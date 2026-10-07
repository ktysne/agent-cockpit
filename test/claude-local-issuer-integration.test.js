'use strict';

// 既定のオプション(registry を注入しない)で常駐サーバーを起動し、擬似の Claude 本体の直接の子として
// 本物の MCP サーバーとフックを動かして、親プロセスの申告による writer の発行を確かめる。

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { startMcpServer, createClaudeWriterSession } = require('../src/mcp/server');
const { startServer } = require('../src/server/server');
const { jsonBody, request, startTestServer } = require('./support/server');
const { temporaryHome } = require('./support/temp');
const { startFakeClaude } = require('./support/fake-claude');

const SESSION_A = 'claude-session-a';
const SESSION_B = 'claude-session-b';
const PR_URL = 'https://github.com/example/project/pull/7';
const HEAD_SHA = 'a'.repeat(40);
const JSON_HEADERS = { 'content-type': 'application/json' };

function createEffects() {
  return { refreshRepo: 0, refreshRepoFresh: 0, setReviewSkip: 0 };
}

function pullRequestServices(effects) {
  return {
    pullRequestTracker: {
      start() {},
      close() {},
      snapshot() { return []; },
      refreshRepo() { effects.refreshRepo += 1; return Promise.resolve(); },
      async refreshRepoFresh() { effects.refreshRepoFresh += 1; return {}; },
      mergeCandidate() { return { pullRequest: { headRefOid: HEAD_SHA } }; },
      async refreshReviewGroups() {},
      async refreshAll() {},
    },
    pullRequestMergeManager: {
      start() {},
      close() {},
      async setReviewSkip(_registration, headRefOid, reason) {
        effects.setReviewSkip += 1;
        return { ok: true, saved: { headRefOid, reason } };
      },
    },
  };
}

async function startIntegrationServer(t, extra = {}) {
  const effects = createEffects();
  const server = await startTestServer(t, {
    temporaryPrefix: 'agent-cockpit-claude-issuer-',
    environment: { AGENT_COCKPIT_HOME: (homeDir) => homeDir },
    sessionScanIntervalMs: 50,
    ...pullRequestServices(effects),
    ...extra,
  });
  return { ...server, effects };
}

async function readState(server) {
  return jsonBody(await request(server.info.port, { path: '/api/state' }));
}

function sessionOf(state, sessionId) {
  return state.sessions.find((session) => session.session_id === sessionId);
}

async function waitFor(predicate, description, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(`timed out waiting for ${description}`);
}

function postJson(server, requestPath, body, headers = {}) {
  return request(server.info.port, {
    method: 'POST',
    path: requestPath,
    body: JSON.stringify(body),
    headers: { ...JSON_HEADERS, 'x-cockpit-secret': server.info.secret, ...headers },
  });
}

async function issueMcpWriter(server, ppid, contextPid = 4242) {
  const response = await postJson(server, '/api/claude/writer', { ppid, contextPid });
  assert.equal(response.status, 200, response.body);
  return jsonBody(response).writer;
}

function toolText(response) {
  return response.result.content[0].text;
}

function hookInput(sessionId, name, fields = {}) {
  return { session_id: sessionId, hook_event_name: name, cwd: process.cwd(), ...fields };
}

async function persistedText(homeDir) {
  const names = await fs.readdir(homeDir);
  const texts = await Promise.all(names.map(async (name) => {
    try { return await fs.readFile(path.join(homeDir, name), 'utf8'); } catch { return ''; }
  }));
  return texts.join('\n');
}

