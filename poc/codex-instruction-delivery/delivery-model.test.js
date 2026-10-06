'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { InstructionDeliveryModel, digestPayload } = require('./delivery-model');

const identity = {
  provider: 'codex',
  hostId: 'host-a',
  homeScope: 'home-a',
  threadId: 'thread-a',
  runId: 'run-a',
  attemptId: 'attempt-a',
};
const payload = { text: 'Use the selected format.' };
const payloadDigest = digestPayload(payload);

function model() {
  let now = 10;
  return {
    broker: new InstructionDeliveryModel({ now: () => now }),
    advance(ms = 1) { now += ms; },
  };
}

function registration(overrides = {}) {
  return {
    ...identity,
    requestId: 'request-a',
    kind: 'ordinary_instruction',
    payload,
    runKind: 'standalone',
    threadState: 'active',
    expectedTurnId: 'turn-a',
    waitingOnApproval: false,
    waitingOnUserInput: false,
    ...overrides,
  };
}

function observed(overrides = {}) {
  return {
    state: 'active',
    activeTurnId: 'turn-a',
    waitingOnApproval: false,
    waitingOnUserInput: false,
    ...overrides,
  };
}

function begin(broker, overrides = {}) {
  return broker.beginDelivery({
    ...identity,
    requestId: 'request-a',
    deliveryId: 'delivery-a',
    observedThread: observed(),
    ...overrides,
  });
}

function evidence(overrides = {}) {
  return {
    ...identity,
    requestId: 'request-a',
    deliveryId: 'delivery-a',
    turnId: 'turn-a',
    itemId: 'item-a',
    itemType: 'user_input',
    payloadDigest,
    ...overrides,
  };
}

test('registration is idempotent for the same request and rejects conflicts or unsafe destinations', () => {
  const { broker } = model();
  assert.equal(broker.register(registration()).reason, 'registered');
  assert.equal(broker.register(registration({ threadState: 'unknown', waitingOnUserInput: true })).reason, 'duplicate_registration');
  assert.equal(broker.register(registration({ payload: { text: 'different' } })).reason, 'request_conflict');
  assert.equal(broker.register(registration({ provider: 'claude' })).reason, 'invalid_identity');
  assert.equal(broker.register(registration({ kind: 'permission_approval' })).reason, 'unsupported_kind');
  assert.equal(broker.register(registration({ runKind: 'review' })).reason, 'review_excluded');
  assert.equal(broker.register(registration({ runKind: 'delegated', threadState: 'ended' })).reason, 'delegated_ended');
});

test('thread waits and state changes hold delivery instead of changing its route', () => {
  const { broker } = model();
  broker.register(registration());
  assert.equal(begin(broker, { observedThread: observed({ waitingOnApproval: true }) }).reason, 'waiting_on_approval');
  assert.equal(begin(broker, { observedThread: observed({ waitingOnUserInput: true }) }).reason, 'waiting_on_user_input');
  assert.equal(begin(broker, { observedThread: observed({ state: 'unknown', activeTurnId: null }) }).reason, 'thread_state_unknown');
  assert.equal(begin(broker, { observedThread: observed({ activeTurnId: 'turn-b' }) }).reason, 'expected_turn_mismatch');
  assert.equal(broker.project().rows[0].state, 'stale');
  assert.equal(begin(broker, { observedThread: observed({ state: 'idle', activeTurnId: null }) }).reason, 'delivery_not_registered');

  const { broker: idleBroker } = model();
  idleBroker.register(registration({ requestId: 'idle-request', threadState: 'idle', expectedTurnId: null }));
  const idleResult = idleBroker.beginDelivery({
    ...identity,
    requestId: 'idle-request',
    deliveryId: 'idle-delivery',
    observedThread: observed({ state: 'idle', activeTurnId: null }),
  });
  assert.equal(idleResult.delivery.route, 'turn_start');
});

test('delegated active delivery stays on its registered turn and never starts a new turn', () => {
  const { broker } = model();
  broker.register(registration({ runKind: 'delegated' }));
  const result = begin(broker);
  assert.equal(result.delivery.route, 'existing_turn');
  assert.equal(result.delivery.targetTurnId, 'turn-a');
  assert.equal(broker.claimNextUserInputFallback({
    ...identity,
    requestId: 'request-a',
    claimId: 'claim-a',
    inputItemId: 'input-item',
    inputItemType: 'user_input',
    inputTurnId: 'turn-a',
    observedThread: observed(),
  }).reason, 'fallback_not_supported');
});

