'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  expandQuestionDeliveryCapsule,
  expandQuestionRejectionCapsule,
} = require('../src/server/question-rejection-capsule-codec');
const {
  encodeCapsuleCheckpointV4Local,
} = require('../src/server/question-capsule-checkpoint-codec');
const {
  encodeCheckpointV3Local,
  normalizeCheckpointV3Local,
} = require('../src/server/delivery-reclamation-codec');
const { encodeQuestionCapsuleJournalV3Local } = require('../src/server/question-capsule-journal-codec');
const {
  encodeQuestionJournalV2Local,
  normalizeQuestionJournalV2Local,
} = require('../src/server/common-question-reclamation-codec');
const { orderFileRecords } = require('../src/server/question-capsule-file-primitives');
const {
  MAX_SOURCE_BYTES,
  measureCheckpointReservation,
  measureQuestionJournalReservationBytes,
} = require('../src/server/reclamation-capacity-bounds');
const {
  measureCheckpointCapsuleExistingUpdateReservation,
  measureQuestionCapsuleExistingUpdateReservation,
} = require('../src/server/question-capsule-existing-update-capacity');
const { selectionFor, sha256Json } = require('../src/server/common-question-kernel');
const { transitionDelivery } = require('../src/server/delivery-ledger');
const { makeDeliveryCapsule } = require('./helpers/question-rejection-capsule-fixtures');
const { createQuestionCapsuleFilesFixture } = require('./helpers/question-capsule-files-fixtures');
const { createReclaimedQuestionPairFixture } = require('./helpers/reclaimed-question-pair-fixtures');

const INVALID_QUESTION_CAPACITY = 'invalid_question_capsule_existing_update_capacity';
const INVALID_CHECKPOINT_CAPACITY = 'invalid_checkpoint_capsule_existing_update_capacity';
const SCOPE_LIMITATIONS = [
  'local_slot_capacity_only',
  'fixed_structure_existing_record_updates_only',
  'anchor_and_cross_store_consistency_not_verified',
  'new_admission_and_structural_changes_not_covered',
  'prepare_and_atomic_peak_not_verified',
  'persistence_recovery_not_verified',
  'runtime_integration_not_verified',
];
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const CHUNK_ID = 'b0000000-0000-4000-8000-000000000001';

function restoreQuestionJournal(file) {
  const expanded = file.questionCapsules.flatMap(({ capsule }) =>
    expandQuestionRejectionCapsule(capsule));
  const reservations = orderFileRecords(
    [...file.reservations, ...expanded],
    file.reservationOrder,
    'internalQuestionId',
    INVALID_QUESTION_CAPACITY,
  );
  return normalizeQuestionJournalV2Local({
    schemaVersion: 2,
    storeId: file.storeId,
    revision: file.revision,
    questions: file.questions,
    reservations,
    migrationAllowance: null,
  });
}

function restoreCheckpoint(file) {
  const expanded = file.checkpointCapsules.flatMap(({ capsule }) =>
    expandQuestionDeliveryCapsule(capsule));
  const deliveries = orderFileRecords(
    [...file.ledger.deliveries, ...expanded],
    file.deliveryAttemptOrder,
    'deliveryAttemptId',
    INVALID_CHECKPOINT_CAPACITY,
  );
  return normalizeCheckpointV3Local({
    schemaVersion: 3,
    storeId: file.storeId,
    revision: file.revision,
    registrations: file.registrations,
    ledger: {
      schemaVersion: 2,
      revision: file.ledger.revision,
      deliveries,
      notificationTargets: file.ledger.notificationTargets,
      logicalTombstones: file.ledger.logicalTombstones,
    },
    migrationAllowance: null,
  });
}

function legacyQuestionMeasurement(snapshot, currentByteLimit = MAX_SOURCE_BYTES) {
  return measureQuestionJournalReservationBytes({ snapshot, currentByteLimit });
}

function legacyCheckpointMeasurement(snapshot, currentByteLimit = MAX_SOURCE_BYTES) {
  return measureCheckpointReservation({ snapshot, currentByteLimit });
}

