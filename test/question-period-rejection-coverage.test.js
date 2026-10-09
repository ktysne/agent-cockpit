'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { serialize } = require('node:v8');
const { createQuestionRecord } = require('../src/server/common-question-kernel');
const { createQuestionPeriodGate } = require('../src/server/question-period-gate');
const { createReclamationDelivery, getReclamationDelivery, registerReclamationTarget } =
  require('../src/server/delivery-reclamation-runtime');
const { questionCommonKeyDigest, normalizeQuestionJournalV2Local } =
  require('../src/server/common-question-reclamation-codec');
const { normalizeInstructionJournalV2Local } = require('../src/server/delivery-reclamation-codec');
const { MAX_SOURCE_BYTES } = require('../src/server/reclamation-capacity-bounds');
const { planInitialReclamationMigration } = require('../src/server/reclamation-migration-plan');
const { planQuestionBodyReclamation } = require('../src/server/question-body-reclamation');
const { planQuestionPeriodRetirement } = require('../src/server/question-period-retirement');
const { validateReclamationSnapshot, validateReclamationStoreWrite } =
  require('../src/server/reclamation-store-consistency');
const { threeSlotLegacySources } = require('./support/native-migration-allowance-release-harness');
const { analyzeQuestionPeriodRejectionCoverage } =
  require('../src/server/question-period-rejection-coverage');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const MIGRATION_ID = '22222222-2222-4222-8222-222222222222';
const RECLAMATION_ID = '33333333-3333-4333-8333-333333333333';
const STORE_FIELDS = ['questions', 'checkpoint', 'instructions'];
const RETIRED_AT = 2_000_000;
const RETENTION_MS = 604_800_000;

function makeQuestion(base, overrides) {
  return createQuestionRecord({
    internalQuestionId: overrides.internalQuestionId,
    questionId: overrides.questionId,
    identity: structuredClone(base.identity),
    periodId: overrides.periodId,
    executionId: overrides.executionId,
    conversationId: overrides.conversationId,
    launchRef: overrides.launchRef,
    executionBinding: structuredClone(overrides.executionBinding),
    category: 'ordinary',
    questions: structuredClone(base.questions),
    timeoutMinutes: 1,
    createdAt: overrides.createdAt,
  });
}

function appendOtherPeriodRegistration(checkpoint, base) {
  const identity = structuredClone(base.identity);
  const executionBinding = { periodId: 'period-2', actor: { kind: 'agent', id: 'actor-2' } };
  const claims = {
    launchId: 'launch-id-period-2',
    runId: 'run-id-period-2',
    attemptId: 'attempt-id-period-2',
    provider: identity.provider,
    nativeIdKind: identity.nativeIdKind,
    hostId: identity.hostId,
    homeScopeId: identity.homeScopeId,
    origin: 'standalone',
    purpose: 'agent',
    originBinding: null,
  };
  const immutableExecutionClaims = { ...claims, identity, executionBinding };
  const conversationId = base.conversationId;
  const sessionId = 'session-period-2';
  const launchRef = 'launch-period-2';
  const registration = checkpoint.registrations;
  const connectionScope = structuredClone(registration.connections[0].scope);

  registration.executions.push({
    conversationId,
    executionId: executionBinding.periodId,
    sessionId,
    state: 'active',
  });
  registration.launches.push({
    launchRef,
    claims,
    state: 'bound',
    identity,
    executionBinding,
    conversationId,
    sessionId,
  });
  registration.runtimeLaunches.push({
    launchRef,
    claims: immutableExecutionClaims,
    state: 'bound',
    conversationId,
    sessionId,
    currentOwner: executionBinding,
    ownerGeneration: 0,
  });
  registration.actors.push({
    identity,
    periodId: executionBinding.periodId,
    actor: executionBinding.actor,
    contextId: 'context-period-2',
    launchRef,
    immutableExecutionClaims,
    connectionScope,
    connectionGeneration: registration.connections[0].generation,
    state: 'active',
  });
  return { launchRef, executionBinding, conversationId };
}

