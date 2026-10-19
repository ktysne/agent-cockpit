const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHookEvent, runHook } = require('../src/hooks/event');
const { DashboardState, deriveSessions } = require('../src/server/state');
const { sanitizeEvent } = require('../src/server/events');
const { hookHeaders, jsonBody, request, startTestServer } = require('./support/server');

const parentId = 'claude-parent';
const command = 'bash ~/.claude/tools/codex-agent.sh impl-hard < prompt.md';

test('PowerShell のクロスレビュー起動は /api/events から Codex の行になる', async (t) => {
  const c = await startTestServer(t);
  const send = (hook_event_name, fields = {}) => {
    const event = makeHookEvent({
      session_id: 'powershell-review',
      hook_event_name,
      tool_name: 'PowerShell',
      tool_use_id: 'review',
      cwd: process.cwd(),
      tool_input: { command: 'npm run review:codex' },
      ...fields,
    });
    return request(c.info.port, {
      method: 'POST',
      path: '/api/events',
      headers: hookHeaders(c.info.secret),
      body: JSON.stringify(event),
    });
  };
  const response = await send('PreToolUse');
  assert.equal(response.status, 202);
  assert.equal((await send('PostToolUse', { tool_response: 'codex-agent: result=ok' })).status, 202);
  const state = jsonBody(await request(c.info.port, { path: '/api/state' }));
  assert.deepEqual(state.sessions.map(session => session.session_id), ['powershell-review']);
  const [agent] = state.sessions[0].agents;
  assert.equal(agent.agent_type, 'codex-review');
  assert.equal(agent.lastTool.tool_name, 'PowerShell');
  assert.equal(agent.resultReceived, true);
});

test('コマンド位置の起動は前置きや引用符、長いパスを含んでも全文の定義名で行を作る', () => {
  for (const command of [
    'bash "$HOME/.claude/tools/codex-agent.sh" impl-hard < "C:/tmp/p.md"',
    "bash '/c/Users/me/.claude/tools/codex-agent.sh' impl-hard < p.md",
    'bash "C:/User Data/tools/codex-agent.sh" impl-hard',
    `cd ${'long-directory/'.repeat(12)} && bash /tools/codex-agent.sh impl-hard < p.md`,
    ...['\n', '&&', '||', ';', '|'].map(separator => `true ${separator} sh codex-agent.cmd impl-hard`),
    '(sh codex-agent.cmd impl-hard)',
    'out=$(bash codex-agent.sh impl-hard<p.md)',
    'codex-agent.ps1 impl-hard',
    'timeout 600 bash ~/.claude/tools/codex-agent.sh impl-hard',
    'CODEX_HOME=x env A=1 nohup bash ~/.claude/tools/codex-agent.sh impl-hard < p.md',
    'bash -lc "cd D:/repo; bash ~/.claude/tools/codex-agent.sh impl-hard"',
    'bash ~/.claude/tools/codex-agent.sh impl-hard <<\'EOF\'\n依頼文\nEOF',
    'echo "$(bash ~/.claude/tools/codex-agent.sh impl-hard < prompt.md)"',
    '# 実装を委譲する(cd repo && の後で起動する)\nbash ~/.claude/tools/codex-agent.sh impl-hard < p.md',
    'echo "a << b"; bash ~/.claude/tools/codex-agent.sh impl-hard',
  ]) {
    const state = new DashboardState();
    const event = claudeEvent('PreToolUse', { tool_input: { command } });
    assert.equal(sanitizeEvent(event).codexDefinition, 'impl-hard', command);
    state.addEvent(event);
    assert.equal(state.snapshot().sessions[0].agents[0].agent_type, 'impl-hard', command);
  }
});

