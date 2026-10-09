'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { createQuestionRecord, selectionFor } = require('../src/server/common-question-kernel');
const { createDelivery, createEmptyLedger } = require('../src/server/delivery-ledger');
const { makeEmptyCheckpoint } = require('../src/server/durable-checkpoint');
const {
  createEmptyQuestionJournalV2TargetLocal,
} = require('../src/server/reclamation-migration-projection');
const {
  FIXED_ANCHOR_MIGRATION_BOUNDS,
  FIXED_H_BOUNDS,
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
} = require('../src/server/reclamation-capacity-bounds');
const { planInitialReclamationMigration } = require('../src/server/reclamation-migration-plan');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const STARTED_AT = 1_000_000;

function legacyQuestion(provider = 'claude') {
  return createQuestionRecord({
    internalQuestionId: 'internal-1',
    questionId: 'public-1',
    identity: {
      provider, nativeIdKind: provider === 'claude' ? 'session' : 'thread',
      hostId: `host-${provider}`, homeScopeId: `home-${provider}`, nativeId: 'native-1',
    },
    periodId: 'period-1',
    executionId: 'execution-1',
    conversationId: 'conversation-1',
    launchRef: 'launch-1',
    executionBinding: { periodId: 'period-1', actor: { kind: 'agent', id: 'actor-1' } },
    category: 'ordinary',
    questions: [{
      id: 'question-1', text: 'Choose one', mode: 'single',
      options: [{ id: 'option-1', label: 'First', description: '' }],
      allowFreeText: true, recommendedOptionId: 'option-1',
    }],
    timeoutMinutes: 1,
    createdAt: 10_000,
  });
}

function questionSource(record = legacyQuestion()) {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 3, questions: [record] }), 'utf8');
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function legacyCheckpointWithLaunch(launch, ledger) {
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
    launchRef: launch.launchRef, claims, state: 'bound', identity: launch.identity,
    executionBinding: launch.executionBinding, conversationId: launch.conversationId,
    sessionId: launch.sessionId,
  }];
  checkpoint.registrations.runtimeLaunches = [{
    launchRef: launch.launchRef, claims: immutableExecutionClaims, state: 'bound',
    conversationId: launch.conversationId, sessionId: launch.sessionId,
    currentOwner: launch.executionBinding, ownerGeneration: 0,
  }];
  checkpoint.registrations.connections = [{ scope, generation: 1, state: 'active' }];
  checkpoint.registrations.actors = [{
    identity: launch.identity, periodId: launch.executionBinding.periodId,
    actor: launch.executionBinding.actor, contextId: 'source-context', launchRef: launch.launchRef,
    immutableExecutionClaims, connectionScope: scope, connectionGeneration: 1, state: 'active',
  }];
  checkpoint.registrations.incompleteConversationIds = [launch.conversationId];
  return checkpoint;
}

function threeSlotLegacySources(provider) {
  const selected = selectionFor(legacyQuestion(provider), [{
    questionId: 'question-1', optionIds: ['option-1'], freeText: null,
  }], 'manual', 11_000, 'selection-1').record;
  const launch = {
    launchRef: selected.launchRef,
    launchId: 'launch-id', runId: 'run-id', attemptId: 'attempt-id',
    provider: selected.identity.provider,
    nativeIdKind: selected.identity.nativeIdKind,
    hostId: selected.identity.hostId,
    homeScopeId: selected.identity.homeScopeId,
    origin: 'standalone', purpose: 'agent', originBinding: null, state: 'bound',
    identity: selected.identity,
    executionBinding: selected.executionBinding,
    conversationId: selected.conversationId,
    sessionId: 'session-1',
    currentOwner: selected.executionBinding,
    ownerGeneration: 0,
  };
  const questionPayload = JSON.stringify({
    questionId: selected.questionId,
    revision: selected.deliveryIntent.revision,
    answers: selected.selection.answers,
  });
  const questionLedger = createDelivery(createEmptyLedger(), 'question', {
    deliveryAttemptId: selected.deliveryIntent.deliveryAttemptId,
    logicalMessageId: selected.deliveryIntent.logicalMessageId,
    revision: selected.deliveryIntent.revision,
    payload: questionPayload,
  }, launch).ledger;

  const input = [{ type: 'text', text: 'instruction-payload', text_elements: [] }];
  const envelope = JSON.stringify({
    schemaVersion: 1, mode: 'start', expectedTurnId: null, input,
  });
  const combinedLedger = createDelivery(questionLedger, 'instruction', {
    deliveryAttemptId: 'attempt-instruction',
    logicalMessageId: 'logical-instruction',
    revision: 3,
    payload: envelope,
  }, launch).ledger;
  const checkpoint = legacyCheckpointWithLaunch(launch, combinedLedger);
  const instructionDelivery = combinedLedger.deliveries.find((delivery) => delivery.kind === 'instruction');
  const instruction = {
    deliveryAttemptId: instructionDelivery.deliveryAttemptId,
    launchRef: instructionDelivery.source.launchRef,
    logicalMessageId: instructionDelivery.logicalMessageId,
    revision: instructionDelivery.revision,
    source: instructionDelivery.source,
    envelope,
    envelopeDigest: sha256(envelope),
    nativeContentDigest: sha256(JSON.stringify(input)),
    createdAt: 12_000,
  };
  return {
    checkpoint: Buffer.from(JSON.stringify(checkpoint), 'utf8'),
    instructions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, instructions: [instruction] }), 'utf8'),
    questions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, questions: [selected] }), 'utf8'),
  };
}

