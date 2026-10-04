const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DashboardState } = require('../src/server/state');

const NOW = Date.UTC(2026, 9, 2, 1, 2, 3);
const STORE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const RESTORE_SESSION_CLEANUP_GRACE_MS = 10 * 60 * 1000;
const QUESTIONS = [{
  question: 'どの形式にしますか。',
  header: '形式',
  multiSelect: false,
  options: [
    { label: 'JSON (推奨)', description: '既存 API と一致する。', recommended: true },
    { label: 'CSV', description: '表計算で開ける。', recommended: false },
  ],
}];

async function temporaryHome(testContext) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-ask-persistence-'));
  testContext.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  return homeDir;
}

function askEvent(sessionId, toolUseId, hookEventName, hookAt, extra = {}) {
  return {
    session_id: sessionId,
    hook_event_name: hookEventName,
    hookAt,
    tool_name: 'AskUserQuestion',
    tool_use_id: toolUseId,
    ...(hookEventName === 'PreToolUse' ? { questions: QUESTIONS } : {}),
    ...extra,
  };
}

test('離席中の質問と tool_use_id の結び付きは保存して読み込める', async (t) => {
  const homeDir = await temporaryHome(t);
  const state = await DashboardState.load(homeDir, { now: NOW });
  state.addEvent(askEvent('session-roundtrip', 'ask-original', 'PreToolUse', NOW));
  state.addEvent(askEvent('session-roundtrip', 'ask-reused', 'PreToolUse', NOW + 10));
  await state.flushPersistence();

  const stored = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
  assert.equal(stored.plans['session-roundtrip'].decisions.length, 1);
  assert.equal(stored.plans['session-roundtrip'].decisions[0].source, 'ask');
  assert.deepEqual(stored.plans['session-roundtrip'].decisions[0].questions, QUESTIONS);
  assert.deepEqual(stored.askDecisionBindings['session-roundtrip'], {
    'ask-original': 'ask-original',
    'ask-reused': 'ask-original',
  });

  const restored = await DashboardState.load(homeDir, { now: NOW + 20 });
  const decision = restored.decisionFor('session-roundtrip', 'ask-original');
  assert.equal(decision.state, 'waiting');
  assert.equal(decision.createdAt, new Date(NOW).toISOString());
  assert.equal(decision.updatedAt, new Date(NOW + 10).toISOString());
  assert.deepEqual(decision.questions, QUESTIONS);
  assert.equal(restored.decisionIdForToolUse('session-roundtrip', 'ask-reused'), 'ask-original');

  restored.addEvent(askEvent('session-roundtrip', 'ask-reused', 'PreToolUse', NOW + 30));
  assert.equal(restored.snapshot().sessions[0].decisions.length, 1);
  assert.equal(restored.snapshot().sessions[0].decisions[0].id, 'ask-original');
  assert.equal(restored.decisionIdForToolUse('session-roundtrip', 'ask-reused'), 'ask-original');
});

test('再起動後の同じ tool_use_id の PostToolUse で判断事項を解決する', async (t) => {
  const homeDir = await temporaryHome(t);
  const state = await DashboardState.load(homeDir, { now: NOW });
  state.addEvent(askEvent('session-post', 'ask-post', 'PreToolUse', NOW));
  await state.flushPersistence();

  const restored = await DashboardState.load(homeDir, { now: NOW + 10 });
  restored.addEvent(askEvent('session-post', 'ask-post', 'PostToolUse', NOW + 20, {
    decisionResolution: { chosen: ['JSON (推奨)'], note: 'この形式で進める。' },
  }));
  const decision = restored.decisionFor('session-post', 'ask-post');
  assert.equal(decision.state, 'resolved');
  assert.equal(decision.resolvedAt, new Date(NOW + 20).toISOString());
  assert.deepEqual(decision.resolution, { chosen: ['JSON (推奨)'], note: 'この形式で進める。' });
  await restored.flushPersistence();

  const savedAgain = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
  assert.equal(savedAgain.plans['session-post'].decisions[0].state, 'resolved');
  assert.deepEqual(savedAgain.plans['session-post'].decisions[0].resolution, decision.resolution);
});

