const test = require('node:test');
const assert = require('node:assert/strict');
const { DashboardState } = require('../src/server/state');
const { PullRequestTracker } = require('../src/server/pull-requests');
const { DecisionAnswerDelivery } = require('../src/server/decision-answers');
const { pullRequest } = require('./support/github');
const { request, startTestServer } = require('./support/server');
const { runAnswerHookMain } = require('../src/hooks/answer');
const { Writable } = require('node:stream');

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
  let requestId = 0;
  const stop = async () => {
    const generation = delivery.startStop(sessionId, `stop-${++requestId}`);
    const result = await delivery.waitForStopAnswer(sessionId, generation);
    if (result.stderrText) {
      const record = delivery.recordHookDelivery({ sessionId, action: 'stop-poll', requestId: `poll-${requestId}`,
        requestGeneration: generation, generation, response: result });
      delivery.acknowledgeHookDelivery(sessionId, record.deliveryId);
    }
    return result;
  };
  return { state, sessionId, tracker, pr, logs, delivery, stop };
}

async function reminderHttp(t) {
  let now = Date.now();
  const f = reminderFixture(t, { now: () => now });
  const server = await startTestServer(t, { state: f.state, answerDelivery: f.delivery });
  let id = 0;
  const send = async (action, extra = {}) => {
    const response = await request(server.info.port, { method: 'POST', path: '/api/hooks/answers',
      headers: { 'x-cockpit-secret': server.info.secret },
      body: JSON.stringify({ session_id: f.sessionId, action, event_name: action === 'user-prompt-submit' ? 'UserPromptSubmit' : 'Stop',
        id: `http-${++id}`, ...extra }) });
    assert.equal(response.status, 200);
    return JSON.parse(response.body);
  };
  const stop = async () => {
    const result = await send('stop-check', { provider: 'claude' });
    if (result.deliveryId) await send('delivery-ack', { delivery_id: result.deliveryId });
    return result.hookOutput?.reason || null;
  };
  return { ...f, ...server, send, stop, now: () => now, advance: ms => { now += ms; } };
}

async function addReminderEvent(f, event) {
  const response = await request(f.info.port, { method: 'POST', path: '/api/events',
    headers: { 'x-cockpit-secret': f.info.secret },
    body: JSON.stringify({ session_id: f.sessionId, hookAt: f.now(), ...event }) });
  assert.equal(response.status, 202);
}

test('ACK 後も未記録なら新しい UserPromptSubmit の後の Stop で再び催促する', async t => {
  const f = await reminderHttp(t);
  assert.match(await f.stop(), /現在の head/);
  assert.equal(await f.stop(), null);
  await f.send('user-prompt-submit');
  assert.match(await f.stop(), /cockpit_defer_review/);
});

test('ACK 後の最後の配信から 30 分が過ぎた Stop で再び催促する', async t => {
  const f = await reminderHttp(t);
  await f.stop();
  f.advance(30 * 60_000 + 1);
  assert.match(await f.stop(), /cockpit_skip_review/);
});

test('入力と時間経過を繰り返しても同じ head の催促は 3 回を超えない', async t => {
  const f = await reminderHttp(t);
  for (let count = 0; count < 3; count += 1) {
    assert.match(await f.stop(), /cockpit_skip_review/);
    f.advance(31 * 60_000);
    await f.send('user-prompt-submit');
  }
  assert.equal(await f.stop(), null);
  const response = await request(f.info.port, { path: '/api/state' });
  assert.equal(response.status, 200);
  assert.ok((await f.tracker.missingReviewRecords(f.sessionId)).length);
});

test('古い head の収束または往復の記録だけなら現在の head の記録を催促する', async t => {
  for (const review of [{ round: 1, reviewedSha: 'b'.repeat(40) },
    { round: 1, triage: { round: 1, outcome: 'converged', sha: 'b'.repeat(40) } }]) {
    const f = await reminderHttp(t);
    f.tracker.readCrossReviewState = async () => review;
    assert.match(await f.stop(), /古い head/);
  }
});

test('現在の head の保留記録があれば Stop で催促しない', async t => {
  const f = await reminderHttp(t);
  f.state.setCrossReviewDeferral({ owner: 'example', repo: 'project', number: 31,
    headRefOid: f.pr.headRefOid, reason: '実機が無い', next: '実機でレビューする', recordedAt: new Date().toISOString() });
  assert.equal(await f.stop(), null);
});

