'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { createQuestionRecord, selectionFor } = require('../src/server/common-question-kernel');
const { createDelivery, createEmptyLedger } = require('../src/server/delivery-ledger');
const { makeEmptyCheckpoint } = require('../src/server/durable-checkpoint');
const { normalizeQuestionJournalV2Local } = require('../src/server/common-question-reclamation-codec');
const { normalizeCheckpointV3Local } = require('../src/server/delivery-reclamation-codec');
const { encodeNormalized } = require('../src/server/reclamation-json-codec');
const { measureMigrationAllowance } = require('../src/server/reclamation-capacity-bounds');
const {
  createEmptyCheckpointV3TargetLocal,
  createEmptyInstructionJournalV2TargetLocal,
  createEmptyQuestionJournalV2TargetLocal,
  projectLegacyReclamationMigrationLocal,
} = require('../src/server/reclamation-migration-projection');
const {
  inspectReclamationMigrationSnapshot,
  validateReclamationSnapshot,
  validateReclamationTransition,
} = require('../src/server/reclamation-store-consistency');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const STARTED_AT = 1_000_000;
const BYTE_LIMITS = { questions: 16_777_216, checkpoint: 16_777_216, instructions: 16_777_216 };

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function emptyAnchor(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 0,
    storeId: STORE_ID,
    retiredQuestionPeriods: [],
    migration: null,
    ...overrides,
  };
}

function emptyStores() {
  return {
    questions: createEmptyQuestionJournalV2TargetLocal({ storeId: STORE_ID }).snapshot,
    checkpoint: createEmptyCheckpointV3TargetLocal({ storeId: STORE_ID }).snapshot,
    instructions: createEmptyInstructionJournalV2TargetLocal({ storeId: STORE_ID }).snapshot,
  };
}

function legacyQuestion() {
  return createQuestionRecord({
    internalQuestionId: 'internal-1',
    questionId: 'public-1',
    identity: {
      provider: 'claude', nativeIdKind: 'session', hostId: 'host-1',
      homeScopeId: 'home-1', nativeId: 'native-1',
    },
    periodId: 'period-1',
    executionId: 'execution-1',
    conversationId: 'conversation-1',
    launchRef: 'launch-1',
    executionBinding: { periodId: 'period-1', actor: { kind: 'agent', id: 'actor-1' } },
    category: 'ordinary',
    questions: [{
      id: 'q-1', text: 'Choose one', mode: 'single',
      options: [{ id: 'option-1', label: 'First', description: '' }],
      allowFreeText: true, recommendedOptionId: 'option-1',
    }],
    timeoutMinutes: 1,
    createdAt: 10_000,
  });
}

function projectQuestion(sourceBytes = Buffer.from(JSON.stringify({
  schemaVersion: 1, revision: 7, questions: [legacyQuestion()],
}))) {
  return projectLegacyReclamationMigrationLocal({
    configuredSlots: ['questions'],
    sourceBytesBySlot: { questions: sourceBytes },
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowanceBySlot: { questions: null },
  });
}

function selectedLegacyQuestion() {
  const question = legacyQuestion();
  return selectionFor(question, [{
    questionId: question.questions[0].id,
    optionIds: ['option-1'],
    freeText: null,
  }], 'manual', question.createdAt + 1_000, 'selection-1').record;
}

function launchForQuestion(question) {
  return {
    launchRef: question.launchRef,
    launchId: 'launch-id',
    runId: 'run-id',
    attemptId: 'attempt-id',
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
    sessionId: 'session-1',
    currentOwner: question.executionBinding,
    ownerGeneration: 0,
  };
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

function legacyCheckpointForQuestion(question) {
  const launch = launchForQuestion(question);
  const ledger = createDelivery(createEmptyLedger(), 'question', {
    deliveryAttemptId: question.deliveryIntent.deliveryAttemptId,
    logicalMessageId: question.deliveryIntent.logicalMessageId,
    revision: question.deliveryIntent.revision,
    payload: JSON.stringify({
      questionId: question.questionId,
      revision: question.deliveryIntent.revision,
      answers: question.selection.answers,
    }),
  }, launch).ledger;
  return legacyCheckpointWithLaunch(launch, ledger);
}

function selectedQuestionProjection(withCheckpoint) {
  const question = selectedLegacyQuestion();
  const questionBytes = Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, questions: [question] }));
  const checkpointBytes = withCheckpoint
    ? Buffer.from(JSON.stringify(legacyCheckpointForQuestion(question)))
    : null;
  const configuredSlots = withCheckpoint ? ['questions', 'checkpoint'] : ['questions'];
  const sourceBytesBySlot = withCheckpoint
    ? { questions: questionBytes, checkpoint: checkpointBytes }
    : { questions: questionBytes };
  const migrationAllowanceBySlot = withCheckpoint
    ? { questions: null, checkpoint: null }
    : { questions: null };
  return projectLegacyReclamationMigrationLocal({
    configuredSlots,
    sourceBytesBySlot,
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowanceBySlot,
  });
}

