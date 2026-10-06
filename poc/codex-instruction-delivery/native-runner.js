'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const {
  assertNoSymlinkComponents,
  REQUIRED_CODEX_VERSION,
  REPOSITORY_ROOT,
  resolveOutputDirectory,
  setup,
} = require('../codex-hooks-identity/setup');
const {
  clearFixtureConfig,
  createRuntimeHome,
  makeChildEnvironment,
  runVersionCheck,
  validatePaths,
} = require('../codex-hooks-identity/run-exec');
const {
  chooseLoopbackPort,
  makeServerArguments,
  startServerProcess,
} = require('../codex-shared-app-server/run-managed');
const { connectViaWebSocket, validateInitializeResponse } = require('../codex-shared-app-server/collector');
const { FIXTURE_FINAL_TEXT, FIXTURE_MODEL, MARKERS, createNativeInstructionFixture } = require('./native-fixture');

const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 60000;
const MAX_RESULT_BYTES = 64 * 1024;
const SERVER_STOP_TIMEOUT_MS = 4000;
const MAX_CONTROL_LINE_BYTES = 4096;
const RPC_METHODS = Object.freeze([
  'initialize', 'initialized', 'thread/start', 'thread/resume', 'thread/read',
  'thread/queue/add', 'thread/queue/start', 'thread/queue/list', 'thread/queue/delete',
  'turn/start', 'turn/steer', 'turn/interrupt',
]);
const NOTIFICATION_METHODS = new Set([
  'thread/started', 'thread/status/changed', 'thread/closed', 'thread/queueChanged',
  'turn/started', 'turn/completed', 'turn/status/changed', 'item/started', 'item/completed',
  'serverRequest/resolved',
]);
const TURN_STATUSES = new Set(['queued', 'inProgress', 'completed', 'failed', 'interrupted', 'cancelling']);
const ITEM_TYPES = new Set([
  'userMessage', 'agentMessage', 'functionCallOutput', 'dynamicToolCall', 'mcpToolCall',
  'commandExecution', 'fileChange', 'reasoning', 'plan', 'collabAgentToolCall', 'subAgentActivity',
]);
const RPC_ERROR_CATEGORIES = new Set([
  'thread_not_found', 'history_missing', 'not_initialized', 'experimental_required',
  'invalid_params', 'permission_denied', 'thread_not_persisted', 'resume_unavailable', 'unknown',
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FIXTURE_ID = 'agent-cockpit-poc161-native';
const DEFAULT_OUTPUT = 'poc/out/poc161-native';

class NativeInstructionError extends Error {
  constructor(kind) {
    super(kind);
    this.kind = kind;
  }
}

function parseArguments(argv) {
  const values = new Map();
  let serve = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--serve') {
      if (serve) throw new NativeInstructionError('invalid_arguments');
      serve = true;
      continue;
    }
    if (!['--codex-path', '--out', '--timeout-ms', '--mode'].includes(arg)
      || values.has(arg) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new NativeInstructionError('invalid_arguments');
    }
    values.set(arg, argv[++index]);
  }
  if (!values.has('--codex-path')) throw new NativeInstructionError('codex_path_required');
  const timeoutMs = values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new NativeInstructionError('invalid_timeout');
  }
  const mode = values.get('--mode') || 'lifecycle';
  if (!['lifecycle', 'queue-cli', 'tool', 'question', 'approval', 'stop'].includes(mode)) {
    throw new NativeInstructionError('invalid_mode');
  }
  return {
    codexPath: values.get('--codex-path'),
    outputDirectory: values.get('--out') || DEFAULT_OUTPUT,
    timeoutMs,
    mode,
    serve,
  };
}

function safeErrorKind(error, fallback = 'native_probe_failed') {
  const candidate = error && (error.kind || error.code);
  return typeof candidate === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(candidate) ? candidate : fallback;
}