function withoutQuestionCapsules(file) {
  const oldSnapshot = restoreQuestionJournal(file);
  return encodeQuestionCapsuleJournalV3Local({
    schemaVersion: 3,
    storeId: oldSnapshot.storeId,
    revision: oldSnapshot.revision,
    questions: oldSnapshot.questions,
    reservations: oldSnapshot.reservations,
    migrationAllowance: null,
    questionCapsules: [],
    reservationOrder: oldSnapshot.reservations.map((row) => row.internalQuestionId),
  }).value;
}

function withoutCheckpointCapsules(file) {
  const oldSnapshot = restoreCheckpoint(file);
  return encodeCapsuleCheckpointV4Local({
    schemaVersion: 4,
    storeId: oldSnapshot.storeId,
    revision: oldSnapshot.revision,
    registrations: oldSnapshot.registrations,
    ledger: oldSnapshot.ledger,
    migrationAllowance: null,
    checkpointCapsules: [],
    deliveryAttemptOrder: oldSnapshot.ledger.deliveries.map((row) => row.deliveryAttemptId),
  }).value;
}

function questionOptions(file) {
  const snapshot = restoreQuestionJournal(file);
  const encoded = encodeQuestionJournalV2Local(snapshot);
  const oldCapacity = legacyQuestionMeasurement(snapshot);
  const result = measureQuestionCapsuleExistingUpdateReservation({
    questionFile: file,
    currentByteLimit: MAX_SOURCE_BYTES,
  });
  assert.equal(result.currentBytes, encodeQuestionCapsuleJournalV3Local(file).sizeBytes);
  assert.equal(result.restoredCurrentBytes, encoded.sizeBytes);
  assert.equal(result.restoredReservedBytes, oldCapacity.reservedBytes);
  assert.equal(result.existingUpdateGrowthBytes, oldCapacity.reservedBytes - oldCapacity.currentBytes);
  assert.equal(result.reservedBytes, result.currentBytes + result.existingUpdateGrowthBytes);
  assert.equal(result.currentByteLimit, MAX_SOURCE_BYTES);
  assert.equal(result.fits, result.reservedBytes <= MAX_SOURCE_BYTES);
  assert.deepStrictEqual(result.scopeLimitations, SCOPE_LIMITATIONS);
  assert.equal(Object.isFrozen(result.scopeLimitations), true);
  assert.equal(Object.isFrozen(result), false);
  return { result, snapshot, oldCapacity };
}

function checkpointOptions(file) {
  const snapshot = restoreCheckpoint(file);
  const encoded = encodeCheckpointV3Local(snapshot);
  const oldCapacity = legacyCheckpointMeasurement(snapshot);
  const result = measureCheckpointCapsuleExistingUpdateReservation({
    checkpointFile: file,
    currentByteLimit: MAX_SOURCE_BYTES,
  });
  assert.equal(result.currentBytes, encodeCapsuleCheckpointV4Local(file).sizeBytes);
  assert.equal(result.restoredCurrentBytes, encoded.sizeBytes);
  assert.equal(result.restoredReservedBytes, oldCapacity.reservedBytes);
  assert.equal(result.existingUpdateGrowthBytes, oldCapacity.reservedBytes - oldCapacity.currentBytes);
  assert.equal(result.reservedBytes, result.currentBytes + result.existingUpdateGrowthBytes);
  assert.equal(result.currentByteLimit, MAX_SOURCE_BYTES);
  assert.equal(result.fits, result.reservedBytes <= MAX_SOURCE_BYTES);
  assert.deepStrictEqual(result.scopeLimitations, SCOPE_LIMITATIONS);
  assert.equal(Object.isFrozen(result.scopeLimitations), true);
  assert.equal(Object.isFrozen(result), false);
  return { result, snapshot, oldCapacity };
}

