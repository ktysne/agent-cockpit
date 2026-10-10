'use strict';

const { types } = require('node:util');
const {
  checkedCapacityAdd,
  checkedCapacitySum,
} = require('./reclamation-capacity-bounds');
const { assertSafeUnsignedInteger } = require('./reclamation-codec-primitives');
const { captureFileRecord } = require('./question-capsule-file-primitives');
const {
  decodeQuestionCapsulePreparedMaterial,
  encodeQuestionCapsulePreparedMaterial,
  validateQuestionCapsulePreparedMaterial,
} = require('./question-capsule-prepared-material-codec');
const {
  decodeQuestionCapsuleJournalV3Local,
  encodeQuestionCapsuleJournalV3Local,
} = require('./question-capsule-journal-codec');
const {
  decodeCapsuleCheckpointV4Local,
  encodeCapsuleCheckpointV4Local,
} = require('./question-capsule-checkpoint-codec');
const {
  measureCheckpointCapsuleExistingUpdateReservation,
  measureQuestionCapsuleExistingUpdateReservation,
} = require('./question-capsule-existing-update-capacity');
const {
  normalizeQuestionJournalV2Local,
} = require('./common-question-reclamation-codec');
const {
  normalizeCheckpointV3Local,
  normalizeInstructionJournalV2Local,
} = require('./delivery-reclamation-codec');
const { normalizeQuestionReclamationAnchorV1Local } = require('./question-reclamation-anchor-codec');
const {
  FIXED_H_BOUNDS,
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
  measureCheckpointReservation,
  measureInstructionReservation,
  measurePendingQuestionPeriodCapacity,
  measureQuestionJournalReservationBytes,
} = require('./reclamation-capacity-bounds');
const { decodeSourceBytes } = require('./reclamation-json-codec');

const INVALID_CAPACITY = 'invalid_question_capsule_migration_capacity';
const INPUT_FIELDS = ['materialBytes', 'anchorBytes', 'instructionBytes', 'expectedNormalByteLimitsBySlot'];
const LIMIT_FIELDS = ['questions', 'checkpoint', 'instructions'];
const BYTE_SLOTS = ['anchor', 'instructions', 'questions', 'checkpoint'];
const INSTRUCTION_RAW_MAX_BYTES = checkedCapacityAdd(MAX_SOURCE_BYTES, FIXED_H_BOUNDS.instructions);
const PROTOCOL_ASSUMPTIONS = Object.freeze([
  'all_writers_stopped',
  'original_anchor_and_instruction_bytes_unchanged',
  'one_operation_at_a_time',
  'single_atomic_temp_at_a_time',
  'no_unknown_orphan_or_backup_files',
  'prepared_material_immutable_until_complete',
  'old_and_target_future_reservations_retained_until_complete',
]);
const SCOPE_LIMITATIONS = Object.freeze([
  'restricted_capacity_assessment_only',
  'configuration_provenance_not_verified',
  'source_freshness_and_writer_exclusion_not_verified',
  'persistent_grant_protocol_not_applied',
  'additional_operation_lease_accounting_not_verified',
  'orphan_and_external_files_not_counted',
  'filesystem_allocation_and_os_durability_not_verified',
  'atomic_write_and_readback_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'runtime_integration_not_verified',
]);

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getTypedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const getTypedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const getTypedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;

function requireValue(condition) {
  if (!condition) throw new TypeError(INVALID_CAPACITY);
}

