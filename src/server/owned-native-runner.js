'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');

const PROFILE = 'cockpit-native-v1';
const ENVIRONMENT_ALLOWLIST = Object.freeze(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC']);
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_LINES = 100_000;
const DEFAULT_TIMEOUTS = Object.freeze({ startupMs: 15_000, rpcMs: 10_000, loginMs: 5 * 60_000, stopMs: 2_000 });
const MAX_TIMEOUT_MS = 60_000;
const MAX_LOGIN_TIMEOUT_MS = 15 * 60_000;
const REQUIRED_HOME_DIRECTORIES = Object.freeze([
  Object.freeze(['AppData', 'Roaming']),
  Object.freeze(['AppData', 'Local']),
  Object.freeze(['tmp']),
  Object.freeze(['.config']),
  Object.freeze(['.local', 'share']),
  Object.freeze(['.cache']),
]);
const CODEX_HOME_DIRECTORY = Object.freeze(['.codex']);

class OwnedNativeRunnerError extends Error {
  constructor(code) {
    super('owned native runner operation failed');
    this.name = 'OwnedNativeRunnerError';
    this.code = code;
  }
}

function runnerError(code) {
  return new OwnedNativeRunnerError(code);
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(value, keys, code) {
  if (!isRecord(value) || Object.keys(value).some((key) => !keys.includes(key))) throw runnerError(code);
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) && !value.startsWith('-');
}

function isSecretValue(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 16 * 1024 &&
    !/[\u0000\r\n]/.test(value);
}

function validateAuthenticationUrl(value) {
  if (typeof value !== 'string' || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw runnerError('authentication_response_invalid');
  }
  let parsed;
  try { parsed = new URL(value); } catch { throw runnerError('authentication_response_invalid'); }
  if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) {
    throw runnerError('authentication_response_invalid');
  }
  return value;
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function ensureIsolatedHomeDirectories(homePath, provider) {
  const requiredDirectories = provider === 'codex'
    ? [...REQUIRED_HOME_DIRECTORIES, CODEX_HOME_DIRECTORY]
    : REQUIRED_HOME_DIRECTORIES;
  for (const parts of requiredDirectories) {
    let current = homePath;
    for (const part of parts) {
      current = path.join(current, part);
      const relative = path.relative(homePath, current);
      if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw runnerError('isolated_directory_unsafe');
      }
      let stat;
      try {
        stat = fs.lstatSync(current);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw runnerError('isolated_directory_unavailable');
        try {
          fs.mkdirSync(current);
        } catch (createError) {
          if (createError?.code !== 'EEXIST') throw runnerError('isolated_directory_unavailable');
        }
        try {
          stat = fs.lstatSync(current);
        } catch {
          throw runnerError('isolated_directory_unavailable');
        }
      }
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw runnerError('isolated_directory_unsafe');
      let realPath;
      try {
        realPath = fs.realpathSync.native(current);
      } catch {
        throw runnerError('isolated_directory_unavailable');
      }
      if (normalizedPath(realPath) !== normalizedPath(current)) throw runnerError('isolated_directory_unsafe');
    }
  }
}

function validateDirectory(value, code) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw runnerError(code);
  const resolved = path.resolve(value);
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw runnerError(code);
    if (normalizedPath(fs.realpathSync.native(resolved)) !== normalizedPath(resolved)) throw runnerError(code);
  } catch (error) {
    if (error instanceof OwnedNativeRunnerError) throw error;
    throw runnerError(code);
  }
  return resolved;
}

function validateExecutable(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw runnerError('absolute_executable_required');
  const resolved = path.resolve(value);
  try {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) throw runnerError('executable_unavailable');
  } catch (error) {
    if (error instanceof OwnedNativeRunnerError) throw error;
    throw runnerError('executable_unavailable');
  }
  return resolved;
}

function normalizeTimeouts(value) {
  const result = { ...DEFAULT_TIMEOUTS };
  if (value !== undefined) {
    assertOnlyKeys(value, Object.keys(DEFAULT_TIMEOUTS), 'invalid_timeouts');
    for (const [key, timeout] of Object.entries(value)) {
      const maximum = key === 'loginMs' ? MAX_LOGIN_TIMEOUT_MS : MAX_TIMEOUT_MS;
      if (!Number.isInteger(timeout) || timeout < 50 || timeout > maximum) throw runnerError('invalid_timeouts');
      result[key] = timeout;
    }
  }
  return Object.freeze(result);
}

