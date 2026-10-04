'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { postToServer } = require('../src/client/server-connection');

function serverInfo(port, secret) {
  return { port, secret, pid: 1234, startedAt: '2026-10-05T00:00:00.000Z' };
}

function successResponse() {
  return { ok: true, status: 200, json: async () => ({ accepted: true }) };
}

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
