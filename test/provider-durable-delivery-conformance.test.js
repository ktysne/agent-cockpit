'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createRegistrationKernel } = require('../src/server/conversation-registry');
const { createProviderRegistrationAdapter } = require('../src/server/provider-registration');
const { createLaunchBindingKernel, createProviderLaunchAdapter } = require('../src/server/launch-binding');
const { createRuntimeBindingKernel, createProviderRuntimeAdapter } = require('../src/server/runtime-binding');
const { createDurableDeliveryStore, createProviderDeliveryAdapter } = require('../src/server/durable-delivery-store');
const { atomicWriteJson } = require('../src/server/json-storage');
const { createDurableCheckpointStore } = require('../src/server/durable-checkpoint');

const PROVIDERS = ['claude', 'codex'];
const NATIVE_ID_KINDS = { claude: 'session', codex: 'thread' };
const CLAIM_FIELDS = [
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding', 'identity', 'executionBinding',
];

function otherProvider(provider) {
  return provider === 'claude' ? 'codex' : 'claude';
}

function evidence(evidenceId, registrationRef = undefined) {
  return {
    evidenceId,
    source: 'authenticated-test-fixture',
    method: 'product-conformance-fixture',
    adapterVersion: 'fixture-adapter-1',
    runtimeVersion: 'fixture-runtime-1',
    ...(registrationRef === undefined ? {} : { registrationRef }),
    capabilities: ['native-binding'],
  };
}

function cloneBinding(period) {
  return { periodId: period.registration.executionId, actor: structuredClone(period.actor) };
}

function immutableClaims(record) {
  return Object.fromEntries(CLAIM_FIELDS.map((field) => [
    field,
    field === 'originBinding' || field === 'executionBinding' || field === 'identity'
      ? structuredClone(record[field])
      : record[field],
  ]));
}

function createProductHarness() {
  const registrationKernel = createRegistrationKernel();
  const registrationAdapters = Object.fromEntries(PROVIDERS.map((provider) => [
    provider,
    createProviderRegistrationAdapter(provider, registrationKernel.registry, registrationKernel.authority),
  ]));
  let periodSequence = 0;

  function registerPeriod(provider, suffix, role) {
    periodSequence += 1;
    const nativeIdentity = {
      nativeIdKind: NATIVE_ID_KINDS[provider],
      hostId: 'host-' + suffix,
      homeScopeId: 'home-' + suffix,
      nativeId: provider + '-native-' + suffix,
    };
    const identity = { provider, ...nativeIdentity };
    const startId = 'start-' + suffix;
    const registration = registrationAdapters[provider].register(
      nativeIdentity,
      evidence('period-evidence-' + suffix),
      {
        startId,
        ...(provider === 'claude' ? { projectionId: nativeIdentity.nativeId } : {}),
      },
    );
    return {
      provider,
      identity,
      nativeIdentity,
      registration,
      actor: role === 'execution'
        ? { kind: 'agent', id: 'agent-' + suffix }
        : { kind: 'tool-use', id: 'tool-use-' + suffix },
      contextId: 'context-' + suffix,
      role,
    };
  }

  const periods = [];
  const period = (provider, suffix, role) => {
    const value = registerPeriod(provider, suffix, role);
    periods.push(value);
    return value;
  };
  const owners = {};
  const children = {};
  for (const provider of PROVIDERS) {
    owners[provider] = period(otherProvider(provider), 'owner-for-' + provider, 'owner');
    children[provider] = period(provider, 'child-for-' + provider, 'execution');
  }

  const launchKernel = createLaunchBindingKernel({ registrationRegistry: registrationKernel.registry });
  const launchAdapters = Object.fromEntries(PROVIDERS.map((provider) => [
    provider,
    createProviderLaunchAdapter(provider, launchKernel.registry, launchKernel.authority),
  ]));
  const launches = {};

  for (const provider of PROVIDERS) {
    const child = children[provider];
    const owner = owners[provider];
    const claims = {
      launchId: 'launch-' + provider,
      runId: 'run-' + provider,
      attemptId: 'attempt-initial',
      provider,
      nativeIdKind: NATIVE_ID_KINDS[provider],
      hostId: child.identity.hostId,
      homeScopeId: child.identity.homeScopeId,
      origin: 'delegated',
      purpose: 'agent',
      originBinding: cloneBinding(owner),
    };
    const registered = launchAdapters[provider].registerLaunch(
      claims,
      evidence('launch-start-' + provider),
    );
    launchAdapters[provider].bindExecution(registered.launchRef, {
      identity: structuredClone(child.identity),
      executionBinding: cloneBinding(child),
      evidence: evidence('launch-binding-' + provider, registered.launchRef),
    });
    const record = launchKernel.registry.get(registered.launchRef);
    launches[provider] = {
      provider,
      launchRef: registered.launchRef,
      claims: immutableClaims(record),
      child,
      owner,
    };
  }

  const runtimeKernel = createRuntimeBindingKernel({
    registrationRegistry: registrationKernel.registry,
    launchRegistry: launchKernel.registry,
  });
  const runtimeAdapters = Object.fromEntries(PROVIDERS.map((provider) => [
    provider,
    createProviderRuntimeAdapter(provider, runtimeKernel.registry, runtimeKernel.authority),
  ]));
  const proofs = new Map();
  const pairs = new Map();

  function actorClaims(launch, subjectPeriod, isExecution) {
    return {
      identity: structuredClone(subjectPeriod.identity),
      periodId: subjectPeriod.registration.executionId,
      actor: structuredClone(subjectPeriod.actor),
      contextId: subjectPeriod.contextId,
      launchRef: isExecution ? launch.launchRef : null,
      immutableExecutionClaims: isExecution ? structuredClone(launch.claims) : null,
    };
  }

  function openActor(launch, subjectPeriod, label, isExecution) {
    const adapter = runtimeAdapters[subjectPeriod.provider];
    const connectionId = 'connection-' + label;
    const scope = {
      provider: subjectPeriod.identity.provider,
      nativeIdKind: subjectPeriod.identity.nativeIdKind,
      hostId: subjectPeriod.identity.hostId,
      homeScopeId: subjectPeriod.identity.homeScopeId,
      connectionSlotId: 'slot-' + subjectPeriod.registration.executionId + '-' + (isExecution ? 'execution' : 'owner'),
    };
    const opened = adapter.openConnection(scope, connectionId, evidence('connection-evidence-' + label));
    const claims = actorClaims(launch, subjectPeriod, isExecution);
    const attested = adapter.attestActor(
      opened.connectionHandle,
      claims,
      evidence('actor-evidence-' + label),
    );
    return {
      adapter,
      scope,
      connectionId,
      connectionHandle: opened.connectionHandle,
      connectionGeneration: opened.connectionGeneration,
      actorHandle: attested.actorHandle,
      actorClaims: claims,
      period: subjectPeriod,
    };
  }

  function openPair(launch, suffix) {
    const childActor = openActor(launch, launch.child, suffix + '-child', true);
    const ownerActor = openActor(launch, launch.owner, suffix + '-owner', false);
    return { childActor, ownerActor };
  }

  for (const provider of PROVIDERS) {
    runtimeAdapters[provider].adoptExecution(launches[provider].launchRef, structuredClone(launches[provider].claims));
    const pair = openPair(launches[provider], 'initial-' + provider);
    const proof = runtimeAdapters[provider].reconcileExecution(launches[provider].launchRef, {
      executionActorHandle: pair.childActor.actorHandle,
      ownerActorHandle: pair.ownerActor.actorHandle,
      expectedOwnerGeneration: 0,
    });
    pairs.set(provider, pair);
    proofs.set(launches[provider].launchRef, proof.proofHandle);
  }

  const proofChecks = [];
  const ownerChecks = [];
  const runtimeRegistry = {
    get(launchRef) {
      return runtimeKernel.registry.get(launchRef);
    },
    snapshot() {
      return runtimeKernel.registry.snapshot();
    },
    checkCurrentProof(launchRef, proofHandle) {
      const result = runtimeKernel.registry.checkCurrentProof(launchRef, proofHandle);
      proofChecks.push({ launchRef, ok: result.ok, reason: result.reason });
      return result;
    },
  };

  function verifyResultOwner(delivery) {
    ownerChecks.push(delivery.deliveryAttemptId);
    const current = runtimeKernel.registry.get(delivery.source.launchRef);
    const registration = registrationKernel.registry.snapshot();
    const runtime = runtimeKernel.registry.snapshot();
    const targetPeriod = registration.executions.find((item) => item.executionId === delivery.target.periodId);
    const targetConversation = targetPeriod &&
      registration.conversations.find((item) => item.conversationId === targetPeriod.conversationId);
    const expectedPeriod = periods.find((item) => item.registration.executionId === delivery.target.periodId);
    const ownerActors = runtime.actors.filter((item) => item.periodId === delivery.target.periodId &&
      item.state === 'active' && item.contextId === expectedPeriod?.contextId &&
      item.launchRef === null && JSON.stringify(item.actor) === JSON.stringify(delivery.target.actor) &&
      JSON.stringify(item.identity) === JSON.stringify(delivery.target.identity));
    const ownerActor = ownerActors.length === 1 ? ownerActors[0] : null;
    const ownerConnection = ownerActor && runtime.connections.find((item) =>
      item.connectionId === ownerActor.connectionId && item.generation === ownerActor.connectionGeneration &&
      item.state === 'active' && item.scope.provider === delivery.target.identity.provider &&
      item.scope.nativeIdKind === delivery.target.identity.nativeIdKind &&
      item.scope.hostId === delivery.target.identity.hostId &&
      item.scope.homeScopeId === delivery.target.identity.homeScopeId);
    return Boolean(current && current.currentOwner &&
      current.currentOwner.periodId === delivery.target.periodId &&
      current.ownerGeneration === delivery.ownerGeneration &&
      JSON.stringify(current.currentOwner.actor) === JSON.stringify(delivery.target.actor) &&
      targetPeriod && targetPeriod.state === 'active' &&
      targetConversation && JSON.stringify(targetConversation.identity) === JSON.stringify(delivery.target.identity) &&
      ownerActor && ownerConnection);
  }

  return {
    registrationKernel, registrationAdapters, periods, period, owners, children,
    launchKernel, launchAdapters, launches, runtimeKernel, runtimeAdapters,
    runtimeRegistry, proofs, pairs, proofChecks, ownerChecks, verifyResultOwner,
  };
}
function reconcileWithOwner(harness, launch, childActor, ownerActor, generation) {
  const proof = harness.runtimeAdapters[launch.provider].reconcileExecution(launch.launchRef, {
    executionActorHandle: childActor.actorHandle,
    ownerActorHandle: ownerActor.actorHandle,
    expectedOwnerGeneration: generation,
  });
  harness.proofs.set(launch.launchRef, proof.proofHandle);
  return proof;
}

