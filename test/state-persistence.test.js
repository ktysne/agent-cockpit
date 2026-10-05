const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AwayState, DashboardState } = require('../src/server/state');
const { AtomicJsonWriter } = require('../src/server/json-storage');
const { temporaryDirectory } = require('./support/temp');

const DAY_MS = 24 * 60 * 60 * 1000;

async function temporaryHome(testContext) {
  return temporaryDirectory(testContext, 'agent-cockpit-store-test-').directory;
}

function task(title, state = 'doing') {
  return { title, state, criteria: [{ text: '確認する', met: false }] };
}

function decisionInput(title) {
  return {
    title,
    context: '背景',
    state: 'waiting',
    options: [{ label: '案 A', description: '説明', recommended: true }],
  };
}

test('指定した外したセッションだけを戻し、変更があるときだけ保存する', () => {
  const state = new DashboardState();
  state.hiddenSessions.add('restore-one');
  state.hiddenSessions.add('restore-two');
  state.hiddenSessionUpdatedAt.set('restore-one', '2026-10-03T00:00:00.000Z');
  state.hiddenSessionUpdatedAt.set('restore-two', '2026-10-03T00:00:01.000Z');
  let writes = 0;
  state.requestStoreWrite = () => { writes += 1; };
  const initialVersion = state.version;

  assert.equal(state.unhideSessions(['restore-one', 'restore-one', 'missing']), 1);
  assert.equal(state.hiddenSessions.has('restore-one'), false);
  assert.equal(state.hiddenSessionUpdatedAt.has('restore-one'), false);
  assert.equal(state.hiddenSessions.has('restore-two'), true);
  assert.equal(state.hiddenSessionUpdatedAt.has('restore-two'), true);
  assert.equal(state.version, initialVersion + 1);
  assert.equal(writes, 1);

  assert.equal(state.unhideSessions(['restore-one', 'missing']), 0);
  assert.equal(state.version, initialVersion + 1);
  assert.equal(writes, 1);
});

test('保存したタスク、判断事項、回答、完了記録、外したセッション、表示設定を新しい状態へ復元する', async (t) => {
  const homeDir = await temporaryHome(t);
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  const state = new DashboardState({ homeDir });
  state.syncSessionFiles([{ session_id: 'restored-session', cwd: 'C:\\project', name: '復元する作業' }], now);
  state.setTasks('restored-session', [task('画面を作る')], now);
  const decision = state.addDecision('restored-session', decisionInput('配置を選ぶ'), now);
  const answer = {
    choice: 'pick', note: '案 A で進める', picks: [['案 A']],
    sentAt: new Date(now + 1).toISOString(),
    deliveredAt: new Date(now + 2).toISOString(),
    reflectedAt: new Date(now + 3).toISOString(), promptDeliveries: 1,
  };
  state.setDecisionLifecycle('restored-session', decision.id, {
    answer,
    state: 'provisional',
    awaitingAnswerUntil: new Date(now + 60_000).toISOString(),
  }, now + 4);
  assert.equal(state.closeTask('restored-session', '画面を作る'), true);
  assert.equal(state.hideSession('restored-session', now), true);
  const display = {
    mode: 'kind', order: ['C:\\project'], pinned: ['C:\\project'],
    collapsed: ['C:\\project'], hidden: ['agents', 'prs'],
    sectionOrder: ['now', 'judgment', 'tasks', 'prs', 'sinceSeen'],
    longWaitMinutes: 37, awayAnswerWaitMinutes: 12, idleHideMinutes: 45, hideFinished: true, mergeableCondition: 'ci',
    mergeResultHideMinutes: 5,
  };
  state.patchDisplayPreferences(display);
  state.registerPullRequest('restored-session', { url: 'https://github.com/example/project/pull/47' }, {
    cwd: 'C:\\project', product: { key: 'project', name: 'project' },
  }, now);
  const reviewSkip = {
    owner: 'example', repo: 'project', number: 47, headRefOid: 'a'.repeat(40),
    reason: '軽微な文言修正のため', recordedAt: new Date(now).toISOString(),
  };
  assert.deepEqual(state.setCrossReviewSkip(reviewSkip), reviewSkip);
  await state.flushPersistence();

  const restored = await DashboardState.load(homeDir, { now: now + 5 });
  restored.syncSessionFiles([{ session_id: 'restored-session', cwd: 'C:\\project', name: '復元する作業' }], now + 5);
  const snapshot = restored.snapshot();
  const session = snapshot.sessions[0];
  assert.deepEqual(session.tasks.map(({ title, state, closedByUser }) => ({ title, state, closedByUser })), [
    { title: '画面を作る', state: 'done', closedByUser: true },
  ]);
  assert.equal(session.decisions[0].id, decision.id);
  assert.deepEqual(session.decisions[0].answer, answer);
  assert.equal(session.decisions[0].awaitingAnswerUntil, undefined);
  assert.equal(session.hidden, true);
  assert.deepEqual(snapshot.display, display);
  assert.deepEqual(restored.crossReviewSkip('example', 'project', 47), reviewSkip);
  const saved = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
  assert.deepEqual(saved.crossReviewSkips, [reviewSkip]);
});

test('古い表示設定は既定順を補い、保存済みの不明な種類や重複を正規化する', async (t) => {
  const expectedDefault = ['sinceSeen', 'judgment', 'tasks', 'now', 'prs'];
  const cases = [
    ['並び順がない', undefined, expectedDefault],
    ['不明な種類と重複がある', ['now', 'legacy', 'now', 'prs'], ['now', 'prs', 'sinceSeen', 'judgment', 'tasks']],
  ];

  for (const [name, sectionOrder, expected] of cases) {
    const homeDir = await temporaryHome(t);
    const display = { mode: 'product', order: [], pinned: [], collapsed: [], hidden: [], mergeAfterReviewDefault: true };
    if (sectionOrder !== undefined) display.sectionOrder = sectionOrder;
    await fs.writeFile(path.join(homeDir, 'store.json'), JSON.stringify({
      version: 1,
      display,
      plans: {},
      decisionLifecycles: {},
      closedTasks: [],
      hiddenSessions: [],
    }));

    const restored = await DashboardState.load(homeDir, { now: Date.parse('2026-10-03T00:00:00.000Z') });
    assert.deepEqual(restored.display.sectionOrder, expected, name);
    assert.equal(restored.getDisplayPreferences().mergeableCondition, 'cross-review', name);
    assert.equal(Object.hasOwn(restored.getDisplayPreferences(), 'mergeAfterReviewDefault'), false, name);
    assert.deepEqual(restored.crossReviewSkips.size, 0, name);
    assert.equal((await fs.readdir(homeDir)).some((file) => file.startsWith('store.json.broken-')), false, name);
    await restored.flushPersistence();
    const saved = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
    assert.deepEqual(saved.display.sectionOrder, expected, name);
    assert.equal(saved.display.mergeableCondition, 'cross-review', name);
    assert.equal(Object.hasOwn(saved.display, 'mergeAfterReviewDefault'), false, name);
    assert.deepEqual(saved.crossReviewSkips, [], name);
  }
});

test('レビュー不要の記録は PR 登録と同じ保持期限で片付ける', () => {
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  const state = new DashboardState();
  state.registerPullRequest('expired-review-session', { url: 'https://github.com/example/project/pull/48' }, {}, now - 14 * DAY_MS - 1);
  state.setCrossReviewSkip({
    owner: 'example', repo: 'project', number: 48, headRefOid: 'b'.repeat(40),
    reason: '変更が軽微なため', recordedAt: new Date(now - 14 * DAY_MS - 1).toISOString(),
  });

  state.pruneExpiredStoreRecords(now);

  assert.equal(state.pullRequestRegistrations().some((record) => record.number === 48), false);
  assert.equal(state.crossReviewSkip('example', 'project', 48), null);
});

