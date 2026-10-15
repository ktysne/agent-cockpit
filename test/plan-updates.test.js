const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHookEvent } = require('../src/hooks/event');
const { DashboardState } = require('../src/server/state');
const { startTestServer, request, hookHeaders, uiHeaders, jsonBody } = require('./support/server');

const items = (statuses = ['in_progress', 'pending', 'pending']) => ({
  items: statuses.map((status, index) => ({ content: '段階' + (index + 1), status, session: '捨てる値' })),
  scope: 'continuation',
});

async function setup(t) {
  const state = new DashboardState();
  state.patchDisplayPreferences({ importAppTasks: true });
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
  const tasks = (sessionId = 'plan-session') => state.snapshot().sessions.find(session => session.session_id === sessionId)?.tasks || [];
  const write = (tasks, sessionId = 'plan-session') => post(`/api/sessions/${sessionId}/plan`, { kind: 'tasks', tasks });
  const display = importAppTasks => request(info.port, {
    method: 'POST', path: '/api/display',
    headers: { ...uiHeaders(info, `http://127.0.0.1:${info.port}`), 'content-type': 'application/json' },
    body: JSON.stringify({ importAppTasks }),
  });
  await post('/api/events', { session_id: 'plan-session', hook_event_name: 'SessionStart', hookAt: 0 });
  return { state, send, tasks, write, post, display };
}

const criteria = () => [
  { text: '段階1', met: false, doing: true },
  { text: '段階2', met: false },
  { text: '段階3', met: false },
];
const progress = tasks => tasks.at(-1)?.criteria.map(item => item.met ? 'done' : item.doing ? 'doing' : 'todo');

test('items は題だけのタスクへ完了条件を入れ、同じ入力の差分は使わない', async t => {
  const { send, tasks, write } = await setup(t);
  await write([{ title: '依頼', state: 'doing' }]);
  await send({ ...items(), scope: 'new_task', advance: true });
  assert.equal(tasks().length, 1);
  assert.equal(tasks()[0].title, '依頼');
  assert.deepEqual(tasks()[0].criteria, criteria());
});

test('全項目が completed ならタスクが done になる', async t => {
  const { send, tasks } = await setup(t);
  await send(items(['completed', 'completed']), 100);
  assert.equal(tasks()[0].state, 'done');
  assert.deepEqual(progress(tasks()), ['done', 'done']);
});

test('new_task は前の完了条件を保って done にし、番号付きの新しい題を足す', async t => {
  const { send, tasks } = await setup(t);
  await send(items(), 100);
  await send({ ...items(), scope: 'new_task' }, 200);
  await send({ ...items(), scope: 'new_task' }, 300);
  assert.deepEqual(tasks().map(task => task.title), ['作業', '作業 (2)', '作業 (3)']);
  assert.deepEqual(tasks().map(task => task.state), ['done', 'done', 'doing']);
  assert.deepEqual(tasks()[0].criteria, criteria());
});

for (const scope of ['continuation', 'first_task', undefined]) {
  test('scope が ' + scope + ' の items は今の完了条件を置き換える', async t => {
    const { send, tasks } = await setup(t);
    await send(items(), 100);
    await send({ ...items(['pending']), scope }, 200);
    assert.equal(tasks().length, 1);
    assert.deepEqual(progress(tasks()), ['todo']);
  });
}

test('自動の題は状態のセッション名とセッション一覧の名前を使う', async t => {
  const { send, tasks, post, state } = await setup(t);
  state.addEvent({ session_id: 'plan-session', hook_event_name: 'SessionStart', hookAt: 1 }, { sessionName: '状態の名前' });
  await send(items(), 100);
  assert.equal(tasks()[0].title, '状態の名前');
  state.sessionFiles.set('plan-session', { name: '一覧の名前' });
  await send({ ...items(), scope: 'new_task' }, 200);
  assert.equal(tasks()[1].title, '一覧の名前');
});

test('advance は作業中を達成にして次の未着手を開始する', async t => {
  const { send, tasks } = await setup(t);
  await send(items(), 100);
  await send({ advance: true }, 200);
  assert.deepEqual(progress(tasks()), ['done', 'doing', 'todo']);
});

