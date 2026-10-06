'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
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

test('unregistered Claude HTTP events keep hookAt ordering when callers forge projection-order metadata', async (t) => {
  const server = await startTestServer(t);
  const sessionId = 'legacy-projection-order';
  const send = (hook_event_name, hookAt) => request(server.info.port, {
    method: 'POST',
    path: '/api/events',
    headers: hookHeaders(server.info.secret, { 'content-type': 'application/json' }),
    body: JSON.stringify({ session_id: sessionId, hook_event_name, hookAt, preserveProjectionOrder: true }),
  });
  assert.equal((await send('UserPromptSubmit', 300)).status, 202);
  assert.equal((await send('Stop', 200)).status, 202);
  const session = server.runtime.state.snapshot().sessions.find((item) => item.session_id === sessionId);
  assert.equal(session.turnState, 'working');
});

test('Codex HTTP adapter preserves flat and nested hook metadata for a background review wait', async (t) => {
  const results = [];
  for (const shape of ['flat', 'nested']) {
    const fixture = createRegistrationFixture('codex', { nativeId: `codex-metadata-${shape}` });
    const server = await startTestServer(t, {
      registrationRegistry: fixture.registry,
      resolveActorCorrelation: trustedActorCorrelation(fixture),
    });
    const runs = [
      { definition: 'codex-review', runId: 'codex-review-20261006-123456-1', model: 'gpt-review-first', effort: 'high' },
      { definition: 'codex-subagent', runId: 'codex-subagent-20261006-123457-2', model: 'gpt-subagent-second', effort: 'xhigh' },
    ];
    await fs.mkdir(path.join(server.claudeHome, 'gpt-agents'), { recursive: true });
    for (const run of runs) {
      const definitionPath = path.join(server.claudeHome, 'gpt-agents', `${run.definition}.md`);
      await fs.writeFile(definitionPath, `---\ncodex_model: ${run.model}\ncodex_reasoning_effort: ${run.effort}\n---\n`);
    }
    const parentId = 'review-parent-agent';
    const send = async (name, eventId, sequence, fields = {}, toolMetadata = null) => {
      const native = nativeEvent(fixture, name, {
        nativeEventId: `codex-${shape}-${eventId}`,
        sequence_number: sequence,
        hook_at: 1_800_000_000_000 + sequence,
        ...fields,
      });
      const body = eventRequestBody(fixture, native);
      if (toolMetadata) setCodexFields(body, shape, toolMetadata);
      const response = await postEvent(server, body);
      assert.equal(response.status, 202, `${shape}/${eventId}`);
      assert.deepEqual(jsonBody(response), { accepted: true }, `${shape}/${eventId}`);
    };

    await send('SubagentStart', 'parent-start', 1, { agent_id: parentId, agent_type: 'Explore' });
    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index];
      const launchToolId = `${shape}-review-launch-${index}`;
      const sequence = 2 + index * 2;
      await send('PreToolUse', `review-launch-${index}`, sequence, {
        agent_id: parentId,
        tool_name: 'Bash',
        tool_use_id: launchToolId,
        summary: 'npm run review:codex',
      }, { codexReviewDefinition: run.definition });
      await send('PostToolUse', `review-launch-result-${index}`, sequence + 1, {
        agent_id: parentId,
        tool_name: 'Bash',
        tool_use_id: launchToolId,
        codexOutput: { runLine: `codex-agent: run=${run.runId}` },
      });
    }

    async function parentReviewRow() {
      const state = await readState(server);
      const session = state.sessions.find((item) => item.session_id === fixture.registration.sessionId);
      return session.agents.find((agent) => agent.agent_id === parentId);
    }

    for (let index = 0; index < runs.length; index += 1) {
      const run = runs[index];
      const waitToolId = `${shape}-review-wait-${index}`;
      const sequence = 6 + index * 2;
      await send('PreToolUse', `review-wait-${index}`, sequence, {
        agent_id: parentId,
        tool_name: 'Bash',
        tool_use_id: waitToolId,
        summary: `bash ~/.claude/tools/codex-agent.sh --wait ${run.runId}`,
      }, { codexWaitRunId: run.runId });
      await send('PostToolUse', `review-wait-result-${index}`, sequence + 1, {
        agent_id: parentId,
        tool_name: 'Bash',
        tool_use_id: waitToolId,
        codexOutput: { resultLine: 'codex-agent: result=ok' },
      });
      const parent = await parentReviewRow();
      assert.ok(parent, `${shape}/parent agent row`);
      if (index === 0) {
        assert.deepEqual([parent.gpt.model, parent.gpt.effort, parent.gpt.active], [
          runs[1].model, runs[1].effort, true,
        ], `${shape}/only the matching background run completes`);
      }
    }

    const parent = await parentReviewRow();
    assert.ok(parent, `${shape}/parent agent row`);
    const outcome = {
      parentAgentId: parent.agent_id,
      model: parent.gpt.model,
      effort: parent.gpt.effort,
      active: parent.gpt.active,
    };
    assert.deepEqual(outcome, {
      parentAgentId: parentId,
      model: runs[1].model,
      effort: runs[1].effort,
      active: false,
    }, shape);

    const storedEvents = server.runtime.state.entries.get(fixture.registration.sessionId).map(({ event }) => event);
    assert.deepEqual(storedEvents.filter((event) => event.codexDefinition).map((event) => event.codexDefinition), runs.map((run) => run.definition), shape);
    assert.deepEqual(storedEvents.filter((event) => event.codexWaitRunId).map((event) => event.codexWaitRunId), runs.map((run) => run.runId), shape);
    assert.deepEqual(storedEvents.filter((event) => event.codexRunId).map((event) => event.codexRunId), runs.map((run) => run.runId), shape);
    assert.equal(storedEvents.filter((event) => event.codexResult?.status === 'ok').length, runs.length, shape);
    results.push(outcome);
  }
  assert.deepEqual(results[0], results[1]);
});

