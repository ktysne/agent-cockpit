const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const childProcess = require('node:child_process');
const { UpdateChecker, compareVersions, latestVersionFromTags } = require('../src/server/update-check');
const { startTestServer, request, jsonBody, uiHeaders } = require('./support/server');

function fakeClock() {
  let now = 0;
  let unrefs = 0;
  const timers = new Map();
  return {
    nowMs: () => now,
    setTimeoutImpl(callback, delay) {
      const timer = { unref() { unrefs += 1; } };
      timers.set(timer, { at: now + delay, callback });
      return timer;
    },
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
    unrefs: () => unrefs,
    pending: () => timers.size,
  };
}

const tags = (...versions) => versions.map(value => `abc\trefs/tags/v${value}`).join('\n');
const gitResult = output => (_file, _args, _options, callback) => callback(null, output);

test('タグの抽出は正式なバージョンだけを整数順で比べ、pre-release と剥離行を捨てる', () => {
  assert.equal(latestVersionFromTags(tags('0.0.0', '1.9.99', '1.10.0', '1.10.0^{}', '2.0.0-rc.1')), '1.10.0');
  assert.equal(latestVersionFromTags(tags('0.0.0')), '0.0.0');
  assert.equal(latestVersionFromTags('abc\trefs/tags/1.0.0\nabc\trefs/heads/v8.0.0'), null);
  for (const [left, right, expected] of [['0.0.0', '0.0.0', 0], ['0.0.1', '0.0.0', 1],
    ['2.0.0', '10.0.0', -1], ['1.10.0', '1.9.99', 1], ['1.0.11', '1.0.9', 1],
    ['9007199254740993.0.0', '9007199254740992.0.0', 1]]) {
    assert.equal(compareVersions(left, right), expected);
  }
});

test('起動 1 分後と 6 時間ごとに固定 URL を対話なしで調べ、終了後は調べない', async () => {
  const clock = fakeClock();
  const calls = [];
  const checker = new UpdateChecker({ ...clock, current: '0.0.0', execFileImpl(file, args, options, callback) {
    calls.push({ file, args, options });
    callback(null, tags('0.1.0'));
  } });
  checker.start();
  await clock.advance(59_999);
  assert.equal(calls.length, 0);
  await clock.advance(1);
  assert.equal(calls.length, 1);
  assert.equal(checker.snapshot().checkedAt, '1970-01-01T00:01:00.000Z');
  await clock.advance(6 * 60 * 60_000);
  assert.equal(calls.length, 2);
  assert.equal(clock.unrefs(), 3);
  assert.deepEqual(calls[0].args, ['ls-remote', '--refs', '--tags', 'https://github.com/ktysne/agent-cockpit.git']);
  assert.equal(calls[0].file, 'git');
  assert.equal(calls[0].options.windowsHide, true);
  assert.equal(calls[0].options.timeout, 15_000);
  assert.equal(calls[0].options.maxBuffer, 1024 * 1024);
  assert.equal(calls[0].options.env.GIT_TERMINAL_PROMPT, '0');
  assert.equal(calls[0].options.env.GCM_INTERACTIVE, 'never');
  await checker.close();
  assert.equal(clock.pending(), 0);
  await clock.advance(6 * 60 * 60_000);
  assert.equal(calls.length, 2);
});

test('成功後の確認に失敗しても更新候補と成功時刻を残し、失敗分類を診断に残す', async () => {
  for (const [failure, expected] of [[{ code: 'ENOENT' }, 'ENOENT'], [{ killed: true }, 'TIMEOUT'],
    [{ code: 128 }, '128'], [null, 'NO_VERSION_TAGS']]) {
    const records = [];
    let now = 1000;
    const checker = new UpdateChecker({ current: '0.0.0', execFileImpl: gitResult(tags('1.0.0')),
      nowMs: () => now, diagnostics: { record: (...args) => records.push(args) } });
    await checker.check();
    const succeededAt = checker.snapshot().succeededAt;
    assert.equal(succeededAt, '1970-01-01T00:00:01.000Z');
    now = 2000;
    checker.execFileImpl = (_file, _args, _options, callback) => callback(failure, '');
    await checker.check();
    const result = checker.snapshot();
    assert.equal(result.latest, '1.0.0');
    assert.equal(result.available, true);
    assert.equal(result.succeededAt, succeededAt);
    assert.equal(result.checkedAt, '1970-01-01T00:00:02.000Z');
    assert.equal(result.error, expected);
    assert.match(result.prompt, /v1\.0\.0/);
    assert.equal(result.compareUrl, 'https://github.com/ktysne/agent-cockpit/tree/v1.0.0');
    assert.deepEqual(records.at(-1), ['warn', 'server', 'update.failed', { failure: expected }]);
    assert.equal(records[0][0], 'info');
  }
});

