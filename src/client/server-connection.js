'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
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
  const logFd = fs.openSync(logPath, 'w');
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
    error.requestStarted = false;
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
          error.requestStarted = true;
          reject(error);
          controller.abort();
        }, Math.min(attemptTimeoutMs, remaining));
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

async function serverIsHealthy(info, { fetchImpl = fetch, deadline = Date.now() + 250, now = Date.now } = {}) {
  if (!info) return false;
  try {
    const result = await fetchWithDeadline(
      fetchImpl,
      `http://127.0.0.1:${info.port}/health`,
      { method: 'GET' },
      deadline,
      120,
      now,
      async (response) => ({ ok: response.ok, json: response.ok ? await response.json() : null }),
    );
    if (!result.ok) return false;
    const health = result.json;
    return health.app === 'agent-cockpit' && health.pid === info.pid && health.startedAt === info.startedAt;
  } catch {
    return false;
  }
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
  now = Date.now,
} = {}) {
  let info = await readInfo(homeDir, fileSystem);
  if (await serverIsHealthy(info, { fetchImpl, deadline, now })) return info;

  const token = await acquireStartLock(homeDir, now(), fileSystem);
  if (!token) return waitForHealthyServer(homeDir, { fetchImpl, deadline, readInfo, fileSystem, now });

  try {
    info = await readInfo(homeDir, fileSystem);
    if (await serverIsHealthy(info, { fetchImpl, deadline, now })) return info;
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
  const maxAttempts = options.maxAttempts ?? 2;
  if (![1, 2].includes(maxAttempts)) return { ok: false, status: null, json: null };
  const homeDir = options.homeDir || cockpitHomeFromOptions(options);
  const fetchImpl = options.fetchImpl || fetch;
  const environment = options.environment || process.env;
  const now = options.now || Date.now;
  const deadline = options.deadline ?? now() + (options.timeoutMs || HOOK_TIMEOUT_MS);
  const fileSystem = options.fileSystem || fsp;
  const readInfo = options.readServerInfo || readServerInfo;
  const ensureSetting = Object.hasOwn(options, 'ensure') ? options.ensure : true;
  const retryAfterTimeout = options.retryAfterTimeout ?? true;
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

  for (let attempt = 0; attempt < maxAttempts && now() < deadline; attempt += 1) {
    if (!info) return { ok: false, status: null, json: null };
    try {
      const remaining = deadline - now();
      const requestOptions = {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cockpit-secret': info.secret },
        body: JSON.stringify(body),
      };
      if (options.cache) requestOptions.cache = options.cache;
      const result = await fetchWithDeadline(
        fetchImpl,
        `http://127.0.0.1:${info.port}${requestPath}`,
        requestOptions,
        deadline,
        Math.min(options.attemptTimeoutMs || remaining, remaining),
        now,
        async (response) => ({
          response,
          json: response.ok && options.parseJson !== false ? await response.json() : undefined,
          errorJson: !response.ok && options.parseErrorJson ? await response.json().catch(() => null) : undefined,
        }),
      );
      const { response, json, errorJson } = result;
      if (response.ok) {
        return { ok: true, status: response.status, json };
      }
      if (response.status !== 401 || attempt + 1 >= maxAttempts) {
        return { ok: false, status: response.status, json: null, ...(errorJson === undefined ? {} : { errorJson }) };
      }
      const replacement = await readInfo(homeDir, fileSystem);
      info = replacement || (options.reuseInfoOnUnauthorized ? info : null);
    } catch (error) {
      if (error?.requestStarted === false && error.code === 'DEADLINE_TIMEOUT') {
        return { ok: false, status: null, json: null };
      }
      if (retryAfterTimeout === false && error?.requestStarted === true &&
          (error.code === 'ATTEMPT_TIMEOUT' || error.code === 'DEADLINE_TIMEOUT')) {
        return { ok: false, status: null, json: null, timedOut: true };
      }
      if (attempt + 1 >= maxAttempts) return { ok: false, status: null, json: null };
      try {
        if (ensureServer) info = await ensureServer(ensureOptions);
        else info = await readInfo(homeDir, fileSystem);
      } catch {
        return { ok: false, status: null, json: null };
      }
    }
  }
  return { ok: false, status: null, json: null };
}

module.exports = {
  DEFAULT_PORT,
  HOOK_TIMEOUT_MS,
  acquireStartLock,
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
