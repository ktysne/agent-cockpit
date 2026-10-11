'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DashboardState } = require('../src/server/state');
const { hookHeaders, jsonBody, request, startTestServer, uiHeaders } = require('./support/server');
const { createRegistrationFixture } = require('./support/registration');

function questionFor(fixture, overrides = {}) {
  return {
    internalQuestionId: `projection-question-${fixture.identity.provider}`,
    questionId: 'projection-question',
    identity: fixture.identity,
    executionId: fixture.registration.executionId,
    conversationId: fixture.registration.conversationId,
    createdAt: 1_800_000_000_000,
    questions: [],
    ...overrides,
  };
}

function questionService(fixture) {
  const question = questionFor(fixture);
  return {
    ready: async () => {},
    dashboardSnapshot: async () => ({ version: 1, questions: [question] }),
    close() {},
  };
}

function questionServiceFor(questions) {
  return {
    ready: async () => {},
    dashboardSnapshot: async () => ({ version: 1, questions }),
    close() {},
  };
}

function registrationRegistryWithStates(fixture, initialStates = ['active'], additionalExecutions = []) {
  let states = [...initialStates];
  let snapshotIndex = 0;
  return {
    registry: {
      snapshot() {
        const base = fixture.registry.snapshot();
        const state = states[Math.min(snapshotIndex++, states.length - 1)] || 'active';
        return {
          conversations: base.conversations,
          executions: [
            ...base.executions.map((execution) => ({ ...execution, state })),
            ...additionalExecutions,
          ],
        };
      },
      authorizeEvent: (...args) => fixture.registry.authorizeEvent(...args),
      authorizeWriter: (...args) => fixture.registry.authorizeWriter(...args),
      isRegisteredSessionId: (...args) => fixture.registry.isRegisteredSessionId(...args),
    },
    setStates(nextStates) {
      states = [...nextStates];
      snapshotIndex = 0;
    },
    snapshotCount: () => snapshotIndex,
  };
}

function launchFor(fixture, launchRef) {
  return {
    launchRef,
    state: 'bound',
    identity: fixture.identity,
    conversationId: fixture.registration.conversationId,
    sessionId: fixture.registration.sessionId,
    origin: 'standalone',
    purpose: 'agent',
    executionBinding: {
      periodId: fixture.registration.executionId,
      actor: { kind: 'agent', id: `${fixture.identity.provider}-status-actor` },
    },
  };
}

function instructionFor(fixture, launchRef) {
  return {
    deliveryAttemptId: `${fixture.identity.provider}-status-attempt`,
    logicalMessageId: `${fixture.identity.provider}-status-message`,
    revision: 1,
    launchRef,
    sessionId: fixture.registration.sessionId,
    executionId: fixture.registration.executionId,
    identity: fixture.identity,
    origin: 'standalone',
    state: 'available',
    mode: 'start',
    nativeTurnId: null,
    heldReason: null,
    createdAt: 1_800_000_000_000,
  };
}

function instructionServiceFor(instructions) {
  return {
    ready: async () => {},
    dashboardSnapshot: async () => ({ instructions }),
  };
}

