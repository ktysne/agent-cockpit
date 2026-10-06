'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const {
  QUESTION_TEMPLATES,
  buildQuestionArguments,
  createNativeQuestionFixture,
  findQuestionCallPlan,
  inspectFixedAnswerOutput,
} = require('./native-fixture');
const {
  bindQuestionTurn,
  classifyQuestionOutcome,
  createQuestionRpcLedger,
  fixedAnswerPayload,
  parseArguments,
  questionFlowSucceeded,
  removeRuntimeHome,
  summarizeRpcLedger,
} = require('./native-runner');

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const TURN_ID = '22222222-2222-4222-8222-222222222222';

function makeToolSchema(overrides = {}) {
  return {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        minItems: 1,
        maxItems: 4,
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            header: { type: 'string' },
            question: { type: 'string' },
            options: {
              type: 'array',
              minItems: 2,
              maxItems: 3,
              items: {
                type: 'object',
                properties: { label: { type: 'string' }, description: { type: 'string' } },
                required: ['label', 'description'],
              },
            },
            isOther: { type: 'boolean' },
            isSecret: { type: 'boolean' },
          },
          required: ['id', 'header', 'question', 'options', 'isOther', 'isSecret'],
        },
      },
      isBlocking: { type: 'boolean' },
    },
    required: ['questions', 'isBlocking'],
    additionalProperties: false,
    ...overrides,
  };
}

function makeTools(parameters = makeToolSchema(), { namespace } = {}) {
  return [{ type: 'function', name: 'request_user_input', ...(namespace ? { namespace } : {}), parameters }];
}

function makeQuestionParams({ turnId = TURN_ID, itemId = 'fixture-item-001', isSecret = false } = {}) {
  return {
    threadId: THREAD_ID,
    turnId,
    itemId,
    isBlocking: true,
    questions: QUESTION_TEMPLATES.map((question) => ({
      id: question.id,
      header: question.header,
      question: question.question,
      options: question.options.map((option) => ({ ...option })),
      isOther: question.isOther,
      isSecret: isSecret || question.isSecret,
    })),
  };
}

function rpc(method, params, id) {
  return JSON.stringify({ ...(id === undefined ? {} : { id }), method, params });
}

function makeFakeClient() {
  const sent = [];
  return {
    sent,
    async sendJson(message) { sent.push(message); },
    dispatchText() {},
  };
}

function makeFixtureSummary() {
  return {
    callSummary: {
      item_id: 'fixture-item-001',
      call_id: 'fixture-call-001',
      call_name: 'request_user_input',
      call_namespace: null,
      target_tool: 'request_user_input',
      target_namespace: null,
      schema_summary: { is_other_declared: false, is_secret_declared: false },
      model_tool_schema_is_blocking_declared: true,
      question_ids: QUESTION_TEMPLATES.map((question) => question.id),
      questions: QUESTION_TEMPLATES.map((question) => ({
        id: question.id,
        option_count: question.options.length,
        free_form_enabled: question.isOther,
        secret: false,
      })),
    },
  };
}

function makeSingleFixtureSummary() {
  const fixture = makeFixtureSummary();
  fixture.callSummary.question_ids = [QUESTION_TEMPLATES[0].id];
  fixture.callSummary.questions = fixture.callSummary.questions.slice(0, 1);
  return fixture;
}

async function postFixture(fixture, body, headers = {}) {
  const url = new URL('/responses', fixture.baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: url.hostname,
      port: Number(url.port),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...fixture.requestHeaders,
        ...headers,
      },
    }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

