'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createRegistrationKernel } = require('../src/server/conversation-registry');
const { createLaunchBindingKernel } = require('../src/server/launch-binding');
const { createRuntimeBindingKernel } = require('../src/server/runtime-binding');
const { createNativeLaunchComposition } = require('../src/server/native-launch-composition');
const { createOwnedNativeRunner } = require('../src/server/owned-native-runner');
const { createFakeNativeProcess } = require('./support/native-instruction-integration-harness');
const { createNativeInstructionOwnerRouter } = require('../src/server/native-instruction-service-integration');

const PROVIDERS = ['claude', 'codex'];
const NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });
const EXPECTED_HOME = path.resolve(os.tmpdir(), 'native-composition-home');

function evidence(evidenceId, extra = {}) {
  return {
    evidenceId,
    source: 'native-composition-fixture',
    method: 'owned-native-fixture',
    adapterVersion: 'fixture-1',
    runtimeVersion: 'fixture-1',
    capabilities: ['native-binding'],
    ...extra,
  };
}

function createFixture(options = {}) {
  const actualRegistrationKernel = createRegistrationKernel();
  const registrationCalls = { register: 0, bindWriter: 0, authorizeWriter: 0 };
  const registrationAuthority = Object.freeze({
    ...actualRegistrationKernel.authority,
    register(...args) {
      registrationCalls.register += 1;
      return actualRegistrationKernel.authority.register(...args);
    },
    bindWriter(...args) {
      registrationCalls.bindWriter += 1;
      return actualRegistrationKernel.authority.bindWriter(...args);
    },
  });
  const registrationRegistry = Object.freeze({
    ...actualRegistrationKernel.registry,
    checkAuthorityRevision(stamp) {
      return options.revisionCheck ? options.revisionCheck(stamp, actualRegistrationKernel.registry.checkAuthorityRevision) : actualRegistrationKernel.registry.checkAuthorityRevision(stamp);
    },
    authorizeWriter(...args) {
      registrationCalls.authorizeWriter += 1;
      return actualRegistrationKernel.registry.authorizeWriter(...args);
    },
  });
  const registrationKernel = Object.freeze({
    ...actualRegistrationKernel,
    registry: registrationRegistry,
    authority: registrationAuthority,
  });
  const actualLaunchKernel = createLaunchBindingKernel({ registrationRegistry: registrationKernel.registry });
  const launchCalls = { registerLaunch: 0, bindExecution: 0 };
  const launchAuthority = Object.freeze({
    ...actualLaunchKernel.authority,
    registerLaunch(...args) {
      launchCalls.registerLaunch += 1;
      return actualLaunchKernel.authority.registerLaunch(...args);
    },
    bindExecution(...args) {
      launchCalls.bindExecution += 1;
      return actualLaunchKernel.authority.bindExecution(...args);
    },
  });
  const launchKernel = Object.freeze({ ...actualLaunchKernel, authority: launchAuthority });
  const actualRuntimeKernel = createRuntimeBindingKernel({
    registrationRegistry: registrationKernel.registry,
    launchRegistry: launchKernel.registry,
  });
  const attestedActors = new Map();
  const runtimeCalls = { adoptExecution: 0, attestActor: 0, reconcileExecution: 0, handoff: 0 };
  const openedConnections = [];
  const runtimeAuthority = Object.freeze({
    ...actualRuntimeKernel.authority,
    adoptExecution(...args) {
      runtimeCalls.adoptExecution += 1;
      return actualRuntimeKernel.authority.adoptExecution(...args);
    },
    openConnection(...args) {
      const opened = actualRuntimeKernel.authority.openConnection(...args);
      openedConnections.push({ scope: structuredClone(args[0]), ...opened });
      return opened;
    },
    attestActor(connectionHandle, claims, proof) {
      runtimeCalls.attestActor += 1;
      const result = actualRuntimeKernel.authority.attestActor(connectionHandle, claims, proof);
      const items = attestedActors.get(claims.launchRef) || [];
      items.push(result.actorHandle);
      attestedActors.set(claims.launchRef, items);
      return result;
    },
    reconcileExecution(...args) {
      runtimeCalls.reconcileExecution += 1;
      return actualRuntimeKernel.authority.reconcileExecution(...args);
    },
    handoff(...args) {
      runtimeCalls.handoff += 1;
      return actualRuntimeKernel.authority.handoff(...args);
    },
  });
  const runtimeRegistry = Object.freeze({
    ...actualRuntimeKernel.registry,
    checkCurrentConnection(handle) {
      return options.connectionCheck
        ? options.connectionCheck(handle, actualRuntimeKernel.registry.checkCurrentConnection)
        : actualRuntimeKernel.registry.checkCurrentConnection(handle);
    },
    snapshot() {
      const snapshot = actualRuntimeKernel.registry.snapshot();
      if (options.onRuntimeSnapshot) options.onRuntimeSnapshot();
      return snapshot;
    },
  });
  const runtimeKernel = Object.freeze({ ...actualRuntimeKernel, registry: runtimeRegistry, authority: runtimeAuthority });
  const profiles = Object.fromEntries(PROVIDERS.map((provider) => [provider, {
    provider,
    executablePath: path.resolve(os.tmpdir(), `private-${provider}.exe`),
    homePath: path.resolve(EXPECTED_HOME, provider),
    homeScopeId: `scope-${provider}`,
    cwd: path.resolve(os.tmpdir(), `private-${provider}-cwd`),
  }]));
  profiles['codex-alt'] = Object.freeze({
    provider: 'codex',
    executablePath: path.resolve(os.tmpdir(), 'private-codex-alt.exe'),
    homePath: path.resolve(EXPECTED_HOME, 'codex-alt'),
    homeScopeId: 'scope-codex-alt',
    cwd: path.resolve(os.tmpdir(), 'private-codex-alt-cwd'),
  });
  for (const [profileId, profile] of Object.entries(options.profileOverrides || {})) {
    profiles[profileId] = Object.freeze({ ...profiles[profileId], ...profile });
  }
  const plans = [];
  const runners = [];
  const createStubRunner = (runnerOptions) => {
    const runner = {
      options: runnerOptions,
      startCalls: 0,
      stopCalls: 0,
      async start(input) {
        runner.startCalls += 1;
        const plan = plans.shift();
        if (plan) await plan(runner, input);
      },
      async stop() { runner.stopCalls += 1; },
      snapshot() { return { state: 'fixture' }; },
    };
    runners.push(runner);
    return runner;
  };
  const runnerFactory = options.runnerFactory
    ? (runnerOptions) => options.runnerFactory(runnerOptions, createStubRunner)
    : createStubRunner;
  const composition = createNativeLaunchComposition({
    registrationKernel,
    launchKernel,
    runtimeKernel,
    runnerFactory,
    hostId: 'fixture-host',
    profiles,
    getAuthentication: options.getAuthentication || (() => undefined),
    ...(options.onAuthenticationRequired ? { onAuthenticationRequired: options.onAuthenticationRequired } : {}),
  });
  let evidenceSerial = 0;

  function admission(provider, suffix, options = {}) {
    return composition.admitLaunch({
      launchId: `launch-${suffix}`,
      runId: `run-${suffix}`,
      attemptId: `attempt-${suffix}`,
      profileId: options.profileId || provider,
      origin: options.origin || 'standalone',
      purpose: options.purpose || 'agent',
      ...(options.originReceipt ? { originReceipt: options.originReceipt } : {}),
    });
  }

  function sendMainContext(runner, provider, suffix, options = {}) {
    const identity = {
      provider,
      nativeIdKind: NATIVE_ID_KINDS[provider],
      hostId: 'fixture-host',
      homeScopeId: profiles[provider].homeScopeId,
      nativeId: `${provider}-native-${suffix}`,
    };
    const context = {
      kind: provider === 'codex' ? 'turn' : 'assistant_message',
      nativeContextId: options.contextId || `${provider}-context-${suffix}`,
      parentToolUseId: options.parentToolUseId ?? null,
    };
    runner.options.onNative({ type: 'identity', provider, identity });
    if (!options.omitContext) runner.options.onNative({ type: 'context', provider, identity, context });
    return { identity, context };
  }

  async function startStandalone(provider, suffix, inputText = `private prompt ${suffix}`) {
    plans.push(async (runner) => sendMainContext(runner, provider, suffix));
    const receipt = admission(provider, suffix);
    return { receipt, result: await composition.start(receipt, { inputText }) };
  }

  function nextEvidence(label) {
    return evidence(`test-${++evidenceSerial}-${label}`);
  }

  return {
    composition,
    registrationKernel,
    actualRegistrationKernel,
    registrationCalls,
    launchKernel,
    launchCalls,
    runtimeKernel,
    actualRuntimeKernel,
    runtimeCalls,
    openedConnections,
    attestedActors,
    profiles,
    plans,
    runners,
    admission,
    sendMainContext,
    startStandalone,
    nextEvidence,
  };
}

function assertCode(action, code) {
  assert.throws(action, (error) => error && error.code === code);
}

class FakePipe extends EventEmitter {
  constructor(onWrite) {
    super();
    this.onWrite = onWrite;
  }

  write(value, callback) {
    this.onWrite?.(value.toString());
    queueMicrotask(() => callback?.());
    return true;
  }

  end() {}
}

class FakeChild extends EventEmitter {
  constructor(onWrite, options = {}) {
    super();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.stdin = new FakePipe((line) => onWrite(line, this));
    this.exited = false;
    this.suppressKillClose = options.suppressKillClose === true;
    this.killEvents = options.killEvents || ['exit', 'close'];
    this.killResult = options.killResult ?? true;
    this.killError = options.killError || null;
  }

  send(...messages) {
    const body = messages.map((message) => JSON.stringify(message)).join('\n') + '\n';
    this.stdout.emit('data', Buffer.from(body, 'utf8'));
  }

  kill(signal) {
    if (this.killError) throw this.killError;
    if (this.killResult === false) return false;
    if (!this.exited && !this.suppressKillClose) {
      this.exited = this.killEvents.includes('exit');
      setImmediate(() => {
        for (const event of this.killEvents) this.emit(event, 0, signal || null);
        this.stdout.emit('end');
      });
    }
    return this.killResult;
  }
}

function createOwnedWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'native-composition-owned-'));
  const workspace = {
    root,
    homePath: path.join(root, 'isolated-home'),
    cwd: path.join(root, 'empty-workspace'),
    executablePath: path.join(root, process.platform === 'win32' ? 'native.exe' : 'native'),
  };
  fs.mkdirSync(workspace.homePath);
  fs.mkdirSync(workspace.cwd);
  fs.writeFileSync(workspace.executablePath, 'fixture executable');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return workspace;
}

