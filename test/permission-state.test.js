const test = require('node:test');
const assert = require('node:assert/strict');
const { hookHeaders, jsonBody, request, startTestServer } = require('./support/server');

async function permissionServer(t) {
  const server = await startTestServer(t);
  let hookAt = 1000;
  const event = (name, fields = {}) => request(server.info.port, {
    method: 'POST', path: '/api/events', headers: hookHeaders(server.info.secret),
    body: JSON.stringify({ session_id: 'permission', hook_event_name: name, hookAt: hookAt++, ...fields }),
  });
  const session = async () => jsonBody(await request(server.info.port, { path: '/api/state' })).sessions[0];
  const tray = async () => jsonBody(await request(server.info.port, { path: '/api/tray' }));
  return { event, session, tray };
}

test('PermissionRequest は経過時間によらず確認中として返し、通知用の許可待ちへ含めない', async (t) => {
  const c = await permissionServer(t);
  await c.event('PreToolUse', { tool_name: 'Bash', tool_use_id: 'shell', summary: 'npm test' });
  await c.event('PermissionRequest', { tool_name: 'Bash', summary: 'npm test' });

  assert.equal((await c.session()).status, '許可確認中');
  assert.equal((await c.session()).permissionWaits[0].phase, 'checking');
  assert.deepEqual((await c.tray()).permissionKeys, []);
});

test('Claude の承認通知で確認済みにし、完了またはターンの区切りで通知対象から外す', async (t) => {
  const c = await permissionServer(t);
  for (const name of ['PostToolUse', 'PostToolUseFailure', 'Stop', 'UserPromptSubmit']) {
    await c.event('PreToolUse', { tool_name: 'Bash', tool_use_id: name });
    await c.event('PermissionRequest', { tool_name: 'Bash' });
    await c.event('Notification', { notification_type: 'permission_prompt', message: '許可が必要です' });
    const session = await c.session();
    assert.equal(session.status, '許可待ち');
    assert.equal(session.permissionWaits[0].phase, 'prompted');
    assert.equal(session.permissionWaits[0].startedAt, session.lastActivityAt);
    assert.equal((await c.tray()).permissionKeys.length, 1);

    await c.event(name, { tool_name: 'Bash', tool_use_id: name });
    assert.deepEqual((await c.session()).permissionWaits, []);
    assert.deepEqual((await c.tray()).permissionKeys, []);
  }
});

test('完了後に届いた通知は送信時刻が前後どちらでも終了済みの許可待ちを復活させない', async (t) => {
  const c = await permissionServer(t);
  await c.event('PreToolUse', { hookAt: 100, tool_name: 'Bash', tool_use_id: 'shell' });
  await c.event('PostToolUse', { hookAt: 300, tool_name: 'Bash', tool_use_id: 'shell' });
  for (const hookAt of [250, 350]) {
    await c.event('Notification', { hookAt, notification_type: 'permission_prompt' });
    assert.deepEqual((await c.session()).permissionWaits, []);
    assert.deepEqual((await c.tray()).permissionKeys, []);
  }
});

test('別のツールが完了しても実行中ツールの承認通知を表示し、そのツールの完了で解除する', async (t) => {
  const c = await permissionServer(t);
  await c.event('PreToolUse', { tool_name: 'Read', tool_use_id: 'first' });
  await c.event('PreToolUse', { tool_name: 'Bash', tool_use_id: 'second', summary: 'git push' });
  await c.event('PostToolUse', { tool_name: 'Read', tool_use_id: 'first' });
  await c.event('Notification', { notification_type: 'permission_prompt' });

  const waits = (await c.session()).permissionWaits;
  assert.equal(waits.length, 1);
  assert.equal(waits[0].target_tool_use_id, 'second');
  assert.equal(waits[0].summary, 'git push');
  assert.equal((await c.tray()).permissionKeys.length, 1);
  await c.event('PostToolUse', { tool_name: 'Bash', tool_use_id: 'second' });
  assert.deepEqual((await c.session()).permissionWaits, []);
  assert.deepEqual((await c.tray()).permissionKeys, []);
});

test('次の承認通知に一意の対象があれば拒否済みまたは対象不明の待ちを置き換える', async (t) => {
  for (const withPreviousTool of [true, false]) {
    const c = await permissionServer(t);
    if (withPreviousTool) await c.event('PreToolUse', { tool_name: 'Bash', tool_use_id: 'rejected' });
    await c.event('Notification', { notification_type: 'permission_prompt' });
    await c.event('PostToolBatch');
    await c.event('PreToolUse', { tool_name: 'Bash', tool_use_id: 'next', summary: 'npm test' });
    await c.event('Notification', { notification_type: 'permission_prompt' });

    const waits = (await c.session()).permissionWaits;
    assert.equal(waits.length, 1);
    assert.equal(waits[0].target_tool_use_id, 'next');
    assert.equal(waits[0].summary, 'npm test');
    assert.equal((await c.tray()).permissionKeys.length, 1);
    await c.event('PostToolUse', { tool_name: 'Bash', tool_use_id: 'next' });
    assert.deepEqual((await c.session()).permissionWaits, []);
    assert.deepEqual((await c.tray()).permissionKeys, []);
  }
});

test('並列の承認通知は対象を断定せず、同名の別ツールと別エージェントの確認を維持する', async (t) => {
  const c = await permissionServer(t);
  for (const [id, agent_id] of [['first', null], ['second', null], ['child', 'worker']]) {
    await c.event('PreToolUse', { tool_name: 'Bash', tool_use_id: id, summary: id, agent_id });
    await c.event('PermissionRequest', { tool_name: 'Bash', summary: id, agent_id });
  }
  await c.event('Notification', { notification_type: 'permission_prompt', message: '元の画面で確認してください' });
  const waits = (await c.session()).permissionWaits;
  assert.deepEqual(waits.filter(wait => wait.phase === 'checking').map(wait => wait.target_tool_use_id), ['first', 'second', 'child']);
  const prompted = waits.find(wait => wait.phase === 'prompted');
  assert.equal(prompted.target_tool_use_id, null);
  assert.equal(prompted.tool_name, '');
  assert.equal((await c.tray()).permissionKeys.length, 1);

  await c.event('PostToolUse', { tool_name: 'Bash', tool_use_id: 'second' });
  assert.deepEqual((await c.session()).permissionWaits.filter(wait => wait.phase === 'checking').map(wait => wait.target_tool_use_id), ['first', 'child']);
  await c.event('PostToolUseFailure', { tool_name: 'Bash', tool_use_id: 'first' });
  assert.deepEqual((await c.session()).permissionWaits.map(wait => wait.agent_id), ['worker']);
  assert.deepEqual((await c.tray()).permissionKeys, []);
});

test('サブエージェントの承認通知はメインの許可確認を昇格させない', async (t) => {
  const c = await permissionServer(t);
  await c.event('PermissionRequest', { tool_name: 'Bash' });
  await c.event('Notification', { notification_type: 'permission_prompt', agent_id: 'worker' });
  assert.deepEqual((await c.session()).permissionWaits.map(wait => [wait.agent_id, wait.phase]), [
    [null, 'checking'], ['worker', 'prompted'],
  ]);
  assert.equal((await c.tray()).permissionKeys.length, 1);
});
