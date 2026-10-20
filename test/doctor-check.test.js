const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { DoctorChecker } = require('../src/server/doctor-check');
const { startTestServer, request, jsonBody, uiHeaders, hookHeaders } = require('./support/server');

const report = () => ({ schemaVersion: 1, generatedAt: '2026-10-21T01:30:00.000Z',
  checkout: { root: '/checkout', version: '1.8.1', commit: 'private' }, homes: { claude: '/claude', codex: '/codex', agents: '/agents' },
  summary: { ok: 0, mismatch: 1, unverified: 0, notRun: 0, notInstalled: 0 },
  items: [{ id: 'cockpit.hook', tool: 'agent-cockpit', provider: 'claude', result: 'mismatch', reason: '登録が違います。',
    expected: 'private', observed: 'private', actions: [{ op: 'set', value: 'private', content: 'private', from: 'private', to: 'private' },
      { op: 'manual', text: 'セッションを開き直してください。', value: 'private' }] }] });
const execResult = (error = null, output = JSON.stringify(report())) => (_file, _args, _options, callback) => callback(error, output);

function fakeClock() {
  let now = 0;
  const timers = new Map();
  return { nowMs: () => now,
    setTimeoutImpl(callback, delay) { const timer = { unref() {} }; timers.set(timer, { at: now + delay, callback }); return timer; },
    clearTimeoutImpl: timer => timers.delete(timer),
    async advance(delay) {
      const until = now + delay;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
        if (!next || next[1].at > until) break;
        now = next[1].at;
        timers.delete(next[0]);
        await next[1].callback();
      }
      now = until;
    },
  };
}

test('導入の点検は終了コード 0 と 1 の JSON を受け取り、子プロセスの環境と期限を指定する', async () => {
  for (const error of [null, { code: 1 }]) {
    const checker = new DoctorChecker({ homeDir: '/cockpit', execFileImpl(file, args, options, callback) {
      assert.equal(file, process.execPath);
      assert.deepEqual(args, [path.resolve(__dirname, '../src/client/doctor.js'), '--json']);
      assert.equal(options.env.AGENT_COCKPIT_HOME, '/cockpit');
      assert.equal(options.windowsHide, true);
      assert.equal(options.timeout, 90_000);
      assert.equal(options.maxBuffer, 8 * 1024 * 1024);
      callback(error, JSON.stringify(report()));
    } });
    assert.equal((await checker.check()).error, null);
    assert.deepEqual(checker.snapshot().summary, report().summary);
  }
});

test('診断の失敗は分類だけを返し、前に成功した点検結果を残す', async () => {
  for (const [error, output, expected] of [[{ code: 2 }, '{}', '2'], [{ killed: true }, '', 'TIMEOUT'],
    [null, '{', 'INVALID_JSON'], [null, '{"schemaVersion":2}', 'UNSUPPORTED_SCHEMA'], [null, 'null', 'UNSUPPORTED_SCHEMA']]) {
    const checker = new DoctorChecker({ execFileImpl: execResult() });
    await checker.check();
    const previous = checker.details();
    checker.execFileImpl = execResult(error, output);
    const result = await checker.check();
    assert.equal(result.error, expected);
    assert.equal(result.running, false);
    assert.deepEqual(checker.details(), previous);
  }
});

test('点検の要求は実行中の Promise を共有し、close は完了を待って次の実行を止める', async () => {
  let callback;
  const checker = new DoctorChecker({ execFileImpl: (_file, _args, _options, done) => { callback = done; } });
  const pending = checker.check();
  assert.equal(checker.check(), pending);
  assert.equal(checker.snapshot().running, true);
  let closed = false;
  const closing = checker.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  callback(null, JSON.stringify(report()));
  await closing;
  assert.equal(checker.snapshot().running, false);
  assert.equal((await checker.check()).generatedAt, report().generatedAt);
});

test('起動後 90 秒に一度だけ点検し、close で予定も取り消す', async () => {
  const clock = fakeClock();
  let calls = 0;
  const checker = new DoctorChecker({ ...clock, execFileImpl(...args) { calls += 1; execResult()(...args); } });
  checker.start();
  checker.start();
  await clock.advance(89_999);
  assert.equal(calls, 0);
  await clock.advance(1);
  assert.equal(calls, 1);
  await clock.advance(1_000_000);
  assert.equal(calls, 1);
  checker.sessionStarted();
  await checker.close();
  await clock.advance(90_000);
  assert.equal(calls, 1);
});

test('SessionStart は最後のイベントから 10 秒待ってまとめ、前の点検の開始から 60 秒空ける', async () => {
  const clock = fakeClock();
  const starts = [];
  const checker = new DoctorChecker({ ...clock, execFileImpl(...args) { starts.push(clock.nowMs()); execResult()(...args); } });
  checker.sessionStarted();
  await clock.advance(9_000);
  checker.sessionStarted();
  await clock.advance(9_999);
  assert.deepEqual(starts, []);
  await clock.advance(1);
  assert.deepEqual(starts, [19_000]);
  checker.sessionStarted();
  await clock.advance(59_999);
  assert.deepEqual(starts, [19_000]);
  await clock.advance(1);
  assert.deepEqual(starts, [19_000, 79_000]);
  await checker.close();
});

function checkRequest(info, headers = uiHeaders(info, `http://127.0.0.1:${info.port}`)) {
  return request(info.port, { method: 'POST', path: '/api/doctor/check', body: '{}',
    headers: { 'content-type': 'application/json', ...headers } });
}

