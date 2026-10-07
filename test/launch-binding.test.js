'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  createLaunchBindingKernel,
  createProviderLaunchAdapter,
} = require('../src/server/launch-binding');

function identity(provider = 'claude', suffix = 'one') {
  return {
    provider,
    nativeIdKind: provider === 'claude' ? 'session' : 'thread',
    hostId: 'host-' + suffix,
    homeScopeId: 'home-' + suffix,
    nativeId: provider + '-native-' + suffix,
  };
}

function actor(kind = 'agent', id = 'actor-one') {
  return { kind, id };
}

function periodBinding(periodId, actorValue = actor()) {
  return { periodId, actor: actorValue };
}

function claims(overrides = {}) {
  return {
    launchId: 'launch-id',
    runId: 'run-id',
    attemptId: 'attempt-one',
    provider: 'claude',
    nativeIdKind: 'session',
    hostId: 'host-one',
    homeScopeId: 'home-one',
    origin: 'standalone',
    purpose: 'agent',
    originBinding: null,
    ...overrides,
  };
}

function evidence(evidenceId, extra = {}) {
  return {
    evidenceId,
    source: 'fixture-issuer',
    method: 'authenticated-fixture',
    adapterVersion: 'fixture-1',
    runtimeVersion: 'fixture-runtime-1',
    capabilities: ['native-binding'],
    ...extra,
  };
}

function createFakeRegistrationRegistry(periods = []) {
  const state = { conversations: [], executions: [] };
  for (const [index, period] of periods.entries()) {
    const conversationId = period.conversationId || 'conversation-' + index;
    state.conversations.push({ conversationId, identity: { ...period.identity } });
    state.executions.push({
      conversationId,
      executionId: period.periodId,
      sessionId: period.sessionId || 'session-' + index,
      state: period.state || 'active',
    });
  }
  let snapshotCalls = 0;
  const registry = {
    snapshot() {
      snapshotCalls += 1;
      return structuredClone(state);
    },
  };
  return {
    registry,
    state,
    snapshotCalls: () => snapshotCalls,
  };
}

function assertCode(action, code) {
  assert.throws(action, (error) => error.code === code && !error.message.includes('private'));
}

test('public observation keeps allowlisted claims unverified and cannot create launch authority', () => {
  const registration = createFakeRegistrationRegistry();
  const kernel = createLaunchBindingKernel({ registrationRegistry: registration.registry });
  const candidate = claims({
    origin: 'delegated',
    purpose: 'agent',
    originBinding: periodBinding('inactive-parent', actor('tool-use', 'parent-tool')),
  });
  const inputEvidence = evidence('observation-evidence', {
    verified: true,
    pid: 77,
    cwd: 'private-working-directory',
    timestamp: 'close-to-start',
    inheritedClaudeId: 'private-claude-id',
    secret: 'private-secret',
    payload: 'private-payload',
  });

  const rejected = kernel.registry.observe({ ...candidate, verified: true }, inputEvidence);
  assert.deepEqual(rejected, { ok: false, status: 'mismatch', observationId: null });
  const observed = kernel.registry.observe(candidate, inputEvidence);
  assert.equal(observed.status, 'unverified');
  candidate.originBinding.actor.id = 'mutated-input';
  inputEvidence.capabilities.push('mutated-input');

  const snapshot = kernel.registry.snapshot();
  assert.deepEqual(snapshot.launches, []);
  assert.equal(snapshot.observations.length, 1);
  assert.equal(snapshot.observations[0].status, 'unverified');
  assert.equal(snapshot.observations[0].claims.originBinding.actor.id, 'parent-tool');
  assert.deepEqual(snapshot.observations[0].metadata.capabilities, ['native-binding']);
  for (const forbidden of ['verified', 'pid', 'cwd', 'timestamp', 'inheritedClaudeId', 'secret', 'payload']) {
    assert.equal(Object.hasOwn(snapshot.observations[0].metadata, forbidden), false, forbidden);
  }
  for (const forbidden of [
    'private-working-directory', 'private-claude-id', 'private-secret', 'private-payload',
  ]) {
    assert.equal(JSON.stringify(snapshot).includes(forbidden), false, forbidden);
  }
  assert.deepEqual(Object.keys(kernel.authority).sort(), ['bindExecution', 'endLaunch', 'registerLaunch']);
  assert.equal(registration.snapshotCalls(), 0);
});

