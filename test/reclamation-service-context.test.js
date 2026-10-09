'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createQuestionRecord, selectionFor } = require('../src/server/common-question-kernel');
const {
  encodeQuestionJournalV2Local,
  normalizeQuestionJournalV2Local,
} = require('../src/server/common-question-reclamation-codec');
const {
  encodeCheckpointV3Local,
  encodeInstructionJournalV2Local,
  normalizeCheckpointV3Local,
} = require('../src/server/delivery-reclamation-codec');
const {
  createEmptyCheckpointV3TargetLocal,
  createEmptyInstructionJournalV2TargetLocal,
  createEmptyQuestionJournalV2TargetLocal,
  projectLegacyQuestionJournalV1Local,
} = require('../src/server/reclamation-migration-projection');
const { createReclamationCapacityBudget } = require('../src/server/reclamation-capacity-reservation');
const {
  FIXED_H_BOUNDS,
  NORMAL_ANCHOR_MAX_BYTES,
  computePhysicalReclamationBounds,
} = require('../src/server/reclamation-capacity-bounds');
const { createReclamationPersistence } = require('../src/server/reclamation-persistence');
const { createReclamationServiceContext } = require('../src/server/reclamation-service-context');
const { createReclamationServiceHarness, PROVIDERS } = require('./helpers/reclamation-service-harness');
const {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
} = require('../src/server/question-reclamation-anchor-codec');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const NORMAL_LIMIT = 1_000_000;
const SLOTS = Object.freeze(['checkpoint', 'instructions', 'questions']);
const IDENTITY = Object.freeze({
  provider: 'claude', nativeIdKind: 'session', hostId: 'host-1', homeScopeId: 'home-1', nativeId: 'native-1',
});
const LIVE_RETIRE_AT = 1_250_000;

function emptyAnchor(overrides = {}) {
  return normalizeQuestionReclamationAnchorV1Local({
    schemaVersion: 1,
    revision: 0,
    storeId: STORE_ID,
    retiredQuestionPeriods: [],
    migration: null,
    ...overrides,
  });
}

function emptyStores() {
  return {
    questions: createEmptyQuestionJournalV2TargetLocal({ storeId: STORE_ID }).snapshot,
    checkpoint: createEmptyCheckpointV3TargetLocal({ storeId: STORE_ID }).snapshot,
    instructions: createEmptyInstructionJournalV2TargetLocal({ storeId: STORE_ID }).snapshot,
  };
}

function checkpointWithRegisteredLaunch({ grant = false, addAlias = false } = {}) {
  const checkpoint = structuredClone(createEmptyCheckpointV3TargetLocal({ storeId: STORE_ID }).snapshot);
  const claims = {
    launchId: 'launch-id',
    runId: 'launch-run',
    attemptId: 'launch-attempt',
    provider: IDENTITY.provider,
    nativeIdKind: IDENTITY.nativeIdKind,
    hostId: IDENTITY.hostId,
    homeScopeId: IDENTITY.homeScopeId,
    origin: 'standalone',
    purpose: 'agent',
    originBinding: null,
  };
  const executionBinding = { periodId: 'period-1', actor: { kind: 'agent', id: 'actor-1' } };
  const launch = {
    launchRef: 'launch-ref-1',
    claims,
    identity: IDENTITY,
    executionBinding,
    conversationId: 'conversation-1',
    sessionId: IDENTITY.nativeId,
    state: 'bound',
  };
  checkpoint.registrations.conversations.push({ conversationId: launch.conversationId, identity: IDENTITY });
  checkpoint.registrations.executions.push({
    conversationId: launch.conversationId,
    executionId: executionBinding.periodId,
    sessionId: launch.sessionId,
    state: 'active',
  });
  checkpoint.registrations.replayClaims.push({
    startIdDigest: 'c'.repeat(64),
    evidenceIdDigest: 'd'.repeat(64),
    fingerprintDigest: 'e'.repeat(64),
    conversationId: launch.conversationId,
    executionId: executionBinding.periodId,
    order: 1,
  });
  checkpoint.registrations.launches.push(launch);
  if (addAlias) {
    checkpoint.ledger.notificationTargets.push({
      targetId: 'new-notification-target',
      launch: {
        launchRef: launch.launchRef,
        claims,
        identity: IDENTITY,
        executionBinding,
        conversationId: launch.conversationId,
        sessionId: launch.sessionId,
      },
    });
  }
  if (grant) {
    checkpoint.migrationAllowance = {
      operationId: OPERATION_ID,
      sourceSchemaVersion: 2,
      sourceSizeBytes: 500,
      sourceSha256: 'b'.repeat(64),
      maxExtraBytes: FIXED_H_BOUNDS.checkpoint,
      eligibleAttemptIds: [],
    };
  }
  return normalizeCheckpointV3Local(checkpoint);
}

function activeQuestionStore() {
  const question = legacyQuestionRecord();
  const checkpoint = createEmptyCheckpointV3TargetLocal({ storeId: STORE_ID }).snapshot;
  const projected = projectLegacyQuestionJournalV1Local({
    sourceBytes: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 0, questions: [question] })),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: 20_000,
    checkpointSnapshot: checkpoint,
    migrationAllowance: null,
  }).snapshot;
  return normalizeQuestionJournalV2Local({
    schemaVersion: 2,
    storeId: projected.storeId,
    revision: projected.revision,
    questions: projected.questions.map((detail) => ({
      ...detail,
      deliveryCreationState: 'not_created',
      quarantinedAt: null,
    })),
    reservations: projected.reservations.map((reservation) => ({ ...reservation, quarantinedAt: null })),
    migrationAllowance: null,
  });
}

function legacyQuestionRecord() {
  return createQuestionRecord({
    internalQuestionId: 'internal-1',
    questionId: 'public-1',
    identity: IDENTITY,
    periodId: 'period-1',
    executionId: 'period-1',
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

function creatingQuestionStore() {
  const question = legacyQuestionRecord();
  const selected = selectionFor(question, [{
    questionId: question.questions[0].id,
    optionIds: ['option-1'],
    freeText: null,
  }], 'manual', question.createdAt + 1, 'repair-intent').record;
  const checkpoint = createEmptyCheckpointV3TargetLocal({ storeId: STORE_ID }).snapshot;
  const projected = projectLegacyQuestionJournalV1Local({
    sourceBytes: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 1, questions: [selected] })),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: 20_000,
    checkpointSnapshot: checkpoint,
    migrationAllowance: null,
  }).snapshot;
  return normalizeQuestionJournalV2Local({
    schemaVersion: 2,
    storeId: projected.storeId,
    revision: projected.revision,
    questions: projected.questions.map((detail) => ({
      ...detail,
      deliveryCreationState: 'creating',
      quarantinedAt: null,
    })),
    reservations: projected.reservations.map((reservation) => ({
      ...reservation,
      deliveryCreationState: 'creating',
      checkpointState: null,
      sourceClaimsDigest: null,
      sessionId: null,
      terminalResultKind: null,
      quarantinedAt: null,
    })),
    migrationAllowance: null,
  });
}

