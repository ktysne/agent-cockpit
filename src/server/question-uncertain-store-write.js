'use strict';

const { types } = require('node:util');
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
  FIXED_H_BOUNDS,
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
  checkedCapacityAdd,
  measureCheckpointReservation,
  measureInstructionReservation,
  measurePendingQuestionPeriodCapacity,
  measureQuestionJournalReservationBytes,
} = require('./reclamation-capacity-bounds');
const {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
} = require('./question-reclamation-anchor-codec');
const { encodeNormalized } = require('./reclamation-json-codec');
const { validateReclamationStoreWrite } = require('./reclamation-store-consistency');

const INVALID_WRITE = 'invalid_question_uncertain_store_write';
const STORE_FIELDS = Object.freeze(['questions', 'checkpoint', 'instructions']);
const ALLOWED_REASONS = new Set([
  'question_creation_state',
  'question_checkpoint_cache',
  'instruction_creation_state',
]);
const NORMALIZERS = Object.freeze({
  questions: normalizeQuestionJournalV2Local,
  checkpoint: normalizeCheckpointV3Local,
  instructions: normalizeInstructionJournalV2Local,
});
const ENCODERS = Object.freeze({
  questions: encodeQuestionJournalV2Local,
  checkpoint: encodeCheckpointV3Local,
  instructions: encodeInstructionJournalV2Local,
});
const RESERVATION_MEASURERS = Object.freeze({
  questions: measureQuestionJournalReservationBytes,
  checkpoint: measureCheckpointReservation,
  instructions: measureInstructionReservation,
});

function fail() {
  throw new TypeError(INVALID_WRITE);
}

function requireValue(condition) {
  if (!condition) fail();
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function assertPlainDataTree(value, active = new Set(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    requireValue(Number.isFinite(value));
    return;
  }
  requireValue(typeof value === 'object' && !types.isProxy(value) && depth <= 128);
  requireValue(!active.has(value));
  active.add(value);
  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    requireValue(array ? prototype === Array.prototype
      : prototype === Object.prototype || prototype === null);
    const keys = Reflect.ownKeys(value);
    if (array) {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      requireValue(lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value') &&
        Number.isSafeInteger(lengthDescriptor.value) && lengthDescriptor.value >= 0 &&
        lengthDescriptor.value <= 100_000 && keys.length === lengthDescriptor.value + 1);
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
        assertPlainDataTree(descriptor.value, active, depth + 1);
      }
    } else {
      for (const key of keys) {
        requireValue(typeof key === 'string');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
        assertPlainDataTree(descriptor.value, active, depth + 1);
      }
    }
  } catch (error) {
    if (error instanceof TypeError && error.message === INVALID_WRITE) throw error;
    fail();
  } finally {
    active.delete(value);
  }
}

