'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { atomicWriteJson } = require('../src/server/json-storage');
const {
  createDurableCheckpointStore,
} = require('../src/server/durable-checkpoint');
const {
  createDurableDeliveryStore,
  createProviderDeliveryAdapter,
} = require('../src/server/durable-delivery-store');

function identity(provider, tag) {
  return {
    provider,
    nativeIdKind: provider === 'claude' ? 'session' : 'thread',
    hostId: `${provider}-host`,
    homeScopeId: `${provider}-home`,
    nativeId: `${tag}-${provider}-native`,
  };
}

function binding(periodId, actorId) {
  return { periodId, actor: { kind: 'agent', id: actorId } };
}

function launchRecord({ provider, tag, identity: launchIdentity, periodId, actor, origin, originBinding }) {
  const launchRef = `${tag}-launch-ref`;
  return {
    launchRef,
    launchId: `${tag}-launch-id`,
    runId: `${tag}-run-id`,
    attemptId: `${tag}-attempt-id`,
    provider,
    nativeIdKind: launchIdentity.nativeIdKind,
    hostId: launchIdentity.hostId,
    homeScopeId: launchIdentity.homeScopeId,
    origin,
    purpose: 'agent',
    originBinding,
    state: 'bound',
    identity: launchIdentity,
    executionBinding: binding(periodId, actor.id),
    conversationId: `${tag}-conversation`,
    sessionId: `${tag}-session`,
    currentOwner: originBinding || binding(periodId, actor.id),
    ownerGeneration: 0,
    currentProof: { publicSummary: 'must not be persisted' },
  };
}

