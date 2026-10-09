'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { createQuestionRecord } = require('../src/server/common-question-kernel');
const { createDelivery, createEmptyLedger, transitionDelivery } = require('../src/server/delivery-ledger');
const { makeEmptyCheckpoint } = require('../src/server/durable-checkpoint');
const {
  normalizeCheckpointV3Local,
  normalizeInstructionJournalV2Local,
} = require('../src/server/delivery-reclamation-codec');
const {
  projectLegacyReclamationMigrationLocal,
} = require('../src/server/reclamation-migration-projection');
const { validateReclamationStoreWrite } = require('../src/server/reclamation-store-consistency');
const { planInstructionBodyReclamation } = require('../src/server/instruction-body-reclamation');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const STARTED_AT = 1_000_000;
const RETENTION_MS = 604_800_000;
const MAX_BYTES = 16_777_216;
const LIMITS = { questions: null, checkpoint: MAX_BYTES, instructions: MAX_BYTES };

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sourceQuestion(provider = 'claude') {
  return createQuestionRecord({
    internalQuestionId: 'internal-fixture',
    questionId: 'public-fixture',
    identity: {
      provider,
      nativeIdKind: provider === 'claude' ? 'session' : 'thread',
      hostId: 'host-fixture',
      homeScopeId: 'home-fixture',
      nativeId: 'native-fixture',
    },
    periodId: 'execution-fixture',
    executionId: 'execution-fixture',
    conversationId: 'conversation-fixture',
    launchRef: 'launch-fixture',
    executionBinding: { periodId: 'execution-fixture', actor: { kind: 'agent', id: 'actor-fixture' } },
    category: 'ordinary',
    questions: [{
      id: 'question-fixture', text: 'Choose one', mode: 'single',
      options: [{ id: 'option-fixture', label: 'Option', description: '' }],
      allowFreeText: true, recommendedOptionId: 'option-fixture',
    }],
    timeoutMinutes: 1,
    createdAt: 10,
  });
}

function launchFor(question) {
  return {
    launchRef: question.launchRef,
    launchId: 'launch-id-fixture',
    runId: 'run-id-fixture',
    attemptId: 'launch-attempt-fixture',
    provider: question.identity.provider,
    nativeIdKind: question.identity.nativeIdKind,
    hostId: question.identity.hostId,
    homeScopeId: question.identity.homeScopeId,
    origin: 'standalone',
    purpose: 'agent',
    originBinding: null,
    state: 'bound',
    identity: question.identity,
    executionBinding: question.executionBinding,
    conversationId: question.conversationId,
    sessionId: 'session-fixture',
    currentOwner: question.executionBinding,
    ownerGeneration: 0,
  };
}

function legacyCheckpoint(launch, ledger) {
  const checkpoint = structuredClone(makeEmptyCheckpoint());
  checkpoint.schemaVersion = 2;
  checkpoint.revision = 9;
  checkpoint.ledger = structuredClone(ledger);
  checkpoint.ledger.revision = 11;
  const claims = {
    launchId: launch.launchId,
    runId: launch.runId,
    attemptId: launch.attemptId,
    provider: launch.provider,
    nativeIdKind: launch.nativeIdKind,
    hostId: launch.hostId,
    homeScopeId: launch.homeScopeId,
    origin: launch.origin,
    purpose: launch.purpose,
    originBinding: launch.originBinding,
  };
  const immutableExecutionClaims = {
    ...claims,
    identity: launch.identity,
    executionBinding: launch.executionBinding,
  };
  const scope = {
    provider: launch.provider,
    nativeIdKind: launch.nativeIdKind,
    hostId: launch.hostId,
    homeScopeId: launch.homeScopeId,
    connectionSlotId: 'source-slot',
  };
  checkpoint.registrations.conversations = [{
    conversationId: launch.conversationId,
    identity: launch.identity,
  }];
  checkpoint.registrations.executions = [{
    conversationId: launch.conversationId,
    executionId: launch.executionBinding.periodId,
    sessionId: launch.sessionId,
    state: 'active',
  }];
  checkpoint.registrations.launches = [{
    launchRef: launch.launchRef,
    claims,
    state: 'bound',
    identity: launch.identity,
    executionBinding: launch.executionBinding,
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
  }];
  checkpoint.registrations.runtimeLaunches = [{
    launchRef: launch.launchRef,
    claims: immutableExecutionClaims,
    state: 'bound',
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
    currentOwner: launch.executionBinding,
    ownerGeneration: 0,
  }];
  checkpoint.registrations.connections = [{ scope, generation: 1, state: 'active' }];
  checkpoint.registrations.actors = [{
    identity: launch.identity,
    periodId: launch.executionBinding.periodId,
    actor: launch.executionBinding.actor,
    contextId: 'source-context-fixture',
    launchRef: launch.launchRef,
    immutableExecutionClaims,
    connectionScope: scope,
    connectionGeneration: 1,
    state: 'active',
  }];
  checkpoint.registrations.incompleteConversationIds = [launch.conversationId];
  return checkpoint;
}

