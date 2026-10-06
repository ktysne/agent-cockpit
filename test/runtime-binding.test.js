'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRegistrationKernel, createProviderRegistrationAdapter } = require('../src/server/conversation-registry');
const { createLaunchBindingKernel, createProviderLaunchAdapter } = require('../src/server/launch-binding');
const { createRuntimeBindingKernel, createProviderRuntimeAdapter } = require('../src/server/runtime-binding');

function identity(provider, suffix) {
  return {
    provider,
    nativeIdKind: provider === 'claude' ? 'session' : 'thread',
    hostId: `host-${suffix}`,
    homeScopeId: `home-${suffix}`,
    nativeId: `native-${suffix}`,
  };
}

function actor(id) { return { kind: 'agent', id }; }
function binding(periodId, actorValue) { return { periodId, actor: actorValue }; }
function evidence(evidenceId, extra = {}) {
  return { evidenceId, source: 'fixture', method: 'test-issuer', adapterVersion: 'test-1', ...extra };
}

function createEnvironment() {
  const registration = createRegistrationKernel();
  const registrationAdapters = {
    claude: createProviderRegistrationAdapter('claude', registration.registry, registration.authority),
    codex: createProviderRegistrationAdapter('codex', registration.registry, registration.authority),
  };
  const launch = createLaunchBindingKernel({ registrationRegistry: registration.registry });
  const launchAdapters = {
    claude: createProviderLaunchAdapter('claude', launch.registry, launch.authority),
    codex: createProviderLaunchAdapter('codex', launch.registry, launch.authority),
  };
  const runtime = createRuntimeBindingKernel({ registrationRegistry: registration.registry, launchRegistry: launch.registry });
  const runtimeAdapters = {
    claude: createProviderRuntimeAdapter('claude', runtime.registry, runtime.authority),
    codex: createProviderRuntimeAdapter('codex', runtime.registry, runtime.authority),
  };
  let serial = 0;
  function register(provider, suffix) {
    const native = identity(provider, suffix);
    const run = registrationAdapters[provider].register(
      { nativeIdKind: native.nativeIdKind, hostId: native.hostId, homeScopeId: native.homeScopeId, nativeId: native.nativeId },
      evidence(`registration-${suffix}`),
      { startId: `start-${suffix}` },
    );
    return { identity: native, periodId: run.executionId, conversationId: run.conversationId,
      sessionId: run.sessionId, actor: actor(`actor-${suffix}`) };
  }
  function createLaunch(child, origin = 'standalone', originOwner = null) {
    const launchId = `launch-id-${++serial}`;
    const claims = {
      launchId,
      runId: `run-${serial}`,
      attemptId: `attempt-${serial}`,
      provider: child.identity.provider,
      nativeIdKind: child.identity.nativeIdKind,
      hostId: child.identity.hostId,
      homeScopeId: child.identity.homeScopeId,
      origin,
      purpose: origin === 'review' ? 'cross-review' : 'agent',
      originBinding: origin === 'standalone' ? null : binding(originOwner.periodId, originOwner.actor),
    };
    const registered = launchAdapters[child.identity.provider].registerLaunch(
      claims, evidence(`launch-${serial}`));
    const bindingEvidence = evidence(`launch-binding-${serial}`, { registrationRef: registered.launchRef });
    launchAdapters[child.identity.provider].bindExecution(registered.launchRef, {
      identity: child.identity,
      executionBinding: binding(child.periodId, child.actor),
      evidence: bindingEvidence,
    });
    const record = launch.registry.get(registered.launchRef);
    const immutableClaims = {
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
    return { launchRef: registered.launchRef, claims: immutableClaims,
      record, adapter: runtimeAdapters[child.identity.provider] };
  }
  function openActorConnection(who, suffix, options = {}) {
    const adapter = runtimeAdapters[who.identity.provider];
    const connectionSlotId = options.connectionSlotId || `slot-${suffix}`;
    return adapter.openConnection({ provider: who.identity.provider, nativeIdKind: who.identity.nativeIdKind,
      hostId: who.identity.hostId, homeScopeId: who.identity.homeScopeId, connectionSlotId },
    options.connectionId || `connection-${suffix}`, evidence(options.evidenceId || `connection-evidence-${suffix}`));
  }
  function attest(adapter, who, connectionHandle, contextId, launchInfo = null, evidenceId = `actor-evidence-${contextId}`) {
    return adapter.attestActor(connectionHandle, {
      identity: structuredClone(who.identity),
      periodId: who.periodId,
      actor: structuredClone(who.actor),
      contextId,
      launchRef: launchInfo ? launchInfo.launchRef : null,
      immutableExecutionClaims: launchInfo ? structuredClone(launchInfo.claims) : null,
    }, evidence(evidenceId));
  }
  return { registration, registrationAdapters, launch, launchAdapters, runtime, runtimeAdapters,
    register, createLaunch, openActorConnection, attest };
}

function assertCode(action, code) {
  assert.throws(action, (error) => error && error.code === code && !/secret|private/i.test(error.message));
}

test('observe is unverified, strips non-allowlisted metadata, and does not create a launch or proof', { timeout: 1000 }, () => {
  const env = createEnvironment();
  const who = { identity: identity('claude', 'observe'), periodId: 'external-period', actor: actor('external-actor') };
  const observed = env.runtime.registry.observe(who.identity, evidence('observe-evidence', {
    verified: true, pid: 41, cwd: 'private-path', inheritedClaims: 'secret-claim', payload: 'private-payload',
  }));
  assert.deepEqual(observed, { ok: true, status: 'unverified', observationId: observed.observationId });
  const snapshot = env.runtime.registry.snapshot();
  assert.equal(snapshot.launches.length, 0);
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.observations[0].status, 'unverified');
  assert.deepEqual(snapshot.observations[0].metadata, evidence('observe-evidence'));
  assert.equal(snapshot.connections.length, 0);
  assert.equal(snapshot.actors.length, 0);
});

