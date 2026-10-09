'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { createQuestionRecord, selectionFor } = require('../src/server/common-question-kernel');
const { createDelivery, createEmptyLedger, transitionDelivery } = require('../src/server/delivery-ledger');
const { makeEmptyCheckpoint } = require('../src/server/durable-checkpoint');
const { normalizeQuestionJournalV2Local } = require('../src/server/common-question-reclamation-codec');
const {
  encodeInstructionJournalV2Local,
  normalizeCheckpointV3Local,
  normalizeInstructionJournalV2Local,
  normalizeInstructionRecordV2Local,
} = require('../src/server/delivery-reclamation-codec');
const {
  createEmptyCheckpointV3TargetLocal,
  createEmptyQuestionJournalV2TargetLocal,
  projectLegacyReclamationMigrationLocal,
} = require('../src/server/reclamation-migration-projection');
const {
  validateReclamationSnapshot,
  validateReclamationStoreWrite,
} = require('../src/server/reclamation-store-consistency');
const { planQuestionPeriodRetirement } = require('../src/server/question-period-retirement');
const { planQuestionBodyReclamation } = require('../src/server/question-body-reclamation');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const STARTED_AT = 1_000_000;
const RETIRED_AT = 1_100_000;
const RETENTION_MS = 604_800_000;
const LIMITS_WITH_CHECKPOINT = { questions: 16_777_216, checkpoint: 16_777_216, instructions: null };
const LIMITS_WITH_ALL_STORES = { questions: 16_777_216, checkpoint: 16_777_216, instructions: 16_777_216 };
const LIMITS_QUESTIONS_ONLY = { questions: 16_777_216, checkpoint: null, instructions: null };

function legacyQuestion(provider = 'claude', selected = true, suffix = '1') {
  const identity = provider === 'codex'
    ? { provider, nativeIdKind: 'thread', hostId: 'host-1', homeScopeId: 'home-1', nativeId: 'native-1' }
    : { provider, nativeIdKind: 'session', hostId: 'host-1', homeScopeId: 'home-1', nativeId: 'native-1' };
  const question = createQuestionRecord({
    internalQuestionId: `internal-${suffix}`,
    questionId: `public-${suffix}`,
    identity,
    periodId: `period-${suffix}`,
    executionId: `execution-${suffix}`,
    conversationId: 'conversation-1',
    launchRef: `launch-${suffix}`,
    executionBinding: { periodId: `period-${suffix}`, actor: { kind: 'agent', id: `actor-${suffix}` } },
    category: 'ordinary',
    questions: [{
      id: `q-${suffix}`, text: 'Choose one', mode: 'single',
      options: [{ id: `option-${suffix}`, label: 'First', description: '' }],
      allowFreeText: true, recommendedOptionId: `option-${suffix}`,
    }],
    timeoutMinutes: 1,
    createdAt: 10_000,
  });
  if (!selected) return question;
  return selectionFor(question, [{ questionId: `q-${suffix}`, optionIds: [`option-${suffix}`], freeText: null }],
    'manual', 11_000, `selection-${suffix}`).record;
}

function launchForQuestion(question) {
  const suffix = question.internalQuestionId.slice('internal-'.length);
  return {
    launchRef: question.launchRef,
    launchId: suffix === '1' ? 'launch-id' : `launch-id-${suffix}`,
    runId: suffix === '1' ? 'run-id' : `run-id-${suffix}`,
    attemptId: suffix === '1' ? 'attempt-id' : `attempt-id-${suffix}`,
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
    sessionId: `session-${suffix}`,
    currentOwner: question.executionBinding,
    ownerGeneration: 0,
  };
}

