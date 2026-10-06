'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { assertNoSymlinkComponents, REPOSITORY_ROOT } = require('../codex-hooks-identity/setup');

const MAX_HTTP_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_CHILD_TIMEOUT_MS = 15000;
const CHILD_ENVIRONMENT_KEYS = Object.freeze([
  'PATH', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT',
]);

class CockpitProbeError extends Error {
  constructor(kind) {
    super(kind);
    this.name = 'CockpitProbeError';
    this.kind = kind;
  }
}

function safeErrorKind(error, fallback = 'cockpit_probe_failed') {
  const value = error && (error.kind || error.code);
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : fallback;
}

function childEnvironment(parentEnvironment = process.env) {
  const environment = {};
  for (const name of CHILD_ENVIRONMENT_KEYS) {
    if (typeof parentEnvironment[name] === 'string') environment[name] = parentEnvironment[name];
  }
  return environment;
}

function validateOwnedPaths({ outputDirectory, homeDir, claudeHome, userHome }) {
  const output = path.resolve(outputDirectory);
  const outputParent = path.join(REPOSITORY_ROOT, 'poc', 'out');
  if (path.dirname(output) !== outputParent || !/^poc162-[a-z0-9][a-z0-9-]{0,48}$/i.test(path.basename(output))) {
    throw new CockpitProbeError('cockpit_output_invalid');
  }
  assertNoSymlinkComponents(REPOSITORY_ROOT, output);
  const outputStat = fs.lstatSync(output);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw new CockpitProbeError('cockpit_output_invalid');
  const targets = [homeDir, claudeHome, userHome].map((value) => path.resolve(value));
  const normalizedTargets = targets.map((target) => process.platform === 'win32' ? target.toLowerCase() : target);
  if (new Set(normalizedTargets).size !== targets.length
    || normalizedTargets.some((target, index) => normalizedTargets.some((other, otherIndex) => (
      index !== otherIndex && other.startsWith(target + path.sep.toLowerCase())
    )))) throw new CockpitProbeError('cockpit_homes_must_be_distinct');
  for (const target of targets) {
    const relative = path.relative(output, target);
    if (relative && !path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`)) {
      assertNoSymlinkComponents(output, target);
    } else {
      throw new CockpitProbeError('cockpit_home_outside_output');
    }
  }
  return { output, homeDir: targets[0], claudeHome: targets[1], userHome: targets[2] };
}

function createChildChannel(child) {
  let closed = false;
  let exitCode = null;
  let spawnFailed = false;
  let ipcDisconnected = false;
  const listeners = new Set();
  child.on('message', (message) => {
    for (const listener of [...listeners]) listener(message);
  });
  child.once('close', (code) => {
    closed = true;
    exitCode = Number.isInteger(code) ? code : null;
    for (const listener of [...listeners]) listener({ kind: 'child_closed' });
  });
  child.once('error', () => {
    spawnFailed = true;
    for (const listener of [...listeners]) listener({ kind: 'child_error' });
  });
  child.once('disconnect', () => {
    ipcDisconnected = true;
    for (const listener of [...listeners]) listener({ kind: 'child_disconnected' });
  });
  return {
    get closed() { return closed; },
    get exitCode() { return exitCode; },
    waitForMessage(predicate, timeoutMs) {
      return new Promise((resolve, reject) => {
        if (closed || spawnFailed || ipcDisconnected) {
          return reject(new CockpitProbeError(spawnFailed ? 'cockpit_child_spawn_failed' : 'cockpit_child_closed'));
        }
        const finish = (error, value) => {
          clearTimeout(timer);
          listeners.delete(onMessage);
          if (error) reject(error);
          else resolve(value);
        };
        const onMessage = (message) => {
          if (predicate(message)) finish(null, message);
          else if (message?.kind === 'child_closed') finish(new CockpitProbeError('cockpit_child_closed'));
          else if (message?.kind === 'child_error') finish(new CockpitProbeError('cockpit_child_spawn_failed'));
          else if (message?.kind === 'child_disconnected') finish(new CockpitProbeError('cockpit_child_closed'));
        };
        const timer = setTimeout(() => finish(new CockpitProbeError('cockpit_child_timeout')), timeoutMs);
        listeners.add(onMessage);
      });
    },
    send(message) {
      return new Promise((resolve, reject) => {
        if (closed || !child.connected) return reject(new CockpitProbeError('cockpit_child_closed'));
        child.send(message, (error) => error
          ? reject(new CockpitProbeError('cockpit_child_send_failed'))
          : resolve(true));
      });
    },
  };
}

function createCockpitChild(options, dependencies = {}) {
  validateOwnedPaths(options);
  const forkImpl = dependencies.fork || fork;
  const child = forkImpl(__filename, ['--owned-child'], {
    cwd: REPOSITORY_ROOT,
    env: childEnvironment(dependencies.environment || process.env),
    execArgv: [],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    windowsHide: true,
  });
  const channel = createChildChannel(child);
  let secrets = null;
  let startPromise = null;
  let stopPromise = null;
  return {
    child,
    get closed() { return channel.closed; },
    get exitCode() { return channel.exitCode; },
    async start(timeoutMs = DEFAULT_CHILD_TIMEOUT_MS) {
      if (startPromise) return startPromise;
      startPromise = (async () => {
        const readyPromise = channel.waitForMessage((message) => ['ready', 'failed'].includes(message?.kind), timeoutMs);
        readyPromise.catch(() => {});
        await channel.send({
          kind: 'start',
          outputDirectory: path.resolve(options.outputDirectory),
          homeDir: path.resolve(options.homeDir),
          claudeHome: path.resolve(options.claudeHome),
          userHome: path.resolve(options.userHome),
        });
        const ready = await readyPromise;
        if (ready.kind !== 'ready') throw new CockpitProbeError(ready.error || 'cockpit_start_failed');
        secrets = {
          port: ready.port,
          secret: ready.secret,
          uiSecret: ready.uiSecret,
        };
        if (!Number.isInteger(secrets.port) || secrets.port < 1
          || typeof secrets.secret !== 'string' || typeof secrets.uiSecret !== 'string') {
          throw new CockpitProbeError('cockpit_ready_invalid');
        }
        return { port: secrets.port, secret: secrets.secret, uiSecret: secrets.uiSecret };
      })();
      return startPromise;
    },
    get credentials() {
      return secrets && { ...secrets };
    },
    async stop(timeoutMs = DEFAULT_CHILD_TIMEOUT_MS) {
      if (stopPromise) return stopPromise;
      stopPromise = (async () => {
        let stoppedAck = false;
        if (!channel.closed) {
          try {
            const stoppedPromise = channel.waitForMessage((message) => message?.kind === 'stopped', timeoutMs);
            stoppedPromise.catch(() => {});
            await channel.send({ kind: 'stop' });
            const response = await stoppedPromise;
            stoppedAck = response.closed === true;
          } catch {
            try { if (!channel.closed) child.kill(); } catch {}
          }
        }
        if (!channel.closed) {
          await Promise.race([
            new Promise((resolve) => child.once('close', () => resolve(true))),
            new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
          ]);
        }
        if (!channel.closed) {
          try { child.kill(); } catch {}
          await Promise.race([
            new Promise((resolve) => child.once('close', () => resolve(true))),
            new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
          ]);
        }
        return { stop_acknowledged: stoppedAck, exit_observed: channel.closed, exit_code: channel.exitCode };
      })();
      return stopPromise;
    },
  };
}

function requestCockpit({ port, method = 'GET', pathname, headers = {}, body, timeoutMs = DEFAULT_CHILD_TIMEOUT_MS }, dependencies = {}) {
  const httpImpl = dependencies.http || http;
  if (!Number.isInteger(port) || port < 1 || port > 65535 || typeof pathname !== 'string' || !pathname.startsWith('/')) {
    return Promise.reject(new CockpitProbeError('cockpit_request_invalid'));
  }
  const bodyText = body === undefined ? null : JSON.stringify(body);
  const requestHeaders = { ...headers };
  if (bodyText !== null && !Object.keys(requestHeaders).some((name) => name.toLowerCase() === 'content-length')) {
    requestHeaders['content-length'] = Buffer.byteLength(bodyText);
  }
  return new Promise((resolve, reject) => {
    let settled = false;
    let responseBytes = 0;
    const chunks = [];
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(value);
    };
    const request = httpImpl.request({ host: '127.0.0.1', port, method, path: pathname, headers: requestHeaders }, (response) => {
      response.on('data', (chunk) => {
        responseBytes += chunk.length;
        if (responseBytes > MAX_HTTP_RESPONSE_BYTES) {
          response.destroy();
          finish(new CockpitProbeError('cockpit_response_too_large'));
          return;
        }
        chunks.push(Buffer.from(chunk));
      });
      response.once('error', () => finish(new CockpitProbeError('cockpit_response_error')));
      response.once('end', () => {
        let json = null;
        try { json = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch {}
        finish(null, { status: response.statusCode || 0, headers: response.headers, json });
      });
    });
    request.setTimeout(timeoutMs, () => request.destroy(new CockpitProbeError('cockpit_request_timeout')));
    request.once('error', (error) => finish(new CockpitProbeError(safeErrorKind(error, 'cockpit_request_error'))));
    if (bodyText !== null) request.write(bodyText);
    request.end();
  });
}

async function startOwnedCockpitChild(options) {
  const { startServer } = require('../../src/server/server');
  const noOpTracker = {
    start() {},
    close() {},
    snapshot() { return []; },
    refreshRepo() { return Promise.resolve(); },
    refreshAll() { return Promise.resolve(); },
  };
  const noOpMergeManager = {
    start() {},
    close() {},
    handleDetectedMerge() {},
    handleDetectedClose() {},
    checkReservations() {},
  };
  const runtime = await startServer({
    homeDir: options.homeDir,
    claudeHome: options.claudeHome,
    userHome: options.userHome,
    port: 0,
    truncateLog: true,
    pullRequestTracker: noOpTracker,
    pullRequestMergeManager: noOpMergeManager,
    codexAgentScriptExists: async () => false,
    crossReviewToolExists: async () => false,
  });
  return runtime;
}

async function childMain() {
  let runtime = null;
  let startupPromise = null;
  let closePromise = null;
  let closingRequested = false;
  const send = (message) => new Promise((resolve) => {
    if (!process.connected) return resolve(false);
    process.send(message, () => resolve(true));
  });
  const close = async () => {
    if (closePromise) return closePromise;
    closingRequested = true;
    closePromise = (async () => {
      if (startupPromise) {
        try { await startupPromise; } catch {}
      }
      try {
        await runtime?.close();
        await send({ kind: 'stopped', closed: true });
        return true;
      } catch {
        await send({ kind: 'stopped', closed: false });
        return false;
      } finally {
        if (process.connected) process.disconnect();
      }
    })();
    return closePromise;
  };
  process.once('SIGINT', () => { void close(); });
  process.once('SIGTERM', () => { void close(); });
  process.once('disconnect', () => { void close(); });
  process.on('message', async (message) => {
    if (message?.kind === 'start' && !runtime && !startupPromise && !closingRequested) {
      startupPromise = (async () => {
        try {
          const validated = validateOwnedPaths(message);
          runtime = await startOwnedCockpitChild({ ...message, ...validated });
          if (closingRequested) return;
          await send({
            kind: 'ready',
            port: runtime.info.port,
            secret: runtime.info.secret,
            uiSecret: runtime.info.uiSecret,
          });
        } catch (error) {
          await send({ kind: 'failed', error: safeErrorKind(error, 'cockpit_start_failed') });
          if (process.connected) process.disconnect();
          throw error;
        }
      })();
      startupPromise.catch(() => {});
    } else if (message?.kind === 'stop') {
      await close();
    }
  });
}

if (require.main === module && process.argv.includes('--owned-child')) childMain().catch(() => {
  try { if (process.connected) process.send({ kind: 'failed', error: 'cockpit_start_failed' }, () => process.disconnect()); } catch {}
});

module.exports = {
  CockpitProbeError,
  DEFAULT_CHILD_TIMEOUT_MS,
  MAX_HTTP_RESPONSE_BYTES,
  childEnvironment,
  createCockpitChild,
  requestCockpit,
  safeErrorKind,
  validateOwnedPaths,
};
