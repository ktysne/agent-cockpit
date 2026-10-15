const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startTestServer, request, jsonBody, hookHeaders, uiHeaders } = require('./support/server');

async function cacheServer(t, options = {}) {
  let now = Date.now();
  const server = await startTestServer(t, { stateCacheNow: () => now, ...options });
  return { ...server, advance(ms) { now += ms; }, now: () => now,
    get: (etag) => request(server.info.port, { path: '/api/state',
      headers: etag ? { 'if-none-match': etag } : {} }),
    post: (route, body, hook = false) => request(server.info.port, { method: 'POST', path: route,
      headers: hook ? hookHeaders(server.info.secret) : uiHeaders(server.info, `http://127.0.0.1:${server.info.port}`), body: JSON.stringify(body) }),
  };
}

async function expectChanged(server, previous) {
  const response = await server.get(previous.headers.etag);
  assert.equal(response.status, 200);
  assert.notEqual(response.headers.etag, previous.headers.etag);
  assert.notEqual(response.body, previous.body);
  const unchanged = await server.get(response.headers.etag);
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.etag, response.headers.etag);
  assert.equal(unchanged.body, '');
  return response;
}

test('状態が変わらなければ本文を使い回し、同じ ETag の条件付き取得に本文なしの 304 を返す', async (t) => {
  const server = await cacheServer(t);
  const first = await server.get();
  const second = await server.get();
  assert.equal(second.status, 200);
  assert.equal(second.body, first.body);
  assert.equal(second.headers.etag, first.headers.etag);
  const unchanged = await server.get(first.headers.etag);
  assert.equal(unchanged.status, 304);
  assert.equal(unchanged.headers.etag, first.headers.etag);
  assert.equal(unchanged.body, '');
  assert.equal(unchanged.headers['cache-control'], 'no-store');
  assert.equal(unchanged.headers['x-frame-options'], 'DENY');
});

test('フックのイベントを受けると条件付き取得で新しいセッションを返す', async (t) => {
  const server = await cacheServer(t);
  const first = await server.get();
  assert.equal((await server.post('/api/events', { session_id: 'cache-event', hook_event_name: 'SessionStart' }, true)).status, 202);
  const changed = await expectChanged(server, first);
  assert.equal(jsonBody(changed).sessions[0].session_id, 'cache-event');
});

test('離席をオンまたはオフにすると版が同じでも条件付き取得で新しい値を返す', async (t) => {
  const server = await cacheServer(t);
  let previous = await server.get();
  for (const enabled of [true, false]) {
    assert.equal((await server.post('/api/away', { enabled })).status, 200);
    previous = await expectChanged(server, previous);
    assert.equal(jsonBody(previous).away.enabled, enabled);
  }
});

test('経路の値が変わると touch の通知がなくても条件付き取得で新しい経路を返す', async (t) => {
  const server = await cacheServer(t);
  const first = await server.get();
  const version = server.runtime.state.version;
  await server.runtime.routing.set('agents', 'codex');
  assert.equal(server.runtime.state.version, version);
  const changed = await expectChanged(server, first);
  assert.equal(jsonBody(changed).routing.agents, 'codex');
});

test('更新確認の結果が変わると版が同じでも条件付き取得で通知を返す', async (t) => {
  const server = await cacheServer(t, { updateCheck: { current: '0.0.0',
    execFileImpl(_file, _args, _options, done) { done(null, 'abcd refs/tags/v1.0.0'); } } });
  const first = await server.get();
  await server.post('/api/update/check', {});
  const changed = await expectChanged(server, first);
  assert.equal(jsonBody(changed).version, jsonBody(first).version);
  assert.equal(jsonBody(changed).update.available, true);
});

test('PR の初回取得の開始と完了を条件付き取得で返す', async (t) => {
  const callbacks = [];
  const server = await cacheServer(t, { pullRequestOptions: {
    execFileImpl(_file, _args, _options, done) { callbacks.push(done); },
  } });
  server.runtime.state.registerPullRequest('cache-pr', { url: 'https://github.com/example/project/pull/1' });
  const first = await server.get();
  const fetching = server.runtime.pullRequestTracker.refreshRepo('example', 'project');
  const loading = await server.get(first.headers.etag);
  assert.equal(loading.status, 200);
  assert.equal(jsonBody(loading).pullRequests[0].loading, true);
  assert.equal((await server.get(loading.headers.etag)).status, 304);
  while (server.runtime.pullRequestTracker.inFlight.size) {
    for (const done of callbacks.splice(0)) done(Object.assign(new Error('unavailable'), { code: 'ENOENT' }));
    await new Promise(resolve => setImmediate(resolve));
  }
  await fetching;
  const completed = await expectChanged(server, loading);
  assert.equal(jsonBody(completed).pullRequests.some(group => group.loading), false);
});