function legacyCheckpoint(question, deliveryState = 'available') {
  const launch = launchForQuestion(question);
  const payload = JSON.stringify({
    questionId: question.questionId,
    revision: question.deliveryIntent.revision,
    answers: question.selection.answers,
  });
  let ledger = createDelivery(createEmptyLedger(), 'question', {
    deliveryAttemptId: question.deliveryIntent.deliveryAttemptId,
    logicalMessageId: question.deliveryIntent.logicalMessageId,
    revision: question.deliveryIntent.revision,
    payload,
  }, launch).ledger;
  if (deliveryState === 'unknown' || deliveryState === 'applied') {
    ledger = transitionDelivery(ledger, question.deliveryIntent.deliveryAttemptId, 'sendStart').ledger;
  }
  if (deliveryState === 'applied') {
    const delivery = ledger.deliveries[0];
    ledger = transitionDelivery(ledger, question.deliveryIntent.deliveryAttemptId, 'applied', {
      deliveryAttemptId: delivery.deliveryAttemptId,
      revision: delivery.revision,
      payloadDigest: delivery.payloadDigest,
      targetPeriodId: delivery.target.periodId,
      nativeTurnId: 'turn-1',
      nativeItemId: 'item-1',
      clientRequestId: delivery.deliveryAttemptId,
    }).ledger;
  }

  const checkpoint = structuredClone(makeEmptyCheckpoint());
  checkpoint.schemaVersion = 2;
  checkpoint.revision = 9;
  checkpoint.ledger = structuredClone(ledger);
  checkpoint.ledger.revision += 10;
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
  checkpoint.registrations.conversations = [{ conversationId: launch.conversationId, identity: launch.identity }];
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
    actor: launch.executionBinding.actor,
    contextId: `source-context-${question.internalQuestionId.slice('internal-'.length)}`,
    launchRef: launch.launchRef,
    immutableExecutionClaims, connectionScope: scope, connectionGeneration: 1, state: 'active',
  }];
  checkpoint.registrations.incompleteConversationIds = [launch.conversationId];
  return checkpoint;
}

function combineCheckpoints(first, second) {
  const checkpoint = structuredClone(first);
  const registrationArrays = Object.keys(checkpoint.registrations);
  for (const field of registrationArrays) {
    if (!Array.isArray(checkpoint.registrations[field])) continue;
    if (field === 'connections') {
      const seen = new Set(checkpoint.registrations.connections.map((connection) => JSON.stringify(connection)));
      for (const connection of second.registrations.connections) {
        const key = JSON.stringify(connection);
        if (!seen.has(key)) {
          checkpoint.registrations.connections.push(structuredClone(connection));
          seen.add(key);
        }
      }
    } else if (field === 'conversations') {
      const seen = new Set(checkpoint.registrations.conversations.map((item) => JSON.stringify(item.identity)));
      for (const conversation of second.registrations.conversations) {
        const key = JSON.stringify(conversation.identity);
        if (!seen.has(key)) {
          checkpoint.registrations.conversations.push(structuredClone(conversation));
          seen.add(key);
        }
      }
    } else if (field === 'incompleteConversationIds') {
      const seen = new Set(checkpoint.registrations.incompleteConversationIds);
      for (const conversationId of second.registrations.incompleteConversationIds) {
        if (!seen.has(conversationId)) {
          checkpoint.registrations.incompleteConversationIds.push(conversationId);
          seen.add(conversationId);
        }
      }
    } else {
      checkpoint.registrations[field].push(...structuredClone(second.registrations[field]));
    }
  }
  checkpoint.ledger.deliveries.push(...structuredClone(second.ledger.deliveries));
  checkpoint.ledger.notificationTargets.push(...structuredClone(second.ledger.notificationTargets));
  checkpoint.ledger.logicalTombstones.push(...structuredClone(second.ledger.logicalTombstones));
  checkpoint.revision = Math.max(first.revision, second.revision) + 1;
  checkpoint.ledger.revision = Math.max(first.ledger.revision, second.ledger.revision) + 1;
  return normalizeCheckpointV3Local(checkpoint);
}

function projectQuestionAndCheckpoint(question, deliveryState) {
  const sourceBytesBySlot = {
    questions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, questions: [question] })),
    checkpoint: Buffer.from(JSON.stringify(legacyCheckpoint(question, deliveryState))),
  };
  return projectLegacyReclamationMigrationLocal({
    configuredSlots: ['questions', 'checkpoint'],
    sourceBytesBySlot,
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowanceBySlot: { questions: null, checkpoint: null },
  });
}

