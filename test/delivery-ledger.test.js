'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const {
  DELIVERY_LEDGER_LIMITS,
  createEmptyLedger,
  validateLedger,
  createDelivery,
  registerPrTarget,
  transitionDelivery,
  getDelivery,
  snapshotLedger,
  recoverLedger,
} = require('../src/server/delivery-ledger');

function makeLaunch(options = {}) {
  const provider = options.provider || 'codex';
  const nativeIdKind = provider === 'claude' ? 'session' : 'thread';
  const launchId = options.launchId || ('launch-' + provider + '-1');
  const runId = options.runId || (launchId + '-run');
  const attemptId = options.attemptId || (launchId + '-attempt');
  const periodId = options.periodId || (launchId + '-period');
  const actor = structuredClone(options.actor || { kind: 'agent', id: launchId + '-actor' });
  const identity = {
    provider,
    nativeIdKind,
    hostId: options.hostId || (provider + '-host'),
    homeScopeId: options.homeScopeId || (provider + '-home'),
    nativeId: options.nativeId || (provider + '-native-' + launchId),
  };
  const origin = options.origin || 'standalone';
  const purpose = options.purpose || 'agent';
  const originBinding = origin === 'standalone'
    ? null
    : structuredClone(options.originBinding || {
      periodId: launchId + '-parent-period',
      actor: { kind: 'agent', id: launchId + '-parent' },
    });
  const executionBinding = { periodId, actor };
  const currentOwner = structuredClone(options.currentOwner || executionBinding);
  return {
    launchRef: options.launchRef || (launchId + '-ref'),
    launchId,
    runId,
    attemptId,
    provider,
    nativeIdKind,
    hostId: identity.hostId,
    homeScopeId: identity.homeScopeId,
    origin,
    purpose,
    originBinding,
    state: options.state || 'bound',
    registrationEvidence: { token: launchId + '-registration-secret' },
    identity,
    executionBinding,
    conversationId: options.conversationId || (launchId + '-conversation'),
    sessionId: options.sessionId || (launchId + '-session'),
    bindingEvidence: { secret: launchId + '-binding-secret' },
    currentOwner,
    ownerGeneration: options.ownerGeneration ?? 0,
    currentProof: { opaque: launchId + '-proof-secret' },
  };
}

function makePeriodRecord(periodId, identity, suffix = 'owner') {
  return {
    executionId: periodId,
    conversationId: suffix + '-conversation',
    sessionId: suffix + '-session',
    identity: structuredClone(identity),
  };
}

function makeInput(deliveryAttemptId, logicalMessageId, payload = ('payload:' + deliveryAttemptId), extra = {}) {
  return {
    deliveryAttemptId,
    logicalMessageId,
    revision: 1,
    payload,
    ...extra,
  };
}

function createQuestion(ledger, launch, input) {
  return createDelivery(ledger, 'question', input, launch);
}

function step(ledger, id, operation, correlation = undefined) {
  return transitionDelivery(ledger, id, operation, correlation);
}

function correlationFor(delivery, options = {}) {
  return {
    deliveryAttemptId: delivery.deliveryAttemptId,
    revision: delivery.revision,
    payloadDigest: delivery.payloadDigest,
    targetPeriodId: delivery.target.periodId,
    nativeTurnId: options.nativeTurnId ?? null,
    nativeItemId: options.nativeItemId ?? null,
    clientRequestId: options.clientRequestId ?? delivery.deliveryAttemptId,
  };
}

function assertCode(callback, code) {
  assert.throws(callback, (error) => error && error.code === code);
}

