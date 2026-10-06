'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createRegistrationKernel } = require('../src/server/conversation-registry');
const { createProviderRegistrationAdapter } = require('../src/server/provider-registration');

function claudeNative(overrides = {}) {
  return {
    nativeIdKind: 'session',
    hostId: 'host-a',
    homeScopeId: 'home-a',
    nativeId: 'claude-session',
    ...overrides,
  };
}

function identityFrom(provider, nativeIdentity) {
  return { provider, ...nativeIdentity };
}

function evidence(evidenceId, extras = {}) {
  return {
    evidenceId,
    source: 'test-fixture',
    method: 'authorized-registration',
    adapterVersion: 'fixture-1',
    capabilities: ['thread-observation'],
    ...extras,
  };
}

function register(authority, identity, startId, options = {}) {
  return authority.register(identity, evidence(`evidence-${startId}`), { startId, ...options });
}

function bind(authority, execution, identity, contextId = 'context-main', evidenceId = 'binding-evidence') {
  return authority.bindWriter(execution.executionId, {
    identity,
    contextId,
    evidence: evidence(evidenceId),
  });
}

function nativeContext(identity, contextId = 'context-main') {
  return { ...identity, contextId };
}

test('identity tuple separates provider, native kind, host, HOME scope, and native ID', () => {
  const { registry, authority } = createRegistrationKernel();
  const baseNative = claudeNative();
  const baseIdentity = identityFrom('claude', baseNative);
  const first = register(authority, baseIdentity, 'start-base');
  authority.end(first.executionId);

  const variants = [
    [identityFrom('codex', { ...baseNative, nativeIdKind: 'thread' }), 'provider-kind'],
    [identityFrom('claude', claudeNative({ hostId: 'host-b' })), 'host'],
    [identityFrom('claude', claudeNative({ homeScopeId: 'home-b' })), 'home'],
    [identityFrom('claude', claudeNative({ nativeId: 'claude-session-b' })), 'native'],
  ];

  for (const [identity, label] of variants) {
    const next = register(authority, identity, `start-${label}`);
    assert.notEqual(next.conversationId, first.conversationId, label);
    authority.end(next.executionId);
  }
  assert.equal(registry.snapshot().conversations.length, variants.length + 1);
});

test('unsupported or incomplete identities cannot create verified conversations', () => {
  const { registry, authority } = createRegistrationKernel();
  const invalidIdentities = [
    { provider: 'claude-code', ...claudeNative() },
    { provider: 'claude', ...claudeNative({ nativeIdKind: 'thread' }) },
    { provider: 'claude', ...claudeNative({ homeScopeId: '' }) },
    { provider: 'claude', ...claudeNative(), extra: 'not part of the tuple' },
  ];

  for (const identity of invalidIdentities) {
    assert.throws(() => authority.register(identity, evidence('invalid'), { startId: 'invalid-start' }));
  }
  assert.equal(registry.snapshot().conversations.length, 0);
});

test('observations remain unverified and metadata stores only allowlisted fields', () => {
  const { registry } = createRegistrationKernel();
  const identity = identityFrom('claude', claudeNative());
  const observation = registry.observe(identity, evidence('observation-evidence', {
    verified: true,
    token: 'secret-token',
    payload: 'private body',
  }));

  assert.deepEqual({ ok: observation.ok, status: observation.status }, { ok: true, status: 'unverified' });
  assert.equal(typeof observation.observationId, 'string');
  const snapshot = registry.snapshot();
  assert.equal(snapshot.conversations.length, 0);
  assert.equal(snapshot.executions.length, 0);
  assert.equal(snapshot.observations[0].status, 'unverified');
  assert.equal(typeof registry.register, 'undefined');
  assert.equal(typeof registry.bindWriter, 'undefined');
  assert.equal(snapshot.observations[0].metadata.evidenceId, 'observation-evidence');
  assert.equal(Object.hasOwn(snapshot.observations[0].metadata, 'verified'), false);
  assert.equal(Object.hasOwn(snapshot.observations[0].metadata, 'token'), false);
  assert.equal(Object.hasOwn(snapshot.observations[0].metadata, 'payload'), false);
  assert.equal(JSON.stringify(snapshot).includes('secret-token'), false);
  assert.equal(registry.authorizeWriter({}).status, 'unverified');
});

