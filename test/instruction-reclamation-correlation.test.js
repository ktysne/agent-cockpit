'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const {
  normalizeDeliveryRecordV2Local,
  normalizeInstructionRecordV2Local,
} = require('../src/server/delivery-reclamation-codec');
const {
  assertInstructionDeliveryBinding,
  projectInstructionDeliveryReferences,
} = require('../src/server/instruction-reclamation-correlation');

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sourceFor(provider, origin = 'standalone') {
  const binding = origin === 'standalone' ? null : {
    periodId: 'origin-period',
    actor: { kind: 'agent', id: 'origin-actor' },
  };
  const purpose = origin === 'review' ? 'cross-review' : 'agent';
  const identity = {
    provider,
    nativeIdKind: provider === 'claude' ? 'session' : 'thread',
    hostId: 'host-1',
    homeScopeId: 'home-1',
    nativeId: 'native-1',
  };
  return {
    launchRef: 'launch-ref-1',
    claims: {
      launchId: 'launch-1',
      runId: 'run-1',
      attemptId: 'attempt-1',
      provider,
      nativeIdKind: identity.nativeIdKind,
      hostId: identity.hostId,
      homeScopeId: identity.homeScopeId,
      origin,
      purpose,
      originBinding: binding,
    },
    identity,
    executionBinding: { periodId: 'execution-1', actor: { kind: 'tool-use', id: 'tool-1' } },
    conversationId: 'conversation-1',
    sessionId: 'session-1',
  };
}

function instructionFor(source) {
  const input = [{ type: 'text', text: 'message body', text_elements: [] }];
  const envelope = JSON.stringify({ schemaVersion: 1, mode: 'start', expectedTurnId: null, input });
  return normalizeInstructionRecordV2Local({
    recordType: 'detail',
    deliveryAttemptId: 'delivery-1',
    launchRef: source.launchRef,
    logicalMessageId: 'logical-1',
    revision: 1,
    source,
    envelope,
    envelopeDigest: sha256(envelope),
    nativeContentDigest: sha256(JSON.stringify(input)),
    createdAt: 10,
    deliveryCreationState: 'checkpointed',
    reclamation: null,
  });
}

function deliveryFor(instruction, { state = 'available', source, target, recordType = 'detail' } = {}) {
  const refs = projectInstructionDeliveryReferences(instruction.source);
  const base = {
    recordType: 'detail',
    deliveryAttemptId: instruction.deliveryAttemptId,
    kind: 'instruction',
    logicalMessageId: instruction.logicalMessageId,
    revision: instruction.revision,
    sourceExecutionId: instruction.source.executionBinding.periodId,
    source: source || refs.source,
    target: target || refs.target,
    ownerGeneration: null,
    payloadDigest: instruction.envelopeDigest,
    state,
    cancelRequested: false,
    acceptedCorrelation: null,
    appliedCorrelation: null,
    terminalAt: ['applied', 'cancelled_before_send', 'superseded_before_send'].includes(state) ? 100 : null,
  };
  if (state === 'applied') {
    base.appliedCorrelation = {
      deliveryAttemptId: instruction.deliveryAttemptId,
      revision: instruction.revision,
      payloadDigest: instruction.envelopeDigest,
      targetPeriodId: refs.target.periodId,
      nativeTurnId: 'turn-1',
      nativeItemId: 'item-1',
      clientRequestId: instruction.deliveryAttemptId,
    };
  }
  if (recordType === 'detail') return normalizeDeliveryRecordV2Local(base);
  const grave = {
    recordType: 'reclaimed',
    deliveryAttemptId: base.deliveryAttemptId,
    kind: base.kind,
    logicalMessageId: base.logicalMessageId,
    revision: base.revision,
    sourceExecutionId: base.sourceExecutionId,
    payloadDigest: base.payloadDigest,
    state: base.state,
    terminalAt: base.terminalAt,
    cancelRequested: base.cancelRequested,
    ownerGeneration: null,
    acceptedCorrelation: base.acceptedCorrelation,
    appliedCorrelation: base.appliedCorrelation,
    sourceRef: refs.sourceRef,
    targetRef: refs.targetRef,
    reclamation: {
      operationId: '22222222-2222-4222-8222-222222222222',
      reclaimedAt: 100 + 604_800_000,
      reason: 'terminal_retention',
    },
  };
  return normalizeDeliveryRecordV2Local(grave);
}