function openFreshActor(harness, launch, subjectPeriod, label, isExecution) {
  const adapter = harness.runtimeAdapters[subjectPeriod.provider];
  const scope = {
    provider: subjectPeriod.identity.provider,
    nativeIdKind: subjectPeriod.identity.nativeIdKind,
    hostId: subjectPeriod.identity.hostId,
    homeScopeId: subjectPeriod.identity.homeScopeId,
    connectionSlotId: 'slot-' + subjectPeriod.registration.executionId + '-' +
      (isExecution ? 'execution' : 'owner'),
  };
  const opened = adapter.openConnection(scope, 'connection-' + label,
    evidence('connection-evidence-' + label));
  const claims = {
    identity: structuredClone(subjectPeriod.identity),
    periodId: subjectPeriod.registration.executionId,
    actor: structuredClone(subjectPeriod.actor),
    contextId: subjectPeriod.contextId,
    launchRef: isExecution ? launch.launchRef : null,
    immutableExecutionClaims: isExecution ? structuredClone(launch.claims) : null,
  };
  const attested = adapter.attestActor(opened.connectionHandle, claims, evidence('actor-evidence-' + label));
  return {
    adapter,
    connectionHandle: opened.connectionHandle,
    actorHandle: attested.actorHandle,
    period: subjectPeriod,
    actorClaims: claims,
  };
}

function refreshProof(harness, launch, suffix) {
  const prior = harness.pairs.get(launch.provider);
  harness.runtimeAdapters[launch.child.provider].disconnect(prior.childActor.connectionHandle);
  harness.runtimeAdapters[launch.owner.provider].disconnect(prior.ownerActor.connectionHandle);
  const pair = {
    childActor: openFreshActor(harness, launch, launch.child, suffix + '-child', true),
    ownerActor: openFreshActor(harness, launch, launch.owner, suffix + '-owner', false),
  };
  const generation = harness.runtimeAdapters[launch.provider].get(launch.launchRef).ownerGeneration;
  reconcileWithOwner(harness, launch, pair.childActor, pair.ownerActor, generation);
  harness.pairs.set(launch.provider, pair);
}

function disconnectCurrentPairs(harness) {
  for (const provider of PROVIDERS) {
    const pair = harness.pairs.get(provider);
    harness.runtimeAdapters[pair.childActor.period.provider].disconnect(pair.childActor.connectionHandle);
    harness.runtimeAdapters[pair.ownerActor.period.provider].disconnect(pair.ownerActor.connectionHandle);
  }
}

async function makeSandbox(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'durable-delivery-conformance-'));
  const pathFor = (name) => path.join(directory, name + '.json');
  const stores = [];
  t.after(async () => {
    for (const store of stores) await store.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    pathFor,
    async open(harness, name, options = {}) {
      const store = createDurableDeliveryStore({
        filePath: pathFor(name),
        registrationRegistry: harness.registrationKernel.registry,
        launchRegistry: harness.launchKernel.registry,
        runtimeRegistry: harness.runtimeRegistry,
        resolveProof: (launchRef) => harness.proofs.get(launchRef) || null,
        verifyResultOwner: (delivery) => harness.verifyResultOwner(delivery),
        ...options,
      });
      stores.push(store);
      await store.ready;
      const adapters = Object.fromEntries(PROVIDERS.map((provider) => [
        provider,
        createProviderDeliveryAdapter(provider, store),
      ]));
      return { store, adapters };
    },
  };
}

function deliveryInput(launchRef, suffix, payload) {
  return {
    launchRef,
    deliveryAttemptId: 'delivery-' + suffix,
    logicalMessageId: 'logical-' + suffix,
    revision: 1,
    payload,
  };
}