function copyRawBytes(value, maximumBytes, nullable = false) {
  if (value === null) {
    requireValue(nullable);
    return null;
  }
  requireValue(value !== null && typeof value === 'object' && !types.isProxy(value) &&
    types.isUint8Array(value));

  let buffer;
  let byteOffset;
  let byteLength;
  try {
    buffer = getTypedArrayBuffer.call(value);
    byteOffset = getTypedArrayByteOffset.call(value);
    byteLength = getTypedArrayByteLength.call(value);
  } catch {
    throw new TypeError(INVALID_CAPACITY);
  }
  requireValue(types.isArrayBuffer(buffer) && !types.isSharedArrayBuffer(buffer) &&
    Number.isSafeInteger(byteOffset) && byteOffset >= 0 &&
    Number.isSafeInteger(byteLength) && byteLength > 0 && byteLength <= maximumBytes &&
    Number.isSafeInteger(byteOffset + byteLength));

  let source;
  try {
    source = new Uint8Array(buffer, byteOffset, byteLength);
  } catch {
    throw new TypeError(INVALID_CAPACITY);
  }
  const copied = Buffer.alloc(byteLength);
  for (let index = 0; index < byteLength; index += 1) copied[index] = source[index];
  return copied;
}

function normalizeLimits(value) {
  const limits = captureFileRecord(value, LIMIT_FIELDS, INVALID_CAPACITY);
  for (const slot of LIMIT_FIELDS) {
    const limit = limits[slot];
    if (limit === null) continue;
    assertSafeUnsignedInteger(limit, INVALID_CAPACITY);
    requireValue(limit > 0 && limit <= MAX_SOURCE_BYTES);
  }
  return limits;
}

function parseSourceBuffer(bytes, maximumBytes) {
  return decodeSourceBytes(bytes, maximumBytes).value;
}

function parseEmbeddedBytes(base64, maximumBytes) {
  requireValue(typeof base64 === 'string');
  const bytes = Buffer.from(base64, 'base64');
  requireValue(bytes.length > 0 && bytes.length <= maximumBytes);
  return bytes;
}

function copySlotBytes(current, future) {
  return Math.max(current, future);
}

function protectedBeforeComplete(current, oldFuture, targetFuture) {
  return Math.max(current, oldFuture, targetFuture);
}

function makeBoundary(currentBytesBySlot, protectedBytesBySlot) {
  return {
    currentBytesBySlot,
    currentTotalBytes: checkedCapacitySum(BYTE_SLOTS.map((slot) => currentBytesBySlot[slot])),
    protectedBytesBySlot,
    protectedTotalBytes: checkedCapacitySum(BYTE_SLOTS.map((slot) => protectedBytesBySlot[slot])),
  };
}

function addTemporaryBytes(boundary, beforeBoundary, tempBytes) {
  return {
    beforeBoundary,
    tempBytes,
    logicalBytes: checkedCapacityAdd(boundary.currentTotalBytes, tempBytes),
    conditionalReservationBytes: checkedCapacityAdd(boundary.protectedTotalBytes, tempBytes),
  };
}

function validateExpectedLimits(expectedLimits, manifestLimits) {
  for (const slot of LIMIT_FIELDS) {
    requireValue(expectedLimits[slot] === manifestLimits[slot]);
  }
}

