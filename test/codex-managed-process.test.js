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
const TRANSPORT_ENVIRONMENT_KEYS = Object.freeze([
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
]);
const FORBIDDEN_INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  'ALL_PROXY', 'SSL_CERT_DIR', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'GH_TOKEN', 'GITHUB_TOKEN', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CUSTOM_ENDPOINT',
]);

test('managed process isolates its HOME, exposes a secret-free snapshot, and stops only owned children', async (t) => {
  const fixture = createProcessFixture(t);
  const manager = fixture.createManager();
  const started = await manager.start();
  assert.equal(started.endpoint.startsWith('ws://127.0.0.1:'), true);
  assert.equal(started.managedHomePath, fixture.managedHomePath);
  assert.equal(started.homeScopeId, 'managed-home-test');
  assert.equal(started.state, 'running');

  const serverCall = fixture.calls[0];
  assert.equal(serverCall.executable, fixture.executablePath);
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
  assert.equal(fixture.transportOptions.timeoutMs, undefined);
  assert.equal(fixture.transportOptions.handshakeTimeoutMs, 1000);
  assert.equal(fixture.transportOptions.requestTimeoutMs, undefined);
  assert.equal(fixture.transportOptions.capabilityToken.length, 64);
  assert.equal(serverCall.args.includes(fixture.transportOptions.capabilityToken), false);
  assert.equal(JSON.stringify(manager.snapshot()).includes(fixture.transportOptions.capabilityToken), false);
  assert.equal(JSON.stringify(manager.snapshot()).includes(serverCall.args[6]), false);

  await assert.rejects(manager.launchRemoteCLI({ threadId: 'not-loaded' }), (error) => error.code === 'thread_not_loaded');
  assert.equal(fixture.calls.length, 1);
  const remoteClient = await manager.launchRemoteCLI({ threadId: THREAD_ID });
  assert.equal(fixture.calls[1].executable, fixture.executablePath);
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

test('Windows managed launches reject non-EXE paths before changing HOME or spawning children', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows executable suffix contract');

  const fixture = createProcessFixture(t);
  for (const fileName of ['codex.cmd', 'codex.bat', 'codex']) {
    const executablePath = path.join(fixture.tempRoot, fileName);
    fs.writeFileSync(executablePath, 'fixture executable');
    assert.throws(
      () => fixture.createManager({ executablePath }),
      (error) => error.code === 'executable_format_unsupported' && !error.message.includes(executablePath),
    );
    assert.equal(fixture.calls.length, 0);
    assert.deepEqual(fs.readdirSync(fixture.managedHomePath), ['config.toml']);
    assert.equal(fixture.managedConfigContents(), 'managed-home-configuration');
  }

  const relativeExecutablePath = 'codex.cmd';
  assert.throws(
    () => fixture.createManager({ executablePath: relativeExecutablePath }),
    (error) => error.code === 'absolute_executable_path_required',
  );
  const missingExecutablePath = path.join(fixture.tempRoot, 'missing.cmd');
  assert.throws(
    () => fixture.createManager({ executablePath: missingExecutablePath }),
    (error) => error.code === 'executable_unavailable' && !error.message.includes(missingExecutablePath),
  );
});

test('Windows managed executable symlinks keep the invalid-file diagnostic ahead of suffix validation', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows executable suffix contract');

  const fixture = createProcessFixture(t);
  const symlinkPath = path.join(fixture.tempRoot, 'linked.cmd');
  try {
    fs.symlinkSync(fixture.executablePath, symlinkPath, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) return t.skip('Windows symlink privilege unavailable');
    throw error;
  }
  assert.throws(
    () => fixture.createManager({ executablePath: symlinkPath }),
    (error) => error.code === 'invalid_executable',
  );
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(fs.readdirSync(fixture.managedHomePath), ['config.toml']);
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

test('managed process separates the retry handshake deadline from the request deadline', async (t) => {
  const fixture = createProcessFixture(t);
  const receivedOptions = [];
  const manager = fixture.createManager({
    transportTimeoutMs: 800,
    requestTimeoutMs: 2300,
    transportFactory: async (options) => {
      receivedOptions.push(options);
      return {
        request: async () => ({ codexHome: fixture.managedHomePath, userAgent: 'codex_cli/0.160.1' }),
        notify: async () => {},
        confirmLoadedThread: async () => true,
        close() {},
        snapshot: () => ({ state: 'open' }),
      };
    },
  });
  await manager.start();
  await manager.connect({ onNotification() {}, onServerRequest() {}, onDisconnect() {} });
  assert.equal(receivedOptions[0].timeoutMs, 800);
  assert.equal(receivedOptions[0].handshakeTimeoutMs, 800);
  assert.equal(receivedOptions[0].requestTimeoutMs, 2300);

  await manager.launchRemoteCLI({ threadId: THREAD_ID });
  assert.equal(receivedOptions[1].timeoutMs, 800);
  assert.equal(receivedOptions[1].handshakeTimeoutMs, undefined);
  assert.equal(receivedOptions[1].requestTimeoutMs, 2300);
  await manager.stop();
});

test('managed process validates explicit transport and request deadlines', (t) => {
  const fixture = createProcessFixture(t);
  assert.throws(
    () => fixture.createManager({ transportTimeoutMs: 49 }),
    (error) => error.code === 'invalid_transport_timeout',
  );
  assert.throws(
    () => fixture.createManager({ requestTimeoutMs: 60_001 }),
    (error) => error.code === 'invalid_request_timeout',
  );
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

test('managed app-server and remote CLI receive current transport values and clear each spawn environment', async (t) => {
  const fixture = createProcessFixture(t);
  let values = makeTransportValues();
  const lookupCounts = Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, 0]));
  const sourceEnvironment = makeManagedEnvironment(fixture, () => values, lookupCounts);
  const sourceDescriptors = Object.getOwnPropertyDescriptors(sourceEnvironment);
  const manager = fixture.createManager({ environment: sourceEnvironment });

  const started = await manager.start();
  const serverCall = fixture.calls[0];
  assert.deepEqual(readTransportValues(serverCall.options.env), values);
  assert.deepEqual(serverCall.args.slice(0, 4), ['app-server', '--listen', started.endpoint, '--ws-auth']);
  assert.deepEqual(serverCall.args.slice(4, 6), ['capability-token', '--ws-token-sha256']);
  assert.equal(serverCall.options.env.HOME, fixture.managedHomePath);
  assert.equal(serverCall.options.env.CODEX_HOME, fixture.managedHomePath);
  assert.equal(serverCall.options.shell, false);
  assert.deepEqual(serverCall.options.stdio, ['ignore', 'ignore', 'ignore']);
  assertForbiddenEnvironmentAbsent(serverCall.options.env);
  assertEnvironmentCleared(fixture.environmentReferences[0]);
  assert.deepEqual(lookupCounts, Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, 1])));
  assert.deepEqual(Object.getOwnPropertyDescriptors(sourceEnvironment), sourceDescriptors);

  const firstRemote = await manager.launchRemoteCLI({ threadId: THREAD_ID });
  const firstRemoteCall = fixture.calls[1];
  assert.deepEqual(readTransportValues(firstRemoteCall.options.env), values);
  const tokenVariable = firstRemoteCall.args[firstRemoteCall.args.indexOf('--remote-auth-token-env') + 1];
  assert.deepEqual(firstRemoteCall.args, [
    'resume', THREAD_ID, '--remote', started.endpoint, '--remote-auth-token-env', tokenVariable, '--no-alt-screen',
  ]);
  assert.equal(firstRemoteCall.options.env.CODEX_HOME, fixture.managedHomePath);
  assert.equal(firstRemoteCall.options.env[tokenVariable], fixture.transportOptions.capabilityToken);
  assert.equal(firstRemoteCall.options.shell, false);
  assert.equal(firstRemoteCall.options.stdio, 'inherit');
  assertForbiddenEnvironmentAbsent(firstRemoteCall.options.env);
  assertEnvironmentCleared(fixture.environmentReferences[1]);
  assert.deepEqual(lookupCounts, Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, 2])));

  const previousHttpsProxy = values.HTTPS_PROXY;
  values = { ...values, HTTPS_PROXY: 'http://fixture:next-CREDENTIAL-SENTINEL@proxy.invalid:9443' };
  const secondRemote = await manager.launchRemoteCLI({ threadId: THREAD_ID });
  const secondRemoteCall = fixture.calls[2];
  assert.equal(firstRemoteCall.options.env.HTTPS_PROXY, previousHttpsProxy);
  assert.equal(secondRemoteCall.options.env.HTTPS_PROXY, values.HTTPS_PROXY);
  assert.deepEqual(readTransportValues(secondRemoteCall.options.env), values);
  assertEnvironmentCleared(fixture.environmentReferences[2]);
  assert.deepEqual(lookupCounts, Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, 3])));
  assert.deepEqual(Object.getOwnPropertyDescriptors(sourceEnvironment), sourceDescriptors);
  assert.equal(JSON.stringify(manager.snapshot()).includes('CREDENTIAL-SENTINEL'), false);
  assert.equal(JSON.stringify(firstRemoteCall.args).includes('CREDENTIAL-SENTINEL'), false);
  assert.equal(JSON.stringify(secondRemoteCall.args).includes('CREDENTIAL-SENTINEL'), false);
  assert.equal(started.state, 'running');
  assert.deepEqual(await firstRemote.snapshot(), { state: 'running' });

  await manager.stop();
});