async function checkpoint(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function rejectsCode(promiseOrAction, code) {
  await assert.rejects(
    typeof promiseOrAction === 'function' ? promiseOrAction : Promise.resolve(promiseOrAction),
    (error) => error && error.code === code,
  );
}

function assertNoFixtureSecret(serialized, secrets) {
  for (const secret of secrets) assert.equal(serialized.includes(secret), false, 'checkpoint exposed fixture secret');
}

function assertWriterNotIssued(harness, launch) {
  const child = launch.child;
  const denied = harness.registrationAdapters[child.provider].authorizeWrite({
    token: launch.launchRef,
    identity: structuredClone(child.identity),
    contextId: child.contextId,
    executionId: child.registration.executionId,
  }, { ...child.identity, contextId: child.contextId });
  assert.notEqual(denied.status, 'accepted');
  assert.equal(typeof harness.runtimeKernel.authority.bindWriter, 'undefined');
}

test('ID-F05-A01: 両providerのproduct adapterはquestion/result/PRを実file storeへ保存し、payloadを公開しない', { timeout: 5000 }, async (t) => {
  for (const provider of PROVIDERS) {
    const harness = createProductHarness();
    const sandbox = await makeSandbox(t);
    const targetProvider = otherProvider(provider);
    const secrets = [
      'private-question-' + provider,
      'private-result-' + provider,
      'private-pr-body-' + provider,
      'fixture-token-' + provider,
    ];
    const filePath = sandbox.pathFor('create-' + provider);
    const { store, adapters } = await sandbox.open(harness, 'create-' + provider);
    const question = await adapters[provider].createQuestionDelivery(
      deliveryInput(harness.launches[provider].launchRef, 'question-' + provider, secrets[0]),
    );
    const result = await adapters[provider].createResultDelivery(
      deliveryInput(harness.launches[provider].launchRef, 'result-' + provider, secrets[1]),
    );
    const targetLaunch = harness.launches[targetProvider];
    const targetInput = { targetId: 'pr-target-' + provider, launchRef: targetLaunch.launchRef };
    await adapters[targetProvider].registerPrNotificationTarget(targetInput);
    await adapters[targetProvider].registerPrNotificationTarget(targetInput);
    const pr = await adapters[targetProvider].createPrNotification({
      sourceLaunchRef: harness.launches[provider].launchRef,
      targetId: targetInput.targetId,
      deliveryAttemptId: 'delivery-pr-' + provider,
      logicalMessageId: 'logical-pr-' + provider,
      revision: 1,
      payload: secrets[2],
    });
    assert.equal((await adapters[targetProvider].get(pr.deliveryAttemptId)).target.launchRef, targetLaunch.launchRef);
    assert.equal((await adapters[provider].get(question.deliveryAttemptId)).target.launchRef,
      harness.launches[provider].launchRef);
    assert.equal((await adapters[provider].get(result.deliveryAttemptId)).target.periodId,
      harness.launches[provider].owner.registration.executionId);
    const beforeWrongProvider = {
      file: await fs.readFile(filePath, 'utf8'),
      ledger: await store.snapshot(),
      registrations: harness.registrationKernel.registry.snapshot(),
      launches: harness.launchKernel.registry.snapshot(),
      runtime: harness.runtimeKernel.registry.snapshot(),
    };
    await rejectsCode(adapters[provider].createPrNotification({
      sourceLaunchRef: harness.launches[provider].launchRef,
      targetId: targetInput.targetId,
      deliveryAttemptId: 'wrong-provider-pr-' + provider,
      logicalMessageId: 'wrong-provider-logical-' + provider,
      revision: 1,
      payload: 'must not save',
    }), 'provider_mismatch');
    assert.equal(await adapters[provider].get(pr.deliveryAttemptId), null);
    await rejectsCode(adapters[provider].claim(pr.deliveryAttemptId), 'provider_mismatch');
    await rejectsCode(adapters[provider].cancel(pr.deliveryAttemptId), 'provider_mismatch');
    await rejectsCode(adapters[provider].supersedeUnsentDelivery(pr.deliveryAttemptId), 'provider_mismatch');
    let wrongProviderSinkCalls = 0;
    await rejectsCode(adapters[provider].sendStart(pr.deliveryAttemptId, () => { wrongProviderSinkCalls += 1; }),
      'provider_mismatch');
    await rejectsCode(adapters[provider].recordAccepted(pr.deliveryAttemptId, correlationFor(pr, null, null)),
      'provider_mismatch');
    await rejectsCode(adapters[provider].recordApplied(pr.deliveryAttemptId,
      correlationFor(pr, 'wrong-provider-turn', 'wrong-provider-item')), 'provider_mismatch');
    await rejectsCode(adapters[provider].markUnknown(pr.deliveryAttemptId), 'provider_mismatch');
    await rejectsCode(adapters[provider].rehydratePayload(pr.deliveryAttemptId, 'must not restore'),
      'provider_mismatch');
    assert.equal(wrongProviderSinkCalls, 0);
    assert.deepEqual(await store.snapshot(), beforeWrongProvider.ledger);
    assert.equal(await fs.readFile(filePath, 'utf8'), beforeWrongProvider.file);
    assert.deepEqual(harness.registrationKernel.registry.snapshot(), beforeWrongProvider.registrations);
    assert.deepEqual(harness.launchKernel.registry.snapshot(), beforeWrongProvider.launches);
    assert.deepEqual(harness.runtimeKernel.registry.snapshot(), beforeWrongProvider.runtime);
    assert.equal((await store.snapshot()).notificationTargets.length, 1);
    const text = JSON.stringify(await checkpoint(filePath));
    assertNoFixtureSecret(text, secrets);
    for (const record of [question, result, pr]) {
      assert.equal(Object.hasOwn(record, 'payload'), false);
      assert.match(record.payloadDigest, /^[0-9a-f]{64}$/);
    }
    assertWriterNotIssued(harness, harness.launches[provider]);
    assert.deepEqual(harness.proofChecks, []);
  }
});

function makeAtomicWriteGate() {
  let armed = false;
  let startedResolve;
  let releaseResolve;
  let started;
  let released;
  return {
    atomicWrite: async (target, value) => {
      if (armed) {
        armed = false;
        startedResolve();
        await released;
      }
      await atomicWriteJson(path.dirname(target), path.basename(target), value);
    },
    arm() {
      armed = true;
      started = new Promise((resolve) => { startedResolve = resolve; });
      released = new Promise((resolve) => { releaseResolve = resolve; });
    },
    waitUntilStarted() { return started; },
    release() { releaseResolve(); },
  };
}

test('ID-F05-A02:取消先行では送信せず、send-start先行では一度だけ送って取消要求を保持する', { timeout: 5000 }, async (t) => {
  for (const provider of PROVIDERS) {
    const harness = createProductHarness();
    const sandbox = await makeSandbox(t);
    const { adapters } = await sandbox.open(harness, 'race-' + provider);
    const adapter = adapters[provider];
    let sinkCalls = 0;
    const cancelledFirst = await adapter.createQuestionDelivery(
      deliveryInput(harness.launches[provider].launchRef, 'cancel-first-' + provider, 'question cancel first'),
    );
    const cancelFirst = adapter.cancel(cancelledFirst.deliveryAttemptId);
    const sendAfterCancel = adapter.sendStart(cancelledFirst.deliveryAttemptId, () => { sinkCalls += 1; });
    assert.equal((await cancelFirst).state, 'cancelled_before_send');
    await assert.rejects(sendAfterCancel);
    assert.equal((await adapter.get(cancelledFirst.deliveryAttemptId)).state, 'cancelled_before_send');
    assert.equal(sinkCalls, 0);

    const sentFirst = await adapter.createQuestionDelivery(
      deliveryInput(harness.launches[provider].launchRef, 'send-first-' + provider, 'question send first'),
    );
    await adapter.claim(sentFirst.deliveryAttemptId);
    const send = adapter.sendStart(sentFirst.deliveryAttemptId, (payload, metadata) => {
      sinkCalls += 1;
      assert.equal(payload, 'question send first');
      assert.equal(Object.isFrozen(metadata), true);
      assert.equal(Object.hasOwn(metadata, 'payload'), false);
    });
    const cancel = adapter.cancel(sentFirst.deliveryAttemptId);
    assert.equal((await send).state, 'sending');
    const requested = await cancel;
    assert.equal(requested.state, 'sending');
    assert.equal(requested.cancelRequested, true);
    await rejectsCode(adapter.sendStart(sentFirst.deliveryAttemptId, () => { sinkCalls += 1; }), 'payload_unavailable');
    assert.equal(sinkCalls, 1);
  }
});

test('ID-F05-A03:send-start checkpoint失敗では直前fileと公開状態を保ちpayloadを送らない', { timeout: 5000 }, async (t) => {
  for (const provider of PROVIDERS) {
    const harness = createProductHarness();
    const sandbox = await makeSandbox(t);
    let failNextWrite = false;
    const atomicWrite = async (target, value) => {
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('fixture write failure');
      }
      await atomicWriteJson(path.dirname(target), path.basename(target), value);
    };
    const filePath = sandbox.pathFor('failed-send-' + provider);
    const { store, adapters } = await sandbox.open(harness, 'failed-send-' + provider, { atomicWrite });
    const adapter = adapters[provider];
    const delivery = await adapter.createQuestionDelivery(
      deliveryInput(harness.launches[provider].launchRef, 'failed-send-' + provider, 'private-send-payload-' + provider),
    );
    const fileBefore = await fs.readFile(filePath, 'utf8');
    const registrationsBefore = structuredClone(harness.registrationKernel.registry.snapshot());
    const launchesBefore = structuredClone(harness.launchKernel.registry.snapshot());
    const runtimeBefore = structuredClone(harness.runtimeKernel.registry.snapshot());
    let sinkCalls = 0;
    failNextWrite = true;
    await rejectsCode(adapter.sendStart(delivery.deliveryAttemptId, () => { sinkCalls += 1; }), 'checkpoint_write_failed');
    assert.equal(sinkCalls, 0);
    assert.equal(await fs.readFile(filePath, 'utf8'), fileBefore);
    assert.equal((await store.get(delivery.deliveryAttemptId)).state, 'available');
    assert.equal((await adapter.get(delivery.deliveryAttemptId)).state, 'available');
    assert.deepEqual(harness.registrationKernel.registry.snapshot(), registrationsBefore);
    assert.deepEqual(harness.launchKernel.registry.snapshot(), launchesBefore);
    assert.deepEqual(harness.runtimeKernel.registry.snapshot(), runtimeBefore);
    assertWriterNotIssued(harness, harness.launches[provider]);
  }
});

