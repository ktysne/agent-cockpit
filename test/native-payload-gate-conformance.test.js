'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createRegistrationKernel } = require('../src/server/conversation-registry');
const { createLaunchBindingKernel } = require('../src/server/launch-binding');
const { createRuntimeBindingKernel } = require('../src/server/runtime-binding');
const { createNativeLaunchComposition } = require('../src/server/native-launch-composition');
const { createDurableDeliveryStore, createProviderDeliveryAdapter } = require('../src/server/durable-delivery-store');
const { atomicWriteJson } = require('../src/server/json-storage');

function createFixture(provider, options = {}) {
  const registration = createRegistrationKernel();
  const launch = createLaunchBindingKernel({ registrationRegistry: registration.registry });
  const runtime = createRuntimeBindingKernel({ registrationRegistry: registration.registry, launchRegistry: launch.registry });
  const connections = [];
  const actors = new Map();
  const guardedRuntime = { registry: { ...runtime.registry, snapshot() { const value = runtime.registry.snapshot(); options.onRuntimeSnapshot?.(); return value; } }, authority: {
    ...runtime.authority,
    openConnection(...args) { const opened = runtime.authority.openConnection(...args); connections.push(opened.connectionHandle); return opened; },
    attestActor(handle, claims, evidence) { const result = runtime.authority.attestActor(handle, claims, evidence); actors.set(claims.launchRef, result.actorHandle); return result; },
  } };
  const runners = [];
  const home = path.resolve(os.tmpdir(), `native-payload-home-${provider}`);
  const composition = createNativeLaunchComposition({
    registrationKernel: registration,
    launchKernel: launch,
    runtimeKernel: guardedRuntime,
    hostId: 'native-payload-host',
    profiles: { main: { provider, executablePath: path.join(home, 'fixture.exe'), homePath: home,
      homeScopeId: `native-payload-scope-${provider}`, cwd: home } },
    runnerFactory(options) {
      const index = runners.length;
      const identity = { provider, nativeIdKind: provider === 'codex' ? 'thread' : 'session',
        hostId: 'native-payload-host', homeScopeId: `native-payload-scope-${provider}`, nativeId: `native-${index}` };
      const context = { kind: provider === 'codex' ? 'turn' : 'assistant_message',
        nativeContextId: `context-${index}`, parentToolUseId: null };
      const runner = {
        options, identity, context,
        async start() {
          options.onNative({ type: 'identity', provider, identity });
          options.onNative({ type: 'context', provider, identity, context });
        },
        async stop() {},
        snapshot() { return { state: 'fixture' }; },
      };
      runners.push(runner);
      return runner;
    },
  });
  const runtimeRegistry = Object.freeze({
    get: (ref) => runtime.registry.get(ref),
    snapshot: () => runtime.registry.snapshot(),
    checkCurrentProof: (ref, handle) => { options.beforeGate?.(); return composition.checkCurrentProof(ref, handle); },
  });
  async function start(suffix, originReceipt) {
    const receipt = composition.admitLaunch({ launchId: `launch-${suffix}`, runId: `run-${suffix}`,
      attemptId: `attempt-${suffix}`, profileId: 'main', origin: originReceipt ? 'delegated' : 'standalone',
      purpose: 'agent', ...(originReceipt ? { originReceipt } : {}) });
    const result = await composition.start(receipt, { inputText: `private-input-${suffix}` });
    assert.equal(result.accepted, true);
    return result;
  }
  function end(index) {
    const runner = runners[index];
    runner.options.onNative({ type: 'context_ended', provider, identity: runner.identity,
      context: { kind: runner.context.kind, nativeContextId: runner.context.nativeContextId } });
  }
  function fresh(index) {
    const runner = runners[index];
    runner.options.onNative({ type: 'context', provider, identity: runner.identity,
      context: { ...runner.context, nativeContextId: `fresh-context-${index}` } });
  }
  return { registration, launch, runtime, composition, runtimeRegistry, start, end, fresh, connections, actors };
}

