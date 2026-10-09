'use strict';

const { createHash } = require('node:crypto');
const kernel = require('./common-question-kernel');
const {
  measureNewQuestionCandidateCapacity,
  measureQuestionJournalReservationBytes,
} = require('./reclamation-capacity-bounds');
const {
  encodeQuestionJournalV2Local,
  normalizeQuestionJournalV2Local,
  normalizeQuestionDetailV2,
  normalizeQuestionReservation,
} = require('./common-question-reclamation-codec');
const { encodeNormalized } = require('./reclamation-json-codec');

const V1_RECORD_FIELDS = [
  'internalQuestionId', 'questionId', 'identity', 'periodId', 'executionId', 'conversationId',
  'launchRef', 'executionBinding', 'category', 'contentDigest', 'questions', 'createdAt', 'deadlineAt',
  'timeoutMinutes', 'revision', 'held', 'selection', 'deliveryIntent', 'autoApplyEnabledAtRegistration',
  'externalResolution', 'lateAnswers', 'cancelledAt',
];
const QUESTION_TERMINAL_STATES = new Set(['applied', 'cancelled_before_send', 'superseded_before_send']);
const CLAIM_FIELDS = ['launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId',
  'homeScopeId', 'origin', 'purpose', 'originBinding'];
const GRANT_FIELDS = ['operationId', 'sourceSchemaVersion', 'sourceSizeBytes', 'sourceSha256',
  'maxExtraBytes', 'eligibleQuestionIds'];

function adapterError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sameIdentity(left, right) {
  return ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']
    .every((field) => left[field] === right[field]);
}

function sameIntent(left, right) {
  return left === null || right === null ? left === right :
    ['deliveryAttemptId', 'logicalMessageId', 'revision', 'payloadDigest']
      .every((field) => left[field] === right[field]);
}

function sameDetail(left, right) {
  return left.internalQuestionId === right.internalQuestionId &&
    sameIdentity(left.identity, right.identity) && left.periodId === right.periodId &&
    left.questionId === right.questionId;
}

function sameGrant(left, right) {
  if (left === null || right === null) return left === right;
  return GRANT_FIELDS.every((field) => field === 'eligibleQuestionIds'
    ? left[field].length === right[field].length && left[field].every((item, index) => item === right[field][index])
    : left[field] === right[field]);
}

function sameRecord(left, right) {
  return encodeNormalized(left).bytes.equals(encodeNormalized(right).bytes);
}

function safeRecord(entries) {
  const record = Object.create(null);
  Object.defineProperty(record, 'toJSON', { value: null, enumerable: false });
  for (const [key, value] of entries) {
    Object.defineProperty(record, key, { value, enumerable: true });
  }
  return record;
}

function sourceClaimsDigest(claims) {
  const binding = claims.originBinding === null ? null : safeRecord([
    ['periodId', claims.originBinding.periodId],
    ['actor', safeRecord([
      ['kind', claims.originBinding.actor.kind],
      ['id', claims.originBinding.actor.id],
    ])],
  ]);
  const normalizedClaims = safeRecord(CLAIM_FIELDS.map((field) => [
    field,
    field === 'originBinding' ? binding : claims[field],
  ]));
  return createHash('sha256').update(JSON.stringify(normalizedClaims), 'utf8').digest('hex');
}

function legacyRecord(detail) {
  const record = {};
  for (const field of V1_RECORD_FIELDS) record[field] = detail[field];
  return record;
}

function projectLegacyJournal(snapshot, maxRecords) {
  return kernel.normalizeJournal({
    schemaVersion: kernel.JOURNAL_SCHEMA_VERSION,
    revision: snapshot.revision,
    questions: snapshot.questions.map(legacyRecord),
  }, maxRecords);
}

function terminalResultKind(checkpointState) {
  return QUESTION_TERMINAL_STATES.has(checkpointState) ? checkpointState : null;
}

