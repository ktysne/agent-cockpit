'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createInstructionEnvelope } = require('../src/server/instruction-envelope');
const {
  DEFAULT_TTL_MS,
  MAX_BUFFER_BYTES,
  MAX_PENDING,
  createInstructionInputCorrelator,
} = require('../src/server/instruction-input-correlator');

function fixture({ text = 'expected input', deliveryAttemptId = 'attempt-delivery-one' } = {}) {
  const identity = {
    provider: 'claude', nativeIdKind: 'session', hostId: 'host-one', homeScopeId: 'home-one', nativeId: 'session-one',
  };
  const actor = { kind: 'agent', id: 'agent-one' };
  const claims = {
    launchId: 'launch-one', runId: 'run-one', attemptId: 'attempt-one', provider: 'claude',
    nativeIdKind: 'session', hostId: 'host-one', homeScopeId: 'home-one', origin: 'standalone',
    purpose: 'agent', originBinding: null,
  };
  const source = {
    launchRef: 'launch-ref-one', claims, identity,
    executionBinding: { periodId: 'period-one', actor },
    conversationId: 'conversation-one', sessionId: 'session-one',
  };
  const target = {
    kind: 'execution', launchRef: source.launchRef, claims, identity,
    periodId: source.executionBinding.periodId, actor,
    conversationId: source.conversationId, sessionId: source.sessionId,
  };
  const envelope = createInstructionEnvelope({ mode: 'steer', expectedTurnId: 'turn-one', text });
  const registration = {
    deliveryAttemptId, source, target, revision: 1,
    payloadDigest: envelope.envelopeDigest, nativeContentDigest: envelope.nativeContentDigest,
    mode: 'steer', expectedTurnId: 'turn-one',
  };
  const evidence = {
    source, target, clientRequestId: deliveryAttemptId, nativeTurnId: 'turn-one',
    nativeItemId: 'native-item-one', input: envelope.envelope.input,
  };
  return { deliveryAttemptId, source, target, envelope, registration, evidence };
}

function defer() {
  let resolve;
  const promise = new Promise((accept) => { resolve = accept; });
  return { promise, resolve };
}

async function waitFor(predicate) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('expected asynchronous correlator transition did not complete');
}

test('matching JSON claims without the captured source token cannot be applied', async () => {
  const value = fixture();
  let applyCalls = 0;
  const sourceToken = Symbol('source-capability');
  let correlator;
  correlator = createInstructionInputCorrelator({
    onApplied: (id, evidence, token) => {
      applyCalls += 1;
      assert.equal(correlator.beginApplyCommit(id, token, evidence), true);
      return Promise.resolve(true);
    },
    onUnknown: () => {},
  });
  correlator.register(value.registration);
  correlator.attachSourceToken(value.deliveryAttemptId, sourceToken);
  correlator.markDispatching(value.deliveryAttemptId, sourceToken);
  assert.equal(correlator.observe({
    deliveryAttemptId: value.deliveryAttemptId,
    sourceToken: Symbol('other-source'),
    evidence: { ...value.evidence, verified: true },
  }), false);
  assert.equal(correlator.observe({
    deliveryAttemptId: value.deliveryAttemptId,
    sourceToken,
    evidence: value.evidence,
  }), true);
  assert.equal(applyCalls, 0);
  correlator.accepted(value.deliveryAttemptId, sourceToken, {
    clientRequestId: value.deliveryAttemptId, nativeTurnId: 'turn-one', nativeItemId: null,
  });
  await waitFor(() => applyCalls === 1 && correlator.pendingCount === 0);
  assert.equal(correlator.diagnostics().length, 0);
  correlator.close();
});

