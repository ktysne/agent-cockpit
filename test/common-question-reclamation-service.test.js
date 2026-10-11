'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const kernel = require('../src/server/common-question-kernel');
const {
  normalizeQuestionDetailV2,
  normalizeQuestionJournalV2Local,
  normalizeQuestionReservation,
} = require('../src/server/common-question-reclamation-codec');
const { createCommonQuestionReclamationJournal } = require('../src/server/common-question-reclamation-adapter');
const { createCommonQuestionService } = require('../src/server/common-question-service');
const { createQuestionPeriodGate } = require('../src/server/question-period-gate');
const { measureQuestionJournalReservationBytes } = require('../src/server/reclamation-capacity-bounds');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const ANCHOR_ID = '22222222-2222-4222-8222-222222222222';
const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const identity = Object.freeze({ provider: 'claude', nativeIdKind: 'session', hostId: 'host-1',
  homeScopeId: 'home-1', nativeId: 'native-1' });

test('the bound uncertain read guard prevents dashboard fallback and cached adapter reads', async (t) => {
  const fixture = makeFixture();
  t.after(() => fixture.service.close());
  await install(fixture);
  await register(fixture, 'uncertain-guard-question');
  const adapter = createCommonQuestionReclamationJournal({
    backend: fixture.backendState.backend, periodGate: fixture.periodGate,
  });
  adapter.prepareResume(fixture.backendState.fullSnapshot);
  const unavailable = Object.assign(new Error('question read uncertain'), { code: 'question_journal_uncertain' });
  fixture.backendState.backend.assertQuestionReadable = () => { throw unavailable; };
  await assert.rejects(fixture.service.dashboardSnapshot(), (error) => error === unavailable);
  for (const read of [() => adapter.load(), () => adapter.getSnapshot(), () => adapter.getLegacySnapshot(),
    () => adapter.getReservation('unknown'), () => adapter.findReservation(identity, 'period-1', 'unknown')]) {
    assert.throws(read, (error) => error === unavailable);
  }
  assert.equal(fixture.service.getQuarantineDiagnostics().status, 'unavailable');
});

test('question read guards must be functions with synchronous void results', async (t) => {
  const fixture = makeFixture();
  t.after(() => fixture.service.close());
  await install(fixture);
  const adapter = createCommonQuestionReclamationJournal({
    backend: fixture.backendState.backend, periodGate: fixture.periodGate,
  });
  adapter.prepareResume(fixture.backendState.fullSnapshot);
  for (const guard of [false, () => true, () => Promise.reject(new Error('read guard rejected'))]) {
    fixture.backendState.backend.assertQuestionReadable = guard;
    assert.throws(() => adapter.getSnapshot(), { code: 'invalid_reclamation_read_guard' });
    await assert.rejects(fixture.service.dashboardSnapshot(), { code: 'invalid_reclamation_read_guard' });
  }
});

test('grant question scope rejects recursive service queues and expires after callback return', async (t) => {
  const fixture = makeFixture();
  t.after(() => fixture.service.close());
  await install(fixture);
  let retained;
  await fixture.service.withMigrationAllowance(async (access) => {
    retained = access;
    assert.equal(access.snapshot().storeId, STORE_ID);
    for (const operation of [() => fixture.service.tick(), () => fixture.service.flush(), () => fixture.service.close(),
      () => fixture.service.withMigrationAllowance(() => {})]) {
      await assert.rejects(operation(), (error) => error.code === 'migration_allowance_access_reentry');
    }
  });
  assert.throws(() => retained.snapshot(), (error) => error.code === 'migration_allowance_access_expired');
  await assert.rejects(retained.persist({}), (error) => error.code === 'migration_allowance_access_expired');
  await fixture.service.flush();
});

