'use strict';

const { createHash } = require('node:crypto');
const { types } = require('node:util');
const {
  assertIdentifier,
  assertSafeUnsignedInteger,
  assertSha256,
  assertUuidV4,
  checkedAddBytes,
} = require('./reclamation-codec-primitives');
const { captureFileArray, captureFileRecord } = require('./question-capsule-file-primitives');
const { planQuestionCapsuleFileMigration } = require('./question-capsule-migration-plan');
const { FIXED_H_BOUNDS, MAX_SOURCE_BYTES } = require('./reclamation-capacity-bounds');
const { decodeSourceBytes, encodeNormalized } = require('./reclamation-json-codec');

const INVALID_MANIFEST = 'invalid_question_capsule_prepare_manifest';
const INVALID_EVIDENCE = 'invalid_question_capsule_prepare_evidence';
const MANIFEST_FIELDS = [
  'formatVersion', 'operationId', 'storeId', 'sourceFingerprints', 'targetFingerprints',
  'selection', 'usedChunkIds', 'normalByteLimitsBySlot',
];
const SOURCE_FINGERPRINT_FIELDS = ['anchor', 'questions', 'checkpoint', 'instructions'];
const TARGET_FINGERPRINT_FIELDS = ['questions', 'checkpoint'];
const LIMIT_FIELDS = ['questions', 'checkpoint', 'instructions'];
const SOURCE_BYTE_FIELDS = SOURCE_FINGERPRINT_FIELDS;
const TARGET_BYTE_FIELDS = TARGET_FINGERPRINT_FIELDS;
const SELECTION_FIELDS = ['identity', 'periodId', 'internalQuestionIds'];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const FINGERPRINT_FIELDS = ['sizeBytes', 'sha256'];
const CREATE_FIELDS = ['sourceBytes', 'normalByteLimitsBySlot', 'selection', 'operationId', 'chunkIds'];
const EVIDENCE_FIELDS = ['manifest', 'sourceBytes', 'targetBytes'];
const MAX_SELECTION_SCOPES = 20_000;
const MAX_SELECTED_IDS = 20_000;
const MAX_USED_CHUNK_IDS = 20_000;
const INSTRUCTION_SOURCE_MAX_BYTES = checkedAddBytes(MAX_SOURCE_BYTES, FIXED_H_BOUNDS.instructions);
const SCOPE_LIMITATIONS = Object.freeze([
  'pure_manifest_and_byte_evidence_only',
  'source_path_freshness_not_verified',
  'source_and_target_availability_after_crash_not_verified',
  'persistent_outer_schema_not_verified',
  'new_outer_future_capacity_not_verified',
  'prepare_and_atomic_peak_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'runtime_integration_not_verified',
]);

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getTypedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const getTypedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const getTypedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;

function requireValue(condition, errorCode) {
  if (!condition) throw new TypeError(errorCode);
}

function withUnifiedError(operation, errorCode) {
  try {
    return operation();
  } catch {
    throw new TypeError(errorCode);
  }
}

function isProxy(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && types.isProxy(value);
}

function captureBoundedArray(value, maximumLength, errorCode) {
  requireValue(!isProxy(value) && Array.isArray(value), errorCode);
  let lengthDescriptor;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    throw new TypeError(errorCode);
  }
  requireValue(lengthDescriptor !== undefined && Object.hasOwn(lengthDescriptor, 'value') &&
    !lengthDescriptor.enumerable && Number.isSafeInteger(lengthDescriptor.value) &&
    lengthDescriptor.value >= 0 && lengthDescriptor.value <= maximumLength, errorCode);
  return captureFileArray(value, maximumLength, errorCode);
}

function accountString(value, budget, errorCode) {
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new TypeError(errorCode);
  }
  requireValue(typeof encoded === 'string', errorCode);
  const sizeBytes = Buffer.byteLength(encoded, 'utf8');
  requireValue(sizeBytes <= MAX_SOURCE_BYTES - budget.stringBytes, errorCode);
  budget.stringBytes += sizeBytes;
  return value;
}

function identifier(value, budget, errorCode) {
  return accountString(assertIdentifier(value, errorCode), budget, errorCode);
}

