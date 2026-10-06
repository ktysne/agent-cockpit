'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');
const { startMcpServer } = require('../src/mcp/server');
const { startServer } = require('../src/server/server');
const { createRegistrationKernel } = require('../src/server/conversation-registry');
const { createProviderRegistrationAdapter } = require('../src/server/provider-registration');
const { hookHeaders, request, startTestServer } = require('./support/server');
const { temporaryHome } = require('./support/temp');
const { createRegistrationFixture } = require('./support/registration');

const PROVIDERS = ['claude', 'codex'];

function evidence(evidenceId) {
  return {
    evidenceId,
    source: 'fixture-verifier',
    method: 'authenticated-test-fixture',
    adapterVersion: 'fixture-adapter-1',
    runtimeVersion: 'fixture-runtime-1',
    capabilities: ['native-binding'],
  };
}

function repeatRegistration(fixture) {
  return fixture.adapter.register(fixture.nativeIdentity, fixture.evidence, {
    startId: fixture.startId,
    ...(fixture.identity.provider === 'claude' ? { projectionId: fixture.identity.nativeId } : {}),
  });
}

function mismatchEnvelope(writer, field) {
  const envelope = structuredClone(writer);
  if (field === 'provider') {
    envelope.identity.provider = envelope.identity.provider === 'claude' ? 'codex' : 'claude';
  } else if (field === 'nativeIdKind') {
    envelope.identity.nativeIdKind = envelope.identity.nativeIdKind === 'session' ? 'thread' : 'session';
  } else if (field === 'hostId' || field === 'homeScopeId' || field === 'nativeId') {
    envelope.identity[field] = `mismatch-${envelope.identity[field]}`;
  } else if (field === 'contextId') {
    envelope.contextId = `mismatch-${envelope.contextId}`;
  } else if (field === 'token') {
    envelope.token = 'z'.repeat(43);
  } else if (field === 'executionId') {
    envelope.executionId = 'exec-unbound-mismatch';
  }
  return envelope;
}

function createEffectSpy() {
  return {
    setTasks: 0,
    addDecision: 0,
    updateDecision: 0,
    addEvent: 0,
    captureFieldNames: 0,
    registerPullRequest: 0,
    setCrossReviewSkip: 0,
    afterTasksWrite: 0,
    afterDecisionUpdate: 0,
    afterEvent: 0,
    deliverPostToolBatch: 0,
    refreshRepo: 0,
    refreshRepoFresh: 0,
    mergeCandidate: 0,
    refreshReviewGroups: 0,
    setReviewSkip: 0,
  };
}

function attachStateSpy(runtime, effects) {
  for (const method of [
    'setTasks', 'addDecision', 'updateDecision', 'addEvent', 'captureFieldNames',
    'registerPullRequest', 'setCrossReviewSkip',
  ]) {
    const original = runtime.state[method].bind(runtime.state);
    runtime.state[method] = (...args) => {
      effects[method] += 1;
      return original(...args);
    };
  }
  for (const method of ['afterTasksWrite', 'afterDecisionUpdate', 'afterEvent', 'deliverPostToolBatch']) {
    const original = runtime.answerDelivery[method]?.bind(runtime.answerDelivery);
    if (!original) continue;
    runtime.answerDelivery[method] = (...args) => {
      effects[method] += 1;
      return original(...args);
    };
  }
}

function trackedPullRequestServices(effects) {
  return {
    pullRequestTracker: {
      start() {},
      close() {},
      snapshot() { return []; },
      refreshRepo() { effects.refreshRepo += 1; return Promise.resolve(); },
      async refreshRepoFresh() { effects.refreshRepoFresh += 1; return {}; },
      mergeCandidate() {
        effects.mergeCandidate += 1;
        return { pullRequest: { headRefOid: 'a'.repeat(40) } };
      },
      async refreshReviewGroups() { effects.refreshReviewGroups += 1; },
      async refreshAll() {},
    },
    pullRequestMergeManager: {
      start() {},
      close() {},
      async setReviewSkip(_registration, headRefOid, reason) {
        effects.setReviewSkip += 1;
        return { ok: true, saved: { headRefOid, reason } };
      },
    },
  };
}

function stateSignature(runtime) {
  return JSON.stringify({
    snapshot: runtime.state.snapshot(),
    prs: runtime.state.pullRequestRegistrations(),
    events: [...runtime.state.sessions.entries()],
  });
}