function createFixture(provider, { omitQuestionDelivery = false } = {}) {
  const sources = { ...threeSlotLegacySources(provider) };
  const selected = sources.question;
  const checkpoint = JSON.parse(sources.checkpoint.toString('utf8'));
  if (omitQuestionDelivery) {
    const attemptId = selected.deliveryIntent.deliveryAttemptId;
    checkpoint.ledger.deliveries = checkpoint.ledger.deliveries.filter((item) =>
      item.deliveryAttemptId !== attemptId);
    checkpoint.ledger.logicalTombstones = checkpoint.ledger.logicalTombstones.filter((item) =>
      !(item.kind === 'question' && item.logicalMessageId === selected.deliveryIntent.logicalMessageId));
  }
  const otherPeriodRegistration = appendOtherPeriodRegistration(checkpoint, selected);
  const samePeriodUnselected = makeQuestion(selected, {
    internalQuestionId: 'internal-unselected-period-1',
    questionId: 'public-unselected-period-1',
    periodId: selected.periodId,
    executionId: selected.executionId,
    conversationId: selected.conversationId,
    launchRef: selected.launchRef,
    executionBinding: selected.executionBinding,
    createdAt: 12_000,
  });
  const otherPeriodUnselected = makeQuestion(selected, {
    internalQuestionId: 'internal-unselected-period-2',
    questionId: 'public-unselected-period-2',
    periodId: 'period-2',
    executionId: 'period-2',
    conversationId: otherPeriodRegistration.conversationId,
    launchRef: otherPeriodRegistration.launchRef,
    executionBinding: otherPeriodRegistration.executionBinding,
    createdAt: 13_000,
  });
  const legacyQuestions = JSON.parse(sources.questions.toString('utf8'));
  legacyQuestions.questions.push(samePeriodUnselected, otherPeriodUnselected);
  sources.questions = Buffer.from(JSON.stringify(legacyQuestions), 'utf8');
  sources.checkpoint = Buffer.from(JSON.stringify(checkpoint), 'utf8');

  const sourceBytesBySlot = Object.fromEntries(STORE_FIELDS.map((slot) => [slot, sources[slot]]));
  const migrationByteLimitsBySlot = Object.fromEntries(STORE_FIELDS.map((slot) =>
    [slot, sources[slot].byteLength]));
  const migrated = planInitialReclamationMigration({
    configuredSlots: STORE_FIELDS,
    sourceBytesBySlot,
    normalByteLimitsBySlot: migrationByteLimitsBySlot,
    storeId: STORE_ID,
    operationId: MIGRATION_ID,
    startedAt: 1_000_000,
  });
  const anchor = structuredClone(migrated.anchor);
  anchor.revision += 1;
  anchor.retiredQuestionPeriods = [];
  anchor.migration = null;
  const stores = structuredClone(migrated.stores);
  for (const detail of stores.questions.questions) detail.quarantinedAt = null;
  for (const reservation of stores.questions.reservations) reservation.quarantinedAt = null;
  stores.questions = normalizeQuestionJournalV2Local(stores.questions);
  const normalByteLimitsBySlot = Object.fromEntries(STORE_FIELDS.map((slot) =>
    [slot, MAX_SOURCE_BYTES]));
  const active = { anchor, stores, normalByteLimitsBySlot };
  const retired = planQuestionPeriodRetirement({
    anchor,
    questionJournal: stores.questions,
    checkpoint: stores.checkpoint,
    identity: selected.identity,
    periodId: selected.periodId,
    retiredAt: RETIRED_AT,
  });
  const retiredStores = {
    questions: retired.questionJournal,
    checkpoint: retired.checkpoint,
    instructions: stores.instructions,
  };
  const retiredSnapshot = {
    anchor: retired.anchor,
    stores: retiredStores,
    normalByteLimitsBySlot,
  };
  const bodyPlan = planQuestionBodyReclamation({
    anchor: retired.anchor,
    stores: retiredStores,
    normalByteLimitsBySlot,
    internalQuestionId: selected.internalQuestionId,
    now: RETIRED_AT + RETENTION_MS,
    operationId: RECLAMATION_ID,
  });
  assert.equal(bodyPlan.status, 'planned');
  return {
    active,
    selected,
    retired: retiredSnapshot,
    prepared: {
      anchor: bodyPlan.steps[0].snapshot.anchor,
      stores: bodyPlan.steps[0].snapshot.stores,
      normalByteLimitsBySlot,
    },
    reclaimed: {
      anchor: bodyPlan.steps.at(-1).snapshot.anchor,
      stores: bodyPlan.steps.at(-1).snapshot.stores,
      normalByteLimitsBySlot,
    },
    otherPeriodLaunchRef: otherPeriodRegistration.launchRef,
  };
}

