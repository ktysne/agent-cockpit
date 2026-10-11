const test = require('node:test');
const assert = require('node:assert/strict');
const { DashboardState } = require('../src/server/state');
const { DecisionAnswerDelivery } = require('../src/server/decision-answers');

const NOW = Date.UTC(2026, 9, 11);
const QUESTIONS = [{ question: '形式を選んでください', header: '形式', options: [{ label: 'JSON', description: 'JSON形式' }] }];

function ask(toolUseId = 'ask-1', hookAt = NOW, extra = {}) {
  return { session_id: 'session-a', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: toolUseId, questions: QUESTIONS, hookAt, ...extra };
}

function progress(hookEventName, hookAt = NOW + 100, extra = {}) {
  return { session_id: 'session-a', hook_event_name: hookEventName, hookAt,
    ...(hookEventName === 'PreToolUse' ? { tool_name: 'Bash', tool_use_id: 'bash-1' } : {}), ...extra };
}

function decision(state) {
  return state.decisionFor('session-a', 'ask-1');
}

async function restart(state) {
  const contents = JSON.stringify(state.serializeStore());
  return DashboardState.load('.', {
    now: NOW + 1000,
    fileSystem: { readFile: async () => contents },
    writer: { write: async () => {} },
  });
}

for (const eventName of ['UserPromptSubmit', 'Stop', 'PreToolUse']) {
  test(`終了フックのない質問は後続の ${eventName} で withdrawn になる`, () => {
    const state = new DashboardState();
    state.addEvent(ask());
    state.addEvent(progress(eventName));
    assert.equal(decision(state).state, 'withdrawn');
    assert.equal(decision(state).resolvedAt, new Date(NOW + 100).toISOString());
    assert.equal(decision(state).finishedByToolUseId, 'ask-1');
    assert.equal(decision(state).resolution, null);
    state.addEvent(progress('UserPromptSubmit', NOW + 200));
    assert.equal(decision(state).state, 'withdrawn');
  });

  test(`サブエージェントの ${eventName} はメインの質問を取り下げない`, () => {
    const state = new DashboardState();
    state.addEvent(ask());
    state.addEvent(progress(eventName, NOW + 100, { agent_id: 'agent-a' }));
    assert.equal(decision(state).state, 'waiting');
  });
}

test('開始以前の時刻や先に受信したイベントと同じ呼び出しの開始では取り下げない', () => {
  const state = new DashboardState();
  state.addEvent(progress('UserPromptSubmit', NOW + 100));
  state.addEvent(ask());
  assert.equal(decision(state).state, 'waiting');
  state.addEvent(progress('Stop', NOW));
  state.addEvent(progress('UserPromptSubmit', NOW - 1));
  state.addEvent(ask('ask-1', NOW + 200));
  assert.equal(decision(state).state, 'waiting');
});

test('終了の根拠にしないイベントでは質問を取り下げない', () => {
  const state = new DashboardState();
  state.addEvent(ask());
  for (const eventName of ['PostToolUse', 'PostToolBatch', 'Notification']) {
    state.addEvent(progress(eventName));
    assert.equal(decision(state).state, 'waiting');
  }
});

test('離席中のフックが回答待ちを記録した質問は再起動後も waiting を保つ', async () => {
  const state = new DashboardState();
  const away = { enabled: true, snapshot() { return { enabled: this.enabled }; } };
  const delivery = new DecisionAnswerDelivery({ state, away, now: () => NOW, setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} });
  delivery.registerAsk({ sessionId: 'session-a', toolUseId: 'ask-1', questions: QUESTIONS });
  state.addEvent(progress('UserPromptSubmit'));
  assert.equal(decision(state).state, 'waiting');
  assert.ok(decision(state).awaitingAnswerUntil);
  const restored = await restart(state);
  assert.equal(decision(restored).awaitingAnswerUntil, undefined);
  restored.addEvent(progress('Stop', NOW + 200));
  restored.addEvent(progress('PreToolUse', NOW + 300));
  assert.equal(decision(restored).state, 'waiting');
  away.enabled = false;
  assert.equal(delivery.finishAsk({ sessionId: 'session-a', toolUseId: 'ask-1' }).outcome, 'released');
  state.addEvent(progress('Stop', NOW + 400));
  assert.equal(decision(state).state, 'waiting');
});

