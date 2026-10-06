'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { hookHeaders, jsonBody, request, startTestServer } = require('./support/server');
const { createRegistrationFixture } = require('./support/registration');

const PROVIDERS = ['claude', 'codex'];

function nativeEvent(fixture, name, overrides = {}) {
  return {
    session_id: fixture.identity.nativeId,
    hook_event_name: name,
    hook_at: 1_800_000_000_000,
    nativeEventId: `${fixture.identity.provider}-${name}-1`,
    sequence_number: 1,
    ...overrides,
  };
}

function eventRequestBody(fixture, event, overrides = {}) {
  return {
    session_id: fixture.registration.sessionId,
    writer: fixture.writer,
    nativeEvent: event,
    ...overrides,
  };
}

function trackedPullRequestOptions() {
  return {
    pullRequestTracker: {
      start() {},
      close() {},
      snapshot() { return []; },
      refreshRepo() { return Promise.resolve(); },
      refreshAll() { return Promise.resolve(); },
    },
    pullRequestMergeManager: {
      start() {},
      close() {},
      async setReviewSkip(_registration, headRefOid, reason) {
        return { ok: true, saved: { headRefOid, reason } };
      },
    },
  };
}

function createEffects() {
  return { addEvent: 0, captureFieldNames: 0, registerPullRequest: 0, afterEvent: 0, sessionEnded: 0, refreshRepo: 0, refreshAll: 0 };
}

function attachEffectSpy(server, effects) {
  for (const method of ['addEvent', 'captureFieldNames', 'registerPullRequest']) {
    const original = server.runtime.state[method].bind(server.runtime.state);
    server.runtime.state[method] = (...args) => {
      effects[method] += 1;
      return original(...args);
    };
  }
  const originalAfterEvent = server.runtime.answerDelivery.afterEvent.bind(server.runtime.answerDelivery);
  server.runtime.answerDelivery.afterEvent = (...args) => {
    effects.afterEvent += 1;
    return originalAfterEvent(...args);
  };
  const originalSessionEnded = server.runtime.answerDelivery.sessionEnded.bind(server.runtime.answerDelivery);
  server.runtime.answerDelivery.sessionEnded = (...args) => {
    effects.sessionEnded += 1;
    return originalSessionEnded(...args);
  };
  for (const method of ['refreshRepo', 'refreshAll']) {
    const original = server.runtime.pullRequestTracker[method].bind(server.runtime.pullRequestTracker);
    server.runtime.pullRequestTracker[method] = (...args) => {
      effects[method] += 1;
      return original(...args);
    };
  }
}

