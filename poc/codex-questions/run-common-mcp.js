'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes, timingSafeEqual, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { performance } = require('node:perf_hooks');
const {
  assertNoSymlinkComponents,
  resolveOutputDirectory,
  setup,
  REPOSITORY_ROOT,
  REQUIRED_CODEX_VERSION,
} = require('../codex-hooks-identity/setup');
const {
  clearFixtureConfig,
  createRuntimeHome,
  makeChildEnvironment,
  runVersionCheck,
} = require('../codex-hooks-identity/run-exec');
const { POLL_TOOL, REGISTER_TOOL, safeIdentifier } = require('./mcp-server');

const FIXTURE_MODEL = 'poc160-fixture-model';
const SERVER_LABEL = 'poc160_questions';
const TOOL_TIMEOUT_SEC = 2;
const DEFAULT_TIMEOUT_MS = 40000;
const MAX_TIMEOUT_MS = 90000;
const MAX_FIXTURE_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_CHILD_OUTPUT_BYTES = 1024 * 1024;
const MAX_EVENT_LINE_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 128 * 1024;
const CHILD_ENV_NAMES = [
  'POC160_HOST_ID', 'POC160_HOME_SCOPE', 'POC160_FIXTURE_MODE',
];
const VALID_MODES = new Set(['selected', 'fallback', 'long-poll']);
const ITEM_ID = /^[A-Za-z0-9_.:-]{1,128}$/;
const EVENT_TYPES = new Set([
  'thread.started', 'thread.closed', 'turn.started', 'turn.completed', 'turn.failed', 'turn.interrupted',
  'item.started', 'item.completed',
]);
const TOOL_STATES = new Set(['pending', 'chosen', 'provisional', 'cancelled', 'external_resolved']);
const TOOL_STATUSES = new Set(['completed', 'failed', 'error', 'cancelled', 'in_progress', 'unknown']);

function usage() {
  return 'Usage: node run-common-mcp.js --codex-path <codex.exe> --out poc/out/<fresh-slug> --mode selected|fallback|long-poll [--timeout-ms 40000]';
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--codex-path', '--out', '--mode', '--timeout-ms'].includes(option) || values.has(option) || !argv[index + 1]) {
      throw new Error(usage());
    }
    values.set(option, argv[index + 1]);
    index += 1;
  }
  if (!values.has('--codex-path') || !values.has('--out') || !VALID_MODES.has(values.get('--mode'))) throw new Error(usage());
  const timeoutMs = values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) throw new Error(usage());
  return {
    codexPath: path.resolve(values.get('--codex-path')),
    outputDirectory: values.get('--out'),
    mode: values.get('--mode'),
    timeoutMs,
  };
}

function tomlString(value) {
  return JSON.stringify(value);
}

function renderFixtureConfig(adapterPath, fixture, hostId, homeScope, mode) {
  const toolEnvironment = [...CHILD_ENV_NAMES].map(tomlString).join(', ');
  return [
    `model = ${tomlString(FIXTURE_MODEL)}`,
    'model_provider = "poc160_fixture"',
    '',
    '[model_providers.poc160_fixture]',
    'name = "Local common-question Responses fixture"',
    `base_url = ${tomlString(fixture.baseUrl)}`,
    'wire_api = "responses"',
    `http_headers = { "X-Poc160-Token" = ${tomlString(fixture.token)} }`,
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
    `[mcp_servers.${SERVER_LABEL}]`,
    'command = "node"',
    `args = [${tomlString(adapterPath)}, "--mcp"]`,
    `env_vars = [${toolEnvironment}]`,
    `tool_timeout_sec = ${TOOL_TIMEOUT_SEC}`,
    '',
  ].join('\n');
}

function validateCodexPath(codexPath) {
  const stat = fs.lstatSync(codexPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('--codex-path must be a regular file');
}

function readRequest(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let sizeBytes = 0;
    let exceeded = false;
    request.on('data', chunk => {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      sizeBytes += data.length;
      if (sizeBytes > MAX_FIXTURE_REQUEST_BYTES) {
        exceeded = true;
        chunks.length = 0;
        return;
      }
      if (!exceeded) chunks.push(data);
    });
    request.on('end', () => {
      if (exceeded) return reject(new Error('request_limit'));
      const contents = Buffer.concat(chunks, sizeBytes);
      try {
        const text = contents.toString('utf8');
        const body = JSON.parse(text);
        resolve({ body, sizeBytes });
      } catch {
        reject(new Error('invalid_json'));
      }
    });
    request.on('error', () => reject(new Error('request_error')));
  });
}

