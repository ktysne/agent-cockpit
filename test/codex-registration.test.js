const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const vm = require('node:vm');
const { runHook } = require('../src/hooks/event');
const { handleRequest } = require('../src/mcp/server');
const { hookHeaders, jsonBody, request, startTestServer } = require('./support/server');
const { functionSource, displayPageContext: pageContext } = require('./support/page-context');

async function cockpit(t, options = {}) {
  const server = await startTestServer(t, options);
  const post = (url, body) => request(server.info.port, {
    method: 'POST', path: url, headers: hookHeaders(server.info.secret), body: JSON.stringify(body),
  });
  // 製品のフックと同じく送る側で時刻を付ける。受信時刻に任せると、同じミリ秒に届いたイベントの前後が決まらないため。
  let hookAt = Date.now();
  const event = (id, name, fields = {}) => post('/api/events', {
    session_id: id, hook_event_name: name, provider: 'codex', cwd: server.homeDir, hookAt: hookAt++, ...fields,
  });
  const snapshot = async () => jsonBody(await request(server.info.port, { path: '/api/state' }));
  const initialize = (name = 'codex-mcp-client') => handleRequest({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name } },
  });
  const mcp = async (name, args, meta, extra = {}) => {
    const response = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) },
    }, { homeDir: server.homeDir, environment: {}, ...extra });
    return response.result;
  };
  return { ...server, post, event, snapshot, initialize, mcp };
}

const tasks = (title) => ({ tasks: [{ title, state: 'doing', criteria: [] }] });

test('Codex のフックは親とネイティブの子を同じセッションに登録してモデルと再開を表示する', async (t) => {
  const c = await cockpit(t);
  await c.event('parent', 'SessionStart', { source: 'startup', model: 'gpt-6' });
  await c.event('parent', 'SubagentStart', { agent_id: 'child', agent_type: 'default', model: 'gpt-6-sol' });
  await c.event('parent', 'PreToolUse', { agent_id: 'child', tool_name: 'exec_command', tool_use_id: 'tool', model: 'gpt-6.1-sol' });
  await c.event('parent', 'SessionStart', { source: 'resume', model: 'gpt-6-astra' });
  const [session] = (await c.snapshot()).sessions;
  assert.equal(session.provider, 'codex');
  assert.deepEqual(session.codex, { model: 'gpt-6-astra', resumes: 1 });
  assert.equal(session.agents[0].agent_id, 'child');
  assert.equal(session.agents[0].model, 'gpt-6.1-sol');
  assert.equal(session.agents[0].isCodex, undefined);
  assert.equal(session.tools[0].tool_name, 'exec_command');
  await c.event('parent', 'SubagentStop', { agent_id: 'child' });
  assert.equal((await c.snapshot()).sessions[0].agents[0].active, false);
});

test('provider が異なるイベントは既存のセッションの状態を変えない', async (t) => {
  const c = await cockpit(t);
  await c.event('codex', 'SessionStart', { source: 'startup' });
  const before = (await c.snapshot()).sessions[0];
  await c.event('codex', 'PreToolUse', { provider: 'claude', tool_name: 'Bash', tool_use_id: 'other' });
  assert.deepEqual((await c.snapshot()).sessions[0], before);
});

test('Codex の再開の回数は SessionEnd を挟んでも続けて数える', async (t) => {
  const c = await cockpit(t);
  for (let round = 0; round < 2; round += 1) {
    await c.event('thread', 'SessionStart', { source: 'resume' });
    await c.event('thread', 'SessionEnd');
  }
  await c.event('thread', 'SessionStart', { source: 'resume' });
  assert.equal((await c.snapshot()).sessions[0].codex.resumes, 3);
});

test('未知の provider を持つフックは Claude のセッションとして登録する', async (t) => {
  const c = await cockpit(t);
  await c.event('unknown-provider', 'SessionStart', { provider: 'other' });
  assert.equal((await c.snapshot()).sessions[0].provider, 'claude');
});