test('引数や文字列中のラッパー名とオプション呼び出しは Codex の行を作らない', () => {
  for (const command of [
    'git diff -- tools/codex-agent.sh docs/x',
    'git add tools/codex-agent.sh test/x.sh',
    'wc -l ~/.claude/tools/codex-agent.sh 2>/dev/null',
    'grep -rn "codex-agent.sh impl-standard" docs',
    'echo "手順; bash codex-agent.sh impl-hard"',
    '"codex-agent.sh impl-hard"',
    'bash codex-agent.sh --header-of impl-hard',
    'bash codex-agent.sh --wait impl-hard-20261019-110000-7',
    'timeout 600 grep codex-agent.sh impl-hard',
    "cat > p.md <<'EOF'\nbash ~/.claude/tools/codex-agent.sh impl-hard\nEOF",
    '# 実行例: cd repo && bash codex-agent.sh impl-hard',
    "echo '$(bash codex-agent.sh impl-hard)'",
    "bash -lc 'cat > prompt.md <<EOF\nbash ~/.claude/tools/codex-agent.sh impl-hard\nEOF'",
  ]) {
    const state = new DashboardState();
    state.addEvent(claudeEvent('PreToolUse', { tool_input: { command } }));
    assert.deepEqual(state.snapshot().sessions[0].agents, [], command);
  }
});

function backgroundLaunch(state, definition = 'impl-hard', startedAt = 100) {
  launch(state, 'launch', { hookAt: startedAt, tool_input: { command: `bash codex-agent.sh ${definition}` } });
  state.addEvent(claudeEvent('PostToolUse', { hookAt: startedAt + 1, tool_response: { backgroundTaskId: 'task-a' } }));
}

test('killed と stopped の通知に結果が無ければ背景 Codex は終了未確認になる', () => {
  for (const status of ['killed', 'stopped']) {
    const state = new DashboardState();
    backgroundLaunch(state);
    state.addEvent({ session_id: parentId, hook_event_name: 'BackgroundTaskEnd', hookAt: 300,
      backgroundTaskEnds: [{ taskId: 'task-a', status }] });
    const [agent] = state.snapshot().sessions[0].agents;
    assert.equal(agent.active, false);
    assert.equal(agent.unconfirmed, true);
    assert.equal(agent.waitEnded, true);
  }
});

test('背景レビューへ別定義の実行 ID の結果を割り当てない', () => {
  const state = new DashboardState();
  backgroundLaunch(state, 'codex-review');
  state.addEvent(claudeEvent('PostToolUse', { tool_use_id: 'read', hookAt: 300,
    tool_response: 'codex-agent: run=impl-standard-20261019-110000-7\ncodex-agent: result=ok' }));
  const [agent] = state.snapshot().sessions[0].agents;
  assert.equal(agent.active, true);
  assert.equal(agent.runId, undefined);
});

test('停止通知で終了未確認になった行も実行 ID が一致する遅延結果で終了する', () => {
  const state = new DashboardState();
  backgroundLaunch(state);
  const runId = 'impl-hard-20261019-110000-7';
  state.addEvent({ session_id: parentId, hook_event_name: 'BackgroundTaskEnd', hookAt: 300,
    backgroundTaskEnds: [{ taskId: 'task-a', status: 'killed',
      codexOutput: { runLine: `codex-agent: run=${runId}` } }] });
  state.addEvent(claudeEvent('PostToolUse', { tool_use_id: 'wait-result', hookAt: 400,
    tool_response: `codex-agent: run=${runId}\ncodex-agent: result=ok` }));
  const [agent] = state.snapshot().sessions[0].agents;
  assert.equal(agent.resultReceived, true);
  assert.equal(agent.unconfirmed, false);
});

test('停止通知でも待機状態行があればその状態で稼働と終了未確認を決める', () => {
  for (const [status, active, unconfirmed] of [
    ['waiting', true, false], ['orphaned', false, true], ['unverified', false, true],
    ['vanished', false, false], ['not-found', false, false],
  ]) {
    const state = new DashboardState();
    backgroundLaunch(state);
    state.addEvent({ session_id: parentId, hook_event_name: 'BackgroundTaskEnd', hookAt: 300,
      backgroundTaskEnds: [{ taskId: 'task-a', status: 'stopped',
        codexOutput: { waitStatusLine: `codex-agent: ${status} run=impl-hard-20261019-110000-7` } }] });
    const [agent] = state.snapshot().sessions[0].agents;
    assert.deepEqual([agent.active, agent.unconfirmed === true], [active, unconfirmed], status);
  }
});

