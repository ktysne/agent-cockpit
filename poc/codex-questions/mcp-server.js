'use strict';

const { randomUUID } = require('node:crypto');
const { DecisionQuestionsBroker } = require('./decision-model');

const MAX_LINE_BYTES = 64 * 1024;
const MAX_SESSION_INPUT_BYTES = 256 * 1024;
const MAX_SESSION_OUTPUT_BYTES = 256 * 1024;
const MAX_OUTPUT_LINE_BYTES = 64 * 1024;
const PROTOCOL_VERSIONS = new Set(['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25']);
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL_PREFIX = /^(?:sk-|gh[pousr]_|github_pat_|bearer\s|eyJ)/i;
const SOURCE = 'common_mcp';
const CATEGORY = 'ordinary';
const REGISTER_TOOL = 'questions_register';
const POLL_TOOL = 'questions_poll';
const TOOL_NAMES = new Set([REGISTER_TOOL, POLL_TOOL]);
const STATES = new Set(['pending', 'chosen', 'provisional', 'cancelled', 'external_resolved']);
const FIXTURE_MODES = new Set(['selected', 'fallback', 'long-poll']);

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every(key => allowed.has(key));
}

function safeIdentifier(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) && !CREDENTIAL_PREFIX.test(value) ? value : null;
}

function safeRequestId(value) {
  return typeof value === 'string' && safeIdentifier(value) ? value : null;
}

function makeResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

function makeError(id, code, message) {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolError(message) {
  return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: message }) }] };
}

function publicRequest(request) {
  const state = STATES.has(request.state) ? request.state : 'pending';
  const chosen = answerRows(request.chosen);
  const provisional = request.applied && request.applied.kind === 'provisional'
    ? answerRows(request.applied)
    : null;
  return {
    request_id: safeIdentifier(request.requestId),
    thread_id: safeIdentifier(request.threadId),
    state,
    held: request.held === true,
    deadline_evaluated: request.deadlineEvaluated === true,
    deadline_reached: typeof request.deadlineReached === 'boolean' ? request.deadlineReached : null,
    deadline_at_ms: Number.isSafeInteger(request.deadlineAt) ? request.deadlineAt : null,
    selected_answers: chosen,
    provisional_answers: provisional,
    late_answer_recorded: request.lateAnswer !== null && request.lateAnswer !== undefined,
    delivery_state: safeDeliveryState(request.deliveryState),
  };
}

function answerRows(value) {
  const answers = isRecord(value) ? value.answers : null;
  if (!Array.isArray(answers) || answers.length > 3) return null;
  const rows = [];
  for (const answer of answers) {
    if (!isRecord(answer) || !safeIdentifier(answer.questionId) || !Array.isArray(answer.optionIds)
      || answer.optionIds.length > 6 || answer.optionIds.some(id => !safeIdentifier(id))) return null;
    const row = { question_id: answer.questionId, option_ids: [...answer.optionIds] };
    if (typeof answer.freeText === 'string' && answer.freeText.length <= 4000) row.free_text = answer.freeText;
    rows.push(row);
  }
  return rows;
}

function safeDeliveryState(value) {
  return ['none', 'available', 'claimed', 'acknowledged', 'invalidated'].includes(value) ? value : 'unknown';
}

function resultContent(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function toolDefinitions() {
  return [
    {
      name: REGISTER_TOOL,
      description: 'Register an ordinary decision question for the current thread.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: {
          requestId: { type: 'string' },
          timeoutMinutes: { type: 'integer', minimum: 1, maximum: 30 },
          questions: {
            type: 'array', minItems: 1, maxItems: 3,
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' }, text: { type: 'string' }, mode: { type: 'string', enum: ['single', 'multi'] },
                options: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' }, label: { type: 'string' } }, required: ['id', 'label'], additionalProperties: false } },
                allowFreeText: { type: 'boolean' }, recommendedOptionId: { type: 'string' },
              },
              required: ['id', 'text', 'mode', 'options', 'allowFreeText'],
              additionalProperties: false,
            },
          },
        },
        required: ['requestId', 'timeoutMinutes', 'questions'],
        additionalProperties: false,
      },
    },
    {
      name: POLL_TOOL,
      description: 'Read the current state of a previously registered ordinary decision question without waiting.',
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      inputSchema: {
        type: 'object',
        properties: { requestId: { type: 'string' } },
        required: ['requestId'],
        additionalProperties: false,
      },
    },
  ];
}

function fixedFixtureAnswers(request) {
  if (!Array.isArray(request.questions) || request.questions.length !== 1 || request.questions[0].id !== 'format') return null;
  const question = request.questions[0];
  const choice = question.options.find(option => option.id !== question.recommendedOptionId);
  return choice ? [{ questionId: question.id, optionIds: [choice.id] }] : null;
}