test('マージ結果を隠す時間は旧設定と不正値で既定を使う', async (t) => {
  for (const [name, value, expected] of [
    ['設定がない', undefined, 5],
    ['整数の下限', 1, 1],
    ['整数の上限', 60, 60],
    ['下限未満', 0, 5],
    ['上限超過', 61, 5],
    ['整数でない', 5.5, 5],
    ['数値でない', '5', 5],
  ]) {
    const homeDir = await temporaryHome(t);
    const display = { mode: 'product', order: [], pinned: [], collapsed: [], hidden: [] };
    if (value !== undefined) display.mergeResultHideMinutes = value;
    await fs.writeFile(path.join(homeDir, 'store.json'), JSON.stringify({
      version: 1, display, plans: {}, decisionLifecycles: {}, closedTasks: [], hiddenSessions: [],
    }));

    const restored = await DashboardState.load(homeDir);
    assert.equal(restored.getDisplayPreferences().mergeResultHideMinutes, expected, name);
    assert.equal((await fs.readdir(homeDir)).some((file) => file.startsWith('store.json.broken-')), false, name);
  }
});

test('予約マージ結果の閉じた時刻を保存し、旧形式は未閉鎖として読む', async (t) => {
  const homeDir = await temporaryHome(t);
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  const state = new DashboardState({ homeDir });
  state.recordMergedPullRequest({
    owner: 'example', repo: 'project', number: 41, title: '予約結果',
    url: 'https://github.com/example/project/pull/41', mergedAt: new Date(now).toISOString(),
    method: 'squash', automatic: true,
    automaticResult: { branchDeleted: false, autoDeleteBranch: false, retargetedBase: null, retargetedNumbers: [], warning: null },
  }, now);
  await state.flushPersistence();

  const restoredLegacy = await DashboardState.load(homeDir, { now: now + 1 });
  const legacyRecord = restoredLegacy.mergedPullRequestHistoryForRepo('example', 'project', now + 1)[0];
  assert.equal(Object.hasOwn(legacyRecord, 'mergeResultClosedAt'), false);
  assert.equal(restoredLegacy.closeAutomaticPullRequestMergeResult('example', 'project', 41, now + 2), true);
  assert.equal(restoredLegacy.closeAutomaticPullRequestMergeResult('example', 'project', 41, now + 3), false);
  await restoredLegacy.flushPersistence();

  const restoredClosed = await DashboardState.load(homeDir, { now: now + 4 });
  const closedRecord = restoredClosed.mergedPullRequestHistoryForRepo('example', 'project', now + 4)[0];
  assert.equal(closedRecord.mergeResultClosedAt, new Date(now + 2).toISOString());
});

test('保存時刻の欠落や範囲外の値は表示設定の既定値で補う', async (t) => {
  const cases = [
    ['値がない', {}, 15, 5, 30, true],
    ['終わったものの設定が偽', { hideFinished: false }, 15, 5, 30, false],
    ['終わったものの設定が真偽値でない', { hideFinished: 'false' }, 15, 5, 30, true],
    ['長い待ち時間が範囲外', { longWaitMinutes: 121, awayAnswerWaitMinutes: 12 }, 15, 12, 30, true],
    ['回答待ち時間が整数でない', { longWaitMinutes: 30, awayAnswerWaitMinutes: 2.5 }, 30, 5, 30, true],
    ['更新間隔が最小値', { idleHideMinutes: 5 }, 15, 5, 5, true],
    ['更新間隔が最大値', { idleHideMinutes: 1440 }, 15, 5, 1440, true],
    ['更新間隔が下限未満', { idleHideMinutes: 4 }, 15, 5, 30, true],
    ['更新間隔が上限超過', { idleHideMinutes: 1441 }, 15, 5, 30, true],
    ['更新間隔が整数でない', { idleHideMinutes: 30.5 }, 15, 5, 30, true],
  ];

  for (const [name, settings, expectedLongWait, expectedAwayWait, expectedIdleHide, expectedHideFinished] of cases) {
    const homeDir = await temporaryHome(t);
    await fs.writeFile(path.join(homeDir, 'store.json'), JSON.stringify({
      version: 1,
      display: { mode: 'product', order: [], pinned: [], collapsed: [], hidden: [], ...settings },
      plans: {},
      decisionLifecycles: {},
      closedTasks: [],
      hiddenSessions: [],
    }));

    const restored = await DashboardState.load(homeDir);
    assert.equal(restored.display.longWaitMinutes, expectedLongWait, name);
    assert.equal(restored.display.awayAnswerWaitMinutes, expectedAwayWait, name);
    assert.equal(restored.display.idleHideMinutes, expectedIdleHide, name);
    assert.equal(restored.display.hideFinished, expectedHideFinished, name);
    assert.equal((await fs.readdir(homeDir)).some((file) => file.startsWith('store.json.broken-')), false, name);
    await restored.flushPersistence();
    const saved = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
    assert.equal(saved.display.longWaitMinutes, expectedLongWait, name);
    assert.equal(saved.display.awayAnswerWaitMinutes, expectedAwayWait, name);
    assert.equal(saved.display.idleHideMinutes, expectedIdleHide, name);
    assert.equal(saved.display.hideFinished, expectedHideFinished, name);
  }
});

test('積み直し用の項目を含む旧 store を退避せず読み、次の保存から項目を除く', async (t) => {
  const homeDir = await temporaryHome(t);
  const lastOpen = {
    title: 'Legacy PR',
    url: 'https://github.com/example/project/pull/41',
    headRefName: 'feat/legacy',
    baseRefName: 'main',
    headRefOid: 'a'.repeat(40),
    basePullRequestNumber: 40,
    basePullRequestHeadRefOid: 'b'.repeat(40),
    restackParents: [{ number: 40, headRefOid: 'b'.repeat(40), method: 'squash' }],
  };
  await fs.writeFile(path.join(homeDir, 'store.json'), JSON.stringify({
    version: 1,
    display: null,
    plans: {},
    decisionLifecycles: {},
    closedTasks: [],
    hiddenSessions: [],
    prs: [{
      session_id: 'legacy-session', owner: 'example', repo: 'project', number: 41,
      url: 'https://github.com/example/project/pull/41', addedAt: '2026-10-03T00:00:00.000Z',
      cwd: null, product: null, state: 'open', mergedAt: null, lastOpen,
    }],
    relatedPrs: [{
      owner: 'example', repo: 'project', number: 42,
      url: 'https://github.com/example/project/pull/42', addedAt: '2026-10-03T00:00:00.000Z',
      state: 'open', mergedAt: null,
      lastOpen: { ...lastOpen, url: 'https://github.com/example/project/pull/42', title: 'Related legacy PR' },
    }],
    retargetedPrs: [],
    mergedPrHeads: [{
      owner: 'example', repo: 'project', number: 40, headRefOid: 'b'.repeat(40),
      method: 'squash', mergedAt: '2026-10-02T00:00:00.000Z',
    }],
  }));

  const restored = await DashboardState.load(homeDir, { now: Date.parse('2026-10-03T00:00:00.000Z') });
  assert.equal(restored.pullRequestRegistrations().length, 1);
  assert.equal(restored.relatedPullRequestRegistrations().length, 1);
  assert.equal(Object.hasOwn(restored.pullRequestRegistrations()[0].lastOpen, 'restackParents'), false);
  assert.equal(Object.hasOwn(restored.relatedPullRequestRegistrations()[0].lastOpen, 'basePullRequestHeadRefOid'), false);
  assert.equal((await fs.readdir(homeDir)).some((file) => file.startsWith('store.json.broken-')), false);

  await restored.flushPersistence();
  const saved = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
  assert.equal(saved.prs.length, 1);
  assert.equal(saved.relatedPrs.length, 1);
  assert.equal(Object.hasOwn(saved.prs[0].lastOpen, 'basePullRequestNumber'), false);
  assert.equal(Object.hasOwn(saved.relatedPrs[0].lastOpen, 'restackParents'), false);
  assert.equal(Object.hasOwn(saved, 'mergedPrHeads'), false);
});

