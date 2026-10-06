'use strict';

const assert = require('node:assert/strict');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');
const {
  MAX_LINE_BYTES,
  MAX_SESSION_INPUT_BYTES,
  POLL_TOOL,
  REGISTER_TOOL,
  attachBoundedReader,
  createMcpServer,
  createRunnerServer,
  toolDefinitions,
} = require('./mcp-server');
const { DecisionQuestionsBroker } = require('./decision-model');
const {
  callOutputHasTimeout,
  callOutputSummary,
  createChildCollector,
  createResponsesFixture,
  SERVER_LABEL,
  summarizeRun,
} = require('./run-common-mcp');

const QUESTION = {
  id: 'format',
  text: 'Which output format should the report use?',
  mode: 'single',
  options: [{ id: 'json', label: 'JSON' }, { id: 'csv', label: 'CSV' }],
  allowFreeText: false,
  recommendedOptionId: 'json',
};

function createBroker(now = () => 1000) {
  const calls = [];
  const requests = new Map();
  const broker = {
    calls,
    register(input) {
      calls.push({ method: 'register', input });
      const request = {
        ...input,
        state: 'pending',
        createdAt: now(),
        deadlineAt: now() + input.timeoutMinutes * 60_000,
        held: false,
        deadlineEvaluated: false,
        chosen: null,
        applied: null,
        lateAnswer: null,
        deliveryState: 'none',
      };
      requests.set(JSON.stringify([input.hostId, input.homeScope, input.threadId, input.requestId]), request);
      return { accepted: true, request: structuredClone(request) };
    },
    submitAnswer(input) {
      calls.push({ method: 'submitAnswer', input });
      const request = requests.get(JSON.stringify([input.hostId, input.homeScope, input.threadId, input.requestId]));
      if (!request) return { accepted: false };
      request.chosen = { answers: input.answers };
      request.applied = { kind: 'chosen', answers: input.answers };
      request.state = 'chosen';
      return { accepted: true };
    },
    poll(input) {
      calls.push({ method: 'poll', input });
      const request = requests.get(JSON.stringify([input.hostId, input.homeScope, input.threadId, input.requestId]));
      if (!request) return { found: false, reason: 'not_found' };
      if (now() >= request.deadlineAt && request.state === 'pending') {
        request.state = 'provisional';
        request.deadlineEvaluated = true;
        request.applied = { kind: 'provisional', answers: [{ questionId: 'format', optionIds: ['json'] }] };
      }
      return { found: true, request };
    },
  };
  return broker;
}

function toolCall(server, id, name, args, meta = { threadId: 'thread-1' }) {
  return server.handleRequest({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args, _meta: meta },
  });
}

function parseToolResult(response) {
  assert.equal(response.jsonrpc, '2.0');
  return JSON.parse(response.result.content[0].text);
}

