const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { runHook } = require('../src/hooks/event');
const { DashboardState } = require('../src/server/state');
const {
  startServer,
  MAX_BODY_BYTES,
  escapeHtmlAttribute,
} = require('../src/server/server');

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

async function request(port, options = {}) {
  const method = options.method || 'GET';
  const body = options.body || '';
  const headers = { ...options.headers };
  if (body && headers['content-length'] === undefined) headers['content-length'] = Buffer.byteLength(body);
  if (headers.host === undefined) headers.host = `127.0.0.1:${port}`;
  return new Promise((resolve, reject) => {
    const client = http.request({ host: '127.0.0.1', port, path: options.path || '/', method, headers }, (response) => {
      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: response.headers }));
    });
    client.once('error', reject);
    client.end(body);
  });
}

function jsonBody(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    assert.fail(`Expected JSON response, received: ${response.body}`);
  }
}

test('離席中の切り替えは秘密値と Origin を照合し、状態を軽い応答で返す', async (t) => {
  const runtime = await runningServer(t);
  const body = JSON.stringify({ enabled: true });
  const missingSecret = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body,
    headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${runtime.info.port}` },
  });
  assert.equal(missingSecret.status, 401);

  const hookSecret = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(hookSecret.status, 401);

  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin: 'https://other.example' },
  });
  assert.equal(foreignOrigin.status, 403);

  const enabled = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(enabled.status, 200);
  assert.deepEqual(jsonBody(enabled).enabled, true);
  assert.ok(Number.isFinite(jsonBody(enabled).since));

  const enabledLocalhost = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body,
    headers: {
      'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret,
      origin: `http://localhost:${runtime.info.port}`,
    },
  });
  assert.equal(enabledLocalhost.status, 200);

  const enabledLoopback = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body,
    headers: {
      'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret,
      origin: `http://127.0.0.1:${runtime.info.port}`,
    },
  });
  assert.equal(enabledLoopback.status, 200);

  const disabled = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body: JSON.stringify({ enabled: false }),
    headers: {
      'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret,
      origin: `http://localhost:${runtime.info.port}`,
    },
  });
  assert.equal(disabled.status, 200);
  assert.deepEqual(jsonBody(disabled), { enabled: false, since: null });

  const invalidEnabled = await request(runtime.info.port, {
    method: 'POST', path: '/api/away', body: JSON.stringify({ enabled: 'true' }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(invalidEnabled.status, 400);

  const away = await request(runtime.info.port, { path: '/api/away' });
  assert.deepEqual(Object.keys(jsonBody(away)).sort(), ['enabled', 'since']);
  assert.deepEqual(jsonBody(away), { enabled: false, since: null });
  const state = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.deepEqual(state.away, { enabled: false, since: null });
  assert.equal(away.headers['access-control-allow-origin'], undefined);
});

test('PR マージ口は画面秘密値と Origin 必須照合を行い、owner/repo を要求本文から拒む', async (t) => {
  const runtime = await runningServer(t);
  const path = '/api/pull-requests/merge';
  const payload = {
    number: 41, registration_key: 'b'.repeat(64),
    headRefOid: 'a'.repeat(40), method: 'squash', deleteBranch: true,
  };
  const body = JSON.stringify(payload);
  const origin = `http://127.0.0.1:${runtime.info.port}`;

  const missingSecret = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json', origin },
  });
  assert.equal(missingSecret.status, 401);

  const hookSecret = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret, origin },
  });
  assert.equal(hookSecret.status, 401);

  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin: 'https://other.example' },
  });
  assert.equal(foreignOrigin.status, 403);

  const missingOrigin = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(missingOrigin.status, 403);

  const missingRegistrationKey = await request(runtime.info.port, {
    method: 'POST', path, body: JSON.stringify({ ...payload, registration_key: undefined }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin },
  });
  assert.equal(missingRegistrationKey.status, 400);

  const suppliedRepository = await request(runtime.info.port, {
    method: 'POST', path, body: JSON.stringify({ ...payload, owner: 'example', repo: 'project' }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin },
  });
  assert.equal(suppliedRepository.status, 400);

  const recordedKeyOnly = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin },
  });
  assert.equal(recordedKeyOnly.status, 404);
});