test('fixture emits a consistent namespaced Responses call and retains only safe request metadata', async (t) => {
  const fixture = createNativeQuestionFixture({ blocking: false });
  await fixture.start();
  t.after(() => fixture.close());
  const response = await postFixture(fixture, { tools: makeTools(makeToolSchema(), { namespace: 'native' }) });
  assert.equal(response.status, 200);
  const events = response.body.trim().split(/\n\n/).map((entry) => {
    const [eventLine, dataLine] = entry.split(/\r?\n/);
    return { event: eventLine.slice('event: '.length), payload: JSON.parse(dataLine.slice('data: '.length)) };
  });
  assert.deepEqual(events.map((entry) => entry.event), [
    'response.created', 'response.output_item.added', 'response.function_call_arguments.done',
    'response.output_item.done', 'response.completed',
  ]);
  assert.equal(events[0].payload.response.id, events.at(-1).payload.response.id);
  assert.equal(events[1].payload.item.id, events[2].payload.item_id);
  assert.equal(events[2].payload.item_id, events[3].payload.item.id);
  assert.equal(events[3].payload.item.call_id, events.at(-1).payload.response.output[0].call_id);
  const call = events[3].payload.item;
  assert.equal(call.name, 'request_user_input');
  assert.equal(call.namespace, 'native');
  const argumentsValue = JSON.parse(call.arguments);
  assert.equal(argumentsValue.isBlocking, false);
  assert.equal(argumentsValue.questions.length, 2);
  assert.equal(argumentsValue.questions[1].isOther, true);
  assert.equal(argumentsValue.questions[1].options.length, 2);
  assert.equal(fixture.callSummary.target_tool, 'request_user_input');
  const retained = JSON.stringify(fixture.requests);
  assert.equal(retained.includes(fixture.requestHeaders['X-Poc160-Token']), false);
  assert.equal(retained.includes(QUESTION_TEMPLATES[0].question), false);
  assert.deepEqual(Object.keys(fixture.requests[0]), [
    'path', 'top_level_fields', 'tool_names', 'tool_schema_keys', 'question_tool_declared', 'question_tool_schema',
  ]);
});

test('fixture rejects a wrong Host and any Origin without recording the request', async (t) => {
  const fixture = createNativeQuestionFixture();
  await fixture.start();
  t.after(() => fixture.close());
  const wrongHost = await postFixture(fixture, {}, { Host: '127.0.0.1:1' });
  const withOrigin = await postFixture(fixture, {}, { Origin: 'http://example.invalid' });
  assert.equal(wrongHost.status, 403);
  assert.equal(withOrigin.status, 403);
  assert.deepEqual(fixture.requests, []);
  assert.equal(withOrigin.headers['access-control-allow-origin'], undefined);
  assert.equal(withOrigin.headers['x-frame-options'], 'DENY');
});

test('fixture refuses schema shapes that cannot represent the requested values', () => {
  const schema = makeToolSchema();
  schema.properties.questions.minItems = 3;
  assert.deepEqual(findQuestionCallPlan(makeTools(schema)), { error: 'question_count_minimum_unsupported' });
  const blockingUnavailable = makeToolSchema();
  delete blockingUnavailable.properties.isBlocking;
  blockingUnavailable.required = ['questions'];
  assert.deepEqual(findQuestionCallPlan(makeTools(blockingUnavailable), { blocking: false }), { error: 'blocking_not_configurable' });
  const freeFormUnavailable = makeToolSchema();
  delete freeFormUnavailable.properties.questions.items.properties.isOther;
  freeFormUnavailable.properties.questions.items.required = ['id', 'header', 'question', 'options', 'isSecret'];
  assert.deepEqual(findQuestionCallPlan(makeTools(freeFormUnavailable)), { error: 'free_form_schema_unsupported' });
  assert.equal(findQuestionCallPlan(makeTools(freeFormUnavailable), { questionProfile: 'single' }).value.arguments.questions.length, 1);
});

test('single-choice profile is explicit and reports the free-form schema gap without changing the profile', async (t) => {
  const fixture = createNativeQuestionFixture({ questionProfile: 'single' });
  await fixture.start();
  t.after(() => fixture.close());
  const parameters = makeToolSchema();
  delete parameters.properties.questions.items.properties.isOther;
  parameters.properties.questions.items.required = ['id', 'header', 'question', 'options', 'isSecret'];
  const response = await postFixture(fixture, { tools: makeTools(parameters) });
  assert.equal(response.status, 200);
  assert.equal(fixture.unsupported, null);
  assert.equal(fixture.callSummary.question_profile, 'single');
  assert.deepEqual(fixture.callSummary.question_ids, ['poc160_choice']);
  assert.equal(fixture.requests[0].question_tool_declared, true);
  assert.equal(fixture.requests[0].question_tool_schema.is_other_declared, false);
});

