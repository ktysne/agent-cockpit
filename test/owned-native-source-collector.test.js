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
const { createOwnedNativeRunner, getOwnedSource } = require('../src/server/owned-native-runner');
const {
  createOwnedNativeSourceCollector,
  createOwnedSourceAccessor,
  getOwnedNativeCollectorControl,
  aliasOwnedNativeCollectorControl,
} = require('../src/server/owned-native-source-collector');
const { createManagedCollector } = require('../src/server/managed-collector');
const { createDurableDeliveryStore, createProviderDeliveryAdapter } = require('../src/server/durable-delivery-store');
const { atomicWriteJson } = require('../src/server/json-storage');

function fixture(t, provider, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-collector-'));
  const homePath = path.join(directory, 'home');
  const cwd = path.join(directory, 'workspace');
  const executablePath = path.join(directory, 'native.exe');
  fs.mkdirSync(homePath); fs.mkdirSync(cwd); fs.writeFileSync(executablePath, 'fixture');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let onKernelRead = null, duringAttest = false;
  const actualRegistration = createRegistrationKernel();
  const registrationKernel = { ...actualRegistration, registry: { ...actualRegistration.registry, snapshot() { if (duringAttest && onKernelRead) onKernelRead(); return actualRegistration.registry.snapshot(); } } };
  const launchKernel = createLaunchBindingKernel({ registrationRegistry: registrationKernel.registry });
  const actualRuntime = createRuntimeBindingKernel({ registrationRegistry: registrationKernel.registry, launchRegistry: launchKernel.registry });
  const runtimeKernel = { ...actualRuntime, authority: { ...actualRuntime.authority, attestActor(...args) { duringAttest = true; try { return actualRuntime.authority.attestActor(...args); } finally { duringAttest = false; } } } };
  const methods = [];
  const observations = [];
  const children = [];
  let collector, capability, holdRead = false, pendingRead, heldContext, runnerOptionsCaptured;
  let resolvePendingReadReady;
  const pendingReadReady = new Promise((resolve) => { resolvePendingReadReady = resolve; });
  let resolveHeldContext;
  const heldContextReady = new Promise((resolve) => { resolveHeldContext = resolve; });
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.send = (...messages) => child.stdout.emit('data', Buffer.from(messages.map(JSON.stringify).join('\n') + '\n'));
  child.kill = () => { child.killCalls += 1; setImmediate(() => { child.emit('exit', 0); child.emit('close', 0); }); return true; };
  child.stdin = Object.assign(new EventEmitter(), {
    write(line, callback) {
      const request = JSON.parse(line);
      if (provider === 'claude' && request.type === 'user') {
        child.send({ type: 'system', subtype: 'init', session_id: 'native-id' });
        const sendContext = () => child.send({ type: 'stream_event', session_id: 'native-id', parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'native-context', role: 'assistant' } } });
        if (options.holdContext) { heldContext = sendContext; resolveHeldContext(); } else sendContext();
      } else if (request.method && Object.hasOwn(request, 'id')) {
        methods.push(request.method);
        const send = (result) => child.send({ id: request.id, result });
        if (request.method === 'initialize') send({ serverInfo: { name: 'fixture', version: '1' }, codexHome: path.join(homePath, '.codex') });
        else if (request.method === 'account/login/start') send({ type: 'chatgpt', loginId: 'login-id', authUrl: 'https://auth.openai.com/device?fixture=source-collector-CREDENTIAL-SENTINEL' });
        else if (request.method === 'thread/start') send({ thread: { id: 'native-id' } });
        else if (request.method === 'turn/start') {
          const sendContext = () => send({ turn: { id: 'native-context' } });
          if (options.holdContext) { heldContext = sendContext; resolveHeldContext(); } else sendContext();
        }
        else if (request.method === 'thread/loaded/list') send({ data: ['native-id'], nextCursor: null });
        else if (request.method === 'thread/read') {
          const result = { thread: { id: 'native-id', status: { type: 'active' }, turns: [{ id: 'native-context', status: 'inProgress', items: [] }] } };
          if (holdRead) { pendingRead = () => send(result); resolvePendingReadReady(); } else send(result);
        }
      }
      queueMicrotask(() => callback?.()); return true;
    }, end() {},
  });
  const composition = createNativeLaunchComposition({ registrationKernel, launchKernel, runtimeKernel,
    hostId: 'fixture-host', profiles: { [provider]: { provider, executablePath, homePath, cwd, homeScopeId: 'fixture-home' } },
    getAuthentication: () => ({ oauthToken: 'fixture-token' }),
    onAuthenticationRequired: ({ loginId }) => child.send({ method: 'account/login/completed', params: { loginId, success: true } }),
    runnerFactory(runnerOptions) {
      runnerOptionsCaptured = runnerOptions;
      return createOwnedNativeRunner({ ...runnerOptions,
        onSourceReady(cap) { capability = cap; runnerOptions.onSourceReady(cap); },
        onNative(event) {
          runnerOptions.onNative(event);
          if (event.type === 'identity') collector.connect();
        },
        spawnImpl() { children.push(child); setImmediate(() => child.emit('spawn')); return child; },
        timeouts: { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 100 },
      });
    },
  });
  const receipt = composition.admitLaunch({ launchId: 'launch', runId: 'run', attemptId: 'attempt', profileId: provider, origin: 'standalone', purpose: 'agent' });
  collector = composition.createOwnedCollector(receipt, { onObservation: (value) => observations.push(value) });
  const releaseRead = () => { const release = pendingRead; pendingRead = null; release?.(); };
  const releaseContext = () => { const release = heldContext; heldContext = null; release?.(); };
  t.after(async () => {
    const stopping = composition.stop(receipt);
    releaseRead();
    releaseContext();
    await stopping;
  });
  return { composition, collector, receipt, registrationKernel, launchKernel, runtimeKernel, child, children, methods, observations, directory,
    onKernelRead(callback) { onKernelRead = callback; },
    runnerOptions: () => runnerOptionsCaptured, contextHeld: () => Boolean(heldContext), heldContextReady: () => heldContextReady, releaseContext,
    capability: () => capability,
    holdRead: () => { holdRead = true; return pendingReadReady; },
    releaseRead,
    pendingRead: () => Boolean(pendingRead),
    start: () => composition.start(receipt, { inputText: 'fixture input' }),
  };
}