test('再起動後に別の tool_use_id で同じ質問を出しても後続イベント後に判断事項を維持する', async (t) => {
  const homeDir = await temporaryHome(t);
  const state = await DashboardState.load(homeDir, { now: NOW });
  state.addEvent(askEvent('session-retry', 'ask-original', 'PreToolUse', NOW));
  await state.flushPersistence();

  const restored = await DashboardState.load(homeDir, { now: NOW + 10 });
  restored.addEvent(askEvent('session-retry', 'ask-retry', 'PreToolUse', NOW + 20));
  const retried = restored.decisionFor('session-retry', 'ask-original');
  assert.equal(retried.id, 'ask-original');
  assert.equal(retried.createdAt, new Date(NOW).toISOString());
  assert.equal(restored.decisionIdForToolUse('session-retry', 'ask-retry'), 'ask-original');

  const answer = {
    choice: 'ok',
    note: '推奨案で進める。',
    sentAt: new Date(NOW + 21).toISOString(),
    deliveredAt: null,
    reflectedAt: null,
    promptDeliveries: 0,
  };
  restored.setDecisionLifecycle('session-retry', 'ask-original', { answer }, NOW + 21);
  restored.addEvent({
    session_id: 'session-retry', hook_event_name: 'UserPromptSubmit', hookAt: NOW + 30,
  });

  const decision = restored.decisionFor('session-retry', 'ask-original');
  assert.equal(decision.id, 'ask-original');
  assert.equal(decision.createdAt, new Date(NOW).toISOString());
  assert.deepEqual(decision.answer, answer);
  assert.equal(restored.decisionIdForToolUse('session-retry', 'ask-retry'), 'ask-original');

  await restored.flushPersistence();
  const saved = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
  assert.equal(saved.plans['session-retry'].decisions.length, 1);
  assert.equal(saved.plans['session-retry'].decisions[0].id, 'ask-original');
  assert.equal(saved.plans['session-retry'].decisions[0].createdAt, new Date(NOW).toISOString());
  assert.deepEqual(saved.decisionLifecycles['session-retry']['ask-original'].answer, answer);
});

test('仮の推奨案と回答は再起動後も残る', async (t) => {
  const homeDir = await temporaryHome(t);
  const state = await DashboardState.load(homeDir, { now: NOW });
  state.addEvent(askEvent('session-provisional', 'ask-provisional', 'PreToolUse', NOW));
  state.setDecisionLifecycle('session-provisional', 'ask-provisional', {
    state: 'provisional',
    answer: {
      choice: 'ok',
      note: '推奨案で進める。',
      sentAt: new Date(NOW + 10).toISOString(),
      deliveredAt: new Date(NOW + 20).toISOString(),
      reflectedAt: null,
      promptDeliveries: 0,
    },
  }, NOW + 20);
  await state.flushPersistence();

  const restored = await DashboardState.load(homeDir, { now: NOW + 30 });
  const decision = restored.decisionFor('session-provisional', 'ask-provisional');
  assert.equal(decision.state, 'provisional');
  assert.equal(decision.answer.choice, 'ok');
  assert.equal(decision.answer.note, '推奨案で進める。');
  assert.equal(decision.answer.sentAt, new Date(NOW + 10).toISOString());
  assert.equal(decision.answer.deliveredAt, new Date(NOW + 20).toISOString());
  assert.equal(decision.awaitingAnswerUntil, undefined);
});

