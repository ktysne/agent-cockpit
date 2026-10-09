'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  expandQuestionDeliveryCapsule,
  expandQuestionRejectionCapsule,
  normalizeQuestionDeliveryCapsule,
  normalizeQuestionRejectionCapsule,
} = require('../src/server/question-rejection-capsule-codec');
const { makeDeliveryCapsule } = require('./helpers/question-rejection-capsule-fixtures');
const { validateQuestionRejectionCapsulePair } = require('../src/server/question-rejection-capsule-pair');
const {
  createMaximalQuestionRejectionCapsulePairFixture,
  createQuestionRejectionCapsulePairFixture,
  makePairInput,
} = require('./helpers/question-rejection-capsule-pair-fixtures');

const TERMINAL_STATES = ['applied', 'cancelled_before_send', 'superseded_before_send'];
const CHECKPOINT_STATES = ['available', 'unknown', ...TERMINAL_STATES];
const INVALID_PAIR = 'invalid_question_rejection_capsule_pair';
const TERMINAL_RETENTION_MS = 604_800_000;

function trapCountingProxy(value, counter) {
  return new Proxy(value, {
    getPrototypeOf() { counter.count += 1; return Object.getPrototypeOf(value); },
    ownKeys() { counter.count += 1; return Reflect.ownKeys(value); },
    getOwnPropertyDescriptor(target, key) {
      counter.count += 1;
      return Object.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, receiver) { counter.count += 1; return Reflect.get(target, key, receiver); },
  });
}

function clone(value) {
  return structuredClone(value);
}

function setPath(record, path, value) {
  const parts = path.split('.');
  let current = record;
  for (const part of parts.slice(0, -1)) current = current[part];
  current[parts.at(-1)] = value;
}

function longIdentifier(prefix, index) {
  const uniquePrefix = `${prefix}-${String(index).padStart(3, '0')}-`;
  return uniquePrefix + 'x'.repeat(512 - uniquePrefix.length);
}

function makeRepeatedGroupParts(states) {
  const fixtures = states.map((state) => createQuestionRejectionCapsulePairFixture({
    provider: 'claude',
    presence: 'checkpoint',
    state,
  }));
  const reservations = fixtures.map((fixture, index) => {
    const reservation = clone(fixture.questionReservations[0]);
    reservation.internalQuestionId = `question-${index === 0 ? 'a' : 'b'}`;
    reservation.questionId = `question-id-${index === 0 ? 'a' : 'b'}`;
    reservation.deliveryIntent.deliveryAttemptId = `delivery-${index === 0 ? 'a' : 'b'}`;
    return reservation;
  });
  const deliveries = fixtures.map((fixture, index) => {
    const delivery = clone(fixture.checkpointDeliveries[0]);
    delivery.deliveryAttemptId = `delivery-${index === 0 ? 'a' : 'b'}`;
    for (const correlation of [delivery.acceptedCorrelation, delivery.appliedCorrelation]) {
      if (correlation !== null) {
        correlation.deliveryAttemptId = delivery.deliveryAttemptId;
        correlation.clientRequestId = delivery.deliveryAttemptId;
      }
    }
    return delivery;
  });
  return { reservations, deliveries, metadata: fixtures[0].metadata };
}

function makeRepeatedGroupInput(states) {
  const { reservations, deliveries, metadata } = makeRepeatedGroupParts(states);
  return makePairInput(reservations, deliveries, metadata);
}

