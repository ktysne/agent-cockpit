const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CLAUDE_ROUTE_CONTEXT, CODEX_ROUTE_CONTEXT, outputForInputText, outputForRoute } = require('../src/hooks/route');

async function temporaryHome(t, routing = { agents: 'default', review: 'default' }) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-route-hook-'));
  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify(routing));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  return homeDir;
}

test('SubagentStart は選択経路を差し込み、既定では出力しない', async (t) => {
  const homeDir = await temporaryHome(t);
  const input = { hook_event_name: 'SubagentStart', agent_id: 'agent-1' };
  assert.equal(outputForRoute(input, { homeDir }), null);

  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify({ agents: 'claude', review: 'default' }));
  assert.deepEqual(outputForRoute(input, { homeDir }), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CLAUDE_ROUTE_CONTEXT },
  });

  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify({ agents: 'codex', review: 'default' }));
  assert.deepEqual(outputForRoute(input, { homeDir }), {
    hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CODEX_ROUTE_CONTEXT },
  });
});

test('Claude 経路ではサブエージェントの codex-agent.sh 呼び出しだけを拒否する', async (t) => {
  const homeDir = await temporaryHome(t, { agents: 'claude', review: 'default' });
  const input = {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
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

test('routing.json を読めない場合はフック出力を返さない', async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-route-missing-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  assert.equal(outputForRoute({ hook_event_name: 'SubagentStart' }, { homeDir }), null);
  assert.equal(outputForInputText('{invalid', { homeDir }), null);

  await fs.writeFile(path.join(homeDir, 'routing.json'), '{invalid');
  assert.equal(outputForRoute({ hook_event_name: 'SubagentStart' }, { homeDir }), null);
});
