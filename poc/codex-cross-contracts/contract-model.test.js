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

const executionLocations = new WeakMap();

function locationsFor(model) {
  let locations = executionLocations.get(model);
  if (!locations) {
    locations = new Map();
    executionLocations.set(model, locations);
  }
  return locations;
}

function registerChild(model, runId, periodId, actorId, options = {}) {
  const owner = { periodId, actor: { kind: 'tool-use', id: actorId } };
  const bindingConversation = options.executionConversation || identity({
    nativeId: 'execution-' + runId,
    homeScopeId: 'home-execution-' + runId,
  });
  const bindingActor = options.executionActor || { kind: 'tool-use', id: 'execution-' + runId };
  const bindingPeriodId = startOwned(
    model,
    bindingConversation,
    'proof-execution-' + runId,
    bindingActor.id,
  );
  const executionBinding = { periodId: bindingPeriodId, actor: bindingActor };
  locationsFor(model).set(runId, { conversation: bindingConversation, executionBinding });
  return model.registerExecution({
    launchId: 'launch-' + runId,
    runId,
    attemptId: 'attempt-' + runId,
    provider: options.provider || 'codex',
    origin: 'delegated',
    purpose: 'agent',
    originBinding: owner,
    executionBinding,
    currentOwner: owner,
  });
}

function registerTargetExecution(model, runId, periodId, actorId, conversation) {
  const binding = { periodId, actor: { kind: 'tool-use', id: actorId } };
  locationsFor(model).set(runId, { conversation, executionBinding: binding });
  return model.registerExecution({
    launchId: 'launch-' + runId,
    runId,
    attemptId: 'attempt-' + runId,
    provider: conversation.provider,
    origin: 'standalone',
    purpose: 'agent',
    originBinding: null,
    executionBinding: binding,
    currentOwner: binding,
  });
}

function ownerEvidence(model, runId, ownerConversation) {
  const execution = model.executionMetadata(runId);
  const location = locationsFor(model).get(runId);
  const ownConversation = location
    ? location.conversation
    : model.periodMetadata(execution.executionBinding.periodId).conversationIdentity;
  return {
    launchId: execution.launchId,
    runId: execution.runId,
    attemptId: execution.attemptId,
    provider: execution.provider,
    origin: execution.origin,
    purpose: execution.purpose,
    originBinding: execution.originBinding,
    executionBinding: execution.executionBinding,
    currentOwner: execution.currentOwner,
    ownerGeneration: execution.ownerGeneration,
    ownerConnectionGeneration: model.conversationMetadata(ownerConversation).connectionGeneration,
    executionConnectionGeneration: model.conversationMetadata(ownConversation).connectionGeneration,
    verified: true,
  };
}

