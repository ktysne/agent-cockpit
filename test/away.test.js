const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { AWAY_CONTEXT, TASK_CONTEXT, runAwayHook, sessionSummary } = require('../src/hooks/away');

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

test('離席中の AskUserQuestion は常駐サーバーの回答待ちに登録し、期限後の JSON を返す', async (t) => {
  const homeDir = await temporaryHome(t);
  const fallbackOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: '期限切れ',
    },
  };
  const calls = [];
  const result = await runAwayHook({
    session_id: 'ask-session', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'ask-42',
    tool_input: { questions: [{ question: 'どの形式にしますか。', options: [] }] },
  }, {
    homeDir,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.action === 'ask-register') return new Response(JSON.stringify({ awaiting: true, decisionId: 'ask-42', fallbackOutput }));
      if (body.action === 'ask-poll') return new Response(JSON.stringify({ outcome: 'timeout' }));
      return new Response(JSON.stringify({ outcome: 'timeout', hookOutput: fallbackOutput }));
    },
  });
  assert.deepEqual(result, fallbackOutput);
  assert.deepEqual(calls.map((call) => call.action), ['ask-register', 'ask-poll', 'ask-finish']);
  assert.equal(calls[0].event_name, 'PreToolUse');
  assert.equal(calls[0].id, 'ask-42');
});

test('未対応の質問結末は server-lost として終了する', async (t) => {
  const homeDir = await temporaryHome(t);
  const fallbackOutput = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny' } };
  const calls = [];
  const result = await runAwayHook({
    session_id: 'ask-session', hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_use_id: 'ask-43',
    tool_input: { questions: [{ question: 'どの形式にしますか。', options: [] }] },
  }, {
    homeDir,
    fetchImpl: async (_url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (body.action === 'ask-register') return new Response(JSON.stringify({ awaiting: true, decisionId: 'ask-43', fallbackOutput }));
      if (body.action === 'ask-poll') return new Response(JSON.stringify({ outcome: 'hold' }));
      return new Response(JSON.stringify({ outcome: 'server-lost', hookOutput: fallbackOutput }));
    },
  });

  assert.equal(calls.find((body) => body.action === 'ask-finish').outcome, 'server-lost');
  assert.deepEqual(result, fallbackOutput);
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

test('UserPromptSubmit と SessionStart にタスク登録の決まりと離席中の文脈を返す', async (t) => {
  const homeDir = await temporaryHome(t);
  const fetchImpl = async () => awayResponse();
  for (const hookEventName of ['UserPromptSubmit', 'SessionStart']) {
    const result = await runAwayHook({ hook_event_name: hookEventName }, { homeDir, fetchImpl });
    assert.equal(result.hookSpecificOutput.hookEventName, hookEventName);
    assert.equal(
      result.hookSpecificOutput.additionalContext,
      `${TASK_CONTEXT}\n${AWAY_CONTEXT.replace('{since}', '2026-10-02T01:02:03.000Z')}`,
    );
  }
});

test('server.json が無くてもメインセッションへタスク登録の決まりを返す', async (t) => {
  const homeDir = await temporaryHome(t, false);
  let fetchCount = 0;
  const result = await runAwayHook({ hook_event_name: 'UserPromptSubmit' }, {
    homeDir,
    fetchImpl: async () => { fetchCount += 1; return awayResponse(); },
  });
  assert.equal(result.hookSpecificOutput.additionalContext, TASK_CONTEXT);
  assert.equal(fetchCount, 0);
});

test('サブエージェントの UserPromptSubmit にはタスク登録の決まりを足さない', async (t) => {
  const homeDir = await temporaryHome(t);
  const result = await runAwayHook({ hook_event_name: 'UserPromptSubmit', agent_id: 'agent-1' }, {
    homeDir,
    fetchImpl: async () => awayResponse(false),
  });
  assert.equal(result, null);
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

test('引き継ぎ要約はタスクと判断事項を各 10 件まで表示する', () => {
  const summary = sessionSummary({
    tasks: Array.from({ length: 12 }, (_, index) => ({ title: `task-${index + 1}`, state: 'todo' })),
    decisions: Array.from({ length: 13 }, (_, index) => ({
      id: `decision-${index + 1}`, title: `question-${index + 1}`, state: 'waiting',
    })),
  });
  assert.match(summary, /task-10 \(todo\)、ほか 2 件/);
  assert.doesNotMatch(summary, /task-11/);
  assert.match(summary, /decision-10 question-10 \(waiting\)、ほか 3 件/);
  assert.doesNotMatch(summary, /decision-11/);
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
  assert.equal((context.match(/Agent Cockpit:/g) || []).length, 3);
});

test('常駐サーバーの応答が無くてもタスク登録の決まりは返す', async (t) => {
  const homeDir = await temporaryHome(t);
  const startedAt = performance.now();
  let aborted = false;
  const result = await runAwayHook({ hook_event_name: 'UserPromptSubmit' }, {
    homeDir,
    fetchImpl: (_url, { signal }) => new Promise((resolve) => {
      signal.addEventListener('abort', () => { aborted = true; }, { once: true });
    }),
  });
  assert.equal(result.hookSpecificOutput.additionalContext, TASK_CONTEXT);
  assert.equal(aborted, true);
  assert.ok(performance.now() - startedAt < 1300);
});