test('実行 ID の定義と秒単位の起動時刻が合う結果だけを背景行へ割り当てる', () => {
  for (const [started, expected] of [['10:59:59', false], ['11:00:00', true], ['', true]]) {
    const state = new DashboardState();
    backgroundLaunch(state, 'impl-hard', Date.parse('2026-10-19T11:00:00.900Z'));
    const run = `codex-agent: run=impl-hard-20261019-110000-7${started ? ` pid=7 started=2026-10-19T${started}Z` : ''}`;
    state.addEvent(claudeEvent('PostToolUse', { tool_use_id: 'read', hookAt: Date.parse('2026-10-19T11:01:00Z'),
      tool_response: `${run}\ncodex-agent: result=ok` }));
    assert.equal(state.snapshot().sessions[0].agents[0].resultReceived === true, expected, started);
  }
});

test('引用された結果行の後に本物の結果行があれば最後の結果で終了する', () => {
  const state = new DashboardState();
  launch(state);
  state.addEvent(claudeEvent('PostToolUse', { hookAt: 300,
    tool_response: '```\ncodex-agent: result=rate-limited\n```\ncodex-agent: result=ok' }));
  const [agent] = state.snapshot().sessions[0].agents;
  assert.equal(agent.resultReceived, true);
  assert.equal(agent.unavailable, '');
});

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

test('PostToolBatch は拒否された Codex 起動を外し、次の thread を独立として表示する', () => {
  for (const agent_id of [null, 'window']) {
    const state = new DashboardState();
    launch(state, 'rejected', { agent_id,
      tool_input: { command: 'bash ~/.claude/tools/codex-agent.sh impl-light --effort low < "<依頼文>"' } });
    state.addEvent(claudeEvent('PostToolBatch', { agent_id, hookAt: 200 }));
    if (agent_id) state.addEvent(claudeEvent('SubagentStop', { agent_id, hookAt: 210 }));
    const agents = state.snapshot().sessions[0].agents;
    assert.equal(agents.some(agent => agent.isCodex || agent.gpt), false);
    assert.equal(state.hasRunningDelegation(parentId), false);
    state.addEvent(codexEvent('SessionStart', { hookAt: 220 }));
    assert.equal(codexSessions(state).length, 1);
  }
});

test('PostToolBatch で拒否を除去した次の区切りでは正しい Codex 起動だけが残る', () => {
  const state = new DashboardState();
  launch(state, 'rejected', { tool_input: { command: 'npm run review:codex' } });
  state.addEvent(claudeEvent('PostToolBatch', { hookAt: 200 }));
  launch(state, 'accepted', { hookAt: 300 });
  finish(state, { tool_use_id: 'accepted', hookAt: 400 });
  state.addEvent(claudeEvent('PostToolBatch', { hookAt: 500 }));
  const agents = state.snapshot().sessions[0].agents;
  assert.deepEqual(agents.map(agent => agent.agent_id), ['codex:accepted']);
  assert.equal(agents[0].resultReceived, true);
});

test('PostToolBatch は backgroundTaskId を受けた Codex 起動を残す', () => {
  const state = new DashboardState();
  backgroundLaunch(state);
  state.addEvent(claudeEvent('PostToolBatch', { hookAt: 200 }));
  const [agent] = state.snapshot().sessions[0].agents;
  assert.equal(agent.backgroundTaskId, 'task-a');
  assert.equal(agent.active, true);
  assert.equal(state.hasRunningDelegation(parentId), true);
});

for (const delayed of [false, true]) {
  test(`PostToolBatch は${delayed ? '遅れて届いた' : '先に届いた'}前面の PostToolUse があれば Codex 起動を残す`, () => {
    const state = new DashboardState();
    launch(state);
    if (!delayed) finish(state, { hookAt: 150 });
    state.addEvent(claudeEvent('PostToolBatch', { hookAt: 200 }));
    if (delayed) finish(state, { hookAt: 150 });
    const [agent] = state.snapshot().sessions[0].agents;
    assert.equal(agent.agent_id, 'codex:launch');
    assert.equal(agent.resultReceived, true);
    assert.equal(state.hasRunningDelegation(parentId), false);
  });
}

test('PostToolBatch は別のエージェントと区切りと同時刻の Codex 起動を残す', () => {
  const state = new DashboardState();
  launch(state, 'other', { agent_id: 'other' });
  launch(state, 'same-time', { hookAt: 200 });
  state.addEvent(claudeEvent('PostToolBatch', { hookAt: 200 }));
  assert.equal(state.hasRunningDelegation(parentId), true);
  assert.ok(state.snapshot().sessions[0].agents.some(agent => agent.agent_id === 'codex:same-time'));
  assert.ok(state.snapshot().sessions[0].agents.find(agent => agent.agent_id === 'other').gpt);
});