test('状態推定 API は画面の認証とセッション状態を照合し、結果を保存する', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const state = new DashboardState();
  const cwd = path.join(homeDir, 'workspace', 'project');
  state.syncSessionFiles([
    { session_id: 'estimate_unknown', cwd, name: '不明なセッション' },
    { session_id: 'estimate_known', cwd, name: '既知のセッション' },
  ]);
  state.addEvent({ session_id: 'estimate_known', hook_event_name: 'SessionStart', hookAt: 100 });
  const projectDirectory = path.join(claudeHome, 'projects', cwd.replace(/[^A-Za-z0-9]/g, '-'));
  await fs.mkdir(projectDirectory, { recursive: true });
  await fs.writeFile(path.join(projectDirectory, 'estimate_unknown.jsonl'), `${JSON.stringify({
    type: 'assistant', timestamp: '2026-10-02T01:02:03.000Z', isSidechain: false,
    message: { role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: '本文は返さない' }] },
  })}\n`);
  const runtime = await startServer({ homeDir, claudeHome, port: 0, state });
  t.after(() => runtime.close());
  const endpoint = '/api/sessions/estimate_unknown/estimate';
  const validHeaders = {
    'content-type': 'application/json',
    'x-cockpit-secret': runtime.info.uiSecret,
    origin: `http://127.0.0.1:${runtime.info.port}`,
  };

  const unauthorized = await request(runtime.info.port, { method: 'POST', path: endpoint });
  assert.equal(unauthorized.status, 401);
  const forbidden = await request(runtime.info.port, {
    method: 'POST', path: endpoint,
    headers: { ...validHeaders, origin: 'https://other.example' },
  });
  assert.equal(forbidden.status, 403);
  const missing = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/not_known/estimate', headers: validHeaders,
  });
  assert.equal(missing.status, 404);
  const conflict = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/estimate_known/estimate', headers: validHeaders,
  });
  assert.equal(conflict.status, 409);

  const versionBeforeEstimate = state.version;
  const estimated = await request(runtime.info.port, { method: 'POST', path: endpoint, headers: validHeaders });
  assert.equal(estimated.status, 200);
  assert.equal(state.version, versionBeforeEstimate + 1);
  assert.deepEqual(jsonBody(estimated), {
    canEstimate: true, recordedAt: '2026-10-02T01:02:03.000Z', lastTool: null, state: 'input',
  });
  const snapshot = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.deepEqual(snapshot.sessions.find((session) => session.session_id === 'estimate_unknown').estimate, jsonBody(estimated));
  assert.equal(snapshot.version, state.version);
});

test('一覧から外す API は認証し、複数の状態のセッションをまとめて外してすべて表示できる', async (t) => {
  const state = new DashboardState();
  state.syncSessionFiles([
    { session_id: 'hide_unknown', cwd: 'C:\\project', name: '不明なセッション' },
    { session_id: 'hide_known', cwd: 'C:\\project', name: '既知のセッション' },
  ]);
  state.addEvent({ session_id: 'hide_known', hook_event_name: 'SessionStart', hookAt: 100 });
  const runtime = await runningServer(t, { state });
  const endpoint = '/api/hidden-sessions';
  const body = JSON.stringify({ action: 'hide', session_id: 'hide_unknown' });
  const validHeaders = {
    'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret,
    origin: `http://localhost:${runtime.info.port}`,
  };

  const unauthorized = await request(runtime.info.port, { method: 'POST', path: endpoint, body });
  assert.equal(unauthorized.status, 401);
  const forbidden = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body,
    headers: { ...validHeaders, origin: 'https://other.example' },
  });
  assert.equal(forbidden.status, 403);
  const missing = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ action: 'hide', session_id: 'not_known' }), headers: validHeaders,
  });
  assert.equal(missing.status, 404);
  const conflict = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ action: 'hide', session_id: 'hide_known' }), headers: validHeaders,
  });
  assert.equal(conflict.status, 200);
  assert.deepEqual(jsonBody(conflict), { hidden: true });
  const invalid = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ action: 'clear', session_id: 'extra' }), headers: validHeaders,
  });
  assert.equal(invalid.status, 400);

  const versionBeforeHide = state.version;
  const hidden = await request(runtime.info.port, { method: 'POST', path: endpoint, body, headers: validHeaders });
  assert.equal(hidden.status, 200);
  assert.equal(state.version, versionBeforeHide + 1);
  assert.deepEqual(jsonBody(hidden), { hidden: true });
  assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions.find((session) => session.session_id === 'hide_unknown').hidden, true);

  const batchHidden = await request(runtime.info.port, {
    method: 'POST', path: endpoint,
    body: JSON.stringify({ action: 'hide', session_ids: ['hide_unknown', 'hide_known', 'not_known'] }),
    headers: validHeaders,
  });
  assert.equal(batchHidden.status, 200);
  assert.deepEqual(jsonBody(batchHidden), { hidden: 2 });
  const allHidden = jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions;
  assert.equal(allHidden.find((session) => session.session_id === 'hide_unknown').hidden, true);
  assert.equal(allHidden.find((session) => session.session_id === 'hide_known').hidden, true);

  const batchMissing = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ action: 'hide', session_ids: ['not_known'] }), headers: validHeaders,
  });
  assert.equal(batchMissing.status, 404);
  const emptyBatch = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ action: 'hide', session_ids: [] }), headers: validHeaders,
  });
  assert.equal(emptyBatch.status, 400);
  const oversizedBatch = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ action: 'hide', session_ids: Array.from({ length: 51 }, (_, index) => `session_${index}`) }), headers: validHeaders,
  });
  assert.equal(oversizedBatch.status, 400);

  const versionBeforeClear = state.version;
  const cleared = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ action: 'clear' }), headers: validHeaders,
  });
  assert.equal(cleared.status, 200);
  assert.equal(state.version, versionBeforeClear + 1);
  assert.deepEqual(jsonBody(cleared), { cleared: 2 });
  assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions.find((session) => session.session_id === 'hide_unknown').hidden, undefined);
});

