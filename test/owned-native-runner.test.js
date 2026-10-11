'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOwnedNativeRunner, getOwnedSource } = require('../src/server/owned-native-runner');
const { getOwnedInstructionWriter } = require('../src/server/owned-native-instruction-writer');
const { sha256 } = require('../src/server/owned-native-instruction-dispatch');

const LOGIN_ID = 'login_test_1';
const LOGIN_URL = 'https://auth.openai.com/oauth/authorize?code=test';
const TRANSPORT_ENVIRONMENT_KEYS = Object.freeze([
  'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS',
]);
const FORBIDDEN_INHERITED_ENVIRONMENT_KEYS = Object.freeze([
  'ALL_PROXY', 'SSL_CERT_DIR', 'NODE_OPTIONS', 'NODE_TLS_REJECT_UNAUTHORIZED',
  'GH_TOKEN', 'GITHUB_TOKEN', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CUSTOM_ENDPOINT',
]);

class FakePipe extends EventEmitter {
  constructor(onWrite, onWriteCallback) {
    super();
    this.onWrite = onWrite;
    this.onWriteCallback = onWriteCallback;
    this.writes = [];
    this.ended = false;
  }

  write(value, callback) {
    const text = value.toString();
    this.writes.push(text);
    if (this.onWrite) this.onWrite(text);
    if (callback) {
      if (this.onWriteCallback) this.onWriteCallback(text, callback);
      else queueMicrotask(() => callback());
    }
    return true;
  }

  end() {
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  constructor(onWrite, options = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killCalls = [];
    this.exited = false;
    this.stdin = new FakePipe(
      onWrite ? (text) => onWrite(text, this) : null,
      options.onWriteCallback ? (text, callback) => options.onWriteCallback(text, callback, this) : null,
    );
    this.killEvents = options.killEvents || ['exit', 'close'];
    this.killResult = options.killResult ?? true;
    this.killError = options.killError || null;
    this.autoKillEvents = options.autoKillEvents !== false;
  }

  send(...messages) {
    const text = messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
    this.stdout.emit('data', Buffer.from(text, 'utf8'));
  }

  sendRaw(value) {
    this.stdout.emit('data', Buffer.isBuffer(value) ? value : Buffer.from(value));
  }

  kill(signal) {
    this.killCalls.push(signal || null);
    if (this.killError) throw this.killError;
    if (this.killResult === false) return false;
    if (!this.exited && this.autoKillEvents) {
      this.exited = this.killEvents.includes('exit');
      setImmediate(() => {
        for (const event of this.killEvents) this.emit(event, 0, signal || null);
        this.stdout.emit('end');
      });
    }
    return this.killResult;
  }
}

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-native-runner-'));
  const homePath = path.join(root, 'isolated-home');
  const cwd = path.join(root, 'empty-workspace');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(homePath);
  fs.mkdirSync(cwd);
  fs.mkdirSync(bin);
  const executablePath = path.join(bin, process.platform === 'win32' ? 'native.exe' : 'native');
  fs.writeFileSync(executablePath, 'fake executable');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, homePath, cwd, executablePath };
}

function createSpawnHarness(workspace, onWrite) {
  const harness = { calls: 0, child: null, executable: null, args: null, options: null, environment: null, spawnEnvironment: null };
  harness.spawnImpl = (executable, args, options) => {
    harness.calls += 1;
    harness.executable = executable;
    harness.args = [...args];
    harness.options = { ...options, env: undefined };
    harness.home = options.env.HOME;
    harness.codexHome = options.env.CODEX_HOME;
    harness.windowsHome = { HOMEDRIVE: options.env.HOMEDRIVE, HOMEPATH: options.env.HOMEPATH };
    harness.claudeTokenPresent = typeof options.env.CLAUDE_CODE_OAUTH_TOKEN === 'string';
    harness.environment = options.env;
    harness.spawnEnvironment = { ...options.env };
    harness.child = new FakeChild(onWrite);
    setImmediate(() => harness.child.emit('spawn'));
    return harness.child;
  };
  return harness;
}

function baseOptions(workspace, provider, values = {}) {
  return {
    provider,
    executablePath: workspace.executablePath,
    hostId: 'host_test',
    homeScopeId: 'scope_test',
    homePath: workspace.homePath,
    cwd: workspace.cwd,
    profile: 'cockpit-native-v1',
    ...values,
  };
}

function assertWindowsHomePair(environment, homePath, cwd) {
  if (process.platform !== 'win32') return;
  const drivePath = `${environment.HOMEDRIVE}${environment.HOMEPATH}`;
  assert.equal(path.win32.isAbsolute(environment.HOMEPATH), true);
  assert.equal(path.win32.isAbsolute(drivePath), true);
  assert.equal(path.win32.resolve(drivePath).toLowerCase(), path.win32.resolve(homePath).toLowerCase());
  assert.equal(path.win32.resolve(cwd, drivePath).toLowerCase(), path.win32.resolve(homePath).toLowerCase());
}

function requiredHomeDirectories(homePath) {
  return [
    path.join(homePath, 'AppData', 'Roaming'),
    path.join(homePath, 'AppData', 'Local'),
    path.join(homePath, 'tmp'),
    path.join(homePath, '.config'),
    path.join(homePath, '.local', 'share'),
    path.join(homePath, '.cache'),
    path.join(homePath, '.codex'),
  ];
}

test('Windows rejects non-EXE native paths before authentication, spawn, or isolated HOME setup', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows executable suffix contract');

  for (const provider of ['claude', 'codex']) {
    for (const fileName of ['native.cmd', 'native.bat', 'native']) {
      const workspace = createWorkspace(t);
      const executablePath = path.join(workspace.root, fileName);
      fs.writeFileSync(executablePath, 'fixture executable');
      let callbackCount = 0;
      let spawnCount = 0;
      const providerCallbacks = provider === 'claude'
        ? { getAuthentication() { callbackCount += 1; return { oauthToken: 'unused' }; } }
        : { onAuthenticationRequired() { callbackCount += 1; } };
      assert.throws(
        () => createOwnedNativeRunner(baseOptions(workspace, provider, {
          executablePath,
          ...providerCallbacks,
          onNative() { callbackCount += 1; },
          spawnImpl() { spawnCount += 1; },
        })),
        (error) => error.code === 'executable_format_unsupported' && !error.message.includes(executablePath),
      );
      assert.equal(callbackCount, 0);
      assert.equal(spawnCount, 0);
      assert.equal(requiredHomeDirectories(workspace.homePath).some((directory) => fs.existsSync(directory)), false);
    }
  }
});

test('Windows executable validation preserves earlier diagnostics and accepts uppercase EXE suffixes', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows executable suffix contract');

  const workspace = createWorkspace(t);
  const validExecutablePath = path.join(workspace.root, 'alternate.EXE');
  fs.writeFileSync(validExecutablePath, 'fixture executable');
  for (const provider of ['claude', 'codex']) {
    const providerCallbacks = provider === 'claude'
      ? { getAuthentication() { return { oauthToken: 'unused' }; } }
      : { onAuthenticationRequired() {} };
    const options = {
      ...providerCallbacks,
      onNative() {},
      executablePath: validExecutablePath,
    };
    assert.doesNotThrow(() => createOwnedNativeRunner(baseOptions(workspace, provider, options)));
    assert.throws(
      () => createOwnedNativeRunner(baseOptions(workspace, provider, { ...options, executablePath: 'native.cmd' })),
      (error) => error.code === 'absolute_executable_required',
    );
    const missingExecutablePath = path.join(workspace.root, 'missing.cmd');
    assert.throws(
      () => createOwnedNativeRunner(baseOptions(workspace, provider, { ...options, executablePath: missingExecutablePath })),
      (error) => error.code === 'executable_unavailable' && !error.message.includes(missingExecutablePath),
    );
  }
});

test('Windows executable symlinks keep the unavailable diagnostic ahead of suffix validation', (t) => {
  if (process.platform !== 'win32') return t.skip('Windows executable suffix contract');

  const workspace = createWorkspace(t);
  const targetPath = path.join(workspace.root, 'target.EXE');
  const symlinkPath = path.join(workspace.root, 'linked.cmd');
  fs.writeFileSync(targetPath, 'fixture executable');
  try {
    fs.symlinkSync(targetPath, symlinkPath, 'file');
  } catch (error) {
    if (['EPERM', 'EACCES', 'UNKNOWN'].includes(error?.code)) return t.skip('Windows symlink privilege unavailable');
    throw error;
  }

  for (const provider of ['claude', 'codex']) {
    const providerCallbacks = provider === 'claude'
      ? { getAuthentication() { return { oauthToken: 'unused' }; } }
      : { onAuthenticationRequired() {} };
    assert.throws(
      () => createOwnedNativeRunner(baseOptions(workspace, provider, {
        ...providerCallbacks,
        executablePath: symlinkPath,
        onNative() {},
      })),
      (error) => error.code === 'executable_unavailable',
    );
  }
});

function codexResponse(id, result) {
  return { id, result };
}

function codexNotification(method, params) {
  return { method, params };
}

function codexLoginCompleted(loginId = LOGIN_ID, success = true) {
  return codexNotification('account/login/completed', { loginId, success });
}

function codexTurnCompleted(threadId = 'thread_native_1', turnId = 'turn_native_1') {
  return codexNotification('turn/completed', { threadId, turn: { id: turnId, status: 'completed' } });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function observeStart(promise) {
  return promise.then(
    (value) => ({ status: 'resolved', value }),
    (error) => ({ status: 'rejected', error }),
  );
}

function nextImmediate() {
  return new Promise((resolve) => setImmediate(resolve));
}

function codexResponder(options = {}) {
  const methods = [];
  const harness = createSpawnHarness(options.workspace, (line, child) => {
    const request = JSON.parse(line);
    if (!request.method || !Object.hasOwn(request, 'id')) return;
    methods.push(request.method);
    if (request.method === 'initialize') {
      if (options.serverRequest) {
        child.send(makeNativeHoldRequest('server-request', 'item/commandExecution/requestApproval'));
      }
      child.send(codexResponse(request.id, { serverInfo: { name: 'codex', version: 'test' } }));
      return;
    }
    if (request.method === 'account/login/start') {
      if (options.earlyLoginCompletion) child.send(codexLoginCompleted(options.earlyLoginId || LOGIN_ID, true));
      child.send(codexResponse(request.id, {
        type: 'chatgpt',
        loginId: options.loginResponseId || LOGIN_ID,
        authUrl: options.authUrl === undefined ? LOGIN_URL : options.authUrl,
      }));
      return;
    }
    if (request.method === 'thread/start') {
      child.send(codexResponse(request.id, { thread: { id: 'thread_native_1' } }));
      return;
    }
    if (request.method === 'turn/start') {
      if (options.earlyTurnCompletion) child.send(codexTurnCompleted());
      child.send(codexResponse(request.id, { turn: { id: 'turn_native_1' } }));
    }
  });
  harness.methods = methods;
  return harness;
}

test('construction does not spawn and Claude reports only native main-message context before ending it', async (t) => {
  const workspace = createWorkspace(t);
  const inputText = 'private prompt body';
  const secretText = 'private model output';
  const token = 'claude-oauth-secret-test';
  let envReference;
  let callbackText;
  let disconnectCount = 0;
  const harness = { calls: 0, child: null, args: null };
  const events = [];
  const previousSentinel = process.env.OWNED_NATIVE_RUNNER_TEST_SECRET;
  process.env.OWNED_NATIVE_RUNNER_TEST_SECRET = 'must-not-inherit';
  try {
    const runner = createOwnedNativeRunner(baseOptions(workspace, 'claude', {
      getAuthentication: () => ({ oauthToken: token }),
      spawnImpl: (executable, args, spawnOptions) => {
        envReference = spawnOptions.env;
        assert.equal(executable, workspace.executablePath);
        assert.equal(spawnOptions.cwd, workspace.cwd);
        assert.equal(spawnOptions.shell, false);
        assert.equal(spawnOptions.windowsHide, true);
        assert.deepEqual(spawnOptions.stdio, ['pipe', 'pipe', 'pipe']);
        assert.equal(spawnOptions.env.HOME, workspace.homePath);
        assert.equal(spawnOptions.env.USERPROFILE, workspace.homePath);
        assertWindowsHomePair(spawnOptions.env, workspace.homePath, workspace.cwd);
        assert.equal(spawnOptions.env.CLAUDE_CONFIG_DIR, workspace.homePath);
        assert.equal(spawnOptions.env.CLAUDE_CODE_OAUTH_TOKEN, token);
        assert.equal(spawnOptions.env.OWNED_NATIVE_RUNNER_TEST_SECRET, undefined);
        assert.equal(args.includes('--no-session-persistence'), true);
        assert.equal(args.includes('--strict-mcp-config'), true);
        assert.equal(args.includes('--tools'), true);
        assert.equal(args[args.indexOf('--tools') + 1], '');
        assert.equal(args.includes('--setting-sources'), true);
        assert.equal(args[args.indexOf('--setting-sources') + 1], '');
        harness.calls += 1;
        harness.args = [...args];
        harness.child = new FakeChild((line, child) => {
          const input = JSON.parse(line);
          if (input.type === 'user') {
            callbackText = input.message.content[0].text;
            child.send(
              { type: 'system', subtype: 'init', session_id: 'session_native_1' },
              {
                type: 'stream_event', session_id: 'session_native_1', parent_tool_use_id: 'tool_native_1',
                event: { type: 'message_start', message: { id: 'nested_message_id', role: 'assistant' } },
              },
              {
                type: 'stream_event', session_id: 'session_native_1', parent_tool_use_id: null,
                event: { type: 'message_start', message: { id: 'assistant_message_native_1', role: 'assistant' } },
              },
              { type: 'assistant', message: { content: [{ type: 'text', text: secretText }] } },
              { type: 'result', uuid: '11111111-1111-4111-8111-111111111111', session_id: 'session_native_1', result: secretText },
            );
          }
        });
        setImmediate(() => harness.child.emit('spawn'));
        return harness.child;
      },
      onNative: (event) => events.push(event),
      onDisconnect: () => { disconnectCount += 1; },
    }));
    assert.equal(harness.calls, 0);
    const snapshot = await runner.start({ inputText });
    assert.equal(callbackText, inputText);
    assert.deepEqual(events.map((event) => event.type), ['identity', 'context', 'context_ended']);
    assert.deepEqual(events[0].identity, {
      provider: 'claude', nativeIdKind: 'session', hostId: 'host_test',
      homeScopeId: 'scope_test', nativeId: 'session_native_1',
    });
    assert.deepEqual(events[1].context, {
      kind: 'assistant_message', nativeContextId: 'assistant_message_native_1', parentToolUseId: null,
    });
    assert.deepEqual(events[2].context, {
      kind: 'assistant_message', nativeContextId: 'assistant_message_native_1',
    });
    assert.equal(Object.isFrozen(events[0]), true);
    assert.equal(Object.isFrozen(events[0].identity), true);
    assert.equal(Object.isFrozen(events[1].context), true);
    assert.equal(snapshot.state, 'running');
    assert.equal(snapshot.contextState, 'ended');
    assert.equal(snapshot.terminalContextCount, 1);
    assert.equal(JSON.stringify(snapshot).includes(token), false);
    assert.equal(JSON.stringify(snapshot).includes(inputText), false);
    assert.equal(JSON.stringify(events).includes(secretText), false);
    assert.equal(Object.keys(envReference).length, 0);
    harness.child.stderr.emit('data', Buffer.from(token));
    await runner.stop();
    harness.child.send({ type: 'system', subtype: 'init', session_id: 'late_session' });
    assert.equal(events.length, 3);
    assert.equal(disconnectCount, 0);
  } finally {
    if (previousSentinel === undefined) delete process.env.OWNED_NATIVE_RUNNER_TEST_SECRET;
    else process.env.OWNED_NATIVE_RUNNER_TEST_SECRET = previousSentinel;
  }
});

test('Codex presents same-process managed login once and waits for its matching completion before starting a turn', async (t) => {
  const workspace = createWorkspace(t);
  const events = [];
  const methods = [];
  const harness = createSpawnHarness(workspace, (line, child) => {
    const request = JSON.parse(line);
    if (!request.method || !Object.hasOwn(request, 'id')) return;
    methods.push(request.method);
    if (request.method === 'initialize') child.send(codexResponse(request.id, { serverInfo: { name: 'codex', version: 'test' } }));
    else if (request.method === 'account/login/start') {
      child.send(codexResponse(request.id, { type: 'chatgpt', loginId: LOGIN_ID, authUrl: LOGIN_URL }));
    } else if (request.method === 'thread/start') {
      child.send(codexResponse(request.id, { thread: { id: 'thread_native_1' } }));
    } else if (request.method === 'turn/start') {
      child.send(codexResponse(request.id, { turn: { id: 'turn_native_1' } }));
    }
  });
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    onAuthenticationRequired: ({ loginId, authUrl }) => {
      assert.equal(loginId, LOGIN_ID);
      assert.equal(authUrl, LOGIN_URL);
      assert.deepEqual(methods, ['initialize', 'account/login/start']);
      harness.child.send(codexLoginCompleted(loginId));
    },
    spawnImpl: (executable, args, options) => {
      for (const directory of requiredHomeDirectories(workspace.homePath)) {
        assert.equal(fs.statSync(directory).isDirectory(), true);
      }
      return harness.spawnImpl(executable, args, options);
    },
    onNative: (event) => events.push(event),
  }));
  const snapshot = await runner.start({ inputText: 'private task prompt' });
  assert.equal(harness.calls, 1);
  assert.equal(harness.options.shell, false);
  assert.equal(harness.options.windowsHide, true);
  assert.equal(harness.home, workspace.homePath);
  assertWindowsHomePair(harness.windowsHome, workspace.homePath, workspace.cwd);
  assert.equal(harness.codexHome, path.join(workspace.homePath, '.codex'));
  assert.equal(harness.claudeTokenPresent, false);
  assert.deepEqual(harness.args.slice(0, 3), ['app-server', '--listen', 'stdio://']);
  assert.equal(harness.args.includes('cli_auth_credentials_store="ephemeral"'), true);
  for (const setting of [
    'features.shell_tool=false', 'features.unified_exec=false', 'features.multi_agent=false',
    'features.apps=false', 'features.hooks=false', 'features.skill_mcp_dependency_install=false',
    'features.daemon_auto_start=false', 'features.browser_use=false', 'features.browser_use_external=false',
    'features.browser_use_full_cdp_access=false', 'features.computer_use=false',
    'features.image_generation=false', 'features.plugins=false', 'features.remote_plugin=false',
    'features.workspace_dependencies=false',
    'web_search="disabled"',
  ]) assert.equal(harness.args.includes(setting), true);
  assert.deepEqual(methods, ['initialize', 'account/login/start', 'thread/start', 'turn/start']);
  assert.deepEqual(events.map((event) => event.type), ['identity', 'context']);
  assert.equal(events[0].identity.nativeIdKind, 'thread');
  assert.equal(events[1].context.nativeContextId, 'turn_native_1');
  assert.equal(snapshot.contextState, 'active');
  assert.equal(snapshot.authCapability, 'managed_chatgpt_login');
  assert.equal(JSON.stringify(snapshot).includes(LOGIN_URL), false);
  assert.equal(JSON.stringify(events).includes(LOGIN_URL), false);

  harness.child.send(codexTurnCompleted());
  assert.deepEqual(events.map((event) => event.type), ['identity', 'context', 'context_ended']);
  assert.equal(runner.snapshot().contextState, 'ended');
  assert.equal(runner.snapshot().terminalContextCount, 1);
  await assert.rejects(runner.start({ inputText: 'a second task' }), (error) => error.code === 'already_started');
  await runner.stop();
});