test('native receipt is accepted but only exact item, turn, identity, and payload evidence applies it', () => {
  const { broker } = model();
  broker.register(registration());
  const started = begin(broker);
  assert.equal(started.delivery.route, 'steer_expected_turn');
  started.delivery.payload.text = 'caller mutation';
  assert.equal(broker.recordAccepted({ ...identity, requestId: 'request-a', deliveryId: 'delivery-a', turnId: 'turn-a' }).reason, 'accepted');
  const accepted = broker.project().rows[0];
  assert.equal(accepted.state, 'accepted');
  assert.equal('payload' in accepted, false);
  assert.equal('payloadDigest' in accepted, false);
  assert.equal(broker.observeApplied(evidence({ payloadDigest: '0'.repeat(64) })).reason, 'evidence_mismatch');
  assert.equal(broker.observeApplied(evidence({ itemType: 'tool_call' })).reason, 'invalid_native_evidence');
  assert.equal(broker.observeApplied(evidence({ turnId: 'turn-b' })).reason, 'evidence_mismatch');
  assert.equal(broker.observeApplied(evidence()).reason, 'applied');
  assert.equal(broker.observeApplied(evidence()).reason, 'duplicate_applied_evidence');
});

test('a native input item has one delivery owner per host, HOME, thread, and turn', () => {
  const { broker } = model();
  const otherRunIdentity = { ...identity, runId: 'run-b', attemptId: 'attempt-b' };
  const sameThreadInput = (inputIdentity, requestId, deliveryId) => ({
    ...inputIdentity,
    requestId,
    deliveryId,
    observedThread: observed(),
  });
  const accept = (inputIdentity, requestId, deliveryId) => broker.recordAccepted({
    ...inputIdentity,
    requestId,
    deliveryId,
    turnId: 'turn-a',
  });

  broker.register(registration());
  broker.register(registration({ ...otherRunIdentity, requestId: 'request-b' }));
  assert.equal(broker.beginDelivery(sameThreadInput(identity, 'request-a', 'delivery-a')).reason, 'sending');
  assert.equal(broker.beginDelivery(sameThreadInput(otherRunIdentity, 'request-b', 'delivery-b')).reason, 'sending');
  assert.equal(accept(identity, 'request-a', 'delivery-a').reason, 'accepted');
  assert.equal(accept(otherRunIdentity, 'request-b', 'delivery-b').reason, 'accepted');

  assert.equal(broker.observeApplied(evidence({ itemId: 'shared-item' })).reason, 'applied');
  assert.equal(broker.observeApplied(evidence({ itemId: 'shared-item' })).reason, 'duplicate_applied_evidence');
  assert.equal(broker.observeApplied({
    ...otherRunIdentity,
    requestId: 'request-b',
    deliveryId: 'delivery-b',
    turnId: 'turn-a',
    itemId: 'shared-item',
    itemType: 'user_input',
    payloadDigest,
  }).reason, 'native_item_already_owned');
  assert.equal(broker.project().rows.find((row) => row.requestId === 'request-b').state, 'accepted');
  assert.equal(broker.observeApplied({
    ...otherRunIdentity,
    requestId: 'request-b',
    deliveryId: 'delivery-b',
    turnId: 'turn-a',
    itemId: 'other-item',
    itemType: 'user_input',
    payloadDigest,
  }).reason, 'applied');

  const otherHomeIdentity = { ...identity, homeScope: 'home-b', runId: 'run-c', attemptId: 'attempt-c' };
  broker.register(registration({ ...otherHomeIdentity, requestId: 'request-c' }));
  broker.beginDelivery(sameThreadInput(otherHomeIdentity, 'request-c', 'delivery-c'));
  broker.recordAccepted({ ...otherHomeIdentity, requestId: 'request-c', deliveryId: 'delivery-c', turnId: 'turn-a' });
  assert.equal(broker.observeApplied({
    ...otherHomeIdentity,
    requestId: 'request-c',
    deliveryId: 'delivery-c',
    turnId: 'turn-a',
    itemId: 'shared-item',
    itemType: 'user_input',
    payloadDigest,
  }).reason, 'applied');

  const otherThreadIdentity = { ...identity, threadId: 'thread-b', runId: 'run-d', attemptId: 'attempt-d' };
  broker.register(registration({ ...otherThreadIdentity, requestId: 'request-d' }));
  broker.beginDelivery(sameThreadInput(otherThreadIdentity, 'request-d', 'delivery-d'));
  broker.recordAccepted({ ...otherThreadIdentity, requestId: 'request-d', deliveryId: 'delivery-d', turnId: 'turn-a' });
  assert.equal(broker.observeApplied({
    ...otherThreadIdentity,
    requestId: 'request-d',
    deliveryId: 'delivery-d',
    turnId: 'turn-a',
    itemId: 'shared-item',
    itemType: 'user_input',
    payloadDigest,
  }).reason, 'applied');
});

