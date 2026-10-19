const test = require('node:test');
const assert = require('node:assert/strict');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CLAUDE_ROUTE_CONTEXT, CODEX_ROUTE_CONTEXT, commandInvokesCodexAgent, effectiveRouteForSubagentStart, outputForInputText, outputForRoute } = require('../src/hooks/route');
const { temporaryDirectory } = require('./support/temp');

async function temporaryHome(t, routing = { agents: 'default', review: 'default' }, withCodexAgent = true) {
  const homeDir = temporaryDirectory(t, 'agent-cockpit-route-hook-', {
    environment: { CLAUDE_CONFIG_DIR: (directory) => directory },
  }).directory;
  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify(routing));
  if (withCodexAgent) {
    const toolsDirectory = path.join(homeDir, 'tools');
    await fs.mkdir(toolsDirectory);
    await fs.writeFile(path.join(toolsDirectory, 'codex-agent.sh'), '');
  }
  return homeDir;
}

test('SubagentStart は codex-agent.sh が無ければ経路を読み込まず、Claude ホームを差し替えられる', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'default' }, false);
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-no-codex', agent_id: 'agent-1', agent_type: 'impl-hard' };
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
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-fallback', agent_id: 'agent-1', agent_type: 'impl-hard' };
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
  const start = (agentId) => ({ hook_event_name: 'SubagentStart', session_id: 'session-1', agent_id: agentId, agent_type: 'impl-hard' });
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

test('SubagentStart は bridge の窓口種別ごとに経路を記録して差し込む', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'codex' });
  const agentTypes = ['impl-hard', 'impl-standard', 'impl-light', 'codex-subagent'];
  for (const [index, agentType] of agentTypes.entries()) {
    const start = { hook_event_name: 'SubagentStart', session_id: 'session-scoped', agent_id: `agent-${index}`, agent_type: agentType };
    assert.deepEqual(outputForRoute(start, { homeDir }), {
      hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CLAUDE_ROUTE_CONTEXT },
    }, agentType);
    const recordPath = path.join(homeDir, 'route-agents',
      `${Buffer.from(start.session_id).toString('hex')}.${Buffer.from(start.agent_id).toString('hex')}.json`);
    assert.deepEqual(JSON.parse(await fs.readFile(recordPath, 'utf8')), { route: 'claude' });
  }
});

test('codex-review は review 経路に従い、既定も記録して Claude の agents 設定では Codex 起動を拒否しない', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'codex' });
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-review', agent_id: 'agent-codex-review', agent_type: 'codex-review' };
  assert.deepEqual(outputForRoute(start, { homeDir }), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CODEX_ROUTE_CONTEXT },
  });
  assert.equal(effectiveRouteForSubagentStart(start, { homeDir }), 'codex');
  assert.equal(outputForRoute({
    ...start, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'bash ~/.claude/tools/codex-agent.sh review' },
  }, { homeDir }), null);

  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify({ agents: 'claude', review: 'claude' }));
  const claudeReviewStart = { ...start, agent_id: 'agent-claude-review' };
  assert.deepEqual(outputForRoute(claudeReviewStart, { homeDir }), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CLAUDE_ROUTE_CONTEXT },
  });
  assert.equal(outputForRoute({
    ...claudeReviewStart, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'bash ~/.claude/tools/codex-agent.sh review' },
  }, { homeDir })?.hookSpecificOutput?.permissionDecision, 'deny');

  for (const [index, routing] of [{ agents: 'claude', review: 'default' }, { agents: 'claude' }].entries()) {
    await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify(routing));
    const unsetReviewStart = { ...start, agent_id: `agent-review-default-${index}` };
    assert.equal(outputForRoute(unsetReviewStart, { homeDir }), null);
    assert.equal(effectiveRouteForSubagentStart(unsetReviewStart, { homeDir }), 'default');
    const recordPath = path.join(homeDir, 'route-agents',
      `${Buffer.from(unsetReviewStart.session_id).toString('hex')}.${Buffer.from(unsetReviewStart.agent_id).toString('hex')}.json`);
    assert.deepEqual(JSON.parse(await fs.readFile(recordPath, 'utf8')), { route: 'default' });
  }
});

test('既定で開始した codex-review は Claude に設定を変えて再開しても Codex 待機を拒否しない', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'default' });
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-review-resume', agent_id: 'agent-review-resume', agent_type: 'codex-review' };
  assert.equal(outputForRoute(start, { homeDir }), null);
  assert.equal(effectiveRouteForSubagentStart(start, { homeDir }), 'default');

  const recordPath = path.join(homeDir, 'route-agents',
    `${Buffer.from(start.session_id).toString('hex')}.${Buffer.from(start.agent_id).toString('hex')}.json`);
  assert.deepEqual(JSON.parse(await fs.readFile(recordPath, 'utf8')), { route: 'default' });
  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify({ agents: 'claude', review: 'claude' }));

  assert.equal(outputForRoute(start, { homeDir }), null);
  assert.equal(effectiveRouteForSubagentStart(start, { homeDir }), 'default');
  assert.equal(outputForRoute({
    ...start, hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: 'bash ~/.claude/tools/codex-agent.sh --wait codex-review-run' },
  }, { homeDir }), null);
});

