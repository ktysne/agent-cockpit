'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRegistrationKernel, createProviderRegistrationAdapter } = require('../src/server/conversation-registry');
const { createLaunchBindingKernel, createProviderLaunchAdapter } = require('../src/server/launch-binding');
const { createRuntimeBindingKernel, createProviderRuntimeAdapter } = require('../src/server/runtime-binding');

const PROVIDERS = ['claude', 'codex'];
const NATIVE_ID_KINDS = { claude: 'session', codex: 'thread' };
const CLAIM_FIELDS = [
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding', 'identity', 'executionBinding',
];

function evidence(evidenceId, extra = {}) {
  return {
    evidenceId,
    source: 'fixture-test-issuer',
    method: 'authenticated-fixture',
    adapterVersion: 'fixture-adapter-1',
    runtimeVersion: 'fixture-runtime-1',
    capabilities: ['native-binding'],
    ...extra,
  };
}

function oppositeProvider(provider) {
  return provider === 'claude' ? 'codex' : 'claude';
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

function createHarness(provider, options = {}) {
  const registrationKernel = createRegistrationKernel();
  const registrationAdapters = Object.fromEntries(PROVIDERS.map((item) => [
    item,
    createProviderRegistrationAdapter(item, registrationKernel.registry, registrationKernel.authority),
  ]));
  const periods = [];

  function registerPeriod(periodProvider, suffix, role) {
    const identity = fullIdentity(periodProvider, suffix);
    const startId = 'start-' + suffix;
    const registration = registrationAdapters[periodProvider].register(
      nativeIdentity(periodProvider, suffix),
      evidence('period-evidence-' + suffix),
      {
        startId,
        ...(periodProvider === 'claude' ? { projectionId: identity.nativeId } : {}),
      },
    );
    const actorValue = actor(role === 'execution' ? 'agent' : 'tool-use', role + '-' + suffix);
    const contextId = 'context-' + suffix;
    const writer = registrationAdapters[periodProvider].bindWriter(registration.executionId, {
      identity,
      contextId,
      evidence: evidence('writer-evidence-' + suffix),
    });
    const period = { identity, registration, actor: actorValue, contextId, writer, role };
    periods.push(period);
    return period;
  }

  const parent = registerPeriod(oppositeProvider(provider), 'parent-' + provider, 'owner');
  const child = registerPeriod(provider, 'child-' + provider, 'execution');
  const launchKernel = createLaunchBindingKernel({ registrationRegistry: registrationKernel.registry });
  const launchAdapters = Object.fromEntries(PROVIDERS.map((item) => [
    item,
    createProviderLaunchAdapter(item, launchKernel.registry, launchKernel.authority),
  ]));
  const originBinding = periodBinding(parent.registration.executionId, parent.actor);
  const launchClaims = {
    launchId: 'launch-' + provider + (options.standalone ? '-standalone' : ''),
    runId: 'run-' + provider + (options.standalone ? '-standalone' : ''),
    attemptId: 'attempt-' + provider + (options.standalone ? '-standalone' : ''),
    provider,
    nativeIdKind: NATIVE_ID_KINDS[provider],
    hostId: child.identity.hostId,
    homeScopeId: child.identity.homeScopeId,
    origin: options.standalone ? 'standalone' : 'delegated',
    purpose: 'agent',
    originBinding: options.standalone ? null : originBinding,
  };
  const launch = launchAdapters[provider].registerLaunch(
    launchClaims,
    evidence('launch-start-' + provider),
  );
  launchAdapters[provider].bindExecution(launch.launchRef, {
    identity: structuredClone(child.identity),
    executionBinding: periodBinding(child.registration.executionId, child.actor),
    evidence: evidence('launch-binding-' + provider, { registrationRef: launch.launchRef }),
  });
  const launchRecord = launchKernel.registry.get(launch.launchRef);
  const harness = {
    provider,
    registrationKernel,
    registrationAdapters,
    periods,
    parent,
    child,
    launchKernel,
    launchAdapters,
    launch,
    immutableClaims: immutableClaims(launchRecord),
    runtimeInstances: [],
  };
  harness.runtime = createRuntime(harness, true);
  return harness;
}

function createRuntime(harness, adopt = false) {
  const kernel = createRuntimeBindingKernel({
    registrationRegistry: harness.registrationKernel.registry,
    launchRegistry: harness.launchKernel.registry,
  });
  const adapters = Object.fromEntries(PROVIDERS.map((provider) => [
    provider,
    createProviderRuntimeAdapter(provider, kernel.registry, kernel.authority),
  ]));
  const runtime = { ...kernel, adapters };
  harness.runtimeInstances.push(runtime);
  if (adopt) adapters[harness.provider].adoptExecution(
    harness.launch.launchRef,
    structuredClone(harness.immutableClaims),
  );
  return runtime;
}
function runtimeAdapter(harness, runtime, provider = harness.provider) {
  return runtime.adapters[provider];
}

function actorClaims(harness, period, role, contextId = period.contextId) {
  const execution = role === 'execution';
  return {
    identity: structuredClone(period.identity),
    periodId: period.registration.executionId,
    actor: structuredClone(period.actor),
    contextId,
    launchRef: execution ? harness.launch.launchRef : null,
    immutableExecutionClaims: execution ? structuredClone(harness.immutableClaims) : null,
  };
}

function openConnection(harness, runtime, period, role, connectionId, connectionSlotId) {
  const adapter = runtimeAdapter(harness, runtime, period.identity.provider);
  const scope = {
    provider: period.identity.provider,
    nativeIdKind: period.identity.nativeIdKind,
    hostId: period.identity.hostId,
    homeScopeId: period.identity.homeScopeId,
    connectionSlotId: connectionSlotId ||
      'slot-' + period.registration.executionId + '-' + role,
  };
  const opened = adapter.openConnection(
    scope,
    connectionId,
    evidence('connection-evidence-' + connectionId),
  );
  return { ...opened, adapter, scope, connectionId };
}

function attestActor(harness, runtime, period, role, connection, contextId, evidenceId) {
  const result = connection.adapter.attestActor(
    connection.connectionHandle,
    actorClaims(harness, period, role, contextId),
    evidence(evidenceId),
  );
  return {
    actorHandle: result.actorHandle,
    claims: actorClaims(harness, period, role, contextId),
    connection,
    period,
    role,
  };
}

function attestPair(harness, runtime = harness.runtime, suffix = 'initial') {
  const childConnection = openConnection(
    harness, runtime, harness.child, 'execution', 'child-connection-' + suffix,
  );
  const ownerConnection = openConnection(
    harness, runtime, harness.parent, 'owner', 'owner-connection-' + suffix,
  );
  const childActor = attestActor(
    harness, runtime, harness.child, 'execution', childConnection,
    harness.child.contextId, 'child-actor-evidence-' + suffix,
  );
  const ownerActor = attestActor(
    harness, runtime, harness.parent, 'owner', ownerConnection,
    harness.parent.contextId, 'owner-actor-evidence-' + suffix,
  );
  return { childConnection, ownerConnection, childActor, ownerActor };
}

function reconcile(harness, runtime, pair, expectedOwnerGeneration) {
  const record = runtimeAdapter(harness, runtime).get(harness.launch.launchRef);
  return runtimeAdapter(harness, runtime).reconcileExecution(harness.launch.launchRef, {
    executionActorHandle: pair.childActor.actorHandle,
    ownerActorHandle: pair.ownerActor.actorHandle,
    expectedOwnerGeneration: expectedOwnerGeneration ?? record.ownerGeneration,
  });
}

function checkProof(harness, runtime, proofHandle) {
  return runtimeAdapter(harness, runtime).checkCurrentProof(harness.launch.launchRef, proofHandle);
}

function assertProofAccepted(harness, runtime, proofHandle) {
  const verdict = checkProof(harness, runtime, proofHandle);
  assert.equal(verdict.ok, true, harness.provider);
  assert.equal(verdict.reason, 'accepted', harness.provider);
}

function assertProofRejected(harness, runtime, proofHandle) {
  assert.equal(checkProof(harness, runtime, proofHandle).ok, false, harness.provider);
}

function writerAuthorization(harness, period) {
  return harness.registrationAdapters[period.identity.provider].authorizeWrite(
    period.writer,
    { ...period.identity, contextId: period.contextId },
  );
}

function launchRefIsNotWriter(harness) {
  const envelope = {
    token: harness.launch.launchRef,
    identity: structuredClone(harness.child.identity),
    contextId: 'launch-reference-is-not-a-writer',
    executionId: harness.child.registration.executionId,
  };
  return harness.registrationAdapters[harness.provider].authorizeWrite(
    envelope,
    { ...harness.child.identity, contextId: envelope.contextId },
  );
}

function captureA(harness) {
  return {
    registration: harness.registrationKernel.registry.snapshot(),
    launch: harness.launchKernel.registry.snapshot(),
    realWriters: harness.periods.map((period) => writerAuthorization(harness, period)),
    launchReferenceWriter: launchRefIsNotWriter(harness),
  };
}

function assertAUnchanged(harness, expected) {
  assert.deepEqual(captureA(harness), expected, harness.provider);
}

function getRecord(harness, runtime = harness.runtime) {
  return runtime.registry.get(harness.launch.launchRef);
}

function captureB(runtime) {
  return runtime.registry.snapshot();
}

function assertBoundRecord(harness, runtime, expectedOwner, generation, proof = null) {
  const record = getRecord(harness, runtime);
  assert.ok(record, harness.provider);
  assert.deepEqual(immutableClaims(record), harness.immutableClaims, harness.provider);
  assert.deepEqual(record.originBinding, harness.immutableClaims.originBinding, harness.provider);
  assert.deepEqual(record.currentOwner, expectedOwner, harness.provider);
  assert.equal(record.ownerGeneration, generation, harness.provider);
  assert.deepEqual(record.currentProof, proof, harness.provider);
  return record;
}

function addOwnerPeriod(harness, suffix, periodProvider = harness.provider) {
  const adapter = harness.registrationAdapters[periodProvider];
  const identity = fullIdentity(periodProvider, suffix);
  const registration = adapter.register(
    nativeIdentity(periodProvider, suffix),
    evidence('period-evidence-' + suffix),
    {
      startId: 'start-' + suffix,
      ...(periodProvider === 'claude' ? { projectionId: identity.nativeId } : {}),
    },
  );
  const actorValue = actor('tool-use', 'owner-' + suffix);
  const contextId = 'context-' + suffix;
  const writer = adapter.bindWriter(registration.executionId, {
    identity,
    contextId,
    evidence: evidence('writer-evidence-' + suffix),
  });
  const period = { identity, registration, actor: actorValue, contextId, writer, role: 'owner' };
  harness.periods.push(period);
  return period;
}

function attestOwnerPeriod(harness, runtime, period, suffix) {
  const connection = openConnection(
    harness, runtime, period, 'owner',
    'owner-connection-' + suffix,
  );
  return attestActor(
    harness, runtime, period, 'owner', connection,
    period.contextId, 'owner-actor-evidence-' + suffix,
  );
}

function makeTransition(harness, expectedOwner, expectedGeneration, newOwner, newGeneration, handoffId, claims = harness.immutableClaims) {
  return {
    handoffId,
    expectedOwner: structuredClone(expectedOwner),
    expectedOwnerGeneration: expectedGeneration,
    newOwner: structuredClone(newOwner),
    newOwnerGeneration: newGeneration,
    immutableExecutionClaims: structuredClone(claims),
    evidence: evidence('handoff-evidence-' + handoffId),
  };
}

function acceptHandoff(harness, runtime, transition, ownerActorHandle) {
  return runtimeAdapter(harness, runtime).handoff(
    harness.launch.launchRef,
    transition,
    ownerActorHandle,
  );
}

function expectThrow(action, code) {
  assert.throws(action, (error) => {
    assert.ok(error instanceof Error);
    if (code) assert.equal(error.code, code);
    return true;
  });
}
test('ID-F03-B01: observeは外部metadataを昇格せず別kernel・JSON handleを拒否する', { timeout: 1000 }, () => {
  for (const provider of PROVIDERS) {
    const harness = createHarness(provider);
    const target = harness.runtime;
    const source = createRuntime(harness, true);
    const targetAdapter = runtimeAdapter(harness, target);
    const beforeA = captureA(harness);
    const beforeTarget = captureB(target);
    const sourceActors = attestPair(harness, source, 'foreign');
    const sourceProof = reconcile(harness, source, sourceActors);
    assertProofAccepted(harness, source, sourceProof.proofHandle);

    const hostile = evidence('hostile-observation-' + provider, {
      verified: true,
      pid: 4321,
      cwd: 'private-working-directory',
      inheritedClaims: { nativeId: 'private-native-id' },
      secret: 'private-secret',
      payload: 'private-payload',
    });
    const observed = targetAdapter.observe(structuredClone(harness.child.identity), hostile);
    assert.deepEqual([observed.ok, observed.status], [true, 'unverified'], provider);
    const targetSnapshot = target.registry.snapshot();
    const savedObservation = targetSnapshot.observations.find((item) => item.observationId === observed.observationId);
    assert.ok(savedObservation, provider);
    const savedMetadata = JSON.stringify(savedObservation.metadata);
    for (const value of ['private-working-directory', 'private-native-id', 'private-secret', 'private-payload', '4321']) {
      assert.equal(savedMetadata.includes(value), false, provider);
    }
    assert.deepEqual(
      targetSnapshot.launches.find((item) => item.launchRef === harness.launch.launchRef).currentProof,
      null,
      provider,
    );
    assert.deepEqual(targetAdapter.get(harness.launch.launchRef).currentOwner, harness.immutableClaims.originBinding, provider);
    assert.equal(targetAdapter.get(harness.launch.launchRef).ownerGeneration, 0, provider);

    assertProofRejected(harness, target, sourceProof.proofHandle);
    assertProofRejected(harness, target, structuredClone(sourceProof.proofHandle));
    assertProofRejected(harness, target, JSON.parse(JSON.stringify(sourceProof.currentProof)));
    expectThrow(() => targetAdapter.reconcileExecution(harness.launch.launchRef, {
      executionActorHandle: sourceActors.childActor.actorHandle,
      ownerActorHandle: sourceActors.ownerActor.actorHandle,
      expectedOwnerGeneration: 0,
    }));
    expectThrow(() => targetAdapter.reconcileExecution(harness.launch.launchRef, {
      executionActorHandle: structuredClone(sourceActors.childActor.actorHandle),
      ownerActorHandle: sourceActors.ownerActor.actorHandle,
      expectedOwnerGeneration: 0,
    }));
    assert.deepEqual(target.registry.snapshot().launches.find(
      (item) => item.launchRef === harness.launch.launchRef,
    ).currentProof, null, provider);
    assertAUnchanged(harness, beforeA);
    assert.deepEqual(beforeTarget.launches, target.registry.snapshot().launches, provider);
  }
});

test('ID-F03-B02: claim欠落・すり替えと同contextのactor衝突はproofを流用しない', { timeout: 1000 }, () => {
  for (const provider of PROVIDERS) {
    const harness = createHarness(provider);
    const runtime = harness.runtime;
    const adapter = runtimeAdapter(harness, runtime);
    const actors = attestPair(harness, runtime, 'claims');
    const validProof = reconcile(harness, runtime, actors);
    assertProofAccepted(harness, runtime, validProof.proofHandle);
    const beforeA = captureA(harness);
    const beforeB = captureB(runtime);
    const validRecord = getRecord(harness, runtime);

    for (const field of CLAIM_FIELDS) {
      const incomplete = structuredClone(harness.immutableClaims);
      delete incomplete[field];
      expectThrow(() => adapter.adoptExecution(harness.launch.launchRef, incomplete));
      assert.deepEqual(captureB(runtime), beforeB, provider);

      const changed = structuredClone(harness.immutableClaims);
      if (typeof changed[field] === 'string') {
        changed[field] += '-swapped';
      } else if (field === 'originBinding') {
        changed.originBinding.periodId += '-swapped';
      } else if (field === 'identity') {
        changed.identity.nativeId += '-swapped';
      } else if (field === 'executionBinding') {
        changed.executionBinding.actor.id += '-swapped';
      }
      expectThrow(() => adapter.adoptExecution(harness.launch.launchRef, changed));
      assert.deepEqual(captureB(runtime), beforeB, provider);
    }
    expectThrow(() => adapter.adoptExecution(harness.launch.launchRef, {
      ...structuredClone(harness.immutableClaims),
      untrusted: true,
    }));

    const invalidActorClaims = [
      (claims) => { delete claims.identity; },
      (claims) => { delete claims.periodId; },
      (claims) => { delete claims.actor; },
      (claims) => { delete claims.contextId; },
      (claims) => { delete claims.launchRef; },
      (claims) => { delete claims.immutableExecutionClaims; },
      (claims) => { claims.identity.nativeId += '-swapped'; },
      (claims) => { claims.periodId = harness.parent.registration.executionId; },
      (claims) => { claims.actor.id += '-swapped'; },
      (claims) => { claims.contextId = ''; },
      (claims) => { claims.launchRef += '-swapped'; },
      (claims) => { claims.immutableExecutionClaims.runId += '-swapped'; },
      (claims) => { claims.immutableExecutionClaims.identity.nativeId += '-swapped'; },
      (claims) => { claims.untrusted = true; },
    ];
    for (const [index, mutate] of invalidActorClaims.entries()) {
      const claims = actorClaims(harness, harness.child, 'execution');
      mutate(claims);
      expectThrow(() => actors.childConnection.adapter.attestActor(
        actors.childConnection.connectionHandle,
        claims,
        evidence('invalid-actor-evidence-' + provider + '-' + index),
      ));
      assert.deepEqual(captureB(runtime), beforeB, provider);
    }

    const collisionClaims = actorClaims(harness, harness.parent, 'owner');
    collisionClaims.actor.id += '-other';
    expectThrow(() => actors.ownerConnection.adapter.attestActor(
      actors.ownerConnection.connectionHandle,
      collisionClaims,
      evidence('same-context-collision-' + provider),
    ));
    assert.deepEqual(captureB(runtime), beforeB, provider);

    expectThrow(() => adapter.reconcileExecution(harness.launch.launchRef, {
      executionActorHandle: actors.ownerActor.actorHandle,
      ownerActorHandle: actors.childActor.actorHandle,
      expectedOwnerGeneration: 0,
    }));
    assert.deepEqual(captureB(runtime), beforeB, provider);
    assert.deepEqual(validRecord.currentOwner, harness.immutableClaims.originBinding, provider);
    assert.deepEqual(getRecord(harness, runtime).currentOwner, harness.immutableClaims.originBinding, provider);
    assert.equal(getRecord(harness, runtime).ownerGeneration, 0, provider);
    assert.equal(checkProof(harness, runtime, validProof.proofHandle).ok, true, provider);
    assertAUnchanged(harness, beforeA);
  }
});

test('ID-F03-B03: 両providerの完全claimを同じ#166へ照合しgeneration 0 proofを作る', { timeout: 1000 }, () => {
  for (const provider of PROVIDERS) {
    const harness = createHarness(provider);
    const beforeA = captureA(harness);
    const actors = attestPair(harness, harness.runtime, 'valid');
    const result = reconcile(harness, harness.runtime, actors, 0);
    assertProofAccepted(harness, harness.runtime, result.proofHandle);
    const record = assertBoundRecord(
      harness,
      harness.runtime,
      harness.immutableClaims.originBinding,
      0,
      result.currentProof,
    );
    assert.notEqual(record.identity.provider, actors.ownerActor.claims.identity.provider, provider);
    assert.deepEqual(result.currentProof, {
      identity: structuredClone(harness.child.identity),
      executionBinding: structuredClone(harness.immutableClaims.executionBinding),
      currentOwner: structuredClone(harness.immutableClaims.originBinding),
      ownerGeneration: 0,
      executionConnectionGeneration: actors.childConnection.connectionGeneration,
      ownerConnectionGeneration: actors.ownerConnection.connectionGeneration,
      executionContextId: harness.child.contextId,
      ownerContextId: harness.parent.contextId,
    }, provider);
    assert.equal(runtimeAdapter(harness, harness.runtime, oppositeProvider(provider)).get(
      harness.launch.launchRef,
    ), null, provider);
    assertAUnchanged(harness, beforeA);
    assert.equal(launchRefIsNotWriter(harness).ok, false, provider);

    const standalone = createHarness(provider, { standalone: true });
    const standaloneBeforeA = captureA(standalone);
    const standaloneActors = attestPair(standalone, standalone.runtime, 'standalone');
    const standaloneRecord = getRecord(standalone, standalone.runtime);
    const selfOwner = structuredClone(standalone.immutableClaims.executionBinding);
    assert.equal(standalone.immutableClaims.originBinding, null, provider);
    assert.deepEqual(standaloneRecord.currentOwner, selfOwner, provider);
    const selfProof = runtimeAdapter(standalone, standalone.runtime).reconcileExecution(
      standalone.launch.launchRef,
      {
        executionActorHandle: standaloneActors.childActor.actorHandle,
        ownerActorHandle: standaloneActors.childActor.actorHandle,
        expectedOwnerGeneration: 0,
      },
    );
    const expectedSelfProof = {
      identity: structuredClone(standalone.child.identity),
      executionBinding: structuredClone(standalone.immutableClaims.executionBinding),
      currentOwner: selfOwner,
      ownerGeneration: 0,
      executionConnectionGeneration: standaloneActors.childConnection.connectionGeneration,
      ownerConnectionGeneration: standaloneActors.childConnection.connectionGeneration,
      executionContextId: standalone.child.contextId,
      ownerContextId: standalone.child.contextId,
    };
    assert.deepEqual(selfProof.currentProof, expectedSelfProof, provider);
    assertProofAccepted(standalone, standalone.runtime, selfProof.proofHandle);
    assertBoundRecord(standalone, standalone.runtime, selfOwner, 0, expectedSelfProof);
    assertAUnchanged(standalone, standaloneBeforeA);
  }
});
test('ID-F04-B01: 同slot再接続は旧proofを失効させ遅延disconnect・attest・endを無効にする', { timeout: 1000 }, () => {
  for (const provider of PROVIDERS) {
    const harness = createHarness(provider);
    const runtime = harness.runtime;
    const actors = attestPair(harness, runtime, 'reconnect');
    const originalProof = reconcile(harness, runtime, actors);
    assertProofAccepted(harness, runtime, originalProof.proofHandle);
    const beforeA = captureA(harness);

    const newChildConnection = openConnection(
      harness,
      runtime,
      harness.child,
      'execution',
      'child-reconnect-' + provider,
      actors.childConnection.scope.connectionSlotId,
    );
    assertProofRejected(harness, runtime, originalProof.proofHandle);
    assert.equal(actors.childConnection.adapter.disconnect(actors.childConnection.connectionHandle), false);
    expectThrow(() => actors.childConnection.adapter.attestActor(
      actors.childConnection.connectionHandle,
      actors.childActor.claims,
      evidence('late-child-attest-' + provider),
    ));
    expectThrow(() => runtimeAdapter(harness, runtime).reconcileExecution(harness.launch.launchRef, {
      executionActorHandle: actors.childActor.actorHandle,
      ownerActorHandle: actors.ownerActor.actorHandle,
      expectedOwnerGeneration: 0,
    }));
    const currentChildActor = attestActor(
      harness, runtime, harness.child, 'execution', newChildConnection,
      harness.child.contextId, 'current-child-attest-' + provider,
    );
    const childRefreshedProof = runtimeAdapter(harness, runtime).reconcileExecution(harness.launch.launchRef, {
      executionActorHandle: currentChildActor.actorHandle,
      ownerActorHandle: actors.ownerActor.actorHandle,
      expectedOwnerGeneration: 0,
    });
    assertProofAccepted(harness, runtime, childRefreshedProof.proofHandle);
    assert.equal(actors.childConnection.adapter.endActor(actors.childActor.actorHandle), false);
    assertProofAccepted(harness, runtime, childRefreshedProof.proofHandle);
    const childActorStates = runtime.registry.snapshot().actors.filter((item) =>
      item.periodId === harness.child.registration.executionId && item.actor.id === harness.child.actor.id);
    assert.equal(childActorStates.find((item) => item.connectionId === actors.childConnection.connectionId).state, 'unknown');
    assert.equal(childActorStates.find((item) => item.connectionId === newChildConnection.connectionId).state, 'active');

    const newOwnerConnection = openConnection(
      harness,
      runtime,
      harness.parent,
      'owner',
      'owner-reconnect-' + provider,
      actors.ownerConnection.scope.connectionSlotId,
    );
    assertProofRejected(harness, runtime, childRefreshedProof.proofHandle);
    assert.equal(actors.ownerConnection.adapter.disconnect(actors.ownerConnection.connectionHandle), false);
    expectThrow(() => actors.ownerConnection.adapter.attestActor(
      actors.ownerConnection.connectionHandle,
      actors.ownerActor.claims,
      evidence('late-owner-attest-' + provider),
    ));
    const currentOwnerActor = attestActor(
      harness, runtime, harness.parent, 'owner', newOwnerConnection,
      harness.parent.contextId, 'current-owner-attest-' + provider,
    );
    const refreshedProof = runtimeAdapter(harness, runtime).reconcileExecution(harness.launch.launchRef, {
      executionActorHandle: currentChildActor.actorHandle,
      ownerActorHandle: currentOwnerActor.actorHandle,
      expectedOwnerGeneration: 0,
    });
    assertProofAccepted(harness, runtime, refreshedProof.proofHandle);
    assert.equal(actors.ownerConnection.adapter.endActor(actors.ownerActor.actorHandle), false);
    assertProofAccepted(harness, runtime, refreshedProof.proofHandle);
    const ownerActorStates = runtime.registry.snapshot().actors.filter((item) =>
      item.periodId === harness.parent.registration.executionId && item.actor.id === harness.parent.actor.id);
    assert.equal(ownerActorStates.find((item) => item.connectionId === actors.ownerConnection.connectionId).state, 'unknown');
    assert.equal(ownerActorStates.find((item) => item.connectionId === newOwnerConnection.connectionId).state, 'active');
    assertAUnchanged(harness, beforeA);
    assertBoundRecord(
      harness,
      runtime,
      harness.immutableClaims.originBinding,
      0,
      refreshedProof.currentProof,
    );
  }
});

test('ID-F04-B02: actor・period・launchの終了は該当proofだけを失効させる', { timeout: 1000 }, () => {
  for (const provider of PROVIDERS) {
    {
      const harness = createHarness(provider);
      const runtime = harness.runtime;
      const actors = attestPair(harness, runtime, 'actor-end');
      const secondContext = attestActor(
        harness,
        runtime,
        harness.child,
        'execution',
        actors.childConnection,
        harness.child.contextId + '-other',
        'same-actor-other-context-' + provider,
      );
      const proof = runtimeAdapter(harness, runtime).reconcileExecution(harness.launch.launchRef, {
        executionActorHandle: secondContext.actorHandle,
        ownerActorHandle: actors.ownerActor.actorHandle,
        expectedOwnerGeneration: 0,
      });
      assertProofAccepted(harness, runtime, proof.proofHandle);
      const beforeA = captureA(harness);
      assert.equal(actors.childConnection.adapter.endActor(actors.childActor.actorHandle), true);
      assertProofRejected(harness, runtime, proof.proofHandle);
      assert.equal(actors.childConnection.adapter.endActor(secondContext.actorHandle), true);
      expectThrow(() => actors.childConnection.adapter.attestActor(
        actors.childConnection.connectionHandle,
        actorClaims(harness, harness.child, 'execution', harness.child.contextId + '-revived'),
        evidence('revive-ended-actor-' + provider),
      ));
      assertAUnchanged(harness, beforeA);
      assertBoundRecord(harness, runtime, harness.immutableClaims.originBinding, 0, null);
      const ownerState = runtime.registry.snapshot().actors.find((item) =>
        item.periodId === harness.parent.registration.executionId);
      assert.equal(ownerState.state, 'active', provider);
    }

    {
      const harness = createHarness(provider);
      const runtime = harness.runtime;
      const actors = attestPair(harness, runtime, 'owner-actor-end');
      const proof = reconcile(harness, runtime, actors);
      assertProofAccepted(harness, runtime, proof.proofHandle);
      const beforeA = captureA(harness);
      assert.equal(actors.ownerConnection.adapter.endActor(actors.ownerActor.actorHandle), true);
      assert.equal(checkProof(harness, runtime, proof.proofHandle).ok, false, provider);
      assert.equal(checkProof(harness, runtime, proof.proofHandle).reason, 'owner_actor_ended', provider);
      assertAUnchanged(harness, beforeA);
      const states = runtime.registry.snapshot().actors;
      assert.equal(states.find((item) => item.periodId === harness.parent.registration.executionId).state, 'ended');
      assert.equal(states.find((item) => item.periodId === harness.child.registration.executionId).state, 'active');
      assert.equal(getRecord(harness, runtime).currentOwner.periodId, harness.parent.registration.executionId, provider);
    }

    {
      const harness = createHarness(provider);
      const runtime = harness.runtime;
      const actors = attestPair(harness, runtime, 'period-end');
      const proof = reconcile(harness, runtime, actors);
      assertProofAccepted(harness, runtime, proof.proofHandle);
      assert.equal(harness.registrationKernel.authority.end(harness.child.registration.executionId), true);
      const afterEndA = captureA(harness);
      assertProofRejected(harness, runtime, proof.proofHandle);
      const reconnect = openConnection(
        harness, runtime, harness.child, 'execution', 'ended-period-reconnect-' + provider,
      );
      expectThrow(() => attestActor(
        harness, runtime, harness.child, 'execution', reconnect,
        harness.child.contextId, 'ended-period-attest-' + provider,
      ));
      assertAUnchanged(harness, afterEndA);
      assert.equal(getRecord(harness, runtime).currentOwner.periodId, harness.parent.registration.executionId, provider);
      assert.equal(getRecord(harness, runtime).ownerGeneration, 0, provider);
    }

    {
      const harness = createHarness(provider);
      const runtime = harness.runtime;
      const actors = attestPair(harness, runtime, 'launch-end');
      const proof = reconcile(harness, runtime, actors);
      assertProofAccepted(harness, runtime, proof.proofHandle);
      assert.equal(harness.launchKernel.authority.endLaunch(harness.launch.launchRef), true);
      const afterEndA = captureA(harness);
      assertProofRejected(harness, runtime, proof.proofHandle);
      expectThrow(() => runtimeAdapter(harness, runtime).reconcileExecution(harness.launch.launchRef, {
        executionActorHandle: actors.childActor.actorHandle,
        ownerActorHandle: actors.ownerActor.actorHandle,
        expectedOwnerGeneration: 0,
      }));
      assertAUnchanged(harness, afterEndA);
      assert.equal(getRecord(harness, runtime).currentOwner.periodId, harness.parent.registration.executionId, provider);
      assert.equal(getRecord(harness, runtime).ownerGeneration, 0, provider);
    }
  }
});
test('ID-F09-B01: handoffはCAS・連続generation・完全bindingだけを一度反映する', { timeout: 1000 }, () => {
  for (const provider of PROVIDERS) {
    const harness = createHarness(provider);
    const runtime = harness.runtime;
    const actors = attestPair(harness, runtime, 'handoff');
    const oldProof = reconcile(harness, runtime, actors);
    assertProofAccepted(harness, runtime, oldProof.proofHandle);
    const nextOwner = addOwnerPeriod(harness, 'next-owner-' + provider);
    const wrongOwner = addOwnerPeriod(harness, 'wrong-owner-' + provider);
    const nextOwnerActor = attestOwnerPeriod(harness, runtime, nextOwner, 'next-' + provider);
    const wrongOwnerActor = attestOwnerPeriod(harness, runtime, wrongOwner, 'wrong-' + provider);
    const beforeA = captureA(harness);
    const initialOwner = harness.immutableClaims.originBinding;
    const nextOwnerBinding = periodBinding(nextOwner.registration.executionId, nextOwner.actor);
    const wrongOwnerBinding = periodBinding(wrongOwner.registration.executionId, wrongOwner.actor);
    const valid = makeTransition(
      harness, initialOwner, 0, nextOwnerBinding, 1, 'handoff-0-1-' + provider,
    );
    const receipt = acceptHandoff(harness, runtime, valid, nextOwnerActor.actorHandle);
    assert.deepEqual(receipt, {
      handoffId: valid.handoffId,
      owner: nextOwnerBinding,
      ownerGeneration: 1,
      status: 'accepted',
    }, provider);
    assertProofRejected(harness, runtime, oldProof.proofHandle);
    assertBoundRecord(harness, runtime, nextOwnerBinding, 1, null);

    const replay = acceptHandoff(harness, runtime, structuredClone(valid), nextOwnerActor.actorHandle);
    assert.deepEqual(replay, receipt, provider);
    const afterAccepted = captureB(runtime);
    const afterAcceptedRecord = getRecord(harness, runtime);
    const rejectCases = [
      {
        transition: makeTransition(
          harness, initialOwner, 0, wrongOwnerBinding, 1, valid.handoffId,
        ),
        handle: wrongOwnerActor.actorHandle,
      },
      {
        transition: makeTransition(
          harness, initialOwner, 0, wrongOwnerBinding, 1, 'stale-cas-' + provider,
        ),
        handle: wrongOwnerActor.actorHandle,
      },
      {
        transition: makeTransition(
          harness, nextOwnerBinding, 1, wrongOwnerBinding, 3, 'generation-gap-' + provider,
        ),
        handle: wrongOwnerActor.actorHandle,
      },
      {
        transition: makeTransition(
          harness,
          nextOwnerBinding,
          1,
          wrongOwnerBinding,
          2,
          'immutable-change-' + provider,
          { ...structuredClone(harness.immutableClaims), runId: harness.immutableClaims.runId + '-changed' },
        ),
        handle: wrongOwnerActor.actorHandle,
      },
    ];
    for (const invalid of rejectCases) {
      expectThrow(() => acceptHandoff(harness, runtime, invalid.transition, invalid.handle));
      assert.deepEqual(captureB(runtime), afterAccepted, provider);
      assert.deepEqual(getRecord(harness, runtime), afterAcceptedRecord, provider);
      assertAUnchanged(harness, beforeA);
    }

    const newPair = { childActor: actors.childActor, ownerActor: nextOwnerActor };
    const currentProof = reconcile(harness, runtime, newPair, 1);
    assertProofAccepted(harness, runtime, currentProof.proofHandle);
    assert.equal(harness.registrationKernel.authority.end(harness.parent.registration.executionId), true);
    const afterOriginEnd = captureA(harness);
    assertProofAccepted(harness, runtime, currentProof.proofHandle);
    assertAUnchanged(harness, afterOriginEnd);
    assert.deepEqual(getRecord(harness, runtime).currentOwner, nextOwnerBinding, provider);
    assert.equal(getRecord(harness, runtime).ownerGeneration, 1, provider);
  }
});
test('ID-F09-B02: origin owner終了後もfreshなownerへhandoffしてproofを再照合する', { timeout: 1000 }, () => {
  for (const provider of PROVIDERS) {
    const harness = createHarness(provider);
    const runtime = harness.runtime;
    const actors = attestPair(harness, runtime, 'origin-ended');
    const oldProof = reconcile(harness, runtime, actors);
    assertProofAccepted(harness, runtime, oldProof.proofHandle);
    assert.equal(harness.registrationKernel.authority.end(harness.parent.registration.executionId), true);
    assert.equal(checkProof(harness, runtime, oldProof.proofHandle).ok, false, provider);
    assert.equal(checkProof(harness, runtime, oldProof.proofHandle).reason, 'owner_period_ended', provider);

    const newOwner = addOwnerPeriod(harness, 'after-origin-' + provider);
    const newOwnerActor = attestOwnerPeriod(harness, runtime, newOwner, 'after-origin-' + provider);
    const beforeUnverifiedObservation = captureA(harness);
    const suggestedOwner = runtimeAdapter(harness, runtime).observe(
      structuredClone(newOwner.identity),
      evidence('unverified-handoff-suggestion-' + provider, {
        verified: true,
        pid: 9876,
        cwd: 'unverified-cwd',
      }),
    );
    assert.equal(suggestedOwner.status, 'unverified', provider);
    assert.deepEqual(getRecord(harness, runtime).currentOwner, harness.immutableClaims.originBinding, provider);
    assert.equal(getRecord(harness, runtime).ownerGeneration, 0, provider);

    const nextOwner = periodBinding(newOwner.registration.executionId, newOwner.actor);
    const transition = makeTransition(
      harness,
      harness.immutableClaims.originBinding,
      0,
      nextOwner,
      1,
      'handoff-after-origin-end-' + provider,
    );
    const receipt = acceptHandoff(harness, runtime, transition, newOwnerActor.actorHandle);
    assert.equal(receipt.ownerGeneration, 1, provider);
    assert.equal(getRecord(harness, runtime).currentProof, null, provider);
    const result = runtimeAdapter(harness, runtime).reconcileExecution(harness.launch.launchRef, {
      executionActorHandle: actors.childActor.actorHandle,
      ownerActorHandle: newOwnerActor.actorHandle,
      expectedOwnerGeneration: 1,
    });
    assertProofAccepted(harness, runtime, result.proofHandle);
    assert.equal(result.currentProof.ownerGeneration, 1, provider);
    assert.deepEqual(getRecord(harness, runtime).currentOwner, nextOwner, provider);
    assertAUnchanged(harness, beforeUnverifiedObservation);
  }
});

test('ID-F09-B03: 過去handoff再送とJSON snapshotは現在ownerやproofを復元しない', { timeout: 1000 }, () => {
  for (const provider of PROVIDERS) {
    const harness = createHarness(provider);
    const runtime = harness.runtime;
    const actors = attestPair(harness, runtime, 'history');
    const owner1 = addOwnerPeriod(harness, 'history-owner-1-' + provider);
    const owner2 = addOwnerPeriod(harness, 'history-owner-2-' + provider);
    const owner1Actor = attestOwnerPeriod(harness, runtime, owner1, 'history-owner-1-' + provider);
    const owner2Actor = attestOwnerPeriod(harness, runtime, owner2, 'history-owner-2-' + provider);
    const owner0 = harness.immutableClaims.originBinding;
    const owner1Binding = periodBinding(owner1.registration.executionId, owner1.actor);
    const owner2Binding = periodBinding(owner2.registration.executionId, owner2.actor);
    const transition01 = makeTransition(harness, owner0, 0, owner1Binding, 1, 'history-0-1-' + provider);
    const receipt01 = acceptHandoff(harness, runtime, transition01, owner1Actor.actorHandle);
    const transition12 = makeTransition(harness, owner1Binding, 1, owner2Binding, 2, 'history-1-2-' + provider);
    acceptHandoff(harness, runtime, transition12, owner2Actor.actorHandle);
    assertBoundRecord(harness, runtime, owner2Binding, 2, null);

    const latestProof = runtimeAdapter(harness, runtime).reconcileExecution(harness.launch.launchRef, {
      executionActorHandle: actors.childActor.actorHandle,
      ownerActorHandle: owner2Actor.actorHandle,
      expectedOwnerGeneration: 2,
    });
    assertProofAccepted(harness, runtime, latestProof.proofHandle);
    const beforeReplay = captureB(runtime);
    const proofBeforeReplay = getRecord(harness, runtime).currentProof;
    assert.deepEqual(
      acceptHandoff(harness, runtime, structuredClone(transition01), owner1Actor.actorHandle),
      receipt01,
      provider,
    );
    assert.deepEqual(captureB(runtime), beforeReplay, provider);
    assert.deepEqual(getRecord(harness, runtime).currentProof, proofBeforeReplay, provider);
    assert.deepEqual(getRecord(harness, runtime).currentOwner, owner2Binding, provider);
    assert.equal(getRecord(harness, runtime).ownerGeneration, 2, provider);

    const publicSnapshot = JSON.parse(JSON.stringify(runtime.registry.snapshot()));
    const snapshotRecord = publicSnapshot.launches.find((item) => item.launchRef === harness.launch.launchRef);
    assert.ok(snapshotRecord, provider);
    const foreignKernel = createRuntime(harness, false);
    assertProofRejected(harness, foreignKernel, JSON.parse(JSON.stringify(latestProof.proofHandle)));
    const restoredCandidate = createRuntime(harness, false);
    assert.equal(runtimeAdapter(harness, restoredCandidate).get(harness.launch.launchRef), null, provider);
    assertProofRejected(harness, restoredCandidate, snapshotRecord.currentProof);
    expectThrow(() => runtimeAdapter(harness, restoredCandidate).adoptExecution(
      harness.launch.launchRef,
      snapshotRecord,
    ));
    assert.equal(runtimeAdapter(harness, restoredCandidate).get(harness.launch.launchRef), null, provider);

    runtimeAdapter(harness, restoredCandidate).adoptExecution(
      harness.launch.launchRef,
      structuredClone(harness.immutableClaims),
    );
    const freshRecord = runtimeAdapter(harness, restoredCandidate).get(harness.launch.launchRef);
    assert.deepEqual(freshRecord.currentOwner, owner0, provider);
    assert.equal(freshRecord.ownerGeneration, 0, provider);
    assert.equal(freshRecord.currentProof, null, provider);
  }
});