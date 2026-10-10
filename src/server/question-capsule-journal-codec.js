'use strict';

const {
  assertSafeUnsignedInteger,
  assertUuidV4,
} = require('./reclamation-codec-primitives');
const {
  captureFileArray,
  captureFileRecord,
  orderFileRecords,
  preflightFileRow,
} = require('./question-capsule-file-primitives');
const {
  encodeQuestionRejectionCapsule,
  expandQuestionRejectionCapsule,
} = require('./question-rejection-capsule-codec');
const { normalizeQuestionJournalV2Local } = require('./common-question-reclamation-codec');
const { decodeSourceBytes, encodeNormalized } = require('./reclamation-json-codec');

const INVALID_QUESTION_CAPSULE_JOURNAL = 'invalid_question_capsule_journal_v3';
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_RECORDS = 20_000;
const MAX_CAPSULE_ENTRIES = 256;
const QUESTION_FILE_FIELDS = [
  'schemaVersion', 'storeId', 'revision', 'questions', 'reservations', 'migrationAllowance',
  'questionCapsules', 'reservationOrder',
];
const CAPSULE_WRAPPER_FIELDS = ['chunkId', 'capsule'];
const CAPSULE_FIELDS = [
  'formatVersion', 'compactionOperationId', 'storeId', 'identity', 'periodId', 'reservations',
];

function requireValue(condition) {
  if (!condition) throw new TypeError(INVALID_QUESTION_CAPSULE_JOURNAL);
}

function recordField(value, field) {
  return Object.getOwnPropertyDescriptor(value, field)?.value;
}

function compareUuidOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function prepareCapsules(value, storeId, ordinaryReservationCount) {
  const wrappers = captureFileArray(value, MAX_FILE_RECORDS, INVALID_QUESTION_CAPSULE_JOURNAL);
  const chunks = new Set();
  let reservationCount = 0;
  const prepared = wrappers.map((wrapper) => {
    const capturedWrapper = captureFileRecord(wrapper, CAPSULE_WRAPPER_FIELDS, INVALID_QUESTION_CAPSULE_JOURNAL);
    const chunkId = capturedWrapper.chunkId;
    assertUuidV4(chunkId, INVALID_QUESTION_CAPSULE_JOURNAL);
    requireValue(!chunks.has(chunkId));
    chunks.add(chunkId);

    const capsule = captureFileRecord(capturedWrapper.capsule, CAPSULE_FIELDS, INVALID_QUESTION_CAPSULE_JOURNAL);
    const reservations = captureFileArray(capsule.reservations, MAX_CAPSULE_ENTRIES,
      INVALID_QUESTION_CAPSULE_JOURNAL);
    requireValue(reservations.length > 0 && capsule.storeId === storeId);
    reservationCount += reservations.length;
    requireValue(ordinaryReservationCount + reservationCount <= MAX_FILE_RECORDS);
    capsule.reservations = reservations;
    return { chunkId, capsule, reservationCount: reservations.length };
  });
  return { capsules: prepared, reservationCount };
}

function readRecordId(record) {
  const id = recordField(record, 'internalQuestionId');
  requireValue(typeof id === 'string');
  return id;
}

