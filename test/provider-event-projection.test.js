'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { createProviderEventAdapter, createProviderEventProjection } = require('../src/server/provider-event-projection');
const { createRegistrationFixture } = require('./support/registration');

const PROVIDERS = ['claude', 'codex'];

function createHarness(provider, options = {}) {
  const fixture = createRegistrationFixture(provider, options);
  const projection = createProviderEventProjection({
    registry: fixture.registry,
    resolveActorCorrelation: options.resolveActorCorrelation,
  });
  return { fixture, projection };
}

function nativeEvent(fixture, overrides = {}) {
  return {
    session_id: fixture.identity.nativeId,
    hook_event_name: 'PostToolUse',
    nativeEventId: 'native-event-1',
    sequence_number: 1,
    ...overrides,
  };
}

function commonEvent(fixture, overrides = {}) {
  return {
    session_id: fixture.registration.sessionId,
    hook_event_name: 'PostToolUse',
    tool_name: 'Bash',
    tool_use_id: 'tool-use-1',
    nativeEvent: nativeEvent(fixture),
    ...overrides,
  };
}

function authorizeChild(registration, actorId) {
  return {
    status: 'verified',
    actor: { kind: 'agent', id: actorId },
    binding: {
      identity: { ...registration.identity },
      conversationId: registration.conversationId,
      executionId: registration.executionId,
      sessionId: registration.sessionId,
    },
  };
}

