'use strict';

const LIFETIME_CONTROLS = new WeakMap();
function getReclamationMigrationCoordinatorControl(value) { return LIFETIME_CONTROLS.get(value) || null; }

const { randomUUID } = require('node:crypto');
const { Buffer } = require('node:buffer');
const {
  assertSafeUnsignedInteger,
  assertUuidV4,
  captureDenseArray,
  captureExactRecord,
  checkedAddBytes,
} = require('./reclamation-codec-primitives');
const {
  FIXED_ANCHOR_MIGRATION_BOUNDS,
  FIXED_H_BOUNDS,
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
} = require('./reclamation-capacity-bounds');
const {
  measureReclamationAtomicReservation,
  measureReclamationStoreCapacity,
} = require('./reclamation-capacity-reservation');
const {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
} = require('./question-reclamation-anchor-codec');
const { decodeSourceBytes } = require('./reclamation-json-codec');
const { encodeQuestionJournalV2Local } = require('./common-question-reclamation-codec');
const {
  encodeCheckpointV3Local,
  encodeInstructionJournalV2Local,
} = require('./delivery-reclamation-codec');
const { planInitialReclamationMigration } = require('./reclamation-migration-plan');
const {
  inspectReclamationMigrationSnapshot,
  validateReclamationSnapshot,
  validateReclamationTransition,
} = require('./reclamation-store-consistency');

const SLOT_ORDER = Object.freeze(['checkpoint', 'instructions', 'questions']);
const STORE_ORDER = Object.freeze(['questions', 'checkpoint', 'instructions']);
const WRITER_FIELDS = Object.freeze(['stop', 'drain', 'prepareResume']);
const REQUIRED_OPTIONS = Object.freeze([
  'persistence', 'writersBySlot', 'capacityBudget', 'normalByteLimitsBySlot',
]);
const OPTIONAL_OPTIONS = Object.freeze(['createStoreId', 'createOperationId', 'now']);
const INVALID_COORDINATOR = 'invalid_reclamation_migration_coordinator';
const BLOCKED = 'reclamation_migration_blocked';
const CLOSED = 'reclamation_migration_coordinator_closed';

function requireValue(condition, code = INVALID_COORDINATOR) {
  if (!condition) throw new TypeError(code);
}

function exact(value, fields, code = INVALID_COORDINATOR) {
  return captureExactRecord(value, fields, code);
}

function dense(value, maxLength, code = INVALID_COORDINATOR) {
  return captureDenseArray(value, maxLength, code);
}