function safeUuid(value) {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function safeTurnStatus(value) {
  return typeof value === 'string' && TURN_STATUSES.has(value) ? value : 'unknown';
}

function projectThreadSettings(response, expectedCwd) {
  const thread = response && response.thread && typeof response.thread === 'object' ? response.thread : null;
  const cwd = typeof response?.cwd === 'string' ? response.cwd : null;
  const cwdMatches = Boolean(cwd && path.resolve(cwd).toLowerCase() === path.resolve(expectedCwd).toLowerCase());
  const approvalPolicy = ['on-request', 'untrusted', 'never'].includes(response && response.approvalPolicy)
    ? response.approvalPolicy : 'unknown';
  const sandboxValue = response && response.sandbox;
  const sandboxKeys = sandboxValue && typeof sandboxValue === 'object' && !Array.isArray(sandboxValue)
    ? Object.keys(sandboxValue) : [];
  const sandbox = sandboxValue && typeof sandboxValue === 'object' && !Array.isArray(sandboxValue)
    && sandboxKeys.every((key) => ['type', 'networkAccess'].includes(key))
    && sandboxValue.type === 'readOnly'
    && (sandboxValue.networkAccess === undefined || sandboxValue.networkAccess === false)
    ? 'read-only' : 'unknown';
  const ephemeral = typeof (thread && thread.ephemeral) === 'boolean' ? thread.ephemeral : null;
  const modelMatches = response?.model === FIXTURE_MODEL;
  const providerMatches = response?.modelProvider === 'poc161_fixture';
  return {
    available: Boolean(thread && cwd && typeof response.approvalPolicy === 'string' && sandboxValue),
    cwd_matches_private_repo: cwdMatches,
    approval_policy: approvalPolicy,
    sandbox,
    ephemeral,
    model_matches_fixture: modelMatches,
    model_provider_matches_fixture: providerMatches,
    requested_settings_preserved: cwdMatches && approvalPolicy === 'on-request'
      && sandbox === 'read-only' && ephemeral === false && modelMatches && providerMatches,
  };
}

function classifyServerMethod(method) {
  if (typeof method !== 'string') return 'other';
  if (method === 'item/tool/requestUserInput') return 'question';
  if (/approval|permission/i.test(method)) return 'approval';
  return 'other';
}

function createObserver() {
  const methodCounts = new Map();
  const turnStatuses = new Map();
  const turnIds = new Set();
  const threadIds = new Set();
  const itemCounts = new Map();
  const requestCounts = { approval: 0, question: 0, other: 0 };
  const waiting = {
    approval: { seen: false, active: false, cleared: false },
    question: { seen: false, active: false, cleared: false },
  };
  let serverRequestCount = 0;
  let resolvedCount = 0;

  function onNotification(method, metadata) {
    const projectedMethod = NOTIFICATION_METHODS.has(method) ? method : 'other';
    methodCounts.set(projectedMethod, (methodCounts.get(projectedMethod) || 0) + 1);
    if (!metadata || typeof metadata !== 'object') return;
    const threadId = safeUuid(metadata.threadId);
    const turnId = safeUuid(metadata.turnId);
    if (threadId) threadIds.add(threadId);
    if (turnId) {
      turnIds.add(turnId);
      const status = safeTurnStatus(metadata.status);
      if (status !== 'unknown') turnStatuses.set(turnId, status);
    }
    if (projectedMethod === 'item/started' || projectedMethod === 'item/completed') {
      const type = ITEM_TYPES.has(metadata.itemType) ? metadata.itemType : 'unknown';
      itemCounts.set(`${projectedMethod}:${type}`, (itemCounts.get(`${projectedMethod}:${type}`) || 0) + 1);
    }
    if (projectedMethod === 'serverRequest/resolved') resolvedCount += 1;
    if (projectedMethod === 'thread/status/changed' && metadata.threadStatus?.type === 'active') {
      const flags = Array.isArray(metadata.threadStatus.activeFlags) ? metadata.threadStatus.activeFlags : [];
      updateFlag(waiting.approval, flags.includes('waitingOnApproval'));
      updateFlag(waiting.question, flags.includes('waitingOnUserInput'));
    }
  }

  function onServerRequest(request) {
    serverRequestCount += 1;
    requestCounts[classifyServerMethod(request && request.method)] += 1;
  }

  return {
    onNotification,
    onServerRequest,
    get currentTurnId() { return [...turnIds].at(-1) || null; },
    get turnStatuses() { return turnStatuses; },
    get turnIds() { return turnIds; },
    get serverRequestCount() { return serverRequestCount; },
    summary() {
      return {
        notification_counts: Object.fromEntries([...methodCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
        server_requests: { ...requestCounts, total: serverRequestCount, resolved: resolvedCount },
        item_counts: Object.fromEntries([...itemCounts.entries()].sort(([a], [b]) => a.localeCompare(b))),
        turn_ids_observed: turnIds.size,
        thread_ids_observed: threadIds.size,
        waiting_on_approval: { ...waiting.approval },
        waiting_on_user_input: { ...waiting.question },
      };
    },
  };
}

function updateFlag(state, active) {
  if (active) state.seen = true;
  if (state.active && !active) state.cleared = true;
  state.active = active;
}

function safeRpcCode(error) {
  return Number.isSafeInteger(error && error.rpcCode) ? error.rpcCode : null;
}

function safeRpcCategory(error) {
  return RPC_ERROR_CATEGORIES.has(error && error.rpcErrorCategory) ? error.rpcErrorCategory : 'unknown';
}

async function observeRpc(client, method, params) {
  try {
    return { accepted: true, rpc_code: null, error_category: null, result: await client.request(method, params) };
  } catch (error) {
    return { accepted: false, rpc_code: safeRpcCode(error), error_category: safeRpcCategory(error), result: null };
  }
}

async function readThreadSettings(client, threadId) {
  const read = await observeRpc(client, 'thread/read', { threadId, includeTurns: false });
  return {
    accepted: read.accepted,
    rpc_code: read.rpc_code,
    error_category: read.error_category,
    available: false,
    source: 'thread_read_does_not_project_effective_settings',
    cwd_matches_private_repo: null,
    approval_policy: 'unknown',
    sandbox: 'unknown',
    ephemeral: null,
    model_matches_fixture: null,
    model_provider_matches_fixture: null,
    requested_settings_preserved: null,
  };
}

function compareThreadSettings(left, right) {
  const fields = ['cwd_matches_private_repo', 'approval_policy', 'sandbox', 'ephemeral',
    'model_matches_fixture', 'model_provider_matches_fixture'];
  return Boolean(left && right && left.requested_settings_preserved && right.requested_settings_preserved
    && fields.every((field) => left[field] === right[field]));
}

function createResult(options = {}) {
  return {
    schema: 'agent-cockpit-poc161-native-v1',
    backend: { source: 'local_responses_fixture', model: FIXTURE_MODEL, real_model_observed: false },
    target_version: null,
    output_directory: null,
    private_home: null,
    mode: options.serve ? 'serve' : options.mode,
    success: false,
    measurement_success: false,
    feature_flow_success: null,
    state_probe_success: null,
    ordinary_instruction_delivery_observed: false,
    failure_stage: null,
    failure_code: null,
    thread: { id: null, started: false, client_b_resumed: false, same_id: false },
    settings: { after_start: null, before_resume: null, after_resume: null, start_resume_match: null, after_probe: null },
    clients: {
      a: { initialized: false, experimental_api: true, private_home_match: false },
      b: { initialized: false, experimental_api: false, private_home_match: false },
    },
    turns: [],
    steer: { matching: null, mismatching: null, idle: null },
    queue: {
      api_experimental_false: null,
      list_before: null,
      same_id_same_payload: null,
      same_id_different_payload: null,
      api_add_window: null,
      explicit_start_window: null,
      list_after: null,
      start: null,
      cli: null,
    },
    native_user_markers: Object.fromEntries(Object.keys(MARKERS).map((name) => [name, false])),
    native_user_marker_evidence: Object.fromEntries(Object.keys(MARKERS).map((name) => [name, {
      exact_text_match: false,
      same_item_tuple_match: false,
      same_item_thread_turn_match: false,
      expected_client_message_id_match: null,
      native_item_count: 0,
      unique_native_item_count: 0,
    }])),
    native_marker_parse_errors: 0,
    fixture: {
      request_count: 0,
      request_markers: Object.fromEntries(Object.keys(MARKERS).map((name) => [name, 0])),
      exec_tool_declared: false,
      question_tool_declared: false,
      call_output_count: 0,
      call_output_type: 'unknown',
      unsupported: false,
    },
    observed: { a: null, b: null },
    serve: { ready_file: null, stop_requested: false, control_commands: 0 },
    cleanup: {
      server_stopped: true,
      client_a_closed: true,
      client_b_closed: true,
      fixture_closed: true,
      private_config_restored: true,
      private_home_removed: true,
      token_file_removed: true,
      cli_child_stopped: true,
    },
  };
}

function validateExecutable(codexPath) {
  if (typeof codexPath !== 'string' || !path.isAbsolute(codexPath)) throw new NativeInstructionError('absolute_codex_path_required');
  const stat = fs.lstatSync(codexPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new NativeInstructionError('invalid_codex_executable');
  return path.resolve(codexPath);
}

function writePrivateConfig(layout, fixture) {
  const configPath = layout.configPath;
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new NativeInstructionError('private_config_invalid');
  const originalConfig = fs.readFileSync(configPath, 'utf8');
  const fixtureToken = fixture.requestHeaders['X-Poc161-Token'];
  if (typeof fixtureToken !== 'string' || !/^[0-9a-f]{64}$/.test(fixtureToken) || !fixture.baseUrl) {
    throw new NativeInstructionError('fixture_connection_details_invalid');
  }
  const quote = (value) => JSON.stringify(value);
  const provider = [
    `model = ${quote(FIXTURE_MODEL)}`,
    'model_provider = "poc161_fixture"',
    '',
    '[model_providers.poc161_fixture]',
    'name = "Local deterministic instruction fixture"',
    `base_url = ${quote(fixture.baseUrl)}`,
    'wire_api = "responses"',
    `http_headers = { "X-Poc161-Token" = ${quote(fixtureToken)} }`,
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n');
  const existingTables = originalConfig.trim();
  const appliedConfig = `${provider}\n${existingTables}\n`;
  assertNoSymlinkComponents(layout.output, configPath);
  const temporary = `${configPath}.poc161-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporary, appliedConfig, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, configPath);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { output: layout.output, isolatedHome: layout.home, configPath, originalConfig, appliedConfig };
}

function createTokenFile(output) {
  const token = randomBytes(32).toString('hex');
  const tokenPath = path.join(output, `.poc161-capability-${randomUUID()}.token`);
  assertNoSymlinkComponents(REPOSITORY_ROOT, tokenPath);
  fs.writeFileSync(tokenPath, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const hash = createHash('sha256').update(token).digest('hex');
  if (fs.readFileSync(tokenPath, 'utf8') !== token) throw new NativeInstructionError('capability_token_file_invalid');
  return { token, tokenPath, hash };
}

function removeTokenFile(tokenFile) {
  if (!tokenFile) return true;
  try {
    const stat = fs.lstatSync(tokenFile.tokenPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const value = fs.readFileSync(tokenFile.tokenPath, 'utf8');
    if (createHash('sha256').update(value).digest('hex') !== tokenFile.hash) return false;
    fs.unlinkSync(tokenFile.tokenPath);
    return !fs.existsSync(tokenFile.tokenPath);
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

function removePrivateHome(output, home) {
  if (!output || !home) return true;
  const resolvedOutput = resolveOutputDirectory(output);
  const parent = path.join(resolvedOutput, 'runtime-homes');
  const target = path.resolve(home);
  const relativeHome = path.relative(parent, target);
  if (path.isAbsolute(relativeHome) || relativeHome === '..' || relativeHome.startsWith('..' + path.sep)
    || path.dirname(target) !== parent || !UUID.test(path.basename(target))) return false;
  try {
    assertNoSymlinkComponents(REPOSITORY_ROOT, parent);
    assertNoSymlinkComponents(parent, target);
    const stat = fs.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    fs.rmSync(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
    return !fs.existsSync(target);
  } catch {
    return false;
  }
}

async function stopServer(server, timeoutMs = SERVER_STOP_TIMEOUT_MS) {
  if (!server || server.state.closed) return true;
  const waitForExit = async () => Promise.race([
    server.exited.then(() => true),
    new Promise((resolveStop) => setTimeout(() => resolveStop(false), timeoutMs)),
  ]);
  try { server.child.kill(); } catch {}
  const stopped = await waitForExit();
  if (!stopped) {
    try { server.child.kill('SIGKILL'); } catch {}
    return waitForExit();
  }
  return stopped;
}

function createMarkerTargets(threadId, result) {
  const targets = new Map(Object.keys(MARKERS).map((name) => [name, {
    items: new Map(),
    nativeEventCount: 0,
    expectedClientId: null,
    expectedTurnId: null,
    threadId,
  }]));
  const updateEvidence = (name, target) => {
    const evidence = result.native_user_marker_evidence[name];
    const items = [...target.items.values()];
    evidence.exact_text_match = items.length > 0;
    const threadTurnMatch = Boolean(target.expectedTurnId && items.some((item) => !item.conflict
      && item.threadMatch && item.turnIds.has(target.expectedTurnId)));
    const tupleMatch = Boolean(threadTurnMatch && target.expectedClientId
      && items.some((item) => !item.conflict && item.threadMatch && item.clientMatch
        && item.turnIds.has(target.expectedTurnId)));
    evidence.same_item_tuple_match = tupleMatch;
    evidence.same_item_thread_turn_match = threadTurnMatch;
    evidence.expected_client_message_id_match = target.expectedClientId ? tupleMatch : null;
    evidence.native_item_count = target.nativeEventCount;
    evidence.unique_native_item_count = target.items.size;
    result.native_user_markers[name] = tupleMatch;
  };
  return {
    register(name, clientUserMessageId) {
      const target = targets.get(name);
      if (!target) return false;
      target.expectedClientId = clientUserMessageId;
      target.expectedTurnId = null;
      target.items.clear();
      target.nativeEventCount = 0;
      updateEvidence(name, target);
      return true;
    },
    bindTurn(name, turnId) {
      const target = targets.get(name);
      if (!target || !safeUuid(turnId)) return false;
      target.expectedTurnId = turnId;
      updateEvidence(name, target);
      return true;
    },
    observe(name, fields) {
      const target = targets.get(name);
      if (!target) return;
      target.nativeEventCount += 1;
      if (typeof fields.itemId === 'string' && fields.itemId.length > 0 && fields.itemId.length <= 128) {
        const prior = target.items.get(fields.itemId);
        const explicitWrongThread = typeof fields.threadId === 'string' && fields.threadId !== target.threadId;
        const explicitClientId = typeof fields.clientId === 'string' ? fields.clientId : null;
        const explicitWrongClient = target.expectedClientId !== null && explicitClientId !== null
          && explicitClientId !== target.expectedClientId;
        const turnIds = new Set(prior?.turnIds || []);
        const turnId = safeUuid(fields.turnId);
        if (turnId) turnIds.add(turnId);
        target.items.set(fields.itemId, {
          threadMatch: !explicitWrongThread && (fields.threadId === target.threadId || prior?.threadMatch === true),
          clientMatch: target.expectedClientId !== null && !explicitWrongClient
            && (explicitClientId === target.expectedClientId || prior?.clientMatch === true),
          turnIds,
          conflict: Boolean(prior?.conflict || explicitWrongThread || explicitWrongClient || turnIds.size > 1),
        });
      }
      updateEvidence(name, target);
    },
  };
}

function installClientMarkerObserver(client, result, markerTargets) {
  const dispatch = client.dispatchText.bind(client);
  client.dispatchText = function dispatchWithMarkerProjection(payload) {
    if (Buffer.isBuffer(payload) && payload.length <= 1024 * 1024) {
      try {
        const message = JSON.parse(payload.toString('utf8'));
        const item = message?.params?.item;
        if ((message.method === 'item/started' || message.method === 'item/completed')
          && item?.type === 'userMessage' && Array.isArray(item.content)) {
          for (const part of item.content.slice(0, 128)) {
            if (!part || typeof part.text !== 'string' || !['text', 'inputText'].includes(part.type)) continue;
            for (const [name, marker] of Object.entries(MARKERS)) {
              if (part.text === marker) {
                markerTargets.observe(name, {
                  threadId: message.params?.threadId,
                  turnId: message.params?.turnId || message.params?.turn?.id,
                  clientId: item.clientId || item.clientUserMessageId,
                  itemId: item.id,
                });
              }
            }
          }
        }
      } catch {
        result.native_marker_parse_errors += 1;
      }
    }
    return dispatch(payload);
  };
}

async function connectClient(options, server, observer, connect = connectViaWebSocket) {
  const deadline = Date.now() + Math.min(options.timeoutMs, 15000);
  let last = 'connection_error';
  while (Date.now() < deadline) {
    if (server.state.closed) throw new NativeInstructionError('app_server_exited_before_connect');
    try {
      return await connect({
        url: `ws://127.0.0.1:${options.port}`,
        authToken: options.token,
        timeoutMs: Math.min(options.timeoutMs, 3000),
        allowedMethods: RPC_METHODS,
        onNotification: observer.onNotification,
        onServerRequest: observer.onServerRequest,
      });
    } catch (error) {
      last = safeErrorKind(error, 'connection_error');
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
    }
  }
  throw new NativeInstructionError(`app_server_connect_${last}`);
}

async function initializeClient(connection, home, experimentalApi) {
  const client = connection && connection.client;
  if (!client || typeof client.request !== 'function' || typeof client.notify !== 'function') {
    throw new NativeInstructionError('app_server_client_invalid');
  }
  const response = await client.request('initialize', {
    clientInfo: { name: FIXTURE_ID, title: 'Agent Cockpit instruction delivery fixture', version: '0.1.0' },
    capabilities: { experimentalApi },
  });
  const metadata = validateInitializeResponse(response);
  await client.notify('initialized', {});
  const normalize = (value) => path.resolve(value).toLowerCase();
  return {
    version: metadata.version,
    privateHomeMatch: typeof response.codexHome === 'string' && normalize(response.codexHome) === normalize(home),
  };
}

function extractThreadId(value) {
  const threadId = safeUuid(value && value.thread && value.thread.id);
  if (!threadId) throw new NativeInstructionError('native_thread_id_missing');
  return threadId;
}

function extractTurnId(value) {
  const turnId = safeUuid(value && value.turn && value.turn.id);
  if (!turnId) throw new NativeInstructionError('native_turn_id_missing');
  return turnId;
}

function exactMarkerInput(marker) {
  if (!Object.values(MARKERS).includes(marker)) throw new NativeInstructionError('marker_not_allowlisted');
  return [{ type: 'text', text: marker }];
}

function requestParams(threadId, marker, clientUserMessageId) {
  return { threadId, input: exactMarkerInput(marker), clientUserMessageId };
}

function collectFixtureSummary(fixture) {
  const requests = fixture.requests;
  const markerCounts = Object.fromEntries(Object.keys(MARKERS).map((name) => [name, 0]));
  let callOutputCount = 0;
  let outputType = 'unknown';
  let execDeclared = false;
  let questionDeclared = false;
  for (const request of requests) {
    for (const [name, seen] of Object.entries(request.marker_hits)) if (seen) markerCounts[name] += 1;
    callOutputCount += request.call_output_seen ? 1 : 0;
    if (request.call_output_seen) outputType = request.call_output_type;
    execDeclared ||= request.tool_inventory.exec_command;
    questionDeclared ||= request.tool_inventory.request_user_input;
  }
  return {
    request_count: requests.length,
    request_markers: markerCounts,
    exec_tool_declared: execDeclared,
    question_tool_declared: questionDeclared,
    call_output_count: callOutputCount,
    call_output_type: outputType,
    unsupported: fixture.unsupported,
  };
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  return predicate();
}

function turnStatus(observer, turnId) {
  return observer.turnStatuses.get(turnId) || 'unknown';
}

async function waitForTurn(observers, turnId, timeoutMs) {
  return waitFor(() => observers.some((observer) => ['completed', 'failed', 'interrupted'].includes(turnStatus(observer, turnId))), timeoutMs);
}

function safeTurnRecord(turnId, startResult, observerA, observerB, terminalObserved) {
  return {
    id: safeUuid(turnId),
    start_accepted: startResult.accepted,
    start_error_category: startResult.error_category,
    start_status: safeTurnStatus(startResult.result?.turn?.status),
    status_a: turnStatus(observerA, turnId),
    status_b: turnStatus(observerB, turnId),
    terminal_observed: terminalObserved,
    same_terminal_status: turnStatus(observerA, turnId) !== 'unknown'
      && turnStatus(observerA, turnId) === turnStatus(observerB, turnId),
  };
}

function markerHit(fixture, markerName) {
  return fixture.requests.some((request) => request.marker_hits[markerName] === true);
}

async function startTurn(session, client, markerName, messageId = randomUUID()) {
  const marker = MARKERS[markerName];
  if (!marker) throw new NativeInstructionError('marker_not_allowlisted');
  session.markerTargets.register(markerName, messageId);
  const observation = await observeRpc(client, 'turn/start', requestParams(session.threadId, marker, messageId));
  if (observation.accepted) session.markerTargets.bindTurn(markerName, extractTurnId(observation.result));
  return observation;
}

async function steerTurn(session, client, markerName, expectedTurnId, messageId = randomUUID(), correlatedTurnId = expectedTurnId) {
  const marker = MARKERS[markerName];
  if (!marker) throw new NativeInstructionError('marker_not_allowlisted');
  session.markerTargets.register(markerName, messageId);
  const observation = await observeRpc(client, 'turn/steer', {
    threadId: session.threadId,
    input: exactMarkerInput(marker),
    clientUserMessageId: messageId,
    expectedTurnId,
  });
  if (observation.accepted) session.markerTargets.bindTurn(markerName, correlatedTurnId);
  return observation;
}

function queueItemHasMarker(entry, marker) {
  if (!entry || !Array.isArray(entry.input)) return false;
  return entry.input.some((part) => part && part.type === 'text' && part.text === marker);
}

function queueSummary(observation, data, clientMessageId) {
  const entries = Array.isArray(data) ? data : [];
  return {
    accepted: observation.accepted,
    rpc_code: observation.rpc_code,
    error_category: observation.error_category,
    count: entries.length,
    has_more: typeof observation.result?.nextCursor === 'string' && observation.result.nextCursor.length > 0,
    target_id_count: entries.filter((entry) => entry && entry.clientUserMessageId === clientMessageId).length,
    marker_a_count: entries.filter((entry) => queueItemHasMarker(entry, MARKERS.queueA)).length,
    marker_b_count: entries.filter((entry) => queueItemHasMarker(entry, MARKERS.queueB)).length,
    marker_cli_count: entries.filter((entry) => queueItemHasMarker(entry, MARKERS.queueCli)).length,
    start_id_available: entries.some((entry) => typeof entry?.id === 'string' && entry.id.length > 0),
  };
}

function newTurnIds(observer, before) {
  return [...observer.turnIds].filter((turnId) => !before.has(turnId));
}

async function runCliQueue(options, threadId, marker) {
  const env = makeChildEnvironment(process.env, options.home);
  env.POC161_REMOTE_TOKEN = options.token;
  const args = [
    'queue', '--thread', threadId, '--message', marker,
    '--remote', `ws://127.0.0.1:${options.port}`,
    '--remote-auth-token-env', 'POC161_REMOTE_TOKEN',
  ];
  return new Promise((resolveQueue) => {
    let child;
    let settled = false;
    let childClosed = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveQueue(value);
    };
    const timer = setTimeout(async () => {
      try { if (child && !childClosed) child.kill(); } catch {}
      if (child && !childClosed) {
        await Promise.race([
          new Promise((resolveClosed) => child.once('close', () => { childClosed = true; resolveClosed(); })),
          new Promise((resolveTimeout) => setTimeout(resolveTimeout, SERVER_STOP_TIMEOUT_MS)),
        ]);
      }
      finish({ exited: false, exit_code: null, timeout: true, child_stopped: childClosed || !child });
    }, options.timeoutMs);
    try {
      child = spawn(options.codexPath, args, {
        cwd: options.cwd,
        env,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch {
      finish({ exited: false, exit_code: null, timeout: false, child_stopped: true });
      return;
    }
    child.once('error', () => finish({ exited: false, exit_code: null, timeout: false, child_stopped: childClosed }));
    child.once('close', (code) => {
      childClosed = true;
      finish({ exited: true, exit_code: Number.isSafeInteger(code) ? code : null, timeout: false, child_stopped: true });
    });
  });
}

async function runLifecycle(session) {
  const { result, clientA, clientB, observerA, observerB, threadId, fixture, options } = session;
  fixture.gateNext();
  const turnStart = await startTurn(session, clientA, 'initial', randomUUID());
  const firstTurnId = turnStart.accepted ? extractTurnId(turnStart.result) : null;
  if (firstTurnId) {
    const gateObserved = await fixture.waitForGate(Math.min(options.timeoutMs, 10000));
    const started = await waitFor(() => turnStatus(observerA, firstTurnId) === 'inProgress', Math.min(options.timeoutMs, 5000));
    const wrongTurnId = randomUUID();
    const mismatch = await steerTurn(session, clientB, 'mismatchSteer', wrongTurnId, randomUUID(), firstTurnId);
    result.steer.mismatching = {
      accepted: mismatch.accepted,
      rpc_code: mismatch.rpc_code,
      error_category: mismatch.error_category,
      turn_id_matches: safeUuid(mismatch.result?.turnId) === firstTurnId,
    };
    const matching = gateObserved && started
      ? await steerTurn(session, clientB, 'steer', firstTurnId)
      : { accepted: false, rpc_code: null, error_category: 'turn_not_observed_active' };
    result.steer.matching = {
      accepted: matching.accepted,
      rpc_code: matching.rpc_code,
      error_category: matching.error_category,
      turn_id_matches: safeUuid(matching.result?.turnId) === firstTurnId,
      attempted_while_active: started,
    };
    fixture.release();
    const firstDone = await waitForTurn([observerA, observerB], firstTurnId, options.timeoutMs);
    result.turns.push(safeTurnRecord(firstTurnId, turnStart, observerA, observerB, firstDone));
    result.turns.at(-1).role = 'held_turn';
    result.turns.at(-1).fixture_gate_observed = gateObserved;
    result.steer.mismatching.native_user_message_seen = result.native_user_markers.mismatchSteer;
    result.steer.mismatching.fixture_input_seen = await waitFor(() => markerHit(fixture, 'mismatchSteer'), Math.min(options.timeoutMs, 2000));
    result.steer.matching.native_user_message_seen = result.native_user_markers.steer;
    result.steer.matching.fixture_input_seen = await waitFor(() => markerHit(fixture, 'steer'), Math.min(options.timeoutMs, 2000));
    const idle = await steerTurn(session, clientB, 'idleSteer', firstTurnId);
    result.steer.idle = {
      accepted: idle.accepted,
      rpc_code: idle.rpc_code,
      error_category: idle.error_category,
      attempted_after_terminal: firstDone,
      native_user_message_seen: result.native_user_markers.idleSteer,
      fixture_input_seen: await waitFor(() => markerHit(fixture, 'idleSteer'), Math.min(options.timeoutMs, 1000)),
    };
    const secondStart = await startTurn(session, clientA, 'second', randomUUID());
    if (secondStart.accepted) {
      const secondId = extractTurnId(secondStart.result);
      const secondDone = await waitForTurn([observerA, observerB], secondId, options.timeoutMs);
      result.turns.push(safeTurnRecord(secondId, secondStart, observerA, observerB, secondDone));
      result.turns.at(-1).role = 'followup_turn';
      result.turns.at(-1).native_user_message_seen = result.native_user_markers.second;
      result.turns.at(-1).fixture_input_seen = await waitFor(() => markerHit(fixture, 'second'), Math.min(options.timeoutMs, 5000));
    } else {
      result.turns.push({ id: null, start_accepted: false, start_error_category: secondStart.error_category, terminal_observed: false });
    }
  } else {
    fixture.release();
    result.turns.push({ id: null, start_accepted: false, start_error_category: turnStart.error_category, terminal_observed: false });
  }
  await runQueueChecks(session);
}

async function runQueueChecks(session) {
  const { result, clientA, clientB, threadId, fixture, options, observerA } = session;
  const disabled = await observeRpc(clientB, 'thread/queue/list', { threadId, limit: 10 });
  result.queue.api_experimental_false = {
    accepted: disabled.accepted,
    rpc_code: disabled.rpc_code,
    error_category: disabled.error_category,
  };
  const before = await observeRpc(clientA, 'thread/queue/list', { threadId, limit: 50 });
  result.queue.list_before = queueSummary(before, before.result?.data, null);
  const id = randomUUID();
  session.markerTargets.register('queueA', id);
  session.markerTargets.register('queueB', id);
  const turnIdsBeforeAdds = new Set(observerA.turnIds);
  const fixtureRequestCountBeforeAdds = fixture.requestCount;
  const addWindowStartedAt = Date.now();
  const first = await observeRpc(clientA, 'thread/queue/add', {
    threadId,
    clientUserMessageId: id,
    input: exactMarkerInput(MARKERS.queueA),
  });
  const same = await observeRpc(clientA, 'thread/queue/add', {
    threadId,
    clientUserMessageId: id,
    input: exactMarkerInput(MARKERS.queueA),
  });
  const sameList = await observeRpc(clientA, 'thread/queue/list', { threadId, limit: 50 });
  result.queue.same_id_same_payload = {
    first_accepted: first.accepted,
    repeat_accepted: same.accepted,
    repeat_error_category: same.error_category,
    snapshot: queueSummary(sameList, sameList.result?.data, id),
  };
  const conflict = await observeRpc(clientA, 'thread/queue/add', {
    threadId,
    clientUserMessageId: id,
    input: exactMarkerInput(MARKERS.queueB),
  });
  const after = await observeRpc(clientA, 'thread/queue/list', { threadId, limit: 50 });
  result.queue.same_id_different_payload = {
    accepted: conflict.accepted,
    rpc_code: conflict.rpc_code,
    error_category: conflict.error_category,
    snapshot: queueSummary(after, after.result?.data, id),
  };
  result.queue.list_after = queueSummary(after, after.result?.data, null);
  await waitFor(() => newTurnIds(observerA, turnIdsBeforeAdds).length > 0
    || fixture.requests.slice(fixtureRequestCountBeforeAdds).some((request) => request.marker_hits.queueA || request.marker_hits.queueB), 1500);
  const addWindowTurnIds = newTurnIds(observerA, turnIdsBeforeAdds);
  if (addWindowTurnIds.length === 1) {
    session.markerTargets.bindTurn('queueA', addWindowTurnIds[0]);
    session.markerTargets.bindTurn('queueB', addWindowTurnIds[0]);
  }
  const addWindowFixtureRequests = fixture.requests.slice(fixtureRequestCountBeforeAdds);
  const addWindowMarkerARequests = addWindowFixtureRequests.filter((request) => request.marker_hits.queueA).length;
  const addWindowMarkerBRequests = addWindowFixtureRequests.filter((request) => request.marker_hits.queueB).length;
  result.queue.api_add_window = {
    bounded: true,
    observation_window_ms: Math.max(0, Date.now() - addWindowStartedAt),
    turn_started_count: addWindowTurnIds.length,
    queue_a_fixture_input_count: addWindowMarkerARequests,
    queue_b_fixture_input_count: addWindowMarkerBRequests,
    attribution: addWindowTurnIds.length === 1 && (addWindowMarkerARequests + addWindowMarkerBRequests) > 0
      ? 'api_queue_add_phase_observed'
      : addWindowTurnIds.length > 0 || addWindowMarkerARequests + addWindowMarkerBRequests > 0
        ? 'api_queue_add_phase_unresolved' : 'not_observed_within_window',
  };
  for (const turnId of addWindowTurnIds) {
    await waitForTurn([observerA, clientB ? session.observerB : observerA], turnId, Math.min(options.timeoutMs, 5000));
  }
  const target = Array.isArray(after.result?.data)
    ? after.result.data.find((entry) => entry && entry.clientUserMessageId === id && typeof entry.id === 'string')
    : null;
  if (target) {
    const beforeTurnIds = new Set(observerA.turnIds);
    const explicitStartAt = Date.now();
    const start = await observeRpc(clientA, 'thread/queue/start', { threadId, queuedSubmissionId: target.id });
    let turnId = null;
    let terminal = false;
    if (start.accepted) {
      turnId = extractTurnId(start.result);
      terminal = await waitForTurn([observerA], turnId, options.timeoutMs);
    } else {
      await waitFor(() => newTurnIds(observerA, beforeTurnIds).length > 0, 1000);
    }
    const explicitStartTurnIds = newTurnIds(observerA, beforeTurnIds);
    result.queue.start = {
      accepted: start.accepted,
      rpc_code: start.rpc_code,
      error_category: start.error_category,
      turn_id_present: Boolean(turnId),
      terminal_observed: terminal,
      observed_new_turn: explicitStartTurnIds.length > 0,
      new_turn_count: explicitStartTurnIds.length,
    };
    result.queue.explicit_start_window = {
      bounded: true,
      observation_window_ms: Math.max(0, Date.now() - explicitStartAt),
      turn_started_count: explicitStartTurnIds.length,
      attribution: start.accepted && turnId ? 'queue_start_response_correlated'
        : explicitStartTurnIds.length > 0 ? 'unknown_after_adds_and_start_attempt'
          : 'no_turn_observed_within_window',
    };
  } else {
    result.queue.start = { accepted: false, error_category: 'queue_item_not_observed', turn_id_present: false, terminal_observed: false, observed_new_turn: false, new_turn_count: 0 };
    result.queue.explicit_start_window = { bounded: true, observation_window_ms: 0, turn_started_count: 0, attribution: 'no_target_item_observed' };
  }
}

async function runQueueCliScenario(session) {
  const { result, clientA, observerA, threadId, fixture, options } = session;
  const before = await observeRpc(clientA, 'thread/queue/list', { threadId, limit: 50 });
  result.queue.cli_list_before = queueSummary(before, before.result?.data, null);
  const beforeTurnIds = new Set(observerA.turnIds);
  const fixtureRequestCountBefore = fixture.requestCount;
  const startedAt = Date.now();
  session.markerTargets.register('queueCli', null);
  fixture.gateNext();
  const cliResult = await runCliQueue({ ...options, home: options.home, cwd: options.cwd }, threadId, MARKERS.queueCli);
  const gateObserved = await fixture.waitForGate(Math.min(options.timeoutMs, 5000));
  const gatedTurnIds = newTurnIds(observerA, beforeTurnIds);
  if (gateObserved && gatedTurnIds.length === 1) session.markerTargets.bindTurn('queueCli', gatedTurnIds[0]);
  if (gateObserved) {
    await waitFor(() => result.native_user_marker_evidence.queueCli.same_item_thread_turn_match, 1000);
  }
  fixture.release();
  await waitFor(() => newTurnIds(observerA, beforeTurnIds).length > 0
    || fixture.requests.slice(fixtureRequestCountBefore).some((request) => request.marker_hits.queueCli), 1500);
  const observedTurnIds = newTurnIds(observerA, beforeTurnIds);
  const uniqueObservedTurnId = observedTurnIds.length === 1 ? observedTurnIds[0] : null;
  if (uniqueObservedTurnId) session.markerTargets.bindTurn('queueCli', uniqueObservedTurnId);
  if (uniqueObservedTurnId) {
    await waitFor(() => result.native_user_marker_evidence.queueCli.same_item_thread_turn_match, 1000);
    await waitForTurn([observerA], uniqueObservedTurnId, Math.min(options.timeoutMs, 5000));
  }
  const after = await observeRpc(clientA, 'thread/queue/list', { threadId, limit: 50 });
  const afterData = Array.isArray(after.result?.data) ? after.result.data.slice(0, 50) : [];
  const fixtureRequests = fixture.requests.slice(fixtureRequestCountBefore);
  const fixtureInputSeen = fixtureRequests.some((request) => request.marker_hits.queueCli === true);
  const newIds = newTurnIds(observerA, beforeTurnIds);
  const queueMarkerCount = afterData.filter((entry) => queueItemHasMarker(entry, MARKERS.queueCli)).length;
  const nativeUserItemThreadTurnSeen = result.native_user_marker_evidence.queueCli.same_item_thread_turn_match;
  const terminalStatus = uniqueObservedTurnId ? turnStatus(observerA, uniqueObservedTurnId) : 'unknown';
  const queueReceived = cliResult.exited && cliResult.exit_code === 0
    && (queueMarkerCount > 0 || fixtureInputSeen || newIds.length > 0);
  const deliveryCompleted = queueReceived && fixtureInputSeen && nativeUserItemThreadTurnSeen
    && newIds.length === 1 && terminalStatus === 'completed';
  let attribution = 'no_cli_marker_or_turn_observed_within_window';
  if (deliveryCompleted) attribution = 'cli_marker_same_thread_turn_completed';
  else if (fixtureInputSeen && newIds.length === 1 && nativeUserItemThreadTurnSeen) attribution = 'cli_marker_and_same_thread_turn_item_observed_terminal_unknown';
  else if (fixtureInputSeen) attribution = 'cli_marker_fixture_input_seen_turn_correlation_incomplete';
  else if (queueMarkerCount > 0 && newIds.length === 0) attribution = 'cli_marker_queued_without_turn_observed';
  else if (newIds.length > 0) attribution = 'turn_delta_without_cli_marker_correlation';
  result.queue.cli = {
    fresh_thread_without_api_queue: true,
    process_exited: cliResult.exited,
    exit_code: cliResult.exit_code,
    timed_out: cliResult.timeout,
    child_stopped: cliResult.child_stopped,
    list_before_accepted: before.accepted,
    list_after_accepted: after.accepted,
    marker_seen_in_queue_count: queueMarkerCount,
    queue_received: queueReceived,
    fixture_input_seen: fixtureInputSeen,
    native_user_item_thread_turn_seen: nativeUserItemThreadTurnSeen,
    native_client_message_id_known: false,
    turn_started_during_observation: newIds.length > 0,
    new_turn_count: newIds.length,
    unique_turn_terminal_observed: Boolean(uniqueObservedTurnId && ['completed', 'failed', 'interrupted'].includes(terminalStatus)),
    unique_turn_terminal_status: terminalStatus,
    delivery_completed: deliveryCompleted,
    gate_observed: gateObserved,
    attribution,
    observation_window_ms: Math.max(0, Date.now() - startedAt),
    measurement_completed: true,
  };
  result.queue.cli_list_after = queueSummary(after, afterData, null);
  result.cleanup.cli_child_stopped = cliResult.child_stopped === true;
}

async function runSpecialCase(session) {
  const { result, options, clientA, observerA, observerB, threadId, fixture } = session;
  fixture.setCallMode(options.mode === 'question' ? 'question'
    : options.mode === 'tool' || options.mode === 'approval' ? 'exec' : 'final');
  fixture.gateNext();
  const start = await startTurn(session, clientA, 'initial', randomUUID());
  if (!start.accepted) {
    fixture.release();
    result.turns.push({ id: null, start_accepted: false, start_error_category: start.error_category, terminal_observed: false });
    return;
  }
  const turnId = extractTurnId(start.result);
  const gateObserved = await fixture.waitForGate(Math.min(options.timeoutMs, 10000));
  if (options.mode === 'stop') {
    const active = await waitFor(() => turnStatus(observerA, turnId) === 'inProgress', Math.min(options.timeoutMs, 5000));
    const interrupted = await observeRpc(clientA, 'turn/interrupt', { threadId, turnId });
    fixture.release();
    const terminal = await waitForTurn([observerA, observerB], turnId, options.timeoutMs);
    result.turns.push({ ...safeTurnRecord(turnId, start, observerA, observerB, terminal), role: 'stop', stop_requested: interrupted.accepted, active_before_stop: active });
    result.turns.at(-1).fixture_gate_observed = gateObserved;
    return;
  }
  fixture.release();
  if (options.mode === 'question' || options.mode === 'approval') {
    const category = options.mode === 'question' ? 'question' : 'approval';
    await waitFor(() => observerA.summary().server_requests[category] > 0, Math.min(options.timeoutMs, 10000));
    const active = turnStatus(observerA, turnId);
    const interrupted = active === 'inProgress'
      ? await observeRpc(clientA, 'turn/interrupt', { threadId, turnId })
      : { accepted: false };
    fixture.release();
    const terminal = await waitForTurn([observerA, observerB], turnId, options.timeoutMs);
    result.turns.push({ ...safeTurnRecord(turnId, start, observerA, observerB, terminal), role: options.mode, pending_kind: category,
      pending_request_observed: observerA.summary().server_requests[category] > 0,
      runner_replied_to_server_request: false,
      stop_requested: interrupted.accepted,
      waiting_flags: observerA.summary().waiting_on_user_input,
    });
    result.turns.at(-1).fixture_gate_observed = gateObserved;
    return;
  }
  fixture.release();
  const terminal = await waitForTurn([observerA, observerB], turnId, options.timeoutMs);
  result.turns.push({ ...safeTurnRecord(turnId, start, observerA, observerB, terminal), role: options.mode });
  result.turns.at(-1).fixture_gate_observed = gateObserved;
}

function completedByBoth(turn) {
  return Boolean(turn && turn.start_accepted && turn.terminal_observed
    && turn.status_a === 'completed' && turn.status_b === 'completed');
}

function calculateMeasurementSuccess(result) {
  const warmup = result.turns.find((turn) => turn.role === 'thread_materialization_warmup');
  const warmupObserved = Boolean(warmup && warmup.terminal_observed && warmup.status_a === 'completed'
    && warmup.fixture_input_seen);
  const sharedThreadReady = result.target_version === REQUIRED_CODEX_VERSION && result.thread.same_id
    && result.settings.start_resume_match === true;
  if (result.failure_code || !warmupObserved || !sharedThreadReady) return false;
  if (result.mode === 'serve') return Boolean(result.serve.ready_file && result.serve.stop_requested);
  if (result.mode === 'queue-cli') return Boolean(result.queue.cli && result.queue.cli.measurement_completed);
  if (result.mode === 'lifecycle') {
    const held = result.turns.find((turn) => turn.role === 'held_turn');
    const followup = result.turns.find((turn) => turn.role === 'followup_turn');
    return Boolean(held && held.terminal_observed && followup && followup.terminal_observed
      && held.fixture_gate_observed && result.steer.matching && result.steer.mismatching && result.steer.idle
      && result.queue.api_experimental_false && result.queue.list_before && result.queue.same_id_same_payload
      && result.queue.same_id_different_payload && result.queue.api_add_window
      && result.queue.start && result.queue.explicit_start_window);
  }
  const turn = result.turns.find((item) => item.role === result.mode);
  if (!turn || !turn.terminal_observed || !turn.fixture_gate_observed) return false;
  return true;
}

function calculateFeatureFlowSuccess(result) {
  if (result.mode === 'queue-cli') {
    const cli = result.queue.cli;
    return Boolean(result.measurement_success && cli && cli.delivery_completed === true);
  }
  if (result.mode !== 'lifecycle') return null;
  if (!result.measurement_success) return false;
  const held = result.turns.find((turn) => turn.role === 'held_turn');
  const followup = result.turns.find((turn) => turn.role === 'followup_turn');
  return Boolean(completedByBoth(held) && completedByBoth(followup)
    && held.fixture_gate_observed
    && result.steer.mismatching.accepted === false
    && result.steer.matching.accepted === true
    && result.steer.matching.turn_id_matches === true
    && result.steer.matching.attempted_while_active === true
    && result.steer.matching.fixture_input_seen === true
    && result.steer.matching.native_user_message_seen === true
    && result.steer.idle.accepted === false
    && result.steer.idle.attempted_after_terminal === true
    && result.queue.api_experimental_false.accepted === false
    && result.queue.list_before.accepted === true
    && result.queue.same_id_same_payload.first_accepted === true
    && result.queue.same_id_same_payload.repeat_accepted === true
    && result.queue.start.accepted === true && result.queue.start.terminal_observed === true
    && result.queue.api_add_window.bounded === true
    && result.queue.explicit_start_window.bounded === true);
}

function calculateStateProbeSuccess(result) {
  if (!['tool', 'question', 'approval', 'stop'].includes(result.mode)) return null;
  const turn = result.turns.find((item) => item.role === result.mode);
  if (!result.measurement_success || !turn) return false;
  if (result.mode === 'tool') return result.fixture.exec_tool_declared && result.fixture.call_output_count > 0;
  if (result.mode === 'question' || result.mode === 'approval') {
    return turn.pending_request_observed === true && turn.runner_replied_to_server_request === false
      && turn.stop_requested === true && turn.status_a === 'interrupted' && turn.status_b === 'interrupted';
  }
  return turn.stop_requested === true && turn.active_before_stop === true
    && turn.status_a === 'interrupted' && turn.status_b === 'interrupted';
}

function createReadyFile(output, details) {
  const readyPath = path.join(output, 'native-ready.json');
  assertNoSymlinkComponents(REPOSITORY_ROOT, readyPath);
  const contents = JSON.stringify({
    schema: 'agent-cockpit-poc161-native-ready-v1',
    host: '127.0.0.1',
    port: details.port,
    websocket_url: `ws://127.0.0.1:${details.port}`,
    codex_home: details.home,
    cwd: details.cwd,
    thread_id: details.threadId,
    token_file: details.tokenPath,
    token_environment_name: 'POC161_REMOTE_TOKEN',
  }, null, 2) + '\n';
  if (Buffer.byteLength(contents) > 8192) throw new NativeInstructionError('ready_file_too_large');
  fs.writeFileSync(readyPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return readyPath;
}

function parseControlLine(line) {
  if (typeof line !== 'string' || Buffer.byteLength(line, 'utf8') > MAX_CONTROL_LINE_BYTES) return null;
  let value;
  try { value = JSON.parse(line); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value);
  if (keys.some((key) => !['op', 'marker', 'turn'].includes(key))) return null;
  if (value.op === 'release' || value.op === 'snapshot' || value.op === 'stop') return keys.length === 1 ? value : null;
  if (value.op === 'start') return keys.length === 2 && Object.keys(MARKERS).includes(value.marker) ? value : null;
  if (value.op === 'steer') {
    return keys.length === 3 && ['active', 'mismatch', 'idle'].includes(value.turn)
      && Object.keys(MARKERS).includes(value.marker) ? value : null;
  }
  return null;
}

async function runServeControl(session, readyPath, input = process.stdin) {
  const rl = readline.createInterface({ input, crlfDelay: Infinity, terminal: false });
  let stopping = false;
  const { fixture, result, threadId, clientA, clientB, observerA } = session;
  const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
  try {
    for await (const line of rl) {
      const command = parseControlLine(line);
      result.serve.control_commands += 1;
      if (!command) {
        emit({ ok: false, error: 'invalid_control_command' });
        continue;
      }
      if (command.op === 'release') {
        fixture.release();
        emit({ ok: true, op: 'release', fixture_request_count: fixture.requestCount });
      } else if (command.op === 'snapshot') {
        emit({ ok: true, op: 'snapshot', active_turn_count: [...observerA.turnStatuses.values()].filter((status) => status === 'inProgress').length,
          fixture_request_count: fixture.requestCount, native_user_markers: result.native_user_markers });
    } else if (command.op === 'start') {
        const markerName = Object.keys(MARKERS).find((name) => MARKERS[name] === command.marker) || command.marker;
        const start = await startTurn(session, clientA, markerName, randomUUID());
        emit({ ok: start.accepted, op: 'start', turn_id: start.accepted ? safeUuid(start.result?.turn?.id) : null,
          error_category: start.error_category });
      } else if (command.op === 'steer') {
        const active = [...observerA.turnStatuses.entries()].filter(([, status]) => status === 'inProgress').at(-1)?.[0];
        const ended = [...observerA.turnStatuses.entries()].filter(([, status]) => ['completed', 'failed', 'interrupted'].includes(status)).at(-1)?.[0];
        const expectedTurnId = command.turn === 'active' ? active : command.turn === 'idle' ? ended : randomUUID();
        if (!expectedTurnId) {
          emit({ ok: false, op: 'steer', error_category: 'turn_target_not_observed' });
          continue;
        }
        const sent = await steerTurn(session, clientB, command.marker, expectedTurnId);
        emit({ ok: sent.accepted, op: 'steer', accepted: sent.accepted, error_category: sent.error_category,
          turn_id_matches: safeUuid(sent.result?.turnId) === expectedTurnId,
          fixture_input_seen: markerHit(fixture, command.marker) });
      } else if (command.op === 'stop') {
        const active = [...observerA.turnStatuses.entries()].filter(([, status]) => status === 'inProgress').at(-1)?.[0];
        if (active) await observeRpc(clientA, 'turn/interrupt', { threadId, turnId: active });
        fixture.release();
        stopping = true;
        result.serve.stop_requested = true;
        emit({ ok: true, op: 'stop', active_turn_observed: Boolean(active) });
        break;
      }
    }
  } finally {
    rl.close();
    if (!stopping) fixture.release();
  }
  result.serve.ready_file = path.relative(result.output_directory, readyPath).split(path.sep).join('/');
}

async function runNativeProbe(options, dependencies = {}) {
  const normalized = {
    ...options,
    timeoutMs: Number.isSafeInteger(options && options.timeoutMs)
      ? Math.min(Math.max(options.timeoutMs, 1000), MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS,
    mode: options && ['lifecycle', 'queue-cli', 'tool', 'question', 'approval', 'stop'].includes(options.mode) ? options.mode : 'lifecycle',
    serve: options && options.serve === true,
  };
  const result = createResult(normalized);
  let output = null;
  let outputOwned = false;
  let layout = null;
  let fixture = null;
  let tokenFile = null;
  let configSnapshot = null;
  let server = null;
  let connectionA = null;
  let connectionB = null;
  let observerA = createObserver();
  let observerB = createObserver();
  let signalSeen = false;
  let currentStage = 'output_validation';
  const signalSource = dependencies.signalSource || process;
  const onSignal = () => {
    signalSeen = true;
    if (fixture) fixture.release();
    if (server && !server.state.closed) {
      try { server.child.kill(); } catch {}
    }
  };
  signalSource.on('SIGINT', onSignal);
  signalSource.on('SIGTERM', onSignal);
  try {
    const codexPath = validateExecutable(normalized.codexPath);
    output = resolveOutputDirectory(normalized.outputDirectory || DEFAULT_OUTPUT);
    assertNoSymlinkComponents(REPOSITORY_ROOT, output);
    if (fs.existsSync(output)) throw new NativeInstructionError('output_directory_not_fresh');
    currentStage = 'setup';
    (dependencies.setup || setup)({
      outputDirectory: path.relative(REPOSITORY_ROOT, output).split(path.sep).join('/'),
      codexVersion: REQUIRED_CODEX_VERSION,
    });
    outputOwned = true;
    const paths = (dependencies.validatePaths || validatePaths)(codexPath, path.relative(REPOSITORY_ROOT, output).split(path.sep).join('/'));
    currentStage = 'private_home';
    layout = (dependencies.createRuntimeHome || createRuntimeHome)(paths.layout);
    result.output_directory = path.relative(REPOSITORY_ROOT, output).split(path.sep).join('/');
    result.private_home = path.relative(output, layout.home).split(path.sep).join('/');
    currentStage = 'fixture_start';
    fixture = (dependencies.createFixture || createNativeInstructionFixture)({
      callMode: 'final',
      gateCount: 0,
      timeoutMs: normalized.timeoutMs,
      workdir: layout.repo,
    });
    await fixture.start();
    currentStage = 'version_check';
    const version = await (dependencies.runVersionCheck || runVersionCheck)(paths.executable, layout.home, {
      cwd: layout.repo,
      timeoutMs: normalized.timeoutMs,
    });
    result.target_version = version.version;
    if (version.version !== REQUIRED_CODEX_VERSION) throw new NativeInstructionError('unsupported_native_version');
    currentStage = 'private_config';
    configSnapshot = writePrivateConfig(layout, fixture);
    currentStage = 'server_start';
    const port = await (dependencies.choosePort || chooseLoopbackPort)();
    tokenFile = createTokenFile(output);
    const spawnServer = dependencies.startServer || startServerProcess;
    server = spawnServer(paths.executable, layout.repo, layout.home, port, tokenFile.tokenPath, dependencies);
    currentStage = 'connect_a';
    const connect = dependencies.connect || connectViaWebSocket;
    connectionA = await connectClient({ port, token: tokenFile.token, timeoutMs: normalized.timeoutMs }, server, observerA, connect);
    currentStage = 'initialize_a';
    const initializedA = await initializeClient(connectionA, layout.home, true);
    result.clients.a.initialized = true;
    result.clients.a.private_home_match = initializedA.privateHomeMatch;
    result.target_version = initializedA.version;
    if (initializedA.version !== REQUIRED_CODEX_VERSION || !initializedA.privateHomeMatch) {
      throw new NativeInstructionError('private_app_server_identity_mismatch');
    }
    currentStage = 'connect_b';
    connectionB = await connectClient({ port, token: tokenFile.token, timeoutMs: normalized.timeoutMs }, server, observerB, connect);
    currentStage = 'initialize_b';
    const initializedB = await initializeClient(connectionB, layout.home, false);
    result.clients.b.initialized = true;
    result.clients.b.private_home_match = initializedB.privateHomeMatch;
    if (initializedB.version !== REQUIRED_CODEX_VERSION || !initializedB.privateHomeMatch) {
      throw new NativeInstructionError('private_app_server_identity_mismatch');
    }
    currentStage = 'thread_start';
    const started = await observeRpc(connectionA.client, 'thread/start', {
      cwd: layout.repo,
      approvalPolicy: 'on-request',
      sandbox: 'read-only',
      ephemeral: false,
    });
    if (!started.accepted) throw new NativeInstructionError('thread_start_rejected');
    const threadId = extractThreadId(started.result);
    result.thread = { id: threadId, started: true, client_b_resumed: false, same_id: false };
    result.settings.after_start = projectThreadSettings(started.result, layout.repo);
    if (!result.settings.after_start.requested_settings_preserved) {
      throw new NativeInstructionError('thread_start_settings_not_confirmed');
    }
    const markerTargets = createMarkerTargets(threadId, result);
    const session = {
      options: { ...normalized, codexPath, home: layout.home, cwd: layout.repo, port, token: tokenFile.token },
      result,
      fixture,
      server,
      layout,
      clientA: connectionA.client,
      clientB: connectionB.client,
      observerA,
      observerB,
      markerTargets,
      threadId,
    };
    installClientMarkerObserver(connectionA.client, result, markerTargets);
    currentStage = 'warmup_turn';
    const warmup = await startTurn(session, connectionA.client, 'warmup', randomUUID());
    if (!warmup.accepted) throw new NativeInstructionError('warmup_turn_start_rejected');
    const warmupId = extractTurnId(warmup.result);
    const warmupTerminal = await waitForTurn([observerA], warmupId, normalized.timeoutMs);
    result.turns.push(safeTurnRecord(warmupId, warmup, observerA, observerB, warmupTerminal));
    result.turns.at(-1).role = 'thread_materialization_warmup';
    result.turns.at(-1).fixture_input_seen = await waitFor(() => markerHit(fixture, 'warmup'), Math.min(normalized.timeoutMs, 3000));
    result.turns.at(-1).native_user_message_seen = result.native_user_markers.warmup;
    if (!warmupTerminal || turnStatus(observerA, warmupId) !== 'completed') {
      throw new NativeInstructionError('warmup_turn_not_completed');
    }
    result.settings.before_resume = await readThreadSettings(connectionA.client, threadId);
    currentStage = 'thread_resume_b';
    const resumed = await observeRpc(connectionB.client, 'thread/resume', { threadId });
    result.thread.client_b_resumed = resumed.accepted;
    result.thread.same_id = resumed.accepted && extractThreadId(resumed.result) === threadId;
    if (!resumed.accepted || !result.thread.same_id) throw new NativeInstructionError('second_client_thread_resume_failed');
    result.settings.after_resume = projectThreadSettings(resumed.result, layout.repo);
    result.settings.start_resume_match = compareThreadSettings(result.settings.after_start, result.settings.after_resume);
    if (!result.settings.start_resume_match) {
      throw new NativeInstructionError('thread_resume_settings_not_confirmed');
    }
    if (normalized.serve) {
      currentStage = 'serve_turn_start';
      fixture.gateNext();
      const first = await startTurn(session, connectionA.client, 'initial', randomUUID());
      if (!first.accepted) throw new NativeInstructionError('serve_turn_start_failed');
      const turnId = extractTurnId(first.result);
      result.turns.push({ id: turnId, role: 'held_serve_turn', start_accepted: true,
        start_status: safeTurnStatus(first.result?.turn?.status), status_a: 'unknown', status_b: 'unknown', terminal_observed: false });
      const gateObserved = await fixture.waitForGate(Math.min(normalized.timeoutMs, 10000));
      result.turns.at(-1).fixture_gate_observed = gateObserved;
      if (!gateObserved) throw new NativeInstructionError('serve_fixture_gate_not_observed');
      const readyPath = createReadyFile(output, { port, home: layout.home, cwd: layout.repo, threadId, tokenPath: tokenFile.tokenPath });
      result.serve.ready_file = path.relative(output, readyPath).split(path.sep).join('/');
      process.stdout.write(`${JSON.stringify({ ok: true, ready_file: result.serve.ready_file })}\n`);
      currentStage = 'serve_control';
      await runServeControl(session, readyPath, dependencies.input || process.stdin);
    } else if (normalized.mode === 'lifecycle') {
      currentStage = 'lifecycle';
      await runLifecycle(session);
    } else if (normalized.mode === 'queue-cli') {
      currentStage = 'queue_cli';
      await runQueueCliScenario(session);
    } else {
      currentStage = 'special_case';
      await runSpecialCase(session);
    }
    if (!normalized.serve) {
      result.settings.after_probe = await readThreadSettings(connectionA.client, threadId);
    }
  } catch (error) {
    result.failure_stage = currentStage;
    result.failure_code = safeErrorKind(error, 'native_probe_failed');
    result.success = false;
  } finally {
    try { if (fixture) fixture.release(); } catch {}
    try {
      if (connectionA) {
        result.cleanup.client_a_closed = false;
        connectionA.close();
        result.cleanup.client_a_closed = true;
      }
    } catch {}
    try {
      if (connectionB) {
        result.cleanup.client_b_closed = false;
        connectionB.close();
        result.cleanup.client_b_closed = true;
      }
    } catch {}
    result.cleanup.server_stopped = await stopServer(server);
    result.cleanup.fixture_closed = !fixture;
    try {
      result.cleanup.fixture_closed = fixture ? (await fixture.close()) !== false : true;
    } catch {}
    if (result.cleanup.server_stopped) {
      result.cleanup.private_config_restored = !configSnapshot;
      try {
        result.cleanup.private_config_restored = configSnapshot
          ? clearFixtureConfig(layout.configPath, configSnapshot) : true;
      } catch {}
      result.cleanup.token_file_removed = removeTokenFile(tokenFile);
      result.cleanup.private_home_removed = layout ? removePrivateHome(output, layout.home) : true;
    } else {
      result.cleanup.private_config_restored = !configSnapshot;
      result.cleanup.token_file_removed = !tokenFile;
      result.cleanup.private_home_removed = !layout;
    }
    result.fixture = fixture ? collectFixtureSummary(fixture) : result.fixture;
    result.observed.a = observerA.summary();
    result.observed.b = observerB.summary();
    if (signalSeen && !result.failure_code) {
      result.success = false;
      result.failure_stage = currentStage;
      result.failure_code = 'signal_received';
    }
    if (typeof signalSource.off === 'function') {
      signalSource.off('SIGINT', onSignal);
      signalSource.off('SIGTERM', onSignal);
    } else if (typeof signalSource.removeListener === 'function') {
      signalSource.removeListener('SIGINT', onSignal);
      signalSource.removeListener('SIGTERM', onSignal);
    }
    if (output && !result.output_directory) result.output_directory = path.relative(REPOSITORY_ROOT, output).split(path.sep).join('/');
    result.measurement_success = calculateMeasurementSuccess(result);
    result.feature_flow_success = calculateFeatureFlowSuccess(result);
    result.state_probe_success = calculateStateProbeSuccess(result);
    if (result.mode === 'lifecycle') {
      result.ordinary_instruction_delivery_observed = Boolean(result.steer.matching?.accepted
        && result.steer.matching?.fixture_input_seen && result.steer.matching?.native_user_message_seen);
    } else if (result.mode === 'serve') {
      result.ordinary_instruction_delivery_observed = Object.keys(MARKERS)
        .filter((name) => name !== 'warmup')
        .some((name) => result.native_user_markers[name] && result.fixture.request_markers[name] > 0);
    } else if (result.mode === 'queue-cli') {
      result.ordinary_instruction_delivery_observed = Boolean(result.queue.cli?.fixture_input_seen
        && result.queue.cli?.native_user_item_thread_turn_seen);
    }
    const cleanupComplete = Object.values(result.cleanup).every((value) => value === true);
    result.success = result.measurement_success && cleanupComplete && !result.failure_code;
    if (!result.success && !result.failure_code) result.failure_code = cleanupComplete
      ? 'measurement_incomplete' : 'cleanup_incomplete';
    if (outputOwned && output) {
      try {
        const resultPath = path.join(output, 'native-result.json');
        assertNoSymlinkComponents(REPOSITORY_ROOT, resultPath);
        result.result_file = path.relative(REPOSITORY_ROOT, resultPath).split(path.sep).join('/');
        const serialized = JSON.stringify(result, null, 2) + '\n';
        if (Buffer.byteLength(serialized) <= MAX_RESULT_BYTES && !fs.existsSync(resultPath)) {
          fs.writeFileSync(resultPath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        } else {
          result.success = false;
          result.failure_code = 'result_size_or_path_invalid';
        }
      } catch {
        result.success = false;
        result.failure_code = 'result_write_failed';
      }
    }
  }
  return result;
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeErrorKind(error, 'invalid_arguments') })}\n`);
    process.exitCode = 2;
    return;
  }
  const result = await runNativeProbe(options);
  process.stdout.write(`${JSON.stringify({ success: result.success, result_file: result.result_file || null,
    failure_stage: result.failure_stage, failure_code: result.failure_code })}\n`);
  if (!result.success) process.exitCode = 1;
}

if (require.main === module) main(process.argv.slice(2)).catch(() => {
  process.stderr.write('{"ok":false,"error":"native_probe_failed"}\n');
  process.exitCode = 1;
});

module.exports = {
  DEFAULT_OUTPUT,
  DEFAULT_TIMEOUT_MS,
  MAX_RESULT_BYTES,
  MARKERS,
  NativeInstructionError,
  calculateFeatureFlowSuccess,
  calculateMeasurementSuccess,
  calculateStateProbeSuccess,
  compareThreadSettings,
  createMarkerTargets,
  createObserver,
  createResult,
  exactMarkerInput,
  installClientMarkerObserver,
  parseArguments,
  parseControlLine,
  projectThreadSettings,
  queueSummary,
  readThreadSettings,
  runNativeProbe,
  safeRpcCategory,
  safeRpcCode,
  safeTurnStatus,
  stopServer,
};
