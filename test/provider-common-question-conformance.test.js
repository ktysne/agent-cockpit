'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { startMcpServer } = require('../src/mcp/server');
const { startServer } = require('../src/server/server');
const { DEFAULT_MAX_CHECKPOINT_BYTES } = require('../src/server/durable-checkpoint');
const { readNativeRecoverySnapshot } = require('../src/server/durable-delivery-store');
const { atomicWriteJson } = require('../src/server/json-storage');
const { createCommonQuestionProductHarness, PROVIDERS } = require('./support/common-question-product-harness');
const { jsonBody, request } = require('./support/server');

const QUESTION_ROUTE = '/api/sessions/pending/questions';

function question(id, options = {}) {
  return {
    id,
    text: 'Choose an option for ' + id,
    mode: options.mode || 'single',
    options: options.options === undefined ? [{ id: 'a', label: 'Option A', description: '' }] : options.options,
    allowFreeText: options.allowFreeText ?? false,
    recommendedOptionId: options.recommendedOptionId ?? null,
  };
}

function questionRegistration(writer, questionId, questions = [question('choice')], extra = {}) {
  return { writer, questionId, questions, timeoutMinutes: 1, ...extra };
}

function questionAnswer(questionId, optionIds = ['a'], freeText = null) {
  return { questionId, optionIds, freeText };
}

function fixtureEvidence(evidenceId) {
  return {
    evidenceId,
    source: 'authenticated-test-fixture',
    method: 'product-conformance-fixture',
    adapterVersion: 'fixture-adapter-1',
    runtimeVersion: 'fixture-runtime-1',
    capabilities: ['native-binding'],
  };
}

function observeService(service, calls) {
  return Object.freeze({
    ready: service.ready.bind(service),
    register: service.register.bind(service),
    status: service.status.bind(service),
    dashboardSnapshot: service.dashboardSnapshot.bind(service),
    submitAnswer: service.submitAnswer.bind(service),
    hold: service.hold.bind(service),
    cancel: service.cancel.bind(service),
    reportResponseLost: (internalQuestionId) => {
      calls.responseLost += 1;
      return service.reportResponseLost(internalQuestionId);
    },
    answerPoll: (writer, questionId, sink) => {
      calls.answerPoll += 1;
      return service.answerPoll(writer, questionId, (answers, metadata) => {
        calls.sinks += 1;
        return sink(answers, metadata);
      });
    },
    flush: service.flush.bind(service),
    close: service.close.bind(service),
  });
}

async function createProductContext(t, provider, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'common-question-product-' + provider + '-'));
  const context = {
    directory,
    harness: null,
    runtime: null,
    calls: null,
    applicationHome: path.join(directory, 'application-home'),
    claudeHome: path.join(directory, 'claude-home'),
    userHome: path.join(directory, 'user-home'),
  };
  t.after(async () => {
    await context.runtime?.close().catch(() => {});
    await context.harness?.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  context.harness = await createCommonQuestionProductHarness({
    provider,
    directory: path.join(directory, 'fixture'),
    ...options.harnessOptions,
  });
  await startProductServer(context);
  return context;
}

async function startProductServer(context) {
  context.calls = { answerPoll: 0, sinks: 0, responseLost: 0 };
  context.runtime = await startServer({
    homeDir: context.applicationHome,
    claudeHome: context.claudeHome,
    userHome: context.userHome,
    port: 0,
    registrationRegistry: context.harness.registrationKernel.registry,
    questionService: observeService(context.harness.questionService, context.calls),
    away: context.harness.away,
  });
  return context.runtime;
}

async function stopProductServer(context) {
  const runtime = context.runtime;
  context.runtime = null;
  if (runtime) await runtime.close();
}

function requestHeaders(runtime, origin = undefined) {
  return {
    'content-type': 'application/json',
    'x-cockpit-secret': runtime.info.secret,
    ...(origin === undefined ? {} : { origin }),
  };
}

function uiHeaders(runtime, origin = `http://127.0.0.1:${runtime.info.port}`) {
  return { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin };
}

async function postProduct(context, route, body, headers = requestHeaders(context.runtime)) {
  return request(context.runtime.info.port, {
    method: 'POST', path: route, headers, body: JSON.stringify(body),
  });
}

async function getDashboardQuestion(context, questionId) {
  const snapshot = await context.harness.questionService.dashboardSnapshot();
  return snapshot.questions.find((item) => item.questionId === questionId);
}

function mcpOptions(context) {
  const identity = context.harness.primary.child.identity;
  return {
    homeDir: context.applicationHome,
    environment: { CLAUDE_CODE_SESSION_ID: identity.nativeId },
    getWriter: () => structuredClone(context.harness.writer),
  };
}

async function mcpExchange(requests, options, output = new PassThrough()) {
  const input = new PassThrough();
  let text = '';
  output.setEncoding?.('utf8');
  output.on?.('data', (chunk) => { text += chunk; });
  const running = startMcpServer({ input, output, ...options });
  input.end(requests.map((item) => JSON.stringify(item)).join('\n') + '\n');
  await running;
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function mcpCall(id, name, args, provider, nativeId) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: {
      name,
      arguments: args,
      ...(provider === 'codex' ? { _meta: { provider, threadId: nativeId } } : {}),
    },
  };
}

async function registerOverMcp(context, questionId, questions = [question('choice')]) {
  const writer = context.harness.writer;
  const responses = await mcpExchange([mcpCall(1, 'cockpit_register_question', {
    questionId, questions, timeoutMinutes: 1,
  }, context.harness.provider, writer.identity.nativeId)], mcpOptions(context));
  assert.equal(responses[0].result.isError, undefined);
  assert.ok(!JSON.stringify(responses).includes(questions[0].text));
  return responses[0];
}

async function answerOverUi(context, questionId, answers) {
  const dashboardQuestion = await getDashboardQuestion(context, questionId);
  assert.ok(dashboardQuestion, questionId);
  const response = await postProduct(context, `/api/decisions/${encodeURIComponent(dashboardQuestion.internalQuestionId)}/answer`, {
    session_id: context.harness.primary.child.registration.sessionId,
    execution_id: dashboardQuestion.executionId,
    answers,
  }, uiHeaders(context.runtime));
  return { dashboardQuestion, response };
}

async function answerOverMcp(context, questionId, output = new PassThrough()) {
  return mcpExchange([mcpCall(1, 'cockpit_answer_poll', { questionId },
    context.harness.provider, context.harness.writer.identity.nativeId)], mcpOptions(context), output);
}