test('creates detached payload-free routes for questions, results, and PR targets', () => {
  const ledger = createEmptyLedger();
  const child = makeLaunch({
    state: 'ended',
    currentOwner: { periodId: 'owner-period', actor: { kind: 'tool-use', id: 'owner-tool' } },
    ownerGeneration: 4,
  });
  const questionInput = makeInput('question-attempt', 'question-1', 'secret question payload');
  const question = createQuestion(ledger, child, questionInput);

  assert.equal(question.delivery.sourceExecutionId, child.executionBinding.periodId);
  assert.deepEqual(question.delivery.target, {
    kind: 'execution',
    launchRef: child.launchRef,
    claims: {
      launchId: child.launchId,
      runId: child.runId,
      attemptId: child.attemptId,
      provider: child.provider,
      nativeIdKind: child.nativeIdKind,
      hostId: child.hostId,
      homeScopeId: child.homeScopeId,
      origin: child.origin,
      purpose: child.purpose,
      originBinding: null,
    },
    identity: child.identity,
    periodId: child.executionBinding.periodId,
    actor: child.executionBinding.actor,
    conversationId: child.conversationId,
    sessionId: child.sessionId,
  });
  assert.equal(question.delivery.ownerGeneration, null);
  assert.equal(question.delivery.state, 'available');
  assert.equal(question.ledger.revision, 1);
  assert.equal(ledger.revision, 0);

  const parentIdentity = {
    provider: 'claude',
    nativeIdKind: 'session',
    hostId: 'claude-host',
    homeScopeId: 'claude-home',
    nativeId: 'owner-session',
  };
  const resultSource = makeLaunch({
    launchId: 'child-result',
    state: 'ended',
    currentOwner: { periodId: 'parent-period', actor: { kind: 'agent', id: 'parent-agent' } },
    ownerGeneration: 7,
  });
  const result = createDelivery(
    ledger,
    'result',
    makeInput('result-attempt', 'result-1', 'private result payload'),
    resultSource,
    makePeriodRecord('parent-period', parentIdentity),
  );
  assert.equal(result.delivery.sourceExecutionId, resultSource.executionBinding.periodId);
  assert.equal(result.delivery.target.kind, 'owner');
  assert.equal(result.delivery.target.launchRef, null);
  assert.deepEqual(result.delivery.target.identity, parentIdentity);
  assert.equal(result.delivery.target.periodId, 'parent-period');
  assert.equal(result.delivery.target.actor.id, 'parent-agent');
  assert.equal(result.delivery.ownerGeneration, 7);

  const creator = makeLaunch({
    launchId: 'pr-creator',
    provider: 'claude',
    origin: 'delegated',
    purpose: 'agent',
  });
  const prTarget = makeLaunch({ launchId: 'pr-target', provider: 'codex' });
  const targetRegistration = registerPrTarget(ledger, 'pr-alias', prTarget);
  assert.equal(targetRegistration.created, true);
  const pr = createDelivery(
    targetRegistration.ledger,
    'pr-notification',
    makeInput('pr-attempt', 'pr-event-1', 'private PR payload', { targetId: 'pr-alias' }),
    creator,
  );
  assert.equal(pr.delivery.source.launchRef, creator.launchRef);
  assert.equal(pr.delivery.source.claims.provider, 'claude');
  assert.equal(pr.delivery.target.launchRef, prTarget.launchRef);
  assert.equal(pr.delivery.target.claims.provider, 'codex');
  assert.equal(pr.delivery.target.periodId, prTarget.executionBinding.periodId);

  for (const value of [question.ledger, result.ledger, pr.ledger]) {
    const serialized = JSON.stringify(value);
    assert.equal(serialized.includes('secret question payload'), false);
    assert.equal(serialized.includes('private result payload'), false);
    assert.equal(serialized.includes('private PR payload'), false);
    assert.equal(serialized.includes('registration-secret'), false);
    assert.equal(serialized.includes('binding-secret'), false);
    assert.equal(serialized.includes('proof-secret'), false);
    assert.equal(serialized.includes('currentProof'), false);
    for (const delivery of value.deliveries) {
      assert.equal(Object.hasOwn(delivery, 'payload'), false);
      assert.equal(Object.hasOwn(delivery.source, 'registrationEvidence'), false);
    }
  }

  questionInput.payload = 'mutated after create';
  child.identity.nativeId = 'mutated native id';
  assert.equal(question.delivery.payloadDigest, createHash('sha256')
    .update('secret question payload', 'utf8').digest('hex'));
  assert.notEqual(question.delivery.source.identity.nativeId, child.identity.nativeId);
  assert.equal(Object.isFrozen(question.ledger.deliveries[0].target.identity), true);
  assert.equal(Object.isFrozen(question.delivery.source.claims.originBinding), true);
});

