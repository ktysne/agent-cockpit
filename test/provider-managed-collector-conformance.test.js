'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createRegistrationKernel } = require('../src/server/conversation-registry');
const { createProviderRegistrationAdapter } = require('../src/server/provider-registration');
const { createLaunchBindingKernel, createProviderLaunchAdapter } = require('../src/server/launch-binding');
const { createRuntimeBindingKernel, createProviderRuntimeAdapter } = require('../src/server/runtime-binding');
const { createProviderEventProjection, createProviderEventAdapter } = require('../src/server/provider-event-projection');
const { createManagedCollector } = require('../src/server/managed-collector');

const PROVIDERS = ['claude', 'codex'];
const NATIVE_ID_KINDS = { claude: 'session', codex: 'thread' };
const EXPECTED_HOME = path.resolve(os.tmpdir(), 'managed-collector-conformance-home');

function evidence(evidenceId, extra = {}) {
  return {
    evidenceId,
    source: 'managed-collector-fixture',
    method: 'authenticated-fixture',
    adapterVersion: 'fixture-1',
    runtimeVersion: 'fixture-1',
    capabilities: ['native-binding'],
    ...extra,
  };
}

function nativeIdentity(provider, suffix) {
  return {
    nativeIdKind: NATIVE_ID_KINDS[provider],
    hostId: 'host-' + suffix,
    homeScopeId: 'home-' + suffix,
    nativeId: provider + '-native-' + suffix,
  };
}

function fullIdentity(provider, suffix) {
  return { provider, ...nativeIdentity(provider, suffix) };
}

function actor(kind, id) {
  return { kind, id };
}

function periodBinding(periodId, actorValue) {
  return { periodId, actor: structuredClone(actorValue) };
}

function immutableClaims(record) {
  return {
    launchId: record.launchId,
    runId: record.runId,
    attemptId: record.attemptId,
    provider: record.provider,
    nativeIdKind: record.nativeIdKind,
    hostId: record.hostId,
    homeScopeId: record.homeScopeId,
    origin: record.origin,
    purpose: record.purpose,
    originBinding: structuredClone(record.originBinding),
    identity: structuredClone(record.identity),
    executionBinding: structuredClone(record.executionBinding),
  };
}

