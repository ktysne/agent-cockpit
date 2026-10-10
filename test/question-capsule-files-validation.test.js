'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  decodeCapsuleCheckpointV4Local,
  encodeCapsuleCheckpointV4Local,
} = require('../src/server/question-capsule-checkpoint-codec');
const {
  decodeQuestionCapsuleJournalV3Local,
  encodeQuestionCapsuleJournalV3Local,
} = require('../src/server/question-capsule-journal-codec');
const { validateQuestionCapsuleFiles } = require('../src/server/question-capsule-files-validation');
const { validateQuestionCapsuleWholeRepresentation } = require('../src/server/question-capsule-whole-validation');
const {
  validateReclamationSnapshot,
  validateReclamationStoreWrite,
} = require('../src/server/reclamation-store-consistency');
const { MAX_SOURCE_BYTES } = require('../src/server/reclamation-capacity-bounds');
const { createQuestionCapsuleWholeValidationFixture } = require('./helpers/question-capsule-whole-validation-fixtures');
const { createQuestionCapsuleFilesFixture } = require('./helpers/question-capsule-files-fixtures');

const INVALID_FILES = 'invalid_question_capsule_files';
const SCOPE_LIMITATIONS = [
  'declared_delivery_order_authenticity_not_verified',
  'anchor_persistence_not_verified',
  'persistent_outer_schema_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'runtime_integration_not_verified',
  'new_outer_future_capacity_not_verified',
];

function clone(value) {
  return structuredClone(value);
}

function assertInvalid(input) {
  assert.throws(() => validateQuestionCapsuleFiles(input), {
    name: 'TypeError',
    message: INVALID_FILES,
  });
}

function roundTripFiles(input) {
  return {
    ...input,
    questionFile: input.questionFile === null
      ? null
      : decodeQuestionCapsuleJournalV3Local(encodeQuestionCapsuleJournalV3Local(input.questionFile).bytes),
    checkpointFile: input.checkpointFile === null
      ? null
      : decodeCapsuleCheckpointV4Local(encodeCapsuleCheckpointV4Local(input.checkpointFile).bytes),
  };
}

function assertReadyAndChecked(fixture) {
  const snapshotOracle = validateReclamationSnapshot(fixture.snapshot);
  assert.equal(snapshotOracle.status, 'ready');
  assert.deepEqual(snapshotOracle.reasons, []);
  const writeOracle = validateReclamationStoreWrite({
    anchor: fixture.snapshot.anchor,
    previousStores: fixture.snapshot.stores,
    nextStores: fixture.snapshot.stores,
    normalByteLimitsBySlot: fixture.input.normalByteLimitsBySlot,
  });
  assert.equal(writeOracle.status, 'checked');
  assert.deepEqual(writeOracle.reasons, []);
}

function allOrdinaryFiles(snapshot, normalByteLimitsBySlot) {
  const stores = clone(snapshot.stores);
  const questionFile = stores.questions === null ? null : {
    schemaVersion: 3,
    storeId: stores.questions.storeId,
    revision: stores.questions.revision,
    questions: stores.questions.questions,
    reservations: stores.questions.reservations,
    migrationAllowance: stores.questions.migrationAllowance,
    questionCapsules: [],
    reservationOrder: stores.questions.reservations.map((row) => row.internalQuestionId),
  };
  const checkpointFile = stores.checkpoint === null ? null : {
    schemaVersion: 4,
    storeId: stores.checkpoint.storeId,
    revision: stores.checkpoint.revision,
    registrations: stores.checkpoint.registrations,
    ledger: stores.checkpoint.ledger,
    migrationAllowance: stores.checkpoint.migrationAllowance,
    checkpointCapsules: [],
    deliveryAttemptOrder: stores.checkpoint.ledger.deliveries.map((row) => row.deliveryAttemptId),
  };
  const limits = clone(normalByteLimitsBySlot);
  const wholeInput = {
    formatVersion: 1,
    anchor: clone(snapshot.anchor),
    ordinaryStores: stores,
    capsulePairs: [],
    deliveryAttemptOrder: checkpointFile?.deliveryAttemptOrder ?? [],
    questionReservationOrder: questionFile?.reservationOrder ?? [],
    normalByteLimitsBySlot: limits,
  };
  return {
    input: {
      anchor: clone(snapshot.anchor),
      questionFile,
      checkpointFile,
      instructionStore: stores.instructions,
      normalByteLimitsBySlot: limits,
    },
    wholeInput,
  };
}

