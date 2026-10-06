'use strict';

const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { randomBytes, randomUUID, createHash } = require('node:crypto');
const { spawn } = require('node:child_process');
const {
  assertNoSymlinkComponents,
  makeLayout,
  renderConfig,
  renderHooksConfig,
  resolveOutputDirectory,
  REPOSITORY_ROOT,
  REQUIRED_CODEX_VERSION,
  setup,
} = require('../codex-hooks-identity/setup');
const {
  clearFixtureConfig,
  FIXTURE_MODEL,
  makeChildEnvironment,
  startFixture,
} = require('../codex-hooks-identity/run-exec');
const { connectViaTcp, RPC_ERROR_CATEGORIES, validateInitializeResponse } = require('./collector');

const DEFAULT_OUTPUT = 'poc/out/poc158-managed';
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 60000;
const CONNECT_ATTEMPT_TIMEOUT_MS = 1200;
const SERVER_STOP_TIMEOUT_MS = 5000;
const FIXTURE_CLOSE_TIMEOUT_MS = 5000;
const MAX_LOADED_PAGES = 10;
const MAX_CAPTURED_STDERR_BYTES = 4096;
const MAX_TRACKED_TURN_IDS = 64;
const MAX_ADDITIONAL_THREAD_READS = 10;
const JSON_RPC_METHODS = Object.freeze([
  'initialize',
  'initialized',
  'thread/start',
  'thread/resume',
  'thread/read',
  'thread/loaded/list',
  'turn/start',
]);
const NOTIFICATION_METHODS = new Set([
  'thread/started', 'thread/status/changed', 'thread/closed', 'thread/name/updated',
  'turn/started', 'turn/completed', 'turn/plan/updated', 'item/started', 'item/completed',
  'item/mcpToolCall/progress', 'serverRequest/resolved',
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TURN_TERMINAL_STATUSES = new Set(['completed', 'interrupted', 'failed']);
const TURN_STATUS_METHODS = new Set(['turn/started', 'turn/status/changed', 'turn/completed']);
const THREAD_STATUS_TYPES = new Set(['notLoaded', 'idle', 'systemError', 'active']);
const THREAD_SOURCES = new Set(['cli', 'vscode', 'exec', 'appServer', 'subAgent', 'custom', 'unknown']);

class ManagedRunError extends Error {
  constructor(kind) {
    super(kind);
    this.name = 'ManagedRunError';
    this.kind = kind;
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--serve' || option === '--serve-pending-turn') {
      if (values.has(option)) throw new ManagedRunError('invalid_arguments');
      values.set(option, true);
      continue;
    }
    if (!['--codex-path', '--out', '--timeout-ms'].includes(option) || values.has(option)
      || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new ManagedRunError('invalid_arguments');
    }
    values.set(option, argv[index + 1]);
    index += 1;
  }
  const timeoutMs = values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new ManagedRunError('invalid_timeout');
  }
  if (values.has('--serve') && values.has('--serve-pending-turn')) {
    throw new ManagedRunError('invalid_arguments');
  }
  return {
    codexPath: values.get('--codex-path'),
    outputDirectory: values.get('--out') || DEFAULT_OUTPUT,
    timeoutMs,
    serve: values.has('--serve'),
    servePendingTurn: values.has('--serve-pending-turn'),
  };
}

function prepareWorkspace(outputDirectory) {
  const output = resolveOutputDirectory(outputDirectory);
  assertNoSymlinkComponents(REPOSITORY_ROOT, output);
  if (!fs.existsSync(output)) {
    return setup({
      outputDirectory: path.relative(REPOSITORY_ROOT, output),
      codexVersion: REQUIRED_CODEX_VERSION,
    });
  }
  const layout = makeLayout(output);
  const expectedFiles = [
    [layout.home, 'directory'],
    [layout.repo, 'directory'],
    [path.join(layout.home, 'config.toml'), 'file'],
    [path.join(layout.home, 'hooks.json'), 'file'],
    [path.join(layout.repo, '.git'), 'directory'],
  ];
  for (const [target, kind] of expectedFiles) {
    const stat = fs.lstatSync(target);
    if (stat.isSymbolicLink() || (kind === 'directory' ? !stat.isDirectory() : !stat.isFile())) {
      throw new ManagedRunError('invalid_existing_setup');
    }
  }
  const expectedConfig = renderConfig(path.join(__dirname, '..', 'codex-hooks-identity', 'mcp-probe.js'));
  const expectedHooks = renderHooksConfig(path.join(layout.hooks, 'hook-logger.js'));
  if (fs.readFileSync(path.join(layout.home, 'config.toml'), 'utf8') !== expectedConfig
    || fs.readFileSync(path.join(layout.home, 'hooks.json'), 'utf8') !== expectedHooks) {
    throw new ManagedRunError('existing_setup_mismatch');
  }
  return layout;
}

function validateExecutable(codexPath) {
  if (typeof codexPath !== 'string' || !path.isAbsolute(codexPath)) {
    throw new ManagedRunError('absolute_codex_path_required');
  }
  let stat;
  try {
    stat = fs.lstatSync(codexPath);
  } catch {
    throw new ManagedRunError('codex_executable_missing');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ManagedRunError('invalid_codex_executable');
  return path.resolve(codexPath);
}

function assertPrivateHome(output, home) {
  const resolvedOutput = path.resolve(output);
  const resolvedHome = path.resolve(home);
  const relative = path.relative(resolvedOutput, resolvedHome);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new ManagedRunError('private_home_outside_output');
  }
  assertNoSymlinkComponents(resolvedOutput, resolvedHome);
  const stat = fs.lstatSync(resolvedHome);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new ManagedRunError('invalid_private_home');
}

function readRegularFile(filePath) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ManagedRunError('expected_regular_file');
  return fs.readFileSync(filePath);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function createCapabilityTokenFile(output, runId, randomBytesImpl = randomBytes) {
  const token = randomBytesImpl(32).toString('hex');
  const tokenPath = path.join(output, `.poc158-capability-${runId}.token`);
  assertNoSymlinkComponents(output, tokenPath);
  fs.writeFileSync(tokenPath, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  const stat = fs.lstatSync(tokenPath);
  if (!stat.isFile() || stat.isSymbolicLink() || fs.readFileSync(tokenPath, 'utf8') !== token) {
    throw new ManagedRunError('capability_token_file_invalid');
  }
  return { token, tokenPath, tokenHash: sha256(token) };
}

function removeCapabilityTokenFile(tokenPath, expectedHash) {
  if (!tokenPath) return true;
  try {
    const contents = readRegularFile(tokenPath);
    if (sha256(contents) !== expectedHash) return false;
    fs.unlinkSync(tokenPath);
    return true;
  } catch (error) {
    return error && error.code === 'ENOENT';
  }
}

function chooseLoopbackPort(netImpl = net) {
  return new Promise((resolvePort, rejectPort) => {
    const probe = netImpl.createServer();
    probe.once('error', () => rejectPort(new ManagedRunError('loopback_port_probe_failed')));
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string' || !Number.isInteger(address.port) || address.port < 1) {
        probe.close(() => rejectPort(new ManagedRunError('loopback_port_unavailable')));
        return;
      }
      probe.close((error) => error
        ? rejectPort(new ManagedRunError('loopback_port_probe_failed'))
        : resolvePort(address.port));
    });
  });
}

function makeServerArguments(port, tokenPath) {
  return [
    'app-server',
    '--listen', `ws://127.0.0.1:${port}`,
    '--ws-auth', 'capability-token',
    '--ws-token-file', tokenPath,
  ];
}

