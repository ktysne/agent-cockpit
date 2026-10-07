'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { DashboardState } = require('../src/server/state');
const { hookHeaders, jsonBody, request, startTestServer, uiHeaders } = require('./support/server');
const { createRegistrationFixture } = require('./support/registration');

function questionFor(fixture) {
  return {
    internalQuestionId: `projection-question-${fixture.identity.provider}`,
    questionId: 'projection-question',
    identity: fixture.identity,
    executionId: fixture.registration.executionId,
    conversationId: fixture.registration.conversationId,
    createdAt: 1_800_000_000_000,
    questions: [],
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

    const postEvent = (event) => request(runtime.info.port, {
      method: 'POST',
      path: '/api/events',
      headers: hookHeaders(runtime.info.secret, { 'content-type': 'application/json' }),
      body: JSON.stringify(event),
    });
    const stale = await postEvent(registeredEvent(fixture, 'UserPromptSubmit', deletedAt, 1));
    assert.equal(stale.status, 202);
    assert.deepEqual(jsonBody(stale), { accepted: true });
    assert.equal(state.sessions.has(sessionId), false);
    assert.equal(state.projectionDisplayFor(provider, sessionId).deletedAt, new Date(deletedAt).toISOString());

    const unknown = await postEvent(registeredEvent(fixture, 'PermissionRequest', deletedAt + 1, 2));
    assert.equal(unknown.status, 202);
    assert.equal(jsonBody(unknown).status, 'unknown');
    assert.equal(state.sessions.has(sessionId), false);
    assert.equal(state.projectionDisplayFor(provider, sessionId).deletedAt, new Date(deletedAt).toISOString());

    const current = await postEvent(registeredEvent(fixture, 'UserPromptSubmit', deletedAt + 2, 3));
    assert.equal(current.status, 202);
    assert.deepEqual(jsonBody(current), { accepted: true });
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

  const hidden = await postUi(runtime, '/api/hidden-sessions', { action: 'hide', session_id: sharedSessionId });
  assert.equal(hidden.status, 409);
  const deleted = await postUi(runtime, '/api/record-deletions', { session_ids: [sharedSessionId] });
  assert.equal(deleted.status, 409);
  assert.equal(runtime.state.projectionDisplayFor('claude', sharedSessionId), null);
  assert.equal(runtime.state.projectionDisplayFor('codex', sharedSessionId), null);
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