async function postEvent(server, body) {
  return request(server.info.port, {
    method: 'POST',
    path: '/api/events',
    headers: hookHeaders(server.info.secret, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

async function readState(server) {
  const response = await request(server.info.port, { path: '/api/state' });
  assert.equal(response.status, 200);
  return jsonBody(response);
}

function providerEvent(snapshot, executionId) {
  return snapshot.providerEvents.find((item) => item.executionId === executionId);
}

function trustedActorCorrelation(registration) {
  return ({ registration: observed, event }) => ({
    status: 'verified',
    binding: {
      identity: { ...registration.identity },
      conversationId: registration.registration.conversationId,
      executionId: registration.registration.executionId,
      sessionId: registration.registration.sessionId,
    },
    actor: { kind: 'agent', id: event.agent_id || event.nativeEvent?.agent_id },
  });
}

for (const provider of PROVIDERS) {
  test(`${provider} HTTP adapter binds native identity and writer to the registered execution`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-http-binding` });
    const server = await startTestServer(t, { registrationRegistry: fixture.registry });
    const effects = createEffects();
    attachEffectSpy(server, effects);

    const accepted = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'UserPromptSubmit')));
    assert.equal(accepted.status, 202, provider);
    assert.deepEqual(jsonBody(accepted), { accepted: true }, provider);

    const beforeReject = JSON.stringify(server.runtime.state.snapshot());
    const effectsBeforeReject = structuredClone(effects);
    const mismatch = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'UserPromptSubmit', {
      session_id: `${fixture.identity.nativeId}-other`,
      nativeEventId: `${provider}-wrong-native-session`,
      sequence_number: 2,
    })));
    assert.equal(mismatch.status, 403, provider);
    assert.equal(JSON.stringify(server.runtime.state.snapshot()), beforeReject, provider);
    assert.deepEqual(effects, effectsBeforeReject, provider);

    const state = await readState(server);
    const projection = providerEvent(state, fixture.registration.executionId);
    assert.equal(projection.provider, provider);
    assert.equal(projection.conversationId, fixture.registration.conversationId);
    assert.equal(projection.executionId, fixture.registration.executionId);
    assert.equal(projection.sessionId, fixture.registration.sessionId);
    assert.ok(state.sessions.some((session) => session.session_id === fixture.registration.sessionId), provider);
  });

  test(`${provider} HTTP adapter isolates a delayed old-period writer after a new period resumes`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-http-late-period` });
    const server = await startTestServer(t, { registrationRegistry: fixture.registry });
    const first = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'UserPromptSubmit')));
    assert.equal(first.status, 202, provider);
    const beforeLateEvent = JSON.stringify(server.runtime.state.snapshot());

    assert.equal(fixture.authority.end(fixture.registration.executionId), true);
    const resumed = fixture.adapter.register(fixture.nativeIdentity, {
      ...fixture.evidence,
      evidenceId: `${provider}-late-period-resume-evidence`,
    }, { startId: `${provider}-late-period-resume-start`, resume: true });
    const resumedWriter = fixture.adapter.bindWriter(resumed.executionId, {
      identity: fixture.identity,
      contextId: `${provider}-late-period-resume-context`,
      evidence: { ...fixture.evidence, evidenceId: `${provider}-late-period-resume-binding` },
    });

    const stale = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'PostToolUse', {
      nativeEventId: `${provider}-delayed-old-event`,
      sequence_number: 2,
      tool_name: 'Bash',
      tool_use_id: 'old-period-tool',
    })));
    assert.equal(stale.status, 403, provider);
    assert.equal(JSON.stringify(server.runtime.state.snapshot()), beforeLateEvent, provider);

    const current = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'UserPromptSubmit', {
      nativeEventId: `${provider}-new-period-event`,
      sequence_number: 1,
    }), { session_id: resumed.sessionId, writer: resumedWriter }));
    assert.equal(current.status, 202, provider);
    const projection = providerEvent(await readState(server), resumed.executionId);
    assert.equal(projection.sessionId, resumed.sessionId, provider);
    assert.equal(projection.lastKnownState.rootTurn, 'working', provider);
  });

  test(`${provider} HTTP adapter keeps Stop, Interrupt, and SessionEnd semantically distinct`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-http-turn-state` });
    const server = await startTestServer(t, { registrationRegistry: fixture.registry });
    const names = ['UserPromptSubmit', 'Stop', 'Interrupt', 'SessionEnd'];
    const expectedTurns = ['working', 'waiting', 'interrupted', 'ended'];

    for (let index = 0; index < names.length; index += 1) {
      const native = nativeEvent(fixture, names[index], {
        nativeEventId: `${provider}-turn-${index + 1}`,
        sequence_number: index + 1,
      });
      const response = await postEvent(server, eventRequestBody(fixture, native));
      assert.equal(response.status, 202, `${provider}/${names[index]}`);
      const state = await readState(server);
      const projection = providerEvent(state, fixture.registration.executionId);
      assert.equal(projection.lastKnownState.rootTurn, expectedTurns[index], `${provider}/${names[index]}`);
      if (names[index] === 'SessionEnd') {
        assert.equal(projection.lastKnownState.period, 'ended_observed', provider);
        assert.equal(fixture.registry.snapshot().executions.find((item) => item.executionId === fixture.registration.executionId).state, 'active', provider);
      }
    }

    const before = JSON.stringify(server.runtime.state.snapshot());
    const postEnd = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'UserPromptSubmit', {
      nativeEventId: `${provider}-after-end`,
      sequence_number: 5,
    })));
    assert.equal(postEnd.status, 202, provider);
    assert.deepEqual(jsonBody(postEnd), { accepted: false, status: 'unknown', reason: 'period_end_observed' }, provider);
    assert.equal(JSON.stringify(server.runtime.state.snapshot()), before, provider);
  });

  test(`${provider} HTTP adapter deduplicates provider IDs and keeps ID conflicts and unsequenced observations unknown`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-http-dedup` });
    const server = await startTestServer(t, { registrationRegistry: fixture.registry });
    const effects = createEffects();
    attachEffectSpy(server, effects);
    const firstNative = nativeEvent(fixture, 'UserPromptSubmit', {
      nativeEventId: `${provider}-stable-id`, sequence_number: 1,
    });
    const first = await postEvent(server, eventRequestBody(fixture, firstNative));
    assert.equal(first.status, 202, provider);
    const acceptedEffects = structuredClone(effects);

    const duplicate = await postEvent(server, eventRequestBody(fixture, structuredClone(firstNative)));
    assert.equal(duplicate.status, 202, provider);
    assert.deepEqual(jsonBody(duplicate), { accepted: true, duplicate: true }, provider);
    assert.deepEqual(effects, acceptedEffects, provider);

    const conflict = await postEvent(server, eventRequestBody(fixture, {
      ...firstNative,
      summary: 'conflicting content under the same native event ID',
    }));
    assert.equal(conflict.status, 202, provider);
    assert.deepEqual(jsonBody(conflict), { accepted: false, status: 'unknown', reason: 'event_id_content_conflict' }, provider);
    assert.deepEqual(effects, acceptedEffects, provider);

    const unsequenced = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'UserPromptSubmit', {
      nativeEventId: undefined,
      sequence_number: undefined,
      hook_at: 1_800_000_000_001,
    })));
    assert.equal(unsequenced.status, 202, provider);
    assert.deepEqual(jsonBody(unsequenced), { accepted: true }, provider);
    assert.equal(effects.addEvent, acceptedEffects.addEvent + 1, provider);
    const state = await readState(server);
    const projection = providerEvent(state, fixture.registration.executionId);
    assert.equal(projection.dedupQuality, 'unknown', provider);
    assert.ok(projection.reasons.includes('event_id_missing'), provider);
    assert.ok(projection.reasons.includes('event_sequence_missing'), provider);
  });

  test(`${provider} HTTP adapter applies a PR event and refresh once across duplicate delivery`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-http-pr-dedup` });
    const effects = createEffects();
    const server = await startTestServer(t, {
      registrationRegistry: fixture.registry,
      ...trackedPullRequestOptions(),
    });
    attachEffectSpy(server, effects);
    const create = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'PreToolUse', {
      nativeEventId: `${provider}-create-pr-start`,
      sequence_number: 1,
      tool_name: 'Bash',
      tool_use_id: `${provider}-create-pr-tool`,
      ghPrCreateCommand: true,
    })));
    assert.equal(create.status, 202, provider);

    const pullRequestEvent = nativeEvent(fixture, 'PostToolUse', {
      nativeEventId: `${provider}-create-pr-result`,
      sequence_number: 2,
      tool_name: 'Bash',
      tool_use_id: `${provider}-create-pr-tool`,
      pullRequest: {
        owner: 'example',
        repo: 'projection-fixture',
        number: provider === 'claude' ? 71 : 72,
        url: `https://github.com/example/projection-fixture/pull/${provider === 'claude' ? 71 : 72}`,
      },
    });
    const registered = await postEvent(server, eventRequestBody(fixture, pullRequestEvent));
    assert.equal(registered.status, 202, provider);
    assert.equal(server.runtime.state.pullRequestRegistrations().length, 1, provider);
    const appliedEffects = structuredClone(effects);
    assert.equal(appliedEffects.registerPullRequest, 1, `${provider}/${JSON.stringify(appliedEffects)}`);
    assert.equal(appliedEffects.refreshRepo, 1, `${provider}/${JSON.stringify(appliedEffects)}`);
    assert.equal(appliedEffects.afterEvent, 2, `${provider}/${JSON.stringify(appliedEffects)}`);

    const duplicate = await postEvent(server, eventRequestBody(fixture, structuredClone(pullRequestEvent)));
    assert.equal(duplicate.status, 202, provider);
    assert.deepEqual(jsonBody(duplicate), { accepted: true, duplicate: true }, provider);
    assert.equal(server.runtime.state.pullRequestRegistrations().length, 1, provider);
    assert.deepEqual(effects, appliedEffects, provider);
  });

  test(`${provider} HTTP adapter leaves child events unknown without trusted actor correlation`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-http-child` });
    const server = await startTestServer(t, { registrationRegistry: fixture.registry });
    const effects = createEffects();
    attachEffectSpy(server, effects);
    const before = JSON.stringify(server.runtime.state.snapshot());
    const childEvent = nativeEvent(fixture, 'SubagentStart', {
      agent_id: `${provider}-child-1`,
      agent_type: 'Explore',
    });
    const response = await postEvent(server, eventRequestBody(fixture, childEvent));
    assert.equal(response.status, 202, provider);
    assert.deepEqual(jsonBody(response), {
      accepted: false,
      status: 'unknown',
      reason: 'actor_correlation_unavailable',
    }, provider);
    assert.equal(JSON.stringify(server.runtime.state.snapshot()), before, provider);
    assert.deepEqual(effects, createEffects(), provider);
  });

  test(`${provider} HTTP adapter scopes verified child stop to its actor and parent end to the period`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-http-actor` });
    const server = await startTestServer(t, {
      registrationRegistry: fixture.registry,
      resolveActorCorrelation: trustedActorCorrelation(fixture),
    });
    const effects = createEffects();
    attachEffectSpy(server, effects);
    const childId = `${provider}-child-2`;
    const childStart = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'SubagentStart', {
      agent_id: childId,
      agent_type: 'Explore',
      nativeEventId: `${provider}-child-start`,
      sequence_number: 1,
    })));
    assert.equal(childStart.status, 202, provider);
    assert.deepEqual(jsonBody(childStart), { accepted: true }, provider);

    const childStop = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'SubagentStop', {
      agent_id: childId,
      nativeEventId: `${provider}-child-stop`,
      sequence_number: 2,
    })));
    assert.equal(childStop.status, 202, provider);
    const afterChildStop = providerEvent(await readState(server), fixture.registration.executionId);
    assert.deepEqual(afterChildStop.lastKnownState.actors, [{ id: childId, active: false, turn: 'stopped' }], provider);
    assert.equal(afterChildStop.lastKnownState.period, 'active', provider);

    const parentEnd = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'SessionEnd', {
      nativeEventId: `${provider}-parent-end`,
      sequence_number: 3,
    })));
    assert.equal(parentEnd.status, 202, provider);
    const ended = providerEvent(await readState(server), fixture.registration.executionId);
    assert.equal(ended.lastKnownState.period, 'ended_observed', provider);
    assert.deepEqual(ended.lastKnownState.actors, [{ id: childId, active: false, turn: 'session_ended' }], provider);
  });

  test(`${provider} HTTP adapter keeps child lifecycle events from mutating parent delivery state`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-http-child-lifecycle` });
    const server = await startTestServer(t, {
      registrationRegistry: fixture.registry,
      resolveActorCorrelation: trustedActorCorrelation(fixture),
    });
    const effects = createEffects();
    attachEffectSpy(server, effects);
    const parentSessionId = fixture.registration.sessionId;
    const eventAt = 1_800_000_000_000;
    const parentTool = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'PreToolUse', {
      hook_at: eventAt,
      nativeEventId: `${provider}-parent-tool`,
      sequence_number: 1,
      tool_name: 'Read',
      tool_use_id: `${provider}-parent-read`,
    })));
    assert.equal(parentTool.status, 202, provider);
    const parentPermissionWait = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'Notification', {
      hook_at: eventAt + 1,
      nativeEventId: `${provider}-parent-permission`,
      sequence_number: 2,
      notification_type: 'permission_prompt',
      message: 'Waiting for parent tool permission',
    })));
    assert.equal(parentPermissionWait.status, 202, provider);

    const delivery = server.runtime.answerDelivery;
    delivery.startStop(parentSessionId, `${provider}-parent-stop-generation`, eventAt + 2);
    delivery.endedSessions.add(parentSessionId);
    delivery.notifySessions([parentSessionId], 'parent notification remains pending');
    const initialParentSession = server.runtime.state.snapshot().sessions.find((session) => session.session_id === parentSessionId);
    assert.ok(initialParentSession.tools.length > 0, provider);
    assert.ok(initialParentSession.permissionWaits.length > 0, provider);
    const rootActivity = (session) => ({
      tools: session.tools.filter((tool) => !tool.agent_id),
      permissionWaits: session.permissionWaits.filter((wait) => !wait.agent_id),
    });
    const initialRootActivity = rootActivity(initialParentSession);
    const parentBaseline = {
      ended: delivery.endedSessions.has(parentSessionId),
      stopGeneration: delivery.stopGenerations.get(parentSessionId),
      lastLifecycleAt: delivery.lastLifecycleAt.get(parentSessionId),
      notifications: [...delivery.sessionNotifications.get(parentSessionId)],
      turnState: initialParentSession.turnState,
      tools: structuredClone(initialRootActivity.tools),
      permissionWaits: structuredClone(initialRootActivity.permissionWaits),
    };
    const childId = `${provider}-lifecycle-child`;
    const childEvents = [
      nativeEvent(fixture, 'SubagentStart', {
        hook_at: eventAt + 3,
        nativeEventId: `${provider}-child-start`,
        sequence_number: 3,
        agent_id: childId,
        agent_type: 'Explore',
      }),
      nativeEvent(fixture, 'Stop', {
        hook_at: eventAt + 4,
        nativeEventId: `${provider}-child-stop-before-pre`,
        sequence_number: 4,
        agent_id: childId,
      }),
      nativeEvent(fixture, 'PreToolUse', {
        hook_at: eventAt + 5,
        nativeEventId: `${provider}-child-pre-tool`,
        sequence_number: 5,
        agent_id: childId,
        tool_name: 'Read',
        tool_use_id: `${provider}-child-read`,
      }),
      nativeEvent(fixture, 'Stop', {
        hook_at: eventAt + 6,
        nativeEventId: `${provider}-child-stop-before-post`,
        sequence_number: 6,
        agent_id: childId,
      }),
      nativeEvent(fixture, 'PostToolUse', {
        hook_at: eventAt + 7,
        nativeEventId: `${provider}-child-post-tool`,
        sequence_number: 7,
        agent_id: childId,
        tool_name: 'Read',
        tool_use_id: `${provider}-child-read`,
      }),
      nativeEvent(fixture, 'Stop', {
        hook_at: eventAt + 8,
        nativeEventId: `${provider}-child-stop-before-prompt`,
        sequence_number: 8,
        agent_id: childId,
      }),
      nativeEvent(fixture, 'UserPromptSubmit', {
        hook_at: eventAt + 9,
        nativeEventId: `${provider}-child-prompt`,
        sequence_number: 9,
        agent_id: childId,
      }),
      nativeEvent(fixture, 'SessionStart', {
        hook_at: eventAt + 10,
        nativeEventId: `${provider}-child-session-start`,
        sequence_number: 10,
        agent_id: childId,
        source: 'resume',
      }),
      nativeEvent(fixture, 'SessionEnd', {
        hook_at: eventAt + 11,
        nativeEventId: `${provider}-child-session-end`,
        sequence_number: 11,
        agent_id: childId,
      }),
    ];
    const expectedChildTurns = ['working', 'waiting', 'working', 'waiting', 'working', 'waiting', 'working', 'working', 'session_ended'];

    for (let index = 0; index < childEvents.length; index += 1) {
      const childEvent = childEvents[index];
      const response = await postEvent(server, eventRequestBody(fixture, childEvent));
      assert.equal(response.status, 202, `${provider}/${childEvent.hook_event_name}`);
      assert.deepEqual(jsonBody(response), { accepted: true }, `${provider}/${childEvent.hook_event_name}`);
      assert.equal(delivery.endedSessions.has(parentSessionId), parentBaseline.ended, `${provider}/${childEvent.hook_event_name}`);
      assert.equal(delivery.stopGenerations.get(parentSessionId), parentBaseline.stopGeneration, `${provider}/${childEvent.hook_event_name}`);
      assert.equal(delivery.lastLifecycleAt.get(parentSessionId), parentBaseline.lastLifecycleAt, `${provider}/${childEvent.hook_event_name}`);
      assert.deepEqual(delivery.sessionNotifications.get(parentSessionId), parentBaseline.notifications, `${provider}/${childEvent.hook_event_name}`);
      const parentSession = server.runtime.state.snapshot().sessions.find((session) => session.session_id === parentSessionId);
      assert.equal(parentSession.turnState, parentBaseline.turnState, `${provider}/${childEvent.hook_event_name}`);
      const rootActivityAfterChild = rootActivity(parentSession);
      assert.deepEqual(rootActivityAfterChild.tools, parentBaseline.tools, `${provider}/${childEvent.hook_event_name}`);
      assert.deepEqual(rootActivityAfterChild.permissionWaits, parentBaseline.permissionWaits, `${provider}/${childEvent.hook_event_name}`);
      const observation = providerEvent(await readState(server), fixture.registration.executionId);
      assert.deepEqual(observation.lastKnownState.actors, [{
        id: childId,
        active: index < childEvents.length - 1,
        turn: expectedChildTurns[index],
      }], `${provider}/${childEvent.hook_event_name}`);
    }

    const beforeParentEnd = providerEvent(await readState(server), fixture.registration.executionId);
    assert.equal(beforeParentEnd.lastKnownState.period, 'active', provider);
    assert.deepEqual(beforeParentEnd.lastKnownState.actors, [{ id: childId, active: false, turn: 'session_ended' }], provider);
    assert.equal(effects.sessionEnded, 0, provider);

    const parentEnd = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'SessionEnd', {
      hook_at: eventAt + 12,
      nativeEventId: `${provider}-root-session-end`,
      sequence_number: 12,
    })));
    assert.equal(parentEnd.status, 202, provider);
    assert.equal(delivery.endedSessions.has(parentSessionId), true, provider);
    assert.equal(delivery.sessionNotifications.has(parentSessionId), false, provider);
    assert.ok(delivery.stopGenerations.get(parentSessionId) > parentBaseline.stopGeneration, provider);
    assert.equal(effects.sessionEnded, 1, provider);
    const afterParentEnd = providerEvent(await readState(server), fixture.registration.executionId);
    assert.equal(afterParentEnd.lastKnownState.period, 'ended_observed', provider);
  });

  test(`${provider} registered projection remains active when its session file disappears`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-http-file-absence` });
    const server = await startTestServer(t, { registrationRegistry: fixture.registry });
    const effects = createEffects();
    attachEffectSpy(server, effects);
    const eventAt = 1_800_000_000_000;
    const first = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'UserPromptSubmit', {
      hook_at: eventAt,
    })));
    assert.equal(first.status, 202, provider);

    server.runtime.state.syncSessionFiles([{
      session_id: fixture.registration.sessionId,
      cwd: 'D:\\fixture\\project',
      name: `${provider} fixture`,
      updatedAt: eventAt,
    }], eventAt);
    server.runtime.state.syncSessionFiles([], eventAt + 60_001);

    const activeExecution = fixture.registry.snapshot().executions.find((item) => item.executionId === fixture.registration.executionId);
    assert.equal(activeExecution.state, 'active', provider);
    assert.ok(server.runtime.state.snapshot().sessions.some((session) => session.session_id === fixture.registration.sessionId), provider);
    assert.equal(server.runtime.state.endedByAbsence.has(fixture.registration.sessionId), false, provider);
    assert.equal(effects.sessionEnded, 0, provider);
    const afterAbsence = providerEvent(await readState(server), fixture.registration.executionId);
    assert.equal(afterAbsence.lastKnownState.period, 'active', provider);

    const nextEvent = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'UserPromptSubmit', {
      hook_at: eventAt + 60_002,
      nativeEventId: `${provider}-after-file-absence`,
      sequence_number: 2,
    })));
    assert.equal(nextEvent.status, 202, provider);
    const afterEvent = providerEvent(await readState(server), fixture.registration.executionId);
    assert.equal(afterEvent.lastKnownState.period, 'active', provider);
  });
}