function classifyServerStderr(stderrText) {
  if (/unsupported|not supported/i.test(stderrText)) return 'unsupported_transport';
  if (/eaddrinuse|address.{0,24}already in use|10048/i.test(stderrText)) return 'address_in_use';
  if (/eacces|eperm|permission denied|access is denied|os error 5/i.test(stderrText)) return 'permission_error';
  if (/invalid.{0,24}(?:token|auth)|unauthorized|authentication/i.test(stderrText)) return 'auth_error';
  if (/invalid.{0,24}(?:address|port)|(?:address|port).{0,24}invalid|10049/i.test(stderrText)) return 'invalid_listen_address';
  if (/bind.{0,24}(?:failed|error)|(?:failed|error).{0,24}bind|os error 87/i.test(stderrText)) return 'listen_bind_error';
  if (/config|toml|parse/i.test(stderrText)) return 'config_error';
  if (/listen|socket|port|websocket/i.test(stderrText)
    && /\b(?:error|failed|failure|unable|cannot|could not|denied|refused|invalid)\b/i.test(stderrText)) {
    return 'listen_error';
  }
  return 'unknown';
}

function safeProcessCode(value) {
  return typeof value === 'string' && /^[A-Z0-9_]{1,32}$/.test(value) ? value : 'unknown';
}

function startServerProcess(executable, cwd, home, port, tokenPath, dependencies = {}) {
  const spawnImpl = dependencies.spawn || spawn;
  let child;
  try {
    child = spawnImpl(executable, makeServerArguments(port, tokenPath), {
      cwd,
      env: makeChildEnvironment(process.env, home),
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
  } catch (error) {
    throw new ManagedRunError(safeProcessCode(error && error.code) === 'unknown'
      ? 'server_spawn_failed'
      : 'server_spawn_' + safeProcessCode(error.code).toLowerCase());
  }
  const state = {
    closed: false,
    exitCode: null,
    signal: null,
    spawnErrorCode: null,
    stderrBytes: 0,
    stderrText: '',
  };
  const exited = new Promise((resolveExit) => {
    child.once('error', (error) => {
      state.spawnErrorCode = safeProcessCode(error && error.code);
    });
    child.once('close', (code, signal) => {
      state.closed = true;
      state.exitCode = Number.isInteger(code) ? code : null;
      state.signal = typeof signal === 'string' && /^[A-Z0-9_]{1,32}$/.test(signal) ? signal : null;
      resolveExit();
    });
  });
  if (child.stderr && typeof child.stderr.on === 'function') {
    child.stderr.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      state.stderrBytes += buffer.length;
      if (Buffer.byteLength(state.stderrText) < MAX_CAPTURED_STDERR_BYTES) {
        const remaining = MAX_CAPTURED_STDERR_BYTES - Buffer.byteLength(state.stderrText);
        state.stderrText += buffer.subarray(0, remaining).toString('utf8');
      }
    });
  }
  return { child, state, exited };
}

function errorKind(error, fallback = 'unexpected_error') {
  const value = error && (error.kind || error.code);
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function delay(milliseconds) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}

