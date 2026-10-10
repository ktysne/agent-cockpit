'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  expandQuestionDeliveryCapsule,
  expandQuestionRejectionCapsule,
} = require('../src/server/question-rejection-capsule-codec');
const { validateQuestionCapsuleFiles } = require('../src/server/question-capsule-files-validation');
const { orderFileRecords } = require('../src/server/question-capsule-file-primitives');
const {
  measureCheckpointCapsuleExistingUpdateReservation,
  measureQuestionCapsuleExistingUpdateReservation,
} = require('../src/server/question-capsule-existing-update-capacity');
const { validateQuestionCapsuleExistingUpdate } = require('../src/server/question-capsule-existing-update-validation');
const {
  measureCheckpointReservation,
  measureQuestionJournalReservationBytes,
} = require('../src/server/reclamation-capacity-bounds');
const { validateReclamationStoreWrite } = require('../src/server/reclamation-store-consistency');
const { selectionFor } = require('../src/server/common-question-kernel');
const { createQuestionCapsuleFilesFixture } = require('./helpers/question-capsule-files-fixtures');

const INVALID = 'invalid_question_capsule_existing_update';
const EXPECTED_SCOPE_LIMITATIONS = [
  'existing_update_structure_and_transition_only',
  'restricted_update_operations',
  'source_freshness_not_verified',
  'queue_exclusion_not_verified',
  'prepare_and_atomic_peak_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'new_question_admission_not_verified',
  'runtime_integration_not_verified',
];

function clone(value) {
  return structuredClone(value);
}

function makeInput(fixture, previous = fixture, next = fixture) {
  return {
    anchor: clone(fixture.input.anchor),
    previous: {
      questionFile: clone(previous.questionFile),
      checkpointFile: clone(previous.checkpointFile),
    },
    next: {
      questionFile: clone(next.questionFile),
      checkpointFile: clone(next.checkpointFile),
    },
    instructionStore: clone(fixture.input.instructionStore),
    normalByteLimitsBySlot: clone(fixture.input.normalByteLimitsBySlot),
  };
}

function withoutCapsules(fixture) {
  const questionFile = clone(fixture.questionFile);
  const checkpointFile = clone(fixture.checkpointFile);
  questionFile.reservations = orderFileRecords([
    ...questionFile.reservations,
    ...questionFile.questionCapsules.flatMap(({ capsule }) => expandQuestionRejectionCapsule(capsule)),
  ], questionFile.reservationOrder, 'internalQuestionId', INVALID);
  questionFile.questionCapsules = [];
  checkpointFile.ledger.deliveries = orderFileRecords([
    ...checkpointFile.ledger.deliveries,
    ...checkpointFile.checkpointCapsules.flatMap(({ capsule }) => expandQuestionDeliveryCapsule(capsule)),
  ], checkpointFile.deliveryAttemptOrder, 'deliveryAttemptId', INVALID);
  checkpointFile.checkpointCapsules = [];
  return { questionFile, checkpointFile };
}

function nullFilesInput(fixture) {
  const input = makeInput(fixture, { questionFile: null, checkpointFile: null },
    { questionFile: null, checkpointFile: null });
  input.instructionStore = null;
  input.normalByteLimitsBySlot = { questions: null, checkpoint: null, instructions: null };
  return input;
}

function jointResult(input, side) {
  return validateQuestionCapsuleFiles({
    anchor: input.anchor,
    questionFile: side.questionFile,
    checkpointFile: side.checkpointFile,
    instructionStore: input.instructionStore,
    normalByteLimitsBySlot: input.normalByteLimitsBySlot,
  });
}

function assertLegacyTransition(input) {
  const previous = jointResult(input, input.previous);
  const next = jointResult(input, input.next);
  const oldWrite = validateReclamationStoreWrite({
    anchor: previous.snapshot.anchor,
    previousStores: previous.snapshot.stores,
    nextStores: next.snapshot.stores,
    normalByteLimitsBySlot: input.normalByteLimitsBySlot,
  });
  assert.equal(oldWrite.status, 'checked');
  assert.deepEqual(oldWrite.reasons, []);
  assert.deepEqual(oldWrite.snapshot, next.snapshot);
  return { previous, next };
}