test('結合 1: MCP の各ツールとフックの各イベントが、親の申告だけで /api/state に反映される', async (t) => {
  const server = await startIntegrationServer(t);
  const claude = await startFakeClaude(t, { claudeHome: server.claudeHome, homeDir: server.homeDir, sessionId: SESSION_A });
  const mcp = await claude.startMcp();

  const start = await claude.runHook('event', hookInput(SESSION_A, 'SessionStart', { source: 'startup' }));
  assert.match(start.stdout, /Agent Cockpit: http:\/\/127\.0\.0\.1:\d+\//);
  await claude.runHook('event', hookInput(SESSION_A, 'UserPromptSubmit'));
  await claude.runHook('event', hookInput(SESSION_A, 'PreToolUse', {
    tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { command: 'npm test' },
  }));
  let session = sessionOf(await readState(server), SESSION_A);
  assert.deepEqual(session.tools.map((tool) => tool.tool_use_id), ['tool-1']);
  assert.equal(session.turnState, 'working');
  await claude.runHook('event', hookInput(SESSION_A, 'PostToolUse', {
    tool_name: 'Bash', tool_use_id: 'tool-1', tool_input: { command: 'npm test' }, tool_response: {},
  }));
  session = sessionOf(await readState(server), SESSION_A);
  assert.deepEqual(session.tools, []);

  const tasks = await claude.callTool(mcp, 'cockpit_set_tasks', {
    tasks: [{ title: '実装', state: 'doing', criteria: [{ text: '試験が通る', met: false }] }],
  });
  assert.equal(tasks.result.isError, undefined, toolText(tasks));
  session = sessionOf(await readState(server), SESSION_A);
  assert.deepEqual(session.tasks.map((task) => [task.title, task.state]), [['実装', 'doing']]);

  const added = await claude.callTool(mcp, 'cockpit_add_decision', {
    title: '方式を決める', context: '', state: 'waiting',
    options: [{ label: '案 A', description: '', recommended: true }],
  });
  assert.equal(added.result.isError, undefined, toolText(added));
  session = sessionOf(await readState(server), SESSION_A);
  const [decision] = session.decisions;
  assert.equal(decision.title, '方式を決める');
  const updated = await claude.callTool(mcp, 'cockpit_update_decision', {
    id: decision.id, state: 'resolved', chosen: '案 A', note: '決定',
  });
  assert.equal(updated.result.isError, undefined, toolText(updated));
  assert.equal(server.runtime.state.decisionFor(SESSION_A, decision.id).state, 'resolved');

  const pr = await claude.callTool(mcp, 'cockpit_add_pr', { url: PR_URL });
  assert.equal(pr.result.isError, undefined, toolText(pr));
  assert.deepEqual(
    server.runtime.state.pullRequestRegistrations().map((record) => [record.session_id, record.number]),
    [[SESSION_A, 7]],
  );
  assert.equal(server.effects.refreshRepo, 1);
  const skip = await claude.callTool(mcp, 'cockpit_skip_review', {
    owner: 'example', repo: 'project', number: 7, headRefOid: HEAD_SHA, reason: '文書だけの変更',
  });
  assert.equal(skip.result.isError, undefined, toolText(skip));
  assert.equal(server.effects.setReviewSkip, 1);

  // AskUserQuestion の回答: 離席中に登録した質問へ、ダッシュボードの回答がフックの出力として返る。
  await server.runtime.away.setEnabled(true, Date.now());
  const questions = [{ question: '形式は?', header: '', multiSelect: false, options: [
    { label: 'JSON (推奨)', description: '' }, { label: 'CSV', description: '' },
  ] }];
  const asking = claude.runHook('answer', hookInput(SESSION_A, 'PreToolUse', {
    tool_name: 'AskUserQuestion', tool_use_id: 'ask-1', tool_input: { questions },
  }));
  const askDecisionId = await waitFor(() => server.runtime.state.decisionIdForToolUse(SESSION_A, 'ask-1'), 'ask registration');
  assert.ok(server.runtime.answerDelivery.submitAnswer(SESSION_A, askDecisionId, 'ok', '推奨でよい'));
  const asked = await asking;
  assert.equal(asked.exitCode, 0);
  assert.deepEqual(JSON.parse(asked.stdout).hookSpecificOutput.updatedInput.answers, { '形式は?': 'JSON (推奨)' });
  await server.runtime.away.setEnabled(false, Date.now());

  // PostToolBatch: 回答待ちでない判断事項への回答を、次のツールの前に差し込む。
  const batchDecision = server.runtime.state.addDecision(SESSION_A, {
    title: '期限', context: '', state: 'provisional', options: [],
  }, Date.now());
  assert.ok(server.runtime.answerDelivery.submitAnswer(SESSION_A, batchDecision.id, null, '期限は 1 日'));
  const batch = await claude.runHook('answer', hookInput(SESSION_A, 'PostToolBatch'));
  assert.match(JSON.parse(batch.stdout).hookSpecificOutput.additionalContext, /期限は 1 日/);

  // Stop の asyncRewake: 待機中のセッションへ回答を届け、終了コード 2 で起こす。
  const stopDecision = server.runtime.state.addDecision(SESSION_A, {
    title: '削除方法', context: '', state: 'provisional', options: [],
  }, Date.now());
  assert.ok(server.runtime.answerDelivery.submitAnswer(SESSION_A, stopDecision.id, null, '退避してから削除'));
  const stop = await claude.runHook('answer', hookInput(SESSION_A, 'Stop'));
  assert.equal(stop.exitCode, 2);
  assert.match(stop.stderr, /退避してから削除/);

  await claude.runHook('event', hookInput(SESSION_A, 'Stop'));
  await claude.runHook('event', hookInput(SESSION_A, 'SessionEnd'));
  assert.equal(sessionOf(await readState(server), SESSION_A), undefined);
  assert.equal(server.runtime.state.endedAt.has(SESSION_A), true);
});

test('結合 2: 同じ CLAUDE_CODE_SESSION_ID を持つ親が Claude でないプロセスは、登録済みの Claude のセッションへ副作用 0 件になる', async (t) => {
  const server = await startIntegrationServer(t);
  const claude = await startFakeClaude(t, { claudeHome: server.claudeHome, homeDir: server.homeDir, sessionId: SESSION_A });
  await claude.runHook('event', hookInput(SESSION_A, 'SessionStart', { source: 'startup' }));
  assert.equal(server.runtime.state.isSessionAbsenceProtected(SESSION_A), true);
  const shimmed = await claude.startMcp({ viaShim: true, env: { CLAUDE_CODE_SESSION_ID: SESSION_A } });

  const tasks = await claude.callTool(shimmed, 'cockpit_set_tasks', { tasks: [{ title: '混入', state: 'todo', criteria: [] }] });
  assert.equal(tasks.result.isError, true);
  assert.match(toolText(tasks), /親プロセスを Claude と確認できませんでした/);
  const decision = await claude.callTool(shimmed, 'cockpit_add_decision', {
    title: '混入', context: '', state: 'waiting', options: [],
  });
  assert.equal(decision.result.isError, true);
  const pr = await claude.callTool(shimmed, 'cockpit_add_pr', { url: PR_URL });
  assert.equal(pr.result.isError, true);
  const skip = await claude.callTool(shimmed, 'cockpit_skip_review', {
    owner: 'example', repo: 'project', number: 7, headRefOid: HEAD_SHA, reason: '混入',
  });
  assert.equal(skip.result.isError, true);

  // writer の発行は、親の pid がセッションファイルに載らないプロセスには出さない。
  const notClaude = await postJson(server, '/api/claude/writer', { ppid: process.pid, contextPid: 1 });
  assert.equal(notClaude.status, 403);
  assert.equal(jsonBody(notClaude).reason, 'claude_parent_unverified');

  // 親が Claude でないフックは、登録済みの session_id に書けない。
  const before = JSON.stringify(sessionOf(await readState(server), SESSION_A));
  const forged = await postJson(server, '/api/events', {
    ...hookInput(SESSION_A, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'forged', tool_input: { command: 'ls' } }),
    claudeLineage: { ppid: process.pid },
  });
  assert.equal(forged.status, 403);
  const forgedAnswer = await postJson(server, '/api/hooks/answers', {
    action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: SESSION_A, id: 'forged', claudeLineage: { ppid: process.pid },
  });
  assert.equal(forgedAnswer.status, 403);
  assert.equal(JSON.stringify(sessionOf(await readState(server), SESSION_A)), before);

  // 親の Claude と別のセッション ID を名乗るフックは、観測として受け付けるだけで、期間を登録しない。
  const mismatched = await postJson(server, '/api/events', {
    ...hookInput('claude-session-other', 'UserPromptSubmit'), claudeLineage: { ppid: claude.pid },
  });
  assert.equal(mismatched.status, 202);
  assert.equal(server.runtime.state.isSessionAbsenceProtected('claude-session-other'), false);

  const state = await readState(server);
  assert.equal(sessionOf(state, SESSION_A).tasks.length, 0);
  assert.equal(sessionOf(state, SESSION_A).decisions.length, 0);
  assert.deepEqual(server.runtime.state.pullRequestRegistrations(), []);
  assert.deepEqual(server.effects, createEffects());
  const log = await fs.readFile(path.join(server.homeDir, 'server.log'), 'utf8');
  assert.match(log, /claude writer rejected: source=mcp reason=claude_parent_unverified/);
  assert.match(log, /claude writer rejected: source=hook reason=claude_parent_unverified/);
  assert.match(log, /claude writer rejected: source=hook reason=claude_session_mismatch/);
});