function collectQuestionTools(value, names = new Set(), depth = 0) {
  if (depth > 12 || value === null || value === undefined) return names;
  if (Array.isArray(value)) {
    for (const item of value) collectQuestionTools(item, names, depth + 1);
    return names;
  }
  if (typeof value !== 'object') return names;
  if (value.server_label === SERVER_LABEL && Array.isArray(value.allowed_tools)) {
    for (const name of value.allowed_tools) {
      if (typeof name === 'string') {
        const toolName = name.split('.').at(-1);
        if (toolName === REGISTER_TOOL || toolName === POLL_TOOL) names.add(toolName);
      }
    }
  }
  if (typeof value.name === 'string') {
    const parts = value.name.split('.');
    const toolName = parts.at(-1);
    if (toolName === REGISTER_TOOL || toolName === POLL_TOOL) names.add(toolName);
  }
  for (const child of Object.values(value)) collectQuestionTools(child, names, depth + 1);
  return names;
}

function parseStructuredValue(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (value.length > MAX_EVENT_LINE_BYTES) return null;
    try { return parseStructuredValue(JSON.parse(value), depth + 1); } catch { return null; }
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const parsed = parseStructuredValue(item, depth + 1);
      if (parsed) return parsed;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  if (safeIdentifier(value.request_id) && TOOL_STATES.has(value.state)) {
    return {
      request_id: value.request_id,
      state: value.state,
      selected_answer_count: Array.isArray(value.selected_answers) ? Math.min(3, value.selected_answers.length) : 0,
      provisional_answer_count: Array.isArray(value.provisional_answers) ? Math.min(3, value.provisional_answers.length) : 0,
    };
  }
  if (Array.isArray(value.content)) {
    for (const item of value.content) {
      if (item && item.type === 'text' && typeof item.text === 'string') {
        const parsed = parseStructuredValue(item.text, depth + 1);
        if (parsed) return parsed;
      }
    }
  }
  for (const nested of Object.values(value)) {
    const parsed = parseStructuredValue(nested, depth + 1);
    if (parsed) return parsed;
  }
  return null;
}

function callOutputSummary(body, callId, expectedRequestId) {
  let foundOutput = null;
  function visit(value, depth = 0) {
    if (depth > 16 || value === null || value === undefined || foundOutput !== null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'string' && value.length <= MAX_EVENT_LINE_BYTES) {
      try { visit(JSON.parse(value), depth + 1); } catch {}
      return;
    }
    if (typeof value !== 'object') return;
    if (value.type === 'function_call_output' && value.call_id === callId) {
      foundOutput = value.output;
      return;
    }
    for (const nested of Object.values(value)) visit(nested, depth + 1);
  }
  visit(body && body.input);
  const parsed = parseStructuredValue(foundOutput);
  return {
    output_found: foundOutput !== null,
    request_id_matches: parsed?.request_id === expectedRequestId,
    state: parsed?.request_id === expectedRequestId ? parsed.state : null,
    selected_answer_count: parsed?.request_id === expectedRequestId ? parsed.selected_answer_count : 0,
    provisional_answer_count: parsed?.request_id === expectedRequestId ? parsed.provisional_answer_count : 0,
  };
}

function callOutputHasTimeout(body, callId) {
  let output = null;
  function visit(value, depth = 0) {
    if (depth > 16 || value === null || value === undefined || output !== null) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth + 1);
      return;
    }
    if (typeof value === 'string' && value.length <= MAX_EVENT_LINE_BYTES) {
      try { visit(JSON.parse(value), depth + 1); } catch {}
      return;
    }
    if (typeof value !== 'object') return;
    if (value.type === 'function_call_output' && value.call_id === callId) {
      output = value.output;
      return;
    }
    for (const nested of Object.values(value)) visit(nested, depth + 1);
  }
  visit(body && body.input);
  function hasTimeout(value, depth = 0) {
    if (depth > 8 || value === null || value === undefined) return false;
    if (typeof value === 'string') {
      if (value.length > MAX_EVENT_LINE_BYTES) return false;
      if (/timed?\s*out|mcp\s+timeout|timeout\s+exceeded/i.test(value)) return true;
      try { return hasTimeout(JSON.parse(value), depth + 1); } catch { return false; }
    }
    if (Array.isArray(value)) return value.some(item => hasTimeout(item, depth + 1));
    if (typeof value !== 'object') return false;
    return Object.values(value).some(item => hasTimeout(item, depth + 1));
  }
  return hasTimeout(output);
}

function responseBase(id, createdAt, output = [], status = 'completed') {
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    completed_at: createdAt,
    error: null,
    incomplete_details: null,
    model: FIXTURE_MODEL,
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    store: false,
    usage: null,
  };
}

