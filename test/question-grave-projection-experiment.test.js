'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { serialize } = require('node:v8');
const { createQuestionRecord, selectionFor } = require('../src/server/common-question-kernel');
const { createQuestionPeriodGate } = require('../src/server/question-period-gate');
const { createReclamationDelivery, getReclamationDelivery } =
  require('../src/server/delivery-reclamation-runtime');
const { createDelivery, createEmptyLedger, transitionDelivery } = require('../src/server/delivery-ledger');
const { normalizeQuestionJournalV2Local } = require('../src/server/common-question-reclamation-codec');
const { normalizeInstructionJournalV2Local } = require('../src/server/delivery-reclamation-codec');
const { MAX_SOURCE_BYTES } = require('../src/server/reclamation-capacity-bounds');
const { planInitialReclamationMigration } = require('../src/server/reclamation-migration-plan');
const { planQuestionBodyReclamation } = require('../src/server/question-body-reclamation');
const { planQuestionPeriodRetirement } = require('../src/server/question-period-retirement');
const { validateReclamationSnapshot } = require('../src/server/reclamation-store-consistency');
const {
  buildQuestionGraveProjectionExperiment,
  expandQuestionGraveProjectionExperiment,
} = require('../src/server/question-grave-projection-experiment');
const { threeSlotLegacySources } = require('./support/native-migration-allowance-release-harness');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const MIGRATION_ID = '22222222-2222-4222-8222-222222222222';
const RETIRED_AT = 2_000_000;
const RETENTION_MS = 604_800_000;
const STORE_FIELDS = ['questions', 'checkpoint', 'instructions'];

function makeQuestion(base, { internalQuestionId, questionId, periodId = base.periodId, createdAt }) {
  return createQuestionRecord({
    internalQuestionId,
    questionId,
    identity: structuredClone(base.identity),
    periodId,
    executionId: periodId === base.periodId ? base.executionId : periodId,
    conversationId: base.conversationId,
    launchRef: base.launchRef,
    executionBinding: structuredClone(base.executionBinding),
    category: 'ordinary',
    questions: structuredClone(base.questions),
    timeoutMinutes: 1,
    createdAt,
  });
}

function selectQuestion(base, questionId, suffix, selectedAt) {
  const result = selectionFor(base, [{
    questionId: 'question-1', optionIds: ['option-1'], freeText: null,
  }], 'manual', selectedAt, suffix);
  assert.equal(result.outcome, 'selected');
  assert.equal(result.record.questionId, questionId);
  return result.record;
}

