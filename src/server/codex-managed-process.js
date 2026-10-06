'use strict';

const { createHash, randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createCodexManagedTransport } = require('./codex-managed-transport');

const DEFAULT_START_TIMEOUT_MS = 5000;
const DEFAULT_STOP_TIMEOUT_MS = 2000;
const DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
const CONNECT_RETRY_DELAY_MS = 100;
const CONNECT_ATTEMPT_TIMEOUT_MS = 1000;
const MAX_TIMEOUT_MS = 60_000;
const ENVIRONMENT_ALLOWLIST = Object.freeze([
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC',
]);

class ManagedProcessError extends Error {
  constructor(code) {
    super('managed Codex process operation failed');
    this.name = 'ManagedProcessError';
    this.code = code;
  }
}

function processError(code) {
  return new ManagedProcessError(code);
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) && !value.startsWith('-');
}

function normalizeTimeout(value, fallback, name) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 50 || value > MAX_TIMEOUT_MS) throw processError(`invalid_${name}`);
  return value;
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function isPathWithin(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function validateExecutable(executablePath) {
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) {
    throw processError('absolute_executable_path_required');
  }
  try {
    const stat = fs.lstatSync(executablePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw processError('invalid_executable');
  } catch (error) {
    if (error instanceof ManagedProcessError) throw error;
    throw processError('executable_unavailable');
  }
  return path.resolve(executablePath);
}

function pathParts(absolutePath) {
  const parsed = path.parse(absolutePath);
  return {
    root: parsed.root,
    parts: path.relative(parsed.root, absolutePath).split(path.sep).filter(Boolean),
  };
}

function assertNoSymlinkComponents(absolutePath, allowMissingLeaf = false) {
  const { root, parts } = pathParts(absolutePath);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (allowMissingLeaf && error && error.code === 'ENOENT') return;
      throw processError('managed_home_unavailable');
    }
    if (stat.isSymbolicLink()) throw processError('managed_home_symlink');
    if (index < parts.length - 1 && !stat.isDirectory()) throw processError('managed_home_invalid_path');
  }
}

function assertDirectory(absolutePath) {
  assertNoSymlinkComponents(absolutePath);
  try {
    if (!fs.lstatSync(absolutePath).isDirectory()) throw processError('managed_home_invalid_path');
    const realPath = fs.realpathSync.native(absolutePath);
    if (normalizedPath(realPath) !== normalizedPath(absolutePath)) throw processError('managed_home_symlink');
  } catch (error) {
    if (error instanceof ManagedProcessError) throw error;
    throw processError('managed_home_unavailable');
  }
}

function validateManagedPaths(managedHomeRoot, managedHomePath, environment) {
  if (typeof managedHomeRoot !== 'string' || !path.isAbsolute(managedHomeRoot) ||
      typeof managedHomePath !== 'string' || !path.isAbsolute(managedHomePath)) {
    throw processError('absolute_managed_home_required');
  }
  const root = path.resolve(managedHomeRoot);
  const home = path.resolve(managedHomePath);
  assertDirectory(root);
  const normalizedRoot = normalizedPath(root);
  const normalizedHome = normalizedPath(home);
  const relative = path.relative(normalizedRoot, normalizedHome);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw processError('managed_home_outside_root');
  }
  const defaultCodexHome = path.join(os.homedir(), '.codex');
  const configuredCodexHome = environment && typeof environment.CODEX_HOME === 'string' &&
    path.isAbsolute(environment.CODEX_HOME) ? environment.CODEX_HOME : null;
  for (const ordinaryHome of [defaultCodexHome, configuredCodexHome].filter(Boolean)) {
    const ordinary = normalizedPath(path.resolve(ordinaryHome));
    if (normalizedHome === ordinary || isPathWithin(normalizedHome, ordinary)) {
      throw processError('ordinary_codex_home_forbidden');
    }
  }
  return { root, home };
}