test('Responses fixture applies frame-isolation headers to SSE and rejected authentication responses', async () => {
  const fixture = createResponsesFixture('selected');
  const expectedHeaders = {
    'x-frame-options': 'DENY',
    'content-security-policy': "frame-ancestors 'none'",
    'cross-origin-resource-policy': 'same-origin',
    'cross-origin-opener-policy': 'same-origin',
  };
  const assertHeaders = response => {
    for (const [name, value] of Object.entries(expectedHeaders)) {
      assert.equal(response.headers.get(name), value, `${name} must isolate fixture responses`);
    }
  };

  try {
    await fixture.start();
    const denied = await fetch(`${fixture.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'x-poc160-token': 'invalid-token' },
      body: '{}',
    });
    assert.equal(denied.status, 403);
    assertHeaders(denied);

    const accepted = await fetch(`${fixture.baseUrl}/responses`, {
      method: 'POST',
      headers: { 'x-poc160-token': fixture.token, 'content-type': 'application/json' },
      body: JSON.stringify({
        tools: [{ server_label: SERVER_LABEL, allowed_tools: [REGISTER_TOOL, POLL_TOOL] }],
      }),
    });
    assert.equal(accepted.status, 200);
    assert.equal(accepted.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    assertHeaders(accepted);
    const events = await accepted.text();
    assert.match(events, /event: response\.created/);
    assert.match(events, /event: response\.completed/);
  } finally {
    await fixture.close();
  }
});

test('tool inventory exposes only ordinary register and immediate poll tools with truthful mutation hints', async () => {
  const server = createMcpServer({ broker: createBroker(), hostId: 'host-1', homeScope: 'scope-1' });
  const response = await server.handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  const tools = response.result.tools;
  assert.deepEqual(tools.map(tool => tool.name), [REGISTER_TOOL, POLL_TOOL]);
  assert.ok(tools.every(tool => tool.annotations.readOnlyHint === false));
  assert.ok(tools.every(tool => tool.inputSchema.additionalProperties === false));
  assert.equal(JSON.stringify(tools).includes('permission'), false);
  assert.equal(JSON.stringify(tools).includes('approval'), false);
});

test('register fixes provenance and scope, returns pending, then poll exposes a fixture-selected answer', async () => {
  const broker = createBroker();
  const server = createMcpServer({
    broker,
    hostId: 'host-owned',
    homeScope: 'scope-owned',
    fixtureMode: 'selected',
    randomId: () => 'fixture-submission',
  });
  const registered = parseToolResult(await toolCall(server, 1, REGISTER_TOOL, {
    requestId: 'request-1', timeoutMinutes: 5, questions: [QUESTION],
  }));
  assert.equal(registered.state, 'pending');
  assert.equal(registered.fixture_selection_injected, true);
  assert.equal(registered.selected_answers, null);
  const registration = broker.calls.find(call => call.method === 'register').input;
  assert.deepEqual({
    provenance: registration.provenance,
    category: registration.category,
    hostId: registration.hostId,
    homeScope: registration.homeScope,
    threadId: registration.threadId,
    requestId: registration.requestId,
  }, {
    provenance: 'common_mcp',
    category: 'ordinary',
    hostId: 'host-owned',
    homeScope: 'scope-owned',
    threadId: 'thread-1',
    requestId: 'request-1',
  });
  const polled = parseToolResult(await toolCall(server, 2, POLL_TOOL, { requestId: 'request-1' }));
  assert.equal(polled.state, 'chosen');
  assert.deepEqual(polled.selected_answers, [{ question_id: 'format', option_ids: ['csv'] }]);
  assert.equal(polled.provisional_answers, null);
  assert.equal(broker.calls.some(call => ['claimDelivery', 'acknowledgeDelivery'].includes(call.method)), false);
  assert.equal(JSON.stringify(polled).includes('fixture-submission'), false);
});

test('fixture deadline advancement returns a provisional recommendation separately from a chosen answer', async () => {
  let nowMs = 1000;
  const broker = createBroker(() => nowMs);
  const server = createMcpServer({
    broker,
    hostId: 'host-1',
    homeScope: 'scope-1',
    fixtureMode: 'fallback',
    setNow(value) { nowMs = value; },
  });
  const registered = parseToolResult(await toolCall(server, 1, REGISTER_TOOL, {
    requestId: 'request-2', timeoutMinutes: 1, questions: [QUESTION],
  }));
  assert.equal(registered.state, 'pending');
  const polled = parseToolResult(await toolCall(server, 2, POLL_TOOL, { requestId: 'request-2' }));
  assert.equal(polled.state, 'provisional');
  assert.equal(polled.fixture_deadline_advanced, true);
  assert.equal(polled.selected_answers, null);
  assert.deepEqual(polled.provisional_answers, [{ question_id: 'format', option_ids: ['json'] }]);
});

test('thread metadata is required and caller arguments cannot override the owned destination', async () => {
  const broker = createBroker();
  const server = createMcpServer({ broker, hostId: 'host-1', homeScope: 'scope-1' });
  const missing = parseToolResult(await toolCall(server, 1, REGISTER_TOOL, {
    requestId: 'request-3', timeoutMinutes: 5, questions: [QUESTION],
  }, null));
  assert.equal(missing.error, 'invalid_thread_metadata');
  const unsafe = parseToolResult(await toolCall(server, 2, REGISTER_TOOL, {
    requestId: 'request-3', timeoutMinutes: 5, questions: [QUESTION],
  }, { threadId: 'sk-secret-value' }));
  assert.equal(unsafe.error, 'invalid_thread_metadata');
  const wrongScope = parseToolResult(await toolCall(server, 3, REGISTER_TOOL, {
    requestId: 'request-3', timeoutMinutes: 5, questions: [QUESTION],
  }, { threadId: 'thread-1', homeScope: 'scope-other' }));
  assert.equal(wrongScope.error, 'wrong_scope');
  const override = parseToolResult(await toolCall(server, 4, REGISTER_TOOL, {
    requestId: 'request-3', timeoutMinutes: 5, questions: [QUESTION], hostId: 'host-other',
  }));
  assert.equal(override.error, 'invalid_request');
  assert.equal(broker.calls.filter(call => call.method === 'register').length, 0);
});

test('wrong request and thread scopes cannot poll a registration', async () => {
  const broker = createBroker();
  const server = createMcpServer({ broker, hostId: 'host-1', homeScope: 'scope-1' });
  await toolCall(server, 1, REGISTER_TOOL, { requestId: 'request-4', timeoutMinutes: 5, questions: [QUESTION] });
  const wrongThread = parseToolResult(await toolCall(server, 2, POLL_TOOL, { requestId: 'request-4' }, { threadId: 'thread-other' }));
  assert.equal(wrongThread.error, 'unknown_request');
  const wrongHome = parseToolResult(await toolCall(server, 3, POLL_TOOL, { requestId: 'request-4', homeScope: 'scope-other' }));
  assert.equal(wrongHome.error, 'invalid_request');
});

test('delayed polling is enabled only by an explicit fixture mode', async () => {
  const ordinary = createMcpServer({ broker: createBroker(), hostId: 'host-1', homeScope: 'scope-1' });
  const delayed = createMcpServer({
    broker: createBroker(), hostId: 'host-1', homeScope: 'scope-1', fixtureMode: 'long-poll', fixtureDelayMs: 120,
  });
  await toolCall(ordinary, 1, REGISTER_TOOL, { requestId: 'normal-poll', timeoutMinutes: 5, questions: [QUESTION] });
  await toolCall(delayed, 2, REGISTER_TOOL, { requestId: 'delayed-poll', timeoutMinutes: 5, questions: [QUESTION] });
  const start = Date.now();
  await toolCall(ordinary, 3, POLL_TOOL, { requestId: 'normal-poll' });
  const ordinaryDurationMs = Date.now() - start;
  const delayedStart = Date.now();
  await toolCall(delayed, 4, POLL_TOOL, { requestId: 'delayed-poll' });
  assert.ok(Date.now() - delayedStart >= 100);
  assert.ok(ordinaryDurationMs < 100);
});

test('stdio request lines and total input bytes are bounded', async () => {
  async function exchange(inputText) {
    const input = new PassThrough();
    const chunks = [];
    const output = new Writable({ write(chunk, encoding, callback) { chunks.push(Buffer.from(chunk)); callback(); } });
    attachBoundedReader(input, output, { broker: createBroker(), hostId: 'host-1', homeScope: 'scope-1' });
    input.end(inputText);
    await new Promise(resolve => setTimeout(resolve, 20));
    return Buffer.concat(chunks).toString('utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  }

  const lineLimited = await exchange(`${'x'.repeat(MAX_LINE_BYTES + 1)}\n`);
  assert.equal(lineLimited.length, 1);
  assert.equal(lineLimited[0].error.code, -32700);
  const totalLimited = await exchange('x'.repeat(MAX_SESSION_INPUT_BYTES + 1));
  assert.equal(totalLimited.length, 1);
  assert.equal(totalLimited[0].error.message, 'Request limit exceeded');
});

test('ordinary runner deadline follows later wall-clock reads', async () => {
  let nowMs = 1000;
  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    const normal = createRunnerServer({ POC160_HOST_ID: 'host-1', POC160_HOME_SCOPE: 'scope-1' });
    const register = (id, requestId) => normal.handleRequest({ jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: REGISTER_TOOL,
      arguments: { requestId, timeoutMinutes: 1, questions: [QUESTION] },
      _meta: { threadId: 'thread-1' },
    } });
    const first = parseToolResult(await register(1, 'clock-first'));
    nowMs = 2000;
    const second = parseToolResult(await register(2, 'clock-second'));
    assert.equal(first.deadline_at_ms, 61_000);
    assert.equal(second.deadline_at_ms, 62_000);
    nowMs = 61_001;
    const polled = parseToolResult(await toolCall(normal, 3, POLL_TOOL, { requestId: 'clock-first' }));
    assert.equal(polled.deadline_reached, true);
    assert.equal(polled.state, 'pending');
  } finally {
    Date.now = originalNow;
  }
});

test('real broker keeps an exact registration idempotent and isolates the same id by native thread', async () => {
  let nowMs = 1000;
  const broker = new DecisionQuestionsBroker({ now: () => nowMs });
  const server = createMcpServer({ broker, hostId: 'host-1', homeScope: 'scope-1' });
  const register = (id, threadId, timeoutMinutes = 1) => server.handleRequest({
    jsonrpc: '2.0', id, method: 'tools/call', params: {
      name: REGISTER_TOOL,
      arguments: { requestId: 'same-request', timeoutMinutes, questions: [QUESTION] },
      _meta: { threadId },
    },
  });
  const first = parseToolResult(await register(1, 'thread-1'));
  nowMs = 2000;
  const duplicate = parseToolResult(await register(2, 'thread-1'));
  assert.equal(first.deadline_at_ms, 61_000);
  assert.equal(duplicate.deadline_at_ms, 61_000);
  assert.equal(duplicate.state, 'pending');
  const conflict = parseToolResult(await register(3, 'thread-1', 2));
  assert.equal(conflict.error, 'registration_rejected');
  const otherThread = parseToolResult(await register(4, 'thread-2'));
  assert.equal(otherThread.deadline_at_ms, 62_000);
  const hidden = parseToolResult(await toolCall(server, 5, POLL_TOOL, { requestId: 'same-request' }, { threadId: 'thread-3' }));
  assert.equal(hidden.error, 'unknown_request');
});

test('Responses fixture identifies structured function outputs instead of matching tool arguments', () => {
  const argumentOnly = {
    input: [{ type: 'function_call', call_id: 'call_poc160_001', arguments: '{"requestId":"poc160-fixture-request"}' }],
  };
  assert.deepEqual(callOutputSummary(argumentOnly, 'call_poc160_001', 'poc160-fixture-request'), {
    output_found: false,
    request_id_matches: false,
    state: null,
    selected_answer_count: 0,
    provisional_answer_count: 0,
  });
  const functionOutput = {
    input: [{
      type: 'function_call_output',
      call_id: 'call_poc160_001',
      output: JSON.stringify({ request_id: 'poc160-fixture-request', state: 'chosen', selected_answers: [{ question_id: 'format' }] }),
    }],
  };
  const result = callOutputSummary(functionOutput, 'call_poc160_001', 'poc160-fixture-request');
  assert.equal(result.output_found, true);
  assert.equal(result.request_id_matches, true);
  assert.equal(result.state, 'chosen');
  assert.equal(callOutputHasTimeout({ input: [{ type: 'function_call_output', call_id: 'call_poc160_002', output: 'permission denied' }] }, 'call_poc160_002'), false);
  assert.equal(callOutputHasTimeout({ input: [{ type: 'function_call_output', call_id: 'call_poc160_002', output: 'MCP tool call timed out' }] }, 'call_poc160_002'), true);
});

test('native event collection keeps the actual thread ID and does not classify generic tool errors as timeouts', () => {
  const collector = createChildCollector(() => {});
  collector.consumeStdout(Buffer.from(`${JSON.stringify({ type: 'thread.started', thread_id: 'native-thread-1' })}\n`));
  collector.consumeStdout(Buffer.from(`${JSON.stringify({
    type: 'item.completed',
    item: {
      id: 'item_1', type: 'mcp_tool_call', server: 'poc160_questions', tool: 'questions_poll', status: 'failed',
      error: { message: 'MCP approval denied' },
    },
  })}\n`));
  const events = collector.finish();
  assert.deepEqual(events.native_thread_ids, ['native-thread-1']);
  assert.equal(events.tool_calls[0].timed_out, false);
  assert.equal(events.tool_calls[0].approval_denied, true);
  assert.equal(events.tool_calls[0].tool_error, true);

  const result = summarizeRun({
    mode: 'long-poll',
    version: { version: '0.160.0' },
    child: { exit_code: 0, timed_out: false, interrupted: false, spawn_error_code: 'none', events },
    fixture: {
      requestCount: 3,
      requestSteps: [
        { step: 'register' },
        { step: 'poll' },
        { step: 'complete', timeout_output_seen: false },
      ],
      pollToNextRequestMs: 1950,
      serverFailure: null,
    },
    configRestored: true,
    homeRemoved: true,
    timeoutMs: 40000,
    outputDirectory: 'D:/repo/poc/out/poc160-test',
  });
  assert.ok(result.failure_reasons.includes('long_mcp_timeout_not_observed'));

  const shortResult = summarizeRun({
    mode: 'selected',
    version: { version: '0.160.0' },
    child: {
      exit_code: 0, timed_out: false, interrupted: false, spawn_error_code: 'none',
      events: {
        native_thread_ids: ['native-thread-1'],
        tool_calls: [
          { tool: REGISTER_TOOL, result: { state: 'pending', thread_id: 'native-thread-1', fixture_selection_injected: true } },
          { tool: POLL_TOOL, status: 'completed', timed_out: false, result: { state: 'chosen', thread_id: 'native-thread-1', selected_answer_count: 1 } },
        ],
      },
    },
    fixture: {
      requestCount: 3,
      requestSteps: [{ step: 'register' }, { step: 'poll' }, { step: 'complete' }],
      pollToNextRequestMs: 5,
      serverFailure: null,
    },
    configRestored: true,
    homeRemoved: true,
    timeoutMs: 40000,
    outputDirectory: 'D:/repo/poc/out/poc160-short',
  });
  assert.equal(shortResult.native.timeout_expected, false);
  assert.equal(shortResult.native.timeout_observed, false);

  const timedOutResult = summarizeRun({
    mode: 'long-poll',
    version: { version: '0.160.0' },
    child: {
      exit_code: 0, timed_out: false, interrupted: false, spawn_error_code: 'none',
      events: {
        native_thread_ids: ['native-thread-1'],
        output_limit_exceeded: false,
        malformed_line_count: 0,
        tool_calls: [
          { tool: REGISTER_TOOL, result: { state: 'pending', thread_id: 'native-thread-1' } },
          { tool: POLL_TOOL, status: 'failed', timed_out: true, result: null },
        ],
      },
    },
    fixture: {
      requestCount: 3,
      requestSteps: [{ step: 'register' }, { step: 'poll' }, { step: 'complete', timeout_output_seen: true }],
      pollToNextRequestMs: 2006,
      serverFailure: null,
    },
    configRestored: true,
    homeRemoved: true,
    timeoutMs: 40000,
    outputDirectory: 'D:/repo/poc/out/poc160-timeout',
  });
  assert.equal(timedOutResult.measurement_success, true);
  assert.equal(timedOutResult.feature_flow_success, false);
  assert.equal(timedOutResult.native.timeout_observed, true);
  assert.equal(timedOutResult.native.register_thread_binding_matches, true);
  assert.equal(timedOutResult.native.poll_thread_binding_matches, null);
  assert.equal(timedOutResult.native.thread_binding_verified, null);
});
