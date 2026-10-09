'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { createQuestionRecord, selectionFor } = require('../src/server/common-question-kernel');
const { createDelivery, createEmptyLedger } = require('../src/server/delivery-ledger');
const { makeEmptyCheckpoint } = require('../src/server/durable-checkpoint');
const {
  encodeQuestionJournalV2Local,
} = require('../src/server/common-question-reclamation-codec');
const {
  encodeCheckpointV3Local,
  encodeInstructionJournalV2Local,
  normalizeInstructionJournalV2Local,
} = require('../src/server/delivery-reclamation-codec');
const {
  MAX_SOURCE_BYTES,
  canClearMigrationAllowance,
} = require('../src/server/reclamation-capacity-bounds');
const { planInitialReclamationMigration } = require('../src/server/reclamation-migration-plan');
const { planMigrationAllowanceRelease } = require('../src/server/migration-allowance-release');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const STARTED_AT = 1_000_000;
const STORE_FIELDS = ['questions', 'checkpoint', 'instructions'];
const ENCODERS = {
  questions: encodeQuestionJournalV2Local,
  checkpoint: encodeCheckpointV3Local,
  instructions: encodeInstructionJournalV2Local,
};

function legacyQuestion() {
  return createQuestionRecord({
    internalQuestionId: 'internal-1',
    questionId: 'public-1',
    identity: {
      provider: 'claude', nativeIdKind: 'session', hostId: 'host-claude',
      homeScopeId: 'home-claude', nativeId: 'native-1',
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

function threeSlotLegacySources() {
  const question = legacyQuestion();
  const selected = selectionFor(question, [{
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
    envelopeDigest: createHash('sha256').update(envelope, 'utf8').digest('hex'),
    nativeContentDigest: createHash('sha256').update(JSON.stringify(input), 'utf8').digest('hex'),
    createdAt: 12_000,
  };
  return {
    checkpoint: Buffer.from(JSON.stringify(checkpoint), 'utf8'),
    instructions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, instructions: [instruction] }), 'utf8'),
    questions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, questions: [selected] }), 'utf8'),
  };
}

function migratedFixture() {
  const sources = threeSlotLegacySources();
  const sourceLimits = Object.fromEntries(STORE_FIELDS.map((slot) => [slot, sources[slot].length]));
  const plan = planInitialReclamationMigration({
    configuredSlots: STORE_FIELDS,
    sourceBytesBySlot: sources,
    normalByteLimitsBySlot: sourceLimits,
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
  });
  assert.equal(plan.outcome, 'migration-prepared');
  for (const slot of STORE_FIELDS) assert.ok(plan.slots[slot].grant, slot);

  const anchor = structuredClone(plan.anchor);
  anchor.revision += 1;
  anchor.migration = null;
  return { anchor, stores: structuredClone(plan.stores), sources };
}

function releaseCandidate(stores, slot) {
  const candidate = structuredClone(stores[slot]);
  candidate.migrationAllowance = null;
  candidate.revision += 1;
  return candidate;
}

function releaseCapacity(stores, slot) {
  return canClearMigrationAllowance({
    slot,
    snapshotWithoutGrant: releaseCandidate(stores, slot),
    normalByteLimit: MAX_SOURCE_BYTES,
  });
}

function limitsFor(stores, slot, limit) {
  return Object.fromEntries(STORE_FIELDS.map((field) => [
    field,
    stores[field] === null ? null : field === slot ? limit : MAX_SOURCE_BYTES,
  ]));
}

function plannerInput(snapshot, slot, limit) {
  return {
    anchor: snapshot.anchor,
    stores: snapshot.stores,
    normalByteLimitsBySlot: limitsFor(snapshot.stores, slot, limit),
    slot,
  };
}

test('a source-derived grant stays when current bytes fit but future reservation exceeds the limit', () => {
  const snapshot = migratedFixture();
  const inputStoresBefore = structuredClone(snapshot.stores);
  for (const slot of STORE_FIELDS) {
    const noGrant = releaseCandidate(snapshot.stores, slot);
    const currentBytes = ENCODERS[slot](noGrant).sizeBytes;
    const capacity = releaseCapacity(snapshot.stores, slot);
    assert.ok(snapshot.stores[slot].migrationAllowance, slot);
    assert.ok(currentBytes <= capacity.reserveBytes, slot);
    assert.ok(capacity.reserveBytes > currentBytes, slot);

    const plan = planMigrationAllowanceRelease(plannerInput(snapshot, slot, currentBytes));
    assert.equal(plan.status, 'retained', slot);
    assert.equal(plan.slot, slot);
    assert.equal(Object.hasOwn(plan, 'snapshot'), false, slot);
  }
  assert.deepEqual(snapshot.stores, inputStoresBefore);
});

