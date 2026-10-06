'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  createCodexManagedProcessManager,
  makeRemoteCliArguments,
} = require('../src/server/codex-managed-process');

const THREAD_ID = '00000000-0000-4000-8000-000000000170';

test('managed process isolates its HOME, exposes a secret-free snapshot, and stops only owned children', async (t) => {
  const fixture = createProcessFixture(t);
  const manager = fixture.createManager();
  const started = await manager.start();
  assert.equal(started.endpoint.startsWith('ws://127.0.0.1:'), true);
  assert.equal(started.managedHomePath, fixture.managedHomePath);
  assert.equal(started.homeScopeId, 'managed-home-test');
  assert.equal(started.state, 'running');

  const serverCall = fixture.calls[0];
  assert.deepEqual(serverCall.args.slice(0, 4), ['app-server', '--listen', started.endpoint, '--ws-auth']);
  assert.deepEqual(serverCall.args.slice(4, 6), ['capability-token', '--ws-token-sha256']);
  assert.match(serverCall.args[6], /^[0-9a-f]{64}$/);
  assert.equal(serverCall.options.env.CODEX_HOME, fixture.managedHomePath);
  assert.equal(serverCall.options.env.HOME, fixture.managedHomePath);
  assert.equal(serverCall.options.env.USERPROFILE, fixture.managedHomePath);
  assert.equal(serverCall.options.env.APPDATA.startsWith(fixture.managedHomePath), true);
  assert.equal(Object.hasOwn(serverCall.options.env, 'GITHUB_TOKEN'), false);

  let disconnectCount = 0;
  const transport = await manager.connect({
    onNotification() {},
    onServerRequest() {},
    onDisconnect() { disconnectCount += 1; },
  });
  assert.equal(fixture.transportOptions.capabilityToken.length, 64);
  assert.equal(serverCall.args.includes(fixture.transportOptions.capabilityToken), false);
  assert.equal(JSON.stringify(manager.snapshot()).includes(fixture.transportOptions.capabilityToken), false);
  assert.equal(JSON.stringify(manager.snapshot()).includes(serverCall.args[6]), false);

  await assert.rejects(manager.launchRemoteCLI({ threadId: 'not-loaded' }), (error) => error.code === 'thread_not_loaded');
  assert.equal(fixture.calls.length, 1);
  const remoteClient = await manager.launchRemoteCLI({ threadId: THREAD_ID });
  assert.deepEqual(fixture.calls[1].args, [
    'resume', THREAD_ID,
    '--remote', started.endpoint,
    '--remote-auth-token-env', fixture.calls[1].args[fixture.calls[1].args.indexOf('--remote-auth-token-env') + 1],
    '--no-alt-screen',
  ]);
  assert.equal(fixture.calls[1].args.includes('--sandbox'), false);
  assert.equal(fixture.calls[1].args.includes('--ask-for-approval'), false);
  const tokenVariable = fixture.calls[1].args[fixture.calls[1].args.indexOf('--remote-auth-token-env') + 1];
  assert.match(tokenVariable, /^CODEX_REMOTE_AUTH_TOKEN_[0-9A-F]{12}$/);
  assert.equal(fixture.calls[1].options.env[tokenVariable], fixture.transportOptions.capabilityToken);
  assert.equal(fixture.calls[1].args.includes(fixture.transportOptions.capabilityToken), false);
  assert.deepEqual(await remoteClient.snapshot(), { state: 'running' });
  assert.equal(fixture.transportInstances[1].closed, true);
  assert.equal(fixture.transportInstances[2].closed, true);
  assert.deepEqual(fixture.transportInstances[1].operations, [
    'request:initialize', 'notify:initialized', 'confirm:not-loaded',
  ]);
  assert.deepEqual(fixture.transportInstances[2].operations, [
    'request:initialize', 'notify:initialized', 'confirm:loaded',
  ]);

  await manager.stop();
  assert.equal(transport.closed, true);
  assert.equal(disconnectCount, 1);
  assert.deepEqual(fixture.calls.map((call) => call.child.killSignals), [['SIGTERM'], ['SIGTERM']]);
  assert.equal(fixture.normalConfigContents(), 'ordinary-home-configuration');
  assert.equal(fixture.managedConfigContents(), 'managed-home-configuration');
  assert.equal(manager.snapshot().state, 'stopped');
  assert.equal(JSON.stringify(manager.snapshot()).includes(fixture.transportOptions.capabilityToken), false);
});