function ensureManagedHome(root, home) {
  assertDirectory(root);
  const relative = path.relative(root, home);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw processError('managed_home_outside_root');
  }
  let current = root;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw processError('managed_home_create_failed');
    }
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw processError('managed_home_symlink');
      if (!stat.isDirectory()) throw processError('managed_home_invalid_path');
    } catch (error) {
      if (error instanceof ManagedProcessError) throw error;
      throw processError('managed_home_create_failed');
    }
  }
  assertDirectory(home);
  const realRoot = normalizedPath(fs.realpathSync.native(root));
  const realHome = normalizedPath(fs.realpathSync.native(home));
  if (!isPathWithin(realRoot, realHome) || realRoot === realHome) throw processError('managed_home_outside_root');
  for (const subdirectory of [
    'tmp',
    path.join('AppData', 'Roaming'),
    path.join('AppData', 'Local'),
    '.config',
    path.join('.local', 'share'),
    '.cache',
  ]) {
    ensureManagedSubdirectory(home, subdirectory);
  }
}

function ensureManagedSubdirectory(home, relativeDirectory) {
  let current = home;
  for (const part of relativeDirectory.split(path.sep)) {
    current = path.join(current, part);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if (!error || error.code !== 'EEXIST') throw processError('managed_home_create_failed');
    }
    try {
      const stat = fs.lstatSync(current);
      if (stat.isSymbolicLink()) throw processError('managed_home_symlink');
      if (!stat.isDirectory()) throw processError('managed_home_invalid_path');
    } catch (error) {
      if (error instanceof ManagedProcessError) throw error;
      throw processError('managed_home_create_failed');
    }
  }
  const realHome = normalizedPath(fs.realpathSync.native(home));
  const realDirectory = normalizedPath(fs.realpathSync.native(current));
  if (!isPathWithin(realHome, realDirectory)) throw processError('managed_home_outside_root');
}

function chooseLoopbackPort(netImpl = net) {
  return new Promise((resolve, reject) => {
    const probe = netImpl.createServer();
    probe.once('error', () => reject(processError('loopback_port_unavailable')));
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string' || !Number.isInteger(address.port) || address.port < 1) {
        probe.close(() => reject(processError('loopback_port_unavailable')));
        return;
      }
      probe.close((error) => error
        ? reject(processError('loopback_port_unavailable'))
        : resolve(address.port));
    });
  });
}

function createChildEnvironment(sourceEnvironment, managedHomePath, tokenVariable, token) {
  const result = {};
  for (const key of ENVIRONMENT_ALLOWLIST) {
    if (typeof sourceEnvironment[key] === 'string') result[key] = sourceEnvironment[key];
  }
  const temporaryPath = path.join(managedHomePath, 'tmp');
  result.CODEX_HOME = managedHomePath;
  result.HOME = managedHomePath;
  result.USERPROFILE = managedHomePath;
  result.APPDATA = path.join(managedHomePath, 'AppData', 'Roaming');
  result.LOCALAPPDATA = path.join(managedHomePath, 'AppData', 'Local');
  result.TEMP = temporaryPath;
  result.TMP = temporaryPath;
  result.XDG_CONFIG_HOME = path.join(managedHomePath, '.config');
  result.XDG_DATA_HOME = path.join(managedHomePath, '.local', 'share');
  result.XDG_CACHE_HOME = path.join(managedHomePath, '.cache');
  if (tokenVariable && token) result[tokenVariable] = token;
  return result;
}

function waitForSpawn(child, timeoutMs, records) {
  const record = records.get(child);
  return new Promise((resolve, reject) => {
    if (!record || record.exited) {
      reject(processError('process_spawn_failed'));
      return;
    }
    let settled = false;
    const timer = setTimeout(() => finish(processError('process_spawn_timeout')), timeoutMs);
    const onSpawn = () => finish(null);
    const onError = () => finish(processError('process_spawn_failed'));
    const onExit = () => finish(processError('process_exited_early'));
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('spawn', onSpawn);
      child.removeListener('error', onError);
      child.removeListener('exit', onExit);
      if (error) reject(error);
      else resolve();
    }
    child.once('spawn', onSpawn);
    child.once('error', onError);
    child.once('exit', onExit);
    if (typeof child.pid === 'number' && child.pid > 0) queueMicrotask(onSpawn);
  });
}