test('復元直後はセッション記録を残し最初の同期で期限切れを捨てる', async (t) => {
  const homeDir = await temporaryHome(t);
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  const expiredAt = now - 14 * DAY_MS - 1;
  const state = new DashboardState({ homeDir });
  state.syncSessionFiles([
    { session_id: 'expired-session', cwd: 'C:\\project', name: '期限切れ' },
    { session_id: 'current-session', cwd: 'C:\\project', name: '残す作業' },
  ], now);
  state.setTasks('expired-session', [task('古いタスク')], expiredAt);
  state.addDecision('expired-session', decisionInput('古い判断'), expiredAt);
  state.hideSession('expired-session', expiredAt);
  state.closeTask('expired-session', '古いタスク', expiredAt);
  state.setTasks('current-session', [task('新しいタスク')], now - 1);
  const currentDecision = state.addDecision('current-session', decisionInput('新しい判断'), now - 1);
  state.setDecisionLifecycle('current-session', currentDecision.id, {
    answer: { choice: 'ok', note: '', sentAt: new Date(now - 1).toISOString() },
    awaitingAnswerUntil: new Date(now + DAY_MS).toISOString(),
  }, now - 1);
  await state.flushPersistence();

  const storePath = path.join(homeDir, 'store.json');
  const persisted = JSON.parse(await fs.readFile(storePath, 'utf8'));
  persisted.decisionLifecycles['current-session']['orphan-answer'] = {
    answer: { choice: 'ok', note: '', sentAt: new Date(now - 1).toISOString() },
    state: null,
    awaitingAnswerUntil: null,
    updatedAt: new Date(now - 1).toISOString(),
  };
  await fs.writeFile(storePath, JSON.stringify(persisted));

  const restored = await DashboardState.load(homeDir, { now });
  assert.equal(restored.plans.has('expired-session'), true);
  assert.equal(restored.hiddenSessions.has('expired-session'), true);
  assert.equal(restored.closedTasks.has('expired-session'), true);
  assert.deepEqual([...restored.decisionLifecycles.get('current-session').keys()], [currentDecision.id]);
  assert.equal(restored.decisionFor('current-session', currentDecision.id).awaitingAnswerUntil, undefined);

  restored.syncSessionFiles([], now);
  assert.equal(restored.plans.has('expired-session'), false);
  assert.equal(restored.hiddenSessions.has('expired-session'), false);
  assert.equal(restored.closedTasks.has('expired-session'), false);
});

test('復元後の最初のセッションファイル同期でフックにもファイルにも無い外し記録を捨てる', async (t) => {
  const homeDir = await temporaryHome(t);
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  const state = new DashboardState({ homeDir });
  state.syncSessionFiles([
    { session_id: 'hidden-without-task', cwd: 'C:\\project', name: '掃除対象' },
    { session_id: 'hidden-with-task', cwd: 'C:\\project', name: 'タスクあり' },
  ], now);
  state.setTasks('hidden-with-task', [task('残すタスク')], now);
  state.hideSession('hidden-without-task', now);
  state.hideSession('hidden-with-task', now);
  await state.flushPersistence();

  const restored = await DashboardState.load(homeDir, { now: now + 1 });
  restored.syncSessionFiles([] , now + 1);

  assert.equal(restored.hiddenSessions.has('hidden-without-task'), false);
  assert.equal(restored.hiddenSessions.has('hidden-with-task'), false);
});

test('一覧から外しただけで記録の無いセッションは prune 後も外れたままにする', () => {
  const state = new DashboardState();
  const sessionId = 'hidden-only';
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  state.addEvent({ session_id: sessionId, hook_event_name: 'SessionStart', hookAt: now });
  state.hideSession(sessionId, now);

  state.pruneExpiredStoreRecords(now + 15 * DAY_MS);

  assert.equal(state.hiddenSessions.has(sessionId), true);
  assert.equal(state.hiddenSessionUpdatedAt.get(sessionId), new Date(now).toISOString());
  assert.equal(state.snapshot().sessions.find((session) => session.session_id === sessionId).hidden, true);
});

test('外した時刻が新しくても期限切れの plan は生存していないセッションから削除する', () => {
  const state = new DashboardState();
  const sessionId = 'hidden-expired-plan';
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  state.addEvent({ session_id: sessionId, hook_event_name: 'SessionStart', hookAt: now - 15 * DAY_MS });
  state.setTasks(sessionId, [task('古いタスク')], now - 15 * DAY_MS);
  state.hideSession(sessionId, now);
  state.sessions.delete(sessionId);

  state.pruneExpiredStoreRecords(now);

  assert.equal(state.plans.has(sessionId), false);
  assert.equal(state.hiddenSessions.has(sessionId), true);
});

test('hook session が生きていれば古い plan を保持する', () => {
  const state = new DashboardState();
  const sessionId = 'live-hook-session';
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  state.sessions.set(sessionId, { session_id: sessionId });
  state.setTasks(sessionId, [task('古いタスク')], now - 20 * DAY_MS);

  state.pruneExpiredStoreRecords(now);

  assert.equal(state.plans.has(sessionId), true);
});

test('session file にある生存中のセッションは古い plan を保持する', () => {
  const state = new DashboardState();
  const sessionId = 'live-file-session';
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  state.syncSessionFiles([{ session_id: sessionId, cwd: 'C:\\project', name: '稼働中' }], now);
  state.setTasks(sessionId, [task('古いタスク')], now - 20 * DAY_MS);

  state.pruneExpiredStoreRecords(now);

  assert.equal(state.plans.has(sessionId), true);
});

test('最初の同期ではファイルの無い期限切れ記録だけを削除する', async (t) => {
  const homeDir = await temporaryHome(t);
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  const old = now - 20 * DAY_MS;
  const state = new DashboardState({ homeDir });
  state.setTasks('expired-without-file', [task('期限切れ')], old);
  state.setTasks('expired-with-file', [task('ファイルあり')], old);
  state.setTasks('recent-without-file', [task('新しい記録')], now - DAY_MS);
  await state.flushPersistence();

  const restored = await DashboardState.load(homeDir, { now });
  assert.equal(restored.plans.has('expired-without-file'), true);
  assert.equal(restored.plans.has('expired-with-file'), true);
  assert.equal(restored.plans.has('recent-without-file'), true);

  restored.syncSessionFiles([{ session_id: 'expired-with-file', cwd: 'C:\\project', name: 'ファイルあり' }], now);

  assert.equal(restored.plans.has('expired-without-file'), false);
  assert.equal(restored.plans.has('expired-with-file'), true);
  assert.equal(restored.plans.has('recent-without-file'), true);
});

test('セッションファイルの同期が来ないまま猶予を過ぎると、フックで届いたセッション以外の期限切れ記録を捨てる', async (t) => {
  const homeDir = await temporaryHome(t);
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  const state = new DashboardState({ homeDir });
  state.setTasks('expired-session', [task('期限切れ')], now - 20 * DAY_MS);
  state.setTasks('live-hook-session', [task('稼働中')], now - 20 * DAY_MS);
  await state.flushPersistence();

  const restored = await DashboardState.load(homeDir, { now });
  restored.sessions.set('live-hook-session', { session_id: 'live-hook-session' });
  restored.pruneExpiredStoreRecords(now + 5 * 60_000);
  assert.equal(restored.plans.has('expired-session'), true);

  restored.pruneExpiredStoreRecords(now + 11 * 60_000);
  assert.equal(restored.plans.has('expired-session'), false);
  assert.equal(restored.plans.has('live-hook-session'), true);
});

