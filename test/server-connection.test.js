'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { postToServer, serverIsHealthy, ensureServerRunning } = require('../src/client/server-connection');
const { temporaryDirectory } = require('./support/temp');

function serverInfo(port, secret) {
  return { port, secret, pid: 1234, startedAt: '2026-10-05T00:00:00.000Z' };
}

function successResponse() {
  return { ok: true, status: 200, json: async () => ({ accepted: true }) };
}

function healthResponse(info) {
  return { ok: true, json: async () => ({ app: 'agent-cockpit', pid: info.pid, startedAt: info.startedAt }) };
}

function waitForAbort(_url, { signal }) {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
}

test('/health が 120ms より遅く 500ms 以内に返れば健全と判定する', async () => {
  const info = serverInfo(41001, 'secret');
  const healthy = await serverIsHealthy(info, {
    deadline: Date.now() + 1000,
    fetchImpl: async () => {
      await new Promise((resolve) => setTimeout(resolve, 160));
      return healthResponse(info);
    },
  });

  assert.equal(healthy, true);
});

test('/health が期限内に返らず番号へ接続できるときは起動せず server.json の情報を返す', async (t) => {
  const temporary = temporaryDirectory(t, 'agent-cockpit-connection-test-');
  const info = serverInfo(41001, 'secret');
  let starts = 0;
  let portChecks = 0;
  const result = await ensureServerRunning({
    homeDir: temporary.directory,
    deadline: Date.now() + 1400,
    readInfo: async () => info,
    fetchImpl: waitForAbort,
    canConnectToPort: async (port) => {
      assert.equal(port, info.port);
      portChecks += 1;
      return portChecks === 2;
    },
    startServer: async () => { starts += 1; },
  });

  assert.equal(result, info);
  assert.equal(portChecks, 2);
  assert.equal(starts, 0);
});

test('/health の識別が合わない相手には、番号へ接続できても server.json の情報を返さない', async (t) => {
  const temporary = temporaryDirectory(t, 'agent-cockpit-connection-test-');
  const info = serverInfo(41001, 'secret');
  let portChecks = 0;
  const result = await ensureServerRunning({
    homeDir: temporary.directory,
    deadline: Date.now() + 300,
    readInfo: async () => info,
    fetchImpl: async () => ({ ok: true, json: async () => ({ app: 'other-app' }) }),
    canConnectToPort: async () => { portChecks += 1; return true; },
    startServer: async () => {},
  });

  assert.equal(result, null);
  assert.equal(portChecks, 0);
});

test('/health が応答した後に本文を返し切らない相手には、番号へ接続できても server.json の情報を返さない', async (t) => {
  const temporary = temporaryDirectory(t, 'agent-cockpit-connection-test-');
  const info = serverInfo(41001, 'secret');
  let portChecks = 0;
  const result = await ensureServerRunning({
    homeDir: temporary.directory,
    deadline: Date.now() + 700,
    readInfo: async () => info,
    fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }),
    canConnectToPort: async () => { portChecks += 1; return true; },
    startServer: async () => {},
  });

  assert.equal(result, null);
  assert.equal(portChecks, 0);
});

test('/health が期限内に返らず番号へ接続できないときはサーバーを起動する', async (t) => {
  const temporary = temporaryDirectory(t, 'agent-cockpit-connection-test-');
  const info = serverInfo(41001, 'secret');
  let starts = 0;
  let portChecks = 0;
  let started = false;
  const result = await ensureServerRunning({
    homeDir: temporary.directory,
    deadline: Date.now() + 1400,
    readInfo: async () => info,
    fetchImpl: async (url, options) => {
      if (started) return healthResponse(info);
      return waitForAbort(url, options);
    },
    canConnectToPort: async (port) => {
      assert.equal(port, info.port);
      portChecks += 1;
      return false;
    },
    startServer: async () => { starts += 1; started = true; },
  });

  assert.equal(result, info);
  assert.equal(portChecks, 2);
  assert.equal(starts, 1);
});

test('401 の後に server.json を読み直して新しい secret で再送する', async () => {
  const previousInfo = serverInfo(41001, 'old-secret');
  const currentInfo = serverInfo(41002, 'new-secret');
  const requests = [];
  let reads = 0;
  const result = await postToServer('/api/test', { value: 1 }, {
    homeDir: 'unused',
    initialInfo: previousInfo,
    ensure: false,
    readServerInfo: async () => { reads += 1; return currentInfo; },
    fetchImpl: async (url, options) => {
      requests.push({ url, secret: options.headers['x-cockpit-secret'] });
      return requests.length === 1 ? { ok: false, status: 401 } : successResponse();
    },
  });

  assert.deepEqual(result, { ok: true, status: 200, json: { accepted: true } });
  assert.equal(reads, 1);
  assert.deepEqual(requests, [
    { url: 'http://127.0.0.1:41001/api/test', secret: 'old-secret' },
    { url: 'http://127.0.0.1:41002/api/test', secret: 'new-secret' },
  ]);
});

