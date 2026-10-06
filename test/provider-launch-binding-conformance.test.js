'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createRegistrationKernel } = require('../src/server/conversation-registry');
const { createProviderRegistrationAdapter } = require('../src/server/provider-registration');
const {
  createLaunchBindingKernel,
  createProviderLaunchAdapter,
} = require('../src/server/launch-binding');

const PROVIDERS = ['claude', 'codex'];
const NATIVE_ID_KINDS = { claude: 'session', codex: 'thread' };

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

function identity(provider, suffix) {
  return {
    provider,
    nativeIdKind: NATIVE_ID_KINDS[provider],
    hostId: 'host-' + suffix,
    homeScopeId: 'home-' + suffix,
    nativeId: provider + '-native-' + suffix,
  };
}

function nativeIdentity(fullIdentity) {
  return {
    nativeIdKind: fullIdentity.nativeIdKind,
    hostId: fullIdentity.hostId,
    homeScopeId: fullIdentity.homeScopeId,
    nativeId: fullIdentity.nativeId,
  };
}

function actor(kind = 'agent', id = 'agent-one') {
  return { kind, id };
}

function periodBinding(periodId, actorValue = actor()) {
  return { periodId, actor: actorValue };
}

function launchClaims(fullIdentity, overrides = {}) {
  return {
    launchId: 'launch-' + fullIdentity.nativeId,
    runId: 'run-' + fullIdentity.nativeId,
    attemptId: 'attempt-one',
    provider: fullIdentity.provider,
    nativeIdKind: fullIdentity.nativeIdKind,
    hostId: fullIdentity.hostId,
    homeScopeId: fullIdentity.homeScopeId,
    origin: 'standalone',
    purpose: 'agent',
    originBinding: null,
    ...overrides,
  };
}

function createHarness() {
  const registrationKernel = createRegistrationKernel();
  const effects = {
    periodRegistrations: 0,
    periodEnds: 0,
    writerIssuance: 0,
  };
  const instrumentedAuthority = new Proxy({ ...registrationKernel.authority }, {
    get(target, property) {
      if (property === 'register') {
        return (...args) => {
          effects.periodRegistrations += 1;
          return target.register(...args);
        };
      }
      if (property === 'bindWriter') {
        return (...args) => {
          effects.writerIssuance += 1;
          return target.bindWriter(...args);
        };
      }
      if (property === 'end') {
        return (...args) => {
          effects.periodEnds += 1;
          return target.end(...args);
        };
      }
      return target[property];
    },
  });
  const registrationAdapters = Object.fromEntries(PROVIDERS.map((provider) => [
    provider,
    createProviderRegistrationAdapter(provider, registrationKernel.registry, instrumentedAuthority),
  ]));
  const launchKernel = createLaunchBindingKernel({ registrationRegistry: registrationKernel.registry });
  const launchAdapters = Object.fromEntries(PROVIDERS.map((provider) => [
    provider,
    createProviderLaunchAdapter(provider, launchKernel.registry, launchKernel.authority),
  ]));
  return {
    registrationKernel,
    registrationAdapters,
    launchKernel,
    launchAdapters,
    registrationAuthority: instrumentedAuthority,
    effects,
  };
}

function registerPeriod(harness, provider, suffix, { resume = false, identitySuffix = suffix } = {}) {
  const fullIdentity = identity(provider, identitySuffix);
  const startId = 'start-' + suffix;
  const registration = harness.registrationAdapters[provider].register(
    nativeIdentity(fullIdentity),
    evidence('period-evidence-' + suffix),
    {
      startId,
      ...(resume ? { resume: true } : {}),
      ...(!resume && provider === 'claude' ? { projectionId: fullIdentity.nativeId } : {}),
    },
  );
  return { identity: fullIdentity, registration };
}

function snapshot(harness) {
  return harness.registrationKernel.registry.snapshot();
}

function assertCode(action, code) {
  assert.throws(action, (error) => error.code === code && !error.message.includes('private'));
}

function assertProhibitedEffectsZero(harness) {
  assert.equal(harness.effects.writerIssuance, 0);
  assert.equal(typeof harness.launchKernel.authority.bindWriter, 'undefined');
  assert.equal(typeof harness.launchKernel.authority.authorizeWrite, 'undefined');
  assert.equal(typeof harness.launchKernel.authority.changeOwner, 'undefined');
  assert.equal(typeof harness.launchKernel.authority.handoff, 'undefined');
}