function clone(value) {
  return structuredClone(value);
}

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-durable-store-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function createFixture(options = {}) {
  const sourceProvider = options.sourceProvider || 'claude';
  const ownerProvider = options.ownerProvider || sourceProvider;
  const targetProvider = options.targetProvider || 'codex';
  const ownerIdentity = identity(ownerProvider, 'owner');
  const sourceIdentity = identity(sourceProvider, 'source');
  const targetIdentity = identity(targetProvider, 'target');
  const ownerBinding = binding('owner-period', 'owner-actor');
  const sourceBinding = binding('source-period', 'source-actor');
  const targetBinding = binding('target-period', 'target-actor');
  const source = launchRecord({ provider: sourceProvider, tag: 'source', identity: sourceIdentity,
    periodId: sourceBinding.periodId, actor: sourceBinding.actor, origin: 'delegated', originBinding: ownerBinding });
  const target = launchRecord({ provider: targetProvider, tag: 'target', identity: targetIdentity,
    periodId: targetBinding.periodId, actor: targetBinding.actor, origin: 'standalone', originBinding: null });
  const ownerConversation = `${ownerProvider}-owner-conversation`;
  const ownerSession = `${ownerProvider}-owner-session`;
  const conversations = [
    { conversationId: ownerConversation, identity: ownerIdentity },
    { conversationId: source.conversationId, identity: sourceIdentity },
    { conversationId: target.conversationId, identity: targetIdentity },
  ];
  const executions = [
    { conversationId: ownerConversation, executionId: ownerBinding.periodId, sessionId: ownerSession, state: 'active' },
    { conversationId: source.conversationId, executionId: sourceBinding.periodId, sessionId: source.sessionId, state: 'active' },
    { conversationId: target.conversationId, executionId: targetBinding.periodId, sessionId: target.sessionId, state: 'active' },
  ];
  const ownerActor = { identity: ownerIdentity, periodId: ownerBinding.periodId, actor: ownerBinding.actor,
    contextId: 'owner-context', launchRef: null };
  const sourceActor = { identity: sourceIdentity, periodId: sourceBinding.periodId, actor: sourceBinding.actor,
    contextId: 'source-context', launchRef: source.launchRef };
  const targetActor = { identity: targetIdentity, periodId: targetBinding.periodId, actor: targetBinding.actor,
    contextId: 'target-context', launchRef: target.launchRef };
  const actorRows = [ownerActor, sourceActor, targetActor];
  const connections = [];
  const runtimeActors = [];
  for (let index = 0; index < actorRows.length; index += 1) {
    const actor = actorRows[index];
    const slot = `slot-${index}`;
    const connectionId = `connection-${index}`;
    const scope = {
      provider: actor.identity.provider,
      nativeIdKind: actor.identity.nativeIdKind,
      hostId: actor.identity.hostId,
      homeScopeId: actor.identity.homeScopeId,
      connectionSlotId: slot,
    };
    connections.push({ connectionId, scope, generation: 1, state: 'active', evidence: { private: true } });
    runtimeActors.push({ ...actor, connectionId, connectionGeneration: 1, state: 'active', evidence: { private: true } });
  }
  const sourceRuntime = { ...source, state: 'bound', currentOwner: ownerBinding, ownerGeneration: 0 };
  const targetRuntime = { ...target, state: 'bound', currentOwner: targetBinding, ownerGeneration: 0 };
  const launches = [source, target];
  const runtimeLaunches = [sourceRuntime, targetRuntime];
  const proofHandles = new Map([[source.launchRef, { private: 'source-proof' }],
    [target.launchRef, { private: 'target-proof' }]]);
  const proofLive = new Map([[source.launchRef, true], [target.launchRef, true]]);
  const registrationRegistry = {
    snapshot() { return { conversations: clone(conversations), executions: clone(executions) }; },
  };
  const launchRegistry = {
    get(launchRef) { return clone(launches.find((item) => item.launchRef === launchRef) || null); },
    snapshot() { return { launches: clone(launches), observations: [{ private: 'ignored' }] }; },
  };
  const runtimeRegistry = {
    get(launchRef) { return clone(runtimeLaunches.find((item) => item.launchRef === launchRef) || null); },
    snapshot() { return { launches: clone(runtimeLaunches), connections: clone(connections),
      actors: clone(runtimeActors), handoffs: [], observations: [{ private: 'ignored' }] }; },
    checkCurrentProof(launchRef, handle) {
      const runtime = runtimeLaunches.find((item) => item.launchRef === launchRef);
      return { ok: Boolean(runtime && runtime.state === 'bound' && proofLive.get(launchRef) &&
        proofHandles.get(launchRef) === handle) };
    },
  };
  const verifyResultOwner = options.verifyResultOwner || (() => true);
  const dependencies = { registrationRegistry, launchRegistry, runtimeRegistry,
    resolveProof: (launchRef) => proofHandles.get(launchRef), verifyResultOwner };
  return {
    source, target, sourceBinding, ownerBinding, targetBinding, ownerIdentity, sourceIdentity, targetIdentity,
    conversations, executions, connections, runtimeActors, launches, runtimeLaunches, proofLive,
    registrationRegistry, launchRegistry, runtimeRegistry, dependencies,
  };
}

function deliveryInput(launchRef, deliveryAttemptId, payload = 'payload-secret-unique') {
  return { launchRef, deliveryAttemptId, logicalMessageId: `${deliveryAttemptId}-logical`, revision: 1, payload };
}

function errorCode(code) {
  return (error) => error?.code === code;
}

function appliedCorrelation(delivery) {
  return {
    deliveryAttemptId: delivery.deliveryAttemptId,
    revision: delivery.revision,
    payloadDigest: delivery.payloadDigest,
    targetPeriodId: delivery.target.periodId,
    nativeTurnId: 'native-turn-1',
    nativeItemId: 'native-item-1',
    clientRequestId: delivery.deliveryAttemptId,
  };
}

