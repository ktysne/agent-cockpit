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
