'use strict';

const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createNativeInstructionServiceIntegration } = require('../../src/server/native-instruction-service-integration');
const { createOwnedNativeRunner } = require('../../src/server/owned-native-runner');
const { atomicWriteJson } = require('../../src/server/json-storage');

const PROVIDERS = Object.freeze(['claude', 'codex']);
const NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });
const LOGIN_URL = 'https://auth.openai.com/oauth/authorize?code=fixture';

function rpcResponse(id, result) {
  return { jsonrpc: '2.0', id, result };
}

class FakeInput extends EventEmitter {
  constructor(onWrite) {
    super();
    this.destroyed = false;
    this.ended = false;
    this.writes = [];
    this.onWrite = onWrite;
  }

  write(value, callback) {
    if (this.destroyed || this.ended) throw new Error('fake_pipe_closed');
    const line = value.toString();
    this.writes.push(line);
    const outcome = this.onWrite?.(line);
    const error = outcome === 'write-error' ? Object.assign(new Error('fixture stdin write failure'), { code: 'fixture_stdin_write_failure' }) : null;
    queueMicrotask(() => callback?.(error));
    return true;
  }

  end() {
    this.ended = true;
  }
}

class FakeNativeChild extends EventEmitter {
  constructor(onWrite) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new FakeInput(onWrite);
    this.exited = false;
    this.killSignals = [];
  }

  send(...messages) {
    const data = messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
    this.stdout.emit('data', Buffer.from(data, 'utf8'));
  }

  kill(signal) {
    this.killSignals.push(signal || null);
    if (this.exited) return true;
    this.exited = true;
    this.stdin.destroyed = true;
    setImmediate(() => {
      this.emit('exit', 0, signal || null);
      this.emit('close', 0, signal || null);
      this.stdout.emit('end');
    });
    return true;
  }
}

