'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { ContractModel, MAX_CHECKPOINT_BYTES, MAX_PAYLOAD_BYTES } = require('./contract-model');

function identity({
  provider = 'codex',
  nativeIdKind = provider === 'codex' ? 'thread' : 'session',
  hostId = 'host-one',
  homeScopeId = 'home-one',
  nativeId = 'native-one',
} = {}) {
  return { provider, nativeIdKind, hostId, homeScopeId, nativeId };
}

function startOwned(model, conversation, proofId, actorId) {
  return model.startOwnedPeriod({
    conversation,
    ownerActor: { kind: 'tool-use', id: actorId },
    evidence: { kind: 'owned-start', proofId, verified: true },
  });
}

function resumeOwned(model, conversation, endedPeriodId, proofId, actorId) {
  return model.startOwnedPeriod({
    conversation,
    ownerActor: { kind: 'tool-use', id: actorId },
    evidence: { kind: 'owned-resume', proofId, verified: true, endedPeriodId },
  });
}

function registerChild(model, runId, periodId, actorId) {
  const owner = { periodId, actor: { kind: 'tool-use', id: actorId } };
  return model.registerExecution({
    launchId: 'launch-' + runId,
    runId,
    attemptId: 'attempt-' + runId,
    provider: 'codex',
    origin: 'delegated',
    purpose: 'agent',
    originBinding: owner,
    currentOwner: owner,
  });
}

function ownerEvidence(model, runId, conversation) {
  const execution = model.executionMetadata(runId);
  return {
    launchId: execution.launchId,
    runId: execution.runId,
    attemptId: execution.attemptId,
    provider: execution.provider,
    origin: execution.origin,
    purpose: execution.purpose,
    originBinding: execution.originBinding,
    currentOwner: execution.currentOwner,
    ownerGeneration: execution.ownerGeneration,
    connectionGeneration: model.conversationMetadata(conversation).connectionGeneration,
    verified: true,
  };
}

function assertCode(action, code) {
  assert.throws(action, (error) => error && error.code === code);
}

test('conversation identity separates provider, native ID kind, host, and HOME scope', () => {
  const model = new ContractModel();
  const codexA = identity({ nativeId: 'same-native' });
  const codexOtherHome = identity({ nativeId: 'same-native', homeScopeId: 'home-two' });
  const claude = identity({
    provider: 'claude',
    nativeIdKind: 'session',
    nativeId: 'same-native',
  });
  const pA = startOwned(model, codexA, 'proof-a', 'actor-a');
  const pHome = startOwned(model, codexOtherHome, 'proof-home', 'actor-home');
  const pClaude = startOwned(model, claude, 'proof-claude', 'actor-claude');

  assert.notEqual(pA, pHome);
  assert.notEqual(pA, pClaude);
  assert.notEqual(pA, codexA.nativeId);
  assert.notEqual(
    model.conversationMetadata(codexA).conversationKey,
    model.conversationMetadata(codexOtherHome).conversationKey,
  );
  assert.notEqual(
    model.conversationMetadata(codexA).conversationKey,
    model.conversationMetadata(claude).conversationKey,
  );
  assert.equal(model.observerResume(codexA).periodId, pA);
  assert.equal(model.observerResume(codexOtherHome).periodId, pHome);
  assert.equal(model.observerResume(claude).periodId, pClaude);
  assertCode(
    () => startOwned(
      model,
      identity({ nativeIdKind: 'session' }),
      'bad-kind-proof',
      'bad-kind-actor',
    ),
    'invalid_native_id_kind',
  );
  assertCode(
    () => model.observerResume({ provider: 'codex', nativeIdKind: 'thread', hostId: 'host-one', nativeId: 'x' }),
    'invalid_conversation_identity',
  );
});