test('結合 3: 2 つのセッションを同時に動かしても、書き込みが混ざらない', async (t) => {
  const server = await startIntegrationServer(t);
  const first = await startFakeClaude(t, { claudeHome: server.claudeHome, homeDir: server.homeDir, sessionId: SESSION_A });
  const second = await startFakeClaude(t, { claudeHome: server.claudeHome, homeDir: server.homeDir, sessionId: SESSION_B });
  const [mcpA, mcpB] = await Promise.all([first.startMcp(), second.startMcp()]);

  const results = await Promise.all([
    first.callTool(mcpA, 'cockpit_set_tasks', { tasks: [{ title: 'A のタスク', state: 'doing', criteria: [] }] }),
    second.callTool(mcpB, 'cockpit_set_tasks', { tasks: [{ title: 'B のタスク', state: 'todo', criteria: [] }] }),
    first.runHook('event', hookInput(SESSION_A, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'a-tool', tool_input: { command: 'ls' } })),
    second.runHook('event', hookInput(SESSION_B, 'PreToolUse', { tool_name: 'Read', tool_use_id: 'b-tool', tool_input: { file_path: 'x' } })),
  ]);
  assert.equal(results[0].result.isError, undefined);
  assert.equal(results[1].result.isError, undefined);
  const decisionA = await first.callTool(mcpA, 'cockpit_add_decision', { title: 'A の判断', context: '', state: 'waiting', options: [] });
  assert.equal(decisionA.result.isError, undefined);

  // B のフックが A の session_id を名乗っても、B の親のセッションファイルと合わないので入らない。
  await second.runHook('event', hookInput(SESSION_A, 'PreToolUse', { tool_name: 'Write', tool_use_id: 'cross', tool_input: { file_path: 'y' } }));

  const state = await readState(server);
  const a = sessionOf(state, SESSION_A);
  const b = sessionOf(state, SESSION_B);
  assert.deepEqual(a.tasks.map((task) => task.title), ['A のタスク']);
  assert.deepEqual(b.tasks.map((task) => task.title), ['B のタスク']);
  assert.deepEqual(a.tools.map((tool) => tool.tool_use_id), ['a-tool']);
  assert.deepEqual(b.tools.map((tool) => tool.tool_use_id), ['b-tool']);
  assert.deepEqual(a.decisions.map((decision) => decision.title), ['A の判断']);
  assert.deepEqual(b.decisions, []);
});

