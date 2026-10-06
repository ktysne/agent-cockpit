'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const { test } = require('node:test');
const { startMcpServer } = require('../src/mcp/server');
const { startServer } = require('../src/server/server');
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

  test(`ID-F07-A03/A04/A05: ${provider} は送信開始を一度だけ行い再open後も同じdeliveryを使う`, { timeout: 5000 }, async (t) => {
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

    await stopProductServer(context);
    await context.harness.reopen();
    await startProductServer(context);
    const reopenedReady = await context.harness.questionService.ready().then(() => 'ready', (error) => error.code || error.message);
    assert.equal(reopenedReady, 'ready');
    const replay = await answerOverMcp(context, beforeSendId);
    assert.equal(replay[0].result.isError, undefined, JSON.stringify({ replay, calls: context.calls }));
    const replayResult = JSON.parse(replay[0].result.content[0].text);
    assert.equal(replayResult.deliveryAttemptId, availableAttempt);
    assert.ok(Array.isArray(replayResult.answers));
    assert.equal(context.calls.sinks, 1);

    await stopProductServer(context);
    await context.harness.reopen();
    await startProductServer(context);
    const afterUnknown = await context.harness.questionService.dashboardSnapshot();
    assert.equal(afterUnknown.questions.find((item) => item.questionId === beforeSendId).deliveryState, 'unknown');
    const retry = await answerOverMcp(context, beforeSendId);
    assert.equal(JSON.stringify(retry).includes('restart-private-' + provider), false);
    assert.equal(context.calls.sinks, 0);
    assert.equal((await context.harness.deliveryStore.get(availableAttempt)).state, 'unknown');
  });

  test('ID-F07-A04: ' + provider + ' はsend-start保存失敗時に本文を渡さず、同じIDを再open後に使う', { timeout: 5000 }, async (t) => {
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
    assert.equal(recovered[0].result.isError, undefined, JSON.stringify(recovered));
    const delivery = JSON.parse(recovered[0].result.content[0].text);
    assert.equal(delivery.deliveryAttemptId, deliveryId);
    assert.equal(delivery.answers[0].freeText, answerText);
    assert.equal(context.calls.sinks, 1);
    assert.equal((await context.harness.deliveryStore.get(deliveryId)).state, 'sending');
  });

  test('ID-F07-A05: ' + provider + ' は選択済みintentを保ち、available保存失敗後も同じIDで一度だけ配送する', { timeout: 5000 }, async (t) => {
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
    assert.equal(recoveredDeliveries.length, 1);
    assert.equal(recoveredDeliveries[0].deliveryAttemptId, fixedIntent.deliveryAttemptId);
    assert.equal(recoveredDeliveries[0].logicalMessageId, fixedIntent.logicalMessageId);
    assert.equal(recoveredDeliveries[0].revision, fixedIntent.revision);
    assert.equal(recoveredDeliveries[0].payloadDigest, fixedIntent.payloadDigest);
    assert.equal(recoveredDeliveries[0].state, 'available');

    const delivered = await answerOverMcp(context, questionId);
    assert.equal(delivered[0].result.isError, undefined, JSON.stringify(delivered));
    const response = JSON.parse(delivered[0].result.content[0].text);
    assert.equal(response.deliveryAttemptId, fixedIntent.deliveryAttemptId);
    assert.deepEqual(response.answers, [questionAnswer('choice', ['a'], answerText)]);
    assert.equal(context.calls.sinks, 1);
    const afterSend = (await context.harness.deliveryStore.snapshot()).deliveries;
    assert.equal(afterSend.length, 1);
    assert.equal(afterSend[0].deliveryAttemptId, fixedIntent.deliveryAttemptId);
    assert.equal(afterSend[0].state, 'sending');
  });


  test('ID-F08-A01: ' + provider + ' は保留と全問適格条件を離席期限で確認する', { timeout: 5000 }, async (t) => {
    let clock = 1_000;
    const away = { enabled: true, snapshot() { return { enabled: this.enabled }; } };
    const context = await createProductContext(t, provider, {
      harnessOptions: { now: () => clock, away },
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
    clock = mixed.deadlineAt;
    await context.harness.questionService.tick();
    const unchanged = await getDashboardQuestion(context, mixedId);
    assert.equal(unchanged.selectionSource, null);
    assert.deepEqual(unchanged.selectedOptionIds, []);
    assert.equal(unchanged.deliveryAttemptId, null);
  });

  test('ID-F08-A02: ' + provider + ' は手動回答と期限回答の先着を保持し遅い回答を再適用しない', { timeout: 5000 }, async (t) => {
    let clock = 2_000;
    const away = { snapshot: () => ({ enabled: true }) };
    const context = await createProductContext(t, provider, {
      harnessOptions: { now: () => clock, away },
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
    clock = manualQuestion.deadlineAt;
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
    clock = pending.deadlineAt;
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

  test('ID-F08-A06: ' + provider + ' は初回HTTP応答の結果を使わず再試行し、late 回答を永続履歴で重複排除する', { timeout: 5000 }, async (t) => {
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

    await stopProductServer(context);
    await context.harness.reopen();
    await startProductServer(context);
    const recoveredRetry = await answerOverUi(context, questionId, [questionAnswer('choice', ['b'], privateAnswer)]);
    assert.equal(recoveredRetry.response.status, 200, recoveredRetry.response.body);
    assert.equal(jsonBody(recoveredRetry.response).outcome, 'duplicate');
    assert.equal(recoveredRetry.response.body.includes(privateAnswer), false);
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
    const finalJournal = await readJournal();
    assert.equal(findRecord(finalJournal, questionId).revision, 0);
    assert.equal(findRecord(finalJournal, otherQuestionId).revision, 0);
    assert.equal(findRecord(finalJournal, otherQuestionId).lateAnswers.length, 1);
    assert.equal((await context.harness.deliveryStore.snapshot()).deliveries.length, 0);
    let sinkCalls = 0;
    const poll = await context.harness.questionService.answerPoll(context.harness.writer, questionId, () => { sinkCalls += 1; });
    assert.equal(poll.outcome, 'unavailable');
    assert.equal(Object.hasOwn(poll, 'answers'), false);
    assert.equal(sinkCalls, 0);
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
