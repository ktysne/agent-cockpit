const test = require('node:test');
const assert = require('node:assert/strict');
const { runAnswerHook } = require('../src/hooks/answer');
const { runAwayHook } = require('../src/hooks/away');
const { runHook } = require('../src/hooks/event');
const { hookHeaders, jsonBody, request, startTestServer, uiHeaders } = require('./support/server');

const QUESTIONS = [{ title: '保存の形式は', options: ['JSON', 'CSV'] }];

async function fixture(t, { answerWaitMs = 1000, toolName = 'request_user_input_async' } = {}) {
  let now = Date.now();
  let fetchCount = 0;
  let away = true;
  const c = await startTestServer(t, {
    away: { snapshot: () => ({ enabled: away, since: away ? now : null }) },
    answerDeliveryOptions: { now: () => now, answerWaitMs },
  });
  c.runtime.state.addEvent({ session_id: 'thread', provider: 'codex', hook_event_name: 'SessionStart', hookAt: now });

  const fetchToServer = (beforeAskPoll = async () => {}) => async (url, init = {}) => {
    fetchCount += 1;
    const body = init.body ? JSON.parse(init.body) : null;
    if (body?.action === 'ask-poll') await beforeAskPoll();
    const response = await request(c.info.port, {
      method: init.method,
      path: new URL(url).pathname,
      headers: init.headers,
      body: init.body || '',
    });
    return { ok: response.status === 200, status: response.status, json: async () => jsonBody(response) };
  };
  const askForAnswer = async () => runAwayHook({
    session_id: 'thread',
    hook_event_name: 'PreToolUse',
    tool_name: toolName,
    tool_use_id: 'ask-1',
    tool_input: { questions: toolName === 'request_user_input_async' ? QUESTIONS : [{
      id: 'format', header: '形式', question: '保存の形式は',
      options: [{ label: 'JSON (Recommended)', description: '構造を保つ' }, { label: 'CSV', description: '表で読む' }],
    }] },
  }, {
    homeDir: c.homeDir,
    provider: 'codex',
    now: () => now,
    fetchImpl: fetchToServer(async () => { now += answerWaitMs + 1; }),
  });
  const answer = (decisionId) => request(c.info.port, {
    method: 'POST',
    path: '/api/decisions/' + decisionId + '/answer',
    headers: uiHeaders(c.info, 'http://127.0.0.1:' + c.info.port),
    body: JSON.stringify({ session_id: 'thread', choice: 'pick', picks: [['CSV']], note: 'CSVを使う' }),
  });
  const run = (fields) => runAnswerHook({
    session_id: 'thread',
    ...fields,
  }, {
    homeDir: c.homeDir,
    provider: 'codex',
    now: () => now,
    fetchImpl: fetchToServer(),
  });

  return {
    ...c,
    askForAnswer,
    answer,
    run,
    event: (fields) => runHook({ session_id: 'thread', ...fields }, {
      homeDir: c.homeDir, provider: 'codex', now, fetchImpl: fetchToServer(), environment: {},
    }),
    snapshotDecision: async () => jsonBody(await request(c.info.port, { path: '/api/state' }))
      .sessions.find((session) => session.session_id === 'thread').decisions[0],
    decision: () => c.runtime.state.decisionsFor('thread')[0],
    now: () => now,
    advance: (milliseconds) => { now += milliseconds; },
    fetchCount: () => fetchCount,
    returnFromAway: () => { away = false; },
  };
}

async function createLateAnswer(c) {
  await c.askForAnswer();
  assert.equal(c.decision().state, 'provisional');
  const response = await c.answer(c.decision().id);
  assert.equal(response.status, 200);
}

test('期限後の回答は次の PostToolUse の additionalContext に入り配信済みになる', async (t) => {
  const c = await fixture(t);
  await createLateAnswer(c);

  const result = await c.run({ hook_event_name: 'PostToolUse' });

  assert.equal(result.output.hookSpecificOutput.hookEventName, 'PostToolUse');
  assert.match(result.output.hookSpecificOutput.additionalContext, /「保存の形式は」は「CSV」/);
  assert.match(result.output.hookSpecificOutput.additionalContext, /指示: CSVを使う/);
  assert.ok(c.decision().answer.deliveredAt);
});