function applyDeliveryState(ledger, state) {
  const attemptId = 'instruction-attempt-fixture';
  if (state === 'available') return ledger;
  if (state === 'claimed') return transitionDelivery(ledger, attemptId, 'claim').ledger;
  if (state === 'cancelled_before_send') return transitionDelivery(ledger, attemptId, 'cancel').ledger;
  if (state === 'superseded_before_send') return transitionDelivery(ledger, attemptId, 'supersede').ledger;
  let current = transitionDelivery(ledger, attemptId, 'sendStart').ledger;
  if (state === 'sending') return current;
  const original = current.deliveries[0];
  const correlation = {
    deliveryAttemptId: attemptId,
    revision: original.revision,
    payloadDigest: original.payloadDigest,
    targetPeriodId: original.target.periodId,
    nativeTurnId: state === 'applied' ? 'turn-fixture' : null,
    nativeItemId: state === 'applied' ? 'item-fixture' : null,
    clientRequestId: attemptId,
  };
  if (state === 'accepted') return transitionDelivery(current, attemptId, 'accepted', correlation).ledger;
  if (state === 'unknown') return transitionDelivery(current, attemptId, 'unknown').ledger;
  if (state === 'applied') return transitionDelivery(current, attemptId, 'applied', correlation).ledger;
  throw new Error(`unsupported state ${state}`);
}

function createSnapshot({ provider = 'claude', state = 'applied', terminalAt = STARTED_AT } = {}) {
  const question = sourceQuestion(provider);
  const launch = launchFor(question);
  const input = [{ type: 'text', text: 'instruction fixture body', text_elements: [] }];
  const envelope = JSON.stringify({ schemaVersion: 1, mode: 'start', expectedTurnId: null, input });
  const rawLedger = createDelivery(createEmptyLedger(), 'instruction', {
    deliveryAttemptId: 'instruction-attempt-fixture',
    logicalMessageId: 'instruction-logical-fixture',
    revision: 2,
    payload: envelope,
  }, launch).ledger;
  const ledger = applyDeliveryState(rawLedger, state);
  const checkpoint = legacyCheckpoint(launch, ledger);
  const instruction = {
    deliveryAttemptId: 'instruction-attempt-fixture',
    launchRef: launch.launchRef,
    logicalMessageId: 'instruction-logical-fixture',
    revision: 2,
    source: ledger.deliveries[0].source,
    envelope,
    envelopeDigest: sha256(envelope),
    nativeContentDigest: sha256(JSON.stringify(input)),
    createdAt: 20,
  };
  const sourceBytesBySlot = {
    checkpoint: Buffer.from(JSON.stringify(checkpoint), 'utf8'),
    instructions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, instructions: [instruction] }), 'utf8'),
  };
  const projection = projectLegacyReclamationMigrationLocal({
    configuredSlots: ['checkpoint', 'instructions'],
    sourceBytesBySlot,
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: terminalAt,
    migrationAllowanceBySlot: { checkpoint: null, instructions: null },
  });
  const snapshot = {
    anchor: {
      schemaVersion: 1,
      revision: 0,
      storeId: STORE_ID,
      retiredQuestionPeriods: [],
      migration: null,
    },
    stores: {
      questions: null,
      checkpoint: projection.slots.checkpoint.target.snapshot,
      instructions: projection.slots.instructions.target.snapshot,
    },
  };
  const checked = validateReclamationStoreWrite({
    anchor: snapshot.anchor,
    previousStores: snapshot.stores,
    nextStores: snapshot.stores,
    normalByteLimitsBySlot: LIMITS,
  });
  assert.deepEqual(checked.reasons, []);
  return { anchor: checked.snapshot.anchor, stores: checked.snapshot.stores };
}

function plan(snapshot, now, options = {}) {
  return planInstructionBodyReclamation({
    anchor: snapshot.anchor,
    stores: snapshot.stores,
    normalByteLimitsBySlot: LIMITS,
    deliveryAttemptId: 'instruction-attempt-fixture',
    now,
    ...options,
  });
}