for (const failure of ['save', 'readback']) {
  test(`grant question adapter latches its writer after ${failure} failure despite a writable backend`, async (t) => {
    const sourceBytes = Buffer.from(`${JSON.stringify(kernel.createEmptyJournal(), null, 2)}\n`, 'utf8');
    const initial = questionSnapshot({ migrationAllowance: {
      operationId: OPERATION_ID, sourceSchemaVersion: 1, sourceSizeBytes: sourceBytes.length,
      sourceSha256: createHash('sha256').update(sourceBytes).digest('hex'), maxExtraBytes: 1,
      eligibleQuestionIds: [],
    } });
    const fixture = makeFixture(initial);
    t.after(() => fixture.service.close());
    await install(fixture);
    const adapter = createCommonQuestionReclamationJournal({
      backend: fixture.backendState.backend, periodGate: fixture.periodGate,
    });
    adapter.prepareResume(fixture.backendState.fullSnapshot);
    let saves = 0;
    fixture.backendState.backend.save = async (candidate) => {
      saves += 1;
      if (failure === 'save') throw Object.assign(new Error('save failed'), { code: 'injected_save_failure' });
      return { ...candidate, revision: candidate.revision + 1 };
    };
    await assert.rejects(adapter.withMigrationAllowance((access) => access.persist({
      ...access.snapshot(), revision: 1, migrationAllowance: null,
    })), { code: failure === 'save' ? 'injected_save_failure' : 'question_journal_save_mismatch' });
    assert.equal(fixture.backendState.backend.canWrite(), true);
    assert.equal(saves, 1);
    await assert.rejects(adapter.withMigrationAllowance(() => {}), { code: 'question_service_closed' });
    await assert.rejects(adapter.save({}, null), { code: 'question_service_closed' });
    assert.equal(saves, 1);
    await adapter.close();
  });
}

function clone(value) {
  return structuredClone(value);
}

function questionInput(questionId = 'question-1') {
  return { questionId, category: 'ordinary', timeoutMinutes: 1, questions: [{
    id: 'decision', text: 'Choose one', mode: 'single',
    options: [{ id: 'continue', label: 'Continue', description: '' }],
    allowFreeText: false, recommendedOptionId: null,
  }] };
}

function createDetail({ internalQuestionId = 'cq-existing', questionId = 'question-1', periodId = 'period-1',
  createdAt = 1_000 } = {}) {
  const record = kernel.createQuestionRecord({
    internalQuestionId,
    questionId,
    identity,
    periodId,
    executionId: periodId,
    conversationId: 'conversation-1',
    launchRef: 'launch-1',
    executionBinding: { periodId, actor: { kind: 'agent', id: 'agent-1' } },
    category: 'ordinary',
    questions: questionInput(questionId).questions,
    timeoutMinutes: 1,
    createdAt,
  });
  return normalizeQuestionDetailV2({ ...record, deliveryCreationState: 'not_created', quarantinedAt: null });
}

function reservationFor(detail, overrides = {}) {
  return normalizeQuestionReservation({
    internalQuestionId: detail.internalQuestionId,
    identity: detail.identity,
    periodId: detail.periodId,
    questionId: detail.questionId,
    contentDigest: detail.contentDigest,
    executionId: detail.executionId,
    conversationId: detail.conversationId,
    launchRef: detail.launchRef,
    executionBinding: detail.executionBinding,
    createdAt: detail.createdAt,
    revision: detail.revision,
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
    quarantinedAt: detail.quarantinedAt,
    bodyState: 'retained',
    reclaimedAt: null,
    reclamation: null,
    ...overrides,
  });
}

function questionSnapshot({ questions = [], reservations = [], revision = 0, migrationAllowance = null } = {}) {
  return normalizeQuestionJournalV2Local({
    schemaVersion: 2,
    storeId: STORE_ID,
    revision,
    questions,
    reservations,
    migrationAllowance,
  });
}

function anchor(retiredQuestionPeriods = [], revision = 0) {
  return { schemaVersion: 1, revision, storeId: ANCHOR_ID, retiredQuestionPeriods, migration: null };
}