function deferred() {
  let resolve, reject;
  const promise = new Promise((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

function privateFixture(t, options = {}) {
  let currentLoan = null;
  let attachCount = 0;
  let readCount = 0;
  let cancelPendingCount = 0;
  let holdReads = false;
  let nextAttach = null;
  let lastLoan = null;
  let onObservation = options.onObservation || (() => {});
  const pendingReads = [];
  const observations = [];
  const callbacks = {};

  function makeLoan({ onNative, onDetach, makeCurrent = true }) {
    const loan = { id: ++attachCount, active: true, onNative, onDetach };
    if (makeCurrent) {
      currentLoan = loan;
      lastLoan = loan;
    }
    return loan;
  }

  const binding = {
    launchRef: 'private-launch',
    reserve: () => true,
    attach(onNative, onDetach) {
      if (nextAttach) {
        const handler = nextAttach;
        nextAttach = null;
        return handler({ onNative, onDetach, makeLoan });
      }
      return makeLoan({ onNative, onDetach });
    },
    detach(loan) {
      if (!loan || !loan.active) return false;
      loan.active = false;
      if (currentLoan === loan) currentLoan = null;
      loan.onDetach?.(loan, 'owned_source_detached');
      callbacks.detach?.(loan);
      return true;
    },
    current(loan) {
      callbacks.current?.(loan);
      return Boolean(loan?.active && currentLoan === loan);
    },
    proof(loan) {
      callbacks.proof?.(loan);
      return loan?.active && currentLoan === loan ? { launchRef: 'private-launch', loanId: loan.id } : null;
    },
    read(loan) {
      readCount += 1;
      callbacks.read?.(loan);
      const customResult = callbacks.readResult?.(loan);
      if (customResult) return Promise.resolve(customResult);
      if (!holdReads) return Promise.resolve({ status: 'observed', activity: 'active' });
      const held = deferred();
      pendingReads.push({ loan, ...held });
      return held.promise;
    },
    metadata() {
      callbacks.metadata?.();
      return {
        provider: 'codex',
        scope: { provider: 'codex', nativeIdKind: 'thread', hostId: 'private-host', homeScopeId: 'private-home' },
        identity: { provider: 'codex', nativeIdKind: 'thread', nativeId: 'native-id' },
        registration: { conversationId: 'private-conversation', executionId: 'private-execution', sessionId: 'native-id' },
        contextId: 'native-context',
      };
    },
    cancelPending() { cancelPendingCount += 1; callbacks.cancelPending?.(); },
  };
  const accessor = createOwnedSourceAccessor(binding);
  const collector = createOwnedNativeSourceCollector({
    ownedSourceAccessor: accessor,
    onObservation(value) {
      observations.push(value);
      onObservation(value);
    },
  }, (snapshot) => snapshot);
  const control = getOwnedNativeCollectorControl(collector);
  t.after(async () => {
    const disconnecting = collector.disconnect();
    control.stopAdmission();
    for (const pending of pendingReads) {
      if (pending.released) continue;
      pending.released = true;
      pending.resolve({ status: 'unknown', reason: 'test_cleanup' });
    }
    await disconnecting;
    await control.drain();
  });
  return {
    collector,
    control,
    observations,
    callbacks,
    setOnObservation(callback) { onObservation = callback; },
    setNextAttach(handler) { nextAttach = handler; },
    makeLoan,
    emitNative(event) { lastLoan?.onNative(event); },
    holdReads() { holdReads = true; },
    pendingReadCount() { return pendingReads.filter((entry) => !entry.released).length; },
    readCount: () => readCount,
    attachCount: () => attachCount,
    cancelPendingCount: () => cancelPendingCount,
    waitForRead(index = 0) { return pendingReads[index]?.promise; },
    releaseRead(index = 0, result = { status: 'observed', activity: 'active' }) {
      const pending = pendingReads[index];
      if (!pending || pending.released) return false;
      pending.released = true;
      pending.resolve(result);
      return true;
    },
  };
}

for (const provider of ['claude', 'codex']) {
  test(`${provider}: same owned pipe borrows the attested proof without another initialize or registration`, async (t) => {
    const f = fixture(t, provider);
    const started = await f.start();
    assert.equal(started.status, 'observed');
    assert.equal(f.collector.resolveProof(started.launchRef), f.composition.resolveProof(started.launchRef));
    assert.ok(f.observations.some((value) => value.status === 'active'));
    assert.equal(f.runtimeKernel.registry.snapshot().connections.length, 1);
    assert.equal(f.registrationKernel.registry.snapshot().executions.length, 1);
    assert.equal(f.methods.filter((method) => method === 'initialize').length, provider === 'codex' ? 1 : 0);
    assert.equal(f.composition.createOwnedCollector(f.receipt), f.collector);
    const publicKeys = ['close', 'connect', 'disconnect', 'observeKnownThread', 'reconcileProof', 'resolveProof', 'resumeKnownThread', 'snapshot'];
    assert.deepEqual(Object.keys(f.collector).sort(), publicKeys);
    assert.ok(getOwnedNativeCollectorControl(f.collector));
    const wrapperAlias = Object.freeze({ ...f.collector });
    assert.equal(aliasOwnedNativeCollectorControl(f.collector, wrapperAlias), true);
    assert.equal(getOwnedNativeCollectorControl(wrapperAlias), getOwnedNativeCollectorControl(f.collector));
    assert.throws(() => f.composition.createOwnedCollector({}), (error) => error.code === 'owned_collector_invalid');
    assert.equal(getOwnedNativeCollectorControl({}), null);
    assert.equal(aliasOwnedNativeCollectorControl({}, {}), false);
    assert.equal(getOwnedSource(f.capability()).bindOwner({}), false);
    assert.equal(getOwnedSource({}), null);
    const snapshot = f.collector.snapshot();
    assert.equal(snapshot.version, 1);
    assert.equal(snapshot.observations[0].activity, 'active');
    assert.deepEqual(Object.keys(snapshot).sort(), ['capabilities', 'connection', 'observations', 'provider', 'scope', 'version']);
  });

  test(`${provider}: detach keeps last known activity and physical period while all old proof operations deny`, async (t) => {
    const f = fixture(t, provider); const started = await f.start();
    const handle = f.collector.resolveProof(started.launchRef);
    const oldWriter = f.composition.writerFor(started.launchRef);
    assert.equal(f.composition.authorizeWriter(started.launchRef, oldWriter).status, 'accepted');
    await f.collector.disconnect();
    assert.equal(f.collector.resolveProof(started.launchRef), null);
    assert.equal(f.composition.checkCurrentProof(started.launchRef, handle).ok, false);
    assert.equal(f.composition.authorizeWriter(started.launchRef, oldWriter).ok, false);
    assert.equal(f.child.killCalls, 0);
    assert.equal(f.registrationKernel.registry.snapshot().executions[0].state, 'active');
    assert.equal(getOwnedSource(f.capability()).checkSource(), true);
    const observation = f.collector.snapshot().observations[0];
    assert.equal(observation.status, 'unknown'); assert.equal(observation.activity, 'active');
    assert.equal(observation.turnId, 'native-context');
    assert.equal((await f.collector.connect()).status, 'connected');
    assert.equal(f.collector.resolveProof(started.launchRef), null);
    assert.equal(f.runtimeKernel.registry.snapshot().connections.length, 2);
    assert.equal(f.registrationKernel.registry.snapshot().executions.length, 1);
    const read = await f.collector.observeKnownThread('native-id');
    assert.equal(read.status, provider === 'codex' ? 'observed' : 'unsupported');
    assert.equal(Boolean(f.collector.resolveProof(started.launchRef)), provider === 'codex');
    assert.equal(f.composition.authorizeWriter(started.launchRef, oldWriter).ok, false);
    if (provider === 'codex') {
      const freshWriter = f.composition.writerFor(started.launchRef);
      assert.equal(f.composition.authorizeWriter(started.launchRef, freshWriter).status, 'accepted');
      assert.notEqual(freshWriter.token, oldWriter.token);
    }
    assert.equal(f.methods.filter((method) => method === 'initialize').length, provider === 'codex' ? 1 : 0);
  });
}

test('foreign owned accessor cannot switch a generic collector into the owned proof issuer', () => {
  let opened = 0;
  assert.throws(() => createManagedCollector({ ownedSourceAccessor: () => ({ verified: true, generation: 1 }), transportFactory: () => { opened += 1; } }), TypeError);
  assert.equal(opened, 0);
});

for (const provider of ['claude', 'codex']) {
  test(`${provider}: detached matching terminal prevents same-context reattach without ending the physical period`, async (t) => {
    const f = fixture(t, provider); const started = await f.start();
    await f.collector.disconnect();
    if (provider === 'codex') f.child.send({ method: 'turn/completed', params: { threadId: 'native-id', turn: { id: 'native-context', status: 'completed' } } });
    else f.child.send({ type: 'stream_event', session_id: 'native-id', parent_tool_use_id: null, event: { type: 'message_stop' } });
    assert.equal(getOwnedSource(f.capability()).checkSource(), true);
    assert.equal(f.child.killCalls, 0);
    assert.equal(f.registrationKernel.registry.snapshot().executions[0].state, 'active');
    await f.collector.connect();
    const read = await f.collector.observeKnownThread('native-id');
    assert.equal(Boolean(f.collector.resolveProof(started.launchRef)), false);
    assert.notEqual(read.status, 'observed');
    assert.equal(f.runtimeKernel.registry.snapshot().actors.length, 1);
  });

  test(`${provider}: snapshot projects raw proof revocation without observation callback or changing last known activity`, async (t) => {
    const f = fixture(t, provider); await f.start();
    const notified = f.observations.length;
    f.registrationKernel.authority.end(f.registrationKernel.registry.snapshot().executions[0].executionId);
    const snapshot = f.collector.snapshot();
    assert.equal(snapshot.observations[0].status, 'unknown');
    assert.equal(snapshot.observations[0].activity, 'active');
    assert.equal(snapshot.observations[0].turnId, 'native-context');
    assert.equal(f.observations.length, notified);
  });

  test(`${provider}: send-start saved before logical detach invokes no durable payload sink and does not retry`, async (t) => {
    const f = fixture(t, provider); const started = await f.start();
    const captured = f.collector.resolveProof(started.launchRef);
    let entered, release, armed = false;
    const paused = new Promise((resolve) => { entered = resolve; });
    const resumed = new Promise((resolve) => { release = resolve; });
    const store = createDurableDeliveryStore({ filePath: path.join(f.directory, 'checkpoint.json'),
      registrationRegistry: f.registrationKernel.registry, launchRegistry: f.launchKernel.registry,
      runtimeRegistry: Object.freeze({ get: f.runtimeKernel.registry.get, snapshot: f.runtimeKernel.registry.snapshot,
        checkCurrentProof: f.composition.checkCurrentProof }), resolveProof: () => captured,
      atomicWrite: async (target, value) => {
        if (armed && value.ledger.deliveries.some((row) => row.state === 'sending')) { armed = false; entered(); await resumed; }
        await atomicWriteJson(path.dirname(target), path.basename(target), value);
      },
    });
    t.after(() => store.close()); await store.ready;
    const adapter = createProviderDeliveryAdapter(provider, store);
    const delivery = await adapter.createQuestionDelivery({ launchRef: started.launchRef, deliveryAttemptId: 'delivery', logicalMessageId: 'logical', revision: 1, payload: 'fixture payload' });
    const second = await adapter.createQuestionDelivery({ launchRef: started.launchRef, deliveryAttemptId: 'delivery-after-attach', logicalMessageId: 'logical-after-attach', revision: 1, payload: 'second fixture payload' });
    let sink = 0; armed = true;
    const sending = adapter.sendStart(delivery.deliveryAttemptId, () => { sink += 1; });
    await paused; await f.collector.disconnect(); release();
    assert.equal((await sending).state, 'unknown'); assert.equal(sink, 0);
    await f.collector.connect();
    await assert.rejects(adapter.sendStart(second.deliveryAttemptId, () => { sink += 1; }), { code: 'delivery_target_unavailable' });
    assert.equal(sink, 0);
    await assert.rejects(adapter.sendStart(delivery.deliveryAttemptId, () => { sink += 1; }), { code: 'payload_unavailable' });
    assert.equal(sink, 0);
  });
}

test('codex: a delayed read from a released lease cannot attest or replace the new lease proof', async (t) => {
  const f = fixture(t, 'codex'); const started = await f.start();
  await f.collector.disconnect(); await f.collector.connect();
  f.holdRead();
  const pending = f.collector.observeKnownThread('native-id');
  while (!f.pendingRead()) await new Promise((resolve) => setImmediate(resolve));
  await f.collector.disconnect(); await f.collector.connect();
  f.releaseRead();
  assert.equal((await pending).status, 'unknown');
  assert.equal(f.collector.resolveProof(started.launchRef), null);
  assert.equal(f.runtimeKernel.registry.snapshot().actors.length, 1);
  assert.equal(f.child.killCalls, 0);
});

test('ID-F209-C01 Codex collector drain waits for runner lease cancellation while the raw response remains held', async (t) => {
  const f = fixture(t, 'codex');
  const started = await f.start();
  const control = getOwnedNativeCollectorControl(f.collector);
  const proof = f.composition.resolveProof(started.launchRef);
  const writer = f.composition.writerFor(started.launchRef);
  assert.ok(proof);
  assert.equal(f.composition.authorizeWriter(started.launchRef, writer).status, 'accepted');

  f.holdRead();
  let readerSettled = false;
  const reader = f.collector.observeKnownThread('native-id');
  reader.then(() => { readerSettled = true; }, () => { readerSettled = true; });
  await f.holdRead();

  assert.equal(control.stopAdmission(), true);
  assert.equal(f.collector.resolveProof(started.launchRef), null);
  assert.equal(f.collector.snapshot().observations[0].status, 'unknown');
  assert.equal(f.composition.resolveProof(started.launchRef), proof);
  assert.equal(f.composition.authorizeWriter(started.launchRef, writer).status, 'accepted');
  assert.equal(readerSettled, false);

  let drainSettled = false;
  const draining = control.drain();
  draining.then(() => { drainSettled = true; });
  await Promise.resolve();
  assert.equal(drainSettled, false);
  assert.equal(f.pendingRead(), true);

  await f.collector.disconnect();
  await draining;
  assert.equal(drainSettled, true);
  assert.equal((await reader).status, 'unknown');
  assert.equal(readerSettled, true);
  assert.equal(f.pendingRead(), true);
  assert.equal(f.composition.resolveProof(started.launchRef), null);

  const observationsAtDrain = f.observations.slice();
  const actorsAtDrain = f.runtimeKernel.registry.snapshot().actors;
  const snapshotAtDrain = f.collector.snapshot();
  f.releaseRead();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(f.observations, observationsAtDrain);
  assert.deepEqual(f.runtimeKernel.registry.snapshot().actors, actorsAtDrain);
  assert.deepEqual(f.collector.snapshot(), snapshotAtDrain);
  assert.equal(f.collector.resolveProof(started.launchRef), null);
});

test('ID-F209-C01 private drain retains a non-cooperative read until its explicit release', async (t) => {
  const f = privateFixture(t);
  const acquisitions = [];
  const releases = [];
  assert.throws(() => f.control.drain(), /admission must stop/);
  assert.throws(() => f.control.bindTicketAcquirer(null), TypeError);
  assert.equal(f.control.bindTicketAcquirer((kind) => {
    acquisitions.push(kind);
    return () => releases.push(kind);
  }), true);
  assert.equal(f.control.bindTicketAcquirer(() => () => {}), false);

  assert.equal((await f.collector.connect()).status, 'connected');
  assert.equal((await f.collector.observeKnownThread('native-id')).status, 'observed');
  assert.equal(await f.collector.reconcileProof('private-launch'), true);
  assert.deepEqual(acquisitions, ['connect', 'observe', 'reconcile']);
  assert.deepEqual(releases, acquisitions);
  assert.equal(f.control.bindTicketAcquirer(() => () => {}), false);

  f.holdReads();
  let readSettled = false;
  const reader = f.collector.observeKnownThread('native-id');
  reader.then(() => { readSettled = true; }, () => { readSettled = true; });
  assert.equal(f.pendingReadCount(), 1);
  f.control.stopAdmission();
  await f.collector.disconnect();

  let drainSettled = false;
  const draining = f.control.drain();
  draining.then(() => { drainSettled = true; });
  await Promise.resolve();
  assert.equal(readSettled, false);
  assert.equal(drainSettled, false);
  assert.equal(f.releaseRead(), true);
  assert.equal((await reader).status, 'unknown');
  await draining;
  assert.equal(drainSettled, true);
});

test('ID-F209-C01 ticket acquisition registers the shared connect placeholder before reentrant callbacks', async (t) => {
  const f = privateFixture(t);
  let nestedConnect;
  let releaseCount = 0;
  assert.equal(f.control.bindTicketAcquirer((kind) => {
    if (kind === 'connect') nestedConnect = f.collector.connect();
    return () => { releaseCount += 1; };
  }), true);
  const connect = f.collector.connect();
  connect.catch(() => {});
  assert.equal(nestedConnect, connect);
  assert.equal((await connect).status, 'connected');
  assert.equal(releaseCount, 1);
});

test('ID-F209-C01 acquisition reentry stops or disconnects before source work and releases its ticket', async (t) => {
  const stopCase = privateFixture(t);
  let stopReleaseCount = 0;
  assert.equal(stopCase.control.bindTicketAcquirer(() => {
    stopCase.control.stopAdmission();
    return () => { stopReleaseCount += 1; };
  }), true);
  assert.equal((await stopCase.collector.connect()).status, 'unknown');
  assert.equal(stopCase.attachCount(), 0);
  assert.equal(stopReleaseCount, 1);
  await stopCase.control.drain();

  const disconnectCase = privateFixture(t);
  let disconnectReleaseCount = 0;
  assert.equal(disconnectCase.control.bindTicketAcquirer(() => {
    disconnectCase.collector.disconnect();
    return () => { disconnectReleaseCount += 1; };
  }), true);
  assert.equal((await disconnectCase.collector.connect()).status, 'unknown');
  assert.equal(disconnectCase.attachCount(), 0);
  assert.equal(disconnectReleaseCount, 1);
});

test('ID-F209-C01 acquisition and release failures reject while operation records still drain', async (t) => {
  const acquireCase = privateFixture(t);
  const acquireFailure = new Error('ticket acquisition failed');
  assert.equal(acquireCase.control.bindTicketAcquirer(() => { throw acquireFailure; }), true);
  const acquiring = acquireCase.collector.connect();
  acquiring.catch(() => {});
  await assert.rejects(acquiring, acquireFailure);
  acquireCase.control.stopAdmission();
  await acquireCase.control.drain();
  assert.equal(acquireCase.attachCount(), 0);

  const releaseCase = privateFixture(t);
  const releaseFailure = new Error('ticket release failed');
  assert.equal(releaseCase.control.bindTicketAcquirer(() => () => { throw releaseFailure; }), true);
  const releasing = releaseCase.collector.connect();
  releasing.catch(() => {});
  await assert.rejects(releasing, releaseFailure);
  releaseCase.control.stopAdmission();
  await releaseCase.collector.disconnect();
  await releaseCase.control.drain();
  assert.equal(releaseCase.attachCount(), 1);

  const unknownConnectCase = privateFixture(t);
  unknownConnectCase.setNextAttach(() => null);
  const unknownConnectReleaseFailure = new Error('unknown connect ticket release failed');
  assert.equal(unknownConnectCase.control.bindTicketAcquirer(() => () => { throw unknownConnectReleaseFailure; }), true);
  const unknownConnect = unknownConnectCase.collector.connect();
  unknownConnect.catch(() => {});
  await assert.rejects(unknownConnect, unknownConnectReleaseFailure);
  unknownConnectCase.control.stopAdmission();
  await unknownConnectCase.control.drain();

  const unknownReadCase = privateFixture(t);
  const unknownReadReleaseFailure = new Error('unknown read ticket release failed');
  assert.equal(unknownReadCase.control.bindTicketAcquirer((kind) => kind === 'observe'
    ? () => { throw unknownReadReleaseFailure; }
    : () => {}), true);
  await unknownReadCase.collector.connect();
  unknownReadCase.callbacks.readResult = () => ({ status: 'unknown', reason: 'fixture_unknown' });
  const unknownRead = unknownReadCase.collector.observeKnownThread('native-id');
  unknownRead.catch(() => {});
  await assert.rejects(unknownRead, unknownReadReleaseFailure);
  unknownReadCase.control.stopAdmission();
  await unknownReadCase.collector.disconnect();
  await unknownReadCase.control.drain();
});

test('ID-F209-C01 falsy callback failures stay rejected and ticket release preserves the first reason', async (t) => {
  for (const releaseFailure of [undefined, null, false, 0, '']) {
    const f = privateFixture(t);
    assert.equal(f.control.bindTicketAcquirer(() => () => { throw releaseFailure; }), true);
    const connecting = f.collector.connect();
    const settlement = connecting.then(
      (value) => ({ status: 'fulfilled', value }),
      (error) => ({ status: 'rejected', error }),
    );
    f.control.stopAdmission();
    const draining = f.control.drain();
    const result = await settlement;
    assert.equal(result.status, 'rejected');
    assert.ok(Object.is(result.error, releaseFailure));
    await draining;
    assert.equal(f.attachCount(), 1);
  }

  const primaryCase = privateFixture(t);
  assert.equal(primaryCase.control.bindTicketAcquirer((kind) => kind === 'observe'
    ? () => { throw false; }
    : () => {}), true);
  assert.equal((await primaryCase.collector.connect()).status, 'connected');
  primaryCase.callbacks.read = () => { throw null; };
  const observing = primaryCase.collector.observeKnownThread('native-id');
  const observationSettlement = observing.then(
    (value) => ({ status: 'fulfilled', value }),
    (error) => ({ status: 'rejected', error }),
  );
  const observationResult = await observationSettlement;
  assert.equal(observationResult.status, 'rejected');
  assert.equal(observationResult.error, null);
  primaryCase.callbacks.read = null;
  primaryCase.control.stopAdmission();
  await primaryCase.collector.disconnect();
  await primaryCase.control.drain();

  const unknownCase = privateFixture(t);
  unknownCase.setNextAttach(() => null);
  assert.deepEqual(await unknownCase.collector.connect(), {
    status: 'unknown', reason: 'owned_source_unavailable',
  });
});

test('ID-F209-C01 disconnect keeps detach and pending-cancel failures as Promise rejections', async (t) => {
  const detachCase = privateFixture(t);
  await detachCase.collector.connect();
  const detachFailure = new Error('detach failed');
  detachCase.callbacks.detach = () => { throw detachFailure; };
  const detaching = detachCase.collector.disconnect();
  assert.ok(detaching instanceof Promise);
  assert.equal(detachCase.collector.resolveProof('private-launch'), null);
  detaching.catch(() => {});
  await assert.rejects(detaching, detachFailure);
  detachCase.callbacks.detach = null;

  const cancelCase = privateFixture(t);
  const cancelFailure = new Error('pending cancellation failed');
  cancelCase.callbacks.cancelPending = () => { throw cancelFailure; };
  const cancelling = cancelCase.collector.disconnect();
  assert.ok(cancelling instanceof Promise);
  assert.equal(cancelCase.cancelPendingCount(), 1);
  cancelling.catch(() => {});
  await assert.rejects(cancelling, cancelFailure);
  cancelCase.callbacks.cancelPending = null;
});

test('ID-F209-C01 old attach rejection cannot clear or overwrite a newer reconnect', async (t) => {
  const f = privateFixture(t);
  const oldAttach = deferred();
  f.setNextAttach(() => oldAttach.promise);
  oldAttach.promise.catch(() => {});
  let oldSettled = false;
  const oldConnect = f.collector.connect();
  oldConnect.then(() => { oldSettled = true; }, () => { oldSettled = true; });
  let oldReleased = false;
  try {
    await f.collector.disconnect();
    assert.equal((await f.collector.connect()).status, 'connected');
    const freshProof = f.collector.resolveProof('private-launch');
    assert.ok(freshProof);

    oldAttach.reject(new Error('late attach failure'));
    oldReleased = true;
    assert.equal((await oldConnect).status, 'unknown');
    assert.equal(oldSettled, true);
    assert.equal(f.collector.snapshot().connection.state, 'connected');
    assert.ok(f.collector.resolveProof('private-launch'));
    assert.notEqual(f.collector.resolveProof('private-launch').loanId, undefined);
  } finally {
    if (!oldReleased) oldAttach.reject(new Error('test cleanup released old attach'));
    await oldConnect.catch(() => {});
  }
});

test('ID-F209-C01 old attach adoption cannot replace the loan installed by a newer reconnect', async (t) => {
  const f = privateFixture(t);
  const oldAttach = deferred();
  let oldCallbacks;
  f.setNextAttach((callbacks) => {
    oldCallbacks = callbacks;
    return oldAttach.promise;
  });
  const oldConnect = f.collector.connect();
  oldConnect.catch(() => {});
  let oldReleased = false;
  try {
    await f.collector.disconnect();
    assert.equal((await f.collector.connect()).status, 'connected');
    const freshProof = f.collector.resolveProof('private-launch');
    assert.ok(freshProof);

    oldAttach.resolve(f.makeLoan({ ...oldCallbacks, makeCurrent: false }));
    oldReleased = true;
    assert.equal((await oldConnect).status, 'unknown');
    assert.equal(f.collector.snapshot().connection.state, 'connected');
    assert.equal(f.collector.resolveProof('private-launch').loanId, freshProof.loanId);
  } finally {
    if (!oldReleased) oldAttach.resolve(f.makeLoan({ ...(oldCallbacks || {}), makeCurrent: false }));
    await oldConnect.catch(() => {});
  }
});

test('ID-F209-C01 callback reentry stops admission and drains the operation already registered', async (t) => {
  let control;
  let draining;
  let drainSettled = false;
  let drainWasPendingInCallback = false;
  const f = privateFixture(t, {
    onObservation() {
      if (!control || draining) return;
      control.stopAdmission();
      draining = control.drain();
      draining.then(() => { drainSettled = true; });
      drainWasPendingInCallback = !drainSettled;
    },
  });
  control = f.control;
  const connecting = f.collector.connect();
  connecting.catch(() => {});
  assert.equal((await connecting).status, 'unknown');
  await draining;
  assert.equal(drainWasPendingInCallback, true);
  assert.equal(drainSettled, true);
  assert.equal(f.collector.resolveProof('private-launch'), null);
});

test('ID-F209-C01 binding callback sees its operation registered before stop admission drains it', async (t) => {
  const f = privateFixture(t);
  const heldAttach = deferred();
  heldAttach.promise.catch(() => {});
  let drain;
  let snapshotBeforeStop;
  let drainSettled = false;
  let connectSettled = false;
  let attachReleased = false;
  f.setNextAttach(() => {
    snapshotBeforeStop = f.collector.snapshot().connection.state;
    f.control.stopAdmission();
    drain = f.control.drain();
    drain.then(() => { drainSettled = true; });
    return heldAttach.promise;
  });
  const connecting = f.collector.connect();
  connecting.then(() => { connectSettled = true; }, () => { connectSettled = true; });
  connecting.catch(() => {});

  try {
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(drain);
    assert.equal(snapshotBeforeStop, 'connecting');
    assert.equal(f.collector.snapshot().connection.state, 'unknown');
    assert.equal(drainSettled, false);
    assert.equal(connectSettled, false);
    heldAttach.resolve(f.makeLoan({ onNative: () => {}, onDetach: () => {} }));
    attachReleased = true;
    assert.equal((await connecting).status, 'unknown');
    await drain;
    assert.equal(drainSettled, true);
  } finally {
    if (!attachReleased) heldAttach.resolve(f.makeLoan({ onNative: () => {}, onDetach: () => {} }));
    await connecting.catch(() => {});
    if (drain) await drain.catch(() => {});
  }
});

test('ID-F209-C01 resolve, snapshot, adoption, and native callbacks cannot publish after admission stops', async (t) => {
  const proofCase = privateFixture(t);
  await proofCase.collector.connect();
  proofCase.callbacks.proof = () => { proofCase.control.stopAdmission(); };
  assert.equal(proofCase.collector.resolveProof('private-launch'), null);
  await proofCase.control.drain();

  const snapshotCase = privateFixture(t);
  await snapshotCase.collector.connect();
  snapshotCase.callbacks.proof = () => { snapshotCase.control.stopAdmission(); };
  const stoppedSnapshot = snapshotCase.collector.snapshot();
  assert.equal(stoppedSnapshot.connection.state, 'unknown');
  assert.equal(stoppedSnapshot.observations[0].status, 'unknown');
  await snapshotCase.control.drain();

  const metadataCase = privateFixture(t);
  await metadataCase.collector.connect();
  metadataCase.callbacks.metadata = () => { metadataCase.control.stopAdmission(); };
  const metadataSnapshot = metadataCase.collector.snapshot();
  assert.equal(metadataSnapshot.connection.state, 'unknown');
  assert.equal(metadataSnapshot.observations[0].status, 'unknown');
  await metadataCase.control.drain();

  let pendingAttach;
  const adoptionCase = privateFixture(t);
  pendingAttach = deferred();
  pendingAttach.promise.catch(() => {});
  adoptionCase.setNextAttach(() => pendingAttach.promise);
  let connectingSettled = false;
  const connecting = adoptionCase.collector.connect();
  connecting.then(() => { connectingSettled = true; }, () => { connectingSettled = true; });
  let pendingAttachReleased = false;
  try {
    adoptionCase.control.stopAdmission();
    pendingAttach.resolve(adoptionCase.makeLoan({
      onNative() { throw new Error('detached native callback must not run'); },
      onDetach() {},
    }));
    pendingAttachReleased = true;
    assert.equal((await connecting).status, 'unknown');
    assert.equal(connectingSettled, true);
    assert.equal(adoptionCase.collector.snapshot().observations.length, 0);
    assert.equal(adoptionCase.collector.resolveProof('private-launch'), null);
    await adoptionCase.control.drain();
  } finally {
    if (!pendingAttachReleased) pendingAttach.resolve(adoptionCase.makeLoan({ onNative: () => {}, onDetach: () => {} }));
    await connecting.catch(() => {});
    adoptionCase.control.stopAdmission();
    await adoptionCase.control.drain();
  }

  const nativeCase = privateFixture(t);
  await nativeCase.collector.connect();
  const observationsBeforeStop = nativeCase.observations.slice();
  nativeCase.control.stopAdmission();
  nativeCase.emitNative({ type: 'context' });
  assert.deepEqual(nativeCase.observations, observationsBeforeStop);
  assert.equal(nativeCase.collector.snapshot().observations[0].status, 'unknown');
  await nativeCase.control.drain();
});

test('ID-F209-C01 ticket binding is sticky after the first operation and rejected after stop', async (t) => {
  const started = privateFixture(t);
  await started.collector.connect();
  assert.equal(started.control.bindTicketAcquirer(() => () => {}), false);

  const stopped = privateFixture(t);
  assert.equal(stopped.control.stopAdmission(), true);
  assert.equal(stopped.control.bindTicketAcquirer(() => () => {}), false);
  assert.equal(stopped.control.stopAdmission(), false);
  await stopped.control.drain();
});

test('codex: detach and reattach inside the kernel metadata callback cause no old-receipt actor mutation', async (t) => {
  const f = fixture(t, 'codex'); const started = await f.start();
  await f.collector.disconnect(); await f.collector.connect();
  f.onKernelRead(() => { f.onKernelRead(null); f.collector.disconnect(); f.collector.connect(); });
  const read = await f.collector.observeKnownThread('native-id');
  assert.equal(read.status, 'unknown');
  assert.equal(f.collector.resolveProof(started.launchRef), null);
  assert.equal(f.runtimeKernel.registry.snapshot().actors.length, 1);
  assert.equal(f.runtimeKernel.registry.snapshot().connections.length, 3);
  assert.equal(f.collector.snapshot().connection.state, 'connected');
  assert.equal((await f.collector.observeKnownThread('native-id')).status, 'observed');
  assert.ok(f.collector.resolveProof(started.launchRef));
  assert.equal(f.runtimeKernel.registry.snapshot().actors.length, 2);
  assert.equal(f.child.killCalls, 0);
});

for (const provider of ['claude', 'codex']) {
  test(`${provider}: early attachment is idempotent and returns unknown after the fixed five-second bound`, async (t) => {
    const f = fixture(t, provider);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const connecting = f.collector.connect();
    assert.equal(f.collector.connect(), connecting);
    t.mock.timers.tick(5000);
    assert.equal((await connecting).status, 'unknown');
    assert.equal(f.children.length, 0);
    assert.equal(f.runtimeKernel.registry.snapshot().connections.length, 0);
    assert.equal(f.registrationKernel.registry.snapshot().executions.length, 0);
  });
}

for (const provider of ['claude', 'codex']) {
  test(`${provider}: one logical disconnect emits one unknown observation and repeated disconnect emits none`, async (t) => {
    const f = fixture(t, provider); await f.start();
    const before = f.observations.length;
    await f.collector.disconnect();
    assert.equal(f.observations.length, before + 1);
    assert.equal(f.observations.at(-1).status, 'unknown');
    await f.collector.disconnect();
    assert.equal(f.observations.length, before + 1);
  });

  test(`${provider}: physical source loss retires the owned loan before publishing unknown`, async (t) => {
    const f = fixture(t, provider); const started = await f.start();
    const before = f.observations.length;
    f.child.emit('exit', 0);
    assert.equal(f.collector.resolveProof(started.launchRef), null);
    assert.equal(f.observations.length, before + 1);
    assert.equal(f.observations.at(-1).status, 'unknown');
    assert.equal(f.collector.snapshot().connection.state, 'disconnected');
    assert.equal(f.collector.snapshot().observations[0].activity, 'active');
  });

  test(`${provider}: stopping an early attachment cancels its timer and forbids delayed adoption`, async (t) => {
    const f = fixture(t, provider);
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const connecting = f.collector.connect();
    await f.composition.stop(f.receipt);
    assert.equal((await connecting).status, 'unknown');
    t.mock.timers.tick(5000);
    assert.equal(f.children.length, 0);
    assert.equal(f.runtimeKernel.registry.snapshot().connections.length, 0);
  });
}

for (const provider of ['claude', 'codex']) {
  for (const attachBeforeContext of [false, true]) {
    test(`${provider}: startup detach with reattach-before-context=${attachBeforeContext} keeps the child and requires a fresh read before proof`, async (t) => {
      const f = fixture(t, provider, { holdContext: true });
      const starting = f.start();
      await Promise.race([f.heldContextReady(), starting.then(() => { throw new Error('native context was not held'); })]);
      await f.collector.disconnect();
      assert.equal(f.runnerOptions().isSourceCurrent(), true);
      assert.equal(f.runnerOptions().isObservationCurrent(), false);
      assert.equal(f.runtimeKernel.registry.snapshot().actors.length, 0);
      if (attachBeforeContext) await f.collector.connect();
      assert.equal(f.runnerOptions().isObservationCurrent(), false);
      f.releaseContext();
      const started = await starting;
      assert.equal(started.accepted, false);
      assert.equal(f.composition.snapshot().launches[0].processState, 'running');
      assert.equal(f.child.killCalls, 0);
      assert.equal(f.runtimeKernel.registry.snapshot().actors.length, 0);
      assert.equal(f.composition.resolveProof(started.launchRef), null);
      assert.equal(f.composition.writerFor(started.launchRef), null);
      assert.equal(f.registrationKernel.registry.snapshot().executions[0].state, 'active');
      if (!attachBeforeContext) await f.collector.connect();
      assert.equal(f.runnerOptions().isObservationCurrent(), false);
      assert.equal(f.composition.resolveProof(started.launchRef), null);
      const read = await f.collector.observeKnownThread('native-id');
      assert.equal(read.status, provider === 'codex' ? 'observed' : 'unsupported');
      assert.equal(Boolean(f.composition.resolveProof(started.launchRef)), provider === 'codex');
      assert.equal(f.runtimeKernel.registry.snapshot().actors.length, provider === 'codex' ? 1 : 0);
      assert.equal(f.child.killCalls, 0);
    });
  }

  test(`${provider}: a detached startup still fails closed when its canonical period expires`, async (t) => {
    const f = fixture(t, provider, { holdContext: true });
    const starting = f.start();
    await Promise.race([f.heldContextReady(), starting.then(() => { throw new Error('native context was not held'); })]);
    await f.collector.disconnect();
    f.registrationKernel.authority.end(f.registrationKernel.registry.snapshot().executions[0].executionId);
    assert.equal(f.runnerOptions().isSourceCurrent(), false);
    f.releaseContext();
    await assert.rejects(starting);
    assert.ok(f.child.killCalls > 0);
    assert.equal(f.runtimeKernel.registry.snapshot().actors.length, 0);
    assert.equal(f.collector.snapshot().observations[0].status, 'unknown');
  });
}

for (const provider of ['claude', 'codex']) {
  test(`${provider}: physical source expiry during detached startup cannot continue or issue an actor`, async (t) => {
    const f = fixture(t, provider, { holdContext: true });
    const starting = f.start();
    await Promise.race([f.heldContextReady(), starting.then(() => { throw new Error('native context was not held'); })]);
    await f.collector.disconnect();
    f.child.emit('exit', 0);
    assert.equal(f.runnerOptions().isSourceCurrent(), false);
    await assert.rejects(starting);
    assert.equal(f.runtimeKernel.registry.snapshot().actors.length, 0);
    assert.equal(f.registrationKernel.registry.snapshot().executions[0].state, 'active');
    assert.equal(f.collector.snapshot().connection.state, 'disconnected');
  });

  test(`${provider}: a terminal for the private-only detached startup context prevents any later proof`, async (t) => {
    const f = fixture(t, provider, { holdContext: true });
    const starting = f.start();
    await Promise.race([f.heldContextReady(), starting.then(() => { throw new Error('native context was not held'); })]);
    await f.collector.disconnect(); f.releaseContext();
    const started = await starting;
    if (provider === 'codex') f.child.send({ method: 'turn/completed', params: { threadId: 'native-id', turn: { id: 'native-context', status: 'completed' } } });
    else f.child.send({ type: 'stream_event', session_id: 'native-id', parent_tool_use_id: null, event: { type: 'message_stop' } });
    await f.collector.connect();
    assert.notEqual((await f.collector.observeKnownThread('native-id')).status, 'observed');
    assert.equal(f.composition.resolveProof(started.launchRef), null);
    assert.equal(f.runtimeKernel.registry.snapshot().actors.length, 0);
    assert.equal(f.child.killCalls, 0);
    assert.equal(f.registrationKernel.registry.snapshot().executions[0].state, 'active');
  });
}