test('managed process rejects invalid transport values before spawning', async (t) => {
  const invalidValues = [
    { key: 'HTTP_PROXY', value: 17 },
    { key: 'HTTPS_PROXY', value: 'http://fixture.invalid\u0000/path' },
    { key: 'NO_PROXY', value: 'fixture.invalid\rmore' },
    { key: 'NODE_EXTRA_CA_CERTS', value: `${makeTransportValues().NODE_EXTRA_CA_CERTS}\n` },
    { key: 'SSL_CERT_FILE', value: process.platform === 'win32' ? 'C:relative-ca.pem' : 'relative-ca.pem' },
    ...(process.platform === 'win32' ? [
      { key: 'SSL_CERT_FILE', value: '\\rooted-without-drive.pem' },
    ] : []),
  ];

  for (const invalid of invalidValues) {
    const fixture = createProcessFixture(t);
    const values = { ...makeTransportValues(), [invalid.key]: invalid.value };
    const sourceEnvironment = makeManagedEnvironment(fixture, values);
    const sourceDescriptors = Object.getOwnPropertyDescriptors(sourceEnvironment);
    const manager = fixture.createManager({ environment: sourceEnvironment });

    await assert.rejects(manager.start(), (error) => {
      assert.equal(error.code, 'invalid_transport_environment');
      assert.equal(error.cause, undefined);
      assert.equal(error.message.includes('CREDENTIAL-SENTINEL'), false);
      assert.equal(error.message.includes(String(invalid.value)), false);
      return true;
    });
    assert.equal(fixture.calls.length, 0);
    assert.equal(manager.snapshot().failureCode, 'invalid_transport_environment');
    assert.deepEqual(Object.getOwnPropertyDescriptors(sourceEnvironment), sourceDescriptors);
    await manager.stop();
  }
});