test('対象外の agent_type は経路記録、差し込み、codex-agent.sh の拒否の対象外にする', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'codex' });
  const agentTypes = ['review-claude', 'impl-hard-claude', 'impl-standard-claude', 'impl-light-claude', 'general-purpose', 'Explore', undefined];

  for (const [index, agentType] of agentTypes.entries()) {
    const start = { hook_event_name: 'SubagentStart', session_id: 'session-out-of-scope', agent_id: `agent-${index}` };
    if (agentType !== undefined) start.agent_type = agentType;
    assert.equal(outputForRoute(start, { homeDir }), null, String(agentType));
    assert.equal(effectiveRouteForSubagentStart(start, { homeDir }), null, String(agentType));
    assert.equal(outputForRoute({
      ...start, hook_event_name: 'PreToolUse', tool_name: 'Bash',
      tool_input: { command: 'bash ~/.claude/tools/codex-agent.sh impl-hard' },
    }, { homeDir }), null, String(agentType));
  }

  await assert.rejects(fs.access(path.join(homeDir, 'route-agents')), { code: 'ENOENT' });
});

test('effectiveRouteForSubagentStart は agent_type ごとに対応する経路を返す', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'codex' });
  const agentTypes = [
    ['impl-hard', 'claude'],
    ['impl-standard', 'claude'],
    ['impl-light', 'claude'],
    ['codex-subagent', 'claude'],
    ['codex-review', 'codex'],
  ];

  for (const [agentType, route] of agentTypes) {
    assert.equal(effectiveRouteForSubagentStart({
      hook_event_name: 'SubagentStart', session_id: 'session-effective', agent_id: agentType, agent_type: agentType,
    }, { homeDir }), route, agentType);
  }
  assert.equal(effectiveRouteForSubagentStart({
    hook_event_name: 'SubagentStart', session_id: 'session-effective', agent_id: 'general-purpose', agent_type: 'general-purpose',
  }, { homeDir }), null);
});

test('Claude 経路ではサブエージェントの codex-agent.sh 呼び出しだけを拒否する', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'default' });
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-1', agent_id: 'agent-1', agent_type: 'impl-hard' };
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
  const powerShellInput = {
    ...input,
    tool_name: 'PowerShell',
    tool_input: { command: '& "$HOME\\.claude\\tools\\codex-agent.sh" impl-standard' },
  };
  assert.deepEqual(outputForRoute(powerShellInput, { homeDir }), {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: CLAUDE_ROUTE_CONTEXT,
    },
  });
  assert.equal(outputForRoute({
    ...powerShellInput, tool_input: { command: 'Set-Location "D:\\repo\\"; bash "$HOME/.claude/tools/codex-agent.sh" impl-standard' },
  }, { homeDir })?.hookSpecificOutput.permissionDecision, 'deny');
  assert.equal(outputForRoute({
    ...powerShellInput, tool_input: { command: 'Write-Output "codex-agent.sh impl-standard"' },
  }, { homeDir }), null);
  assert.equal(outputForRoute({
    ...powerShellInput,
    tool_input: { command: "@'\nDon't run: bash ~/.claude/tools/codex-agent.sh impl-standard\n'@ | Set-Content notes.md" },
  }, { homeDir }), null);
  assert.equal(outputForRoute({ ...input, agent_id: undefined }, { homeDir }), null);
  assert.equal(outputForRoute({ ...input, tool_input: { command: 'npm test' } }, { homeDir }), null);
  assert.equal(outputForRoute({ ...input, tool_name: 'Read' }, { homeDir }), null);
  assert.equal(outputForRoute({ ...input, tool_input: { command: 'echo codex-agent.sh' } }, { homeDir }), null);
});