test('Codex の許可確認中はツール完了またはターンの区切りで解消する', async (t) => {
  const c = await cockpit(t);
  for (const name of ['PostToolUse', 'PostToolUseFailure', 'Stop', 'Interrupt', 'UserPromptSubmit']) {
    await c.event(name, 'PreToolUse', { tool_name: 'exec_command', tool_use_id: 'tool' });
    await c.event(name, 'PermissionRequest', { tool_name: 'exec_command', summary: 'npm test' });
    const waiting = (await c.snapshot()).sessions.find(s => s.session_id === name);
    assert.equal(waiting.status, '許可確認中');
    assert.equal(waiting.permissionWaits[0].phase, 'checking');
    assert.equal(waiting.permissionWaits[0].summary, 'npm test');
    await c.event(name, name, { tool_name: 'exec_command', tool_use_id: 'tool' });
    const done = (await c.snapshot()).sessions.find(s => s.session_id === name);
    assert.deepEqual(done.permissionWaits, []);
    assert.equal(done.status, { Stop: '待機中', Interrupt: '中断' }[name] ?? '作業中');
  }
});

test('Codex の許可確認中は別のツールの完了では解消しない', async (t) => {
  const c = await cockpit(t);
  await c.event('parallel', 'PreToolUse', { tool_name: 'exec_command', tool_use_id: 'shell' });
  await c.event('parallel', 'PreToolUse', { tool_name: 'mcp__cockpit__probe', tool_use_id: 'probe' });
  await c.event('parallel', 'PermissionRequest', { tool_name: 'exec_command' });
  await c.event('parallel', 'PostToolUse', { tool_name: 'mcp__cockpit__probe', tool_use_id: 'probe' });
  assert.equal((await c.snapshot()).sessions[0].status, '許可確認中');
  await c.event('parallel', 'PostToolUse', { tool_name: 'exec_command', tool_use_id: 'shell' });
  assert.deepEqual((await c.snapshot()).sessions[0].permissionWaits, []);
});

test('Codex の子の許可確認中はその子のツール完了で解消する', async (t) => {
  const c = await cockpit(t);
  await c.event('parent', 'PermissionRequest', { agent_id: 'child', tool_name: 'exec_command' });
  await c.event('parent', 'PostToolUse', { agent_id: 'child', tool_name: 'exec_command', tool_use_id: 'tool' });
  assert.deepEqual((await c.snapshot()).sessions[0].permissionWaits, []);
});

test('登録済みの Codex の親と子の MCP は継承した Claude の ID へ書き込まない', async (t) => {
  const c = await cockpit(t);
  await c.event('claude-parent', 'SessionStart', { provider: 'claude' });
  await c.event('codex-parent', 'SessionStart');
  await c.initialize();
  for (const threadId of ['codex-parent', 'codex-child']) {
    const saved = await c.mcp('cockpit_set_tasks', tasks(threadId), { sessionId: 'codex-parent', threadId },
      { environment: { CLAUDE_CODE_SESSION_ID: 'claude-parent' }, ppid: process.pid });
    assert.equal(saved.isError, undefined);
    const sessions = (await c.snapshot()).sessions;
    assert.equal(sessions.find(s => s.session_id === 'codex-parent').tasks[0].title, threadId);
    assert.deepEqual(sessions.find(s => s.session_id === 'claude-parent').tasks, []);
  }
});

test('独立した Codex の MCP の書き込みはそれぞれのセッションへ届く', async (t) => {
  const c = await cockpit(t);
  await c.initialize();
  for (const id of ['first', 'second']) {
    await c.event(id, 'SessionStart');
    await c.mcp('cockpit_set_tasks', tasks(id), { sessionId: id, threadId: id });
  }
  assert.deepEqual((await c.snapshot()).sessions.map(s => [s.session_id, s.tasks[0].title]), [['first', 'first'], ['second', 'second']]);
});