function assertUnchanged(actual, expected) {
  assert.deepEqual(actual, expected);
}

test('ID-F02-L01: 公開observeは外部metadataを認証へ昇格せず副作用を起こさない', { timeout: 1000 }, () => {
  for (const provider of PROVIDERS) {
    const harness = createHarness();
    const fullIdentity = identity(provider, 'observe-' + provider);
    const candidate = launchClaims(fullIdentity);
    const before166 = snapshot(harness);
    const hostileEvidence = evidence('observe-evidence-' + provider, {
      verified: true,
      pid: 1234,
      cwd: 'private-working-directory',
      timestamp: 'nearby-time',
      inheritedClaudeId: 'private-claude-id',
      secret: 'private-secret',
      payload: 'private-payload',
    });

    const result = harness.launchAdapters[provider].observe(candidate, hostileEvidence);
    assert.deepEqual([result.ok, result.status], [true, 'unverified'], provider);
    assertUnchanged(snapshot(harness), before166);
    const launchSnapshot = harness.launchKernel.registry.snapshot();
    assert.deepEqual(launchSnapshot.launches, []);
    assert.equal(launchSnapshot.observations.length, 1);
    assert.equal(launchSnapshot.observations[0].status, 'unverified');
    for (const field of ['verified', 'pid', 'cwd', 'timestamp', 'inheritedClaudeId', 'secret', 'payload']) {
      assert.equal(Object.hasOwn(launchSnapshot.observations[0].metadata, field), false, provider + '/' + field);
    }
    assert.equal(JSON.stringify(launchSnapshot).includes('private-working-directory'), false, provider);
    assert.equal(JSON.stringify(launchSnapshot).includes('private-claude-id'), false, provider);
    assert.equal(JSON.stringify(launchSnapshot).includes('private-secret'), false, provider);
    assert.equal(JSON.stringify(launchSnapshot).includes('private-payload'), false, provider);
    assert.equal(harness.effects.periodRegistrations, 0, provider);
    assertProhibitedEffectsZero(harness);
  }
});

test('ID-F02-L02: Claude/Codex launch adapterは同一attemptだけを冪等登録する', { timeout: 1000 }, () => {
  for (const provider of PROVIDERS) {
    const harness = createHarness();
    const parentProvider = provider === 'claude' ? 'codex' : 'claude';
    const parent = registerPeriod(harness, parentProvider, 'parent-' + provider);
    const fullIdentity = identity(provider, 'launch-replay-' + provider);
    const actorClaim = periodBinding(parent.registration.executionId, actor('tool-use', 'parent-tool'));
    const scenarios = [
      { origin: 'standalone', purpose: 'agent', originBinding: null },
      { origin: 'standalone', purpose: 'pr-creator', originBinding: null },
      { origin: 'delegated', purpose: 'agent', originBinding: actorClaim },
      { origin: 'review', purpose: 'cross-review', originBinding: actorClaim },
    ];

    for (const [index, scenario] of scenarios.entries()) {
      const claims = launchClaims(fullIdentity, {
        launchId: 'scenario-' + provider + '-' + index,
        runId: 'run-' + provider + '-' + index,
        attemptId: 'attempt-' + provider + '-' + index,
        ...scenario,
      });
      const startEvidence = evidence('launch-start-' + provider + '-' + index);
      const registered = harness.launchAdapters[provider].registerLaunch(claims, startEvidence);
      const replay = harness.launchAdapters[provider].registerLaunch(
        structuredClone(claims),
        structuredClone(startEvidence),
      );
      assert.deepEqual(replay, registered, provider + '/' + scenario.origin + '/' + scenario.purpose);

      const saved = harness.launchKernel.registry.get(registered.launchRef);
      const conflictClaims = { ...claims, hostId: claims.hostId + '-changed' };
      assertCode(
        () => harness.launchAdapters[provider].registerLaunch(conflictClaims, evidence('changed-scope-' + index)),
        'launch_conflict',
      );
      assertCode(
        () => harness.launchAdapters[provider].registerLaunch(claims, evidence('changed-evidence-' + index)),
        'launch_conflict',
      );
      if (claims.originBinding) {
        const changedActor = structuredClone(claims);
        changedActor.originBinding.actor.id += '-changed';
        assertCode(
          () => harness.launchAdapters[provider].registerLaunch(changedActor, evidence('changed-actor-' + index)),
          'launch_conflict',
        );
      }
      assert.deepEqual(harness.launchKernel.registry.get(registered.launchRef), saved, provider);
    }

    const first = scenarios[0];
    const firstClaims = launchClaims(fullIdentity, {
      launchId: 'scenario-' + provider + '-0',
      runId: 'run-' + provider + '-0',
      attemptId: 'attempt-' + provider + '-0',
      ...first,
    });
    const alternateProvider = provider === 'claude' ? 'codex' : 'claude';
    assertCode(() => harness.launchAdapters[alternateProvider].registerLaunch({
      ...firstClaims,
      provider: alternateProvider,
      nativeIdKind: NATIVE_ID_KINDS[alternateProvider],
    }, evidence('provider-conflict-' + provider)), 'launch_conflict');
    assertCode(() => harness.launchAdapters[provider].registerLaunch({
      ...firstClaims,
      attemptId: 'evidence-reuse-attempt-' + provider,
    }, evidence('launch-start-' + provider + '-0')), 'evidence_conflict');

    assert.equal(harness.launchKernel.registry.snapshot().launches.length, scenarios.length, provider);
    assert.equal(harness.effects.periodRegistrations, 1, provider);
    assertProhibitedEffectsZero(harness);
  }
});

