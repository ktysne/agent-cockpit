'use strict';

const { types } = require('node:util');
const { captureExactRecord } = require('./reclamation-codec-primitives');
const { normalizeQuestionReservation } = require('./common-question-reclamation-codec');
const { normalizeDeliveryRecordV2Local } = require('./delivery-reclamation-codec');
const { validateReclamationSnapshot, validateReclamationStoreWrite } =
  require('./reclamation-store-consistency');
const { analyzeQuestionPeriodRejectionCoverage } =
  require('./question-period-rejection-coverage');

const INVALID_EXPERIMENT = 'invalid_question_grave_projection_experiment';
const INPUT_FIELDS = ['anchor', 'stores', 'normalByteLimitsBySlot', 'identity', 'periodId'];
const CANDIDATE_FIELDS = [
  'format', 'periodIdentity', 'periodId', 'reservations', 'deliveryGraves', 'referenceTable', 'logicalTombstones',
];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const RESERVATION_SHARED_FIELDS = new Set(['identity', 'periodId']);
const GRAVE_SHARED_FIELDS = new Set(['sourceRef', 'targetRef']);
const SCOPE_LIMITATIONS = Object.freeze([
  'candidate_is_not_a_persistent_format_or_runtime_decoder',
  'roundtrip_does_not_grant_deletion_or_capacity_release_authority',
  'compact_json_bytes_do_not_measure_memory_or_persistent_capacity_savings',
  'candidate_is_revalidated_against_expansion_input_without_build_time_binding',
]);

function fail() {
  const error = new TypeError(INVALID_EXPERIMENT);
  error.code = INVALID_EXPERIMENT;
  throw error;
}

function requireValue(condition) {
  if (!condition) fail();
}

function assertPlainDataTree(value, active = new Set(), depth = 0) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    requireValue(Number.isFinite(value));
    return;
  }
  requireValue(typeof value === 'object' && !types.isProxy(value) && depth <= 128);
  requireValue(!active.has(value));
  active.add(value);
  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    requireValue(array ? prototype === Array.prototype
      : prototype === Object.prototype || prototype === null);
    const keys = Reflect.ownKeys(value);
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
      requireValue(descriptor && Object.hasOwn(descriptor, 'value') &&
        Number.isSafeInteger(descriptor.value) && descriptor.value >= 0 &&
        descriptor.value <= 100_000 && keys.length === descriptor.value + 1);
      for (let index = 0; index < descriptor.value; index += 1) {
        const item = Object.getOwnPropertyDescriptor(value, String(index));
        requireValue(item && item.enumerable && Object.hasOwn(item, 'value'));
        assertPlainDataTree(item.value, active, depth + 1);
      }
    } else {
      for (const key of keys) {
        requireValue(typeof key === 'string');
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
        assertPlainDataTree(descriptor.value, active, depth + 1);
      }
    }
  } finally {
    active.delete(value);
  }
}

function freezeDeep(value, visited = new Set()) {
  if (value === null || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value);
  for (const key of Reflect.ownKeys(value)) freezeDeep(value[key], visited);
  return Object.freeze(value);
}

function safeJsonValue(value) {
  if (Array.isArray(value)) {
    const result = new Array(value.length);
    Object.defineProperty(result, 'toJSON', { value: null, enumerable: false });
    for (let index = 0; index < value.length; index += 1) result[index] = safeJsonValue(value[index]);
    return result;
  }
  if (value !== null && typeof value === 'object') {
    const result = Object.create(null);
    for (const key of Object.keys(value)) {
      Object.defineProperty(result, key, {
        value: safeJsonValue(value[key]), enumerable: true, writable: true, configurable: true,
      });
    }
    return result;
  }
  return value;
}

function compactJson(value) {
  return JSON.stringify(safeJsonValue(value));
}

function sameJson(left, right) {
  return compactJson(left) === compactJson(right);
}

function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function normalizeInput(value) {
  assertPlainDataTree(value);
  const input = captureExactRecord(value, INPUT_FIELDS, INVALID_EXPERIMENT);
  const analysis = analyzeQuestionPeriodRejectionCoverage(input);
  const validated = validateReclamationSnapshot({ anchor: input.anchor, stores: input.stores });
  requireValue(validated.status === 'ready');
  const transition = validateReclamationStoreWrite({
    anchor: validated.snapshot.anchor,
    previousStores: validated.snapshot.stores,
    nextStores: validated.snapshot.stores,
    normalByteLimitsBySlot: input.normalByteLimitsBySlot,
  });
  requireValue(transition.status === 'checked' && transition.reasons.length === 0);
  return {
    input,
    analysis,
    anchor: validated.snapshot.anchor,
    stores: validated.snapshot.stores,
  };
}

function withoutFields(value, omittedFields) {
  const result = Object.create(null);
  for (const key of Object.keys(value)) {
    if (!omittedFields.has(key)) result[key] = value[key];
  }
  return result;
}

