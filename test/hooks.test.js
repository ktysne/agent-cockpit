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

test('レビュー起動は heredoc 後と前置きとシェル内部と npm や node のオプション付きと別の場所の入口でも検出する', () => {
  for (const [tool_name, command, expected] of [
    ['Bash', "cat > req.md <<'EOF'\nDo work.\nEOF\nnpm run review:codex", 'codex-review'],
    ['Bash', 'CROSS_REVIEW_NO_FETCH=1 npm run review:codex', 'codex-review'],
    ['Bash', 'bash -c "echo \\#; npm run review:codex"', 'codex-review'],
    ['Bash', "bash -lc 'npm run review:codex'", 'codex-review'],
    ['Bash', "echo \"$(cat <<'EOF'\nit's (done\nEOF\n)\" && npm run review:codex", 'codex-review'],
    ['Bash', 'env -u DEBUG command npm run review:codex:fix', 'codex-subagent'],
    ['Bash', '/usr/bin/node ./tools/cross-review.js codex --fix', 'codex-subagent'],
    ['Bash', 'cd "D:/x" && npm run -s review:codex 2>&1 | tail -80', 'codex-review'],
    ['Bash', 'npm run --silent review:codex', 'codex-review'],
    ['Bash', 'npm -s run review:codex', 'codex-review'],
    ['Bash', 'npm --prefix ./repo run-script review:codex:fix', 'codex-subagent'],
    ['Bash', 'npm -w app --loglevel=warn run -s review:codex -- --fix', 'codex-subagent'],
    ['Bash', 'node --use-system-ca tools/cross-review.js codex', 'codex-review'],
    ['Bash', 'node -r ./preload.js --no-warnings tools/cross-review.js codex --fix', 'codex-subagent'],
    ['Bash', 'node D:/Desktop/Develop/agent-cockpit/tools/cross-review.js codex', 'codex-review'],
    ['Bash', 'cd sub && node ../tools/cross-review.js codex', 'codex-review'],
    ['PowerShell', 'npm.cmd run review:codex', 'codex-review'],
    ['PowerShell', 'Write-Output a#b; npm.cmd run review:codex', 'codex-review'],
    ['PowerShell', '& "C:\\tools\\npm.exe" run review:codex -- --fix', 'codex-subagent'],
    ['PowerShell', 'node.exe .\\tools\\cross-review.js codex', 'codex-review'],
    ['PowerShell', "bash -lc 'CROSS_REVIEW_NO_FETCH=1 npm run review:codex'", 'codex-review'],
    ['PowerShell', "$request = @'\nDo work.\n'@\nnpm.cmd run review:codex", 'codex-review'],
  ]) {
    const event = makeHookEvent({ hook_event_name: 'PreToolUse', tool_name, tool_input: { command } });
    assert.equal(event.codexReviewDefinition, expected, command);
  }
});

test('レビューの説明文とコメントとヘルプだけの起動は検出しない', () => {
  for (const [tool_name, command] of [
    ['Bash', "cat <<'EOF'\nnpm run review:codex\nEOF"],
    ['Bash', 'echo ok # ; npm run review:codex'],
    ['Bash', 'echo "npm run review:codex"'],
    ['Bash', "bash -lc 'npm run review:codex -- --help'"],
    ['Bash', 'env DEBUG=1 npm run review:codex -- -h'],
    ['Bash', 'node run review:codex'],
    ['Bash', 'npm tools/cross-review.js codex'],
    ['Bash', 'npm -s test review:codex'],
    ['Bash', 'npm run -s review:codex -- --help'],
    ['Bash', 'npm --prefix run review:codex'],
    ['Bash', 'npm --help run review:codex'],
    ['Bash', 'npm run --help review:codex'],
    ['Bash', 'npm -v run -s review:codex'],
    ['Bash', 'node -e "require(\'./tools/cross-review.js\')" tools/cross-review.js codex'],
    ['Bash', 'node --check tools/cross-review.js codex'],
    ['Bash', 'node -r tools/cross-review.js codex'],
    ['Bash', 'node tools/my-cross-review.js codex'],
    ['PowerShell', "$request = @'\nnpm.cmd run review:codex\n'@"],
    ['PowerShell', 'Write-Output ok # ; npm.cmd run review:codex'],
    ['PowerShell', '<# ; npm.cmd run review:codex\n#>'],
    ['PowerShell', 'Write-Output "npm.cmd run review:codex"'],
    ['PowerShell', 'npm.cmd run review:codex -- --help'],
    ['PowerShell', "bash -c 'node tools/cross-review.js codex -h'"],
  ]) {
    const event = makeHookEvent({ hook_event_name: 'PreToolUse', tool_name, tool_input: { command } });
    assert.equal(event.codexReviewDefinition, undefined, command);
  }
});

test('heredoc 後の待機呼び出しは開始イベントに実行 ID を残す', () => {
  const runId = 'impl-light-20261020-123456-1';
  const event = makeHookEvent({ hook_event_name: 'PreToolUse', tool_name: 'Bash',
    tool_input: { command: `cat <<'EOF'\nDo work.\nEOF\nbash ~/.claude/tools/codex-agent.sh --wait ${runId}` } });
  assert.equal(event.codexWaitRunId, runId);
});