function responseEvents(number, tool, argumentsValue) {
  const id = `resp_poc160_${String(number).padStart(3, '0')}`;
  const itemId = `fc_poc160_${String(number).padStart(3, '0')}`;
  const callId = `call_poc160_${String(number).padStart(3, '0')}`;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const args = JSON.stringify(argumentsValue);
  const item = {
    id: itemId,
    type: 'function_call',
    status: 'completed',
    call_id: callId,
    name: tool,
    namespace: `mcp__${SERVER_LABEL}`,
    arguments: args,
  };
  let sequence = 0;
  const event = (type, values) => ({ type, ...values, sequence_number: sequence++ });
  return [
    event('response.created', { response: responseBase(id, nowSeconds, [], 'in_progress') }),
    event('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } }),
    event('response.function_call_arguments.done', { item_id: itemId, output_index: 0, arguments: args }),
    event('response.output_item.done', { output_index: 0, item }),
    event('response.completed', { response: responseBase(id, nowSeconds, [item]) }),
  ];
}

function finalEvents(number) {
  const id = `resp_poc160_${String(number).padStart(3, '0')}`;
  const itemId = `msg_poc160_${String(number).padStart(3, '0')}`;
  const nowSeconds = Math.floor(Date.now() / 1000);
  const message = 'ローカルfixtureの登録とpollが完了しました。実モデルや実ダッシュボードの回答ではありません。';
  const item = {
    id: itemId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: message, annotations: [] }],
  };
  let sequence = 0;
  const event = (type, values) => ({ type, ...values, sequence_number: sequence++ });
  return [
    event('response.created', { response: responseBase(id, nowSeconds, [], 'in_progress') }),
    event('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } }),
    event('response.content_part.added', { item_id: itemId, output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } }),
    event('response.output_text.delta', { item_id: itemId, output_index: 0, content_index: 0, delta: message }),
    event('response.output_text.done', { item_id: itemId, output_index: 0, content_index: 0, text: message }),
    event('response.content_part.done', { item_id: itemId, output_index: 0, content_index: 0, part: item.content[0] }),
    event('response.output_item.done', { output_index: 0, item }),
    event('response.completed', { response: responseBase(id, nowSeconds, [item]) }),
  ];
}

function writeEvents(response, events) {
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  response.end();
}