test('作業中が無い advance は最初の未着手を開始する', async t => {
  const { send, tasks } = await setup(t);
  await send(items(['completed', 'pending', 'pending']), 100);
  await send({ advance: true }, 200);
  assert.deepEqual(progress(tasks()), ['done', 'doing', 'todo']);
});

test('done と start は完了条件の番号を更新し、範囲外を無視する', async t => {
  const { send, tasks } = await setup(t);
  await send(items(), 100);
  await send({ done: [1, 2, 99, -1], start: 3 }, 200);
  assert.deepEqual(progress(tasks()), ['done', 'done', 'doing']);
  await send({ done: [3] }, 300);
  assert.equal(tasks()[0].state, 'done');
});

test('差分が items より先に届いても hookAt 順で再構成する', async t => {
  const { send, tasks } = await setup(t);
  await send({ advance: true }, 300);
  await send(items(), 100);
  await send({ advance: true }, 200);
  assert.deepEqual(progress(tasks()), ['done', 'done', 'doing']);
});

test('古い items と同じ tool_use_id は現在の完了条件を変えない', async t => {
  const { send, tasks } = await setup(t);
  await send(items(), 100);
  await send({ advance: true }, 200, { tool_use_id: 'same' });
  await send({ advance: true }, 300, { tool_use_id: 'same' });
  await send(items(['completed']), 50);
  assert.deepEqual(progress(tasks()), ['done', 'doing', 'todo']);
});

test('後から登録した題で自動の題を改名し、差分後も保つ', async t => {
  const { send, tasks, write } = await setup(t);
  await send(items(), 100);
  const response = await write([{ title: '依頼の題', state: 'doing' }]);
  assert.equal(jsonBody(response).unmatchedTitles, undefined);
  await send({ advance: true }, 200);
  assert.equal(tasks().length, 1);
  assert.equal(tasks()[0].title, '依頼の題');
  assert.deepEqual(progress(tasks()), ['done', 'doing', 'todo']);
});

test('同じ題をまとめ書きし、空でない完了条件だけ置き換えて他の題を残す', async t => {
  const { send, write, tasks } = await setup(t);
  await send({ items: [{ content: '段階1', status: 'in_progress' }] });
  await write([{ title: '前の依頼', state: 'doing', criteria: criteria() }]);
  await write([{ title: '次の依頼', state: 'doing', criteria: criteria() }]);
  await write([{ title: ' 前の依頼 ', state: 'done', criteria: [] }]);
  assert.deepEqual(tasks().map(task => task.title), ['前の依頼', '次の依頼']);
  assert.equal(tasks()[0].state, 'done');
  assert.deepEqual(tasks()[0].criteria, criteria());
  await write([{ title: '次の依頼', state: 'doing', criteria: [{ text: '確認', met: true }] }]);
  assert.deepEqual(tasks()[1].criteria, [{ text: '確認', met: true }]);
});

test('アプリの一覧を取り込んでいないセッションの 1 件の set_tasks は一覧を置き換える', async t => {
  const { write, tasks } = await setup(t);
  await write([{ title: 'A', state: 'doing', criteria: criteria() }]);
  await write([{ title: 'B', state: 'doing', criteria: [] }]);
  assert.deepEqual(tasks().map(task => `${task.title}:${task.state}`), ['B:doing']);
});

test('取り込みの印が無い保存済みの複数タスクは最初の items で一覧ごと置き換える', async t => {
  const { state, send, tasks } = await setup(t);
  state.setTasks('plan-session', [
    { title: '旧1', state: 'done', criteria: [] },
    { title: '旧2', state: 'doing', criteria: [] },
    { title: '旧3', state: 'todo', criteria: [] },
  ]);
  await send(items());
  assert.equal(tasks().length, 1);
  assert.ok(!tasks()[0].title.startsWith('旧'));
  assert.deepEqual(tasks()[0].criteria, criteria());
  await send(items(['completed', 'in_progress', 'pending']));
  assert.equal(tasks().length, 1);
});

test('取り込みの印が無い複数タスクは差分が先に届いても最初の items で置き換える', async t => {
  const { state, send, tasks } = await setup(t);
  state.setTasks('plan-session', [
    { title: '旧1', state: 'doing', criteria: [] },
    { title: '旧2', state: 'todo', criteria: [] },
  ]);
  const now = Date.now();
  await send({ advance: true }, now + 2000);
  await send(items(), now + 1000);
  assert.equal(tasks().length, 1);
  assert.ok(!tasks()[0].title.startsWith('旧'));
  assert.deepEqual(progress(tasks()), ['done', 'doing', 'todo']);
});