test('same attempt replays idempotently and only a superseded unsent key permits a replacement', () => {
  const launch = makeLaunch();
  const original = makeInput('attempt-1', 'logical-1', 'same payload');
  const first = createQuestion(createEmptyLedger(), launch, original);
  const replay = createQuestion(first.ledger, launch, structuredClone(original));
  assert.equal(replay.created, false);
  assert.deepEqual(replay.delivery, first.delivery);
  assert.equal(replay.ledger.revision, first.ledger.revision);

  assertCode(() => createQuestion(first.ledger, launch,
    makeInput('attempt-1', 'logical-1', 'changed payload')), 'delivery_conflict');
  assertCode(() => createQuestion(first.ledger, launch,
    makeInput('attempt-2', 'logical-1', 'same payload')), 'logical_conflict');
  assertCode(() => createQuestion(first.ledger, launch,
    makeInput('attempt-2', 'logical-1', 'new payload')), 'logical_conflict');

  const superseded = step(first.ledger, 'attempt-1', 'supersede');
  const replacement = createQuestion(superseded.ledger, launch,
    makeInput('attempt-2', 'logical-1', 'same payload'));
  assert.equal(replacement.created, true);
  assert.equal(getDelivery(replacement.ledger, 'attempt-1').state, 'superseded_before_send');
  assert.equal(getDelivery(replacement.ledger, 'attempt-2').state, 'available');

  const cancelled = createQuestion(createEmptyLedger(), launch,
    makeInput('attempt-cancelled', 'logical-cancelled', 'cancel payload'));
  const cancelledLedger = step(cancelled.ledger, 'attempt-cancelled', 'cancel').ledger;
  assert.equal(getDelivery(cancelledLedger, 'attempt-cancelled').state, 'cancelled_before_send');
  assertCode(() => createQuestion(cancelledLedger, launch,
    makeInput('attempt-cancelled-retry', 'logical-cancelled', 'cancel payload')), 'logical_conflict');
});

test('result replay retains its recorded owner across a later handoff', () => {
  const identityA = {
    provider: 'codex', nativeIdKind: 'thread', hostId: 'host-a', homeScopeId: 'home-a', nativeId: 'thread-a',
  };
  const identityB = {
    provider: 'claude', nativeIdKind: 'session', hostId: 'host-b', homeScopeId: 'home-b', nativeId: 'session-b',
  };
  const launch = makeLaunch({
    launchId: 'result-owner-history',
    currentOwner: { periodId: 'owner-period-a', actor: { kind: 'agent', id: 'owner-a' } },
    ownerGeneration: 2,
  });
  const input = makeInput('result-stable-id', 'result-stable-logical', 'stable result');
  const first = createDelivery(createEmptyLedger(), 'result', input, launch,
    makePeriodRecord('owner-period-a', identityA, 'a'));
  const afterHandoff = {
    ...launch,
    currentOwner: { periodId: 'owner-period-b', actor: { kind: 'tool-use', id: 'owner-b' } },
    ownerGeneration: 3,
  };
  const replay = createDelivery(first.ledger, 'result', structuredClone(input), afterHandoff,
    makePeriodRecord('owner-period-b', identityB, 'b'));

  assert.equal(replay.created, false);
  assert.equal(replay.delivery.target.periodId, 'owner-period-a');
  assert.deepEqual(replay.delivery.target.identity, identityA);
  assert.equal(replay.delivery.ownerGeneration, 2);
});

