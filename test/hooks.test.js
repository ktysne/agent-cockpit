const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const {
  childEnvironment,
  extractAskUserQuestionResolution,
  extractCodexWaitRunId,
  makeHookEvent,
  runHook,
} = require('../src/hooks/event');
const { sanitizeEvent } = require('../src/server/events');

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

test('PostToolUseFailure では error の文字列からも Codex の結果行を抽出する', async (t) => {
  await temporaryHome(t);
  const event = makeHookEvent({
    session_id: 'hook-failure', hook_event_name: 'PostToolUseFailure', cwd: 'D:/repo', agent_id: 'parent-1',
    tool_name: 'Bash', tool_use_id: 'bash-1', error: 'Exit code 75\nprivate output\ncodex-agent: result=rate-limited retry=14:00',
  }, 1234);
  assert.deepEqual(event.codexOutput, { resultLine: 'codex-agent: result=rate-limited retry=14:00' });
  assert.ok(!JSON.stringify(event).includes('private output'));
});

test('codex-agent: run= の最初の行を runLine として抽出し、形式の合う実行 ID だけを渡す', () => {
  const runId = 'impl-hard-20261003-123456-7';
  const event = makeHookEvent({
    session_id: 'codex-run-line', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'bash-1',
    tool_response: `codex-agent: run=${runId} ${'x'.repeat(1100)}\ncodex-agent: run=impl-hard-20261003-123457-8`,
  });
  assert.equal(event.codexOutput.runLine, `codex-agent: run=${runId} ${'x'.repeat(1024 - `codex-agent: run=${runId} `.length)}`);
  assert.equal(event.codexOutput.runLine.length, 1024);
  assert.equal(sanitizeEvent(event).codexRunId, runId);

  const invalid = makeHookEvent({
    session_id: 'codex-invalid-run-line', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'bash-2',
    tool_response: 'codex-agent: run=not-a-run-id',
  });
  assert.equal(invalid.codexOutput.runLine, 'codex-agent: run=not-a-run-id');
  assert.equal(Object.hasOwn(sanitizeEvent(invalid), 'codexRunId'), false);
});