test('Codex accepts only approved authentication URL origins and preserves the original URL', async (t) => {
  const authenticationUrls = [
    'https://auth.openai.com/oauth/authorize?code=auth-origin-CREDENTIAL-SENTINEL',
    'https://chatgpt.com/device?continue=%2Fsettings&code=chatgpt-origin-CREDENTIAL-SENTINEL',
    'https://AUTH.OPENAI.COM:443/arbitrary/path?opaque=%2f+',
    'https://chatgpt.com:443/another/path?state=original+value',
  ];

  for (const authUrl of authenticationUrls) {
    const workspace = createWorkspace(t);
    const events = [];
    const harness = codexResponder({ workspace, authUrl });
    let displayedUrl = null;
    let promptCalls = 0;
    const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
      onAuthenticationRequired: ({ loginId, authUrl: challengeUrl }) => {
        promptCalls += 1;
        displayedUrl = challengeUrl;
        harness.child.send(codexLoginCompleted(loginId));
      },
      spawnImpl: harness.spawnImpl,
      onNative: (event) => events.push(event),
    }));
    t.after(async () => { await runner.stop(); });

    const snapshot = await runner.start({ inputText: 'fixture task' });
    assert.equal(displayedUrl, authUrl);
    assert.equal(promptCalls, 1);
    assert.deepEqual(harness.methods, ['initialize', 'account/login/start', 'thread/start', 'turn/start']);
    assert.equal(JSON.stringify(snapshot).includes(authUrl), false);
    assert.equal(JSON.stringify(events).includes(authUrl), false);
    assert.equal(JSON.stringify(snapshot).includes('CREDENTIAL-SENTINEL'), false);
    assert.equal(JSON.stringify(events).includes('CREDENTIAL-SENTINEL'), false);
    await runner.stop();
  }
});

test('Codex rejects authentication URLs outside the approved origins without exposing them', async (t) => {
  const marker = 'private-auth-url-CREDENTIAL-SENTINEL';
  const invalidUrls = [
    `https://unknown.invalid/oauth?code=${marker}`,
    `https://auth.openai.com:444/oauth?code=${marker}`,
    `https://fixture-user:${marker}@auth.openai.com/oauth`,
    `https://login.auth.openai.com/oauth?code=${marker}`,
    `https://auth.openai.com.attacker.invalid/oauth?code=${marker}`,
    `https://auth.openai.com./oauth?code=${marker}`,
    `https://127.0.0.1/oauth?code=${marker}`,
    `https://[::1]/oauth?code=${marker}`,
    `https://localhost/oauth?code=${marker}`,
    `http://auth.openai.com/oauth?code=${marker}`,
    ` https://auth.openai.com/oauth?code=${marker}`,
    `https://auth.openai.com/oauth?code=${marker} `,
    `https://auth.openai.com/oauth?code=${marker}${String.fromCharCode(10)}continued`,
    `https://auth.openai.com/oauth?code=${'x'.repeat(4100)}${marker}`,
  ];

  for (const authUrl of invalidUrls) {
    const workspace = createWorkspace(t);
    const events = [];
    const harness = codexResponder({ workspace, authUrl });
    let promptCalls = 0;
    const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
      onAuthenticationRequired() { promptCalls += 1; },
      spawnImpl: harness.spawnImpl,
      onNative: (event) => events.push(event),
    }));
    t.after(async () => { await runner.stop(); });

    await assert.rejects(runner.start({ inputText: 'fixture task' }), (error) => {
      assert.equal(error.code, 'authentication_response_invalid');
      assert.equal(error.cause, undefined);
      assert.equal(error.message.includes(authUrl), false);
      assert.equal(error.stack.includes(authUrl), false);
      assert.equal(error.message.includes(marker), false);
      assert.equal(error.stack.includes(marker), false);
      return true;
    });
    assert.equal(promptCalls, 0);
    assert.deepEqual(harness.methods, ['initialize', 'account/login/start']);
    assert.deepEqual(events, []);
    assert.equal(runner.snapshot().failureCode, 'authentication_response_invalid');
    assert.equal(JSON.stringify(runner.snapshot()).includes(authUrl), false);
    assert.equal(JSON.stringify(runner.snapshot()).includes(marker), false);
    await runner.stop();
  }
});

test('Codex rejects an invalid authentication URL even when login completion arrived first', async (t) => {
  const workspace = createWorkspace(t);
  const marker = 'early-private-auth-url-CREDENTIAL-SENTINEL';
  const authUrl = `https://unknown.invalid/oauth?code=${marker}`;
  const events = [];
  const harness = codexResponder({ workspace, authUrl, earlyLoginCompletion: true });
  let promptCalls = 0;
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    onAuthenticationRequired() { promptCalls += 1; },
    spawnImpl: harness.spawnImpl,
    onNative: (event) => events.push(event),
  }));
  t.after(async () => { await runner.stop(); });

  await assert.rejects(runner.start({ inputText: 'fixture task' }), (error) => {
    assert.equal(error.code, 'authentication_response_invalid');
    assert.equal(error.cause, undefined);
    assert.equal(error.message.includes(marker), false);
    assert.equal(error.stack.includes(marker), false);
    return true;
  });
  assert.equal(promptCalls, 0);
  assert.deepEqual(harness.methods, ['initialize', 'account/login/start']);
  assert.deepEqual(events, []);
  assert.equal(JSON.stringify(runner.snapshot()).includes(marker), false);
  await runner.stop();
});

test('a symlinked HOME descendant is rejected before authentication or child spawn', async (t) => {
  const workspace = createWorkspace(t);
  const outside = path.join(workspace.root, 'outside-home');
  const configPath = path.join(workspace.homePath, '.config');
  fs.mkdirSync(outside);
  try {
    fs.symlinkSync(outside, configPath, process.platform === 'win32' ? 'junction' : 'dir');
  } catch {
    t.skip('directory symlinks are unavailable in this environment');
    return;
  }
  const harness = createSpawnHarness(workspace);
  let authenticationCalls = 0;
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'claude', {
    getAuthentication: () => {
      authenticationCalls += 1;
      return { oauthToken: 'oauth-secret' };
    },
    spawnImpl: harness.spawnImpl,
    onNative() {},
  }));

  await assert.rejects(runner.start({ inputText: 'task' }),
    (error) => error.code === 'isolated_directory_unsafe');
  assert.equal(authenticationCalls, 0);
  assert.equal(harness.calls, 0);
  assert.equal(runner.snapshot().failureCode, 'isolated_directory_unsafe');
  await runner.stop();
  fs.rmSync(configPath, { recursive: false, force: true });
});

test('Codex reconciles a completion notification that arrives before turn/start response without activating context', async (t) => {
  const workspace = createWorkspace(t);
  const events = [];
  let prompts = 0;
  const harness = codexResponder({ workspace, earlyTurnCompletion: true });
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    onAuthenticationRequired: ({ loginId }) => {
      prompts += 1;
      harness.child.send(codexLoginCompleted(loginId));
    },
    spawnImpl: harness.spawnImpl,
    onNative: (event) => events.push(event),
  }));
  const snapshot = await runner.start({ inputText: 'private turn' });
  assert.equal(prompts, 1);
  assert.deepEqual(harness.methods, ['initialize', 'account/login/start', 'thread/start', 'turn/start']);
  assert.deepEqual(events.map((event) => event.type), ['identity', 'context_ended']);
  assert.equal(events[1].context.nativeContextId, 'turn_native_1');
  assert.equal(snapshot.contextState, 'ended');
  assert.equal(snapshot.terminalContextCount, 1);
  await runner.stop();
});

test('a successful login notification that precedes its RPC response is correlated before any thread starts', async (t) => {
  const workspace = createWorkspace(t);
  const methods = [];
  const harness = createSpawnHarness(workspace, (line, child) => {
    const request = JSON.parse(line);
    if (!request.method || !Object.hasOwn(request, 'id')) return;
    methods.push(request.method);
    if (request.method === 'initialize') child.send(codexResponse(request.id, {}));
    else if (request.method === 'account/login/start') {
      child.send(codexLoginCompleted(LOGIN_ID));
      child.send(codexResponse(request.id, { type: 'chatgpt', loginId: LOGIN_ID, authUrl: LOGIN_URL }));
    } else if (request.method === 'thread/start') child.send(codexResponse(request.id, { thread: { id: 'thread_native_1' } }));
    else if (request.method === 'turn/start') child.send(codexResponse(request.id, { turn: { id: 'turn_native_1' } }));
  });
  let prompts = 0;
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    onAuthenticationRequired: () => { prompts += 1; },
    spawnImpl: harness.spawnImpl,
    onNative() {},
  }));
  const snapshot = await runner.start({ inputText: 'task' });
  assert.equal(prompts, 0);
  assert.deepEqual(methods, ['initialize', 'account/login/start', 'thread/start', 'turn/start']);
  assert.equal(snapshot.contextState, 'active');
  await runner.stop();
});

test('owner expiry at the authentication callback prevents thread start despite native login completion', async (t) => {
  const workspace = createWorkspace(t);
  const methods = [];
  let ownerCurrent = true;
  let prompts = 0;
  const harness = createSpawnHarness(workspace, (line, child) => {
    const request = JSON.parse(line);
    if (!request.method || !Object.hasOwn(request, 'id')) return;
    methods.push(request.method);
    if (request.method === 'initialize') child.send(codexResponse(request.id, {}));
    else if (request.method === 'account/login/start') {
      child.send(codexResponse(request.id, { type: 'chatgpt', loginId: LOGIN_ID, authUrl: LOGIN_URL }));
    }
  });
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    isCurrent: () => ownerCurrent,
    onAuthenticationRequired: ({ loginId }) => {
      prompts += 1;
      harness.child.send(codexLoginCompleted(loginId));
      ownerCurrent = false;
    },
    spawnImpl: harness.spawnImpl,
    onNative() {},
  }));
  await assert.rejects(runner.start({ inputText: 'task' }), (error) => error.code === 'authority_expired');
  assert.equal(prompts, 1);
  assert.deepEqual(methods, ['initialize', 'account/login/start']);
  assert.equal(runner.snapshot().failureCode, 'authority_expired');
  await runner.stop();
});

test('owner expiry after thread identity registration prevents the turn request', async (t) => {
  const workspace = createWorkspace(t);
  const events = [];
  let ownerCurrent = true;
  const harness = codexResponder({ workspace });
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    isCurrent: () => ownerCurrent,
    onAuthenticationRequired: ({ loginId }) => harness.child.send(codexLoginCompleted(loginId)),
    spawnImpl: harness.spawnImpl,
    onNative: (event) => {
      events.push(event);
      if (event.type === 'identity') ownerCurrent = false;
    },
  }));
  await assert.rejects(runner.start({ inputText: 'task' }), (error) => error.code === 'authority_expired');
  assert.deepEqual(harness.methods, ['initialize', 'account/login/start', 'thread/start']);
  assert.deepEqual(events.map((event) => event.type), ['identity']);
  assert.equal(runner.snapshot().contextState, 'none');
  await runner.stop();
});

test('owner freshness callback must return the synchronous boolean true', async (t) => {
  const workspace = createWorkspace(t);
  const harness = codexResponder({ workspace });
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    isCurrent: () => Promise.resolve(true),
    onAuthenticationRequired() {},
    spawnImpl: harness.spawnImpl,
    onNative() {},
  }));
  await assert.rejects(runner.start({ inputText: 'task' }), (error) => error.code === 'authority_expired');
  assert.equal(harness.calls, 0);
  await runner.stop();
});

test('Codex accepts native responses without jsonrpc and rejects a conflicting present version', async (t) => {
  const workspace = createWorkspace(t);
  const methods = [];
  const harness = createSpawnHarness(workspace, (line, child) => {
    const request = JSON.parse(line);
    if (!request.method || !Object.hasOwn(request, 'id')) return;
    methods.push(request.method);
    child.send({ jsonrpc: '1.0', id: request.id, result: {} });
  });
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    onAuthenticationRequired() {},
    spawnImpl: harness.spawnImpl,
    onNative() {},
  }));
  await assert.rejects(runner.start({ inputText: 'task' }), (error) => error.code === 'operation_stopped');
  assert.deepEqual(methods, ['initialize']);
  assert.equal(runner.snapshot().failureCode, 'codex_message_invalid');
  await runner.stop();
});

test('stop remains unconfirmed after exit until close confirms the owned child is inactive', async (t) => {
  const workspace = createWorkspace(t);
  let child;
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'claude', {
    getAuthentication: () => ({ oauthToken: 'oauth-secret' }),
    spawnImpl: (executable, args, spawnOptions) => {
      child = new FakeChild((line, ownedChild) => {
        if (JSON.parse(line).type !== 'user') return;
        ownedChild.send(
          { type: 'system', subtype: 'init', session_id: 'session_native_1' },
          {
            type: 'stream_event', session_id: 'session_native_1', parent_tool_use_id: null,
            event: { type: 'message_start', message: { id: 'message_native_1', role: 'assistant' } },
          },
        );
      });
      child.kill = (signal) => {
        child.killCalls.push(signal || null);
        return true;
      };
      setImmediate(() => child.emit('spawn'));
      return child;
    },
    onNative() {},
    timeouts: { stopMs: 50 },
  }));
  await runner.start({ inputText: 'fixed task' });
  const firstStop = await runner.stop();
  assert.equal(firstStop.state, 'stop_unconfirmed');
  assert.equal(firstStop.failureCode, 'stop_unconfirmed');
  assert.equal(firstStop.childExited, false);
  assert.equal(firstStop.childClosed, false);
  assert.equal(firstStop.ownedChildActive, true);
  assert.deepEqual(child.killCalls, [null, 'SIGKILL']);
  child.emit('exit', 137, 'SIGKILL');
  const afterExit = runner.snapshot();
  assert.equal(afterExit.state, 'stop_unconfirmed');
  assert.equal(afterExit.childExited, true);
  assert.equal(afterExit.childClosed, false);
  assert.equal(afterExit.ownedChildActive, true);
  child.emit('close', 137, 'SIGKILL');
  const afterClose = runner.snapshot();
  assert.equal(afterClose.state, 'stopped');
  assert.equal(afterClose.childClosed, true);
  assert.equal(afterClose.ownedChildActive, false);
});

test('close without exit does not confirm stop, while a later exit completes the evidence', async (t) => {
  const workspace = createWorkspace(t);
  let child;
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'claude', {
    getAuthentication: () => ({ oauthToken: 'oauth-secret' }),
    spawnImpl: (executable, args, spawnOptions) => {
      child = new FakeChild((line, ownedChild) => {
        if (JSON.parse(line).type !== 'user') return;
        ownedChild.send(
          { type: 'system', subtype: 'init', session_id: 'session_native_1' },
          { type: 'stream_event', session_id: 'session_native_1', parent_tool_use_id: null,
            event: { type: 'message_start', message: { id: 'message_native_1', role: 'assistant' } } },
        );
      });
      child.kill = () => true;
      setImmediate(() => child.emit('spawn'));
      return child;
    },
    onNative() {},
    timeouts: { stopMs: 50 },
  }));
  await runner.start({ inputText: 'fixed task' });
  assert.equal((await runner.stop()).state, 'stop_unconfirmed');
  child.emit('close', 0, 'SIGKILL');
  assert.deepEqual(
    { state: runner.snapshot().state, childExited: runner.snapshot().childExited,
      childClosed: runner.snapshot().childClosed, ownedChildActive: runner.snapshot().ownedChildActive },
    { state: 'stop_unconfirmed', childExited: false, childClosed: true, ownedChildActive: true },
  );
  child.emit('exit', 0, 'SIGKILL');
  assert.equal(runner.snapshot().state, 'stopped');
  assert.equal(runner.snapshot().ownedChildActive, false);
});

test('exit before the stop timeout avoids a redundant kill while close is pending', async (t) => {
  const workspace = createWorkspace(t);
  let child;
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'claude', {
    getAuthentication: () => ({ oauthToken: 'oauth-secret' }),
    spawnImpl: (executable, args, spawnOptions) => {
      child = new FakeChild((line, ownedChild) => {
        if (JSON.parse(line).type !== 'user') return;
        ownedChild.send(
          { type: 'system', subtype: 'init', session_id: 'session_native_1' },
          { type: 'stream_event', session_id: 'session_native_1', parent_tool_use_id: null,
            event: { type: 'message_start', message: { id: 'message_native_1', role: 'assistant' } } },
        );
      });
      child.kill = (signal) => {
        child.killCalls.push(signal || null);
        setTimeout(() => child.emit('exit', 0, signal || null), 5);
        return true;
      };
      setImmediate(() => child.emit('spawn'));
      return child;
    },
    onNative() {},
    timeouts: { stopMs: 50 },
  }));
  await runner.start({ inputText: 'fixed task' });

  const stopped = await runner.stop();
  assert.equal(stopped.state, 'stop_unconfirmed');
  assert.equal(stopped.childExited, true);
  assert.equal(stopped.childClosed, false);
  assert.equal(stopped.ownedChildActive, true);
  assert.deepEqual(child.killCalls, [null]);
  child.emit('close', 0, 'SIGTERM');
  assert.equal(runner.snapshot().state, 'stopped');
});

test('false or throwing kill results do not count as physical termination', async (t) => {
  for (const behavior of ['false', 'throw']) {
    const workspace = createWorkspace(t);
    const harness = createSpawnHarness(workspace);
    const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
      onAuthenticationRequired: ({ loginId }) => harness.child.send(codexLoginCompleted(loginId)),
      spawnImpl: (executable, args, spawnOptions) => {
        const child = new FakeChild();
        child.kill = (signal) => {
          child.killCalls.push(signal || null);
          if (behavior === 'throw') throw new Error('fixture kill failure');
          return false;
        };
        harness.child = child;
        setImmediate(() => child.emit('spawn'));
        child.stdin.onWrite = (line) => {
          const request = JSON.parse(line);
          if (request.method === 'initialize') child.send(codexResponse(request.id, {}));
          else if (request.method === 'account/login/start') child.send(codexResponse(request.id, {
            type: 'chatgpt', loginId: LOGIN_ID, authUrl: LOGIN_URL,
          }));
          else if (request.method === 'thread/start') child.send(codexResponse(request.id, { thread: { id: 'thread_native_1' } }));
          else if (request.method === 'turn/start') child.send(codexResponse(request.id, { turn: { id: 'turn_native_1' } }));
        };
        return child;
      },
      onNative() {},
      timeouts: { stopMs: 50 },
    }));
    await runner.start({ inputText: 'fixed task' });
    const stopped = await runner.stop();
    assert.equal(stopped.state, 'stop_unconfirmed', behavior);
    assert.equal(stopped.childExited, false, behavior);
    assert.equal(stopped.childClosed, false, behavior);
    assert.equal(stopped.ownedChildActive, true, behavior);
  }
});

test('spawn error followed by close without exit remains unconfirmed', async (t) => {
  const workspace = createWorkspace(t);
  let child;
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'claude', {
    getAuthentication: () => ({ oauthToken: 'oauth-secret' }),
    spawnImpl: (executable, args, spawnOptions) => {
      child = new FakeChild((line, ownedChild) => {
        if (JSON.parse(line).type !== 'user') return;
        ownedChild.send(
          { type: 'system', subtype: 'init', session_id: 'session_native_1' },
          { type: 'stream_event', session_id: 'session_native_1', parent_tool_use_id: null,
            event: { type: 'message_start', message: { id: 'message_native_1', role: 'assistant' } } },
        );
      }, { autoKillEvents: false });
      setImmediate(() => child.emit('spawn'));
      return child;
    },
    onNative() {},
    timeouts: { stopMs: 50 },
  }));
  await runner.start({ inputText: 'fixed task' });
  child.emit('error', new Error('fixture spawn failure'));
  child.emit('close', -1, null);
  const stopped = await runner.stop();
  assert.equal(stopped.state, 'stop_unconfirmed');
  assert.equal(stopped.childExited, false);
  assert.equal(stopped.childClosed, true);
  assert.equal(stopped.ownedChildActive, true);
});

test('a spawn attempt without a child handle is not treated as confirmed stop', async (t) => {
  const workspace = createWorkspace(t);
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'claude', {
    getAuthentication: () => ({ oauthToken: 'oauth-secret' }),
    spawnImpl: () => { throw new Error('spawn adapter failed'); },
    onNative() {},
  }));

  await assert.rejects(runner.start({ inputText: 'fixed task' }), (error) => error.code === 'spawn_failed');
  const stopped = await runner.stop();
  assert.equal(stopped.state, 'stop_unconfirmed');
  assert.equal(stopped.childExited, false);
  assert.equal(stopped.childClosed, false);
  assert.equal(stopped.ownedChildActive, false);
});

test('owner expiry immediately after spawn still stops the returned child', async (t) => {
  const workspace = createWorkspace(t);
  let ownerCurrent = true;
  let child;
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'claude', {
    isCurrent: () => ownerCurrent,
    getAuthentication: () => ({ oauthToken: 'oauth-secret' }),
    spawnImpl: () => {
      ownerCurrent = false;
      child = new FakeChild(() => {});
      setImmediate(() => child.emit('spawn'));
      return child;
    },
    onNative() {},
  }));

  await assert.rejects(runner.start({ inputText: 'fixed task' }), (error) => error.code === 'authority_expired');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(child.killCalls, [null]);
  const stopped = await runner.stop();
  assert.equal(stopped.state, 'stopped');
  assert.equal(stopped.childExited, true);
  assert.equal(stopped.childClosed, true);
});

