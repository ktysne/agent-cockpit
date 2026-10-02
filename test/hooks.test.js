const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const {
  childEnvironment,
  extractAskUserQuestionResolution,
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

test('フックは入力全文を送らず、任意のツール出力から Codex の行だけを抽出する', async (t) => {
  await temporaryHome(t);
  const event = makeHookEvent({
    session_id: 'hook-1', hook_event_name: 'PostToolUse', cwd: 'D:\\repo', agent_id: 'parent-1',
    tool_name: 'Read', tool_use_id: 'read-1',
    tool_input: { file_path: 'README.md' },
    tool_response: { content: [{ type: 'text', text: 'private output\ncodex-agent: agent=agent-7 model=gpt-5.5-codex effort=high sandbox=read-only codex_home=C:\\Users\\User Data\\.codex workdir=D:\\repo\ncodex-agent: result=ok\nmore private output' }] },
  }, 1234);
  assert.deepEqual(event, {
    session_id: 'hook-1', hook_event_name: 'PostToolUse', cwd: 'D:\\repo', hookAt: 1234, agent_id: 'parent-1',
    input_fields: ['session_id', 'hook_event_name', 'cwd', 'agent_id', 'tool_name', 'tool_use_id', 'tool_input', 'tool_response'],
    tool_name: 'Read', tool_use_id: 'read-1',
    codexOutput: {
      auditLine: 'codex-agent: agent=agent-7 model=gpt-5.5-codex effort=high sandbox=read-only codex_home=C:\\Users\\User Data\\.codex workdir=D:\\repo',
      resultLine: 'codex-agent: result=ok',
    },
  });
  assert.ok(!JSON.stringify(event).includes('private output'));
});

test('Agent の説明は 200 文字までフックイベントに含める', async (t) => {
  await temporaryHome(t);
  const event = makeHookEvent({
    session_id: 'agent-description', hook_event_name: 'PreToolUse',
    tool_name: 'Agent', tool_use_id: 'agent-1',
    tool_input: { description: '説明'.repeat(120), prompt: '送信しない本文' },
  });
  assert.equal(event.description, '説明'.repeat(100));
  assert.ok(!JSON.stringify(event).includes('送信しない本文'));
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

test('AskUserQuestion の質問だけを上限付きでフックイベントに含める', async (t) => {
  await temporaryHome(t);
  const event = makeHookEvent({
    session_id: 'ask-session', hook_event_name: 'PreToolUse', cwd: 'D:\\repo',
    tool_name: 'AskUserQuestion', tool_use_id: 'ask-1',
    tool_input: {
      questions: [{
        question: 'どの形式にしますか。',
        header: '形式',
        multiSelect: false,
        options: [
          { label: '(推奨) JSON', description: '既存 API で使えます。', secret: 'discarded' },
          { label: 'YAML', description: '設定ファイル向けです。' },
        ],
      }],
      private: 'discarded',
    },
  });
  assert.deepEqual(event.questions, [{
    question: 'どの形式にしますか。',
    header: '形式',
    multiSelect: false,
    options: [
      { label: '(推奨) JSON', description: '既存 API で使えます。', recommended: true },
      { label: 'YAML', description: '設定ファイル向けです。', recommended: false },
    ],
  }]);
  assert.ok(!JSON.stringify(event).includes('discarded'));
});

test('AskUserQuestion の回答抽出は異なる応答形を扱い、不明な形では選択を空にする', () => {
  const cases = [
    ['JSON', []],
    [{ answer: 'YAML' }, ['YAML']],
    [{ answers: [{ question: '形式', answer: 'JSON' }, { answer: '二つ目' }] }, ['JSON', '二つ目']],
    [{ answers: { 形式: 'YAML' } }, ['YAML']],
    [{ text: '説明文で、選択肢とは限らない' }, []],
  ];
  for (const [response, chosen] of cases) {
    assert.deepEqual(extractAskUserQuestionResolution(response), { chosen, note: '' });
  }
});

test('AskUserQuestion の回答を本文の全文なしで PostToolUse に載せる', async (t) => {
  await temporaryHome(t);
  const event = makeHookEvent({
    session_id: 'ask-session', hook_event_name: 'PostToolUse',
    tool_name: 'AskUserQuestion', tool_use_id: 'ask-1',
    tool_response: { answers: [{ answer: 'JSON' }], private: 'discarded' },
  });
  assert.deepEqual(event.decisionResolution, { chosen: ['JSON'], note: '' });
  assert.ok(!JSON.stringify(event).includes('discarded'));
  const agentEvent = makeHookEvent({
    session_id: 'ask-session', hook_event_name: 'PostToolUse', agent_id: 'agent-1',
    tool_name: 'AskUserQuestion', tool_use_id: 'ask-1', tool_response: { answer: 'JSON' },
  });
  assert.equal(Object.hasOwn(agentEvent, 'decisionResolution'), false);
});