function projectQuestionWithoutCheckpoint(question) {
  return projectLegacyReclamationMigrationLocal({
    configuredSlots: ['questions'],
    sourceBytesBySlot: {
      questions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, questions: [question] })),
    },
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowanceBySlot: { questions: null },
  });
}

function makeQuestionCheckpointCacheIntermediate(provider) {
  const retired = makeRetiredSnapshot({ provider, deliveryState: 'available' });
  const staleQuestion = legacyQuestion(provider, true, '2');
  const staleProjection = projectQuestionAndCheckpoint(staleQuestion, 'unknown');
  const staleJournal = structuredClone(staleProjection.slots.questions.target.snapshot);
  staleJournal.questions[0].quarantinedAt = null;
  staleJournal.reservations[0].quarantinedAt = null;
  staleJournal.reservations[0].checkpointState = 'available';
  normalizeQuestionJournalV2Local(staleJournal);

  const creatingQuestion = legacyQuestion(provider, true, '3');
  const creatingProjection = projectQuestionWithoutCheckpoint(creatingQuestion);
  const creatingJournal = structuredClone(creatingProjection.slots.questions.target.snapshot);
  creatingJournal.questions[0].quarantinedAt = null;
  creatingJournal.questions[0].deliveryCreationState = 'creating';
  creatingJournal.reservations[0].quarantinedAt = null;
  creatingJournal.reservations[0].deliveryCreationState = 'creating';
  creatingJournal.reservations[0].checkpointState = null;
  creatingJournal.reservations[0].sourceClaimsDigest = null;
  creatingJournal.reservations[0].sessionId = null;
  creatingJournal.reservations[0].terminalResultKind = null;
  normalizeQuestionJournalV2Local(creatingJournal);

  const questionJournal = structuredClone(retired.stores.questions);
  questionJournal.questions.push(...structuredClone(staleJournal.questions), ...structuredClone(creatingJournal.questions));
  questionJournal.reservations.push(...structuredClone(staleJournal.reservations),
    ...structuredClone(creatingJournal.reservations));
  questionJournal.revision += 1;
  const normalizedQuestions = normalizeQuestionJournalV2Local(questionJournal);
  const checkpoint = combineCheckpoints(
    retired.stores.checkpoint,
    staleProjection.slots.checkpoint.target.snapshot,
  );
  const stores = {
    questions: normalizedQuestions,
    checkpoint,
    instructions: null,
  };
  return { anchor: retired.anchor, stores };
}

function instructionRecord(question, suffix, deliveryCreationState) {
  const launch = launchForQuestion(question);
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
  const source = {
    launchRef: launch.launchRef,
    claims,
    identity: launch.identity,
    executionBinding: launch.executionBinding,
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
  };
  const input = [{ type: 'text', text: `body-reclamation-${suffix}`, text_elements: [] }];
  const envelope = JSON.stringify({
    schemaVersion: 1,
    mode: 'start',
    expectedTurnId: null,
    input,
  });
  const nativeContent = JSON.stringify(input);
  return normalizeInstructionRecordV2Local({
    recordType: 'detail',
    deliveryAttemptId: `instruction-attempt-${suffix}`,
    launchRef: source.launchRef,
    logicalMessageId: `instruction-message-${suffix}`,
    revision: 1,
    source,
    envelope,
    envelopeDigest: createHash('sha256').update(envelope, 'utf8').digest('hex'),
    nativeContentDigest: createHash('sha256').update(nativeContent, 'utf8').digest('hex'),
    createdAt: STARTED_AT,
    deliveryCreationState,
    reclamation: null,
  });
}

function creatingInstructionJournal(question) {
  return normalizeInstructionJournalV2Local({
    schemaVersion: 2,
    revision: 4,
    storeId: STORE_ID,
    migrationAllowance: null,
    instructions: [
      instructionRecord(question, 'creating', 'creating'),
      instructionRecord(question, 'not-created', 'not_created'),
    ],
  });
}