function createClientObserver() {
  const methodCounts = new Map();
  const threadIds = new Set();
  const turnIds = new Set();
  const turnStatuses = new Map();
  const requestKinds = { approval: 0, other: 0 };
  const serverRequestsById = new Map();
  const resolvedRequestIds = new Set();
  const waitingFlags = {
    approval: { seen: false, active: false, cleared: false },
    user_input: { seen: false, active: false, cleared: false },
  };
  let notificationCount = 0;
  let serverRequestCount = 0;
  let resolutionCount = 0;
  let matchedResolutionCount = 0;
  let unmatchedResolutionCount = 0;
  let resolvedApprovalCount = 0;
  let targetThreadId = null;

  function onNotification(method, metadata) {
    notificationCount += 1;
    const safeMethod = NOTIFICATION_METHODS.has(method) ? method : 'other';
    methodCounts.set(safeMethod, (methodCounts.get(safeMethod) || 0) + 1);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return;
    if (isUuid(metadata.threadId)) threadIds.add(metadata.threadId);
    if (isUuid(metadata.turnId)) {
      if (turnIds.has(metadata.turnId) || turnIds.size < MAX_TRACKED_TURN_IDS) turnIds.add(metadata.turnId);
      if (TURN_STATUS_METHODS.has(safeMethod)
        && ['inProgress', 'completed', 'interrupted', 'failed'].includes(metadata.status)
        && (turnStatuses.has(metadata.turnId) || turnStatuses.size < MAX_TRACKED_TURN_IDS)) {
        turnStatuses.set(metadata.turnId, metadata.status);
      }
    }
    if (safeMethod === 'serverRequest/resolved') {
      resolutionCount += 1;
      const requestKey = requestIdKey(metadata.requestId);
      if (requestKey && serverRequestsById.has(requestKey)) {
        if (!resolvedRequestIds.has(requestKey)) matchedResolutionCount += 1;
        resolvedRequestIds.add(requestKey);
        if (serverRequestsById.get(requestKey)) resolvedApprovalCount += 1;
      } else {
        unmatchedResolutionCount += 1;
      }
    }
    if (safeMethod === 'thread/status/changed' && metadata.threadId === targetThreadId
      && metadata.threadStatus && typeof metadata.threadStatus === 'object') {
      const flags = metadata.threadStatus.type === 'active' ? metadata.threadStatus.activeFlags : [];
      updateWaitingFlag(waitingFlags.approval, Array.isArray(flags) && flags.includes('waitingOnApproval'));
      updateWaitingFlag(waitingFlags.user_input, Array.isArray(flags) && flags.includes('waitingOnUserInput'));
    }
  }

  function onServerRequest(request) {
    serverRequestCount += 1;
    const method = request && request.method;
    const approval = typeof method === 'string' && /approval|permission/i.test(method);
    if (approval) requestKinds.approval += 1;
    else requestKinds.other += 1;
    const requestKey = requestIdKey(request && request.id);
    if (requestKey) serverRequestsById.set(requestKey, approval);
  }

  function requestSummary() {
    return {
      count: serverRequestCount,
      approval_count: requestKinds.approval,
      other_count: requestKinds.other,
      resolved_count: resolutionCount,
      matched_resolution_count: matchedResolutionCount,
      unmatched_resolution_count: unmatchedResolutionCount,
      resolved_approval_count: resolvedApprovalCount,
      waiting_on_approval_seen: waitingFlags.approval.seen,
      waiting_on_approval_active: waitingFlags.approval.active,
      waiting_on_approval_cleared: waitingFlags.approval.cleared,
      waiting_on_user_input_seen: waitingFlags.user_input.seen,
      waiting_on_user_input_active: waitingFlags.user_input.active,
      waiting_on_user_input_cleared: waitingFlags.user_input.cleared,
    };
  }

  return {
    onNotification,
    onServerRequest,
    setTargetThreadId(id) { targetThreadId = isUuid(id) ? id : null; },
    hasThread(threadId) { return threadIds.has(threadId); },
    hasTurn(turnId) { return turnIds.has(turnId); },
    turnStatus(turnId) { return turnStatuses.get(turnId) || null; },
    hasTerminalTurnStatus(turnId) { return TURN_TERMINAL_STATUSES.has(turnStatuses.get(turnId)); },
    turnSnapshots() {
      return [...turnIds].map((id) => ({ id, status: turnStatuses.get(id) || 'unknown' }));
    },
    hasApprovalRequest() { return requestKinds.approval > 0; },
    serverRequestSnapshot() { return new Map(serverRequestsById); },
    resolvedRequestIdSnapshot() { return new Set(resolvedRequestIds); },
    requestSummary,
    get serverRequestCount() { return serverRequestCount; },
    summarize() {
      const requests = requestSummary();
      return {
        count: notificationCount,
        methods: Object.fromEntries([...methodCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
        server_requests: serverRequestCount,
        server_request_approval_count: requestKinds.approval,
        server_request_other_count: requestKinds.other,
        server_request_resolution_count: requests.resolved_count,
        server_request_resolution_matched_count: requests.matched_resolution_count,
        server_request_resolution_unmatched_count: requests.unmatched_resolution_count,
        server_request_resolved_approval_count: requests.resolved_approval_count,
        waiting_on_approval_seen: requests.waiting_on_approval_seen,
        waiting_on_approval_active: requests.waiting_on_approval_active,
        waiting_on_approval_cleared: requests.waiting_on_approval_cleared,
        waiting_on_user_input_seen: requests.waiting_on_user_input_seen,
        waiting_on_user_input_active: requests.waiting_on_user_input_active,
        waiting_on_user_input_cleared: requests.waiting_on_user_input_cleared,
      };
    },
  };
}

function requestIdKey(value) {
  if (Number.isSafeInteger(value)) return `number:${value}`;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? `string:${value}`
    : null;
}

function updateWaitingFlag(state, active) {
  if (active) {
    state.seen = true;
    state.active = true;
  } else if (state.active) {
    state.active = false;
    state.cleared = true;
  }
}

function summarizeServerRequestCorrelation(observers) {
  const requests = new Map();
  const resolutions = new Set();
  for (const observer of observers) {
    for (const [requestId, approval] of observer.serverRequestSnapshot()) {
      requests.set(requestId, Boolean(approval) || requests.get(requestId) === true);
    }
    for (const requestId of observer.resolvedRequestIdSnapshot()) resolutions.add(requestId);
  }
  const approvalRequestIds = [...requests.entries()]
    .filter(([, approval]) => approval)
    .map(([requestId]) => requestId);
  const resolvedApprovalRequestCount = approvalRequestIds.filter((requestId) => resolutions.has(requestId)).length;
  const resolvedKnownRequestCount = [...resolutions].filter((requestId) => requests.has(requestId)).length;
  return {
    unique_request_id_count: requests.size,
    unique_approval_request_id_count: approvalRequestIds.length,
    unique_resolved_request_id_count: resolutions.size,
    resolved_approval_request_id_count: resolvedApprovalRequestCount,
    unresolved_approval_request_id_count: Math.max(0, approvalRequestIds.length - resolvedApprovalRequestCount),
    unmatched_resolved_request_id_count: Math.max(0, resolutions.size - resolvedKnownRequestCount),
    approval_resolution_correlation_complete: approvalRequestIds.length > 0
      && approvalRequestIds.length === resolvedApprovalRequestCount,
  };
}

function isUuid(value) {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

function normalizePathForMatch(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
  }
  return value;
}

function sameJsonValue(left, right) {
  return JSON.stringify(stableValue(left)) === JSON.stringify(stableValue(right));
}

function compareEffectiveSettings(started, resumed, expectedCwd, expectedApprovalPolicy = 'on-request') {
  const startedThread = started && started.thread;
  const resumedThread = resumed && resumed.thread;
  const cwd = normalizePathForMatch(expectedCwd);
  const cwdMatch = Boolean(cwd)
    && normalizePathForMatch(started && started.cwd) === cwd
    && normalizePathForMatch(resumed && resumed.cwd) === cwd;
  const startedSandbox = normalizeReadOnlySandboxPolicy(started && started.sandbox);
  const resumedSandbox = normalizeReadOnlySandboxPolicy(resumed && resumed.sandbox);
  const fields = {
    approval_policy: started?.approvalPolicy === expectedApprovalPolicy
      && resumed?.approvalPolicy === expectedApprovalPolicy,
    cwd: cwdMatch,
    model: started?.model === FIXTURE_MODEL && started.model === resumed?.model,
    model_provider: started?.modelProvider === 'poc157_fixture' && started.modelProvider === resumed?.modelProvider,
    sandbox: Boolean(startedSandbox && resumedSandbox) && sameJsonValue(startedSandbox, resumedSandbox),
    ephemeral: startedThread?.ephemeral === false && resumedThread?.ephemeral === false,
  };
  return { ...fields, all: Object.values(fields).every(Boolean) };
}

function normalizeReadOnlySandboxPolicy(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const keys = Object.keys(value).sort();
  if (keys.some((key) => !['networkAccess', 'type'].includes(key))
    || value.type !== 'readOnly'
    || (value.networkAccess !== undefined && value.networkAccess !== false)) return null;
  return { type: 'readOnly', networkAccess: false };
}

function createResultFileName(now = new Date(), runId = randomUUID()) {
  const timestamp = now.toISOString().replace(/[-:.]/g, '').replace(/Z$/, 'Z');
  if (!/^[0-9a-f-]{36}$/i.test(runId)) throw new ManagedRunError('invalid_run_id');
  return `managed-${timestamp}-${runId}.json`;
}

async function connectClient(connect, options, server, deadline) {
  let lastFailure = 'connection_error';
  while (Date.now() < deadline) {
    if (server.state.closed) throw new ManagedRunError('server_exited_before_connect');
    try {
      return await connect({
        host: '127.0.0.1',
        port: options.port,
        capabilityToken: options.token,
        timeoutMs: Math.min(options.timeoutMs, CONNECT_ATTEMPT_TIMEOUT_MS),
        allowedMethods: JSON_RPC_METHODS,
        onNotification: options.observer.onNotification,
        onServerRequest: options.observer.onServerRequest,
      });
    } catch (error) {
      lastFailure = errorKind(error, 'connection_error');
      if (server.state.closed) break;
      await delay(100);
    }
  }
  throw new ManagedRunError(server.state.closed ? 'server_exited_before_connect' : `server_connect_${lastFailure}`);
}

async function initializeClient(connection, privateHome) {
  const client = connection && connection.client;
  if (!client || typeof client.request !== 'function' || typeof client.notify !== 'function') {
    throw new ManagedRunError('invalid_client_connection');
  }
  const response = await client.request('initialize', {
    clientInfo: {
      name: 'agent-cockpit-poc158-managed',
      title: 'Agent Cockpit shared app-server PoC',
      version: '0.1.0',
    },
    capabilities: { experimentalApi: false },
  });
  const metadata = validateInitializeResponse(response);
  await client.notify('initialized', {});
  const expectedHome = normalizePathForMatch(privateHome);
  return {
    client,
    version: metadata.version,
    privateHomeMatch: Boolean(expectedHome) && normalizePathForMatch(response.codexHome) === expectedHome,
  };
}

async function readLoadedSnapshot(client, threadId) {
  const seenCursors = new Set();
  let cursor = null;
  let count = 0;
  let containsThread = false;
  let truncated = false;
  for (let page = 0; page < MAX_LOADED_PAGES; page += 1) {
    const params = { limit: 100 };
    if (cursor) params.cursor = cursor;
    const result = await client.request('thread/loaded/list', params);
    if (!result || !Array.isArray(result.data) || result.data.some((id) => typeof id !== 'string')) {
      throw new ManagedRunError('invalid_loaded_list');
    }
    count += result.data.length;
    if (result.data.includes(threadId)) containsThread = true;
    if (typeof result.nextCursor !== 'string' || result.nextCursor.length === 0) return { count, containsThread, truncated };
    if (seenCursors.has(result.nextCursor)) {
      truncated = true;
      return { count, containsThread, truncated };
    }
    seenCursors.add(result.nextCursor);
    cursor = result.nextCursor;
  }
  return { count, containsThread, truncated: true };
}

async function waitForTerminalTurnStatuses(observers, turnId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (observers.every((observer) => observer.hasTerminalTurnStatus(turnId))) return true;
    await delay(50);
  }
  return observers.every((observer) => observer.hasTerminalTurnStatus(turnId));
}

async function waitForApprovalRequest(observer, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (observer.hasApprovalRequest()) return true;
    await delay(50);
  }
  return observer.hasApprovalRequest();
}

async function readThreadMetadataSnapshot(client, threadId) {
  const result = await client.request('thread/read', { threadId, includeTurns: false });
  const thread = result && result.thread;
  const status = thread && thread.status && THREAD_STATUS_TYPES.has(thread.status.type)
    ? thread.status.type
    : 'unknown';
  return {
    thread_matches: Boolean(thread && thread.id === threadId),
    status,
    turns_returned: Boolean(thread && Array.isArray(thread.turns) && thread.turns.length > 0),
  };
}

