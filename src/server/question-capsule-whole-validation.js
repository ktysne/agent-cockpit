'use strict';

const { types } = require('node:util');
const { assertIdentifier } = require('./reclamation-codec-primitives');
const { assertPlainDataTree } = require('./reclamation-plain-data');
const {
  encodeQuestionJournalV2Local,
  normalizeQuestionDetailV2,
  normalizeQuestionReservation,
} = require('./common-question-reclamation-codec');
const {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
} = require('./question-reclamation-anchor-codec');
const {
  encodeCheckpointV3Local,
  encodeInstructionJournalV2Local,
  normalizeDeliveryRecordV2Local,
  normalizeInstructionJournalV2Local,
  normalizeLogicalTombstoneV2Local,
} = require('./delivery-reclamation-codec');
const { encodeNormalized } = require('./reclamation-json-codec');
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
  validateReclamationSnapshot,
  validateReclamationStoreWrite,
} = require('./reclamation-store-consistency');
const { validateQuestionRejectionCapsulePair } = require('./question-rejection-capsule-pair');
const { CAPSULE_LIMITS } = require('./question-rejection-capsule-codec');

const INVALID_WHOLE = 'invalid_question_capsule_whole_representation';
const MAX_CAPSULE_PAIRS = 20_000;
const MAX_QUESTION_RESERVATIONS = 20_000;
const MAX_DELIVERIES = 20_000;
const MAX_NOTIFICATION_TARGETS = 10_000;
const MAX_CHECKPOINT_REGISTRATION_RECORDS = 50_000;
const MAX_INSTRUCTIONS = 20_000;
const MAX_RETIRED_PERIODS = 20_000;
const MAX_ROW_ARRAY_LENGTH = 100_000;
const MAX_ROW_VISITED_VALUES = 100_000;
const MAX_CAPSULE_VISITED_VALUES = 100_000;
const TOP_LEVEL_FIELDS = [
  'formatVersion', 'anchor', 'ordinaryStores', 'capsulePairs',
  'deliveryAttemptOrder', 'questionReservationOrder', 'normalByteLimitsBySlot',
];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const ANCHOR_FIELDS = ['schemaVersion', 'revision', 'storeId', 'retiredQuestionPeriods', 'migration'];
const STORE_FIELDS = ['questions', 'checkpoint', 'instructions'];
const QUESTION_STORE_FIELDS = [
  'schemaVersion', 'storeId', 'revision', 'questions', 'reservations', 'migrationAllowance',
];
const QUESTION_CAPSULE_FIELDS = [
  'formatVersion', 'compactionOperationId', 'storeId', 'identity', 'periodId', 'reservations',
];
const CHECKPOINT_STORE_FIELDS = [
  'schemaVersion', 'storeId', 'revision', 'registrations', 'ledger', 'migrationAllowance',
];
const REGISTRATION_FIELDS = [
  'conversations', 'executions', 'launches', 'runtimeLaunches', 'connections', 'actors', 'handoffs',
  'replayClaims', 'incompleteConversationIds',
];
const LEDGER_FIELDS = ['schemaVersion', 'revision', 'deliveries', 'notificationTargets', 'logicalTombstones'];
const INSTRUCTION_STORE_FIELDS = ['schemaVersion', 'revision', 'storeId', 'migrationAllowance', 'instructions'];
const CHECKPOINT_CAPSULE_FIELDS = [
  'formatVersion', 'compactionOperationId', 'storeId', 'identity', 'periodId', 'references', 'deliveries',
];
const REFERENCE_FIELDS = ['sources', 'targets'];
const SOURCE_REFERENCE_FIELDS = [
  'launchRef', 'launchKey', 'sourceClaimsDigest', 'identity', 'executionBinding', 'conversationId', 'sessionId',
];
const CAPSULE_DELIVERY_FIELDS = [
  'recordType', 'deliveryAttemptId', 'kind', 'logicalMessageId', 'revision', 'sourceExecutionId',
  'payloadDigest', 'state', 'terminalAt', 'cancelRequested', 'ownerGeneration',
  'acceptedCorrelation', 'appliedCorrelation', 'reclamation', 'sourceRefIndex', 'targetRefIndex',
];
const LOGICAL_TOMBSTONE_FIELDS = [
  'kind', 'sourceExecutionId', 'logicalMessageId', 'revision', 'targetLaunchKey',
];
const LIMIT_FIELDS = ['questions', 'checkpoint', 'instructions'];
const SCOPE_LIMITATIONS = Object.freeze([
  'declared_delivery_order_authenticity_not_verified',
  'anchor_persistence_not_verified',
  'persistent_outer_schema_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'runtime_integration_not_verified',
]);
const CAPACITY_ENCODERS = Object.freeze({
  questions: encodeQuestionJournalV2Local,
  checkpoint: encodeCheckpointV3Local,
  instructions: encodeInstructionJournalV2Local,
});
const CAPACITY_MEASURERS = Object.freeze({
  questions: measureQuestionJournalReservationBytes,
  checkpoint: measureCheckpointReservation,
  instructions: measureInstructionReservation,
});