function planInput({
  slots = ['questions'],
  sources = { questions: null },
  limits = { questions: MAX_SOURCE_BYTES },
  ...overrides
} = {}) {
  return {
    configuredSlots: slots,
    sourceBytesBySlot: sources,
    normalByteLimitsBySlot: limits,
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    ...overrides,
  };
}

test('all configured stores absent produce empty schema targets without a migration manifest', () => {
  const plan = planInitialReclamationMigration(planInput({
    slots: ['questions', 'instructions', 'checkpoint'],
    sources: { questions: null, instructions: null, checkpoint: null },
    limits: { questions: MAX_SOURCE_BYTES, instructions: MAX_SOURCE_BYTES, checkpoint: MAX_SOURCE_BYTES },
  }));

  assert.equal(plan.outcome, 'initial-create');
  assert.equal(plan.operationId, null);
  assert.equal(plan.anchor.migration, null);
  assert.equal(plan.anchor.revision, 0);
  assert.equal(plan.crossStoreValidation.status, 'ready');
  assert.deepEqual(plan.crossStoreValidation.reasons, []);
  assert.equal(plan.physicalBounds, null);
  assert.equal(plan.anchorEncoded.sizeBytes <= NORMAL_ANCHOR_MAX_BYTES, true);
  for (const slot of ['questions', 'checkpoint', 'instructions']) {
    assert.equal(plan.stores[slot].storeId, STORE_ID);
    assert.equal(plan.stores[slot].revision, 0);
    assert.equal(plan.slots[slot].grant, null);
    assert.equal(plan.slots[slot].target.sizeBytes <= MAX_SOURCE_BYTES, true);
  }
});

test('a source-bound plan computes a fixed grant and validates the final prepared target', () => {
  const source = questionSource();
  const plan = planInitialReclamationMigration(planInput({
    sources: { questions: source },
    limits: { questions: source.length },
  }));
  const slot = plan.slots.questions;
  const grant = slot.grant;

  assert.equal(plan.outcome, 'migration-prepared');
  assert.equal(plan.anchor.migration.phase, 'prepared');
  assert.equal(plan.crossStoreValidation.status, 'reconciliation-required');
  assert.deepEqual(plan.crossStoreValidation.reasons, ['migration_in_progress']);
  assert.equal(slot.source.sizeBytes, source.length);
  assert.equal(slot.source.sha256.length, 64);
  assert.deepEqual(grant.eligibleQuestionIds, ['internal-1']);
  assert.ok(grant.maxExtraBytes > 0);
  assert.ok(grant.maxExtraBytes <= FIXED_H_BOUNDS.questions);
  assert.ok(slot.target.sizeBytes <= slot.source.sizeBytes + grant.maxExtraBytes);
  assert.ok(slot.target.sizeBytes <= source.length + grant.maxExtraBytes);
  assert.ok(plan.migrationAnchorBytes <= plan.migrationAnchorMaxBytes);
  assert.ok(plan.normalAnchorMaxRevisionBytes <= NORMAL_ANCHOR_MAX_BYTES);
  assert.ok(plan.physicalBounds.firstMigrationPeakBytes > 0);
  assert.ok(plan.physicalBounds.postMigrationPeakBytes > 0);
  assert.equal(plan.anchor.migration.sources[0].targetSizeBytes, slot.target.sizeBytes);
  assert.equal(plan.anchor.migration.sources[0].targetSha256, slot.target.sha256);
});

test('a source whose future reservation fits its normal limit needs no grant', () => {
  const source = questionSource();
  const plan = planInitialReclamationMigration(planInput({
    sources: { questions: source },
    limits: { questions: MAX_SOURCE_BYTES },
  }));

  assert.equal(plan.slots.questions.grant, null);
  assert.ok(plan.slots.questions.target.sizeBytes <= MAX_SOURCE_BYTES);
  assert.equal(plan.physicalBounds.firstMigrationPeakBytes > 0, true);
});

