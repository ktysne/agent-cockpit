'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { createDelivery, createEmptyLedger } = require('../src/server/delivery-ledger');
const { createReclamationDelivery, legacyLedgerView } = require('../src/server/delivery-reclamation-runtime');
const {
  normalizeDeliveryLedgerV2Local,
  normalizeDeliveryRecordV2Local,
} = require('../src/server/delivery-reclamation-codec');

const OPERATION_ID = '11111111-1111-4111-8111-111111111111';

function launch() {
  const identity = {
    provider: 'claude', nativeIdKind: 'session', hostId: 'host-id',
    homeScopeId: 'home-id', nativeId: 'native-id',
  };
  return {
    launchRef: 'launch-ref', launchId: 'launch-id', runId: 'run-id', attemptId: 'attempt-id',
    provider: 'claude', nativeIdKind: 'session', hostId: 'host-id', homeScopeId: 'home-id',
    origin: 'standalone', purpose: 'agent', originBinding: null, state: 'bound', identity,
    executionBinding: { periodId: 'period-id', actor: { kind: 'agent', id: 'actor-id' } },
    conversationId: 'conversation-id', sessionId: 'session-id',
  };
}

function digestClaims(claims) {
  const canonical = {
    launchId: claims.launchId, runId: claims.runId, attemptId: claims.attemptId,
    provider: claims.provider, nativeIdKind: claims.nativeIdKind, hostId: claims.hostId,
    homeScopeId: claims.homeScopeId, origin: claims.origin, purpose: claims.purpose,
    originBinding: null,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function legacyDetail(source, suffix) {
  return createDelivery(createEmptyLedger(), 'question', {
    deliveryAttemptId: `attempt-${suffix}`,
    logicalMessageId: `logical-${suffix}`,
    revision: 1,
    payload: `payload-${suffix}`,
  }, source).delivery;
}

function graveFrom(detail) {
  const source = detail.source;
  const target = detail.target;
  const launchKey = [source.claims.launchId, source.claims.runId, source.claims.attemptId];
  const claimsDigest = digestClaims(source.claims);
  return normalizeDeliveryRecordV2Local({
    recordType: 'reclaimed',
    deliveryAttemptId: detail.deliveryAttemptId,
    kind: detail.kind,
    logicalMessageId: detail.logicalMessageId,
    revision: detail.revision,
    sourceExecutionId: detail.sourceExecutionId,
    payloadDigest: detail.payloadDigest,
    state: detail.state,
    terminalAt: null,
    cancelRequested: detail.cancelRequested,
    ownerGeneration: detail.ownerGeneration,
    acceptedCorrelation: null,
    appliedCorrelation: null,
    sourceRef: {
      launchRef: source.launchRef, launchKey, sourceClaimsDigest: claimsDigest,
      identity: source.identity, executionBinding: source.executionBinding,
      conversationId: source.conversationId, sessionId: source.sessionId,
    },
    targetRef: {
      kind: target.kind, launchRef: target.launchRef, launchKey,
      targetClaimsDigest: claimsDigest, identity: target.identity,
      periodId: target.periodId, actor: target.actor,
      conversationId: target.conversationId, sessionId: target.sessionId,
    },
    reclamation: {
      operationId: OPERATION_ID, reclaimedAt: 1_000, reason: 'retired_question_period',
    },
  });
}

function tombstone(record) {
  const sourceKey = record.recordType === 'detail'
    ? [record.source.claims.launchId, record.source.claims.runId, record.source.claims.attemptId]
    : record.sourceRef.launchKey;
  return {
    kind: record.kind,
    sourceExecutionId: record.sourceExecutionId,
    logicalMessageId: record.logicalMessageId,
    revision: record.revision,
    targetLaunchKey: null,
    sourceLaunchKey: sourceKey,
    payloadDigest: record.payloadDigest,
  };
}

function ledgerWithIndependentGrave(source) {
  const unrelated = normalizeDeliveryRecordV2Local({
    recordType: 'detail', ...legacyDetail(source, 'unrelated'), terminalAt: null,
  });
  const grave = graveFrom(legacyDetail(source, 'grave'));
  return normalizeDeliveryLedgerV2Local({
    schemaVersion: 2,
    revision: 2,
    deliveries: [grave, unrelated],
    notificationTargets: [],
    logicalTombstones: [tombstone(grave), tombstone(unrelated)],
  });
}

test('a grave without a launch registration does not block an unrelated live detail transition', () => {
  const source = launch();
  const ledger = ledgerWithIndependentGrave(source);
  const checkpoint = { ledger };

  const legacy = legacyLedgerView(checkpoint);
  assert.deepEqual(legacy.deliveries.map((record) => record.deliveryAttemptId), ['attempt-unrelated']);
  assert.equal(legacy.logicalTombstones.length, 1);

  const created = createReclamationDelivery(checkpoint, 'question', {
    deliveryAttemptId: 'attempt-next', logicalMessageId: 'logical-next', revision: 1, payload: 'next',
  }, source, undefined);

  assert.equal(created.created, true);
  assert.equal(created.ledger.deliveries.find((record) => record.deliveryAttemptId === 'attempt-grave').recordType,
    'reclaimed');
  assert.equal(created.ledger.deliveries.find((record) => record.deliveryAttemptId === 'attempt-next').recordType,
    'detail');
  assert.equal(created.ledger.logicalTombstones.length, 3);
});