test('same start evidence is idempotent and conflicting replay cannot replace it', () => {
  const { authority } = createRegistrationKernel();
  const identity = identityFrom('claude', claudeNative());
  const start = { startId: 'start-once' };
  const proof = evidence('proof-once');
  const first = authority.register(identity, proof, start);
  const replay = authority.register(identity, proof, start);
  assert.deepEqual(replay, first);

  assert.throws(
    () => authority.register(identity, evidence('proof-different'), start),
    (error) => error.code === 'start_replay_mismatch',
  );
  assert.throws(
    () => register(authority, identity, 'start-other'),
    (error) => error.code === 'active_execution',
  );
});

test('a new execution requires explicit resume and a fresh evidence ID', () => {
  const { authority } = createRegistrationKernel();
  const identity = identityFrom('claude', claudeNative());
  const first = authority.register(identity, evidence('proof-first'), { startId: 'start-first' });
  authority.end(first.executionId);

  assert.throws(
    () => authority.register(identity, evidence('proof-new'), { startId: 'start-without-resume' }),
    (error) => error.code === 'resume_required',
  );
  assert.throws(
    () => authority.register(identity, evidence('proof-first'), { startId: 'start-replayed-proof', resume: true }),
    (error) => error.code === 'evidence_replay',
  );
  const resumed = authority.register(identity, evidence('proof-resume'), { startId: 'start-resume', resume: true });
  assert.equal(resumed.conversationId, first.conversationId);
  assert.notEqual(resumed.executionId, first.executionId);
  assert.notEqual(resumed.sessionId, identity.nativeId);
});

test('ending a period invalidates its writer and resume creates a new period', () => {
  const { registry, authority } = createRegistrationKernel();
  const identity = identityFrom('claude', claudeNative());
  const first = register(authority, identity, 'start-first');
  const firstWriter = bind(authority, first, identity);
  const firstContext = nativeContext(identity);
  assert.equal(registry.authorizeWriter(firstWriter).status, 'accepted');
  assert.equal(registry.authorizeEvent(firstWriter).status, 'accepted');

  assert.equal(authority.end(first.executionId), true);
  assert.equal(authority.end(first.executionId), true);
  assert.equal(registry.authorizeWriter(firstWriter).status, 'stale_execution');
  assert.equal(registry.authorizeEvent(firstWriter).status, 'stale_execution');
  assert.throws(
    () => authority.bindWriter(first.executionId, {
      identity,
      contextId: firstContext.contextId,
      evidence: evidence('late-binding'),
    }),
    (error) => error.code === 'stale_execution',
  );

  const resumed = register(authority, identity, 'start-resume', { resume: true });
  assert.equal(resumed.conversationId, first.conversationId);
  assert.notEqual(resumed.executionId, first.executionId);
  assert.notEqual(resumed.sessionId, identity.nativeId);
  assert.match(resumed.sessionId, /^exec-[0-9a-f-]{36}$/);
  const resumedWriter = bind(authority, resumed, identity);
  assert.equal(registry.authorizeWriter(firstWriter).status, 'stale_execution');
  assert.equal(registry.authorizeEvent(firstWriter).status, 'stale_execution');
  assert.equal(registry.authorizeWriter(resumedWriter).status, 'accepted');
});

test('resume cannot start an active or nonexistent prior execution', () => {
  const { authority, registry } = createRegistrationKernel();
  const identity = identityFrom('codex', {
    nativeIdKind: 'thread', hostId: 'host-a', homeScopeId: 'home-a', nativeId: 'thread-a',
  });
  assert.throws(
    () => register(authority, identity, 'resume-first', { resume: true }),
    (error) => error.code === 'invalid_resume',
  );
  assert.equal(registry.snapshot().conversations.length, 0);
});