test('結合 4: 常駐サーバーを再起動すると古い token は拒否され、MCP が照合し直すと書き込みが成功する', async (t) => {
  const temporary = temporaryHome(t, 'agent-cockpit-claude-issuer-restart-', {
    deferCleanup: true, environment: { AGENT_COCKPIT_HOME: (homeDir) => homeDir },
  });
  const serverOptions = {
    homeDir: temporary.homeDir, claudeHome: temporary.claudeHome, userHome: temporary.homeDir, port: 0,
    sessionScanIntervalMs: 50, ...pullRequestServices(createEffects()),
  };
  let runtime = await startServer(serverOptions);
  t.after(async () => {
    try { await runtime.close(); } finally { await temporary.cleanup(); }
  });
  const claude = await startFakeClaude(t, { claudeHome: temporary.claudeHome, homeDir: temporary.homeDir, sessionId: SESSION_A });
  const mcp = await claude.startMcp();
  const before = await claude.callTool(mcp, 'cockpit_set_tasks', { tasks: [{ title: '再起動の前', state: 'doing', criteria: [] }] });
  assert.equal(before.result.isError, undefined, toolText(before));
  const oldWriter = await issueMcpWriter({ info: runtime.info }, claude.pid);

  await runtime.close();
  runtime = await startServer({ ...serverOptions, pullRequestTracker: undefined, ...pullRequestServices(createEffects()) });
  const restarted = { info: runtime.info };

  const stale = await postJson(restarted, '/api/sessions/pending/plan', { kind: 'tasks', tasks: [], writer: oldWriter });
  assert.equal(stale.status, 403);
  const after = await claude.callTool(mcp, 'cockpit_set_tasks', { tasks: [{ title: '再起動の後', state: 'doing', criteria: [] }] });
  assert.equal(after.result.isError, undefined, toolText(after));
  const state = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.deepEqual(sessionOf(state, SESSION_A).tasks.map((task) => task.title), ['再起動の後']);
});