for (const provider of ['claude', 'codex']) {
  for (const endedRole of ['execution', 'owner', 'ancestor']) {
    test(`ID-F05-N01 ${provider} ${endedRole}: saved send-start gates payload and preserves unknown without retry`, { timeout: 5000 }, async (t) => {
      const fixture = createFixture(provider);
      const parent = await fixture.start('parent');
      const child = await fixture.start('child', parent.runReceipt);
      const source = endedRole === 'ancestor' ? await fixture.start('leaf', child.runReceipt) : child;
      const captured = fixture.composition.resolveProof(source.launchRef);
      const before = fixture.launch.registry.get(source.launchRef);
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-payload-gate-'));
      const filePath = path.join(directory, 'checkpoint.json');
      const stores = [];
      t.after(async () => {
        for (const store of stores) await store.close().catch(() => {});
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('native-payload-gate-'));
        await fs.rm(directory, { recursive: true, force: true });
      });
      let releaseSave;
      let signalSave;
      let armed = false;
      let supplyCaptured = false;
      const saveEntered = new Promise((resolve) => { signalSave = resolve; });
      const saveReleased = new Promise((resolve) => { releaseSave = resolve; });
      const options = {
        filePath,
        registrationRegistry: fixture.registration.registry,
        launchRegistry: fixture.launch.registry,
        runtimeRegistry: fixture.runtimeRegistry,
        resolveProof: (ref) => supplyCaptured ? captured : fixture.composition.resolveProof(ref),
        atomicWrite: async (target, value) => {
          if (armed && value.ledger.deliveries.some((item) => item.state === 'sending')) {
            armed = false;
            signalSave();
            await saveReleased;
          }
          await atomicWriteJson(path.dirname(target), path.basename(target), value);
        },
      };
      const store = createDurableDeliveryStore(options);
      stores.push(store);
      await store.ready;
      const adapter = createProviderDeliveryAdapter(provider, store);
      const payload = `private-payload-${provider}-${endedRole}`;
      const delivery = await adapter.createQuestionDelivery({ launchRef: source.launchRef,
        deliveryAttemptId: `delivery-${provider}-${endedRole}`, logicalMessageId: `logical-${endedRole}`,
        revision: 1, payload });
      let sinkCalls = 0;
      armed = true;
      const sending = adapter.sendStart(delivery.deliveryAttemptId, () => { sinkCalls += 1; });
      await saveEntered;
      fixture.end(endedRole === 'execution' ? 1 : 0);
      supplyCaptured = true;
      assert.equal(fixture.composition.checkCurrentProof(source.launchRef, captured).ok, false);
      if (endedRole === 'ancestor') {
        assert.equal(fixture.runtime.registry.checkCurrentProof(source.launchRef, captured).ok, true);
      }
      releaseSave();
      const unknown = await sending;
      assert.equal(unknown.state, 'unknown');
      assert.equal(sinkCalls, 0);
      assert.deepEqual(unknown.target, delivery.target);
      assert.deepEqual(unknown.source, delivery.source);
      assert.deepEqual(fixture.launch.registry.get(source.launchRef), before);
      await assert.rejects(adapter.sendStart(delivery.deliveryAttemptId, () => { sinkCalls += 1; }),
        { code: 'payload_unavailable' });
      const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
      assert.equal(persisted.ledger.deliveries[0].state, 'unknown');
      assert.equal(JSON.stringify(persisted).includes(payload), false);
      assert.ok(persisted.registrations.actors.every((row) => !Object.hasOwn(row, 'contextState')));
      await store.close();
      fixture.fresh(endedRole === 'execution' ? 1 : 0);
      if (endedRole !== 'execution') assert.ok(await fixture.composition.reconcileProof(child.launchRef));
      if (endedRole === 'ancestor') assert.ok(await fixture.composition.reconcileProof(source.launchRef));
      supplyCaptured = false;
      assert.ok(fixture.composition.resolveProof(source.launchRef));
      const restoredRuntime = createRuntimeBindingKernel({
        registrationRegistry: fixture.registration.registry, launchRegistry: fixture.launch.registry,
      });
      const restored = createDurableDeliveryStore({ ...options,
        runtimeRegistry: restoredRuntime.registry, resolveProof: () => null,
      });
      stores.push(restored);
      await restored.ready;
      const restoredAdapter = createProviderDeliveryAdapter(provider, restored);
      assert.equal((await restoredAdapter.get(delivery.deliveryAttemptId)).state, 'unknown');
      await assert.rejects(restoredAdapter.sendStart(delivery.deliveryAttemptId, () => { sinkCalls += 1; }),
        { code: 'payload_unavailable' });
      assert.equal(sinkCalls, 0);
    });
  }
}