function exactKey(value) {
  return compactJson(value);
}

function selectedData(normalized) {
  const { input, analysis, stores } = normalized;
  const rows = analysis.questionRows;
  if (analysis.periodStatus !== 'retired') return { eligible: false, reason: 'period_not_retired' };
  if (rows.length === 0) return { eligible: false, reason: 'period_has_no_question_reservations' };
  if (rows.some((row) => row.bodyLifecycle !== 'reclaimed')) {
    return { eligible: false, reason: 'period_has_unreclaimed_question_bodies' };
  }

  const reservations = stores.questions.reservations.filter((reservation) =>
    reservation.periodId === input.periodId && sameIdentity(reservation.identity, input.identity));
  requireValue(reservations.length === rows.length);
  const selectedAttemptIds = new Set(reservations.flatMap((reservation) =>
    reservation.deliveryIntent === null ? [] : [reservation.deliveryIntent.deliveryAttemptId]));
  const deliveryGraves = stores.checkpoint === null ? [] : stores.checkpoint.ledger.deliveries.filter((delivery) =>
    selectedAttemptIds.has(delivery.deliveryAttemptId));
  const graveByAttempt = new Map(deliveryGraves.map((grave) => [grave.deliveryAttemptId, grave]));
  const selectedGroups = new Set(deliveryGraves.map((grave) => exactKey({
    kind: grave.kind,
    sourceExecutionId: grave.sourceExecutionId,
    logicalMessageId: grave.logicalMessageId,
    revision: grave.revision,
    targetLaunchKey: null,
    sourceLaunchKey: grave.sourceRef.launchKey,
    payloadDigest: grave.payloadDigest,
  })));
  const logicalTombstones = stores.checkpoint === null ? []
    : stores.checkpoint.ledger.logicalTombstones.filter((tombstone) =>
      selectedGroups.has(exactKey(tombstone)));

  for (const reservation of reservations) {
    if (reservation.deliveryIntent === null) continue;
    const grave = graveByAttempt.get(reservation.deliveryIntent.deliveryAttemptId);
    if (grave !== undefined) requireValue(grave.recordType === 'reclaimed' && grave.kind === 'question');
  }

  return {
    eligible: true,
    reservations,
    deliveryGraves,
    logicalTombstones,
    graveByAttempt,
    selectedReservationIndexes: stores.questions.reservations.flatMap((reservation, index) =>
      reservation.periodId === input.periodId && sameIdentity(reservation.identity, input.identity) ? [index] : []),
    selectedDeliveryIndexes: (stores.checkpoint?.ledger.deliveries ?? []).flatMap((delivery, index) =>
      selectedAttemptIds.has(delivery.deliveryAttemptId) ? [index] : []),
    selectedTombstoneIndexes: (stores.checkpoint?.ledger.logicalTombstones ?? []).flatMap((tombstone, index) =>
      selectedGroups.has(exactKey(tombstone)) ? [index] : []),
  };
}

function candidateFromSelection(identity, periodId, selected) {
  const referenceTable = [];
  const referenceIndexes = new Map();
  const internReference = (role, value) => {
    const key = `${role}:${exactKey(value)}`;
    if (referenceIndexes.has(key)) return referenceIndexes.get(key);
    const index = referenceTable.length;
    referenceIndexes.set(key, index);
    referenceTable.push({ role, value });
    return index;
  };
  const reservations = selected.reservations.map((reservation) =>
    withoutFields(reservation, RESERVATION_SHARED_FIELDS));
  const deliveryGraves = selected.deliveryGraves.map((grave) => ({
    ...withoutFields(grave, GRAVE_SHARED_FIELDS),
    sourceRefIndex: internReference('source', grave.sourceRef),
    targetRefIndex: internReference('target', grave.targetRef),
  }));
  return {
    format: 'question-grave-projection-experiment/v1',
    periodIdentity: Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, identity[field]])),
    periodId,
    reservations,
    deliveryGraves,
    referenceTable,
    logicalTombstones: selected.logicalTombstones,
  };
}

function metricCounts(candidate, selected) {
  return {
    questionReservations: selected.reservations.length,
    checkpointGraves: selected.deliveryGraves.length,
    checkpointMissingIntents: selected.reservations.filter((reservation) =>
      reservation.deliveryIntent !== null && !selected.graveByAttempt.has(reservation.deliveryIntent.deliveryAttemptId)).length,
    unselectedReservations: selected.reservations.filter((reservation) => reservation.deliveryIntent === null).length,
    logicalTombstones: selected.logicalTombstones.length,
    sharedReferences: candidate.referenceTable.length,
  };
}

function notEligible(reason) {
  return freezeDeep({
    status: 'not_eligible',
    reason,
    candidate: null,
    baselineMetrics: null,
    candidateMetrics: null,
    scopeLimitations: [...SCOPE_LIMITATIONS],
  });
}

