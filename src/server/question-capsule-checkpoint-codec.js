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
  encodeQuestionDeliveryCapsule,
  expandQuestionDeliveryCapsule,
} = require('./question-rejection-capsule-codec');
const { normalizeCheckpointV3Local } = require('./delivery-reclamation-codec');
const { decodeSourceBytes, encodeNormalized } = require('./reclamation-json-codec');

const INVALID_CAPSULE_CHECKPOINT = 'invalid_capsule_checkpoint_v4';
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_RECORDS = 20_000;
const MAX_CHECKPOINT_REGISTRATION_RECORDS = 50_000;
const MAX_DELIVERIES = 20_000;
const MAX_NOTIFICATION_TARGETS = 10_000;
const MAX_LOGICAL_TOMBSTONES = 20_000;
const MAX_CAPSULE_ENTRIES = 256;
const CHECKPOINT_FILE_FIELDS = [
  'schemaVersion', 'storeId', 'revision', 'registrations', 'ledger', 'migrationAllowance',
  'checkpointCapsules', 'deliveryAttemptOrder',
];
const REGISTRATION_FIELDS = [
  'conversations', 'executions', 'launches', 'runtimeLaunches', 'connections', 'actors', 'handoffs',
  'replayClaims', 'incompleteConversationIds',
];
const LEDGER_FIELDS = ['schemaVersion', 'revision', 'deliveries', 'notificationTargets', 'logicalTombstones'];
const CAPSULE_WRAPPER_FIELDS = ['chunkId', 'capsule'];
const DELIVERY_CAPSULE_FIELDS = [
  'formatVersion', 'compactionOperationId', 'storeId', 'identity', 'periodId', 'references', 'deliveries',
];
const REFERENCE_FIELDS = ['sources', 'targets'];

function requireValue(condition) {
  if (!condition) throw new TypeError(INVALID_CAPSULE_CHECKPOINT);
}

function recordField(value, field) {
  return Object.getOwnPropertyDescriptor(value, field)?.value;
}

function compareUuidOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function prepareCapsules(value, storeId, ordinaryDeliveryCount) {
  const wrappers = captureFileArray(value, MAX_FILE_RECORDS, INVALID_CAPSULE_CHECKPOINT);
  const chunks = new Set();
  let deliveryCount = 0;
  const prepared = wrappers.map((wrapper) => {
    const capturedWrapper = captureFileRecord(wrapper, CAPSULE_WRAPPER_FIELDS, INVALID_CAPSULE_CHECKPOINT);
    const chunkId = capturedWrapper.chunkId;
    assertUuidV4(chunkId, INVALID_CAPSULE_CHECKPOINT);
    requireValue(!chunks.has(chunkId));
    chunks.add(chunkId);

    const capsule = captureFileRecord(capturedWrapper.capsule, DELIVERY_CAPSULE_FIELDS,
      INVALID_CAPSULE_CHECKPOINT);
    requireValue(capsule.formatVersion === 1 && capsule.storeId === storeId);
    assertUuidV4(capsule.compactionOperationId, INVALID_CAPSULE_CHECKPOINT);
    assertUuidV4(capsule.storeId, INVALID_CAPSULE_CHECKPOINT);

    const references = captureFileRecord(capsule.references, REFERENCE_FIELDS, INVALID_CAPSULE_CHECKPOINT);
    const sources = captureFileArray(references.sources, MAX_CAPSULE_ENTRIES, INVALID_CAPSULE_CHECKPOINT);
    const targets = captureFileArray(references.targets, MAX_CAPSULE_ENTRIES, INVALID_CAPSULE_CHECKPOINT);
    const deliveries = captureFileArray(capsule.deliveries, MAX_CAPSULE_ENTRIES, INVALID_CAPSULE_CHECKPOINT);
    requireValue(deliveries.length >= 1 && sources.length >= 1 && targets.length >= 1 &&
      sources.length <= deliveries.length && targets.length <= deliveries.length);

    deliveryCount += deliveries.length;
    requireValue(ordinaryDeliveryCount + deliveryCount <= MAX_DELIVERIES);
    return { chunkId, capsule, deliveryCount: deliveries.length };
  });

  return { capsules: prepared, deliveryCount };
}

