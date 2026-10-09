'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const test = require('node:test');
const kernel = require('../src/server/common-question-kernel');
const {
  normalizeQuestionJournalV2Local,
  normalizeQuestionReservation,
} = require('../src/server/common-question-reclamation-codec');
const { normalizeQuestionReclamationAnchorV1Local } = require('../src/server/question-reclamation-anchor-codec');
const { createReclamationServiceHarness, PROVIDERS } = require('./helpers/reclamation-service-harness');

const QUESTION = Object.freeze({
  id: 'decision',
  text: 'Choose one',
  mode: 'single',
  options: [{ id: 'continue', label: 'Continue', description: '' }],
  allowFreeText: false,
  recommendedOptionId: null,
});

function questionRegistration(questionId) {
  return {
    questionId,
    category: 'ordinary',
    timeoutMinutes: 1,
    questions: [structuredClone(QUESTION)],
  };
}

function answer() {
  return { answers: [{ questionId: 'decision', optionIds: ['continue'], freeText: null }] };
}

async function registerQuestion(harness, execution, questionId) {
  return harness.questionService.register(execution.child.writer, questionRegistration(questionId));
}

function hasCode(code) {
  return (error) => error?.code === code;
}

function callbackCorrelation(delivery) {
  return {
    deliveryAttemptId: delivery.deliveryAttemptId,
    revision: delivery.revision,
    payloadDigest: delivery.payloadDigest,
    targetPeriodId: delivery.target.periodId,
    nativeTurnId: delivery.kind === 'instruction' ? 'turn-' + delivery.deliveryAttemptId
      : 'callback-turn-' + delivery.deliveryAttemptId,
    nativeItemId: 'item-' + delivery.deliveryAttemptId,
    clientRequestId: delivery.deliveryAttemptId,
  };
}

function reclaimedQuestionSeed({ primary, emptyAnchor, emptyStores, product }) {
  const identity = structuredClone(primary.child.identity);
  const periodId = primary.child.registration.executionId;
  const source = product.launchKernel.registry.get(primary.launchRef);
  const internalQuestionId = 'cq-aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const quarantinedAt = 900_001;
  const preparedAt = quarantinedAt + 604_800_000;
  const reservation = normalizeQuestionReservation({
    internalQuestionId,
    identity,
    periodId,
    questionId: 'grave-question',
    contentDigest: kernel.sha256Json({ category: 'ordinary', questions: [QUESTION] }),
    executionId: periodId,
    conversationId: source.conversationId,
    launchRef: primary.launchRef,
    executionBinding: {
      periodId,
      actor: structuredClone(primary.child.actor),
    },
    createdAt: 800_000,
    revision: 0,
    selectionSource: null,
    selectedAt: null,
    deliveryIntent: null,
    deliveryCreationState: 'not_created',
    checkpointState: null,
    sourceClaimsDigest: null,
    sessionId: null,
    externalResolution: null,
    cancelledAt: null,
    terminalResultKind: null,
    quarantinedAt,
    bodyState: 'reclaimed',
    reclaimedAt: preparedAt + 1,
    reclamation: {
      operationId: '33333333-3333-4333-8333-333333333333',
      preparedAt,
      deliveryPresence: 'none',
      checkpointState: null,
    },
  });
  const anchor = normalizeQuestionReclamationAnchorV1Local({
    ...emptyAnchor,
    revision: 1,
    retiredQuestionPeriods: [{ identity, periodId, retiredAt: quarantinedAt, reason: 'confirmed-retirement' }],
  });
  const questions = normalizeQuestionJournalV2Local({
    ...emptyStores.questions,
    revision: 1,
    reservations: [reservation],
  });
  return { anchor, stores: { questions } };
}