function postUi(runtime, pathname, body) {
  return request(runtime.info.port, {
    method: 'POST',
    path: pathname,
    headers: uiHeaders(runtime.info, `http://127.0.0.1:${runtime.info.port}`, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

function registeredEvent(fixture, name, hookAt, sequence) {
  const nativeIdentity = fixture.provider === 'codex'
    ? { thread_id: fixture.identity.nativeId }
    : { session_id: fixture.identity.nativeId };
  return {
    session_id: fixture.registration.sessionId,
    writer: fixture.writer,
    nativeEvent: {
      ...nativeIdentity,
      hook_event_name: name,
      hook_at: hookAt,
      nativeEventId: `${fixture.identity.provider}-${name}-${sequence}`,
      sequence_number: sequence,
    },
  };
}

for (const provider of ['claude', 'codex']) {
  test(`${provider} の検証済み質問行はprovider別に非表示・削除できる`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-projection-display` });
    fixture.provider = provider;
    const state = new DashboardState();
    const runtime = (await startTestServer(t, {
      state,
      registrationRegistry: fixture.registry,
      questionService: questionService(fixture),
    })).runtime;
    const sessionId = fixture.registration.sessionId;
    const initial = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
    const initialRow = initial.sessions.find((session) => session.session_id === sessionId);
    assert.equal(initialRow.provider, provider);
    assert.equal(initialRow.commonQuestions[0].internalQuestionId, `projection-question-${provider}`);

    const hidden = await postUi(runtime, '/api/hidden-sessions', { action: 'hide', session_id: sessionId });
    assert.equal(hidden.status, 200);
    assert.deepEqual(jsonBody(hidden), { hidden: true });
    assert.equal(state.projectionDisplayFor(provider, sessionId).hiddenAt !== undefined, true);
    assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
      .find((session) => session.session_id === sessionId).hidden, true);

    const unhidden = await postUi(runtime, '/api/hidden-sessions', { action: 'unhide', session_ids: [sessionId] });
    assert.equal(unhidden.status, 200);
    assert.deepEqual(jsonBody(unhidden), { unhidden: 1 });
    assert.equal(state.projectionDisplayFor(provider, sessionId), null);

    const deleted = await postUi(runtime, '/api/record-deletions', { session_ids: [sessionId] });
    assert.equal(deleted.status, 200);
    assert.deepEqual(jsonBody(deleted), { deleted: { sessions: 1, pullRequests: 0 } });
    assert.equal(state.projectionDisplayFor(provider, sessionId).deletedAt !== undefined, true);
    assert.equal(state.deletedSessions.has(sessionId), false);
    assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
      .some((session) => session.session_id === sessionId), false);
  });

  test(`${provider} の削除済みprojectionは古い・unknown eventで戻らず、新しい検証済みstate writeで戻る`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-projection-revival` });
    fixture.provider = provider;
    const state = new DashboardState();
    const runtime = (await startTestServer(t, {
      state,
      registrationRegistry: fixture.registry,
      questionService: questionService(fixture),
    })).runtime;
    const sessionId = fixture.registration.sessionId;
    const deletedAt = Date.now();
    state.deleteProjectionDisplay(provider, sessionId, deletedAt);
    assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
      .some((session) => session.session_id === sessionId), false);
    const afterEvents = [];
    const afterEvent = runtime.answerDelivery.afterEvent.bind(runtime.answerDelivery);
    runtime.answerDelivery.afterEvent = (event) => {
      afterEvents.push(event.hook_event_name);
      return afterEvent(event);
    };

    const postEvent = (event) => request(runtime.info.port, {
      method: 'POST',
      path: '/api/events',
      headers: hookHeaders(runtime.info.secret, { 'content-type': 'application/json' }),
      body: JSON.stringify(event),
    });
    const stale = await postEvent(registeredEvent(fixture, 'UserPromptSubmit', deletedAt, 1));
    assert.equal(stale.status, 202);
    assert.deepEqual(jsonBody(stale), { accepted: true });
    assert.equal(state.sessions.has(sessionId), true);
    assert.equal(state.entries.get(sessionId)?.length, 1);
    assert.deepEqual(afterEvents, ['UserPromptSubmit']);
    assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
      .some((session) => session.session_id === sessionId), false);
    assert.equal(state.projectionDisplayFor(provider, sessionId).deletedAt, new Date(deletedAt).toISOString());

    const unknown = await postEvent(registeredEvent(fixture, 'PermissionRequest', deletedAt + 1, 2));
    assert.equal(unknown.status, 202);
    assert.equal(jsonBody(unknown).status, 'unknown');
    assert.equal(state.sessions.has(sessionId), true);
    assert.equal(state.entries.get(sessionId)?.length, 1);
    assert.deepEqual(afterEvents, ['UserPromptSubmit']);
    assert.equal(state.projectionDisplayFor(provider, sessionId).deletedAt, new Date(deletedAt).toISOString());

    const current = await postEvent(registeredEvent(fixture, 'UserPromptSubmit', deletedAt + 2, 3));
    assert.equal(current.status, 202);
    assert.deepEqual(jsonBody(current), { accepted: true });
    assert.deepEqual(afterEvents, ['UserPromptSubmit', 'UserPromptSubmit']);
    assert.equal(state.projectionDisplayFor(provider, sessionId), null);
    assert.equal(state.sessions.has(sessionId), true);
    state.sessions.get(sessionId).provider = `preserved-${provider}`;
    const realRow = jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
      .find((session) => session.session_id === sessionId);
    assert.equal(realRow.provider, `preserved-${provider}`);
  });

  test(`${provider} の複数質問と指示projectionは同じ行に集約される`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-instruction-projection` });
    const { sessionId, executionId, conversationId } = fixture.registration;
    const launchRef = `${provider}-display-launch`;
    const questions = [questionFor(fixture), {
      ...questionFor(fixture),
      internalQuestionId: `projection-question-second-${provider}`,
    }];
    const launch = {
      launchRef,
      state: 'bound',
      identity: fixture.identity,
      conversationId,
      sessionId,
      origin: 'standalone',
      purpose: 'agent',
      executionBinding: { periodId: executionId, actor: { kind: 'agent', id: `${provider}-display-actor` } },
    };
    const state = new DashboardState();
    const runtime = (await startTestServer(t, {
      state,
      registrationRegistry: fixture.registry,
      launchRegistry: {
        get: (ref) => ref === launchRef ? launch : null,
        snapshot: () => ({ launches: [launch] }),
      },
      questionService: {
        ready: async () => {},
        dashboardSnapshot: async () => ({ version: 1, questions }),
      },
      instructionService: {
        ready: async () => {},
        dashboardSnapshot: async () => ({ instructions: [{
          deliveryAttemptId: `${provider}-display-attempt`,
          logicalMessageId: `${provider}-display-message`,
          revision: 1,
          launchRef,
          sessionId,
          executionId,
          identity: fixture.identity,
          origin: 'standalone',
          state: 'available',
          mode: 'start',
          nativeTurnId: null,
          heldReason: null,
          createdAt: Date.now(),
        }] }),
      },
    })).runtime;

    const row = jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
      .find((session) => session.session_id === sessionId);
    assert.equal(row.commonQuestions.length, 2);
    assert.equal(row.instructions[0].deliveryAttemptId, `${provider}-display-attempt`);
    const hidden = await postUi(runtime, '/api/hidden-sessions', { action: 'hide', session_id: sessionId });
    assert.equal(hidden.status, 200);
    assert.equal(state.projectionDisplayFor(provider, sessionId)?.hiddenAt !== undefined, true);
    const unhidden = await postUi(runtime, '/api/hidden-sessions', { action: 'unhide', session_ids: [sessionId] });
    assert.equal(unhidden.status, 200);
    assert.equal(state.projectionDisplayFor(provider, sessionId), null);

    const deleteSession = state.deleteSession.bind(state);
    let realDeletionCalls = 0;
    state.deleteSession = (...args) => { realDeletionCalls += 1; return deleteSession(...args); };
    const deleted = await postUi(runtime, '/api/record-deletions', { session_ids: [sessionId] });
    assert.equal(deleted.status, 200);
    assert.equal(state.projectionDisplayFor(provider, sessionId)?.deletedAt !== undefined, true);
    assert.equal(state.deletedSessions.has(sessionId), false);
    assert.equal(realDeletionCalls, 0);
  });
}

test('tombstoneより古いSessionEndも通常処理され、projection表示だけは抑制される', async (t) => {
  const fixture = createRegistrationFixture('claude', { nativeId: 'projection-late-session-end' });
  const state = new DashboardState();
  const runtime = (await startTestServer(t, {
    state,
    registrationRegistry: fixture.registry,
    questionService: questionService(fixture),
  })).runtime;
  const sessionId = fixture.registration.sessionId;
  const deletedAt = Date.now();
  state.deleteProjectionDisplay('claude', sessionId, deletedAt);
  const afterEvents = [];
  const afterEvent = runtime.answerDelivery.afterEvent.bind(runtime.answerDelivery);
  runtime.answerDelivery.afterEvent = (event) => {
    afterEvents.push(event.hook_event_name);
    return afterEvent(event);
  };

  const response = await request(runtime.info.port, {
    method: 'POST',
    path: '/api/events',
    headers: hookHeaders(runtime.info.secret, { 'content-type': 'application/json' }),
    body: JSON.stringify(registeredEvent(fixture, 'SessionEnd', deletedAt - 1, 1)),
  });
  assert.equal(response.status, 202);
  assert.deepEqual(jsonBody(response), { accepted: true });
  assert.equal(state.endedAt.get(sessionId), deletedAt - 1);
  assert.deepEqual(afterEvents, ['SessionEnd']);
  assert.equal(state.projectionDisplayFor('claude', sessionId).deletedAt, new Date(deletedAt).toISOString());
  assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
    .some((session) => session.session_id === sessionId), false);
});

test('GET /api/state は質問snapshotとregistrationの片方が失敗したら部分projectionを出さない', async (t) => {
  const fixture = createRegistrationFixture('claude', { nativeId: 'projection-pair-clear' });
  const state = new DashboardState();
  let failNextSnapshot = false;
  const registry = {
    snapshot() {
      if (failNextSnapshot) {
        failNextSnapshot = false;
        throw new Error('private registration failure');
      }
      return fixture.registry.snapshot();
    },
    authorizeEvent: (...args) => fixture.registry.authorizeEvent(...args),
    authorizeWriter: (...args) => fixture.registry.authorizeWriter(...args),
    isRegisteredSessionId: (...args) => fixture.registry.isRegisteredSessionId(...args),
  };
  const runtime = (await startTestServer(t, {
    state,
    registrationRegistry: registry,
    questionService: questionService(fixture),
  })).runtime;

  const hidden = async () => postUi(runtime, '/api/hidden-sessions', {
    action: 'hide', session_id: fixture.registration.sessionId,
  });
  const deleted = async () => postUi(runtime, '/api/record-deletions', {
    session_ids: [fixture.registration.sessionId],
  });
  failNextSnapshot = true;
  assert.equal((await hidden()).status, 503);
  assert.equal(state.projectionDisplayFor('claude', fixture.registration.sessionId), null);
  failNextSnapshot = true;
  assert.equal((await deleted()).status, 503);
  assert.equal(state.projectionDisplayFor('claude', fixture.registration.sessionId), null);

  failNextSnapshot = true;
  const failedPair = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.equal(failedPair.sessions.some((session) => session.session_id === fixture.registration.sessionId), false);
  assert.deepEqual(failedPair.commonQuestionDiagnostics, {
    recovery: { status: 'unavailable', errorCode: 'common_question_state_unavailable' },
  });

  const recovered = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.equal(recovered.sessions.find((session) => session.session_id === fixture.registration.sessionId)
    .commonQuestions[0].internalQuestionId, 'projection-question-claude');
});

test('projection取得中の失敗では削除を保留し、GETは実rowを返す', async (t) => {
  const fixture = createRegistrationFixture('claude', { nativeId: 'projection-delete-unavailable' });
  const state = new DashboardState();
  const sessionId = fixture.registration.sessionId;
  state.syncSessionFiles([{ session_id: sessionId }], Date.now(), 'claude');
  let failSnapshot = false;
  const runtime = (await startTestServer(t, {
    state,
    registrationRegistry: fixture.registry,
    questionService: {
      ready: async () => {},
      dashboardSnapshot: async () => {
        if (failSnapshot) throw new Error('question snapshot unavailable');
        return { version: 1, questions: [questionFor(fixture)] };
      },
    },
  })).runtime;
  const initial = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.ok(initial.sessions.find((session) => session.session_id === sessionId)?.commonQuestions?.length);

  const deletionCalls = [];
  const deleteSession = state.deleteSession.bind(state);
  state.deleteSession = (...args) => {
    deletionCalls.push(args);
    return deleteSession(...args);
  };
  failSnapshot = true;
  const deletion = await postUi(runtime, '/api/record-deletions', { session_ids: [sessionId] });
  assert.equal(deletion.status, 503);
  assert.deepEqual(jsonBody(deletion), { error: 'Session target is unavailable' });
  assert.deepEqual(deletionCalls, []);
  assert.equal(state.sessionFiles.has(sessionId), true);
  assert.equal(state.deletedSessions.has(sessionId), false);
  assert.equal(state.projectionDisplayFor('claude', sessionId), null);

  const current = await request(runtime.info.port, { path: '/api/state' });
  assert.equal(current.status, 200);
  assert.ok(jsonBody(current).sessions.some((session) => session.session_id === sessionId));
});

test('設定済みinstruction serviceがreadyでない間は実row削除へfallbackしない', async (t) => {
  const fixture = createRegistrationFixture('claude', { nativeId: 'instruction-display-not-ready' });
  const sessionId = fixture.registration.sessionId;
  const ended = [];
  const state = new DashboardState({ onSessionEndedByAbsence: (...args) => ended.push(args) });
  state.addEvent({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', hookAt: Date.now() }, { provider: 'claude' });
  const runtime = (await startTestServer(t, {
    state,
    registrationRegistry: fixture.registry,
    launchRegistry: { get: () => null, snapshot: () => ({ launches: [] }) },
    instructionService: {
      ready: async () => { throw new Error('instruction state unavailable'); },
      dashboardSnapshot: async () => ({ instructions: [] }),
    },
  })).runtime;

  const deletion = await postUi(runtime, '/api/record-deletions', { session_ids: [sessionId] });
  assert.equal(deletion.status, 503);
  assert.equal(state.sessions.has(sessionId), true);
  assert.equal(state.deletedSessions.has(sessionId), false);
  assert.deepEqual(ended, []);
});

test('instruction targetだけが構成された場合は未構成扱いで実rowを削除しない', async (t) => {
  const fixture = createRegistrationFixture('claude', { nativeId: 'instruction-target-only' });
  const sessionId = fixture.registration.sessionId;
  const ended = [];
  const state = new DashboardState({ onSessionEndedByAbsence: (...args) => ended.push(args) });
  state.addEvent({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', hookAt: Date.now() }, { provider: 'claude' });
  const runtime = (await startTestServer(t, {
    state,
    registrationRegistry: fixture.registry,
    launchRegistry: { get: () => null, snapshot: () => ({ launches: [] }) },
  })).runtime;

  const diagnostics = jsonBody(await request(runtime.info.port, { path: '/api/state' })).instructionDiagnostics;
  assert.deepEqual(diagnostics, { configuration: 'configured', service: 'unavailable', targets: 'available' });
  const deletion = await postUi(runtime, '/api/record-deletions', { session_ids: [sessionId] });
  assert.equal(deletion.status, 503);
  assert.equal(state.sessions.has(sessionId), true);
  assert.equal(state.deletedSessions.has(sessionId), false);
  assert.deepEqual(ended, []);
});

test('GET /api/state は指示dashboardとregistrationの片方が失敗したら部分projectionを出さない', async (t) => {
  const fixture = createRegistrationFixture('claude', { nativeId: 'instruction-projection-pair-clear' });
  let failNextSnapshot = false;
  const registry = {
    snapshot() {
      if (failNextSnapshot) {
        failNextSnapshot = false;
        throw new Error('private registration failure');
      }
      return fixture.registry.snapshot();
    },
    authorizeEvent: (...args) => fixture.registry.authorizeEvent(...args),
    authorizeWriter: (...args) => fixture.registry.authorizeWriter(...args),
    isRegisteredSessionId: (...args) => fixture.registry.isRegisteredSessionId(...args),
  };
  const runtime = (await startTestServer(t, {
    registrationRegistry: registry,
    launchRegistry: { snapshot: () => ({ launches: [] }) },
    instructionService: {
      ready: async () => {},
      dashboardSnapshot: async () => ({ instructions: [{
        deliveryAttemptId: 'private-delivery-attempt',
        logicalMessageId: 'private-logical-message',
        revision: 1,
        launchRef: 'private-launch',
        sessionId: 'instruction-orphan-session',
        executionId: 'private-execution',
        identity: {
          provider: 'claude', nativeIdKind: 'session', hostId: 'test-host',
          homeScopeId: 'test-home', nativeId: 'instruction-native-id',
        },
        origin: 'standalone', state: 'available', mode: 'start', nativeTurnId: null,
        heldReason: null, createdAt: 1_800_000_000_000,
      }] }),
    },
  })).runtime;

  failNextSnapshot = true;
  const snapshot = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.equal(snapshot.sessions.some((session) => session.session_id === 'instruction-orphan-session'), false);
  assert.deepEqual(snapshot.instructionDiagnostics, {
    configuration: 'configured', service: 'ready', targets: 'unavailable',
  });
});

test('synthetic-only projection deletion does not end a real session', async (t) => {
  const fixture = createRegistrationFixture('codex', { nativeId: 'projection-only-delete' });
  fixture.provider = 'codex';
  const state = new DashboardState();
  const runtime = (await startTestServer(t, {
    state,
    registrationRegistry: fixture.registry,
    questionService: questionService(fixture),
  })).runtime;
  const ended = [];
  const deletionResults = [];
  const deleteSession = state.deleteSession.bind(state);
  state.deleteSession = (...args) => {
    const result = deleteSession(...args);
    deletionResults.push(result);
    return result;
  };
  runtime.answerDelivery.sessionEnded = (...args) => ended.push(args);
  const response = await postUi(runtime, '/api/record-deletions', { session_ids: [fixture.registration.sessionId] });
  assert.equal(response.status, 200);
  assert.deepEqual(jsonBody(response), { deleted: { sessions: 1, pullRequests: 0 } });
  assert.deepEqual(deletionResults, []);
  assert.equal(state.deletedSessions.has(fixture.registration.sessionId), false);
  assert.deepEqual(ended, []);

  state.setProjectionHidden('codex', 'projection-clear-hidden', true);
  const deletedAt = Date.now();
  state.deleteProjectionDisplay('claude', 'projection-clear-tombstone', deletedAt);
  const cleared = await postUi(runtime, '/api/hidden-sessions', { action: 'clear' });
  assert.equal(cleared.status, 200);
  assert.deepEqual(jsonBody(cleared), { cleared: 1 });
  assert.equal(state.projectionDisplayFor('codex', 'projection-clear-hidden'), null);
  assert.equal(state.projectionDisplayFor('claude', 'projection-clear-tombstone')?.deletedAt,
    new Date(deletedAt).toISOString());
});

test('同じsession IDに複数providerのprojectionがある場合は表示操作を拒否する', async (t) => {
  const claude = createRegistrationFixture('claude', { nativeId: 'shared-projection-id' });
  const codex = createRegistrationFixture('codex', { nativeId: 'codex-shared-projection' });
  const sharedSessionId = claude.registration.sessionId;
  const registry = {
    snapshot() {
      const claudeSnapshot = claude.registry.snapshot();
      const codexSnapshot = codex.registry.snapshot();
      return {
        conversations: [...claudeSnapshot.conversations, ...codexSnapshot.conversations],
        executions: [
          ...claudeSnapshot.executions,
          ...codexSnapshot.executions.map((execution) => execution.executionId === codex.registration.executionId
            ? { ...execution, sessionId: sharedSessionId }
            : execution),
        ],
      };
    },
    authorizeEvent: (writer) => writer?.identity?.provider === 'codex'
      ? codex.registry.authorizeEvent(writer)
      : claude.registry.authorizeEvent(writer),
    authorizeWriter: (writer) => writer?.identity?.provider === 'codex'
      ? codex.registry.authorizeWriter(writer)
      : claude.registry.authorizeWriter(writer),
    isRegisteredSessionId(sessionId) {
      return this.snapshot().executions.some((execution) => execution.sessionId === sessionId);
    },
  };
  const runtime = (await startTestServer(t, {
    registrationRegistry: registry,
    questionService: {
      ready: async () => {},
      dashboardSnapshot: async () => ({ version: 1, questions: [questionFor(claude), questionFor(codex)] }),
    },
  })).runtime;

  runtime.state.setProjectionHidden('claude', sharedSessionId, true);
  const unhidden = await postUi(runtime, '/api/hidden-sessions', { action: 'unhide', session_ids: [sharedSessionId] });
  assert.equal(unhidden.status, 409);
  assert.equal(runtime.state.projectionDisplayFor('claude', sharedSessionId)?.hiddenAt !== undefined, true);

  const hidden = await postUi(runtime, '/api/hidden-sessions', { action: 'hide', session_id: sharedSessionId });
  assert.equal(hidden.status, 409);
  const deleted = await postUi(runtime, '/api/record-deletions', { session_ids: [sharedSessionId] });
  assert.equal(deleted.status, 409);
  assert.equal(runtime.state.projectionDisplayFor('claude', sharedSessionId)?.hiddenAt !== undefined, true);
  assert.equal(runtime.state.projectionDisplayFor('codex', sharedSessionId), null);
});

test('複数provider起源の実rowは片方のprojection tombstoneがあってもGETに残る', async (t) => {
  const fixture = createRegistrationFixture('claude', { nativeId: 'mixed-provenance-visible-row' });
  const sessionId = fixture.registration.sessionId;
  const state = new DashboardState();
  const hookAt = Date.now();
  state.addEvent({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', hookAt }, { provider: 'claude' });
  state.addEvent({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', hookAt: hookAt + 1 }, { provider: 'codex' });
  state.deleteProjectionDisplay('claude', sessionId, hookAt + 2);
  const runtime = (await startTestServer(t, {
    state,
    registrationRegistry: fixture.registry,
    questionService: questionService(fixture),
  })).runtime;

  const snapshot = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const row = snapshot.sessions.find((session) => session.session_id === sessionId);
  assert.ok(row);
  assert.deepEqual(state.sessionProviderSourcesFor(sessionId), ['claude', 'codex']);
  assert.equal(row.commonQuestions, undefined);
  assert.equal(state.projectionDisplayFor('claude', sessionId)?.deletedAt, new Date(hookAt + 2).toISOString());
});

for (const [rowProvider, fileProvider] of [['claude', 'claude'], ['unknown', null]]) {
  test(`既存real rowのproviderが${rowProvider}のとき別providerのprojection操作を拒否する`, async (t) => {
    const fixture = createRegistrationFixture('codex', { nativeId: `codex-row-${rowProvider}-collision` });
    const state = new DashboardState();
    const sessionId = fixture.registration.sessionId;
    state.syncSessionFiles([{ session_id: sessionId, provider: 'codex' }], Date.now(), fileProvider);
    const runtime = (await startTestServer(t, {
      state,
      registrationRegistry: fixture.registry,
      questionService: questionService(fixture),
    })).runtime;

    for (const operation of [
      () => postUi(runtime, '/api/hidden-sessions', { action: 'hide', session_id: sessionId }),
      () => postUi(runtime, '/api/record-deletions', { session_ids: [sessionId] }),
    ]) {
      const response = await operation();
      assert.equal(response.status, 409);
      assert.equal(state.projectionDisplayFor('codex', sessionId), null);
      assert.equal(state.hiddenSessions.has(sessionId), false);
      assert.equal(state.deletedSessions.has(sessionId), false);
      assert.equal(state.sessionFiles.has(sessionId), true);
    }
    assert.deepEqual(state.sessionProviderSourcesFor(sessionId), rowProvider === 'unknown' ? ['unknown'] : ['claude']);
  });
}

test('同provider real rowの削除はprojectionだけを隠し、再度の削除もreal rowを消さない', async (t) => {
  const fixture = createRegistrationFixture('claude', { nativeId: 'claude-real-row-projection' });
  const sessionId = fixture.registration.sessionId;
  const absenceEnds = [];
  const state = new DashboardState({ onSessionEndedByAbsence: (...args) => absenceEnds.push(args) });
  const fileSeenAt = Date.now();
  state.addEvent({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', hookAt: fileSeenAt }, { provider: 'claude' });
  state.syncSessionFiles([{ session_id: sessionId }], fileSeenAt, 'claude');
  let questions = [questionFor(fixture)];
  const runtime = (await startTestServer(t, {
    state,
    registrationRegistry: fixture.registry,
    questionService: {
      ready: async () => {},
      dashboardSnapshot: async () => ({ version: 1, questions }),
    },
  })).runtime;
  const deletionCalls = [];
  const deleteSession = state.deleteSession.bind(state);
  state.deleteSession = (...args) => {
    deletionCalls.push(args);
    return deleteSession(...args);
  };

  const firstDelete = await postUi(runtime, '/api/record-deletions', { session_ids: [sessionId] });
  assert.deepEqual(jsonBody(firstDelete), { deleted: { sessions: 1, pullRequests: 0 } });
  assert.equal(state.sessionFiles.has(sessionId), true);
  assert.equal(state.deletedSessions.has(sessionId), false);
  assert.equal(state.sessionProviderSourcesFor(sessionId)[0], 'claude');

  state.syncSessionFiles([{ session_id: sessionId }], fileSeenAt + 60_001, 'claude');
  assert.equal(state.sessions.has(sessionId), true);
  assert.equal(state.sessionFiles.has(sessionId), true);
  assert.equal(state.endedByAbsence.has(sessionId), false);
  assert.deepEqual(absenceEnds, []);
  assert.equal(jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
    .some((session) => session.session_id === sessionId), false);

  questions = [];
  const repeatedDelete = await postUi(runtime, '/api/record-deletions', { session_ids: [sessionId] });
  assert.deepEqual(jsonBody(repeatedDelete), { deleted: { sessions: 0, pullRequests: 0 } });
  assert.equal(state.sessionFiles.has(sessionId), true);
  assert.deepEqual(absenceEnds, []);
  assert.deepEqual(deletionCalls, []);
});

test('real rowのprovider根拠は複数のevent sourceとunknown sourceを保持する', () => {
  const state = new DashboardState();
  const sessionId = 'mixed-provider-source';
  state.addEvent({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', hookAt: 1_800_000_000_000 }, { provider: 'claude' });
  state.addEvent({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', hookAt: 1_800_000_000_001 }, { provider: 'codex' });
  assert.deepEqual(state.sessionProviderSourcesFor(sessionId), ['claude', 'codex']);

  state.addEvent({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', hookAt: 1_800_000_000_002 });
  assert.deepEqual(state.sessionProviderSourcesFor(sessionId), ['claude', 'codex', 'unknown']);
});

for (const provider of ['claude', 'codex']) {
  test(`${provider} の質問projectionだけで作るrowは登録状態を表示する`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-synthetic-question-status` });
    const registration = registrationRegistryWithStates(fixture);
    const runtime = (await startTestServer(t, {
      registrationRegistry: registration.registry,
      questionService: questionServiceFor([questionFor(fixture)]),
    })).runtime;

    for (const [executionState, expectedStatus] of [
      ['active', '待機中'],
      ['ended', '終了済み'],
      ['unknown', '不明'],
      ['future-state', '不明'],
    ]) {
      registration.setStates([executionState]);
      const snapshot = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
      const row = snapshot.sessions.find((session) => session.session_id === fixture.registration.sessionId);
      assert.equal(row.status, expectedStatus);
      assert.equal(row.projectionOnly, true);
      assert.equal(Object.hasOwn(row, 'endedAt'), false);
    }
  });

  test(`${provider} のinstruction projectionはactiveとendedだけを合成行へ反映する`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-synthetic-instruction-status` });
    const registration = registrationRegistryWithStates(fixture);
    const launchRef = `${provider}-synthetic-status-launch`;
    const launch = launchFor(fixture, launchRef);
    const runtime = (await startTestServer(t, {
      registrationRegistry: registration.registry,
      launchRegistry: {
        get: (ref) => ref === launchRef ? launch : null,
        snapshot: () => ({ launches: [launch] }),
      },
      instructionService: instructionServiceFor([instructionFor(fixture, launchRef)]),
    })).runtime;

    for (const [executionState, expectedStatus] of [
      ['active', '待機中'],
      ['ended', '終了済み'],
    ]) {
      registration.setStates([executionState]);
      const snapshot = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
      const row = snapshot.sessions.find((session) => session.session_id === fixture.registration.sessionId);
      assert.equal(row.status, expectedStatus);
      assert.equal(row.projectionOnly, true);
      assert.equal(row.instructions.length, 1);
    }

    registration.setStates(['unknown']);
    const unknown = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
    assert.equal(unknown.sessions.some((session) => session.session_id === fixture.registration.sessionId), false);
    assert.equal(unknown.instructionDiagnostics.unmatchedCount, 1);
  });
}

for (const provider of ['claude', 'codex']) {
  test(`${provider} の質問と指示の状態不一致は不明になり、unknownから復帰しない`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-synthetic-status-conflict` });
    const registration = registrationRegistryWithStates(fixture);
    const launchRef = `${provider}-synthetic-conflict-launch`;
    const launch = launchFor(fixture, launchRef);
    const runtime = (await startTestServer(t, {
      registrationRegistry: registration.registry,
      launchRegistry: {
        get: (ref) => ref === launchRef ? launch : null,
        snapshot: () => ({ launches: [launch] }),
      },
      questionService: questionServiceFor([questionFor(fixture)]),
      instructionService: instructionServiceFor([instructionFor(fixture, launchRef)]),
    })).runtime;

    for (const [questionState, instructionState, expectedStatus] of [
      ['active', 'active', '待機中'],
      ['ended', 'ended', '終了済み'],
      ['active', 'ended', '不明'],
      ['ended', 'active', '不明'],
      ['unknown', 'active', '不明'],
      ['future-state', 'active', '不明'],
    ]) {
      registration.setStates([questionState, instructionState]);
      const snapshot = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
      const row = snapshot.sessions.find((session) => session.session_id === fixture.registration.sessionId);
      assert.equal(row.status, expectedStatus);
      assert.equal(row.projectionOnly, true);
    }
  });

  test(`${provider} の別executionIdを含む三投影は最後の一致状態でも不明のまま`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-synthetic-status-multiple-executions` });
    const baseExecution = fixture.registry.snapshot().executions[0];
    const secondExecution = {
      ...baseExecution,
      executionId: `${baseExecution.executionId}-other`,
      state: 'ended',
    };
    const registration = registrationRegistryWithStates(fixture, ['active'], [secondExecution]);
    const questions = [
      questionFor(fixture, { internalQuestionId: `${provider}-status-first` }),
      questionFor(fixture, {
        internalQuestionId: `${provider}-status-second`, executionId: secondExecution.executionId,
      }),
      questionFor(fixture, { internalQuestionId: `${provider}-status-third` }),
    ];
    const runtime = (await startTestServer(t, {
      registrationRegistry: registration.registry,
      questionService: questionServiceFor(questions),
    })).runtime;

    const row = jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
      .find((session) => session.session_id === fixture.registration.sessionId);
    assert.equal(row.status, '不明');
    assert.equal(row.projectionOnly, true);
    assert.equal(row.commonQuestions.length, 3);
    assert.equal(Object.hasOwn(row, 'endedAt'), false);
  });
}

test('実rowのstatusと識別情報はprojectionで上書きされず、合成flagも付かない', async (t) => {
  const fixture = createRegistrationFixture('claude', { nativeId: 'real-row-synthetic-status' });
  const state = new DashboardState();
  state.addEvent({
    session_id: fixture.registration.sessionId,
    hook_event_name: 'UserPromptSubmit',
    hookAt: 1_800_000_000_000,
  }, { provider: 'claude' });
  const before = state.snapshot().sessions.find((session) => session.session_id === fixture.registration.sessionId);
  const runtime = (await startTestServer(t, {
    state,
    registrationRegistry: fixture.registry,
    questionService: questionService(fixture),
  })).runtime;

  const row = jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
    .find((session) => session.session_id === fixture.registration.sessionId);
  for (const field of ['session_id', 'status', 'title', 'product']) assert.deepEqual(row[field], before[field]);
  assert.equal(Object.hasOwn(row, 'projectionOnly'), false);
});

test('実rowが後続GETで現れたらprojectionOnlyを除き実statusへ戻す', async (t) => {
  const fixture = createRegistrationFixture('codex', { nativeId: 'synthetic-row-reappears' });
  const state = new DashboardState();
  const runtime = (await startTestServer(t, {
    state,
    registrationRegistry: fixture.registry,
    questionService: questionService(fixture),
  })).runtime;
  const sessionId = fixture.registration.sessionId;

  const synthetic = jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
    .find((session) => session.session_id === sessionId);
  assert.equal(synthetic.projectionOnly, true);
  state.addEvent({ session_id: sessionId, hook_event_name: 'UserPromptSubmit', hookAt: Date.now() }, { provider: 'codex' });
  const realBefore = state.snapshot().sessions.find((session) => session.session_id === sessionId);
  const real = jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
    .find((session) => session.session_id === sessionId);
  assert.equal(Object.hasOwn(real, 'projectionOnly'), false);
  assert.equal(real.status, realBefore.status);
});

test('hidden projectionは状態を保ち、deleted projectionは状態集約前に除外する', async (t) => {
  const fixture = createRegistrationFixture('claude', { nativeId: 'synthetic-status-display-guards' });
  const state = new DashboardState();
  const runtime = (await startTestServer(t, {
    state,
    registrationRegistry: fixture.registry,
    questionService: questionService(fixture),
  })).runtime;
  const sessionId = fixture.registration.sessionId;

  state.setProjectionHidden('claude', sessionId, true);
  const hidden = jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
    .find((session) => session.session_id === sessionId);
  assert.equal(hidden.hidden, true);
  assert.equal(hidden.projectionOnly, true);
  assert.equal(hidden.status, '待機中');

  state.deleteProjectionDisplay('claude', sessionId, Date.now());
  const deleted = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.equal(deleted.sessions.some((session) => session.session_id === sessionId), false);
});

test('同じsynthetic session IDに複数providerのprojectionがある場合は合成しない', async (t) => {
  const claude = createRegistrationFixture('claude', { nativeId: 'synthetic-shared-projection' });
  const codex = createRegistrationFixture('codex', { nativeId: 'synthetic-codex-shared-projection' });
  const sessionId = claude.registration.sessionId;
  const claudeSnapshot = claude.registry.snapshot();
  const codexSnapshot = codex.registry.snapshot();
  const registrationRegistry = {
    snapshot() {
      return {
        conversations: [...claudeSnapshot.conversations, ...codexSnapshot.conversations],
        executions: [
          ...claudeSnapshot.executions,
          ...codexSnapshot.executions.map((execution) => ({ ...execution, sessionId })),
        ],
      };
    },
    authorizeEvent: (writer) => writer?.identity?.provider === 'codex'
      ? codex.registry.authorizeEvent(writer) : claude.registry.authorizeEvent(writer),
    authorizeWriter: (writer) => writer?.identity?.provider === 'codex'
      ? codex.registry.authorizeWriter(writer) : claude.registry.authorizeWriter(writer),
    isRegisteredSessionId: (id) => id === sessionId,
  };
  const runtime = (await startTestServer(t, {
    registrationRegistry,
    questionService: questionServiceFor([questionFor(claude), questionFor(codex)]),
  })).runtime;

  const snapshot = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.equal(snapshot.sessions.some((session) => session.session_id === sessionId), false);
});

test('質問snapshot失敗時も有効なinstruction projectionの状態を表示し診断を維持する', async (t) => {
  const fixture = createRegistrationFixture('codex', { nativeId: 'question-failure-with-instruction' });
  const registration = registrationRegistryWithStates(fixture, ['ended']);
  const launchRef = 'codex-question-failure-launch';
  const launch = launchFor(fixture, launchRef);
  const runtime = (await startTestServer(t, {
    registrationRegistry: registration.registry,
    launchRegistry: {
      get: (ref) => ref === launchRef ? launch : null,
      snapshot: () => ({ launches: [launch] }),
    },
    questionService: {
      ready: async () => {},
      dashboardSnapshot: async () => { throw new Error('private question snapshot failure'); },
    },
    instructionService: instructionServiceFor([instructionFor(fixture, launchRef)]),
  })).runtime;

  registration.setStates(['ended']);
  const snapshot = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const row = snapshot.sessions.find((session) => session.session_id === fixture.registration.sessionId);
  assert.equal(row.status, '終了済み');
  assert.equal(row.projectionOnly, true);
  assert.equal(row.instructions.length, 1);
  assert.equal(registration.snapshotCount(), 2);
  assert.deepEqual(snapshot.commonQuestionDiagnostics, {
    recovery: { status: 'unavailable', errorCode: 'common_question_state_unavailable' },
  });
});

for (const provider of ['claude', 'codex']) {
  test(`${provider} の実authority終了は応答上の質問rowだけをendedにする`, async (t) => {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-real-authority-end` });
    const state = new DashboardState();
    const runtime = (await startTestServer(t, {
      state,
      registrationRegistry: fixture.registry,
      questionService: questionService(fixture),
    })).runtime;
    const sessionId = fixture.registration.sessionId;

    assert.equal(state.snapshot().sessions.some((session) => session.session_id === sessionId), false);
    const active = jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
      .find((session) => session.session_id === sessionId);
    assert.equal(active.status, '待機中');
    assert.equal(active.projectionOnly, true);
    assert.equal(active.endedAt, undefined);
    const stableFields = ['session_id', 'title', 'product'];
    const stableValues = Object.fromEntries(stableFields.map((field) => [field, active[field]]));
    assert.equal(state.snapshot().sessions.some((session) => session.session_id === sessionId), false);

    assert.equal(fixture.authority.end(fixture.registration.executionId), true);
    assert.equal(fixture.registry.snapshot().executions.find((execution) =>
      execution.executionId === fixture.registration.executionId).state, 'ended');
    const ended = jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions
      .find((session) => session.session_id === sessionId);
    assert.equal(ended.status, '終了済み');
    assert.equal(ended.projectionOnly, true);
    assert.equal(ended.endedAt, undefined);
    assert.deepEqual(Object.fromEntries(stableFields.map((field) => [field, ended[field]])), stableValues);
    assert.equal(state.snapshot().sessions.some((session) => session.session_id === sessionId), false);
  });
}
