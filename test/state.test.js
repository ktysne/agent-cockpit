const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DashboardState, claudeModelName } = require('../src/server/state');
const { productFromCwd } = require('../src/server/identity');
const { readSessionName, listLiveSessionFiles, findLiveSessionIdByPid, claudeAgentDefinition, codexAgentDefinition } = require('../src/server/session-files');
const { temporaryHome: createTemporaryHome } = require('./support/temp');

test('Notification だけの行は不明になり Stop またはメインのツールで状態が確定する', () => {
  for (const [hook_event_name, status] of [
    ['Stop', '待機中'], ['PreToolUse', '作業中'], ['PostToolUse', '作業中'],
    ['PostToolUseFailure', '作業中'], ['UserPromptSubmit', '作業中'],
  ]) {
    const state = new DashboardState();
    state.addEvent({ session_id: 'unknown', hook_event_name: 'Notification', hookAt: 100 });
    assert.equal(state.snapshot().sessions[0].status, '不明');
    assert.equal(Object.hasOwn(state.snapshot().sessions[0], 'turnKnown'), false);
    state.addEvent({ session_id: 'unknown', hook_event_name, tool_name: 'Read', tool_use_id: 'tool', hookAt: 200 });
    assert.equal(state.snapshot().sessions[0].status, status);
  }
});

test('サブエージェントのイベントと compact と PostToolBatch はターンの状態を確定しない', () => {
  for (const event of [
    { hook_event_name: 'SubagentStart', agent_id: 'sub' },
    { hook_event_name: 'SubagentStop', agent_id: 'sub' },
    ...['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].map((hook_event_name) => ({
      hook_event_name, agent_id: 'sub', tool_name: 'Read', tool_use_id: 'tool',
    })),
    { hook_event_name: 'SessionStart', source: 'compact' },
    { hook_event_name: 'SessionStart' },
    { hook_event_name: 'PostToolBatch' },
  ]) {
    const state = new DashboardState();
    state.addEvent({ session_id: 'unknown', hookAt: 100, ...event });
    assert.equal(state.snapshot().sessions[0].status, '不明', JSON.stringify(event));
  }
});

test('未確定の行でも許可待ちは idle の補完より優先する', () => {
  const state = new DashboardState();
  state.addEvent({ session_id: 'permission', hook_event_name: 'Notification', notification_type: 'permission_prompt', hookAt: 100 });
  state.syncSessionFiles([{ session_id: 'permission', status: 'idle' }]);
  assert.equal(state.snapshot().sessions[0].status, '許可待ち');
});

test('不明なターンの通知は推定を保ちメインの Interrupt で中断が確定したら推定を消す', () => {
  const state = new DashboardState();
  state.addEvent({ session_id: 'interrupt-estimate', hook_event_name: 'Notification', hookAt: 100 });
  const estimate = state.saveEstimate('interrupt-estimate', null);
  state.addEvent({ session_id: 'interrupt-estimate', hook_event_name: 'Notification', hookAt: 200 });
  assert.equal(state.snapshot().sessions[0].status, '不明');
  assert.equal(state.snapshot().sessions[0].turnState, 'unknown');
  assert.deepEqual(state.snapshot().sessions[0].estimate, estimate);
  state.addEvent({ session_id: 'interrupt-estimate', hook_event_name: 'Interrupt', hookAt: 300 });
  assert.equal(state.snapshot().sessions[0].status, '中断');
  assert.equal(state.snapshot().sessions[0].turnState, 'interrupted');
  assert.equal(state.snapshot().sessions[0].estimate, undefined);
  assert.equal(state.estimates.has('interrupt-estimate'), false);
});

test('子の Interrupt と Stop は親の不明なターンと推定を保つ', () => {
  const state = new DashboardState();
  state.addEvent({ session_id: 'child-turn', hook_event_name: 'SubagentStart', agent_id: 'child', hookAt: 100 });
  const estimate = state.saveEstimate('child-turn', null);
  for (const [hook_event_name, turnState] of [['Interrupt', 'interrupted'], ['Stop', 'waiting']]) {
    state.addEvent({ session_id: 'child-turn', agent_id: 'child', hook_event_name,
      hookAt: hook_event_name === 'Interrupt' ? 200 : 300 });
    const session = state.snapshot().sessions[0];
    assert.equal(session.status, '不明');
    assert.equal(session.turnState, 'unknown');
    assert.equal(session.agents[0].turnState, turnState);
    assert.deepEqual(session.estimate, estimate);
  }
});

test('イベント由来とファイルだけの不明な行は idle のときだけ待機中で補う', () => {
  for (const withEvent of [false, true]) {
    const state = new DashboardState();
    if (withEvent) state.addEvent({ session_id: 'unknown', hook_event_name: 'Notification', hookAt: 100 });
    for (const status of [undefined, 'busy', 'unknown', 'IDLE', 'idle']) {
      state.syncSessionFiles([{ session_id: 'unknown', ...(status ? { status } : {}) }]);
      assert.equal(state.snapshot().sessions[0].status, status === 'idle' ? '待機中' : '不明');
    }
  }
});

test('idle の補完は稼働中のサブエージェントを含み画面で終了にしたものを除く', () => {
  const state = new DashboardState();
  state.addEvent({ session_id: 'unknown', hook_event_name: 'SubagentStart', agent_id: 'sub', hookAt: 100 });
  state.syncSessionFiles([{ session_id: 'unknown', status: 'idle' }]);
  assert.equal(state.snapshot().sessions[0].status, '待機中(サブエージェント稼働中)');
  state.addEvent({ session_id: 'unknown', hook_event_name: 'SubagentStop', agent_id: 'sub', hookAt: 200 });
  assert.equal(state.snapshot().sessions[0].status, '待機中');

  // 背景のサブエージェントは確定したターンの PostToolUse(Agent)で付くため、ここでは Stop の後に作る。
  const background = backgroundClaudeState('closed');
  background.addEvent({ session_id: 'closed', hook_event_name: 'Stop', hookAt: 400 });
  background.syncSessionFiles([{ session_id: 'closed', status: 'idle' }]);
  assert.equal(background.snapshot().sessions[0].status, '待機中(サブエージェント稼働中)');
  assert.equal(background.closeAgent('closed', 'task-1'), true);
  assert.equal(background.snapshot().sessions[0].status, '待機中');
});

test('ファイルの status だけの変更で版が進み補完した行には推定を付けず保存も拒否する', () => {
  for (const withEvent of [false, true]) {
    const state = new DashboardState();
    if (withEvent) state.addEvent({ session_id: 'unknown', hook_event_name: 'Notification', hookAt: 100 });
    const file = { session_id: 'unknown', status: 'busy' };
    state.syncSessionFiles([file]);
    assert.ok(state.saveEstimate('unknown', null));
    const version = state.version;
    state.syncSessionFiles([{ ...file, status: 'idle' }]);
    assert.equal(state.version, version + 1);
    assert.equal(state.snapshot().sessions[0].estimate, undefined);
    assert.equal(state.saveEstimate('unknown', null), null);
    const unchangedVersion = state.version;
    state.syncSessionFiles([{ ...file, status: 'idle' }]);
    assert.equal(state.version, unchangedVersion);
  }
});

test('確定したターンの状態はセッションファイルの idle で上書きしない', () => {
  const state = new DashboardState();
  state.addEvent({ session_id: 'working', hook_event_name: 'UserPromptSubmit', hookAt: 100 });
  state.syncSessionFiles([{ session_id: 'working', status: 'idle' }]);
  assert.equal(state.snapshot().sessions[0].status, '作業中');
});

test('セッションファイルの status は文字列だけを先頭 50 文字まで読む', async () => {
  const values = ['idle', 'busy', 'x'.repeat(60), '', undefined, null, 1, {}, []];
  const fileSystem = {
    readdir: async () => values.map((_, index) => ({ name: `${index}.json`, isFile: () => true })),
    readFile: async (file) => {
      const index = Number(path.basename(file, '.json'));
      return JSON.stringify({ session_id: String(index), pid: 1, status: values[index] });
    },
  };
  const files = await listLiveSessionFiles('unused', { fileSystem, isAlive: () => true });
  assert.deepEqual(files.map((file) => file.status), ['idle', 'busy', 'x'.repeat(50), '', undefined, undefined, undefined, undefined, undefined]);
});

function backgroundClaudeState(sessionId = 'task-stop') {
  const state = new DashboardState();
  state.addEvent({ session_id: sessionId, hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: 'launch', hookAt: 100 });
  state.addEvent({ session_id: sessionId, hook_event_name: 'SubagentStart', agent_id: 'task-1', agent_type: 'impl-standard', hookAt: 200 });
  state.addEvent({ session_id: sessionId, hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'launch', hookAt: 300 });
  return state;
}

test('TaskStop で一致する背景サブエージェントを終了にし Stop 後は待機中になる', () => {
  const state = backgroundClaudeState();
  state.addEvent({ session_id: 'task-stop', hook_event_name: 'PostToolUse', tool_name: 'TaskStop', stoppedTaskId: 'task-1', hookAt: 400 });
  state.addEvent({ session_id: 'task-stop', hook_event_name: 'Stop', hookAt: 500 });
  const session = state.snapshot().sessions[0];
  assert.equal(session.agents[0].active, false);
  assert.equal(session.agents[0].unconfirmed, false);
  assert.equal(session.status, '待機中');
});

test('transcript通知は直接Codex行を終了や結果受領として扱わない', () => {
  const state = new DashboardState();
  launchCodex(state, 'direct-codex', 'codex-launch', 350, null);
  const before = state.snapshot().sessions[0].agents[0];
  assert.equal(before.isCodex, true);
  assert.equal(before.active, true);

  state.applyTaskNotifications('direct-codex', new Map([[
    before.agent_id, { status: 'killed', recordedAt: null },
  ]]), 500);

  const after = state.snapshot().sessions[0].agents[0];
  assert.deepEqual([after.active, after.resultReceived], [before.active, before.resultReceived]);
});

test('一致しない task_id と PostToolUseFailure はサブエージェントを終了にしない', () => {
  for (const [hook_event_name, stoppedTaskId] of [['PostToolUse', 'other'], ['PostToolUseFailure', 'task-1']]) {
    const state = backgroundClaudeState();
    state.addEvent({ session_id: 'task-stop', hook_event_name, tool_name: 'TaskStop', stoppedTaskId, hookAt: 400 });
    assert.equal(state.snapshot().sessions[0].agents[0].active, true);
  }
});

test('TaskStop と SubagentStop は未完了ツールと許可待ちを消す', () => {
  for (const stop of [
    { hook_event_name: 'PostToolUse', tool_name: 'TaskStop', stoppedTaskId: 'task-1' },
    { hook_event_name: 'SubagentStop', agent_id: 'task-1' },
  ]) {
    const state = backgroundClaudeState();
    state.addEvent({ session_id: 'task-stop', hook_event_name: 'PreToolUse', agent_id: 'task-1', tool_name: 'Bash', tool_use_id: 'pending', hookAt: 350 });
    state.addEvent({ session_id: 'task-stop', hook_event_name: 'Notification', notification_type: 'permission_prompt', agent_id: 'task-1', hookAt: 360 });
    assert.equal(state.snapshot().sessions[0].permissionWaits.length, 1);
    state.addEvent({ session_id: 'task-stop', ...stop, hookAt: 400 });
    assert.deepEqual(state.snapshot().sessions[0].tools, []);
    assert.deepEqual(state.snapshot().sessions[0].permissionWaits, []);
  }
});

test('TaskStop で窓口配下の背景 Codex は終了未確認になる', () => {
  const state = backgroundClaudeState();
  launchCodex(state, 'task-stop', 'codex-launch', 350, 'task-1');
  state.addEvent({ session_id: 'task-stop', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'codex-launch', agent_id: 'task-1', hookAt: 360 });
  state.addEvent({ session_id: 'task-stop', hook_event_name: 'PostToolUse', tool_name: 'TaskStop', stoppedTaskId: 'task-1', hookAt: 400 });
  assert.deepEqual([state.snapshot().sessions[0].agents[0].gpt.active, state.snapshot().sessions[0].agents[0].gpt.unconfirmed], [false, true]);
});

test('TaskStop 後の遅延イベントでは復活せず SubagentStart で再開する', () => {
  const state = backgroundClaudeState();
  state.addEvent({ session_id: 'task-stop', hook_event_name: 'PostToolUse', tool_name: 'TaskStop', stoppedTaskId: 'task-1', hookAt: 400 });
  state.addEvent({ session_id: 'task-stop', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'late', agent_id: 'task-1', hookAt: 500 });
  state.addEvent({ session_id: 'task-stop', hook_event_name: 'Notification', notification_type: 'permission_prompt', agent_id: 'task-1', hookAt: 510 });
  assert.equal(state.snapshot().sessions[0].agents[0].active, false);
  assert.deepEqual(state.snapshot().sessions[0].tools, []);
  assert.deepEqual(state.snapshot().sessions[0].permissionWaits, []);
  state.addEvent({ session_id: 'task-stop', hook_event_name: 'SubagentStart', agent_id: 'task-1', hookAt: 600 });
  assert.equal(state.snapshot().sessions[0].agents[0].active, true);
  assert.equal(state.snapshot().sessions[0].agents[0].startedAt, new Date(600).toISOString());
});

test('合成 SubagentStop で終了にし二度合成せず開始より前の通知は無視する', () => {
  const state = backgroundClaudeState();
  const notifications = new Map([['task-1', { status: 'killed', recordedAt: new Date(199).toISOString() }]]);
  state.applyTaskNotifications('task-stop', notifications, 400);
  assert.equal(state.snapshot().sessions[0].agents[0].active, true);
  notifications.get('task-1').recordedAt = new Date(200).toISOString();
  state.applyTaskNotifications('task-stop', notifications, 400);
  assert.equal(state.snapshot().sessions[0].agents[0].active, false);
  const count = state.entries.get('task-stop').length;
  state.applyTaskNotifications('task-stop', notifications, 500);
  assert.equal(state.entries.get('task-stop').length, count);
  state.addEvent({ session_id: 'task-stop', hook_event_name: 'SubagentStart', agent_id: 'task-1', hookAt: 600 });
  state.applyTaskNotifications('task-stop', notifications, 700);
  assert.equal(state.snapshot().sessions[0].agents[0].active, true);
  notifications.get('task-1').recordedAt = null;
  state.applyTaskNotifications('task-stop', notifications, 800);
  assert.equal(state.snapshot().sessions[0].agents[0].active, false);
});

test('背景起動した Claude サブエージェントは閉じられ閉じた後にイベントが来たら戻る', () => {
  const state = backgroundClaudeState();
  state.addEvent({ session_id: 'task-stop', hook_event_name: 'Stop', hookAt: 400 });
  assert.equal(state.snapshot().sessions[0].agents[0].closable, true);
  assert.equal(state.closeAgent('task-stop', 'task-1'), true);
  assert.equal(state.snapshot().sessions[0].agents[0].active, false);
  assert.equal(state.snapshot().sessions[0].status, '待機中');
  state.addEvent({ session_id: 'task-stop', hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'new-tool', agent_id: 'task-1', hookAt: 500 });
  assert.equal(state.closedAgents.get('task-stop')?.has('task-1') || false, false);
  assert.equal(state.snapshot().sessions[0].agents[0].active, true);
  assert.equal(state.snapshot().sessions[0].status, '待機中(サブエージェント稼働中)');
});