test('Codex の MCP は親の判断事項を追加して解決する', async (t) => {
  const c = await cockpit(t);
  await c.event('parent', 'SessionStart');
  await c.initialize();
  const meta = { sessionId: 'parent', threadId: 'child' };
  assert.equal((await c.mcp('cockpit_add_decision', { title: '方針', context: '実装方針を選ぶ', state: 'waiting',
    options: [{ label: '採用', description: 'この方針で進める', recommended: true }] }, meta)).isError, undefined);
  const decision = (await c.snapshot()).sessions[0].decisions[0];
  assert.equal((await c.mcp('cockpit_update_decision', { id: decision.id, state: 'resolved', chosen: ['採用'], note: '' }, meta)).isError, undefined);
  assert.equal((await c.snapshot()).sessions[0].decisions[0].state, 'resolved');
});

test('Codex の MCP は未登録、Claude、終了済みのセッションへ書き込まない', async (t) => {
  const c = await cockpit(t);
  await c.event('claude', 'SessionStart', { provider: 'claude' });
  await c.event('ended', 'SessionStart');
  await c.event('ended', 'SessionEnd');
  await c.initialize();
  for (const id of ['missing', 'claude', 'ended']) {
    const response = await c.mcp('cockpit_set_tasks', tasks('書き込まない'), { sessionId: id });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /Codex のフックが届いていない/);
  }
  assert.deepEqual((await c.snapshot()).sessions[0].tasks, []);
  assert.equal(c.runtime.state.plans.size, 0);
});

test('Codex の MCP は sessionId が無い場合に送信しない', async () => {
  await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'codex-mcp-client' } } });
  let sent = false;
  const result = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'cockpit_set_tasks', arguments: tasks('送らない'), _meta: { threadId: 'child' } },
  }, { fetchImpl: async () => { sent = true; } });
  assert.equal(result.result.isError, true);
  assert.equal(sent, false);
});

test('Claude と判断された MCP は threadId を持つ要求を送信しない', async () => {
  await handleRequest({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { clientInfo: { name: 'changed-codex-client' } } });
  let sent = false;
  const result = await handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/call',
    params: { name: 'cockpit_set_tasks', arguments: tasks('送らない'), _meta: { threadId: 'thread' } },
  }, { fetchImpl: async () => { sent = true; } });
  assert.equal(result.result.isError, true);
  assert.equal(sent, false);
});

test('Codex と Claude の識別情報が混在する HTTP 書き込みは拒否する', async (t) => {
  const c = await cockpit(t);
  await c.event('codex', 'SessionStart');
  for (const fields of [{ ppid: process.pid }, { claudeCodeSessionId: null }]) {
    for (const [route, body] of [['plan', { kind: 'tasks', ...tasks('拒否') }],
      ['prs', { kind: 'add_pr', url: 'https://github.com/example/project/pull/1' }],
      ['prs', { kind: 'skip_review', owner: 'example', repo: 'project', number: 1, headRefOid: 'a'.repeat(40), reason: '文言のみ' }]]) {
      const response = await c.post(`/api/sessions/codex/${route}`, { ...body, codexSessionId: 'codex', ...fields });
      assert.equal(response.status, 400);
    }
  }
  assert.deepEqual((await c.snapshot()).sessions[0].tasks, []);
  assert.deepEqual(c.runtime.state.pullRequestRegistrations(), []);
});

test('Codex の plan と PR の HTTP 書き込みは未登録または終了済みなら拒否する', async (t) => {
  const c = await cockpit(t);
  await c.event('ended', 'SessionStart');
  await c.event('ended', 'SessionEnd');
  for (const id of ['missing', 'ended']) {
    for (const [route, body] of [['plan', { kind: 'tasks', ...tasks('拒否') }],
      ['prs', { kind: 'add_pr', url: 'https://github.com/example/project/pull/1' }],
      ['prs', { kind: 'skip_review', owner: 'example', repo: 'project', number: 1, headRefOid: 'a'.repeat(40), reason: '文言のみ' }]]) {
      assert.equal((await c.post(`/api/sessions/${id}/${route}`, { ...body, codexSessionId: id })).status, 403);
    }
  }
  assert.deepEqual(c.runtime.state.pullRequestRegistrations(), []);
  assert.equal(c.runtime.state.plans.size, 0);
});

