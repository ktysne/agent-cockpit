'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { startServer } = require('../src/server/server');
const { atomicWriteJson } = require('../src/server/json-storage');
const { createInstructionHarness, PROVIDERS } = require('./support/instruction-harness');
const { jsonBody, request, uiHeaders } = require('./support/server');
const { temporaryHome } = require('./support/temp');

const ORIGIN = 'standalone';
const DIGEST = 'a'.repeat(64);
const SECOND_DIGEST = DIGEST;

function registrationView(harness, snapshotOverride) {
  const registry = harness.registrationRegistry;
  const snapshot = () => snapshotOverride ? snapshotOverride(registry) : registry.snapshot();
  return Object.freeze({
    snapshot,
    authorizeEvent: () => ({ ok: false, status: 'unverified' }),
    authorizeWriter: () => ({ ok: false, status: 'unverified' }),
    isRegisteredSessionId: (sessionId) => snapshot().executions.some((item) => item.sessionId === sessionId),
  });
}

function lateQuestion(harness) {
  const launch = harness.launch;
  return {
    internalQuestionId: 'common-question-internal-1',
    questionId: 'common-question-1',
    identity: launch.identity,
    periodId: launch.executionBinding.periodId,
    executionId: launch.executionBinding.periodId,
    conversationId: launch.conversationId,
    launchRef: launch.launchRef,
    revision: 3,
    createdAt: 1000,
    deadlineAt: 2000,
    held: false,
    selectionSource: 'manual',
    selectedAt: 1500,
    deliveryAttemptId: null,
    deliveryState: null,
    externalResolution: true,
    lateAnswerCount: 2,
    lateAnswerRefs: [
      { index: 0, digest: DIGEST, submittedAt: 1700 },
      { index: 1, digest: SECOND_DIGEST, submittedAt: 1800 },
    ],
    cancelled: false,
    cancelRequested: false,
    cancelHistoryMissing: false,
    questions: [],
  };
}