test('valid Q and CP capsules pair for both providers and checkpoint states', () => {
  for (const provider of ['claude', 'codex']) {
    for (const state of CHECKPOINT_STATES) {
      const fixture = createQuestionRejectionCapsulePairFixture({ provider, presence: 'checkpoint', state });
      const result = validateQuestionRejectionCapsulePair(fixture.input);
      assert.equal(result.reservations.length, 1);
      assert.equal(result.deliveries.length, 1);
      assert.equal(result.deliveries[0].state, state);
      assert.deepEqual(JSON.parse(JSON.stringify(expandQuestionRejectionCapsule(result.questionCapsule))),
        JSON.parse(JSON.stringify(fixture.questionReservations)));
      assert.deepEqual(JSON.parse(JSON.stringify(expandQuestionDeliveryCapsule(result.checkpointCapsule))),
        JSON.parse(JSON.stringify(fixture.checkpointDeliveries)));
      assert.equal(result.selectedLogicalTombstones.length, 1);
      assert.equal(Object.isFrozen(result.scopeLimitations), true);
      assert.deepEqual(result.scopeLimitations, [
        'anchor_retirement_not_verified',
        'global_identifier_uniqueness_not_verified',
        'checkpoint_context_subset_not_verified',
        'whole_logical_closure_not_verified',
        'aggregate_capacity_not_verified',
        'persistence_recovery_not_verified',
        'delivery_history_not_verified',
        'native_correlation_uniqueness_not_verified',
      ]);
    }
  }
});

test('null CP pairs allow none and indeterminate reservations and an empty selected context', () => {
  for (const provider of ['claude', 'codex']) {
    for (const presence of ['none', 'indeterminate']) {
      const fixture = createQuestionRejectionCapsulePairFixture({ provider, presence });
      const result = validateQuestionRejectionCapsulePair(fixture.input);
      assert.equal(result.checkpointCapsule, null);
      assert.equal(result.deliveries.length, 0);
      assert.equal(result.selectedLogicalTombstones.length, 0);
    }
    const unselected = createQuestionRejectionCapsulePairFixture({
      provider,
      presence: 'none',
      selected: false,
    });
    assert.equal(validateQuestionRejectionCapsulePair(unselected.input).reservations.length, 1);
  }

  const withoutCheckpoint = createQuestionRejectionCapsulePairFixture({ presence: 'none' });
  const withCheckpoint = createQuestionRejectionCapsulePairFixture({ presence: 'checkpoint' });
  const nonemptyContext = clone(withoutCheckpoint.input);
  nonemptyContext.selectedLogicalTombstones = clone(withCheckpoint.input.selectedLogicalTombstones);
  assert.throws(() => validateQuestionRejectionCapsulePair(nonemptyContext));
});

test('Q capsule and CP grave records must match one-to-one by delivery attempt', () => {
  const fixture = createQuestionRejectionCapsulePairFixture({ provider: 'claude', presence: 'checkpoint' });
  const missing = makePairInput(fixture.questionReservations, [], fixture.metadata, []);
  assert.throws(() => validateQuestionRejectionCapsulePair(missing));

  const orphan = clone(fixture.checkpointDeliveries[0]);
  orphan.deliveryAttemptId = 'unmatched-delivery-attempt';
  const extra = makePairInput(fixture.questionReservations, [fixture.checkpointDeliveries[0], orphan], fixture.metadata);
  assert.throws(() => validateQuestionRejectionCapsulePair(extra));

  const wrongAttempt = clone(fixture.questionReservations[0]);
  wrongAttempt.deliveryIntent.deliveryAttemptId = 'unmatched-reservation-attempt';
  const mismatched = makePairInput([wrongAttempt], fixture.checkpointDeliveries, fixture.metadata);
  assert.throws(() => validateQuestionRejectionCapsulePair(mismatched));
});

test('capsule headers must share store, operation, identity, and period', () => {
  const fixture = createQuestionRejectionCapsulePairFixture({ provider: 'codex', presence: 'checkpoint' });
  for (const [field, value] of [
    ['storeId', '66666666-6666-4666-8666-666666666666'],
    ['compactionOperationId', '77777777-7777-4777-8777-777777777777'],
    ['periodId', 'another-period'],
  ]) {
    const input = clone(fixture.input);
    input.checkpointCapsule[field] = value;
    assert.throws(() => validateQuestionRejectionCapsulePair(input), {
      name: 'TypeError',
      message: INVALID_PAIR,
    });
  }

  const claude = createQuestionRejectionCapsulePairFixture({ provider: 'claude', presence: 'checkpoint' });
  const codex = createQuestionRejectionCapsulePairFixture({ provider: 'codex', presence: 'checkpoint' });
  assert.throws(() => validateQuestionRejectionCapsulePair({
    questionCapsule: claude.input.questionCapsule,
    checkpointCapsule: codex.input.checkpointCapsule,
    selectedLogicalTombstones: codex.input.selectedLogicalTombstones,
  }));
});