test('401 の後に server.json が無ければ再送しない', async () => {
  let requests = 0;
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    initialInfo: serverInfo(41001, 'old-secret'),
    ensure: false,
    readServerInfo: async () => null,
    fetchImpl: async () => {
      requests += 1;
      return { ok: false, status: 401 };
    },
  });

  assert.deepEqual(result, { ok: false, status: null, json: null });
  assert.equal(requests, 1);
});

test('401 の後に server.json が無ければ指定に応じて最初の情報を再利用する', async () => {
  const secrets = [];
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    initialInfo: serverInfo(41001, 'old-secret'),
    ensure: false,
    reuseInfoOnUnauthorized: true,
    readServerInfo: async () => null,
    fetchImpl: async (_url, options) => {
      secrets.push(options.headers['x-cockpit-secret']);
      return secrets.length === 1 ? { ok: false, status: 401 } : successResponse();
    },
  });

  assert.deepEqual(result, { ok: true, status: 200, json: { accepted: true } });
  assert.deepEqual(secrets, ['old-secret', 'old-secret']);
});

test('接続に失敗したら server.json を読み直して新しい secret で再送する', async () => {
  const currentInfo = serverInfo(41002, 'new-secret');
  const secrets = [];
  let reads = 0;
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    initialInfo: serverInfo(41001, 'old-secret'),
    ensure: false,
    readServerInfo: async () => { reads += 1; return currentInfo; },
    fetchImpl: async (_url, options) => {
      secrets.push(options.headers['x-cockpit-secret']);
      if (secrets.length === 1) throw new Error('ECONNREFUSED');
      return successResponse();
    },
  });

  assert.equal(result.ok, true);
  assert.equal(reads, 1);
  assert.deepEqual(secrets, ['old-secret', 'new-secret']);
});

test('応答本文の読み込みに失敗したら server.json を読み直して再送する', async () => {
  const secrets = [];
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    initialInfo: serverInfo(41001, 'old-secret'),
    ensure: false,
    readServerInfo: async () => serverInfo(41002, 'new-secret'),
    fetchImpl: async (_url, options) => {
      secrets.push(options.headers['x-cockpit-secret']);
      if (secrets.length === 1) {
        return { ok: true, status: 200, json: async () => { throw new Error('invalid JSON'); } };
      }
      return successResponse();
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(secrets, ['old-secret', 'new-secret']);
});

test('2 回目の接続失敗で再送を打ち切る', async () => {
  let requests = 0;
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    initialInfo: serverInfo(41001, 'old-secret'),
    ensure: false,
    readServerInfo: async () => serverInfo(41002, 'new-secret'),
    fetchImpl: async () => {
      requests += 1;
      throw new Error('ECONNREFUSED');
    },
  });

  assert.deepEqual(result, { ok: false, status: null, json: null });
  assert.equal(requests, 2);
});

test('試行の締切が応答本文の読み込みにも適用される', async () => {
  let jsonStarted = false;
  let requestSignal;
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    initialInfo: serverInfo(41001, 'secret'),
    ensure: false,
    timeoutMs: 500,
    attemptTimeoutMs: 20,
    readServerInfo: async () => null,
    fetchImpl: async (_url, options) => {
      requestSignal = options.signal;
      return {
        ok: true,
        status: 200,
        json: async () => {
          jsonStarted = true;
          return new Promise(() => {});
        },
      };
    },
  });

  assert.deepEqual(result, { ok: false, status: null, json: null });
  assert.equal(jsonStarted, true);
  assert.equal(requestSignal.aborted, true);
});

test('retryAfterTimeout が false のとき試行タイムアウトを再送せず timedOut を返す', async () => {
  let ensureCalls = 0;
  let requests = 0;
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    timeoutMs: 200,
    attemptTimeoutMs: 20,
    retryAfterTimeout: false,
    ensure: async () => {
      ensureCalls += 1;
      return serverInfo(41001, 'secret');
    },
    fetchImpl: async (_url, options) => {
      requests += 1;
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });

  assert.deepEqual(result, { ok: false, status: null, json: null, timedOut: true });
  assert.equal(requests, 1);
  assert.equal(ensureCalls, 1);
});

test('既定の retryAfterTimeout はタイムアウト後に再送する', async () => {
  let requests = 0;
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    initialInfo: serverInfo(41001, 'secret'),
    ensure: false,
    timeoutMs: 500,
    attemptTimeoutMs: 20,
    readServerInfo: async () => serverInfo(41001, 'secret'),
    fetchImpl: async (_url, options) => {
      requests += 1;
      if (requests === 1) {
        return new Promise((_, reject) => {
          options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      }
      return successResponse();
    },
  });

  assert.deepEqual(result, { ok: true, status: 200, json: { accepted: true } });
  assert.equal(requests, 2);
});

test('retryAfterTimeout が false でも接続拒否は再試行する', async () => {
  let ensureCalls = 0;
  let requests = 0;
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    retryAfterTimeout: false,
    ensure: async () => {
      ensureCalls += 1;
      return serverInfo(41001, 'secret');
    },
    fetchImpl: async () => {
      requests += 1;
      if (requests === 1) throw new Error('ECONNREFUSED');
      return successResponse();
    },
  });

  assert.deepEqual(result, { ok: true, status: 200, json: { accepted: true } });
  assert.equal(requests, 2);
  assert.equal(ensureCalls, 2);
});