test('provider and origin source projections use canonical claim field order', () => {
  for (const provider of ['claude', 'codex']) {
    for (const origin of ['delegated', 'review']) {
      const source = sourceFor(provider, origin);
      source.claims.originBinding = {
        actor: { id: 'origin-actor', kind: 'agent' },
        periodId: 'origin-period',
      };
      const projected = projectInstructionDeliveryReferences(source);
      const claims = source.claims;
      const canonical = JSON.stringify({
        launchId: claims.launchId,
        runId: claims.runId,
        attemptId: claims.attemptId,
        provider: claims.provider,
        nativeIdKind: claims.nativeIdKind,
        hostId: claims.hostId,
        homeScopeId: claims.homeScopeId,
        origin: claims.origin,
        purpose: claims.purpose,
        originBinding: {
          periodId: 'origin-period',
          actor: { kind: 'agent', id: 'origin-actor' },
        },
      });
      const expected = sha256(canonical);
      assert.equal(projected.sourceRef.sourceClaimsDigest, expected);
      assert.equal(projected.targetRef.targetClaimsDigest, expected);
      assert.equal(projected.sourceRef.launchKey.join(','), 'launch-1,run-1,attempt-1');
    }
  }
});

test('static binding accepts matching instruction detail and terminal grave for both providers', () => {
  for (const provider of ['claude', 'codex']) {
    const instruction = instructionFor(sourceFor(provider));
    assert.doesNotThrow(() => assertInstructionDeliveryBinding(
      instruction, deliveryFor(instruction), 'instruction_binding_mismatch'));
    for (const state of ['applied', 'cancelled_before_send', 'superseded_before_send']) {
      const graveInstruction = instructionFor(sourceFor(provider));
      const grave = deliveryFor(graveInstruction, { state, recordType: 'reclaimed' });
      assert.doesNotThrow(() => assertInstructionDeliveryBinding(
        graveInstruction, grave, 'instruction_binding_mismatch'));
    }
  }
});

test('static binding rejects every outer and nested correlation mismatch', () => {
  const instruction = instructionFor(sourceFor('claude'));
  const delivery = deliveryFor(instruction);
  const cases = [
    ['attempt', (value) => { value.deliveryAttemptId = 'other-attempt'; }],
    ['logical id', (value) => { value.logicalMessageId = 'other-logical'; }],
    ['revision', (value) => { value.revision = 2; }],
    ['payload digest', (value) => { value.payloadDigest = 'b'.repeat(64); }],
    ['source execution', (value) => { value.sourceExecutionId = 'other-execution'; }],
    ['source claims', (value) => { value.source.claims.runId = 'other-run'; }],
    ['source identity', (value) => { value.source.identity.nativeId = 'other-native'; }],
    ['source binding actor', (value) => { value.source.executionBinding.actor.id = 'other-actor'; }],
    ['target claims', (value) => { value.target.claims.attemptId = 'other-launch-attempt'; }],
    ['target period', (value) => { value.target.periodId = 'other-period'; }],
    ['target actor kind', (value) => { value.target.actor.kind = 'agent'; }],
    ['conversation', (value) => { value.target.conversationId = 'other-conversation'; }],
    ['session', (value) => { value.target.sessionId = 'other-session'; }],
  ];
  for (const [label, corrupt] of cases) {
    const candidate = structuredClone(delivery);
    corrupt(candidate);
    assert.throws(() => assertInstructionDeliveryBinding(
      instruction, candidate, 'instruction_binding_mismatch'),
    { code: 'instruction_binding_mismatch' }, label);
  }

  const graveInstruction = instructionFor(sourceFor('codex'));
  const grave = structuredClone(deliveryFor(graveInstruction, { state: 'applied', recordType: 'reclaimed' }));
  const wrongRef = structuredClone(grave);
  wrongRef.targetRef.actor.id = 'other-actor';
  assert.throws(() => assertInstructionDeliveryBinding(
    graveInstruction, wrongRef, 'grave_binding_mismatch'),
  { code: 'grave_binding_mismatch' });
});

test('static binding rejects accessors and invokes no hostile getter or toJSON', () => {
  let calls = 0;
  const rawSource = sourceFor('claude');
  Object.defineProperty(rawSource, 'sessionId', {
    enumerable: true,
    get() { calls += 1; throw new Error('source getter'); },
  });
  assert.throws(() => projectInstructionDeliveryReferences(rawSource), TypeError);
  assert.equal(calls, 0);

  const instruction = instructionFor(sourceFor('codex'));
  const delivery = deliveryFor(instruction);
  const hostile = structuredClone(delivery);
  Object.defineProperty(hostile.source, 'toJSON', {
    enumerable: true,
    value() { calls += 1; throw new Error('toJSON'); },
  });
  assert.throws(() => assertInstructionDeliveryBinding(
    instruction, hostile, 'instruction_binding_mismatch'), TypeError);
  assert.equal(calls, 0);
});