function analyze(snapshot, identity, periodId) {
  return analyzeQuestionPeriodRejectionCoverage(analysisInput(snapshot, identity, periodId));
}

function analysisInput(snapshot, identity, periodId) {
  return {
    anchor: snapshot.anchor,
    stores: snapshot.stores,
    normalByteLimitsBySlot: snapshot.normalByteLimitsBySlot,
    identity,
    periodId,
  };
}

function validateTransition(previousSnapshot, nextSnapshot) {
  return validateReclamationStoreWrite({
    anchor: previousSnapshot.anchor,
    previousStores: previousSnapshot.stores,
    nextStores: nextSnapshot.stores,
    normalByteLimitsBySlot: previousSnapshot.normalByteLimitsBySlot,
  });
}

function assertAllowedReasonUsesOriginalSnapshot(snapshot, identity, periodId, expectedReason) {
  const input = analysisInput(snapshot, identity, periodId);
  const inputBefore = serialize(input);
  assert.equal(Object.isFrozen(input), false);
  const repair = validateReclamationSnapshot({ anchor: snapshot.anchor, stores: snapshot.stores });
  assert.equal(repair.status, 'reconciliation-required');
  assert.deepEqual(repair.reasons, [expectedReason]);
  const repairedSnapshot = { ...snapshot, stores: repair.snapshot.stores };
  const transition = validateTransition(snapshot, repairedSnapshot);
  assert.deepEqual(transition.reasons, [expectedReason]);
  assert.deepEqual(serialize(transition.snapshot.stores), serialize(repair.snapshot.stores));
  const coverage = analyzeQuestionPeriodRejectionCoverage(input);
  assert.deepEqual(serialize(input), inputBefore);
  assert.equal(Object.isFrozen(input), false);
  return { coverage, transition };
}

function withQuestionCreationState(snapshot) {
  const journal = structuredClone(snapshot.stores.questions);
  journal.revision += 1;
  for (const detail of journal.questions) {
    if (detail.deliveryIntent !== null) detail.deliveryCreationState = 'creating';
  }
  for (const reservation of journal.reservations) {
    if (reservation.deliveryIntent === null) continue;
    reservation.deliveryCreationState = 'creating';
    reservation.checkpointState = null;
    reservation.sourceClaimsDigest = null;
    reservation.sessionId = null;
    reservation.terminalResultKind = null;
  }
  return { ...snapshot, stores: { ...snapshot.stores, questions: normalizeQuestionJournalV2Local(journal) } };
}

function withQuestionCheckpointCacheState(snapshot, staleState) {
  const journal = structuredClone(snapshot.stores.questions);
  journal.revision += 1;
  for (const reservation of journal.reservations) {
    if (reservation.deliveryIntent !== null) reservation.checkpointState = staleState;
  }
  return { ...snapshot, stores: { ...snapshot.stores, questions: normalizeQuestionJournalV2Local(journal) } };
}

function withInstructionCreationState(snapshot) {
  const journal = structuredClone(snapshot.stores.instructions);
  journal.revision += 1;
  for (const instruction of journal.instructions) {
    if (instruction.recordType === 'detail') instruction.deliveryCreationState = 'creating';
  }
  return { ...snapshot, stores: { ...snapshot.stores, instructions: normalizeInstructionJournalV2Local(journal) } };
}

function sourceForLaunch(checkpoint, launchRef) {
  const registration = checkpoint.registrations.launches.find((item) => item.launchRef === launchRef);
  const runtime = checkpoint.registrations.runtimeLaunches.find((item) => item.launchRef === launchRef);
  assert.ok(registration);
  assert.ok(runtime);
  return {
    ...structuredClone(registration.claims),
    launchRef,
    state: registration.state,
    identity: structuredClone(registration.identity),
    executionBinding: structuredClone(registration.executionBinding),
    conversationId: registration.conversationId,
    sessionId: registration.sessionId,
    currentOwner: structuredClone(runtime.currentOwner),
    ownerGeneration: runtime.ownerGeneration,
  };
}

