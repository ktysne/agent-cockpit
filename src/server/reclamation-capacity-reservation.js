'use strict';

const {
  assertSafeUnsignedInteger,
  captureExactRecord,
  captureDenseArray,
} = require('./reclamation-codec-primitives');
const {
  encodeQuestionJournalV2Local,
} = require('./common-question-reclamation-codec');
const {
  encodeCheckpointV3Local,
  encodeInstructionJournalV2Local,
} = require('./delivery-reclamation-codec');
const {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
} = require('./question-reclamation-anchor-codec');
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
const { validateReclamationSnapshot } = require('./reclamation-store-consistency');

const STORE_FIELDS = Object.freeze(['questions', 'checkpoint', 'instructions']);
const ATOMIC_SLOT_ORDER = Object.freeze(['checkpoint', 'instructions', 'questions']);
const INVALID_BUDGET = 'invalid_reclamation_capacity_budget';
const INVALID_RESERVATION = 'invalid_reclamation_store_capacity';
const CAPACITY_EXCEEDED = 'reclamation_capacity_exceeded';
const BUDGET_EXCEEDED = 'reclamation_capacity_exceeded';
const OVERFLOW = 'reclamation_capacity_overflow';

function requireValue(condition, code = INVALID_RESERVATION) {
  if (!condition) throw new TypeError(code);
}

function requireCapacity(condition) {
  if (!condition) throw codedError(CAPACITY_EXCEEDED, RangeError);
}

function codedError(code, ErrorType = Error) {
  const error = new ErrorType(code);
  error.code = code;
  return error;
}

function captureRecord(value, fields, code = INVALID_RESERVATION) {
  return captureExactRecord(value, fields, code);
}

function captureArray(value, maxLength, code = INVALID_RESERVATION) {
  return captureDenseArray(value, maxLength, code);
}

function checkedAdd(left, right) {
  assertSafeUnsignedInteger(left, INVALID_RESERVATION);
  assertSafeUnsignedInteger(right, INVALID_RESERVATION);
  const total = left + right;
  if (!Number.isSafeInteger(total)) throw codedError(OVERFLOW, TypeError);
  return total;
}

function checkedSum(values) {
  return captureArray(values, 16).reduce((total, value) => checkedAdd(total, value), 0);
}