test('launch claims enforce origin-purpose pairs, attempt idempotency, and immutable provider scope', () => {
  const parent = { periodId: 'parent-period', identity: identity('codex', 'parent') };
  const registration = createFakeRegistrationRegistry([parent]);
  const kernel = createLaunchBindingKernel({ registrationRegistry: registration.registry });

  const standalone = claims();
  const startEvidence = evidence('standalone-start');
  const first = kernel.authority.registerLaunch(standalone, startEvidence);
  const replay = kernel.authority.registerLaunch(structuredClone(standalone), structuredClone(startEvidence));
  assert.deepEqual(replay, first);
  assert.equal(kernel.registry.get(first.launchRef).state, 'registered');
  assert.equal(kernel.registry.get(first.launchRef).currentOwner, null);

  const wrongProvider = { ...standalone, provider: 'codex', nativeIdKind: 'thread' };
  assertCode(() => kernel.authority.registerLaunch(wrongProvider, startEvidence), 'launch_conflict');
  assertCode(() => kernel.authority.registerLaunch({
    ...standalone, origin: 'review', purpose: 'agent', originBinding: periodBinding('parent-period'),
  }, evidence('wrong-purpose')), 'invalid_launch');
  assertCode(() => kernel.authority.registerLaunch({
    ...standalone, origin: 'delegated', purpose: 'cross-review', originBinding: periodBinding('parent-period'),
  }, evidence('wrong-delegated-purpose')), 'invalid_launch');

  const delegatedClaims = claims({
    launchId: 'delegated-launch',
    attemptId: 'delegated-attempt',
    origin: 'delegated',
    purpose: 'agent',
    originBinding: periodBinding('parent-period', actor('tool-use', 'parent-tool')),
  });
  const delegated = kernel.authority.registerLaunch(delegatedClaims, evidence('delegated-start'));
  const delegatedRecord = kernel.registry.get(delegated.launchRef);
  assert.deepEqual(delegatedRecord.originBinding, delegatedClaims.originBinding);
  assert.deepEqual(delegatedRecord.currentOwner, delegatedClaims.originBinding);
  assert.equal(delegatedRecord.ownerGeneration, 0);
  assert.equal(delegatedRecord.currentProof, null);

  assertCode(() => kernel.authority.registerLaunch(
    { ...delegatedClaims, attemptId: 'another-attempt' },
    evidence('standalone-start'),
  ), 'evidence_conflict');
  assert.deepEqual(kernel.registry.get(first.launchRef).originBinding, null);
  assert.equal(kernel.registry.snapshot().launches.length, 2);
});

