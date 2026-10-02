const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { runHook } = require('../src/hooks/event');
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
  assert.deepEqual(session.tasks, [{ title: 'API を追加する', state: 'doing', criteria: [{ text: '一覧に出る', met: true }] }]);
  assert.deepEqual(session.decisions[0].resolution, { chosen: 'waiting', note: '確認後に進める。' });
  assert.equal(session.decisions[0].answer, null);

  const context = jsonBody(await request(runtime.info.port, { path: '/api/sessions/plan-session/context' }));
  assert.deepEqual(context.tasks, [{ title: 'API を追加する', state: 'doing' }]);
  assert.deepEqual(context.decisions, [{ id: decision.id, title: '状態を選ぶ', state: 'provisional' }]);
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
  assert.deepEqual(state.sessions[0].product, { key: 'd:\\desktop\\develop\\agent-cockpit', name: 'agent-cockpit' });
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