test('離席状態は同じ置き場でサーバーを再起動しても残る', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const first = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => first.close());
  const enabled = await request(first.info.port, {
    method: 'POST', path: '/api/away', body: JSON.stringify({ enabled: true }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': first.info.uiSecret },
  });
  assert.equal(enabled.status, 200);
  const saved = jsonBody(enabled);
  assert.equal(JSON.parse(await fs.readFile(path.join(homeDir, 'away.json'), 'utf8')).since, saved.since);
  await first.close();

  const second = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => second.close());
  assert.deepEqual(jsonBody(await request(second.info.port, { path: '/api/away' })), saved);
  assert.deepEqual(jsonBody(await request(second.info.port, { path: '/api/state' })).away, saved);
});

test('壊れた離席状態は離席中ではない状態として読む', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  await fs.writeFile(path.join(homeDir, 'away.json'), '{invalid');
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());
  assert.deepEqual(jsonBody(await request(runtime.info.port, { path: '/api/away' })), { enabled: false, since: null });
});

test('画面には画面用の秘密値だけを埋め、iframe への埋め込みを拒み、/api/events は画面用の秘密値を受け付けない', async (t) => {
  const runtime = await runningServer(t);
  const page = await request(runtime.info.port, { path: '/' });
  assert.equal(page.status, 200);
  assert.ok(page.body.includes(`<meta name="cockpit-secret" content="${runtime.info.uiSecret}">`));
  assert.ok(!page.body.includes(runtime.info.secret));
  assert.equal(page.headers['x-frame-options'], 'DENY');
  assert.equal(page.headers['content-security-policy'], "frame-ancestors 'none'");
  assert.equal(page.headers['access-control-allow-origin'], undefined);

  const event = await request(runtime.info.port, {
    method: 'POST', path: '/api/events', body: JSON.stringify({}),
    headers: {
      'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret,
      origin: `http://127.0.0.1:${runtime.info.port}`,
    },
  });
  assert.equal(event.status, 403);

  const eventWithUiSecret = await request(runtime.info.port, {
    method: 'POST', path: '/api/events', body: JSON.stringify({}),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(eventWithUiSecret.status, 401);
});

test('HTML 属性値のエスケープは一般の文字列に対応する', () => {
  assert.equal(escapeHtmlAttribute(`&"'<>`), '&amp;&quot;&#39;&lt;&gt;');
});

async function runningServer(t, options = {}) {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const runtime = await startServer({
    homeDir,
    claudeHome,
    port: 0,
    ...options,
  });
  t.after(() => runtime.close());
  return runtime;
}

test('Agent 起動後の PostToolBatch はタスク催促を返し、タスク登録後は返さない', async (t) => {
  const runtime = await runningServer(t);
  const sessionId = 'task-nudge-integration';
  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret };
  const eventResponse = await request(runtime.info.port, {
    method: 'POST', path: '/api/events',
    body: JSON.stringify({
      session_id: sessionId, hook_event_name: 'PreToolUse', hookAt: Date.now(), tool_name: 'Agent',
    }),
    headers,
  });
  assert.equal(eventResponse.status, 202);

  const postToolBatch = () => request(runtime.info.port, {
    method: 'POST', path: '/api/hooks/answers',
    body: JSON.stringify({
      action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: sessionId, id: 'batch-1',
    }),
    headers,
  });
  const reminded = jsonBody(await postToolBatch());
  assert.match(reminded.hookOutput.hookSpecificOutput.additionalContext, /タスクが登録されていない/);

  const planResponse = await request(runtime.info.port, {
    method: 'POST', path: `/api/sessions/${sessionId}/plan`,
    body: JSON.stringify({ kind: 'tasks', tasks: [{ title: '検証する', state: 'doing', criteria: [] }] }),
    headers,
  });
  assert.equal(planResponse.status, 200);
  const afterTaskWrite = jsonBody(await postToolBatch());
  assert.equal(afterTaskWrite.hookOutput, null);
});

test('Host、秘密値、Origin を照合して書き込みを制限する', async (t) => {
  const runtime = await runningServer(t);
  const localhost = await request(runtime.info.port, { path: '/health', headers: { host: `localhost:${runtime.info.port}` } });
  assert.equal(localhost.status, 200);
  const invalidHost = await request(runtime.info.port, { path: '/health', headers: { host: `example.test:${runtime.info.port}` } });
  assert.equal(invalidHost.status, 400);

  const body = JSON.stringify({ session_id: 'secure', hook_event_name: 'SessionStart', hookAt: Date.now() });
  const missingSecret = await request(runtime.info.port, {
    method: 'POST', path: '/api/events', body,
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(missingSecret.status, 401);

  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path: '/api/events', body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret, origin: 'https://other.example' },
  });
  assert.equal(foreignOrigin.status, 403);

  const accepted = await request(runtime.info.port, {
    method: 'POST', path: '/api/events', body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(accepted.status, 202);

  const devDisabled = await request(runtime.info.port, { path: '/api/dev/fields' });
  assert.equal(devDisabled.status, 404);
});

test('SubagentStart のない agent_type 付きイベントから定義を読み込んで行を復元する', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const agentsDirectory = path.join(claudeHome, 'agents');
  await fs.mkdir(agentsDirectory, { recursive: true });
  await fs.writeFile(path.join(agentsDirectory, 'Explore.md'), '---\nmodel: claude-sonnet-5-5\neffort: high\n---\n');
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());

  const response = await request(runtime.info.port, {
    method: 'POST', path: '/api/events',
    body: JSON.stringify({
      session_id: 'restored-agent', hook_event_name: 'PreToolUse', hookAt: 200,
      agent_id: 'agent-1', agent_type: 'Explore', tool_name: 'Read', tool_use_id: 'read-1', summary: 'README.md',
    }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(response.status, 202);

  const state = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const [agent] = state.sessions.find((session) => session.session_id === 'restored-agent').agents;
  assert.equal(agent.model, 'claude-sonnet-5-5');
  assert.equal(agent.effort, 'high');
});

test('サブエージェント行があるイベントでは定義を読み直さず SubagentStart では読む', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const definitionPath = path.join(claudeHome, 'agents', 'Explore.md');
  await fs.mkdir(path.dirname(definitionPath), { recursive: true });
  await fs.writeFile(definitionPath, '---\nmodel: claude-sonnet-5-5\n---\n');
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());

  const originalReadFile = fs.readFile;
  let definitionReads = 0;
  fs.readFile = async function (filePath, ...args) {
    if (path.resolve(filePath) === path.resolve(definitionPath)) definitionReads += 1;
    return originalReadFile.call(fs, filePath, ...args);
  };
  try {
    const postEvent = (hook_event_name, hookAt, tool_use_id) => request(runtime.info.port, {
      method: 'POST', path: '/api/events',
      body: JSON.stringify({
        session_id: 'agent-definition-read', hook_event_name, hookAt,
        agent_id: 'agent-1', agent_type: 'Explore', tool_name: 'Read', tool_use_id,
      }),
      headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
    });

    assert.equal((await postEvent('PreToolUse', 100, 'read-1')).status, 202);
    assert.equal(definitionReads, 1);
    assert.equal((await postEvent('PreToolUse', 200, 'read-2')).status, 202);
    assert.equal(definitionReads, 1);
    assert.equal((await postEvent('SubagentStart', 300, 'read-3')).status, 202);
    assert.equal(definitionReads, 2);
  } finally {
    fs.readFile = originalReadFile;
  }
});

test('/plan は秘密値と Origin を照合し、session ID と入力上限を検査する', async (t) => {
  const runtime = await runningServer(t);
  const path = '/api/sessions/plan-session/plan';
  const body = JSON.stringify({ kind: 'tasks', tasks: [] });
  const missingSecret = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(missingSecret.status, 401);

  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path, body,
    headers: {
      'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret,
      origin: `http://127.0.0.1:${runtime.info.port}`,
    },
  });
  assert.equal(foreignOrigin.status, 403);

  const invalidSession = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/bad_session/plan', body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(invalidSession.status, 400);

  const tooManyTasks = await request(runtime.info.port, {
    method: 'POST', path, body: JSON.stringify({ kind: 'tasks', tasks: Array.from({ length: 51 }, (_, index) => ({ title: `task ${index}`, state: 'todo', criteria: [] })) }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(tooManyTasks.status, 400);
});

test('/prs は秘密値と Origin を照合し、MCP とフックから PR を登録する', async (t) => {
  const calls = { repos: [], all: 0 };
  const pullRequestTracker = {
    start() {},
    close() {},
    snapshot: () => [],
    refreshRepo(owner, repo) { calls.repos.push(`${owner}/${repo}`); return Promise.resolve(); },
    refreshAll() { calls.all += 1; return Promise.resolve(); },
  };
  const runtime = await runningServer(t, {
    pullRequestTracker,
    findSessionIdByPid: async () => null,
  });
  const body = JSON.stringify({
    kind: 'add_pr', url: 'https://github.com/example/project/pull/46',
    ppid: 123, claudeCodeSessionId: 'pr-session', cwd: process.cwd(),
  });
  const missingSecret = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/pr-session/prs', body,
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(missingSecret.status, 401);
  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/pr-session/prs', body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret, origin: 'https://other.example' },
  });
  assert.equal(foreignOrigin.status, 403);
  const added = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/pr-session/prs', body,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(added.status, 200);
  assert.deepEqual(jsonBody(added), {
    owner: 'example', repo: 'project', number: 46,
    url: 'https://github.com/example/project/pull/46',
  });
  assert.equal(runtime.state.pullRequestRegistrations()[0].number, 46);

  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret };
  await request(runtime.info.port, {
    method: 'POST', path: '/api/events', headers,
    body: JSON.stringify({
      session_id: 'pr-session', hook_event_name: 'PreToolUse', hookAt: Date.now(),
      tool_name: 'Bash', tool_use_id: 'create-47', ghPrCreateCommand: true,
    }),
  });
  await request(runtime.info.port, {
    method: 'POST', path: '/api/events', headers,
    body: JSON.stringify({
      session_id: 'pr-session', hook_event_name: 'PostToolUse', hookAt: Date.now(),
      tool_name: 'Bash', tool_use_id: 'create-47',
      pullRequest: { owner: 'example', repo: 'project', number: 47, url: 'https://github.com/example/project/pull/47' },
    }),
  });
  assert.ok(runtime.state.pullRequestRegistrations().some((record) => record.number === 47));

  await request(runtime.info.port, {
    method: 'POST', path: '/api/events', headers,
    body: JSON.stringify({
      session_id: 'pr-session', hook_event_name: 'PostToolUse', hookAt: Date.now(),
      tool_name: 'Bash', tool_use_id: 'unrelated',
      pullRequest: { owner: 'example', repo: 'project', number: 48, url: 'https://github.com/example/project/pull/48' },
    }),
  });
  assert.ok(!runtime.state.pullRequestRegistrations().some((record) => record.number === 48));

  await request(runtime.info.port, {
    method: 'POST', path: '/api/events', headers,
    body: JSON.stringify({
      session_id: 'pr-session', hook_event_name: 'PreToolUse', hookAt: Date.now(),
      tool_name: 'Bash', tool_use_id: 'push-1', refreshPullRequestsCommand: true,
    }),
  });
  await request(runtime.info.port, {
    method: 'POST', path: '/api/events', headers,
    body: JSON.stringify({
      session_id: 'pr-session', hook_event_name: 'PostToolUse', hookAt: Date.now(),
      tool_name: 'Bash', tool_use_id: 'push-1',
    }),
  });
  assert.equal(calls.all, 1);
  assert.ok(calls.repos.includes('example/project'));
  const snapshot = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.deepEqual(snapshot.pullRequests, []);
});