test('delivery store saves payload digests only and gives the sink one frozen delivery', async (t) => {
  const directory = await temporaryDirectory(t);
  const fixture = createFixture();
  const store = createDurableDeliveryStore({ filePath: path.join(directory, 'ledger.json'), ...fixture.dependencies });
  t.after(() => store.close());
  await store.ready;
  const adapter = createProviderDeliveryAdapter('claude', store);
  const input = deliveryInput(fixture.source.launchRef, 'question-delivery', 'highly-sensitive-payload');
  const pending = adapter.createQuestionDelivery(input);
  input.launchRef = fixture.target.launchRef;
  input.payload = 'changed after enqueue';
  const delivery = await pending;
  assert.equal(delivery.source.launchRef, fixture.source.launchRef);
  const savedBytes = await fs.readFile(path.join(directory, 'ledger.json'), 'utf8');
  assert.equal(savedBytes.includes('highly-sensitive-payload'), false);
  assert.equal(savedBytes.includes('changed after enqueue'), false);
  assert.equal(savedBytes.includes('publicSummary'), false);
  assert.equal(savedBytes.includes('private'), false);
  const sent = [];
  await adapter.sendStart(delivery.deliveryAttemptId, (payload, metadata) => {
    sent.push(payload);
    assert.equal(Object.isFrozen(metadata), true);
    assert.equal(Object.hasOwn(metadata, 'payload'), false);
  });
  assert.deepEqual(sent, ['highly-sensitive-payload']);
  assert.equal(Object.hasOwn(await adapter.get(delivery.deliveryAttemptId), 'payload'), false);
  await assert.rejects(adapter.sendStart(delivery.deliveryAttemptId, () => {}), errorCode('payload_unavailable'));
});

test('provider adapters scope lifecycle IDs to the delivery target kind', async (t) => {
  const directory = await temporaryDirectory(t);
  const fixture = createFixture({ sourceProvider: 'claude', targetProvider: 'codex' });
  const store = createDurableDeliveryStore({ filePath: path.join(directory, 'ledger.json'), ...fixture.dependencies });
  t.after(() => store.close());
  await store.ready;
  const claude = createProviderDeliveryAdapter('claude', store);
  const codex = createProviderDeliveryAdapter('codex', store);
  const question = await claude.createQuestionDelivery(deliveryInput(fixture.source.launchRef, 'question-owned-by-claude'));
  await assert.rejects(codex.cancel(question.deliveryAttemptId), errorCode('provider_mismatch'));
  const target = await codex.registerPrNotificationTarget({ targetId: 'codex-target', launchRef: fixture.target.launchRef });
  assert.equal(target.targetId, 'codex-target');
  const prInput = {
    sourceLaunchRef: fixture.source.launchRef,
    targetId: target.targetId,
    deliveryAttemptId: 'notification-owned-by-codex',
    logicalMessageId: 'notification-logical',
    revision: 1,
    payload: 'cross-provider-notification',
  };
  await assert.rejects(claude.createPrNotification(prInput), errorCode('provider_mismatch'));
  const notification = await codex.createPrNotification(prInput);
  assert.equal(notification.source.identity.provider, 'claude');
  assert.equal(notification.target.identity.provider, 'codex');
  await assert.rejects(claude.sendStart(notification.deliveryAttemptId, () => {}), errorCode('provider_mismatch'));
  await codex.claim(notification.deliveryAttemptId);
  const sent = [];
  await codex.sendStart(notification.deliveryAttemptId, (payload) => sent.push(payload));
  assert.deepEqual(sent, ['cross-provider-notification']);
});

test('result delivery uses its captured cross-provider owner verifier after the child ends', async (t) => {
  const directory = await temporaryDirectory(t);
  let verifierCalls = 0;
  const fixture = createFixture({ sourceProvider: 'claude', ownerProvider: 'codex',
    verifyResultOwner: (delivery) => {
      verifierCalls += 1;
      return delivery.target.identity.provider === 'codex' && delivery.target.periodId === 'owner-period';
    } });
  const store = createDurableDeliveryStore({ filePath: path.join(directory, 'ledger.json'), ...fixture.dependencies });
  t.after(() => store.close());
  await store.ready;
  const claude = createProviderDeliveryAdapter('claude', store);
  const delivery = await claude.createResultDelivery(deliveryInput(fixture.source.launchRef, 'cross-provider-result'));
  assert.equal(delivery.target.identity.provider, 'codex');
  fixture.launches.find((item) => item.launchRef === fixture.source.launchRef).state = 'ended';
  fixture.runtimeLaunches.find((item) => item.launchRef === fixture.source.launchRef).state = 'ended';
  fixture.executions.find((item) => item.executionId === fixture.sourceBinding.periodId).state = 'ended';
  fixture.runtimeActors.find((item) => item.launchRef === fixture.source.launchRef).state = 'ended';
  const sent = [];
  await claude.sendStart(delivery.deliveryAttemptId, (payload) => sent.push(payload));
  assert.deepEqual(sent, ['payload-secret-unique']);
  assert.equal(verifierCalls >= 2, true);
});

