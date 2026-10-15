const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHookEvent } = require('../src/hooks/event');
const { DashboardState } = require('../src/server/state');
const { startTestServer, request, hookHeaders, jsonBody } = require('./support/server');

const items = (statuses = ['in_progress', 'pending', 'pending']) => ({
  items: statuses.map((status, index) => ({ content: '段階' + (index + 1), status, session: '捨てる値' })),
  scope: 'continuation',
});

async function setup(t) {
  const state = new DashboardState();
  const { info } = await startTestServer(t, { state });
  const post = async (path, body) => request(info.port, {
    method: 'POST', path, headers: hookHeaders(info.secret), body: JSON.stringify(body),
  });
  let serial = 0;
  const send = (input, hookAt = Date.now() + ++serial, extra = {}) => post('/api/events', {
    session_id: 'plan-session', hook_event_name: 'PostToolUse',
    tool_name: 'mcp__ccd_turn__update_plan', tool_use_id: 'plan-' + ++serial,
    hookAt, planUpdate: input, ...extra,
  });
  const tasks = () => state.snapshot().sessions.find(session => session.session_id === 'plan-session')?.tasks || [];
  const write = tasks => post('/api/sessions/plan-session/plan', { kind: 'tasks', tasks });
  return { state, send, tasks, write, post };
}

test('items は一覧と状態を置き換え、同じ呼び出しの差分と不要なキーを使わない', async t => {
  const { send, tasks, write } = await setup(t);
  await write([{ title: '置き換える前の題', state: 'todo', criteria: [] }]);
  await send({ ...items(), advance: true });
  assert.deepEqual(tasks().map(({ title, state, criteria }) => ({ title, state, criteria })), [
    { title: '段階1', state: 'doing', criteria: [] },
    { title: '段階2', state: 'todo', criteria: [] },
    { title: '段階3', state: 'todo', criteria: [] },
  ]);
});

test('advance は作業中を完了にし、その後ろの未着手を開始する', async t => {
  const { send, tasks } = await setup(t);
  await send(items(), 100);
  await send({ advance: true }, 200);
  assert.deepEqual(tasks().map(task => task.state), ['done', 'doing', 'todo']);
});

test('作業中が無い advance は最初の未着手を開始する', async t => {
  const { send, tasks } = await setup(t);
  await send(items(['completed', 'pending', 'pending']), 100);
  await send({ advance: true }, 200);
  assert.deepEqual(tasks().map(task => task.state), ['done', 'doing', 'todo']);
});

test('done と start は 1 始まりの番号で更新し、範囲外を無視する', async t => {
  const { send, tasks } = await setup(t);
  await send(items(), 100);
  await send({ done: [1, 2, 99, -1], start: 3 }, 200);
  assert.deepEqual(tasks().map(task => task.state), ['done', 'done', 'doing']);
});

test('差分が順不同に届いても hookAt 順に当て直す', async t => {
  const { send, tasks } = await setup(t);
  await send({ advance: true }, 300);
  await send(items(), 100);
  await send({ advance: true }, 200);
  assert.deepEqual(tasks().map(task => task.state), ['done', 'done', 'doing']);
});

test('古い items は最新の items を置き換えない', async t => {
  const { send, tasks } = await setup(t);
  await send(items(['completed']), 300);
  await send(items(), 100);
  assert.deepEqual(tasks().map(task => task.state), ['done']);
});

test('同じ tool_use_id が重複しても差分を重ねない', async t => {
  const { send, tasks } = await setup(t);
  await send(items(), 100);
  await send({ advance: true }, 200, { tool_use_id: 'same' });
  await send({ advance: true }, 300, { tool_use_id: 'same' });
  assert.deepEqual(tasks().map(task => task.state), ['done', 'doing', 'todo']);
});

test('前後の空白を除いた題が同じなら完了条件を引き継ぐ', async t => {
  const { send, tasks, write } = await setup(t);
  const criteria = [{ text: '確認できる', met: true }];
  await write([{ title: '段階1 ', state: 'todo', criteria }]);
  await send(items(), 100);
  assert.deepEqual(tasks()[0].criteria, criteria);
});

test('new_task の items は題が同じでも完了条件を引き継がない', async t => {
  const { send, tasks, write } = await setup(t);
  await write([{ title: '段階1', state: 'todo', criteria: [{ text: '確認できる', met: true }] }]);
  await send({ ...items(), scope: 'new_task' }, 100);
  assert.deepEqual(tasks()[0].criteria, []);
});