function instructionProjection() {
  const launch = launchForQuestion(legacyQuestion());
  const input = [{ type: 'text', text: 'instruction-payload', text_elements: [] }];
  const envelope = JSON.stringify({
    schemaVersion: 1,
    mode: 'start',
    expectedTurnId: null,
    input,
  });
  const createdLedger = createDelivery(createEmptyLedger(), 'instruction', {
    deliveryAttemptId: 'attempt-instruction',
    logicalMessageId: 'logical-instruction',
    revision: 3,
    payload: envelope,
  }, launch).ledger;
  const ledger = structuredClone(createdLedger);
  ledger.deliveries[0].state = 'cancelled_before_send';
  const checkpoint = legacyCheckpointWithLaunch(launch, ledger);
  const instruction = {
    deliveryAttemptId: 'attempt-instruction',
    launchRef: launch.launchRef,
    logicalMessageId: 'logical-instruction',
    revision: 3,
    source: ledger.deliveries[0].source,
    envelope,
    envelopeDigest: sha256(Buffer.from(envelope, 'utf8')),
    nativeContentDigest: sha256(Buffer.from(JSON.stringify(input), 'utf8')),
    createdAt: 12_000,
  };
  return projectLegacyReclamationMigrationLocal({
    configuredSlots: ['checkpoint', 'instructions'],
    sourceBytesBySlot: {
      checkpoint: Buffer.from(JSON.stringify(checkpoint), 'utf8'),
      instructions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, instructions: [instruction] }), 'utf8'),
    },
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowanceBySlot: { checkpoint: null, instructions: null },
  });
}

function fullThreeSlotProjection() {
  const question = selectedLegacyQuestion();
  const launch = launchForQuestion(question);
  const checkpoint = legacyCheckpointForQuestion(question);
  const input = [{ type: 'text', text: 'instruction-payload', text_elements: [] }];
  const envelope = JSON.stringify({
    schemaVersion: 1,
    mode: 'start',
    expectedTurnId: null,
    input,
  });
  const combinedLedger = createDelivery(checkpoint.ledger, 'instruction', {
    deliveryAttemptId: 'attempt-instruction',
    logicalMessageId: 'logical-instruction',
    revision: 3,
    payload: envelope,
  }, launch).ledger;
  checkpoint.ledger = structuredClone(combinedLedger);
  const instruction = {
    deliveryAttemptId: 'attempt-instruction',
    launchRef: launch.launchRef,
    logicalMessageId: 'logical-instruction',
    revision: 3,
    source: combinedLedger.deliveries.find((delivery) => delivery.kind === 'instruction').source,
    envelope,
    envelopeDigest: sha256(Buffer.from(envelope, 'utf8')),
    nativeContentDigest: sha256(Buffer.from(JSON.stringify(input), 'utf8')),
    createdAt: 12_000,
  };
  const sourceBytesBySlot = {
    checkpoint: Buffer.from(JSON.stringify(checkpoint), 'utf8'),
    instructions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, instructions: [instruction] }), 'utf8'),
    questions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, questions: [question] }), 'utf8'),
  };
  const projection = projectLegacyReclamationMigrationLocal({
    configuredSlots: ['checkpoint', 'instructions', 'questions'],
    sourceBytesBySlot,
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowanceBySlot: { checkpoint: null, instructions: null, questions: null },
  });
  return { projection, sourceBytesBySlot };
}