test('離席中にフックが却下した質問と送信済みの回答は後続イベントで取り下げない', async () => {
  const state = new DashboardState();
  const delivery = new DecisionAnswerDelivery({ state, away: { snapshot: () => ({ enabled: true }) },
    now: () => NOW, setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} });
  delivery.registerAsk({ sessionId: 'session-a', toolUseId: 'ask-1', questions: QUESTIONS });
  const result = delivery.finishAsk({ sessionId: 'session-a', toolUseId: 'ask-1', outcome: 'server-lost' });
  assert.equal(result.hookOutput.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(decision(state).state, 'provisional');
  for (const eventName of ['UserPromptSubmit', 'Stop', 'PreToolUse']) state.addEvent(progress(eventName, NOW + 5));
  assert.equal(decision(state).state, 'provisional');
  state.setDecisionLifecycle('session-a', 'ask-1', { state: null, answer: { sentAt: new Date(NOW + 10).toISOString() } }, NOW + 10);
  for (const eventName of ['UserPromptSubmit', 'Stop', 'PreToolUse']) state.addEvent(progress(eventName));
  assert.equal(decision(state).state, 'waiting');
  const restored = await restart(state);
  restored.addEvent(progress('Stop', NOW + 200));
  assert.equal(decision(restored).state, 'waiting');
  assert.ok(decision(restored).answer.sentAt);
});

test('provisional の質問は後続イベントで取り下げない', () => {
  const state = new DashboardState();
  state.addEvent(ask());
  state.updateDecision('session-a', 'ask-1', 'provisional', [], '', NOW + 10);
  for (const eventName of ['UserPromptSubmit', 'Stop', 'PreToolUse']) state.addEvent(progress(eventName));
  assert.equal(decision(state).state, 'provisional');
});

test('同じ質問の出し直しは判断事項を引き継ぎ、その後の進行で最新の呼び出しを取り下げる', () => {
  const state = new DashboardState();
  state.addEvent(ask());
  state.addEvent(ask('ask-2', NOW + 10));
  assert.equal(decision(state).state, 'waiting');
  assert.equal(state.decisionIdForToolUse('session-a', 'ask-2'), 'ask-1');
  state.addEvent(progress('Stop'));
  assert.equal(decision(state).state, 'withdrawn');
  assert.equal(decision(state).finishedByToolUseId, 'ask-2');
});

test('別の質問の開始は元の質問を取り下げる', () => {
  const state = new DashboardState();
  state.addEvent(ask());
  state.addEvent(ask('ask-2', NOW + 10, { questions: [{ ...QUESTIONS[0], question: '別の質問' }] }));
  assert.equal(decision(state).state, 'withdrawn');
  assert.equal(state.decisionFor('session-a', 'ask-2').state, 'waiting');
});

test('取り下げは再起動後の再作成と遅れた開始や PostToolUse でも巻き戻らない', async () => {
  const state = new DashboardState();
  state.addEvent(ask());
  state.addEvent(progress('Stop'));
  const expected = decision(state);
  for (const current of [state, await restart(state)]) {
    current.addEvent(ask());
    current.addEvent(ask('ask-1', NOW + 200, { hook_event_name: 'PostToolUse', decisionResolution: { chosen: ['JSON'], note: '' } }));
    current.addEvent(ask('ask-1', NOW + 300));
    current.addEvent(progress('UserPromptSubmit', NOW + 400));
    assert.deepEqual(decision(current), expected);
    const restored = await restart(current);
    restored.addEvent(progress('Stop', NOW + 500));
    assert.deepEqual(decision(restored), expected);
  }
});

test('再起動前に開始した未完了の質問も後続イベントで取り下げる', async () => {
  const state = new DashboardState();
  state.addEvent(ask());
  const restored = await restart(state);
  restored.addEvent(progress('UserPromptSubmit'));
  assert.equal(decision(restored).state, 'withdrawn');
  assert.equal(decision(restored).finishedByToolUseId, 'ask-1');
});

test('再起動後に古い開始が届いても最新の出し直しより前のイベントでは取り下げない', async () => {
  const state = new DashboardState();
  state.addEvent(ask());
  state.addEvent(ask('ask-2', NOW + 20));
  const restored = await restart(state);
  restored.addEvent(ask());
  restored.addEvent(progress('Stop', NOW + 10));
  assert.equal(decision(restored).state, 'waiting');
  restored.addEvent(progress('UserPromptSubmit', NOW + 100));
  assert.equal(decision(restored).state, 'withdrawn');
  assert.equal(decision(restored).finishedByToolUseId, 'ask-2');
});
