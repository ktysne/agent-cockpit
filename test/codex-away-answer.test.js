const test = require('node:test');
const assert = require('node:assert/strict');
const { runAwayHook } = require('../src/hooks/away');
const { denyAnswerOutput } = require('../src/server/decision-answers');
const { makeHookEvent } = require('../src/hooks/event');
const { hookHeaders, uiHeaders, jsonBody, request, startTestServer } = require('./support/server');

const QUESTIONS = [{ title: '保存の形式は', options: ['JSON', 'CSV'] }];
const PLAN_QUESTIONS = [{ id: 'format', header: '形式', question: '保存の形式は',
  options: [{ label: 'JSON (Recommended)', description: '構造を保つ' }, { label: 'CSV', description: '表で読む' }] }];

async function fixture(t, { enabled = true, ...deliveryOptions } = {}) {
  let now = Date.now();
  const c = await startTestServer(t, {
    away: { snapshot: () => ({ enabled, since: enabled ? now : null }) },
    answerDeliveryOptions: { now: () => now, ...deliveryOptions },
  });
  c.runtime.state.addEvent({ session_id: 'thread', provider: 'codex', hook_event_name: 'SessionStart', hookAt: now });
  const input = (fields = {}) => ({ session_id: 'thread', hook_event_name: 'PreToolUse',
    tool_name: 'request_user_input_async', tool_use_id: 'ask-1', tool_input: { questions: QUESTIONS }, ...fields });
  const post = async (body) => jsonBody(await request(c.info.port, { method: 'POST', path: '/api/hooks/answers',
    headers: hookHeaders(c.info.secret), body: JSON.stringify({ event_name: 'PreToolUse', session_id: 'thread',
      id: 'ask-1', provider: 'codex', tool_name: 'request_user_input_async', ...body }) }));
  const answer = async (decisionId, body) => request(c.info.port, { method: 'POST', path: `/api/decisions/${decisionId}/answer`,
    headers: uiHeaders(c.info, `http://127.0.0.1:${c.info.port}`), body: JSON.stringify({ session_id: 'thread', ...body }) });
  const run = (fields = {}, beforePoll = async () => {}) => runAwayHook(input(fields), {
    homeDir: c.homeDir, provider: 'codex', now: () => now,
    fetchImpl: async (url, init) => {
      if (init.body && JSON.parse(init.body).action === 'ask-poll') await beforePoll();
      const response = await request(c.info.port, { method: init.method, path: new URL(url).pathname,
        headers: init.headers, body: init.body || '' });
      return { ok: response.status === 200, status: response.status, json: async () => jsonBody(response) };
    },
  });
  return { ...c, input, post, answer, run, now: () => now, advance: milliseconds => { now += milliseconds; },
    decision: () => c.runtime.state.decisionsFor('thread')[0] };
}

test('Codex の質問は在席中は待たず hookOutput を返さない', async (t) => {
  const c = await fixture(t, { enabled: false });
  assert.equal(await c.run(), null);
  assert.deepEqual(await c.post({ action: 'ask-register', questions: QUESTIONS }), { awaiting: false, hookOutput: null });
});

test('両方の Codex 質問ツールは選んだ label と指示を拒否理由で返して解決済みにする', async (t) => {
  for (const [tool_name, questions] of [['request_user_input_async', QUESTIONS], ['request_user_input', PLAN_QUESTIONS]]) {
    const c = await fixture(t);
    c.runtime.state.addEvent(makeHookEvent(c.input({ tool_name, tool_input: { questions } }), c.now(), { provider: 'codex' }));
    const result = await c.run({ tool_name, tool_input: { questions } }, async () => {
      assert.equal((await c.answer(c.decision().id, { choice: 'pick', picks: [['CSV']], note: '理由を記録する' })).status, 200);
    });
    assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /開発者がダッシュボードで回答/);
    assert.match(result.hookSpecificOutput.permissionDecisionReason, /保存の形式は → CSV\n開発者の指示: 理由を記録する$/);
    assert.equal(c.runtime.state.decisionsFor('thread').length, 1);
    assert.equal(c.decision().state, 'resolved');
    assert.deepEqual(c.decision().resolution, { chosen: ['CSV'], note: '理由を記録する' });
    assert.ok(c.decision().answer.reflectedAt);
  }
});

test('回答で解決した後に同じ呼び出しの開始が新しい時刻で届いても解決済みを保つ', async (t) => {
  const c = await fixture(t);
  await c.run({}, async () => {
    assert.equal((await c.answer(c.decision().id, { choice: 'pick', picks: [['CSV']], note: '' })).status, 200);
  });
  c.advance(1000);
  c.runtime.state.addEvent(makeHookEvent(c.input(), c.now(), { provider: 'codex' }));
  assert.equal(c.decision().state, 'resolved');
  assert.deepEqual(c.decision().resolution, { chosen: ['CSV'], note: '' });
});