function questionGrantForProjection(projection, sourceBytes) {
  const slot = projection.slots.questions;
  const source = projection.anchor.migration.sources.find((item) => item.slot === 'questions');
  const grant = {
    operationId: OPERATION_ID,
    sourceSchemaVersion: source.schemaVersion,
    sourceSizeBytes: source.sizeBytes,
    sourceSha256: source.sha256,
    maxExtraBytes: Number.MAX_SAFE_INTEGER,
    eligibleQuestionIds: slot.eligibleIds,
  };
  const candidateProjection = (includeGrant) => Object.fromEntries(
    ['migration', 'retained', 'prepared', 'reclaimed'].map((boundary) => {
      const original = slot.candidateSnapshotsByBoundary[boundary];
      const snapshot = structuredClone(original.snapshot);
      if (includeGrant) snapshot.migrationAllowance = grant;
      return [boundary, { snapshot, encoded: encodeNormalized(snapshot) }];
    }),
  );
  const measured = measureMigrationAllowance({
    slot: 'questions',
    sourcePresent: true,
    sourceSchemaVersion: source.schemaVersion,
    sourceRevision: source.revision,
    sourceSizeBytes: source.sizeBytes,
    sourceSha256: source.sha256,
    currentByteLimit: source.sizeBytes,
    anchor: projection.anchor,
    eligibleIds: slot.eligibleIds,
    projections: {
      withoutGrant: candidateProjection(false),
      withMaximumGrant: candidateProjection(true),
    },
  });
  assert.ok(sourceBytes.length > 0);
  return measured;
}

function asCreatingQuestionStore(snapshot) {
  const store = structuredClone(snapshot);
  for (const detail of store.questions) {
    detail.deliveryCreationState = 'creating';
    detail.quarantinedAt = null;
  }
  for (const reservation of store.reservations) {
    reservation.deliveryCreationState = 'creating';
    reservation.checkpointState = null;
    reservation.sourceClaimsDigest = null;
    reservation.sessionId = null;
    reservation.terminalResultKind = null;
    reservation.quarantinedAt = null;
  }
  return normalizeQuestionJournalV2Local(store);
}

function retiredQuestionSnapshot(withCheckpoint) {
  const projection = selectedQuestionProjection(withCheckpoint);
  const questions = asCreatingQuestionStore(projection.slots.questions.target.snapshot);
  const anchor = emptyAnchor({ retiredQuestionPeriods: [retiredPeriodFor(questions)] });
  const result = validateReclamationSnapshot({
    anchor,
    stores: {
      checkpoint: withCheckpoint ? projection.slots.checkpoint.target.snapshot : null,
      instructions: null,
      questions,
    },
  });
  return { anchor: result.snapshot.anchor, stores: structuredClone(result.snapshot.stores) };
}

function setQuestionCreation(store, state, checkpointState, sourceClaimsDigest = null, sessionId = null) {
  const detail = store.questions[0];
  const reservation = store.reservations[0];
  detail.deliveryCreationState = state;
  reservation.deliveryCreationState = state;
  reservation.checkpointState = checkpointState;
  reservation.sourceClaimsDigest = sourceClaimsDigest;
  reservation.sessionId = sessionId;
  reservation.terminalResultKind = null;
}

function retiredPeriodFor(snapshot, retiredAt = STARTED_AT) {
  const question = snapshot.questions[0];
  return {
    identity: question.identity,
    periodId: question.periodId,
    retiredAt,
    reason: 'confirmed-retirement',
  };
}

function claimsDigest(claims) {
  return createHash('sha256').update(JSON.stringify(claims), 'utf8').digest('hex');
}

function graveFromDetail(detail, operationId, reclaimedAt, reason = 'retired_question_period') {
  const { source, target, ...common } = detail;
  return {
    ...common,
    recordType: 'reclaimed',
    sourceRef: {
      launchRef: source.launchRef,
      launchKey: [source.claims.launchId, source.claims.runId, source.claims.attemptId],
      sourceClaimsDigest: claimsDigest(source.claims),
      identity: source.identity,
      executionBinding: source.executionBinding,
      conversationId: source.conversationId,
      sessionId: source.sessionId,
    },
    targetRef: {
      kind: target.kind,
      launchRef: target.launchRef,
      launchKey: [target.claims.launchId, target.claims.runId, target.claims.attemptId],
      targetClaimsDigest: claimsDigest(target.claims),
      identity: target.identity,
      periodId: target.periodId,
      actor: target.actor,
      conversationId: target.conversationId,
      sessionId: target.sessionId,
    },
    reclamation: { operationId, reclaimedAt, reason },
  };
}

function bytesBySlot({ checkpoint = null, instructions = null, questions = null } = {}) {
  return { checkpoint, instructions, questions };
}