function buildNormalized(normalized) {
  const selected = selectedData(normalized);
  if (!selected.eligible) return notEligible(selected.reason);
  const candidate = candidateFromSelection(normalized.input.identity, normalized.input.periodId, selected);
  const baseline = {
    reservations: selected.reservations,
    deliveryGraves: selected.deliveryGraves,
    logicalTombstones: selected.logicalTombstones,
  };
  const baselineMetrics = {
    counts: metricCounts(candidate, selected),
    compactUtf8Bytes: Buffer.byteLength(compactJson(baseline), 'utf8'),
  };
  const candidateMetrics = {
    counts: metricCounts(candidate, selected),
    compactUtf8Bytes: Buffer.byteLength(compactJson(candidate), 'utf8'),
    wholeSnapshotCompactUtf8Bytes: Buffer.byteLength(compactJson({
      anchor: normalized.anchor,
      stores: normalized.stores,
    }), 'utf8'),
  };
  return freezeDeep({
    status: 'ready',
    candidate,
    baselineMetrics,
    candidateMetrics,
    scopeLimitations: [...SCOPE_LIMITATIONS],
  });
}

function buildQuestionGraveProjectionExperiment(value) {
  try {
    return buildNormalized(normalizeInput(value));
  } catch {
    fail();
  }
}

function expandQuestionGraveProjectionExperiment(value) {
  try {
    assertPlainDataTree(value);
    const input = captureExactRecord(value, ['originalInput', 'candidate'], INVALID_EXPERIMENT);
    assertPlainDataTree(input.candidate);
    captureExactRecord(input.candidate, CANDIDATE_FIELDS, INVALID_EXPERIMENT);
    const normalized = normalizeInput(input.originalInput);
    const built = buildNormalized(normalized);
    requireValue(built.status === 'ready' && sameJson(input.candidate, built.candidate));

    const candidate = structuredClone(input.candidate);
    const selected = selectedData(normalized);
    const reservations = candidate.reservations.map((reservation) => normalizeQuestionReservation({
      ...reservation,
      identity: candidate.periodIdentity,
      periodId: candidate.periodId,
    }));
    const references = candidate.referenceTable;
    const deliveryGraves = candidate.deliveryGraves.map((grave) => {
      const sourceEntry = references[grave.sourceRefIndex];
      const targetEntry = references[grave.targetRefIndex];
      requireValue(sourceEntry?.role === 'source' && targetEntry?.role === 'target');
      const { sourceRefIndex, targetRefIndex, ...shared } = grave;
      return normalizeDeliveryRecordV2Local({
        ...shared,
        sourceRef: sourceEntry.value,
        targetRef: targetEntry.value,
      });
    });
    const logicalTombstones = candidate.logicalTombstones;
    requireValue(sameJson(reservations, selected.reservations));
    requireValue(sameJson(deliveryGraves, selected.deliveryGraves));
    requireValue(sameJson(logicalTombstones, selected.logicalTombstones));

    const nextStores = {
      ...normalized.stores,
      questions: normalized.stores.questions === null ? null : {
        ...normalized.stores.questions,
        reservations: normalized.stores.questions.reservations.slice(),
      },
    };
    for (let index = 0; index < selected.selectedReservationIndexes.length; index += 1) {
      nextStores.questions.reservations[selected.selectedReservationIndexes[index]] = reservations[index];
    }
    if (normalized.stores.checkpoint !== null) {
      const ledger = normalized.stores.checkpoint.ledger;
      const nextLedger = {
        ...ledger,
        deliveries: ledger.deliveries.slice(),
        logicalTombstones: ledger.logicalTombstones.slice(),
      };
      for (let index = 0; index < selected.selectedDeliveryIndexes.length; index += 1) {
        nextLedger.deliveries[selected.selectedDeliveryIndexes[index]] = deliveryGraves[index];
      }
      for (let index = 0; index < selected.selectedTombstoneIndexes.length; index += 1) {
        nextLedger.logicalTombstones[selected.selectedTombstoneIndexes[index]] = logicalTombstones[index];
      }
      nextStores.checkpoint = { ...normalized.stores.checkpoint, ledger: nextLedger };
    }

    const transition = validateReclamationStoreWrite({
      anchor: normalized.anchor,
      previousStores: normalized.stores,
      nextStores,
      normalByteLimitsBySlot: normalized.input.normalByteLimitsBySlot,
    });
    requireValue(transition.status === 'checked' && transition.reasons.length === 0 &&
      sameJson(transition.snapshot.stores, normalized.stores));
    return freezeDeep({ questionReservations: reservations, deliveryGraves, logicalTombstones });
  } catch {
    fail();
  }
}

module.exports = {
  buildQuestionGraveProjectionExperiment,
  expandQuestionGraveProjectionExperiment,
};