function pickPresentFields(record, fields) {
  return Object.fromEntries(fields.filter((field) => Object.hasOwn(record, field))
    .map((field) => [field, structuredClone(record[field])]));
}

function staticQuestionCorrelation(snapshot) {
  return {
    questions: snapshot.questions.map((record) => pickPresentFields(record, [
      'internalQuestionId', 'questionId', 'identity', 'periodId', 'executionId', 'conversationId',
      'launchRef', 'executionBinding', 'contentDigest', 'category', 'questions', 'createdAt', 'deliveryIntent',
    ])),
    reservations: snapshot.reservations.map((record) => pickPresentFields(record, [
      'internalQuestionId', 'questionId', 'identity', 'periodId', 'executionId', 'conversationId',
      'launchRef', 'executionBinding', 'contentDigest', 'createdAt', 'selection', 'selectedAt',
      'deliveryIntent', 'sourceClaimsDigest', 'sessionId',
    ])),
  };
}

function staticDeliveryCorrelation(delivery) {
  return pickPresentFields(delivery, [
    'deliveryAttemptId', 'kind', 'logicalMessageId', 'revision', 'payloadDigest', 'source', 'target',
    'sourceExecutionId', 'recordType', 'reclamation',
  ]);
}

async function prepareLiveQuestionDelivery(harness, questionId, accepted) {
  const registered = await harness.questionService.register(harness.resumed.child.writer, {
    questionId,
    category: 'ordinary',
    timeoutMinutes: 1,
    questions: [{
      id: 'decision', text: 'Choose one', mode: 'single',
      options: [{ id: 'continue', label: 'Continue', description: '' }],
      allowFreeText: false, recommendedOptionId: null,
    }],
  });
  await harness.questionService.submitAnswer(registered.question.internalQuestionId, {
    answers: [{ questionId: 'decision', optionIds: ['continue'], freeText: null }],
  });
  let sinkCalls = 0;
  const sent = await harness.questionService.answerPoll(harness.resumed.child.writer, questionId, () => {
    sinkCalls += 1;
  });
  const currentQuestion = await harness.questionService.status(harness.resumed.child.writer, questionId);
  const deliveryAttemptId = currentQuestion.deliveryAttemptId;
  assert.ok(deliveryAttemptId);
  const checkpoint = await harness.deliveryStore.snapshot();
  let delivery = checkpoint.deliveries.find((record) => record.deliveryAttemptId === deliveryAttemptId);
  assert.ok(delivery);
  assert.equal(sent.outcome, 'sent');
  assert.equal(delivery.state, 'sending');
  if (accepted) {
    const correlation = {
      deliveryAttemptId: delivery.deliveryAttemptId,
      revision: delivery.revision,
      payloadDigest: delivery.payloadDigest,
      targetPeriodId: delivery.target.periodId,
      nativeTurnId: `callback-turn-${delivery.deliveryAttemptId}`,
      nativeItemId: `item-${delivery.deliveryAttemptId}`,
      clientRequestId: delivery.deliveryAttemptId,
    };
    delivery = await harness.providerDeliveryStore.recordAccepted(deliveryAttemptId, correlation);
    assert.equal(delivery.state, 'accepted');
  }
  return {
    internalQuestionId: registered.question.internalQuestionId,
    deliveryAttemptId,
    sinkCalls: () => sinkCalls,
    questionCorrelation: staticQuestionCorrelation(harness.questionBackend.getSnapshot()),
    deliveryCorrelation: staticDeliveryCorrelation(delivery),
  };
}

function questionStoreWithGrant(sourceSizeBytes = 500) {
  const store = activeQuestionStore();
  return normalizeQuestionJournalV2Local({
    schemaVersion: store.schemaVersion,
    storeId: store.storeId,
    revision: store.revision,
    questions: store.questions,
    reservations: store.reservations,
    migrationAllowance: {
      operationId: OPERATION_ID,
      sourceSchemaVersion: 1,
      sourceSizeBytes,
      sourceSha256: 'a'.repeat(64),
      maxExtraBytes: FIXED_H_BOUNDS.questions,
      eligibleQuestionIds: ['internal-1'],
    },
  });
}

function limits() {
  return { checkpoint: NORMAL_LIMIT, instructions: NORMAL_LIMIT, questions: NORMAL_LIMIT };
}

test('grant rejection during a retirement checkpoint boundary keeps writers ready and retirement finishes', async (t) => {
  const harness = await createReclamationServiceHarness('claude');
  t.after(async () => {
    harness.releaseCheckpointSave();
    await harness.close();
  });
  const question = await prepareLiveQuestionDelivery(harness, 'retirement-grant-race', true);
  harness.setNow(LIVE_RETIRE_AT);
  harness.holdNextCheckpointSave();
  const retirement = harness.context.retireQuestionPeriod({
    identity: harness.resumed.child.identity,
    periodId: harness.resumed.child.registration.executionId,
    questionService: harness.questionService,
    deliveryStore: harness.deliveryStore,
  });
  await harness.checkpointSaveEntered;
  const duringRetirement = harness.context.snapshot();
  assert.ok(duringRetirement.anchor.retiredQuestionPeriods.some((period) =>
    period.periodId === harness.resumed.child.registration.executionId));
  assert.equal(duringRetirement.stores.questions.questions.find((record) =>
    record.internalQuestionId === question.internalQuestionId).quarantinedAt, null);
  const beforeFiles = await Promise.all(['question-reclamation-anchor', ...SLOTS].map((slot) =>
    fs.readFile(path.join(harness.directory, `${slot}.json`))));
  const beforeWrites = structuredClone(harness.saveCounts);
  const beforePersistence = structuredClone(harness.persistenceCounts);
  await assert.rejects(harness.context.releaseMigrationAllowance({
    slot: 'instructions', writer: harness.instructionService,
  }), { code: 'invalid_migration_allowance_release' });
  assert.equal(harness.context.status().state, 'ready');
  assert.equal(harness.context.canWrite(), true);
  assert.deepEqual(harness.saveCounts, beforeWrites);
  assert.deepEqual(harness.persistenceCounts, beforePersistence);
  const afterFiles = await Promise.all(['question-reclamation-anchor', ...SLOTS].map((slot) =>
    fs.readFile(path.join(harness.directory, `${slot}.json`))));
  assert.deepEqual(afterFiles, beforeFiles);
  harness.releaseCheckpointSave();
  assert.equal((await retirement).status, 'retired');
  assert.equal(harness.context.status().state, 'ready');
  assert.deepEqual(await harness.context.releaseMigrationAllowance({
    slot: 'instructions', writer: harness.instructionService,
  }), { status: 'already_clear', slot: 'instructions' });
});

