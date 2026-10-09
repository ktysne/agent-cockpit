'use strict';

const { encodeNormalized } = require('../../src/server/reclamation-json-codec');
const { createReclaimedQuestionPairFixture } = require('./reclaimed-question-pair-fixtures');

const COMPACTION_OPERATION_ID = '55555555-5555-4555-8555-555555555555';

function clone(value) {
  return structuredClone(value);
}

function makeMetadata(reservation, snapshot) {
  return {
    storeId: snapshot.stores.questions.storeId,
    compactionOperationId: COMPACTION_OPERATION_ID,
    identity: clone(reservation.identity),
    periodId: reservation.periodId,
  };
}

function makeQuestionCapsule(reservations, metadata) {
  return {
    formatVersion: 1,
    compactionOperationId: metadata.compactionOperationId,
    storeId: metadata.storeId,
    identity: clone(metadata.identity),
    periodId: metadata.periodId,
    reservations: reservations.map((reservation) => {
      const entry = clone(reservation);
      delete entry.identity;
      delete entry.periodId;
      return entry;
    }),
  };
}

function refKey(ref) {
  return JSON.stringify(ref);
}

function makeDeliveryCapsule(deliveries, metadata) {
  if (deliveries.length === 0) return null;
  const sources = [];
  const targets = [];
  const sourceIndices = new Map();
  const targetIndices = new Map();
  const entries = deliveries.map((delivery) => {
    const sourceKey = refKey(delivery.sourceRef);
    const targetKey = refKey(delivery.targetRef);
    if (!sourceIndices.has(sourceKey)) {
      sourceIndices.set(sourceKey, sources.length);
      sources.push(clone(delivery.sourceRef));
    }
    if (!targetIndices.has(targetKey)) {
      targetIndices.set(targetKey, targets.length);
      targets.push(clone(delivery.targetRef));
    }
    const entry = clone(delivery);
    delete entry.sourceRef;
    delete entry.targetRef;
    entry.sourceRefIndex = sourceIndices.get(sourceKey);
    entry.targetRefIndex = targetIndices.get(targetKey);
    return entry;
  });
  return {
    formatVersion: 1,
    compactionOperationId: metadata.compactionOperationId,
    storeId: metadata.storeId,
    identity: clone(metadata.identity),
    periodId: metadata.periodId,
    references: { sources, targets },
    deliveries: entries,
  };
}

function tombstoneForDelivery(delivery) {
  return {
    kind: delivery.kind,
    sourceExecutionId: delivery.sourceExecutionId,
    logicalMessageId: delivery.logicalMessageId,
    revision: delivery.revision,
    targetLaunchKey: null,
    sourceLaunchKey: clone(delivery.sourceRef.launchKey),
    payloadDigest: delivery.payloadDigest,
  };
}

function groupKey(tombstone) {
  return encodeNormalized([
    tombstone.kind,
    tombstone.sourceExecutionId,
    tombstone.logicalMessageId,
    tombstone.revision,
    tombstone.targetLaunchKey,
  ]).bytes.toString('utf8');
}

function makePairInput(questionReservations, checkpointDeliveries, metadata, selectedLogicalTombstones) {
  const tombstones = selectedLogicalTombstones === undefined
    ? [...new Map(checkpointDeliveries.map((delivery) => {
      const tombstone = tombstoneForDelivery(delivery);
      return [groupKey(tombstone), tombstone];
    })).values()]
    : selectedLogicalTombstones.map(clone);
  tombstones.sort((left, right) => groupKey(left) < groupKey(right) ? -1 :
    groupKey(left) > groupKey(right) ? 1 : 0);
  return {
    questionCapsule: makeQuestionCapsule(questionReservations, metadata),
    checkpointCapsule: makeDeliveryCapsule(checkpointDeliveries, metadata),
    selectedLogicalTombstones: tombstones,
  };
}

function createQuestionRejectionCapsulePairFixture(options = {}) {
  const base = createReclaimedQuestionPairFixture(options);
  const metadata = makeMetadata(base.reservation, base.snapshot);
  const questionReservations = [clone(base.reservation)];
  const checkpointDeliveries = base.delivery === null ? [] : [clone(base.delivery)];
  return {
    input: makePairInput(questionReservations, checkpointDeliveries, metadata),
    metadata,
    questionReservations,
    checkpointDeliveries,
    snapshot: base.snapshot,
  };
}

function createMaximalQuestionRejectionCapsulePairFixture() {
  const base = createReclaimedQuestionPairFixture({ provider: 'claude', presence: 'checkpoint', state: 'applied' });
  const metadata = makeMetadata(base.reservation, base.snapshot);
  const questionReservations = [];
  const checkpointDeliveries = [];
  for (let index = 0; index < 256; index += 1) {
    const suffix = String(index).padStart(3, '0');
    const digest = index.toString(16).padStart(64, '0');
    const reservation = clone(base.reservation);
    const delivery = clone(base.delivery);
    const deliveryAttemptId = `delivery-${suffix}`;
    const logicalMessageId = `logical-${suffix}`;
    const launchRef = `launch-ref-${suffix}`;
    const launchKey = [`launch-${suffix}`, `run-${suffix}`, `attempt-${suffix}`];

    reservation.internalQuestionId = `question-${suffix}`;
    reservation.questionId = `question-id-${suffix}`;
    reservation.launchRef = launchRef;
    reservation.sourceClaimsDigest = digest;
    reservation.deliveryIntent.deliveryAttemptId = deliveryAttemptId;
    reservation.deliveryIntent.logicalMessageId = logicalMessageId;
    reservation.deliveryIntent.payloadDigest = digest;
    reservation.externalResolution = {
      resolvedAt: reservation.createdAt,
      evidenceDigest: digest,
    };

    delivery.deliveryAttemptId = deliveryAttemptId;
    delivery.logicalMessageId = logicalMessageId;
    delivery.payloadDigest = digest;
    delivery.sourceRef.launchRef = launchRef;
    delivery.sourceRef.launchKey = clone(launchKey);
    delivery.sourceRef.sourceClaimsDigest = digest;
    delivery.targetRef.launchRef = launchRef;
    delivery.targetRef.launchKey = clone(launchKey);
    delivery.targetRef.targetClaimsDigest = digest;
    delivery.acceptedCorrelation = clone(delivery.appliedCorrelation);
    for (const correlation of [delivery.acceptedCorrelation, delivery.appliedCorrelation]) {
      correlation.deliveryAttemptId = deliveryAttemptId;
      correlation.payloadDigest = digest;
      correlation.clientRequestId = deliveryAttemptId;
    }

    questionReservations.push(reservation);
    checkpointDeliveries.push(delivery);
  }
  return {
    input: makePairInput(questionReservations, checkpointDeliveries, metadata),
    metadata,
    questionReservations,
    checkpointDeliveries,
  };
}

module.exports = {
  createMaximalQuestionRejectionCapsulePairFixture,
  createQuestionRejectionCapsulePairFixture,
  makePairInput,
};