test('managed transport lookup errors are replaced with a fixed diagnostic', async (t) => {
  const fixture = createProcessFixture(t);
  const sourceEnvironment = makeManagedEnvironment(fixture, makeTransportValues());
  const secretFailure = 'fixture-private-proxy-CREDENTIAL-SENTINEL';
  let lookupCount = 0;
  Object.defineProperty(sourceEnvironment, 'HTTPS_PROXY', {
    configurable: true,
    enumerable: true,
    get() {
      lookupCount += 1;
      throw new Error(secretFailure);
    },
  });
  const descriptor = Object.getOwnPropertyDescriptor(sourceEnvironment, 'HTTPS_PROXY');
  const manager = fixture.createManager({ environment: sourceEnvironment });

  await assert.rejects(manager.start(), (error) => {
    assert.equal(error.code, 'invalid_transport_environment');
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes(secretFailure), false);
    assert.equal(error.stack.includes(secretFailure), false);
    return true;
  });
  assert.equal(lookupCount, 1);
  assert.equal(fixture.calls.length, 0);
  assert.deepEqual(Object.getOwnPropertyDescriptor(sourceEnvironment, 'HTTPS_PROXY'), descriptor);
  await manager.stop();
});

test('managed process omits unset and empty transport values and ignores lowercase names', async (t) => {
  const fixture = createProcessFixture(t);
  const counts = Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, 0]));
  const sourceEnvironment = makeManagedEnvironment(fixture, {
    HTTPS_PROXY: '',
    HTTP_PROXY: undefined,
    NO_PROXY: undefined,
    SSL_CERT_FILE: '',
    NODE_EXTRA_CA_CERTS: undefined,
  }, counts);
  sourceEnvironment.https_proxy = 'http://lowercase.invalid:8080';
  sourceEnvironment.ssl_cert_file = '/lowercase/ca.pem';
  const descriptors = Object.getOwnPropertyDescriptors(sourceEnvironment);
  const manager = fixture.createManager({ environment: sourceEnvironment });

  await manager.start();
  const childEnvironment = fixture.calls[0].options.env;
  for (const key of TRANSPORT_ENVIRONMENT_KEYS) assert.equal(Object.hasOwn(childEnvironment, key), false);
  assertForbiddenEnvironmentAbsent(childEnvironment);
  assertEnvironmentCleared(fixture.environmentReferences[0]);
  assert.deepEqual(counts, Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, 1])));
  assert.deepEqual(Object.getOwnPropertyDescriptors(sourceEnvironment), descriptors);
  await manager.stop();
});