test('empty normalized stores pass current snapshot validation', () => {
  const result = validateReclamationSnapshot({ anchor: emptyAnchor(), stores: emptyStores() });
  assert.equal(result.status, 'ready');
  assert.deepEqual(result.reasons, []);
  assert.equal(result.snapshot.stores.checkpoint.ledger.schemaVersion, 2);
});

test('prepared migration source is validated and classified as reconciliation-required', () => {
  const sourceBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1, revision: 7, questions: [legacyQuestion()],
  }));
  const projection = projectQuestion(sourceBytes);
  const result = inspectReclamationMigrationSnapshot({
    anchor: projection.anchor,
    slotBytesBySlot: bytesBySlot({ questions: sourceBytes }),
  });

  assert.equal(result.status, 'reconciliation-required');
  assert.equal(result.phase, 'prepared');
  assert.equal(result.prefixLength, 0);
  assert.equal(result.snapshot.stores.questions.revision, 8);
  assert.equal(result.snapshot.stores.questions.questions[0].quarantinedAt, STARTED_AT);
});

test('prepared source projection reconstructs the bound non-null migration grant', () => {
  const sourceBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1, revision: 7, questions: [legacyQuestion()],
  }));
  const withoutGrant = projectQuestion(sourceBytes);
  const grant = questionGrantForProjection(withoutGrant, sourceBytes);
  assert.ok(grant);

  const withGrant = projectLegacyReclamationMigrationLocal({
    configuredSlots: ['questions'],
    sourceBytesBySlot: { questions: sourceBytes },
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowanceBySlot: { questions: grant },
  });
  const result = inspectReclamationMigrationSnapshot({
    anchor: withGrant.anchor,
    slotBytesBySlot: bytesBySlot({ questions: sourceBytes }),
  });

  assert.equal(result.status, 'reconciliation-required');
  assert.deepEqual(result.snapshot.stores.questions.migrationAllowance, grant);
  assert.equal(result.snapshot.stores.questions.migrationAllowance.maxExtraBytes, grant.maxExtraBytes);
});

test('installing source projection reconstructs a fixed grant without changing the manifest phase', () => {
  const sourceBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1, revision: 7, questions: [legacyQuestion()],
  }));
  const withoutGrant = projectQuestion(sourceBytes);
  const grant = questionGrantForProjection(withoutGrant, sourceBytes);
  const withGrant = projectLegacyReclamationMigrationLocal({
    configuredSlots: ['questions'],
    sourceBytesBySlot: { questions: sourceBytes },
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowanceBySlot: { questions: grant },
  });
  const anchor = structuredClone(withGrant.anchor);
  anchor.migration.phase = 'installing';
  const result = inspectReclamationMigrationSnapshot({
    anchor,
    slotBytesBySlot: bytesBySlot({ questions: sourceBytes }),
  });

  assert.equal(result.phase, 'installing');
  assert.equal(result.snapshot.anchor.migration.phase, 'installing');
  assert.equal(anchor.migration.phase, 'installing');
  assert.deepEqual(result.snapshot.stores.questions.migrationAllowance, grant);
  assert.deepEqual(result.snapshot.stores.questions, withGrant.slots.questions.target.snapshot);
});

test('a completed migration manifest still requires reconciliation on current snapshots', () => {
  const projection = projectQuestion();
  const anchor = structuredClone(projection.anchor);
  anchor.migration.phase = 'completed';
  const result = validateReclamationSnapshot({
    anchor,
    stores: {
      checkpoint: null,
      instructions: null,
      questions: projection.slots.questions.target.snapshot,
    },
  });

  assert.equal(result.status, 'reconciliation-required');
  assert.deepEqual(result.reasons, ['migration_in_progress']);
});

test('clearing a source-bound grant requires the normal budget to cover future reservations', () => {
  const sourceBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1, revision: 7, questions: [legacyQuestion()],
  }));
  const withoutGrant = projectQuestion(sourceBytes);
  const grant = questionGrantForProjection(withoutGrant, sourceBytes);
  const withGrant = projectLegacyReclamationMigrationLocal({
    configuredSlots: ['questions'],
    sourceBytesBySlot: { questions: sourceBytes },
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowanceBySlot: { questions: grant },
  });
  const anchor = emptyAnchor({
    revision: 1,
    retiredQuestionPeriods: withGrant.anchor.retiredQuestionPeriods,
  });
  const previousStores = {
    checkpoint: null,
    instructions: null,
    questions: withGrant.slots.questions.target.snapshot,
  };
  const nextStores = structuredClone(previousStores);
  nextStores.questions.migrationAllowance = null;
  nextStores.questions.revision += 1;
  const transition = {
    previous: anchor,
    next: anchor,
    previousStores,
    nextStores,
  };

  assert.equal(validateReclamationTransition({
    ...transition,
    normalByteLimitsBySlot: { questions: 16_777_216, checkpoint: null, instructions: null },
  }).status, 'ready');
  assert.throws(() => validateReclamationTransition({
    ...transition,
    normalByteLimitsBySlot: { questions: 1, checkpoint: null, instructions: null },
  }), TypeError);
});