test('結合 5: 同じ親のセッション ID が変わると(/clear)、古い期間が終わり、以後の書き込みは新しいセッションに入る', async (t) => {
  const server = await startIntegrationServer(t);
  const claude = await startFakeClaude(t, { claudeHome: server.claudeHome, homeDir: server.homeDir, sessionId: SESSION_A });
  const mcp = await claude.startMcp();
  await claude.runHook('event', hookInput(SESSION_A, 'SessionStart', { source: 'startup' }));
  const before = await claude.callTool(mcp, 'cockpit_set_tasks', { tasks: [{ title: 'clear の前', state: 'doing', criteria: [] }] });
  assert.equal(before.result.isError, undefined, toolText(before));
  assert.equal(server.runtime.state.isSessionAbsenceProtected(SESSION_A), true);

  await claude.setSession(SESSION_B);
  await waitFor(() => !server.runtime.state.isSessionAbsenceProtected(SESSION_A), 'old period to end');

  // MCP は古い writer を 1 回だけ取り直して、新しいセッションへ書く。
  const after = await claude.callTool(mcp, 'cockpit_set_tasks', { tasks: [{ title: 'clear の後', state: 'doing', criteria: [] }] });
  assert.equal(after.result.isError, undefined, toolText(after));
  // 古いセッション ID を名乗るフックは親のセッションファイルと合わず、新しい ID のフックは入る。
  await claude.runHook('event', hookInput(SESSION_A, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'late-old', tool_input: { command: 'ls' } }));
  await claude.runHook('event', hookInput(SESSION_B, 'SessionStart', { source: 'clear' }));
  await claude.runHook('event', hookInput(SESSION_B, 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'new-tool', tool_input: { command: 'ls' } }));

  const state = await readState(server);
  assert.deepEqual(sessionOf(state, SESSION_A).tasks.map((task) => task.title), ['clear の前']);
  assert.deepEqual(sessionOf(state, SESSION_A).tools, []);
  assert.deepEqual(sessionOf(state, SESSION_B).tasks.map((task) => task.title), ['clear の後']);
  assert.deepEqual(sessionOf(state, SESSION_B).tools.map((tool) => tool.tool_use_id), ['new-tool']);
  assert.equal(server.runtime.state.isSessionAbsenceProtected(SESSION_B), true);
});