function registerTarget(model, targetId, targetExecutionId) {
  return model.registerPrNotificationTarget({ targetId, targetExecutionId });
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
  registerTargetExecution(model, 'target-b', periodB, 'actor-b', conversationB);
  registerTarget(model, 'notify-b', 'target-b');

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
    'execution_binding_not_reconciled',
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
  restored.reconcileExecution('target-b', ownerEvidence(restored, 'target-b', conversationB));
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
  const questionBinding = model.executionMetadata('run-question').executionBinding;
  const actor = questionBinding.actor;

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
      periodId: questionBinding.periodId,
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
    periodId: questionBinding.periodId,
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

  registerTargetExecution(model, 'target-a', periodA, 'actor-a', conversationA);
  registerTargetExecution(model, 'target-b', periodB, 'actor-b', conversationB);
  registerTarget(model, 'registered-a', 'target-a');
  registerTarget(model, 'registered-b', 'target-b');
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
  assertCode(() => model.sendStart('pr-event-a'), 'execution_ended');
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
  stale.ownerConnectionGeneration -= 1;
  assertCode(
    () => model.reconcileExecution('run-old-proof', stale),
    'stale_owner_connection_proof',
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
      executionBinding: owner,
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

test('questions stay with the child while results follow a proven owner handoff', () => {
  const model = new ContractModel();
  const conversationA = identity({ nativeId: 'question-parent-a' });
  const conversationB = identity({ nativeId: 'question-parent-b' });
  const periodA = startOwned(model, conversationA, 'proof-question-a', 'question-a');
  const periodB = startOwned(model, conversationB, 'proof-question-b', 'question-b');
  registerChild(model, 'run-question-route', periodA, 'question-a');
  const execution = model.executionMetadata('run-question-route');
  const ownBinding = execution.executionBinding;
  model.createQuestionDelivery({
    deliveryAttemptId: 'question-before-handoff',
    logicalMessageId: 'question-route',
    executionId: execution.runId,
    revision: 1,
    decision: 'chosen',
    payload: 'answer remains addressed to child C',
  });
  assert.deepEqual(model.deliveryMetadata('question-before-handoff').recipient, ownBinding);
  model.createResultDelivery({
    deliveryAttemptId: 'result-before-handoff',
    logicalMessageId: 'result-route',
    executionId: execution.runId,
    revision: 1,
    payload: 'old result remains addressed to A',
  });

  model.handoff(execution.runId, {
    handoffId: 'question-route-handoff',
    expectedOwnerGeneration: 0,
    newOwnerGeneration: 1,
    newOwner: { periodId: periodB, actor: { kind: 'tool-use', id: 'question-b' } },
  });
  model.reconcileExecution(
    execution.runId,
    ownerEvidence(model, execution.runId, conversationB),
  );

  const question = model.sendStart('question-before-handoff');
  assert.deepEqual(question.recipient, ownBinding);
  assert.equal(question.routeOwnerGeneration, 1);
  assertCode(() => model.sendStart('result-before-handoff'), 'delivery_owner_changed');
  model.supersedeUnsentDelivery('result-before-handoff');
  model.createResultDelivery({
    deliveryAttemptId: 'result-after-handoff',
    logicalMessageId: 'result-route',
    executionId: execution.runId,
    revision: 1,
    payload: 'new result addressed to B',
  });
  const result = model.sendStart('result-after-handoff');
  assert.deepEqual(result.recipient, {
    periodId: periodB,
    actor: { kind: 'tool-use', id: 'question-b' },
  });
  assert.equal(result.routeOwnerGeneration, 1);
});


test('child reconnect and forged or duplicate execution bindings do not reuse a current proof', () => {
  const model = new ContractModel();
  const parentConversation = identity({ nativeId: 'binding-parent' });
  const parentPeriod = startOwned(model, parentConversation, 'proof-binding-parent', 'binding-parent');
  registerChild(model, 'run-child-binding', parentPeriod, 'binding-parent');
  const execution = model.executionMetadata('run-child-binding');
  const ownConversation = locationsFor(model).get(execution.runId).conversation;
  const reconnected = model.reconnect(ownConversation);
  model.reconcileConversation(ownConversation, {
    periodId: execution.executionBinding.periodId,
    connectionGeneration: reconnected.connectionGeneration,
    verified: true,
  });
  assertCode(
    () => model.createResultDelivery({
      deliveryAttemptId: 'blocked-child-reconnect',
      logicalMessageId: 'child-result',
      executionId: execution.runId,
      revision: 1,
      payload: 'wait for full child and owner proof',
    }),
    'execution_not_reconciled',
  );
  const staleChild = ownerEvidence(model, execution.runId, parentConversation);
  staleChild.executionConnectionGeneration -= 1;
  assertCode(
    () => model.reconcileExecution(execution.runId, staleChild),
    'stale_execution_connection_proof',
  );

  const forgedBinding = ownerEvidence(model, execution.runId, parentConversation);
  forgedBinding.executionBinding = execution.currentOwner;
  assertCode(
    () => model.reconcileExecution(execution.runId, forgedBinding),
    'origin_proof_mismatch',
  );
  model.reconcileExecution(
    execution.runId,
    ownerEvidence(model, execution.runId, parentConversation),
  );
  assertCode(
    () => model.registerExecution({
      launchId: 'launch-duplicate-binding',
      runId: 'run-duplicate-binding',
      attemptId: 'attempt-duplicate-binding',
      provider: 'codex',
      origin: 'delegated',
      purpose: 'agent',
      originBinding: execution.originBinding,
      executionBinding: execution.executionBinding,
      currentOwner: execution.currentOwner,
    }),
    'duplicate_execution_binding',
  );

  const claudeConversation = identity({
    provider: 'claude',
    nativeId: 'binding-claude-child',
    homeScopeId: 'home-claude-child',
  });
  const claudePeriod = startOwned(model, claudeConversation, 'proof-binding-claude', 'binding-claude');
  assertCode(
    () => model.registerExecution({
      launchId: 'launch-wrong-provider',
      runId: 'run-wrong-provider',
      attemptId: 'attempt-wrong-provider',
      provider: 'codex',
      origin: 'delegated',
      purpose: 'agent',
      originBinding: execution.originBinding,
      executionBinding: {
        periodId: claudePeriod,
        actor: { kind: 'tool-use', id: 'binding-claude' },
      },
      currentOwner: execution.currentOwner,
    }),
    'execution_binding_provider_mismatch',
  );
});


test('restore imports only an authenticated one-generation handoff after the old owner ends', () => {
  const model = new ContractModel();
  const conversationA = identity({ nativeId: 'restore-owner-a' });
  const conversationB = identity({ nativeId: 'restore-owner-b' });
  const periodA = startOwned(model, conversationA, 'proof-restore-a', 'restore-a');
  const periodB = startOwned(model, conversationB, 'proof-restore-b', 'restore-b');
  registerChild(model, 'run-offline-handoff', periodA, 'restore-a');
  const before = model.executionMetadata('run-offline-handoff');
  const childConversation = locationsFor(model).get(before.runId).conversation;
  model.createResultDelivery({
    deliveryAttemptId: 'offline-started-result-to-a',
    logicalMessageId: 'offline-started-result',
    executionId: before.runId,
    revision: 1,
    payload: 'already started before checkpoint',
  });
  model.sendStart('offline-started-result-to-a');
  const restored = ContractModel.restore(model.checkpoint());
  assert.equal(restored.deliveryMetadata('offline-started-result-to-a').status, 'unknown');
  restored.endPeriod(periodA);
  assert.equal(restored.executionMetadata(before.runId).status, 'active');
  assert.equal(restored.periodMetadata(before.executionBinding.periodId).status, 'active');
  const restoredExecution = restored.executionMetadata(before.runId);
  assert.equal(restoredExecution.currentProof, null);
  assertCode(
    () => restored.reconcileExecution(
      before.runId,
      ownerEvidence(restored, before.runId, conversationB),
    ),
    'owner_not_active',
  );

  const prematureBProof = ownerEvidence(restored, before.runId, conversationB);
  prematureBProof.currentOwner = {
    periodId: periodB,
    actor: { kind: 'tool-use', id: 'restore-b' },
  };
  prematureBProof.ownerGeneration = 1;
  assertCode(
    () => restored.reconcileExecution(before.runId, prematureBProof),
    'owner_proof_mismatch',
  );

  const request = {
    handoffId: 'offline-handoff-a-b',
    expectedOldOwner: restoredExecution.currentOwner,
    expectedOwnerGeneration: 0,
    newOwner: { periodId: periodB, actor: { kind: 'tool-use', id: 'restore-b' } },
    newOwnerGeneration: 1,
    executionIdentity: {
      launchId: restoredExecution.launchId,
      runId: restoredExecution.runId,
      attemptId: restoredExecution.attemptId,
      provider: restoredExecution.provider,
      origin: restoredExecution.origin,
      purpose: restoredExecution.purpose,
      originBinding: restoredExecution.originBinding,
      executionBinding: restoredExecution.executionBinding,
    },
    executionConnectionGeneration: restored.conversationMetadata(childConversation).connectionGeneration,
    newOwnerConnectionGeneration: restored.conversationMetadata(conversationB).connectionGeneration,
    verified: true,
  };
  assertCode(
    () => restored.reconcileHandoff(before.runId, { ...request, expectedOwnerGeneration: 1, newOwnerGeneration: 2 }),
    'stale_owner_generation',
  );
  assertCode(
    () => restored.reconcileHandoff(before.runId, { ...request, newOwnerGeneration: 2 }),
    'invalid_owner_generation',
  );
  assertCode(
    () => restored.reconcileHandoff(before.runId, {
      ...request,
      executionIdentity: { ...request.executionIdentity, originBinding: null },
    }),
    'origin_proof_mismatch',
  );
  assertCode(
    () => restored.reconcileHandoff(before.runId, {
      ...request,
      executionConnectionGeneration: request.executionConnectionGeneration - 1,
    }),
    'stale_execution_connection_proof',
  );
  assertCode(
    () => restored.reconcileHandoff(before.runId, {
      ...request,
      newOwnerConnectionGeneration: request.newOwnerConnectionGeneration - 1,
    }),
    'stale_owner_connection_proof',
  );
  assertCode(
    () => restored.reconcileHandoff(before.runId, { ...request, verified: false }),
    'handoff_reconciliation_unverified',
  );

  assert.deepEqual(restored.reconcileHandoff(before.runId, request), {
    executionId: before.runId,
    currentOwner: request.newOwner,
    ownerGeneration: 1,
  });
  assert.equal(restored.executionMetadata(before.runId).currentProof, null);
  assert.equal(restored.executionMetadata(before.runId).status, 'active');
  assertCode(
    () => restored.createQuestionDelivery({
      deliveryAttemptId: 'offline-question-too-early',
      logicalMessageId: 'offline-question',
      executionId: before.runId,
      revision: 1,
      decision: 'chosen',
      payload: 'wait for fresh child and new owner proof',
    }),
    'execution_not_reconciled',
  );
  assertCode(
    () => restored.reconcileHandoff(before.runId, {
      ...request,
      newOwner: { periodId: before.executionBinding.periodId, actor: before.executionBinding.actor },
    }),
    'handoff_id_conflict',
  );

  const recovered = ContractModel.restore(restored.checkpoint());
  assert.equal(recovered.executionMetadata(before.runId).currentOwner.periodId, periodB);
  recovered.reconcileExecution(
    before.runId,
    ownerEvidence(recovered, before.runId, conversationB),
  );
  assertCode(
    () => recovered.createResultDelivery({
      deliveryAttemptId: 'offline-started-result-to-b',
      logicalMessageId: 'offline-started-result',
      executionId: before.runId,
      revision: 1,
      payload: 'unknown result must not replay to B',
    }),
    'duplicate_logical_delivery',
  );
  recovered.createQuestionDelivery({
    deliveryAttemptId: 'offline-question-to-child',
    logicalMessageId: 'offline-question',
    executionId: before.runId,
    revision: 1,
    decision: 'chosen',
    payload: 'restored question remains addressed to C',
  });
  const sent = recovered.sendStart('offline-question-to-child');
  assert.deepEqual(sent.recipient, before.executionBinding);
  assert.equal(sent.routeOwnerGeneration, 1);
  recovered.createResultDelivery({
    deliveryAttemptId: 'offline-new-result-to-b',
    logicalMessageId: 'offline-new-result',
    executionId: before.runId,
    revision: 1,
    payload: 'new result after restored handoff',
  });
  const resultToB = recovered.sendStart('offline-new-result-to-b');
  assert.deepEqual(resultToB.recipient, request.newOwner);
  assert.equal(resultToB.routeOwnerGeneration, 1);
});


test('PR target aliases deduplicate by canonical execution and survive creator or target-owner changes only for that target', () => {
  const model = new ContractModel();
  const conversationA = identity({ nativeId: 'pr-creator-owner' });
  const conversationB = identity({ nativeId: 'pr-target-b' });
  const conversationE = identity({ nativeId: 'pr-target-owner-e' });
  const conversationF = identity({ nativeId: 'pr-target-owner-f' });
  const conversationG = identity({ nativeId: 'pr-target-ended' });
  const periodA = startOwned(model, conversationA, 'proof-pr-a', 'pr-a');
  const periodB = startOwned(model, conversationB, 'proof-pr-b', 'pr-b');
  const periodE = startOwned(model, conversationE, 'proof-pr-e', 'pr-e');
  const periodF = startOwned(model, conversationF, 'proof-pr-f', 'pr-f');
  const periodG = startOwned(model, conversationG, 'proof-pr-g', 'pr-g');
  registerChild(model, 'pr-creator-c', periodA, 'pr-a');
  registerTargetExecution(model, 'pr-target-b-run', periodB, 'pr-b', conversationB);
  registerChild(model, 'pr-target-d-run', periodE, 'pr-e');
  registerTargetExecution(model, 'pr-target-g-run', periodG, 'pr-g', conversationG);
  registerTarget(model, 'b-alias-one', 'pr-target-b-run');
  registerTarget(model, 'b-alias-two', 'pr-target-b-run');
  registerTarget(model, 'd-explicit-target', 'pr-target-d-run');
  registerTarget(model, 'ended-explicit-target', 'pr-target-g-run');

  model.createPrNotification({
    deliveryAttemptId: 'pr-to-b-alias-one',
    logicalMessageId: 'canonical-pr-event',
    executionId: 'pr-creator-c',
    revision: 1,
    targetId: 'b-alias-one',
    payload: 'explicit notification to B',
  });
  assertCode(
    () => model.createPrNotification({
      deliveryAttemptId: 'pr-to-b-alias-two',
      logicalMessageId: 'canonical-pr-event',
      executionId: 'pr-creator-c',
      revision: 1,
      targetId: 'b-alias-two',
      payload: 'alias must not duplicate B',
    }),
    'duplicate_logical_delivery',
  );
  model.createPrNotification({
    deliveryAttemptId: 'pr-to-d',
    logicalMessageId: 'canonical-pr-event',
    executionId: 'pr-creator-c',
    revision: 1,
    targetId: 'd-explicit-target',
    payload: 'same event explicitly to D',
  });
  model.createPrNotification({
    deliveryAttemptId: 'pr-to-ended-g',
    logicalMessageId: 'canonical-pr-event',
    executionId: 'pr-creator-c',
    revision: 1,
    targetId: 'ended-explicit-target',
    payload: 'must remain addressed to ended G',
  });
  const creatorBinding = model.executionMetadata('pr-creator-c').executionBinding;
  model.endPeriod(creatorBinding.periodId);
  assert.equal(model.executionMetadata('pr-creator-c').status, 'ended');

  const sentToB = model.sendStart('pr-to-b-alias-one');
  assert.deepEqual(sentToB.recipient, model.executionMetadata('pr-target-b-run').executionBinding);
  assert.equal(sentToB.payload, 'explicit notification to B');
  const restoredAfterBNotification = ContractModel.restore(model.checkpoint());
  assert.equal(restoredAfterBNotification.deliveryMetadata('pr-to-b-alias-one').status, 'unknown');
  restoredAfterBNotification.reconcileExecution(
    'pr-target-b-run',
    ownerEvidence(restoredAfterBNotification, 'pr-target-b-run', conversationB),
  );
  assertCode(
    () => restoredAfterBNotification.createPrNotification({
      deliveryAttemptId: 'pr-to-b-after-restore-alias-two',
      logicalMessageId: 'canonical-pr-event',
      executionId: 'pr-creator-c',
      revision: 1,
      targetId: 'b-alias-two',
      payload: 'same event remains unknown after restore',
    }),
    'duplicate_logical_delivery',
  );
  model.createPrNotification({
    deliveryAttemptId: 'new-pr-event-after-creator-ended',
    logicalMessageId: 'new-event-after-creator-ended',
    executionId: 'pr-creator-c',
    revision: 1,
    targetId: 'b-alias-two',
    payload: 'new explicit event to the active target',
  });
  assert.equal(model.sendStart('new-pr-event-after-creator-ended').payload, 'new explicit event to the active target');

  const targetD = model.executionMetadata('pr-target-d-run');
  const ownConversationD = locationsFor(model).get(targetD.runId).conversation;
  model.endPeriod(periodE);
  assert.equal(model.executionMetadata(targetD.runId).status, 'active');
  assertCode(() => model.sendStart('pr-to-d'), 'owner_not_active');
  const targetOwnerF = { periodId: periodF, actor: { kind: 'tool-use', id: 'pr-f' } };
  const recovery = {
    handoffId: 'pr-target-owner-recovery',
    expectedOldOwner: targetD.currentOwner,
    expectedOwnerGeneration: 0,
    newOwner: targetOwnerF,
    newOwnerGeneration: 1,
    executionIdentity: {
      launchId: targetD.launchId,
      runId: targetD.runId,
      attemptId: targetD.attemptId,
      provider: targetD.provider,
      origin: targetD.origin,
      purpose: targetD.purpose,
      originBinding: targetD.originBinding,
      executionBinding: targetD.executionBinding,
    },
    executionConnectionGeneration: model.conversationMetadata(ownConversationD).connectionGeneration,
    newOwnerConnectionGeneration: model.conversationMetadata(conversationF).connectionGeneration,
    verified: true,
  };
  model.reconcileHandoff(targetD.runId, recovery);
  const reconnectedD = model.reconnect(ownConversationD);
  model.reconcileConversation(ownConversationD, {
    periodId: targetD.executionBinding.periodId,
    connectionGeneration: reconnectedD.connectionGeneration,
    verified: true,
  });
  assertCode(() => model.sendStart('pr-to-d'), 'execution_not_reconciled');
  model.reconcileExecution(targetD.runId, ownerEvidence(model, targetD.runId, conversationF));
  const sentToD = model.sendStart('pr-to-d');
  assert.deepEqual(sentToD.recipient, targetD.executionBinding);
  assert.equal(sentToD.routeOwnerGeneration, 1);

  model.endPeriod(periodG);
  assert.equal(model.executionMetadata('pr-target-g-run').status, 'ended');
  assert.deepEqual(model.deliveryMetadata('pr-to-ended-g').recipient, {
    periodId: periodG,
    actor: { kind: 'tool-use', id: 'pr-g' },
  });
  assertCode(() => model.sendStart('pr-to-ended-g'), 'execution_ended');
});
