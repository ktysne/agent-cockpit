const test = require('node:test');
const assert = require('node:assert/strict');
const { verifyHealth } = require('../src/client/server-verification');

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
    }, commitVerified: true, identityMatches: true,
  });
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
});