test('adoption and reconciliation copy claims, keep opaque handles private, and issue no writer token', { timeout: 1000 }, () => {
  const env = createEnvironment();
  const child = env.register('claude', 'copy');
  const launch = env.createLaunch(child);
  const adoptionClaims = structuredClone(launch.claims);
  const registrationBefore = env.registration.registry.snapshot();
  const adopted = launch.adapter.adoptExecution(launch.launchRef, adoptionClaims);
  const replay = launch.adapter.adoptExecution(launch.launchRef, structuredClone(adoptionClaims));
  assert.equal(adopted.ownerGeneration, 0);
  assert.deepEqual(adopted.currentOwner, binding(child.periodId, child.actor));
  assert.equal(adopted.currentProof, null);
  adoptionClaims.identity.nativeId = 'caller-mutated';
  adopted.identity.nativeId = 'result-mutated';
  assert.equal(launch.adapter.get(launch.launchRef).identity.nativeId, child.identity.nativeId);
  assert.equal(replay.identity.nativeId, child.identity.nativeId);
  assertCode(() => launch.adapter.adoptExecution(launch.launchRef, adoptionClaims), 'stale_launch');

  const opened = env.openActorConnection(child, 'copy');
  const exactReplay = launch.adapter.openConnection({
    provider: 'claude', nativeIdKind: 'session', hostId: child.identity.hostId,
    homeScopeId: child.identity.homeScopeId, connectionSlotId: 'slot-copy',
  }, 'connection-copy', evidence('connection-evidence-copy', { secret: 'ignored' }));
  assert.equal(exactReplay.connectionHandle, opened.connectionHandle);
  assert.equal(opened.connectionGeneration, 1);
  assert.equal(Object.isFrozen(opened.connectionHandle), true);
  assert.deepEqual(Object.keys(opened.connectionHandle), []);
  assert.equal(JSON.stringify(opened.connectionHandle), '{}');
  assert.equal(launch.adapter.disconnect(structuredClone(opened.connectionHandle)), false);

  const actorResult = env.attest(launch.adapter, child, opened.connectionHandle, 'copy-context', launch, 'actor-evidence-copy');
  const proof = launch.adapter.reconcileExecution(launch.launchRef, {
    executionActorHandle: actorResult.actorHandle,
    ownerActorHandle: actorResult.actorHandle,
    expectedOwnerGeneration: 0,
  });
  assert.equal(launch.adapter.checkCurrentProof(launch.launchRef, proof.proofHandle).ok, true);
  assert.equal(Object.isFrozen(proof.proofHandle), true);
  assert.deepEqual(Object.keys(proof.proofHandle), []);
  assert.equal(JSON.stringify(proof.proofHandle), '{}');
  assert.equal(launch.adapter.checkCurrentProof(launch.launchRef, structuredClone(proof.proofHandle)).ok, false);
  assert.deepEqual(proof.currentProof, {
    identity: child.identity,
    executionBinding: binding(child.periodId, child.actor),
    currentOwner: binding(child.periodId, child.actor),
    ownerGeneration: 0,
    executionConnectionGeneration: 1,
    ownerConnectionGeneration: 1,
    executionContextId: 'copy-context',
    ownerContextId: 'copy-context',
  });
  proof.currentProof.identity.nativeId = 'caller-mutated';
  const record = launch.adapter.get(launch.launchRef);
  assert.equal(record.currentProof.identity.nativeId, child.identity.nativeId);
  assert.equal(Object.hasOwn(record, 'proofHandle'), false);
  assert.equal(Object.hasOwn(record, 'writerToken'), false);
  const snapshot = env.runtime.registry.snapshot();
  assert.equal(Object.hasOwn(snapshot.launches[0], 'proofHandle'), false);
  assert.equal(Object.hasOwn(snapshot.launches[0], 'writerToken'), false);
  assert.equal(typeof env.runtime.authority.bindWriter, 'undefined');
  assert.equal(typeof env.runtime.registry.authorizeWrite, 'undefined');
  assert.deepEqual(env.registration.registry.snapshot(), registrationBefore);
  const siblingAdapter = createProviderRuntimeAdapter('claude', env.runtime.registry, env.runtime.authority);
  assert.deepEqual(siblingAdapter.checkCurrentProof(launch.launchRef, proof.proofHandle), { ok: true, reason: 'accepted' });
});