function delay(timeoutMs) {
  return new Promise((resolve) => setTimeout(resolve, timeoutMs));
}

function publicTransportFailure(code) {
  if (code === 'connect_timeout') return 'transport_connect_timeout';
  if (code === 'connection_failed') return 'transport_connection_failed';
  if (code === 'connection_closed') return 'transport_connection_closed';
  if (code === 'handshake_timeout') return 'transport_handshake_timeout';
  return 'transport_connect_failed';
}

function registerOwnedChild(child, records, kind) {
  const record = { child, kind, exited: false, exitCode: null, signal: null, exitPromise: null, resolveExit: null };
  record.exitPromise = new Promise((resolve) => { record.resolveExit = resolve; });
  const markExited = (code, signal) => {
    if (record.exited) return;
    record.exited = true;
    record.exitCode = Number.isInteger(code) ? code : null;
    record.signal = typeof signal === 'string' ? signal : null;
    record.resolveExit();
  };
  child.once('exit', markExited);
  child.once('close', markExited);
  child.once('error', () => {
    if (!record.child.pid) markExited(null, null);
  });
  records.set(child, record);
  return record;
}

async function stopOwnedChild(record, timeoutMs) {
  if (!record || record.exited) return true;
  try {
    record.child.kill('SIGTERM');
  } catch {}
  if (await waitForOwnedExit(record, timeoutMs)) return true;
  try {
    record.child.kill('SIGKILL');
  } catch {}
  return waitForOwnedExit(record, timeoutMs);
}

function waitForOwnedExit(record, timeoutMs) {
  if (record.exited) return Promise.resolve(true);
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => finish(false), timeoutMs);
    record.exitPromise.then(() => finish(true));
    function finish(exited) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(exited);
    }
  });
}

function makeServerArguments(port, token) {
  const digest = createHash('sha256').update(token, 'utf8').digest('hex');
  return [
    'app-server',
    '--listen', `ws://127.0.0.1:${port}`,
    '--ws-auth', 'capability-token',
    '--ws-token-sha256', digest,
  ];
}

function makeRemoteCliArguments(threadId, endpoint, tokenVariable) {
  if (!isIdentifier(threadId)) throw processError('invalid_thread_id');
  return [
    'resume', threadId,
    '--remote', endpoint,
    '--remote-auth-token-env', tokenVariable,
    '--no-alt-screen',
  ];
}

function pathsEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !path.isAbsolute(left) || !path.isAbsolute(right)) {
    return false;
  }
  return normalizedPath(left) === normalizedPath(right);
}