function createOwnedRunnerFactory(workspace, provider, options = {}) {
  const harness = { child: null, methods: [], responses: [], spawnCalls: 0, options: null };
  const spawnImpl = (executable, args, spawnOptions) => {
    harness.spawnCalls += 1;
    harness.options = { executable, args: [...args], cwd: spawnOptions.cwd, shell: spawnOptions.shell };
    harness.child = new FakeChild((line, child) => {
      let request;
      try { request = JSON.parse(line); } catch { request = null; }
      if (provider === 'claude') {
        if (request?.type === 'user') {
          child.send(
            { type: 'system', subtype: 'init', session_id: options.nativeId || 'session-integration' },
            {
              type: 'stream_event',
              session_id: options.nativeId || 'session-integration',
              parent_tool_use_id: null,
              event: { type: 'message_start', message: { id: 'message-integration', role: 'assistant' } },
            },
          );
        }
        return;
      }
      if (!request?.method || !Object.hasOwn(request, 'id')) {
        if (request && Object.hasOwn(request, 'result')) harness.responses.push(request);
        return;
      }
      harness.methods.push(request.method);
      if (request.method === 'initialize') {
        child.send({ id: request.id, result: { serverInfo: { name: 'fixture', version: '1' }, codexHome: path.join(workspace.homePath, '.codex') } });
      } else if (request.method === 'account/login/start') {
        child.send({ id: request.id, result: {
          type: 'chatgpt', loginId: 'login-integration', authUrl: 'https://auth.example.test/device',
        } });
      } else if (request.method === 'thread/start') {
        child.send({ id: request.id, result: { thread: { id: options.nativeId || 'thread-integration' } } });
      } else if (request.method === 'turn/start') {
        child.send({ id: request.id, result: { turn: { id: 'turn-integration' } } });
      }
    }, { suppressKillClose: options.suppressKillClose });
    setImmediate(() => harness.child.emit('spawn'));
    return harness.child;
  };
  const runnerFactory = (runnerOptions) => {
    harness.runnerOptions = runnerOptions;
    assert.equal(typeof runnerOptions.isCurrent, 'function');
    if (provider === 'codex') {
      assert.equal(Object.hasOwn(runnerOptions, 'onAuthenticationRequired'), true);
      assert.equal(Object.hasOwn(runnerOptions, 'getAuthentication'), false);
    } else {
      assert.equal(Object.hasOwn(runnerOptions, 'onAuthenticationRequired'), false);
      assert.equal(Object.hasOwn(runnerOptions, 'getAuthentication'), true);
    }
    harness.runner = createOwnedNativeRunner({
      ...runnerOptions,
      ...(options.waitProfile ? { profile: 'cockpit-native-wait-v1', onWaitRequired: options.onWaitRequired } : {}),
      spawnImpl,
      timeouts: { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: options.stopMs ?? 100 },
    });
    return harness.runner;
  };
  const onAuthenticationRequired = options.onAuthenticationRequired || (({ loginId }) => {
    harness.child.send({ method: 'account/login/completed', params: { loginId, success: true } });
  });
  return { harness, runnerFactory, onAuthenticationRequired };
}

function createOwnedCompositionFixture(t, provider, options = {}) {
  const workspace = createOwnedWorkspace(t);
  const owned = createOwnedRunnerFactory(workspace, provider, options);
  const profile = {
    executablePath: workspace.executablePath,
    homePath: workspace.homePath,
    cwd: workspace.cwd,
  };
  const fixture = createFixture({
    runnerFactory: owned.runnerFactory,
    getAuthentication: () => ({ oauthToken: 'fixture-claude-token' }),
    onAuthenticationRequired: owned.onAuthenticationRequired,
    profileOverrides: { [provider]: profile },
    onRuntimeSnapshot: options.onRuntimeSnapshot,
  });
  return { ...fixture, workspace, nativeHarness: owned.harness };
}

for (const provider of PROVIDERS) {
  test(`${provider} binds only its owned native identity and context to an active registered period`, async () => {
    const fixture = createFixture();
    const { result } = await fixture.startStandalone(provider, 'primary');

    assert.equal(result.accepted, true);
    assert.equal(result.status, 'observed');
    assert.equal(result.observation.provider, provider);
    assert.equal(result.observation.nativeId, `${provider}-native-primary`);
    assert.equal(result.observation.executionId, fixture.registrationKernel.registry.snapshot().executions[0].executionId);
    assert.equal(fixture.registrationKernel.registry.snapshot().executions.length, 1);
    assert.equal(fixture.launchKernel.registry.snapshot().launches[0].state, 'bound');
    assert.equal(fixture.runtimeKernel.registry.snapshot().launches[0].currentProof.ownerGeneration, 0);
    assert.equal(fixture.composition.resolveProof(result.launchRef) !== null, true);

    const visible = JSON.stringify(fixture.composition.snapshot());
    for (const secret of [
      'private prompt primary',
      fixture.profiles[provider].executablePath,
      fixture.profiles[provider].homePath,
      fixture.profiles[provider].cwd,
    ]) assert.equal(visible.includes(secret), false, secret);
    for (const field of ['connectionHandle', 'actorHandle', 'proofHandle', 'writerToken', 'cwd', 'homePath']) {
      assert.equal(Object.hasOwn(fixture.composition.snapshot().launches[0], field), false, field);
    }
    assert.equal(Object.keys(result.runReceipt).length, 0);
  });

  test(`${provider} composition passes only its native runner authentication options`, async (t) => {
    const fixture = createOwnedCompositionFixture(t, provider);
    const receipt = fixture.admission(provider, 'owned-runner');
    const result = await fixture.composition.start(receipt, { inputText: 'integration fixture input' });

    assert.equal(result.accepted, true);
    assert.equal(result.observation.status, 'observed');
    assert.equal(fixture.nativeHarness.spawnCalls, 1);
    assert.equal(fixture.registrationCalls.register, 1);
    assert.equal(fixture.runtimeKernel.registry.snapshot().actors.length, 1);
    assert.equal(fixture.composition.resolveProof(result.launchRef) !== null, true);
    if (provider === 'codex') {
      assert.deepEqual(fixture.nativeHarness.methods, ['initialize', 'account/login/start', 'thread/start', 'turn/start']);
    }
    await fixture.composition.stop(receipt);
  });
}

test('the same attempt and prompt reuse one opaque receipt and spawn once', async () => {
  const fixture = createFixture();
  fixture.plans.push(async (runner) => fixture.sendMainContext(runner, 'codex', 'replay'));
  const input = {
    launchId: 'launch-replay',
    runId: 'run-replay',
    attemptId: 'attempt-replay',
    profileId: 'codex',
    origin: 'standalone',
    purpose: 'agent',
  };
  const first = fixture.composition.admitLaunch(input);
  const replay = fixture.composition.admitLaunch({ ...input });
  assert.equal(first, replay);

  const firstStart = fixture.composition.start(first, { inputText: 'a prompt that must not be retained' });
  const repeatedStart = fixture.composition.start(replay, { inputText: 'a prompt that must not be retained' });
  assert.equal(firstStart, repeatedStart);
  const result = await firstStart;
  assert.equal(result.accepted, true);
  assert.equal(fixture.runners.length, 1);
  assert.equal(fixture.runners[0].startCalls, 1);
  await assert.rejects(
    fixture.composition.start(first, { inputText: 'a different prompt' }),
    (error) => error.code === 'attempt_conflict',
  );
  assert.equal(JSON.stringify(fixture.composition.snapshot()).includes('a prompt that must not be retained'), false);
  assert.equal(fixture.composition.snapshot().launches.length, 1);
  assertCode(() => fixture.composition.admitLaunch({ ...input, profileId: 'codex-alt' }), 'attempt_conflict');
  assert.equal(fixture.launchKernel.registry.snapshot().launches.length, 1);
});

test('stop before the start microtask prevents a runner spawn', async () => {
  const fixture = createFixture();
  const receipt = fixture.admission('claude', 'stop-before-start');
  const starting = fixture.composition.start(receipt, { inputText: 'private input' });
  const startRejected = assert.rejects(starting, (error) => error.code === 'start_invalidated');
  await fixture.composition.stop(receipt);

  await startRejected;
  assert.equal(fixture.runners.length, 1);
  assert.equal(fixture.runners[0].startCalls, 0);
  assert.equal(fixture.runners[0].stopCalls, 1);
  assert.equal(fixture.registrationKernel.registry.snapshot().executions.length, 0);
});

test('unmatched identity and nested Claude messages cannot create actor proof', async () => {
  const mismatch = createFixture();
  mismatch.plans.push(async (runner) => {
    const identity = {
      provider: 'codex', nativeIdKind: 'thread', hostId: 'other-host',
      homeScopeId: mismatch.profiles.codex.homeScopeId, nativeId: 'forged-thread',
    };
    runner.options.onNative({ type: 'identity', provider: 'codex', identity });
  });
  const mismatchReceipt = mismatch.admission('codex', 'scope-mismatch');
  const mismatchResult = await mismatch.composition.start(mismatchReceipt, { inputText: 'fixture input' });
  assert.equal(mismatchResult.accepted, false);
  assert.equal(mismatch.registrationKernel.registry.snapshot().executions.length, 0);
  assert.equal(mismatch.runtimeKernel.registry.snapshot().actors.length, 0);

  const nested = createFixture();
  nested.plans.push(async (runner) => nested.sendMainContext(runner, 'claude', 'nested', { parentToolUseId: 'tool-use-1' }));
  const nestedReceipt = nested.admission('claude', 'nested');
  const nestedResult = await nested.composition.start(nestedReceipt, { inputText: 'fixture input' });
  assert.equal(nestedResult.accepted, false);
  assert.equal(nestedResult.reason, 'native_context_unavailable');
  assert.equal(nested.registrationKernel.registry.snapshot().executions.length, 1);
  assert.equal(nested.runtimeKernel.registry.snapshot().actors.length, 0);
});

test('a context received before identity creates an actor only after its identity is registered', async () => {
  const fixture = createFixture();
  fixture.plans.push(async (runner) => {
    const identity = {
      provider: 'codex', nativeIdKind: 'thread', hostId: 'fixture-host',
      homeScopeId: fixture.profiles.codex.homeScopeId, nativeId: 'codex-native-reordered',
    };
    const context = { kind: 'turn', nativeContextId: 'codex-context-reordered', parentToolUseId: null };
    runner.options.onNative({ type: 'context', provider: 'codex', identity, context });
    assert.equal(fixture.registrationKernel.registry.snapshot().executions.length, 0);
    assert.equal(fixture.runtimeKernel.registry.snapshot().actors.length, 0);
    runner.options.onNative({ type: 'identity', provider: 'codex', identity });
  });
  const receipt = fixture.admission('codex', 'reordered');
  const result = await fixture.composition.start(receipt, { inputText: 'fixture input' });

  assert.equal(result.accepted, true);
  assert.equal(fixture.registrationKernel.registry.snapshot().executions.length, 1);
  assert.equal(fixture.runtimeKernel.registry.snapshot().actors.length, 1);
});

test('a second owned launch cannot register an identity already assigned to another launch', async () => {
  const fixture = createFixture({
    profileOverrides: {
      'codex-alt': { homeScopeId: 'scope-codex' },
    },
  });
  const first = await fixture.startStandalone('codex', 'identity-owner');
  const firstWriter = fixture.composition.writerFor(first.result.launchRef);
  const registrationCalls = fixture.registrationCalls.register;
  const bindCalls = fixture.launchCalls.bindExecution;
  const adoptCalls = fixture.runtimeCalls.adoptExecution;
  const actorCount = fixture.runtimeKernel.registry.snapshot().actors.length;
  fixture.plans.push(async (runner) => {
    const identity = {
      provider: 'codex', nativeIdKind: 'thread', hostId: 'fixture-host',
      homeScopeId: fixture.profiles.codex.homeScopeId, nativeId: 'codex-native-identity-owner',
    };
    runner.options.onNative({ type: 'identity', provider: 'codex', identity });
    runner.options.onNative({
      type: 'context', provider: 'codex', identity,
      context: { kind: 'turn', nativeContextId: 'second-launch-context', parentToolUseId: null },
    });
  });
  const secondReceipt = fixture.admission('codex', 'identity-contender', { profileId: 'codex-alt' });
  const second = await fixture.composition.start(secondReceipt, { inputText: 'second fixture input' });
  const secondLaunch = fixture.launchKernel.registry.snapshot().launches.find((item) =>
    item.launchId === 'launch-identity-contender');

  assert.equal(second.accepted, false);
  assert.equal(second.observation.reason, 'native_identity_already_owned');
  assert.equal(fixture.registrationCalls.register, registrationCalls);
  assert.equal(fixture.launchCalls.bindExecution, bindCalls);
  assert.equal(fixture.runtimeCalls.adoptExecution, adoptCalls);
  assert.equal(fixture.registrationKernel.registry.snapshot().executions.length, 1);
  assert.equal(fixture.runtimeKernel.registry.snapshot().actors.length, actorCount);
  assert.equal(fixture.runtimeKernel.registry.get(secondLaunch.launchRef), null);
  assert.equal(fixture.runners[1].stopCalls, 1);
  assert.equal(fixture.composition.resolveProof(first.result.launchRef) !== null, true);
  const authorizeCalls = fixture.registrationCalls.authorizeWriter;
  assert.equal(fixture.composition.authorizeWriter(secondLaunch.launchRef, firstWriter).status, 'unverified');
  assert.equal(fixture.registrationCalls.authorizeWriter, authorizeCalls);
  assert.equal(fixture.registrationCalls.bindWriter, 1);
  assert.equal(fixture.composition.snapshot().launches.filter((item) =>
    item.nativeId === 'codex-native-identity-owner').length, 1);
});

