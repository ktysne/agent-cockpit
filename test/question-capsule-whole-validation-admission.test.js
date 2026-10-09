'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  validateQuestionCapsuleWholeRepresentation,
} = require('../src/server/question-capsule-whole-validation');
const {
  createQuestionCapsuleWholeValidationFixture,
} = require('./helpers/question-capsule-whole-validation-fixtures');

const INVALID_WHOLE = 'invalid_question_capsule_whole_representation';
const MAX_CAPSULE_PAIRS = 20_000;
const MAX_QUESTION_RESERVATIONS = 20_000;
const MAX_DELIVERIES = 20_000;
const MAX_NOTIFICATION_TARGETS = 10_000;
const MAX_CHECKPOINT_REGISTRATION_RECORDS = 50_000;

function inputFixture() {
  return createQuestionCapsuleWholeValidationFixture().input;
}

function assertInvalid(input) {
  assert.throws(() => validateQuestionCapsuleWholeRepresentation(input), {
    name: 'TypeError',
    message: INVALID_WHOLE,
  });
}

function trackedProxy(counter) {
  return new Proxy({}, {
    get(target, key, receiver) {
      counter.count += 1;
      return Reflect.get(target, key, receiver);
    },
    ownKeys(target) {
      counter.count += 1;
      return Reflect.ownKeys(target);
    },
    getOwnPropertyDescriptor(target, key) {
      counter.count += 1;
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
}

function trackedRows(count, counter) {
  return Array(count).fill(trackedProxy(counter));
}

function capsuleReservationCount(input) {
  return input.capsulePairs.reduce((total, pair) => total + pair.questionCapsule.reservations.length, 0);
}

function capsuleDeliveryCount(input) {
  return input.capsulePairs.reduce((total, pair) => total + (pair.checkpointCapsule?.deliveries.length ?? 0), 0);
}

function watchOwnKeys(t) {
  const callsByValue = new Map();
  const originalOwnKeys = Reflect.ownKeys;
  t.mock.method(Reflect, 'ownKeys', (value) => {
    if (callsByValue.has(value)) callsByValue.set(value, callsByValue.get(value) + 1);
    return originalOwnKeys(value);
  });
  return {
    watch(value) {
      callsByValue.set(value, 0);
    },
    calls(value) {
      return callsByValue.get(value) ?? 0;
    },
  };
}

function capsulePairWithReservations(template, count) {
  const pair = structuredClone(template);
  pair.questionCapsule.reservations = Array(count).fill({});
  return pair;
}

function capsulePairWithDeliveries(template, count) {
  const pair = structuredClone(template);
  pair.checkpointCapsule.deliveries = Array(count).fill({});
  return pair;
}

test('rejects more than the capsule-pair admission limit before reading a pair getter', () => {
  const input = inputFixture();
  const getterCalls = { count: 0 };
  const oversizedPairs = new Array(MAX_CAPSULE_PAIRS + 1);
  Object.defineProperty(oversizedPairs, '0', {
    enumerable: true,
    get() {
      getterCalls.count += 1;
      return {};
    },
  });
  input.capsulePairs = oversizedPairs;

  assertInvalid(input);
  assert.equal(getterCalls.count, 0);
});

test('rejects over-limit combined question reservations with no row proxy trap calls', () => {
  const input = inputFixture();
  const rowInspection = { count: 0 };
  const capsuleCount = capsuleReservationCount(input);
  input.ordinaryStores.questions.reservations = trackedRows(
    MAX_QUESTION_RESERVATIONS - capsuleCount + 1,
    rowInspection,
  );
  input.ordinaryStores.questions.questions = [];

  assertInvalid(input);
  assert.equal(rowInspection.count, 0);
});

test('rejects over-limit combined deliveries with no row proxy trap calls', () => {
  const input = inputFixture();
  const rowInspection = { count: 0 };
  const capsuleCount = capsuleDeliveryCount(input);
  input.ordinaryStores.checkpoint.ledger.deliveries = trackedRows(
    MAX_DELIVERIES - capsuleCount + 1,
    rowInspection,
  );

  assertInvalid(input);
  assert.equal(rowInspection.count, 0);
});

test('rejects an oversized capsule reference dictionary with no row proxy trap calls', () => {
  const input = inputFixture();
  const rowInspection = { count: 0 };
  const checkpointCapsule = input.capsulePairs.find((pair) => pair.checkpointCapsule !== null).checkpointCapsule;
  checkpointCapsule.deliveries = [];
  checkpointCapsule.references.sources = [trackedProxy(rowInspection)];
  checkpointCapsule.references.targets = [];

  assertInvalid(input);
  assert.equal(rowInspection.count, 0);
});

test('rejects over-limit checkpoint registration totals with no row proxy trap calls', () => {
  const input = inputFixture();
  const rowInspection = { count: 0 };
  const registrations = input.ordinaryStores.checkpoint.registrations;
  registrations.conversations = trackedRows(MAX_CHECKPOINT_REGISTRATION_RECORDS, rowInspection);
  registrations.executions = [trackedProxy(rowInspection)];

  assertInvalid(input);
  assert.equal(rowInspection.count, 0);
});

test('keeps checkpoint ledger limits independent from registration totals with zero row proxy trap calls', () => {
  const cases = [
    ['deliveries', MAX_DELIVERIES],
    ['notificationTargets', MAX_NOTIFICATION_TARGETS],
    ['logicalTombstones', MAX_QUESTION_RESERVATIONS],
  ];

  for (const [field, maximum] of cases) {
    const input = inputFixture();
    const rowInspection = { count: 0 };
    input.ordinaryStores.checkpoint.ledger[field] = trackedRows(maximum + 1, rowInspection);

    assertInvalid(input);
    assert.equal(rowInspection.count, 0, `${field} rows must not be inspected after admission fails`);
  }
});

test('rejects an over-limit capsule-pair array before enumerating it', (t) => {
  const input = inputFixture();
  const pair = structuredClone(input.capsulePairs[0]);
  pair.questionCapsule.reservations = [];
  pair.checkpointCapsule = null;
  const oversizedPairs = Array(MAX_CAPSULE_PAIRS + 1).fill(pair);
  input.capsulePairs = oversizedPairs;
  const ownKeysWatcher = watchOwnKeys(t);
  ownKeysWatcher.watch(oversizedPairs);

  assertInvalid(input);
  assert.equal(ownKeysWatcher.calls(oversizedPairs), 0);
});

test('enumerates a capsule-pair array at its admission limit', (t) => {
  const input = inputFixture();
  const pair = structuredClone(input.capsulePairs[0]);
  pair.questionCapsule.reservations = [];
  pair.checkpointCapsule = null;
  input.capsulePairs = Array(MAX_CAPSULE_PAIRS).fill(pair);
  const ownKeysWatcher = watchOwnKeys(t);
  ownKeysWatcher.watch(pair);

  assertInvalid(input);
  assert.ok(ownKeysWatcher.calls(pair) > 0);
});

test('rejects combined question reservations at the crossing pair and skips later pairs', (t) => {
  const input = inputFixture();
  const pair = capsulePairWithReservations(input.capsulePairs[0], 2);
  const laterPair = { laterPairMarker: true };
  input.ordinaryStores.questions.reservations = Array(MAX_QUESTION_RESERVATIONS - 1).fill({});
  input.ordinaryStores.questions.questions = [];
  input.capsulePairs = [pair, laterPair];
  const ownKeysWatcher = watchOwnKeys(t);
  ownKeysWatcher.watch(laterPair);

  assertInvalid(input);
  assert.equal(ownKeysWatcher.calls(laterPair), 0);
});

test('visits later pairs when combined question reservations equal the admission limit', (t) => {
  const input = inputFixture();
  const pair = capsulePairWithReservations(input.capsulePairs[0], 2);
  const laterPair = { laterPairMarker: true };
  input.ordinaryStores.questions.reservations = Array(MAX_QUESTION_RESERVATIONS - 2).fill({});
  input.ordinaryStores.questions.questions = [];
  input.capsulePairs = [pair, laterPair];
  const ownKeysWatcher = watchOwnKeys(t);
  ownKeysWatcher.watch(laterPair);

  assertInvalid(input);
  assert.ok(ownKeysWatcher.calls(laterPair) > 0);
});

test('rejects combined deliveries at the crossing pair and skips later pairs', (t) => {
  const input = inputFixture();
  const deliveryPair = input.capsulePairs.find((pair) => pair.checkpointCapsule !== null);
  const pair = capsulePairWithDeliveries(deliveryPair, 2);
  const laterPair = { laterPairMarker: true };
  input.ordinaryStores.checkpoint.ledger.deliveries = Array(MAX_DELIVERIES - 1).fill({});
  input.capsulePairs = [pair, laterPair];
  const ownKeysWatcher = watchOwnKeys(t);
  ownKeysWatcher.watch(laterPair);

  assertInvalid(input);
  assert.equal(ownKeysWatcher.calls(laterPair), 0);
});

test('visits later pairs when combined deliveries equal the admission limit', (t) => {
  const input = inputFixture();
  const deliveryPair = input.capsulePairs.find((pair) => pair.checkpointCapsule !== null);
  const pair = capsulePairWithDeliveries(deliveryPair, 2);
  const laterPair = { laterPairMarker: true };
  input.ordinaryStores.checkpoint.ledger.deliveries = Array(MAX_DELIVERIES - 2).fill({});
  input.capsulePairs = [pair, laterPair];
  const ownKeysWatcher = watchOwnKeys(t);
  ownKeysWatcher.watch(laterPair);

  assertInvalid(input);
  assert.ok(ownKeysWatcher.calls(laterPair) > 0);
});

test('rejects checkpoint registration totals over the limit before reading the ledger', (t) => {
  const input = inputFixture();
  const registrations = input.ordinaryStores.checkpoint.registrations;
  for (const field of Object.keys(registrations)) registrations[field] = [];
  registrations.conversations = Array(MAX_CHECKPOINT_REGISTRATION_RECORDS).fill({});
  registrations.executions = [{}];
  const ledger = input.ordinaryStores.checkpoint.ledger;
  const ownKeysWatcher = watchOwnKeys(t);
  ownKeysWatcher.watch(ledger);

  assertInvalid(input);
  assert.equal(ownKeysWatcher.calls(ledger), 0);
});

test('reads the ledger when checkpoint registrations equal their limit', (t) => {
  const input = inputFixture();
  const registrations = input.ordinaryStores.checkpoint.registrations;
  for (const field of Object.keys(registrations)) registrations[field] = [];
  registrations.conversations = Array(MAX_CHECKPOINT_REGISTRATION_RECORDS - 1).fill({});
  registrations.executions = [{}];
  const ledger = input.ordinaryStores.checkpoint.ledger;
  const ownKeysWatcher = watchOwnKeys(t);
  ownKeysWatcher.watch(ledger);

  assertInvalid(input);
  assert.ok(ownKeysWatcher.calls(ledger) > 0);
});

test('rejects a capsule reference count mismatch before reading a later pair', (t) => {
  const input = inputFixture();
  const pair = structuredClone(input.capsulePairs.find((item) => item.checkpointCapsule !== null));
  pair.checkpointCapsule.deliveries = [];
  pair.checkpointCapsule.references.sources = [{}];
  pair.checkpointCapsule.references.targets = [];
  const laterPair = { laterPairMarker: true };
  input.capsulePairs = [pair, laterPair];
  const ownKeysWatcher = watchOwnKeys(t);
  ownKeysWatcher.watch(laterPair);

  assertInvalid(input);
  assert.equal(ownKeysWatcher.calls(laterPair), 0);
});

test('visits later pairs when capsule references match delivery count', (t) => {
  const input = inputFixture();
  const pair = structuredClone(input.capsulePairs.find((item) => item.checkpointCapsule !== null));
  pair.checkpointCapsule.deliveries = [];
  pair.checkpointCapsule.references.sources = [];
  pair.checkpointCapsule.references.targets = [];
  const laterPair = { laterPairMarker: true };
  input.capsulePairs = [pair, laterPair];
  const ownKeysWatcher = watchOwnKeys(t);
  ownKeysWatcher.watch(laterPair);

  assertInvalid(input);
  assert.ok(ownKeysWatcher.calls(laterPair) > 0);
});

test('checks each checkpoint ledger array length before enumerating an oversized array', (t) => {
  const cases = [
    ['deliveries', MAX_DELIVERIES],
    ['notificationTargets', MAX_NOTIFICATION_TARGETS],
    ['logicalTombstones', MAX_QUESTION_RESERVATIONS],
  ];
  const ownKeysWatcher = watchOwnKeys(t);

  for (const [field, maximum] of cases) {
    const input = inputFixture();
    const oversized = Array(maximum + 1).fill({});
    input.ordinaryStores.checkpoint.ledger[field] = oversized;
    ownKeysWatcher.watch(oversized);

    assertInvalid(input);
    assert.equal(ownKeysWatcher.calls(oversized), 0, `${field} should be length-checked before enumeration`);
  }
});

test('enumerates each checkpoint ledger array at its admission limit', (t) => {
  const cases = [
    ['deliveries', MAX_DELIVERIES],
    ['notificationTargets', MAX_NOTIFICATION_TARGETS],
    ['logicalTombstones', MAX_QUESTION_RESERVATIONS],
  ];
  const ownKeysWatcher = watchOwnKeys(t);

  for (const [field, maximum] of cases) {
    const input = inputFixture();
    const boundary = Array(maximum).fill({});
    input.ordinaryStores.checkpoint.ledger[field] = boundary;
    ownKeysWatcher.watch(boundary);

    assertInvalid(input);
    assert.ok(ownKeysWatcher.calls(boundary) > 0, `${field} at the limit should be enumerated`);
  }
});