test('a synchronous apply callback failure terminally closes the pending attempt as unknown', async () => {
  const value = fixture();
  const sourceToken = Symbol('source-capability');
  const unknown = [];
  const correlator = createInstructionInputCorrelator({
    onApplied: () => { throw new Error('fixture persistence callback failure'); },
    onUnknown: (id, reason) => { unknown.push({ id, reason }); },
  });
  correlator.register(value.registration);
  correlator.attachSourceToken(value.deliveryAttemptId, sourceToken);
  correlator.markDispatching(value.deliveryAttemptId, sourceToken);
  correlator.accepted(value.deliveryAttemptId, sourceToken, {
    clientRequestId: value.deliveryAttemptId, nativeTurnId: 'turn-one', nativeItemId: null,
  });
  correlator.observe({ deliveryAttemptId: value.deliveryAttemptId, sourceToken, evidence: value.evidence });
  assert.equal(correlator.pendingCount, 0);
  assert.deepEqual(unknown, [{ deliveryAttemptId: value.deliveryAttemptId, code: 'instruction_evidence_conflict' }]
    .map(({ deliveryAttemptId, code }) => ({ id: deliveryAttemptId, reason: code })));
  correlator.close();
});
test('an expired accepted attempt is closed even when its timer callback has not run', () => {
  const value = fixture();
  let currentTime = 0;
  let timerCallback;
  const sourceToken = Symbol('source-capability');
  const unknown = [];
  const correlator = createInstructionInputCorrelator({
    now: () => currentTime,
    setTimeoutImpl: (callback) => { timerCallback = callback; return { unref() {} }; },
    clearTimeoutImpl: () => {},
    onApplied: () => assert.fail('expired evidence cannot be applied'),
    onUnknown: (id, reason) => unknown.push({ id, reason }),
  });
  correlator.register(value.registration);
  correlator.attachSourceToken(value.deliveryAttemptId, sourceToken);
  correlator.markDispatching(value.deliveryAttemptId, sourceToken);
  currentTime = DEFAULT_TTL_MS;

  assert.equal(correlator.accepted(value.deliveryAttemptId, sourceToken, {
    clientRequestId: value.deliveryAttemptId, nativeTurnId: 'turn-one', nativeItemId: null,
  }), false);
  assert.equal(typeof timerCallback, 'function');
  assert.equal(correlator.pendingCount, 0);
  assert.deepEqual(unknown, [{ id: value.deliveryAttemptId, reason: 'instruction_evidence_expired' }]);
  correlator.close();
});

test('the commit guard rejects evidence after TTL even while an apply callback is waiting', async () => {
  const value = fixture();
  let currentTime = 5;
  let timerCallback;
  const sourceToken = Symbol('source-capability');
  const applyGate = defer();
  let appliedSaves = 0;
  let guardResult;
  const unknown = [];
  let correlator;
  correlator = createInstructionInputCorrelator({
    now: () => currentTime,
    setTimeoutImpl: (callback) => { timerCallback = callback; return { unref() {} }; },
    clearTimeoutImpl: () => {},
    onApplied: async (id, evidence, token) => {
      await applyGate.promise;
      guardResult = correlator.beginApplyCommit(id, token, evidence);
      if (guardResult) appliedSaves += 1;
      return guardResult;
    },
    onUnknown: (id, reason) => unknown.push({ id, reason }),
  });
  correlator.register(value.registration);
  correlator.attachSourceToken(value.deliveryAttemptId, sourceToken);
  correlator.markDispatching(value.deliveryAttemptId, sourceToken);
  correlator.accepted(value.deliveryAttemptId, sourceToken, {
    clientRequestId: value.deliveryAttemptId, nativeTurnId: 'turn-one', nativeItemId: null,
  });
  assert.equal(correlator.observe({ deliveryAttemptId: value.deliveryAttemptId, sourceToken, evidence: value.evidence }), true);
  currentTime += DEFAULT_TTL_MS;
  assert.equal(typeof timerCallback, 'function');
  applyGate.resolve();
  await waitFor(() => correlator.pendingCount === 0);

  assert.equal(guardResult, false);
  assert.equal(appliedSaves, 0);
  assert.deepEqual(unknown, [{ id: value.deliveryAttemptId, reason: 'instruction_evidence_expired' }]);
  correlator.close();
});

test('evidence arriving after TTL cannot revive an attempt when its timer callback is delayed', () => {
  const value = fixture();
  let currentTime = 0;
  let timerCallback;
  const sourceToken = Symbol('source-capability');
  const unknown = [];
  const correlator = createInstructionInputCorrelator({
    now: () => currentTime,
    setTimeoutImpl: (callback) => { timerCallback = callback; return { unref() {} }; },
    clearTimeoutImpl: () => {},
    onApplied: () => assert.fail('late evidence cannot be applied'),
    onUnknown: (id, reason) => unknown.push({ id, reason }),
  });
  correlator.register(value.registration);
  correlator.attachSourceToken(value.deliveryAttemptId, sourceToken);
  correlator.markDispatching(value.deliveryAttemptId, sourceToken);
  currentTime = DEFAULT_TTL_MS;

  assert.equal(correlator.observe({ deliveryAttemptId: value.deliveryAttemptId, sourceToken, evidence: value.evidence }), false);
  assert.equal(typeof timerCallback, 'function');
  assert.equal(correlator.accepted(value.deliveryAttemptId, sourceToken, {
    clientRequestId: value.deliveryAttemptId, nativeTurnId: 'turn-one', nativeItemId: null,
  }), false);
  assert.equal(correlator.pendingCount, 0);
  assert.deepEqual(unknown, [{ id: value.deliveryAttemptId, reason: 'instruction_evidence_expired' }]);
  correlator.close();
});