async function mcpExchange(calls, options) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8').on('data', (chunk) => { text += chunk; });
  const running = startMcpServer({ input, output, ...options });
  input.end(`${calls.map((call) => JSON.stringify(call)).join('\n')}\n`);
  await running;
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

function toolCall(id, name, args, meta) {
  return {
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args, ...(meta === undefined ? {} : { _meta: meta }) },
  };
}

function fetchCounter() {
  let postCount = 0;
  const fetchImpl = (url, init) => {
    if (init?.method === 'POST' && new URL(url).pathname.startsWith('/api/sessions/')) postCount += 1;
    return fetch(url, init);
  };
  return { fetchImpl, postCount: () => postCount };
}

test('ID-F01-A01: 両adapterはprovider・native kind・host・HOME・native ID全体を会話identityにする', () => {
  for (const provider of PROVIDERS) {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-canonical` });
    assert.deepEqual(repeatRegistration(fixture), fixture.registration);

    const variants = [
      { hostId: `${fixture.identity.hostId}-other` },
      { homeScopeId: `${fixture.identity.homeScopeId}-other` },
      { nativeId: `${fixture.identity.nativeId}-other` },
      { provider: provider === 'claude' ? 'codex' : 'claude', nativeIdKind: provider === 'claude' ? 'thread' : 'session' },
    ];
    const conversations = new Set([fixture.registration.conversationId]);
    variants.forEach((change, index) => {
      const identity = { ...fixture.identity, ...change };
      const registration = fixture.authority.register(identity, evidence(`${provider}-variant-${index}`), {
        startId: `${provider}-variant-start-${index}`,
      });
      assert.ok(!conversations.has(registration.conversationId));
      conversations.add(registration.conversationId);
    });

    assert.throws(() => fixture.authority.register({
      ...fixture.identity,
      nativeIdKind: fixture.identity.nativeIdKind === 'session' ? 'thread' : 'session',
    }, evidence(`${provider}-invalid-kind`), { startId: `${provider}-invalid-kind-start` }));
    for (const field of ['nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']) {
      const incomplete = { ...fixture.nativeIdentity };
      delete incomplete[field];
      assert.deepEqual(fixture.adapter.observe(incomplete, evidence(`${provider}-missing-${field}`)), {
        ok: false, status: 'mismatch', observationId: null,
      });
      assert.throws(() => fixture.adapter.register(incomplete, evidence(`${provider}-missing-register-${field}`), {
        startId: `${provider}-missing-register-start-${field}`,
      }), (error) => error.code === 'invalid_identity');
    }
    assert.equal(fixture.registry.snapshot().conversations.length, 5);
    assert.ok(fixture.registry.isRegisteredSessionId(fixture.registration.sessionId));
  }
});

test('ID-F01-A02: observerと同一開始証拠は期間を増やさず、終了後の新証拠だけがresumeを作る', () => {
  for (const provider of PROVIDERS) {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-lifecycle` });
    const observation = fixture.adapter.observe(fixture.nativeIdentity, evidence(`${provider}-observer`));
    assert.equal(observation.status, 'unverified');
    assert.equal(fixture.registry.snapshot().executions.length, 1);
    assert.deepEqual(repeatRegistration(fixture), fixture.registration);
    assert.equal(fixture.registry.snapshot().executions.length, 1);

    fixture.authority.end(fixture.registration.executionId);
    const resumedEvidence = evidence(`${provider}-resume-evidence`);
    const resumed = fixture.adapter.register(fixture.nativeIdentity, resumedEvidence, {
      startId: `${provider}-resume-start`,
      resume: true,
    });
    assert.equal(resumed.conversationId, fixture.registration.conversationId);
    assert.notEqual(resumed.executionId, fixture.registration.executionId);
    assert.notEqual(resumed.sessionId, fixture.registration.sessionId);
    assert.equal(fixture.registry.authorizeWriter(fixture.writer).status, 'stale_execution');
    assert.equal(fixture.registry.snapshot().executions.filter((item) => item.state === 'active').length, 1);
  }
});