test('ID-F05-A04:送信保存中の子またはowner接続失効は保存後再照合でunknownとなり送信しない', { timeout: 5000 }, async (t) => {
  for (const provider of PROVIDERS) {
    const harness = createProductHarness();
    const sandbox = await makeSandbox(t);
    const gate = makeAtomicWriteGate();
    const { store, adapters } = await sandbox.open(harness, 'proof-expiry-' + provider,
      { atomicWrite: gate.atomicWrite });
    const adapter = adapters[provider];
    const launch = harness.launches[provider];
    const child = harness.pairs.get(provider).childActor;
    const owner = harness.pairs.get(provider).ownerActor;
    const periodCount = harness.registrationKernel.registry.snapshot().executions.length;
    const question = await adapter.createQuestionDelivery(
      deliveryInput(launch.launchRef, 'proof-expiry-question-' + provider, 'private-proof-question'),
    );
    let questionSinkCalls = 0;
    gate.arm();
    const questionSend = adapter.sendStart(question.deliveryAttemptId, () => { questionSinkCalls += 1; });
    await gate.waitUntilStarted();
    assert.equal(harness.runtimeAdapters[child.period.provider].disconnect(child.connectionHandle), true);
    gate.release();
    assert.equal((await questionSend).state, 'unknown');
    assert.equal(questionSinkCalls, 0);
    assert.equal(harness.proofChecks.at(-1).ok, false);

    const result = await adapter.createResultDelivery(
      deliveryInput(launch.launchRef, 'proof-expiry-result-' + provider, 'private-proof-result'),
    );
    let resultSinkCalls = 0;
    gate.arm();
    const resultSend = adapter.sendStart(result.deliveryAttemptId, () => { resultSinkCalls += 1; });
    await gate.waitUntilStarted();
    assert.equal(harness.runtimeAdapters[owner.period.provider].disconnect(owner.connectionHandle), true);
    gate.release();
    assert.equal((await resultSend).state, 'unknown');
    assert.equal(resultSinkCalls, 0);
    assert.ok(harness.ownerChecks.includes(result.deliveryAttemptId));
    assert.equal((await store.get(result.deliveryAttemptId)).state, 'unknown');
    assert.equal(harness.registrationKernel.registry.snapshot().executions.length, periodCount);
    assertWriterNotIssued(harness, launch);
  }
});

function handoffAndReconcile(harness, launch, newOwnerPeriod, suffix) {
  const adapter = harness.runtimeAdapters[launch.provider];
  const priorPair = harness.pairs.get(launch.provider);
  const priorProof = harness.proofs.get(launch.launchRef);
  const current = adapter.get(launch.launchRef);
  const candidateOwner = openFreshActor(harness, launch, newOwnerPeriod, suffix + '-handoff-owner', false);
  const newOwner = { periodId: newOwnerPeriod.registration.executionId, actor: structuredClone(newOwnerPeriod.actor) };
  const receipt = adapter.handoff(launch.launchRef, {
    handoffId: 'handoff-' + suffix,
    expectedOwner: structuredClone(current.currentOwner),
    expectedOwnerGeneration: current.ownerGeneration,
    newOwner,
    newOwnerGeneration: current.ownerGeneration + 1,
    immutableExecutionClaims: structuredClone(launch.claims),
    evidence: evidence('handoff-evidence-' + suffix),
  }, candidateOwner.actorHandle);
  assert.equal(adapter.checkCurrentProof(launch.launchRef, priorProof).ok, false);
  adapter.disconnect(priorPair.childActor.connectionHandle);
  harness.runtimeAdapters[priorPair.ownerActor.period.provider].disconnect(priorPair.ownerActor.connectionHandle);
  adapter.disconnect(candidateOwner.connectionHandle);
  const pair = {
    childActor: openFreshActor(harness, launch, launch.child, suffix + '-fresh-child', true),
    ownerActor: openFreshActor(harness, launch, newOwnerPeriod, suffix + '-fresh-owner', false),
  };
  const proof = adapter.reconcileExecution(launch.launchRef, {
    executionActorHandle: pair.childActor.actorHandle,
    ownerActorHandle: pair.ownerActor.actorHandle,
    expectedOwnerGeneration: receipt.ownerGeneration,
  });
  harness.pairs.set(launch.provider, pair);
  harness.proofs.set(launch.launchRef, proof.proofHandle);
  return { receipt, pair, proof: proof.proofHandle };
}