function requireValue(condition) {
  if (!condition) throw new TypeError(INVALID_WHOLE);
}

function captureExactRecord(value, fields) {
  requireValue(value !== null && typeof value === 'object' && !types.isProxy(value));
  let prototype;
  let ownKeys;
  try {
    requireValue(!Array.isArray(value));
    prototype = Object.getPrototypeOf(value);
    requireValue(prototype === Object.prototype || prototype === null);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(INVALID_WHOLE);
  }
  requireValue(ownKeys.length === fields.length);

  const captured = new Map();
  for (const key of ownKeys) {
    requireValue(typeof key === 'string' && fields.includes(key));
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new TypeError(INVALID_WHOLE);
    }
    requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
    captured.set(key, descriptor.value);
  }

  const result = Object.create(null);
  for (const field of fields) {
    requireValue(captured.has(field));
    Object.defineProperty(result, field, {
      value: captured.get(field), enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

function captureDenseArray(value, maximumLength) {
  requireValue(Number.isSafeInteger(maximumLength) && maximumLength >= 0 &&
    maximumLength <= MAX_ROW_ARRAY_LENGTH && !types.isProxy(value) && Array.isArray(value));
  let prototype;
  let lengthDescriptor;
  try {
    prototype = Object.getPrototypeOf(value);
    requireValue(prototype === Array.prototype);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    throw new TypeError(INVALID_WHOLE);
  }
  requireValue(lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value') && !lengthDescriptor.enumerable);
  const length = lengthDescriptor.value;
  requireValue(Number.isSafeInteger(length) && length >= 0 && length <= maximumLength);
  let ownKeys;
  try {
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(INVALID_WHOLE);
  }
  requireValue(ownKeys.length === length + 1);

  const result = new Array(length);
  for (const key of ownKeys) {
    if (key === 'length') continue;
    requireValue(typeof key === 'string');
    const index = Number(key);
    requireValue(Number.isSafeInteger(index) && index >= 0 && index < length && String(index) === key);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw new TypeError(INVALID_WHOLE);
    }
    requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
    result[index] = descriptor.value;
  }
  return result;
}

function preflightRow(value, maximumArrayLength = MAX_ROW_ARRAY_LENGTH) {
  assertPlainDataTree(value, INVALID_WHOLE, maximumArrayLength, MAX_ROW_VISITED_VALUES);
}

function preflightRows(rows) {
  for (const row of rows) preflightRow(row);
}

function makeRecord(fields) {
  const result = Object.create(null);
  for (const [key, value] of fields) {
    Object.defineProperty(result, key, {
      value, enumerable: true, writable: true, configurable: true,
    });
  }
  return result;
}

function checkedTotal(left, right, maximum) {
  const total = left + right;
  requireValue(Number.isSafeInteger(total) && total <= maximum);
  return total;
}

function canonicalJson(value) {
  return encodeNormalized(value).bytes.toString('utf8');
}

function identityPeriodKey(identity, periodId) {
  return canonicalJson(IDENTITY_FIELDS.map((field) => identity[field]).concat(periodId));
}

function logicalGroupKey(tombstone) {
  return canonicalJson([
    tombstone.kind,
    tombstone.sourceExecutionId,
    tombstone.logicalMessageId,
    tombstone.revision,
    tombstone.targetLaunchKey,
  ]);
}

function preflightGrant(value, schemaVersion) {
  if (value === null) return;
  const fields = schemaVersion === 1
    ? ['operationId', 'sourceSchemaVersion', 'sourceSizeBytes', 'sourceSha256', 'maxExtraBytes', 'eligibleQuestionIds']
    : ['operationId', 'sourceSchemaVersion', 'sourceSizeBytes', 'sourceSha256', 'maxExtraBytes', 'eligibleAttemptIds'];
  const grant = captureExactRecord(value, fields);
  const ids = schemaVersion === 1 ? grant.eligibleQuestionIds : grant.eligibleAttemptIds;
  const capturedIds = captureDenseArray(ids, MAX_QUESTION_RESERVATIONS);
  preflightRow(makeRecord(fields.map((field) => [field, field === (schemaVersion === 1
    ? 'eligibleQuestionIds' : 'eligibleAttemptIds') ? capturedIds : grant[field]])), MAX_QUESTION_RESERVATIONS);
}

function prepareAnchor(value) {
  const raw = captureExactRecord(value, ANCHOR_FIELDS);
  requireValue(raw.migration === null);
  const retiredQuestionPeriods = captureDenseArray(raw.retiredQuestionPeriods, MAX_RETIRED_PERIODS);
  preflightRows(retiredQuestionPeriods);
  const normalized = normalizeQuestionReclamationAnchorV1Local(makeRecord([
    ['schemaVersion', raw.schemaVersion], ['revision', raw.revision], ['storeId', raw.storeId],
    ['retiredQuestionPeriods', retiredQuestionPeriods], ['migration', null],
  ]));
  const retiredScopes = new Set(normalized.retiredQuestionPeriods.map((period) =>
    identityPeriodKey(period.identity, period.periodId)));
  return { normalized, retiredScopes };
}

function prepareQuestionStore(value) {
  if (value === null) return null;
  const store = captureExactRecord(value, QUESTION_STORE_FIELDS);
  const questions = captureDenseArray(store.questions, MAX_QUESTION_RESERVATIONS);
  const reservations = captureDenseArray(store.reservations, MAX_QUESTION_RESERVATIONS);
  return { store, questions, reservations };
}

function prepareCheckpointStore(value) {
  if (value === null) return null;
  const store = captureExactRecord(value, CHECKPOINT_STORE_FIELDS);
  const registrations = captureExactRecord(store.registrations, REGISTRATION_FIELDS);
  const registrationArrays = Object.create(null);
  let registrationCount = 0;
  for (const field of REGISTRATION_FIELDS) {
    registrationArrays[field] = captureDenseArray(registrations[field], MAX_CHECKPOINT_REGISTRATION_RECORDS);
    registrationCount = checkedTotal(registrationCount, registrationArrays[field].length,
      MAX_CHECKPOINT_REGISTRATION_RECORDS);
  }

  const ledger = captureExactRecord(store.ledger, LEDGER_FIELDS);
  const deliveries = captureDenseArray(ledger.deliveries, MAX_DELIVERIES);
  const notificationTargets = captureDenseArray(ledger.notificationTargets, MAX_NOTIFICATION_TARGETS);
  const logicalTombstones = captureDenseArray(ledger.logicalTombstones, MAX_QUESTION_RESERVATIONS);
  const ledgerCount = deliveries.length + notificationTargets.length + logicalTombstones.length;
  requireValue(Number.isSafeInteger(ledgerCount) && ledgerCount <=
    MAX_DELIVERIES + MAX_NOTIFICATION_TARGETS + MAX_QUESTION_RESERVATIONS);

  return {
    store,
    registrations,
    registrationArrays,
    registrationCount,
    ledger,
    deliveries,
    notificationTargets,
    logicalTombstones,
  };
}

function prepareInstructionStore(value) {
  if (value === null) return null;
  const store = captureExactRecord(value, INSTRUCTION_STORE_FIELDS);
  const instructions = captureDenseArray(store.instructions, MAX_INSTRUCTIONS);
  return { store, instructions };
}

function prepareCapsulePairShallow(value) {
  const pair = captureExactRecord(value, ['questionCapsule', 'checkpointCapsule']);
  const questionCapsule = captureExactRecord(pair.questionCapsule, QUESTION_CAPSULE_FIELDS);
  const reservations = captureDenseArray(questionCapsule.reservations, CAPSULE_LIMITS.maxQuestionEntries);
  let checkpointCapsule = null;
  let deliveries = [];
  let sourceReferences = [];
  let targetReferences = [];
  if (pair.checkpointCapsule !== null) {
    checkpointCapsule = captureExactRecord(pair.checkpointCapsule, CHECKPOINT_CAPSULE_FIELDS);
    const references = captureExactRecord(checkpointCapsule.references, REFERENCE_FIELDS);
    sourceReferences = captureDenseArray(references.sources, CAPSULE_LIMITS.maxDeliveryEntries);
    targetReferences = captureDenseArray(references.targets, CAPSULE_LIMITS.maxDeliveryEntries);
    deliveries = captureDenseArray(checkpointCapsule.deliveries, CAPSULE_LIMITS.maxDeliveryEntries);
    requireValue(sourceReferences.length <= deliveries.length && targetReferences.length <= deliveries.length);
  }
  return {
    questionCapsule,
    checkpointCapsule,
    reservations,
    deliveries,
    sourceReferences,
    targetReferences,
  };
}

function preflightOrdinaryStores(question, checkpoint, instruction) {
  if (question !== null) {
    preflightRows(question.questions);
    preflightRows(question.reservations);
    if (question.store.migrationAllowance !== null) {
      preflightGrant(question.store.migrationAllowance, 1);
    }
  }
  if (checkpoint !== null) {
    for (const field of REGISTRATION_FIELDS) {
      if (field === 'incompleteConversationIds') {
        preflightRow(checkpoint.registrationArrays[field], MAX_CHECKPOINT_REGISTRATION_RECORDS);
      } else {
        preflightRows(checkpoint.registrationArrays[field]);
      }
    }
    preflightRows(checkpoint.deliveries);
    preflightRows(checkpoint.notificationTargets);
    preflightRows(checkpoint.logicalTombstones);
    if (checkpoint.store.migrationAllowance !== null) {
      preflightGrant(checkpoint.store.migrationAllowance, 2);
    }
  }
  if (instruction !== null) {
    preflightRows(instruction.instructions);
    if (instruction.store.migrationAllowance !== null) {
      preflightGrant(instruction.store.migrationAllowance, 2);
    }
  }
}

function preflightCapsulePairs(pairs) {
  for (const pair of pairs) {
    preflightRow(makeRecord([
      ['questionCapsule', pair.questionCapsule],
      ['checkpointCapsule', pair.checkpointCapsule],
    ]), CAPSULE_LIMITS.maxQuestionEntries);
  }
}

function normalizeOrdinaryQuestionStore(question) {
  if (question === null) return null;
  const questions = question.questions.map((row) => normalizeQuestionDetailV2(row));
  const reservations = question.reservations.map((row) => normalizeQuestionReservation(row));
  return makeRecord([
    ['schemaVersion', question.store.schemaVersion], ['storeId', question.store.storeId],
    ['revision', question.store.revision], ['questions', questions], ['reservations', reservations],
    ['migrationAllowance', question.store.migrationAllowance],
  ]);
}

function normalizeOrdinaryCheckpointRecords(checkpoint) {
  if (checkpoint === null) return null;
  const deliveries = checkpoint.deliveries.map((row) => normalizeDeliveryRecordV2Local(row));
  const logicalTombstones = checkpoint.logicalTombstones.map((row) => normalizeLogicalTombstoneV2Local(row));
  const tombstonesByKey = new Map();
  for (const tombstone of logicalTombstones) {
    const key = logicalGroupKey(tombstone);
    requireValue(!tombstonesByKey.has(key));
    tombstonesByKey.set(key, tombstone);
  }
  return { deliveries, logicalTombstones, tombstonesByKey };
}

function capsuleDeliveryTombstones(pair, tombstonesByKey) {
  if (pair.checkpointCapsule === null) return [];
  const selectedByKey = new Map();
  for (const raw of pair.deliveries) {
    const entry = captureExactRecord(raw, CAPSULE_DELIVERY_FIELDS);
    requireValue(Number.isSafeInteger(entry.sourceRefIndex) && entry.sourceRefIndex >= 0 &&
      entry.sourceRefIndex < pair.sourceReferences.length);
    const source = captureExactRecord(pair.sourceReferences[entry.sourceRefIndex], SOURCE_REFERENCE_FIELDS);
    const tombstone = normalizeLogicalTombstoneV2Local(makeRecord([
      ['kind', entry.kind], ['sourceExecutionId', entry.sourceExecutionId],
      ['logicalMessageId', entry.logicalMessageId], ['revision', entry.revision], ['targetLaunchKey', null],
      ['sourceLaunchKey', source.launchKey], ['payloadDigest', entry.payloadDigest],
    ]));
    const key = logicalGroupKey(tombstone);
    if (!selectedByKey.has(key)) {
      const fullTombstone = tombstonesByKey.get(key);
      requireValue(fullTombstone !== undefined);
      selectedByKey.set(key, fullTombstone);
    }
  }
  return [...selectedByKey.values()];
}

function appendUnique(index, key, value) {
  requireValue(typeof key === 'string' && !index.has(key));
  index.set(key, value);
}

function orderedValues(order, index) {
  const seen = new Set();
  requireValue(order.length === index.size);
  const result = [];
  for (const id of order) {
    assertIdentifier(id, INVALID_WHOLE);
    requireValue(!seen.has(id) && index.has(id));
    seen.add(id);
    result.push(index.get(id));
  }
  requireValue(seen.size === index.size);
  return result;
}

function sameSemanticValue(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftIsArray = Array.isArray(left);
  if (leftIsArray !== Array.isArray(right)) return false;
  if (leftIsArray) {
    if (left.length !== right.length) return false;
    for (let index = 0; index < left.length; index += 1) {
      if (!sameSemanticValue(left[index], right[index])) return false;
    }
    return true;
  }
  const leftKeys = Reflect.ownKeys(left);
  const rightKeys = Reflect.ownKeys(right);
  if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => typeof key !== 'string')) return false;
  leftKeys.sort();
  rightKeys.sort();
  for (let index = 0; index < leftKeys.length; index += 1) {
    const key = leftKeys[index];
    if (key !== rightKeys[index] || !sameSemanticValue(left[key], right[key])) return false;
  }
  return true;
}

function validateWholeCapacity(snapshot, normalByteLimitsBySlot) {
  const { anchor, stores } = snapshot;
  requireValue(anchor.migration === null &&
    encodeQuestionReclamationAnchorV1Local(anchor).sizeBytes <= NORMAL_ANCHOR_MAX_BYTES);
  const activePeriods = stores.questions === null ? [] : stores.questions.reservations.map((reservation) => ({
    identity: reservation.identity,
    periodId: reservation.periodId,
  }));
  const anchorReservation = measurePendingQuestionPeriodCapacity(anchor, activePeriods);
  requireValue(anchorReservation.fits && anchorReservation.projectedBytes !== null &&
    anchorReservation.projectedBytes <= NORMAL_ANCHOR_MAX_BYTES);

  for (const slot of LIMIT_FIELDS) {
    const store = stores[slot];
    const normalByteLimit = normalByteLimitsBySlot[slot];
    if (store === null) {
      requireValue(normalByteLimit === null);
      continue;
    }
    requireValue(Number.isSafeInteger(normalByteLimit) && normalByteLimit > 0 &&
      normalByteLimit <= MAX_SOURCE_BYTES);
    const grantBytes = store.migrationAllowance?.maxExtraBytes ?? 0;
    requireValue(Number.isSafeInteger(grantBytes) && grantBytes >= 0 && grantBytes <= FIXED_H_BOUNDS[slot]);
    const writableLimit = checkedCapacityAdd(normalByteLimit, grantBytes);
    const encodedBytes = CAPACITY_ENCODERS[slot](store).sizeBytes;
    const reservation = CAPACITY_MEASURERS[slot]({ snapshot: store, currentByteLimit: normalByteLimit });
    requireValue(Math.max(encodedBytes, reservation.reservedBytes) <= writableLimit);
  }
}

function validateInternal(value) {
  const input = captureExactRecord(value, TOP_LEVEL_FIELDS);
  requireValue(input.formatVersion === 1);
  const anchorInput = prepareAnchor(input.anchor);
  const ordinary = captureExactRecord(input.ordinaryStores, STORE_FIELDS);
  const question = prepareQuestionStore(ordinary.questions);
  const checkpoint = prepareCheckpointStore(ordinary.checkpoint);
  const instruction = prepareInstructionStore(ordinary.instructions);
  const rawCapsulePairs = captureDenseArray(input.capsulePairs, MAX_CAPSULE_PAIRS);
  const deliveryAttemptOrder = captureDenseArray(input.deliveryAttemptOrder, MAX_DELIVERIES);
  const questionReservationOrder = captureDenseArray(input.questionReservationOrder, MAX_QUESTION_RESERVATIONS);
  const normalByteLimitsBySlot = captureExactRecord(input.normalByteLimitsBySlot, LIMIT_FIELDS);
  preflightRow(normalByteLimitsBySlot, LIMIT_FIELDS.length);
  for (const id of deliveryAttemptOrder) assertIdentifier(id, INVALID_WHOLE);
  for (const id of questionReservationOrder) assertIdentifier(id, INVALID_WHOLE);

  const ordinaryQuestionReservations = question?.reservations.length ?? 0;
  const ordinaryDeliveries = checkpoint?.deliveries.length ?? 0;
  const capsulePairs = [];
  let capsuleQuestionReservations = 0;
  let capsuleDeliveries = 0;
  let checkpointCapsules = 0;
  for (const rawPair of rawCapsulePairs) {
    const pair = prepareCapsulePairShallow(rawPair);
    capsuleQuestionReservations = checkedTotal(capsuleQuestionReservations, pair.reservations.length,
      MAX_QUESTION_RESERVATIONS);
    capsuleDeliveries = checkedTotal(capsuleDeliveries, pair.deliveries.length, MAX_DELIVERIES);
    checkedTotal(ordinaryQuestionReservations, capsuleQuestionReservations, MAX_QUESTION_RESERVATIONS);
    checkedTotal(ordinaryDeliveries, capsuleDeliveries, MAX_DELIVERIES);
    if (pair.checkpointCapsule !== null) checkpointCapsules += 1;
    capsulePairs.push(pair);
  }
  const questionReservations = checkedTotal(ordinaryQuestionReservations, capsuleQuestionReservations,
    MAX_QUESTION_RESERVATIONS);
  const deliveries = checkedTotal(ordinaryDeliveries, capsuleDeliveries, MAX_DELIVERIES);

  requireValue(questionReservationOrder.length === questionReservations && deliveryAttemptOrder.length === deliveries);
  if (capsulePairs.length > 0) requireValue(question !== null);
  if (checkpointCapsules > 0) requireValue(checkpoint !== null);
  if (capsuleQuestionReservations > 0) requireValue(question.store.migrationAllowance === null);
  if (checkpointCapsules > 0) requireValue(checkpoint.store.migrationAllowance === null);

  preflightOrdinaryStores(question, checkpoint, instruction);
  preflightCapsulePairs(capsulePairs);

  const anchor = anchorInput.normalized;
  const normalizedQuestion = normalizeOrdinaryQuestionStore(question);
  const normalizedCheckpointRecords = normalizeOrdinaryCheckpointRecords(checkpoint);
  let normalizedInstructions = null;
  if (instruction !== null) {
    normalizedInstructions = normalizeInstructionJournalV2Local(makeRecord([
      ['schemaVersion', instruction.store.schemaVersion], ['revision', instruction.store.revision],
      ['storeId', instruction.store.storeId], ['migrationAllowance', instruction.store.migrationAllowance],
      ['instructions', instruction.instructions],
    ]));
  }

  const reservationsById = new Map();
  for (const reservation of normalizedQuestion?.reservations ?? []) {
    appendUnique(reservationsById, reservation.internalQuestionId, reservation);
  }
  const deliveriesByAttempt = new Map();
  for (const delivery of normalizedCheckpointRecords?.deliveries ?? []) {
    appendUnique(deliveriesByAttempt, delivery.deliveryAttemptId, delivery);
  }
  const fullTombstonesByKey = normalizedCheckpointRecords?.tombstonesByKey ?? new Map();

  for (const pair of capsulePairs) {
    const selectedLogicalTombstones = capsuleDeliveryTombstones(pair, fullTombstonesByKey);
    const normalizedPair = validateQuestionRejectionCapsulePair({
      questionCapsule: pair.questionCapsule,
      checkpointCapsule: pair.checkpointCapsule,
      selectedLogicalTombstones,
    });
    requireValue(normalizedPair.questionCapsule.storeId === anchor.storeId);
    requireValue(anchorInput.retiredScopes.has(identityPeriodKey(
      normalizedPair.questionCapsule.identity, normalizedPair.questionCapsule.periodId)));
    if (question !== null) requireValue(question.store.storeId === normalizedPair.questionCapsule.storeId);
    if (normalizedPair.checkpointCapsule !== null) {
      requireValue(checkpoint !== null && checkpoint.store.storeId === normalizedPair.checkpointCapsule.storeId);
      requireValue(anchorInput.retiredScopes.has(identityPeriodKey(
        normalizedPair.checkpointCapsule.identity, normalizedPair.checkpointCapsule.periodId)));
    }
    for (const reservation of normalizedPair.reservations) {
      appendUnique(reservationsById, reservation.internalQuestionId, reservation);
    }
    for (const delivery of normalizedPair.deliveries) {
      appendUnique(deliveriesByAttempt, delivery.deliveryAttemptId, delivery);
    }
  }

  const orderedReservations = orderedValues(questionReservationOrder, reservationsById);
  const orderedDeliveries = orderedValues(deliveryAttemptOrder, deliveriesByAttempt);
  let reconstructedQuestion = null;
  if (normalizedQuestion !== null) {
    reconstructedQuestion = makeRecord([
      ['schemaVersion', normalizedQuestion.schemaVersion], ['storeId', normalizedQuestion.storeId],
      ['revision', normalizedQuestion.revision], ['questions', normalizedQuestion.questions],
      ['reservations', orderedReservations], ['migrationAllowance', normalizedQuestion.migrationAllowance],
    ]);
  }
  let reconstructedCheckpoint = null;
  if (checkpoint !== null) {
    reconstructedCheckpoint = makeRecord([
      ['schemaVersion', checkpoint.store.schemaVersion], ['storeId', checkpoint.store.storeId],
      ['revision', checkpoint.store.revision],
      ['registrations', makeRecord(REGISTRATION_FIELDS.map((field) =>
        [field, checkpoint.registrationArrays[field]]))],
      ['ledger', makeRecord([
        ['schemaVersion', checkpoint.ledger.schemaVersion], ['revision', checkpoint.ledger.revision],
        ['deliveries', orderedDeliveries], ['notificationTargets', checkpoint.notificationTargets],
        ['logicalTombstones', normalizedCheckpointRecords.logicalTombstones],
      ])],
      ['migrationAllowance', checkpoint.store.migrationAllowance],
    ]);
  }
  const reconstructedStores = makeRecord([
    ['questions', reconstructedQuestion], ['checkpoint', reconstructedCheckpoint],
    ['instructions', normalizedInstructions],
  ]);
  const rawSnapshot = makeRecord([['anchor', anchor], ['stores', reconstructedStores]]);

  const snapshotResult = validateReclamationSnapshot(rawSnapshot);
  requireValue(snapshotResult.status === 'ready' && snapshotResult.reasons.length === 0 &&
    sameSemanticValue(rawSnapshot, snapshotResult.snapshot));
  const storeWriteResult = validateReclamationStoreWrite({
    anchor,
    previousStores: reconstructedStores,
    nextStores: reconstructedStores,
    normalByteLimitsBySlot,
  });
  requireValue(storeWriteResult.status === 'checked' && storeWriteResult.reasons.length === 0 &&
    sameSemanticValue(rawSnapshot, storeWriteResult.snapshot));
  validateWholeCapacity(snapshotResult.snapshot, normalByteLimitsBySlot);

  return {
    snapshot: snapshotResult.snapshot,
    counts: {
      capsulePairs: capsulePairs.length,
      checkpointCapsules,
      ordinaryQuestionReservations,
      capsuleQuestionReservations,
      questionReservations,
      ordinaryDeliveries,
      capsuleDeliveries,
      deliveries,
    },
    scopeLimitations: SCOPE_LIMITATIONS,
  };
}

/** capsuleを旧全体snapshotへ復元し、既存の全体整合条件で検査する。 */
function validateQuestionCapsuleWholeRepresentation(value) {
  try {
    return validateInternal(value);
  } catch {
    throw new TypeError(INVALID_WHOLE);
  }
}

module.exports = { validateQuestionCapsuleWholeRepresentation };