function assertReady(input) {
  const { previous, next } = assertLegacyTransition(input);
  const result = validateQuestionCapsuleExistingUpdate(input);
  assert.deepEqual(result.previous, previous.snapshot);
  assert.deepEqual(result.next, next.snapshot);
  assert.equal(Object.isFrozen(result), false);
  assert.equal(Object.isFrozen(result.previous), false);
  assert.equal(Object.isFrozen(result.next), false);
  assert.equal(Object.isFrozen(result.scopeLimitations), true);
  assert.deepEqual(result.scopeLimitations, EXPECTED_SCOPE_LIMITATIONS);
  for (const slot of ['questions', 'checkpoint']) {
    const beforeFile = input.previous[slot === 'questions' ? 'questionFile' : 'checkpointFile'];
    const afterFile = input.next[slot === 'questions' ? 'questionFile' : 'checkpointFile'];
    const measurement = result.measurements[slot];
    if (beforeFile === null) {
      assert.equal(afterFile, null);
      assert.equal(measurement, null);
    } else {
      assert.equal(measurement.before.fits, true);
      assert.equal(measurement.after.fits, true);
      assert.ok(measurement.after.currentBytes <= measurement.before.reservedBytes);
    }
  }
  return result;
}

function assertInvalid(input) {
  assert.throws(() => validateQuestionCapsuleExistingUpdate(input), (error) =>
    error instanceof TypeError && error.message === INVALID);
}

function deepFreeze(value, seen = new Set()) {
  if (value === null || typeof value !== 'object' || seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key], seen);
  return Object.freeze(value);
}

test('no-op and monotone store revisions pass for both providers and mixed periods', () => {
  for (const options of [
    { provider: 'claude' },
    { provider: 'codex' },
    { provider: 'claude', secondaryProvider: 'codex' },
    { provider: 'codex', secondaryProvider: 'claude' },
  ]) {
    const fixture = createQuestionCapsuleFilesFixture(options);
    const input = makeInput(fixture);
    const beforeInput = clone(input);
    const result = assertReady(input);
    assert.deepEqual(input, beforeInput);
    assert.equal(result.measurements.questions.before.fits, true);
    assert.equal(result.measurements.checkpoint.before.fits, true);
  }

  const fixture = createQuestionCapsuleFilesFixture({ provider: 'claude' });
  const input = makeInput(fixture);
  input.next.questionFile.revision += 1;
  input.next.checkpointFile.revision += 1;
  input.next.checkpointFile.ledger.revision += 1;
  assertReady(input);
});

test('capsule-free files keep their array ownership, counts, and order', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'codex' });
  const files = withoutCapsules(fixture);
  const input = makeInput(fixture, files, files);
  assert.equal(input.previous.questionFile.questionCapsules.length, 0);
  assert.equal(input.previous.checkpointFile.checkpointCapsules.length, 0);
  assertReady(input);
});

test('selected ordinary question late answers append without changing reservation structure', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'claude', ordinaryQuestionSelected: true });
  const input = makeInput(fixture);
  const question = input.next.questionFile.questions[0];
  const answers = [{ questionId: question.questions[0].id, optionIds: [], freeText: 'later response' }];
  const legacyQuestion = { ...question };
  delete legacyQuestion.deliveryCreationState;
  delete legacyQuestion.quarantinedAt;
  const late = selectionFor(legacyQuestion, answers, 'manual', question.createdAt + 1,
    'late-answer-fixture').record;
  question.lateAnswers = clone(late.lateAnswers);
  input.next.questionFile.revision += 1;
  const result = assertReady(input);
  assert.equal(result.next.stores.questions.questions[0].lateAnswers.length, 1);
});

test('non-question checkpoint delivery progression stays within the existing reservation', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'codex' });
  const input = makeInput(fixture);
  const delivery = input.next.checkpointFile.ledger.deliveries.find((row) => row.kind === 'instruction');
  delivery.state = 'accepted';
  delivery.acceptedCorrelation = {
    deliveryAttemptId: delivery.deliveryAttemptId,
    revision: delivery.revision,
    payloadDigest: delivery.payloadDigest,
    targetPeriodId: delivery.target.periodId,
    nativeTurnId: 'native-turn-1',
    nativeItemId: null,
    clientRequestId: delivery.deliveryAttemptId,
  };
  input.next.checkpointFile.ledger.revision += 1;
  input.next.checkpointFile.revision += 1;
  const result = assertReady(input);
  const restored = result.next.stores.checkpoint.ledger.deliveries.find((row) => row.kind === 'instruction');
  assert.equal(restored.state, 'accepted');
  assert.equal(restored.acceptedCorrelation.nativeTurnId, 'native-turn-1');
});