test('a #192 proof context from a different connection is rejected before runtime authority use', async () => {
  const fixture = createFixture();
  const { result } = await fixture.startStandalone('codex', 'foreign-connection');
  const runtime = fixture.runtimeKernel.registry.get(result.launchRef);
  const launch = fixture.launchKernel.registry.get(result.launchRef);
  const opened = fixture.openedConnections[0];
  const proof = fixture.composition.resolveProof(result.launchRef);
  const reconcileCalls = fixture.runtimeCalls.reconcileExecution;
  const foreignContext = {
    launchRef: result.launchRef,
    connectionHandle: Object.freeze({}),
    connectionGeneration: runtime.currentProof.executionConnectionGeneration,
    scope: opened.scope,
    identity: launch.identity,
    periodId: launch.executionBinding.periodId,
    actor: launch.executionBinding.actor,
    contextId: runtime.currentProof.executionContextId,
    isCurrent: () => true,
  };

  assert.equal(await fixture.composition.reconcileProof(result.launchRef, foreignContext), null);
  assert.equal(fixture.runtimeCalls.reconcileExecution, reconcileCalls);
  assert.equal(fixture.composition.resolveProof(result.launchRef), proof);
  assert.equal(fixture.runtimeKernel.registry.checkCurrentProof(result.launchRef, proof).ok, true);
});

test('resolveProof rejects a synchronous reentry without invalidating the underlying proof', async () => {
  const fixture = createFixture();
  const { result } = await fixture.startStandalone('codex', 'reentrant-proof');
  const runtime = fixture.runtimeKernel.registry.get(result.launchRef);
  const launch = fixture.launchKernel.registry.get(result.launchRef);
  const scope = fixture.openedConnections[0].scope;
  const proof = fixture.composition.resolveProof(result.launchRef);
  let reentrantProof = proof;
  let reentrantVerdict;
  const context = {
    launchRef: result.launchRef,
    connectionHandle: fixture.openedConnections[0].connectionHandle,
    connectionGeneration: runtime.currentProof.executionConnectionGeneration,
    scope,
    identity: launch.identity,
    periodId: launch.executionBinding.periodId,
    actor: launch.executionBinding.actor,
    contextId: runtime.currentProof.executionContextId,
    isCurrent() {
      reentrantVerdict = fixture.composition.checkCurrentProof(result.launchRef, proof);
      reentrantProof = fixture.composition.resolveProof(result.launchRef);
      return true;
    },
  };

  assert.equal(fixture.composition.resolveProof(result.launchRef, context), null);
  assert.equal(reentrantProof, null);
  assert.equal(reentrantVerdict.ok, false);
  assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, true);
  assert.equal(fixture.composition.resolveProof(result.launchRef), proof);
  assert.equal(fixture.runtimeKernel.registry.checkCurrentProof(result.launchRef, proof).ok, true);
});

test('repeated identity and context events for one launch do not duplicate registration or actor binding', async () => {
  const fixture = createFixture();
  const { result } = await fixture.startStandalone('claude', 'duplicate-callback');
  const runner = fixture.runners[0];
  const identity = {
    provider: 'claude', nativeIdKind: 'session', hostId: 'fixture-host',
    homeScopeId: fixture.profiles.claude.homeScopeId, nativeId: 'claude-native-duplicate-callback',
  };
  const context = { kind: 'assistant_message', nativeContextId: 'claude-context-duplicate-callback', parentToolUseId: null };
  const counts = {
    registration: fixture.registrationCalls.register,
    actors: fixture.runtimeKernel.registry.snapshot().actors.length,
    attest: fixture.runtimeCalls.attestActor,
    reconcile: fixture.runtimeCalls.reconcileExecution,
  };

  runner.options.onNative({ type: 'identity', provider: 'claude', identity });
  runner.options.onNative({ type: 'context', provider: 'claude', identity, context });
  assert.equal(fixture.registrationCalls.register, counts.registration);
  assert.equal(fixture.runtimeKernel.registry.snapshot().actors.length, counts.actors);
  assert.equal(fixture.runtimeCalls.attestActor, counts.attest);
  assert.equal(fixture.runtimeCalls.reconcileExecution, counts.reconcile);
  assert.equal(fixture.composition.resolveProof(result.launchRef) !== null, true);
  assert.equal(fixture.composition.snapshot().launches.filter((item) =>
    item.nativeId === identity.nativeId).length, 1);
});

for (const { parentProvider, childProvider } of [
  { parentProvider: 'codex', childProvider: 'claude' },
  { parentProvider: 'claude', childProvider: 'codex' },
]) {
test(`delegated ${parentProvider} ownership of ${childProvider} launch preserves origin through handoff`, async () => {
  const fixture = createFixture();
  const parent = await fixture.startStandalone(parentProvider, `parent-${parentProvider}`);
  const target = await fixture.startStandalone('codex', 'target');

  fixture.plans.push(async (runner) => fixture.sendMainContext(runner, childProvider, `child-${childProvider}`));
  const childAdmission = fixture.admission(childProvider, `child-${childProvider}`, {
    origin: 'delegated', purpose: 'agent', originReceipt: parent.result.runReceipt,
  });
  const child = await fixture.composition.start(childAdmission, { inputText: 'private child prompt' });
  const childLaunch = fixture.launchKernel.registry.get(child.launchRef);
  const parentLaunch = fixture.launchKernel.registry.get(parent.result.launchRef);
  const targetLaunch = fixture.launchKernel.registry.get(target.result.launchRef);
  assert.deepEqual(childLaunch.originBinding, parentLaunch.executionBinding);
  assert.notDeepEqual(childLaunch.executionBinding, parentLaunch.executionBinding);

  const handoffRequest = { handoffId: 'handoff-once', expectedOwnerGeneration: 0 };
  const handoffReceipt = fixture.composition.handoff(
    child.runReceipt,
    parent.result.runReceipt,
    target.result.runReceipt,
    handoffRequest,
  );
  assert.equal(fixture.composition.resolveProof(child.launchRef), null);
  const handoffReplay = fixture.composition.handoff(
    child.runReceipt,
    parent.result.runReceipt,
    target.result.runReceipt,
    handoffRequest,
  );
  assert.equal(handoffReplay, handoffReceipt);
  const handoffCalls = fixture.runtimeCalls.handoff;
  assertCode(() => fixture.composition.handoff(
    child.runReceipt,
    parent.result.runReceipt,
    parent.result.runReceipt,
    handoffRequest,
  ), 'handoff_conflict');
  assert.equal(fixture.runtimeCalls.handoff, handoffCalls);
  assert.equal(fixture.runtimeKernel.registry.get(child.launchRef).ownerGeneration, 1);

  const reconciled = await fixture.composition.reconcileProof(child.launchRef);
  assert.ok(reconciled);
  assert.equal(fixture.runtimeKernel.registry.get(child.launchRef).ownerGeneration, 1);
  const formerOwnerActors = fixture.attestedActors.get(parent.result.launchRef);
  fixture.actualRuntimeKernel.authority.endActor(formerOwnerActors[0]);
  await fixture.composition.stop(parent.receipt);
  assert.notEqual(fixture.composition.resolveProof(child.launchRef), null);
  assert.equal(fixture.launchKernel.registry.get(child.launchRef).originBinding.periodId,
    parent.result.observation.executionId);
  assert.equal(fixture.runtimeKernel.registry.get(child.launchRef).currentOwner.periodId,
    target.result.observation.executionId);

  const liveTargetActor = fixture.attestedActors.get(target.result.launchRef)[0];
  fixture.actualRuntimeKernel.authority.endActor(liveTargetActor);
  fixture.actualRegistrationKernel.authority.end(target.result.observation.executionId);
  const writerCalls = fixture.registrationCalls.bindWriter;
  assert.equal(fixture.composition.writerFor(child.launchRef), null);
  assert.equal(fixture.registrationCalls.bindWriter, writerCalls);
  assert.equal(fixture.composition.resolveProof(child.launchRef), null);
});
}

test('an expired ancestor owner invalidates descendant proofs, writers, and new delegated admission', async () => {
  const fixture = createFixture();
  const parent = await fixture.startStandalone('claude', 'chain-parent');

  fixture.plans.push(async (runner) => fixture.sendMainContext(runner, 'codex', 'chain-child-a'));
  const childAReceipt = fixture.admission('codex', 'chain-child-a', {
    origin: 'delegated', purpose: 'agent', originReceipt: parent.result.runReceipt,
  });
  const childA = await fixture.composition.start(childAReceipt, { inputText: 'child A' });

  fixture.plans.push(async (runner) => fixture.sendMainContext(runner, 'claude', 'chain-child-b'));
  const childBReceipt = fixture.admission('claude', 'chain-child-b', {
    origin: 'delegated', purpose: 'agent', originReceipt: childA.runReceipt,
  });
  const childB = await fixture.composition.start(childBReceipt, { inputText: 'child B' });
  const proofB = fixture.composition.resolveProof(childB.launchRef);
  const writerB = fixture.composition.writerFor(childB.launchRef);
  assert.ok(proofB);
  assert.ok(writerB);

  fixture.runners[0].options.onNative({
    type: 'context_ended',
    provider: 'claude',
    identity: {
      provider: 'claude', nativeIdKind: 'session', hostId: 'fixture-host',
      homeScopeId: fixture.profiles.claude.homeScopeId, nativeId: 'claude-native-chain-parent',
    },
    context: { kind: 'assistant_message', nativeContextId: 'claude-context-chain-parent' },
  });

  assert.equal(fixture.composition.resolveProof(childA.launchRef), null);
  assert.equal(fixture.composition.resolveProof(childB.launchRef), null);
  assert.equal(fixture.runtimeKernel.registry.checkCurrentProof(childB.launchRef, proofB).ok, true);
  const authorizeCalls = fixture.registrationCalls.authorizeWriter;
  assert.notEqual(fixture.composition.authorizeWriter(childB.launchRef, writerB).status, 'accepted');
  assert.equal(fixture.registrationCalls.authorizeWriter, authorizeCalls);

  const launchCount = fixture.launchKernel.registry.snapshot().launches.length;
  const runnerCount = fixture.runners.length;
  assert.throws(() => fixture.admission('codex', 'chain-child-c', {
    origin: 'delegated', purpose: 'agent', originReceipt: childB.runReceipt,
  }), (error) => error.code === 'origin_receipt_unavailable');
  assert.equal(fixture.launchKernel.registry.snapshot().launches.length, launchCount);
  assert.equal(fixture.runners.length, runnerCount);
});