test('observer resume, compaction, and reconnect do not create a new owned period', () => {
  const model = new ContractModel();
  const conversation = identity();
  const first = startOwned(model, conversation, 'proof-first', 'actor-first');
  const observer = model.observerResume(conversation);
  const compaction = model.observeCompaction(conversation);
  assert.equal(observer.periodId, first);
  assert.equal(compaction.periodId, first);

  const reconnected = model.reconnect(conversation);
  assert.equal(reconnected.periodId, first);
  assert.equal(reconnected.connectionGeneration, observer.connectionGeneration + 1);
  assert.equal(model.observerResume(conversation).periodId, first);

  model.endPeriod(first);
  assertCode(() => model.observerResume(conversation), 'no_active_owned_period');
  assertCode(
    () => model.startOwnedPeriod({
      conversation,
      ownerActor: { kind: 'agent', id: 'unproven-new-owner' },
      evidence: { kind: 'owned-start', proofId: 'wrong-start-kind', verified: true },
    }),
    'resume_evidence_required',
  );
  const second = resumeOwned(model, conversation, first, 'proof-resume', 'actor-second');
  assert.notEqual(second, first);
  assert.equal(model.periodMetadata(first).status, 'ended');
  assert.equal(model.observerResume(conversation).periodId, second);
});
test('handoff, restore, and fresh reconciliation keep result and PR destinations explicit', () => {
  const model = new ContractModel();
  const conversationA = identity({ nativeId: 'thread-a', homeScopeId: 'home-a' });
  const conversationB = identity({ nativeId: 'thread-b', homeScopeId: 'home-b' });
  const periodA = startOwned(model, conversationA, 'proof-a', 'actor-a');
  const periodB = startOwned(model, conversationB, 'proof-b', 'actor-b');
  registerChild(model, 'child-c', periodA, 'actor-a');
  model.registerPrNotificationTarget({
    targetId: 'notify-b',
    periodId: periodB,
    actor: { kind: 'tool-use', id: 'actor-b' },
  });

  const original = model.executionMetadata('child-c');
  model.handoff('child-c', {
    handoffId: 'handoff-a-b',
    expectedOwnerGeneration: 0,
    newOwnerGeneration: 1,
    newOwner: { periodId: periodB, actor: { kind: 'tool-use', id: 'actor-b' } },
  });
  const restored = ContractModel.restore(model.checkpoint());
  const restoredRun = restored.executionMetadata('child-c');
  assert.deepEqual(restoredRun.originBinding, original.originBinding);
  assert.equal(restoredRun.currentOwner.periodId, periodB);
  assert.equal(restoredRun.ownerGeneration, 1);
  assertCode(
    () => restored.createResultDelivery({
      deliveryAttemptId: 'result-too-early',
      logicalMessageId: 'logical-result',
      executionId: 'child-c',
      revision: 1,
      payload: 'synthetic result',
    }),
    'owner_not_reconciled',
  );

  const connectionGeneration = restored.conversationMetadata(conversationB).connectionGeneration;
  restored.reconcileConversation(conversationB, {
    periodId: periodB,
    connectionGeneration,
    verified: true,
  });
  registerChild(restored, 'other-child-b', periodB, 'actor-b');
  assertCode(
    () => restored.createResultDelivery({
      deliveryAttemptId: 'result-still-too-early',
      logicalMessageId: 'logical-result',
      executionId: 'child-c',
      revision: 1,
      payload: 'synthetic result',
    }),
    'execution_not_reconciled',
  );
  const staleProof = ownerEvidence(restored, 'child-c', conversationB);
  staleProof.ownerGeneration = 0;
  assertCode(
    () => restored.reconcileExecution('child-c', staleProof),
    'owner_generation_proof_mismatch',
  );
  const changedOrigin = ownerEvidence(restored, 'child-c', conversationB);
  changedOrigin.originBinding = null;
  assertCode(
    () => restored.reconcileExecution('child-c', changedOrigin),
    'origin_proof_mismatch',
  );

  restored.reconcileExecution('child-c', ownerEvidence(restored, 'child-c', conversationB));
  restored.endPeriod(periodA);
  assert.equal(restored.executionMetadata('child-c').currentOwner.periodId, periodB);

  const result = restored.createResultDelivery({
    deliveryAttemptId: 'result-to-b',
    logicalMessageId: 'logical-result',
    executionId: 'child-c',
    revision: 1,
    payload: 'synthetic result for B',
  });
  const notification = restored.createPrNotification({
    deliveryAttemptId: 'pr-to-b',
    logicalMessageId: 'pr-event-b',
    executionId: 'child-c',
    revision: 1,
    targetId: 'notify-b',
    payload: 'synthetic PR notification for B',
  });
  assert.equal(result.recipient.periodId, periodB);
  assert.equal(notification.targetId, 'notify-b');
  assert.equal(notification.recipient.periodId, periodB);
  assert.equal(Object.hasOwn(restored.deliveryMetadata('result-to-b'), 'payload'), false);
  assert.equal(Object.hasOwn(restored.claimDelivery('result-to-b', 'poll-1'), 'payload'), false);
  assert.equal(
    restored.checkpoint().includes('synthetic result for B'),
    false,
  );

  assert.equal(restored.sendStart('result-to-b').payload, 'synthetic result for B');
  assert.equal(restored.sendStart('pr-to-b').payload, 'synthetic PR notification for B');
  const afterRestart = ContractModel.restore(restored.checkpoint());
  assert.equal(afterRestart.deliveryMetadata('result-to-b').status, 'unknown');
  assert.equal(afterRestart.deliveryMetadata('pr-to-b').status, 'unknown');
  assertCode(() => afterRestart.sendStart('result-to-b'), 'delivery_not_sendable');
});