function captureExactRecord(value, fields) {
  requireValue(isPlainRecord(value));
  const keys = Reflect.ownKeys(value);
  requireValue(keys.length === fields.length &&
    keys.every((key) => typeof key === 'string' && fields.includes(key)));
  const result = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
    Object.defineProperty(result, field, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
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

function sameCanonicalJson(left, right) {
  if (left === null || right === null) return left === right;
  return encodeNormalized(left).bytes.equals(encodeNormalized(right).bytes);
}

function normalizeStore(slot, value) {
  return value === null ? null : NORMALIZERS[slot](value);
}

function normalizeStores(value) {
  const captured = captureExactRecord(value, STORE_FIELDS);
  return makeRecord(STORE_FIELDS.map((slot) => [slot, normalizeStore(slot, captured[slot])]));
}

function withQuestions(stores, questions) {
  return makeRecord(STORE_FIELDS.map((slot) => [slot,
    slot === 'questions' ? questions : stores[slot]]));
}

function freezeDeep(value, visited = new Set()) {
  if (value === null || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value);
  for (const key of Reflect.ownKeys(value)) freezeDeep(value[key], visited);
  return Object.freeze(value);
}

function migrationAllowance(store) {
  return store === null ? null : store.migrationAllowance;
}

function assertMigrationAllowancesUnchanged(previousStores, nextStores) {
  for (const slot of STORE_FIELDS) {
    requireValue(sameCanonicalJson(
      migrationAllowance(previousStores[slot]), migrationAllowance(nextStores[slot])));
  }
}

function questionCheckpointRows(checkpoint, field) {
  if (checkpoint === null) return [];
  return checkpoint.ledger[field].filter((record) => record.kind === 'question');
}

function assertQuestionCheckpointRowsUnchanged(previousStores, nextStores) {
  const previous = previousStores.checkpoint;
  const next = nextStores.checkpoint;
  requireValue((previous === null) === (next === null));
  if (previous === null) return;
  requireValue(sameCanonicalJson(questionCheckpointRows(previous, 'deliveries'),
    questionCheckpointRows(next, 'deliveries')));
  requireValue(sameCanonicalJson(questionCheckpointRows(previous, 'logicalTombstones'),
    questionCheckpointRows(next, 'logicalTombstones')));
}

function validateAnchorCapacity(anchor, questions) {
  requireValue(anchor.migration === null);
  const encodedBytes = encodeQuestionReclamationAnchorV1Local(anchor).sizeBytes;
  requireValue(encodedBytes <= NORMAL_ANCHOR_MAX_BYTES);
  const activePeriods = questions.reservations.map((reservation) => ({
    identity: reservation.identity,
    periodId: reservation.periodId,
  }));
  const reservation = measurePendingQuestionPeriodCapacity(anchor, activePeriods);
  requireValue(reservation.projectedBytes !== null &&
    reservation.projectedBytes <= NORMAL_ANCHOR_MAX_BYTES);
}

function validateStoreCapacity(stores, limits) {
  for (const slot of STORE_FIELDS) {
    const store = stores[slot];
    const normalByteLimit = limits[slot];
    if (store === null) {
      requireValue(normalByteLimit === null);
      continue;
    }
    requireValue(Number.isSafeInteger(normalByteLimit) && normalByteLimit > 0 &&
      normalByteLimit <= MAX_SOURCE_BYTES);
    const grantBytes = store.migrationAllowance?.maxExtraBytes ?? 0;
    requireValue(grantBytes <= FIXED_H_BOUNDS[slot]);
    const totalLimit = checkedCapacityAdd(normalByteLimit, grantBytes);
    const encodedBytes = ENCODERS[slot](store).sizeBytes;
    const reservation = RESERVATION_MEASURERS[slot]({
      snapshot: store,
      currentByteLimit: normalByteLimit,
    });
    requireValue(Math.max(encodedBytes, reservation.reservedBytes) <= totalLimit);
  }
}

function validateWorld(anchor, rawPreviousStores, rawNextStores, previousStores, nextStores, limits,
  rawQuestions, questions) {
  const worldPrevious = withQuestions(previousStores, questions);
  const worldNext = withQuestions(nextStores, questions);
  const transition = validateReclamationStoreWrite({
    anchor,
    previousStores: withQuestions(rawPreviousStores, rawQuestions),
    nextStores: withQuestions(rawNextStores, rawQuestions),
    normalByteLimitsBySlot: limits,
  });
  requireValue(transition.reasons.every((reason) => ALLOWED_REASONS.has(reason)));
  assertMigrationAllowancesUnchanged(worldPrevious, worldNext);
  assertMigrationAllowancesUnchanged(worldPrevious, transition.snapshot.stores);
  assertQuestionCheckpointRowsUnchanged(worldPrevious, worldNext);
  assertQuestionCheckpointRowsUnchanged(worldPrevious, transition.snapshot.stores);
  validateAnchorCapacity(anchor, questions);
  validateStoreCapacity(worldPrevious, limits);
  validateStoreCapacity(transition.snapshot.stores, limits);
  return transition.snapshot.stores;
}

function validateQuestionUncertainStoreWrite(value) {
  try {
    assertPlainDataTree(value);
    const input = captureExactRecord(value, [
      'anchor', 'previousStores', 'nextStores', 'questionCandidates', 'normalByteLimitsBySlot',
    ]);
    const anchor = normalizeQuestionReclamationAnchorV1Local(input.anchor);
    requireValue(anchor.migration === null);
    const rawPreviousStores = captureExactRecord(input.previousStores, STORE_FIELDS);
    const rawNextStores = captureExactRecord(input.nextStores, STORE_FIELDS);
    const previousStores = normalizeStores(input.previousStores);
    const nextStores = normalizeStores(input.nextStores);
    const limits = captureExactRecord(input.normalByteLimitsBySlot, STORE_FIELDS);
    requireValue(Array.isArray(input.questionCandidates) && input.questionCandidates.length === 2);
    const rawQuestionCandidates = input.questionCandidates.slice();
    const questionCandidates = rawQuestionCandidates.map((candidate) => normalizeStore('questions', candidate));
    requireValue(questionCandidates[0] !== null && questionCandidates[1] !== null &&
      previousStores.questions !== null && nextStores.questions !== null);
    requireValue(sameCanonicalJson(migrationAllowance(questionCandidates[0]),
      migrationAllowance(questionCandidates[1])));
    requireValue(sameCanonicalJson(previousStores.questions, questionCandidates[0]) &&
      sameCanonicalJson(nextStores.questions, questionCandidates[0]));
    assertMigrationAllowancesUnchanged(previousStores, nextStores);
    assertQuestionCheckpointRowsUnchanged(previousStores, nextStores);

    const validatedWorlds = questionCandidates.map((questions, index) =>
      validateWorld(anchor, rawPreviousStores, rawNextStores, previousStores, nextStores, limits,
        rawQuestionCandidates[index], questions));
    requireValue(sameCanonicalJson(validatedWorlds[0].checkpoint, validatedWorlds[1].checkpoint) &&
      sameCanonicalJson(validatedWorlds[0].instructions, validatedWorlds[1].instructions));
    const stores = Object.freeze({
      checkpoint: freezeDeep(validatedWorlds[0].checkpoint),
      instructions: freezeDeep(validatedWorlds[0].instructions),
    });
    return Object.freeze({ stores });
  } catch (error) {
    if (error instanceof TypeError && error.message === INVALID_WRITE) throw error;
    fail();
  }
}

module.exports = { validateQuestionUncertainStoreWrite };