function createFakeNativeProcess(provider, homePath, options = {}) {
  const nativeIdSuffix = options.nativeIdSuffix || randomUUID();
  const state = {
    provider,
    homePath,
    child: null,
    spawnCount: 0,
    rpcMethods: [],
    instructionWrites: [],
    threadId: `${provider}-native-thread-${nativeIdSuffix}`,
    sessionId: `${provider}-native-session-${nativeIdSuffix}`,
    turnId: `${provider}-native-turn-1`,
    messageId: `${provider}-assistant-message-1`,
    nextTurn: 2,
    nextMessage: 2,
    evidenceMode: options.instructionEvidence || 'none',
  };

  function emitInstructionItem(request, mode = state.evidenceMode) {
    if (provider !== 'codex' || mode === 'none') return;
    const expectedTurnId = request.method === 'turn/steer'
      ? request.params.expectedTurnId
      : `codex-instruction-turn-${state.nextTurn - 1}`;
    const content = request.params.input.map((item) => ({ type: 'text', text: item.text }));
    const item = {
      type: 'userMessage',
      clientId: request.params.clientUserMessageId,
      id: `codex-user-item-${state.instructionWrites.length}`,
      content,
    };
    if (mode === 'missing-client-id') delete item.clientId;
    if (mode === 'partial-input') item.content = [{ type: 'text', text: `${content[0]?.text || ''} ` }];
    const turnId = mode === 'wrong-turn' ? 'unrelated-native-turn' : expectedTurnId;
    state.child.send({
      jsonrpc: '2.0',
      method: 'item/started',
      params: { threadId: state.threadId, turnId, item },
    });
  }

  function respond(request) {
    if (provider === 'codex') {
      if (!request.method || !Object.hasOwn(request, 'id')) return;
      state.rpcMethods.push(request.method);
      if (request.method === 'initialize') {
        state.child.send(rpcResponse(request.id, {
          serverInfo: { name: 'codex', version: 'fixture' },
          codexHome: path.join(homePath, '.codex'),
        }));
      } else if (request.method === 'account/login/start') {
        state.child.send(rpcResponse(request.id, { type: 'chatgpt', loginId: 'fixture-login-id', authUrl: LOGIN_URL }));
      } else if (request.method === 'thread/start') {
        state.child.send(rpcResponse(request.id, { thread: { id: state.threadId } }));
      } else if (request.method === 'turn/start') {
        const isInstruction = state.rpcMethods.filter((method) => method === 'turn/start').length > 1;
        const turnId = isInstruction ? `codex-instruction-turn-${state.nextTurn++ - 1}` : state.turnId;
        if (isInstruction) {
          state.instructionWrites.push(request);
          if (options.instructionWriteError) return 'write-error';
          emitInstructionItem(request);
        }
        if (!isInstruction && options.earlyTurnCompletion) {
          state.child.send({
            jsonrpc: '2.0', method: 'turn/completed',
            params: { threadId: state.threadId, turn: { id: turnId } },
          });
        }
        state.child.send(rpcResponse(request.id, { turn: { id: turnId } }));
        if (isInstruction) state.turnId = turnId;
        else if (options.waitOnStart) setImmediate(() => state.child?.send({
          jsonrpc: '2.0', id: 'fixture-wait-request', method: 'item/tool/call',
          params: { threadId: state.threadId, turnId, callId: 'fixture-wait-call', namespace: null,
            tool: 'cockpit_wait', arguments: {} },
        }));
      } else if (request.method === 'turn/steer') {
        state.instructionWrites.push(request);
        if (options.instructionWriteError) return 'write-error';
        emitInstructionItem(request);
        state.child.send(rpcResponse(request.id, { turnId: request.params.expectedTurnId }));
      } else if (request.method === 'thread/loaded/list') {
        state.child.send(rpcResponse(request.id, { data: [state.threadId], nextCursor: null }));
      } else if (request.method === 'thread/read') {
        state.child.send(rpcResponse(request.id, {
          thread: {
            id: state.threadId,
            status: { type: 'active' },
            turns: [{ id: state.turnId, status: 'inProgress', items: [] }],
          },
        }));
      }
      return;
    }

    if (request.type !== 'user') return;
    if (!request.session_id) {
      state.child.send(
        { type: 'system', subtype: 'init', session_id: state.sessionId },
        {
          type: 'stream_event',
          session_id: state.sessionId,
          parent_tool_use_id: null,
          event: { type: 'message_start', message: { role: 'assistant', id: state.messageId } },
        },
      );
      return;
    }
    state.instructionWrites.push(request);
    const messageId = `claude-assistant-message-${state.nextMessage++}`;
    state.child.send({
      type: 'stream_event',
      session_id: state.sessionId,
      parent_tool_use_id: null,
      event: { type: 'message_start', message: { role: 'assistant', id: messageId } },
    });
    state.messageId = messageId;
  }

  const spawnImpl = (_executable, _args, spawnOptions) => {
    state.spawnCount += 1;
    state.child = new FakeNativeChild((line) => {
      let request;
      try { request = JSON.parse(line); } catch { return; }
      return respond(request);
    });
    state.environment = {
      home: spawnOptions.env.HOME,
      codexHome: spawnOptions.env.CODEX_HOME || null,
      claudeConfigDir: spawnOptions.env.CLAUDE_CONFIG_DIR || null,
      oauthTokenPresent: typeof spawnOptions.env.CLAUDE_CODE_OAUTH_TOKEN === 'string',
    };
    setImmediate(() => state.child.emit('spawn'));
    return state.child;
  };

  return Object.freeze({
    state,
    spawnImpl,
    emitInstructionEvidence(request = state.instructionWrites.at(-1), mode = 'full') {
      if (!request) return false;
      emitInstructionItem(request, mode);
      return true;
    },
    endCurrentContext() {
      if (!state.child) return false;
      if (provider === 'codex') {
        state.child.send({
          jsonrpc: '2.0', method: 'turn/completed',
          params: { threadId: state.threadId, turn: { id: state.turnId } },
        });
      } else {
        state.child.send({
          type: 'result', session_id: state.sessionId,
          uuid: `00000000-0000-4000-8000-${String(state.nextMessage).padStart(12, '0')}`,
          subtype: 'success',
        });
      }
      return true;
    },
    completeLogin(loginId) {
      if (!state.child || provider !== 'codex') return false;
      state.child.send({ jsonrpc: '2.0', method: 'account/login/completed', params: { loginId, success: true } });
      return true;
    },
  });
}

function defaultProfiles(directory) {
  return Object.fromEntries(PROVIDERS.map((provider) => [provider, {
    provider,
    executablePath: process.execPath,
    homePath: path.join(directory, 'homes', provider),
    homeScopeId: `fixture-${provider}-home-scope`,
    cwd: path.join(directory, 'workspaces', provider),
  }]));
}