test('セッション削除は作業記録を消し、PR 登録と予約と意図を残す', () => {
  const ended = [];
  const state = new DashboardState({ onSessionEndedByAbsence: (...args) => ended.push(args) });
  const id = 'deleted-session';
  state.addEvent({ session_id: id, hook_event_name: 'SessionStart', hookAt: 100 });
  state.syncSessionFiles([{ session_id: id, updatedAt: new Date(100).toISOString() }], 100);
  state.setTasks(id, [{ title: '作業', state: 'doing', criteria: [] }], 100);
  state.registerPullRequest(id, { url: 'https://github.com/example/project/pull/1' }, {}, 100);
  state.hideSession(id, 150);
  assert.equal(state.snapshot().sessions[0].hiddenAt, new Date(150).toISOString());
  for (const records of [state.decisionOverrides, state.estimates, state.closedAgents,
    state.askDecisionBindings, state.finishedOutsideEventsAskDecisionIds, state.decisionLifecycles, state.closedTasks]) {
    records.set(id, new Map());
  }
  state.pullRequestMergeReservationRecords.set('reservation', { session_id: id });
  state.pullRequestMergeIntentRecords.set('intent', { session_id: id });
  assert.equal(state.deleteSession('unknown', 200), false);
  assert.equal(state.deleteSession(id, 200), true);
  for (const records of [state.entries, state.sessions, state.endedAt, state.endedByAbsence,
    state.decisionOverrides, state.estimates, state.hiddenSessions, state.hiddenSessionUpdatedAt,
    state.closedAgents, state.sessionFileLastSeenAt, state.plans, state.askDecisionBindings,
    state.finishedOutsideEventsAskDecisionIds, state.decisionLifecycles, state.closedTasks]) {
    assert.equal(records.has(id), false);
  }
  assert.equal(state.pullRequestRegistrations().length, 1);
  assert.equal(state.pullRequestMergeReservationRecords.size, 1);
  assert.equal(state.pullRequestMergeIntentRecords.size, 1);
  assert.deepEqual(ended, [[id, 200]]);
  assert.deepEqual(state.snapshot().sessions, []);
  assert.equal(state.deleteSession(id, 201), false);
});

test('削除時刻以前と更新時刻の無いファイルは隠し、新しいファイルで復活する', () => {
  const state = new DashboardState();
  const file = { session_id: 'deleted-file', updatedAt: new Date(100).toISOString() };
  state.syncSessionFiles([file], 100);
  state.deleteSession(file.session_id, 200);
  for (const updatedAt of [file.updatedAt, new Date(200).toISOString(), undefined]) {
    state.syncSessionFiles([{ ...file, updatedAt }], 201);
    assert.deepEqual(state.snapshot().sessions, []);
    assert.equal(state.deletedSessions.has(file.session_id), true);
  }
  state.syncSessionFiles([{ ...file, updatedAt: new Date(201).toISOString() }], 202);
  assert.equal(state.snapshot().sessions[0].session_id, file.session_id);
  assert.equal(state.deletedSessions.has(file.session_id), false);
});

test('削除時刻以前のイベントを捨て、新しいイベントで新しい記録を作る', () => {
  const reopened = [];
  const state = new DashboardState({ onSessionReopened: (id) => reopened.push(id) });
  const id = 'deleted-event';
  state.addEvent({ session_id: id, hook_event_name: 'SessionStart', hookAt: 100 });
  state.deleteSession(id, 200);
  for (const hookAt of [100, 200]) {
    state.addEvent({ session_id: id, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'old', hookAt });
    assert.deepEqual(state.snapshot().sessions, []);
    assert.equal(state.entries.has(id), false);
  }
  state.addEvent({ session_id: id, hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'new', hookAt: 201 });
  assert.equal(state.deletedSessions.has(id), false);
  assert.equal(state.entries.get(id).length, 1);
  assert.deepEqual(reopened, [id]);
});

test('同期で一度ファイルが欠け、次の同期で古い updatedAt のファイルが戻っても再表示しない', () => {
  const state = new DashboardState();
  const file = { session_id: 'temporarily-unreadable', updatedAt: new Date(100).toISOString() };
  state.syncSessionFiles([file], 100);
  state.deleteSession(file.session_id, 200);
  state.syncSessionFiles([], 201);
  assert.equal(state.deletedSessions.has(file.session_id), true);
  state.syncSessionFiles([file], 202);
  assert.deepEqual(state.snapshot().sessions, []);
  assert.equal(state.deletedSessions.has(file.session_id), true);
});

test('削除印は保存期限を超えたときに掃除する', () => {
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'expired' }], 100);
  state.deleteSession('expired', 200);
  state.pruneExpiredStoreRecords(14 * 24 * 60 * 60_000 + 201);
  assert.equal(state.deletedSessions.has('expired'), false);
});

test('MCP のタスクと判断事項と PR の書き込みで削除印を解除する', () => {
  for (const write of [
    (state, id) => state.setTasks(id, [{ title: '新しい作業', state: 'doing', criteria: [] }], 200),
    (state, id) => state.addDecision(id, { title: '新しい判断', state: 'waiting', context: '', options: [] }, 200),
    (state, id) => state.registerPullRequest(id, { url: 'https://github.com/example/project/pull/2' }, {}, 201),
  ]) {
    const state = new DashboardState();
    state.syncSessionFiles([{ session_id: 'mcp-reopen' }], 100);
    state.deleteSession('mcp-reopen', 200);
    assert.ok(write(state, 'mcp-reopen'));
    assert.equal(state.deletedSessions.has('mcp-reopen'), false);
    assert.equal(state.snapshot().sessions.length, 1);
  }
});

async function temporaryHome(testContext) {
  return createTemporaryHome(testContext, 'agent-cockpit-test-', {
    environment: { AGENT_COCKPIT_HOME: (homeDir) => homeDir },
  });
}

test('worktree の cwd からプロダクトの鍵と表示名を求める', async (t) => {
  await temporaryHome(t);
  const product = productFromCwd('D:\\Desktop\\Develop\\Agent-Cockpit\\.claude\\worktrees\\feature-x\\src');
  assert.deepEqual(
    { key: product.key, name: product.name },
    { key: 'd:\\desktop\\develop\\agent-cockpit', name: 'Agent-Cockpit' },
  );
});

test('既知の cwd は稼働中セッションと PR 登録から文字列だけを重複なく返す', () => {
  const state = new DashboardState();
  state.syncSessionFiles([
    { session_id: 'live-one', cwd: 'C:\\worktree\\active' },
    { session_id: 'live-two', cwd: 'C:\\worktree\\active' },
    { session_id: 'live-no-cwd', cwd: 42 },
  ]);
  state.registerPullRequest('registered-one', {
    url: 'https://github.com/example/project/pull/1',
  }, { cwd: 'C:\\worktree\\active' });
  state.registerPullRequest('registered-two', {
    url: 'https://github.com/example/project/pull/2',
  }, { cwd: 'D:\\worktree\\registered' });

  assert.deepEqual(state.knownCwds(), ['C:\\worktree\\active', 'D:\\worktree\\registered']);
});

test('更新の無いセッションを隠す時間は既定で30分', () => {
  assert.equal(new DashboardState().getDisplayPreferences().idleHideMinutes, 30);
});

test('マージ結果を隠す時間は既定で5分', () => {
  assert.equal(new DashboardState().getDisplayPreferences().mergeResultHideMinutes, 5);
});

test('予約取消の知らせは記録時刻から1分後に PR の状態へ含めない', () => {
  const state = new DashboardState();
  const now = Date.now();
  const notice = (number, at) => ({
    owner: 'example', repo: 'project', number,
    url: `https://github.com/example/project/pull/${number}`,
    at: new Date(at).toISOString(), message: '予約を取り消しました。',
  });
  state.recordPullRequestMergeReservationNotice(notice(1, now - 60_001));
  state.recordPullRequestMergeReservationNotice(notice(2, now - 30_000));

  assert.deepEqual(
    state.pullRequestMergeReservationNoticesForRepo('example', 'project').map((record) => record.number),
    [2],
  );
});

test('lastUpdatedAt はイベント、計画、判断事項の最新時刻を返す', () => {
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'last-updated', cwd: 'C:\\project', name: '更新時刻' }]);
  state.addEvent({ session_id: 'last-updated', hook_event_name: 'SessionStart', hookAt: 1_000 });
  const session = () => state.snapshot().sessions.find((item) => item.session_id === 'last-updated');
  const timestamp = (milliseconds) => new Date(milliseconds).toISOString();

  assert.equal(session().lastUpdatedAt, timestamp(1_000));
  state.setTasks('last-updated', [{ title: '計画', state: 'todo', criteria: [] }], 3_000);
  assert.equal(session().lastUpdatedAt, timestamp(3_000));
  const decision = state.addDecision('last-updated', {
    title: '判断', context: '', state: 'waiting', options: [{ label: '続ける' }],
  }, 2_000);
  assert.equal(session().lastUpdatedAt, timestamp(3_000));
  state.updateDecision('last-updated', decision.id, 'provisional', [], '', 4_000);
  assert.equal(session().lastUpdatedAt, timestamp(4_000));
  state.addEvent({ session_id: 'last-updated', hook_event_name: 'UserPromptSubmit', hookAt: 5_000 });
  assert.equal(session().lastUpdatedAt, timestamp(5_000));

  state.syncSessionFiles([{
    session_id: 'file-only', cwd: 'C:\\project', name: '時刻なし', updatedAt: '2026-10-04T00:00:00.000Z',
  }]);
  const fileOnly = state.snapshot().sessions.find((item) => item.session_id === 'file-only');
  assert.equal(fileOnly.sessionFileUpdatedAt, '2026-10-04T00:00:00.000Z');
  assert.equal(fileOnly.lastUpdatedAt, null);
});

test('状態不明のセッションを外し、すべて表示する操作で戻す', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'hidden-unknown', cwd: 'C:\\project', name: '作業中' }]);

  const originalVersion = state.version;
  assert.equal(state.hideSession('hidden-unknown'), true);
  assert.equal(state.version, originalVersion + 1);
  assert.equal(state.snapshot().sessions[0].hidden, true);
  const hiddenVersion = state.version;
  assert.equal(state.clearHiddenSessions(), 1);
  assert.equal(state.version, hiddenVersion + 1);
  assert.equal(state.snapshot().sessions[0].hidden, undefined);
});

test('外したセッションはイベント到着後に一覧へ戻る', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'hidden-event', cwd: 'C:\\project', name: '作業中' }]);
  state.hideSession('hidden-event');

  state.addEvent({ session_id: 'hidden-event', hook_event_name: 'SessionStart', source: 'startup', hookAt: 100 });
  assert.equal(state.snapshot().sessions[0].hidden, undefined);
  assert.notEqual(state.snapshot().sessions[0].status, '不明');
});

test('状態の推定結果はイベント到着後に消える', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'estimated-event', cwd: 'C:\\project', name: '作業中' }]);
  const originalVersion = state.version;
  state.saveEstimate('estimated-event', { recordedAt: '2026-10-02T01:02:03.000Z', lastTool: 'Read', state: 'input' });
  assert.equal(state.version, originalVersion + 1);
  assert.equal(state.snapshot().sessions[0].estimate.canEstimate, true);

  state.addEvent({ session_id: 'estimated-event', hook_event_name: 'SessionStart', source: 'startup', hookAt: 100 });
  assert.equal(state.snapshot().sessions[0].estimate, undefined);
});

test('推定は不明のままのイベントでは残し、ターンが確定した Stop で消す', async (t) => {
  await temporaryHome(t);
  for (const [event, kept, status = kept ? '不明' : '待機中'] of [
    [{ hook_event_name: 'Notification' }, true],
    [{ hook_event_name: 'SubagentStart', agent_id: 'sub' }, true],
    [{ hook_event_name: 'PreToolUse', agent_id: 'sub', tool_name: 'Read', tool_use_id: 'sub-tool' }, true],
    [{ hook_event_name: 'PostToolBatch' }, true],
    [{ hook_event_name: 'Notification', notification_type: 'permission_prompt', agent_id: 'sub' }, true, '許可待ち'],
    [{ hook_event_name: 'Stop' }, false],
  ]) {
    const state = new DashboardState();
    state.syncSessionFiles([{ session_id: 'estimate-kept', cwd: 'C:\\project', name: '作業中' }]);
    state.addEvent({ session_id: 'estimate-kept', hook_event_name: 'Notification', hookAt: 50 });
    state.saveEstimate('estimate-kept', { recordedAt: '2026-10-02T01:02:03.000Z', lastTool: 'Read', state: 'input' });
    state.addEvent({ session_id: 'estimate-kept', hookAt: 100, ...event });
    assert.equal(state.estimates.has('estimate-kept'), kept, JSON.stringify(event));
    const session = state.snapshot().sessions[0];
    assert.equal(session.status, status, JSON.stringify(event));
    assert.equal(session.estimate?.canEstimate, status === '不明' ? true : undefined, JSON.stringify(event));
  }
});

test('セッションファイルから60秒間消えたイベントセッションを終了扱いにする', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'ended-by-file', cwd: 'C:\\project', name: '作業中' }], 1_000);
  state.addEvent({ session_id: 'ended-by-file', hook_event_name: 'SessionStart', hookAt: 1_000 });

  state.syncSessionFiles([], 60_999);
  assert.equal(state.endedAt.has('ended-by-file'), false);
  assert.equal(state.snapshot().sessions.length, 1);

  state.syncSessionFiles([], 61_000);
  assert.equal(state.endedByAbsence.get('ended-by-file'), 61_000);
  assert.equal(state.sessionFileLastSeenAt.has('ended-by-file'), false);
  assert.deepEqual(state.snapshot().sessions, []);
});

test('一覧から消えて終了扱いになったセッションは新しい SessionStart で戻る', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'resume-by-start', cwd: 'C:\\project', name: '作業中' }], 1_000);
  state.addEvent({ session_id: 'resume-by-start', hook_event_name: 'SessionStart', hookAt: 1_000 });
  state.syncSessionFiles([], 61_000);

  state.addEvent({ session_id: 'resume-by-start', hook_event_name: 'SessionStart', hookAt: 62_000 });

  assert.equal(state.endedByAbsence.has('resume-by-start'), false);
  assert.equal(state.snapshot().sessions.length, 1);
});

test('一覧から消えて終了扱いになったセッションは新しいイベントで戻る', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'resume-by-event', cwd: 'C:\\project', name: '作業中' }], 1_000);
  state.addEvent({ session_id: 'resume-by-event', hook_event_name: 'SessionStart', hookAt: 1_000 });
  state.syncSessionFiles([], 61_000);

  state.addEvent({ session_id: 'resume-by-event', hook_event_name: 'UserPromptSubmit', hookAt: 62_000 });

  assert.equal(state.endedByAbsence.has('resume-by-event'), false);
  assert.equal(state.snapshot().sessions.length, 1);
});

test('一覧に戻ったセッションファイルで不在終了の扱いを解除する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'resume-by-file', cwd: 'C:\\project', name: '作業中' }], 1_000);
  state.addEvent({ session_id: 'resume-by-file', hook_event_name: 'SessionStart', hookAt: 1_000 });
  state.syncSessionFiles([], 61_000);

  state.syncSessionFiles([{ session_id: 'resume-by-file', cwd: 'C:\\project', name: '作業中' }], 62_000);

  assert.equal(state.endedByAbsence.has('resume-by-file'), false);
  assert.equal(state.snapshot().sessions.length, 1);
});

