const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHookEvent, runHook } = require('../src/hooks/event');
const { DashboardState, deriveSessions } = require('../src/server/state');
const { hookHeaders, jsonBody, request, startTestServer } = require('./support/server');

const parentId = 'claude-parent';
const command = 'bash ~/.claude/tools/codex-agent.sh impl-hard < prompt.md';

function claudeEvent(name, fields = {}) {
  return makeHookEvent({ session_id: parentId, hook_event_name: name, tool_name: 'Bash',
    tool_use_id: 'launch', tool_input: { command }, ...fields }, fields.hookAt || 100, { environment: {} });
}

function launch(state, toolUseId = 'launch', fields = {}) {
  state.addEvent(claudeEvent('PreToolUse', { tool_use_id: toolUseId, ...fields }));
}

function finish(state, fields = {}) {
  state.addEvent(claudeEvent('PostToolUse', { hookAt: 300, ...fields,
    tool_response: 'codex-agent: agent=impl-hard model=gpt-6 effort=high sandbox=workspace-write\ncodex-agent: result=ok' }));
}

function codexEvent(name, fields = {}) {
  return { session_id: 'thread', provider: 'codex', hook_event_name: name, hookAt: 200,
    claudeParentSessionId: parentId, ...fields };
}

function codexRun(state, fields = {}) {
  for (const [index, name] of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd'].entries()) {
    state.addEvent(codexEvent(name, { hookAt: 200 + index, tool_name: 'exec_command', tool_use_id: 'tool', ...fields }));
  }
}

function codexSessions(state) {
  return state.snapshot().sessions.filter(session => session.provider === 'codex');
}

test('委譲した Codex は親の下にだけ表示され、結果行で終了する', () => {
  const state = new DashboardState();
  launch(state);
  codexRun(state);
  assert.deepEqual(codexSessions(state), []);
  assert.equal(state.sessions.has('thread'), false);
  finish(state);
  const agents = state.snapshot().sessions[0].agents;
  assert.equal(agents.length, 1);
  assert.equal(agents[0].isCodex, true);
  assert.equal(agents[0].active, false);
  assert.equal(agents[0].unconfirmed, false);
  assert.equal(agents[0].resultReceived, true);
  const entries = state.entries.get('thread');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].event.delegatedFrom, parentId);
  assert.deepEqual(deriveSessions(entries), []);
});

test('親に委譲行が無い Codex は独立したセッションとして表示される', () => {
  const state = new DashboardState();
  state.addEvent(claudeEvent('SessionStart'));
  for (const name of ['SessionStart', 'PreToolUse', 'PostToolUse', 'Stop']) {
    state.addEvent(codexEvent(name, { tool_name: 'exec_command', tool_use_id: 'tool' }));
    assert.equal(codexSessions(state)[0].session_id, 'thread');
  }
  state.addEvent(codexEvent('SessionEnd'));
  assert.deepEqual(codexSessions(state), []);
});

test('親の ID が無い Codex は通常のセッションとして表示される', () => {
  const state = new DashboardState();
  launch(state);
  state.addEvent(codexEvent('SessionStart', { claudeParentSessionId: undefined }));
  assert.equal(codexSessions(state)[0].session_id, 'thread');
});

test('委譲の結果と SessionEnd の後に遅れて届いたイベントでもセッションを作らない', () => {
  const state = new DashboardState();
  launch(state);
  codexRun(state);
  finish(state);
  for (const name of ['PreToolUse', 'SessionStart', 'Stop']) {
    state.addEvent(codexEvent(name, { hookAt: 400, claudeParentSessionId: 'other-parent' }));
    assert.deepEqual(codexSessions(state), []);
  }
  assert.ok(state.entries.get('thread').every(({ event }) => event.delegatedFrom === parentId));
});

test('サブエージェントから委譲した Codex も親の下にだけ表示される', () => {
  const state = new DashboardState();
  state.addEvent(claudeEvent('SubagentStart', { agent_id: 'sub-1', agent_type: 'impl-hard' }));
  launch(state, 'launch', { agent_id: 'sub-1' });
  codexRun(state);
  assert.deepEqual(codexSessions(state), []);
  const subagent = state.snapshot().sessions[0].agents.find(agent => agent.agent_id === 'sub-1');
  assert.equal(subagent.gpt.active, true);
  finish(state, { agent_id: 'sub-1' });
  state.addEvent(codexEvent('SessionStart', { session_id: 'after-result', hookAt: 400 }));
  assert.deepEqual(codexSessions(state).map(session => session.session_id), ['after-result']);
});