function normalizeCapsuleCheckpointV4Internal(value) {
  const file = captureFileRecord(value, CHECKPOINT_FILE_FIELDS, INVALID_CAPSULE_CHECKPOINT);
  requireValue(file.schemaVersion === 4 && file.migrationAllowance === null);
  assertUuidV4(file.storeId, INVALID_CAPSULE_CHECKPOINT);
  assertSafeUnsignedInteger(file.revision, INVALID_CAPSULE_CHECKPOINT);

  const registrationInput = captureFileRecord(file.registrations, REGISTRATION_FIELDS,
    INVALID_CAPSULE_CHECKPOINT);
  const registrationArrays = Object.create(null);
  let registrationCount = 0;
  for (const field of REGISTRATION_FIELDS) {
    const rows = captureFileArray(registrationInput[field], MAX_CHECKPOINT_REGISTRATION_RECORDS,
      INVALID_CAPSULE_CHECKPOINT);
    registrationCount += rows.length;
    requireValue(registrationCount <= MAX_CHECKPOINT_REGISTRATION_RECORDS);
    registrationArrays[field] = rows;
  }

  const ledgerInput = captureFileRecord(file.ledger, LEDGER_FIELDS, INVALID_CAPSULE_CHECKPOINT);
  requireValue(ledgerInput.schemaVersion === 2);
  assertSafeUnsignedInteger(ledgerInput.revision, INVALID_CAPSULE_CHECKPOINT);
  const ordinaryDeliveries = captureFileArray(ledgerInput.deliveries, MAX_DELIVERIES,
    INVALID_CAPSULE_CHECKPOINT);
  const notificationTargets = captureFileArray(ledgerInput.notificationTargets, MAX_NOTIFICATION_TARGETS,
    INVALID_CAPSULE_CHECKPOINT);
  const logicalTombstones = captureFileArray(ledgerInput.logicalTombstones, MAX_LOGICAL_TOMBSTONES,
    INVALID_CAPSULE_CHECKPOINT);
  const deliveryAttemptOrder = captureFileArray(file.deliveryAttemptOrder, MAX_DELIVERIES,
    INVALID_CAPSULE_CHECKPOINT);

  const preparedCapsules = prepareCapsules(file.checkpointCapsules, file.storeId, ordinaryDeliveries.length);
  const fullDeliveryCount = ordinaryDeliveries.length + preparedCapsules.deliveryCount;
  requireValue(deliveryAttemptOrder.length === fullDeliveryCount);

  for (const field of REGISTRATION_FIELDS) {
    for (const row of registrationArrays[field]) preflightFileRow(row, INVALID_CAPSULE_CHECKPOINT);
  }
  for (const row of ordinaryDeliveries) preflightFileRow(row, INVALID_CAPSULE_CHECKPOINT);
  for (const row of notificationTargets) preflightFileRow(row, INVALID_CAPSULE_CHECKPOINT);
  for (const row of logicalTombstones) preflightFileRow(row, INVALID_CAPSULE_CHECKPOINT);
  for (const { capsule } of preparedCapsules.capsules) preflightFileRow(capsule, INVALID_CAPSULE_CHECKPOINT);

  const normalDeliveryIds = ordinaryDeliveries.map((delivery) => {
    const id = recordField(delivery, 'deliveryAttemptId');
    requireValue(typeof id === 'string');
    return id;
  });
  const normalDeliveryIdSet = new Set(normalDeliveryIds);
  requireValue(normalDeliveryIdSet.size === normalDeliveryIds.length);

  const normalizedCapsules = [];
  const expandedCapsuleDeliveries = [];
  let encodedCapsuleBytes = 0;
  for (const { chunkId, capsule } of preparedCapsules.capsules) {
    const encodedCapsule = encodeQuestionDeliveryCapsule(capsule);
    encodedCapsuleBytes += encodedCapsule.sizeBytes;
    requireValue(encodedCapsuleBytes <= MAX_FILE_BYTES);
    normalizedCapsules.push({ chunkId, capsule: encodedCapsule.value });
    expandedCapsuleDeliveries.push(...expandQuestionDeliveryCapsule(encodedCapsule.value));
  }
  normalizedCapsules.sort((left, right) => compareUuidOrdinal(left.chunkId, right.chunkId));

  const fullDeliveries = [...ordinaryDeliveries, ...expandedCapsuleDeliveries];
  requireValue(fullDeliveries.length === fullDeliveryCount);
  const fullDeliveriesInOrder = orderFileRecords(
    fullDeliveries,
    deliveryAttemptOrder,
    'deliveryAttemptId',
    INVALID_CAPSULE_CHECKPOINT,
  );
  const ordinaryIdsInDeclaredOrder = fullDeliveriesInOrder
    .filter((delivery) => normalDeliveryIdSet.has(recordField(delivery, 'deliveryAttemptId')))
    .map((delivery) => recordField(delivery, 'deliveryAttemptId'));
  requireValue(ordinaryIdsInDeclaredOrder.length === normalDeliveryIds.length &&
    ordinaryIdsInDeclaredOrder.every((id, index) => id === normalDeliveryIds[index]));

  const legacyCheckpoint = normalizeCheckpointV3Local({
    schemaVersion: 3,
    storeId: file.storeId,
    revision: file.revision,
    registrations: registrationInput,
    ledger: {
      schemaVersion: 2,
      revision: ledgerInput.revision,
      deliveries: fullDeliveriesInOrder,
      notificationTargets,
      logicalTombstones,
    },
    migrationAllowance: null,
  }, MAX_CHECKPOINT_REGISTRATION_RECORDS);
  const normalizedOrdinaryDeliveries = legacyCheckpoint.ledger.deliveries.filter((delivery) =>
    normalDeliveryIdSet.has(delivery.deliveryAttemptId));
  requireValue(normalizedOrdinaryDeliveries.length === ordinaryDeliveries.length);

  const normalizedFile = {
    schemaVersion: 4,
    storeId: legacyCheckpoint.storeId,
    revision: legacyCheckpoint.revision,
    registrations: legacyCheckpoint.registrations,
    ledger: {
      schemaVersion: 2,
      revision: legacyCheckpoint.ledger.revision,
      deliveries: normalizedOrdinaryDeliveries,
      notificationTargets: legacyCheckpoint.ledger.notificationTargets,
      logicalTombstones: legacyCheckpoint.ledger.logicalTombstones,
    },
    migrationAllowance: null,
    checkpointCapsules: normalizedCapsules,
    deliveryAttemptOrder: legacyCheckpoint.ledger.deliveries.map((delivery) => delivery.deliveryAttemptId),
  };
  const encoded = encodeNormalized(normalizedFile);
  requireValue(encoded.sizeBytes <= MAX_FILE_BYTES);
  return { value: normalizedFile, ...encoded };
}

function withUnifiedError(operation) {
  try {
    return operation();
  } catch {
    throw new TypeError(INVALID_CAPSULE_CHECKPOINT);
  }
}

/** 内包deliveryを復元して旧checkpoint局所schemaを検査し、CP4 fileを返す。 */
function normalizeCapsuleCheckpointV4Local(value) {
  return withUnifiedError(() => normalizeCapsuleCheckpointV4Internal(value).value);
}

function encodeCapsuleCheckpointV4Local(value) {
  return withUnifiedError(() => normalizeCapsuleCheckpointV4Internal(value));
}

/** raw byte上限をparse前に適用してCP4 fileをdecodeする。 */
function decodeCapsuleCheckpointV4Local(bytes) {
  return withUnifiedError(() => {
    const decoded = decodeSourceBytes(bytes, MAX_FILE_BYTES);
    return normalizeCapsuleCheckpointV4Internal(decoded.value).value;
  });
}

module.exports = {
  decodeCapsuleCheckpointV4Local,
  encodeCapsuleCheckpointV4Local,
  normalizeCapsuleCheckpointV4Local,
};