test('実行中のクロスレビュー Codex は前面とバックグラウンドのどちらでも Stop の催促を止める', async t => {
  for (const backgrounded of [false, true]) {
    const f = await reminderHttp(t);
    await addReminderEvent(f, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'review-launch',
      codexReviewDefinition: 'codex-review' });
    if (backgrounded) {
      await addReminderEvent(f, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'review-launch',
        backgroundTaskId: 'review-task' });
    }
    assert.deepEqual(f.state.sessions.get(f.sessionId).reviewRuns.map(({ agent_id }) => agent_id), ['codex:review-launch']);
    assert.equal(await f.stop(), null);
    const response = await request(f.info.port, { path: '/api/state' });
    const session = JSON.parse(response.body).sessions.find(({ session_id }) => session_id === f.sessionId);
    assert.equal(session.reviewRuns, undefined);
  }
});

test('見送った Stop は催促の上限に数えず、バックグラウンドレビューの完了後に 3 回まで催促する', async t => {
  const f = await reminderHttp(t);
  await addReminderEvent(f, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'review-launch',
    codexReviewDefinition: 'codex-review' });
  await addReminderEvent(f, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'review-launch',
    backgroundTaskId: 'review-task' });

  assert.equal(await f.stop(), null);
  assert.equal(f.delivery.remindedReviewHeads.has(f.sessionId), false);
  assert.equal(f.delivery.pendingHookReminders.has(f.sessionId), false);
  assert.deepEqual(f.logs, []);

  await addReminderEvent(f, { hook_event_name: 'UserPromptSubmit',
    backgroundTaskEnds: [{ taskId: 'review-task', status: 'completed' }] });
  assert.deepEqual(f.state.sessions.get(f.sessionId).reviewRuns, []);
  for (let count = 0; count < 3; count += 1) {
    assert.match(await f.stop(), /cockpit_skip_review/);
    if (count < 2) {
      f.advance(30 * 60_000 + 1);
      await f.send('user-prompt-submit');
    }
  }
  f.advance(30 * 60_000 + 1);
  await f.send('user-prompt-submit');
  assert.equal(await f.stop(), null);
});

test('起動を拒否されたクロスレビュー Codex は Stop の催促を止めない', async t => {
  const f = await reminderHttp(t);
  await addReminderEvent(f, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'review-launch',
    codexReviewDefinition: 'codex-review' });
  f.advance(1);
  await addReminderEvent(f, { hook_event_name: 'PostToolBatch' });
  assert.deepEqual(f.state.sessions.get(f.sessionId).reviewRuns, []);
  assert.match(await f.stop(), /cockpit_skip_review/);
});

test('実行中の review-claude サブエージェントは Stop の催促を止める', async t => {
  const f = await reminderHttp(t);
  await addReminderEvent(f, { hook_event_name: 'SubagentStart', agent_id: 'review-agent', agent_type: 'review-claude' });
  assert.deepEqual(f.state.sessions.get(f.sessionId).reviewRuns.map(({ agent_id }) => agent_id), ['review-agent']);
  assert.equal(await f.stop(), null);
});

test('開始から 60 分を過ぎた実行中レビューは Stop の催促を止めない', async t => {
  const f = await reminderHttp(t);
  await addReminderEvent(f, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'review-launch',
    codexReviewDefinition: 'codex-review' });
  f.advance(60 * 60_000 + 1);
  assert.deepEqual(f.state.sessions.get(f.sessionId).reviewRuns.map(({ agent_id }) => agent_id), ['codex:review-launch']);
  assert.match(await f.stop(), /cockpit_skip_review/);
});

for (const options of [{ noninteractive: true }, { provider: 'codex' }, {}]) {
  test(`${options.provider || (options.noninteractive ? '非対話' : 'Claude stop-poll')} の Stop は出力後に ACK し再催促の上限を守る`, async t => {
    const f = await reminderHttp(t);
    let output = '';
    const stream = new Writable({ write(chunk, _encoding, done) { output += chunk; done(); } });
    const run = async () => {
      output = '';
      await runAnswerHookMain({ session_id: f.sessionId, hook_event_name: 'Stop' }, stream, stream, {
        ...options, now: f.now, once: true, isParentAlive: () => true, readServerInfo: async () => f.info, homeDir: f.homeDir,
      });
      return output;
    };
    assert.match(await run(), /cockpit_defer_review/);
    assert.equal(await run(), '');
    f.advance(30 * 60_000 + 1);
    assert.match(await run(), /cockpit_defer_review/);
    assert.equal(await run(), '');
    await f.send('user-prompt-submit');
    assert.match(await run(), /cockpit_defer_review/);
    await f.send('user-prompt-submit');
    assert.equal(await run(), '');
  });
}

