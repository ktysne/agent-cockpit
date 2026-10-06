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
  let collector, capability, holdRead = false, pendingRead;
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.send = (...messages) => child.stdout.emit('data', Buffer.from(messages.map(JSON.stringify).join('\n') + '\n'));
  child.kill = () => { child.killCalls += 1; setImmediate(() => child.emit('exit', 0)); return true; };
  child.stdin = Object.assign(new EventEmitter(), {
    write(line, callback) {
      const request = JSON.parse(line);
      if (provider === 'claude' && request.type === 'user') {
        child.send({ type: 'system', subtype: 'init', session_id: 'native-id' },
          { type: 'stream_event', session_id: 'native-id', parent_tool_use_id: null,
            event: { type: 'message_start', message: { id: 'native-context', role: 'assistant' } } });
      } else if (request.method && Object.hasOwn(request, 'id')) {
        methods.push(request.method);
        const send = (result) => child.send({ id: request.id, result });
        if (request.method === 'initialize') send({ serverInfo: { name: 'fixture', version: '1' }, codexHome: path.join(homePath, '.codex') });
        else if (request.method === 'account/login/start') send({ type: 'chatgpt', loginId: 'login-id', authUrl: 'https://auth.example.test/device' });
        else if (request.method === 'thread/start') send({ thread: { id: 'native-id' } });
        else if (request.method === 'turn/start') send({ turn: { id: 'native-context' } });
        else if (request.method === 'thread/loaded/list') send({ data: ['native-id'], nextCursor: null });
        else if (request.method === 'thread/read') {
          const result = { thread: { id: 'native-id', status: { type: 'active' }, turns: [{ id: 'native-context', status: 'inProgress', items: [] }] } };
          if (holdRead) pendingRead = () => send(result); else send(result);
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
  t.after(() => composition.stop(receipt));
  return { composition, collector, receipt, registrationKernel, launchKernel, runtimeKernel, child, children, methods, observations, directory,
    onKernelRead(callback) { onKernelRead = callback; },
    capability: () => capability, holdRead: () => { holdRead = true; }, releaseRead: () => pendingRead?.(), pendingRead: () => Boolean(pendingRead),
    start: () => composition.start(receipt, { inputText: 'fixture input' }),
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
    assert.throws(() => f.composition.createOwnedCollector({}), (error) => error.code === 'owned_collector_invalid');
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