test('PostToolBatch は Codex の --wait の待ちを外さない', () => {
  const state = new DashboardState();
  state.addEvent(claudeEvent('PreToolUse', { agent_id: 'window',
    tool_input: { command: 'bash codex-agent.sh --wait impl-hard-20261019-110000-7' } }));
  state.addEvent(claudeEvent('PostToolBatch', { agent_id: 'window', hookAt: 200 }));
  assert.equal(state.hasRunningDelegation(parentId), true);
  assert.equal(state.snapshot().sessions[0].agents.find(agent => agent.agent_id === 'window').gpt.active, true);
});

test('起動の中断は Failure と合成 Interrupt の順によらず終了未確認になる', () => {
  for (const command of ['bash codex-agent.sh impl-hard', 'npm run review:codex']) {
    for (const interruptFirst of [true, false]) {
      const state = new DashboardState();
      launch(state, 'launch', { tool_input: { command } });
      const failure = () => state.addEvent(claudeEvent('PostToolUseFailure', {
        hookAt: interruptFirst ? 300 : 200, is_interrupt: true,
      }));
      if (interruptFirst) state.recordInterruption(parentId, 200);
      failure();
      if (!interruptFirst) state.recordInterruption(parentId, 300);
      const [agent] = state.snapshot().sessions[0].agents;
      assert.deepEqual([agent.active, agent.unconfirmed, agent.closable], [false, true, true], command);
    }
  }
});

test('中断の印が無い起動の Failure は終了にする', () => {
  for (const command of ['bash codex-agent.sh impl-hard', 'npm run review:codex']) {
    const state = new DashboardState();
    launch(state, 'launch', { tool_input: { command } });
    state.addEvent(claudeEvent('PostToolUseFailure', { hookAt: 200, error: 'interrupted' }));
    state.recordInterruption(parentId, 300);
    const [agent] = state.snapshot().sessions[0].agents;
    assert.equal(agent.active, false);
    assert.notEqual(agent.unconfirmed, true);
  }
});

const missingRunId = 'impl-hard-20261019-031058-1234';
const missingRunLine = `codex-agent: run=${missingRunId} pid=1234 started=2026-10-19T03:10:58Z`;
const missingLaunchAt = Date.parse('2026-10-19T03:10:58.900Z');

function missingLaunch(state, toolUseId = 'launch') {
  state.addEvent(claudeEvent('SubagentStart', { hookAt: missingLaunchAt - 1, agent_id: 'sub', agent_type: 'impl-hard' }));
  launch(state, toolUseId, { hookAt: missingLaunchAt, agent_id: 'sub' });
}

test('起動の PostToolUse が無くても run 行の有無によらず子の --wait で同じ行を終了する', () => {
  for (const withHeader of [true, false]) {
    const state = new DashboardState();
    missingLaunch(state);
    if (withHeader) state.addEvent(claudeEvent('PostToolUse', { hookAt: missingLaunchAt + 1,
      agent_id: 'sub', tool_use_id: 'header', tool_input: { command: 'bash codex-agent.sh --header-of impl-hard' },
      tool_response: missingRunLine }));
    state.addEvent(claudeEvent('PreToolUse', { hookAt: missingLaunchAt + 2, agent_id: 'sub', tool_use_id: 'wait',
      tool_input: { command: `bash codex-agent.sh --wait ${missingRunId}` } }));
    state.addEvent(claudeEvent('PostToolUse', { hookAt: missingLaunchAt + 3, agent_id: 'sub', tool_use_id: 'wait',
      tool_response: `${missingRunLine}\ncodex-agent: result=ok` }));
    state.addEvent(claudeEvent('SubagentStop', { hookAt: missingLaunchAt + 4, agent_id: 'sub' }));
    const [parent] = state.snapshot().sessions[0].agents;
    assert.deepEqual([parent.active, parent.unconfirmed, parent.gpt.active, parent.gpt.unconfirmed], [false, false, false, false]);
  }
});

