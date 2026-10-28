const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { DashboardState } = require('../src/server/state');
const { PullRequestTracker } = require('../src/server/pull-requests');
const { pullRequest } = require('./support/github');
const { startTestServer, request, jsonBody, uiHeaders } = require('./support/server');
const { temporaryHome } = require('./support/temp');

async function fixture(t) {
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'hidden-items', cwd: process.cwd() }]);
  const decision = state.addDecision('hidden-items', { title: '確認してください', context: '', state: 'waiting', options: [] });
  const tracker = new PullRequestTracker({ state, readCrossReviewState: async () => null });
  for (const number of [1, 2, 3]) {
    state.registerPullRequest('hidden-items', { url: `https://github.com/example/project/pull/${number}` });
    state.updatePullRequest('hidden-items', 'example', 'project', number, { state: 'open' });
  }
  state.patchDisplayPreferences({ mergeableCondition: 'ci' });
  tracker.repositories.set('example/project', {
    defaultBranch: 'main', openPullRequests: [pullRequest(1, 'one', 'main'), pullRequest(2, 'two', 'one'), pullRequest(3, 'three', 'main')],
    mergeMethods: ['merge'], uninspectedNumbers: new Set(), restackResults: new Map([1, 2, 3].map(number => [number, { checked: true, parent: null }])), liveMergedBranches: new Map(), listAvailable: true,
  });
  await tracker.refreshReviewGroups('example', 'project');
  tracker.start = () => {};
  const server = await startTestServer(t, { state, pullRequestTracker: tracker });
  const post = (endpoint, body, headers = uiHeaders(server.info, `http://127.0.0.1:${server.info.port}`)) => request(server.info.port, {
    method: 'POST', path: `/api/hidden-${endpoint}`, body: JSON.stringify(body), headers: { 'content-type': 'application/json', ...headers },
  });
  const decisionBody = { action: 'hide', session_id: 'hidden-items', id: decision.id };
  const prBody = { action: 'hide', owner: 'example', repo: 'project', number: 1 };
  return { ...server, state, tracker, decision, post, decisionBody, prBody };
}

test('非表示の書き込み口は起動時の秘密値と同じ Origin を要求する', async t => {
  const f = await fixture(t);
  for (const [endpoint, body] of [['decisions', f.decisionBody], ['pull-requests', f.prBody]]) {
    assert.equal((await f.post(endpoint, body, {})).status, 401);
    assert.equal((await f.post(endpoint, body, uiHeaders(f.info))).status, 403);
    assert.equal((await f.post(endpoint, body, uiHeaders(f.info, 'https://other.example'))).status, 403);
    assert.equal((await f.post(endpoint, body, { ...uiHeaders(f.info, `http://127.0.0.1:${f.info.port}`), 'x-cockpit-secret': f.info.secret })).status, 401);
    assert.equal((await f.post(endpoint, body)).status, 200);
  }
});

test('非表示の書き込み口は未知の項目や不正な識別子を拒否する', async t => {
  const f = await fixture(t);
  for (const [endpoint, body] of [['decisions', f.decisionBody], ['pull-requests', f.prBody]]) {
    for (const invalid of [{ ...body, extra: true }, { ...body, action: 'clear' }, []]) {
      assert.equal((await f.post(endpoint, invalid)).status, 400);
    }
  }
  assert.equal((await f.post('decisions', { ...f.decisionBody, id: 'x'.repeat(257) })).status, 400);
  assert.equal((await f.post('decisions', { ...f.decisionBody, session_id: '../bad' })).status, 400);
  assert.equal((await f.post('pull-requests', { ...f.prBody, number: '1' })).status, 400);
  assert.equal((await f.post('pull-requests', { ...f.prBody, owner: '../bad' })).status, 400);
  assert.equal((await f.post('pull-requests', { ...f.prBody, number: 999 })).status, 404);
});

test('隠した判断はスナップショットに残り、トレイから除かれ、更新されても隠れたままになる', async t => {
  const f = await fixture(t);
  assert.equal((await f.post('decisions', f.decisionBody)).status, 200);
  const snapshot = jsonBody(await request(f.info.port, { path: '/api/state' }));
  assert.equal(snapshot.sessions[0].decisions[0].hidden, true);
  assert.deepEqual(jsonBody(await request(f.info.port, { path: '/api/tray' })).decisionKeys, []);
  f.state.updateDecision('hidden-items', f.decision.id, 'provisional', null, '推奨で進める');
  assert.equal(f.state.snapshot().sessions[0].decisions[0].hidden, true);
  assert.equal((await f.post('decisions', { ...f.decisionBody, action: 'unhide' })).status, 200);
  assert.equal(f.state.snapshot().sessions[0].decisions[0].hidden, undefined);
});

test('回答の秒読み中と終了済みの判断は非表示にできない', async t => {
  const f = await fixture(t);
  f.state.setDecisionLifecycle('hidden-items', f.decision.id, { awaitingAnswerUntil: new Date(Date.now() + 60000).toISOString() });
  assert.equal((await f.post('decisions', f.decisionBody)).status, 409);
  f.state.setDecisionLifecycle('hidden-items', f.decision.id, { state: 'resolved', awaitingAnswerUntil: null });
  assert.equal((await f.post('decisions', f.decisionBody)).status, 409);
});