test('result delivery refuses to send without a fresh owner verifier', async (t) => {
  const directory = await temporaryDirectory(t);
  const fixture = createFixture();
  const dependencies = { ...fixture.dependencies };
  delete dependencies.verifyResultOwner;
  const store = createDurableDeliveryStore({ filePath: path.join(directory, 'ledger.json'), ...dependencies });
  t.after(() => store.close());
  await store.ready;
  const adapter = createProviderDeliveryAdapter('claude', store);
  const delivery = await adapter.createResultDelivery(deliveryInput(fixture.source.launchRef, 'unverified-result'));
  let sinkCalls = 0;
  await assert.rejects(adapter.sendStart(delivery.deliveryAttemptId, () => { sinkCalls += 1; }),
    errorCode('delivery_target_unavailable'));
  assert.equal(sinkCalls, 0);
  assert.equal((await adapter.get(delivery.deliveryAttemptId)).state, 'available');
});
test('proof loss while the sending checkpoint is being saved exposes no payload', async (t) => {
  const directory = await temporaryDirectory(t);
  const fixture = createFixture();
  let writeCount = 0;
  let releaseSendingWrite;
  let startedSendingWrite;
  const started = new Promise((resolve) => { startedSendingWrite = resolve; });
  const gate = new Promise((resolve) => { releaseSendingWrite = resolve; });
  const store = createDurableDeliveryStore({
    filePath: path.join(directory, 'ledger.json'),
    ...fixture.dependencies,
    atomicWrite: async (target, value) => {
      writeCount += 1;
      if (writeCount === 2) {
        startedSendingWrite();
        await gate;
      }
      await atomicWriteJson(path.dirname(target), path.basename(target), value);
    },
  });
  t.after(() => store.close());
  await store.ready;
  const adapter = createProviderDeliveryAdapter('claude', store);
  const delivery = await adapter.createQuestionDelivery(deliveryInput(fixture.source.launchRef, 'proof-expiry'));
  const sent = [];
  const sending = adapter.sendStart(delivery.deliveryAttemptId, (payload) => sent.push(payload));
  await started;
  fixture.proofLive.set(fixture.source.launchRef, false);
  releaseSendingWrite();
  const finalDelivery = await sending;
  assert.equal(sent.length, 0);
  assert.equal(finalDelivery.state, 'unknown');
});

test('unknown replacement outcome blocks the writer and a restart recovers sending as unknown', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'ledger.json');
  const fixture = createFixture();
  let writeCount = 0;
  const store = createDurableDeliveryStore({
    filePath,
    ...fixture.dependencies,
    atomicWrite: async (target, value) => {
      writeCount += 1;
      await atomicWriteJson(path.dirname(target), path.basename(target), value);
      if (writeCount === 2) throw new Error('replacement result unknown');
    },
  });
  await store.ready;
  const adapter = createProviderDeliveryAdapter('claude', store);
  const delivery = await adapter.createQuestionDelivery(deliveryInput(fixture.source.launchRef, 'failed-send-save'));
  let sinkCalls = 0;
  await assert.rejects(adapter.sendStart(delivery.deliveryAttemptId, () => { sinkCalls += 1; }),
    errorCode('checkpoint_write_failed'));
  assert.equal(sinkCalls, 0);
  assert.equal((await store.get(delivery.deliveryAttemptId)).state, 'available');
  await assert.rejects(store.claim(delivery.deliveryAttemptId), errorCode('store_writer_blocked'));
  await store.close();
  const checkpointStore = createDurableCheckpointStore({ filePath });
  const recovered = await checkpointStore.load();
  assert.equal(recovered.ledger.deliveries[0].state, 'unknown');
  assert.equal(Object.hasOwn(recovered.ledger.deliveries[0], 'payload'), false);
  await checkpointStore.close();
});