for (const resizeOutcome of ['success', 'retained', 'unknown']) {
  test(`grant clear installs saved state before lease resize and handles ${resizeOutcome} reservation`, async (t) => {
    const stores = emptyStores();
    stores.checkpoint = checkpointWithRegisteredLaunch({ grant: true });
    const budget = createReclamationCapacityBudget({ maxAdditionalBytes: 4_000_000_000 });
    const observed = [];
    let armed = false;
    let leaseUnknown = false;
    let sandbox;
    const capacityBudget = {
      status: () => budget.status(),
      acquire(bytes) {
        const held = budget.acquire(bytes);
        return Object.freeze({
          status() {
            if (leaseUnknown) throw new Error('unknown lease');
            return held.status();
          },
          release: () => held.release(),
          resize(nextBytes) {
            if (!armed) return held.resize(nextBytes);
            observed.push({ phase: 'resize', bytes: held.status().bytes,
              grant: sandbox.context.snapshot().stores.checkpoint.migrationAllowance });
            if (resizeOutcome === 'retained') throw new Error('resize refused');
            if (resizeOutcome === 'unknown') { leaseUnknown = true; throw new Error('lease state lost'); }
            return held.resize(nextBytes);
          },
        });
      },
    };
    const atomicWriteBytes = async (filePath, bytes) => {
      if (armed) observed.push({ phase: 'write', bytes: budget.status().reservedBytes,
        grant: sandbox.context.snapshot().stores.checkpoint.migrationAllowance });
      await fs.writeFile(filePath, bytes);
    };
    sandbox = await makeSandbox(t, stores, emptyAnchor(), atomicWriteBytes, {}, limits(), capacityBudget);
    await sandbox.context.start(sandbox.writersBySlot);
    const oldBytes = budget.status().reservedBytes;
    let cache = sandbox.context.backend('checkpoint').getSnapshot();
    const writer = { async withMigrationAllowance(callback) {
      return callback({ snapshot: () => structuredClone(cache), async persist(candidate) {
        const saved = await sandbox.context.backend('checkpoint').save(candidate);
        cache = saved;
        return saved;
      } });
    } };
    armed = true;
    const release = sandbox.context.releaseMigrationAllowance({ slot: 'checkpoint', writer });
    if (resizeOutcome === 'unknown') {
      await assert.rejects(release, (error) => error.code === 'reclamation_capacity_reservation_unknown');
      assert.equal(sandbox.context.status().state, 'blocked');
      assert.throws(() => sandbox.context.backend('checkpoint').getSnapshot(),
        (error) => error.code === 'reclamation_service_blocked');
      assert.notEqual(cache.migrationAllowance, null);
    } else {
      assert.deepEqual(await release, { status: 'released', slot: 'checkpoint' });
      assert.equal(cache.migrationAllowance, null);
      assert.equal(sandbox.context.status().state, 'ready');
      assert.equal(budget.status().reservedBytes, resizeOutcome === 'retained' ? oldBytes
        : oldBytes - stores.checkpoint.migrationAllowance.maxExtraBytes);
      assert.deepEqual(await sandbox.context.releaseMigrationAllowance({ slot: 'checkpoint', writer }),
        { status: 'already_clear', slot: 'checkpoint' });
    }
    assert.equal(observed.length, 2);
    assert.equal(observed[0].phase, 'write');
    assert.equal(observed[0].bytes, oldBytes);
    assert.notEqual(observed[0].grant, null);
    assert.equal(observed[1].phase, 'resize');
    assert.equal(observed[1].bytes, oldBytes);
    assert.equal(observed[1].grant, null);
    const persisted = JSON.parse(await fs.readFile(sandbox.slotPathsBySlot.checkpoint, 'utf8'));
    assert.equal(persisted.migrationAllowance, null);
    assert.equal(persisted.ledger.revision, stores.checkpoint.ledger.revision);
  });
}

function encodeStores(stores) {
  return {
    checkpoint: encodeCheckpointV3Local(stores.checkpoint).bytes,
    instructions: encodeInstructionJournalV2Local(stores.instructions).bytes,
    questions: encodeQuestionJournalV2Local(stores.questions).bytes,
  };
}

