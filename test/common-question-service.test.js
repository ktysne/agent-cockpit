'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const kernel = require('../src/server/common-question-kernel');
const { createCommonQuestionService } = require('../src/server/common-question-service');
const { createCommonQuestionProductHarness } = require('./support/common-question-product-harness');
const { atomicWriteJson } = require('../src/server/json-storage');

function clone(value) {
  return structuredClone(value);
}

function makeDeliveryStore(launch, options = {}) {
  const deliveries = new Map();
  const payloads = new Map();
  const rehydratedIds = [];
  const store = {
    ready: Promise.resolve(),
    async createQuestionDelivery(input) {
      if (options.beforeCreate) await options.beforeCreate(input);
      const data = JSON.parse(input.payload);
      const delivery = {
        kind: 'question',
        deliveryAttemptId: input.deliveryAttemptId,
        logicalMessageId: input.logicalMessageId,
        revision: input.revision,
        payloadDigest: kernel.sha256Json(data),
        source: { launchRef: input.launchRef,
          claims: Object.fromEntries(['launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'origin', 'purpose', 'originBinding'].map((key) => [key, clone(launch[key])])),
          identity: clone(launch.identity), executionBinding: clone(launch.executionBinding),
          conversationId: launch.conversationId, sessionId: launch.sessionId },
        target: { kind: 'execution', launchRef: input.launchRef, periodId: launch.executionBinding.periodId,
          claims: Object.fromEntries(['launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'origin', 'purpose', 'originBinding'].map((key) => [key, clone(launch[key])])),
          actor: clone(launch.executionBinding.actor), identity: clone(launch.identity),
          conversationId: launch.conversationId, sessionId: launch.sessionId },
        state: 'available',
        cancelRequested: false,
      };
      deliveries.set(delivery.deliveryAttemptId, delivery);
      payloads.set(delivery.deliveryAttemptId, input.payload);
      return clone(delivery);
    },
    async get(id) { return clone(deliveries.get(id) || null); },
    async snapshot() { return { deliveries: [...deliveries.values()].map(clone) }; },
    async rehydratePayload(id, payload) {
      rehydratedIds.push(id);
      const delivery = deliveries.get(id);
      if (!delivery || !['available', 'claimed'].includes(delivery.state)) {
        const error = new Error('payload_rehydrate_forbidden');
        error.code = 'payload_rehydrate_forbidden';
        throw error;
      }
      if (kernel.sha256Json(JSON.parse(payload)) !== delivery.payloadDigest) {
        const error = new Error('payload_digest_mismatch');
        error.code = 'payload_digest_mismatch';
        throw error;
      }
      payloads.set(id, payload);
      return clone(delivery);
    },
    async sendStart(id, sink) {
      const delivery = deliveries.get(id);
      if (!delivery || !['available', 'claimed'].includes(delivery.state) || !payloads.has(id)) {
        const error = new Error('payload_unavailable');
        error.code = 'payload_unavailable';
        throw error;
      }
      delivery.state = 'sending';
      if (options.beforeSink) await options.beforeSink(delivery);
      const payload = payloads.get(id);
      payloads.delete(id);
      try { sink(payload, { deliveryAttemptId: id, payloadDigest: delivery.payloadDigest }); }
      catch { delivery.state = 'unknown'; }
      return clone(delivery);
    },
    async cancel(id) {
      const delivery = deliveries.get(id);
      if (!delivery) throw new Error('delivery_not_found');
      if (['available', 'claimed'].includes(delivery.state)) {
        delivery.state = 'cancelled_before_send';
        payloads.delete(id);
      } else if (['sending', 'accepted'].includes(delivery.state)) {
        delivery.cancelRequested = true;
      }
      return clone(delivery);
    },
    async markUnknown(id) {
      const delivery = deliveries.get(id);
      if (delivery && ['sending', 'accepted'].includes(delivery.state)) delivery.state = 'unknown';
      return clone(delivery || null);
    },
    async flush() {},
  };
  return { store, deliveries, payloads, rehydratedIds };
}

async function createFixture(t, overrides = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'common-question-service-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const identity = { provider: 'claude', nativeIdKind: 'session', hostId: 'host',
    homeScopeId: 'home', nativeId: 'native-session' };
  const binding = { periodId: 'period-1', actor: { kind: 'agent', id: 'agent-1' } };
  const claims = {
    launchId: 'launch-id', runId: 'run-id', attemptId: 'attempt-id',
    provider: identity.provider, nativeIdKind: identity.nativeIdKind,
    hostId: identity.hostId, homeScopeId: identity.homeScopeId,
    origin: 'standalone', purpose: 'agent', originBinding: null,
  };
  const launchRef = 'launch-ref';
  const launch = { ...claims, launchRef, identity: clone(identity), executionBinding: clone(binding),
    conversationId: 'conversation-1', sessionId: 'session-1', state: 'bound',
    currentOwner: clone(binding), ownerGeneration: 0 };
  let writerValid = true;
  const writer = { token: 'a'.repeat(43), identity: clone(identity), contextId: 'context-1', executionId: 'period-1' };
  const registrationRegistry = {
    authorizeWriter(value) {
      return writerValid && value.token === writer.token && value.contextId === writer.contextId &&
        value.executionId === writer.executionId
        ? { ok: true, status: 'accepted', executionId: 'period-1', conversationId: 'conversation-1' }
        : { ok: false, status: 'unverified' };
    },
    snapshot() {
      return { conversations: [{ conversationId: 'conversation-1', identity: clone(identity) }],
        executions: [{ conversationId: 'conversation-1', executionId: 'period-1', sessionId: 'session-1', state: 'active' }] };
    },
  };
  const actor = { identity: clone(identity), periodId: 'period-1', actor: clone(binding.actor),
    contextId: 'context-1', launchRef, connectionId: 'connection-1', connectionGeneration: 1, state: 'active' };
  const connection = { connectionId: 'connection-1', generation: 1, state: 'active',
    scope: { provider: identity.provider, nativeIdKind: identity.nativeIdKind, hostId: identity.hostId,
      homeScopeId: identity.homeScopeId, connectionSlotId: 'slot-1' } };
  let runtimeActors = [actor];
  let runtimeConnections = [connection];
  const launchRegistry = { get() { return clone(launch); }, snapshot() { return { launches: [clone(launch)] }; } };
  const runtimeRegistry = {
    get() { return clone(launch); },
    snapshot() { return { actors: runtimeActors.map(clone), connections: runtimeConnections.map(clone) }; },
  };
  let now = 1_000;
  let awayEnabled = false;
  let nextTimerId = 0;
  const timers = new Map();
  const timeout = (callback, delay) => {
    const id = ++nextTimerId;
    timers.set(id, { callback, delay });
    return id;
  };
  const clearTimeout = (id) => timers.delete(id);
  const delivery = makeDeliveryStore(launch, overrides.delivery || {});
  const journalPath = path.join(directory, 'questions.json');
  const createService = (deliveryStore = delivery.store) => createCommonQuestionService({
    journalPath,
    registrationRegistry,
    launchRegistry,
    runtimeRegistry,
    deliveryStore,
    away: { snapshot: () => ({ enabled: awayEnabled }) },
    now: () => now,
    setTimeoutImpl: timeout,
    clearTimeoutImpl: clearTimeout,
    ...(overrides.atomicWrite ? { atomicWrite: overrides.atomicWrite } : {}),
    ...(overrides.verifyNativeQuestion ? { verifyNativeQuestion: overrides.verifyNativeQuestion } : {}),
  });
  const service = createService();
  t.after(() => service.close());
  return {
    directory, journalPath, identity, binding, launch, launchRef, writer, registrationRegistry, actor, connection,
    delivery, service, createService, timers,
    setRuntime(actors, connections) { runtimeActors = actors; runtimeConnections = connections; },
    setNow(value) { now = value; }, setAway(value) { awayEnabled = value; },
    invalidateWriter() { writerValid = false; },
  };
}

function question(id = 'question-1', opts = {}) {
  return { questionId: id, questions: [{
    id: 'decision', text: 'Choose a course of action', mode: 'single',
    options: [{ id: 'continue', label: 'Continue', description: 'Continue the work' },
      { id: 'stop', label: 'Stop', description: 'Stop the work' }],
    allowFreeText: opts.allowFreeText === true, recommendedOptionId: opts.recommendation ?? null,
  }], timeoutMinutes: 1, category: 'ordinary' };
}

function answers(optionId = 'continue', freeText = null) {
  return { answers: [{ questionId: 'decision', optionIds: [optionId], freeText }] };
}

async function register(fixture, input = question()) {
  return fixture.service.register(fixture.writer, input);
}

async function select(fixture, result, value = answers()) {
  return fixture.service.submitAnswer(result.question.internalQuestionId, value);
}

function fireNextTimer(fixture) {
  const [id, item] = fixture.timers.entries().next().value || [];
  if (!item) throw new Error('timer_not_scheduled');
  fixture.timers.delete(id);
  item.callback();
  return item.delay;
}

function errorCode(code) {
  return (error) => error?.code === code;
}

test('registration fixes its identity, content, and original deadline without exposing answers', async (t) => {
  const fixture = await createFixture(t);
  const created = await register(fixture);
  const same = await register(fixture, { ...question(), timeoutMinutes: 2 });
  assert.equal(same.outcome, 'existing');
  assert.equal(same.question.deadlineAt, created.question.deadlineAt);
  await assert.rejects(register(fixture, question('question-1', { allowFreeText: true })),
    errorCode('question_conflict'));
  const status = await fixture.service.status(fixture.writer, 'question-1');
  assert.equal(Object.hasOwn(status, 'answers'), false);
  assert.equal(Object.hasOwn(status, 'freeText'), false);
  const dashboard = await fixture.service.dashboardSnapshot();
  assert.equal(dashboard.questions[0].conversationId, 'conversation-1');
  assert.deepEqual(dashboard.questions[0].selectedOptionIds, []);
});

test('manual selection persists one delivery intent and answer poll exposes it once', async (t) => {
  const fixture = await createFixture(t);
  const created = await register(fixture);
  const chosen = await select(fixture, created, answers('stop'));
  assert.equal(chosen.outcome, 'selected');
  assert.equal(chosen.question.deliveryState, 'available');
  const attemptId = chosen.question.deliveryAttemptId;
  const sent = [];
  const first = await fixture.service.answerPoll(fixture.writer, 'question-1', (value, metadata) => {
    sent.push({ value, metadata });
  });
  assert.equal(first.outcome, 'sent');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].metadata.deliveryAttemptId, attemptId);
  assert.deepEqual(sent[0].value, answers('stop').answers);
  const second = await fixture.service.answerPoll(fixture.writer, 'question-1', () => sent.push('duplicate'));
  assert.equal(second.outcome, 'already_started');
  assert.equal(sent.length, 1);
  const status = await fixture.service.status(fixture.writer, 'question-1');
  assert.equal(Object.hasOwn(status, 'answers'), false);
  assert.deepEqual((await fixture.service.dashboardSnapshot()).questions[0].selectedOptionIds,
    [{ questionId: 'decision', optionIds: ['stop'] }]);
});

test('a rejected promise-returning answer sink becomes unknown without an unhandled rejection', async (t) => {
  const fixture = await createFixture(t);
  const created = await register(fixture);
  await select(fixture, created);
  let calls = 0;
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const first = await fixture.service.answerPoll(fixture.writer, 'question-1', () => {
    calls += 1;
    return Promise.reject(new Error('late sink failure'));
  });
  assert.equal(first.outcome, 'unknown');
  const second = await fixture.service.answerPoll(fixture.writer, 'question-1', () => { calls += 1; });
  assert.equal(second.outcome, 'already_started');
  assert.equal(calls, 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

test('an arbitrary sink thenable is rejected without invoking its then method', async (t) => {
  const fixture = await createFixture(t);
  const created = await register(fixture);
  await select(fixture, created);
  let thenCalls = 0;
  const result = await fixture.service.answerPoll(fixture.writer, 'question-1', () => ({
    then() { thenCalls += 1; },
  }));
  assert.equal(result.outcome, 'unknown');
  assert.equal(thenCalls, 0);
});

test('a rejected native verifier promise is consumed while external verification stays synchronous', async (t) => {
  const unhandled = [];
  const onUnhandled = (reason) => unhandled.push(reason);
  process.on('unhandledRejection', onUnhandled);
  t.after(() => process.off('unhandledRejection', onUnhandled));
  const fixture = await createFixture(t, {
    verifyNativeQuestion: () => Promise.reject(new Error('late verifier failure')),
  });
  const created = await register(fixture);
  await assert.rejects(fixture.service.resolveExternal(created.question.internalQuestionId, { result: 'resolved' }),
    errorCode('native_question_unverified'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
});

test('response loss marks sending unknown without creating another attempt', async (t) => {
  const fixture = await createFixture(t);
  const created = await register(fixture);
  await select(fixture, created);
  const sent = await fixture.service.answerPoll(fixture.writer, 'question-1', () => {});
  assert.equal(sent.outcome, 'sent');
  const lost = await fixture.service.reportResponseLost(created.question.internalQuestionId);
  assert.equal(lost.outcome, 'unknown');
  assert.equal(lost.question.deliveryState, 'unknown');
  let calls = 0;
  const retry = await fixture.service.answerPoll(fixture.writer, 'question-1', () => { calls += 1; });
  assert.equal(retry.outcome, 'already_started');
  assert.equal(calls, 0);
});

test('cancelling an unsent selection removes its payload and is idempotent', async (t) => {
  const fixture = await createFixture(t);
  const created = await register(fixture);
  const chosen = await select(fixture, created);
  const id = chosen.question.deliveryAttemptId;
  assert.equal(fixture.delivery.payloads.has(id), true);
  const cancelled = await fixture.service.cancel(created.question.internalQuestionId);
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(cancelled.question.deliveryState, 'cancelled_before_send');
  assert.equal(fixture.delivery.payloads.has(id), false);
  assert.equal((await fixture.service.cancel(created.question.internalQuestionId)).outcome, 'cancelled');
  assert.equal((await fixture.service.dashboardSnapshot()).questions[0].cancelled, true);
});

test('an expired pending question is rechecked after away changes without a dashboard poll', async (t) => {
  const fixture = await createFixture(t);
  const input = question('question-default', { recommendation: 'continue' });
  await register(fixture, input);
  fixture.setNow(61_001);
  assert.equal(fireNextTimer(fixture), 60_000);
  await fixture.service.flush();
  assert.equal([...fixture.timers.values()][0].delay, 1_000);
  fixture.setAway(true);
  assert.equal(fireNextTimer(fixture), 1_000);
  await fixture.service.flush();
  const status = await fixture.service.status(fixture.writer, 'question-default');
  assert.equal(status.selectionSource, 'away-default');
  assert.equal(status.deliveryState, 'available');
});

test('one timeout delivery creation failure reschedules other expired questions', async (t) => {
  let failures = 1;
  const fixture = await createFixture(t, { delivery: { beforeCreate: async () => {
    if (failures-- > 0) throw new Error('temporary delivery failure');
  } } });
  await register(fixture, question('question-timeout-first', { recommendation: 'continue' }));
  await register(fixture, question('question-timeout-next', { recommendation: 'stop' }));
  fixture.setNow(61_001);
  fixture.setAway(true);

  await assert.rejects(fixture.service.tick(), /temporary delivery failure/);
  assert.equal([...fixture.timers.values()][0].delay, 1_000);
  assert.equal(fireNextTimer(fixture), 1_000);
  await fixture.service.flush();

  const first = await fixture.service.status(fixture.writer, 'question-timeout-first');
  const next = await fixture.service.status(fixture.writer, 'question-timeout-next');
  assert.equal(first.selectionSource, 'away-default');
  assert.equal(first.deliveryState, null);
  assert.equal(next.selectionSource, 'away-default');
  assert.equal(next.deliveryState, 'available');
  assert.deepEqual((await fixture.service.dashboardSnapshot()).questions.map((item) => item.questionId),
    ['question-timeout-first', 'question-timeout-next']);
});

test('a stale writer discovered after send-start persistence cannot receive the answer', async (t) => {
  let reached;
  let release;
  const paused = new Promise((resolve) => { reached = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const fixture = await createFixture(t, { delivery: { beforeSink: async () => { reached(); await barrier; } } });
  const created = await register(fixture);
  await select(fixture, created);
  let sinkCalls = 0;
  const pending = fixture.service.answerPoll(fixture.writer, 'question-1', () => { sinkCalls += 1; });
  await paused;
  fixture.invalidateWriter();
  release();
  const result = await pending;
  assert.equal(result.outcome, 'unknown');
  assert.equal(result.deliveryState, 'unknown');
  assert.equal(sinkCalls, 0);
});

test('a trusted external resolution suppresses a sink while send-start is paused', async (t) => {
  let reached;
  let release;
  const paused = new Promise((resolve) => { reached = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const fixture = await createFixture(t, {
    delivery: { beforeSink: async () => { reached(); await barrier; } },
    verifyNativeQuestion: () => true,
  });
  const created = await register(fixture);
  await select(fixture, created);
  let sinkCalls = 0;
  const pendingPoll = fixture.service.answerPoll(fixture.writer, 'question-1', () => { sinkCalls += 1; });
  await paused;
  const pendingResolve = fixture.service.resolveExternal(created.question.internalQuestionId, { source: 'trusted' });
  release();
  const poll = await pendingPoll;
  const resolved = await pendingResolve;
  assert.equal(poll.outcome, 'suppressed');
  assert.equal(resolved.outcome, 'resolved');
  assert.equal(sinkCalls, 0);
  assert.equal(resolved.question.deliveryState, 'unknown');
});

test('external resolution preserves a late answer without marking the question manually cancelled', async (t) => {
  const fixture = await createFixture(t, { verifyNativeQuestion: () => true });
  const created = await register(fixture);
  const chosen = await select(fixture, created, answers('continue'));
  const id = chosen.question.deliveryAttemptId;
  assert.equal(fixture.delivery.payloads.has(id), true);

  const resolved = await fixture.service.resolveExternal(created.question.internalQuestionId, { source: 'trusted' });
  assert.equal(resolved.question.externalResolution, true);
  assert.equal(resolved.question.deliveryState, 'cancelled_before_send');
  assert.equal(resolved.question.cancelled, false);
  assert.equal(resolved.question.cancelHistoryMissing, false);
  assert.equal(fixture.delivery.payloads.has(id), false);

  let sinkCalls = 0;
  const poll = await fixture.service.answerPoll(fixture.writer, 'question-1', () => { sinkCalls += 1; });
  assert.equal(poll.outcome, 'unavailable');
  assert.equal(poll.cancelled, false);
  assert.equal(sinkCalls, 0);

  const late = await fixture.service.submitAnswer(created.question.internalQuestionId, answers('stop'));
  assert.equal(late.outcome, 'late');
  const dashboard = await fixture.service.dashboardSnapshot();
  assert.equal(dashboard.questions[0].cancelled, false);
  assert.equal(dashboard.questions[0].cancelHistoryMissing, false);
  assert.equal(dashboard.questions[0].lateAnswerCount, 1);
  assert.deepEqual(dashboard.questions[0].selectedOptionIds, [{ questionId: 'decision', optionIds: ['continue'] }]);
});

test('manual cancellation after external resolution persists without retrying the stopped delivery', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'common-question-service-external-cancel-'));
  const harness = await createCommonQuestionProductHarness({ provider: 'claude', directory,
    questionServiceOptions: { verifyNativeQuestion: () => true } });
  t.after(async () => {
    await harness.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const created = await harness.questionService.register(harness.writer, question('question-external-cancel'));
  const chosen = await harness.questionService.submitAnswer(created.question.internalQuestionId, answers('continue'));
  assert.equal(chosen.question.deliveryState, 'available');
  const resolved = await harness.questionService.resolveExternal(created.question.internalQuestionId, { source: 'trusted' });
  assert.equal(resolved.question.externalResolution, true);
  assert.equal(resolved.question.deliveryState, 'cancelled_before_send');
  assert.equal(resolved.question.cancelled, false);

  const cancelled = await harness.questionService.cancel(created.question.internalQuestionId);
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(cancelled.question.externalResolution, true);
  assert.equal(cancelled.question.cancelled, true);
  assert.equal(cancelled.question.cancelHistoryMissing, false);
  await harness.reopen();

  const status = await harness.questionService.status(harness.writer, 'question-external-cancel');
  assert.equal(status.externalResolution, true);
  assert.equal(status.cancelled, true);
  assert.equal(status.deliveryState, 'cancelled_before_send');
  assert.equal(status.cancelHistoryMissing, false);
  await assert.rejects(harness.questionService.submitAnswer(created.question.internalQuestionId, answers('stop')),
    errorCode('question_cancelled'));
  let sinkCalls = 0;
  const poll = await harness.questionService.answerPoll(harness.writer, 'question-external-cancel', () => { sinkCalls += 1; });
  assert.equal(poll.outcome, 'unavailable');
  assert.equal(sinkCalls, 0);
  const repeated = await harness.questionService.cancel(created.question.internalQuestionId);
  assert.equal(repeated.outcome, 'cancelled');
  assert.equal(repeated.question.externalResolution, true);
  assert.equal(repeated.question.cancelled, true);
});

test('cancelling unknown persists a request in the file-backed delivery store without retrying', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'common-question-service-file-backed-'));
  const harness = await createCommonQuestionProductHarness({ provider: 'claude', directory });
  t.after(async () => {
    await harness.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const created = await harness.questionService.register(harness.writer, question('question-unknown-cancel'));
  const chosen = await harness.questionService.submitAnswer(created.question.internalQuestionId, answers());
  const deliveryId = chosen.question.deliveryAttemptId;
  let initialCalls = 0;
  const sent = await harness.questionService.answerPoll(harness.writer, 'question-unknown-cancel', () => {
    initialCalls += 1;
    throw new Error('sink failed');
  });
  assert.equal(sent.outcome, 'unknown');
  assert.equal(initialCalls, 1);

  const cancelled = await harness.questionService.cancel(created.question.internalQuestionId);
  assert.equal(cancelled.outcome, 'too_late');
  assert.equal(cancelled.question.deliveryState, 'unknown');
  assert.equal(cancelled.question.cancelRequested, true);
  await harness.reopen();

  const status = await harness.questionService.status(harness.writer, 'question-unknown-cancel');
  assert.equal(status.deliveryState, 'unknown');
  assert.equal(status.cancelRequested, true);
  const persistedDelivery = await harness.deliveryStore.get(deliveryId);
  assert.equal(persistedDelivery.state, 'unknown');
  assert.equal(persistedDelivery.cancelRequested, true);
  let retryCalls = 0;
  const retry = await harness.questionService.answerPoll(harness.writer, 'question-unknown-cancel', () => { retryCalls += 1; });
  assert.equal(retry.outcome, 'already_started');
  assert.equal(retryCalls, 0);
});

test('journal write failure after durable cancellation is diagnosed without claiming history saved', async (t) => {
  const atomicWrite = async (filePath, value) => {
    if (value.questions.some((record) => record.cancelledAt !== null)) throw new Error('disk-full');
    return atomicWriteJson(path.dirname(filePath), path.basename(filePath), value);
  };
  const fixture = await createFixture(t, { atomicWrite });
  const created = await register(fixture);
  await select(fixture, created);
  await assert.rejects(fixture.service.cancel(created.question.internalQuestionId),
    errorCode('question_cancelled_journal_save_failed'));
  const dashboard = await fixture.service.dashboardSnapshot();
  assert.equal(dashboard.recovery.state, 'blocked');
  assert.equal(dashboard.questions[0].cancelled, true);
  assert.equal(dashboard.questions[0].cancelHistoryMissing, true);
});

test('a CQ-owned delivery without a readable matching journal blocks writes but keeps diagnostics readable', async (t) => {
  const fixture = await createFixture(t);
  const orphanId = 'orphan-delivery';
  fixture.delivery.deliveries.set(orphanId, {
    deliveryAttemptId: orphanId, logicalMessageId: 'common-question-cq-12345678-1234-1234-1234-123456789abc',
  });
  await assert.rejects(fixture.service.ready(), errorCode('question_journal_missing_for_delivery'));
  await assert.rejects(register(fixture), errorCode('question_journal_missing_for_delivery'));
  const dashboard = await fixture.service.dashboardSnapshot();
  assert.deepEqual(dashboard.questions, []);
  assert.equal(dashboard.recovery.code, 'question_journal_missing_for_delivery');
});

test('a corrupt journal yields payload-free recovery metadata instead of a dashboard read failure', async (t) => {
  const fixture = await createFixture(t);
  await fs.writeFile(path.join(fixture.directory, 'questions.json'), '{bad');
  const recoveryFixture = await createFixture(t);
  const filePath = path.join(recoveryFixture.directory, 'questions.json');
  await fs.writeFile(filePath, '{bad');
  await assert.rejects(recoveryFixture.service.ready(), errorCode('invalid_journal_json'));
  assert.deepEqual(await recoveryFixture.service.dashboardSnapshot(), {
    version: 1, questions: [], recovery: { state: 'blocked', code: 'invalid_journal_json' },
  });
  void fixture;
});
test('selection journal intent is rehydrated with the same delivery ID after restart', async (t) => {
  let failCreate = true;
  const fixture = await createFixture(t, { delivery: { beforeCreate: async () => {
    if (failCreate) { failCreate = false; throw new Error('delivery store unavailable'); }
  } } });
  const created = await register(fixture);
  await assert.rejects(select(fixture, created), /delivery store unavailable/);
  const selected = await fixture.service.status(fixture.writer, 'question-1');
  const fixedId = selected.deliveryAttemptId;
  assert.equal(selected.selectionSource, 'manual');
  assert.equal(selected.deliveryState, null);
  await fixture.service.close();

  const restoredStore = makeDeliveryStore(fixture.launch);
  const restored = fixture.createService(restoredStore.store);
  t.after(() => restored.close());
  await restored.ready();
  assert.deepEqual(restoredStore.rehydratedIds, [fixedId]);
  const afterRestore = await restored.status(fixture.writer, 'question-1');
  assert.equal(afterRestore.deliveryAttemptId, fixedId);
  assert.equal(afterRestore.deliveryState, 'available');
  const sent = await restored.answerPoll(fixture.writer, 'question-1', () => {});
  assert.equal(sent.deliveryAttemptId, fixedId);
  assert.equal(sent.outcome, 'sent');
});

test('external evidence is rejected when its encoded JSON exceeds the input limit', async (t) => {
  const fixture = await createFixture(t, { verifyNativeQuestion: () => true });
  const created = await register(fixture);
  const oversizedNumbers = Array(4_000).fill(12345678901234567890);
  await assert.rejects(fixture.service.resolveExternal(created.question.internalQuestionId, oversizedNumbers),
    errorCode('invalid_evidence'));
});

test('cancel after send-start records a request without hiding the sending state', async (t) => {
  let reached;
  let release;
  const paused = new Promise((resolve) => { reached = resolve; });
  const barrier = new Promise((resolve) => { release = resolve; });
  const fixture = await createFixture(t, { delivery: { beforeSink: async () => { reached(); await barrier; } } });
  const created = await register(fixture);
  await select(fixture, created);
  const poll = fixture.service.answerPoll(fixture.writer, 'question-1', () => {});
  await paused;
  const cancellation = fixture.service.cancel(created.question.internalQuestionId);
  release();
  await poll;
  const result = await cancellation;
  assert.equal(result.outcome, 'too_late');
  assert.equal(result.question.deliveryState, 'sending');
  assert.equal(result.question.cancelRequested, true);
  assert.equal(result.question.cancelled, false);
});

test('writer resolution selects the sole current actor beside a stale actor record', async (t) => {
  const fixture = await createFixture(t);
  const staleActor = { ...clone(fixture.actor), state: 'unknown' };
  const currentActor = { ...clone(fixture.actor), connectionId: 'connection-2', connectionGeneration: 2 };
  const staleConnection = { ...clone(fixture.connection), state: 'inactive' };
  const currentConnection = { ...clone(fixture.connection), connectionId: 'connection-2', generation: 2 };
  fixture.setRuntime([staleActor, currentActor], [staleConnection, currentConnection]);
  const created = await register(fixture);
  assert.equal(created.outcome, 'created');
  assert.equal(created.question.executionId, 'period-1');
});

test('writer resolution rejects when more than one current actor matches its context', async (t) => {
  const fixture = await createFixture(t);
  const firstActor = { ...clone(fixture.actor), connectionId: 'connection-2', connectionGeneration: 2 };
  const secondActor = { ...clone(fixture.actor), connectionId: 'connection-3', connectionGeneration: 2 };
  const firstConnection = { ...clone(fixture.connection), connectionId: 'connection-2', generation: 2 };
  const secondConnection = { ...clone(fixture.connection), connectionId: 'connection-3', generation: 2 };
  fixture.setRuntime([firstActor, secondActor], [firstConnection, secondConnection]);
  await assert.rejects(register(fixture), errorCode('question_writer_ambiguous'));
});

test('writer resolution rejects when every matching actor is stale', async (t) => {
  const fixture = await createFixture(t);
  fixture.setRuntime([{ ...clone(fixture.actor), state: 'unknown' }], [
    { ...clone(fixture.connection), state: 'inactive' },
  ]);
  await assert.rejects(register(fixture), errorCode('question_writer_inactive'));
});
test('registration does not report success when its writer expires during journal persistence', async (t) => {
  let fixture;
  const atomicWrite = async (filePath, value) => {
    await atomicWriteJson(path.dirname(filePath), path.basename(filePath), value);
    if (fixture && value.questions.length === 1) fixture.invalidateWriter();
  };
  fixture = await createFixture(t, { atomicWrite });
  await assert.rejects(register(fixture), errorCode('question_writer_unverified'));
  const dashboard = await fixture.service.dashboardSnapshot();
  assert.equal(dashboard.questions.length, 1);
});