test('並行する委譲がある親からの Codex は直接起動した thread も委譲として扱う', () => {
  const state = new DashboardState();
  launch(state, 'first');
  launch(state, 'second');
  for (const session_id of ['first-thread', 'second-thread', 'direct-thread']) {
    state.addEvent(codexEvent('SessionStart', { session_id }));
  }
  assert.deepEqual(codexSessions(state), []);
  assert.equal(state.snapshot().sessions[0].agents.filter(agent => agent.isCodex).length, 2);
});

test('起動通知が子の Codex より後に届いても、起動以降に始まった thread は委譲に直す', () => {
  const state = new DashboardState();
  state.addEvent(codexEvent('SessionStart'));
  assert.equal(codexSessions(state)[0].session_id, 'thread');
  launch(state);
  assert.deepEqual(codexSessions(state), []);
  state.addEvent(codexEvent('PreToolUse', { hookAt: 210, tool_name: 'exec_command', tool_use_id: 'tool' }));
  assert.deepEqual(codexSessions(state), []);
  assert.equal(state.entries.get('thread').length, 1);
  assert.equal(state.entries.get('thread')[0].event.delegatedFrom, parentId);
});

test('起動より前に始まった独立の thread は後から委譲行ができても独立のままである', () => {
  const state = new DashboardState();
  state.addEvent(codexEvent('SessionStart'));
  launch(state, 'launch', { hookAt: 250 });
  state.addEvent(codexEvent('PreToolUse', { hookAt: 260, tool_name: 'exec_command', tool_use_id: 'tool' }));
  assert.equal(codexSessions(state)[0].session_id, 'thread');
  assert.ok(state.entries.get('thread').every(({ event }) => event.delegatedFrom === undefined));
});

test('HTTP で委譲を受けた Codex は状態に表示されず MCP の書き込みが 403 になる', async (t) => {
  const c = await startTestServer(t);
  const post = (url, body) => request(c.info.port, { method: 'POST', path: url,
    headers: hookHeaders(c.info.secret), body: JSON.stringify(body) });
  await post('/api/events', claudeEvent('PreToolUse'));
  await post('/api/events', codexEvent('SessionStart'));
  const state = jsonBody(await request(c.info.port, { path: '/api/state' }));
  assert.deepEqual(state.sessions.map(session => session.session_id), [parentId]);
  const response = await post('/api/sessions/thread/plan', { codexSessionId: 'thread', kind: 'tasks',
    tasks: [{ title: '書き込まない', state: 'doing', criteria: [] }] });
  assert.equal(response.status, 403);
  assert.equal(c.runtime.state.plans.size, 0);
});

test('Codex のフックは親の ID だけを送信し Claude のフックには付けない', async () => {
  const environment = { CLAUDE_CODE_SESSION_ID: parentId, CLAUDE_CODE_MESSAGING_TOKEN: 'secret-token-never-send' };
  for (const provider of ['codex', 'claude']) {
    let sent;
    const result = await runHook({ session_id: 'thread', hook_event_name: 'Stop' }, {
      provider, environment, homeDir: '.', ensureServerRunning: async () => ({ port: 1234, secret: 'hook-secret' }),
      fetchImpl: async (_url, options) => { sent = JSON.parse(options.body); return { ok: true, status: 200 }; },
    });
    assert.equal(sent.claudeParentSessionId, provider === 'codex' ? parentId : undefined);
    assert.equal(JSON.stringify({ sent, result }).includes(environment.CLAUDE_CODE_MESSAGING_TOKEN), false);
  }
});

test('環境とフック入力の不正な親 ID は委譲の判定に使わない', () => {
  const state = new DashboardState();
  launch(state);
  for (const value of ['../claude-parent', 'x'.repeat(129), 42]) {
    const event = makeHookEvent({ session_id: 'thread', hook_event_name: 'SessionStart' }, 200,
      { provider: 'codex', environment: { CLAUDE_CODE_SESSION_ID: value } });
    assert.equal(event.claudeParentSessionId, undefined);
    state.addEvent(codexEvent('SessionStart', { session_id: `thread-${String(value).length}`, claudeParentSessionId: value }));
  }
  assert.ok(codexSessions(state).length > 0);
  assert.ok([...state.entries.values()].flat().every(({ event }) => event.claudeParentSessionId === undefined));
});
