const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startTestServer, request, uiHeaders, hookHeaders, jsonBody } = require('./support/server');
const { ghPullRequest } = require('./support/github');

async function unregisterServer(t, { unreachable = false, open = [] } = {}) {
  const calls = [];
  const { runtime } = await startTestServer(t, { pullRequestOptions: {
    readCrossReviewStateAcrossWorktrees: async () => null,
    execFileImpl: (_file, args, _options, callback) => {
      calls.push(args);
      if (unreachable || args[1] === 'view') return callback(new Error('GitHub unavailable'));
      if (args[0] === 'api' && args[1].includes('/git/ref/')) return callback(null, JSON.stringify({ object: { sha: 'a'.repeat(40) } }));
      if (args[0] === 'api' && args[1].includes('/compare/')) return callback(null, JSON.stringify({ ahead_by: 1, commits: [{ sha: 'a'.repeat(40) }] }));
      if (args[0] === 'api') return callback(null, JSON.stringify({ default_branch: 'main', allow_merge_commit: true }));
      callback(null, JSON.stringify(args[args.indexOf('--state') + 1] === 'open' ? open : []));
    },
  } });
  const send = (body = { owner: 'example', repo: 'project' }, headers = uiHeaders(runtime.info, `http://127.0.0.1:${runtime.info.port}`)) =>
    request(runtime.info.port, { method: 'POST', path: '/api/pull-requests/repository/unregister', headers, body: JSON.stringify(body) });
  const groups = async () => jsonBody(await request(runtime.info.port, { path: '/api/state' })).pullRequests;
  const register = async (number) => {
    const response = await request(runtime.info.port, { method: 'POST', path: '/api/sessions/unregister-test/prs',
      headers: hookHeaders(runtime.info.secret), body: JSON.stringify({ kind: 'add_pr', ppid: process.pid,
        claudeCodeSessionId: 'unregister-test', url: `https://github.com/example/project/pull/${number}` }) });
    assert.equal(response.status, 200);
    await runtime.pullRequestTracker.refreshRepoFresh('example', 'project');
  };
  return { runtime, send, groups, register, calls };
}

test('取得できないリポジトリの登録を外すと保存記録と PR の枠が消え取得対象から外れる', async (t) => {
  const { runtime, send, groups, register, calls } = await unregisterServer(t, { unreachable: true });
  await register(1);
  assert.ok((await groups())[0].error);
  assert.equal((await groups())[0].unregisterableCount, 1);
  runtime.state.setPullRequestMergeReservation({ session_id: 'unregister-test', owner: 'example', repo: 'project', number: 1,
    url: 'https://github.com/example/project/pull/1', method: 'merge', deleteBranch: false, createdAt: new Date().toISOString() });
  runtime.state.recordMergedPullRequest({ owner: 'example', repo: 'project', number: 4,
    url: 'https://github.com/example/project/pull/4', title: '履歴', mergedAt: new Date().toISOString(), method: 'merge' });
  const reservations = runtime.state.pullRequestMergeReservations();
  const history = runtime.state.mergedPullRequestHistoryForRepo('example', 'project');
  assert.equal(jsonBody(await send()).deleted, 1);
  assert.deepEqual(await groups(), []);
  assert.deepEqual(runtime.state.pullRequestRegistrations(), []);
  assert.deepEqual(runtime.state.pullRequestProviders('example', 'project', 1), []);
  assert.deepEqual(runtime.state.pullRequestMergeReservations(), reservations);
  assert.deepEqual(runtime.state.mergedPullRequestHistoryForRepo('example', 'project'), history);
  const stored = JSON.parse(await fs.readFile(path.join(runtime.homeDir, 'store.json'), 'utf8'));
  assert.deepEqual(stored.prs, []);
  const callCount = calls.length;
  await runtime.pullRequestTracker.refreshAll();
  assert.equal(calls.length, callCount);
});

test('同じリポジトリの open を残し unknown と関連 PR の unknown だけ登録を外す', async (t) => {
  const { runtime, send, groups, register } = await unregisterServer(t, { open: [ghPullRequest(1, 'feature/one', 'main')] });
  await register(1);
  await register(2);
  runtime.state.rememberRelatedPullRequest({ owner: 'example', repo: 'project', number: 3, url: 'https://github.com/example/project/pull/3' });
  runtime.state.updateRelatedPullRequest('example', 'project', 3, { state: 'unknown' });
  assert.match((await groups())[0].error, /#2/);
  assert.equal(jsonBody(await send()).deleted, 2);
  assert.deepEqual(runtime.state.pullRequestRegistrations().map(record => [record.number, record.state]), [[1, 'open']]);
  assert.deepEqual(runtime.state.relatedPullRequestRegistrations(), []);
  assert.equal((await groups())[0].error, null);
  assert.equal((await groups())[0].openCount, 1);
  assert.equal((await groups())[0].unregisterableCount, 0);
});

test('外せる記録が無ければ成功し open と closed と merged の記録を変えない', async (t) => {
  const { runtime, send, register, calls } = await unregisterServer(t, { open: [ghPullRequest(1, 'feature/one', 'main')] });
  await register(1);
  for (const [number, state] of [[2, 'closed'], [3, 'merged']]) {
    runtime.state.registerPullRequest('unregister-test', { url: `https://github.com/example/project/pull/${number}` });
    runtime.state.updatePullRequest('unregister-test', 'example', 'project', number, { state });
  }
  const before = runtime.state.serializeStore();
  const callCount = calls.length;
  const response = await send();
  assert.equal(response.status, 200);
  assert.equal(jsonBody(response).deleted, 0);
  assert.deepEqual(runtime.state.serializeStore(), before);
  assert.equal(calls.length, callCount);
});

test('リポジトリの登録解除 API は秘密値と Origin と入力を照合する', async (t) => {
  const { runtime, send, register } = await unregisterServer(t, { unreachable: true });
  await register(1);
  assert.equal((await send(undefined, {})).status, 401);
  assert.equal((await send(undefined, uiHeaders(runtime.info, undefined))).status, 403);
  assert.equal((await send(undefined, uiHeaders(runtime.info, 'https://other.example'))).status, 403);
  assert.equal((await send(undefined, uiHeaders(runtime.info, `http://127.0.0.1:${runtime.info.port}`, { 'x-cockpit-secret': 'wrong' }))).status, 401);
  for (const body of [null, [], {}, { owner: '../example', repo: 'project' }, { owner: 'example', repo: 'project', number: 1 }]) {
    assert.equal((await send(body)).status, 400);
  }
  assert.equal(runtime.state.pullRequestRegistrations().length, 1);
});