test('both-null slots remain null and return null measurements', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'claude' });
  const input = nullFilesInput(fixture);
  const result = assertReady(input);
  assert.deepEqual(result.measurements, { questions: null, checkpoint: null });
});

test('null slots cannot become present or absent across the update', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'claude' });
  const allNull = nullFilesInput(fixture);
  allNull.next.questionFile = clone(fixture.questionFile);
  assertInvalid(allNull);

  const presentToNull = makeInput(fixture);
  presentToNull.next.checkpointFile = null;
  assertInvalid(presentToNull);
});

test('capsule metadata changes are rejected even when both old whole snapshots and transition pass', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'claude' });
  const input = makeInput(fixture);
  const questionWrapper = input.next.questionFile.questionCapsules[0];
  const matchingCheckpoint = input.next.checkpointFile.checkpointCapsules.find((row) =>
    row.chunkId === questionWrapper.chunkId);
  questionWrapper.capsule.compactionOperationId = '99999999-9999-4999-8999-999999999999';
  if (matchingCheckpoint) matchingCheckpoint.capsule.compactionOperationId = questionWrapper.capsule.compactionOperationId;
  assertLegacyTransition(input);
  assertInvalid(input);
});

test('declared reservation and delivery order changes are rejected after the old transition passes', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'claude' });
  const input = makeInput(fixture);
  input.next.questionFile.revision += 1;
  input.next.questionFile.reservationOrder.reverse();
  input.next.questionFile.reservations.reverse();
  input.next.checkpointFile.revision += 1;
  input.next.checkpointFile.ledger.revision += 1;
  input.next.checkpointFile.deliveryAttemptOrder.reverse();
  input.next.checkpointFile.ledger.deliveries.reverse();
  assertLegacyTransition(input);
  assertInvalid(input);
});

test('question record and reservation revision changes fail the legacy transition control', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'claude' });
  const input = makeInput(fixture);
  const question = input.next.questionFile.questions[0];
  input.next.questionFile.revision += 1;
  question.revision += 1;
  const reservation = input.next.questionFile.reservations.find((row) =>
    row.internalQuestionId === question.internalQuestionId);
  reservation.revision += 1;

  const previous = jointResult(input, input.previous);
  const next = jointResult(input, input.next);
  assert.throws(() => validateReclamationStoreWrite({
    anchor: previous.snapshot.anchor,
    previousStores: previous.snapshot.stores,
    nextStores: next.snapshot.stores,
    normalByteLimitsBySlot: input.normalByteLimitsBySlot,
  }), (error) => error instanceof TypeError && error.message === 'invalid_reclamation_store_write');
  assertInvalid(input);
});

test('new question and checkpoint reservations reject limits that fit old reservations only', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'claude' });
  const files = withoutCapsules(fixture);
  const input = makeInput(fixture, files, files);
  const baseline = jointResult(input, input.previous);
  const oldQuestions = measureQuestionJournalReservationBytes({
    snapshot: baseline.snapshot.stores.questions,
    currentByteLimit: input.normalByteLimitsBySlot.questions,
  });
  const oldCheckpoint = measureCheckpointReservation({
    snapshot: baseline.snapshot.stores.checkpoint,
    currentByteLimit: input.normalByteLimitsBySlot.checkpoint,
  });
  assert.equal(oldQuestions.fits, true);
  assert.equal(oldCheckpoint.fits, true);

  for (const targetSlot of ['questions', 'checkpoint']) {
    const targetOldMeasurement = targetSlot === 'questions' ? oldQuestions : oldCheckpoint;
    const input = makeInput(fixture, files, files);
    input.normalByteLimitsBySlot[targetSlot] = targetOldMeasurement.reservedBytes;
    assertLegacyTransition(input);

    const newQuestions = measureQuestionCapsuleExistingUpdateReservation({
      questionFile: input.previous.questionFile,
      currentByteLimit: input.normalByteLimitsBySlot.questions,
    });
    const newCheckpoint = measureCheckpointCapsuleExistingUpdateReservation({
      checkpointFile: input.previous.checkpointFile,
      currentByteLimit: input.normalByteLimitsBySlot.checkpoint,
    });
    const targetNewMeasurement = targetSlot === 'questions' ? newQuestions : newCheckpoint;
    const otherNewMeasurement = targetSlot === 'questions' ? newCheckpoint : newQuestions;
    assert.ok(targetNewMeasurement.currentBytes <= targetOldMeasurement.reservedBytes);
    assert.ok(targetNewMeasurement.reservedBytes > targetOldMeasurement.reservedBytes);
    assert.equal(targetNewMeasurement.fits, false);
    assert.equal(otherNewMeasurement.fits, true);
    assertInvalid(input);
  }
});

