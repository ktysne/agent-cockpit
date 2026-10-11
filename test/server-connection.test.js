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

test('既定policyとunknown-result policyの両方で401後に新secretを使う', async () => {
  const previousInfo = serverInfo(41001, 'old-secret');
  const currentInfo = serverInfo(41002, 'new-secret');
  for (const retryAfterUnknownResult of [undefined, false]) {
    const requests = [];
    let reads = 0;
    const result = await postToServer('/api/test', { value: 1 }, {
      homeDir: 'unused',
      initialInfo: previousInfo,
      ensure: false,
      ...(retryAfterUnknownResult === undefined ? {} : { retryAfterUnknownResult }),
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
  }
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

test('401後に新secretで再送した要求が結果不明なら追加再送しない', async () => {
  const secrets = [];
  let reads = 0;
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    initialInfo: serverInfo(41001, 'old-secret'),
    ensure: false,
    retryAfterUnknownResult: false,
    readServerInfo: async () => {
      reads += 1;
      return serverInfo(41002, 'new-secret');
    },
    fetchImpl: async (_url, options) => {
      secrets.push(options.headers['x-cockpit-secret']);
      if (secrets.length === 1) return { ok: false, status: 401 };
      throw Object.freeze(Object.assign(new Error('response lost'), { requestStarted: false, code: 'DEADLINE_TIMEOUT' }));
    },
  });

  assert.deepEqual(result, {
    ok: false,
    status: null,
    json: null,
    outcomeUnknown: true,
    code: 'REQUEST_OUTCOME_UNKNOWN',
  });
  assert.deepEqual(secrets, ['old-secret', 'new-secret']);
  assert.equal(reads, 1);
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

test('本文準備中に期限が尽きた場合は再試行せず未到達として返す', async () => {
  for (const retryAfterTimeout of [false, true]) {
    let now = 0;
    let ensureCalls = 0;
    let readCalls = 0;
    let requests = 0;
    const body = {
      toJSON: () => {
        now = 100;
        return { value: 1 };
      },
    };
    const result = await postToServer('/api/test', body, {
      homeDir: 'unused',
      initialInfo: serverInfo(41001, 'secret'),
      deadline: 100,
      retryAfterTimeout,
      retryAfterUnknownResult: false,
      now: () => now,
      ensure: async () => { ensureCalls += 1; return serverInfo(41002, 'new-secret'); },
      readServerInfo: async () => { readCalls += 1; return serverInfo(41002, 'new-secret'); },
      fetchImpl: async () => { requests += 1; return successResponse(); },
    });

    assert.deepEqual(result, { ok: false, status: null, json: null });
    assert.equal(ensureCalls, 0);
    assert.equal(readCalls, 0);
    assert.equal(requests, 0);
  }
});

test('初回のensureが期限を使い切った場合は未到達として返す', async () => {
  let now = 0;
  let requests = 0;
  let ensureCalls = 0;
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    deadline: 100,
    retryAfterTimeout: false,
    now: () => now,
    ensure: async () => {
      ensureCalls += 1;
      now = 100;
      return serverInfo(41001, 'secret');
    },
    fetchImpl: async () => { requests += 1; return successResponse(); },
  });

  assert.deepEqual(result, { ok: false, status: null, json: null });
  assert.equal(ensureCalls, 1);
  assert.equal(requests, 0);
});

test('接続拒否後のensureが期限を使い切った場合は未到達として返す', async () => {
  let now = 0;
  let requests = 0;
  let ensureCalls = 0;
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    initialInfo: serverInfo(41001, 'secret'),
    deadline: 100,
    retryAfterTimeout: false,
    now: () => now,
    ensure: async () => {
      ensureCalls += 1;
      now = 100;
      return serverInfo(41002, 'new-secret');
    },
    fetchImpl: async () => {
      requests += 1;
      throw new Error('ECONNREFUSED');
    },
  });

  assert.deepEqual(result, { ok: false, status: null, json: null });
  assert.equal(ensureCalls, 1);
  assert.equal(requests, 1);
});

