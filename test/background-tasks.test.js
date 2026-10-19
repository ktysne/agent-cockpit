const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { makeHookEvent } = require('../src/hooks/event');
const { hookHeaders, jsonBody, request, startTestServer, uiHeaders } = require('./support/server');

async function cockpit(t) {
  const server = await startTestServer(t);
  const send = async (input) => {
    const event = makeHookEvent({ session_id: 'background-main', cwd: server.homeDir, ...input });
    const response = await request(server.info.port, { method: 'POST', path: '/api/events',
      headers: hookHeaders(server.info.secret), body: JSON.stringify(event) });
    assert.equal(response.status, 202);
  };
  const session = async () => jsonBody(await request(server.info.port, { path: '/api/state' }))
    .sessions.find((item) => item.session_id === 'background-main');
  const launch = async (extra = {}) => {
    const input = { tool_name: 'Bash', tool_use_id: 'launch',
      tool_input: { command: 'npm test', description: 'テストを実行' }, ...extra };
    await send({ ...input, hook_event_name: 'PreToolUse' });
    await send({ ...input, hook_event_name: 'PostToolUse', tool_response: { backgroundTaskId: 'task-a' } });
  };
  return { ...server, send, session, launch };
}

test('メインの Bash は Stop 後も待機中のセッションにバックグラウンドタスクを残す', async (t) => {
  const { launch, send, session } = await cockpit(t);
  await launch();
  await send({ hook_event_name: 'Stop' });
  const current = await session();
  assert.equal(current.status, '待機中');
  assert.equal(current.tools.length, 0);
  assert.equal(current.backgrounds.length, 1);
  assert.equal(current.backgrounds[0].taskId, 'task-a');
  assert.equal(current.backgrounds[0].description, 'テストを実行');
  assert.equal(current.backgrounds[0].summary, 'npm test');
  assert.ok(Number.isFinite(Date.parse(current.backgrounds[0].startedAt)));
});

test('UserPromptSubmit の終了通知は一致する task-id の行だけを消す', async (t) => {
  const { launch, send, session } = await cockpit(t);
  for (const status of ['completed', 'failed', 'killed', 'stopped']) {
    await launch({ tool_use_id: `launch-${status}`, tool_name: 'PowerShell' });
    const notification = (id) => `<task-notification><task-id>${id}</task-id><status>${status}</status></task-notification>`;
    await send({ hook_event_name: 'UserPromptSubmit', prompt: notification('other') });
    assert.equal((await session()).backgrounds.length, 1);
    await send({ hook_event_name: 'UserPromptSubmit', prompt: notification('task-a') });
    assert.deepEqual((await session()).backgrounds, []);
  }
});

test('TaskStop の成功で指定したバックグラウンドタスクを消す', async (t) => {
  const { launch, send, session } = await cockpit(t);
  await launch();
  for (const [hook_event_name, task_id] of [['PostToolUseFailure', 'task-a'], ['PostToolUse', 'other']]) {
    await send({ hook_event_name, tool_name: 'TaskStop', tool_input: { task_id } });
    assert.equal((await session()).backgrounds.length, 1);
  }
  await send({ hook_event_name: 'PostToolUse', tool_name: 'TaskStop', tool_input: { task_id: 'task-a' } });
  assert.deepEqual((await session()).backgrounds, []);
});

test('SessionEnd でバックグラウンドタスクのあるセッションを消す', async (t) => {
  const { launch, send, session } = await cockpit(t);
  await launch();
  await send({ hook_event_name: 'SessionEnd' });
  assert.equal(await session(), undefined);
});

test('画面で終了にしたタスクは次のイベントで再投影しても表示しない', async (t) => {
  const { launch, send, session, info, runtime } = await cockpit(t);
  await launch();
  const agentId = (await session()).backgrounds[0].agent_id;
  const response = await request(info.port, { method: 'POST', path: '/api/closed-agents',
    headers: uiHeaders(info, `http://127.0.0.1:${info.port}`),
    body: JSON.stringify({ session_id: 'background-main', agent_id: agentId }) });
  assert.equal(response.status, 200);
  await send({ hook_event_name: 'Stop' });
  assert.deepEqual((await session()).backgrounds, []);
  await send({ hook_event_name: 'PostToolUse', tool_name: 'TaskStop', tool_input: { task_id: 'task-a' } });
  assert.equal(runtime.state.closedAgents.has('background-main'), false);
});

test('Codex の起動とクロスレビューとサブエージェントのタスクを一覧に重複して出さない', async (t) => {
  const { launch, session } = await cockpit(t);
  for (const extra of [
    { tool_input: { command: 'bash codex-agent.sh impl' } },
    { tool_use_id: 'review', tool_input: { command: 'npm run review:codex' } },
    { tool_use_id: 'child', agent_id: 'child' },
  ]) {
    await launch(extra);
    assert.deepEqual((await session()).backgrounds, []);
  }
});

test('待機中でも記録ファイルの完了通知を読みバックグラウンドタスクを消す', async (t) => {
  const { launch, send, session, claudeHome, homeDir } = await cockpit(t);
  await launch();
  await send({ hook_event_name: 'Stop' });
  const directory = path.join(claudeHome, 'projects', homeDir.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, 'background-main.jsonl'), JSON.stringify({
    type: 'queue-operation', operation: 'enqueue', timestamp: new Date().toISOString(),
    content: '<task-notification><task-id>task-a</task-id><status>completed</status></task-notification>',
  }));
  await send({ hook_event_name: 'Stop' });
  const deadline = Date.now() + 3000;
  while ((await session()).backgrounds.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.deepEqual((await session()).backgrounds, []);
  assert.equal((await session()).status, '待機中');
});