function tombstoneForDelivery(delivery) {
  return {
    kind: delivery.kind,
    sourceExecutionId: delivery.sourceExecutionId,
    logicalMessageId: delivery.logicalMessageId,
    revision: delivery.revision,
    targetLaunchKey: null,
    sourceLaunchKey: clone(delivery.sourceRef.launchKey),
    payloadDigest: delivery.payloadDigest,
  };
}

function addThresholdRows(snapshot, wholeInput) {
  const nextSnapshot = clone(snapshot);
  const nextWholeInput = clone(wholeInput);
  const templateReservation = nextSnapshot.stores.questions.reservations.find((reservation) =>
    reservation.deliveryIntent?.deliveryAttemptId !== undefined);
  const templateDelivery = nextSnapshot.stores.checkpoint.ledger.deliveries.find((delivery) =>
    delivery.deliveryAttemptId === templateReservation?.deliveryIntent?.deliveryAttemptId);
  assert.ok(templateReservation);
  assert.ok(templateDelivery);
  const allReservations = [];
  const allDeliveries = [];

  for (let sequence = 0; sequence < 768; sequence += 1) {
    const suffix = String(sequence).padStart(4, '0');
    const attemptId = `threshold-attempt-${suffix}`;
    const logicalMessageId = `threshold-logical-${suffix}`;
    const reservation = clone(templateReservation);
    const delivery = clone(templateDelivery);
    reservation.internalQuestionId = `threshold-internal-${suffix}`;
    reservation.questionId = `threshold-public-${suffix}`;
    reservation.deliveryIntent.deliveryAttemptId = attemptId;
    reservation.deliveryIntent.logicalMessageId = logicalMessageId;
    reservation.reclamation.operationId = `c0000000-0000-4000-8000-${String(sequence + 1).padStart(12, '0')}`;
    delivery.deliveryAttemptId = attemptId;
    delivery.logicalMessageId = logicalMessageId;
    delivery.reclamation.operationId = reservation.reclamation.operationId;
    for (const correlation of [delivery.acceptedCorrelation, delivery.appliedCorrelation]) {
      if (correlation) {
        correlation.deliveryAttemptId = attemptId;
        correlation.clientRequestId = attemptId;
        correlation.nativeItemId = `threshold-item-${suffix}`;
        correlation.nativeTurnId = `threshold-turn-${suffix}`;
      }
    }
    allReservations.push(reservation);
    allDeliveries.push(delivery);
  }

  nextSnapshot.stores.questions.reservations.push(...clone(allReservations));
  nextSnapshot.stores.checkpoint.ledger.deliveries.push(...clone(allDeliveries));
  nextSnapshot.stores.checkpoint.ledger.logicalTombstones.push(...allDeliveries.map(tombstoneForDelivery));

  const stores = nextWholeInput.ordinaryStores;
  stores.questions.reservations.push(...clone(allReservations));
  stores.checkpoint.ledger.deliveries.push(...clone(allDeliveries));
  stores.checkpoint.ledger.logicalTombstones.push(...allDeliveries.map(tombstoneForDelivery));
  nextWholeInput.questionReservationOrder.push(...allReservations.map((row) => row.internalQuestionId));
  nextWholeInput.deliveryAttemptOrder.push(...allDeliveries.map((row) => row.deliveryAttemptId));
  return { snapshot: nextSnapshot, wholeInput: nextWholeInput };
}

function proxyWithTrapCounter(value, counter) {
  return new Proxy(value, {
    getPrototypeOf(target) { counter.count += 1; return Object.getPrototypeOf(target); },
    ownKeys(target) { counter.count += 1; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      counter.count += 1;
      return Object.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, receiver) { counter.count += 1; return Reflect.get(target, key, receiver); },
  });
}

test('new Q3/CP4 files round trip into the same ready and checked snapshots for both providers', () => {
  for (const options of [
    { provider: 'claude' },
    { provider: 'codex' },
    { provider: 'claude', secondaryProvider: 'codex', ordinaryQuestionSelected: true },
  ]) {
    const fixture = createQuestionCapsuleFilesFixture(options);
    assertReadyAndChecked(fixture);
    assert.deepEqual(validateQuestionCapsuleWholeRepresentation(fixture.wholeInput).snapshot, fixture.snapshot);
    const input = roundTripFiles(fixture.input);
    const result = validateQuestionCapsuleFiles(input);
    assert.deepEqual(result.snapshot, fixture.snapshot);
    assert.deepEqual(result.counts, {
      capsulePairs: 4,
      checkpointCapsules: 2,
      ordinaryQuestionReservations: 1,
      capsuleQuestionReservations: 4,
      questionReservations: 5,
      ordinaryDeliveries: options.ordinaryQuestionSelected ? 2 : 1,
      capsuleDeliveries: 2,
      deliveries: options.ordinaryQuestionSelected ? 4 : 3,
    });
    assert.deepEqual(result.scopeLimitations, SCOPE_LIMITATIONS);
    assert.ok(input.instructionStore.migrationAllowance);
    assert.deepEqual({ ...result.snapshot.stores.instructions.migrationAllowance },
      input.instructionStore.migrationAllowance);
  }
});

