'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const {
  createDelivery,
  createEmptyLedger,
  transitionDelivery,
} = require('../src/server/delivery-ledger');
const {
  createQuestionRecord,
  selectionFor,
} = require('../src/server/common-question-kernel');
const { makeEmptyCheckpoint } = require('../src/server/durable-checkpoint');
const {
  createEmptyCheckpointV3TargetLocal,
  createEmptyInstructionJournalV2TargetLocal,
  createEmptyQuestionJournalV2TargetLocal,
  projectLegacyCheckpointV2Local,
  projectLegacyInstructionJournalV1Local,
  projectLegacyQuestionJournalV1Local,
  projectLegacyReclamationMigrationLocal,
} = require('../src/server/reclamation-migration-projection');
const { encodeCheckpointV3Local, normalizeCheckpointV3Local } = require('../src/server/delivery-reclamation-codec');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const STARTED_AT = 1_000_000;

function sourceBytes(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function questionRecord({ provider = 'claude', internalQuestionId = 'internal-1', periodId = 'period-1' } = {}) {
  const nativeIdKind = provider === 'claude' ? 'session' : 'thread';
  return createQuestionRecord({
    internalQuestionId,
    questionId: `public-${internalQuestionId}`,
    identity: {
      provider,
      nativeIdKind,
      hostId: `host-${provider}`,
      homeScopeId: `home-${provider}`,
      nativeId: `native-${internalQuestionId}`,
    },
    periodId,
    executionId: `execution-${internalQuestionId}`,
    conversationId: `conversation-${internalQuestionId}`,
    launchRef: `launch-${internalQuestionId}`,
    executionBinding: { periodId, actor: { kind: 'agent', id: `actor-${internalQuestionId}` } },
    category: 'ordinary',
    questions: [{
      id: `question-${internalQuestionId}`,
      text: 'Choose one',
      mode: 'single',
      options: [{ id: 'option-1', label: 'First', description: '' }],
      allowFreeText: true,
      recommendedOptionId: 'option-1',
    }],
    timeoutMinutes: 1,
    createdAt: 10_000,
  });
}

function selectedQuestionCheckpoint(provider) {
  const created = questionRecord({ provider, internalQuestionId: `internal-${provider}` });
  const selected = selectionFor(created, [{
    questionId: created.questions[0].id,
    optionIds: ['option-1'],
    freeText: null,
  }], 'manual', created.createdAt + 1_000, `selection-${provider}`).record;
  const launch = {
    launchRef: selected.launchRef,
    launchId: `launch-${provider}`,
    runId: `run-${provider}`,
    attemptId: `attempt-${provider}`,
    provider: selected.identity.provider,
    nativeIdKind: selected.identity.nativeIdKind,
    hostId: selected.identity.hostId,
    homeScopeId: selected.identity.homeScopeId,
    origin: 'standalone',
    purpose: 'agent',
    originBinding: null,
    state: 'bound',
    identity: selected.identity,
    executionBinding: selected.executionBinding,
    conversationId: selected.conversationId,
    sessionId: `session-${provider}`,
    currentOwner: selected.executionBinding,
    ownerGeneration: 0,
  };
  const payload = JSON.stringify({
    questionId: selected.questionId,
    revision: selected.deliveryIntent.revision,
    answers: selected.selection.answers,
  });
  const ledger = createDelivery(createEmptyLedger(), 'question', {
    deliveryAttemptId: selected.deliveryIntent.deliveryAttemptId,
    logicalMessageId: selected.deliveryIntent.logicalMessageId,
    revision: selected.deliveryIntent.revision,
    payload,
  }, launch).ledger;
  return { selected, checkpoint: checkpointWithLaunch(launch, ledger) };
}

function questionJournal(...questions) {
  return { schemaVersion: 1, revision: 7, questions };
}

function checkpointV2() {
  const checkpoint = structuredClone(makeEmptyCheckpoint());
  checkpoint.schemaVersion = 2;
  checkpoint.revision = 9;
  checkpoint.ledger.revision = 11;
  return checkpoint;
}

function executionLaunch() {
  const identity = {
    provider: 'claude', nativeIdKind: 'session', hostId: 'host-1',
    homeScopeId: 'home-1', nativeId: 'native-1',
  };
  return {
    launchRef: 'launch-1', launchId: 'launch-id', runId: 'run-id', attemptId: 'attempt-id',
    provider: 'claude', nativeIdKind: 'session', hostId: 'host-1', homeScopeId: 'home-1',
    origin: 'standalone', purpose: 'agent', originBinding: null, state: 'bound', identity,
    executionBinding: { periodId: 'period-1', actor: { kind: 'agent', id: 'actor-1' } },
    conversationId: 'conversation-1', sessionId: 'session-1', ownerGeneration: 0,
  };
}

function checkpointWithLaunch(launch, ledger) {
  const checkpoint = checkpointV2();
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
    ...claims, identity: launch.identity, executionBinding: launch.executionBinding,
  };
  const scope = {
    provider: launch.provider,
    nativeIdKind: launch.nativeIdKind,
    hostId: launch.hostId,
    homeScopeId: launch.homeScopeId,
    connectionSlotId: 'source-slot',
  };
  checkpoint.ledger = structuredClone(ledger);
  checkpoint.registrations.conversations = [{
    conversationId: launch.conversationId, identity: launch.identity,
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

function checkpointWithInstructionDelivery() {
  return checkpointAndInstructionV1().checkpoint;
}

function checkpointAndInstructionV1() {
  const launch = executionLaunch();
  const runtimeLaunch = { ...launch, currentOwner: launch.executionBinding, ownerGeneration: 0 };
  const inputItem = { type: 'text', text: 'instruction-payload', text_elements: [] };
  const envelope = JSON.stringify({
    schemaVersion: 1, mode: 'start', expectedTurnId: null, input: [inputItem],
  });
  const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
  const ledger = createDelivery(createEmptyLedger(), 'instruction', {
    deliveryAttemptId: 'attempt-instruction',
    logicalMessageId: 'logical-instruction',
    revision: 3,
    payload: envelope,
  }, runtimeLaunch).ledger;
  const checkpoint = checkpointWithLaunch(launch, ledger);
  return {
    checkpoint,
    instruction: {
      deliveryAttemptId: 'attempt-instruction',
      launchRef: launch.launchRef,
      logicalMessageId: 'logical-instruction',
      revision: 3,
      source: structuredClone(ledger.deliveries[0].source),
      envelope,
      envelopeDigest: digest(envelope),
      nativeContentDigest: digest(JSON.stringify([inputItem])),
      createdAt: 12_000,
    },
  };
}

function fullProjection(questionBytes, checkpointBytes = null) {
  const configuredSlots = checkpointBytes === null ? ['questions'] : ['questions', 'checkpoint'];
  const sourceBytesBySlot = checkpointBytes === null
    ? { questions: questionBytes }
    : { questions: questionBytes, checkpoint: checkpointBytes };
  const migrationAllowanceBySlot = checkpointBytes === null
    ? { questions: null }
    : { questions: null, checkpoint: null };
  return projectLegacyReclamationMigrationLocal({
    configuredSlots,
    sourceBytesBySlot,
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowanceBySlot,
  });
}

test('empty target helpers start all schema revisions at zero', () => {
  const checkpoint = createEmptyCheckpointV3TargetLocal({ storeId: STORE_ID });
  const questions = createEmptyQuestionJournalV2TargetLocal({ storeId: STORE_ID });
  const instructions = createEmptyInstructionJournalV2TargetLocal({ storeId: STORE_ID });
  assert.equal(checkpoint.snapshot.revision, 0);
  assert.equal(checkpoint.snapshot.ledger.revision, 0);
  assert.equal(questions.snapshot.revision, 0);
  assert.equal(instructions.snapshot.revision, 0);
  assert.deepEqual(JSON.parse(checkpoint.encoded.bytes.toString('utf8')).registrations.conversations, []);
  assert.equal(JSON.parse(questions.encoded.bytes.toString('utf8')).migrationAllowance, null);
  assert.equal(JSON.parse(instructions.encoded.bytes.toString('utf8')).migrationAllowance, null);
});

test('unselected legacy questions become retired none snapshots and revisions advance once', () => {
  const original = questionRecord();
  const questionBytes = sourceBytes(questionJournal(original));
  const checkpointBytes = sourceBytes(checkpointV2());
  const projection = fullProjection(questionBytes, checkpointBytes);

  assert.deepEqual(projection.anchor.migration.sources.map((source) => source.slot), ['checkpoint', 'questions']);
  assert.equal(projection.slots.checkpoint.target.snapshot.revision, 10);
  assert.equal(projection.slots.checkpoint.target.snapshot.ledger.revision, 12);
  assert.equal(projection.slots.questions.target.snapshot.revision, 8);
  assert.equal(projection.anchor.retiredQuestionPeriods.length, 1);
  assert.equal(projection.anchor.retiredQuestionPeriods[0].retiredAt, STARTED_AT);
  assert.equal(projection.anchor.migration.targets[0].deliveryPresence, 'none');
  assert.equal(projection.anchor.migration.targets[0].checkpointState, null);
  assert.equal(projection.slots.questions.target.snapshot.questions[0].quarantinedAt, STARTED_AT);
  assert.equal(projection.slots.questions.candidateSnapshotsByBoundary.prepared.snapshot.revision, 8);
  assert.equal(projection.slots.questions.questionCandidates[0].internalQuestionId, 'internal-1');
  assert.equal(projection.slots.questions.questionCandidates[0].currentDetail,
    projection.slots.questions.questionCandidates[0].maxFutureDetail);
  assert.equal(projection.slots.questions.questionCandidates[0].preparedReservation.reclamation.preparedAt,
    Number.MAX_SAFE_INTEGER);
  assert.deepEqual(JSON.parse(projection.slots.questions.target.encoded.bytes.toString('utf8')).questions[0]
    .deliveryCreationState, 'not_created');
});

test('selected questions without a matching checkpoint attempt become indeterminate', () => {
  const created = questionRecord({ provider: 'codex' });
  const selected = selectionFor(created, [{
    questionId: created.questions[0].id,
    optionIds: ['option-1'],
    freeText: null,
  }], 'manual', created.createdAt + 1_000, 'fixed-selection-id').record;
  const projection = fullProjection(sourceBytes(questionJournal(selected)));
  const detail = projection.slots.questions.target.snapshot.questions[0];
  const reservation = projection.slots.questions.target.snapshot.reservations[0];

  assert.equal(detail.deliveryCreationState, 'indeterminate');
  assert.equal(reservation.checkpointState, 'unknown');
  assert.equal(reservation.sourceClaimsDigest, null);
  assert.equal(reservation.sessionId, null);
  assert.equal(projection.anchor.migration.targets[0].deliveryPresence, 'indeterminate');
  assert.equal(projection.anchor.migration.targets[0].checkpointState, 'unknown');
});

test('legacy question source without the optional auto-apply field defaults to false', () => {
  const legacy = structuredClone(questionRecord());
  delete legacy.autoApplyEnabledAtRegistration;
  const projection = fullProjection(sourceBytes(questionJournal(legacy)));
  assert.equal(projection.slots.questions.target.snapshot.questions[0].autoApplyEnabledAtRegistration, false);
});

test('matching checkpointed questions preserve exact source claims and state for both providers', () => {
  for (const provider of ['claude', 'codex']) {
    const input = selectedQuestionCheckpoint(provider);
    const projection = fullProjection(sourceBytes(questionJournal(input.selected)), sourceBytes(input.checkpoint));
    const detail = projection.slots.questions.target.snapshot.questions[0];
    const reservation = projection.slots.questions.target.snapshot.reservations[0];
    assert.equal(detail.deliveryCreationState, 'checkpointed');
    assert.equal(reservation.checkpointState, 'available');
    assert.equal(reservation.sessionId, `session-${provider}`);
    assert.equal(reservation.sourceClaimsDigest.length, 64);
    assert.equal(projection.anchor.migration.targets[0].deliveryPresence, 'checkpoint');
    assert.equal(projection.anchor.migration.targets[0].checkpointState, 'available');
    assert.ok(projection.slots.checkpoint.deliveryCandidates[0].candidates
      .some((candidate) => candidate.variant === 'reclaimed'));
  }
});

test('legacy accepted checkpoint state is validated before recovery maps it to unknown', () => {
  const launch = executionLaunch();
  const ledger = structuredClone(createDelivery(createEmptyLedger(), 'question', {
    deliveryAttemptId: 'attempt-question', logicalMessageId: 'logical-question', revision: 1, payload: 'answer',
  }, launch).ledger);
  const delivery = ledger.deliveries[0];
  const acceptedCorrelation = {
    deliveryAttemptId: delivery.deliveryAttemptId,
    revision: delivery.revision,
    payloadDigest: delivery.payloadDigest,
    targetPeriodId: delivery.target.periodId,
    nativeTurnId: 'turn-1',
    nativeItemId: null,
    clientRequestId: delivery.deliveryAttemptId,
  };
  delivery.state = 'accepted';
  delivery.acceptedCorrelation = acceptedCorrelation;
  const validCheckpoint = checkpointWithLaunch(launch, ledger);

  const validProjection = projectLegacyCheckpointV2Local({
    sourceBytes: sourceBytes(validCheckpoint),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowance: null,
  });
  assert.equal(validProjection.snapshot.ledger.deliveries[0].state, 'unknown');
  assert.deepEqual({ ...validProjection.snapshot.ledger.deliveries[0].acceptedCorrelation }, acceptedCorrelation);

  const malformedLedger = structuredClone(ledger);
  malformedLedger.deliveries[0].acceptedCorrelation = null;
  const malformedCheckpoint = checkpointWithLaunch(launch, malformedLedger);

  assert.throws(() => projectLegacyCheckpointV2Local({
    sourceBytes: sourceBytes(malformedCheckpoint),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowance: null,
  }), TypeError);
});

test('checkpoint recovery maps claimed to available and sending or accepted to unknown', () => {
  const base = checkpointWithInstructionDelivery();
  const attemptId = 'attempt-instruction';
  const initial = base.ledger;
  const claimedLedger = transitionDelivery(initial, attemptId, 'claim').ledger;
  const sendingLedger = transitionDelivery(initial, attemptId, 'sendStart').ledger;
  const sendingDelivery = sendingLedger.deliveries[0];
  const acceptedLedger = transitionDelivery(sendingLedger, attemptId, 'accepted', {
    deliveryAttemptId: attemptId,
    revision: sendingDelivery.revision,
    payloadDigest: sendingDelivery.payloadDigest,
    targetPeriodId: sendingDelivery.target.periodId,
    nativeTurnId: 'turn-accepted',
    nativeItemId: null,
    clientRequestId: attemptId,
  }).ledger;
  const cases = [
    [claimedLedger, 'available'],
    [sendingLedger, 'unknown'],
    [acceptedLedger, 'unknown'],
  ];
  for (const [ledger, expectedState] of cases) {
    const checkpoint = structuredClone(base);
    checkpoint.ledger = structuredClone(ledger);
    const projected = projectLegacyCheckpointV2Local({
      sourceBytes: sourceBytes(checkpoint),
      storeId: STORE_ID,
      operationId: OPERATION_ID,
      startedAt: STARTED_AT,
      migrationAllowance: null,
    });
    assert.equal(projected.snapshot.ledger.deliveries[0].state, expectedState);
  }
});

test('checkpoint candidates expose legal maximum correlation and terminal grave variants per attempt', () => {
  const projected = projectLegacyCheckpointV2Local({
    sourceBytes: sourceBytes(checkpointWithInstructionDelivery()),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowance: null,
  });
  const row = projected.deliveryCandidates[0];
  assert.equal(row.deliveryAttemptId, 'attempt-instruction');
  const future = row.candidates.find((item) => item.variant === 'maxFutureDetail').record;
  assert.equal(future.state, 'applied');
  assert.equal(future.acceptedCorrelation.nativeTurnId.length, 512);
  assert.equal(future.acceptedCorrelation.nativeItemId.length, 512);
  assert.equal(future.terminalAt, Number.MAX_SAFE_INTEGER);
  const grave = row.candidates.find((item) => item.variant === 'reclaimed').record;
  assert.equal(grave.recordType, 'reclaimed');
  assert.equal(grave.terminalAt, Number.MAX_SAFE_INTEGER - 604_800_000);
  assert.equal(grave.reclamation.reclaimedAt, Number.MAX_SAFE_INTEGER);
  assert.equal(grave.reclamation.reason, 'terminal_retention');

  const futureCheckpoint = structuredClone(projected.snapshot);
  futureCheckpoint.ledger.deliveries[0] = future;
  assert.doesNotThrow(() => normalizeCheckpointV3Local(futureCheckpoint));
  const graveCheckpoint = structuredClone(projected.snapshot);
  graveCheckpoint.ledger.deliveries[0] = grave;
  assert.doesNotThrow(() => normalizeCheckpointV3Local(graveCheckpoint));
  assert.equal(projected.candidateSnapshotsByBoundary.reclaimed.snapshot.revision,
    projected.snapshot.revision);
});

test('instruction candidates reserve reachable prepare and reclaimed records for a future terminal checkpoint', () => {
  const input = checkpointAndInstructionV1();
  const checkpoint = projectLegacyCheckpointV2Local({
    sourceBytes: sourceBytes(input.checkpoint),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowance: null,
  });
  const projected = projectLegacyInstructionJournalV1Local({
    sourceBytes: sourceBytes({ schemaVersion: 1, revision: 4, instructions: [input.instruction] }),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    checkpointSnapshot: checkpoint.snapshot,
    migrationAllowance: null,
  });
  const row = projected.instructionCandidates[0];
  assert.equal(row.deliveryAttemptId, 'attempt-instruction');
  assert.equal(row.candidates.find((item) => item.variant === 'current').record.deliveryCreationState,
    'checkpointed');
  const prepared = row.candidates.find((item) => item.variant === 'prepared').record;
  const reclaimed = row.candidates.find((item) => item.variant === 'reclaimed').record;
  assert.equal(prepared.reclamation.preparedAt, Number.MAX_SAFE_INTEGER);
  assert.equal(prepared.reclamation.terminalState, 'applied');
  assert.equal(prepared.reclamation.terminalAt, Number.MAX_SAFE_INTEGER - 604_800_000);
  assert.equal(reclaimed.reclaimedAt, Number.MAX_SAFE_INTEGER);
  assert.equal(projected.candidateSnapshotsByBoundary.prepared.snapshot.revision,
    projected.snapshot.revision);
});

test('future retention candidates are omitted when no safe terminal timestamp can satisfy seven days', () => {
  const startedAt = Number.MAX_SAFE_INTEGER - 604_800_000 + 1;
  const input = checkpointAndInstructionV1();
  const checkpoint = projectLegacyCheckpointV2Local({
    sourceBytes: sourceBytes(input.checkpoint),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt,
    migrationAllowance: null,
  });
  assert.deepEqual(checkpoint.deliveryCandidates[0].candidates.map((item) => item.variant),
    ['current', 'maxFutureDetail']);
  const instruction = projectLegacyInstructionJournalV1Local({
    sourceBytes: sourceBytes({ schemaVersion: 1, revision: 4, instructions: [input.instruction] }),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt,
    checkpointSnapshot: checkpoint.snapshot,
    migrationAllowance: null,
  });
  assert.deepEqual(instruction.instructionCandidates[0].candidates.map((item) => item.variant),
    ['current', 'maxFutureDetail']);
});

test('legacy checkpoint and question helper produce stable raw and normalized fingerprints', () => {
  const checkpointBytes = sourceBytes(checkpointV2());
  const checkpoint = projectLegacyCheckpointV2Local({
    sourceBytes: checkpointBytes,
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowance: null,
  });
  const questionBytes = sourceBytes(questionJournal(questionRecord()));
  const question = projectLegacyQuestionJournalV1Local({
    sourceBytes: questionBytes,
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    checkpointSnapshot: checkpoint.snapshot,
    migrationAllowance: null,
  });

  assert.equal(checkpoint.source.sha256.length, 64);
  assert.equal(checkpoint.source.sizeBytes, checkpointBytes.length);
  assert.equal(checkpoint.snapshot.schemaVersion, 3);
  assert.equal(question.source.sha256.length, 64);
  assert.equal(question.source.sizeBytes, questionBytes.length);
  assert.equal(question.targets[0].recordDigest.length, 64);
  assert.equal(question.snapshot.questions[0].deliveryCreationState, 'not_created');
});

test('migration projection rejects an outer revision that cannot advance safely', () => {
  const source = questionJournal(questionRecord());
  source.revision = Number.MAX_SAFE_INTEGER;
  assert.throws(() => fullProjection(sourceBytes(source)), TypeError);
});

test('checkpoint projection rejects either outer or ledger revision overflow', () => {
  for (const field of ['revision', 'ledger.revision']) {
    const checkpoint = checkpointV2();
    if (field === 'revision') checkpoint.revision = Number.MAX_SAFE_INTEGER;
    else checkpoint.ledger.revision = Number.MAX_SAFE_INTEGER;
    assert.throws(() => projectLegacyCheckpointV2Local({
      sourceBytes: sourceBytes(checkpoint),
      storeId: STORE_ID,
      operationId: OPERATION_ID,
      startedAt: STARTED_AT,
      migrationAllowance: null,
    }), TypeError);
  }
});

test('strict projection and encoding do not call inherited toJSON getters', () => {
  const inputBytes = sourceBytes(questionJournal(questionRecord()));
  const baseline = fullProjection(inputBytes);
  const originalObjectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const originalArrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let calls = 0;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get() { calls += 1; throw new Error('unexpected Object.prototype.toJSON'); },
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      get() { calls += 1; throw new Error('unexpected Array.prototype.toJSON'); },
    });
    const current = fullProjection(inputBytes);
    assert.equal(calls, 0);
    assert.equal(current.slots.questions.target.sha256, baseline.slots.questions.target.sha256);
    assert.deepEqual(current.slots.questions.target.encoded.bytes, baseline.slots.questions.target.encoded.bytes);
    assert.deepEqual(current.anchorEncoded.bytes, baseline.anchorEncoded.bytes);
  } finally {
    if (originalObjectToJSON) Object.defineProperty(Object.prototype, 'toJSON', originalObjectToJSON);
    else delete Object.prototype.toJSON;
    if (originalArrayToJSON) Object.defineProperty(Array.prototype, 'toJSON', originalArrayToJSON);
    else delete Array.prototype.toJSON;
  }
});

