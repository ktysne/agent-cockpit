'use strict';

const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { captureFileRecord } = require('./question-capsule-file-primitives');
const {
  decodeQuestionCapsulePreparedMaterial,
  encodeQuestionCapsulePreparedMaterial,
  validateQuestionCapsulePreparedMaterial,
} = require('./question-capsule-prepared-material-codec');
const { checkedAddBytes } = require('./reclamation-codec-primitives');
const { FIXED_H_BOUNDS, MAX_SOURCE_BYTES, NORMAL_ANCHOR_MAX_BYTES } = require('./reclamation-capacity-bounds');

const INVALID_BOUNDARY = 'invalid_question_capsule_migration_boundary';
const INPUT_FIELDS = ['materialBytes', 'anchorBytes', 'instructionBytes', 'questionBytes', 'checkpointBytes'];
const INSTRUCTION_MAX_BYTES = checkedAddBytes(MAX_SOURCE_BYTES, FIXED_H_BOUNDS.instructions);
const SCOPE_LIMITATIONS = Object.freeze([
  'boundary_bytes_only',
  'material_durable_availability_not_verified',
  'source_freshness_not_verified',
  'trusted_limits_not_verified',
  'orphan_and_external_files_not_counted',
  'atomic_peak_and_admission_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'runtime_integration_not_verified',
]);

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getTypedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const getTypedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const getTypedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;

function requireValue(condition) {
  if (!condition) throw new TypeError(INVALID_BOUNDARY);
}

function withUnifiedError(operation) {
  try {
    return operation();
  } catch {
    throw new TypeError(INVALID_BOUNDARY);
  }
}

function isProxy(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && types.isProxy(value);
}

function copyRawBytes(value, maximumBytes) {
  requireValue(!isProxy(value) && types.isUint8Array(value));
  let buffer;
  let byteOffset;
  let byteLength;
  try {
    buffer = Reflect.apply(getTypedArrayBuffer, value, []);
    byteOffset = Reflect.apply(getTypedArrayByteOffset, value, []);
    byteLength = Reflect.apply(getTypedArrayByteLength, value, []);
  } catch {
    throw new TypeError(INVALID_BOUNDARY);
  }
  requireValue(types.isArrayBuffer(buffer) && !types.isSharedArrayBuffer(buffer) &&
    Number.isSafeInteger(byteOffset) && byteOffset >= 0 && Number.isSafeInteger(byteLength) &&
    byteLength > 0 && byteLength <= maximumBytes);
  try {
    return Buffer.from(new Uint8Array(buffer, byteOffset, byteLength));
  } catch {
    throw new TypeError(INVALID_BOUNDARY);
  }
}

function copyOptionalBytes(value, maximumBytes) {
  return value === null ? null : copyRawBytes(value, maximumBytes);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function fingerprint(bytes) {
  return bytes === null ? null : { sizeBytes: bytes.length, sha256: sha256(bytes) };
}

function sameOptionalBytes(left, right) {
  return left === null ? right === null : right !== null && left.equals(right);
}

function classifyBoundaryInternal(value) {
  const input = captureFileRecord(value, INPUT_FIELDS, INVALID_BOUNDARY);
  const materialBytes = copyRawBytes(input.materialBytes, MAX_SOURCE_BYTES);
  const anchorBytes = copyRawBytes(input.anchorBytes, NORMAL_ANCHOR_MAX_BYTES);
  const instructionBytes = copyOptionalBytes(input.instructionBytes, INSTRUCTION_MAX_BYTES);
  const questionBytes = copyRawBytes(input.questionBytes, MAX_SOURCE_BYTES);
  const checkpointBytes = copyOptionalBytes(input.checkpointBytes, MAX_SOURCE_BYTES);

  const material = decodeQuestionCapsulePreparedMaterial(materialBytes);
  const canonicalMaterial = encodeQuestionCapsulePreparedMaterial(material);
  requireValue(canonicalMaterial.bytes.equals(materialBytes));
  const validated = validateQuestionCapsulePreparedMaterial({
    material,
    anchorBytes,
    instructionBytes,
  });

  const oldQuestionBytes = Buffer.from(material.sourceQuestionBytesBase64, 'base64');
  const oldCheckpointBytes = material.sourceCheckpointBytesBase64 === null
    ? null
    : Buffer.from(material.sourceCheckpointBytesBase64, 'base64');
  const targetQuestionBytes = validated.targetBytes.questions;
  const targetCheckpointBytes = validated.targetBytes.checkpoint;

  const candidates = [];
  if (questionBytes.equals(oldQuestionBytes) && sameOptionalBytes(checkpointBytes, oldCheckpointBytes)) {
    candidates.push('source');
  }
  if (questionBytes.equals(materialBytes) && sameOptionalBytes(checkpointBytes, oldCheckpointBytes)) {
    candidates.push('prepared');
  }
  if (targetCheckpointBytes !== null && questionBytes.equals(materialBytes) &&
    sameOptionalBytes(checkpointBytes, targetCheckpointBytes)) {
    candidates.push('checkpoint_moved');
  }
  if (questionBytes.equals(targetQuestionBytes) && sameOptionalBytes(checkpointBytes, targetCheckpointBytes)) {
    candidates.push('complete');
  }
  requireValue(candidates.length === 1);

  const currentBytesBySlot = {
    anchor: anchorBytes.length,
    instructions: instructionBytes?.length ?? 0,
    questions: questionBytes.length,
    checkpoint: checkpointBytes?.length ?? 0,
  };
  const currentTotalBytes = Object.values(currentBytesBySlot)
    .reduce((total, sizeBytes) => checkedAddBytes(total, sizeBytes), 0);

  return {
    boundary: candidates[0],
    checkpointPresent: checkpointBytes !== null,
    observedFingerprints: {
      anchor: fingerprint(anchorBytes),
      instructions: fingerprint(instructionBytes),
      questions: fingerprint(questionBytes),
      checkpoint: fingerprint(checkpointBytes),
    },
    currentBytesBySlot,
    currentTotalBytes,
    scopeLimitations: SCOPE_LIMITATIONS,
  };
}

function classifyQuestionCapsuleMigrationBoundary(value) {
  return withUnifiedError(() => classifyBoundaryInternal(value));
}

module.exports = { classifyQuestionCapsuleMigrationBoundary };
