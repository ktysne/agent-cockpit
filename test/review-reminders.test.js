const test = require('node:test');
const assert = require('node:assert/strict');
const { DashboardState } = require('../src/server/state');
const { PullRequestTracker } = require('../src/server/pull-requests');
const { DecisionAnswerDelivery } = require('../src/server/decision-answers');
const { pullRequest } = require('./support/github');
const { request, startTestServer } = require('./support/server');

function reminderFixture(t, options = {}) {
  const state = new DashboardState();
  const sessionId = 'session-reminder';
  state.registerPullRequest(sessionId, { url: 'https://github.com/example/project/pull/31' });
  const tracker = new PullRequestTracker({ state, readCrossReviewStateAcrossWorktrees: async () => null });
  const pr = pullRequest(31, 'feature', 'main');
  tracker.repositories.set('example/project', {
    owner: 'example', repo: 'project', defaultBranch: 'main', openPullRequests: [pr],
    mergeMethods: ['merge'], listAvailable: true, uninspectedNumbers: new Set(),
  });
  const logs = [];
  const delivery = new DecisionAnswerDelivery({
    state, away: { snapshot: () => ({ enabled: false }) }, pullRequestTracker: tracker,
    diagnostics: { record: (...args) => logs.push(args) }, maxLongPollMs: 1,
    ...options,
  });
  t.after(() => { delivery.close(); tracker.close(); });
  const stop = async () => delivery.waitForStopAnswer(sessionId, await delivery.startStop(sessionId, 'stop'));
  return { state, sessionId, tracker, pr, logs, delivery, stop };
}