test('checkpoint projection and record candidates do not call inherited toJSON getters', () => {
  const checkpointBytes = sourceBytes(checkpointWithInstructionDelivery());
  const baseline = projectLegacyCheckpointV2Local({
    sourceBytes: checkpointBytes,
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowance: null,
  });
  const originalObjectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const originalArrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let calls = 0;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get() { calls += 1; throw new Error('unexpected Object.prototype.toJSON'); },
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      get() { calls += 1; throw new Error('unexpected Array.prototype.toJSON'); },
    });
    const current = projectLegacyCheckpointV2Local({
      sourceBytes: checkpointBytes,
      storeId: STORE_ID,
      operationId: OPERATION_ID,
      startedAt: STARTED_AT,
      migrationAllowance: null,
    });
    assert.equal(calls, 0);
    assert.equal(current.sha256, baseline.sha256);
    assert.deepEqual(current.encoded.bytes, baseline.encoded.bytes);
    assert.deepEqual(current.deliveryCandidates[0], baseline.deliveryCandidates[0]);
  } finally {
    if (originalObjectToJSON) Object.defineProperty(Object.prototype, 'toJSON', originalObjectToJSON);
    else delete Object.prototype.toJSON;
    if (originalArrayToJSON) Object.defineProperty(Array.prototype, 'toJSON', originalArrayToJSON);
    else delete Array.prototype.toJSON;
  }
});