function createCodexManagedProcessManager(options = {}) {
  const environment = options.environment || process.env;
  const executablePath = validateExecutable(options.executablePath);
  const { root: managedHomeRoot, home: managedHomePath } = validateManagedPaths(
    options.managedHomeRoot,
    options.managedHomePath,
    environment,
  );
  if (!isIdentifier(options.hostId) || !isIdentifier(options.homeScopeId)) {
    throw processError('managed_home_scope_required');
  }
  const startTimeoutMs = normalizeTimeout(options.startTimeoutMs, DEFAULT_START_TIMEOUT_MS, 'start_timeout');
  const stopTimeoutMs = normalizeTimeout(options.stopTimeoutMs, DEFAULT_STOP_TIMEOUT_MS, 'stop_timeout');
  const connectTimeoutMs = normalizeTimeout(options.connectTimeoutMs, DEFAULT_CONNECT_TIMEOUT_MS, 'connect_timeout');
  const spawnImpl = options.spawnImpl || spawn;
  const choosePortImpl = options.choosePortImpl || (() => chooseLoopbackPort(options.netImpl || net));
  const transportFactory = options.transportFactory || createCodexManagedTransport;
  const randomBytesImpl = options.randomBytesImpl || randomBytes;
  const tokenVariable = `CODEX_REMOTE_AUTH_TOKEN_${randomBytesImpl(6).toString('hex').toUpperCase()}`;
  const ownedChildren = new Map();
  const transports = new Set();
  const remoteCliRecords = new Set();
  let state = 'created';
  let endpoint = null;
  let capabilityToken = null;
  let serverRecord = null;
  let startPromise = null;
  let stopPromise = null;
  let failureCode = null;

  function safeSnapshot() {
    return Object.freeze({
      provider: 'codex',
      hostId: options.hostId,
      homeScopeId: options.homeScopeId,
      managedHomePath,
      endpoint,
      state,
      failureCode,
      ownedRemoteCliCount: remoteCliRecords.size,
    });
  }

  async function startImpl() {
    if (state !== 'created') throw processError('manager_already_started');
    state = 'starting';
    try {
      ensureManagedHome(managedHomeRoot, managedHomePath);
      const port = await choosePortImpl();
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw processError('loopback_port_unavailable');
      endpoint = `ws://127.0.0.1:${port}`;
      capabilityToken = randomBytesImpl(32).toString('hex');
      if (!/^[0-9a-f]{64}$/.test(capabilityToken)) throw processError('invalid_capability_token');
      const args = makeServerArguments(port, capabilityToken);
      const childEnvironment = createChildEnvironment(environment, managedHomePath);
      let child;
      try {
        child = spawnImpl(executablePath, args, {
          cwd: managedHomePath,
          env: childEnvironment,
          stdio: ['ignore', 'ignore', 'ignore'],
          windowsHide: true,
          shell: false,
        });
      } catch {
        throw processError('server_spawn_failed');
      } finally {
        for (const key of Object.keys(childEnvironment)) {
          if (key === 'CODEX_HOME' || key === 'HOME' || key === 'USERPROFILE' || key === 'APPDATA' ||
              key === 'LOCALAPPDATA' || key === 'TEMP' || key === 'TMP' || key.startsWith('XDG_')) {
            childEnvironment[key] = '';
          }
        }
      }
      serverRecord = registerOwnedChild(child, ownedChildren, 'app-server');
      child.once('exit', () => {
        if (state === 'running') {
          state = 'exited';
          failureCode = 'server_exited';
        }
      });
      await waitForSpawn(child, startTimeoutMs, ownedChildren);
      state = 'running';
      return safeSnapshot();
    } catch (error) {
      failureCode = error instanceof ManagedProcessError ? error.code : 'server_start_failed';
      state = 'failed';
      if (serverRecord) await stopOwnedChild(serverRecord, stopTimeoutMs);
      capabilityToken = null;
      throw error instanceof ManagedProcessError ? error : processError('server_start_failed');
    }
  }

  function start() {
    if (!startPromise) startPromise = startImpl();
    return startPromise;
  }

  async function connect(callbacks = {}) {
    if (state !== 'running' || !endpoint || !capabilityToken) throw processError('server_not_running');
    if (typeof callbacks.onNotification !== 'function' || typeof callbacks.onServerRequest !== 'function' ||
        typeof callbacks.onDisconnect !== 'function') {
      throw processError('transport_callbacks_required');
    }
    const deadline = Date.now() + connectTimeoutMs;
    let lastFailureCode = 'transport_connect_failed';
    while (state === 'running' && Date.now() < deadline) {
      let transport;
      let established = false;
      const remainingMs = deadline - Date.now();
      const attemptTimeoutMs = Math.min(options.transportTimeoutMs || CONNECT_ATTEMPT_TIMEOUT_MS, remainingMs);
      if (attemptTimeoutMs < 50) break;
      const onDisconnect = (event) => {
        if (!established) return;
        if (transport) transports.delete(transport);
        try { callbacks.onDisconnect(event); } catch {}
      };
      try {
        transport = await transportFactory({
          endpoint,
          capabilityToken,
          timeoutMs: attemptTimeoutMs,
          onNotification: callbacks.onNotification,
          onServerRequest: callbacks.onServerRequest,
          onDisconnect,
        });
        established = true;
        transports.add(transport);
        return transport;
      } catch (error) {
        lastFailureCode = error && typeof error.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code)
          ? error.code
          : 'transport_connect_failed';
        if (lastFailureCode === 'handshake_rejected') throw processError('transport_auth_rejected');
        if (state !== 'running' || (serverRecord && serverRecord.exited)) throw processError('server_not_running');
        await delay(Math.min(CONNECT_RETRY_DELAY_MS, Math.max(0, deadline - Date.now())));
      }
    }
    throw processError(publicTransportFailure(lastFailureCode));
  }

  async function launchRemoteCLI({ threadId } = {}) {
    if (state !== 'running' || !endpoint || !capabilityToken) throw processError('server_not_running');
    if (!isIdentifier(threadId)) throw processError('invalid_thread_id');
    let preflightTransport;
    try {
      preflightTransport = await transportFactory({
        endpoint,
        capabilityToken,
        timeoutMs: options.transportTimeoutMs,
        onNotification() {},
        onServerRequest() {},
        onDisconnect() {},
      });
      transports.add(preflightTransport);
      const initialize = await preflightTransport.request('initialize', {
        clientInfo: { name: 'agent-cockpit-remote-preflight', version: '0.1.0' },
        capabilities: { experimentalApi: false },
      });
      if (!isRecord(initialize) || !pathsEqual(initialize.codexHome, managedHomePath)) {
        throw processError('managed_home_mismatch');
      }
      await preflightTransport.notify('initialized', {});
      if (!await preflightTransport.confirmLoadedThread(threadId)) throw processError('thread_not_loaded');
    } catch (error) {
      throw error instanceof ManagedProcessError ? error : processError('remote_preflight_failed');
    } finally {
      if (preflightTransport) {
        transports.delete(preflightTransport);
        try { preflightTransport.close(); } catch {}
      }
    }
    const args = makeRemoteCliArguments(threadId, endpoint, tokenVariable);
    const childEnvironment = createChildEnvironment(environment, managedHomePath, tokenVariable, capabilityToken);
    let child;
    try {
      child = spawnImpl(executablePath, args, {
        cwd: managedHomePath,
        env: childEnvironment,
        stdio: 'inherit',
        windowsHide: false,
        shell: false,
      });
    } catch {
      throw processError('remote_cli_spawn_failed');
    } finally {
      for (const key of Object.keys(childEnvironment)) childEnvironment[key] = '';
    }
    const record = registerOwnedChild(child, ownedChildren, 'remote-cli');
    remoteCliRecords.add(record);
    record.exitPromise.finally(() => remoteCliRecords.delete(record));
    try {
      await waitForSpawn(child, startTimeoutMs, ownedChildren);
    } catch (error) {
      await stopOwnedChild(record, stopTimeoutMs);
      throw error instanceof ManagedProcessError ? error : processError('remote_cli_spawn_failed');
    }
    return Object.freeze({
      snapshot: () => Object.freeze({ state: record.exited ? 'exited' : 'running' }),
      stop: () => stopOwnedChild(record, stopTimeoutMs),
    });
  }

  function stop() {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      if (startPromise) {
        try { await startPromise; } catch {}
      }
      if (state === 'stopped') return safeSnapshot();
      state = 'stopping';
      for (const transport of [...transports]) {
        try { transport.close(); } catch {}
      }
      transports.clear();
      const cliChildren = [...remoteCliRecords];
      for (const record of cliChildren) await stopOwnedChild(record, stopTimeoutMs);
      if (serverRecord) await stopOwnedChild(serverRecord, stopTimeoutMs);
      capabilityToken = null;
      endpoint = null;
      state = 'stopped';
      return safeSnapshot();
    })();
    return stopPromise;
  }

  return Object.freeze({
    start,
    connect,
    launchRemoteCLI,
    stop,
    snapshot: safeSnapshot,
  });
}

module.exports = {
  ManagedProcessError,
  createCodexManagedProcessManager,
  makeRemoteCliArguments,
};