test('未記録の PR は同じセッションと head で一度だけ催促する', async (t) => {
  const { stop, logs, pr } = reminderFixture(t);
  const first = await stop();
  assert.match(first.stderrText, /PR #31 \(example\/project\)/);
  assert.match(first.stderrText, /cockpit_skip_review/);
  assert.match(first.stderrText, /日本語/);
  assert.ok(!first.stderrText.includes(pr.headRefOid));
  assert.equal((await stop()).stderrText, null);
  assert.deepEqual(logs, [['info', 'merge', 'review.reminder', {
    repository: 'example/project', number: 31, session: 'session-',
  }]]);
});

test('head が変わると同じ PR でも催促する', async (t) => {
  const { stop, pr } = reminderFixture(t);
  await stop();
  pr.headRefOid = 'a'.repeat(40);
  assert.match((await stop()).stderrText, /cockpit_skip_review/);
});

test('レビュー記録や不要記録があれば催促しない', async (t) => {
  const { tracker, stop } = reminderFixture(t);
  for (const review of [undefined, { notRequired: true, source: 'tool-absent' },
    { notRequired: true, source: 'recorded' }, { unavailable: true },
    { round: 1, reviewedSha: 'b'.repeat(40) },
    { round: 1, reviewedSha: '0'.repeat(38) + '31', triage: { outcome: 'converged' } }]) {
    tracker.readCrossReviewState = async () => review;
    assert.equal((await stop()).stderrText, null);
  }
});

test('開発者の回答待ちの判断事項があれば催促しない', async (t) => {
  const { state, sessionId, stop } = reminderFixture(t);
  state.addDecision(sessionId, { title: '方式を選ぶ', context: '', state: 'waiting', options: [] });
  assert.equal((await stop()).stderrText, null);
});

test('推奨を仮に適用した判断事項は催促を止めない', async (t) => {
  const { state, sessionId, stop } = reminderFixture(t);
  state.addDecision(sessionId, { title: '方式を選ぶ', context: '', state: 'provisional', options: [] });
  assert.match((await stop()).stderrText, /cockpit_skip_review/);
});

test('Stop の開始はレビュー記録の判定を待たずに generation を返す', (t) => {
  const { tracker, delivery, sessionId } = reminderFixture(t);
  tracker.readCrossReviewState = () => new Promise(() => {});
  assert.ok(Number.isInteger(delivery.startStop(sessionId, 'stop')));
});

test('Stop の催促は PostToolBatch や UserPromptSubmit で配らない', async (t) => {
  const { delivery, sessionId } = reminderFixture(t);
  const generation = await delivery.startStop(sessionId, 'stop');
  assert.equal(delivery.deliverPostToolBatch(sessionId), null);
  assert.match((await delivery.waitForStopAnswer(sessionId, generation)).stderrText, /cockpit_skip_review/);
  assert.equal(delivery.deliverPrompt(sessionId, 'prompt'), null);
});

test('Codex の checkStop は催促を block 理由に含める', async (t) => {
  const { delivery, sessionId } = reminderFixture(t);
  const result = await delivery.checkStop(sessionId, 'stop');
  assert.equal(result.hookOutput.decision, 'block');
  assert.match(result.hookOutput.reason, /cockpit_skip_review/);
});

test('ローカル記録の読み直しに失敗しても Stop を続ける', async (t) => {
  const { tracker, stop } = reminderFixture(t);
  tracker.readCrossReviewState = async () => { throw new Error('read failed'); };
  assert.equal((await stop()).stderrText, null);
});

test('PR 再取得が上限を超えた Stop には後から催促を追加しない', async (t) => {
  const { tracker, delivery, sessionId } = reminderFixture(t, { reviewReminderWaitMs: 5 });
  let finish;
  tracker.inFlight.set('example/project', new Promise((resolve) => { finish = resolve; }));
  const generation = delivery.startStop(sessionId, 'stop');
  await new Promise((resolve) => setTimeout(resolve, 30));
  finish();
  assert.equal((await delivery.waitForStopAnswer(sessionId, generation)).stderrText, null);
  assert.equal((await delivery.waitForStopAnswer(sessionId, generation)).stderrText, null);
});

test('Stop は進行中の PR 再取得後にローカル記録を読み直す', async (t) => {
  const { tracker, delivery, sessionId } = reminderFixture(t);
  let finish;
  tracker.inFlight.set('example/project', new Promise((resolve) => { finish = resolve; }));
  let reads = 0;
  tracker.readCrossReviewState = async () => { reads += 1; return null; };
  const starting = delivery.startStop(sessionId, 'stop');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(reads, 0);
  tracker.readCrossReviewState = async () => ({ notRequired: true, source: 'tool-absent' });
  finish();
  assert.equal((await delivery.waitForStopAnswer(sessionId, await starting)).stderrText, null);
});

test('セッション終了で催促済みの head の記録を消す', async (t) => {
  const { stop, delivery, sessionId } = reminderFixture(t);
  await stop();
  delivery.sessionEnded(sessionId);
  delivery.sessionReopened(sessionId);
  assert.match((await stop()).stderrText, /cockpit_skip_review/);
});

test('非同期の Stop 開始と Codex の判定を HTTP で返す', async (t) => {
  const fixture = reminderFixture(t);
  const { runtime, info } = await startTestServer(t, { state: fixture.state, pullRequestOptions: {
    readCrossReviewStateAcrossWorktrees: async () => null,
    execFileImpl: (_file, _args, _options, callback) => callback(new Error('GitHub unavailable')),
  } });
  await Promise.all(runtime.pullRequestTracker.inFlight.values());
  runtime.pullRequestTracker.repositories.set('example/project', fixture.tracker.repositories.get('example/project'));
  const send = async (action, extra = {}) => {
    const response = await request(info.port, { method: 'POST', path: '/api/hooks/answers',
      headers: { 'content-type': 'application/json', 'x-cockpit-secret': info.secret },
      body: JSON.stringify({ action, event_name: 'Stop', session_id: fixture.sessionId, id: action, ...extra }) });
    assert.equal(response.status, 200);
    return JSON.parse(response.body);
  };
  const { generation } = await send('stop-start');
  assert.ok(Number.isInteger(generation));
  const result = await send('stop-poll', { generation, parent_alive: true });
  assert.match(result.stderrText, /cockpit_skip_review/);
  fixture.pr.headRefOid = 'a'.repeat(40);
  const codex = await send('stop-check', { provider: 'codex' });
  assert.equal(codex.hookOutput.decision, 'block');
  await runtime.diagnostics.flush();
  const entries = await runtime.diagnostics.readRun(runtime.diagnostics.run);
  const reminder = entries.filter((entry) => entry.msg === 'review.reminder');
  assert.deepEqual(reminder.map((entry) => entry.data), [{ repository: 'example/project', number: 31, session: 'session-' }]);
});

test('登録していない PR、別セッションの PR、閉じた PR は催促しない', async (t) => {
  const { tracker, state, sessionId, stop } = reminderFixture(t);
  state.registerPullRequest('session-other', { url: 'https://github.com/example/project/pull/32' });
  state.registerPullRequest(sessionId, { url: 'https://github.com/example/project/pull/34' });
  tracker.repositories.get('example/project').openPullRequests.push(
    pullRequest(32, 'other', 'main'), pullRequest(33, 'unregistered', 'main'));
  const result = await stop();
  assert.match(result.stderrText, /PR #31/);
  assert.doesNotMatch(result.stderrText, /PR #(32|33|34)/);
});

test('複数の PR の催促は各 PR を一行にし本文は一度だけ返す', async (t) => {
  const { state, sessionId, tracker, stop } = reminderFixture(t);
  state.registerPullRequest(sessionId, { url: 'https://github.com/example/project/pull/32' });
  tracker.repositories.get('example/project').openPullRequests.push(pullRequest(32, 'second', 'main'));
  const { stderrText } = await stop();
  assert.match(stderrText, /PR #31 \(example\/project\)。\nPR #32 \(example\/project\)。/);
  assert.equal(stderrText.match(/cockpit_skip_review/g).length, 1);
});


test('現在の head への不要記録があればローカルレビュー状態に関係なく催促しない', async (t) => {
  const { state, pr, stop } = reminderFixture(t);
  state.setCrossReviewSkip({ owner: 'example', repo: 'project', number: 31,
    headRefOid: pr.headRefOid, reason: '文言だけの修正', recordedAt: new Date().toISOString() });
  assert.equal((await stop()).stderrText, null);
});

test('Stop のローカル読み直しが上限を超えても Stop を続ける', async (t) => {
  const { tracker, stop } = reminderFixture(t, { reviewReminderWaitMs: 5 });
  tracker.readCrossReviewState = () => new Promise(() => {});
  assert.equal((await stop()).stderrText, null);
});

test('読み直し中に次の入力が届いた Stop の催促は破棄する', async (t) => {
  const { tracker, delivery, sessionId } = reminderFixture(t);
  let finish;
  tracker.readCrossReviewState = () => new Promise((resolve) => { finish = resolve; });
  const starting = delivery.startStop(sessionId, 'stop', 1);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivery.deliverPrompt(sessionId, 'prompt', 2), null);
  finish(null);
  assert.deepEqual(await delivery.waitForStopAnswer(sessionId, await starting), { stderrText: null, done: true });
});