test('一覧にない状態不明セッションの最終確認時刻は Map から削除する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'file-only', cwd: 'C:\\project', name: '作業中' }], 1_000);

  state.syncSessionFiles([], 2_000);

  assert.equal(state.sessionFileLastSeenAt.has('file-only'), false);
});

test('セッションファイルから59秒しか消えていないイベントセッションを残す', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'still-live', cwd: 'C:\\project', name: '作業中' }], 1_000);
  state.addEvent({ session_id: 'still-live', hook_event_name: 'SessionStart', hookAt: 1_000 });

  state.syncSessionFiles([], 60_999);

  assert.equal(state.endedAt.has('still-live'), false);
  assert.equal(state.snapshot().sessions.length, 1);
});

test('セッションファイルに載ったことがないイベントセッションを終了扱いにしない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'never-listed', hook_event_name: 'SessionStart', hookAt: 1_000 });

  state.syncSessionFiles([], 100_000);

  assert.equal(state.endedAt.has('never-listed'), false);
  assert.equal(state.snapshot().sessions.length, 1);
});

test('セッションファイル一覧を読めないときは終了判定をしない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'unreadable-list', cwd: 'C:\\project', name: '作業中' }], 1_000);
  state.addEvent({ session_id: 'unreadable-list', hook_event_name: 'SessionStart', hookAt: 1_000 });

  state.syncSessionFiles(null, 100_000);

  assert.equal(state.endedAt.has('unreadable-list'), false);
  assert.equal(state.snapshot().sessions.length, 1);
});

test('推定の読み取り中に状態が分かったセッションには推定を保存しない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'estimated-race', cwd: 'C:\\project', name: '作業中' }]);
  state.addEvent({ session_id: 'estimated-race', hook_event_name: 'SessionStart', source: 'startup', hookAt: 100 });
  assert.equal(state.saveEstimate('estimated-race', { recordedAt: '2026-10-02T01:02:03.000Z', lastTool: 'Read', state: 'input' }), null);
  assert.equal(state.snapshot().sessions[0].estimate, undefined);
});

test('状態にかかわらず一覧にあるセッションを外せる', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'known-session', hook_event_name: 'SessionStart', hookAt: 100 });
  assert.equal(state.hideSession('known-session'), true);
  assert.equal(state.snapshot().sessions[0].hidden, true);
  assert.equal(state.hideSession('missing-session'), null);
});

test('外したセッションを再度外すと更新時刻を更新して保存する', async (t) => {
  const { homeDir } = await temporaryHome(t);
  const state = await DashboardState.load(homeDir);
  const sessionId = 'hidden-again';
  state.syncSessionFiles([{ session_id: sessionId }], 100);
  state.hideSession(sessionId, 150);
  const version = state.version;

  state.hideSession(sessionId, 250);

  assert.equal(state.version, version + 1);
  assert.equal(state.snapshot().sessions[0].hiddenAt, new Date(250).toISOString());
  await state.flushPersistence();
  const stored = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
  assert.deepEqual(stored.hiddenSessions, [{ session_id: sessionId, updatedAt: new Date(250).toISOString() }]);
});

test('終了して一覧から消えたセッションを外した集合からも除く', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'hidden-ended', cwd: 'C:\\project', name: '作業中' }]);
  state.hideSession('hidden-ended');
  state.syncSessionFiles([]);
  assert.deepEqual(state.snapshot().sessions, []);
  assert.equal(state.hiddenSessions.size, 0);
});

test('hookAt の順に再構成し、後から届いた古い PreToolUse を完了済みの PostToolUse より前に置く', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({
    session_id: 'ordered', hook_event_name: 'PostToolUse', hookAt: 200,
    tool_name: 'Read', tool_use_id: 'tool-1',
  });
  state.addEvent({
    session_id: 'ordered', hook_event_name: 'PreToolUse', hookAt: 100,
    tool_name: 'Read', tool_use_id: 'tool-1', summary: 'README.md',
  });
  assert.deepEqual(state.snapshot().sessions[0].tools, []);
});

test('メインの Stop と UserPromptSubmit はメインのツールだけを消す', async (t) => {
  await temporaryHome(t);
  for (const hook_event_name of ['Stop', 'UserPromptSubmit']) {
    const state = new DashboardState();
    state.addEvent({ session_id: 'tool-cleanup', hook_event_name: 'SessionStart', hookAt: 100 });
    state.addEvent({ session_id: 'tool-cleanup', hook_event_name: 'PreToolUse', hookAt: 200, tool_name: 'Bash', tool_use_id: 'main-tool' });
    state.addEvent({ session_id: 'tool-cleanup', hook_event_name: 'PreToolUse', hookAt: 210, agent_id: 'agent-1', tool_name: 'Read', tool_use_id: 'agent-tool' });

    state.addEvent({ session_id: 'tool-cleanup', hook_event_name, hookAt: 300 });

    assert.deepEqual(state.snapshot().sessions[0].tools.map((tool) => tool.tool_use_id), ['agent-tool']);
  }
});

test('PostToolBatch はその時刻より前に始まったメインツールだけを消す', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'batch-cleanup', hook_event_name: 'PreToolUse', hookAt: 100, tool_name: 'Bash', tool_use_id: 'old-main-tool' });
  state.addEvent({ session_id: 'batch-cleanup', hook_event_name: 'PreToolUse', hookAt: 150, agent_id: 'agent-1', tool_name: 'Read', tool_use_id: 'agent-tool' });
  state.addEvent({ session_id: 'batch-cleanup', hook_event_name: 'PreToolUse', hookAt: 200, tool_name: 'Read', tool_use_id: 'same-time-main-tool' });
  state.addEvent({ session_id: 'batch-cleanup', hook_event_name: 'PreToolUse', hookAt: 250, tool_name: 'Read', tool_use_id: 'new-main-tool' });

  state.addEvent({ session_id: 'batch-cleanup', hook_event_name: 'PostToolBatch', hookAt: 200 });

  assert.deepEqual(state.snapshot().sessions[0].tools.map((tool) => tool.tool_use_id), [
    'agent-tool', 'same-time-main-tool', 'new-main-tool',
  ]);
});

test('サブエージェントの PostToolBatch は拒否されたツールと許可待ちを消し、ほかのエージェントの分は残す', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const add = (event) => state.addEvent({ session_id: 'rejected-tool', ...event });
  add({ hook_event_name: 'SubagentStart', hookAt: 50, agent_id: 'agent-1', agent_type: 'general-purpose' });
  add({ hook_event_name: 'PreToolUse', hookAt: 100, agent_id: 'agent-1', tool_name: 'Bash', tool_use_id: 'rejected' });
  add({ hook_event_name: 'Notification', hookAt: 110, agent_id: 'agent-1', notification_type: 'permission_prompt', message: '許可が必要です' });
  add({ hook_event_name: 'PreToolUse', hookAt: 120, agent_id: 'agent-2', tool_name: 'Read', tool_use_id: 'other-agent-tool' });
  add({ hook_event_name: 'Notification', hookAt: 130, agent_id: 'agent-2', notification_type: 'permission_prompt', message: '許可が必要です' });
  add({ hook_event_name: 'PreToolUse', hookAt: 140, tool_name: 'Agent', tool_use_id: 'main-agent-call' });
  add({ hook_event_name: 'PreToolUse', hookAt: 200, agent_id: 'agent-1', tool_name: 'Read', tool_use_id: 'next-tool' });
  add({ hook_event_name: 'PostToolUse', hookAt: 210, agent_id: 'agent-1', tool_name: 'Read', tool_use_id: 'next-tool' });
  add({ hook_event_name: 'PostToolBatch', hookAt: 220, agent_id: 'agent-1' });

  const session = state.snapshot().sessions[0];
  assert.deepEqual(session.tools.map((tool) => tool.tool_use_id), ['other-agent-tool', 'main-agent-call']);
  assert.deepEqual(session.permissionWaits.map((wait) => wait.agent_id), ['agent-2']);
});

test('メインの PostToolBatch では許可待ちを消さない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const add = (event) => state.addEvent({ session_id: 'main-wait', ...event });
  add({ hook_event_name: 'PreToolUse', hookAt: 100, tool_name: 'Bash', tool_use_id: 'main-tool' });
  add({ hook_event_name: 'Notification', hookAt: 110, notification_type: 'permission_prompt', message: '許可が必要です' });
  add({ hook_event_name: 'Notification', hookAt: 120, agent_id: 'agent-1', notification_type: 'permission_prompt', message: '許可が必要です' });
  add({ hook_event_name: 'PostToolBatch', hookAt: 200 });

  assert.deepEqual(state.snapshot().sessions[0].permissionWaits.map((wait) => wait.agent_id), [null, 'agent-1']);
});

test('許可待ちは同じ対象ツールの PostToolUse で解消する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'permission', hook_event_name: 'SessionStart', hookAt: 100 });
  state.addEvent({ session_id: 'permission', hook_event_name: 'PreToolUse', hookAt: 200, tool_name: 'Bash', tool_use_id: 'oldest', summary: 'git push' });
  state.addEvent({ session_id: 'permission', hook_event_name: 'PreToolUse', hookAt: 300, tool_name: 'Read', tool_use_id: 'newer', summary: 'README.md' });
  state.addEvent({ session_id: 'permission', hook_event_name: 'Notification', hookAt: 400, notification_type: 'permission_prompt', message: '許可を待っています' });

  let session = state.snapshot().sessions[0];
  assert.equal(session.status, '許可待ち');
  assert.equal(session.permissionWaits[0].target_tool_use_id, 'oldest');

  state.addEvent({ session_id: 'permission', hook_event_name: 'PostToolUse', hookAt: 500, tool_name: 'Read', tool_use_id: 'newer' });
  assert.equal(state.snapshot().sessions[0].permissionWaits.length, 1);
  state.addEvent({ session_id: 'permission', hook_event_name: 'PostToolUse', hookAt: 600, tool_name: 'Bash', tool_use_id: 'oldest' });
  session = state.snapshot().sessions[0];
  assert.equal(session.permissionWaits.length, 0);
  assert.equal(session.status, '作業中');
});

test('AskUserQuestion は PostToolUse で回答付きの解決済みにする', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({
    session_id: 'ask-resolved', hook_event_name: 'PreToolUse', hookAt: 100,
    tool_name: 'AskUserQuestion', tool_use_id: 'ask-1',
    questions: [{
      question: 'どの形式にしますか。', header: '形式', multiSelect: false,
      options: [{ label: '(推奨) JSON', description: '既存 API で使えます。', recommended: true }],
    }],
  });
  const waiting = state.snapshot().sessions[0].decisions[0];
  assert.deepEqual([waiting.id, waiting.source, waiting.state, waiting.questions[0].options[0].recommended], ['ask-1', 'ask', 'waiting', true]);
  assert.equal(waiting.answer, null);
  state.addEvent({
    session_id: 'ask-resolved', hook_event_name: 'PostToolUse', hookAt: 200,
    tool_name: 'AskUserQuestion', tool_use_id: 'ask-1',
    decisionResolution: { chosen: ['JSON'], note: '' },
  });
  const resolved = state.snapshot().sessions[0].decisions[0];
  assert.deepEqual([resolved.state, resolved.resolvedAt], ['resolved', new Date(200).toISOString()]);
  assert.deepEqual(resolved.resolution, { chosen: ['JSON'], note: '' });
});

test('AskUserQuestion の失敗は判断事項を取り下げる', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({
    session_id: 'ask-withdrawn', hook_event_name: 'PreToolUse', hookAt: 100,
    tool_name: 'AskUserQuestion', tool_use_id: 'ask-1',
    questions: [{ question: '続けますか。', header: '', multiSelect: false, options: [] }],
  });
  state.addEvent({
    session_id: 'ask-withdrawn', hook_event_name: 'PostToolUseFailure', hookAt: 200,
    tool_name: 'AskUserQuestion', tool_use_id: 'ask-1',
  });
  assert.equal(state.snapshot().sessions[0].decisions[0].state, 'withdrawn');
});

test('AskUserQuestion の題は 200 文字まで記録する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({
    session_id: 'ask-long-title', hook_event_name: 'PreToolUse', hookAt: 100,
    tool_name: 'AskUserQuestion', tool_use_id: 'ask-long',
    questions: [{ question: 'あ'.repeat(250), header: '', multiSelect: false, options: [] }],
  });
  assert.equal(state.snapshot().sessions[0].decisions[0].title.length, 200);
});

test('サブエージェントの AskUserQuestion は判断事項に記録しない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({
    session_id: 'ask-agent', hook_event_name: 'PreToolUse', hookAt: 100, agent_id: 'agent-1',
    tool_name: 'AskUserQuestion', tool_use_id: 'ask-1',
    questions: [{ question: '続けますか。', header: '', multiSelect: false, options: [] }],
  });
  assert.deepEqual(state.snapshot().sessions[0].decisions, []);
});

test('同じ未解決質問は既存の ID に寄せ、別名から更新して後続の回答で解決する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const addQuestion = (toolUseId, hookAt) => state.addEvent({
    session_id: 'ask-duplicate', hook_event_name: 'PreToolUse', hookAt,
    tool_name: 'AskUserQuestion', tool_use_id: toolUseId,
    questions: [{ question: 'どの形式にしますか。', header: '形式', multiSelect: false, options: [] }],
  });
  addQuestion('ask-original', 100);
  addQuestion('ask-repeat', 200);
  assert.equal(state.snapshot().sessions[0].decisions.length, 1);
  assert.equal(state.snapshot().sessions[0].decisions[0].id, 'ask-original');
  assert.equal(state.snapshot().sessions[0].decisions[0].createdAt, new Date(100).toISOString());
  const updated = state.updateDecision('ask-duplicate', 'ask-repeat', 'provisional', ['JSON'], '推奨で進めた。', 250);
  assert.deepEqual([updated.id, updated.state], ['ask-original', 'provisional']);
  assert.deepEqual(state.snapshot().sessions[0].decisions[0].resolution, {
    chosen: ['JSON'], note: '推奨で進めた。',
  });
  state.addEvent({
    session_id: 'ask-duplicate', hook_event_name: 'PostToolUse', hookAt: 300,
    tool_name: 'AskUserQuestion', tool_use_id: 'ask-repeat',
    decisionResolution: { chosen: ['JSON'], note: '' },
  });
  assert.deepEqual(
    [state.snapshot().sessions[0].decisions[0].id, state.snapshot().sessions[0].decisions[0].state],
    ['ask-original', 'resolved'],
  );
});

test('同じ質問の再表示は後から来た PreToolUse を採用して待ちに戻す', async (t) => {
  await temporaryHome(t);
  for (const priorState of ['provisional', 'resolved']) {
    const state = new DashboardState();
    const sessionId = `ask-repeat-${priorState}`;
    const addQuestion = (toolUseId, hookAt) => state.addEvent({
      session_id: sessionId, hook_event_name: 'PreToolUse', hookAt,
      tool_name: 'AskUserQuestion', tool_use_id: toolUseId,
      questions: [{ question: 'どの形式にしますか。', header: '形式', multiSelect: false, options: [] }],
    });
    addQuestion('ask-original', 100);
    state.updateDecision(sessionId, 'ask-original', priorState, ['JSON'], 'MCP の更新。', 150);
    addQuestion('ask-again', 200);
    const decision = state.snapshot().sessions[0].decisions[0];
    assert.deepEqual(
      [decision.id, decision.state, decision.updatedAt, decision.resolvedAt, decision.resolution],
      ['ask-original', 'waiting', new Date(200).toISOString(), null, null],
    );
  }
});