test('joint pairing uses chunk UUIDs after independent chunk reordering and accepts shared operation IDs', () => {
  const fixture = createQuestionCapsuleFilesFixture({
    provider: 'claude',
    secondaryProvider: 'codex',
    ordinaryQuestionSelected: true,
  });
  const operationIds = new Set(fixture.questionFile.questionCapsules.map((entry) =>
    entry.capsule.compactionOperationId));
  assert.equal(operationIds.size, 1);
  fixture.questionFile.questionCapsules.reverse();
  fixture.checkpointFile.checkpointCapsules.reverse();

  const result = validateQuestionCapsuleFiles(roundTripFiles(fixture.input));
  assert.deepEqual(result.snapshot, fixture.snapshot);
});

test('joint validation rejects a required missing checkpoint, an unmatched checkpoint chunk, and header mismatches', () => {
  const fixture = createQuestionCapsuleFilesFixture();

  const missingCheckpoint = clone(fixture.input);
  const removed = missingCheckpoint.checkpointFile.checkpointCapsules.shift();
  const removedAttempts = new Set(removed.capsule.deliveries.map((row) => row.deliveryAttemptId));
  missingCheckpoint.checkpointFile.deliveryAttemptOrder =
    missingCheckpoint.checkpointFile.deliveryAttemptOrder.filter((id) => !removedAttempts.has(id));
  assertInvalid(missingCheckpoint);

  const unmatchedCheckpoint = clone(fixture.input);
  unmatchedCheckpoint.questionFile.questionCapsules[0].chunkId =
    'b0000000-0000-4000-8000-000000000001';
  assertInvalid(unmatchedCheckpoint);

  const mismatchedHeader = clone(fixture.input);
  mismatchedHeader.checkpointFile.checkpointCapsules[0].capsule.compactionOperationId =
    'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
  assertInvalid(mismatchedHeader);
});

test('joint validation rejects duplicate chunk UUIDs and an ordinary row order that disagrees with the declared order', () => {
  const fixture = createQuestionCapsuleFilesFixture({ ordinaryQuestionSelected: true });
  const duplicateChunk = clone(fixture.input);
  duplicateChunk.questionFile.questionCapsules.push(clone(duplicateChunk.questionFile.questionCapsules[0]));
  assertInvalid(duplicateChunk);

  const wrongSubsequence = clone(fixture.input);
  const normalAttemptIds = wrongSubsequence.checkpointFile.ledger.deliveries.map((row) => row.deliveryAttemptId);
  assert.equal(normalAttemptIds.length, 2);
  const first = wrongSubsequence.checkpointFile.deliveryAttemptOrder.indexOf(normalAttemptIds[0]);
  const second = wrongSubsequence.checkpointFile.deliveryAttemptOrder.indexOf(normalAttemptIds[1]);
  [wrongSubsequence.checkpointFile.deliveryAttemptOrder[first],
    wrongSubsequence.checkpointFile.deliveryAttemptOrder[second]] =
    [wrongSubsequence.checkpointFile.deliveryAttemptOrder[second],
      wrongSubsequence.checkpointFile.deliveryAttemptOrder[first]];
  assertInvalid(wrongSubsequence);
});

test('joint validation preserves a valid instruction grant and rejects grants on either new target', () => {
  const fixture = createQuestionCapsuleFilesFixture();
  const source = createQuestionCapsuleWholeValidationFixture();
  assert.ok(fixture.input.instructionStore.migrationAllowance);
  assert.ok(source.sourceGrants.questions);
  assert.ok(source.sourceGrants.checkpoint);
  const valid = validateQuestionCapsuleFiles(roundTripFiles(fixture.input));
  assert.deepEqual({ ...valid.snapshot.stores.instructions.migrationAllowance },
    fixture.input.instructionStore.migrationAllowance);

  for (const slot of ['questions', 'checkpoint']) {
    const invalid = clone(fixture.input);
    const target = slot === 'questions' ? invalid.questionFile : invalid.checkpointFile;
    target.migrationAllowance = clone(source.sourceGrants[slot]);
    assertInvalid(invalid);
  }
});