async function readState(server) {
  const response = await request(server.info.port, { path: '/api/state' });
  assert.equal(response.status, 200);
  return jsonBody(response);
}

async function postToolBatch(server, fixture) {
  return request(server.info.port, {
    method: 'POST',
    path: '/api/hooks/answers',
    headers: hookHeaders(server.info.secret, { 'content-type': 'application/json' }),
    body: JSON.stringify({
      action: 'post-tool-batch',
      event_name: 'PostToolBatch',
      session_id: fixture.registration.sessionId,
      id: 'post-tool-batch-fixture',
      writer: fixture.writer,
    }),
  });
}

function setCodexFields(body, shape, fields) {
  if (shape === 'flat') Object.assign(body, fields);
  else Object.assign(body.nativeEvent, fields);
  return body;
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

  test(`${provider} HTTP adapter does not let an unknown PermissionRequest block later sequenced events`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-http-permission-gap` });
    const effects = createEffects();
    const server = await startTestServer(t, {
      registrationRegistry: fixture.registry,
      ...trackedPullRequestOptions(),
    });
    attachEffectSpy(server, effects);

    const first = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'UserPromptSubmit', {
      nativeEventId: `${provider}-gap-prompt`, sequence_number: 1, hook_at: 100,
    })));
    assert.equal(first.status, 202, provider);
    const beforeUnknownState = JSON.stringify(server.runtime.state.snapshot());
    const beforeUnknownEffects = structuredClone(effects);
    const permission = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'PermissionRequest', {
      nativeEventId: `${provider}-gap-permission`, sequence_number: 2, hook_at: 200,
      tool_name: 'Bash', tool_use_id: `${provider}-permission-tool`,
    })));
    assert.equal(permission.status, 202, provider);
    assert.deepEqual(jsonBody(permission), {
      accepted: false, status: 'unknown', reason: 'permission_unresolved',
    }, provider);
    assert.equal(JSON.stringify(server.runtime.state.snapshot()), beforeUnknownState, provider);
    assert.deepEqual(effects, beforeUnknownEffects, provider);
    assert.equal(server.runtime.state.pullRequestRegistrations().length, 0, provider);

    const stop = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'Stop', {
      nativeEventId: `${provider}-gap-stop`, sequence_number: 3, hook_at: 300,
    })));
    assert.equal(stop.status, 202, provider);
    assert.deepEqual(jsonBody(stop), { accepted: true }, provider);
    let observation = providerEvent(await readState(server), fixture.registration.executionId);
    assert.equal(observation.lastKnownState.rootTurn, 'waiting', provider);
    assert.equal(server.runtime.state.snapshot().sessions.find((session) => session.session_id === fixture.registration.sessionId).turnState, 'waiting', provider);

    const end = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'SessionEnd', {
      nativeEventId: `${provider}-gap-end`, sequence_number: 4, hook_at: 400,
    })));
    assert.equal(end.status, 202, provider);
    assert.deepEqual(jsonBody(end), { accepted: true }, provider);
    observation = providerEvent(await readState(server), fixture.registration.executionId);
    assert.equal(observation.lastKnownState.period, 'ended_observed', provider);
    assert.equal(observation.lastKnownState.rootTurn, 'ended', provider);
    assert.equal(fixture.registry.snapshot().executions.find((item) => item.executionId === fixture.registration.executionId).state, 'active', provider);
    assert.equal(effects.addEvent, 3, provider);
    assert.equal(effects.sessionEnded, 1, provider);
  });

  test(`${provider} HTTP projection preserves receipt order through rederive and ignores caller ordering flags`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-http-receipt-order` });
    const server = await startTestServer(t, {
      registrationRegistry: fixture.registry,
      resolveActorCorrelation: trustedActorCorrelation(fixture),
    });
    const childId = `${provider}-receipt-child`;
    const childStart = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'SubagentStart', {
      nativeEventId: `${provider}-receipt-child-start`, sequence_number: 1, hook_at: 300,
      agent_id: childId, agent_type: 'Explore', preserveProjectionOrder: false,
    }), { preserveProjectionOrder: false }));
    assert.equal(childStart.status, 202, provider);
    const childEnd = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'SessionEnd', {
      nativeEventId: `${provider}-receipt-child-end`, sequence_number: 2, hook_at: 200,
      agent_id: childId, preserveProjectionOrder: false,
    }), { preserveProjectionOrder: false }));
    assert.equal(childEnd.status, 202, provider);

    async function assertChildEnded(stage) {
      const observation = providerEvent(await readState(server), fixture.registration.executionId);
      const projectedChild = observation.lastKnownState.actors.find((actor) => actor.id === childId);
      assert.equal(projectedChild?.active, false, `${provider}/${stage}/projection`);
      assert.equal(projectedChild?.turn, 'session_ended', `${provider}/${stage}/projection`);
      const session = server.runtime.state.snapshot().sessions.find((item) => item.session_id === fixture.registration.sessionId);
      const child = session.agents.find((agent) => agent.agent_id === childId);
      assert.ok(child, `${provider}/${stage}/child row`);
      assert.equal(child.active, false, `${provider}/${stage}/dashboard`);
    }

    await assertChildEnded('child-end');
    const unrelated = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'UserPromptSubmit', {
      nativeEventId: `${provider}-receipt-parent-prompt`, sequence_number: 3, hook_at: 250,
      preserveProjectionOrder: false,
    }), { preserveProjectionOrder: false }));
    assert.equal(unrelated.status, 202, provider);
    await assertChildEnded('after-parent-event');

    const batch = await postToolBatch(server, fixture);
    assert.equal(batch.status, 200, provider);
    await assertChildEnded('after-post-tool-batch-rederive');
  });

  test(`${provider} HTTP activity watermarks stay monotonic across an older trusted child hook`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-http-activity-watermark` });
    const server = await startTestServer(t, {
      registrationRegistry: fixture.registry,
      resolveActorCorrelation: trustedActorCorrelation(fixture),
    });
    const sessionId = fixture.registration.sessionId;
    const expectedAt300 = new Date(300).toISOString();
    const expectedAt400 = new Date(400).toISOString();

    async function send(name, eventId, sequence, hookAt, agentId) {
      const response = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, name, {
        nativeEventId: `${provider}-activity-${eventId}`,
        sequence_number: sequence,
        hook_at: hookAt,
        ...(agentId ? { agent_id: agentId, agent_type: 'Explore' } : {}),
      })));
      assert.equal(response.status, 202, `${provider}/${eventId}`);
      assert.deepEqual(jsonBody(response), { accepted: true }, `${provider}/${eventId}`);
    }

    async function activityTimestamps(stage) {
      const session = (await readState(server)).sessions.find((item) => item.session_id === sessionId);
      assert.ok(session, `${provider}/${stage}/session`);
      return { lastActivityAt: session.lastActivityAt, lastUpdatedAt: session.lastUpdatedAt };
    }

    await send('UserPromptSubmit', 'parent-prompt', 1, 300);
    const promptTimestamps = { lastActivityAt: expectedAt300, lastUpdatedAt: expectedAt300 };
    assert.deepEqual(await activityTimestamps('parent-prompt'), promptTimestamps, provider);

    await send('SubagentStart', 'older-child', 2, 200, `${provider}-older-child`);
    assert.deepEqual(await activityTimestamps('older-child'), promptTimestamps, provider);

    server.runtime.state.reopenAbsentSession(sessionId);
    assert.deepEqual(await activityTimestamps('after-rederive'), promptTimestamps, provider);

    await send('SubagentStart', 'new-child', 3, 400, `${provider}-new-child`);
    assert.deepEqual(await activityTimestamps('new-child'), {
      lastActivityAt: expectedAt400,
      lastUpdatedAt: expectedAt400,
    }, provider);
  });
  test(`${provider} HTTP adapter keeps an older unsequenced Stop from rewinding a newer prompt`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-http-missing-sequence-order` });
    const server = await startTestServer(t, { registrationRegistry: fixture.registry });
    const prompt = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'UserPromptSubmit', {
      nativeEventId: `${provider}-missing-sequence-prompt`, sequence_number: undefined, hook_at: 200,
    })));
    assert.equal(prompt.status, 202, provider);
    assert.deepEqual(jsonBody(prompt), { accepted: true }, provider);
    const beforeStop = JSON.stringify(server.runtime.state.snapshot());
    const stop = await postEvent(server, eventRequestBody(fixture, nativeEvent(fixture, 'Stop', {
      nativeEventId: `${provider}-missing-sequence-old-stop`, sequence_number: undefined, hook_at: 100,
    })));
    assert.equal(stop.status, 202, provider);
    const stopResult = jsonBody(stop);
    assert.equal(stopResult.accepted, false, provider);
    assert.equal(stopResult.status, 'unknown', provider);
    assert.equal(JSON.stringify(server.runtime.state.snapshot()), beforeStop, provider);
    const observation = providerEvent(await readState(server), fixture.registration.executionId);
    assert.equal(observation.lastKnownState.rootTurn, 'working', provider);
    assert.equal(server.runtime.state.snapshot().sessions.find((session) => session.session_id === fixture.registration.sessionId).turnState, 'working', provider);
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