test('結合 6: 親が終了すると writer が失効し、不在の判定による終了の表示が従来どおり動く', async (t) => {
  const server = await startIntegrationServer(t);
  const claude = await startFakeClaude(t, { claudeHome: server.claudeHome, homeDir: server.homeDir, sessionId: SESSION_A });
  await claude.runHook('event', hookInput(SESSION_A, 'SessionStart', { source: 'startup' }));
  const writer = await issueMcpWriter(server, claude.pid);
  const live = await postJson(server, '/api/sessions/pending/plan', { kind: 'tasks', tasks: [], writer });
  assert.equal(live.status, 200);
  await waitFor(() => server.runtime.state.sessionFileLastSeenAt.has(SESSION_A), 'session file to be seen');

  await claude.exit();
  await waitFor(() => !server.runtime.state.isSessionAbsenceProtected(SESSION_A), 'period to end');

  const revoked = await postJson(server, '/api/sessions/pending/plan', { kind: 'tasks', tasks: [], writer });
  assert.equal(revoked.status, 403);
  server.runtime.state.syncSessionFiles([], Date.now() + 61_000);
  assert.equal(server.runtime.state.endedByAbsence.has(SESSION_A), true);
});

test('結合 7: agent_id 付きのフックがサブエージェントとして表示され、unknown にならない', async (t) => {
  const server = await startIntegrationServer(t);
  const claude = await startFakeClaude(t, { claudeHome: server.claudeHome, homeDir: server.homeDir, sessionId: SESSION_A });
  await claude.runHook('event', hookInput(SESSION_A, 'SessionStart', { source: 'startup' }));
  await claude.runHook('event', hookInput(SESSION_A, 'SubagentStart', { agent_id: 'agent-1', agent_type: 'general-purpose' }));
  await claude.runHook('event', hookInput(SESSION_A, 'PreToolUse', {
    agent_id: 'agent-1', agent_type: 'general-purpose', tool_name: 'Read', tool_use_id: 'agent-tool', tool_input: { file_path: 'a.txt' },
  }));

  const state = await readState(server);
  const session = sessionOf(state, SESSION_A);
  assert.deepEqual(session.agents.map((agent) => agent.agent_id), ['agent-1']);
  assert.equal(session.agents[0].active, true);
  assert.equal(session.agents[0].turnState, 'working');
  assert.deepEqual(session.tools.map((tool) => [tool.tool_use_id, tool.agent_id]), [['agent-tool', 'agent-1']]);
  const log = await fs.readFile(path.join(server.homeDir, 'server.log'), 'utf8');
  assert.doesNotMatch(log, /unknown/);
});