test('binding checks the active period and full identity, preserves copies, and retains ended claims', () => {
  const parentIdentity = identity('codex', 'parent');
  const childIdentity = identity('claude', 'child');
  const registration = createFakeRegistrationRegistry([
    { periodId: 'parent-period', identity: parentIdentity },
    { periodId: 'child-period', identity: childIdentity },
  ]);
  const kernel = createLaunchBindingKernel({ registrationRegistry: registration.registry });
  const launchClaims = claims({
    hostId: childIdentity.hostId,
    homeScopeId: childIdentity.homeScopeId,
    origin: 'delegated',
    purpose: 'agent',
    originBinding: periodBinding('parent-period', actor('tool-use', 'parent-tool')),
  });
  const launch = kernel.authority.registerLaunch(launchClaims, evidence('child-start'));
  const bindingInput = {
    identity: { ...childIdentity },
    executionBinding: periodBinding('child-period', actor('agent', 'child-agent')),
    evidence: evidence('child-binding', { registrationRef: launch.launchRef }),
  };
  const bound = kernel.authority.bindExecution(launch.launchRef, bindingInput);
  assert.equal(bound.state, 'bound');
  assert.equal(bound.periodId, undefined);
  assert.deepEqual(bound.identity, childIdentity);
  assert.equal(bound.executionBinding.periodId, 'child-period');
  assert.equal(bound.conversationId, 'conversation-1');
  assert.equal(bound.sessionId, 'session-1');
  assert.deepEqual(bound.currentOwner, launchClaims.originBinding);
  assert.deepEqual(bound.originBinding, launchClaims.originBinding);
  assert.equal(bound.ownerGeneration, 0);
  assert.equal(bound.currentProof, null);
  assert.equal(bound.bindingEvidence.registrationRef, launch.launchRef);

  bindingInput.identity.nativeId = 'mutated-input';
  bindingInput.executionBinding.actor.id = 'mutated-input';
  bindingInput.evidence.capabilities.push('mutated-input');
  bound.identity.nativeId = 'mutated-return';
  bound.executionBinding.actor.id = 'mutated-return';
  bound.currentOwner.actor.id = 'mutated-return';
  bound.bindingEvidence.capabilities.push('mutated-return');
  const saved = kernel.registry.get(launch.launchRef);
  assert.equal(saved.identity.nativeId, childIdentity.nativeId);
  assert.equal(saved.executionBinding.actor.id, 'child-agent');
  assert.equal(saved.currentOwner.actor.id, 'parent-tool');
  assert.deepEqual(saved.bindingEvidence.capabilities, ['native-binding']);
  const beforeReplay = registration.snapshotCalls();
  assert.deepEqual(
    kernel.authority.bindExecution(launch.launchRef, {
      identity: childIdentity,
      executionBinding: periodBinding('child-period', actor('agent', 'child-agent')),
      evidence: evidence('child-binding', { registrationRef: launch.launchRef }),
    }),
    saved,
  );
  assert.equal(registration.snapshotCalls(), beforeReplay + 1);

  const duplicateLaunch = kernel.authority.registerLaunch(
    { ...launchClaims, launchId: 'duplicate-launch', attemptId: 'duplicate-attempt' },
    evidence('duplicate-start'),
  );
  const beforeDuplicate = kernel.registry.snapshot();
  assertCode(() => kernel.authority.bindExecution(duplicateLaunch.launchRef, {
    identity: childIdentity,
    executionBinding: periodBinding('child-period', actor('agent', 'child-agent')),
    evidence: evidence('duplicate-binding', { registrationRef: duplicateLaunch.launchRef }),
  }), 'duplicate_execution_binding');
  assert.deepEqual(kernel.registry.snapshot(), beforeDuplicate);

  const beforePeriodEnd = kernel.registry.get(launch.launchRef);
  registration.state.executions.find((item) => item.executionId === 'child-period').state = 'ended';
  const beforeDelayedReplay = kernel.registry.snapshot();
  assertCode(() => kernel.authority.bindExecution(launch.launchRef, {
    identity: childIdentity,
    executionBinding: periodBinding('child-period', actor('agent', 'child-agent')),
    evidence: evidence('child-binding', { registrationRef: launch.launchRef }),
  }), 'stale_period');
  assert.deepEqual(kernel.registry.snapshot(), beforeDelayedReplay);
  assert.deepEqual(kernel.registry.get(launch.launchRef), beforePeriodEnd);

  const executionSnapshot = registration.registry.snapshot();
  assert.equal(executionSnapshot.executions.find((item) => item.executionId === 'child-period').state, 'ended');
  assert.equal(typeof kernel.authority.bindWriter, 'undefined');
  assert.equal(typeof kernel.authority.authorizeWrite, 'undefined');

  assert.equal(kernel.authority.endLaunch(launch.launchRef), true);
  assert.equal(kernel.registry.get(launch.launchRef).state, 'ended');
  assert.equal(registration.registry.snapshot().executions.find((item) => item.executionId === 'child-period').state, 'ended');
  assertCode(() => kernel.authority.bindExecution(launch.launchRef, {
    identity: childIdentity,
    executionBinding: periodBinding('child-period', actor('agent', 'child-agent')),
    evidence: evidence('child-binding', { registrationRef: launch.launchRef }),
  }), 'ended_launch');
  assert.deepEqual(
    kernel.authority.registerLaunch(launchClaims, evidence('child-start')),
    launch,
  );
  assert.equal(kernel.registry.get(launch.launchRef).state, 'ended');
});

test('standalone current owner is its own execution binding', () => {
  const childIdentity = identity();
  const registration = createFakeRegistrationRegistry([
    { periodId: 'child-period', identity: childIdentity },
  ]);
  const kernel = createLaunchBindingKernel({ registrationRegistry: registration.registry });
  const launch = kernel.authority.registerLaunch(claims(), evidence('standalone-start'));
  const binding = periodBinding('child-period', actor('agent', 'standalone-agent'));
  const bound = kernel.authority.bindExecution(launch.launchRef, {
    identity: childIdentity,
    executionBinding: binding,
    evidence: evidence('standalone-binding', { registrationRef: launch.launchRef }),
  });
  assert.deepEqual(bound.currentOwner, binding);
  assert.deepEqual(bound.executionBinding, binding);
  assert.equal(bound.originBinding, null);
  assert.equal(bound.ownerGeneration, 0);
  assert.equal(bound.currentProof, null);
});