async function makeSandbox(t, stores = emptyStores(), anchor = emptyAnchor(), atomicWriteBytes = undefined,
  rawSlotOverrides = {}, normalByteLimitsBySlot = limits(), capacityBudget = undefined, modules = undefined) {
  const createPersistence = modules?.persistence.createReclamationPersistence ?? createReclamationPersistence;
  const createContext = modules?.context.createReclamationServiceContext ?? createReclamationServiceContext;
  const tempRoot = await fs.realpath(os.tmpdir());
  const directory = await fs.mkdtemp(path.join(tempRoot, 'reclamation-context-'));
  const slotPathsBySlot = Object.fromEntries(SLOTS.map((slot) => [slot, path.join(directory, `${slot}.json`)]));
  const anchorPath = path.join(directory, 'question-reclamation-anchor.json');
  const seed = createPersistence({ anchorPath, slotPathsBySlot });
  await seed.writeAnchorBytes(encodeQuestionReclamationAnchorV1Local(anchor).bytes, 16_777_216);
  const encodedStores = encodeStores(stores);
  for (const slot of SLOTS) {
    await seed.writeSlotBytes(slot, rawSlotOverrides[slot] ?? encodedStores[slot], 16_777_216);
  }
  await seed.close();
  const persistence = createPersistence({
    anchorPath,
    slotPathsBySlot,
    ...(atomicWriteBytes ? { atomicWriteBytes } : {}),
  });
  const budget = capacityBudget ?? createReclamationCapacityBudget({ maxAdditionalBytes: 4_000_000_000 });
  const context = createContext({
    persistence,
    capacityBudget: budget,
    normalByteLimitsBySlot,
    now: () => 30_000,
  });
  const writersBySlot = Object.fromEntries(SLOTS.map((slot) => [slot, {
    stop() {},
    drain() {},
    prepareResume(snapshot) { return context.backend(slot).prepareResume(snapshot); },
  }]));
  t.after(async () => {
    await context.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { context, persistence, capacityBudget: budget, writersBySlot, directory, anchorPath, slotPathsBySlot };
}

for (const phase of ['before', 'after']) {
  test(`qualified question rename ${phase} failure freezes question reads but keeps nonquestion writers and lease`, async (t) => {
    const { loadQuestionWriteIsolationModules } = require('./support/question-write-isolation-loader');
    const modules = loadQuestionWriteIsolationModules();
    const sandbox = await makeSandbox(t, emptyStores(), emptyAnchor(), undefined, {}, limits(), undefined, modules);
    await sandbox.context.start(sandbox.writersBySlot);
    const initial = sandbox.context.snapshot();
    const beforeBytes = await fs.readFile(sandbox.slotPathsBySlot.questions);
    const oldReservation = sandbox.capacityBudget.status().reservedBytes;
    const qBackend = sandbox.context.backend('questions');
    const candidate = { ...qBackend.getSnapshot(), revision: 1 };
    modules.nativeFileSystem.armRenameRetryExhaustion({ targetPath: sandbox.slotPathsBySlot.questions, phase });
    let questionError;
    await assert.rejects(qBackend.save(candidate), (error) => {
      questionError = error;
      return error.code === 'EPERM';
    });
    assert.equal(sandbox.context.status().state, 'degraded');
    assert.deepEqual(sandbox.context.status().slotHealth,
      { checkpoint: 'ready', instructions: 'ready', questions: 'uncertain' });
    assert.equal(qBackend.canWrite(), false);
    assert.equal(sandbox.context.backend('instructions').canWrite(), true);
    assert.throws(() => sandbox.context.snapshot(), { code: 'question_journal_uncertain' });
    assert.throws(() => qBackend.getSnapshot(), { code: 'question_journal_uncertain' });
    await assert.rejects(qBackend.load(), { code: 'question_journal_uncertain' });
    await assert.rejects(qBackend.flush(), { code: 'question_journal_uncertain' });
    for (const slot of SLOTS) {
      assert.throws(() => sandbox.context.backend(slot).prepareResume(initial), { code: 'question_journal_uncertain' });
    }
    assert.throws(() => sandbox.context.start(sandbox.writersBySlot), { code: 'question_journal_uncertain' });
    await assert.rejects(sandbox.context.releaseMigrationAllowance({}), { code: 'question_journal_uncertain' });
    await assert.rejects(sandbox.context.retireQuestionPeriod({}), { code: 'question_journal_uncertain' });
    const afterFault = await fs.readFile(sandbox.slotPathsBySlot.questions);
    if (phase === 'before') assert.deepEqual(afterFault, beforeBytes);
    else assert.equal(JSON.parse(afterFault).revision, 1);
    const iBackend = sandbox.context.backend('instructions');
    const instruction = iBackend.getSnapshot();
    await iBackend.save({ ...instruction, revision: instruction.revision + 1 });
    const cpBackend = sandbox.context.backend('checkpoint');
    const checkpoint = cpBackend.getSnapshot();
    await cpBackend.save({ ...checkpoint, revision: checkpoint.revision + 1,
      ledger: { ...checkpoint.ledger, revision: checkpoint.ledger.revision + 1 } });
    assert.equal(sandbox.capacityBudget.status().reservedBytes, oldReservation);
    assert.deepEqual(await fs.readFile(sandbox.slotPathsBySlot.questions), afterFault);
    assert.equal(sandbox.context.status().state, 'degraded');
    const nextCheckpoint = cpBackend.getSnapshot();
    modules.nativeFileSystem.armRenameRetryExhaustion({ targetPath: sandbox.slotPathsBySlot.checkpoint,
      error: questionError });
    await assert.rejects(cpBackend.save({ ...nextCheckpoint, revision: nextCheckpoint.revision + 1,
      ledger: { ...nextCheckpoint.ledger, revision: nextCheckpoint.ledger.revision + 1 } }), { code: 'EPERM' });
    assert.equal(sandbox.context.status().state, 'blocked');
    assert.equal(iBackend.canWrite(), false);
    assert.equal(sandbox.capacityBudget.status().reservedBytes, oldReservation);
  });
}

test('queued nonquestion I/O rechecks close after local isolation and shared checkpoint uncertainty', async (t) => {
  const { loadQuestionWriteIsolationModules } = require('./support/question-write-isolation-loader');
  const modules = loadQuestionWriteIsolationModules();
  const sandbox = await makeSandbox(t, emptyStores(), emptyAnchor(), undefined, {}, limits(), undefined, modules);
  await sandbox.context.start(sandbox.writersBySlot);
  const qBackend = sandbox.context.backend('questions');
  const qCandidate = { ...qBackend.getSnapshot(), revision: 1 };
  modules.nativeFileSystem.armRenameRetryExhaustion({ targetPath: sandbox.slotPathsBySlot.questions });
  await assert.rejects(qBackend.save(qCandidate), { code: 'EPERM' });
  const cpBackend = sandbox.context.backend('checkpoint');
  const checkpoint = cpBackend.getSnapshot();
  const barrier = modules.nativeFileSystem.armRenameRetryExhaustion({
    targetPath: sandbox.slotPathsBySlot.checkpoint, hold: true,
  });
  t.after(() => barrier.release());
  const checkpointWrite = cpBackend.save({ ...checkpoint, revision: checkpoint.revision + 1,
    ledger: { ...checkpoint.ledger, revision: checkpoint.ledger.revision + 1 } });
  const checkpointResult = assert.rejects(checkpointWrite, { code: 'EPERM' });
  await barrier.entered;
  const iBackend = sandbox.context.backend('instructions');
  const instruction = iBackend.getSnapshot();
  const beforeInstruction = await fs.readFile(sandbox.slotPathsBySlot.instructions);
  const queued = iBackend.save({ ...instruction, revision: instruction.revision + 1 });
  const queuedResult = assert.rejects(queued, { code: 'reclamation_service_blocked' });
  const closing = sandbox.context.close();
  barrier.release();
  await Promise.all([checkpointResult, queuedResult, closing]);
  assert.deepEqual(await fs.readFile(sandbox.slotPathsBySlot.instructions), beforeInstruction);
  assert.equal(sandbox.context.status().state, 'closed');
  assert.equal(sandbox.capacityBudget.status().reservedBytes, 0);
});

for (const phase of ['before', 'after']) {
  test(`question grant rename ${phase} failure remains global and keeps the pre-write reservation`, async (t) => {
    const { loadQuestionWriteIsolationModules } = require('./support/question-write-isolation-loader');
    const { threeSlotLegacySources, limitsForPostBodyRelease } = require('./support/native-migration-allowance-release-harness');
    const modules = loadQuestionWriteIsolationModules();
    const sources = threeSlotLegacySources('claude');
    const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'question-grant-isolation-'));
    const slotPathsBySlot = Object.fromEntries(SLOTS.map((slot) => [slot, path.join(directory, `${slot}.json`)]));
    await Promise.all(SLOTS.map((slot) => fs.writeFile(slotPathsBySlot[slot], sources[slot])));
    const persistence = modules.persistence.createReclamationPersistence({
      anchorPath: path.join(directory, 'question-reclamation-anchor.json'), slotPathsBySlot,
    });
    const capacityBudget = createReclamationCapacityBudget({ maxAdditionalBytes: 4_000_000_000 });
    let now = 1_000_000;
    const context = modules.context.createReclamationServiceContext({ persistence, capacityBudget,
      normalByteLimitsBySlot: limitsForPostBodyRelease(sources), now: () => now });
    t.after(async () => {
      await context.close().catch(() => {});
      await fs.rm(directory, { recursive: true, force: true });
    });
    const writers = Object.fromEntries(SLOTS.map((slot) => [slot, {
      stop() {}, drain() {}, prepareResume(snapshot) { context.backend(slot).prepareResume(snapshot); },
    }]));
    await context.start(writers);
    const qBackend = context.backend('questions');
    const cpBackend = context.backend('checkpoint');
    now = 1_604_800_001;
    await context.reclaimQuestionBodies({ identity: sources.question.identity, periodId: 'period-1',
      questionService: { async withRetiredQuestionBodies(request, callback) {
        return callback({ snapshot: () => qBackend.getSnapshot(),
          persist: (internalQuestionId, candidate) => qBackend.save(candidate) });
      } },
      deliveryStore: { async withRetiredQuestionCheckpoint(request, callback) {
        return callback({ snapshot: () => cpBackend.getSnapshot(), persist: (candidate) => cpBackend.save(candidate) });
      } },
    });
    let cached = qBackend.getSnapshot();
    assert.notEqual(cached.migrationAllowance, null);
    const oldReservation = capacityBudget.status().reservedBytes;
    const before = await fs.readFile(slotPathsBySlot.questions);
    modules.nativeFileSystem.armRenameRetryExhaustion({ targetPath: slotPathsBySlot.questions, phase });
    await assert.rejects(context.releaseMigrationAllowance({ slot: 'questions', writer: {
      async withMigrationAllowance(callback) {
        return callback({ snapshot: () => structuredClone(cached), async persist(candidate) {
          cached = await qBackend.save(candidate);
          return cached;
        } });
      },
    } }), { code: 'EPERM' });
    assert.equal(context.status().state, 'blocked');
    assert.equal(capacityBudget.status().reservedBytes, oldReservation);
    assert.notEqual(cached.migrationAllowance, null);
    for (const slot of SLOTS) assert.equal(context.backend(slot).canWrite(), false);
    const after = await fs.readFile(slotPathsBySlot.questions);
    if (phase === 'before') assert.deepEqual(after, before);
    else assert.equal(JSON.parse(after).migrationAllowance, null);
  });
}