test('取り込み後の PostToolBatch はタスク未登録の催促を返さない', async t => {
  const { send, post } = await setup(t);
  await post('/api/events', { session_id: 'plan-session', hook_event_name: 'PreToolUse', tool_name: 'Agent' });
  await send(items());
  const response = await post('/api/hooks/answers', { action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: 'plan-session', id: 'batch' });
  assert.equal(jsonBody(response).hookOutput, null);
});

test('agent_id 付きと codex のイベントは一覧を取り込まない', async t => {
  const { send, state } = await setup(t);
  for (const extra of [{ agent_id: 'child' }, { provider: 'codex', session_id: 'codex-session' }]) await send(items(), undefined, extra);
  assert.deepEqual(state.snapshot().sessions.flatMap(session => session.tasks), []);
});

test('形が違う入力は丸ごと無視してタスクを書き換えない', async t => {
  const { send, tasks } = await setup(t);
  await send(items(), 100);
  const before = tasks();
  for (const invalid of [null, { items: {} }, { items: [{ content: '段階', status: 'unknown' }] },
    { items: [{ content: 'x'.repeat(201), status: 'pending' }] }, { items: Array(13).fill({ content: '段階', status: 'pending' }) },
    { items: Array(2).fill({ content: '重複する題', status: 'pending' }) },
    { done: ['1'], start: 2 }, { advance: false }, { start: 1.5 }]) await send(invalid, 200);
  assert.deepEqual(tasks(), before);
});

test('cockpit_set_tasks は後から一覧を置き換え、基準に無い題を応答に添える', async t => {
  const { send, tasks, write } = await setup(t);
  await send(items(), 100);
  const response = await write([{ title: '別の題', state: 'doing', criteria: [] }]);
  assert.deepEqual(jsonBody(response).unmatchedTitles, ['別の題']);
  assert.deepEqual(tasks().map(task => task.title), ['別の題']);
});

test('items が無い差分は最初の保存済み一覧を固定した基準として再構成する', async t => {
  const { state, send, tasks } = await setup(t);
  state.setTasks('plan-session', [1, 2, 3].map(index => ({ title: '段階' + index, state: 'todo', criteria: [] })), 100);
  await send({ advance: true }, 300);
  await send({ advance: true }, 200);
  await send({ done: [3] }, 50);
  assert.deepEqual(tasks().map(task => task.state), ['done', 'doing', 'todo']);
});

for (const lifecycle of ['終了', '削除']) {
  test('セッション' + lifecycle + '後はアプリの基準と重複記録を引き継がない', async t => {
    const { send, write, post, state } = await setup(t);
    const at = Date.now();
    await send(items(), at, { tool_use_id: 'reused' });
    if (lifecycle === '終了') await post('/api/events', { session_id: 'plan-session', hook_event_name: 'SessionEnd', hookAt: at + 1 });
    else state.deleteSession('plan-session', at + 1);
    const response = await write([{ title: '別の題', state: 'todo', criteria: [] }]);
    assert.deepEqual(jsonBody(response).unmatchedTitles, []);
    await post('/api/events', { session_id: 'plan-session', hook_event_name: 'SessionStart', hookAt: at + 2 });
    await send(items(), at + 3, { tool_use_id: 'reused' });
    assert.deepEqual(jsonBody(await write([{ title: '別の題', state: 'todo', criteria: [] }])).unmatchedTitles, ['別の題']);
  });
}

test('フックは Claude メインの PostToolUse の update_plan だけ検査済み入力を送る', () => {
  const input = { session_id: 'plan-session', hook_event_name: 'PostToolUse', tool_name: 'mcp__ccd_turn__update_plan', tool_input: items(), tool_response: '使わない結果' };
  const event = makeHookEvent(input, 100);
  assert.equal(event.planUpdate.items[0].session, undefined);
  assert.equal(event.planUpdate.items[0].content, '段階1');
  assert.ok(!JSON.stringify(event).includes('使わない結果'));
  for (const patch of [{ hook_event_name: 'PreToolUse' }, { hook_event_name: 'PostToolUseFailure' }, { agent_id: 'child' }, { tool_name: 'other' }, { tool_input: { advance: false } }]) {
    assert.equal(makeHookEvent({ ...input, ...patch }, 100).planUpdate, undefined);
  }
  assert.equal(makeHookEvent(input, 100, { provider: 'codex' }).planUpdate, undefined);
});