test('/plan はタスクと判断事項を記録し、読み取り用の要約を返す', async (t) => {
  const runtime = await runningServer(t);
  const path = '/api/sessions/plan-session/plan';
  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret };
  const tasksResponse = await request(runtime.info.port, {
    method: 'POST', path,
    body: JSON.stringify({
      kind: 'tasks',
      tasks: [{ title: 'API を追加する', state: 'doing', criteria: [{ text: '一覧に出る', met: true }] }],
    }),
    headers,
  });
  assert.equal(tasksResponse.status, 200);
  assert.deepEqual(jsonBody(tasksResponse).tasks, [{ title: 'API を追加する', state: 'doing' }]);

  const added = await request(runtime.info.port, {
    method: 'POST', path,
    body: JSON.stringify({
      kind: 'add_decision', title: '状態を選ぶ', context: '運用上の理由を記録する。', state: 'waiting',
      options: [{ label: '(推奨) waiting', description: '利用者の確認を待つ。', recommended: true }],
    }),
    headers,
  });
  assert.equal(added.status, 200);
  const decision = jsonBody(added).decision;
  assert.ok(decision.id);
  assert.deepEqual([decision.title, decision.state], ['状態を選ぶ', 'waiting']);

  const updated = await request(runtime.info.port, {
    method: 'POST', path,
    body: JSON.stringify({ kind: 'update_decision', id: decision.id, state: 'provisional', chosen: 'waiting', note: '確認後に進める。' }),
    headers,
  });
  assert.equal(updated.status, 200);
  assert.equal(jsonBody(updated).decision.state, 'provisional');

  const state = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const session = state.sessions.find((item) => item.session_id === 'plan-session');
  runtime.state.syncSessionFiles([{ session_id: 'plan-session', cwd: 'C:\\project', name: '計画中' }]);
  const stateWithSessionFile = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const visibleSession = stateWithSessionFile.sessions.find((item) => item.session_id === 'plan-session');
  assert.equal(session, undefined);
  assert.deepEqual(visibleSession.tasks, [{ title: 'API を追加する', state: 'doing', criteria: [{ text: '一覧に出る', met: true }] }]);
  assert.deepEqual(visibleSession.decisions[0].resolution, { chosen: 'waiting', note: '確認後に進める。' });
  assert.equal(visibleSession.decisions[0].answer, null);

  const context = jsonBody(await request(runtime.info.port, { path: '/api/sessions/plan-session/context' }));
  assert.deepEqual(context.tasks, [{ title: 'API を追加する', state: 'doing' }]);
  assert.deepEqual(context.decisions, [{ id: decision.id, title: '状態を選ぶ', state: 'provisional' }]);
});