test('evidence for an old period, another identity, or partial input is terminally rejected', () => {
  const mutations = [
    (value) => ({ ...value.evidence, target: { ...value.target, periodId: 'period-old' } }),
    (value) => {
      const identity = { ...value.source.identity, homeScopeId: 'home-other' };
      const claims = { ...value.source.claims, homeScopeId: 'home-other' };
      return {
        ...value.evidence,
        source: { ...value.source, identity, claims },
        target: { ...value.target, identity, claims },
      };
    },
    (value) => ({ ...value.evidence, input: [{ type: 'text', text: 'expected input tail', text_elements: [] }] }),
  ];

  for (const mutate of mutations) {
    const value = fixture();
    const sourceToken = Symbol('source-capability');
    const unknown = [];
    let applyCalls = 0;
    const correlator = createInstructionInputCorrelator({
      onApplied: () => { applyCalls += 1; return Promise.resolve(false); },
      onUnknown: (id, reason) => unknown.push({ id, reason }),
    });
    correlator.register(value.registration);
    correlator.attachSourceToken(value.deliveryAttemptId, sourceToken);
    correlator.markDispatching(value.deliveryAttemptId, sourceToken);

    assert.equal(correlator.observe({ deliveryAttemptId: value.deliveryAttemptId, sourceToken, evidence: mutate(value) }), false);
    assert.equal(correlator.observe({ deliveryAttemptId: value.deliveryAttemptId, sourceToken, evidence: value.evidence }), false);
    assert.equal(applyCalls, 0);
    assert.deepEqual(unknown, [{ id: value.deliveryAttemptId, reason: 'instruction_evidence_conflict' }]);
    correlator.close();
  }
});

test('pending attempts and buffered early evidence remain bounded at their configured limits', async () => {
  const value = fixture();
  const pendingCorrelator = createInstructionInputCorrelator({
    onApplied: () => Promise.resolve(false), onUnknown: () => {},
  });
  for (let index = 0; index < MAX_PENDING; index += 1) {
    pendingCorrelator.register({ ...value.registration, deliveryAttemptId: `capacity-${index}` });
  }
  assert.throws(() => pendingCorrelator.register({
    ...value.registration, deliveryAttemptId: 'capacity-overflow',
  }), { code: 'instruction_correlation_capacity' });
  assert.equal(pendingCorrelator.pendingCount, MAX_PENDING);
  pendingCorrelator.close();

  const text = 'x'.repeat(63_000);
  const largeBase = fixture({ text, deliveryAttemptId: 'buffer-0' });
  const sourceTokens = new Map();
  const applied = [];
  const unknown = [];
  let correlator;
  correlator = createInstructionInputCorrelator({
    onApplied: (id, evidence, token) => {
      assert.equal(correlator.beginApplyCommit(id, token, evidence), true);
      applied.push(id);
      return Promise.resolve(true);
    },
    onUnknown: (id, reason) => unknown.push({ id, reason }),
  });
  const attemptCount = 5;
  for (let index = 0; index < attemptCount; index += 1) {
    const id = `buffer-${index}`;
    const token = Symbol(id);
    sourceTokens.set(id, token);
    correlator.register({ ...largeBase.registration, deliveryAttemptId: id });
    correlator.attachSourceToken(id, token);
    correlator.markDispatching(id, token);
    const evidence = { ...largeBase.evidence, clientRequestId: id, nativeItemId: `item-${index}` };
    const observed = correlator.observe({ deliveryAttemptId: id, sourceToken: token, evidence });
    if (index < attemptCount - 1) assert.equal(observed, true);
    else assert.equal(observed, false);
    assert.ok(correlator.bufferedBytes <= MAX_BUFFER_BYTES);
    if (index === attemptCount - 2) {
      assert.ok(correlator.bufferedBytes > MAX_BUFFER_BYTES - 64 * 1024);
    }
  }
  assert.equal(correlator.bufferedBytes > 0, true);
  assert.deepEqual(unknown, [{ id: 'buffer-4', reason: 'instruction_evidence_capacity' }]);
  for (let index = 0; index < attemptCount - 1; index += 1) {
    const id = `buffer-${index}`;
    correlator.accepted(id, sourceTokens.get(id), {
      clientRequestId: id, nativeTurnId: 'turn-one', nativeItemId: null,
    });
  }
  await waitFor(() => correlator.pendingCount === 0);
  assert.equal(correlator.bufferedBytes, 0);
  assert.deepEqual(applied, ['buffer-0', 'buffer-1', 'buffer-2', 'buffer-3']);
  assert.equal(correlator.observe({
    deliveryAttemptId: 'buffer-4',
    sourceToken: sourceTokens.get('buffer-4'),
    evidence: { ...largeBase.evidence, clientRequestId: 'buffer-4', nativeItemId: 'item-4' },
  }), false);
  assert.equal(correlator.pendingCount, 0);
  correlator.close();
});