function createBackend(initialSnapshot, normalByteLimit = 16_777_216) {
  let snapshot = null;
  let installed = false;
  let writable = true;
  const calls = { load: 0, getStoreId: 0, getSnapshot: 0, save: 0, prepareResume: 0, canWrite: 0 };
  const backend = {
    slot: 'questions',
    normalByteLimit,
    canWrite() { calls.canWrite += 1; return writable; },
    getStoreId() {
      calls.getStoreId += 1;
      if (!installed) throw new Error('cold_store_id_read');
      return STORE_ID;
    },
    getSnapshot() {
      calls.getSnapshot += 1;
      if (!installed) throw new Error('cold_snapshot_read');
      return clone(snapshot);
    },
    async load() {
      calls.load += 1;
      if (!installed) throw new Error('cold_load');
      return clone(snapshot);
    },
    async save(candidate) {
      calls.save += 1;
      if (!installed) throw new Error('save_before_install');
      snapshot = questionSnapshot(candidate);
      return clone(snapshot);
    },
    prepareResume(fullSnapshot) {
      calls.prepareResume += 1;
      snapshot = questionSnapshot(fullSnapshot.stores.questions);
      installed = true;
    },
    async flush() {},
    async close() {},
  };
  const fullSnapshot = { anchor: anchor(), stores: { questions: questionSnapshot(initialSnapshot) } };
  return { backend, calls, fullSnapshot, setCanWrite(value) { writable = value; } };
}

function makeFixture(initialSnapshot = questionSnapshot(), { byteLimit = 16_777_216, delivery = {}, maxRecords } = {}) {
  let periodId = 'period-1';
  const binding = { periodId, actor: { kind: 'agent', id: 'agent-1' } };
  const claims = {
    launchId: 'launch-id', runId: 'run-id', attemptId: 'attempt-id', provider: identity.provider,
    nativeIdKind: identity.nativeIdKind, hostId: identity.hostId, homeScopeId: identity.homeScopeId,
    origin: 'standalone', purpose: 'agent', originBinding: null,
  };
  const launch = {
    ...claims,
    launchRef: 'launch-1', identity: clone(identity), executionBinding: clone(binding),
    conversationId: 'conversation-1', sessionId: 'session-1', state: 'bound', currentOwner: clone(binding),
    ownerGeneration: 0,
  };
  const writer = { token: 'a'.repeat(43), identity: clone(identity), contextId: 'context-1', executionId: periodId };
  const actor = { identity: clone(identity), periodId, actor: clone(binding.actor), contextId: 'context-1',
    launchRef: 'launch-1', connectionId: 'connection-1', connectionGeneration: 1, state: 'active' };
  const connection = { connectionId: 'connection-1', generation: 1, state: 'active',
    scope: { provider: identity.provider, nativeIdKind: identity.nativeIdKind, hostId: identity.hostId,
      homeScopeId: identity.homeScopeId, connectionSlotId: 'slot-1' } };
  const registrationRegistry = {
    authorizeWriter(value) {
      return value.token === writer.token && value.contextId === writer.contextId && value.executionId === periodId
        ? { ok: true, status: 'accepted', executionId: periodId, conversationId: 'conversation-1' }
        : { ok: false, status: 'unverified' };
    },
    snapshot() {
      return { conversations: [{ conversationId: 'conversation-1', identity: clone(identity) }],
        executions: [{ conversationId: 'conversation-1', executionId: periodId, state: 'active' }] };
    },
  };
  const launchRegistry = { get() { return clone(launch); }, snapshot() { return { launches: [clone(launch)] }; } };
  const runtimeRegistry = {
    get() { return clone(launch); },
    snapshot() { return { actors: [clone(actor)], connections: [clone(connection)] }; },
  };
  const deliveries = new Map();
  const payloads = new Map();
  const deliveryEvents = [];
  const timerCallbacks = [];
  const deliveryStore = {
    ready: Promise.resolve(),
    async createQuestionDelivery(input) {
      deliveryEvents.push('createQuestionDelivery');
      const payload = JSON.parse(input.payload);
      const item = {
        kind: 'question', deliveryAttemptId: input.deliveryAttemptId,
        logicalMessageId: input.logicalMessageId, revision: input.revision,
        payloadDigest: kernel.sha256Json(payload),
        source: { launchRef: input.launchRef, claims: clone(claims), identity: clone(identity),
          executionBinding: clone(binding), conversationId: 'conversation-1', sessionId: 'session-1' },
        target: { kind: 'execution', launchRef: input.launchRef, periodId, claims: clone(claims),
          actor: clone(binding.actor), identity: clone(identity), conversationId: 'conversation-1', sessionId: 'session-1' },
        state: 'available', cancelRequested: false,
      };
      deliveries.set(item.deliveryAttemptId, item);
      payloads.set(item.deliveryAttemptId, input.payload);
      return clone(item);
    },
    async get(id) { deliveryEvents.push('get'); return clone(deliveries.get(id) || null); },
    async snapshot() { deliveryEvents.push('snapshot'); return { deliveries: [...deliveries.values()].map(clone) }; },
    async rehydratePayload(id, payload) { deliveryEvents.push('rehydratePayload'); payloads.set(id, payload); },
    async sendStart(id, sink) {
      deliveryEvents.push('sendStart');
      const item = deliveries.get(id);
      item.state = 'sending';
      if (delivery.beforeSink) await delivery.beforeSink(item);
      const payload = payloads.get(id);
      payloads.delete(id);
      try { sink(payload, { deliveryAttemptId: id, payloadDigest: item.payloadDigest }); }
      catch { item.state = 'unknown'; }
      return clone(item);
    },
    async markUnknown(id) {
      deliveryEvents.push('markUnknown');
      const item = deliveries.get(id);
      if (item && ['sending', 'accepted'].includes(item.state)) item.state = 'unknown';
      return clone(item || null);
    },
    async cancel(id) { deliveryEvents.push('cancel'); return clone(deliveries.get(id) || null); },
    async flush() {},
  };
  const currentAnchor = anchor();
  const periodGate = createQuestionPeriodGate({ getAnchor: () => currentAnchor, canWrite: () => true });
  const backendState = createBackend(initialSnapshot, byteLimit);
  const service = createCommonQuestionService({
    reclamation: { backend: backendState.backend, periodGate },
    ...(maxRecords !== undefined ? { maxRecords } : {}),
    registrationRegistry,
    launchRegistry,
    runtimeRegistry,
    deliveryStore,
    away: { snapshot: () => ({ enabled: false, since: null }) },
    now: () => 100_000,
    setTimeoutImpl: (callback) => { timerCallbacks.push(callback); return { unref() {} }; },
    clearTimeoutImpl() {},
  });
  function setPeriod(value) {
    periodId = value;
    binding.periodId = value;
    writer.executionId = value;
    actor.periodId = value;
    launch.executionBinding = clone(binding);
    launch.currentOwner = clone(binding);
  }
  return { service, backendState, periodGate, writer, deliveryStore, deliveries, payloads, deliveryEvents,
    timerCallbacks, setPeriod };
}