test('an ancestor ended after a current-owner handoff does not invalidate descendants', async () => {
  const fixture = createFixture();
  const parent = await fixture.startStandalone('claude', 'rebound-parent');
  const target = await fixture.startStandalone('codex', 'rebound-target');

  fixture.plans.push(async (runner) => fixture.sendMainContext(runner, 'codex', 'rebound-child-a'));
  const childAReceipt = fixture.admission('codex', 'rebound-child-a', {
    origin: 'delegated', purpose: 'agent', originReceipt: parent.result.runReceipt,
  });
  const childA = await fixture.composition.start(childAReceipt, { inputText: 'child A' });

  fixture.plans.push(async (runner) => fixture.sendMainContext(runner, 'claude', 'rebound-child-b'));
  const childBReceipt = fixture.admission('claude', 'rebound-child-b', {
    origin: 'delegated', purpose: 'agent', originReceipt: childA.runReceipt,
  });
  const childB = await fixture.composition.start(childBReceipt, { inputText: 'child B' });
  const proofB = fixture.composition.resolveProof(childB.launchRef);
  const writerB = fixture.composition.writerFor(childB.launchRef);
  assert.ok(proofB);
  assert.ok(writerB);

  assert.ok(fixture.composition.handoff(
    childA.runReceipt,
    parent.result.runReceipt,
    target.result.runReceipt,
    { handoffId: 'rebind-ancestor', expectedOwnerGeneration: 0 },
  ));
  assert.ok(await fixture.composition.reconcileProof(childA.launchRef));
  assert.ok(fixture.composition.resolveProof(childB.launchRef));

  fixture.runners[0].options.onNative({
    type: 'context_ended',
    provider: 'claude',
    identity: {
      provider: 'claude', nativeIdKind: 'session', hostId: 'fixture-host',
      homeScopeId: fixture.profiles.claude.homeScopeId, nativeId: 'claude-native-rebound-parent',
    },
    context: { kind: 'assistant_message', nativeContextId: 'claude-context-rebound-parent' },
  });

  assert.equal(fixture.composition.resolveProof(childA.launchRef) !== null, true);
  assert.equal(fixture.composition.resolveProof(childB.launchRef) !== null, true);
  assert.equal(fixture.composition.authorizeWriter(childB.launchRef, writerB).status, 'accepted');
  assert.equal(fixture.runtimeKernel.registry.checkCurrentProof(childB.launchRef, proofB).ok, true);
});

test('handoff rejects a target owner chain that reaches the execution', async () => {
  const fixture = createFixture();
  const execution = await fixture.startStandalone('claude', 'cycle-execution');
  const target = await fixture.startStandalone('codex', 'cycle-target');

  assert.ok(fixture.composition.handoff(
    execution.result.runReceipt,
    execution.result.runReceipt,
    target.result.runReceipt,
    { handoffId: 'cycle-first-edge', expectedOwnerGeneration: 0 },
  ));
  assert.ok(await fixture.composition.reconcileProof(execution.result.launchRef));
  const handoffCalls = fixture.runtimeCalls.handoff;
  const targetProof = fixture.composition.resolveProof(target.result.launchRef);

  assertCode(() => fixture.composition.handoff(
    target.result.runReceipt,
    target.result.runReceipt,
    execution.result.runReceipt,
    { handoffId: 'cycle-closing-edge', expectedOwnerGeneration: 0 },
  ), 'handoff_cycle');

  assert.equal(fixture.runtimeCalls.handoff, handoffCalls);
  assert.equal(fixture.composition.resolveProof(execution.result.launchRef) !== null, true);
  assert.equal(fixture.composition.resolveProof(target.result.launchRef), targetProof);
  assert.equal(fixture.runtimeKernel.registry.get(target.result.launchRef).ownerGeneration, 0);
});

test('a standalone launch can hand off to a live owner and rebind against the new current owner', async () => {
  const fixture = createFixture();
  const execution = await fixture.startStandalone('claude', 'standalone-handoff-execution');
  const target = await fixture.startStandalone('codex', 'standalone-handoff-target');
  const result = fixture.composition.handoff(
    execution.result.runReceipt,
    execution.result.runReceipt,
    target.result.runReceipt,
    { handoffId: 'standalone-handoff', expectedOwnerGeneration: 0 },
  );
  assert.ok(result);
  assert.equal(fixture.composition.resolveProof(execution.result.launchRef), null);

  const reconciled = await fixture.composition.reconcileProof(execution.result.launchRef);
  const currentProof = fixture.composition.resolveProof(execution.result.launchRef);
  const targetLaunch = fixture.launchKernel.registry.get(target.result.launchRef);
  assert.ok(reconciled);
  assert.ok(currentProof);
  assert.deepEqual(fixture.runtimeKernel.registry.get(execution.result.launchRef).currentOwner,
    targetLaunch.executionBinding);

  const nextTarget = await fixture.startStandalone('claude', 'standalone-handoff-next-target');
  const runtimeCalls = fixture.runtimeCalls.reconcileExecution;
  assertCode(() => fixture.composition.handoff(
    execution.result.runReceipt,
    target.result.runReceipt,
    nextTarget.result.runReceipt,
    { handoffId: 'stale-standalone-handoff', expectedOwnerGeneration: 0 },
  ), 'stale_owner');
  assert.equal(fixture.runtimeCalls.reconcileExecution, runtimeCalls);
  assert.equal(fixture.composition.resolveProof(execution.result.launchRef), currentProof);
});

test('writer envelopes are reused for one native context and a second context quarantines the attempt', async () => {
  const fixture = createFixture();
  const { result } = await fixture.startStandalone('codex', 'writer');
  const first = fixture.composition.writerFor(result.launchRef);
  const replay = fixture.composition.writerFor(result.launchRef);
  const proof = fixture.composition.resolveProof(result.launchRef);
  assert.equal(first.token, replay.token);
  assert.equal(fixture.composition.authorizeWriter(result.launchRef, first).status, 'accepted');

  const runner = fixture.runners[0];
  runner.options.onNative({
    type: 'context',
    provider: 'codex',
    identity: {
      provider: 'codex', nativeIdKind: 'thread', hostId: 'fixture-host',
      homeScopeId: fixture.profiles.codex.homeScopeId, nativeId: 'codex-native-writer',
    },
    context: { kind: 'turn', nativeContextId: 'codex-context-writer-next', parentToolUseId: null },
  });
  const afterContext = fixture.composition.writerFor(result.launchRef);
  assert.equal(afterContext, null);
  assert.equal(fixture.composition.snapshot().launches[0].reason, 'native_context_conflict');
  assert.equal(fixture.composition.resolveProof(result.launchRef), null);
  assert.equal(fixture.runtimeKernel.registry.checkCurrentProof(result.launchRef, proof).ok, false);
  assert.notEqual(fixture.composition.authorizeWriter(result.launchRef, first).status, 'accepted');
  assert.equal(fixture.runtimeKernel.registry.snapshot().actors.length, 1);
});

for (const provider of PROVIDERS) {
  test(`${provider} context completion expires only its proof and keeps the canonical period active`, async () => {
    const fixture = createFixture();
    const { result } = await fixture.startStandalone(provider, 'completion');
    const proof = fixture.composition.resolveProof(result.launchRef);
    const runner = fixture.runners[0];
    const identity = {
      provider,
      nativeIdKind: NATIVE_ID_KINDS[provider],
      hostId: 'fixture-host',
      homeScopeId: fixture.profiles[provider].homeScopeId,
      nativeId: `${provider}-native-completion`,
    };
    const context = {
      kind: provider === 'codex' ? 'turn' : 'assistant_message',
      nativeContextId: `${provider}-context-completion`,
    };
    const actorCount = fixture.runtimeKernel.registry.snapshot().actors.length;
    const executionCount = fixture.registrationKernel.registry.snapshot().executions.length;

    runner.options.onNative({ type: 'context_ended', provider, identity, context });
    assert.equal(fixture.composition.resolveProof(result.launchRef), null);
    assert.equal(fixture.runtimeKernel.registry.checkCurrentProof(result.launchRef, proof).ok, false);
    assert.equal(fixture.composition.snapshot().launches[0].reason, 'native_context_ended');
    assert.equal(fixture.registrationKernel.registry.snapshot().executions.length, executionCount);
    assert.equal(fixture.registrationKernel.registry.snapshot().executions[0].state, 'active');
    assert.equal(fixture.runtimeKernel.registry.snapshot().actors.length, actorCount);

    runner.options.onNative({ type: 'context', provider, identity, context: { ...context, parentToolUseId: null } });
    assert.equal(fixture.composition.resolveProof(result.launchRef), null);
    assert.equal(fixture.runtimeKernel.registry.snapshot().actors.length, actorCount);
  });
}

test('a terminal context received before its context event prevents later proof creation', async () => {
  const fixture = createFixture();
  fixture.plans.push(async (runner) => {
    const { identity, context } = fixture.sendMainContext(runner, 'codex', 'early-terminal', { omitContext: true });
    runner.options.onNative({
      type: 'context_ended',
      provider: 'codex',
      identity,
      context: { kind: context.kind, nativeContextId: context.nativeContextId },
    });
    runner.options.onNative({ type: 'context', provider: 'codex', identity, context });
  });
  const receipt = fixture.admission('codex', 'early-terminal');
  const result = await fixture.composition.start(receipt, { inputText: 'fixture input' });

  assert.equal(result.accepted, false);
  assert.equal(result.reason, 'native_context_ended');
  assert.equal(fixture.runtimeKernel.registry.snapshot().actors.length, 0);
  assert.equal(fixture.registrationKernel.registry.snapshot().executions[0].state, 'active');
});

test('stop keeps proof revoked and reports an unconfirmed child until exit and close are observed', async (t) => {
  const fixture = createOwnedCompositionFixture(t, 'codex', {
    suppressKillClose: true,
    stopMs: 50,
  });
  const { receipt, result } = await fixture.startStandalone('codex', 'stop-unconfirmed');
  const proof = fixture.composition.resolveProof(result.launchRef);
  const firstStop = fixture.composition.stop(receipt);

  assert.equal(fixture.composition.snapshot().launches[0].processState, 'stopping');
  assert.equal(fixture.composition.resolveProof(result.launchRef), null);
  const duplicateStop = fixture.composition.stop(receipt);
  assert.equal(duplicateStop, firstStop);
  assert.equal(fixture.composition.snapshot().launches[0].processState, 'stopping');

  const stopped = await firstStop;
  assert.equal(stopped.processState, 'stop_unconfirmed');
  assert.equal(stopped.reason, 'owned_process_stop_unconfirmed');
  assert.equal(fixture.nativeHarness.runnerOptions.provider, 'codex');
  assert.equal(fixture.nativeHarness.child.exited, false);
  assert.equal(fixture.runtimeKernel.registry.checkCurrentProof(result.launchRef, proof).ok, false);
  assert.equal(fixture.registrationKernel.registry.snapshot().executions[0].state, 'active');
  fixture.nativeHarness.child.exited = true;
  fixture.nativeHarness.child.emit('exit', 137, 'SIGKILL');
  assert.equal(fixture.composition.snapshot().launches[0].processState, 'stop_unconfirmed');
  assert.equal(fixture.nativeHarness.runnerOptions.isCurrent(), false);
  fixture.nativeHarness.child.emit('close');
  assert.equal(fixture.nativeHarness.child.exited, true);
  assert.equal(fixture.nativeHarness.runnerOptions.isCurrent(), false);
  assert.equal(fixture.composition.snapshot().launches[0].processState, 'stopped');
  assert.equal(fixture.composition.resolveProof(result.launchRef), null);
});

test('composition does not infer stop success from a runner snapshot without both termination flags', async () => {
  const fixture = createFixture();
  const { receipt } = await fixture.startStandalone('codex', 'missing-termination-evidence');
  const stopped = await fixture.composition.stop(receipt);
  assert.equal(stopped.processState, 'stop_unconfirmed');
  assert.equal(stopped.reason, 'owned_process_stop_unconfirmed');
  assert.equal(fixture.composition.snapshot().launches[0].processState, 'stop_unconfirmed');
});