for (const provider of PROVIDERS) {
  test(`ID-F07-A01/A02: ${provider} は質問を期間とidentityへ固定し、認証・選択をHTTPで分離する`, { timeout: 5000 }, async (t) => {
    const context = await createProductContext(t, provider);
    const writer = context.harness.writer;
    const questionId = 'same-public-id';
    const form = [
      question('choice', { allowFreeText: true }),
      question('multi', { mode: 'multi', options: [
        { id: 'a', label: 'Option A', description: '' },
        { id: 'b', label: 'Option B', description: '' },
        { id: 'c', label: 'Option C', description: '' },
      ] }),
    ];
    const body = questionRegistration(writer, questionId, form);

    const badSecret = await postProduct(context, QUESTION_ROUTE + '/register', body,
      { ...requestHeaders(context.runtime), 'x-cockpit-secret': 'incorrect' });
    const badOrigin = await postProduct(context, QUESTION_ROUTE + '/register', body,
      requestHeaders(context.runtime, 'https://untrusted.example'));
    assert.equal(badSecret.status, 401);
    assert.equal(badOrigin.status, 403);

    const registered = await postProduct(context, QUESTION_ROUTE + '/register', body);
    assert.equal(registered.status, 200, registered.body);
    assert.equal(jsonBody(registered).outcome, 'created');
    const firstInternalId = jsonBody(registered).question.internalQuestionId;
    const pendingPoll = await postProduct(context, QUESTION_ROUTE + '/answer-poll', { writer, questionId });
    assert.equal(pendingPoll.status, 200);
    assert.equal(jsonBody(pendingPoll).delivery, null);
    assert.equal((await postProduct(context, QUESTION_ROUTE + '/response-lost', { writer, questionId })).status, 404);
    const replay = await postProduct(context, QUESTION_ROUTE + '/register', body);
    assert.equal(jsonBody(replay).outcome, 'existing');
    assert.equal(jsonBody(replay).question.internalQuestionId, firstInternalId);
    const conflict = await postProduct(context, QUESTION_ROUTE + '/register', questionRegistration(
      writer, questionId, [question('choice', { allowFreeText: false })],
    ));
    assert.equal(conflict.status, 409);
    const unknownFormat = await postProduct(context, QUESTION_ROUTE + '/register', questionRegistration(
      writer, 'unknown-format', [question('unknown', { mode: 'unsupported' })],
    ));
    assert.equal(unknownFormat.status, 400);
    assert.equal((await getDashboardQuestion(context, 'unknown-format')), undefined);

    const secondHomeIdentity = {
      ...context.harness.primary.child.identity,
      homeScopeId: 'other-home-scope-' + provider,
    };
    const secondHome = context.harness.createExecution('other-home-' + provider, secondHomeIdentity, { resume: false });
    assert.equal(secondHome.child.identity.nativeId, writer.identity.nativeId);
    assert.notEqual(secondHome.child.identity.homeScopeId, writer.identity.homeScopeId);
    const secondHomeRegistration = await postProduct(context, QUESTION_ROUTE + '/register',
      questionRegistration(secondHome.child.writer, questionId, form));
    assert.equal(jsonBody(secondHomeRegistration).outcome, 'created');
    const secondHomeId = jsonBody(secondHomeRegistration).question.internalQuestionId;
    assert.notEqual(secondHomeId, firstInternalId);
    assert.equal((await postProduct(context, QUESTION_ROUTE + '/status', {
      writer, questionId,
    })).status, 200);
    assert.equal(jsonBody(await postProduct(context, QUESTION_ROUTE + '/status', {
      writer: secondHome.child.writer, questionId,
    })).internalQuestionId, secondHomeId);
    const secondHomeSave = await postProduct(context, '/api/decisions/' + encodeURIComponent(secondHomeId) + '/answer', {
      session_id: secondHome.child.registration.sessionId,
      execution_id: secondHome.child.registration.executionId,
      answers: [questionAnswer('choice', ['a'], 'other-home-private'), questionAnswer('multi', ['a', 'c'])],
    }, uiHeaders(context.runtime));
    assert.equal(secondHomeSave.status, 200, secondHomeSave.body);
    assert.deepEqual((await getDashboardQuestion(context, questionId)).selectedOptionIds, []);
    const secondHomeDashboard = await context.harness.questionService.dashboardSnapshot();
    const secondHomeProjection = secondHomeDashboard.questions.find((item) => item.internalQuestionId === secondHomeId);
    assert.deepEqual(secondHomeProjection.selectedOptionIds, [
      { questionId: 'choice', optionIds: ['a'] },
      { questionId: 'multi', optionIds: ['a', 'c'] },
    ]);
    assert.equal(JSON.stringify(secondHomeDashboard).includes('other-home-private'), false);

    context.harness.registrationKernel.authority.end(context.harness.primary.child.registration.executionId);
    const resumed = context.harness.createExecution('resumed-period-' + provider,
      structuredClone(context.harness.primary.child.identity), { resume: true });
    const resumedRegistration = await postProduct(context, QUESTION_ROUTE + '/register',
      questionRegistration(resumed.child.writer, questionId, form));
    assert.equal(jsonBody(resumedRegistration).outcome, 'created');
    const resumedId = jsonBody(resumedRegistration).question.internalQuestionId;
    assert.notEqual(resumedId, firstInternalId);
    assert.notEqual(jsonBody(resumedRegistration).question.executionId,
      jsonBody(registered).question.executionId);
    const staleWrite = await postProduct(context, QUESTION_ROUTE + '/register', body);
    assert.equal(staleWrite.status, 403);

    const stateResponse = await request(context.runtime.info.port, { path: '/api/state' });
    assert.equal(stateResponse.status, 200);
    const state = jsonBody(stateResponse);
    const sessionRow = state.sessions.find((session) => session.session_id === resumed.child.registration.sessionId);
    assert.ok(sessionRow, 'questions-only session should receive a canonical dashboard row');
    const resumedView = sessionRow.commonQuestions.find((item) => item.executionId === resumed.child.registration.executionId);
    assert.ok(resumedView);
    assert.equal(resumedView.sessionId, resumed.child.registration.sessionId);
    assert.deepEqual(resumedView.questions, form);
    assert.equal(JSON.stringify(state).includes('freeText'), false);

    const saved = await postProduct(context, `/api/decisions/${encodeURIComponent(resumedId)}/answer`, {
      session_id: resumed.child.registration.sessionId,
      execution_id: resumed.child.registration.executionId,
      answers: [
        questionAnswer('choice', ['a'], 'private-choice-value'),
        questionAnswer('multi', ['a', 'c']),
      ],
    }, uiHeaders(context.runtime));
    assert.equal(saved.status, 200);
    assert.equal(jsonBody(saved).outcome, 'selected');

    const beforeOriginRequests = { ...context.calls };
    const selfOriginHeaders = requestHeaders(context.runtime, `http://127.0.0.1:${context.runtime.info.port}`);
    const selfOriginRequests = [
      [QUESTION_ROUTE + '/register', questionRegistration(
        resumed.child.writer, 'self-origin-' + provider, [question('private-origin-question')],
      )],
      [QUESTION_ROUTE + '/status', { writer: resumed.child.writer, questionId }],
      [QUESTION_ROUTE + '/answer-poll', { writer: resumed.child.writer, questionId }],
      [QUESTION_ROUTE + '/response-lost', { writer: resumed.child.writer, questionId }],
    ];
    for (const [route, body] of selfOriginRequests) {
      const response = await postProduct(context, route, body, selfOriginHeaders);
      assert.equal(response.status, 403, route);
      assert.equal(JSON.stringify(response).includes('private-choice-value'), false, route);
      assert.equal(JSON.stringify(response).includes('private-origin-question'), false, route);
    }
    assert.deepEqual(context.calls, beforeOriginRequests);

    const status = await postProduct(context, QUESTION_ROUTE + '/status', {
      writer: resumed.child.writer, questionId,
    });
    assert.equal(status.status, 200);
    assert.equal(JSON.stringify(jsonBody(status)).includes('private-choice-value'), false);
    const selectedDashboard = await context.harness.questionService.dashboardSnapshot();
    const selectedQuestion = selectedDashboard.questions.find((item) => item.internalQuestionId === resumedId);
    assert.deepEqual(selectedQuestion.selectedOptionIds, [
      { questionId: 'choice', optionIds: ['a'] },
      { questionId: 'multi', optionIds: ['a', 'c'] },
    ]);
    const selectedState = jsonBody(await request(context.runtime.info.port, { path: '/api/state' }));
    assert.equal(JSON.stringify(selectedState).includes('private-choice-value'), false);
  });

  test(`ID-F07-A03/A04/A05: ${provider} は再open後に保存済み質問を隔離し送信しない`, { timeout: 5000 }, async (t) => {
    const context = await createProductContext(t, provider);
    const questionId = 'send-once-' + provider;
    const textSecret = 'private-answer-' + provider;
    await registerOverMcp(context, questionId, [question('choice', { allowFreeText: true })]);
    const info = await getDashboardQuestion(context, questionId);
    const save = await answerOverUi(context, questionId, [questionAnswer('choice', ['a'], textSecret)]);
    assert.equal(save.response.status, 200);
    assert.ok(!JSON.stringify(await context.harness.deliveryStore.snapshot()).includes(textSecret));

    const statusResponses = await mcpExchange([
      mcpCall(1, 'cockpit_question_status', { questionId }, provider, context.harness.writer.identity.nativeId),
    ], mcpOptions(context));
    assert.equal(statusResponses[0].result.isError, undefined);
    assert.equal(JSON.stringify(statusResponses).includes(textSecret), false);

    const firstPoll = await answerOverMcp(context, questionId);
    const firstPayload = JSON.parse(firstPoll[0].result.content[0].text);
    assert.ok(firstPayload.deliveryAttemptId);
    assert.equal(firstPayload.answers[0].freeText, textSecret);
    assert.equal(context.calls.sinks, 1);
    const deliveryAttemptId = firstPayload.deliveryAttemptId;
    const deliveryAfterSend = await context.harness.deliveryStore.get(deliveryAttemptId);
    assert.equal(deliveryAfterSend.state, 'sending');
    assert.equal(context.calls.answerPoll, 1);

    const tooLate = await postProduct(context, `/api/decisions/${encodeURIComponent(info.internalQuestionId)}/cancel`, {
      session_id: context.harness.primary.child.registration.sessionId,
      execution_id: info.executionId,
    }, uiHeaders(context.runtime));
    assert.equal(tooLate.status, 200);
    assert.equal(jsonBody(tooLate).outcome, 'too_late');

    const secondPoll = await answerOverMcp(context, questionId);
    assert.equal(JSON.stringify(secondPoll).includes(textSecret), false);
    assert.equal(context.calls.sinks, 1);
    assert.equal(context.calls.answerPoll, 2);

    const lostId = 'stdio-response-loss-' + provider;
    await registerOverMcp(context, lostId, [question('choice', { allowFreeText: true })]);
    const lostSave = await answerOverUi(context, lostId,
      [questionAnswer('choice', ['a'], 'stdio-private-' + provider)]);
    assert.equal(lostSave.response.status, 200);
    const lostDeliveryId = (await getDashboardQuestion(context, lostId)).deliveryAttemptId;
    const failedOutput = new Writable({ write(_chunk, _encoding, callback) {
      callback(new Error('MCP response channel failed'));
    } });
    const lostResponse = await answerOverMcp(context, lostId, failedOutput);
    assert.deepEqual(lostResponse, []);
    assert.equal(context.calls.sinks, 2);
    assert.equal(context.calls.responseLost, 1);
    assert.equal((await context.harness.deliveryStore.get(lostDeliveryId)).state, 'unknown');
    const lostRetry = await answerOverMcp(context, lostId);
    assert.equal(JSON.stringify(lostRetry).includes('stdio-private-' + provider), false);
    assert.equal(context.calls.sinks, 2);

    const cancelledId = 'cancel-first-' + provider;
    await registerOverMcp(context, cancelledId);
    const cancelledQuestion = await getDashboardQuestion(context, cancelledId);
    const cancelled = await postProduct(context, `/api/decisions/${encodeURIComponent(cancelledQuestion.internalQuestionId)}/cancel`, {
      session_id: context.harness.primary.child.registration.sessionId,
      execution_id: cancelledQuestion.executionId,
    }, uiHeaders(context.runtime));
    assert.equal(jsonBody(cancelled).outcome, 'cancelled');
    const cancelledPoll = await answerOverMcp(context, cancelledId);
    assert.equal(JSON.stringify(cancelledPoll).includes(textSecret), false);
    assert.equal(context.calls.sinks, 2);

    const beforeSendId = 'restart-before-send-' + provider;
    await registerOverMcp(context, beforeSendId, [question('choice', { allowFreeText: true })]);
    const beforeSendSave = await answerOverUi(context, beforeSendId,
      [questionAnswer('choice', ['a'], 'restart-private-' + provider)]);
    assert.equal(beforeSendSave.response.status, 200, beforeSendSave.response.body);
    const beforeSendQuestion = await getDashboardQuestion(context, beforeSendId);
    const availableAttempt = beforeSendQuestion.deliveryAttemptId;
    assert.ok(availableAttempt);
    assert.equal((await context.harness.deliveryStore.get(availableAttempt)).state, 'available');
    const journalBeforeRestart = await fs.readFile(context.harness.journalPath, 'utf8');
    const checkpointBeforeRestart = await fs.readFile(context.harness.checkpointPath, 'utf8');

    await stopProductServer(context);
    await context.harness.reopen();
    await startProductServer(context);
    const reopenedReady = await context.harness.questionService.ready().then(() => 'ready', (error) => error.code || error.message);
    assert.equal(reopenedReady, 'ready');
    const afterRestart = await context.harness.questionService.dashboardSnapshot();
    const reopenedQuestion = afterRestart.questions.find((item) => item.questionId === beforeSendId);
    assert.equal(reopenedQuestion.quarantined, true);
    assert.equal(reopenedQuestion.deliveryAttemptId, availableAttempt);
    assert.equal(reopenedQuestion.deliveryState, 'available');
    const sentQuestion = afterRestart.questions.find((item) => item.questionId === questionId);
    assert.equal(sentQuestion.quarantined, true);
    assert.equal(sentQuestion.deliveryState, 'unknown');
    assert.equal(context.harness.questionService.getQuarantineDiagnostics().quarantinedCount, 4);

    const replay = await answerOverMcp(context, beforeSendId);
    assert.equal(replay[0].result.isError, true);
    assert.equal(JSON.stringify(replay).includes('restart-private-' + provider), false);
    assert.equal(JSON.stringify(afterRestart).includes('restart-private-' + provider), false);
    assert.equal(context.calls.sinks, 0);
    assert.equal((await context.harness.deliveryStore.get(availableAttempt)).state, 'available');
    assert.equal((await context.harness.deliveryStore.get(deliveryAttemptId)).state, 'unknown');
    assert.equal(await fs.readFile(context.harness.journalPath, 'utf8'), journalBeforeRestart);
    assert.equal(await fs.readFile(context.harness.checkpointPath, 'utf8'), checkpointBeforeRestart);
  });

  test('ID-F07-A04: ' + provider + ' はsend-start保存失敗後の再openでも回答本文を渡さない', { timeout: 5000 }, async (t) => {
    let failedSendingCheckpoint = false;
    let sendingWriteAttempts = 0;
    const atomicWrite = async (filePath, checkpoint) => {
      const isSending = checkpoint?.ledger?.deliveries?.some((delivery) => delivery.state === 'sending');
      if (!failedSendingCheckpoint && isSending) {
        failedSendingCheckpoint = true;
        sendingWriteAttempts += 1;
        throw new Error('injected checkpoint write failure');
      }
      return atomicWriteJson(path.dirname(filePath), path.basename(filePath), checkpoint);
    };
    const context = await createProductContext(t, provider, {
      harnessOptions: { deliveryStoreOptions: { atomicWrite } },
    });
    const questionId = 'send-save-failure-' + provider;
    const answerText = 'must-not-leak-before-send-save-' + provider;
    await registerOverMcp(context, questionId, [question('choice', { allowFreeText: true })]);
    const saved = await answerOverUi(context, questionId, [questionAnswer('choice', ['a'], answerText)]);
    assert.equal(saved.response.status, 200, saved.response.body);
    const internal = saved.dashboardQuestion.internalQuestionId;
    const selected = await getDashboardQuestion(context, questionId);
    const deliveryId = selected.deliveryAttemptId;
    assert.ok(deliveryId);
    assert.equal((await context.harness.deliveryStore.get(deliveryId)).state, 'available');

    const failedPoll = await answerOverMcp(context, questionId);
    assert.equal(failedPoll[0].result.isError, true);
    assert.equal(JSON.stringify(failedPoll).includes(answerText), false);
    assert.equal(failedSendingCheckpoint, true);
    assert.equal(sendingWriteAttempts, 1);
    assert.equal(context.calls.answerPoll, 1);
    assert.equal(context.calls.sinks, 0);
    assert.equal((await context.harness.deliveryStore.get(deliveryId)).state, 'available');
    await assert.rejects(context.harness.deliveryStore.claim(deliveryId, 'blocked-after-send-failure-' + provider),
      (error) => error.code === 'store_writer_blocked');
    const savedCheckpoint = JSON.parse(await fs.readFile(context.harness.checkpointPath, 'utf8'));
    assert.equal(savedCheckpoint.ledger.deliveries.find((item) => item.deliveryAttemptId === deliveryId).state, 'available');
    const afterFailure = await context.harness.questionService.dashboardSnapshot();
    assert.equal(afterFailure.questions.find((item) => item.internalQuestionId === internal).deliveryState, 'available');

    await stopProductServer(context);
    await context.harness.reopen();
    await startProductServer(context);
    const recovered = await answerOverMcp(context, questionId);
    assert.equal(recovered[0].result.isError, true);
    assert.equal(JSON.stringify(recovered).includes(answerText), false);
    const quarantined = await getDashboardQuestion(context, questionId);
    assert.equal(quarantined.quarantined, true);
    assert.equal(quarantined.deliveryAttemptId, deliveryId);
    assert.equal(quarantined.deliveryState, 'available');
    assert.equal(context.calls.sinks, 0);
    assert.equal((await context.harness.deliveryStore.get(deliveryId)).state, 'available');
  });

  test('ID-F07-A05: ' + provider + ' はdelivery保存失敗後もintentを隔離し配送を再生成しない', { timeout: 5000 }, async (t) => {
    let failedAvailableCheckpoint = false;
    let availableWriteAttempts = 0;
    const atomicWrite = async (filePath, checkpoint) => {
      const hasAvailableQuestion = checkpoint?.ledger?.deliveries?.some((delivery) =>
        delivery.kind === 'question' && delivery.state === 'available');
      if (!failedAvailableCheckpoint && hasAvailableQuestion) {
        failedAvailableCheckpoint = true;
        availableWriteAttempts += 1;
        throw new Error('injected available checkpoint write failure');
      }
      return atomicWriteJson(path.dirname(filePath), path.basename(filePath), checkpoint);
    };
    const context = await createProductContext(t, provider, {
      harnessOptions: { deliveryStoreOptions: { atomicWrite } },
    });
    const questionId = 'available-save-failure-' + provider;
    const answerText = 'journaled-before-delivery-' + provider;
    await registerOverMcp(context, questionId, [question('choice', { allowFreeText: true })]);

    const save = await answerOverUi(context, questionId, [questionAnswer('choice', ['a'], answerText)]);
    assert.notEqual(save.response.status, 200, save.response.body);
    assert.equal(failedAvailableCheckpoint, true);
    assert.equal(availableWriteAttempts, 1);
    const journal = JSON.parse(await fs.readFile(context.harness.journalPath, 'utf8'));
    const journalQuestion = journal.questions.find((item) => item.internalQuestionId === save.dashboardQuestion.internalQuestionId);
    assert.ok(journalQuestion?.selection);
    assert.deepEqual(journalQuestion.selection.answers, [questionAnswer('choice', ['a'], answerText)]);
    assert.ok(journalQuestion.deliveryIntent);
    const fixedIntent = structuredClone(journalQuestion.deliveryIntent);
    assert.equal(journalQuestion.revision, fixedIntent.revision);
    assert.deepEqual((await context.harness.deliveryStore.snapshot()).deliveries, []);
    assert.equal(context.calls.sinks, 0);
    await assert.rejects(fs.readFile(context.harness.checkpointPath, 'utf8'), { code: 'ENOENT' });

    const selectedProjection = await getDashboardQuestion(context, questionId);
    assert.equal(selectedProjection.selectionSource, 'manual');
    assert.equal(selectedProjection.deliveryAttemptId, fixedIntent.deliveryAttemptId);
    assert.equal(selectedProjection.deliveryState, null);

    await stopProductServer(context);
    await context.harness.reopen();
    await startProductServer(context);

    const recoveredJournal = JSON.parse(await fs.readFile(context.harness.journalPath, 'utf8'));
    const recoveredQuestion = recoveredJournal.questions.find((item) => item.internalQuestionId === save.dashboardQuestion.internalQuestionId);
    assert.deepEqual(recoveredQuestion.deliveryIntent, fixedIntent);
    const recoveredDeliveries = (await context.harness.deliveryStore.snapshot()).deliveries;
    assert.deepEqual(recoveredDeliveries, []);
    const quarantined = await getDashboardQuestion(context, questionId);
    assert.equal(quarantined.quarantined, true);
    assert.equal(quarantined.deliveryAttemptId, fixedIntent.deliveryAttemptId);
    assert.equal(quarantined.deliveryState, null);
    assert.equal(context.harness.questionService.getQuarantineDiagnostics().quarantinedCount, 1);

    const delivered = await answerOverMcp(context, questionId);
    assert.equal(delivered[0].result.isError, true);
    assert.equal(JSON.stringify(delivered).includes(answerText), false);
    assert.equal(context.calls.sinks, 0);
    const afterSend = (await context.harness.deliveryStore.snapshot()).deliveries;
    assert.deepEqual(afterSend, []);
    assert.deepEqual(JSON.parse(await fs.readFile(context.harness.journalPath, 'utf8')), recoveredJournal);
  });

  test(`ID-F08-QR01/QR03: ${provider} は同じsessionの保存質問を隔離し、新periodだけ受け付ける`, { timeout: 5000 }, async (t) => {
    const context = await createProductContext(t, provider);
    const questionId = 'same-session-question-' + provider;
    const form = [question('choice')];
    await registerOverMcp(context, questionId, form);
    const original = await getDashboardQuestion(context, questionId);
    const save = await answerOverUi(context, questionId, [questionAnswer('choice')]);
    assert.equal(save.response.status, 200, save.response.body);
    const journalBeforeRestart = await fs.readFile(context.harness.journalPath, 'utf8');

    await stopProductServer(context);
    await context.harness.reopen();
    await startProductServer(context);
    const afterReconnect = await getDashboardQuestion(context, questionId);
    assert.equal(afterReconnect.quarantined, true);
    await assert.rejects(context.harness.questionService.register(context.harness.writer,
      { questionId, questions: form, timeoutMinutes: 1, category: 'ordinary' }),
    (error) => error.code === 'question_quarantined');
    assert.equal(await fs.readFile(context.harness.journalPath, 'utf8'), journalBeforeRestart);

    const identity = context.harness.primary.child.identity;
    assert.equal(context.harness.registrationKernel.authority.end(original.periodId), true);
    const resumed = context.harness.createExecution('new-period-' + provider, {
      provider: identity.provider,
      nativeIdKind: identity.nativeIdKind,
      hostId: identity.hostId,
      homeScopeId: identity.homeScopeId,
      nativeId: identity.nativeId,
    }, { resume: true });
    assert.deepEqual(resumed.child.identity, identity);
    assert.notEqual(resumed.child.registration.executionId, original.periodId);
    const nextPeriod = await context.harness.questionService.register(resumed.child.writer,
      { questionId, questions: form, timeoutMinutes: 1, category: 'ordinary' });
    assert.equal(nextPeriod.outcome, 'created');
    assert.equal(nextPeriod.question.periodId, resumed.child.registration.executionId);
    assert.notEqual(nextPeriod.question.internalQuestionId, original.internalQuestionId);
    const afterNewPeriod = await context.harness.questionService.dashboardSnapshot();
    assert.equal(afterNewPeriod.questions.find((item) => item.internalQuestionId === original.internalQuestionId).quarantined, true);
    assert.equal(afterNewPeriod.questions.find((item) => item.internalQuestionId === nextPeriod.question.internalQuestionId).quarantined, false);
    assert.equal(afterNewPeriod.questions.length, 2);
  });

  for (const corruption of ['digest', 'orphan delivery', 'duplicate attempt']) {
    test(`ID-F08-QR04: ${provider} は${corruption}を拒否し、修復後に再openできる`, { timeout: 5000 }, async (t) => {
      const context = await createProductContext(t, provider);
      const primaryId = 'qr04-primary-' + provider;
      const ids = corruption === 'duplicate attempt'
        ? [primaryId, 'qr04-secondary-' + provider]
        : [primaryId];
      for (const questionId of ids) {
        await registerOverMcp(context, questionId);
        const saved = await answerOverUi(context, questionId, [questionAnswer('choice')]);
        assert.equal(saved.response.status, 200, saved.response.body);
      }

      const journalBefore = await fs.readFile(context.harness.journalPath, 'utf8');
      const checkpointBefore = await fs.readFile(context.harness.checkpointPath, 'utf8');
      const malformed = JSON.parse(journalBefore);
      if (corruption === 'digest') malformed.questions[0].deliveryIntent.payloadDigest = '0'.repeat(64);
      if (corruption === 'orphan delivery') malformed.questions = [];
      if (corruption === 'duplicate attempt') {
        malformed.questions[1].deliveryIntent.deliveryAttemptId = malformed.questions[0].deliveryIntent.deliveryAttemptId;
      }
      const malformedBytes = JSON.stringify(malformed, null, 2) + '\n';
      const expectedCode = corruption === 'orphan delivery'
        ? 'question_journal_missing_for_delivery'
        : corruption === 'digest' ? 'invalid_journal' : 'question_delivery_mismatch';

      await stopProductServer(context);
      await fs.writeFile(context.harness.journalPath, malformedBytes);
      await assert.rejects(context.harness.reopen(), (error) => error.code === expectedCode);
      assert.equal(await fs.readFile(context.harness.journalPath, 'utf8'), malformedBytes);
      assert.equal(await fs.readFile(context.harness.checkpointPath, 'utf8'), checkpointBefore);

      await fs.writeFile(context.harness.journalPath, journalBefore);
      await context.harness.reopen();
      await startProductServer(context);
      assert.equal(context.harness.questionService.getQuarantineDiagnostics().quarantinedCount, ids.length);
      assert.equal(await fs.readFile(context.harness.journalPath, 'utf8'), journalBefore);
      assert.equal(await fs.readFile(context.harness.checkpointPath, 'utf8'), checkpointBefore);
      const original = await getDashboardQuestion(context, primaryId);
      await assert.rejects(context.harness.questionService.submitAnswer(original.internalQuestionId,
        { answers: [questionAnswer('choice')] }), (error) => error.code === 'question_quarantined');
      const fresh = await registerOverMcp(context, 'qr04-fresh-' + provider);
      assert.equal(fresh.result.isError, undefined);
    });
  }

  test(`ID-F08-QR05: ${provider} は混在checkpointの既存復旧だけを適用し質問を再送しない`, { timeout: 5000 }, async (t) => {
    const context = await createProductContext(t, provider);
    const store = context.harness.deliveryStore;
    const stateByQuestion = new Map();
    const sinkCalls = { beforeRestart: 0, afterRestart: 0 };
    for (const state of ['available', 'claimed', 'sending', 'accepted', 'unknown']) {
      const questionId = 'qr05-' + state + '-' + provider;
      await registerOverMcp(context, questionId, [question('choice', { allowFreeText: true })]);
      const saved = await answerOverUi(context, questionId, [questionAnswer('choice', ['a'], 'private-' + state)]);
      assert.equal(saved.response.status, 200, saved.response.body);
      const selected = await getDashboardQuestion(context, questionId);
      const deliveryId = selected.deliveryAttemptId;
      stateByQuestion.set(questionId, { internalQuestionId: selected.internalQuestionId, deliveryId, state });
      if (state === 'claimed') await store.claim(deliveryId);
      if (['sending', 'accepted', 'unknown'].includes(state)) {
        await store.sendStart(deliveryId, () => { sinkCalls.beforeRestart += 1; });
      }
      if (state === 'accepted') {
        const delivery = await store.get(deliveryId);
        await store.recordAccepted(deliveryId, {
          deliveryAttemptId: deliveryId, revision: delivery.revision, payloadDigest: delivery.payloadDigest,
          targetPeriodId: delivery.target.periodId, nativeTurnId: 'accepted-turn-' + provider,
          nativeItemId: null, clientRequestId: deliveryId,
        });
      }
      if (state === 'unknown') await store.markUnknown(deliveryId);
    }
    const instructionId = 'qr05-instruction-' + provider;
    const instruction = await store.createInstructionDelivery({ launchRef: context.harness.primary.launchRef,
      deliveryAttemptId: instructionId, logicalMessageId: 'qr05-instruction-message-' + provider,
      revision: 0, payload: 'opaque instruction payload' });
    assert.equal(instruction.kind, 'instruction');
    assert.equal(instruction.state, 'available');

    const journalBeforeRestart = await fs.readFile(context.harness.journalPath, 'utf8');
    const checkpointBeforeRestartBytes = await fs.readFile(context.harness.checkpointPath, 'utf8');
    const checkpointBeforeRestart = JSON.parse(checkpointBeforeRestartBytes);
    const beforeDeliveries = new Map(checkpointBeforeRestart.ledger.deliveries.map((item) => [item.deliveryAttemptId, item]));
    const originalTombstones = structuredClone(checkpointBeforeRestart.ledger.logicalTombstones);
    const expectedStates = { available: 'available', claimed: 'claimed', sending: 'sending',
      accepted: 'accepted', unknown: 'unknown' };
    for (const { deliveryId, state } of stateByQuestion.values()) {
      assert.equal(beforeDeliveries.get(deliveryId).state, expectedStates[state]);
    }
    assert.equal(Buffer.byteLength(checkpointBeforeRestartBytes, 'utf8') <= DEFAULT_MAX_CHECKPOINT_BYTES, true);

    await stopProductServer(context);
    await context.harness.reopen();
    await startProductServer(context);
    assert.equal(await fs.readFile(context.harness.checkpointPath, 'utf8'), checkpointBeforeRestartBytes);
    const recoveredCheckpoint = await readNativeRecoverySnapshot(context.harness.deliveryStore);
    assert.equal(recoveredCheckpoint.revision, checkpointBeforeRestart.revision);
    assert.equal(recoveredCheckpoint.ledger.revision, checkpointBeforeRestart.ledger.revision + 1);
    assert.ok(recoveredCheckpoint.registrations.executions.every((item) => item.state === 'unknown'));
    assert.ok(recoveredCheckpoint.registrations.launches.every((item) => item.state === 'unknown'));
    assert.ok(recoveredCheckpoint.registrations.runtimeLaunches.every((item) => item.state === 'unknown'));
    assert.ok(recoveredCheckpoint.registrations.connections.every((item) => item.state === 'inactive'));
    assert.ok(recoveredCheckpoint.registrations.actors.every((item) => item.state === 'unknown'));
    assert.deepEqual(recoveredCheckpoint.ledger.logicalTombstones, originalTombstones);

    const restoredStates = { available: 'available', claimed: 'available', sending: 'unknown',
      accepted: 'unknown', unknown: 'unknown' };
    const recoveredDeliveries = new Map(recoveredCheckpoint.ledger.deliveries.map((item) => [item.deliveryAttemptId, item]));
    for (const [questionId, { internalQuestionId, deliveryId, state }] of stateByQuestion) {
      const before = beforeDeliveries.get(deliveryId);
      const after = recoveredDeliveries.get(deliveryId);
      assert.equal(after.state, restoredStates[state]);
      assert.equal(after.payloadDigest, before.payloadDigest);
      assert.equal(after.logicalMessageId, before.logicalMessageId);
      assert.deepEqual(after.source, before.source);
      assert.deepEqual(after.target, before.target);
      assert.deepEqual(after.acceptedCorrelation, before.acceptedCorrelation);
      assert.deepEqual(after.appliedCorrelation, before.appliedCorrelation);
      const row = (await getDashboardQuestion(context, questionId));
      assert.equal(row.internalQuestionId, internalQuestionId);
      assert.equal(row.quarantined, true);
      assert.equal(row.deliveryState, restoredStates[state]);
      await assert.rejects(context.harness.questionService.answerPoll(context.harness.writer, questionId, () => {
        sinkCalls.afterRestart += 1;
      }), (error) => error.code === 'question_quarantined');
    }
    assert.equal(recoveredDeliveries.get(instructionId).kind, 'instruction');
    assert.equal(recoveredDeliveries.get(instructionId).state, 'available');
    assert.equal(sinkCalls.afterRestart, 0);
    assert.equal(sinkCalls.beforeRestart, 3);
    assert.equal(await fs.readFile(context.harness.checkpointPath, 'utf8'), checkpointBeforeRestartBytes);
    assert.equal(await fs.readFile(context.harness.journalPath, 'utf8'), journalBeforeRestart);

    const nextInstructionId = 'qr05-post-reopen-instruction-' + provider;
    await context.harness.deliveryStore.createInstructionDelivery({ launchRef: context.harness.primary.launchRef,
      deliveryAttemptId: nextInstructionId, logicalMessageId: 'qr05-post-reopen-message-' + provider,
      revision: 0, payload: 'another opaque instruction payload' });
    const checkpointAfterSaveBytes = await fs.readFile(context.harness.checkpointPath, 'utf8');
    const checkpointAfterSave = JSON.parse(checkpointAfterSaveBytes);
    const savedDeliveries = new Map(checkpointAfterSave.ledger.deliveries.map((item) => [item.deliveryAttemptId, item]));
    assert.notEqual(checkpointAfterSaveBytes, checkpointBeforeRestartBytes);
    assert.equal(checkpointAfterSave.revision, checkpointBeforeRestart.revision + 1);
    assert.equal(checkpointAfterSave.ledger.revision, checkpointBeforeRestart.ledger.revision + 2);
    assert.equal(checkpointAfterSave.ledger.logicalTombstones.length, originalTombstones.length + 1);
    for (const tombstone of originalTombstones) assert.ok(checkpointAfterSave.ledger.logicalTombstones.some((item) =>
      JSON.stringify(item) === JSON.stringify(tombstone)));
    for (const { deliveryId, state } of stateByQuestion.values()) {
      const before = beforeDeliveries.get(deliveryId);
      const after = savedDeliveries.get(deliveryId);
      assert.equal(after.state, restoredStates[state]);
      assert.equal(after.payloadDigest, before.payloadDigest);
      assert.equal(after.logicalMessageId, before.logicalMessageId);
      assert.deepEqual(after.source, before.source);
      assert.deepEqual(after.target, before.target);
      assert.deepEqual(after.acceptedCorrelation, before.acceptedCorrelation);
      assert.deepEqual(after.appliedCorrelation, before.appliedCorrelation);
    }
    assert.equal(savedDeliveries.get(instructionId).state, 'available');
    assert.equal(savedDeliveries.get(nextInstructionId).kind, 'instruction');
    assert.equal(savedDeliveries.get(nextInstructionId).state, 'available');
    assert.equal(checkpointAfterSave.ledger.deliveries.filter((item) => item.kind === 'question').length, 5);
    assert.equal(Buffer.byteLength(checkpointAfterSaveBytes, 'utf8') <= DEFAULT_MAX_CHECKPOINT_BYTES, true);
    assert.equal(await fs.readFile(context.harness.journalPath, 'utf8'), journalBeforeRestart);
    assert.equal(sinkCalls.afterRestart, 0);
  });

  test(`ID-F08-QR06: ${provider} は隔離対象で容量上限を維持し、再起動後も新規受付を拒否する`, { timeout: 5000 }, async (t) => {
    const context = await createProductContext(t, provider, {
      harnessOptions: { questionServiceOptions: { maxBytes: 16_384, maxRecords: 1 } },
    });
    const questionId = 'qr06-full-' + provider;
    const registrationInput = { questionId, questions: [question('choice')], timeoutMinutes: 1, category: 'ordinary' };
    await context.harness.questionService.register(context.harness.writer, registrationInput);
    const diagnostics = context.harness.questionService.getQuarantineDiagnostics();
    assert.equal(diagnostics.status, 'ready');
    assert.equal(diagnostics.reason, 'question_quarantine_capacity');
    assert.equal(diagnostics.quarantinedCount, 0);
    assert.equal(diagnostics.remainingCount, 0);
    assert.ok(diagnostics.reservedBytes > 0);
    assert.ok(diagnostics.remainingBytes > 0);

    const instructionId = 'qr06-instruction-' + provider;
    await context.harness.deliveryStore.createInstructionDelivery({ launchRef: context.harness.primary.launchRef,
      deliveryAttemptId: instructionId, logicalMessageId: 'qr06-instruction-message-' + provider,
      revision: 0, payload: 'opaque instruction payload' });

    const journalBeforeRestart = await fs.readFile(context.harness.journalPath, 'utf8');
    const checkpointBeforeRestart = await fs.readFile(context.harness.checkpointPath, 'utf8');
    await assert.rejects(context.harness.questionService.register(context.harness.writer,
      { ...registrationInput, questionId: 'qr06-rejected-' + provider }),
    (error) => error.code === 'question_quarantine_capacity');
    assert.equal(await fs.readFile(context.harness.journalPath, 'utf8'), journalBeforeRestart);

    await stopProductServer(context);
    await context.harness.reopen();
    await startProductServer(context);
    const restored = context.harness.questionService.getQuarantineDiagnostics();
    assert.equal(restored.status, 'ready');
    assert.equal(restored.reason, 'question_quarantine_capacity');
    assert.equal(restored.quarantinedCount, 1);
    assert.equal(restored.remainingCount, 0);
    assert.ok(restored.reservedBytes > 0);
    assert.ok(restored.remainingBytes > 0);
    assert.equal((await context.harness.deliveryStore.get(instructionId)).state, 'available');
    const row = await getDashboardQuestion(context, questionId);
    assert.equal(row.quarantined, true);
    await assert.rejects(context.harness.questionService.submitAnswer(row.internalQuestionId,
      { answers: [questionAnswer('choice')] }), (error) => error.code === 'question_quarantined');
    await assert.rejects(context.harness.questionService.register(context.harness.writer,
      { ...registrationInput, questionId: 'qr06-rejected-after-restart-' + provider }),
    (error) => error.code === 'question_quarantine_capacity');
    assert.equal(await fs.readFile(context.harness.journalPath, 'utf8'), journalBeforeRestart);
    assert.equal(await fs.readFile(context.harness.checkpointPath, 'utf8'), checkpointBeforeRestart);
  });


  test('ID-F08-A01: ' + provider + ' は保留と全問適格条件を離席期限で確認する', { timeout: 5000 }, async (t) => {
    let clock = 1_000;
    const away = { enabled: true, since: 1_000, snapshot() { return { enabled: this.enabled, since: this.since }; } };
    const context = await createProductContext(t, provider, {
      harnessOptions: { now: () => clock, away, questionServiceOptions: {
        getAutoApplySettings: () => ({ enabled: true, minimumWaitMs: 300_000 }),
      } },
    });
    const allRecommendedId = 'held-recommended-' + provider;
    await registerOverMcp(context, allRecommendedId, [
      question('first', { recommendedOptionId: 'a' }),
      question('second', {
        options: [
          { id: 'a', label: 'Option A', description: '' },
          { id: 'b', label: 'Option B', description: '' },
        ],
        recommendedOptionId: 'b',
      }),
    ]);
    const heldQuestion = await getDashboardQuestion(context, allRecommendedId);
    const hold = await postProduct(context, '/api/decisions/' + encodeURIComponent(heldQuestion.internalQuestionId) + '/hold', {
      session_id: context.harness.primary.child.registration.sessionId,
      execution_id: heldQuestion.executionId,
      held: true,
    }, uiHeaders(context.runtime));
    assert.equal(hold.status, 200, hold.body);
    clock = heldQuestion.deadlineAt;
    await context.harness.questionService.tick();
    assert.equal((await getDashboardQuestion(context, allRecommendedId)).selectionSource, null);
    assert.equal((await context.harness.deliveryStore.snapshot()).deliveries.length, 0);
    const release = await postProduct(context, '/api/decisions/' + encodeURIComponent(heldQuestion.internalQuestionId) + '/hold', {
      session_id: context.harness.primary.child.registration.sessionId,
      execution_id: heldQuestion.executionId,
      held: false,
    }, uiHeaders(context.runtime));
    assert.equal(release.status, 200, release.body);
    clock = heldQuestion.createdAt + 300_000;
    await context.harness.questionService.tick();
    const defaulted = await getDashboardQuestion(context, allRecommendedId);
    assert.equal(defaulted.selectionSource, 'away-default');
    assert.deepEqual(defaulted.selectedOptionIds, [
      { questionId: 'first', optionIds: ['a'] },
      { questionId: 'second', optionIds: ['b'] },
    ]);
    assert.equal((await context.harness.deliveryStore.get(defaulted.deliveryAttemptId)).state, 'available');

    const mixedId = 'no-partial-default-' + provider;
    await registerOverMcp(context, mixedId, [
      question('eligible', { recommendedOptionId: 'a' }),
      question('multi', { mode: 'multi', recommendedOptionId: 'a' }),
    ]);
    const mixed = await getDashboardQuestion(context, mixedId);
    clock = mixed.createdAt + 300_000;
    await context.harness.questionService.tick();
    const unchanged = await getDashboardQuestion(context, mixedId);
    assert.equal(unchanged.selectionSource, null);
    assert.deepEqual(unchanged.selectedOptionIds, []);
    assert.equal(unchanged.deliveryAttemptId, null);
  });

  test('ID-F08-A02: ' + provider + ' は手動回答と期限回答の先着を保持し遅い回答を再適用しない', { timeout: 5000 }, async (t) => {
    let clock = 2_000;
    const away = { snapshot: () => ({ enabled: true, since: 2_000 }) };
    const context = await createProductContext(t, provider, {
      harnessOptions: { now: () => clock, away, questionServiceOptions: {
        getAutoApplySettings: () => ({ enabled: true, minimumWaitMs: 300_000 }),
      } },
    });
    const manualId = 'manual-before-deadline-' + provider;
    await registerOverMcp(context, manualId, [question('choice', { options: [
      { id: 'a', label: 'Option A', description: '' },
      { id: 'b', label: 'Option B', description: '' },
    ], recommendedOptionId: 'a' })]);
    const manualQuestion = await getDashboardQuestion(context, manualId);
    const manual = await answerOverUi(context, manualId, [questionAnswer('choice', ['b'])]);
    assert.equal(manual.response.status, 200, manual.response.body);
    assert.equal(jsonBody(manual.response).outcome, 'selected');
    clock = manualQuestion.createdAt + 300_000;
    await context.harness.questionService.tick();
    const preservedManual = await getDashboardQuestion(context, manualId);
    assert.equal(preservedManual.selectionSource, 'manual');
    assert.deepEqual(preservedManual.selectedOptionIds, [{ questionId: 'choice', optionIds: ['b'] }]);

    const defaultId = 'late-manual-answer-' + provider;
    await registerOverMcp(context, defaultId, [question('choice', { options: [
      { id: 'a', label: 'Option A', description: '' },
      { id: 'b', label: 'Option B', description: '' },
    ], recommendedOptionId: 'a' })]);
    const pending = await getDashboardQuestion(context, defaultId);
    clock = pending.createdAt + 300_000;
    await context.harness.questionService.tick();
    const selected = await getDashboardQuestion(context, defaultId);
    assert.equal(selected.selectionSource, 'away-default');
    const late = await answerOverUi(context, defaultId, [questionAnswer('choice', ['b'])]);
    assert.equal(late.response.status, 200, late.response.body);
    assert.equal(jsonBody(late.response).outcome, 'late');
    const afterLate = await getDashboardQuestion(context, defaultId);
    assert.equal(afterLate.selectionSource, 'away-default');
    assert.deepEqual(afterLate.selectedOptionIds, [{ questionId: 'choice', optionIds: ['a'] }]);
    assert.equal(afterLate.lateAnswerCount, 1);
    assert.equal((await context.harness.deliveryStore.get(selected.deliveryAttemptId)).state, 'available');
  });

  test('ID-F08-A06: ' + provider + ' は同一起動内のlate回答を重複排除し再open後は保存済み質問を隔離する', { timeout: 5000 }, async (t) => {
    const context = await createProductContext(t, provider, {
      harnessOptions: { questionServiceOptions: {
        verifyNativeQuestion: (evidence) => evidence?.source === 'trusted-original-ui-fixture',
      } },
    });
    const form = [question('choice', { allowFreeText: true, options: [
      { id: 'a', label: 'Option A', description: '' },
      { id: 'b', label: 'Option B', description: '' },
    ] })];
    const questionId = 'external-unanswered-' + provider;
    const privateAnswer = 'late-private-' + provider;
    await registerOverMcp(context, questionId, form);
    const original = await getDashboardQuestion(context, questionId);
    assert.equal(original.selectionSource, null);
    assert.equal(original.deliveryAttemptId, null);
    await context.harness.questionService.resolveExternal(original.internalQuestionId, {
      source: 'trusted-original-ui-fixture', evidenceId: 'external-unanswered-' + provider,
    });
    const resolved = await getDashboardQuestion(context, questionId);
    assert.equal(resolved.externalResolution, true);
    assert.equal(resolved.selectionSource, null);
    assert.equal(resolved.deliveryAttemptId, null);

    const readJournal = async () => JSON.parse(await fs.readFile(context.harness.journalPath, 'utf8'));
    const findRecord = (journal, id) => journal.questions.find((item) => item.questionId === id);
    await answerOverUi(context, questionId, [questionAnswer('choice', ['b'], privateAnswer)]);
    const firstJournal = await readJournal();
    const firstRecord = findRecord(firstJournal, questionId);
    assert.equal(firstRecord.revision, 0);
    assert.equal(firstRecord.selection, null);
    assert.equal(firstRecord.deliveryIntent, null);
    assert.equal(firstRecord.lateAnswers.length, 1);
    const firstJournalRevision = firstJournal.revision;

    const retry = await answerOverUi(context, questionId, [questionAnswer('choice', ['b'], privateAnswer)]);
    assert.equal(retry.response.status, 200, retry.response.body);
    assert.equal(jsonBody(retry.response).outcome, 'duplicate');
    assert.equal(retry.response.body.includes(privateAnswer), false);
    assert.equal((await readJournal()).revision, firstJournalRevision);

    const different = await answerOverUi(context, questionId, [questionAnswer('choice', ['a'], 'late-distinct-' + provider)]);
    assert.equal(different.response.status, 200, different.response.body);
    assert.equal(jsonBody(different.response).outcome, 'late');
    const afterDifferent = await readJournal();
    assert.equal(findRecord(afterDifferent, questionId).lateAnswers.length, 2);
    assert.equal(findRecord(afterDifferent, questionId).selection, null);
    assert.equal(findRecord(afterDifferent, questionId).deliveryIntent, null);

    const otherQuestionId = 'external-unanswered-independent-' + provider;
    await registerOverMcp(context, otherQuestionId, form);
    const other = await getDashboardQuestion(context, otherQuestionId);
    await context.harness.questionService.resolveExternal(other.internalQuestionId, {
      source: 'trusted-original-ui-fixture', evidenceId: 'external-unanswered-independent-' + provider,
    });
    const independent = await answerOverUi(context, otherQuestionId, [questionAnswer('choice', ['b'], privateAnswer)]);
    assert.equal(independent.response.status, 200, independent.response.body);
    assert.equal(jsonBody(independent.response).outcome, 'late');
    const beforeRestart = await readJournal();
    assert.equal(findRecord(beforeRestart, otherQuestionId).lateAnswers.length, 1);
    assert.equal((await context.harness.deliveryStore.snapshot()).deliveries.length, 0);
    const journalBytesBeforeRestart = await fs.readFile(context.harness.journalPath, 'utf8');

    await stopProductServer(context);
    await context.harness.reopen();
    await startProductServer(context);
    const recoveredRetry = await answerOverUi(context, questionId, [questionAnswer('choice', ['b'], privateAnswer)]);
    assert.equal(recoveredRetry.response.status, 503, recoveredRetry.response.body);
    assert.equal(recoveredRetry.response.body.includes(privateAnswer), false);
    const differentAfterRestart = await answerOverUi(context, questionId,
      [questionAnswer('choice', ['a'], 'late-after-restart-' + provider)]);
    assert.equal(differentAfterRestart.response.status, 503, differentAfterRestart.response.body);
    assert.equal(differentAfterRestart.response.body.includes('late-after-restart-' + provider), false);
    assert.equal(await fs.readFile(context.harness.journalPath, 'utf8'), journalBytesBeforeRestart);
    assert.equal(context.harness.questionService.getQuarantineDiagnostics().quarantinedCount, 2);

    await assert.rejects(context.harness.questionService.submitAnswer(original.internalQuestionId,
      { answers: [questionAnswer('choice', ['a'], 'direct-after-restart-' + provider)] }),
    (error) => error.code === 'question_quarantined');
    await assert.rejects(context.harness.questionService.answerPoll(context.harness.writer, questionId, () => {}),
      (error) => error.code === 'question_quarantined');
    assert.equal(await fs.readFile(context.harness.journalPath, 'utf8'), journalBytesBeforeRestart);
    assert.equal((await context.harness.deliveryStore.snapshot()).deliveries.length, 0);
  });

  test('ID-F08-A03: ' + provider + ' はowner終了後のfresh handoff proofで同じ子宛deliveryを再開する', { timeout: 5000 }, async (t) => {
    const context = await createProductContext(t, provider);
    const execution = context.harness.primary;
    const questionId = 'handoff-owner-' + provider;
    await registerOverMcp(context, questionId, [question('choice', { allowFreeText: true })]);
    const saved = await answerOverUi(context, questionId, [questionAnswer('choice', ['a'], 'handoff-private-' + provider)]);
    assert.equal(saved.response.status, 200, saved.response.body);
    const deliveryId = (await getDashboardQuestion(context, questionId)).deliveryAttemptId;
    assert.equal((await context.harness.deliveryStore.get(deliveryId)).state, 'available');

    const candidate = context.harness.createExecution('new-owner-' + provider);
    assert.notEqual(candidate.owner.provider, provider);
    assert.equal(context.harness.runtimeAdapters[execution.owner.provider].endActor(execution.ownerActor.actorHandle), true);
    assert.equal(context.harness.runtimeAdapters[provider].checkCurrentProof(execution.launchRef, execution.proofHandle).ok, false);
    const before = context.harness.runtimeKernel.registry.get(execution.launchRef);
    const newOwner = { periodId: candidate.owner.registration.executionId, actor: structuredClone(candidate.owner.actor) };
    const handoff = context.harness.runtimeAdapters[provider].handoff(execution.launchRef, {
      handoffId: 'handoff-' + provider,
      expectedOwner: structuredClone(before.currentOwner),
      expectedOwnerGeneration: before.ownerGeneration,
      newOwner,
      newOwnerGeneration: before.ownerGeneration + 1,
      immutableExecutionClaims: structuredClone(execution.claims),
      evidence: fixtureEvidence('handoff-evidence-' + provider),
    }, candidate.ownerActor.actorHandle);
    assert.equal(handoff.ownerGeneration, 1);
    assert.deepEqual(handoff.owner, newOwner);
    const proof = context.harness.reconcile(execution, {
      childActor: execution.childActor,
      ownerActor: candidate.ownerActor,
      expectedOwnerGeneration: 1,
    });
    assert.equal(context.harness.runtimeAdapters[provider].checkCurrentProof(execution.launchRef, proof.proofHandle).ok, true);
    const afterHandoff = context.harness.runtimeKernel.registry.get(execution.launchRef);
    assert.equal(afterHandoff.executionBinding.periodId, execution.child.registration.executionId);
    assert.deepEqual(afterHandoff.currentOwner, newOwner);
    assert.equal(afterHandoff.ownerGeneration, 1);

    const sent = await answerOverMcp(context, questionId);
    assert.equal(sent[0].result.isError, undefined, JSON.stringify(sent));
    const payload = JSON.parse(sent[0].result.content[0].text);
    assert.equal(payload.deliveryAttemptId, deliveryId);
    assert.equal(payload.answers[0].freeText, 'handoff-private-' + provider);
    assert.equal(context.calls.sinks, 1);
    assert.equal((await context.harness.deliveryStore.get(deliveryId)).state, 'sending');
  });

  test('ID-F08-A04: ' + provider + ' は元UI解決を送信前と送信後で別状態に保つ', { timeout: 5000 }, async (t) => {
    const context = await createProductContext(t, provider, {
      harnessOptions: { questionServiceOptions: {
        verifyNativeQuestion: (evidence) => evidence?.source === 'trusted-original-ui-fixture',
      } },
    });
    const beforeId = 'external-before-send-' + provider;
    await registerOverMcp(context, beforeId, [question('choice', { allowFreeText: true })]);
    const beforeSave = await answerOverUi(context, beforeId, [questionAnswer('choice', ['a'], 'before-external-private')]);
    assert.equal(beforeSave.response.status, 200, beforeSave.response.body);
    const beforeQuestion = await getDashboardQuestion(context, beforeId);
    await context.harness.questionService.resolveExternal(beforeQuestion.internalQuestionId, {
      source: 'trusted-original-ui-fixture', evidenceId: 'external-before-' + provider,
    });
    assert.equal((await context.harness.deliveryStore.get(beforeQuestion.deliveryAttemptId)).state, 'cancelled_before_send');
    const suppressed = await answerOverMcp(context, beforeId);
    assert.equal(suppressed[0].result.isError, undefined);
    assert.equal(JSON.stringify(suppressed).includes('before-external-private'), false);
    assert.equal(context.calls.sinks, 0);

    const afterId = 'external-after-send-' + provider;
    await registerOverMcp(context, afterId, [question('choice', { allowFreeText: true })]);
    const afterSave = await answerOverUi(context, afterId, [questionAnswer('choice', ['a'], 'after-external-private')]);
    assert.equal(afterSave.response.status, 200, afterSave.response.body);
    const afterQuestion = await getDashboardQuestion(context, afterId);
    const sent = await answerOverMcp(context, afterId);
    assert.equal(sent[0].result.isError, undefined);
    assert.equal(context.calls.sinks, 1);
    await context.harness.questionService.resolveExternal(afterQuestion.internalQuestionId, {
      source: 'trusted-original-ui-fixture', evidenceId: 'external-after-' + provider,
    });
    const afterResolution = await context.harness.deliveryStore.get(afterQuestion.deliveryAttemptId);
    assert.equal(afterResolution.state, 'unknown');
    assert.equal(afterResolution.state === 'cancelled_before_send', false);
  });


  test('ID-F08-A05: ' + provider + ' は許可・network・app分類を質問登録へ変換しない', { timeout: 5000 }, async (t) => {
    const context = await createProductContext(t, provider);
    const questionId = 'forbidden-category-' + provider;
    const questionForm = [question('choice')];
    const writer = context.harness.writer;
    const classified = await mcpExchange([mcpCall(1, 'cockpit_register_question', {
      questionId, questions: questionForm, timeoutMinutes: 1, category: 'permission',
    }, provider, writer.identity.nativeId)], mcpOptions(context));
    assert.equal(classified[0].result.isError, true);
    assert.equal(await getDashboardQuestion(context, questionId), undefined);
    const appClassification = await mcpExchange([mcpCall(2, 'cockpit_register_question', {
      questionId, questions: questionForm, timeoutMinutes: 1, category: 'app-operation',
    }, provider, writer.identity.nativeId)], mcpOptions(context));
    assert.equal(appClassification[0].result.isError, true);
    assert.equal(await getDashboardQuestion(context, questionId), undefined);
    const directClassification = await postProduct(context, QUESTION_ROUTE + '/register', {
      ...questionRegistration(writer, questionId, questionForm), category: 'network',
    });
    assert.equal(directClassification.status, 400);
    assert.equal(await getDashboardQuestion(context, questionId), undefined);
    assert.equal((await context.harness.deliveryStore.snapshot()).deliveries.length, 0);
  });
}