test('ID-F01-A03: 旧期間eventと期間不明の登録済みalias eventは状態更新前に拒否する', async (t) => {
  for (const provider of PROVIDERS) {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-delayed-event` });
    const effects = createEffectSpy();
    const services = trackedPullRequestServices(effects);
    const server = await startTestServer(t, {
      temporaryPrefix: `agent-cockpit-${provider}-event-`,
      environment: { AGENT_COCKPIT_HOME: (homeDir) => homeDir },
      registrationRegistry: fixture.registry,
      ...services,
    });
    attachStateSpy(server.runtime, effects);
    const headers = hookHeaders(server.info.secret, { 'content-type': 'application/json' });
    const before = stateSignature(server.runtime);
    const post = (body) => request(server.info.port, {
      method: 'POST', path: '/api/events', headers, body: JSON.stringify(body),
    });

    const writerless = await post({
      session_id: fixture.registration.sessionId,
      hook_event_name: 'SessionStart', hookAt: Date.now(),
    });
    assert.equal(writerless.status, 403, provider);

    fixture.authority.end(fixture.registration.executionId);
    const resumedEvidence = evidence(`${provider}-delayed-resume-evidence`);
    const resumed = fixture.adapter.register(fixture.nativeIdentity, resumedEvidence, {
      startId: `${provider}-delayed-resume-start`, resume: true,
    });
    const newWriter = fixture.adapter.bindWriter(resumed.executionId, {
      identity: fixture.identity,
      contextId: `${provider}-delayed-resume-context`,
      evidence: evidence(`${provider}-delayed-resume-binding`),
    });
    const stale = await post({
      session_id: resumed.sessionId,
      writer: fixture.writer,
      hook_event_name: 'PostToolUse', hookAt: Date.now(), tool_name: 'Bash', tool_use_id: 'late-event',
    });
    assert.equal(stale.status, 403, provider);
    assert.equal(stateSignature(server.runtime), before, provider);
    assert.deepEqual(effects, createEffectSpy(), provider);

    const current = await post({
      session_id: resumed.sessionId,
      writer: newWriter,
      hook_event_name: 'SessionStart', hookAt: Date.now(),
    });
    assert.equal(current.status, 202, provider);
    assert.ok(server.runtime.state.snapshot().sessions.some((session) => session.session_id === resumed.sessionId), provider);
  }
});

test('ID-F02-A01: 外部verified・PID・cwd観測は未検証のまま保存されwriter権限を作らない', () => {
  for (const provider of PROVIDERS) {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-untrusted-observation` });
    const kernel = createRegistrationKernel();
    const adapter = createProviderRegistrationAdapter(provider, kernel.registry, kernel.authority);
    const metadata = {
      ...evidence(`${provider}-untrusted-evidence`),
      verified: true,
      pid: 1234,
      cwd: 'D:\\untrusted\\project',
      secret: 'must-not-be-stored',
      payload: 'private body must not be stored',
    };
    const observed = adapter.observe(fixture.nativeIdentity, metadata);
    assert.deepEqual([observed.ok, observed.status], [true, 'unverified']);
    assert.deepEqual(kernel.registry.snapshot().executions, []);
    const saved = kernel.registry.snapshot().observations[0].metadata;
    assert.equal(saved.verified, undefined);
    assert.equal(saved.pid, undefined);
    assert.equal(saved.cwd, undefined);
    assert.equal(saved.secret, undefined);
    assert.equal(saved.payload, undefined);
    assert.ok(!JSON.stringify(kernel.registry.snapshot()).includes('must-not-be-stored'));
    assert.equal(kernel.registry.authorizeWriter(fixture.writer).ok, false);
  }
});