function addUnrelatedCreatingInstruction(snapshot) {
  const journal = structuredClone(snapshot.stores.instructions);
  const other = structuredClone(journal.instructions[0]);
  other.deliveryAttemptId = 'unrelated-creating-attempt';
  other.logicalMessageId = 'unrelated-creating-logical';
  other.deliveryCreationState = 'creating';
  other.reclamation = null;
  journal.instructions.push(other);
  snapshot.stores.instructions = normalizeInstructionJournalV2Local(journal);
  return other;
}

test('terminal delivery body reclamation observes the exact seven-day boundary for both providers', () => {
  for (const provider of ['claude', 'codex']) {
    for (const state of ['applied', 'cancelled_before_send', 'superseded_before_send']) {
      const terminalAt = STARTED_AT + 100;
      const current = createSnapshot({ provider, state, terminalAt });
      const deadlineAt = terminalAt + RETENTION_MS;
      const before = plan(current, deadlineAt - 1);
      assert.equal(before.status, 'deferred');
      assert.equal(before.deferredReason, 'retention_not_elapsed');
      assert.equal(before.steps.length, 0);

      const eligible = plan(current, deadlineAt);
      assert.equal(eligible.status, 'eligible');
      assert.equal(eligible.deadlineAt, deadlineAt);
      assert.equal(eligible.steps.length, 0);

      const planned = plan(current, deadlineAt, { operationId: OPERATION_ID });
      assert.equal(planned.status, 'planned');
      assert.equal(planned.steps.map((step) => step.boundary).join(','),
        'prepare,checkpoint-grave,reclaim');
      assert.equal(planned.steps[0].snapshot.stores.instructions.instructions[0].reclamation.operationId,
        OPERATION_ID);
      assert.equal(planned.steps[1].snapshot.stores.checkpoint.ledger.deliveries[0].reclamation.reason,
        'terminal_retention');
      assert.equal(planned.steps[2].snapshot.stores.instructions.instructions[0].recordType, 'reclaimed');
      assert.equal(planned.steps[2].snapshot.stores.instructions.instructions[0].envelope, undefined);
      assert.equal(planned.steps[2].snapshot.stores.instructions.instructions[0].reclaimedAt, deadlineAt);
    }
  }
});

test('nonterminal checkpoint states remain unchanged and are not reclaimed', () => {
  for (const state of ['available', 'claimed', 'sending', 'accepted', 'unknown']) {
    const current = createSnapshot({ state });
    const original = structuredClone(current);
    const result = plan(current, STARTED_AT + RETENTION_MS, { operationId: OPERATION_ID });
    assert.equal(result.status, 'deferred', state);
    assert.equal(result.deferredReason, 'not_reclaimable', state);
    assert.equal(result.steps.length, 0, state);
      assert.equal(JSON.stringify(current), JSON.stringify(original), state);
  }
});

test('prepared journal resumes the same operation through grave and reclaim boundaries', () => {
  const current = createSnapshot();
  const deadline = STARTED_AT + RETENTION_MS;
  const first = plan(current, deadline, { operationId: OPERATION_ID });
  const resumedDetail = plan(first.steps[0].snapshot, deadline + 10);
  assert.equal(resumedDetail.status, 'planned');
  assert.equal(resumedDetail.operationId, OPERATION_ID);
  assert.deepEqual(resumedDetail.steps.map((step) => step.boundary), ['checkpoint-grave', 'reclaim']);

  const resumedGrave = plan(first.steps[1].snapshot, deadline + 20, { operationId: OPERATION_ID });
  assert.equal(resumedGrave.status, 'planned');
  assert.deepEqual(resumedGrave.steps.map((step) => step.boundary), ['reclaim']);
  const complete = plan(first.steps[2].snapshot, 0);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.steps.length, 0);

  const rolledBack = plan(first.steps[0].snapshot, deadline - 1);
  assert.equal(rolledBack.status, 'deferred');
  assert.equal(rolledBack.deferredReason, 'clock_before_prepared_at');
  assert.equal(rolledBack.operationId, OPERATION_ID);
});

