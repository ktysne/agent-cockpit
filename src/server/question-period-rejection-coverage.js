'use strict';

const { types } = require('node:util');
const {
  captureExactRecord,
} = require('./reclamation-codec-primitives');
const {
  normalizeQuestionJournalV2Local,
  questionCommonKeyDigest,
} = require('./common-question-reclamation-codec');
const {
  normalizeCheckpointV3Local,
  normalizeInstructionJournalV2Local,
} = require('./delivery-reclamation-codec');
const { normalizeQuestionReclamationAnchorV1Local } = require('./question-reclamation-anchor-codec');
const { validateReclamationStoreWrite } = require('./reclamation-store-consistency');

const INVALID_ANALYSIS = 'invalid_question_period_rejection_coverage';
const INPUT_FIELDS = ['anchor', 'stores', 'normalByteLimitsBySlot', 'identity', 'periodId'];
const STORE_FIELDS = ['questions', 'checkpoint', 'instructions'];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const ALLOWED_REASONS = new Set([
  'question_creation_state',
  'question_checkpoint_cache',
  'instruction_creation_state',
]);
const NORMALIZERS = Object.freeze({
  questions: normalizeQuestionJournalV2Local,
  checkpoint: normalizeCheckpointV3Local,
  instructions: normalizeInstructionJournalV2Local,
});
const SCOPE_LIMITATIONS = Object.freeze([
  'global_internal_question_id_uniqueness_not_covered',
  'global_delivery_attempt_id_uniqueness_not_covered',
  'logical_replay_and_tombstone_retention_not_covered',
  'checkpoint_question_correlation_not_covered',
  'question_delivery_result_or_state_lookup_not_covered',
  'nonquestion_checkpoint_and_instruction_obligations_not_covered',
  'body_reclamation_does_not_establish_capacity_release',
  'normal_capacity_validation_applies_to_input_snapshot_only',
  'whole_snapshot_deletion_safety_not_assessed',
]);
const OBLIGATION_REASONS = Object.freeze({
  global_internal_question_id_uniqueness:
    'period gateはinternalQuestionIdの全体重複を判定しない。',
  global_delivery_attempt_id_uniqueness:
    'period gateは別kind・別periodへのdeliveryAttemptId再利用を判定しない。',
  logical_replay_and_tombstone_retention:
    'logical keyの再送判断はcheckpoint tombstone履歴に依存する。',
  checkpoint_question_correlation:
    'reservationとcheckpointの相関はperiod gateの対象外。',
  question_delivery_result_or_state_lookup:
    '質問deliveryの結果・状態照会はcheckpointのdetail/grave記録に依存する。',
});
const COMMON_KEY_VALIDATION_ID = 'question-period-coverage-validation';