test('期限後の回答は次の UserPromptSubmit の additionalContext に入り配信済みになる', async (t) => {
  const c = await fixture(t);
  await createLateAnswer(c);

  const result = await c.run({ hook_event_name: 'UserPromptSubmit' });

  assert.equal(result.output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
  assert.match(result.output.hookSpecificOutput.additionalContext, /「保存の形式は」は「CSV」/);
  assert.ok(c.decision().answer.deliveredAt);
  assert.equal(c.decision().answer.promptDeliveries, 1);
});

for (const toolName of ['request_user_input_async', 'request_user_input']) {
  for (const eventFirst of [true, false]) {
    test(`${toolName} の期限後の回答は入力の${eventFirst ? 'イベント' : '回答'}フックが先でも届き、元の画面で回答済みにならない`, async (t) => {
      const c = await fixture(t, { toolName });
      await createLateAnswer(c);
      c.returnFromAway();
      c.advance(5);
      const input = { hook_event_name: 'UserPromptSubmit' };
      if (eventFirst) await c.event(input);
      const result = await c.run(input);
      if (!eventFirst) await c.event(input);

      assert.match(result.output.hookSpecificOutput.additionalContext, /「保存の形式は」は「CSV」/);
      assert.equal(result.output.hookSpecificOutput.hookEventName, 'UserPromptSubmit');
      await c.event({ hook_event_name: 'Stop' });
      const decision = await c.snapshotDecision();
      assert.equal(decision.state, 'provisional');
      assert.equal(decision.resolution, null);
      assert.ok(decision.answer.deliveredAt);
      assert.equal(decision.answer.promptDeliveries, 1);
    });
  }

  test(`${toolName} の離席中の仮適用は回答がなくても次の入力で閉じない`, async (t) => {
    const c = await fixture(t, { toolName });
    await c.askForAnswer();
    c.returnFromAway();
    c.advance(5);
    await c.event({ hook_event_name: 'UserPromptSubmit' });
    assert.equal((await c.run({ hook_event_name: 'UserPromptSubmit' })).output, null);

    const decision = await c.snapshotDecision();
    assert.equal(decision.state, 'provisional');
    assert.equal(decision.resolution, null);
    assert.ok(decision.provisionalAt);
  });
}

test('期限後の回答を反映して解決済みにした判断事項はイベントの再派生後も回答内容を保つ', async (t) => {
  const c = await fixture(t);
  await createLateAnswer(c);
  c.returnFromAway();
  c.advance(5);
  await c.event({ hook_event_name: 'UserPromptSubmit' });
  await c.run({ hook_event_name: 'UserPromptSubmit' });
  const response = await request(c.info.port, {
    method: 'POST', path: '/api/sessions/thread/plan', headers: hookHeaders(c.info.secret),
    body: JSON.stringify({ kind: 'update_decision', id: c.decision().id,
      state: 'resolved', chosen: ['CSV'], note: 'CSVを使う' }),
  });
  assert.equal(response.status, 200);
  c.advance(5);
  await c.event({ hook_event_name: 'UserPromptSubmit' });
  await c.event({ hook_event_name: 'Stop' });

  const decision = await c.snapshotDecision();
  assert.equal(decision.state, 'resolved');
  assert.deepEqual(decision.resolution, { chosen: ['CSV'], note: 'CSVを使う' });
  assert.ok(decision.answer.reflectedAt);
});

test('在席中、未配信の回答がある Stop は一度だけ block する', async (t) => {
  const c = await fixture(t);
  await createLateAnswer(c);
  c.returnFromAway();

  const first = await c.run({ hook_event_name: 'Stop' });
  const second = await c.run({ hook_event_name: 'Stop' });

  assert.equal(first.output.decision, 'block');
  assert.match(first.output.reason, /「保存の形式は」は「CSV」/);
  assert.match(first.output.reason, /指示: CSVを使う/);
  assert.ok(c.decision().answer.deliveredAt);
  assert.equal(second.output, null);
});

test('在席中、未配信の回答がない Stop と PostToolUse は出力しない', async (t) => {
  const c = await fixture(t);
  c.returnFromAway();

  for (const hook_event_name of ['Stop', 'PostToolUse']) {
    const result = await c.run({ hook_event_name });
    assert.equal(result.output, null);
  }
});

test('Codex の子の PostToolUse と Stop は出力しない', async (t) => {
  const c = await fixture(t);
  const fetchCount = c.fetchCount();

  for (const hook_event_name of ['PostToolUse', 'Stop']) {
    const result = await c.run({ hook_event_name, agent_id: 'child' });
    assert.equal(result.output, null);
  }

  assert.equal(c.fetchCount(), fetchCount);
});

test('古い Stop は未配信の回答を届けない', async (t) => {
  const c = await fixture(t);
  await c.askForAnswer();
  c.advance(5);
  await c.run({ hook_event_name: 'UserPromptSubmit' });
  const response = await c.answer(c.decision().id);
  assert.equal(response.status, 200);
  c.advance(-5);

  const result = await c.run({ hook_event_name: 'Stop' });

  assert.equal(result.output, null);
  assert.equal(c.decision().answer.deliveredAt, null);
});