function record(entries) {
  const output = Object.create(null);
  for (const [key, value] of entries) {
    Object.defineProperty(output, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return output;
}

function captureOptions(value) {
  let ownKeys;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(INVALID_COORDINATOR);
  }
  const allowed = new Set([...REQUIRED_OPTIONS, ...OPTIONAL_OPTIONS]);
  requireValue(ownKeys.every((key) => typeof key === 'string' && allowed.has(key)));
  const present = new Set(ownKeys);
  const fields = [...REQUIRED_OPTIONS, ...OPTIONAL_OPTIONS.filter((key) => present.has(key))];
  const input = exact(value, fields);

  const persistence = exact(input.persistence, [
    'configuredSlots', 'readAnchorBytes', 'readSlotBytes', 'writeAnchorBytes', 'writeSlotBytes', 'close', 'status',
  ]);
  const configured = dense(persistence.configuredSlots, SLOT_ORDER.length);
  requireValue(configured.length >= 1 && configured.every((slot) => SLOT_ORDER.includes(slot)) &&
    new Set(configured).size === configured.length);
  const configuredSlots = SLOT_ORDER.filter((slot) => configured.includes(slot));
  requireValue(configuredSlots.length === configured.length &&
    configuredSlots.every((slot, index) => slot === configured[index]));
  for (const method of ['readAnchorBytes', 'readSlotBytes', 'writeAnchorBytes', 'writeSlotBytes', 'close', 'status']) {
    requireValue(typeof persistence[method] === 'function');
  }

  const writers = exact(input.writersBySlot, configuredSlots);
  const writersBySlot = record(configuredSlots.map((slot) => {
    const writer = exact(writers[slot], WRITER_FIELDS);
    for (const field of WRITER_FIELDS) requireValue(typeof writer[field] === 'function');
    return [slot, writer];
  }));
  const capacityBudget = exact(input.capacityBudget, ['acquire', 'status']);
  requireValue(typeof capacityBudget.acquire === 'function' && typeof capacityBudget.status === 'function');
  const normalLimits = exact(input.normalByteLimitsBySlot, configuredSlots);
  for (const slot of configuredSlots) {
    assertSafeUnsignedInteger(normalLimits[slot], INVALID_COORDINATOR);
    requireValue(normalLimits[slot] > 0 && normalLimits[slot] <= MAX_SOURCE_BYTES);
  }

  const generators = {};
  for (const field of OPTIONAL_OPTIONS) {
    if (!present.has(field) || input[field] === undefined) continue;
    requireValue(typeof input[field] === 'function');
    generators[field] = input[field];
  }
  return {
    persistence,
    configuredSlots,
    writersBySlot,
    capacityBudget,
    normalByteLimitsBySlot: normalLimits,
    createStoreId: generators.createStoreId || randomUUID,
    createOperationId: generators.createOperationId || randomUUID,
    now: generators.now || Date.now,
  };
}

function fullStores(value) {
  return exact(value, STORE_ORDER);
}

function fullBytesBySlot(configuredSlots, bytesByConfiguredSlot) {
  return record(STORE_ORDER.map((slot) => [
    slot,
    configuredSlots.includes(slot) ? bytesByConfiguredSlot[slot] : null,
  ]));
}

function fullLimitsBySlot(configuredSlots, normalLimits) {
  return record(STORE_ORDER.map((slot) => [
    slot,
    configuredSlots.includes(slot) ? normalLimits[slot] : null,
  ]));
}

function byteSizes(configuredSlots, valuesBySlot) {
  return record(configuredSlots.map((slot) => {
    const value = valuesBySlot[slot];
    return [slot, value === null ? 0 : Number.isSafeInteger(value) ? value : value.length];
  }));
}

function targetByteSizes(configuredSlots, planOrSnapshot) {
  return record(configuredSlots.map((slot) => {
    const target = planOrSnapshot.slots?.[slot]?.target;
    const encoded = target?.encoded;
    requireValue(encoded && Number.isSafeInteger(encoded.sizeBytes));
    return [slot, encoded.sizeBytes];
  }));
}

function slotMaximum(slot) {
  return checkedAddBytes(MAX_SOURCE_BYTES, FIXED_H_BOUNDS[slot]);
}

function copySnapshot(snapshot) {
  return structuredClone(snapshot);
}

function compareBytes(left, right) {
  return Buffer.isBuffer(left) && Buffer.isBuffer(right) && left.equals(right);
}

function assertUuid(value) {
  assertUuidV4(value, INVALID_COORDINATOR);
}

function createManifestAnchor(anchor, phase, clear = false) {
  requireValue(anchor.migration !== null);
  requireValue(anchor.revision < Number.MAX_SAFE_INTEGER, 'reclamation_anchor_revision_overflow');
  const migration = anchor.migration;
  const nextMigration = clear ? null : record([
    ['operationId', migration.operationId],
    ['startedAt', migration.startedAt],
    ['phase', phase],
    ['sources', migration.sources],
    ['targets', migration.targets],
  ]);
  return normalizeQuestionReclamationAnchorV1Local(record([
    ['schemaVersion', anchor.schemaVersion],
    ['revision', anchor.revision + 1],
    ['storeId', anchor.storeId],
    ['retiredQuestionPeriods', anchor.retiredQuestionPeriods],
    ['migration', nextMigration],
  ]));
}

function maxMigrationAnchorBytes(anchor) {
  requireValue(anchor.migration !== null);
  const migration = anchor.migration;
  const maximum = normalizeQuestionReclamationAnchorV1Local(record([
    ['schemaVersion', anchor.schemaVersion],
    ['revision', Number.MAX_SAFE_INTEGER],
    ['storeId', anchor.storeId],
    ['retiredQuestionPeriods', anchor.retiredQuestionPeriods],
    ['migration', record([
      ['operationId', migration.operationId],
      ['startedAt', migration.startedAt],
      ['phase', 'installing'],
      ['sources', migration.sources],
      ['targets', migration.targets],
    ])],
  ]));
  const sizeBytes = encodeQuestionReclamationAnchorV1Local(maximum).sizeBytes;
  requireValue(sizeBytes <= FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes);
  return sizeBytes;
}

function maxNormalAnchorBytes(anchor) {
  const maximum = normalizeQuestionReclamationAnchorV1Local(record([
    ['schemaVersion', anchor.schemaVersion],
    ['revision', Number.MAX_SAFE_INTEGER],
    ['storeId', anchor.storeId],
    ['retiredQuestionPeriods', anchor.retiredQuestionPeriods],
    ['migration', null],
  ]));
  const sizeBytes = encodeQuestionReclamationAnchorV1Local(maximum).sizeBytes;
  requireValue(sizeBytes <= NORMAL_ANCHOR_MAX_BYTES);
  return sizeBytes;
}

function migrationDescriptorSlots(anchor) {
  requireValue(anchor.migration !== null);
  return anchor.migration.sources.map((source) => source.slot);
}

function assertConfiguredManifestSlots(configuredSlots, anchor) {
  const slots = migrationDescriptorSlots(anchor);
  requireValue(slots.length === configuredSlots.length &&
    slots.every((slot, index) => slot === configuredSlots[index]));
}

function assertCanonicalReadback(bytes, expected) {
  requireValue(compareBytes(bytes, expected), 'reclamation_persistence_readback_mismatch');
}

function errorCodeFrom(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) return BLOCKED;
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
      ? descriptor.value
      : BLOCKED;
  } catch {
    return BLOCKED;
  }
}