function makeRetiredSnapshot({ provider = 'claude', selected = true, checkpoint = true,
  deliveryState = 'available', retiredAt = RETIRED_AT, terminalAt = null } = {}) {
  const question = legacyQuestion(provider, selected);
  const questionBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, questions: [question] }));
  const sourceBytesBySlot = { questions: questionBytes };
  const configuredSlots = ['questions'];
  if (checkpoint) {
    const legacy = selected ? legacyCheckpoint(question, deliveryState) : null;
    sourceBytesBySlot.checkpoint = Buffer.from(JSON.stringify(legacy || makeEmptyCheckpoint()));
    configuredSlots.push('checkpoint');
  }
  const projection = projectLegacyReclamationMigrationLocal({
    configuredSlots,
    sourceBytesBySlot,
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowanceBySlot: Object.fromEntries(configuredSlots.map((slot) => [slot, null])),
  });
  const questionJournal = structuredClone(projection.slots.questions.target.snapshot);
  const targetCheckpoint = checkpoint
    ? structuredClone(projection.slots.checkpoint.target.snapshot)
    : createEmptyCheckpointV3TargetLocal({ storeId: STORE_ID }).snapshot;

  if (terminalAt !== null && targetCheckpoint.ledger.deliveries.length > 0) {
    targetCheckpoint.ledger.deliveries[0].terminalAt = terminalAt;
    normalizeCheckpointV3Local(targetCheckpoint);
  }
  for (const detail of questionJournal.questions) {
    detail.quarantinedAt = null;
    if (detail.selection !== null) {
      detail.deliveryCreationState = deliveryState === 'not_created' && !checkpoint ? 'not_created' : 'creating';
    }
  }
  for (const reservation of questionJournal.reservations) {
    reservation.quarantinedAt = null;
    if (reservation.deliveryIntent !== null) {
      reservation.deliveryCreationState = deliveryState === 'not_created' && !checkpoint
        ? 'not_created' : 'creating';
      reservation.checkpointState = null;
      reservation.sourceClaimsDigest = null;
      reservation.sessionId = null;
      reservation.terminalResultKind = null;
    }
  }
  normalizeQuestionJournalV2Local(questionJournal);

  const retired = planQuestionPeriodRetirement({
    anchor: {
      schemaVersion: 1, revision: 0, storeId: STORE_ID, retiredQuestionPeriods: [], migration: null,
    },
    questionJournal,
    checkpoint: targetCheckpoint,
    identity: question.identity,
    periodId: question.periodId,
    retiredAt,
  });
  const stores = {
    questions: retired.questionJournal,
    checkpoint: checkpoint ? retired.checkpoint : null,
    instructions: null,
  };
  const checked = validateReclamationSnapshot({ anchor: retired.anchor, stores });
  assert.equal(checked.status, 'ready');
  return { anchor: checked.snapshot.anchor, stores: structuredClone(checked.snapshot.stores) };
}

function plan(snapshot, now, options = {}) {
  return planQuestionBodyReclamation({
    anchor: snapshot.anchor,
    stores: snapshot.stores,
    normalByteLimitsBySlot: snapshot.stores.checkpoint === null ? LIMITS_QUESTIONS_ONLY : LIMITS_WITH_CHECKPOINT,
    internalQuestionId: 'internal-1',
    now,
    ...options,
  });
}