test('rejected sink promise moves accepted to unknown and cannot undo applied', async (t) => {
  const directory = await temporaryDirectory(t);
  const fixture = createFixture();
  const store = createDurableDeliveryStore({ filePath: path.join(directory, 'ledger.json'), ...fixture.dependencies });
  t.after(() => store.close());
  await store.ready;
  const adapter = createProviderDeliveryAdapter('claude', store);
  const acceptedOnly = await adapter.createQuestionDelivery(deliveryInput(fixture.source.launchRef, 'late-reject-accepted'));
  let rejectAccepted;
  const acceptedPromise = new Promise((resolve, reject) => { rejectAccepted = reject; });
  await adapter.sendStart(acceptedOnly.deliveryAttemptId, () => acceptedPromise);
  const correlation = appliedCorrelation(acceptedOnly);
  await adapter.recordAccepted(acceptedOnly.deliveryAttemptId, correlation);
  rejectAccepted(new Error('transport rejected'));
  await new Promise((resolve) => setImmediate(resolve));
  await store.flush();
  assert.equal((await adapter.get(acceptedOnly.deliveryAttemptId)).state, 'unknown');

  const applied = await adapter.createQuestionDelivery(deliveryInput(fixture.source.launchRef, 'late-reject-applied'));
  let rejectApplied;
  const appliedPromise = new Promise((resolve, reject) => { rejectApplied = reject; });
  await adapter.sendStart(applied.deliveryAttemptId, () => appliedPromise);
  const appliedAck = { ...appliedCorrelation(applied), nativeTurnId: 'native-turn-2', nativeItemId: 'native-item-2' };
  await adapter.recordAccepted(applied.deliveryAttemptId, appliedAck);
  await adapter.recordApplied(applied.deliveryAttemptId, appliedAck);
  rejectApplied(new Error('late transport rejection'));
  await new Promise((resolve) => setImmediate(resolve));
  await store.flush();
  assert.equal((await adapter.get(applied.deliveryAttemptId)).state, 'applied');
});

test('rehydration requires the stored digest, fresh connection generation, and a live verifier', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'ledger.json');
  const fixture = createFixture();
  const first = createDurableDeliveryStore({ filePath, ...fixture.dependencies });
  await first.ready;
  const original = await first.createQuestionDelivery(deliveryInput(fixture.source.launchRef, 'rehydrate-delivery'));
  await first.close();

  for (const connection of fixture.connections) connection.state = 'ended';
  const priorConnections = clone(fixture.connections);
  const connectionIds = new Map();
  for (let index = 0; index < priorConnections.length; index += 1) {
    const previous = fixture.connections[index];
    const nextId = `${previous.connectionId}-fresh`;
    const next = { ...previous, connectionId: nextId, generation: 2, state: 'active' };
    connectionIds.set(previous.connectionId, nextId);
    fixture.connections.push(next);
  }
  for (const actor of fixture.runtimeActors) {
    actor.connectionId = connectionIds.get(actor.connectionId);
    actor.connectionGeneration = 2;
    actor.state = 'active';
  }
  fixture.connections.splice(0, priorConnections.length, ...priorConnections);
  const second = createDurableDeliveryStore({ filePath, ...fixture.dependencies });
  t.after(() => second.close());
  await second.ready;
  const adapter = createProviderDeliveryAdapter('claude', second);
  await assert.rejects(adapter.rehydratePayload(original.deliveryAttemptId, 'wrong-content'),
    errorCode('payload_digest_mismatch'));
  await adapter.rehydratePayload(original.deliveryAttemptId, 'payload-secret-unique');
  const sent = [];
  await adapter.sendStart(original.deliveryAttemptId, (payload) => sent.push(payload));
  assert.deepEqual(sent, ['payload-secret-unique']);
  await assert.rejects(adapter.rehydratePayload(original.deliveryAttemptId, 'payload-secret-unique'),
    errorCode('payload_rehydrate_forbidden'));
});