test('閉じた時刻と PR のマージ時刻をセッション保持期限の起点にする', () => {
  const state = new DashboardState();
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  const old = now - 20 * DAY_MS;
  const recentlyClosed = now - DAY_MS;
  const recentlyMerged = now - 2 * DAY_MS;
  const product = { key: 'C:\\project', name: 'project' };
  const owner = 'example';
  const repo = 'project';
  const sessionIdForClosedTask = 'recently-closed-task';
  const sessionIdForMergedPr = 'recently-merged-pr';
  state.setTasks(sessionIdForClosedTask, [task('閉じたタスク')], old);
  state.closeTask(sessionIdForClosedTask, '閉じたタスク', recentlyClosed);
  state.setTasks(sessionIdForMergedPr, [task('古いタスク')], old);
  state.registerPullRequest(sessionIdForMergedPr, {
    url: `https://github.com/${owner}/${repo}/pull/101`,
  }, { product }, old);
  state.updatePullRequest(sessionIdForMergedPr, owner, repo, 101, {
    state: 'merged', mergedAt: new Date(recentlyMerged).toISOString(),
  }, recentlyMerged);

  state.pruneExpiredStoreRecords(now);

  assert.equal(state.plans.has(sessionIdForClosedTask), true);
  assert.equal(state.closedTasks.get(sessionIdForClosedTask)?.has('閉じたタスク'), true);
  assert.equal(state.plans.has(sessionIdForMergedPr), true);
  assert.equal(state.pullRequests.get(sessionIdForMergedPr)?.size, 1);
});

test('実行中の prune でセッション記録を削除すると version を進める', () => {
  const state = new DashboardState();
  const sessionId = 'expired-prune-version';
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  state.setTasks(sessionId, [task('古いタスク')], now - 15 * DAY_MS);
  const previousVersion = state.version;

  state.pruneExpiredStoreRecords(now);

  assert.equal(state.plans.has(sessionId), false);
  assert.ok(state.version > previousVersion);
});

test('通常の保存は500msでまとめ、回答記録の変更は待たずに書く', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const homeDir = await temporaryHome(t);
  let writes = 0;
  const fileSystem = {
    writeFile: fs.writeFile.bind(fs),
    rm: fs.rm.bind(fs),
    rename: async (...args) => {
      writes += 1;
      return fs.rename(...args);
    },
  };
  const writer = new AtomicJsonWriter(homeDir, { fileSystem });
  const state = new DashboardState();
  state.attachWriter(writer);
  state.setTasks('debounced', [task('最初の一覧')]);
  state.setTasks('debounced', [task('まとめた一覧')]);
  t.mock.timers.tick(499);
  assert.equal(writes, 0);
  t.mock.timers.tick(1);
  t.mock.timers.reset();
  await state.waitForPersistence();
  assert.equal(writes, 1);

  const decision = state.addDecision('debounced', decisionInput('回答を記録する'));
  state.setDecisionLifecycle('debounced', decision.id, {
    answer: { choice: 'ok', note: '続行する', sentAt: new Date().toISOString() },
  });
  await state.waitForPersistence();
  assert.equal(writes, 2);
});

test('壊れた store と新しい version の store を退避して空で始める', async (t) => {
  for (const [name, contents] of [
    ['broken-json', '{'],
    ['newer-version', JSON.stringify({ version: 2 })],
  ]) {
    const homeDir = await temporaryHome(t);
    await fs.writeFile(path.join(homeDir, 'store.json'), contents);
    const restored = await DashboardState.load(homeDir, { now: Date.parse('2026-10-03T00:00:00.000Z') });
    assert.equal(restored.plans.size, 0, name);
    assert.equal(restored.display, null, name);
    assert.ok((await fs.readdir(homeDir)).some((file) => file.startsWith('store.json.broken-')), name);
  }
});

test('rename を再試行し、最終失敗でもメモリーを保って次の変更で書き直す', async (t) => {
  const homeDir = await temporaryHome(t);
  let failuresRemaining = 4;
  let attempts = 0;
  let loggedFailures = 0;
  const delays = [];
  const fileSystem = {
    writeFile: fs.writeFile.bind(fs),
    rm: fs.rm.bind(fs),
    rename: async (...args) => {
      attempts += 1;
      if (failuresRemaining > 0) {
        failuresRemaining -= 1;
        throw Object.assign(new Error('busy'), { code: 'EBUSY' });
      }
      return fs.rename(...args);
    },
  };
  const writer = new AtomicJsonWriter(homeDir, {
    fileSystem,
    retryDelaysMs: [50, 100, 200],
    delay: async (milliseconds) => { delays.push(milliseconds); },
    onFailure: () => { loggedFailures += 1; },
  });
  const state = new DashboardState();
  state.attachWriter(writer);
  state.setTasks('write-retry', [task('メモリーに残す')]);
  await state.flushPersistence();

  assert.deepEqual(delays, [50, 100, 200]);
  assert.equal(attempts, 4);
  assert.equal(loggedFailures, 1);
  assert.deepEqual(state.plans.get('write-retry').tasks.map(({ title }) => title), ['メモリーに残す']);
  await assert.rejects(fs.readFile(path.join(homeDir, 'store.json'), 'utf8'), { code: 'ENOENT' });

  failuresRemaining = 0;
  state.setTasks('write-retry', [task('次の変更で保存')]);
  await state.flushPersistence();
  const saved = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
  assert.equal(saved.plans['write-retry'].tasks[0].title, '次の変更で保存');
  assert.equal(loggedFailures, 1);
});

test('回答記録の即時保存が失敗してもメモリーの記録を保持する', async (t) => {
  const homeDir = await temporaryHome(t);
  let loggedFailures = 0;
  const fileSystem = {
    writeFile: fs.writeFile.bind(fs),
    rm: fs.rm.bind(fs),
    rename: async () => { throw Object.assign(new Error('busy'), { code: 'EBUSY' }); },
  };
  const writer = new AtomicJsonWriter(homeDir, {
    fileSystem,
    retryDelaysMs: [0, 0, 0],
    delay: async () => {},
    onFailure: () => { loggedFailures += 1; },
  });
  const state = new DashboardState();
  state.attachWriter(writer);
  const decision = state.addDecision('answer-write-failure', decisionInput('回答を保つ'));

  state.setDecisionLifecycle('answer-write-failure', decision.id, {
    answer: { choice: 'ok', note: '続行する', sentAt: new Date().toISOString() },
  });
  await state.waitForPersistence();

  assert.equal(state.decisionFor('answer-write-failure', decision.id).answer.note, '続行する');
  assert.equal(loggedFailures, 1);
});

test('away.json も共通の rename 再試行を使い、メモリーの切り替えを保つ', async (t) => {
  const homeDir = await temporaryHome(t);
  let attempts = 0;
  const fileSystem = {
    writeFile: fs.writeFile.bind(fs),
    rm: fs.rm.bind(fs),
    rename: async (...args) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('busy'), { code: 'EPERM' });
      return fs.rename(...args);
    },
  };
  const writer = new AtomicJsonWriter(homeDir, {
    fileSystem,
    retryDelaysMs: [0, 0, 0],
    delay: async () => {},
  });
  const away = new AwayState(homeDir, { enabled: false, since: null }, fileSystem, writer);

  assert.deepEqual(await away.setEnabled(true, 123), {
    enabled: true, since: 123, periods: [{ start: 123, end: null }],
  });
  assert.equal(attempts, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(homeDir, 'away.json'), 'utf8')), {
    enabled: true, since: 123, periods: [{ start: 123, end: null }],
  });
});

test('旧形式の離席状態は enabled に応じた期間へ読み替える', async (t) => {
  const homeDir = await temporaryHome(t);
  const filePath = path.join(homeDir, 'away.json');
  await fs.writeFile(filePath, JSON.stringify({ enabled: true, since: 123 }));

  assert.deepEqual((await AwayState.load(homeDir)).snapshot(), {
    enabled: true, since: 123, periods: [{ start: 123, end: null }],
  });

  await fs.writeFile(filePath, JSON.stringify({ enabled: false, since: null }));
  assert.deepEqual((await AwayState.load(homeDir)).snapshot(), { enabled: false, since: null, periods: [] });
});