test('newly due body reclamation produces prepared, checkpoint grave, and reclaimed snapshots', () => {
  for (const provider of ['claude', 'codex']) {
    const snapshot = makeRetiredSnapshot({ provider, deliveryState: 'available' });
    const original = structuredClone(snapshot);
    const planned = plan(snapshot, RETIRED_AT + RETENTION_MS, { operationId: OPERATION_ID });

    assert.equal(planned.status, 'planned');
    assert.equal(planned.operationId, OPERATION_ID);
    assert.equal(planned.steps.map((step) => step.boundary).join(','), 'prepare,checkpoint-grave,reclaim');
    assert.equal(JSON.stringify(snapshot), JSON.stringify(original));
    assert.equal(planned.steps[0].snapshot.stores.questions.reservations[0].bodyState, 'retained');
    assert.equal(planned.steps[0].snapshot.stores.questions.reservations[0].reclamation.preparedAt,
      RETIRED_AT + RETENTION_MS);
    assert.equal(planned.steps[1].snapshot.stores.checkpoint.ledger.deliveries[0].recordType, 'reclaimed');
    assert.equal(planned.steps[1].snapshot.stores.checkpoint.ledger.deliveries[0].reclamation.operationId,
      OPERATION_ID);
    const claims = snapshot.stores.checkpoint.ledger.deliveries[0].source.claims;
    const canonicalClaims = JSON.stringify({
      launchId: claims.launchId,
      runId: claims.runId,
      attemptId: claims.attemptId,
      provider: claims.provider,
      nativeIdKind: claims.nativeIdKind,
      hostId: claims.hostId,
      homeScopeId: claims.homeScopeId,
      origin: claims.origin,
      purpose: claims.purpose,
      originBinding: claims.originBinding,
    });
    const expectedClaimsDigest = createHash('sha256').update(canonicalClaims, 'utf8').digest('hex');
    assert.equal(planned.steps[1].snapshot.stores.checkpoint.ledger.deliveries[0]
      .sourceRef.sourceClaimsDigest, expectedClaimsDigest);
    assert.equal(planned.steps[1].snapshot.stores.checkpoint.ledger.deliveries[0]
      .targetRef.targetClaimsDigest, expectedClaimsDigest);
    assert.equal(planned.steps[2].snapshot.stores.questions.questions.length, 0);
    assert.equal(planned.steps[2].snapshot.stores.questions.reservations[0].bodyState, 'reclaimed');
    assert.equal(planned.steps[2].snapshot.stores.questions.reservations[0].reclaimedAt,
      RETIRED_AT + RETENTION_MS);
    assert.deepEqual(planned.steps[2].snapshot.stores.instructions, null);
  }
});

test('not-created and indeterminate questions never add a checkpoint delivery', () => {
  const none = makeRetiredSnapshot({ selected: false, checkpoint: false });
  const nonePlan = plan(none, RETIRED_AT + RETENTION_MS, { operationId: OPERATION_ID });
  assert.equal(nonePlan.steps.map((step) => step.boundary).join(','), 'prepare,reclaim');
  assert.equal(nonePlan.steps[1].snapshot.stores.checkpoint, null);

  const selectedIntentNotCreated = makeRetiredSnapshot({
    selected: true, checkpoint: false, deliveryState: 'not_created',
  });
  const selectedIntentPlan = plan(selectedIntentNotCreated, RETIRED_AT + RETENTION_MS,
    { operationId: OPERATION_ID });
  assert.equal(selectedIntentPlan.steps[0].snapshot.stores.questions.reservations[0].reclamation.deliveryPresence,
    'none');
  assert.equal(selectedIntentPlan.steps.map((step) => step.boundary).join(','), 'prepare,reclaim');

  const indeterminate = makeRetiredSnapshot({ selected: true, checkpoint: false });
  const indeterminatePlan = plan(indeterminate, RETIRED_AT + RETENTION_MS, { operationId: OPERATION_ID });
  assert.equal(indeterminatePlan.steps.map((step) => step.boundary).join(','), 'prepare,reclaim');
  assert.equal(indeterminatePlan.steps[0].snapshot.stores.questions.reservations[0].reclamation.deliveryPresence,
    'indeterminate');
  assert.equal(indeterminatePlan.steps[1].snapshot.stores.checkpoint, null);
  const resumed = plan(indeterminatePlan.steps[0].snapshot, RETIRED_AT + RETENTION_MS);
  assert.equal(resumed.steps.length, 1);
  assert.equal(resumed.steps[0].boundary, 'reclaim');
  assert.equal(plan(resumed.steps[0].snapshot, RETIRED_AT + RETENTION_MS).status, 'complete');
});