test('Stop 時にサブエージェントが稼働中なら待機中として区別する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'stopped', hook_event_name: 'SessionStart', hookAt: 100 });
  state.addEvent({ session_id: 'stopped', hook_event_name: 'SubagentStart', hookAt: 200, agent_id: 'agent-1', agent_type: 'Explore' });
  state.addEvent({ session_id: 'stopped', hook_event_name: 'Stop', hookAt: 300 });
  assert.equal(state.snapshot().sessions[0].status, '待機中(サブエージェント稼働中)');
});

test('Agent ツールの resolvedModel でサブエージェントの仮モデルを置き換える', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({
    session_id: 'model-update', hook_event_name: 'PreToolUse', hookAt: 100,
    tool_name: 'Agent', tool_use_id: 'agent-tool', summary: 'Agent', description: '探索対象を調べる',
  });
  state.addEvent({ session_id: 'model-update', hook_event_name: 'SubagentStart', hookAt: 200, agent_id: 'agent-1', agent_type: 'Explore' }, {
    agentDefinition: { model: 'claude-default', effort: 'high', source: 'claude-agent-definition' },
  });
  state.addEvent({ session_id: 'model-update', hook_event_name: 'PostToolUse', hookAt: 300, tool_name: 'Agent', tool_use_id: 'agent-tool', resolvedModel: 'claude-resolved' });

  const agent = state.snapshot().sessions[0].agents[0];
  assert.equal(agent.model, 'claude-resolved');
  assert.equal(agent.effort, 'high');
  assert.equal(agent.source, 'Agent tool response');
  assert.equal(agent.description, '探索対象を調べる');
  assert.equal(agent.backgrounded, true);
});

test('SubagentStart が Agent の PreToolUse より先でも応答の agentId から行を引き直す', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'agent-id-rebind', hook_event_name: 'SubagentStart', hookAt: 100, agent_id: 'agent-1', agent_type: 'Explore' }, {
    agentDefinition: { model: 'claude-default', effort: 'high' },
  });
  state.addEvent({
    session_id: 'agent-id-rebind', hook_event_name: 'PreToolUse', hookAt: 200,
    tool_name: 'Agent', tool_use_id: 'agent-call', description: '探索対象を調べる',
  });
  state.addEvent({
    session_id: 'agent-id-rebind', hook_event_name: 'PostToolUse', hookAt: 300,
    tool_name: 'Agent', tool_use_id: 'agent-call', agentId: 'agent-1', resolvedModel: 'claude-resolved',
  });

  const agent = state.snapshot().sessions[0].agents[0];
  assert.equal(agent.model, 'claude-resolved');
  assert.equal(agent.effort, 'high');
  assert.equal(agent.source, 'Agent tool response');
  assert.equal(agent.description, '探索対象を調べる');
  assert.equal(agent.backgrounded, true);
});

test('Agent の PostToolUse の agentId は既存の別行への結び付けより優先する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({
    session_id: 'agent-id-conflict', hook_event_name: 'PreToolUse', hookAt: 100,
    tool_name: 'Agent', tool_use_id: 'agent-call', description: '正しい呼び出しの説明',
  });
  state.addEvent({ session_id: 'agent-id-conflict', hook_event_name: 'SubagentStart', hookAt: 200, agent_id: 'wrong-agent', agent_type: 'Explore' });
  state.addEvent({ session_id: 'agent-id-conflict', hook_event_name: 'SubagentStart', hookAt: 250, agent_id: 'agent-1', agent_type: 'Explore' });
  state.addEvent({
    session_id: 'agent-id-conflict', hook_event_name: 'PostToolUse', hookAt: 300,
    tool_name: 'Agent', tool_use_id: 'agent-call', agentId: 'agent-1', resolvedModel: 'claude-resolved',
  });

  const agents = state.snapshot().sessions[0].agents;
  const correct = agents.find((agent) => agent.agent_id === 'agent-1');
  const wrong = agents.find((agent) => agent.agent_id === 'wrong-agent');
  assert.equal(correct.model, 'claude-resolved');
  assert.equal(correct.description, '正しい呼び出しの説明');
  assert.equal(correct.backgrounded, true);
  assert.equal(wrong.model, '');
  assert.equal(wrong.backgrounded, undefined);
});

test('並行した Agent 呼び出しで SubagentStart が入れ替わっても各行に自分の呼び出しの説明が入る', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const add = (event) => state.addEvent({ session_id: 'agent-swap', ...event });
  add({ hook_event_name: 'PreToolUse', hookAt: 100, tool_name: 'Agent', tool_use_id: 'call-1', description: '一つ目の説明' });
  add({ hook_event_name: 'SubagentStart', hookAt: 200, agent_id: 'agent-2', agent_type: 'Explore' });
  add({ hook_event_name: 'PreToolUse', hookAt: 300, tool_name: 'Agent', tool_use_id: 'call-2', description: '二つ目の説明' });
  add({ hook_event_name: 'SubagentStart', hookAt: 400, agent_id: 'agent-1', agent_type: 'Explore' });
  add({ hook_event_name: 'PostToolUse', hookAt: 500, tool_name: 'Agent', tool_use_id: 'call-1', agentId: 'agent-1', resolvedModel: 'claude-one' });
  add({ hook_event_name: 'PostToolUse', hookAt: 600, tool_name: 'Agent', tool_use_id: 'call-2', agentId: 'agent-2', resolvedModel: 'claude-two' });

  const agents = state.snapshot().sessions[0].agents;
  const first = agents.find((agent) => agent.agent_id === 'agent-1');
  const second = agents.find((agent) => agent.agent_id === 'agent-2');
  assert.equal(first.description, '一つ目の説明');
  assert.equal(first.model, 'claude-one');
  assert.equal(second.description, '二つ目の説明');
  assert.equal(second.model, 'claude-two');
});

test('agentId で引き直した行は、同じ行を指していた別の呼び出しの agentId の無い応答で書き換えない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const add = (event) => state.addEvent({ session_id: 'agent-stale', ...event });
  add({ hook_event_name: 'PreToolUse', hookAt: 100, tool_name: 'Agent', tool_use_id: 'call-1', description: '一つ目の説明' });
  add({ hook_event_name: 'SubagentStart', hookAt: 200, agent_id: 'agent-2', agent_type: 'Explore' });
  add({ hook_event_name: 'PreToolUse', hookAt: 300, tool_name: 'Agent', tool_use_id: 'call-2', description: '二つ目の説明' });
  add({ hook_event_name: 'SubagentStart', hookAt: 400, agent_id: 'agent-1', agent_type: 'Explore' });
  add({ hook_event_name: 'PostToolUse', hookAt: 500, tool_name: 'Agent', tool_use_id: 'call-1', agentId: 'agent-1', resolvedModel: 'claude-one' });
  add({ hook_event_name: 'PostToolUse', hookAt: 600, tool_name: 'Agent', tool_use_id: 'call-2', resolvedModel: 'claude-two' });

  const first = state.snapshot().sessions[0].agents.find((agent) => agent.agent_id === 'agent-1');
  assert.equal(first.description, '一つ目の説明');
  assert.equal(first.model, 'claude-one');
});

test('Agent の PostToolUse の agentId は曖昧な結び付けを解決する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'agent-id-ambiguous', hook_event_name: 'PreToolUse', hookAt: 100, tool_name: 'Agent', tool_use_id: 'call-a' });
  state.addEvent({ session_id: 'agent-id-ambiguous', hook_event_name: 'PreToolUse', hookAt: 200, tool_name: 'Agent', tool_use_id: 'call-b' });
  state.addEvent({ session_id: 'agent-id-ambiguous', hook_event_name: 'SubagentStart', hookAt: 300, agent_id: 'agent-a', agent_type: 'Explore' });
  state.addEvent({ session_id: 'agent-id-ambiguous', hook_event_name: 'SubagentStart', hookAt: 400, agent_id: 'agent-b', agent_type: 'Explore' });
  state.addEvent({
    session_id: 'agent-id-ambiguous', hook_event_name: 'PostToolUse', hookAt: 500,
    tool_name: 'Agent', tool_use_id: 'call-a', agentId: 'agent-a', resolvedModel: 'claude-resolved',
  });

  const agents = state.snapshot().sessions[0].agents;
  assert.equal(agents.find((agent) => agent.agent_id === 'agent-a').model, 'claude-resolved');
  assert.equal(agents.find((agent) => agent.agent_id === 'agent-b').model, '');
});

test('外したセッションが一覧不在で終了したら外した集合からも除く', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.syncSessionFiles([{ session_id: 'hidden-absent', cwd: 'C:\\project', name: '作業中' }], 1_000);
  state.addEvent({ session_id: 'hidden-absent', hook_event_name: 'SessionStart', hookAt: 1_000 });
  state.hideSession('hidden-absent');

  state.syncSessionFiles([], 61_000);

  assert.equal(state.hiddenSessions.has('hidden-absent'), false);
  assert.deepEqual(state.snapshot().sessions, []);
});

test('サブエージェント行の有無をセッションごとに調べる', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'agent-row', hook_event_name: 'SubagentStart', hookAt: 100, agent_id: 'agent-1', agent_type: 'Explore' });

  assert.equal(state.hasAgentRow('agent-row', 'agent-1'), true);
  assert.equal(state.hasAgentRow('agent-row', 'missing-agent'), false);
  assert.equal(state.hasAgentRow('missing-session', 'agent-1'), false);
});

test('再起動後に agent_id 付きイベントからサブエージェントの行を復元する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({
    session_id: 'restored-agent', hook_event_name: 'PreToolUse', hookAt: 200,
    agent_id: 'agent-1', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 'read-1',
  }, {
    agentDefinition: { model: 'claude-sonnet-5-5', effort: 'high', source: 'claude-agent-definition' },
  });

  const [agent] = state.snapshot().sessions[0].agents;
  assert.equal(agent.agent_id, 'agent-1');
  assert.equal(agent.agent_type, 'Explore');
  assert.equal(agent.startedAt, new Date(200).toISOString());
  assert.equal(agent.active, true);
  assert.equal(agent.model, 'claude-sonnet-5-5');
  assert.equal(agent.effort, 'high');
});

test('SubagentStop 後の遅延イベントではサブエージェントを復活させない', async (t) => {
  await temporaryHome(t);
  for (const hasStart of [true, false]) {
    const state = new DashboardState();
    if (hasStart) {
      state.addEvent({
        session_id: 'stopped-agent', hook_event_name: 'SubagentStart', hookAt: 100,
        agent_id: 'agent-1', agent_type: 'Explore',
      });
    }
    state.addEvent({
      session_id: 'stopped-agent', hook_event_name: 'SubagentStop', hookAt: 200,
      agent_id: 'agent-1',
    });
    state.addEvent({
      session_id: 'stopped-agent', hook_event_name: 'PreToolUse', hookAt: 300,
      agent_id: 'agent-1', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 'read-1',
    });

    const agents = state.snapshot().sessions[0].agents;
    if (hasStart) assert.equal(agents[0].active, false);
    else assert.deepEqual(agents, []);
  }
});

test('停止後の Notification と PostToolBatch と完了イベントはツールと許可待ちを残さない', () => {
  for (const event of [
    { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
    { hook_event_name: 'PostToolBatch' },
    { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'late' },
    { hook_event_name: 'PostToolUseFailure', tool_name: 'Read', tool_use_id: 'late' },
  ]) {
    const state = backgroundClaudeState('late-cleanup');
    const add = (input) => state.addEvent({ session_id: 'late-cleanup', agent_id: 'task-1', ...input });
    add({ hook_event_name: 'SubagentStop', hookAt: 400 });
    add({ hook_event_name: 'PreToolUse', tool_name: 'Read', tool_use_id: 'late', hookAt: 500 });
    add({ ...event, hookAt: 510 });
    const session = state.snapshot().sessions[0];
    assert.equal(session.agents[0].active, false);
    assert.deepEqual(session.tools, []);
    assert.deepEqual(session.permissionWaits, []);
  }
});

test('再起動後の完了と通知と区切りイベントもサブエージェントの行を復元する', () => {
  for (const event of [
    { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'read' },
    { hook_event_name: 'PostToolUseFailure', tool_name: 'Read', tool_use_id: 'read' },
    { hook_event_name: 'Notification', notification_type: 'permission_prompt' },
    { hook_event_name: 'PostToolBatch' },
  ]) {
    const state = new DashboardState();
    state.addEvent({ session_id: 'restored-row', agent_id: 'agent-1', agent_type: 'Explore', hookAt: 200, ...event }, {
      agentDefinition: { model: 'claude-sonnet-5-5', effort: 'high', source: 'claude-agent-definition' },
    });
    const [agent] = state.snapshot().sessions[0].agents;
    assert.equal(agent.agent_id, 'agent-1');
    assert.equal(agent.agent_type, 'Explore');
    assert.equal(agent.active, true);
    assert.equal(agent.startedAt, new Date(200).toISOString());
    assert.equal(agent.model, 'claude-sonnet-5-5');
    assert.equal(agent.effort, 'high');
  }
});

test('復元したサブエージェントに最初の PreToolUse の lastTool を記録する', () => {
  const state = new DashboardState();
  state.addEvent({ session_id: 'restored-tool', hook_event_name: 'PreToolUse', agent_id: 'agent-1',
    agent_type: 'Explore', tool_name: 'Read', tool_use_id: 'read', summary: '対象を読む', hookAt: 200 });
  const session = state.snapshot().sessions[0];
  assert.deepEqual(session.agents[0].lastTool, { tool_name: 'Read', summary: '対象を読む' });
  assert.equal(session.tools[0].agent_id, 'agent-1');
});

test('停止したエージェントの内部集合は snapshot に含めない', () => {
  const state = backgroundClaudeState();
  state.addEvent({ session_id: 'task-stop', hook_event_name: 'SubagentStop', agent_id: 'task-1', hookAt: 400 });
  const session = state.snapshot().sessions[0];
  assert.equal(Object.hasOwn(session, 'stoppedAgentIds'), false);
  assert.equal(Object.hasOwn(state.sessions.get('task-stop'), 'stoppedAgentIds'), false);
});

test('Codex の擬似 agent_id はサブエージェント行の復元対象にしない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({
    session_id: 'codex-pseudo', hook_event_name: 'PreToolUse', hookAt: 100,
    agent_id: 'codex:tool-1', agent_type: 'impl-hard', tool_name: 'Read', tool_use_id: 'read-1',
  });

  assert.deepEqual(state.snapshot().sessions[0].agents, []);
});

test('Agent ツールの説明を対応するサブエージェントへ結び付け、200 文字で制限する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({
    session_id: 'agent-description', hook_event_name: 'PreToolUse', hookAt: 100,
    tool_name: 'Agent', tool_use_id: 'agent-tool', description: '作業の説明'.repeat(50),
  });
  state.addEvent({
    session_id: 'agent-description', hook_event_name: 'SubagentStart', hookAt: 200,
    agent_id: 'agent-1', agent_type: 'Explore',
  });

  assert.equal(state.snapshot().sessions[0].agents[0].description, '作業の説明'.repeat(40));
});