test('a selected legacy question without a checkpoint becomes indeterminate, not uncreated', () => {
  const created = legacyQuestion();
  const selected = selectionFor(created, [{
    questionId: 'question-1', optionIds: ['option-1'], freeText: null,
  }], 'manual', created.createdAt + 1_000, 'selection-1').record;
  const plan = planInitialReclamationMigration(planInput({
    sources: { questions: questionSource(selected) },
    limits: { questions: MAX_SOURCE_BYTES },
  }));

  assert.equal(plan.slots.questions.target.snapshot.questions[0].deliveryCreationState, 'indeterminate');
  assert.equal(plan.anchor.migration.targets[0].deliveryPresence, 'indeterminate');
  assert.equal(plan.stores.checkpoint, null);
});

test('source bytes must fit the current limit before a migration grant can be measured', () => {
  const source = questionSource();
  assert.throws(() => planInitialReclamationMigration(planInput({
    sources: { questions: source },
    limits: { questions: source.length - 1 },
  })), TypeError);
});

test('the plan rejects an existing new-schema slot when no anchor is supplied', () => {
  const target = createEmptyQuestionJournalV2TargetLocal({ storeId: STORE_ID });
  assert.throws(() => planInitialReclamationMigration(planInput({
    sources: { questions: target.encoded.bytes },
  })), TypeError);
});

test('strict input capture rejects accessors and invalid slot limit shapes without invoking getters', () => {
  let getterCalls = 0;
  const input = planInput();
  Object.defineProperty(input, 'startedAt', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('getter must not run');
    },
  });
  assert.throws(() => planInitialReclamationMigration(input), TypeError);
  assert.equal(getterCalls, 0);

  assert.throws(() => planInitialReclamationMigration(planInput({
    slots: ['questions', 'questions'],
    sources: { questions: null },
    limits: { questions: MAX_SOURCE_BYTES },
  })), TypeError);
  assert.throws(() => planInitialReclamationMigration(planInput({
    sources: { questions: null },
    limits: { questions: MAX_SOURCE_BYTES, instructions: MAX_SOURCE_BYTES },
  })), TypeError);
});

test('source byte views are copied through typed-array intrinsics and left unchanged', () => {
  const source = questionSource();
  const original = Buffer.from(source);
  let getterCalls = 0;
  Object.defineProperty(source, 'buffer', {
    configurable: true,
    get() {
      getterCalls += 1;
      throw new Error('typed-array getter must not run');
    },
  });
  const plan = planInitialReclamationMigration(planInput({
    sources: { questions: source },
    limits: { questions: MAX_SOURCE_BYTES },
  }));

  assert.equal(getterCalls, 0);
  assert.equal(source.length, original.length);
  for (let index = 0; index < original.length; index += 1) {
    assert.equal(source[index], original[index]);
  }
  assert.equal(plan.slots.questions.source.sizeBytes, original.length);
});

test('three legacy stores preserve question and instruction deliveries for both providers with and without grants', () => {
  const configuredSlots = ['questions', 'checkpoint', 'instructions'];
  for (const provider of ['claude', 'codex']) {
    const sourceBytesBySlot = threeSlotLegacySources(provider);
    const noGrant = planInitialReclamationMigration(planInput({
      slots: configuredSlots,
      sources: sourceBytesBySlot,
      limits: {
        questions: MAX_SOURCE_BYTES,
        checkpoint: MAX_SOURCE_BYTES,
        instructions: MAX_SOURCE_BYTES,
      },
    }));

    assert.equal(noGrant.outcome, 'migration-prepared');
    assert.equal(noGrant.crossStoreValidation.status, 'reconciliation-required');
    assert.deepEqual(noGrant.crossStoreValidation.reasons, ['migration_in_progress']);
    assert.equal(noGrant.stores.questions.questions.length, 1);
    assert.equal(noGrant.stores.checkpoint.ledger.deliveries.length, 2);
    assert.equal(noGrant.stores.instructions.instructions.length, 1);
    for (const slot of configuredSlots) assert.equal(noGrant.slots[slot].grant, null);

    const sourceSizedLimits = Object.fromEntries(configuredSlots.map((slot) => [
      slot,
      sourceBytesBySlot[slot].length,
    ]));
    const withGrants = planInitialReclamationMigration(planInput({
      slots: configuredSlots,
      sources: sourceBytesBySlot,
      limits: sourceSizedLimits,
    }));

    assert.equal(withGrants.outcome, 'migration-prepared');
    assert.equal(withGrants.crossStoreValidation.status, 'reconciliation-required');
    assert.deepEqual(withGrants.crossStoreValidation.reasons, ['migration_in_progress']);
    assert.equal(withGrants.stores.questions.questions.length, 1);
    assert.equal(withGrants.stores.checkpoint.ledger.deliveries.length, 2);
    assert.equal(withGrants.stores.instructions.instructions.length, 1);
    for (const slot of configuredSlots) {
      assert.equal(withGrants.slots[slot].source.sizeBytes, sourceBytesBySlot[slot].length);
      assert.ok(withGrants.slots[slot].grant);
      assert.ok(withGrants.slots[slot].grant.maxExtraBytes > 0);
    }
  }
});