test('a synchronous sink throw persists unknown and deletes its payload', async (t) => {
  const directory = await temporaryDirectory(t);
  const fixture = createFixture();
  const store = createDurableDeliveryStore({ filePath: path.join(directory, 'ledger.json'), ...fixture.dependencies });
  t.after(() => store.close());
  await store.ready;
  const adapter = createProviderDeliveryAdapter('claude', store);
  const delivery = await adapter.createQuestionDelivery(deliveryInput(fixture.source.launchRef, 'sink-throws'));
  const result = await adapter.sendStart(delivery.deliveryAttemptId, () => { throw new Error('sink failed'); });
  assert.equal(result.state, 'unknown');
  await assert.rejects(adapter.rehydratePayload(delivery.deliveryAttemptId, 'payload-secret-unique'),
    errorCode('payload_rehydrate_forbidden'));
});

test('result owner generation change during sending persistence holds the fixed destination', async (t) => {
  const directory = await temporaryDirectory(t);
  const fixture = createFixture({ sourceProvider: 'claude', ownerProvider: 'codex' });
  let writeCount = 0;
  let releaseSendingWrite;
  let startedSendingWrite;
  const started = new Promise((resolve) => { startedSendingWrite = resolve; });
  const gate = new Promise((resolve) => { releaseSendingWrite = resolve; });
  const store = createDurableDeliveryStore({
    filePath: path.join(directory, 'ledger.json'),
    ...fixture.dependencies,
    atomicWrite: async (target, value) => {
      writeCount += 1;
      if (writeCount === 2) {
        startedSendingWrite();
        await gate;
      }
      await atomicWriteJson(path.dirname(target), path.basename(target), value);
    },
  });
  t.after(() => store.close());
  await store.ready;
  const adapter = createProviderDeliveryAdapter('claude', store);
  const delivery = await adapter.createResultDelivery(deliveryInput(fixture.source.launchRef, 'result-owner-change'));
  const sent = [];
  const sending = adapter.sendStart(delivery.deliveryAttemptId, (payload) => sent.push(payload));
  await started;
  fixture.runtimeLaunches.find((item) => item.launchRef === fixture.source.launchRef).ownerGeneration = 1;
  fixture.runtimeLaunches.find((item) => item.launchRef === fixture.source.launchRef).currentOwner =
    binding('new-owner-period', 'new-owner-actor');
  releaseSendingWrite();
  const result = await sending;
  assert.equal(sent.length, 0);
  assert.equal(result.state, 'unknown');
});

test('delivery checkpoint reservation rejects the next create and retains maximum correlations through restore', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'ledger.json');
  const maxBytes = 40_000;
  const fixture = createFixture();
  const store = createDurableDeliveryStore({ filePath, limits: { maxBytes }, ...fixture.dependencies });
  await store.ready;
  const adapter = createProviderDeliveryAdapter('claude', store);
  const deliveries = [];
  let overflowIndex = 0;
  for (; overflowIndex < 20; overflowIndex += 1) {
    try {
      deliveries.push(await adapter.createQuestionDelivery(
        deliveryInput(fixture.source.launchRef, `reserved-${overflowIndex}`)));
    } catch (error) {
      if (error.code !== 'checkpoint_capacity_reserved') throw error;
      break;
    }
  }
  assert.ok(deliveries.length > 0);
  assert.ok(overflowIndex < 20);
  const beforeRejectedCreate = await fs.readFile(filePath, 'utf8');
  assert.ok(Buffer.byteLength(beforeRejectedCreate, 'utf8') <= maxBytes);
  await assert.rejects(adapter.createQuestionDelivery(
    deliveryInput(fixture.source.launchRef, 'reserved-overflow')),
  errorCode('checkpoint_capacity_reserved'));
  assert.equal(await fs.readFile(filePath, 'utf8'), beforeRejectedCreate);

  const delivery = deliveries[0];
  await adapter.sendStart(delivery.deliveryAttemptId, () => {});
  const base = appliedCorrelation(delivery);
  await adapter.recordAccepted(delivery.deliveryAttemptId, {
    ...base, nativeTurnId: null, nativeItemId: null,
  });
  const escapedNativeId = '\uD800'.repeat(512);
  const maximumCorrelation = {
    ...base, nativeTurnId: escapedNativeId, nativeItemId: escapedNativeId,
  };
  await adapter.recordApplied(delivery.deliveryAttemptId, maximumCorrelation);
  await adapter.recordAccepted(delivery.deliveryAttemptId, maximumCorrelation);
  const cancelled = await adapter.cancel(delivery.deliveryAttemptId);
  assert.equal(cancelled.state, 'applied');
  assert.equal(cancelled.cancelRequested, true);
  await store.close();

  const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
  const persistedDelivery = persisted.ledger.deliveries.find((item) =>
    item.deliveryAttemptId === delivery.deliveryAttemptId);
  assert.equal(persistedDelivery.acceptedCorrelation.nativeTurnId.length, 512);
  assert.equal(persistedDelivery.appliedCorrelation.nativeItemId.length, 512);
  assert.equal(Object.hasOwn(persistedDelivery, 'payload'), false);
  assert.ok(Buffer.byteLength(JSON.stringify(persisted, null, 2) + '\n', 'utf8') <= maxBytes);

  const reopened = createDurableDeliveryStore({ filePath, limits: { maxBytes }, ...fixture.dependencies });
  t.after(() => reopened.close());
  await reopened.ready;
  const reopenedAdapter = createProviderDeliveryAdapter('claude', reopened);
  const afterRestore = await reopenedAdapter.get(delivery.deliveryAttemptId);
  assert.equal(afterRestore.state, 'applied');
  assert.equal(afterRestore.cancelRequested, true);
  assert.equal(afterRestore.acceptedCorrelation.nativeItemId, escapedNativeId);
  assert.equal(afterRestore.appliedCorrelation.nativeTurnId, escapedNativeId);
  for (const connection of fixture.connections) connection.state = 'inactive';
  for (const actor of fixture.runtimeActors) actor.state = 'unknown';
  await assert.rejects(reopenedAdapter.sendStart(delivery.deliveryAttemptId, () => {}),
    errorCode('payload_unavailable'));
});