test('a native source identity conflict quarantines the connection and expires its proof', async () => {
  const fixture = createFixture();
  const { result } = await fixture.startStandalone('claude', 'quarantine');
  const proof = fixture.composition.resolveProof(result.launchRef);
  const actorCount = fixture.runtimeKernel.registry.snapshot().actors.length;
  const executionCount = fixture.registrationKernel.registry.snapshot().executions.length;
  fixture.runners[0].options.onNative({
    type: 'identity',
    provider: 'claude',
    identity: {
      provider: 'claude', nativeIdKind: 'session', hostId: 'fixture-host',
      homeScopeId: fixture.profiles.claude.homeScopeId, nativeId: 'different-session',
    },
  });

  assert.equal(fixture.composition.snapshot().launches[0].reason, 'native_identity_conflict');
  assert.equal(fixture.composition.resolveProof(result.launchRef), null);
  assert.equal(fixture.runtimeKernel.registry.checkCurrentProof(result.launchRef, proof).ok, false);
  fixture.runners[0].options.onNative({
    type: 'context',
    provider: 'claude',
    identity: {
      provider: 'claude', nativeIdKind: 'session', hostId: 'fixture-host',
      homeScopeId: fixture.profiles.claude.homeScopeId, nativeId: 'claude-native-quarantine',
    },
    context: { kind: 'assistant_message', nativeContextId: 'late-context', parentToolUseId: null },
  });
  assert.equal(fixture.runtimeKernel.registry.snapshot().actors.length, actorCount);
  assert.equal(fixture.registrationKernel.registry.snapshot().executions.length, executionCount);
  assert.equal(fixture.composition.resolveProof(result.launchRef), null);
});

test('Codex login challenge goes only to the injected trusted presentation callback', async () => {
  const challenges = [];
  const fixture = createFixture({
    onAuthenticationRequired(challenge) {
      assert.equal(Object.isFrozen(challenge), true);
      assert.deepEqual(Object.keys(challenge).sort(), ['authUrl', 'loginId']);
      assert.equal(fixture.registrationKernel.registry.snapshot().executions.length, 0);
      challenges.push(challenge);
    },
  });
  fixture.plans.push(async (runner) => {
    await runner.options.onAuthenticationRequired({
      loginId: 'login-fixture',
      authUrl: 'https://auth.example.test/device?code=private-code',
    });
    fixture.sendMainContext(runner, 'codex', 'auth');
  });
  const receipt = fixture.admission('codex', 'auth');
  const result = await fixture.composition.start(receipt, { inputText: 'private auth prompt' });

  assert.equal(result.accepted, true);
  assert.equal(challenges.length, 1);
  const visible = JSON.stringify(fixture.composition.snapshot());
  assert.equal(visible.includes('login-fixture'), false);
  assert.equal(visible.includes('auth.example.test'), false);
  assert.equal(visible.includes('private-code'), false);
  assert.equal(visible.includes('private auth prompt'), false);
  const runner = fixture.runners[0];
  await fixture.composition.stop(receipt);
  assertCode(() => runner.options.onAuthenticationRequired({
    loginId: 'late-login', authUrl: 'https://auth.example.test/late',
  }), 'launch_authority_expired');
  assert.equal(challenges.length, 1);
});

test('a delegated launch whose parent period ended before start creates no child process or binding', async () => {
  let challengeCount = 0;
  const fixture = createFixture({ onAuthenticationRequired() { challengeCount += 1; } });
  const parent = await fixture.startStandalone('claude', 'expired-parent');
  const childAdmission = fixture.admission('codex', 'expired-child', {
    origin: 'delegated', purpose: 'agent', originReceipt: parent.result.runReceipt,
  });
  const childLaunch = fixture.launchKernel.registry.snapshot().launches.find((item) =>
    item.launchId === 'launch-expired-child');
  const bindCalls = fixture.launchCalls.bindExecution;
  const adoptCalls = fixture.runtimeCalls.adoptExecution;
  fixture.actualRegistrationKernel.authority.end(parent.result.observation.executionId);

  await assert.rejects(
    fixture.composition.start(childAdmission, { inputText: 'private child input' }),
    (error) => error.code === 'origin_receipt_unavailable',
  );
  assert.equal(challengeCount, 0);
  assert.equal(fixture.runners.length, 1);
  assert.equal(fixture.registrationKernel.registry.snapshot().executions.length, 1);
  assert.equal(fixture.launchCalls.bindExecution, bindCalls);
  assert.equal(fixture.runtimeCalls.adoptExecution, adoptCalls);
  assert.equal(fixture.runtimeKernel.registry.get(childLaunch.launchRef), null);
  assert.equal(fixture.launchKernel.registry.get(childLaunch.launchRef).state, 'registered');
  assert.equal(fixture.launchKernel.registry.get(childLaunch.launchRef).executionBinding, null);
});

test('a parent period that ends during Codex login prevents thread and turn creation', async (t) => {
  const workspace = createOwnedWorkspace(t);
  let resolveChallenge;
  let loginId;
  const challenge = new Promise((resolve) => { resolveChallenge = resolve; });
  const owned = createOwnedRunnerFactory(workspace, 'codex', {
    onAuthenticationRequired(value) {
      loginId = value.loginId;
      resolveChallenge(value);
    },
  });
  const fixture = createFixture({
    runnerFactory: (runnerOptions, createStubRunner) => runnerOptions.provider === 'codex'
      ? owned.runnerFactory(runnerOptions)
      : createStubRunner(runnerOptions),
    getAuthentication: () => ({ oauthToken: 'unused-codex-auth' }),
    onAuthenticationRequired: owned.onAuthenticationRequired,
    profileOverrides: {
      codex: {
        executablePath: workspace.executablePath,
        homePath: workspace.homePath,
        cwd: workspace.cwd,
      },
    },
  });
  const parent = await fixture.startStandalone('claude', 'parent-login-wait');
  const childAdmission = fixture.admission('codex', 'child-login-wait', {
    origin: 'delegated', purpose: 'agent', originReceipt: parent.result.runReceipt,
  });
  const bindCalls = fixture.launchCalls.bindExecution;
  const adoptCalls = fixture.runtimeCalls.adoptExecution;
  const pendingStart = fixture.composition.start(childAdmission, { inputText: 'private child prompt' });
  const loginChallenge = await challenge;
  assert.equal(loginChallenge.loginId, 'login-integration');
  assert.equal(fixture.registrationKernel.registry.snapshot().executions.length, 1);
  assert.equal(fixture.launchCalls.bindExecution, bindCalls);
  assert.equal(fixture.runtimeCalls.adoptExecution, adoptCalls);

  fixture.actualRegistrationKernel.authority.end(parent.result.observation.executionId);
  assert.equal(owned.harness.runnerOptions.isCurrent(), false);
  owned.harness.child.send({
    method: 'account/login/completed', params: { loginId, success: true },
  });
  await assert.rejects(pendingStart, (error) => error.code === 'authority_expired');

  assert.deepEqual(owned.harness.methods, ['initialize', 'account/login/start']);
  assert.equal(fixture.registrationKernel.registry.snapshot().executions.length, 1);
  const childLaunch = fixture.launchKernel.registry.snapshot().launches.find((item) =>
    item.launchId === 'launch-child-login-wait');
  assert.equal(fixture.launchKernel.registry.get(childLaunch.launchRef).state, 'registered');
  assert.equal(fixture.launchKernel.registry.get(childLaunch.launchRef).executionBinding, null);
  assert.equal(fixture.runtimeKernel.registry.get(childLaunch.launchRef), null);
  await fixture.composition.stop(childAdmission);
});

test('an opaque receipt clone and a caller-supplied binding cannot create a launch', async () => {
  const fixture = createFixture();
  const parent = await fixture.startStandalone('claude', 'receipt-parent');
  const cloned = structuredClone(parent.result.runReceipt);
  assertCode(() => fixture.composition.admitLaunch({
    launchId: 'launch-forged-origin',
    runId: 'run-forged-origin',
    attemptId: 'attempt-forged-origin',
    profileId: 'codex',
    origin: 'delegated',
    purpose: 'agent',
    originReceipt: cloned,
  }), 'origin_receipt_unavailable');
  assertCode(() => fixture.composition.admitLaunch({
    launchId: 'launch-json-binding',
    runId: 'run-json-binding',
    attemptId: 'attempt-json-binding',
    profileId: 'codex',
    origin: 'delegated',
    purpose: 'agent',
    originBinding: { periodId: 'forged', actor: { kind: 'agent', id: 'forged' } },
    originReceipt: parent.result.runReceipt,
  }), 'invalid_admission');
  assert.equal(fixture.launchKernel.registry.snapshot().launches.length, 1);
});

for (const provider of PROVIDERS) {
  test(`ID-F04-N06 ${provider}: fresh native context retains the main actor and retires old proof and writer`, { timeout: 1000 }, async () => {
    const fixture = createFixture();
    const { result } = await fixture.startStandalone(provider, 'fresh-main');
    const proof = fixture.composition.resolveProof(result.launchRef);
    const writer = fixture.composition.writerFor(result.launchRef);
    const before = fixture.launchKernel.registry.get(result.launchRef);
    const registrationCount = fixture.registrationCalls.register;
    const actor = fixture.runtimeKernel.registry.snapshot().actors[0];
    const runner = fixture.runners[0];
    const identity = before.identity;
    assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, true);
    runner.options.onNative({ type: 'context_ended', provider, identity,
      context: { kind: provider === 'codex' ? 'turn' : 'assistant_message', nativeContextId: actor.contextId } });
    const ended = fixture.runtimeKernel.registry.snapshot().actors[0];
    assert.equal(ended.state, 'active');
    assert.equal(ended.contextState, 'ended');
    assert.equal(runner.stopCalls, 0);
    assert.equal(runner.options.isCurrent(), true);
    const authorizeCalls = fixture.registrationCalls.authorizeWriter;
    assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, false);
    assert.notEqual(fixture.composition.authorizeWriter(result.launchRef, writer).status, 'accepted');
    assert.equal(fixture.registrationCalls.authorizeWriter, authorizeCalls);
    assert.equal(await fixture.composition.reconcileProof(result.launchRef), null);
    runner.options.onNative({ type: 'context', provider, identity,
      context: { kind: provider === 'codex' ? 'turn' : 'assistant_message', nativeContextId: 'fresh-main-context', parentToolUseId: null } });
    const fresh = fixture.composition.resolveProof(result.launchRef);
    assert.ok(fresh);
    assert.notEqual(fresh, proof);
    assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, false);
    assert.equal(fixture.composition.checkCurrentProof(result.launchRef, structuredClone(fresh)).ok, false);
    assert.equal(fixture.composition.checkCurrentProof(result.launchRef, fresh).ok, true);
    runner.options.onNative({ type: 'context', provider, identity,
      context: { kind: provider === 'codex' ? 'turn' : 'assistant_message', nativeContextId: actor.contextId, parentToolUseId: null } });
    assert.equal(fixture.composition.resolveProof(result.launchRef), fresh);
    const freshWriter = fixture.composition.writerFor(result.launchRef);
    assert.notEqual(freshWriter.token, writer.token);
    assert.notEqual(fixture.composition.authorizeWriter(result.launchRef, writer).status, 'accepted');
    assert.equal(fixture.composition.authorizeWriter(result.launchRef, freshWriter).status, 'accepted');
    assert.equal(fixture.registrationCalls.register, registrationCount);
    assert.deepEqual(fixture.launchKernel.registry.get(result.launchRef), before);
    assert.equal(fixture.registrationKernel.registry.snapshot().executions[0].state, 'active');
    assert.ok(fixture.runtimeKernel.registry.snapshot().actors.every((row) =>
      row.actor.id === actor.actor.id && row.periodId === actor.periodId && row.state === 'active'));
  });

  test(`ID-F04-N07 ${provider}: each descendant requires explicit reconciliation after its ancestor context ends`, { timeout: 1000 }, async () => {
    const fixture = createFixture();
    const parent = await fixture.startStandalone(provider, 'fresh-chain-parent');
    const children = [];
    let owner = parent.result;
    for (const suffix of ['a', 'b']) {
      fixture.plans.push(async (runner) => fixture.sendMainContext(runner, provider, `fresh-chain-${suffix}`));
      const receipt = fixture.admission(provider, `fresh-chain-${suffix}`, {
        origin: 'delegated', originReceipt: owner.runReceipt,
      });
      const result = await fixture.composition.start(receipt, { inputText: suffix });
      children.push({ result, proof: fixture.composition.resolveProof(result.launchRef),
        writer: fixture.composition.writerFor(result.launchRef), receipt });
      owner = result;
    }
    const fixed = fixture.launchKernel.registry.snapshot();
    const parentRecord = fixture.launchKernel.registry.get(parent.result.launchRef);
    fixture.runners[0].options.onNative({ type: 'context_ended', provider, identity: parentRecord.identity,
      context: { kind: provider === 'codex' ? 'turn' : 'assistant_message', nativeContextId: `${provider}-context-fresh-chain-parent` } });
    for (const child of children) {
      assert.equal(fixture.composition.checkCurrentProof(child.result.launchRef, child.proof).ok, false);
      assert.notEqual(fixture.composition.authorizeWriter(child.result.launchRef, child.writer).status, 'accepted');
    }
    assert.equal(fixture.runtimeKernel.registry.checkCurrentProof(children[1].result.launchRef, children[1].proof).ok, true);
    fixture.sendMainContext(fixture.runners[0], provider, 'fresh-chain-parent', { contextId: 'fresh-parent-context' });
    for (const child of children) assert.equal(fixture.composition.resolveProof(child.result.launchRef), null);
    assert.equal(await fixture.composition.reconcileProof(children[1].result.launchRef), null);
    for (const child of children) {
      const proof = await fixture.composition.reconcileProof(child.result.launchRef);
      assert.ok(proof);
      assert.notEqual(proof, child.proof);
      assert.equal(fixture.composition.checkCurrentProof(child.result.launchRef, child.proof).ok, false);
      assert.equal(fixture.composition.checkCurrentProof(child.result.launchRef, proof).ok, true);
      assert.notEqual(fixture.composition.authorizeWriter(child.result.launchRef, child.writer).status, 'accepted');
      const writer = fixture.composition.writerFor(child.result.launchRef);
      assert.notEqual(writer.token, child.writer.token);
      assert.equal(fixture.composition.authorizeWriter(child.result.launchRef, writer).status, 'accepted');
    }
    assert.deepEqual(fixture.launchKernel.registry.snapshot(), fixed);
    assert.equal(fixture.registrationKernel.registry.snapshot().executions.length, 3);
    assert.ok(fixture.registrationKernel.registry.snapshot().executions.every((row) => row.state === 'active'));
    const leaf = children[1];
    const current = fixture.composition.resolveProof(leaf.result.launchRef);
    const writer = fixture.composition.writerFor(leaf.result.launchRef);
    const authorizeCalls = fixture.registrationCalls.authorizeWriter;
    assert.equal(fixture.actualRegistrationKernel.authority.end(parentRecord.executionBinding.periodId), true);
    assert.equal(fixture.composition.checkCurrentProof(leaf.result.launchRef, current).ok, false);
    assert.notEqual(fixture.composition.authorizeWriter(leaf.result.launchRef, writer).status, 'accepted');
    assert.equal(fixture.registrationCalls.authorizeWriter, authorizeCalls);
  });
}

