'use strict';

const {
  assertIdentifier,
  assertSafeUnsignedInteger,
  assertUuidV4,
  captureDenseArray,
  captureExactRecord,
} = require('./reclamation-codec-primitives');
const { assertPlainDataTree } = require('./reclamation-plain-data');
const { normalizeQuestionReservation } = require('./common-question-reclamation-codec');
const { normalizeDeliveryRecordV2Local } = require('./delivery-reclamation-codec');
const { decodeSourceBytes, encodeNormalized } = require('./reclamation-json-codec');

const INVALID_QUESTION_CAPSULE = 'invalid_question_rejection_capsule';
const INVALID_DELIVERY_CAPSULE = 'invalid_question_delivery_capsule';
const MAX_CAPSULE_ENTRIES = 256;
const MAX_CAPSULE_BYTES = 1_048_576;
const MAX_PREFLIGHT_VISITS = 100_000;
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const QUESTION_CAPSULE_FIELDS = [
  'formatVersion', 'compactionOperationId', 'storeId', 'identity', 'periodId', 'reservations',
];
const DELIVERY_CAPSULE_FIELDS = [
  'formatVersion', 'compactionOperationId', 'storeId', 'identity', 'periodId', 'references', 'deliveries',
];
const REFERENCE_FIELDS = ['sources', 'targets'];
const SOURCE_REF_FIELD = 'sourceRef';
const TARGET_REF_FIELD = 'targetRef';
const SOURCE_REF_INDEX_FIELD = 'sourceRefIndex';
const TARGET_REF_INDEX_FIELD = 'targetRefIndex';

const CAPSULE_LIMITS = Object.freeze({
  maxQuestionEntries: MAX_CAPSULE_ENTRIES,
  maxDeliveryEntries: MAX_CAPSULE_ENTRIES,
  maxQuestionBytes: MAX_CAPSULE_BYTES,
  maxCheckpointBytes: MAX_CAPSULE_BYTES,
  maxSelectedLogicalTombstones: MAX_CAPSULE_ENTRIES,
});

function fail(errorCode) {
  throw new TypeError(errorCode);
}

function requireValue(condition, errorCode) {
  if (!condition) fail(errorCode);
}

function preflight(value, errorCode) {
  assertPlainDataTree(value, errorCode, MAX_CAPSULE_ENTRIES, MAX_PREFLIGHT_VISITS);
}

function captureCapsule(value, fields, errorCode) {
  preflight(value, errorCode);
  return captureExactRecord(value, fields, errorCode);
}

function capsuleHeader(capsule, errorCode) {
  requireValue(capsule.formatVersion === 1, errorCode);
  assertUuidV4(capsule.compactionOperationId, errorCode);
  assertUuidV4(capsule.storeId, errorCode);
  const identity = captureExactRecord(capsule.identity, IDENTITY_FIELDS, errorCode);
  assertIdentifier(capsule.periodId, errorCode);
  return { identity, periodId: capsule.periodId };
}

function encodeCapsuleValue(value, maxBytes, tooLargeCode) {
  const encoded = encodeNormalized(value);
  if (encoded.sizeBytes > maxBytes) throw new RangeError(tooLargeCode);
  return {
    value,
    bytes: encoded.bytes,
    sizeBytes: encoded.sizeBytes,
    sha256: encoded.sha256,
  };
}

function withoutFields(record, omittedFields) {
  const result = {};
  for (const key of Object.keys(record)) {
    if (!omittedFields.has(key)) result[key] = record[key];
  }
  return result;
}

function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function encodeReference(reference, errorCode) {
  try {
    return encodeNormalized(reference).bytes.toString('utf8');
  } catch {
    fail(errorCode);
  }
}

function internReference(reference, requestedIndex, dictionaryLength, seen, normalizedReferences, errorCode) {
  assertSafeUnsignedInteger(requestedIndex, errorCode);
  requireValue(requestedIndex < dictionaryLength, errorCode);
  const signature = encodeReference(reference, errorCode);
  const existingIndex = seen.get(signature);
  if (existingIndex !== undefined) {
    requireValue(requestedIndex === existingIndex, errorCode);
    return existingIndex;
  }

  requireValue(requestedIndex === seen.size, errorCode);
  seen.set(signature, requestedIndex);
  normalizedReferences[requestedIndex] = reference;
  return requestedIndex;
}

