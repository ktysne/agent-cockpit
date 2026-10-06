'use strict';

const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');
const { findQuestionCallPlan } = require('../codex-questions/native-fixture');

const FIXTURE_MODEL = 'poc161-native-fixture-model';
const FIXTURE_FINAL_TEXT = 'POC161_FIXED_FIXTURE_RESPONSE';
const MAX_REQUEST_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS = 64;
const MAX_SCHEMA_DEPTH = 12;
const MARKERS = Object.freeze({
  warmup: 'POC161_NATIVE_WARMUP_MARKER',
  initial: 'POC161_NATIVE_INITIAL_MARKER',
  steer: 'POC161_NATIVE_STEER_MARKER',
  mismatchSteer: 'POC161_NATIVE_MISMATCH_STEER_MARKER',
  idleSteer: 'POC161_NATIVE_IDLE_STEER_MARKER',
  second: 'POC161_NATIVE_SECOND_TURN_MARKER',
  queueA: 'POC161_NATIVE_QUEUE_A_MARKER',
  queueB: 'POC161_NATIVE_QUEUE_B_MARKER',
  queueCli: 'POC161_NATIVE_QUEUE_CLI_MARKER',
  disconnectSteer: 'POC161_NATIVE_DISCONNECT_STEER_MARKER',
});
const RESPONSE_PATHS = new Set(['/responses', '/v1/responses']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function safeName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,128}$/.test(value) ? value : null;
}

function setSecurityHeaders(response) {
  response.setHeader('X-Frame-Options', 'DENY');
  response.setHeader('Content-Security-Policy', "frame-ancestors 'none'");
  response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
  response.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error('request_too_large'), { statusCode: 413 });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid_json'), { statusCode: 400 });
  }
}

function markerSummary(input) {
  const userTexts = [];
  const messages = Array.isArray(input) ? input.slice(0, 512) : [];
  for (const message of messages) {
    if (!isRecord(message) || message.type !== 'message' || message.role !== 'user') continue;
    const content = Array.isArray(message.content) ? message.content.slice(0, 128) : [];
    for (const part of content) {
      if (isRecord(part) && ['input_text', 'text'].includes(part.type) && typeof part.text === 'string') {
        userTexts.push(part.text);
      }
    }
  }
  return Object.fromEntries(Object.entries(MARKERS).map(([name, marker]) => [name, userTexts.some((text) => text === marker)]));
}

function discoverToolInventory(tools) {
  const found = new Set();
  const visited = new Set();
  const visit = (value, depth = 0) => {
    if (depth > MAX_SCHEMA_DEPTH || !value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const child of value.slice(0, 128)) visit(child, depth + 1);
      return;
    }
    const functionValue = isRecord(value.function) ? value.function : value;
    const name = safeName(functionValue.name);
    if (name) found.add(name.split(/[./:]/).pop());
    for (const key of ['tools', 'functions']) visit(value[key], depth + 1);
  };
  visit(tools);
  return {
    exec_command: found.has('exec_command'),
    request_user_input: found.has('request_user_input'),
    tool_count: found.size,
  };
}

function schemaOf(value) {
  if (!isRecord(value)) return null;
  return value.parameters || value.input_schema || value.inputSchema || value.schema || null;
}

function findExecTool(tools, options = {}) {
  const found = [];
  const visited = new Set();
  const visit = (value, namespace = null, depth = 0) => {
    if (depth > MAX_SCHEMA_DEPTH || !value || typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
      for (const child of value.slice(0, 128)) visit(child, namespace, depth + 1);
      return;
    }
    const nextNamespace = value.type === 'namespace' && safeName(value.name)
      ? namespace ? namespace + '.' + value.name : value.name
      : namespace;
    const functionValue = isRecord(value.function) ? value.function : value;
    const name = safeName(functionValue.name);
    const schema = schemaOf(functionValue) || schemaOf(value);
    if (name && name.split(/[./:]/).pop() === 'exec_command' && isRecord(schema)) {
      found.push({ name: name.split(/[./:]/).pop(), namespace: functionValue.namespace || value.namespace || nextNamespace, schema });
    }
    for (const key of ['tools', 'functions']) visit(value[key], nextNamespace, depth + 1);
  };
  visit(tools);
  if (found.length !== 1) return null;
  const { schema } = found[0];
  const properties = isRecord(schema.properties) ? schema.properties : {};
  const command = 'powershell.exe -NoProfile -Command "Start-Sleep -Seconds 1; Write-Output POC161_NATIVE_TOOL"';
  const args = {};
  if (properties.cmd?.type === 'array') {
    args.cmd = ['powershell.exe', '-NoProfile', '-Command', 'Start-Sleep -Seconds 1; Write-Output POC161_NATIVE_TOOL'];
  } else if (!properties.cmd?.type || properties.cmd.type === 'string') {
    args.cmd = command;
  } else {
    return null;
  }
  for (const required of Array.isArray(schema.required) ? schema.required : []) {
    if (Object.hasOwn(args, required)) continue;
    if (required === 'workdir' && properties.workdir && typeof options.workdir === 'string') args.workdir = options.workdir;
    else if (required === 'yield_time_ms' && properties[required]) args[required] = 1000;
    else if (required === 'max_output_tokens' && properties[required]) args[required] = 128;
    else if (required === 'timeout_ms' && properties[required]) args[required] = 10000;
    else return null;
  }
  if (schema.additionalProperties === false && Object.keys(args).some((key) => !Object.hasOwn(properties, key))) return null;
  return { name: found[0].name, namespace: found[0].namespace, arguments: args };
}