function createResponsesFixture(mode) {
  const token = randomBytes(32).toString('hex');
  const requestSteps = [];
  let requestCount = 0;
  let pollRequestAt = null;
  let pollToNextRequestMs = null;
  let serverFailure = null;
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    let url;
    try {
      url = new URL(request.url, 'http://127.0.0.1');
    } catch {
      request.resume();
      response.writeHead(400).end();
      return;
    }
    if (request.method !== 'POST' || !['/responses', '/v1/responses'].includes(url.pathname)) {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    const address = server.address();
    const expectedHost = address && typeof address === 'object' ? `127.0.0.1:${address.port}` : '';
    const supplied = request.headers['x-poc160-token'];
    const tokenMatches = typeof supplied === 'string' && Buffer.byteLength(supplied) === Buffer.byteLength(token)
      && timingSafeEqual(Buffer.from(supplied), Buffer.from(token));
    if (request.headers.host !== expectedHost || Object.hasOwn(request.headers, 'origin') || !tokenMatches) {
      request.resume();
      response.writeHead(403).end();
      return;
    }

    let received;
    try {
      received = await readRequest(request);
    } catch (error) {
      serverFailure = error.message === 'request_limit' ? 'request_limit' : 'invalid_request';
      response.writeHead(error.message === 'request_limit' ? 413 : 400).end();
      return;
    }
    requestCount += 1;
    const availableTools = collectQuestionTools(received.body.tools);
    const step = requestCount === 1 ? 'register' : requestCount === 2 ? 'poll' : 'complete';
    const previousRegistration = step === 'poll'
      ? callOutputSummary(received.body, 'call_poc160_001', 'poc160-fixture-request')
      : null;
    const previousPoll = step === 'complete'
      ? callOutputSummary(received.body, 'call_poc160_002', 'poc160-fixture-request')
      : null;
    const timeoutOutputSeen = step === 'complete' ? callOutputHasTimeout(received.body, 'call_poc160_002') : null;
    const summary = {
      step,
      body_bytes: received.sizeBytes,
      register_tool_declared: availableTools.has(REGISTER_TOOL),
      poll_tool_declared: availableTools.has(POLL_TOOL),
      register_output_seen: previousRegistration?.output_found === true,
      register_result_id_matches: previousRegistration?.request_id_matches === true,
      poll_output_seen: previousPoll?.output_found === true,
      poll_result_id_matches: previousPoll?.request_id_matches === true,
      poll_result_state: previousPoll?.state || null,
      poll_selected_answer_count: previousPoll?.selected_answer_count || 0,
      poll_provisional_answer_count: previousPoll?.provisional_answer_count || 0,
      timeout_output_seen: timeoutOutputSeen,
      fixture_response_stage: step,
    };
    requestSteps.push(summary);

    if (step === 'register') {
      if (!availableTools.has(REGISTER_TOOL) || !availableTools.has(POLL_TOOL)) {
        serverFailure = 'expected_tools_missing';
        writeEvents(response, finalEvents(requestCount));
        return;
      }
      writeEvents(response, responseEvents(requestCount, REGISTER_TOOL, {
        requestId: 'poc160-fixture-request',
        timeoutMinutes: 1,
        questions: [{
          id: 'format',
          text: 'Which output format should the report use?',
          mode: 'single',
          options: [{ id: 'json', label: 'JSON' }, { id: 'csv', label: 'CSV' }],
          allowFreeText: false,
          recommendedOptionId: 'json',
        }],
      }));
      return;
    }
    if (step === 'poll') {
      if (!summary.register_output_seen || !summary.register_result_id_matches) serverFailure = 'register_result_missing_from_followup';
      pollRequestAt = performance.now();
      writeEvents(response, responseEvents(requestCount, POLL_TOOL, { requestId: 'poc160-fixture-request' }));
      return;
    }
    if (pollRequestAt !== null && pollToNextRequestMs === null) pollToNextRequestMs = Math.round(performance.now() - pollRequestAt);
    const expectedResult = mode === 'fallback' ? 'provisional' : 'chosen';
    const expectedOutput = mode === 'long-poll'
      ? summary.timeout_output_seen === true
      : summary.poll_output_seen && summary.poll_result_id_matches && summary.poll_result_state === expectedResult;
    if (!expectedOutput) serverFailure = mode === 'long-poll' ? 'long_poll_timeout_output_missing' : 'poll_result_missing_from_followup';
    writeEvents(response, finalEvents(requestCount));
  });

  return {
    token,
    requestSteps,
    get requestCount() { return requestCount; },
    get pollToNextRequestMs() { return pollToNextRequestMs; },
    get serverFailure() { return serverFailure; },
    get baseUrl() {
      const address = server.address();
      return address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : null;
    },
    async start() {
      if (!server.listening) {
        await new Promise((resolve, reject) => {
          const onError = error => { server.off('listening', onListening); reject(error); };
          const onListening = () => { server.off('error', onError); resolve(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(0, '127.0.0.1');
        });
      }
      return this;
    },
    async close() {
      if (!server.listening) return;
      await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    },
  };
}

function safeToolResult(result) {
  let value = result;
  if (typeof value === 'string' && value.length <= MAX_EVENT_LINE_BYTES) {
    try { value = JSON.parse(value); } catch { return null; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  let text = null;
  if (Array.isArray(value.content) && value.content.length <= 4) {
    const textItem = value.content.find(item => item && item.type === 'text' && typeof item.text === 'string' && item.text.length <= MAX_EVENT_LINE_BYTES);
    if (textItem) text = textItem.text;
  } else if (Array.isArray(value.result?.content)) {
    const textItem = value.result.content.find(item => item && item.type === 'text' && typeof item.text === 'string' && item.text.length <= MAX_EVENT_LINE_BYTES);
    if (textItem) text = textItem.text;
  }
  if (text === null) return { is_error: value.isError === true };
  let parsed;
  try { parsed = JSON.parse(text); } catch { return { is_error: value.isError === true }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { is_error: value.isError === true };
  const selected = Array.isArray(parsed.selected_answers) ? parsed.selected_answers.length : 0;
  const provisional = Array.isArray(parsed.provisional_answers) ? parsed.provisional_answers.length : 0;
  const state = TOOL_STATES.has(parsed.state) ? parsed.state : null;
  const errorCode = typeof parsed.error === 'string' && /^[a-z_]{1,48}$/.test(parsed.error) ? parsed.error : null;
  return {
    ...(safeIdentifier(parsed.request_id) ? { request_id: parsed.request_id } : {}),
    ...(safeIdentifier(parsed.thread_id) ? { thread_id: parsed.thread_id } : {}),
    state,
    selected_answer_count: Math.min(3, selected),
    provisional_answer_count: Math.min(3, provisional),
    deadline_reached: typeof parsed.deadline_reached === 'boolean' ? parsed.deadline_reached : null,
    fixture_selection_injected: parsed.fixture_selection_injected === true,
    fixture_deadline_advanced: parsed.fixture_deadline_advanced === true,
    is_error: value.isError === true,
    error_code: errorCode,
  };
}

function createChildCollector(killChild) {
  const decoder = new StringDecoder('utf8');
  const eventCounts = new Map();
  const toolCalls = [];
  const startedItems = new Map();
  const nativeThreadIds = new Set();
  let pending = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let malformedLineCount = 0;
  let omittedEventCount = 0;
  let outputExceeded = false;
  let stderrHasWarning = false;
  let stderrHasError = false;

  function consumeLine(line) {
    if (Buffer.byteLength(line, 'utf8') > MAX_EVENT_LINE_BYTES) {
      omittedEventCount += 1;
      return;
    }
    let event;
    try { event = JSON.parse(line); } catch { malformedLineCount += 1; return; }
    if (!event || typeof event !== 'object' || Array.isArray(event) || !EVENT_TYPES.has(event.type)) return;
    eventCounts.set(event.type, (eventCounts.get(event.type) || 0) + 1);
    if (event.type === 'thread.started') {
      const nativeId = event.thread_id || event.threadId || (event.thread && event.thread.id);
      if (safeIdentifier(nativeId)) nativeThreadIds.add(nativeId);
    }
    const item = event.item && typeof event.item === 'object' && !Array.isArray(event.item) ? event.item : null;
    const itemId = item && typeof item.id === 'string' && ITEM_ID.test(item.id) ? item.id : null;
    if (event.type === 'item.started' && itemId) startedItems.set(itemId, performance.now());
    if (event.type !== 'item.completed' || !item || item.type !== 'mcp_tool_call') return;
    const server = item.server === SERVER_LABEL ? SERVER_LABEL : null;
    const tool = [REGISTER_TOOL, POLL_TOOL].includes(item.tool) ? item.tool : null;
    if (!server || !tool || toolCalls.length >= 8) return;
    const status = TOOL_STATUSES.has(item.status) ? item.status : 'unknown';
    const duration = itemId && startedItems.has(itemId) ? Math.round(performance.now() - startedItems.get(itemId)) : null;
    if (itemId) startedItems.delete(itemId);
    const safeResult = safeToolResult(item.result);
    const diagnosticText = [];
    for (const source of [item.result, item.error]) {
      if (typeof source === 'string' && source.length <= MAX_EVENT_LINE_BYTES) diagnosticText.push(source);
      else if (source && typeof source === 'object') {
        for (const entry of Array.isArray(source.content) ? source.content : []) {
          if (typeof entry?.text === 'string' && entry.text.length <= MAX_EVENT_LINE_BYTES) diagnosticText.push(entry.text);
        }
        if (typeof source.message === 'string' && source.message.length <= MAX_EVENT_LINE_BYTES) diagnosticText.push(source.message);
      }
    }
    const timeoutMentioned = diagnosticText.some(text => /\btimed?\s*out\b|timeout\s+exceeded|request\s+timeout/i.test(text));
    const approvalDenied = diagnosticText.some(text => /approval\s+(?:required|denied)|permission\s+denied|not\s+permitted|not\s+allowed/i.test(text));
    const toolError = item.result?.isError === true || ['failed', 'error', 'cancelled'].includes(status);
    toolCalls.push({
      server,
      tool,
      status,
      duration_ms: duration,
      timed_out: timeoutMentioned,
      approval_denied: approvalDenied,
      tool_error: toolError,
      result: safeResult,
    });
  }

  function consumeStdout(chunk) {
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutBytes += data.length;
    if (stdoutBytes > MAX_CHILD_OUTPUT_BYTES) {
      outputExceeded = true;
      killChild();
      return;
    }
    pending += decoder.write(data);
    let newline;
    while ((newline = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, newline).replace(/\r$/, '');
      pending = pending.slice(newline + 1);
      consumeLine(line);
    }
    if (Buffer.byteLength(pending, 'utf8') > MAX_EVENT_LINE_BYTES) {
      pending = '';
      omittedEventCount += 1;
    }
  }

  function consumeStderr(chunk) {
    const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    stderrBytes += Buffer.byteLength(text, 'utf8');
    if (/warning/i.test(text)) stderrHasWarning = true;
    if (/error|failed/i.test(text)) stderrHasError = true;
  }

  function finish() {
    pending += decoder.end();
    if (pending.trim()) consumeLine(pending.replace(/\r$/, ''));
    return {
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
      stderr_has_warning: stderrHasWarning,
      stderr_has_error: stderrHasError,
      malformed_line_count: malformedLineCount,
      omitted_event_count: omittedEventCount,
      output_limit_exceeded: outputExceeded,
      event_counts: Object.fromEntries([...eventCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
      native_thread_ids: [...nativeThreadIds].sort(),
      tool_calls: toolCalls,
    };
  }

  return { consumeStdout, consumeStderr, finish };
}

function runCodex(executable, layout, mode, timeoutMs, environment) {
  return new Promise(resolve => {
    const prompt = 'Use only questions_register with requestId "poc160-fixture-request" and then questions_poll with that same ID. Do not call any other tool. After poll returns, finish.';
    const args = ['--no-daemon', 'exec', '--json', '--ephemeral', '-C', layout.repo, '-s', 'read-only', prompt];
    const child = spawn(executable, args, {
      cwd: layout.repo,
      env: environment,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let settled = false;
    let timedOut = false;
    let interrupted = false;
    let spawnError = 'none';
    const terminate = () => { if (child.pid && !child.killed) child.kill(); };
    const collector = createChildCollector(terminate);
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);
      resolve({
        exit_code: Number.isInteger(code) ? code : 'unknown',
        signal: signal || 'none',
        timed_out: timedOut,
        interrupted,
        spawn_error_code: spawnError,
        events: collector.finish(),
      });
    };
    const onInterrupt = () => { interrupted = true; terminate(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onInterrupt);
    child.stdout.on('data', collector.consumeStdout);
    child.stderr.on('data', collector.consumeStderr);
    child.on('error', error => {
      spawnError = typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'unknown';
      finish(null, null);
    });
    child.on('close', finish);
    child.stdin.end();
  });
}

function assertOwnedRuntimeHome(outputDirectory, homeDirectory) {
  const output = path.resolve(outputDirectory);
  const runtimeRoot = path.join(output, 'runtime-homes');
  const home = path.resolve(homeDirectory);
  const relative = path.relative(runtimeRoot, home);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(relative)
    || path.isAbsolute(relative) || relative.startsWith(`..${path.sep}`)) throw new Error('Runtime home is outside the owned output directory');
  assertNoSymlinkComponents(REPOSITORY_ROOT, home);
  const rootStat = fs.lstatSync(runtimeRoot);
  const homeStat = fs.lstatSync(home);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || !homeStat.isDirectory() || homeStat.isSymbolicLink()) {
    throw new Error('Runtime home path must contain real directories');
  }
  function inspect(directory) {
    for (const name of fs.readdirSync(directory)) {
      const entry = path.resolve(directory, name);
      const relativeEntry = path.relative(output, entry);
      if (path.isAbsolute(relativeEntry) || relativeEntry === '..' || relativeEntry.startsWith(`..${path.sep}`)) {
        throw new Error('Runtime home entry escaped owned output');
      }
      const stat = fs.lstatSync(entry);
      if (stat.isSymbolicLink()) throw new Error('Runtime home contains a symbolic link');
      if (stat.isDirectory()) inspect(entry);
      else if (!stat.isFile()) throw new Error('Runtime home contains an unsupported entry');
    }
  }
  inspect(home);
  return home;
}

function cleanupRuntimeHome(outputDirectory, homeDirectory) {
  const home = assertOwnedRuntimeHome(outputDirectory, homeDirectory);
  fs.rmSync(home, { recursive: true, force: false });
  return !fs.existsSync(home);
}

function summarizeRun({ mode, version, child, fixture, configRestored, homeRemoved, timeoutMs, outputDirectory }) {
  const calls = child.events.tool_calls;
  const register = calls.find(call => call.tool === REGISTER_TOOL) || null;
  const poll = calls.find(call => call.tool === POLL_TOOL) || null;
  const expectedState = mode === 'fallback' ? 'provisional' : mode === 'selected' ? 'chosen' : null;
  const mcpCallsObserved = Boolean(register && poll);
  const nativeThreadId = child.events.native_thread_ids.length === 1 ? child.events.native_thread_ids[0] : null;
  const registerThreadBindingMatches = Boolean(nativeThreadId && register?.result?.thread_id === nativeThreadId);
  const pollThreadBindingMatches = poll?.result?.thread_id
    ? poll.result.thread_id === nativeThreadId
    : null;
  const threadBindingVerified = registerThreadBindingMatches && pollThreadBindingMatches === true ? true
    : mode === 'long-poll' && registerThreadBindingMatches && poll?.timed_out && !poll.result ? null
      : false;
  const threadBindingRequirementSatisfied = registerThreadBindingMatches
    && (mode === 'long-poll' && poll?.timed_out && !poll.result || pollThreadBindingMatches === true);
  const registerStartedPending = register?.result?.state === 'pending';
  const expectedAnswerObserved = expectedState === null || poll?.result?.state === expectedState;
  const timeoutEvidence = Boolean(poll?.timed_out || fixture.requestSteps.at(-1)?.timeout_output_seen === true);
  const timeoutObserved = mode === 'long-poll' && timeoutEvidence
    && fixture.pollToNextRequestMs !== null && fixture.pollToNextRequestMs >= 1700
    && fixture.pollToNextRequestMs < TOOL_TIMEOUT_SEC * 1000 + 1200;
  const timeoutExpectationSatisfied = mode !== 'long-poll' || timeoutObserved;
  const pollUnderTimeout = mode === 'long-poll'
    ? fixture.pollToNextRequestMs !== null && fixture.pollToNextRequestMs >= 1700 && fixture.pollToNextRequestMs < TOOL_TIMEOUT_SEC * 1000 + 1200
    : fixture.pollToNextRequestMs !== null && fixture.pollToNextRequestMs < TOOL_TIMEOUT_SEC * 1000;
  const completeFixtureSequence = fixture.requestCount >= 3 && fixture.requestSteps[0]?.step === 'register'
    && fixture.requestSteps[1]?.step === 'poll' && fixture.requestSteps.at(-1)?.step === 'complete';
  const failureReasons = [];
  if (version.version !== REQUIRED_CODEX_VERSION) failureReasons.push('codex_version_mismatch');
  if (child.exit_code !== 0 || child.timed_out || child.interrupted || child.spawn_error_code !== 'none') failureReasons.push('native_child_failed');
  if (child.events.output_limit_exceeded || child.events.malformed_line_count > 0) failureReasons.push('native_output_invalid');
  if (!completeFixtureSequence || fixture.serverFailure) failureReasons.push('fixture_exchange_incomplete');
  if (!mcpCallsObserved) failureReasons.push('register_or_poll_result_missing');
  if (!threadBindingRequirementSatisfied) failureReasons.push('native_thread_binding_unconfirmed');
  if (!registerStartedPending) failureReasons.push('registration_pending_not_observed');
  if (!expectedAnswerObserved) failureReasons.push('expected_answer_state_not_observed');
  if (!timeoutExpectationSatisfied) failureReasons.push('long_mcp_timeout_not_observed');
  if (!pollUnderTimeout) failureReasons.push('poll_timing_outside_expected_window');
  if (calls.some(call => call.approval_denied)) failureReasons.push('mcp_tool_approval_denied');
  if (!configRestored || !homeRemoved) failureReasons.push('isolated_home_cleanup_failed');
  const success = failureReasons.length === 0;
  return {
    backend: { source: 'local_responses_fixture', model: FIXTURE_MODEL, real_model_observed: false },
    mode,
    target_version: version.version,
    tool_timeout_sec: TOOL_TIMEOUT_SEC,
    fixture_poll_delay_ms: mode === 'long-poll' ? 2600 : 0,
    timeout_ms: timeoutMs,
    success,
    measurement_success: success,
    feature_flow_success: mode === 'long-poll' ? false : expectedAnswerObserved && mcpCallsObserved,
    failure_reasons: failureReasons,
    child: {
      exit_code: child.exit_code,
      signal: child.signal,
      timed_out: child.timed_out,
      interrupted: child.interrupted,
      spawn_error_code: child.spawn_error_code,
    },
    native: {
      register_and_poll_items_observed: mcpCallsObserved,
      native_thread_id: nativeThreadId,
      native_thread_id_count: child.events.native_thread_ids.length,
      register_thread_binding_matches: registerThreadBindingMatches,
      poll_thread_binding_matches: pollThreadBindingMatches,
      thread_binding_verified: threadBindingVerified,
      poll_thread_binding_observation: poll?.result ? 'result_compared' : mode === 'long-poll' && poll?.timed_out ? 'timed_out_before_result' : 'missing',
      register_initial_state_pending: registerStartedPending,
      poll_state: poll?.result?.state || 'unknown',
      selected_answer_count: poll?.result?.selected_answer_count || 0,
      provisional_answer_count: poll?.result?.provisional_answer_count || 0,
      fixture_selection_injected: register?.result?.fixture_selection_injected === true,
      fixture_deadline_advanced: poll?.result?.fixture_deadline_advanced === true,
      poll_tool_status: poll?.status || 'unknown',
      poll_tool_duration_ms: poll?.duration_ms,
      timeout_expected: mode === 'long-poll',
      timeout_observed: timeoutObserved,
      short_poll_under_timeout: mode === 'long-poll' ? null : fixture.pollToNextRequestMs !== null && fixture.pollToNextRequestMs < TOOL_TIMEOUT_SEC * 1000,
      answer_returned_in_mcp_result: Boolean(poll?.result?.state === expectedState),
      delivery_claimed: false,
      delivery_acknowledged: false,
    },
    fixture: {
      request_count: fixture.requestCount,
      stages: fixture.requestSteps,
      poll_to_followup_request_ms: fixture.pollToNextRequestMs,
      timeout_output_seen: fixture.requestSteps.at(-1)?.timeout_output_seen === true,
      server_failure: fixture.serverFailure,
    },
    events: {
      counts: child.events.event_counts,
      malformed_line_count: child.events.malformed_line_count,
      omitted_event_count: child.events.omitted_event_count,
      stderr_bytes: child.events.stderr_bytes,
      stderr_has_warning: child.events.stderr_has_warning,
      stderr_has_error: child.events.stderr_has_error,
      tool_calls: calls,
    },
    cleanup: { isolated_config_restored: configRestored, runtime_home_removed: homeRemoved },
    output_directory: path.relative(REPOSITORY_ROOT, outputDirectory).split(path.sep).join('/'),
  };
}

function writeResults(outputDirectory, results) {
  const resultPath = path.join(outputDirectory, 'common-mcp-results.json');
  const contents = `${JSON.stringify(results, null, 2)}\n`;
  if (Buffer.byteLength(contents, 'utf8') > MAX_RESULT_BYTES) throw new Error('Result limit exceeded');
  fs.writeFileSync(resultPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return resultPath;
}

async function runCommonMcp(options) {
  const outputDirectory = resolveOutputDirectory(options.outputDirectory);
  const executable = path.resolve(options.codexPath);
  validateCodexPath(executable);
  const layout = setup({ outputDirectory, codexVersion: REQUIRED_CODEX_VERSION });
  let runtimeLayout = null;
  let fixture = null;
  let configSnapshot = null;
  let configRestored = false;
  let homeRemoved = false;
  let version = { version: 'unknown' };
  let child = {
    exit_code: 'unknown', signal: 'none', timed_out: false, interrupted: false,
    spawn_error_code: 'not_started', events: createChildCollector(() => {}).finish(),
  };
  try {
    runtimeLayout = createRuntimeHome(layout);
    version = await runVersionCheck(executable, runtimeLayout.home, { cwd: runtimeLayout.repo });
    fixture = createResponsesFixture(options.mode);
    await fixture.start();
    const originalConfig = fs.readFileSync(runtimeLayout.configPath, 'utf8');
    const hostId = 'codex-local';
    const homeScope = `poc160-${randomUUID()}`;
    const appliedConfig = renderFixtureConfig(path.join(__dirname, 'mcp-server.js'), fixture, hostId, homeScope, options.mode);
    configSnapshot = {
      output: path.resolve(outputDirectory),
      isolatedHome: path.resolve(runtimeLayout.home),
      configPath: path.resolve(runtimeLayout.configPath),
      originalConfig,
      appliedConfig,
    };
    fs.writeFileSync(runtimeLayout.configPath, appliedConfig, { encoding: 'utf8', flag: 'w', mode: 0o600 });
    const environment = makeChildEnvironment(process.env, runtimeLayout.home);
    Object.assign(environment, { POC160_HOST_ID: hostId, POC160_HOME_SCOPE: homeScope, POC160_FIXTURE_MODE: options.mode });
    child = await runCodex(executable, runtimeLayout, options.mode, options.timeoutMs, environment);
  } finally {
    if (fixture) {
      try { await fixture.close(); } catch {}
    }
    if (runtimeLayout && configSnapshot) {
      try { configRestored = clearFixtureConfig(runtimeLayout.configPath, configSnapshot); } catch { configRestored = false; }
      if (configRestored) {
        try { homeRemoved = cleanupRuntimeHome(outputDirectory, runtimeLayout.home); } catch { homeRemoved = false; }
      }
    } else if (runtimeLayout) {
      configRestored = true;
      try { homeRemoved = cleanupRuntimeHome(outputDirectory, runtimeLayout.home); } catch { homeRemoved = false; }
    }
  }
  const results = summarizeRun({ mode: options.mode, version, child, fixture: fixture || { requestCount: 0, requestSteps: [], pollToNextRequestMs: null, serverFailure: 'fixture_not_started' }, configRestored, homeRemoved, timeoutMs: options.timeoutMs, outputDirectory });
  const resultPath = writeResults(outputDirectory, results);
  return { resultPath, results };
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try {
    options = parseArguments(argv);
  } catch {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const { resultPath, results } = await runCommonMcp(options);
    process.stdout.write(`${JSON.stringify({
      file: path.relative(REPOSITORY_ROOT, resultPath).split(path.sep).join('/'),
      mode: results.mode,
      success: results.success,
      failure_reasons: results.failure_reasons,
    })}\n`);
    if (!results.success) process.exitCode = 1;
  } catch {
    process.stderr.write('Common MCP fixture run failed; raw diagnostics were omitted.\n');
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  MAX_EVENT_LINE_BYTES,
  MAX_FIXTURE_REQUEST_BYTES,
  SERVER_LABEL,
  TOOL_TIMEOUT_SEC,
  cleanupRuntimeHome,
  collectQuestionTools,
  createChildCollector,
  createResponsesFixture,
  callOutputHasTimeout,
  callOutputSummary,
  parseArguments,
  renderFixtureConfig,
  runCommonMcp,
  runCodex,
  safeToolResult,
  summarizeRun,
};