test('Claude 経路の判定は env、代入、サブシェル、bash -lc の呼び出しを検出する', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'default' });
  const input = {
    hook_event_name: 'PreToolUse', tool_name: 'Bash', session_id: 'session-shell-forms', agent_id: 'agent-shell-forms',
    tool_input: { command: '' },
  };
  outputForRoute({ ...input, hook_event_name: 'SubagentStart', agent_type: 'impl-hard' }, { homeDir });
  const commands = [
    'VAR=1 bash ~/.claude/tools/codex-agent.sh impl-hard',
    'env A=1 bash ~/.claude/tools/codex-agent.sh impl-hard',
    '( bash ~/.claude/tools/codex-agent.sh impl-hard )',
    'bash -lc "bash ~/.claude/tools/codex-agent.sh impl-hard"',
    '{ bash ~/.claude/tools/codex-agent.sh impl-hard; }',
    'timeout 600 bash ~/.claude/tools/codex-agent.sh impl-hard',
    'timeout -s KILL 600 bash ~/.claude/tools/codex-agent.sh impl-hard',
    'nohup bash ~/.claude/tools/codex-agent.sh impl-hard',
    'exec bash ~/.claude/tools/codex-agent.sh impl-hard',
    'command bash ~/.claude/tools/codex-agent.sh impl-hard',
    'time bash ~/.claude/tools/codex-agent.sh impl-hard',
    'nice -n 10 bash ~/.claude/tools/codex-agent.sh impl-hard',
    '/usr/bin/env bash ~/.claude/tools/codex-agent.sh impl-hard',
    'env -i bash ~/.claude/tools/codex-agent.sh impl-hard',
    'env -u HOME A=1 bash ~/.claude/tools/codex-agent.sh impl-hard',
    'source ~/.claude/tools/codex-agent.sh',
    '. ~/.claude/tools/codex-agent.sh',
    'exec -a worker bash ~/.claude/tools/codex-agent.sh impl-hard',
    '! bash ~/.claude/tools/codex-agent.sh impl-hard',
    'builtin source ~/.claude/tools/codex-agent.sh',
    'A=1 env -i bash ~/.claude/tools/codex-agent.sh impl-hard',
  ];

  for (const command of commands) {
    assert.equal(commandInvokesCodexAgent(command), true, command);
    assert.equal(outputForRoute({ ...input, tool_input: { command } }, { homeDir })?.hookSpecificOutput?.permissionDecision, 'deny', command);
  }
  for (const command of [
    'echo codex-agent.sh',
    'printf "%s\\n" codex-agent.sh',
    'bash -lc "echo codex-agent.sh"',
    'bash echo codex-agent.sh',
    'bash --version ~/.claude/tools/codex-agent.sh',
    'time echo codex-agent.sh',
    'env A=1 grep codex-agent.sh notes.md',
    'source ~/.bashrc',
    'cat > notes.md <<EOF\n- bash ~/.claude/tools/codex-agent.sh impl-hard で委譲\nEOF',
    'command -v ~/.claude/tools/codex-agent.sh',
  ]) assert.equal(commandInvokesCodexAgent(command), false, command);
});

test('起動後に経路を変えても稼働中の Codex は codex-agent.sh --wait を拒否されない', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'codex', review: 'default' });
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-codex', agent_id: 'agent-codex', agent_type: 'impl-hard' };
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
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-resume', agent_id: 'agent-resume', agent_type: 'impl-hard' };
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
  const start = { hook_event_name: 'SubagentStart', session_id: '../session:1', agent_id: '../agent?1', agent_type: 'impl-hard' };
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

  outputForRoute({ hook_event_name: 'SubagentStart', session_id: 'session-new', agent_id: 'agent-new', agent_type: 'impl-hard' }, { homeDir });
  await assert.rejects(fs.access(staleRecord), { code: 'ENOENT' });
});

test('使った経路記録は 24 時間の掃除の対象から外れる', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'default' });
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-long', agent_id: 'agent-long', agent_type: 'impl-hard' };
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
  const input = { hook_event_name: 'SubagentStart', session_id: 'session-write-fail', agent_id: 'agent-1', agent_type: 'impl-hard' };
  assert.equal(outputForRoute(input, { homeDir, fileSystem }), null);
});

test('routing.json を読めない場合はフック出力を返さない', async (t) => {
  const homeDir = temporaryDirectory(t, 'agent-cockpit-route-missing-').directory;
  const toolsDirectory = path.join(homeDir, 'tools');
  await fs.mkdir(toolsDirectory);
  await fs.writeFile(path.join(toolsDirectory, 'codex-agent.sh'), '');
  const start = { hook_event_name: 'SubagentStart', session_id: 'session-routing-missing', agent_id: 'agent-1', agent_type: 'impl-hard' };
  assert.equal(outputForRoute(start, { homeDir, claudeHome: homeDir }), null);
  assert.equal(outputForInputText('{invalid', { homeDir }), null);

  await fs.writeFile(path.join(homeDir, 'routing.json'), '{invalid');
  assert.equal(outputForRoute({ ...start, agent_id: 'agent-invalid-routing' }, { homeDir, claudeHome: homeDir }), null);
});

test('routing.json の EBUSY が続く SubagentStart は応答も経路記録も作らない', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'codex', review: 'default' });
  let attempts = 0;
  const delays = [];
  const fileSystem = new Proxy(fsSync, {
    get(target, property) {
      if (property === 'readFileSync') return (filePath, ...args) => {
        if (path.basename(filePath) === 'routing.json') {
          attempts += 1;
          throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        }
        return target.readFileSync.call(target, filePath, ...args);
      };
      const value = target[property];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  assert.equal(outputForRoute({ hook_event_name: 'SubagentStart', session_id: 'busy-session', agent_id: 'busy-agent', agent_type: 'impl-hard' }, {
    homeDir, fileSystem, readRetryOptions: { delaySync: (milliseconds) => delays.push(milliseconds) },
  }), null);

  assert.equal(attempts, 5);
  assert.ok(delays.reduce((sum, milliseconds) => sum + milliseconds, 0) <= 200);
  assert.deepEqual(await fs.readdir(path.join(homeDir, 'route-agents')), []);
});