test('ID-F02-L03: active periodへのbindingは再送可能で別attemptの宛先重複を拒否する', { timeout: 1000 }, () => {
  for (const provider of PROVIDERS) {
    const harness = createHarness();
    const child = registerPeriod(harness, provider, 'binding-' + provider);
    const claims = launchClaims(child.identity);
    const launch = harness.launchAdapters[provider].registerLaunch(
      claims,
      evidence('binding-start-' + provider),
    );
    const binding = {
      identity: { ...child.identity },
      executionBinding: periodBinding(child.registration.executionId, actor('agent', 'child-' + provider)),
      evidence: evidence('binding-evidence-' + provider, { registrationRef: launch.launchRef }),
    };
    const before166 = snapshot(harness);
    const bound = harness.launchAdapters[provider].bindExecution(launch.launchRef, binding);
    assert.equal(bound.state, 'bound', provider);
    assert.equal(bound.executionBinding.periodId, child.registration.executionId, provider);
    assert.equal(bound.conversationId, child.registration.conversationId, provider);
    assert.equal(bound.sessionId, child.registration.sessionId, provider);
    assert.equal(bound.bindingEvidence.registrationRef, launch.launchRef, provider);
    const afterBind166 = snapshot(harness);
    assertUnchanged(afterBind166, before166);

    const replay = harness.launchAdapters[provider].bindExecution(launch.launchRef, structuredClone(binding));
    assert.deepEqual(replay, bound, provider);
    const writerAttempt = harness.registrationAdapters[provider].authorizeWrite({
      token: launch.launchRef,
      identity: { ...child.identity },
      contextId: 'launch-ref-is-not-writer',
      executionId: child.registration.executionId,
    }, { ...child.identity, contextId: 'launch-ref-is-not-writer' });
    assert.equal(writerAttempt.ok, false, provider);
    assertUnchanged(snapshot(harness), afterBind166);

    const second = harness.launchAdapters[provider].registerLaunch(
      { ...claims, launchId: claims.launchId + '-other', attemptId: claims.attemptId + '-other' },
      evidence('duplicate-start-' + provider),
    );
    const beforeDuplicate = snapshot(harness);
    assertCode(() => harness.launchAdapters[provider].bindExecution(second.launchRef, {
      identity: { ...child.identity },
      executionBinding: structuredClone(binding.executionBinding),
      evidence: evidence('duplicate-binding-' + provider, { registrationRef: second.launchRef }),
    }), 'duplicate_execution_binding');
    assertUnchanged(snapshot(harness), beforeDuplicate);
    assert.equal(harness.launchKernel.registry.get(second.launchRef).state, 'registered', provider);
    assert.equal(harness.effects.periodRegistrations, 1, provider);
    assertProhibitedEffectsZero(harness);
  }
});