test('画面ファイルの変更を 5 秒の確認期限後に条件付き取得で返す', async (t) => {
  const server = await cacheServer(t);
  const webPath = path.join(server.homeDir, 'dashboard.html');
  await fs.writeFile(webPath, 'first');
  const local = await cacheServer(t, { webPath });
  const first = await local.get();
  await fs.writeFile(webPath, 'second version');
  assert.equal((await local.get(first.headers.etag)).status, 304);
  local.advance(5_000);
  const changed = await expectChanged(local, first);
  assert.notEqual(jsonBody(changed).uiVersion, jsonBody(first).uiVersion);
});

test('連携ファイルの有無の変更を 10 秒の確認期限後に条件付き取得で返す', async (t) => {
  const server = await cacheServer(t);
  const first = await server.get();
  const script = path.join(server.claudeHome, 'tools', 'codex-agent.sh');
  await fs.mkdir(path.dirname(script), { recursive: true });
  await fs.writeFile(script, '');
  assert.equal((await server.get(first.headers.etag)).status, 304);
  server.advance(10_000);
  const changed = await expectChanged(server, first);
  assert.equal(jsonBody(changed).integrations.codexAgent, true);
});

test('予約通知の期限直前は 304、期限直後は通知を除いた本文と新しい ETag を返す', async (t) => {
  let now = Date.now();
  const server = await cacheServer(t, { stateCacheNow: () => now, pullRequestOptions: { now: () => now,
    execFileImpl(_file, _args, _options, done) { done(Object.assign(new Error('unavailable'), { code: 'ENOENT' })); } } });
  server.runtime.state.registerPullRequest('notice-pr', { url: 'https://github.com/example/project/pull/1' });
  await server.runtime.pullRequestTracker.refreshRepo('example', 'project');
  const at = now - 59_000;
  server.runtime.state.recordPullRequestMergeReservationNotice({ owner: 'example', repo: 'project', number: 1,
    at: new Date(at).toISOString(), message: '予約を解除しました' });
  const first = await server.get();
  assert.equal(jsonBody(first).pullRequests[0].reservationNotices.length, 1);
  now += 999;
  assert.equal((await server.get(first.headers.etag)).status, 304);
  now += 2;
  const changed = await expectChanged(server, first);
  assert.equal(jsonBody(changed).pullRequests[0].reservationNotices.length, 0);
});

test('同じ本文でも再起動前の ETag では 304 を返さない', async (t) => {
  const first = await cacheServer(t);
  const before = await first.get();
  await first.runtime.close();
  const second = await cacheServer(t);
  const after = await second.get(before.headers.etag);
  assert.equal(after.status, 200);
  assert.notEqual(after.headers.etag, before.headers.etag);
});

test('初めて表示する製品は生成時に既読を初期化し、304 の間は既読時刻を保つ', async (t) => {
  const server = await cacheServer(t);
  server.runtime.state.syncSessionFiles([{ session_id: 'seen-product', cwd: server.homeDir,
    product: { key: 'cache-product', name: 'cache-product' } }]);
  const version = server.runtime.state.version;
  assert.equal(server.runtime.state.seenAtByProduct.size, 0);
  const first = await server.get();
  assert.ok(jsonBody(first).version > version);
  assert.equal(jsonBody(first).version, server.runtime.state.version);
  const seen = [...server.runtime.state.seenAtByProduct];
  assert.equal(seen.length, 1);
  server.advance(2_000);
  assert.equal((await server.get(first.headers.etag)).status, 304);
  assert.deepEqual([...server.runtime.state.seenAtByProduct], seen);
});

test('キャッシュ照合で食い違いを記録せず、性能記録に使い回しの回数を残す', async (t) => {
  const server = await cacheServer(t, { perfSummaryIntervalMs: 10 });
  const first = await server.get();
  await server.get(first.headers.etag);
  await new Promise(resolve => setTimeout(resolve, 30));
  const result = jsonBody(await request(server.info.port, { path: `/api/diagnostics?run=${server.runtime.diagnostics.run}` }));
  assert.equal(result.entries.some(entry => entry.msg === 'state.cache.mismatch'), false);
  assert.ok(result.entries.some(entry => entry.msg === 'server.perf' && entry.data.stateCacheHitCount > 0));
});

test('本文の最大保持期限を過ぎたら指紋が同じでも新しい ETag を返す', async (t) => {
  const server = await cacheServer(t);
  const first = await server.get();
  server.advance(30_000);
  const expired = await server.get(first.headers.etag);
  assert.equal(expired.status, 200);
  assert.equal(expired.body, first.body);
  assert.notEqual(expired.headers.etag, first.headers.etag);
});

