'use strict';

const {
  assertSafeUnsignedInteger,
  checkedAddBytes,
} = require('./reclamation-codec-primitives');
const { orderFileRecords, captureFileRecord } = require('./question-capsule-file-primitives');
const {
  expandQuestionDeliveryCapsule,
  expandQuestionRejectionCapsule,
} = require('./question-rejection-capsule-codec');
const { encodeCapsuleCheckpointV4Local } = require('./question-capsule-checkpoint-codec');
const { encodeQuestionCapsuleJournalV3Local } = require('./question-capsule-journal-codec');
const { normalizeCheckpointV3Local } = require('./delivery-reclamation-codec');
const { normalizeQuestionJournalV2Local } = require('./common-question-reclamation-codec');
const {
  MAX_SOURCE_BYTES,
  measureCheckpointReservation,
  measureQuestionJournalReservationBytes,
} = require('./reclamation-capacity-bounds');

const INVALID_QUESTION_CAPACITY = 'invalid_question_capsule_existing_update_capacity';
const INVALID_CHECKPOINT_CAPACITY = 'invalid_checkpoint_capsule_existing_update_capacity';
const SCOPE_LIMITATIONS = Object.freeze([
  'local_slot_capacity_only',
  'fixed_structure_existing_record_updates_only',
  'anchor_and_cross_store_consistency_not_verified',
  'new_admission_and_structural_changes_not_covered',
  'prepare_and_atomic_peak_not_verified',
  'persistence_recovery_not_verified',
  'runtime_integration_not_verified',
]);

function requireValue(condition, errorCode) {
  if (!condition) throw new TypeError(errorCode);
}

function measureExistingUpdate(inputValue, fileField, errorCode, encodeFile, restoreFile, measureOld) {
  const input = captureFileRecord(inputValue, [fileField, 'currentByteLimit'], errorCode);
  assertSafeUnsignedInteger(input.currentByteLimit, errorCode);
  requireValue(input.currentByteLimit > 0 && input.currentByteLimit <= MAX_SOURCE_BYTES, errorCode);

  const encoded = encodeFile(input[fileField]);
  const restoredSnapshot = restoreFile(encoded.value, errorCode);
  const oldMeasurement = measureOld(restoredSnapshot, input.currentByteLimit);
  const restoredCurrentBytes = oldMeasurement.currentBytes;
  const restoredReservedBytes = oldMeasurement.reservedBytes;
  requireValue(Number.isSafeInteger(restoredCurrentBytes) && restoredCurrentBytes >= 0 &&
    Number.isSafeInteger(restoredReservedBytes) && restoredReservedBytes >= restoredCurrentBytes, errorCode);
  const existingUpdateGrowthBytes = restoredReservedBytes - restoredCurrentBytes;
  const reservedBytes = checkedAddBytes(encoded.sizeBytes, existingUpdateGrowthBytes);

  return {
    currentBytes: encoded.sizeBytes,
    restoredCurrentBytes,
    restoredReservedBytes,
    existingUpdateGrowthBytes,
    reservedBytes,
    currentByteLimit: input.currentByteLimit,
    fits: reservedBytes <= input.currentByteLimit,
    scopeLimitations: SCOPE_LIMITATIONS,
  };
}

function restoreQuestionJournal(file, errorCode) {
  const capsuleReservations = file.questionCapsules.flatMap(({ capsule }) =>
    expandQuestionRejectionCapsule(capsule));
  const reservations = orderFileRecords(
    [...file.reservations, ...capsuleReservations],
    file.reservationOrder,
    'internalQuestionId',
    errorCode,
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

function restoreCheckpoint(file, errorCode) {
  const capsuleDeliveries = file.checkpointCapsules.flatMap(({ capsule }) =>
    expandQuestionDeliveryCapsule(capsule));
  const deliveries = orderFileRecords(
    [...file.ledger.deliveries, ...capsuleDeliveries],
    file.deliveryAttemptOrder,
    'deliveryAttemptId',
    errorCode,
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

function withUnifiedError(operation, errorCode) {
  try {
    return operation();
  } catch {
    throw new TypeError(errorCode);
  }
}

/** `fits` は既存質問fileの局所容量だけを示し、保存や件数解放を許可しない。 */
function measureQuestionCapsuleExistingUpdateReservation(inputValue) {
  return withUnifiedError(() => measureExistingUpdate(
    inputValue,
    'questionFile',
    INVALID_QUESTION_CAPACITY,
    encodeQuestionCapsuleJournalV3Local,
    restoreQuestionJournal,
    (snapshot, currentByteLimit) => measureQuestionJournalReservationBytes({ snapshot, currentByteLimit }),
  ), INVALID_QUESTION_CAPACITY);
}

/** `fits` は既存checkpoint fileの局所容量だけを示し、保存や件数解放を許可しない。 */
function measureCheckpointCapsuleExistingUpdateReservation(inputValue) {
  return withUnifiedError(() => measureExistingUpdate(
    inputValue,
    'checkpointFile',
    INVALID_CHECKPOINT_CAPACITY,
    encodeCapsuleCheckpointV4Local,
    restoreCheckpoint,
    (snapshot, currentByteLimit) => measureCheckpointReservation({ snapshot, currentByteLimit }),
  ), INVALID_CHECKPOINT_CAPACITY);
}

module.exports = {
  measureCheckpointCapsuleExistingUpdateReservation,
  measureQuestionCapsuleExistingUpdateReservation,
};