function makeRecord(entries) {
  const result = Object.create(null);
  for (const [key, value] of entries) {
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function assertBudgetSize(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw codedError(INVALID_BUDGET, TypeError);
  return value;
}

function createReclamationCapacityBudget(value) {
  const input = captureRecord(value, ['maxAdditionalBytes'], INVALID_BUDGET);
  const maxAdditionalBytes = assertBudgetSize(input.maxAdditionalBytes);
  const leases = new Set();
  let reservedBytes = 0;

  function budgetStatus() {
    return Object.freeze({
      maxAdditionalBytes,
      reservedBytes,
      availableBytes: maxAdditionalBytes - reservedBytes,
      activeLeaseCount: leases.size,
    });
  }

  function acquire(bytesValue) {
    const bytes = assertBudgetSize(bytesValue);
    if (bytes > maxAdditionalBytes - reservedBytes) throw codedError(BUDGET_EXCEEDED);

    const entry = { bytes, released: false };
    const lease = Object.freeze({
      resize(nextBytesValue) {
        const nextBytes = assertBudgetSize(nextBytesValue);
        if (entry.released) throw codedError('reclamation_capacity_lease_released', TypeError);
        const otherReservedBytes = reservedBytes - entry.bytes;
        if (nextBytes > maxAdditionalBytes - otherReservedBytes) throw codedError(BUDGET_EXCEEDED);
        reservedBytes = otherReservedBytes + nextBytes;
        entry.bytes = nextBytes;
      },
      release() {
        if (entry.released) return false;
        reservedBytes -= entry.bytes;
        entry.bytes = 0;
        entry.released = true;
        leases.delete(entry);
        return true;
      },
      status() {
        return Object.freeze({ bytes: entry.bytes, released: entry.released });
      },
    });
    leases.add(entry);
    reservedBytes += bytes;
    return lease;
  }

  return Object.freeze({ acquire, status: budgetStatus });
}

function captureStoreInputs(value) {
  const input = captureRecord(value, [
    'anchor', 'stores', 'normalByteLimitsBySlot', 'rawSizeBytesBySlot', 'rawAnchorSizeBytes',
  ]);
  const suppliedStores = captureRecord(input.stores, STORE_FIELDS);
  const configuredSlots = STORE_FIELDS.filter((slot) => suppliedStores[slot] !== null);
  requireValue(configuredSlots.every((slot) => suppliedStores[slot] !== undefined));
  const normalByteLimitsBySlot = captureRecord(input.normalByteLimitsBySlot, configuredSlots);
  const rawSizeBytesBySlot = captureRecord(input.rawSizeBytesBySlot, configuredSlots);
  for (const slot of configuredSlots) {
    assertSafeUnsignedInteger(normalByteLimitsBySlot[slot], INVALID_RESERVATION);
    requireValue(normalByteLimitsBySlot[slot] > 0 && normalByteLimitsBySlot[slot] <= MAX_SOURCE_BYTES);
    assertSafeUnsignedInteger(rawSizeBytesBySlot[slot], INVALID_RESERVATION);
  }
  assertSafeUnsignedInteger(input.rawAnchorSizeBytes, INVALID_RESERVATION);
  return {
    anchorValue: input.anchor,
    stores: suppliedStores,
    configuredSlots,
    normalByteLimitsBySlot,
    rawSizeBytesBySlot,
    rawAnchorSizeBytes: input.rawAnchorSizeBytes,
  };
}

function migrationSourceSize(anchor, slot) {
  if (anchor.migration === null) return null;
  const source = anchor.migration.sources.find((item) => item.slot === slot);
  requireValue(source !== undefined);
  return source.sourcePresent ? source.sizeBytes : 0;
}

function sourceSizeForPhysicalBound(anchor, store, slot, rawSizeBytes) {
  const migrationSize = migrationSourceSize(anchor, slot);
  if (migrationSize !== null) return migrationSize;
  const grant = store.migrationAllowance;
  return grant === null ? rawSizeBytes : grant.sourceSizeBytes;
}

function grantRoster(store, slot, migrationActive) {
  const grant = store.migrationAllowance;
  if (grant === null) return 0;
  requireValue(grant.maxExtraBytes <= FIXED_H_BOUNDS[slot]);

  const expectedIds = slot === 'questions'
    ? store.reservations.map((reservation) => reservation.internalQuestionId)
    : slot === 'checkpoint'
      ? store.ledger.deliveries.map((delivery) => delivery.deliveryAttemptId)
      : store.instructions.map((instruction) => instruction.deliveryAttemptId);
  const eligibleIds = slot === 'questions' ? grant.eligibleQuestionIds : grant.eligibleAttemptIds;
  const expected = new Set(expectedIds);
  requireValue(eligibleIds.every((identifier) => expected.has(identifier)));
  if (migrationActive) requireValue(eligibleIds.length === expected.size);
  return grant.maxExtraBytes;
}

function encodeStore(slot, store) {
  if (slot === 'questions') return encodeQuestionJournalV2Local(store);
  if (slot === 'checkpoint') return encodeCheckpointV3Local(store);
  return encodeInstructionJournalV2Local(store);
}

function measureStoreReserve(slot, snapshot, normalByteLimit) {
  if (slot === 'questions') {
    return measureQuestionJournalReservationBytes({ snapshot, currentByteLimit: normalByteLimit });
  }
  if (slot === 'checkpoint') {
    return measureCheckpointReservation({ snapshot, currentByteLimit: normalByteLimit });
  }
  return measureInstructionReservation({ snapshot, currentByteLimit: normalByteLimit });
}

function measureReclamationStoreCapacity(value) {
  const input = captureStoreInputs(value);
  const validation = validateReclamationSnapshot({ anchor: input.anchorValue, stores: input.stores });
  const anchor = validation.snapshot.anchor;
  const stores = validation.snapshot.stores;
  const allowedReasons = anchor.migration === null ? [] : ['migration_in_progress'];
  requireValue(validation.reasons.length === allowedReasons.length &&
    validation.reasons.every((reason, index) => reason === allowedReasons[index]));
  const migrationActive = anchor.migration !== null;
  const anchorLimitBytes = migrationActive
    ? FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes
    : NORMAL_ANCHOR_MAX_BYTES;
  const anchorCurrentEncodedBytes = encodeQuestionReclamationAnchorV1Local(anchor).sizeBytes;
  const pendingPeriods = stores.questions === null
    ? []
    : stores.questions.reservations.map((reservation) => ({
      identity: reservation.identity,
      periodId: reservation.periodId,
    }));
  const anchorReservation = migrationActive
    ? { projectedBytes: anchorLimitBytes }
    : measurePendingQuestionPeriodCapacity(anchor, pendingPeriods);
  requireValue(anchorReservation.projectedBytes !== null);
  const anchorReserveBytes = anchorReservation.projectedBytes;
  requireCapacity(input.rawAnchorSizeBytes <= anchorLimitBytes &&
    anchorCurrentEncodedBytes <= anchorLimitBytes && anchorReserveBytes <= anchorLimitBytes);

  const slotResults = makeRecord([]);
  const physicalSlots = [];
  for (const slot of input.configuredSlots) {
    const store = stores[slot];
    const normalByteLimit = input.normalByteLimitsBySlot[slot];
    const grantBytes = grantRoster(store, slot, migrationActive);
    const limitBytes = checkedAdd(normalByteLimit, grantBytes);
    const actualBytes = input.rawSizeBytesBySlot[slot];
    const encodedBytes = encodeStore(slot, store).sizeBytes;
    const reservation = measureStoreReserve(slot, store, normalByteLimit);
    const reserveBytes = reservation.reservedBytes;
    const requiredBytes = Math.max(actualBytes, encodedBytes, reserveBytes);
    requireCapacity(requiredBytes <= limitBytes);
    slotResults[slot] = Object.freeze({
      actualBytes,
      reserveBytes,
      normalByteLimit,
      grantBytes,
      limitBytes,
      extraUsedBytes: Math.max(0, requiredBytes - normalByteLimit),
      fitsNormal: requiredBytes <= normalByteLimit,
    });
    physicalSlots.push({
      slot,
      sourceSizeBytes: sourceSizeForPhysicalBound(anchor, store, slot, actualBytes),
      normalByteLimit,
      grantBytes,
    });
  }

  const physicalBounds = computePhysicalReclamationBounds({
    anchorByteLimit: NORMAL_ANCHOR_MAX_BYTES,
    slots: physicalSlots,
  });
  return Object.freeze({
    anchor: Object.freeze({
      actualBytes: input.rawAnchorSizeBytes,
      reserveBytes: anchorReserveBytes,
      limitBytes: anchorLimitBytes,
    }),
    slots: Object.freeze(slotResults),
    physicalBounds,
  });
}

function captureSizeMap(value, code = INVALID_RESERVATION) {
  let keys;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(code);
    keys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(code);
  }
  const fields = keys.filter((key) => typeof key === 'string');
  requireValue(fields.length === keys.length, code);
  const result = captureRecord(value, fields, code);
  for (const size of Object.values(result)) assertSafeUnsignedInteger(size, code);
  return { fields, result };
}

function addToPeak(currentBytes, additionalBytes, peaks) {
  const peak = checkedAdd(currentBytes, additionalBytes);
  if (peak > peaks.value) peaks.value = peak;
}

function measureReclamationAtomicReservation(value) {
  const input = captureRecord(value, [
    'anchorSizeBytes', 'slotSizeBytesBySlot', 'targetSizeBytesBySlot',
    'migrationAnchorMaxBytes', 'normalAnchorSizeBytes',
  ]);
  assertSafeUnsignedInteger(input.anchorSizeBytes, INVALID_RESERVATION);
  assertSafeUnsignedInteger(input.migrationAnchorMaxBytes, INVALID_RESERVATION);
  assertSafeUnsignedInteger(input.normalAnchorSizeBytes, INVALID_RESERVATION);
  requireValue(input.normalAnchorSizeBytes > 0 &&
    input.normalAnchorSizeBytes <= NORMAL_ANCHOR_MAX_BYTES);
  requireValue(input.migrationAnchorMaxBytes === 0 ||
    (input.migrationAnchorMaxBytes > 0 &&
      input.migrationAnchorMaxBytes <= FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes));

  const currentMap = captureSizeMap(input.slotSizeBytesBySlot);
  const targetMap = captureSizeMap(input.targetSizeBytesBySlot);
  const configuredSlots = ATOMIC_SLOT_ORDER.filter((slot) => currentMap.fields.includes(slot));
  requireValue(currentMap.fields.length === configuredSlots.length &&
    targetMap.fields.length === configuredSlots.length &&
    configuredSlots.every((slot) => targetMap.fields.includes(slot)));
  const currentSizes = currentMap.result;
  const targetSizes = targetMap.result;
  let currentSlotsBytes = checkedSum(configuredSlots.map((slot) => currentSizes[slot]));
  const initialAnchorBytes = input.anchorSizeBytes;
  const migrationAnchorBytes = input.migrationAnchorMaxBytes;
  const normalAnchorBytes = input.normalAnchorSizeBytes;
  const baselineBytes = checkedSum([initialAnchorBytes, currentSlotsBytes]);
  const peaks = { value: baselineBytes };

  if (migrationAnchorBytes === 0) {
    requireValue(initialAnchorBytes === 0 && configuredSlots.every((slot) => currentSizes[slot] === 0));
    for (const slot of configuredSlots) {
      addToPeak(currentSlotsBytes, targetSizes[slot], peaks);
      currentSlotsBytes = checkedAdd(currentSlotsBytes, targetSizes[slot]);
    }
    addToPeak(currentSlotsBytes, normalAnchorBytes, peaks);
  } else {
    requireValue(initialAnchorBytes <= migrationAnchorBytes);
    addToPeak(baselineBytes, migrationAnchorBytes, peaks);

    let activeSlotsBytes = currentSlotsBytes;
    let activeTotalBytes = checkedAdd(migrationAnchorBytes, activeSlotsBytes);
    addToPeak(activeTotalBytes, migrationAnchorBytes, peaks);

    for (const slot of configuredSlots) {
      addToPeak(activeTotalBytes, targetSizes[slot], peaks);
      activeSlotsBytes = checkedAdd(activeSlotsBytes, targetSizes[slot]);
      activeSlotsBytes -= currentSizes[slot];
      currentSizes[slot] = targetSizes[slot];
      activeTotalBytes = checkedAdd(migrationAnchorBytes, activeSlotsBytes);
      addToPeak(activeTotalBytes, migrationAnchorBytes, peaks);
    }

    addToPeak(activeTotalBytes, normalAnchorBytes, peaks);
  }

  return Object.freeze({
    peakBytes: peaks.value,
    additionalBytes: peaks.value - baselineBytes,
  });
}

module.exports = {
  createReclamationCapacityBudget,
  measureReclamationAtomicReservation,
  measureReclamationStoreCapacity,
};