function assertCode(callback, code) {
  assert.throws(callback, (error) => error && error.code === code);
}

for (const provider of ['claude', 'codex']) {
  test(`QRC02-QRC03-QRC04-QRC06-QRC07: ${provider} migration fixture scopes retired-period coverage and preserves other obligations`, () => {
    const fixture = createFixture(provider);
    const identity = fixture.selected.identity;
    const coverage = analyze(fixture.retired, identity, fixture.selected.periodId);
    assert.equal(coverage.scope, 'question_period_rejection_only');
    assert.equal(coverage.periodStatus, 'retired');
    assert.deepEqual(coverage.summary.lifecycleCounts, { retained: 2, prepared: 0, reclaimed: 0 });
    assert.equal(coverage.summary.coveredQuestionCount, 2);
    assert.equal(coverage.summary.unselectedQuestionCount, 1);
    assert.equal(coverage.summary.wholeSnapshotDeletionSafety, 'not_assessed');
    assert.equal(Object.hasOwn(coverage, 'stores'), false);
    assert.equal(Object.hasOwn(coverage, 'deleteIds'), false);
    assert.equal(Object.hasOwn(coverage, 'canDelete'), false);
    assert.ok(Object.isFrozen(coverage) && Object.isFrozen(coverage.questionRows));
    assert.ok(Object.isFrozen(coverage.target));
    assert.ok(Object.isFrozen(coverage.target.identity));
    assert.ok(Object.isFrozen(coverage.scopeLimitations));
    assert.ok(Object.isFrozen(coverage.summary));
    assert.ok(Object.isFrozen(coverage.summary.lifecycleCounts));
    assert.ok(Object.isFrozen(coverage.summary.remainingObligationCounts));
    assert.ok(Object.isFrozen(coverage.questionRows[0]));
    assert.ok(Object.isFrozen(coverage.questionRows[0].remainingObligations));
    assert.ok(coverage.questionRows[0].remainingObligations.every(Object.isFrozen));

    const selectedRow = coverage.questionRows.find((row) =>
      row.internalQuestionId === fixture.selected.internalQuestionId);
    const unselectedRow = coverage.questionRows.find((row) =>
      row.internalQuestionId === 'internal-unselected-period-1');
    assert.equal(selectedRow.commonKeyDigest,
      questionCommonKeyDigest(identity, fixture.selected.periodId, fixture.selected.questionId));
    assert.equal(selectedRow.commonKeyReRegistration, 'covered');
    assert.equal(selectedRow.questionPeriodDeliveryAndLateUpdate, 'covered');
    assert.equal(selectedRow.checkpointDeliveryRecordType, 'detail');
    assert.equal(selectedRow.checkpointDeliveryState, 'available');
    assert.ok(selectedRow.remainingObligations.some((item) =>
      item.code === 'global_delivery_attempt_id_uniqueness' && item.reason.includes('別kind')));
    assert.ok(selectedRow.remainingObligations.some((item) =>
      item.code === 'logical_replay_and_tombstone_retention'));
    assert.ok(selectedRow.remainingObligations.some((item) =>
      item.code === 'question_delivery_result_or_state_lookup'));
    assert.equal(unselectedRow.deliveryIntentPresent, false);
    assert.equal(unselectedRow.remainingObligations.some((item) =>
      item.code === 'global_delivery_attempt_id_uniqueness'), false);
    assert.equal(unselectedRow.remainingObligations.some((item) =>
      item.code === 'logical_replay_and_tombstone_retention'), false);
    assert.equal(unselectedRow.remainingObligations.some((item) =>
      item.code === 'question_delivery_result_or_state_lookup'), false);

    const prepared = analyze(fixture.prepared, identity, fixture.selected.periodId);
    const reclaimed = analyze(fixture.reclaimed, identity, fixture.selected.periodId);
    assert.equal(prepared.questionRows.find((row) =>
      row.internalQuestionId === fixture.selected.internalQuestionId).bodyLifecycle, 'prepared');
    assert.equal(reclaimed.questionRows.find((row) =>
      row.internalQuestionId === fixture.selected.internalQuestionId).bodyLifecycle, 'reclaimed');
    const reclaimedRow = reclaimed.questionRows.find((row) =>
      row.internalQuestionId === fixture.selected.internalQuestionId);
    assert.equal(reclaimedRow.questionDetailPresent, false);
    assert.equal(reclaimedRow.checkpointDeliveryRecordType, 'reclaimed');
    assert.equal(reclaimedRow.checkpointDeliveryState, 'available');
    assert.equal(fixture.reclaimed.stores.questions.reservations.find((reservation) =>
      reservation.internalQuestionId === fixture.selected.internalQuestionId).terminalResultKind, null);
    assert.ok(reclaimedRow.remainingObligations.some((item) =>
      item.code === 'question_delivery_result_or_state_lookup'));
    const lookupResult = getReclamationDelivery(fixture.reclaimed.stores.checkpoint,
      fixture.selected.deliveryIntent.deliveryAttemptId);
    assert.equal(lookupResult.recordType, 'reclaimed');
    assert.equal(lookupResult.state, 'available');

    const otherPeriod = analyze(fixture.retired, identity, 'period-2');
    assert.equal(otherPeriod.periodStatus, 'not_retired');
    assert.equal(otherPeriod.questionRows.length, 1);
    assert.equal(otherPeriod.questionRows[0].commonKeyReRegistration, 'not_covered');
    assert.equal(otherPeriod.questionRows[0].questionPeriodDeliveryAndLateUpdate, 'not_covered');
    assert.ok(otherPeriod.scopeLimitations.includes('whole_snapshot_deletion_safety_not_assessed'));
    assert.ok(otherPeriod.scopeLimitations.includes('nonquestion_checkpoint_and_instruction_obligations_not_covered'));
    assert.ok(otherPeriod.scopeLimitations.includes('body_reclamation_does_not_establish_capacity_release'));

    const otherProvider = identity.provider === 'claude' ? 'codex' : 'claude';
    const otherIdentityVariants = [
      { ...identity, nativeId: `${identity.nativeId}-other` },
      { ...identity, hostId: `${identity.hostId}-other` },
      { ...identity, homeScopeId: `${identity.homeScopeId}-other` },
      { ...identity, provider: otherProvider, nativeIdKind: otherProvider === 'claude' ? 'session' : 'thread' },
    ];
    for (const otherIdentity of otherIdentityVariants) {
      const otherIdentityCoverage = analyze(fixture.retired, otherIdentity, fixture.selected.periodId);
      assert.equal(otherIdentityCoverage.periodStatus, 'not_retired');
      assert.equal(otherIdentityCoverage.questionRows.length, 0);
    }
    const invalidNativeIdKind = {
      ...identity,
      nativeIdKind: identity.nativeIdKind === 'session' ? 'thread' : 'session',
    };
    assert.throws(() => analyze(fixture.retired, invalidNativeIdKind, fixture.selected.periodId), TypeError);

    let gateAnchor = fixture.active.anchor;
    const gate = createQuestionPeriodGate({ getAnchor: () => gateAnchor, canWrite: () => true });
    const token = gate.capture(identity, fixture.selected.periodId);
    gateAnchor = fixture.retired.anchor;
    assertCode(() => gate.assertCurrent(token), 'question_quarantined');
    assertCode(() => gate.capture(identity, fixture.selected.periodId), 'question_quarantined');
    assert.doesNotThrow(() => gate.capture(identity, 'period-2'));

    const checkpoint = fixture.reclaimed.stores.checkpoint;
    const source = sourceForLaunch(checkpoint, fixture.otherPeriodLaunchRef);
    const newInstruction = createReclamationDelivery(checkpoint, 'instruction', {
      deliveryAttemptId: 'period-2-new-instruction-attempt',
      logicalMessageId: 'period-2-new-instruction',
      revision: 1,
      payload: 'new instruction in a non-retired period',
    }, source);
    assert.equal(newInstruction.created, true);
    assert.equal(newInstruction.delivery.kind, 'instruction');
    assertCode(() => createReclamationDelivery(checkpoint, 'instruction', {
      deliveryAttemptId: fixture.selected.deliveryIntent.deliveryAttemptId,
      logicalMessageId: 'period-2-reuse-question-attempt',
      revision: 1,
      payload: 'attempt ID still held by reclaimed question grave',
    }, source), 'delivery_reclaimed');
  });
}