test('Claude のモデル ID を読みやすい名前に変換する', () => {
  const cases = [
    ['claude-sonnet-5-5', 'Sonnet 5.5'],
    ['claude-haiku-4-5-20251001', 'Haiku 4.5'],
    ['claude-opus-5-5', 'Opus 5.5'],
    ['claude-3-5-sonnet-20241022', 'Sonnet 3.5'],
    ['claude-fable-5-1', 'Fable 5.1'],
    ['claude-opus-5-5[1m]', 'Opus 5.5'],
  ];
  for (const [modelId, expected] of cases) assert.equal(claudeModelName(modelId), expected);
});

test('SessionEnd はセッションを一覧から外す', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'ended', hook_event_name: 'SessionStart', hookAt: 100 });
  state.addEvent({ session_id: 'ended', hook_event_name: 'SessionEnd', hookAt: 200 });
  assert.deepEqual(state.snapshot().sessions, []);
});

test('セッション名を *.json から読み、*.key は開かない', async (t) => {
  const { homeDir } = await temporaryHome(t);
  const reads = [];
  const fileSystem = {
    async readdir() {
      return [
        { name: 'session-1.key', isFile: () => true },
        { name: 'session-1.json', isFile: () => true },
      ];
    },
    async readFile(filePath) {
      reads.push(path.basename(filePath));
      return JSON.stringify({ name: '設計作業', session_id: 'session-1' });
    },
  };
  assert.equal(await readSessionName('session-1', homeDir, fileSystem), '設計作業');
  assert.deepEqual(reads, ['session-1.json']);
});

test('公開仕様でないセッション JSON の不正な項目を飛ばす', async (t) => {
  const { claudeHome } = await temporaryHome(t);
  const sessionsDirectory = path.join(claudeHome, 'sessions');
  await fs.mkdir(sessionsDirectory, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(sessionsDirectory, 'broken.json'), '{invalid'),
    fs.writeFile(path.join(sessionsDirectory, 'null.json'), 'null'),
    fs.writeFile(path.join(sessionsDirectory, 'array.json'), '[]'),
    fs.writeFile(path.join(sessionsDirectory, 'missing-pid.json'), JSON.stringify({ session_id: 'missing-pid' })),
    fs.writeFile(path.join(sessionsDirectory, 'missing-id.json'), JSON.stringify({ pid: process.pid })),
    fs.writeFile(path.join(sessionsDirectory, 'session-valid.json'), JSON.stringify({
      session_id: 'session-valid', pid: process.pid, cwd: 'D:\\project', name: '正常なセッション',
    })),
  ]);

  assert.deepEqual(await listLiveSessionFiles(claudeHome), [{
    session_id: 'session-valid', pid: process.pid, cwd: 'D:\\project', name: '正常なセッション', updatedAt: null, procStart: null,
  }]);
  assert.equal(await findLiveSessionIdByPid(process.pid, claudeHome), 'session-valid');
  assert.equal(await readSessionName('session-valid', claudeHome), '正常なセッション');
  assert.equal(await findLiveSessionIdByPid(Number.MAX_SAFE_INTEGER, claudeHome), null);
});

test('セッションファイルの更新時刻を ISO 形式にし、不正な値は null にする', async (t) => {
  const { claudeHome } = await temporaryHome(t);
  const sessionsDirectory = path.join(claudeHome, 'sessions');
  await fs.mkdir(sessionsDirectory, { recursive: true });
  const records = [
    { session_id: 'numeric-time', updatedAt: 1791113430428 },
    { session_id: 'missing-time' },
    { session_id: 'string-time', updatedAt: '1791113430428' },
    { session_id: 'out-of-range-time', updatedAt: Number.MAX_VALUE },
  ];
  await Promise.all(records.map((record) => fs.writeFile(
    path.join(sessionsDirectory, `${record.session_id}.json`),
    JSON.stringify({ ...record, pid: process.pid }),
  )));

  const sessions = await listLiveSessionFiles(claudeHome);
  const updatedAtById = Object.fromEntries(sessions.map(({ session_id, updatedAt }) => [session_id, updatedAt]));
  assert.deepEqual(updatedAtById, {
    'numeric-time': new Date(1791113430428).toISOString(),
    'missing-time': null,
    'string-time': null,
    'out-of-range-time': null,
  });
});

test('セッションファイルの procStart は文字列か有限の数値だけを受け付け、それ以外は null にする', async (t) => {
  const { claudeHome } = await temporaryHome(t);
  const sessionsDirectory = path.join(claudeHome, 'sessions');
  await fs.mkdir(sessionsDirectory, { recursive: true });
  const records = [
    { session_id: 'string-start', procStart: '2026-10-07T00:00:00Z' },
    { session_id: 'numeric-start', procStart: 1791113430428 },
    { session_id: 'missing-start' },
    { session_id: 'empty-start', procStart: '' },
    { session_id: 'object-start', procStart: { at: 1 } },
    { session_id: 'null-start', procStart: null },
  ];
  await Promise.all(records.map((record) => fs.writeFile(
    path.join(sessionsDirectory, `${record.session_id}.json`),
    JSON.stringify({ ...record, pid: process.pid }),
  )));

  const sessions = await listLiveSessionFiles(claudeHome);
  const startById = Object.fromEntries(sessions.map(({ session_id, procStart }) => [session_id, procStart]));
  assert.deepEqual(startById, {
    'string-start': '2026-10-07T00:00:00Z',
    'numeric-start': '1791113430428',
    'missing-start': null,
    'empty-start': null,
    'object-start': null,
    'null-start': null,
  });
});

test('サブエージェント定義から Claude と Codex のモデルおよび effort を読む', async (t) => {
  const { homeDir } = await temporaryHome(t);
  const claudeAgents = path.join(homeDir, 'agents');
  const gptAgents = path.join(homeDir, 'gpt-agents');
  await fs.mkdir(claudeAgents, { recursive: true });
  await fs.mkdir(gptAgents, { recursive: true });
  await fs.writeFile(path.join(claudeAgents, 'Explore.md'), '---\nmodel: claude-opus\neffort: high\n---\n');
  await fs.writeFile(path.join(gptAgents, 'impl-hard.md'), '---\ncodex_model: gpt-5.5-codex\ncodex_reasoning_effort: xhigh\n---\n');

  assert.deepEqual(await claudeAgentDefinition('Explore', homeDir), {
    model: 'claude-opus', effort: 'high', source: 'claude-agent-definition',
  });
  assert.deepEqual(await codexAgentDefinition('impl-hard', homeDir), {
    model: 'gpt-5.5-codex', effort: 'xhigh', source: 'gpt-agent-definition',
  });
  assert.equal(await claudeAgentDefinition('../outside', homeDir), null);
});

test('SessionEnd より後に遅れて届いたイベントで終了済みセッションを復活させない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'ended-late', hook_event_name: 'SessionStart', hookAt: 100 });
  state.addEvent({ session_id: 'ended-late', hook_event_name: 'SessionEnd', hookAt: 300 });
  state.addEvent({ session_id: 'ended-late', hook_event_name: 'PreToolUse', hookAt: 200, tool_name: 'Read', tool_use_id: 'tool-1', summary: 'README.md' });
  assert.deepEqual(state.snapshot().sessions, []);
});

function launchCodex(state, sessionId, toolUseId, hookAt, agentId, agentDefinition = null, definition = 'impl-hard') {
  state.addEvent({
    session_id: sessionId, hook_event_name: 'PreToolUse', hookAt, agent_id: agentId,
    tool_name: 'Bash', tool_use_id: toolUseId, summary: `bash ~/.claude/tools/codex-agent.sh ${definition} < prompt.md`,
  }, agentDefinition ? { codexAgentDefinition: agentDefinition } : undefined);
}

function launchCodexReview(state, sessionId, toolUseId, hookAt, definition, definitionMetadata) {
  const script = definition === 'codex-subagent' ? 'npm run review:codex:fix' : 'npm run review:codex';
  state.addEvent({
    session_id: sessionId, hook_event_name: 'PreToolUse', hookAt,
    tool_name: 'Bash', tool_use_id: toolUseId, summary: `cd "${'D:/worktree/'.repeat(12)}repo" && ${script}`,
    codexReviewDefinition: definition,
  }, { codexAgentDefinition: definitionMetadata });
}

function waitForCodex(state, sessionId, toolUseId, hookAt, agentId, runId, definitionMetadata = null) {
  state.addEvent({
    session_id: sessionId, hook_event_name: 'PreToolUse', hookAt, agent_id: agentId,
    tool_name: 'Bash', tool_use_id: toolUseId,
    summary: `bash ~/.claude/tools/codex-agent.sh --wait ${runId}`,
    codexWaitRunId: runId,
  }, definitionMetadata ? { codexAgentDefinition: definitionMetadata } : undefined);
}

function codexOutput(model, effort, result = 'ok', codexHome = 'C:\\Users\\mss02968\\.codex') {
  return {
    auditLine: `codex-agent: agent=impl-hard model=${model} effort=${effort} sandbox=read-only codex_home=${codexHome} workdir=D:\\repo`,
    resultLine: `codex-agent: result=${result}${result === 'rate-limited' || result === 'unavailable' ? ' exit=75' : ''}`,
  };
}

test('メインのクロスレビュー行は定義と監査行を反映し、後続の Bash の結果行で終了する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  launchCodexReview(state, 'main-review', 'review-call', 1, 'codex-review', {
    model: 'gpt-review-definition', effort: 'low',
  });
  state.addEvent({
    session_id: 'main-review', hook_event_name: 'PostToolUse', hookAt: 2,
    tool_name: 'Bash', tool_use_id: 'review-call',
    codexOutput: { auditLine: 'codex-agent: agent=codex-review model=gpt-review-actual effort=xhigh sandbox=read-only' },
  });

  launchCodexReview(state, 'main-review', 'fix-call', 3, 'codex-subagent', {
    model: 'gpt-fix-definition', effort: 'high',
  });
  state.addEvent({
    session_id: 'main-review', hook_event_name: 'PostToolUse', hookAt: 4,
    tool_name: 'Bash', tool_use_id: 'fix-call',
    codexOutput: {
      auditLine: 'codex-agent: agent=codex-subagent model=gpt-fix-actual effort=max sandbox=workspace-write',
      resultLine: 'codex-agent: result=ok',
    },
  });

  state.addEvent({ session_id: 'main-review', hook_event_name: 'SubagentStart', hookAt: 5, agent_id: 'sub-1', agent_type: 'impl-hard' });
  launchCodex(state, 'main-review', 'subagent-call', 6, 'sub-1', { model: 'gpt-subagent-definition', effort: 'low' });
  state.addEvent({
    session_id: 'main-review', hook_event_name: 'PostToolUse', hookAt: 7, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'subagent-call',
    codexOutput: { auditLine: 'codex-agent: agent=impl-hard model=gpt-subagent-actual effort=high sandbox=read-only' },
  });

  state.addEvent({
    session_id: 'main-review', hook_event_name: 'PostToolUse', hookAt: 8,
    tool_name: 'Bash', tool_use_id: 'later-bash',
    codexOutput: { resultLine: 'codex-agent: result=ok' },
  });

  const agents = state.snapshot().sessions[0].agents;
  const byId = Object.fromEntries(agents.map((agent) => [agent.agent_id, agent]));
  assert.deepEqual([byId['codex:review-call'].agent_type, byId['codex:review-call'].model, byId['codex:review-call'].active], [
    'codex-review', 'gpt-review-actual', false,
  ]);
  assert.deepEqual([byId['codex:fix-call'].agent_type, byId['codex:fix-call'].model, byId['codex:fix-call'].active], [
    'codex-subagent', 'gpt-fix-actual', false,
  ]);
  assert.deepEqual([byId['sub-1'].gpt.model, byId['sub-1'].gpt.active], [
    'gpt-subagent-actual', true,
  ]);
});

test('背景で起動した Codex は後続の Read 出力にある結果行で終了し、親の GPT 情報にまとまる', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'bg', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' }, {
    agentDefinition: { model: 'claude-sonnet-5-5', effort: 'high' },
  });
  launchCodex(state, 'bg', 'bash-1', 2, 'sub-1', { model: 'gpt-draft', effort: 'low' });
  state.addEvent({ session_id: 'bg', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
  state.addEvent({
    session_id: 'bg', hook_event_name: 'PostToolUse', hookAt: 4, agent_id: 'sub-1',
    tool_name: 'Read', tool_use_id: 'read-1',
    codexOutput: codexOutput('gpt-5.5-codex', 'xhigh', 'ok', 'C:\\Users\\User Data\\.codex'),
  });

  const agents = state.snapshot().sessions[0].agents;
  assert.deepEqual(agents.map((agent) => agent.agent_id), ['sub-1']);
  assert.equal(agents[0].modelName, 'Sonnet 5.5');
  assert.deepEqual(agents[0].gpt, {
    model: 'gpt-5.5-codex', effort: 'xhigh', codex_home: 'C:\\Users\\User Data\\.codex',
    unavailable: '', active: false, unconfirmed: false,
  });
});