function identityPeriodKey(identity, periodId) {
  return IDENTITY_FIELDS.map((field) => identity[field]).concat(periodId)
    .map((value) => `${value.length}:${value}`).join('');
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function normalizeIdentity(value, budget, errorCode) {
  const identity = captureFileRecord(value, IDENTITY_FIELDS, errorCode);
  const provider = identity.provider;
  const nativeIdKind = identity.nativeIdKind;
  requireValue((provider === 'claude' && nativeIdKind === 'session') ||
    (provider === 'codex' && nativeIdKind === 'thread'), errorCode);
  accountString(provider, budget, errorCode);
  accountString(nativeIdKind, budget, errorCode);
  return {
    provider,
    nativeIdKind,
    hostId: identifier(identity.hostId, budget, errorCode),
    homeScopeId: identifier(identity.homeScopeId, budget, errorCode),
    nativeId: identifier(identity.nativeId, budget, errorCode),
  };
}

function normalizeSelection(value, budget, errorCode) {
  const rawScopes = captureBoundedArray(value, MAX_SELECTION_SCOPES, errorCode);
  requireValue(rawScopes.length > 0, errorCode);
  const scopes = [];
  const scopeKeys = new Set();
  const selectedIds = new Set();
  let selectedCount = 0;

  for (const rawScope of rawScopes) {
    const scope = captureFileRecord(rawScope, SELECTION_FIELDS, errorCode);
    const identity = normalizeIdentity(scope.identity, budget, errorCode);
    const periodId = identifier(scope.periodId, budget, errorCode);
    const ids = captureBoundedArray(scope.internalQuestionIds, MAX_SELECTED_IDS, errorCode);
    requireValue(ids.length > 0, errorCode);
    const scopeKey = identityPeriodKey(identity, periodId);
    requireValue(!scopeKeys.has(scopeKey), errorCode);
    scopeKeys.add(scopeKey);

    const localIds = new Set();
    for (const rawId of ids) {
      const id = identifier(rawId, budget, errorCode);
      requireValue(!localIds.has(id) && !selectedIds.has(id), errorCode);
      localIds.add(id);
      selectedIds.add(id);
      selectedCount += 1;
      requireValue(selectedCount <= MAX_SELECTED_IDS, errorCode);
    }
    scopes.push({
      identity,
      periodId,
      internalQuestionIds: [...localIds].sort(compareOrdinal),
      scopeKey,
    });
  }

  scopes.sort((left, right) => compareOrdinal(left.scopeKey, right.scopeKey));
  return scopes.map(({ identity, periodId, internalQuestionIds }) => ({
    identity,
    periodId,
    internalQuestionIds,
  }));
}

function normalizeFingerprint(value, maxBytes, budget, errorCode) {
  if (value === null) return null;
  const fingerprint = captureFileRecord(value, FINGERPRINT_FIELDS, errorCode);
  assertSafeUnsignedInteger(fingerprint.sizeBytes, errorCode);
  requireValue(fingerprint.sizeBytes > 0 && fingerprint.sizeBytes <= maxBytes, errorCode);
  const sha256 = accountString(assertSha256(fingerprint.sha256, errorCode), budget, errorCode);
  return { sizeBytes: fingerprint.sizeBytes, sha256 };
}

function normalizeSourceFingerprints(value, budget, errorCode) {
  const fingerprints = captureFileRecord(value, SOURCE_FINGERPRINT_FIELDS, errorCode);
  const normalized = {
    anchor: normalizeFingerprint(fingerprints.anchor, MAX_SOURCE_BYTES, budget, errorCode),
    questions: normalizeFingerprint(fingerprints.questions, MAX_SOURCE_BYTES, budget, errorCode),
    checkpoint: normalizeFingerprint(fingerprints.checkpoint, MAX_SOURCE_BYTES, budget, errorCode),
    instructions: normalizeFingerprint(fingerprints.instructions, INSTRUCTION_SOURCE_MAX_BYTES, budget, errorCode),
  };
  requireValue(normalized.anchor !== null && normalized.questions !== null, errorCode);
  return normalized;
}

function normalizeTargetFingerprints(value, budget, errorCode) {
  const fingerprints = captureFileRecord(value, TARGET_FINGERPRINT_FIELDS, errorCode);
  const normalized = {
    questions: normalizeFingerprint(fingerprints.questions, MAX_SOURCE_BYTES, budget, errorCode),
    checkpoint: normalizeFingerprint(fingerprints.checkpoint, MAX_SOURCE_BYTES, budget, errorCode),
  };
  requireValue(normalized.questions !== null, errorCode);
  return normalized;
}

function normalizeUsedChunkIds(value, operationId, budget, errorCode) {
  const chunkIds = captureBoundedArray(value, MAX_USED_CHUNK_IDS, errorCode);
  const seen = new Set();
  const normalized = [];
  for (const rawId of chunkIds) {
    const chunkId = accountString(assertUuidV4(rawId, errorCode), budget, errorCode);
    requireValue(chunkId !== operationId && !seen.has(chunkId), errorCode);
    seen.add(chunkId);
    normalized.push(chunkId);
  }
  return normalized;
}

function normalizeLimits(value, sourceFingerprints, errorCode) {
  const limits = captureFileRecord(value, LIMIT_FIELDS, errorCode);
  const normalized = Object.create(null);
  for (const slot of LIMIT_FIELDS) {
    if (sourceFingerprints[slot] === null) {
      requireValue(limits[slot] === null, errorCode);
      normalized[slot] = null;
      continue;
    }
    assertSafeUnsignedInteger(limits[slot], errorCode);
    requireValue(limits[slot] > 0 && limits[slot] <= MAX_SOURCE_BYTES, errorCode);
    normalized[slot] = limits[slot];
  }
  return normalized;
}

function normalizeManifestInternal(value, errorCode) {
  const input = captureFileRecord(value, MANIFEST_FIELDS, errorCode);
  requireValue(input.formatVersion === 1, errorCode);
  const budget = { stringBytes: 0 };
  const operationId = accountString(assertUuidV4(input.operationId, errorCode), budget, errorCode);
  const storeId = accountString(assertUuidV4(input.storeId, errorCode), budget, errorCode);
  const sourceFingerprints = normalizeSourceFingerprints(input.sourceFingerprints, budget, errorCode);
  const targetFingerprints = normalizeTargetFingerprints(input.targetFingerprints, budget, errorCode);
  requireValue((sourceFingerprints.checkpoint === null) === (targetFingerprints.checkpoint === null), errorCode);
  const selection = normalizeSelection(input.selection, budget, errorCode);
  const usedChunkIds = normalizeUsedChunkIds(input.usedChunkIds, operationId, budget, errorCode);
  requireValue(usedChunkIds.length >= selection.length, errorCode);
  const normalByteLimitsBySlot = normalizeLimits(input.normalByteLimitsBySlot, sourceFingerprints, errorCode);

  return {
    formatVersion: 1,
    operationId,
    storeId,
    sourceFingerprints,
    targetFingerprints,
    selection,
    usedChunkIds,
    normalByteLimitsBySlot,
  };
}

function copyRawBytes(value, maximumBytes, errorCode) {
  requireValue(!isProxy(value) && types.isUint8Array(value), errorCode);
  let buffer;
  let byteOffset;
  let byteLength;
  try {
    buffer = Reflect.apply(getTypedArrayBuffer, value, []);
    byteOffset = Reflect.apply(getTypedArrayByteOffset, value, []);
    byteLength = Reflect.apply(getTypedArrayByteLength, value, []);
  } catch {
    throw new TypeError(errorCode);
  }
  requireValue(types.isArrayBuffer(buffer) && !types.isSharedArrayBuffer(buffer) &&
    Number.isSafeInteger(byteOffset) && byteOffset >= 0 && Number.isSafeInteger(byteLength) &&
    byteLength >= 0 && byteLength <= maximumBytes, errorCode);
  try {
    return Buffer.from(new Uint8Array(buffer, byteOffset, byteLength));
  } catch {
    throw new TypeError(errorCode);
  }
}

function normalizeCreateInput(value, errorCode) {
  const input = captureFileRecord(value, CREATE_FIELDS, errorCode);
  const sourceBytes = captureFileRecord(input.sourceBytes, SOURCE_BYTE_FIELDS, errorCode);
  const normalByteLimitsBySlot = captureFileRecord(input.normalByteLimitsBySlot, LIMIT_FIELDS, errorCode);
  requireValue(sourceBytes.anchor !== null && sourceBytes.questions !== null, errorCode);
  const sourcePresence = Object.fromEntries(SOURCE_FINGERPRINT_FIELDS.map((slot) => [slot, sourceBytes[slot]]));
  const presenceFingerprints = Object.fromEntries(SOURCE_FINGERPRINT_FIELDS.map((slot) => [
    slot,
    sourcePresence[slot] === null ? null : { sizeBytes: 1, sha256: '0'.repeat(64) },
  ]));
  const limits = normalizeLimits(normalByteLimitsBySlot, presenceFingerprints, errorCode);
  const budget = { stringBytes: 0 };
  const selection = normalizeSelection(input.selection, budget, errorCode);
  const operationId = assertUuidV4(input.operationId, errorCode);
  const chunkIds = captureBoundedArray(input.chunkIds, MAX_USED_CHUNK_IDS, errorCode);
  const seenChunks = new Set();
  for (const chunkId of chunkIds) {
    assertUuidV4(chunkId, errorCode);
    requireValue(!seenChunks.has(chunkId), errorCode);
    seenChunks.add(chunkId);
  }
  return { sourceBytes, normalByteLimitsBySlot: limits, selection, operationId, chunkIds };
}

function sourceFingerprintsForPlan(plan) {
  return Object.fromEntries(SOURCE_FINGERPRINT_FIELDS.map((slot) => {
    const fingerprint = plan.sourceFingerprints[slot];
    return [slot, fingerprint === null ? null : {
      sizeBytes: fingerprint.sizeBytes,
      sha256: fingerprint.sha256,
    }];
  }));
}

function targetFingerprintsForPlan(plan) {
  return Object.fromEntries(TARGET_FINGERPRINT_FIELDS.map((slot) => {
    const target = plan.targets[slot];
    return [slot, target === null ? null : { sizeBytes: target.sizeBytes, sha256: target.sha256 }];
  }));
}

function plannerInput(sourceBytes, normalByteLimitsBySlot, selection, operationId, chunkIds) {
  return { sourceBytes, normalByteLimitsBySlot, selection, operationId, chunkIds };
}

function encodeManifestInternal(value, errorCode) {
  const normalized = normalizeManifestInternal(value, errorCode);
  const encoded = encodeNormalized(normalized);
  requireValue(encoded.sizeBytes <= MAX_SOURCE_BYTES, errorCode);
  return { value: normalized, bytes: encoded.bytes, sizeBytes: encoded.sizeBytes, sha256: encoded.sha256 };
}

function sameFingerprints(left, right, fields) {
  return fields.every((field) => {
    const expected = left[field];
    const actual = right[field];
    return expected === null
      ? actual === null
      : actual !== null && expected.sizeBytes === actual.sizeBytes && expected.sha256 === actual.sha256;
  });
}

function copyFingerprints(value, fields) {
  return Object.fromEntries(fields.map((field) => {
    const fingerprint = value[field];
    return [field, fingerprint === null ? null : {
      sizeBytes: fingerprint.sizeBytes,
      sha256: fingerprint.sha256,
    }];
  }));
}

function copyTargetBytes(value, expected, errorCode) {
  const targetBytes = captureFileRecord(value, TARGET_BYTE_FIELDS, errorCode);
  const copied = Object.create(null);
  for (const slot of TARGET_BYTE_FIELDS) {
    if (expected[slot] === null) {
      requireValue(targetBytes[slot] === null, errorCode);
      copied[slot] = null;
      continue;
    }
    const bytes = copyRawBytes(targetBytes[slot], MAX_SOURCE_BYTES, errorCode);
    const fingerprint = {
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
    requireValue(fingerprint.sizeBytes === expected[slot].sizeBytes &&
      fingerprint.sha256 === expected[slot].sha256 && bytes.equals(expected[slot].bytes), errorCode);
    copied[slot] = fingerprint;
  }
  return copied;
}

function createQuestionCapsulePrepareManifestInternal(value) {
  const input = normalizeCreateInput(value, INVALID_MANIFEST);
  const plan = planQuestionCapsuleFileMigration(plannerInput(
    input.sourceBytes,
    input.normalByteLimitsBySlot,
    input.selection,
    input.operationId,
    input.chunkIds,
  ));
  requireValue(plan.usedChunkIds.every((chunkId) => chunkId !== input.operationId), INVALID_MANIFEST);
  const manifest = {
    formatVersion: 1,
    operationId: input.operationId,
    storeId: plan.targets.questions.value.storeId,
    sourceFingerprints: sourceFingerprintsForPlan(plan),
    targetFingerprints: targetFingerprintsForPlan(plan),
    selection: input.selection,
    usedChunkIds: plan.usedChunkIds,
    normalByteLimitsBySlot: input.normalByteLimitsBySlot,
  };
  const encoded = encodeManifestInternal(manifest, INVALID_MANIFEST);
  return {
    manifest: encoded.value,
    bytes: encoded.bytes,
    sizeBytes: encoded.sizeBytes,
    sha256: encoded.sha256,
    scopeLimitations: SCOPE_LIMITATIONS,
  };
}

function validateQuestionCapsulePrepareEvidenceInternal(value) {
  const input = captureFileRecord(value, EVIDENCE_FIELDS, INVALID_EVIDENCE);
  const manifest = encodeManifestInternal(input.manifest, INVALID_EVIDENCE).value;
  const sourceBytes = captureFileRecord(input.sourceBytes, SOURCE_BYTE_FIELDS, INVALID_EVIDENCE);
  const plan = planQuestionCapsuleFileMigration(plannerInput(
    sourceBytes,
    manifest.normalByteLimitsBySlot,
    manifest.selection,
    manifest.operationId,
    manifest.usedChunkIds,
  ));
  requireValue(plan.unusedChunkIds.length === 0 && plan.usedChunkIds.length === manifest.usedChunkIds.length &&
    plan.usedChunkIds.every((chunkId, index) => chunkId === manifest.usedChunkIds[index]), INVALID_EVIDENCE);
  requireValue(plan.targets.questions.value.storeId === manifest.storeId &&
    (plan.targets.checkpoint === null || plan.targets.checkpoint.value.storeId === manifest.storeId), INVALID_EVIDENCE);

  const sourceFingerprints = sourceFingerprintsForPlan(plan);
  const targetFingerprints = targetFingerprintsForPlan(plan);
  requireValue(sameFingerprints(manifest.sourceFingerprints, sourceFingerprints,
    SOURCE_FINGERPRINT_FIELDS), INVALID_EVIDENCE);
  requireValue(sameFingerprints(manifest.targetFingerprints, targetFingerprints,
    TARGET_FINGERPRINT_FIELDS), INVALID_EVIDENCE);
  copyTargetBytes(input.targetBytes, plan.targets, INVALID_EVIDENCE);

  return {
    manifest,
    sourceFingerprints: copyFingerprints(sourceFingerprints, SOURCE_FINGERPRINT_FIELDS),
    targetFingerprints: copyFingerprints(targetFingerprints, TARGET_FINGERPRINT_FIELDS),
    scopeLimitations: SCOPE_LIMITATIONS,
  };
}

function normalizeQuestionCapsulePrepareManifest(value) {
  return withUnifiedError(() => encodeManifestInternal(value, INVALID_MANIFEST).value, INVALID_MANIFEST);
}

function encodeQuestionCapsulePrepareManifest(value) {
  return withUnifiedError(() => encodeManifestInternal(value, INVALID_MANIFEST), INVALID_MANIFEST);
}

function decodeQuestionCapsulePrepareManifest(rawBytes) {
  return withUnifiedError(() => {
    const bytes = copyRawBytes(rawBytes, MAX_SOURCE_BYTES, INVALID_MANIFEST);
    const decoded = decodeSourceBytes(bytes, MAX_SOURCE_BYTES);
    return encodeManifestInternal(decoded.value, INVALID_MANIFEST).value;
  }, INVALID_MANIFEST);
}

function createQuestionCapsulePrepareManifest(value) {
  return withUnifiedError(() => createQuestionCapsulePrepareManifestInternal(value), INVALID_MANIFEST);
}

function validateQuestionCapsulePrepareEvidence(value) {
  return withUnifiedError(() => validateQuestionCapsulePrepareEvidenceInternal(value), INVALID_EVIDENCE);
}

module.exports = {
  createQuestionCapsulePrepareManifest,
  decodeQuestionCapsulePrepareManifest,
  encodeQuestionCapsulePrepareManifest,
  normalizeQuestionCapsulePrepareManifest,
  validateQuestionCapsulePrepareEvidence,
};