test('ambiguous known-turn delivery can reconcile with exact evidence while an unknown start remains unknown', () => {
  const { broker } = model();
  broker.register(registration());
  begin(broker);
  assert.equal(broker.markUnknown({ ...identity, requestId: 'request-a', deliveryId: 'delivery-a', reason: 'disconnect' }).reason, 'unknown');
  assert.equal(broker.reconcileUnknown(evidence()).reason, 'applied');

  const { broker: startBroker } = model();
  startBroker.register(registration({ requestId: 'start-request', threadState: 'idle', expectedTurnId: null }));
  startBroker.beginDelivery({
    ...identity,
    requestId: 'start-request',
    deliveryId: 'start-delivery',
    observedThread: observed({ state: 'idle', activeTurnId: null }),
  });
  assert.equal(startBroker.markUnknown({ ...identity, requestId: 'start-request', deliveryId: 'start-delivery', reason: 'timeout' }).reason, 'unknown');
  const result = startBroker.reconcileUnknown(evidence({ requestId: 'start-request', deliveryId: 'start-delivery', turnId: 'guessed-turn' }));
  assert.equal(result.reason, 'evidence_mismatch');
  assert.equal(startBroker.project().rows[0].state, 'unknown');
  assert.equal(startBroker.claimNextUserInputFallback({
    ...identity,
    requestId: 'start-request',
    claimId: 'claim-a',
    inputItemId: 'input-item',
    inputItemType: 'user_input',
    inputTurnId: 'new-turn',
    observedThread: observed({ activeTurnId: 'new-turn' }),
  }).reason, 'unknown_no_fallback');

  const { broker: unknownAtRegistration } = model();
  unknownAtRegistration.register(registration({
    requestId: 'unknown-registration',
    threadState: 'unknown',
  }));
  assert.equal(unknownAtRegistration.claimNextUserInputFallback({
    ...identity,
    requestId: 'unknown-registration',
    claimId: 'claim-unknown',
    inputItemId: 'verified-input',
    inputItemType: 'user_input',
    inputTurnId: 'turn-b',
    observedThread: observed({ activeTurnId: 'turn-b' }),
  }).reason, 'thread_state_unknown');
});

test('fallback claim supersedes the primary path and applies only to the claimed next user input', () => {
  const { broker } = model();
  broker.register(registration());
  assert.equal(begin(broker, { observedThread: observed({ activeTurnId: 'turn-b' }) }).reason, 'expected_turn_mismatch');
  const claim = {
    ...identity,
    requestId: 'request-a',
    claimId: 'claim-a',
    inputItemId: 'input-item',
    inputItemType: 'user_input',
    inputTurnId: 'turn-b',
    observedThread: observed({ activeTurnId: 'turn-b' }),
  };
  assert.equal(broker.claimNextUserInputFallback(claim).reason, 'fallback_claimed');
  assert.equal(broker.project().rows[0].primarySupersededByFallback, true);
  assert.equal(broker.beginDelivery({
    ...identity,
    requestId: 'request-a',
    deliveryId: 'primary-delivery',
    observedThread: observed(),
  }).reason, 'fallback_claimed');
  assert.equal(broker.recordAccepted({ ...identity, requestId: 'request-a', deliveryId: 'delivery-a', turnId: 'turn-a' }).reason, 'fallback_claimed');
  assert.equal(broker.markUnknown({ ...identity, requestId: 'request-a', deliveryId: 'delivery-a', reason: 'disconnect' }).reason, 'fallback_claimed');
  assert.equal(broker.observeApplied(evidence()).reason, 'fallback_claimed');

  const fallback = broker.beginDelivery({
    ...identity,
    requestId: 'request-a',
    deliveryId: 'fallback-delivery',
    channel: 'next_user_input',
    claimId: 'claim-a',
    observedThread: observed({ activeTurnId: 'turn-b' }),
  });
  assert.equal(fallback.delivery.route, 'existing_turn');
  assert.equal(broker.recordAccepted({
    ...identity,
    requestId: 'request-a',
    deliveryId: 'fallback-delivery',
    channel: 'next_user_input',
    claimId: 'claim-a',
    turnId: 'turn-b',
  }).reason, 'accepted');
  assert.equal(broker.observeApplied(evidence({
    deliveryId: 'fallback-delivery',
    turnId: 'turn-b',
    channel: 'next_user_input',
    claimId: 'claim-a',
    inputItemId: 'wrong-item',
  })).reason, 'evidence_mismatch');
  assert.equal(broker.observeApplied(evidence({
    deliveryId: 'fallback-delivery',
    turnId: 'turn-b',
    channel: 'next_user_input',
    claimId: 'claim-a',
    inputItemId: 'input-item',
  })).reason, 'applied');
});

