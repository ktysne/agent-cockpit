'use strict';

const { randomUUID } = require('node:crypto');
const { types: utilTypes } = require('node:util');
const {
  assertSafeUnsignedInteger,
  assertIdentifier,
  captureDenseArray,
  captureExactRecord,
  checkedAddBytes,
} = require('./reclamation-codec-primitives');
const {
  FIXED_ANCHOR_MIGRATION_BOUNDS,
  FIXED_H_BOUNDS,
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
  computePhysicalReclamationBounds,
  measureCheckpointReservation,
  measureInstructionReservation,
  measurePendingQuestionPeriodCapacity,
  measureQuestionJournalReservationBytes,
} = require('./reclamation-capacity-bounds');
const {
  encodeQuestionJournalV2Local,
  normalizeQuestionJournalV2Local,
} = require('./common-question-reclamation-codec');
const {
  encodeCheckpointV3Local,
  encodeInstructionJournalV2Local,
  normalizeCheckpointV3Local,
  normalizeInstructionJournalV2Local,
} = require('./delivery-reclamation-codec');
const {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
} = require('./question-reclamation-anchor-codec');
const { decodeSourceBytes, encodeNormalized } = require('./reclamation-json-codec');
const { createReclamationMigrationCoordinator } = require('./reclamation-migration-coordinator');
const {
  validateQuestionPeriodRetirementAnchorTransition,
  validateReclamationSnapshot,
  validateReclamationStoreWrite,
  validateReclamationTransition,
} = require('./reclamation-store-consistency');
const { planQuestionPeriodRetirement } = require('./question-period-retirement');
const { planQuestionBodyReclamation } = require('./question-body-reclamation');
const { planTerminalDeliveryBodyReclamation } = require('./terminal-delivery-body-reclamation');
const { planInstructionBodyReclamation } = require('./instruction-body-reclamation');
const { createQuestionPeriodGate } = require('./question-period-gate');

const SLOT_ORDER = Object.freeze(['checkpoint', 'instructions', 'questions']);
const STORE_ORDER = Object.freeze(['questions', 'checkpoint', 'instructions']);
const WRITER_FIELDS = Object.freeze(['stop', 'drain', 'prepareResume']);
const REQUIRED_OPTIONS = Object.freeze(['persistence', 'capacityBudget', 'normalByteLimitsBySlot']);
const OPTIONAL_OPTIONS = Object.freeze(['now', 'createStoreId', 'createOperationId']);
const REPAIR_REASONS = new Set([
  'question_retirement_snapshot',
  'question_creation_state',
  'question_checkpoint_cache',
  'instruction_creation_state',
]);
const STORE_CODEC = Object.freeze({
  questions: Object.freeze({ normalize: normalizeQuestionJournalV2Local, encode: encodeQuestionJournalV2Local }),
  checkpoint: Object.freeze({ normalize: normalizeCheckpointV3Local, encode: encodeCheckpointV3Local }),
  instructions: Object.freeze({ normalize: normalizeInstructionJournalV2Local, encode: encodeInstructionJournalV2Local }),
});

function contextError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function errorCodeFrom(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function')) {
    return 'reclamation_service_blocked';
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string'
      ? descriptor.value
      : 'reclamation_service_blocked';
  } catch {
    return 'reclamation_service_blocked';
  }
}

function requireValue(condition, code = 'invalid_reclamation_service_context') {
  if (!condition) {
    const error = new TypeError(code);
    error.code = code;
    throw error;
  }
}

function makeRecord(entries) {
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
    throw contextError('invalid_reclamation_service_context');
  }
  const allowed = new Set([...REQUIRED_OPTIONS, ...OPTIONAL_OPTIONS]);
  requireValue(ownKeys.every((key) => typeof key === 'string' && allowed.has(key)));
  const present = new Set(ownKeys);
  for (const field of REQUIRED_OPTIONS) requireValue(present.has(field));
  const fields = [...REQUIRED_OPTIONS, ...OPTIONAL_OPTIONS.filter((field) => present.has(field))];
  const input = captureExactRecord(value, fields, 'invalid_reclamation_service_context');
  const persistence = captureExactRecord(input.persistence,
    ['configuredSlots', 'readAnchorBytes', 'readSlotBytes', 'writeAnchorBytes', 'writeSlotBytes', 'close', 'status'],
    'invalid_reclamation_service_context');
  for (const method of ['readAnchorBytes', 'readSlotBytes', 'writeAnchorBytes', 'writeSlotBytes', 'close', 'status']) {
    requireValue(typeof persistence[method] === 'function');
  }
  const configured = captureDenseArray(persistence.configuredSlots, SLOT_ORDER.length,
    'invalid_reclamation_service_context');
  requireValue(configured.length >= 2 && configured.includes('checkpoint') && configured.includes('questions') &&
    configured.every((slot) => typeof slot === 'string' && SLOT_ORDER.includes(slot)) &&
    new Set(configured).size === configured.length);
  const configuredSlots = SLOT_ORDER.filter((slot) => configured.includes(slot));
  requireValue(configuredSlots.length === configured.length &&
    configuredSlots.every((slot, index) => slot === configured[index]));

  const normalByteLimitsBySlot = captureExactRecord(input.normalByteLimitsBySlot, configuredSlots,
    'invalid_reclamation_service_context');
  for (const slot of configuredSlots) {
    assertSafeUnsignedInteger(normalByteLimitsBySlot[slot], 'invalid_reclamation_service_context');
    requireValue(normalByteLimitsBySlot[slot] > 0 && normalByteLimitsBySlot[slot] <= MAX_SOURCE_BYTES);
  }
  const capacityBudget = captureExactRecord(input.capacityBudget, ['acquire', 'status'],
    'invalid_reclamation_service_context');
  requireValue(typeof capacityBudget.acquire === 'function' && typeof capacityBudget.status === 'function');
  const generators = {};
  for (const field of OPTIONAL_OPTIONS) {
    if (!present.has(field) || input[field] === undefined) continue;
    requireValue(typeof input[field] === 'function');
    generators[field] = input[field];
  }
  return {
    persistence: input.persistence,
    configuredSlots,
    normalByteLimitsBySlot,
    capacityBudget: input.capacityBudget,
    now: generators.now || Date.now,
    createStoreId: generators.createStoreId,
    createOperationId: generators.createOperationId,
  };
}

function cloneSnapshot(snapshot) {
  return structuredClone(snapshot);
}

function fullStores(configuredSlots, stores) {
  return makeRecord(STORE_ORDER.map((slot) => [slot, configuredSlots.includes(slot) ? stores[slot] : null]));
}

function fullLimits(configuredSlots, limits) {
  return makeRecord(STORE_ORDER.map((slot) => [slot, configuredSlots.includes(slot) ? limits[slot] : null]));
}

function slotMaximum(slot) {
  return checkedAddBytes(MAX_SOURCE_BYTES, FIXED_H_BOUNDS[slot]);
}