test('selected logical context is an exact unordered set of unique keys and matching grave values', () => {
  const fixture = createMaximalQuestionRejectionCapsulePairFixture();
  const valid = validateQuestionRejectionCapsulePair(fixture.input);
  assert.equal(valid.selectedLogicalTombstones.length, 256);

  const missing = clone(fixture.input);
  missing.selectedLogicalTombstones.pop();
  assert.throws(() => validateQuestionRejectionCapsulePair(missing));

  const extra = clone(fixture.input);
  extra.selectedLogicalTombstones.push({
    ...extra.selectedLogicalTombstones[0],
    logicalMessageId: 'unused-logical-group',
  });
  assert.throws(() => validateQuestionRejectionCapsulePair(extra));

  const duplicate = clone(fixture.input);
  duplicate.selectedLogicalTombstones[1] = clone(duplicate.selectedLogicalTombstones[0]);
  assert.throws(() => validateQuestionRejectionCapsulePair(duplicate));

  const outOfOrder = clone(fixture.input);
  outOfOrder.selectedLogicalTombstones.reverse();
  const reversed = validateQuestionRejectionCapsulePair(outOfOrder);
  assert.deepEqual(reversed.selectedLogicalTombstones.map((item) => item.logicalMessageId),
    outOfOrder.selectedLogicalTombstones.map((item) => item.logicalMessageId));

  const wrongDigest = clone(fixture.input);
  wrongDigest.selectedLogicalTombstones[0].payloadDigest = 'f'.repeat(64);
  assert.throws(() => validateQuestionRejectionCapsulePair(wrongDigest));

  const wrongSource = clone(fixture.input);
  wrongSource.selectedLogicalTombstones[0].sourceLaunchKey[0] = 'another-launch';
  assert.throws(() => validateQuestionRejectionCapsulePair(wrongSource));
});

test('one selected tombstone covers a superseded grave and one active grave in the same group', () => {
  const input = makeRepeatedGroupInput(['superseded_before_send', 'available']);
  const result = validateQuestionRejectionCapsulePair(input);
  assert.equal(result.reservations.length, 2);
  assert.equal(result.deliveries.length, 2);
  assert.equal(result.selectedLogicalTombstones.length, 1);
});

test('a logical group cannot contain two graves that are not superseded before send', () => {
  for (const states of [['available', 'available'], ['applied', 'applied']]) {
    assert.throws(() => validateQuestionRejectionCapsulePair(makeRepeatedGroupInput(states)), {
      name: 'TypeError',
      message: INVALID_PAIR,
    });
  }
});

test('graves sharing a five-field logical key must also share source launch key and digest', () => {
  const parts = makeRepeatedGroupParts(['superseded_before_send', 'available']);
  const secondReservation = parts.reservations[1];
  const secondDelivery = parts.deliveries[1];
  const otherLaunchKey = ['other-launch', 'other-run', 'other-attempt'];
  secondReservation.launchRef = 'launch-ref-second';
  for (const reference of [secondDelivery.sourceRef, secondDelivery.targetRef]) {
    reference.launchRef = 'launch-ref-second';
    reference.launchKey = clone(otherLaunchKey);
  }

  assert.throws(() => validateQuestionRejectionCapsulePair(
    makePairInput(parts.reservations, parts.deliveries, parts.metadata)), {
    name: 'TypeError',
    message: INVALID_PAIR,
  });
});

test('graves sharing a five-field logical key must also share payload digest', () => {
  const parts = makeRepeatedGroupParts(['superseded_before_send', 'available']);
  const otherDigest = 'f'.repeat(64);
  parts.reservations[1].deliveryIntent.payloadDigest = otherDigest;
  parts.deliveries[1].payloadDigest = otherDigest;

  assert.throws(() => validateQuestionRejectionCapsulePair(
    makePairInput(parts.reservations, parts.deliveries, parts.metadata)), {
    name: 'TypeError',
    message: INVALID_PAIR,
  });
});

