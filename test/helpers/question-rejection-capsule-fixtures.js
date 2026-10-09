'use strict';

const { encodeNormalized } = require('../../src/server/reclamation-json-codec');
const { createReclaimedQuestionPairFixture } = require('./reclaimed-question-pair-fixtures');

const COMPACTION_OPERATION_ID = '55555555-5555-4555-8555-555555555555';
const QUESTION_SHARED_FIELDS = new Set(['identity', 'periodId']);
const DELIVERY_SHARED_FIELDS = new Set(['sourceRef', 'targetRef']);

function withoutFields(record, omittedFields) {
  const result = {};
  for (const key of Object.keys(record)) {
    if (!omittedFields.has(key)) result[key] = record[key];
  }
  return result;
}

function makeQuestionCapsule(reservations, metadata) {
  const identity = metadata.identity ?? reservations[0]?.identity;
  const periodId = metadata.periodId ?? reservations[0]?.periodId;
  return {
    formatVersion: 1,
    compactionOperationId: metadata.compactionOperationId ?? COMPACTION_OPERATION_ID,
    storeId: metadata.storeId,
    identity: structuredClone(identity),
    periodId,
    reservations: reservations.map((record) => withoutFields(record, QUESTION_SHARED_FIELDS)),
  };
}

function makeDeliveryCapsule(deliveries, metadata) {
  const sources = [];
  const targets = [];
  const sourceIndexes = new Map();
  const targetIndexes = new Map();
  const intern = (reference, values, indexes) => {
    const signature = encodeNormalized(reference).bytes.toString('utf8');
    if (indexes.has(signature)) return indexes.get(signature);
    const index = values.length;
    indexes.set(signature, index);
    values.push(structuredClone(reference));
    return index;
  };
  const normalizedDeliveries = deliveries.map((delivery) => ({
    ...withoutFields(delivery, DELIVERY_SHARED_FIELDS),
    sourceRefIndex: intern(delivery.sourceRef, sources, sourceIndexes),
    targetRefIndex: intern(delivery.targetRef, targets, targetIndexes),
  }));

  return {
    formatVersion: 1,
    compactionOperationId: metadata.compactionOperationId ?? COMPACTION_OPERATION_ID,
    storeId: metadata.storeId,
    identity: structuredClone(metadata.identity ?? deliveries[0]?.targetRef.identity),
    periodId: metadata.periodId ?? deliveries[0]?.targetRef.periodId,
    references: { sources, targets },
    deliveries: normalizedDeliveries,
  };
}

function sameArray(left, right) {
  return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function matchesQuestionTombstone(tombstone, delivery) {
  return tombstone.kind === 'question' &&
    tombstone.sourceExecutionId === delivery.sourceExecutionId &&
    tombstone.logicalMessageId === delivery.logicalMessageId &&
    tombstone.revision === delivery.revision && tombstone.targetLaunchKey === null &&
    sameArray(tombstone.sourceLaunchKey, delivery.sourceRef.launchKey) &&
    tombstone.payloadDigest === delivery.payloadDigest;
}

function createQuestionRejectionCapsuleFixture(options = {}) {
  const fixture = createReclaimedQuestionPairFixture(options);
  const metadata = {
    storeId: fixture.snapshot.stores.questions.storeId,
    identity: fixture.reservation.identity,
    periodId: fixture.reservation.periodId,
    compactionOperationId: COMPACTION_OPERATION_ID,
  };
  const questionCapsule = makeQuestionCapsule([fixture.reservation], metadata);
  const checkpointCapsule = fixture.delivery === null ? null : makeDeliveryCapsule([fixture.delivery], metadata);
  const selectedLogicalTombstones = fixture.delivery === null ? [] :
    fixture.snapshot.stores.checkpoint.ledger.logicalTombstones.filter((tombstone) =>
      matchesQuestionTombstone(tombstone, fixture.delivery));
  if (fixture.delivery !== null && selectedLogicalTombstones.length !== 1) {
    throw new TypeError('question_rejection_capsule_fixture_failed');
  }

  return {
    questionCapsule,
    checkpointCapsule,
    selectedLogicalTombstones: structuredClone(selectedLogicalTombstones),
    reservation: fixture.reservation,
    delivery: fixture.delivery,
    snapshot: fixture.snapshot,
  };
}

module.exports = {
  createQuestionRejectionCapsuleFixture,
  makeDeliveryCapsule,
  makeQuestionCapsule,
};
