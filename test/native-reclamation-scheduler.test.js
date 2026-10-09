'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { test } = require('node:test');
const { createDelivery, registerPrTarget, transitionDelivery } = require('../src/server/delivery-ledger');
const { createNativeQuestionWriteIsolationHarness } = require('./support/native-question-write-isolation-harness');
const {
  createFakeTimerQueue,
  createNativeReclamationSchedulerHarness,
} = require('./support/native-reclamation-scheduler-harness');
const { threeSlotLegacySources } = require('./support/native-migration-allowance-release-harness');
const { PROVIDERS } = require('./support/native-instruction-integration-harness');

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function slots(bytes) {
  return ['checkpoint', 'instructions', 'questions'].map((slot) =>
    [slot, JSON.parse(bytes[slot].toString('utf8'))]);
}

function grants(bytes) {
  return Object.fromEntries(slots(bytes).map(([slot, snapshot]) =>
    [slot, structuredClone(snapshot.migrationAllowance)]));
}

function nativeInstructionWrites(harness, provider) {
  return harness.processesByProvider.get(provider).reduce((total, process) =>
    total + process.state.instructionWrites.length, 0);
}

async function createHarness(provider, options = {}) {
  const sources = options.sources || threeSlotLegacySources(provider);
  const fixture = await createNativeReclamationSchedulerHarness(provider, {
    sources,
    ...(options.normalByteLimitsBySlot === undefined
      ? {} : { normalByteLimitsBySlot: options.normalByteLimitsBySlot }),
    ...(options.paddingBytes === undefined ? {} : { paddingBytes: options.paddingBytes }),
    ...(options.initialNow === undefined ? {} : { initialNow: options.initialNow }),
    ...(options.autoReclaim === undefined ? {} : { autoReclaim: options.autoReclaim }),
  });
  return { ...fixture, sources };
}

async function fireNext(fixture) {
  await fixture.timers.fireNext();
  await fixture.scheduler().drain();
}

async function assertNoTemporaryFiles(harness) {
  assert.deepEqual(await fs.readdir(harness.directory).then((names) => names.filter((name) => name.endsWith('.tmp'))), []);
  await harness.nativeFileSystem.removeTemporaryFiles(harness.directory);
}

function sourcesWithCancelledTerminalDeliveries(sources) {
  const checkpoint = JSON.parse(sources.checkpoint.toString('utf8'));
  const launchRecord = checkpoint.registrations.launches[0];
  const runtimeLaunch = checkpoint.registrations.runtimeLaunches[0];
  const launch = {
    ...launchRecord.claims,
    launchRef: launchRecord.launchRef,
    state: launchRecord.state,
    identity: launchRecord.identity,
    executionBinding: launchRecord.executionBinding,
    conversationId: launchRecord.conversationId,
    sessionId: launchRecord.sessionId,
    currentOwner: runtimeLaunch.currentOwner,
    ownerGeneration: runtimeLaunch.ownerGeneration,
  };
  const targetId = 'scheduler-terminal-target';
  let ledger = registerPrTarget(checkpoint.ledger, targetId, launch).ledger;
  const resultId = 'scheduler-terminal-result';
  const result = createDelivery(ledger, 'result', {
    deliveryAttemptId: resultId,
    logicalMessageId: 'scheduler-terminal-result-logical',
    revision: 1,
    payload: 'fixture result body',
  }, launch, {
    identity: launch.identity,
    executionId: launch.currentOwner.periodId,
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
  });
  ledger = transitionDelivery(result.ledger, resultId, 'cancel').ledger;
  const notificationId = 'scheduler-terminal-pr-notification';
  const notification = createDelivery(ledger, 'pr-notification', {
    deliveryAttemptId: notificationId,
    logicalMessageId: 'scheduler-terminal-pr-notification-logical',
    revision: 1,
    payload: 'fixture PR notification body',
    targetId,
  }, launch);
  ledger = transitionDelivery(notification.ledger, notificationId, 'cancel').ledger;
  checkpoint.ledger = ledger;
  checkpoint.revision += 5;
  return {
    sources: Object.freeze({
      ...sources,
      checkpoint: Buffer.from(JSON.stringify(checkpoint), 'utf8'),
    }),
    deliveryAttemptIds: [resultId, notificationId],
  };
}