test('input property order does not affect normalization and caller values stay mutable', () => {
  const fixture = createQuestionRejectionCapsulePairFixture({ provider: 'claude', presence: 'checkpoint' });
  const input = clone(fixture.input);
  input.selectedLogicalTombstones = input.selectedLogicalTombstones.map((tombstone) =>
    Object.fromEntries(Object.entries(tombstone).reverse()));
  const before = JSON.stringify(input);
  const result = validateQuestionRejectionCapsulePair(input);

  assert.equal(JSON.stringify(input), before);
  assert.equal(Object.isFrozen(input), false);
  assert.equal(Object.isFrozen(input.questionCapsule), false);
  assert.equal(result.reservations[0].internalQuestionId, fixture.questionReservations[0].internalQuestionId);
});

test('pair preflight rejects getters and nested proxies before running traps', () => {
  const fixture = createQuestionRejectionCapsulePairFixture({ provider: 'claude', presence: 'checkpoint' });
  let getterCalls = 0;
  const accessorInput = { ...fixture.input };
  Object.defineProperty(accessorInput, 'selectedLogicalTombstones', {
    enumerable: true,
    get() { getterCalls += 1; return fixture.input.selectedLogicalTombstones; },
  });
  assert.throws(() => validateQuestionRejectionCapsulePair(accessorInput));
  assert.equal(getterCalls, 0);

  const rootCounter = { count: 0 };
  assert.throws(() => validateQuestionRejectionCapsulePair(trapCountingProxy(clone(fixture.input), rootCounter)));
  assert.equal(rootCounter.count, 0);

  const nestedCounter = { count: 0 };
  const nestedProxyInput = clone(fixture.input);
  nestedProxyInput.checkpointCapsule.references.sources[0].launchKey = trapCountingProxy(
    nestedProxyInput.checkpointCapsule.references.sources[0].launchKey, nestedCounter);
  assert.throws(() => validateQuestionRejectionCapsulePair(nestedProxyInput));
  assert.equal(nestedCounter.count, 0);
});

test('pair boundary maps lower-level validation errors to its public error code', () => {
  const fixture = createQuestionRejectionCapsulePairFixture({ provider: 'claude', presence: 'checkpoint' });
  const input = clone(fixture.input);
  input.questionCapsule.identity.nativeId = {};
  assert.throws(() => validateQuestionRejectionCapsulePair(input), {
    name: 'TypeError',
    message: INVALID_PAIR,
  });
});

test('pair boundary preserves only the two intentional capsule size errors', () => {
  const fixture = createMaximalQuestionRejectionCapsulePairFixture();
  const oversizedQuestion = clone(fixture.input);
  const questionFields = [
    ['internalQuestionId', 'internal'],
    ['questionId', 'question'],
    ['executionId', 'execution'],
    ['conversationId', 'conversation'],
    ['launchRef', 'launch'],
    ['executionBinding.actor.id', 'actor'],
    ['deliveryIntent.deliveryAttemptId', 'attempt'],
    ['deliveryIntent.logicalMessageId', 'logical'],
    ['sessionId', 'session'],
  ];
  oversizedQuestion.questionCapsule.reservations.forEach((reservation, index) => {
    for (const [path, prefix] of questionFields) {
      setPath(reservation, path, longIdentifier(prefix, index));
    }
  });
  assert.throws(() => validateQuestionRejectionCapsulePair(oversizedQuestion), {
    name: 'RangeError',
    message: 'question_capsule_too_large',
  });

  const oversizedDelivery = clone(fixture.input);
  const deliveries = expandQuestionDeliveryCapsule(oversizedDelivery.checkpointCapsule);
  deliveries.forEach((delivery, index) => {
    const launchKey = ['launch', 'run', 'attempt'].map((prefix) => longIdentifier(prefix, index));
    const launchRef = longIdentifier('launch-ref', index);
    delivery.deliveryAttemptId = longIdentifier('delivery-attempt', index);
    delivery.logicalMessageId = longIdentifier('logical-message', index);
    delivery.sourceRef.launchRef = launchRef;
    delivery.targetRef.launchRef = launchRef;
    delivery.sourceRef.launchKey = launchKey;
    delivery.targetRef.launchKey = clone(launchKey);
    for (const correlation of [delivery.acceptedCorrelation, delivery.appliedCorrelation]) {
      if (correlation !== null) {
        correlation.deliveryAttemptId = delivery.deliveryAttemptId;
        correlation.clientRequestId = delivery.deliveryAttemptId;
      }
    }
  });
  oversizedDelivery.checkpointCapsule = makeDeliveryCapsule(deliveries, fixture.metadata);
  assert.throws(() => validateQuestionRejectionCapsulePair(oversizedDelivery), {
    name: 'RangeError',
    message: 'question_delivery_capsule_too_large',
  });
});