test('provider adapters cannot end another provider launch', () => {
  const kernel = createLaunchBindingKernel({ registrationRegistry: createFakeRegistrationRegistry().registry });
  const claude = createProviderLaunchAdapter('claude', kernel.registry, kernel.authority);
  const codex = createProviderLaunchAdapter('codex', kernel.registry, kernel.authority);
  const claudeLaunch = claude.registerLaunch(claims(), evidence('claude-start'));
  const codexLaunch = codex.registerLaunch(claims({
    launchId: 'codex-launch',
    attemptId: 'codex-attempt',
    provider: 'codex',
    nativeIdKind: 'thread',
  }), evidence('codex-start'));

  assert.equal(claude.endLaunch(codexLaunch.launchRef), false);
  assert.equal(codex.endLaunch(claudeLaunch.launchRef), false);
  assert.equal(kernel.registry.get(claudeLaunch.launchRef).state, 'registered');
  assert.equal(kernel.registry.get(codexLaunch.launchRef).state, 'registered');
  assert.equal(claude.endLaunch(claudeLaunch.launchRef), true);
  assert.equal(codex.endLaunch(codexLaunch.launchRef), true);
});

test('launch storage stops at its bounded capacity', () => {
  const kernel = createLaunchBindingKernel({ registrationRegistry: createFakeRegistrationRegistry().registry });
  for (let index = 0; index < 10_000; index += 1) {
    kernel.authority.registerLaunch(claims({
      launchId: 'capacity-' + index,
      runId: 'run-' + index,
      attemptId: 'attempt-' + index,
    }), evidence('capacity-evidence-' + index));
  }
  assertCode(() => kernel.authority.registerLaunch(claims({
    launchId: 'capacity-overflow',
    runId: 'capacity-overflow',
    attemptId: 'capacity-overflow',
  }), evidence('capacity-overflow-evidence')), 'capacity');
  assert.equal(kernel.registry.snapshot().launches.length, 10_000);
});

for (const provider of ['claude', 'codex']) {
  test(`${provider} launch authority revisions track only mutations and cannot be cloned or restored`, () => {
    const native = identity(provider);
    const registration = createFakeRegistrationRegistry([{ periodId: 'stamp-period', identity: native }]);
    const kernel = createLaunchBindingKernel({ registrationRegistry: registration.registry });
    const initial = kernel.registry.captureAuthorityRevision();
    for (const foreign of [undefined, {}, structuredClone(initial), JSON.parse(JSON.stringify(initial)), createLaunchBindingKernel({ registrationRegistry: registration.registry }).registry.captureAuthorityRevision()]) {
      assert.equal(kernel.registry.checkAuthorityRevision(foreign), false);
    }
    const input = claims({ provider, nativeIdKind: native.nativeIdKind });
    kernel.registry.observe(input, evidence('stamp-observe'));
    kernel.registry.snapshot();
    assert.equal(kernel.registry.checkAuthorityRevision(initial), true);
    const launch = kernel.authority.registerLaunch(input, evidence('stamp-register'));
    assert.equal(kernel.registry.checkAuthorityRevision(initial), false);
    let current = kernel.registry.captureAuthorityRevision();
    kernel.authority.registerLaunch(input, evidence('stamp-register'));
    assert.equal(kernel.registry.checkAuthorityRevision(current), true);
    const request = { identity: native, executionBinding: periodBinding('stamp-period'), evidence: evidence('stamp-bind', { registrationRef: launch.launchRef }) };
    kernel.authority.bindExecution(launch.launchRef, request);
    assert.equal(kernel.registry.checkAuthorityRevision(current), false);
    current = kernel.registry.captureAuthorityRevision();
    kernel.authority.bindExecution(launch.launchRef, request);
    assert.equal(kernel.registry.checkAuthorityRevision(current), true);
    assert.throws(() => kernel.authority.bindExecution(launch.launchRef, { ...request, executionBinding: periodBinding('other') }));
    assert.equal(kernel.registry.checkAuthorityRevision(current), true);
    kernel.authority.endLaunch(launch.launchRef);
    assert.equal(kernel.registry.checkAuthorityRevision(current), false);
    current = kernel.registry.captureAuthorityRevision();
    kernel.authority.endLaunch(launch.launchRef);
    assert.equal(kernel.registry.checkAuthorityRevision(current), true);
    assert.equal(kernel.registry.checkAuthorityRevision(initial), false);
    assert.equal(JSON.stringify(kernel.registry.snapshot()).includes('authorityRevision'), false);
  });
}
