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

for (const eventName of ['UserPromptSubmit', 'Stop', 'Interrupt', 'PreToolUse']) {
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

test('開始以前の時刻の区切りや同じ呼び出しの開始では取り下げない', () => {
  const state = new DashboardState();
  state.addEvent(progress('UserPromptSubmit', NOW - 100));
  state.addEvent(progress('Stop', NOW - 50));
  state.addEvent(ask());
  assert.equal(decision(state).state, 'waiting');
  state.addEvent(progress('Stop', NOW));
  state.addEvent(progress('UserPromptSubmit', NOW - 1));
  state.addEvent(ask('ask-1', NOW + 200));
  assert.equal(decision(state).state, 'waiting');
});

for (const eventName of ['Stop', 'PreToolUse', 'UserPromptSubmit', 'Interrupt']) {
  test(`先に届いた ${eventName} より前の時刻の質問開始はその場で withdrawn になる`, () => {
    const state = new DashboardState();
    state.addEvent(progress('UserPromptSubmit', NOW - 100));
    state.addEvent(progress(eventName, NOW + 200));
    state.addEvent(ask('ask-1', NOW + 100));
    assert.equal(decision(state).state, 'withdrawn');
    assert.equal(decision(state).inferredWithdrawalHookAt, NOW + 200);
    assert.equal(decision(state).finishedByToolUseId, 'ask-1');
    assert.equal(decision(state).resolution, null);
  });

  for (const sameQuestions of [true, false]) {
    test(`${eventName} の後に遅れて届いた${sameQuestions ? '同じ' : '別の'}質問も元の質問とともに withdrawn になる`, () => {
      const state = new DashboardState();
      state.addEvent(ask());
      state.addEvent(progress(eventName, NOW + 200));
      state.addEvent(ask('ask-2', NOW + 100, {
        questions: sameQuestions ? QUESTIONS : [{ ...QUESTIONS[0], question: '別の質問' }],
      }));
      for (const toolUseId of ['ask-1', 'ask-2']) {
        const current = state.decisionFor('session-a', state.decisionIdForToolUse('session-a', toolUseId));
        assert.equal(current.state, 'withdrawn');
        assert.equal(current.inferredWithdrawalHookAt, NOW + 200);
        assert.equal(current.finishedByToolUseId, toolUseId);
        assert.equal(current.resolution, null);
      }
    });
  }
}

test('遅れた開始は同じ質問の出し直しを除いた最も早い区切りで取り下げる', () => {
  const state = new DashboardState();
  state.addEvent(ask('ask-2', NOW + 150));
  state.addEvent(progress('Stop', NOW + 300));
  state.addEvent(progress('UserPromptSubmit', NOW + 200));
  state.addEvent(ask('ask-1', NOW + 100));
  const current = state.decisionFor('session-a', state.decisionIdForToolUse('session-a', 'ask-1'));
  assert.equal(current.state, 'withdrawn');
  assert.equal(current.inferredWithdrawalHookAt, NOW + 200);
  assert.equal(current.finishedByToolUseId, 'ask-1');
});

test('同じ質問の出し直しだけが先に届いていても遅れた開始を取り下げない', () => {
  const state = new DashboardState();
  state.addEvent(ask('ask-2', NOW + 150));
  state.addEvent(ask('ask-1', NOW + 100));
  const current = state.decisionFor('session-a', state.decisionIdForToolUse('session-a', 'ask-1'));
  assert.equal(current.state, 'waiting');
  assert.equal(state.decisionIdForToolUse('session-a', 'ask-1'), state.decisionIdForToolUse('session-a', 'ask-2'));
});

test('遅れた開始の取り下げも区切りより前の PostToolUse で resolved と回答内容に訂正する', () => {
  const resolution = { chosen: ['JSON'], note: 'JSONで出力する' };
  for (const hookAt of [NOW + 150, NOW + 200, NOW + 250]) {
    const state = new DashboardState();
    state.addEvent(progress('Stop', NOW + 200));
    state.addEvent(ask('ask-1', NOW + 100));
    const expected = decision(state);
    state.addEvent(ask('ask-1', hookAt, { hook_event_name: 'PostToolUse', decisionResolution: resolution }));
    if (hookAt < NOW + 200) {
      assert.equal(decision(state).state, 'resolved');
      assert.deepEqual(decision(state).resolution, resolution);
      assert.equal(decision(state).resolvedAt, new Date(hookAt).toISOString());
      assert.equal(decision(state).inferredWithdrawalHookAt, undefined);
    }
    else assert.deepEqual(decision(state), expected);
  }
});

test('先に届いたサブエージェントの区切りでは遅れたメインの質問を取り下げない', () => {
  for (const eventName of ['Stop', 'PreToolUse', 'UserPromptSubmit', 'Interrupt']) {
    const state = new DashboardState();
    state.addEvent(progress(eventName, NOW + 200, { agent_id: 'agent-a' }));
    state.addEvent(ask('ask-1', NOW + 100));
    assert.equal(decision(state).state, 'waiting');
  }
});

test('Codex のセッションでは区切りより遅れて届いた質問開始を取り下げない', () => {
  const state = new DashboardState();
  state.addEvent(progress('Stop', NOW + 200, { provider: 'codex' }));
  state.addEvent(ask('ask-1', NOW + 100, { provider: 'codex', tool_name: 'request_user_input' }));
  assert.equal(decision(state).state, 'waiting');
});

test('遅れた開始の推定の取り下げは再起動後も保ち同じ開始で巻き戻らない', async () => {
  const state = new DashboardState();
  state.addEvent(progress('Stop', NOW + 200));
  state.addEvent(ask('ask-1', NOW + 100));
  const expected = decision(state);
  assert.equal(expected.state, 'withdrawn');
  const restored = await restart(state);
  assert.deepEqual(decision(restored), expected);
  restored.addEvent(ask('ask-1', NOW + 100));
  assert.deepEqual(decision(restored), expected);
});

test('フックの回答待ちを扱った質問は区切りより遅れて開始が届いても取り下げない', () => {
  const state = new DashboardState();
  const delivery = new DecisionAnswerDelivery({ state, away: { snapshot: () => ({ enabled: true }) },
    now: () => NOW, setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} });
  delivery.registerAsk({ sessionId: 'session-a', toolUseId: 'ask-1', questions: QUESTIONS });
  state.addEvent(progress('Stop', NOW + 200));
  state.addEvent(ask('ask-1', NOW + 100));
  assert.equal(decision(state).state, 'waiting');
  assert.ok(decision(state).awaitingAnswerUntil);
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
});

