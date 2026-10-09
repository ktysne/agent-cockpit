'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createQuestionRecord, selectionFor } = require('../src/server/common-question-kernel');
const { createDelivery, createEmptyLedger } = require('../src/server/delivery-ledger');
const { makeEmptyCheckpoint } = require('../src/server/durable-checkpoint');
const { planQuestionBodyReclamation } = require('../src/server/question-body-reclamation');
const { encodeCheckpointV3Local } = require('../src/server/delivery-reclamation-codec');
const { createNativeQuestionBodyReclamationHarness } = require('./support/native-question-body-reclamation-harness');

const PROVIDERS = ['claude', 'codex'];
const DATA_FILES = Object.freeze({
  checkpoint: 'delivery-checkpoint.json',
  instructions: 'instruction-journal.json',
  questions: 'common-question-journal.json',
});
const ANCHOR_FILE = 'question-reclamation-anchor.json';
const RETENTION_MS = 604_800_000;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function legacyQuestion(provider) {
  return createQuestionRecord({
    internalQuestionId: 'internal-1',
    questionId: 'public-1',
    identity: {
      provider,
      nativeIdKind: provider === 'claude' ? 'session' : 'thread',
      hostId: `host-${provider}`,
      homeScopeId: `home-${provider}`,
      nativeId: 'native-1',
    },
    periodId: 'period-1',
    executionId: 'execution-1',
    conversationId: 'conversation-1',
    launchRef: 'launch-1',
    executionBinding: { periodId: 'period-1', actor: { kind: 'agent', id: 'actor-1' } },
    category: 'ordinary',
    questions: [{
      id: 'question-1',
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
  checkpoint.registrations.conversations = [{ conversationId: launch.conversationId, identity: launch.identity }];
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
    contextId: 'source-context',
    launchRef: launch.launchRef,
    immutableExecutionClaims,
    connectionScope: scope,
    connectionGeneration: 1,
    state: 'active',
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
    launchId: 'launch-id',
    runId: 'run-id',
    attemptId: 'attempt-id',
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
  const envelope = JSON.stringify({ schemaVersion: 1, mode: 'start', expectedTurnId: null, input });
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
    question: selected,
  };
}

function questionRegistration(questionId) {
  return {
    questionId,
    timeoutMinutes: 1,
    category: 'ordinary',
    questions: [{
      id: `choice-${questionId}`,
      text: 'Choose an option',
      mode: 'single',
      options: [{ id: 'option-a', label: 'Option A', description: '' }],
      allowFreeText: false,
      recommendedOptionId: 'option-a',
    }],
  };
}

function answerFor(questionId) {
  return { answers: [{ questionId: `choice-${questionId}`, optionIds: ['option-a'], freeText: null }] };
}

function reclamationConfig({ normalByteLimitsBySlot, maxRecordsBySlot = {} } = {}) {
  return {
    maxAdditionalBytes: 64 * 1024 * 1024,
    normalByteLimitsBySlot: normalByteLimitsBySlot || {
      checkpoint: 16 * 1024 * 1024,
      instructions: 16 * 1024 * 1024,
      questions: 16 * 1024 * 1024,
    },
    maxRecordsBySlot: { checkpoint: 50_000, instructions: 20_000, questions: 20_000, ...maxRecordsBySlot },
  };
}

async function temporaryDirectory(prefix) {
  const root = await fs.realpath(os.tmpdir());
  return fs.mkdtemp(path.join(root, prefix));
}

async function writeLegacySources(directory, sources) {
  await Promise.all(Object.entries(DATA_FILES).map(([slot, basename]) =>
    fs.writeFile(path.join(directory, basename), sources[slot])));
}

async function createHarness(t, provider, options = {}) {
  const directory = options.directory || await temporaryDirectory('native-question-body-reclamation-');
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  if (options.sources) await writeLegacySources(directory, options.sources);
  let now = options.initialNow ?? 1_000_000;
  const normalByteLimitsBySlot = options.sources
    ? Object.fromEntries(Object.keys(DATA_FILES).map((slot) => [slot, options.sources[slot].length]))
    : undefined;
  const harness = createNativeQuestionBodyReclamationHarness({
    directory,
    now: () => now,
    reclamation: reclamationConfig({
      normalByteLimitsBySlot: options.normalByteLimitsBySlot || normalByteLimitsBySlot,
      maxRecordsBySlot: options.maxRecordsBySlot,
    }),
  });
  t.after(async () => { try { await harness.close(); } catch {} });
  await harness.ready;
  return { directory, harness, setNow(value) { now = value; }, getNow() { return now; } };
}

async function startWriter(harness, provider, suffix) {
  const started = await harness.start(provider, suffix);
  const launchRef = started.result?.launchRef || started.launchRef;
  const writer = harness.writerFor(launchRef);
  assert.ok(writer);
  return { started, writer };
}

async function registerQuestion(harness, writer, questionId) {
  const result = await harness.questionService.register(writer, questionRegistration(questionId));
  assert.equal(result.outcome, 'created');
  return result.question;
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readSlotBytes(directory) {
  return Object.fromEntries(await Promise.all(Object.entries(DATA_FILES).map(async ([slot, basename]) =>
    [slot, await fs.readFile(path.join(directory, basename))])));
}

function totalInstructionWrites(harness, provider) {
  return harness.processesByProvider.get(provider).reduce((sum, process) =>
    sum + process.state.instructionWrites.length, 0);
}

for (const provider of PROVIDERS) {
  test(`${provider} retains question bodies until due, then reclaims only details and preserves capacity`, async (t) => {
    const { harness, setNow } = await createHarness(t, provider, { maxRecordsBySlot: { questions: 5 } });
    const { writer } = await startWriter(harness, provider, 'body-state-matrix');
    const questions = [];

    const notCreated = await registerQuestion(harness, writer, `none-${provider}`);
    questions.push(notCreated);

    const available = await registerQuestion(harness, writer, `available-${provider}`);
    await harness.questionService.submitAnswer(available.internalQuestionId, answerFor(available.questionId));
    questions.push(available);

    const unknown = await registerQuestion(harness, writer, `unknown-${provider}`);
    await harness.questionService.submitAnswer(unknown.internalQuestionId, answerFor(unknown.questionId));
    await harness.questionService.answerPoll(writer, unknown.questionId, () => undefined);
    await harness.questionService.reportResponseLost(unknown.internalQuestionId);
    questions.push(unknown);

    const terminal = await registerQuestion(harness, writer, `terminal-${provider}`);
    await harness.questionService.submitAnswer(terminal.internalQuestionId, answerFor(terminal.questionId));
    await harness.questionService.cancel(terminal.internalQuestionId);
    questions.push(terminal);

    const beforeRetirement = await readJson(harness.questionJournalPath);
    const reservationIds = beforeRetirement.reservations.map((item) => item.internalQuestionId).sort();
    const identity = writer.identity;
    const periodId = writer.executionId;
    assert.ok(questions.every((question) => question.periodId === periodId));
    const retired = await harness.reclamationService.retireQuestionPeriod({ identity, periodId });
    assert.equal(retired.status, 'retired');
    const anchor = await readJson(path.join(harness.directory, ANCHOR_FILE));
    const retiredAt = anchor.retiredQuestionPeriods.find((item) => item.periodId === periodId).retiredAt;

    setNow(retiredAt + RETENTION_MS - 1);
    const earlyQuestionBytes = await fs.readFile(harness.questionJournalPath);
    const early = await harness.reclamationService.reclaimQuestionBodies({ identity, periodId });
    assert.equal(early.status, 'deferred');
    assert.deepEqual(await fs.readFile(harness.questionJournalPath), earlyQuestionBytes);

    setNow(retiredAt + RETENTION_MS);
    const complete = await harness.reclamationService.reclaimQuestionBodies({ identity, periodId });
    assert.equal(complete.status, 'complete');
    assert.deepEqual([...complete.reclaimedQuestionIds].sort(), reservationIds);
    assert.deepEqual(complete.deferredQuestionIds, []);

    const reclaimedQuestions = await readJson(harness.questionJournalPath);
    const reclaimedCheckpoint = await readJson(harness.checkpointPath);
    assert.equal(reclaimedQuestions.questions.length, 0);
    assert.equal(reclaimedQuestions.reservations.length, 4);
    assert.equal(reclaimedQuestions.reservations.every((item) => item.bodyState === 'reclaimed'), true);
    assert.equal(reclaimedQuestions.reservations.every((item) => item.reclamation !== null), true);
    assert.deepEqual(reclaimedQuestions.reservations.map((item) => item.internalQuestionId).sort(), reservationIds);
    const graves = reclaimedCheckpoint.ledger.deliveries.filter((item) => item.kind === 'question');
    assert.equal(graves.length, 3);
    assert.equal(graves.every((item) => item.recordType === 'reclaimed'), true);
    const deliveryAttemptByInternalQuestionId = new Map(reclaimedQuestions.reservations.map((item) =>
      [item.internalQuestionId, item.deliveryIntent?.deliveryAttemptId ?? null]));
    for (const [question, expectedState] of [
      [available, 'available'], [unknown, 'unknown'], [terminal, 'cancelled_before_send'],
    ]) {
      const deliveryAttemptId = deliveryAttemptByInternalQuestionId.get(question.internalQuestionId);
      const grave = graves.find((item) => item.deliveryAttemptId === deliveryAttemptId);
      assert.equal(grave.state, expectedState);
    }
    assert.equal(harness.questionService.getQuarantineDiagnostics().remainingCount, 1);

    await assert.rejects(harness.questionService.submitAnswer(notCreated.internalQuestionId,
      answerFor(notCreated.questionId)));
    await assert.rejects(harness.questionService.register(writer, questionRegistration(notCreated.questionId)));
    await assert.rejects(harness.questionService.answerPoll(writer, available.questionId, () => undefined));
    await assert.rejects(harness.questionService.reportResponseLost(unknown.internalQuestionId));
    assert.equal(totalInstructionWrites(harness, provider), 0);

    const { writer: freshWriter } = await startWriter(harness, provider, 'new-period-after-reclaim');
    const fresh = await registerQuestion(harness, freshWriter, `fresh-${provider}`);
    assert.notEqual(fresh.periodId, periodId);
    assert.equal(harness.questionService.getQuarantineDiagnostics().remainingCount, 0);
    await assert.rejects(harness.questionService.register(freshWriter,
      questionRegistration(`over-limit-${provider}`)), { code: 'question_quarantine_capacity' });
    assert.equal(totalInstructionWrites(harness, provider), 0);
  });

  test(`${provider} preserves migrated question grants and reservation count after body reclamation`, async (t) => {
    const sources = threeSlotLegacySources(provider);
    const { harness, setNow } = await createHarness(t, provider, { sources, maxRecordsBySlot: { questions: 1 } });
    const migrated = await readJson(harness.questionJournalPath);
    const originalGrant = structuredClone(migrated.migrationAllowance);
    const originalAttempt = migrated.reservations[0].deliveryIntent.deliveryAttemptId;
    const originalDeliveryCount = (await readJson(harness.checkpointPath)).ledger.deliveries.length;
    assert.ok(originalGrant);
    assert.equal(originalGrant.sourceSizeBytes, sources.questions.length);
    const anchor = await readJson(path.join(harness.directory, ANCHOR_FILE));
    const retired = anchor.retiredQuestionPeriods.find((item) => item.periodId === sources.question.periodId);
    assert.ok(retired);

    setNow(retired.retiredAt + RETENTION_MS);
    const result = await harness.reclamationService.reclaimQuestionBodies({
      identity: sources.question.identity,
      periodId: sources.question.periodId,
    });
    assert.equal(result.status, 'complete');

    const afterQuestionJournal = await readJson(harness.questionJournalPath);
    const afterCheckpoint = await readJson(harness.checkpointPath);
    assert.deepEqual(afterQuestionJournal.migrationAllowance, originalGrant);
    assert.equal(afterQuestionJournal.reservations.length, 1);
    assert.equal(afterQuestionJournal.reservations[0].bodyState, 'reclaimed');
    assert.equal(afterQuestionJournal.reservations[0].deliveryIntent.deliveryAttemptId, originalAttempt);
    assert.equal(afterCheckpoint.ledger.deliveries.length, originalDeliveryCount);
    assert.equal(afterCheckpoint.ledger.deliveries.find((item) => item.deliveryAttemptId === originalAttempt).recordType,
      'reclaimed');
    assert.equal(harness.questionService.getQuarantineDiagnostics().remainingCount, 0);

    const { writer } = await startWriter(harness, provider, 'capacity-remains-used');
    await assert.rejects(harness.questionService.register(writer, questionRegistration(`blocked-${provider}`)),
      { code: 'question_quarantine_capacity' });
    assert.equal(totalInstructionWrites(harness, provider), 0);
  });

  test(`${provider} rejects accepted and applied events for a reclaimed delivery without writes`, async (t) => {
    const sources = threeSlotLegacySources(provider);
    const { harness, setNow } = await createHarness(t, provider, { sources });
    const deliveryAdapter = harness.deliveryAdapter(provider);
    assert.ok(deliveryAdapter);
    const attemptId = sources.question.deliveryIntent.deliveryAttemptId;
    const checkpointBefore = await fs.readFile(harness.checkpointPath);
    const checkpoint = JSON.parse(checkpointBefore.toString('utf8'));
    const detail = checkpoint.ledger.deliveries.find((item) => item.deliveryAttemptId === attemptId);
    assert.equal(detail.recordType, 'detail');
    const anchor = await readJson(path.join(harness.directory, ANCHOR_FILE));
    const retiredAt = anchor.retiredQuestionPeriods.find((item) => item.periodId === sources.question.periodId).retiredAt;
    setNow(retiredAt + RETENTION_MS);

    const result = await harness.reclamationService.reclaimQuestionBodies({
      identity: sources.question.identity,
      periodId: sources.question.periodId,
    });
    assert.equal(result.status, 'complete');
    const checkpointAfterReclamation = await fs.readFile(harness.checkpointPath);
    const reclaimed = JSON.parse(checkpointAfterReclamation.toString('utf8')).ledger.deliveries
      .find((item) => item.deliveryAttemptId === attemptId);
    assert.equal(reclaimed.recordType, 'reclaimed');
    const correlation = {
      deliveryAttemptId: reclaimed.deliveryAttemptId,
      revision: reclaimed.revision,
      payloadDigest: reclaimed.payloadDigest,
      targetPeriodId: reclaimed.targetRef.periodId,
      nativeTurnId: `late-turn-${provider}`,
      nativeItemId: `late-item-${provider}`,
      clientRequestId: reclaimed.deliveryAttemptId,
    };
    const checkpointWrites = harness.persistenceWriteCounts.checkpoint;
    const nativeWrites = totalInstructionWrites(harness, provider);

    await assert.rejects(async () => deliveryAdapter.recordAccepted(attemptId, correlation),
      { code: 'question_quarantined' });
    await assert.rejects(async () => deliveryAdapter.recordApplied(attemptId, correlation),
      { code: 'question_quarantined' });
    assert.deepEqual(await fs.readFile(harness.checkpointPath), checkpointAfterReclamation);
    assert.equal(harness.persistenceWriteCounts.checkpoint, checkpointWrites);
    assert.equal(totalInstructionWrites(harness, provider), nativeWrites);
  });

  test(`${provider} resumes only the persisted operation across each save-boundary return failure`, async (t) => {
    const boundaries = [
      { name: 'question prepare', slot: 'questions', occurrence: 1 },
      { name: 'checkpoint grave', slot: 'checkpoint', occurrence: 1 },
      { name: 'question detail deletion', slot: 'questions', occurrence: 2 },
    ];
    for (const boundary of boundaries) {
      for (const phase of ['before-write', 'after-write']) {
        await t.test(`${boundary.name} ${phase}`, async (subtest) => {
          const sources = threeSlotLegacySources(provider);
          const { directory, harness, setNow } = await createHarness(subtest, provider, { sources });
          const beforeCheckpoint = await fs.readFile(harness.checkpointPath);
          const anchor = await readJson(path.join(directory, ANCHOR_FILE));
          const retired = anchor.retiredQuestionPeriods.find((item) => item.periodId === sources.question.periodId);
          setNow(retired.retiredAt + RETENTION_MS);
          harness.faults.arm({ slot: boundary.slot, phase, occurrence: boundary.occurrence });

          await assert.rejects(harness.reclamationService.reclaimQuestionBodies({
            identity: sources.question.identity,
            periodId: sources.question.periodId,
          }), /fixture/);
          assert.equal(harness.faults.isArmed(), false);
          const failedJournal = await readJson(harness.questionJournalPath);
          const failedReservation = failedJournal.reservations.find((item) => item.internalQuestionId === 'internal-1');
          const persistedOperationId = failedReservation.reclamation?.operationId ?? null;
          if (boundary.name === 'question prepare' && phase === 'before-write') {
            assert.equal(persistedOperationId, null);
            assert.ok(failedJournal.questions.some((item) => item.internalQuestionId === 'internal-1'));
          } else {
            assert.equal(typeof persistedOperationId, 'string');
          }

          await harness.restart();
          const resumedJournal = await readJson(harness.questionJournalPath);
          const resumedReservation = resumedJournal.reservations.find((item) => item.internalQuestionId === 'internal-1');
          if (persistedOperationId === null) {
            assert.equal(resumedReservation.bodyState, 'retained');
            const resumed = await harness.reclamationService.reclaimQuestionBodies({
              identity: sources.question.identity,
              periodId: sources.question.periodId,
            });
            assert.equal(resumed.status, 'complete');
          } else {
            assert.equal(resumedReservation.reclamation.operationId, persistedOperationId);
            assert.equal(resumedReservation.bodyState, 'reclaimed');
          }
          const completedJournal = await readJson(harness.questionJournalPath);
          const completedReservation = completedJournal.reservations.find((item) => item.internalQuestionId === 'internal-1');
          assert.equal(completedReservation.bodyState, 'reclaimed');
          if (persistedOperationId !== null) {
            assert.equal(completedReservation.reclamation.operationId, persistedOperationId);
          }
          const completedCheckpoint = await readJson(harness.checkpointPath);
          assert.equal(completedCheckpoint.ledger.deliveries.length, 2);
          assert.deepEqual(completedCheckpoint.ledger.deliveries.map((item) => item.deliveryAttemptId).sort(),
            JSON.parse(beforeCheckpoint.toString('utf8')).ledger.deliveries.map((item) => item.deliveryAttemptId).sort());
          assert.equal(completedCheckpoint.ledger.deliveries.find((item) => item.deliveryAttemptId ===
            sources.question.deliveryIntent.deliveryAttemptId).recordType, 'reclaimed');
          assert.equal(totalInstructionWrites(harness, provider), 0);
        });
      }
    }
  });

  test(`${provider} keeps dashboard recovery clear while a prepared grave waits for its clock`, async (t) => {
    const sources = threeSlotLegacySources(provider);
    const { directory, harness, setNow } = await createHarness(t, provider, { sources });
    const anchor = await readJson(path.join(directory, ANCHOR_FILE));
    const retired = anchor.retiredQuestionPeriods.find((item) => item.periodId === sources.question.periodId);
    setNow(retired.retiredAt + RETENTION_MS);
    harness.faults.arm({ slot: 'questions', phase: 'before-write', occurrence: 2 });
    await assert.rejects(harness.reclamationService.reclaimQuestionBodies({
      identity: sources.question.identity,
      periodId: sources.question.periodId,
    }), /fixture/);

    const interrupted = await readJson(harness.questionJournalPath);
    const prepared = interrupted.reservations.find((item) => item.internalQuestionId === sources.question.internalQuestionId)
      .reclamation;
    assert.ok(prepared);
    assert.equal(interrupted.reservations[0].bodyState, 'retained');
    const checkpoint = await readJson(harness.checkpointPath);
    assert.equal(checkpoint.ledger.deliveries.find((item) =>
      item.deliveryAttemptId === sources.question.deliveryIntent.deliveryAttemptId).recordType, 'reclaimed');

    setNow(prepared.preparedAt - 1);
    const bytesBeforeRestart = await readSlotBytes(directory);
    const writesBeforeRestart = { ...harness.persistenceWritesBySlot };
    await harness.restart();
    assert.deepEqual(await readSlotBytes(directory), bytesBeforeRestart);
    assert.deepEqual(harness.persistenceWritesBySlot, writesBeforeRestart);

    const dashboard = await harness.questionService.dashboardSnapshot();
    assert.equal(dashboard.recovery, null);
    const displayed = dashboard.questions.find((item) =>
      item.internalQuestionId === sources.question.internalQuestionId);
    assert.ok(displayed);
    assert.equal(displayed.quarantined, true);
    assert.equal((await readJson(harness.questionJournalPath)).reservations[0].reclamation.operationId,
      prepared.operationId);

    setNow(prepared.preparedAt);
    const completed = await harness.reclamationService.reclaimQuestionBodies({
      identity: sources.question.identity,
      periodId: sources.question.periodId,
    });
    assert.equal(completed.status, 'complete');
    const finalQuestionJournal = await readJson(harness.questionJournalPath);
    assert.equal(finalQuestionJournal.questions.length, 0);
    assert.equal(finalQuestionJournal.reservations[0].reclamation.operationId, prepared.operationId);
  });

  test(`${provider} rejects both impossible question-detail and checkpoint-grave pairs without writes`, async (t) => {
    for (const mismatch of ['reclaimed-question-with-detail', 'retained-question-with-grave']) {
      await t.test(mismatch, async (subtest) => {
        const sources = threeSlotLegacySources(provider);
        const { directory, harness, setNow, getNow } = await createHarness(subtest, provider, { sources });
        const questionDetailBytes = await fs.readFile(harness.questionJournalPath);
        const checkpointDetailBytes = await fs.readFile(harness.checkpointPath);
        const anchor = await readJson(path.join(directory, ANCHOR_FILE));
        const retired = anchor.retiredQuestionPeriods.find((item) => item.periodId === sources.question.periodId);
        setNow(retired.retiredAt + RETENTION_MS);
        const result = await harness.reclamationService.reclaimQuestionBodies({
          identity: sources.question.identity,
          periodId: sources.question.periodId,
        });
        assert.equal(result.status, 'complete');
        await harness.close();
        const tamperedPath = mismatch === 'reclaimed-question-with-detail'
          ? path.join(directory, DATA_FILES.checkpoint)
          : path.join(directory, DATA_FILES.questions);
        const originalDetailBytes = mismatch === 'reclaimed-question-with-detail'
          ? checkpointDetailBytes : questionDetailBytes;
        await fs.writeFile(tamperedPath, originalDetailBytes);
        const bytesBeforeInvalidStartup = {
          ...await readSlotBytes(directory),
          anchor: await fs.readFile(path.join(directory, ANCHOR_FILE)),
        };

        const restarted = createNativeQuestionBodyReclamationHarness({
          directory,
          now: () => getNow(),
          reclamation: reclamationConfig({
            normalByteLimitsBySlot: Object.fromEntries(Object.keys(DATA_FILES).map((slot) => [slot, sources[slot].length])),
          }),
        });
        await assert.rejects(restarted.ready);
        assert.deepEqual({
          ...await readSlotBytes(directory),
          anchor: await fs.readFile(path.join(directory, ANCHOR_FILE)),
        }, bytesBeforeInvalidStartup);
        assert.deepEqual(restarted.persistenceWritesBySlot, { checkpoint: 0, instructions: 0, questions: 0 });
        assert.deepEqual(restarted.persistenceWriteCounts, { anchor: 0, checkpoint: 0, instructions: 0, questions: 0 });
        await restarted.close();
      });
    }
  });

  test(`${provider} rejects a locally valid new-format checkpoint with mismatched question correlation before startup writes`, async (t) => {
    const sources = threeSlotLegacySources(provider);
    const { directory, harness } = await createHarness(t, provider, { sources });
    const checkpoint = await readJson(harness.checkpointPath);
    const attemptId = sources.question.deliveryIntent.deliveryAttemptId;
    const questionDelivery = checkpoint.ledger.deliveries.find((item) => item.deliveryAttemptId === attemptId);
    assert.equal(questionDelivery.kind, 'question');
    assert.equal(questionDelivery.recordType, 'detail');
    const originalDigest = questionDelivery.payloadDigest;
    const mismatchedDigest = '0'.repeat(64) === originalDigest ? '1'.repeat(64) : '0'.repeat(64);
    questionDelivery.payloadDigest = mismatchedDigest;
    for (const correlationName of ['acceptedCorrelation', 'appliedCorrelation']) {
      if (questionDelivery[correlationName] !== null) {
        questionDelivery[correlationName].payloadDigest = mismatchedDigest;
      }
    }
    const tombstone = checkpoint.ledger.logicalTombstones.find((item) =>
      item.kind === questionDelivery.kind && item.sourceExecutionId === questionDelivery.sourceExecutionId &&
      item.logicalMessageId === questionDelivery.logicalMessageId && item.revision === questionDelivery.revision);
    assert.ok(tombstone);
    tombstone.payloadDigest = mismatchedDigest;
    const locallyEncoded = encodeCheckpointV3Local(checkpoint);
    assert.equal(JSON.parse(locallyEncoded.bytes.toString('utf8')).ledger.deliveries
      .find((item) => item.deliveryAttemptId === attemptId).payloadDigest, questionDelivery.payloadDigest);

    await harness.close();
    await fs.writeFile(path.join(directory, DATA_FILES.checkpoint), locallyEncoded.bytes);
    const bytesBeforeStartup = {
      ...await readSlotBytes(directory),
      anchor: await fs.readFile(path.join(directory, ANCHOR_FILE)),
    };
    const restarted = createNativeQuestionBodyReclamationHarness({
      directory,
      now: () => 1_000_000,
      reclamation: reclamationConfig({
        normalByteLimitsBySlot: Object.fromEntries(Object.keys(DATA_FILES).map((slot) =>
          [slot, sources[slot].length])),
      }),
    });
    t.after(async () => { try { await restarted.close(); } catch {} });

    await assert.rejects(restarted.ready, (error) => {
      assert.equal(error.message, 'invalid_reclamation_snapshot');
      return true;
    });
    assert.deepEqual({
      ...await readSlotBytes(directory),
      anchor: await fs.readFile(path.join(directory, ANCHOR_FILE)),
    }, bytesBeforeStartup);
    assert.deepEqual(restarted.persistenceWritesBySlot, { checkpoint: 0, instructions: 0, questions: 0 });
    assert.deepEqual(restarted.persistenceWriteCounts, { anchor: 0, checkpoint: 0, instructions: 0, questions: 0 });
    assert.equal(restarted.processesByProvider.get(provider).length, 0);
  });

  test(`${provider} rejects unknown question-body fields and captures identity before queued work`, async (t) => {
    const { harness, setNow } = await createHarness(t, provider);
    const { writer } = await startWriter(harness, provider, 'body-request-capture');
    const question = await registerQuestion(harness, writer, `capture-${provider}`);
    const identity = writer.identity;
    const periodId = writer.executionId;
    await harness.reclamationService.retireQuestionPeriod({ identity, periodId });
    const anchor = await readJson(path.join(harness.directory, ANCHOR_FILE));
    const retiredAt = anchor.retiredQuestionPeriods.find((item) => item.periodId === periodId).retiredAt;
    setNow(retiredAt + RETENTION_MS);

    assert.throws(() => harness.reclamationService.reclaimQuestionBodies({ identity, periodId, reason: 'extra' }),
      { code: 'invalid_question_body_reclamation' });
    let getterCalls = 0;
    const getterInput = { periodId };
    Object.defineProperty(getterInput, 'identity', {
      enumerable: true,
      get() { getterCalls += 1; throw new Error('identity getter ran'); },
    });
    assert.throws(() => harness.reclamationService.reclaimQuestionBodies(getterInput),
      { code: 'invalid_question_body_reclamation' });
    assert.equal(getterCalls, 0);

    const mutableRequest = { identity: { ...identity }, periodId };
    const barrier = harness.faults.holdNextWrite('questions');
    const reclamation = harness.reclamationService.reclaimQuestionBodies(mutableRequest);
    await barrier.entered;
    mutableRequest.identity.nativeId = 'mutated-after-queue';
    barrier.release();
    const result = await reclamation;
    assert.equal(result.status, 'complete');
    const questionJournal = await readJson(harness.questionJournalPath);
    assert.equal(questionJournal.questions.some((item) => item.internalQuestionId === question.internalQuestionId), false);
    const reservation = questionJournal.reservations.find((item) => item.internalQuestionId === question.internalQuestionId);
    assert.equal(reservation.identity.nativeId, identity.nativeId);
    assert.equal(reservation.bodyState, 'reclaimed');
  });

  test(`${provider} rejects an unawaited question persistence after callback access expires`, async (t) => {
    const { harness, setNow } = await createHarness(t, provider);
    const { writer } = await startWriter(harness, provider, 'expired-body-access');
    const question = await registerQuestion(harness, writer, `expired-${provider}`);
    await harness.reclamationService.retireQuestionPeriod({
      identity: writer.identity,
      periodId: writer.executionId,
    });
    const anchor = await readJson(path.join(harness.directory, ANCHOR_FILE));
    const retiredAt = anchor.retiredQuestionPeriods.find((item) => item.periodId === writer.executionId).retiredAt;
    const now = retiredAt + RETENTION_MS;
    setNow(now);
    const contextSnapshot = harness.reclamationContext.snapshot();
    const normalByteLimitsBySlot = {
      checkpoint: 16 * 1024 * 1024,
      instructions: 16 * 1024 * 1024,
      questions: 16 * 1024 * 1024,
    };
    const planInput = {
      anchor: contextSnapshot.anchor,
      stores: contextSnapshot.stores,
      normalByteLimitsBySlot,
      internalQuestionId: question.internalQuestionId,
      now,
    };
    const planned = planQuestionBodyReclamation({
      ...planInput,
      operationId: crypto.randomUUID(),
    });
    assert.equal(planned.status, 'planned');
    const candidate = planned.steps[0].snapshot.stores.questions;
    const beforeQuestionBytes = await fs.readFile(harness.questionJournalPath);

    const instructionBarrier = harness.faults.holdNextWrite('instructions');
    const instructionSnapshot = contextSnapshot.stores.instructions;
    const blockingWrite = harness.reclamationContext.backend('instructions').save({
      ...structuredClone(instructionSnapshot),
      revision: instructionSnapshot.revision + 1,
    });
    await instructionBarrier.entered;

    let latePersist;
    await harness.questionService.withRetiredQuestionBodies({
      identity: writer.identity,
      periodId: writer.executionId,
    }, (access) => {
      latePersist = access.persist(question.internalQuestionId, candidate).then(
        () => ({ error: null }),
        (error) => ({ error }),
      );
    });
    instructionBarrier.release();
    await blockingWrite;
    const outcome = await latePersist;
    assert.equal(outcome.error?.code, 'question_retirement_access_expired');
    assert.deepEqual(await fs.readFile(harness.questionJournalPath), beforeQuestionBytes);
  });

  test(`${provider} preserves an instruction creating while body reclamation waits on checkpoint persistence`, async (t) => {
    const sources = threeSlotLegacySources(provider);
    const normalByteLimitsBySlot = Object.fromEntries(Object.keys(DATA_FILES).map((slot) =>
      [slot, sources[slot].length + 1024 * 1024]));
    const { harness, setNow } = await createHarness(t, provider, { sources, normalByteLimitsBySlot });
    const anchor = await readJson(path.join(harness.directory, ANCHOR_FILE));
    const retired = anchor.retiredQuestionPeriods.find((item) => item.periodId === sources.question.periodId);
    const { started } = await startWriter(harness, provider, 'instruction-interleaving');
    const instructionId = `interleaved-instruction-${provider}`;
    const checkpointBarrier = harness.faults.holdNextWrite('checkpoint');
    const instructionCreation = harness.instructionService.create({
      deliveryAttemptId: instructionId,
      launchRef: started.result.launchRef,
      logicalMessageId: `logical-${instructionId}`,
      revision: 0,
      text: 'instruction created while an unrelated question body is reclaimed',
      mode: 'start',
      expectedTurnId: null,
    });
    await checkpointBarrier.entered;
    const creatingBeforeRelease = await readJson(path.join(harness.directory, DATA_FILES.instructions));
    assert.equal(creatingBeforeRelease.instructions.find((item) => item.deliveryAttemptId === instructionId)
      .deliveryCreationState, 'creating');

    setNow(retired.retiredAt + RETENTION_MS);
    const bodyReclamation = harness.reclamationService.reclaimQuestionBodies({
      identity: sources.question.identity,
      periodId: sources.question.periodId,
    });
    await new Promise((resolve) => setImmediate(resolve));
    checkpointBarrier.release();
    const [created, reclaimed] = await Promise.all([instructionCreation, bodyReclamation]);
    assert.equal(created.outcome, 'created');
    assert.equal(reclaimed.status, 'complete');

    const instructionJournal = await readJson(path.join(harness.directory, DATA_FILES.instructions));
    assert.equal(instructionJournal.instructions.find((item) => item.deliveryAttemptId === instructionId)
      .deliveryCreationState, 'checkpointed');
    const checkpoint = await readJson(path.join(harness.directory, DATA_FILES.checkpoint));
    assert.equal(checkpoint.ledger.deliveries.find((item) => item.deliveryAttemptId === instructionId).kind, 'instruction');
    assert.equal(checkpoint.ledger.deliveries.find((item) => item.deliveryAttemptId ===
      sources.question.deliveryIntent.deliveryAttemptId).recordType, 'reclaimed');
    assert.equal(totalInstructionWrites(harness, provider), 0);
  });

  test(`${provider} stops prepared reclamation after close during startup persistence`, async (t) => {
    const sources = threeSlotLegacySources(provider);
    const { directory, harness, setNow } = await createHarness(t, provider, { sources });
    const anchor = await readJson(path.join(directory, ANCHOR_FILE));
    const retired = anchor.retiredQuestionPeriods.find((item) => item.periodId === sources.question.periodId);
    const dueAt = retired.retiredAt + RETENTION_MS;
    setNow(dueAt);
    harness.faults.arm({ slot: 'questions', phase: 'after-write', occurrence: 1 });
    await assert.rejects(harness.reclamationService.reclaimQuestionBodies({
      identity: sources.question.identity,
      periodId: sources.question.periodId,
    }), /fixture/);
    const prepared = (await readJson(harness.questionJournalPath)).reservations[0].reclamation;
    assert.ok(prepared);

    const checkpointBarrier = harness.faults.holdNextWrite('checkpoint');
    const restarting = harness.restart();
    await checkpointBarrier.entered;
    const startupContext = harness.reclamationContext;
    assert.equal(startupContext.status().state, 'starting');
    const closing = startupContext.close();
    checkpointBarrier.release();
    await assert.rejects(restarting, /closed|reclamation/);
    await closing;

    const afterClosedStartup = await readJson(harness.questionJournalPath);
    const afterClosedCheckpoint = await readJson(harness.checkpointPath);
    assert.equal(afterClosedStartup.questions.length, 1);
    assert.equal(afterClosedStartup.reservations[0].bodyState, 'retained');
    assert.equal(afterClosedStartup.reservations[0].reclamation.operationId, prepared.operationId);
    assert.equal(afterClosedCheckpoint.ledger.deliveries.find((item) =>
      item.deliveryAttemptId === sources.question.deliveryIntent.deliveryAttemptId).recordType, 'reclaimed');

    await harness.restart();
    assert.equal(harness.reclamationContext.status().state, 'ready');
    const completed = await readJson(harness.questionJournalPath);
    assert.equal(completed.questions.length, 0);
    assert.equal(completed.reservations[0].bodyState, 'reclaimed');
    assert.equal(completed.reservations[0].reclamation.operationId, prepared.operationId);
    assert.equal(totalInstructionWrites(harness, provider), 0);
  });

  test(`${provider} refuses a new prepare when the same context observes a newer clock high-water`, async (t) => {
    const { harness, getNow, setNow } = await createHarness(t, provider);
    const first = await startWriter(harness, provider, 'clock-high-water-source');
    const firstQuestion = await registerQuestion(harness, first.writer, `clock-first-${provider}`);
    const firstPeriod = first.writer.executionId;
    const firstIdentity = first.writer.identity;
    await harness.reclamationService.retireQuestionPeriod({ identity: firstIdentity, periodId: firstPeriod });
    const firstRetiredAt = (await readJson(path.join(harness.directory, ANCHOR_FILE))).retiredQuestionPeriods
      .find((item) => item.periodId === firstPeriod).retiredAt;
    const firstDeadline = firstRetiredAt + RETENTION_MS;

    const futureObservedAt = firstDeadline + 100;
    setNow(futureObservedAt);
    const second = await startWriter(harness, provider, 'clock-high-water-observer');
    await registerQuestion(harness, second.writer, `clock-second-${provider}`);
    await harness.reclamationService.retireQuestionPeriod({
      identity: second.writer.identity,
      periodId: second.writer.executionId,
    });
    assert.equal(getNow(), futureObservedAt);
    const secondPeriodReclamation = await harness.reclamationService.reclaimQuestionBodies({
      identity: second.writer.identity,
      periodId: second.writer.executionId,
    });
    assert.equal(secondPeriodReclamation.status, 'deferred');

    setNow(firstDeadline + 50);
    const before = await fs.readFile(harness.questionJournalPath);
    const result = await harness.reclamationService.reclaimQuestionBodies({
      identity: firstIdentity,
      periodId: firstPeriod,
    });
    assert.equal(result.status, 'deferred');
    assert.deepEqual(await fs.readFile(harness.questionJournalPath), before);
    const journal = await readJson(harness.questionJournalPath);
    const reservation = journal.reservations.find((item) => item.internalQuestionId === firstQuestion.internalQuestionId);
    assert.equal(reservation.bodyState, 'retained');
    assert.equal(reservation.reclamation, null);
  });

  test(`${provider} defers on deadline overflow and clock rollback without deleting a body`, async (t) => {
    const overflowAt = MAX_SAFE_INTEGER - RETENTION_MS + 1;
    const overflow = await createHarness(t, provider, { initialNow: overflowAt });
    const { writer: overflowWriter } = await startWriter(overflow.harness, provider, 'retention-overflow');
    const overflowQuestion = await registerQuestion(overflow.harness, overflowWriter, `overflow-${provider}`);
    const overflowIdentity = overflowWriter.identity;
    const overflowPeriodId = overflowWriter.executionId;
    const overflowRetirement = await overflow.harness.reclamationService.retireQuestionPeriod({
      identity: overflowIdentity,
      periodId: overflowPeriodId,
    });
    assert.equal(overflowRetirement.status, 'retired');
    const overflowAnchor = await readJson(path.join(overflow.directory, ANCHOR_FILE));
    const overflowPeriod = overflowAnchor.retiredQuestionPeriods.find((item) => item.periodId === overflowPeriodId);
    overflow.setNow(MAX_SAFE_INTEGER);
    const overflowBefore = await readSlotBytes(overflow.directory);
    const overflowResult = await overflow.harness.reclamationService.reclaimQuestionBodies({
      identity: overflowIdentity,
      periodId: overflowPeriodId,
    });
    assert.equal(overflowResult.status, 'deferred');
    assert.deepEqual(await readSlotBytes(overflow.directory), overflowBefore);
    assert.equal(overflowPeriod.retiredAt, overflowAt);

    const rollbackSources = threeSlotLegacySources(provider);
    const rollback = await createHarness(t, provider, { sources: rollbackSources });
    const rollbackAnchor = await readJson(path.join(rollback.directory, ANCHOR_FILE));
    const rollbackPeriod = rollbackAnchor.retiredQuestionPeriods.find((item) => item.periodId === rollbackSources.question.periodId);
    rollback.setNow(rollbackPeriod.retiredAt + RETENTION_MS);
    rollback.harness.faults.arm({ slot: 'questions', phase: 'after-write', occurrence: 1 });
    await assert.rejects(rollback.harness.reclamationService.reclaimQuestionBodies({
      identity: rollbackSources.question.identity,
      periodId: rollbackSources.question.periodId,
    }), /fixture/);
    const preparedJournal = await readJson(rollback.harness.questionJournalPath);
    const prepared = preparedJournal.reservations[0].reclamation;
    assert.ok(prepared);
    rollback.setNow(prepared.preparedAt - 1);
    const beforeRollbackRestart = await readSlotBytes(rollback.directory);
    await rollback.harness.restart();
    assert.deepEqual(await readSlotBytes(rollback.directory), beforeRollbackRestart);
    const deferred = await rollback.harness.reclamationService.reclaimQuestionBodies({
      identity: rollbackSources.question.identity,
      periodId: rollbackSources.question.periodId,
    });
    assert.equal(deferred.status, 'deferred');
    assert.equal((await readJson(rollback.harness.questionJournalPath)).questions.length, 1);
  });

  test(`${provider} close during prepared persistence does not continue to checkpoint grave or delete the body`, async (t) => {
    const sources = threeSlotLegacySources(provider);
    const { directory, harness, setNow } = await createHarness(t, provider, { sources });
    const anchor = await readJson(path.join(directory, ANCHOR_FILE));
    const retired = anchor.retiredQuestionPeriods.find((item) => item.periodId === sources.question.periodId);
    setNow(retired.retiredAt + RETENTION_MS);
    const attemptsBefore = { ...harness.persistenceWritesBySlot };
    const barrier = harness.faults.holdNextWrite('questions');
    const reclamationPromise = harness.reclamationService.reclaimQuestionBodies({
      identity: sources.question.identity,
      periodId: sources.question.periodId,
    });
    await barrier.entered;
    const closePromise = harness.close();
    barrier.release();
    await assert.rejects(reclamationPromise);
    await closePromise;

    const questionJournal = await readJson(path.join(directory, DATA_FILES.questions));
    const checkpoint = await readJson(path.join(directory, DATA_FILES.checkpoint));
    assert.equal(questionJournal.questions.length, 1);
    assert.ok(questionJournal.reservations[0].reclamation);
    assert.equal(checkpoint.ledger.deliveries.find((item) => item.kind === 'question').recordType, 'detail');
    assert.equal(harness.persistenceWritesBySlot.questions - attemptsBefore.questions, 1);
    assert.equal(harness.persistenceWritesBySlot.checkpoint - attemptsBefore.checkpoint, 0);
    assert.equal(totalInstructionWrites(harness, provider), 0);
  });
}