test('ID-F02-A02: active identityの二重開始とbinding identity差し替えを拒否する', () => {
  for (const provider of PROVIDERS) {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-duplicate-binding` });
    assert.throws(() => fixture.adapter.register(
      fixture.nativeIdentity,
      evidence(`${provider}-duplicate-evidence`),
      { startId: `${provider}-duplicate-start` },
    ), (error) => error.code === 'active_execution');
    assert.throws(() => fixture.authority.bindWriter(fixture.registration.executionId, {
      identity: { ...fixture.identity, homeScopeId: `${fixture.identity.homeScopeId}-other` },
      contextId: 'different-context',
      evidence: evidence(`${provider}-mismatched-binding`),
    }), (error) => error.code === 'invalid_binding');
    assert.equal(fixture.adapter.authorizeWrite(fixture.writer, fixture.nativeContext).status, 'accepted');
    for (const field of ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId', 'contextId']) {
      const changedContext = { ...fixture.nativeContext };
      changedContext[field] = field === 'provider'
        ? (provider === 'claude' ? 'codex' : 'claude')
        : `mismatch-${fixture.nativeContext[field]}`;
      const denied = fixture.adapter.authorizeWrite(fixture.writer, changedContext);
      assert.deepEqual([denied.ok, denied.status], [false, 'mismatch'], `${provider}/${field}`);
    }
    assert.equal(fixture.registry.snapshot().executions.length, 1);

    fixture.authority.end(fixture.registration.executionId);
    assert.throws(() => fixture.adapter.register(fixture.nativeIdentity, fixture.evidence, {
      startId: `${provider}-replayed-evidence-start`, resume: true,
    }), (error) => error.code === 'evidence_replay');
  }
});

test('ID-F02-A03: MCPはCodexのthread metadataなし・不一致とClaude metadata混入を送信しない', async (t) => {
  for (const provider of PROVIDERS) {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-mcp-native` });
    const services = trackedPullRequestServices(createEffectSpy());
    const server = await startTestServer(t, {
      temporaryPrefix: `agent-cockpit-${provider}-mcp-`,
      environment: { AGENT_COCKPIT_HOME: (homeDir) => homeDir },
      registrationRegistry: fixture.registry,
      ...services,
    });
    const counter = fetchCounter();
    const environment = provider === 'codex'
      ? { CLAUDE_CODE_SESSION_ID: 'inherited-claude-session' }
      : { CLAUDE_CODE_SESSION_ID: fixture.identity.nativeId };
    const options = {
      homeDir: server.homeDir,
      environment,
      writer: fixture.writer,
      fetchImpl: counter.fetchImpl,
    };
    const meta = provider === 'codex'
      ? { provider: 'codex', threadId: fixture.identity.nativeId }
      : { provider: 'claude' };

    const invalidCalls = provider === 'codex'
      ? [
        toolCall('missing-meta', 'cockpit_set_tasks', { tasks: [] }),
        toolCall('mismatched-meta', 'cockpit_set_tasks', { tasks: [] }, { provider: 'codex', threadId: 'other-thread' }),
      ]
      : [
        toolCall('mixed-claude-meta', 'cockpit_set_tasks', { tasks: [] }, { provider: 'claude', threadId: 'codex-thread' }),
      ];
    const invalid = await mcpExchange(invalidCalls, options);
    assert.equal(invalid.length, invalidCalls.length, provider);
    assert.ok(invalid.every((response) => response.result.isError === true), provider);
    assert.equal(counter.postCount(), 0, provider);

    const valid = await mcpExchange([
      toolCall('valid', 'cockpit_set_tasks', {
        tasks: [{ title: `${provider} MCP task`, state: 'doing', criteria: [] }],
      }, meta),
    ], options);
    assert.equal(valid[0].result.isError, undefined, provider);
    assert.equal(counter.postCount(), 1, provider);
    assert.equal(server.runtime.state.planSummary(fixture.registration.sessionId).tasks[0].title, `${provider} MCP task`, provider);

    if (provider === 'claude') {
      const wrongEnvironment = await mcpExchange([
        toolCall('wrong-env', 'cockpit_set_tasks', { tasks: [] }, { provider: 'claude' }),
      ], { ...options, environment: { CLAUDE_CODE_SESSION_ID: 'different-claude-session' } });
      assert.equal(wrongEnvironment[0].result.isError, true);
      assert.equal(counter.postCount(), 1);
    }
  }
});