test('handoff replay is idempotent while conflicting or stale generations are rejected', () => {
  const model = new ContractModel();
  const conversationA = identity({ nativeId: 'parent-a' });
  const conversationB = identity({ nativeId: 'parent-b' });
  const conversationC = identity({ nativeId: 'parent-c' });
  const periodA = startOwned(model, conversationA, 'proof-a', 'actor-a');
  const periodB = startOwned(model, conversationB, 'proof-b', 'actor-b');
  const periodC = startOwned(model, conversationC, 'proof-c', 'actor-c');
  registerChild(model, 'run-handoff', periodA, 'actor-a');
  const before = model.executionMetadata('run-handoff');
  const handoffToB = {
    handoffId: 'handoff-1',
    expectedOwnerGeneration: 0,
    newOwnerGeneration: 1,
    newOwner: { periodId: periodB, actor: { kind: 'tool-use', id: 'actor-b' } },
  };
  const accepted = model.handoff('run-handoff', handoffToB);
  assert.deepEqual(model.handoff('run-handoff', handoffToB), accepted);
  assertCode(
    () => model.handoff('run-handoff', {
      ...handoffToB,
      newOwnerGeneration: 2,
      newOwner: { periodId: periodC, actor: { kind: 'tool-use', id: 'actor-c' } },
    }),
    'handoff_id_conflict',
  );
  assertCode(
    () => model.handoff('run-handoff', {
      handoffId: 'stale-retry',
      expectedOwnerGeneration: 0,
      newOwnerGeneration: 1,
      newOwner: { periodId: periodC, actor: { kind: 'tool-use', id: 'actor-c' } },
    }),
    'stale_owner_generation',
  );

  model.reconcileExecution(
    'run-handoff',
    ownerEvidence(model, 'run-handoff', conversationB),
  );
  model.handoff('run-handoff', {
    handoffId: 'handoff-2',
    expectedOwnerGeneration: 1,
    newOwnerGeneration: 2,
    newOwner: { periodId: periodC, actor: { kind: 'tool-use', id: 'actor-c' } },
  });
  const after = model.executionMetadata('run-handoff');
  for (const field of [
    'launchId', 'runId', 'attemptId', 'provider', 'origin', 'purpose', 'originBinding',
  ]) {
    assert.deepEqual(after[field], before[field]);
  }
  assert.equal(after.ownerGeneration, 2);
  assert.equal(after.currentOwner.periodId, periodC);
});
test('cancel wins before send-start, while late cancellation preserves delivery evidence', () => {
  const model = new ContractModel();
  const conversation = identity();
  const periodId = startOwned(model, conversation, 'proof-owner', 'actor-owner');
  registerChild(model, 'run-question', periodId, 'actor-owner');
  const actor = { kind: 'tool-use', id: 'actor-owner' };

  model.createQuestionDelivery({
    deliveryAttemptId: 'question-cancelled',
    logicalMessageId: 'question-1',
    executionId: 'run-question',
    revision: 1,
    decision: 'provisional',
    payload: 'synthetic answer that must remain private',
  });
  const claim = model.claimDelivery('question-cancelled', 'poller-a');
  assert.equal(claim.status, 'claimed');
  assert.equal(Object.hasOwn(claim, 'payload'), false);
  assert.equal(Object.hasOwn(model.deliveryMetadata('question-cancelled'), 'payload'), false);
  const cancelled = model.cancelQuestion('question-cancelled');
  assert.equal(cancelled.status, 'cancelled_before_send');
  assert.equal(cancelled.decision, 'provisional');
  assert.equal(cancelled.decisionState, 'cancelled');
  assertCode(() => model.sendStart('question-cancelled'), 'delivery_not_sendable');
  assertCode(
    () => model.recordDeliveryEvidence('question-cancelled', {
      stage: 'accepted',
      revision: 1,
      periodId,
      actor,
      ownerGeneration: 0,
    }),
    'delivery_not_in_flight',
  );

  model.createQuestionDelivery({
    deliveryAttemptId: 'question-race',
    logicalMessageId: 'question-2',
    executionId: 'run-question',
    revision: 2,
    decision: 'chosen',
    payload: 'synthetic selected answer',
  });
  model.claimDelivery('question-race', 'poller-b');
  assert.equal(model.sendStart('question-race').payload, 'synthetic selected answer');
  const lateCancel = model.cancelQuestion('question-race');
  assert.equal(lateCancel.status, 'sending');
  assert.equal(lateCancel.cancelRequested, true);
  assert.equal(lateCancel.decisionState, 'chosen');

  const evidence = {
    revision: 2,
    periodId,
    actor,
    ownerGeneration: 0,
  };
  const accepted = model.recordDeliveryEvidence('question-race', {
    ...evidence,
    stage: 'accepted',
  });
  assert.equal(accepted.status, 'accepted');
  assert.equal(accepted.applied, false);
  const applied = model.recordDeliveryEvidence('question-race', {
    ...evidence,
    stage: 'applied',
  });
  assert.equal(applied.status, 'applied');
  assert.equal(applied.cancelRequested, true);
  assert.equal(applied.decisionState, 'chosen');
});