test('Codex の期限の拒否文は Claude の文のツール名を替え、適用する推奨を書き添えて仮適用になる', async (t) => {
  const c = await fixture(t, { answerWaitMs: 1000 });
  const result = await c.run({}, async () => c.advance(1001));
  assert.equal(c.decision().state, 'provisional');
  const claudeReason = denyAnswerOutput(c.decision().id).hookSpecificOutput.permissionDecisionReason;
  const [reason, ...recommendations] = result.hookSpecificOutput.permissionDecisionReason.split('\n');
  assert.equal(reason, claudeReason.replace('AskUserQuestion', 'request_user_input_async'));
  assert.deepEqual(recommendations, ['推奨: 保存の形式は → JSON']);
});

test('Codex の推奨案への OK は先頭の label を回答して解決済みにする', async (t) => {
  const c = await fixture(t);
  const result = await c.run({}, async () => {
    assert.equal((await c.answer(c.decision().id, { choice: 'ok', note: '' })).status, 200);
  });
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /保存の形式は → JSON$/);
  assert.deepEqual(c.decision().resolution, { chosen: ['JSON'], note: '' });
  assert.equal(c.decision().state, 'resolved');
});

test('自由記入を含む Codex の期限は推奨と仮定で進めるよう拒否して仮適用にする', async (t) => {
  const c = await fixture(t, { answerWaitMs: 1000 });
  const result = await c.run({ tool_input: { questions: [...QUESTIONS, { title: '保存先は' }] } }, async () => c.advance(1001));
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /推奨のある質問は推奨/);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /推奨の無い質問は仮定を置いて自分の判断/);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /cockpit_update_decision.*置いた仮定/);
  assert.equal(c.decision().state, 'provisional');
});

test('選択と自由記入を含む回答は本文を拒否理由に入れ OK は受け付けない', async (t) => {
  const c = await fixture(t);
  const result = await c.run({ tool_input: { questions: [...QUESTIONS, { title: '保存先は' }] } }, async () => {
    assert.equal((await c.answer(c.decision().id, { choice: 'ok', note: '' })).status, 400);
    assert.equal((await c.answer(c.decision().id, { choice: 'pick', picks: [['CSV'], []], note: '作業ディレクトリ' })).status, 200);
  });
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /保存先は → 作業ディレクトリ/);
  assert.equal(c.decision().state, 'resolved');
});

test('自由記入だけの Codex の質問は note の本文で回答できる', async (t) => {
  const c = await fixture(t);
  const result = await c.run({ tool_input: { questions: [{ title: '保存先は' }] } }, async () => {
    assert.equal((await c.answer(c.decision().id, { choice: null, note: '作業ディレクトリ' })).status, 200);
  });
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /保存先は → 作業ディレクトリ/);
  assert.deepEqual(c.decision().resolution, { chosen: ['作業ディレクトリ'], note: '作業ディレクトリ' });
});

test('Codex の子は離席中は拒否し質問を登録しない', async (t) => {
  const c = await fixture(t);
  const output = await c.run({ agent_id: 'child' });
  assert.equal(output.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(output.hookSpecificOutput.permissionDecisionReason, /推奨: 保存の形式は → JSON$/);
  assert.equal(c.decision(), undefined);
});

test('セッション行の無い委譲 thread は離席中も待たず通す', async (t) => {
  const c = await fixture(t);
  assert.equal(await c.run({ session_id: 'delegated' }), null);
  assert.equal(c.runtime.state.sessions.has('delegated'), false);
});

test('Codex のポーリングが途絶えると回答待ちを解除する', async (t) => {
  const c = await fixture(t, { maxAskPollGapMs: 1000 });
  const registered = await c.post({ action: 'ask-register', questions: QUESTIONS });
  assert.equal(registered.awaiting, true);
  c.advance(1001);
  assert.deepEqual(await c.post({ action: 'ask-poll' }), { outcome: 'released' });
  assert.deepEqual(await c.post({ action: 'ask-finish', outcome: 'released' }), { outcome: 'released', hookOutput: null });
  assert.equal(c.decision().awaitingAnswerUntil ?? null, null);
  assert.equal(c.decision().state, 'waiting');
});

test('Codex の SessionStart と UserPromptSubmit は Claude と同じ離席とタスクと再開の文脈を返す', async (t) => {
  const c = await fixture(t);
  for (const fields of [{ hook_event_name: 'SessionStart', source: 'resume' }, { hook_event_name: 'UserPromptSubmit' }]) {
    const input = c.input(fields);
    const codex = await runAwayHook(input, { homeDir: c.homeDir, provider: 'codex' });
    const claude = await runAwayHook(input, { homeDir: c.homeDir });
    assert.deepEqual(codex, claude);
    assert.match(codex.hookSpecificOutput.additionalContext, /開発者は離席中/);
    assert.match(codex.hookSpecificOutput.additionalContext, /cockpit_set_tasks/);
    if (fields.source === 'resume') assert.match(codex.hookSpecificOutput.additionalContext, /現在の状態/);
  }
});