test('failed reconciliation leaves the current proof usable and unchanged', { timeout: 1000 }, () => {
  const env = createEnvironment();
  const child = env.register('claude', 'atomic');
  const launch = env.createLaunch(child);
  launch.adapter.adoptExecution(launch.launchRef, launch.claims);
  const connection = env.openActorConnection(child, 'atomic');
  const actorResult = env.attest(launch.adapter, child, connection.connectionHandle, 'atomic-context', launch, 'actor-evidence-atomic');
  const proof = launch.adapter.reconcileExecution(launch.launchRef, {
    executionActorHandle: actorResult.actorHandle, ownerActorHandle: actorResult.actorHandle,
    expectedOwnerGeneration: 0,
  });
  const before = env.runtime.registry.snapshot();
  assertCode(() => launch.adapter.reconcileExecution(launch.launchRef, {
    executionActorHandle: actorResult.actorHandle, ownerActorHandle: actorResult.actorHandle,
    expectedOwnerGeneration: 1,
  }), 'stale_owner_generation');
  assert.deepEqual(env.runtime.registry.snapshot(), before);
  assert.equal(launch.adapter.checkCurrentProof(launch.launchRef, proof.proofHandle).ok, true);
});

test('context claims and evidence IDs cannot be rebound to different actor claims', { timeout: 1000 }, () => {
  const env = createEnvironment();
  const child = env.register('claude', 'context');
  const launch = env.createLaunch(child);
  launch.adapter.adoptExecution(launch.launchRef, launch.claims);
  const opened = env.openActorConnection(child, 'context');
  const claims = {
    identity: structuredClone(child.identity), periodId: child.periodId, actor: structuredClone(child.actor),
    contextId: 'one-context', launchRef: launch.launchRef,
    immutableExecutionClaims: structuredClone(launch.claims),
  };
  const first = launch.adapter.attestActor(opened.connectionHandle, claims, evidence('context-evidence'));
  const replay = launch.adapter.attestActor(opened.connectionHandle, claims,
    evidence('context-evidence', { secret: 'ignored metadata' }));
  assert.equal(replay.actorHandle, first.actorHandle);

  const before = env.runtime.registry.snapshot();
  assertCode(() => launch.adapter.attestActor(opened.connectionHandle, {
    ...claims, launchRef: null, immutableExecutionClaims: null,
  }, evidence('different-context-evidence')), 'context_claim_conflict');
  assertCode(() => launch.adapter.attestActor(opened.connectionHandle, {
    ...claims, contextId: 'second-context',
  }, evidence('context-evidence')), 'evidence_conflict');
  assert.deepEqual(env.runtime.registry.snapshot(), before);
  assert.equal(env.registration.registry.snapshot().executions.length, 1);
});