test('/plan は同じ題を持つタスク一覧を拒む', async (t) => {
  const runtime = await runningServer(t);
  const response = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/duplicate-tasks/plan',
    body: JSON.stringify({
      kind: 'tasks',
      tasks: [taskForRequest('同じ題'), taskForRequest('同じ題', 'todo')],
    }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(response.status, 400);
});

function taskForRequest(title, state = 'doing') {
  return { title, state, criteria: [] };
}

test('表示設定 API は照合し、変更した項目だけを既存値へ合わせる', async (t) => {
  const runtime = await runningServer(t);
  const endpoint = '/api/display';
  const body = JSON.stringify({ mode: 'kind' });
  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const validHeaders = {
    'content-type': 'application/json',
    'x-cockpit-secret': runtime.info.uiSecret,
    origin,
  };

  assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).display, null);
  const unauthorized = await request(runtime.info.port, { method: 'POST', path: endpoint, body, headers: { 'content-type': 'application/json', origin } });
  assert.equal(unauthorized.status, 401);
  const forbidden = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body, headers: { ...validHeaders, origin: 'https://other.example' },
  });
  assert.equal(forbidden.status, 403);
  const missingOrigin = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body, headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(missingOrigin.status, 403);
  const invalid = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ mode: 'kind', display: { hidden: [] } }), headers: validHeaders,
  });
  assert.equal(invalid.status, 400);

  const mode = await request(runtime.info.port, { method: 'POST', path: endpoint, body, headers: validHeaders });
  assert.equal(mode.status, 200);
  const hidden = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ hidden: ['agents', 'prs'] }), headers: validHeaders,
  });
  assert.equal(hidden.status, 200);
  const pinned = await request(runtime.info.port, {
    method: 'POST', path: endpoint, body: JSON.stringify({ pinned: ['C:\\project'] }), headers: validHeaders,
  });
  assert.equal(pinned.status, 200);
  assert.deepEqual(jsonBody(await request(runtime.info.port, { path: '/api/state' })).display, {
    mode: 'kind', order: [], pinned: ['C:\\project'], collapsed: [], hidden: ['agents', 'prs'],
  });
});