for (const provider of PROVIDERS) {
  test(`actual ${provider} composition preserves live periods and retires only the selected question period`, async (t) => {
    const harness = await createReclamationServiceHarness(provider);
    t.after(() => harness.close());

    const selected = await registerQuestion(harness, harness.resumed, 'question-retired');
    const unrelated = await registerQuestion(harness, harness.unrelated, 'question-unrelated');
    await harness.questionService.submitAnswer(selected.question.internalQuestionId, answer());
    let sinkCalls = 0;
    const delivered = await harness.questionService.answerPoll(harness.resumed.child.writer,
      'question-retired', () => { sinkCalls += 1; });
    assert.equal(delivered.outcome, 'sent');
    assert.equal(sinkCalls, 1);

    const unrelatedBefore = harness.questionBackend.getSnapshot().questions.find((item) =>
      item.internalQuestionId === unrelated.question.internalQuestionId);
    const deliveryId = selected.question.deliveryAttemptId ||
      (await harness.questionService.status(harness.resumed.child.writer, 'question-retired')).deliveryAttemptId;
    const retiredPeriodId = harness.resumed.child.registration.executionId;
    await harness.context.retireQuestionPeriod({
      identity: harness.resumed.child.identity,
      periodId: retiredPeriodId,
      questionService: harness.questionService,
      deliveryStore: harness.deliveryStore,
    });

    const questionSnapshot = harness.questionBackend.getSnapshot();
    const retiredReservation = questionSnapshot.reservations.find((item) =>
      item.internalQuestionId === selected.question.internalQuestionId);
    assert.equal(retiredReservation.quarantinedAt, 1_000_000);
    assert.equal(retiredReservation.bodyState, 'retained');
    const dashboard = await harness.questionService.dashboardSnapshot();
    assert.equal(dashboard.questions.find((item) => item.internalQuestionId === selected.question.internalQuestionId)
      .quarantined, true);
    assert.equal(dashboard.questions.find((item) => item.internalQuestionId === unrelated.question.internalQuestionId)
      .quarantined, false);
    assert.equal(harness.questionService.getQuarantineDiagnostics().quarantinedCount, 1);
    assert.equal((await harness.deliveryStore.snapshot()).deliveries.find((item) =>
      item.deliveryAttemptId === deliveryId).state, 'unknown');
    assert.deepEqual(questionSnapshot.questions.find((item) =>
      item.internalQuestionId === unrelated.question.internalQuestionId), unrelatedBefore);
    assert.equal((await harness.questionService.status(harness.unrelated.child.writer, 'question-unrelated'))
      .internalQuestionId, unrelated.question.internalQuestionId);

    const writesAfterRetirement = { ...harness.saveCounts };
    const staleCalls = [
      () => harness.questionService.register(harness.resumed.child.writer, questionRegistration('question-retired')),
      () => harness.questionService.status(harness.resumed.child.writer, 'question-retired'),
      () => harness.questionService.answerPoll(harness.resumed.child.writer, 'question-retired', () => { sinkCalls += 1; }),
      () => harness.questionService.submitAnswer(selected.question.internalQuestionId, answer()),
      () => harness.questionService.hold(selected.question.internalQuestionId, true),
      () => harness.questionService.cancel(selected.question.internalQuestionId),
      () => harness.questionService.resolveExternal(selected.question.internalQuestionId, { source: 'late-callback' }),
      () => harness.questionService.reportResponseLost(selected.question.internalQuestionId),
      () => harness.questionService.readLateAnswerDraft(selected.question.internalQuestionId, 0, 'a'.repeat(64)),
      () => harness.providerDeliveryStore.createQuestionDelivery({
        launchRef: harness.resumed.launchRef,
        deliveryAttemptId: 'late-question-attempt',
        logicalMessageId: 'late-question-logical',
        revision: 1,
        payload: '{}',
      }),
      () => harness.providerDeliveryStore.claim(deliveryId),
      () => harness.providerDeliveryStore.cancel(deliveryId),
      () => harness.providerDeliveryStore.sendStart(deliveryId, () => { sinkCalls += 1; }),
      () => harness.deliveryStore.snapshot().then((snapshot) => harness.providerDeliveryStore.recordAccepted(
        deliveryId, callbackCorrelation(snapshot.deliveries.find((item) => item.deliveryAttemptId === deliveryId)))),
      () => harness.deliveryStore.snapshot().then((snapshot) => harness.providerDeliveryStore.recordApplied(
        deliveryId, callbackCorrelation(snapshot.deliveries.find((item) => item.deliveryAttemptId === deliveryId)))),
      () => harness.providerDeliveryStore.rehydratePayload(deliveryId, '{}'),
    ];
    for (const call of staleCalls) {
      await assert.rejects(() => Promise.resolve().then(call), hasCode('question_quarantined'));
    }
    await harness.questionService.tick();
    await harness.questionService.notifyAwayChanged();
    assert.deepEqual(harness.saveCounts, writesAfterRetirement);
    assert.equal(sinkCalls, 1);

    harness.endExecution(harness.resumed);
    const fresh = harness.createExecution(`fresh-${provider}`, harness.resumed.child.identity, { resume: true });
    const freshQuestion = await registerQuestion(harness, fresh, 'question-retired');
    assert.equal(freshQuestion.outcome, 'created');
    assert.notEqual(freshQuestion.question.internalQuestionId, selected.question.internalQuestionId);
  });

  test(`actual ${provider} composition reserves reclaimed internal IDs and counts every reservation toward maxRecords`, async (t) => {
    const seeded = await createReclamationServiceHarness(provider, {
      initialSnapshotsFactory: reclaimedQuestionSeed,
    });
    t.after(() => seeded.close());
    const grave = seeded.questionBackend.getSnapshot().reservations[0];
    assert.equal(grave.bodyState, 'reclaimed');
    assert.equal(await seeded.questionService.status(seeded.resumed.child.writer, 'grave-question'), null);

    const randomUUIDDescriptor = Object.getOwnPropertyDescriptor(crypto, 'randomUUID');
    Object.defineProperty(crypto, 'randomUUID', {
      ...randomUUIDDescriptor,
      value: () => grave.internalQuestionId.slice(3),
    });
    try {
      await assert.rejects(registerQuestion(seeded, seeded.resumed, 'new-question'),
        hasCode('question_internal_id_unavailable'));
    } finally {
      Object.defineProperty(crypto, 'randomUUID', randomUUIDDescriptor);
    }
    assert.equal(seeded.saveCounts.questions, 0);

    const limited = await createReclamationServiceHarness(provider, { maxRecords: 1 });
    t.after(() => limited.close());
    const first = await registerQuestion(limited, limited.resumed, 'first-question');
    await limited.context.retireQuestionPeriod({
      identity: limited.resumed.child.identity,
      periodId: limited.resumed.child.registration.executionId,
      questionService: limited.questionService,
      deliveryStore: limited.deliveryStore,
    });
    limited.endExecution(limited.resumed);
    const fresh = limited.createExecution(`limited-fresh-${provider}`, limited.resumed.child.identity, { resume: true });
    const writesBefore = limited.saveCounts.questions;
    await assert.rejects(registerQuestion(limited, fresh, 'second-question'),
      hasCode('question_quarantine_capacity'));
    assert.equal(limited.questionBackend.getSnapshot().reservations.length, 1);
    assert.equal(limited.saveCounts.questions, writesBefore);
    assert.ok(first.question.internalQuestionId);
  });

  test(`actual ${provider} composition rejects a question sink after retirement starts but before checkpoint persistence`, async (t) => {
    const harness = await createReclamationServiceHarness(provider);
    t.after(() => harness.close());

    const registered = await registerQuestion(harness, harness.resumed, 'question-race');
    await harness.questionService.submitAnswer(registered.question.internalQuestionId, answer());
    const deliveryId = (await harness.questionService.status(harness.resumed.child.writer, 'question-race'))
      .deliveryAttemptId;
    harness.holdNextCheckpointSave();
    let sinkCalls = 0;
    const pendingSend = harness.providerDeliveryStore.sendStart(deliveryId, () => { sinkCalls += 1; });
    await harness.checkpointSaveEntered;

    const retiring = harness.context.retireQuestionPeriod({
      identity: harness.resumed.child.identity,
      periodId: harness.resumed.child.registration.executionId,
      questionService: harness.questionService,
      deliveryStore: harness.deliveryStore,
    });
    assert.equal(harness.context.periodGate.snapshot().retiringCount, 1);
    harness.releaseCheckpointSave();
    await assert.rejects(pendingSend, hasCode('question_quarantined'));
    await retiring;
    assert.equal(sinkCalls, 0);
    const delivery = (await harness.deliveryStore.snapshot()).deliveries.find((item) =>
      item.deliveryAttemptId === deliveryId);
    assert.notEqual(delivery.state, 'sending');
  });

  test(`actual ${provider} composition rechecks the question token at persistence entry after retirement starts`, async (t) => {
    const harness = await createReclamationServiceHarness(provider);
    t.after(() => harness.close());

    const registered = await registerQuestion(harness, harness.resumed, `question-save-race-${provider}`);
    const checkpoint = harness.checkpointBackend.getSnapshot();
    checkpoint.revision += 1;
    checkpoint.ledger.revision += 1;
    const persistenceBarrier = harness.holdNextPersistenceWrite('checkpoint');
    const blockingCheckpointSave = harness.checkpointBackend.save(checkpoint);
    await persistenceBarrier.entered;

    const questionSaveEnqueued = harness.waitForNextQuestionSaveEnqueued();
    const pendingAnswer = harness.questionService.submitAnswer(registered.question.internalQuestionId, answer());
    await questionSaveEnqueued;

    const questionWritesBeforeRetirement = harness.persistenceCounts.questions.writes;
    const retiring = harness.context.retireQuestionPeriod({
      identity: harness.resumed.child.identity,
      periodId: harness.resumed.child.registration.executionId,
      questionService: harness.questionService,
      deliveryStore: harness.deliveryStore,
    });
    assert.equal(harness.context.periodGate.snapshot().retiringCount, 1);
    persistenceBarrier.release();

    await blockingCheckpointSave;
    await assert.rejects(pendingAnswer, hasCode('question_quarantined'));
    await retiring;
    assert.equal(harness.context.canWrite(), true);
    assert.equal(harness.persistenceCounts.questions.writes, questionWritesBeforeRetirement + 1);
    const persisted = harness.questionBackend.getSnapshot().questions.find((item) =>
      item.internalQuestionId === registered.question.internalQuestionId);
    assert.equal(persisted.selection, null);
    assert.ok(persisted.quarantinedAt !== null);
  });

  test(`actual ${provider} composition preserves delayed instruction and PR callbacks after question retirement`, async (t) => {
    const harness = await createReclamationServiceHarness(provider);
    t.after(() => harness.close());

    await registerQuestion(harness, harness.resumed, 'question-retire-instruction');
    const instruction = (await harness.instructionService.create({
      deliveryAttemptId: `instruction-attempt-${provider}`,
      launchRef: harness.resumed.launchRef,
      logicalMessageId: `instruction-logical-${provider}`,
      revision: 0,
      text: 'ordinary instruction',
      mode: 'steer',
      expectedTurnId: `turn-instruction-attempt-${provider}`,
    })).delivery;
    await harness.providerDeliveryStore.registerPrNotificationTarget({
      targetId: `pr-target-${provider}`,
      launchRef: harness.prTarget.launchRef,
    });
    const prNotification = await harness.providerDeliveryStore.createPrNotification({
      sourceLaunchRef: harness.resumed.launchRef,
      targetId: `pr-target-${provider}`,
      deliveryAttemptId: `pr-attempt-${provider}`,
      logicalMessageId: `pr-logical-${provider}`,
      revision: 0,
      payload: 'review status changed',
    });
    await harness.providerDeliveryStore.sendStart(instruction.deliveryAttemptId, () => undefined);
    await harness.providerDeliveryStore.sendStart(prNotification.deliveryAttemptId, () => undefined);

    const instructionJournalBefore = await harness.instructionJournal.load();
    await harness.context.retireQuestionPeriod({
      identity: harness.resumed.child.identity,
      periodId: harness.resumed.child.registration.executionId,
      questionService: harness.questionService,
      deliveryStore: harness.deliveryStore,
    });
    const questionSnapshotAfterRetirement = harness.questionBackend.getSnapshot();

    const terminalTimes = new Map();
    for (const delivery of [instruction, prNotification]) {
      const correlation = callbackCorrelation(delivery);
      assert.equal((await harness.providerDeliveryStore.recordAccepted(delivery.deliveryAttemptId, correlation)).state,
        'accepted');
      harness.setNow(1_000_100);
      const applied = await harness.providerDeliveryStore.recordApplied(delivery.deliveryAttemptId, correlation);
      assert.equal(applied.state, 'applied');
      terminalTimes.set(delivery.deliveryAttemptId, applied.terminalAt);
      harness.setNow(1_001_000);
      const repeated = await harness.providerDeliveryStore.recordApplied(delivery.deliveryAttemptId, correlation);
      assert.equal(repeated.terminalAt, terminalTimes.get(delivery.deliveryAttemptId));
    }
    assert.deepEqual(harness.questionBackend.getSnapshot(), questionSnapshotAfterRetirement);
    assert.deepEqual(await harness.instructionJournal.load(), instructionJournalBefore);
    for (const deliveryId of terminalTimes.keys()) {
      const current = (await harness.deliveryStore.snapshot()).deliveries.find((item) =>
        item.deliveryAttemptId === deliveryId);
      assert.equal(current.state, 'applied');
      assert.equal(current.terminalAt, terminalTimes.get(deliveryId));
    }
  });

  test(`actual ${provider} composition keeps instruction creation local while question retirement drains checkpoint work`, async (t) => {
    const harness = await createReclamationServiceHarness(provider);
    t.after(() => harness.close());

    await registerQuestion(harness, harness.resumed, 'question-retire-creating');
    harness.holdNextCheckpointSave();
    const creating = harness.instructionService.create({
      deliveryAttemptId: `creating-instruction-${provider}`,
      launchRef: harness.resumed.launchRef,
      logicalMessageId: `creating-logical-${provider}`,
      revision: 0,
      text: 'instruction creation in progress',
      mode: 'steer',
      expectedTurnId: `turn-creating-instruction-${provider}`,
    });
    await harness.checkpointSaveEntered;
    const creatingSnapshot = harness.instructionBackend.getSnapshot();
    assert.equal(creatingSnapshot.instructions[0].deliveryCreationState, 'creating');
    const instructionWrites = harness.saveCounts.instructions;

    const retiring = harness.context.retireQuestionPeriod({
      identity: harness.resumed.child.identity,
      periodId: harness.resumed.child.registration.executionId,
      questionService: harness.questionService,
      deliveryStore: harness.deliveryStore,
    });
    assert.deepEqual(harness.instructionBackend.getSnapshot(), creatingSnapshot);
    assert.equal(harness.saveCounts.instructions, instructionWrites);
    harness.releaseCheckpointSave();
    const created = await creating;
    await retiring;
    assert.equal(created.outcome, 'created');
    assert.equal(harness.instructionBackend.getSnapshot().instructions[0].deliveryCreationState, 'checkpointed');
    assert.equal(harness.saveCounts.instructions, instructionWrites + 1);
  });

  test(`actual ${provider} composition drains local question work without waiting for an external sink promise`, async (t) => {
    const harness = await createReclamationServiceHarness(provider);
    t.after(() => harness.close());

    const registered = await registerQuestion(harness, harness.resumed, 'question-pending-sink');
    await harness.questionService.submitAnswer(registered.question.internalQuestionId, answer());
    const deliveryId = (await harness.questionService.status(harness.resumed.child.writer, 'question-pending-sink'))
      .deliveryAttemptId;
    let resolveExternal;
    let externalSettled = false;
    const externalPromise = new Promise((resolve) => { resolveExternal = resolve; });
    externalPromise.then(() => { externalSettled = true; });

    const delivery = await harness.providerDeliveryStore.sendStart(deliveryId, () => externalPromise);
    assert.equal(delivery.state, 'sending');
    await harness.deliveryStore.reclamationWriter.drain();
    await harness.questionService.reclamationWriter.drain();
    assert.equal(externalSettled, false);
    resolveExternal();
  });
}