function questionFixtureCases() {
  return [
    { name: 'Claude', options: { provider: 'claude' } },
    { name: 'Codex', options: { provider: 'codex' } },
    { name: 'Claude/Codex mixed periods', options: { provider: 'claude', secondaryProvider: 'codex' } },
    { name: 'Codex/Claude mixed periods', options: { provider: 'codex', secondaryProvider: 'claude' } },
  ];
}

test('legacy Q2 and CP3 restoration matches independent whole snapshots with and without capsules', () => {
  for (const { name, options } of questionFixtureCases()) {
    const fixture = createQuestionCapsuleFilesFixture(options);
    const questions = questionOptions(fixture.questionFile);
    const checkpoint = checkpointOptions(fixture.checkpointFile);
    assert.deepStrictEqual(questions.snapshot, fixture.snapshot.stores.questions, name);
    assert.deepStrictEqual(checkpoint.snapshot, fixture.snapshot.stores.checkpoint, name);

    const plainQuestionFile = withoutQuestionCapsules(fixture.questionFile);
    const plainCheckpointFile = withoutCheckpointCapsules(fixture.checkpointFile);
    const plainQuestions = questionOptions(plainQuestionFile);
    const plainCheckpoint = checkpointOptions(plainCheckpointFile);
    assert.deepStrictEqual(plainQuestions.snapshot, fixture.snapshot.stores.questions, `${name}: Q without capsules`);
    assert.deepStrictEqual(plainCheckpoint.snapshot, fixture.snapshot.stores.checkpoint,
      `${name}: CP without capsules`);
  }
});

test('checkpoint capsule measurement supports shared and distinct reference dictionaries', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'claude' });
  const sharedFile = structuredClone(fixture.checkpointFile);
  const originalCapsules = sharedFile.checkpointCapsules;
  const metadataCapsule = originalCapsules[0].capsule;
  const allDeliveries = originalCapsules.flatMap(({ capsule }) => expandQuestionDeliveryCapsule(capsule));
  const merged = makeDeliveryCapsule(allDeliveries, {
    storeId: sharedFile.storeId,
    identity: metadataCapsule.identity,
    periodId: metadataCapsule.periodId,
    compactionOperationId: metadataCapsule.compactionOperationId,
  });
  sharedFile.checkpointCapsules = [{ chunkId: originalCapsules[0].chunkId, capsule: merged }];
  assert.equal(merged.deliveries.length, allDeliveries.length);
  assert.equal(merged.references.sources.length, 1);
  assert.equal(merged.references.targets.length, 1);
  assert.deepStrictEqual(checkpointOptions(sharedFile).snapshot, fixture.snapshot.stores.checkpoint);

  const distinctFixture = createQuestionCapsuleFilesFixture({ ordinaryQuestionSelected: true });
  const distinctFile = structuredClone(distinctFixture.checkpointFile);
  const distinctWrapper = distinctFile.checkpointCapsules[1];
  const distinctDelivery = expandQuestionDeliveryCapsule(distinctWrapper.capsule)[0];
  const alternateLaunch = distinctFile.registrations.launches.find((launch) =>
    launch.launchRef === 'launch-3');
  assert.ok(alternateLaunch);
  const launchKey = [alternateLaunch.claims.launchId, alternateLaunch.claims.runId,
    alternateLaunch.claims.attemptId];
  const claimsDigest = sha256Json(alternateLaunch.claims);
  const identity = alternateLaunch.identity;
  const periodId = alternateLaunch.executionBinding.periodId;
  const referenceRow = {
    ...distinctDelivery,
    sourceExecutionId: periodId,
    sourceRef: {
      launchRef: alternateLaunch.launchRef,
      launchKey,
      sourceClaimsDigest: claimsDigest,
      identity,
      executionBinding: alternateLaunch.executionBinding,
      conversationId: alternateLaunch.conversationId,
      sessionId: alternateLaunch.sessionId,
    },
    targetRef: {
      kind: 'execution',
      launchRef: alternateLaunch.launchRef,
      launchKey,
      targetClaimsDigest: claimsDigest,
      identity,
      periodId,
      actor: alternateLaunch.executionBinding.actor,
      conversationId: alternateLaunch.conversationId,
      sessionId: alternateLaunch.sessionId,
    },
  };
  const tombstone = distinctFile.ledger.logicalTombstones.find((row) =>
    row.kind === referenceRow.kind && row.logicalMessageId === referenceRow.logicalMessageId &&
    row.revision === referenceRow.revision);
  assert.ok(tombstone);
  tombstone.sourceExecutionId = periodId;
  tombstone.sourceLaunchKey = launchKey;
  const capsule = makeDeliveryCapsule([referenceRow], {
    storeId: distinctFile.storeId,
    identity,
    periodId,
    compactionOperationId: distinctWrapper.capsule.compactionOperationId,
  });
  distinctWrapper.capsule = capsule;
  const distinctReferenceKeys = new Set(distinctFile.checkpointCapsules.map(({ capsule: item }) =>
    JSON.stringify([item.references.sources[0], item.references.targets[0]])));
  assert.ok(distinctReferenceKeys.size > 1);
  const restoredWithDistinctRefs = checkpointOptions(distinctFile).snapshot;
  assert.equal(restoredWithDistinctRefs.ledger.deliveries.find((row) =>
    row.deliveryAttemptId === referenceRow.deliveryAttemptId).sourceExecutionId, periodId);
});