test('ID-F02-L04: binding後のclaim差し替えと不一致identityは拒否される', { timeout: 1000 }, () => {
  for (const provider of PROVIDERS) {
    const harness = createHarness();
    const child = registerPeriod(harness, provider, 'claims-' + provider);
    const other = registerPeriod(harness, provider, 'other-claims-' + provider);
    const validClaims = launchClaims(child.identity, {
      launchId: 'claims-launch-' + provider,
      attemptId: 'claims-attempt-' + provider,
    });
    const baseline166 = snapshot(harness);

    const invalidCases = [
      {
        name: 'provider',
        identity: identity(provider === 'claude' ? 'codex' : 'claude', 'wrong-provider'),
        code: 'invalid_binding',
      },
      {
        name: 'native kind',
        identity: { ...child.identity, nativeIdKind: provider === 'claude' ? 'thread' : 'session' },
        code: 'invalid_binding',
      },
      { name: 'host', identity: { ...child.identity, hostId: 'wrong-host' }, code: 'identity_mismatch' },
      { name: 'HOME', identity: { ...child.identity, homeScopeId: 'wrong-home' }, code: 'identity_mismatch' },
      { name: 'native ID', identity: { ...child.identity, nativeId: 'wrong-native-id' }, code: 'identity_mismatch' },
      {
        name: 'period identity',
        identity: { ...child.identity },
        executionBinding: periodBinding(other.registration.executionId),
        code: 'identity_mismatch',
      },
      {
        name: 'registration reference',
        identity: { ...child.identity },
        evidenceRegistrationRef: 'different-launch-ref',
        code: 'invalid_binding',
      },
    ];

    for (const [index, invalid] of invalidCases.entries()) {
      const launch = harness.launchAdapters[provider].registerLaunch({
        ...validClaims,
        launchId: validClaims.launchId + '-' + index,
        attemptId: validClaims.attemptId + '-' + index,
      }, evidence('claims-start-' + provider + '-' + index));
      const beforeAttempt166 = snapshot(harness);
      assertCode(() => harness.launchAdapters[provider].bindExecution(launch.launchRef, {
        identity: invalid.identity,
        executionBinding: invalid.executionBinding ||
          periodBinding(child.registration.executionId, actor('agent', 'claim-agent-' + index)),
        evidence: evidence('claims-bind-' + provider + '-' + index, {
          registrationRef: invalid.evidenceRegistrationRef || launch.launchRef,
        }),
      }), invalid.code);
      assertUnchanged(snapshot(harness), beforeAttempt166);
      assert.equal(harness.launchKernel.registry.get(launch.launchRef).state, 'registered', invalid.name);
    }

    const validLaunch = harness.launchAdapters[provider].registerLaunch(validClaims, evidence('valid-start-' + provider));
    const validBinding = {
      identity: { ...child.identity },
      executionBinding: periodBinding(child.registration.executionId, actor('agent', 'valid-agent-' + provider)),
      evidence: evidence('valid-binding-evidence-' + provider, { registrationRef: validLaunch.launchRef }),
    };
    harness.launchAdapters[provider].bindExecution(validLaunch.launchRef, validBinding);
    const boundSnapshot = harness.launchKernel.registry.snapshot();

    const alteredActor = structuredClone(validBinding);
    alteredActor.executionBinding.actor.id += '-changed';
    alteredActor.evidence = evidence('altered-actor-evidence-' + provider, { registrationRef: validLaunch.launchRef });
    assertCode(
      () => harness.launchAdapters[provider].bindExecution(validLaunch.launchRef, alteredActor),
      'binding_conflict',
    );
    const alteredPeriod = structuredClone(validBinding);
    alteredPeriod.executionBinding.periodId = other.registration.executionId;
    alteredPeriod.evidence = evidence('altered-period-evidence-' + provider, { registrationRef: validLaunch.launchRef });
    assertCode(
      () => harness.launchAdapters[provider].bindExecution(validLaunch.launchRef, alteredPeriod),
      'binding_conflict',
    );
    const alteredEvidence = structuredClone(validBinding);
    alteredEvidence.evidence = evidence('altered-evidence-' + provider, { registrationRef: validLaunch.launchRef });
    assertCode(
      () => harness.launchAdapters[provider].bindExecution(validLaunch.launchRef, alteredEvidence),
      'binding_conflict',
    );
    assert.deepEqual(harness.launchKernel.registry.snapshot(), boundSnapshot);

    const reusedEvidenceLaunch = harness.launchAdapters[provider].registerLaunch({
      ...validClaims,
      launchId: validClaims.launchId + '-reuse',
      attemptId: validClaims.attemptId + '-reuse',
    }, evidence('reuse-start-' + provider));
    assertCode(() => harness.launchAdapters[provider].bindExecution(reusedEvidenceLaunch.launchRef, {
      identity: { ...child.identity },
      executionBinding: periodBinding(child.registration.executionId, actor('agent', 'unique-agent-' + provider)),
      evidence: evidence('valid-binding-evidence-' + provider, { registrationRef: reusedEvidenceLaunch.launchRef }),
    }), 'evidence_conflict');
    assertUnchanged(snapshot(harness), baseline166);
    assert.equal(harness.effects.periodRegistrations, 2, provider);
    assertProhibitedEffectsZero(harness);
  }
});