async function inspectAdditionalLoadedThreads(client, targetThreadId) {
  const loadedIds = new Set();
  const visitedCursors = new Set();
  let cursor = null;
  let targetLoaded = false;
  let truncated = false;
  for (let page = 0; page < MAX_LOADED_PAGES; page += 1) {
    const params = { limit: 100 };
    if (cursor) params.cursor = cursor;
    const response = await client.request('thread/loaded/list', params);
    if (!response || !Array.isArray(response.data) || response.data.some((id) => typeof id !== 'string')) {
      throw new ManagedRunError('invalid_loaded_list');
    }
    for (const id of response.data) {
      if (id === targetThreadId) targetLoaded = true;
      else if (isUuid(id)) loadedIds.add(id);
    }
    if (typeof response.nextCursor !== 'string' || response.nextCursor.length === 0) break;
    if (visitedCursors.has(response.nextCursor)) {
      truncated = true;
      break;
    }
    visitedCursors.add(response.nextCursor);
    cursor = response.nextCursor;
    if (page === MAX_LOADED_PAGES - 1) truncated = true;
  }

  const extraIds = [...loadedIds];
  const inspectIds = extraIds.slice(0, MAX_ADDITIONAL_THREAD_READS);
  if (inspectIds.length < extraIds.length) truncated = true;
  const sourceKindCounts = Object.fromEntries([...THREAD_SOURCES].map((source) => [source, 0]));
  const statusCounts = Object.fromEntries([...THREAD_STATUS_TYPES, 'unknown'].map((status) => [status, 0]));
  let readMatches = 0;
  let parentMatches = 0;
  let turnsOmitted = 0;
  let readFailures = 0;
  for (const extraId of inspectIds) {
    try {
      const response = await client.request('thread/read', { threadId: extraId, includeTurns: false });
      const thread = response && response.thread;
      if (!thread || thread.id !== extraId) {
        readFailures += 1;
        continue;
      }
      readMatches += 1;
      const source = thread.source;
      const sourceKind = typeof source === 'string' && THREAD_SOURCES.has(source)
        ? source
        : source && typeof source === 'object' && source.subAgent ? 'subAgent'
          : source && typeof source === 'object' && source.custom ? 'custom'
            : 'unknown';
      sourceKindCounts[sourceKind] += 1;
      const status = thread.status && THREAD_STATUS_TYPES.has(thread.status.type)
        ? thread.status.type
        : 'unknown';
      statusCounts[status] += 1;
      const subAgent = source && typeof source === 'object' && source.subAgent && typeof source.subAgent === 'object'
        ? source.subAgent
        : {};
      const parentThreadId = subAgent.parentThreadId || thread.parentThreadId;
      if (parentThreadId === targetThreadId) parentMatches += 1;
      if (!Array.isArray(thread.turns) || thread.turns.length === 0) turnsOmitted += 1;
    } catch {
      readFailures += 1;
    }
  }
  const allInspected = extraIds.length > 0 && inspectIds.length === extraIds.length && readMatches === extraIds.length;
  return {
    available: true,
    target_loaded: targetLoaded,
    extra_count: extraIds.length,
    inspected_count: inspectIds.length,
    read_match_count: readMatches,
    read_failure_count: readFailures,
    source_kind_counts: sourceKindCounts,
    status_counts: statusCounts,
    all_parent_matches_target: allInspected && parentMatches === extraIds.length,
    all_turns_omitted: allInspected && turnsOmitted === extraIds.length,
    truncated,
  };
}

async function readAdditionalLoadedSummary(client, targetThreadId) {
  try {
    return await inspectAdditionalLoadedThreads(client, targetThreadId);
  } catch {
    return { available: false };
  }
}

function notificationSummaryDelta(before, after) {
  const methods = {};
  const methodNames = new Set([...Object.keys(before.methods), ...Object.keys(after.methods)]);
  for (const method of [...methodNames].sort()) {
    const difference = (after.methods[method] || 0) - (before.methods[method] || 0);
    if (difference > 0) methods[method] = difference;
  }
  return { count: Math.max(0, after.count - before.count), methods };
}

function summarizeAdditionalTurns(observer, baselineTurnIds) {
  return observer.turnSnapshots().filter(({ id }) => !baselineTurnIds.has(id));
}

function summarizeSharedTurnsDuringServe(observerA, observerB, baselineA, baselineB) {
  const turnsA = new Map(summarizeAdditionalTurns(observerA, baselineA).map((turn) => [turn.id, turn.status]));
  const turnsB = new Map(summarizeAdditionalTurns(observerB, baselineB).map((turn) => [turn.id, turn.status]));
  const shared = [...turnsA.entries()]
    .filter(([id]) => turnsB.has(id))
    .map(([id, statusA]) => ({ id, status_a: statusA, status_b: turnsB.get(id) }))
    .slice(0, MAX_TRACKED_TURN_IDS);
  return {
    client_a_count: turnsA.size,
    client_b_count: turnsB.size,
    shared_count: shared.length,
    shared_completed_count: shared.filter((turn) => turn.status_a === 'completed' && turn.status_b === 'completed').length,
    shared,
  };
}

function summarizeTurn(turn) {
  const status = turn && typeof turn.status === 'string'
    && ['completed', 'interrupted', 'failed', 'inProgress'].includes(turn.status)
    ? turn.status
    : 'unknown';
  return {
    id: isUuid(turn && turn.id) ? turn.id : null,
    status,
  };
}

function buildCoreSuccess(result) {
  const warmup = result.turn.warmup;
  const observed = result.turn.observed;
  return Boolean(
    result.native_version === REQUIRED_CODEX_VERSION
      && result.clients.a.initialized
      && result.clients.b.initialized
      && result.clients.a.private_home_match
      && result.clients.b.private_home_match
      && result.clients.a.thread_started
      && result.clients.b.thread_resumed
      && result.clients.b.same_thread_id
      && result.clients.b.effective_settings_match.all
      && result.loaded.a.contains_thread
      && result.loaded.b.contains_thread
      && result.loaded.counts_match
      && warmup.started
      && warmup.status === 'completed'
      && warmup.client_a_saw_turn_id
      && observed.started
      && observed.status_a === 'completed'
      && observed.status_b === 'completed'
      && observed.client_a_saw_turn_id
      && observed.client_b_saw_turn_id
      && result.fixture.baseline_request_count === result.fixture.expected_request_count
      && result.server_requests.count === 0
  );
}

function buildOperationalSuccess(result) {
  return Boolean(
    buildCoreSuccess(result)
      && result.reconnect.initialized
      && result.reconnect.contains_thread
      && (result.serve.enabled
        ? result.fixture.request_count >= result.fixture.baseline_request_count + 1
        : result.fixture.request_count === result.fixture.baseline_request_count)
      && (!result.serve.enabled || (result.serve.stop_signal
        && result.serve.cli_turns.shared_count > 0
        && result.serve.cli_turns.shared_completed_count > 0
        && result.serve.loaded_after_cli.a.contains_thread
        && result.serve.loaded_after_cli.b.contains_thread
        && result.serve.loaded_after_cli.counts_match
        && result.serve.after_cli_settings_match.all))
  );
}

function buildSuccess(result) {
  return Boolean(
    buildOperationalSuccess(result)
      && result.cleanup.server_stopped
      && result.cleanup.fixture_closed
      && result.cleanup.fixture_config_removed
      && result.cleanup.appended_config_preserved
      && result.cleanup.source_config_hash_unchanged
      && result.cleanup.token_file_removed,
  );
}

function buildPendingSuccess(result) {
  const pending = result.pending;
  return Boolean(
    pending.enabled
      && result.native_version === REQUIRED_CODEX_VERSION
      && result.clients.a.initialized
      && result.clients.b.initialized
      && result.clients.a.private_home_match
      && result.clients.b.private_home_match
      && result.clients.a.thread_started
      && result.clients.b.thread_resumed
      && result.clients.b.same_thread_id
      && result.clients.b.effective_settings_match.all
      && pending.persisted_read_a.thread_matches
      && !pending.persisted_read_a.turns_returned
      && pending.turn.started
      && pending.turn.approval_request_seen_a
      && pending.stop_signal
      && pending.turn.same_turn_id
      && pending.turn.terminal_observed_by_both
      && TURN_TERMINAL_STATUSES.has(pending.turn.status_a)
      && TURN_TERMINAL_STATUSES.has(pending.turn.status_b)
      && pending.turn.status_a === pending.turn.status_b
      && pending.request_after_cli.correlation?.approval_resolution_correlation_complete === true
      && pending.waiting_on_approval_transition_observed
      && result.reconnect.initialized
      && result.reconnect.contains_thread
      && result.cleanup.server_stopped
      && result.cleanup.fixture_closed
      && result.cleanup.fixture_config_removed
      && result.cleanup.appended_config_preserved
      && result.cleanup.source_config_hash_unchanged
      && result.cleanup.token_file_removed,
  );
}