test('away.json の離席期間を保存して読み戻す', async (t) => {
  const homeDir = await temporaryHome(t);
  const away = await AwayState.load(homeDir);
  const now = Date.now();
  await away.setEnabled(true, now - 4000);
  await away.setEnabled(false, now - 3000);
  await away.setEnabled(true, now - 2000);
  await away.setEnabled(false, now - 1000);

  const saved = JSON.parse(await fs.readFile(path.join(homeDir, 'away.json'), 'utf8'));
  assert.deepEqual(saved.periods, [
    { start: now - 4000, end: now - 3000 },
    { start: now - 2000, end: now - 1000 },
  ]);
  assert.deepEqual((await AwayState.load(homeDir)).snapshot(), saved);
});

test('離席期間は既読時刻と保持期限で整理し、50件までにする', async (t) => {
  const homeDir = await temporaryHome(t);
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const away = new AwayState(homeDir, {
    enabled: false,
    since: null,
    periods: [
      { start: now - 16 * DAY_MS, end: now - 15 * DAY_MS },
      { start: now - 2 * DAY_MS, end: now - DAY_MS },
      { start: now - DAY_MS, end: now - 6 * 60 * 60 * 1000 },
    ],
  });

  await away.prune([new Date(now - DAY_MS).toISOString()], now);
  assert.deepEqual(away.snapshot().periods, [
    { start: now - DAY_MS, end: now - 6 * 60 * 60 * 1000 },
  ]);

  const overLimit = new AwayState(homeDir, {
    enabled: false,
    since: null,
    periods: Array.from({ length: 51 }, (_, index) => ({ start: index * 2, end: index * 2 + 1 })),
  });
  assert.equal(overLimit.snapshot().periods.length, 50);
});

test('タスクを書き直すと題が消えた記録と state が変わった完了記録を消す', async (t) => {
  const state = new DashboardState();
  state.setTasks('closed-session', [task('同じ題', 'todo'), task('削除される題', 'todo')]);
  state.closeTask('closed-session', '同じ題');
  state.closeTask('closed-session', '削除される題');

  state.setTasks('closed-session', [task('同じ題', 'doing')]);
  assert.equal(state.closedTasks.has('closed-session'), false);
  assert.equal(state.snapshot().sessions.length, 0);
});