test('applied native correlation survives capsule restoration and capacity measurement', () => {
  const fixture = createReclaimedQuestionPairFixture({ provider: 'codex', state: 'applied' });
  assert.ok(fixture.delivery?.appliedCorrelation?.nativeItemId);
  const checkpoint = structuredClone(fixture.snapshot.stores.checkpoint);
  checkpoint.migrationAllowance = null;
  const oldSnapshot = normalizeCheckpointV3Local(checkpoint);
  const delivery = oldSnapshot.ledger.deliveries.find((row) =>
    row.deliveryAttemptId === fixture.delivery.deliveryAttemptId);
  const capsule = makeDeliveryCapsule([delivery], {
    storeId: oldSnapshot.storeId,
    identity: delivery.targetRef.identity,
    periodId: delivery.targetRef.periodId,
  });
  const checkpointFile = {
    schemaVersion: 4,
    storeId: oldSnapshot.storeId,
    revision: oldSnapshot.revision,
    registrations: oldSnapshot.registrations,
    ledger: {
      ...oldSnapshot.ledger,
      deliveries: oldSnapshot.ledger.deliveries.filter((row) =>
        row.deliveryAttemptId !== delivery.deliveryAttemptId),
    },
    migrationAllowance: null,
    checkpointCapsules: [{ chunkId: CHUNK_ID, capsule }],
    deliveryAttemptOrder: oldSnapshot.ledger.deliveries.map((row) => row.deliveryAttemptId),
  };
  const restored = restoreCheckpoint(checkpointFile);
  assert.deepStrictEqual(restored, oldSnapshot);
  assert.equal(restored.ledger.deliveries.find((row) =>
    row.deliveryAttemptId === delivery.deliveryAttemptId).appliedCorrelation.nativeItemId,
  delivery.appliedCorrelation.nativeItemId);
  const result = measureCheckpointCapsuleExistingUpdateReservation({
    checkpointFile,
    currentByteLimit: MAX_SOURCE_BYTES,
  });
  assert.equal(result.currentBytes, encodeCapsuleCheckpointV4Local(checkpointFile).sizeBytes);
});

