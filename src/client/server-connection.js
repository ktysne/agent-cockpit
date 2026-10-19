'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const net = require('node:net');
const { cockpitHomeFromOptions } = require('../server/identity');
const { isGithubCredentialEnvironmentVariable } = require('../server/credential-environment');
const { DEFAULT_PORT } = require('../server/server-constants');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'server.js');
const SERVER_PORT = Number(process.env.AGENT_COCKPIT_PORT || DEFAULT_PORT);
const HOOK_TIMEOUT_MS = 1000;

function serverInfoPath(homeDir) {
  return path.join(homeDir, 'server.json');
}

async function readServerInfo(homeDir, fileSystem = fsp) {
  try {
    const value = JSON.parse(await fileSystem.readFile(serverInfoPath(homeDir), 'utf8'));
    if (
      !value || !Number.isInteger(value.port) || typeof value.secret !== 'string' ||
      !Number.isInteger(value.pid) || typeof value.startedAt !== 'string'
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function childEnvironment(environment) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('CLAUDE_CODE_') &&
    !isGithubCredentialEnvironmentVariable(key)));
}

async function launchServer({ homeDir, environment = process.env, spawnProcess = spawn }) {
  await fsp.mkdir(homeDir, { recursive: true });
  const logPath = path.join(homeDir, 'server.log');
  try {
    if ((await fsp.stat(logPath)).size > 1024 * 1024 && !await serverIsHealthy(await readServerInfo(homeDir))) {
      await fsp.rename(logPath, `${logPath}.1`);
    }
  } catch {}
  const logFd = fs.openSync(logPath, 'a');
  try {
    const child = spawnProcess(process.execPath, [SERVER_SCRIPT, '--port', String(SERVER_PORT)], {
      cwd: homeDir,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: childEnvironment(environment),
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
}

async function acquireStartLock(homeDir, now = Date.now(), fileSystem = fsp) {
  const lockPath = path.join(homeDir, 'start.lock');
  await fileSystem.mkdir(homeDir, { recursive: true });
  const token = `${process.pid}-${now}-${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fileSystem.open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: now }));
      await handle.close();
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST') return null;
      try {
        const stat = await fileSystem.stat(lockPath);
        if (now - stat.mtimeMs <= 10_000) return null;
        await fileSystem.rm(lockPath);
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function releaseStartLock(homeDir, token, fileSystem = fsp) {
  if (!token) return;
  const lockPath = path.join(homeDir, 'start.lock');
  try {
    const lock = JSON.parse(await fileSystem.readFile(lockPath, 'utf8'));
    if (lock.token === token) await fileSystem.rm(lockPath, { force: true });
  } catch {
    return;
  }
}

async function fetchWithDeadline(fetchImpl, url, options, deadline, attemptTimeoutMs, now = Date.now, readResponse) {
  const remaining = deadline - now();
  if (remaining <= 0) {
    const error = new Error('server request deadline elapsed');
    error.code = 'DEADLINE_TIMEOUT';
    throw error;
  }
  const controller = new AbortController();
  let timeout;
  try {
    return await Promise.race([
      (async () => {
        const response = await fetchImpl(url, { ...options, signal: controller.signal });
        return readResponse ? readResponse(response) : response;
      })(),
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const deadlineReached = remaining <= attemptTimeoutMs;
          const error = new Error(deadlineReached
            ? 'server request deadline elapsed'
            : 'server request attempt timed out');
          error.code = deadlineReached ? 'DEADLINE_TIMEOUT' : 'ATTEMPT_TIMEOUT';
          reject(error);
          controller.abort();
        }, Math.min(attemptTimeoutMs, remaining));
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function canConnectToPort(port, { deadline = Date.now() + 200, now = Date.now } = {}) {
  const timeoutMs = Math.min(200, deadline - now());
  if (timeoutMs <= 0) return false;

  return new Promise((resolve) => {
    let socket;
    let settled = false;
    const timeout = setTimeout(() => finish(false), timeoutMs);
    const finish = (connected) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      socket?.destroy();
      resolve(connected);
    };

    try {
      socket = net.createConnection({ host: '127.0.0.1', port });
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
      socket.once('timeout', () => finish(false));
    } catch {
      finish(false);
    }
  });
}

// 'healthy'、応答が何も届かないまま期限を過ぎた 'timeout'、それ以外(接続できない、別のアプリ、別の起動)の 'unhealthy' を返す。
// 応答が届いてから本文が期限に間に合わない相手は、本文を返し切らない別のアプリかもしれないので 'timeout' にしない。
async function serverHealth(info, { fetchImpl = fetch, deadline = Date.now() + 250, now = Date.now } = {}) {
  if (!info) return 'unhealthy';
  let responseReceived = false;
  try {
    const result = await fetchWithDeadline(
      fetchImpl,
      `http://127.0.0.1:${info.port}/health`,
      { method: 'GET' },
      deadline,
      Math.min(500, deadline - now()),
      now,
      async (response) => {
        responseReceived = true;
        return { ok: response.ok, json: response.ok ? await response.json() : null };
      },
    );
    if (!result.ok) return 'unhealthy';
    const health = result.json;
    return health.app === 'agent-cockpit' && health.pid === info.pid && health.startedAt === info.startedAt ? 'healthy' : 'unhealthy';
  } catch (error) {
    const timedOut = error?.code === 'ATTEMPT_TIMEOUT' || error?.code === 'DEADLINE_TIMEOUT';
    return timedOut && !responseReceived ? 'timeout' : 'unhealthy';
  }
}

async function serverIsHealthy(info, options) {
  return await serverHealth(info, options) === 'healthy';
}

async function waitForHealthyServer(homeDir, { fetchImpl = fetch, deadline, intervalMs = 35, readInfo = readServerInfo, fileSystem, now = Date.now } = {}) {
  while (now() < deadline) {
    const info = await readInfo(homeDir, fileSystem);
    if (await serverIsHealthy(info, { fetchImpl, deadline: Math.min(deadline, now() + 150), now })) return info;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - now()))));
  }
  return null;
}