test('成功する前の確認失敗は更新候補を持たず、成功時刻を null のままにする', async () => {
  const checker = new UpdateChecker({ current: '1.0.0', nowMs: () => 1000,
    execFileImpl: (_file, _args, _options, callback) => callback({ code: 'ENOENT' }, '') });
  const result = await checker.check();
  assert.equal(result.latest, null);
  assert.equal(result.available, false);
  assert.equal(result.succeededAt, null);
  assert.equal(result.checkedAt, '1970-01-01T00:00:01.000Z');
  assert.equal(result.error, 'ENOENT');
});

test('失敗後の確認成功は結果と成功時刻を更新し、失敗分類を消す', async () => {
  let now = 1000;
  const checker = new UpdateChecker({ current: '1.0.0', nowMs: () => now,
    execFileImpl: (_file, _args, _options, callback) => callback({ code: 'ENOENT' }, '') });
  await checker.check();
  now = 2000;
  checker.execFileImpl = gitResult(tags('1.1.0'));
  const result = await checker.check();
  assert.equal(result.latest, '1.1.0');
  assert.equal(result.available, true);
  assert.equal(result.checkedAt, '1970-01-01T00:00:02.000Z');
  assert.equal(result.succeededAt, result.checkedAt);
  assert.equal(result.error, null);
});

test('バージョンを確認するオプションが無いサーバーは git を起動しない', async t => {
  const calls = [];
  t.mock.method(childProcess, 'execFile', (...args) => calls.push(args));
  t.mock.method(UpdateChecker.prototype, 'start', () => assert.fail('明示しなければバージョンの確認は起動しない'));
  const { runtime, info } = await startTestServer(t);
  assert.equal(runtime.updateChecker, null);
  assert.equal(jsonBody(await request(info.port, { path: '/api/state' })).update, null);
  assert.equal(calls.length, 0);
});

test('state の update は版番号を進めずに変わり、新しいバージョンだけに依頼文とリンクが付く', async t => {
  const { runtime, info } = await startTestServer(t, { updateCheck: { current: '1.2.3', execFileImpl: gitResult(tags('1.3.0')) } });
  const version = runtime.state.version;
  await runtime.updateChecker.check();
  const result = jsonBody(await request(info.port, { path: '/api/state' }));
  assert.equal(result.version, version);
  assert.equal(Object.hasOwn(runtime.state.snapshot(), 'update'), false);
  assert.equal(result.update.available, true);
  assert.equal(result.update.compareUrl, 'https://github.com/ktysne/agent-cockpit/compare/v1.2.3...v1.3.0');
  assert.equal(result.update.prompt, `agent-cockpit を v1.3.0 に更新して。手順は ${path.resolve(__dirname, '../docs/update.md')} にある。`);
  for (const latest of ['1.2.3', '1.2.2']) {
    runtime.updateChecker.execFileImpl = gitResult(tags(latest));
    await runtime.updateChecker.check();
    const update = jsonBody(await request(info.port, { path: '/api/state' })).update;
    assert.equal(update.available, false);
    assert.equal(Object.hasOwn(update, 'prompt'), false);
    assert.equal(Object.hasOwn(update, 'compareUrl'), false);
  }
});

test('0.0.0 からの通知リンクは新しいタグの tree を指す', async t => {
  const { runtime, info } = await startTestServer(t, { updateCheck: { current: '0.0.0', execFileImpl: gitResult(tags('1.0.0')) } });
  await runtime.updateChecker.check();
  assert.equal(jsonBody(await request(info.port, { path: '/api/state' })).update.compareUrl,
    'https://github.com/ktysne/agent-cockpit/tree/v1.0.0');
});

