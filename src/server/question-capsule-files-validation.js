'use strict';

const {
  captureFileRecord,
} = require('./question-capsule-file-primitives');
const {
  encodeCapsuleCheckpointV4Local,
  normalizeCapsuleCheckpointV4Local,
} = require('./question-capsule-checkpoint-codec');
const {
  encodeQuestionCapsuleJournalV3Local,
  normalizeQuestionCapsuleJournalV3Local,
} = require('./question-capsule-journal-codec');
const { validateQuestionCapsuleWholeRepresentation } = require('./question-capsule-whole-validation');
const { MAX_SOURCE_BYTES } = require('./reclamation-capacity-bounds');

const INVALID_QUESTION_CAPSULE_FILES = 'invalid_question_capsule_files';
const INPUT_FIELDS = ['anchor', 'questionFile', 'checkpointFile', 'instructionStore', 'normalByteLimitsBySlot'];
const LIMIT_FIELDS = ['questions', 'checkpoint', 'instructions'];
const SCOPE_LIMITATIONS = Object.freeze([
  'declared_delivery_order_authenticity_not_verified',
  'anchor_persistence_not_verified',
  'persistent_outer_schema_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'runtime_integration_not_verified',
  'new_outer_future_capacity_not_verified',
]);

function requireValue(condition) {
  if (!condition) throw new TypeError(INVALID_QUESTION_CAPSULE_FILES);
}

function makeQuestionStore(file) {
  if (file === null) return null;
  return {
    schemaVersion: 2,
    storeId: file.storeId,
    revision: file.revision,
    questions: file.questions,
    reservations: file.reservations,
    migrationAllowance: file.migrationAllowance,
  };
}

function makeCheckpointStore(file) {
  if (file === null) return null;
  return {
    schemaVersion: 3,
    storeId: file.storeId,
    revision: file.revision,
    registrations: file.registrations,
    ledger: file.ledger,
    migrationAllowance: file.migrationAllowance,
  };
}

function matchCapsules(questionFile, checkpointFile) {
  const questionChunks = new Set();
  const checkpointByChunkId = new Map();
  for (const entry of checkpointFile?.checkpointCapsules ?? []) {
    requireValue(!checkpointByChunkId.has(entry.chunkId));
    checkpointByChunkId.set(entry.chunkId, entry.capsule);
  }

  const pairs = [];
  for (const entry of questionFile?.questionCapsules ?? []) {
    requireValue(!questionChunks.has(entry.chunkId));
    questionChunks.add(entry.chunkId);
    pairs.push({
      questionCapsule: entry.capsule,
      checkpointCapsule: checkpointByChunkId.get(entry.chunkId) ?? null,
    });
  }

  for (const chunkId of checkpointByChunkId.keys()) requireValue(questionChunks.has(chunkId));
  return pairs;
}

function requireNewFileFits(encodedSizeBytes, byteLimit) {
  requireValue(Number.isSafeInteger(byteLimit) && byteLimit > 0 && byteLimit <= MAX_SOURCE_BYTES &&
    encodedSizeBytes <= byteLimit);
}

function validateInternal(value) {
  const input = captureFileRecord(value, INPUT_FIELDS, INVALID_QUESTION_CAPSULE_FILES);
  const limits = captureFileRecord(input.normalByteLimitsBySlot, LIMIT_FIELDS, INVALID_QUESTION_CAPSULE_FILES);

  const questionFile = input.questionFile === null
    ? null
    : normalizeQuestionCapsuleJournalV3Local(input.questionFile);
  const checkpointFile = input.checkpointFile === null
    ? null
    : normalizeCapsuleCheckpointV4Local(input.checkpointFile);
  const capsulePairs = matchCapsules(questionFile, checkpointFile);

  const wholeResult = validateQuestionCapsuleWholeRepresentation({
    formatVersion: 1,
    anchor: input.anchor,
    ordinaryStores: {
      questions: makeQuestionStore(questionFile),
      checkpoint: makeCheckpointStore(checkpointFile),
      instructions: input.instructionStore,
    },
    capsulePairs,
    deliveryAttemptOrder: checkpointFile?.deliveryAttemptOrder ?? [],
    questionReservationOrder: questionFile?.reservationOrder ?? [],
    normalByteLimitsBySlot: limits,
  });

  if (questionFile === null) {
    requireValue(limits.questions === null);
  } else {
    const encoded = encodeQuestionCapsuleJournalV3Local(questionFile);
    requireNewFileFits(encoded.sizeBytes, limits.questions);
  }
  if (checkpointFile === null) {
    requireValue(limits.checkpoint === null);
  } else {
    const encoded = encodeCapsuleCheckpointV4Local(checkpointFile);
    requireNewFileFits(encoded.sizeBytes, limits.checkpoint);
  }

  return {
    snapshot: wholeResult.snapshot,
    counts: wholeResult.counts,
    scopeLimitations: SCOPE_LIMITATIONS,
  };
}

function validateQuestionCapsuleFiles(value) {
  try {
    return validateInternal(value);
  } catch {
    throw new TypeError(INVALID_QUESTION_CAPSULE_FILES);
  }
}

module.exports = { validateQuestionCapsuleFiles };