test('a legacy-accepted held change is outside the initial operation whitelist', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'claude', ordinaryQuestionSelected: true });
  const input = makeInput(fixture);
  input.next.questionFile.revision += 1;
  input.next.questionFile.questions[0].held = !input.next.questionFile.questions[0].held;
  assertLegacyTransition(input);
  assertInvalid(input);
});

test('exact guards reject unknown fields and accessors without invoking getters', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'claude' });
  const input = makeInput(fixture);
  input.extra = true;
  assertInvalid(input);

  const withGetter = makeInput(fixture);
  let getterCalls = 0;
  Object.defineProperty(withGetter, 'anchor', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return fixture.input.anchor;
    },
  });
  assertInvalid(withGetter);
  assert.equal(getterCalls, 0);

  const withPreviousGetter = makeInput(fixture);
  Object.defineProperty(withPreviousGetter.previous, 'questionFile', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return fixture.questionFile;
    },
  });
  assertInvalid(withPreviousGetter);
  assert.equal(getterCalls, 0);
});

test('proxy inputs are rejected before any proxy trap runs', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'claude' });
  const cases = [
    (input, proxy) => proxy(input),
    (input, proxy) => { input.previous = proxy(input.previous); },
    (input, proxy) => { input.next = proxy(input.next); },
    (input, proxy) => { input.anchor = proxy(input.anchor); },
    (input, proxy) => { input.instructionStore = proxy(input.instructionStore); },
    (input, proxy) => { input.normalByteLimitsBySlot = proxy(input.normalByteLimitsBySlot); },
    (input, proxy) => { input.previous.questionFile = proxy(input.previous.questionFile); },
    (input, proxy) => { input.next.checkpointFile = proxy(input.next.checkpointFile); },
  ];
  for (const [index, wrap] of cases.entries()) {
    const input = makeInput(fixture);
    let trapCount = 0;
    const proxy = (value) => new Proxy(value, {
      get() { trapCount += 1; throw new Error('proxy trap'); },
      getOwnPropertyDescriptor() { trapCount += 1; throw new Error('proxy trap'); },
      getPrototypeOf() { trapCount += 1; throw new Error('proxy trap'); },
      ownKeys() { trapCount += 1; throw new Error('proxy trap'); },
    });
    const wrapped = wrap(input, proxy);
    const candidate = wrapped ?? input;
    assert.throws(() => validateQuestionCapsuleExistingUpdate(candidate), (error) =>
      error instanceof TypeError && error.message === INVALID, `proxy case ${index}`);
    assert.equal(trapCount, 0);
  }
});

test('frozen inputs remain unchanged and returned snapshots are detached and mutable', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'codex' });
  const input = deepFreeze(makeInput(fixture));
  const expectedInput = clone(input);
  const result = assertReady(input);
  assert.deepEqual(input, expectedInput);

  const inputRevision = input.anchor.revision;
  result.previous.anchor.revision += 1;
  assert.equal(input.anchor.revision, inputRevision);
  assert.notEqual(result.previous.anchor.revision, inputRevision);
  const previousSnapshotRevision = result.previous.anchor.revision;
  result.measurements.questions.after.currentBytes = 0;
  assert.equal(result.previous.anchor.revision, previousSnapshotRevision);
});
