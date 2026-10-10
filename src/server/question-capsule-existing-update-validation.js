'use strict';

const {
  captureFileRecord,
} = require('./question-capsule-file-primitives');
const {
  normalizeCapsuleCheckpointV4Local,
} = require('./question-capsule-checkpoint-codec');
const {
  normalizeQuestionCapsuleJournalV3Local,
} = require('./question-capsule-journal-codec');
const {
  measureCheckpointCapsuleExistingUpdateReservation,
  measureQuestionCapsuleExistingUpdateReservation,
} = require('./question-capsule-existing-update-capacity');
const { validateQuestionCapsuleFiles } = require('./question-capsule-files-validation');
const { validateReclamationStoreWrite } = require('./reclamation-store-consistency');

const INVALID_QUESTION_CAPSULE_EXISTING_UPDATE = 'invalid_question_capsule_existing_update';
const INPUT_FIELDS = ['anchor', 'previous', 'next', 'instructionStore', 'normalByteLimitsBySlot'];
const FILE_FIELDS = ['questionFile', 'checkpointFile'];
const LIMIT_FIELDS = ['questions', 'checkpoint', 'instructions'];
const QUESTION_DETAIL_MUTABLE_FIELDS = ['lateAnswers'];
const CHECKPOINT_DELIVERY_MUTABLE_FIELDS = [
  'state', 'cancelRequested', 'terminalAt', 'acceptedCorrelation', 'appliedCorrelation',
];
const SCOPE_LIMITATIONS = Object.freeze([
  'existing_update_structure_and_transition_only',
  'restricted_update_operations',
  'source_freshness_not_verified',
  'queue_exclusion_not_verified',
  'prepare_and_atomic_peak_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'new_question_admission_not_verified',
  'runtime_integration_not_verified',
]);

function requireValue(condition) {
  if (!condition) throw new TypeError(INVALID_QUESTION_CAPSULE_EXISTING_UPDATE);
}

function sameValue(left, right) {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  const leftArray = Array.isArray(left);
  if (leftArray !== Array.isArray(right)) return false;
  if (leftArray) {
    return left.length === right.length && left.every((value, index) => sameValue(value, right[index]));
  }
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) =>
    key === rightKeys[index] && sameValue(left[key], right[key]));
}

function sameExcept(left, right, omittedFields) {
  const omitted = new Set(omittedFields);
  const leftProjection = Object.create(null);
  const rightProjection = Object.create(null);
  for (const key of Object.keys(left)) {
    if (!omitted.has(key)) leftProjection[key] = left[key];
  }
  for (const key of Object.keys(right)) {
    if (!omitted.has(key)) rightProjection[key] = right[key];
  }
  return sameValue(leftProjection, rightProjection);
}

function hasNoReclamation(record) {
  return !Object.hasOwn(record, 'reclamation') || record.reclamation === null;
}

function normalizeFiles(files) {
  return {
    questionFile: files.questionFile === null
      ? null
      : normalizeQuestionCapsuleJournalV3Local(files.questionFile),
    checkpointFile: files.checkpointFile === null
      ? null
      : normalizeCapsuleCheckpointV4Local(files.checkpointFile),
  };
}

function assertQuestionRows(previousFile, nextFile, previousSnapshot) {
  if (previousFile === null) return;
  requireValue(previousFile.revision <= nextFile.revision &&
    sameExcept(previousFile, nextFile, ['revision', 'questions']));
  requireValue(previousFile.reservations.length === nextFile.reservations.length &&
    sameValue(previousFile.reservations, nextFile.reservations));
  requireValue(previousFile.questions.length === nextFile.questions.length);

  const reservationsById = new Map(previousSnapshot.stores.questions.reservations.map((reservation) =>
    [reservation.internalQuestionId, reservation]));
  for (let index = 0; index < previousFile.questions.length; index += 1) {
    const previous = previousFile.questions[index];
    const next = nextFile.questions[index];
    requireValue(previous.internalQuestionId === next.internalQuestionId);
    if (sameValue(previous, next)) continue;

    const reservation = reservationsById.get(previous.internalQuestionId);
    requireValue(sameExcept(previous, next, QUESTION_DETAIL_MUTABLE_FIELDS) &&
      previous.selection !== null && previous.quarantinedAt === null && reservation !== undefined &&
      reservation.quarantinedAt === null && reservation.reclamation === null &&
      reservation.bodyState === 'retained' && next.lateAnswers.length >= previous.lateAnswers.length);
    for (let answerIndex = 0; answerIndex < previous.lateAnswers.length; answerIndex += 1) {
      requireValue(sameValue(previous.lateAnswers[answerIndex], next.lateAnswers[answerIndex]));
    }
  }
}

