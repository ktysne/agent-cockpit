'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeQuestionReservation } = require('../src/server/common-question-reclamation-codec');
const {
  normalizeDeliveryRecordV2Local,
  normalizeLogicalTombstoneV2Local,
} = require('../src/server/delivery-reclamation-codec');
const { assertPlainDataTree } = require('../src/server/reclamation-plain-data');
const {
  normalizeReclaimedQuestionPair,
  validateReclamationSnapshot,
} = require('../src/server/reclamation-store-consistency');
const { createReclaimedQuestionPairFixture } = require('./helpers/reclaimed-question-pair-fixtures');

const TERMINAL_RETENTION_MS = 604_800_000;
const TERMINAL_STATES = ['applied', 'cancelled_before_send', 'superseded_before_send'];
const CHECKPOINT_STATES = ['available', 'unknown', ...TERMINAL_STATES];
const UUID_OTHER = '44444444-4444-4444-8444-444444444444';

function validPairFixture(provider, presence, state) {
  return createReclaimedQuestionPairFixture({ provider, presence, state });
}

function replacePairInSnapshot(fixture, reservation, delivery) {
  const snapshot = structuredClone(fixture.snapshot);
  const reservationIndex = snapshot.stores.questions.reservations.findIndex((item) =>
    item.internalQuestionId === fixture.reservation.internalQuestionId);
  snapshot.stores.questions.reservations[reservationIndex] = reservation;
  if (delivery !== null) {
    const originalId = fixture.delivery.deliveryAttemptId;
    const deliveryIndex = snapshot.stores.checkpoint.ledger.deliveries.findIndex((item) =>
      item.deliveryAttemptId === originalId);
    snapshot.stores.checkpoint.ledger.deliveries[deliveryIndex] = delivery;
  }
  return snapshot;
}