test('send-start persistence failure rolls back without exposing the answer payload', () => {
  let failNextSave = false;
  let lastSaved;
  const model = new ContractModel({
    persist(snapshot) {
      if (failNextSave) {
        failNextSave = false;
        throw new Error('fixture save failure');
      }
      lastSaved = snapshot;
    },
  });
  const conversation = identity();
  const periodId = startOwned(model, conversation, 'proof-store', 'actor-store');
  registerChild(model, 'run-store', periodId, 'actor-store');
  const secretFixture = 'synthetic-answer-never-checkpointed';
  model.createQuestionDelivery({
    deliveryAttemptId: 'question-store',
    logicalMessageId: 'question-store',
    executionId: 'run-store',
    revision: 1,
    decision: 'chosen',
    payload: secretFixture,
  });
  model.claimDelivery('question-store', 'poller-store');
  const before = model.checkpoint();
  failNextSave = true;

  assert.throws(
    () => model.sendStart('question-store'),
    /fixture save failure/,
  );
  assert.equal(model.checkpoint(), before);
  assert.equal(model.deliveryMetadata('question-store').status, 'claimed');
  assert.equal(lastSaved.includes(secretFixture), false);
  assert.equal(model.checkpoint().includes(secretFixture), false);

  assert.equal(model.sendStart('question-store').payload, secretFixture);
});
test('started logical results cannot be replayed to a new owner, while proven unsent attempts require explicit superseding', () => {
  const model = new ContractModel();
  const conversationA = identity({ nativeId: 'parent-a', homeScopeId: 'home-a' });
  const conversationB = identity({ nativeId: 'parent-b', homeScopeId: 'home-b' });
  const periodA = startOwned(model, conversationA, 'proof-a', 'actor-a');
  const periodB = startOwned(model, conversationB, 'proof-b', 'actor-b');
  registerChild(model, 'run-delivery', periodA, 'actor-a');

  model.createResultDelivery({
    deliveryAttemptId: 'result-unsent-a',
    logicalMessageId: 'result-unsent',
    executionId: 'run-delivery',
    revision: 1,
    payload: 'synthetic result not yet sent',
  });
  model.createResultDelivery({
    deliveryAttemptId: 'result-started-a',
    logicalMessageId: 'result-started',
    executionId: 'run-delivery',
    revision: 1,
    payload: 'synthetic result already sent',
  });
  model.sendStart('result-started-a');

  model.registerPrNotificationTarget({
    targetId: 'registered-a',
    periodId: periodA,
    actor: { kind: 'tool-use', id: 'actor-a' },
  });
  model.registerPrNotificationTarget({
    targetId: 'registered-b',
    periodId: periodB,
    actor: { kind: 'tool-use', id: 'actor-b' },
  });
  model.createPrNotification({
    deliveryAttemptId: 'pr-event-a',
    logicalMessageId: 'pr-event-1',
    executionId: 'run-delivery',
    revision: 1,
    targetId: 'registered-a',
    payload: 'synthetic PR event for A',
  });
  model.createPrNotification({
    deliveryAttemptId: 'pr-event-b',
    logicalMessageId: 'pr-event-1',
    executionId: 'run-delivery',
    revision: 1,
    targetId: 'registered-b',
    payload: 'synthetic PR event for B',
  });

  model.handoff('run-delivery', {
    handoffId: 'handoff-to-b',
    expectedOwnerGeneration: 0,
    newOwnerGeneration: 1,
    newOwner: { periodId: periodB, actor: { kind: 'tool-use', id: 'actor-b' } },
  });
  model.reconcileExecution('run-delivery', ownerEvidence(model, 'run-delivery', conversationB));
  assertCode(
    () => model.createResultDelivery({
      deliveryAttemptId: 'result-started-b',
      logicalMessageId: 'result-started',
      executionId: 'run-delivery',
      revision: 1,
      payload: 'duplicate must not be sent to B',
    }),
    'duplicate_logical_delivery',
  );
  assertCode(
    () => model.createResultDelivery({
      deliveryAttemptId: 'result-unsent-b-too-soon',
      logicalMessageId: 'result-unsent',
      executionId: 'run-delivery',
      revision: 1,
      payload: 'replacement before invalidation',
    }),
    'duplicate_logical_delivery',
  );

  assert.equal(model.supersedeUnsentDelivery('result-unsent-a').status, 'superseded_before_send');
  model.createResultDelivery({
    deliveryAttemptId: 'result-unsent-b',
    logicalMessageId: 'result-unsent',
    executionId: 'run-delivery',
    revision: 1,
    payload: 'synthetic result explicitly redirected to B',
  });
  model.endPeriod(periodA);
  assertCode(() => model.sendStart('pr-event-a'), 'owner_not_active');
  assert.equal(model.sendStart('pr-event-b').payload, 'synthetic PR event for B');
  assert.equal(
    model.sendStart('result-unsent-b').payload,
    'synthetic result explicitly redirected to B',
  );
  assertCode(
    () => model.createPrNotification({
      deliveryAttemptId: 'pr-event-b-duplicate',
      logicalMessageId: 'pr-event-1',
      executionId: 'run-delivery',
      revision: 1,
      targetId: 'registered-b',
      payload: 'duplicate for the same registered destination',
    }),
    'duplicate_logical_delivery',
  );

  registerChild(model, 'other-run-b', periodB, 'actor-b');
  model.createResultDelivery({
    deliveryAttemptId: 'same-name-other-run',
    logicalMessageId: 'result-started',
    executionId: 'other-run-b',
    revision: 1,
    payload: 'same local message name in another execution',
  });
  assert.equal(model.deliveryMetadata('same-name-other-run').executionId, 'other-run-b');
});