test('メインのバックグラウンドシェルは説明とコマンドを上限付きで送る', () => {
  for (const tool_name of ['Bash', 'PowerShell']) {
    const event = makeHookEvent({ session_id: 'background', hook_event_name: 'PostToolUse', tool_name,
      tool_input: { command: '  npm test\n  ' + 'x'.repeat(100), description: '説'.repeat(201) },
      tool_response: { backgroundTaskId: 'task-a' } });
    assert.equal(event.summary, 'npm test ' + 'x'.repeat(70) + '…');
    assert.equal(event.description, '説'.repeat(200));
    const sanitized = sanitizeEvent(event);
    assert.equal(sanitized.summary, event.summary);
    assert.equal(sanitized.description, event.description);
  }
});

test('起動定義は Bash と PowerShell の開始イベントで定義名の形式と長さを満たすものだけ受ける', () => {
  for (const [tool_name, hook_event_name, definition, expected] of [
    ['Bash', 'PreToolUse', '_impl.hard-1', '_impl.hard-1'],
    ['PowerShell', 'PreToolUse', '_impl.hard-1', '_impl.hard-1'],
    ['Read', 'PreToolUse', 'impl-hard', null],
    ['Bash', 'PostToolUse', 'impl-hard', undefined],
    ['Bash', 'PreToolUse', '--wait', null],
    ['Bash', 'PreToolUse', 'a/b', null],
    ['Bash', 'PreToolUse', 'x'.repeat(201), null],
  ]) {
    const event = sanitizeEvent({ session_id: 'launch-validation', tool_name, hook_event_name,
      summary: 'bash codex-agent.sh impl-hard', codexLaunchDefinition: definition });
    assert.equal(event.codexDefinition, expected);
  }
});

test('Codex ラッパーの -C と --effort の値を除いて定義名を検出する', () => {
  const commands = [
    ['bash ~/.claude/tools/codex-agent.sh -C "D:/work" impl-light < "req.md"', 'impl-light'],
    ['bash ~/.claude/tools/codex-agent.sh --effort high impl-hard', 'impl-hard'],
    ['bash ~/.claude/tools/codex-agent.sh --effort=high impl-standard', 'impl-standard'],
    ['X="$(bash ~/.claude/tools/codex-agent.sh impl-hard)"', 'impl-hard'],
    ["X=\"$(cat <<'EOF'\nit's (done)\nEOF\nbash ~/.claude/tools/codex-agent.sh impl-hard\n)\"", 'impl-hard'],
    ['bash ~/.claude/tools/codex-agent.sh -C "D:/work" --effort max impl-hard', 'impl-hard'],
    ['bash ~/.claude/tools/codex-agent.sh -C D:/work\\ tree\\ dir impl-hard', 'impl-hard'],
    ['bash ~/.claude/tools/codex-agent.sh -C D:/work\\\\ impl-light', 'impl-light'],
    ["bash ~/.claude/tools/codex-agent.sh -C 'D:\\work\\' impl-hard", 'impl-hard'],
    ['bash ~/.claude/tools/codex-agent.sh -C D:\\work\\ impl-hard', 'impl-hard', 'PowerShell'],
    ["bash -lc 'bash ~/.claude/tools/codex-agent.sh -C /mnt/d/work\\ tree impl-hard'", 'impl-hard', 'PowerShell'],
  ];
  for (const [command, definition, toolName = 'Bash'] of commands) {
    const event = makeHookEvent({ session_id: 'codex-launch-options', hook_event_name: 'PreToolUse',
      tool_name: toolName, tool_use_id: command, tool_input: { command } });
    assert.equal(event.codexLaunchDefinition, definition, command);
    assert.equal(sanitizeEvent(event).codexDefinition, definition, command);
  }
});

test('二重引用符の bash -c 内でエスケープした引用符を使っても Codex の定義名を検出する', () => {
  const command = String.raw`bash -c "bash ~/.claude/tools/codex-agent.sh -C \"/mnt/work tree\" impl-hard < p.md"`;
  const event = makeHookEvent({ session_id: 'codex-launch-double-quote', hook_event_name: 'PreToolUse',
    tool_name: 'Bash', tool_use_id: command, tool_input: { command } });
  assert.equal(event.codexLaunchDefinition, 'impl-hard', command);
});

test('Codex の -C にあるエスケープ空白は引用符の位置ごとに従来どおり定義名を検出する', () => {
  for (const command of [
    String.raw`bash ~/.claude/tools/codex-agent.sh -C /mnt/work\ tree impl-hard`,
    String.raw`bash -c "bash ~/.claude/tools/codex-agent.sh -C /mnt/work\ tree impl-hard"`,
    String.raw`bash -c 'bash ~/.claude/tools/codex-agent.sh -C /mnt/work\ tree impl-hard'`,
  ]) {
    const event = makeHookEvent({ session_id: 'codex-launch-escaped-space', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_use_id: command, tool_input: { command } });
    assert.equal(event.codexLaunchDefinition, 'impl-hard', command);
  }
});