test('cold loads wait for strict preparation and the gate opens after coordinator resume', async (t) => {
  const sandbox = await makeSandbox(t);
  const backend = sandbox.context.backend('questions');
  const pendingLoad = backend.load();
  assert.throws(() => backend.getStoreId(), { code: 'reclamation_writer_cold' });
  assert.equal(backend.canWrite(), false);
  assert.equal(sandbox.context.canWrite(), false);

  let releaseResume;
  let markResumeStarted;
  const resumeStarted = new Promise((resolve) => { markResumeStarted = resolve; });
  const resumeBlocked = new Promise((resolve) => { releaseResume = resolve; });
  const originalPrepareResume = sandbox.writersBySlot.instructions.prepareResume;
  sandbox.writersBySlot.instructions.prepareResume = (snapshot) => {
    originalPrepareResume(snapshot);
    markResumeStarted();
    return resumeBlocked;
  };
  let loadResolved = false;
  pendingLoad.then(() => { loadResolved = true; });
  const startPromise = sandbox.context.start(sandbox.writersBySlot);
  await resumeStarted;
  await Promise.resolve();
  assert.equal(loadResolved, false);
  assert.equal(backend.canWrite(), false);
  releaseResume();
  const started = await startPromise;
  assert.equal(started.status, 'ready');
  assert.equal(sandbox.context.canWrite(), true);
  assert.equal(backend.canWrite(), true);
  assert.equal(await pendingLoad.then((snapshot) => snapshot.storeId), STORE_ID);
  assert.equal(backend.getStoreId(), STORE_ID);
});

test('cold startup persists question-period quarantine before opening writers', async (t) => {
  const sandbox = await makeSandbox(t, {
    ...emptyStores(),
    questions: activeQuestionStore(),
  });
  const result = await sandbox.context.start(sandbox.writersBySlot);
  assert.equal(result.status, 'ready');
  const snapshot = sandbox.context.snapshot();
  assert.equal(snapshot.anchor.retiredQuestionPeriods.length, 1);
  assert.equal(snapshot.anchor.retiredQuestionPeriods[0].reason, 'startup-quarantine');
  assert.equal(snapshot.anchor.retiredQuestionPeriods[0].retiredAt, 30_000);
  assert.equal(snapshot.stores.questions.questions[0].quarantinedAt, 30_000);
  assert.equal(snapshot.stores.questions.reservations[0].quarantinedAt, 30_000);
  const persistedAnchor = JSON.parse(await fs.readFile(sandbox.anchorPath, 'utf8'));
  const persistedQuestions = JSON.parse(await fs.readFile(sandbox.slotPathsBySlot.questions, 'utf8'));
  assert.deepEqual(persistedAnchor.retiredQuestionPeriods, snapshot.anchor.retiredQuestionPeriods);
  assert.equal(persistedQuestions.questions[0].quarantinedAt, 30_000);
});

test('cold repair completes an already-retired period with an unquarantined stale creation cache', async (t) => {
  const retiredAt = 25_000;
  const anchor = emptyAnchor({
    revision: 1,
    retiredQuestionPeriods: [{ identity: IDENTITY, periodId: 'period-1', retiredAt, reason: 'confirmed-retirement' }],
  });
  const sandbox = await makeSandbox(t, { ...emptyStores(), questions: creatingQuestionStore() }, anchor);
  const beforeQuestions = await fs.readFile(sandbox.slotPathsBySlot.questions);

  const result = await sandbox.context.start(sandbox.writersBySlot);
  assert.equal(result.status, 'ready');
  const snapshot = sandbox.context.snapshot();
  assert.equal(snapshot.anchor.retiredQuestionPeriods[0].retiredAt, retiredAt);
  assert.equal(snapshot.stores.questions.questions[0].quarantinedAt, retiredAt);
  assert.equal(snapshot.stores.questions.questions[0].deliveryCreationState, 'indeterminate');
  assert.equal(snapshot.stores.questions.reservations[0].quarantinedAt, retiredAt);
  assert.equal(snapshot.stores.questions.reservations[0].deliveryCreationState, 'indeterminate');
  assert.notDeepEqual(await fs.readFile(sandbox.slotPathsBySlot.questions), beforeQuestions);
});

test('cold repair refuses to revise a cache that was already quarantined in an invalid creation state', async (t) => {
  const retiredAt = 25_000;
  const anchor = emptyAnchor({
    revision: 1,
    retiredQuestionPeriods: [{ identity: IDENTITY, periodId: 'period-1', retiredAt, reason: 'confirmed-retirement' }],
  });
  const stale = creatingQuestionStore();
  const questions = normalizeQuestionJournalV2Local({
    ...stale,
    questions: stale.questions.map((record) => ({ ...record, quarantinedAt: retiredAt })),
    reservations: stale.reservations.map((record) => ({ ...record, quarantinedAt: retiredAt })),
  });
  const sandbox = await makeSandbox(t, { ...emptyStores(), questions }, anchor);
  const beforeQuestions = await fs.readFile(sandbox.slotPathsBySlot.questions);

  await assert.rejects(sandbox.context.start(sandbox.writersBySlot));
  assert.deepEqual(await fs.readFile(sandbox.slotPathsBySlot.questions), beforeQuestions);
  assert.equal(sandbox.context.canWrite(), false);
});