function sourceForLaunch(checkpoint, launchRef) {
  const registration = checkpoint.registrations.launches.find((item) => item.launchRef === launchRef);
  const runtime = checkpoint.registrations.runtimeLaunches.find((item) => item.launchRef === launchRef);
  assert.ok(registration && runtime);
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

function addLegacyQuestionDelivery(checkpoint, launch, selected) {
  const payload = JSON.stringify({
    questionId: selected.questionId,
    revision: selected.deliveryIntent.revision,
    answers: selected.selection.answers,
  });
  const result = createDelivery(checkpoint.ledger, 'question', {
    deliveryAttemptId: selected.deliveryIntent.deliveryAttemptId,
    logicalMessageId: selected.deliveryIntent.logicalMessageId,
    revision: selected.deliveryIntent.revision,
    payload,
  }, launch);
  assert.equal(result.created, true);
  checkpoint.ledger = result.ledger;
}

function addOtherPeriodRegistration(checkpoint, base) {
  const identity = structuredClone(base.identity);
  const executionBinding = { periodId: 'period-2', actor: { kind: 'agent', id: 'actor-2' } };
  const claims = {
    launchId: 'launch-id-period-2', runId: 'run-id-period-2', attemptId: 'attempt-id-period-2',
    provider: identity.provider, nativeIdKind: identity.nativeIdKind, hostId: identity.hostId,
    homeScopeId: identity.homeScopeId, origin: 'standalone', purpose: 'agent', originBinding: null,
  };
  const immutableExecutionClaims = { ...claims, identity, executionBinding };
  const registration = checkpoint.registrations;
  const connectionScope = structuredClone(registration.connections[0].scope);
  registration.executions.push({ conversationId: base.conversationId, executionId: 'period-2',
    sessionId: 'session-period-2', state: 'active' });
  registration.launches.push({ launchRef: 'launch-period-2', claims, state: 'bound', identity,
    executionBinding, conversationId: base.conversationId, sessionId: 'session-period-2' });
  registration.runtimeLaunches.push({ launchRef: 'launch-period-2', claims: immutableExecutionClaims,
    state: 'bound', conversationId: base.conversationId, sessionId: 'session-period-2',
    currentOwner: executionBinding, ownerGeneration: 0 });
  registration.actors.push({ identity, periodId: 'period-2', actor: executionBinding.actor,
    contextId: 'context-period-2', launchRef: 'launch-period-2', immutableExecutionClaims,
    connectionScope, connectionGeneration: registration.connections[0].generation, state: 'active' });
  return 'launch-period-2';
}

function createFixture(provider) {
  const sources = { ...threeSlotLegacySources(provider) };
  const initialSelected = sources.question;
  const checkpoint = JSON.parse(sources.checkpoint.toString('utf8'));
  const source = sourceForLaunch(checkpoint, initialSelected.launchRef);
  const unknown = selectQuestion(makeQuestion(initialSelected, {
    internalQuestionId: 'internal-unknown', questionId: 'public-unknown', createdAt: 13_000,
  }), 'public-unknown', 'unknown', 14_000);
  const missing = selectQuestion(makeQuestion(initialSelected, {
    internalQuestionId: 'internal-missing', questionId: 'public-missing', createdAt: 15_000,
  }), 'public-missing', 'missing', 16_000);
  const terminal = selectQuestion(makeQuestion(initialSelected, {
    internalQuestionId: 'internal-terminal', questionId: 'public-terminal', createdAt: 17_000,
  }), 'public-terminal', 'terminal', 18_000);
  const unselected = makeQuestion(initialSelected, {
    internalQuestionId: 'internal-unselected', questionId: 'public-unselected', createdAt: 19_000,
  });
  addLegacyQuestionDelivery(checkpoint, source, unknown);
  let unknownLedger = transitionDelivery(checkpoint.ledger, unknown.deliveryIntent.deliveryAttemptId, 'sendStart').ledger;
  unknownLedger = transitionDelivery(unknownLedger, unknown.deliveryIntent.deliveryAttemptId, 'unknown').ledger;
  checkpoint.ledger = unknownLedger;
  addLegacyQuestionDelivery(checkpoint, source, terminal);
  checkpoint.ledger = transitionDelivery(checkpoint.ledger, terminal.deliveryIntent.deliveryAttemptId, 'cancel').ledger;
  const otherPeriodLaunchRef = addOtherPeriodRegistration(checkpoint, initialSelected);

  const legacyQuestions = JSON.parse(sources.questions.toString('utf8'));
  legacyQuestions.questions.push(unknown, missing, terminal, unselected);
  sources.questions = Buffer.from(JSON.stringify(legacyQuestions), 'utf8');
  sources.checkpoint = Buffer.from(JSON.stringify(checkpoint), 'utf8');
  const sourceBytesBySlot = Object.fromEntries(STORE_FIELDS.map((slot) => [slot, sources[slot]]));
  const migrationLimits = Object.fromEntries(STORE_FIELDS.map((slot) => [slot, sources[slot].byteLength]));
  const migrated = planInitialReclamationMigration({
    configuredSlots: STORE_FIELDS,
    sourceBytesBySlot,
    normalByteLimitsBySlot: migrationLimits,
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
  const normalByteLimitsBySlot = Object.fromEntries(STORE_FIELDS.map((slot) => [slot, MAX_SOURCE_BYTES]));
  const active = { anchor, stores, normalByteLimitsBySlot };
  const retired = planQuestionPeriodRetirement({
    anchor,
    questionJournal: stores.questions,
    checkpoint: stores.checkpoint,
    identity: initialSelected.identity,
    periodId: initialSelected.periodId,
    retiredAt: RETIRED_AT,
  });
  let reclaimed = {
    anchor: retired.anchor,
    stores: { questions: retired.questionJournal, checkpoint: retired.checkpoint, instructions: stores.instructions },
    normalByteLimitsBySlot,
  };
  const targetInternalIds = reclaimed.stores.questions.reservations
    .filter((reservation) => reservation.periodId === initialSelected.periodId &&
      reservation.identity.nativeId === initialSelected.identity.nativeId)
    .map((reservation) => reservation.internalQuestionId);
  for (let index = 0; index < targetInternalIds.length; index += 1) {
    const result = planQuestionBodyReclamation({
      anchor: reclaimed.anchor,
      stores: reclaimed.stores,
      normalByteLimitsBySlot,
      internalQuestionId: targetInternalIds[index],
      now: RETIRED_AT + RETENTION_MS + 100,
      operationId: `44444444-4444-4444-8444-${String(index + 1).padStart(12, '0')}`,
    });
    assert.equal(result.status, 'planned');
    const finalSnapshot = result.steps.at(-1).snapshot;
    reclaimed = { ...finalSnapshot, normalByteLimitsBySlot };
  }
  return {
    active,
    retired: {
      anchor: retired.anchor,
      stores: { questions: retired.questionJournal, checkpoint: retired.checkpoint, instructions: stores.instructions },
      normalByteLimitsBySlot,
    },
    reclaimed,
    selected: initialSelected,
    otherPeriodLaunchRef,
  };
}

function inputFor(snapshot, identity, periodId) {
  return structuredClone({
    anchor: snapshot.anchor,
    stores: snapshot.stores,
    normalByteLimitsBySlot: snapshot.normalByteLimitsBySlot,
    identity,
    periodId,
  });
}

function sameIdentity(left, right) {
  return ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']
    .every((field) => left[field] === right[field]);
}

function selectedOriginalRecords(input) {
  const reservations = input.stores.questions.reservations.filter((reservation) =>
    reservation.periodId === input.periodId && sameIdentity(reservation.identity, input.identity));
  const attemptIds = new Set(reservations.flatMap((reservation) =>
    reservation.deliveryIntent === null ? [] : [reservation.deliveryIntent.deliveryAttemptId]));
  const deliveryGraves = input.stores.checkpoint.ledger.deliveries.filter((delivery) =>
    attemptIds.has(delivery.deliveryAttemptId));
  const questionTargetLaunchKey = null;
  const groups = new Set(deliveryGraves.map((grave) => JSON.stringify([
    grave.kind, grave.sourceExecutionId, grave.logicalMessageId, grave.revision,
    questionTargetLaunchKey, grave.sourceRef.launchKey, grave.payloadDigest,
  ])));
  const logicalTombstones = input.stores.checkpoint.ledger.logicalTombstones.filter((tombstone) =>
    groups.has(JSON.stringify([
      tombstone.kind, tombstone.sourceExecutionId, tombstone.logicalMessageId, tombstone.revision,
      tombstone.targetLaunchKey, tombstone.sourceLaunchKey, tombstone.payloadDigest,
    ])));
  return { reservations, deliveryGraves, logicalTombstones };
}

function assertCode(callback, code) {
  assert.throws(callback, (error) => error && error.code === code);
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function assertDeepFrozen(value, visited = new Set()) {
  if (value === null || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  assert.equal(Object.isFrozen(value), true);
  for (const key of Reflect.ownKeys(value)) assertDeepFrozen(value[key], visited);
}

function assertNotDeepFrozen(value, visited = new Set()) {
  if (value === null || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  assert.equal(Object.isFrozen(value), false);
  for (const key of Reflect.ownKeys(value)) assertNotDeepFrozen(value[key], visited);
}

function assertRejectedCandidate(originalInput, candidate) {
  assertCode(() => expandQuestionGraveProjectionExperiment({ originalInput, candidate }),
    'invalid_question_grave_projection_experiment');
}

for (const provider of ['claude', 'codex']) {
  test(`QGP01: ${provider} only projects a retired period after every selected body is reclaimed`, () => {
    const fixture = createFixture(provider);
    const active = buildQuestionGraveProjectionExperiment(inputFor(fixture.active,
      fixture.selected.identity, fixture.selected.periodId));
    assert.equal(active.status, 'not_eligible');
    assert.equal(active.reason, 'period_not_retired');
    assert.equal(active.candidate, null);

    const retired = buildQuestionGraveProjectionExperiment(inputFor(fixture.retired,
      fixture.selected.identity, fixture.selected.periodId));
    assert.equal(retired.status, 'not_eligible');
    assert.equal(retired.reason, 'period_has_unreclaimed_question_bodies');

    const wrongIdentity = { ...fixture.selected.identity, nativeId: 'different-session' };
    const wrongTarget = buildQuestionGraveProjectionExperiment(inputFor(fixture.reclaimed,
      wrongIdentity, fixture.selected.periodId));
    assert.equal(wrongTarget.status, 'not_eligible');
    assert.equal(wrongTarget.reason, 'period_not_retired');

    const ready = buildQuestionGraveProjectionExperiment(inputFor(fixture.reclaimed,
      fixture.selected.identity, fixture.selected.periodId));
    assert.equal(ready.status, 'ready');
    assert.equal(ready.candidate.format, 'question-grave-projection-experiment/v1');
  });

  test(`QGP01: ${provider} rejects ready candidates against inconsistent full snapshots`, () => {
    const fixture = createFixture(provider);
    const originalInput = inputFor(fixture.reclaimed,
      fixture.selected.identity, fixture.selected.periodId);
    const ready = buildQuestionGraveProjectionExperiment(originalInput);
    assert.equal(ready.status, 'ready');

    const mismatchedStoreId = structuredClone(originalInput);
    mismatchedStoreId.stores.instructions.storeId = '55555555-5555-4555-8555-555555555555';
    assert.equal(normalizeInstructionJournalV2Local(mismatchedStoreId.stores.instructions).storeId,
      mismatchedStoreId.stores.instructions.storeId);
    assertCode(() => buildQuestionGraveProjectionExperiment(mismatchedStoreId),
      'invalid_question_grave_projection_experiment');
    assertRejectedCandidate(mismatchedStoreId, ready.candidate);

    const reconciliationRequired = structuredClone(originalInput);
    reconciliationRequired.stores.instructions.revision += 1;
    const instruction = reconciliationRequired.stores.instructions.instructions.find((record) =>
      record.recordType === 'detail');
    instruction.deliveryCreationState = 'creating';
    reconciliationRequired.stores.instructions = normalizeInstructionJournalV2Local(
      reconciliationRequired.stores.instructions);
    assert.equal(validateReclamationSnapshot({
      anchor: reconciliationRequired.anchor,
      stores: reconciliationRequired.stores,
    }).status, 'reconciliation-required');
    assertCode(() => buildQuestionGraveProjectionExperiment(reconciliationRequired),
      'invalid_question_grave_projection_experiment');
    assertRejectedCandidate(reconciliationRequired, ready.candidate);
  });

  test(`QGP02-QGP03: ${provider} expands complete records while preserving missing and unselected intents`, () => {
    const fixture = createFixture(provider);
    const originalInput = inputFor(fixture.reclaimed, fixture.selected.identity, fixture.selected.periodId);
    const before = serialize(originalInput);
    const result = buildQuestionGraveProjectionExperiment(originalInput);
    assert.equal(result.status, 'ready');
    const expected = selectedOriginalRecords(originalInput);
    const expanded = expandQuestionGraveProjectionExperiment({ originalInput, candidate: result.candidate });
    assert.deepEqual(expanded.questionReservations, expected.reservations);
    assert.equal(stableJson(expanded.deliveryGraves), stableJson(expected.deliveryGraves));
    assert.equal(stableJson(expanded.logicalTombstones), stableJson(expected.logicalTombstones));
    assert.deepEqual(serialize(originalInput), before);
    assert.equal(Object.isFrozen(originalInput), false);

    const byId = new Map(expanded.questionReservations.map((reservation) => [reservation.internalQuestionId, reservation]));
    assert.equal(byId.size, 5);
    assert.equal(byId.get('internal-missing').deliveryCreationState, 'indeterminate');
    assert.equal(byId.get('internal-missing').deliveryIntent.deliveryAttemptId,
      fixture.reclaimed.stores.questions.reservations.find((row) => row.internalQuestionId === 'internal-missing')
        .deliveryIntent.deliveryAttemptId);
    assert.equal(byId.get('internal-unselected').deliveryIntent, null);
    assert.equal(expanded.deliveryGraves.length, 3);
    assert.deepEqual(new Set(expanded.deliveryGraves.map((delivery) => delivery.state)),
      new Set(['available', 'unknown', 'cancelled_before_send']));
    assert.equal(result.candidateMetrics.counts.checkpointMissingIntents, 1);
    assert.equal(result.candidateMetrics.counts.unselectedReservations, 1);

    const checkpoint = originalInput.stores.checkpoint;
    for (const grave of expected.deliveryGraves) {
      assert.deepEqual(getReclamationDelivery(checkpoint, grave.deliveryAttemptId), grave);
    }
    const missingAttempt = byId.get('internal-missing').deliveryIntent.deliveryAttemptId;
    assert.equal(getReclamationDelivery(checkpoint, missingAttempt), null);
    assert.equal(getReclamationDelivery(checkpoint, 'no-question-attempt'), null);
  });

  test(`QGP04: ${provider} keeps runtime attempt, logical-key, and retired-period gates intact`, () => {
    const fixture = createFixture(provider);
    const originalInput = inputFor(fixture.reclaimed, fixture.selected.identity, fixture.selected.periodId);
    const expanded = expandQuestionGraveProjectionExperiment({
      originalInput,
      candidate: buildQuestionGraveProjectionExperiment(originalInput).candidate,
    });
    const checkpoint = originalInput.stores.checkpoint;
    const originalSelected = selectedOriginalRecords(originalInput);
    const attempt = originalSelected.deliveryGraves[0].deliveryAttemptId;
    const source = sourceForLaunch(checkpoint, fixture.selected.launchRef);
    const oldGrave = originalSelected.deliveryGraves.find((grave) => grave.deliveryAttemptId === attempt);
    assert.ok(oldGrave);
    assertCode(() => createReclamationDelivery(checkpoint, 'question', {
      deliveryAttemptId: 'qgp-fresh-same-logical-attempt',
      logicalMessageId: oldGrave.logicalMessageId,
      revision: oldGrave.revision,
      payload: 'fresh payload for a reclaimed logical key',
    }, source), 'logical_conflict');
    const differentLogical = createReclamationDelivery(checkpoint, 'question', {
      deliveryAttemptId: 'qgp-fresh-different-logical-attempt',
      logicalMessageId: 'qgp-different-logical-message',
      revision: 1,
      payload: 'new logical question message',
    }, source);
    assert.equal(differentLogical.created, true);
    assert.equal(differentLogical.delivery.kind, 'question');

    const otherPeriodSource = sourceForLaunch(checkpoint, fixture.otherPeriodLaunchRef);
    assertCode(() => createReclamationDelivery(checkpoint, 'instruction', {
      deliveryAttemptId: attempt,
      logicalMessageId: 'qgp-cross-kind-reuse',
      revision: 1,
      payload: 'cross-kind attempt ID reuse must remain denied',
    }, otherPeriodSource), 'delivery_reclaimed');

    let gateAnchor = fixture.active.anchor;
    const gate = createQuestionPeriodGate({ getAnchor: () => gateAnchor, canWrite: () => true });
    const token = gate.capture(fixture.selected.identity, fixture.selected.periodId);
    gateAnchor = fixture.reclaimed.anchor;
    assertCode(() => gate.assertCurrent(token), 'question_quarantined');
    assertCode(() => gate.capture(fixture.selected.identity, fixture.selected.periodId), 'question_quarantined');
    assert.doesNotThrow(() => gate.capture(fixture.selected.identity, 'period-2'));
    assert.equal(expanded.questionReservations.length, originalSelected.reservations.length);
  });

  test(`QGP05: ${provider} rejects omitted, duplicated, altered, and out-of-range candidate references`, () => {
    const fixture = createFixture(provider);
    const originalInput = inputFor(fixture.reclaimed, fixture.selected.identity, fixture.selected.periodId);
    const candidate = buildQuestionGraveProjectionExperiment(originalInput).candidate;
    const mutations = [
      (copy) => { copy.reservations.pop(); },
      (copy) => { copy.deliveryGraves.pop(); },
      (copy) => { copy.reservations.push(structuredClone(copy.reservations[0])); },
      (copy) => { copy.reservations[0].internalQuestionId = copy.reservations[1].internalQuestionId; },
      (copy) => { copy.deliveryGraves[0].sourceRefIndex = 999_999; },
      (copy) => { copy.referenceTable[0].value.launchRef = 'changed-launch-ref'; },
      (copy) => { copy.periodIdentity.nativeId = 'different-session'; },
      (copy) => { copy.logicalTombstones[0].payloadDigest = '0'.repeat(64); },
      (copy) => { copy.deliveryGraves[0].state = 'applied'; },
      (copy) => { copy.referenceTable.push(structuredClone(copy.referenceTable[0])); },
      (copy) => { copy.referenceTable.push({
        role: 'source', value: { ...copy.referenceTable[0].value, launchRef: 'unused-launch-reference' },
      }); },
    ];
    for (const mutate of mutations) {
      const tampered = structuredClone(candidate);
      mutate(tampered);
      assertRejectedCandidate(originalInput, tampered);
    }
  });

  test(`QGP06-QGP07: ${provider} is immutable, deeply frozen, and reports representation-only UTF-8 bytes`, () => {
    const fixture = createFixture(provider);
    const originalInput = inputFor(fixture.reclaimed, fixture.selected.identity, fixture.selected.periodId);
    const inputBefore = serialize(originalInput);
    assertNotDeepFrozen(originalInput);
    const result = buildQuestionGraveProjectionExperiment(originalInput);
    const mutableCandidate = structuredClone(result.candidate);
    const candidateBefore = serialize(mutableCandidate);
    assertNotDeepFrozen(mutableCandidate);
    const expanded = expandQuestionGraveProjectionExperiment({ originalInput, candidate: mutableCandidate });
    assert.deepEqual(serialize(originalInput), inputBefore);
    assert.deepEqual(serialize(mutableCandidate), candidateBefore);
    assertNotDeepFrozen(mutableCandidate);
    assert.equal(Object.isFrozen(originalInput), false);
    assert.equal(Object.isFrozen(originalInput.stores), false);
    assertDeepFrozen(result);
    assertDeepFrozen(expanded);
    assert.notEqual(expanded.questionReservations[0], originalInput.stores.questions.reservations[0]);
    assert.equal(result.candidateMetrics.compactUtf8Bytes,
      Buffer.byteLength(JSON.stringify(result.candidate), 'utf8'));
    const expectedWholeSnapshotBytes = Buffer.byteLength(JSON.stringify({
      anchor: originalInput.anchor,
      stores: originalInput.stores,
    }), 'utf8');
    assert.equal(result.candidateMetrics.wholeSnapshotCompactUtf8Bytes, expectedWholeSnapshotBytes);
    const expectedSelection = selectedOriginalRecords(originalInput);
    const baseline = {
      reservations: expectedSelection.reservations,
      deliveryGraves: expectedSelection.deliveryGraves,
      logicalTombstones: expectedSelection.logicalTombstones,
    };
    assert.equal(result.baselineMetrics.compactUtf8Bytes,
      Buffer.byteLength(JSON.stringify(baseline), 'utf8'));
    assert.ok(result.scopeLimitations.includes('compact_json_bytes_do_not_measure_memory_or_persistent_capacity_savings'));
    assert.ok(result.scopeLimitations.includes('roundtrip_does_not_grant_deletion_or_capacity_release_authority'));

    let getterCalls = 0;
    const accessorInput = { ...originalInput };
    Object.defineProperty(accessorInput, 'periodId', {
      enumerable: true,
      get() { getterCalls += 1; return originalInput.periodId; },
    });
    assertCode(() => buildQuestionGraveProjectionExperiment(accessorInput),
      'invalid_question_grave_projection_experiment');
    assert.equal(getterCalls, 0);

    let proxyTraps = 0;
    const proxyInput = new Proxy(originalInput, {
      ownKeys() { proxyTraps += 1; return Reflect.ownKeys(originalInput); },
    });
    assertCode(() => buildQuestionGraveProjectionExperiment(proxyInput),
      'invalid_question_grave_projection_experiment');
    assert.equal(proxyTraps, 0);

    let nestedProxyTraps = 0;
    const nestedProxyInput = { ...originalInput, stores: new Proxy(originalInput.stores, {
      ownKeys() { nestedProxyTraps += 1; return Reflect.ownKeys(originalInput.stores); },
    }) };
    assertCode(() => buildQuestionGraveProjectionExperiment(nestedProxyInput),
      'invalid_question_grave_projection_experiment');
    assert.equal(nestedProxyTraps, 0);

    let candidateGetterCalls = 0;
    const accessorCandidate = { ...result.candidate };
    Object.defineProperty(accessorCandidate, 'periodId', {
      enumerable: true,
      get() { candidateGetterCalls += 1; return result.candidate.periodId; },
    });
    assertCode(() => expandQuestionGraveProjectionExperiment({ originalInput, candidate: accessorCandidate }),
      'invalid_question_grave_projection_experiment');
    assert.equal(candidateGetterCalls, 0);

    let candidateProxyTraps = 0;
    const proxyCandidate = new Proxy(result.candidate, {
      ownKeys() { candidateProxyTraps += 1; return Reflect.ownKeys(result.candidate); },
    });
    assertCode(() => expandQuestionGraveProjectionExperiment({ originalInput, candidate: proxyCandidate }),
      'invalid_question_grave_projection_experiment');
    assert.equal(candidateProxyTraps, 0);
  });
}
