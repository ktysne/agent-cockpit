const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const {
  childEnvironment,
  extractAskUserQuestionResolution,
  extractCodexWaitRunId,
  launchServer,
  makeHookEvent,
  runHook,
} = require('../src/hooks/event');
const { postHookRequest } = require('../src/hooks/answer');
const { sanitizeEvent } = require('../src/server/events');

test('Claude の SessionStart の文字列のモデルだけを初期値として送る', () => {
  for (const model of ['claude-opus-5-5', undefined, 42]) {
    const event = makeHookEvent({ session_id: 'claude-model', hook_event_name: 'SessionStart', model });
    assert.equal(sanitizeEvent(event).model, typeof model === 'string' ? model : '');
  }
  const event = makeHookEvent({ session_id: 'claude-model', hook_event_name: 'Stop', model: 'ignored' });
  assert.equal(event.model, undefined);
});
const { temporaryHome: createTemporaryHome } = require('./support/temp');

async function temporaryHome(testContext) {
  return createTemporaryHome(testContext, 'agent-cockpit-test-', {
    environment: { AGENT_COCKPIT_HOME: (homeDir) => homeDir },
  });
}

test('TaskStop の成功だけに形の合う停止タスク ID を載せて正規化する', () => {
  for (const hook_event_name of ['PostToolUse', 'PostToolUseFailure']) {
    for (const task_id of ['task_1-2', '', '../bad', 'x'.repeat(65), 42]) {
      const valid = hook_event_name === 'PostToolUse' && task_id === 'task_1-2';
      const event = makeHookEvent({ session_id: 'stop-task', hook_event_name, tool_name: 'TaskStop', tool_input: { task_id } });
      assert.equal(event.stoppedTaskId, valid ? task_id : undefined);
      assert.equal(sanitizeEvent(event).stoppedTaskId, valid ? task_id : undefined);
      assert.equal(sanitizeEvent({ ...event, stoppedTaskId: task_id }).stoppedTaskId, valid ? task_id : undefined);
    }
  }
  assert.equal(sanitizeEvent({ session_id: 'stop-task', hook_event_name: 'PostToolUse', tool_name: 'Read', stoppedTaskId: 'task_1-2' }).stoppedTaskId, undefined);
});

test('TaskStop の task_id が無いときは非推奨の shell_id を停止タスク ID にする', () => {
  const stop = (tool_input) => makeHookEvent({ session_id: 'stop-task', hook_event_name: 'PostToolUse', tool_name: 'TaskStop', tool_input }).stoppedTaskId;
  assert.equal(stop({ shell_id: 'shell_1' }), 'shell_1');
  assert.equal(stop({ task_id: 'task_1', shell_id: 'shell_1' }), 'task_1');
  assert.equal(stop({ shell_id: '../bad' }), undefined);
});

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