test('Codex の MCP は PR を親に登録してレビュー不要を記録する', async (t) => {
  const skipped = [];
  const c = await cockpit(t, {
    pullRequestTracker: { start() {}, close() {}, snapshot: () => [], refreshRepo: async () => {}, refreshRepoFresh() {}, mergeCandidate() {} },
    pullRequestMergeManager: { start() {}, close() {}, setReviewSkip: async (registration, headRefOid, reason) => {
      skipped.push({ registration, headRefOid, reason });
      return { ok: true, saved: { ...registration, headRefOid } };
    } },
  });
  await c.event('parent', 'SessionStart');
  await c.initialize();
  const meta = { sessionId: 'parent', threadId: 'child' };
  assert.equal((await c.mcp('cockpit_add_pr', { url: 'https://github.com/example/project/pull/1' }, meta)).isError, undefined);
  assert.equal((await c.mcp('cockpit_skip_review', { owner: 'example', repo: 'project', number: 1,
    headRefOid: 'a'.repeat(40), reason: '文言のみ' }, meta)).isError, undefined);
  assert.equal(skipped[0].registration.session_id, 'parent');
});

test('既定のサーバーで provider の無い Claude フックと meta の無い MCP は従来の応答を返す', async (t) => {
  const c = await cockpit(t);
  const hook = await runHook({ session_id: 'claude-default', hook_event_name: 'SessionStart', source: 'startup', cwd: c.homeDir }, { homeDir: c.homeDir });
  assert.equal(hook.exitCode, 0);
  assert.equal(hook.additionalContext, `Agent Cockpit: http://127.0.0.1:${c.info.port}/`);
  await c.initialize('claude-client');
  const saved = await c.mcp('cockpit_set_tasks', tasks('従来のタスク'), undefined,
    { environment: { CLAUDE_CODE_SESSION_ID: 'claude-default' }, ppid: process.pid });
  assert.equal(saved.isError, undefined);
  assert.equal(saved.content[0].text, 'タスクを記録しました: 従来のタスク (doing)');
  const [session] = (await c.snapshot()).sessions;
  assert.equal(session.provider, 'claude');
  assert.equal(session.tasks[0].title, '従来のタスク');
});

test('Codex の runHook は Claude 固有のツール解析と経路読み取りを行わず、Bash の gh pr create は PR として登録する', async (t) => {
  const c = await cockpit(t);
  const options = { homeDir: c.homeDir, provider: 'codex', findCodexParentPid: async () => null };
  const started = await runHook({ session_id: 'hook', hook_event_name: 'SessionStart', source: 'startup', model: 'x'.repeat(200) }, options);
  assert.equal(started.additionalContext, `Agent Cockpit: http://127.0.0.1:${c.info.port}/`);
  await runHook({ session_id: 'hook', hook_event_name: 'SubagentStart', agent_id: 'child', agent_type: 'default', model: 'gpt-6' }, options);
  for (const tool_name of ['Bash', 'Agent', 'AskUserQuestion']) {
    const input = { session_id: 'hook', hook_event_name: 'PreToolUse', tool_name, tool_use_id: tool_name,
      tool_input: { command: 'gh pr create && npm run review:codex && codex-agent.sh --wait impl-hard-20261011-123456-1', description: '解析しない', questions: [{ question: '選択', options: [] }] } };
    await runHook(input, options);
    await runHook({ ...input, hook_event_name: 'PostToolUse', tool_response: 'https://github.com/example/project/pull/1\ncodex-agent: agent=impl-hard model=gpt-6' }, options);
  }
  const [session] = (await c.snapshot()).sessions;
  assert.equal(session.codex.model.length, 160);
  assert.equal(session.agents.length, 1);
  assert.equal(session.agents[0].route, undefined);
  assert.deepEqual(session.decisions, []);
  assert.deepEqual(c.runtime.state.pullRequestRegistrations().map(({ number, provider }) => ({ number, provider })), [{ number: 1, provider: 'codex' }]);
});

