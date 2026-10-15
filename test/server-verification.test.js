const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyHealth, verifyServer } = require('../src/client/server-verification');

const expected = { version: '1.4.0', commit: 'a'.repeat(40) };
const started = { pid: 456, startedAt: '2026-10-15T00:00:00.000Z' };
const health = {
  app: 'agent-cockpit',
  ...started,
  version: expected.version,
  commit: expected.commit,
  sourceState: 'pending',
};

test('起動情報とバージョンと取得できたコミットが一致すれば ok を返す', () => {
  assert.deepEqual(verifyHealth(expected, started, health), {
    result: 'ok', expected, running: {
      version: expected.version, commit: expected.commit, sourceState: 'pending',
    }, commitVerified: true, releaseVerified: false, identityMatches: true,
  });
});

test('公開タグと同じソース状態のときだけ releaseVerified を true にする', () => {
  for (const sourceState of ['dirty', 'diverged', 'unknown', 'pending', null]) {
    const result = verifyHealth(expected, started, { ...health, sourceState });
    assert.equal(result.result, 'ok');
    assert.equal(result.commitVerified, true);
    assert.equal(result.releaseVerified, false);
  }
  assert.equal(verifyHealth(expected, started, { ...health, sourceState: 'release' }).releaseVerified, true);
});

test('バージョンが違うと mismatch を返す', () => {
  assert.equal(verifyHealth(expected, started, { ...health, version: '1.3.0' }).result, 'mismatch');
});

test('取得できた期待コミットと違うと mismatch を返す', () => {
  assert.equal(verifyHealth(expected, started, { ...health, commit: 'b'.repeat(40) }).result, 'mismatch');
});

test('health にバージョンが無いと mismatch を返す', () => {
  const { version, ...withoutVersion } = health;
  assert.equal(verifyHealth(expected, started, withoutVersion).result, 'mismatch');
});

test('期待コミットを取得できないときはバージョンだけ照合する', () => {
  const result = verifyHealth({ ...expected, commit: null }, started, { ...health, commit: 'b'.repeat(40) });
  assert.equal(result.result, 'ok');
  assert.equal(result.commitVerified, false);
  assert.equal(result.releaseVerified, false);
});

test('health を取得できないと releaseVerified が false の start-failed を返す', () => {
  assert.deepEqual(verifyHealth(expected, started, null), {
    result: 'start-failed', expected, running: null, commitVerified: false, releaseVerified: false,
  });
});

test('pending の sourceState を取り直し release に確定した結果を返す', async () => {
  let now = 0;
  const states = ['pending', 'release'];
  const result = await verifyServer(started, {
    expected,
    settleSourceState: true,
    now: () => now,
    sleep: async duration => { now += duration; },
    requestFromServer: async () => ({ ok: true, json: { ...health, sourceState: states.shift() } }),
  });
  assert.equal(result.running.sourceState, 'release');
  assert.equal(result.result, 'ok');
  assert.equal(result.releaseVerified, true);
});

test('sourceState が期限内に確定しなければ pending のまま releaseVerified を false にする', async () => {
  let now = 0;
  let requests = 0;
  const result = await verifyServer(started, {
    expected,
    settleSourceState: true,
    sourceStateIntervalMs: 5000,
    now: () => now,
    sleep: async duration => { now += duration; },
    requestFromServer: async () => { requests += 1; return { ok: true, json: health }; },
  });
  assert.equal(requests, 2);
  assert.equal(result.result, 'ok');
  assert.equal(result.running.sourceState, 'pending');
  assert.equal(result.releaseVerified, false);
});

test('取り直し中に pid または startedAt が変わると mismatch を返す', async () => {
  for (const identityChange of [{ pid: 999 }, { startedAt: 'other' }]) {
    const responses = [health, { ...health, ...identityChange }];
    const result = await verifyServer(started, {
      expected,
      settleSourceState: true,
      now: () => 0,
      sleep: async () => {},
      requestFromServer: async () => ({ ok: true, json: responses.shift() }),
    });
    assert.equal(result.result, 'mismatch');
    assert.equal(result.identityMatches, false);
    assert.equal(result.releaseVerified, false);
  }
});

test('sourceState が無い応答は取り直さずそのまま返す', async () => {
  let requests = 0;
  const { sourceState, ...withoutSourceState } = health;
  const result = await verifyServer(started, {
    expected,
    settleSourceState: true,
    requestFromServer: async () => { requests += 1; return { ok: true, json: withoutSourceState }; },
  });
  assert.equal(requests, 1);
  assert.equal(result.running.sourceState, null);
  assert.equal(result.releaseVerified, false);
});

test('取り直し中の health 取得に失敗すると最後の結果を返す', async () => {
  let requests = 0;
  const result = await verifyServer(started, {
    expected,
    settleSourceState: true,
    now: () => 0,
    sleep: async () => {},
    requestFromServer: async () => {
      if (++requests === 1) return { ok: true, json: health };
      return { ok: false, json: null };
    },
  });
  assert.equal(result.result, 'ok');
  assert.equal(result.running.sourceState, 'pending');
  assert.equal(result.releaseVerified, false);
});