for (const provider of PROVIDERS) {
  for (const mode of ['stop', 'disconnect', 'quarantine']) {
    test(`ID-F04-N08 ${provider} ${mode}: confirmed source loss retires descendant proof and writer`, { timeout: 1000 }, async () => {
      const fixture = createFixture();
      const parent = await fixture.startStandalone(provider, `loss-parent-${mode}`);
      fixture.plans.push(async (runner) => fixture.sendMainContext(runner, provider, `loss-child-${mode}`));
      const receipt = fixture.admission(provider, `loss-child-${mode}`, {
        origin: 'delegated', originReceipt: parent.result.runReceipt,
      });
      const result = await fixture.composition.start(receipt, { inputText: 'loss-child' });
      const proof = fixture.composition.resolveProof(result.launchRef);
      const writer = fixture.composition.writerFor(result.launchRef);
      const runner = fixture.runners[0];
      if (mode === 'stop') await fixture.composition.stop(parent.receipt);
      else if (mode === 'disconnect') runner.options.onDisconnect({ provider, reason: 'fixture-disconnected' });
      else runner.options.onNative({ type: 'unrecognized', provider });
      assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, false);
      assert.equal(fixture.composition.resolveProof(result.launchRef), null);
      const calls = fixture.registrationCalls.authorizeWriter;
      assert.notEqual(fixture.composition.authorizeWriter(result.launchRef, writer).status, 'accepted');
      assert.equal(fixture.registrationCalls.authorizeWriter, calls);
      assert.equal(await fixture.composition.reconcileProof(result.launchRef), null);
      assert.equal(fixture.composition.snapshot().launches[1].reason, 'current_proof_unavailable');
      assert.ok(fixture.registrationKernel.registry.snapshot().executions.every((row) => row.state === 'active'));
    });
  }

  test(`ID-F04-N09 ${provider}: a stale kernel connection cannot authorize the captured payload proof`, { timeout: 1000 }, async () => {
    const fixture = createFixture();
    const { result } = await fixture.startStandalone(provider, 'unknown-connection');
    const proof = fixture.composition.resolveProof(result.launchRef);
    const writer = fixture.composition.writerFor(result.launchRef);
    assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, true);
    fixture.actualRuntimeKernel.authority.disconnect(fixture.openedConnections[0].connectionHandle);
    assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, false);
    const calls = fixture.registrationCalls.authorizeWriter;
    assert.notEqual(fixture.composition.authorizeWriter(result.launchRef, writer).status, 'accepted');
    assert.equal(fixture.registrationCalls.authorizeWriter, calls);
    assert.equal(fixture.runtimeKernel.registry.snapshot().actors[0].state, 'unknown');
    assert.equal(fixture.runtimeKernel.registry.snapshot().actors[0].contextState, 'unknown');
  });
}

for (const provider of PROVIDERS) {
  test(`ID-F04-N10 ${provider}: an idle owner does not terminate the child's trusted native source`, { timeout: 1000 }, async () => {
    const fixture = createFixture();
    const parent = await fixture.startStandalone(provider, 'idle-source-parent');
    fixture.plans.push(async (runner) => fixture.sendMainContext(runner, provider, 'idle-source-child'));
    const receipt = fixture.admission(provider, 'idle-source-child', {
      origin: 'delegated', originReceipt: parent.result.runReceipt,
    });
    const result = await fixture.composition.start(receipt, { inputText: 'idle-source-child' });
    const oldProof = fixture.composition.resolveProof(result.launchRef);
    const oldWriter = fixture.composition.writerFor(result.launchRef);
    const fixed = fixture.launchKernel.registry.snapshot();
    const own = fixture.launchKernel.registry.get(result.launchRef);
    const owner = fixture.launchKernel.registry.get(parent.result.launchRef);
    const contextKind = provider === 'codex' ? 'turn' : 'assistant_message';
    fixture.runners[0].options.onNative({ type: 'context_ended', provider, identity: owner.identity,
      context: { kind: contextKind, nativeContextId: `${provider}-context-idle-source-parent` } });
    const runner = fixture.runners[1];
    assert.equal(runner.options.isCurrent(), false);
    assert.equal(runner.options.isSourceCurrent(), true);
    runner.options.onNative({ type: 'context_ended', provider, identity: own.identity,
      context: { kind: contextKind, nativeContextId: `${provider}-context-idle-source-child` } });
    assert.equal(runner.stopCalls, 0);
    const attestations = fixture.runtimeCalls.attestActor;
    fixture.sendMainContext(runner, provider, 'idle-source-child', { contextId: 'fresh-idle-child-context' });
    assert.equal(fixture.runtimeCalls.attestActor, attestations + 1);
    assert.equal(runner.stopCalls, 0);
    assert.equal(fixture.composition.snapshot().launches[1].reason, 'current_proof_unavailable');
    assert.equal(fixture.composition.resolveProof(result.launchRef), null);
    assert.equal(fixture.composition.writerFor(result.launchRef), null);
    assert.equal(await fixture.composition.reconcileProof(result.launchRef), null);
    assert.equal(fixture.composition.checkCurrentProof(result.launchRef, oldProof).ok, false);
    assert.notEqual(fixture.composition.authorizeWriter(result.launchRef, oldWriter).status, 'accepted');
    const ownRows = fixture.runtimeKernel.registry.snapshot().actors.filter((row) => row.launchRef === result.launchRef);
    assert.ok(ownRows.every((row) => row.state === 'active'));
    assert.equal(ownRows.find((row) => row.contextId === 'fresh-idle-child-context').contextState, 'active');
    fixture.sendMainContext(fixture.runners[0], provider, 'idle-source-parent', { contextId: 'fresh-idle-owner-context' });
    assert.equal(fixture.composition.resolveProof(result.launchRef), null);
    const proof = await fixture.composition.reconcileProof(result.launchRef);
    assert.ok(proof);
    assert.notEqual(proof, oldProof);
    assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, true);
    assert.deepEqual(fixture.launchKernel.registry.snapshot(), fixed);
    assert.ok(fixture.registrationKernel.registry.snapshot().executions.every((row) => row.state === 'active'));
    assert.equal(fixture.actualRegistrationKernel.authority.end(own.executionBinding.periodId), true);
    assert.equal(runner.options.isSourceCurrent(), false);
    assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, false);
  });
}

for (const provider of PROVIDERS) {
test(`ID-F04-N11 ${provider}: source observation rejects synchronous reentry and a stop during the trusted snapshot callback`, { timeout: 1000 }, async () => {
  let reenter = false;
  let stopDuringRead = false;
  let nested;
  let stopping;
  let receipt;
  const fixture = createFixture({
    onRuntimeSnapshot() {
      if (reenter) nested = fixture.runners[0].options.isSourceCurrent();
      if (stopDuringRead) {
        stopDuringRead = false;
        stopping = fixture.composition.stop(receipt);
      }
    },
  });
  const started = await fixture.startStandalone(provider, 'source-reentry');
  receipt = started.receipt;
  const proof = fixture.composition.resolveProof(started.result.launchRef);
  const runner = fixture.runners[0];
  reenter = true;
  assert.equal(runner.options.isSourceCurrent(), false);
  assert.equal(nested, false);
  reenter = false;
  assert.equal(runner.options.isSourceCurrent(), true);
  assert.equal(fixture.composition.checkCurrentProof(started.result.launchRef, proof).ok, true);
  stopDuringRead = true;
  assert.equal(runner.options.isSourceCurrent(), false);
  assert.equal(fixture.composition.checkCurrentProof(started.result.launchRef, proof).ok, false);
  await stopping;
});

test(`ID-F04-N11 ${provider}: the final opaque source check rejects a raw disconnect after the snapshot was captured`, { timeout: 1000 }, async () => {
  let disconnectDuringRead = false;
  const fixture = createFixture({
    onRuntimeSnapshot() {
      if (disconnectDuringRead) {
        disconnectDuringRead = false;
        fixture.actualRuntimeKernel.authority.disconnect(fixture.openedConnections[0].connectionHandle);
      }
    },
  });
  const { result } = await fixture.startStandalone(provider, 'source-final-disconnect');
  const proof = fixture.composition.resolveProof(result.launchRef);
  disconnectDuringRead = true;
  assert.equal(fixture.runners[0].options.isSourceCurrent(), false);
  assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, false);
});

