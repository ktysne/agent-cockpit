'use strict';

const { createHash } = require('node:crypto');
const {
  assertIdentifier,
  assertSafeUnsignedInteger,
  assertUuidV4,
  captureExactRecord,
} = require('./reclamation-codec-primitives');
const {
  normalizeQuestionJournalV2Local,
} = require('./common-question-reclamation-codec');
const {
  normalizeCheckpointV3Local,
  normalizeDeliveryRecordV2Local,
} = require('./delivery-reclamation-codec');
const {
  validateReclamationStoreWrite,
} = require('./reclamation-store-consistency');

const RETENTION_MS = 604_800_000;
const STORE_FIELDS = ['questions', 'checkpoint', 'instructions'];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const RESERVATION_FIELDS = [
  'internalQuestionId', 'identity', 'periodId', 'questionId', 'contentDigest', 'executionId',
  'conversationId', 'launchRef', 'executionBinding', 'createdAt', 'revision', 'selectionSource',
  'selectedAt', 'deliveryIntent', 'deliveryCreationState', 'checkpointState', 'sourceClaimsDigest',
  'sessionId', 'externalResolution', 'cancelledAt', 'terminalResultKind', 'quarantinedAt',
  'bodyState', 'reclaimedAt', 'reclamation',
];
const TERMINAL_STATES = new Set(['applied', 'cancelled_before_send', 'superseded_before_send']);
const ALLOWED_CHECKPOINT_STATES = new Set(['available', 'unknown', ...TERMINAL_STATES]);
const INPUT_REQUIRED_FIELDS = [
  'anchor', 'stores', 'normalByteLimitsBySlot', 'internalQuestionId', 'now',
];
const ALLOWED_RECONCILIATION_REASONS = new Set([
  'instruction_creation_state', 'question_creation_state', 'question_checkpoint_cache',
]);
const INVALID_PLAN = 'invalid_question_body_reclamation';