test('保持期間を過ぎた判断事項は消し、生きているセッションの記録は残す', async (t) => {
  const homeDir = await temporaryHome(t);
  const state = await DashboardState.load(homeDir, { now: NOW });
  const oldAt = NOW - STORE_RETENTION_MS - 1;
  state.addEvent(askEvent('session-expired', 'ask-expired', 'PreToolUse', oldAt));
  state.addEvent(askEvent('session-live', 'ask-live', 'PreToolUse', oldAt));
  await state.flushPersistence();

  const restoredAt = NOW + 1;
  const restored = await DashboardState.load(homeDir, { now: restoredAt });
  restored.syncSessionFiles([{
    session_id: 'session-live', name: '稼働中', cwd: 'D:/project', product: null,
  }], restoredAt + RESTORE_SESSION_CLEANUP_GRACE_MS + 1);

  assert.equal(restored.plans.has('session-expired'), false);
  assert.equal(restored.askDecisionBindings.has('session-expired'), false);
  assert.equal(restored.decisionFor('session-live', 'ask-live').source, 'ask');
  await restored.flushPersistence();
});

test('askDecisionBindings が無い旧形式の store.json も読み込める', async (t) => {
  const homeDir = await temporaryHome(t);
  const timestamp = new Date(NOW).toISOString();
  const oldStore = {
    version: 1,
    display: null,
    plans: {
      'session-legacy': {
        tasks: [],
        tasksUpdatedAt: null,
        product: null,
        decisions: [{
          id: 'decision-mcp',
          session_id: 'session-legacy',
          source: 'mcp',
          state: 'waiting',
          title: '既存の判断事項',
          context: '',
          questions: [{ question: '選択してください。', header: '', multiSelect: false, options: [] }],
          createdAt: timestamp,
          updatedAt: timestamp,
          resolvedAt: null,
          answer: null,
          resolution: null,
        }],
      },
    },
    decisionLifecycles: {},
    closedTasks: [],
    hiddenSessions: [],
  };
  await fs.writeFile(path.join(homeDir, 'store.json'), JSON.stringify(oldStore));

  const restored = await DashboardState.load(homeDir, { now: NOW + 1 });
  assert.equal(restored.decisionFor('session-legacy', 'decision-mcp').title, '既存の判断事項');
  assert.equal(restored.askDecisionBindings.size, 0);
  await restored.flushPersistence();

  const normalized = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
  assert.deepEqual(normalized.askDecisionBindings, {});
  assert.equal(normalized.plans['session-legacy'].decisions[0].source, 'mcp');
});

for (const [finishEvent, finishedState] of [['PostToolUse', 'resolved'], ['PostToolUseFailure', 'withdrawn']]) {
  test(`再起動後に別の tool_use_id で出し直した質問が ${finishedState} になっても、判断事項は元の 1 件のまま`, async (t) => {
    const homeDir = await temporaryHome(t);
    const state = await DashboardState.load(homeDir, { now: NOW });
    state.addEvent(askEvent('session-finish', 'ask-original', 'PreToolUse', NOW));
    await state.flushPersistence();

    const restored = await DashboardState.load(homeDir, { now: NOW + 10 });
    restored.addEvent(askEvent('session-finish', 'ask-retry', 'PreToolUse', NOW + 20));
    const answer = {
      choice: 'ok', note: '', sentAt: new Date(NOW + 21).toISOString(),
      deliveredAt: null, reflectedAt: null, promptDeliveries: 0,
    };
    restored.setDecisionLifecycle('session-finish', 'ask-original', { answer }, NOW + 21);
    restored.addEvent(askEvent('session-finish', 'ask-retry', finishEvent, NOW + 30));
    restored.addEvent({ session_id: 'session-finish', hook_event_name: 'UserPromptSubmit', hookAt: NOW + 40 });

    const decisions = restored.snapshot().sessions.find((session) => session.session_id === 'session-finish').decisions;
    assert.deepEqual(decisions.map((decision) => [decision.id, decision.state]), [['ask-original', finishedState]]);
    assert.equal(decisions[0].createdAt, new Date(NOW).toISOString());
    assert.deepEqual(decisions[0].answer, answer);
    assert.equal(restored.decisionIdForToolUse('session-finish', 'ask-retry'), 'ask-original');

    await restored.flushPersistence();
    const saved = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
    assert.deepEqual(saved.plans['session-finish'].decisions.map((decision) => decision.id), ['ask-original']);
  });
}