test('installing migration accepts only a target prefix in fixed slot order', () => {
  const projection = projectQuestion();
  const installingAnchor = structuredClone(projection.anchor);
  installingAnchor.migration.phase = 'installing';
  const result = inspectReclamationMigrationSnapshot({
    anchor: installingAnchor,
    slotBytesBySlot: bytesBySlot({ questions: projection.slots.questions.target.encoded.bytes }),
  });
  assert.equal(result.prefixLength, 1);

  const preparedAnchor = structuredClone(projection.anchor);
  assert.throws(() => inspectReclamationMigrationSnapshot({
    anchor: preparedAnchor,
    slotBytesBySlot: bytesBySlot({ questions: projection.slots.questions.target.encoded.bytes }),
  }), TypeError);
});

test('migration inspector validates all three-slot fixed-order prefixes', () => {
  const { projection, sourceBytesBySlot } = fullThreeSlotProjection();
  const slots = ['checkpoint', 'instructions', 'questions'];
  const inputForPrefix = (prefixLength, phase) => {
    const anchor = structuredClone(projection.anchor);
    anchor.migration.phase = phase;
    const slotBytesBySlot = Object.fromEntries(slots.map((slot, index) => [
      slot,
      index < prefixLength ? projection.slots[slot].target.encoded.bytes : sourceBytesBySlot[slot],
    ]));
    return { anchor, slotBytesBySlot };
  };

  for (const [phase, prefixLength] of [
    ['prepared', 0],
    ['guarded', 1],
    ['installing', 1],
    ['guarded', 2],
    ['installing', 2],
    ['completed', 3],
  ]) {
    const result = inspectReclamationMigrationSnapshot(inputForPrefix(prefixLength, phase));
    assert.equal(result.phase, phase);
    assert.equal(result.prefixLength, prefixLength);
  }

  for (const targetSlots of [['questions'], ['instructions'], ['checkpoint', 'questions']]) {
    const { anchor, slotBytesBySlot } = inputForPrefix(0, 'installing');
    for (const slot of targetSlots) {
      slotBytesBySlot[slot] = projection.slots[slot].target.encoded.bytes;
    }
    assert.throws(() => inspectReclamationMigrationSnapshot({ anchor, slotBytesBySlot }), TypeError);
  }
});

test('a matching raw fingerprint does not admit a malformed legacy source', () => {
  const projection = projectQuestion();
  const invalidSource = Buffer.from(JSON.stringify({ schemaVersion: 99, revision: 7, questions: [] }));
  const anchor = structuredClone(projection.anchor);
  const descriptor = anchor.migration.sources[0];
  descriptor.sizeBytes = invalidSource.length;
  descriptor.sha256 = sha256(invalidSource);

  assert.throws(() => inspectReclamationMigrationSnapshot({
    anchor,
    slotBytesBySlot: bytesBySlot({ questions: invalidSource }),
  }), TypeError);
});

test('snapshot normalization rejects accessors without invoking them', () => {
  let calls = 0;
  const stores = {
    checkpoint: null,
    instructions: null,
    questions: null,
  };
  Object.defineProperty(stores, 'questions', {
    enumerable: true,
    get() { calls += 1; return null; },
  });
  assert.throws(() => validateReclamationSnapshot({ anchor: emptyAnchor(), stores }), TypeError);
  assert.equal(calls, 0);
});