test('a mismatched login completion fails closed without starting a thread or exposing login data', async (t) => {
  const workspace = createWorkspace(t);
  const methods = [];
  let disconnect = null;
  let runner;
  const harness = createSpawnHarness(workspace, (line, child) => {
    const request = JSON.parse(line);
    if (!request.method || !Object.hasOwn(request, 'id')) return;
    methods.push(request.method);
    if (request.method === 'initialize') child.send(codexResponse(request.id, {}));
    else if (request.method === 'account/login/start') {
      child.send(codexResponse(request.id, { type: 'chatgpt', loginId: LOGIN_ID, authUrl: LOGIN_URL }));
    }
  });
  runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    onAuthenticationRequired: ({ loginId }) => harness.child.send(codexLoginCompleted(loginId + '_wrong')),
    spawnImpl: harness.spawnImpl,
    onNative() {},
    onDisconnect: (event) => { disconnect = event; },
  }));
  await assert.rejects(runner.start({ inputText: 'private' }), (error) => {
    assert.equal(error.message.includes(LOGIN_URL), false);
    assert.equal(error.message.includes(LOGIN_ID), false);
    return ['operation_stopped', 'authentication_login_mismatch'].includes(error.code);
  });
  assert.deepEqual(methods, ['initialize', 'account/login/start']);
  assert.equal(runner.snapshot().failureCode, 'authentication_login_mismatch');
  assert.equal(JSON.stringify(runner.snapshot()).includes(LOGIN_URL), false);
  assert.equal(disconnect.reason, 'authentication_login_mismatch');
  await runner.stop();
});

test('a login completion that arrives before the start response must match its login ID', async (t) => {
  const workspace = createWorkspace(t);
  const methods = [];
  let prompts = 0;
  const harness = createSpawnHarness(workspace, (line, child) => {
    const request = JSON.parse(line);
    if (!request.method || !Object.hasOwn(request, 'id')) return;
    methods.push(request.method);
    if (request.method === 'initialize') child.send(codexResponse(request.id, {}));
    else if (request.method === 'account/login/start') {
      child.send(codexLoginCompleted('unrelated_login', true));
      child.send(codexResponse(request.id, { type: 'chatgpt', loginId: LOGIN_ID, authUrl: LOGIN_URL }));
    }
  });
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    onAuthenticationRequired: () => { prompts += 1; },
    spawnImpl: harness.spawnImpl,
    onNative() {},
  }));
  await assert.rejects(runner.start({ inputText: 'task' }));
  assert.equal(runner.snapshot().failureCode, 'authentication_login_mismatch');
  assert.equal(prompts, 0);
  assert.deepEqual(methods, ['initialize', 'account/login/start']);
  await runner.stop();
});

test('the authentication prompt promise does not substitute for the native login completion', async (t) => {
  const workspace = createWorkspace(t);
  const methods = [];
  let prompts = 0;
  let disconnect = null;
  const harness = createSpawnHarness(workspace, (line, child) => {
    const request = JSON.parse(line);
    if (!request.method || !Object.hasOwn(request, 'id')) return;
    methods.push(request.method);
    if (request.method === 'initialize') child.send(codexResponse(request.id, {}));
    else if (request.method === 'account/login/start') {
      child.send(codexResponse(request.id, { type: 'chatgpt', loginId: LOGIN_ID, authUrl: LOGIN_URL }));
    }
  });
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    onAuthenticationRequired: () => { prompts += 1; return Promise.resolve(); },
    spawnImpl: harness.spawnImpl,
    onNative() {},
    onDisconnect: (event) => { disconnect = event; },
    timeouts: { loginMs: 50 },
  }));
  await assert.rejects(runner.start({ inputText: 'task' }), (error) => error.code === 'authentication_timeout');
  assert.equal(prompts, 1);
  assert.deepEqual(methods, ['initialize', 'account/login/start']);
  assert.equal(runner.snapshot().failureCode, 'authentication_timeout');
  assert.equal(disconnect.reason, 'authentication_timeout');
  await runner.stop();
});

test('a native permission request before thread and turn scope is known enters a safe hold', async (t) => {
  const workspace = createWorkspace(t);
  const harness = codexResponder({ workspace, serverRequest: true });
  let disconnect = null;
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    onAuthenticationRequired: ({ loginId }) => harness.child.send(codexLoginCompleted(loginId)),
    spawnImpl: harness.spawnImpl,
    onNative() {},
    onDisconnect: (event) => { disconnect = event; },
  }));
  const snapshot = await runner.start({ inputText: 'task' });
  assert.equal(snapshot.state, 'running');
  assert.equal(snapshot.failureCode, null);
  assert.equal(snapshot.unknownServerRequestHeld, true);
  assert.equal(snapshot.nativeRequestIdCount, 1);
  assert.equal(disconnect, null);
  assert.deepEqual(harness.methods, ['initialize', 'account/login/start', 'thread/start', 'turn/start']);
  assert.equal(harness.child.stdin.writes.some((line) => line.includes('server-request')), false);
  assert.equal(runner.captureNativePendingSummary('thread_native_1', 'turn_native_1'), null);
  await runner.stop();
});

test('stopping from the authentication callback invalidates the pending attempt before thread start', async (t) => {
  const workspace = createWorkspace(t);
  const methods = [];
  const harness = createSpawnHarness(workspace, (line, child) => {
    const request = JSON.parse(line);
    if (!request.method || !Object.hasOwn(request, 'id')) return;
    methods.push(request.method);
    if (request.method === 'initialize') child.send(codexResponse(request.id, {}));
    else if (request.method === 'account/login/start') {
      child.send(codexResponse(request.id, { type: 'chatgpt', loginId: LOGIN_ID, authUrl: LOGIN_URL }));
    }
  });
  let runner;
  runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    onAuthenticationRequired: () => { void runner.stop(); },
    spawnImpl: harness.spawnImpl,
    onNative() {},
  }));
  await assert.rejects(runner.start({ inputText: 'task' }), (error) => error.code === 'operation_stopped');
  const snapshot = await runner.stop();
  assert.equal(snapshot.state, 'stopped');
  assert.deepEqual(methods, ['initialize', 'account/login/start']);
});

test('bounded JSONL input rejects oversized native output without retaining it', async (t) => {
  const workspace = createWorkspace(t);
  let disconnect = null;
  const harness = createSpawnHarness(workspace, (line, child) => {
    const input = JSON.parse(line);
    if (input.type === 'user') child.sendRaw(Buffer.alloc(1024 * 1024 + 1, 0x61));
  });
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'claude', {
    getAuthentication: () => ({ oauthToken: 'oauth-secret' }),
    spawnImpl: harness.spawnImpl,
    onNative() {},
    onDisconnect: (event) => { disconnect = event; },
  }));
  await assert.rejects(runner.start({ inputText: 'task' }));
  assert.equal(runner.snapshot().failureCode, 'jsonl_buffer_limit');
  assert.equal(disconnect.reason, 'jsonl_buffer_limit');
  assert.equal(JSON.stringify(runner.snapshot()).includes('oauth-secret'), false);
  await runner.stop();
});

test('Claude refuses to bind a message whose session differs from native initialization', async (t) => {
  const workspace = createWorkspace(t);
  let disconnect = null;
  const events = [];
  const harness = createSpawnHarness(workspace, (line, child) => {
    if (JSON.parse(line).type !== 'user') return;
    child.send(
      { type: 'system', subtype: 'init', session_id: 'session_native_1' },
      {
        type: 'stream_event', session_id: 'session_native_2', parent_tool_use_id: null,
        event: { type: 'message_start', message: { id: 'message_native_1', role: 'assistant' } },
      },
    );
  });
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'claude', {
    getAuthentication: () => ({ oauthToken: 'oauth-secret' }),
    spawnImpl: harness.spawnImpl,
    onNative: (event) => events.push(event),
    onDisconnect: (event) => { disconnect = event; },
  }));
  await assert.rejects(runner.start({ inputText: 'task' }));
  assert.equal(runner.snapshot().failureCode, 'native_identity_conflict');
  assert.deepEqual(events.map((event) => event.type), ['identity']);
  assert.equal(disconnect.reason, 'native_identity_conflict');
  await runner.stop();
});

test('Codex cannot start through the runner without a trusted login presentation callback', (t) => {
  const workspace = createWorkspace(t);
  assert.throws(() => createOwnedNativeRunner(baseOptions(workspace, 'codex', { onNative() {} })),
    (error) => error.code === 'invalid_authentication_prompt');
});


test('source-current must be synchronous true before a native attempt starts', async (t) => {
  const workspace = createWorkspace(t);
  for (const sourceGuard of [
    () => false,
    () => { throw new Error('unavailable'); },
    () => Promise.reject(new Error('unavailable')),
    () => 'true',
  ]) {
    const harness = createSpawnHarness(workspace);
    const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
      isCurrent: () => true,
      isSourceCurrent: sourceGuard,
      onAuthenticationRequired() {},
      spawnImpl: harness.spawnImpl,
      onNative() {},
    }));
    await assert.rejects(runner.start({ inputText: 'task' }), (error) => error.code === 'authority_expired');
    assert.equal(harness.calls, 0);
    await runner.stop();
  }
});

test('native terminal is delivered while owner and source freshness are unavailable without ending the owned actor', async (t) => {
  const workspace = createWorkspace(t);
  const events = [];
  let ownerCurrent = true;
  let sourceCurrent = true;
  const harness = codexResponder({ workspace });
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    isCurrent: () => ownerCurrent,
    isSourceCurrent: () => sourceCurrent,
    onAuthenticationRequired: ({ loginId }) => harness.child.send(codexLoginCompleted(loginId)),
    spawnImpl: harness.spawnImpl,
    onNative: (event) => events.push(event),
  }));

  await runner.start({ inputText: 'fixed task' });
  ownerCurrent = false;
  sourceCurrent = false;
  harness.child.send(codexTurnCompleted());

  assert.deepEqual(events.map((event) => event.type), ['identity', 'context', 'context_ended']);
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().contextState, 'ended');
  assert.equal(runner.snapshot().ownedChildActive, true);
  await runner.stop();
});
function makeWaitRequest(params = {}, options = {}) {
  const request = {
    id: options.requestId || 'wait_request_1',
    method: 'item/tool/call',
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      callId: 'call_native_1',
      namespace: null,
      tool: 'cockpit_wait',
      arguments: {},
      ...params,
    },
  };
  if (options.includeJsonrpc) request.jsonrpc = options.jsonrpc || '2.0';
  if (options.omitParams) delete request.params;
  if (options.omitId) delete request.id;
  return request;
}

function makeNativeHoldRequest(requestId, method = 'item/tool/requestUserInput', overrides = {}) {
  const methodParams = method === 'item/tool/requestUserInput'
    ? { isBlocking: true, questions: [{ header: 'Choice', id: 'choice', question: 'Select an option' }] }
    : method === 'item/permissions/requestApproval'
      ? { cwd: 'C:\\workspace', permissions: {}, startedAtMs: 1 }
      : { startedAtMs: 1 };
  return {
    jsonrpc: '2.0',
    id: requestId,
    method,
    params: {
      threadId: 'thread_native_1',
      turnId: 'turn_native_1',
      itemId: 'item_native_1',
      ...methodParams,
      ...overrides,
    },
  };
}

function nativeHoldResolved(requestId, threadId = 'thread_native_1') {
  return { method: 'serverRequest/resolved', params: { requestId, threadId } };
}

function createWaitProfileHarness(workspace, options = {}) {
  const requests = [];
  const harness = createSpawnHarness(workspace, (line, child) => {
    const request = JSON.parse(line);
    if (!request.method || !Object.hasOwn(request, 'id')) return;
    requests.push(request);
    if (request.method === 'initialize') child.send(codexResponse(request.id, { serverInfo: { name: 'codex', version: 'test' } }));
    else if (request.method === 'account/login/start') {
      child.send(codexResponse(request.id, { type: 'chatgpt', loginId: LOGIN_ID, authUrl: LOGIN_URL }));
    } else if (request.method === 'thread/start') {
      child.send(codexResponse(request.id, { thread: { id: 'thread_native_1' } }));
    } else if (request.method === 'turn/start') {
      const before = options.waitCallsBeforeTurnResponse || [];
      for (const call of before) child.send(call);
      for (const nativeRequest of options.nativeRequestsBeforeTurnResponse || []) child.send(nativeRequest);
      if (options.terminalBeforeTurnResponse) child.send(codexTurnCompleted());
      child.send(codexResponse(request.id, { turn: { id: 'turn_native_1' } }));
      const after = options.waitCallsAfterTurnResponse || [];
      if (after.length) setImmediate(() => { for (const call of after) child.send(call); });
    }
  });
  harness.requests = requests;
  return harness;
}

function createWaitRunner(workspace, harness, values = {}) {
  return createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    profile: 'cockpit-native-wait-v1',
    isCurrent: values.isCurrent || (() => true),
    isSourceCurrent: values.isSourceCurrent || (() => true),
    isContextCurrent: values.isContextCurrent || (() => true),
    onAuthenticationRequired: ({ loginId }) => harness.child.send(codexLoginCompleted(loginId)),
    onWaitRequired: values.onWaitRequired || (() => {}),
    spawnImpl: harness.spawnImpl,
    onNative: values.onNative || (() => {}),
    onDisconnect: values.onDisconnect,
  }));
}

function waitReplies(harness, requestId = 'wait_request_1') {
  return harness.child.stdin.writes
    .filter((line) => line.endsWith('\n'))
    .map((line) => JSON.parse(line))
    .filter((message) => message.id === requestId && Object.hasOwn(message, 'result'));
}

function deferNextWaitResponseWrite(harness) {
  const stdin = harness.child.stdin;
  const write = stdin.write.bind(stdin);
  let complete = null;
  stdin.write = (value, callback) => {
    const line = value.toString();
    const message = JSON.parse(line);
    if (Object.hasOwn(message, 'result') && Object.hasOwn(message, 'id')) {
      stdin.writes.push(line);
      complete = callback;
      return true;
    }
    return write(value, callback);
  };
  return (error) => {
    const callback = complete;
    complete = null;
    assert.equal(typeof callback, 'function');
    callback(error);
  };
}

test('native questions and approvals bind to the current turn and accept matching terminal resolutions', async (t) => {
  const workspace = createWorkspace(t);
  const harness = createWaitProfileHarness(workspace);
  const runner = createWaitRunner(workspace, harness);
  await runner.start({ inputText: 'fixed task' });
  const requests = [
    makeNativeHoldRequest('question-request-private', 'item/tool/requestUserInput', {
      autoResolutionMs: 0,
      questions: [{ header: 'Choice', id: 'choice', question: 'Select an option', isOther: false,
        isSecret: false, options: [{ label: 'One', description: 'First option' }] }],
    }),
    makeNativeHoldRequest(1, 'item/permissions/requestApproval'),
    makeNativeHoldRequest('command-approval', 'item/commandExecution/requestApproval'),
    makeNativeHoldRequest('file-approval', 'item/fileChange/requestApproval', { startedAtMs: -1 }),
  ];
  harness.child.send(...requests);
  assert.equal(runner.snapshot().state, 'running');
  const snapshot = JSON.stringify(runner.snapshot());
  for (const privateValue of ['question-request-private', 'command-approval', 'file-approval', 'Select an option', 'First option', 'item_native_1']) {
    assert.equal(snapshot.includes(privateValue), false);
  }
  harness.child.send(codexTurnCompleted());
  for (const request of requests) harness.child.send(nativeHoldResolved(request.id));
  assert.equal(runner.snapshot().state, 'running');
  const replies = harness.child.stdin.writes.filter((line) => line.endsWith('\n'))
    .map((line) => JSON.parse(line))
    .filter((message) => !Object.hasOwn(message, 'method') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')));
  assert.equal(replies.length, 0);
  await runner.stop();
});

test('native pending summaries expose matching kind counts and invalidate replaced request sets', async (t) => {
  const workspace = createWorkspace(t);
  const harness = createWaitProfileHarness(workspace);
  const runner = createWaitRunner(workspace, harness);
  await runner.start({ inputText: 'fixed task' });

  const empty = runner.captureNativePendingSummary('thread_native_1', 'turn_native_1');
  assert.deepEqual(empty.pending, []);
  assert.equal(empty.checkCurrent(), true);
  assert.equal(runner.captureNativePendingSummary('thread_other', 'turn_native_1'), null);

  const questionId = 'private-question-request';
  const questionItemId = 'private-question-item';
  const approvalId = 'private-approval-request';
  harness.child.send(
    makeNativeHoldRequest(questionId, 'item/tool/requestUserInput', {
      itemId: questionItemId,
      questions: [{ header: 'Secret header', id: 'private-question', question: 'Secret question' }],
    }),
    makeNativeHoldRequest(approvalId, 'item/commandExecution/requestApproval', { itemId: 'private-approval-item' }),
  );
  assert.equal(empty.checkCurrent(), false);
  const captured = runner.captureNativePendingSummary('thread_native_1', 'turn_native_1');
  assert.deepEqual(captured.pending, [{ kind: 'question', count: 1 }, { kind: 'approval', count: 1 }]);
  assert.equal(captured.checkCurrent(), true);
  const publicSummary = JSON.stringify(captured.pending);
  for (const privateValue of [questionId, questionItemId, approvalId, 'private-approval-item', 'Secret header', 'Secret question']) {
    assert.equal(publicSummary.includes(privateValue), false);
  }

  harness.child.send(nativeHoldResolved(questionId));
  harness.child.send(makeNativeHoldRequest('replacement-question-request'));
  const replacement = runner.captureNativePendingSummary('thread_native_1', 'turn_native_1');
  assert.deepEqual(replacement.pending, captured.pending);
  assert.equal(captured.checkCurrent(), false);
  assert.equal(replacement.checkCurrent(), true);
  harness.child.send(nativeHoldResolved('replacement-question-request'));
  harness.child.send(nativeHoldResolved(approvalId));
  assert.equal(replacement.checkCurrent(), false);
  await runner.stop();
  assert.equal(runner.captureNativePendingSummary('thread_native_1', 'turn_native_1'), null);
});

test('native request IDs distinguish strings from integers and cannot be reused after resolution', async (t) => {
  const workspace = createWorkspace(t);
  const harness = createWaitProfileHarness(workspace);
  const runner = createWaitRunner(workspace, harness);
  await runner.start({ inputText: 'fixed task' });
  harness.child.send(
    makeNativeHoldRequest('1'),
    makeNativeHoldRequest(1, 'item/commandExecution/requestApproval'),
    makeNativeHoldRequest('-opaque-string-id'),
    makeNativeHoldRequest(-1, 'item/fileChange/requestApproval'),
  );
  harness.child.send(nativeHoldResolved(1));
  assert.equal(runner.snapshot().state, 'running');
  harness.child.send(nativeHoldResolved('1'));
  assert.equal(runner.snapshot().state, 'running');
  harness.child.send(nativeHoldResolved(-1));
  assert.equal(runner.snapshot().state, 'running');
  harness.child.send(nativeHoldResolved('-opaque-string-id'));
  assert.equal(runner.snapshot().state, 'running');
  harness.child.send(makeNativeHoldRequest('used-once'));
  harness.child.send(nativeHoldResolved('used-once'));
  harness.child.send(makeNativeHoldRequest('used-once'));
  assert.equal(runner.snapshot().failureCode, 'native_server_request_id_reused');
  await runner.stop();
});

test('native request violations fail closed while unmatched resolutions are counted without replies', async (t) => {
  const cases = [
    {
      run(harness) { harness.child.send(makeNativeHoldRequest('wrong-thread', 'item/tool/requestUserInput', { threadId: 'thread_other' })); },
      failureCode: 'native_server_request_scope_mismatch',
    },
    {
      run(harness) { harness.child.send(makeNativeHoldRequest('wrong-turn', 'item/tool/requestUserInput', { turnId: 'turn_other' })); },
      failureCode: 'native_server_request_scope_mismatch',
    },
    {
      run(harness) { harness.child.send(nativeHoldResolved('unknown')); },
      unmatchedResolutionCount: 1,
    },
    {
      run(harness) {
        harness.child.send(makeNativeHoldRequest('mismatch'));
        harness.child.send(nativeHoldResolved('mismatch', 'thread_other'));
      },
      unmatchedResolutionCount: 1,
    },
    {
      run(harness) {
        harness.child.send(makeNativeHoldRequest('duplicate-pending'));
        harness.child.send(makeNativeHoldRequest('duplicate-pending'));
      },
      failureCode: 'native_server_request_id_reused',
    },
    {
      run(harness) {
        harness.child.send(makeNativeHoldRequest('double-resolution'));
        harness.child.send(nativeHoldResolved('double-resolution'));
        harness.child.send(nativeHoldResolved('double-resolution'));
      },
      unmatchedResolutionCount: 1,
    },
    {
      run(harness) {
        harness.child.send(makeNativeHoldRequest('wrong-turn-resolution'));
        harness.child.send({ method: 'serverRequest/resolved', params: {
          requestId: 'wrong-turn-resolution', threadId: 'thread_native_1', turnId: 'turn_other',
        } });
      },
      unmatchedResolutionCount: 1,
    },
    {
      run(harness) { harness.child.send(makeNativeHoldRequest('malformed', 'item/fileChange/requestApproval', { startedAtMs: undefined })); },
      failureCode: 'native_server_request_invalid',
    },
  ];
  for (const scenario of cases) {
    const workspace = createWorkspace(t);
    const harness = createWaitProfileHarness(workspace);
    const runner = createWaitRunner(workspace, harness);
    await runner.start({ inputText: 'fixed task' });
    scenario.run(harness);
    if (scenario.failureCode) assert.equal(runner.snapshot().failureCode, scenario.failureCode);
    else {
      assert.equal(runner.snapshot().state, 'running');
      assert.equal(runner.snapshot().unmatchedResolutionCount, 1);
    }
    const replies = harness.child.stdin.writes.filter((line) => line.endsWith('\n'))
      .map((line) => JSON.parse(line))
      .filter((message) => !Object.hasOwn(message, 'method') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')));
    assert.equal(replies.length, 0);
    await runner.stop();
  }
});

test('known native requests and resolutions accept extension fields while retaining required scope checks', async (t) => {
  const workspace = createWorkspace(t);
  const harness = createWaitProfileHarness(workspace);
  const runner = createWaitRunner(workspace, harness);
  await runner.start({ inputText: 'fixed task' });

  const request = makeNativeHoldRequest('extension-fields', 'item/tool/requestUserInput', {
    futureContext: { revision: 2 },
    questions: [{ header: 'Choice', id: 'choice', question: 'Select an option', futureQuestionField: true }],
  });
  request.futureRequestField = 'ignored';
  harness.child.send(request);
  const resolved = nativeHoldResolved('extension-fields');
  resolved.params.turnId = 'turn_native_1';
  resolved.params.futureResolutionField = 'ignored';
  resolved.futureNotificationField = true;
  harness.child.send(resolved);

  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().failureCode, null);
  assert.deepEqual(runner.captureNativePendingSummary('thread_native_1', 'turn_native_1').pending, []);
  await runner.stop();
});

test('native request ID retention is bounded and overflow holds without clearing IDs', async (t) => {
  const workspace = createWorkspace(t);
  const harness = createWaitProfileHarness(workspace);
  const runner = createWaitRunner(workspace, harness);
  await runner.start({ inputText: 'fixed task' });
  const requests = Array.from({ length: 128 }, (_, index) => makeNativeHoldRequest(index + 1));
  harness.child.send(...requests);
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().nativeRequestIdCount, 128);
  assert.equal(runner.snapshot().nativeRequestIdRemaining, 0);
  assert.equal(runner.snapshot().nativeRequestOverflow, false);
  assert.equal(runner.captureNativePendingSummary('thread_native_1', 'turn_native_1').pending[0].count, 128);
  harness.child.send(makeNativeHoldRequest(129));
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().failureCode, null);
  assert.equal(runner.snapshot().nativeRequestIdCount, 128);
  assert.equal(runner.snapshot().nativeRequestIdRemaining, 0);
  assert.equal(runner.snapshot().nativeRequestOverflow, true);
  assert.equal(runner.captureNativePendingSummary('thread_native_1', 'turn_native_1'), null);
  for (const request of requests) harness.child.send(nativeHoldResolved(request.id));
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().nativeRequestIdCount, 128);
  assert.equal(runner.snapshot().nativeRequestOverflow, true);
  assert.equal(runner.captureNativePendingSummary('thread_native_1', 'turn_native_1'), null);
  const replies = harness.child.stdin.writes.filter((line) => line.endsWith('\n'))
    .map((line) => JSON.parse(line))
    .filter((message) => !Object.hasOwn(message, 'method') && (Object.hasOwn(message, 'result') || Object.hasOwn(message, 'error')));
  assert.equal(replies.length, 0);
  await runner.stop();
});