test('Codex ラッパーの --new-prompt、--wait、--header-of は起動定義として検出しない', () => {
  for (const command of [
    'bash ~/.claude/tools/codex-agent.sh -C "D:/work" --new-prompt',
    'bash ~/.claude/tools/codex-agent.sh --effort=high --wait run-id',
    'bash ~/.claude/tools/codex-agent.sh -C "D:/work" --header-of value',
  ]) {
    const event = makeHookEvent({ session_id: 'codex-launch-options', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_use_id: command, tool_input: { command } });
    assert.equal(Object.hasOwn(event, 'codexLaunchDefinition'), false, command);
  }
});

test('PowerShell の中の bash -c は Bash の規則でエスケープした空白を読み、--wait の実行 ID を拾う', () => {
  const command = "bash -lc 'bash ~/.claude/tools/codex-agent.sh -C /mnt/d/work\\ tree --wait impl-hard-20261019-110000-7'";
  const event = makeHookEvent({ session_id: 'codex-launch-options', hook_event_name: 'PreToolUse',
    tool_name: 'PowerShell', tool_use_id: command, tool_input: { command } });
  assert.equal(Object.hasOwn(event, 'codexLaunchDefinition'), false);
  assert.equal(event.codexWaitRunId, 'impl-hard-20261019-110000-7');
});

test('PowerShell の開始イベントから Codex 起動、待機、レビューの定義を抽出する', () => {
  const runId = 'impl-standard-20261019-110000-7';
  const cases = [
    ['& "$HOME\\.claude\\tools\\codex-agent.sh" impl-standard', 'codexLaunchDefinition', 'impl-standard', 'codexDefinition', 'impl-standard'],
    ['& "$HOME\\.claude\\tools\\codex-agent.sh" --wait ' + runId, 'codexWaitRunId', runId, 'codexWaitDefinition', 'impl-standard'],
    ['npm run review:codex', 'codexReviewDefinition', 'codex-review', 'codexDefinition', 'codex-review'],
    ['Set-Location "D:\\repo\\"; bash "$HOME/.claude/tools/codex-agent.sh" impl-hard',
      'codexLaunchDefinition', 'impl-hard', 'codexDefinition', 'impl-hard'],
    ['bash `\n  "$HOME/.claude/tools/codex-agent.sh" impl-light', 'codexLaunchDefinition', 'impl-light', 'codexDefinition', 'impl-light'],
  ];
  for (const [command, field, expected, sanitizedField, sanitizedExpected] of cases) {
    const event = makeHookEvent({ session_id: 'powershell-codex', hook_event_name: 'PreToolUse',
      tool_name: 'PowerShell', tool_use_id: field, tool_input: { command } });
    assert.equal(event[field], expected, command);
    assert.equal(sanitizeEvent(event)[sanitizedField], sanitizedExpected, command);
  }
});

test('標準出力に引用された結果があっても起動とレビューと待機の結果は全文ファイルを優先する', () => {
  for (const command of ['bash "$HOME/tools/codex-agent.sh" impl-hard', 'npm run review:codex',
    'bash codex-agent.sh --wait impl-hard-20261019-110000-7']) {
    const outputPath = path.resolve('output.txt');
    const event = makeHookEvent({ session_id: 'persisted-result', hook_event_name: 'PostToolUse',
      tool_name: 'Bash', tool_input: { command },
      tool_response: { stdout: 'codex-agent: result=rate-limited', persistedOutputPath: outputPath } }, 1,
    { readTaskOutput(file) {
      assert.equal(file, outputPath);
      return 'codex-agent: result=rate-limited\ncodex-agent: result=ok';
    } });
    assert.equal(sanitizeEvent(event).codexResult.status, 'ok', command);
  }
});

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

async function capturePostedSubagentStart(options, sessionId = 'route-event') {
  const startedAt = '2026-10-03T00:00:00.000Z';
  await fs.writeFile(path.join(options.homeDir, 'server.json'), JSON.stringify({
    pid: 12345, port: 47821, secret: 'hook-secret', uiSecret: 'ui-secret', startedAt,
  }));
  let postedEvent;
  const result = await runHook({
    session_id: sessionId, hook_event_name: 'SubagentStart', agent_id: 'agent-1', agent_type: 'impl-hard',
  }, {
    ...options,
    deadline: Date.now() + 1000,
    fetchImpl: async (url, requestOptions = {}) => {
      if (url.endsWith('/health')) return { ok: true, json: async () => ({ app: 'agent-cockpit', pid: 12345, startedAt }) };
      postedEvent = JSON.parse(requestOptions.body);
      return { ok: true, status: 202 };
    },
  });
  return { result, postedEvent };
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

test('bridge があり記録が無いときは現在の経路を SubagentStart イベントに送る', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const userHome = path.join(homeDir, 'user');
  const bridgePath = path.join(claudeHome, 'tools', 'codex-agent.sh');
  await fs.mkdir(path.dirname(bridgePath), { recursive: true });
  await fs.writeFile(bridgePath, '');
  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify({ agents: 'claude', review: 'codex' }));
  const { result, postedEvent } = await capturePostedSubagentStart({ homeDir, claudeHome, userHome });

  assert.equal(result.exitCode, 0);
  assert.equal(postedEvent.route, 'claude');
});