test('送信開始後に全体期限を超えた場合は timedOut を返す', async () => {
  let ensureCalls = 0;
  let requests = 0;
  let requestSignal;
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    timeoutMs: 200,
    attemptTimeoutMs: 500,
    retryAfterTimeout: false,
    ensure: async () => {
      ensureCalls += 1;
      return serverInfo(41001, 'secret');
    },
    fetchImpl: async (_url, options) => {
      requests += 1;
      requestSignal = options.signal;
      return new Promise((_, reject) => {
        options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      });
    },
  });

  assert.deepEqual(result, { ok: false, status: null, json: null, timedOut: true });
  assert.equal(requests, 1);
  assert.equal(ensureCalls, 1);
  assert.equal(requestSignal.aborted, true);
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

test('maxAttempts 1 では応答喪失後にPOSTを再送しない', async () => {
  let requests = 0;
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    initialInfo: serverInfo(41001, 'secret'),
    ensure: false,
    maxAttempts: 1,
    readServerInfo: async () => serverInfo(41002, 'new-secret'),
    fetchImpl: async () => {
      requests += 1;
      throw new Error('response lost');
    },
  });

  assert.deepEqual(result, { ok: false, status: null, json: null });
  assert.equal(requests, 1);
});

test('不正な maxAttempts は常駐サーバーを起動する前に拒否する', async () => {
  let starts = 0;
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    maxAttempts: 3,
    ensureServerRunning: async () => { starts += 1; return serverInfo(41001, 'secret'); },
  });
  assert.deepEqual(result, { ok: false, status: null, json: null });
  assert.equal(starts, 0);
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

test('送信開始後の各種応答喪失は外部error属性を読まず結果不明で停止する', async () => {
  const reasons = [undefined, null, false, 0, '', Object.freeze(Object.defineProperties({}, {
    requestStarted: { value: false, enumerable: true },
    code: { value: 'DEADLINE_TIMEOUT', enumerable: true },
  }))];

  for (const reason of reasons) {
    let requests = 0;
    let reads = 0;
    const result = await postToServer('/api/test', {}, {
      homeDir: 'unused',
      initialInfo: serverInfo(41001, 'secret'),
      ensure: false,
      retryAfterUnknownResult: false,
      readServerInfo: async () => { reads += 1; return serverInfo(41002, 'new-secret'); },
      fetchImpl: async () => {
        requests += 1;
        throw reason;
      },
    });

    assert.deepEqual(result, {
      ok: false,
      status: null,
      json: null,
      outcomeUnknown: true,
      code: 'REQUEST_OUTCOME_UNKNOWN',
    });
    assert.equal(requests, 1);
    assert.equal(reads, 0);
  }

  let getterRequests = 0;
  const getterError = Object.freeze(Object.defineProperties({}, {
    requestStarted: { get() { throw new Error('requestStarted getter ran'); } },
    code: { get() { throw new Error('code getter ran'); } },
  }));
  const getterResult = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    initialInfo: serverInfo(41001, 'secret'),
    ensure: false,
    retryAfterUnknownResult: false,
    fetchImpl: async () => { getterRequests += 1; throw getterError; },
  });
  assert.equal(getterResult.outcomeUnknown, true);
  assert.equal(getterRequests, 1);
});

test('unknown-result policyはhealth GETをPOST開始として扱わない', async () => {
  const methods = [];
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    retryAfterUnknownResult: false,
    ensure: async ({ fetchImpl }) => {
      await fetchImpl('http://127.0.0.1:41001/health', { method: 'GET' });
      return serverInfo(41001, 'secret');
    },
    fetchImpl: async (_url, options) => {
      methods.push(options.method);
      if (options.method === 'POST') throw new Error('response lost');
      return { ok: true, status: 200 };
    },
  });

  assert.equal(result.outcomeUnknown, true);
  assert.deepEqual(methods, ['GET', 'POST']);
});