test('点検 API は要約と全文を分け、ファイルを書き換える対処の中身を配信しない', async t => {
  const { runtime, info } = await startTestServer(t, { doctorCheck: { execFileImpl: execResult() } });
  const response = await checkRequest(info);
  assert.equal(response.status, 200);
  const summary = jsonBody(response);
  assert.deepEqual(Object.keys(summary).sort(), ['error', 'generatedAt', 'running', 'staleBefore', 'summary']);
  assert.deepEqual(jsonBody(await request(info.port, { path: '/api/state' })).doctor, summary);
  const details = jsonBody(await request(info.port, { path: '/api/doctor' }));
  assert.deepEqual(details.checkout, { root: '/checkout', version: '1.8.1' });
  assert.deepEqual(details.items[0].actions, [{ op: 'set' }, { op: 'manual', text: 'セッションを開き直してください。' }]);
  assert.doesNotMatch(JSON.stringify(details), /private|expected|observed/);
  assert.equal(runtime.doctorChecker.homeDir, runtime.homeDir);
});

test('点検の実行は画面の秘密値と Origin を照合する', async t => {
  let calls = 0;
  const { info } = await startTestServer(t, { doctorCheck: { execFileImpl(...args) { calls += 1; execResult()(...args); } } });
  for (const headers of [{}, hookHeaders(info.secret), uiHeaders(info, 'https://example.com'),
    { origin: `http://127.0.0.1:${info.port}`, 'x-cockpit-secret': 'wrong' }]) {
    assert.equal((await checkRequest(info, headers)).status, headers.origin === 'https://example.com' ? 403 : 401);
  }
  assert.equal(calls, 0);
  assert.equal((await checkRequest(info)).status, 200);
});

test('点検を有効にしていないサーバーは実行要求に 409 と全文に null を返す', async t => {
  const { info } = await startTestServer(t);
  assert.equal((await checkRequest(info)).status, 409);
  assert.equal(jsonBody(await request(info.port, { path: '/api/doctor' })), null);
});

test('点検の開始と完了は状態の版を進めずに ETag を更新し、実行中の API は同じ結果を待つ', async t => {
  let complete;
  let started;
  const launched = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const { runtime, info } = await startTestServer(t, { doctorCheck: { execFileImpl(_file, _args, _options, callback) {
    calls += 1; complete = callback; started();
  } } });
  const before = await request(info.port, { path: '/api/state' });
  const first = checkRequest(info);
  await launched;
  const second = checkRequest(info);
  const pending = await request(info.port, { path: '/api/state', headers: { 'if-none-match': before.headers.etag } });
  assert.equal(pending.status, 200);
  assert.equal(jsonBody(pending).doctor.running, true);
  assert.equal(jsonBody(pending).version, jsonBody(before).version);
  complete(null, JSON.stringify(report()));
  const results = await Promise.all([first, second]);
  assert.equal(calls, 1);
  assert.deepEqual(jsonBody(results[0]), jsonBody(results[1]));
  const after = await request(info.port, { path: '/api/state', headers: { 'if-none-match': pending.headers.etag } });
  assert.equal(after.status, 200);
  assert.equal(jsonBody(after).doctor.running, false);
  assert.equal(runtime.doctorChecker.snapshot().error, null);
});

test('再起動待ちになった時刻は維持し、更新を戻すと点検の staleBefore を消す', async t => {
  const fs = require('node:fs/promises');
  const { temporaryDirectory } = require('./support/temp');
  const { directory } = temporaryDirectory(t);
  const version = require('../package.json').version;
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version }));
  let now = Date.parse('2026-10-21T02:00:00Z');
  const { info } = await startTestServer(t, { sourceRoot: directory, stateCacheNow: () => now,
    doctorCheck: { execFileImpl: execResult() } });
  const get = async () => jsonBody(await request(info.port, { path: '/api/state' }));
  assert.equal((await get()).doctor.staleBefore, null);
  await fs.writeFile(path.join(directory, 'package.json'), '{"version":"999.0.0"}');
  now += 6000;
  const at = new Date(now).toISOString();
  assert.equal((await get()).doctor.staleBefore, at);
  now += 6000;
  assert.equal((await get()).doctor.staleBefore, at);
  await fs.writeFile(path.join(directory, 'package.json'), '{"version":"999.0.1"}');
  now += 6000;
  const updatedAgain = new Date(now).toISOString();
  assert.equal((await get()).doctor.staleBefore, updatedAgain);
  now += 6000;
  assert.equal((await get()).doctor.staleBefore, updatedAgain);
  await fs.writeFile(path.join(directory, 'package.json'), JSON.stringify({ version }));
  now += 6000;
  assert.equal((await get()).doctor.staleBefore, null);
});

test('イベントの受付は本体の SessionStart だけを点検の契機にする', async t => {
  const clock = fakeClock();
  let calls = 0;
  const { info } = await startTestServer(t, { doctorCheck: { ...clock, execFileImpl(...args) { calls += 1; execResult()(...args); } } });
  const event = async body => {
    const response = await request(info.port, { method: 'POST', path: '/api/events', headers: hookHeaders(info.secret),
      body: JSON.stringify({ session_id: 'doctor-session', cwd: process.cwd(), hookAt: Date.now(), ...body }) });
    assert.equal(response.status, 202);
  };
  await event({ hook_event_name: 'SessionStart', agent_id: 'worker' });
  await clock.advance(10_000);
  assert.equal(calls, 0);
  await event({ hook_event_name: 'SessionStart' });
  await clock.advance(10_000);
  assert.equal(calls, 1);
});