test('Read の file.content から Codex の結果行と run= の行を抽出する', () => {
  const runId = 'impl-hard-20261003-123456-7';
  const event = makeHookEvent({
    session_id: 'read-file-content', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_use_id: 'read-1',
    tool_response: { file: { content: `private output\ncodex-agent: result=ok\ncodex-agent: run=${runId}` } },
  });

  assert.deepEqual(event.codexOutput, {
    resultLine: 'codex-agent: result=ok',
    runLine: `codex-agent: run=${runId}`,
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

test('Agent の PostToolUse は tool_response の agentId を文字列かつ 256 文字まで含める', async (t) => {
  await temporaryHome(t);
  const makeAgentResponse = (agentId) => makeHookEvent({
    session_id: 'agent-response-id', hook_event_name: 'PostToolUse',
    tool_name: 'Agent', tool_use_id: 'agent-call',
    tool_response: { agentId, resolvedModel: 'claude-resolved' },
  });
  const event = makeAgentResponse('agent-1');
  assert.equal(event.agentId, 'agent-1');
  assert.equal(event.resolvedModel, 'claude-resolved');
  assert.equal(sanitizeEvent(event).agentId, 'agent-1');

  const invalid = makeAgentResponse(42);
  assert.equal(Object.hasOwn(invalid, 'agentId'), false);
  assert.equal(sanitizeEvent({ ...event, agentId: 42 }).agentId, '');
  assert.equal(makeAgentResponse('a'.repeat(300)).agentId.length, 256);
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

test('launchServer は秘密値を除いた環境で子プロセスを起動する', async (t) => {
  const { homeDir } = await temporaryHome(t);
  let childEnvironment = null;
  await launchServer({
    homeDir,
    environment: {
      PATH: 'path-value', OTHER: 'kept',
      CLAUDE_CODE_MESSAGING_TOKEN: 'session-secret',
      GH_TOKEN: 'gh-secret', GITHUB_TOKEN: 'github-secret', GH_ENTERPRISE_TOKEN: 'enterprise-secret',
    },
    spawnProcess: (_executable, _arguments, options) => {
      childEnvironment = options.env;
      const child = new EventEmitter();
      child.unref = () => {};
      setImmediate(() => child.emit('spawn'));
      return child;
    },
  });

  assert.deepEqual(childEnvironment, { PATH: 'path-value', OTHER: 'kept' });
});

test('gh pr create と GitHub MCP の応答から PR の URL だけを送る', async () => {
  const commandCwd = path.join(os.tmpdir(), 'pull-request-repo', 'worktree');
  const command = `cd "${commandCwd.replaceAll('\\', '/')}" && gh pr create --fill`;
  const bash = makeHookEvent({
    session_id: 'pr-hook', hook_event_name: 'PostToolUse', cwd: 'D:\\repo',
    tool_name: 'Bash', tool_use_id: 'bash-pr', tool_input: { command },
    tool_response: { stdout: 'private output\nhttps://github.com/example/project/pull/42\nmore private output' },
  });
  assert.deepEqual(bash.pullRequest, {
    owner: 'example', repo: 'project', number: 42, url: 'https://github.com/example/project/pull/42',
  });
  assert.equal(bash.commandCwd, path.resolve(commandCwd));
  assert.equal(sanitizeEvent(bash).commandCwd, path.resolve(commandCwd));
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
  assert.equal(Object.hasOwn(noUrl, 'commandCwd'), false);
});

test('PostToolUse は絶対 commandCwd を 4096 文字まで受け付ける', () => {
  const base = { session_id: 'command-cwd', hook_event_name: 'PostToolUse', tool_name: 'Bash' };
  const cwd = path.resolve(os.tmpdir(), 'command-repo');
  const pathRoot = path.parse(cwd).root;
  const atLimit = `${pathRoot}${'a'.repeat(4096 - pathRoot.length)}`;
  const overLimit = `${pathRoot}${'a'.repeat(4097 - pathRoot.length)}`;
  assert.equal(sanitizeEvent({ ...base, commandCwd: cwd }).commandCwd, cwd);
  assert.equal(sanitizeEvent({ ...base, commandCwd: atLimit }).commandCwd, atLimit);
  assert.equal(sanitizeEvent({ ...base, commandCwd: 'relative/path' }).commandCwd, undefined);
  assert.equal(sanitizeEvent({ ...base, commandCwd: 42 }).commandCwd, undefined);
  assert.equal(sanitizeEvent({ ...base, commandCwd: overLimit }).commandCwd, undefined);
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
  assert.equal(extractCodexWaitRunId(`# it's slow\nbash ~/.claude/tools/codex-agent.sh --wait ${runId}`), runId);
  assert.equal(extractCodexWaitRunId(`bash ~/.claude/tools/codex-agent.sh \\\n  --wait ${runId}`), runId);
  assert.equal(extractCodexWaitRunId(`# bash ~/.claude/tools/codex-agent.sh --wait ${runId}`), '');
  assert.equal(extractCodexWaitRunId(`echo "$(printf '%s' 'a; codex-agent.sh --wait ${runId}')"`), '');
});

test('長い前置きがあっても Bash のクロスレビュー起動を検出して定義名を送る', () => {
  const command = `cd "${'D:/Desktop/Develop/agent-cockpit/.claude/worktrees/'.repeat(3)}feature" && npm run review:codex 2>&1 | tail -40`;
  const event = makeHookEvent({
    session_id: 'codex-review-hook', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'bash-review',
    tool_input: { command },
  });
  assert.ok(event.summary.length <= 80);
  assert.equal(event.codexReviewDefinition, 'codex-review');
});

test('クロスレビューの fix 起動と node 起動から定義名を選ぶ', () => {
  const commands = [
    ['npm run review:codex:fix', 'codex-subagent'],
    ['cd /tmp && npm run review:codex -- --fix', 'codex-subagent'],
    ['node tools/cross-review.js codex', 'codex-review'],
    ['node tools/cross-review.js codex --fix', 'codex-subagent'],
    ["node tools/cross-review.js codex '--fix'", 'codex-subagent'],
    ['npm run review:codex -- "note --no-codex-agent in documentation"', 'codex-review'],
    ['node tools/cross-review.js codex --no-codex-agent && npm run review:codex', 'codex-review'],
    ['node tools/cross-review.js codex 2>&1 --fix | tail -40', 'codex-subagent'],
    ['npm run review:codex > review.log 2>&1 -- --fix', 'codex-subagent'],
    ['node tools/cross-review.js codex > "review output.log" --fix', 'codex-subagent'],
    ['node tools/cross-review.js codex --instructions ">notes.md" --fix', 'codex-subagent'],
    ['node tools/cross-review.js codex &> review.log --fix', 'codex-subagent'],
    ['node tools/cross-review.js codex\nnode tools/cross-review.js codex --help', 'codex-review'],
    ['node tools/cross-review.js codex\nnode tools/cross-review.js codex --no-codex-agent', 'codex-review'],
    ['node tools/cross-review.js codex\nnpm run review:codex -- --fix', 'codex-review'],
  ];
  for (const [command, definition] of commands) {
    const event = makeHookEvent({
      session_id: 'codex-review-hook', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: command,
      tool_input: { command },
    });
    assert.equal(event.codexReviewDefinition, definition, command);
  }
});

test('文字列やヒアドキュメントのクロスレビュー手順と、--no-codex-agent 付きとヘルプの起動は拾わない', () => {
  const commands = [
    `cat <<'EOF'\nnpm run review:codex\nEOF`,
    'echo "npm run review:codex"',
    "git commit -m 'node tools/cross-review.js codex --fix'",
    'npm run review:codex -- --no-codex-agent',
    'node tools/cross-review.js codex --no-codex-agent',
    "node tools/cross-review.js codex '--no-codex-agent'",
    'node tools/cross-review.js codex 2>&1 --no-codex-agent',
    'node tools/cross-review.js codex --help',
    'npm run review:codex -- -h',
    'node tools/cross-review.js codex > "review output.log" --help',
    'node tools/cross-review.js codex > "review output.log" --no-codex-agent',
  ];
  for (const command of commands) {
    const event = makeHookEvent({
      session_id: 'codex-review-hook', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: command,
      tool_input: { command },
    });
    assert.equal(Object.hasOwn(event, 'codexReviewDefinition'), false, command);
  }
});

test('クロスレビュー定義は Bash の許可値だけを受け、既存の起動定義を優先する', () => {
  const sanitize = (toolName, codexReviewDefinition, summary = 'npm run review:codex') => sanitizeEvent({
    session_id: 'codex-review-sanitize', hook_event_name: 'PreToolUse', tool_name: toolName,
    codexReviewDefinition, summary,
  });
  assert.equal(sanitize('Bash', 'codex-review').codexDefinition, 'codex-review');
  assert.equal(sanitize('Bash', 'codex-subagent').codexDefinition, 'codex-subagent');
  assert.equal(sanitize('Bash', 'untrusted-definition').codexDefinition, null);
  assert.equal(sanitize('Read', 'codex-review').codexDefinition, null);
  assert.equal(
    sanitize('Bash', 'codex-review', 'bash ~/.claude/tools/codex-agent.sh custom < prompt.md').codexDefinition,
    'custom',
  );
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

test('回答フックは接続失敗後に server.json を読み直して新しい secret で再送する', async () => {
  const serverInfos = [
    { port: 41001, secret: 'old-secret', pid: 1234, startedAt: '2026-10-05T00:00:00.000Z' },
    { port: 41002, secret: 'new-secret', pid: 5678, startedAt: '2026-10-05T00:01:00.000Z' },
  ];
  const secrets = [];
  let reads = 0;
  const response = await postHookRequest({ action: 'test' }, {
    homeDir: 'unused',
    timeoutMs: 500,
    readServerInfo: async () => serverInfos[reads++],
    fetchImpl: async (_url, options) => {
      secrets.push(options.headers['x-cockpit-secret']);
      if (secrets.length === 1) throw new Error('ECONNREFUSED');
      return { ok: true, status: 200, json: async () => ({ accepted: true }) };
    },
  });

  assert.deepEqual(response, { accepted: true });
  assert.equal(reads, 2);
  assert.deepEqual(secrets, ['old-secret', 'new-secret']);
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

test('背景タスクの出力を読む呼び出しと、背景へ移った Bash から背景タスク ID を取り出す', () => {
  const base = { session_id: 'bgid', hook_event_name: 'PostToolUse', tool_use_id: 't1' };
  const started = makeHookEvent({
    ...base, tool_name: 'Bash', tool_input: { command: 'npm run review:codex' },
    tool_response: { stdout: '', backgroundTaskId: 'baepc74pm' },
  }, 1);
  assert.equal(started.backgroundTaskId, 'baepc74pm');
  assert.equal(started.backgroundOutputTaskId, undefined);

  const win = makeHookEvent({
    ...base, tool_name: 'Read',
    tool_input: { file_path: 'E:\\Temp\\claude\\x\\tasks\\baepc74pm.output' }, tool_response: {},
  }, 1);
  assert.equal(win.backgroundOutputTaskId, 'baepc74pm');
  const posix = makeHookEvent({
    ...base, tool_name: 'Read', tool_input: { file_path: '/tmp/tasks/b2.output' }, tool_response: {},
  }, 1);
  assert.equal(posix.backgroundOutputTaskId, 'b2');

  const one = makeHookEvent({
    ...base, tool_name: 'Bash', tool_input: { command: 'cat /tmp/tasks/a1.output; tail -5 /tmp/tasks/a1.output' }, tool_response: {},
  }, 1);
  assert.equal(one.backgroundOutputTaskId, 'a1');
  const two = makeHookEvent({
    ...base, tool_name: 'Bash', tool_input: { command: 'cat /tmp/tasks/a1.output /tmp/tasks/b2.output' }, tool_response: {},
  }, 1);
  assert.equal(two.backgroundOutputTaskId, undefined);

  const taskOutput = makeHookEvent({
    ...base, tool_name: 'TaskOutput', tool_input: { task_id: 'c3' }, tool_response: {},
  }, 1);
  assert.equal(taskOutput.backgroundOutputTaskId, 'c3');
});

test('UserPromptSubmit は完了通知から Codex の行だけを送り、プロンプト本文を送らない', () => {
  const outputFile = path.resolve('task-a.output');
  const prompt = `<task-notification>\n<task-id>task-a</task-id>\n<output-file>${outputFile}</output-file>\n<status>completed</status>\n<summary>要約も送らない</summary>\n</task-notification>\n入力本文は送らない`;
  const readPaths = [];
  const event = makeHookEvent({
    session_id: 'bg-notify', hook_event_name: 'UserPromptSubmit', prompt,
  }, 1, {
    readTaskOutput(filePath) {
      readPaths.push(filePath);
      return 'ordinary output\ncodex-agent: agent=codex-review model=gpt-6 effort=high codex_home=C:/codex\ncodex-agent: run=codex-review-20261004-100000-1\ncodex-agent: result=ok';
    },
  });
  const sanitized = sanitizeEvent(event);

  assert.deepEqual(readPaths, [outputFile]);
  assert.deepEqual(event.backgroundTaskEnds, [{
    taskId: 'task-a', status: 'completed', codexOutput: {
      auditLine: 'codex-agent: agent=codex-review model=gpt-6 effort=high codex_home=C:/codex',
      resultLine: 'codex-agent: result=ok',
      runLine: 'codex-agent: run=codex-review-20261004-100000-1',
    },
  }]);
  assert.deepEqual(sanitized.backgroundTaskEnds, [{
    taskId: 'task-a', status: 'completed',
    codexAudit: { model: 'gpt-6', effort: 'high', codex_home: 'C:/codex' },
    codexResult: { status: 'ok', exitCode: null },
    codexRunId: 'codex-review-20261004-100000-1',
  }]);
  assert.equal(Object.hasOwn(event, 'prompt'), false);
  assert.equal(Object.hasOwn(sanitized, 'prompt'), false);
  assert.equal(JSON.stringify({ event, sanitized }).includes('要約も送らない'), false);
  assert.equal(JSON.stringify({ event, sanitized }).includes('入力本文は送らない'), false);
});

test('完了通知の出力ファイル名が task ID と合わないか相対パスなら読まない', () => {
  let reads = 0;
  const prompt = [
    ['task-a', path.resolve('another.output')],
    ['task-b', 'tasks/task-b.output'],
  ].map(([taskId, outputFile]) => `<task-notification><task-id>${taskId}</task-id><output-file>${outputFile}</output-file><status>completed</status></task-notification>`).join('\n');

  const event = makeHookEvent({ session_id: 'bg-notify', hook_event_name: 'UserPromptSubmit', prompt }, 1, {
    readTaskOutput() { reads += 1; return 'codex-agent: result=ok'; },
  });

  assert.equal(reads, 0);
  assert.deepEqual(event.backgroundTaskEnds, [
    { taskId: 'task-a', status: 'completed' },
    { taskId: 'task-b', status: 'completed' },
  ]);
});

test('開発者の入力に引用した完了通知と、終わりを示さない状態の通知は送らない', () => {
  const notification = (taskId, status) => `<task-notification><task-id>${taskId}</task-id><status>${status}</status></task-notification>`;
  const quoted = makeHookEvent({
    session_id: 'bg-notify', hook_event_name: 'UserPromptSubmit', prompt: `この通知の形を説明して\n${notification('task-a', 'completed')}`,
  }, 1, { readTaskOutput() { throw new Error('読まない'); } });
  const running = makeHookEvent({
    session_id: 'bg-notify', hook_event_name: 'UserPromptSubmit',
    prompt: `${notification('task-a', 'running')}\n${notification('task-b', 'killed')}`,
  }, 1, { readTaskOutput() { return ''; } });

  assert.equal(Object.hasOwn(quoted, 'backgroundTaskEnds'), false);
  assert.deepEqual(running.backgroundTaskEnds, [{ taskId: 'task-b', status: 'killed' }]);
});

test('形に合わない背景タスク ID はフックもサーバーの正規化も捨てる', () => {
  const bad = makeHookEvent({
    session_id: 'bgid', hook_event_name: 'PostToolUse', tool_use_id: 't1', tool_name: 'Bash',
    tool_input: { command: 'ls' }, tool_response: { backgroundTaskId: 'bad id!' },
  }, 1);
  assert.equal(bad.backgroundTaskId, undefined);
  const badRead = makeHookEvent({
    session_id: 'bgid', hook_event_name: 'PostToolUse', tool_use_id: 't1', tool_name: 'Read',
    tool_input: { file_path: '/tmp/bad id.output' }, tool_response: {},
  }, 1);
  assert.equal(badRead.backgroundOutputTaskId, undefined);

  const kept = sanitizeEvent({
    session_id: 'bgid', hook_event_name: 'PostToolUse', hookAt: 1, tool_name: 'Bash', tool_use_id: 't1',
    backgroundTaskId: 'baepc74pm', backgroundOutputTaskId: 'x_y-1',
  });
  assert.equal(kept.backgroundTaskId, 'baepc74pm');
  assert.equal(kept.backgroundOutputTaskId, 'x_y-1');
  const dropped = sanitizeEvent({
    session_id: 'bgid', hook_event_name: 'PostToolUse', hookAt: 1, tool_name: 'Bash', tool_use_id: 't1',
    backgroundTaskId: '../x', backgroundOutputTaskId: 42,
  });
  assert.equal(dropped.backgroundTaskId, undefined);
  assert.equal(dropped.backgroundOutputTaskId, undefined);
});


test('完了通知が 9 件あっても全 ID を送り、出力ファイルは 8 件まで読む', () => {
  const readPaths = [];
  const ids = Array.from({ length: 9 }, (_, index) => `task-${index}`);
  const prompt = ids.map(id => `<task-notification><task-id>${id}</task-id><output-file>${path.resolve(id + '.output')}</output-file><status>completed</status></task-notification>`).join('\n');
  const event = makeHookEvent({ session_id: 'many-notifications', hook_event_name: 'UserPromptSubmit', prompt }, 1, {
    readTaskOutput(file) { readPaths.push(file); return 'codex-agent: result=ok'; },
  });
  assert.deepEqual(event.backgroundTaskEnds.map(end => end.taskId), ids);
  assert.deepEqual(sanitizeEvent(event).backgroundTaskEnds.map(end => end.taskId), ids);
  assert.deepEqual(readPaths, ids.slice(0, 8).map(id => path.resolve(id + '.output')));
  assert.equal(event.backgroundTaskEnds[8].codexOutput, undefined);
});

test('フックは BackgroundTaskEnd と Claude の内部 Interrupt を送らない', () => {
  for (const hook_event_name of ['Interrupt', 'BackgroundTaskEnd']) {
    assert.equal(makeHookEvent({ session_id: 'internal', hook_event_name }), null);
    if (hook_event_name === 'BackgroundTaskEnd') assert.equal(makeHookEvent({ session_id: 'internal', hook_event_name }, 1, { provider: 'codex' }), null);
  }
});