test('cold repair refuses a raw slot that exceeds its immutable byte limit', async (t) => {
  const stores = emptyStores();
  const encoded = encodeQuestionJournalV2Local(stores.questions).bytes;
  const oversized = Buffer.concat([encoded, Buffer.alloc(NORMAL_LIMIT, 0x20)]);
  const sandbox = await makeSandbox(t, stores, emptyAnchor(), undefined, { questions: oversized });
  await assert.rejects(sandbox.context.start(sandbox.writersBySlot),
    (error) => error && error.code === 'reclamation_capacity_exceeded');
  assert.deepEqual(await fs.readFile(sandbox.slotPathsBySlot.questions), oversized);
  assert.equal(sandbox.context.canWrite(), false);
});

test('question admission reserves every active period in the immutable anchor budget', async (t) => {
  const retiredQuestionPeriods = Array.from({ length: 20_000 }, (_, index) => ({
    identity: IDENTITY,
    periodId: `retired-${index}`,
    retiredAt: index,
    reason: 'confirmed-retirement',
  }));
  const anchor = emptyAnchor({ revision: retiredQuestionPeriods.length, retiredQuestionPeriods });
  const sandbox = await makeSandbox(t, emptyStores(), anchor);
  await sandbox.context.start(sandbox.writersBySlot);

  const error = await sandbox.context.backend('questions').save(activeQuestionStore()).then(
    () => null,
    (failure) => failure,
  );
  assert.equal(error?.code, 'reclamation_capacity_exceeded');
  assert.equal(sandbox.context.snapshot().stores.questions.reservations.length, 0);
});

test('a new checkpoint notification alias uses the normal slot limit despite a migration grant', async (t) => {
  const checkpoint = checkpointWithRegisteredLaunch({ grant: true });
  const checkpointBytes = encodeCheckpointV3Local(checkpoint).bytes;
  const limitsBySlot = { ...limits(), checkpoint: Math.max(500, checkpointBytes.length) };
  const stores = { ...emptyStores(), checkpoint };
  const sandbox = await makeSandbox(t, stores, emptyAnchor(), undefined, {}, limitsBySlot);
  await sandbox.context.start(sandbox.writersBySlot);

  const candidate = structuredClone(checkpoint);
  candidate.revision += 1;
  candidate.ledger.revision += 1;
  candidate.ledger.notificationTargets.push({
    targetId: 'new-notification-target',
    launch: {
      launchRef: 'launch-ref-1',
      claims: checkpoint.registrations.launches[0].claims,
      identity: IDENTITY,
      executionBinding: checkpoint.registrations.launches[0].executionBinding,
      conversationId: 'conversation-1',
      sessionId: IDENTITY.nativeId,
    },
  });

  await assert.rejects(sandbox.context.backend('checkpoint').save(candidate),
    { code: 'reclamation_capacity_exceeded' });
  assert.equal(sandbox.context.snapshot().stores.checkpoint.ledger.notificationTargets.length, 0);
});

test('close rejects loads that are waiting for cold preparation', async (t) => {
  const sandbox = await makeSandbox(t);
  const pendingLoad = sandbox.context.backend('questions').load();

  await sandbox.context.close();
  await assert.rejects(pendingLoad, { code: 'reclamation_service_context_closed' });
  assert.equal(sandbox.context.status().closed, true);
});

test('close observes asynchronous writer stop failures and still drains before releasing persistence', async (t) => {
  const sandbox = await makeSandbox(t);
  let stopCalls = 0;
  let drainCalls = 0;
  const writers = Object.fromEntries(SLOTS.map((slot) => [slot, {
    stop() {
      stopCalls += 1;
      return Promise.reject(new Error('injected stop failure'));
    },
    drain() {
      drainCalls += 1;
      return Promise.resolve();
    },
    prepareResume(snapshot) { return sandbox.context.backend(slot).prepareResume(snapshot); },
  }]));

  await assert.rejects(sandbox.context.start(writers), { code: 'reclamation_writer_stop_or_drain_failed' });
  await assert.rejects(sandbox.context.close());
  assert.ok(stopCalls >= SLOTS.length);
  assert.ok(drainCalls >= SLOTS.length);
  assert.equal(sandbox.context.status().closed, true);
});

test('close releases the cold-repair lease when repair fails before coordinator startup', async (t) => {
  const atomicWriteBytes = async () => {
    const error = new Error('injected anchor write failure');
    error.code = 'ENOSPC';
    throw error;
  };
  const budget = createReclamationCapacityBudget({ maxAdditionalBytes: 4_000_000_000 });
  const sandbox = await makeSandbox(t, {
    ...emptyStores(),
    questions: activeQuestionStore(),
  }, emptyAnchor(), atomicWriteBytes, {}, limits(), budget);

  await assert.rejects(sandbox.context.start(sandbox.writersBySlot), { code: 'ENOSPC' });
  assert.equal(budget.status().activeLeaseCount, 1);
  await sandbox.context.close();
  assert.equal(budget.status().activeLeaseCount, 0);
});

test('cold repair accepts source bytes above the normal limit when a fixed grant covers them', async (t) => {
  const normalByteLimits = { checkpoint: NORMAL_LIMIT, instructions: NORMAL_LIMIT, questions: 1_000 };
  const stores = { ...emptyStores(), questions: questionStoreWithGrant() };
  const encodedQuestion = encodeQuestionJournalV2Local(stores.questions).bytes;
  const rawQuestion = Buffer.concat([encodedQuestion, Buffer.alloc(1_500, 0x20)]);
  assert.ok(rawQuestion.length > normalByteLimits.questions);
  assert.ok(rawQuestion.length <= normalByteLimits.questions + FIXED_H_BOUNDS.questions);
  const budgetState = createReclamationCapacityBudget({ maxAdditionalBytes: 4_000_000_000 });
  let firstAcquireBytes = null;
  const budget = {
    acquire(bytes) {
      if (firstAcquireBytes === null) firstAcquireBytes = bytes;
      return budgetState.acquire(bytes);
    },
    status() { return budgetState.status(); },
  };
  const rawBytesBySlot = {
    checkpoint: encodeCheckpointV3Local(stores.checkpoint).bytes,
    instructions: encodeInstructionJournalV2Local(stores.instructions).bytes,
    questions: rawQuestion,
  };
  const sandbox = await makeSandbox(t, stores, emptyAnchor(), undefined, rawBytesBySlot,
    normalByteLimits, budget);
  const reservationFor = (useGrantSourceSize) => computePhysicalReclamationBounds({
    anchorByteLimit: NORMAL_ANCHOR_MAX_BYTES,
    slots: SLOTS.map((slot) => ({
      slot,
      sourceSizeBytes: slot === 'questions' && useGrantSourceSize
        ? stores.questions.migrationAllowance.sourceSizeBytes
        : rawBytesBySlot[slot].length,
      normalByteLimit: normalByteLimits[slot],
      grantBytes: stores[slot].migrationAllowance?.maxExtraBytes ?? 0,
    })),
  }).postMigrationReservationBytes;
  const expected = reservationFor(true);

  await sandbox.context.start(sandbox.writersBySlot);
  assert.equal(firstAcquireBytes, expected);
});