function normalizeStore(slot, value) {
  return STORE_CODEC[slot].normalize(value);
}

function encodeStore(slot, value) {
  return STORE_CODEC[slot].encode(value);
}

function sameBytes(left, right) {
  return left.length === right.length && left.equals(right);
}

function sameStore(slot, left, right) {
  return sameBytes(encodeStore(slot, left).bytes, encodeStore(slot, right).bytes);
}

function sameAnchor(left, right) {
  return sameBytes(encodeQuestionReclamationAnchorV1Local(left).bytes,
    encodeQuestionReclamationAnchorV1Local(right).bytes);
}

function identityPeriodKey(identity, periodId) {
  const values = [identity.provider, identity.nativeIdKind, identity.hostId, identity.homeScopeId,
    identity.nativeId, periodId];
  return values.map((value) => `${value.length}:${value}`).join('');
}

function sameIdentity(left, right) {
  return ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']
    .every((field) => left[field] === right[field]);
}

function deliveryCapacity(slot, snapshot, normalByteLimit) {
  if (slot === 'questions') {
    return measureQuestionJournalReservationBytes({ snapshot, currentByteLimit: normalByteLimit }).reservedBytes;
  }
  if (slot === 'checkpoint') {
    return measureCheckpointReservation({ snapshot, currentByteLimit: normalByteLimit }).reservedBytes;
  }
  return measureInstructionReservation({ snapshot, currentByteLimit: normalByteLimit }).reservedBytes;
}

function recordFingerprint(value) {
  return encodeNormalized(value).bytes.toString('hex');
}

function hasNewRow(previousRows, nextRows) {
  const previous = new Set(previousRows.map(recordFingerprint));
  return nextRows.some((row) => !previous.has(recordFingerprint(row)));
}

function changedRowsOutsideRoster(previousRows, nextRows, idField, eligibleIds) {
  const previousById = new Map(previousRows.map((row) => [row[idField], row]));
  return nextRows.some((row) => {
    const previous = previousById.get(row[idField]);
    const changed = previous === undefined || recordFingerprint(previous) !== recordFingerprint(row);
    return changed && !eligibleIds.has(row[idField]);
  });
}

function requiresNormalAdmissionLimit(slot, previous, next) {
  if (slot === 'questions') {
    const eligibleIds = new Set(next.migrationAllowance?.eligibleQuestionIds ?? []);
    return changedRowsOutsideRoster(previous.reservations, next.reservations, 'internalQuestionId', eligibleIds) ||
      changedRowsOutsideRoster(previous.questions, next.questions, 'internalQuestionId', eligibleIds);
  }
  if (slot === 'instructions') {
    const eligibleIds = new Set(next.migrationAllowance?.eligibleAttemptIds ?? []);
    return changedRowsOutsideRoster(previous.instructions, next.instructions, 'deliveryAttemptId', eligibleIds);
  }
  const eligibleIds = new Set(next.migrationAllowance?.eligibleAttemptIds ?? []);
  if (changedRowsOutsideRoster(previous.ledger.deliveries, next.ledger.deliveries,
    'deliveryAttemptId', eligibleIds)) return true;
  if (hasNewRow(previous.ledger.notificationTargets, next.ledger.notificationTargets)) return true;
  for (const field of Object.keys(previous.registrations)) {
    const oldRows = previous.registrations[field];
    const newRows = next.registrations[field];
    if (Array.isArray(oldRows) && Array.isArray(newRows) && hasNewRow(oldRows, newRows)) return true;
  }
  return false;
}

function measurementLimit(slot, snapshot, normalByteLimit, admission, currentAnchor) {
  if (slot === 'questions' && admission) {
    requireValue(currentAnchor !== null && currentAnchor.migration === null,
      'reclamation_capacity_exceeded');
    const activePeriods = snapshot.reservations.map(({ identity, periodId }) => ({ identity, periodId }));
    const anchorCapacity = measurePendingQuestionPeriodCapacity(currentAnchor, activePeriods);
    requireValue(anchorCapacity.fits && anchorCapacity.projectedBytes !== null &&
      anchorCapacity.projectedBytes <= NORMAL_ANCHOR_MAX_BYTES, 'reclamation_capacity_exceeded');
  }
  const grantBytes = snapshot.migrationAllowance?.maxExtraBytes ?? 0;
  const limit = admission ? normalByteLimit : checkedAddBytes(normalByteLimit, grantBytes);
  const encoded = encodeStore(slot, snapshot);
  requireValue(encoded.sizeBytes <= limit, 'reclamation_capacity_exceeded');
  requireValue(deliveryCapacity(slot, snapshot, normalByteLimit) <= limit, 'reclamation_capacity_exceeded');
}