test('ID-F02-L05: 子bindingと親currentOwnerは別々に保持される', { timeout: 1000 }, () => {
  for (const provider of PROVIDERS) {
    const harness = createHarness();
    const parentProvider = provider === 'claude' ? 'codex' : 'claude';
    const parent = registerPeriod(harness, parentProvider, 'separate-parent-' + provider);
    const child = registerPeriod(harness, provider, 'separate-child-' + provider);
    const originBinding = periodBinding(parent.registration.executionId, actor('tool-use', 'parent-tool-' + provider));
    const claims = launchClaims(child.identity, {
      origin: 'delegated',
      purpose: 'agent',
      originBinding: structuredClone(originBinding),
    });
    const launch = harness.launchAdapters[provider].registerLaunch(
      claims,
      evidence('separate-start-' + provider),
    );
    const binding = {
      identity: { ...child.identity },
      executionBinding: periodBinding(child.registration.executionId, actor('agent', 'child-agent-' + provider)),
      evidence: evidence('separate-binding-' + provider, { registrationRef: launch.launchRef }),
    };
    const before166 = snapshot(harness);
    const result = harness.launchAdapters[provider].bindExecution(launch.launchRef, binding);
    assertUnchanged(snapshot(harness), before166);
    assert.equal(result.executionBinding.periodId, child.registration.executionId, provider);
    assert.equal(result.conversationId, child.registration.conversationId, provider);
    assert.equal(result.sessionId, child.registration.sessionId, provider);
    assert.deepEqual(result.originBinding, originBinding, provider);
    assert.deepEqual(result.currentOwner, originBinding, provider);
    assert.notEqual(result.currentOwner.periodId, result.executionBinding.periodId, provider);
    assert.equal(result.ownerGeneration, 0, provider);
    assert.equal(result.currentProof, null, provider);

    result.originBinding.actor.id = 'mutated-return';
    result.currentOwner.actor.id = 'mutated-return';
    binding.executionBinding.actor.id = 'mutated-input';
    const saved = harness.launchKernel.registry.get(launch.launchRef);
    assert.deepEqual(saved.originBinding, originBinding, provider);
    assert.deepEqual(saved.currentOwner, originBinding, provider);
    assert.equal(saved.executionBinding.actor.id, 'child-agent-' + provider, provider);

    assert.equal(harness.registrationAuthority.end(parent.registration.executionId), true, provider);
    const afterParentEnd166 = snapshot(harness);
    const savedBindingReplay = {
      identity: saved.identity,
      executionBinding: saved.executionBinding,
      evidence: saved.bindingEvidence,
    };
    assertCode(
      () => harness.launchAdapters[provider].bindExecution(launch.launchRef, savedBindingReplay),
      'stale_origin',
    );
    assertUnchanged(snapshot(harness), afterParentEnd166);
    const afterEndedParentReplay = harness.launchKernel.registry.get(launch.launchRef);
    assert.equal(afterEndedParentReplay.state, 'bound', provider);
    assert.deepEqual(afterEndedParentReplay.identity, saved.identity, provider);
    assert.deepEqual(afterEndedParentReplay.executionBinding, saved.executionBinding, provider);
    assert.equal(afterEndedParentReplay.currentProof, null, provider);
    assert.equal(
      afterParentEnd166.executions.find((item) => item.executionId === child.registration.executionId).state,
      'active',
      provider,
    );
    assert.equal(harness.effects.periodRegistrations, 2, provider);
    assert.equal(harness.effects.periodEnds, 1, provider);
    assertProhibitedEffectsZero(harness);
  }
});