function createProductionProofFixture(provider) {
  const registrationKernel = createRegistrationKernel();
  const authorityEndCalls = [];
  const authority = Object.freeze({
    ...registrationKernel.authority,
    end(executionId) {
      authorityEndCalls.push(executionId);
      return registrationKernel.authority.end(executionId);
    },
  });
  const registrationAdapters = Object.fromEntries(PROVIDERS.map((item) => [
    item,
    createProviderRegistrationAdapter(item, registrationKernel.registry, authority),
  ]));
  let evidenceSerial = 0;
  const nextEvidence = (label, extra = {}) => evidence(`${provider}-${label}-${++evidenceSerial}`, extra);

  function registerPeriod(periodProvider, suffix, role, identityOverride = null) {
    const identity = identityOverride || fullIdentity(periodProvider, suffix);
    const native = {
      nativeIdKind: identity.nativeIdKind,
      hostId: identity.hostId,
      homeScopeId: identity.homeScopeId,
      nativeId: identity.nativeId,
    };
    const registration = registrationAdapters[periodProvider].register(native, nextEvidence('period-' + suffix), {
      startId: 'start-' + suffix,
      ...(periodProvider === 'claude' && !identityOverride ? { projectionId: identity.nativeId } : {}),
      ...(identityOverride ? { resume: true } : {}),
    });
    const actorValue = actor(role === 'execution' ? 'agent' : 'tool-use', role + '-' + suffix);
    const contextId = 'context-' + suffix;
    const writer = registrationAdapters[periodProvider].bindWriter(registration.executionId, {
      identity,
      contextId,
      evidence: nextEvidence('writer-' + suffix),
    });
    return { identity, nativeIdentity: native, registration, actor: actorValue, contextId, writer };
  }

  const ownerProvider = provider === 'claude' ? 'codex' : 'claude';
  const owner = registerPeriod(ownerProvider, provider + '-owner', 'owner');
  const execution = registerPeriod(provider, provider + '-execution', 'execution');
  const launchKernel = createLaunchBindingKernel({ registrationRegistry: registrationKernel.registry });
  const launchAdapters = Object.fromEntries(PROVIDERS.map((item) => [
    item,
    createProviderLaunchAdapter(item, launchKernel.registry, launchKernel.authority),
  ]));
  const runtimeKernel = createRuntimeBindingKernel({
    registrationRegistry: registrationKernel.registry,
    launchRegistry: launchKernel.registry,
  });
  const runtimeAdapters = Object.fromEntries(PROVIDERS.map((item) => [
    item,
    createProviderRuntimeAdapter(item, runtimeKernel.registry, runtimeKernel.authority),
  ]));
  const ownerAdapter = runtimeAdapters[ownerProvider];
  const ownerScope = {
    provider: owner.identity.provider,
    nativeIdKind: owner.identity.nativeIdKind,
    hostId: owner.identity.hostId,
    homeScopeId: owner.identity.homeScopeId,
    connectionSlotId: `owner-${provider}-fixture-slot`,
  };
  const ownerConnection = ownerAdapter.openConnection(
    ownerScope,
    `owner-connection-${provider}`,
    nextEvidence('owner-connection'),
  );
  const ownerActorHandle = ownerAdapter.attestActor(ownerConnection.connectionHandle, {
    identity: structuredClone(owner.identity),
    periodId: owner.registration.executionId,
    actor: structuredClone(owner.actor),
    contextId: owner.contextId,
    launchRef: null,
    immutableExecutionClaims: null,
  }, nextEvidence('owner-actor')).actorHandle;
  const launchesByRef = new Map();

  function addExecutionLaunch(period, suffix) {
    const registered = launchAdapters[provider].registerLaunch({
      launchId: 'launch-' + suffix,
      runId: 'run-' + suffix,
      attemptId: 'attempt-' + suffix,
      provider,
      nativeIdKind: period.identity.nativeIdKind,
      hostId: period.identity.hostId,
      homeScopeId: period.identity.homeScopeId,
      origin: 'delegated',
      purpose: 'agent',
      originBinding: periodBinding(owner.registration.executionId, owner.actor),
    }, nextEvidence('launch-' + suffix));
    launchAdapters[provider].bindExecution(registered.launchRef, {
      identity: structuredClone(period.identity),
      executionBinding: periodBinding(period.registration.executionId, period.actor),
      evidence: nextEvidence('execution-binding-' + suffix, { registrationRef: registered.launchRef }),
    });
    const claims = immutableClaims(launchKernel.registry.get(registered.launchRef));
    runtimeAdapters[provider].adoptExecution(registered.launchRef, structuredClone(claims));
    const launch = { launchRef: registered.launchRef, claims, period };
    launchesByRef.set(registered.launchRef, launch);
    return launch;
  }

  const initialLaunch = addExecutionLaunch(execution, provider + '-execution');
  let resolverCalls = 0;
  const trustedBindingResolver = {
    async resolveProof(launchRef, context) {
      const launch = launchesByRef.get(launchRef);
      if (!launch || context.connectionHandle == null || context.executionId !== launch.period.registration.executionId ||
          context.sessionId !== launch.period.registration.sessionId || context.identity.nativeId !== launch.period.identity.nativeId) {
        return null;
      }
      resolverCalls += 1;
      const executionActorHandle = runtimeAdapters[provider].attestActor(context.connectionHandle, {
        identity: structuredClone(launch.period.identity),
        periodId: launch.period.registration.executionId,
        actor: structuredClone(launch.period.actor),
        contextId: `${launch.period.contextId}-proof-${resolverCalls}`,
        launchRef,
        immutableExecutionClaims: structuredClone(launch.claims),
      }, nextEvidence('execution-actor-' + resolverCalls)).actorHandle;
      const current = runtimeAdapters[provider].get(launchRef);
      return runtimeAdapters[provider].reconcileExecution(launchRef, {
        executionActorHandle,
        ownerActorHandle,
        expectedOwnerGeneration: current.ownerGeneration,
      }).proofHandle;
    },
    resolveEventWriter(launchRef, context) {
      const launch = launchesByRef.get(launchRef);
      if (!launch || context.executionId !== launch.period.registration.executionId ||
          context.sessionId !== launch.period.registration.sessionId || context.identity.nativeId !== launch.period.identity.nativeId) {
        return null;
      }
      return launch.period.writer;
    },
  };

  return {
    provider,
    registrationKernel,
    authority,
    authorityEndCalls,
    owner,
    ownerActorHandle,
    ownerRuntimeAdapter: ownerAdapter,
    execution,
    initialLaunch,
    launchesByRef,
    addExecutionLaunch: (suffix, identityOverride) => {
      const identity = identityOverride || structuredClone(execution.identity);
      const resumed = registerPeriod(provider, suffix, 'execution', identity);
      return { period: resumed, launch: addExecutionLaunch(resumed, suffix) };
    },
    runtimeKernel,
    runtimeAdapter: runtimeAdapters[provider],
    runtimeAdapters,
    trustedBindingResolver,
    get resolverCalls() { return resolverCalls; },
    scope: {
      provider,
      nativeIdKind: execution.identity.nativeIdKind,
      hostId: execution.identity.hostId,
      homeScopeId: execution.identity.homeScopeId,
      connectionSlotId: `collector-${provider}-fixture-slot`,
    },
  };
}