function fail() {
  throw new TypeError(INVALID_ANALYSIS);
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
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      requireValue(lengthDescriptor && Object.hasOwn(lengthDescriptor, 'value') &&
        Number.isSafeInteger(lengthDescriptor.value) && lengthDescriptor.value >= 0 &&
        lengthDescriptor.value <= 100_000 && keys.length === lengthDescriptor.value + 1);
      for (let index = 0; index < lengthDescriptor.value; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
        assertPlainDataTree(descriptor.value, active, depth + 1);
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

function captureStoreFields(value) {
  return captureExactRecord(value, STORE_FIELDS, INVALID_ANALYSIS);
}

function normalizeStores(value) {
  const captured = captureStoreFields(value);
  const stores = Object.create(null);
  for (const slot of STORE_FIELDS) {
    stores[slot] = captured[slot] === null ? null : NORMALIZERS[slot](captured[slot]);
  }
  return stores;
}

function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function lifecycleFor(reservation) {
  if (reservation.bodyState === 'reclaimed') return 'reclaimed';
  return reservation.reclamation === null ? 'retained' : 'prepared';
}

function obligationsFor(reservation, deliveryRecord) {
  const obligations = ['global_internal_question_id_uniqueness'];
  if (reservation.deliveryIntent !== null) {
    obligations.push(
      'global_delivery_attempt_id_uniqueness',
      'logical_replay_and_tombstone_retention',
      'checkpoint_question_correlation',
    );
  }
  if (deliveryRecord !== null) obligations.push('question_delivery_result_or_state_lookup');
  return obligations.map((code) => ({ code, reason: OBLIGATION_REASONS[code] }));
}

function freezeDeep(value, visited = new Set()) {
  if (value === null || typeof value !== 'object' || visited.has(value)) return value;
  visited.add(value);
  for (const key of Reflect.ownKeys(value)) freezeDeep(value[key], visited);
  return Object.freeze(value);
}

function makeQuestionRow(reservation, detailById, deliveryByAttemptId, periodRetired) {
  const covered = periodRetired ? 'covered' : 'not_covered';
  const deliveryRecord = reservation.deliveryIntent === null
    ? null
    : deliveryByAttemptId.get(reservation.deliveryIntent.deliveryAttemptId) ?? null;
  return {
    internalQuestionId: reservation.internalQuestionId,
    commonKeyDigest: questionCommonKeyDigest(
      reservation.identity,
      reservation.periodId,
      reservation.questionId,
    ),
    bodyLifecycle: lifecycleFor(reservation),
    questionDetailPresent: detailById.has(reservation.internalQuestionId),
    deliveryIntentPresent: reservation.deliveryIntent !== null,
    deliveryCreationState: reservation.deliveryCreationState,
    checkpointState: reservation.checkpointState,
    checkpointDeliveryRecordType: deliveryRecord?.recordType ?? null,
    checkpointDeliveryState: deliveryRecord?.state ?? null,
    commonKeyReRegistration: covered,
    questionPeriodDeliveryAndLateUpdate: covered,
    remainingObligations: obligationsFor(reservation, deliveryRecord),
  };
}

function analyzeInternal(value) {
  assertPlainDataTree(value);
  const input = captureExactRecord(value, INPUT_FIELDS, INVALID_ANALYSIS);
  const anchor = normalizeQuestionReclamationAnchorV1Local(input.anchor);
  const stores = normalizeStores(input.stores);
  const limits = captureStoreFields(input.normalByteLimitsBySlot);
  const identity = captureExactRecord(input.identity, IDENTITY_FIELDS, INVALID_ANALYSIS);
  const periodId = input.periodId;
  questionCommonKeyDigest(identity, periodId, COMMON_KEY_VALIDATION_ID);

  const transition = validateReclamationStoreWrite({
    anchor,
    previousStores: stores,
    nextStores: stores,
    normalByteLimitsBySlot: limits,
  });
  requireValue(transition.status === 'checked' &&
    transition.reasons.every((reason) => ALLOWED_REASONS.has(reason)));

  const periodRetired = anchor.retiredQuestionPeriods.some((period) =>
    period.periodId === periodId && sameIdentity(period.identity, identity));
  const journal = stores.questions;
  const reservations = journal === null ? [] : journal.reservations.filter((reservation) =>
    reservation.periodId === periodId && sameIdentity(reservation.identity, identity));
  const detailById = new Map((journal?.questions ?? []).map((detail) => [detail.internalQuestionId, detail]));
  const deliveryByAttemptId = new Map((stores.checkpoint?.ledger.deliveries ?? []).map((delivery) =>
    [delivery.deliveryAttemptId, delivery]));
  reservations.sort((left, right) => left.internalQuestionId < right.internalQuestionId ? -1
    : left.internalQuestionId > right.internalQuestionId ? 1 : 0);
  const questionRows = reservations.map((reservation) =>
    makeQuestionRow(reservation, detailById, deliveryByAttemptId, periodRetired));
  const lifecycleCounts = { retained: 0, prepared: 0, reclaimed: 0 };
  const obligationCounts = Object.create(null);
  let unselectedQuestionCount = 0;
  for (const row of questionRows) {
    lifecycleCounts[row.bodyLifecycle] += 1;
    if (!row.deliveryIntentPresent) unselectedQuestionCount += 1;
    for (const obligation of row.remainingObligations) {
      obligationCounts[obligation.code] = (obligationCounts[obligation.code] ?? 0) + 1;
    }
  }

  return freezeDeep({
    scope: 'question_period_rejection_only',
    target: { identity, periodId },
    periodStatus: periodRetired ? 'retired' : 'not_retired',
    inputSnapshotValidation: 'passed',
    questionRows,
    scopeLimitations: [...SCOPE_LIMITATIONS],
    summary: {
      questionCount: questionRows.length,
      coveredQuestionCount: questionRows.filter((row) => row.commonKeyReRegistration === 'covered').length,
      notCoveredQuestionCount: questionRows.filter((row) => row.commonKeyReRegistration === 'not_covered').length,
      unselectedQuestionCount,
      lifecycleCounts,
      remainingObligationCounts: obligationCounts,
      wholeSnapshotDeletionSafety: 'not_assessed',
    },
  });
}

function analyzeQuestionPeriodRejectionCoverage(value) {
  try {
    return analyzeInternal(value);
  } catch {
    fail();
  }
}

module.exports = { analyzeQuestionPeriodRejectionCoverage };