test('取り込みの印が無い題だけのタスク 1 件は最初の items の題として引き継ぐ', async t => {
  const { state, send, tasks } = await setup(t);
  state.setTasks('plan-session', [{ title: '依頼', state: 'doing', criteria: [] }]);
  await send(items());
  assert.deepEqual(tasks().map(task => task.title), ['依頼']);
  assert.deepEqual(tasks()[0].criteria, criteria());
});

test('一覧を置き換えた後の差分は置き換えた完了条件から進める', async t => {
  const { send, write, tasks } = await setup(t);
  await send({ items: [{ content: '古い段階', status: 'in_progress' }] });
  await write([
    { title: '依頼', state: 'doing', criteria: criteria() },
    { title: '別の依頼', state: 'todo', criteria: [] },
  ]);
  await write([{ title: '依頼', state: 'doing', criteria: criteria() }, { title: '最後', state: 'doing', criteria: criteria() }]);
  await send({ advance: true });
  assert.deepEqual(tasks().map(task => task.title), ['依頼', '最後']);
  assert.deepEqual(progress(tasks()), ['done', 'doing', 'todo']);
});

test('終えた題を作業中で登録し直すと末尾へ移り、次の一覧がそこへ入る', async t => {
  const { send, write, tasks } = await setup(t);
  await send({ items: [{ content: '段階1', status: 'in_progress' }] });
  await write([{ title: '依頼A', state: 'doing' }]);
  await send({ items: [{ content: '段階1', status: 'completed' }] });
  await write([{ title: '依頼B', state: 'doing' }]);
  await send({ items: [{ content: 'B の段階', status: 'in_progress' }], scope: 'continuation' });
  await write([{ title: '依頼A', state: 'doing' }]);
  await send({ items: [{ content: 'A の再開', status: 'in_progress' }], scope: 'continuation' });
  assert.deepEqual(tasks().map(task => `${task.title}:${task.state}`), ['依頼B:done', '依頼A:doing']);
  assert.deepEqual(tasks().at(-1).criteria.map(item => item.text), ['A の再開']);
});

test('一覧を置き換える前に作られた items が遅れて届いても置き換えた内容を保つ', async t => {
  const { send, write, tasks } = await setup(t);
  await send({ items: [{ content: '古い段階', status: 'in_progress' }] });
  const beforeReplace = Date.now() - 1000;
  await write([{ title: '依頼', state: 'doing', criteria: criteria() }, { title: '最後', state: 'doing', criteria: criteria() }]);
  await send({ items: [{ content: '遅れた段階', status: 'in_progress' }] }, beforeReplace);
  assert.deepEqual(tasks().map(task => task.title), ['依頼', '最後']);
  assert.deepEqual(tasks().at(-1).criteria, criteria());
});

test('自動の題で取り込んだ完了条件は、題を付けて一覧全体を置き換えても新しい題へ引き継ぐ', async t => {
  const { send, write, tasks } = await setup(t);
  await write([{ title: '前の依頼', state: 'done' }]);
  await send(items());
  await write([{ title: '前の依頼', state: 'done' }, { title: '新しい依頼', state: 'doing' }]);
  assert.deepEqual(tasks().map(task => task.title), ['前の依頼', '新しい依頼']);
  assert.deepEqual(tasks().at(-1).criteria, criteria());
  await send({ advance: true });
  assert.deepEqual(progress(tasks()), ['done', 'doing', 'todo']);
});

test('置き換えた題が完了条件を待つ間は、置き換えより前に作られた未着の items を受け入れる', async t => {
  const { send, write, tasks } = await setup(t);
  await write([{ title: '前の依頼', state: 'done' }]);
  const afterFirst = Date.now() + 1;
  await new Promise(resolve => setTimeout(resolve, 20));
  await write([{ title: '前の依頼', state: 'done' }, { title: '新しい依頼', state: 'doing' }]);
  await send(items(['completed', 'pending']), afterFirst - 1000);
  assert.deepEqual(tasks().at(-1).criteria, []);
  await send(items(), afterFirst);
  assert.deepEqual(tasks().map(task => task.title), ['前の依頼', '新しい依頼']);
  assert.deepEqual(tasks().at(-1).criteria, criteria());
  await send(items(['completed', 'pending']), afterFirst + 1);
  assert.deepEqual(tasks().at(-1).criteria, criteria());
});