function normalizeQuestionCapsuleInternal(value) {
  const errorCode = INVALID_QUESTION_CAPSULE;
  const capsule = captureCapsule(value, QUESTION_CAPSULE_FIELDS, errorCode);
  const header = capsuleHeader(capsule, errorCode);
  const inputReservations = captureDenseArray(capsule.reservations, MAX_CAPSULE_ENTRIES, errorCode);
  requireValue(inputReservations.length >= 1, errorCode);

  let identity;
  let previousInternalQuestionId = null;
  const internalQuestionIds = new Set();
  const questionIds = new Set();
  const deliveryAttemptIds = new Set();
  const reservations = inputReservations.map((entry) => {
    requireValue(!Object.hasOwn(entry, 'identity') && !Object.hasOwn(entry, 'periodId'), errorCode);
    const reservation = normalizeQuestionReservation({
      ...entry,
      identity: header.identity,
      periodId: header.periodId,
    });
    requireValue(reservation.bodyState === 'reclaimed' && reservation.quarantinedAt !== null &&
      reservation.reclamation !== null && reservation.periodId === header.periodId, errorCode);
    requireValue(identity === undefined || sameIdentity(identity, reservation.identity), errorCode);
    identity ??= reservation.identity;
    requireValue(previousInternalQuestionId === null || previousInternalQuestionId < reservation.internalQuestionId,
      errorCode);
    previousInternalQuestionId = reservation.internalQuestionId;
    requireValue(!internalQuestionIds.has(reservation.internalQuestionId) && !questionIds.has(reservation.questionId),
      errorCode);
    internalQuestionIds.add(reservation.internalQuestionId);
    questionIds.add(reservation.questionId);
    if (reservation.deliveryIntent !== null) {
      const { deliveryAttemptId } = reservation.deliveryIntent;
      requireValue(!deliveryAttemptIds.has(deliveryAttemptId), errorCode);
      deliveryAttemptIds.add(deliveryAttemptId);
    }
    return withoutFields(reservation, new Set(['identity', 'periodId']));
  });

  return {
    formatVersion: 1,
    compactionOperationId: capsule.compactionOperationId,
    storeId: capsule.storeId,
    identity,
    periodId: header.periodId,
    reservations,
  };
}

function normalizeDeliveryCapsuleInternal(value) {
  const errorCode = INVALID_DELIVERY_CAPSULE;
  const capsule = captureCapsule(value, DELIVERY_CAPSULE_FIELDS, errorCode);
  const header = capsuleHeader(capsule, errorCode);
  const referencesInput = captureExactRecord(capsule.references, REFERENCE_FIELDS, errorCode);
  const sourceReferencesInput = captureDenseArray(referencesInput.sources, MAX_CAPSULE_ENTRIES, errorCode);
  const targetReferencesInput = captureDenseArray(referencesInput.targets, MAX_CAPSULE_ENTRIES, errorCode);
  const inputDeliveries = captureDenseArray(capsule.deliveries, MAX_CAPSULE_ENTRIES, errorCode);
  requireValue(inputDeliveries.length >= 1 && sourceReferencesInput.length >= 1 &&
    targetReferencesInput.length >= 1, errorCode);

  const sourceSeen = new Map();
  const targetSeen = new Map();
  const sourceReferences = [];
  const targetReferences = [];
  const deliveries = [];
  const deliveryAttemptIds = new Set();
  let previousDeliveryAttemptId = null;

  for (const entry of inputDeliveries) {
    requireValue(!Object.hasOwn(entry, SOURCE_REF_FIELD) && !Object.hasOwn(entry, TARGET_REF_FIELD), errorCode);
    const sourceRefIndex = entry[SOURCE_REF_INDEX_FIELD];
    const targetRefIndex = entry[TARGET_REF_INDEX_FIELD];
    assertSafeUnsignedInteger(sourceRefIndex, errorCode);
    assertSafeUnsignedInteger(targetRefIndex, errorCode);
    requireValue(sourceRefIndex < sourceReferencesInput.length && targetRefIndex < targetReferencesInput.length,
      errorCode);

    const deliveryInput = withoutFields(entry, new Set([SOURCE_REF_INDEX_FIELD, TARGET_REF_INDEX_FIELD]));
    const delivery = normalizeDeliveryRecordV2Local({
      ...deliveryInput,
      sourceRef: sourceReferencesInput[sourceRefIndex],
      targetRef: targetReferencesInput[targetRefIndex],
    });
    requireValue(delivery.recordType === 'reclaimed' && delivery.kind === 'question' &&
      sameIdentity(delivery.targetRef.identity, header.identity) &&
      delivery.targetRef.periodId === header.periodId, errorCode);
    requireValue(previousDeliveryAttemptId === null || previousDeliveryAttemptId < delivery.deliveryAttemptId,
      errorCode);
    previousDeliveryAttemptId = delivery.deliveryAttemptId;
    requireValue(!deliveryAttemptIds.has(delivery.deliveryAttemptId), errorCode);
    deliveryAttemptIds.add(delivery.deliveryAttemptId);

    const canonicalSourceIndex = internReference(
      delivery.sourceRef,
      sourceRefIndex,
      sourceReferencesInput.length,
      sourceSeen,
      sourceReferences,
      errorCode,
    );
    const canonicalTargetIndex = internReference(
      delivery.targetRef,
      targetRefIndex,
      targetReferencesInput.length,
      targetSeen,
      targetReferences,
      errorCode,
    );
    deliveries.push({
      ...withoutFields(delivery, new Set([SOURCE_REF_FIELD, TARGET_REF_FIELD])),
      [SOURCE_REF_INDEX_FIELD]: canonicalSourceIndex,
      [TARGET_REF_INDEX_FIELD]: canonicalTargetIndex,
    });
  }

  requireValue(sourceSeen.size === sourceReferencesInput.length &&
    targetSeen.size === targetReferencesInput.length, errorCode);

  return {
    formatVersion: 1,
    compactionOperationId: capsule.compactionOperationId,
    storeId: capsule.storeId,
    identity: header.identity,
    periodId: header.periodId,
    references: { sources: sourceReferences, targets: targetReferences },
    deliveries,
  };
}

