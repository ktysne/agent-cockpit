'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  expandQuestionDeliveryCapsule,
  expandQuestionRejectionCapsule,
} = require('../src/server/question-rejection-capsule-codec');
const { validateQuestionRejectionCapsulePair } = require('../src/server/question-rejection-capsule-pair');
const {
  createMaximalQuestionRejectionCapsulePairFixture,
  createQuestionRejectionCapsulePairFixture,
  makePairInput,
} = require('./helpers/question-rejection-capsule-pair-fixtures');

const TERMINAL_STATES = ['applied', 'cancelled_before_send', 'superseded_before_send'];
const CHECKPOINT_STATES = ['available', 'unknown', ...TERMINAL_STATES];

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
    assert.throws(() => validateQuestionRejectionCapsulePair(input), field);
  }

  const claude = createQuestionRejectionCapsulePairFixture({ provider: 'claude', presence: 'checkpoint' });
  const codex = createQuestionRejectionCapsulePairFixture({ provider: 'codex', presence: 'checkpoint' });
  assert.throws(() => validateQuestionRejectionCapsulePair({
    questionCapsule: claude.input.questionCapsule,
    checkpointCapsule: codex.input.checkpointCapsule,
    selectedLogicalTombstones: codex.input.selectedLogicalTombstones,
  }));
});

test('selected logical context must be exact, unique, ordered, and match grave source and digest', () => {
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
  extra.selectedLogicalTombstones.sort((left, right) => left.logicalMessageId < right.logicalMessageId ? -1 : 1);
  assert.throws(() => validateQuestionRejectionCapsulePair(extra));

  const duplicate = clone(fixture.input);
  duplicate.selectedLogicalTombstones.splice(1, 0, clone(duplicate.selectedLogicalTombstones[0]));
  assert.throws(() => validateQuestionRejectionCapsulePair(duplicate));

  const outOfOrder = clone(fixture.input);
  outOfOrder.selectedLogicalTombstones.reverse();
  assert.throws(() => validateQuestionRejectionCapsulePair(outOfOrder));

  const wrongDigest = clone(fixture.input);
  wrongDigest.selectedLogicalTombstones[0].payloadDigest = 'f'.repeat(64);
  assert.throws(() => validateQuestionRejectionCapsulePair(wrongDigest));

  const wrongSource = clone(fixture.input);
  wrongSource.selectedLogicalTombstones[0].sourceLaunchKey[0] = 'another-launch';
  assert.throws(() => validateQuestionRejectionCapsulePair(wrongSource));
});

test('one selected tombstone covers repeated graves with the same logical group and digest', () => {
  const fixture = createQuestionRejectionCapsulePairFixture({ provider: 'claude', presence: 'checkpoint' });
  const reservation = clone(fixture.questionReservations[0]);
  const delivery = clone(fixture.checkpointDeliveries[0]);
  reservation.internalQuestionId = 'question-second';
  reservation.questionId = 'question-id-second';
  reservation.deliveryIntent.deliveryAttemptId = 'delivery-second';
  delivery.deliveryAttemptId = 'delivery-second';
  const input = makePairInput(
    [fixture.questionReservations[0], reservation],
    [fixture.checkpointDeliveries[0], delivery],
    fixture.metadata,
  );

  const result = validateQuestionRejectionCapsulePair(input);
  assert.equal(result.reservations.length, 2);
  assert.equal(result.deliveries.length, 2);
  assert.equal(result.selectedLogicalTombstones.length, 1);
});

test('graves sharing a five-field logical key must also share source launch key and digest', () => {
  const fixture = createQuestionRejectionCapsulePairFixture({ provider: 'claude', presence: 'checkpoint' });
  const reservation = clone(fixture.questionReservations[0]);
  const delivery = clone(fixture.checkpointDeliveries[0]);
  reservation.internalQuestionId = 'question-second';
  reservation.questionId = 'question-id-second';
  reservation.launchRef = 'launch-ref-second';
  reservation.deliveryIntent.deliveryAttemptId = 'delivery-second';
  delivery.deliveryAttemptId = 'delivery-second';
  delivery.sourceRef.launchRef = 'launch-ref-second';
  delivery.targetRef.launchRef = 'launch-ref-second';
  delivery.sourceRef.launchKey = ['other-launch', 'other-run', 'other-attempt'];
  delivery.targetRef.launchKey = ['other-launch', 'other-run', 'other-attempt'];
  const reservations = [fixture.questionReservations[0], reservation]
    .sort((left, right) => left.internalQuestionId < right.internalQuestionId ? -1 : 1);
  const deliveries = [fixture.checkpointDeliveries[0], delivery]
    .sort((left, right) => left.deliveryAttemptId < right.deliveryAttemptId ? -1 : 1);

  assert.throws(() => validateQuestionRejectionCapsulePair(
    makePairInput(reservations, deliveries, fixture.metadata)));
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