for (const [finishEvent, finishedState] of [['PostToolUse', 'resolved'], ['PostToolUseFailure', 'withdrawn']]) {
  test(`再起動後に同じ呼び出しの古い PreToolUse が届いても、${finishedState} の判断事項は戻らない`, async (t) => {
    const homeDir = await temporaryHome(t);
    const resolution = { chosen: ['JSON (推奨)'], note: 'この形式で進める。' };
    const state = await DashboardState.load(homeDir, { now: NOW });
    state.addEvent(askEvent('session-late', 'ask-late', 'PreToolUse', NOW));
    state.addEvent(askEvent('session-late', 'ask-late', finishEvent, NOW + 10, { decisionResolution: resolution }));
    await state.flushPersistence();

    const restored = await DashboardState.load(homeDir, { now: NOW + 20 });
    const expected = restored.decisionFor('session-late', 'ask-late');
    assert.equal(expected.state, finishedState);

    // 遅れて届いた開始の知らせ(元の時刻)と、重複して届いた開始の知らせ(届いた時刻)の両方を確かめる。
    restored.addEvent(askEvent('session-late', 'ask-late', 'PreToolUse', NOW));
    assert.deepEqual(restored.decisionFor('session-late', 'ask-late'), expected);
    restored.addEvent({ session_id: 'session-late', hook_event_name: 'UserPromptSubmit', hookAt: NOW + 30 });
    assert.deepEqual(restored.decisionFor('session-late', 'ask-late'), expected);
    restored.addEvent(askEvent('session-late', 'ask-late', 'PreToolUse', NOW + 40));
    restored.addEvent({ session_id: 'session-late', hook_event_name: 'Stop', hookAt: NOW + 50 });

    const decisions = restored.snapshot().sessions.find((session) => session.session_id === 'session-late').decisions;
    assert.deepEqual(decisions.map((decision) => [decision.id, decision.state]), [['ask-late', finishedState]]);
    assert.deepEqual(restored.decisionFor('session-late', 'ask-late'), expected);

    await restored.flushPersistence();
    const saved = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
    assert.deepEqual(saved.plans['session-late'].decisions.map((decision) => [decision.id, decision.state]), [['ask-late', finishedState]]);
    assert.deepEqual(saved.plans['session-late'].decisions[0].resolution, expected.resolution);
  });
}

test('再起動後に古い PreToolUse の後で同じ呼び出しの終わりが届いたら、その終わりで解決する', async (t) => {
  const homeDir = await temporaryHome(t);
  const state = await DashboardState.load(homeDir, { now: NOW });
  state.addEvent(askEvent('session-late-open', 'ask-open', 'PreToolUse', NOW));
  await state.flushPersistence();

  const restored = await DashboardState.load(homeDir, { now: NOW + 10 });
  restored.addEvent(askEvent('session-late-open', 'ask-open', 'PreToolUse', NOW));
  assert.equal(restored.decisionFor('session-late-open', 'ask-open').state, 'waiting');
  restored.addEvent(askEvent('session-late-open', 'ask-open', 'PostToolUse', NOW + 20, {
    decisionResolution: { chosen: ['CSV'], note: '' },
  }));
  restored.addEvent({ session_id: 'session-late-open', hook_event_name: 'UserPromptSubmit', hookAt: NOW + 30 });
  const decision = restored.decisionFor('session-late-open', 'ask-open');
  assert.equal(decision.state, 'resolved');
  assert.deepEqual(decision.resolution, { chosen: ['CSV'], note: '' });
});