async function install(fixture, fullSnapshot = fixture.backendState.fullSnapshot) {
  fixture.service.reclamationWriter.stop();
  fixture.service.reclamationWriter.prepareResume(fullSnapshot);
  await fixture.service.ready();
}

async function register(fixture, questionId = 'question-1') {
  return fixture.service.register(fixture.writer, questionInput(questionId));
}

test('registration blocks when the captured period gate closes before its compensation write', async (t) => {
  const fixture = makeFixture();
  t.after(() => fixture.service.close());
  await install(fixture);
  const save = fixture.backendState.backend.save;
  fixture.backendState.backend.save = async (candidate) => {
    const saved = await save(candidate);
    if (candidate.questions.some((record) => record.questionId === 'gate-closes-before-cancellation')) {
      fixture.periodGate.beginRetirement(identity, 'period-1');
      fixture.writer.token = 'b'.repeat(43);
    }
    return saved;
  };

  await assert.rejects(register(fixture, 'gate-closes-before-cancellation'),
    { code: 'question_cancelled_journal_save_failed' });
  assert.equal(fixture.backendState.calls.save, 1);
  const saved = fixture.backendState.backend.getSnapshot().questions[0];
  assert.equal(saved.cancelledAt, null);
  const diagnostics = fixture.service.getQuarantineDiagnostics();
  assert.equal(diagnostics.status, 'blocked');
  assert.equal(diagnostics.reason, 'question_cancelled_journal_save_failed');
  assert.equal(fixture.deliveries.size, 0);
  assert.equal(fixture.deliveryEvents.some((event) => event === 'createQuestionDelivery' || event === 'sendStart'), false);
});