test('画面からタスクを完了にし、終了未確認エージェントを終了にできる', async (t) => {
  const state = new DashboardState();
  const runtime = await runningServer(t, { state });
  const sessionId = 'close-actions';
  state.syncSessionFiles([{ session_id: sessionId, cwd: 'C:\\project', name: '閉じる操作' }]);
  state.setTasks(sessionId, [{ title: '完了にする', state: 'doing', criteria: [] }]);
  state.addEvent({ session_id: sessionId, hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'agent-1', agent_type: 'impl-hard' });
  state.addEvent({
    session_id: sessionId, hook_event_name: 'PreToolUse', hookAt: 2, agent_id: 'agent-1',
    tool_name: 'Bash', tool_use_id: 'bash-1', summary: 'bash ~/.claude/tools/codex-agent.sh impl-hard < prompt.md',
  });
  state.addEvent({ session_id: sessionId, hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'agent-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
  state.addEvent({ session_id: sessionId, hook_event_name: 'SubagentStop', hookAt: 4, agent_id: 'agent-1' });

  const origin = `http://127.0.0.1:${runtime.info.port}`;
  const headers = { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret, origin };
  const taskBody = JSON.stringify({ session_id: sessionId, title: '完了にする' });
  const missingOrigin = await request(runtime.info.port, {
    method: 'POST', path: '/api/closed-tasks', body: taskBody,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.uiSecret },
  });
  assert.equal(missingOrigin.status, 403);
  const missingSecret = await request(runtime.info.port, { method: 'POST', path: '/api/closed-tasks', body: taskBody, headers: { 'content-type': 'application/json', origin } });
  assert.equal(missingSecret.status, 401);
  const foreignOrigin = await request(runtime.info.port, {
    method: 'POST', path: '/api/closed-tasks', body: taskBody, headers: { ...headers, origin: 'https://other.example' },
  });
  assert.equal(foreignOrigin.status, 403);
  const closedTask = await request(runtime.info.port, { method: 'POST', path: '/api/closed-tasks', body: taskBody, headers });
  assert.equal(closedTask.status, 200);
  assert.equal(state.snapshot().sessions[0].tasks[0].state, 'done');
  assert.equal(state.snapshot().sessions[0].tasks[0].closedByUser, true);

  const closeAgent = await request(runtime.info.port, {
    method: 'POST', path: '/api/closed-agents',
    body: JSON.stringify({ session_id: sessionId, agent_id: 'agent-1' }), headers,
  });
  assert.equal(closeAgent.status, 200);
  assert.equal(state.snapshot().sessions[0].agents[0].unconfirmed, false);
  state.addEvent({ session_id: sessionId, hook_event_name: 'SubagentStart', hookAt: 5, agent_id: 'agent-1', agent_type: 'impl-hard' });
  assert.equal(state.closedAgents.has(sessionId), false);
  assert.equal(state.snapshot().sessions[0].agents[0].active, true);
});

test('/plan は ppid に一致するセッションファイルの ID を優先する', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const sessionDirectory = path.join(claudeHome, 'sessions');
  await fs.mkdir(sessionDirectory, { recursive: true });
  await fs.writeFile(path.join(sessionDirectory, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: 'pid-session', name: 'PID から解決したセッション',
  }));
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());
  const response = await request(runtime.info.port, {
    method: 'POST', path: '/api/sessions/fallback-session/plan',
    body: JSON.stringify({
      kind: 'tasks', tasks: [{ title: 'PID のセッションに保存', state: 'todo', criteria: [] }],
      ppid: process.pid, claudeCodeSessionId: 'fallback-session',
    }),
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  assert.equal(response.status, 200);
  const state = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const pidSession = state.sessions.find((session) => session.session_id === 'pid-session');
  assert.deepEqual(pidSession.tasks.map(({ title }) => title), ['PID のセッションに保存']);
  assert.ok(!state.sessions.some((session) => session.session_id === 'fallback-session'));
});

