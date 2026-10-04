const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CLAUDE_ROUTE_CONTEXT, CODEX_ROUTE_CONTEXT, outputForInputText, outputForRoute } = require('../src/hooks/route');

async function temporaryHome(t, routing = { agents: 'default', review: 'default' }, withCodexAgent = true) {
  const previousClaudeHome = process.env.CLAUDE_CONFIG_DIR;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-route-hook-'));
  process.env.CLAUDE_CONFIG_DIR = homeDir;
  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify(routing));
  if (withCodexAgent) {
    const toolsDirectory = path.join(homeDir, 'tools');
    await fs.mkdir(toolsDirectory);
    await fs.writeFile(path.join(toolsDirectory, 'codex-agent.sh'), '');
  }
  t.after(async () => {
    if (previousClaudeHome === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = previousClaudeHome;
    await fs.rm(homeDir, { recursive: true, force: true });
  });
  return homeDir;
}

test('SubagentStart は codex-agent.sh が無ければ経路を読み込まず、Claude ホームを差し替えられる', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'default' }, false);
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-no-codex', agent_id: 'agent-1' };
  assert.equal(outputForRoute(start, { homeDir, userHome: homeDir }), null);
  await assert.rejects(fs.stat(path.join(homeDir, 'route-agents')));

  const alternateClaudeHome = path.join(homeDir, 'alternate-claude-home');
  const toolsDirectory = path.join(alternateClaudeHome, 'tools');
  await fs.mkdir(toolsDirectory, { recursive: true });
  await fs.writeFile(path.join(toolsDirectory, 'codex-agent.sh'), '');
  assert.deepEqual(outputForRoute(start, { homeDir, claudeHome: alternateClaudeHome, userHome: homeDir }), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CLAUDE_ROUTE_CONTEXT },
  });
});

test('SubagentStart は Claude のホームに無くても ~/.claude の codex-agent.sh で bridge を検出する', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'default' }, false);
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-fallback', agent_id: 'agent-1' };
  const userHome = path.join(homeDir, 'user');
  const toolsDirectory = path.join(userHome, '.claude', 'tools');
  await fs.mkdir(toolsDirectory, { recursive: true });
  await fs.writeFile(path.join(toolsDirectory, 'codex-agent.sh'), '');
  assert.deepEqual(outputForRoute(start, { homeDir, userHome }), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CLAUDE_ROUTE_CONTEXT },
  });
});

test('SubagentStart は選択経路を差し込み、既定では出力しない', async (t) => {
  const homeDir = await temporaryHome(t);
  const start = (agentId) => ({ hook_event_name: 'SubagentStart', session_id: 'session-1', agent_id: agentId });
  assert.equal(outputForRoute(start('agent-default'), { homeDir }), null);

  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify({ agents: 'claude', review: 'default' }));
  assert.deepEqual(outputForRoute(start('agent-claude'), { homeDir }), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CLAUDE_ROUTE_CONTEXT },
  });

  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify({ agents: 'codex', review: 'default' }));
  assert.deepEqual(outputForRoute(start('agent-codex'), { homeDir }), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CODEX_ROUTE_CONTEXT },
  });
});

test('Claude 経路ではサブエージェントの codex-agent.sh 呼び出しだけを拒否する', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'default' });
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-1', agent_id: 'agent-1' };
  assert.deepEqual(outputForRoute(start, { homeDir }), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CLAUDE_ROUTE_CONTEXT },
  });
  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify({ agents: 'codex', review: 'default' }));
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    session_id: 'session-1',
    agent_id: 'agent-1',
    tool_input: { command: 'bash ~/.claude/tools/codex-agent.sh impl-hard' },
  };

  assert.deepEqual(outputForRoute(input, { homeDir }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: CLAUDE_ROUTE_CONTEXT,
    },
  });
  assert.equal(outputForRoute({ ...input, agent_id: undefined }, { homeDir }), null);
  assert.equal(outputForRoute({ ...input, tool_input: { command: 'npm test' } }, { homeDir }), null);
  assert.equal(outputForRoute({ ...input, tool_name: 'Read' }, { homeDir }), null);
  assert.equal(outputForRoute({ ...input, tool_input: { command: 'echo codex-agent.sh' } }, { homeDir }), null);
});