test('the opt-in adapter installs only a prepared snapshot and never loads the legacy journal', async () => {
  const fixture = makeFixture();
  assert.deepEqual(fixture.backendState.calls,
    { load: 0, getStoreId: 0, getSnapshot: 0, save: 0, prepareResume: 0, canWrite: 0 });
  await install(fixture);
  assert.equal(fixture.backendState.calls.load, 0);
  assert.equal(fixture.backendState.calls.prepareResume, 1);
  assert.equal(fixture.service.reclamationWriter.prepareResume !== undefined, true);
  await fixture.service.close();
});

test('the shared writer gate rejects public queue work while cold or after local resume preparation', async (t) => {
  const fixture = makeFixture();
  t.after(() => fixture.service.close());
  fixture.backendState.setCanWrite(false);

  await assert.rejects(fixture.service.dashboardSnapshot(), { code: 'question_gate_closed' });
  fixture.service.reclamationWriter.stop();
  fixture.service.reclamationWriter.prepareResume(fixture.backendState.fullSnapshot);
  await assert.rejects(fixture.service.dashboardSnapshot(), { code: 'question_gate_closed' });
  assert.equal(fixture.backendState.calls.save, 0);
  assert.equal(fixture.deliveryEvents.length, 0);

  fixture.backendState.setCanWrite(true);
  fixture.service.reclamationWriter.stop();
  fixture.service.reclamationWriter.prepareResume(fixture.backendState.fullSnapshot);
  await fixture.service.ready();
});

test('retired reservation keys are quarantined while the same public key can be used in a fresh period', async (t) => {
  const detail = createDetail();
  const retiredReservation = reservationFor(detail, {
    quarantinedAt: 5_000,
    bodyState: 'reclaimed',
    reclaimedAt: 5_010,
    reclamation: { operationId: OPERATION_ID, preparedAt: 5_005, deliveryPresence: 'none', checkpointState: null },
  });
  const fixture = makeFixture(questionSnapshot({ revision: 1, reservations: [retiredReservation] }));
  t.after(() => fixture.service.close());
  await install(fixture);

  await assert.rejects(register(fixture), { code: 'question_quarantined' });
  fixture.setPeriod('period-2');
  assert.equal((await register(fixture)).outcome, 'created');
  assert.equal(fixture.backendState.calls.save, 1);
});

test('reclaimed reservations continue to consume the configured journal record limit', async (t) => {
  const detail = createDetail();
  const reservation = reservationFor(detail, {
    quarantinedAt: 5_000,
    bodyState: 'reclaimed',
    reclaimedAt: 5_010,
    reclamation: { operationId: OPERATION_ID, preparedAt: 5_005, deliveryPresence: 'none', checkpointState: null },
  });
  const fixture = makeFixture(questionSnapshot({ revision: 1, reservations: [reservation] }), { maxRecords: 1 });
  t.after(() => fixture.service.close());
  await install(fixture);
  fixture.setPeriod('period-2');

  await assert.rejects(register(fixture, 'question-2'), { code: 'question_quarantine_capacity' });
  assert.equal(fixture.backendState.calls.save, 0);
});

test('anchor reclamation capacity rejection is reported as question quarantine capacity', async (t) => {
  const fixture = makeFixture();
  t.after(() => fixture.service.close());
  await install(fixture);
  const originalSave = fixture.backendState.backend.save;
  t.after(() => { fixture.backendState.backend.save = originalSave; });
  let saveAttempts = 0;
  fixture.backendState.backend.save = async () => {
    saveAttempts += 1;
    const error = new Error('reclamation_capacity_exceeded');
    error.code = 'reclamation_capacity_exceeded';
    throw error;
  };

  await assert.rejects(register(fixture), { code: 'question_quarantine_capacity' });
  assert.equal(saveAttempts, 1);
  const diagnostics = fixture.service.getQuarantineDiagnostics();
  assert.equal(diagnostics.status, 'ready');
  assert.equal(diagnostics.reason, 'question_quarantine_capacity');
  assert.equal(diagnostics.quarantinedCount, 0);
  assert.ok(diagnostics.remainingCount > 0);
});

