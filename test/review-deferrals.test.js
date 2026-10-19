const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { callTool } = require('../src/mcp/server');
const { request, startTestServer } = require('./support/server');
const { pullRequest } = require('./support/github');
const { DashboardState } = require('../src/server/state');

async function deferralApi(t, options = {}, readReview = () => null) {
  const pr = pullRequest(49, 'feature', 'main', { statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] });
  const server = await startTestServer(t, { ...options, findSessionIdByPid: async () => null, pullRequestOptions: {
    readCrossReviewStateAcrossWorktrees: async () => readReview(pr),
    execFileImpl: (_file, args, _options, callback) => {
      if (args[0] === 'pr' && args[1] === 'list') callback(null, JSON.stringify(args[args.indexOf('--state') + 1] === 'open' ? [pr] : []));
      else if (args[0] === 'api' && args[1].includes('/compare/')) callback(null, JSON.stringify({ ahead_by: 0, commits: [] }));
      else if (args[0] === 'api' && args[1].includes('/git/ref/')) callback(null, JSON.stringify({ object: { sha: 'a'.repeat(40) } }));
      else if (args[0] === 'api') callback(null, JSON.stringify({ default_branch: 'main', allow_merge_commit: true }));
      else callback(new Error('unexpected command'));
    },
  } });
  const { runtime, info } = server;
  runtime.state.registerPullRequest('review-session', { url: pr.url }, { product: { key: 'project', name: 'project' } });
  await runtime.pullRequestTracker.refreshRepoFresh('example', 'project');
  const record = { owner: 'example', repo: 'project', number: 49, headRefOid: pr.headRefOid, reason: '実機が無い', next: '実機でレビューする' };
  const mcp = (name, args = record, session = 'review-session') => callTool(name, args, {
    homeDir: server.homeDir, ppid: 321, environment: { CLAUDE_CODE_SESSION_ID: session },
    ensureServerRunning: async () => info,
  });
  const snapshot = async () => JSON.parse((await request(info.port, { path: '/api/state' })).body);
  const screen = async action => {
    const registration = runtime.state.pullRequestRegistrations()[0];
    return request(info.port, { method: 'POST', path: '/api/pull-requests/review-skip',
      headers: { 'x-cockpit-secret': info.uiSecret, origin: `http://127.0.0.1:${info.port}` },
      body: JSON.stringify({ action, registration_key: runtime.state.pullRequestRegistrationKey(registration), headRefOid: pr.headRefOid }) });
  };
  const skip = () => { const { next, ...args } = record; return mcp('cockpit_skip_review', args); };
  return { ...server, pr, record, mcp, skip, snapshot, screen };
}

test('MCP の保留を保存して現在の head のカードに理由と次の作業を返す', async t => {
  const f = await deferralApi(t);
  const result = await f.mcp('cockpit_defer_review');
  assert.equal(result.isError, undefined);
  assert.match(result.content[0].text, /レビュー保留として記録しました/);
  const state = await f.snapshot();
  assert.match(JSON.stringify(state), /"deferred":true/);
  assert.match(JSON.stringify(state), /実機でレビューする/);
  const store = JSON.parse(await fs.readFile(path.join(f.homeDir, 'store.json'), 'utf8'));
  assert.deepEqual(store.crossReviewSkips, []);
  assert.equal(store.crossReviewDeferrals[0].next, f.record.next);
  const restored = await DashboardState.load(f.homeDir);
  assert.equal(restored.crossReviewDeferral('example', 'project', 49).next, f.record.next);
  await restored.flushPersistence();
});

test('PR 登録の保持期限が過ぎると保存した保留も消す', async t => {
  const f = await deferralApi(t);
  await f.mcp('cockpit_defer_review');
  const restored = await DashboardState.load(f.homeDir, { now: Date.now() + 365 * 24 * 60 * 60_000 });
  restored.syncSessionFiles([], Date.now() + 365 * 24 * 60 * 60_000);
  assert.deepEqual(restored.serializeStore().crossReviewDeferrals, []);
  await restored.flushPersistence();
});

test('保留の PR は条件がそろっても予約を保持して収束を待つ', async t => {
  const f = await deferralApi(t);
  await f.mcp('cockpit_defer_review');
  const registration = f.runtime.state.pullRequestRegistrations()[0];
  const response = await request(f.info.port, { method: 'POST', path: '/api/pull-requests/reserve',
    headers: { 'x-cockpit-secret': f.info.uiSecret, origin: `http://127.0.0.1:${f.info.port}` },
    body: JSON.stringify({ number: 49, registration_key: f.runtime.state.pullRequestRegistrationKey(registration),
      headRefOid: f.pr.headRefOid, method: 'merge', deleteBranch: false }) });
  assert.equal(response.status, 200, response.body);
  assert.equal(JSON.parse(response.body).reserved, true);
  assert.match(JSON.stringify(await f.snapshot()), /"deferred":true/);
});