test('結合 8: /api/claude/writer は秘密値と Origin を照合し、token をログにも保存データにも残さない', async (t) => {
  const messagingToken = 'messaging-token-must-not-be-persisted';
  const previous = process.env.CLAUDE_CODE_MESSAGING_TOKEN;
  process.env.CLAUDE_CODE_MESSAGING_TOKEN = messagingToken;
  t.after(() => {
    if (previous === undefined) delete process.env.CLAUDE_CODE_MESSAGING_TOKEN;
    else process.env.CLAUDE_CODE_MESSAGING_TOKEN = previous;
  });
  const server = await startIntegrationServer(t);
  const claude = await startFakeClaude(t, { claudeHome: server.claudeHome, homeDir: server.homeDir, sessionId: SESSION_A });
  const body = { ppid: claude.pid, contextPid: 4242 };
  const post = (headers) => request(server.info.port, {
    method: 'POST', path: '/api/claude/writer', body: JSON.stringify(body), headers: { ...JSON_HEADERS, ...headers },
  });

  assert.equal((await post({})).status, 401);
  assert.equal((await post({ 'x-cockpit-secret': 'wrong-secret' })).status, 401);
  assert.equal((await post({ 'x-cockpit-secret': server.info.uiSecret })).status, 401);
  assert.equal((await post({ 'x-cockpit-secret': server.info.secret, origin: 'https://other.example' })).status, 403);
  assert.equal((await post({ 'x-cockpit-secret': server.info.secret, origin: `http://127.0.0.1:${server.info.port}` })).status, 403);
  assert.equal((await post({ 'x-cockpit-secret': server.info.secret, 'sec-fetch-site': 'cross-site' })).status, 403);
  for (const invalid of [{}, { ppid: claude.pid }, { ...body, extra: 1 }, { ppid: String(claude.pid), contextPid: 1 }, { ppid: 0, contextPid: 1 }]) {
    assert.equal((await postJson(server, '/api/claude/writer', invalid)).status, 400, JSON.stringify(invalid));
  }
  assert.equal((await request(server.info.port, {
    method: 'POST', path: '/api/claude/writer', body: '{', headers: { ...JSON_HEADERS, 'x-cockpit-secret': server.info.secret },
  })).status, 400);
  assert.equal((await request(server.info.port, { path: '/api/claude/writer' })).status, 405);

  // MCP が受け取る writer(メモリー内)の token は、MCP の結果にも保存データにも出ない。
  const session = createClaudeWriterSession({
    ppid: claude.pid, contextPid: 5151, homeDir: server.homeDir, environment: { AGENT_COCKPIT_HOME: server.homeDir },
  });
  await session.refreshWriter();
  const mcpToken = session.getWriter().token;
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8').on('data', (chunk) => { text += chunk; });
  const running = startMcpServer({ input, output, ...session, homeDir: server.homeDir, environment: { AGENT_COCKPIT_HOME: server.homeDir } });
  input.end(`${JSON.stringify({
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'cockpit_set_tasks', arguments: { tasks: [{ title: '秘匿', state: 'doing', criteria: [] }] } },
  })}\n`);
  await running;
  assert.equal(JSON.parse(text.trim()).result.isError, undefined);
  assert.ok(!text.includes(mcpToken));

  const hookWriter = await issueMcpWriter(server, claude.pid, 6161);
  await claude.runHook('event', hookInput(SESSION_A, 'SessionStart', { source: 'startup' }));
  await server.runtime.state.flushPersistence();
  const stored = await persistedText(server.homeDir);
  const state = JSON.stringify(await readState(server));
  for (const secret of [mcpToken, hookWriter.token, messagingToken]) {
    assert.ok(!stored.includes(secret), 'persisted data');
    assert.ok(!state.includes(secret), 'api state');
  }
});

test('結合 9: セッションファイルを読めないときは、MCP は拒否し、フックは観測の経路になって期間を登録しない', async (t) => {
  const server = await startIntegrationServer(t);
  const claude = await startFakeClaude(t, { claudeHome: server.claudeHome, homeDir: server.homeDir, sessionId: SESSION_A });
  await fs.rm(path.join(server.claudeHome, 'sessions'), { recursive: true, force: true });
  const mcp = await claude.startMcp({ env: { CLAUDE_CODE_SESSION_ID: SESSION_A } });

  const tasks = await claude.callTool(mcp, 'cockpit_set_tasks', { tasks: [{ title: '旧経路', state: 'todo', criteria: [] }] });
  assert.equal(tasks.result.isError, true);
  assert.match(toolText(tasks), /セッションファイルを読めない/);
  const unreadable = await postJson(server, '/api/claude/writer', { ppid: claude.pid, contextPid: 1 });
  assert.equal(unreadable.status, 403);
  assert.equal(jsonBody(unreadable).reason, 'claude_sessions_unreadable');

  await claude.runHook('event', hookInput(SESSION_A, 'UserPromptSubmit'));
  await claude.runHook('event', hookInput(SESSION_A, 'PreToolUse', {
    tool_name: 'Bash', tool_use_id: 'observed-tool', tool_input: { command: 'ls' },
  }));

  // フックは未登録の観測として載るが、期間は登録されず、MCP の書き込みも通らないままである。
  const session = sessionOf(await readState(server), SESSION_A);
  assert.deepEqual(session.tools.map((tool) => tool.tool_use_id), ['observed-tool']);
  assert.equal(session.tasks.length, 0);
  assert.equal(server.runtime.state.isSessionAbsenceProtected(SESSION_A), false);
  const retry = await postJson(server, '/api/sessions/pending/plan', { kind: 'tasks', tasks: [] });
  assert.equal(retry.status, 403);
  const log = await fs.readFile(path.join(server.homeDir, 'server.log'), 'utf8');
  assert.match(log, /claude writer rejected: source=hook reason=claude_sessions_unreadable/);
});