test('a native hold request during turn start enters a persistent hold until explicit stop', async (t) => {
  const workspace = createWorkspace(t);
  const harness = createWaitProfileHarness(workspace, {
    nativeRequestsBeforeTurnResponse: [makeNativeHoldRequest('early-native-request')],
  });
  const runner = createWaitRunner(workspace, harness);
  await runner.start({ inputText: 'fixed task' });

  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().failureCode, null);
  assert.equal(runner.snapshot().unknownServerRequestHeld, true);
  assert.equal(runner.snapshot().nativeRequestIdCount, 1);
  assert.equal(runner.captureNativePendingSummary('thread_native_1', 'turn_native_1'), null);
  assert.equal(harness.child.stdin.writes.some((line) => line.includes('early-native-request')), false);
  await runner.stop();
});

test('the fixed Codex wait profile queues one early native call and returns one static JSONL response', async (t) => {
  const workspace = createWorkspace(t);
  const events = [];
  let receipt = null;
  const harness = createWaitProfileHarness(workspace, {
    waitCallsBeforeTurnResponse: [makeWaitRequest()],
  });
  const runner = createWaitRunner(workspace, harness, {
    onNative: (event) => events.push(event),
    onWaitRequired: (value) => {
      assert.deepEqual(events.map((event) => event.type), ['identity', 'context']);
      receipt = value;
    },
  });

  assert.equal(harness.calls, 0);
  await runner.start({ inputText: 'fixed task' });
  const initialize = harness.requests.find((request) => request.method === 'initialize');
  const threadStart = harness.requests.find((request) => request.method === 'thread/start');
  assert.equal(initialize.params.capabilities.experimentalApi, true);
  assert.deepEqual(threadStart.params.dynamicTools, [{
    type: 'function',
    name: 'cockpit_wait',
    description: 'Wait for the trusted host to resume this task.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  }]);
  assert.equal(Object.isFrozen(receipt), true);
  assert.deepEqual(Object.keys(receipt), []);
  assert.equal(waitReplies(harness).length, 0);

  assert.equal(runner.releaseWait(receipt), true);
  const replies = waitReplies(harness);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0], {
    jsonrpc: '2.0',
    id: 'wait_request_1',
    result: { contentItems: [{ type: 'inputText', text: 'released' }], success: true },
  });
  assert.equal(harness.child.stdin.writes.at(-1).endsWith('\n'), true);
  assert.equal(runner.releaseWait(receipt), false);
  assert.equal(runner.cancelWait(receipt), false);
  const snapshotText = JSON.stringify(runner.snapshot());
  assert.equal(snapshotText.includes('wait_request_1'), false);
  assert.equal(snapshotText.includes('call_native_1'), false);
  await runner.stop();
});

test('a wait request without jsonrpc is accepted only with exact native correlation fields', async (t) => {
  const workspace = createWorkspace(t);
  let receipt = null;
  const harness = createWaitProfileHarness(workspace, {
    waitCallsAfterTurnResponse: [makeWaitRequest()],
  });
  const runner = createWaitRunner(workspace, harness, { onWaitRequired: (value) => { receipt = value; } });

  await runner.start({ inputText: 'fixed task' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  assert.equal(runner.cancelWait(receipt), true);
  assert.deepEqual(waitReplies(harness)[0], {
    jsonrpc: '2.0',
    id: 'wait_request_1',
    result: { contentItems: [{ type: 'inputText', text: 'cancelled' }], success: false },
  });
  await runner.stop();
});

test('a resolved notification confirms a written owned wait once and remains scoped after turn end', async (t) => {
  const workspace = createWorkspace(t);
  let receipt = null;
  const harness = createWaitProfileHarness(workspace, {
    waitCallsAfterTurnResponse: [makeWaitRequest()],
  });
  const runner = createWaitRunner(workspace, harness, { onWaitRequired: (value) => { receipt = value; } });

  await runner.start({ inputText: 'fixed task' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  assert.equal(runner.releaseWait(receipt), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waitReplies(harness).length, 1);

  harness.child.send(codexTurnCompleted());
  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.snapshot().state, 'running');
  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().unmatchedResolutionCount, 1);
  await runner.stop();
});

test('a late resolution for an invalidated active wait is consumed once after turn completion', async (t) => {
  const workspace = createWorkspace(t);
  let receipt = null;
  const events = [];
  const harness = createWaitProfileHarness(workspace, {
    waitCallsAfterTurnResponse: [makeWaitRequest()],
  });
  const runner = createWaitRunner(workspace, harness, {
    onNative: (event) => events.push(event),
    onWaitRequired: (value) => { receipt = value; },
  });

  await runner.start({ inputText: 'fixed task' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  harness.child.send(codexTurnCompleted());
  assert.deepEqual(events.map((event) => event.type), ['identity', 'context', 'context_ended']);
  assert.equal(waitReplies(harness).length, 0);

  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.snapshot().state, 'running');
  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().unmatchedResolutionCount, 1);
  await runner.stop();
});

test('a late resolution for an early wait invalidated by turn completion keeps the runner alive', async (t) => {
  const workspace = createWorkspace(t);
  const events = [];
  const harness = createWaitProfileHarness(workspace, {
    waitCallsBeforeTurnResponse: [makeWaitRequest()],
    terminalBeforeTurnResponse: true,
  });
  const runner = createWaitRunner(workspace, harness, { onNative: (event) => events.push(event) });

  await runner.start({ inputText: 'fixed task' });
  assert.deepEqual(events.map((event) => event.type), ['identity', 'context_ended']);
  assert.equal(waitReplies(harness).length, 0);
  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.snapshot().state, 'running');
  await runner.stop();
});

test('an early terminal and wait resolution in one turn-start batch are reconciled after the RPC response', async (t) => {
  const workspace = createWorkspace(t);
  const events = [];
  let callbacks = 0;
  const harness = createWaitProfileHarness(workspace, {
    waitCallsBeforeTurnResponse: [
      makeWaitRequest(),
      codexTurnCompleted(),
      nativeHoldResolved('wait_request_1'),
    ],
  });
  const runner = createWaitRunner(workspace, harness, {
    onNative: (event) => events.push(event),
    onWaitRequired: () => { callbacks += 1; },
  });

  const snapshot = await runner.start({ inputText: 'fixed task' });
  assert.equal(snapshot.state, 'running');
  assert.equal(snapshot.contextState, 'ended');
  assert.deepEqual(events.map((event) => event.type), ['identity', 'context_ended']);
  assert.equal(callbacks, 0);
  assert.equal(waitReplies(harness).length, 0);
  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().unmatchedResolutionCount, 1);
  await runner.stop();
});

test('a deferred early wait resolution is discarded when the turn response has a different ID', async (t) => {
  const workspace = createWorkspace(t);
  const harness = createWaitProfileHarness(workspace, {
    waitCallsBeforeTurnResponse: [
      makeWaitRequest({ turnId: 'turn_native_2' }),
      codexTurnCompleted('thread_native_1', 'turn_native_2'),
      nativeHoldResolved('wait_request_1'),
    ],
  });
  const runner = createWaitRunner(workspace, harness);

  await assert.rejects(runner.start({ inputText: 'fixed task' }));
  assert.equal(runner.snapshot().failureCode, 'wait_request_context_mismatch');
  assert.equal(waitReplies(harness).length, 0);
  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.snapshot().failureCode, 'wait_request_context_mismatch');
  await runner.stop();
});

test('a deferred early wait resolution is not replayed after stop or failure', async (t) => {
  for (const outcome of ['stop', 'failure']) {
    const workspace = createWorkspace(t);
    const events = [];
    const harness = createWaitProfileHarness(workspace, {
      waitCallsBeforeTurnResponse: [
        makeWaitRequest(),
        codexTurnCompleted(),
        nativeHoldResolved('wait_request_1'),
      ],
    });
    let runner;
    runner = createWaitRunner(workspace, harness, {
      onNative: (event) => {
        events.push(event.type);
        if (event.type !== 'context_ended') return;
        if (outcome === 'stop') void runner.stop();
        else throw new Error('synthetic notification failure');
      },
    });

    await assert.rejects(runner.start({ inputText: 'fixed task' }));
    assert.deepEqual(events, ['identity', 'context_ended']);
    assert.equal(waitReplies(harness).length, 0);
    const failureCode = runner.snapshot().failureCode;
    assert.equal(failureCode, outcome === 'failure' ? 'native_callback_failed' : null);
    harness.child.send(nativeHoldResolved('wait_request_1'));
    assert.equal(runner.snapshot().failureCode, failureCode);
    if (outcome === 'stop') assert.equal((await runner.stop()).state, 'stopped');
    else await runner.stop();
  }
});

test('early wait resolutions count unknown IDs, type or thread mismatches, and duplicates without consuming records', async (t) => {
  const scenarios = [
    { waitId: 'wait_request_1', requestId: 'unknown', threadId: 'thread_native_1', unmatchedResolutionCount: 1 },
    { waitId: 7, requestId: '7', threadId: 'thread_native_1', unmatchedResolutionCount: 1 },
    { waitId: 'wait_request_1', requestId: 'wait_request_1', threadId: 'thread_other', unmatchedResolutionCount: 1 },
    { waitId: 'wait_request_1', requestId: 'wait_request_1', threadId: 'thread_native_1', duplicate: true, unmatchedResolutionCount: 1 },
  ];
  for (const scenario of scenarios) {
    const workspace = createWorkspace(t);
    const resolution = nativeHoldResolved(scenario.requestId, scenario.threadId);
    const messages = [
      makeWaitRequest({}, { requestId: scenario.waitId }),
      codexTurnCompleted(),
      resolution,
      ...(scenario.duplicate ? [resolution] : []),
    ];
    const harness = createWaitProfileHarness(workspace, { waitCallsBeforeTurnResponse: messages });
    const runner = createWaitRunner(workspace, harness);

    await runner.start({ inputText: 'fixed task' });
    assert.equal(runner.snapshot().failureCode, null);
    assert.equal(runner.snapshot().state, 'running');
    assert.equal(runner.snapshot().unmatchedResolutionCount, scenario.unmatchedResolutionCount);
    assert.equal(waitReplies(harness).length, 0);
    harness.child.send(nativeHoldResolved(scenario.waitId));
    assert.equal(runner.snapshot().state, 'running');
    assert.equal(runner.snapshot().unmatchedResolutionCount, scenario.duplicate ? 2 : 1);
    harness.child.send(nativeHoldResolved(scenario.waitId));
    assert.equal(runner.snapshot().unmatchedResolutionCount, scenario.duplicate ? 3 : 2);
    await runner.stop();
  }
});

