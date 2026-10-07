'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createRegistrationKernel, createProviderRegistrationAdapter } = require('../src/server/conversation-registry');
const { createDurableDeliveryStore, createProviderDeliveryAdapter } = require('../src/server/durable-delivery-store');
const { createLaunchBindingKernel } = require('../src/server/launch-binding');
const { createNativeRecoveryBootstrap } = require('../src/server/native-recovery-checkpoint');
const { createRuntimeBindingKernel } = require('../src/server/runtime-binding');
const { createCommonQuestionProductHarness } = require('./support/common-question-product-harness');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-native-recovery-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function identity(provider, tag) {
  return {
    nativeIdKind: provider === 'claude' ? 'session' : 'thread',
    hostId: `${tag}-${provider}-host`,
    homeScopeId: `${tag}-${provider}-home`,
    nativeId: `${tag}-${provider}-native`,
  };
}

function evidence(evidenceId) {
  return {
    evidenceId,
    source: 'authorized-adapter-fixture',
    method: 'native-registration',
    adapterVersion: 'fixture-v1',
    capabilities: ['registration'],
  };
}

function createKernels() {
  const registration = createRegistrationKernel();
  const launch = createLaunchBindingKernel({ registrationRegistry: registration.registry });
  const runtime = createRuntimeBindingKernel({
    registrationRegistry: registration.registry,
    launchRegistry: launch.registry,
  });
  return { registration, launch, runtime };
}

function createStore(filePath, kernels) {
  return createDurableDeliveryStore({
    filePath,
    registrationRegistry: kernels.registration.registry,
    launchRegistry: kernels.launch.registry,
    runtimeRegistry: kernels.runtime.registry,
    resolveProof: () => null,
  });
}

for (const provider of ['claude', 'codex']) {
  test(`ID-F11-B01:${provider} registration reopens from the product file store as passive unknown history`, async (t) => {
    const directory = await temporaryDirectory(t);
    const filePath = path.join(directory, `${provider}-checkpoint.json`);
    const kernels = createKernels();
    const store = createStore(filePath, kernels);
    t.after(() => store.close());
    await store.ready;

    const nativeIdentity = identity(provider, 'reopen');
    const startOptions = { startId: `raw-start-identifier-${provider}` };
    const proof = evidence(`raw-evidence-identifier-${provider}`);
    const adapter = createProviderRegistrationAdapter(provider, kernels.registration.registry, kernels.registration.authority);
    const original = adapter.register(nativeIdentity, proof, startOptions);
    await store.captureRegistrations();
    const saved = await fs.readFile(filePath, 'utf8');
    assert.equal(JSON.parse(saved).schemaVersion, 2);
    assert.equal(saved.includes(startOptions.startId), false);
    assert.equal(saved.includes(proof.evidenceId), false);
    assert.equal(JSON.parse(saved).registrations.replayClaims.length, 1);
    await store.close();

    const recovered = await createNativeRecoveryBootstrap({ filePath });
    t.after(() => recovered.close());
    const restoredAdapter = createProviderRegistrationAdapter(provider,
      recovered.kernels.registration.registry, recovered.kernels.registration.authority);
    const restored = recovered.kernels.registration.registry.snapshot();

    assert.equal(recovered.recovery.registrationHistoryRestored, true);
    assert.equal(recovered.recovery.executionAuthorityRestored, false);
    assert.equal(recovered.recovery.writerBindingsRestored, 0);
    assert.equal(recovered.recovery.proofHandlesRestored, 0);
    assert.equal(restored.executions.length, 1);
    assert.equal(restored.executions[0].state, 'unknown');
    assert.equal(restored.replayClaims.length, 1);
    assert.throws(() => restoredAdapter.register(nativeIdentity, proof, startOptions),
      (error) => error.code === 'needs_revalidation');
    assert.throws(() => recovered.kernels.registration.authority.bindWriter(original.executionId, {
      identity: { provider, ...nativeIdentity },
      contextId: 'must-not-bind',
      evidence: evidence(`new-writer-${provider}`),
    }), (error) => error.code === 'stale_execution');
    const ledger = await recovered.store.snapshot();
    assert.deepEqual(ledger.deliveries, []);
    assert.deepEqual(ledger.notificationTargets, []);
    assert.deepEqual(recovered.kernels.launch.registry.snapshot().launches, []);
    const runtimeSnapshot = recovered.kernels.runtime.registry.snapshot();
    assert.deepEqual(runtimeSnapshot.launches, []);
    assert.deepEqual(runtimeSnapshot.connections, []);
    assert.deepEqual(runtimeSnapshot.actors, []);
    assert.deepEqual(runtimeSnapshot.handoffs, []);
  });

  test(`ID-F11-B02:${provider} delivery adapter does not resend a sending attempt after bootstrap`, async (t) => {
    const directory = await temporaryDirectory(t);
    const harness = await createCommonQuestionProductHarness({ provider, directory });
    t.after(() => harness.close());
    const adapter = createProviderDeliveryAdapter(provider, harness.deliveryStore);
    const payload = `fixture-question-payload-${provider}`;
    const delivery = await adapter.createQuestionDelivery({
      launchRef: harness.primary.launchRef,
      deliveryAttemptId: `recovery-sending-${provider}`,
      logicalMessageId: `recovery-sending-logical-${provider}`,
      revision: 1,
      payload,
    });
    let sinkCalls = 0;
    await adapter.sendStart(delivery.deliveryAttemptId, (sentPayload) => {
      sinkCalls += 1;
      assert.equal(sentPayload, payload);
      return new Promise(() => {});
    });
    assert.equal((await adapter.get(delivery.deliveryAttemptId)).state, 'sending');
    const filePath = harness.checkpointPath;
    await harness.close();
    const saved = await fs.readFile(filePath, 'utf8');
    assert.equal(saved.includes(payload), false);

    const recovered = await createNativeRecoveryBootstrap({ filePath });
    t.after(() => recovered.close());
    const recoveredAdapter = createProviderDeliveryAdapter(provider, recovered.store);
    assert.equal((await recoveredAdapter.get(delivery.deliveryAttemptId)).state, 'unknown');
    await assert.rejects(recoveredAdapter.sendStart(delivery.deliveryAttemptId, () => {
      sinkCalls += 1;
    }), (error) => error.code === 'payload_unavailable');
    await assert.rejects(recoveredAdapter.rehydratePayload(delivery.deliveryAttemptId, payload),
      (error) => error.code === 'payload_rehydrate_forbidden');
    assert.equal(sinkCalls, 1);
  });
}

