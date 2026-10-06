'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOwnedNativeRunner } = require('../src/server/owned-native-runner');

const LOGIN_ID = 'login_test_1';
const LOGIN_URL = 'https://auth.openai.com/oauth/authorize?code=test';

class FakePipe extends EventEmitter {
  constructor(onWrite) {
    super();
    this.onWrite = onWrite;
    this.writes = [];
    this.ended = false;
  }

  write(value, callback) {
    const text = value.toString();
    this.writes.push(text);
    if (this.onWrite) this.onWrite(text);
    queueMicrotask(() => { if (callback) callback(); });
    return true;
  }

  end() {
    this.ended = true;
  }
}

class FakeChild extends EventEmitter {
  constructor(onWrite) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.killCalls = [];
    this.exited = false;
    this.stdin = new FakePipe(onWrite ? (text) => onWrite(text, this) : null);
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
    if (!this.exited) {
      this.exited = true;
      setImmediate(() => {
        this.emit('exit', 0, signal || null);
        this.stdout.emit('end');
      });
    }
    return true;
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
  const harness = { calls: 0, child: null, executable: null, args: null, options: null, environment: null };
  harness.spawnImpl = (executable, args, options) => {
    harness.calls += 1;
    harness.executable = executable;
    harness.args = [...args];
    harness.options = { ...options, env: undefined };
    harness.home = options.env.HOME;
    harness.codexHome = options.env.CODEX_HOME;
    harness.claudeTokenPresent = typeof options.env.CLAUDE_CODE_OAUTH_TOKEN === 'string';
    harness.environment = options.env;
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

function codexResponder(options = {}) {
  const methods = [];
  const harness = createSpawnHarness(options.workspace, (line, child) => {
    const request = JSON.parse(line);
    if (!request.method || !Object.hasOwn(request, 'id')) return;
    methods.push(request.method);
    if (request.method === 'initialize') {
      if (options.serverRequest) {
        child.send({ id: 'server-request', method: 'item/commandExecution/requestApproval', params: { command: 'private' } });
      }
      child.send(codexResponse(request.id, { serverInfo: { name: 'codex', version: 'test' } }));
      return;
    }
    if (request.method === 'account/login/start') {
      if (options.earlyLoginCompletion) child.send(codexLoginCompleted(options.earlyLoginId || LOGIN_ID, true));
      child.send(codexResponse(request.id, {
        type: 'chatgpt',
        loginId: options.loginResponseId || LOGIN_ID,
        authUrl: LOGIN_URL,
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
              { type: 'result', session_id: 'session_native_1', result: secretText },
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

test('stop reports an owned child that did not emit exit or close before the kill timeout', async (t) => {
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
  assert.equal(afterExit.state, 'stopped');
  assert.equal(afterExit.childExited, true);
  assert.equal(afterExit.ownedChildActive, false);
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

test('a server permission request is never answered and terminates the Codex attempt', async (t) => {
  const workspace = createWorkspace(t);
  const harness = codexResponder({ workspace, serverRequest: true });
  let disconnect = null;
  const runner = createOwnedNativeRunner(baseOptions(workspace, 'codex', {
    onAuthenticationRequired() {},
    spawnImpl: harness.spawnImpl,
    onNative() {},
    onDisconnect: (event) => { disconnect = event; },
  }));
  await assert.rejects(runner.start({ inputText: 'task' }));
  assert.equal(runner.snapshot().failureCode, 'unknown_server_request');
  assert.equal(disconnect.reason, 'unknown_server_request');
  assert.deepEqual(harness.methods, ['initialize']);
  assert.equal(harness.child.stdin.writes.some((line) => line.includes('server-request')), false);
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

test('a wait receipt cannot release a different runner and unknown approval requests get no response', async (t) => {
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
  const unknownHarness = createWaitProfileHarness(unknownWorkspace);
  const unknownRunner = createWaitRunner(unknownWorkspace, unknownHarness);
  await unknownRunner.start({ inputText: 'fixed task' });
  unknownHarness.child.send({
    id: 'permission_request_1',
    method: 'item/commandExecution/requestApproval',
    params: { command: 'private' },
  });
  assert.equal(unknownHarness.child.stdin.writes.some((line) => line.includes('permission_request_1')), false);
  assert.equal(unknownRunner.snapshot().failureCode, 'unknown_server_request');
  await unknownRunner.stop();
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