test('ID-F05-A05:handoff後のquestion/PRは同じ子targetへ送り、終了子のresultは別providerのactive ownerへ送る', { timeout: 5000 }, async (t) => {
  for (const provider of PROVIDERS) {
    const harness = createProductHarness();
    const sandbox = await makeSandbox(t);
    const { store, adapters } = await sandbox.open(harness, 'handoff-' + provider);
    const creator = harness.launches[provider];
    const targetProvider = otherProvider(provider);
    const prTarget = harness.launches[targetProvider];
    const targetId = 'handoff-target-' + provider;
    await adapters[targetProvider].registerPrNotificationTarget({ targetId, launchRef: prTarget.launchRef });
    const q = await adapters[provider].createQuestionDelivery(
      deliveryInput(creator.launchRef, 'handoff-question-' + provider, 'handoff question body'),
    );
    const pr = await adapters[targetProvider].createPrNotification({
      sourceLaunchRef: creator.launchRef,
      targetId,
      deliveryAttemptId: 'handoff-pr-' + provider,
      logicalMessageId: 'handoff-pr-logical-' + provider,
      revision: 1,
      payload: 'handoff PR body',
    });
    const historicalInput = deliveryInput(creator.launchRef, 'historical-result-' + provider, 'historical result body');
    const historical = await adapters[provider].createResultDelivery(historicalInput);
    const savedHistoricalTarget = structuredClone(historical.target);
    const savedQuestionTarget = structuredClone(q.target);
    const savedPrTarget = structuredClone(pr.target);

    const sourceNewOwner = harness.period(targetProvider, 'handoff-owner-source-' + provider, 'owner');
    const targetNewOwner = harness.period(provider, 'handoff-owner-target-' + provider, 'owner');
    handoffAndReconcile(harness, creator, sourceNewOwner, 'source-' + provider);
    handoffAndReconcile(harness, prTarget, targetNewOwner, 'target-' + provider);

    const replay = await adapters[provider].createResultDelivery(historicalInput);
    assert.deepEqual(replay.target, savedHistoricalTarget);
    assert.equal(replay.ownerGeneration, 0);
    const qSent = await adapters[provider].sendStart(q.deliveryAttemptId, () => {});
    const prSent = await adapters[targetProvider].sendStart(pr.deliveryAttemptId, () => {});
    assert.equal(qSent.target.launchRef, creator.launchRef);
    assert.deepEqual(qSent.target, savedQuestionTarget);
    assert.equal(prSent.target.launchRef, prTarget.launchRef);
    assert.deepEqual(prSent.target, savedPrTarget);

    const endedChild = harness.pairs.get(provider).childActor;
    assert.equal(harness.runtimeAdapters[provider].endActor(endedChild.actorHandle), true);
    const ownerResult = await adapters[provider].createResultDelivery(
      deliveryInput(creator.launchRef, 'ended-child-result-' + provider, 'cross-provider result body'),
    );
    assert.equal(ownerResult.target.identity.provider, targetProvider);
    assert.equal(ownerResult.target.periodId, sourceNewOwner.registration.executionId);
    assert.equal(ownerResult.ownerGeneration, 1);
    const sent = await adapters[provider].sendStart(ownerResult.deliveryAttemptId, (payload) => {
      assert.equal(payload, 'cross-provider result body');
    });
    assert.equal(sent.state, 'sending');
    assert.ok(harness.ownerChecks.includes(ownerResult.deliveryAttemptId));

    const checkpointValue = await checkpoint(sandbox.pathFor('handoff-' + provider));
    const runtimeLaunch = checkpointValue.registrations.runtimeLaunches.find((item) => item.launchRef === creator.launchRef);
    const immutableLaunch = checkpointValue.registrations.launches.find((item) => item.launchRef === creator.launchRef);
    assert.equal(runtimeLaunch.ownerGeneration, 1);
    assert.equal(runtimeLaunch.currentOwner.periodId, sourceNewOwner.registration.executionId);
    assert.deepEqual(immutableLaunch.claims, Object.fromEntries(CLAIM_FIELDS.slice(0, 10).map((field) => [field, creator.claims[field]])));
    assert.deepEqual(immutableLaunch.identity, creator.claims.identity);
    assert.deepEqual(immutableLaunch.executionBinding, creator.claims.executionBinding);
    assert.equal(Object.hasOwn(runtimeLaunch, 'currentProof'), false);
    assert.ok(checkpointValue.registrations.handoffs.some((item) => item.handoffId === 'handoff-source-' + provider));
    assert.equal(checkpointValue.registrations.actors.some((item) =>
      item.periodId === endedChild.period.registration.executionId && item.state === 'ended'), true);
    assert.equal(JSON.stringify(checkpointValue).includes('cross-provider result body'), false);
    assertWriterNotIssued(harness, creator);
    for (const providerKey of PROVIDERS) {
      const currentPair = harness.pairs.get(providerKey);
      assert.equal(harness.runtimeAdapters[currentPair.childActor.period.provider].disconnect(
        currentPair.childActor.connectionHandle), true);
      assert.equal(harness.runtimeAdapters[currentPair.ownerActor.period.provider].disconnect(
        currentPair.ownerActor.connectionHandle), true);
    }

    await store.close();
    const reopened = await sandbox.open(harness, 'handoff-' + provider);
    const restored = await reopened.store.captureRegistrations();
    const restoredRuntime = restored.runtimeLaunches.find((item) => item.launchRef === creator.launchRef);
    assert.equal(restoredRuntime.ownerGeneration, 1);
    assert.equal(restoredRuntime.currentOwner.periodId, sourceNewOwner.registration.executionId);
    assert.equal(Object.hasOwn(restoredRuntime, 'currentProof'), false);
  }
});

function correlationFor(delivery, nativeTurnId, nativeItemId) {
  return {
    deliveryAttemptId: delivery.deliveryAttemptId,
    revision: delivery.revision,
    payloadDigest: delivery.payloadDigest,
    targetPeriodId: delivery.target.periodId,
    nativeTurnId,
    nativeItemId,
    clientRequestId: delivery.deliveryAttemptId,
  };
}

test('ID-F06-A01:sendingは再openでunknownとなりpayloadなしで再送せず同key別attemptを拒む', { timeout: 5000 }, async (t) => {
  for (const provider of PROVIDERS) {
    const harness = createProductHarness();
    const sandbox = await makeSandbox(t);
    const launch = harness.launches[provider];
    const name = 'restart-sending-' + provider;
    const attemptId = 'delivery-restart-sending-' + provider;
    let injectedAfterSendingSave = false;
    const { store, adapters } = await sandbox.open(harness, name, {
      atomicWrite: async (target, value) => {
        await atomicWriteJson(path.dirname(target), path.basename(target), value);
        const savedDelivery = value.ledger.deliveries.find((item) => item.deliveryAttemptId === attemptId);
        if (!injectedAfterSendingSave && savedDelivery?.state === 'sending') {
          injectedAfterSendingSave = true;
          throw new Error('injected post-save failure');
        }
      },
    });
    const adapter = adapters[provider];
    const input = {
      ...deliveryInput(launch.launchRef, 'restart-sending-' + provider, 'private restart payload'),
      deliveryAttemptId: attemptId,
    };
    const delivery = await adapter.createQuestionDelivery(input);
    let sinkCalls = 0;
    await rejectsCode(adapter.sendStart(delivery.deliveryAttemptId, () => { sinkCalls += 1; }),
      'checkpoint_write_failed');
    assert.equal(injectedAfterSendingSave, true);
    assert.equal(sinkCalls, 0);
    const filePath = sandbox.pathFor(name);
    const sendingCheckpoint = await checkpoint(filePath);
    assert.equal(sendingCheckpoint.ledger.deliveries.find((item) =>
      item.deliveryAttemptId === delivery.deliveryAttemptId).state, 'sending');
    const sendingBytes = await fs.readFile(filePath, 'utf8');
    await rejectsCode(adapter.claim(delivery.deliveryAttemptId), 'store_writer_blocked');
    assert.equal(await fs.readFile(filePath, 'utf8'), sendingBytes);
    disconnectCurrentPairs(harness);
    await store.close();

    const reopened = await sandbox.open(harness, name);
    await reopened.store.captureRegistrations();
    const recovered = await reopened.adapters[provider].get(delivery.deliveryAttemptId);
    assert.equal(recovered.state, 'unknown');
    assert.equal(Object.hasOwn(recovered, 'payload'), false);
    await rejectsCode(reopened.adapters[provider].sendStart(delivery.deliveryAttemptId, () => { sinkCalls += 1; }),
      'payload_unavailable');
    await rejectsCode(reopened.adapters[provider].createQuestionDelivery({
      ...input,
      deliveryAttemptId: 'restart-sending-next-' + provider,
    }), 'logical_conflict');
    assert.equal(sinkCalls, 0);
    assert.equal((await reopened.adapters[provider].get(delivery.deliveryAttemptId)).state, 'unknown');
    assertWriterNotIssued(harness, launch);
  }
});