test('store rejects insufficient restored reservation while bare checkpoint reader honors the hard cap', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'ledger.json');
  const fixture = createFixture();
  const seedStore = createDurableDeliveryStore({ filePath, ...fixture.dependencies });
  await seedStore.ready;
  await seedStore.createQuestionDelivery(deliveryInput(fixture.source.launchRef, 'old-checkpoint'));
  await seedStore.close();
  const persistedBytes = Buffer.byteLength(await fs.readFile(filePath), 'utf8');
  const before = await fs.readFile(filePath);

  const limitedStore = createDurableDeliveryStore({
    filePath, limits: { maxBytes: persistedBytes }, ...fixture.dependencies,
  });
  await assert.rejects(limitedStore.ready, errorCode('checkpoint_capacity_reserved'));
  await limitedStore.close();
  assert.deepEqual(await fs.readFile(filePath), before);

  const bareReader = createDurableCheckpointStore({ filePath, maxBytes: persistedBytes });
  const loaded = await bareReader.load();
  assert.equal(loaded.ledger.deliveries[0].state, 'available');
  await bareReader.close();
});

test('cancel and supersede release each unsent payload after their checkpoint commits', async (t) => {
  const directory = await temporaryDirectory(t);
  const fixture = createFixture();
  const store = createDurableDeliveryStore({ filePath: path.join(directory, 'ledger.json'), ...fixture.dependencies });
  t.after(() => store.close());
  await store.ready;
  const adapter = createProviderDeliveryAdapter('claude', store);
  const cancelled = await adapter.createQuestionDelivery(deliveryInput(fixture.source.launchRef, 'payload-cancelled'));
  assert.equal((await adapter.cancel(cancelled.deliveryAttemptId)).state, 'cancelled_before_send');
  await assert.rejects(adapter.sendStart(cancelled.deliveryAttemptId, () => {}), errorCode('payload_unavailable'));

  const superseded = await adapter.createQuestionDelivery(deliveryInput(fixture.source.launchRef, 'payload-superseded'));
  assert.equal((await adapter.supersedeUnsentDelivery(superseded.deliveryAttemptId)).state,
    'superseded_before_send');
  await assert.rejects(adapter.sendStart(superseded.deliveryAttemptId, () => {}), errorCode('payload_unavailable'));
});