test('a discarded wait resolution does not change a later native hold capture', async (t) => {
  const workspace = createWorkspace(t);
  let contextCurrent = true;
  let receipt = null;
  const harness = createWaitProfileHarness(workspace, {
    waitCallsAfterTurnResponse: [makeWaitRequest()],
  });
  const runner = createWaitRunner(workspace, harness, {
    isContextCurrent: () => contextCurrent,
    onWaitRequired: (value) => { receipt = value; },
  });

  await runner.start({ inputText: 'fixed task' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  harness.child.send(makeNativeHoldRequest('later-hold'));
  contextCurrent = false;
  assert.equal(runner.releaseWait(receipt), true);
  contextCurrent = true;
  assert.equal(waitReplies(harness).length, 0);

  const pending = runner.captureNativePendingSummary('thread_native_1', 'turn_native_1');
  assert.deepEqual(pending.pending, [{ kind: 'question', count: 1 }]);
  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(pending.checkCurrent(), true);
  harness.child.send(nativeHoldResolved('later-hold'));
  assert.equal(pending.checkCurrent(), false);
  await runner.stop();
});

test('retired wait resolutions still require the original ID type and thread', async (t) => {
  const scenarios = [
    { waitId: 7, resolution: nativeHoldResolved('7'), unmatchedResolutionCount: 1 },
    { waitId: 'wrong-thread-wait', resolution: nativeHoldResolved('wrong-thread-wait', 'thread_other'), unmatchedResolutionCount: 1 },
  ];
  for (const scenario of scenarios) {
    const workspace = createWorkspace(t);
    const harness = createWaitProfileHarness(workspace, {
      waitCallsAfterTurnResponse: [makeWaitRequest({}, { requestId: scenario.waitId })],
    });
    const runner = createWaitRunner(workspace, harness);
    await runner.start({ inputText: 'fixed task' });
    await new Promise((resolve) => setImmediate(resolve));
    harness.child.send(codexTurnCompleted());
    harness.child.send(scenario.resolution);
    assert.equal(runner.snapshot().failureCode, null);
    assert.equal(runner.snapshot().state, 'running');
    assert.equal(runner.snapshot().unmatchedResolutionCount, scenario.unmatchedResolutionCount);
    harness.child.send(nativeHoldResolved(scenario.waitId));
    assert.equal(runner.snapshot().state, 'running');
    assert.equal(runner.snapshot().unmatchedResolutionCount, 1);
    harness.child.send(nativeHoldResolved(scenario.waitId));
    assert.equal(runner.snapshot().unmatchedResolutionCount, 2);
    await runner.stop();
  }
});

test('a resolved notification may precede the owned wait write callback but cannot confirm a failed write', async (t) => {
  for (const writeError of [null, new Error('private write failure')]) {
    const workspace = createWorkspace(t);
    let receipt = null;
    const harness = createWaitProfileHarness(workspace, {
      waitCallsAfterTurnResponse: [makeWaitRequest()],
    });
    const runner = createWaitRunner(workspace, harness, { onWaitRequired: (value) => { receipt = value; } });

    await runner.start({ inputText: 'fixed task' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(receipt);
    const completeWrite = deferNextWaitResponseWrite(harness);
    assert.equal(runner.releaseWait(receipt), true);
    harness.child.send(nativeHoldResolved('wait_request_1'));
    assert.equal(runner.snapshot().state, 'running');
    completeWrite(writeError);
    if (writeError) {
      assert.equal(runner.snapshot().failureCode, 'wait_response_write_failed');
    } else {
      assert.equal(runner.snapshot().state, 'running');
      assert.equal(waitReplies(harness).length, 1);
    }
    await runner.stop();
  }
});

test('late wait resolution and write callback cannot restore a stopped runner', async (t) => {
  const workspace = createWorkspace(t);
  let receipt = null;
  const harness = createWaitProfileHarness(workspace, {
    waitCallsAfterTurnResponse: [makeWaitRequest()],
  });
  const runner = createWaitRunner(workspace, harness, { onWaitRequired: (value) => { receipt = value; } });
  await runner.start({ inputText: 'fixed task' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  const completeWrite = deferNextWaitResponseWrite(harness);
  assert.equal(runner.releaseWait(receipt), true);

  await runner.stop();
  harness.child.send(nativeHoldResolved('wait_request_1'));
  completeWrite();
  assert.equal(runner.snapshot().state, 'stopped');
  assert.equal(runner.snapshot().failureCode, null);
});

test('resolving an owned wait after turn end leaves a different native hold independently resolvable', async (t) => {
  const workspace = createWorkspace(t);
  let receipt = null;
  const harness = createWaitProfileHarness(workspace, {
    waitCallsAfterTurnResponse: [makeWaitRequest()],
  });
  const runner = createWaitRunner(workspace, harness, { onWaitRequired: (value) => { receipt = value; } });
  await runner.start({ inputText: 'fixed task' });
  harness.child.send(makeNativeHoldRequest('pending-question'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  assert.equal(runner.releaseWait(receipt), true);
  await new Promise((resolve) => setImmediate(resolve));

  const pending = runner.captureNativePendingSummary('thread_native_1', 'turn_native_1');
  assert.deepEqual(pending.pending, [{ kind: 'question', count: 1 }]);
  harness.child.send(codexTurnCompleted());
  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(pending.checkCurrent(), false);
  harness.child.send(nativeHoldResolved('pending-question'));
  assert.equal(runner.snapshot().state, 'running');
  await runner.stop();
});

test('owned wait resolutions count different IDs, ID types, and threads without consuming records', async (t) => {
  const cases = [
    { waitId: 'owned-wait', resolution: nativeHoldResolved('other-wait'), unmatchedResolutionCount: 1 },
    { waitId: 7, resolution: nativeHoldResolved('7'), unmatchedResolutionCount: 1 },
    { waitId: 'wrong-thread-wait', resolution: nativeHoldResolved('wrong-thread-wait', 'thread_other'), unmatchedResolutionCount: 1 },
  ];
  for (const scenario of cases) {
    const workspace = createWorkspace(t);
    let receipt = null;
    const harness = createWaitProfileHarness(workspace, {
      waitCallsAfterTurnResponse: [makeWaitRequest({}, { requestId: scenario.waitId })],
    });
    const runner = createWaitRunner(workspace, harness, { onWaitRequired: (value) => { receipt = value; } });
    await runner.start({ inputText: 'fixed task' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(receipt);
    assert.equal(runner.releaseWait(receipt), true);
    await new Promise((resolve) => setImmediate(resolve));
    harness.child.send(scenario.resolution);
    assert.equal(runner.snapshot().failureCode, null);
    assert.equal(runner.snapshot().state, 'running');
    assert.equal(runner.snapshot().unmatchedResolutionCount, scenario.unmatchedResolutionCount);
    harness.child.send(nativeHoldResolved(scenario.waitId));
    assert.equal(runner.snapshot().state, 'running');
    assert.equal(runner.snapshot().unmatchedResolutionCount, 1);
    harness.child.send(nativeHoldResolved(scenario.waitId));
    assert.equal(runner.snapshot().unmatchedResolutionCount, 2);
    await runner.stop();
  }
});

test('native request IDs cannot collide with an owned wait in either arrival order', async (t) => {
  const scenarios = [
    {
      events: [makeWaitRequest({}, { requestId: 'shared-request-id' }), makeNativeHoldRequest('shared-request-id')],
      expectedCallbacks: 1,
    },
    {
      events: [makeNativeHoldRequest('shared-request-id'), makeWaitRequest({}, { requestId: 'shared-request-id' })],
      expectedCallbacks: 0,
    },
  ];
  for (const scenario of scenarios) {
    const workspace = createWorkspace(t);
    let callbacks = 0;
    const harness = createWaitProfileHarness(workspace, { waitCallsAfterTurnResponse: scenario.events });
    const runner = createWaitRunner(workspace, harness, { onWaitRequired: () => { callbacks += 1; } });
    await runner.start({ inputText: 'fixed task' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(runner.snapshot().failureCode, 'native_server_request_id_reused');
    assert.equal(callbacks, scenario.expectedCallbacks);
    assert.equal(waitReplies(harness).length, 0);
    await runner.stop();
  }
});

test('owned wait IDs share the request limit and overflow prevents wait delivery', async (t) => {
  const workspace = createWorkspace(t);
  let receipt = null;
  const harness = createWaitProfileHarness(workspace, {
    waitCallsAfterTurnResponse: [makeWaitRequest()],
  });
  const runner = createWaitRunner(workspace, harness, { onWaitRequired: (value) => { receipt = value; } });
  await runner.start({ inputText: 'fixed task' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  harness.child.send(...Array.from({ length: 127 }, (_, index) => makeNativeHoldRequest(`request-${index}`)));
  assert.equal(runner.snapshot().state, 'running');
  harness.child.send(makeNativeHoldRequest('request-overflow'));
  assert.equal(runner.snapshot().failureCode, null);
  assert.equal(runner.snapshot().nativeRequestIdCount, 128);
  assert.equal(runner.snapshot().nativeRequestIdRemaining, 0);
  assert.equal(runner.snapshot().nativeRequestOverflow, true);
  assert.equal(runner.snapshot().retiredOwnedWaitRequestCount, 1);
  assert.equal(runner.releaseWait(receipt), false);
  assert.equal(runner.cancelWait(receipt), false);
  assert.equal(waitReplies(harness).length, 0);
  for (let index = 0; index < 127; index += 1) harness.child.send(nativeHoldResolved(`request-${index}`));
  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().nativeRequestOverflow, true);
  assert.equal(runner.snapshot().nativeRequestIdCount, 128);
  assert.equal(runner.snapshot().retiredOwnedWaitRequestCount, 0);
  assert.equal(runner.captureNativePendingSummary('thread_native_1', 'turn_native_1'), null);
  await runner.stop();
});

test('wait requests with missing or conflicting fields fail closed without a reply', async (t) => {
  const invalidCalls = [
    makeWaitRequest({ threadId: 'thread_other' }),
    makeWaitRequest({ turnId: 'turn_other' }),
    makeWaitRequest({ namespace: 'other_namespace' }),
    makeWaitRequest({ tool: 'other_tool' }),
    makeWaitRequest({ arguments: { command: 'private' } }),
    makeWaitRequest({}, { includeJsonrpc: true, jsonrpc: '1.0' }),
    (() => { const call = makeWaitRequest(); delete call.params.threadId; return call; })(),
  ];
  for (const call of invalidCalls) {
    const workspace = createWorkspace(t);
    let callbacks = 0;
    const harness = createWaitProfileHarness(workspace, { waitCallsBeforeTurnResponse: [call] });
    const runner = createWaitRunner(workspace, harness, { onWaitRequired: () => { callbacks += 1; } });

    await assert.rejects(runner.start({ inputText: 'fixed task' }));
    assert.equal(callbacks, 0);
    assert.equal(waitReplies(harness).length, 0);
    await runner.stop();
  }
});

test('one queued wait request cannot be duplicated before turn start resolves', async (t) => {
  const workspace = createWorkspace(t);
  let callbacks = 0;
  const harness = createWaitProfileHarness(workspace, {
    waitCallsBeforeTurnResponse: [makeWaitRequest(), makeWaitRequest({}, { requestId: 'wait_request_2' })],
  });
  const runner = createWaitRunner(workspace, harness, { onWaitRequired: () => { callbacks += 1; } });

  await assert.rejects(runner.start({ inputText: 'fixed task' }));
  assert.equal(callbacks, 0);
  assert.equal(waitReplies(harness).length, 0);
  assert.equal(waitReplies(harness, 'wait_request_2').length, 0);
  await runner.stop();
});

test('turn completion invalidates the wait receipt without answering the native request', async (t) => {
  const workspace = createWorkspace(t);
  let receipt = null;
  const events = [];
  const harness = createWaitProfileHarness(workspace, {
    waitCallsAfterTurnResponse: [makeWaitRequest()],
  });
  const runner = createWaitRunner(workspace, harness, {
    onNative: (event) => events.push(event),
    onWaitRequired: (value) => { receipt = value; },
  });

  await runner.start({ inputText: 'fixed task' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  harness.child.send(codexTurnCompleted());
  assert.deepEqual(events.map((event) => event.type), ['identity', 'context', 'context_ended']);
  assert.equal(runner.releaseWait(receipt), false);
  assert.equal(waitReplies(harness).length, 0);
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().ownedChildActive, true);
  await runner.stop();
});

test('a stale owner, source, or context guard suppresses the wait reply without ending the actor', async (t) => {
  for (const staleGuard of ['owner', 'source', 'context']) {
    const workspace = createWorkspace(t);
    let current = true;
    let receipt = null;
    const harness = createWaitProfileHarness(workspace, {
      waitCallsAfterTurnResponse: [makeWaitRequest()],
    });
    const runner = createWaitRunner(workspace, harness, {
      isCurrent: () => staleGuard === 'owner' ? current : true,
      isSourceCurrent: () => staleGuard === 'source' ? current : true,
      isContextCurrent: () => staleGuard === 'context' ? current : true,
      onWaitRequired: (value) => { receipt = value; },
    });

    await runner.start({ inputText: 'fixed task' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(receipt);
    current = false;
    assert.equal(runner.releaseWait(receipt), true);
    assert.equal(waitReplies(harness).length, 0);
    assert.equal(runner.snapshot().state, 'running');
    assert.equal(runner.snapshot().contextState, 'active');
    assert.equal(runner.snapshot().ownedChildActive, true);
    current = true;
    assert.equal(runner.releaseWait(receipt), false);
    await runner.stop();
  }
});

test('a reentrant owner change during source validation prevents the final wait write', async (t) => {
  const workspace = createWorkspace(t);
  let receipt = null;
  let ownerCurrent = true;
  let armed = false;
  const harness = createWaitProfileHarness(workspace, {
    waitCallsAfterTurnResponse: [makeWaitRequest()],
  });
  const runner = createWaitRunner(workspace, harness, {
    isCurrent: () => ownerCurrent,
    isSourceCurrent: () => {
      if (armed) ownerCurrent = false;
      return true;
    },
    onWaitRequired: (value) => { receipt = value; },
  });

  await runner.start({ inputText: 'fixed task' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  armed = true;
  assert.equal(runner.releaseWait(receipt), true);
  assert.equal(waitReplies(harness).length, 0);
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().ownedChildActive, true);
  await runner.stop();
});

test('unknown server requests hold an active wait without failing or sending a response', async (t) => {
  const firstWorkspace = createWorkspace(t);
  const secondWorkspace = createWorkspace(t);
  let firstReceipt = null;
  let secondReceipt = null;
  const firstHarness = createWaitProfileHarness(firstWorkspace, {
    waitCallsAfterTurnResponse: [makeWaitRequest()],
  });
  const secondHarness = createWaitProfileHarness(secondWorkspace, {
    waitCallsAfterTurnResponse: [makeWaitRequest()],
  });
  const first = createWaitRunner(firstWorkspace, firstHarness, { onWaitRequired: (value) => { firstReceipt = value; } });
  const second = createWaitRunner(secondWorkspace, secondHarness, { onWaitRequired: (value) => { secondReceipt = value; } });

  await Promise.all([
    first.start({ inputText: 'fixed task' }),
    second.start({ inputText: 'fixed task' }),
  ]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(firstReceipt);
  assert.ok(secondReceipt);
  assert.equal(second.releaseWait(firstReceipt), false);
  assert.equal(second.releaseWait(secondReceipt), true);
  assert.equal(first.releaseWait(firstReceipt), true);
  assert.equal(waitReplies(firstHarness).length, 1);
  assert.equal(waitReplies(secondHarness).length, 1);
  await Promise.all([first.stop(), second.stop()]);

  const unknownWorkspace = createWorkspace(t);
  let receipt = null;
  const unknownHarness = createWaitProfileHarness(unknownWorkspace, {
    waitCallsAfterTurnResponse: [makeWaitRequest()],
  });
  const unknownRunner = createWaitRunner(unknownWorkspace, unknownHarness, {
    onWaitRequired: (value) => { receipt = value; },
  });
  await unknownRunner.start({ inputText: 'fixed task' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  unknownHarness.child.send({
    id: 'permission_request_1',
    method: 'mcpServer/elicitation/request',
    params: { command: 'private' },
  });
  assert.equal(unknownHarness.child.stdin.writes.some((line) => line.includes('permission_request_1')), false);
  assert.equal(unknownRunner.snapshot().state, 'running');
  assert.equal(unknownRunner.snapshot().failureCode, null);
  assert.equal(unknownRunner.snapshot().unknownServerRequestHeld, true);
  assert.equal(unknownRunner.releaseWait(receipt), false);
  assert.equal(waitReplies(unknownHarness).length, 0);
  await unknownRunner.stop();
});

test('native request overflow invalidates prepared instruction checks', async (t) => {
  const workspace = createWorkspace(t);
  const claim = Object.freeze({});
  const harness = createOwnedCodexHarness(workspace);
  let capability = null;
  const runner = createOwnedCodexRunner(workspace, harness, claim, {
    onSourceReady: (value) => { capability = value; },
  });
  await runner.start({ inputText: 'fixed task' });
  const source = getOwnedSource(capability);
  assert.equal(source.bindOwner(claim), true);
  source.acquireReadLease(Object.freeze({}));

  const metadata = ownedCodexInstructionMetadata();
  const writer = getOwnedInstructionWriter(capability);
  const token = writer.prepare(metadata);
  assert.ok(token);
  assert.equal(writer.check(token), true);

  const requests = Array.from({ length: 128 }, (_, index) => makeNativeHoldRequest(index + 1));
  harness.child.send(...requests);
  for (const request of requests) harness.child.send(nativeHoldResolved(request.id));
  assert.equal(runner.canPrepareInstruction(metadata), true);
  harness.child.send(makeNativeHoldRequest(129));

  assert.equal(runner.snapshot().nativeRequestOverflow, true);
  assert.equal(runner.canPrepareInstruction(metadata), false);
  assert.equal(writer.check(token), false);
  await runner.stop();
});

test('native holds during a follow-up turn start do not compare against the ended context', async (t) => {
  const workspace = createWorkspace(t);
  const claim = Object.freeze({});
  const harness = createOwnedCodexHarness(workspace);
  let capability = null;
  const runner = createOwnedCodexRunner(workspace, harness, claim, {
    onSourceReady: (value) => { capability = value; },
  });
  await runner.start({ inputText: 'fixed task' });
  const source = getOwnedSource(capability);
  assert.equal(source.bindOwner(claim), true);
  source.acquireReadLease(Object.freeze({}));
  harness.child.send(codexTurnCompleted());

  const metadata = ownedCodexInstructionMetadata({
    deliveryAttemptId: 'delivery_followup_start', mode: 'start', expectedTurnId: null, inputText: 'follow up',
  });
  const writer = getOwnedInstructionWriter(capability);
  const token = writer.prepare(metadata);
  assert.ok(token);
  const previousWrite = harness.child.stdin.onWrite;
  let pendingStartId = null;
  harness.child.stdin.onWrite = (line) => {
    const request = JSON.parse(line);
    if (request.method === 'turn/start' && request.params.clientUserMessageId === metadata.deliveryAttemptId) {
      pendingStartId = request.id;
      return;
    }
    previousWrite(line);
  };
  const input = [{ type: 'text', text: 'follow up', text_elements: [] }];
  const pendingAck = writer.dispatchNow(token, { ...metadata, input }, () => true);
  pendingAck.catch(() => {});
  assert.ok(pendingStartId);

  harness.child.send(makeNativeHoldRequest('followup-hold', 'item/tool/requestUserInput', { turnId: 'turn_native_2' }));
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().failureCode, null);
  assert.equal(runner.snapshot().unknownServerRequestHeld, true);
  assert.equal(runner.snapshot().contextState, 'ended');
  await runner.stop();
});

test('the wait profile requires a trusted context-current callback', (t) => {
  const workspace = createWorkspace(t);
  const harness = createSpawnHarness(workspace);
  assert.throws(() => createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    profile: 'cockpit-native-wait-v1',
    isCurrent: () => true,
    isSourceCurrent: () => true,
    onAuthenticationRequired: () => {},
    onWaitRequired: () => {},
    spawnImpl: harness.spawnImpl,
    onNative() {},
  })), (error) => error.code === 'invalid_wait_callbacks');
  assert.equal(harness.calls, 0);
});

test('context revocation during wait callback reentry invalidates its receipt without replying', async (t) => {
  const workspace = createWorkspace(t);
  let contextCurrent = true;
  let receipt = null;
  const harness = createWaitProfileHarness(workspace, {
    waitCallsAfterTurnResponse: [makeWaitRequest()],
  });
  const runner = createWaitRunner(workspace, harness, {
    isContextCurrent: () => contextCurrent,
    onWaitRequired: (value) => {
      receipt = value;
      contextCurrent = false;
    },
  });

  await runner.start({ inputText: 'fixed task' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  assert.equal(runner.releaseWait(receipt), false);
  assert.equal(waitReplies(harness).length, 0);
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().ownedChildActive, true);
  await runner.stop();
});

test('throwing or asynchronous context guards suppress wait replies without ending the actor', async (t) => {
  for (const mode of ['throw', 'promise']) {
    const workspace = createWorkspace(t);
    let contextMode = 'current';
    let receipt = null;
    const harness = createWaitProfileHarness(workspace, {
      waitCallsAfterTurnResponse: [makeWaitRequest()],
    });
    const runner = createWaitRunner(workspace, harness, {
      isContextCurrent: () => {
        if (contextMode === 'throw') throw new Error('guard unavailable');
        if (contextMode === 'promise') return Promise.reject(new Error('async guard unsupported'));
        return true;
      },
      onWaitRequired: (value) => { receipt = value; },
    });

    await runner.start({ inputText: 'fixed task' });
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(receipt);
    contextMode = mode;
    assert.equal(runner.releaseWait(receipt), true);
    assert.equal(waitReplies(harness).length, 0);
    assert.equal(runner.snapshot().state, 'running');
    assert.equal(runner.snapshot().contextState, 'active');
    assert.equal(runner.snapshot().ownedChildActive, true);
    await runner.stop();
  }
});
test('stopping reentrantly from the wait callback prevents a native reply', async (t) => {
  const workspace = createWorkspace(t);
  let receipt = null;
  let stopPromise = null;
  let runner;
  const harness = createWaitProfileHarness(workspace, {
    waitCallsAfterTurnResponse: [makeWaitRequest()],
  });
  runner = createWaitRunner(workspace, harness, {
    onWaitRequired: (value) => {
      receipt = value;
      stopPromise = runner.stop();
    },
  });

  await runner.start({ inputText: 'fixed task' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  assert.equal(waitReplies(harness).length, 0);
  await stopPromise;
  assert.equal(runner.snapshot().state, 'stopped');
});
test('Claude rejects the wait profile before creating a child process', (t) => {
  const workspace = createWorkspace(t);
  const harness = createSpawnHarness(workspace);
  assert.throws(() => createOwnedNativeRunner(baseOptions(workspace, 'claude', {
    profile: 'cockpit-native-wait-v1',
    isCurrent: () => true,
    isSourceCurrent: () => true,
    getAuthentication: () => ({ oauthToken: 'oauth-secret' }),
    onWaitRequired() {},
    spawnImpl: harness.spawnImpl,
    onNative() {},
  })), (error) => error.code === 'unsupported_profile');
  assert.equal(harness.calls, 0);
});

function createOwnedCodexHarness(workspace, values = {}) {
  const methods = [];
  const requests = [];
  let heldOnce = false;
  let heldRead = null;
  const harness = createSpawnHarness(workspace, (line, child) => {
    const request = JSON.parse(line);
    if (!request.method || !Object.hasOwn(request, 'id')) return;
    methods.push(request.method);
    requests.push(Object.freeze({ method: request.method, id: request.id }));
    const respond = (result) => child.send(codexResponse(request.id, result));
    if (request.method === 'initialize') {
      respond({
        serverInfo: { name: 'codex', version: 'test' },
        codexHome: values.reportedCodexHome || path.join(workspace.homePath, '.codex'),
      });
    } else if (request.method === 'account/login/start') {
      respond({ type: 'chatgpt', loginId: LOGIN_ID, authUrl: LOGIN_URL });
    } else if (request.method === 'thread/start') {
      respond({ thread: { id: 'thread_native_1' } });
    } else if (request.method === 'turn/start') {
      if (values.earlyTurnCompletion) child.send(codexTurnCompleted());
      respond({ turn: { id: 'turn_native_1' } });
    } else if (request.method === 'thread/loaded/list') {
      if (values.rejectReadMethod === request.method) {
        child.send({ id: request.id, error: { code: -32603, message: 'read unavailable' } });
      } else respond({ data: values.loadedThreads || ['thread_native_1'], nextCursor: null });
    } else if (request.method === 'thread/read') {
      const result = {
        thread: {
          id: 'thread_native_1',
          status: { type: 'active' },
          turns: [{
            id: 'turn_native_1',
            status: values.turnStatus || 'inProgress',
            items: [{ content: 'private native history body' }],
          }],
        },
      };
      if (values.rejectReadMethod === request.method) {
        child.send({ id: request.id, error: { code: -32603, message: 'read unavailable' } });
      } else if (values.holdRead && !heldOnce) {
        heldOnce = true;
        heldRead = () => respond(result);
      }
      else respond(result);
    }
  });
  harness.methods = methods;
  harness.requests = requests;
  harness.completeHeldRead = () => { const finish = heldRead; heldRead = null; finish?.(); };
  harness.hasHeldRead = () => typeof heldRead === 'function';
  return harness;
}

function createOwnedCodexRunner(workspace, harness, claim, callbacks = {}) {
  return createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    ownedSourceClaim: claim,
    onSourceReady: callbacks.onSourceReady || (() => {}),
    isCurrent: callbacks.isCurrent || (() => true),
    isSourceCurrent: callbacks.isSourceCurrent || (() => true),
    onAuthenticationRequired: ({ loginId }) => harness.child.send(codexLoginCompleted(loginId)),
    spawnImpl: harness.spawnImpl,
    timeouts: callbacks.timeouts || { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 100 },
    onNative: callbacks.onNative || (() => {}),
  }));
}

function ownedCodexInstructionMetadata({ mode = 'steer', expectedTurnId = 'turn_native_1',
  deliveryAttemptId = 'delivery_native_1', inputText = 'instruction input' } = {}) {
  const claims = {
    launchId: 'launch_native_1', runId: 'run_native_1', attemptId: 'attempt_native_1',
    provider: 'codex', nativeIdKind: 'thread', hostId: 'host_native_1', homeScopeId: 'scope_native_1',
    origin: 'standalone', purpose: 'agent', originBinding: null,
  };
  const identity = {
    provider: 'codex', nativeIdKind: 'thread', hostId: 'host_native_1',
    homeScopeId: 'scope_native_1', nativeId: 'thread_native_1',
  };
  const actor = { kind: 'main', id: 'actor_native_1' };
  const executionBinding = { periodId: 'period_native_1', actor };
  const source = {
    launchRef: 'launch_ref_native_1', claims, identity, executionBinding,
    conversationId: 'conversation_native_1', sessionId: 'session_native_1',
  };
  const input = [{ type: 'text', text: inputText, text_elements: [] }];
  return {
    deliveryAttemptId, revision: 1,
    payloadDigest: sha256(JSON.stringify({ schemaVersion: 1, mode, expectedTurnId, input })),
    nativeContentDigest: sha256(JSON.stringify(input)),
    source,
    target: {
      kind: 'execution', launchRef: source.launchRef, claims, identity,
      periodId: executionBinding.periodId, actor,
      conversationId: source.conversationId, sessionId: source.sessionId,
    },
    mode, expectedTurnId,
  };
}

async function createReadCancellationFixture(t) {
  const workspace = createWorkspace(t);
  const claim = Object.freeze({});
  const harness = createOwnedCodexHarness(workspace);
  let capability;
  const runner = createOwnedCodexRunner(workspace, harness, claim, {
    onSourceReady: (value) => { capability = value; },
    timeouts: { startupMs: 1000, rpcMs: 5000, loginMs: 1000, stopMs: 100 },
  });
  t.after(() => runner.stop());
  await runner.start({ inputText: 'fixed task' });
  const source = getOwnedSource(capability);
  assert.equal(source.bindOwner(claim), true);
  const lease = source.acquireReadLease(Object.freeze({}));
  return { harness, runner, source, lease, capability };
}

function holdNextOwnedRead(t, fixture, method, { responseFirst = false, callbackFirst = false, onWrite } = {}) {
  const { harness } = fixture;
  const stdin = harness.child.stdin;
  const originalWrite = stdin.write.bind(stdin);
  const reached = deferred();
  let held = false;
  let respond;
  let completeWrite;
  let responseReleased = false;
  let writeReleased = false;
  const releaseResponse = () => {
    if (!respond || responseReleased) return;
    responseReleased = true;
    respond();
  };
  const releaseWrite = (error) => {
    if (!completeWrite || writeReleased) return;
    writeReleased = true;
    completeWrite(error);
  };
  t.after(() => { try { releaseResponse(); } finally { releaseWrite(); } });
  stdin.write = (line, callback) => {
    const request = JSON.parse(line.toString());
    if (request.method !== method || held) return originalWrite(line, callback);
    held = true;
    stdin.writes.push(line.toString());
    harness.methods.push(method);
    harness.requests.push({ method, id: request.id });
    respond = () => {
      harness.child.send(codexResponse(request.id, method === 'thread/loaded/list'
        ? { data: ['thread_native_1'], nextCursor: null }
        : { thread: { id: 'thread_native_1', turns: [{ id: 'turn_native_1', status: 'inProgress' }] } }));
    };
    completeWrite = (error) => callback(error);
    if (responseFirst) releaseResponse();
    if (callbackFirst) releaseWrite();
    onWrite?.();
    reached.resolve();
    return true;
  };
  return { reached: reached.promise, respond: releaseResponse, completeWrite: releaseWrite };
}

for (const method of ['thread/loaded/list', 'thread/read']) {
  for (const phase of ['response-first', 'callback-first', 'both-pending']) {
    test(`ID-F209-R01 ${method} ${phase}: release alone settles read before raw work completes`, { timeout: 3000 }, async (t) => {
      const fixture = await createReadCancellationFixture(t);
      const held = holdNextOwnedRead(t, fixture, method, {
        responseFirst: phase === 'response-first', callbackFirst: phase === 'callback-first',
      });
      const pending = fixture.source.readCurrent(fixture.lease);
      await held.reached;
      assert.equal(fixture.source.releaseReadLease(fixture.lease), true);
      assert.equal(fixture.source.releaseReadLease(fixture.lease), false);
      const result = await pending;
      assert.equal(result.status, 'unknown');
      assert.equal(result.receipt, null);
      assert.equal(fixture.runner.snapshot().state, 'running');
      assert.equal(fixture.harness.child.killCalls.length, 0);
      const methodsBeforeLate = [...fixture.harness.methods];
      if (phase !== 'response-first') held.respond();
      if (phase !== 'callback-first') held.completeWrite();
      await nextImmediate();
      assert.deepEqual(fixture.harness.methods, methodsBeforeLate);
      const nextLease = fixture.source.acquireReadLease(Object.freeze({}));
      const fresh = await fixture.source.readCurrent(nextLease);
      assert.equal(fresh.status, 'attested');
      assert.equal(fixture.source.consumeReadReceipt(nextLease, fresh.receipt), true);
    });
  }
}

test('ID-F209-R01 old raw response and write callback do not disturb a new lease receipt', { timeout: 3000 }, async (t) => {
  const fixture = await createReadCancellationFixture(t);
  const held = holdNextOwnedRead(t, fixture, 'thread/read');
  const oldRead = fixture.source.readCurrent(fixture.lease);
  await held.reached;
  fixture.source.releaseReadLease(fixture.lease);
  assert.equal((await oldRead).status, 'unknown');
  const nextLease = fixture.source.acquireReadLease(Object.freeze({}));
  const fresh = await fixture.source.readCurrent(nextLease);
  held.respond();
  held.completeWrite();
  await nextImmediate();
  assert.equal(fresh.status, 'attested');
  assert.equal(fixture.source.consumeReadReceipt(nextLease, fresh.receipt), true);
  assert.equal(fixture.runner.snapshot().state, 'running');
});

test('ID-F209-R01 release after raw loaded-list response and write settlement prevents thread-read', { timeout: 3000 }, async (t) => {
  const fixture = await createReadCancellationFixture(t);
  const held = holdNextOwnedRead(t, fixture, 'thread/loaded/list');
  const read = fixture.source.readCurrent(fixture.lease);
  await held.reached;
  held.respond();
  held.completeWrite();
  queueMicrotask(() => fixture.source.releaseReadLease(fixture.lease));
  assert.equal((await read).status, 'unknown');
  assert.equal(fixture.harness.methods.includes('thread/read'), false);
});

for (const callbackTiming of ['synchronous', 'late-success', 'late-error']) {
  test(`ID-F209-R01 synchronous write release with ${callbackTiming} consumes raw settlement`, { timeout: 3000 }, async (t) => {
    const fixture = await createReadCancellationFixture(t);
    const held = holdNextOwnedRead(t, fixture, 'thread/loaded/list', {
      responseFirst: true,
      onWrite: () => {
        fixture.source.releaseReadLease(fixture.lease);
        if (callbackTiming === 'synchronous') held.completeWrite();
      },
    });
    const read = fixture.source.readCurrent(fixture.lease);
    await held.reached;
    assert.equal((await read).status, 'unknown');
    assert.equal(fixture.harness.methods.includes('thread/read'), false);
    if (callbackTiming !== 'synchronous') held.completeWrite(callbackTiming === 'late-error' ? new Error('physical pipe failure') : undefined);
    await nextImmediate();
    assert.equal(fixture.runner.snapshot().state, callbackTiming === 'late-error' ? 'failed' : 'running');
    assert.equal(fixture.runner.snapshot().failureCode, callbackTiming === 'late-error' ? 'stdin_write_failed' : null);
    if (callbackTiming !== 'late-error') {
      const nextLease = fixture.source.acquireReadLease(Object.freeze({}));
      assert.equal((await fixture.source.readCurrent(nextLease)).status, 'attested');
    }
  });
}

test('ID-F209-R01 source invalidation by stop cancels a response-first pending write', { timeout: 3000 }, async (t) => {
  const fixture = await createReadCancellationFixture(t);
  const held = holdNextOwnedRead(t, fixture, 'thread/loaded/list', { responseFirst: true });
  const pending = fixture.source.readCurrent(fixture.lease);
  await held.reached;
  const stop = fixture.runner.stop();
  assert.equal((await pending).status, 'unknown');
  await stop;
  const stopKillCount = fixture.harness.child.killCalls.length;
  held.completeWrite(new Error('old generation error'));
  await nextImmediate();
  assert.equal(fixture.runner.snapshot().state, 'stopped');
  assert.equal(fixture.runner.snapshot().failureCode, null);
  assert.equal(fixture.harness.child.killCalls.length, stopKillCount);
});

test('ID-F209-R01 cancelling one runner read preserves another runner pending read', { timeout: 3000 }, async (t) => {
  const first = await createReadCancellationFixture(t);
  const second = await createReadCancellationFixture(t);
  const firstHeld = holdNextOwnedRead(t, first, 'thread/read');
  const secondHeld = holdNextOwnedRead(t, second, 'thread/read');
  const firstRead = first.source.readCurrent(first.lease);
  let secondSettled = false;
  const secondRead = second.source.readCurrent(second.lease).then((result) => { secondSettled = true; return result; });
  await Promise.all([firstHeld.reached, secondHeld.reached]);
  first.source.releaseReadLease(first.lease);
  assert.equal((await firstRead).status, 'unknown');
  await nextImmediate();
  assert.equal(secondSettled, false);
  assert.equal(second.source.checkLease(second.lease), true);
  secondHeld.respond();
  secondHeld.completeWrite();
  const fresh = await secondRead;
  assert.equal(fresh.status, 'attested');
  assert.equal(second.source.consumeReadReceipt(second.lease, fresh.receipt), true);
  firstHeld.respond();
  firstHeld.completeWrite();
});

test('ID-F209-R01 read cancellation leaves pending instruction transport until the authority-checked ACK', { timeout: 3000 }, async (t) => {
  const fixture = await createReadCancellationFixture(t);
  const writer = getOwnedInstructionWriter(fixture.capability);
  const metadata = ownedCodexInstructionMetadata();
  const token = writer.prepare(metadata);
  assert.ok(token);
  const stdin = fixture.harness.child.stdin;
  const originalOnWrite = stdin.onWrite;
  let instructionId;
  let instructionAckReleased = false;
  const releaseInstructionAck = () => {
    if (instructionId === undefined || instructionAckReleased) return;
    instructionAckReleased = true;
    fixture.harness.child.send(codexResponse(instructionId, { turnId: 'turn_native_1' }));
  };
  t.after(releaseInstructionAck);
  stdin.onWrite = (line) => {
    const request = JSON.parse(line);
    if (request.method === 'turn/steer') { instructionId = request.id; return; }
    originalOnWrite(line);
  };
  let instructionSettled = false;
  const input = [{ type: 'text', text: 'instruction input', text_elements: [] }];
  const ack = writer.dispatchNow(token, { ...metadata, input }, () => true).then(
    (value) => { instructionSettled = true; return { value }; },
    (error) => { instructionSettled = true; return { error }; },
  );
  assert.ok(instructionId);
  const held = holdNextOwnedRead(t, fixture, 'thread/read');
  const read = fixture.source.readCurrent(fixture.lease);
  await held.reached;
  fixture.source.releaseReadLease(fixture.lease);
  assert.equal((await read).status, 'unknown');
  await nextImmediate();
  assert.equal(instructionSettled, false);
  assert.equal(fixture.runner.snapshot().state, 'running');
  releaseInstructionAck();
  assert.ok((await ack).error);
  assert.equal(fixture.runner.snapshot().state, 'running');
  held.respond();
  held.completeWrite();
});

test('owned Codex source reads only its current loaded turn over the existing pipe', async (t) => {
  const workspace = createWorkspace(t);
  const claim = Object.freeze({});
  const methods = [];
  let capability = null;
  let runner;
  const harness = createOwnedCodexHarness(workspace);
  runner = createOwnedCodexRunner(workspace, harness, claim, {
    onSourceReady: (value) => {
      assert.equal(methods.length, 0);
      capability = value;
    },
    onNative: (event) => methods.push(event.type),
  });

  await runner.start({ inputText: 'private task text' });
  const source = getOwnedSource(capability);
  assert.ok(source);
  assert.equal(source.bindOwner(claim), true);
  assert.equal(source.checkSource(), true);
  const terminalEvents = [];
  source.subscribeTerminal(claim, (event) => terminalEvents.push(event));
  const lease = source.acquireReadLease(Object.freeze({}));
  const result = await source.readCurrent(lease);

  assert.equal(result.status, 'attested');
  assert.equal(result.identity.nativeId, 'thread_native_1');
  assert.equal(result.context.nativeContextId, 'turn_native_1');
  assert.equal(source.consumeReadReceipt(lease, result.receipt), true);
  assert.equal(source.consumeReadReceipt(lease, result.receipt), false);
  assert.deepEqual(harness.methods, [
    'initialize', 'account/login/start', 'thread/start', 'turn/start',
    'thread/loaded/list', 'thread/read',
  ]);
  assert.equal(harness.methods.filter((method) => method === 'initialize').length, 1);
  assert.equal(JSON.stringify({ result, snapshot: runner.snapshot() }).includes('private native history body'), false);
  assert.equal(JSON.stringify({ result, snapshot: runner.snapshot() }).includes('private task text'), false);

  assert.equal(source.releaseReadLease(lease), true);
  harness.child.send(codexTurnCompleted());
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].type, 'context_ended');
  const replayedTerminals = [];
  source.subscribeTerminal(claim, (event) => replayedTerminals.push(event));
  assert.equal(replayedTerminals.length, 1);
  const reattachedLease = source.acquireReadLease(Object.freeze({}));
  assert.equal((await source.readCurrent(reattachedLease)).status, 'unknown');
  assert.equal(harness.methods.filter((method) => method === 'thread/read').length, 1);
  await runner.stop();
  assert.equal(source.checkSource(), false);
});

test('owned Codex source rejects a reported HOME mismatch before login or thread requests', async (t) => {
  const workspace = createWorkspace(t);
  const claim = Object.freeze({});
  const harness = createOwnedCodexHarness(workspace, { reportedCodexHome: path.join(workspace.root, 'other-home') });
  let capability = null;
  const runner = createOwnedCodexRunner(workspace, harness, claim, { onSourceReady: (value) => { capability = value; } });

  await assert.rejects(runner.start({ inputText: 'fixed task' }), (error) => error.code === 'codex_home_mismatch');
  assert.equal(getOwnedSource(capability).checkSource(), false);
  assert.deepEqual(harness.methods, ['initialize']);
  await runner.stop();
});

test('owned Codex source accepts only exact inProgress turn status', async (t) => {
  const workspace = createWorkspace(t);
  const claim = Object.freeze({});
  const harness = createOwnedCodexHarness(workspace, { turnStatus: 'active' });
  let capability = null;
  const runner = createOwnedCodexRunner(workspace, harness, claim, { onSourceReady: (value) => { capability = value; } });
  await runner.start({ inputText: 'fixed task' });
  const source = getOwnedSource(capability);
  source.bindOwner(claim);
  const lease = source.acquireReadLease(Object.freeze({}));

  const result = await source.readCurrent(lease);
  assert.equal(result.status, 'unknown');
  assert.equal(result.receipt, null);
  await runner.stop();
});

test('an early matched turn completion is retained without creating context or stopping the source', async (t) => {
  const workspace = createWorkspace(t);
  const claim = Object.freeze({});
  const harness = createOwnedCodexHarness(workspace, { earlyTurnCompletion: true });
  let capability = null;
  const events = [];
  const runner = createOwnedCodexRunner(workspace, harness, claim, {
    onSourceReady: (value) => { capability = value; },
    onNative: (event) => events.push(event),
  });

  const snapshot = await runner.start({ inputText: 'fixed task' });
  const source = getOwnedSource(capability);
  source.bindOwner(claim);
  const terminalEvents = [];
  source.subscribeTerminal(claim, (event) => terminalEvents.push(event));
  const lease = source.acquireReadLease(Object.freeze({}));

  assert.deepEqual(events.map((event) => event.type), ['identity', 'context_ended']);
  assert.equal(snapshot.state, 'running');
  assert.equal(snapshot.contextState, 'ended');
  assert.equal(snapshot.terminalContextCount, 1);
  assert.equal(terminalEvents.length, 1);
  assert.equal(terminalEvents[0].context.nativeContextId, 'turn_native_1');
  assert.equal((await source.readCurrent(lease)).status, 'unknown');
  assert.equal(harness.methods.includes('thread/read'), false);
  assert.equal(harness.child.killCalls.length, 0);
  await runner.stop();
});

test('an active owned read timeout returns unknown and leaves the native process running', async (t) => {
  const workspace = createWorkspace(t);
  const claim = Object.freeze({});
  const harness = createOwnedCodexHarness(workspace, { holdRead: true });
  let capability = null;
  const runner = createOwnedCodexRunner(workspace, harness, claim, {
    onSourceReady: (value) => { capability = value; },
    timeouts: { startupMs: 1000, rpcMs: 60, loginMs: 1000, stopMs: 100 },
  });
  await runner.start({ inputText: 'fixed task' });
  const source = getOwnedSource(capability);
  source.bindOwner(claim);
  const lease = source.acquireReadLease(Object.freeze({}));

  const timedOut = await source.readCurrent(lease);
  assert.equal(timedOut.status, 'unknown');
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(harness.child.killCalls.length, 0);
  harness.completeHeldRead();
  await new Promise((resolve) => setImmediate(resolve));
  const fresh = await source.readCurrent(lease);
  assert.equal(fresh.status, 'attested');
  assert.equal(source.consumeReadReceipt(lease, fresh.receipt), true);
  assert.equal(harness.child.killCalls.length, 0);
  await runner.stop();
});

test('a refused readonly source RPC returns unknown without stopping the native process', async (t) => {
  for (const rejectReadMethod of ['thread/loaded/list', 'thread/read']) {
    const workspace = createWorkspace(t);
    const claim = Object.freeze({});
    const harness = createOwnedCodexHarness(workspace, { rejectReadMethod });
    let capability = null;
    const runner = createOwnedCodexRunner(workspace, harness, claim, {
      onSourceReady: (value) => { capability = value; },
    });
    await runner.start({ inputText: 'fixed task' });
    const source = getOwnedSource(capability);
    source.bindOwner(claim);
    const lease = source.acquireReadLease(Object.freeze({}));

    assert.equal((await source.readCurrent(lease)).status, 'unknown');
    assert.equal(runner.snapshot().state, 'running');
    assert.equal(harness.child.killCalls.length, 0);
    await runner.stop();
  }
});

for (const method of ['thread/loaded/list', 'thread/read']) {
  test(`ID-F209-R02 ${method} write failure before lease cancellation fails the current runner`, { timeout: 3000 }, async (t) => {
    const fixture = await createReadCancellationFixture(t);
    const held = holdNextOwnedRead(t, fixture, method);
    const read = fixture.source.readCurrent(fixture.lease);
    const readResult = read.then((value) => value, (error) => { throw error; });
    await held.reached;
    held.completeWrite(new Error('physical pipe failure'));

    assert.equal((await readResult).status, 'unknown');
    await nextImmediate();
    assert.equal(fixture.runner.snapshot().state, 'failed');
    assert.equal(fixture.runner.snapshot().failureCode, 'stdin_write_failed');
    assert.equal(fixture.harness.child.killCalls.length, 1);
  });
}

test('ID-F209-R02 falsy synchronous stdin write errors fail the current runner as pipe failures', { timeout: 5000 }, async (t) => {
  for (const thrown of [undefined, null, false, 0, '']) {
    const fixture = await createReadCancellationFixture(t);
    const stdin = fixture.harness.child.stdin;
    const originalWrite = stdin.write.bind(stdin);
    stdin.write = (line, callback) => {
      const request = JSON.parse(line.toString());
      if (request.method === 'thread/loaded/list') throw thrown;
      return originalWrite(line, callback);
    };
    const read = fixture.source.readCurrent(fixture.lease);
    const readResult = read.then((value) => value, (error) => { throw error; });

    assert.equal((await readResult).status, 'unknown', `throw value: ${String(thrown)}`);
    await nextImmediate();
    assert.equal(fixture.runner.snapshot().state, 'failed', `throw value: ${String(thrown)}`);
    assert.equal(fixture.runner.snapshot().failureCode, 'stdin_write_failed', `throw value: ${String(thrown)}`);
    assert.equal(fixture.harness.child.killCalls.length, 1, `throw value: ${String(thrown)}`);
  }
});

test('a delayed stdin callback times out without killing the source and does not block a later read', async (t) => {
  const workspace = createWorkspace(t);
  const claim = Object.freeze({});
  const harness = createOwnedCodexHarness(workspace);
  let capability = null;
  const runner = createOwnedCodexRunner(workspace, harness, claim, {
    onSourceReady: (value) => { capability = value; },
    timeouts: { startupMs: 1000, rpcMs: 60, loginMs: 1000, stopMs: 100 },
  });
  await runner.start({ inputText: 'fixed task' });
  const source = getOwnedSource(capability);
  source.bindOwner(claim);
  const lease = source.acquireReadLease(Object.freeze({}));
  const stdin = harness.child.stdin;
  const originalWrite = stdin.write.bind(stdin);
  let heldCallback = null;
  let heldOnce = false;
  stdin.write = (line, callback) => {
    const request = JSON.parse(line.toString());
    if (request.method === 'thread/loaded/list' && !heldOnce) {
      heldOnce = true;
      heldCallback = callback;
      return originalWrite(line, null);
    }
    return originalWrite(line, callback);
  };

  assert.equal((await source.readCurrent(lease)).status, 'unknown');
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(harness.child.killCalls.length, 0);
  heldCallback(null);
  const fresh = await source.readCurrent(lease);
  assert.equal(fresh.status, 'attested');
  assert.equal(source.consumeReadReceipt(lease, fresh.receipt), true);
  assert.equal(harness.child.killCalls.length, 0);
  await runner.stop();
});

test('a late read-write callback error is handled as a physical pipe failure', async (t) => {
  const workspace = createWorkspace(t);
  const claim = Object.freeze({});
  const harness = createOwnedCodexHarness(workspace);
  let capability = null;
  const runner = createOwnedCodexRunner(workspace, harness, claim, {
    onSourceReady: (value) => { capability = value; },
    timeouts: { startupMs: 1000, rpcMs: 60, loginMs: 1000, stopMs: 100 },
  });
  await runner.start({ inputText: 'fixed task' });
  const source = getOwnedSource(capability);
  source.bindOwner(claim);
  const lease = source.acquireReadLease(Object.freeze({}));
  const stdin = harness.child.stdin;
  const originalWrite = stdin.write.bind(stdin);
  let heldCallback = null;
  let heldOnce = false;
  stdin.write = (line, callback) => {
    const request = JSON.parse(line.toString());
    if (request.method === 'thread/loaded/list' && !heldOnce) {
      heldOnce = true;
      heldCallback = callback;
      return originalWrite(line, null);
    }
    return originalWrite(line, callback);
  };

  assert.equal((await source.readCurrent(lease)).status, 'unknown');
  assert.equal(runner.snapshot().state, 'running');
  heldCallback(new Error('physical write failure'));
  assert.equal(runner.snapshot().failureCode, 'stdin_write_failed');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.child.killCalls.length, 1);
  await runner.stop();
});

test('a detached read is retired so a new lease can read before the old response arrives', async (t) => {
  const workspace = createWorkspace(t);
  const claim = Object.freeze({});
  const harness = createOwnedCodexHarness(workspace, { holdRead: true });
  let capability = null;
  const runner = createOwnedCodexRunner(workspace, harness, claim, {
    onSourceReady: (value) => { capability = value; },
    timeouts: { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 100 },
  });
  await runner.start({ inputText: 'fixed task' });
  const source = getOwnedSource(capability);
  source.bindOwner(claim);
  const oldLease = source.acquireReadLease(Object.freeze({}));
  const oldRead = source.readCurrent(oldLease);
  while (!harness.hasHeldRead()) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(source.releaseReadLease(oldLease), true);
  const newLease = source.acquireReadLease(Object.freeze({}));
  const fresh = await source.readCurrent(newLease);
  assert.equal(fresh.status, 'attested');
  assert.equal((await oldRead).status, 'unknown');
  assert.equal(source.consumeReadReceipt(newLease, fresh.receipt), true);
  assert.equal(harness.methods.filter((method) => method === 'thread/read').length, 2);
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(harness.child.killCalls.length, 0);

  harness.completeHeldRead();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(harness.child.killCalls.length, 0);
  await runner.stop();
});

test('observation freshness suppresses positive events without suppressing a matched terminal', async (t) => {
  const workspace = createWorkspace(t);
  const harness = codexResponder({ workspace });
  const events = [];
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    onAuthenticationRequired: ({ loginId }) => harness.child.send(codexLoginCompleted(loginId)),
    isSourceCurrent: () => true,
    isObservationCurrent: () => false,
    spawnImpl: harness.spawnImpl,
    onNative: (event) => events.push(event),
  }));
  await runner.start({ inputText: 'fixed task' });
  assert.deepEqual(events, []);
  harness.child.send(codexTurnCompleted());
  assert.deepEqual(events.map((event) => event.type), ['context_ended']);
  assert.equal(runner.snapshot().state, 'running');
  await runner.stop();
});

test('unissued and startup RPC response IDs remain protocol errors after owned reads', async (t) => {
  for (const responseId of [1, 999]) {
    const workspace = createWorkspace(t);
    const claim = Object.freeze({});
    const harness = createOwnedCodexHarness(workspace);
    let capability = null;
    const runner = createOwnedCodexRunner(workspace, harness, claim, {
      onSourceReady: (value) => { capability = value; },
    });
    await runner.start({ inputText: 'fixed task' });
    const source = getOwnedSource(capability);
    source.bindOwner(claim);
    const lease = source.acquireReadLease(Object.freeze({}));
    const read = await source.readCurrent(lease);
    assert.equal(read.status, 'attested');
    harness.child.send(codexResponse(responseId, {}));
    assert.equal(runner.snapshot().failureCode, 'rpc_response_unexpected');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(harness.child.killCalls.length, 1);
    await runner.stop();
  }
});

test('unmatched resolutions preserve pending holds and their revision until an exact match arrives', async (t) => {
  const workspace = createWorkspace(t);
  const harness = createWaitProfileHarness(workspace);
  const runner = createWaitRunner(workspace, harness);
  await runner.start({ inputText: 'fixed task' });
  assert.equal(runner.snapshot().unmatchedResolutionCount, 0);
  harness.child.send(makeNativeHoldRequest(7));
  const pending = runner.captureNativePendingSummary('thread_native_1', 'turn_native_1');
  for (const notification of [nativeHoldResolved('unknown'), nativeHoldResolved('7'), nativeHoldResolved(7, 'thread_other')]) {
    const count = runner.snapshot().unmatchedResolutionCount;
    harness.child.send(notification);
    assert.equal(runner.snapshot().state, 'running');
    assert.equal(runner.snapshot().failureCode, null);
    assert.equal(runner.snapshot().unmatchedResolutionCount, count + 1);
    assert.equal(pending.checkCurrent(), true);
    const current = runner.captureNativePendingSummary('thread_native_1', 'turn_native_1');
    assert.deepEqual(current.pending, pending.pending);
  }
  harness.child.send(nativeHoldResolved(7));
  assert.equal(pending.checkCurrent(), false);
  assert.deepEqual(runner.captureNativePendingSummary('thread_native_1', 'turn_native_1').pending, []);
  assert.equal(waitReplies(harness, 7).length, 0);
  await runner.stop();
});

test('an active wait resolution before turn completion cancels the request without a response', async (t) => {
  const workspace = createWorkspace(t);
  let receipt;
  const harness = createWaitProfileHarness(workspace, { waitCallsAfterTurnResponse: [makeWaitRequest()] });
  const runner = createWaitRunner(workspace, harness, { onWaitRequired: (value) => { receipt = value; } });
  await runner.start({ inputText: 'fixed task' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  harness.child.send(nativeHoldResolved('wait_request_1', 'thread_other'));
  assert.equal(runner.snapshot().unmatchedResolutionCount, 1);
  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().contextState, 'active');
  assert.equal(runner.snapshot().unmatchedResolutionCount, 1);
  assert.equal(waitReplies(harness).length, 0);
  harness.child.send(codexTurnCompleted());
  assert.equal(runner.snapshot().contextState, 'ended');
  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().unmatchedResolutionCount, 2);
  assert.equal(waitReplies(harness).length, 0);
  await runner.stop();
});

test('a cancelled active wait still rejects another wait call in the same turn', async (t) => {
  const workspace = createWorkspace(t);
  let receipt;
  const harness = createWaitProfileHarness(workspace, { waitCallsAfterTurnResponse: [makeWaitRequest()] });
  const runner = createWaitRunner(workspace, harness, { onWaitRequired: (value) => { receipt = value; } });
  await runner.start({ inputText: 'fixed task' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.snapshot().state, 'running');
  harness.child.send(makeWaitRequest({}, { requestId: 'duplicate-wait' }));
  assert.equal(runner.snapshot().failureCode, 'wait_request_duplicate');
  assert.equal(waitReplies(harness).length, 0);
  await runner.stop();
});

test('an early wait resolution before early turn completion prevents activation after turn start', async (t) => {
  for (const completeEarly of [false, true]) {
    const workspace = createWorkspace(t);
    let callbacks = 0;
    const harness = createWaitProfileHarness(workspace, { waitCallsBeforeTurnResponse: [
      makeWaitRequest(), nativeHoldResolved('unknown'), nativeHoldResolved('wait_request_1', 'thread_other'),
      nativeHoldResolved('wait_request_1'), ...(completeEarly ? [codexTurnCompleted()] : []),
    ] });
    const runner = createWaitRunner(workspace, harness, { onWaitRequired: () => { callbacks += 1; } });
    await runner.start({ inputText: 'fixed task' });
    assert.equal(runner.snapshot().state, 'running');
    assert.equal(runner.snapshot().unmatchedResolutionCount, 2);
    assert.equal(callbacks, 0);
    assert.equal(waitReplies(harness).length, 0);
    harness.child.send(nativeHoldResolved('wait_request_1'));
    assert.equal(runner.snapshot().unmatchedResolutionCount, 3);
    if (!completeEarly) {
      harness.child.send(makeWaitRequest({}, { requestId: 'duplicate-wait' }));
      assert.equal(runner.snapshot().failureCode, 'wait_request_duplicate');
    }
    await runner.stop();
  }
});

test('delivery through a cancelled wait receipt remains undelivered and writes no response', async (t) => {
  const workspace = createWorkspace(t);
  let receipt;
  const harness = createWaitProfileHarness(workspace, { waitCallsAfterTurnResponse: [makeWaitRequest()] });
  const runner = createWaitRunner(workspace, harness, { onWaitRequired: (value) => { receipt = value; } });
  await runner.start({ inputText: 'fixed task' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(receipt);
  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.releaseWait(receipt), false);
  assert.equal(runner.releaseWait(receipt), false);
  assert.equal(runner.cancelWait(receipt), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(waitReplies(harness).length, 0);
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().unmatchedResolutionCount, 0);
  harness.child.send(codexTurnCompleted());
  assert.equal(runner.releaseWait(receipt), false);
  assert.equal(waitReplies(harness).length, 0);
  await runner.stop();
});

test('a duplicate resolution during terminal callback does not consume the deferred resolution', async (t) => {
  const workspace = createWorkspace(t);
  const harness = createWaitProfileHarness(workspace, { waitCallsBeforeTurnResponse: [
    makeWaitRequest(), codexTurnCompleted(), nativeHoldResolved('wait_request_1'),
  ] });
  const runner = createWaitRunner(workspace, harness, { onNative: (event) => {
    if (event.type === 'context_ended') harness.child.send(nativeHoldResolved('wait_request_1'));
  } });
  await runner.start({ inputText: 'fixed task' });
  assert.equal(runner.snapshot().state, 'running');
  assert.equal(runner.snapshot().unmatchedResolutionCount, 1);
  harness.child.send(nativeHoldResolved('wait_request_1'));
  assert.equal(runner.snapshot().unmatchedResolutionCount, 2);
  assert.equal(waitReplies(harness).length, 0);
  await runner.stop();
});

function createStartCancellationFixture(workspace, provider, stage) {
  const barriers = new Map();
  const state = { child: null, spawnCalls: 0, methods: [], responses: [], events: [], writes: [], releaseLate: () => {} };
  const barrier = (name) => {
    if (!barriers.has(name)) barriers.set(name, deferred());
    return barriers.get(name);
  };
  const reached = (name) => barrier(name).resolve();
  const stageForResponse = {
    'codex-initialize-response': 'initialize',
    'codex-login-start-response': 'account/login/start',
    'codex-thread-start-response': 'thread/start',
    'codex-turn-start-response': 'turn/start',
  }[stage];
  const heldWriteName = stage === 'claude-initial-write' ? 'claude-initial-write' :
    stage === 'codex-initialize-write' ? 'codex-rpc-write:initialize' :
      stage === 'codex-initialized-write' ? 'codex-initialized-write' : null;

  function responseFor(request) {
    if (request.method === 'initialize') return codexResponse(request.id, { serverInfo: { name: 'codex', version: 'test' } });
    if (request.method === 'account/login/start') return codexResponse(request.id, {
      type: 'chatgpt', loginId: LOGIN_ID, authUrl: LOGIN_URL,
    });
    if (request.method === 'thread/start') return codexResponse(request.id, { thread: { id: 'thread_native_1' } });
    if (request.method === 'turn/start') return codexResponse(request.id, { turn: { id: 'turn_native_1' } });
    throw new Error(`unexpected startup method: ${request.method}`);
  }

  const spawnImpl = () => {
    state.spawnCalls += 1;
    state.child = new FakeChild((line, child) => {
      state.writes.push(line);
      const request = JSON.parse(line);
      if (provider === 'claude') {
        if (request.type === 'user') reached('claude-user-write');
        return;
      }
      if (request.method === 'initialized') {
        reached('codex-initialized-write');
        return;
      }
      if (!request.method || !Object.hasOwn(request, 'id')) return;
      state.methods.push(request.method);
      reached(`request:${request.method}`);
      const response = responseFor(request);
      if (request.method === stageForResponse) {
        state.releaseLate = () => child.send(response);
      } else {
        child.send(response);
        state.responses.push(request.method);
        reached(`response:${request.method}`);
      }
    }, {
      onWriteCallback(text, callback, child) {
        let writeName = 'other-write';
        if (provider === 'claude' && JSON.parse(text).type === 'user') writeName = 'claude-initial-write';
        else if (provider === 'codex') {
          const request = JSON.parse(text);
          writeName = request.method === 'initialized' ? 'codex-initialized-write' : `codex-rpc-write:${request.method}`;
        }
        reached(`write-callback:${writeName}`);
        const complete = () => {
          callback();
          reached(`write-complete:${writeName}`);
        };
        if (writeName === heldWriteName) {
          state.releaseLate = complete;
          reached('held-write-callback');
        } else {
          queueMicrotask(complete);
        }
      },
    });
    reached('spawn-created');
    if (stage !== 'claude-spawn') setImmediate(() => state.child.emit('spawn'));
    return state.child;
  };

  const runnerOptions = baseOptions(workspace, provider, {
    ...(provider === 'claude' ? { getAuthentication: () => {
      reached('authentication-requested');
      return stage === 'claude-authentication' ? barrier('authentication-result').promise : { oauthToken: 'fixture-oauth-token' };
    } } : {}),
    ...(provider === 'codex' ? { onAuthenticationRequired: ({ loginId }) => {
      reached('authentication-prompt');
      if (stage === 'codex-login-completion') {
        state.releaseLate = () => state.child.send(codexLoginCompleted(loginId));
      } else {
        state.child.send(codexLoginCompleted(loginId));
      }
    } } : {}),
    spawnImpl,
    onNative: (event) => {
      state.events.push(event);
      reached(`native:${event.type}`);
    },
    timeouts: { startupMs: 5000, rpcMs: 5000, loginMs: 5000, stopMs: 100 },
  });
  const runner = createOwnedNativeRunner(runnerOptions);

  return {
    runner,
    state,
    wait: (name) => barrier(name).promise,
    releaseAuthentication: () => barrier('authentication-result').resolve({ oauthToken: 'late-oauth-token' }),
    releaseLate: () => state.releaseLate(),
  };
}

async function waitForCodexResponseBarrier(fixture, method) {
  await fixture.wait(`request:${method}`);
  await fixture.wait(`write-complete:codex-rpc-write:${method}`);
  await nextImmediate();
}

for (const stage of ['claude-authentication', 'claude-spawn', 'claude-initial-write', 'claude-context-ready']) {
  test(`ID-F209-S01 Claude ${stage}: stop settles start and late input cannot advance it`, { timeout: 7000 }, async (t) => {
    const workspace = createWorkspace(t);
    const fixture = createStartCancellationFixture(workspace, 'claude', stage);
    const startOutcome = observeStart(fixture.runner.start({ inputText: 'private start input' }));
    let stopSnapshot;
    let writesBeforeLate;
    try {
      if (stage === 'claude-authentication') {
        await fixture.wait('authentication-requested');
      } else if (stage === 'claude-spawn') {
        await fixture.wait('spawn-created');
      } else if (stage === 'claude-initial-write') {
        await fixture.wait('held-write-callback');
      } else {
        await fixture.wait('write-complete:claude-initial-write');
        await nextImmediate();
        fixture.state.child.send({ type: 'system', subtype: 'init', session_id: 'session_native_1' });
        await fixture.wait('native:identity');
        await nextImmediate();
      }

      stopSnapshot = await fixture.runner.stop();
      writesBeforeLate = fixture.state.writes.slice();
      const outcome = await startOutcome;
      assert.equal(outcome.status, 'rejected');
      assert.equal(outcome.error.code, 'operation_stopped');
      if (fixture.state.child) {
        assert.equal(stopSnapshot.childExited, true);
        assert.equal(stopSnapshot.childClosed, true);
        assert.equal(stopSnapshot.ownedChildActive, false);
      } else {
        assert.equal(fixture.state.spawnCalls, 0);
      }

      if (stage === 'claude-authentication') fixture.releaseAuthentication();
      if (stage === 'claude-spawn') fixture.state.child.emit('spawn');
      fixture.releaseLate();
      if (stage === 'claude-context-ready') {
        fixture.state.child.send({
          type: 'stream_event', session_id: 'session_native_1', parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'late_context', role: 'assistant' } },
        });
      }
      await nextImmediate();
      assert.deepEqual(fixture.state.writes, writesBeforeLate);
      assert.equal(fixture.state.spawnCalls, stage === 'claude-authentication' ? 0 : 1);
      assert.deepEqual(fixture.state.events.map((event) => event.type), stage === 'claude-context-ready' ? ['identity'] : []);
      assert.equal(fixture.runner.snapshot().contextState, 'none');
    } finally {
      await fixture.runner.stop();
      if (stage === 'claude-authentication') fixture.releaseAuthentication();
      if (stage === 'claude-spawn' && fixture.state.child) fixture.state.child.emit('spawn');
      fixture.releaseLate();
      await nextImmediate();
      await startOutcome;
    }
  });
}

for (const stage of [
  'codex-initialize-response',
  'codex-initialize-write',
  'codex-initialized-write',
  'codex-login-start-response',
  'codex-login-completion',
  'codex-thread-start-response',
  'codex-turn-start-response',
]) {
  test(`ID-F209-S01 Codex ${stage}: stop settles start and late input cannot advance it`, { timeout: 7000 }, async (t) => {
    const workspace = createWorkspace(t);
    const fixture = createStartCancellationFixture(workspace, 'codex', stage);
    const startOutcome = observeStart(fixture.runner.start({ inputText: 'private start input' }));
    let expectedMethods;
    let writesBeforeLate;
    try {
      if (stage === 'codex-initialize-write') {
        await fixture.wait('held-write-callback');
        await fixture.wait('response:initialize');
        assert.deepEqual(fixture.state.responses, ['initialize']);
        expectedMethods = ['initialize'];
      } else if (stage === 'codex-initialized-write') {
        await fixture.wait('held-write-callback');
        expectedMethods = ['initialize'];
      } else if (stage === 'codex-login-completion') {
        await fixture.wait('authentication-prompt');
        await nextImmediate();
        expectedMethods = ['initialize', 'account/login/start'];
      } else {
        const targetMethod = {
          'codex-initialize-response': 'initialize',
          'codex-login-start-response': 'account/login/start',
          'codex-thread-start-response': 'thread/start',
          'codex-turn-start-response': 'turn/start',
        }[stage];
        await waitForCodexResponseBarrier(fixture, targetMethod);
        expectedMethods = fixture.state.methods.slice();
      }

      const stopSnapshot = await fixture.runner.stop();
      writesBeforeLate = fixture.state.writes.slice();
      const outcome = await startOutcome;
      assert.equal(outcome.status, 'rejected');
      assert.equal(outcome.error.code, 'operation_stopped');
      assert.equal(stopSnapshot.childExited, true);
      assert.equal(stopSnapshot.childClosed, true);
      assert.equal(stopSnapshot.ownedChildActive, false);

      fixture.releaseLate();
      await nextImmediate();
      assert.deepEqual(fixture.state.writes, writesBeforeLate);
      assert.deepEqual(fixture.state.methods, expectedMethods);
      assert.deepEqual(fixture.state.events.map((event) => event.type), stage === 'codex-turn-start-response' ? ['identity'] : []);
      assert.equal(fixture.runner.snapshot().contextState, 'none');
    } finally {
      await fixture.runner.stop();
      fixture.releaseLate();
      await nextImmediate();
      await startOutcome;
    }
  });
}

test('owned Claude and Codex pass only current transport values and delete each spawn environment', async (t) => {
  const claudeWorkspace = createWorkspace(t);
  const codexWorkspace = createWorkspace(t);
  const source = makeOwnedProcessEnvironment(makeTransportValues());
  const sourceDescriptors = Object.getOwnPropertyDescriptors(source.environment);
  const firstValues = { ...source.values };

  await withIsolatedProcessEnvironment(source.environment, async () => {
    const claudeHarness = createSpawnHarness(claudeWorkspace, (line, child) => {
      const message = JSON.parse(line);
      if (message.type !== 'user') return;
      child.send(
        { type: 'system', subtype: 'init', session_id: 'session_transport_1' },
        {
          type: 'stream_event', session_id: 'session_transport_1', parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'message_transport_1', role: 'assistant' } },
        },
      );
    });
    const claudeRunner = createOwnedNativeRunner(baseOptions(claudeWorkspace, 'claude', {
      onNative() {},
      getAuthentication: () => ({ oauthToken: 'fixture-oauth-CREDENTIAL-SENTINEL' }),
      spawnImpl: claudeHarness.spawnImpl,
    }));

    const claudeSnapshot = await claudeRunner.start({ inputText: 'fixture prompt' });
    assert.deepEqual(readTransportValues(claudeHarness.spawnEnvironment), firstValues);
    assert.deepEqual(claudeHarness.args, [
      '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose',
      '--include-partial-messages', '--no-session-persistence', '--setting-sources', '',
      '--strict-mcp-config', '--tools', '', '--settings', '{"disableAllHooks":true}',
    ]);
    assert.equal(claudeHarness.spawnEnvironment.HOME, claudeWorkspace.homePath);
    assert.equal(claudeHarness.spawnEnvironment.USERPROFILE, claudeWorkspace.homePath);
    assert.equal(claudeHarness.spawnEnvironment.CLAUDE_CONFIG_DIR, claudeWorkspace.homePath);
    assert.equal(claudeHarness.spawnEnvironment.CLAUDE_CODE_OAUTH_TOKEN, 'fixture-oauth-CREDENTIAL-SENTINEL');
    assert.equal(claudeHarness.options.shell, false);
    assert.deepEqual(claudeHarness.options.stdio, ['pipe', 'pipe', 'pipe']);
    assertForbiddenEnvironmentAbsent(claudeHarness.spawnEnvironment);
    assert.equal(Object.keys(claudeHarness.environment).length, 0);
    assert.equal(JSON.stringify(claudeHarness.args).includes('CREDENTIAL-SENTINEL'), false);
    assert.equal(JSON.stringify(claudeSnapshot).includes('CREDENTIAL-SENTINEL'), false);
    assert.deepEqual(source.lookupCounts, Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, 1])));
    assert.deepEqual(Object.getOwnPropertyDescriptors(source.environment), sourceDescriptors);
    assert.deepEqual(source.values, firstValues);
    await claudeRunner.stop();

    source.values.HTTPS_PROXY = 'http://fixture:next-CREDENTIAL-SENTINEL@proxy.invalid:9443';
    const codexHarness = createOwnedCodexHarness(codexWorkspace);
    const codexRunner = createOwnedNativeRunner(baseOptions(codexWorkspace, 'codex', {
      onNative() {},
      onAuthenticationRequired: ({ loginId }) => codexHarness.child.send(codexLoginCompleted(loginId)),
      spawnImpl: codexHarness.spawnImpl,
    }));
    const codexSnapshot = await codexRunner.start({ inputText: 'fixture task' });

    assert.equal(claudeHarness.spawnEnvironment.HTTPS_PROXY, firstValues.HTTPS_PROXY);
    assert.equal(codexHarness.spawnEnvironment.HTTPS_PROXY, source.values.HTTPS_PROXY);
    assert.deepEqual(codexHarness.args, [
      'app-server', '--listen', 'stdio://',
      '-c', 'cli_auth_credentials_store="ephemeral"',
      '-c', 'features.shell_tool=false',
      '-c', 'features.unified_exec=false',
      '-c', 'features.multi_agent=false',
      '-c', 'features.apps=false',
      '-c', 'features.hooks=false',
      '-c', 'features.skill_mcp_dependency_install=false',
      '-c', 'features.daemon_auto_start=false',
      '-c', 'features.browser_use=false',
      '-c', 'features.browser_use_external=false',
      '-c', 'features.browser_use_full_cdp_access=false',
      '-c', 'features.computer_use=false',
      '-c', 'features.image_generation=false',
      '-c', 'features.plugins=false',
      '-c', 'features.remote_plugin=false',
      '-c', 'features.workspace_dependencies=false',
      '-c', 'web_search="disabled"',
    ]);
    assert.deepEqual(readTransportValues(codexHarness.spawnEnvironment), source.values);
    assert.equal(codexHarness.spawnEnvironment.HOME, codexWorkspace.homePath);
    assert.equal(codexHarness.spawnEnvironment.CODEX_HOME, path.join(codexWorkspace.homePath, '.codex'));
    assert.equal(Object.hasOwn(codexHarness.spawnEnvironment, 'CLAUDE_CODE_OAUTH_TOKEN'), false);
    assert.equal(codexHarness.options.shell, false);
    assert.deepEqual(codexHarness.options.stdio, ['pipe', 'pipe', 'pipe']);
    assertForbiddenEnvironmentAbsent(codexHarness.spawnEnvironment);
    assert.equal(Object.keys(codexHarness.environment).length, 0);
    assert.equal(JSON.stringify(codexHarness.args).includes('CREDENTIAL-SENTINEL'), false);
    assert.equal(JSON.stringify(codexSnapshot).includes('CREDENTIAL-SENTINEL'), false);
    assert.deepEqual(source.lookupCounts, Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, 2])));
    assert.deepEqual(Object.getOwnPropertyDescriptors(source.environment), sourceDescriptors);
    await codexRunner.stop();
  });
});

test('owned runner rejects invalid transport values before spawning', async (t) => {
  const invalidValues = [
    { key: 'HTTP_PROXY', value: 17 },
    { key: 'HTTPS_PROXY', value: 'http://fixture.invalid\u0000/path' },
    { key: 'NO_PROXY', value: 'fixture.invalid\rmore' },
    { key: 'NODE_EXTRA_CA_CERTS', value: `${makeTransportValues().NODE_EXTRA_CA_CERTS}\n` },
    { key: 'SSL_CERT_FILE', value: process.platform === 'win32' ? 'C:relative-ca.pem' : 'relative-ca.pem' },
    ...(process.platform === 'win32' ? [
      { key: 'SSL_CERT_FILE', value: '\\rooted-without-drive.pem' },
      { key: 'SSL_CERT_FILE', value: '\\\\?\\C:\\device-ca.pem' },
      { key: 'NODE_EXTRA_CA_CERTS', value: '\\\\.\\pipe\\device-ca.pem' },
    ] : []),
  ];

  for (const invalid of invalidValues) {
    const workspace = createWorkspace(t);
    const source = makeOwnedProcessEnvironment({ ...makeTransportValues(), [invalid.key]: invalid.value });
    const descriptors = Object.getOwnPropertyDescriptors(source.environment);
    let spawnCalls = 0;

    await withIsolatedProcessEnvironment(source.environment, async () => {
      const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
        onNative() {},
        onAuthenticationRequired() {},
        spawnImpl() { spawnCalls += 1; throw new Error('unexpected fixture spawn'); },
      }));
      await assert.rejects(runner.start({ inputText: 'fixture task' }), (error) => {
        assert.equal(error.code, 'invalid_transport_environment');
        assert.equal(error.cause, undefined);
        assert.equal(error.message.includes('CREDENTIAL-SENTINEL'), false);
        assert.equal(error.message.includes(String(invalid.value)), false);
        return true;
      });
      assert.equal(spawnCalls, 0);
      assert.equal(runner.snapshot().failureCode, 'invalid_transport_environment');
      assert.deepEqual(Object.getOwnPropertyDescriptors(source.environment), descriptors);
      await runner.stop();
    });
  }
});