test('終了にしたエージェントは組み立て直しで稼働中になったら記録を消す', () => {
  const state = new DashboardState();
  const sessionId = 'agent-close';
  state.addEvent({ session_id: sessionId, hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'agent-1', agent_type: 'impl-hard' });
  state.addEvent({
    session_id: sessionId, hook_event_name: 'PreToolUse', hookAt: 2, agent_id: 'agent-1',
    tool_name: 'Bash', tool_use_id: 'bash-1', summary: 'bash ~/.claude/tools/codex-agent.sh impl-hard < prompt.md',
  });
  state.addEvent({ session_id: sessionId, hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'agent-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
  state.addEvent({ session_id: sessionId, hook_event_name: 'SubagentStop', hookAt: 4, agent_id: 'agent-1' });
  assert.equal(state.snapshot().sessions[0].agents[0].unconfirmed, true);
  assert.equal(state.closeAgent(sessionId, 'agent-1'), true);
  assert.equal(state.snapshot().sessions[0].agents[0].unconfirmed, false);

  state.addEvent({ session_id: sessionId, hook_event_name: 'SubagentStart', hookAt: 5, agent_id: 'agent-1', agent_type: 'impl-hard' });

  assert.equal(state.closedAgents.has(sessionId), false);
  assert.equal(state.snapshot().sessions[0].agents[0].active, true);
});

test('終了にしたエージェントは結果が確認された再構築でも記録を消す', () => {
  const state = new DashboardState();
  const sessionId = 'agent-confirmed';
  state.addEvent({ session_id: sessionId, hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'agent-1', agent_type: 'impl-hard' });
  state.addEvent({
    session_id: sessionId, hook_event_name: 'PreToolUse', hookAt: 2, agent_id: 'agent-1',
    tool_name: 'Bash', tool_use_id: 'bash-1', summary: 'bash ~/.claude/tools/codex-agent.sh impl-hard < prompt.md',
  });
  state.addEvent({ session_id: sessionId, hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'agent-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
  state.addEvent({ session_id: sessionId, hook_event_name: 'SubagentStop', hookAt: 4, agent_id: 'agent-1' });
  assert.equal(state.closeAgent(sessionId, 'agent-1'), true);

  state.addEvent({
    session_id: sessionId, hook_event_name: 'PostToolUse', hookAt: 5, agent_id: 'agent-1',
    tool_name: 'Read', tool_use_id: 'read-1',
    codexOutput: { auditLine: 'codex-agent: agent=impl-hard model=gpt-6-luna effort=high sandbox=read-only', resultLine: 'codex-agent: result=ok' },
  });

  assert.equal(state.closedAgents.has(sessionId), false);
  assert.notEqual(state.snapshot().sessions[0].agents[0].unconfirmed, true);
});

test('保存したタスクがあってもイベントとセッションファイルが無い間は一覧へ出さない', () => {
  const state = new DashboardState();
  state.setTasks('plan-only', [task('待機中')]);
  assert.deepEqual(state.snapshot().sessions, []);
});

test('保存済みの旧回答は provisional として復元し、廃止済みの非表示キーは無視する', async (t) => {
  const homeDir = await temporaryHome(t);
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const state = new DashboardState({ homeDir });
  const decision = state.addDecision('legacy-answer', decisionInput('推奨で仮に進める'), now);
  state.setDecisionLifecycle('legacy-answer', decision.id, {
    answer: { choice: 'hold', note: '後で確認する', sentAt: new Date(now).toISOString() },
    state: 'waiting',
    awaitingAnswerUntil: new Date(now + 60_000).toISOString(),
  }, now);
  await state.flushPersistence();
  const storePath = path.join(homeDir, 'store.json');
  const savedStore = JSON.parse(await fs.readFile(storePath, 'utf8'));
  savedStore.display = {
    mode: 'product', order: [], pinned: [], collapsed: [], hidden: ['held'],
    sectionOrder: ['sinceSeen', 'judgment', 'tasks', 'now', 'prs'],
    longWaitMinutes: 15, awayAnswerWaitMinutes: 5, hideFinished: true,
  };
  await fs.writeFile(storePath, JSON.stringify(savedStore));

  const restored = await DashboardState.load(homeDir, { now: now + 1 });
  const restoredDecision = restored.decisionFor('legacy-answer', decision.id);

  assert.equal(restoredDecision.state, 'provisional');
  assert.equal(restoredDecision.answer, null);
  assert.deepEqual(restored.display.hidden, []);
  assert.equal((await fs.readdir(homeDir)).some((name) => name.startsWith('store.json.broken-')), false);
});

test('締切を外して読み戻した回答記録を保存し直しても、次の読み込みで全体が残る', async (t) => {
  const homeDir = await temporaryHome(t);
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  const state = new DashboardState({ homeDir });
  state.setTasks('round-trip', [task('残るタスク')], now);
  const decision = state.addDecision('round-trip', decisionInput('残る判断'), now);
  state.setDecisionLifecycle('round-trip', decision.id, {
    answer: { choice: 'ok', note: '', sentAt: new Date(now).toISOString(), deliveredAt: null, reflectedAt: null, promptDeliveries: 0 },
    state: 'waiting',
    awaitingAnswerUntil: new Date(now + 60_000).toISOString(),
  }, now);
  await state.flushPersistence();

  const second = await DashboardState.load(homeDir, { now: now + 1 });
  second.setTasks('round-trip', [task('残るタスク'), task('足したタスク')], now + 2);
  await second.flushPersistence();
  const third = await DashboardState.load(homeDir, { now: now + 3 });

  assert.deepEqual(third.plans.get('round-trip').tasks.map((item) => item.title), ['残るタスク', '足したタスク']);
  assert.equal(third.decisionLifecycles.get('round-trip').get(decision.id).answer.choice, 'ok');
  const files = await fs.readdir(homeDir);
  assert.equal(files.some((name) => name.startsWith('store.json.broken-')), false);
});

test('既読項目のない旧 store を退避せず読み、既読時刻を保存して読み戻す', async (t) => {
  const homeDir = await temporaryHome(t);
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  await fs.writeFile(path.join(homeDir, 'store.json'), JSON.stringify({
    version: 1,
    display: null,
    plans: {},
    decisionLifecycles: {},
    closedTasks: [],
    hiddenSessions: [],
  }));

  const state = await DashboardState.load(homeDir, { now });
  assert.equal(state.seenAtByProduct.size, 0);
  assert.deepEqual(state.ciFailures, []);
  state.setProductSeen('C:\\project', now + 1);
  await state.flushPersistence();

  const restored = await DashboardState.load(homeDir, { now: now + 2 });
  assert.equal(restored.seenAtByProduct.get('C:\\project'), new Date(now + 1).toISOString());
  assert.equal((await fs.readdir(homeDir)).some((name) => name.startsWith('store.json.broken-')), false);
});

test('初回表示は既存の完了を既読扱いにし、その後の完了だけを新着にする', () => {
  const state = new DashboardState();
  const sessionId = 'first-seen';
  const product = { key: 'C:\\project', name: 'project' };
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  state.syncSessionFiles([{ session_id: sessionId, cwd: 'C:\\project', name: '最初の表示', product }], now);
  state.setTasks(sessionId, [task('既存の完了', 'done')], now);

  state.syncSessionFiles([], now + 500);
  const hidden = state.snapshotSinceSeen([], [], now + 500);
  assert.deepEqual(hidden.sinceSeen, []);
  assert.equal(state.seenAtByProduct.has(product.key), false);

  state.syncSessionFiles([{ session_id: sessionId, cwd: 'C:\\project', name: '最初の表示', product }], now + 750);
  const first = state.snapshotSinceSeen(state.snapshot().sessions, [], now + 1000);
  assert.deepEqual(first.sinceSeen, []);
  assert.equal(first.seenAtByProduct[product.key], new Date(now + 1000).toISOString());

  state.setTasks(sessionId, [task('既存の完了', 'done'), task('新しい完了', 'done')], now + 2000);
  const next = state.snapshotSinceSeen(state.snapshot().sessions, [], now + 3000, [
    { start: now + 1500, end: now + 3000 },
  ]);
  assert.deepEqual(next.sinceSeen[0].items.map((item) => item.text), ['タスク「新しい完了」が完了した']);
});

test('席にいる間の変化は出さず、離席中の変化は離席後も既読まで表示する', () => {
  const state = new DashboardState();
  const sessionId = 'away-period-retained';
  const product = { key: 'C:\\project', name: 'project' };
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  state.syncSessionFiles([{ session_id: sessionId, cwd: product.key, name: '離席期間', product }], now);
  state.setTasks(sessionId, [task('既存の完了', 'done')], now);
  state.snapshotSinceSeen(state.snapshot().sessions, [], now + 1);

  state.setTasks(sessionId, [task('既存の完了', 'done'), task('席にいる間', 'done')], now + 2);
  const whilePresent = state.snapshotSinceSeen(state.snapshot().sessions, [], now + 3);
  assert.deepEqual(whilePresent.sinceSeen, []);

  state.setTasks(sessionId, [
    task('既存の完了', 'done'), task('席にいる間', 'done'), task('離席中', 'done'),
  ], now + 12);
  const periods = [{ start: now + 10, end: now + 20 }];
  const afterAway = state.snapshotSinceSeen(state.snapshot().sessions, [], now + 30, periods);
  assert.deepEqual(afterAway.sinceSeen[0].items.map((item) => item.text), ['タスク「離席中」が完了した']);
  assert.deepEqual(state.snapshotSinceSeen(state.snapshot().sessions, [], now + 31, periods).sinceSeen, afterAway.sinceSeen);

  state.setProductSeen(product.key, now + 32);
  assert.deepEqual(state.snapshotSinceSeen(state.snapshot().sessions, [], now + 33, periods).sinceSeen, []);
});

test('離席を二度挟んだときは両方の期間の変化だけを出す', () => {
  const state = new DashboardState();
  const sessionId = 'multiple-away-periods';
  const product = { key: 'C:\\project', name: 'project' };
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  state.syncSessionFiles([{ session_id: sessionId, cwd: product.key, name: '離席期間', product }], now);
  state.snapshotSinceSeen(state.snapshot().sessions, [], now);

  state.setTasks(sessionId, [task('席にいる間', 'done')], now + 1);
  state.setTasks(sessionId, [task('席にいる間', 'done'), task('一度目の離席', 'done')], now + 3);
  state.setTasks(sessionId, [
    task('席にいる間', 'done'), task('一度目の離席', 'done'), task('二度目の離席', 'done'),
  ], now + 9);

  const result = state.snapshotSinceSeen(state.snapshot().sessions, [], now + 12, [
    { start: now + 2, end: now + 5 },
    { start: now + 8, end: now + 10 },
  ]);
  assert.deepEqual(result.sinceSeen[0].items.map((item) => item.text), [
    'タスク「二度目の離席」が完了した',
    'タスク「一度目の離席」が完了した',
  ]);
});

test('既読時刻は後退せず、既読後に同じ仮適用を更新しても新着に戻らない', () => {
  const state = new DashboardState();
  const sessionId = 'seen-provisional';
  const product = { key: 'C:\\project', name: 'project' };
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  state.syncSessionFiles([{ session_id: sessionId, cwd: product.key, name: '仮適用', product }], now);
  const decision = state.addDecision(sessionId, { ...decisionInput('仮適用の判断'), state: 'provisional' }, now);

  const seenAt = state.setProductSeen(product.key, now + 10);
  assert.equal(state.setProductSeen(product.key, now + 5), seenAt);
  const updated = state.updateDecision(sessionId, decision.id, 'provisional', '案 B', '選択内容だけを変更', now + 20);

  assert.equal(updated.provisionalAt, decision.provisionalAt);
  const result = state.snapshotSinceSeen(state.snapshot().sessions, [], now + 30);
  assert.deepEqual(result.sinceSeen, []);
});

test('既読時刻より前後の完了、PR、仮適用、CI 失敗、マージを分けて新しい順に並べる', () => {
  const state = new DashboardState();
  const sessionId = 'since-seen-events';
  const product = { key: 'C:\\project', name: 'project' };
  const owner = 'example';
  const repo = 'project';
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const url = (number) => `https://github.com/${owner}/${repo}/pull/${number}`;
  const lastOpen = (title, ci) => ({ title, url: url(title === 'PR before' ? 1 : 2), headRefName: `feature/${title}`, baseRefName: 'main', headRefOid: 'a'.repeat(40), ci });
  state.syncSessionFiles([{ session_id: sessionId, cwd: 'C:\\project', name: '変化一覧', product }], now);
  state.setTasks(sessionId, [task('以前の完了', 'done'), task('以前に画面で完了', 'doing')], now);
  state.closeTask(sessionId, '以前に画面で完了', now + 1);
  const oldDecision = state.addDecision(sessionId, decisionInput('以前の仮適用'), now + 2);
  state.updateDecision(sessionId, oldDecision.id, 'provisional', '案 A', '', now + 3);
  state.registerPullRequest(sessionId, { url: url(1) }, { product }, now + 4);
  state.updatePullRequest(sessionId, owner, repo, 1, { lastOpen: lastOpen('PR before', 'pass') }, now + 5);
  state.updatePullRequest(sessionId, owner, repo, 1, { lastOpen: lastOpen('PR before', 'fail') }, now + 6);
  state.setProductSeen(product.key, now + 7);

  state.setTasks(sessionId, [
    task('以前の完了', 'done'),
    task('以前に画面で完了', 'doing'),
    task('以後の完了', 'done'),
    task('以後に画面で完了', 'doing'),
  ], now + 8);
  state.closeTask(sessionId, '以後に画面で完了', now + 9);
  state.addDecision(sessionId, { ...decisionInput('以後の仮適用'), state: 'provisional' }, now + 10);
  state.registerPullRequest(sessionId, { url: url(2) }, { product }, now + 11);
  state.updatePullRequest(sessionId, owner, repo, 2, { lastOpen: lastOpen('PR after', 'pending') }, now + 12);
  state.updatePullRequest(sessionId, owner, repo, 2, { lastOpen: lastOpen('PR after', 'fail') }, now + 13);
  state.updatePullRequest(sessionId, owner, repo, 1, { lastOpen: lastOpen('PR before', 'pass') }, now + 14);
  state.updatePullRequest(sessionId, owner, repo, 1, { lastOpen: lastOpen('PR before', 'fail') }, now + 15);
  state.recordMergedPullRequest({
    owner, repo, number: 1, title: 'PR before', url: url(1), mergedAt: new Date(now + 16).toISOString(), method: 'squash',
  }, now + 16);

  const result = state.snapshotSinceSeen(state.snapshot().sessions, [], now + 20, [{ start: 0, end: now + 20 }]);
  const items = result.sinceSeen[0].items;
  assert.deepEqual(new Set(items.map((item) => item.type)), new Set([
    'task', 'provisional', 'pull-request-summary',
  ]));
  assert.equal(items.length, 5);
  assert.deepEqual(items.map((item) => item.at), [...items.map((item) => item.at)].sort((left, right) => Date.parse(right) - Date.parse(left)));
  assert.deepEqual(state.ciFailures.map((record) => record.at), [
    new Date(now + 6).toISOString(), new Date(now + 13).toISOString(), new Date(now + 15).toISOString(),
  ]);
  assert.ok(items.some((item) => item.text === 'PR #1(PR before)の CI が失敗した。マージした'));
  assert.ok(items.some((item) => item.text === 'PR #2(PR after)の CI が失敗した。作成した'));
  assert.ok(items.some((item) => item.text === '判断「以後の仮適用」を推奨案で仮に進めた'));
  assert.ok(items.some((item) => item.text === 'タスク「以後の完了」が完了した'));
  assert.ok(items.some((item) => item.text === 'タスク「以後に画面で完了」が完了した'));
  assert.deepEqual(items.filter((item) => item.type === 'pull-request-summary').map((item) => item.at), [
    new Date(now + 16).toISOString(), new Date(now + 13).toISOString(),
  ]);
  assert.equal(items.some((item) => item.at === new Date(now + 6).toISOString()), false);
  assert.equal(items.some((item) => item.text.includes('以前')), false);
  assert.equal(items.some((item) => item.text.includes('PR #1(PR before)を作成した')), false);
});

test('作成とマージを1件にまとめ、まとめた時刻で並べる', () => {
  const state = new DashboardState();
  const sessionId = 'since-seen-pr-summary-order';
  const product = { key: 'C:\\project', name: 'project' };
  const owner = 'example';
  const repo = 'project';
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const url = (number) => `https://github.com/${owner}/${repo}/pull/${number}`;
  const mixedCaseUrl = (number) => `https://github.com/Example/Project/pull/${number}`;
  const lastOpen = (title, number) => ({
    title, url: number === 20 ? mixedCaseUrl(number) : url(number),
    headRefName: `feature/${number}`, baseRefName: 'main', headRefOid: 'a'.repeat(40), ci: 'pass',
  });
  state.registerPullRequest(sessionId, { url: mixedCaseUrl(20) }, { product }, now + 3);
  state.updatePullRequest(sessionId, owner, repo, 20, { lastOpen: lastOpen('作成とマージ', 20) }, now + 4);
  state.registerPullRequest(sessionId, { url: url(21) }, { product }, now + 5);
  state.updatePullRequest(sessionId, owner, repo, 21, { lastOpen: lastOpen('作成のみ', 21) }, now + 6);
  state.setProductSeen(product.key, now + 2);
  state.recordMergedPullRequest({
    owner, repo, number: 20, url: url(20), mergedAt: new Date(now + 10).toISOString(), method: 'squash',
  }, now + 10);

  const result = state.snapshotSinceSeen([], [], now + 12, [{ start: 0, end: now + 12 }]);
  const items = result.sinceSeen[0].items;

  assert.equal(items.length, 2);
  assert.deepEqual(items.map((item) => item.text), [
    'PR #20(作成とマージ)を作成し、マージした',
    'PR #21(作成のみ)を作成した',
  ]);
  assert.deepEqual(items.map((item) => item.at), [new Date(now + 10).toISOString(), new Date(now + 5).toISOString()]);
});

test('CI失敗を含むPRの変化を失敗、作成、マージの順でまとめる', () => {
  const state = new DashboardState();
  const sessionId = 'since-seen-ci-pr-summaries';
  const product = { key: 'C:\\project', name: 'project' };
  const owner = 'example';
  const repo = 'project';
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const url = (number) => `https://github.com/${owner}/${repo}/pull/${number}`;
  const lastOpen = (number, title, ci) => ({
    title, url: url(number), headRefName: `feature/${number}`, baseRefName: 'main', headRefOid: 'a'.repeat(40), ci,
  });
  for (const [number, title] of [[30, '失敗のみ']]) {
    state.registerPullRequest(sessionId, { url: url(number) }, { product }, now - 2);
    state.updatePullRequest(sessionId, owner, repo, number, { lastOpen: lastOpen(number, title, 'pending') }, now - 1);
  }
  state.setProductSeen(product.key, now);
  state.updatePullRequest(sessionId, owner, repo, 30, { lastOpen: lastOpen(30, '失敗のみ', 'fail') }, now + 1);
  state.registerPullRequest(sessionId, { url: url(31) }, { product }, now + 2);
  state.updatePullRequest(sessionId, owner, repo, 31, { lastOpen: lastOpen(31, '作成と失敗', 'pending') }, now + 3);
  state.updatePullRequest(sessionId, owner, repo, 31, { lastOpen: lastOpen(31, '作成と失敗', 'fail') }, now + 4);
  state.registerPullRequest(sessionId, { url: url(32) }, { product }, now + 2);
  state.updatePullRequest(sessionId, owner, repo, 32, { lastOpen: lastOpen(32, '作成、失敗、マージ', 'pending') }, now + 3);
  state.updatePullRequest(sessionId, owner, repo, 32, { lastOpen: lastOpen(32, '作成、失敗、マージ', 'fail') }, now + 5);
  state.recordMergedPullRequest({
    owner, repo, number: 32, title: '作成、失敗、マージ', url: url(32), mergedAt: new Date(now + 6).toISOString(), method: 'squash',
  }, now + 6);
  state.ciFailures.push({ owner, repo, number: 33, product, at: new Date(now + 7).toISOString() });

  const result = state.snapshotSinceSeen([], [], now + 8, [{ start: 0, end: now + 8 }]);

  assert.deepEqual(result.sinceSeen[0].items.map((item) => item.text), [
    'PR #33 の CI が失敗した',
    'PR #32(作成、失敗、マージ)の CI が失敗した。作成し、マージした',
    'PR #31(作成と失敗)の CI が失敗した。作成した',
    'PR #30(失敗のみ)の CI が失敗した',
  ]);
  assert.equal(result.sinceSeen[0].items.length, 4);
});

test('既読前の作成を除外して、既読後のマージだけを表示する', () => {
  const state = new DashboardState();
  const sessionId = 'since-seen-merge-only';
  const product = { key: 'C:\\project', name: 'project' };
  const owner = 'example';
  const repo = 'project';
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const url = 'https://github.com/example/project/pull/40';
  state.registerPullRequest(sessionId, { url }, { product }, now - 2);
  state.updatePullRequest(sessionId, owner, repo, 40, {
    lastOpen: { title: '既読前の作成', url, headRefName: 'feature', baseRefName: 'main', headRefOid: 'a'.repeat(40), ci: 'pass' },
  }, now - 1);
  state.setProductSeen(product.key, now);
  state.recordMergedPullRequest({
    owner, repo, number: 40, title: '既読前の作成', url, mergedAt: new Date(now + 1).toISOString(), method: 'squash',
  }, now + 1);

  const result = state.snapshotSinceSeen([], [], now + 2, [{ start: 0, end: now + 2 }]);

  assert.equal(result.sinceSeen[0].items.length, 1);
  assert.equal(result.sinceSeen[0].items[0].text, 'PR #40(既読前の作成)をマージした');
});

test('マージ履歴がなくても登録のマージ時刻を前回見てからに表示する', () => {
  const state = new DashboardState();
  const product = { key: 'C:\\project', name: 'project' };
  const owner = 'example';
  const repo = 'project';
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const mergedAt = new Date(now - 2 * DAY_MS).toISOString();
  const seenAt = new Date(now - 3 * DAY_MS).toISOString();
  state.registerPullRequest('merged-registration', {
    url: `https://github.com/${owner}/${repo}/pull/10`,
  }, { product }, Date.parse(mergedAt));
  state.updatePullRequest('merged-registration', owner, repo, 10, { state: 'merged', mergedAt });
  state.setProductSeen(product.key, seenAt);

  const result = state.snapshotSinceSeen([], [], now, [{ start: 0, end: now }]);

  assert.equal(state.mergedPullRequests.size, 0);
  assert.ok(result.sinceSeen[0].items.some((item) => (
    item.type === 'pull-request-summary' && item.text === 'PR #10を作成し、マージした'
  )));
});

test('セッション登録とマージ履歴の時刻書式が異なってもマージ項目は1件にする', () => {
  const state = new DashboardState();
  const product = { key: 'C:\\project', name: 'project' };
  const owner = 'example';
  const repo = 'project';
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const mergedAt = '2026-10-03T11:00:00Z';
  state.registerPullRequest('duplicate-merge', {
    url: `https://github.com/${owner}/${repo}/pull/11`,
  }, { product }, now - 2 * 60 * 60_000);
  state.recordMergedPullRequest({
    owner, repo, number: 11, title: '同じPR', url: `https://github.com/${owner}/${repo}/pull/11`, mergedAt,
  }, now);
  state.updatePullRequest('duplicate-merge', owner, repo, 11, {
    state: 'merged', mergedAt: '2026-10-03T11:00:00.000Z',
  });
  state.setProductSeen(product.key, now - 2 * 60 * 60_000);

  const result = state.snapshotSinceSeen([], [], now, [{ start: 0, end: now }]);
  const mergedItems = result.sinceSeen[0].items.filter((item) => item.type === 'pull-request-summary');

  assert.equal(mergedItems.length, 1);
  assert.equal(mergedItems[0].text, 'PR #11(同じPR)をマージした');
});

test('関連PR登録だけが残るマージも前回見てからに表示する', () => {
  const state = new DashboardState();
  const owner = 'example';
  const repo = 'project';
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const mergedAt = new Date(now - 2 * DAY_MS).toISOString();
  const productKey = `repo:${owner}/${repo}`;
  state.rememberRelatedPullRequest({
    owner,
    repo,
    number: 12,
    url: `https://github.com/${owner}/${repo}/pull/12`,
    lastOpen: {
      title: '関連PR', url: `https://github.com/${owner}/${repo}/pull/12`,
      headRefName: 'feature', baseRefName: 'main', headRefOid: '',
    },
  }, Date.parse(mergedAt));
  state.updateRelatedPullRequest(owner, repo, 12, { state: 'merged', mergedAt });
  state.setProductSeen(productKey, now - 3 * DAY_MS);

  const result = state.snapshotSinceSeen([], [], now, [{ start: 0, end: now }]);

  assert.equal(result.sinceSeen[0].product.key, productKey);
  assert.ok(result.sinceSeen[0].items.some((item) => (
    item.type === 'pull-request-summary' && item.text === 'PR #12(関連PR)をマージした'
  )));
});

test('関連PRのマージはそのPRをマージ済みとして載せるPR群のプロダクトに表示する', () => {
  const state = new DashboardState();
  const owner = 'example';
  const repo = 'project';
  const product = { key: 'C:\\project', name: 'project' };
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const mergedAt = new Date(now - 2 * DAY_MS).toISOString();
  state.rememberRelatedPullRequest({
    owner, repo, number: 13, url: `https://github.com/${owner}/${repo}/pull/13`,
    lastOpen: { title: '親のPR', url: `https://github.com/${owner}/${repo}/pull/13`, headRefName: 'parent', baseRefName: 'main', headRefOid: '' },
  }, Date.parse(mergedAt));
  state.updateRelatedPullRequest(owner, repo, 13, { state: 'merged', mergedAt });
  state.setProductSeen(product.key, now - 3 * DAY_MS);
  const pullRequestGroups = [{ product, owner, repo, merged: [{ number: 13, state: 'merged' }] }];

  const result = state.snapshotSinceSeen([], pullRequestGroups, now, [{ start: 0, end: now }]);

  assert.deepEqual(result.sinceSeen.map((entry) => entry.product.key), [product.key]);
  assert.ok(result.sinceSeen[0].items.some((item) => item.text === 'PR #13(親のPR)をマージした'));
});

test('20日前の既読時刻は参照記録が残る間維持して保持中の項目を未読にする', () => {
  const state = new DashboardState();
  const product = { key: 'C:\\project', name: 'project' };
  const owner = 'example';
  const repo = 'project';
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  const mergedAt = new Date(now - 2 * DAY_MS).toISOString();
  const seenAt = new Date(now - 20 * DAY_MS).toISOString();
  state.registerPullRequest('old-seen-merge', {
    url: `https://github.com/${owner}/${repo}/pull/13`,
  }, { product }, Date.parse(mergedAt));
  state.updatePullRequest('old-seen-merge', owner, repo, 13, { state: 'merged', mergedAt });
  state.setProductSeen(product.key, seenAt);

  state.pruneExpiredStoreRecords(now);
  const result = state.snapshotSinceSeen([], [], now, [{ start: 0, end: now }]);

  assert.equal(state.seenAtByProduct.get(product.key), seenAt);
  assert.ok(result.sinceSeen[0].items.some((item) => item.type === 'pull-request-summary'));
});

test('参照する記録がなくなったプロダクトの既読時刻をsnapshot時に削除する', () => {
  const state = new DashboardState();
  const sessionId = 'expired-product-records';
  const product = { key: 'C:\\project', name: 'project' };
  const now = Date.parse('2026-10-03T12:00:00.000Z');
  state.syncSessionFiles([{ session_id: sessionId, cwd: product.key, name: '期限切れ', product }], now);
  state.setTasks(sessionId, [task('期限切れタスク', 'done')], now);
  state.setProductSeen(product.key, now);
  state.syncSessionFiles([], now + 15 * DAY_MS);

  state.pruneExpiredStoreRecords(now + 15 * DAY_MS);
  const versionBeforeSnapshot = state.version;
  state.snapshotSinceSeen([], [], now + 15 * DAY_MS);

  assert.equal(state.seenAtByProduct.has(product.key), false);
  assert.ok(state.version > versionBeforeSnapshot);
});

test('離席期間の記録が食い違っていても、離席中かどうかの記録は保つ', async (t) => {
  const homeDir = await temporaryHome(t);
  const filePath = path.join(homeDir, 'away.json');
  // 閉じていない期間が途中にあり、since とも合わない。
  await fs.writeFile(filePath, JSON.stringify({
    enabled: true, since: 500, periods: [{ start: 100, end: null }, { start: 200, end: 300 }],
  }));
  assert.deepEqual((await AwayState.load(homeDir)).snapshot(), {
    enabled: true, since: 500, periods: [{ start: 500, end: null }],
  });

  await fs.writeFile(filePath, JSON.stringify({ enabled: false, since: null, periods: 'broken' }));
  assert.deepEqual((await AwayState.load(homeDir)).snapshot(), { enabled: false, since: null, periods: [] });
});