test('ordinary legal question and delivery updates remain within their fixed-structure reservations', () => {
  const fixture = createQuestionCapsuleFilesFixture({ ordinaryQuestionSelected: true });
  const originalQuestionFile = structuredClone(fixture.questionFile);
  const question = originalQuestionFile.questions[0];
  const selectedOptionId = question.selection.answers[0].optionIds[0];
  const commonQuestion = { ...question };
  delete commonQuestion.deliveryCreationState;
  delete commonQuestion.quarantinedAt;
  const late = selectionFor(commonQuestion, [{
    questionId: question.questions[0].id,
    optionIds: [selectedOptionId],
    freeText: '\uD800'.repeat(2_000),
  }], 'manual', MAX_SAFE_INTEGER, 'capacity-late-answer').record;
  assert.equal(late.lateAnswers.length, question.lateAnswers.length + 1);
  originalQuestionFile.questions[0] = { ...question, lateAnswers: late.lateAnswers };
  originalQuestionFile.revision += 1;
  const questionReservation = measureQuestionCapsuleExistingUpdateReservation({
    questionFile: fixture.questionFile,
    currentByteLimit: MAX_SOURCE_BYTES,
  });
  const updatedQuestionBytes = encodeQuestionCapsuleJournalV3Local(originalQuestionFile).sizeBytes;
  assert.ok(updatedQuestionBytes <= questionReservation.reservedBytes);

  const checkpointFile = structuredClone(fixture.checkpointFile);
  const checkpointSnapshot = restoreCheckpoint(checkpointFile);
  const delivery = checkpointSnapshot.ledger.deliveries.find((row) => row.kind === 'instruction');
  assert.ok(delivery);
  const rawDelivery = {
    deliveryAttemptId: delivery.deliveryAttemptId,
    kind: delivery.kind,
    logicalMessageId: delivery.logicalMessageId,
    revision: delivery.revision,
    sourceExecutionId: delivery.sourceExecutionId,
    source: delivery.source,
    target: delivery.target,
    ownerGeneration: delivery.ownerGeneration,
    payloadDigest: delivery.payloadDigest,
    state: delivery.state,
    cancelRequested: delivery.cancelRequested,
    acceptedCorrelation: delivery.acceptedCorrelation,
    appliedCorrelation: delivery.appliedCorrelation,
  };
  const transitionableLedger = {
    schemaVersion: 1,
    revision: 0,
    deliveries: [rawDelivery],
    notificationTargets: [],
    logicalTombstones: [{
      kind: delivery.kind,
      sourceExecutionId: delivery.sourceExecutionId,
      logicalMessageId: delivery.logicalMessageId,
      revision: delivery.revision,
      targetLaunchKey: null,
      sourceLaunchKey: [delivery.source.claims.launchId, delivery.source.claims.runId,
        delivery.source.claims.attemptId],
      payloadDigest: delivery.payloadDigest,
    }],
  };
  const started = transitionDelivery(transitionableLedger, delivery.deliveryAttemptId, 'sendStart');
  const escapedIdentifier = '\uD800'.repeat(512);
  const applied = transitionDelivery(started.ledger, delivery.deliveryAttemptId, 'applied', {
    deliveryAttemptId: delivery.deliveryAttemptId,
    revision: delivery.revision,
    payloadDigest: delivery.payloadDigest,
    targetPeriodId: delivery.target.periodId,
    nativeTurnId: escapedIdentifier,
    nativeItemId: escapedIdentifier,
    clientRequestId: delivery.deliveryAttemptId,
  });
  const updatedDelivery = { ...delivery, ...applied.delivery };
  updatedDelivery.terminalAt = MAX_SAFE_INTEGER;
  assert.equal(updatedDelivery.appliedCorrelation.nativeItemId.length, escapedIdentifier.length);
  checkpointFile.ledger.deliveries = checkpointFile.ledger.deliveries.map((row) =>
    row.deliveryAttemptId === delivery.deliveryAttemptId ? updatedDelivery : row);
  checkpointFile.ledger.revision += 2;
  checkpointFile.revision += 2;
  const checkpointReservation = measureCheckpointCapsuleExistingUpdateReservation({
    checkpointFile: fixture.checkpointFile,
    currentByteLimit: MAX_SOURCE_BYTES,
  });
  const updatedCheckpointBytes = encodeCapsuleCheckpointV4Local(checkpointFile).sizeBytes;
  assert.ok(updatedCheckpointBytes <= checkpointReservation.reservedBytes);
});