test('projection option accessors are rejected without invoking the getter', () => {
  let calls = 0;
  const options = {
    configuredSlots: ['questions'],
    sourceBytesBySlot: { questions: sourceBytes(questionJournal(questionRecord())) },
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowanceBySlot: { questions: null },
  };
  Object.defineProperty(options, 'startedAt', {
    enumerable: true,
    configurable: true,
    get() { calls += 1; return STARTED_AT; },
  });
  assert.throws(() => projectLegacyReclamationMigrationLocal(options), TypeError);
  assert.equal(calls, 0);
});

test('delivery future projection preserves cancellation and fills missing accepted correlation from applied evidence', () => {
  const checkpoint = checkpointWithInstructionDelivery();
  const sourceBytesFor = (value) => sourceBytes(value);
  const project = (value) => projectLegacyCheckpointV2Local({
    sourceBytes: sourceBytesFor(value),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowance: null,
  });
  const availableProjection = project(checkpoint);
  const availableFuture = availableProjection.deliveryCandidates[0].candidates
    .find(({ variant }) => variant === 'maxFutureDetail').record;
  assert.equal(availableFuture.cancelRequested, false);

  const deliveryAttemptId = checkpoint.ledger.deliveries[0].deliveryAttemptId;
  const acceptedCorrelation = {
    deliveryAttemptId,
    revision: checkpoint.ledger.deliveries[0].revision,
    payloadDigest: checkpoint.ledger.deliveries[0].payloadDigest,
    targetPeriodId: checkpoint.ledger.deliveries[0].target.periodId,
    nativeTurnId: 'turn-long',
    nativeItemId: null,
    clientRequestId: deliveryAttemptId,
  };
  const appliedCorrelation = { ...acceptedCorrelation, nativeItemId: '\uD800'.repeat(512) };
  let appliedLedger = transitionDelivery(checkpoint.ledger, deliveryAttemptId, 'sendStart').ledger;
  appliedLedger = transitionDelivery(appliedLedger, deliveryAttemptId, 'accepted', acceptedCorrelation).ledger;
  appliedLedger = transitionDelivery(appliedLedger, deliveryAttemptId, 'applied', appliedCorrelation).ledger;
  const appliedProjection = project({ ...checkpoint, ledger: appliedLedger });
  const { candidates } = appliedProjection.deliveryCandidates[0];
  const current = candidates.find(({ variant }) => variant === 'current').record;
  const future = candidates.find(({ variant }) => variant === 'maxFutureDetail').record;
  assert.equal(current.acceptedCorrelation.nativeItemId, null);
  assert.equal(future.cancelRequested, false);
  assert.equal(future.acceptedCorrelation.nativeTurnId, 'turn-long');
  assert.equal(future.acceptedCorrelation.nativeItemId, appliedCorrelation.nativeItemId);

  const expanded = structuredClone(appliedProjection.snapshot);
  expanded.ledger.deliveries[0] = future;
  assert.ok(encodeCheckpointV3Local(expanded).sizeBytes > appliedProjection.encoded.sizeBytes);
});