test('Codex の runHook は PermissionRequest にツール名と入力の要約を載せる', async (t) => {
  const c = await cockpit(t);
  await runHook({ session_id: 'permission', hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test' } },
    { provider: 'codex', homeDir: c.homeDir });
  const wait = (await c.snapshot()).sessions[0].permissionWaits[0];
  assert.equal(wait.tool_name, 'Bash');
  assert.equal(wait.summary, 'npm test');
  assert.equal(wait.phase, 'checking');
});

test('Codex の子が稼働中でも Claude のエージェント定義とタスク通知を読まない', async (t) => {
  let taskReads = 0;
  const c = await cockpit(t, { taskNotificationDelayMs: 1, readTaskNotifications: async () => { taskReads += 1; return new Map(); } });
  const reads = [];
  const original = fs.readFile;
  t.mock.method(fs, 'readFile', async (file, ...args) => { reads.push(String(file)); return original(file, ...args); });
  await c.event('parent', 'SessionStart', { source: 'startup' });
  await c.event('parent', 'SubagentStart', { agent_id: 'child', agent_type: 'default', model: 'gpt-6' });
  await c.event('parent', 'PreToolUse', { tool_name: 'Bash', tool_use_id: 'review', summary: 'codex-agent.sh impl-hard', codexReviewDefinition: 'codex-review' });
  await c.event('parent', 'Stop');
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(taskReads, 0);
  assert.equal(reads.some(file => /[\\/](?:agents|gpt-agents)[\\/]/.test(file)), false);
});

test('Claude のセッションファイルに無い Codex は不在によって終了しない', async (t) => {
  const c = await cockpit(t);
  await fs.mkdir(path.join(c.claudeHome, 'sessions'), { recursive: true });
  await c.event('parent', 'SessionStart', { source: 'startup' });
  c.runtime.state.syncSessionFiles([], Date.now() + 120_000);
  assert.equal((await c.snapshot()).sessions[0].session_id, 'parent');
});

test('Codex のメインと子の画面行はそれぞれのモデルとメインの再開回数を表示し、題に thread ID を使わない', async (t) => {
  const c = await cockpit(t);
  await c.event('parent', 'SessionStart', { source: 'resume', model: 'gpt-6' });
  await c.event('parent', 'SubagentStart', { agent_id: 'child', model: 'gpt-6-sol' });
  const session = (await c.snapshot()).sessions[0];
  const html = (await request(c.info.port)).body.replace(/\r\n/g, '\n');
  const element = (tagName, className = '', textContent = '') => ({
    tagName, className, textContent, childNodes: [], dataset: {},
    append(...nodes) { this.childNodes.push(...nodes); },
  });
  const context = pageContext(html, { element, document: { createTextNode: text => element('text', '', text) },
    activityStatus: () => ({ tone: 'wait', label: '待機中' }), newestFirst: items => items,
    appendContextTags() {}, appendUnknownSessionControls() {}, durationAgoLabel: () => '1 分前',
    relativeTimeElement: () => element('time'), badge: text => element('span', 'badge', text),
    expandedEndedSessions: new Set(), displayPreferences: { hideFinished: true }, isFilterShown: () => true,
    isEndedAgent: agent => !agent.active,
  });
  vm.runInContext(['sessionOrigin', 'mainRow', 'appendAgents', 'appendSessionModelLine', 'appendModelLine', 'sessionDisplayName']
    .map(name => functionSource(html, name)).join('\n'), context);
  assert.equal(context.sessionDisplayName(session), 'Codex のセッション');
  const texts = node => [node.textContent, ...node.childNodes.flatMap(texts)];
  const main = texts(context.mainRow(session, {}));
  assert.ok(main.includes('Codex gpt-6'));
  assert.ok(main.includes('再開 1 回'));
  const children = element('div');
  context.appendAgents(children, session, {}, false, false, false, false);
  assert.ok(texts(children).includes('Codex gpt-6-sol'));
  assert.equal(texts(children).some(text => /^Claude |^GPT /.test(text)), false);
});
