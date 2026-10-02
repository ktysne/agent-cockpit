const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const {
  childEnvironment,
  makeHookEvent,
  runHook,
} = require('../src/hooks/event');

async function temporaryHome(testContext) {
  const previous = process.env.AGENT_COCKPIT_HOME;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-test-'));
  process.env.AGENT_COCKPIT_HOME = homeDir;
  testContext.after(async () => {
    if (previous === undefined) delete process.env.AGENT_COCKPIT_HOME;
    else process.env.AGENT_COCKPIT_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  });
  return { homeDir, claudeHome: path.join(homeDir, '.claude') };
}

test('フックは入力全文を送らず、Bash の監査行だけを抽出する', async (t) => {
  await temporaryHome(t);
  const event = makeHookEvent({
    session_id: 'hook-1', hook_event_name: 'PostToolUse', cwd: 'D:\\repo',
    tool_name: 'Bash', tool_use_id: 'bash-1',
    tool_input: { command: 'secret command' },
    tool_response: 'private output\ncodex-agent: agent=agent-7 model=gpt-5.5-codex effort=high\nmore private output',
  }, 1234);
  assert.deepEqual(event, {
    session_id: 'hook-1', hook_event_name: 'PostToolUse', cwd: 'D:\\repo', hookAt: 1234,
    input_fields: ['session_id', 'hook_event_name', 'cwd', 'tool_name', 'tool_use_id', 'tool_input', 'tool_response'],
    tool_name: 'Bash', tool_use_id: 'bash-1',
    codexAudit: { agent_id: 'agent-7', model: 'gpt-5.5-codex', effort: 'high' },
  });
  assert.ok(!JSON.stringify(event).includes('private output'));
  assert.ok(!JSON.stringify(event).includes('secret command'));
});

test('常駐サーバーへ渡す環境から CLAUDE_CODE_ 変数を除く', async (t) => {
  await temporaryHome(t);
  assert.deepEqual(childEnvironment({
    PATH: 'path-value', CLAUDE_CODE_SESSION_ID: 'session-value',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret-value', OTHER: 'kept',
  }), { PATH: 'path-value', OTHER: 'kept' });
});

test('常駐サーバーに接続できなくても 1 秒程度で終了コード 0 を返す', async (t) => {
  const { homeDir } = await temporaryHome(t);
  await fs.writeFile(path.join(homeDir, 'server.json'), JSON.stringify({
    pid: 12345, port: 0, secret: 'test-secret', startedAt: '2026-10-02T00:00:00.000Z',
  }));
  let connectionAttempts = 0;
  const startedAt = performance.now();
  const result = await runHook({
    session_id: 'offline', hook_event_name: 'PostToolUse', cwd: 'D:\\repo',
    tool_name: 'Read', tool_use_id: 'tool-1',
  }, {
    homeDir,
    environment: { AGENT_COCKPIT_HOME: homeDir },
    fetchImpl: async () => { connectionAttempts += 1; throw new Error('ECONNREFUSED'); },
    startServer: async () => { throw new Error('server cannot start'); },
  });
  assert.equal(result.exitCode, 0);
  assert.ok(connectionAttempts > 0);
  assert.ok(performance.now() - startedAt < 1000);
});