test('64 KB を超える本文を拒否する', async (t) => {
  const runtime = await runningServer(t);
  const response = await request(runtime.info.port, {
    method: 'POST', path: '/api/events',
    body: 'x'.repeat(MAX_BODY_BYTES + 1),
    headers: {
      'content-type': 'application/json',
      'x-cockpit-secret': runtime.info.secret,
    },
  });
  assert.equal(response.status, 413);
});

test('server.json は待ち受け成功後にだけ書く', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  let listeningResolve;
  const listening = new Promise((resolve) => { listeningResolve = resolve; });
  let releaseWrite;
  const writeGate = new Promise((resolve) => { releaseWrite = resolve; });
  const starting = startServer({
    homeDir,
    claudeHome,
    port: 0,
    afterListen: async (server) => {
      assert.equal(server.listening, true);
      await assert.rejects(fs.access(path.join(homeDir, 'server.json')));
      listeningResolve();
      await writeGate;
    },
  });
  await listening;
  releaseWrite();
  const runtime = await starting;
  t.after(() => runtime.close());
  assert.equal(JSON.parse(await fs.readFile(path.join(homeDir, 'server.json'), 'utf8')).port, runtime.info.port);
});

test('EADDRINUSE で負けた同時起動は server.json に触れない', async (t) => {
  const runtime = await runningServer(t);
  const serverInfoPath = path.join(runtime.homeDir, 'server.json');
  const before = await fs.readFile(serverInfoPath, 'utf8');
  const losingServer = new EventEmitter();
  losingServer.listening = false;
  losingServer.listen = () => {
    queueMicrotask(() => losingServer.emit('error', Object.assign(new Error('address already in use'), { code: 'EADDRINUSE' })));
  };
  losingServer.close = (callback) => callback?.();

  await assert.rejects(
    startServer({ homeDir: runtime.homeDir, claudeHome: path.join(runtime.homeDir, '.claude'), port: 0, server: losingServer }),
    (error) => error.code === 'EADDRINUSE',
  );
  assert.equal(await fs.readFile(serverInfoPath, 'utf8'), before);
});