test('メインの --wait の出力でも欠落した起動を親を問わず引き取って終了する', () => {
  const state = new DashboardState();
  missingLaunch(state);
  state.addEvent(claudeEvent('PostToolUse', { hookAt: missingLaunchAt + 1, tool_use_id: 'main-wait',
    tool_input: { command: `bash codex-agent.sh --wait ${missingRunId}` },
    tool_response: `${missingRunLine}\ncodex-agent: result=ok` }));
  state.addEvent(claudeEvent('SubagentStop', { hookAt: missingLaunchAt + 2, agent_id: 'sub' }));
  const [parent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([parent.active, parent.unconfirmed, parent.gpt.active, parent.gpt.unconfirmed], [false, false, false, false]);
});

test('同じ定義の起動が二つ欠落したとき run 行や --wait は引き取らない', () => {
  const state = new DashboardState();
  missingLaunch(state);
  launch(state, 'second', { hookAt: missingLaunchAt, agent_id: 'sub' });
  state.addEvent(claudeEvent('PostToolUse', { hookAt: missingLaunchAt + 1, agent_id: 'sub', tool_use_id: 'header',
    tool_response: missingRunLine }));
  state.addEvent(claudeEvent('PreToolUse', { hookAt: missingLaunchAt + 2, agent_id: 'sub', tool_use_id: 'wait',
    tool_input: { command: `bash codex-agent.sh --wait ${missingRunId}` } }));
  state.addEvent(claudeEvent('PostToolUse', { hookAt: missingLaunchAt + 3, agent_id: 'sub', tool_use_id: 'wait',
    tool_response: `${missingRunLine}\ncodex-agent: result=ok` }));
  state.addEvent(claudeEvent('SubagentStop', { hookAt: missingLaunchAt + 4, agent_id: 'sub' }));
  const [parent] = state.snapshot().sessions[0].agents;
  assert.deepEqual([parent.unconfirmed, parent.gpt.active, parent.gpt.unconfirmed], [true, false, false]);
});

test('背景行と欠落した起動が共存すると正常な背景行の run 行を欠落した行へ付けない', () => {
  for (const outputTask of [true, false]) {
    const state = new DashboardState();
    backgroundLaunch(state, 'impl-hard', missingLaunchAt);
    launch(state, 'missing', { hookAt: missingLaunchAt + 1 });
    state.addEvent(claudeEvent('PostToolUse', { hookAt: missingLaunchAt + 2, tool_use_id: 'header',
      tool_input: { command: outputTask ? 'cat /tmp/task-a.output' : 'bash codex-agent.sh --header-of impl-hard' },
      tool_response: missingRunLine }));
    const agents = state.sessions.get(parentId).agents;
    assert.equal(agents.find(agent => agent.agent_id === 'codex:missing').runId, undefined);
    assert.equal(agents.find(agent => agent.agent_id === 'codex:launch').runId, outputTask ? missingRunId : undefined);
  }
});

test('run 行で背景へ移った欠落起動はメインの Stop で終了未確認に戻らない', () => {
  const state = new DashboardState();
  launch(state, 'launch', { hookAt: missingLaunchAt });
  state.addEvent(claudeEvent('PostToolUse', { hookAt: missingLaunchAt + 1, tool_use_id: 'read',
    tool_input: { command: 'cat /tmp/task-a.output' }, tool_response: missingRunLine }));
  state.addEvent(claudeEvent('Stop', { hookAt: missingLaunchAt + 2 }));
  const [agent] = state.snapshot().sessions[0].agents;
  assert.equal(agent.active, true);
  assert.notEqual(agent.unconfirmed, true);
  assert.equal(agent.backgroundTaskId, 'task-a');
});

test('Agent の報告に引用された run 行は欠落した起動へ付けない', () => {
  const state = new DashboardState();
  launch(state, 'launch', { hookAt: missingLaunchAt });
  state.addEvent(claudeEvent('PostToolUse', { hookAt: missingLaunchAt + 1, tool_name: 'Agent', tool_use_id: 'agent',
    tool_input: { prompt: '依頼' }, tool_response: missingRunLine }));
  const agent = state.sessions.get(parentId).agents.find(item => item.agent_id === 'codex:launch');
  assert.equal(agent.runId, undefined);
  assert.notEqual(agent.backgrounded, true);
});

test('結果を受け取った欠落起動は遅れて届いた中断で終了未確認に戻らない', () => {
  const state = new DashboardState();
  launch(state, 'launch', { hookAt: missingLaunchAt });
  state.addEvent(claudeEvent('PostToolUse', { hookAt: missingLaunchAt + 1, tool_use_id: 'read',
    tool_input: { command: 'cat /tmp/task-a.output' }, tool_response: `${missingRunLine}\ncodex-agent: result=ok` }));
  state.addEvent(claudeEvent('PostToolUseFailure', { hookAt: missingLaunchAt + 2, is_interrupt: true }));
  const [agent] = state.snapshot().sessions[0].agents;
  assert.equal(agent.active, false);
  assert.notEqual(agent.unconfirmed, true);
});

test('Codex の子は開始通知の有無によらず親の Stop の後も稼働し画面から閉じられる', () => {
  for (const name of ['SubagentStart', 'PreToolUse']) {
    const state = new DashboardState();
    state.addEvent(codexEvent(name, { claudeParentSessionId: undefined, agent_id: 'child',
      agent_type: 'default', tool_name: 'exec_command', tool_use_id: 'child-tool' }));
    state.addEvent(codexEvent('Stop', { claudeParentSessionId: undefined, hookAt: 300 }));
    const [agent] = state.snapshot().sessions[0].agents;
    assert.deepEqual([agent.active, agent.backgrounded, agent.closable], [true, true, true]);
    assert.equal(state.closeAgent('thread', 'child'), true);
    assert.equal(state.snapshot().sessions[0].agents[0].active, false);
  }
});

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
  assert.equal(jsonBody(response).error, 'Codex session delegated');
  assert.equal(c.runtime.state.plans.size, 0);
});