function assertCheckpointRows(previousFile, nextFile) {
  if (previousFile === null) return;
  requireValue(previousFile.revision <= nextFile.revision &&
    sameExcept(previousFile, nextFile, ['revision', 'ledger']));
  requireValue(previousFile.ledger.revision <= nextFile.ledger.revision &&
    sameExcept(previousFile.ledger, nextFile.ledger, ['revision', 'deliveries']));
  requireValue(previousFile.ledger.deliveries.length === nextFile.ledger.deliveries.length);

  for (let index = 0; index < previousFile.ledger.deliveries.length; index += 1) {
    const previous = previousFile.ledger.deliveries[index];
    const next = nextFile.ledger.deliveries[index];
    requireValue(previous.deliveryAttemptId === next.deliveryAttemptId);
    if (sameValue(previous, next)) continue;
    requireValue(previous.kind !== 'question' && previous.recordType === 'detail' &&
      next.recordType === 'detail' && hasNoReclamation(previous) && hasNoReclamation(next) &&
      sameExcept(previous, next, CHECKPOINT_DELIVERY_MUTABLE_FIELDS));
  }
}

function assertStructureTransition(previousFiles, nextFiles, previousSnapshot) {
  const previousQuestion = previousFiles.questionFile;
  const nextQuestion = nextFiles.questionFile;
  const previousCheckpoint = previousFiles.checkpointFile;
  const nextCheckpoint = nextFiles.checkpointFile;
  requireValue((previousQuestion === null) === (nextQuestion === null) &&
    (previousCheckpoint === null) === (nextCheckpoint === null));
  assertQuestionRows(previousQuestion, nextQuestion, previousSnapshot);
  assertCheckpointRows(previousCheckpoint, nextCheckpoint);
}

function measureSlot(file, slot, byteLimit) {
  if (file === null) return null;
  if (slot === 'questions') {
    return measureQuestionCapsuleExistingUpdateReservation({
      questionFile: file,
      currentByteLimit: byteLimit,
    });
  }
  return measureCheckpointCapsuleExistingUpdateReservation({
    checkpointFile: file,
    currentByteLimit: byteLimit,
  });
}

function validateMeasuredSlot(beforeFile, afterFile, slot, byteLimit) {
  const before = measureSlot(beforeFile, slot, byteLimit);
  const after = measureSlot(afterFile, slot, byteLimit);
  if (before === null) {
    requireValue(after === null);
    return null;
  }
  requireValue(after !== null && before.fits && after.fits && after.currentBytes <= before.reservedBytes);
  return { before, after };
}

function validateInternal(value) {
  const input = captureFileRecord(value, INPUT_FIELDS, INVALID_QUESTION_CAPSULE_EXISTING_UPDATE);
  const previousInput = captureFileRecord(input.previous, FILE_FIELDS,
    INVALID_QUESTION_CAPSULE_EXISTING_UPDATE);
  const nextInput = captureFileRecord(input.next, FILE_FIELDS,
    INVALID_QUESTION_CAPSULE_EXISTING_UPDATE);
  const limits = captureFileRecord(input.normalByteLimitsBySlot, LIMIT_FIELDS,
    INVALID_QUESTION_CAPSULE_EXISTING_UPDATE);
  requireValue((previousInput.questionFile === null) === (nextInput.questionFile === null) &&
    (previousInput.checkpointFile === null) === (nextInput.checkpointFile === null));

  const previousResult = validateQuestionCapsuleFiles({
    anchor: input.anchor,
    questionFile: previousInput.questionFile,
    checkpointFile: previousInput.checkpointFile,
    instructionStore: input.instructionStore,
    normalByteLimitsBySlot: limits,
  });
  const nextResult = validateQuestionCapsuleFiles({
    anchor: input.anchor,
    questionFile: nextInput.questionFile,
    checkpointFile: nextInput.checkpointFile,
    instructionStore: input.instructionStore,
    normalByteLimitsBySlot: limits,
  });
  const previousFiles = normalizeFiles(previousInput);
  const nextFiles = normalizeFiles(nextInput);
  assertStructureTransition(previousFiles, nextFiles, previousResult.snapshot);
  requireValue(sameValue(previousResult.snapshot.anchor, nextResult.snapshot.anchor) &&
    sameValue(previousResult.snapshot.stores.instructions, nextResult.snapshot.stores.instructions));

  const transition = validateReclamationStoreWrite({
    anchor: previousResult.snapshot.anchor,
    previousStores: previousResult.snapshot.stores,
    nextStores: nextResult.snapshot.stores,
    normalByteLimitsBySlot: limits,
  });
  requireValue(transition.status === 'checked' && transition.reasons.length === 0 &&
    sameValue(transition.snapshot, nextResult.snapshot));

  const measurements = {
    questions: validateMeasuredSlot(previousFiles.questionFile, nextFiles.questionFile,
      'questions', limits.questions),
    checkpoint: validateMeasuredSlot(previousFiles.checkpointFile, nextFiles.checkpointFile,
      'checkpoint', limits.checkpoint),
  };
  return {
    previous: previousResult.snapshot,
    next: nextResult.snapshot,
    measurements,
    scopeLimitations: SCOPE_LIMITATIONS,
  };
}

function validateQuestionCapsuleExistingUpdate(value) {
  try {
    return validateInternal(value);
  } catch {
    throw new TypeError(INVALID_QUESTION_CAPSULE_EXISTING_UPDATE);
  }
}

module.exports = { validateQuestionCapsuleExistingUpdate };