test('answer output requires an exact question-ID map and rejects error text with matching substrings', () => {
  const exact = { answers: fixedAnswerPayload() };
  const matched = inspectFixedAnswerOutput({ input: [{
    type: 'function_call_output', call_id: 'fixture-call-001', output: JSON.stringify(exact),
  }] }, 'fixture-call-001');
  assert.equal(matched.answers_structurally_match, true);
  assert.equal(matched.answer_encoding, 'question_id_map');
  const misleading = inspectFixedAnswerOutput({ input: [{
    type: 'function_call_output', call_id: 'fixture-call-001',
    output: `Error: ${Object.values(fixedAnswerPayload()).map((answer) => answer.answers[0]).join(' ')}`,
  }] }, 'fixture-call-001');
  assert.equal(misleading.fixed_answer_strings_present, true);
  assert.equal(misleading.answers_structurally_match, false);
  const modeErrorText = 'request_user_input is not available in Default mode';
  const modeError = inspectFixedAnswerOutput({ input: [{
    type: 'function_call_output', call_id: 'fixture-call-001', output: modeErrorText,
  }] }, 'fixture-call-001');
  assert.equal(modeError.tool_output_error_kind, 'default_mode_unavailable');
  assert.equal(JSON.stringify(modeError).includes(modeErrorText), false);
});

test('native runner accepts explicit plan and fixed free-text answer selection', () => {
  const options = parseArguments([
    '--codex-path', 'codex.exe', '--out', 'poc/out/poc160-native-parse',
    '--mode', 'plan', '--question-profile', 'single', '--answer-kind', 'free-text',
  ]);
  assert.equal(options.mode, 'plan');
  assert.equal(options.questionProfile, 'single');
  assert.equal(options.answerKind, 'free-text');
});

test('native question requests are answered once only after exact thread, turn, and fixture-item correlation', async () => {
  const client = makeFakeClient();
  const fixture = makeFixtureSummary();
  const ledger = createQuestionRpcLedger(client, fixture, { threadId: THREAD_ID, requestedMode: 'plan' });
  const params = makeQuestionParams();
  const questionRpc = rpc('item/tool/requestUserInput', params, 'question-1');
  client.dispatchText(questionRpc);
  assert.equal(client.sent.length, 0);
  assert.equal(ledger.pendingQuestion.projection.turn_matches, false);
  assert.equal(bindQuestionTurn(ledger, client, TURN_ID), true);
  client.dispatchText(questionRpc);
  await new Promise(setImmediate);
  assert.equal(client.sent.length, 1);
  assert.equal(ledger.responseSentCount, 1);
  assert.equal(ledger.duplicateQuestionRequestCount, 1);
  client.dispatchText(rpc('item/commandExecution/requestApproval', { command: 'never retained' }, 9));
  client.dispatchText(rpc('serverRequest/resolved', { requestId: 9 }));
  assert.equal(ledger.correlatedResolvedCount, 0);
  client.dispatchText(rpc('serverRequest/resolved', { requestId: 'question-1' }));
  client.dispatchText(rpc('turn/completed', { turn: { id: TURN_ID, status: 'completed' } }));
  client.dispatchText(rpc('thread/settings/updated', {
    threadId: THREAD_ID,
    threadSettings: {
      collaborationMode: {
        mode: 'plan',
        settings: { model: require('./native-fixture').FIXTURE_MODEL, developer_instructions: null, reasoning_effort: null },
      },
      preview: 'must not be retained',
    },
  }));
  assert.equal(client.sent.length, 1);
  const summary = summarizeRpcLedger(ledger, fixture.callSummary, TURN_ID);
  assert.equal(summary.question_schema_supported, true);
  assert.equal(summary.correlated_id_kind, 'output_item_id');
  assert.equal(summary.correlated_resolved_request_count, 1);
  assert.equal(summary.server_request_counts.command_approval, 1);
  assert.equal(summary.requested_mode, 'plan');
  assert.equal(summary.observed_mode, 'plan');
  assert.equal(summary.observed_mode_matches_request, true);
  assert.equal(JSON.stringify(summary).includes(QUESTION_TEMPLATES[0].question), false);
  assert.equal(JSON.stringify(summary).includes('never retained'), false);
  assert.equal(JSON.stringify(summary).includes('must not be retained'), false);
});