test('unknown and terminal checkpoint states are frozen in the grave after their retention deadlines', () => {
  const unknown = makeRetiredSnapshot({ deliveryState: 'unknown' });
  const unknownPlan = plan(unknown, RETIRED_AT + RETENTION_MS, { operationId: OPERATION_ID });
  assert.equal(unknownPlan.status, 'planned');
  assert.equal(unknownPlan.steps[1].snapshot.stores.checkpoint.ledger.deliveries[0].state, 'unknown');

  const terminalAt = RETIRED_AT + 2_000_000;
  const terminal = makeRetiredSnapshot({ deliveryState: 'applied', terminalAt });
  const deadline = terminalAt + RETENTION_MS;
  const early = plan(terminal, deadline - 1, { operationId: OPERATION_ID });
  assert.equal(early.status, 'deferred');
  assert.equal(early.deferredReason, 'retention_not_elapsed');
  const due = plan(terminal, deadline, { operationId: OPERATION_ID });
  assert.equal(due.status, 'planned');
  assert.equal(due.deadlineAt, deadline);
  assert.equal(due.steps[1].snapshot.stores.checkpoint.ledger.deliveries[0].terminalAt, terminalAt);
  assert.equal(due.steps[1].snapshot.stores.checkpoint.ledger.deliveries[0].state, 'applied');
});

test('an eligible unprepared reservation requests a UUID before planning any mutation', () => {
  const snapshot = makeRetiredSnapshot({ deliveryState: 'available' });
  const due = plan(snapshot, RETIRED_AT + RETENTION_MS);
  assert.equal(due.status, 'eligible');
  assert.equal(due.operationId, null);
  assert.deepEqual(due.steps, []);
  const before = plan(snapshot, RETIRED_AT + RETENTION_MS - 1);
  assert.equal(before.status, 'deferred');
  assert.equal(before.deferredReason, 'retention_not_elapsed');
});

test('prepared operations resume with the saved UUID and fixed preparedAt at each boundary', () => {
  const snapshot = makeRetiredSnapshot({ deliveryState: 'available' });
  const time = RETIRED_AT + RETENTION_MS;
  const full = plan(snapshot, time, { operationId: OPERATION_ID });
  const prepared = full.steps[0].snapshot;
  const resumed = plan(prepared, time);
  assert.equal(resumed.operationId, OPERATION_ID);
  assert.equal(resumed.steps.map((step) => step.boundary).join(','), 'checkpoint-grave,reclaim');
  assert.equal(resumed.steps[0].snapshot.stores.questions.reservations[0].reclamation.preparedAt, time);
  const afterGrave = plan(resumed.steps[0].snapshot, time, { operationId: OPERATION_ID });
  assert.equal(afterGrave.steps.length, 1);
  assert.equal(afterGrave.steps[0].boundary, 'reclaim');
  const complete = plan(resumed.steps[1].snapshot, time);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.steps.length, 0);
  assert.throws(() => plan(prepared, time, { operationId: '33333333-3333-4333-8333-333333333333' }), TypeError);
});

test('clock rollback and unrepresentable deadlines defer without changing snapshots', () => {
  const snapshot = makeRetiredSnapshot({ deliveryState: 'available' });
  const beforeOrigin = plan(snapshot, RETIRED_AT - 1);
  assert.equal(beforeOrigin.status, 'deferred');
  assert.equal(beforeOrigin.deferredReason, 'clock_before_retention_origin');

  const time = RETIRED_AT + RETENTION_MS;
  const prepared = plan(snapshot, time, { operationId: OPERATION_ID }).steps[0].snapshot;
  const rolledBack = plan(prepared, time - 1);
  assert.equal(rolledBack.status, 'deferred');
  assert.equal(rolledBack.deferredReason, 'clock_before_prepared_at');
  assert.equal(rolledBack.snapshot.stores.questions.reservations[0].reclamation.preparedAt, time);

  const overflow = makeRetiredSnapshot({ retiredAt: Number.MAX_SAFE_INTEGER - RETENTION_MS + 1 });
  const overflowResult = plan(overflow, Number.MAX_SAFE_INTEGER);
  assert.equal(overflowResult.status, 'deferred');
  assert.equal(overflowResult.deferredReason, 'retention_deadline_overflow');
  assert.equal(overflowResult.deadlineAt, null);

  const terminalOverflow = makeRetiredSnapshot({
    deliveryState: 'applied',
    terminalAt: Number.MAX_SAFE_INTEGER - RETENTION_MS + 1,
  });
  const terminalOverflowResult = plan(terminalOverflow, Number.MAX_SAFE_INTEGER);
  assert.equal(terminalOverflowResult.status, 'deferred');
  assert.equal(terminalOverflowResult.deferredReason, 'retention_deadline_overflow');
});