function fail() {
  const error = new TypeError(INVALID_PLAN);
  error.code = INVALID_PLAN;
  throw error;
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

function makeArray(values) {
  const result = new Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    Object.defineProperty(result, String(index), {
      value: values[index],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function capturePlannerInput(value) {
  let keys;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    keys = Reflect.ownKeys(value);
  } catch {
    fail();
  }
  const hasOperationId = keys.includes('operationId');
  const fields = hasOperationId ? [...INPUT_REQUIRED_FIELDS, 'operationId'] : INPUT_REQUIRED_FIELDS;
  return captureExactRecord(value, fields, INVALID_PLAN);
}

function captureLimits(value, stores) {
  const limits = captureExactRecord(value, STORE_FIELDS, INVALID_PLAN);
  for (const slot of STORE_FIELDS) {
    if (stores[slot] === null) {
      if (limits[slot] !== null) fail();
    } else if (!Number.isSafeInteger(limits[slot]) || limits[slot] < 1 || limits[slot] > 16_777_216) {
      fail();
    }
  }
  return limits;
}

function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function nextRevision(value) {
  assertSafeUnsignedInteger(value, INVALID_PLAN);
  if (value >= Number.MAX_SAFE_INTEGER) fail();
  return value + 1;
}

function checkedDeadline(value) {
  assertSafeUnsignedInteger(value, INVALID_PLAN);
  return value > Number.MAX_SAFE_INTEGER - RETENTION_MS ? null : value + RETENTION_MS;
}

function identityPeriodMatches(reservation, retiredPeriod) {
  return reservation.periodId === retiredPeriod.periodId &&
    sameIdentity(reservation.identity, retiredPeriod.identity);
}

function reservationAndDetail(snapshot, internalQuestionId) {
  const journal = snapshot.stores.questions;
  if (journal === null) fail();
  let reservation = null;
  let detail = null;
  for (const item of journal.reservations) {
    if (item.internalQuestionId === internalQuestionId) reservation = item;
  }
  for (const item of journal.questions) {
    if (item.internalQuestionId === internalQuestionId) detail = item;
  }
  if (reservation === null) fail();
  return { journal, reservation, detail };
}

function retiredPeriodFor(anchor, reservation) {
  for (const period of anchor.retiredQuestionPeriods) {
    if (identityPeriodMatches(reservation, period)) return period;
  }
  fail();
}

function deliveryForReservation(snapshot, reservation) {
  if (reservation.deliveryIntent === null) return null;
  const checkpoint = snapshot.stores.checkpoint;
  if (checkpoint === null) return null;
  for (const delivery of checkpoint.ledger.deliveries) {
    if (delivery.deliveryAttemptId === reservation.deliveryIntent.deliveryAttemptId) return delivery;
  }
  return null;
}

function compactSafeJson(value) {
  const normalized = safeJsonProjection(value);
  const text = JSON.stringify(normalized);
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function safeJsonProjection(value) {
  if (Array.isArray(value)) {
    const result = new Array(value.length);
    Object.defineProperty(result, 'toJSON', {
      value: null,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    for (let index = 0; index < value.length; index += 1) {
      result[index] = safeJsonProjection(value[index]);
    }
    return result;
  }
  if (value !== null && typeof value === 'object') {
    const result = Object.create(null);
    for (const key of Object.keys(value)) {
      Object.defineProperty(result, key, {
        value: safeJsonProjection(value[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  return value;
}

function deliveryGraveFromDetail(delivery, operationId, reclaimedAt) {
  if (delivery.recordType !== 'detail' || delivery.kind !== 'question') fail();
  const source = delivery.source;
  const target = delivery.target;
  if (target.kind !== 'execution') fail();
  const grave = makeRecord([
    ['recordType', 'reclaimed'],
    ['deliveryAttemptId', delivery.deliveryAttemptId],
    ['kind', delivery.kind],
    ['logicalMessageId', delivery.logicalMessageId],
    ['revision', delivery.revision],
    ['sourceExecutionId', delivery.sourceExecutionId],
    ['payloadDigest', delivery.payloadDigest],
    ['state', delivery.state],
    ['terminalAt', delivery.terminalAt],
    ['cancelRequested', delivery.cancelRequested],
    ['ownerGeneration', delivery.ownerGeneration],
    ['acceptedCorrelation', delivery.acceptedCorrelation],
    ['appliedCorrelation', delivery.appliedCorrelation],
    ['sourceRef', makeRecord([
      ['launchRef', source.launchRef],
      ['launchKey', makeArray([source.claims.launchId, source.claims.runId, source.claims.attemptId])],
      ['sourceClaimsDigest', compactSafeJson(source.claims)],
      ['identity', source.identity],
      ['executionBinding', source.executionBinding],
      ['conversationId', source.conversationId],
      ['sessionId', source.sessionId],
    ])],
    ['targetRef', makeRecord([
      ['kind', target.kind],
      ['launchRef', target.launchRef],
      ['launchKey', makeArray([target.claims.launchId, target.claims.runId, target.claims.attemptId])],
      ['targetClaimsDigest', compactSafeJson(target.claims)],
      ['identity', target.identity],
      ['periodId', target.periodId],
      ['actor', target.actor],
      ['conversationId', target.conversationId],
      ['sessionId', target.sessionId],
    ])],
    ['reclamation', makeRecord([
      ['operationId', operationId],
      ['reclaimedAt', reclaimedAt],
      ['reason', 'retired_question_period'],
    ])],
  ]);
  return normalizeDeliveryRecordV2Local(grave);
}

function questionPreparation(operationId, preparedAt, deliveryPresence, checkpointState) {
  return makeRecord([
    ['operationId', operationId],
    ['preparedAt', preparedAt],
    ['deliveryPresence', deliveryPresence],
    ['checkpointState', checkpointState],
  ]);
}

function buildQuestionJournal(journal, reservations) {
  return normalizeQuestionJournalV2Local(makeRecord([
    ['schemaVersion', journal.schemaVersion],
    ['storeId', journal.storeId],
    ['revision', nextRevision(journal.revision)],
    ['questions', journal.questions],
    ['reservations', makeArray(reservations)],
    ['migrationAllowance', journal.migrationAllowance],
  ]));
}

function buildCheckpoint(checkpoint, deliveryId, grave) {
  const deliveries = [];
  let replaced = false;
  for (const delivery of checkpoint.ledger.deliveries) {
    if (delivery.deliveryAttemptId === deliveryId) {
      if (replaced) fail();
      deliveries.push(grave);
      replaced = true;
    } else {
      deliveries.push(delivery);
    }
  }
  if (!replaced) fail();
  const ledger = makeRecord([
    ['schemaVersion', checkpoint.ledger.schemaVersion],
    ['revision', nextRevision(checkpoint.ledger.revision)],
    ['deliveries', makeArray(deliveries)],
    ['notificationTargets', checkpoint.ledger.notificationTargets],
    ['logicalTombstones', checkpoint.ledger.logicalTombstones],
  ]);
  return normalizeCheckpointV3Local(makeRecord([
    ['schemaVersion', checkpoint.schemaVersion],
    ['storeId', checkpoint.storeId],
    ['revision', nextRevision(checkpoint.revision)],
    ['registrations', checkpoint.registrations],
    ['ledger', ledger],
    ['migrationAllowance', checkpoint.migrationAllowance],
  ]));
}

function replaceStore(stores, slot, value) {
  return makeRecord(STORE_FIELDS.map((field) => [field, field === slot ? value : stores[field]]));
}

function makeSnapshot(anchor, stores) {
  return makeRecord([['anchor', anchor], ['stores', stores]]);
}

function validateBoundary(previousSnapshot, nextStores, limits) {
  const transition = validateReclamationStoreWrite({
    anchor: previousSnapshot.anchor,
    previousStores: previousSnapshot.stores,
    nextStores,
    normalByteLimitsBySlot: limits,
  });
  if (transition.reasons.some((reason) => !ALLOWED_RECONCILIATION_REASONS.has(reason))) fail();
  return transition.snapshot.stores;
}

function result(status, snapshot, deadlineAt, deferredReason, operationId = null, steps = []) {
  return makeRecord([
    ['status', status],
    ['operationId', operationId],
    ['deadlineAt', deadlineAt],
    ['deferredReason', deferredReason],
    ['snapshot', snapshot],
    ['steps', makeArray(steps)],
  ]);
}

function defer(snapshot, deadlineAt, deferredReason, operationId = null) {
  return result('deferred', snapshot, deadlineAt, deferredReason, operationId);
}

function prepareQuestionStep(snapshot, limits, row, operationId, preparedAt, deliveryPresence, checkpointState) {
  const reservations = row.journal.reservations.map((reservation) => reservation.internalQuestionId === row.reservation.internalQuestionId
    ? makeRecord(RESERVATION_FIELDS.map((field) => [field,
      field === 'reclamation'
        ? questionPreparation(operationId, preparedAt, deliveryPresence, checkpointState)
        : reservation[field]]))
    : reservation);
  const questions = buildQuestionJournal(row.journal, reservations);
  const stores = replaceStore(snapshot.stores, 'questions', questions);
  return {
    boundary: 'prepare',
    slot: 'questions',
    snapshot: makeSnapshot(snapshot.anchor, validateBoundary(snapshot, stores, limits)),
  };
}

function graveQuestionStep(snapshot, limits, delivery, operationId, reclaimedAt) {
  const checkpoint = snapshot.stores.checkpoint;
  if (checkpoint === null) fail();
  const grave = deliveryGraveFromDetail(delivery, operationId, reclaimedAt);
  const nextCheckpoint = buildCheckpoint(checkpoint, delivery.deliveryAttemptId, grave);
  const stores = replaceStore(snapshot.stores, 'checkpoint', nextCheckpoint);
  return {
    boundary: 'checkpoint-grave',
    slot: 'checkpoint',
    snapshot: makeSnapshot(snapshot.anchor, validateBoundary(snapshot, stores, limits)),
  };
}

function reclaimQuestionStep(snapshot, limits, row, reclaimedAt) {
  const reservations = row.journal.reservations.map((reservation) => reservation.internalQuestionId === row.reservation.internalQuestionId
    ? makeRecord(RESERVATION_FIELDS.map((field) => [field,
      field === 'bodyState' ? 'reclaimed'
        : field === 'reclaimedAt' ? reclaimedAt
          : reservation[field]]))
    : reservation);
  const questions = row.journal.questions.filter((detail) =>
    detail.internalQuestionId !== row.reservation.internalQuestionId);
  const nextQuestionJournal = normalizeQuestionJournalV2Local(makeRecord([
    ['schemaVersion', row.journal.schemaVersion],
    ['storeId', row.journal.storeId],
    ['revision', nextRevision(row.journal.revision)],
    ['questions', makeArray(questions)],
    ['reservations', makeArray(reservations)],
    ['migrationAllowance', row.journal.migrationAllowance],
  ]));
  const stores = replaceStore(snapshot.stores, 'questions', nextQuestionJournal);
  return {
    boundary: 'reclaim',
    slot: 'questions',
    snapshot: makeSnapshot(snapshot.anchor, validateBoundary(snapshot, stores, limits)),
  };
}

function validatePresence(reservation, detail, delivery) {
  if (reservation.bodyState !== 'retained' && reservation.bodyState !== 'reclaimed') fail();
  if (reservation.bodyState === 'retained' && detail === null) fail();
  if (reservation.bodyState === 'reclaimed' && detail !== null) fail();
  if (reservation.deliveryCreationState === 'not_created') {
    if (reservation.checkpointState !== null || delivery !== null) fail();
    return { deliveryPresence: 'none', checkpointState: null };
  }
  if (reservation.deliveryCreationState === 'indeterminate') {
    if (reservation.deliveryIntent === null || reservation.checkpointState !== 'unknown' || delivery !== null) fail();
    return { deliveryPresence: 'indeterminate', checkpointState: 'unknown' };
  }
  if (reservation.deliveryCreationState !== 'checkpointed' || reservation.deliveryIntent === null || delivery === null) fail();
  if (!ALLOWED_CHECKPOINT_STATES.has(delivery.state) || reservation.checkpointState !== delivery.state) fail();
  return { deliveryPresence: 'checkpoint', checkpointState: delivery.state };
}

/** 退役済み質問の本文回収に必要な局所snapshot群を、保存せずに計画する。 */
function planQuestionBodyReclamation(value) {
  const input = capturePlannerInput(value);
  assertIdentifier(input.internalQuestionId, INVALID_PLAN);
  assertSafeUnsignedInteger(input.now, INVALID_PLAN);
  if (Object.hasOwn(input, 'operationId') && input.operationId !== null) {
    assertUuidV4(input.operationId, INVALID_PLAN);
  }

  const rawStores = captureExactRecord(input.stores, STORE_FIELDS, INVALID_PLAN);
  const limits = captureLimits(input.normalByteLimitsBySlot, rawStores);
  const initial = validateReclamationStoreWrite({
    anchor: input.anchor,
    previousStores: rawStores,
    nextStores: rawStores,
    normalByteLimitsBySlot: limits,
  });
  if (initial.reasons.some((reason) => !ALLOWED_RECONCILIATION_REASONS.has(reason))) fail();
  const snapshot = initial.snapshot;
  const row = reservationAndDetail(snapshot, input.internalQuestionId);
  const retired = retiredPeriodFor(snapshot.anchor, row.reservation);
  if (row.reservation.quarantinedAt === null || row.reservation.quarantinedAt !== retired.retiredAt) fail();
  const delivery = deliveryForReservation(snapshot, row.reservation);
  const presence = validatePresence(row.reservation, row.detail, delivery);
  const preparation = row.reservation.reclamation;

  let deadlineAt = checkedDeadline(row.reservation.quarantinedAt);
  if (deadlineAt === null) {
    return defer(snapshot, null, 'retention_deadline_overflow', preparation?.operationId ?? null);
  }
  if (presence.deliveryPresence === 'checkpoint' && TERMINAL_STATES.has(delivery.state)) {
    const terminalDeadline = checkedDeadline(delivery.terminalAt);
    if (terminalDeadline === null) {
      return defer(snapshot, null, 'retention_deadline_overflow', preparation?.operationId ?? null);
    }
    deadlineAt = Math.max(deadlineAt, terminalDeadline);
  }
  if (input.now < row.reservation.quarantinedAt ||
      (presence.deliveryPresence === 'checkpoint' && TERMINAL_STATES.has(delivery.state) && input.now < delivery.terminalAt)) {
    return defer(snapshot, deadlineAt, 'clock_before_retention_origin', preparation?.operationId ?? null);
  }

  if (preparation !== null) {
    if (Object.hasOwn(input, 'operationId') && input.operationId !== null &&
        input.operationId !== preparation.operationId) fail();
    if (input.now < preparation.preparedAt) {
      return defer(snapshot, deadlineAt, 'clock_before_prepared_at', preparation.operationId);
    }
    if (row.reservation.bodyState === 'reclaimed') {
      return result('complete', snapshot, deadlineAt, null, preparation.operationId);
    }
    if (preparation.deliveryPresence !== presence.deliveryPresence ||
        preparation.checkpointState !== presence.checkpointState) fail();
  } else {
    if (row.reservation.bodyState !== 'retained') fail();
    if (input.now < deadlineAt) return defer(snapshot, deadlineAt, 'retention_not_elapsed');
    if (!Object.hasOwn(input, 'operationId') || input.operationId === null) {
      return result('eligible', snapshot, deadlineAt, null);
    }
  }

  const operationId = preparation === null ? input.operationId : preparation.operationId;
  if (operationId === null) return result('eligible', snapshot, deadlineAt, null);
  const steps = [];
  let current = snapshot;
  let currentRow = row;
  let currentDelivery = delivery;
  if (preparation === null) {
    const prepared = prepareQuestionStep(current, limits, currentRow, operationId, input.now,
      presence.deliveryPresence, presence.checkpointState);
    steps.push(prepared);
    current = prepared.snapshot;
    currentRow = reservationAndDetail(current, input.internalQuestionId);
    currentDelivery = deliveryForReservation(current, currentRow.reservation);
  }

  if (presence.deliveryPresence === 'checkpoint' && currentDelivery?.recordType === 'detail') {
    const grave = graveQuestionStep(current, limits, currentDelivery, operationId, input.now);
    steps.push(grave);
    current = grave.snapshot;
    currentRow = reservationAndDetail(current, input.internalQuestionId);
    currentDelivery = deliveryForReservation(current, currentRow.reservation);
  }
  if (presence.deliveryPresence === 'checkpoint' &&
      (currentDelivery?.recordType !== 'reclaimed' ||
       currentDelivery.reclamation.operationId !== operationId ||
       currentDelivery.reclamation.reason !== 'retired_question_period')) fail();
  const reclaimed = reclaimQuestionStep(current, limits, currentRow, input.now);
  steps.push(reclaimed);

  return result('planned', snapshot, deadlineAt, null, operationId, steps);
}

module.exports = { planQuestionBodyReclamation };