test('未記録の PR は ACK 後の同じターンの Stop では再び催促しない', async (t) => {
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

test('現在の head のレビュー記録や不要記録と確認不能や競合は催促しない', async (t) => {
  const { tracker, stop, pr } = await reminderHttp(t);
  for (const review of [undefined, { notRequired: true, source: 'tool-absent' },
    { notRequired: true, source: 'recorded' }, { unavailable: true },
    { round: 1, reviewedSha: pr.headRefOid },
    { round: 1, triage: { round: 1, sha: pr.headRefOid, outcome: 'converged' } },
    { round: 1, triage: { round: 1, sha: pr.headRefOid, outcome: 'halted' } },
    { round: 1, triage: { round: 1, sha: pr.headRefOid, outcome: 'fixing' } },
    { round: 1, reviewedSha: 'b'.repeat(40), conflict: [{ outcome: 'halted', round: 1, sha: pr.headRefOid }] }]) {
    tracker.readCrossReviewState = async () => review;
    assert.equal(await stop(), null);
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

for (const action of ['stop-check', 'stop-poll']) {
  test(`${action} の未 ACK のレビュー催促は次の Stop で再配信し、ACK 後は同じターンで繰り返さない`, async (t) => {
    const f = reminderFixture(t);
    const server = await startTestServer(t, { state: f.state, answerDelivery: f.delivery });
    const send = async (action, id, extra = {}) => {
      const response = await request(server.info.port, { method: 'POST', path: '/api/hooks/answers',
        headers: { 'x-cockpit-secret': server.info.secret },
        body: JSON.stringify({ session_id: f.sessionId, event_name: 'Stop', ...(action === 'stop-check' ? { provider: 'claude' } : {}), action, id, ...extra }) });
      assert.equal(response.status, 200);
      return JSON.parse(response.body);
    };
    const next = async (id) => {
      const { generation } = await send('stop-start', `start-${id}`);
      const body = { generation, parent_alive: true };
      return { body, result: await send(action, id, body) };
    };
    const first = await next('lost');
    assert.match(first.result.hookOutput?.reason || first.result.stderrText, /cockpit_skip_review/);
    assert.deepEqual(await send(action, 'lost', first.body), first.result);
    const second = await next('next');
    assert.match(second.result.hookOutput?.reason || second.result.stderrText, /cockpit_skip_review/);
    await send('delivery-ack', 'late-ack', { delivery_id: first.result.deliveryId });
    const third = await next('still-unacknowledged');
    assert.match(third.result.hookOutput?.reason || third.result.stderrText, /cockpit_skip_review/);
    await send('delivery-ack', 'ack', { delivery_id: third.result.deliveryId });
    const acknowledged = (await next('acknowledged')).result;
    assert.equal(acknowledged.hookOutput || acknowledged.stderrText || null, null);
  });
}

test('レビュー判定中に別の要求が取得したタスク催促を、レビュー催促の ACK で配信済みにしない', async (t) => {
  const f = reminderFixture(t);
  const server = await startTestServer(t, { state: f.state, answerDelivery: f.delivery });
  const send = async (action, id, extra = {}) => {
    const response = await request(server.info.port, { method: 'POST', path: '/api/hooks/answers',
      headers: { 'x-cockpit-secret': server.info.secret },
      body: JSON.stringify({ session_id: f.sessionId, action, id, ...extra }) });
    assert.equal(response.status, 200);
    return JSON.parse(response.body);
  };
  await request(server.info.port, { method: 'POST', path: '/api/events',
    headers: { 'x-cockpit-secret': server.info.secret },
    body: JSON.stringify({ session_id: f.sessionId, hook_event_name: 'PreToolUse', tool_name: 'Agent', hookAt: Date.now() - 1 }) });
  let finishReview;
  let reviewStarted;
  const started = new Promise((resolve) => { reviewStarted = resolve; });
  f.tracker.readCrossReviewState = () => new Promise((resolve) => { finishReview = resolve; reviewStarted(); });
  const stop = send('stop-check', 'stop', { event_name: 'Stop', provider: 'claude' });
  await started;
  const batch = await send('post-tool-batch', 'batch', { event_name: 'PostToolBatch' });
  assert.match(batch.hookOutput.hookSpecificOutput.additionalContext, /タスクが登録されていない/);
  finishReview(null);
  const review = await stop;
  assert.match(review.hookOutput.reason, /cockpit_skip_review/);
  await send('delivery-ack', 'review-ack', { delivery_id: review.deliveryId });
  const retry = await send('post-tool-batch', 'next-batch', { event_name: 'PostToolBatch' });
  assert.match(retry.hookOutput.hookSpecificOutput.additionalContext, /タスクが登録されていない/);
});