test('conflicting evidence while application waits before beginCommit closes unknown without applied', async () => {
  const value = fixture();
  const sourceToken = Symbol('source-capability');
  const applyGate = defer();
  let correlator;
  let applyCalls = 0;
  const unknown = [];
  correlator = createInstructionInputCorrelator({
    onApplied: async (id, evidence, token) => {
      applyCalls += 1;
      await applyGate.promise;
      return correlator.beginApplyCommit(id, token, evidence);
    },
    onUnknown: (id, reason) => { unknown.push({ id, reason }); },
  });
  correlator.register(value.registration);
  correlator.attachSourceToken(value.deliveryAttemptId, sourceToken);
  correlator.markDispatching(value.deliveryAttemptId, sourceToken);
  correlator.accepted(value.deliveryAttemptId, sourceToken, {
    clientRequestId: value.deliveryAttemptId, nativeTurnId: 'turn-one', nativeItemId: null,
  });
  correlator.observe({ deliveryAttemptId: value.deliveryAttemptId, sourceToken, evidence: value.evidence });
  assert.equal(applyCalls, 1);
  assert.equal(correlator.observe({
    deliveryAttemptId: value.deliveryAttemptId,
    sourceToken,
    evidence: { ...value.evidence, input: [{ type: 'text', text: 'conflicting input', text_elements: [] }] },
  }), false);
  applyGate.resolve();
  await waitFor(() => correlator.pendingCount === 0);
  assert.equal(unknown.length, 1);
  assert.equal(unknown[0].reason, 'instruction_evidence_conflict');
  assert.equal(correlator.diagnostics().length, 0);
  correlator.close();
});

test('conflicting evidence after beginCommit keeps applied and records a bounded body-free diagnostic', async () => {
  const value = fixture();
  const sourceToken = Symbol('source-capability');
  const commitGate = defer();
  let correlator;
  correlator = createInstructionInputCorrelator({
    onApplied: (id, evidence, token) => {
      assert.equal(correlator.beginApplyCommit(id, token, evidence), true);
      return commitGate.promise.then(() => true);
    },
    onUnknown: () => assert.fail('committing evidence must not be finalized as unknown'),
  });
  correlator.register(value.registration);
  correlator.attachSourceToken(value.deliveryAttemptId, sourceToken);
  correlator.markDispatching(value.deliveryAttemptId, sourceToken);
  correlator.accepted(value.deliveryAttemptId, sourceToken, {
    clientRequestId: value.deliveryAttemptId, nativeTurnId: 'turn-one', nativeItemId: null,
  });
  correlator.observe({ deliveryAttemptId: value.deliveryAttemptId, sourceToken, evidence: value.evidence });
  assert.equal(correlator.observe({
    deliveryAttemptId: value.deliveryAttemptId,
    sourceToken,
    evidence: { ...value.evidence, input: [{ type: 'text', text: 'post-commit conflict secret', text_elements: [] }] },
  }), false);
  commitGate.resolve();
  await waitFor(() => correlator.pendingCount === 0);
  assert.deepEqual(correlator.diagnostics().map(({ deliveryAttemptId, code }) => ({ deliveryAttemptId, code })), [{
    deliveryAttemptId: value.deliveryAttemptId,
    code: 'instruction_evidence_conflict',
  }]);
  assert.equal(JSON.stringify(correlator.diagnostics()).includes('post-commit conflict secret'), false);
  assert.equal(correlator.unknown(value.deliveryAttemptId), false);
  correlator.close();
});

test('TTL and close cannot terminally race an applied commit after its synchronous guard', async () => {
  const value = fixture();
  let currentTime = 10;
  const sourceToken = Symbol('source-capability');
  const commitGate = defer();
  let correlator;
  correlator = createInstructionInputCorrelator({
    now: () => currentTime,
    onApplied: (id, evidence, token) => {
      assert.equal(correlator.beginApplyCommit(id, token, evidence), true);
      return commitGate.promise.then(() => true);
    },
    onUnknown: () => assert.fail('committing evidence must not become unknown'),
  });
  correlator.register(value.registration);
  correlator.attachSourceToken(value.deliveryAttemptId, sourceToken);
  correlator.markDispatching(value.deliveryAttemptId, sourceToken);
  correlator.accepted(value.deliveryAttemptId, sourceToken, {
    clientRequestId: value.deliveryAttemptId, nativeTurnId: 'turn-one', nativeItemId: null,
  });
  correlator.observe({ deliveryAttemptId: value.deliveryAttemptId, sourceToken, evidence: value.evidence });
  currentTime += 120_000;
  correlator.expire();
  correlator.close();
  commitGate.resolve();
  await waitFor(() => correlator.pendingCount === 0);
});