test('owned transport lookup errors use a fixed diagnostic without preserving their cause', async (t) => {
  const workspace = createWorkspace(t);
  const source = makeOwnedProcessEnvironment(makeTransportValues(), 'HTTPS_PROXY');
  const descriptors = Object.getOwnPropertyDescriptors(source.environment);
  let spawnCalls = 0;

  await withIsolatedProcessEnvironment(source.environment, async () => {
    const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
      onNative() {},
      onAuthenticationRequired() {},
      spawnImpl() { spawnCalls += 1; throw new Error('unexpected fixture spawn'); },
    }));
    await assert.rejects(runner.start({ inputText: 'fixture task' }), (error) => {
      assert.equal(error.code, 'invalid_transport_environment');
      assert.equal(error.cause, undefined);
      assert.equal(error.message.includes('fixture-private-proxy-CREDENTIAL-SENTINEL'), false);
      assert.equal(error.stack.includes('fixture-private-proxy-CREDENTIAL-SENTINEL'), false);
      return true;
    });
    assert.equal(source.lookupCounts.HTTPS_PROXY, 1);
    assert.equal(spawnCalls, 0);
    assert.deepEqual(Object.getOwnPropertyDescriptors(source.environment), descriptors);
    await runner.stop();
  });
});

test('owned runner omits unset and empty transport values and ignores lowercase names', async (t) => {
  const workspace = createWorkspace(t);
  const source = makeOwnedProcessEnvironment({
    HTTPS_PROXY: '', HTTP_PROXY: undefined, NO_PROXY: undefined, SSL_CERT_FILE: '', NODE_EXTRA_CA_CERTS: undefined,
  });
  source.environment.https_proxy = 'http://lowercase.invalid:8080';
  source.environment.ssl_cert_file = '/lowercase/ca.pem';

  await withIsolatedProcessEnvironment(source.environment, async () => {
    const harness = createOwnedCodexHarness(workspace);
    const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
      onNative() {},
      onAuthenticationRequired: ({ loginId }) => harness.child.send(codexLoginCompleted(loginId)),
      spawnImpl: harness.spawnImpl,
    }));
    await runner.start({ inputText: 'fixture task' });
    for (const key of TRANSPORT_ENVIRONMENT_KEYS) assert.equal(Object.hasOwn(harness.spawnEnvironment, key), false);
    assert.equal(Object.hasOwn(harness.spawnEnvironment, 'https_proxy'), false);
    assert.equal(Object.hasOwn(harness.spawnEnvironment, 'ssl_cert_file'), false);
    assertForbiddenEnvironmentAbsent(harness.spawnEnvironment);
    assert.equal(Object.keys(harness.environment).length, 0);
    assert.deepEqual(source.lookupCounts, Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, 1])));
    await runner.stop();
  });
});