test('同時の条件付き取得は期限切れの外部確認を共有する', async (t) => {
  let checks = 0;
  let release;
  let started;
  const checking = new Promise(resolve => { started = resolve; });
  const server = await cacheServer(t, { codexAgentScriptExists: async () => {
    checks += 1;
    if (checks === 2) { started(); await new Promise(resolve => { release = resolve; }); }
    return true;
  } });
  const first = await server.get();
  server.advance(10_000);
  const reads = [server.get(first.headers.etag), server.get(first.headers.etag)];
  await checking;
  await new Promise(resolve => setImmediate(resolve));
  release();
  for (const response of await Promise.all(reads)) assert.equal(response.status, 304);
  assert.equal(checks, 2);
});

test('外部確認中に製品が増えたら、その応答は待ち直さず次の取得で新しい cwd を調べる', async (t) => {
  let release;
  let started;
  const checking = new Promise(resolve => { started = resolve; });
  const cwds = [];
  const server = await cacheServer(t, { crossReviewToolExists: async cwd => {
    cwds.push(cwd);
    if (cwds.length === 1) { started(); await new Promise(resolve => { release = resolve; }); }
    return cwd === 'new-worktree';
  } });
  server.runtime.state.syncSessionFiles([{ session_id: 'old', cwd: 'old-worktree' }]);
  const reading = server.get();
  await checking;
  server.runtime.state.syncSessionFiles([{ session_id: 'new', cwd: 'new-worktree' }]);
  release();
  const response = await reading;
  assert.equal(jsonBody(response).integrations.crossReview, false);
  const next = await server.get(response.headers.etag);
  assert.equal(next.status, 200);
  assert.equal(jsonBody(next).integrations.crossReview, true);
  assert.ok(cwds.includes('new-worktree'));
});

test('開いた離席期間では未来の完了記録の時刻を過ぎた取得で本文を作り直す', async (t) => {
  const server = await cacheServer(t);
  const product = { key: 'future-product', name: 'future-product' };
  server.runtime.state.syncSessionFiles([{ session_id: 'future', product }]);
  await server.get();
  await server.runtime.away.setEnabled(true, server.now());
  server.runtime.state.setTasks('future', [{ title: '未来の完了', state: 'done', criteria: [] }], server.now() + 1_000);
  const first = await server.get();
  assert.deepEqual(jsonBody(first).sinceSeen, []);
  server.advance(999);
  assert.equal((await server.get(first.headers.etag)).status, 304);
  server.advance(2);
  const changed = await expectChanged(server, first);
  assert.equal(jsonBody(changed).sinceSeen[0].items[0].text, 'タスク「未来の完了」が完了した');
});

test('離席期間の保持期限を過ぎた取得は整理後の状態に新しい ETag を付ける', async (t) => {
  const server = await cacheServer(t);
  const retentionMs = 14 * 24 * 60 * 60_000;
  await server.runtime.away.setEnabled(true, server.now() - retentionMs);
  await server.runtime.away.setEnabled(false, server.now() - retentionMs + 1_000);
  const first = await server.get();
  assert.equal(jsonBody(first).away.periods.length, 1);
  server.advance(999);
  assert.equal((await server.get(first.headers.etag)).status, 304);
  server.advance(2);
  const changed = await expectChanged(server, first);
  assert.deepEqual(jsonBody(changed).away.periods, []);
});

test('マージ履歴の保持期限を過ぎた取得で履歴を除いた本文を返す', async (t) => {
  let now = Date.now();
  const server = await cacheServer(t, { stateCacheNow: () => now, pullRequestOptions: { now: () => now,
    execFileImpl(_file, _args, _options, done) { done(Object.assign(new Error('unavailable'), { code: 'ENOENT' })); } } });
  server.runtime.state.registerPullRequest('history', { url: 'https://github.com/example/project/pull/1' });
  await server.runtime.pullRequestTracker.refreshRepo('example', 'project');
  server.runtime.state.recordMergedPullRequest({ owner: 'example', repo: 'project', number: 2,
    url: 'https://github.com/example/project/pull/2',
    mergedAt: new Date(now - 24 * 60 * 60_000 + 1_000).toISOString(), title: '履歴' }, now);
  const first = await server.get();
  assert.equal(jsonBody(first).pullRequests[0].mergeHistory.length, 1);
  now += 999;
  assert.equal((await server.get(first.headers.etag)).status, 304);
  now += 2;
  const changed = await expectChanged(server, first);
  assert.deepEqual(jsonBody(changed).pullRequests[0].mergeHistory, []);
});

