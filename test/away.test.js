const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { DENY_REASON, runAwayHook } = require('../src/hooks/away');

async function temporaryHome(testContext, withServerInfo = true) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-away-test-'));
  if (withServerInfo) {
    await fs.writeFile(path.join(homeDir, 'server.json'), JSON.stringify({
      pid: process.pid,
      port: 49123,
      secret: 'test-secret',
      startedAt: '2026-10-02T00:00:00.000Z',
    }));
  }
  testContext.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  return homeDir;
}

function awayResponse(enabled = true, since = Date.parse('2026-10-02T01:02:03.000Z')) {
  return new Response(JSON.stringify({ enabled, since: enabled ? since : null }), { status: 200 });
}

test('離席中の AskUserQuestion を拒否する', async (t) => {
  const homeDir = await temporaryHome(t);
  const result = await runAwayHook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'ask-42' }, {
    homeDir,
    fetchImpl: async () => awayResponse(),
  });
  assert.deepEqual(result, {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: DENY_REASON.replace('{id}', 'ask-42'),
    },
  });
});

test('離席中でも AskUserQuestion 以外のツールには出力しない', async (t) => {
  const homeDir = await temporaryHome(t);
  let fetchCount = 0;
  const result = await runAwayHook({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, {
    homeDir,
    fetchImpl: async () => { fetchCount += 1; return awayResponse(); },
  });
  assert.equal(result, null);
  assert.equal(fetchCount, 0);
});

test('離席中でなければ出力しない', async (t) => {
  const homeDir = await temporaryHome(t);
  const result = await runAwayHook({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }, {
    homeDir,
    fetchImpl: async () => awayResponse(false),
  });
  assert.equal(result, null);
});

test('UserPromptSubmit と SessionStart に ISO 8601 の追加文脈を返す', async (t) => {
  const homeDir = await temporaryHome(t);
  const fetchImpl = async () => awayResponse();
  for (const hookEventName of ['UserPromptSubmit', 'SessionStart']) {
    const result = await runAwayHook({ hook_event_name: hookEventName }, { homeDir, fetchImpl });
    assert.equal(result.hookSpecificOutput.hookEventName, hookEventName);
    assert.equal(
      result.hookSpecificOutput.additionalContext,
      'Agent Cockpit: 開発者は離席中です(2026-10-02T01:02:03.000Zから)。開発者に尋ねずに、推奨を適用して作業を続けてください。破壊的な操作、PR のマージ、main への push は行わず、判断待ちとして最後の報告に書いてください。',
    );
  }
});

test('server.json が無ければ常駐サーバーへ接続せず出力しない', async (t) => {
  const homeDir = await temporaryHome(t, false);
  let fetchCount = 0;
  const result = await runAwayHook({ hook_event_name: 'UserPromptSubmit' }, {
    homeDir,
    fetchImpl: async () => { fetchCount += 1; return awayResponse(); },
  });
  assert.equal(result, null);
  assert.equal(fetchCount, 0);
});

test('compact の SessionStart は離席中でなくてもタスクと未解決判断の要約を返す', async (t) => {
  const homeDir = await temporaryHome(t);
  let requestedUrl = '';
  const result = await runAwayHook({
    session_id: 'compact-session', hook_event_name: 'SessionStart', source: 'compact',
  }, {
    homeDir,
    fetchImpl: async (url) => {
      requestedUrl = url;
      return new Response(JSON.stringify({
        enabled: false,
        since: null,
        tasks: [{ title: '画面を更新する', state: 'doing' }],
        decisions: [{ id: 'ask-42', title: '配色を選ぶ', state: 'waiting' }],
      }), { status: 200 });
    },
  });
  assert.equal(requestedUrl, 'http://127.0.0.1:49123/api/sessions/compact-session/context');
  assert.match(result.hookSpecificOutput.additionalContext, /画面を更新する \(doing\)/);
  assert.match(result.hookSpecificOutput.additionalContext, /ask-42 配色を選ぶ \(waiting\)/);
});

test('resume の引き継ぎ要約と離席中の文脈を一つにまとめる', async (t) => {
  const homeDir = await temporaryHome(t);
  const result = await runAwayHook({
    session_id: 'resume-session', hook_event_name: 'SessionStart', source: 'resume',
  }, {
    homeDir,
    fetchImpl: async () => new Response(JSON.stringify({
      enabled: true,
      since: Date.parse('2026-10-02T01:02:03.000Z'),
      tasks: [],
      decisions: [],
    }), { status: 200 }),
  });
  const context = result.hookSpecificOutput.additionalContext;
  assert.match(context, /タスク: なし/);
  assert.match(context, /未解決の判断事項: なし/);
  assert.match(context, /開発者は離席中です/);
  assert.equal((context.match(/Agent Cockpit:/g) || []).length, 2);
});

test('常駐サーバーの応答が 1 秒以内に届かなければ出力しない', async (t) => {
  const homeDir = await temporaryHome(t);
  const startedAt = performance.now();
  let aborted = false;
  const result = await runAwayHook({ hook_event_name: 'UserPromptSubmit' }, {
    homeDir,
    fetchImpl: (_url, { signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    }),
  });
  assert.equal(result, null);
  assert.equal(aborted, true);
  assert.ok(performance.now() - startedAt < 1300);
});