test('ID-F02-A04: HTTP plan・decision・PR・skip-reviewは全claim不一致で副作用を起こさない', async (t) => {
  const claimFields = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId', 'contextId', 'token', 'executionId'];
  const operations = [
    {
      path: '/api/sessions/pending/plan',
      body: (writer) => ({ kind: 'tasks', tasks: [], writer }),
    },
    {
      path: '/api/sessions/pending/plan',
      body: (writer) => ({
        kind: 'add_decision', title: 'decision mismatch', context: '', state: 'waiting',
        options: [{ label: 'defer', description: '', recommended: true }], writer,
      }),
    },
    {
      path: '/api/sessions/pending/plan',
      body: (writer, decisionId) => ({
        kind: 'update_decision', id: decisionId, state: 'resolved', chosen: 'continue', note: 'confirmed', writer,
      }),
    },
    {
      path: '/api/sessions/pending/prs',
      body: (writer) => ({ kind: 'add_pr', url: 'https://github.com/example/project/pull/81', writer }),
    },
    {
      path: '/api/sessions/pending/prs',
      body: (writer) => ({
        kind: 'skip_review', owner: 'example', repo: 'project', number: 80,
        headRefOid: 'a'.repeat(40), reason: 'identity mismatch', writer,
      }),
    },
  ];

  for (const provider of PROVIDERS) {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-http-claims` });
    const effects = createEffectSpy();
    const services = trackedPullRequestServices(effects);
    const server = await startTestServer(t, {
      temporaryPrefix: `agent-cockpit-${provider}-claims-`,
      environment: { AGENT_COCKPIT_HOME: (homeDir) => homeDir },
      registrationRegistry: fixture.registry,
      ...services,
    });
    server.runtime.state.registerPullRequest(fixture.registration.sessionId, {
      url: 'https://github.com/example/project/pull/80',
    });
    const decision = server.runtime.state.addDecision(fixture.registration.sessionId, {
      title: 'decision for update', context: '', state: 'waiting',
      options: [{ label: 'continue', description: '', recommended: true }],
    });
    attachStateSpy(server.runtime, effects);

    const headers = { 'content-type': 'application/json', 'x-cockpit-secret': server.info.secret };
    const validOperations = [
      { path: '/api/sessions/pending/plan', body: { kind: 'tasks', tasks: [{ title: 'accepted task', state: 'doing', criteria: [] }] } },
      { path: '/api/sessions/pending/plan', body: {
        kind: 'add_decision', title: 'accepted decision', context: '', state: 'waiting',
        options: [{ label: 'continue', description: '', recommended: true }],
      } },
      { path: '/api/sessions/pending/plan', body: {
        kind: 'update_decision', id: decision.id, state: 'resolved', chosen: 'continue', note: 'confirmed',
      } },
      { path: '/api/sessions/pending/prs', body: { kind: 'add_pr', url: 'https://github.com/example/project/pull/83' } },
      { path: '/api/sessions/pending/prs', body: {
        kind: 'skip_review', owner: 'example', repo: 'project', number: 80,
        headRefOid: 'a'.repeat(40), reason: 'accepted skip',
      } },
    ];
    for (const operation of validOperations) {
      const response = await request(server.info.port, {
        method: 'POST', path: operation.path, headers,
        body: JSON.stringify({ ...operation.body, writer: fixture.writer }),
      });
      assert.equal(response.status, 200, `${provider}/${operation.body.kind} valid control`);
    }
    for (const key of Object.keys(effects)) effects[key] = 0;
    const beforeState = stateSignature(server.runtime);
    const beforeEffects = structuredClone(effects);

    for (const claimField of claimFields) {
      const writer = mismatchEnvelope(fixture.writer, claimField);
      for (const operation of operations) {
        const response = await request(server.info.port, {
          method: 'POST', path: operation.path, headers,
          body: JSON.stringify(operation.body(writer, decision.id)),
        });
        assert.equal(response.status, 403, `${provider}/${claimField}/${operation.path}`);
        assert.equal(stateSignature(server.runtime), beforeState, `${provider}/${claimField}/${operation.path}`);
        assert.deepEqual(effects, beforeEffects, `${provider}/${claimField}/${operation.path}`);
      }
    }

    fixture.authority.end(fixture.registration.executionId);
    const resumed = fixture.adapter.register(fixture.nativeIdentity, evidence(`${provider}-expired-writer-evidence`), {
      startId: `${provider}-expired-writer-start`, resume: true,
    });
    for (const operation of operations) {
      const response = await request(server.info.port, {
        method: 'POST', path: operation.path, headers,
        body: JSON.stringify(operation.body(fixture.writer, decision.id)),
      });
      assert.equal(response.status, 403, `${provider}/expired/${operation.path}`);
      assert.equal(stateSignature(server.runtime), beforeState, `${provider}/expired/${operation.path}`);
      assert.deepEqual(effects, beforeEffects, `${provider}/expired/${operation.path}`);
    }
    assert.notEqual(resumed.executionId, fixture.registration.executionId);

    const legacy = await request(server.info.port, {
      method: 'POST', path: '/api/sessions/pending/plan', headers,
      body: JSON.stringify({
        kind: 'tasks', tasks: [], session_id: fixture.registration.sessionId,
        ppid: 4242, claudeCodeSessionId: fixture.identity.nativeId,
      }),
    });
    assert.equal(legacy.status, 403, provider);
    assert.equal(stateSignature(server.runtime), beforeState, provider);
    assert.deepEqual(effects, beforeEffects, provider);
  }
});

test('ID-F02-A05: Claude旧store表示はreload後も残り、restartは旧writer tokenを復元しない', async (t) => {
  for (const provider of PROVIDERS) {
    const fixture = createRegistrationFixture(provider, { nativeId: `${provider}-restart-native` });
    const temporary = temporaryHome(t, `agent-cockpit-${provider}-restart-`, { deferCleanup: true });
    const legacySessionId = 'legacy-claude-session';
    const now = Date.now();
    const sessionsDirectory = path.join(temporary.claudeHome, 'sessions');
    await fs.mkdir(sessionsDirectory, { recursive: true });
    await fs.writeFile(path.join(sessionsDirectory, `${legacySessionId}.json`), JSON.stringify({
      session_id: legacySessionId,
      pid: process.pid,
      cwd: process.cwd(),
      name: 'Legacy Claude session',
      updatedAt: now,
    }));
    const startOptions = (registrationRegistry) => ({
      homeDir: temporary.homeDir,
      claudeHome: temporary.claudeHome,
      userHome: temporary.homeDir,
      port: 0,
      registrationRegistry,
      ...trackedPullRequestServices(createEffectSpy()),
    });
    let runtime = await startServer(startOptions(fixture.registry));
    t.after(async () => {
      await runtime?.close();
      await temporary.cleanup();
    });

    runtime.state.setTasks(legacySessionId, [{ title: 'saved Claude task', state: 'doing', criteria: [] }], now);
    runtime.state.addDecision(legacySessionId, {
      title: 'saved Claude decision', context: '', state: 'waiting',
      options: [{ label: 'continue', description: '', recommended: true }],
    }, now);
    runtime.state.registerPullRequest(legacySessionId, {
      url: 'https://github.com/example/project/pull/82',
    }, {}, now);
    runtime.state.addEvent({
      session_id: legacySessionId,
      hook_event_name: 'SessionStart',
      hookAt: now,
    });
    await runtime.state.waitForPersistence();
    const saved = runtime.state.snapshot().sessions.find((session) => session.session_id === legacySessionId);
    assert.equal(saved.tasks[0].title, 'saved Claude task', provider);
    assert.equal(saved.decisions[0].title, 'saved Claude decision', provider);
    assert.equal(runtime.state.pullRequestRegistrations().some((item) => item.number === 82), true, provider);

    await runtime.close();
    runtime = await startServer(startOptions(createRegistrationKernel().registry));
    const reloaded = runtime.state.snapshot().sessions.find((session) => session.session_id === legacySessionId);
    assert.equal(reloaded.tasks[0].title, 'saved Claude task', provider);
    assert.equal(reloaded.decisions[0].title, 'saved Claude decision', provider);
    assert.equal(runtime.state.pullRequestRegistrations().some((item) => item.number === 82), true, provider);
    assert.equal(runtime.state.snapshot().sessions.some((session) => session.session_id === fixture.registration.sessionId), false, provider);

    const counter = fetchCounter();
    const meta = provider === 'codex'
      ? { provider: 'codex', threadId: fixture.identity.nativeId }
      : { provider: 'claude' };
    const environment = provider === 'codex'
      ? { CLAUDE_CODE_SESSION_ID: 'legacy-claude-session' }
      : { CLAUDE_CODE_SESSION_ID: fixture.identity.nativeId };
    const response = await mcpExchange([
      toolCall('old-token', 'cockpit_set_tasks', {
        tasks: [{ title: 'must not persist', state: 'doing', criteria: [] }],
      }, meta),
    ], {
      homeDir: temporary.homeDir,
      environment,
      writer: fixture.writer,
      fetchImpl: counter.fetchImpl,
    });
    assert.equal(response[0].result.isError, true, provider);
    assert.equal(counter.postCount(), 1, provider);
    assert.equal(runtime.state.snapshot().sessions.find((session) => session.session_id === legacySessionId).tasks[0].title, 'saved Claude task', provider);
    assert.equal(runtime.state.snapshot().sessions.some((session) => session.tasks?.some((task) => task.title === 'must not persist')), false, provider);
  }
});