test('consistency normalization does not invoke inherited toJSON getters', () => {
  const stores = emptyStores();
  const baselineAnchor = emptyAnchor();
  const projection = projectQuestion();
  const snapshotInput = { anchor: baselineAnchor, stores };
  const transitionInput = {
    previous: baselineAnchor,
    next: baselineAnchor,
    previousStores: stores,
    nextStores: stores,
    normalByteLimitsBySlot: BYTE_LIMITS,
  };
  const migrationInput = {
    anchor: projection.anchor,
    slotBytesBySlot: bytesBySlot({
      questions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, questions: [legacyQuestion()] })),
    }),
  };
  const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let calls = 0;
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get() { calls += 1; throw new Error('inherited object toJSON invoked'); },
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      get() { calls += 1; throw new Error('inherited array toJSON invoked'); },
    });
    assert.doesNotThrow(() => validateReclamationSnapshot(snapshotInput));
    assert.doesNotThrow(() => validateReclamationTransition(transitionInput));
    assert.doesNotThrow(() => inspectReclamationMigrationSnapshot(migrationInput));
    assert.equal(calls, 0);
  } finally {
    if (objectDescriptor === undefined) delete Object.prototype.toJSON;
    else Object.defineProperty(Object.prototype, 'toJSON', objectDescriptor);
    if (arrayDescriptor === undefined) delete Array.prototype.toJSON;
    else Object.defineProperty(Array.prototype, 'toJSON', arrayDescriptor);
  }
});

test('initial and append-only anchor transitions are accepted', () => {
  const stores = emptyStores();
  const initial = validateReclamationTransition({
    previous: null,
    next: emptyAnchor(),
    previousStores: null,
    nextStores: stores,
    normalByteLimitsBySlot: BYTE_LIMITS,
  });
  assert.equal(initial.status, 'ready');

  const retired = {
    identity: {
      provider: 'claude', nativeIdKind: 'session', hostId: 'host-1',
      homeScopeId: 'home-1', nativeId: 'native-1',
    },
    periodId: 'period-1',
    retiredAt: STARTED_AT,
    reason: 'confirmed-retirement',
  };
  const appendedAnchor = emptyAnchor({ revision: 1, retiredQuestionPeriods: [retired] });
  const appended = validateReclamationTransition({
    previous: emptyAnchor(),
    next: appendedAnchor,
    previousStores: stores,
    nextStores: stores,
    normalByteLimitsBySlot: BYTE_LIMITS,
  });
  assert.equal(appended.status, 'ready');
  assert.throws(() => validateReclamationTransition({
    previous: appendedAnchor,
    next: emptyAnchor({ revision: 2 }),
    previousStores: stores,
    nextStores: stores,
    normalByteLimitsBySlot: BYTE_LIMITS,
  }), TypeError);
});

test('anchor store identity cannot change across snapshots', () => {
  const stores = emptyStores();
  assert.throws(() => validateReclamationTransition({
    previous: emptyAnchor(),
    next: emptyAnchor({ revision: 1, storeId: '33333333-3333-4333-8333-333333333333' }),
    previousStores: stores,
    nextStores: emptyStores(),
    normalByteLimitsBySlot: BYTE_LIMITS,
  }), TypeError);
});

test('a question cannot be registered in a period retired by the previous or next anchor', () => {
  const projection = projectQuestion();
  const targetRetired = projection.anchor.retiredQuestionPeriods;
  const scenarios = [
    {
      previousRetired: targetRetired,
      nextRetired: targetRetired,
      previousRevision: 0,
      nextRevision: 0,
    },
    {
      previousRetired: [],
      nextRetired: targetRetired,
      previousRevision: 0,
      nextRevision: 1,
    },
  ];

  for (const scenario of scenarios) {
    const previousAnchor = emptyAnchor({
      revision: scenario.previousRevision,
      retiredQuestionPeriods: scenario.previousRetired,
    });
    const nextAnchor = emptyAnchor({
      revision: scenario.nextRevision,
      retiredQuestionPeriods: scenario.nextRetired,
    });
    assert.throws(() => validateReclamationTransition({
      previous: previousAnchor,
      next: nextAnchor,
      previousStores: { checkpoint: null, instructions: null, questions: emptyStores().questions },
      nextStores: {
        checkpoint: null,
        instructions: null,
        questions: projection.slots.questions.target.snapshot,
      },
      normalByteLimitsBySlot: { checkpoint: null, instructions: null, questions: 16_777_216 },
    }), TypeError);
  }
});

