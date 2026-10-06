'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const { createHash, randomBytes, randomUUID } = require('node:crypto');
const {
  assertNoSymlinkComponents,
  REQUIRED_CODEX_VERSION,
  REPOSITORY_ROOT,
  renderConfig,
  renderHooksConfig,
  resolveOutputDirectory,
  setup,
} = require('../codex-hooks-identity/setup');
const {
  chooseLoopbackPort,
  makeServerArguments,
  startServerProcess,
  readLoadedSnapshot,
  readThreadMetadataSnapshot,
} = require('../codex-shared-app-server/run-managed');
const { connectViaWebSocket } = require('../codex-shared-app-server/collector');
const {
  FIXTURE_MODEL,
  MARKERS,
  createNativeInstructionFixture,
} = require('../codex-instruction-delivery/native-fixture');
const {
  compareThreadSettings,
  createMarkerTargets,
  createObserver,
  installClientMarkerObserver,
  projectThreadSettings,
} = require('../codex-instruction-delivery/native-runner');
const {
  createCockpitChild,
  requestCockpit,
} = require('./cockpit-probe');

const DEFAULT_OUTPUT = 'poc/out/poc162-native';
const DEFAULT_TIMEOUT_MS = 20000;
const MAX_TIMEOUT_MS = 60000;
const MAX_RESULT_BYTES = 64 * 1024;
const CONNECT_TIMEOUT_MS = 10000;
const SERVER_STOP_TIMEOUT_MS = 4000;
const FIXTURE_CLOSE_TIMEOUT_MS = 5000;
const RPC_METHODS = Object.freeze([
  'initialize', 'initialized', 'thread/start', 'thread/resume', 'thread/read', 'thread/loaded/list',
  'turn/start', 'turn/steer', 'turn/interrupt',
]);
const TURN_STATUSES = new Set(['queued', 'inProgress', 'completed', 'failed', 'interrupted', 'cancelling']);
const OUTPUT_SLUG = /^poc162-[a-z0-9][a-z0-9-]{0,48}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODEX_VERSION_ENVIRONMENT = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'PROGRAMDATA',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'COMSPEC',
]);
const FIXED_TASKS = Object.freeze([
  { title: 'POC162 persistence task', state: 'doing', criteria: [{ text: 'private persistence check', met: false }] },
]);
const FIXED_DECISION = Object.freeze({
  title: 'POC162 persistence decision',
  context: 'Private Cockpit persistence fixture.',
  state: 'waiting',
  options: [{ label: 'Option A', description: 'Fixed persistence fixture.', recommended: true }],
});
const SYNTHETIC_SESSION_ID = 'poc162-native-private-session';

class NativeRecoveryError extends Error {
  constructor(kind) {
    super(kind);
    this.name = 'NativeRecoveryError';
    this.kind = kind;
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--codex-path', '--out', '--timeout-ms', '--mode'].includes(option)
      || values.has(option) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new NativeRecoveryError('invalid_arguments');
    }
    values.set(option, argv[index + 1]);
    index += 1;
  }
  const timeoutMs = values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : DEFAULT_TIMEOUT_MS;
  const mode = values.get('--mode') || 'recovery';
  if (!values.has('--codex-path') || !path.isAbsolute(values.get('--codex-path'))) {
    throw new NativeRecoveryError('absolute_codex_path_required');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new NativeRecoveryError('invalid_timeout');
  }
  if (!['recovery', 'approval', 'cockpit'].includes(mode)) throw new NativeRecoveryError('invalid_mode');
  return {
    codexPath: values.get('--codex-path'),
    outputDirectory: values.get('--out') || DEFAULT_OUTPUT,
    timeoutMs,
    mode,
  };
}

function safeErrorKind(error, fallback = 'native_probe_failed') {
  const candidate = error && (error.kind || error.code);
  return typeof candidate === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(candidate) ? candidate : fallback;
}

function probeLoopbackWebSocketAuthorization({ port, token, timeoutMs }, dependencies = {}) {
  const httpImpl = dependencies.http || http;
  if (!Number.isInteger(port) || port < 1 || port > 65535
    || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1) return Promise.resolve('invalid_probe');
  return new Promise((resolve) => {
    let settled = false;
    let request;
    const finish = (kind) => {
      if (settled) return;
      settled = true;
      try { request?.destroy(); } catch {}
      resolve(kind);
    };
    try {
      request = httpImpl.request({
        host: '127.0.0.1',
        port,
        method: 'GET',
        path: '/',
        headers: {
          Host: `127.0.0.1:${port}`,
          Connection: 'Upgrade',
          Upgrade: 'websocket',
          'Sec-WebSocket-Key': randomBytes(16).toString('base64'),
          'Sec-WebSocket-Version': '13',
          Authorization: `Bearer ${token}`,
        },
      }, (response) => {
        const status = response.statusCode;
        response.destroy();
        finish(status === 401 ? 'http_401' : status === 403 ? 'http_403' : 'other_http_status');
      });
    } catch {
      finish('connection_error');
      return;
    }
    request.once('upgrade', (_response, socket) => {
      try { socket.destroy(); } catch {}
      finish('http_101');
    });
    request.once('error', (error) => finish(error && error.code === 'ETIMEDOUT' ? 'timeout' : 'connection_error'));
    request.setTimeout(timeoutMs, () => finish('timeout'));
    request.end();
  });
}

function safeUuid(value) {
  return typeof value === 'string' && UUID.test(value) ? value : null;
}

function safeRpcCode(error) {
  return Number.isSafeInteger(error && error.rpcCode) ? error.rpcCode : null;
}

function safeRpcCategory(error) {
  const allowed = new Set([
    'thread_not_found', 'history_missing', 'not_initialized', 'experimental_required',
    'invalid_params', 'permission_denied', 'thread_not_persisted', 'resume_unavailable', 'unknown',
  ]);
  return allowed.has(error && error.rpcErrorCategory) ? error.rpcErrorCategory : 'unknown';
}