test('send start may follow either unsent state and cancellation preserves the send boundary', () => {
  const launch = makeLaunch();
  const cancelled = createQuestion(createEmptyLedger(), launch,
    makeInput('cancel-first', 'cancel-first-logical'));
  const claimed = step(cancelled.ledger, 'cancel-first', 'claim');
  const cancelResult = step(claimed.ledger, 'cancel-first', 'cancel');
  assert.equal(cancelResult.delivery.state, 'cancelled_before_send');
  assertCode(() => step(cancelResult.ledger, 'cancel-first', 'sendStart'), 'invalid_transition');

  const claimedSend = createQuestion(createEmptyLedger(), launch,
    makeInput('claimed-send', 'claimed-send-logical'));
  const claimedForSend = step(claimedSend.ledger, 'claimed-send', 'claim');
  const claimedStart = step(claimedForSend.ledger, 'claimed-send', 'sendStart');
  assert.equal(claimedStart.delivery.state, 'sending');

  const direct = createQuestion(createEmptyLedger(), launch,
    makeInput('direct-send', 'direct-send-logical'));
  const directStart = step(direct.ledger, 'direct-send', 'sendStart');
  assert.equal(directStart.delivery.state, 'sending');

  const postSend = step(directStart.ledger, 'direct-send', 'cancel');
  assert.equal(postSend.delivery.state, 'sending');
  assert.equal(postSend.delivery.cancelRequested, true);
  const accepted = step(postSend.ledger, 'direct-send', 'accepted',
    correlationFor(postSend.delivery));
  assert.equal(accepted.delivery.state, 'accepted');
  assert.equal(accepted.delivery.appliedCorrelation, null);

  const appliedCorr = correlationFor(accepted.delivery, {
    nativeTurnId: 'native-turn-1',
    nativeItemId: 'native-item-1',
  });
  const applied = step(accepted.ledger, 'direct-send', 'applied', appliedCorr);
  assert.equal(applied.delivery.state, 'applied');
  assert.equal(applied.delivery.cancelRequested, true);
  assert.deepEqual(applied.delivery.appliedCorrelation, appliedCorr);

  const lateAccepted = step(applied.ledger, 'direct-send', 'accepted',
    correlationFor(applied.delivery, { nativeTurnId: 'native-turn-1' }));
  assert.equal(lateAccepted.delivery.state, 'applied');
  assert.equal(lateAccepted.delivery.appliedCorrelation.nativeItemId, 'native-item-1');
  assert.equal(lateAccepted.delivery.acceptedCorrelation.nativeTurnId, 'native-turn-1');
});

test('accepted and applied claims require a fixed request and exact delivery correlation', () => {
  const launch = makeLaunch();
  const created = createQuestion(createEmptyLedger(), launch,
    makeInput('correlation-id', 'correlation-logical'));
  const started = step(created.ledger, 'correlation-id', 'sendStart');
  const base = correlationFor(started.delivery);
  const beforeReject = snapshotLedger(started.ledger);

  assertCode(() => step(started.ledger, 'correlation-id', 'accepted',
    { ...base, clientRequestId: 'unfixed-request' }), 'correlation_mismatch');
  assert.deepEqual(snapshotLedger(started.ledger), beforeReject);
  assertCode(() => step(started.ledger, 'correlation-id', 'accepted',
    { ...base, nativeTurnId: null, nativeItemId: 'item-without-turn' }), 'correlation_mismatch');

  const turnOnly = correlationFor(started.delivery, { nativeTurnId: 'turn-known' });
  const accepted = step(started.ledger, 'correlation-id', 'accepted', turnOnly);
  assert.equal(accepted.delivery.state, 'accepted');
  assert.equal(accepted.delivery.acceptedCorrelation.nativeTurnId, 'turn-known');
  assert.equal(accepted.delivery.acceptedCorrelation.nativeItemId, null);

  assertCode(() => step(accepted.ledger, 'correlation-id', 'applied',
    correlationFor(accepted.delivery, {
      nativeTurnId: 'different-turn',
      nativeItemId: 'item-1',
    })), 'correlation_mismatch');
  assertCode(() => step(accepted.ledger, 'correlation-id', 'applied',
    correlationFor(accepted.delivery, {
      nativeTurnId: 'turn-known',
      nativeItemId: 'item-1',
      clientRequestId: 'other-request',
    })), 'correlation_mismatch');

  const applied = step(accepted.ledger, 'correlation-id', 'applied',
    correlationFor(accepted.delivery, {
      nativeTurnId: 'turn-known',
      nativeItemId: 'item-1',
    }));
  assert.equal(applied.delivery.state, 'applied');
  assertCode(() => step(applied.ledger, 'correlation-id', 'applied',
    correlationFor(applied.delivery, {
      nativeTurnId: 'turn-known',
      nativeItemId: 'item-2',
    })), 'correlation_mismatch');
  assert.equal(getDelivery(applied.ledger, 'correlation-id').appliedCorrelation.nativeItemId, 'item-1');
});