test('all three source-derived grants release at the exact future-reservation bound', () => {
  const snapshot = migratedFixture();
  for (const slot of STORE_FIELDS) {
    const inputStoresBefore = structuredClone(snapshot.stores);
    const candidate = releaseCandidate(snapshot.stores, slot);
    const currentBytes = ENCODERS[slot](candidate).sizeBytes;
    const capacity = releaseCapacity(snapshot.stores, slot);
    assert.ok(capacity.reserveBytes > currentBytes, slot);

    const belowBound = planMigrationAllowanceRelease(
      plannerInput(snapshot, slot, capacity.reserveBytes - 1));
    assert.equal(belowBound.status, 'retained', slot);
    assert.equal(belowBound.slot, slot);
    assert.equal(Object.hasOwn(belowBound, 'snapshot'), false, slot);

    const released = planMigrationAllowanceRelease(
      plannerInput(snapshot, slot, capacity.reserveBytes));
    assert.equal(released.status, 'released', slot);
    assert.equal(released.slot, slot);
    assert.deepEqual(released.snapshot.anchor, snapshot.anchor);
    const expectedStores = Object.assign(Object.create(null), structuredClone(snapshot.stores));
    expectedStores[slot].migrationAllowance = null;
    expectedStores[slot].revision += 1;
    assert.deepEqual(released.snapshot.stores, expectedStores, slot);
    assert.deepEqual(snapshot.stores, inputStoresBefore, slot);

    assert.equal(released.snapshot.stores.questions.questions.length,
      snapshot.stores.questions.questions.length, slot);
    assert.equal(released.snapshot.stores.questions.reservations.length,
      snapshot.stores.questions.reservations.length, slot);
    assert.equal(released.snapshot.stores.checkpoint.ledger.revision,
      snapshot.stores.checkpoint.ledger.revision, slot);
    assert.equal(released.snapshot.stores.checkpoint.ledger.deliveries.length,
      snapshot.stores.checkpoint.ledger.deliveries.length, slot);
    assert.deepEqual(released.snapshot.stores.checkpoint.ledger.notificationTargets,
      snapshot.stores.checkpoint.ledger.notificationTargets, slot);
    assert.deepEqual(released.snapshot.stores.checkpoint.ledger.logicalTombstones,
      snapshot.stores.checkpoint.ledger.logicalTombstones, slot);
    assert.equal(released.snapshot.stores.instructions.instructions.length,
      snapshot.stores.instructions.instructions.length, slot);
    for (const otherSlot of STORE_FIELDS) {
      if (otherSlot !== slot) {
        assert.deepEqual(released.snapshot.stores[otherSlot].migrationAllowance,
          snapshot.stores[otherSlot].migrationAllowance, slot);
      }
    }
    assert.notStrictEqual(released.snapshot.anchor, snapshot.anchor);
    assert.notStrictEqual(released.snapshot.stores, snapshot.stores);
    assert.notStrictEqual(released.snapshot.stores[slot], snapshot.stores[slot]);
  }
});

test('a validated store without a grant is a no-op and malformed no-grant state is rejected', () => {
  const empty = planInitialReclamationMigration({
    configuredSlots: STORE_FIELDS,
    sourceBytesBySlot: { questions: null, checkpoint: null, instructions: null },
    normalByteLimitsBySlot: Object.fromEntries(STORE_FIELDS.map((slot) => [slot, MAX_SOURCE_BYTES])),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
  });
  const snapshot = { anchor: empty.anchor, stores: empty.stores };
  const result = planMigrationAllowanceRelease(plannerInput(snapshot, 'checkpoint', MAX_SOURCE_BYTES));
  assert.equal(result.status, 'already_clear');
  assert.equal(result.slot, 'checkpoint');
  assert.equal(Object.hasOwn(result, 'snapshot'), false);

  const malformed = structuredClone(snapshot);
  malformed.stores.instructions.schemaVersion = 1;
  assert.throws(() => planMigrationAllowanceRelease(
    plannerInput(malformed, 'checkpoint', MAX_SOURCE_BYTES)),
  { code: 'invalid_migration_allowance_release' });

  const invalidLimit = plannerInput(snapshot, 'checkpoint', MAX_SOURCE_BYTES);
  invalidLimit.normalByteLimitsBySlot.instructions = null;
  assert.throws(() => planMigrationAllowanceRelease(invalidLimit),
    { code: 'invalid_migration_allowance_release' });
});