test('maximum legacy revisions are measured without overflow', () => {
  const fixture = createQuestionCapsuleFilesFixture({});
  const baselineQuestion = questionOptions(fixture.questionFile).result;
  const baselineCheckpoint = checkpointOptions(fixture.checkpointFile).result;
  const maxQuestion = structuredClone(fixture.questionFile);
  maxQuestion.revision = MAX_SAFE_INTEGER;
  const question = questionOptions(maxQuestion);
  assert.equal(question.oldCapacity.revisionGrowthBytes, 0);
  assert.ok(encodeQuestionCapsuleJournalV3Local(maxQuestion).sizeBytes <= baselineQuestion.reservedBytes);

  const maxCheckpointRoot = structuredClone(fixture.checkpointFile);
  maxCheckpointRoot.revision = MAX_SAFE_INTEGER;
  const root = checkpointOptions(maxCheckpointRoot);
  assert.ok(root.oldCapacity.revisionGrowthBytes > 0);
  assert.ok(encodeCapsuleCheckpointV4Local(maxCheckpointRoot).sizeBytes <= baselineCheckpoint.reservedBytes);

  const maxCheckpointLedger = structuredClone(fixture.checkpointFile);
  maxCheckpointLedger.ledger.revision = MAX_SAFE_INTEGER;
  const ledger = checkpointOptions(maxCheckpointLedger);
  assert.ok(ledger.oldCapacity.revisionGrowthBytes > 0);
  assert.ok(encodeCapsuleCheckpointV4Local(maxCheckpointLedger).sizeBytes <= baselineCheckpoint.reservedBytes);

  const bothCheckpointRevisions = structuredClone(fixture.checkpointFile);
  bothCheckpointRevisions.revision = MAX_SAFE_INTEGER;
  bothCheckpointRevisions.ledger.revision = MAX_SAFE_INTEGER;
  assert.equal(checkpointOptions(bothCheckpointRevisions).oldCapacity.revisionGrowthBytes, 0);
  assert.ok(encodeCapsuleCheckpointV4Local(bothCheckpointRevisions).sizeBytes <= baselineCheckpoint.reservedBytes);
});

test('old capacity may fit while the capsule file fits now but its reservation exceeds the limit', () => {
  const fixture = createQuestionCapsuleFilesFixture({ ordinaryQuestionSelected: true });
  const questionSnapshot = restoreQuestionJournal(fixture.questionFile);
  const oldQuestion = legacyQuestionMeasurement(questionSnapshot);
  const oldQuestionAtLimit = legacyQuestionMeasurement(questionSnapshot, oldQuestion.reservedBytes);
  const questionResult = measureQuestionCapsuleExistingUpdateReservation({
    questionFile: fixture.questionFile,
    currentByteLimit: oldQuestion.reservedBytes,
  });
  assert.equal(oldQuestionAtLimit.fits, true);
  assert.ok(oldQuestionAtLimit.currentBytes <= oldQuestion.reservedBytes);
  assert.ok(oldQuestionAtLimit.reservedBytes <= oldQuestion.reservedBytes);
  assert.ok(questionResult.currentBytes <= oldQuestion.reservedBytes);
  assert.ok(oldQuestion.reservedBytes < questionResult.reservedBytes);
  assert.equal(questionResult.fits, false);

  const checkpointSnapshot = restoreCheckpoint(fixture.checkpointFile);
  const oldCheckpoint = legacyCheckpointMeasurement(checkpointSnapshot);
  const oldCheckpointAtLimit = legacyCheckpointMeasurement(checkpointSnapshot, oldCheckpoint.reservedBytes);
  const checkpointResult = measureCheckpointCapsuleExistingUpdateReservation({
    checkpointFile: fixture.checkpointFile,
    currentByteLimit: oldCheckpoint.reservedBytes,
  });
  assert.equal(oldCheckpointAtLimit.fits, true);
  assert.ok(oldCheckpointAtLimit.currentBytes <= oldCheckpoint.reservedBytes);
  assert.ok(oldCheckpointAtLimit.reservedBytes <= oldCheckpoint.reservedBytes);
  assert.ok(checkpointResult.currentBytes <= oldCheckpoint.reservedBytes);
  assert.ok(oldCheckpoint.reservedBytes < checkpointResult.reservedBytes);
  assert.equal(checkpointResult.fits, false);
});