function proxyWithTrapCounter(value, counter) {
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

test('reclaimed checkpoint pairs normalize for each provider and delivery lifecycle state', () => {
  for (const provider of ['claude', 'codex']) {
    for (const state of CHECKPOINT_STATES) {
      const fixture = validPairFixture(provider, 'checkpoint', state);
      const result = normalizeReclaimedQuestionPair({
        reservation: fixture.reservation,
        delivery: fixture.delivery,
      });

      assert.equal(result.reservation.bodyState, 'reclaimed');
      assert.equal(result.delivery.recordType, 'reclaimed');
      assert.equal(result.delivery.state, state);
      assert.equal(validateReclamationSnapshot(fixture.snapshot).status, 'ready');
    }
  }
});

test('null delivery pairs preserve none and indeterminate creation states for each provider', () => {
  for (const provider of ['claude', 'codex']) {
    for (const presence of ['none', 'indeterminate']) {
      const fixture = validPairFixture(provider, presence, null);
      const result = normalizeReclaimedQuestionPair({
        reservation: fixture.reservation,
        delivery: null,
      });

      assert.equal(result.delivery, null);
      assert.equal(result.reservation.reclamation.deliveryPresence, presence);
      assert.equal(validateReclamationSnapshot(fixture.snapshot).status, 'ready');
    }
    const unselected = createReclaimedQuestionPairFixture({
      provider,
      presence: 'none',
      selected: false,
    });
    assert.equal(unselected.reservation.deliveryIntent, null);
    assert.equal(normalizeReclaimedQuestionPair({
      reservation: unselected.reservation,
      delivery: null,
    }).delivery, null);
  }
});

test('a checkpointed reservation rejects a missing grave and a null-presence reservation rejects a grave', () => {
  const checkpointed = validPairFixture('claude', 'checkpoint', 'available');
  assert.throws(() => normalizeReclaimedQuestionPair({
    reservation: checkpointed.reservation,
    delivery: null,
  }));

  const noCheckpoint = validPairFixture('claude', 'none', null);
  assert.throws(() => normalizeReclaimedQuestionPair({
    reservation: noCheckpoint.reservation,
    delivery: checkpointed.delivery,
  }));
});

test('pair validation catches cross-record mismatches after both local codecs accept the records', () => {
  const cases = [
    ['attempt', (reservation, delivery) => { delivery.deliveryAttemptId = 'different-attempt'; }],
    ['identity', (reservation, delivery) => {
      delivery.sourceRef.identity.nativeId = 'different-native';
      delivery.targetRef.identity.nativeId = 'different-native';
    }],
    ['digest', (reservation, delivery) => { delivery.payloadDigest = 'f'.repeat(64); }],
    ['session', (reservation, delivery) => {
      delivery.sourceRef.sessionId = 'different-session';
      delivery.targetRef.sessionId = 'different-session';
    }],
    ['operation', (reservation, delivery) => { delivery.reclamation.operationId = UUID_OTHER; }],
    ['preparedAt', (reservation, delivery) => {
      delivery.reclamation.reclaimedAt = reservation.reclamation.preparedAt - 1;
    }],
    ['retention', (reservation) => {
      reservation.reclamation.preparedAt = reservation.quarantinedAt + TERMINAL_RETENTION_MS - 1;
    }],
  ];

  for (const [name, mutate] of cases) {
    const fixture = validPairFixture('claude', 'checkpoint', 'available');
    const reservation = structuredClone(fixture.reservation);
    const delivery = structuredClone(fixture.delivery);
    mutate(reservation, delivery);

    assert.doesNotThrow(() => normalizeQuestionReservation(reservation), name);
    assert.doesNotThrow(() => normalizeDeliveryRecordV2Local(delivery), name);
    assert.throws(() => normalizeReclaimedQuestionPair({ reservation, delivery }), name);
  }
});

test('terminal retention requires seven days after both quarantine and terminal time', () => {
  const fixture = validPairFixture('claude', 'checkpoint', 'applied');
  const reservation = structuredClone(fixture.reservation);
  const delivery = structuredClone(fixture.delivery);
  reservation.quarantinedAt = 100;
  reservation.reclamation.preparedAt = 100 + TERMINAL_RETENTION_MS;
  reservation.reclaimedAt = reservation.reclamation.preparedAt;
  delivery.terminalAt = 200;
  delivery.reclamation.reclaimedAt = 200 + TERMINAL_RETENTION_MS;

  assert.doesNotThrow(() => normalizeQuestionReservation(reservation));
  assert.doesNotThrow(() => normalizeDeliveryRecordV2Local(delivery));
  assert.throws(() => normalizeReclaimedQuestionPair({ reservation, delivery }));
});

test('none and indeterminate preparations require seven days after quarantine for both providers', () => {
  for (const provider of ['claude', 'codex']) {
    for (const presence of ['none', 'indeterminate']) {
      const fixture = validPairFixture(provider, presence, null);
      const reservation = structuredClone(fixture.reservation);
      reservation.reclamation.preparedAt = reservation.quarantinedAt + TERMINAL_RETENTION_MS - 1;

      assert.doesNotThrow(() => normalizeQuestionReservation(reservation));
      assert.throws(() => normalizeReclaimedQuestionPair({ reservation, delivery: null }));
    }
  }
});

test('a locally valid retained reservation cannot be returned as a reclaimed pair', () => {
  const fixture = validPairFixture('codex', 'checkpoint', 'available');
  const reservation = structuredClone(fixture.reservation);
  reservation.bodyState = 'retained';
  reservation.reclaimedAt = null;

  assert.doesNotThrow(() => normalizeQuestionReservation(reservation));
  assert.throws(() => normalizeReclaimedQuestionPair({ reservation, delivery: fixture.delivery }));
});

test('a mismatched pair is also rejected by the full snapshot validator', () => {
  const fixture = validPairFixture('codex', 'checkpoint', 'available');
  const reservation = structuredClone(fixture.reservation);
  const delivery = structuredClone(fixture.delivery);
  delivery.sourceRef.sessionId = 'different-session';
  delivery.targetRef.sessionId = 'different-session';

  assert.doesNotThrow(() => normalizeQuestionReservation(reservation));
  assert.doesNotThrow(() => normalizeDeliveryRecordV2Local(delivery));
  assert.throws(() => normalizeReclaimedQuestionPair({ reservation, delivery }));
  assert.throws(() => validateReclamationSnapshot(replacePairInSnapshot(fixture, reservation, delivery)));
});

test('normalization leaves caller records mutable and unchanged', () => {
  const fixture = validPairFixture('claude', 'checkpoint', 'available');
  const reservation = structuredClone(fixture.reservation);
  const delivery = structuredClone(fixture.delivery);
  const before = JSON.stringify({ reservation, delivery });

  const result = normalizeReclaimedQuestionPair({ reservation, delivery });

  assert.equal(JSON.stringify({ reservation, delivery }), before);
  assert.equal(Object.isFrozen(reservation), false);
  assert.equal(Object.isFrozen(delivery), false);
  assert.notEqual(result.reservation, reservation);
  assert.notEqual(result.delivery, delivery);
});

test('pair and logical tombstone guards reject accessors and proxies without running traps', () => {
  const fixture = validPairFixture('claude', 'checkpoint', 'available');
  const getterInput = { delivery: fixture.delivery };
  let getterCalls = 0;
  Object.defineProperty(getterInput, 'reservation', {
    enumerable: true,
    get() { getterCalls += 1; return fixture.reservation; },
  });
  assert.throws(() => normalizeReclaimedQuestionPair(getterInput), TypeError);
  assert.equal(getterCalls, 0);

  const pairProxyCounter = { count: 0 };
  assert.throws(() => normalizeReclaimedQuestionPair(
    proxyWithTrapCounter({ reservation: fixture.reservation, delivery: fixture.delivery }, pairProxyCounter)));
  assert.equal(pairProxyCounter.count, 0);

  const reservationProxyCounter = { count: 0 };
  const proxiedReservation = structuredClone(fixture.reservation);
  proxiedReservation.identity = proxyWithTrapCounter(proxiedReservation.identity, reservationProxyCounter);
  assert.throws(() => normalizeReclaimedQuestionPair({
    reservation: proxiedReservation,
    delivery: fixture.delivery,
  }));
  assert.equal(reservationProxyCounter.count, 0);

  const deliveryProxyCounter = { count: 0 };
  assert.throws(() => normalizeReclaimedQuestionPair({
    reservation: fixture.reservation,
    delivery: proxyWithTrapCounter(structuredClone(fixture.delivery), deliveryProxyCounter),
  }));
  assert.equal(deliveryProxyCounter.count, 0);

  const nestedProxyCounter = { count: 0 };
  const proxiedDelivery = structuredClone(fixture.delivery);
  proxiedDelivery.sourceRef = proxyWithTrapCounter(proxiedDelivery.sourceRef, nestedProxyCounter);
  assert.throws(() => normalizeReclaimedQuestionPair({
    reservation: fixture.reservation,
    delivery: proxiedDelivery,
  }));
  assert.equal(nestedProxyCounter.count, 0);

  const launchKeyProxyCounter = { count: 0 };
  const proxiedLaunchKeyDelivery = structuredClone(fixture.delivery);
  proxiedLaunchKeyDelivery.sourceRef.launchKey = proxyWithTrapCounter(
    proxiedLaunchKeyDelivery.sourceRef.launchKey, launchKeyProxyCounter);
  assert.throws(() => normalizeReclaimedQuestionPair({
    reservation: fixture.reservation,
    delivery: proxiedLaunchKeyDelivery,
  }));
  assert.equal(launchKeyProxyCounter.count, 0);

  const tombstone = {
    kind: 'question',
    sourceExecutionId: 'period-1',
    logicalMessageId: 'logical-1',
    revision: 1,
    targetLaunchKey: null,
    sourceLaunchKey: ['launch', 'run', 'attempt'],
    payloadDigest: 'a'.repeat(64),
  };
  const tombstoneProxyCounter = { count: 0 };
  tombstone.sourceLaunchKey = proxyWithTrapCounter(tombstone.sourceLaunchKey, tombstoneProxyCounter);
  assert.throws(() => normalizeLogicalTombstoneV2Local(tombstone));
  assert.equal(tombstoneProxyCounter.count, 0);
});

test('plain-data preflight rejects cycles, excessive depth, sparse arrays, and accessors', () => {
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => assertPlainDataTree(cycle, 'invalid_test_data', 3));

  let deep = {};
  for (let index = 0; index < 129; index += 1) deep = { child: deep };
  assert.throws(() => assertPlainDataTree(deep, 'invalid_test_data', 3));
  assert.throws(() => assertPlainDataTree([1, 2], 'invalid_test_data', 1));
  assert.throws(() => assertPlainDataTree(new Array(1), 'invalid_test_data', 3));

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() { getterCalls += 1; return 1; },
  });
  assert.throws(() => assertPlainDataTree(accessor, 'invalid_test_data', 3));
  assert.equal(getterCalls, 0);

  for (const value of [undefined, Number.NaN, Number.POSITIVE_INFINITY, Symbol('invalid'), 1n, () => {}]) {
    assert.throws(() => assertPlainDataTree(value, 'invalid_test_data', 3));
  }
});

test('logical tombstone local normalization retains its fields without freezing the input', () => {
  const tombstone = {
    kind: 'question',
    sourceExecutionId: 'period-1',
    logicalMessageId: 'logical-1',
    revision: 1,
    targetLaunchKey: null,
    sourceLaunchKey: ['launch', 'run', 'attempt'],
    payloadDigest: 'a'.repeat(64),
  };
  const before = JSON.stringify(tombstone);
  const normalized = normalizeLogicalTombstoneV2Local(tombstone);

  assert.equal(JSON.stringify(normalized), before);
  assert.equal(JSON.stringify(tombstone), before);
  assert.equal(Object.isFrozen(tombstone), false);
});
