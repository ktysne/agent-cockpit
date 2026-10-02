const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { AwayState, DashboardState } = require('../src/server/state');
const { AtomicJsonWriter } = require('../src/server/json-storage');

const DAY_MS = 24 * 60 * 60 * 1000;

async function temporaryHome(testContext) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-store-test-'));
  testContext.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  return homeDir;
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
    collapsed: ['C:\\project'], hidden: ['agents'],
  };
  state.patchDisplayPreferences(display);
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
});

test('復元時に orphan の回答記録と14日を過ぎたセッションの記録を捨てる', async (t) => {
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
  state.closeTask('expired-session', '古いタスク');
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
  assert.equal(restored.plans.has('expired-session'), false);
  assert.equal(restored.hiddenSessions.has('expired-session'), false);
  assert.equal(restored.closedTasks.has('expired-session'), false);
  assert.deepEqual([...restored.decisionLifecycles.get('current-session').keys()], [currentDecision.id]);
  assert.equal(restored.decisionFor('current-session', currentDecision.id).awaitingAnswerUntil, undefined);
});

test('復元後の最初のセッションファイル同期でタスクもファイルも無い外し記録を捨てる', async (t) => {
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
  assert.equal(restored.hiddenSessions.has('hidden-with-task'), true);
});

test('通常の保存は500msでまとめ、回答記録の変更は待たずに書く', async (t) => {
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
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(writes, 0);
  await new Promise((resolve) => setTimeout(resolve, 450));
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

  assert.deepEqual(await away.setEnabled(true, 123), { enabled: true, since: 123 });
  assert.equal(attempts, 2);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(homeDir, 'away.json'), 'utf8')), { enabled: true, since: 123 });
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