test('managed app-server and remote CLI clear the environment after synchronous spawn errors', async (t) => {
  const failedServerFixture = createProcessFixture(t);
  const serverSource = makeManagedEnvironment(failedServerFixture, makeTransportValues());
  const serverEnvironmentReferences = [];
  const serverManager = failedServerFixture.createManager({
    environment: serverSource,
    spawnImpl(_executable, _args, options) {
      serverEnvironmentReferences.push(options.env);
      throw new Error('fixture-CREDENTIAL-SENTINEL');
    },
  });

  await assert.rejects(serverManager.start(), (error) =>
    error.code === 'server_spawn_failed' && !error.message.includes('CREDENTIAL-SENTINEL') && error.cause === undefined);
  assert.equal(failedServerFixture.calls.length, 0);
  assertEnvironmentCleared(serverEnvironmentReferences[0]);

  const failedRemoteFixture = createProcessFixture(t);
  const remoteSource = makeManagedEnvironment(failedRemoteFixture, makeTransportValues());
  const remoteEnvironmentReferences = [];
  let spawnCount = 0;
  const remoteManager = failedRemoteFixture.createManager({
    environment: remoteSource,
    spawnImpl(executable, args, options) {
      spawnCount += 1;
      if (spawnCount === 1) return failedRemoteFixture.spawnImpl(executable, args, options);
      remoteEnvironmentReferences.push(options.env);
      throw new Error('fixture-CREDENTIAL-SENTINEL');
    },
  });
  await remoteManager.start();
  await assert.rejects(remoteManager.launchRemoteCLI({ threadId: THREAD_ID }), (error) =>
    error.code === 'remote_cli_spawn_failed' && !error.message.includes('CREDENTIAL-SENTINEL') && error.cause === undefined);
  assert.equal(failedRemoteFixture.calls.length, 1);
  assertEnvironmentCleared(remoteEnvironmentReferences[0]);
  await remoteManager.stop();
});

function makeTransportValues() {
  return {
    HTTPS_PROXY: 'http://fixture:proxy-CREDENTIAL-SENTINEL@proxy.invalid:8443',
    HTTP_PROXY: 'http://http-proxy.invalid:8080',
    NO_PROXY: 'localhost, internal.invalid ',
    SSL_CERT_FILE: process.platform === 'win32'
      ? 'C:\\transport certs\\root.pem'
      : '/tmp/transport certs/root.pem',
    NODE_EXTRA_CA_CERTS: process.platform === 'win32'
      ? '\\\\certificate-server\\shared certs\\extra.pem'
      : '/tmp/transport certs/extra.pem',
  };
}

