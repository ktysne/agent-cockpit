'use strict';

const { createHash } = require('node:crypto');
const { types } = require('node:util');
const { assertSafeUnsignedInteger, checkedAddBytes, checkedMultiplyBytes } = require('./reclamation-codec-primitives');
const { captureFileRecord } = require('./question-capsule-file-primitives');
const {
  encodeQuestionCapsulePrepareManifest,
  normalizeQuestionCapsulePrepareManifest,
  validateQuestionCapsulePrepareEvidence,
} = require('./question-capsule-prepare-manifest-codec');
const { planQuestionCapsuleFileMigration } = require('./question-capsule-migration-plan');
const { FIXED_H_BOUNDS, MAX_SOURCE_BYTES, NORMAL_ANCHOR_MAX_BYTES } = require('./reclamation-capacity-bounds');
const { decodeSourceBytes, encodeNormalized } = require('./reclamation-json-codec');

const INVALID_MATERIAL = 'invalid_question_capsule_prepared_material';
const MATERIAL_KIND = 'question_capsule_prepared_material';
const MATERIAL_FIELDS = [
  'formatVersion', 'kind', 'manifest', 'sourceQuestionBytesBase64', 'sourceCheckpointBytesBase64',
];
const CREATE_FIELDS = ['manifest', 'sourceBytes', 'targetBytes'];
const SOURCE_BYTE_FIELDS = ['anchor', 'questions', 'checkpoint', 'instructions'];
const TARGET_BYTE_FIELDS = ['questions', 'checkpoint'];
const VALIDATE_FIELDS = ['material', 'anchorBytes', 'instructionBytes'];
const SOURCE_FINGERPRINT_FIELDS = ['anchor', 'questions', 'checkpoint', 'instructions'];
const TARGET_FINGERPRINT_FIELDS = ['questions', 'checkpoint'];
const INSTRUCTION_SOURCE_MAX_BYTES = checkedAddBytes(MAX_SOURCE_BYTES, FIXED_H_BOUNDS.instructions);
const SCOPE_LIMITATIONS = Object.freeze([
  'pure_material_representation_and_reproduction_only',
  'source_path_freshness_not_verified',
  'source_and_target_availability_after_crash_not_verified',
  'persistent_outer_schema_not_verified',
  'manifest_byte_limits_not_authenticated',
  'new_outer_future_capacity_not_verified',
  'prepare_and_atomic_peak_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'save_or_resume_authority_not_verified',
  'runtime_integration_not_verified',
]);

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getTypedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const getTypedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const getTypedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;

function requireValue(condition) {
  if (!condition) throw new TypeError(INVALID_MATERIAL);
}

function withUnifiedError(operation) {
  try {
    return operation();
  } catch {
    throw new TypeError(INVALID_MATERIAL);
  }
}

function isProxy(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && types.isProxy(value);
}