async function ensureServerRunning({
  homeDir,
  fetchImpl = fetch,
  startServer = (args) => launchServer(args),
  environment = process.env,
  deadline = Date.now() + HOOK_TIMEOUT_MS,
  readInfo = readServerInfo,
  fileSystem = fsp,
  canConnectToPort: checkPort = canConnectToPort,
  now = Date.now,
} = {}) {
  // 応答が遅いだけで番号が埋まっていれば、起動しても EADDRINUSE で終わるので起動しない。
  // 応答はあるが識別が合わないときは別のアプリなので、秘密値を送らないよう server.json の情報を返さない。
  const reusableInfo = async (current) => {
    const health = await serverHealth(current, { fetchImpl, deadline, now });
    if (health === 'healthy') return current;
    if (health === 'timeout' && await checkPort(current.port ?? DEFAULT_PORT, { deadline, now })) return current;
    return null;
  };
  let info = await readInfo(homeDir, fileSystem);
  const reused = await reusableInfo(info);
  if (reused) return reused;

  const token = await acquireStartLock(homeDir, now(), fileSystem);
  if (!token) return waitForHealthyServer(homeDir, { fetchImpl, deadline, readInfo, fileSystem, now });

  try {
    info = await readInfo(homeDir, fileSystem);
    const reusedAfterLock = await reusableInfo(info);
    if (reusedAfterLock) return reusedAfterLock;
    await startServer({ homeDir, environment });
    return await waitForHealthyServer(homeDir, { fetchImpl, deadline, readInfo, fileSystem, now });
  } catch {
    return null;
  } finally {
    await releaseStartLock(homeDir, token, fileSystem);
  }
}

async function requestFromServer(info, requestPath, init, {
  fetchImpl = fetch,
  deadline = Date.now() + HOOK_TIMEOUT_MS,
  attemptTimeoutMs = 1000,
  now = Date.now,
} = {}) {
  if (!info) return { ok: false, status: null, json: null };
  try {
    const result = await fetchWithDeadline(
      fetchImpl,
      `http://127.0.0.1:${info.port}${requestPath}`,
      init,
      deadline,
      attemptTimeoutMs,
      now,
      async (response) => ({
        ok: response.ok,
        status: response.status,
        json: response.ok ? await response.json() : null,
      }),
    );
    return result;
  } catch {
    return { ok: false, status: null, json: null };
  }
}