test('Claude aliases are collision-safe while Codex and resumed periods use execution IDs', () => {
  const { registry, authority } = createRegistrationKernel();
  const firstIdentity = identityFrom('claude', claudeNative({ nativeId: 'shared-session' }));
  const first = register(authority, firstIdentity, 'start-alias-one');
  assert.equal(first.sessionId, 'shared-session');
  authority.end(first.executionId);

  const otherIdentity = identityFrom('claude', claudeNative({ hostId: 'host-b', nativeId: 'shared-session' }));
  const other = register(authority, otherIdentity, 'start-alias-two');
  assert.notEqual(other.sessionId, 'shared-session');
  assert.match(other.sessionId, /^exec-[0-9a-f-]{36}$/);
  assert.equal(registry.isRegisteredSessionId('shared-session'), true);
  assert.equal(registry.isRegisteredSessionId(other.sessionId), true);
  assert.equal(registry.isRegisteredSessionId('unknown-session'), false);

  authority.end(other.executionId);
  const legacyIdentity = identityFrom('claude', claudeNative({ nativeId: 'legacy_session' }));
  const legacy = register(authority, legacyIdentity, 'start-legacy-alias');
  assert.notEqual(legacy.sessionId, 'legacy_session');
  assert.match(legacy.sessionId, /^exec-[0-9a-f-]{36}$/);
  assert.equal(registry.isRegisteredSessionId('legacy_session'), false);
  authority.end(legacy.executionId);

  const codexIdentity = identityFrom('codex', {
    nativeIdKind: 'thread', hostId: 'host-a', homeScopeId: 'home-a', nativeId: 'thread-a',
  });
  const codex = register(authority, codexIdentity, 'start-codex');
  assert.match(codex.sessionId, /^exec-[0-9a-f-]{36}$/);
  assert.throws(() => register(authority, codexIdentity, 'start-codex-alias', { projectionId: 'thread-a' }));
});

test('provider adapter binds and authorizes every native context field', () => {
  const { registry, authority } = createRegistrationKernel();
  const adapter = createProviderRegistrationAdapter('codex', registry, authority);
  const nativeIdentity = {
    nativeIdKind: 'thread',
    hostId: 'host-codex',
    homeScopeId: 'home-codex',
    nativeId: 'thread-123',
  };
  const identity = identityFrom('codex', nativeIdentity);
  const observation = adapter.observe(nativeIdentity, evidence('codex-observation', { verified: true }));
  assert.equal(observation.status, 'unverified');
  const execution = adapter.register(nativeIdentity, evidence('codex-start'), { startId: 'codex-start' });
  const writer = adapter.bindWriter(execution.executionId, {
    identity,
    contextId: 'codex-context',
    evidence: evidence('codex-binding'),
  });
  const context = nativeContext(identity, 'codex-context');
  assert.equal(adapter.authorizeWrite(writer, context).status, 'accepted');

  const mismatches = [
    { ...context, provider: 'claude' },
    { ...context, nativeIdKind: 'session' },
    { ...context, hostId: 'other-host' },
    { ...context, homeScopeId: 'other-home' },
    { ...context, nativeId: 'other-thread' },
    { ...context, contextId: 'other-context' },
  ];
  for (const mismatch of mismatches) assert.equal(adapter.authorizeWrite(writer, mismatch).status, 'mismatch');
  assert.equal(adapter.authorizeWrite({ ...writer, identity: { ...identity, nativeId: 'other-thread' } }, context).status, 'mismatch');
  assert.equal(adapter.authorizeWrite(writer, { ...context, extra: 'untrusted' }).status, 'mismatch');
});

test('rebinding a context invalidates its previous token and snapshots never expose writer secrets', () => {
  const { registry, authority } = createRegistrationKernel();
  const identity = identityFrom('claude', claudeNative());
  const execution = register(authority, identity, 'start-rebind');
  const oldWriter = bind(authority, execution, identity, 'context-one', 'binding-old');
  const newWriter = bind(authority, execution, identity, 'context-one', 'binding-new');
  assert.notEqual(newWriter.token, oldWriter.token);
  assert.equal(registry.authorizeWriter(oldWriter).status, 'unverified');
  assert.equal(registry.authorizeWriter(newWriter).status, 'accepted');

  const snapshot = registry.snapshot();
  assert.equal(JSON.stringify(snapshot).includes(oldWriter.token), false);
  assert.equal(JSON.stringify(snapshot).includes(newWriter.token), false);
  snapshot.executions[0].evidence.capabilities.push('mutated');
  assert.deepEqual(registry.snapshot().executions[0].evidence.capabilities, ['thread-observation']);
});

test('metadata over configured bounds is rejected without retaining partial observations', () => {
  const { registry } = createRegistrationKernel();
  const result = registry.observe(identityFrom('claude', claudeNative()), {
    evidenceId: 'too-large',
    source: 'x'.repeat(513),
  });
  assert.deepEqual(result, { ok: false, status: 'mismatch', observationId: null });
  assert.equal(registry.observe(identityFrom('claude', claudeNative()), {
    evidenceId: 'sparse-capabilities',
    capabilities: new Array(1),
  }).status, 'mismatch');
  assert.equal(registry.snapshot().observations.length, 0);
});