test('all ingress rejects retired reservation keys and ticks skip quarantined details', async (t) => {
  const graveDetail = createDetail({ internalQuestionId: 'cq-grave' });
  const grave = reservationFor(graveDetail, {
    quarantinedAt: 5_000,
    bodyState: 'reclaimed',
    reclaimedAt: 5_010,
    reclamation: { operationId: OPERATION_ID, preparedAt: 5_005, deliveryPresence: 'none', checkpointState: null },
  });
  const tickDetail = normalizeQuestionDetailV2({
    ...createDetail({ internalQuestionId: 'cq-tick', questionId: 'question-tick', createdAt: 0 }),
    quarantinedAt: 6_000,
  });
  const prepared = reservationFor(tickDetail, {
    quarantinedAt: 6_000,
    reclamation: { operationId: OPERATION_ID, preparedAt: 6_000, deliveryPresence: 'none', checkpointState: null },
  });
  const fixture = makeFixture(questionSnapshot({
    revision: 1,
    questions: [tickDetail],
    reservations: [grave, prepared],
  }));
  t.after(() => fixture.service.close());
  await install(fixture);
  const beforeDeliveryEvents = fixture.deliveryEvents.length;

  await assert.rejects(fixture.service.status(fixture.writer, grave.questionId), { code: 'question_quarantined' });
  await assert.rejects(fixture.service.answerPoll(fixture.writer, grave.questionId, () => {}),
    { code: 'question_quarantined' });
  await assert.rejects(fixture.service.submitAnswer(grave.internalQuestionId, {
    answers: [{ questionId: 'decision', optionIds: ['continue'], freeText: null }],
  }), { code: 'question_quarantined' });
  await assert.rejects(fixture.service.hold(grave.internalQuestionId, true), { code: 'question_quarantined' });
  await assert.rejects(fixture.service.cancel(grave.internalQuestionId), { code: 'question_quarantined' });
  await assert.rejects(fixture.service.resolveExternal(grave.internalQuestionId, {}), { code: 'question_quarantined' });
  await assert.rejects(fixture.service.reportResponseLost(grave.internalQuestionId), { code: 'question_quarantined' });
  await assert.rejects(fixture.service.readLateAnswerDraft(grave.internalQuestionId, 0, 'a'.repeat(64)),
    { code: 'question_quarantined' });
  await fixture.service.tick();
  await fixture.service.notifyAwayChanged();

  assert.equal(fixture.backendState.calls.save, 0);
  assert.equal(fixture.deliveryEvents.length, beforeDeliveryEvents);
  assert.equal(fixture.deliveries.size, 0);
  assert.equal(fixture.timerCallbacks.length, 0);
});

test('a captured period token is rechecked before the queued write reaches persistence', async (t) => {
  let enterSnapshot;
  let releaseSnapshot;
  const snapshotEntered = new Promise((resolve) => { enterSnapshot = resolve; });
  const snapshotRelease = new Promise((resolve) => { releaseSnapshot = resolve; });
  const fixture = makeFixture();
  t.after(() => fixture.service.close());
  await install(fixture);
  const originalSnapshot = fixture.deliveryStore.snapshot;
  fixture.deliveryStore.snapshot = async () => {
    enterSnapshot();
    await snapshotRelease;
    fixture.deliveryStore.snapshot = originalSnapshot;
    return originalSnapshot();
  };

  const blocker = fixture.service.dashboardSnapshot();
  await snapshotEntered;
  const queuedRegistration = register(fixture);
  fixture.periodGate.beginRetirement(identity, 'period-1');
  releaseSnapshot();
  await blocker;
  await assert.rejects(queuedRegistration, { code: 'question_quarantined' });
  assert.equal(fixture.backendState.calls.save, 0);
});

test('the shared writer gate is rechecked when a public operation leaves the queue', async (t) => {
  let enterSnapshot;
  let releaseSnapshot;
  const snapshotEntered = new Promise((resolve) => { enterSnapshot = resolve; });
  const snapshotRelease = new Promise((resolve) => { releaseSnapshot = resolve; });
  const fixture = makeFixture();
  t.after(() => fixture.service.close());
  await install(fixture);
  const originalSnapshot = fixture.deliveryStore.snapshot;
  fixture.deliveryStore.snapshot = async () => {
    enterSnapshot();
    await snapshotRelease;
    fixture.deliveryStore.snapshot = originalSnapshot;
    return originalSnapshot();
  };

  const blocker = fixture.service.dashboardSnapshot();
  await snapshotEntered;
  const queuedRegistration = register(fixture);
  fixture.backendState.setCanWrite(false);
  releaseSnapshot();
  await blocker;
  await assert.rejects(queuedRegistration, { code: 'question_gate_closed' });
  assert.equal(fixture.backendState.calls.save, 0);
});