test('retiring a selected question during creation preserves quarantine and reconciles both creation outcomes', () => {
  for (const withCheckpoint of [false, true]) {
    const projection = selectedQuestionProjection(withCheckpoint);
    const creating = asCreatingQuestionStore(projection.slots.questions.target.snapshot);
    const anchor = emptyAnchor({ retiredQuestionPeriods: [retiredPeriodFor(creating)] });
    const result = validateReclamationSnapshot({
      anchor,
      stores: {
        checkpoint: withCheckpoint ? projection.slots.checkpoint.target.snapshot : null,
        instructions: null,
        questions: creating,
      },
    });

    const detail = result.snapshot.stores.questions.questions[0];
    const reservation = result.snapshot.stores.questions.reservations[0];
    assert.equal(result.status, 'reconciliation-required');
    assert.equal(detail.quarantinedAt, STARTED_AT);
    assert.equal(reservation.quarantinedAt, STARTED_AT);
    assert.equal(detail.deliveryCreationState, withCheckpoint ? 'checkpointed' : 'indeterminate');
    assert.equal(reservation.deliveryCreationState, withCheckpoint ? 'checkpointed' : 'indeterminate');
    assert.equal(reservation.checkpointState, withCheckpoint ? 'available' : 'unknown');
  }
});

test('persisted question quarantine rejects creation and checkpoint cache reconciliation', () => {
  const withCheckpoint = retiredQuestionSnapshot(true);
  const withoutCheckpoint = retiredQuestionSnapshot(false);
  const cases = [
    ['terminal delivery diverges from available cache', withCheckpoint, (stores) => {
      const delivery = stores.checkpoint.ledger.deliveries[0];
      delivery.state = 'cancelled_before_send';
      delivery.terminalAt = STARTED_AT + 1;
      delivery.cancelRequested = false;
    }],
    ['creation loses its checkpoint attempt', withoutCheckpoint, (stores) => {
      setQuestionCreation(stores.questions, 'creating', null);
    }],
    ['creation is completed from a later checkpoint attempt', withCheckpoint, (stores) => {
      setQuestionCreation(stores.questions, 'creating', null);
    }],
    ['claimed delivery is normalized to available', withCheckpoint, (stores) => {
      stores.checkpoint.ledger.deliveries[0].state = 'claimed';
      stores.questions.reservations[0].checkpointState = 'claimed';
    }],
    ['sending delivery is normalized to unknown', withCheckpoint, (stores) => {
      stores.checkpoint.ledger.deliveries[0].state = 'sending';
      stores.questions.reservations[0].checkpointState = 'sending';
    }],
    ['accepted delivery is normalized to unknown', withCheckpoint, (stores) => {
      const delivery = stores.checkpoint.ledger.deliveries[0];
      delivery.state = 'accepted';
      delivery.acceptedCorrelation = {
        deliveryAttemptId: delivery.deliveryAttemptId,
        revision: delivery.revision,
        payloadDigest: delivery.payloadDigest,
        targetPeriodId: delivery.target.periodId,
        nativeTurnId: 'turn-1',
        nativeItemId: null,
        clientRequestId: delivery.deliveryAttemptId,
      };
      stores.questions.reservations[0].checkpointState = 'accepted';
    }],
  ];

  for (const [description, previous, mutate] of cases) {
    const stores = structuredClone(previous.stores);
    mutate(stores);
    assert.throws(() => validateReclamationSnapshot({ anchor: previous.anchor, stores }), TypeError, description);
  }
});

test('prepared retired-question detail can transition to its matching checkpoint grave', () => {
  const projection = selectedQuestionProjection(true);
  const checked = validateReclamationSnapshot({
    anchor: emptyAnchor({ retiredQuestionPeriods: [retiredPeriodFor(projection.slots.questions.target.snapshot)] }),
    stores: {
      checkpoint: projection.slots.checkpoint.target.snapshot,
      instructions: null,
      questions: asCreatingQuestionStore(projection.slots.questions.target.snapshot),
    },
  });
  const preparedAt = STARTED_AT + 604_800_000;
  const previousStores = structuredClone(checked.snapshot.stores);
  previousStores.questions.revision += 1;
  previousStores.questions.reservations[0].reclamation = {
    operationId: '33333333-3333-4333-8333-333333333333',
    preparedAt,
    deliveryPresence: 'checkpoint',
    checkpointState: 'available',
  };
  const nextStores = structuredClone(previousStores);
  nextStores.checkpoint.revision += 1;
  nextStores.checkpoint.ledger.revision += 1;
  nextStores.checkpoint.ledger.deliveries[0] = graveFromDetail(
    nextStores.checkpoint.ledger.deliveries[0],
    previousStores.questions.reservations[0].reclamation.operationId,
    preparedAt,
  );

  const transition = validateReclamationTransition({
    previous: checked.snapshot.anchor,
    next: checked.snapshot.anchor,
    previousStores,
    nextStores,
    normalByteLimitsBySlot: { questions: 16_777_216, checkpoint: 16_777_216, instructions: null },
  });
  assert.equal(transition.status, 'ready');
  assert.equal(transition.snapshot.stores.checkpoint.ledger.deliveries[0].recordType, 'reclaimed');
});