test('起動後に経路を変えても稼働中の Codex は codex-agent.sh --wait を拒否されない', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'codex', review: 'default' });
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-codex', agent_id: 'agent-codex' };
  assert.deepEqual(outputForRoute(start, { homeDir }), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CODEX_ROUTE_CONTEXT },
  });

  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify({ agents: 'claude', review: 'default' }));
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    session_id: start.session_id,
    agent_id: start.agent_id,
    tool_input: { command: 'bash ~/.claude/tools/codex-agent.sh --wait run-123' },
  };
  assert.equal(outputForRoute(input, { homeDir }), null);
});

test('開始時の記録がないサブエージェントは現在の経路設定で止めない', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'default' });
  const input = {
    hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'session-old', agent_id: 'agent-old',
    tool_input: { command: 'bash ~/.claude/tools/codex-agent.sh impl-hard' },
  };
  assert.equal(outputForRoute(input, { homeDir }), null);
});

test('同じサブエージェントの 2 回目の SubagentStart と SubagentStop の後も初回の経路を保つ', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'codex', review: 'default' });
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-resume', agent_id: 'agent-resume' };
  outputForRoute(start, { homeDir });
  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify({ agents: 'claude', review: 'default' }));

  assert.equal(outputForRoute({ ...start, hook_event_name: 'SubagentStop' }, { homeDir }), null);
  assert.deepEqual(outputForRoute(start, { homeDir }), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CODEX_ROUTE_CONTEXT },
  });
  const input = {
    ...start, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'bash ~/.claude/tools/codex-agent.sh --wait run-123' },
  };
  assert.equal(outputForRoute(input, { homeDir }), null);
});

test('経路記録のファイル名は session ID と agent ID のパス文字を含まない', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'default' });
  const start = { hook_event_name: 'SubagentStart', session_id: '../session:1', agent_id: '../agent?1' };
  outputForRoute(start, { homeDir });

  const entries = await fs.readdir(path.join(homeDir, 'route-agents'));
  assert.equal(entries.length, 1);
  assert.match(entries[0], /^[a-f0-9]+\.[a-f0-9]+\.json$/);
});

test('SubagentStart は 24 時間より古い経路記録を削除する', async (t) => {
  const homeDir = await temporaryHome(t);
  const directory = path.join(homeDir, 'route-agents');
  await fs.mkdir(directory);
  const staleRecord = path.join(directory, 'stale.json');
  await fs.writeFile(staleRecord, JSON.stringify({ route: 'claude' }));
  const oldTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await fs.utimes(staleRecord, oldTime, oldTime);

  outputForRoute({ hook_event_name: 'SubagentStart', session_id: 'session-new', agent_id: 'agent-new' }, { homeDir });
  await assert.rejects(fs.access(staleRecord), { code: 'ENOENT' });
});

test('使った経路記録は 24 時間の掃除の対象から外れる', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'default' });
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-long', agent_id: 'agent-long' };
  outputForRoute(start, { homeDir });
  const [recordName] = await fs.readdir(path.join(homeDir, 'route-agents'));
  const recordPath = path.join(homeDir, 'route-agents', recordName);
  const oldTime = new Date(Date.now() - 23 * 60 * 60 * 1000);
  await fs.utimes(recordPath, oldTime, oldTime);

  const input = {
    ...start, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'bash ~/.claude/tools/codex-agent.sh impl-hard' },
  };
  assert.equal(outputForRoute(input, { homeDir })?.hookSpecificOutput?.permissionDecision, 'deny');
  assert.ok(Date.now() - (await fs.stat(recordPath)).mtimeMs < 60 * 1000);
});

test('経路記録を書けない SubagentStart は応答を返さない', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'codex', review: 'default' });
  const fileSystem = new Proxy(fsSync, {
    get(target, property) {
      if (property === 'writeFileSync') return () => { throw new Error('write failed'); };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const input = { hook_event_name: 'SubagentStart', session_id: 'session-write-fail', agent_id: 'agent-1' };
  assert.equal(outputForRoute(input, { homeDir, fileSystem }), null);
});

test('routing.json を読めない場合はフック出力を返さない', async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-route-missing-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const toolsDirectory = path.join(homeDir, 'tools');
  await fs.mkdir(toolsDirectory);
  await fs.writeFile(path.join(toolsDirectory, 'codex-agent.sh'), '');
  assert.equal(outputForRoute({ hook_event_name: 'SubagentStart' }, { homeDir, claudeHome: homeDir }), null);
  assert.equal(outputForInputText('{invalid', { homeDir }), null);

  await fs.writeFile(path.join(homeDir, 'routing.json'), '{invalid');
  assert.equal(outputForRoute({ hook_event_name: 'SubagentStart' }, { homeDir, claudeHome: homeDir }), null);
});
