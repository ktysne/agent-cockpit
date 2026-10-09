'use strict';

const {
  captureDenseArray,
  captureExactRecord,
} = require('./reclamation-codec-primitives');
const {
  expandQuestionDeliveryCapsule,
  expandQuestionRejectionCapsule,
  normalizeQuestionDeliveryCapsule,
  normalizeQuestionRejectionCapsule,
} = require('./question-rejection-capsule-codec');
const { normalizeLogicalTombstoneV2Local } = require('./delivery-reclamation-codec');
const { normalizeReclaimedQuestionPair } = require('./reclamation-store-consistency');
const { encodeNormalized } = require('./reclamation-json-codec');
const { assertPlainDataTree } = require('./reclamation-plain-data');

const INVALID_PAIR = 'invalid_question_rejection_capsule_pair';
const MAX_PAIR_ARRAY_LENGTH = 256;
const MAX_PAIR_VISITED_VALUES = 100_000;
const PAIR_FIELDS = ['questionCapsule', 'checkpointCapsule', 'selectedLogicalTombstones'];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const SCOPE_LIMITATIONS = Object.freeze([
  'anchor_retirement_not_verified',
  'global_identifier_uniqueness_not_verified',
  'checkpoint_context_subset_not_verified',
  'whole_logical_closure_not_verified',
  'aggregate_capacity_not_verified',
  'persistence_recovery_not_verified',
  'delivery_history_not_verified',
  'native_correlation_uniqueness_not_verified',
]);

function requirePair(condition) {
  if (!condition) throw new TypeError(INVALID_PAIR);
}

