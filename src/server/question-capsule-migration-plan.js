'use strict';

const { types } = require('node:util');
const {
  assertIdentifier,
  assertSafeUnsignedInteger,
  assertUuidV4,
} = require('./reclamation-codec-primitives');
const {
  captureFileArray: captureDenseArray,
  captureFileRecord: captureExactRecord,
} = require('./question-capsule-file-primitives');
const {
  normalizeCheckpointV3Local,
  normalizeInstructionJournalV2Local,
} = require('./delivery-reclamation-codec');
const { normalizeQuestionJournalV2Local } = require('./common-question-reclamation-codec');
const {
  FIXED_H_BOUNDS,
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
  checkedCapacityAdd,
} = require('./reclamation-capacity-bounds');
const {
  normalizeQuestionReclamationAnchorV1Local,
} = require('./question-reclamation-anchor-codec');
const {
  decodeCapsuleCheckpointV4Local,
  encodeCapsuleCheckpointV4Local,
} = require('./question-capsule-checkpoint-codec');
const {
  decodeQuestionCapsuleJournalV3Local,
  encodeQuestionCapsuleJournalV3Local,
} = require('./question-capsule-journal-codec');
const { validateQuestionCapsuleFiles } = require('./question-capsule-files-validation');
const {
  CAPSULE_LIMITS,
  encodeQuestionDeliveryCapsule,
  encodeQuestionRejectionCapsule,
} = require('./question-rejection-capsule-codec');
const { decodeSourceBytes, encodeNormalized } = require('./reclamation-json-codec');
const { validateQuestionCapsuleWholeRepresentation } = require('./question-capsule-whole-validation');

const INVALID_PLAN = 'invalid_question_capsule_file_migration_plan';
const INPUT_FIELDS = ['sourceBytes', 'normalByteLimitsBySlot', 'selection', 'operationId', 'chunkIds'];
const SOURCE_FIELDS = ['anchor', 'questions', 'checkpoint', 'instructions'];
const LIMIT_FIELDS = ['questions', 'checkpoint', 'instructions'];
const SELECTION_FIELDS = ['identity', 'periodId', 'internalQuestionIds'];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const SHARED_QUESTION_FIELDS = new Set(['identity', 'periodId']);
const SHARED_DELIVERY_FIELDS = new Set(['sourceRef', 'targetRef']);
const MAX_SELECTION_SCOPES = 20_000;
const MAX_SELECTED_IDS = 20_000;
const MAX_CHUNK_IDS = 20_000;
const SCOPE_LIMITATIONS = Object.freeze([
  'source_path_freshness_not_verified',
  'persistent_outer_schema_not_verified',
  'persistence_recovery_not_verified',
  'new_outer_future_capacity_not_verified',
  'prepare_and_atomic_peak_not_verified',
  'count_capacity_release_not_verified',
  'runtime_integration_not_verified',
]);

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getTypedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const getTypedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const getTypedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;

function requireValue(condition) {
  if (!condition) throw new TypeError(INVALID_PLAN);
}

function readRawBytes(value, maximumBytes) {
  requireValue(value !== null && typeof value === 'object' && !types.isProxy(value) &&
    types.isUint8Array(value));
  let buffer;
  let byteLength;
  try {
    buffer = Reflect.apply(getTypedArrayBuffer, value, []);
    byteLength = Reflect.apply(getTypedArrayByteLength, value, []);
    Reflect.apply(getTypedArrayByteOffset, value, []);
  } catch {
    throw new TypeError(INVALID_PLAN);
  }
  requireValue(types.isArrayBuffer(buffer) && !types.isSharedArrayBuffer(buffer) &&
    Number.isSafeInteger(byteLength) && byteLength <= maximumBytes);
  return decodeSourceBytes(value, maximumBytes);
}

function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function identityPeriodKey(identity, periodId) {
  return IDENTITY_FIELDS.map((field) => identity[field]).concat(periodId)
    .map((value) => `${value.length}:${value}`).join('');
}