function createMcpServer(options) {
  const broker = options && options.broker;
  const hostId = options && safeIdentifier(options.hostId);
  const homeScope = options && safeIdentifier(options.homeScope);
  const randomId = options && options.randomId || randomUUID;
  const fixtureMode = options && options.fixtureMode || 'none';
  const fixtureDelayMs = options && options.fixtureDelayMs === undefined ? 2600 : options.fixtureDelayMs;
  if (!broker || typeof broker.register !== 'function' || typeof broker.poll !== 'function'
    || !hostId || !homeScope || !(fixtureMode === 'none' || FIXTURE_MODES.has(fixtureMode))
    || !Number.isSafeInteger(fixtureDelayMs) || fixtureDelayMs < 0 || fixtureDelayMs > 10000) {
    throw new TypeError('Invalid common question MCP server options');
  }
  const fixtureRequestIds = new Set();

  async function callTool(params) {
    if (!isRecord(params) || !TOOL_NAMES.has(params.name) || !isRecord(params.arguments)) return toolError('invalid_request');
    const meta = params._meta;
    if (!isRecord(meta) || !safeIdentifier(meta.threadId)) return toolError('invalid_thread_metadata');
    if ((meta.hostId !== undefined && meta.hostId !== hostId)
      || (meta.homeScope !== undefined && meta.homeScope !== homeScope)) return toolError('wrong_scope');
    const threadId = meta.threadId;

    if (params.name === REGISTER_TOOL) {
      const args = params.arguments;
      if (!hasOnlyKeys(args, new Set(['requestId', 'timeoutMinutes', 'questions']))
        || !safeRequestId(args.requestId)
        || !Number.isSafeInteger(args.timeoutMinutes) || !Array.isArray(args.questions)) return toolError('invalid_request');
      const requestId = args.requestId;
      const registration = broker.register({
        provenance: SOURCE,
        category: CATEGORY,
        hostId,
        homeScope,
        threadId,
        requestId,
        timeoutMinutes: args.timeoutMinutes,
        questions: args.questions,
      });
      if (!registration || registration.accepted !== true || !isRecord(registration.request)) return toolError('registration_rejected');
      fixtureRequestIds.add(requestId);
      const registered = registration.request;
      let injected = false;
      if (fixtureMode === 'selected') {
        const answers = fixedFixtureAnswers(registered);
        if (answers && typeof broker.submitAnswer === 'function') {
          const submission = broker.submitAnswer({
            hostId, homeScope, threadId, requestId, source: 'dashboard',
            submissionId: safeIdentifier(randomId()), answers,
          });
          injected = Boolean(submission && submission.accepted === true);
        }
      }
      const initial = publicRequest(registered);
      return resultContent({ ...initial, fixture_selection_injected: injected });
    }

    const args = params.arguments;
    if (!hasOnlyKeys(args, new Set(['requestId'])) || !safeRequestId(args.requestId)) return toolError('invalid_request');
    if (!fixtureRequestIds.has(args.requestId)) return toolError('unknown_request');
    if (fixtureMode === 'long-poll') await new Promise(resolve => setTimeout(resolve, fixtureDelayMs));
    const preliminary = broker.poll({ hostId, homeScope, threadId, requestId: args.requestId });
    if (!preliminary || preliminary.found !== true || !isRecord(preliminary.request)) return toolError('unknown_request');
    let advanced = false;
    if (fixtureMode === 'fallback' && typeof options.setNow === 'function') {
      const deadlineAt = preliminary.request.deadlineAt;
      if (Number.isSafeInteger(deadlineAt)) {
        options.setNow(deadlineAt + 1);
        advanced = true;
      }
    }
    const polled = advanced
      ? broker.poll({ hostId, homeScope, threadId, requestId: args.requestId })
      : preliminary;
    if (!polled || polled.found !== true || !isRecord(polled.request)) return toolError('unknown_request');
    return resultContent({ ...publicRequest(polled.request), fixture_deadline_advanced: advanced });
  }

  async function handleRequest(request) {
    if (!isRecord(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
      return isRecord(request) && Object.hasOwn(request, 'id') ? makeError(request.id, -32600, 'Invalid request') : null;
    }
    const hasId = Object.hasOwn(request, 'id');
    if (request.method.startsWith('notifications/')) return null;
    if (!hasId) return null;
    if (request.method === 'initialize') {
      const requestedVersion = isRecord(request.params) ? request.params.protocolVersion : undefined;
      return makeResponse(request.id, {
        protocolVersion: PROTOCOL_VERSIONS.has(requestedVersion) ? requestedVersion : '2025-11-25',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-cockpit-common-questions-poc', version: '0.1.0' },
      });
    }
    if (request.method === 'ping') return makeResponse(request.id, {});
    if (request.method === 'tools/list') return makeResponse(request.id, { tools: toolDefinitions() });
    if (request.method === 'tools/call') {
      const result = await callTool(isRecord(request.params) ? request.params : null);
      return makeResponse(request.id, result);
    }
    return makeError(request.id, -32601, 'Method not found');
  }

  return { handleRequest };
}

function parseLine(line, server) {
  let request;
  try {
    request = JSON.parse(line.toString('utf8'));
  } catch {
    return Promise.resolve(makeError(null, -32700, 'Parse error'));
  }
  return Promise.resolve(server.handleRequest(request)).catch(() => (
    isRecord(request) && Object.hasOwn(request, 'id') ? makeError(request.id, -32603, 'Internal error') : null
  ));
}

function attachBoundedReader(input, output, options) {
  const server = options && typeof options.handleRequest === 'function' ? options : createMcpServer(options);
  let pending = Buffer.alloc(0);
  let inputBytes = 0;
  let outputBytes = 0;
  let stopped = false;
  let chain = Promise.resolve();

  const writeResponse = response => {
    if (!response || stopped) return;
    const line = Buffer.from(`${JSON.stringify(response)}\n`, 'utf8');
    if (line.length > MAX_OUTPUT_LINE_BYTES || outputBytes + line.length > MAX_SESSION_OUTPUT_BYTES) {
      stopped = true;
      input.pause();
      return;
    }
    outputBytes += line.length;
    output.write(line);
  };

  const enqueueLine = line => {
    chain = chain.then(() => parseLine(line, server)).then(writeResponse);
  };

  input.on('data', chunk => {
    if (stopped) return;
    const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    inputBytes += data.length;
    if (inputBytes > MAX_SESSION_INPUT_BYTES) {
      pending = Buffer.alloc(0);
      input.pause();
      writeResponse(makeError(null, -32700, 'Request limit exceeded'));
      stopped = true;
      return;
    }
    let start = 0;
    while (start < data.length) {
      const newline = data.indexOf(0x0a, start);
      const end = newline < 0 ? data.length : newline;
      const piece = data.subarray(start, end);
      if (pending.length + piece.length > MAX_LINE_BYTES) {
        pending = Buffer.alloc(0);
        if (newline < 0) {
          input.pause();
          writeResponse(makeError(null, -32700, 'Line limit exceeded'));
          stopped = true;
          return;
        }
        enqueueLine(Buffer.from(''));
      } else if (newline >= 0) {
        enqueueLine(Buffer.concat([pending, piece]));
        pending = Buffer.alloc(0);
      } else {
        pending = Buffer.concat([pending, piece]);
      }
      if (newline < 0) break;
      start = newline + 1;
    }
  });
  input.on('end', () => {
    if (!stopped && pending.length) enqueueLine(pending);
    pending = Buffer.alloc(0);
  });
  input.on('error', () => {
    stopped = true;
    pending = Buffer.alloc(0);
  });
}

function createRunnerServer(environment = process.env) {
  const hostId = safeIdentifier(environment.POC160_HOST_ID);
  const homeScope = safeIdentifier(environment.POC160_HOME_SCOPE);
  const fixtureMode = environment.POC160_FIXTURE_MODE || 'none';
  if (!hostId || !homeScope || !(fixtureMode === 'none' || FIXTURE_MODES.has(fixtureMode))) {
    throw new Error('Runner registration is invalid');
  }
  let nowMs = Date.now();
  const now = fixtureMode === 'none' ? () => Date.now() : () => nowMs;
  const broker = new DecisionQuestionsBroker({
    now,
    awayEnabled: fixtureMode === 'fallback',
  });
  return createMcpServer({
    broker,
    hostId,
    homeScope,
    fixtureMode,
    now,
    setNow(value) { nowMs = value; },
  });
}

function main(argv = process.argv.slice(2), input = process.stdin, output = process.stdout) {
  if (argv.length !== 1 || argv[0] !== '--mcp') {
    process.stderr.write('MCP adapter requires --mcp.\n');
    return;
  }
  try {
    const server = createRunnerServer();
    attachBoundedReader(input, output, server);
  } catch {
    process.stderr.write('MCP adapter configuration is invalid.\n');
  }
}

if (require.main === module) main();

module.exports = {
  CATEGORY,
  MAX_LINE_BYTES,
  MAX_SESSION_INPUT_BYTES,
  MAX_SESSION_OUTPUT_BYTES,
  POLL_TOOL,
  REGISTER_TOOL,
  SOURCE,
  attachBoundedReader,
  createMcpServer,
  createRunnerServer,
  publicRequest,
  safeIdentifier,
  toolDefinitions,
};