function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function canonicalJson(value) {
  return encodeNormalized(value).bytes.toString('utf8');
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

function validateSelectedLogicalTombstones(input, deliveries) {
  const expectedByKey = new Map();
  for (const delivery of deliveries) {
    const tombstone = normalizeLogicalTombstoneV2Local({
      kind: delivery.kind,
      sourceExecutionId: delivery.sourceExecutionId,
      logicalMessageId: delivery.logicalMessageId,
      revision: delivery.revision,
      targetLaunchKey: null,
      sourceLaunchKey: delivery.sourceRef.launchKey,
      payloadDigest: delivery.payloadDigest,
    });
    const key = logicalGroupKey(tombstone);
    const sourceLaunchKey = canonicalJson(tombstone.sourceLaunchKey);
    const prior = expectedByKey.get(key);
    requirePair(prior === undefined || prior.payloadDigest === tombstone.payloadDigest &&
      prior.sourceLaunchKey === sourceLaunchKey);
    if (prior === undefined) expectedByKey.set(key, {
      payloadDigest: tombstone.payloadDigest,
      sourceLaunchKey,
      nonSupersededCount: delivery.state === 'superseded_before_send' ? 0 : 1,
    });
    else if (delivery.state !== 'superseded_before_send') {
      prior.nonSupersededCount += 1;
      requirePair(prior.nonSupersededCount <= 1);
    }
  }

  const selectedLogicalTombstones = captureDenseArray(input, MAX_PAIR_ARRAY_LENGTH, INVALID_PAIR)
    .map((item) => normalizeLogicalTombstoneV2Local(item));
  const selectedByKey = new Map();
  for (const tombstone of selectedLogicalTombstones) {
    const key = logicalGroupKey(tombstone);
    requirePair(!selectedByKey.has(key));
    selectedByKey.set(key, tombstone);
  }
  requirePair(selectedByKey.size === expectedByKey.size);
  for (const [key, expected] of expectedByKey) {
    const tombstone = selectedByKey.get(key);
    requirePair(expected !== undefined &&
      tombstone !== undefined && expected.payloadDigest === tombstone.payloadDigest &&
      expected.sourceLaunchKey === canonicalJson(tombstone.sourceLaunchKey));
  }
  return selectedLogicalTombstones;
}

function normalizePairInput(value) {
  assertPlainDataTree(value, INVALID_PAIR, MAX_PAIR_ARRAY_LENGTH, MAX_PAIR_VISITED_VALUES);
  return captureExactRecord(value, PAIR_FIELDS, INVALID_PAIR);
}

function validateQuestionRejectionCapsulePairInternal(value) {
  const input = normalizePairInput(value);
  const questionCapsule = normalizeQuestionRejectionCapsule(input.questionCapsule);
  const checkpointCapsule = input.checkpointCapsule === null
    ? null
    : normalizeQuestionDeliveryCapsule(input.checkpointCapsule);
  const questionReservations = expandQuestionRejectionCapsule(questionCapsule);
  const checkpointDeliveries = checkpointCapsule === null
    ? []
    : expandQuestionDeliveryCapsule(checkpointCapsule);

  if (checkpointCapsule !== null) {
    requirePair(questionCapsule.storeId === checkpointCapsule.storeId &&
      questionCapsule.compactionOperationId === checkpointCapsule.compactionOperationId &&
      questionCapsule.periodId === checkpointCapsule.periodId &&
      sameIdentity(questionCapsule.identity, checkpointCapsule.identity));
  }

  for (const reservation of questionReservations) {
    requirePair(sameIdentity(reservation.identity, questionCapsule.identity) &&
      reservation.periodId === questionCapsule.periodId);
  }
  for (const delivery of checkpointDeliveries) {
    requirePair(delivery.recordType === 'reclaimed' && delivery.kind === 'question' &&
      sameIdentity(delivery.sourceRef.identity, checkpointCapsule.identity) &&
      sameIdentity(delivery.targetRef.identity, checkpointCapsule.identity) &&
      delivery.sourceRef.executionBinding.periodId === checkpointCapsule.periodId &&
      delivery.targetRef.periodId === checkpointCapsule.periodId);
  }

  const deliveriesByAttempt = new Map();
  for (const delivery of checkpointDeliveries) {
    requirePair(!deliveriesByAttempt.has(delivery.deliveryAttemptId));
    deliveriesByAttempt.set(delivery.deliveryAttemptId, delivery);
  }
  const usedAttempts = new Set();
  const reservations = [];
  const deliveriesByNormalizedAttempt = new Map();
  for (const reservation of questionReservations) {
    const presence = reservation.reclamation.deliveryPresence;
    let delivery = null;
    if (presence === 'checkpoint') {
      requirePair(reservation.deliveryIntent !== null);
      delivery = deliveriesByAttempt.get(reservation.deliveryIntent.deliveryAttemptId) ?? null;
      requirePair(delivery !== null && !usedAttempts.has(delivery.deliveryAttemptId));
      usedAttempts.add(delivery.deliveryAttemptId);
    }
    const normalizedPair = normalizeReclaimedQuestionPair({ reservation, delivery });
    reservations.push(normalizedPair.reservation);
    if (normalizedPair.delivery !== null) {
      deliveriesByNormalizedAttempt.set(normalizedPair.delivery.deliveryAttemptId, normalizedPair.delivery);
    }
  }
  requirePair(usedAttempts.size === checkpointDeliveries.length);
  const deliveries = checkpointDeliveries.map((delivery) =>
    deliveriesByNormalizedAttempt.get(delivery.deliveryAttemptId));
  requirePair(deliveries.every((delivery) => delivery !== undefined));

  const selectedLogicalTombstones = validateSelectedLogicalTombstones(input.selectedLogicalTombstones, deliveries);
  return {
    questionCapsule,
    checkpointCapsule,
    reservations,
    deliveries,
    selectedLogicalTombstones,
    scopeLimitations: SCOPE_LIMITATIONS,
  };
}

/** standalone Q/CP capsuleと選択logical contextの局所整合を検査する。 */
function validateQuestionRejectionCapsulePair(value) {
  try {
    return validateQuestionRejectionCapsulePairInternal(value);
  } catch (error) {
    if (error instanceof RangeError &&
        ['question_capsule_too_large', 'question_delivery_capsule_too_large'].includes(error.message)) {
      throw error;
    }
    throw new TypeError(INVALID_PAIR);
  }
}

module.exports = { validateQuestionRejectionCapsulePair };