test('managed process rejects a HOME outside its explicit root and rejects symlink traversal', async (t) => {
  const fixture = createProcessFixture(t);
  assert.throws(
    () => fixture.createManager({ managedHomePath: path.join(fixture.tempRoot, 'outside') }),
    (error) => error.code === 'managed_home_outside_root',
  );

  const external = path.join(fixture.tempRoot, 'external');
  fs.mkdirSync(external);
  const link = path.join(fixture.managedHomeRoot, 'redirect');
  fs.symlinkSync(external, link, process.platform === 'win32' ? 'junction' : 'dir');
  const manager = fixture.createManager({ managedHomePath: path.join(link, 'codex') });
  await assert.rejects(manager.start(), (error) => error.code === 'managed_home_symlink');
  assert.equal(fs.existsSync(path.join(external, 'codex')), false);
  assert.equal(manager.snapshot().state, 'failed');
});

test('managed process refuses to reuse the ordinary Codex HOME', (t) => {
  const fixture = createProcessFixture(t);
  assert.throws(
    () => fixture.createManager({
      managedHomeRoot: path.dirname(fixture.normalCodexHome),
      managedHomePath: fixture.normalCodexHome,
    }),
    (error) => error.code === 'ordinary_codex_home_forbidden',
  );
});

test('managed process retries transient connection startup without reporting a disconnect before connect', async (t) => {
  const fixture = createProcessFixture(t);
  let attempts = 0;
  let disconnectCount = 0;
  const manager = fixture.createManager({
    transportFactory: async (options) => {
      attempts += 1;
      if (attempts === 1) throw Object.assign(new Error('private failure text'), { code: 'connection_failed' });
      return {
        snapshot: () => ({ state: 'open' }),
        close() { options.onDisconnect({ code: 'closed' }); },
      };
    },
  });
  await manager.start();
  const transport = await manager.connect({
    onNotification() {},
    onServerRequest() {},
    onDisconnect() { disconnectCount += 1; },
  });
  assert.equal(attempts, 2);
  assert.equal(disconnectCount, 0);
  transport.close();
  assert.equal(disconnectCount, 1);
  await manager.stop();
});

test('stop invalidates remote CLI launch while loaded-thread preflight is pending', async (t) => {
  const fixture = createProcessFixture(t);
  let markLoadedCheckStarted;
  const loadedCheckStarted = new Promise((resolve) => { markLoadedCheckStarted = resolve; });
  let resolveLoadedCheck;
  const loadedCheck = new Promise((resolve) => { resolveLoadedCheck = resolve; });
  let closeCount = 0;
  let closed = false;
  const manager = fixture.createManager({
    transportFactory: async (options) => ({
      request: async (method) => {
        assert.equal(method, 'initialize');
        return { codexHome: fixture.managedHomePath, userAgent: 'codex_cli/0.160.1' };
      },
      notify: async (method) => assert.equal(method, 'initialized'),
      confirmLoadedThread: async (threadId) => {
        assert.equal(threadId, THREAD_ID);
        markLoadedCheckStarted();
        return loadedCheck;
      },
      close() {
        if (closed) return;
        closed = true;
        closeCount += 1;
        options.onDisconnect({ code: 'closed' });
      },
    }),
  });
  await manager.start();

  const launch = manager.launchRemoteCLI({ threadId: THREAD_ID });
  await loadedCheckStarted;
  await manager.stop();
  assert.equal(manager.snapshot().state, 'stopped');
  resolveLoadedCheck(true);
  await assert.rejects(launch, (error) => error.code === 'server_not_running');

  assert.equal(fixture.calls.length, 1);
  assert.equal(closeCount, 1);
  assert.equal(fixture.calls[0].args[0], 'app-server');
});

test('stop closes a transport that finishes connecting after shutdown', async (t) => {
  const fixture = createProcessFixture(t);
  let markFactoryStarted;
  const factoryStarted = new Promise((resolve) => { markFactoryStarted = resolve; });
  let resolveTransport;
  const pendingTransport = new Promise((resolve) => { resolveTransport = resolve; });
  const manager = fixture.createManager({
    transportFactory: () => {
      markFactoryStarted();
      return pendingTransport;
    },
  });
  await manager.start();

  let disconnectCount = 0;
  const connecting = manager.connect({
    onNotification() {},
    onServerRequest() {},
    onDisconnect() { disconnectCount += 1; },
  });
  await factoryStarted;
  await manager.stop();
  assert.equal(manager.snapshot().state, 'stopped');

  let closed = false;
  let closeCount = 0;
  resolveTransport({
    snapshot: () => ({ state: closed ? 'closed' : 'open' }),
    close() {
      if (closed) return;
      closed = true;
      closeCount += 1;
    },
  });
  await assert.rejects(connecting, (error) => error.code === 'server_not_running');
  assert.equal(closed, true);
  assert.equal(closeCount, 1);
  assert.equal(disconnectCount, 0);
  assert.equal(fixture.calls.length, 1);
});