async function createRuntime(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-instruction-http-'));
  const harness = createInstructionHarness({
    provider: options.provider || 'codex',
    origin: options.origin || ORIGIN,
    state: options.state || (options.origin === 'delegated' ? 'working' : 'stopped'),
    directory: path.join(directory, 'delivery'),
    ...(options.autoAck !== undefined ? { autoAck: options.autoAck } : {}),
    ...(options.evidenceOnDispatch !== undefined ? { evidenceOnDispatch: options.evidenceOnDispatch } : {}),
    ...(options.atomicWrite ? { atomicWrite: options.atomicWrite } : {}),
  });
  await harness.ready();
  const temporary = temporaryHome(t, 'agent-cockpit-instruction-http-home-', { deferCleanup: true });
  const question = lateQuestion(harness);
  let draftReads = 0;
  let questionAnswerCalls = 0;
  const questionService = options.withQuestion ? {
    ready: async () => {},
    dashboardSnapshot: options.questionDashboardSnapshot
      ? () => options.questionDashboardSnapshot(harness)
      : async () => ({ version: 1, questions: [question], recovery: { status: 'ready' } }),
    submitAnswer: async () => { questionAnswerCalls += 1; return { outcome: 'selected', question }; },
    readLateAnswerDraft: async (internalQuestionId, index, digest) => {
      draftReads += 1;
      if (internalQuestionId !== question.internalQuestionId) return null;
      if (index === 0 && digest === DIGEST) {
        return { launchRef: harness.launch.launchRef, logicalMessageId: 'source-question-logical', revision: 3,
          text: '保存済みの後続回答本文' };
      }
      if (index === 1 && digest === SECOND_DIGEST) {
        return { launchRef: harness.launch.launchRef, logicalMessageId: 'source-question-logical-2', revision: 4,
          text: '保存済みの後続回答本文' };
      }
      return null;
    },
    close: async () => {},
  } : null;
  const instructionConfigured = options.withInstruction !== false;
  const instructionServiceConfigured = instructionConfigured && options.withInstructionService !== false;
  const instructionTargetsConfigured = instructionConfigured && options.withInstructionTargets !== false;
  const instructionService = !instructionServiceConfigured ? null : options.instructionServiceFactory
    ? options.instructionServiceFactory(harness.service)
    : harness.service;
  const runtime = await startServer({
    homeDir: temporary.homeDir,
    claudeHome: temporary.claudeHome,
    userHome: temporary.homeDir,
    port: 0,
    registrationRegistry: registrationView(harness, options.registrationSnapshot),
    launchRegistry: instructionTargetsConfigured ? harness.launchRegistry : null,
    instructionService,
    instructionTargetState: instructionTargetsConfigured ? (options.instructionTargetState || harness.targetState) : null,
    questionService,
  });
  t.after(async () => {
    await runtime.close();
    await harness.close();
    await temporary.cleanup();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { harness, runtime, question, draftReads: () => draftReads, questionAnswerCalls: () => questionAnswerCalls };
}

function post(runtime, pathname, body, origin = `http://127.0.0.1:${runtime.info.port}`) {
  return request(runtime.info.port, {
    method: 'POST',
    path: pathname,
    headers: uiHeaders(runtime.info, origin, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

function postWithoutOrigin(runtime, pathname, body) {
  return request(runtime.info.port, {
    method: 'POST',
    path: pathname,
    headers: uiHeaders(runtime.info, undefined, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

function postWithoutSecret(runtime, pathname, body) {
  return request(runtime.info.port, {
    method: 'POST',
    path: pathname,
    headers: { origin: `http://127.0.0.1:${runtime.info.port}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function startDroppablePost(runtime, pathname, body) {
  let finish;
  const completed = new Promise((resolve) => { finish = resolve; });
  const client = http.request({
    host: '127.0.0.1',
    port: runtime.info.port,
    method: 'POST',
    path: pathname,
    headers: uiHeaders(runtime.info, `http://127.0.0.1:${runtime.info.port}`, { 'content-type': 'application/json' }),
  }, (response) => {
    response.resume();
    response.on('end', () => finish('response'));
  });
  client.on('error', () => finish('closed'));
  client.end(JSON.stringify(body));
  return { abort: () => client.destroy(), completed };
}

async function waitForDeliveryState(harness, deliveryAttemptId, expected) {
  let latest;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    latest = await harness.service.get(deliveryAttemptId);
    if (latest?.delivery?.state === expected) return latest;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(`instruction did not reach ${expected}; last state was ${latest?.delivery?.state || 'missing'}`);
}

function createBody(harness, overrides = {}) {
  const delegated = harness.origin === 'delegated';
  return {
    session_id: harness.launch.sessionId,
    execution_id: harness.launch.executionBinding.periodId,
    launch_ref: harness.launch.launchRef,
    delivery_attempt_id: 'http-instruction-attempt',
    logical_message_id: 'http-instruction-logical',
    revision: 1,
    text: 'HTTP fixture instruction payload secret',
    mode: delegated ? 'steer' : 'start',
    expected_turn_id: delegated ? 'native-fixture-turn' : null,
    ...overrides,
  };
}

test('未構成の指示機能を診断状態で区別する', async (t) => {
  const { runtime } = await createRuntime(t, { withInstruction: false });
  const state = await request(runtime.info.port, { path: '/api/state' });
  assert.equal(state.status, 200);
  const snapshot = jsonBody(state);
  assert.deepEqual(snapshot.instructionDiagnostics, {
    configuration: 'unconfigured', service: 'unavailable', targets: 'unavailable',
  });
  assert.equal(snapshot.commonQuestionDiagnostics, undefined);
});

test('対象だけ構成された指示機能は未構成ではなく対象利用不能を診断する', async (t) => {
  const { runtime } = await createRuntime(t, { withInstructionService: false });
  const state = await request(runtime.info.port, { path: '/api/state' });
  assert.equal(state.status, 200);
  assert.deepEqual(jsonBody(state).instructionDiagnostics, {
    configuration: 'configured', service: 'unavailable', targets: 'available',
  });
});

test('構成済み指示サービスの起動失敗を診断に残す', async (t) => {
  const { runtime } = await createRuntime(t, {
    instructionServiceFactory: (service) => ({
      ready: async () => { throw new Error('service unavailable'); },
      dashboardSnapshot: () => service.dashboardSnapshot(),
      close: () => service.close(),
    }),
  });
  const state = await request(runtime.info.port, { path: '/api/state' });
  assert.equal(state.status, 200);
  const diagnostics = jsonBody(state).instructionDiagnostics;
  assert.equal(diagnostics.configuration, 'configured');
  assert.equal(diagnostics.service, 'unavailable');
  assert.equal(diagnostics.targets, 'available');
});

for (const [failureName, questionDashboardSnapshot] of [
  ['throws', async () => { throw new Error('private question snapshot details'); }],
  ['is malformed', async () => ({ version: 1, questions: { internalQuestionId: 'private-question-id' } })],
  ['contains malformed entries', async () => ({ version: 1, questions: [null] })],
]) {
  test(`question state ${failureName} without hiding other dashboard state`, async (t) => {
    const { harness, runtime } = await createRuntime(t, { withQuestion: true, questionDashboardSnapshot });
    const instructionBody = createBody(harness);
    const created = await post(runtime, '/api/instructions/create', instructionBody);
    assert.equal(created.status, 200);

    const state = await request(runtime.info.port, { path: '/api/state' });
    assert.equal(state.status, 200);
    const snapshot = jsonBody(state);
    assert.equal(Array.isArray(snapshot.sessions), true);
    assert.equal(Array.isArray(snapshot.pullRequests), true);
    assert.deepEqual(snapshot.instructionDiagnostics, {
      configuration: 'configured', service: 'ready', targets: 'available',
    });
    assert.deepEqual(snapshot.commonQuestionDiagnostics, {
      recovery: { status: 'unavailable', errorCode: 'common_question_state_unavailable' },
    });
    assert.equal(snapshot.sessions.some((session) =>
      session.instructions?.some((instruction) => instruction.deliveryAttemptId === instructionBody.delivery_attempt_id)), true);
    assert.equal(snapshot.sessions.some((session) => session.commonQuestions?.length), false);
    assert.equal(JSON.stringify(snapshot).includes('private question snapshot details'), false);
    assert.equal(JSON.stringify(snapshot).includes('private-question-id'), false);
  });
}

for (const [failureName, failedSnapshot] of [
  ['throws', () => { throw new Error('private registration snapshot details'); }],
  ['is malformed', () => ({ conversations: [], executions: null })],
  ['contains malformed entries', () => ({ conversations: [null], executions: [] })],
]) {
  test(`registration snapshot ${failureName} drops partial questions and preserves the next dashboard read`, async (t) => {
    let questionSnapshotRead = false;
    const questionDashboardSnapshot = async (harness) => {
      questionSnapshotRead = true;
      return { version: 1, questions: [{ ...lateQuestion(harness), identity: {
        ...harness.launch.identity, nativeId: 'private-question-native-id',
      } }], recovery: { status: 'ready' } };
    };
    const registrationSnapshot = (registry) => {
      if (questionSnapshotRead) {
        questionSnapshotRead = false;
        return failedSnapshot();
      }
      return registry.snapshot();
    };
    const { harness, runtime } = await createRuntime(t, {
      withQuestion: true,
      questionDashboardSnapshot,
      registrationSnapshot,
    });
    const instructionBody = createBody(harness);
    assert.equal((await post(runtime, '/api/instructions/create', instructionBody)).status, 200);

    const state = await request(runtime.info.port, { path: '/api/state' });
    assert.equal(state.status, 200);
    const snapshot = jsonBody(state);
    assert.deepEqual(snapshot.commonQuestionDiagnostics, {
      recovery: { status: 'unavailable', errorCode: 'common_question_state_unavailable' },
    });
    assert.equal(snapshot.sessions.some((session) => session.commonQuestions?.length), false);
    assert.equal(snapshot.sessions.some((session) =>
      session.instructions?.some((instruction) => instruction.deliveryAttemptId === instructionBody.delivery_attempt_id)), true);
    assert.deepEqual(snapshot.instructionDiagnostics, {
      configuration: 'configured', service: 'ready', targets: 'available',
    });
    assert.equal(JSON.stringify(snapshot).includes('common-question-internal-1'), false);
    assert.equal(JSON.stringify(snapshot).includes('private-question-native-id'), false);
    assert.equal(JSON.stringify(snapshot).includes('private registration snapshot details'), false);
  });
}

test('question writes remain authorized and fail closed when the dashboard snapshot is unavailable', async (t) => {
  const { harness, runtime, questionAnswerCalls } = await createRuntime(t, {
    withQuestion: true,
    questionDashboardSnapshot: async () => { throw new Error('private question snapshot details'); },
  });
  const pathname = '/api/decisions/cq-common-question-internal-1/answer';
  const body = {
    session_id: harness.launch.sessionId,
    execution_id: harness.launch.executionBinding.periodId,
    answers: [],
  };
  const unauthorized = await postWithoutSecret(runtime, pathname, body);
  assert.equal(unauthorized.status, 401);
  assert.equal(questionAnswerCalls(), 0);

  const unavailable = await post(runtime, pathname, body);
  assert.equal(unavailable.status, 503);
  assert.equal(questionAnswerCalls(), 0);
});

for (const provider of PROVIDERS) {
  for (const origin of ['standalone', 'delegated']) {
    test(`${provider} ${origin} instruction create is scoped, idempotent, and payload-free`, async (t) => {
      const { harness, runtime } = await createRuntime(t, { provider, origin });
      const body = createBody(harness);
      const created = await post(runtime, '/api/instructions/create', body);
      assert.equal(created.status, 200);
      assert.equal(jsonBody(created).outcome, 'created');
      assert.equal(jsonBody(created).instruction.state, 'available');
      assert.equal(JSON.stringify(jsonBody(created)).includes(body.text), false);

      const repeated = await post(runtime, '/api/instructions/create', body);
      assert.equal(repeated.status, 200);
      assert.equal(jsonBody(repeated).outcome, 'existing');
      assert.equal(harness.writes.length, 0);

      const wrongScope = await post(runtime, '/api/instructions/create', {
        ...body, delivery_attempt_id: 'other-attempt', session_id: 'other-session',
      });
      assert.equal(wrongScope.status, 403);
      const wrongExecution = await post(runtime, '/api/instructions/create', {
        ...body, delivery_attempt_id: 'other-execution-attempt', execution_id: 'other-execution',
      });
      assert.equal(wrongExecution.status, 403);

      const state = await request(runtime.info.port, { path: '/api/state' });
      assert.equal(state.status, 200);
      assert.equal(state.body.includes(body.text), false);
      assert.deepEqual({
        configuration: jsonBody(state).instructionDiagnostics.configuration,
        service: jsonBody(state).instructionDiagnostics.service,
        targets: jsonBody(state).instructionDiagnostics.targets,
      }, { configuration: 'configured', service: 'ready', targets: 'available' });
      const projection = jsonBody(state).sessions.find((item) => item.session_id === body.session_id)?.instructions?.[0];
      assert.ok(projection);
      assert.equal(projection.executionId, harness.launch.executionBinding.periodId);
      assert.equal(projection.registrationExecutionId, harness.launch.executionBinding.periodId);
      assert.equal(projection.state, 'available');
    });
  }
}

for (const provider of PROVIDERS) {
  test(`${provider} instruction send/cancel/alternative enforce UI scope and preserve file-backed states`, async (t) => {
    const { harness, runtime } = await createRuntime(t, { provider, origin: 'standalone' });
    const first = createBody(harness, { delivery_attempt_id: 'http-cancel-attempt', logical_message_id: 'http-cancel-logical' });
    const created = await post(runtime, '/api/instructions/create', first);
    assert.equal(created.status, 200);

    const sendPath = `/api/instructions/${first.delivery_attempt_id}/send`;
    const noSecretSend = await postWithoutSecret(runtime, sendPath, {
      session_id: first.session_id, execution_id: first.execution_id,
    });
    assert.equal(noSecretSend.status, 401);
    const missingOriginSend = await postWithoutOrigin(runtime, sendPath, {
      session_id: first.session_id, execution_id: first.execution_id,
    });
    assert.equal(missingOriginSend.status, 403);
    const wrongOriginSend = await post(runtime, sendPath, {
      session_id: first.session_id, execution_id: first.execution_id,
    }, 'https://outside.example');
    assert.equal(wrongOriginSend.status, 403);
    const extraSend = await post(runtime, sendPath, {
      session_id: first.session_id, execution_id: first.execution_id, text: 'ignored',
    });
    assert.equal(extraSend.status, 400);
    const wrongScopeSend = await post(runtime, sendPath, {
      session_id: 'another-session', execution_id: first.execution_id,
    });
    assert.equal(wrongScopeSend.status, 403);
    const wrongExecutionSend = await post(runtime, sendPath, {
      session_id: first.session_id, execution_id: 'another-execution',
    });
    assert.equal(wrongExecutionSend.status, 403);
    assert.equal(harness.writes.length, 0);

    const cancelPath = `/api/instructions/${first.delivery_attempt_id}/cancel`;
    const noSecretCancel = await postWithoutSecret(runtime, cancelPath, {
      session_id: first.session_id, execution_id: first.execution_id,
    });
    assert.equal(noSecretCancel.status, 401);
    const missingOriginCancel = await postWithoutOrigin(runtime, cancelPath, {
      session_id: first.session_id, execution_id: first.execution_id,
    });
    assert.equal(missingOriginCancel.status, 403);
    const wrongOriginCancel = await post(runtime, cancelPath, {
      session_id: first.session_id, execution_id: first.execution_id,
    }, 'https://outside.example');
    assert.equal(wrongOriginCancel.status, 403);
    const cancelExtra = await post(runtime, cancelPath, {
      session_id: first.session_id, execution_id: first.execution_id, cancel: true,
    });
    assert.equal(cancelExtra.status, 400);
    assert.equal((await post(runtime, cancelPath, {
      session_id: 'another-session', execution_id: first.execution_id,
    })).status, 403);
    assert.equal((await post(runtime, cancelPath, {
      session_id: first.session_id, execution_id: 'another-execution',
    })).status, 403);
    const cancelled = await post(runtime, cancelPath, {
      session_id: first.session_id, execution_id: first.execution_id,
    });
    assert.equal(cancelled.status, 200);
    assert.equal(jsonBody(cancelled).instruction.state, 'cancelled_before_send');
    assert.equal((await harness.service.get(first.delivery_attempt_id)).delivery.state, 'cancelled_before_send');
    assert.equal(harness.writes.length, 0);

    const parent = createBody(harness, {
      delivery_attempt_id: 'http-alternative-parent', logical_message_id: 'http-alternative-logical', revision: 2,
    });
    assert.equal((await post(runtime, '/api/instructions/create', parent)).status, 200);
    const alternativePath = `/api/instructions/${parent.delivery_attempt_id}/alternative`;
    const alternative = {
      session_id: parent.session_id,
      execution_id: parent.execution_id,
      new_delivery_attempt_id: 'http-alternative-next',
      logical_message_id: parent.logical_message_id,
      revision: parent.revision + 1,
      text: '次に送る内容',
      mode: 'next-user-input',
      expected_turn_id: null,
    };
    const noSecretAlternative = await postWithoutSecret(runtime, alternativePath, alternative);
    assert.equal(noSecretAlternative.status, 401);
    const missingOriginAlternative = await postWithoutOrigin(runtime, alternativePath, alternative);
    assert.equal(missingOriginAlternative.status, 403);
    const wrongOriginAlternative = await post(runtime, alternativePath, alternative, 'https://outside.example');
    assert.equal(wrongOriginAlternative.status, 403);
    const extraAlternative = await post(runtime, alternativePath, { ...alternative, extra: true });
    assert.equal(extraAlternative.status, 400);
    assert.equal((await post(runtime, alternativePath, {
      ...alternative, session_id: 'another-session', new_delivery_attempt_id: 'wrong-scope-session',
    })).status, 403);
    assert.equal((await post(runtime, alternativePath, {
      ...alternative, execution_id: 'another-execution', new_delivery_attempt_id: 'wrong-scope-execution',
    })).status, 403);
    assert.equal((await harness.service.get(parent.delivery_attempt_id)).delivery.state, 'available');
    const replaced = await post(runtime, alternativePath, alternative);
    assert.equal(replaced.status, 200);
    const alternativeInstruction = jsonBody(replaced).instruction;
    assert.equal(alternativeInstruction.deliveryAttemptId, alternative.new_delivery_attempt_id);
    assert.equal(alternativeInstruction.state, 'available');
    assert.equal(alternativeInstruction.mode, 'next-user-input');
    assert.equal(alternativeInstruction.nativeTurnId, null);
    assert.equal(alternativeInstruction.launchRef, parent.launch_ref);
    assert.equal(alternativeInstruction.executionId, parent.execution_id);
    assert.equal(alternativeInstruction.logicalMessageId, parent.logical_message_id);
    assert.equal(alternativeInstruction.revision, alternative.revision);
    assert.equal((await harness.service.get(parent.delivery_attempt_id)).delivery.state, 'superseded_before_send');
    assert.equal(harness.writes.length, 0);

    const alternativeSend = await post(runtime,
      `/api/instructions/${alternative.new_delivery_attempt_id}/send`, {
        session_id: alternative.session_id, execution_id: alternative.execution_id,
      });
    assert.equal(alternativeSend.status, 200);
    const acceptedAlternative = await waitForDeliveryState(harness, alternative.new_delivery_attempt_id, 'accepted');
    assert.equal(acceptedAlternative.instruction.mode, 'next-user-input');
    assert.equal(acceptedAlternative.instruction.launchRef, parent.launch_ref);
    assert.equal(acceptedAlternative.instruction.executionId, parent.execution_id);
    assert.equal(acceptedAlternative.instruction.logicalMessageId, parent.logical_message_id);
    assert.equal(acceptedAlternative.instruction.revision, alternative.revision);
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.writes[0].mode, 'next-user-input');
    assert.equal(harness.writes[0].expectedTurnId, null);
    assert.equal(harness.writes[0].revision, alternative.revision);
    assert.equal(harness.writes[0].source.launchRef, parent.launch_ref);
    assert.equal(harness.writes[0].target.periodId, parent.execution_id);
    assert.equal(acceptedAlternative.delivery.state, 'accepted');

    const oldSend = await post(runtime, `/api/instructions/${parent.delivery_attempt_id}/send`, {
      session_id: parent.session_id, execution_id: parent.execution_id,
    });
    assert.equal(oldSend.status, 409);
    assert.equal((await harness.service.get(parent.delivery_attempt_id)).delivery.state, 'superseded_before_send');
    assert.equal(harness.writes.length, 1);
  });
}

for (const provider of PROVIDERS) {
  test(`${provider} working standalone steer is sent once and applies only after input evidence`, async (t) => {
    const { harness, runtime } = await createRuntime(t, {
      provider, origin: 'standalone', state: 'working', evidenceOnDispatch: false,
    });
    const body = createBody(harness, {
      delivery_attempt_id: `http-standalone-steer-${provider}`,
      logical_message_id: `http-standalone-steer-logical-${provider}`,
      mode: 'steer',
      expected_turn_id: 'native-fixture-turn',
    });
    const created = await post(runtime, '/api/instructions/create', body);
    assert.equal(created.status, 200);
    assert.equal(jsonBody(created).instruction.mode, 'steer');
    const sendPath = `/api/instructions/${body.delivery_attempt_id}/send`;
    const sent = await post(runtime, sendPath, { session_id: body.session_id, execution_id: body.execution_id });
    assert.equal(sent.status, 200);
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.writes[0].mode, 'steer');
    assert.equal(harness.writes[0].expectedTurnId, 'native-fixture-turn');

    const accepted = await waitForDeliveryState(harness, body.delivery_attempt_id, 'accepted');
    assert.equal(accepted.delivery.state, 'accepted');
    assert.equal(harness.owner.emitInputEvidence(body.delivery_attempt_id), true);
    assert.equal((await waitForDeliveryState(harness, body.delivery_attempt_id, 'applied')).delivery.state, 'applied');

    const repeated = await post(runtime, sendPath, { session_id: body.session_id, execution_id: body.execution_id });
    assert.equal(repeated.status, 409);
    assert.equal(harness.writes.length, 1);
  });
}

for (const provider of PROVIDERS) {
  test(`${provider} file-backed send remains accepted until evidence and duplicate send never dispatches twice`, async (t) => {
    const { harness, runtime } = await createRuntime(t, {
      provider, origin: 'delegated', state: 'working', evidenceOnDispatch: false,
    });
    const body = createBody(harness, { delivery_attempt_id: 'http-accepted-attempt', logical_message_id: 'http-accepted-logical' });
    assert.equal((await post(runtime, '/api/instructions/create', body)).status, 200);
    const sendPath = `/api/instructions/${body.delivery_attempt_id}/send`;
    const sent = await post(runtime, sendPath, { session_id: body.session_id, execution_id: body.execution_id });
    assert.equal(sent.status, 200);
    assert.equal(harness.writes.length, 1);
    const accepted = await waitForDeliveryState(harness, body.delivery_attempt_id, 'accepted');
    assert.equal(accepted.delivery.state, 'accepted');
    assert.equal((await harness.service.get(body.delivery_attempt_id)).delivery.state, 'accepted');
    const repeated = await post(runtime, sendPath, { session_id: body.session_id, execution_id: body.execution_id });
    assert.equal(repeated.status, 409);
    assert.equal(harness.writes.length, 1);
  });
}

test('waiting target and a lost HTTP response leave no retry path or duplicate dispatch', async (t) => {
  const { harness: waitingHarness, runtime: waitingRuntime } = await createRuntime(t, { provider: 'claude' });
  const waitingBody = createBody(waitingHarness, {
    delivery_attempt_id: 'http-waiting-attempt', logical_message_id: 'http-waiting-logical',
  });
  assert.equal((await post(waitingRuntime, '/api/instructions/create', waitingBody)).status, 200);
  waitingHarness.owner.setState('waiting');
  const waitingSend = await post(waitingRuntime, `/api/instructions/${waitingBody.delivery_attempt_id}/send`, {
    session_id: waitingBody.session_id, execution_id: waitingBody.execution_id,
  });
  assert.equal(waitingSend.status, 409);
  assert.equal((await waitingHarness.service.get(waitingBody.delivery_attempt_id)).delivery.state, 'available');
  assert.equal(waitingHarness.writes.length, 0);

  let holdSending = false;
  let markSendingStarted;
  const sendingStarted = new Promise((resolve) => { markSendingStarted = resolve; });
  let releaseSending;
  const sendingGate = new Promise((resolve) => { releaseSending = resolve; });
  const atomicWrite = async (target, value) => {
    if (holdSending && value.ledger.deliveries.some((item) =>
      item.deliveryAttemptId === 'http-lost-attempt' && item.state === 'sending')) {
      holdSending = false;
      markSendingStarted();
      await sendingGate;
    }
    await atomicWriteJson(path.dirname(target), path.basename(target), value);
  };
  const { harness, runtime } = await createRuntime(t, {
    provider: 'codex', atomicWrite, autoAck: false,
  });
  const body = createBody(harness, { delivery_attempt_id: 'http-lost-attempt', logical_message_id: 'http-lost-logical' });
  assert.equal((await post(runtime, '/api/instructions/create', body)).status, 200);
  holdSending = true;
  const pending = startDroppablePost(runtime, `/api/instructions/${body.delivery_attempt_id}/send`, {
    session_id: body.session_id, execution_id: body.execution_id,
  });
  const timeout = setTimeout(() => { throw new Error('sending checkpoint did not start'); }, 5000);
  await sendingStarted;
  clearTimeout(timeout);
  pending.abort();
  releaseSending();
  await pending.completed;
  const unknown = await waitForDeliveryState(harness, body.delivery_attempt_id, 'unknown');
  assert.equal(unknown.delivery.state, 'unknown');
  assert.equal(harness.writes.length, 0);
  const retry = await post(runtime, `/api/instructions/${body.delivery_attempt_id}/send`, {
    session_id: body.session_id, execution_id: body.execution_id,
  });
  assert.equal(retry.status, 409);
  assert.equal((await harness.service.get(body.delivery_attempt_id)).delivery.state, 'unknown');
  assert.equal(harness.writes.length, 0);
});

test('HTTP target projection accepts only bounded question and approval counts', async (t) => {
  let projected = {
    status: 'waiting', nativeTurnId: 'native-turn-1', reason: 'native_request_pending',
    nativeWaiting: [{ kind: 'question', count: 1 }, { kind: 'approval', count: 1 }],
  };
  const { runtime } = await createRuntime(t, { instructionTargetState: () => projected });
  const stateForTarget = async () => {
    const response = await request(runtime.info.port, { path: '/api/state' });
    assert.equal(response.status, 200);
    return jsonBody(response).instructionTargets[0];
  };

  assert.deepEqual((await stateForTarget()).nativeWaiting, projected.nativeWaiting);
  const invalidTargets = [
    { ...projected, nativeWaiting: [{ kind: 'question', count: 129 }] },
    { ...projected, nativeWaiting: [{ kind: 'question', count: 1, requestId: 'private-request' }] },
    { ...projected, nativeWaiting: [{ kind: 'question', count: 1 }, { kind: 'question', count: 1 }] },
    { ...projected, nativeWaiting: [{ kind: 'question', count: 1 }, { kind: 'approval', count: 128 }] },
    { ...projected, privateField: 'private-value' },
  ];
  for (const invalid of invalidTargets) {
    projected = invalid;
    const target = await stateForTarget();
    assert.equal(target.status, 'unverified');
    assert.equal(Object.hasOwn(target, 'nativeWaiting'), false);
    assert.equal(JSON.stringify(target).includes('private'), false);
  }
});

test('an HTTP response lost after native dispatch leaves unknown and cannot dispatch again', async (t) => {
  let sendReachedResponseGate;
  const sendResponseReached = new Promise((resolve) => { sendReachedResponseGate = resolve; });
  let releaseSendResponse;
  const sendResponseGate = new Promise((resolve) => { releaseSendResponse = resolve; });
  const { harness, runtime } = await createRuntime(t, {
    provider: 'codex', origin: 'standalone', autoAck: false,
    instructionServiceFactory: (service) => ({
      ready: () => service.ready(),
      create: (input) => service.create(input),
      send: async (id) => {
        const result = await service.send(id);
        sendReachedResponseGate();
        await sendResponseGate;
        return result;
      },
      cancel: (id) => service.cancel(id),
      supersedeUnsent: (id, input) => service.supersedeUnsent(id, input),
      get: (id) => service.get(id),
      dashboardSnapshot: () => service.dashboardSnapshot(),
      reportResponseLost: (id) => service.reportResponseLost(id),
      flush: () => service.flush(),
      close: () => service.close(),
    }),
  });
  t.after(() => releaseSendResponse());
  const body = createBody(harness, {
    delivery_attempt_id: 'http-after-write-loss', logical_message_id: 'http-after-write-loss-logical',
  });
  assert.equal((await post(runtime, '/api/instructions/create', body)).status, 200);

  const pending = startDroppablePost(runtime, `/api/instructions/${body.delivery_attempt_id}/send`, {
    session_id: body.session_id, execution_id: body.execution_id,
  });
  const timeout = setTimeout(() => { throw new Error('native dispatch did not return to the HTTP response gate'); }, 5000);
  await sendResponseReached;
  clearTimeout(timeout);
  assert.equal(harness.writes.length, 1);
  assert.equal((await harness.service.get(body.delivery_attempt_id)).delivery.state, 'sending');

  pending.abort();
  assert.equal(await pending.completed, 'closed');
  releaseSendResponse();
  const unknown = await waitForDeliveryState(harness, body.delivery_attempt_id, 'unknown');
  assert.equal(unknown.delivery.state, 'unknown');
  assert.equal(harness.writes.length, 1);

  const retry = await post(runtime, `/api/instructions/${body.delivery_attempt_id}/send`, {
    session_id: body.session_id, execution_id: body.execution_id,
  });
  assert.equal(retry.status, 409);
  assert.equal((await harness.service.get(body.delivery_attempt_id)).delivery.state, 'unknown');
  assert.equal(harness.writes.length, 1);
});

test('late-answer HTTP stub conversion is idempotent by tuple and creates an unsent instruction', async (t) => {
  const { harness, runtime, question, draftReads } = await createRuntime(t, {
    provider: 'codex', origin: 'standalone', withQuestion: true,
  });
  const route = `/api/decisions/${encodeURIComponent(question.internalQuestionId)}/late-instruction`;
  const body = {
    session_id: harness.launch.sessionId,
    execution_id: harness.launch.executionBinding.periodId,
    index: 0,
    digest: 'b'.repeat(64),
    mode: 'start',
    expected_turn_id: null,
  };
  const mismatch = await post(runtime, route, body);
  assert.equal(mismatch.status, 404);
  assert.equal(draftReads(), 0);
  assert.equal(harness.writes.length, 0);

  const converted = await post(runtime, route, { ...body, digest: DIGEST });
  assert.equal(converted.status, 200);
  assert.equal(jsonBody(converted).outcome, 'created');
  assert.equal(jsonBody(converted).instruction.state, 'available');
  const firstId = jsonBody(converted).instruction.deliveryAttemptId;
  const firstLogicalId = jsonBody(converted).instruction.logicalMessageId;
  assert.equal(JSON.stringify(jsonBody(converted)).includes('保存済みの後続回答本文'), false);
  assert.equal(draftReads(), 1);
  assert.equal(harness.writes.length, 0);

  const repeated = await post(runtime, route, { ...body, digest: DIGEST });
  assert.equal(repeated.status, 200);
  assert.equal(jsonBody(repeated).outcome, 'existing');
  assert.equal(jsonBody(repeated).instruction.deliveryAttemptId, firstId);
  assert.equal(draftReads(), 2);

  const second = await post(runtime, route, { ...body, index: 1, digest: SECOND_DIGEST });
  assert.equal(second.status, 200);
  assert.equal(jsonBody(second).outcome, 'created');
  assert.notEqual(jsonBody(second).instruction.deliveryAttemptId, firstId);
  assert.equal(jsonBody(second).instruction.state, 'available');
  assert.notEqual(jsonBody(second).instruction.logicalMessageId, firstLogicalId);
  assert.equal(JSON.stringify(jsonBody(second)).includes('保存済みの後続回答本文'), false);
  assert.equal(draftReads(), 3);
  assert.equal((await harness.service.dashboardSnapshot()).instructions.length, 2);
  assert.equal(harness.writes.length, 0);

  const state = await request(runtime.info.port, { path: '/api/state' });
  assert.equal(state.status, 200);
  assert.equal(state.body.includes('保存済みの後続回答本文'), false);
  assert.equal(jsonBody(state).sessions.find((item) => item.session_id === harness.launch.sessionId)
    .commonQuestions[0].deliveryState, null);
});

test('instruction create requires the UI secret, local Origin, and exact body fields', async (t) => {
  const { harness, runtime } = await createRuntime(t, { provider: 'claude', origin: 'standalone' });
  const body = createBody(harness);
  const missingSecret = await postWithoutSecret(runtime, '/api/instructions/create', body);
  assert.equal(missingSecret.status, 401);
  const missingOrigin = await postWithoutOrigin(runtime, '/api/instructions/create', body);
  assert.equal(missingOrigin.status, 403);
  const otherOrigin = await post(runtime, '/api/instructions/create', body, 'https://outside.example');
  assert.equal(otherOrigin.status, 403);
  const extra = await post(runtime, '/api/instructions/create', { ...body, unexpected: true });
  assert.equal(extra.status, 400);
  assert.equal(harness.writes.length, 0);
});