function makeManagedEnvironment(fixture, transportValues, lookupCounts = null) {
  const readValues = typeof transportValues === 'function' ? transportValues : () => transportValues;
  const environment = {
    PATH: 'fixture-path',
    CODEX_HOME: fixture.normalCodexHome,
    HOME: fixture.tempRoot,
    USERPROFILE: fixture.tempRoot,
    ALL_PROXY: 'fixture-forbidden-all-proxy',
    SSL_CERT_DIR: 'fixture-forbidden-ca-dir',
    NODE_OPTIONS: '--require fixture-forbidden-module',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    GH_TOKEN: 'fixture-forbidden-github-token',
    GITHUB_TOKEN: 'fixture-forbidden-github-token',
    CLAUDE_CODE_MESSAGING_TOKEN: 'fixture-forbidden-messaging-token',
    CUSTOM_ENDPOINT: 'fixture-forbidden-endpoint',
  };
  for (const key of TRANSPORT_ENVIRONMENT_KEYS) {
    Object.defineProperty(environment, key, {
      configurable: true,
      enumerable: true,
      get() {
        if (lookupCounts) lookupCounts[key] += 1;
        return readValues()[key];
      },
    });
  }
  return environment;
}

function readTransportValues(environment) {
  return Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, environment[key]]));
}

function assertForbiddenEnvironmentAbsent(environment) {
  for (const key of FORBIDDEN_INHERITED_ENVIRONMENT_KEYS) assert.equal(Object.hasOwn(environment, key), false);
}

function assertEnvironmentCleared(environment) {
  assert.deepEqual(Object.values(environment).every((value) => value === ''), true);
}

function createProcessFixture(t) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-managed-process-test-'));
  const managedHomeRoot = path.join(tempRoot, 'isolated');
  const managedHomePath = path.join(managedHomeRoot, 'codex-home');
  const normalCodexHome = path.join(tempRoot, 'ordinary', '.codex');
  const executablePath = path.join(tempRoot, 'codex.EXE');
  fs.mkdirSync(managedHomeRoot);
  fs.mkdirSync(normalCodexHome, { recursive: true });
  fs.mkdirSync(managedHomePath);
  fs.writeFileSync(executablePath, 'fixture executable');
  fs.writeFileSync(path.join(managedHomePath, 'config.toml'), 'managed-home-configuration');
  fs.writeFileSync(path.join(normalCodexHome, 'config.toml'), 'ordinary-home-configuration');
  const calls = [];
  const environmentReferences = [];
  let transportOptions = null;
  const transportInstances = [];
  const spawnImpl = (executable, args, spawnOptions) => {
    environmentReferences.push(spawnOptions.env);
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
    environmentReferences,
    spawnImpl,
    get transportOptions() { return transportOptions; },
    transportInstances,
    createManager(overrides = {}) {
      const selectedManagedHomeRoot = overrides.managedHomeRoot || managedHomeRoot;
      const selectedManagedHomePath = overrides.managedHomePath || managedHomePath;
      return createCodexManagedProcessManager({
        executablePath: overrides.executablePath || executablePath,
        managedHomeRoot: selectedManagedHomeRoot,
        managedHomePath: selectedManagedHomePath,
        hostId: 'local-host',
        homeScopeId: 'managed-home-test',
        transportTimeoutMs: overrides.transportTimeoutMs,
        requestTimeoutMs: overrides.requestTimeoutMs,
        environment: overrides.environment || {
          PATH: 'C:\\Windows\\System32',
          CODEX_HOME: normalCodexHome,
          HOME: tempRoot,
          USERPROFILE: tempRoot,
          GITHUB_TOKEN: 'must-not-be-inherited',
        },
        startTimeoutMs: 500,
        stopTimeoutMs: 100,
        spawnImpl: overrides.spawnImpl || spawnImpl,
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