test('reconnection makes delayed disconnect and actor end harmless, then current actor end is global', { timeout: 1000 }, () => {
  const env = createEnvironment();
  const child = env.register('claude', 'generation');
  const launch = env.createLaunch(child);
  launch.adapter.adoptExecution(launch.launchRef, launch.claims);
  const first = env.openActorConnection(child, 'generation-old', { connectionSlotId: 'shared-slot' });
  const oldActor = env.attest(launch.adapter, child, first.connectionHandle, 'shared-context', launch, 'generation-actor-old');
  const firstProof = launch.adapter.reconcileExecution(launch.launchRef, {
    executionActorHandle: oldActor.actorHandle, ownerActorHandle: oldActor.actorHandle,
    expectedOwnerGeneration: 0,
  });

  const second = env.openActorConnection(child, 'generation-new', { connectionSlotId: 'shared-slot' });
  assert.equal(second.connectionGeneration, 2);
  assert.equal(launch.adapter.disconnect(first.connectionHandle), false);
  assert.equal(launch.adapter.endActor(oldActor.actorHandle), false);
  assert.equal(launch.adapter.checkCurrentProof(launch.launchRef, firstProof.proofHandle).ok, false);
  assert.equal(launch.adapter.get(launch.launchRef).currentProof, null);
  const newActor = env.attest(launch.adapter, child, second.connectionHandle, 'shared-context', launch, 'generation-actor-new');
  assert.equal(launch.adapter.endActor(newActor.actorHandle), true);
  assertCode(() => env.attest(launch.adapter, child, second.connectionHandle, 'other-context', launch,
    'generation-actor-other'), 'actor_ended');
  const runtimeSnapshot = env.runtime.registry.snapshot();
  assert.equal(runtimeSnapshot.connections.find((item) => item.connectionId === 'connection-generation-new').state, 'active');
  assert.equal(runtimeSnapshot.actors.every((item) => item.state === 'ended'), true);
  const period = env.registration.registry.snapshot().executions.find((item) => item.executionId === child.periodId);
  assert.equal(period.state, 'active');
});

test('handoff can replace an ended origin owner and keeps the child proof current', { timeout: 1000 }, () => {
  const env = createEnvironment();
  const parent = env.register('claude', 'parent');
  const child = env.register('claude', 'delegated-child');
  const launch = env.createLaunch(child, 'delegated', parent);
  launch.adapter.adoptExecution(launch.launchRef, launch.claims);

  const childConnection = env.openActorConnection(child, 'handoff-child');
  const childActor = env.attest(launch.adapter, child, childConnection.connectionHandle,
    'child-context', launch, 'handoff-child-actor');
  const parentConnection = env.openActorConnection(parent, 'handoff-parent');
  const parentActor = env.attest(env.runtimeAdapters.claude, parent, parentConnection.connectionHandle,
    'parent-context', null, 'handoff-parent-actor');
  const initialProof = launch.adapter.reconcileExecution(launch.launchRef, {
    executionActorHandle: childActor.actorHandle, ownerActorHandle: parentActor.actorHandle,
    expectedOwnerGeneration: 0,
  });
  assert.equal(launch.adapter.checkCurrentProof(launch.launchRef, initialProof.proofHandle).ok, true);

  assert.equal(env.registration.authority.end(parent.periodId), true);
  assert.equal(launch.adapter.checkCurrentProof(launch.launchRef, initialProof.proofHandle).reason, 'owner_period_ended');
  assert.equal(launch.adapter.get(launch.launchRef).currentProof, null);

  const newOwner = env.register('codex', 'new-owner');
  const newOwnerConnection = env.openActorConnection(newOwner, 'handoff-new-owner');
  const newOwnerActor = env.attest(env.runtimeAdapters.codex, newOwner, newOwnerConnection.connectionHandle,
    'new-owner-context', null, 'handoff-new-owner-actor');
  const transition = {
    handoffId: 'handoff-cross-provider',
    expectedOwner: binding(parent.periodId, parent.actor),
    expectedOwnerGeneration: 0,
    newOwner: binding(newOwner.periodId, newOwner.actor),
    newOwnerGeneration: 1,
    immutableExecutionClaims: structuredClone(launch.claims),
    evidence: evidence('handoff-evidence'),
  };
  const receipt = launch.adapter.handoff(launch.launchRef, transition, newOwnerActor.actorHandle);
  assert.deepEqual(receipt, { handoffId: 'handoff-cross-provider', owner: binding(newOwner.periodId, newOwner.actor),
    ownerGeneration: 1, status: 'accepted' });
  assert.equal(Object.isFrozen(receipt.owner), true);
  assert.equal(launch.adapter.get(launch.launchRef).ownerGeneration, 1);
  assert.equal(launch.adapter.get(launch.launchRef).currentProof, null);
  assert.equal(launch.adapter.checkCurrentProof(launch.launchRef, initialProof.proofHandle).ok, false);
  assert.deepEqual(launch.adapter.handoff(launch.launchRef, transition, {}), receipt);
  assertCode(() => launch.adapter.handoff(launch.launchRef, {
    ...transition, newOwnerGeneration: 2,
  }, newOwnerActor.actorHandle), 'handoff_conflict');
  assert.equal(launch.adapter.get(launch.launchRef).ownerGeneration, 1);

  const currentProof = launch.adapter.reconcileExecution(launch.launchRef, {
    executionActorHandle: childActor.actorHandle, ownerActorHandle: newOwnerActor.actorHandle,
    expectedOwnerGeneration: 1,
  });
  assert.equal(currentProof.currentProof.ownerGeneration, 1);
  assert.deepEqual(currentProof.currentProof.currentOwner, binding(newOwner.periodId, newOwner.actor));
  assert.equal(launch.adapter.checkCurrentProof(launch.launchRef, currentProof.proofHandle).ok, true);
  const registrationSnapshot = env.registration.registry.snapshot();
  assert.equal(registrationSnapshot.executions.find((item) => item.executionId === child.periodId).state, 'active');
  assert.equal(registrationSnapshot.executions.find((item) => item.executionId === parent.periodId).state, 'ended');
  assert.equal(launch.record.state, 'bound');
  assert.deepEqual(launch.record.originBinding, binding(parent.periodId, parent.actor));
});