test('function-call IDs correlate only to the controlled fixture call and preserve runtime-added free-form state', async () => {
  const client = makeFakeClient();
  const fixture = makeSingleFixtureSummary();
  const ledger = createQuestionRpcLedger(client, fixture, {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    requestedMode: 'plan',
  });
  const question = QUESTION_TEMPLATES[0];
  const params = makeQuestionParams({ itemId: fixture.callSummary.call_id });
  params.questions = params.questions.slice(0, 1);
  params.questions[0].isOther = true;
  client.dispatchText(rpc('item/tool/requestUserInput', params, 'question-call-id'));
  await new Promise(setImmediate);
  assert.equal(client.sent.length, 1);
  assert.deepEqual(client.sent[0].result, { answers: fixedAnswerPayload([question.id], 'choice') });
  const summary = summarizeRpcLedger(ledger, fixture.callSummary, TURN_ID);
  assert.equal(summary.fixture_item_match, false);
  assert.equal(summary.fixture_call_id_match, true);
  assert.equal(summary.correlated_id_kind, 'function_call_id');
  assert.equal(summary.model_tool_schema_is_other_declared, false);
  assert.equal(summary.questions[0].free_form_enabled, true);
  assert.equal(summary.questions[0].free_form_source, 'runtime_added');
  assert.equal(summary.questions[0].is_other_matches_model_schema, null);
  assert.equal(summary.questions[0].template_match, true);
});

test('declared isOther mismatches and free-text answer without native free-form support are rejected', async () => {
  const fixture = makeSingleFixtureSummary();
  fixture.callSummary.schema_summary.is_other_declared = true;
  for (const [answerKind, isOther, expectedRejection] of [
    ['choice', true, 'origin_or_identity_unverified'],
    ['free-text', false, 'free_text_not_enabled'],
  ]) {
    const client = makeFakeClient();
    const ledger = createQuestionRpcLedger(client, fixture, {
      threadId: THREAD_ID,
      turnId: TURN_ID,
      answerKind,
    });
    const params = makeQuestionParams({ itemId: fixture.callSummary.call_id });
    params.questions = params.questions.slice(0, 1);
    params.questions[0].isOther = isOther;
    client.dispatchText(rpc('item/tool/requestUserInput', params, `question-${answerKind}`));
    await new Promise(setImmediate);
    assert.equal(client.sent.length, 0, answerKind);
    assert.equal(ledger.question.questions[0].is_other_matches_model_schema, isOther === false, answerKind);
    assert.equal(ledger.question.rejection, expectedRejection, answerKind);
  }
});

test('free-text answers require observed native isOther and match the exact question-ID map', async () => {
  const client = makeFakeClient();
  const fixture = makeSingleFixtureSummary();
  const question = QUESTION_TEMPLATES[0];
  const ledger = createQuestionRpcLedger(client, fixture, {
    threadId: THREAD_ID,
    turnId: TURN_ID,
    answerKind: 'free-text',
  });
  const params = makeQuestionParams({ itemId: fixture.callSummary.call_id });
  params.questions = params.questions.slice(0, 1);
  params.questions[0].isOther = true;
  client.dispatchText(rpc('item/tool/requestUserInput', params, 'question-free-text'));
  await new Promise(setImmediate);
  assert.deepEqual(client.sent[0].result, { answers: fixedAnswerPayload([question.id], 'free-text') });
  assert.equal(client.sent[0].result.answers[question.id].answers[0], 'fixture free text');
  assert.equal(question.options.some((option) => option.label === client.sent[0].result.answers[question.id].answers[0]), false);
  const answer = inspectFixedAnswerOutput({ input: [{
    type: 'function_call_output', call_id: fixture.callSummary.call_id,
    output: JSON.stringify(client.sent[0].result),
  }] }, fixture.callSummary.call_id, [question.id], 'free-text');
  assert.equal(answer.answers_structurally_match, true);
});

test('secret, mismatched, and malformed questions never receive a fixture answer', async () => {
  for (const [label, params] of [
    ['secret', makeQuestionParams({ isSecret: true })],
    ['wrong item', makeQuestionParams({ itemId: 'unrelated-item' })],
    ['unknown field', { ...makeQuestionParams(), raw: 'private' }],
  ]) {
    const client = makeFakeClient();
    const fixture = makeFixtureSummary();
    const ledger = createQuestionRpcLedger(client, fixture, { threadId: THREAD_ID, turnId: TURN_ID });
    client.dispatchText(rpc('item/tool/requestUserInput', params, `request-${label.replace(/\W/g, '')}`));
    await new Promise(setImmediate);
    assert.equal(client.sent.length, 0, label);
    assert.notEqual(ledger.question && ledger.question.rejection, null, label);
    if (label === 'wrong item') assert.equal(ledger.question.correlated_id_kind, 'unknown');
  }
});