test('non-retired, mismatched, impossible, or malformed snapshots reject', () => {
  const snapshot = makeRetiredSnapshot({ deliveryState: 'available' });
  const dueAt = RETIRED_AT + RETENTION_MS;
  const notRetired = structuredClone(snapshot);
  notRetired.anchor.retiredQuestionPeriods = [];
  assert.throws(() => plan(notRetired, dueAt, { operationId: OPERATION_ID }), TypeError);

  const changedRetiredAt = structuredClone(snapshot);
  changedRetiredAt.anchor.retiredQuestionPeriods[0].retiredAt += 1;
  assert.throws(() => plan(changedRetiredAt, dueAt, { operationId: OPERATION_ID }), TypeError);

  const mismatchedCache = structuredClone(snapshot);
  mismatchedCache.stores.questions.reservations[0].checkpointState = 'unknown';
  assert.throws(() => plan(mismatchedCache, dueAt, { operationId: OPERATION_ID }), TypeError);

  const malformed = structuredClone(snapshot);
  malformed.stores.checkpoint.ledger.deliveries[0].acceptedCorrelation = {
    deliveryAttemptId: 'wrong', revision: 9,
  };
  assert.throws(() => plan(malformed, dueAt, { operationId: OPERATION_ID }), TypeError);
});

test('hostile accessors are rejected without invoking their getters', () => {
  const snapshot = makeRetiredSnapshot({ deliveryState: 'available' });
  const dueAt = RETIRED_AT + RETENTION_MS;
  let getterCalls = 0;
  const input = {
    anchor: snapshot.anchor,
    stores: snapshot.stores,
    normalByteLimitsBySlot: LIMITS_WITH_CHECKPOINT,
    internalQuestionId: 'internal-1',
    now: dueAt,
    operationId: OPERATION_ID,
  };
  Object.defineProperty(input, 'now', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('getter called'); },
  });
  assert.throws(() => planQuestionBodyReclamation(input), TypeError);
  assert.equal(getterCalls, 0);

  const hostileLimits = { ...LIMITS_WITH_CHECKPOINT };
  Object.defineProperty(hostileLimits, 'questions', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('getter called'); },
  });
  assert.throws(() => planQuestionBodyReclamation({
    anchor: snapshot.anchor,
    stores: snapshot.stores,
    normalByteLimitsBySlot: hostileLimits,
    internalQuestionId: 'internal-1',
    now: dueAt,
    operationId: OPERATION_ID,
  }), TypeError);
  assert.equal(getterCalls, 0);

  const objectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  const hostileToJSON = () => { getterCalls += 1; throw new Error('toJSON called'); };
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get: hostileToJSON,
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      get: hostileToJSON,
    });
    const safePlan = plan(snapshot, dueAt, { operationId: OPERATION_ID });
    assert.equal(safePlan.status, 'planned');
    assert.equal(getterCalls, 0);
  } finally {
    if (objectToJSON === undefined) delete Object.prototype.toJSON;
    else Object.defineProperty(Object.prototype, 'toJSON', objectToJSON);
    if (arrayToJSON === undefined) delete Array.prototype.toJSON;
    else Object.defineProperty(Array.prototype, 'toJSON', arrayToJSON);
  }
});