test('live retirement persists the anchor first and blocks the retired period', async (t) => {
  const order = [];
  const atomicWriteBytes = async (targetPath, bytes, fileSystem) => {
    order.push(path.basename(targetPath));
    const temporary = `${targetPath}.context-test-temp`;
    await fileSystem.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fileSystem.rename(temporary, targetPath);
  };
  const sandbox = await makeSandbox(t, emptyStores(), emptyAnchor(), atomicWriteBytes);
  await sandbox.context.start(sandbox.writersBySlot);
  order.length = 0;
  const gate = sandbox.context.periodGate;
  const questionService = {
    reclamationWriter: sandbox.writersBySlot.questions,
    async withRetirementSnapshot(ticket, callback) {
      gate.assertRetirement(ticket);
      return callback({
        snapshot: () => sandbox.context.backend('questions').getSnapshot(),
        persist: (candidate) => sandbox.context.backend('questions').save(candidate),
      });
    },
  };
  const deliveryStore = {
    reclamationWriter: sandbox.writersBySlot.checkpoint,
    async withQuestionRetirement(ticket, callback) {
      gate.assertRetirement(ticket);
      return callback({
        snapshot: () => sandbox.context.snapshot().stores.checkpoint,
        persist: (candidate) => sandbox.context.backend('checkpoint').save(candidate),
      });
    },
  };
  const result = await sandbox.context.retireQuestionPeriod({
    identity: IDENTITY,
    periodId: 'new-period',
    questionService,
    deliveryStore,
  });
  assert.equal(result.status, 'retired');
  assert.deepEqual(order, ['question-reclamation-anchor.json']);
  assert.equal(result.snapshot.anchor.retiredQuestionPeriods[0].periodId, 'new-period');
  assert.throws(() => gate.capture(IDENTITY, 'new-period'), { code: 'question_quarantined' });
});

test('a queued question write rechecks its token immediately before persistence', async (t) => {
  let releaseBlocker;
  let markBlockerStarted;
  const blockerStarted = new Promise((resolve) => { markBlockerStarted = resolve; });
  const blocker = new Promise((resolve) => { releaseBlocker = resolve; });
  const writes = [];
  let blockCheckpoint = true;
  const atomicWriteBytes = async (targetPath, bytes, fileSystem) => {
    writes.push(path.basename(targetPath));
    if (blockCheckpoint && path.basename(targetPath) === 'checkpoint.json') {
      blockCheckpoint = false;
      markBlockerStarted();
      await blocker;
    }
    const temporary = `${targetPath}.token-test-temp`;
    await fileSystem.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fileSystem.rename(temporary, targetPath);
  };
  const sandbox = await makeSandbox(t, emptyStores(), emptyAnchor(), atomicWriteBytes);
  await sandbox.context.start(sandbox.writersBySlot);
  writes.length = 0;
  const checkpointBackend = sandbox.context.backend('checkpoint');
  const questionBackend = sandbox.context.backend('questions');
  const checkpointCandidate = structuredClone(checkpointBackend.getSnapshot());
  checkpointCandidate.revision += 1;
  checkpointCandidate.ledger.revision += 1;
  const qBefore = await fs.readFile(sandbox.slotPathsBySlot.questions);
  const checkpointSave = checkpointBackend.save(checkpointCandidate);
  await blockerStarted;

  const token = sandbox.context.periodGate.capture(IDENTITY, 'pending-period');
  const questionCandidate = structuredClone(questionBackend.getSnapshot());
  questionCandidate.revision += 1;
  const questionSave = questionBackend.save(questionCandidate, () =>
    sandbox.context.periodGate.assertCurrent(token));
  const questionService = {
    async withRetirementSnapshot(ticket, callback) {
      return callback({
        snapshot: () => questionBackend.getSnapshot(),
        persist: (candidate) => questionBackend.save(candidate),
      });
    },
  };
  const deliveryStore = {
    async withQuestionRetirement(ticket, callback) {
      return callback({
        snapshot: () => checkpointBackend.getSnapshot(),
        persist: (candidate) => checkpointBackend.save(candidate),
      });
    },
  };
  const retirement = sandbox.context.retireQuestionPeriod({
    identity: IDENTITY,
    periodId: 'pending-period',
    questionService,
    deliveryStore,
  });

  releaseBlocker();
  await checkpointSave;
  await assert.rejects(questionSave, { code: 'question_quarantined' });
  const result = await retirement;

  assert.equal(result.status, 'retired');
  assert.deepEqual(writes, ['checkpoint.json', 'question-reclamation-anchor.json']);
  assert.deepEqual(await fs.readFile(sandbox.slotPathsBySlot.questions), qBefore);
  assert.equal(sandbox.context.canWrite(), true);
});

test('write guards must be synchronous and rejected guard promises are observed', async (t) => {
  const writes = [];
  const atomicWriteBytes = async (targetPath, bytes, fileSystem) => {
    writes.push(path.basename(targetPath));
    const temporary = `${targetPath}.guard-test-temp`;
    await fileSystem.writeFile(temporary, bytes, { flag: 'wx', mode: 0o600 });
    await fileSystem.rename(temporary, targetPath);
  };
  const sandbox = await makeSandbox(t, emptyStores(), emptyAnchor(), atomicWriteBytes);
  await sandbox.context.start(sandbox.writersBySlot);
  const backend = sandbox.context.backend('checkpoint');
  const candidate = structuredClone(backend.getSnapshot());
  candidate.revision += 1;
  candidate.ledger.revision += 1;

  await assert.rejects(backend.save(candidate, async () => {
    throw new Error('late guard failure');
  }), { code: 'invalid_reclamation_write_guard' });
  assert.deepEqual(writes, []);
  assert.equal(backend.canWrite(), true);
});

test('backend writes require the same store id and exactly one store revision step', async (t) => {
  const sandbox = await makeSandbox(t);
  await sandbox.context.start(sandbox.writersBySlot);
  const backend = sandbox.context.backend('checkpoint');
  const skippedRevision = structuredClone(backend.getSnapshot());
  skippedRevision.revision += 2;
  skippedRevision.ledger.revision += 1;
  await assert.rejects(backend.save(skippedRevision), { code: 'reclamation_store_transition_rejected' });

  const changedStoreId = structuredClone(backend.getSnapshot());
  changedStoreId.storeId = '33333333-3333-4333-8333-333333333333';
  changedStoreId.revision += 1;
  await assert.rejects(backend.save(changedStoreId), { code: 'reclamation_store_transition_rejected' });
  assert.equal(backend.canWrite(), true);
});