test('checkpoint rejects a rolled-back period sequence and unknown schema fields', () => {
  const model = new ContractModel();
  const conversation = identity();
  startOwned(model, conversation, 'proof-checkpoint', 'actor-checkpoint');
  const valid = JSON.parse(model.checkpoint());

  const rewound = structuredClone(valid);
  rewound.nextPeriodSequence = 1;
  assertCode(
    () => ContractModel.restore(JSON.stringify(rewound)),
    'period_sequence_rewind',
  );

  const extended = structuredClone(valid);
  extended.unrecognized = true;
  assertCode(
    () => ContractModel.restore(JSON.stringify(extended)),
    'invalid_checkpoint_schema',
  );
  assertCode(
    () => ContractModel.restore('x'.repeat(MAX_CHECKPOINT_BYTES + 1)),
    'checkpoint_too_large',
  );
});

test('reconnect invalidates each execution proof until that execution is reconciled', () => {
  const model = new ContractModel();
  const conversation = identity();
  const periodId = startOwned(model, conversation, 'proof-reconnect', 'actor-reconnect');
  registerChild(model, 'run-old-proof', periodId, 'actor-reconnect');
  const otherRun = registerChild(model, 'run-other-proof', periodId, 'actor-reconnect');
  const reconnected = model.reconnect(conversation);
  model.reconcileConversation(conversation, {
    periodId,
    connectionGeneration: reconnected.connectionGeneration,
    verified: true,
  });
  model.reconcileExecution(otherRun, ownerEvidence(model, otherRun, conversation));

  assertCode(
    () => model.createResultDelivery({
      deliveryAttemptId: 'blocked-after-reconnect',
      logicalMessageId: 'result-reconnect',
      executionId: 'run-old-proof',
      revision: 1,
      payload: 'must wait for this execution proof',
    }),
    'execution_not_reconciled',
  );
  const stale = ownerEvidence(model, 'run-old-proof', conversation);
  stale.connectionGeneration -= 1;
  assertCode(
    () => model.reconcileExecution('run-old-proof', stale),
    'stale_connection_proof',
  );

  model.reconcileExecution(
    'run-old-proof',
    ownerEvidence(model, 'run-old-proof', conversation),
  );
  assert.equal(
    model.createResultDelivery({
      deliveryAttemptId: 'allowed-after-reconcile',
      logicalMessageId: 'result-reconnect',
      executionId: 'run-old-proof',
      revision: 1,
      payload: 'freshly reconciled result',
    }).status,
    'available',
  );
});

test('origin, purpose, owner proof, and payload bounds reject ambiguous input', () => {
  const model = new ContractModel();
  const conversation = identity();
  const periodId = model.startOwnedPeriod({
    conversation,
    ownerActor: { kind: 'agent', id: 'actor-strict' },
    evidence: { kind: 'owned-start', proofId: 'proof-strict', verified: true },
  });
  const owner = { periodId, actor: { kind: 'agent', id: 'actor-strict' } };
  assertCode(
    () => model.registerExecution({
      launchId: 'launch-bad-purpose',
      runId: 'run-bad-purpose',
      attemptId: 'attempt-bad-purpose',
      provider: 'codex',
      origin: 'delegated',
      purpose: 'cross-review',
      originBinding: owner,
      currentOwner: owner,
    }),
    'origin_purpose_mismatch',
  );
  assertCode(
    () => model.startOwnedPeriod({
      conversation: identity({ nativeId: 'unverified' }),
      ownerActor: { kind: 'agent', id: 'actor-unverified' },
      evidence: { kind: 'owned-start', proofId: 'proof-unverified', verified: false },
    }),
    'owner_evidence_unverified',
  );
  assert.equal(MAX_PAYLOAD_BYTES, 4096);
});