function createReclamationServiceContext(value) {
  const input = captureOptions(value);
  const { persistence, configuredSlots, normalByteLimitsBySlot, capacityBudget } = input;
  const limitsForTransitions = fullLimits(configuredSlots, normalByteLimitsBySlot);
  let anchor = null;
  let stores = makeRecord(STORE_ORDER.map((slot) => [slot, null]));
  let coordinator = null;
  let writersBySlot = null;
  let lease = null;
  let leaseReleased = false;
  let startPromise = null;
  let closePromise = null;
  let ioTail = Promise.resolve();
  let opened = false;
  let blocked = false;
  let closing = false;
  let closed = false;
  let failureCode = null;
  let lastObservedNow = null;
  let readyResolve;
  let readyReject;
  let readyPending = true;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  ready.catch(() => {});

  function contextCanWrite() {
    return opened && !blocked && !closing && !closed && coordinator?.canWrite() === true;
  }

  function observeClock() {
    let now;
    try { now = input.now(); } catch { return { now: null, synchronized: false }; }
    if (!Number.isSafeInteger(now) || now < 0) return { now: null, synchronized: false };
    if (lastObservedNow === null) {
      lastObservedNow = now;
      return { now, synchronized: false };
    }
    const synchronized = now >= lastObservedNow;
    if (synchronized) lastObservedNow = now;
    return { now, synchronized };
  }

  const periodGate = createQuestionPeriodGate({
    getAnchor: () => {
      if (!anchor) throw contextError('question_gate_closed');
      return cloneSnapshot(anchor);
    },
    canWrite: contextCanWrite,
  });

  function currentSnapshot() {
    if (!anchor) return null;
    return makeRecord([['anchor', cloneSnapshot(anchor)], ['stores', cloneSnapshot(stores)]]);
  }

  function currentStore(slot) {
    if (!configuredSlots.includes(slot)) throw contextError('reclamation_persistence_slot_not_configured');
    if (!opened || stores[slot] === null) throw contextError('reclamation_writer_cold');
    return stores[slot];
  }

  function block(error) {
    if (blocked || closed) return;
    blocked = true;
    opened = false;
    failureCode = errorCodeFrom(error);
    if (readyPending) {
      readyPending = false;
      readyReject?.(contextError(failureCode));
    }
    if (writersBySlot !== null) {
      for (const slot of configuredSlots) {
        try { Promise.resolve(writersBySlot[slot].stop()).catch(() => {}); } catch {}
      }
    }
  }

  function enqueueIO(operation) {
    if (blocked || closing || closed) return Promise.reject(contextError('reclamation_service_blocked'));
    const result = ioTail.then(() => {
      if (blocked || closing || closed) throw contextError('reclamation_service_blocked');
      return operation();
    });
    ioTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function acquireOrResize(bytes) {
    if (lease === null) {
      const acquired = capacityBudget.acquire(bytes);
      let released = false;
      lease = Object.freeze({
        resize(nextBytes) {
          if (released) throw contextError('reclamation_capacity_lease_released');
          acquired.resize(nextBytes);
        },
        release() {
          if (released) return false;
          released = true;
          leaseReleased = true;
          return acquired.release();
        },
        status() {
          return acquired.status();
        },
      });
    } else {
      lease.resize(bytes);
    }
  }

  function capacityLeaseFacade() {
    return Object.freeze({
      acquire(bytes) {
        acquireOrResize(lease === null ? bytes : Math.max(lease.status().bytes, bytes));
        return lease;
      },
      status: () => capacityBudget.status(),
    });
  }

  function assertWriterMap(value) {
    const supplied = captureExactRecord(value, configuredSlots, 'invalid_reclamation_migration_writers');
    const result = makeRecord(configuredSlots.map((slot) => {
      const writer = captureExactRecord(supplied[slot], WRITER_FIELDS,
        'invalid_reclamation_migration_writers');
      for (const field of WRITER_FIELDS) requireValue(typeof writer[field] === 'function',
        'invalid_reclamation_migration_writers');
      return [slot, writer];
    }));
    return result;
  }

  async function stopAndDrainWriters() {
    const stopResults = [];
    for (const slot of configuredSlots) {
      try { stopResults.push(Promise.resolve(writersBySlot[slot].stop())); } catch (error) {
        stopResults.push(Promise.reject(error));
      }
    }
    const stopped = await Promise.allSettled(stopResults);
    const drainResults = [];
    for (const slot of configuredSlots) {
      try { drainResults.push(Promise.resolve(writersBySlot[slot].drain())); } catch (error) {
        drainResults.push(Promise.reject(error));
      }
    }
    const drained = await Promise.allSettled(drainResults);
    if (stopped.some((item) => item.status === 'rejected') || drained.some((item) => item.status === 'rejected')) {
      throw contextError('reclamation_writer_stop_or_drain_failed');
    }
  }

  function normalizeFullSnapshot(value) {
    const captured = captureExactRecord(value, ['anchor', 'stores'], 'invalid_reclamation_service_snapshot');
    const normalizedAnchor = normalizeQuestionReclamationAnchorV1Local(captured.anchor);
    const suppliedStores = captureExactRecord(captured.stores, STORE_ORDER,
      'invalid_reclamation_service_snapshot');
    const normalizedStores = makeRecord(STORE_ORDER.map((slot) => {
      const store = configuredSlots.includes(slot) ? normalizeStore(slot, suppliedStores[slot]) : null;
      requireValue(configuredSlots.includes(slot) || suppliedStores[slot] === null,
        'invalid_reclamation_service_snapshot');
      return [slot, store];
    }));
    const validation = validateReclamationSnapshot({ anchor: normalizedAnchor, stores: normalizedStores });
    requireValue(validation.status === 'ready', 'reclamation_snapshot_requires_reconciliation');
    return validation.snapshot;
  }

  function installSnapshot(value) {
    const normalized = normalizeFullSnapshot(value);
    if (opened) {
      requireValue(sameAnchor(anchor, normalized.anchor), 'reclamation_resume_mismatch');
      for (const slot of configuredSlots) {
        requireValue(sameStore(slot, stores[slot], normalized.stores[slot]), 'reclamation_resume_mismatch');
      }
      return;
    }
    anchor = cloneSnapshot(normalized.anchor);
    stores = cloneSnapshot(normalized.stores);
    opened = true;
  }

  function backend(slot) {
    if (typeof slot !== 'string' || !configuredSlots.includes(slot)) {
      throw contextError('reclamation_persistence_slot_not_configured');
    }
    return Object.freeze({
      slot,
      normalByteLimit: normalByteLimitsBySlot[slot],
      canWrite() {
        return contextCanWrite();
      },
      getStoreId() {
        if (!opened || anchor === null) throw contextError('reclamation_writer_cold');
        return anchor.storeId;
      },
      async load() {
        await ready;
        if (!opened || blocked || closing || closed) throw contextError('reclamation_service_blocked');
        return cloneSnapshot(currentStore(slot));
      },
      save(candidateValue, assertBeforeWrite = undefined) {
        if (assertBeforeWrite !== undefined && typeof assertBeforeWrite !== 'function') {
          return Promise.reject(contextError('invalid_reclamation_write_guard'));
        }
        let candidate;
        let encoded;
        try {
          candidate = normalizeStore(slot, candidateValue);
          encoded = encodeStore(slot, candidate);
        } catch (error) {
          return Promise.reject(error);
        }
        return enqueueIO(async () => {
          requireValue(contextCanWrite(), 'reclamation_service_blocked');
          requireValue(opened && anchor !== null && stores[slot] !== null, 'reclamation_writer_cold');
          const previous = stores[slot];
          requireValue(candidate.storeId === previous.storeId &&
            previous.revision < Number.MAX_SAFE_INTEGER && candidate.revision === previous.revision + 1,
          'reclamation_store_transition_rejected');
          const nextStores = cloneSnapshot(stores);
          nextStores[slot] = candidate;
          const transition = validateReclamationStoreWrite({
            anchor,
            previousStores: stores,
            nextStores,
            normalByteLimitsBySlot: limitsForTransitions,
          });
          requireValue(sameStore(slot, transition.snapshot.stores[slot], candidate),
            'reclamation_store_transition_rejected');
          const newAdmission = requiresNormalAdmissionLimit(slot, previous, candidate);
          measurementLimit(slot, candidate, normalByteLimitsBySlot[slot], newAdmission, anchor);
          const grantBytes = candidate.migrationAllowance?.maxExtraBytes ?? 0;
          const writeLimit = checkedAddBytes(normalByteLimitsBySlot[slot], grantBytes);
          requireValue(encoded.sizeBytes <= writeLimit, 'reclamation_capacity_exceeded');
          if (assertBeforeWrite !== undefined) {
            const result = assertBeforeWrite();
            if (result !== undefined) {
              if (utilTypes.isPromise(result)) Promise.prototype.catch.call(result, () => {});
              throw contextError('invalid_reclamation_write_guard');
            }
          }
          try {
            await persistence.writeSlotBytes(slot, encoded.bytes, writeLimit);
            const readback = await persistence.readSlotBytes(slot, writeLimit);
            requireValue(readback !== null && sameBytes(readback, encoded.bytes),
              'reclamation_persistence_readback_mismatch');
          } catch (error) {
            block(error);
            throw error;
          }
          stores[slot] = candidate;
          return cloneSnapshot(candidate);
        });
      },
      prepareResume(snapshot) {
        if (closing || closed || blocked) throw contextError('reclamation_service_blocked');
        installSnapshot(snapshot);
      },
      flush() {
        return ioTail.then(() => {
          if (blocked || closing || closed) throw contextError('reclamation_service_blocked');
        });
      },
      close,
      getSnapshot() {
        return cloneSnapshot(currentStore(slot));
      },
    });
  }

  async function readNormalSnapshotForRepair() {
    const anchorBytes = await persistence.readAnchorBytes(
      FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes);
    if (anchorBytes === null) return null;
    const anchor = normalizeQuestionReclamationAnchorV1Local(
      decodeSourceBytes(anchorBytes, FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes).value);
    if (anchor.migration !== null) return null;
    requireValue(anchorBytes.length <= NORMAL_ANCHOR_MAX_BYTES, 'reclamation_capacity_exceeded');
    const rawBytes = makeRecord([]);
    const loadedStores = makeRecord(STORE_ORDER.map((slot) => [slot, null]));
    for (const slot of configuredSlots) {
      const bytes = await persistence.readSlotBytes(slot, slotMaximum(slot));
      requireValue(bytes !== null, 'reclamation_missing_mandatory_slot');
      rawBytes[slot] = bytes;
      const decoded = decodeSourceBytes(bytes, slotMaximum(slot));
      loadedStores[slot] = normalizeStore(slot, decoded.value);
      const grantBytes = loadedStores[slot].migrationAllowance?.maxExtraBytes ?? 0;
      requireValue(bytes.length <= checkedAddBytes(normalByteLimitsBySlot[slot], grantBytes),
        'reclamation_capacity_exceeded');
    }
    const validation = validateReclamationSnapshot({ anchor, stores: loadedStores });
    const reasons = captureDenseArray(validation.reasons, REPAIR_REASONS.size,
      'reclamation_snapshot_requires_reconciliation');
    requireValue(reasons.every((reason) => REPAIR_REASONS.has(reason)),
      'reclamation_snapshot_requires_reconciliation');
    const retired = new Set(anchor.retiredQuestionPeriods.map((item) =>
      identityPeriodKey(item.identity, item.periodId)));
    const periods = new Map();
    for (const reservation of loadedStores.questions.reservations) {
      const key = identityPeriodKey(reservation.identity, reservation.periodId);
      if (!retired.has(key) && !periods.has(key)) {
        periods.set(key, { identity: reservation.identity, periodId: reservation.periodId });
      }
    }
    let nextAnchor = anchor;
    if (periods.size > 0) {
      const retiredAt = input.now();
      assertSafeUnsignedInteger(retiredAt, 'invalid_question_retirement_time');
      requireValue(anchor.revision < Number.MAX_SAFE_INTEGER, 'reclamation_anchor_revision_overflow');
      nextAnchor = normalizeQuestionReclamationAnchorV1Local({
        schemaVersion: 1,
        revision: anchor.revision + 1,
        storeId: anchor.storeId,
        retiredQuestionPeriods: [...anchor.retiredQuestionPeriods,
          ...[...periods.values()].map((period) => ({
            identity: period.identity,
            periodId: period.periodId,
            retiredAt,
            reason: 'startup-quarantine',
          }))],
        migration: null,
      });
    }
    const transition = validateReclamationTransition({
      previous: anchor,
      next: nextAnchor,
      previousStores: loadedStores,
      nextStores: validation.snapshot.stores,
      normalByteLimitsBySlot: limitsForTransitions,
    });
    const finalValidation = validateReclamationSnapshot({
      anchor: nextAnchor,
      stores: transition.snapshot.stores,
    });
    const finalReasons = captureDenseArray(finalValidation.reasons, REPAIR_REASONS.size,
      'reclamation_snapshot_requires_reconciliation');
    requireValue(finalReasons.every((reason) => REPAIR_REASONS.has(reason)),
      'reclamation_snapshot_requires_reconciliation');
    const repairReasons = [...new Set([...reasons, ...transition.reasons, ...finalReasons])];
    requireValue(repairReasons.length <= REPAIR_REASONS.size &&
      repairReasons.every((reason) => REPAIR_REASONS.has(reason)),
    'reclamation_snapshot_requires_reconciliation');
    return {
      anchorBytes,
      rawBytes,
      originalAnchor: anchor,
      anchor: nextAnchor,
      stores: finalValidation.snapshot.stores,
      reasons: repairReasons,
    };
  }

  function coldRepairReservation(repair) {
    const slots = configuredSlots.map((slot) => ({
      slot,
      sourceSizeBytes: repair.stores[slot].migrationAllowance?.sourceSizeBytes ?? repair.rawBytes[slot].length,
      normalByteLimit: normalByteLimitsBySlot[slot],
      grantBytes: repair.stores[slot].migrationAllowance?.maxExtraBytes ?? 0,
    }));
    return computePhysicalReclamationBounds({
      anchorByteLimit: NORMAL_ANCHOR_MAX_BYTES,
      slots,
    }).postMigrationReservationBytes;
  }

  async function saveRepairAnchor(repair) {
    if (sameAnchor(repair.originalAnchor, repair.anchor)) return;
    const encoded = encodeQuestionReclamationAnchorV1Local(repair.anchor);
    requireValue(encoded.sizeBytes <= NORMAL_ANCHOR_MAX_BYTES, 'reclamation_anchor_size_limit');
    try {
      await persistence.writeAnchorBytes(encoded.bytes, NORMAL_ANCHOR_MAX_BYTES);
      const readback = await persistence.readAnchorBytes(NORMAL_ANCHOR_MAX_BYTES);
      requireValue(readback !== null && sameBytes(readback, encoded.bytes),
        'reclamation_persistence_readback_mismatch');
    } catch (error) {
      block(error);
      throw error;
    }
  }

  async function saveRepairSlot(slot, repair) {
    const candidate = repair.stores[slot];
    const current = repair.rawBytes[slot];
    const canonical = encodeStore(slot, candidate);
    if (sameBytes(current, canonical.bytes)) return;
    const limit = checkedAddBytes(normalByteLimitsBySlot[slot],
      candidate.migrationAllowance?.maxExtraBytes ?? 0);
    requireValue(canonical.sizeBytes <= limit, 'reclamation_capacity_exceeded');
    try {
      await persistence.writeSlotBytes(slot, canonical.bytes, limit);
      const readback = await persistence.readSlotBytes(slot, limit);
      requireValue(readback !== null && sameBytes(readback, canonical.bytes),
        'reclamation_persistence_readback_mismatch');
      repair.rawBytes[slot] = readback;
    } catch (error) {
      block(error);
      throw error;
    }
  }

  function fullSnapshotForRepair(repair) {
    return makeRecord([
      ['anchor', repair.anchor],
      ['stores', fullStores(configuredSlots, repair.stores)],
    ]);
  }

  async function savePreparedBodyBoundary(repair, step, errorCode = 'invalid_question_body_reclamation_plan') {
    const slot = step.slot;
    if (!['questions', 'instructions', 'checkpoint'].includes(slot) ||
        (step.boundary === 'checkpoint-grave') !== (slot === 'checkpoint')) {
      throw contextError(errorCode);
    }
    const currentStores = repair.stores;
    const nextStores = cloneSnapshot(currentStores);
    nextStores[slot] = normalizeStore(slot, step.snapshot.stores[slot]);
    const transition = validateReclamationStoreWrite({
      anchor: repair.anchor,
      previousStores: currentStores,
      nextStores,
      normalByteLimitsBySlot: limitsForTransitions,
    });
    requireValue(sameStore(slot, transition.snapshot.stores[slot], nextStores[slot]),
      errorCode);
    const validation = validateReclamationSnapshot({
      anchor: repair.anchor,
      stores: transition.snapshot.stores,
    });
    requireValue(validation.status === 'ready', 'reclamation_snapshot_requires_reconciliation');
    const candidate = validation.snapshot.stores[slot];
    const encoded = encodeStore(slot, candidate);
    const limit = checkedAddBytes(normalByteLimitsBySlot[slot], candidate.migrationAllowance?.maxExtraBytes ?? 0);
    requireValue(limit <= slotMaximum(slot) && encoded.sizeBytes <= limit, 'reclamation_capacity_exceeded');
    measurementLimit(slot, candidate, normalByteLimitsBySlot[slot], false, repair.anchor);
    requireValue(!closing && !closed && !blocked, 'reclamation_service_context_closed');
    try {
      await persistence.writeSlotBytes(slot, encoded.bytes, limit);
      const readback = await persistence.readSlotBytes(slot, limit);
      requireValue(readback !== null && sameBytes(readback, encoded.bytes),
        'reclamation_persistence_readback_mismatch');
      repair.stores[slot] = candidate;
      repair.rawBytes[slot] = readback;
    } catch (error) {
      block(error);
      throw error;
    }
  }

  async function continuePreparedBodyReclamations(repair) {
    if (repair === null || repair.stores.questions === null) return;
    const prepared = repair.stores.questions.reservations.filter((reservation) =>
      reservation.reclamation !== null && reservation.bodyState === 'retained');
    if (prepared.length === 0) return;
    acquireOrResize(coldRepairReservation(repair));
    for (const reservation of prepared) {
      const clock = observeClock();
      if (clock.now === null || !clock.synchronized) continue;
      const planned = planQuestionBodyReclamation({
        ...fullSnapshotForRepair(repair),
        normalByteLimitsBySlot: limitsForTransitions,
        internalQuestionId: reservation.internalQuestionId,
        now: clock.now,
      });
      if (planned.status === 'deferred') continue;
      requireValue(planned.status === 'planned', 'invalid_question_body_reclamation_plan');
      for (const step of planned.steps) await savePreparedBodyBoundary(repair, step);
    }
  }

  async function continuePreparedInstructionBodies(repair) {
    if (repair === null || repair.stores.instructions === null) return;
    const prepared = repair.stores.instructions.instructions.filter((record) =>
      record.recordType === 'detail' && record.reclamation !== null);
    if (prepared.length === 0) return;
    acquireOrResize(coldRepairReservation(repair));
    for (const record of prepared) {
      const clock = observeClock();
      if (clock.now === null || !clock.synchronized) continue;
      const planned = planInstructionBodyReclamation({
        ...fullSnapshotForRepair(repair), normalByteLimitsBySlot: limitsForTransitions,
        deliveryAttemptId: record.deliveryAttemptId, now: clock.now,
      });
      if (planned.status === 'deferred') continue;
      requireValue(planned.status === 'planned', 'invalid_instruction_body_reclamation_plan');
      for (const step of planned.steps) await savePreparedBodyBoundary(repair, step, 'invalid_instruction_body_reclamation_plan');
    }
  }

  async function repairColdStartup() {
    const repair = await readNormalSnapshotForRepair();
    if (repair === null) return null;
    if (!sameAnchor(repair.originalAnchor, repair.anchor) || repair.reasons.length > 0) {
      acquireOrResize(coldRepairReservation(repair));
      await saveRepairAnchor(repair);
      for (const slot of ['checkpoint', 'instructions', 'questions']) {
        if (configuredSlots.includes(slot)) await saveRepairSlot(slot, repair);
      }
    }
    const validation = validateReclamationSnapshot({ anchor: repair.anchor, stores: repair.stores });
    requireValue(validation.status === 'ready', 'reclamation_snapshot_requires_reconciliation');
    return repair;
  }

  function start(writersValue) {
    if (startPromise !== null) return startPromise;
    if (closing || closed) return Promise.reject(contextError('reclamation_service_context_closed'));
    if (blocked) return Promise.reject(contextError('reclamation_service_blocked'));
    writersBySlot = assertWriterMap(writersValue);
    coordinator = createReclamationMigrationCoordinator({
      persistence,
      writersBySlot,
      capacityBudget: capacityLeaseFacade(),
      normalByteLimitsBySlot,
      ...(input.now === Date.now ? {} : { now: input.now }),
      ...(input.createStoreId ? { createStoreId: input.createStoreId } : {}),
      ...(input.createOperationId ? { createOperationId: input.createOperationId } : {}),
    });
    startPromise = (async () => {
      try {
        observeClock();
        await stopAndDrainWriters();
        const repair = await repairColdStartup();
        await continuePreparedBodyReclamations(repair);
        await continuePreparedInstructionBodies(repair);
        const result = await coordinator.start();
        requireValue(result.status === 'ready' && contextCanWrite(), 'reclamation_service_start_failed');
        readyPending = false;
        readyResolve(cloneSnapshot(result.snapshot));
        return result;
      } catch (error) {
        block(error);
        throw error;
      }
    })();
    return startPromise;
  }

  async function persistAnchorForRetirement(nextAnchor, identity, periodId, retiredAt, reason) {
    const encoded = encodeQuestionReclamationAnchorV1Local(nextAnchor);
    requireValue(encoded.sizeBytes <= NORMAL_ANCHOR_MAX_BYTES, 'reclamation_anchor_size_limit');
    return enqueueIO(async () => {
      const validated = validateQuestionPeriodRetirementAnchorTransition({
        previous: anchor,
        next: nextAnchor,
        identity,
        periodId,
        retiredAt,
        reason,
      });
      try {
        await persistence.writeAnchorBytes(encodeQuestionReclamationAnchorV1Local(validated).bytes,
          NORMAL_ANCHOR_MAX_BYTES);
        const readback = await persistence.readAnchorBytes(NORMAL_ANCHOR_MAX_BYTES);
        requireValue(readback !== null && sameBytes(readback, encoded.bytes),
          'reclamation_persistence_readback_mismatch');
        anchor = validated;
      } catch (error) {
        block(error);
        throw error;
      }
    });
  }

  async function retireQuestionPeriod(value) {
    const fields = ['identity', 'periodId', 'questionService', 'deliveryStore'];
    let keys;
    try {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
      keys = Reflect.ownKeys(value);
    } catch {
      throw contextError('invalid_question_period_retirement');
    }
    const hasReason = keys.includes('reason');
    const inputValue = captureExactRecord(value, hasReason ? [...fields, 'reason'] : fields,
      'invalid_question_period_retirement');
    if (!inputValue.questionService || typeof inputValue.questionService.withRetirementSnapshot !== 'function' ||
        !inputValue.deliveryStore || typeof inputValue.deliveryStore.withQuestionRetirement !== 'function') {
      throw contextError('invalid_question_period_retirement');
    }
    if (!contextCanWrite()) throw contextError('question_gate_closed');
    const ticket = periodGate.beginRetirement(inputValue.identity, inputValue.periodId);
    try {
      const retiredAt = input.now();
      assertSafeUnsignedInteger(retiredAt, 'invalid_question_retirement_time');
      const result = await inputValue.questionService.withRetirementSnapshot(ticket, async (questionAccess) =>
        inputValue.deliveryStore.withQuestionRetirement(ticket, async (checkpointAccess) => {
          periodGate.assertRetirement(ticket);
          const questionJournal = questionAccess.snapshot();
          const checkpoint = checkpointAccess.snapshot();
          const planned = planQuestionPeriodRetirement({
            anchor,
            questionJournal,
            checkpoint,
            identity: inputValue.identity,
            periodId: inputValue.periodId,
            retiredAt,
            ...(hasReason ? { reason: inputValue.reason } : {}),
          });
          await persistAnchorForRetirement(planned.anchor, inputValue.identity, inputValue.periodId,
            retiredAt, hasReason ? inputValue.reason : 'confirmed-retirement');
          periodGate.assertRetirement(ticket);
          if (!sameStore('checkpoint', checkpoint, planned.checkpoint)) {
            await checkpointAccess.persist(planned.checkpoint);
          }
          periodGate.assertRetirement(ticket);
          if (!sameStore('questions', questionJournal, planned.questionJournal)) {
            await questionAccess.persist(planned.questionJournal);
          }
          periodGate.assertRetirement(ticket);
          periodGate.finishRetirement(ticket);
          return Object.freeze({ status: 'retired', snapshot: currentSnapshot() });
        }));
      return result;
    } catch (error) {
      block(error);
      throw error;
    }
  }

  function captureRetiredPeriodRequest(value) {
    const captured = captureExactRecord(value, ['identity', 'periodId'],
      'invalid_question_body_reclamation');
    const request = Object.freeze(makeRecord([
      ['identity', Object.freeze(captureExactRecord(captured.identity,
        ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'],
        'invalid_question_body_reclamation'))],
      ['periodId', captured.periodId],
    ]));
    if (!periodGate.isRetired(request.identity, request.periodId) || anchor === null ||
        !anchor.retiredQuestionPeriods.some((period) => period.periodId === request.periodId &&
          sameIdentity(period.identity, request.identity))) {
      throw contextError('question_period_not_retired');
    }
    return request;
  }

  function assertRetiredBodyOperation(request) {
    if (!contextCanWrite() || anchor === null || anchor.migration !== null ||
        !periodGate.isRetired(request.identity, request.periodId) ||
        !anchor.retiredQuestionPeriods.some((period) => period.periodId === request.periodId &&
          sameIdentity(period.identity, request.identity))) {
      throw contextError('question_period_not_retired');
    }
  }

  function liveBodySnapshot(questionAccess, checkpointAccess) {
    const snapshot = currentSnapshot();
    requireValue(snapshot !== null, 'reclamation_writer_cold');
    snapshot.stores.questions = questionAccess.snapshot();
    snapshot.stores.checkpoint = checkpointAccess.snapshot();
    return snapshot;
  }

  async function persistLiveBodyBoundary(step, internalQuestionId, deliveryAttemptId,
    questionAccess, checkpointAccess, request) {
    assertRetiredBodyOperation(request);
    const current = liveBodySnapshot(questionAccess, checkpointAccess);
    requireValue(sameAnchor(current.anchor, step.snapshot.anchor), 'invalid_question_body_reclamation_plan');
    const slot = step.slot;
    const candidate = normalizeStore(slot, step.snapshot.stores[slot]);
    const nextStores = cloneSnapshot(current.stores);
    nextStores[slot] = candidate;
    const transition = validateReclamationStoreWrite({
      anchor: current.anchor,
      previousStores: current.stores,
      nextStores,
      normalByteLimitsBySlot: limitsForTransitions,
    });
    requireValue(sameStore(slot, transition.snapshot.stores[slot], candidate),
      'invalid_question_body_reclamation_plan');
    for (const otherSlot of STORE_ORDER) {
      if (otherSlot !== slot && current.stores[otherSlot] !== null) {
        requireValue(sameStore(otherSlot, transition.snapshot.stores[otherSlot], current.stores[otherSlot]),
          'invalid_question_body_reclamation_plan');
      }
    }
    requireValue(transition.reasons.every((reason) =>
      ['instruction_creation_state', 'question_creation_state', 'question_checkpoint_cache'].includes(reason)),
    'invalid_question_body_reclamation_plan');
    let saved;
    if (slot === 'questions') {
      saved = await questionAccess.persist(internalQuestionId, candidate);
    } else if (slot === 'checkpoint' && deliveryAttemptId !== null) {
      saved = await checkpointAccess.persist(candidate, deliveryAttemptId);
    } else {
      throw contextError('invalid_question_body_reclamation_plan');
    }
    requireValue(sameStore(slot, candidate, saved), 'reclamation_persistence_readback_mismatch');
  }

  async function reclaimQuestionBodies(value) {
    const inputValue = captureExactRecord(value,
      ['identity', 'periodId', 'questionService', 'deliveryStore'], 'invalid_question_body_reclamation');
    const request = captureRetiredPeriodRequest(makeRecord([
      ['identity', inputValue.identity], ['periodId', inputValue.periodId],
    ]));
    if (!contextCanWrite()) throw contextError('reclamation_service_blocked');
    const questionService = inputValue.questionService;
    const deliveryStore = inputValue.deliveryStore;
    if (!questionService || typeof questionService.withRetiredQuestionBodies !== 'function' ||
        !deliveryStore || typeof deliveryStore.withRetiredQuestionCheckpoint !== 'function') {
      throw contextError('invalid_question_body_reclamation');
    }
    const reclaimedQuestionIds = [];
    const deferredQuestionIds = [];
    try {
      await questionService.withRetiredQuestionBodies(request, async (questionAccess) =>
        deliveryStore.withRetiredQuestionCheckpoint(request, async (checkpointAccess) => {
          assertRetiredBodyOperation(request);
          const initial = liveBodySnapshot(questionAccess, checkpointAccess);
          const internalQuestionIds = initial.stores.questions.reservations
            .filter((reservation) => reservation.periodId === request.periodId &&
              sameIdentity(reservation.identity, request.identity))
            .map((reservation) => reservation.internalQuestionId);
          for (const internalQuestionId of internalQuestionIds) {
            assertRetiredBodyOperation(request);
            const base = liveBodySnapshot(questionAccess, checkpointAccess);
            const reservation = base.stores.questions.reservations.find((item) =>
              item.internalQuestionId === internalQuestionId);
            if (!reservation || reservation.bodyState === 'reclaimed') {
              if (reservation?.bodyState === 'reclaimed') reclaimedQuestionIds.push(internalQuestionId);
              continue;
            }
            const clock = observeClock();
            if (clock.now === null || !clock.synchronized) {
              deferredQuestionIds.push(internalQuestionId);
              continue;
            }
            const planInput = {
              ...base,
              normalByteLimitsBySlot: limitsForTransitions,
              internalQuestionId,
              now: clock.now,
              ...(reservation.reclamation === null ? {} : { operationId: reservation.reclamation.operationId }),
            };
            let planned = planQuestionBodyReclamation(planInput);
            if (planned.status === 'eligible') {
              const operationId = input.createOperationId ? input.createOperationId() : randomUUID();
              planned = planQuestionBodyReclamation({ ...planInput, operationId });
            }
            if (planned.status === 'deferred') {
              deferredQuestionIds.push(internalQuestionId);
              continue;
            }
            if (planned.status === 'complete') {
              reclaimedQuestionIds.push(internalQuestionId);
              continue;
            }
            requireValue(planned.status === 'planned', 'invalid_question_body_reclamation_plan');
            for (const step of planned.steps) {
              await persistLiveBodyBoundary(step, internalQuestionId,
                reservation.deliveryIntent?.deliveryAttemptId ?? null,
                questionAccess, checkpointAccess, request);
            }
            reclaimedQuestionIds.push(internalQuestionId);
          }
        }));
      return Object.freeze({
        status: deferredQuestionIds.length === 0 ? 'complete' : 'deferred',
        reclaimedQuestionIds: Object.freeze(reclaimedQuestionIds),
        deferredQuestionIds: Object.freeze(deferredQuestionIds),
      });
    } catch (error) {
      block(error);
      throw error;
    }
  }

  async function reclaimInstructionBody(value) {
    const captured = captureExactRecord(value, ['deliveryAttemptId', 'instructionService', 'deliveryStore'],
      'invalid_instruction_body_reclamation');
    assertIdentifier(captured.deliveryAttemptId, 'invalid_instruction_body_reclamation');
    const request = Object.freeze({ deliveryAttemptId: captured.deliveryAttemptId });
    const service = captured.instructionService;
    const store = captured.deliveryStore;
    if (!service || typeof service.withInstructionBody !== 'function' ||
        !store || typeof store.withInstructionBodyCheckpoint !== 'function') {
      throw contextError('invalid_instruction_body_reclamation');
    }
    requireValue(contextCanWrite(), 'reclamation_service_blocked');
    try {
      return await service.withInstructionBody(request, (instructionAccess) =>
        store.withInstructionBodyCheckpoint(request, async (checkpointAccess) => {
          const snapshot = () => {
            requireValue(contextCanWrite() && anchor !== null && anchor.migration === null,
              'reclamation_service_blocked');
            const current = currentSnapshot();
            current.stores.instructions = instructionAccess.snapshot();
            current.stores.checkpoint = checkpointAccess.snapshot();
            return current;
          };
          const base = snapshot();
          const record = base.stores.instructions.instructions.find((item) =>
            item.deliveryAttemptId === request.deliveryAttemptId);
          if (!record) throw contextError('instruction_not_found');
          if (record.recordType === 'reclaimed') {
            const completed = planInstructionBodyReclamation({ ...base,
              normalByteLimitsBySlot: limitsForTransitions,
              deliveryAttemptId: request.deliveryAttemptId, now: record.reclaimedAt });
            requireValue(completed.status === 'complete', 'invalid_instruction_body_reclamation_plan');
            return Object.freeze({ status: 'complete', deliveryAttemptId: request.deliveryAttemptId });
          }
          const clock = observeClock();
          if (clock.now === null || !clock.synchronized) {
            return Object.freeze({ status: 'deferred', deliveryAttemptId: request.deliveryAttemptId });
          }
          const planInput = { ...base, normalByteLimitsBySlot: limitsForTransitions,
            deliveryAttemptId: request.deliveryAttemptId, now: clock.now };
          let planned = planInstructionBodyReclamation(planInput);
          if (planned.status === 'eligible') {
            planned = planInstructionBodyReclamation({ ...planInput,
              operationId: input.createOperationId ? input.createOperationId() : randomUUID() });
          }
          if (planned.status === 'deferred' || planned.status === 'complete') {
            return Object.freeze({ status: planned.status, deliveryAttemptId: request.deliveryAttemptId });
          }
          requireValue(planned.status === 'planned', 'invalid_instruction_body_reclamation_plan');
          for (const step of planned.steps) {
            const current = snapshot();
            requireValue(sameAnchor(current.anchor, step.snapshot.anchor), 'invalid_instruction_body_reclamation_plan');
            const slot = step.slot;
            requireValue(['instructions', 'checkpoint'].includes(slot), 'invalid_instruction_body_reclamation_plan');
            const candidate = normalizeStore(slot, step.snapshot.stores[slot]);
            const nextStores = cloneSnapshot(current.stores);
            nextStores[slot] = candidate;
            const transition = validateReclamationStoreWrite({ anchor: current.anchor,
              previousStores: current.stores, nextStores, normalByteLimitsBySlot: limitsForTransitions });
            for (const otherSlot of STORE_ORDER) {
              requireValue(nextStores[otherSlot] === null
                ? transition.snapshot.stores[otherSlot] === null
                : sameStore(otherSlot, transition.snapshot.stores[otherSlot], nextStores[otherSlot]),
              'invalid_instruction_body_reclamation_plan');
            }
            requireValue(transition.reasons.every((reason) =>
              ['instruction_creation_state', 'question_creation_state', 'question_checkpoint_cache'].includes(reason)),
            'invalid_instruction_body_reclamation_plan');
            const saved = slot === 'instructions' ? await instructionAccess.persist(candidate)
              : await checkpointAccess.persist(candidate);
            requireValue(sameStore(slot, candidate, saved), 'reclamation_persistence_readback_mismatch');
          }
          return Object.freeze({ status: 'complete', deliveryAttemptId: request.deliveryAttemptId });
        }));
    } catch (error) {
      if (error.code !== 'instruction_not_found') block(error);
      throw error;
    }
  }

  async function reclaimTerminalDeliveryBody(value) {
    const captured = captureExactRecord(value, ['deliveryAttemptId', 'deliveryStore'],
      'invalid_terminal_delivery_body_reclamation');
    assertIdentifier(captured.deliveryAttemptId, 'invalid_terminal_delivery_body_reclamation');
    const request = Object.freeze({ deliveryAttemptId: captured.deliveryAttemptId });
    const store = captured.deliveryStore;
    if (!store || typeof store.withTerminalDeliveryBodyCheckpoint !== 'function') {
      throw contextError('invalid_terminal_delivery_body_reclamation');
    }
    requireValue(contextCanWrite(), 'reclamation_service_blocked');
    try {
      return await store.withTerminalDeliveryBodyCheckpoint(request, async (checkpointAccess) => {
        const snapshot = () => {
          requireValue(contextCanWrite() && anchor !== null && anchor.migration === null,
            'reclamation_service_blocked');
          const current = currentSnapshot();
          current.stores.checkpoint = checkpointAccess.snapshot();
          return current;
        };
        const base = snapshot();
        const record = base.stores.checkpoint.ledger.deliveries.find((item) =>
          item.deliveryAttemptId === request.deliveryAttemptId);
        if (!record) throw contextError('delivery_not_found');
        requireValue(['pr-notification', 'result'].includes(record.kind), 'invalid_terminal_delivery_body_reclamation_kind');
        if (record.recordType === 'reclaimed') {
          const completed = planTerminalDeliveryBodyReclamation({ ...base,
            normalByteLimitsBySlot: limitsForTransitions,
            deliveryAttemptId: request.deliveryAttemptId, now: record.reclamation.reclaimedAt });
          requireValue(completed.status === 'complete', 'invalid_terminal_delivery_body_reclamation_plan');
          return Object.freeze({ status: 'complete', deliveryAttemptId: request.deliveryAttemptId });
        }
        const clock = observeClock();
        if (clock.now === null || !clock.synchronized) {
          const validation = validateReclamationStoreWrite({ anchor: base.anchor,
            previousStores: base.stores, nextStores: base.stores, normalByteLimitsBySlot: limitsForTransitions });
          requireValue(validation.reasons.every((reason) =>
            ['instruction_creation_state', 'question_creation_state', 'question_checkpoint_cache'].includes(reason)),
          'invalid_terminal_delivery_body_reclamation_plan');
          return Object.freeze({ status: 'deferred', deliveryAttemptId: request.deliveryAttemptId });
        }
        const planInput = { ...base, normalByteLimitsBySlot: limitsForTransitions,
          deliveryAttemptId: request.deliveryAttemptId, now: clock.now };
        let planned = planTerminalDeliveryBodyReclamation(planInput);
        if (planned.status === 'eligible') {
          planned = planTerminalDeliveryBodyReclamation({ ...planInput,
            operationId: input.createOperationId ? input.createOperationId() : randomUUID() });
        }
        if (planned.status === 'deferred' || planned.status === 'complete') {
          return Object.freeze({ status: planned.status, deliveryAttemptId: request.deliveryAttemptId });
        }
        requireValue(planned.status === 'planned' && Array.isArray(planned.steps) && planned.steps.length === 1,
          'invalid_terminal_delivery_body_reclamation_plan');
        for (const step of planned.steps) {
          const current = snapshot();
          requireValue(sameAnchor(current.anchor, step.snapshot.anchor), 'invalid_terminal_delivery_body_reclamation_plan');
          const slot = step.slot;
          requireValue(slot === 'checkpoint', 'invalid_terminal_delivery_body_reclamation_plan');
          const candidate = normalizeStore(slot, step.snapshot.stores[slot]);
          const nextStores = cloneSnapshot(current.stores);
          nextStores[slot] = candidate;
          const transition = validateReclamationStoreWrite({ anchor: current.anchor,
            previousStores: current.stores, nextStores, normalByteLimitsBySlot: limitsForTransitions });
          for (const otherSlot of STORE_ORDER) {
            requireValue(nextStores[otherSlot] === null
              ? transition.snapshot.stores[otherSlot] === null
              : sameStore(otherSlot, transition.snapshot.stores[otherSlot], nextStores[otherSlot]),
            'invalid_terminal_delivery_body_reclamation_plan');
          }
          requireValue(transition.reasons.every((reason) =>
            ['instruction_creation_state', 'question_creation_state', 'question_checkpoint_cache'].includes(reason)),
          'invalid_terminal_delivery_body_reclamation_plan');
          const saved = await checkpointAccess.persist(candidate);
          requireValue(sameStore(slot, candidate, saved), 'reclamation_persistence_readback_mismatch');
        }
        return Object.freeze({ status: 'complete', deliveryAttemptId: request.deliveryAttemptId });
      });
    } catch (error) {
      if (!['delivery_not_found', 'invalid_terminal_delivery_body_reclamation_kind'].includes(error.code)) block(error);
      throw error;
    }
  }

  function close() {
    if (closePromise !== null) return closePromise;
    closing = true;
    opened = false;
    if (readyPending) {
      readyPending = false;
      readyReject?.(contextError('reclamation_service_context_closed'));
    }
    if (writersBySlot !== null) {
      for (const slot of configuredSlots) {
        try { Promise.resolve(writersBySlot[slot].stop()).catch(() => {}); } catch {}
      }
    }
    closePromise = (async () => {
      let closeError = null;
      if (startPromise !== null) await startPromise.catch(() => {});
      await ioTail.catch(() => {});
      if (coordinator !== null) {
        try { await coordinator.close(); } catch (error) { closeError = error; }
      } else {
        if (writersBySlot !== null) {
          try { await stopAndDrainWriters(); } catch (error) { closeError = error; }
        }
        try { await ioTail; } catch {}
        try { await persistence.close(); } catch (error) { if (closeError === null) closeError = error; }
      }
      if (lease !== null && !leaseReleased) {
        try { lease.release(); } catch (error) { if (closeError === null) closeError = error; }
      }
      closed = true;
      closing = false;
      if (closeError !== null) throw closeError;
    })();
    return closePromise;
  }

  function status() {
    return Object.freeze({
      state: closed ? 'closed' : blocked ? 'blocked' : contextCanWrite() ? 'ready' : startPromise ? 'starting' : 'cold',
      canWrite: contextCanWrite(),
      closing,
      closed,
      failureCode,
      gate: periodGate.snapshot(),
      coordinator: coordinator?.status() ?? null,
      capacity: capacityBudget.status(),
    });
  }

  return Object.freeze({
    periodGate,
    backend,
    start,
    canWrite: contextCanWrite,
    snapshot: currentSnapshot,
    retireQuestionPeriod,
    reclaimQuestionBodies,
    reclaimInstructionBody,
    reclaimTerminalDeliveryBody,
    close,
    status,
  });
}

module.exports = { createReclamationServiceContext };