test('実際の試行タイマーは結果不明とtimedOutを記録し、遅れて解決しても再送しない', async () => {
  let requests = 0;
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    initialInfo: serverInfo(41001, 'secret'),
    ensure: false,
    retryAfterUnknownResult: false,
    timeoutMs: 300,
    attemptTimeoutMs: 10,
    fetchImpl: async () => {
      requests += 1;
      return new Promise((resolve) => setTimeout(() => resolve(successResponse()), 30));
    },
  });

  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(result, {
    ok: false,
    status: null,
    json: null,
    outcomeUnknown: true,
    code: 'REQUEST_OUTCOME_UNKNOWN',
    timedOut: true,
  });
  assert.equal(requests, 1);
});

test('同期fetch throwは開始済みunknownとして一度だけ処理する', async () => {
  let requests = 0;
  let reads = 0;
  const failure = Object.freeze(Object.assign(new Error('response lost'), {
    requestStarted: false,
    code: 'DEADLINE_TIMEOUT',
  }));
  const result = await postToServer('/api/test', {}, {
    homeDir: 'unused',
    initialInfo: serverInfo(41001, 'secret'),
    ensure: false,
    retryAfterUnknownResult: false,
    readServerInfo: async () => { reads += 1; return serverInfo(41002, 'new-secret'); },
    fetchImpl: () => {
      requests += 1;
      throw failure;
    },
  });

  assert.deepEqual(result, {
    ok: false,
    status: null,
    json: null,
    outcomeUnknown: true,
    code: 'REQUEST_OUTCOME_UNKNOWN',
  });
  assert.equal(requests, 1);
  assert.equal(reads, 0);
});

test('JSON待機中の実timeoutはunknownで停止し、遅延settle後も再送しない', async () => {
  let resolveJson;
  let settleJsonObserver;
  let jsonCalled = false;
  let requests = 0;
  let ensureCalls = 0;
  let reads = 0;
  const pendingJson = new Promise((resolve) => { resolveJson = resolve; });
  const jsonSettled = new Promise((resolve) => { settleJsonObserver = resolve; });
  const resultPromise = postToServer('/api/test', {}, {
    homeDir: 'unused',
    timeoutMs: 300,
    attemptTimeoutMs: 10,
    retryAfterUnknownResult: false,
    ensure: async () => {
      ensureCalls += 1;
      return serverInfo(41001, 'secret');
    },
    readServerInfo: async () => {
      reads += 1;
      return serverInfo(41002, 'new-secret');
    },
    fetchImpl: () => {
      requests += 1;
      return {
        ok: true,
        status: 200,
        json: () => {
          jsonCalled = true;
          const operation = pendingJson.then((value) => value);
          operation.then(settleJsonObserver, settleJsonObserver);
          return operation;
        },
      };
    },
  });

  const result = await resultPromise;
  assert.deepEqual(result, {
    ok: false,
    status: null,
    json: null,
    outcomeUnknown: true,
    code: 'REQUEST_OUTCOME_UNKNOWN',
    timedOut: true,
  });
  assert.equal(jsonCalled, true);
  assert.equal(requests, 1);
  assert.equal(ensureCalls, 1);
  assert.equal(reads, 0);

  resolveJson({ accepted: true });
  await jsonSettled;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests, 1);
  assert.equal(ensureCalls, 1);
  assert.equal(reads, 0);
});

test('MCP向けpolicyでは送信前の準備失敗を結果不明にしない', async () => {
  let requests = 0;
  const result = await postToServer('/api/test', {
    toJSON() { throw new Error('serialization failed'); },
  }, {
    homeDir: 'unused',
    initialInfo: serverInfo(41001, 'secret'),
    ensure: false,
    maxAttempts: 1,
    retryAfterUnknownResult: false,
    fetchImpl: async () => { requests += 1; return successResponse(); },
  });

  assert.deepEqual(result, { ok: false, status: null, json: null });
  assert.equal(requests, 0);
});