test('置き換えた今のタスクに完了条件があれば、取り込み済みの完了条件で上書きしない', async t => {
  const { send, write, tasks } = await setup(t);
  await send(items());
  const own = [{ text: '独自の条件', met: false }];
  await write([{ title: '前の依頼', state: 'done' }, { title: '新しい依頼', state: 'doing', criteria: own }]);
  assert.deepEqual(tasks().at(-1).criteria, own);
});

test('未完了のタスクを未完了のまま更新しても並びと他の状態を保つ', async t => {
  const { send, write, tasks } = await setup(t);
  await send({ items: [{ content: '段階1', status: 'in_progress' }] });
  await write([{ title: 'A', state: 'todo', criteria: [] }, { title: 'B', state: 'doing', criteria: [] }]);
  await write([{ title: 'A', state: 'todo' }]);
  assert.deepEqual(tasks().map(task => `${task.title}:${task.state}`), ['A:todo', 'B:doing']);
});

test('取り込み中でも 2 件以上の set_tasks は一覧全体を置き換える', async t => {
  const { write, tasks } = await setup(t);
  await write([{ title: '前の依頼', state: 'doing', criteria: criteria() }]);
  await write([
    { title: 'A', state: 'doing', criteria: [] },
    { title: 'B', state: 'todo', criteria: [] },
    { title: 'C', state: 'todo', criteria: [] },
  ]);
  assert.deepEqual(tasks().map(task => `${task.title}:${task.state}`), ['A:doing', 'B:todo', 'C:todo']);
});

test('wrap_up は今のタスクだけを完了にし、先に届いても items の後に適用する', async t => {
  const { send, tasks } = await setup(t);
  await send(undefined, 300, { tool_name: 'mcp__ccd_turn__wrap_up' });
  await send(items(), 100);
  assert.deepEqual(progress(tasks()), ['done', 'done', 'done']);
  assert.equal(tasks()[0].state, 'done');
});

test('今のタスクが無い差分と wrap_up は新しいタスクを作らない', async t => {
  const { send, tasks } = await setup(t);
  await send({ advance: true }, 100);
  await send(undefined, 200, { tool_name: 'mcp__ccd_turn__wrap_up' });
  assert.deepEqual(tasks(), []);
});

test('サブエージェントと Codex のイベントは取り込まない', async t => {
  const { send, state } = await setup(t);
  for (const extra of [{ agent_id: 'child' }, { provider: 'codex', session_id: 'codex-session' }]) {
    await send(items(), undefined, extra);
    await send(undefined, undefined, { ...extra, tool_name: 'mcp__ccd_turn__wrap_up' });
  }
  assert.deepEqual(state.snapshot().sessions.flatMap(session => session.tasks), []);
});

test('取り込みオフと Codex の set_tasks は従来どおり一覧を置き換える', async t => {
  const { send, tasks, write, display } = await setup(t);
  await display(false);
  await write([{ title: '元', state: 'doing', criteria: criteria() }]);
  await write([{ title: '新', state: 'doing', criteria: [] }]);
  await send(items());
  await send(undefined, undefined, { tool_name: 'mcp__ccd_turn__wrap_up' });
  assert.equal(tasks()[0].state, 'doing');
  assert.deepEqual(tasks().map(task => task.title), ['新']);
  await display(true);
  await send(items(), undefined, { provider: 'codex', session_id: 'codex-session' });
  await write([{ title: '元', state: 'doing', criteria: [] }], 'codex-session');
  await write([{ title: '新', state: 'doing', criteria: [] }], 'codex-session');
  assert.deepEqual(tasks('codex-session').map(task => task.title), ['新']);
});

test('設定の切り替え後は保存済みの完了条件を基準に差分を適用する', async t => {
  const { send, tasks, write, display } = await setup(t);
  await send(items(), 100);
  await display(false);
  await write([{ title: '手動', state: 'doing', criteria: criteria().slice(0, 2) }]);
  await display(true);
  await send({ advance: true }, Date.now() + 10000);
  assert.equal(tasks()[0].title, '手動');
  assert.deepEqual(progress(tasks()), ['done', 'doing']);
});