test('ID-F06-A02:再open後acceptedはunknown、applied/cancelledとended actorは終端を保つ', { timeout: 5000 }, async (t) => {
  for (const provider of PROVIDERS) {
    const harness = createProductHarness();
    const sandbox = await makeSandbox(t);
    const launch = harness.launches[provider];
    const name = 'restart-states-' + provider;
    const { store, adapters } = await sandbox.open(harness, name);
    const adapter = adapters[provider];
    const accepted = await adapter.createQuestionDelivery(
      deliveryInput(launch.launchRef, 'accepted-' + provider, 'accepted payload'),
    );
    const applied = await adapter.createQuestionDelivery(
      deliveryInput(launch.launchRef, 'applied-' + provider, 'applied payload'),
    );
    const cancelled = await adapter.createQuestionDelivery(
      deliveryInput(launch.launchRef, 'cancelled-' + provider, 'cancelled payload'),
    );
    let sinkCalls = 0;
    await adapter.sendStart(accepted.deliveryAttemptId, () => { sinkCalls += 1; });
    await adapter.recordAccepted(accepted.deliveryAttemptId,
      correlationFor(accepted, 'accepted-turn-' + provider, null));
    await adapter.sendStart(applied.deliveryAttemptId, () => { sinkCalls += 1; });
    await adapter.recordApplied(applied.deliveryAttemptId,
      correlationFor(applied, 'applied-turn-' + provider, 'applied-item-' + provider));
    assert.equal((await adapter.cancel(cancelled.deliveryAttemptId)).state, 'cancelled_before_send');
    const endedChild = harness.pairs.get(provider).childActor;
    assert.equal(harness.runtimeAdapters[provider].endActor(endedChild.actorHandle), true);
    await store.captureRegistrations();
    assert.equal(sinkCalls, 2);
    assert.equal(harness.runtimeKernel.registry.get(launch.launchRef).currentProof, null);
    await store.close();

    const reopened = await sandbox.open(harness, name);
    assert.equal((await reopened.adapters[provider].get(accepted.deliveryAttemptId)).state, 'unknown');
    assert.equal((await reopened.adapters[provider].get(applied.deliveryAttemptId)).state, 'applied');
    assert.equal((await reopened.adapters[provider].get(cancelled.deliveryAttemptId)).state, 'cancelled_before_send');
    assert.equal(Object.hasOwn(await reopened.adapters[provider].get(applied.deliveryAttemptId), 'payload'), false);
    const saved = await checkpoint(sandbox.pathFor(name));
    assert.equal(saved.registrations.actors.some((item) =>
      item.periodId === endedChild.period.registration.executionId && item.state === 'ended'), true);
    assert.equal(sinkCalls, 2);
    assertWriterNotIssued(harness, launch);
  }
});

test('ID-F06-A03:未送信payloadはdigest一致だけでは復元されずfresh proof後に一度だけ送る', { timeout: 5000 }, async (t) => {
  for (const provider of PROVIDERS) {
    const harness = createProductHarness();
    const sandbox = await makeSandbox(t);
    const launch = harness.launches[provider];
    const name = 'rehydrate-' + provider;
    const payload = 'private rehydrated payload ' + provider;
    const { store, adapters } = await sandbox.open(harness, name);
    const adapter = adapters[provider];
    const delivery = await adapter.createQuestionDelivery(
      deliveryInput(launch.launchRef, 'rehydrate-' + provider, payload),
    );
    await adapter.claim(delivery.deliveryAttemptId);
    disconnectCurrentPairs(harness);
    await store.captureRegistrations();
    await store.close();

    const reopened = await sandbox.open(harness, name);
    const restoredAdapter = reopened.adapters[provider];
    const filePath = sandbox.pathFor(name);
    await reopened.store.captureRegistrations();
    const savedBefore = await fs.readFile(filePath, 'utf8');
    const ledgerBefore = await restoredAdapter.snapshot();
    let sinkCalls = 0;
    await rejectsCode(restoredAdapter.rehydratePayload(delivery.deliveryAttemptId, payload + ' changed'),
      'payload_digest_mismatch');
    assert.deepEqual(await restoredAdapter.snapshot(), ledgerBefore);
    assert.equal(await fs.readFile(filePath, 'utf8'), savedBefore);
    await rejectsCode(restoredAdapter.rehydratePayload(delivery.deliveryAttemptId, payload),
      'delivery_target_unavailable');
    assert.deepEqual(await restoredAdapter.snapshot(), ledgerBefore);
    assert.equal(await fs.readFile(filePath, 'utf8'), savedBefore);
    await rejectsCode(restoredAdapter.sendStart(delivery.deliveryAttemptId, () => { sinkCalls += 1; }),
      'payload_unavailable');
    assert.equal(sinkCalls, 0);

    refreshProof(harness, launch, 'rehydrate-fresh-' + provider);
    await restoredAdapter.rehydratePayload(delivery.deliveryAttemptId, payload);
    assert.equal((await restoredAdapter.sendStart(delivery.deliveryAttemptId, () => { sinkCalls += 1; })).state,
      'sending');
    assert.equal(sinkCalls, 1);
    assert.equal((await restoredAdapter.get(delivery.deliveryAttemptId)).state, 'sending');
    assert.equal((await checkpoint(filePath)).ledger.deliveries[0].payloadDigest, delivery.payloadDigest);
    assert.equal((await fs.readFile(filePath, 'utf8')).includes(payload), false);
    assert.ok(harness.proofChecks.some((check) => check.launchRef === launch.launchRef));
    assertWriterNotIssued(harness, launch);
  }
});