test('remote resume arguments contain no settings overrides', () => {
  const args = makeRemoteCliArguments(THREAD_ID, 'ws://127.0.0.1:12345', 'CODEX_REMOTE_AUTH_TOKEN_1234567890AB');
  assert.deepEqual(args, [
    'resume', THREAD_ID,
    '--remote', 'ws://127.0.0.1:12345',
    '--remote-auth-token-env', 'CODEX_REMOTE_AUTH_TOKEN_1234567890AB',
    '--no-alt-screen',
  ]);
  assert.equal(args.some((argument) => ['--sandbox', '--ask-for-approval', '-m', '--model', '--cd'].includes(argument)), false);
});

function createProcessFixture(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-managed-process-test-'));
  const managedHomeRoot = path.join(tempRoot, 'isolated');
  const managedHomePath = path.join(managedHomeRoot, 'codex-home');
  const normalCodexHome = path.join(tempRoot, 'ordinary', '.codex');
  const executablePath = path.join(tempRoot, 'codex.exe');
  fs.mkdirSync(managedHomeRoot);
  fs.mkdirSync(normalCodexHome, { recursive: true });
  fs.mkdirSync(managedHomePath);
  fs.writeFileSync(executablePath, 'fixture executable');
  fs.writeFileSync(path.join(managedHomePath, 'config.toml'), 'managed-home-configuration');
  fs.writeFileSync(path.join(normalCodexHome, 'config.toml'), 'ordinary-home-configuration');
  const calls = [];
  let transportOptions = null;
  const transportInstances = [];
  const spawnImpl = (executable, args, spawnOptions) => {
    const child = new EventEmitter();
    child.pid = calls.length + 100;
    child.exitCode = null;
    child.signalCode = null;
    child.killSignals = [];
    child.kill = (signal) => {
      child.killSignals.push(signal);
      queueMicrotask(() => {
        child.signalCode = signal;
        child.emit('exit', null, signal);
        child.emit('close', null, signal);
      });
      return true;
    };
    const captured = {
      executable,
      args: [...args],
      options: { ...spawnOptions, env: { ...spawnOptions.env } },
      child,
    };
    calls.push(captured);
    queueMicrotask(() => child.emit('spawn'));
    return child;
  };
  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));
  return {
    tempRoot,
    managedHomeRoot,
    managedHomePath,
    normalCodexHome,
    executablePath,
    calls,
    get transportOptions() { return transportOptions; },
    transportInstances,
    createManager(overrides = {}) {
      const selectedManagedHomeRoot = overrides.managedHomeRoot || managedHomeRoot;
      const selectedManagedHomePath = overrides.managedHomePath || managedHomePath;
      return createCodexManagedProcessManager({
        executablePath,
        managedHomeRoot: selectedManagedHomeRoot,
        managedHomePath: selectedManagedHomePath,
        hostId: 'local-host',
        homeScopeId: 'managed-home-test',
        environment: {
          PATH: 'C:\\Windows\\System32',
          CODEX_HOME: normalCodexHome,
          HOME: tempRoot,
          USERPROFILE: tempRoot,
          GITHUB_TOKEN: 'must-not-be-inherited',
        },
        startTimeoutMs: 500,
        stopTimeoutMs: 100,
        spawnImpl,
        choosePortImpl: async () => 43210,
        transportFactory: overrides.transportFactory || (async (options) => {
          transportOptions = options;
          let closed = false;
          const operations = [];
          const instance = {
            snapshot: () => ({ state: closed ? 'closed' : 'open' }),
            request: async (method) => {
              operations.push(`request:${method}`);
              assert.equal(method, 'initialize');
              return { codexHome: selectedManagedHomePath, userAgent: 'codex_cli/0.160.1' };
            },
            notify: async (method) => {
              operations.push(`notify:${method}`);
              assert.equal(method, 'initialized');
            },
            confirmLoadedThread: async (threadId) => {
              operations.push(threadId === THREAD_ID ? 'confirm:loaded' : 'confirm:not-loaded');
              return threadId === THREAD_ID;
            },
            close() {
              if (closed) return;
              closed = true;
              options.onDisconnect({ code: 'closed' });
            },
            get closed() { return closed; },
            operations,
          };
          transportInstances.push(instance);
          return instance;
        }),
      });
    },
    normalConfigContents() { return fs.readFileSync(path.join(normalCodexHome, 'config.toml'), 'utf8'); },
    managedConfigContents() { return fs.readFileSync(path.join(managedHomePath, 'config.toml'), 'utf8'); },
  };
}