test('委譲した Codex の UserPromptSubmit は配信として記録せずに記録不要の文脈を返し、独立した Codex には返さない', async (t) => {
  const c = await startTestServer(t);
  const post = (url, body) => request(c.info.port, { method: 'POST', path: url,
    headers: hookHeaders(c.info.secret), body: JSON.stringify(body) });
  await post('/api/events', codexEvent('SessionStart', { session_id: 'independent-thread', hookAt: 50 }));
  await post('/api/events', claudeEvent('PreToolUse'));
  await post('/api/events', codexEvent('SessionStart', { hookAt: 200 }));
  const submitPrompt = async (sessionId) => {
    const response = await post('/api/hooks/answers', { action: 'user-prompt-submit', event_name: 'UserPromptSubmit',
      session_id: sessionId, id: `${sessionId}-prompt`, hook_at: 300 });
    assert.equal(response.status, 200);
    return jsonBody(response);
  };

  const delegated = await submitPrompt('thread');
  const additionalContext = delegated.hookOutput.hookSpecificOutput.additionalContext;
  assert.match(additionalContext, /Agent Cockpit/);
  assert.match(additionalContext, /Claude のセッションから委譲/);
  assert.match(additionalContext, /cockpit_\*/);
  assert.equal(delegated.deliveryId, undefined);
  assert.equal((await submitPrompt('independent-thread')).hookOutput, null);

  const delegatedContext = jsonBody(await request(c.info.port, { path: '/api/sessions/thread/context' }));
  const independentContext = jsonBody(await request(c.info.port, { path: '/api/sessions/independent-thread/context' }));
  assert.equal(delegatedContext.delegated, true);
  assert.equal(independentContext.delegated, false);
});

test('委譲した Codex の PostToolUse は配信処理を呼ばない', async (t) => {
  const c = await startTestServer(t);
  const post = (url, body) => request(c.info.port, { method: 'POST', path: url,
    headers: hookHeaders(c.info.secret), body: JSON.stringify(body) });
  await post('/api/events', claudeEvent('PreToolUse'));
  await post('/api/events', codexEvent('SessionStart'));

  let deliveryCalls = 0;
  const deliverPostToolBatch = c.runtime.answerDelivery.deliverPostToolBatch.bind(c.runtime.answerDelivery);
  c.runtime.answerDelivery.deliverPostToolBatch = (...args) => {
    deliveryCalls += 1;
    return deliverPostToolBatch(...args);
  };
  const response = await post('/api/hooks/answers', {
    action: 'post-tool-use', event_name: 'PostToolUse', provider: 'codex', session_id: 'thread', id: 'thread-post-tool-use',
  });

  assert.equal(response.status, 200);
  assert.equal(jsonBody(response).hookOutput, null);
  assert.equal(deliveryCalls, 0);
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