function createTransportFixture(provider, options = {}) {
  const calls = [];
  const connections = [];
  const loadedIds = new Set(options.loadedIds || []);
  const readWaiters = [];
  let readMode = options.readMode || 'active';
  let deferThreadRead = Boolean(options.deferThreadRead);

  async function transportFactory(callbacks) {
    const connection = { callbacks, closed: false };
    const transport = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'initialize') {
          return {
            codexHome: EXPECTED_HOME,
            platformFamily: 'windows',
            platformOs: 'windows',
            userAgent: 'codex/1.2.3',
          };
        }
        if (method === 'thread/read') {
          if (deferThreadRead) {
            return new Promise((resolve) => readWaiters.push(resolve));
          }
          if (readMode === 'failed') throw new Error('fixture read failure');
          const id = readMode === 'identity-mismatch' ? `${params.threadId}-different` : params.threadId;
          return options.threadReadReply
            ? options.threadReadReply(params)
            : { thread: { id, status: { type: 'active' } } };
        }
        return {};
      },
      async notify(method, params) { calls.push({ method, params }); },
      async confirmLoadedThread(nativeId) {
        calls.push({ method: 'confirmLoadedThread', nativeId });
        return loadedIds.has(nativeId);
      },
      async resumeLoadedThread(nativeId) { calls.push({ method: 'resumeLoadedThread', nativeId }); },
      async close() { connection.closed = true; calls.push({ method: 'close' }); },
      snapshot() { return { provider }; },
    };
    connection.transport = transport;
    connections.push(connection);
    return transport;
  }

  function releaseRead(nativeId, type = 'active', index = 0) {
    const [resolve] = readWaiters.splice(index, 1);
    assert.ok(resolve, 'a thread read should be waiting');
    resolve({ thread: { id: nativeId, status: { type } } });
  }

  return {
    calls,
    connections,
    loadedIds,
    readWaiters,
    releaseRead,
    setReadMode(mode) { readMode = mode; },
    setReadDeferred(value) { deferThreadRead = Boolean(value); },
    transportFactory,
  };
}

function createCollectorFixture(proofFixture, transport, options = {}) {
  const projection = createProviderEventProjection({ registry: proofFixture.registrationKernel.registry });
  const productionEventAdapter = createProviderEventAdapter(proofFixture.provider, projection);
  const projected = [];
  const eventAdapter = {
    provider: proofFixture.provider,
    project(input) {
      const result = productionEventAdapter.project(input);
      projected.push({ input, result });
      return result;
    },
  };
  const collector = createManagedCollector({
    provider: proofFixture.provider,
    scope: proofFixture.scope,
    expectedHome: EXPECTED_HOME,
    transportFactory: transport.transportFactory,
    runtimeAdapter: proofFixture.runtimeAdapter,
    registrationRegistry: proofFixture.registrationKernel.registry,
    runtimeRegistry: proofFixture.runtimeKernel.registry,
    eventAdapter,
    trustedBindingResolver: options.trustedBindingResolver || proofFixture.trustedBindingResolver,
    onObservation: options.onObservation,
  });
  return { collector, eventAdapter, projection, projected, productionEventAdapter };
}

function observationFor(collector, nativeId) {
  return collector.snapshot().observations.find((item) => item.nativeId === nativeId);
}