function makeResponseId(index) {
  return `poc161_response_${String(index).padStart(4, '0')}`;
}

function createEnvelope(id, status, output, model) {
  const createdAt = Math.floor(Date.now() / 1000);
  return {
    id,
    object: 'response',
    created_at: createdAt,
    status,
    completed_at: status === 'completed' ? createdAt : null,
    error: null,
    incomplete_details: null,
    model,
    output,
    parallel_tool_calls: false,
    previous_response_id: null,
    store: false,
    usage: null,
  };
}

function makeEvents(number, model, call) {
  const responseId = makeResponseId(number);
  const sequence = (type, values, value) => ({ type, ...values, sequence_number: value });
  if (call) {
    const itemId = `poc161_item_${String(number).padStart(4, '0')}`;
    const callId = `poc161_call_${String(number).padStart(4, '0')}`;
    const argumentsText = JSON.stringify(call.arguments);
    const item = {
      id: itemId,
      type: 'function_call',
      status: 'completed',
      call_id: callId,
      name: call.name,
      ...(call.namespace ? { namespace: call.namespace } : {}),
      arguments: argumentsText,
    };
    return {
      call: { itemId, callId, name: call.name, namespace: call.namespace || null },
      events: [
        sequence('response.created', { response: createEnvelope(responseId, 'in_progress', [], model) }, 0),
        sequence('response.output_item.added', { output_index: 0, item: { ...item, status: 'in_progress', arguments: '' } }, 1),
        sequence('response.function_call_arguments.done', { item_id: itemId, output_index: 0, arguments: argumentsText }, 2),
        sequence('response.output_item.done', { output_index: 0, item }, 3),
        sequence('response.completed', { response: createEnvelope(responseId, 'completed', [item], model) }, 4),
      ],
    };
  }
  const itemId = `poc161_text_${String(number).padStart(4, '0')}`;
  const item = {
    id: itemId,
    type: 'message',
    status: 'completed',
    role: 'assistant',
    content: [{ type: 'output_text', text: FIXTURE_FINAL_TEXT, annotations: [] }],
  };
  return {
    call: null,
    events: [
      sequence('response.created', { response: createEnvelope(responseId, 'in_progress', [], model) }, 0),
      sequence('response.output_item.added', { output_index: 0, item: { id: itemId, type: 'message', status: 'in_progress', role: 'assistant', content: [] } }, 1),
      sequence('response.output_item.done', { output_index: 0, item }, 2),
      sequence('response.completed', { response: createEnvelope(responseId, 'completed', [item], model) }, 3),
    ],
  };
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

function inspectCallOutput(input, callId) {
  const items = Array.isArray(input) ? input.slice(0, 512) : [];
  for (const item of items) {
    if (!isRecord(item) || item.type !== 'function_call_output' || item.call_id !== callId) continue;
    return { seen: true, output_type: item.output === null ? 'null' : Array.isArray(item.output) ? 'array' : typeof item.output };
  }
  return { seen: false, output_type: 'unknown' };
}

function createNativeInstructionFixture(options = {}) {
  const gateCount = Number.isInteger(options.gateCount) ? Math.max(0, Math.min(4, options.gateCount)) : 1;
  let callMode = ['final', 'exec', 'question', 'approval'].includes(options.callMode) ? options.callMode : 'final';
  const timeoutMs = Number.isInteger(options.timeoutMs) ? Math.max(1000, Math.min(60000, options.timeoutMs)) : 20000;
  const token = randomBytes(32).toString('hex');
  const requests = [];
  const pendingGates = [];
  const gateWaiters = [];
  let requestCount = 0;
  let responseCount = 0;
  let callEmitted = false;
  let callInfo = null;
  let unsupported = false;
  let gateReleased = false;
  let gateTargetRequestCount = gateCount > 0 ? gateCount : null;

  const waitAtGate = () => gateReleased || requestCount !== gateTargetRequestCount
    ? Promise.resolve()
    : new Promise((resolveGate, rejectGate) => {
    const timer = setTimeout(() => rejectGate(new Error('fixture_gate_timeout')), timeoutMs);
    pendingGates.push(() => {
      clearTimeout(timer);
      resolveGate();
    });
    while (gateWaiters.length) gateWaiters.shift()();
  });

  const server = http.createServer(async (request, response) => {
    setSecurityHeaders(response);
    let url;
    try {
      url = new URL(request.url, 'http://127.0.0.1');
    } catch {
      request.resume();
      response.writeHead(400).end();
      return;
    }
    if (request.method !== 'POST' || !RESPONSE_PATHS.has(url.pathname)) {
      request.resume();
      response.writeHead(404).end();
      return;
    }
    const address = server.address();
    const expectedHost = address && typeof address === 'object' ? `127.0.0.1:${address.port}` : '';
    const provided = request.headers['x-poc161-token'];
    const validToken = typeof provided === 'string'
      && Buffer.byteLength(provided) === Buffer.byteLength(token)
      && timingSafeEqual(Buffer.from(provided), Buffer.from(token));
    if (request.headers.host !== expectedHost || Object.hasOwn(request.headers, 'origin') || !validToken) {
      request.resume();
      response.writeHead(403).end();
      return;
    }
    let body;
    try {
      body = await readJsonBody(request);
    } catch (error) {
      response.writeHead(error.statusCode || 400).end();
      return;
    }
    if (requests.length >= MAX_REQUESTS) {
      response.writeHead(429).end();
      return;
    }
    const toolInventory = discoverToolInventory(body && body.tools);
    const markers = markerSummary(body && body.input);
    const hasCallOutput = callInfo ? inspectCallOutput(body && body.input, callInfo.callId) : { seen: false, output_type: 'unknown' };
    const requestRecord = {
      index: requests.length + 1,
      fixture_model_match: body?.model === FIXTURE_MODEL,
      marker_hits: markers,
      tool_inventory: toolInventory,
      call_output_seen: hasCallOutput.seen,
      call_output_type: hasCallOutput.output_type,
    };
    requests.push(requestRecord);
    requestCount += 1;
    if (requestCount === gateTargetRequestCount) {
      try {
        await waitAtGate();
      } catch {
        if (!response.headersSent) response.writeHead(504).end();
        return;
      }
    }
    responseCount += 1;

    let call = null;
    if (!callEmitted && callMode === 'exec') {
      call = findExecTool(body && body.tools, options);
      if (!call) unsupported = true;
    } else if (!callEmitted && callMode === 'question') {
      const plan = findQuestionCallPlan(body && body.tools, { questionProfile: 'single', blocking: true });
      if (plan && plan.value) call = plan.value;
      else unsupported = true;
    } else if (!callEmitted && callMode === 'approval') {
      call = findExecTool(body && body.tools, options);
      if (!call) unsupported = true;
    }
    const built = makeEvents(responseCount, FIXTURE_MODEL, call);
    if (call) {
      callEmitted = true;
      callInfo = built.call;
    }
    writeEvents(response, built.events);
    body = null;
  });

  const fixture = {
    server,
    get requestHeaders() { return { 'X-Poc161-Token': token }; },
    get baseUrl() {
      const address = server.address();
      return address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : null;
    },
    get requestCount() { return requests.length; },
    get gateWaiting() { return pendingGates.length; },
    get requests() { return requests.map((entry) => structuredClone(entry)); },
    get callSummary() { return callInfo ? { ...callInfo } : null; },
    get unsupported() { return unsupported; },
    async start() {
      if (!server.listening) {
        await new Promise((resolveListen, rejectListen) => {
          const onError = (error) => { server.off('listening', onListening); rejectListen(error); };
          const onListening = () => { server.off('error', onError); resolveListen(); };
          server.once('error', onError);
          server.once('listening', onListening);
          server.listen(0, '127.0.0.1');
        });
      }
      return fixture;
    },
    release() {
      gateReleased = true;
      while (pendingGates.length) pendingGates.shift()();
    },
    gateNext() {
      gateTargetRequestCount = requestCount + 1;
      gateReleased = false;
      return gateTargetRequestCount;
    },
    setCallMode(value) {
      if (callEmitted || !['final', 'exec', 'question', 'approval'].includes(value)) return false;
      callMode = value;
      return true;
    },
    waitForGate(timeout = timeoutMs) {
      if (pendingGates.length) return Promise.resolve(true);
      if (gateReleased) return Promise.resolve(false);
      return new Promise((resolveWait) => {
        const waiter = () => {
          clearTimeout(timer);
          resolveWait(pendingGates.length > 0);
        };
        const timer = setTimeout(() => {
          const index = gateWaiters.indexOf(waiter);
          if (index >= 0) gateWaiters.splice(index, 1);
          resolveWait(pendingGates.length > 0);
        }, timeout);
        gateWaiters.push(waiter);
      });
    },
    async close() {
      fixture.release();
      while (gateWaiters.length) gateWaiters.shift()();
      if (!server.listening) return;
      const closed = new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose(true)));
      server.closeAllConnections?.();
      return Promise.race([closed, new Promise((resolveTimeout) => setTimeout(() => resolveTimeout(false), 3000))]);
    },
  };
  return fixture;
}

module.exports = {
  FIXTURE_FINAL_TEXT,
  FIXTURE_MODEL,
  MARKERS,
  createNativeInstructionFixture,
  discoverToolInventory,
  markerSummary,
  setSecurityHeaders,
};
