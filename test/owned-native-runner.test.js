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
    spawnImpl: harness.spawnImpl,
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