test('QRC01: question creation reconciliation is accepted without analyzing its repaired snapshot', () => {
  const fixture = createFixture('codex');
  const snapshot = withQuestionCreationState(fixture.active);
  const { coverage, transition } = assertAllowedReasonUsesOriginalSnapshot(snapshot,
    fixture.selected.identity, fixture.selected.periodId, 'question_creation_state');
  const selectedRow = coverage.questionRows.find((row) =>
    row.internalQuestionId === fixture.selected.internalQuestionId);
  const repairedReservation = transition.snapshot.stores.questions.reservations.find((row) =>
    row.internalQuestionId === fixture.selected.internalQuestionId);

  assert.equal(selectedRow.deliveryCreationState, 'creating');
  assert.equal(selectedRow.checkpointState, null);
  assert.equal(repairedReservation.deliveryCreationState, 'checkpointed');
});

test('QRC01: checkpoint cache reconciliation is accepted while coverage reads the raw cache', () => {
  const fixture = createFixture('codex');
  const snapshot = withQuestionCheckpointCacheState(fixture.active, 'claimed');
  const { coverage, transition } = assertAllowedReasonUsesOriginalSnapshot(snapshot,
    fixture.selected.identity, fixture.selected.periodId, 'question_checkpoint_cache');
  const selectedRow = coverage.questionRows.find((row) =>
    row.internalQuestionId === fixture.selected.internalQuestionId);
  const repairedReservation = transition.snapshot.stores.questions.reservations.find((row) =>
    row.internalQuestionId === fixture.selected.internalQuestionId);

  assert.equal(selectedRow.checkpointState, 'claimed');
  assert.equal(selectedRow.checkpointDeliveryState, 'available');
  assert.equal(repairedReservation.checkpointState, 'available');
});