function validateExecutable(codexPath, fileSystem = fs) {
  if (typeof codexPath !== 'string' || !path.isAbsolute(codexPath)) {
    throw new NativeRecoveryError('absolute_codex_path_required');
  }
  let stat;
  try { stat = fileSystem.lstatSync(codexPath); } catch { throw new NativeRecoveryError('codex_executable_missing'); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new NativeRecoveryError('invalid_codex_executable');
  return path.resolve(codexPath);
}

function validateOutputDirectory(outputDirectory, fileSystem = fs) {
  if (typeof outputDirectory !== 'string') throw new NativeRecoveryError('output_directory_invalid');
  const output = resolveOutputDirectory(outputDirectory);
  if (!OUTPUT_SLUG.test(path.basename(output))) throw new NativeRecoveryError('output_directory_invalid');
  assertNoSymlinkComponents(REPOSITORY_ROOT, output);
  if (fileSystem.existsSync(output)) throw new NativeRecoveryError('output_directory_not_fresh');
  return output;
}

function prepareWorkspace(outputDirectory, dependencies = {}) {
  const fileSystem = dependencies.fs || fs;
  const output = validateOutputDirectory(outputDirectory, fileSystem);
  const setupImpl = dependencies.setup || setup;
  const relative = path.relative(REPOSITORY_ROOT, output).split(path.sep).join('/');
  const layout = setupImpl({ outputDirectory: relative, codexVersion: REQUIRED_CODEX_VERSION });
  const expected = {
    output,
    home: path.join(output, 'home'),
    repo: path.join(output, 'repo'),
  };
  if (path.resolve(layout.output) !== expected.output || path.resolve(layout.home) !== expected.home
    || path.resolve(layout.repo) !== expected.repo) throw new NativeRecoveryError('workspace_layout_invalid');
  for (const directory of [layout.home, layout.repo]) {
    const stat = fileSystem.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NativeRecoveryError('workspace_layout_invalid');
  }
  return { output, layout };
}

function writeWorkspaceFile(fileSystem, filePath, contents) {
  fileSystem.writeFileSync(filePath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function prepareOwnedWorkspaceContents(output, fileSystem = fs, dependencies = {}) {
  const layout = {
    output,
    home: path.join(output, 'home'),
    repo: path.join(output, 'repo'),
    hooks: path.join(output, 'home', 'hooks'),
  };
  fileSystem.mkdirSync(layout.home, { recursive: false, mode: 0o700 });
  fileSystem.mkdirSync(layout.hooks, { recursive: false, mode: 0o700 });
  fileSystem.mkdirSync(layout.repo, { recursive: false, mode: 0o700 });
  const hookLogger = path.join(layout.hooks, 'hook-logger.js');
  writeWorkspaceFile(fileSystem, hookLogger,
    fileSystem.readFileSync(path.join(__dirname, '..', 'codex-hooks-identity', 'hook-logger.js')));
  const hooksConfig = renderHooksConfig(hookLogger).replace(
    'Codex 0.160.0 identity probe', 'Codex identity probe',
  );
  writeWorkspaceFile(fileSystem, path.join(layout.home, 'hooks.json'), hooksConfig);
  writeWorkspaceFile(fileSystem, path.join(layout.home, 'config.toml'),
    renderConfig(path.join(__dirname, '..', 'codex-hooks-identity', 'mcp-probe.js')));
  writeWorkspaceFile(fileSystem, path.join(layout.repo, 'README.md'),
    '# Codex identity fixture\n\nThis repository isolates the Agent Cockpit identity probe.\n');
  const localInstructions = '# 隔離PoC\n\nこのリポジトリはAgent Cockpitの識別情報を確認するための空のfixtureです。\n';
  writeWorkspaceFile(fileSystem, path.join(layout.repo, 'AGENTS.md'), localInstructions);
  writeWorkspaceFile(fileSystem, path.join(layout.repo, 'CLAUDE.md'), localInstructions);
  writeWorkspaceFile(fileSystem, path.join(layout.repo, '.gitignore'), 'events.jsonl\n');
  (dependencies.execFileSync || execFileSync)('git', ['init', '--quiet'], {
    cwd: layout.repo,
    stdio: 'ignore',
  });
  return { output, layout };
}

function prepareOwnedWorkspace(outputDirectory, fileSystem = fs, dependencies = {}, onOwnedOutput) {
  const output = validateOutputDirectory(outputDirectory, fileSystem);
  fileSystem.mkdirSync(output, { recursive: false, mode: 0o700 });
  onOwnedOutput?.(output);
  const outputStat = fileSystem.lstatSync(output);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
    throw new NativeRecoveryError('workspace_layout_invalid');
  }
  assertNoSymlinkComponents(REPOSITORY_ROOT, output);
  return dependencies.prepareWorkspace
    ? dependencies.prepareWorkspace(output, { fs: fileSystem, outputOwned: true })
    : prepareOwnedWorkspaceContents(output, fileSystem, dependencies);
}

function makeCodexEnvironment(home, source = process.env) {
  const environment = {};
  for (const name of CODEX_VERSION_ENVIRONMENT) {
    if (typeof source[name] === 'string') environment[name] = source[name];
  }
  environment.CODEX_HOME = home;
  return environment;
}

function readCodexVersion(executable, home, options = {}) {
  const spawnImpl = options.spawn || spawn;
  const timeoutMs = Number.isSafeInteger(options.timeoutMs) ? Math.min(Math.max(options.timeoutMs, 1000), 15000) : 10000;
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, ['--version'], {
        cwd: options.cwd,
        env: makeCodexEnvironment(home, options.environment || process.env),
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch {
      reject(new NativeRecoveryError('codex_version_process_failed'));
      return;
    }
    let stdout = '';
    let spawnFailed = false;
    let timedOut = false;
    let settled = false;
    const state = { closed: false, exitCode: null, signal: null };
    let resolveExit;
    const exited = new Promise((resolvePromise) => { resolveExit = resolvePromise; });
    const ownedProcess = { child, state, exited };
    let escalationTimer = null;
    let exitTimer = null;
    const finish = (error, version) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      clearTimeout(exitTimer);
      if (error) reject(error);
      else resolve({ version });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch {}
      escalationTimer = setTimeout(() => {
        if (!state.closed) {
          try { child.kill('SIGKILL'); } catch {}
        }
      }, 1000);
      exitTimer = setTimeout(() => {
        if (!state.closed) finish(new NativeRecoveryError('codex_version_exit_unobserved'));
      }, Math.max(1000, Math.min(timeoutMs, SERVER_STOP_TIMEOUT_MS)));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      if (stdout.length < 4096) stdout += chunk.toString('utf8').slice(0, 4096 - stdout.length);
    });
    child.once('error', () => { spawnFailed = true; });
    child.once('close', (code, signal) => {
      state.closed = true;
      state.exitCode = Number.isInteger(code) ? code : null;
      state.signal = typeof signal === 'string' ? signal : null;
      resolveExit(state);
      if (timedOut) {
        finish(new NativeRecoveryError('codex_version_timeout'));
        return;
      }
      if (spawnFailed) {
        finish(new NativeRecoveryError('codex_version_process_failed'));
        return;
      }
      const match = code === 0 ? stdout.match(/\b(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\b/) : null;
      if (!match) finish(new NativeRecoveryError('codex_version_unavailable'));
      else finish(null, match[1]);
    });
    options.onOwnedChild?.(ownedProcess);
  });
}