test(`ID-F04-N11 ${provider}: temporary source snapshot failure without a context event preserves proof and writer capabilities`, { timeout: 1000 }, async () => {
  let unavailable = false;
  const fixture = createFixture({ onRuntimeSnapshot() { if (unavailable) throw new Error('fixture-unavailable'); } });
  const { result } = await fixture.startStandalone(provider, 'source-unavailable');
  const proof = fixture.composition.resolveProof(result.launchRef);
  const writer = fixture.composition.writerFor(result.launchRef);
  const actorCount = fixture.runtimeCalls.attestActor;
  unavailable = true;
  const runner = fixture.runners[0];
  const identity = fixture.launchKernel.registry.get(result.launchRef).identity;
  runner.options.onNative({ type: 'identity', provider, identity });
  assert.equal(runner.options.isSourceCurrent(), false);
  assert.equal(runner.stopCalls, 0);
  assert.equal(fixture.runtimeCalls.attestActor, actorCount);
  assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, false);
  const calls = fixture.registrationCalls.authorizeWriter;
  assert.notEqual(fixture.composition.authorizeWriter(result.launchRef, writer).status, 'accepted');
  assert.equal(fixture.registrationCalls.authorizeWriter, calls);
  unavailable = false;
  assert.equal(fixture.composition.resolveProof(result.launchRef), proof);
  assert.equal(fixture.composition.authorizeWriter(result.launchRef, writer).status, 'accepted');
});

test(`ID-F04-N11 ${provider}: source capability checks reject nonliteral true, thenables, and throws without destroying cached proofs`, { timeout: 1000 }, async () => {
  let verdict;
  const fixture = createFixture({ connectionCheck(handle, actual) {
    if (verdict === 'throw') throw new Error('fixture-unavailable');
    return verdict === undefined ? actual(handle) : verdict;
  } });
  const { result } = await fixture.startStandalone(provider, 'source-verdict');
  const proof = fixture.composition.resolveProof(result.launchRef);
  const runner = fixture.runners[0];
  for (const invalid of [false, null, {}, Promise.resolve(true), 'throw']) {
    verdict = invalid;
    assert.equal(runner.options.isSourceCurrent(), false);
    assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, false);
    assert.equal(runner.stopCalls, 0);
  }
  verdict = undefined;
  assert.equal(runner.options.isSourceCurrent(), true);
  assert.equal(fixture.composition.resolveProof(result.launchRef), proof);
});
}


for (const provider of PROVIDERS) {
  for (const eventType of ['context_ended', 'context']) {
    test(`ID-F04-N12 ${provider} ${eventType}: a native event during source uncertainty fences old context authorization`, { timeout: 1000 }, async () => {
      let unavailable = false;
      const fixture = createFixture({ onRuntimeSnapshot() { if (unavailable) throw new Error('fixture-unavailable'); } });
      const { result } = await fixture.startStandalone(provider, 'terminal-during-gap');
      const proof = fixture.composition.resolveProof(result.launchRef);
      const writer = fixture.composition.writerFor(result.launchRef);
      const before = fixture.launchKernel.registry.get(result.launchRef);
      fixture.plans.push(async (runner) => fixture.sendMainContext(runner, provider, 'gap-descendant'));
      const childReceipt = fixture.admission(provider, 'gap-descendant', {
        origin: 'delegated', originReceipt: result.runReceipt,
      });
      const child = await fixture.composition.start(childReceipt, { inputText: 'gap-descendant' });
      const childProof = fixture.composition.resolveProof(child.launchRef);
      const childWriter = fixture.composition.writerFor(child.launchRef);
      const contextId = `${provider}-context-terminal-during-gap`;
      const kind = provider === 'codex' ? 'turn' : 'assistant_message';
      unavailable = true;
      const runner = fixture.runners[0];
      runner.options.onNative({ type: eventType, provider, identity: before.identity,
        context: { kind, nativeContextId: contextId, ...(eventType === 'context' ? { parentToolUseId: null } : {}) } });
      assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, false);
      unavailable = false;
      assert.equal(fixture.composition.resolveProof(result.launchRef), null);
      assert.notEqual(fixture.composition.authorizeWriter(result.launchRef, writer).status, 'accepted');
      assert.equal(await fixture.composition.reconcileProof(result.launchRef), null);
      assert.equal(fixture.composition.snapshot().launches[0].reason, 'native_observation_gap');
      assert.equal(fixture.composition.resolveProof(child.launchRef), null);
      assert.notEqual(fixture.composition.authorizeWriter(child.launchRef, childWriter).status, 'accepted');
      assert.equal(fixture.runtimeKernel.registry.checkCurrentProof(child.launchRef, childProof).ok, true);
      assert.equal(runner.stopCalls, 0);
      const raw = fixture.runtimeKernel.registry.snapshot().actors[0];
      assert.equal(raw.state, 'active');
      assert.equal(raw.contextState, 'active');
      assert.equal(fixture.runtimeKernel.registry.checkCurrentProof(result.launchRef, proof).ok, true);
      runner.options.onNative({ type: 'context', provider, identity: before.identity,
        context: { kind, nativeContextId: contextId, parentToolUseId: null } });
      assert.equal(fixture.composition.resolveProof(result.launchRef), null);
      fixture.sendMainContext(runner, provider, 'terminal-during-gap', { contextId: 'fresh-gap-context' });
      const fresh = fixture.composition.resolveProof(result.launchRef);
      assert.ok(fresh);
      assert.notEqual(fresh, proof);
      assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, false);
      const freshWriter = fixture.composition.writerFor(result.launchRef);
      assert.notEqual(freshWriter.token, writer.token);
      assert.equal(fixture.composition.authorizeWriter(result.launchRef, freshWriter).status, 'accepted');
      assert.equal(fixture.composition.resolveProof(child.launchRef), null);
      const freshChild = await fixture.composition.reconcileProof(child.launchRef);
      assert.ok(freshChild);
      assert.notEqual(freshChild, childProof);
      assert.equal(fixture.composition.checkCurrentProof(child.launchRef, childProof).ok, false);
      assert.notEqual(fixture.composition.authorizeWriter(child.launchRef, childWriter).status, 'accepted');
      assert.deepEqual(fixture.launchKernel.registry.get(result.launchRef), before);
      assert.equal(fixture.registrationKernel.registry.snapshot().executions[0].state, 'active');
    });
  }
}

for (const provider of PROVIDERS) {
  test(`ID-F04-N12 ${provider}: the real owned runner delivers a negative terminal while source metadata is unknown`, { timeout: 5000 }, async (t) => {
    let unavailable = false;
    const fixture = createOwnedCompositionFixture(t, provider, {
      onRuntimeSnapshot() { if (unavailable) throw new Error('fixture-unavailable'); },
    });
    const receipt = fixture.admission(provider, 'owned-source-gap');
    const result = await fixture.composition.start(receipt, { inputText: 'owned-source-gap' });
    t.after(async () => fixture.composition.stop(receipt));
    assert.equal(result.accepted, true);
    const proof = fixture.composition.resolveProof(result.launchRef);
    const writer = fixture.composition.writerFor(result.launchRef);
    const actorCount = fixture.runtimeCalls.attestActor;
    const before = fixture.launchKernel.registry.get(result.launchRef);
    unavailable = true;
    assert.equal(fixture.nativeHarness.runnerOptions.isSourceCurrent(), false);
    if (provider === 'claude') {
      fixture.nativeHarness.child.send({ type: 'result', uuid: '11111111-1111-4111-8111-111111111111', subtype: 'success', session_id: before.identity.nativeId });
    } else {
      fixture.nativeHarness.child.send({ method: 'turn/completed',
        params: { threadId: before.identity.nativeId, turn: { id: 'turn-integration' } } });
    }
    unavailable = false;
    assert.equal(fixture.composition.snapshot().launches[0].reason, 'native_observation_gap');
    assert.equal(fixture.nativeHarness.child.exited, false);
    assert.equal(fixture.composition.resolveProof(result.launchRef), null);
    assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, false);
    const calls = fixture.registrationCalls.authorizeWriter;
    assert.notEqual(fixture.composition.authorizeWriter(result.launchRef, writer).status, 'accepted');
    assert.equal(fixture.registrationCalls.authorizeWriter, calls);
    assert.equal(fixture.runtimeCalls.attestActor, actorCount);
    assert.equal(fixture.runtimeKernel.registry.checkCurrentProof(result.launchRef, proof).ok, true);
    assert.equal(fixture.runtimeKernel.registry.snapshot().actors[0].contextState, 'active');
    assert.equal(fixture.registrationKernel.registry.snapshot().executions[0].state, 'active');
    assert.deepEqual(fixture.launchKernel.registry.get(result.launchRef), before);
  });
}

for (const provider of PROVIDERS) {
  for (const invalidation of ['own', 'owner', 'ancestor', 'period', 'source']) {
    test(`ID-F04-N13 ${provider} ${invalidation}: context callback rejects raw authority invalidation before a native terminal`, async () => {
      const fixture = createFixture();
      const root = await fixture.startStandalone(provider, 'context-gate-root');
      const launches = [root.result];
      for (const suffix of ['owner', 'leaf']) {
        fixture.plans.push(async (runner) => fixture.sendMainContext(runner, provider, `context-gate-${suffix}`));
        const receipt = fixture.admission(provider, `context-gate-${suffix}`, {
          origin: 'delegated', originReceipt: launches.at(-1).runReceipt,
        });
        launches.push(await fixture.composition.start(receipt, { inputText: suffix }));
      }
      const gate = fixture.runners.at(-1).options.isContextCurrent;
      assert.equal(gate.length, 0);
      assert.equal(gate(), true);
      const leaf = launches.at(-1);
      const rawLeafProof = fixture.composition.resolveProof(leaf.launchRef);
      if (['own', 'owner', 'ancestor'].includes(invalidation)) {
        const index = { own: 2, owner: 1, ancestor: 0 }[invalidation];
        assert.equal(fixture.actualRuntimeKernel.authority.endContext(fixture.attestedActors.get(launches[index].launchRef).at(-1)), true);
      } else if (invalidation === 'period') {
        fixture.actualRegistrationKernel.authority.end(fixture.launchKernel.registry.get(leaf.launchRef).executionBinding.periodId);
      } else {
        fixture.actualRuntimeKernel.authority.disconnect(fixture.openedConnections.at(-1).connectionHandle);
      }
      assert.equal(gate(), false);
      assert.equal(fixture.composition.checkCurrentProof(leaf.launchRef, {}).ok, false);
      assert.equal(gate(), false);
      if (invalidation === 'ancestor') assert.equal(fixture.actualRuntimeKernel.registry.checkCurrentProof(leaf.launchRef, rawLeafProof).ok, true);
      assert.equal(fixture.runners.at(-1).stopCalls, 0);
    });
  }
}

test('ID-F04-N13 context callback rejects synchronous reentry without restoring a rejected nested check', async () => {
  let duringSnapshot;
  const fixture = createFixture({ onRuntimeSnapshot() { duringSnapshot?.(); } });
  await fixture.startStandalone('codex', 'context-gate-reentry');
  const gate = fixture.runners[0].options.isContextCurrent;
  let nested;
  duringSnapshot = () => { duringSnapshot = null; nested = gate(); };
  assert.equal(gate(), false);
  assert.equal(nested, false);
  assert.equal(gate(), true);
});