test('invalid owned transport values are physically stopped by the owned stop path', async (t) => {
  const workspace = createWorkspace(t);
  const source = makeOwnedProcessEnvironment({ ...makeTransportValues(), HTTP_PROXY: 19 });
  const originalCreateServer = http.createServer;
  const servers = [];
  let spawnCalls = 0;
  let runner;
  http.createServer = function captureServer(...args) {
    const server = originalCreateServer.apply(this, args);
    servers.push(server);
    return server;
  };

  try {
    await withIsolatedProcessEnvironment(source.environment, async () => {
      runner = createOwnedNativeRunner(baseOptions(workspace, 'claude', {
        profile: 'cockpit-native-wait-v1',
        onNative() {},
        ownedSourceClaim: Object.freeze({}),
        getAuthentication: () => ({ oauthToken: 'fixture-oauth-CREDENTIAL-SENTINEL' }),
        onSourceReady() {},
        captureWaitAuthorization: () => null,
        onContextContinuation() {},
        spawnImpl() { spawnCalls += 1; throw new Error('unexpected fixture spawn'); },
      }));
      await assert.rejects(runner.start({ inputText: 'fixture task' }), (error) =>
        error.code === 'invalid_transport_environment' && error.cause === undefined);
      assert.equal(spawnCalls, 0);
      assert.equal(servers.length, 1);
      const stopped = await runner.stop();
      assert.equal(stopped.state, 'stopped');
      assert.equal(servers[0].listening, false);
    });
  } finally {
    if (runner) await runner.stop();
    http.createServer = originalCreateServer;
  }
});