function reservationForDetail(detail, previous = null) {
  if (previous?.bodyState === 'reclaimed') throw adapterError('question_id_reused');
  const deliveryIntent = detail.deliveryIntent;
  let deliveryCreationState = previous?.deliveryCreationState || 'not_created';
  if (deliveryIntent === null) deliveryCreationState = 'not_created';
  else if (!previous || previous.deliveryIntent === null) deliveryCreationState = 'not_created';
  else if (!sameIntent(previous.deliveryIntent, deliveryIntent)) throw adapterError('question_delivery_mismatch');

  const checkpointState = deliveryCreationState === 'checkpointed' ? previous.checkpointState :
    deliveryCreationState === 'indeterminate' ? 'unknown' : null;
  const sourceClaimsDigest = deliveryCreationState === 'checkpointed' ? previous.sourceClaimsDigest : null;
  const sessionId = deliveryCreationState === 'checkpointed' ? previous.sessionId : null;
  return normalizeQuestionReservation({
    internalQuestionId: detail.internalQuestionId,
    identity: detail.identity,
    periodId: detail.periodId,
    questionId: detail.questionId,
    contentDigest: detail.contentDigest,
    executionId: detail.executionId,
    conversationId: detail.conversationId,
    launchRef: detail.launchRef,
    executionBinding: detail.executionBinding,
    createdAt: detail.createdAt,
    revision: detail.revision,
    selectionSource: detail.selection?.source ?? null,
    selectedAt: detail.selection?.selectedAt ?? null,
    deliveryIntent,
    deliveryCreationState,
    checkpointState,
    sourceClaimsDigest,
    sessionId,
    externalResolution: detail.externalResolution,
    cancelledAt: detail.cancelledAt,
    terminalResultKind: terminalResultKind(checkpointState),
    quarantinedAt: previous?.quarantinedAt ?? detail.quarantinedAt,
    bodyState: previous?.bodyState || 'retained',
    reclaimedAt: previous?.reclaimedAt ?? null,
    reclamation: previous?.reclamation ?? null,
  });
}

function reservationMatchesKey(reservation, identity, periodId, questionId) {
  return reservation.periodId === periodId && reservation.questionId === questionId &&
    sameIdentity(reservation.identity, identity);
}