for (const provider of ['claude', 'codex']) {
  for (const invalidation of ['connection', 'context', 'period', 'launch']) {
    test(`ID-F05-N02 ${provider} ${invalidation}: final ancestor callback cannot admit a payload sink`, { timeout: 5000 }, async (t) => {
      let armGate = false;
      let duringCapture = false;
      let count = 0;
      let invalidate;
      const fixture = createFixture(provider, {
        beforeGate() { if (armGate) { armGate = false; duringCapture = true; count = 0; } },
        onRuntimeSnapshot() { if (duringCapture && ++count === 4) { duringCapture = false; invalidate(); } },
      });
      const parent = await fixture.start('late-parent');
      const leaf = await fixture.start('late-leaf', parent.runReceipt);
      const captured = fixture.composition.resolveProof(leaf.launchRef);
      invalidate = () => {
        if (invalidation === 'connection') fixture.runtime.authority.disconnect(fixture.connections.at(-1));
        else if (invalidation === 'context') fixture.runtime.authority.endContext(fixture.actors.get(leaf.launchRef));
        else if (invalidation === 'period') fixture.registration.authority.end(fixture.launch.registry.get(leaf.launchRef).executionBinding.periodId);
        else fixture.launch.authority.endLaunch(leaf.launchRef);
      };
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-payload-gate-'));
      const filePath = path.join(directory, 'checkpoint.json');
      let store;
      t.after(async () => {
        await store?.close();
        assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
        assert.ok(path.basename(directory).startsWith('native-payload-gate-'));
        await fs.rm(directory, { recursive: true, force: true });
      });
      store = createDurableDeliveryStore({ filePath, registrationRegistry: fixture.registration.registry,
        launchRegistry: fixture.launch.registry, runtimeRegistry: fixture.runtimeRegistry, resolveProof: () => captured,
        atomicWrite: async (target, value) => {
          await atomicWriteJson(path.dirname(target), path.basename(target), value);
          if (value.ledger.deliveries.some((row) => row.state === 'sending')) armGate = true;
        },
      });
      await store.ready;
      const adapter = createProviderDeliveryAdapter(provider, store);
      const delivery = await adapter.createQuestionDelivery({ launchRef: leaf.launchRef,
        deliveryAttemptId: `late-${provider}-${invalidation}`, logicalMessageId: 'late-proof', revision: 1, payload: 'private-late-payload' });
      let sinkCalls = 0;
      const result = await adapter.sendStart(delivery.deliveryAttemptId, () => { sinkCalls += 1; });
      assert.equal(result.state, 'unknown');
      assert.equal(sinkCalls, 0);
      assert.equal(count, 4);
      assert.equal(fixture.runtime.registry.checkCurrentProof(leaf.launchRef, captured).ok, false);
      await assert.rejects(adapter.sendStart(delivery.deliveryAttemptId, () => { sinkCalls += 1; }), { code: 'payload_unavailable' });
      assert.equal(sinkCalls, 0);
    });
  }
}