test('QRC01: instruction creation reconciliation does not rewrite the analyzed snapshot', () => {
  const fixture = createFixture('codex');
  const snapshot = withInstructionCreationState(fixture.active);
  const { coverage, transition } = assertAllowedReasonUsesOriginalSnapshot(snapshot,
    fixture.selected.identity, fixture.selected.periodId, 'instruction_creation_state');
  const rawInstruction = snapshot.stores.instructions.instructions.find((row) =>
    row.recordType === 'detail');
  const repairedInstruction = transition.snapshot.stores.instructions.instructions.find((row) =>
    row.recordType === 'detail');

  assert.equal(rawInstruction.deliveryCreationState, 'creating');
  assert.equal(repairedInstruction.deliveryCreationState, 'checkpointed');
  assert.equal(coverage.questionRows.find((row) =>
    row.internalQuestionId === fixture.selected.internalQuestionId).deliveryCreationState,
  fixture.active.stores.questions.reservations.find((row) =>
    row.internalQuestionId === fixture.selected.internalQuestionId).deliveryCreationState);
});

test('QRC05: real PR and result deliveries remain outside question-period coverage', () => {
  const fixture = createFixture('codex');
  const initialCheckpoint = fixture.retired.stores.checkpoint;
  const source = sourceForLaunch(initialCheckpoint, fixture.selected.launchRef);
  const registration = registerReclamationTarget(initialCheckpoint, 'qrc05-pr-target', source);
  let checkpoint = { ...initialCheckpoint, ledger: registration.ledger };
  const prNotification = createReclamationDelivery(checkpoint, 'pr-notification', {
    deliveryAttemptId: 'qrc05-pr-attempt',
    logicalMessageId: 'qrc05-pr-message',
    revision: 1,
    payload: 'PR notification outside question-period coverage',
    targetId: 'qrc05-pr-target',
  }, source);
  checkpoint = { ...checkpoint, ledger: prNotification.ledger };
  const result = createReclamationDelivery(checkpoint, 'result', {
    deliveryAttemptId: 'qrc05-result-attempt',
    logicalMessageId: 'qrc05-result-message',
    revision: 1,
    payload: 'result outside question-period coverage',
  }, source, {
    executionId: source.currentOwner.periodId,
    conversationId: source.conversationId,
    sessionId: source.sessionId,
    identity: source.identity,
  });
  checkpoint = { ...checkpoint, ledger: result.ledger };
  const augmented = {
    ...fixture.retired,
    stores: {
      ...fixture.retired.stores,
      checkpoint: { ...checkpoint, revision: initialCheckpoint.revision + 1 },
    },
  };
  const baselineCoverage = analyze(fixture.retired, fixture.selected.identity, fixture.selected.periodId);
  const augmentedCoverage = analyze(augmented, fixture.selected.identity, fixture.selected.periodId);

  const transition = validateTransition(fixture.retired, augmented);
  assert.equal(transition.status, 'checked');
  assert.deepEqual(transition.reasons, []);
  assert.equal(registration.created, true);
  assert.equal(prNotification.created, true);
  assert.equal(prNotification.delivery.kind, 'pr-notification');
  assert.equal(result.created, true);
  assert.equal(result.delivery.kind, 'result');
  assert.equal(getReclamationDelivery(checkpoint, 'qrc05-pr-attempt').kind, 'pr-notification');
  assert.equal(getReclamationDelivery(checkpoint, 'qrc05-result-attempt').kind, 'result');
  assert.deepEqual(augmentedCoverage, baselineCoverage);
  assert.ok(augmentedCoverage.scopeLimitations.includes(
    'nonquestion_checkpoint_and_instruction_obligations_not_covered'));
});