function createCommonQuestionReclamationJournal(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw adapterError('invalid_question_reclamation_journal');
  }
  const backend = value.backend;
  const periodGate = value.periodGate;
  const maxRecords = value.maxRecords ?? kernel.MAX_JOURNAL_RECORDS;
  if (!backend || backend.slot !== 'questions' || !Number.isSafeInteger(backend.normalByteLimit) ||
      backend.normalByteLimit < 1 || backend.normalByteLimit > 16_777_216 || typeof backend.getStoreId !== 'function' ||
      typeof backend.getSnapshot !== 'function' || typeof backend.load !== 'function' ||
      typeof backend.save !== 'function' || typeof backend.prepareResume !== 'function' ||
      typeof backend.flush !== 'function' || typeof backend.close !== 'function' ||
      typeof backend.canWrite !== 'function' ||
      !periodGate || typeof periodGate.assertCurrent !== 'function' ||
      typeof periodGate.assertRetirement !== 'function' ||
      typeof periodGate.isRetired !== 'function' ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > kernel.MAX_JOURNAL_RECORDS) {
    throw adapterError('invalid_question_reclamation_journal');
  }

  const maxBytes = backend.normalByteLimit;
  let snapshot = null;
  let legacy = null;
  let closed = false;
  let stopped = false;

  function install(value) {
    snapshot = normalizeQuestionJournalV2Local(value, maxRecords);
    if (snapshot.storeId !== backend.getStoreId()) throw adapterError('question_store_id_mismatch');
    legacy = projectLegacyJournal(snapshot, maxRecords);
  }

  function requireInstalled() {
    if (closed) throw adapterError('question_service_closed');
    if (!snapshot || !legacy) throw adapterError('question_service_not_ready');
    return snapshot;
  }

  function currentReservationById(internalQuestionId) {
    return requireInstalled().reservations.find((item) => item.internalQuestionId === internalQuestionId) || null;
  }

  function buildCandidate(candidateInput) {
    const current = requireInstalled();
    const candidate = kernel.normalizeJournal(candidateInput, maxRecords);
    if (candidate.revision !== current.revision + 1 || current.revision >= Number.MAX_SAFE_INTEGER) {
      throw adapterError('question_revision_not_advanced');
    }
    const previousById = new Map(current.reservations.map((item) => [item.internalQuestionId, item]));
    const previousByKey = current.reservations;
    const questions = candidate.questions.map((recordInput) => {
      const detail = normalizeQuestionDetailV2({
        ...recordInput,
        deliveryCreationState: 'not_created',
        quarantinedAt: null,
      });
      const previous = previousById.get(detail.internalQuestionId) || null;
      if (previous && !sameDetail(previous, detail)) throw adapterError('question_id_reused');
      const keyed = previousByKey.find((item) => reservationMatchesKey(item, detail.identity,
        detail.periodId, detail.questionId));
      if (keyed && keyed.internalQuestionId !== detail.internalQuestionId) {
        throw adapterError('question_conflict');
      }
      const priorDetail = current.questions.find((item) => item.internalQuestionId === detail.internalQuestionId);
      if (!priorDetail && previous) throw adapterError('question_id_reused');
      if (priorDetail && previous?.bodyState !== 'retained') throw adapterError('question_id_reused');
      const metadata = priorDetail ? {
        deliveryCreationState: previous.deliveryCreationState,
        quarantinedAt: previous.quarantinedAt,
      } : { deliveryCreationState: 'not_created', quarantinedAt: null };
      const merged = normalizeQuestionDetailV2({ ...recordInput, ...metadata });
      const reservation = reservationForDetail(merged, previous);
      return { detail: merged, reservation };
    });

    const byId = new Map(questions.map(({ reservation }) => [reservation.internalQuestionId, reservation]));
    const reservations = current.reservations.map((reservation) =>
      byId.get(reservation.internalQuestionId) || reservation);
    const priorIds = new Set(current.reservations.map((item) => item.internalQuestionId));
    for (const { reservation } of questions) {
      if (!priorIds.has(reservation.internalQuestionId)) reservations.push(reservation);
    }
    if (reservations.length > maxRecords) throw adapterError('question_capacity');
    const normalized = normalizeQuestionJournalV2Local({
      schemaVersion: 2,
      storeId: current.storeId,
      revision: candidate.revision,
      questions: questions.map(({ detail }) => detail),
      reservations,
      migrationAllowance: current.migrationAllowance,
    }, maxRecords);
    const addedReservations = normalized.reservations.filter((item) => !priorIds.has(item.internalQuestionId));
    if (addedReservations.length > 1) throw adapterError('question_capacity');
    if (addedReservations.length === 1) {
      const measurement = measureNewQuestionCandidateCapacity({
        currentSnapshot: current,
        candidateSnapshot: normalized,
        newInternalQuestionId: addedReservations[0].internalQuestionId,
        currentByteLimit: maxBytes,
      });
      if (!measurement.accepted) throw adapterError('question_capacity');
    } else {
      assertSnapshotCapacity(normalized);
    }
    return normalized;
  }

  function assertSnapshotCapacity(value) {
    const normalized = normalizeQuestionJournalV2Local(value, maxRecords);
    const measurement = measureQuestionJournalReservationBytes({ snapshot: normalized, currentByteLimit: maxBytes });
    const extraBytes = normalized.migrationAllowance?.maxExtraBytes ?? 0;
    const allowedBytes = maxBytes + extraBytes;
    if (!Number.isSafeInteger(allowedBytes) || measurement.reservedBytes > allowedBytes) {
      throw adapterError('journal_capacity_reserved');
    }
    return measurement.reservedBytes;
  }

  async function persistCandidate(candidate, assertBeforeWrite) {
    const saved = await backend.save(candidate, assertBeforeWrite);
    const normalized = normalizeQuestionJournalV2Local(saved, maxRecords);
    if (normalized.storeId !== candidate.storeId || normalized.revision !== candidate.revision ||
        !encodeQuestionJournalV2Local(normalized, maxRecords).bytes.equals(
          encodeQuestionJournalV2Local(candidate, maxRecords).bytes)) {
      throw adapterError('question_journal_save_mismatch');
    }
    snapshot = normalized;
    legacy = projectLegacyJournal(snapshot, maxRecords);
    return structuredClone(legacy);
  }

  async function save(candidateInput, periodToken) {
    if (stopped) throw adapterError('question_gate_closed');
    periodGate.assertCurrent(periodToken);
    const candidate = buildCandidate(candidateInput);
    periodGate.assertCurrent(periodToken);
    return persistCandidate(candidate, () => { periodGate.assertCurrent(periodToken); });
  }

  async function updateDeliveryState(internalQuestionId, state, detailEvidence, periodToken) {
    if (stopped) throw adapterError('question_gate_closed');
    periodGate.assertCurrent(periodToken);
    const current = requireInstalled();
    const prior = current.reservations.find((item) => item.internalQuestionId === internalQuestionId);
    const oldDetail = current.questions.find((item) => item.internalQuestionId === internalQuestionId);
    if (!prior || !oldDetail || prior.bodyState !== 'retained') throw adapterError('question_not_found');
    if (!['creating', 'checkpointed', 'indeterminate'].includes(state)) {
      throw adapterError('invalid_question_delivery_creation_state');
    }
    if (prior.deliveryCreationState === 'indeterminate' && state !== 'indeterminate') {
      throw adapterError('question_delivery_creation_state_regressed');
    }
    if (state === 'creating' && (prior.deliveryCreationState !== 'not_created' || !prior.deliveryIntent)) {
      throw adapterError('invalid_question_delivery_creation_state');
    }
    if (state === 'indeterminate' && !prior.deliveryIntent) {
      throw adapterError('invalid_question_delivery_creation_state');
    }

    let checkpointState = null;
    let sourceClaimsDigest = null;
    let sessionId = null;
    if (state === 'checkpointed') {
      if (!detailEvidence || detailEvidence.kind !== 'question' ||
          detailEvidence.deliveryAttemptId !== prior.deliveryIntent?.deliveryAttemptId ||
          detailEvidence.logicalMessageId !== prior.deliveryIntent?.logicalMessageId ||
          detailEvidence.revision !== prior.deliveryIntent?.revision ||
          detailEvidence.payloadDigest !== prior.deliveryIntent?.payloadDigest ||
          !detailEvidence.source?.claims || !detailEvidence.source.sessionId) {
        throw adapterError('question_delivery_mismatch');
      }
      checkpointState = detailEvidence.state;
      sourceClaimsDigest = sourceClaimsDigestForDelivery(detailEvidence);
      sessionId = detailEvidence.source.sessionId;
      if (prior.terminalResultKind !== null && prior.terminalResultKind !== checkpointState) {
        throw adapterError('question_terminal_state_regressed');
      }
    } else if (state === 'indeterminate') {
      checkpointState = 'unknown';
    }

    if (state === 'checkpointed' && prior.deliveryCreationState === 'indeterminate') {
      throw adapterError('question_delivery_creation_state_regressed');
    }
    if (state === 'indeterminate' && prior.deliveryCreationState !== 'creating') {
      throw adapterError('invalid_question_delivery_creation_state');
    }

    const detail = normalizeQuestionDetailV2({
      ...oldDetail,
      deliveryCreationState: state,
    });
    const reservation = normalizeQuestionReservation({
      ...prior,
      revision: detail.revision,
      deliveryCreationState: state,
      checkpointState,
      sourceClaimsDigest,
      sessionId,
      terminalResultKind: terminalResultKind(checkpointState),
    });
    const candidate = normalizeQuestionJournalV2Local({
      ...current,
      revision: current.revision + 1,
      questions: current.questions.map((item) => item.internalQuestionId === internalQuestionId ? detail : item),
      reservations: current.reservations.map((item) => item.internalQuestionId === internalQuestionId ? reservation : item),
    }, maxRecords);
    assertSnapshotCapacity(candidate);
    periodGate.assertCurrent(periodToken);
    await persistCandidate(candidate, () => { periodGate.assertCurrent(periodToken); });
    return structuredClone(legacy);
  }

  function prepareResume(fullSnapshot) {
    if (closed) throw adapterError('question_service_closed');
    const snapshotValue = fullSnapshot?.stores?.questions;
    const normalized = normalizeQuestionJournalV2Local(snapshotValue, maxRecords);
    const prepareResult = backend.prepareResume(fullSnapshot);
    if (prepareResult !== undefined && prepareResult !== null &&
        (typeof prepareResult === 'object' || typeof prepareResult === 'function') &&
        typeof prepareResult.then === 'function') {
      throw adapterError('invalid_question_resume_backend');
    }
    install(backend.getSnapshot());
    if (!encodeQuestionJournalV2Local(snapshot, maxRecords).bytes.equals(
      encodeQuestionJournalV2Local(normalized, maxRecords).bytes)) {
      throw adapterError('question_resume_snapshot_mismatch');
    }
    stopped = false;
    return Object.freeze({ ready: true, revision: snapshot.revision });
  }

  function findReservation(identity, periodId, questionId) {
    return requireInstalled().reservations.find((item) =>
      reservationMatchesKey(item, identity, periodId, questionId)) || null;
  }

  function getReservation(internalQuestionId) {
    const reservation = currentReservationById(internalQuestionId);
    return reservation ? structuredClone(reservation) : null;
  }

  function getSnapshot() {
    return structuredClone(requireInstalled());
  }

  function getLegacySnapshot() {
    requireInstalled();
    return structuredClone(legacy);
  }

  async function persistRetirement(candidateValue, ticket) {
    if (closed) throw adapterError('question_service_closed');
    periodGate.assertRetirement(ticket);
    const current = requireInstalled();
    const candidate = normalizeQuestionJournalV2Local(candidateValue, maxRecords);
    if (candidate.storeId !== current.storeId || candidate.revision !== current.revision + 1 ||
        current.revision >= Number.MAX_SAFE_INTEGER ||
        !sameGrant(candidate.migrationAllowance, current.migrationAllowance)) {
      throw adapterError('invalid_question_retirement_candidate');
    }
    assertSnapshotCapacity(candidate);
    periodGate.assertRetirement(ticket);
    const saved = await backend.save(candidate, () => { periodGate.assertRetirement(ticket); });
    const normalized = normalizeQuestionJournalV2Local(saved, maxRecords);
    if (!encodeQuestionJournalV2Local(normalized, maxRecords).bytes.equals(
      encodeQuestionJournalV2Local(candidate, maxRecords).bytes)) {
      throw adapterError('question_journal_save_mismatch');
    }
    snapshot = normalized;
    legacy = projectLegacyJournal(snapshot, maxRecords);
    return structuredClone(snapshot);
  }

  async function persistBodyReclamation(candidateValue, identity, periodId, internalQuestionId, assertAccess) {
    if (closed) throw adapterError('question_service_closed');
    if (typeof internalQuestionId !== 'string' || internalQuestionId.length === 0 ||
        typeof assertAccess !== 'function' ||
        !periodGate.isRetired(identity, periodId)) {
      throw adapterError('question_period_not_retired');
    }
    const current = requireInstalled();
    const candidate = normalizeQuestionJournalV2Local(candidateValue, maxRecords);
    const previousReservation = current.reservations.find((item) => item.internalQuestionId === internalQuestionId);
    const nextReservation = candidate.reservations.find((item) => item.internalQuestionId === internalQuestionId);
    const previousDetail = current.questions.find((item) => item.internalQuestionId === internalQuestionId);
    const nextDetail = candidate.questions.find((item) => item.internalQuestionId === internalQuestionId);
    const preparing = previousReservation?.reclamation === null;
    const reservationFieldsMatch = previousReservation && nextReservation &&
      Object.keys(previousReservation).every((field) =>
        ['bodyState', 'reclaimedAt', 'reclamation'].includes(field) ||
        sameRecord(previousReservation[field], nextReservation[field]));
    const detailMatches = previousDetail && (nextReservation?.bodyState === 'reclaimed'
      ? nextDetail === undefined
      : nextDetail !== undefined && sameRecord(previousDetail, nextDetail));
    if (!previousReservation || !nextReservation || !previousDetail || !detailMatches || !reservationFieldsMatch ||
        !sameIdentity(previousReservation.identity, identity) || previousReservation.periodId !== periodId ||
        candidate.storeId !== current.storeId || current.revision >= Number.MAX_SAFE_INTEGER ||
        candidate.revision !== current.revision + 1 || !sameGrant(candidate.migrationAllowance, current.migrationAllowance) ||
        candidate.reservations.length !== current.reservations.length ||
        !sameIdentity(nextReservation.identity, identity) || nextReservation.periodId !== periodId ||
        nextReservation.questionId !== previousReservation.questionId ||
        nextReservation.contentDigest !== previousReservation.contentDigest ||
        nextReservation.reclamation === null ||
        (preparing
          ? nextReservation.bodyState !== 'retained' || nextReservation.reclaimedAt !== null
          : previousReservation.bodyState !== 'retained' || nextReservation.bodyState !== 'reclaimed' ||
            nextReservation.reclaimedAt < nextReservation.reclamation.preparedAt ||
            !sameRecord(nextReservation.reclamation, previousReservation.reclamation))) {
      throw adapterError('invalid_question_body_reclamation_candidate');
    }
    const sameRowsExceptTarget = (previousRows, nextRows, field) => {
      if (field === 'questions' && nextReservation.bodyState === 'reclaimed') {
        if (nextRows.length !== previousRows.length - 1 || nextDetail !== undefined) return false;
      } else if (nextRows.length !== previousRows.length) return false;
      const nextById = new Map(nextRows.map((item) => [item.internalQuestionId, item]));
      return previousRows.every((row) => {
        if (row.internalQuestionId !== internalQuestionId) {
          const next = nextById.get(row.internalQuestionId);
          return next !== undefined && sameRecord(row, next);
        }
        return true;
      }) && (field !== 'questions' || nextReservation.bodyState === 'reclaimed' || nextDetail !== undefined);
    };
    if (!sameRowsExceptTarget(current.reservations, candidate.reservations, 'reservations') ||
        !sameRowsExceptTarget(current.questions, candidate.questions, 'questions')) {
      throw adapterError('invalid_question_body_reclamation_candidate');
    }
    assertSnapshotCapacity(candidate);
    const assertRetired = () => {
      assertAccess();
      if (closed || !periodGate.isRetired(identity, periodId)) throw adapterError('question_period_not_retired');
    };
    assertRetired();
    const saved = await backend.save(candidate, assertRetired);
    const normalized = normalizeQuestionJournalV2Local(saved, maxRecords);
    if (!encodeQuestionJournalV2Local(normalized, maxRecords).bytes.equals(
      encodeQuestionJournalV2Local(candidate, maxRecords).bytes)) {
      throw adapterError('question_journal_save_mismatch');
    }
    snapshot = normalized;
    legacy = projectLegacyJournal(snapshot, maxRecords);
    return structuredClone(snapshot);
  }

  function load() {
    return Promise.resolve(structuredClone(projectLegacyJournal(requireInstalled(), maxRecords)));
  }

  function assertCapacityReserved() {
    return assertSnapshotCapacity(requireInstalled());
  }

  function stop() {
    stopped = true;
  }

  function flush() {
    requireInstalled();
    return backend.flush();
  }

  function close() {
    closed = true;
    stopped = true;
    return Promise.resolve();
  }

  return Object.freeze({
    maxBytes,
    maxRecords,
    load,
    save,
    updateDeliveryState,
    prepareResume,
    findReservation,
    getReservation,
    getSnapshot,
    getLegacySnapshot,
    persistRetirement,
    persistBodyReclamation,
    assertCapacityReserved,
    flush,
    close,
    stop,
  });
}

function sourceClaimsDigestForDelivery(delivery) {
  return sourceClaimsDigest(delivery.source.claims);
}

module.exports = { createCommonQuestionReclamationJournal };