test('items が無いときは tasksUpdatedAt より後の差分だけを順番に適用する', async t => {
  const { state, send, tasks } = await setup(t);
  state.setTasks('plan-session', [{ title: '依頼', state: 'doing', criteria: criteria() }], 100);
  await send({ advance: true }, 300);
  await send({ advance: true }, 200);
  await send({ done: [3] }, 50);
  assert.deepEqual(progress(tasks()), ['done', 'done', 'doing']);
});

test('不正な items と差分は全体を無視する', async t => {
  const { send, tasks } = await setup(t);
  await send(items(), 100);
  const before = tasks();
  for (const input of [null, { items: {} }, { items: [{ content: '段階', status: 'unknown' }] },
    { items: [{ content: 'x'.repeat(201), status: 'pending' }] },
    { items: Array(13).fill({ content: '段階', status: 'pending' }) },
    { done: ['1'] }, { advance: false }, { start: 1.5 }]) await send(input, 200);
  assert.deepEqual(tasks(), before);
});

test('タスクが上限を超えたら古い done を捨てる', async t => {
  const { write, send, tasks } = await setup(t);
  await write(Array.from({ length: 50 }, (_, i) => ({ title: '依頼' + i, state: 'done', criteria: [] })));
  await send(items());
  assert.equal(tasks().length, 50);
  assert.equal(tasks()[0].title, '依頼1');
});

for (const lifecycle of ['終了', '削除']) {
  test('セッション' + lifecycle + '後は同じ tool_use_id を再利用できる', async t => {
    const { send, post, state, tasks } = await setup(t);
    const at = Date.now();
    await send(items(), at, { tool_use_id: 'reused' });
    if (lifecycle === '終了') await post('/api/events', { session_id: 'plan-session', hook_event_name: 'SessionEnd', hookAt: at + 1 });
    else state.deleteSession('plan-session', at + 1);
    await post('/api/events', { session_id: 'plan-session', hook_event_name: 'SessionStart', hookAt: at + 2 });
    await send(items(['completed']), at + 3, { tool_use_id: 'reused' });
    assert.equal(tasks().at(-1).state, 'done');
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

test('wrap_up のフックは本文を送らず、完了の印だけを送る', () => {
  const event = makeHookEvent({ session_id: 'plan-session', hook_event_name: 'PostToolUse',
    tool_name: 'mcp__ccd_turn__wrap_up', tool_input: { text: '秘密の本文' }, tool_response: '秘密の結果' }, 100);
  assert.deepEqual(event.planUpdate, { wrapUp: true });
  assert.ok(!JSON.stringify(event).includes('秘密'));
});

test('差分で完了した後の題登録は履歴を残して次の取り込みを待つ', async t => {
  const { send, write, tasks } = await setup(t);
  await send(items(), 100);
  await send({ done: [1, 2, 3] }, 200);
  await write([{ title: '次の依頼', state: 'doing' }]);
  await send({ ...items(), scope: 'new_task' }, 300);
  assert.deepEqual(tasks().map(task => task.title), ['作業', '次の依頼']);
  assert.deepEqual(tasks().map(task => task.state), ['done', 'doing']);
  assert.deepEqual(tasks()[1].criteria, criteria());
});

test('完了条件をまとめ書きした後の差分は新しい完了条件から進める', async t => {
  const { send, write, tasks } = await setup(t);
  await write([{ title: '依頼', state: 'doing' }]);
  await send(items());
  await send({ advance: true });
  await write([{ title: '依頼', state: 'doing', criteria: criteria() }]);
  await send({ advance: true });
  assert.deepEqual(progress(tasks()), ['done', 'doing', 'todo']);
});

test('取り込み後の PostToolBatch はタスク未登録の催促を返さない', async t => {
  const { send, post } = await setup(t);
  await post('/api/events', { session_id: 'plan-session', hook_event_name: 'PreToolUse', tool_name: 'Agent' });
  await send(items());
  const response = await post('/api/hooks/answers', { action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: 'plan-session', id: 'batch' });
  assert.equal(jsonBody(response).hookOutput, null);
});