function assessInternal(value) {
  const input = captureFileRecord(value, INPUT_FIELDS, INVALID_CAPACITY);
  const materialBytes = copyRawBytes(input.materialBytes, MAX_SOURCE_BYTES);
  const material = decodeQuestionCapsulePreparedMaterial(materialBytes);
  const canonicalMaterial = encodeQuestionCapsulePreparedMaterial(material);
  requireValue(canonicalMaterial.bytes.equals(materialBytes));

  const expectedLimits = normalizeLimits(input.expectedNormalByteLimitsBySlot);
  const manifest = material.manifest;
  validateExpectedLimits(expectedLimits, manifest.normalByteLimitsBySlot);

  const anchorBytes = copyRawBytes(input.anchorBytes, NORMAL_ANCHOR_MAX_BYTES);
  const instructionBytes = copyRawBytes(input.instructionBytes, INSTRUCTION_RAW_MAX_BYTES, true);
  const evidence = validateQuestionCapsulePreparedMaterial({
    material,
    anchorBytes,
    instructionBytes,
  });

  const sourceQuestionBytes = parseEmbeddedBytes(material.sourceQuestionBytesBase64, MAX_SOURCE_BYTES);
  const sourceQuestionValue = parseSourceBuffer(sourceQuestionBytes, MAX_SOURCE_BYTES);
  const sourceQuestions = normalizeQuestionJournalV2Local(sourceQuestionValue);
  const questionLimit = manifest.normalByteLimitsBySlot.questions;
  requireValue(questionLimit !== null);
  const oldQuestionReservation = measureQuestionJournalReservationBytes({
    snapshot: sourceQuestions,
    currentByteLimit: questionLimit,
  });
  const oldQuestionRawBytes = sourceQuestionBytes.length;
  requireValue(Math.max(oldQuestionRawBytes, oldQuestionReservation.currentBytes,
    oldQuestionReservation.reservedBytes) <= questionLimit);

  const sourceCheckpointBytes = material.sourceCheckpointBytesBase64 === null
    ? null
    : parseEmbeddedBytes(material.sourceCheckpointBytesBase64, MAX_SOURCE_BYTES);
  const checkpointLimit = manifest.normalByteLimitsBySlot.checkpoint;
  let oldCheckpointReservation = null;
  let oldCheckpointRawBytes = 0;
  if (sourceCheckpointBytes === null) {
    requireValue(checkpointLimit === null && evidence.targetBytes.checkpoint === null);
  } else {
    requireValue(checkpointLimit !== null);
    requireValue(evidence.targetBytes.checkpoint !== null);
    oldCheckpointRawBytes = sourceCheckpointBytes.length;
    const sourceCheckpointValue = parseSourceBuffer(sourceCheckpointBytes, MAX_SOURCE_BYTES);
    const sourceCheckpoint = normalizeCheckpointV3Local(sourceCheckpointValue);
    oldCheckpointReservation = measureCheckpointReservation({
      snapshot: sourceCheckpoint,
      currentByteLimit: checkpointLimit,
    });
    requireValue(Math.max(oldCheckpointRawBytes, oldCheckpointReservation.currentBytes,
      oldCheckpointReservation.reservedBytes) <= checkpointLimit);
  }

  const anchorValue = normalizeQuestionReclamationAnchorV1Local(
    parseSourceBuffer(anchorBytes, NORMAL_ANCHOR_MAX_BYTES),
  );
  const activePeriods = sourceQuestions.reservations.map((reservation) => ({
    identity: reservation.identity,
    periodId: reservation.periodId,
  }));
  const anchorReservation = measurePendingQuestionPeriodCapacity(anchorValue, activePeriods);
  requireValue(anchorReservation.fits && anchorReservation.projectedBytes !== null &&
    Math.max(anchorBytes.length, anchorReservation.projectedBytes) <= NORMAL_ANCHOR_MAX_BYTES);

  let instructionMeasurement = null;
  let instructionRawBytes = 0;
  let instructionLimit = manifest.normalByteLimitsBySlot.instructions;
  let instructionStore = null;
  if (instructionBytes === null) {
    requireValue(instructionLimit === null);
  } else {
    requireValue(instructionLimit !== null);
    instructionRawBytes = instructionBytes.length;
    instructionStore = normalizeInstructionJournalV2Local(parseSourceBuffer(instructionBytes,
      INSTRUCTION_RAW_MAX_BYTES));
    instructionMeasurement = measureInstructionReservation({
      snapshot: instructionStore,
      currentByteLimit: instructionLimit,
    });
    const grantBytes = instructionStore.migrationAllowance?.maxExtraBytes ?? 0;
    const instructionWritableLimit = checkedCapacityAdd(instructionLimit, grantBytes);
    requireValue(Math.max(instructionRawBytes, instructionMeasurement.currentBytes,
      instructionMeasurement.reservedBytes) <= instructionWritableLimit);
  }

  const targetQuestionBytes = evidence.targetBytes.questions;
  requireValue(targetQuestionBytes !== null);
  const targetQuestionFile = decodeQuestionCapsuleJournalV3Local(targetQuestionBytes);
  const targetQuestionEncoded = encodeQuestionCapsuleJournalV3Local(targetQuestionFile);
  const targetQuestionReservation = measureQuestionCapsuleExistingUpdateReservation({
    questionFile: targetQuestionFile,
    currentByteLimit: questionLimit,
  });
  requireValue(targetQuestionReservation.currentBytes === targetQuestionEncoded.sizeBytes &&
    targetQuestionReservation.reservedBytes >= targetQuestionReservation.currentBytes);

  let targetCheckpointBytes = evidence.targetBytes.checkpoint;
  let targetCheckpointEncoded = null;
  let targetCheckpointReservation = null;
  let targetCheckpointFile = null;
  if (targetCheckpointBytes !== null) {
    requireValue(checkpointLimit !== null);
    targetCheckpointFile = decodeCapsuleCheckpointV4Local(targetCheckpointBytes);
    targetCheckpointEncoded = encodeCapsuleCheckpointV4Local(targetCheckpointFile);
    targetCheckpointReservation = measureCheckpointCapsuleExistingUpdateReservation({
      checkpointFile: targetCheckpointFile,
      currentByteLimit: checkpointLimit,
    });
    requireValue(targetCheckpointReservation.currentBytes === targetCheckpointEncoded.sizeBytes &&
      targetCheckpointReservation.reservedBytes >= targetCheckpointReservation.currentBytes);
  } else {
    requireValue(checkpointLimit === null);
  }

  const rawQuestionLimit = manifest.normalByteLimitsBySlot.questions;
  const stableBoundsFitBySlot = {
    anchor: true,
    questions: materialBytes.length <= rawQuestionLimit &&
      targetQuestionReservation.reservedBytes <= rawQuestionLimit,
    checkpoint: targetCheckpointReservation === null
      ? null
      : targetCheckpointReservation.reservedBytes <= checkpointLimit,
    instructions: instructionMeasurement === null ? null : true,
  };
  const stableBoundsFit = stableBoundsFitBySlot.anchor && stableBoundsFitBySlot.questions &&
    (stableBoundsFitBySlot.checkpoint === null || stableBoundsFitBySlot.checkpoint) &&
    (stableBoundsFitBySlot.instructions === null || stableBoundsFitBySlot.instructions);

  const measurements = {
    anchor: {
      rawCurrentBytes: anchorBytes.length,
      reservedBytes: anchorReservation.projectedBytes,
    },
    instructions: instructionMeasurement === null ? null : {
      rawCurrentBytes: instructionRawBytes,
      normalizedCurrentBytes: instructionMeasurement.currentBytes,
      reservedBytes: instructionMeasurement.reservedBytes,
      grantedExtraBytes: instructionStore.migrationAllowance?.maxExtraBytes ?? 0,
    },
    source: {
      questions: {
        rawCurrentBytes: oldQuestionRawBytes,
        normalizedCurrentBytes: oldQuestionReservation.currentBytes,
        reservedBytes: oldQuestionReservation.reservedBytes,
      },
      checkpoint: oldCheckpointReservation === null ? null : {
        rawCurrentBytes: oldCheckpointRawBytes,
        normalizedCurrentBytes: oldCheckpointReservation.currentBytes,
        reservedBytes: oldCheckpointReservation.reservedBytes,
      },
    },
    prepared: {
      questions: {
        rawCurrentBytes: materialBytes.length,
        reservedBytes: materialBytes.length,
      },
    },
    target: {
      questions: {
        rawCurrentBytes: targetQuestionBytes.length,
        normalizedCurrentBytes: targetQuestionEncoded.sizeBytes,
        reservedBytes: targetQuestionReservation.reservedBytes,
      },
      checkpoint: targetCheckpointReservation === null ? null : {
        rawCurrentBytes: targetCheckpointBytes.length,
        normalizedCurrentBytes: targetCheckpointEncoded.sizeBytes,
        reservedBytes: targetCheckpointReservation.reservedBytes,
      },
    },
  };

  const anchorRaw = anchorBytes.length;
  const instructionRaw = instructionRawBytes;
  const instructionProtected = instructionMeasurement === null
    ? 0
    : copySlotBytes(instructionRaw, instructionMeasurement.reservedBytes);
  const questionSourceCurrent = oldQuestionRawBytes;
  const questionPreparedCurrent = materialBytes.length;
  const questionTargetCurrent = targetQuestionBytes.length;
  const questionOldFuture = oldQuestionReservation.reservedBytes;
  const questionTargetFuture = targetQuestionReservation.reservedBytes;
  const checkpointSourceCurrent = oldCheckpointRawBytes;
  const checkpointTargetCurrent = targetCheckpointBytes?.length ?? 0;
  const checkpointOldFuture = oldCheckpointReservation?.reservedBytes ?? 0;
  const checkpointTargetFuture = targetCheckpointReservation?.reservedBytes ?? 0;
  const anchorProtected = Math.max(anchorRaw, anchorReservation.projectedBytes);
  const questionProtectedBeforeComplete = protectedBeforeComplete(questionSourceCurrent,
    questionOldFuture, questionTargetFuture);
  const checkpointProtectedBeforeComplete = protectedBeforeComplete(checkpointSourceCurrent,
    checkpointOldFuture, checkpointTargetFuture);

  const currentSlots = (questions, checkpoint) => ({
    anchor: anchorRaw,
    instructions: instructionRaw,
    questions,
    checkpoint,
  });
  const protectedSlots = (questions, checkpoint) => ({
    anchor: anchorProtected,
    instructions: instructionProtected,
    questions,
    checkpoint,
  });
  const boundaries = {
    source: makeBoundary(
      currentSlots(questionSourceCurrent, checkpointSourceCurrent),
      protectedSlots(questionProtectedBeforeComplete, checkpointProtectedBeforeComplete),
    ),
    prepared: makeBoundary(
      currentSlots(questionPreparedCurrent, checkpointSourceCurrent),
      protectedSlots(Math.max(questionPreparedCurrent, questionOldFuture, questionTargetFuture),
        checkpointProtectedBeforeComplete),
    ),
  };
  if (targetCheckpointReservation !== null) {
    boundaries.checkpoint_moved = makeBoundary(
      currentSlots(questionPreparedCurrent, checkpointTargetCurrent),
      protectedSlots(Math.max(questionPreparedCurrent, questionOldFuture, questionTargetFuture),
        Math.max(checkpointTargetCurrent, checkpointOldFuture, checkpointTargetFuture)),
    );
  }
  boundaries.complete = makeBoundary(
    currentSlots(questionTargetCurrent, checkpointTargetCurrent),
    protectedSlots(Math.max(questionTargetCurrent, questionTargetFuture),
      Math.max(checkpointTargetCurrent, checkpointTargetFuture)),
  );

  const singleTempCandidates = {
    questionPrepare: addTemporaryBytes(boundaries.source, 'source', materialBytes.length),
  };
  if (targetCheckpointReservation !== null) {
    singleTempCandidates.checkpointTarget = addTemporaryBytes(boundaries.prepared, 'prepared',
      targetCheckpointBytes.length);
  }
  singleTempCandidates.questionTarget = addTemporaryBytes(
    targetCheckpointReservation === null ? boundaries.prepared : boundaries.checkpoint_moved,
    targetCheckpointReservation === null ? 'prepared' : 'checkpoint_moved',
    targetQuestionBytes.length,
  );

  return {
    stableBoundsFit,
    stableBoundsFitBySlot,
    measurements,
    boundaries,
    singleTempCandidates,
    protocolAssumptions: PROTOCOL_ASSUMPTIONS,
    scopeLimitations: SCOPE_LIMITATIONS,
  };
}

function assessQuestionCapsuleMigrationCapacity(value) {
  try {
    return assessInternal(value);
  } catch {
    throw new TypeError(INVALID_CAPACITY);
  }
}

module.exports = { assessQuestionCapsuleMigrationCapacity };