for (const provider of PROVIDERS) {
  test(`${provider}: only the complete registered identity and writer project to the canonical period`, () => {
    const { fixture, projection } = createHarness(provider);
    const inspected = projection.inspect(fixture.writer, fixture.registration.sessionId);
    assert.equal(inspected.ok, true);
    inspected.registration.identity.nativeId = 'mutated-inspection';
    assert.equal(projection.inspect(fixture.writer, fixture.registration.sessionId).registration.identity.nativeId, fixture.identity.nativeId);
    assert.equal(projection.inspect(fixture.writer, 'unrelated-session').status, 'mismatch');

    const result = projection.project({
      writer: fixture.writer,
      sessionId: fixture.registration.sessionId,
      event: commonEvent(fixture),
    });

    assert.equal(result.action, 'apply');
    assert.equal(result.event.session_id, fixture.registration.sessionId);
    assert.equal(result.observation.conversationId, fixture.registration.conversationId);
    assert.equal(result.observation.executionId, fixture.registration.executionId);

    for (const field of ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']) {
      const alteredWriter = {
        ...fixture.writer,
        identity: { ...fixture.writer.identity, [field]: `${fixture.writer.identity[field]}-other` },
      };
      const rejected = projection.project({
        writer: alteredWriter,
        sessionId: fixture.registration.sessionId,
        event: commonEvent(fixture),
      });
      assert.equal(rejected.action, 'reject', field);
    }

    const missingWriter = projection.project({
      sessionId: fixture.registration.sessionId,
      event: commonEvent(fixture),
    });
    assert.equal(missingWriter.action, 'reject');
    const childWriter = {
      ...fixture.writer,
      identity: { ...fixture.writer.identity, nativeId: 'agent-child-1' },
    };
    const unboundChildWriter = projection.project({
      writer: childWriter,
      sessionId: fixture.registration.sessionId,
      event: commonEvent(fixture),
    });
    assert.equal(unboundChildWriter.action, 'reject');
    assert.deepEqual(projection.snapshot().map((row) => row.executionId), [fixture.registration.executionId]);
  });

  test(`${provider}: stale period writers cannot mutate a resumed period`, () => {
    const { fixture, projection } = createHarness(provider, { nativeId: `${provider}-resume-native` });
    const first = fixture.registration;
    assert.equal(fixture.authority.end(first.executionId), true);
    const resumed = fixture.adapter.register(fixture.nativeIdentity, {
      ...fixture.evidence,
      evidenceId: `${provider}-resume-evidence`,
    }, { startId: `${provider}-resume-start`, resume: true });
    const resumedWriter = fixture.adapter.bindWriter(resumed.executionId, {
      identity: fixture.identity,
      contextId: `${provider}-resume-context`,
      evidence: { ...fixture.evidence, evidenceId: `${provider}-resume-binding` },
    });

    const late = projection.project({
      writer: fixture.writer,
      sessionId: first.sessionId,
      event: commonEvent(fixture),
    });
    assert.equal(late.action, 'reject');
    assert.equal(late.status, 'stale_execution');

    const current = projection.project({
      writer: resumedWriter,
      sessionId: resumed.sessionId,
      event: commonEvent(fixture, {
        session_id: resumed.sessionId,
        nativeEvent: nativeEvent(fixture, { nativeEventId: 'resumed-event', sequence_number: 1 }),
      }),
    });
    assert.equal(current.action, 'apply');
    assert.equal(current.observation.executionId, resumed.executionId);
    assert.equal(current.observation.conversationId, first.conversationId);
    assert.deepEqual(projection.snapshot().map((row) => row.executionId), [resumed.executionId]);
  });

  test(`${provider}: child actors require trusted same-period binding evidence`, () => {
    const agentId = 'agent-child-1';
    const resolver = ({ registration, event }) => authorizeChild(registration, event.agent_id);
    const { fixture, projection } = createHarness(provider, { resolveActorCorrelation: resolver });
    const childEvent = commonEvent(fixture, {
      agent_id: agentId,
      nativeEvent: nativeEvent(fixture, {
        agent_id: agentId,
      }),
    });
    const result = projection.project({ writer: fixture.writer, sessionId: fixture.registration.sessionId, event: childEvent });

    assert.equal(result.action, 'apply');
    assert.equal(result.event.agent_id, agentId);
    assert.equal(result.observation.lastKnownState.period, 'active');
    assert.equal(result.observation.lastKnownState.actors.find((actor) => actor.id === agentId).active, true);
    assert.equal(fixture.registry.snapshot().executions[0].state, 'active');
  });

  test(`${provider}: child claims without a trusted resolver remain unknown`, () => {
    const { fixture, projection } = createHarness(provider);
    const childEvent = commonEvent(fixture, {
      agent_id: 'agent-child-1',
      verified: true,
      binding: { executionId: fixture.registration.executionId },
      nativeEvent: nativeEvent(fixture, { agent_id: 'agent-child-1', verified: true }),
    });
    const result = projection.project({ writer: fixture.writer, sessionId: fixture.registration.sessionId, event: childEvent });

    assert.equal(result.action, 'unknown');
    assert.equal(result.reason, 'actor_correlation_unavailable');
    assert.equal(result.observation.lastKnownState.period, 'active');
    assert.equal(result.observation.lastKnownState.actors.length, 0);
    assert.equal(JSON.stringify(projection.snapshot()).includes('agent-child-1'), false);
  });

  test(`${provider}: resolver errors and cross-period or cross-identity proofs cannot authorize a child`, () => {
    const agentId = 'agent-child-2';
    const event = (fixture) => commonEvent(fixture, {
      agent_id: agentId,
      nativeEvent: nativeEvent(fixture, { agent_id: agentId }),
    });
    const throwing = createHarness(provider, { resolveActorCorrelation() { throw new Error('resolver unavailable'); } });
    const failed = throwing.projection.project({
      writer: throwing.fixture.writer,
      sessionId: throwing.fixture.registration.sessionId,
      event: event(throwing.fixture),
    });
    assert.equal(failed.action, 'unknown');
    assert.equal(failed.reason, 'actor_correlation_failed');

    for (const invalidProof of [
      (registration) => ({ ...authorizeChild(registration, agentId), binding: { ...authorizeChild(registration, agentId).binding, executionId: 'other-period' } }),
      (registration) => ({ ...authorizeChild(registration, agentId), binding: { ...authorizeChild(registration, agentId).binding, identity: { ...registration.identity, hostId: 'other-host' } } }),
      (registration) => ({ ...authorizeChild(registration, 'other-agent') }),
    ]) {
      const harness = createHarness(provider, {
        resolveActorCorrelation: ({ registration }) => invalidProof(registration),
      });
      const rejectedProof = harness.projection.project({
        writer: harness.fixture.writer,
        sessionId: harness.fixture.registration.sessionId,
        event: event(harness.fixture),
      });
      assert.equal(rejectedProof.action, 'unknown');
      assert.equal(rejectedProof.reason, 'actor_binding_mismatch');
      assert.equal(rejectedProof.observation.lastKnownState.period, 'active');
      assert.equal(rejectedProof.observation.lastKnownState.actors.length, 0);
    }
  });

  test(`${provider}: nested native fields normalize into the registered session and foreign native sessions are rejected`, () => {
    const { fixture, projection } = createHarness(provider);
    const adapter = createProviderEventAdapter(provider, projection);
    const normalized = adapter.project({
      writer: fixture.writer,
      sessionId: fixture.registration.sessionId,
      event: {
        nativeEvent: nativeEvent(fixture, {
          tool_name: 'Bash',
          tool_use_id: 'native-tool-use',
        }),
      },
    });
    assert.equal(normalized.action, 'apply');
    assert.equal(normalized.event.session_id, fixture.registration.sessionId);
    assert.equal(normalized.event.tool_use_id, 'native-tool-use');

    const foreignSession = adapter.project({
      writer: fixture.writer,
      sessionId: fixture.registration.sessionId,
      event: {
        nativeEvent: nativeEvent(fixture, {
          session_id: 'unregistered-native-session',
          tool_name: 'Bash',
          tool_use_id: 'native-tool-use-foreign',
          nativeEventId: 'foreign-session-event',
        }),
      },
    });
    assert.equal(foreignSession.action, 'reject');
    assert.equal(foreignSession.status, 'mismatch');
  });

  test(`${provider}: conflicting outer and native event names are not applied`, () => {
    const { fixture, projection } = createHarness(provider);
    const result = projection.project({
      writer: fixture.writer,
      sessionId: fixture.registration.sessionId,
      event: commonEvent(fixture, {
        hook_event_name: 'Stop',
        nativeEvent: nativeEvent(fixture, { hook_event_name: 'SessionEnd' }),
      }),
    });

    assert.ok(['reject', 'unknown'].includes(result.action));
    assert.equal(projection.snapshot()[0]?.lastKnownState.period ?? 'active', 'active');
    assert.equal(fixture.registry.snapshot().executions[0].state, 'active');
  });

  test(`${provider}: repeated native event IDs apply once, and content conflicts remain unknown`, () => {
    const { fixture, projection } = createHarness(provider);
    const firstEvent = commonEvent(fixture);
    const first = projection.project({ writer: fixture.writer, sessionId: fixture.registration.sessionId, event: firstEvent });
    const replay = projection.project({ writer: fixture.writer, sessionId: fixture.registration.sessionId, event: firstEvent });
    const conflict = projection.project({
      writer: fixture.writer,
      sessionId: fixture.registration.sessionId,
      event: commonEvent(fixture, {
        summary: 'different content',
        nativeEvent: nativeEvent(fixture, { tool_use_id: 'different-tool-use' }),
      }),
    });

    assert.equal(first.action, 'apply');
    assert.equal(replay.action, 'duplicate');
    assert.equal(conflict.action, 'unknown');
    assert.equal(conflict.reason, 'event_id_content_conflict');
    assert.equal(conflict.observation.lastKnownState.period, 'active');
    assert.equal(conflict.observation.lastKnownState.rootTurn, 'working');
  });

  test(`${provider}: missing event IDs do not deduplicate equal timestamps or payloads`, () => {
    const { fixture, projection } = createHarness(provider);
    const unnumberedEvent = commonEvent(fixture, {
      hookAt: 100,
      nativeEvent: nativeEvent(fixture, {
        nativeEventId: undefined,
        event_id: undefined,
        sequence_number: undefined,
        sequenceNumber: undefined,
      }),
    });
    delete unnumberedEvent.nativeEvent.nativeEventId;
    delete unnumberedEvent.nativeEvent.event_id;
    delete unnumberedEvent.nativeEvent.sequence_number;
    delete unnumberedEvent.nativeEvent.sequenceNumber;
    const first = projection.project({ writer: fixture.writer, sessionId: fixture.registration.sessionId, event: unnumberedEvent });
    const second = projection.project({ writer: fixture.writer, sessionId: fixture.registration.sessionId, event: unnumberedEvent });
    const observation = projection.snapshot()[0];

    assert.equal(first.action, 'apply');
    assert.equal(second.action, 'apply');
    assert.equal(observation.dedupQuality, 'unknown');
    assert.equal(observation.orderingQuality, 'unknown');
    assert.ok(observation.reasons.includes('event_id_missing'));
    assert.ok(observation.reasons.includes('event_sequence_missing'));
  });

  test(`${provider}: a PostToolUse result without a correlating tool ID remains unknown`, () => {
    const { fixture, projection } = createHarness(provider);
    const result = projection.project({
      writer: fixture.writer,
      sessionId: fixture.registration.sessionId,
      event: commonEvent(fixture, {
        tool_use_id: undefined,
        nativeEvent: nativeEvent(fixture, {
          nativeEventId: 'uncorrelated-result',
          sequence_number: 1,
        }),
      }),
    });

    assert.equal(result.action, 'unknown');
    assert.equal(result.reason, 'tool_result_missing');
    assert.equal(result.observation.lastKnownState.period, 'active');
    assert.equal(result.observation.lastKnownState.rootTurn, 'unknown');
    assert.equal(fixture.registry.snapshot().executions[0].state, 'active');
  });

  test(`${provider}: sequence gaps and regressions stay unknown without inferring a period transition`, () => {
    const { fixture, projection } = createHarness(provider);
    const send = (sequence, nativeEventId, hookEventName = 'PostToolUse') => projection.project({
      writer: fixture.writer,
      sessionId: fixture.registration.sessionId,
      event: commonEvent(fixture, {
        hook_event_name: hookEventName,
        nativeEvent: nativeEvent(fixture, { hook_event_name: hookEventName, sequence_number: sequence, nativeEventId }),
      }),
    });
    assert.equal(send(20, 'sequence-20').action, 'apply');
    const gap = send(22, 'sequence-22', 'SessionEnd');
    assert.equal(gap.action, 'unknown');
    assert.equal(gap.reason, 'event_sequence_gap');
    assert.equal(gap.observation.lastKnownState.period, 'active');
    assert.ok(projection.snapshot()[0].reasons.includes('event_sequence_gap'));

    const regressionHarness = createHarness(provider, { nativeId: `${provider}-regression` });
    const sendRegression = (sequence, nativeEventId) => regressionHarness.projection.project({
      writer: regressionHarness.fixture.writer,
      sessionId: regressionHarness.fixture.registration.sessionId,
      event: commonEvent(regressionHarness.fixture, {
        nativeEvent: nativeEvent(regressionHarness.fixture, { sequence_number: sequence, nativeEventId }),
      }),
    });
    assert.equal(sendRegression(20, 'regression-sequence-20').action, 'apply');
    const regression = sendRegression(19, 'regression-sequence-19');
    assert.equal(regression.action, 'unknown');
    assert.equal(regression.reason, 'event_sequence_regressed');
    assert.equal(regression.observation.lastKnownState.period, 'active');
    assert.ok(regressionHarness.projection.snapshot()[0].reasons.includes('event_sequence_regressed'));
    assert.equal(fixture.registry.snapshot().executions[0].state, 'active');
  });

  test(`${provider}: Stop and Interrupt are turn events, while only parent SessionEnd observes period end`, () => {
    const agentId = 'agent-child-end';
    const { fixture, projection } = createHarness(provider, {
      resolveActorCorrelation: ({ registration, event }) => authorizeChild(registration, event.agent_id),
    });
    const send = (hookEventName, id, actor = '') => projection.project({
      writer: fixture.writer,
      sessionId: fixture.registration.sessionId,
      event: commonEvent(fixture, {
        hook_event_name: hookEventName,
        ...(actor ? { agent_id: actor } : {}),
        nativeEvent: nativeEvent(fixture, {
          hook_event_name: hookEventName,
          nativeEventId: id,
          sequence_number: undefined,
          ...(actor ? { agent_id: actor } : {}),
        }),
      }),
    });

    const stop = send('Stop', 'event-stop');
    const interrupt = send('Interrupt', 'event-interrupt');
    const childStop = send('Stop', 'event-child-stop', agentId);
    const childInterrupt = send('Interrupt', 'event-child-interrupt', agentId);
    const childEnd = send('SessionEnd', 'event-child-end', agentId);
    assert.equal(stop.action, 'apply');
    assert.equal(interrupt.action, 'apply');
    assert.equal(stop.event.hook_event_name, 'Stop');
    assert.equal(interrupt.event.hook_event_name, 'Interrupt');
    assert.equal(stop.observation.lastKnownState.rootTurn, 'waiting');
    assert.equal(interrupt.observation.lastKnownState.rootTurn, 'interrupted');
    assert.equal(childStop.action, 'apply');
    assert.equal(childStop.event.agent_id, agentId);
    assert.equal(childStop.observation.lastKnownState.rootTurn, 'interrupted');
    assert.equal(childStop.observation.lastKnownState.actors.find((actor) => actor.id === agentId).turn, 'waiting');
    assert.equal(childInterrupt.action, 'apply');
    assert.equal(childInterrupt.event.agent_id, agentId);
    assert.equal(childInterrupt.observation.lastKnownState.rootTurn, 'interrupted');
    assert.equal(childInterrupt.observation.lastKnownState.actors.find((actor) => actor.id === agentId).turn, 'interrupted');
    assert.equal(childEnd.action, 'apply');
    assert.equal(childEnd.event.agent_id, agentId);
    assert.equal(childEnd.observation.lastKnownState.period, 'active');
    assert.equal(childEnd.observation.lastKnownState.rootTurn, 'interrupted');
    assert.equal(childEnd.observation.lastKnownState.actors.find((actor) => actor.id === agentId).active, false);
    assert.equal(fixture.registry.snapshot().executions[0].state, 'active');

    const parentEnd = send('SessionEnd', 'event-parent-end');
    assert.equal(parentEnd.action, 'apply');
    assert.equal(parentEnd.observation.lastKnownState.period, 'ended_observed');
    assert.equal(parentEnd.observation.lastKnownState.rootTurn, 'ended');
    assert.equal(fixture.registry.snapshot().executions[0].state, 'active');
    const replay = send('SessionEnd', 'event-parent-end');
    assert.equal(replay.action, 'duplicate');
    assert.equal(projection.project({
      writer: fixture.writer,
      sessionId: fixture.registration.sessionId,
      event: commonEvent(fixture, { nativeEvent: nativeEvent(fixture, { nativeEventId: 'after-end', sequence_number: undefined }) }),
    }).reason, 'period_end_observed');
  });

  test(`${provider}: SubagentStop closes only its correlated child and parent SessionEnd closes every child`, () => {
    const { fixture, projection } = createHarness(provider, {
      resolveActorCorrelation: ({ registration, event }) => authorizeChild(registration, event.agent_id),
    });
    const send = (hookEventName, nativeEventId, agentId = '') => projection.project({
      writer: fixture.writer,
      sessionId: fixture.registration.sessionId,
      event: commonEvent(fixture, {
        hook_event_name: hookEventName,
        ...(agentId ? { agent_id: agentId } : {}),
        nativeEvent: nativeEvent(fixture, {
          hook_event_name: hookEventName,
          nativeEventId,
          sequence_number: undefined,
          ...(agentId ? { agent_id: agentId } : {}),
        }),
      }),
    });

    const firstStart = send('SubagentStart', 'first-agent-start', 'agent-first');
    const secondStart = send('SubagentStart', 'second-agent-start', 'agent-second');
    assert.equal(firstStart.action, 'apply');
    assert.equal(secondStart.action, 'apply');
    assert.equal(firstStart.observation.lastKnownState.actors.find((actor) => actor.id === 'agent-first').active, true);
    assert.equal(secondStart.observation.lastKnownState.actors.find((actor) => actor.id === 'agent-second').active, true);

    const firstStop = send('SubagentStop', 'first-agent-stop', 'agent-first');
    assert.equal(firstStop.action, 'apply');
    assert.equal(firstStop.observation.lastKnownState.period, 'active');
    assert.equal(firstStop.observation.lastKnownState.actors.find((actor) => actor.id === 'agent-first').active, false);
    assert.equal(firstStop.observation.lastKnownState.actors.find((actor) => actor.id === 'agent-second').active, true);

    const delayedRestart = send('SubagentStart', 'late-agent-restart', 'agent-first');
    assert.equal(delayedRestart.action, 'unknown');
    assert.equal(delayedRestart.observation.lastKnownState.actors.find((actor) => actor.id === 'agent-first').active, false);
    assert.equal(delayedRestart.observation.lastKnownState.actors.find((actor) => actor.id === 'agent-second').active, true);

    const parentEnd = send('SessionEnd', 'parent-session-end');
    assert.equal(parentEnd.action, 'apply');
    assert.equal(parentEnd.observation.lastKnownState.period, 'ended_observed');
    assert.ok(parentEnd.observation.lastKnownState.actors.every((actor) => actor.active === false));
    assert.equal(fixture.registry.snapshot().executions[0].state, 'active');
  });

  test(`${provider}: unknown observations preserve known state and snapshots expose no authority material`, () => {
    const { fixture, projection } = createHarness(provider);
    const applied = projection.project({
      writer: fixture.writer,
      sessionId: fixture.registration.sessionId,
      event: commonEvent(fixture),
    });
    assert.equal(applied.action, 'apply');
    const unknown = projection.observeUnknown({
      writer: fixture.writer,
      sessionId: fixture.registration.sessionId,
      reason: 'collector_disconnected',
    });
    const missingResult = projection.observeUnknown({
      writer: fixture.writer,
      sessionId: fixture.registration.sessionId,
      reason: 'tool_result_missing',
    });
    const permission = projection.project({
      writer: fixture.writer,
      sessionId: fixture.registration.sessionId,
      event: commonEvent(fixture, {
        hook_event_name: 'PermissionRequest',
        nativeEvent: nativeEvent(fixture, {
          hook_event_name: 'PermissionRequest',
          nativeEventId: 'permission-request',
          sequence_number: 2,
        }),
      }),
    });
    assert.equal(unknown.ok, true);
    assert.equal(missingResult.ok, true);
    assert.equal(permission.action, 'unknown');
    assert.equal(permission.reason, 'permission_unresolved');
    assert.equal(unknown.observation.lastKnownState.period, 'active');
    assert.equal(unknown.observation.lastKnownState.rootTurn, 'working');
    assert.ok(unknown.observation.reasons.includes('collector_disconnected'));
    assert.ok(missingResult.observation.reasons.includes('tool_result_missing'));
    assert.equal(permission.observation.lastKnownState.rootTurn, 'working');

    const snapshot = projection.snapshot();
    snapshot[0].lastKnownState.rootTurn = 'tampered';
    snapshot[0].lastKnownState.actors.push({ id: 'tampered', active: true, turn: 'working' });
    snapshot[0].reasons.push('tampered');
    assert.equal(projection.snapshot()[0].lastKnownState.rootTurn, 'working');
    assert.equal(projection.snapshot()[0].lastKnownState.actors.length, 0);
    assert.equal(projection.snapshot()[0].reasons.includes('tampered'), false);
    const exposed = JSON.stringify(projection.snapshot());
    assert.equal(exposed.includes(fixture.writer.token), false);
    assert.equal(exposed.includes('authority'), false);
    assert.equal(exposed.includes('secret'), false);
  });
}