async function waitForReadWaiters(transport, count) {
  for (let attempt = 0; attempt < 10 && transport.readWaiters.length < count; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(transport.readWaiters.length, count);
}

function sendKnownStart(provider, callbacks, nativeId) {
  if (provider === 'codex') {
    callbacks.onNotification('turn/started', { threadId: nativeId, turnId: 'turn-a' });
  } else {
    callbacks.onNotification('claude/hook', {
      session_id: nativeId,
      hook_event_name: 'UserPromptSubmit',
      hook_at: 100,
    });
  }
}

async function acquireCollectorProof(provider, proofFixture, collector, transport) {
  const nativeId = proofFixture.execution.identity.nativeId;
  if (provider === 'codex') {
    transport.loadedIds.add(nativeId);
    const result = await collector.observeKnownThread(nativeId);
    assert.equal(result.status, 'observed');
    assert.equal(result.observation.activity, 'active');
  } else {
    assert.equal((await collector.observeKnownThread(nativeId)).status, 'unsupported');
    assert.equal(await collector.reconcileProof(proofFixture.initialLaunch.launchRef), true);
    sendKnownStart(provider, transport.connections.at(-1).callbacks, nativeId);
  }
}

for (const provider of PROVIDERS) {
  test(`${provider} uses current trusted binding for bounded observations and server-request state`, async () => {
    const proofFixture = createProductionProofFixture(provider);
    const before = proofFixture.registrationKernel.registry.snapshot();
    const nativeId = proofFixture.execution.identity.nativeId;
    const transport = createTransportFixture(provider);
    const harness = createCollectorFixture(proofFixture, transport);

    assert.equal(harness.collector.resolveProof(proofFixture.initialLaunch.launchRef), null);
    assert.deepEqual(await harness.collector.connect(), { status: 'connected', generation: 1 });
    await acquireCollectorProof(provider, proofFixture, harness.collector, transport);
    const proofHandle = harness.collector.resolveProof(proofFixture.initialLaunch.launchRef);
    assert.ok(proofHandle && (typeof proofHandle === 'object' || typeof proofHandle === 'function'));
    assert.equal(proofFixture.runtimeAdapter.checkCurrentProof(proofFixture.initialLaunch.launchRef, proofHandle).ok, true);

    const callbacks = transport.connections[0].callbacks;
    if (provider === 'codex') {
      callbacks.onNotification('turn/started', {
        threadId: nativeId,
        turnId: 'turn-a',
        token: 'native-token-marker',
        rawMessage: 'native-raw-message-marker',
      });
      const requestParams = { threadId: nativeId };
      callbacks.onServerRequest({ id: 42, method: 'serverRequest/requestApproval', params: requestParams });
      callbacks.onServerRequest({ id: 42, method: 'serverRequest/requestApproval', params: requestParams });
      assert.deepEqual(observationFor(harness.collector, nativeId).pendingRequests, [
        { requestId: 'number:42', state: 'pending' },
      ]);
      callbacks.onNotification('serverRequest/resolved', { requestId: 42 });
      assert.deepEqual(observationFor(harness.collector, nativeId).pendingRequests, [
        { requestId: 'number:42', state: 'resolved' },
      ]);
    } else {
      callbacks.onNotification('claude/hook', {
        session_id: nativeId,
        hook_event_name: 'UserPromptSubmit',
        hook_at: 150,
        token: 'native-token-marker',
        prompt: 'native-raw-message-marker',
      });
      callbacks.onNotification('claude/hook', {
        session_id: nativeId,
        hook_event_name: 'PermissionRequest',
        hook_at: 160,
        tool_name: 'Bash',
        command: 'must not be sent as an instruction',
      });
      assert.equal(observationFor(harness.collector, nativeId).status, 'unknown');
      assert.equal(typeof observationFor(harness.collector, nativeId).reason, 'string');
      assert.ok(harness.collector.resolveProof(proofFixture.initialLaunch.launchRef));
    }

    assert.deepEqual(harness.collector.snapshot().capabilities, provider === 'codex'
      ? { loadedList: 'supported', threadRead: 'supported', resume: 'supported', serverRequests: 'supported' }
      : { loadedList: 'unsupported', threadRead: 'unsupported', resume: 'unsupported', serverRequests: 'unsupported' });
    assert.equal(proofFixture.registrationKernel.registry.snapshot().executions.length, before.executions.length);
    assert.equal(proofFixture.resolverCalls > 0, true);
    assert.equal(transport.calls.some((call) => /(?:reply|send|command|settings\/|thread\/list)/i.test(call.method)), false);

    const publicSnapshot = harness.collector.snapshot();
    assert.deepEqual(Object.keys(publicSnapshot), [
      'version', 'provider', 'scope', 'connection', 'capabilities', 'observations',
    ]);
    assert.equal(JSON.stringify(publicSnapshot).includes('native-token-marker'), false);
    assert.equal(JSON.stringify(publicSnapshot).includes('native-raw-message-marker'), false);
    assert.equal(JSON.stringify(publicSnapshot).includes('proofHandle'), false);
    assert.equal(JSON.stringify(publicSnapshot).includes('verifiedLaunchRef'), false);
    publicSnapshot.scope.hostId = 'changed-copy';
    publicSnapshot.observations[0].nativeId = 'changed-copy';
    const reread = harness.collector.snapshot();
    assert.equal(reread.scope.hostId, proofFixture.execution.identity.hostId);
    assert.equal(reread.observations[0].nativeId, nativeId);
  });
}

for (const provider of PROVIDERS) {
  test(`${provider} sends only an unsupported native marker through the trusted event writer`, async () => {
    const proofFixture = createProductionProofFixture(provider);
    const nativeId = proofFixture.execution.identity.nativeId;
    const transport = createTransportFixture(provider, { loadedIds: [nativeId] });
    const harness = createCollectorFixture(proofFixture, transport);
    await harness.collector.connect();
    await acquireCollectorProof(provider, proofFixture, harness.collector, transport);
    harness.projected.length = 0;
    const callbacks = transport.connections[0].callbacks;

    if (provider === 'codex') {
      callbacks.onNotification('item/started', {
        threadId: nativeId,
        item: { id: 'native-item', type: 'agentMessage', text: 'private native text' },
      });
    } else {
      callbacks.onNotification('claude/hook', {
        session_id: nativeId,
        hook_event_name: 'SubagentStart',
        agent_id: 'unverified-child-agent',
        hook_at: 200,
        prompt: 'private native prompt',
      });
    }
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(harness.projected.length, 1);
    assert.deepEqual(harness.projected[0].input.event, { hook_event_name: 'ManagedNativeObservation' });
    assert.equal(harness.projected[0].result.action, 'unknown');
    assert.equal(harness.projected[0].result.reason, 'unsupported_event');
    const after = harness.projection.snapshot();
    assert.equal(after.length, 1);
    assert.deepEqual(after[0].lastKnownState, {
      period: 'active',
      observedPeriod: 'active',
      rootTurn: 'unknown',
      observedRootTurn: 'unknown',
      actors: [],
    });
    assert.equal(JSON.stringify(harness.collector.snapshot()).includes('private native'), false);

    const noWriterResolver = {
      resolveProof: proofFixture.trustedBindingResolver.resolveProof.bind(proofFixture.trustedBindingResolver),
    };
    const noWriterTransport = createTransportFixture(provider, { loadedIds: [nativeId] });
    const noWriterHarness = createCollectorFixture(proofFixture, noWriterTransport, {
      trustedBindingResolver: noWriterResolver,
    });
    await noWriterHarness.collector.connect();
    await acquireCollectorProof(provider, proofFixture, noWriterHarness.collector, noWriterTransport);
    noWriterHarness.projected.length = 0;
    if (provider === 'codex') {
      noWriterTransport.connections[0].callbacks.onNotification('item/started', { threadId: nativeId });
    } else {
      noWriterTransport.connections[0].callbacks.onNotification('claude/hook', {
        session_id: nativeId, hook_event_name: 'SubagentStart', agent_id: 'unverified-child-agent', hook_at: 300,
      });
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(noWriterHarness.projected.length, 0);
  });
}

test('Claude Stop, Interrupt, and SessionEnd stay distinct, and a new period is not tombstoned', async () => {
  const proofFixture = createProductionProofFixture('claude');
  const nativeId = proofFixture.execution.identity.nativeId;
  const transport = createTransportFixture('claude');
  const harness = createCollectorFixture(proofFixture, transport);
  await harness.collector.connect();
  await acquireCollectorProof('claude', proofFixture, harness.collector, transport);
  const callbacks = transport.connections[0].callbacks;
  const sendHook = (hook_event_name, hook_at) => callbacks.onNotification('claude/hook', {
    session_id: nativeId, hook_event_name, hook_at,
  });

  sendHook('Interrupt', 150);
  assert.deepEqual(
    [observationFor(harness.collector, nativeId).status, observationFor(harness.collector, nativeId).activity,
      observationFor(harness.collector, nativeId).turnState, observationFor(harness.collector, nativeId).turnId],
    ['interrupted', 'interrupted', 'interrupted', null],
  );
  sendHook('UserPromptSubmit', 175);
  sendHook('Stop', 200);
  assert.equal(observationFor(harness.collector, nativeId).activity, 'waiting');
  sendHook('Interrupt', 300);
  assert.equal(observationFor(harness.collector, nativeId).activity, 'interrupted');
  const oldExecutionId = proofFixture.execution.registration.executionId;
  sendHook('SessionEnd', 400);
  const endedObservation = observationFor(harness.collector, nativeId);
  assert.equal(endedObservation.status, 'unknown');
  assert.equal(endedObservation.reason, 'period_end_observed');
  assert.equal(harness.collector.resolveProof(proofFixture.initialLaunch.launchRef), null);
  assert.deepEqual(proofFixture.registrationKernel.registry.snapshot().executions.find((item) =>
    item.executionId === oldExecutionId)?.state, 'active');
  assert.equal(proofFixture.authorityEndCalls.includes(oldExecutionId), false);

  proofFixture.authority.end(oldExecutionId);
  const resumed = proofFixture.addExecutionLaunch('claude-resumed-period');
  assert.notEqual(resumed.period.registration.executionId, oldExecutionId);
  assert.equal(resumed.period.identity.nativeId, nativeId);
  assert.equal(await harness.collector.reconcileProof(resumed.launch.launchRef), true);
  sendHook('UserPromptSubmit', 500);
  const resumedObservation = observationFor(harness.collector, nativeId);
  assert.equal(resumedObservation.executionId, resumed.period.registration.executionId);
  assert.equal(resumedObservation.status, 'active');
});

test('Codex unknown or mismatched turn completion keeps the last confirmed active turn', async () => {
  const proofFixture = createProductionProofFixture('codex');
  const nativeId = proofFixture.execution.identity.nativeId;
  const transport = createTransportFixture('codex', { loadedIds: [nativeId] });
  const harness = createCollectorFixture(proofFixture, transport);
  await harness.collector.connect();
  await acquireCollectorProof('codex', proofFixture, harness.collector, transport);
  const callbacks = transport.connections[0].callbacks;

  callbacks.onNotification('turn/started', { threadId: nativeId, turnId: 'turn-a' });
  callbacks.onNotification('turn/completed', { threadId: nativeId, turnId: 'turn-a', turn: {} });
  assert.deepEqual(
    [observationFor(harness.collector, nativeId).status, observationFor(harness.collector, nativeId).reason,
      observationFor(harness.collector, nativeId).activity, observationFor(harness.collector, nativeId).turnId],
    ['unknown', 'turn_status_unavailable', 'active', 'turn-a'],
  );

  callbacks.onNotification('turn/started', { threadId: nativeId, turnId: 'turn-a' });
  callbacks.onNotification('turn/completed', { threadId: nativeId, turnId: 'turn-b', turn: { status: 'completed' } });
  assert.deepEqual(
    [observationFor(harness.collector, nativeId).status, observationFor(harness.collector, nativeId).reason,
      observationFor(harness.collector, nativeId).activity, observationFor(harness.collector, nativeId).turnId],
    ['unknown', 'turn_identity_unverified', 'active', 'turn-a'],
  );

  callbacks.onNotification('turn/started', { threadId: nativeId, turnId: 'turn-a' });
  callbacks.onNotification('turn/completed', { threadId: nativeId, turn: { status: 'completed' } });
  assert.deepEqual(
    [observationFor(harness.collector, nativeId).status, observationFor(harness.collector, nativeId).reason,
      observationFor(harness.collector, nativeId).activity, observationFor(harness.collector, nativeId).turnId],
    ['unknown', 'turn_identity_unverified', 'active', 'turn-a'],
  );
});

test('Codex read failures expire cached proof until a successful reread rechecks the binding', async () => {
  const proofFixture = createProductionProofFixture('codex');
  const nativeId = proofFixture.execution.identity.nativeId;
  const transport = createTransportFixture('codex', { loadedIds: [nativeId] });
  const harness = createCollectorFixture(proofFixture, transport);
  await harness.collector.connect();
  await acquireCollectorProof('codex', proofFixture, harness.collector, transport);
  const launchRef = proofFixture.initialLaunch.launchRef;
  assert.ok(harness.collector.resolveProof(launchRef));
  const callbacks = transport.connections[0].callbacks;

  const failures = [
    { mode: 'active', loaded: false, reason: 'thread_not_loaded' },
    { mode: 'failed', loaded: true, reason: 'thread_read_failed' },
    { mode: 'identity-mismatch', loaded: true, reason: 'thread_identity_mismatch' },
  ];
  for (const failure of failures) {
    if (failure.loaded) transport.loadedIds.add(nativeId);
    else transport.loadedIds.delete(nativeId);
    transport.setReadMode(failure.mode);
    const result = await harness.collector.observeKnownThread(nativeId);
    assert.equal(result.status, 'unknown');
    assert.equal(result.reason, failure.reason);
    assert.equal(harness.collector.resolveProof(launchRef), null);

    callbacks.onNotification('turn/started', { threadId: nativeId, turnId: 'must-not-apply' });
    assert.equal(observationFor(harness.collector, nativeId).status, 'unknown');

    transport.loadedIds.add(nativeId);
    transport.setReadMode('active');
    assert.equal((await harness.collector.observeKnownThread(nativeId)).status, 'observed');
    assert.ok(harness.collector.resolveProof(launchRef));
  }
});

test('Codex delayed read from an ended period cannot overwrite the newer period observation', async () => {
  const proofFixture = createProductionProofFixture('codex');
  const nativeId = proofFixture.execution.identity.nativeId;
  const observationCalls = [];
  const transport = createTransportFixture('codex', { loadedIds: [nativeId], deferThreadRead: true });
  const harness = createCollectorFixture(proofFixture, transport, {
    onObservation: (observation) => observationCalls.push(observation),
  });
  await harness.collector.connect();

  const oldExecutionId = proofFixture.execution.registration.executionId;
  const oldRead = harness.collector.observeKnownThread(nativeId);
  await waitForReadWaiters(transport, 1);
  proofFixture.authority.end(oldExecutionId);
  const next = proofFixture.addExecutionLaunch('codex-next-period');

  const newRead = harness.collector.observeKnownThread(nativeId);
  await waitForReadWaiters(transport, 2);
  transport.releaseRead(nativeId, 'active', 1);
  assert.equal((await newRead).status, 'observed');
  const newPeriodObservation = structuredClone(observationFor(harness.collector, nativeId));
  assert.equal(newPeriodObservation.executionId, next.period.registration.executionId);
  assert.equal(newPeriodObservation.sessionId, next.period.registration.sessionId);
  const callbackCount = observationCalls.length;

  transport.releaseRead(nativeId, 'active', 0);
  const oldResult = await oldRead;
  assert.notEqual(oldResult.status, 'observed');
  assert.deepEqual(observationFor(harness.collector, nativeId), newPeriodObservation);
  assert.equal(observationCalls.length, callbackCount);
  assert.ok(harness.collector.resolveProof(next.launch.launchRef));
  const executions = proofFixture.registrationKernel.registry.snapshot().executions;
  assert.equal(executions.find((item) => item.executionId === oldExecutionId).state, 'ended');
  assert.equal(executions.find((item) => item.executionId === next.period.registration.executionId).state, 'active');
});

test('Codex delayed same-period read cannot roll back newer native turn notifications', async () => {
  const proofFixture = createProductionProofFixture('codex');
  const nativeId = proofFixture.execution.identity.nativeId;
  const observationCalls = [];
  const transport = createTransportFixture('codex', { loadedIds: [nativeId] });
  const harness = createCollectorFixture(proofFixture, transport, {
    onObservation: (observation) => observationCalls.push(observation),
  });
  await harness.collector.connect();
  await acquireCollectorProof('codex', proofFixture, harness.collector, transport);
  transport.setReadDeferred(true);
  const oldRead = harness.collector.observeKnownThread(nativeId);
  await waitForReadWaiters(transport, 1);
  const callbacks = transport.connections[0].callbacks;

  callbacks.onNotification('turn/started', { threadId: nativeId, turnId: 'turn-new' });
  callbacks.onNotification('turn/completed', {
    threadId: nativeId,
    turnId: 'turn-new',
    turn: { status: 'completed' },
  });
  const completedTurn = structuredClone(observationFor(harness.collector, nativeId));
  assert.deepEqual(
    [completedTurn.status, completedTurn.activity, completedTurn.turnState, completedTurn.turnId],
    ['completed', 'completed', 'completed', 'turn-new'],
  );
  const callbackCount = observationCalls.length;

  transport.releaseRead(nativeId, 'active');
  await oldRead;
  assert.deepEqual(observationFor(harness.collector, nativeId), completedTurn);
  assert.equal(observationCalls.length, callbackCount);
});

test('snapshot marks revoked proof unknown while retaining the last confirmed turn without a callback', async () => {
  for (const revocation of ['execution-period', 'owner-actor']) {
    const proofFixture = createProductionProofFixture('codex');
    const nativeId = proofFixture.execution.identity.nativeId;
    const observationCalls = [];
    const transport = createTransportFixture('codex', { loadedIds: [nativeId] });
    const harness = createCollectorFixture(proofFixture, transport, {
      onObservation: (observation) => observationCalls.push(observation),
    });
    await harness.collector.connect();
    await acquireCollectorProof('codex', proofFixture, harness.collector, transport);
    const callbacks = transport.connections[0].callbacks;
    callbacks.onNotification('turn/started', {
      threadId: nativeId,
      turnId: 'turn-a',
      token: 'proof-revocation-secret-marker',
      rawMessage: 'private turn payload',
    });
    const live = harness.collector.snapshot();
    const liveObservation = live.observations[0];
    const liveProof = harness.collector.resolveProof(proofFixture.initialLaunch.launchRef);
    assert.ok(liveProof);
    assert.equal(liveObservation.status, 'active');
    const callbackCount = observationCalls.length;

    if (revocation === 'execution-period') {
      proofFixture.authority.end(proofFixture.execution.registration.executionId);
    } else {
      assert.equal(proofFixture.ownerRuntimeAdapter.endActor(proofFixture.ownerActorHandle), true);
    }

    const revoked = harness.collector.snapshot();
    const observation = revoked.observations[0];
    assert.equal(observation.status, 'unknown', revocation);
    assert.equal(typeof observation.reason, 'string', revocation);
    assert.deepEqual(
      [observation.activity, observation.turnState, observation.turnId],
      [liveObservation.activity, liveObservation.turnState, liveObservation.turnId],
      revocation,
    );
    assert.equal(harness.collector.resolveProof(proofFixture.initialLaunch.launchRef), null, revocation);
    assert.equal(proofFixture.runtimeAdapter.checkCurrentProof(proofFixture.initialLaunch.launchRef, liveProof).ok, false, revocation);
    assert.equal(observationCalls.length, callbackCount, revocation);
    assert.equal(JSON.stringify(revoked).includes('proof-revocation-secret-marker'), false, revocation);
    assert.equal(JSON.stringify(revoked).includes('private turn payload'), false, revocation);
  }
});

test('Codex replies from a disconnected thread read cannot establish proof or overwrite state', async () => {
  const proofFixture = createProductionProofFixture('codex');
  const nativeId = proofFixture.execution.identity.nativeId;
  const transport = createTransportFixture('codex', { loadedIds: [nativeId], deferThreadRead: true });
  const harness = createCollectorFixture(proofFixture, transport);
  await harness.collector.connect();
  const observePromise = harness.collector.observeKnownThread(nativeId);
  for (let attempt = 0; attempt < 10 && transport.readWaiters.length === 0; attempt += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.equal(transport.readWaiters.length, 1);

  await harness.collector.disconnect();
  transport.releaseRead(nativeId);
  assert.deepEqual(await observePromise, { status: 'unknown', reason: 'connection_epoch_changed' });
  assert.equal(harness.collector.resolveProof(proofFixture.initialLaunch.launchRef), null);
  assert.equal(harness.collector.snapshot().observations.length, 0);

  await harness.collector.connect();
  assert.equal(harness.collector.snapshot().connection.generation, 2);
  assert.equal(harness.collector.resolveProof(proofFixture.initialLaunch.launchRef), null);
  assert.equal(proofFixture.registrationKernel.registry.snapshot().executions.length, 2);
});

test('Codex resumes only a thread that is currently loaded and already has a live proof', async () => {
  const proofFixture = createProductionProofFixture('codex');
  const nativeId = proofFixture.execution.identity.nativeId;
  const transport = createTransportFixture('codex', { loadedIds: [nativeId] });
  const harness = createCollectorFixture(proofFixture, transport);
  await harness.collector.connect();
  await acquireCollectorProof('codex', proofFixture, harness.collector, transport);
  transport.loadedIds.delete(nativeId);

  const unloaded = await harness.collector.resumeKnownThread(nativeId);
  assert.equal(unloaded.status, 'unknown');
  assert.equal(unloaded.reason, 'thread_not_loaded');
  assert.equal(transport.calls.some((call) => call.method === 'resumeLoadedThread'), false);

  transport.loadedIds.add(nativeId);
  assert.equal((await harness.collector.observeKnownThread(nativeId)).status, 'observed');
  assert.deepEqual(await harness.collector.resumeKnownThread(nativeId), { status: 'resumed', reason: null });
  assert.equal(transport.calls.filter((call) => call.method === 'resumeLoadedThread').length, 1);
  assert.equal(transport.calls.some((call) => call.method === 'thread/list' || String(call.method).startsWith('settings/')), false);
});