function makeEnvironment(provider, homePath, oauthToken) {
  const environment = {};
  for (const key of ENVIRONMENT_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0 && !/[\u0000]/.test(value)) environment[key] = value;
  }
  const tempPath = path.join(homePath, 'tmp');
  Object.assign(environment, {
    HOME: homePath,
    USERPROFILE: homePath,
    APPDATA: path.join(homePath, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(homePath, 'AppData', 'Local'),
    TMP: tempPath,
    TEMP: tempPath,
    TMPDIR: tempPath,
    XDG_CONFIG_HOME: path.join(homePath, '.config'),
    XDG_DATA_HOME: path.join(homePath, '.local', 'share'),
    XDG_CACHE_HOME: path.join(homePath, '.cache'),
  });
  if (process.platform === 'win32') {
    environment.HOMEDRIVE = path.parse(homePath).root.replace(/[\\/]$/, '');
    environment.HOMEPATH = path.relative(path.parse(homePath).root, homePath);
  }
  if (provider === 'codex') environment.CODEX_HOME = path.join(homePath, '.codex');
  if (provider === 'claude') {
    environment.CLAUDE_CONFIG_DIR = homePath;
    environment.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;
  }
  return environment;
}

function buildArguments(provider) {
  if (provider === 'codex') {
    return [
      'app-server', '--listen', 'stdio://',
      '-c', 'cli_auth_credentials_store="ephemeral"',
      '-c', 'features.shell_tool=false',
      '-c', 'features.unified_exec=false',
      '-c', 'features.multi_agent=false',
      '-c', 'features.apps=false',
      '-c', 'features.hooks=false',
      '-c', 'features.skill_mcp_dependency_install=false',
      '-c', 'features.daemon_auto_start=false',
      '-c', 'features.browser_use=false',
      '-c', 'features.browser_use_external=false',
      '-c', 'features.browser_use_full_cdp_access=false',
      '-c', 'features.computer_use=false',
      '-c', 'features.image_generation=false',
      '-c', 'features.plugins=false',
      '-c', 'features.remote_plugin=false',
      '-c', 'features.workspace_dependencies=false',
      '-c', 'web_search="disabled"',
    ];
  }
  return [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
    '--include-partial-messages', '--no-session-persistence', '--setting-sources', '',
    '--strict-mcp-config', '--tools', '', '--settings', '{"disableAllHooks":true}',
  ];
}