test('reclamation preserves unrelated records and interrupted instruction creation', () => {
  const current = createSnapshot();
  const unrelated = addUnrelatedCreatingInstruction(current);
  const originalLedger = structuredClone(current.stores.checkpoint.ledger);
  const planned = plan(current, STARTED_AT + RETENTION_MS, { operationId: OPERATION_ID });
  assert.equal(planned.status, 'planned');
  for (const step of planned.steps) {
    const other = step.snapshot.stores.instructions.instructions.find((item) =>
      item.deliveryAttemptId === unrelated.deliveryAttemptId);
    assert.equal(other.deliveryCreationState, 'creating');
    assert.equal(other.logicalMessageId, unrelated.logicalMessageId);
    assert.equal(step.snapshot.stores.checkpoint.ledger.deliveries.length, originalLedger.deliveries.length);
    assert.equal(step.snapshot.stores.checkpoint.ledger.logicalTombstones.length,
      originalLedger.logicalTombstones.length);
  }
});

test('overflow, impossible correlation, and malformed accessors fail closed', () => {
  const overflow = createSnapshot({ terminalAt: Number.MAX_SAFE_INTEGER - RETENTION_MS + 1 });
  const overflowResult = plan(overflow, Number.MAX_SAFE_INTEGER, { operationId: OPERATION_ID });
  assert.equal(overflowResult.status, 'deferred');
  assert.equal(overflowResult.deferredReason, 'retention_deadline_overflow');

  const mismatch = createSnapshot();
  const checkpoint = structuredClone(mismatch.stores.checkpoint);
  checkpoint.ledger.deliveries[0].payloadDigest = 'b'.repeat(64);
  checkpoint.ledger.deliveries[0].appliedCorrelation.payloadDigest = 'b'.repeat(64);
  checkpoint.ledger.logicalTombstones[0].payloadDigest = 'b'.repeat(64);
  mismatch.stores.checkpoint = normalizeCheckpointV3Local(checkpoint);
  assert.throws(() => plan(mismatch, STARTED_AT + RETENTION_MS, { operationId: OPERATION_ID }),
    { code: 'invalid_instruction_body_reclamation' });

  let getterCalls = 0;
  const hostile = {
    anchor: createSnapshot().anchor,
    stores: createSnapshot().stores,
    normalByteLimitsBySlot: LIMITS,
    deliveryAttemptId: 'instruction-attempt-fixture',
    now: STARTED_AT + RETENTION_MS,
  };
  Object.defineProperty(hostile, 'operationId', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('getter'); },
  });
  assert.throws(() => planInstructionBodyReclamation(hostile), TypeError);
  assert.equal(getterCalls, 0);

  const base = createSnapshot();
  const ownToJson = {
    anchor: base.anchor,
    stores: base.stores,
    normalByteLimitsBySlot: LIMITS,
    deliveryAttemptId: 'instruction-attempt-fixture',
    now: STARTED_AT + RETENTION_MS,
  };
  Object.defineProperty(ownToJson, 'toJSON', {
    enumerable: true,
    value() { getterCalls += 1; throw new Error('toJSON'); },
  });
  assert.throws(() => planInstructionBodyReclamation(ownToJson), TypeError);
  assert.equal(getterCalls, 0);
});

test('inherited toJSON methods are never invoked while validating a plan', () => {
  const current = createSnapshot();
  const input = {
    anchor: current.anchor,
    stores: current.stores,
    normalByteLimitsBySlot: LIMITS,
    deliveryAttemptId: 'instruction-attempt-fixture',
    now: STARTED_AT + RETENTION_MS,
    operationId: OPERATION_ID,
  };
  const objectToJson = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayToJson = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let calls = 0;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value() { calls += 1; throw new Error('object toJSON'); },
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      value() { calls += 1; throw new Error('array toJSON'); },
    });
    const result = planInstructionBodyReclamation(input);
    assert.equal(result.status, 'planned');
    assert.equal(calls, 0);
  } finally {
    if (objectToJson === undefined) delete Object.prototype.toJSON;
    else Object.defineProperty(Object.prototype, 'toJSON', objectToJson);
    if (arrayToJson === undefined) delete Array.prototype.toJSON;
    else Object.defineProperty(Array.prototype, 'toJSON', arrayToJson);
  }
});

test('prepared snapshots reject changed operation ids and retain input immutability', () => {
  const current = createSnapshot();
  const original = structuredClone(current);
  const first = plan(current, STARTED_AT + RETENTION_MS, { operationId: OPERATION_ID });
  assert.equal(JSON.stringify(current), JSON.stringify(original));
  assert.throws(() => plan(first.steps[0].snapshot, STARTED_AT + RETENTION_MS + 1, {
    operationId: '33333333-3333-4333-8333-333333333333',
  }), { code: 'invalid_instruction_body_reclamation' });
});