test('PR を隠すと木の子孫も集計から外れ、マージの条件と子孫の記録は維持される', async t => {
  const f = await fixture(t);
  const before = f.tracker.snapshot()[0];
  assert.equal((await f.post('pull-requests', f.prBody)).status, 200);
  const group = jsonBody(await request(f.info.port, { path: '/api/state' })).pullRequests[0];
  assert.equal(group.openCount, 1);
  assert.equal(group.mergeableCount, before.mergeableCount - 1);
  assert.equal(group.trees[0].hidden, true);
  assert.equal(group.trees[0].children[0].hidden, true);
  assert.equal(group.trees[0].canMerge, before.trees[0].canMerge);
  assert.deepEqual(group.hiddenPrs, [{ number: 1, descendants: 1 }]);
  assert.deepEqual(f.state.serializeStore().hiddenPrs, [{ owner: 'example', repo: 'project', number: 1 }]);
  await f.post('pull-requests', { ...f.prBody, action: 'unhide' });
  assert.equal(f.tracker.snapshot()[0].openCount, before.openCount);
});

test('子の PR を個別に隠すと親を残し、親を隠して戻しても子の非表示を維持する', async t => {
  const f = await fixture(t);
  await f.post('pull-requests', { ...f.prBody, number: 2 });
  const childHidden = f.tracker.snapshot()[0];
  assert.equal(childHidden.trees[0].hidden, false);
  assert.equal(childHidden.trees[0].stackPosition.total, 1);
  assert.equal(childHidden.trees[0].children[0].hidden, true);
  await f.post('pull-requests', f.prBody);
  await f.post('pull-requests', { ...f.prBody, action: 'unhide' });
  assert.equal(f.tracker.snapshot()[0].trees[0].children[0].hidden, true);
});

test('判断事項の非表示は上限を超える要求を拒み、すでに隠した判断は維持する', async t => {
  const f = await fixture(t);
  for (let index = 0; index < 200; index += 1) {
    const decision = f.state.addDecision('hidden-items', { title: `判断 ${index}`, context: '', state: 'waiting', options: [] });
    assert.equal((await f.post('decisions', { ...f.decisionBody, id: decision.id })).status, 200);
  }
  assert.equal((await f.post('decisions', f.decisionBody)).status, 409);
  assert.equal(f.state.snapshot().sessions[0].decisions.filter(decision => decision.hidden).length, 200);
});

test('判断事項と PR の非表示記録は保存して読み直しても残る', async t => {
  const f = await fixture(t);
  await f.post('decisions', f.decisionBody);
  await f.post('pull-requests', f.prBody);
  await f.state.flushPersistence();
  const restored = await DashboardState.load(f.homeDir);
  restored.syncSessionFiles([{ session_id: 'hidden-items', cwd: process.cwd() }]);
  assert.equal(restored.snapshot().sessions[0].decisions[0].hidden, true);
  assert.deepEqual(restored.serializeStore().hiddenPrs, f.state.serializeStore().hiddenPrs);
  await restored.flushPersistence();
});

test('読み直し時にまだ組み立てていない判断の非表示記録は、セッションが残る間は消さない', async t => {
  const f = await fixture(t);
  const stored = f.state.serializeStore();
  stored.hiddenDecisions = [{ session_id: 'hidden-items', id: 'event-only-decision' }, { session_id: 'gone-session', id: 'gone-decision' }];
  const { homeDir } = temporaryHome(t);
  await fs.writeFile(path.join(homeDir, 'store.json'), JSON.stringify(stored));
  const restored = await DashboardState.load(homeDir);
  assert.deepEqual(restored.serializeStore().hiddenDecisions, [{ session_id: 'hidden-items', id: 'event-only-decision' }]);
  await restored.flushPersistence();
});

test('非表示のキーが無い保存形式を読み込める', async t => {
  const f = await fixture(t);
  const stored = f.state.serializeStore();
  delete stored.hiddenDecisions;
  delete stored.hiddenPrs;
  const { homeDir } = temporaryHome(t);
  await fs.writeFile(path.join(homeDir, 'store.json'), JSON.stringify(stored));
  const restored = await DashboardState.load(homeDir);
  assert.equal(restored.planSummary('hidden-items').decisions.length, 1);
  assert.deepEqual(restored.serializeStore().hiddenDecisions, []);
  assert.deepEqual(restored.serializeStore().hiddenPrs, []);
  await restored.flushPersistence();
});

test('解決と取り下げと削除で判断の非表示記録が消える', async t => {
  for (const state of ['resolved', 'withdrawn', 'deleted']) {
    const f = await fixture(t);
    await f.post('decisions', f.decisionBody);
    if (state === 'deleted') f.state.deleteSession('hidden-items');
    else f.state.setDecisionLifecycle('hidden-items', f.decision.id, { state });
    assert.deepEqual(f.state.serializeStore().hiddenDecisions, []);
  }
});

test('マージとクローズで PR の非表示記録が消える', async t => {
  const f = await fixture(t);
  for (const state of ['merged', 'closed']) {
    await f.post('pull-requests', f.prBody);
    f.state.updatePullRequest('hidden-items', 'example', 'project', 1, { state });
    assert.deepEqual(f.state.serializeStore().hiddenPrs, []);
  }
});