test('再起動後に同じ質問の開始が届き直しても、離席中のフックが記録した回答待ちを取り下げない', async () => {
  const state = new DashboardState();
  const away = { snapshot: () => ({ enabled: true }) };
  const options = { away, now: () => NOW + 1000, setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} };
  new DecisionAnswerDelivery({ state, ...options, now: () => NOW }).registerAsk({ sessionId: 'session-a', toolUseId: 'ask-1', questions: QUESTIONS });
  const restored = await restart(state);
  const delivery = new DecisionAnswerDelivery({ state: restored, ...options });
  for (const event of [ask('ask-1', NOW + 100), progress('Stop', NOW + 200)]) {
    restored.addEvent(event);
    delivery.afterEvent(event);
  }
  assert.equal(decision(restored).state, 'waiting');
});

test('再起動後に前の呼び出しの開始が遅れて届いても、新しい呼び出しの回答待ちを消さない', async () => {
  const state = new DashboardState();
  state.addEvent(ask('ask-1', NOW));
  const restored = await restart(state);
  const away = { snapshot: () => ({ enabled: true }) };
  const delivery = new DecisionAnswerDelivery({ state: restored, away, now: () => NOW + 1000, setTimeoutImpl: () => 1, clearTimeoutImpl: () => {} });
  delivery.registerAsk({ sessionId: 'session-a', toolUseId: 'ask-2', questions: QUESTIONS });
  const decisionId = restored.decisionIdForToolUse('session-a', 'ask-2');
  const lateStart = ask('ask-1', NOW + 500);
  restored.addEvent(lateStart);
  delivery.afterEvent(lateStart);
  assert.ok(restored.decisionFor('session-a', decisionId).awaitingAnswerUntil);
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

test('画面で解決した仮適用の質問を別の呼び出しで出し直すと回答できる待ちに戻る', () => {
  const state = new DashboardState();
  state.addEvent(ask());
  state.setDecisionLifecycle('session-a', 'ask-1', { state: 'provisional' }, NOW + 5);
  assert.ok(state.closeDecision('session-a', 'ask-1', NOW + 6));
  state.addEvent(ask('ask-2', NOW + 10));
  assert.equal(state.decisionIdForToolUse('session-a', 'ask-2'), 'ask-1');
  assert.equal(decision(state).state, 'waiting');
  assert.notEqual(decision(state).closedByUser, true);
  // 出し直しより古い時刻の元の呼び出しの終わりが遅れて届いても、出し直しの待ちを保つ。
  state.addEvent({ session_id: 'session-a', hook_event_name: 'PostToolUseFailure', tool_name: 'AskUserQuestion', tool_use_id: 'ask-1', hookAt: NOW + 8 });
  assert.equal(decision(state).state, 'waiting');
});

test('画面で解決した後に出し直した質問へ端末で答えると、画面の解決ではなくその回答を出す', async () => {
  const state = new DashboardState();
  state.addEvent(ask());
  state.setDecisionLifecycle('session-a', 'ask-1', { state: 'provisional' }, NOW + 5);
  assert.ok(state.closeDecision('session-a', 'ask-1', NOW + 6));
  state.addEvent(ask('ask-2', NOW + 10));
  state.addEvent({ session_id: 'session-a', hook_event_name: 'PostToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'ask-2',
    decisionResolution: { chosen: ['JSON'], note: '' }, hookAt: NOW + 20 });
  for (const current of [state, await restart(state)]) {
    assert.equal(decision(current).state, 'resolved');
    assert.equal(decision(current).finishedByToolUseId, 'ask-2');
    assert.deepEqual(decision(current).resolution.chosen, ['JSON']);
    assert.notEqual(decision(current).closedByUser, true);
  }
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

test('Stop より前の PostToolUse が遅れて届くと resolved と回答内容を復元する', () => {
  const state = new DashboardState();
  const resolution = { chosen: ['JSON'], note: 'JSONで出力する' };
  state.addEvent(ask());
  state.addEvent(progress('Stop', NOW + 20));
  assert.equal(decision(state).inferredWithdrawalHookAt, NOW + 20);
  state.addEvent(ask('ask-1', NOW + 10, { hook_event_name: 'PostToolUse', decisionResolution: resolution }));
  assert.equal(decision(state).state, 'resolved');
  assert.deepEqual(decision(state).resolution, resolution);
  assert.equal(decision(state).resolvedAt, new Date(NOW + 10).toISOString());
  assert.equal(decision(state).inferredWithdrawalHookAt, undefined);
});

test('Stop と同時刻か後の PostToolUse は推定の取り下げを変えない', () => {
  for (const hookAt of [NOW + 20, NOW + 30]) {
    const state = new DashboardState();
    state.addEvent(ask());
    state.addEvent(progress('Stop', NOW + 20));
    const expected = decision(state);
    state.addEvent(ask('ask-1', hookAt, { hook_event_name: 'PostToolUse', decisionResolution: { chosen: ['JSON'], note: '' } }));
    assert.deepEqual(decision(state), expected);
  }
});

test('推定の取り下げを訂正した resolved と回答内容は再起動後の再作成でも保つ', async () => {
  const state = new DashboardState();
  state.addEvent(ask());
  state.addEvent(progress('Stop', NOW + 20));
  state.addEvent(ask('ask-1', NOW + 10, { hook_event_name: 'PostToolUse', decisionResolution: { chosen: ['JSON'], note: '回答済み' } }));
  const expected = decision(state);
  const restored = await restart(state);
  assert.equal(decision(restored).state, 'resolved');
  assert.deepEqual(decision(restored), expected);
  restored.addEvent(ask());
  restored.addEvent(progress('Stop', NOW + 30));
  assert.deepEqual(decision(restored), expected);
});

test('再起動後も最新の出し直しの遅れた終了フックで推定の取り下げを訂正する', async () => {
  for (const eventName of ['PostToolUse', 'PostToolUseFailure']) {
    const state = new DashboardState();
    state.addEvent(ask());
    state.addEvent(ask('ask-2', NOW + 5));
    state.addEvent(progress('Stop', NOW + 20));
    const restored = await restart(state);
    restored.addEvent(ask('ask-2', NOW + 10, { hook_event_name: eventName,
      decisionResolution: { chosen: ['JSON'], note: '' } }));
    assert.equal(decision(restored).state, eventName === 'PostToolUse' ? 'resolved' : 'withdrawn');
    assert.deepEqual(decision(restored).resolution, eventName === 'PostToolUse' ? { chosen: ['JSON'], note: '' } : null);
    assert.equal(decision(restored).resolvedAt, new Date(NOW + 10).toISOString());
    assert.equal(decision(restored).inferredWithdrawalHookAt, undefined);
    const reloaded = await restart(restored);
    reloaded.addEvent(progress('Stop', NOW + 30));
    assert.deepEqual(decision(reloaded), decision(restored));
  }
});

test('推定の印がない保存済みの取り下げは古い終了フックで訂正しない', async () => {
  const state = new DashboardState();
  state.addEvent(ask());
  state.addEvent(progress('Stop', NOW + 20));
  delete state.plans.get('session-a').decisions[0].inferredWithdrawalHookAt;
  const restored = await restart(state);
  restored.addEvent(ask('ask-1', NOW + 10, { hook_event_name: 'PostToolUse', decisionResolution: { chosen: ['JSON'], note: '' } }));
  assert.equal(decision(restored).state, 'withdrawn');
  assert.equal(decision(restored).resolution, null);
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

test('出し直し前の呼び出しの遅れた終了フックは推定の取り下げを訂正しない', async () => {
  for (const restarts of [false, true]) {
    for (const eventName of ['PostToolUse', 'PostToolUseFailure']) {
      let state = new DashboardState();
      state.addEvent(ask());
      state.addEvent(ask('ask-2', NOW + 5));
      state.addEvent(progress('Stop', NOW + 20));
      if (restarts) state = await restart(state);
      state.addEvent(ask('ask-1', NOW + 2, { hook_event_name: eventName, decisionResolution: { chosen: ['JSON'], note: '' } }));
      assert.equal(decision(state).state, 'withdrawn');
      assert.equal(decision(state).resolution, null);
      assert.equal(decision(state).finishedByToolUseId, 'ask-2');
    }
  }
});