function copyRawBytes(value, maximumBytes, expectedSizeBytes = null) {
  requireValue(!isProxy(value) && types.isUint8Array(value));
  let buffer;
  let byteOffset;
  let byteLength;
  try {
    buffer = Reflect.apply(getTypedArrayBuffer, value, []);
    byteOffset = Reflect.apply(getTypedArrayByteOffset, value, []);
    byteLength = Reflect.apply(getTypedArrayByteLength, value, []);
  } catch {
    throw new TypeError(INVALID_MATERIAL);
  }
  requireValue(types.isArrayBuffer(buffer) && !types.isSharedArrayBuffer(buffer) &&
    Number.isSafeInteger(byteOffset) && byteOffset >= 0 && Number.isSafeInteger(byteLength) &&
    byteLength >= 0 && byteLength <= maximumBytes &&
    (expectedSizeBytes === null || byteLength === expectedSizeBytes));
  try {
    return Buffer.from(new Uint8Array(buffer, byteOffset, byteLength));
  } catch {
    throw new TypeError(INVALID_MATERIAL);
  }
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function verifyFingerprint(bytes, fingerprint) {
  requireValue(bytes.length === fingerprint.sizeBytes && sha256(bytes) === fingerprint.sha256);
  return bytes;
}

function copyFingerprintBytes(value, fingerprint, maximumBytes) {
  if (fingerprint === null) {
    requireValue(value === null);
    return null;
  }
  const bytes = copyRawBytes(value, maximumBytes, fingerprint.sizeBytes);
  return verifyFingerprint(bytes, fingerprint);
}

function base64CharacterLength(byteLength) {
  assertSafeUnsignedInteger(byteLength, INVALID_MATERIAL);
  const groups = checkedAddBytes(Math.floor(byteLength / 3), byteLength % 3 === 0 ? 0 : 1);
  return checkedMultiplyBytes(groups, 4);
}

function estimateEnvelopeSize(manifestEncoded, questionByteLength, checkpointByteLength) {
  const skeleton = encodeNormalized({
    formatVersion: 1,
    kind: MATERIAL_KIND,
    manifest: null,
    sourceQuestionBytesBase64: '',
    sourceCheckpointBytesBase64: checkpointByteLength === null ? null : '',
  });

  let lineFeedCount = 0;
  for (const byte of manifestEncoded.bytes) {
    if (byte === 0x0a) lineFeedCount = checkedAddBytes(lineFeedCount, 1);
  }
  requireValue(manifestEncoded.sizeBytes >= 1 && lineFeedCount >= 1);
  const nestedManifestContribution = checkedAddBytes(
    manifestEncoded.sizeBytes - 1,
    checkedMultiplyBytes(2, lineFeedCount - 1),
  );
  requireValue(nestedManifestContribution >= 4);
  const manifestReplacementContribution = nestedManifestContribution - 4;
  return checkedAddBytes(
    skeleton.sizeBytes,
    manifestReplacementContribution,
    base64CharacterLength(questionByteLength),
    checkpointByteLength === null ? 0 : base64CharacterLength(checkpointByteLength),
  );
}

function encodeEnvelope(material, predictedSizeBytes) {
  const encoded = encodeNormalized(material);
  requireValue(encoded.sizeBytes <= MAX_SOURCE_BYTES && encoded.sizeBytes === predictedSizeBytes);
  return encoded;
}

function decodeCanonicalBase64(value, fingerprint) {
  const expectedLength = base64CharacterLength(fingerprint.sizeBytes);
  requireValue(typeof value === 'string' && value.length === expectedLength && expectedLength % 4 === 0);
  const paddingLength = fingerprint.sizeBytes % 3 === 0 ? 0 : fingerprint.sizeBytes % 3 === 1 ? 2 : 1;
  const dataLength = expectedLength - paddingLength;
  for (let index = 0; index < dataLength; index += 1) {
    const code = value.charCodeAt(index);
    requireValue((code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a) ||
      (code >= 0x30 && code <= 0x39) || code === 0x2b || code === 0x2f);
  }
  for (let index = dataLength; index < expectedLength; index += 1) {
    requireValue(value.charCodeAt(index) === 0x3d);
  }
  let bytes;
  try {
    bytes = Buffer.from(value, 'base64');
  } catch {
    throw new TypeError(INVALID_MATERIAL);
  }
  requireValue(bytes.length === fingerprint.sizeBytes && bytes.toString('base64') === value);
  return verifyFingerprint(bytes, fingerprint);
}

function normalizeMaterialInternal(value) {
  const input = captureFileRecord(value, MATERIAL_FIELDS, INVALID_MATERIAL);
  requireValue(input.formatVersion === 1 && input.kind === MATERIAL_KIND);
  const manifest = normalizeQuestionCapsulePrepareManifest(input.manifest);
  const manifestEncoded = encodeQuestionCapsulePrepareManifest(manifest);
  const questionFingerprint = manifest.sourceFingerprints.questions;
  const checkpointFingerprint = manifest.sourceFingerprints.checkpoint;
  requireValue(questionFingerprint !== null &&
    ((checkpointFingerprint === null) === (input.sourceCheckpointBytesBase64 === null)));

  const questionBase64Length = base64CharacterLength(questionFingerprint.sizeBytes);
  requireValue(typeof input.sourceQuestionBytesBase64 === 'string' &&
    input.sourceQuestionBytesBase64.length === questionBase64Length);
  let checkpointBase64Length = null;
  if (checkpointFingerprint !== null) {
    checkpointBase64Length = base64CharacterLength(checkpointFingerprint.sizeBytes);
    requireValue(typeof input.sourceCheckpointBytesBase64 === 'string' &&
      input.sourceCheckpointBytesBase64.length === checkpointBase64Length);
  }

  const predictedSizeBytes = estimateEnvelopeSize(
    manifestEncoded,
    questionFingerprint.sizeBytes,
    checkpointFingerprint === null ? null : checkpointFingerprint.sizeBytes,
  );
  requireValue(predictedSizeBytes <= MAX_SOURCE_BYTES);

  const questionBytes = decodeCanonicalBase64(input.sourceQuestionBytesBase64, questionFingerprint);
  const checkpointBytes = checkpointFingerprint === null
    ? null
    : decodeCanonicalBase64(input.sourceCheckpointBytesBase64, checkpointFingerprint);
  const material = {
    formatVersion: 1,
    kind: MATERIAL_KIND,
    manifest,
    sourceQuestionBytesBase64: input.sourceQuestionBytesBase64,
    sourceCheckpointBytesBase64: input.sourceCheckpointBytesBase64,
  };
  return {
    material,
    sourceBytes: { questions: questionBytes, checkpoint: checkpointBytes },
    encoded: encodeEnvelope(material, predictedSizeBytes),
  };
}

function copySourceBytes(value, manifest) {
  const source = captureFileRecord(value, SOURCE_BYTE_FIELDS, INVALID_MATERIAL);
  const copied = Object.create(null);
  for (const slot of SOURCE_FINGERPRINT_FIELDS) {
    const maximumBytes = slot === 'anchor'
      ? NORMAL_ANCHOR_MAX_BYTES
      : slot === 'instructions' ? INSTRUCTION_SOURCE_MAX_BYTES : MAX_SOURCE_BYTES;
    copied[slot] = copyFingerprintBytes(source[slot], manifest.sourceFingerprints[slot], maximumBytes);
  }
  return copied;
}

function copyTargetBytes(value, manifest) {
  const target = captureFileRecord(value, TARGET_BYTE_FIELDS, INVALID_MATERIAL);
  const copied = Object.create(null);
  for (const slot of TARGET_FINGERPRINT_FIELDS) {
    copied[slot] = copyFingerprintBytes(target[slot], manifest.targetFingerprints[slot], MAX_SOURCE_BYTES);
  }
  return copied;
}

function createQuestionCapsulePreparedMaterialInternal(value) {
  const input = captureFileRecord(value, CREATE_FIELDS, INVALID_MATERIAL);
  const manifest = normalizeQuestionCapsulePrepareManifest(input.manifest);
  const sourceBytes = copySourceBytes(input.sourceBytes, manifest);
  const targetBytes = copyTargetBytes(input.targetBytes, manifest);
  const evidence = validateQuestionCapsulePrepareEvidence({ manifest, sourceBytes, targetBytes });
  const normalizedManifest = evidence.manifest;
  const manifestEncoded = encodeQuestionCapsulePrepareManifest(normalizedManifest);
  const questionBytes = sourceBytes.questions;
  const checkpointBytes = sourceBytes.checkpoint;
  const predictedSizeBytes = estimateEnvelopeSize(
    manifestEncoded,
    questionBytes.length,
    checkpointBytes === null ? null : checkpointBytes.length,
  );
  requireValue(predictedSizeBytes <= MAX_SOURCE_BYTES);

  const material = {
    formatVersion: 1,
    kind: MATERIAL_KIND,
    manifest: normalizedManifest,
    sourceQuestionBytesBase64: questionBytes.toString('base64'),
    sourceCheckpointBytesBase64: checkpointBytes === null ? null : checkpointBytes.toString('base64'),
  };
  const encoded = encodeEnvelope(material, predictedSizeBytes);
  return {
    material,
    bytes: encoded.bytes,
    sizeBytes: encoded.sizeBytes,
    sha256: encoded.sha256,
    scopeLimitations: SCOPE_LIMITATIONS,
  };
}

function decodeQuestionCapsulePreparedMaterialInternal(rawBytes) {
  const bytes = copyRawBytes(rawBytes, MAX_SOURCE_BYTES);
  const decoded = decodeSourceBytes(bytes, MAX_SOURCE_BYTES);
  return normalizeMaterialInternal(decoded.value).material;
}

function validateQuestionCapsulePreparedMaterialInternal(value) {
  const input = captureFileRecord(value, VALIDATE_FIELDS, INVALID_MATERIAL);
  const decoded = normalizeMaterialInternal(input.material);
  const manifest = decoded.material.manifest;
  const sourceBytes = Object.create(null);
  sourceBytes.anchor = copyFingerprintBytes(input.anchorBytes, manifest.sourceFingerprints.anchor,
    NORMAL_ANCHOR_MAX_BYTES);
  sourceBytes.questions = decoded.sourceBytes.questions;
  sourceBytes.checkpoint = decoded.sourceBytes.checkpoint;
  sourceBytes.instructions = copyFingerprintBytes(input.instructionBytes,
    manifest.sourceFingerprints.instructions, INSTRUCTION_SOURCE_MAX_BYTES);

  const plan = planQuestionCapsuleFileMigration({
    sourceBytes,
    normalByteLimitsBySlot: manifest.normalByteLimitsBySlot,
    selection: manifest.selection,
    operationId: manifest.operationId,
    chunkIds: manifest.usedChunkIds,
  });
  const targetBytes = {};
  for (const slot of TARGET_FINGERPRINT_FIELDS) {
    const fingerprint = manifest.targetFingerprints[slot];
    const planned = plan.targets[slot];
    if (fingerprint === null) {
      requireValue(planned === null);
      targetBytes[slot] = null;
    } else {
      requireValue(planned !== null);
      targetBytes[slot] = verifyFingerprint(
        copyRawBytes(planned.bytes, MAX_SOURCE_BYTES, fingerprint.sizeBytes),
        fingerprint,
      );
    }
  }
  const evidence = validateQuestionCapsulePrepareEvidence({ manifest, sourceBytes, targetBytes });
  return {
    material: decoded.material,
    sourceFingerprints: evidence.sourceFingerprints,
    targetFingerprints: evidence.targetFingerprints,
    targetBytes,
    scopeLimitations: SCOPE_LIMITATIONS,
  };
}

function createQuestionCapsulePreparedMaterial(value) {
  return withUnifiedError(() => createQuestionCapsulePreparedMaterialInternal(value));
}

function normalizeQuestionCapsulePreparedMaterial(value) {
  return withUnifiedError(() => normalizeMaterialInternal(value).material);
}

function encodeQuestionCapsulePreparedMaterial(value) {
  return withUnifiedError(() => {
    const normalized = normalizeMaterialInternal(value);
    return {
      value: normalized.material,
      bytes: normalized.encoded.bytes,
      sizeBytes: normalized.encoded.sizeBytes,
      sha256: normalized.encoded.sha256,
    };
  });
}

function decodeQuestionCapsulePreparedMaterial(rawBytes) {
  return withUnifiedError(() => decodeQuestionCapsulePreparedMaterialInternal(rawBytes));
}

function validateQuestionCapsulePreparedMaterial(value) {
  return withUnifiedError(() => validateQuestionCapsulePreparedMaterialInternal(value));
}

module.exports = {
  createQuestionCapsulePreparedMaterial,
  decodeQuestionCapsulePreparedMaterial,
  encodeQuestionCapsulePreparedMaterial,
  normalizeQuestionCapsulePreparedMaterial,
  validateQuestionCapsulePreparedMaterial,
};
