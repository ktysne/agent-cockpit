const test = require('node:test');
const assert = require('node:assert/strict');
const { runAwayHook } = require('../src/hooks/away');
const { makeHookEvent } = require('../src/hooks/event');
const { hookHeaders, uiHeaders, jsonBody, request, startTestServer } = require('./support/server');

const TOOL = 'mcp__ccd_turn__wrap_up';
const INPUT = { recap: '保存処理を実装した', ask: '形式はどうしますか', actions: [
  { label: 'JSON', message: '構造を保って保存する' },
  { label: 'CSV (推奨)', message: '表として保存する' },
] };

async function fixture(t, enabled = true) {
  let now = Date.now();
  const c = await startTestServer(t, {
    away: { snapshot: () => ({ enabled, since: enabled ? now : null }) },
    answerDeliveryOptions: { now: () => now, answerWaitMs: 1000 },
  });
  const input = fields => ({ session_id: 'session', hook_event_name: 'PreToolUse', tool_name: TOOL,
    tool_use_id: 'wrap-1', tool_input: INPUT, ...fields });
  const answer = body => request(c.info.port, { method: 'POST', path: '/api/decisions/wrap-1/answer',
    headers: uiHeaders(c.info, `http://127.0.0.1:${c.info.port}`), body: JSON.stringify({ session_id: 'session', ...body }) });
  const run = (fields = {}, beforePoll = () => { now += 1001; }) => runAwayHook(input(fields), {
    homeDir: c.homeDir, now: () => now,
    fetchImpl: async (url, init) => {
      if (init.body && JSON.parse(init.body).action === 'ask-poll') await beforePoll();
      const response = await request(c.info.port, { method: init.method, path: new URL(url).pathname,
        headers: init.headers, body: init.body || '' });
      return { ok: response.status === 200, status: response.status, json: async () => jsonBody(response) };
    },
  });
  return { ...c, input, answer, run, decision: () => c.runtime.state.decisionsFor('session')[0] };
}

test('wrap_up は判断事項に質問と recap と先頭が推奨の選択肢を出し回答を拒否理由で返す', async t => {
  const c = await fixture(t);
  const result = await c.run({}, async () => {
    const decision = c.decision();
    assert.equal(decision.source, 'ask');
    assert.equal(decision.title, INPUT.ask);
    assert.equal(decision.context, INPUT.recap);
    assert.deepEqual(decision.questions[0].options.map(option => option.recommended), [true, false]);
    assert.equal((await c.answer({ choice: 'pick', picks: [['CSV (推奨)']], note: '一覧にする' })).status, 200);
  });
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /^開発者の回答の知らせです/);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /CSV \(推奨\)\n表として保存する/);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /一覧にする/);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /ask を付けずに/);
  assert.equal(c.decision().state, 'resolved');
  assert.ok(c.decision().answer.deliveredAt);
});

test('wrap_up の時間切れは先頭の推奨と message で継続させ仮適用を残す', async t => {
  const c = await fixture(t);
  const result = await c.run();
  assert.equal(result.hookSpecificOutput.permissionDecision, 'deny');
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /^推奨の適用の知らせです/);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /推奨「JSON」.*構造を保って保存する/);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /あなたの判断が必要なこと/);
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /ask を付けずに/);
  c.runtime.state.addEvent(makeHookEvent(c.input({ hook_event_name: 'PostToolUseFailure', error: 'hook denied' })));
  assert.equal(c.decision().state, 'provisional');
});

test('actions の無い wrap_up の時間切れは推奨を判断できないと伝える', async t => {
  const c = await fixture(t);
  const result = await c.run({ tool_input: { ask: '保存先は' } });
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /推奨を判断できないため、判断待ちとして最後の報告に書いて作業を続けて/);
  assert.equal(c.decision().state, 'provisional');
});

test('wrap_up の推奨への OK は先頭の選択肢と message を返す', async t => {
  const c = await fixture(t);
  const result = await c.run({}, async () => {
    assert.equal((await c.answer({ choice: 'ok', note: '' })).status, 200);
  });
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /→ JSON\n構造を保って保存する/);
});

test('wrap_up の自由記入の回答を拒否理由に返す', async t => {
  const c = await fixture(t);
  const result = await c.run({ tool_input: { ask: '保存先は' } }, async () => {
    assert.equal((await c.answer({ choice: null, note: '作業ディレクトリ' })).status, 200);
  });
  assert.match(result.hookSpecificOutput.permissionDecisionReason, /保存先は → 作業ディレクトリ/);
});

test('在席中と ask の無い wrap_up とサブエージェントは出力も判断事項も作らない', async t => {
  for (const [enabled, fields] of [[false, {}], [true, { tool_input: { recap: '完了' } }], [true, { agent_id: 'child' }]]) {
    const c = await fixture(t, enabled);
    assert.equal(await c.run(fields), null);
    assert.equal(c.decision(), undefined);
  }
});

test('拒否した wrap_up はタスクを完了にせず ask の無い再呼び出しの PostToolUse で完了にする', async t => {
  const c = await fixture(t);
  c.runtime.state.patchDisplayPreferences({ importAppTasks: true });
  const post = body => request(c.info.port, { method: 'POST', path: '/api/events',
    headers: hookHeaders(c.info.secret), body: JSON.stringify(body) });
  await post(makeHookEvent(c.input({ hook_event_name: 'PostToolUse', tool_name: 'mcp__ccd_turn__update_plan',
    tool_use_id: 'plan-1', tool_input: { items: [{ content: '保存', status: 'in_progress' }] } }), 1));
  const task = () => c.runtime.state.snapshot().sessions.find(session => session.session_id === 'session').tasks[0];
  await c.run();
  assert.equal(task().state, 'doing');
  await post(makeHookEvent(c.input({ hook_event_name: 'PostToolUse', tool_use_id: 'wrap-2', tool_input: { recap: '完了' } })));
  assert.equal(task().state, 'done');
  assert.ok(task().criteria.every(item => item.met));
});
