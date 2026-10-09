'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { AwayState } = require('../src/server/state');
const { createQuestionRecord, selectionFor } = require('../src/server/common-question-kernel');
const { createDelivery, createEmptyLedger } = require('../src/server/delivery-ledger');
const { makeEmptyCheckpoint } = require('../src/server/durable-checkpoint');
const { createNativeInstructionServiceIntegration } = require('../src/server/native-instruction-service-integration');
const {
  createNativeInstructionIntegrationHarness,
  defaultProfiles,
  PROVIDERS,
} = require('./support/native-instruction-integration-harness');

const DATA_FILES = Object.freeze({
  checkpoint: 'delivery-checkpoint.json',
  instructions: 'instruction-journal.json',
  questions: 'common-question-journal.json',
});
const ANCHOR_FILE = 'question-reclamation-anchor.json';
const SLOT_LIMITS = Object.freeze({ checkpoint: 4 * 1024 * 1024,
  instructions: 2 * 1024 * 1024, questions: 2 * 1024 * 1024 });
const MAX_RECORDS = Object.freeze({ checkpoint: 50_000, instructions: 20_000, questions: 20_000 });

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sha256Bytes(value) {
  return createHash('sha256').update(value).digest('hex');
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
    instructions: Buffer.from(JSON.stringify({
      schemaVersion: 1, revision: 7, instructions: [instruction],
    }), 'utf8'),
    questions: Buffer.from(JSON.stringify({
      schemaVersion: 1, revision: 7, questions: [selected],
    }), 'utf8'),
    question: selected,
  };
}