test('--wait は同じ親と同じ定義の背景 Codex を結果行で終了する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'bg-wait', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  launchCodex(state, 'bg-wait', 'bash-other', 2, 'sub-1', { model: 'gpt-other', effort: 'low' }, 'impl-standard');
  state.addEvent({
    session_id: 'bg-wait', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-other', codexOutput: codexOutput('gpt-other', 'low'),
  });
  launchCodex(state, 'bg-wait', 'bash-target', 4, 'sub-1', { model: 'gpt-target', effort: 'high' });
  state.addEvent({ session_id: 'bg-wait', hook_event_name: 'PostToolUse', hookAt: 5, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-target' });
  waitForCodex(state, 'bg-wait', 'bash-wait', 8, 'sub-1', 'impl-hard-20261003-123456-7');
  state.addEvent({
    session_id: 'bg-wait', hook_event_name: 'PostToolUse', hookAt: 9, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-wait', codexOutput: codexOutput('gpt-6-luna', 'xhigh'),
  });

  const session = state.snapshot().sessions[0];
  assert.deepEqual(session.agents.map((agent) => agent.agent_id), ['sub-1']);
  assert.deepEqual([session.agents[0].gpt.model, session.agents[0].gpt.active, session.agents[0].gpt.unconfirmed], ['gpt-6-luna', false, false]);
});

test('orphaned の --wait が終了未確認にした行は、別の背景実行の結果行を受け取らない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const orphanedRunId = 'impl-hard-20261003-123456-7';
  const activeRunId = 'impl-hard-20261003-123457-8';
  state.addEvent({ session_id: 'wait-ended-row', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  launchCodex(state, 'wait-ended-row', 'bash-old', 2, 'sub-1', { model: 'gpt-old', effort: 'low' });
  state.addEvent({
    session_id: 'wait-ended-row', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-old', codexOutput: { runLine: `codex-agent: run=${orphanedRunId}` },
  });
  waitForCodex(state, 'wait-ended-row', 'bash-wait-old', 4, 'sub-1', orphanedRunId);
  state.addEvent({
    session_id: 'wait-ended-row', hook_event_name: 'PostToolUse', hookAt: 5, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-wait-old',
    codexOutput: { waitStatusLine: `codex-agent: orphaned run=${orphanedRunId}` },
  });
  launchCodex(state, 'wait-ended-row', 'bash-new', 6, 'sub-1', { model: 'gpt-new', effort: 'high' });
  state.addEvent({
    session_id: 'wait-ended-row', hook_event_name: 'PostToolUse', hookAt: 7, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-new', codexOutput: { runLine: `codex-agent: run=${activeRunId}` },
  });
  state.addEvent({
    session_id: 'wait-ended-row', hook_event_name: 'PostToolUse', hookAt: 8, agent_id: 'sub-1',
    tool_name: 'Read', tool_use_id: 'read-1',
    codexOutput: { runLine: `codex-agent: run=${activeRunId}`, resultLine: 'codex-agent: result=ok' },
  });

  const [parent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([parent.gpt.model, parent.gpt.active, parent.gpt.unconfirmed], ['gpt-new', false, false]);
});

test('同じ実行 ID の --wait は orphaned の行を再開し、waitEnded を外す', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const runId = 'impl-hard-20261003-123456-7';
  const otherRunId = 'impl-hard-20261003-123457-8';
  state.addEvent({ session_id: 'resume-orphaned', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  launchCodex(state, 'resume-orphaned', 'bash-1', 2, 'sub-1', { model: 'gpt-orphaned', effort: 'low' });
  state.addEvent({
    session_id: 'resume-orphaned', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-1', codexOutput: { runLine: `codex-agent: run=${runId}` },
  });
  waitForCodex(state, 'resume-orphaned', 'bash-wait-1', 4, 'sub-1', runId);
  state.addEvent({
    session_id: 'resume-orphaned', hook_event_name: 'PostToolUse', hookAt: 5, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-wait-1', codexOutput: { waitStatusLine: `codex-agent: orphaned run=${runId}` },
  });
  launchCodex(state, 'resume-orphaned', 'bash-other', 6, 'sub-1', { model: 'gpt-fallback', effort: 'high' });
  state.addEvent({
    session_id: 'resume-orphaned', hook_event_name: 'PostToolUse', hookAt: 7, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-other', codexOutput: { runLine: `codex-agent: run=${otherRunId}` },
  });
  state.addEvent({ session_id: 'resume-orphaned', hook_event_name: 'SubagentStop', hookAt: 8, agent_id: 'sub-1' });
  state.addEvent({ session_id: 'resume-orphaned', hook_event_name: 'SubagentStart', hookAt: 9, agent_id: 'sub-1', agent_type: 'impl-hard' });
  waitForCodex(state, 'resume-orphaned', 'bash-wait-2', 10, 'sub-1', runId);

  let [parent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([parent.gpt.model, parent.gpt.active, parent.gpt.unconfirmed], ['gpt-orphaned', true, false]);
  state.addEvent({
    session_id: 'resume-orphaned', hook_event_name: 'PostToolUse', hookAt: 11, agent_id: 'sub-1',
    tool_name: 'Read', tool_use_id: 'read-1',
    codexOutput: { runLine: `codex-agent: run=${runId}`, resultLine: 'codex-agent: result=ok' },
  });
  [parent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([parent.gpt.model, parent.gpt.active, parent.gpt.unconfirmed], ['gpt-fallback', false, true]);
});

test('結果を受けた前面実行と同じ ID の --wait は行を増やさず終了状態を保つ', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const runId = 'impl-hard-20261003-123456-7';
  state.addEvent({ session_id: 'wait-finished-run', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  launchCodex(state, 'wait-finished-run', 'bash-1', 2, 'sub-1');
  state.addEvent({
    session_id: 'wait-finished-run', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-1',
    codexOutput: { runLine: `codex-agent: run=${runId}`, resultLine: 'codex-agent: result=ok' },
  });
  waitForCodex(state, 'wait-finished-run', 'bash-wait', 4, 'sub-1', runId, { model: 'gpt-duplicate' });
  state.addEvent({
    session_id: 'wait-finished-run', hook_event_name: 'PostToolUseFailure', hookAt: 5, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-wait', codexOutput: { waitStatusLine: `codex-agent: orphaned run=${runId}` },
  });

  const [parent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([parent.gpt.model, parent.gpt.active, parent.gpt.unconfirmed], ['', false, false]);
});

test('結果を受けた --wait で作成した行は、同じ ID の後続 --wait で増えない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const runId = 'impl-hard-20261003-123456-7';
  state.addEvent({ session_id: 'wait-created-finished', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  waitForCodex(state, 'wait-created-finished', 'bash-wait-1', 2, 'sub-1', runId, { model: 'gpt-original' });
  state.addEvent({
    session_id: 'wait-created-finished', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-wait-1', codexOutput: { resultLine: 'codex-agent: result=ok' },
  });
  waitForCodex(state, 'wait-created-finished', 'bash-wait-2', 4, 'sub-1', runId, { model: 'gpt-duplicate' });
  state.addEvent({
    session_id: 'wait-created-finished', hook_event_name: 'PostToolUseFailure', hookAt: 5, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-wait-2', codexOutput: { waitStatusLine: `codex-agent: orphaned run=${runId}` },
  });

  const [parent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([parent.gpt.model, parent.gpt.active, parent.gpt.unconfirmed], ['gpt-original', false, false]);
});

test('--wait は別の親の結果未受領 Codex を再利用しない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'wait-parent', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  state.addEvent({ session_id: 'wait-parent', hook_event_name: 'SubagentStart', hookAt: 2, agent_id: 'sub-2', agent_type: 'impl-hard' });
  launchCodex(state, 'wait-parent', 'bash-1', 3, 'sub-1', { model: 'gpt-parent-one', effort: 'low' });
  state.addEvent({ session_id: 'wait-parent', hook_event_name: 'PostToolUse', hookAt: 4, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
  waitForCodex(state, 'wait-parent', 'bash-wait', 5, 'sub-2', 'impl-hard-20261003-123456-7', {
    model: 'gpt-parent-two', effort: 'xhigh',
  });

  const agents = state.snapshot().sessions[0].agents;
  assert.equal(agents.length, 2);
  assert.deepEqual(agents.map((agent) => [agent.agent_id, agent.gpt.model, agent.gpt.active]), [
    ['sub-1', 'gpt-parent-one', true],
    ['sub-2', 'gpt-parent-two', true],
  ]);
});

test('実行 ID が分かっていて別の値の背景行は、別の実行の --wait で再開せず、新しい行を作る', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const waitRunId = 'impl-hard-20261003-123456-7';
  const oldRunId = 'impl-hard-20261003-123450-1';
  const latestRunId = 'impl-hard-20261003-123451-2';
  state.addEvent({ session_id: 'wait-background-priority', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  launchCodex(state, 'wait-background-priority', 'bash-old', 2, 'sub-1', { model: 'gpt-old', effort: 'low' });
  state.addEvent({
    session_id: 'wait-background-priority', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-old', codexOutput: { runLine: `codex-agent: run=${oldRunId}` },
  });
  launchCodex(state, 'wait-background-priority', 'bash-latest', 4, 'sub-1', { model: 'gpt-latest', effort: 'high' });
  state.addEvent({
    session_id: 'wait-background-priority', hook_event_name: 'PostToolUse', hookAt: 5, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-latest', codexOutput: { runLine: `codex-agent: run=${latestRunId}` },
  });
  state.addEvent({ session_id: 'wait-background-priority', hook_event_name: 'SubagentStop', hookAt: 6, agent_id: 'sub-1' });
  state.addEvent({ session_id: 'wait-background-priority', hook_event_name: 'SubagentStart', hookAt: 7, agent_id: 'sub-1', agent_type: 'impl-hard' });
  waitForCodex(state, 'wait-background-priority', 'bash-wait', 8, 'sub-1', waitRunId, { model: 'gpt-wait-placeholder' });
  state.addEvent({
    session_id: 'wait-background-priority', hook_event_name: 'PostToolUse', hookAt: 9, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-wait', codexOutput: { resultLine: 'codex-agent: result=ok' },
  });

  const [agent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([agent.gpt.model, agent.gpt.active, agent.gpt.unconfirmed], ['gpt-wait-placeholder', false, false]);
});

test('Agent の出力に含まれる run= は Codex 行の runId にしない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const backgroundRunId = 'impl-hard-20261003-123456-7';
  const agentOutputRunId = 'impl-hard-20261003-123457-8';
  state.addEvent({ session_id: 'agent-run-line', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  launchCodex(state, 'agent-run-line', 'bash-pending', 2, 'sub-1', { model: 'gpt-pending', effort: 'low' });
  launchCodex(state, 'agent-run-line', 'bash-codex', 3, 'sub-1', { model: 'gpt-background', effort: 'high' });
  state.addEvent({
    session_id: 'agent-run-line', hook_event_name: 'PostToolUse', hookAt: 4, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-codex', codexOutput: { runLine: `codex-agent: run=${backgroundRunId}` },
  });
  state.addEvent({ session_id: 'agent-run-line', hook_event_name: 'SubagentStop', hookAt: 5, agent_id: 'sub-1' });
  state.addEvent({
    session_id: 'agent-run-line', hook_event_name: 'PostToolUse', hookAt: 6, agent_id: 'sub-1',
    tool_name: 'Agent', tool_use_id: 'bash-pending', codexOutput: { runLine: `codex-agent: run=${agentOutputRunId}` },
  });
  state.addEvent({ session_id: 'agent-run-line', hook_event_name: 'SubagentStart', hookAt: 7, agent_id: 'sub-1', agent_type: 'impl-hard' });
  waitForCodex(state, 'agent-run-line', 'bash-wait', 8, 'sub-1', agentOutputRunId, { model: 'gpt-wait' });

  const [parent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([parent.gpt.model, parent.gpt.active, parent.gpt.unconfirmed], ['gpt-wait', true, false]);
});

test('結果行なしで失敗した起動は --wait で再開せず、新しい行を作る', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'failed-wait', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  launchCodex(state, 'failed-wait', 'bash-1', 2, 'sub-1', { model: 'gpt-before-wait', effort: 'low' });
  state.addEvent({
    session_id: 'failed-wait', hook_event_name: 'PostToolUseFailure', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-1',
  });
  waitForCodex(state, 'failed-wait', 'bash-wait', 4, 'sub-1', 'impl-hard-20261003-123456-7');

  const [resumed] = state.snapshot().sessions[0].agents;
  assert.deepEqual([resumed.gpt.active, resumed.gpt.unconfirmed], [true, false]);
  assert.notEqual(resumed.gpt.model, 'gpt-before-wait');

  state.addEvent({
    session_id: 'failed-wait', hook_event_name: 'PostToolUse', hookAt: 5, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-wait', codexOutput: codexOutput('gpt-finished', 'xhigh'),
  });
  assert.equal(state.snapshot().sessions[0].agents[0].gpt.active, false);
});

test('上限までに終わらない --wait の後も Codex は稼働中で、親が止まれば終了未確認、次の --wait の結果行で終了する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'wait-timeout', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  launchCodex(state, 'wait-timeout', 'bash-1', 2, 'sub-1', { model: 'gpt-6-luna', effort: 'xhigh' });
  state.addEvent({ session_id: 'wait-timeout', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
  waitForCodex(state, 'wait-timeout', 'bash-wait-1', 4, 'sub-1', 'impl-hard-20261003-123456-7');
  state.addEvent({ session_id: 'wait-timeout', hook_event_name: 'PostToolUseFailure', hookAt: 5, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-wait-1' });
  assert.deepEqual([state.snapshot().sessions[0].agents[0].gpt.active, state.snapshot().sessions[0].agents[0].gpt.unconfirmed], [true, false]);

  state.addEvent({ session_id: 'wait-timeout', hook_event_name: 'SubagentStop', hookAt: 6, agent_id: 'sub-1' });
  assert.deepEqual([state.snapshot().sessions[0].agents[0].gpt.active, state.snapshot().sessions[0].agents[0].gpt.unconfirmed], [false, true]);

  state.addEvent({ session_id: 'wait-timeout', hook_event_name: 'SubagentStart', hookAt: 7, agent_id: 'sub-1', agent_type: 'impl-hard' });
  waitForCodex(state, 'wait-timeout', 'bash-wait-2', 8, 'sub-1', 'impl-hard-20261003-123456-7');
  assert.equal(state.snapshot().sessions[0].agents.length, 1);
  assert.deepEqual([state.snapshot().sessions[0].agents[0].gpt.active, state.snapshot().sessions[0].agents[0].gpt.unconfirmed], [true, false]);
  state.addEvent({
    session_id: 'wait-timeout', hook_event_name: 'PostToolUse', hookAt: 9, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-wait-2', codexOutput: codexOutput('gpt-6-luna', 'xhigh'),
  });
  assert.deepEqual([state.snapshot().sessions[0].agents[0].gpt.active, state.snapshot().sessions[0].agents[0].gpt.unconfirmed], [false, false]);
});

for (const [status, expected, hookEventName] of [
  ['vanished', [false, false], 'PostToolUseFailure'], ['not-found', [false, false], 'PostToolUseFailure'],
  ['orphaned', [false, true], 'PostToolUseFailure'], ['unverified', [false, true], 'PostToolUseFailure'],
  ['vanished', [false, false], 'PostToolUse'],
]) {
  test(`--wait が ${status} で抜けたら Codex の行を稼働中に残さない (${hookEventName})`, async (t) => {
    await temporaryHome(t);
    const state = new DashboardState();
    state.addEvent({ session_id: 'wait-status', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
    launchCodex(state, 'wait-status', 'bash-1', 2, 'sub-1', { model: 'gpt-old', effort: 'low' });
    state.addEvent({ session_id: 'wait-status', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
    waitForCodex(state, 'wait-status', 'bash-wait', 4, 'sub-1', 'impl-hard-20261003-123456-7');
    state.addEvent({
      session_id: 'wait-status', hook_event_name: hookEventName, hookAt: 5, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-wait',
      codexOutput: { waitStatusLine: `codex-agent: ${status} run=impl-hard-20261003-123456-7` },
    });
    const [agent] = state.snapshot().sessions[0].agents;
    assert.deepEqual([agent.gpt.active, agent.gpt.unconfirmed], expected);
  });
}

test('--wait が vanished で抜けた後に起動し直した Codex が終われば、親は終了未確認にならない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'wait-relaunch', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  launchCodex(state, 'wait-relaunch', 'bash-1', 2, 'sub-1', { model: 'gpt-old', effort: 'low' });
  state.addEvent({ session_id: 'wait-relaunch', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
  waitForCodex(state, 'wait-relaunch', 'bash-wait', 4, 'sub-1', 'impl-hard-20261003-123456-7');
  state.addEvent({
    session_id: 'wait-relaunch', hook_event_name: 'PostToolUseFailure', hookAt: 5, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-wait',
    codexOutput: { waitStatusLine: 'codex-agent: vanished run=impl-hard-20261003-123456-7' },
  });
  launchCodex(state, 'wait-relaunch', 'bash-2', 6, 'sub-1', { model: 'gpt-new', effort: 'high' });
  state.addEvent({
    session_id: 'wait-relaunch', hook_event_name: 'PostToolUse', hookAt: 7, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-2', codexOutput: codexOutput('gpt-new', 'high'),
  });
  state.addEvent({ session_id: 'wait-relaunch', hook_event_name: 'SubagentStop', hookAt: 8, agent_id: 'sub-1' });
  const [agent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([agent.gpt.model, agent.gpt.active, agent.gpt.unconfirmed], ['gpt-new', false, false]);
});

test('結果を受けた実行の --wait の結果行は、背景で動いている別の Codex を終了にしない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const runId = 'impl-hard-20261003-123456-7';
  state.addEvent({ session_id: 'rewait', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  waitForCodex(state, 'rewait', 'bash-wait-1', 2, 'sub-1', runId);
  state.addEvent({
    session_id: 'rewait', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-wait-1', codexOutput: codexOutput('gpt-first', 'xhigh'),
  });
  launchCodex(state, 'rewait', 'bash-2', 4, 'sub-1', { model: 'gpt-running', effort: 'high' });
  state.addEvent({ session_id: 'rewait', hook_event_name: 'PostToolUse', hookAt: 5, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-2' });
  waitForCodex(state, 'rewait', 'bash-wait-2', 6, 'sub-1', runId);
  state.addEvent({
    session_id: 'rewait', hook_event_name: 'PostToolUse', hookAt: 7, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-wait-2', codexOutput: codexOutput('gpt-first', 'xhigh'),
  });
  const [agent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([agent.gpt.model, agent.gpt.active], ['gpt-running', true]);
});

test('後続の出力に出た終わった実行の結果行は、run= の行で照合し、背景で動いている別の Codex を終了にしない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const finishedRunId = 'impl-hard-20261003-123456-7';
  state.addEvent({ session_id: 'reread', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  waitForCodex(state, 'reread', 'bash-wait', 2, 'sub-1', finishedRunId);
  state.addEvent({
    session_id: 'reread', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-wait', codexOutput: codexOutput('gpt-first', 'xhigh'),
  });
  launchCodex(state, 'reread', 'bash-2', 4, 'sub-1', { model: 'gpt-running', effort: 'high' });
  state.addEvent({ session_id: 'reread', hook_event_name: 'PostToolUse', hookAt: 5, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-2' });
  state.addEvent({
    session_id: 'reread', hook_event_name: 'PostToolUse', hookAt: 6, agent_id: 'sub-1', tool_name: 'Read', tool_use_id: 'read-1',
    codexOutput: { ...codexOutput('gpt-first', 'xhigh'), runLine: `codex-agent: run=${finishedRunId}` },
  });
  const [agent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([agent.gpt.model, agent.gpt.active], ['gpt-running', true]);
});

test('同じ実行 ID の --wait を別の親が呼んだら、行を増やさずその親の下へ付け替える', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const runId = 'impl-hard-20261003-123456-7';
  state.addEvent({ session_id: 'handoff', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  waitForCodex(state, 'handoff', 'bash-wait-1', 2, 'sub-1', runId, { model: 'gpt-6-luna' });
  state.addEvent({ session_id: 'handoff', hook_event_name: 'PostToolUseFailure', hookAt: 3, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-wait-1' });
  state.addEvent({ session_id: 'handoff', hook_event_name: 'SubagentStop', hookAt: 4, agent_id: 'sub-1' });
  state.addEvent({ session_id: 'handoff', hook_event_name: 'SubagentStart', hookAt: 5, agent_id: 'sub-2', agent_type: 'impl-hard' });
  waitForCodex(state, 'handoff', 'bash-wait-2', 6, 'sub-2', runId);
  const agents = state.snapshot().sessions[0].agents;
  const first = agents.find((agent) => agent.agent_id === 'sub-1');
  const second = agents.find((agent) => agent.agent_id === 'sub-2');
  assert.equal(first.gpt, undefined);
  assert.deepEqual([second.gpt.model, second.gpt.active], ['gpt-6-luna', true]);
});

test('後続の出力の結果行で終えた行は実行 ID を持ち、同じ実行の --wait で行が増えない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const runId = 'impl-hard-20261003-123456-7';
  state.addEvent({ session_id: 'read-then-wait', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  launchCodex(state, 'read-then-wait', 'bash-1', 2, 'sub-1', { model: 'gpt-6-luna', effort: 'xhigh' });
  state.addEvent({ session_id: 'read-then-wait', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
  state.addEvent({
    session_id: 'read-then-wait', hook_event_name: 'PostToolUse', hookAt: 4, agent_id: 'sub-1', tool_name: 'Read', tool_use_id: 'read-1',
    codexOutput: { ...codexOutput('gpt-6-luna', 'xhigh'), runLine: `codex-agent: run=${runId}` },
  });
  waitForCodex(state, 'read-then-wait', 'bash-wait', 5, 'sub-1', runId, { model: 'gpt-wait' });
  const [agent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([agent.gpt.model, agent.gpt.active], ['gpt-6-luna', false]);
});

test('起動イベントが無い --wait は実行 ID の定義で Codex 行を作る', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'wait-after-restart', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  waitForCodex(state, 'wait-after-restart', 'bash-wait', 2, 'sub-1', 'impl-hard-20261003-123456-7', {
    model: 'gpt-from-definition', effort: 'xhigh', source: 'gpt-agent-definition',
  });
  const [running] = state.snapshot().sessions[0].agents;
  assert.deepEqual([running.gpt.model, running.gpt.active], ['gpt-from-definition', true]);

  state.addEvent({
    session_id: 'wait-after-restart', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-wait', codexOutput: codexOutput('gpt-real', 'max'),
  });
  const session = state.snapshot().sessions[0];
  assert.equal(session.agents.length, 1);
  assert.deepEqual([session.agents[0].gpt.model, session.agents[0].gpt.active], ['gpt-real', false]);
});

test('結果行を受けた Codex は後続の --wait で再利用しない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'wait-after-result', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  launchCodex(state, 'wait-after-result', 'bash-1', 2, 'sub-1', { model: 'gpt-first', effort: 'low' });
  state.addEvent({
    session_id: 'wait-after-result', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-1', codexOutput: codexOutput('gpt-finished', 'high'),
  });
  waitForCodex(state, 'wait-after-result', 'bash-wait', 4, 'sub-1', 'impl-hard-20261003-123456-8', {
    model: 'gpt-new-run', effort: 'xhigh',
  });

  const [running] = state.snapshot().sessions[0].agents;
  assert.deepEqual([running.gpt.model, running.gpt.active], ['gpt-new-run', true]);
});

test('メインセッションの --wait は Codex 行を作らない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  waitForCodex(state, 'main-wait', 'bash-wait', 1, null, 'impl-hard-20261003-123456-7', {
    model: 'gpt-should-not-appear', effort: 'high',
  });
  assert.deepEqual(state.snapshot().sessions[0].agents, []);
});

test('同じ親の背景 Codex が複数あるときは、run= の無い結果行でどちらも終了にしない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'bg-oldest', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-standard' });
  launchCodex(state, 'bg-oldest', 'bash-old', 2, 'sub-1', { model: 'gpt-old', effort: 'low' }, 'impl-standard');
  state.addEvent({ session_id: 'bg-oldest', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-old' });
  launchCodex(state, 'bg-oldest', 'bash-new', 4, 'sub-1', { model: 'gpt-new', effort: 'high' }, 'impl-hard');
  state.addEvent({ session_id: 'bg-oldest', hook_event_name: 'PostToolUse', hookAt: 5, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-new' });
  state.addEvent({
    session_id: 'bg-oldest', hook_event_name: 'PostToolUse', hookAt: 6, agent_id: 'sub-1',
    tool_name: 'Read', tool_use_id: 'read-1', codexOutput: { resultLine: 'codex-agent: result=ok' },
  });
  state.addEvent({ session_id: 'bg-oldest', hook_event_name: 'SubagentStop', hookAt: 7, agent_id: 'sub-1' });

  const [agent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([agent.gpt.model, agent.gpt.unconfirmed], ['gpt-new', true]);

  state.addEvent({ session_id: 'bg-oldest', hook_event_name: 'SubagentStart', hookAt: 8, agent_id: 'sub-1', agent_type: 'impl-standard' });
  waitForCodex(state, 'bg-oldest', 'bash-wait-old', 9, 'sub-1', 'impl-standard-20261003-123456-7', {
    model: 'gpt-wait-placeholder', effort: 'high',
  });
  const [resumedAgent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([resumedAgent.gpt.model, resumedAgent.gpt.active, resumedAgent.gpt.unconfirmed], ['gpt-old', true, false]);
});

test('一致する runId の行が無い結果は、一意な背景 Codex に結び付ける', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const runId = 'impl-hard-20261003-123456-7';
  state.addEvent({ session_id: 'single-background', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-standard' });
  launchCodex(state, 'single-background', 'bash-1', 2, 'sub-1', { model: 'gpt-draft', effort: 'low' });
  state.addEvent({ session_id: 'single-background', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
  state.addEvent({
    session_id: 'single-background', hook_event_name: 'PostToolUse', hookAt: 4, agent_id: 'sub-1',
    tool_name: 'Read', tool_use_id: 'read-1',
    codexOutput: { runLine: `codex-agent: run=${runId}`, resultLine: 'codex-agent: result=ok' },
  });

  const [agent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([agent.gpt.model, agent.gpt.active, agent.gpt.unconfirmed], ['gpt-draft', false, false]);
  waitForCodex(state, 'single-background', 'bash-wait', 5, 'sub-1', runId, {
    model: 'gpt-wait-placeholder', effort: 'high',
  });
  const [afterWait] = state.snapshot().sessions[0].agents;
  assert.equal(afterWait.gpt.model, 'gpt-draft');
});

test('run= の無い結果行を、実行 ID が記録済みの背景 Codex に結び付けない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const runId = 'impl-hard-20261003-123456-7';
  state.addEvent({ session_id: 'known-run-background', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  launchCodex(state, 'known-run-background', 'bash-1', 2, 'sub-1', { model: 'gpt-known-run', effort: 'low' });
  state.addEvent({
    session_id: 'known-run-background', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-1', codexOutput: { runLine: `codex-agent: run=${runId}` },
  });
  state.addEvent({
    session_id: 'known-run-background', hook_event_name: 'PostToolUse', hookAt: 4, agent_id: 'sub-1',
    tool_name: 'Read', tool_use_id: 'read-1', codexOutput: { resultLine: 'codex-agent: result=ok' },
  });
  state.addEvent({ session_id: 'known-run-background', hook_event_name: 'SubagentStop', hookAt: 5, agent_id: 'sub-1' });

  const [agent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([agent.gpt.model, agent.gpt.active, agent.gpt.unconfirmed], ['gpt-known-run', false, true]);
});

test('同じ定義の Codex の実行が 2 回あっても、監査行はそれぞれの実行に付く', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  launchCodex(state, 'twice', 'bash-a', 1, null);
  launchCodex(state, 'twice', 'bash-b', 2, null);
  state.addEvent({
    session_id: 'twice', hook_event_name: 'PostToolUse', hookAt: 3, tool_name: 'Bash', tool_use_id: 'bash-b',
    codexOutput: codexOutput('gpt-b', 'high'),
  });
  state.addEvent({
    session_id: 'twice', hook_event_name: 'PostToolUse', hookAt: 4, tool_name: 'Bash', tool_use_id: 'bash-a',
    codexOutput: codexOutput('gpt-a', 'max'),
  });
  const models = Object.fromEntries(state.snapshot().sessions[0].agents.map((agent) => [agent.agent_id, agent.model]));
  assert.deepEqual(models, { 'codex:bash-a': 'gpt-a', 'codex:bash-b': 'gpt-b' });
});

test('完了した tool_use_id は、遅れて処理された PreToolUse で実行中に戻らない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'late', hook_event_name: 'PostToolUse', hookAt: 100, tool_name: 'Read', tool_use_id: 'read-1' });
  state.addEvent({ session_id: 'late', hook_event_name: 'PreToolUse', hookAt: 200, tool_name: 'Read', tool_use_id: 'read-1', summary: 'a.md' });
  assert.deepEqual(state.snapshot().sessions[0].tools, []);
});

test('結果行が無いまま親が終わった背景 Codex は終了未確認になる', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'unconfirmed', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-standard' });
  launchCodex(state, 'unconfirmed', 'bash-1', 2, 'sub-1', { model: 'gpt-draft', effort: 'low' });
  state.addEvent({ session_id: 'unconfirmed', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
  state.addEvent({ session_id: 'unconfirmed', hook_event_name: 'SubagentStop', hookAt: 4, agent_id: 'sub-1' });
  const [agent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([agent.gpt.active, agent.gpt.unconfirmed], [false, true]);
});

test('メインの Stop 後もメイン直下の背景 Codex は稼働中で、結果行が届くと終了する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  launchCodex(state, 'main-background', 'bash-1', 1, null, { model: 'gpt-draft', effort: 'low' });
  state.addEvent({ session_id: 'main-background', hook_event_name: 'PostToolUse', hookAt: 2, tool_name: 'Bash', tool_use_id: 'bash-1' });
  state.addEvent({ session_id: 'main-background', hook_event_name: 'Stop', hookAt: 3 });

  let session = state.snapshot().sessions[0];
  let [agent] = session.agents;
  assert.deepEqual([agent.active, agent.unconfirmed, agent.closable], [true, undefined, true]);
  assert.equal(session.status, '待機中(サブエージェント稼働中)');

  state.addEvent({
    session_id: 'main-background', hook_event_name: 'PostToolUse', hookAt: 4,
    tool_name: 'Read', tool_use_id: 'read-1', codexOutput: codexOutput('gpt-6-luna', 'low'),
  });
  session = state.snapshot().sessions[0];
  [agent] = session.agents;
  assert.deepEqual([agent.active, agent.unconfirmed, agent.closable], [false, false, undefined]);
  assert.equal(session.status, '作業中');
});

test('メイン直下の稼働中の背景 Codex は閉じられ、結果行で閉じた記録が消える', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  launchCodex(state, 'close-background', 'bash-1', 1, null);
  state.addEvent({ session_id: 'close-background', hook_event_name: 'PostToolUse', hookAt: 2, tool_name: 'Bash', tool_use_id: 'bash-1' });
  state.addEvent({ session_id: 'close-background', hook_event_name: 'Stop', hookAt: 3 });
  const agentId = state.sessions.get('close-background').agents[0].agent_id;

  assert.equal(state.closeAgent('close-background', agentId), true);
  let session = state.snapshot().sessions[0];
  let [agent] = session.agents;
  assert.deepEqual([agent.active, agent.unconfirmed, agent.closable], [false, false, undefined]);
  assert.equal(session.status, '待機中');

  state.addEvent({
    session_id: 'close-background', hook_event_name: 'PostToolUse', hookAt: 4,
    tool_name: 'Read', tool_use_id: 'read-1', codexOutput: codexOutput('gpt-6-luna', 'low'),
  });
  assert.equal(state.closedAgents.has('close-background'), false);
  session = state.snapshot().sessions[0];
  [agent] = session.agents;
  assert.deepEqual([agent.active, agent.unconfirmed], [false, false]);
  assert.equal(session.status, '作業中');
});

test('サブエージェント配下の稼働中 Codex と通常のサブエージェントは閉じられない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'not-closable', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-standard' });
  launchCodex(state, 'not-closable', 'bash-1', 2, 'sub-1');
  state.addEvent({ session_id: 'not-closable', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-1' });

  assert.equal(state.closeAgent('not-closable', 'sub-1'), false);
  assert.notEqual(state.closeAgent('not-closable', 'codex:bash-1'), true);
  const session = state.snapshot().sessions[0];
  const parent = session.agents.find((agent) => agent.agent_id === 'sub-1');
  assert.equal(parent.gpt.active, true);
  assert.equal(parent.closable, undefined);
  assert.equal(state.closedAgents.has('not-closable'), false);
});

test('終了コードが 0 以外で PostToolUseFailure になった Codex も、結果行で GPT 不使用にする', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'failure', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-standard' });
  launchCodex(state, 'failure', 'bash-1', 2, 'sub-1', { model: 'gpt-draft', effort: 'low' });
  state.addEvent({
    session_id: 'failure', hook_event_name: 'PostToolUseFailure', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-1',
    codexOutput: { resultLine: 'codex-agent: result=failed exit=3' },
  });

  const [agent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([agent.gpt.unavailable, agent.gpt.active], ['使用不能', false]);
});

test('監査行だけの出力では Codex を終了にせず、背景で動いているものとして扱う', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'audit-only', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-standard' });
  launchCodex(state, 'audit-only', 'bash-1', 2, 'sub-1');
  state.addEvent({
    session_id: 'audit-only', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-1', codexOutput: { auditLine: codexOutput('gpt-6-luna', 'max').auditLine },
  });

  const [agent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([agent.gpt.model, agent.gpt.active], ['gpt-6-luna', true]);
});

test('結果行が届かないまま親が終わったら、親の行を終了未確認にする', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'parent-unconfirmed', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-standard' });
  launchCodex(state, 'parent-unconfirmed', 'bash-1', 2, 'sub-1');
  state.addEvent({ session_id: 'parent-unconfirmed', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
  state.addEvent({ session_id: 'parent-unconfirmed', hook_event_name: 'SubagentStop', hookAt: 4, agent_id: 'sub-1' });

  const [agent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([agent.active, agent.unconfirmed], [false, true]);
});

test('再開した親が取り出した結果行で、終了未確認になった Codex を終了にする', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'resumed', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-standard' });
  launchCodex(state, 'resumed', 'bash-1', 2, 'sub-1');
  state.addEvent({ session_id: 'resumed', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
  state.addEvent({ session_id: 'resumed', hook_event_name: 'SubagentStop', hookAt: 4, agent_id: 'sub-1' });
  state.addEvent({ session_id: 'resumed', hook_event_name: 'SubagentStart', hookAt: 5, agent_id: 'sub-1', agent_type: 'impl-standard' });
  state.addEvent({
    session_id: 'resumed', hook_event_name: 'PostToolUse', hookAt: 6, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-wait', codexOutput: codexOutput('gpt-6-luna', 'max'),
  });
  state.addEvent({ session_id: 'resumed', hook_event_name: 'SubagentStop', hookAt: 7, agent_id: 'sub-1' });

  const [agent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([agent.unconfirmed === true, agent.gpt.active, agent.gpt.unconfirmed], [false, false, false]);
});

test('Agent の結果に写った結果行では、背景の Codex を終了にしない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  launchCodex(state, 'agent-report', 'bash-1', 1, null);
  state.addEvent({ session_id: 'agent-report', hook_event_name: 'PostToolUse', hookAt: 2, tool_name: 'Bash', tool_use_id: 'bash-1' });
  state.addEvent({
    session_id: 'agent-report', hook_event_name: 'PostToolUse', hookAt: 3, tool_name: 'Agent', tool_use_id: 'agent-1',
    codexOutput: { resultLine: 'codex-agent: result=ok' },
  });

  const [agent] = state.snapshot().sessions[0].agents;
  assert.equal(agent.active, true);
});

test('rate-limited の結果行は親の GPT 情報を利用上限にする', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'rate-limited', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-standard' });
  launchCodex(state, 'rate-limited', 'bash-1', 2, 'sub-1', { model: 'gpt-draft', effort: 'low' });
  state.addEvent({
    session_id: 'rate-limited', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1',
    tool_name: 'Bash', tool_use_id: 'bash-1',
    codexOutput: { resultLine: 'codex-agent: result=rate-limited retry=14:00 exit=75' },
  });

  const [agent] = state.snapshot().sessions[0].agents;
  assert.equal(agent.gpt.unavailable, '利用上限');
  assert.equal(agent.gpt.active, false);
});

test('メインの Stop の後のサブエージェントの活動では、メインを作業中に戻さない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const status = () => state.snapshot().sessions[0].status;
  state.addEvent({ session_id: 'bg-agent', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'Explore' });
  state.addEvent({ session_id: 'bg-agent', hook_event_name: 'Stop', hookAt: 2 });
  state.addEvent({ session_id: 'bg-agent', hook_event_name: 'PreToolUse', hookAt: 3, agent_id: 'sub-1', tool_name: 'Read', tool_use_id: 'r-1' });
  state.addEvent({ session_id: 'bg-agent', hook_event_name: 'PostToolUse', hookAt: 4, agent_id: 'sub-1', tool_name: 'Read', tool_use_id: 'r-1' });
  assert.equal(status(), '待機中(サブエージェント稼働中)');
  state.addEvent({ session_id: 'bg-agent', hook_event_name: 'SubagentStop', hookAt: 5, agent_id: 'sub-1' });
  assert.equal(status(), '待機中');
});

test('並列の Agent 呼び出しで対応が決まらないときは、resolvedModel を別のサブエージェントに付けない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'parallel', hook_event_name: 'PreToolUse', hookAt: 1, tool_name: 'Agent', tool_use_id: 'call-a' });
  state.addEvent({ session_id: 'parallel', hook_event_name: 'PreToolUse', hookAt: 2, tool_name: 'Agent', tool_use_id: 'call-b' });
  state.addEvent({ session_id: 'parallel', hook_event_name: 'SubagentStart', hookAt: 3, agent_id: 'agent-a', agent_type: 'Explore' });
  state.addEvent({ session_id: 'parallel', hook_event_name: 'SubagentStart', hookAt: 4, agent_id: 'agent-b', agent_type: 'Explore' });
  state.addEvent({ session_id: 'parallel', hook_event_name: 'PostToolUse', hookAt: 5, tool_name: 'Agent', tool_use_id: 'call-a', resolvedModel: 'model-a' });
  const models = state.snapshot().sessions[0].agents.map((agent) => agent.model);
  assert.ok(!models.includes('model-a'));
});

test('セッションファイルの題名が変わったら、一覧の題名も変わる', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'renamed', hook_event_name: 'SessionStart', hookAt: 1 });
  state.syncSessionFiles([{ session_id: 'renamed', cwd: '', name: '最初の名前' }]);
  state.syncSessionFiles([{ session_id: 'renamed', cwd: '', name: '変えた名前' }]);
  assert.equal(state.snapshot().sessions[0].title, '変えた名前');
});

test('開始が重なった Agent 呼び出しは、片方が先に終わっても後の SubagentStart に結び付けない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const add = (event) => state.addEvent({ session_id: 'overlap', ...event });
  add({ hook_event_name: 'PreToolUse', hookAt: 1, tool_name: 'Agent', tool_use_id: 'call-a' });
  add({ hook_event_name: 'PreToolUse', hookAt: 2, tool_name: 'Agent', tool_use_id: 'call-b' });
  add({ hook_event_name: 'PostToolUse', hookAt: 3, tool_name: 'Agent', tool_use_id: 'call-a', resolvedModel: 'model-a' });
  add({ hook_event_name: 'SubagentStart', hookAt: 4, agent_id: 'agent-a', agent_type: 'Explore' });
  add({ hook_event_name: 'SubagentStart', hookAt: 5, agent_id: 'agent-b', agent_type: 'Explore' });
  add({ hook_event_name: 'PostToolUse', hookAt: 6, tool_name: 'Agent', tool_use_id: 'call-b', resolvedModel: 'model-b' });
  const models = state.snapshot().sessions[0].agents.map((agent) => agent.model);
  assert.ok(!models.includes('model-a') && !models.includes('model-b'));
});

for (const source of ['startup', 'resume', 'clear']) {
  test(`SessionStart の ${source} を受けたセッションは待機中になり、メインの実行中のツールを外す`, async (t) => {
    await temporaryHome(t);
    const state = new DashboardState();
    state.addEvent({ session_id: 'idle-start', hook_event_name: 'SessionStart', source, hookAt: 50 });
    assert.equal(state.snapshot().sessions[0].status, '待機中');
    state.addEvent({ session_id: 'idle-start', hook_event_name: 'UserPromptSubmit', hookAt: 100 });
    state.addEvent({ session_id: 'idle-start', hook_event_name: 'PreToolUse', hookAt: 200, tool_name: 'Bash', tool_use_id: 'stale', summary: 'npm test' });
    state.addEvent({ session_id: 'idle-start', hook_event_name: 'SessionStart', source, hookAt: 300 });

    const session = state.snapshot().sessions[0];
    assert.equal(session.status, '待機中');
    assert.equal(session.tools.length, 0);
  });
}

test('SessionStart の compact は直前の状態を保つ', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'compact-working', hook_event_name: 'UserPromptSubmit', hookAt: 100 });
  state.addEvent({ session_id: 'compact-working', hook_event_name: 'SessionStart', source: 'compact', hookAt: 200 });
  state.addEvent({ session_id: 'compact-idle', hook_event_name: 'Stop', hookAt: 100 });
  state.addEvent({ session_id: 'compact-idle', hook_event_name: 'SessionStart', source: 'compact', hookAt: 200 });

  const statusOf = (id) => state.snapshot().sessions.find((session) => session.session_id === id).status;
  assert.equal(statusOf('compact-working'), '作業中');
  assert.equal(statusOf('compact-idle'), '待機中');
});

function launchBackgroundCodexInMain(state, sessionId, toolUseId, backgroundTaskId, hookAt) {
  state.addEvent({
    session_id: sessionId, hook_event_name: 'PreToolUse', hookAt,
    tool_name: 'Bash', tool_use_id: toolUseId, summary: 'npm run review:codex', codexReviewDefinition: 'codex-review',
  }, { codexAgentDefinition: { model: 'gpt-review', effort: 'low' } });
  state.addEvent({
    session_id: sessionId, hook_event_name: 'PostToolUse', hookAt: hookAt + 1,
    tool_name: 'Bash', tool_use_id: toolUseId, backgroundTaskId,
  });
}

test('メインが背景で起動した複数の Codex は、背景タスク ID で出力を読んだ行だけを終了にする', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  launchBackgroundCodexInMain(state, 'bg-ids', 'bash-a', 'taska', 1);
  launchBackgroundCodexInMain(state, 'bg-ids', 'bash-b', 'taskb', 3);
  const gpt = () => state.snapshot().sessions[0].agents.filter((agent) => agent.agent_type === 'codex-review');
  const states = () => gpt().map((agent) => [agent.active, agent.unconfirmed]);

  state.addEvent({
    session_id: 'bg-ids', hook_event_name: 'PostToolUse', hookAt: 5,
    tool_name: 'Read', tool_use_id: 'read-a', backgroundOutputTaskId: 'taska',
    codexOutput: { runLine: 'codex-agent: run=codex-review-20261004-100000-1' },
  });
  assert.equal(gpt().length, 2);
  assert.ok(gpt().every((item) => item.active));

  state.addEvent({
    session_id: 'bg-ids', hook_event_name: 'PostToolUse', hookAt: 6,
    tool_name: 'Read', tool_use_id: 'read-a2', backgroundOutputTaskId: 'taska',
    codexOutput: { runLine: 'codex-agent: run=codex-review-20261004-100000-1', resultLine: 'codex-agent: result=ok' },
  });
  const afterA = states();
  assert.equal(afterA.filter(([active]) => active === false).length, 1);
  assert.equal(afterA.filter(([active]) => active === true).length, 1);

  state.addEvent({
    session_id: 'bg-ids', hook_event_name: 'PostToolUse', hookAt: 7,
    tool_name: 'Read', tool_use_id: 'read-b', backgroundOutputTaskId: 'taskb',
    codexOutput: { resultLine: 'codex-agent: result=ok' },
  });
  assert.ok(gpt().every((item) => item.active === false && item.unconfirmed === false));
});

test('Codex を起動した呼び出しの引数に別の背景タスクの出力ファイルがあっても、完了が重複して届いても、その行に結び付けない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  launchBackgroundCodexInMain(state, 'bg-launch', 'bash-a', 'taska', 1);
  state.addEvent({
    session_id: 'bg-launch', hook_event_name: 'PreToolUse', hookAt: 3,
    tool_name: 'Bash', tool_use_id: 'bash-b', summary: 'npm run review:codex', codexReviewDefinition: 'codex-review',
  }, { codexAgentDefinition: { model: 'gpt-review', effort: 'low' } });
  const resultOfB = { runLine: 'codex-agent: run=codex-review-20261004-100000-2', resultLine: 'codex-agent: result=ok' };
  state.addEvent({
    session_id: 'bg-launch', hook_event_name: 'PostToolUse', hookAt: 4,
    tool_name: 'Bash', tool_use_id: 'bash-b', backgroundOutputTaskId: 'taska', codexOutput: resultOfB,
  });
  state.addEvent({
    session_id: 'bg-launch', hook_event_name: 'PostToolUse', hookAt: 4,
    tool_name: 'Bash', tool_use_id: 'bash-b', backgroundOutputTaskId: 'taska', codexOutput: resultOfB,
  });
  state.addEvent({
    session_id: 'bg-launch', hook_event_name: 'PostToolUse', hookAt: 5,
    tool_name: 'Bash', tool_use_id: 'refetch-b', codexOutput: resultOfB,
  });
  const agents = state.snapshot().sessions[0].agents.filter((agent) => agent.agent_type === 'codex-review');
  assert.equal(agents.length, 2);
  assert.equal(agents.filter((agent) => agent.active === true).length, 1);
});

test('実行 ID の無い結果で失敗した Codex の起動が重複して届いても、背景で稼働中の別の Codex を終了にしない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  launchBackgroundCodexInMain(state, 'bg-fail', 'bash-a', 'taska', 1);
  state.addEvent({
    session_id: 'bg-fail', hook_event_name: 'PreToolUse', hookAt: 3,
    tool_name: 'Bash', tool_use_id: 'bash-b', summary: 'npm run review:codex', codexReviewDefinition: 'codex-review',
  }, { codexAgentDefinition: { model: 'gpt-review', effort: 'low' } });
  for (const hookAt of [4, 4]) {
    state.addEvent({
      session_id: 'bg-fail', hook_event_name: 'PostToolUseFailure', hookAt,
      tool_name: 'Bash', tool_use_id: 'bash-b', codexOutput: { resultLine: 'codex-agent: result=failed exit=3' },
    });
  }
  const agents = state.snapshot().sessions[0].agents.filter((agent) => agent.agent_type === 'codex-review');
  const running = agents.filter((agent) => agent.active === true);
  assert.equal(agents.length, 2);
  assert.equal(running.length, 1);
  assert.equal(running[0].unavailable, '');
});

test('背景タスクの途中の出力に run= の行があれば、行に実行 ID を記録して後の結果行を実行 ID で照合する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  launchBackgroundCodexInMain(state, 'bg-run', 'bash-a', 'taska', 1);
  launchBackgroundCodexInMain(state, 'bg-run', 'bash-b', 'taskb', 3);
  state.addEvent({
    session_id: 'bg-run', hook_event_name: 'PostToolUse', hookAt: 5,
    tool_name: 'Read', tool_use_id: 'read-b', backgroundOutputTaskId: 'taskb',
    codexOutput: { runLine: 'codex-agent: run=codex-review-20261004-100000-2' },
  });
  state.addEvent({
    session_id: 'bg-run', hook_event_name: 'PostToolUse', hookAt: 6,
    tool_name: 'Bash', tool_use_id: 'later',
    codexOutput: { runLine: 'codex-agent: run=codex-review-20261004-100000-2', resultLine: 'codex-agent: result=ok' },
  });
  const flags = state.snapshot().sessions[0].agents.filter((agent) => agent.agent_type === 'codex-review').map((agent) => agent.active);
  assert.equal(flags.filter((active) => active === false).length, 1);
  assert.equal(flags.filter((active) => active === true).length, 1);
});