for (const provider of PROVIDERS) {
  test(`${provider} leaves automatic reclamation disabled unless configured`, async (t) => {
    for (const autoReclaim of [undefined, false]) {
      const fixture = await createHarness(provider, autoReclaim === undefined ? {} : { autoReclaim });
      t.after(() => fixture.removeDirectory());
      const before = await fixture.harness.readAllBytes();
      const context = fixture.harness.context;
      assert.equal(fixture.scheduler(), null);
      assert.equal(fixture.timers.pendingCount(), 0);
      assert.equal(Object.hasOwn(fixture.harness.integration.reclamation.status(), 'scheduler'), false);

      fixture.harness.setNow(1_000_000 + RETENTION_MS);
      assert.deepEqual(await fixture.harness.readAllBytes(), before);
      assert.deepEqual(context.listReclamationCandidates().bodyCandidates.map((candidate) => candidate.kind),
        ['question-period']);
      assert.equal(nativeInstructionWrites(fixture.harness, provider), 0);
    }
  });

  test(`${provider} automatically reclaims a checkpoint-confirmed result body without native submission`, async (t) => {
    const baseSources = threeSlotLegacySources(provider);
    const terminalSource = sourcesWithCancelledTerminalDeliveries(baseSources);
    const fixture = await createHarness(provider, {
      sources: terminalSource.sources,
      autoReclaim: { intervalMs: 40, maxOperationsPerPass: 100 },
    });
    t.after(() => fixture.removeDirectory());
    const harness = fixture.harness;
    const initial = await harness.readJson('checkpoint');
    const details = terminalSource.deliveryAttemptIds.map((deliveryAttemptId) =>
      initial.ledger.deliveries.find((item) => item.deliveryAttemptId === deliveryAttemptId));
    assert.deepEqual(details.map((detail) => detail.kind), ['result', 'pr-notification']);
    assert.ok(details.every((detail) => detail.state === 'cancelled_before_send' && detail.recordType === 'detail'));
    const deadlineAt = Math.max(...details.map((detail) => detail.terminalAt + RETENTION_MS));
    assert.ok(Number.isSafeInteger(deadlineAt));
    harness.setNow(deadlineAt);
    const nativeWritesBefore = nativeInstructionWrites(harness, provider);

    await fireNext(fixture);

    const after = await harness.readJson('checkpoint');
    const graves = terminalSource.deliveryAttemptIds.map((deliveryAttemptId) =>
      after.ledger.deliveries.find((item) => item.deliveryAttemptId === deliveryAttemptId));
    assert.deepEqual(graves.map((grave) => grave.kind), ['result', 'pr-notification']);
    assert.ok(graves.every((grave) => grave.recordType === 'reclaimed' &&
      grave.state === 'cancelled_before_send' && grave.reclamation.reason === 'terminal_retention' &&
      Boolean(grave.reclamation.operationId)));
    assert.equal(after.ledger.deliveries.length, initial.ledger.deliveries.length);
    assert.equal(nativeInstructionWrites(harness, provider), nativeWritesBefore);
    await assertNoTemporaryFiles(harness);
  });

  test(`${provider} closes the context and releases its lease when the first scheduler timer cannot be installed`, async (t) => {
    const initial = await createHarness(provider);
    t.after(() => initial.removeDirectory());
    const before = await initial.harness.readAllBytes();
    const migratedSources = Object.freeze({
      ...initial.sources,
      checkpoint: before.checkpoint,
      instructions: before.instructions,
      questions: before.questions,
    });
    await initial.harness.close();

    const timerError = Object.assign(new Error('timer setup failed'), { code: 'fixture_timer_setup_failed' });
    const timers = createFakeTimerQueue({ setTimeoutError: timerError });
    let failedModules = null;
    await assert.rejects(createNativeQuestionWriteIsolationHarness(provider, {
      directory: initial.harness.directory,
      sources: migratedSources,
      normalByteLimitsBySlot: initial.harness.normalByteLimitsBySlot,
      initialNow: initial.harness.now,
      autoReclaim: { intervalMs: 40, maxOperationsPerPass: 100 },
      schedulerTimers: timers.schedulerTimers,
      onModules(modules) { failedModules = modules; },
    }), (error) => error === timerError);

    assert.ok(failedModules);
    const failedContext = failedModules.observer.contexts().at(-1);
    const failedScheduler = failedModules.observer.schedulers().at(-1);
    assert.ok(failedContext);
    assert.ok(failedScheduler);
    assert.equal(failedContext.status().state, 'closed');
    assert.equal(failedContext.status().capacity.activeLeaseCount, 0);
    assert.equal(failedContext.canWrite(), false);
    assert.equal(failedScheduler.status().state, 'stopped');
    assert.equal(failedScheduler.status().timerPending, false);
    assert.equal(timers.pendingCount(), 0);
    const after = await initial.harness.readAllBytes();
    for (const slot of ['anchor', 'checkpoint', 'instructions', 'questions']) {
      assert.deepEqual(after[slot], before[slot]);
    }
    await assertNoTemporaryFiles(initial.harness);
  });

  test(`${provider} waits for the seven-day boundary and serializes a manual race with an automatic pass`, async (t) => {
    const fixture = await createHarness(provider, {
      paddingBytes: 700,
      autoReclaim: { intervalMs: 50, maxOperationsPerPass: 100 },
    });
    t.after(() => fixture.removeDirectory());
    const harness = fixture.harness;
    const scheduler = fixture.scheduler();
    const retiredAt = (await harness.readJson('anchor')).retiredQuestionPeriods[0].retiredAt;
    const instruction = await harness.integration.service.cancel('attempt-instruction');
    const deadline = Math.max(retiredAt, instruction.delivery.terminalAt) + RETENTION_MS;
    assert.equal(deadline, retiredAt + RETENTION_MS);
    const before = await harness.readAllBytes();
    const beforeGrants = grants(before);
    const beforeCapacity = structuredClone(harness.context.status().capacity);
    assert.ok(Object.values(beforeGrants).every((grant) => grant !== null));
    assert.deepEqual(harness.context.listReclamationCandidates().bodyCandidates.map((candidate) => candidate.kind),
      ['question-period', 'instruction']);
    assert.equal(scheduler.status().passCount, 0);
    assert.equal(fixture.timers.pendingCount(), 1);
    assert.equal(fixture.timers.scheduledDelays()[0], 50);
    assert.equal(nativeInstructionWrites(harness, provider), 0);

    harness.setNow(deadline - 1);
    await fireNext(fixture);
    assert.deepEqual(await harness.readAllBytes(), before);
    assert.equal(scheduler.status().passCount, 1);
    assert.equal(fixture.timers.pendingCount(), 1);

    harness.setNow(deadline);
    const manual = harness.integration.reclamation.reclaimQuestionBodies({
      identity: fixture.sources.question.identity,
      periodId: fixture.sources.question.periodId,
    });
    const [manualResult] = await Promise.all([manual, fixture.timers.fireNext()]);
    await scheduler.drain();
    assert.deepEqual(manualResult, {
      status: 'complete', reclaimedQuestionIds: ['internal-1'], deferredQuestionIds: [],
    });
    const after = await harness.readAllBytes();
    const [checkpoint, instructions, questions] = slots(after).map(([, value]) => value);
    assert.equal(questions.reservations.find((item) => item.internalQuestionId === 'internal-1').bodyState, 'reclaimed');
    assert.equal(questions.questions.some((item) => item.internalQuestionId === 'internal-1'), false);
    assert.equal(instructions.instructions.find((item) => item.deliveryAttemptId === 'attempt-instruction').recordType,
      'reclaimed');
    assert.equal(checkpoint.ledger.deliveries.find((item) => item.deliveryAttemptId === 'attempt-instruction').recordType,
      'reclaimed');
    assert.equal(checkpoint.ledger.deliveries.find((item) => item.deliveryAttemptId === 'common-question-selection-1').recordType,
      'reclaimed');
    assert.deepEqual(grants(after), {
      checkpoint: beforeGrants.checkpoint,
      instructions: null,
      questions: null,
    });
    assert.equal(harness.context.status().state, 'ready');
    assert.equal(harness.context.status().capacity.activeLeaseCount, 1);
    assert.ok(harness.context.status().capacity.reservedBytes < beforeCapacity.reservedBytes);
    assert.equal(scheduler.status().passCount, 2);
    assert.equal(scheduler.status().state, 'scheduled');
    assert.equal(fixture.timers.pendingCount(), 1);
    assert.equal(nativeInstructionWrites(harness, provider), 0);
    await assertNoTemporaryFiles(harness);
  });

  test(`${provider} resumes a prepared body before scheduling its first automatic pass`, async (t) => {
    const fixture = await createHarness(provider, {
      paddingBytes: 700,
      autoReclaim: { intervalMs: 25, maxOperationsPerPass: 100 },
    });
    t.after(() => fixture.removeDirectory());
    const harness = fixture.harness;
    const retiredAt = (await harness.readJson('anchor')).retiredQuestionPeriods[0].retiredAt;
    harness.setNow(retiredAt + RETENTION_MS);
    const beforeCheckpoint = await harness.readJson('checkpoint');
    harness.nativeFileSystem.armRenameRetryExhaustion({
      targetPath: harness.pathFor('checkpoint'),
      phase: 'before',
    });
    await assert.rejects(harness.integration.reclamation.reclaimQuestionBodies({
      identity: fixture.sources.question.identity,
      periodId: fixture.sources.question.periodId,
    }), { code: 'EPERM' });
    const prepared = await harness.readJson('questions');
    const preparedReservation = prepared.reservations.find((item) => item.internalQuestionId === 'internal-1');
    const operationId = preparedReservation.reclamation.operationId;
    assert.equal(preparedReservation.bodyState, 'retained');
    assert.deepEqual(await harness.readJson('checkpoint'), beforeCheckpoint);
    assert.equal(fixture.scheduler().status().passCount, 0);
    assert.equal(fixture.timers.pendingCount(), 1);

    await harness.restart();
    const resumed = await harness.readJson('questions');
    const checkpoint = await harness.readJson('checkpoint');
    assert.equal(resumed.reservations.find((item) => item.internalQuestionId === 'internal-1').bodyState, 'reclaimed');
    assert.equal(resumed.reservations.find((item) => item.internalQuestionId === 'internal-1')
      .reclamation.operationId, operationId);
    assert.equal(checkpoint.ledger.deliveries.find((item) => item.deliveryAttemptId === 'common-question-selection-1')
      .reclamation.operationId, operationId);
    assert.equal(fixture.harness.context.status().state, 'ready');
    assert.equal(fixture.scheduler().status().passCount, 0);
    assert.equal(fixture.scheduler().status().timerPending, true);
    assert.equal(fixture.timers.pendingCount(), 1);
    assert.equal(nativeInstructionWrites(harness, provider), 0);
    await assertNoTemporaryFiles(harness);
  });

  test(`${provider} defers automatic work on clock rollback and checked-deadline overflow`, async (t) => {
    const rollback = await createHarness(provider, {
      paddingBytes: 0,
      autoReclaim: { intervalMs: 20, maxOperationsPerPass: 100 },
    });
    t.after(() => rollback.removeDirectory());
    const rollbackHarness = rollback.harness;
    const rollbackBefore = await rollbackHarness.readAllBytes();
    rollbackHarness.setNow(rollbackHarness.now - 1);
    await fireNext(rollback);
    assert.deepEqual(await rollbackHarness.readAllBytes(), rollbackBefore);
    assert.equal(rollback.scheduler().status().lastFailureCode, null);
    assert.equal(rollback.scheduler().status().state, 'scheduled');
    rollbackHarness.setNow(1_000_000 + RETENTION_MS);
    await fireNext(rollback);
    assert.equal((await rollbackHarness.readJson('questions')).reservations[0].bodyState, 'reclaimed');

    const overflow = await createHarness(provider, {
      normalByteLimitsBySlot: { checkpoint: 16 * 1024 * 1024,
        instructions: 16 * 1024 * 1024, questions: 16 * 1024 * 1024 },
      autoReclaim: { intervalMs: 20, maxOperationsPerPass: 100 },
    });
    t.after(() => overflow.removeDirectory());
    const overflowHarness = overflow.harness;
    const oldRetired = (await overflowHarness.readJson('anchor')).retiredQuestionPeriods[0];
    overflowHarness.setNow(oldRetired.retiredAt + RETENTION_MS);
    await overflowHarness.integration.reclamation.reclaimQuestionBodies({
      identity: oldRetired.identity,
      periodId: oldRetired.periodId,
    });
    const started = await overflowHarness.start(provider, 'deadline-overflow');
    const registration = await overflowHarness.integration.questionService.register(started.writer, {
      questionId: `overflow-${provider}`,
      timeoutMinutes: 1,
      category: 'ordinary',
      questions: [{
        id: 'choice',
        text: 'Choose one',
        mode: 'single',
        options: [{ id: 'option-a', label: 'Option A', description: '' }],
        allowFreeText: false,
        recommendedOptionId: 'option-a',
      }],
    });
    assert.equal(registration.outcome, 'created');
    overflowHarness.setNow(MAX_SAFE_INTEGER - 1);
    const retired = await overflowHarness.integration.reclamation.retireQuestionPeriod({
      identity: started.writer.identity,
      periodId: registration.question.periodId,
    });
    assert.equal(retired.status, 'retired');
    const overflowBefore = await overflowHarness.readAllBytes();
    await fireNext(overflow);
    assert.deepEqual(await overflowHarness.readAllBytes(), overflowBefore);
    const overflowQuestion = (await overflowHarness.readJson('questions')).reservations.find((item) =>
      item.periodId === registration.question.periodId);
    assert.equal(overflowQuestion.bodyState, 'retained');
    assert.equal(overflowQuestion.reclaimedAt, null);
    assert.equal(overflow.scheduler().status().lastFailureCode, null);
    assert.equal(overflow.scheduler().status().state, 'scheduled');
  });

  test(`${provider} continues non-question work after qualified question uncertainty and freezes grants`, async (t) => {
    const fixture = await createHarness(provider, {
      paddingBytes: 700,
      autoReclaim: { intervalMs: 30, maxOperationsPerPass: 100 },
    });
    t.after(() => fixture.removeDirectory());
    const harness = fixture.harness;
    const retiredAt = (await harness.readJson('anchor')).retiredQuestionPeriods[0].retiredAt;
    const instruction = await harness.integration.service.cancel('attempt-instruction');
    const deadline = Math.max(retiredAt, instruction.delivery.terminalAt) + RETENTION_MS;
    const before = await harness.readAllBytes();
    const beforeGrants = grants(before);
    const questionOpenCountBeforePass = harness.nativeFileSystem.openCalls(harness.pathFor('questions'));
    harness.setNow(deadline);
    harness.nativeFileSystem.armRenameRetryExhaustion({
      targetPath: harness.pathFor('questions'),
      phase: 'after',
      occurrence: 2,
    });

    await fireNext(fixture);
    const after = await harness.readAllBytes();
    assert.equal(harness.context.status().state, 'degraded');
    assert.equal(harness.context.status().failureCode, null);
    assert.equal(harness.context.status().questionFailureCode, 'EPERM');
    assert.equal(harness.context.status().slotHealth.questions, 'uncertain');
    assert.equal(harness.context.status().slotHealth.checkpoint, 'ready');
    assert.equal(harness.context.status().slotHealth.instructions, 'ready');
    assert.equal(JSON.parse(after.questions.toString('utf8')).reservations[0].bodyState, 'reclaimed');
    assert.equal(JSON.parse(after.instructions.toString('utf8')).instructions
      .find((item) => item.deliveryAttemptId === 'attempt-instruction').recordType, 'reclaimed');
    assert.equal(JSON.parse(after.checkpoint.toString('utf8')).ledger.deliveries
      .find((item) => item.deliveryAttemptId === 'attempt-instruction').recordType, 'reclaimed');
    assert.deepEqual(grants(after), beforeGrants);
    assert.equal(harness.nativeFileSystem.renameCalls(harness.pathFor('questions')), 4);
    assert.equal(fixture.scheduler().status().state, 'scheduled');
    assert.equal(fixture.scheduler().status().failureCount, 0);
    assert.equal(fixture.timers.pendingCount(), 1);
    const questionOpenCountAfterPass = harness.nativeFileSystem.openCalls(harness.pathFor('questions'));
    await fireNext(fixture);
    assert.equal(harness.nativeFileSystem.openCalls(harness.pathFor('questions')), questionOpenCountAfterPass);
    assert.ok(questionOpenCountAfterPass > questionOpenCountBeforePass);
    assert.equal(fixture.scheduler().status().state, 'scheduled');
    assert.equal(nativeInstructionWrites(harness, provider), 0);
    await assertNoTemporaryFiles(harness);
  });

  test(`${provider} stops the automatic pass after a global checkpoint persistence failure`, async (t) => {
    const fixture = await createHarness(provider, {
      paddingBytes: 700,
      autoReclaim: { intervalMs: 35, maxOperationsPerPass: 100 },
    });
    t.after(() => fixture.removeDirectory());
    const harness = fixture.harness;
    const retiredAt = (await harness.readJson('anchor')).retiredQuestionPeriods[0].retiredAt;
    const instruction = await harness.integration.service.cancel('attempt-instruction');
    harness.setNow(Math.max(retiredAt, instruction.delivery.terminalAt) + RETENTION_MS);
    const before = await harness.readAllBytes();
    harness.nativeFileSystem.armRenameRetryExhaustion({
      targetPath: harness.pathFor('checkpoint'),
      phase: 'before',
    });

    await fireNext(fixture);
    const after = await harness.readAllBytes();
    assert.equal(harness.context.status().state, 'blocked');
    assert.equal(harness.context.status().failureCode, 'EPERM');
    assert.deepEqual(after.checkpoint, before.checkpoint);
    assert.deepEqual(after.instructions, before.instructions);
    assert.deepEqual(grants(after), grants(before));
    const questionJournal = JSON.parse(after.questions.toString('utf8'));
    const preparedReservation = questionJournal.reservations.find((item) => item.internalQuestionId === 'internal-1');
    assert.equal(preparedReservation.bodyState, 'retained');
    assert.ok(preparedReservation.reclamation);
    assert.equal(fixture.scheduler().status().state, 'stopped');
    assert.equal(fixture.scheduler().status().stopReason, 'failure');
    assert.equal(fixture.scheduler().status().lastFailureCode, 'EPERM');
    assert.equal(fixture.scheduler().status().failureCount, 1);
    assert.equal(fixture.timers.pendingCount(), 0);
    assert.equal(nativeInstructionWrites(harness, provider), 0);
    await assertNoTemporaryFiles(harness);
  });

  test(`${provider} stops timers and later operations when close races a held automatic save`, async (t) => {
    const fixture = await createHarness(provider, {
      paddingBytes: 700,
      autoReclaim: { intervalMs: 40, maxOperationsPerPass: 100 },
    });
    t.after(() => fixture.removeDirectory());
    const harness = fixture.harness;
    const retiredAt = (await harness.readJson('anchor')).retiredQuestionPeriods[0].retiredAt;
    harness.setNow(retiredAt + RETENTION_MS);
    const before = await harness.readAllBytes();
    const beforeCapacity = structuredClone(harness.context.status().capacity);
    const hold = harness.nativeFileSystem.armRenameRetryExhaustion({
      targetPath: harness.pathFor('questions'),
      phase: 'before',
      hold: true,
    });

    const pass = fixture.timers.fireNext();
    await hold.entered;
    const close = harness.integration.close();
    assert.equal(fixture.scheduler().status().stopped, true);
    assert.equal(fixture.timers.pendingCount(), 0);
    assert.equal(harness.context.status().closing, true);
    assert.equal(harness.context.canWrite(), false);
    hold.release();
    await Promise.all([pass, close]);

    const after = await harness.readAllBytes();
    assert.deepEqual(after.questions, before.questions);
    assert.deepEqual(after.checkpoint, before.checkpoint);
    assert.deepEqual(after.instructions, before.instructions);
    assert.deepEqual(grants(after), grants(before));
    assert.equal(harness.context.status().state, 'closed');
    assert.equal(harness.context.status().capacity.activeLeaseCount, 0);
    assert.ok(beforeCapacity.activeLeaseCount > 0);
    assert.equal(fixture.scheduler().status().state, 'stopped');
    assert.equal(fixture.scheduler().status().timerPending, false);
    assert.equal(fixture.timers.pendingCount(), 0);
    assert.equal(harness.nativeFileSystem.renameCalls(harness.pathFor('questions')), 4);
    assert.equal(nativeInstructionWrites(harness, provider), 0);
    await assertNoTemporaryFiles(harness);
  });
}