test('ID-F02-L06: 終了後の遅延bindingと再送は旧launch・periodを復活させない', { timeout: 1000 }, () => {
  for (const provider of PROVIDERS) {
    const harness = createHarness();
    const child = registerPeriod(harness, provider, 'lifecycle-' + provider);
    const claims = launchClaims(child.identity, {
      launchId: 'lifecycle-launch-' + provider,
      runId: 'lifecycle-run-' + provider,
      attemptId: 'attempt-one',
    });
    const startEvidence = evidence('lifecycle-start-' + provider);
    const launch = harness.launchAdapters[provider].registerLaunch(claims, startEvidence);
    const oldPeriod = child.registration.executionId;
    assert.equal(harness.registrationAuthority.end(oldPeriod), true);
    const ended166 = snapshot(harness);
    const effectsAtEnd = structuredClone(harness.effects);

    assertCode(() => harness.launchAdapters[provider].bindExecution(launch.launchRef, {
      identity: { ...child.identity },
      executionBinding: periodBinding(oldPeriod, actor('agent', 'late-agent-' + provider)),
      evidence: evidence('late-binding-' + provider, { registrationRef: launch.launchRef }),
    }), 'stale_period');
    assertUnchanged(snapshot(harness), ended166);
    assert.deepEqual(harness.effects, effectsAtEnd);
    assert.deepEqual(harness.launchAdapters[provider].registerLaunch(claims, startEvidence), launch);
    assert.equal(harness.launchKernel.registry.get(launch.launchRef).state, 'registered', provider);

    assert.equal(harness.launchAdapters[provider].endLaunch(launch.launchRef), true);
    assertUnchanged(snapshot(harness), ended166);
    assert.deepEqual(harness.launchAdapters[provider].registerLaunch(claims, startEvidence), launch);
    assert.equal(harness.launchKernel.registry.get(launch.launchRef).state, 'ended', provider);
    assertCode(() => harness.launchAdapters[provider].bindExecution(launch.launchRef, {
      identity: { ...child.identity },
      executionBinding: periodBinding(oldPeriod, actor('agent', 'late-agent-' + provider)),
      evidence: evidence('late-binding-after-end-' + provider, { registrationRef: launch.launchRef }),
    }), 'ended_launch');

    const resumed = registerPeriod(harness, provider, 'lifecycle-resume-' + provider, { resume: true, identitySuffix: 'lifecycle-' + provider });
    assert.notEqual(resumed.registration.executionId, oldPeriod, provider);
    const nextClaims = { ...claims, attemptId: 'attempt-two' };
    const nextLaunch = harness.launchAdapters[provider].registerLaunch(
      nextClaims,
      evidence('lifecycle-resumed-start-' + provider),
    );
    const nextBinding = harness.launchAdapters[provider].bindExecution(nextLaunch.launchRef, {
      identity: { ...resumed.identity },
      executionBinding: periodBinding(resumed.registration.executionId, actor('agent', 'new-agent-' + provider)),
      evidence: evidence('lifecycle-resumed-binding-' + provider, { registrationRef: nextLaunch.launchRef }),
    });
    assert.equal(nextBinding.state, 'bound', provider);
    assert.equal(nextBinding.executionBinding.periodId, resumed.registration.executionId, provider);
    assert.equal(harness.launchKernel.registry.get(launch.launchRef).state, 'ended', provider);
    const final166 = snapshot(harness);
    assert.equal(final166.executions.find((item) => item.executionId === oldPeriod).state, 'ended', provider);
    assert.equal(final166.executions.find((item) => item.executionId === resumed.registration.executionId).state, 'active', provider);
    assert.equal(harness.effects.periodRegistrations, 2, provider);
    assert.equal(harness.effects.periodEnds, 1, provider);
    assertProhibitedEffectsZero(harness);
  }
});