function writeResultFile(output, result, dependencies = {}) {
  const fileName = createResultFileName((dependencies.now || (() => new Date()))(), result.run_id);
  const resultPath = path.join(output, fileName);
  assertNoSymlinkComponents(output, resultPath);
  fs.writeFileSync(resultPath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return path.relative(REPOSITORY_ROOT, resultPath).split(path.sep).join('/');
}

function writeServeReadyFile(output, ready) {
  const fileName = `managed-serve-${ready.run_id}.json`;
  if (!/^[0-9a-f-]{36}$/i.test(ready.run_id)) throw new ManagedRunError('invalid_run_id');
  const readyPath = path.join(output, fileName);
  assertNoSymlinkComponents(output, readyPath);
  fs.writeFileSync(readyPath, `${JSON.stringify(ready, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
  return path.relative(REPOSITORY_ROOT, readyPath).split(path.sep).join('/');
}

function waitForStopSignal() {
  return new Promise((resolveSignal) => {
    const finish = (signal) => {
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onTerminate);
      resolveSignal(signal);
    };
    const onInterrupt = () => finish('SIGINT');
    const onTerminate = () => finish('SIGTERM');
    process.once('SIGINT', onInterrupt);
    process.once('SIGTERM', onTerminate);
  });
}

async function closeOwnedServer(server) {
  if (!server) return true;
  if (server.state.closed) return true;
  try {
    server.child.kill();
  } catch {
    return false;
  }
  const stopped = await Promise.race([
    server.exited.then(() => true),
    delay(SERVER_STOP_TIMEOUT_MS).then(() => false),
  ]);
  return stopped;
}

async function closeFixture(fixture) {
  if (!fixture || typeof fixture.close !== 'function') return true;
  const close = () => Promise.resolve().then(() => fixture.close());
  let closed = await Promise.race([
    close().then(() => true, () => false),
    delay(FIXTURE_CLOSE_TIMEOUT_MS).then(() => false),
  ]);
  if (!closed && fixture.server && typeof fixture.server.closeAllConnections === 'function') {
    fixture.server.closeAllConnections();
    closed = await Promise.race([
      close().then(() => true, () => false),
      delay(FIXTURE_CLOSE_TIMEOUT_MS).then(() => false),
    ]);
  }
  return closed;
}

function cleanupFixtureConfigPreservingSuffix(configPath, configSnapshot) {
  const failed = {
    config_restored: false,
    fixture_config_removed: false,
    appended_config_preserved: false,
  };
  let restoredExactly;
  try {
    restoredExactly = clearFixtureConfig(configPath, configSnapshot);
  } catch {
    return failed;
  }
  if (restoredExactly) {
    return {
      config_restored: true,
      fixture_config_removed: true,
      appended_config_preserved: true,
    };
  }

  let temporaryPath = null;
  try {
    const stat = fs.lstatSync(configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return failed;
    const current = fs.readFileSync(configPath, 'utf8');
    if (!configSnapshot || typeof configSnapshot.appliedConfig !== 'string'
      || typeof configSnapshot.originalConfig !== 'string'
      || !current.startsWith(configSnapshot.appliedConfig)) return failed;
    const suffix = current.slice(configSnapshot.appliedConfig.length);
    const next = configSnapshot.originalConfig + suffix;
    temporaryPath = `${configPath}.poc158-cleanup-${randomUUID()}.tmp`;
    assertNoSymlinkComponents(path.dirname(configPath), temporaryPath);
    fs.writeFileSync(temporaryPath, next, {
      encoding: 'utf8',
      flag: 'wx',
      mode: stat.mode & 0o777,
    });
    const currentStat = fs.lstatSync(configPath);
    if (!currentStat.isFile() || currentStat.isSymbolicLink()
      || fs.readFileSync(configPath, 'utf8') !== current) return failed;
    fs.renameSync(temporaryPath, configPath);
    temporaryPath = null;
    const actual = fs.readFileSync(configPath, 'utf8');
    if (actual !== next) return failed;
    return {
      config_restored: actual === configSnapshot.originalConfig,
      fixture_config_removed: actual === next,
      appended_config_preserved: suffix.length === 0 || actual.endsWith(suffix),
    };
  } catch {
    return failed;
  } finally {
    if (temporaryPath) {
      try { fs.unlinkSync(temporaryPath); } catch {}
    }
  }
}

async function runPendingTurn(options) {
  const {
    result, started, aInitialized, aStarted, threadId, port, tokenFile, timeoutMs, server,
    connect, connections, observers, dependencies, output, runId, stage,
  } = options;
  const pending = result.pending;
  const turnResponse = await aInitialized.client.request('turn/start', {
    threadId,
    input: [{ type: 'text', text: 'Run the configured harmless command once, then finish.' }],
  });
  const turn = summarizeTurn(turnResponse && turnResponse.turn);
  pending.turn.started = Boolean(turn.id);
  pending.turn.id = turn.id;
  pending.turn.start_status = turn.status;
  if (!turn.id) throw new ManagedRunError('invalid_pending_turn_response');

  stage('pending_approval_wait');
  pending.turn.approval_request_seen_a = await waitForApprovalRequest(observers.a, timeoutMs);
  pending.request_before_cli.a = observers.a.requestSummary();
  const persistedRead = await readThreadMetadataSnapshot(aInitialized.client, threadId);
  pending.persisted_read_a = persistedRead;
  if (!persistedRead.thread_matches || persistedRead.turns_returned) {
    throw new ManagedRunError('pending_thread_read_mismatch');
  }

  stage('connect_b');
  const bConnection = await connectClient(connect, {
    port,
    token: tokenFile.token,
    timeoutMs,
    observer: observers.b,
  }, server, Date.now() + timeoutMs);
  connections.push(bConnection);
  stage('initialize_b');
  const bInitialized = await initializeClient(bConnection, started.isolatedHome);
  result.clients.b.initialized = true;
  result.clients.b.private_home_match = bInitialized.privateHomeMatch;
  if (bInitialized.version !== result.native_version) throw new ManagedRunError('client_server_version_mismatch');
  observers.b.setTargetThreadId(threadId);
  stage('thread_resume');
  const resumed = await bInitialized.client.request('thread/resume', { threadId, excludeTurns: true });
  const resumedThreadId = resumed && resumed.thread && resumed.thread.id;
  if (!isUuid(resumedThreadId)) throw new ManagedRunError('invalid_resumed_thread');
  result.clients.b.thread_resumed = true;
  result.clients.b.thread_id = resumedThreadId;
  result.clients.b.same_thread_id = resumedThreadId === threadId;
  result.clients.b.effective_settings_match = compareEffectiveSettings(
    aStarted, resumed, started.layout.repo, pending.approval_policy,
  );

  stage('pending_loaded_list');
  const loadedA = await readLoadedSnapshot(aInitialized.client, threadId);
  const loadedB = await readLoadedSnapshot(bInitialized.client, threadId);
  result.loaded.a = { count: loadedA.count, contains_thread: loadedA.containsThread, truncated: loadedA.truncated };
  result.loaded.b = { count: loadedB.count, contains_thread: loadedB.containsThread, truncated: loadedB.truncated };
  result.loaded.counts_match = loadedA.count === loadedB.count;
  pending.request_before_cli.b = observers.b.requestSummary();
  pending.request_before_cli.correlation = summarizeServerRequestCorrelation([observers.a, observers.b]);
  const baselineA = observers.a.summarize();
  const baselineB = observers.b.summarize();
  result.fixture.baseline_request_count = started.fixture.requests.length;
  result.fixture.unsupported = Boolean(started.fixture.unsupported);

  const ready = {
    schema: 'agent-cockpit-poc158-pending-turn-serve-v1',
    mode: 'pending_turn',
    run_id: runId,
    host: '127.0.0.1',
    port,
    codex_home: path.resolve(started.isolatedHome),
    cwd: path.resolve(started.layout.repo),
    thread_id: threadId,
    turn_id: turn.id,
    token_file: path.resolve(tokenFile.tokenPath),
  };
  pending.ready_file = writeServeReadyFile(output, ready);
  if (typeof dependencies.onServeReady === 'function') dependencies.onServeReady(pending.ready_file);
  stage('pending_cli_wait');
  const waitForStop = dependencies.waitForStopSignal || waitForStopSignal;
  pending.stop_signal = await waitForStop();

  pending.turn.terminal_observed_by_both = await waitForTerminalTurnStatuses(
    [observers.a, observers.b], turn.id, timeoutMs,
  );
  pending.turn.status_a = observers.a.turnStatus(turn.id) || 'unknown';
  pending.turn.status_b = observers.b.turnStatus(turn.id) || 'unknown';
  pending.turn.client_a_saw_turn_id = observers.a.hasTurn(turn.id);
  pending.turn.client_b_saw_turn_id = observers.b.hasTurn(turn.id);
  pending.turn.same_turn_id = pending.turn.client_a_saw_turn_id && pending.turn.client_b_saw_turn_id;
  pending.notification_delta.a = notificationSummaryDelta(baselineA, observers.a.summarize());
  pending.notification_delta.b = notificationSummaryDelta(baselineB, observers.b.summarize());
  pending.request_after_cli.a = observers.a.requestSummary();
  pending.request_after_cli.b = observers.b.requestSummary();
  pending.request_after_cli.correlation = summarizeServerRequestCorrelation([observers.a, observers.b]);
  pending.waiting_on_approval_transition_observed = [
    pending.request_after_cli.a,
    pending.request_after_cli.b,
  ].some((summary) => summary.waiting_on_approval_seen
    && summary.waiting_on_approval_cleared
    && !summary.waiting_on_approval_active);
  pending.fixture_requests_after_cli = Math.max(0, started.fixture.requests.length - result.fixture.baseline_request_count);

  stage('pending_loaded_after_cli');
  const afterCliA = await readLoadedSnapshot(aInitialized.client, threadId);
  const afterCliB = await readLoadedSnapshot(bInitialized.client, threadId);
  pending.loaded_after_cli.a = {
    count: afterCliA.count,
    contains_thread: afterCliA.containsThread,
    truncated: afterCliA.truncated,
  };
  pending.loaded_after_cli.b = {
    count: afterCliB.count,
    contains_thread: afterCliB.containsThread,
    truncated: afterCliB.truncated,
  };
  pending.loaded_after_cli.counts_match = afterCliA.count === afterCliB.count;
  pending.additional_loaded_threads.a = await readAdditionalLoadedSummary(aInitialized.client, threadId);
  pending.additional_loaded_threads.b = await readAdditionalLoadedSummary(bInitialized.client, threadId);
  if (!pending.turn.terminal_observed_by_both) throw new ManagedRunError('pending_turn_terminal_timeout');
}

async function runManagedServer(options, dependencies = {}) {
  const codexPath = validateExecutable(options && options.codexPath);
  const output = resolveOutputDirectory(options.outputDirectory || DEFAULT_OUTPUT);
  const timeoutMs = options.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : options.timeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new ManagedRunError('invalid_timeout');
  }
  if (options.serve === true && options.servePendingTurn === true) {
    throw new ManagedRunError('invalid_arguments');
  }
  const pendingMode = options.servePendingTurn === true;
  const approvalPolicy = pendingMode ? 'untrusted' : 'on-request';
  const prepare = dependencies.prepareWorkspace || prepareWorkspace;
  const startFixtureImpl = dependencies.startFixture || startFixture;
  const spawnImpl = dependencies.spawn || spawn;
  const connect = dependencies.connect || connectViaTcp;
  const getPort = dependencies.chooseLoopbackPort || chooseLoopbackPort;
  const writeResult = dependencies.writeResult || writeResultFile;
  const runId = randomUUID();
  const result = {
    schema: pendingMode ? 'agent-cockpit-poc158-pending-turn-v1' : 'agent-cockpit-poc158-managed-v2',
    run_id: runId,
    mode: pendingMode ? 'pending_turn' : options.serve === true ? 'serve' : 'one_shot',
    native_version: null,
    transport: { type: 'loopback_websocket_capability_token', host: '127.0.0.1', port: null },
    clients: {
      a: { initialized: false, private_home_match: false, thread_started: false, thread_id: null },
      b: { initialized: false, private_home_match: false, thread_resumed: false, same_thread_id: false, thread_id: null,
        effective_settings_match: { approval_policy: false, cwd: false, model: false, model_provider: false, sandbox: false, ephemeral: false, all: false } },
    },
    loaded: {
      a: { count: 0, contains_thread: false, truncated: false },
      b: { count: 0, contains_thread: false, truncated: false },
      counts_match: false,
    },
    turn: {
      warmup: {
        started: false,
        id: null,
        start_status: 'unknown',
        status: 'unknown',
        terminal_observed: false,
        client_a_saw_turn_id: false,
      },
      observed: {
        started: false,
        id: null,
        start_status: 'unknown',
        status_a: 'unknown',
        status_b: 'unknown',
        terminal_observed_by_both: false,
        client_a_saw_turn_id: false,
        client_b_saw_turn_id: false,
      },
    },
    notifications: { a: null, b: null },
    server_requests: { count: 0, approval_count: 0, other_count: 0, answered_by_runner: false },
    fixture: { request_count: 0, baseline_request_count: 0, expected_request_count: 3, unsupported: false },
    serve: {
      enabled: options.serve === true,
      ready_file: null,
      stop_signal: null,
      additional_fixture_requests: 0,
      notification_delta: { a: null, b: null },
      cli_turns: { client_a_count: 0, client_b_count: 0, shared_count: 0, shared_completed_count: 0, shared: [] },
      loaded_after_cli: {
        a: { count: 0, contains_thread: false, truncated: false },
        b: { count: 0, contains_thread: false, truncated: false },
        counts_match: false,
      },
      additional_loaded_threads: { a: null, b: null },
      after_cli_settings_match: { approval_policy: false, cwd: false, model: false, model_provider: false, sandbox: false, ephemeral: false, all: false },
    },
    pending: {
      enabled: pendingMode,
      approval_policy: approvalPolicy,
      turn: {
        started: false,
        id: null,
        start_status: 'unknown',
        approval_request_seen_a: false,
        status_a: 'unknown',
        status_b: 'unknown',
        client_a_saw_turn_id: false,
        client_b_saw_turn_id: false,
        same_turn_id: false,
        terminal_observed_by_both: false,
      },
      persisted_read_a: { thread_matches: false, status: 'unknown', turns_returned: false },
      request_before_cli: { a: null, b: null, correlation: null },
      request_after_cli: { a: null, b: null, correlation: null },
      waiting_on_approval_transition_observed: false,
      ready_file: null,
      stop_signal: null,
      notification_delta: { a: null, b: null },
      loaded_after_cli: {
        a: { count: 0, contains_thread: false, truncated: false },
        b: { count: 0, contains_thread: false, truncated: false },
        counts_match: false,
      },
      additional_loaded_threads: { a: null, b: null },
      fixture_requests_after_cli: 0,
    },
    reconnect: { initialized: false, loaded_count: 0, contains_thread: false },
    cleanup: {
      server_stopped: false,
      fixture_closed: false,
      config_restored: false,
      fixture_config_removed: false,
      appended_config_preserved: false,
      source_config_hash_unchanged: false,
      token_file_removed: true,
      server_exit_code: null,
      server_spawn_error: null,
      server_stderr_bytes: 0,
      server_stderr_class: 'unknown',
    },
    failure_stage: null,
    failure_code: null,
    failure_rpc_code: null,
    failure_rpc_category: null,
    success: false,
  };
  let stage = 'prepare_workspace';
  let layout = null;
  let sourceConfigHash = null;
  let started = null;
  let server = null;
  let tokenFile = null;
  const connections = [];
  const observers = { a: createClientObserver(), b: createClientObserver(), reconnect: createClientObserver() };
  let threadId = null;

  try {
    layout = prepare(options.outputDirectory || DEFAULT_OUTPUT);
    sourceConfigHash = sha256(readRegularFile(path.join(layout.home, 'config.toml')));
    stage = 'prepare_fixture';
    started = await startFixtureImpl(output, codexPath, { startWith: pendingMode ? 'command' : 'mcp' });
    if (!started || !started.layout || !started.isolatedHome || !started.fixture) {
      throw new ManagedRunError('fixture_setup_invalid');
    }
    assertPrivateHome(output, started.isolatedHome);
    if (!started.version || started.version.version !== REQUIRED_CODEX_VERSION) {
      throw new ManagedRunError('unsupported_native_version');
    }
    result.native_version = started.version.version;
    stage = 'create_token';
    tokenFile = createCapabilityTokenFile(output, runId, dependencies.randomBytes || randomBytes);
    stage = 'start_server';
    const port = await getPort();
    result.transport.port = port;
    server = startServerProcess(codexPath, started.layout.repo, started.isolatedHome, port, tokenFile.tokenPath, {
      spawn: spawnImpl,
    });
    const connectDeadline = Date.now() + timeoutMs;
    stage = 'connect_a';
    const aConnection = await connectClient(connect, {
      port,
      token: tokenFile.token,
      timeoutMs,
      observer: observers.a,
    }, server, connectDeadline);
    connections.push(aConnection);
    stage = 'initialize_a';
    const aInitialized = await initializeClient(aConnection, started.isolatedHome);
    result.clients.a.initialized = true;
    result.clients.a.private_home_match = aInitialized.privateHomeMatch;
    result.native_version = aInitialized.version;
    stage = 'thread_start';
    const aStarted = await aInitialized.client.request('thread/start', {
      cwd: started.layout.repo,
      approvalPolicy,
      sandbox: 'read-only',
      ephemeral: false,
    });
    threadId = aStarted && aStarted.thread && aStarted.thread.id;
    if (!isUuid(threadId)) throw new ManagedRunError('invalid_started_thread');
    result.clients.a.thread_started = true;
    result.clients.a.thread_id = threadId;
    observers.a.setTargetThreadId(threadId);
    if (pendingMode) {
      stage = 'pending_turn_start';
      await runPendingTurn({
        result,
        started,
        aInitialized,
        aStarted,
        threadId,
        port,
        tokenFile,
        timeoutMs,
        server,
        connect,
        connections,
        observers,
        dependencies,
        output,
        runId,
        stage(nextStage) { stage = nextStage; },
      });
    } else {
      stage = 'warmup_turn_start';
      const warmupResponse = await aInitialized.client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'Run the available read-only MCP identity probe once, then finish.' }],
      });
      const warmup = summarizeTurn(warmupResponse && warmupResponse.turn);
      result.turn.warmup.started = Boolean(warmup.id);
      result.turn.warmup.id = warmup.id;
      result.turn.warmup.start_status = warmup.status;
      if (!warmup.id) throw new ManagedRunError('invalid_warmup_turn_response');
      stage = 'warmup_turn_wait';
      result.turn.warmup.terminal_observed = await waitForTerminalTurnStatuses([observers.a], warmup.id, timeoutMs);
      result.turn.warmup.status = observers.a.turnStatus(warmup.id) || 'unknown';
      result.turn.warmup.client_a_saw_turn_id = observers.a.hasTurn(warmup.id);
      if (!result.turn.warmup.terminal_observed) throw new ManagedRunError('warmup_turn_timeout');
      if (result.turn.warmup.status !== 'completed') throw new ManagedRunError('warmup_turn_not_completed');
      stage = 'connect_b';
      const bConnection = await connectClient(connect, {
        port,
        token: tokenFile.token,
        timeoutMs,
        observer: observers.b,
      }, server, Date.now() + timeoutMs);
      connections.push(bConnection);
      stage = 'initialize_b';
      const bInitialized = await initializeClient(bConnection, started.isolatedHome);
      result.clients.b.initialized = true;
      result.clients.b.private_home_match = bInitialized.privateHomeMatch;
      if (bInitialized.version !== result.native_version) throw new ManagedRunError('client_server_version_mismatch');
      stage = 'thread_resume';
      const resumeParams = { threadId, excludeTurns: true };
      const bResumed = await bInitialized.client.request('thread/resume', resumeParams);
      const resumedThreadId = bResumed && bResumed.thread && bResumed.thread.id;
      if (!isUuid(resumedThreadId)) throw new ManagedRunError('invalid_resumed_thread');
      result.clients.b.thread_resumed = true;
      result.clients.b.thread_id = resumedThreadId;
      result.clients.b.same_thread_id = resumedThreadId === threadId;
      result.clients.b.effective_settings_match = compareEffectiveSettings(aStarted, bResumed, started.layout.repo);
      stage = 'loaded_list';
      const loadedA = await readLoadedSnapshot(aInitialized.client, threadId);
      const loadedB = await readLoadedSnapshot(bInitialized.client, threadId);
      result.loaded.a = {
        count: loadedA.count,
        contains_thread: loadedA.containsThread,
        truncated: loadedA.truncated,
      };
      result.loaded.b = {
        count: loadedB.count,
        contains_thread: loadedB.containsThread,
        truncated: loadedB.truncated,
      };
      result.loaded.counts_match = result.loaded.a.count === result.loaded.b.count;
      stage = 'observed_turn_start';
      const observedResponse = await aInitialized.client.request('turn/start', {
        threadId,
        input: [{ type: 'text', text: 'Confirm that the prior read-only probe turn is complete.' }],
      });
      const observed = summarizeTurn(observedResponse && observedResponse.turn);
      result.turn.observed.started = Boolean(observed.id);
      result.turn.observed.id = observed.id;
      result.turn.observed.start_status = observed.status;
      if (!observed.id) throw new ManagedRunError('invalid_observed_turn_response');
      stage = 'observed_turn_wait';
      result.turn.observed.terminal_observed_by_both = await waitForTerminalTurnStatuses(
        [observers.a, observers.b], observed.id, timeoutMs,
      );
      result.turn.observed.status_a = observers.a.turnStatus(observed.id) || 'unknown';
      result.turn.observed.status_b = observers.b.turnStatus(observed.id) || 'unknown';
      result.turn.observed.client_a_saw_turn_id = observers.a.hasTurn(observed.id);
      result.turn.observed.client_b_saw_turn_id = observers.b.hasTurn(observed.id);
      if (!result.turn.observed.terminal_observed_by_both) throw new ManagedRunError('observed_turn_timeout');
      if (result.turn.observed.status_a !== 'completed' || result.turn.observed.status_b !== 'completed') {
        throw new ManagedRunError('observed_turn_not_completed');
      }
      stage = 'fixture_summary';
      result.fixture.request_count = started.fixture.requests.length;
      result.fixture.baseline_request_count = result.fixture.request_count;
      result.fixture.unsupported = Boolean(started.fixture.unsupported);
      result.notifications.a = observers.a.summarize();
      result.notifications.b = observers.b.summarize();
      result.server_requests.count = observers.a.serverRequestCount + observers.b.serverRequestCount;
      result.server_requests.approval_count = result.notifications.a.server_request_approval_count
        + result.notifications.b.server_request_approval_count;
      result.server_requests.other_count = result.notifications.a.server_request_other_count
        + result.notifications.b.server_request_other_count;
      if (result.fixture.request_count !== result.fixture.expected_request_count) {
        throw new ManagedRunError('fixture_request_count_mismatch');
      }
      if (options.serve) {
        if (!buildCoreSuccess(result)) throw new ManagedRunError('serve_precondition_failed');
        const baselineA = observers.a.summarize();
        const baselineB = observers.b.summarize();
        const baselineTurnIdsA = new Set(observers.a.turnSnapshots().map((turnSummary) => turnSummary.id));
        const baselineTurnIdsB = new Set(observers.b.turnSnapshots().map((turnSummary) => turnSummary.id));
        const ready = {
          schema: 'agent-cockpit-poc158-managed-serve-v1',
          run_id: runId,
          host: '127.0.0.1',
          port,
          codex_home: path.resolve(started.isolatedHome),
          cwd: path.resolve(started.layout.repo),
          thread_id: threadId,
          token_file: path.resolve(tokenFile.tokenPath),
        };
        result.serve.ready_file = writeServeReadyFile(output, ready);
        if (typeof dependencies.onServeReady === 'function') {
          dependencies.onServeReady(result.serve.ready_file);
        }
        stage = 'serve_wait';
        const waitForStop = dependencies.waitForStopSignal || waitForStopSignal;
        result.serve.stop_signal = await waitForStop();
        const afterCliA = observers.a.summarize();
        const afterCliB = observers.b.summarize();
        result.serve.notification_delta.a = notificationSummaryDelta(baselineA, afterCliA);
        result.serve.notification_delta.b = notificationSummaryDelta(baselineB, afterCliB);
        result.serve.cli_turns = summarizeSharedTurnsDuringServe(
          observers.a, observers.b, baselineTurnIdsA, baselineTurnIdsB,
        );
        if (result.serve.cli_turns.shared_count === 0) throw new ManagedRunError('serve_turn_not_shared');
        if (result.serve.cli_turns.shared_completed_count === 0) throw new ManagedRunError('serve_turn_not_completed');
        if (started.fixture.requests.length < result.fixture.baseline_request_count + 1) {
          throw new ManagedRunError('serve_fixture_request_missing');
        }
        stage = 'post_cli_loaded_list';
        const loadedAfterCliA = await readLoadedSnapshot(aInitialized.client, threadId);
        const loadedAfterCliB = await readLoadedSnapshot(bInitialized.client, threadId);
        result.serve.loaded_after_cli.a = {
          count: loadedAfterCliA.count,
          contains_thread: loadedAfterCliA.containsThread,
          truncated: loadedAfterCliA.truncated,
        };
        result.serve.loaded_after_cli.b = {
          count: loadedAfterCliB.count,
          contains_thread: loadedAfterCliB.containsThread,
          truncated: loadedAfterCliB.truncated,
        };
        result.serve.loaded_after_cli.counts_match = loadedAfterCliA.count === loadedAfterCliB.count;
        if (!loadedAfterCliA.containsThread || !loadedAfterCliB.containsThread) {
          throw new ManagedRunError('post_cli_thread_unloaded');
        }
        result.serve.additional_loaded_threads.a = await readAdditionalLoadedSummary(aInitialized.client, threadId);
        result.serve.additional_loaded_threads.b = await readAdditionalLoadedSummary(bInitialized.client, threadId);
        stage = 'post_cli_resume';
        const afterCliResume = await bInitialized.client.request('thread/resume', resumeParams);
        result.serve.after_cli_settings_match = compareEffectiveSettings(aStarted, afterCliResume, started.layout.repo);
        if (!result.serve.after_cli_settings_match.all) throw new ManagedRunError('post_cli_settings_mismatch');
      }
    }
    stage = 'disconnect_clients';
    for (const connection of connections.splice(0)) connection.close();
    await delay(300);
    stage = 'reconnect';
    const reconnectConnection = await connectClient(connect, {
      port,
      token: tokenFile.token,
      timeoutMs,
      observer: observers.reconnect,
    }, server, Date.now() + timeoutMs);
    connections.push(reconnectConnection);
    const reconnectClient = await initializeClient(reconnectConnection, started.isolatedHome);
    result.reconnect.initialized = reconnectClient.privateHomeMatch && reconnectClient.version === result.native_version;
    const reloaded = await readLoadedSnapshot(reconnectClient.client, threadId);
    result.reconnect.loaded_count = reloaded.count;
    result.reconnect.contains_thread = reloaded.containsThread;
  } catch (error) {
    result.failure_stage = stage;
    result.failure_code = errorKind(error);
    result.failure_rpc_code = Number.isSafeInteger(error && error.rpcCode) ? error.rpcCode : null;
    const rpcCategory = error && error.rpcErrorCategory;
    result.failure_rpc_category = typeof rpcCategory === 'string'
      && RPC_ERROR_CATEGORIES.includes(rpcCategory)
      ? rpcCategory
      : null;
  } finally {
    stage = result.failure_stage ? stage : 'cleanup';
    for (const connection of connections.splice(0)) {
      try { connection.close(); } catch {}
    }
    if (started) {
      result.fixture.request_count = started.fixture.requests.length;
      result.fixture.unsupported = Boolean(started.fixture.unsupported);
    }
    result.serve.additional_fixture_requests = Math.max(
      0, result.fixture.request_count - result.fixture.baseline_request_count,
    );
    result.notifications.a = observers.a.summarize();
    result.notifications.b = observers.b.summarize();
    result.server_requests.count = observers.a.serverRequestCount + observers.b.serverRequestCount;
    result.server_requests.approval_count = observers.a.summarize().server_request_approval_count
      + observers.b.summarize().server_request_approval_count;
    result.server_requests.other_count = observers.a.summarize().server_request_other_count
      + observers.b.summarize().server_request_other_count;
    result.cleanup.server_stopped = await closeOwnedServer(server);
    if (server) {
      result.cleanup.server_exit_code = server.state.exitCode;
      result.cleanup.server_spawn_error = server.state.spawnErrorCode;
      result.cleanup.server_stderr_bytes = server.state.stderrBytes;
      result.cleanup.server_stderr_class = classifyServerStderr(server.state.stderrText);
    }
    if (started) {
      Object.assign(
        result.cleanup,
        cleanupFixtureConfigPreservingSuffix(started.configPath, started.configSnapshot),
      );
      result.cleanup.fixture_closed = await closeFixture(started.fixture);
    }
    if (layout && sourceConfigHash) {
      try {
        result.cleanup.source_config_hash_unchanged = sha256(readRegularFile(path.join(layout.home, 'config.toml'))) === sourceConfigHash;
      } catch {
        result.cleanup.source_config_hash_unchanged = false;
      }
    }
    result.cleanup.token_file_removed = removeCapabilityTokenFile(
      tokenFile && tokenFile.tokenPath,
      tokenFile && tokenFile.tokenHash,
    );
  }
  if (!result.failure_code && !result.cleanup.server_stopped) {
    result.failure_stage = 'cleanup';
    result.failure_code = 'server_stop_timeout';
  }
  if (!result.failure_code && (!result.cleanup.fixture_closed || !result.cleanup.fixture_config_removed
    || !result.cleanup.appended_config_preserved
    || !result.cleanup.source_config_hash_unchanged || !result.cleanup.token_file_removed)) {
    result.failure_stage = 'cleanup';
    result.failure_code = 'cleanup_incomplete';
  }
  result.success = (pendingMode ? buildPendingSuccess(result) : buildSuccess(result)) && !result.failure_code;
  result.result_file = writeResult(output, result, dependencies);
  return result;
}

async function main(argv) {
  let options;
  try {
    options = parseArguments(argv);
    if (!options.codexPath) throw new ManagedRunError('codex_path_required');
    const result = await runManagedServer(options, {
      onServeReady(readyFile) {
        process.stdout.write(`${JSON.stringify({
          ok: true,
          serving: true,
          mode: options.servePendingTurn ? 'pending_turn' : 'normal',
          ready_file: readyFile,
        })}\n`);
      },
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.success) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: errorKind(error, 'invalid_arguments') })}\n`);
    process.exitCode = 2;
  }
}

if (require.main === module) main(process.argv.slice(2));

module.exports = {
  DEFAULT_OUTPUT,
  DEFAULT_TIMEOUT_MS,
  JSON_RPC_METHODS,
  ManagedRunError,
  buildSuccess,
  chooseLoopbackPort,
  classifyServerStderr,
  compareEffectiveSettings,
  cleanupFixtureConfigPreservingSuffix,
  createClientObserver,
  createResultFileName,
  initializeClient,
  makeServerArguments,
  parseArguments,
  prepareWorkspace,
  readLoadedSnapshot,
  readThreadMetadataSnapshot,
  inspectAdditionalLoadedThreads,
  summarizeServerRequestCorrelation,
  buildPendingSuccess,
  runManagedServer,
  startServerProcess,
};