test('ID-F06-A04:相関不一致とnative item再利用は保存を変えず、遅延適用は取消要求を保つ', { timeout: 5000 }, async (t) => {
  for (const provider of PROVIDERS) {
    const harness = createProductHarness();
    const sandbox = await makeSandbox(t);
    const launch = harness.launches[provider];
    const name = 'correlation-' + provider;
    const filePath = sandbox.pathFor(name);
    const { store, adapters } = await sandbox.open(harness, name);
    const adapter = adapters[provider];
    const first = await adapter.createQuestionDelivery(
      deliveryInput(launch.launchRef, 'correlation-first-' + provider, 'correlation payload'),
    );
    await adapter.sendStart(first.deliveryAttemptId, () => {});
    const valid = correlationFor(first, null, null);
    const wrongPeriodId = harness.children[otherProvider(provider)].registration.executionId;
    const mutations = [
      (value) => { value.deliveryAttemptId += '-other'; },
      (value) => { value.revision += 1; },
      (value) => { value.payloadDigest = 'a'.repeat(64); },
      (value) => { value.targetPeriodId = wrongPeriodId; },
      (value) => { value.clientRequestId = 'unfixed-request'; },
    ];
    for (const mutate of mutations) {
      const beforeLedger = await adapter.snapshot();
      const beforeFile = await fs.readFile(filePath, 'utf8');
      const invalid = structuredClone(valid);
      mutate(invalid);
      await rejectsCode(adapter.recordAccepted(first.deliveryAttemptId, invalid), 'correlation_mismatch');
      assert.deepEqual(await adapter.snapshot(), beforeLedger);
      assert.equal(await fs.readFile(filePath, 'utf8'), beforeFile);
    }

    await adapter.recordAccepted(first.deliveryAttemptId, correlationFor(first, 'turn-' + provider, null));
    await adapter.recordApplied(first.deliveryAttemptId,
      correlationFor(first, 'turn-' + provider, 'item-unique-' + provider));
    assert.equal((await adapter.get(first.deliveryAttemptId)).state, 'applied');

    const duplicate = await adapter.createQuestionDelivery(
      deliveryInput(launch.launchRef, 'correlation-duplicate-' + provider, 'second payload'),
    );
    await adapter.sendStart(duplicate.deliveryAttemptId, () => {});
    const beforeReuseLedger = await adapter.snapshot();
    const beforeReuseFile = await fs.readFile(filePath, 'utf8');
    await rejectsCode(adapter.recordApplied(duplicate.deliveryAttemptId,
      correlationFor(duplicate, 'turn-' + provider, 'item-unique-' + provider)), 'correlation_reused');
    assert.deepEqual(await adapter.snapshot(), beforeReuseLedger);
    assert.equal(await fs.readFile(filePath, 'utf8'), beforeReuseFile);

    const late = await adapter.createQuestionDelivery(
      deliveryInput(launch.launchRef, 'correlation-late-' + provider, 'late payload'),
    );
    await adapter.sendStart(late.deliveryAttemptId, () => {});
    assert.equal((await adapter.cancel(late.deliveryAttemptId)).cancelRequested, true);
    const applied = await adapter.recordApplied(late.deliveryAttemptId,
      correlationFor(late, 'late-turn-' + provider, 'late-item-' + provider));
    assert.equal(applied.state, 'applied');
    assert.equal(applied.cancelRequested, true);
    assertWriterNotIssued(harness, launch);
    await store.close();
  }
});

test('ID-F11-A03:容量上限で新規登録を拒み既存証拠を保存する', { timeout: 5000 }, async (t) => {
  for (const provider of PROVIDERS) {
    const harness = createProductHarness();
    const sandbox = await makeSandbox(t);
    const launch = harness.launches[provider];
    const name = 'capacity-reservation-' + provider;
    const filePath = sandbox.pathFor(name);
    const initial = await sandbox.open(harness, name);
    const adapter = initial.adapters[provider];
    const delivery = await adapter.createQuestionDelivery(
      deliveryInput(launch.launchRef, 'capacity-reservation-' + provider, 'capacity payload'),
    );
    let sinkCalls = 0;
    assert.equal((await adapter.sendStart(delivery.deliveryAttemptId, () => { sinkCalls += 1; })).state, 'sending');
    assert.equal(sinkCalls, 1);
    disconnectCurrentPairs(harness);
    await initial.store.captureRegistrations();
    await initial.store.close();

    const initialBytes = await fs.readFile(filePath, 'utf8');
    const maximumBytes = 16 * 1024 * 1024;
    const openAtLimit = (maxBytes) => sandbox.open(harness, name, { limits: { maxBytes } });
    const maximumProbe = await openAtLimit(maximumBytes);
    await maximumProbe.store.close();
    let lower = Buffer.byteLength(initialBytes, 'utf8') - 1;
    let upper = maximumBytes;
    while (upper - lower > 1) {
      const candidate = Math.floor((lower + upper) / 2);
      try {
        const probe = await openAtLimit(candidate);
        await probe.store.close();
        upper = candidate;
      } catch (error) {
        assert.ok(['checkpoint_too_large', 'checkpoint_capacity_reserved'].includes(error.code),
          'unexpected limit-probe failure: ' + error.code);
        lower = candidate;
      }
    }

    const limited = await openAtLimit(upper);
    const limitedAdapter = limited.adapters[provider];
    const beforeRejectedCreate = await limitedAdapter.snapshot();
    const beforeRejectedBytes = await fs.readFile(filePath, 'utf8');
    await rejectsCode(limitedAdapter.createQuestionDelivery(
      deliveryInput(launch.launchRef, 'capacity-reservation-extra-' + provider, 'must remain private'),
    ), 'checkpoint_capacity_reserved');
    assert.deepEqual(await limitedAdapter.snapshot(), beforeRejectedCreate);
    assert.equal(await fs.readFile(filePath, 'utf8'), beforeRejectedBytes);

    const escapedNativeId = '\uD800'.repeat(512);
    const applied = await limitedAdapter.recordApplied(delivery.deliveryAttemptId,
      correlationFor(delivery, escapedNativeId, escapedNativeId));
    assert.equal(applied.state, 'applied');
    assert.ok(Buffer.byteLength(await fs.readFile(filePath, 'utf8'), 'utf8') <= upper);
    const lateAccepted = await limitedAdapter.recordAccepted(delivery.deliveryAttemptId,
      correlationFor(delivery, escapedNativeId, escapedNativeId));
    assert.equal(lateAccepted.state, 'applied');
    assert.equal(lateAccepted.acceptedCorrelation.nativeTurnId, escapedNativeId);
    assert.equal(lateAccepted.acceptedCorrelation.nativeItemId, escapedNativeId);
    const cancelled = await limitedAdapter.cancel(delivery.deliveryAttemptId);
    assert.equal(cancelled.cancelRequested, true);
    assert.ok(Buffer.byteLength(await fs.readFile(filePath, 'utf8'), 'utf8') <= upper);
    assert.equal(sinkCalls, 1);
    await limited.store.close();

    const reopened = await openAtLimit(upper);
    const recovered = await reopened.adapters[provider].get(delivery.deliveryAttemptId);
    assert.equal(recovered.state, 'applied');
    assert.equal(recovered.cancelRequested, true);
    assert.equal(recovered.acceptedCorrelation.nativeTurnId, escapedNativeId);
    const replayedAccepted = await reopened.adapters[provider].recordAccepted(delivery.deliveryAttemptId,
      correlationFor(delivery, escapedNativeId, escapedNativeId));
    assert.equal(replayedAccepted.state, 'applied');
    assert.equal((await reopened.adapters[provider].cancel(delivery.deliveryAttemptId)).cancelRequested, true);
    assert.ok(Buffer.byteLength(await fs.readFile(filePath, 'utf8'), 'utf8') <= upper);
    assert.equal(sinkCalls, 1);
    assertWriterNotIssued(harness, launch);
    await reopened.store.close();
  }
});