async function stopOwnedProcess(ownedProcess, timeoutMs = SERVER_STOP_TIMEOUT_MS) {
  if (!ownedProcess) return { kill_requested: false, exit_observed: true };
  const { child, state } = ownedProcess;
  if (state.closed) return { kill_requested: false, exit_observed: true };
  let killRequested = false;
  try { killRequested = child.kill('SIGKILL') === true; } catch {}
  const exitObserved = await Promise.race([
    Promise.resolve(ownedProcess.exited).then(() => true, () => Boolean(state.closed)),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
  return { kill_requested: killRequested, exit_observed: exitObserved || state.closed === true };
}

function replaceFileAtomically(filePath, expectedContents, nextContents, fileSystem = fs) {
  const stat = fileSystem.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new NativeRecoveryError('private_config_invalid');
  if (fileSystem.readFileSync(filePath, 'utf8') !== expectedContents) throw new NativeRecoveryError('private_config_changed');
  const temporary = `${filePath}.poc162-${randomUUID()}.tmp`;
  try {
    fileSystem.writeFileSync(temporary, nextContents, { encoding: 'utf8', flag: 'wx', mode: stat.mode & 0o777 });
    fileSystem.renameSync(temporary, filePath);
  } finally {
    try { fileSystem.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function writePrivateConfig(layout, fixture, fileSystem = fs) {
  const configPath = path.join(layout.home, 'config.toml');
  assertNoSymlinkComponents(layout.output, configPath);
  const stat = fileSystem.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new NativeRecoveryError('private_config_invalid');
  const originalConfig = fileSystem.readFileSync(configPath, 'utf8');
  const fixtureToken = fixture.requestHeaders?.['X-Poc161-Token'];
  if (typeof fixtureToken !== 'string' || !/^[0-9a-f]{64}$/.test(fixtureToken) || typeof fixture.baseUrl !== 'string') {
    throw new NativeRecoveryError('fixture_connection_details_invalid');
  }
  const quote = (value) => JSON.stringify(value);
  const provider = [
    `model = ${quote(FIXTURE_MODEL)}`,
    'model_provider = "poc161_fixture"',
    '',
    '[model_providers.poc161_fixture]',
    'name = "Local deterministic recovery fixture"',
    `base_url = ${quote(fixture.baseUrl)}`,
    'wire_api = "responses"',
    `http_headers = { "X-Poc161-Token" = ${quote(fixtureToken)} }`,
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n');
  const appliedConfig = `${provider}\n${originalConfig.trim()}\n`;
  replaceFileAtomically(configPath, originalConfig, appliedConfig, fileSystem);
  return { output: layout.output, isolatedHome: layout.home, configPath, originalConfig, appliedConfig };
}

function restorePrivateConfig(snapshot, fileSystem = fs) {
  if (!snapshot || typeof snapshot.configPath !== 'string') return false;
  try {
    const stat = fileSystem.lstatSync(snapshot.configPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const current = fileSystem.readFileSync(snapshot.configPath, 'utf8');
    if (current === snapshot.originalConfig) return true;
    if (current !== snapshot.appliedConfig) return false;
    replaceFileAtomically(snapshot.configPath, current, snapshot.originalConfig, fileSystem);
    return true;
  } catch {
    return false;
  }
}

function createCapabilityToken(output, fileSystem = fs, randomBytesImpl = randomBytes) {
  const token = randomBytesImpl(32).toString('hex');
  const tokenPath = path.join(output, `.poc162-capability-${randomUUID()}.token`);
  assertNoSymlinkComponents(REPOSITORY_ROOT, tokenPath);
  try {
    fileSystem.writeFileSync(tokenPath, token, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    const stat = fileSystem.lstatSync(tokenPath);
    if (!stat.isFile() || stat.isSymbolicLink() || fileSystem.readFileSync(tokenPath, 'utf8') !== token) {
      throw new NativeRecoveryError('capability_token_file_invalid');
    }
    return { token, tokenPath, hash: createHash('sha256').update(token).digest('hex') };
  } catch (error) {
    try {
      const stat = fileSystem.lstatSync(tokenPath);
      if (stat.isFile() && !stat.isSymbolicLink() && fileSystem.readFileSync(tokenPath, 'utf8') === token) fileSystem.unlinkSync(tokenPath);
    } catch {}
    throw error instanceof NativeRecoveryError ? error : new NativeRecoveryError('capability_token_file_failed');
  }
}

function removeCapabilityToken(output, tokenFile, fileSystem = fs) {
  if (!tokenFile) return true;
  if (path.dirname(path.resolve(tokenFile.tokenPath)) !== path.resolve(output)
    || !/^\.poc162-capability-[0-9a-f-]{36}\.token$/i.test(path.basename(tokenFile.tokenPath))) return false;
  try {
    const stat = fileSystem.lstatSync(tokenFile.tokenPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const contents = fileSystem.readFileSync(tokenFile.tokenPath, 'utf8');
    if (createHash('sha256').update(contents).digest('hex') !== tokenFile.hash) return false;
    fileSystem.unlinkSync(tokenFile.tokenPath);
    return !fileSystem.existsSync(tokenFile.tokenPath);
  } catch (error) {
    return error.code === 'ENOENT';
  }
}

function removePrivateHome(output, home, fileSystem = fs) {
  if (!output || !home) return true;
  const resolvedOutput = path.resolve(output);
  const target = path.resolve(home);
  if (path.dirname(target) !== resolvedOutput || path.basename(target) !== 'home') return false;
  try {
    assertNoSymlinkComponents(REPOSITORY_ROOT, resolvedOutput);
    assertNoSymlinkComponents(resolvedOutput, target);
    const stat = fileSystem.lstatSync(target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    fileSystem.rmSync(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
    return !fileSystem.existsSync(target);
  } catch {
    return !fileSystem.existsSync(target);
  }
}

async function waitForServerExit(server, timeoutMs) {
  const state = server.state || {};
  return Promise.race([
    Promise.resolve(server.exited).then(() => true, () => Boolean(state.closed)),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

async function hardKillOwnedServer(server, timeoutMs = SERVER_STOP_TIMEOUT_MS) {
  if (!server) return { kill_requested: false, exit_observed: false, signal: 'SIGKILL' };
  const state = server.state || {};
  if (state.closed) return { kill_requested: false, exit_observed: true, signal: 'SIGKILL' };
  let killRequested = false;
  try { killRequested = server.child.kill('SIGKILL') === true; } catch {}
  const exitObserved = await waitForServerExit(server, timeoutMs);
  return { kill_requested: killRequested, exit_observed: exitObserved || state.closed === true, signal: 'SIGKILL' };
}

async function stopOwnedServer(server, timeoutMs = SERVER_STOP_TIMEOUT_MS) {
  if (!server) return { kill_requested: false, exit_observed: true, exit_code: null, signal: null };
  const state = server.state || {};
  if (state.closed) return { kill_requested: false, exit_observed: true, exit_code: state.exitCode ?? null, signal: state.signal || null };
  let killRequested = false;
  try { killRequested = server.child.kill() === true; } catch {}
  let exited = await waitForServerExit(server, timeoutMs);
  if (!exited) {
    try { killRequested = server.child.kill('SIGKILL') === true || killRequested; } catch {}
    exited = await waitForServerExit(server, timeoutMs);
  }
  return {
    kill_requested: killRequested,
    exit_observed: exited || state.closed === true,
    exit_code: Number.isInteger(state.exitCode) ? state.exitCode : null,
    signal: typeof state.signal === 'string' && /^[A-Z0-9_]{1,32}$/.test(state.signal) ? state.signal : null,
  };
}

function createRecoveryObserver() {
  const observer = createObserver();
  return {
    onNotification: observer.onNotification,
    onServerRequest: observer.onServerRequest,
    turnStatus(turnId) { return observer.turnStatuses.get(turnId) || 'unknown'; },
    turnIds: observer.turnIds,
    summary() {
      const summary = observer.summary();
      return { ...summary, waiting_on_question: summary.waiting_on_user_input };
    },
  };
}

function createNativeMarkerProjection() {
  return {
    native_user_markers: Object.fromEntries(Object.keys(MARKERS).map((key) => [key, false])),
    native_user_marker_evidence: Object.fromEntries(Object.keys(MARKERS).map((key) => [key, {
      exact_text_match: false,
      same_item_tuple_match: false,
      same_item_thread_turn_match: false,
      expected_client_message_id_match: null,
      native_item_count: 0,
      unique_native_item_count: 0,
    }])),
    native_marker_parse_errors: 0,
  };
}

function projectSafeSettings(response, expectedCwd) {
  return projectThreadSettings(response, expectedCwd);
}

function safeTurnStatus(observer, turnId) {
  const status = observer.turnStatus(turnId);
  return TURN_STATUSES.has(status) ? status : 'unknown';
}

async function requestRpc(client, method, params) {
  try {
    return { accepted: true, rpc_code: null, error_category: null, result: await client.request(method, params) };
  } catch (error) {
    return { accepted: false, rpc_code: safeRpcCode(error), error_category: safeRpcCategory(error), result: null };
  }
}

function countTurnStartRequests(client) {
  const request = client.request.bind(client);
  let count = 0;
  client.request = (method, params) => {
    if (method === 'turn/start') count += 1;
    return request(method, params);
  };
  return () => count;
}

async function waitUntil(predicate, timeoutMs, options = {}) {
  const now = options.now || Date.now;
  const sleep = options.sleep || ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)));
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    if (predicate()) return true;
    await sleep(Math.min(25, Math.max(1, deadline - now())));
  }
  return Boolean(predicate());
}

async function waitForTurn(observers, turnId, timeoutMs, options = {}) {
  return waitUntil(() => observers.every((observer) => ['completed', 'interrupted', 'failed'].includes(observer.turnStatus(turnId))), timeoutMs, options);
}

async function connectClient({ port, token, timeoutMs, observer }, dependencies, server) {
  const connect = dependencies.connect || connectViaWebSocket;
  const deadline = Date.now() + Math.min(timeoutMs, CONNECT_TIMEOUT_MS);
  let lastError = 'connection_error';
  while (Date.now() < deadline) {
    if (server?.state?.closed) throw new NativeRecoveryError('app_server_exited_before_connect');
    try {
      return await connect({
        url: `ws://127.0.0.1:${port}`,
        authToken: token,
        timeoutMs: Math.min(timeoutMs, 3000),
        allowedMethods: RPC_METHODS,
        onNotification: observer.onNotification,
        onServerRequest: observer.onServerRequest,
      });
    } catch (error) {
      lastError = safeErrorKind(error, 'connection_error');
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new NativeRecoveryError(`app_server_connect_${lastError}`);
}

function validateNativeInitializeResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.codexHome !== 'string'
    || !path.isAbsolute(value.codexHome)
    || typeof value.platformFamily !== 'string'
    || typeof value.platformOs !== 'string'
    || typeof value.userAgent !== 'string') {
    throw new NativeRecoveryError('app_server_initialize_response_invalid');
  }
  const match = value.userAgent.match(/(?:^|[/ ])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:$|[^0-9A-Za-z.+-])/);
  if (!match) throw new NativeRecoveryError('app_server_version_unavailable');
  return { version: match[1] };
}

async function initializeClient(connection, home, timeoutMs) {
  if (!connection?.client || typeof connection.client.request !== 'function' || typeof connection.client.notify !== 'function') {
    throw new NativeRecoveryError('app_server_client_invalid');
  }
  const response = await connection.client.request('initialize', {
    clientInfo: { name: 'agent-cockpit-poc162-recovery', title: 'Agent Cockpit recovery fixture', version: '0.1.0' },
    capabilities: { experimentalApi: false },
  });
  const metadata = validateNativeInitializeResponse(response);
  await connection.client.notify('initialized', {});
  return {
    version: metadata.version,
    private_home_match: typeof response.codexHome === 'string'
      && path.resolve(response.codexHome).toLowerCase() === path.resolve(home).toLowerCase(),
  };
}

async function readKnownThread(client, threadId) {
  try {
    const snapshot = await readThreadMetadataSnapshot(client, threadId);
    return { available: true, ...snapshot };
  } catch (error) {
    return { available: false, thread_matches: false, status: 'unknown', turns_returned: false,
      error_category: safeRpcCategory(error) };
  }
}

function settingsPreserved(left, right) {
  return compareThreadSettings(left, right);
}

function collectFixtureSummary(fixture, requests = fixture?.requests || []) {
  if (!fixture) return { request_count: 0, request_markers: Object.fromEntries(Object.keys(MARKERS).map((key) => [key, 0])),
    unsupported: false, exec_tool_declared: false, call_output_count: 0 };
  const markerCounts = Object.fromEntries(Object.keys(MARKERS).map((key) => [key, 0]));
  let execToolDeclared = false;
  let callOutputCount = 0;
  for (const request of requests) {
    for (const [key, seen] of Object.entries(request.marker_hits || {})) {
      if (Object.hasOwn(markerCounts, key) && seen === true) markerCounts[key] += 1;
    }
    execToolDeclared ||= request.tool_inventory?.exec_command === true;
    callOutputCount += request.call_output_seen === true ? 1 : 0;
  }
  return {
    request_count: requests.length,
    request_markers: markerCounts,
    unsupported: fixture.unsupported === true,
    exec_tool_declared: execToolDeclared,
    call_output_count: callOutputCount,
  };
}

async function waitForFixtureConnectionsToClose(fixture, timeoutMs, dependencies = {}) {
  if (dependencies.waitForFixtureConnectionsToClose) {
    return (await dependencies.waitForFixtureConnectionsToClose(fixture, timeoutMs)) === true;
  }
  const server = fixture?.server;
  if (!server || typeof server.getConnections !== 'function') return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const connections = await new Promise((resolve) => {
      server.getConnections((error, count) => resolve(error ? null : count));
    });
    if (connections === 0) return true;
    if (connections === null) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

function calculateMeasurementSuccess(result) {
  if (!result || result.failure_code || !result.cleanup?.output_owned) return false;
  if (result.mode === 'cockpit') return Boolean(result.cockpit?.measurement_observed);
  if (typeof result.target_version !== 'string' || result.target_version.length === 0) return false;
  if (result.mode === 'recovery') {
    return Boolean(result.thread.started && result.turns.warmup?.terminal_observed
      && result.turns.warmup?.status_a === 'completed'
      && result.turns.held?.fixture_gate_observed && result.turns.held?.active_observed
      && result.steer.acknowledgement_received && result.steer.same_turn_id
      && result.steer.sender_disconnected_after_ack
      && result.recovery.hard_kill_requested && result.recovery.hard_kill_exit_observed
      && result.recovery.hard_kill_signal === 'SIGKILL'
      && result.recovery.fixture_gate_held_at_kill && result.recovery.fixture_released_after_exit
      && result.recovery.fixture_old_generation_drained
      && result.recovery.current_token_initialize_succeeded && result.recovery.probe_completed_after_restart);
  }
  if (result.mode === 'approval') {
    return Boolean(result.thread.started && result.turns.warmup?.terminal_observed
      && result.turns.approval?.terminal_observed && result.fixture.request_count > 0);
  }
  return false;
}

function calculateMetadataRecoverySuccess(result) {
  if (!result || result.mode !== 'recovery' || !result.measurement_success) return false;
  return Boolean(result.recovery.old_token_websocket_rejected && result.recovery.current_token_initialize_succeeded
    && result.recovery.hard_kill_requested && result.recovery.hard_kill_exit_observed
    && result.recovery.hard_kill_signal === 'SIGKILL'
    && result.recovery.fixture_gate_held_at_kill && result.recovery.fixture_released_after_exit
    && result.recovery.fixture_old_generation_drained
    && result.recovery.metadata_restored_after_resume === true
    && result.recovery.read_after_resume?.available === true
    && result.recovery.read_after_resume.thread_matches === true
    && result.recovery.loaded_after_resume?.available === true
    && result.recovery.loaded_after_resume.contains_thread === true
    && result.recovery.resume_accepted
    && result.recovery.same_thread_id
    && result.settings.recovery_preserved === true
    && result.recovery.turn_start_rpc_count_after_restart === 0
    && result.recovery.turn_started_notifications_after_restart === 0);
}

function calculateRecoverySuccess(result) {
  if (!result || result.mode !== 'recovery' || !result.metadata_recovery_success) return false;
  return Boolean(result.steer.acknowledgement_received && result.steer.same_turn_id
    && result.steer.sender_disconnected_after_ack
    && result.steer.native_item_thread_turn_match === true
    && result.steer.native_item_client_id_match === true);
}

function calculateFeatureFlowSuccess(result) {
  if (result.mode === 'recovery') return result.recovery_success;
  if (result.mode === 'cockpit') return result.cockpit_persistence_success;
  return null;
}

async function createStartedTurn(client, threadId, marker, markerName, markers, observer) {
  const clientUserMessageId = randomUUID();
  markers.register(markerName, clientUserMessageId);
  const started = await requestRpc(client, 'turn/start', {
    threadId,
    input: [{ type: 'text', text: marker }],
    clientUserMessageId,
  });
  const turnId = safeUuid(started.result?.turn?.id);
  if (started.accepted && turnId) markers.bindTurn(markerName, turnId);
  return { ...started, turnId, clientUserMessageId };
}

function turnRecord(started, observers, terminalObserved) {
  return {
    id: safeUuid(started.turnId),
    start_accepted: started.accepted,
    start_error_category: started.error_category,
    start_status: TURN_STATUSES.has(started.result?.turn?.status) ? started.result.turn.status : 'unknown',
    status_a: safeTurnStatus(observers[0], started.turnId),
    status_b: observers[1] ? safeTurnStatus(observers[1], started.turnId) : 'unknown',
    terminal_observed: terminalObserved,
  };
}

async function closeConnection(connection) {
  if (!connection) return true;
  try { connection.close(); return true; } catch { return false; }
}

function markerEvidence(projection, markerName) {
  const value = projection.native_user_marker_evidence?.[markerName];
  return {
    exact_text_match: value?.exact_text_match === true,
    thread_turn_match: value?.same_item_thread_turn_match === true,
    client_message_id_match: value?.expected_client_message_id_match === true
      ? true : value?.expected_client_message_id_match === false ? false : null,
    unique_native_item_count: Number.isSafeInteger(value?.unique_native_item_count) ? value.unique_native_item_count : 0,
  };
}

function makeResult(options) {
  const result = {
    schema: 'agent-cockpit-poc162-recovery-v1',
    backend: { source: 'local_responses_fixture', model: FIXTURE_MODEL, real_model_observed: false },
    mode: options.mode,
    target_version: null,
    server_versions: { a: null, b: null, recovery: null },
    output_directory: null,
    success: false,
    measurement_success: false,
    metadata_recovery_success: null,
    feature_flow_success: null,
    recovery_success: null,
    approval_state_observed: null,
    cockpit_persistence_success: null,
    failure_stage: null,
    failure_code: null,
    thread: { id: null, started: false, initial_resume_same_id: false,
      initial_resume_rpc_code: null, initial_resume_error_category: null, read_after_warmup: null },
    settings: { after_start: null, initial_resume: null, start_resume_match: null, recovery_resume: null, recovery_preserved: null },
    clients: { a_initialized: false, b_initialized: false, b_reconnected: false, recovery_client_initialized: false },
    turns: { warmup: null, held: null, approval: null },
    steer: { acknowledgement_received: false, same_turn_id: false, sender_disconnected_after_ack: false,
      fixture_marker_seen: false, native_item_thread_turn_match: false, native_item_client_id_match: null,
      terminal_status_a: 'unknown', terminal_status_b: 'unknown', retry_count: 0 },
    recovery: {
      first_server_exit_observed: false,
      hard_kill_requested: false,
      hard_kill_signal: null,
      hard_kill_exit_observed: false,
      fixture_gate_held_at_kill: null,
      fixture_released_after_exit: false,
      fixture_old_generation_drained: false,
      fixture_generations: { initial_server: null, restarted_server: null },
      old_token_websocket_rejected: false,
      old_token_error_kind: 'unknown',
      current_token_initialize_succeeded: false,
      history_loaded_reconciled: null,
      metadata_restored_after_resume: null,
      turn_execution_resumed_after_restart: null,
      original_execution_continued_after_restart: null,
      probe_completed_after_restart: false,
      read_before_resume: null,
      loaded_before_resume: null,
      resume_accepted: false,
      same_thread_id: false,
      read_after_resume: null,
      loaded_after_resume: null,
      turn_start_rpc_count_after_restart: null,
      turn_started_notifications_after_restart: null,
    },
    approval: { request_observed: false, waiting_on_approval_seen: false,
      waiting_on_approval_active_before_interrupt: false, waiting_on_approval_active: false,
      waiting_on_approval_cleared: false, runner_replied: false, interrupt_accepted: false, terminal_observed: false },
    cockpit: null,
    fixture: { request_count: 0, request_markers: Object.fromEntries(Object.keys(MARKERS).map((key) => [key, 0])),
      unsupported: false, exec_tool_declared: false, call_output_count: 0 },
    observed: { a: null, b: null, recovery: null },
    cleanup: {
      client_a_closed: true,
      client_b_closed: true,
      recovery_client_closed: true,
      server_exit_observed: true,
      fixture_closed: true,
      fixture_drained: true,
      fixture_released_after_servers_exit: true,
      runtime_process_exit_observed: true,
      private_config_restored: true,
      private_config_removed: true,
      token_files_removed: true,
      private_home_removed: true,
      output_owned: false,
      result_written: false,
    },
  };
  if (options.mode === 'cockpit') {
    result.cockpit = {
      measurement_observed: false,
      first_child_exit_observed: false,
      second_child_exit_observed: false,
      task_written: false,
      decision_written: false,
      away_enabled: false,
      task_persisted_after_restart: false,
      decision_persisted_after_restart: false,
      away_persisted_after_restart: false,
      old_hook_secret_rejected: false,
      old_ui_secret_rejected: false,
      current_secret_accepted: false,
      foreign_origin_rejected: false,
      security_headers_observed: false,
      statuses: { old_hook: null, old_ui: null, current_hook: null, current_ui: null, foreign_origin: null },
    };
  }
  return result;
}

async function prepareNativeWorkspace(options, dependencies, fileSystem, onOwnedOutput) {
  const executable = validateExecutable(options.codexPath, fileSystem);
  const output = validateOutputDirectory(options.outputDirectory, fileSystem);
  const workspace = await prepareOwnedWorkspace(options.outputDirectory, fileSystem, {
    prepareWorkspace: dependencies.prepareWorkspace,
    execFileSync: dependencies.execFileSync,
  }, onOwnedOutput);
  if (!workspace || path.resolve(workspace.output) !== output || !workspace.layout) {
    throw new NativeRecoveryError('workspace_layout_invalid');
  }
  return { executable, output, layout: workspace.layout };
}

async function waitForFixtureMarker(fixture, markerName, timeoutMs, dependencies) {
  return waitUntil(() => (fixture.requests || []).some((request) => request.marker_hits?.[markerName] === true), timeoutMs, dependencies);
}

async function runWarmup(session) {
  const { result, fixture, clientA, observerA, observerB, markerTargets, timeoutMs, dependencies } = session;
  const start = await createStartedTurn(clientA, session.threadId, MARKERS.warmup, 'warmup', markerTargets, observerA);
  if (!start.accepted || !start.turnId) throw new NativeRecoveryError('warmup_turn_start_failed');
  const terminal = await waitForTurn([observerA], start.turnId, timeoutMs, dependencies);
  const fixtureSeen = await waitForFixtureMarker(fixture, 'warmup', Math.min(timeoutMs, 3000), dependencies);
  result.turns.warmup = { ...turnRecord(start, [observerA, observerB], terminal), fixture_marker_seen: fixtureSeen,
    native_item: markerEvidence(session.markerProjection, 'warmup') };
  if (!terminal || safeTurnStatus(observerA, start.turnId) !== 'completed') {
    throw new NativeRecoveryError('warmup_turn_not_completed');
  }
}

async function runHeldSteer(session) {
  const { result, fixture, clientA, observerA, observerB, markerTargets, timeoutMs, dependencies } = session;
  fixture.gateNext();
  const start = await createStartedTurn(clientA, session.threadId, MARKERS.initial, 'initial', markerTargets, observerA);
  if (!start.accepted || !start.turnId) throw new NativeRecoveryError('held_turn_start_failed');
  const gateObserved = await fixture.waitForGate(Math.min(timeoutMs, 10000));
  const turnActive = await waitUntil(() => observerA.turnStatus(start.turnId) === 'inProgress', Math.min(timeoutMs, 5000), dependencies);
  result.turns.held = { ...turnRecord(start, [observerA, observerB], false), fixture_gate_observed: gateObserved,
    active_observed: turnActive };
  if (!gateObserved || !turnActive || !session.clientB) {
    throw new NativeRecoveryError('held_turn_not_observed');
  }
  const clientUserMessageId = randomUUID();
  markerTargets.register('steer', clientUserMessageId);
  const steer = await requestRpc(session.clientB, 'turn/steer', {
    threadId: session.threadId,
    expectedTurnId: start.turnId,
    input: [{ type: 'text', text: MARKERS.steer }],
    clientUserMessageId,
  });
  result.steer.acknowledgement_received = steer.accepted;
  result.steer.same_turn_id = safeUuid(steer.result?.turnId) === start.turnId;
  if (steer.accepted && result.steer.same_turn_id) markerTargets.bindTurn('steer', start.turnId);
  result.steer.sender_disconnected_after_ack = steer.accepted ? await closeConnection(session.connectionB) : false;
  if (result.steer.sender_disconnected_after_ack) {
    session.connectionB = null;
    session.clientB = null;
  }
  if (!steer.accepted || !result.steer.same_turn_id || !result.steer.sender_disconnected_after_ack) {
    throw new NativeRecoveryError('held_steer_not_accepted');
  }
  result.steer.fixture_marker_seen = await waitForFixtureMarker(fixture, 'steer', Math.min(timeoutMs, 4000), dependencies);
  await waitUntil(() => {
    const evidence = markerEvidence(session.markerProjection, 'steer');
    return evidence.thread_turn_match && evidence.client_message_id_match === true;
  }, Math.min(timeoutMs, 5000), dependencies);
  const evidence = markerEvidence(session.markerProjection, 'steer');
  result.steer.native_item_thread_turn_match = evidence.thread_turn_match;
  result.steer.native_item_client_id_match = evidence.client_message_id_match;
  result.steer.unique_native_item_count = evidence.unique_native_item_count;
  result.steer.terminal_status_a = safeTurnStatus(observerA, start.turnId);
  result.steer.terminal_status_b = safeTurnStatus(observerB, start.turnId);
}

async function createAndStartServer({ executable, layout, tokenFile, dependencies, onOwnedServer }) {
  const port = await (dependencies.choosePort || chooseLoopbackPort)();
  const start = dependencies.startServer || startServerProcess;
  const starting = start(executable, layout.repo, layout.home, port, tokenFile.tokenPath, dependencies);
  const server = starting && typeof starting.then === 'function' ? await starting : starting;
  onOwnedServer?.(server);
  return { port, server };
}

async function runRecoveryMode(session) {
  const { result, options, dependencies, output, layout, executable, fileSystem } = session;
  const recovery = result.recovery;
  await runHeldSteer(session);
  const preRestartRead = await readKnownThread(session.clientA, session.threadId);
  const preRestartLoaded = await safeLoadedSnapshot(session.clientA, session.threadId);
  recovery.read_before_initial_shutdown = preRestartRead;
  recovery.loaded_before_initial_shutdown = preRestartLoaded;
  recovery.fixture_gate_held_at_kill = session.fixture.gateWaiting > 0;
  result.observed.a = session.observerA.summary();
  result.observed.b = session.observerB.summary();

  const initialRequests = session.fixture.requests || [];
  const firstStop = await hardKillOwnedServer(session.server, SERVER_STOP_TIMEOUT_MS);
  recovery.hard_kill_requested = firstStop.kill_requested;
  recovery.hard_kill_signal = firstStop.kill_requested ? firstStop.signal : null;
  recovery.hard_kill_exit_observed = firstStop.exit_observed;
  recovery.first_server_exit_observed = firstStop.exit_observed;
  result.cleanup.server_exit_observed = firstStop.exit_observed;
  const heldTurnId = result.turns.held?.id;
  const statusA = safeTurnStatus(session.observerA, heldTurnId);
  const statusB = safeTurnStatus(session.observerB, heldTurnId);
  result.turns.held.terminal_observed = ['completed', 'failed', 'interrupted'].includes(statusA)
    || ['completed', 'failed', 'interrupted'].includes(statusB);
  result.turns.held.status_a = statusA;
  result.turns.held.status_b = statusB;
  result.steer.terminal_status_a = statusA;
  result.steer.terminal_status_b = statusB;
  if (!firstStop.kill_requested || !firstStop.exit_observed || !recovery.fixture_gate_held_at_kill) {
    throw new NativeRecoveryError('held_turn_hard_kill_unconfirmed');
  }

  result.cleanup.client_a_closed = await closeConnection(session.connectionA);
  if (session.connectionB) result.cleanup.client_b_closed &&= await closeConnection(session.connectionB);
  session.connectionA = null;
  session.connectionB = null;
  session.clientA = null;
  session.clientB = null;

  session.fixture.release();
  recovery.fixture_released_after_exit = true;
  recovery.fixture_old_generation_drained = await waitForFixtureConnectionsToClose(
    session.fixture, Math.min(options.timeoutMs, 5000), dependencies,
  );
  if (!recovery.fixture_old_generation_drained) throw new NativeRecoveryError('fixture_old_generation_not_drained');
  recovery.fixture_generations.initial_server = collectFixtureSummary(session.fixture, initialRequests);
  const restartedRequestIndex = (session.fixture.requests || []).length;

  const oldToken = session.tokenFile.token;
  const oldTokenRemoved = removeCapabilityToken(output, session.tokenFile, fileSystem);
  result.cleanup.token_files_removed = oldTokenRemoved;
  session.tokenFile = null;
  if (!oldTokenRemoved) throw new NativeRecoveryError('old_capability_token_cleanup_failed');

  session.tokenFile = (dependencies.createCapabilityToken || createCapabilityToken)(output, fileSystem);
  session.tokenFiles.push(session.tokenFile);
  const restarted = await createAndStartServer({ executable, layout, tokenFile: session.tokenFile, dependencies,
    onOwnedServer: session.onOwnedServer });
  session.server = restarted.server;
  session.currentPort = restarted.port;
  result.cleanup.server_exit_observed = false;
  const observer = createRecoveryObserver();
  session.recoveryObserver = observer;
  session.recoveryPort = restarted.port;

  let currentConnection = await connectClient({ port: restarted.port, token: session.tokenFile.token,
    timeoutMs: options.timeoutMs, observer }, dependencies, session.server);
  session.recoveryConnection = currentConnection;
  const readTurnStartCount = countTurnStartRequests(currentConnection.client);
  const initialized = await initializeClient(currentConnection, layout.home, options.timeoutMs);
  result.clients.recovery_client_initialized = initialized.private_home_match;
  result.server_versions.recovery = initialized.version;
  if (!result.clients.recovery_client_initialized) throw new NativeRecoveryError('restarted_server_identity_mismatch');
  recovery.current_token_initialize_succeeded = true;

  recovery.old_token_error_kind = await probeLoopbackWebSocketAuthorization({
    port: restarted.port,
    token: oldToken,
    timeoutMs: Math.min(options.timeoutMs, 1500),
  }, dependencies);
  recovery.old_token_websocket_rejected = ['http_401', 'http_403'].includes(recovery.old_token_error_kind);

  recovery.read_before_resume = await readKnownThread(currentConnection.client, session.threadId);
  recovery.loaded_before_resume = await safeLoadedSnapshot(currentConnection.client, session.threadId);
  const resumed = await requestRpc(currentConnection.client, 'thread/resume', { threadId: session.threadId });
  recovery.resume_accepted = resumed.accepted;
  recovery.same_thread_id = resumed.accepted && safeUuid(resumed.result?.thread?.id) === session.threadId;
  if (resumed.accepted && recovery.same_thread_id) {
    result.settings.recovery_resume = projectSafeSettings(resumed.result, layout.repo);
    result.settings.recovery_preserved = settingsPreserved(result.settings.after_start, result.settings.recovery_resume);
    recovery.read_after_resume = await readKnownThread(currentConnection.client, session.threadId);
    recovery.loaded_after_resume = await safeLoadedSnapshot(currentConnection.client, session.threadId);
  }
  recovery.turn_started_notifications_after_restart = observer.summary().notification_counts['turn/started'] || 0;
  recovery.turn_start_rpc_count_after_restart = readTurnStartCount();
  recovery.metadata_restored_after_resume = Boolean(recovery.resume_accepted && recovery.same_thread_id
    && recovery.read_after_resume?.available === true && recovery.read_after_resume.thread_matches === true
    && recovery.loaded_after_resume?.available === true
    && recovery.loaded_after_resume.contains_thread === true);
  recovery.history_loaded_reconciled = recovery.metadata_restored_after_resume;
  const originalTurnStatus = safeTurnStatus(observer, heldTurnId);
  if (['inProgress', 'cancelling'].includes(originalTurnStatus)) {
    recovery.original_execution_continued_after_restart = true;
    recovery.turn_execution_resumed_after_restart = true;
  }
  recovery.probe_completed_after_restart = true;
  const restartedRequests = (session.fixture.requests || []).slice(restartedRequestIndex);
  recovery.fixture_generations.restarted_server = collectFixtureSummary(session.fixture, restartedRequests);
  result.observed.recovery = observer.summary();
}

async function safeLoadedSnapshot(client, threadId) {
  try {
    const snapshot = await readLoadedSnapshot(client, threadId);
    return { available: true, count: snapshot.count, contains_thread: snapshot.containsThread, truncated: snapshot.truncated };
  } catch (error) {
    return { available: false, count: 0, contains_thread: false, truncated: false, error_category: safeRpcCategory(error) };
  }
}

async function runApprovalMode(session) {
  const { result, fixture, options, observerA, observerB, clientA, threadId, dependencies } = session;
  fixture.setCallMode('approval');
  const start = await createStartedTurn(clientA, threadId, MARKERS.initial, 'initial', session.markerTargets, observerA);
  if (!start.accepted || !start.turnId) throw new NativeRecoveryError('approval_turn_start_failed');
  const observed = await waitUntil(() => observerA.summary().server_requests.approval > 0
    || observerB.summary().server_requests.approval > 0
    || observerA.summary().waiting_on_approval.seen || observerB.summary().waiting_on_approval.seen,
  options.timeoutMs, dependencies);
  const waitingA = observerA.summary().waiting_on_approval;
  const waitingB = observerB.summary().waiting_on_approval;
  result.approval.request_observed = observerA.summary().server_requests.approval > 0
    || observerB.summary().server_requests.approval > 0;
  result.approval.waiting_on_approval_seen = waitingA.seen || waitingB.seen;
  result.approval.waiting_on_approval_active_before_interrupt = waitingA.active || waitingB.active;
  const active = ['inProgress', 'cancelling'].includes(observerA.turnStatus(start.turnId));
  if (active) {
    const stopped = await requestRpc(clientA, 'turn/interrupt', { threadId, turnId: start.turnId });
    result.approval.interrupt_accepted = stopped.accepted;
  }
  fixture.release();
  const terminal = await waitForTurn([observerA, observerB], start.turnId, options.timeoutMs, dependencies);
  result.approval.terminal_observed = terminal;
  const waitingAfterTerminalA = observerA.summary().waiting_on_approval;
  const waitingAfterTerminalB = observerB.summary().waiting_on_approval;
  result.approval.waiting_on_approval_active = waitingAfterTerminalA.active || waitingAfterTerminalB.active;
  result.approval.waiting_on_approval_cleared = terminal
    && result.approval.waiting_on_approval_active_before_interrupt
    && !result.approval.waiting_on_approval_active;
  result.turns.approval = { ...turnRecord(start, [observerA, observerB], terminal),
    request_observed: result.approval.request_observed, waiting_observed: observed };
}

async function runCockpitMode(options, dependencies, result, output, fileSystem) {
  const childFactory = dependencies.createCockpitChild || createCockpitChild;
  const request = dependencies.requestCockpit || requestCockpit;
  const mkdir = (target) => fileSystem.mkdirSync(target, { recursive: false, mode: 0o700 });
  const paths = {
    outputDirectory: output,
    homeDir: path.join(output, 'cockpit-home'),
    claudeHome: path.join(output, 'claude-home'),
    userHome: path.join(output, 'user-home'),
  };
  result.cleanup.output_owned = true;
  for (const target of [paths.claudeHome, paths.userHome]) mkdir(target);
  const tokenName = 'x-cockpit-secret';
  const localOrigin = (port) => `http://127.0.0.1:${port}`;
  const headersOkay = (response) => Boolean(response && response.headers
    && response.headers['x-frame-options'] === 'DENY'
    && response.headers['content-security-policy'] === "frame-ancestors 'none'"
    && response.headers['cross-origin-resource-policy'] === 'same-origin'
    && response.headers['cross-origin-opener-policy'] === 'same-origin');
  const taskPath = `/api/sessions/${SYNTHETIC_SESSION_ID}/plan`;
  let firstChild = null;
  let secondChild = null;
  let firstCredentials = null;
  let secondCredentials = null;
  const childTimeout = Math.min(options.timeoutMs, 15000);
  const send = (credentials, port, pathname, body, extraHeaders = {}) => request({
    port,
    method: body === undefined ? 'GET' : 'POST',
    pathname,
    timeoutMs: Math.min(options.timeoutMs, 15000),
    ...(body === undefined ? {} : { body }),
    headers: { [tokenName]: credentials.secret, ...extraHeaders },
  }, dependencies);
  try {
      firstChild = childFactory(paths, dependencies);
    dependencies.registerOwnedCockpitChild?.(firstChild);
    firstCredentials = await firstChild.start(childTimeout);
    const taskWrite = await send(firstCredentials, firstCredentials.port, taskPath, {
      session_id: SYNTHETIC_SESSION_ID,
      id: SYNTHETIC_SESSION_ID,
      kind: 'tasks',
      tasks: FIXED_TASKS,
    });
    const decisionWrite = await send(firstCredentials, firstCredentials.port, taskPath, {
      session_id: SYNTHETIC_SESSION_ID,
      id: SYNTHETIC_SESSION_ID,
      kind: 'add_decision',
      ...FIXED_DECISION,
    });
    const awayWrite = await send(firstCredentials, firstCredentials.port, '/api/away', { enabled: true }, {
      'x-cockpit-secret': firstCredentials.uiSecret,
      origin: localOrigin(firstCredentials.port),
    });
    result.cockpit.task_written = taskWrite.status === 200
      && taskWrite.json?.tasks?.some((task) => task.title === FIXED_TASKS[0].title && task.state === 'doing') === true;
    result.cockpit.decision_written = decisionWrite.status === 200
      && decisionWrite.json?.decision?.title === FIXED_DECISION.title
      && decisionWrite.json?.decision?.state === 'waiting';
    result.cockpit.away_enabled = awayWrite.status === 200 && awayWrite.json?.enabled === true;
    result.cockpit.security_headers_observed = headersOkay(taskWrite) && headersOkay(decisionWrite) && headersOkay(awayWrite);
    const firstStop = await firstChild.stop(childTimeout);
    result.cockpit.first_child_exit_observed = firstStop.exit_observed === true;
    if (!firstStop.exit_observed) throw new NativeRecoveryError('cockpit_first_child_exit_unobserved');

    secondChild = childFactory(paths, dependencies);
    dependencies.registerOwnedCockpitChild?.(secondChild);
    secondCredentials = await secondChild.start(childTimeout);
    const oldHook = await send(firstCredentials, secondCredentials.port, taskPath, {
      session_id: SYNTHETIC_SESSION_ID, id: SYNTHETIC_SESSION_ID, kind: 'tasks', tasks: FIXED_TASKS,
    });
    const oldUi = await send(firstCredentials, secondCredentials.port, '/api/away', { enabled: true }, {
      'x-cockpit-secret': firstCredentials.uiSecret,
      origin: localOrigin(secondCredentials.port),
    });
    const context = await request({ port: secondCredentials.port, pathname: `/api/sessions/${SYNTHETIC_SESSION_ID}/context`,
      timeoutMs: Math.min(options.timeoutMs, 15000) }, dependencies);
    const away = await request({ port: secondCredentials.port, pathname: '/api/away',
      timeoutMs: Math.min(options.timeoutMs, 15000) }, dependencies);
    const tasks = Array.isArray(context.json?.tasks) ? context.json.tasks : [];
    const decisions = Array.isArray(context.json?.decisions) ? context.json.decisions : [];
    result.cockpit.task_persisted_after_restart = tasks.some((task) => task.title === FIXED_TASKS[0].title && task.state === 'doing');
    result.cockpit.decision_persisted_after_restart = decisions.some((decision) => decision.title === FIXED_DECISION.title
      && decision.state === 'waiting');
    result.cockpit.away_persisted_after_restart = away.status === 200 && away.json?.enabled === true;
    const currentHook = await send(secondCredentials, secondCredentials.port, taskPath, {
      session_id: SYNTHETIC_SESSION_ID, id: SYNTHETIC_SESSION_ID, kind: 'tasks', tasks: FIXED_TASKS,
    });
    const foreignOrigin = await send(secondCredentials, secondCredentials.port, '/api/away', { enabled: true }, {
      'x-cockpit-secret': secondCredentials.uiSecret,
      origin: 'https://foreign.invalid',
    });
    const currentUi = await send(secondCredentials, secondCredentials.port, '/api/away', { enabled: true }, {
      'x-cockpit-secret': secondCredentials.uiSecret,
      origin: localOrigin(secondCredentials.port),
    });
    result.cockpit.old_hook_secret_rejected = oldHook.status === 401;
    result.cockpit.old_ui_secret_rejected = oldUi.status === 401;
    result.cockpit.current_secret_accepted = currentHook.status === 200 && currentUi.status === 200;
    result.cockpit.foreign_origin_rejected = foreignOrigin.status === 403;
    result.cockpit.statuses = {
      old_hook: oldHook.status,
      old_ui: oldUi.status,
      current_hook: currentHook.status,
      current_ui: currentUi.status,
      foreign_origin: foreignOrigin.status,
    };
    result.cockpit.security_headers_observed &&= [oldHook, oldUi, currentHook, currentUi, foreignOrigin, context, away].every(headersOkay);
    result.cockpit.measurement_observed = result.cockpit.first_child_exit_observed
      && result.cockpit.second_child_exit_observed;
  } finally {
    let firstStop = { exit_observed: !firstChild };
    let secondStop = { exit_observed: !secondChild };
    if (firstChild && !result.cockpit.first_child_exit_observed) firstStop = await firstChild.stop(childTimeout);
    if (secondChild) secondStop = await secondChild.stop(childTimeout);
    result.cockpit.first_child_exit_observed ||= firstStop.exit_observed === true;
    result.cockpit.second_child_exit_observed = !secondChild || secondStop.exit_observed === true;
    result.cleanup.server_exit_observed = result.cockpit.first_child_exit_observed && result.cockpit.second_child_exit_observed;
    result.cleanup.fixture_closed = true;
    result.cleanup.private_config_restored = true;
    result.cleanup.private_config_removed = true;
    result.cleanup.token_files_removed = true;
    if (result.cleanup.server_exit_observed) {
      result.cleanup.private_home_removed = removeCockpitHomes(output, paths, fileSystem);
    } else {
      result.cleanup.private_home_removed = false;
    }
    result.cockpit.measurement_observed = result.cockpit.first_child_exit_observed
      && result.cockpit.second_child_exit_observed
      && Object.values(result.cockpit.statuses).every(Number.isInteger);
  }
}

function removeCockpitHomes(output, paths, fileSystem = fs) {
  const resolvedOutput = path.resolve(output);
  const targets = [paths.homeDir, paths.claudeHome, paths.userHome].map((target) => path.resolve(target));
  for (const target of targets) {
    if (path.dirname(target) !== resolvedOutput || !['cockpit-home', 'claude-home', 'user-home'].includes(path.basename(target))) return false;
  }
  let removed = true;
  for (const target of targets) {
    try {
      assertNoSymlinkComponents(resolvedOutput, target);
      const stat = fileSystem.lstatSync(target);
      if (!stat.isDirectory() || stat.isSymbolicLink()) { removed = false; continue; }
      fileSystem.rmSync(target, { recursive: true, force: false, maxRetries: 2, retryDelay: 100 });
      removed &&= !fileSystem.existsSync(target);
    } catch (error) {
      if (error.code !== 'ENOENT') removed = false;
    }
  }
  return removed;
}

async function closeFixture(fixture, options = {}) {
  if (!fixture) return true;
  if (options.release === false) {
    const server = fixture.server;
    if (!server || typeof server.close !== 'function') return false;
    try { server.closeAllConnections?.(); } catch {}
    if (!server.listening) return true;
    return Promise.race([
      new Promise((resolve) => server.close((error) => resolve(!error))),
      new Promise((resolve) => setTimeout(() => resolve(false), FIXTURE_CLOSE_TIMEOUT_MS)),
    ]);
  }
  try { fixture.release?.(); } catch {}
  const closed = await Promise.race([
    Promise.resolve().then(() => fixture.close()).then((value) => value !== false, () => false),
    new Promise((resolve) => setTimeout(() => resolve(false), FIXTURE_CLOSE_TIMEOUT_MS)),
  ]);
  if (closed) return true;
  try { fixture.server?.closeAllConnections?.(); } catch {}
  return false;
}

function cleanupComplete(result) {
  return result.cleanup.output_owned
    && result.cleanup.client_a_closed
    && result.cleanup.client_b_closed
    && result.cleanup.recovery_client_closed
    && result.cleanup.server_exit_observed
    && result.cleanup.fixture_closed
    && result.cleanup.fixture_drained
    && result.cleanup.fixture_released_after_servers_exit
    && result.cleanup.runtime_process_exit_observed
    && result.cleanup.private_config_removed
    && result.cleanup.token_files_removed
    && result.cleanup.private_home_removed;
}

function writeResultFile(output, result, fileSystem = fs) {
  const resultPath = path.join(output, 'native-result.json');
  assertNoSymlinkComponents(REPOSITORY_ROOT, resultPath);
  const contents = `${JSON.stringify(result, null, 2)}\n`;
  if (Buffer.byteLength(contents) > MAX_RESULT_BYTES || fileSystem.existsSync(resultPath)) return false;
  try {
    fileSystem.writeFileSync(resultPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

async function runNativeProbe(rawOptions, dependencies = {}) {
  let options;
  try {
    options = {
      ...rawOptions,
      timeoutMs: Number.isSafeInteger(rawOptions?.timeoutMs)
        ? rawOptions.timeoutMs : DEFAULT_TIMEOUT_MS,
      mode: ['recovery', 'approval', 'cockpit'].includes(rawOptions?.mode) ? rawOptions.mode : 'recovery',
      outputDirectory: rawOptions?.outputDirectory || DEFAULT_OUTPUT,
    };
    if (options.timeoutMs < 1000 || options.timeoutMs > MAX_TIMEOUT_MS) throw new NativeRecoveryError('invalid_timeout');
    if (options.mode !== rawOptions?.mode && rawOptions?.mode !== undefined) throw new NativeRecoveryError('invalid_mode');
  } catch (error) {
    return { ...makeResult({ mode: rawOptions?.mode || 'recovery' }), failure_stage: 'arguments',
      failure_code: safeErrorKind(error, 'invalid_arguments') };
  }
  const result = makeResult(options);
  const fileSystem = dependencies.fs || fs;
  const ownedServers = [];
  const ownedProcesses = [];
  const ownedCockpitChildren = new Set();
  const tokenFiles = [];
  let session = null;
  let fixture = null;
  let configSnapshot = null;
  let output = null;
  let layout = null;
  let outputOwned = false;
  let signalSeen = false;
  let currentStage = 'output_validation';
  const signalSource = dependencies.signalSource || process;
  const onSignal = () => {
    signalSeen = true;
    for (const server of ownedServers) {
      if (server && !server.state?.closed) {
        try { server.child.kill(); } catch {}
      }
    }
    for (const ownedProcess of ownedProcesses) {
      if (ownedProcess && !ownedProcess.state?.closed) {
        try { ownedProcess.child.kill(); } catch {}
      }
    }
    for (const child of ownedCockpitChildren) void child.stop(Math.min(options.timeoutMs, 15000));
  };
  signalSource.on('SIGINT', onSignal);
  signalSource.on('SIGTERM', onSignal);
  try {
    if (options.mode === 'cockpit') {
      currentStage = 'cockpit_output';
      output = validateOutputDirectory(options.outputDirectory, fileSystem);
      fileSystem.mkdirSync(output, { recursive: false, mode: 0o700 });
      outputOwned = true;
      result.output_directory = path.relative(REPOSITORY_ROOT, output).split(path.sep).join('/');
      result.cleanup.output_owned = true;
      const cockpitDependencies = {
        ...dependencies,
        registerOwnedCockpitChild: (child) => ownedCockpitChildren.add(child),
      };
      currentStage = 'cockpit_measurement';
      await runCockpitMode(options, cockpitDependencies, result, output, fileSystem);
    } else {
      currentStage = 'workspace_setup';
      const workspace = await prepareNativeWorkspace(options, dependencies, fileSystem, (ownedOutput) => {
        output = ownedOutput;
        layout = { output, home: path.join(output, 'home'), repo: path.join(output, 'repo') };
        outputOwned = true;
        result.output_directory = path.relative(REPOSITORY_ROOT, output).split(path.sep).join('/');
        result.cleanup.output_owned = true;
      });
      ({ output, layout } = workspace);
      const executable = workspace.executable;
      currentStage = 'fixture_start';
      const createFixture = dependencies.createFixture || createNativeInstructionFixture;
      fixture = createFixture({ callMode: 'final', gateCount: 0, timeoutMs: options.timeoutMs, workdir: layout.repo });
      await fixture.start();
      currentStage = 'native_version_check';
      const readVersion = dependencies.readCodexVersion || dependencies.runVersionCheck || readCodexVersion;
      const version = await readVersion(executable, layout.home, {
        cwd: layout.repo,
        timeoutMs: Math.min(options.timeoutMs, 15000),
        spawn: dependencies.spawn,
        environment: dependencies.environment,
        onOwnedChild: (ownedProcess) => ownedProcesses.push(ownedProcess),
      });
      result.target_version = version.version;
      currentStage = 'private_config';
      configSnapshot = (dependencies.writePrivateConfig || writePrivateConfig)(layout, fixture, fileSystem);
      currentStage = 'server_start';
      const tokenFile = (dependencies.createCapabilityToken || createCapabilityToken)(output, fileSystem);
      tokenFiles.push(tokenFile);
      session = {
        options, dependencies, result, output, layout, executable, fileSystem,
        fixture, tokenFile, tokenFiles, configSnapshot, server: null,
        onOwnedServer: (server) => ownedServers.push(server),
        connectionA: null, connectionB: null, clientA: null, clientB: null,
        observerA: createRecoveryObserver(), observerB: createRecoveryObserver(),
        markerProjection: createNativeMarkerProjection(), markerTargets: null, threadId: null,
        timeoutMs: options.timeoutMs,
      };
      const first = await createAndStartServer({ executable, layout, tokenFile, dependencies,
        onOwnedServer: session.onOwnedServer });
      session.currentPort = first.port;
      session.server = first.server;
      result.cleanup.server_exit_observed = false;
      currentStage = 'client_a_connect';
      session.connectionA = await connectClient({ port: first.port, token: tokenFile.token,
        timeoutMs: options.timeoutMs, observer: session.observerA }, dependencies, first.server);
      session.clientA = session.connectionA.client;
      const initializedA = await initializeClient(session.connectionA, layout.home, options.timeoutMs);
      result.clients.a_initialized = initializedA.private_home_match;
      result.server_versions.a = initializedA.version;
      if (!result.clients.a_initialized) throw new NativeRecoveryError('private_app_server_identity_mismatch');
      currentStage = 'client_b_connect';
      session.connectionB = await connectClient({ port: first.port, token: tokenFile.token,
        timeoutMs: options.timeoutMs, observer: session.observerB }, dependencies, first.server);
      session.clientB = session.connectionB.client;
      const initializedB = await initializeClient(session.connectionB, layout.home, options.timeoutMs);
      result.clients.b_initialized = initializedB.private_home_match;
      result.server_versions.b = initializedB.version;
      if (!result.clients.b_initialized) throw new NativeRecoveryError('second_client_identity_mismatch');
      currentStage = 'thread_start';
      const startThread = await requestRpc(session.clientA, 'thread/start', {
        cwd: layout.repo,
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
        ephemeral: false,
      });
      session.threadId = safeUuid(startThread.result?.thread?.id);
      if (!startThread.accepted || !session.threadId) throw new NativeRecoveryError('thread_start_failed');
      result.thread.id = session.threadId;
      result.thread.started = true;
      result.settings.after_start = projectSafeSettings(startThread.result, layout.repo);
      session.markerTargets = createMarkerTargets(session.threadId, session.markerProjection);
      installClientMarkerObserver(session.clientA, session.markerProjection, session.markerTargets);
      currentStage = 'warmup_turn';
      await runWarmup(session);
      result.thread.read_after_warmup = await readKnownThread(session.clientA, session.threadId);
      currentStage = 'initial_thread_resume';
      const initialResume = await requestRpc(session.clientB, 'thread/resume', { threadId: session.threadId });
      result.thread.initial_resume_rpc_code = initialResume.rpc_code;
      result.thread.initial_resume_error_category = initialResume.error_category;
      result.thread.initial_resume_same_id = initialResume.accepted
        && safeUuid(initialResume.result?.thread?.id) === session.threadId;
      if (initialResume.accepted) {
        result.settings.initial_resume = projectSafeSettings(initialResume.result, layout.repo);
        result.settings.start_resume_match = settingsPreserved(result.settings.after_start, result.settings.initial_resume);
      }
      if (!result.thread.initial_resume_same_id) throw new NativeRecoveryError('initial_thread_resume_failed');
      currentStage = 'client_b_reconnect';
      result.clients.b_reconnected = await closeConnection(session.connectionB);
      session.connectionB = await connectClient({ port: first.port, token: tokenFile.token,
        timeoutMs: options.timeoutMs, observer: session.observerB }, dependencies, first.server);
      session.clientB = session.connectionB.client;
      const initializedBAgain = await initializeClient(session.connectionB, layout.home, options.timeoutMs);
      result.server_versions.b = initializedBAgain.version;
      result.clients.b_reconnected &&= initializedBAgain.private_home_match;
      const reconnectResume = await requestRpc(session.clientB, 'thread/resume', { threadId: session.threadId });
      result.clients.b_reconnected &&= reconnectResume.accepted
        && safeUuid(reconnectResume.result?.thread?.id) === session.threadId;
      if (options.mode === 'recovery') {
        currentStage = 'held_steer';
        await runRecoveryMode(session);
      } else {
        currentStage = 'approval_wait';
        await runApprovalMode(session);
      }
    }
  } catch (error) {
    result.failure_stage = currentStage;
    result.failure_code = safeErrorKind(error, 'native_probe_failed');
  } finally {
    if (session) {
      if (session.connectionA) result.cleanup.client_a_closed &&= await closeConnection(session.connectionA);
      if (session.connectionB) result.cleanup.client_b_closed &&= await closeConnection(session.connectionB);
      if (session.recoveryConnection) result.cleanup.recovery_client_closed &&= await closeConnection(session.recoveryConnection);
      result.observed.a = session.observerA.summary();
      result.observed.b = session.observerB.summary();
      result.observed.recovery = session.recoveryObserver?.summary() || null;
    }
    let cockpitChildrenExited = true;
    for (const child of ownedCockpitChildren) {
      if (child.closed) continue;
      try {
        const stopped = await child.stop(Math.min(options.timeoutMs, 15000));
        cockpitChildrenExited &&= stopped?.exit_observed === true;
      } catch {
        cockpitChildrenExited = false;
      }
    }
    let nativeServersExited = true;
    for (const server of [...ownedServers].reverse()) {
      const stopped = await stopOwnedServer(server);
      nativeServersExited &&= stopped.exit_observed === true;
    }
    let runtimeProcessesExited = true;
    for (const ownedProcess of [...ownedProcesses].reverse()) {
      const stopped = await stopOwnedProcess(ownedProcess);
      runtimeProcessesExited &&= stopped.exit_observed === true;
    }
    if (ownedServers.length > 0) result.cleanup.server_exit_observed = nativeServersExited;
    else if (options.mode === 'cockpit') result.cleanup.server_exit_observed = cockpitChildrenExited;
    result.cleanup.runtime_process_exit_observed = runtimeProcessesExited;
    if (fixture) {
      const safeToReleaseFixture = nativeServersExited && runtimeProcessesExited;
      result.cleanup.fixture_released_after_servers_exit = safeToReleaseFixture;
      if (safeToReleaseFixture) {
        try { fixture.release?.(); } catch {}
        result.cleanup.fixture_drained = await waitForFixtureConnectionsToClose(
          fixture, Math.min(options.timeoutMs, 5000), dependencies,
        );
      } else {
        result.cleanup.fixture_drained = false;
      }
      result.cleanup.fixture_closed = await closeFixture(fixture, { release: safeToReleaseFixture });
      result.fixture = collectFixtureSummary(fixture);
    }
    if (options.mode === 'cockpit') {
      result.cleanup.private_config_restored = true;
      result.cleanup.private_config_removed = true;
      result.cleanup.token_files_removed = true;
      const cockpitPaths = {
        homeDir: path.join(output || '', 'cockpit-home'),
        claudeHome: path.join(output || '', 'claude-home'),
        userHome: path.join(output || '', 'user-home'),
      };
      result.cleanup.private_home_removed = cockpitChildrenExited && output
        ? removeCockpitHomes(output, cockpitPaths, fileSystem)
        : false;
    } else if (nativeServersExited && runtimeProcessesExited) {
      result.cleanup.private_config_restored = configSnapshot
        ? restorePrivateConfig(configSnapshot, fileSystem)
        : true;
      result.cleanup.token_files_removed = tokenFiles
        .map((tokenFile) => removeCapabilityToken(output, tokenFile, fileSystem))
        .every(Boolean);
      result.cleanup.private_home_removed = layout?.home
        ? removePrivateHome(output, layout.home, fileSystem)
        : !outputOwned;
      const configPath = layout?.home ? path.join(layout.home, 'config.toml') : null;
      result.cleanup.private_config_removed = !configPath || !fileSystem.existsSync(configPath);
    } else {
      result.cleanup.private_config_restored = false;
      result.cleanup.private_config_removed = false;
      result.cleanup.token_files_removed = false;
      result.cleanup.private_home_removed = false;
    }
    if (signalSeen && !result.failure_code) {
      result.failure_stage = currentStage;
      result.failure_code = 'signal_received';
    }
    result.cleanup.output_owned = outputOwned;
    result.measurement_success = calculateMeasurementSuccess(result);
    result.metadata_recovery_success = options.mode === 'recovery'
      ? calculateMetadataRecoverySuccess(result)
      : null;
    result.recovery_success = calculateRecoverySuccess(result);
    result.approval_state_observed = options.mode === 'approval'
      ? result.approval.request_observed && result.approval.waiting_on_approval_seen
      : null;
    result.cockpit_persistence_success = options.mode === 'cockpit'
      ? Boolean(result.cockpit?.task_persisted_after_restart && result.cockpit?.decision_persisted_after_restart
        && result.cockpit?.away_persisted_after_restart && result.cockpit?.old_hook_secret_rejected
        && result.cockpit?.old_ui_secret_rejected && result.cockpit?.current_secret_accepted
        && result.cockpit?.foreign_origin_rejected && result.cockpit?.security_headers_observed)
      : null;
    result.feature_flow_success = calculateFeatureFlowSuccess(result);
    const cleanupOk = cleanupComplete(result);
    result.success = result.measurement_success && cleanupOk && !result.failure_code;
    if (!result.success && !result.failure_code) result.failure_code = cleanupOk ? 'measurement_incomplete' : 'cleanup_incomplete';
    if (typeof signalSource.off === 'function') {
      signalSource.off('SIGINT', onSignal);
      signalSource.off('SIGTERM', onSignal);
    } else if (typeof signalSource.removeListener === 'function') {
      signalSource.removeListener('SIGINT', onSignal);
      signalSource.removeListener('SIGTERM', onSignal);
    }
    if (outputOwned && output) {
      result.cleanup.result_written = true;
      const saved = writeResultFile(output, result, fileSystem);
      result.cleanup.result_written = saved;
      if (saved) result.result_file = path.relative(REPOSITORY_ROOT, path.join(output, 'native-result.json')).split(path.sep).join('/');
      else {
        result.success = false;
        result.failure_code = result.failure_code || 'result_write_failed';
      }
    }
  }
  return result;
}

async function main(argv) {
  let options;
  try { options = parseArguments(argv); } catch (error) {
    process.stderr.write(`${JSON.stringify({ ok: false, error: safeErrorKind(error, 'invalid_arguments') })}\n`);
    process.exitCode = 2;
    return;
  }
  const result = await runNativeProbe(options);
  process.stdout.write(`${JSON.stringify({ success: result.success, measurement_success: result.measurement_success,
    recovery_success: result.recovery_success, cockpit_persistence_success: result.cockpit_persistence_success,
    result_file: result.result_file || null, failure_stage: result.failure_stage, failure_code: result.failure_code })}\n`);
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
  NativeRecoveryError,
  calculateFeatureFlowSuccess,
  calculateMetadataRecoverySuccess,
  calculateMeasurementSuccess,
  calculateRecoverySuccess,
  collectFixtureSummary,
  createCapabilityToken,
  createRecoveryObserver,
  makeResult,
  parseArguments,
  prepareWorkspace,
  removeCapabilityToken,
  removeCockpitHomes,
  removePrivateHome,
  restorePrivateConfig,
  runCockpitMode,
  runNativeProbe,
  safeErrorKind,
  stopOwnedServer,
  validateExecutable,
  validateOutputDirectory,
  writePrivateConfig,
  writeResultFile,
};
