'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { normalizeDeliveryRecordV2Local } = require('../src/server/delivery-reclamation-codec');
const { projectNormalizedDeliveryReferences } = require('../src/server/reclamation-delivery-references');

const CLAIM_FIELDS = [
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding',
];

function identity(provider, suffix) {
  return {
    provider,
    nativeIdKind: provider === 'claude' ? 'session' : 'thread',
    hostId: `${provider}-host-${suffix}`,
    homeScopeId: `${provider}-home-${suffix}`,
    nativeId: `${provider}-native-${suffix}`,
  };
}

function claims(provider, suffix) {
  return {
    launchId: `launch-${suffix}`,
    runId: `run-${suffix}`,
    attemptId: `attempt-${suffix}`,
    provider,
    nativeIdKind: provider === 'claude' ? 'session' : 'thread',
    hostId: `${provider}-host-${suffix}`,
    homeScopeId: `${provider}-home-${suffix}`,
    origin: 'delegated',
    purpose: 'agent',
    originBinding: { periodId: `parent-${suffix}`, actor: { kind: 'agent', id: `owner-${suffix}` } },
  };
}

function sourceFor(suffix) {
  const provider = 'claude';
  const binding = { periodId: `period-${suffix}`, actor: { kind: 'agent', id: `actor-${suffix}` } };
  return {
    launchRef: `source-launch-ref-${suffix}`,
    claims: claims(provider, `source-${suffix}`),
    identity: identity(provider, `source-${suffix}`),
    executionBinding: binding,
    conversationId: `source-conversation-${suffix}`,
    sessionId: `source-session-${suffix}`,
  };
}

function detailFor(kind, targetKind = 'execution') {
  const source = sourceFor(kind);
  const targetClaims = claims('codex', `target-${kind}`);
  const target = targetKind === 'owner'
    ? {
        kind: 'owner', launchRef: null, claims: null,
        identity: identity('codex', `owner-${kind}`),
        periodId: `owner-period-${kind}`, actor: { kind: 'agent', id: `owner-actor-${kind}` },
        conversationId: `owner-conversation-${kind}`, sessionId: `owner-session-${kind}`,
      }
    : {
        kind: 'execution', launchRef: `target-launch-ref-${kind}`, claims: targetClaims,
        identity: identity('codex', `target-${kind}`), periodId: `target-period-${kind}`,
        actor: { kind: 'agent', id: `target-actor-${kind}` },
        conversationId: `target-conversation-${kind}`, sessionId: `target-session-${kind}`,
      };
  return normalizeDeliveryRecordV2Local({
    recordType: 'detail',
    deliveryAttemptId: `delivery-${kind}`,
    kind: kind === 'owner' ? 'result' : 'pr-notification',
    logicalMessageId: `logical-${kind}`,
    revision: 3,
    sourceExecutionId: source.executionBinding.periodId,
    source,
    target,
    ownerGeneration: targetKind === 'owner' ? 7 : null,
    payloadDigest: 'a'.repeat(64),
    state: 'applied',
    cancelRequested: false,
    acceptedCorrelation: null,
    appliedCorrelation: {
      deliveryAttemptId: `delivery-${kind}`,
      revision: 3,
      payloadDigest: 'a'.repeat(64),
      targetPeriodId: target.periodId,
      nativeTurnId: `turn-${kind}`,
      nativeItemId: `item-${kind}`,
      clientRequestId: `delivery-${kind}`,
    },
    terminalAt: 1_000,
  });
}

function digestInClaimOrder(value) {
  const ordered = Object.fromEntries(CLAIM_FIELDS.map((field) => [field, value[field]]));
  return createHash('sha256').update(JSON.stringify(ordered), 'utf8').digest('hex');
}

test('normalized source and execution target references use fixed claims order and own their nested values', () => {
  const detail = detailFor('pr', 'execution');
  const refs = projectNormalizedDeliveryReferences(detail);

  assert.deepEqual(refs.sourceRef.launchKey, [
    detail.source.claims.launchId, detail.source.claims.runId, detail.source.claims.attemptId,
  ]);
  assert.equal(refs.sourceRef.sourceClaimsDigest, digestInClaimOrder(detail.source.claims));
  assert.deepEqual(refs.targetRef.launchKey, [
    detail.target.claims.launchId, detail.target.claims.runId, detail.target.claims.attemptId,
  ]);
  assert.equal(refs.targetRef.targetClaimsDigest, digestInClaimOrder(detail.target.claims));
  assert.notEqual(refs.sourceRef.sourceClaimsDigest, refs.targetRef.targetClaimsDigest);
  assert.notStrictEqual(refs.sourceRef.identity, detail.source.identity);
  assert.notStrictEqual(refs.sourceRef.executionBinding.actor, detail.source.executionBinding.actor);
  assert.notStrictEqual(refs.targetRef.identity, detail.target.identity);
  assert.notStrictEqual(refs.targetRef.actor, detail.target.actor);

  refs.sourceRef.identity.nativeId = 'mutated-source';
  refs.targetRef.actor.id = 'mutated-target';
  assert.equal(detail.source.identity.nativeId, 'claude-native-source-pr');
  assert.equal(detail.target.actor.id, 'target-actor-pr');
});

test('result owner references retain null launch metadata independently of the source', () => {
  const detail = detailFor('owner', 'owner');
  const refs = projectNormalizedDeliveryReferences(detail);

  assert.equal(refs.targetRef.kind, 'owner');
  assert.equal(refs.targetRef.launchRef, null);
  assert.equal(refs.targetRef.launchKey, null);
  assert.equal(refs.targetRef.targetClaimsDigest, null);
  assert.equal(refs.targetRef.periodId, detail.target.periodId);
  assert.equal(detail.ownerGeneration, 7);
  assert.notStrictEqual(refs.targetRef.identity, detail.target.identity);
});

test('grave records are rejected by the detail reference projector', () => {
  assert.throws(() => projectNormalizedDeliveryReferences({ recordType: 'reclaimed' }),
    { code: 'delivery_references_require_detail', message: 'delivery_references_require_detail' });
});