test('native item reuse is rejected within a full identity-period scope only', () => {
  const launch = makeLaunch({ launchId: 'same-target' });
  let ledger = createEmptyLedger();
  const first = createQuestion(ledger, launch, makeInput('item-first', 'item-logical-1'));
  const firstStart = step(first.ledger, 'item-first', 'sendStart');
  const firstApplied = step(firstStart.ledger, 'item-first', 'applied',
    correlationFor(firstStart.delivery, { nativeTurnId: 'turn-1', nativeItemId: 'item-1' }));
  ledger = createQuestion(firstApplied.ledger, launch, makeInput('item-second', 'item-logical-2')).ledger;
  const secondStart = step(ledger, 'item-second', 'sendStart');
  const beforeReject = snapshotLedger(secondStart.ledger);
  assertCode(() => step(secondStart.ledger, 'item-second', 'applied',
    correlationFor(secondStart.delivery, { nativeTurnId: 'turn-1', nativeItemId: 'item-1' })),
  'correlation_reused');
  assert.deepEqual(snapshotLedger(secondStart.ledger), beforeReject);

  const otherHome = makeLaunch({
    launchId: 'same-native-on-other-home',
    provider: 'claude',
    hostId: 'different-host',
    homeScopeId: 'different-home',
    nativeId: 'different-session',
  });
  const other = createQuestion(secondStart.ledger, otherHome,
    makeInput('other-scope', 'other-scope-logical'));
  const otherStart = step(other.ledger, 'other-scope', 'sendStart');
  const otherApplied = step(otherStart.ledger, 'other-scope', 'applied',
    correlationFor(otherStart.delivery, { nativeTurnId: 'turn-1', nativeItemId: 'item-1' }));
  assert.equal(otherApplied.delivery.state, 'applied');
});

test('recovery reopens claims, quarantines send ambiguity, and retains terminal states', () => {
  const launch = makeLaunch();
  let ledger = createEmptyLedger();
  const states = [
    ['claimed', 'claim'],
    ['sending', 'sendStart'],
    ['accepted', 'accepted'],
    ['applied', 'applied'],
    ['cancelled', 'cancel'],
    ['superseded', 'supersede'],
  ];
  for (const [id, operation] of states) {
    const created = createQuestion(ledger, launch, makeInput('recover-' + id, 'recover-logical-' + id));
    ledger = created.ledger;
    if (operation === 'accepted' || operation === 'applied') {
      const started = step(ledger, 'recover-' + id, 'sendStart');
      ledger = started.ledger;
      if (operation === 'accepted') {
        ledger = step(ledger, 'recover-' + id, 'accepted',
          correlationFor(started.delivery)).ledger;
      } else {
        ledger = step(ledger, 'recover-' + id, 'applied',
          correlationFor(started.delivery, { nativeTurnId: 'turn-a', nativeItemId: 'item-a' })).ledger;
      }
    } else {
      ledger = step(ledger, 'recover-' + id, operation).ledger;
    }
  }
  const recovered = recoverLedger(ledger);
  assert.equal(getDelivery(recovered, 'recover-claimed').state, 'available');
  assert.equal(getDelivery(recovered, 'recover-sending').state, 'unknown');
  assert.equal(getDelivery(recovered, 'recover-accepted').state, 'unknown');
  assert.ok(getDelivery(recovered, 'recover-accepted').acceptedCorrelation);
  assert.equal(getDelivery(recovered, 'recover-applied').state, 'applied');
  assert.equal(getDelivery(recovered, 'recover-cancelled').state, 'cancelled_before_send');
  assert.equal(getDelivery(recovered, 'recover-superseded').state, 'superseded_before_send');
  assert.equal(recoverLedger(recovered).revision, recovered.revision);
});

