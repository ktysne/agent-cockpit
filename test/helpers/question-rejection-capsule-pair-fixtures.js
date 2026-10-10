'use strict';

const { createReclaimedQuestionPairFixture } = require('./reclaimed-question-pair-fixtures');
const { encodeNormalized } = require('../../src/server/reclamation-json-codec');
const {
  makeDeliveryCapsule,
  makeQuestionCapsule,
} = require('./question-rejection-capsule-fixtures');

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

function tombstoneKey(tombstone) {
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
      return [tombstoneKey(tombstone), tombstone];
    })).values()]
    : selectedLogicalTombstones.map(clone);
  return {
    questionCapsule: makeQuestionCapsule(questionReservations, metadata),
    checkpointCapsule: checkpointDeliveries.length === 0
      ? null
      : makeDeliveryCapsule(checkpointDeliveries, metadata),
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