test('cancelling a claimed fallback does not revive the superseded primary delivery', () => {
  const { broker } = model();
  broker.register(registration());
  begin(broker, { observedThread: observed({ activeTurnId: 'turn-b' }) });
  broker.claimNextUserInputFallback({
    ...identity,
    requestId: 'request-a',
    claimId: 'claim-a',
    inputItemId: 'input-item',
    inputItemType: 'user_input',
    inputTurnId: 'turn-b',
    observedThread: observed({ activeTurnId: 'turn-b' }),
  });
  assert.equal(broker.cancel({ ...identity, requestId: 'request-a', operationId: 'cancel-a' }).reason, 'cancelled_before_send');
  assert.equal(broker.beginDelivery({
    ...identity,
    requestId: 'request-a',
    deliveryId: 'primary-delivery',
    observedThread: observed(),
  }).reason, 'fallback_claimed');
  assert.equal(broker.project().rows[0].state, 'cancelled');
});

test('cancellation before send is final, while post-send cancellation records uncertainty only', () => {
  const { broker } = model();
  broker.register(registration({ requestId: 'cancel-before' }));
  assert.equal(broker.cancel({ ...identity, requestId: 'cancel-before', operationId: 'cancel-before-op' }).reason, 'cancelled_before_send');
  assert.equal(broker.beginDelivery({
    ...identity,
    requestId: 'cancel-before',
    deliveryId: 'cancel-before-delivery',
    observedThread: observed(),
  }).reason, 'delivery_not_registered');

  broker.register(registration());
  begin(broker);
  assert.equal(broker.cancel({ ...identity, requestId: 'request-a', operationId: 'cancel-after' }).reason, 'delivery_may_have_been_sent');
  assert.equal(broker.project().rows.find((row) => row.requestId === 'request-a').cancelRequested, true);
  assert.equal(broker.markUnknown({ ...identity, requestId: 'request-a', deliveryId: 'delivery-a', reason: 'disconnect' }).reason, 'unknown');
  assert.equal(broker.reconcileUnknown(evidence()).reason, 'applied');
  assert.equal(broker.cancel({ ...identity, requestId: 'request-a', operationId: 'cancel-applied' }).reason, 'already_applied');
});

test('payload digest is stable for record key order and bounded to plain JSON values', () => {
  assert.equal(digestPayload({ a: 1, b: { c: true } }), digestPayload({ b: { c: true }, a: 1 }));
  assert.equal(digestPayload(['not', 'a', 'plain record']), null);
  const cyclic = {};
  cyclic.self = cyclic;
  assert.equal(digestPayload(cyclic), null);
  assert.equal(digestPayload({ constructor: 'unsafe' }), null);

  let payloadGetterCalled = false;
  const accessorPayload = {};
  Object.defineProperty(accessorPayload, 'text', {
    enumerable: true,
    get() {
      payloadGetterCalled = true;
      return 'should not be read';
    },
  });
  assert.equal(digestPayload(accessorPayload), null);
  assert.equal(payloadGetterCalled, false);

  const { broker } = model();
  let kindGetterCalled = false;
  const accessorInput = registration({ requestId: 'accessor-request' });
  Object.defineProperty(accessorInput, 'kind', {
    enumerable: true,
    get() {
      kindGetterCalled = true;
      return 'ordinary_instruction';
    },
  });
  assert.equal(broker.register(accessorInput).reason, 'invalid_input');
  assert.equal(kindGetterCalled, false);
  const symbolInput = registration({ requestId: 'symbol-request' });
  symbolInput[Symbol('extra')] = true;
  assert.equal(broker.register(symbolInput).reason, 'invalid_input');
});

test('request history refuses overflow without evicting existing registrations', () => {
  const { broker } = model();
  for (let index = 0; index < 128; index += 1) {
    assert.equal(broker.register(registration({ requestId: `request-${index}` })).reason, 'registered');
  }
  assert.equal(broker.register(registration({ requestId: 'request-overflow' })).reason, 'capacity');
  assert.equal(broker.project().counts.total, 128);
  assert.equal(broker.register(registration({ requestId: 'request-0' })).reason, 'duplicate_registration');
});

test('invalid clock values do not partially register or begin a delivery', () => {
  const invalidBroker = new InstructionDeliveryModel({ now: () => Number.NaN });
  assert.equal(invalidBroker.register(registration()).reason, 'invalid_clock');
  assert.equal(invalidBroker.project().counts.total, 0);

  let now = 100;
  const broker = new InstructionDeliveryModel({ now: () => now });
  broker.register(registration());
  now = -1;
  assert.equal(begin(broker).reason, 'invalid_clock');
  const row = broker.project().rows[0];
  assert.equal(row.state, 'registered');
  assert.equal(row.deliveryId, null);
});