test('ledger validation rejects unknown shape and capacity while returning deep copies', () => {
  const empty = createEmptyLedger();
  const tamperedTop = { ...empty, extra: true };
  assertCode(() => validateLedger(tamperedTop), 'invalid_ledger');

  const launch = makeLaunch();
  const created = createQuestion(empty, launch, makeInput('schema-id', 'schema-logical'));
  const tamperedRecord = structuredClone(created.ledger);
  tamperedRecord.deliveries[0].privateProof = 'not allowed';
  assertCode(() => validateLedger(tamperedRecord), 'invalid_ledger');

  const detached = snapshotLedger(created.ledger);
  assert.notEqual(detached, created.ledger);
  assert.notEqual(detached.deliveries[0], created.ledger.deliveries[0]);
  assert.equal(Object.isFrozen(detached), true);
  assert.equal(Object.isFrozen(getDelivery(created.ledger, 'schema-id')), true);

  const overCapacity = {
    ...empty,
    deliveries: new Array(DELIVERY_LEDGER_LIMITS.maxDeliveries + 1),
  };
  assertCode(() => validateLedger(overCapacity), 'capacity');
});


test('PR aliases resolve to one canonical target and allow a different-provider creator', () => {
  const creator = makeLaunch({
    launchId: 'delegated-pr-creator',
    provider: 'claude',
    origin: 'delegated',
    purpose: 'agent',
  });
  const target = makeLaunch({ launchId: 'canonical-pr-target', provider: 'codex' });
  const firstAlias = registerPrTarget(createEmptyLedger(), 'pr-alias-a', target);
  const replayAlias = registerPrTarget(firstAlias.ledger, 'pr-alias-a', target);
  assert.equal(replayAlias.created, false);
  const secondAlias = registerPrTarget(replayAlias.ledger, 'pr-alias-b', target);

  const first = createDelivery(secondAlias.ledger, 'pr-notification',
    makeInput('pr-canonical-attempt', 'pr-canonical-event', 'same notice', { targetId: 'pr-alias-a' }),
    creator);
  const sameAttempt = createDelivery(first.ledger, 'pr-notification',
    makeInput('pr-canonical-attempt', 'pr-canonical-event', 'same notice', { targetId: 'pr-alias-b' }),
    creator);
  assert.equal(sameAttempt.created, false);
  assert.equal(sameAttempt.delivery.source.claims.provider, 'claude');
  assert.equal(sameAttempt.delivery.target.claims.provider, 'codex');

  assertCode(() => createDelivery(first.ledger, 'pr-notification',
    makeInput('pr-canonical-attempt-2', 'pr-canonical-event', 'same notice', { targetId: 'pr-alias-b' }),
    creator), 'logical_conflict');
  const superseded = step(first.ledger, 'pr-canonical-attempt', 'supersede');
  const replacement = createDelivery(superseded.ledger, 'pr-notification',
    makeInput('pr-canonical-attempt-2', 'pr-canonical-event', 'same notice', { targetId: 'pr-alias-b' }),
    creator);
  assert.equal(replacement.created, true);
  assert.equal(replacement.delivery.target.launchRef, target.launchRef);

  const changedTarget = makeLaunch({ launchId: 'different-pr-target', provider: 'codex' });
  assertCode(() => registerPrTarget(secondAlias.ledger, 'pr-alias-a', changedTarget),
    'pr_target_conflict');
});

test('sending and unknown attempts keep the logical key locked against retry', () => {
  const launch = makeLaunch();
  const created = createQuestion(createEmptyLedger(), launch,
    makeInput('locked-attempt', 'locked-logical', 'fixed content'));
  const sending = step(created.ledger, 'locked-attempt', 'sendStart');
  assertCode(() => createQuestion(sending.ledger, launch,
    makeInput('locked-retry', 'locked-logical', 'fixed content')), 'logical_conflict');
  const unknown = step(sending.ledger, 'locked-attempt', 'unknown');
  assert.equal(unknown.delivery.state, 'unknown');
  assertCode(() => createQuestion(unknown.ledger, launch,
    makeInput('locked-retry-after-unknown', 'locked-logical', 'fixed content')), 'logical_conflict');
  assert.equal(getDelivery(recoverLedger(unknown.ledger), 'locked-attempt').state, 'unknown');
});