for (const provider of PROVIDERS) {
  for (const slot of ['anchor', 'checkpoint', 'questions']) {
    for (const phase of ['before-write', 'after-write', 'readback']) {
      test(`actual ${provider} retirement ${slot} ${phase} failure blocks writers and cold-repairs without resending`, async (t) => {
        const harness = await createReclamationServiceHarness(provider, {
          initialNow: 1_000_000,
          preserveDirectory: true,
        });
        const directory = harness.directory;
        let restartedHarness = null;
        t.after(async () => {
          if (restartedHarness) await restartedHarness.close().catch(() => {});
          else await harness.close().catch(() => {});
          await fs.rm(directory, { recursive: true, force: true });
        });

        const questionId = `fault-${slot}-${phase}`;
        const attempt = await prepareLiveQuestionDelivery(harness, questionId, slot === 'checkpoint');
        const periodId = harness.resumed.child.registration.executionId;
        const identity = harness.resumed.child.identity;
        harness.setNow(LIVE_RETIRE_AT);
        const candidates = Object.fromEntries(SLOTS.map((candidateSlot) => [
          candidateSlot,
          structuredClone(harness.context.backend(candidateSlot).getSnapshot()),
        ]));
        harness.armPersistenceFault({ slot, phase });

        await assert.rejects(harness.context.retireQuestionPeriod({
          identity,
          periodId,
          questionService: harness.questionService,
          deliveryStore: harness.deliveryStore,
        }));
        assert.equal(harness.context.canWrite(), false);
        for (const candidateSlot of SLOTS) {
          assert.equal(harness.context.backend(candidateSlot).canWrite(), false);
        }
        await Promise.allSettled([
          harness.deliveryStore.reclamationWriter.drain(),
          harness.instructionService.reclamationWriter.drain(),
          harness.questionService.reclamationWriter.drain(),
        ]);
        const writesAfterFailure = structuredClone(harness.persistenceCounts);
        for (const candidateSlot of SLOTS) {
          await assert.rejects(harness.context.backend(candidateSlot).save(candidates[candidateSlot]));
        }
        assert.deepEqual(harness.persistenceCounts, writesAfterFailure);

        const restartNow = LIVE_RETIRE_AT + 10_000;
        restartedHarness = await harness.restart({ initialNow: restartNow });
        assert.equal(harness.context.status().capacity.activeLeaseCount, 0);
        assert.deepEqual(harness.persistenceCounts, writesAfterFailure);

        assert.equal(restartedHarness.context.canWrite(), true);
        const snapshot = restartedHarness.context.snapshot();
        const retired = snapshot.anchor.retiredQuestionPeriods.find((record) =>
          record.periodId === periodId && JSON.stringify(record.identity) === JSON.stringify(identity));
        assert.ok(retired);
        const markerWasPersisted = slot !== 'anchor' || phase !== 'before-write';
        assert.equal(retired.reason, markerWasPersisted ? 'confirmed-retirement' : 'startup-quarantine');
        assert.equal(retired.retiredAt, markerWasPersisted ? LIVE_RETIRE_AT : restartNow);

        const restartedQuestion = snapshot.stores.questions.questions.find((record) =>
          record.internalQuestionId === attempt.internalQuestionId);
        const restartedReservation = snapshot.stores.questions.reservations.find((record) =>
          record.internalQuestionId === attempt.internalQuestionId);
        assert.ok(restartedQuestion);
        assert.ok(restartedReservation);
        assert.equal(restartedQuestion.quarantinedAt, retired.retiredAt);
        assert.equal(restartedReservation.quarantinedAt, retired.retiredAt);
        assert.deepEqual(staticQuestionCorrelation(snapshot.stores.questions), attempt.questionCorrelation);

        const restartedCheckpoint = await restartedHarness.deliveryStore.snapshot();
        const restartedDelivery = restartedCheckpoint.deliveries.find((record) =>
          record.deliveryAttemptId === attempt.deliveryAttemptId);
        assert.ok(restartedDelivery);
        assert.equal(restartedDelivery.state, 'unknown');
        assert.deepEqual(staticDeliveryCorrelation(restartedDelivery), attempt.deliveryCorrelation);
        assert.equal(snapshot.stores.questions.questions.length, 1);
        assert.equal(snapshot.stores.questions.reservations.length, 1);
        assert.equal(attempt.sinkCalls(), 1);

        const writesAtRestart = structuredClone(restartedHarness.persistenceCounts);
        let restartSinkCalls = 0;
        await assert.rejects(restartedHarness.questionService.register(restartedHarness.resumed.child.writer, {
          questionId: `${questionId}-again`,
          category: 'ordinary',
          timeoutMinutes: 1,
          questions: [{
            id: 'decision', text: 'Choose one', mode: 'single',
            options: [{ id: 'continue', label: 'Continue', description: '' }],
            allowFreeText: false, recommendedOptionId: null,
          }],
        }), { code: 'question_quarantined' });
        await assert.rejects(restartedHarness.questionService.answerPoll(
          restartedHarness.resumed.child.writer, questionId, () => { restartSinkCalls += 1; }),
        { code: 'question_quarantined' });
        await assert.rejects(Promise.resolve().then(() => restartedHarness.providerDeliveryStore.sendStart(
          attempt.deliveryAttemptId, () => { restartSinkCalls += 1; })),
        { code: 'question_quarantined' });
        assert.equal(restartSinkCalls, 0);
        assert.deepEqual(restartedHarness.persistenceCounts, writesAtRestart);
        assert.equal(restartedHarness.questionBackend.getSnapshot().questions.length, 1);
        assert.equal(restartedHarness.questionBackend.getSnapshot().reservations.length, 1);
      });
    }
  }
}

test('terminal body reclamation captures only data fields and leaves writers available after unknown IDs', async (t) => {
  const sandbox = await makeSandbox(t);
  await sandbox.context.start(sandbox.writersBySlot);
  let getterReads = 0;
  const malformed = { deliveryStore: { withTerminalDeliveryBodyCheckpoint() {} } };
  Object.defineProperty(malformed, 'deliveryAttemptId', { enumerable: true, get() { getterReads += 1; return 'unknown'; } });
  await assert.rejects(sandbox.context.reclaimTerminalDeliveryBody(malformed),
    /invalid_terminal_delivery_body_reclamation/);
  assert.equal(getterReads, 0);
  const before = sandbox.context.snapshot();
  const store = { withTerminalDeliveryBodyCheckpoint(request, callback) {
    assert.deepEqual(request, { deliveryAttemptId: 'unknown' });
    return callback({ snapshot: () => structuredClone(before.stores.checkpoint) });
  } };
  await assert.rejects(sandbox.context.reclaimTerminalDeliveryBody({ deliveryAttemptId: 'unknown', deliveryStore: store }),
    { code: 'delivery_not_found' });
  assert.equal(sandbox.context.status().canWrite, true);
  assert.deepEqual(sandbox.context.snapshot(), before);
});