test('bridge が無いと SubagentStart イベントに route を含めない', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const userHome = path.join(homeDir, 'user');
  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify({ agents: 'claude', review: 'codex' }));

  const { postedEvent } = await capturePostedSubagentStart({ homeDir, claudeHome, userHome });

  assert.equal(Object.hasOwn(postedEvent, 'route'), false);
});

test('SubagentStart の再開では記録済みの経路を route として送る', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const userHome = path.join(homeDir, 'user');
  const bridgePath = path.join(claudeHome, 'tools', 'codex-agent.sh');
  const sessionId = 'route-restart';
  const recordPath = path.join(homeDir, 'route-agents',
    `${Buffer.from(sessionId).toString('hex')}.${Buffer.from('agent-1').toString('hex')}.json`);
  await fs.mkdir(path.dirname(bridgePath), { recursive: true });
  await fs.writeFile(bridgePath, '');
  await fs.mkdir(path.dirname(recordPath), { recursive: true });
  await fs.writeFile(recordPath, JSON.stringify({ route: 'codex' }));
  await fs.writeFile(path.join(homeDir, 'routing.json'), JSON.stringify({ agents: 'claude', review: 'codex' }));

  const { postedEvent } = await capturePostedSubagentStart({ homeDir, claudeHome, userHome }, sessionId);

  assert.equal(postedEvent.route, 'codex');
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

test('PowerShell の gh pr create は URL を送り、cd 先を commandCwd にしない', () => {
  const commandCwd = path.resolve(os.tmpdir(), 'powershell-pr-repo', 'worktree');
  const command = `cd "${commandCwd.replaceAll('\\', '/')}" && gh pr create --fill`;
  const pre = makeHookEvent({
    session_id: 'powershell-pr', hook_event_name: 'PreToolUse', cwd: process.cwd(),
    tool_name: 'PowerShell', tool_use_id: 'powershell-pr', tool_input: { command },
  });
  assert.equal(pre.ghPrCreateCommand, true);
  assert.equal(Object.hasOwn(pre, 'commandCwd'), false);

  const post = makeHookEvent({
    session_id: 'powershell-pr', hook_event_name: 'PostToolUse', cwd: process.cwd(),
    tool_name: 'PowerShell', tool_use_id: 'powershell-pr', tool_input: { command },
    tool_response: { stdout: 'https://github.com/example/project/pull/43' },
  });
  assert.equal(post.ghPrCreateCommand, true);
  assert.deepEqual(post.pullRequest, {
    owner: 'example', repo: 'project', number: 43, url: 'https://github.com/example/project/pull/43',
  });
  assert.equal(Object.hasOwn(post, 'commandCwd'), false);
  assert.equal(Object.hasOwn(sanitizeEvent(post), 'commandCwd'), false);
});

test('複数の gh pr create は URL を出た順に送り、各 Bash cd を対応させる', () => {
  const sessionCwd = path.resolve(os.tmpdir(), 'session-product', '.claude', 'worktrees', 'session');
  const firstCwd = path.resolve(os.tmpdir(), 'first-product', '.claude', 'worktrees', 'feature');
  const secondCwd = path.resolve(os.tmpdir(), 'second-product', '.claude', 'worktrees', 'feature');
  const quoted = value => `"${value.replaceAll('\\', '/')}"`;
  const command = `cd ${quoted(firstCwd)} && gh pr create && cd ${quoted(secondCwd)} && gh pr create`;
  const response = { stdout: [
    'https://github.com/example/first/pull/1',
    'https://github.com/EXAMPLE/FIRST/pull/1',
    'https://github.com/example/second/pull/2',
    'https://github.com/example/first/pull/new/main',
  ].join('\n') };

  for (const provider of ['claude', 'codex']) {
    const event = makeHookEvent({ session_id: 'multiple-prs', hook_event_name: 'PostToolUse', cwd: sessionCwd,
      tool_name: 'Bash', tool_use_id: 'create-multiple', tool_input: { command }, tool_response: response }, 1, { provider });
    assert.equal(event.pullRequest.number, 1);
    assert.equal(event.commandCwd, path.resolve(firstCwd));
    assert.deepEqual(event.additionalPullRequests, [{
      owner: 'example', repo: 'second', number: 2,
      url: 'https://github.com/example/second/pull/2', commandCwd: path.resolve(secondCwd),
    }]);
    assert.deepEqual(sanitizeEvent(event).additionalPullRequests, event.additionalPullRequests);
  }

  const oneCreate = makeHookEvent({ session_id: 'one-pr', hook_event_name: 'PostToolUse', cwd: sessionCwd,
    tool_name: 'Bash', tool_input: { command: 'gh pr create' },
    tool_response: 'https://github.com/example/first/pull/1 https://github.com/example/second/pull/2' });
  assert.equal(oneCreate.pullRequest.number, 1);
  assert.equal(Object.hasOwn(oneCreate, 'additionalPullRequests'), false);

  const powershell = makeHookEvent({ session_id: 'powershell-multiple-prs', hook_event_name: 'PostToolUse', cwd: sessionCwd,
    tool_name: 'PowerShell', tool_input: { command: 'gh pr create && gh pr create' },
    tool_response: 'https://github.com/example/first/pull/1 https://github.com/example/second/pull/2' });
  assert.equal(powershell.additionalPullRequests.length, 1);
  assert.equal(Object.hasOwn(powershell.additionalPullRequests[0], 'commandCwd'), false);
  assert.equal(Object.hasOwn(sanitizeEvent(powershell).additionalPullRequests[0], 'commandCwd'), false);

  const continued = makeHookEvent({ session_id: 'continued-prs', hook_event_name: 'PostToolUse', cwd: sessionCwd,
    tool_name: 'Bash', tool_input: { command: `gh pr create && cd ${quoted(secondCwd)} &&\n  gh pr create` },
    tool_response: 'https://github.com/example/first/pull/1\nhttps://github.com/example/second/pull/2' });
  assert.equal(continued.additionalPullRequests[0].commandCwd, path.resolve(secondCwd));
});

test('複数の gh pr create でも、URL の数が作成回数と違うか gh pr create 以外の gh があれば 2 件目以降を送らない', () => {
  const sessionCwd = path.resolve(os.tmpdir(), 'session-product', '.claude', 'worktrees', 'session');
  const secondCwd = path.resolve(os.tmpdir(), 'second-product', '.claude', 'worktrees', 'feature');
  const create = (command, stdout) => makeHookEvent({ session_id: 'mismatched-prs', hook_event_name: 'PostToolUse',
    cwd: sessionCwd, tool_name: 'Bash', tool_input: { command }, tool_response: { stdout } });
  const twoCreates = `gh pr create && cd "${secondCwd.replaceAll('\\', '/')}" && gh pr create`;

  const extra = create(twoCreates, ['1', '99', '2'].map(number => `https://github.com/example/project/pull/${number}`).join('\n'));
  assert.equal(extra.pullRequest.number, 1);
  assert.equal(Object.hasOwn(extra, 'additionalPullRequests'), false);

  const missing = create(twoCreates, 'https://github.com/example/project/pull/2');
  assert.equal(Object.hasOwn(missing, 'additionalPullRequests'), false);

  const viewed = create(`gh pr create && gh pr view 99 --json url --jq .url && cd "${secondCwd.replaceAll('\\', '/')}" && gh pr create`,
    'https://github.com/example/project/pull/1\nhttps://github.com/example/project/pull/2');
  assert.equal(Object.hasOwn(viewed, 'additionalPullRequests'), false);
});

test('additionalPullRequests は URL と番号を検査し、重複、上限超過、PowerShell の cwd を除く', () => {
  const main = { owner: 'example', repo: 'project', number: 1, url: 'https://github.com/example/project/pull/1' };
  const makePullRequest = number => ({ owner: 'example', repo: 'project', number,
    url: `https://github.com/example/project/pull/${number}` });
  const base = { session_id: 'sanitize-prs', hook_event_name: 'PostToolUse', tool_name: 'Bash', pullRequest: main };
  const additionalPullRequests = [
    makePullRequest(1),
    { ...makePullRequest(2), number: 3 },
    { ...makePullRequest(4), owner: 'other' },
    makePullRequest(2),
    makePullRequest(2),
  ];
  const sanitized = sanitizeEvent({ ...base, additionalPullRequests });
  assert.deepEqual(sanitized.additionalPullRequests.map(item => item.number), [2]);

  const overLimit = sanitizeEvent({ ...base, additionalPullRequests:
    Array.from({ length: 11 }, (_, index) => makePullRequest(index + 10)) });
  assert.deepEqual(overLimit.additionalPullRequests.map(item => item.number), [10, 11, 12, 13, 14, 15, 16, 17, 18]);

  const powershell = sanitizeEvent({ ...base, tool_name: 'PowerShell', additionalPullRequests: [
    { ...makePullRequest(2), commandCwd: path.resolve(os.tmpdir(), 'other-product') },
  ] });
  assert.deepEqual(powershell.additionalPullRequests, [makePullRequest(2)]);

  const bash = sanitizeEvent({ ...base, additionalPullRequests: [
    { ...makePullRequest(2), commandCwd: 'relative/path' },
    { ...makePullRequest(3), commandCwd: `${path.parse(path.resolve(os.tmpdir())).root}${'a'.repeat(4097)}` },
    { ...makePullRequest(4), commandCwd: path.resolve(os.tmpdir(), 'valid-product') },
  ] });
  assert.deepEqual(bash.additionalPullRequests, [
    makePullRequest(2), makePullRequest(3),
    { ...makePullRequest(4), commandCwd: path.resolve(os.tmpdir(), 'valid-product') },
  ]);
});

test('PowerShell の push は未知スコープとして取り直し、cd 先を送らない', () => {
  const commandCwd = path.resolve(os.tmpdir(), 'powershell-push-repo', 'worktree');
  const command = `cd "${commandCwd.replaceAll('\\', '/')}" && git push`;
  for (const hook_event_name of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
    const event = makeHookEvent({
      session_id: 'powershell-push', hook_event_name, cwd: process.cwd(),
      tool_name: 'PowerShell', tool_use_id: 'powershell-push', tool_input: { command },
    });
    assert.equal(hook_event_name === 'PreToolUse' ? event.refreshPullRequestsCommand : event.refreshPullRequests, true);
    assert.equal(event.refreshScopeUnknown, true);
    assert.equal(Object.hasOwn(event, 'commandCwd'), false);
    assert.equal(sanitizeEvent(event).refreshScopeUnknown, true);
    assert.equal(Object.hasOwn(sanitizeEvent(event), 'commandCwd'), false);
    assert.equal(Object.hasOwn(sanitizeEvent({ ...event, refreshRepository: 'example/project' }), 'refreshRepository'), false);
  }
});

test('PR 取り直しコマンドの cwd と --repo を Claude と Codex のイベントに載せる', () => {
  const hookCwd = path.resolve(os.tmpdir(), 'session-repo', 'worktree');
  const commandCwd = path.resolve(os.tmpdir(), 'target-repo', 'worktree');
  const pushCommand = `cd "${commandCwd.replaceAll('\\', '/')}" && git push`;
  const makeBashEvent = (provider, hook_event_name, command) => makeHookEvent({
    session_id: 'refresh-scope', hook_event_name, cwd: hookCwd,
    tool_name: 'Bash', tool_use_id: 'refresh-command', tool_input: { command },
  }, Date.now(), { provider });

  for (const provider of ['claude', 'codex']) {
    for (const hook_event_name of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure']) {
      const push = makeBashEvent(provider, hook_event_name, pushCommand);
      assert.equal(push.commandCwd, commandCwd, `${provider} ${hook_event_name} commandCwd`);
      assert.equal(sanitizeEvent(push).commandCwd, commandCwd, `${provider} ${hook_event_name} sanitized commandCwd`);
      assert.equal(hook_event_name === 'PreToolUse' ? push.refreshPullRequestsCommand : push.refreshPullRequests, true);

      const view = makeBashEvent(provider, hook_event_name, 'gh pr view 1 --repo o/r');
      assert.equal(view.refreshRepository, 'o/r', `${provider} ${hook_event_name} refreshRepository`);
      assert.equal(sanitizeEvent(view).refreshRepository, 'o/r', `${provider} ${hook_event_name} sanitized refreshRepository`);
      assert.equal(Object.hasOwn(sanitizeEvent({ ...view, refreshRepository: 'o/r/extra' }), 'refreshRepository'), false);

      const elsewhere = makeBashEvent(provider, hook_event_name, 'git -C ../other push');
      assert.equal(sanitizeEvent(elsewhere).refreshScopeUnknown, true, `${provider} ${hook_event_name} refreshScopeUnknown`);
    }
  }
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

test('前置きとシェルの文字列内の --wait を起動と同じ規則で検出する', () => {
  const runId = 'impl-hard-20261019-031058-1234';
  for (const command of [
    `timeout 600 bash ~/.claude/tools/codex-agent.sh --wait ${runId}`,
    `bash ~/.claude/tools/codex-agent.sh -C "D:/work" --wait ${runId}`,
    `env A=1 bash ~/.claude/tools/codex-agent.sh --wait ${runId}`,
    `A=1 bash ~/.claude/tools/codex-agent.sh --wait ${runId}`,
    `bash -lc 'bash ~/.claude/tools/codex-agent.sh --wait ${runId}'`,
  ]) {
    const event = makeHookEvent({ session_id: 'wait-prefix', hook_event_name: 'PreToolUse',
      tool_name: 'Bash', tool_use_id: 'wait', tool_input: { command } }, 1, { environment: {} });
    assert.equal(event.codexWaitRunId, runId, command);
  }
  assert.equal(extractCodexWaitRunId(`bash -lc 'cat <<EOF\nbash codex-agent.sh --wait ${runId}\nEOF'`), '');
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
    ['bash -c "echo `"review start`"; npm run review:codex"', 'codex-review', 'PowerShell'],
  ];
  for (const [command, definition, tool_name = 'Bash'] of commands) {
    const event = makeHookEvent({
      session_id: 'codex-review-hook', hook_event_name: 'PreToolUse', tool_name, tool_use_id: command,
      tool_input: { command },
    });
    assert.equal(event.codexReviewDefinition, definition, command);
  }
});

test('文字列やヒアドキュメントのクロスレビュー手順とヘルプ起動は拾わない', () => {
  const commands = [
    `cat <<'EOF'\nnpm run review:codex\nEOF`,
    'echo "npm run review:codex"',
    "git commit -m 'node tools/cross-review.js codex --fix'",
    'node tools/cross-review.js codex --help',
    'npm run review:codex -- -h',
    'node tools/cross-review.js codex > "review output.log" --help',
  ];
  for (const command of commands) {
    const event = makeHookEvent({
      session_id: 'codex-review-hook', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: command,
      tool_input: { command },
    });
    assert.equal(Object.hasOwn(event, 'codexReviewDefinition'), false, command);
  }
});

test('--no-codex-agent 付きのクロスレビューも定義名を選ぶ', () => {
  const commands = [
    ['npm run review:codex -- --no-codex-agent', 'codex-review'],
    ['node tools/cross-review.js codex --no-codex-agent', 'codex-review'],
    ["node tools/cross-review.js codex '--no-codex-agent'", 'codex-review'],
    ['node tools/cross-review.js codex 2>&1 --no-codex-agent', 'codex-review'],
    ['npm run review:codex:fix -- --no-codex-agent', 'codex-subagent'],
    ['node tools/cross-review.js codex --no-codex-agent --fix', 'codex-subagent'],
  ];
  for (const [command, definition] of commands) {
    const event = makeHookEvent({
      session_id: 'codex-review-hook', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: command,
      tool_input: { command },
    });
    assert.equal(event.codexReviewDefinition, definition, command);
  }
});

test('クロスレビュー定義は Bash と PowerShell の許可値だけを受け、既存の起動定義を優先する', () => {
  const sanitize = (toolName, codexReviewDefinition, summary = 'npm run review:codex') => sanitizeEvent({
    session_id: 'codex-review-sanitize', hook_event_name: 'PreToolUse', tool_name: toolName,
    codexReviewDefinition, summary, codexLaunchDefinition: summary.includes(' custom ') ? 'custom' : undefined,
  });
  assert.equal(sanitize('Bash', 'codex-review').codexDefinition, 'codex-review');
  assert.equal(sanitize('Bash', 'codex-review').codexReviewLaunch, true);
  assert.equal(sanitize('PowerShell', 'codex-review').codexDefinition, 'codex-review');
  assert.equal(sanitize('PowerShell', 'codex-review').codexReviewLaunch, true);
  assert.equal(sanitize('Bash', 'codex-subagent').codexDefinition, 'codex-subagent');
  assert.equal(sanitize('Bash', 'untrusted-definition').codexDefinition, null);
  assert.equal(sanitize('Read', 'codex-review').codexDefinition, null);
  assert.equal(
    sanitize('Bash', 'codex-review', 'bash ~/.claude/tools/codex-agent.sh custom < prompt.md').codexDefinition,
    'custom',
  );
  assert.equal(sanitize('Bash', 'codex-review', 'bash ~/.claude/tools/codex-agent.sh custom < prompt.md').codexReviewLaunch, undefined);
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

test('バックグラウンドタスクの出力を読む呼び出しと、バックグラウンドへ移ったシェルツールからバックグラウンドタスク ID を取り出す', () => {
  const base = { session_id: 'bgid', hook_event_name: 'PostToolUse', tool_use_id: 't1' };
  for (const tool_name of ['Bash', 'PowerShell']) {
    for (const hook_event_name of ['PostToolUse', 'PostToolUseFailure']) {
      const started = makeHookEvent({
        ...base, hook_event_name, tool_name, tool_input: { command: 'npm run review:codex' },
        tool_response: { stdout: '', backgroundTaskId: 'baepc74pm' },
      }, 1);
      assert.equal(started.backgroundTaskId, 'baepc74pm');
      assert.equal(sanitizeEvent(started).backgroundTaskId, 'baepc74pm');
      assert.equal(started.backgroundOutputTaskId, undefined);
    }
  }

  const win = makeHookEvent({
    ...base, tool_name: 'Read',
    tool_input: { file_path: 'E:\\Temp\\claude\\x\\tasks\\baepc74pm.output' }, tool_response: {},
  }, 1);
  assert.equal(win.backgroundOutputTaskId, 'baepc74pm');
  const posix = makeHookEvent({
    ...base, tool_name: 'Read', tool_input: { file_path: '/tmp/tasks/b2.output' }, tool_response: {},
  }, 1);
  assert.equal(posix.backgroundOutputTaskId, 'b2');
  const powerShell = makeHookEvent({
    ...base, tool_name: 'PowerShell',
    tool_input: { command: 'Get-Content E:\\Temp\\claude\\x\\tasks\\baepc74pm.output' }, tool_response: {},
  }, 1);
  assert.equal(powerShell.backgroundOutputTaskId, 'baepc74pm');

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

test('形に合わないバックグラウンドタスク ID はフックもサーバーの正規化も捨てる', () => {
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


test('完了通知が 9 件あれば出力ファイルを 8 件まで読み、読まなかった通知は送らない', () => {
  const readPaths = [];
  const ids = Array.from({ length: 9 }, (_, index) => `task-${index}`);
  const prompt = ids.map(id => `<task-notification><task-id>${id}</task-id><output-file>${path.resolve(id + '.output')}</output-file><status>completed</status></task-notification>`).join('\n');
  const event = makeHookEvent({ session_id: 'many-notifications', hook_event_name: 'UserPromptSubmit', prompt }, 1, {
    readTaskOutput(file) { readPaths.push(file); return 'codex-agent: result=ok'; },
  });
  assert.deepEqual(event.backgroundTaskEnds.map(end => end.taskId), ids.slice(0, 8));
  assert.deepEqual(sanitizeEvent(event).backgroundTaskEnds.map(end => end.taskId), ids.slice(0, 8));
  assert.deepEqual(readPaths, ids.slice(0, 8).map(id => path.resolve(id + '.output')));
});

test('完了通知の出力ファイルが消えていれば印を付けて送り、読めなければ送らない', () => {
  const prompt = ['task-a', 'task-b'].map(id => `<task-notification><task-id>${id}</task-id><output-file>${path.resolve('missing-dir-for-test', id + '.output')}</output-file><status>completed</status></task-notification>`).join('\n');
  const missing = makeHookEvent({ session_id: 'missing-output', hook_event_name: 'UserPromptSubmit', prompt }, 1);
  assert.deepEqual(sanitizeEvent(missing).backgroundTaskEnds, [
    { taskId: 'task-a', status: 'completed', outputMissing: true },
    { taskId: 'task-b', status: 'completed', outputMissing: true },
  ]);
  const unreadable = makeHookEvent({ session_id: 'missing-output', hook_event_name: 'UserPromptSubmit', prompt }, 1, {
    readTaskOutput() { return null; },
  });
  assert.equal(Object.hasOwn(unreadable, 'backgroundTaskEnds'), false);
});

test('フックは BackgroundTaskEnd と Claude の内部 Interrupt を送らない', () => {
  for (const hook_event_name of ['Interrupt', 'BackgroundTaskEnd']) {
    assert.equal(makeHookEvent({ session_id: 'internal', hook_event_name }), null);
    if (hook_event_name === 'BackgroundTaskEnd') assert.equal(makeHookEvent({ session_id: 'internal', hook_event_name }, 1, { provider: 'codex' }), null);
  }
});

test('Bash と PowerShell の Codex 起動と待機は保存された出力から末尾の結果行を取得する', () => {
  const outputPath = path.resolve('review-output.txt');
  const runId = 'impl-hard-20261003-123456-7';
  for (const tool_name of ['Bash', 'PowerShell']) {
    const commands = tool_name === 'PowerShell'
      ? ['& "$HOME\\.claude\\tools\\codex-agent.sh" impl-hard', 'npm run review:codex',
        '& "$HOME\\.claude\\tools\\codex-agent.sh" --wait ' + runId]
      : ['bash ~/.claude/tools/codex-agent.sh impl-hard < prompt.md', 'npm run review:codex',
        'bash ~/.claude/tools/codex-agent.sh --wait ' + runId];
    for (const hook_event_name of ['PostToolUse', 'PostToolUseFailure']) {
      for (const command of commands) {
        const readPaths = [];
        const event = makeHookEvent({
          session_id: 'persisted', hook_event_name, tool_name, tool_use_id: 'call',
          tool_input: { command },
          tool_response: { stdout: 'codex-agent: waiting run=' + runId, persistedOutputPath: outputPath },
        }, 1, { readTaskOutput(filePath) {
          readPaths.push(filePath);
          return 'codex-agent: vanished run=' + runId + '\ncodex-agent: result=ok';
        } });
        assert.deepEqual(readPaths, [outputPath]);
        assert.equal(event.codexOutput.resultLine, 'codex-agent: result=ok');
        assert.equal(event.codexOutput.waitStatusLine, 'codex-agent: vanished run=' + runId);
      }
    }
  }
});

test('Codex に関係のないコマンドの保存出力は読まない', () => {
  const readPaths = [];
  makeHookEvent({
    session_id: 'persisted', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call',
    tool_input: { command: 'npm test' }, tool_response: { persistedOutputPath: path.resolve('output.txt') },
  }, 1, { readTaskOutput(filePath) { readPaths.push(filePath); return 'codex-agent: result=ok'; } });
  assert.deepEqual(readPaths, []);
});

test('Codex の保存出力は絶対パスで許可されたファイル名のときだけ読む', () => {
  const readPaths = [];
  for (const persistedOutputPath of ['relative.txt', path.resolve('output.log'), path.resolve('名前.txt'), path.resolve(`${'a'.repeat(65)}.txt`)]) {
    makeHookEvent({
      session_id: 'persisted', hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'call',
      tool_input: { command: 'npm run review:codex' }, tool_response: { persistedOutputPath },
    }, 1, { readTaskOutput(filePath) { readPaths.push(filePath); return ''; } });
  }
  assert.deepEqual(readPaths, []);
});