for (const outcome of ['converged', 'halted']) {
  test(`保留の後に今の head のレビューが ${outcome} になれば、保留で隠さずにレビューの記録を返す`, async t => {
    let review = null;
    const f = await deferralApi(t, {}, () => review);
    await f.mcp('cockpit_defer_review');
    const head = f.pr.headRefOid.toLowerCase();
    review = { round: 1, max: 3, dismissed: 0, reviewedSha: head, triage: { round: 1, sha: head, outcome } };
    await f.runtime.pullRequestTracker.refreshRepoFresh('example', 'project');
    const [tree] = (await f.snapshot()).pullRequests.flatMap(group => group.trees);
    assert.equal(tree.crossReview.deferred, undefined);
    assert.equal(tree.crossReview.triage.outcome, outcome);
  });
}

test('保留を反映した後に保存を確かめられなければ、未記録と断定せずダッシュボードでの確認を求める', async t => {
  const f = await deferralApi(t);
  const waitForPersistence = f.runtime.state.waitForPersistence.bind(f.runtime.state);
  let failed = false;
  f.runtime.state.waitForPersistence = async () => {
    if (failed) return waitForPersistence();
    failed = true;
    throw new Error('disk full');
  };
  const result = await f.mcp('cockpit_defer_review');
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /記録できたかを確かめられなかった/);
  assert.doesNotMatch(result.content[0].text, /記録できなかった。/);
  assert.match(JSON.stringify(await f.snapshot()), /"deferred":true/);
});

test('MCP の保留は最新の head と登録元のセッションを照合する', async t => {
  const f = await deferralApi(t);
  for (const [args, session] of [[{ ...f.record, headRefOid: 'b'.repeat(40) }, 'review-session'], [f.record, 'other-session']]) {
    const result = await f.mcp('cockpit_defer_review', args, session);
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /記録できなかった。完了報告に未記録であることと理由/);
  }
  assert.doesNotMatch(JSON.stringify(await f.snapshot()), /"deferred":true/);
});

test('MCP の保留は次の作業が無ければ未記録と直す項目を返す', async t => {
  const f = await deferralApi(t);
  const { next, ...args } = f.record;
  const result = await f.mcp('cockpit_defer_review', args);
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /次の作業\(next\)/);
  assert.match(result.content[0].text, /記録できなかった。完了報告に未記録であることと理由/);
  assert.doesNotMatch(JSON.stringify(await f.snapshot()), /"deferred":true/);
});

test('MCP の不要記録と保留は後から記録したほうだけを残す', async t => {
  const f = await deferralApi(t);
  assert.equal((await f.skip()).isError, undefined);
  assert.equal((await f.mcp('cockpit_defer_review')).isError, undefined);
  let state = JSON.stringify(await f.snapshot());
  assert.match(state, /"deferred":true/);
  assert.doesNotMatch(state, /"notRequired":true/);
  assert.equal((await f.skip()).isError, undefined);
  state = JSON.stringify(await f.snapshot());
  assert.match(state, /"notRequired":true/);
  assert.doesNotMatch(state, /"deferred":true/);
});

test('画面から不要を記録して取り消しても保留の記録は復活しない', async t => {
  const f = await deferralApi(t);
  await f.mcp('cockpit_defer_review');
  assert.equal((await f.screen('set')).status, 200);
  assert.doesNotMatch(JSON.stringify(await f.snapshot()), /"deferred":true/);
  assert.equal((await f.screen('clear')).status, 200);
  assert.doesNotMatch(JSON.stringify(await f.snapshot()), /"deferred":true|"notRequired":true/);
});

test('head が変わると保留を無効にして次の Stop で催促する', async t => {
  const f = await deferralApi(t);
  await f.mcp('cockpit_defer_review');
  f.pr.headRefOid = 'b'.repeat(40);
  await f.runtime.pullRequestTracker.refreshRepoFresh('example', 'project');
  const response = await request(f.info.port, { method: 'POST', path: '/api/hooks/answers',
    headers: { 'x-cockpit-secret': f.info.secret },
    body: JSON.stringify({ session_id: 'review-session', action: 'stop-check', event_name: 'Stop', provider: 'claude', id: 'stop' }) });
  assert.match(JSON.parse(response.body).hookOutput.reason, /cockpit_defer_review/);
  assert.doesNotMatch(JSON.stringify(await f.snapshot()), /"deferred":true/);
});

test('MCP の不要と保留は通信できないとき未記録であることを完了報告に書くよう返す', async () => {
  for (const name of ['cockpit_skip_review', 'cockpit_defer_review']) {
    const result = await callTool(name, { owner: 'example', repo: 'project', number: 49,
      headRefOid: 'a'.repeat(40), reason: '実機が無い', next: '実機でレビューする' }, {
      environment: {}, ensureServerRunning: async () => null,
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0].text, /記録できなかった。完了報告に未記録であることと理由/);
  }
});
