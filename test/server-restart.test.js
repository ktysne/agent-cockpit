const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { startTestServer, request, jsonBody, uiHeaders } = require('./support/server');

async function restartFixture(t, options = {}) {
  const calls = [];
  let now = Date.now();
  const serverRestart = { now: () => now, spawnImpl(...args) {
    options.onSpawn?.();
    calls.push(args);
    const child = new EventEmitter();
    child.unref = () => { child.unreferenced = true; };
    calls.at(-1).child = child;
    process.nextTick(() => child.emit('spawn'));
    return child;
  } };
  const fixture = await startTestServer(t, { appVersion: 'before-update', serverRestart, ...options });
  const { info } = fixture;
  const state = () => request(info.port, { path: '/api/state' });
  const post = (body = {}, headers = uiHeaders(info, `http://127.0.0.1:${info.port}`)) => request(info.port, {
    method: 'POST', path: '/api/server/restart', headers, body: JSON.stringify(body),
  });
  await state();
  return { ...fixture, calls, post, state, advance: ms => { now += ms; } };
}

test('再起動の口は画面用の秘密値と同一 Origin を照合する', async t => {
  const f = await restartFixture(t);
  assert.equal((await f.post({}, {})).status, 401);
  assert.equal((await f.post({}, uiHeaders(f.info, 'https://example.com'))).status, 403);
  assert.equal((await f.post({}, uiHeaders(f.info))).status, 403);
  assert.equal(f.calls.length, 0);
});

test('明示しない再起動と dev の再起動は利用できない', async t => {
  for (const options of [{ serverRestart: undefined }, { dev: true }]) {
    const f = await restartFixture(t, options);
    assert.equal(jsonBody(await f.state()).restartAvailable, false);
    const response = await f.post();
    assert.equal(response.status, 409);
    assert.deepEqual(jsonBody(response), { error: 'Restart unavailable' });
    assert.equal(f.calls.length, 0);
  }
});

test('配置済みの版が同じなら再起動せず 409 を返す', async t => {
  const f = await restartFixture(t, { appVersion: require('../package.json').version });
  const response = await f.post();
  assert.equal(response.status, 409);
  assert.deepEqual(jsonBody(response), { error: 'Restart not required' });
  assert.equal(f.calls.length, 0);
});

test('再起動の口は JSON オブジェクトだけを受け付ける', async t => {
  const f = await restartFixture(t);
  for (const body of [null, [], 'restart', 1]) assert.equal((await f.post(body)).status, 400);
  assert.equal((await f.post({ extra: true })).status, 202);
});

test('保存の書き出し後に同じ保存先とポートで再起動の子を起動する', async t => {
  const flushed = [];
  const f = await restartFixture(t, { onSpawn: () => {
    assert.deepEqual([...flushed].sort(), ['flush', 'flush', 'flushPersistence', 'flushPersistence']);
  } });
  for (const [target, method] of [[f.runtime.state, 'flushPersistence'], [f.runtime.away, 'flushPersistence'],
    [f.runtime.routing, 'flush'], [f.runtime.diagnostics, 'flush']]) {
    const original = target[method].bind(target);
    target[method] = async () => { await original(); flushed.push(method); };
  }
  const response = await f.post();
  assert.equal(response.status, 202);
  assert.deepEqual(jsonBody(response), { restarting: true });
  const [command, args, options] = f.calls[0];
  assert.equal(command, process.execPath);
  assert.deepEqual(args, [path.resolve(__dirname, '../src/client/restart-server.js'), '--json',
    '--expect-pid', String(f.info.pid), '--expect-started-at', f.info.startedAt]);
  assert.equal(options.detached, true);
  assert.equal(options.windowsHide, true);
  assert.equal(options.cwd, f.homeDir);
  assert.equal(options.env.AGENT_COCKPIT_HOME, f.homeDir);
  assert.equal(options.env.AGENT_COCKPIT_PORT, String(f.info.port));
  assert.equal(options.env.CLAUDE_CODE_MESSAGING_TOKEN, undefined);
  assert.deepEqual(options.stdio, ['ignore', options.stdio[1], options.stdio[1]]);
  assert.equal(Number.isInteger(options.stdio[1]), true);
  assert.equal(f.calls[0].child.unreferenced, true);
});

test('再起動中は 409 と新しい ETag を返し 60 秒後に再び受け付ける', async t => {
  const f = await restartFixture(t);
  const before = await f.state();
  assert.equal(jsonBody(before).restartAvailable, true);
  await f.post();
  const during = await f.state();
  assert.equal(jsonBody(during).restartAvailable, false);
  assert.notEqual(during.headers.etag, before.headers.etag);
  const second = await f.post();
  assert.equal(second.status, 409);
  assert.deepEqual(jsonBody(second), { error: 'Restart in progress' });
  f.advance(60_001);
  assert.equal(jsonBody(await f.state()).restartAvailable, true);
  assert.equal((await f.post()).status, 202);
});

test('子の起動に失敗したら 500 を返して再試行できる', async t => {
  const f = await restartFixture(t, { serverRestart: { spawnImpl() {
    const child = new EventEmitter();
    process.nextTick(() => child.emit('error', new Error('spawn failed')));
    return child;
  } } });
  assert.equal((await f.post()).status, 500);
  assert.equal(jsonBody(await f.state()).restartAvailable, true);
  assert.equal((await f.post()).status, 500);
});