test('QRC01/QRC07: rejects unsafe input and snapshots that need retirement repair', () => {
  const fixture = createFixture('codex');
  const input = {
    anchor: fixture.retired.anchor,
    stores: fixture.retired.stores,
    normalByteLimitsBySlot: fixture.retired.normalByteLimitsBySlot,
    identity: fixture.selected.identity,
    periodId: fixture.selected.periodId,
  };
  const inputBeforeAnalysis = serialize(input);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input.stores.questions), false);
  assert.equal(Object.isFrozen(input.stores.checkpoint), false);
  assert.equal(Object.isFrozen(input.anchor.retiredQuestionPeriods), false);
  assert.equal(Object.isFrozen(input.stores.questions.reservations[0].identity), false);
  analyzeQuestionPeriodRejectionCoverage(input);
  assert.deepEqual(serialize(input), inputBeforeAnalysis);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input.stores.questions), false);
  assert.equal(Object.isFrozen(input.stores.checkpoint), false);

  let getterCalls = 0;
  const accessorInput = { ...input };
  Object.defineProperty(accessorInput, 'periodId', {
    enumerable: true,
    get() { getterCalls += 1; return fixture.selected.periodId; },
  });
  assert.throws(() => analyzeQuestionPeriodRejectionCoverage(accessorInput), TypeError);
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const proxyInput = new Proxy(input, {
    ownKeys() { proxyTraps += 1; return Reflect.ownKeys(input); },
  });
  assert.throws(() => analyzeQuestionPeriodRejectionCoverage(proxyInput), TypeError);
  assert.equal(proxyTraps, 0);

  const inconsistentStores = structuredClone(fixture.retired.stores);
  for (const detail of inconsistentStores.questions.questions) detail.quarantinedAt = null;
  for (const reservation of inconsistentStores.questions.reservations) reservation.quarantinedAt = null;
  inconsistentStores.questions = normalizeQuestionJournalV2Local(inconsistentStores.questions);
  assert.throws(() => analyzeQuestionPeriodRejectionCoverage({
    ...input,
    stores: inconsistentStores,
  }), TypeError);

  const withoutCheckpoint = createFixture('codex', { omitQuestionDelivery: true });
  const missingDeliveryCoverage = analyze(withoutCheckpoint.reclaimed,
    withoutCheckpoint.selected.identity, withoutCheckpoint.selected.periodId);
  const indeterminateRow = missingDeliveryCoverage.questionRows.find((row) =>
    row.internalQuestionId === withoutCheckpoint.selected.internalQuestionId);
  assert.equal(indeterminateRow.deliveryIntentPresent, true);
  assert.equal(indeterminateRow.deliveryCreationState, 'indeterminate');
  assert.equal(indeterminateRow.checkpointDeliveryRecordType, null);
  assert.equal(getReclamationDelivery(withoutCheckpoint.reclaimed.stores.checkpoint,
    withoutCheckpoint.selected.deliveryIntent.deliveryAttemptId), null);
  assert.equal(indeterminateRow.remainingObligations.some((item) =>
    item.code === 'question_delivery_result_or_state_lookup'), false);
});