test('a migration manifest and an unconfigured slot cannot be treated as releasable state', () => {
  const snapshot = migratedFixture();
  const active = planInitialReclamationMigration({
    configuredSlots: STORE_FIELDS,
    sourceBytesBySlot: snapshot.sources,
    normalByteLimitsBySlot: Object.fromEntries(STORE_FIELDS.map((slot) => [slot, snapshot.sources[slot].length])),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
  });
  const activeSnapshot = { anchor: active.anchor, stores: active.stores };
  assert.throws(() => planMigrationAllowanceRelease(
    plannerInput(activeSnapshot, 'questions', MAX_SOURCE_BYTES)),
  { code: 'invalid_migration_allowance_release' });

  const unconfigured = {
    anchor: snapshot.anchor,
    stores: { questions: null, checkpoint: null, instructions: snapshot.stores.instructions },
  };
  const limits = { questions: null, checkpoint: null, instructions: MAX_SOURCE_BYTES };
  assert.throws(() => planMigrationAllowanceRelease({
    ...unconfigured, normalByteLimitsBySlot: limits, slot: 'questions',
  }), { code: 'invalid_migration_allowance_release' });
});

test('legal creation reconciliation in another slot remains raw in the released snapshot', () => {
  const snapshot = migratedFixture();
  const stores = structuredClone(snapshot.stores);
  stores.instructions.instructions[0].deliveryCreationState = 'creating';
  const inputSnapshot = { anchor: snapshot.anchor, stores };
  const questionCapacity = releaseCapacity(stores, 'questions');

  const released = planMigrationAllowanceRelease(
    plannerInput(inputSnapshot, 'questions', questionCapacity.reserveBytes));
  assert.equal(released.status, 'released');
  assert.equal(released.snapshot.stores.instructions.instructions[0].deliveryCreationState, 'creating');
  assert.deepEqual(released.snapshot.stores.instructions, stores.instructions);
  assert.equal(released.snapshot.stores.instructions.revision, stores.instructions.revision);
  assert.equal(normalizeInstructionJournalV2Local(released.snapshot.stores.instructions)
    .instructions[0].deliveryCreationState, 'creating');
});

test('strict capture rejects accessors, proxies, unknown fields, and wrapper revision overflow', () => {
  const snapshot = migratedFixture();
  let getterCalls = 0;
  const accessorInput = plannerInput(snapshot, 'questions', MAX_SOURCE_BYTES);
  Object.defineProperty(accessorInput, 'slot', {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error('getter must not run');
    },
  });
  assert.throws(() => planMigrationAllowanceRelease(accessorInput),
    { code: 'invalid_migration_allowance_release' });
  assert.equal(getterCalls, 0);

  const proxyAnchor = new Proxy(snapshot.anchor, {
    ownKeys() {
      getterCalls += 1;
      throw new Error('proxy trap must not run');
    },
  });
  assert.throws(() => planMigrationAllowanceRelease({
    ...plannerInput(snapshot, 'questions', MAX_SOURCE_BYTES), anchor: proxyAnchor,
  }), { code: 'invalid_migration_allowance_release' });
  assert.equal(getterCalls, 0);

  const unknown = plannerInput(snapshot, 'questions', MAX_SOURCE_BYTES);
  unknown.extra = true;
  assert.throws(() => planMigrationAllowanceRelease(unknown),
    { code: 'invalid_migration_allowance_release' });

  const overflow = migratedFixture();
  overflow.stores.questions.revision = Number.MAX_SAFE_INTEGER;
  assert.throws(() => planMigrationAllowanceRelease(
    plannerInput(overflow, 'questions', MAX_SOURCE_BYTES)),
  { code: 'invalid_migration_allowance_release' });
});