test('ID-F11-A01:壊れたbinding、未知key・version、容量超過は既存checkpointを保持する', { timeout: 5000 }, async (t) => {
  for (const provider of PROVIDERS) {
    const harness = createProductHarness();
    const sandbox = await makeSandbox(t);
    const launch = harness.launches[provider];
    const name = 'checkpoint-validation-' + provider;
    const filePath = sandbox.pathFor(name);
    const { store, adapters } = await sandbox.open(harness, name);
    await adapters[provider].createQuestionDelivery(
      deliveryInput(launch.launchRef, 'checkpoint-validation-' + provider, 'private checkpoint payload'),
    );
    await store.captureRegistrations();
    await store.close();
    const originalBytes = await fs.readFile(filePath, 'utf8');
    const original = JSON.parse(originalBytes);
    const beforeSnapshots = {
      registrations: harness.registrationKernel.registry.snapshot(),
      launches: harness.launchKernel.registry.snapshot(),
      runtime: harness.runtimeKernel.registry.snapshot(),
    };

    let validationWriterCalls = 0;
    const checkpointStore = createDurableCheckpointStore({ filePath, atomicWrite: async () => {
      validationWriterCalls += 1;
    } });
    const invalidCases = [
      [
        (candidate) => { candidate.registrations.runtimeLaunches[0].claims.executionBinding.actor.id += '-changed'; },
        'checkpoint_runtime_launch_mismatch',
      ],
      [(candidate) => { candidate.unexpectedSecret = 'must-not-save'; }, 'invalid_checkpoint_version'],
      [(candidate) => { candidate.schemaVersion += 1; }, 'invalid_checkpoint_version'],
    ];
    for (const [mutate, errorCode] of invalidCases) {
      const candidate = structuredClone(original);
      candidate.revision += 1;
      mutate(candidate);
      await rejectsCode(checkpointStore.save(candidate), errorCode);
      assert.equal(await fs.readFile(filePath, 'utf8'), originalBytes);
    }
    await checkpointStore.close();
    assert.equal(validationWriterCalls, 0);

    const capacityStore = createDurableCheckpointStore({ filePath, maxRecords: 1 });
    const overCapacity = structuredClone(original);
    overCapacity.revision += 1;
    await rejectsCode(capacityStore.save(overCapacity), 'checkpoint_capacity');
    await capacityStore.close();
    assert.equal(await fs.readFile(filePath, 'utf8'), originalBytes);

    const hostileFiles = [
      ['malformed-json', '{"schemaVersion":', 'invalid_checkpoint_json', undefined],
      ['unknown-version', JSON.stringify({ ...original, schemaVersion: original.schemaVersion + 1 }),
        'invalid_checkpoint_version', undefined],
      ['over-byte-limit', 'x'.repeat(129), 'checkpoint_too_large', 128],
    ];
    for (const [suffix, content, errorCode, maxBytes] of hostileFiles) {
      const hostilePath = sandbox.pathFor(name + '-' + suffix);
      await fs.writeFile(hostilePath, content, 'utf8');
      let hostileWriterCalls = 0;
      const hostileStore = createDurableCheckpointStore({
        filePath: hostilePath,
        ...(maxBytes === undefined ? {} : { maxBytes }),
        atomicWrite: async () => { hostileWriterCalls += 1; },
      });
      await rejectsCode(hostileStore.load(), errorCode);
      await hostileStore.close();
      assert.equal(hostileWriterCalls, 0);
      assert.equal(await fs.readFile(hostilePath, 'utf8'), content);
      assert.equal(await fs.readFile(filePath, 'utf8'), originalBytes);
    }

    const reader = createDurableCheckpointStore({ filePath });
    const loaded = await reader.load();
    assert.equal(loaded.revision, original.revision);
    await reader.close();
    assert.deepEqual(harness.registrationKernel.registry.snapshot(), beforeSnapshots.registrations);
    assert.deepEqual(harness.launchKernel.registry.snapshot(), beforeSnapshots.launches);
    assert.deepEqual(harness.runtimeKernel.registry.snapshot(), beforeSnapshots.runtime);
    assert.equal(originalBytes.includes('private checkpoint payload'), false);
    assert.equal(originalBytes.includes('unexpectedSecret'), false);
    assertWriterNotIssued(harness, launch);
  }
});

test('ID-F11-A02:adopt直後の未attest実行もbinding履歴を保存し送信proofにしない', { timeout: 5000 }, async (t) => {
  for (const provider of PROVIDERS) {
    const harness = createProductHarness();
    const sandbox = await makeSandbox(t);
    const child = harness.period(provider, 'adopt-only-' + provider, 'execution');
    const claims = {
      launchId: 'adopt-only-launch-' + provider,
      runId: 'adopt-only-run-' + provider,
      attemptId: 'adopt-only-attempt-' + provider,
      provider,
      nativeIdKind: NATIVE_ID_KINDS[provider],
      hostId: child.identity.hostId,
      homeScopeId: child.identity.homeScopeId,
      origin: 'standalone',
      purpose: 'agent',
      originBinding: null,
    };
    const registration = harness.launchAdapters[provider].registerLaunch(
      claims,
      evidence('adopt-only-start-' + provider),
    );
    harness.launchAdapters[provider].bindExecution(registration.launchRef, {
      identity: structuredClone(child.identity),
      executionBinding: cloneBinding(child),
      evidence: evidence('adopt-only-binding-' + provider, registration.launchRef),
    });
    const boundLaunch = harness.launchKernel.registry.get(registration.launchRef);
    harness.runtimeAdapters[provider].adoptExecution(registration.launchRef, immutableClaims(boundLaunch));
    const adopted = harness.runtimeAdapters[provider].get(registration.launchRef);
    assert.equal(adopted.currentProof, null);
    assert.equal(adopted.ownerGeneration, 0);
    assert.equal(harness.runtimeKernel.registry.snapshot().actors.some((actor) =>
      actor.launchRef === registration.launchRef), false);

    const name = 'adopt-only-' + provider;
    const { store, adapters } = await sandbox.open(harness, name);
    await store.captureRegistrations();
    const saved = await checkpoint(sandbox.pathFor(name));
    const runtimeRecord = saved.registrations.runtimeLaunches.find((item) =>
      item.launchRef === registration.launchRef);
    assert.ok(runtimeRecord);
    assert.equal(runtimeRecord.ownerGeneration, 0);
    assert.equal(runtimeRecord.currentOwner.periodId, child.registration.executionId);
    assert.equal(Object.hasOwn(runtimeRecord, 'currentProof'), false);
    assert.equal(saved.registrations.actors.some((actor) => actor.launchRef === registration.launchRef), false);

    const delivery = await adapters[provider].createQuestionDelivery(
      deliveryInput(registration.launchRef, 'adopt-only-delivery-' + provider, 'unattested payload'),
    );
    let sinkCalls = 0;
    await rejectsCode(adapters[provider].sendStart(delivery.deliveryAttemptId,
      () => { sinkCalls += 1; }), 'delivery_target_unavailable');
    assert.equal(sinkCalls, 0);
    assert.equal((await adapters[provider].get(delivery.deliveryAttemptId)).state, 'available');
    assert.equal(harness.runtimeKernel.registry.get(registration.launchRef).currentProof, null);
    assertWriterNotIssued(harness, { child, launchRef: registration.launchRef });
    await store.close();
  }
});