test('サーバーは明示した時計でバージョンを確認し、close で次の確認を止める', async t => {
  const clock = fakeClock();
  let calls = 0;
  const { runtime, info } = await startTestServer(t, { updateCheck: { ...clock, current: '0.0.0', execFileImpl(_file, _args, _options, callback) {
    calls += 1;
    callback(null, tags('1.0.0'));
  } } });
  assert.equal(calls, 0);
  await clock.advance(60_000);
  assert.equal(calls, 1);
  assert.equal(jsonBody(await request(info.port, { path: '/api/state' })).update.available, true);
  await runtime.close();
  await clock.advance(6 * 60 * 60_000);
  assert.equal(calls, 1);
});

test('バージョンの確認の成功と失敗は診断 API から結果と分類だけを読める', async t => {
  const { runtime, info } = await startTestServer(t, { updateCheck: { current: '0.0.0', execFileImpl: gitResult(tags('1.0.0')) } });
  await runtime.updateChecker.check();
  runtime.updateChecker.execFileImpl = (_file, _args, _options, callback) => callback(Object.assign(new Error('private stderr'), { code: 'ENOENT' }));
  await runtime.updateChecker.check();
  const entries = jsonBody(await request(info.port, { path: `/api/diagnostics?run=${runtime.diagnostics.run}` })).entries
    .filter(entry => entry.msg.startsWith('update.'));
  assert.deepEqual(entries.map(entry => [entry.level, entry.msg]), [['info', 'update.checked'], ['warn', 'update.failed']]);
  assert.equal(entries[0].data.latest, '1.0.0');
  assert.equal(entries[0].data.available, true);
  assert.equal(Object.hasOwn(entries[0].data, 'succeededAt'), false);
  assert.deepEqual(entries[1].data, { failure: 'ENOENT' });
  assert.doesNotMatch(JSON.stringify(entries), /private|stderr|prompt|compareUrl/);
});

function checkRequest(info) {
  return request(info.port, {
    method: 'POST', path: '/api/update/check', body: '{}',
    headers: { 'content-type': 'application/json', ...uiHeaders(info, `http://127.0.0.1:${info.port}`) },
  });
}

test('バージョンを確認するオプションが無いサーバーは、手動の確認も 409 を返し git を起動しない', async t => {
  const calls = [];
  t.mock.method(childProcess, 'execFile', (...args) => calls.push(args));
  const { info } = await startTestServer(t);
  const response = await checkRequest(info);
  assert.equal(response.status, 409);
  assert.deepEqual(jsonBody(response), { error: 'update-check-disabled' });
  assert.equal(calls.length, 0);
});

test('手動の確認は確認の結果を返し、/api/state の update にも反映する', async t => {
  const { info } = await startTestServer(t, { updateCheck: { current: '1.2.3', execFileImpl: gitResult(tags('1.3.0')) } });
  const response = await checkRequest(info);
  assert.equal(response.status, 200);
  assert.equal(response.headers['content-type'], 'application/json; charset=utf-8');
  const result = jsonBody(response);
  assert.equal(result.available, true);
  assert.equal(result.latest, '1.3.0');
  assert.equal(result.compareUrl, 'https://github.com/ktysne/agent-cockpit/compare/v1.2.3...v1.3.0');
  assert.deepEqual(jsonBody(await request(info.port, { path: '/api/state' })).update, result);
});

test('確認の実行中に来た手動の確認は、新しい git を起動せず同じ確認の結果を受け取る', async t => {
  let gitCalls = 0;
  let checks = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const { runtime, info } = await startTestServer(t, { updateCheck: { current: '0.0.0', execFileImpl(_file, _args, _options, callback) {
    gitCalls += 1;
    gate.then(() => callback(null, tags('1.0.0')));
  } } });
  const check = runtime.updateChecker.check.bind(runtime.updateChecker);
  t.mock.method(runtime.updateChecker, 'check', () => { checks += 1; return check(); });

  const first = checkRequest(info);
  const second = checkRequest(info);
  while (checks < 2) await new Promise(resolve => setImmediate(resolve));
  release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.status, 200);
  assert.equal(b.status, 200);
  assert.deepEqual(jsonBody(a), jsonBody(b));
  assert.equal(jsonBody(a).latest, '1.0.0');
  assert.equal(gitCalls, 1);
});