test('開発用フィールド口は --dev のときだけ使える', async (t) => {
  const runtime = await runningServer(t, { dev: true });
  const event = JSON.stringify({
    session_id: 'dev-session', hook_event_name: 'Notification', cwd: 'D:\\repo',
    notification_type: 'permission_prompt', message: '許可待ち', secret_input: 'must-not-be-recorded',
    input_fields: ['session_id', 'hook_event_name', 'notification_type', 'message'],
  });
  await request(runtime.info.port, {
    method: 'POST', path: '/api/events', body: event,
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': runtime.info.secret },
  });
  const fields = jsonBody(await request(runtime.info.port, { path: '/api/dev/fields' }));
  assert.ok(fields.fields.includes('Notification.notification_type'));
  assert.deepEqual(fields.notificationTypes, ['permission_prompt']);
  assert.ok(!JSON.stringify(fields).includes('must-not-be-recorded'));
});

test('SessionStart はタイトルを読み、ダッシュボードの URL を返す', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const sessionId = 'session-title';
  const sessionDirectory = path.join(claudeHome, 'sessions');
  await fs.mkdir(sessionDirectory, { recursive: true });
  await fs.writeFile(path.join(sessionDirectory, `${process.pid}.json`), JSON.stringify({ pid: process.pid, sessionId, name: '段階 1 の実装' }));
  await fs.writeFile(path.join(sessionDirectory, `${sessionId}.key`), 'not a session record');
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());

  const result = await runHook({
    session_id: sessionId,
    hook_event_name: 'SessionStart',
    cwd: 'D:\\Desktop\\Develop\\agent-cockpit\\.claude\\worktrees\\stage1',
  }, { homeDir, environment: { AGENT_COCKPIT_HOME: homeDir } });

  assert.equal(result.exitCode, 0);
  assert.equal(result.additionalContext, `Agent Cockpit: http://127.0.0.1:${runtime.info.port}/`);
  const state = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.equal(state.sessions[0].title, '段階 1 の実装');
  // cwd が実在するリポジトリの下を指すので、ブランチ名は実行する場所で変わる。比べる対象から外す。
  const { branch: _branch, ...product } = state.sessions[0].product;
  assert.deepEqual(product, { key: 'd:\\desktop\\develop\\agent-cockpit', name: 'agent-cockpit' });
});

test('起動時に、フックがまだ届いていない生きているセッションを一覧に出す', async (t) => {
  const { homeDir, claudeHome } = await temporaryHome(t);
  const sessionDirectory = path.join(claudeHome, 'sessions');
  await fs.mkdir(sessionDirectory, { recursive: true });
  await fs.writeFile(path.join(sessionDirectory, `${process.pid}.json`), JSON.stringify({
    pid: process.pid, sessionId: 'waiting-session', name: '待機しているセッション', cwd: 'D:\\work\\repo',
  }));
  const runtime = await startServer({ homeDir, claudeHome, port: 0 });
  t.after(() => runtime.close());
  const state = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.deepEqual(
    state.sessions.map((session) => [session.session_id, session.title, session.status, session.product.name]),
    [['waiting-session', '待機しているセッション', '不明', 'repo']],
  );
});

test('離席状態の切り替えを続けて呼ぶと、呼んだ順に保存される', async (t) => {
  const { homeDir } = await temporaryHome(t);
  const { AwayState } = require('../src/server/state');
  const away = await AwayState.load(homeDir);
  const results = await Promise.all([away.setEnabled(true), away.setEnabled(false), away.setEnabled(true)]);
  assert.deepEqual(results.map((value) => value.enabled), [true, false, true]);
  assert.equal(away.snapshot().enabled, true);
  assert.equal(JSON.parse(await fs.readFile(path.join(homeDir, 'away.json'), 'utf8')).enabled, true);
});