for (const invalidation of ['none', 'own', 'owner', 'ancestor', 'period', 'source', 'before-own', 'before-owner', 'before-ancestor']) {
  test(`ID-F04-N13 Codex native wait ${invalidation}: reply requires the current full context proof chain`, { timeout: 5000 }, async (t) => {
    const workspace = createOwnedWorkspace(t);
    let waitReceipt;
    const owned = createOwnedRunnerFactory(workspace, 'codex', {
      waitProfile: true, onWaitRequired(receipt) { waitReceipt = receipt; },
    });
    let nativeLeaf = false;
    const fixture = createFixture({
      runnerFactory(options, createStub) { return nativeLeaf ? owned.runnerFactory(options) : createStub(options); },
      onAuthenticationRequired: owned.onAuthenticationRequired,
      profileOverrides: { codex: { executablePath: workspace.executablePath, homePath: workspace.homePath, cwd: workspace.cwd } },
    });
    const root = await fixture.startStandalone('codex', 'native-wait-root');
    fixture.plans.push(async (runner) => fixture.sendMainContext(runner, 'codex', 'native-wait-owner'));
    const ownerReceipt = fixture.admission('codex', 'native-wait-owner', { origin: 'delegated', originReceipt: root.result.runReceipt });
    const owner = await fixture.composition.start(ownerReceipt, { inputText: 'owner' });
    nativeLeaf = true;
    const receipt = fixture.admission('codex', 'native-wait-leaf', { origin: 'delegated', originReceipt: owner.runReceipt });
    const leaf = await fixture.composition.start(receipt, { inputText: 'leaf' });
    t.after(async () => fixture.composition.stop(receipt));
    assert.equal(leaf.accepted, true);
    const sendWait = () => owned.harness.child.send({ id: 'wait-proof-gate', method: 'item/tool/call', params: {
      threadId: 'thread-integration', turnId: 'turn-integration', callId: 'proof-gate-call',
      namespace: null, tool: 'cockpit_wait', arguments: {},
    } });
    const beforeCallback = invalidation.startsWith('before-');
    if (!beforeCallback) { sendWait(); assert.ok(waitReceipt); }
    const targetKind = beforeCallback ? invalidation.slice('before-'.length) : invalidation;
    if (['own', 'owner', 'ancestor'].includes(targetKind)) {
      const target = { own: leaf, owner, ancestor: root.result }[targetKind];
      fixture.actualRuntimeKernel.authority.endContext(fixture.attestedActors.get(target.launchRef).at(-1));
    } else if (invalidation === 'period') {
      fixture.actualRegistrationKernel.authority.end(fixture.launchKernel.registry.get(leaf.launchRef).executionBinding.periodId);
    } else if (invalidation === 'source') {
      fixture.actualRuntimeKernel.authority.disconnect(fixture.openedConnections.at(-1).connectionHandle);
    }
    if (beforeCallback) {
      sendWait();
      assert.equal(waitReceipt, undefined);
    } else {
      owned.harness.runner.releaseWait(waitReceipt);
    }
    assert.equal(owned.harness.responses.length, invalidation === 'none' ? 1 : 0);
    assert.equal(owned.harness.child.exited, false);
  });
}

for (const provider of PROVIDERS) {
  for (const invalidation of ['connection', 'context', 'period', 'actor', 'launch', 'latest-proof', 'handoff']) {
    test(`ID-F04-N14 ${provider} ${invalidation}: final ancestor snapshot must reject a raw-invalidated leaf`, async () => {
      let action;
      let snapshots = 0;
      const fixture = createFixture({ onRuntimeSnapshot() {
        if (action && ++snapshots === 4) { const current = action; action = null; current(); }
      } });
      const root = await fixture.startStandalone(provider, 'late-leaf-root');
      fixture.plans.push(async (runner) => fixture.sendMainContext(runner, provider, 'late-leaf'));
      const receipt = fixture.admission(provider, 'late-leaf', { origin: 'delegated', originReceipt: root.result.runReceipt });
      const leaf = await fixture.composition.start(receipt, { inputText: 'leaf' });
      const proof = fixture.composition.resolveProof(leaf.launchRef);
      const runtimeBefore = fixture.runtimeKernel.registry.get(leaf.launchRef);
      const immutable = Object.fromEntries(['launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'origin', 'purpose', 'originBinding', 'identity', 'executionBinding'].map((key) => [key, runtimeBefore[key]]));
      action = () => {
        if (invalidation === 'connection') fixture.actualRuntimeKernel.authority.disconnect(fixture.openedConnections.at(-1).connectionHandle);
        else if (invalidation === 'context') fixture.actualRuntimeKernel.authority.endContext(fixture.attestedActors.get(leaf.launchRef).at(-1));
        else if (invalidation === 'period') fixture.actualRegistrationKernel.authority.end(fixture.launchKernel.registry.get(leaf.launchRef).executionBinding.periodId);
        else if (invalidation === 'actor') fixture.actualRuntimeKernel.authority.endActor(fixture.attestedActors.get(leaf.launchRef).at(-1));
        else if (invalidation === 'launch') fixture.launchKernel.authority.endLaunch(leaf.launchRef);
        else if (invalidation === 'latest-proof') fixture.actualRuntimeKernel.authority.reconcileExecution(leaf.launchRef, {
          executionActorHandle: fixture.attestedActors.get(leaf.launchRef).at(-1), ownerActorHandle: fixture.attestedActors.get(root.result.launchRef).at(-1), expectedOwnerGeneration: 0,
        });
        else fixture.actualRuntimeKernel.authority.handoff(leaf.launchRef, { handoffId: 'late-handoff', expectedOwner: runtimeBefore.currentOwner, expectedOwnerGeneration: 0,
          newOwner: runtimeBefore.executionBinding, newOwnerGeneration: 1, immutableExecutionClaims: immutable, evidence: fixture.nextEvidence('late-handoff'),
        }, fixture.attestedActors.get(leaf.launchRef).at(-1));
      };
      assert.equal(fixture.composition.checkCurrentProof(leaf.launchRef, proof).ok, false);
      assert.equal(snapshots, 4);
      assert.equal(action, null);
      assert.equal(fixture.actualRuntimeKernel.registry.checkCurrentProof(leaf.launchRef, proof).ok, false);
    });
  }
}

for (const provider of PROVIDERS) {
  test(`ID-F04-N14 ${provider}: revision denial fails closed without destroying cached proof or writer`, async () => {
    let verdict;
    const fixture = createFixture({ revisionCheck(stamp, actual) { if (verdict === 'throw') throw new Error('unavailable'); return verdict === undefined ? actual(stamp) : verdict; } });
    const { result } = await fixture.startStandalone(provider, 'revision-denial');
    const proof = fixture.composition.resolveProof(result.launchRef);
    const writer = fixture.composition.writerFor(result.launchRef);
    for (const invalid of [false, null, {}, Promise.resolve(true), 'throw']) {
      verdict = invalid;
      assert.equal(fixture.composition.resolveProof(result.launchRef), null);
      assert.equal(fixture.composition.checkCurrentProof(result.launchRef, proof).ok, false);
      assert.equal(fixture.runners[0].stopCalls, 0);
    }
    verdict = undefined;
    assert.equal(fixture.composition.resolveProof(result.launchRef), proof);
    assert.equal(fixture.composition.writerFor(result.launchRef).token, writer.token);
  });
}

for (const provider of PROVIDERS) {
  for (const stage of ['admission', 'start-auth']) {
    test(`ID-F04-N14 ${provider} ${stage}: a last-ancestor callback cannot admit an invalidated owner`, async () => {
      let action;
      let snapshots = 0;
      let authCalls = 0;
      const fixture = createFixture({ onAuthenticationRequired() { authCalls += 1; }, onRuntimeSnapshot() {
        if (action && ++snapshots === 4) { const current = action; action = null; current(); }
      } });
      const parent = await fixture.startStandalone(provider, 'admission-ancestor');
      fixture.plans.push(async (runner) => fixture.sendMainContext(runner, provider, 'admission-owner'));
      const ownerReceipt = fixture.admission(provider, 'admission-owner', { origin: 'delegated', originReceipt: parent.result.runReceipt });
      const owner = await fixture.composition.start(ownerReceipt, { inputText: 'owner' });
      const makeAdmission = () => fixture.admission(provider, 'admission-child', { origin: 'delegated', originReceipt: owner.runReceipt });
      const childReceipt = stage === 'start-auth' ? makeAdmission() : null;
      const registered = fixture.registrationCalls.register;
      const attested = fixture.runtimeCalls.attestActor;
      action = () => fixture.actualRuntimeKernel.authority.disconnect(fixture.openedConnections.at(-1).connectionHandle);
      if (stage === 'admission') assertCode(makeAdmission, 'origin_receipt_unavailable');
      else await assert.rejects(fixture.composition.start(childReceipt, { inputText: 'child' }), { code: 'origin_receipt_unavailable' });
      assert.equal(snapshots, 4);
      assert.equal(fixture.runners.length, 2);
      assert.equal(authCalls, 0);
      assert.equal(fixture.registrationCalls.register, registered);
      assert.equal(fixture.runtimeCalls.attestActor, attested);
    });
  }
}

test('native target projection becomes unverified after owner handoff', async (t) => {
  const executionWorkspace = createOwnedWorkspace(t);
  const ownerWorkspace = createOwnedWorkspace(t);
  const processes = [];
  const fixture = createFixture({
    profileOverrides: {
      codex: {
        executablePath: executionWorkspace.executablePath,
        homePath: executionWorkspace.homePath,
        cwd: executionWorkspace.cwd,
      },
      'codex-alt': {
        executablePath: ownerWorkspace.executablePath,
        homePath: ownerWorkspace.homePath,
        cwd: ownerWorkspace.cwd,
      },
    },
    getAuthentication: () => ({ oauthToken: 'fixture-oauth-token' }),
    onAuthenticationRequired: ({ loginId }) => {
      const processHarness = processes.at(-1);
      if (!processHarness?.completeLogin(loginId)) throw new Error('fixture_login_unavailable');
    },
    runnerFactory(runnerOptions) {
      const processHarness = createFakeNativeProcess(runnerOptions.provider, runnerOptions.homePath, {
        nativeIdSuffix: processes.length + 1,
      });
      processes.push(processHarness);
      return createOwnedNativeRunner({
        ...runnerOptions,
        spawnImpl: processHarness.spawnImpl,
        timeouts: { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 250 },
      });
    },
  });
  let executionReceipt;
  let ownerReceipt;
  let executionCollector;
  let ownerCollector;
  const router = createNativeInstructionOwnerRouter({ provider: 'codex', composition: fixture.composition });
  t.after(async () => {
    router.close();
    await executionCollector?.disconnect().catch(() => {});
    await ownerCollector?.disconnect().catch(() => {});
    if (ownerReceipt) await fixture.composition.stop(ownerReceipt).catch(() => {});
    if (executionReceipt) await fixture.composition.stop(executionReceipt).catch(() => {});
  });

  async function startObserved(profileId, suffix, inputText) {
    const receipt = fixture.admission('codex', suffix, { profileId });
    router.attachAdmission(receipt);
    const collector = fixture.composition.createOwnedCollector(receipt);
    const connected = Promise.resolve(collector.connect());
    const starting = fixture.composition.start(receipt, { inputText });
    const [result] = await Promise.all([starting, connected]);
    const processHarness = processes.at(-1);
    assert.equal((await collector.observeKnownThread(processHarness.state.threadId)).status, 'observed');
    return { receipt, result, collector };
  }

  const execution = await startObserved('codex', 'projection-handoff-execution', 'execution prompt');
  executionReceipt = execution.receipt;
  executionCollector = execution.collector;
  const owner = await startObserved('codex-alt', 'projection-handoff-owner', 'owner prompt');
  ownerReceipt = owner.receipt;
  ownerCollector = owner.collector;

  assert.equal(fixture.composition.instructionTargetState(execution.result.launchRef).status, 'working');
  processes[0].state.child.send({ jsonrpc: '2.0', id: 'private-handoff-pending-request',
    method: 'item/tool/requestUserInput', params: { threadId: processes[0].state.threadId,
      turnId: processes[0].state.turnId, itemId: 'private-handoff-pending-item', isBlocking: true,
      questions: [{ header: 'private header', id: 'private question', question: 'private body' }] } });
  assert.deepEqual(fixture.composition.instructionTargetState(execution.result.launchRef), {
    status: 'waiting', nativeTurnId: processes[0].state.turnId, reason: 'native_request_pending',
    nativeWaiting: [{ kind: 'question', count: 1 }],
  });
  fixture.composition.handoff(
    execution.result.runReceipt,
    execution.result.runReceipt,
    owner.result.runReceipt,
    { handoffId: 'projection-handoff', expectedOwnerGeneration: 0 },
  );
  assert.deepEqual(fixture.composition.instructionTargetState(execution.result.launchRef), {
    status: 'unverified', nativeTurnId: null, reason: 'instruction_target_unverified',
  });
  assert.equal(processes[0].state.instructionWrites.length, 0);
});