test('owned wait endpoint startup does not read transport values while its listen callback is pending', async (t) => {
  const workspace = createWorkspace(t);
  const source = makeOwnedProcessEnvironment(makeTransportValues());
  const originalCreateServer = http.createServer;
  const originalListen = http.Server.prototype.listen;
  const servers = [];
  let resolveListening;
  const listening = new Promise((resolve) => { resolveListening = resolve; });
  let spawnCalls = 0;
  let runner;
  http.createServer = function captureServer(...args) {
    const server = originalCreateServer.apply(this, args);
    servers.push(server);
    server.once('listening', resolveListening);
    return server;
  };
  http.Server.prototype.listen = function holdListenCallback(...args) {
    const callbackIndex = args.length - 1;
    if (typeof args[callbackIndex] === 'function') args[callbackIndex] = () => {};
    return originalListen.apply(this, args);
  };

  try {
    await withIsolatedProcessEnvironment(source.environment, async () => {
      runner = createOwnedNativeRunner(baseOptions(workspace, 'claude', {
        profile: 'cockpit-native-wait-v1',
        onNative() {},
        ownedSourceClaim: Object.freeze({}),
        getAuthentication: () => ({ oauthToken: 'fixture-oauth-CREDENTIAL-SENTINEL' }),
        onSourceReady() {},
        captureWaitAuthorization: () => null,
        onContextContinuation() {},
        spawnImpl() { spawnCalls += 1; throw new Error('unexpected fixture spawn'); },
      }));
      const startPromise = runner.start({ inputText: 'fixture task' });
      await listening;
      assert.equal(servers.length, 1);
      assert.equal(servers[0].listening, true);
      assert.deepEqual(source.lookupCounts, Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, 0])));
      assert.equal(spawnCalls, 0);

      const stopped = await runner.stop();
      await assert.rejects(startPromise, (error) => error.code === 'operation_stopped');
      assert.equal(stopped.state, 'stopped');
      assert.equal(servers[0].listening, false);
      assert.deepEqual(source.lookupCounts, Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, 0])));
      assert.equal(spawnCalls, 0);
    });
  } finally {
    if (runner) await runner.stop();
    http.Server.prototype.listen = originalListen;
    http.createServer = originalCreateServer;
  }
});

test('owned runner stops after transport capture when the owner expires before spawn', async (t) => {
  const workspace = createWorkspace(t);
  const source = makeOwnedProcessEnvironment(makeTransportValues());
  let runner;
  let stopPromise;
  let spawnCalls = 0;

  await withIsolatedProcessEnvironment(source.environment, async () => {
    runner = createOwnedNativeRunner(baseOptions(workspace, 'claude', {
      onNative() {},
      getAuthentication: () => ({ oauthToken: 'fixture-oauth-CREDENTIAL-SENTINEL' }),
      isSourceCurrent() {
        if (source.lookupCounts.NODE_EXTRA_CA_CERTS === 1 && !stopPromise) stopPromise = runner.stop();
        return true;
      },
      spawnImpl() { spawnCalls += 1; throw new Error('unexpected fixture spawn'); },
    }));
    await assert.rejects(runner.start({ inputText: 'fixture task' }), (error) => error.code === 'operation_stopped');
    const stopped = await stopPromise;
    assert.equal(stopped.state, 'stopped');
    assert.deepEqual(source.lookupCounts, Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, 1])));
    assert.deepEqual(source.values, makeTransportValues());
    assert.equal(spawnCalls, 0);
    assert.equal(JSON.stringify(runner.snapshot()).includes('CREDENTIAL-SENTINEL'), false);
  });
});

test('owned runner clears its environment after a synchronous spawn error', async (t) => {
  const workspace = createWorkspace(t);
  const source = makeOwnedProcessEnvironment(makeTransportValues());
  let environmentReference;
  let spawnEnvironment;

  await withIsolatedProcessEnvironment(source.environment, async () => {
    const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
      onNative() {},
      onAuthenticationRequired() {},
      spawnImpl(_executable, _args, options) {
        environmentReference = options.env;
        spawnEnvironment = { ...options.env };
        throw new Error('fixture-CREDENTIAL-SENTINEL');
      },
    }));
    await assert.rejects(runner.start({ inputText: 'fixture task' }), (error) =>
      error.code === 'spawn_failed' && error.cause === undefined && !error.message.includes('CREDENTIAL-SENTINEL'));
    assert.deepEqual(readTransportValues(spawnEnvironment), source.values);
    assertForbiddenEnvironmentAbsent(spawnEnvironment);
    assert.equal(Object.keys(environmentReference).length, 0);
    assert.equal(JSON.stringify(runner.snapshot()).includes('CREDENTIAL-SENTINEL'), false);
    assert.deepEqual(source.lookupCounts, Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, 1])));
    await runner.stop();
  });
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

function makeOwnedProcessEnvironment(transportValues, throwingKey = null) {
  const values = { ...transportValues };
  const lookupCounts = Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, 0]));
  const environment = {
    PATH: 'owned-fixture-path',
    PATHEXT: '.EXE',
    SYSTEMROOT: 'owned-fixture-system-root',
    WINDIR: 'owned-fixture-windows-root',
    COMSPEC: 'owned-fixture-command-shell',
    ALL_PROXY: 'fixture-forbidden-all-proxy',
    SSL_CERT_DIR: 'fixture-forbidden-ca-dir',
    NODE_OPTIONS: '--require fixture-forbidden-module',
    NODE_TLS_REJECT_UNAUTHORIZED: '0',
    GH_TOKEN: 'fixture-forbidden-github-token',
    GITHUB_TOKEN: 'fixture-forbidden-github-token',
    CLAUDE_CODE_MESSAGING_TOKEN: 'fixture-forbidden-messaging-token',
    CUSTOM_ENDPOINT: 'fixture-forbidden-endpoint',
    https_proxy: 'http://lowercase.invalid:8080',
    ssl_cert_file: '/lowercase/ca.pem',
  };
  for (const key of TRANSPORT_ENVIRONMENT_KEYS) {
    Object.defineProperty(environment, key, {
      configurable: true,
      enumerable: true,
      get() {
        lookupCounts[key] += 1;
        if (key === throwingKey) throw new Error('fixture-private-proxy-CREDENTIAL-SENTINEL');
        return values[key];
      },
    });
  }
  return { environment, lookupCounts, values };
}

async function withIsolatedProcessEnvironment(environment, callback) {
  const originalEnvironment = process.env;
  process.env = environment;
  try {
    return await callback();
  } finally {
    process.env = originalEnvironment;
  }
}

function readTransportValues(environment) {
  return Object.fromEntries(TRANSPORT_ENVIRONMENT_KEYS.map((key) => [key, environment[key]]));
}

function assertForbiddenEnvironmentAbsent(environment) {
  for (const key of FORBIDDEN_INHERITED_ENVIRONMENT_KEYS) assert.equal(Object.hasOwn(environment, key), false);
}