test('the adapter rejects a stale period token before calling backend save', async (t) => {
  const fixture = makeFixture();
  t.after(() => fixture.service.close());
  await install(fixture);
  const adapter = createCommonQuestionReclamationJournal({
    backend: fixture.backendState.backend,
    periodGate: fixture.periodGate,
  });
  adapter.prepareResume(fixture.backendState.fullSnapshot);
  const current = adapter.getSnapshot();
  const record = kernel.createQuestionRecord({
    internalQuestionId: 'cq-adapter', questionId: 'question-adapter', identity, periodId: 'period-1',
    executionId: 'period-1', conversationId: 'conversation-1', launchRef: 'launch-1',
    executionBinding: { periodId: 'period-1', actor: { kind: 'agent', id: 'agent-1' } },
    category: 'ordinary', questions: questionInput('question-adapter').questions, timeoutMinutes: 1, createdAt: 1_000,
  });
  const candidate = kernel.addQuestion(adapter.getLegacySnapshot(), record);
  const token = fixture.periodGate.capture(identity, 'period-1');
  fixture.periodGate.beginRetirement(identity, 'period-1');

  await assert.rejects(adapter.save(candidate, token), { code: 'question_quarantined' });
  assert.equal(fixture.backendState.calls.save, 0);
  assert.equal(current.questions.length, 0);
  await adapter.close();
});

test('answer delivery checks the captured token immediately before invoking the trusted sink', async (t) => {
  let fixture;
  fixture = makeFixture(questionSnapshot(), { delivery: {
    beforeSink() { fixture.periodGate.beginRetirement(identity, 'period-1'); },
  } });
  t.after(() => fixture.service.close());
  await install(fixture);
  const created = await register(fixture);
  await fixture.service.submitAnswer(created.question.internalQuestionId, {
    answers: [{ questionId: 'decision', optionIds: ['continue'], freeText: null }],
  });
  let sinkCalls = 0;

  await assert.rejects(fixture.service.answerPoll(fixture.writer, 'question-1', () => { sinkCalls += 1; }),
    { code: 'question_quarantined' });
  assert.equal(sinkCalls, 0);
});

test('ready and existing transitions may use the fixed grant while new intake remains bounded by B', async (t) => {
  const detail = createDetail();
  const reservation = reservationFor(detail);
  const legacyDetail = { ...detail };
  delete legacyDetail.deliveryCreationState;
  delete legacyDetail.quarantinedAt;
  const oldJournal = kernel.addQuestion(kernel.createEmptyJournal(), legacyDetail);
  const oldSourceBytes = Buffer.from(`${JSON.stringify(oldJournal, null, 2)}\n`, 'utf8');
  const migrationAllowance = {
    operationId: OPERATION_ID,
    sourceSchemaVersion: 1,
    sourceSizeBytes: oldSourceBytes.length,
    sourceSha256: createHash('sha256').update(oldSourceBytes).digest('hex'),
    maxExtraBytes: 1_000_000,
    eligibleQuestionIds: [detail.internalQuestionId],
  };
  const migrated = questionSnapshot({ revision: 1, questions: [detail], reservations: [reservation], migrationAllowance });
  const currentByteLimit = oldSourceBytes.length;
  const measure = measureQuestionJournalReservationBytes({ snapshot: migrated, currentByteLimit: 16_777_216 });
  assert.ok(measure.reservedBytes > currentByteLimit);
  const fixture = makeFixture(migrated, { byteLimit: currentByteLimit });
  t.after(() => fixture.service.close());
  await install(fixture);

  const held = await fixture.service.hold(detail.internalQuestionId, true);
  assert.equal(held.outcome, 'held');
  const savesBeforeNewQuestion = fixture.backendState.calls.save;
  await assert.rejects(register(fixture, 'question-2'), { code: 'question_quarantine_capacity' });
  assert.equal(fixture.backendState.calls.save, savesBeforeNewQuestion);
});