function normalizeCapsule(value, normalizeInternal, maxBytes, tooLargeCode, errorCode) {
  try {
    const normalized = normalizeInternal(value);
    return encodeCapsuleValue(normalized, maxBytes, tooLargeCode).value;
  } catch (error) {
    if (error instanceof RangeError) throw error;
    if (error instanceof TypeError && error.message === errorCode) throw error;
    fail(errorCode);
  }
}

function encodeCapsule(value, normalizeInternal, maxBytes, tooLargeCode, errorCode) {
  try {
    const normalized = normalizeInternal(value);
    return encodeCapsuleValue(normalized, maxBytes, tooLargeCode);
  } catch (error) {
    if (error instanceof RangeError) throw error;
    if (error instanceof TypeError && error.message === errorCode) throw error;
    fail(errorCode);
  }
}

function decodeCapsule(bytes, normalize, maxBytes) {
  const decoded = decodeSourceBytes(bytes, maxBytes);
  return normalize(decoded.value);
}

function normalizeQuestionRejectionCapsule(value) {
  return normalizeCapsule(value, normalizeQuestionCapsuleInternal, CAPSULE_LIMITS.maxQuestionBytes,
    'question_capsule_too_large', INVALID_QUESTION_CAPSULE);
}

function normalizeQuestionDeliveryCapsule(value) {
  return normalizeCapsule(value, normalizeDeliveryCapsuleInternal, CAPSULE_LIMITS.maxCheckpointBytes,
    'question_delivery_capsule_too_large', INVALID_DELIVERY_CAPSULE);
}

function encodeQuestionRejectionCapsule(value) {
  return encodeCapsule(value, normalizeQuestionCapsuleInternal, CAPSULE_LIMITS.maxQuestionBytes,
    'question_capsule_too_large', INVALID_QUESTION_CAPSULE);
}

function encodeQuestionDeliveryCapsule(value) {
  return encodeCapsule(value, normalizeDeliveryCapsuleInternal, CAPSULE_LIMITS.maxCheckpointBytes,
    'question_delivery_capsule_too_large', INVALID_DELIVERY_CAPSULE);
}

function expandQuestionRejectionCapsule(value) {
  const capsule = normalizeQuestionRejectionCapsule(value);
  return capsule.reservations.map((entry) => normalizeQuestionReservation({
    ...entry,
    identity: capsule.identity,
    periodId: capsule.periodId,
  }));
}

function expandQuestionDeliveryCapsule(value) {
  const capsule = normalizeQuestionDeliveryCapsule(value);
  return capsule.deliveries.map((entry) => {
    const { sourceRefIndex, targetRefIndex, ...delivery } = entry;
    return normalizeDeliveryRecordV2Local({
      ...delivery,
      sourceRef: capsule.references.sources[sourceRefIndex],
      targetRef: capsule.references.targets[targetRefIndex],
    });
  });
}

function decodeQuestionRejectionCapsule(bytes) {
  return decodeCapsule(bytes, normalizeQuestionRejectionCapsule, CAPSULE_LIMITS.maxQuestionBytes);
}

function decodeQuestionDeliveryCapsule(bytes) {
  return decodeCapsule(bytes, normalizeQuestionDeliveryCapsule, CAPSULE_LIMITS.maxCheckpointBytes);
}

module.exports = {
  CAPSULE_LIMITS,
  decodeQuestionDeliveryCapsule,
  decodeQuestionRejectionCapsule,
  encodeQuestionDeliveryCapsule,
  encodeQuestionRejectionCapsule,
  expandQuestionDeliveryCapsule,
  expandQuestionRejectionCapsule,
  normalizeQuestionDeliveryCapsule,
  normalizeQuestionRejectionCapsule,
};