function createOwnedNativeRunner(options) {
  assertOnlyKeys(options, [
    'provider', 'executablePath', 'hostId', 'homeScopeId', 'homePath', 'cwd', 'profile',
    'getAuthentication', 'onAuthenticationRequired', 'isCurrent', 'spawnImpl', 'timeouts', 'onNative', 'onDisconnect',
  ], 'invalid_configuration');
  if (options.provider !== 'codex' && options.provider !== 'claude') throw runnerError('invalid_provider');
  if (options.profile !== PROFILE) throw runnerError('invalid_profile');
  if (!isIdentifier(options.hostId) || !isIdentifier(options.homeScopeId)) throw runnerError('invalid_scope');
  if (typeof options.onNative !== 'function' ||
      (options.onDisconnect !== undefined && typeof options.onDisconnect !== 'function')) {
    throw runnerError('invalid_callbacks');
  }
  if (options.provider === 'claude' && typeof options.getAuthentication !== 'function') {
    throw runnerError('invalid_callbacks');
  }
  if (options.provider === 'codex' && typeof options.onAuthenticationRequired !== 'function') {
    throw runnerError('invalid_authentication_prompt');
  }
  if (options.isCurrent !== undefined && typeof options.isCurrent !== 'function') throw runnerError('invalid_current_callback');
  if (options.onAuthenticationRequired !== undefined && options.provider !== 'codex') {
    throw runnerError('invalid_authentication_prompt');
  }

  const executablePath = validateExecutable(options.executablePath);
  const homePath = validateDirectory(options.homePath, 'invalid_isolated_home');
  const cwd = validateDirectory(options.cwd, 'invalid_working_directory');
  const ordinaryHomes = [os.homedir(), process.env.HOME, process.env.USERPROFILE]
    .filter((candidate) => typeof candidate === 'string' && path.isAbsolute(candidate))
    .map(normalizedPath);
  if (ordinaryHomes.includes(normalizedPath(homePath))) throw runnerError('ordinary_home_forbidden');

  const provider = options.provider;
  const hostId = options.hostId;
  const homeScopeId = options.homeScopeId;
  const getAuthentication = options.getAuthentication;
  const onAuthenticationRequired = options.onAuthenticationRequired;
  const isOwnerCurrent = options.isCurrent || (() => true);
  const spawnImpl = options.spawnImpl === undefined ? spawn : options.spawnImpl;
  if (typeof spawnImpl !== 'function') throw runnerError('invalid_spawn_adapter');
  const timeouts = normalizeTimeouts(options.timeouts);

  let state = 'idle';
  let generation = 0;
  let startPromise = null;
  let stopPromise = null;
  let child = null;
  let childExited = false;
  let childClosed = false;
  let childSpawned = false;
  let childTerminationResolve = null;
  let childTerminationPromise = null;
  let childStopPromise = null;
  let stateBeforeStopUnconfirmed = null;
  let failureBeforeStopUnconfirmed = null;
  let stdoutBuffer = Buffer.alloc(0);
  let lineCount = 0;
  let ignoredMessageCount = 0;
  let pendingRpc = null;
  let nextRpcId = 1;
  let nativeIdentity = null;
  let nativeContext = null;
  let terminalContextId = null;
  let turnStartPending = false;
  let earlyTurnCompletion = null;
  let activeLogin = null;
  let terminalContextCount = 0;
  let loginPromptCount = 0;
  let disconnectNotified = false;
  let failureCode = null;
  let authCapability = provider === 'codex' ? 'managed_chatgpt_login' : 'claude_oauth_environment';
  const cancellations = new Set();
  let resolveContext = null;
  const contextReady = new Promise((resolve) => { resolveContext = resolve; });
  contextReady.catch(() => {});

  function safeSnapshot() {
    return Object.freeze({
      provider,
      state,
      authCapability,
      childExited,
      childClosed,
      ownedChildActive: Boolean(child && !childExited && !childClosed),
      lineCount,
      ignoredMessageCount,
      pendingRpcCount: pendingRpc ? 1 : 0,
      contextState: terminalContextId ? 'ended' : nativeContext ? 'active' : 'none',
      terminalContextCount,
      loginPromptCount,
      failureCode,
    });
  }

  function isCurrent(expectedGeneration) {
    return generation === expectedGeneration && state !== 'stopping' && state !== 'stopped' && state !== 'failed';
  }

  function requireCurrent(expectedGeneration) {
    if (!isCurrent(expectedGeneration)) throw runnerError('operation_stopped');
  }

  function requireOwnerCurrent(expectedGeneration) {
    requireCurrent(expectedGeneration);
    let result;
    try { result = isOwnerCurrent(); } catch { throw runnerError('authority_expired'); }
    if (result !== true) {
      try {
        if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
      } catch {}
      throw runnerError('authority_expired');
    }
    requireCurrent(expectedGeneration);
  }

  function awaitCurrent(value, expectedGeneration, timeoutMs, timeoutCode) {
    return new Promise((resolve, reject) => {
      let settled = false;
      let timer = null;
      const finish = (callback, result) => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        cancellations.delete(cancel);
        callback(result);
      };
      const cancel = () => finish(reject, runnerError('operation_stopped'));
      if (!isCurrent(expectedGeneration)) {
        finish(reject, runnerError('operation_stopped'));
        return;
      }
      cancellations.add(cancel);
      timer = setTimeout(() => finish(reject, runnerError(timeoutCode)), timeoutMs);
      Promise.resolve(value).then(
        (result) => {
          if (!isCurrent(expectedGeneration)) finish(reject, runnerError('operation_stopped'));
          else {
            try {
              requireOwnerCurrent(expectedGeneration);
              finish(resolve, result);
            } catch (error) {
              finish(reject, error instanceof OwnedNativeRunnerError ? error : runnerError('authority_expired'));
            }
          }
        },
        () => finish(reject, runnerError('operation_failed')),
      );
    });
  }

  function cancelCurrentOperations() {
    for (const cancel of [...cancellations]) cancel();
  }

  function reportDisconnect(code) {
    if (disconnectNotified || !childSpawned || typeof options.onDisconnect !== 'function') return;
    disconnectNotified = true;
    try {
      options.onDisconnect(Object.freeze({ provider, reason: code }));
    } catch {}
  }

  function clearActiveLogin(code) {
    const attempt = activeLogin;
    activeLogin = null;
    if (attempt && !attempt.settled) {
      attempt.settled = true;
      attempt.reject(runnerError(code));
    }
  }

  function stopChild(childToStop) {
    if (!childToStop || childExited || childClosed) return Promise.resolve(true);
    if (childStopPromise) return childStopPromise;
    try { childToStop.stdin.end(); } catch {}
    try { childToStop.kill(); } catch {}
    const operation = new Promise((resolve) => {
      let settled = false;
      let timer;
      const finish = (confirmed) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(confirmed);
      };
      timer = setTimeout(() => {
        if (!childExited && !childClosed) {
          try { childToStop.kill('SIGKILL'); } catch {}
        }
        const confirmed = childExited || childClosed;
        if (!confirmed && (state === 'stopping' || state === 'failed')) {
          stateBeforeStopUnconfirmed = state;
          failureBeforeStopUnconfirmed = failureCode;
          state = 'stop_unconfirmed';
          failureCode = 'stop_unconfirmed';
        }
        finish(confirmed);
      }, timeouts.stopMs);
      if (childTerminationPromise) childTerminationPromise.then(() => finish(true), () => finish(false));
      else finish(false);
    });
    childStopPromise = operation;
    operation.then(() => {
      if (childStopPromise === operation) childStopPromise = null;
    });
    return operation;
  }

  function restoreStateAfterLateTermination() {
    if (state !== 'stop_unconfirmed') return;
    state = stateBeforeStopUnconfirmed === 'stopping' ? 'stopped' : stateBeforeStopUnconfirmed || 'failed';
    failureCode = failureBeforeStopUnconfirmed;
    stateBeforeStopUnconfirmed = null;
    failureBeforeStopUnconfirmed = null;
  }

  function fail(code) {
    if (state === 'failed' || state === 'stopped' || state === 'stopping') return;
    failureCode = code;
    state = 'failed';
    generation += 1;
    cancelCurrentOperations();
    if (pendingRpc) {
      const pending = pendingRpc;
      pendingRpc = null;
      pending.reject(runnerError(code));
    }
    clearActiveLogin(code);
    reportDisconnect(code);
    stopChild(child).catch(() => {});
  }

  function notifyNative(event) {
    try {
      const result = options.onNative(event);
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw runnerError('async_native_callback_unsupported');
      }
    } catch (error) {
      if (error instanceof OwnedNativeRunnerError) throw error;
      throw runnerError('native_callback_failed');
    }
  }

  function emitIdentity(nativeId) {
    if (!isIdentifier(nativeId)) throw runnerError('native_identity_invalid');
    if (nativeIdentity) {
      if (nativeIdentity.nativeId !== nativeId) throw runnerError('native_identity_conflict');
      return;
    }
    requireOwnerCurrent(generation);
    const identity = Object.freeze({
      provider,
      nativeIdKind: provider === 'codex' ? 'thread' : 'session',
      hostId,
      homeScopeId,
      nativeId,
    });
    nativeIdentity = identity;
    notifyNative(Object.freeze({ type: 'identity', provider, identity }));
  }

  function emitContext(nativeContextId) {
    if (!isIdentifier(nativeContextId)) throw runnerError('native_context_invalid');
    if (!nativeIdentity) throw runnerError('native_event_order_invalid');
    if (terminalContextId) throw runnerError('native_context_after_terminal');
    if (nativeContext) {
      if (nativeContext.nativeContextId !== nativeContextId) throw runnerError('native_context_conflict');
      return;
    }
    requireOwnerCurrent(generation);
    const context = Object.freeze({
      kind: provider === 'codex' ? 'turn' : 'assistant_message',
      nativeContextId,
      parentToolUseId: null,
    });
    nativeContext = context;
    notifyNative(Object.freeze({ type: 'context', provider, identity: nativeIdentity, context }));
    if (resolveContext) resolveContext();
  }

  function emitContextEnded(nativeContextId) {
    if (!nativeIdentity || !isIdentifier(nativeContextId)) throw runnerError('native_context_terminal_invalid');
    if (terminalContextId) {
      if (terminalContextId !== nativeContextId) throw runnerError('native_context_conflict');
      throw runnerError('native_context_terminal_duplicate');
    }
    if (nativeContext && nativeContext.nativeContextId !== nativeContextId) throw runnerError('native_context_conflict');
    requireOwnerCurrent(generation);
    terminalContextId = nativeContextId;
    terminalContextCount = 1;
    const context = Object.freeze({
      kind: provider === 'codex' ? 'turn' : 'assistant_message',
      nativeContextId,
    });
    notifyNative(Object.freeze({ type: 'context_ended', provider, identity: nativeIdentity, context }));
  }

  function createLoginAttempt() {
    let resolve;
    let reject;
    const completion = new Promise((resolvePromise, rejectPromise) => {
      resolve = resolvePromise;
      reject = rejectPromise;
    });
    completion.catch(() => {});
    return { loginId: null, earlyCompletion: null, completionSeen: false, settled: false, completion, resolve, reject };
  }

  function handleLoginCompleted(params) {
    if (!isRecord(params) || !isIdentifier(params.loginId) || typeof params.success !== 'boolean' || !activeLogin) {
      throw runnerError('authentication_notification_invalid');
    }
    const completed = Object.freeze({ loginId: params.loginId, success: params.success });
    if (activeLogin.loginId === null) {
      if (activeLogin.earlyCompletion) throw runnerError('authentication_notification_duplicate');
      activeLogin.earlyCompletion = completed;
      return;
    }
    if (completed.loginId !== activeLogin.loginId) throw runnerError('authentication_login_mismatch');
    if (activeLogin.completionSeen) throw runnerError('authentication_notification_duplicate');
    activeLogin.completionSeen = true;
    if (!completed.success) throw runnerError('authentication_rejected');
    activeLogin.settled = true;
    activeLogin.resolve(completed);
  }

  function reconcileEarlyLogin(attempt, loginId) {
    attempt.loginId = loginId;
    if (!attempt.earlyCompletion) return;
    if (attempt.earlyCompletion.loginId !== loginId) throw runnerError('authentication_login_mismatch');
    attempt.completionSeen = true;
    if (!attempt.earlyCompletion.success) throw runnerError('authentication_rejected');
    attempt.settled = true;
    attempt.resolve(attempt.earlyCompletion);
  }

  function requestAuthenticationPrompt(loginId, authUrl, expectedGeneration) {
    requireOwnerCurrent(expectedGeneration);
    if (loginPromptCount !== 0) throw runnerError('authentication_prompt_duplicate');
    loginPromptCount = 1;
    let result;
    try {
      result = onAuthenticationRequired(Object.freeze({ loginId, authUrl }));
    } catch {
      throw runnerError('authentication_prompt_failed');
    }
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch(() => {
        if (isCurrent(expectedGeneration)) fail('authentication_prompt_failed');
      });
    }
    requireOwnerCurrent(expectedGeneration);
  }

  function handleTurnCompleted(params) {
    if (!isRecord(params) || !isIdentifier(params.threadId) || !isRecord(params.turn) ||
        !isIdentifier(params.turn.id) || !nativeIdentity || params.threadId !== nativeIdentity.nativeId) {
      throw runnerError('codex_turn_completion_invalid');
    }
    const completed = Object.freeze({ threadId: params.threadId, turnId: params.turn.id });
    if (turnStartPending) {
      if (earlyTurnCompletion) throw runnerError('codex_turn_completion_duplicate');
      earlyTurnCompletion = completed;
      return;
    }
    if (!nativeContext || nativeContext.nativeContextId !== completed.turnId) {
      throw runnerError('native_context_conflict');
    }
    emitContextEnded(completed.turnId);
  }

  function writeLine(line, expectedGeneration) {
    requireOwnerCurrent(expectedGeneration);
    if (!child || !child.stdin || typeof child.stdin.write !== 'function') throw runnerError('stdin_unavailable');
    return awaitCurrent(new Promise((resolve, reject) => {
      try {
        child.stdin.write(line + '\n', (error) => {
          if (error) reject(runnerError('stdin_write_failed'));
          else resolve();
        });
      } catch {
        reject(runnerError('stdin_write_failed'));
      }
    }), expectedGeneration, timeouts.rpcMs, 'stdin_write_timeout');
  }

  function sendRpc(method, params, expectedGeneration) {
    requireCurrent(expectedGeneration);
    if (pendingRpc) throw runnerError('rpc_overlap');
    const id = nextRpcId;
    nextRpcId += 1;
    let resolveResponse;
    let rejectResponse;
    const response = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    response.catch(() => {});
    pendingRpc = { id, resolve: resolveResponse, reject: rejectResponse };
    const write = writeLine(JSON.stringify({ jsonrpc: '2.0', id, method, params }), expectedGeneration);
    return (async () => {
      try {
        await write;
        requireOwnerCurrent(expectedGeneration);
        return await awaitCurrent(response, expectedGeneration, timeouts.rpcMs, 'rpc_timeout');
      } catch (error) {
        if (pendingRpc && pendingRpc.id === id && error.code !== 'operation_stopped') fail(error.code || 'rpc_failed');
        throw error instanceof OwnedNativeRunnerError ? error : runnerError('rpc_failed');
      }
    })();
  }

  function handleCodexMessage(message) {
    if (!isRecord(message) || (Object.hasOwn(message, 'jsonrpc') && message.jsonrpc !== '2.0')) {
      throw runnerError('codex_message_invalid');
    }
    if (Object.prototype.hasOwnProperty.call(message, 'method')) {
      if (typeof message.method !== 'string' || !message.method || Object.prototype.hasOwnProperty.call(message, 'id') ||
          Object.prototype.hasOwnProperty.call(message, 'result') || Object.prototype.hasOwnProperty.call(message, 'error')) {
        throw runnerError(Object.prototype.hasOwnProperty.call(message, 'id') ? 'unknown_server_request' : 'codex_message_invalid');
      }
      if (message.method === 'account/login/completed') {
        handleLoginCompleted(message.params);
        return;
      }
      if (message.method === 'turn/completed') {
        handleTurnCompleted(message.params);
        return;
      }
      ignoredMessageCount = Math.min(Number.MAX_SAFE_INTEGER, ignoredMessageCount + 1);
      return;
    }
    const hasResult = Object.prototype.hasOwnProperty.call(message, 'result');
    const hasError = Object.prototype.hasOwnProperty.call(message, 'error');
    if (!Object.prototype.hasOwnProperty.call(message, 'id') || hasResult === hasError) throw runnerError('codex_message_invalid');
    const pending = pendingRpc;
    if (!pending || message.id !== pending.id) throw runnerError('rpc_response_unexpected');
    pendingRpc = null;
    if (hasError) pending.reject(runnerError('rpc_rejected'));
    else pending.resolve(message.result);
  }

  function handleClaudeMessage(message) {
    if (!isRecord(message) || typeof message.type !== 'string') throw runnerError('claude_message_invalid');
    if (message.type === 'system' && message.subtype === 'init') {
      if (!isIdentifier(message.session_id)) throw runnerError('claude_session_invalid');
      emitIdentity(message.session_id);
      return;
    }
    if (message.type === 'result') {
      if (!nativeIdentity || !isIdentifier(message.session_id) || message.session_id !== nativeIdentity.nativeId) {
        throw runnerError('claude_result_identity_invalid');
      }
      if (!nativeContext) throw runnerError('claude_result_before_context');
      emitContextEnded(nativeContext.nativeContextId);
      return;
    }
    if (message.type !== 'stream_event') {
      ignoredMessageCount = Math.min(Number.MAX_SAFE_INTEGER, ignoredMessageCount + 1);
      return;
    }
    if (Object.prototype.hasOwnProperty.call(message, 'session_id')) {
      if (!isIdentifier(message.session_id)) throw runnerError('claude_session_invalid');
      if (nativeIdentity && nativeIdentity.nativeId !== message.session_id) throw runnerError('native_identity_conflict');
    }
    if (!isRecord(message.event) || typeof message.event.type !== 'string') {
      ignoredMessageCount = Math.min(Number.MAX_SAFE_INTEGER, ignoredMessageCount + 1);
      return;
    }
    if (message.event.type !== 'message_start') {
      ignoredMessageCount = Math.min(Number.MAX_SAFE_INTEGER, ignoredMessageCount + 1);
      return;
    }
    const nativeMessage = message.event.message;
    if (!isRecord(nativeMessage) || nativeMessage.role !== 'assistant' || !isIdentifier(nativeMessage.id)) {
      throw runnerError('claude_message_start_invalid');
    }
    if (message.parent_tool_use_id !== null) {
      ignoredMessageCount = Math.min(Number.MAX_SAFE_INTEGER, ignoredMessageCount + 1);
      return;
    }
    if (!nativeIdentity) throw runnerError('native_event_order_invalid');
    if (Object.prototype.hasOwnProperty.call(message, 'session_id') && message.session_id !== nativeIdentity.nativeId) {
      throw runnerError('native_identity_conflict');
    }
    emitContext(nativeMessage.id);
  }

  function handleLine(bytes) {
    if (bytes.length === 0 || bytes.length > MAX_LINE_BYTES) throw runnerError('jsonl_line_invalid');
    let message;
    try {
      message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } catch {
      throw runnerError('jsonl_message_invalid');
    }
    lineCount = Math.min(Number.MAX_SAFE_INTEGER, lineCount + 1);
    if (lineCount > MAX_LINES) throw runnerError('jsonl_line_limit');
    if (provider === 'codex') handleCodexMessage(message);
    else handleClaudeMessage(message);
  }

  function handleStdout(chunk, expectedGeneration) {
    if (!isCurrent(expectedGeneration)) return;
    if (!Buffer.isBuffer(chunk)) return fail('stdout_chunk_invalid');
    if (chunk.length > MAX_LINE_BYTES || stdoutBuffer.length + chunk.length > MAX_LINE_BYTES) return fail('jsonl_buffer_limit');
    stdoutBuffer = stdoutBuffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([stdoutBuffer, chunk]);
    while (true) {
      const newline = stdoutBuffer.indexOf(0x0a);
      if (newline < 0) break;
      const line = stdoutBuffer.subarray(0, newline);
      stdoutBuffer = stdoutBuffer.subarray(newline + 1);
      const normalizedLine = line.length > 0 && line[line.length - 1] === 0x0d ? line.subarray(0, line.length - 1) : line;
      try {
        handleLine(normalizedLine);
        if (!isCurrent(expectedGeneration)) return;
      } catch (error) {
        fail(error instanceof OwnedNativeRunnerError ? error.code : 'protocol_failure');
        return;
      }
    }
    if (stdoutBuffer.length > MAX_LINE_BYTES) fail('jsonl_line_limit');
  }

  function attachChild(childProcess, expectedGeneration) {
    child = childProcess;
    if (!child || !child.stdin || !child.stdout || !child.stderr ||
        typeof child.once !== 'function' || typeof child.kill !== 'function') throw runnerError('spawn_adapter_invalid');
    childTerminationPromise = new Promise((resolve) => { childTerminationResolve = resolve; });
    child.once('spawn', () => {
      if (isCurrent(expectedGeneration)) childSpawned = true;
    });
    child.once('error', () => {
      if (isCurrent(expectedGeneration)) fail('child_process_error');
    });
    child.once('exit', () => {
      childExited = true;
      if (childTerminationResolve) childTerminationResolve();
      restoreStateAfterLateTermination();
      if (isCurrent(expectedGeneration)) fail('process_exited');
    });
    child.once('close', () => {
      childClosed = true;
      if (childTerminationResolve) childTerminationResolve();
      restoreStateAfterLateTermination();
      if (isCurrent(expectedGeneration)) fail('process_exited');
    });
    child.stdout.on('data', (chunk) => handleStdout(chunk, expectedGeneration));
    child.stdout.once('end', () => {
      if (isCurrent(expectedGeneration) && stdoutBuffer.length > 0) fail('jsonl_incomplete_line');
    });
    child.stdout.once('error', () => {
      if (isCurrent(expectedGeneration)) fail('stdout_error');
    });
    child.stderr.on('data', () => {});
    child.stderr.once('error', () => {});
    child.stdin.once('error', () => {
      if (isCurrent(expectedGeneration)) fail('stdin_error');
    });
  }

  async function waitForSpawn(expectedGeneration) {
    await awaitCurrent(new Promise((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(runnerError('spawn_failed')); };
      const cleanup = () => {
        child.removeListener('spawn', onSpawn);
        child.removeListener('error', onError);
      };
      child.once('spawn', onSpawn);
      child.once('error', onError);
    }), expectedGeneration, timeouts.startupMs, 'spawn_timeout');
    childSpawned = true;
    requireOwnerCurrent(expectedGeneration);
  }

  async function loadAuthentication(expectedGeneration) {
    requireOwnerCurrent(expectedGeneration);
    let supplied;
    try { supplied = getAuthentication(); } catch { throw runnerError('authentication_unavailable'); }
    const authentication = await awaitCurrent(supplied, expectedGeneration, timeouts.startupMs, 'authentication_timeout');
    requireOwnerCurrent(expectedGeneration);
    if (!isRecord(authentication)) throw runnerError('authentication_unavailable');
    if (!isSecretValue(authentication.oauthToken)) throw runnerError('authentication_unavailable');
    return { oauthToken: authentication.oauthToken };
  }

  async function spawnOwnedProcess(authentication, expectedGeneration) {
    requireOwnerCurrent(expectedGeneration);
    const environment = makeEnvironment(provider, homePath, provider === 'claude' ? authentication.oauthToken : null);
    let childProcess;
    try {
      childProcess = spawnImpl(executablePath, buildArguments(provider), {
        cwd,
        env: environment,
        shell: false,
        windowsHide: true,
        detached: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch {
      for (const key of Object.keys(environment)) delete environment[key];
      throw runnerError('spawn_failed');
    }
    for (const key of Object.keys(environment)) delete environment[key];
    requireCurrent(expectedGeneration);
    attachChild(childProcess, expectedGeneration);
    await waitForSpawn(expectedGeneration);
    requireOwnerCurrent(expectedGeneration);
  }

  async function startCodex(inputText, expectedGeneration) {
    const initialize = await sendRpc('initialize', {
      clientInfo: { name: 'agent-cockpit', version: '1' },
      capabilities: { experimentalApi: false },
    }, expectedGeneration);
    requireOwnerCurrent(expectedGeneration);
    if (!isRecord(initialize)) throw runnerError('initialize_result_invalid');
    requireCurrent(expectedGeneration);
    await writeLine(JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} }), expectedGeneration);
    requireOwnerCurrent(expectedGeneration);
    const loginAttempt = createLoginAttempt();
    activeLogin = loginAttempt;
    const login = await sendRpc('account/login/start', { type: 'chatgpt' }, expectedGeneration);
    requireOwnerCurrent(expectedGeneration);
    if (!isRecord(login) || login.type !== 'chatgpt' || !isIdentifier(login.loginId)) {
      throw runnerError('authentication_response_invalid');
    }
    const authUrl = validateAuthenticationUrl(login.authUrl);
    reconcileEarlyLogin(loginAttempt, login.loginId);
    if (!loginAttempt.completionSeen) requestAuthenticationPrompt(login.loginId, authUrl, expectedGeneration);
    await awaitCurrent(loginAttempt.completion, expectedGeneration, timeouts.loginMs, 'authentication_timeout');
    requireOwnerCurrent(expectedGeneration);
    if (activeLogin === loginAttempt) activeLogin = null;
    requireCurrent(expectedGeneration);
    const threadResult = await sendRpc('thread/start', {
      cwd,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    }, expectedGeneration);
    requireOwnerCurrent(expectedGeneration);
    if (!isRecord(threadResult) || !isRecord(threadResult.thread) || !isIdentifier(threadResult.thread.id)) {
      throw runnerError('thread_result_invalid');
    }
    emitIdentity(threadResult.thread.id);
    requireCurrent(expectedGeneration);
    turnStartPending = true;
    const turnResult = await sendRpc('turn/start', {
      threadId: threadResult.thread.id,
      input: [{ type: 'text', text: inputText }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'readOnly', networkAccess: false },
    }, expectedGeneration);
    requireOwnerCurrent(expectedGeneration);
    turnStartPending = false;
    if (!isRecord(turnResult) || !isRecord(turnResult.turn) || !isIdentifier(turnResult.turn.id)) {
      throw runnerError('turn_result_invalid');
    }
    if (earlyTurnCompletion) {
      if (earlyTurnCompletion.threadId !== threadResult.thread.id || earlyTurnCompletion.turnId !== turnResult.turn.id) {
        throw runnerError('native_context_conflict');
      }
      earlyTurnCompletion = null;
      emitContextEnded(turnResult.turn.id);
    } else {
      emitContext(turnResult.turn.id);
    }
    requireCurrent(expectedGeneration);
  }

  async function startClaude(inputText, expectedGeneration) {
    const line = JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: inputText }] } });
    await writeLine(line, expectedGeneration);
    requireOwnerCurrent(expectedGeneration);
    await awaitCurrent(contextReady, expectedGeneration, timeouts.startupMs, 'native_context_timeout');
    requireOwnerCurrent(expectedGeneration);
  }

  async function startOnce(request) {
    assertOnlyKeys(request, ['inputText'], 'invalid_start_request');
    if (typeof request.inputText !== 'string' || request.inputText.length === 0 ||
        Buffer.byteLength(request.inputText, 'utf8') > MAX_INPUT_BYTES) throw runnerError('invalid_start_request');
    state = 'starting';
    const expectedGeneration = generation;
    requireOwnerCurrent(expectedGeneration);
    ensureIsolatedHomeDirectories(homePath, provider);
    requireOwnerCurrent(expectedGeneration);
    let authentication = provider === 'claude' ? await loadAuthentication(expectedGeneration) : null;
    requireOwnerCurrent(expectedGeneration);
    await spawnOwnedProcess(authentication, expectedGeneration);
    requireOwnerCurrent(expectedGeneration);
    if (provider === 'codex') await startCodex(request.inputText, expectedGeneration);
    else await startClaude(request.inputText, expectedGeneration);
    requireOwnerCurrent(expectedGeneration);
    state = 'running';
    authentication = null;
    return safeSnapshot();
  }

  function start(request) {
    if (startPromise || state !== 'idle') return Promise.reject(runnerError('already_started'));
    startPromise = startOnce(request).catch((error) => {
      const code = error instanceof OwnedNativeRunnerError ? error.code : 'startup_failed';
      if (state !== 'failed' && state !== 'stopped' && state !== 'stopping' && state !== 'unsupported') fail(code);
      throw runnerError(code);
    });
    startPromise.catch(() => {});
    return startPromise;
  }

  function stop() {
    if (stopPromise) return stopPromise;
    if (state === 'stopped') return Promise.resolve(safeSnapshot());
    generation += 1;
    state = 'stopping';
    cancelCurrentOperations();
    if (pendingRpc) {
      const pending = pendingRpc;
      pendingRpc = null;
      pending.reject(runnerError('operation_stopped'));
    }
    stopPromise = stopChild(child).then((confirmed) => {
      if (confirmed || state !== 'stop_unconfirmed') state = 'stopped';
      return safeSnapshot();
    }, () => {
      if (state !== 'stop_unconfirmed') state = 'stopped';
      return safeSnapshot();
    });
    return stopPromise;
  }

  return Object.freeze({ start, stop, snapshot: safeSnapshot });
}

module.exports = { OwnedNativeRunnerError, createOwnedNativeRunner };