test('ID-F11-B01: legacy recovery locks all registration identities without inferring replay claims', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'legacy-v1.json');
  const checkpoint = {
    schemaVersion: 1,
    revision: 7,
    registrations: {
      conversations: [{
        conversationId: 'legacy-conversation',
        identity: {
          provider: 'claude', nativeIdKind: 'session', hostId: 'legacy-host',
          homeScopeId: 'legacy-home', nativeId: 'legacy-session',
        },
      }],
      executions: [{
        conversationId: 'legacy-conversation', executionId: 'legacy-execution',
        sessionId: 'legacy-session', state: 'active',
      }],
      launches: [], runtimeLaunches: [], connections: [], actors: [], handoffs: [],
    },
    ledger: {
      schemaVersion: 1,
      revision: 0,
      deliveries: [],
      notificationTargets: [],
      logicalTombstones: [],
    },
  };
  await fs.writeFile(filePath, JSON.stringify(checkpoint));

  const recovered = await createNativeRecoveryBootstrap({ filePath });
  t.after(() => recovered.close());
  const codex = createProviderRegistrationAdapter('codex',
    recovered.kernels.registration.registry, recovered.kernels.registration.authority);

  assert.equal(recovered.recovery.registrationHistory, 'incomplete');
  assert.equal(recovered.recovery.schemaVersion, 2);
  assert.equal(recovered.kernels.registration.registry.snapshot().executions[0].state, 'unknown');
  assert.deepEqual(recovered.kernels.registration.registry.snapshot().replayClaims, []);
  assert.throws(() => codex.register(identity('codex', 'new'), evidence('fresh-codex-evidence'), {
    startId: 'fresh-codex-start',
  }), (error) => error.code === 'needs_revalidation');
});

test('failed bootstrap does not publish a bundle or replace malformed checkpoint bytes', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'malformed.json');
  const bytes = '{"schemaVersion":99,"untrusted":"leave unchanged"}';
  await fs.writeFile(filePath, bytes);

  await assert.rejects(createNativeRecoveryBootstrap({ filePath }),
    (error) => error.code === 'invalid_checkpoint_version');
  assert.equal(await fs.readFile(filePath, 'utf8'), bytes);
});

test('oversized bootstrap input is rejected without altering its file', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'oversized.json');
  const bytes = 'x'.repeat(64);
  await fs.writeFile(filePath, bytes);

  await assert.rejects(createNativeRecoveryBootstrap({ filePath, limits: { maxBytes: 8 } }),
    (error) => error.code === 'checkpoint_too_large');
  assert.equal(await fs.readFile(filePath, 'utf8'), bytes);
});