async function createNativeInstructionIntegrationHarness(options = {}) {
  if (!options.directory || !path.isAbsolute(options.directory)) {
    throw new TypeError('an absolute directory is required');
  }
  const directory = options.directory;
  fs.mkdirSync(directory, { recursive: true });
  const externalRunnerFactory = options.runnerFactory;
  if (externalRunnerFactory !== undefined && typeof externalRunnerFactory !== 'function') {
    throw new TypeError('runnerFactory must be a function');
  }
  const profiles = options.profiles || defaultProfiles(directory);
  for (const profile of Object.values(profiles)) {
    fs.mkdirSync(profile.homePath, { recursive: true });
    fs.mkdirSync(profile.cwd, { recursive: true });
  }

  const processes = [];
  const processesByProvider = new Map(PROVIDERS.map((provider) => [provider, []]));
  let checkpointWriteCount = 0;
  let integration;

  function runnerFactory(runnerOptions) {
    const observedRunnerOptions = typeof options.onNative === 'function'
      ? {
          ...runnerOptions,
          onNative(event) {
            try { options.onNative(event); } catch {}
            const dropped = options.dropNative?.(event) === true;
            const accepted = dropped ? true : runnerOptions.onNative(event);
            try { options.afterNative?.(event); } catch {}
            return accepted;
          },
        }
      : runnerOptions;
    if (externalRunnerFactory) return externalRunnerFactory(observedRunnerOptions);
    const settings = options.fakeRuntime || {};
    const fakeProcess = createFakeNativeProcess(observedRunnerOptions.provider, observedRunnerOptions.homePath, {
      ...settings,
      nativeIdSuffix: processes.length + 1,
    });
    processes.push(fakeProcess);
    processesByProvider.get(observedRunnerOptions.provider).push(fakeProcess);
    return createOwnedNativeRunner({
      ...observedRunnerOptions,
      spawnImpl: fakeProcess.spawnImpl,
      timeouts: options.runnerTimeouts || { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 250 },
    });
  }

  const suppliedAuthentication = options.getAuthentication || (() => ({ oauthToken: 'fixture-oauth-token' }));
  const authPresenter = options.onAuthenticationRequired || ((challenge) => {
    if (externalRunnerFactory) throw new Error('authentication_presentation_unavailable');
    const processHarness = processesByProvider.get('codex').at(-1);
    if (!processHarness || !processHarness.completeLogin(challenge.loginId)) {
      throw new Error('fixture_login_process_unavailable');
    }
  });

  async function createIntegration() {
    return createNativeInstructionServiceIntegration({
      profiles,
      dataDirectory: directory,
      hostId: options.hostId || 'native-instruction-integration-host',
      runnerFactory,
      getAuthentication: suppliedAuthentication,
      onAuthenticationRequired: authPresenter,
      checkpointAtomicWrite: async (target, value) => {
        checkpointWriteCount += 1;
        const write = { attempt: checkpointWriteCount, target, value };
        await options.atomicWriteHook?.(write);
        await atomicWriteJson(path.dirname(target), path.basename(target), value);
        await options.afterCheckpointWrite?.(write);
      },
    });
  }

  integration = await createIntegration();

  async function admit(provider, suffix = randomUUID()) {
    if (!PROVIDERS.includes(provider)) throw new TypeError('unknown provider');
    const receipt = integration.native.admitLaunch({
      launchId: `launch-${provider}-${suffix}`,
      runId: `run-${provider}-${suffix}`,
      attemptId: `attempt-${provider}-${suffix}`,
      profileId: provider,
      origin: 'standalone',
      purpose: 'agent',
    });
    const collector = integration.native.createOwnedCollector(receipt);
    return { receipt, profileId: provider, collector };
  }

  async function start(provider, startOptions = {}) {
    if (!PROVIDERS.includes(provider)) throw new TypeError('unknown provider');
    const suffix = startOptions.launchSuffix || randomUUID();
    const started = await integration.native.startLaunch({
      launchId: `launch-${provider}-${suffix}`,
      runId: `run-${provider}-${suffix}`,
      attemptId: `attempt-${provider}-${suffix}`,
      profileId: provider,
      origin: 'standalone',
      purpose: 'agent',
      inputText: startOptions.inputText || `native integration fixture ${provider}`,
    });
    const processHarness = processesByProvider.get(provider).at(-1) || null;
    return {
      ...started,
      profileId: provider,
      process: processHarness?.state || null,
      processHarness,
    };
  }

  async function restartService() {
    await integration.close();
    integration = await createIntegration();
    await integration.service.ready();
    return integration.service;
  }

  async function close() {
    try { await integration.close(); } catch {}
  }

  return Object.freeze({
    directory,
    get checkpointPath() { return integration.checkpointPath; },
    get journalPath() { return integration.journalPath; },
    processes,
    processesByProvider,
    start,
    admit,
    restartService,
    close,
    get native() { return integration.native; },
    get service() { return integration.service; },
    get instructionTargetState() { return integration.instructionTargetState; },
    get checkpointWriteCount() { return checkpointWriteCount; },
  });
}
async function createTemporaryNativeInstructionHarness(options = {}) {
  const directory = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'native-instruction-integration-'));
  let harness;
  try {
    harness = await createNativeInstructionIntegrationHarness({ ...options, directory });
  } catch (error) {
    await fs.promises.rm(directory, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({
    directory,
    checkpointPath: harness.checkpointPath,
    journalPath: harness.journalPath,
    processes: harness.processes,
    processesByProvider: harness.processesByProvider,
    start: harness.start,
    admit: harness.admit,
    restartService: harness.restartService,
    get service() { return harness.service; },
    get instructionTargetState() { return harness.instructionTargetState; },
    get providerAdapters() { return harness.providerAdapters; },
    get providerInstructionAdapters() { return harness.providerInstructionAdapters; },
    get checkpointWriteCount() { return harness.checkpointWriteCount; },
    close: harness.close,
    get native() { return harness.native; },
    get checkpointWriteCount() { return harness.checkpointWriteCount; },
    async removeDirectory() {
      await harness.close();
      await fs.promises.rm(directory, { recursive: true, force: true });
    },
  });
}

module.exports = {
  createNativeInstructionIntegrationHarness,
  createTemporaryNativeInstructionHarness,
  createFakeNativeProcess,
  defaultProfiles,
  FakeNativeChild,
  NATIVE_ID_KINDS,
  PROVIDERS,
};
