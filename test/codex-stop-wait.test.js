const test = require('node:test');
const assert = require('node:assert/strict');
const { runAnswerHook } = require('../src/hooks/answer');
const { runAwayHook } = require('../src/hooks/away');
const { jsonBody, request, startTestServer, uiHeaders } = require('./support/server');

const QUESTIONS = [{ title: '保存の形式は', options: ['JSON', 'CSV'] }];

async function fixture(t, { answerWaitMs = 10, maxLongPollMs = 10, awayEnabled = true } = {}) {
  let now = Date.now();
  let beforeStopPoll = null;
  const actions = [];
  const c = await startTestServer(t, {
    away: { snapshot: () => ({ enabled: awayEnabled, since: now }) },
    answerDeliveryOptions: { now: () => now, answerWaitMs, maxLongPollMs },
  });
  c.runtime.state.addEvent({ session_id: 'thread', provider: 'codex', hook_event_name: 'SessionStart', hookAt: now });

  const fetchToServer = (beforeRequest = async () => {}) => async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : null;
    if (body?.action) actions.push(body.action);
    await beforeRequest(body);
    if (body?.action === 'stop-poll' && beforeStopPoll) {
      const action = beforeStopPoll;
      beforeStopPoll = null;
      await action();
    }
    const response = await request(c.info.port, {
      method: init.method,
      path: new URL(url).pathname,
      headers: init.headers,
      body: init.body || '',
    });
    return { ok: response.status === 200, status: response.status, json: async () => jsonBody(response) };
  };
  const run = (fields, options = {}) => runAnswerHook({ session_id: 'thread', ...fields }, {
    homeDir: c.homeDir,
    provider: 'codex',
    now: () => now,
    fetchImpl: fetchToServer(),
    codexStopWaitMs: 500,
    ...options,
  });
  const askForDecision = async () => runAwayHook({
    session_id: 'thread',
    hook_event_name: 'PreToolUse',
    tool_name: 'request_user_input_async',
    tool_use_id: 'ask-1',
    tool_input: { questions: QUESTIONS },
  }, {
    homeDir: c.homeDir,
    provider: 'codex',
    now: () => now,
    fetchImpl: fetchToServer(async (body) => {
      if (body?.action === 'ask-poll') now += answerWaitMs + 1;
    }),
  });
  const answer = (decisionId) => request(c.info.port, {
    method: 'POST',
    path: `/api/decisions/${decisionId}/answer`,
    headers: uiHeaders(c.info, `http://127.0.0.1:${c.info.port}`),
    body: JSON.stringify({ session_id: 'thread', choice: 'pick', picks: [['CSV']], note: 'CSVを使う' }),
  });

  return {
    ...c,
    actions,
    run,
    askForDecision,
    answer,
    decision: () => c.runtime.state.decisionsFor('thread')[0],
    duringStopWait: (action) => { beforeStopPoll = action; },
    advance: (milliseconds) => { now += milliseconds; },
    setAwayEnabled: (enabled) => { awayEnabled = enabled; },
  };
}

test('離席中の Stop は待機中に届いた期限後の回答を block の理由にする', async (t) => {
  const c = await fixture(t);
  await c.askForDecision();
  c.duringStopWait(async () => assert.equal((await c.answer(c.decision().id)).status, 200));

  const result = await c.run({ hook_event_name: 'Stop' });

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.decision, 'block');
  assert.match(result.output.reason, /「保存の形式は」は「CSV」/);
  assert.match(result.output.reason, /指示: CSVを使う/);
  assert.ok(c.actions.includes('stop-poll'));
});

test('離席中の Stop は待機中に届いたセッション通知を block の理由にする', async (t) => {
  const c = await fixture(t);
  c.duringStopWait(async () => c.runtime.answerDelivery.notifySessions(['thread'], 'PR の確認が完了しました。'));

  const result = await c.run({ hook_event_name: 'Stop' });

  assert.equal(result.exitCode, 0);
  assert.equal(result.output.decision, 'block');
  assert.match(result.output.reason, /PR の確認が完了しました。/);
});

test('離席中の Stop は待機中に離席が解除されると何も返さずに終わる', async (t) => {
  const c = await fixture(t);
  c.duringStopWait(async () => c.setAwayEnabled(false));

  const result = await c.run({ hook_event_name: 'Stop' });

  assert.equal(result.exitCode, 0);
  assert.equal(result.output, null);
  assert.ok(c.actions.includes('stop-poll'));
});

test('在席中の Stop は待たずに何も返さない', async (t) => {
  const c = await fixture(t, { awayEnabled: false });

  const result = await c.run({ hook_event_name: 'Stop' });

  assert.equal(result.output, null);
  assert.equal(c.actions.includes('stop-poll'), false);
});

test('セッション行の無い委譲 thread の Stop は離席中も待たない', async (t) => {
  const c = await fixture(t);

  const result = await c.run({ session_id: 'delegated', hook_event_name: 'Stop' });

  assert.equal(result.output, null);
  assert.equal(c.actions.includes('stop-poll'), false);
});

test('離席中の Stop は待機中に同じセッションの入力が始まると何も返さずに終わる', async (t) => {
  const c = await fixture(t);
  c.duringStopWait(async () => c.run({ hook_event_name: 'UserPromptSubmit' }));

  const result = await c.run({ hook_event_name: 'Stop' });

  assert.equal(result.exitCode, 0);
  assert.equal(result.output, null);
});

test('離席中の Stop は待機上限に達すると何も返さずに終わる', async (t) => {
  const c = await fixture(t, { maxLongPollMs: 5 });
  c.duringStopWait(async () => c.advance(30));

  const result = await c.run({ hook_event_name: 'Stop' }, { codexStopWaitMs: 25 });

  assert.equal(result.exitCode, 0);
  assert.equal(result.output, null);
  assert.ok(c.actions.includes('stop-poll'));
});