test('native question mode reports unavailable separately from an exact answered flow', () => {
  const unavailable = classifyQuestionOutcome({
    fixtureUnsupported: 'request_user_input_unavailable',
    terminal: true,
    fixtureCall: null,
    nativeQuestion: {},
    fixtureAnswer: {},
  });
  assert.deepEqual(unavailable, { outcome: 'tool_unavailable', questionsSupported: false, flowSucceeded: false });
  const unsupportedProfile = classifyQuestionOutcome({
    fixtureUnsupported: 'free_form_schema_unsupported', terminal: true,
    fixtureCall: null, nativeQuestion: {}, fixtureAnswer: {},
  });
  assert.deepEqual(unsupportedProfile, {
    outcome: 'fixture_input_profile_unsupported', questionsSupported: null, flowSucceeded: false,
  });
  const nativeDispatchUnobserved = classifyQuestionOutcome({
    fixtureUnsupported: null, terminal: true, fixtureCall: {}, nativeQuestion: { question_request_count: 0 },
    fixtureAnswer: { call_output_seen: true, tool_output_error_kind: 'unclassified_text' },
  });
  assert.deepEqual(nativeDispatchUnobserved, {
    outcome: 'native_dispatch_not_observed', questionsSupported: null, flowSucceeded: false,
  });
  const fixtureCall = makeFixtureSummary().callSummary;
  const nativeQuestion = {
    question_origin: 'fixture_call_correlated', question_schema_supported: true,
    thread_id_match: true, turn_id_match: true, fixture_item_match: true,
    correlated_id_kind: 'output_item_id',
    response_sent_count: 1, correlated_resolved_request_count: 1, turn_status: 'completed',
  };
  assert.equal(questionFlowSucceeded(fixtureCall, nativeQuestion, { answers_structurally_match: false }), false);
  const answered = classifyQuestionOutcome({
    fixtureUnsupported: null, terminal: true, fixtureCall, nativeQuestion,
    fixtureAnswer: { answers_structurally_match: true },
  });
  assert.deepEqual(answered, { outcome: 'answered', questionsSupported: true, flowSucceeded: true });
});

test('native-home cleanup removes only a UUID directory below the selected poc/out fixture', () => {
  const output = path.join(__dirname, '..', 'out', `poc160-native-test-${randomUUID()}`);
  const home = path.join(output, 'runtime-homes', randomUUID());
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(path.join(home, 'config.toml'), 'private fixture\n');
  assert.equal(removeRuntimeHome(output, home), true);
  assert.equal(fs.existsSync(home), false);
  assert.equal(removeRuntimeHome(output, path.join(output, 'home')), false);
  fs.rmSync(output, { recursive: true, force: true });
});

test('startup failure still closes fixture, removes owned HOME, and unregisters signal handlers', async () => {
  const output = path.join(__dirname, '..', 'out', `poc160-native-test-${randomUUID()}`);
  const runtimeHome = path.join(output, 'runtime-homes', randomUUID());
  fs.mkdirSync(runtimeHome, { recursive: true });
  const signalSource = new EventEmitter();
  let fixtureClosed = false;
  const result = await require('./native-runner').runNativeProbe({
    codexPath: path.join(output, 'unused-codex.exe'),
    outputDirectory: output,
    timeoutMs: 1000,
  }, {
    signalSource,
    setup: () => ({ output, home: path.join(output, 'home'), repo: path.join(output, 'repo') }),
    validatePaths: () => ({ executable: path.join(output, 'unused-codex.exe'), layout: {} }),
    createRuntimeHome: () => ({ output, home: runtimeHome, repo: path.join(output, 'repo'), configPath: path.join(runtimeHome, 'config.toml') }),
    createFixture: () => ({
      async start() { throw Object.assign(new Error('private error'), { kind: 'fixture_start_failed' }); },
      async close() { fixtureClosed = true; },
    }),
  });
  assert.equal(result.result.success, false);
  assert.equal(result.result.failure_reasons.includes('fixture_start_failed'), true);
  assert.equal(fixtureClosed, true);
  assert.equal(result.result.cleanup.native_home_removed, true);
  assert.equal(fs.existsSync(runtimeHome), false);
  assert.equal(signalSource.listenerCount('SIGINT'), 0);
  assert.equal(signalSource.listenerCount('SIGTERM'), 0);
  fs.rmSync(output, { recursive: true, force: true });
});