test('provider adapters reject foreign launch and connection capabilities without changing state', { timeout: 1000 }, () => {
  const env = createEnvironment();
  const child = env.register('claude', 'provider-boundary');
  const launch = env.createLaunch(child);
  const before = env.runtime.registry.snapshot();
  assert.equal(env.runtimeAdapters.codex.get(launch.launchRef), null);
  assertCode(() => env.runtimeAdapters.codex.adoptExecution(launch.launchRef, launch.claims), 'provider_mismatch');
  assert.deepEqual(env.runtime.registry.snapshot(), before);
  assert.equal(env.runtimeAdapters.claude.disconnect(Object.freeze({})), false);
  assertCode(() => env.runtimeAdapters.claude.openConnection({
    provider: 'codex', nativeIdKind: 'thread', hostId: 'h', homeScopeId: 'home', connectionSlotId: 'slot',
  }, 'foreign-connection', evidence('foreign-connection-evidence')), 'provider_mismatch');
  assert.deepEqual(env.runtime.registry.snapshot(), before);
});
test('a failed final launch-registry read cannot replace or clear the previous proof', { timeout: 1000 }, () => {
  const env = createEnvironment();
  const child = env.register('claude', 'read-failure');
  const launch = env.createLaunch(child);
  let getCalls = 0;
  let failAt = 0;
  const launchRegistry = {
    ...env.launch.registry,
    get(launchRef) {
      getCalls += 1;
      if (getCalls === failAt) {
        failAt = 0;
        throw new Error('fixture read failure');
      }
      return env.launch.registry.get(launchRef);
    },
  };
  const runtime = createRuntimeBindingKernel({
    registrationRegistry: env.registration.registry,
    launchRegistry,
  });
  const adapter = createProviderRuntimeAdapter('claude', runtime.registry, runtime.authority);
  adapter.adoptExecution(launch.launchRef, launch.claims);
  const connection = adapter.openConnection({ provider: 'claude', nativeIdKind: 'session',
    hostId: child.identity.hostId, homeScopeId: child.identity.homeScopeId,
    connectionSlotId: 'read-failure-slot' }, 'read-failure-connection', evidence('read-failure-connection-evidence'));
  const actorResult = adapter.attestActor(connection.connectionHandle, {
    identity: child.identity, periodId: child.periodId, actor: child.actor,
    contextId: 'read-failure-context', launchRef: launch.launchRef,
    immutableExecutionClaims: launch.claims,
  }, evidence('read-failure-actor-evidence'));
  const input = { executionActorHandle: actorResult.actorHandle, ownerActorHandle: actorResult.actorHandle,
    expectedOwnerGeneration: 0 };
  const priorProof = adapter.reconcileExecution(launch.launchRef, input);
  const beforeRuntime = runtime.registry.snapshot();
  const beforeRegistration = env.registration.registry.snapshot();
  const callsBeforeReconcile = getCalls;
  failAt = callsBeforeReconcile + 2;
  let reconcileError = null;
  try { runtime.authority.reconcileExecution(launch.launchRef, input); } catch (error) { reconcileError = error; }
  assert.equal(getCalls - callsBeforeReconcile, 2);
  assert.equal(reconcileError?.code, 'registry_unavailable');
  assert.deepEqual(runtime.registry.snapshot(), beforeRuntime);
  assert.deepEqual(env.registration.registry.snapshot(), beforeRegistration);
  assert.equal(adapter.checkCurrentProof(launch.launchRef, priorProof.proofHandle).ok, true);
});