test('null files require null limits and the all-null representation passes the original whole validator', () => {
  const fixture = createQuestionCapsuleFilesFixture();
  const input = {
    anchor: clone(fixture.input.anchor),
    questionFile: null,
    checkpointFile: null,
    instructionStore: null,
    normalByteLimitsBySlot: { questions: null, checkpoint: null, instructions: null },
  };
  const wholeInput = {
    formatVersion: 1,
    anchor: input.anchor,
    ordinaryStores: { questions: null, checkpoint: null, instructions: null },
    capsulePairs: [],
    deliveryAttemptOrder: [],
    questionReservationOrder: [],
    normalByteLimitsBySlot: input.normalByteLimitsBySlot,
  };
  const expected = validateQuestionCapsuleWholeRepresentation(wholeInput);
  assert.deepEqual(validateQuestionCapsuleFiles(input), {
    snapshot: expected.snapshot,
    counts: expected.counts,
    scopeLimitations: SCOPE_LIMITATIONS,
  });

  const nonNullLimit = clone(input);
  nonNullLimit.normalByteLimitsBySlot.questions = MAX_SOURCE_BYTES;
  assertInvalid(nonNullLimit);
});

test('new encoded byte limits reject B-1 after the original whole capacity already fits', () => {
  const base = createQuestionCapsuleFilesFixture();
  const ordinary = allOrdinaryFiles(base.snapshot, base.input.normalByteLimitsBySlot);
  const expanded = addThresholdRows(base.snapshot, ordinary.wholeInput);
  const inputBase = allOrdinaryFiles(expanded.snapshot, base.input.normalByteLimitsBySlot).input;
  const wholeBase = expanded.wholeInput;
  const questionEncoded = encodeQuestionCapsuleJournalV3Local(inputBase.questionFile);
  const checkpointEncoded = encodeCapsuleCheckpointV4Local(inputBase.checkpointFile);
  const exactInput = {
    ...inputBase,
    questionFile: questionEncoded.value,
    checkpointFile: checkpointEncoded.value,
    normalByteLimitsBySlot: {
      ...inputBase.normalByteLimitsBySlot,
      questions: questionEncoded.sizeBytes,
      checkpoint: checkpointEncoded.sizeBytes,
    },
  };
  const legacyAtExact = {
    ...wholeBase,
    normalByteLimitsBySlot: exactInput.normalByteLimitsBySlot,
  };
  const exactLegacyResult = validateQuestionCapsuleWholeRepresentation(legacyAtExact);
  assert.deepEqual(validateQuestionCapsuleFiles(exactInput).snapshot, exactLegacyResult.snapshot);

  for (const slot of ['questions', 'checkpoint']) {
    const belowInput = clone(exactInput);
    belowInput.normalByteLimitsBySlot[slot] -= 1;
    const legacyBelow = {
      ...wholeBase,
      normalByteLimitsBySlot: belowInput.normalByteLimitsBySlot,
    };
    assert.doesNotThrow(() => validateQuestionCapsuleWholeRepresentation(legacyBelow));
    assertInvalid(belowInput);
  }
});

test('joint validation rejects getters and proxies before they run and returns mutable snapshot/count clones', () => {
  const fixture = createQuestionCapsuleFilesFixture();
  let getterCalls = 0;
  const getterInput = { ...fixture.input };
  Object.defineProperty(getterInput, 'anchor', {
    enumerable: true,
    get() { getterCalls += 1; return fixture.input.anchor; },
  });
  assertInvalid(getterInput);
  assert.equal(getterCalls, 0);

  for (const [field, value] of [
    ['input', fixture.input],
    ['questionFile', fixture.input.questionFile],
    ['anchor', fixture.input.anchor],
    ['instructionStore', fixture.input.instructionStore],
    ['normalByteLimitsBySlot', fixture.input.normalByteLimitsBySlot],
  ]) {
    const counter = { count: 0 };
    const invalid = field === 'input'
      ? proxyWithTrapCounter(value, counter)
      : { ...fixture.input, [field]: proxyWithTrapCounter(value, counter) };
    assertInvalid(invalid);
    assert.equal(counter.count, 0);
  }

  const input = roundTripFiles(fixture.input);
  const before = clone(input);
  const result = validateQuestionCapsuleFiles(input);
  assert.equal(JSON.stringify(input), JSON.stringify(before));
  assert.equal(Object.isFrozen(result), false);
  assert.equal(Object.isFrozen(result.snapshot), false);
  assert.equal(Object.isFrozen(result.counts), false);
  const originalText = input.questionFile.questions[0].questions[0].text;
  result.snapshot.stores.questions.questions[0].questions[0].text = 'changed-output';
  result.counts.questionReservations = 0;
  assert.equal(input.questionFile.questions[0].questions[0].text, originalText);
});
