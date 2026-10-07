'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { createOwnedNativeWaitLatch } = require('./owned-native-wait');
const { createOwnedNativeMcpWait, TOOL_NAME: CLAUDE_WAIT_TOOL } = require('./owned-native-mcp-wait');
const { createOwnedNativeClaudeWait } = require('./owned-native-claude-wait');
const { createOwnedNativeSource, getOwnedSource } = require('./owned-native-source');
const { createOwnedInstructionWriter, MAX_INSTRUCTION_DISPATCHES } = require('./owned-native-instruction-writer');

const PROFILE = 'cockpit-native-v1';
const WAIT_PROFILE = 'cockpit-native-wait-v1';
const WAIT_TOOL_NAME = 'cockpit_wait';
const WAIT_TOOL_NAMESPACE = null;
const WAIT_TOOL_SPEC = Object.freeze({
  type: 'function',
  name: WAIT_TOOL_NAME,
  description: 'Wait for the trusted host to resume this task.',
  inputSchema: Object.freeze({
    type: 'object',
    properties: Object.freeze({}),
    additionalProperties: false,
  }),
});
const ENVIRONMENT_ALLOWLIST = Object.freeze(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC']);
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_INPUT_BYTES = 256 * 1024;
const MAX_LINES = 100_000;
const MAX_NATIVE_TERMINALS = MAX_INSTRUCTION_DISPATCHES + 1;
const MAX_NATIVE_SERVER_REQUESTS = 128;
const MAX_NATIVE_REQUEST_ID_LENGTH = 1024;
const READ_RPC_ID_START = 2 ** 32;
const INSTRUCTION_RPC_ID_START = 2 ** 48;
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

function isSynchronousTrue(callback) {
  let result;
  try { result = callback(); } catch { return false; }
  if (result === true) return true;
  try {
    if (result && typeof result.then === 'function') Promise.resolve(result).catch(() => {});
  } catch {}
  return false;
}

function createOwnedNativeRunner(options) {
  assertOnlyKeys(options, [
    'provider', 'executablePath', 'hostId', 'homeScopeId', 'homePath', 'cwd', 'profile',
    'getAuthentication', 'onAuthenticationRequired', 'isCurrent', 'isSourceCurrent', 'isObservationCurrent', 'isContextCurrent', 'onWaitRequired',
    'spawnImpl', 'timeouts', 'onNative', 'onDisconnect', 'ownedSourceClaim', 'onSourceReady', 'captureWaitAuthorization', 'onContextContinuation',
  ], 'invalid_configuration');
  if (options.provider !== 'codex' && options.provider !== 'claude') throw runnerError('invalid_provider');
  if (options.profile !== PROFILE && options.profile !== WAIT_PROFILE) throw runnerError('invalid_profile');
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
  const waitProfile = options.profile === WAIT_PROFILE;
  const claudeWaitProfile = waitProfile && options.provider === 'claude';
  if (claudeWaitProfile && !options.ownedSourceClaim) throw runnerError('unsupported_profile');
  if (claudeWaitProfile && (typeof options.captureWaitAuthorization !== 'function' || typeof options.onContextContinuation !== 'function' ||
      !options.ownedSourceClaim || typeof options.onSourceReady !== 'function')) throw runnerError('invalid_wait_callbacks');
  if (waitProfile && !claudeWaitProfile && (typeof options.onWaitRequired !== 'function' ||
      typeof options.isCurrent !== 'function' || typeof options.isSourceCurrent !== 'function' || typeof options.isContextCurrent !== 'function')) {
    throw runnerError('invalid_wait_callbacks');
  }
  if (!waitProfile && (options.onWaitRequired !== undefined || options.captureWaitAuthorization !== undefined || options.onContextContinuation !== undefined)) throw runnerError('invalid_profile');
  if (options.isCurrent !== undefined && typeof options.isCurrent !== 'function') throw runnerError('invalid_current_callback');
  if (options.isSourceCurrent !== undefined && typeof options.isSourceCurrent !== 'function') throw runnerError('invalid_current_callback');
  if (options.isObservationCurrent !== undefined && typeof options.isObservationCurrent !== 'function') throw runnerError('invalid_current_callback');
  if (options.isContextCurrent !== undefined && typeof options.isContextCurrent !== 'function') throw runnerError('invalid_current_callback');
  if (options.onAuthenticationRequired !== undefined && options.provider !== 'codex') {
    throw runnerError('invalid_authentication_prompt');
  }
  const ownedSourceEnabled = options.ownedSourceClaim !== undefined || options.onSourceReady !== undefined;
  if (ownedSourceEnabled &&
      (options.ownedSourceClaim === undefined || options.ownedSourceClaim === null ||
       !['object', 'function'].includes(typeof options.ownedSourceClaim) ||
       typeof options.onSourceReady !== 'function')) {
    throw runnerError('invalid_owned_source_callbacks');
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
  const onWaitRequired = options.onWaitRequired;
  const isOwnerCurrent = options.isCurrent || (() => true);
  const isSourceCurrent = options.isSourceCurrent || isOwnerCurrent;
  const isObservationCurrent = options.isObservationCurrent || isSourceCurrent;
  const isContextCurrent = options.isContextCurrent || (() => true);
  const spawnImpl = options.spawnImpl === undefined ? spawn : options.spawnImpl;
  if (typeof spawnImpl !== 'function') throw runnerError('invalid_spawn_adapter');
  const timeouts = normalizeTimeouts(options.timeouts);
  let sourceController = null;
  const ownedSource = ownedSourceEnabled
    ? createOwnedNativeSource({
      provider,
      hostId,
      homeScopeId,
      ownedSourceClaim: options.ownedSourceClaim,
      readNativeCurrent,
    })
    : null;
  if (ownedSource) sourceController = ownedSource.controller;
  let sourceReadyNotified = false;

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
  const pendingReadRpcs = new Map();
  const MAX_PENDING_READ_RPCS = 1;
  const pendingNativeRequests = new Map();
  let pendingNativeRequestRevision = 0n;
  const usedNativeRequestIds = new Set();
  let nextRpcId = 1;
  let nextReadRpcId = READ_RPC_ID_START;
  let nextInstructionRpcId = INSTRUCTION_RPC_ID_START;
  const instructionRpcs = new Map();
  const knownInstructionTerminals = new Set();
  const claudeTerminalResults = new Map();
  let instructionStart = null;
  let instructionUncertain = false;
  const instructionController = ownedSource ? createOwnedInstructionWriter(ownedSource.capability, {
    capture: captureInstruction, check: checkInstruction, checkEvidence: checkInstructionEvidence,
    prepareWrite: prepareInstructionWrite, register: registerInstruction, unregister: unregisterInstruction, complete: completeInstruction,
  }) : null;
  let firstIssuedReadRpcId = null;
  let lastIssuedReadRpcId = null;
  let pendingReadWrite = null;
  let nativeIdentity = null;
  let nativeContext = null;
  let terminalContextId = null;
  let initializeHomeConfirmed = false;
  let turnStartPending = false;
  let earlyTurnCompletion = null;
  let earlyWaitCall = null;
  let waitCallSeen = false;
  let activeWait = null;
  let activeLogin = null;
  let terminalContextCount = 0;
  let loginPromptCount = 0;
  let disconnectNotified = false;
  let failureCode = null;
  let authCapability = provider === 'codex' ? 'managed_chatgpt_login' : 'claude_oauth_environment';
  const cancellations = new Set();
  let activeInputEpoch = 0, nextInputEpoch = 1;
  let resolveContext = null;
  const contextReady = new Promise((resolve) => { resolveContext = resolve; });
  contextReady.catch(() => {});
  const claudeMcpWait = claudeWaitProfile ? createOwnedNativeMcpWait(ownedSource.capability, {
    capture: (native) => options.captureWaitAuthorization(native),
    onInvalidated: () => fail('claude_wait_unknown'),
  }) : null;
  const claudeWait = claudeWaitProfile ? createOwnedNativeClaudeWait(ownedSource.capability, {
    mcp: claudeMcpWait,
    current: () => nativeIdentity ? { sessionId: nativeIdentity.nativeId, nativeContextId: nativeContext?.nativeContextId || null, inputEpoch: activeInputEpoch } : null,
    scope: () => ({ generation, child, identity: nativeIdentity, context: nativeContext, epoch: activeInputEpoch, lease: sourceController.captureInstructionLease() }),
    checkScope: (capture) => capture && generation === capture.generation && child === capture.child && nativeIdentity === capture.identity &&
      nativeContext === capture.context && activeInputEpoch === capture.epoch && !terminalContextId &&
      ['starting', 'running'].includes(state) && ownedSource.facade.checkSource() === true && sourceController.isLeaseTokenCurrent(capture.lease) === true,
    onContinuation: (permit) => options.onContextContinuation(permit),
    onUnknown: () => fail('claude_wait_unknown'),
    advance(from, to, capture) {
      if (generation !== capture.generation || nativeContext?.nativeContextId !== from || !sourceController.isLeaseTokenCurrent(capture.lease)) return false;
      emitContextEnded(from);
      if (!sourceController.beginInstructionContext(from)) return false;
      nativeContext = null; terminalContextId = null; waitCallSeen = false;
      emitContext(to); return nativeContext?.nativeContextId === to && ['starting', 'running'].includes(state);
    },
  }) : null;

  function safeSnapshot() {
    return Object.freeze({
      provider,
      state,
      authCapability,
      childExited,
      childClosed,
      waitEndpointActive: claudeMcpWait?.controller.isListening() === true,
      ownedChildActive: Boolean(child && !childExited && !childClosed),
      lineCount,
      ignoredMessageCount,
      pendingRpcCount: (pendingRpc ? 1 : 0) + pendingReadRpcs.size,
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
    if (!isSynchronousTrue(isOwnerCurrent)) throw runnerError('authority_expired');
    requireCurrent(expectedGeneration);
    if (!isSynchronousTrue(isSourceCurrent)) throw runnerError('authority_expired');
    requireCurrent(expectedGeneration);
  }

  function requireWriteCurrent(expectedGeneration) {
    requireOwnerCurrent(expectedGeneration);
    requireOwnerCurrent(expectedGeneration);
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

  function invalidateWait() {
    const wait = activeWait;
    activeWait = null;
    earlyWaitCall = null;
    if (wait) wait.latch.invalidate();
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
    if (sourceController) sourceController.invalidate();
    if (instructionController) instructionController.invalidate();
    if (claudeWait) claudeWait.controller.stop().catch(() => {});
    invalidateWait();
    cancelCurrentOperations();
    if (pendingRpc) {
      const pending = pendingRpc;
      pendingRpc = null;
      pending.reject(runnerError(code));
    }
    for (const [id, pending] of pendingReadRpcs) {
      pendingReadRpcs.delete(id);
      if (typeof pending.reject === 'function') pending.reject(runnerError(code));
    }
    pendingReadWrite = null;
    clearActiveLogin(code);
    reportDisconnect(code);
    stopChild(child).catch(() => {});
  }

  function notifyNative(event, terminal = false) {
    if (!isCurrent(generation)) return false;
    if (!terminal && !isSynchronousTrue(isObservationCurrent)) return false;
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
    return isCurrent(generation) && (terminal || isSynchronousTrue(isObservationCurrent));
  }

  function emitIdentity(nativeId) {
    if (!isIdentifier(nativeId)) throw runnerError('native_identity_invalid');
    if (nativeIdentity) {
      if (nativeIdentity.nativeId !== nativeId) throw runnerError('native_identity_conflict');
      return;
    }
    const identity = Object.freeze({
      provider,
      nativeIdKind: provider === 'codex' ? 'thread' : 'session',
      hostId,
      homeScopeId,
      nativeId,
    });
    nativeIdentity = identity;
    if (sourceController && !sourceController.observeIdentity(identity)) {
      throw runnerError('owned_source_identity_conflict');
    }
    const delivered = notifyNative(Object.freeze({ type: 'identity', provider, identity }));
    if (sourceController && delivered && isSynchronousTrue(isObservationCurrent)) sourceController.deliverIdentity(identity);
  }

  function emitContext(nativeContextId) {
    if (!isIdentifier(nativeContextId)) throw runnerError('native_context_invalid');
    if (!nativeIdentity) throw runnerError('native_event_order_invalid');
    if (terminalContextId) throw runnerError('native_context_after_terminal');
    if (nativeContext) {
      if (nativeContext.nativeContextId !== nativeContextId) throw runnerError('native_context_conflict');
      return;
    }
    const context = Object.freeze({
      kind: provider === 'codex' ? 'turn' : 'assistant_message',
      nativeContextId,
      parentToolUseId: null,
    });
    nativeContext = context;
    if (sourceController && !sourceController.observeContext(nativeIdentity, context)) {
      throw runnerError('owned_source_context_conflict');
    }
    const delivered = notifyNative(Object.freeze({ type: 'context', provider, identity: nativeIdentity, context }));
    if (sourceController && delivered && isSynchronousTrue(isObservationCurrent)) {
      sourceController.deliverContext(nativeIdentity, context);
    }
    if (resolveContext) resolveContext();
  }

  function emitContextEnded(nativeContextId, matchedEarlyTurnStart = false) {
    if (!nativeIdentity || !isIdentifier(nativeContextId)) throw runnerError('native_context_terminal_invalid');
    if (terminalContextId) {
      if (terminalContextId !== nativeContextId) throw runnerError('native_context_conflict');
      throw runnerError('native_context_terminal_duplicate');
    }
    if (nativeContext && nativeContext.nativeContextId !== nativeContextId) throw runnerError('native_context_conflict');
    if (!nativeContext && !matchedEarlyTurnStart) throw runnerError('native_context_conflict');
    invalidateWait();
    if (claudeWait && !claudeWait.controller.transitioning()) claudeWait.controller.endInput();
    terminalContextId = nativeContextId;
    terminalContextCount = Math.min(Number.MAX_SAFE_INTEGER, terminalContextCount + 1);
    if (instructionController) {
      if (knownInstructionTerminals.size >= MAX_NATIVE_TERMINALS) throw runnerError('native_context_end_limit');
      knownInstructionTerminals.add(nativeContextId);
    }
    const context = Object.freeze({
      kind: provider === 'codex' ? 'turn' : 'assistant_message',
      nativeContextId,
    });
    const observed = sourceController && (matchedEarlyTurnStart
      ? sourceController.observeEarlyTerminal(nativeIdentity, context)
      : sourceController.observeTerminal(nativeIdentity, context));
    if (sourceController && !observed) {
      throw runnerError('owned_source_terminal_conflict');
    }
    notifyNative(Object.freeze({ type: 'context_ended', provider, identity: nativeIdentity, context }), true);
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
    if (instructionStart && !instructionStart.acknowledged) {
      if (knownInstructionTerminals.has(completed.turnId)) return;
      if (instructionStart.earlyCompletion) throw runnerError('codex_turn_completion_duplicate');
      instructionStart.earlyCompletion = completed;
      return;
    }
    if (knownInstructionTerminals.has(completed.turnId)) return;
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

  function hasExactKeys(value, expectedKeys) {
    return isRecord(value) && Object.keys(value).length === expectedKeys.length &&
      expectedKeys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
  }

  function isJsonRpcRequestId(value) {
    return (typeof value === 'string' && isIdentifier(value)) ||
      (Number.isSafeInteger(value) && value >= 0);
  }

  function isNativeServerRequestId(value) {
    return (typeof value === 'string' && value.length <= MAX_NATIVE_REQUEST_ID_LENGTH) || Number.isSafeInteger(value);
  }

  function nativeRequestIdKey(id) {
    return typeof id === 'string' ? `string:${id}` : `integer:${id}`;
  }

  function parseNativeHoldRequest(message) {
    const requestKeys = Object.prototype.hasOwnProperty.call(message, 'jsonrpc')
      ? ['jsonrpc', 'id', 'method', 'params']
      : ['id', 'method', 'params'];
    if (!hasExactKeys(message, requestKeys) ||
        (Object.prototype.hasOwnProperty.call(message, 'jsonrpc') && message.jsonrpc !== '2.0') ||
        !isNativeServerRequestId(message.id) || typeof message.method !== 'string' || !isRecord(message.params)) {
      throw runnerError('native_server_request_invalid');
    }
    const params = message.params;
    if (!isIdentifier(params.threadId) || !isIdentifier(params.turnId) || !isIdentifier(params.itemId)) {
      throw runnerError('native_server_request_invalid');
    }

    let kind;
    if (message.method === 'item/tool/requestUserInput') {
      kind = 'user_input';
      if (typeof params.isBlocking !== 'boolean' || !Array.isArray(params.questions) ||
          (Object.hasOwn(params, 'autoResolutionMs') && params.autoResolutionMs !== null &&
            (!Number.isSafeInteger(params.autoResolutionMs) || params.autoResolutionMs < 0)) ||
          params.questions.some((question) => !isRecord(question) ||
            typeof question.header !== 'string' || typeof question.id !== 'string' || typeof question.question !== 'string' ||
            (Object.hasOwn(question, 'isOther') && typeof question.isOther !== 'boolean') ||
            (Object.hasOwn(question, 'isSecret') && typeof question.isSecret !== 'boolean') ||
            (Object.hasOwn(question, 'options') && question.options !== null &&
              (!Array.isArray(question.options) || question.options.some((option) => !isRecord(option) ||
                typeof option.description !== 'string' || typeof option.label !== 'string'))))) {
        throw runnerError('native_server_request_invalid');
      }
    } else if (message.method === 'item/commandExecution/requestApproval') {
      kind = 'command_approval';
      if (!Number.isSafeInteger(params.startedAtMs)) {
        throw runnerError('native_server_request_invalid');
      }
    } else if (message.method === 'item/fileChange/requestApproval') {
      kind = 'file_change_approval';
      if (!Number.isSafeInteger(params.startedAtMs)) {
        throw runnerError('native_server_request_invalid');
      }
    } else if (message.method === 'item/permissions/requestApproval') {
      kind = 'permissions_approval';
      if (typeof params.cwd !== 'string' ||
          !isRecord(params.permissions) || !Number.isSafeInteger(params.startedAtMs)) {
        throw runnerError('native_server_request_invalid');
      }
    } else {
      throw runnerError('unknown_server_request');
    }
    return Object.freeze({
      idKey: nativeRequestIdKey(message.id),
      threadId: params.threadId,
      turnId: params.turnId,
      kind,
    });
  }

  function recordNativeHoldRequest(message) {
    const request = parseNativeHoldRequest(message);
    if (usedNativeRequestIds.has(request.idKey)) throw runnerError('native_server_request_id_reused');
    if (usedNativeRequestIds.size >= MAX_NATIVE_SERVER_REQUESTS) throw runnerError('native_server_request_limit');
    usedNativeRequestIds.add(request.idKey);
    if (!childSpawned || !child || !['starting', 'running'].includes(state) || turnStartPending ||
        !nativeIdentity || !nativeContext || terminalContextId) {
      throw runnerError('native_server_request_scope_unavailable');
    }
    if (nativeIdentity.nativeId !== request.threadId || nativeContext.nativeContextId !== request.turnId) {
      throw runnerError('native_server_request_scope_mismatch');
    }
    pendingNativeRequests.set(request.idKey, Object.freeze({
      generation,
      child,
      threadId: request.threadId,
      turnId: request.turnId,
      kind: request.kind,
    }));
    pendingNativeRequestRevision += 1n;
  }

  function resolveNativeHoldRequest(message) {
    const notificationKeys = Object.prototype.hasOwnProperty.call(message, 'jsonrpc')
      ? ['jsonrpc', 'method', 'params']
      : ['method', 'params'];
    if (!hasExactKeys(message, notificationKeys) ||
        (Object.prototype.hasOwnProperty.call(message, 'jsonrpc') && message.jsonrpc !== '2.0') ||
        !isRecord(message.params) || !hasExactKeys(message.params, ['requestId', 'threadId']) ||
        !isNativeServerRequestId(message.params.requestId) || !isIdentifier(message.params.threadId)) {
      throw runnerError('native_server_resolution_invalid');
    }
    const idKey = nativeRequestIdKey(message.params.requestId);
    const pending = pendingNativeRequests.get(idKey);
    if (!pending) throw runnerError('native_server_resolution_unmatched');
    if (pending.generation !== generation || pending.child !== child || !childSpawned ||
        !['starting', 'running'].includes(state) || message.params.threadId !== pending.threadId ||
        !nativeIdentity || nativeIdentity.nativeId !== pending.threadId || !nativeContext ||
        nativeContext.nativeContextId !== pending.turnId ||
        (terminalContextId !== null && terminalContextId !== pending.turnId)) {
      throw runnerError('native_server_resolution_scope_mismatch');
    }
    pendingNativeRequests.delete(idKey);
    pendingNativeRequestRevision += 1n;
  }

  function captureNativePendingSummary(threadId, turnId) {
    if (!isIdentifier(threadId) || !isIdentifier(turnId) || state !== 'running' || !childSpawned || !child ||
        !nativeIdentity || nativeIdentity.nativeId !== threadId || !nativeContext ||
        nativeContext.nativeContextId !== turnId || terminalContextId || turnStartPending || activeWait ||
        instructionStart || instructionUncertain) return null;
    const capturedGeneration = generation;
    const capturedChild = child;
    const capturedRevision = pendingNativeRequestRevision;
    const counts = new Map([['question', 0], ['approval', 0]]);
    for (const request of pendingNativeRequests.values()) {
      if (request.generation !== capturedGeneration || request.child !== capturedChild ||
          request.threadId !== threadId || request.turnId !== turnId) return null;
      const category = request.kind === 'user_input' ? 'question' :
        ['command_approval', 'file_change_approval', 'permissions_approval'].includes(request.kind) ? 'approval' : null;
      if (!category) return null;
      counts.set(category, counts.get(category) + 1);
    }
    const pending = [...counts]
      .filter(([, count]) => count > 0)
      .map(([kind, count]) => Object.freeze({ kind, count }));
    const checkCurrent = () => {
      if (pendingNativeRequestRevision !== capturedRevision || generation !== capturedGeneration || child !== capturedChild ||
          state !== 'running' || !childSpawned || !nativeIdentity || nativeIdentity.nativeId !== threadId || !nativeContext ||
          nativeContext.nativeContextId !== turnId || terminalContextId || turnStartPending || activeWait ||
          instructionStart || instructionUncertain) return false;
      for (const request of pendingNativeRequests.values()) {
        if (request.generation !== capturedGeneration || request.child !== capturedChild ||
            request.threadId !== threadId || request.turnId !== turnId) return false;
      }
      return true;
    };
    const capture = Object.freeze({ pending: Object.freeze(pending), checkCurrent });
    return checkCurrent() ? capture : null;
  }

  function parseWaitRequest(message) {
    const requestKeys = Object.prototype.hasOwnProperty.call(message, 'jsonrpc')
      ? ['jsonrpc', 'id', 'method', 'params']
      : ['id', 'method', 'params'];
    if (!hasExactKeys(message, requestKeys) ||
        (Object.prototype.hasOwnProperty.call(message, 'jsonrpc') && message.jsonrpc !== '2.0') ||
        !isJsonRpcRequestId(message.id) || message.method !== 'item/tool/call' ||
        !hasExactKeys(message.params, ['threadId', 'turnId', 'callId', 'namespace', 'tool', 'arguments'])) {
      throw runnerError('wait_request_invalid');
    }
    const params = message.params;
    if (!isIdentifier(params.threadId) || !isIdentifier(params.turnId) ||
        !isIdentifier(params.callId) || params.namespace !== WAIT_TOOL_NAMESPACE ||
        params.tool !== WAIT_TOOL_NAME || !hasExactKeys(params.arguments, [])) {
      throw runnerError('wait_request_invalid');
    }
    return Object.freeze({
      requestId: message.id,
      threadId: params.threadId,
      turnId: params.turnId,
      callId: params.callId,
    });
  }

  function waitScopeCurrent(wait) {
    const matches = () => wait && activeWait === wait && isCurrent(wait.generation) &&
      nativeIdentity && nativeIdentity.nativeId === wait.threadId &&
      nativeContext && nativeContext.nativeContextId === wait.turnId && !terminalContextId;
    if (!matches() || !wait.callbackComplete) return false;
    if (!isSynchronousTrue(isOwnerCurrent) || !matches()) return false;
    if (!isSynchronousTrue(isSourceCurrent) || !matches()) return false;
    if (!isSynchronousTrue(isContextCurrent) || !matches()) return false;
    return true;
  }

  function discardWait(wait) {
    if (activeWait === wait) activeWait = null;
    if (wait) wait.latch.invalidate();
  }

  function writeWaitResponse(wait, status) {
    const success = status === 'released';
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: wait.requestId,
      result: { contentItems: [{ type: 'inputText', text: status }], success },
    });
    if (!waitScopeCurrent(wait) || !waitScopeCurrent(wait)) {
      discardWait(wait);
      return;
    }
    if (!child || !child.stdin || typeof child.stdin.write !== 'function') {
      discardWait(wait);
      return;
    }
    activeWait = null;
    try {
      child.stdin.write(line + '\n', (error) => {
        if (error) fail('wait_response_write_failed');
      });
    } catch {
      fail('wait_response_write_failed');
    }
  }

  function activateWaitCall(call) {
    if (!waitProfile || !nativeIdentity || !nativeContext || terminalContextId ||
        call.threadId !== nativeIdentity.nativeId || call.turnId !== nativeContext.nativeContextId) {
      throw runnerError('wait_request_context_mismatch');
    }
    let wait;
    const latch = createOwnedNativeWaitLatch({
      onTerminal: (status) => { if (wait) writeWaitResponse(wait, status); },
    });
    wait = {
      latch,
      requestId: call.requestId,
      threadId: call.threadId,
      turnId: call.turnId,
      generation,
      callbackComplete: false,
    };
    activeWait = wait;
    if (!waitScopeCurrentBeforeCallback(wait)) {
      discardWait(wait);
      return;
    }
    let callbackResult;
    try { callbackResult = onWaitRequired(latch.receipt); } catch {
      discardWait(wait);
      throw runnerError('wait_callback_failed');
    }
    if (callbackResult && typeof callbackResult.then === 'function') {
      Promise.resolve(callbackResult).catch(() => {});
      discardWait(wait);
      throw runnerError('async_wait_callback_unsupported');
    }
    wait.callbackComplete = true;
    if (!waitScopeCurrent(wait)) discardWait(wait);
  }

  function waitScopeCurrentBeforeCallback(wait) {
    const matches = () => wait && activeWait === wait && isCurrent(wait.generation) &&
      nativeIdentity && nativeIdentity.nativeId === wait.threadId &&
      nativeContext && nativeContext.nativeContextId === wait.turnId && !terminalContextId;
    if (!matches()) return false;
    if (!isSynchronousTrue(isOwnerCurrent) || !matches()) return false;
    if (!isSynchronousTrue(isSourceCurrent) || !matches()) return false;
    if (!isSynchronousTrue(isContextCurrent) || !matches()) return false;
    return true;
  }

  function handleWaitToolCall(message) {
    const call = parseWaitRequest(message);
    if (!waitProfile || !nativeIdentity || call.threadId !== nativeIdentity.nativeId) {
      throw runnerError('wait_request_context_mismatch');
    }
    if (waitCallSeen) throw runnerError('wait_request_duplicate');
    waitCallSeen = true;
    if (turnStartPending) {
      if (earlyWaitCall) throw runnerError('wait_request_duplicate');
      earlyWaitCall = call;
      return;
    }
    activateWaitCall(call);
  }

  function releaseWait(receipt) {
    const wait = activeWait;
    return Boolean(wait && wait.callbackComplete && wait.latch.release(receipt));
  }

  function cancelWait(receipt) {
    const wait = activeWait;
    return Boolean(wait && wait.callbackComplete && wait.latch.cancel(receipt));
  }

  function writeLine(line, expectedGeneration) {
    requireWriteCurrent(expectedGeneration);
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
    if (firstIssuedReadRpcId !== null) throw runnerError('rpc_id_sequence_invalid');
    const id = nextRpcId;
    if (!Number.isSafeInteger(id) || id >= READ_RPC_ID_START) throw runnerError('rpc_id_exhausted');
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

  function isCurrentOwnedRead(expectedGeneration, leaseToken, identity, context) {
    return isCurrent(expectedGeneration) && state === 'running' && sourceController &&
      initializeHomeConfirmed &&
      sourceController.isLeaseTokenCurrent(leaseToken) && nativeIdentity && nativeContext &&
      nativeIdentity.nativeId === identity.nativeId &&
      nativeContext.nativeContextId === context.nativeContextId &&
      terminalContextId !== context.nativeContextId;
  }

  function isIssuedOwnedReadRpcId(id) {
    return Number.isSafeInteger(id) && firstIssuedReadRpcId !== null &&
      id >= firstIssuedReadRpcId && id <= lastIssuedReadRpcId;
  }

  function retireReadWriteState(writeState) {
    if (!writeState) return;
    writeState.retired = true;
    if (pendingReadWrite === writeState) pendingReadWrite = null;
  }

  function retirePendingRead(id, pending, reason) {
    if (pendingReadRpcs.get(id) === pending) pendingReadRpcs.delete(id);
    retireReadWriteState(pending.writeState);
    const reject = pending.reject;
    pending.resolve = null;
    pending.reject = null;
    if (typeof reject === 'function') reject(reason);
  }

  function retireStaleReadRpcs() {
    for (const [id, pending] of pendingReadRpcs) {
      if (!isCurrentOwnedRead(pending.expectedGeneration, pending.leaseToken, pending.identity, pending.context)) {
        retirePendingRead(id, pending, runnerError('operation_stopped'));
      }
    }
  }

  function awaitOwnedRead(value, expectedGeneration, leaseToken, identity, context) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (callback, result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        cancellations.delete(cancel);
        callback(result);
      };
      const cancel = () => finish(reject, runnerError('operation_stopped'));
      const timer = setTimeout(() => finish(reject, runnerError('rpc_timeout')), timeouts.rpcMs);
      if (!isCurrentOwnedRead(expectedGeneration, leaseToken, identity, context)) {
        finish(reject, runnerError('operation_stopped'));
        return;
      }
      cancellations.add(cancel);
      Promise.resolve(value).then(
        (result) => {
          if (!isCurrentOwnedRead(expectedGeneration, leaseToken, identity, context)) {
            finish(reject, runnerError('operation_stopped'));
          } else {
            finish(resolve, result);
          }
        },
        () => finish(reject, runnerError('rpc_rejected')),
      );
    });
  }

  function sendOwnedReadRpc(method, params, expectedGeneration, leaseToken, identity, context) {
    retireStaleReadRpcs();
    if (!['thread/loaded/list', 'thread/read'].includes(method) ||
        pendingReadRpcs.size >= MAX_PENDING_READ_RPCS ||
        !isCurrentOwnedRead(expectedGeneration, leaseToken, identity, context)) {
      throw runnerError('owned_read_unavailable');
    }
    const id = nextReadRpcId;
    if (!Number.isSafeInteger(id) || id >= INSTRUCTION_RPC_ID_START) return Promise.reject(runnerError('rpc_id_exhausted'));
    let resolveResponse;
    let rejectResponse;
    const response = new Promise((resolve, reject) => {
      resolveResponse = resolve;
      rejectResponse = reject;
    });
    response.catch(() => {});
    const pending = {
      id,
      expectedGeneration,
      leaseToken,
      identity,
      context,
      resolve: resolveResponse,
      reject: rejectResponse,
    };
    const writeState = { id, settled: false, retired: false };
    pending.writeState = writeState;
    let writeAttempted = false;
    const writeResponse = new Promise((resolve, reject) => {
      try {
        const stdin = child && child.stdin;
        const write = stdin && stdin.write;
        if (!stdin || typeof write !== 'function' ||
            !isCurrentOwnedRead(expectedGeneration, leaseToken, identity, context)) {
          throw runnerError('owned_read_unavailable');
        }
        if (firstIssuedReadRpcId === null) firstIssuedReadRpcId = id;
        else if (id !== lastIssuedReadRpcId + 1) throw runnerError('rpc_id_sequence_invalid');
        lastIssuedReadRpcId = id;
        nextReadRpcId += 1;
        pendingReadRpcs.set(id, pending);
        pendingReadWrite = writeState;
        writeAttempted = true;
        write.call(stdin, JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', (error) => {
          writeState.settled = true;
          if (pendingReadWrite === writeState) pendingReadWrite = null;
          if (error) {
            if (writeState.retired && isCurrent(expectedGeneration)) fail('stdin_write_failed');
            reject(runnerError('stdin_write_failed'));
          }
          else resolve();
        });
      } catch (error) {
        writeState.settled = true;
        if (pendingReadWrite === writeState) pendingReadWrite = null;
        reject(error instanceof OwnedNativeRunnerError ? error : runnerError('stdin_write_failed'));
      }
    });
    return (async () => {
      try {
        await awaitOwnedRead(writeResponse, expectedGeneration, leaseToken, identity, context);
        return await awaitOwnedRead(response, expectedGeneration, leaseToken, identity, context);
      } catch (error) {
        if (pendingReadRpcs.get(id) === pending) retirePendingRead(id, pending, error);
        else retireReadWriteState(writeState);
        if (writeAttempted && error.code === 'stdin_write_failed') fail('stdin_write_failed');
        throw error instanceof OwnedNativeRunnerError ? error : runnerError('owned_read_failed');
      }
    })();
  }

  async function readNativeCurrent({ leaseToken, requestToken }) {
    if (provider !== 'codex' || !sourceController || !requestToken || !isCurrent(generation) ||
        state !== 'running' || !startPromise) return null;
    const expectedGeneration = generation;
    const identity = nativeIdentity;
    const context = nativeContext;
    if (!identity || !context || !isCurrentOwnedRead(expectedGeneration, leaseToken, identity, context)) return null;

    const loadedResult = await sendOwnedReadRpc('thread/loaded/list', { limit: 100 },
      expectedGeneration, leaseToken, identity, context);
    if (!isCurrentOwnedRead(expectedGeneration, leaseToken, identity, context) ||
        !isRecord(loadedResult) || !Array.isArray(loadedResult.data) ||
        loadedResult.data.some((threadId) => !isIdentifier(threadId)) ||
        !loadedResult.data.includes(identity.nativeId)) return null;

    const readResult = await sendOwnedReadRpc('thread/read', {
      threadId: identity.nativeId,
      includeTurns: true,
    }, expectedGeneration, leaseToken, identity, context);
    if (!isCurrentOwnedRead(expectedGeneration, leaseToken, identity, context) ||
        !isRecord(readResult) || !isRecord(readResult.thread) ||
        readResult.thread.id !== identity.nativeId || !Array.isArray(readResult.thread.turns)) return null;
    const matchingTurns = readResult.thread.turns.filter((turn) => isRecord(turn) && turn.id === context.nativeContextId);
    if (matchingTurns.length !== 1 || matchingTurns[0].status !== 'inProgress' ||
        !isCurrentOwnedRead(expectedGeneration, leaseToken, identity, context)) return null;
    return Object.freeze({
      requestToken,
      identity,
      context,
      activity: 'inProgress',
    });
  }


  function captureInstruction(metadata) {
    if (state !== 'running' || !ownedSource || !nativeIdentity || !nativeContext || activeWait || pendingNativeRequests.size > 0 || instructionStart || instructionUncertain ||
        provider === 'codex' && !initializeHomeConfirmed || provider !== 'codex' && metadata.mode === 'steer') return null;
    const capture = { generation, identity: nativeIdentity, contextId: nativeContext.nativeContextId, terminal: terminalContextId, child, lease: sourceController.captureInstructionLease() };
    return checkInstruction(capture, metadata) ? capture : null;
  }
  function checkInstructionPhysical(capture) {
    return capture && isCurrent(capture.generation) && state === 'running' && child === capture.child &&
      nativeIdentity === capture.identity && ownedSource.facade.checkSource() === true &&
      sourceController.isLeaseTokenCurrent(capture.lease) === true;
  }
  function checkInstruction(capture, metadata) {
    return Boolean(checkInstructionPhysical(capture) && !activeWait && pendingNativeRequests.size === 0 && !instructionUncertain &&
      (!claudeWait || !claudeWait.controller.transitioning() && (metadata.mode !== 'start' || !claudeWait.controller.inputInFlight())) &&
      (!instructionStart || instructionStart.capture === capture) &&
      nativeContext?.nativeContextId === capture.contextId && terminalContextId === capture.terminal &&
      metadata.source.identity.nativeId === nativeIdentity.nativeId &&
      (metadata.mode === 'steer' ? provider === 'codex' && !terminalContextId && metadata.expectedTurnId === capture.contextId :
        terminalContextId === capture.contextId && metadata.source.claims.origin === 'standalone'));
  }
  function checkInstructionEvidence(capture, turnId) {
    return Boolean(checkInstructionPhysical(capture) && nativeContext?.nativeContextId === turnId && !terminalContextId);
  }
  function prepareInstructionWrite(metadata, input, capture) {
    if (!checkInstruction(capture, metadata)) return null;
    const stdin = child.stdin; const write = stdin?.write;
    if (!stdin || typeof write !== 'function' || stdin.destroyed) return null;
    let id = null; let line;
    if (provider === 'codex') {
      id = nextInstructionRpcId;
      if (!Number.isSafeInteger(id) || id < INSTRUCTION_RPC_ID_START) return null;
      nextInstructionRpcId += 1;
      const params = { threadId: nativeIdentity.nativeId, input, clientUserMessageId: metadata.deliveryAttemptId };
      if (metadata.mode === 'steer') params.expectedTurnId = metadata.expectedTurnId;
      else { params.approvalPolicy = 'never'; params.sandboxPolicy = { type: 'readOnly', networkAccess: false }; }
      line = JSON.stringify({ jsonrpc: '2.0', id, method: metadata.mode === 'steer' ? 'turn/steer' : 'turn/start', params });
    } else line = JSON.stringify({ type: 'user', session_id: nativeIdentity.nativeId,
      message: { role: 'user', content: input.map(item => ({ type: 'text', text: item.text })) } });
    return { id, capture, write: write.bind(stdin), line: line + '\n' };
  }
  function registerInstruction(token, prepared, metadata) {
    const pending = { token, capture: prepared.capture, metadata, acknowledged: false, earlyCompletion: null };
    if (prepared.id !== null) instructionRpcs.set(prepared.id, pending);
    if (metadata.mode === 'start') instructionStart = pending;
  }
  function completeInstruction(token, error) {
    if (error && instructionStart?.token === token) instructionUncertain = true;
  }
  function unregisterInstruction(token, prepared) {
    if (prepared.id !== null && instructionRpcs.get(prepared.id)?.token === token) instructionRpcs.delete(prepared.id);
    if (instructionStart?.token === token) instructionStart = null;
  }
  function beginInstructionContext(capture) {
    if (!checkInstructionPhysical(capture) || terminalContextId !== capture.contextId ||
        !sourceController.beginInstructionContext(capture.contextId)) throw runnerError('instruction_context_conflict');
    nativeContext = null; terminalContextId = null; waitCallSeen = false;
    if (claudeWait) activeInputEpoch = nextInputEpoch++;
  }
  function handleInstructionAck(pending, result, rejected) {
    if (!instructionController.isPending(pending.token)) return;
    if (!isSynchronousTrue(isOwnerCurrent) || !isSynchronousTrue(isSourceCurrent) ||
        !instructionController.isPending(pending.token) || !checkInstructionPhysical(pending.capture)) {
      instructionController.acknowledge(pending.token, null, true); return;
    }
    let turnId = pending.metadata.mode === 'steer' ? result?.turnId : result?.turn?.id;
    if (rejected || !isIdentifier(turnId) || !instructionController.canAcknowledge(pending.token, turnId) || !checkInstructionPhysical(pending.capture) ||
        pending.metadata.mode === 'steer' && turnId !== pending.metadata.expectedTurnId ||
        pending.metadata.mode === 'start' && knownInstructionTerminals.has(turnId)) {
      if (pending.metadata.mode === 'start') instructionUncertain = true;
      instructionController.acknowledge(pending.token, null, true); return;
    }
    if (pending.metadata.mode === 'start') {
      if (pending.earlyCompletion && pending.earlyCompletion.turnId !== turnId) {
        instructionUncertain = true; instructionController.acknowledge(pending.token, null, true); return;
      }
      beginInstructionContext(pending.capture);
      instructionStart = null;
      if (pending.earlyCompletion) emitContextEnded(turnId, true);
      else emitContext(turnId);
    }
    instructionController.acknowledge(pending.token, turnId);
  }

  function handleCodexMessage(message) {
    if (!isRecord(message) || (Object.hasOwn(message, 'jsonrpc') && message.jsonrpc !== '2.0')) {
      throw runnerError('codex_message_invalid');
    }
    if (Object.prototype.hasOwnProperty.call(message, 'method')) {
      if (typeof message.method !== 'string' || !message.method ||
          Object.prototype.hasOwnProperty.call(message, 'result') ||
          Object.prototype.hasOwnProperty.call(message, 'error')) {
        throw runnerError('codex_message_invalid');
      }
      if (Object.prototype.hasOwnProperty.call(message, 'id')) {
        if (message.method === 'item/tool/call' && waitProfile) {
          handleWaitToolCall(message);
          return;
        }
        if (['item/tool/requestUserInput', 'item/permissions/requestApproval',
          'item/commandExecution/requestApproval', 'item/fileChange/requestApproval'].includes(message.method)) {
          recordNativeHoldRequest(message);
          return;
        }
        throw runnerError('unknown_server_request');
      }
      if (message.method === 'serverRequest/resolved') {
        resolveNativeHoldRequest(message);
        return;
      }
      if (message.method === 'account/login/completed') {
        handleLoginCompleted(message.params);
        return;
      }
      if ((message.method === 'item/started' || message.method === 'item/completed') && instructionController) {
        const params = message.params;
        if (isRecord(params) && isRecord(params.item)) instructionController.observeItem(params.threadId, params.turnId, params.item);
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
    const pending = pendingRpc && message.id === pendingRpc.id ? pendingRpc : null;
    if (pending) {
      pendingRpc = null;
      if (hasError) pending.reject(runnerError('rpc_rejected'));
      else pending.resolve(message.result);
      return;
    }
    const instruction = instructionRpcs.get(message.id);
    if (instruction) {
      if (instruction.acknowledged) throw runnerError('rpc_response_unexpected');
      instruction.acknowledged = true;
      handleInstructionAck(instruction, hasError ? null : message.result, hasError);
      return;
    }
    const pendingRead = pendingReadRpcs.get(message.id);
    if (pendingRead) {
      pendingReadRpcs.delete(message.id);
      const callback = hasError ? pendingRead.reject : pendingRead.resolve;
      if (typeof callback === 'function') callback(hasError ? runnerError('rpc_rejected') : message.result);
      return;
    }
    if (isIssuedOwnedReadRpcId(message.id)) return;
    throw runnerError('rpc_response_unexpected');
  }

  function claudeResultFingerprint(value) {
    function canonical(item) {
      if (Array.isArray(item)) return item.map(canonical);
      if (item && typeof item === 'object') return Object.fromEntries(Object.keys(item).sort().map(key => [key, canonical(item[key])]));
      return item;
    }
    return crypto.createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
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
      if (typeof message.uuid !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(message.uuid)) {
        throw runnerError('claude_result_uuid_invalid');
      }
      const uuid = message.uuid.toLowerCase();
      const fingerprint = claudeResultFingerprint({ ...message, uuid });
      const known = claudeTerminalResults.get(uuid);
      if (known) {
        if (known !== fingerprint) throw runnerError('claude_result_uuid_conflict');
        return;
      }
      if (claudeTerminalResults.size >= MAX_NATIVE_TERMINALS) throw runnerError('claude_result_uuid_limit');
      claudeTerminalResults.set(uuid, fingerprint);
      if (!nativeContext || terminalContextId || instructionStart) throw runnerError('claude_result_before_context');
      emitContextEnded(nativeContext.nativeContextId);
      activeInputEpoch = 0;
      return;
    }
    if (claudeWait && !instructionStart && claudeWait.controller.observe(message)) return;
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
    if (instructionStart && provider === 'claude') {
      if (!instructionController.isPending(instructionStart.token)) return;
      const pending = instructionStart;
      if (!checkInstructionPhysical(pending.capture) || nativeMessage.id === pending.capture.contextId) {
        instructionUncertain = true; instructionController.acknowledge(pending.token, null, true); return;
      }
      beginInstructionContext(pending.capture);
      if (claudeWait) { claudeWait.controller.observe(message); requireCurrent(pending.capture.generation); }
      emitContext(nativeMessage.id);
      pending.acknowledged = true; instructionStart = null;
      instructionController.acknowledge(pending.token, nativeMessage.id);
      return;
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
      if (sourceController) sourceController.invalidate();
    if (instructionController) instructionController.invalidate();
      if (childTerminationResolve) childTerminationResolve();
      restoreStateAfterLateTermination();
      if (isCurrent(expectedGeneration)) fail('process_exited');
    });
    child.once('close', () => {
      childClosed = true;
      if (sourceController) sourceController.invalidate();
    if (instructionController) instructionController.invalidate();
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

  function notifySourceReady(expectedGeneration) {
    if (!sourceController) return;
    requireOwnerCurrent(expectedGeneration);
    if (sourceReadyNotified || !sourceController.markReady()) throw runnerError('owned_source_unavailable');
    sourceReadyNotified = true;
    let result;
    try {
      result = options.onSourceReady(ownedSource.capability);
    } catch {
      throw runnerError('owned_source_callback_failed');
    }
    try {
      if (result && typeof result.then === 'function') {
        Promise.resolve(result).catch(() => {});
        throw runnerError('owned_source_callback_async');
      }
    } catch (error) {
      if (error instanceof OwnedNativeRunnerError) throw error;
      throw runnerError('owned_source_callback_async');
    }
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
    let argumentsList = buildArguments(provider);
    if (claudeMcpWait) {
      const endpoint = await awaitCurrent(claudeMcpWait.controller.start(), expectedGeneration, timeouts.startupMs, 'claude_wait_start_timeout');
      requireOwnerCurrent(expectedGeneration);
      environment.COCKPIT_NATIVE_MCP_SECRET = endpoint.secret;
      environment.MCP_TOOL_TIMEOUT = '420000';
      environment.CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT = '420000';
      environment.CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS = '0';
      environment.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
      argumentsList = [...argumentsList, '--allowedTools', CLAUDE_WAIT_TOOL, '--permission-mode', 'dontAsk', '--mcp-config', endpoint.mcpConfig];
    }
    let childProcess;
    try {
      childProcess = spawnImpl(executablePath, argumentsList, {
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
    notifySourceReady(expectedGeneration);
  }

  async function startCodex(inputText, expectedGeneration) {
    const initialize = await sendRpc('initialize', {
      clientInfo: { name: 'agent-cockpit', version: '1' },
      capabilities: { experimentalApi: waitProfile },
    }, expectedGeneration);
    requireOwnerCurrent(expectedGeneration);
    if (!isRecord(initialize)) throw runnerError('initialize_result_invalid');
    if (ownedSourceEnabled) {
      const reportedHome = initialize.codexHome;
      const expectedHome = path.join(homePath, '.codex');
      if (typeof reportedHome !== 'string' || !path.isAbsolute(reportedHome) ||
          normalizedPath(path.resolve(reportedHome)) !== normalizedPath(path.resolve(expectedHome))) {
        throw runnerError('codex_home_mismatch');
      }
      initializeHomeConfirmed = true;
    }
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
    const threadStartParams = {
      cwd,
      ephemeral: true,
      approvalPolicy: 'never',
      sandbox: 'read-only',
    };
    if (waitProfile) threadStartParams.dynamicTools = [WAIT_TOOL_SPEC];
    const threadResult = await sendRpc('thread/start', threadStartParams, expectedGeneration);
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
    if (earlyWaitCall && earlyWaitCall.turnId !== turnResult.turn.id) {
      throw runnerError('wait_request_context_mismatch');
    }
    if (earlyTurnCompletion) {
      if (earlyTurnCompletion.threadId !== threadResult.thread.id || earlyTurnCompletion.turnId !== turnResult.turn.id) {
        throw runnerError('native_context_conflict');
      }
      earlyTurnCompletion = null;
      emitContextEnded(turnResult.turn.id, true);
    } else {
      emitContext(turnResult.turn.id);
      const queuedWaitCall = earlyWaitCall;
      earlyWaitCall = null;
      if (queuedWaitCall) activateWaitCall(queuedWaitCall);
    }
    requireCurrent(expectedGeneration);
  }

  async function startClaude(inputText, expectedGeneration) {
    if (claudeWait) activeInputEpoch = nextInputEpoch++;
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
    if (sourceController) sourceController.invalidate();
    if (instructionController) instructionController.invalidate();
    invalidateWait();
    cancelCurrentOperations();
    if (pendingRpc) {
      const pending = pendingRpc;
      pendingRpc = null;
      pending.reject(runnerError('operation_stopped'));
    }
    for (const [id, pending] of pendingReadRpcs) {
      pendingReadRpcs.delete(id);
      if (typeof pending.reject === 'function') pending.reject(runnerError('operation_stopped'));
    }
    pendingReadWrite = null;
    stopPromise = Promise.all([stopChild(child), claudeWait ? claudeWait.controller.stop() : Promise.resolve()]).then(([confirmed]) => {
      if (confirmed || state !== 'stop_unconfirmed') state = 'stopped';
      return safeSnapshot();
    }, () => {
      if (state !== 'stop_unconfirmed') state = 'stopped';
      return safeSnapshot();
    });
    return stopPromise;
  }

  const runner = { start, stop, snapshot: safeSnapshot,
    canPrepareInstruction(value) { return instructionController?.canPrepare(value) === true; },
    captureNativePendingSummary };
  if (waitProfile) {
    runner.releaseWait = releaseWait;
    runner.cancelWait = cancelWait;
  }
  return Object.freeze(runner);
}

module.exports = { OwnedNativeRunnerError, createOwnedNativeRunner, getOwnedSource };