function createReclamationMigrationCoordinator(value) {
  const input = captureOptions(value);
  const { persistence, configuredSlots, writersBySlot, capacityBudget, normalByteLimitsBySlot } = input;
  const limitsForTransitions = fullLimitsBySlot(configuredSlots, normalByteLimitsBySlot);
  let managed = false;
  const retentionReasons = [];
  let gateOpen = false;
  let state = 'idle';
  let failureCode = null;
  let startPromise = null;
  let closePromise = null;
  let closing = false;
  let closed = false;
  let lease = null;
  let resultSnapshot = null;

  function leaseBytes() {
    if (lease === null) return 0;
    return lease.status().bytes;
  }

  function status() {
    return Object.freeze({
      state,
      canWrite: gateOpen,
      closing,
      closed,
      failureCode,
      lease: lease === null ? null : Object.freeze({ ...lease.status() }),
    });
  }

  function ensureActive() {
    if (closing || closed) throw new Error(CLOSED);
  }

  function setGate(open) {
    gateOpen = open;
    if (open) state = 'ready';
  }

  function acquireOrResize(bytes) {
    if (lease === null) lease = capacityBudget.acquire(bytes);
    else lease.resize(bytes);
  }

  async function stopAndDrainWriters() {
    const stopPromises = [];
    const stopErrors = [];
    for (const slot of configuredSlots) {
      try {
        const returned = writersBySlot[slot].stop();
        stopPromises.push(Promise.resolve(returned));
      } catch (error) {
        stopErrors.push(error);
      }
    }
    const stopResults = await Promise.allSettled(stopPromises);
    const drainPromises = [];
    for (const slot of configuredSlots) {
      try {
        drainPromises.push(Promise.resolve(writersBySlot[slot].drain()));
      } catch (error) {
        drainPromises.push(Promise.reject(error));
      }
    }
    const drainResults = await Promise.allSettled(drainPromises);
    const failed = stopErrors.length > 0 || stopResults.some((item) => item.status === 'rejected') ||
      drainResults.some((item) => item.status === 'rejected');
    if (failed) {
      retentionReasons.push(...stopErrors, ...stopResults.filter(item => item.status === 'rejected').map(item => item.reason),
        ...drainResults.filter(item => item.status === 'rejected').map(item => item.reason));
      throw new Error('reclamation_writer_stop_or_drain_failed');
    }
  }

  function rawFullBytes(slotBytesByConfiguredSlot) {
    return fullBytesBySlot(configuredSlots, slotBytesByConfiguredSlot);
  }

  function storeCapacity(anchor, stores, rawAnchorBytes, rawSlotBytes) {
    return measureReclamationStoreCapacity({
      anchor,
      stores,
      normalByteLimitsBySlot,
      rawSizeBytesBySlot: byteSizes(configuredSlots, rawSlotBytes),
      rawAnchorSizeBytes: rawAnchorBytes === null ? 0 : rawAnchorBytes.length,
    });
  }

  async function saveAndCheckAnchor(anchor, maximumBytes) {
    const encoded = encodeQuestionReclamationAnchorV1Local(anchor);
    requireValue(encoded.sizeBytes <= maximumBytes, 'reclamation_anchor_size_limit');
    await persistence.writeAnchorBytes(encoded.bytes, maximumBytes);
    const readback = await persistence.readAnchorBytes(maximumBytes);
    assertCanonicalReadback(readback, encoded.bytes);
    return { anchor, encoded, readback };
  }

  async function saveAndCheckSlot(slot, bytes, maximumBytes) {
    await persistence.writeSlotBytes(slot, bytes, maximumBytes);
    const readback = await persistence.readSlotBytes(slot, maximumBytes);
    assertCanonicalReadback(readback, bytes);
    return readback;
  }

  async function readConfiguredSlots(anchor) {
    const output = record([]);
    for (const slot of configuredSlots) {
      let maximumBytes = slotMaximum(slot);
      if (anchor.migration !== null) {
        const descriptor = anchor.migration.sources.find((source) => source.slot === slot);
        requireValue(descriptor !== undefined && descriptor.targetSizeBytes <= slotMaximum(slot));
        if (descriptor.sourcePresent) requireValue(descriptor.sizeBytes <= MAX_SOURCE_BYTES);
        maximumBytes = Math.max(descriptor.sourcePresent ? descriptor.sizeBytes : 0,
          descriptor.targetSizeBytes);
        requireValue(maximumBytes <= slotMaximum(slot));
      }
      output[slot] = await persistence.readSlotBytes(slot, maximumBytes);
    }
    return output;
  }

  function assertSameSlotBytes(expected, actual) {
    for (const slot of configuredSlots) {
      const left = expected[slot];
      const right = actual[slot];
      requireValue(left === null ? right === null : compareBytes(left, right),
        'reclamation_migration_slot_changed');
    }
  }

  async function verifyPersistedManifest(expectedAnchor, expectedSlotBytes) {
    const maximumBytes = expectedAnchor.migration === null
      ? NORMAL_ANCHOR_MAX_BYTES
      : FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes;
    const anchorBytes = await persistence.readAnchorBytes(maximumBytes);
    requireValue(anchorBytes !== null, 'reclamation_migration_anchor_missing');
    decodeSourceBytes(anchorBytes, maximumBytes);
    const expectedEncoded = encodeQuestionReclamationAnchorV1Local(expectedAnchor);
    requireValue(compareBytes(anchorBytes, expectedEncoded.bytes), 'reclamation_migration_anchor_changed');
    const anchor = normalizeQuestionReclamationAnchorV1Local(expectedAnchor);
    const slotBytes = await readConfiguredSlots(anchor);
    assertSameSlotBytes(expectedSlotBytes, slotBytes);
    const inspection = anchor.migration === null ? null : inspectReclamationMigrationSnapshot({
      anchor,
      slotBytesBySlot: rawFullBytes(slotBytes),
    });
    return { anchor, anchorBytes, slotBytes, inspection };
  }

  function validateTransition(previousAnchor, nextAnchor, stores) {
    const checked = validateReclamationTransition({
      previous: previousAnchor,
      next: nextAnchor,
      previousStores: stores,
      nextStores: stores,
      normalByteLimitsBySlot: limitsForTransitions,
    });
    return checked.snapshot.anchor;
  }

  async function transitionAndPersist(previousAnchor, nextAnchor, stores, slotBytesByConfiguredSlot) {
    const validated = validateTransition(previousAnchor, nextAnchor, stores);
    const maximumBytes = validated.migration === null
      ? NORMAL_ANCHOR_MAX_BYTES
      : FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes;
    const saved = await saveAndCheckAnchor(validated, maximumBytes);
    ensureActive();
    let inspection = null;
    if (saved.anchor.migration !== null) {
      const persisted = await verifyPersistedManifest(saved.anchor, slotBytesByConfiguredSlot);
      ensureActive();
      inspection = persisted.inspection;
      requireValue(inspection.status === 'reconciliation-required');
    } else {
      const validation = validateReclamationSnapshot({ anchor: saved.anchor, stores });
      requireValue(validation.status === 'ready');
    }
    return { anchor: saved.anchor, encoded: saved.encoded, inspection };
  }

  function transitionAnchorForPhase(anchor, phase) {
    const next = createManifestAnchor(anchor, phase);
    requireValue(next.migration !== null && next.migration.operationId === anchor.migration.operationId &&
      next.migration.startedAt === anchor.migration.startedAt);
    return next;
  }

  function targetEncodedFromInspection(anchor, snapshot, slot) {
    const descriptor = anchor.migration.sources.find((source) => source.slot === slot);
    requireValue(descriptor !== undefined);
    const store = snapshot.stores[slot];
    requireValue(store !== null);
    const encoded = slot === 'questions' ? encodeQuestionJournalV2Local(store)
      : slot === 'checkpoint' ? encodeCheckpointV3Local(store)
        : encodeInstructionJournalV2Local(store);
    requireValue(encoded.sizeBytes === descriptor.targetSizeBytes && encoded.sha256 === descriptor.targetSha256,
      'reclamation_migration_target_mismatch');
    return encoded;
  }

  function migrationWriteLimit(anchor, snapshot, slot) {
    const descriptor = anchor.migration.sources.find((source) => source.slot === slot);
    const store = snapshot.stores[slot];
    requireValue(descriptor !== undefined && store !== null);
    const grant = store.migrationAllowance;
    const limit = grant === null
      ? normalByteLimitsBySlot[slot]
      : checkedAddBytes(normalByteLimitsBySlot[slot], grant.maxExtraBytes);
    requireValue(limit <= slotMaximum(slot));
    return limit;
  }

  function atomicReservation({ anchorSizeBytes, slotBytesByConfiguredSlot, targetSizeBytesBySlot,
    migrationAnchorBytes, normalAnchorBytes }) {
    return measureReclamationAtomicReservation({
      anchorSizeBytes,
      slotSizeBytesBySlot: byteSizes(configuredSlots, slotBytesByConfiguredSlot),
      targetSizeBytesBySlot,
      migrationAnchorMaxBytes: migrationAnchorBytes,
      normalAnchorSizeBytes: normalAnchorBytes,
    });
  }

  async function resumeAll(snapshot) {
    ensureActive();
    const promises = [];
    for (const slot of configuredSlots) {
      try {
        promises.push(Promise.resolve(writersBySlot[slot].prepareResume(copySnapshot(snapshot))));
      } catch (error) {
        promises.push(Promise.reject(error));
      }
    }
    const settled = await Promise.allSettled(promises);
    ensureActive();
    if (settled.some((item) => item.status === 'rejected')) {
      throw new Error('reclamation_writer_resume_failed');
    }
    resultSnapshot = copySnapshot(snapshot);
    setGate(true);
    return Object.freeze({ status: 'ready', snapshot: copySnapshot(snapshot) });
  }

  async function initializeEmpty(plan, rawSlotBytesByConfiguredSlot) {
    const targetSizes = targetByteSizes(configuredSlots, plan);
    const emptyCurrent = record(configuredSlots.map((slot) => [slot, null]));
    const atomic = atomicReservation({
      anchorSizeBytes: 0,
      slotBytesByConfiguredSlot: emptyCurrent,
      targetSizeBytesBySlot: targetSizes,
      migrationAnchorBytes: 0,
      normalAnchorBytes: plan.normalAnchorMaxRevisionBytes,
    });
    const targetRaw = record(configuredSlots.map((slot) => [slot, plan.slots[slot].target.encoded.sizeBytes]));
    const steady = storeCapacity(plan.anchor, plan.stores, null, targetRaw);
    acquireOrResize(Math.max(atomic.additionalBytes, steady.physicalBounds.postMigrationReservationBytes));
    ensureActive();

    for (const slot of configuredSlots) {
      const target = plan.slots[slot].target;
      await saveAndCheckSlot(slot, target.encoded.bytes, normalByteLimitsBySlot[slot]);
      ensureActive();
      rawSlotBytesByConfiguredSlot[slot] = target.encoded.bytes;
    }
    for (const slot of configuredSlots) {
      const readback = await persistence.readSlotBytes(slot, normalByteLimitsBySlot[slot]);
      assertCanonicalReadback(readback, plan.slots[slot].target.encoded.bytes);
    }
    ensureActive();
    const anchorSaved = await saveAndCheckAnchor(plan.anchor, NORMAL_ANCHOR_MAX_BYTES);
    ensureActive();
    const validation = validateReclamationSnapshot({ anchor: anchorSaved.anchor, stores: plan.stores });
    requireValue(validation.status === 'ready');
    const measured = storeCapacity(validation.snapshot.anchor, validation.snapshot.stores,
      anchorSaved.readback, rawSlotBytesByConfiguredSlot);
    acquireOrResize(measured.physicalBounds.postMigrationReservationBytes);
    return resumeAll(validation.snapshot);
  }

  async function beginLegacyMigration(plan, sourceBytesByConfiguredSlot) {
    const prepared = plan.anchor;
    const targetStores = fullStores(plan.stores);
    const targetSizes = targetByteSizes(configuredSlots, plan);
    const maxAnchorBytes = maxMigrationAnchorBytes(prepared);
    const normalAnchorBytes = maxNormalAnchorBytes(prepared);
    const initialSlots = record(configuredSlots.map((slot) => [slot, sourceBytesByConfiguredSlot[slot]]));
    const rawMeasure = storeCapacity(prepared, targetStores, null, initialSlots);
    const atomic = atomicReservation({
      anchorSizeBytes: 0,
      slotBytesByConfiguredSlot: initialSlots,
      targetSizeBytesBySlot: targetSizes,
      migrationAnchorBytes: maxAnchorBytes,
      normalAnchorBytes,
    });
    acquireOrResize(Math.max(atomic.additionalBytes, rawMeasure.physicalBounds.postMigrationReservationBytes));
    ensureActive();

    const preparedWrite = await saveAndCheckAnchor(prepared, FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes);
    ensureActive();
    let slotBytes = record(configuredSlots.map((slot) => [slot, sourceBytesByConfiguredSlot[slot]]));
    let inspection = inspectReclamationMigrationSnapshot({
      anchor: preparedWrite.anchor,
      slotBytesBySlot: rawFullBytes(slotBytes),
    });
    requireValue(inspection.phase === 'prepared' && inspection.prefixLength === 0);
    return continueMigration(preparedWrite.anchor, inspection, slotBytes, maxAnchorBytes, normalAnchorBytes);
  }

  async function continueMigration(initialAnchor, initialInspection, initialSlotBytes, maxAnchorBytes, normalAnchorBytes) {
    let anchor = initialAnchor;
    let inspection = initialInspection;
    let slotBytes = initialSlotBytes;
    ensureActive();

    if (anchor.migration.phase === 'prepared') {
      const guarded = transitionAnchorForPhase(anchor, 'guarded');
      ({ anchor, inspection } = await transitionAndPersist(anchor, guarded,
        inspection.snapshot.stores, slotBytes));
    }
    ensureActive();
    if (anchor.migration.phase === 'guarded') {
      const installing = transitionAnchorForPhase(anchor, 'installing');
      ({ anchor, inspection } = await transitionAndPersist(anchor, installing,
        inspection.snapshot.stores, slotBytes));
    }

    if (anchor.migration.phase === 'installing') {
      const descriptors = anchor.migration.sources;
      for (const source of descriptors) {
        const current = inspection.sourceStates.find((item) => item.slot === source.slot);
        if (current.state === 'target') continue;
        ensureActive();
        const target = targetEncodedFromInspection(anchor, inspection.snapshot, source.slot);
        await saveAndCheckSlot(source.slot, target.bytes,
          migrationWriteLimit(anchor, inspection.snapshot, source.slot));
        slotBytes[source.slot] = target.bytes;
        ensureActive();
        inspection = inspectReclamationMigrationSnapshot({
          anchor,
          slotBytesBySlot: rawFullBytes(slotBytes),
        });
      }
      requireValue(inspection.prefixLength === descriptors.length);
      const beforeComplete = await verifyPersistedManifest(anchor, slotBytes);
      ensureActive();
      requireValue(beforeComplete.inspection.phase === 'installing' &&
        beforeComplete.inspection.prefixLength === descriptors.length);
      slotBytes = beforeComplete.slotBytes;
      inspection = beforeComplete.inspection;
      const completed = transitionAnchorForPhase(anchor, 'completed');
      ({ anchor, inspection } = await transitionAndPersist(anchor, completed,
        inspection.snapshot.stores, slotBytes));
    }

    requireValue(anchor.migration.phase === 'completed' &&
      inspection.prefixLength === anchor.migration.sources.length);
    ensureActive();

    const completedReadback = await verifyPersistedManifest(anchor, slotBytes);
    ensureActive();
    requireValue(completedReadback.inspection.phase === 'completed' &&
      completedReadback.inspection.prefixLength === anchor.migration.sources.length);
    slotBytes = completedReadback.slotBytes;
    inspection = completedReadback.inspection;
    const stores = inspection.snapshot.stores;
    const rawAnchorSize = completedReadback.anchorBytes.length;
    const beforeClear = storeCapacity(anchor, stores, completedReadback.anchorBytes, slotBytes);
    const targetSizes = record(configuredSlots.map((slot) => [slot, slotBytes[slot].length]));
    const nullAnchor = createManifestAnchor(anchor, null, true);
    const atomic = atomicReservation({
      anchorSizeBytes: rawAnchorSize,
      slotBytesByConfiguredSlot: slotBytes,
      targetSizeBytesBySlot: targetSizes,
      migrationAnchorBytes: maxAnchorBytes,
      normalAnchorBytes,
    });
    acquireOrResize(Math.max(leaseBytes(), beforeClear.physicalBounds.postMigrationReservationBytes,
      atomic.additionalBytes));
    ensureActive();

    const finalCheck = await verifyPersistedManifest(anchor, slotBytes);
    ensureActive();
    requireValue(finalCheck.inspection.phase === 'completed' &&
      finalCheck.inspection.prefixLength === anchor.migration.sources.length);
    const validatedNull = validateTransition(anchor, nullAnchor, finalCheck.inspection.snapshot.stores);
    const nullWrite = await saveAndCheckAnchor(validatedNull, NORMAL_ANCHOR_MAX_BYTES);
    ensureActive();
    const verifiedSlotsAfterClear = await readConfiguredSlots(nullWrite.anchor);
    assertSameSlotBytes(slotBytes, verifiedSlotsAfterClear);
    const ready = validateReclamationSnapshot({
      anchor: nullWrite.anchor,
      stores: finalCheck.inspection.snapshot.stores,
    });
    requireValue(ready.status === 'ready');
    const post = storeCapacity(ready.snapshot.anchor, ready.snapshot.stores, nullWrite.readback, verifiedSlotsAfterClear);
    acquireOrResize(post.physicalBounds.postMigrationReservationBytes);
    return resumeAll(ready.snapshot);
  }

  async function recoverActiveMigration(anchorBytes, slotBytesByConfiguredSlot) {
    const parsed = decodeSourceBytes(anchorBytes, FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes);
    const anchor = normalizeQuestionReclamationAnchorV1Local(parsed.value);
    requireValue(anchor.migration !== null);
    assertConfiguredManifestSlots(configuredSlots, anchor);
    const inspection = inspectReclamationMigrationSnapshot({
      anchor,
      slotBytesBySlot: rawFullBytes(slotBytesByConfiguredSlot),
    });
    const targetSizes = record(configuredSlots.map((slot) => {
      const descriptor = anchor.migration.sources.find((item) => item.slot === slot);
      return [slot, descriptor.targetSizeBytes];
    }));
    const rawAnchorSize = anchorBytes.length;
    const stores = inspection.snapshot.stores;
    const measured = storeCapacity(anchor, stores, anchorBytes, slotBytesByConfiguredSlot);
    const migrationAnchorBytes = maxMigrationAnchorBytes(anchor);
    const normalAnchorBytes = maxNormalAnchorBytes(anchor);
    const atomic = atomicReservation({
      anchorSizeBytes: rawAnchorSize,
      slotBytesByConfiguredSlot: slotBytesByConfiguredSlot,
      targetSizeBytesBySlot: targetSizes,
      migrationAnchorBytes,
      normalAnchorBytes,
    });
    acquireOrResize(Math.max(atomic.additionalBytes, measured.physicalBounds.postMigrationReservationBytes));
    ensureActive();
    return continueMigration(anchor, inspection, slotBytesByConfiguredSlot, migrationAnchorBytes, normalAnchorBytes);
  }

  async function startWork() {
    ensureActive();
    const anchorBytes = await persistence.readAnchorBytes(FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes);
    const slotBytes = record([]);
    let decodedAnchor = null;
    if (anchorBytes !== null) {
      decodedAnchor = normalizeQuestionReclamationAnchorV1Local(
        decodeSourceBytes(anchorBytes, FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes).value);
    }
    if (decodedAnchor !== null && decodedAnchor.migration !== null) {
      assertConfiguredManifestSlots(configuredSlots, decodedAnchor);
    }
    for (const slot of configuredSlots) {
      let maximumBytes = MAX_SOURCE_BYTES;
      if (decodedAnchor !== null && decodedAnchor.migration !== null) {
        const descriptor = decodedAnchor.migration.sources.find((source) => source.slot === slot);
        requireValue(descriptor !== undefined && descriptor.targetSizeBytes <= slotMaximum(slot));
        if (descriptor.sourcePresent) requireValue(descriptor.sizeBytes <= MAX_SOURCE_BYTES);
        maximumBytes = Math.max(descriptor.sourcePresent ? descriptor.sizeBytes : 0, descriptor.targetSizeBytes);
        requireValue(maximumBytes <= slotMaximum(slot));
      } else if (anchorBytes !== null) {
        maximumBytes = slotMaximum(slot);
      }
      slotBytes[slot] = await persistence.readSlotBytes(slot, maximumBytes);
    }
    ensureActive();

    if (anchorBytes !== null) {
      const anchor = decodedAnchor;
      if (anchor.migration !== null) return recoverActiveMigration(anchorBytes, slotBytes);

      const storesBySlot = record(STORE_ORDER.map((slot) => [slot, null]));
      for (const slot of configuredSlots) {
        const bytes = slotBytes[slot];
        requireValue(bytes !== null, 'reclamation_missing_mandatory_slot');
        const decodedStore = decodeSourceBytes(bytes, slotMaximum(slot));
        storesBySlot[slot] = decodedStore.value;
      }
      const validation = validateReclamationSnapshot({ anchor, stores: storesBySlot });
      requireValue(validation.status === 'ready', 'reclamation_snapshot_requires_reconciliation');
      const measured = storeCapacity(validation.snapshot.anchor, validation.snapshot.stores, anchorBytes, slotBytes);
      acquireOrResize(measured.physicalBounds.postMigrationReservationBytes);
      ensureActive();
      return resumeAll(validation.snapshot);
    }

    const allAbsent = configuredSlots.every((slot) => slotBytes[slot] === null);
    const storeId = input.createStoreId();
    const operationId = input.createOperationId();
    assertUuid(storeId);
    assertUuid(operationId);
    const startedAt = input.now();
    assertSafeUnsignedInteger(startedAt, INVALID_COORDINATOR);
    const plan = planInitialReclamationMigration({
      configuredSlots,
      sourceBytesBySlot: slotBytes,
      normalByteLimitsBySlot,
      storeId,
      operationId,
      startedAt,
    });
    ensureActive();
    if (allAbsent) {
      requireValue(plan.outcome === 'initial-create');
      return initializeEmpty(plan, slotBytes);
    }
    requireValue(plan.outcome === 'migration-prepared');
    return beginLegacyMigration(plan, slotBytes);
  }

  function failClosed(error) {
    gateOpen = false;
    if (closing || closed) return;
    state = 'blocked';
    failureCode = errorCodeFrom(error);
    return stopAndDrainWriters().catch(() => {});
  }

  function start() {
    if (closing || closed) return Promise.reject(new Error(CLOSED));
    if (state === 'ready' && resultSnapshot !== null) {
      return Promise.resolve(Object.freeze({ status: 'ready', snapshot: copySnapshot(resultSnapshot) }));
    }
    if (startPromise !== null) return startPromise;
    if (state === 'blocked') return Promise.reject(new Error(BLOCKED));
    gateOpen = false;
    state = 'starting';
    let resolveStart;
    let rejectStart;
    startPromise = new Promise((resolve, reject) => {
      resolveStart = resolve;
      rejectStart = reject;
    });
    void (async () => {
      try {
        await stopAndDrainWriters();
        resolveStart(await startWork());
      } catch (error) {
        await failClosed(error);
        rejectStart(error);
      }
    })();
    return startPromise;
  }

  function closeStandard() {
    if (closePromise !== null) return closePromise;
    closing = true;
    gateOpen = false;
    state = state === 'blocked' ? 'blocked' : 'closing';
    closePromise = (async () => {
      if (startPromise !== null) await startPromise.catch(() => {});
      let closeError = null;
      try {
        await stopAndDrainWriters();
      } catch (error) {
        closeError = error;
      }
      try {
        await persistence.close();
      } catch (error) {
        if (closeError === null) closeError = error;
      } finally {
        if (lease !== null) {
          try {
            lease.release();
          } catch (error) {
            if (closeError === null) closeError = error;
          }
        }
        closed = true;
        closing = false;
        gateOpen = false;
        if (state !== 'blocked') state = 'closed';
      }
      if (closeError !== null) throw closeError;
    })();
    return closePromise;
  }

  function close() {
    if (!managed) return closeStandard();
    if (closePromise !== null) return closePromise;
    let resolveClose;
    let rejectClose;
    closePromise = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    closePromise.catch(() => {});
    closing = true;
    gateOpen = false;
    state = state === 'blocked' ? 'blocked' : 'closing';
    const work = (async () => {
      if (startPromise !== null) await startPromise.catch(() => {});
      try { await stopAndDrainWriters(); }
      finally { closed = true; closing = false; if (state !== 'blocked') state = 'closed'; }
      if (retentionReasons.length) throw retentionReasons[0];
    })();
    work.then(resolveClose, rejectClose);
    return closePromise;
  }

  const api = Object.freeze({
    start,
    close,
    canWrite: () => gateOpen,
    status,
  });
  LIFETIME_CONTROLS.set(api, Object.freeze({
    bindOwner() {
      if (managed || startPromise !== null || closePromise !== null) return false;
      managed = true;
      return Object.freeze({ stopAndDrain: close, retentionReasons: () => [...retentionReasons] });
    },
  }));
  return api;
}

module.exports = { createReclamationMigrationCoordinator, getReclamationMigrationCoordinatorControl };