test('pair retention rejects a terminal grave before seven days after its terminal time', () => {
  const fixture = createQuestionRejectionCapsulePairFixture({
    provider: 'claude',
    presence: 'checkpoint',
    state: 'applied',
  });
  const reservation = clone(fixture.questionReservations[0]);
  const delivery = clone(fixture.checkpointDeliveries[0]);
  reservation.quarantinedAt = 100;
  reservation.reclamation.preparedAt = 100 + TERMINAL_RETENTION_MS;
  reservation.reclaimedAt = reservation.reclamation.preparedAt;
  delivery.terminalAt = 200;
  delivery.reclamation.reclaimedAt = 200 + TERMINAL_RETENTION_MS;
  const input = makePairInput([reservation], [delivery], fixture.metadata);

  assert.doesNotThrow(() => normalizeQuestionRejectionCapsule(input.questionCapsule));
  assert.doesNotThrow(() => normalizeQuestionDeliveryCapsule(input.checkpointCapsule));
  assert.throws(() => validateQuestionRejectionCapsulePair(input), {
    name: 'TypeError',
    message: INVALID_PAIR,
  });
});

test('null-checkpoint pairs require seven days after quarantine for none and indeterminate providers', () => {
  for (const provider of ['claude', 'codex']) {
    for (const presence of ['none', 'indeterminate']) {
      const fixture = createQuestionRejectionCapsulePairFixture({ provider, presence });
      const reservation = clone(fixture.questionReservations[0]);
      reservation.reclamation.preparedAt = reservation.quarantinedAt + TERMINAL_RETENTION_MS - 1;
      const input = makePairInput([reservation], [], fixture.metadata, []);

      assert.doesNotThrow(() => normalizeQuestionRejectionCapsule(input.questionCapsule));
      assert.throws(() => validateQuestionRejectionCapsulePair(input), {
        name: 'TypeError',
        message: INVALID_PAIR,
      });
    }
  }
});

test('maximum legal capsule and selected-context node structure fits the combined visit budget', () => {
  const fixture = createMaximalQuestionRejectionCapsulePairFixture();
  const valueCount = countPlainDataValues(fixture.input);
  assert.equal(valueCount, 31_517);
  assert.equal(fixture.input.questionCapsule.reservations.length, 256);
  assert.equal(fixture.input.checkpointCapsule.deliveries.length, 256);
  assert.equal(fixture.input.checkpointCapsule.references.sources.length, 256);
  assert.equal(fixture.input.checkpointCapsule.references.targets.length, 256);
  assert.equal(fixture.input.selectedLogicalTombstones.length, 256);
  assert.ok(fixture.questionReservations.every((reservation) => reservation.externalResolution !== null));
  assert.ok(fixture.checkpointDeliveries.every((delivery) =>
    delivery.acceptedCorrelation !== null && delivery.appliedCorrelation !== null));
  assert.ok(valueCount < 100_000);
  const result = validateQuestionRejectionCapsulePair(fixture.input);
  assert.equal(result.reservations.length, 256);
  assert.equal(result.deliveries.length, 256);
  assert.equal(result.selectedLogicalTombstones.length, 256);
});

function countPlainDataValues(value) {
  if (value === null || typeof value !== 'object') return 1;
  if (Array.isArray(value)) return 1 + value.reduce((sum, item) => sum + countPlainDataValues(item), 0);
  return 1 + Reflect.ownKeys(value).reduce((sum, key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return sum + countPlainDataValues(descriptor.value);
  }, 0);
}