test('planner preserves unrelated creation and cache intermediates across every boundary', () => {
  for (const provider of ['claude', 'codex']) {
    const snapshot = makeQuestionCheckpointCacheIntermediate(provider);
    const questionCheck = validateReclamationStoreWrite({
      anchor: snapshot.anchor,
      previousStores: snapshot.stores,
      nextStores: snapshot.stores,
      normalByteLimitsBySlot: LIMITS_WITH_CHECKPOINT,
    });
    assert.deepEqual([...questionCheck.reasons].sort(), [
      'question_checkpoint_cache', 'question_creation_state',
    ]);
    assert.equal(questionCheck.snapshot.stores.questions.reservations.find((item) =>
      item.internalQuestionId === 'internal-2').checkpointState, 'available');

    const unrelatedQuestion = structuredClone(snapshot.stores.questions.questions.find((item) =>
      item.internalQuestionId === 'internal-2'));
    const unrelatedDelivery = structuredClone(snapshot.stores.checkpoint.ledger.deliveries.find((item) =>
      item.sourceExecutionId === 'period-2'));
    const creatingQuestion = structuredClone(snapshot.stores.questions.questions.find((item) =>
      item.internalQuestionId === 'internal-3'));
    const creatingReservation = structuredClone(snapshot.stores.questions.reservations.find((item) =>
      item.internalQuestionId === 'internal-3'));
    const dueAt = RETIRED_AT + RETENTION_MS;
    const planned = planQuestionBodyReclamation({
      anchor: snapshot.anchor,
      stores: snapshot.stores,
      normalByteLimitsBySlot: LIMITS_WITH_CHECKPOINT,
      internalQuestionId: 'internal-1',
      now: dueAt,
      operationId: OPERATION_ID,
    });

    assert.equal(planned.status, 'planned');
    assert.deepEqual(planned.steps.map((step) => step.boundary), [
      'prepare', 'checkpoint-grave', 'reclaim',
    ]);
    for (const step of planned.steps) {
      assert.equal(JSON.stringify(step.snapshot.stores.questions.questions.find((item) =>
        item.internalQuestionId === 'internal-2')), JSON.stringify(unrelatedQuestion));
      assert.equal(step.snapshot.stores.questions.reservations.find((item) =>
        item.internalQuestionId === 'internal-2').checkpointState, 'available');
      assert.equal(JSON.stringify(step.snapshot.stores.checkpoint.ledger.deliveries.find((item) =>
        item.deliveryAttemptId === unrelatedDelivery.deliveryAttemptId)), JSON.stringify(unrelatedDelivery));
      assert.equal(JSON.stringify(step.snapshot.stores.questions.questions.find((item) =>
        item.internalQuestionId === 'internal-3')), JSON.stringify(creatingQuestion));
      assert.equal(JSON.stringify(step.snapshot.stores.questions.reservations.find((item) =>
        item.internalQuestionId === 'internal-3')), JSON.stringify(creatingReservation));
    }

    const notFrozen = structuredClone(snapshot);
    notFrozen.stores.questions.questions.find((item) => item.internalQuestionId === 'internal-1')
      .quarantinedAt = null;
    notFrozen.stores.questions.reservations.find((item) => item.internalQuestionId === 'internal-1')
      .quarantinedAt = null;
    assert.throws(() => planQuestionBodyReclamation({
      anchor: notFrozen.anchor,
      stores: notFrozen.stores,
      normalByteLimitsBySlot: LIMITS_WITH_CHECKPOINT,
      internalQuestionId: 'internal-1',
      now: dueAt,
      operationId: OPERATION_ID,
    }), TypeError);
  }
});

test('planner preserves unrelated instruction creation without repairing its journal', () => {
  for (const provider of ['claude', 'codex']) {
    const snapshot = makeRetiredSnapshot({ provider, deliveryState: 'available' });
    snapshot.stores.instructions = creatingInstructionJournal(legacyQuestion(provider));
    const originalBytes = encodeInstructionJournalV2Local(snapshot.stores.instructions).bytes;
    const dueAt = RETIRED_AT + RETENTION_MS;
    const planned = planQuestionBodyReclamation({
      anchor: snapshot.anchor,
      stores: snapshot.stores,
      normalByteLimitsBySlot: LIMITS_WITH_ALL_STORES,
      internalQuestionId: 'internal-1',
      now: dueAt,
      operationId: OPERATION_ID,
    });

    assert.equal(planned.status, 'planned');
    assert.deepEqual(planned.steps.map((step) => step.boundary), [
      'prepare', 'checkpoint-grave', 'reclaim',
    ]);
    for (const step of planned.steps) {
      assert.equal(step.snapshot.stores.instructions.instructions[0].deliveryCreationState, 'creating');
      assert.equal(step.snapshot.stores.instructions.instructions[1].deliveryCreationState, 'not_created');
      assert.deepEqual(Buffer.from(encodeInstructionJournalV2Local(step.snapshot.stores.instructions).bytes),
        Buffer.from(originalBytes));
    }
  }
});