test('SubagentStart イベントに起動時の経路を記録する', async (t) => {
  const { homeDir } = await temporaryHome(t);
  const startedAt = '2026-10-03T00:00:00.000Z';
  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify({ agents: 'claude', review: 'codex' }));
  await fs.writeFile(path.join(homeDir, 'server.json'), JSON.stringify({
    pid: 12345, port: 47821, secret: 'hook-secret', uiSecret: 'ui-secret', startedAt,
  }));
  let postedEvent;
  const result = await runHook({
    session_id: 'route-event', hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'impl-hard',
  }, {
    homeDir,
    deadline: Date.now() + 1000,
    fetchImpl: async (url, options = {}) => {
      if (url.endsWith('/health')) return { ok: true, json: async () => ({ app: 'agent-cockpit', pid: 12345, startedAt }) };
      postedEvent = JSON.parse(options.body);
      return { ok: true, status: 202 };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(postedEvent.route, 'claude');
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

test('入力要約は切り詰めた場合にだけ80文字以内で省略記号を付ける', async (t) => {
  await temporaryHome(t);
  const cases = [
    ['複数行の入力は改行と続く空白を空白にする', 'git status\r\n  2行目\n\t3行目', 'git status 2行目 3行目'],
    ['複数行でも80文字以内なら省略記号を付けない', `git status\n${'x'.repeat(69)}`, `git status ${'x'.repeat(69)}`],
    ['複数行を正規化した全体が80文字を超えたら省略する', `${'x'.repeat(70)}\n${'y'.repeat(11)}`, `${'x'.repeat(70)} ${'y'.repeat(8)}…`],
    ['末尾の改行だけの入力には付けない', 'git status\n', 'git status'],
    ['80文字を超える入力', 'x'.repeat(81), `${'x'.repeat(79)}…`],
    ['80文字ちょうどの入力', 'x'.repeat(80), 'x'.repeat(80)],
  ];

  for (const [label, command, expected] of cases) {
    const event = makeHookEvent({
      session_id: 'summary', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_input: { command },
    });
    assert.equal(event.summary, expected, label);
    assert.ok(event.summary.length <= 80, label);
  }
});

test('常駐サーバーへ渡す環境から CLAUDE_CODE_ 変数を除く', async (t) => {
  await temporaryHome(t);
  assert.deepEqual(childEnvironment({
    PATH: 'path-value', CLAUDE_CODE_SESSION_ID: 'session-value',
    CLAUDE_CODE_MESSAGING_TOKEN: 'secret-value', GH_TOKEN: 'gh-secret',
    GITHUB_TOKEN: 'github-secret', GH_ENTERPRISE_TOKEN: 'enterprise-secret', OTHER: 'kept',
  }), { PATH: 'path-value', OTHER: 'kept' });
});

test('gh pr create と GitHub MCP の応答から PR の URL だけを送る', async () => {
  const bash = makeHookEvent({
    session_id: 'pr-hook', hook_event_name: 'PostToolUse', cwd: 'D:\\repo',
    tool_name: 'Bash', tool_use_id: 'bash-pr', tool_input: { command: 'gh pr create --fill' },
    tool_response: { stdout: 'private output\nhttps://github.com/example/project/pull/42\nmore private output' },
  });
  assert.deepEqual(bash.pullRequest, {
    owner: 'example', repo: 'project', number: 42, url: 'https://github.com/example/project/pull/42',
  });
  assert.equal(bash.ghPrCreateCommand, true);
  assert.ok(!JSON.stringify(bash).includes('private output'));

  const github = makeHookEvent({
    session_id: 'pr-mcp', hook_event_name: 'PostToolUse',
    tool_name: 'mcp__github__create_pull_request', tool_use_id: 'github-pr',
    tool_response: { content: [{ type: 'text', text: 'Created #43 https://github.com/example/project/pull/43' }] },
  });
  assert.deepEqual(github.pullRequest, {
    owner: 'example', repo: 'project', number: 43, url: 'https://github.com/example/project/pull/43',
  });
  assert.ok(!JSON.stringify(github).includes('Created #43'));

  const noUrl = makeHookEvent({
    session_id: 'pr-missing', hook_event_name: 'PostToolUse', tool_name: 'Bash',
    tool_input: { command: 'gh pr create' }, tool_response: 'Pull request created successfully',
  });
  assert.equal(Object.hasOwn(noUrl, 'pullRequest'), false);
});

test('Bash の要約が切れても全文から Codex の --wait 実行 ID を送る', () => {
  const runId = 'impl-hard-20261003-123456-7';
  const event = makeHookEvent({
    session_id: 'codex-wait-hook', hook_event_name: 'PreToolUse', agent_id: 'agent-1',
    tool_name: 'Bash', tool_use_id: 'wait-1',
    tool_input: { command: `${'x'.repeat(100)} && bash ~/.claude/tools/codex-agent.sh --wait "${runId}"` },
  });

  assert.equal(event.summary.length, 80);
  assert.equal(event.codexWaitRunId, runId);

  const longRunId = `${'x'.repeat(300)}-20261003-123456-7`;
  const bounded = makeHookEvent({
    session_id: 'codex-wait-limit', hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: `bash ~/.claude/tools/codex-agent.sh --wait ${longRunId}` },
  });
  assert.equal(bounded.codexWaitRunId.length, 256);
});

test('Codex の --wait は実行 ID の形だけを受け、同じコマンドの起動より優先しない', () => {
  const makeWaitEvent = (command) => makeHookEvent({
    session_id: 'codex-wait-sanitize', hook_event_name: 'PreToolUse', agent_id: 'agent-1',
    tool_name: 'Bash', tool_use_id: 'wait-1', tool_input: { command },
  });
  const invalid = sanitizeEvent(makeWaitEvent('bash ~/.claude/tools/codex-agent.sh --wait <実行 ID>'));
  assert.equal(Object.hasOwn(invalid, 'codexWaitRunId'), false);
  assert.equal(Object.hasOwn(invalid, 'codexWaitDefinition'), false);

  const runId = 'impl-hard-20261003-123456-7';
  const launchAndWait = sanitizeEvent(makeWaitEvent(
    `bash ~/.claude/tools/codex-agent.sh impl-hard --wait ${runId}`,
  ));
  assert.equal(launchAndWait.codexDefinition, 'impl-hard');
  assert.equal(Object.hasOwn(launchAndWait, 'codexWaitRunId'), false);
  assert.equal(Object.hasOwn(launchAndWait, 'codexWaitDefinition'), false);
});

test('文字列やヒアドキュメントに書かれた Codex の --wait は拾わない', () => {
  const runId = 'impl-hard-20261003-123456-7';
  assert.equal(extractCodexWaitRunId(`cat > notes.md <<'EOF'\nbash ~/.claude/tools/codex-agent.sh --wait ${runId}\nEOF`), '');
  assert.equal(extractCodexWaitRunId(`echo "codex-agent.sh --wait ${runId}"`), '');
  assert.equal(extractCodexWaitRunId(`git commit -m "bash codex-agent.sh --wait ${runId}"`), '');
  assert.equal(extractCodexWaitRunId(`echo "手順: cd x; bash codex-agent.sh --wait ${runId}"`), '');
  assert.equal(extractCodexWaitRunId(`printf "%s" "a | codex-agent.sh --wait ${runId}"`), '');
  assert.equal(extractCodexWaitRunId(`echo "quoted\n; bash codex-agent.sh --wait ${runId}"`), '');
  assert.equal(extractCodexWaitRunId(`echo 'quoted; codex-agent.sh --wait ${runId}'`), '');
  assert.equal(extractCodexWaitRunId(`cd /tmp; codex-agent.sh --wait ${runId}`), runId);
  assert.equal(extractCodexWaitRunId(`bash "C:/Users/me/.claude/tools/codex-agent.sh" --wait ${runId}`), runId);
  assert.equal(extractCodexWaitRunId(`x=$(bash ~/.claude/tools/codex-agent.sh --wait ${runId})`), runId);
  assert.equal(extractCodexWaitRunId(`x="$(bash ~/.claude/tools/codex-agent.sh --wait ${runId})"`), runId);
  assert.equal(extractCodexWaitRunId(`echo "$(printf '%s' 'a; codex-agent.sh --wait ${runId}')"`), '');
});

test('Codex の --wait の状態の行を、監査行と結果行とは別に抜き出す', () => {
  const runId = 'impl-hard-20261003-123456-7';
  const event = makeHookEvent({
    session_id: 's', hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'b',
    error: `codex-agent: agent=impl-hard model=gpt-6-luna effort=max\ncodex-agent: waiting run=${runId}\ncodex-agent: vanished run=${runId}\n`,
  });
  assert.equal(event.codexOutput.waitStatusLine, `codex-agent: vanished run=${runId}`);
  assert.equal(event.codexOutput.resultLine, undefined);
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