test('an instruction checkpoint grave cannot skip the previously saved preparation boundary', () => {
  const projection = instructionProjection();
  const operationId = '33333333-3333-4333-8333-333333333333';
  const preparedAt = STARTED_AT + 604_800_010;
  const previousStores = {
    checkpoint: structuredClone(projection.slots.checkpoint.target.snapshot),
    instructions: structuredClone(projection.slots.instructions.target.snapshot),
    questions: null,
  };
  const nextStores = structuredClone(previousStores);
  const instruction = nextStores.instructions.instructions[0];
  instruction.reclamation = {
    operationId,
    preparedAt,
    terminalState: 'cancelled_before_send',
    terminalAt: STARTED_AT,
  };
  nextStores.instructions.revision += 1;
  const delivery = nextStores.checkpoint.ledger.deliveries[0];
  nextStores.checkpoint.revision += 1;
  nextStores.checkpoint.ledger.revision += 1;
  nextStores.checkpoint.ledger.deliveries[0] = graveFromDetail(
    delivery,
    operationId,
    preparedAt,
    'terminal_retention',
  );

  assert.equal(validateReclamationSnapshot({ anchor: emptyAnchor(), stores: previousStores }).status, 'ready');
  assert.equal(validateReclamationSnapshot({ anchor: emptyAnchor(), stores: nextStores }).status, 'ready');
  assert.throws(() => validateReclamationTransition({
    previous: emptyAnchor(),
    next: emptyAnchor(),
    previousStores,
    nextStores,
    normalByteLimitsBySlot: { checkpoint: 16_777_216, instructions: 16_777_216, questions: null },
  }), TypeError);

  const preparedPreviousStores = structuredClone(previousStores);
  preparedPreviousStores.instructions.instructions[0].reclamation = {
    operationId,
    preparedAt,
    terminalState: 'cancelled_before_send',
    terminalAt: STARTED_AT,
  };
  const preparedNextStores = structuredClone(preparedPreviousStores);
  preparedNextStores.checkpoint.revision += 1;
  preparedNextStores.checkpoint.ledger.revision += 1;
  preparedNextStores.checkpoint.ledger.deliveries[0] = graveFromDetail(
    preparedNextStores.checkpoint.ledger.deliveries[0],
    operationId,
    preparedAt,
    'terminal_retention',
  );
  assert.equal(validateReclamationTransition({
    previous: emptyAnchor(),
    next: emptyAnchor(),
    previousStores: preparedPreviousStores,
    nextStores: preparedNextStores,
    normalByteLimitsBySlot: { checkpoint: 16_777_216, instructions: 16_777_216, questions: null },
  }).status, 'ready');
});

test('a reclaimed instruction and its checkpoint grave must both respect the preparation time', () => {
  const projection = instructionProjection();
  const operationId = '33333333-3333-4333-8333-333333333333';
  const preparedAt = STARTED_AT + 604_800_010;
  const makeStores = (deliveryReclaimedAt) => {
    const stores = structuredClone({
      checkpoint: projection.slots.checkpoint.target.snapshot,
      instructions: projection.slots.instructions.target.snapshot,
      questions: null,
    });
    const instruction = stores.instructions.instructions[0];
    instruction.reclamation = {
      operationId,
      preparedAt,
      terminalState: 'cancelled_before_send',
      terminalAt: STARTED_AT,
    };
    const { envelope, ...instructionCommon } = instruction;
    stores.instructions.instructions[0] = {
      ...instructionCommon,
      recordType: 'reclaimed',
      reclaimedAt: preparedAt,
    };
    const delivery = stores.checkpoint.ledger.deliveries[0];
    stores.checkpoint.ledger.deliveries[0] = graveFromDetail(
      delivery,
      operationId,
      deliveryReclaimedAt,
      'terminal_retention',
    );
    return stores;
  };

  assert.equal(validateReclamationSnapshot({
    anchor: emptyAnchor(),
    stores: makeStores(preparedAt),
  }).status, 'ready');
  assert.throws(() => validateReclamationSnapshot({
    anchor: emptyAnchor(),
    stores: makeStores(preparedAt - 1),
  }), TypeError);
});