async function postToServer(requestPath, body, options = {}) {
  const homeDir = options.homeDir || cockpitHomeFromOptions(options);
  const fetchImpl = options.fetchImpl || fetch;
  const environment = options.environment || process.env;
  const now = options.now || Date.now;
  const deadline = options.deadline ?? now() + (options.timeoutMs || HOOK_TIMEOUT_MS);
  const fileSystem = options.fileSystem || fsp;
  const readInfo = options.readServerInfo || readServerInfo;
  const ensureSetting = Object.hasOwn(options, 'ensure') ? options.ensure : true;
  const retryAfterUnknownOutcome = options.retryAfterUnknownOutcome ?? true;
  const ensureServer = ensureSetting === false
    ? null
    : typeof ensureSetting === 'function'
      ? ensureSetting
      : options.ensureServerRunning || ensureServerRunning;
  const ensureOptions = {
    homeDir,
    fetchImpl,
    environment,
    deadline,
    startServer: options.startServer || ((args) => launchServer(args)),
    canConnectToPort: options.canConnectToPort,
    readInfo,
    fileSystem,
    now,
  };
  let info;
  try {
    if (Object.hasOwn(options, 'initialInfo')) info = options.initialInfo;
    else if (ensureServer) info = await ensureServer(ensureOptions);
    else info = await readInfo(homeDir, fileSystem);
  } catch {
    return { ok: false, status: null, json: null };
  }

  for (let attempt = 0; attempt < 2 && now() < deadline; attempt += 1) {
    if (!info) return { ok: false, status: null, json: null };
    try {
      const remaining = deadline - now();
      const requestOptions = {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cockpit-secret': info.secret },
        body: JSON.stringify(body),
      };
      if (options.cache) requestOptions.cache = options.cache;
      options.onServerInfo?.(info);
      const result = await fetchWithDeadline(
        fetchImpl,
        `http://127.0.0.1:${info.port}${requestPath}`,
        requestOptions,
        deadline,
        Math.min(options.attemptTimeoutMs || remaining, remaining),
        now,
        async (response) => ({
          response,
          json: response.ok
            ? (options.parseJson !== false ? await response.json() : undefined)
            : (options.errorJson ? await response.json().catch(() => null) : null),
        }),
      );
      const { response, json } = result;
      if (response.ok) {
        return { ok: true, status: response.status, json };
      }
      if (response.status !== 401 || attempt > 0) return { ok: false, status: response.status, json };
      const replacement = await readInfo(homeDir, fileSystem);
      info = replacement || (options.reuseInfoOnUnauthorized ? info : null);
    } catch (error) {
      if (retryAfterUnknownOutcome === false && (error?.code === 'ATTEMPT_TIMEOUT' || error?.code === 'DEADLINE_TIMEOUT')) {
        return { ok: false, status: null, json: null, timedOut: true };
      }
      if (retryAfterUnknownOutcome === false && error?.cause?.code !== 'ECONNREFUSED') {
        return { ok: false, status: null, json: null, outcomeUnknown: true };
      }
      if (attempt > 0) return { ok: false, status: null, json: null };
      try {
        if (ensureServer) info = await ensureServer(ensureOptions);
        else info = await readInfo(homeDir, fileSystem);
      } catch {
        return { ok: false, status: null, json: null };
      }
    }
  }
  if (retryAfterUnknownOutcome === false && now() >= deadline) {
    return { ok: false, status: null, json: null, timedOut: true };
  }
  return { ok: false, status: null, json: null };
}

module.exports = {
  DEFAULT_PORT,
  HOOK_TIMEOUT_MS,
  acquireStartLock,
  canConnectToPort,
  childEnvironment,
  ensureServerRunning,
  fetchWithDeadline,
  launchServer,
  postToServer,
  readServerInfo,
  releaseStartLock,
  requestFromServer,
  serverInfoPath,
  serverIsHealthy,
  waitForHealthyServer,
};