test('invalid top-level getters and nested proxies are rejected without invoking traps', () => {
  const fixture = createQuestionCapsuleFilesFixture({});
  let questionGetterCalls = 0;
  const getterInput = {
    currentByteLimit: MAX_SOURCE_BYTES,
  };
  Object.defineProperty(getterInput, 'questionFile', {
    enumerable: true,
    configurable: true,
    get() {
      questionGetterCalls += 1;
      return fixture.questionFile;
    },
  });
  assert.throws(() => measureQuestionCapsuleExistingUpdateReservation(getterInput),
    { name: 'TypeError', message: INVALID_QUESTION_CAPACITY });
  assert.equal(questionGetterCalls, 0);

  let questionProxyTraps = 0;
  const proxiedQuestionFile = new Proxy(fixture.questionFile, {
    ownKeys() {
      questionProxyTraps += 1;
      throw new Error('unexpected trap');
    },
  });
  assert.throws(() => measureQuestionCapsuleExistingUpdateReservation({
    questionFile: proxiedQuestionFile,
    currentByteLimit: MAX_SOURCE_BYTES,
  }), { name: 'TypeError', message: INVALID_QUESTION_CAPACITY });
  assert.equal(questionProxyTraps, 0);

  let checkpointProxyTraps = 0;
  const proxiedCheckpointFile = new Proxy(fixture.checkpointFile, {
    ownKeys() {
      checkpointProxyTraps += 1;
      throw new Error('unexpected trap');
    },
  });
  assert.throws(() => measureCheckpointCapsuleExistingUpdateReservation({
    checkpointFile: proxiedCheckpointFile,
    currentByteLimit: MAX_SOURCE_BYTES,
  }), { name: 'TypeError', message: INVALID_CHECKPOINT_CAPACITY });
  assert.equal(checkpointProxyTraps, 0);
});

test('measurement does not mutate either capsule file', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'codex', secondaryProvider: 'claude' });
  const questionBefore = structuredClone(fixture.questionFile);
  const checkpointBefore = structuredClone(fixture.checkpointFile);
  questionOptions(fixture.questionFile);
  checkpointOptions(fixture.checkpointFile);
  assert.deepStrictEqual(fixture.questionFile, questionBefore);
  assert.deepStrictEqual(fixture.checkpointFile, checkpointBefore);
});

test('malformed limits and capsule values use fixed public error codes', () => {
  const fixture = createQuestionCapsuleFilesFixture({});
  assert.throws(() => measureQuestionCapsuleExistingUpdateReservation({
    questionFile: fixture.questionFile,
    currentByteLimit: 0,
  }), { name: 'TypeError', message: INVALID_QUESTION_CAPACITY });
  assert.throws(() => measureCheckpointCapsuleExistingUpdateReservation({
    checkpointFile: fixture.checkpointFile,
    currentByteLimit: NaN,
  }), { name: 'TypeError', message: INVALID_CHECKPOINT_CAPACITY });

  const invalidQuestion = structuredClone(fixture.questionFile);
  invalidQuestion.schemaVersion = 2;
  assert.throws(() => measureQuestionCapsuleExistingUpdateReservation({
    questionFile: invalidQuestion,
    currentByteLimit: MAX_SOURCE_BYTES,
  }), { name: 'TypeError', message: INVALID_QUESTION_CAPACITY });
  const invalidCheckpoint = structuredClone(fixture.checkpointFile);
  invalidCheckpoint.schemaVersion = 3;
  assert.throws(() => measureCheckpointCapsuleExistingUpdateReservation({
    checkpointFile: invalidCheckpoint,
    currentByteLimit: MAX_SOURCE_BYTES,
  }), { name: 'TypeError', message: INVALID_CHECKPOINT_CAPACITY });
});