function questionDependencies({ invalidSubscription = false } = {}) {
  const listeners = new Set();
  const settings = {
    getAutoApplySettings: () => ({ enabled: false, minimumWaitMs: 300_000 }),
    getStatus: () => ({ status: 'ready', revision: 'factory-reclamation-settings', reason: null }),
    subscribe(listener) {
      if (invalidSubscription) return null;
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { away: new AwayState(), settings };
}

function sourceByteLimits(sources, paddingBytes = 0) {
  return Object.fromEntries(Object.entries(DATA_FILES).map(([slot]) =>
    [slot, sources[slot].length + paddingBytes]));
}

function reclamationOptions({ questionMaxRecords = MAX_RECORDS.questions,
  maxAdditionalBytes = 64 * 1024 * 1024, normalByteLimitsBySlot = SLOT_LIMITS } = {}) {
  return {
    maxAdditionalBytes,
    normalByteLimitsBySlot: { ...normalByteLimitsBySlot },
    maxRecordsBySlot: { ...MAX_RECORDS, questions: questionMaxRecords },
  };
}

async function writeLegacySources(directory, sources) {
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(DATA_FILES).map(([slot, basename]) =>
    fs.writeFile(path.join(directory, basename), sources[slot])));
}

function integrationOptions(directory, {
  questionMaxRecords,
  maxAdditionalBytes,
  normalByteLimitsBySlot,
  invalidSubscription = false,
  includeCommonQuestions = true,
} = {}) {
  return {
    directory,
    hostId: 'native-reclamation-factory-host',
    ...(includeCommonQuestions ? { commonQuestions: questionDependencies({ invalidSubscription }) } : {}),
    reclamation: reclamationOptions({ questionMaxRecords, maxAdditionalBytes, normalByteLimitsBySlot }),
  };
}

function directFactoryOptions(directory, sources, overrides = {}) {
  const harnessOptions = integrationOptions(directory, {
    ...overrides,
    normalByteLimitsBySlot: overrides.normalByteLimitsBySlot || sourceByteLimits(sources),
  });
  return {
    profiles: defaultProfiles(directory),
    dataDirectory: directory,
    hostId: harnessOptions.hostId,
    commonQuestions: harnessOptions.commonQuestions,
    reclamation: harnessOptions.reclamation,
  };
}

function encodeJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

async function readAllPersistedBytes(directory) {
  const paths = [...Object.entries(DATA_FILES).map(([slot, basename]) => [slot, path.join(directory, basename)]),
    ['anchor', path.join(directory, ANCHOR_FILE)]];
  return Object.fromEntries(await Promise.all(paths.map(async ([slot, filePath]) =>
    [slot, await fs.readFile(filePath)])));
}

async function createHarness(t, provider, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-instruction-reclamation-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sources = threeSlotLegacySources(provider);
  await writeLegacySources(directory, sources);
  const harness = await createNativeInstructionIntegrationHarness(integrationOptions(directory, {
    ...options,
    normalByteLimitsBySlot: options.normalByteLimitsBySlot || sourceByteLimits(sources, options.bytePadding || 0),
  }));
  t.after(async () => { try { await harness.close(); } catch {} });
  return { directory, harness, sources };
}

function registration(questionId) {
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

function selectedAnswer() {
  return { answers: [{ questionId: 'question-1', optionIds: ['option-1'], freeText: null }] };
}

async function currentWriter(harness, provider, suffix) {
  const started = await harness.start(provider, { launchSuffix: suffix });
  const writer = harness.writerFor(started.result.launchRef);
  assert.ok(writer);
  return { started, writer };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

for (const provider of PROVIDERS) {
  test(`${provider} actual factory migrates correlated legacy slots and keeps retired question intake refused`, async (t) => {
    const { directory, harness, sources } = await createHarness(t, provider, {
      questionMaxRecords: 2,
      normalByteLimitsBySlot: sourceByteLimits(threeSlotLegacySources(provider)),
    });
    const migrationAnchorPath = path.join(directory, ANCHOR_FILE);
    const anchor = await readJson(migrationAnchorPath);
    const checkpoint = await readJson(harness.checkpointPath);
    const instructionJournal = await readJson(harness.journalPath);
    const questionJournal = await readJson(harness.commonQuestionJournalPath);
    const migratedBytes = await Promise.all([
      fs.readFile(harness.checkpointPath),
      fs.readFile(harness.journalPath),
      fs.readFile(harness.commonQuestionJournalPath),
    ]);

    assert.equal(anchor.migration, null);
    assert.ok(anchor.retiredQuestionPeriods.some((period) =>
      period.periodId === sources.question.periodId &&
      period.reason === 'startup-quarantine' &&
      period.identity.provider === provider));
    assert.equal(checkpoint.schemaVersion, 3);
    assert.equal(instructionJournal.schemaVersion, 2);
    assert.equal(questionJournal.schemaVersion, 2);
    assert.equal(questionJournal.migrationAllowance.sourceSizeBytes, sources.questions.length);
    assert.equal(questionJournal.migrationAllowance.sourceSha256, sha256Bytes(sources.questions));
    assert.equal(checkpoint.registrations.conversations.length, 1);
    assert.equal(checkpoint.registrations.executions[0].executionId, sources.question.executionBinding.periodId);
    assert.equal(checkpoint.registrations.incompleteConversationIds.includes(sources.question.conversationId), true);
    const question = questionJournal.questions.find((item) => item.internalQuestionId === 'internal-1');
    assert.ok(question);
    assert.equal(question.questionId, sources.question.questionId);
    assert.deepEqual(question.selection.answers, sources.question.selection.answers);
    assert.equal(question.deliveryCreationState, 'checkpointed');
    assert.equal(question.quarantinedAt, anchor.retiredQuestionPeriods[0].retiredAt);
    const questionDelivery = checkpoint.ledger.deliveries.find((item) => item.kind === 'question');
    const instructionDelivery = checkpoint.ledger.deliveries.find((item) => item.kind === 'instruction');
    assert.equal(questionDelivery.deliveryAttemptId, question.deliveryIntent.deliveryAttemptId);
    assert.equal(instructionDelivery.deliveryAttemptId, instructionJournal.instructions[0].deliveryAttemptId);
    assert.deepEqual(instructionJournal.instructions[0].source, instructionDelivery.source);
    assert.equal(instructionJournal.instructions[0].envelopeDigest,
      sha256(instructionJournal.instructions[0].envelope));
    assert.ok(harness.reclamation.status().capacity.activeLeaseCount > 0);

    const { started } = await currentWriter(harness, provider, 'old-question-refusal');
    await assert.rejects(harness.questionService.submitAnswer('internal-1', selectedAnswer()),
      { code: 'question_quarantined' });
    assert.equal(started.process.instructionWrites.length, 0);
    assert.deepEqual(await Promise.all([
      fs.readFile(harness.checkpointPath),
      fs.readFile(harness.journalPath),
      fs.readFile(harness.commonQuestionJournalPath),
    ]), migratedBytes);

    const previousReclamation = harness.reclamation;
    await harness.restartService();
    assert.equal(previousReclamation.status().capacity.activeLeaseCount, 0);
    assert.equal(harness.reclamation.status().canWrite, true);
    await assert.rejects(harness.questionService.submitAnswer('internal-1', selectedAnswer()),
      { code: 'question_quarantined' });
    const currentReclamation = harness.reclamation;
    await harness.close();
    assert.equal(currentReclamation.status().capacity.activeLeaseCount, 0);
  });

  test(`${provider} native integration blocks question intake at the configured migrated record count`, async (t) => {
    const sources = threeSlotLegacySources(provider);
    const { harness } = await createHarness(t, provider, {
      questionMaxRecords: 1,
      normalByteLimitsBySlot: sourceByteLimits(sources),
    });
    const { started, writer } = await currentWriter(harness, provider, 'question-capacity-full');

    await assert.rejects(harness.questionService.register(writer, registration(`blocked-${provider}`)),
      { code: 'question_quarantine_capacity' });
    assert.equal(harness.questionService.getQuarantineDiagnostics().remainingCount, 0);
    assert.equal((await readJson(harness.commonQuestionJournalPath)).questions.length, 1);
    assert.equal((await readJson(harness.checkpointPath)).ledger.deliveries.length, 2);
    assert.equal(started.process.instructionWrites.length, 0);
  });

  test(`${provider} with spare migrated capacity admits a new question after restart`, async (t) => {
    const { harness, sources } = await createHarness(t, provider, {
      questionMaxRecords: 2,
      bytePadding: 1024 * 1024,
    });
    await harness.restartService();
    const { started, writer } = await currentWriter(harness, provider, 'new-question-after-restart');
    const registered = await harness.questionService.register(writer, registration(`new-question-${provider}`));
    assert.equal(registered.outcome, 'created');
    const questionJournal = await readJson(harness.commonQuestionJournalPath);
    assert.equal(questionJournal.questions.length, 2);
    await assert.rejects(harness.questionService.submitAnswer('internal-1', selectedAnswer()),
      { code: 'question_quarantined' });
    const newQuestion = questionJournal.questions.find((question) =>
      question.questionId === `new-question-${provider}`);
    assert.ok(newQuestion);
    const retirement = await harness.reclamation.retireQuestionPeriod({
      identity: newQuestion.identity,
      periodId: newQuestion.periodId,
    });
    assert.equal(retirement.status, 'retired');
    await assert.rejects(harness.questionService.submitAnswer(newQuestion.internalQuestionId, selectedAnswer()),
      { code: 'question_quarantined' });
    const anchor = await readJson(path.join(harness.directory, ANCHOR_FILE));
    assert.ok(anchor.retiredQuestionPeriods.some((period) =>
      period.periodId === newQuestion.periodId && period.reason === 'confirmed-retirement'));
    await assert.rejects(harness.questionService.submitAnswer('internal-1', selectedAnswer()),
      { code: 'question_quarantined' });
    assert.equal(started.process.instructionWrites.length, 0);
    assert.equal(sources.question.questionId, 'public-1');
    const closingReclamation = harness.reclamation;
    await harness.close();
    assert.equal(closingReclamation.status().capacity.activeLeaseCount, 0);
  });

  test(`${provider} a zero-byte migration budget failure releases storage for a same-path retry`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-instruction-reclamation-budget-failure-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const sources = threeSlotLegacySources(provider);
    await writeLegacySources(directory, sources);
    const rawBytes = await Promise.all(Object.entries(DATA_FILES).map(([, basename]) =>
      fs.readFile(path.join(directory, basename))));
    const failedOptions = integrationOptions(directory, {
      maxAdditionalBytes: 0,
      normalByteLimitsBySlot: sourceByteLimits(sources),
    });

    await assert.rejects(createNativeInstructionServiceIntegration({
      profiles: defaultProfiles(directory),
      dataDirectory: directory,
      hostId: failedOptions.hostId,
      commonQuestions: failedOptions.commonQuestions,
      reclamation: failedOptions.reclamation,
    }), { code: 'reclamation_capacity_exceeded' });
    assert.deepEqual(await Promise.all(Object.entries(DATA_FILES).map(([, basename]) =>
      fs.readFile(path.join(directory, basename)))), rawBytes);
    await assert.rejects(fs.access(path.join(directory, ANCHOR_FILE)), { code: 'ENOENT' });

    const retry = await createNativeInstructionIntegrationHarness(integrationOptions(directory, {
      questionMaxRecords: 2,
      normalByteLimitsBySlot: sourceByteLimits(sources),
    }));
    t.after(async () => { try { await retry.close(); } catch {} });
    assert.equal(retry.reclamation.status().canWrite, true);
    assert.ok(retry.reclamation.status().capacity.activeLeaseCount > 0);
    const reclamation = retry.reclamation;
    await retry.close();
    assert.equal(reclamation.status().capacity.activeLeaseCount, 0);
  });

  test(`${provider} a startup failure after migration releases storage for a valid retry`, async (t) => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-instruction-reclamation-start-failure-'));
    t.after(() => fs.rm(directory, { recursive: true, force: true }));
    const sources = threeSlotLegacySources(provider);
    await writeLegacySources(directory, sources);
    const failedOptions = integrationOptions(directory, {
      invalidSubscription: true,
      questionMaxRecords: 2,
      normalByteLimitsBySlot: sourceByteLimits(sources),
    });

    await assert.rejects(createNativeInstructionServiceIntegration({
      profiles: defaultProfiles(directory),
      dataDirectory: directory,
      hostId: failedOptions.hostId,
      commonQuestions: failedOptions.commonQuestions,
      reclamation: failedOptions.reclamation,
    }), { code: 'invalid_common_question_subscription' });
    assert.equal((await readJson(path.join(directory, ANCHOR_FILE))).migration, null);
    assert.equal((await readJson(path.join(directory, DATA_FILES.questions))).schemaVersion, 2);
    assert.equal((await readJson(path.join(directory, DATA_FILES.checkpoint))).schemaVersion, 3);

    const retry = await createNativeInstructionIntegrationHarness(integrationOptions(directory, {
      questionMaxRecords: 2,
      normalByteLimitsBySlot: sourceByteLimits(sources),
    }));
    t.after(async () => { try { await retry.close(); } catch {} });
    assert.equal(retry.reclamation.status().canWrite, true);
    assert.ok(retry.reclamation.status().capacity.activeLeaseCount > 0);
    const reclamation = retry.reclamation;
    await retry.close();
    assert.equal(reclamation.status().capacity.activeLeaseCount, 0);
  });

  test(`${provider} rejects malformed legacy correlations before migration writes`, async (t) => {
    const tamperCases = [
      {
        name: 'question identity',
        slot: 'questions',
        message: 'invalid_reclamation_migration_projection',
        mutate(source) { source.questions[0].identity.nativeId = 'other-native-id'; },
      },
      {
        name: 'delivery source claims',
        slot: 'checkpoint',
        message: 'invalid_delivery_record_v2',
        mutate(source) {
          source.ledger.deliveries.find((delivery) => delivery.kind === 'question')
            .source.claims.attemptId = 'different-attempt';
        },
      },
      {
        name: 'delivery intent digest',
        slot: 'questions',
        message: 'invalid_question_detail_v2',
        mutate(source) { source.questions[0].deliveryIntent.payloadDigest = '0'.repeat(64); },
      },
    ];

    for (const tamperCase of tamperCases) {
      await t.test(tamperCase.name, async (subtest) => {
        const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-instruction-reclamation-legacy-tamper-'));
        subtest.after(() => fs.rm(directory, { recursive: true, force: true }));
        const sources = threeSlotLegacySources(provider);
        const altered = JSON.parse(sources[tamperCase.slot].toString('utf8'));
        tamperCase.mutate(altered);
        const tamperedSources = { ...sources, [tamperCase.slot]: encodeJson(altered) };
        await writeLegacySources(directory, tamperedSources);
        const bytesBeforeStartup = Object.fromEntries(await Promise.all(Object.entries(DATA_FILES).map(
          async ([slot, basename]) => [slot, await fs.readFile(path.join(directory, basename))])));

        await assert.rejects(createNativeInstructionIntegrationHarness(integrationOptions(directory, {
          questionMaxRecords: 2,
          normalByteLimitsBySlot: sourceByteLimits(tamperedSources),
        })), { message: tamperCase.message });
        const bytesAfterFailure = Object.fromEntries(await Promise.all(Object.entries(DATA_FILES).map(
          async ([slot, basename]) => [slot, await fs.readFile(path.join(directory, basename))])));
        assert.deepEqual(bytesAfterFailure, bytesBeforeStartup);
        await assert.rejects(fs.access(path.join(directory, ANCHOR_FILE)), { code: 'ENOENT' });

        await writeLegacySources(directory, sources);
        const retry = await createNativeInstructionIntegrationHarness(integrationOptions(directory, {
          questionMaxRecords: 2,
          normalByteLimitsBySlot: sourceByteLimits(sources),
        }));
        subtest.after(async () => { try { await retry.close(); } catch {} });
        assert.equal(retry.reclamation.status().canWrite, true);
        await retry.close();
        assert.equal((await readJson(path.join(directory, ANCHOR_FILE))).migration, null);
      });
    }
  });

  test(`${provider} rejects corrupted migrated reservation correlations without fallback writes`, async (t) => {
    const sources = threeSlotLegacySources(provider);
    const { directory, harness } = await createHarness(t, provider, {
      questionMaxRecords: 2,
      normalByteLimitsBySlot: sourceByteLimits(sources),
    });
    await harness.close();
    const validBytes = await readAllPersistedBytes(directory);
    const validJournalBytes = validBytes.questions;
    const tamperCases = [
      {
        name: 'source claims digest',
        mutate(journal) {
          const reservation = journal.reservations.find((item) => item.internalQuestionId === 'internal-1');
          reservation.sourceClaimsDigest = '0'.repeat(64);
        },
      },
      {
        name: 'source session id',
        mutate(journal) {
          const reservation = journal.reservations.find((item) => item.internalQuestionId === 'internal-1');
          reservation.sessionId = 'different-session';
        },
      },
    ];

    for (const tamperCase of tamperCases) {
      await t.test(tamperCase.name, async (subtest) => {
        const altered = JSON.parse(validJournalBytes.toString('utf8'));
        tamperCase.mutate(altered);
        const corruptedQuestionBytes = encodeJson(altered);
        await fs.writeFile(harness.commonQuestionJournalPath, corruptedQuestionBytes);
        const expectedBytes = { ...validBytes, questions: corruptedQuestionBytes };

        await assert.rejects(createNativeInstructionServiceIntegration(
          directFactoryOptions(directory, sources, { questionMaxRecords: 2 })),
        { message: 'invalid_reclamation_snapshot' });
        assert.deepEqual(await readAllPersistedBytes(directory), expectedBytes);

        await fs.writeFile(harness.commonQuestionJournalPath, validJournalBytes);
        const retry = await createNativeInstructionServiceIntegration(
          directFactoryOptions(directory, sources, { questionMaxRecords: 2 }));
        subtest.after(async () => { try { await retry.close(); } catch {} });
        assert.equal(retry.reclamation.status().canWrite, true);
        assert.deepEqual(await readAllPersistedBytes(directory), validBytes);
        await retry.close();
      });
    }
  });
}

test('malformed explicit reclamation options reject without falling back to legacy question storage', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-instruction-reclamation-invalid-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const sources = threeSlotLegacySources('claude');
  await writeLegacySources(directory, sources);
  const commonQuestions = questionDependencies();
  const commonQuestionPath = path.join(directory, DATA_FILES.questions);
  const validReclamation = reclamationOptions({ normalByteLimitsBySlot: sourceByteLimits(sources) });
  const validOptions = {
    profiles: defaultProfiles(directory),
    dataDirectory: directory,
    hostId: 'native-reclamation-factory-host',
    commonQuestions,
    reclamation: validReclamation,
  };
  let getterCalls = 0;
  const accessorReclamation = { normalByteLimitsBySlot: validReclamation.normalByteLimitsBySlot };
  Object.defineProperty(accessorReclamation, 'maxAdditionalBytes', {
    enumerable: true,
    get() { getterCalls += 1; return validReclamation.maxAdditionalBytes; },
  });
  const symbolLimits = { ...validReclamation.normalByteLimitsBySlot };
  Object.defineProperty(symbolLimits, Symbol('extra'), { enumerable: true, value: 1 });
  const optionsWithTopLevelSymbol = { ...validOptions };
  optionsWithTopLevelSymbol[Symbol('extra')] = true;
  const cases = [
    { options: { ...validOptions, reclamation: undefined }, code: 'invalid_reclamation_options' },
    { options: { ...validOptions, reclamation: null }, code: 'invalid_reclamation_options' },
    { options: { ...validOptions, reclamation: accessorReclamation }, code: 'invalid_reclamation_options' },
    { options: { ...validOptions, reclamation: { ...validReclamation,
      normalByteLimitsBySlot: symbolLimits } }, code: 'invalid_reclamation_options' },
    { options: optionsWithTopLevelSymbol, code: 'invalid_native_integration_options' },
    { options: { ...validOptions, reclamation: { ...validReclamation,
      normalByteLimitsBySlot: { checkpoint: 2048, instructions: 2048 } } },
    code: 'invalid_reclamation_options' },
    { options: { ...validOptions, checkpointAtomicWrite: async () => {} }, code: 'reclamation_option_conflict' },
    { options: { ...validOptions, commonQuestions: undefined }, code: 'common_question_service_unavailable' },
  ];

  for (const entry of cases) {
    await assert.rejects(createNativeInstructionServiceIntegration(entry.options), { code: entry.code });
    assert.deepEqual(await fs.readFile(commonQuestionPath), sources.questions);
    await assert.rejects(fs.access(path.join(directory, ANCHOR_FILE)), { code: 'ENOENT' });
  }
  assert.equal(getterCalls, 0);
});
