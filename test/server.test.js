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
      response.on('end', () => resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
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
  await fs.writeFile(path.join(sessionDirectory, `${sessionId}.json`), JSON.stringify({ name: '段階 1 の実装' }));
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