function normalizeQuestionCapsuleJournalV3Internal(value) {
  const file = captureFileRecord(value, QUESTION_FILE_FIELDS, INVALID_QUESTION_CAPSULE_JOURNAL);
  requireValue(file.schemaVersion === 3 && file.migrationAllowance === null);
  assertUuidV4(file.storeId, INVALID_QUESTION_CAPSULE_JOURNAL);
  assertSafeUnsignedInteger(file.revision, INVALID_QUESTION_CAPSULE_JOURNAL);

  const questionsInput = captureFileArray(file.questions, MAX_FILE_RECORDS, INVALID_QUESTION_CAPSULE_JOURNAL);
  const reservationsInput = captureFileArray(file.reservations, MAX_FILE_RECORDS,
    INVALID_QUESTION_CAPSULE_JOURNAL);
  const reservationOrder = captureFileArray(file.reservationOrder, MAX_FILE_RECORDS,
    INVALID_QUESTION_CAPSULE_JOURNAL);
  const preparedCapsules = prepareCapsules(file.questionCapsules, file.storeId, reservationsInput.length);
  const fullReservationCount = reservationsInput.length + preparedCapsules.reservationCount;
  requireValue(questionsInput.length <= MAX_FILE_RECORDS && fullReservationCount <= MAX_FILE_RECORDS &&
    reservationOrder.length === fullReservationCount &&
    reservationOrder.every((id) => typeof id === 'string'));

  for (const question of questionsInput) preflightFileRow(question, INVALID_QUESTION_CAPSULE_JOURNAL);
  for (const reservation of reservationsInput) {
    preflightFileRow(reservation, INVALID_QUESTION_CAPSULE_JOURNAL);
  }
  for (const { capsule } of preparedCapsules.capsules) {
    preflightFileRow(capsule, INVALID_QUESTION_CAPSULE_JOURNAL);
  }

  const normalReservationIds = reservationsInput.map((reservation) => {
    const id = recordField(reservation, 'internalQuestionId');
    requireValue(typeof id === 'string');
    return id;
  });
  const normalReservationIdSet = new Set(normalReservationIds);
  requireValue(normalReservationIdSet.size === normalReservationIds.length);

  const normalizedCapsules = [];
  const expandedCapsuleReservations = [];
  let encodedCapsuleBytes = 0;
  for (const { chunkId, capsule } of preparedCapsules.capsules) {
    const encodedCapsule = encodeQuestionRejectionCapsule(capsule);
    encodedCapsuleBytes += encodedCapsule.sizeBytes;
    requireValue(encodedCapsuleBytes <= MAX_FILE_BYTES);
    normalizedCapsules.push({ chunkId, capsule: encodedCapsule.value });
    expandedCapsuleReservations.push(...expandQuestionRejectionCapsule(encodedCapsule.value));
  }
  normalizedCapsules.sort((left, right) => compareUuidOrdinal(left.chunkId, right.chunkId));

  const expandedReservationCount = reservationsInput.length + expandedCapsuleReservations.length;
  requireValue(expandedReservationCount === fullReservationCount && expandedReservationCount <= MAX_FILE_RECORDS);
  const fullReservationsInOrder = orderFileRecords(
    [...reservationsInput, ...expandedCapsuleReservations],
    reservationOrder,
    'internalQuestionId',
    INVALID_QUESTION_CAPSULE_JOURNAL,
  );

  const fullReservationIds = fullReservationsInOrder.map(readRecordId);
  const ordinaryIdsInDeclaredOrder = fullReservationIds.filter((id) => normalReservationIdSet.has(id));
  requireValue(ordinaryIdsInDeclaredOrder.length === normalReservationIds.length &&
    ordinaryIdsInDeclaredOrder.every((id, index) => id === normalReservationIds[index]));

  const oldJournal = normalizeQuestionJournalV2Local({
    schemaVersion: 2,
    storeId: file.storeId,
    revision: file.revision,
    questions: questionsInput,
    reservations: fullReservationsInOrder,
    migrationAllowance: null,
  }, MAX_FILE_RECORDS);
  const normalizedOrdinaryReservations = oldJournal.reservations.filter((reservation) => {
    if (!normalReservationIdSet.has(reservation.internalQuestionId)) return false;
    return true;
  });
  requireValue(normalizedOrdinaryReservations.length === reservationsInput.length);

  const normalizedFile = {
    schemaVersion: 3,
    storeId: oldJournal.storeId,
    revision: oldJournal.revision,
    questions: oldJournal.questions,
    reservations: normalizedOrdinaryReservations,
    migrationAllowance: null,
    questionCapsules: normalizedCapsules,
    reservationOrder: fullReservationIds,
  };
  const encoded = encodeNormalized(normalizedFile);
  requireValue(encoded.sizeBytes <= MAX_FILE_BYTES);
  return { ...encoded, value: normalizedFile };
}

function withUnifiedError(operation) {
  try {
    return operation();
  } catch {
    throw new TypeError(INVALID_QUESTION_CAPSULE_JOURNAL);
  }
}

function normalizeQuestionCapsuleJournalV3Local(value) {
  return withUnifiedError(() => normalizeQuestionCapsuleJournalV3Internal(value).value);
}

function encodeQuestionCapsuleJournalV3Local(value) {
  return withUnifiedError(() => normalizeQuestionCapsuleJournalV3Internal(value));
}

function decodeQuestionCapsuleJournalV3Local(bytes) {
  return withUnifiedError(() => {
    const decoded = decodeSourceBytes(bytes, MAX_FILE_BYTES);
    return normalizeQuestionCapsuleJournalV3Internal(decoded.value).value;
  });
}

module.exports = {
  decodeQuestionCapsuleJournalV3Local,
  encodeQuestionCapsuleJournalV3Local,
  normalizeQuestionCapsuleJournalV3Local,
};