function sameValue(left, right) {
  if (left === right) return true;
  if (left === null || right === null || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length &&
      left.every((value, index) => sameValue(value, right[index]));
  }
  const leftKeys = Object.keys(left);
  const rightKeys = Object.keys(right);
  return leftKeys.length === rightKeys.length && leftKeys.every((key) =>
    Object.hasOwn(right, key) && sameValue(left[key], right[key]));
}

function compareOrdinal(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function withoutFields(record, omittedFields) {
  const result = {};
  for (const key of Object.keys(record)) {
    if (!omittedFields.has(key)) result[key] = record[key];
  }
  return result;
}

function captureSelection(value) {
  const rawScopes = captureDenseArray(value, MAX_SELECTION_SCOPES, INVALID_PLAN);
  requireValue(rawScopes.length > 0);
  const scopes = [];
  const scopeKeys = new Set();
  const allIds = new Set();
  let selectedCount = 0;
  for (const rawScope of rawScopes) {
    const scope = captureExactRecord(rawScope, SELECTION_FIELDS, INVALID_PLAN);
    const identity = captureExactRecord(scope.identity, IDENTITY_FIELDS, INVALID_PLAN);
    requireValue((identity.provider === 'claude' && identity.nativeIdKind === 'session') ||
      (identity.provider === 'codex' && identity.nativeIdKind === 'thread'));
    for (const field of IDENTITY_FIELDS.slice(2)) assertIdentifier(identity[field], INVALID_PLAN);
    assertIdentifier(scope.periodId, INVALID_PLAN);
    const internalQuestionIds = captureDenseArray(scope.internalQuestionIds, MAX_SELECTED_IDS, INVALID_PLAN);
    requireValue(internalQuestionIds.length > 0);
    const key = identityPeriodKey(identity, scope.periodId);
    requireValue(!scopeKeys.has(key));
    scopeKeys.add(key);
    const localIds = new Set();
    for (const id of internalQuestionIds) {
      assertIdentifier(id, INVALID_PLAN);
      requireValue(!localIds.has(id) && !allIds.has(id));
      localIds.add(id);
      allIds.add(id);
      selectedCount += 1;
      requireValue(selectedCount <= MAX_SELECTED_IDS);
    }
    scopes.push({
      identity,
      periodId: scope.periodId,
      key,
      internalQuestionIds: [...localIds].sort(compareOrdinal),
    });
  }
  scopes.sort((left, right) => compareOrdinal(left.key, right.key));
  return { scopes, selectedCount };
}

function captureChunkIds(value) {
  const chunkIds = captureDenseArray(value, MAX_CHUNK_IDS, INVALID_PLAN);
  const seen = new Set();
  for (const chunkId of chunkIds) {
    assertUuidV4(chunkId, INVALID_PLAN);
    requireValue(!seen.has(chunkId));
    seen.add(chunkId);
  }
  return chunkIds;
}

function capturePlannerInput(value) {
  const input = captureExactRecord(value, INPUT_FIELDS, INVALID_PLAN);
  const sourceBytes = captureExactRecord(input.sourceBytes, SOURCE_FIELDS, INVALID_PLAN);
  const normalByteLimitsBySlot = captureExactRecord(input.normalByteLimitsBySlot, LIMIT_FIELDS, INVALID_PLAN);
  const limits = Object.create(null);
  for (const slot of LIMIT_FIELDS) {
    if (sourceBytes[slot] === null) {
      requireValue(normalByteLimitsBySlot[slot] === null);
      limits[slot] = null;
    } else {
      assertSafeUnsignedInteger(normalByteLimitsBySlot[slot], INVALID_PLAN);
      requireValue(normalByteLimitsBySlot[slot] > 0 && normalByteLimitsBySlot[slot] <= MAX_SOURCE_BYTES);
      limits[slot] = normalByteLimitsBySlot[slot];
    }
  }
  requireValue(sourceBytes.anchor !== null);
  assertUuidV4(input.operationId, INVALID_PLAN);
  const selection = captureSelection(input.selection);
  const chunkIds = captureChunkIds(input.chunkIds);
  const anchorDecoded = readRawBytes(sourceBytes.anchor, NORMAL_ANCHOR_MAX_BYTES);
  const decodedSlots = Object.create(null);
  const rawFingerprints = Object.create(null);
  for (const slot of LIMIT_FIELDS) {
    const raw = sourceBytes[slot];
    if (raw === null) {
      decodedSlots[slot] = null;
      rawFingerprints[slot] = null;
      continue;
    }
    const maximumBytes = slot === 'instructions'
      ? checkedCapacityAdd(MAX_SOURCE_BYTES, FIXED_H_BOUNDS.instructions)
      : limits[slot];
    const decoded = readRawBytes(raw, maximumBytes);
    decodedSlots[slot] = decoded;
    rawFingerprints[slot] = { sizeBytes: decoded.sizeBytes, sha256: decoded.sha256 };
  }
  const anchor = normalizeQuestionReclamationAnchorV1Local(anchorDecoded.value);
  requireValue(anchor.migration === null);
  const stores = {
    questions: decodedSlots.questions === null
      ? null
      : normalizeQuestionJournalV2Local(decodedSlots.questions.value),
    checkpoint: decodedSlots.checkpoint === null
      ? null
      : normalizeCheckpointV3Local(decodedSlots.checkpoint.value),
    instructions: decodedSlots.instructions === null
      ? null
      : normalizeInstructionJournalV2Local(decodedSlots.instructions.value),
  };
  requireValue(stores.questions === null || stores.questions.migrationAllowance === null);
  requireValue(stores.checkpoint === null || stores.checkpoint.migrationAllowance === null);

  const wholeInput = {
    formatVersion: 1,
    anchor,
    ordinaryStores: stores,
    capsulePairs: [],
    deliveryAttemptOrder: stores.checkpoint?.ledger.deliveries.map((delivery) =>
      delivery.deliveryAttemptId) ?? [],
    questionReservationOrder: stores.questions?.reservations.map((reservation) =>
      reservation.internalQuestionId) ?? [],
    normalByteLimitsBySlot: limits,
  };
  const whole = validateQuestionCapsuleWholeRepresentation(wholeInput);
  for (const slot of LIMIT_FIELDS) {
    const decoded = decodedSlots[slot];
    if (decoded === null) continue;
    const rawLimit = slot === 'instructions'
      ? checkedCapacityAdd(limits[slot], whole.snapshot.stores.instructions.migrationAllowance?.maxExtraBytes ?? 0)
      : limits[slot];
    requireValue(decoded.sizeBytes <= rawLimit);
  }
  return {
    anchor,
    stores: whole.snapshot.stores,
    wholeInput,
    whole,
    normalByteLimitsBySlot: limits,
    sourceFingerprints: {
      anchor: { sizeBytes: anchorDecoded.sizeBytes, sha256: anchorDecoded.sha256 },
      questions: rawFingerprints.questions,
      checkpoint: rawFingerprints.checkpoint,
      instructions: rawFingerprints.instructions,
    },
    selection,
    operationId: input.operationId,
    chunkIds,
  };
}

function logicalKeyForDelivery(delivery) {
  const targetLaunchKey = delivery.kind !== 'pr-notification'
    ? null
    : delivery.recordType === 'detail'
      ? delivery.target.launchKey
      : delivery.targetRef.launchKey;
  return encodeNormalized([
    delivery.kind,
    delivery.kind === 'pr-notification' ? null : delivery.sourceExecutionId,
    delivery.logicalMessageId,
    delivery.revision,
    targetLaunchKey,
  ]).bytes.toString('utf8');
}

function resolveSelection(input) {
  const stores = input.stores;
  requireValue(stores.questions !== null);
  const retiredScopes = new Set(input.anchor.retiredQuestionPeriods.map((period) =>
    identityPeriodKey(period.identity, period.periodId)));
  const reservationsById = new Map(stores.questions.reservations.map((reservation) =>
    [reservation.internalQuestionId, reservation]));
  const deliveries = stores.checkpoint?.ledger.deliveries ?? [];
  const deliveriesByAttempt = new Map(deliveries.map((delivery) => [delivery.deliveryAttemptId, delivery]));
  const selectedReservations = [];
  const selectedReservationIds = new Set();
  const selectedDeliveries = [];
  const selectedDeliveryIds = new Set();
  const selectedLogicalKeys = new Map();
  const scopes = [];

  for (const scope of input.selection.scopes) {
    requireValue(retiredScopes.has(scope.key));
    const selectedInScope = [];
    for (const internalQuestionId of scope.internalQuestionIds) {
      const reservation = reservationsById.get(internalQuestionId);
      requireValue(reservation !== undefined && sameIdentity(reservation.identity, scope.identity) &&
        reservation.periodId === scope.periodId && reservation.bodyState === 'reclaimed' &&
        reservation.quarantinedAt !== null && reservation.reclamation !== null);
      requireValue(!selectedReservationIds.has(internalQuestionId));
      selectedReservationIds.add(internalQuestionId);
      selectedReservations.push(reservation);
      selectedInScope.push(reservation);

      const intent = reservation.deliveryIntent;
      const delivery = intent === null ? undefined : deliveriesByAttempt.get(intent.deliveryAttemptId);
      if (reservation.reclamation.deliveryPresence === 'checkpoint') {
        requireValue(delivery !== undefined && delivery.recordType === 'reclaimed' && delivery.kind === 'question');
        requireValue(delivery.deliveryAttemptId === intent.deliveryAttemptId);
        selectedDeliveryIds.add(delivery.deliveryAttemptId);
        selectedDeliveries.push(delivery);
        selectedLogicalKeys.set(logicalKeyForDelivery(delivery), true);
      } else {
        requireValue(reservation.reclamation.deliveryPresence === 'none' ||
          reservation.reclamation.deliveryPresence === 'indeterminate');
        requireValue(delivery === undefined);
      }
    }
    scopes.push({ identity: scope.identity, periodId: scope.periodId, key: scope.key, reservations: selectedInScope });
  }

  for (const delivery of deliveries) {
    if (delivery.kind !== 'question') continue;
    const key = logicalKeyForDelivery(delivery);
    if (selectedLogicalKeys.has(key)) requireValue(selectedDeliveryIds.has(delivery.deliveryAttemptId));
  }

  selectedDeliveries.sort((left, right) => compareOrdinal(left.deliveryAttemptId, right.deliveryAttemptId));
  return {
    scopes,
    selectedReservations,
    selectedReservationIds,
    selectedDeliveries,
    selectedDeliveryIds,
  };
}

function capsuleQuestionValue(reservations, scope, operationId, storeId) {
  return {
    formatVersion: 1,
    compactionOperationId: operationId,
    storeId,
    identity: scope.identity,
    periodId: scope.periodId,
    reservations: reservations.map((reservation) => withoutFields(reservation, SHARED_QUESTION_FIELDS)),
  };
}

function capsuleDeliveryValue(deliveries, scope, operationId, storeId) {
  if (deliveries.length === 0) return null;
  const sources = [];
  const targets = [];
  const sourceIndexes = new Map();
  const targetIndexes = new Map();
  const intern = (reference, values, indexes) => {
    const key = encodeNormalized(reference).bytes.toString('utf8');
    if (indexes.has(key)) return indexes.get(key);
    const index = values.length;
    indexes.set(key, index);
    values.push(reference);
    return index;
  };
  const deliveryEntries = [...deliveries]
    .sort((left, right) => compareOrdinal(left.deliveryAttemptId, right.deliveryAttemptId))
    .map((delivery) => ({
      ...withoutFields(delivery, SHARED_DELIVERY_FIELDS),
      sourceRefIndex: intern(delivery.sourceRef, sources, sourceIndexes),
      targetRefIndex: intern(delivery.targetRef, targets, targetIndexes),
    }));
  return {
    formatVersion: 1,
    compactionOperationId: operationId,
    storeId,
    identity: scope.identity,
    periodId: scope.periodId,
    references: { sources, targets },
    deliveries: deliveryEntries,
  };
}

function encodeCandidateChunk(reservations, scope, selection, operationId, storeId) {
  const questionValue = capsuleQuestionValue(reservations, scope, operationId, storeId);
  const questionCapsule = encodeQuestionRejectionCapsule(questionValue);
  const selectedAttempts = new Set(reservations.flatMap((reservation) =>
    reservation.deliveryIntent === null ? [] : [reservation.deliveryIntent.deliveryAttemptId]));
  const deliveries = selection.selectedDeliveries.filter((delivery) =>
    selectedAttempts.has(delivery.deliveryAttemptId));
  requireValue(deliveries.length <= CAPSULE_LIMITS.maxDeliveryEntries);
  const checkpointValue = capsuleDeliveryValue(deliveries, scope, operationId, storeId);
  const checkpointCapsule = checkpointValue === null ? null : encodeQuestionDeliveryCapsule(checkpointValue);
  return { questionCapsule, checkpointCapsule };
}

function isCapsuleSizeError(error) {
  return error instanceof RangeError &&
    (error.message === 'question_capsule_too_large' || error.message === 'question_delivery_capsule_too_large');
}

function packScope(scope, selection, operationId, storeId) {
  const reservations = [...scope.reservations]
    .sort((left, right) => compareOrdinal(left.internalQuestionId, right.internalQuestionId));
  const chunks = [];
  let current = [];
  let currentEncoded = null;
  for (const reservation of reservations) {
    if (current.length >= CAPSULE_LIMITS.maxQuestionEntries) {
      chunks.push({
        scope,
        reservations: current,
        questionCapsule: currentEncoded.questionCapsule,
        checkpointCapsule: currentEncoded.checkpointCapsule,
      });
      current = [];
      currentEncoded = null;
    }
    const candidate = [...current, reservation];
    try {
      currentEncoded = encodeCandidateChunk(candidate, scope, selection, operationId, storeId);
      current = candidate;
    } catch (error) {
      if (!isCapsuleSizeError(error)) throw error;
      requireValue(current.length > 0);
      chunks.push({
        scope,
        reservations: current,
        questionCapsule: currentEncoded.questionCapsule,
        checkpointCapsule: currentEncoded.checkpointCapsule,
      });
      current = [reservation];
      currentEncoded = encodeCandidateChunk(current, scope, selection, operationId, storeId);
    }
  }
  if (current.length > 0) {
    chunks.push({
      scope,
      reservations: current,
      questionCapsule: currentEncoded.questionCapsule,
      checkpointCapsule: currentEncoded.checkpointCapsule,
    });
  }
  return chunks;
}

function makeTargets(input, selection) {
  const questionStore = input.stores.questions;
  const checkpointStore = input.stores.checkpoint;
  const storeId = input.anchor.storeId;
  const chunks = selection.scopes.flatMap((scope) =>
    packScope(scope, selection, input.operationId, storeId));
  requireValue(chunks.length > 0 && chunks.length <= input.chunkIds.length);
  const chunksWithIds = chunks.map((chunk, index) => ({ ...chunk, chunkId: input.chunkIds[index] }));

  const questionFile = {
    schemaVersion: 3,
    storeId: questionStore.storeId,
    revision: questionStore.revision,
    questions: questionStore.questions,
    reservations: questionStore.reservations.filter((reservation) =>
      !selection.selectedReservationIds.has(reservation.internalQuestionId)),
    migrationAllowance: null,
    questionCapsules: chunksWithIds.map((chunk) => ({ chunkId: chunk.chunkId, capsule: chunk.questionCapsule.value })),
    reservationOrder: questionStore.reservations.map((reservation) => reservation.internalQuestionId),
  };

  let checkpointFile = null;
  if (checkpointStore !== null) {
    checkpointFile = {
      schemaVersion: 4,
      storeId: checkpointStore.storeId,
      revision: checkpointStore.revision,
      registrations: checkpointStore.registrations,
      ledger: {
        schemaVersion: checkpointStore.ledger.schemaVersion,
        revision: checkpointStore.ledger.revision,
        deliveries: checkpointStore.ledger.deliveries.filter((delivery) =>
          !selection.selectedDeliveryIds.has(delivery.deliveryAttemptId)),
        notificationTargets: checkpointStore.ledger.notificationTargets,
        logicalTombstones: checkpointStore.ledger.logicalTombstones,
      },
      migrationAllowance: null,
      checkpointCapsules: chunksWithIds.flatMap((chunk) => chunk.checkpointCapsule === null
        ? []
        : [{ chunkId: chunk.chunkId, capsule: chunk.checkpointCapsule.value }]),
      deliveryAttemptOrder: checkpointStore.ledger.deliveries.map((delivery) => delivery.deliveryAttemptId),
    };
  }

  const questionEncoded = encodeQuestionCapsuleJournalV3Local(questionFile);
  const checkpointEncoded = checkpointFile === null
    ? null
    : encodeCapsuleCheckpointV4Local(checkpointFile);
  requireValue(questionEncoded.sizeBytes <= input.normalByteLimitsBySlot.questions &&
    questionEncoded.sizeBytes <= MAX_SOURCE_BYTES);
  requireValue(checkpointEncoded === null ||
    checkpointEncoded.sizeBytes <= input.normalByteLimitsBySlot.checkpoint &&
    checkpointEncoded.sizeBytes <= MAX_SOURCE_BYTES);

  const decodedQuestionFile = decodeQuestionCapsuleJournalV3Local(questionEncoded.bytes);
  const decodedCheckpointFile = checkpointEncoded === null
    ? null
    : decodeCapsuleCheckpointV4Local(checkpointEncoded.bytes);
  const reconstructed = validateQuestionCapsuleFiles({
    anchor: input.anchor,
    questionFile: decodedQuestionFile,
    checkpointFile: decodedCheckpointFile,
    instructionStore: input.stores.instructions,
    normalByteLimitsBySlot: input.normalByteLimitsBySlot,
  });
  requireValue(sameValue(reconstructed.snapshot, input.whole.snapshot));

  const selectedCount = selection.selectedReservations.length;
  return {
    targets: {
      questions: {
        value: questionEncoded.value,
        bytes: questionEncoded.bytes,
        sizeBytes: questionEncoded.sizeBytes,
        sha256: questionEncoded.sha256,
      },
      checkpoint: checkpointEncoded === null ? null : {
        value: checkpointEncoded.value,
        bytes: checkpointEncoded.bytes,
        sizeBytes: checkpointEncoded.sizeBytes,
        sha256: checkpointEncoded.sha256,
      },
    },
    usedChunkIds: chunksWithIds.map((chunk) => chunk.chunkId),
    unusedChunkIds: input.chunkIds.slice(chunksWithIds.length),
    selectionSummary: {
      scopeCount: selection.scopes.length,
      questionReservationCount: selectedCount,
      checkpointDeliveryCount: selection.selectedDeliveries.length,
      questionChunkCount: chunksWithIds.length,
      checkpointChunkCount: chunksWithIds.filter((chunk) => chunk.checkpointCapsule !== null).length,
    },
  };
}

function planQuestionCapsuleFileMigration(value) {
  try {
    const input = capturePlannerInput(value);
    const selection = resolveSelection(input);
    const target = makeTargets(input, selection);
    return {
      sourceFingerprints: input.sourceFingerprints,
      targets: target.targets,
      selectionSummary: target.selectionSummary,
      usedChunkIds: target.usedChunkIds,
      unusedChunkIds: target.unusedChunkIds,
      scopeLimitations: SCOPE_LIMITATIONS,
    };
  } catch {
    throw new TypeError(INVALID_PLAN);
  }
}

module.exports = { planQuestionCapsuleFileMigration };
