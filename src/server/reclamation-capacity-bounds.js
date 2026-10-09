'use strict';

const { createHash } = require('node:crypto');
const {
  assertIdentifier,
  assertSha256,
  assertSafeUnsignedInteger,
  assertUuidV4,
  captureDenseArray,
  captureExactRecord,
} = require('./reclamation-codec-primitives');
const {
  encodeQuestionJournalV2Local,
  normalizeQuestionDetailV2,
  normalizeQuestionJournalV2Local,
  normalizeQuestionReservation,
} = require('./common-question-reclamation-codec');
const {
  encodeCheckpointV3Local,
  encodeInstructionJournalV2Local,
  normalizeDeliveryRecordV2Local,
  normalizeCheckpointV3Local,
  normalizeInstructionJournalV2Local,
  normalizeInstructionRecordV2Local,
} = require('./delivery-reclamation-codec');
const {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
} = require('./question-reclamation-anchor-codec');
const { encodeNormalized } = require('./reclamation-json-codec');
const { MAX_FREE_TEXT, MAX_LATE_ANSWERS } = require('./common-question-kernel');

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const TERMINAL_RETENTION_MS = 604_800_000;
const MAX_SOURCE_BYTES = 16_777_216;
const MAX_QUESTION_RECORDS = 20_000;
const MAX_CHECKPOINT_RECORDS = 50_000;
const MAX_ELIGIBLE_IDS = 20_000;
const NORMAL_ANCHOR_MAX_BYTES = 16_777_216;
const MAX_RETIRED_PERIODS = 20_000;
const FIXED_H_COMPONENTS = Object.freeze({
  questions: Object.freeze({ structureFactor: 18, maxRecords: 20_000, perRecordExtraBytes: 4_997, wrapperExtraBytes: 461 }),
  checkpoint: Object.freeze({ structureFactor: 18, maxRecords: 17_753, perRecordExtraBytes: 32_161, wrapperExtraBytes: 600 }),
  instructions: Object.freeze({ structureFactor: 16, maxRecords: 20_000, perRecordExtraBytes: 365, wrapperExtraBytes: 441 }),
});
const MIGRATION_BOUNDARIES = Object.freeze(['migration', 'retained', 'prepared', 'reclaimed']);
const FIXED_OPERATION_ID = '00000000-0000-4000-8000-000000000000';
const MAX_ESCAPED_IDENTIFIER = '\uD800'.repeat(512);
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const SOURCE_FIELDS = [
  'slot', 'sourcePresent', 'schemaVersion', 'revision', 'sizeBytes', 'sha256',
  'targetSchemaVersion', 'targetRevision', 'targetSizeBytes', 'targetSha256',
];
const SOURCE_LIMITS = Object.freeze({
  questions: Object.freeze({ sourceSchemaVersion: 1, targetSchemaVersion: 2, maxRecords: MAX_QUESTION_RECORDS }),
  checkpoint: Object.freeze({ sourceSchemaVersion: 2, targetSchemaVersion: 3, maxRecords: MAX_CHECKPOINT_RECORDS }),
  instructions: Object.freeze({ sourceSchemaVersion: 1, targetSchemaVersion: 2, maxRecords: MAX_QUESTION_RECORDS }),
});
const ALLOWANCE_FIELDS = [
  'operationId', 'sourceSchemaVersion', 'sourceSizeBytes', 'sourceSha256', 'maxExtraBytes',
  'eligibleQuestionIds',
];
const DELIVERY_ALLOWANCE_FIELDS = [
  'operationId', 'sourceSchemaVersion', 'sourceSizeBytes', 'sourceSha256', 'maxExtraBytes',
  'eligibleAttemptIds',
];
const SOURCE_GRANT_INPUT_FIELDS = [
  'slot', 'sourcePresent', 'sourceSchemaVersion', 'sourceRevision', 'sourceSizeBytes',
  'sourceSha256', 'currentByteLimit', 'anchor', 'eligibleIds', 'projections',
];
const PROJECTION_FIELDS = ['withoutGrant', 'withMaximumGrant'];
const PROJECTION_ROW_FIELDS = ['questionCandidates', 'deliveryCandidates', 'instructionCandidates'];
const PROJECTION_CANDIDATE_FIELDS = ['snapshot', 'encoded'];
const ANCHOR_PERIOD_FIELDS = ['identity', 'periodId'];
const QUESTION_CANDIDATE_FIELDS = [
  'internalQuestionId', 'currentDetail', 'maxFutureDetail', 'retainedReservation',
  'preparedReservation', 'reclaimedReservation',
];
const DELIVERY_CANDIDATE_ROW_FIELDS = ['deliveryAttemptId', 'candidates'];
const INSTRUCTION_CANDIDATE_ROW_FIELDS = ['deliveryAttemptId', 'candidates'];
const RECORD_VARIANT_FIELDS = ['variant', 'record'];
const MAX_DELIVERY_RECORDS = 20_000;

const INVALID_CAPACITY = 'invalid_reclamation_capacity';

function requireValue(condition, code = INVALID_CAPACITY) {
  if (!condition) throw new TypeError(code);
}

function captureRecord(value, fields, code = INVALID_CAPACITY) {
  return captureExactRecord(value, fields, code);
}

function captureRecordWithOptional(value, requiredFields, optionalFields, code = INVALID_CAPACITY) {
  let ownKeys;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(code);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw new TypeError(code);
  }
  const allowed = new Set([...requiredFields, ...optionalFields]);
  requireValue(ownKeys.every((key) => typeof key === 'string' && allowed.has(key)), code);
  const present = new Set(ownKeys);
  requireValue(requiredFields.every((field) => present.has(field)), code);
  return captureRecord(value, [...requiredFields, ...optionalFields.filter((field) => present.has(field))], code);
}

function captureArray(value, maxLength, code = INVALID_CAPACITY) {
  return captureDenseArray(value, maxLength, code);
}

function checkedCapacityAdd(left, right) {
  assertSafeUnsignedInteger(left, INVALID_CAPACITY);
  assertSafeUnsignedInteger(right, INVALID_CAPACITY);
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new RangeError('reclamation_capacity_overflow');
  return result;
}

function checkedCapacityMultiply(left, right) {
  assertSafeUnsignedInteger(left, INVALID_CAPACITY);
  assertSafeUnsignedInteger(right, INVALID_CAPACITY);
  const result = left * right;
  if (!Number.isSafeInteger(result)) throw new RangeError('reclamation_capacity_overflow');
  return result;
}

function checkedCapacitySum(values) {
  const items = captureArray(values, 64);
  return items.reduce((total, value) => checkedCapacityAdd(total, value), 0);
}

function migrationTargetRevision(sourcePresent, sourceRevision) {
  requireValue(typeof sourcePresent === 'boolean');
  if (!sourcePresent) {
    requireValue(sourceRevision === null);
    return 0;
  }
  assertSafeUnsignedInteger(sourceRevision, INVALID_CAPACITY);
  if (sourceRevision === MAX_SAFE_INTEGER) throw new RangeError('migration_source_revision_overflow');
  return sourceRevision + 1;
}

function serializedPrettyJsonBytes(value) {
  return encodeNormalized(value).sizeBytes;
}

function createAnchorPeriodSkeleton() {
  return {
    identity: {
      provider: 'claude',
      nativeIdKind: 'session',
      hostId: '',
      homeScopeId: '',
      nativeId: '',
    },
    periodId: '',
    retiredAt: MAX_SAFE_INTEGER,
    reason: 'confirmed-retirement',
  };
}

function createAnchorTargetSkeleton() {
  return {
    internalQuestionId: '',
    commonKeyDigest: '0'.repeat(64),
    periodIndex: MAX_RETIRED_PERIODS - 1,
    recordDigest: '0'.repeat(64),
    deliveryPresence: 'checkpoint',
    deliveryIntent: {
      deliveryAttemptId: '',
      logicalMessageId: '',
      revision: MAX_SAFE_INTEGER,
      payloadDigest: '0'.repeat(64),
    },
    checkpointState: 'superseded_before_send',
  };
}

function createAnchorSourceSkeleton(slot) {
  const versions = SOURCE_LIMITS[slot];
  return {
    slot,
    sourcePresent: true,
    schemaVersion: versions.sourceSchemaVersion,
    revision: MAX_SAFE_INTEGER,
    sizeBytes: MAX_SOURCE_BYTES,
    sha256: '0'.repeat(64),
    targetSchemaVersion: versions.targetSchemaVersion,
    targetRevision: MAX_SAFE_INTEGER,
    targetSizeBytes: MAX_SAFE_INTEGER,
    targetSha256: '0'.repeat(64),
  };
}

function createAnchorSkeleton({ retiredQuestionPeriods = [], migration = null } = {}) {
  return {
    schemaVersion: 1,
    revision: MAX_SAFE_INTEGER,
    storeId: '00000000-0000-4000-8000-000000000000',
    retiredQuestionPeriods,
    migration,
  };
}

function createMigrationSkeleton({ sources, targets = [] }) {
  return {
    operationId: '00000000-0000-4000-8000-000000000000',
    startedAt: MAX_SAFE_INTEGER,
    phase: 'installing',
    sources,
    targets,
  };
}

function measureFixedAnchorMigrationBounds() {
  const noRetiredPeriods = createAnchorSkeleton();
  const oneRetiredPeriod = createAnchorSkeleton({ retiredQuestionPeriods: [createAnchorPeriodSkeleton()] });
  const kPeriod = serializedPrettyJsonBytes(oneRetiredPeriod) - serializedPrettyJsonBytes(noRetiredPeriods);

  const sources = ['checkpoint', 'instructions', 'questions'].map(createAnchorSourceSkeleton);
  const emptyMigration = createAnchorSkeleton({ migration: createMigrationSkeleton({ sources }) });
  const kManifest = serializedPrettyJsonBytes(emptyMigration);
  const oneTargetMigration = createAnchorSkeleton({
    migration: createMigrationSkeleton({ sources, targets: [createAnchorTargetSkeleton()] }),
  });
  const kQuestion = serializedPrettyJsonBytes(oneTargetMigration) - serializedPrettyJsonBytes(emptyMigration);
  const targetBytes = checkedCapacityMultiply(MAX_QUESTION_RECORDS, kQuestion);
  const retiredBytes = checkedCapacityMultiply(MAX_RETIRED_PERIODS, kPeriod);
  const sourceBytes = MAX_SOURCE_BYTES;
  const migrationBytes = checkedCapacitySum([sourceBytes, targetBytes, retiredBytes, kManifest]);
  const migrationAnchorMaxBytes = checkedCapacityAdd(NORMAL_ANCHOR_MAX_BYTES, migrationBytes);

  return Object.freeze({
    kQuestionBytes: kQuestion,
    kRetiredPeriodBytes: kPeriod,
    kManifestBytes: kManifest,
    migrationBytes,
    migrationAnchorMaxBytes,
  });
}

const FIXED_ANCHOR_MIGRATION_BOUNDS = measureFixedAnchorMigrationBounds();
const FIXED_H_BOUNDS = Object.freeze(Object.fromEntries(Object.entries(FIXED_H_COMPONENTS).map(([slot, parts]) => {
  const structureBytes = checkedCapacityMultiply(parts.structureFactor - 1, MAX_SOURCE_BYTES);
  const recordBytes = checkedCapacityMultiply(parts.maxRecords, parts.perRecordExtraBytes);
  return [slot, checkedCapacitySum([structureBytes, recordBytes, parts.wrapperExtraBytes])];
})));

function canonicalIdentityPeriodKey(identity, periodId) {
  return [...IDENTITY_FIELDS.map((field) => identity[field]), periodId]
    .map((value) => `${value.length}:${value}`)
    .join('');
}

function normalizeIdentityForReservation(value) {
  const identity = captureRecord(value, IDENTITY_FIELDS);
  requireValue((identity.provider === 'claude' && identity.nativeIdKind === 'session') ||
    (identity.provider === 'codex' && identity.nativeIdKind === 'thread'));
  for (const field of IDENTITY_FIELDS.slice(2)) assertIdentifier(identity[field], INVALID_CAPACITY);
  return Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, identity[field]]));
}

function normalizePeriodForReservation(value) {
  const period = captureRecord(value, ANCHOR_PERIOD_FIELDS);
  const identity = normalizeIdentityForReservation(period.identity);
  assertIdentifier(period.periodId, INVALID_CAPACITY);
  return { identity, periodId: period.periodId };
}

function measurePendingQuestionPeriodCapacity(anchorValue, activePeriodsValue) {
  const anchor = normalizeQuestionReclamationAnchorV1Local(anchorValue);
  requireValue(anchor.migration === null);

  const retiredKeys = new Set(anchor.retiredQuestionPeriods.map(({ identity, periodId }) =>
    canonicalIdentityPeriodKey(identity, periodId)));
  const pendingKeys = new Set();
  const pendingPeriods = [];
  for (const value of captureArray(activePeriodsValue, MAX_QUESTION_RECORDS)) {
    const period = normalizePeriodForReservation(value);
    const key = canonicalIdentityPeriodKey(period.identity, period.periodId);
    if (retiredKeys.has(key) || pendingKeys.has(key)) continue;
    pendingKeys.add(key);
    pendingPeriods.push(period);
  }

  const pendingCount = pendingPeriods.length;
  const projectedCount = anchor.retiredQuestionPeriods.length + pendingCount;
  const currentBytes = encodeQuestionReclamationAnchorV1Local(anchor).sizeBytes;
  if (projectedCount > MAX_RETIRED_PERIODS) {
    return Object.freeze({
      currentBytes,
      projectedBytes: null,
      pendingBytes: null,
      pendingCount,
      projectedCount,
      fits: false,
      reason: 'period_count_limit',
    });
  }
  if (anchor.revision > MAX_SAFE_INTEGER - pendingCount) {
    return Object.freeze({
      currentBytes,
      projectedBytes: null,
      pendingBytes: null,
      pendingCount,
      projectedCount,
      fits: false,
      reason: 'revision_overflow',
    });
  }
  checkedCapacityAdd(anchor.revision, pendingCount);
  const revisionReservedAnchor = cloneNormalizedJson(anchor);
  revisionReservedAnchor.revision = MAX_SAFE_INTEGER;
  const revisionReservedBytes = encodeQuestionReclamationAnchorV1Local(revisionReservedAnchor).sizeBytes;
  const revisionGrowthBytes = revisionReservedBytes - currentBytes;
  requireValue(revisionGrowthBytes >= 0);
  const projectedAnchor = {
    schemaVersion: 1,
    revision: MAX_SAFE_INTEGER,
    storeId: anchor.storeId,
    retiredQuestionPeriods: [
      ...anchor.retiredQuestionPeriods,
      ...pendingPeriods.map(({ identity, periodId }) => ({
        identity,
        periodId,
        retiredAt: MAX_SAFE_INTEGER,
        reason: 'confirmed-retirement',
      })),
    ],
    migration: null,
  };
  const projectedBytes = encodeQuestionReclamationAnchorV1Local(projectedAnchor).sizeBytes;
  const pendingBytes = projectedBytes - currentBytes;
  requireValue(pendingBytes >= 0);

  return Object.freeze({
    currentBytes,
    projectedBytes,
    pendingBytes,
    revisionGrowthBytes,
    pendingCount,
    projectedCount,
    fits: projectedCount <= MAX_RETIRED_PERIODS && projectedBytes <= NORMAL_ANCHOR_MAX_BYTES,
    reason: projectedBytes <= NORMAL_ANCHOR_MAX_BYTES ? null : 'byte_limit',
  });
}

function embeddedRecordBytes(value) {
  return encodeNormalized({ records: [value] });
}

function sameEmbeddedRecord(left, right) {
  if (left === null || right === null) return left === right;
  return embeddedRecordBytes(left).bytes.equals(embeddedRecordBytes(right).bytes);
}

function normalizeQuestionCandidateRecord(value, normalizer) {
  return value === null ? null : normalizer(value);
}

function worstQuestionAnswers(questions) {
  const freeText = '\uD800'.repeat(MAX_FREE_TEXT);
  return questions.map((question) => {
    let optionIds = [];
    if (question.mode === 'multi') {
      optionIds = question.options.map(({ id }) => id);
    } else if (question.options.length > 0) {
      const largest = question.options.reduce((best, option) =>
        Buffer.byteLength(JSON.stringify(option.id), 'utf8') > Buffer.byteLength(JSON.stringify(best.id), 'utf8')
          ? option : best);
      optionIds = [largest.id];
    }
    return { questionId: question.id, optionIds, freeText: question.allowFreeText ? freeText : null };
  });
}

function safeCompactValue(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    const result = [];
    Object.defineProperty(result, 'toJSON', { value: null });
    for (const item of value) result.push(safeCompactValue(item));
    return result;
  }
  const result = Object.create(null);
  for (const key of Object.keys(value)) result[key] = safeCompactValue(value[key]);
  return result;
}

function safeCompactJson(value) {
  return JSON.stringify(safeCompactValue(value));
}

function compactDigest(value) {
  return createHash('sha256').update(safeCompactJson(value), 'utf8').digest('hex');
}

function maxFutureQuestionDetail(currentValue) {
  const current = normalizeQuestionDetailV2(currentValue);
  const answers = worstQuestionAnswers(current.questions);
  const variants = [];
  const addFutureMetadata = (record) => {
    record.quarantinedAt = MAX_SAFE_INTEGER;
    if (record.deliveryIntent !== null &&
        ['not_created', 'creating'].includes(record.deliveryCreationState)) {
      record.deliveryCreationState = 'indeterminate';
    }
  };
  const addLateAnswers = (record) => {
    addFutureMetadata(record);
    record.cancelledAt ??= MAX_SAFE_INTEGER;
    record.externalResolution ??= {
      resolvedAt: MAX_SAFE_INTEGER,
      evidenceDigest: 'f'.repeat(64),
    };
    record.lateAnswers = record.lateAnswers.slice();
    const digest = compactDigest(answers);
    while (record.lateAnswers.length < MAX_LATE_ANSWERS) {
      record.lateAnswers.push({ submittedAt: MAX_SAFE_INTEGER, digest, answers });
    }
  };

  if (current.quarantinedAt !== null) return current;
  if (current.selection === null && current.cancelledAt === null && current.externalResolution === null &&
      current.revision < MAX_SAFE_INTEGER) {
    const revision = current.revision + 1;
    const selection = { source: 'manual', selectedAt: current.deadlineAt, answers };
    const intent = {
      deliveryAttemptId: MAX_ESCAPED_IDENTIFIER,
      logicalMessageId: MAX_ESCAPED_IDENTIFIER,
      revision,
      payloadDigest: compactDigest({ questionId: current.questionId, revision, answers }),
    };
    const manual = cloneNormalizedJson(current);
    manual.revision = revision;
    manual.selection = selection;
    manual.deliveryIntent = intent;
    addLateAnswers(manual);
    variants.push(normalizeQuestionDetailV2(manual));

    const awayAnswers = current.questions.map((question) => ({
      questionId: question.id,
      optionIds: question.recommendedOptionId === null ? [] : [question.recommendedOptionId],
      freeText: null,
    }));
    if (current.questions.every((question) => question.mode === 'single' &&
        question.recommendedOptionId !== null)) {
      const away = cloneNormalizedJson(current);
      away.revision = revision;
      away.selection = { source: 'away-default', selectedAt: current.deadlineAt, answers: awayAnswers };
      away.deliveryIntent = {
        deliveryAttemptId: MAX_ESCAPED_IDENTIFIER,
        logicalMessageId: MAX_ESCAPED_IDENTIFIER,
        revision,
        payloadDigest: compactDigest({ questionId: current.questionId, revision, answers: awayAnswers }),
      };
      addLateAnswers(away);
      variants.push(normalizeQuestionDetailV2(away));
    }
  } else {
    const future = cloneNormalizedJson(current);
    addLateAnswers(future);
    variants.push(normalizeQuestionDetailV2(future));
  }
  return variants.reduce((largest, candidate) =>
    embeddedRecordBytes(candidate).sizeBytes > embeddedRecordBytes(largest).sizeBytes ? candidate : largest);
}

function reservationMirroringDetail(reservation, detail, overrides = {}) {
  return normalizeQuestionReservation({
    ...reservation,
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
    deliveryIntent: detail.deliveryIntent,
    deliveryCreationState: detail.deliveryCreationState,
    externalResolution: detail.externalResolution,
    cancelledAt: detail.cancelledAt,
    quarantinedAt: detail.quarantinedAt,
    ...overrides,
  });
}

function requiredQuestionReservationCandidates(currentReservation, maxDetail) {
  const candidates = [currentReservation];
  if (currentReservation.bodyState === 'reclaimed') return candidates;
  if (currentReservation.reclamation !== null) {
    candidates.push(normalizeQuestionReservation({
      ...currentReservation,
      bodyState: 'reclaimed',
      reclaimedAt: MAX_SAFE_INTEGER,
    }));
    return candidates;
  }

  const quarantinedAt = currentReservation.quarantinedAt ?? MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS;
  if (quarantinedAt > MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS) return candidates;
  const sourceDetail = cloneNormalizedJson(maxDetail);
  sourceDetail.quarantinedAt = quarantinedAt;
  const frozen = currentReservation.quarantinedAt !== null;
  const states = frozen
    ? [{
      creationState: currentReservation.deliveryCreationState,
      checkpointState: currentReservation.checkpointState,
      presence: currentReservation.deliveryCreationState === 'not_created' ? 'none'
        : currentReservation.deliveryCreationState === 'checkpointed' ? 'checkpoint' : 'indeterminate',
    }]
    : sourceDetail.deliveryIntent === null
      ? [{ creationState: 'not_created', checkpointState: null, presence: 'none' }]
      : [
        { creationState: 'not_created', checkpointState: null, presence: 'none' },
        { creationState: 'indeterminate', checkpointState: 'unknown', presence: 'indeterminate' },
        { creationState: 'checkpointed', checkpointState: 'superseded_before_send', presence: 'checkpoint' },
      ];
  for (const state of states) {
    const detail = cloneNormalizedJson(sourceDetail);
    detail.deliveryCreationState = state.creationState;
    const preparedReservation = reservationMirroringDetail(currentReservation, detail, {
      sourceClaimsDigest: state.creationState === 'checkpointed'
        ? frozen ? currentReservation.sourceClaimsDigest : 'f'.repeat(64)
        : null,
      sessionId: state.creationState === 'checkpointed'
        ? frozen ? currentReservation.sessionId : MAX_ESCAPED_IDENTIFIER
        : null,
      checkpointState: state.checkpointState,
      terminalResultKind: frozen ? currentReservation.terminalResultKind
        : state.checkpointState === 'superseded_before_send' ? 'superseded_before_send' : null,
      quarantinedAt,
      bodyState: 'retained',
      reclaimedAt: null,
      reclamation: {
        operationId: FIXED_OPERATION_ID,
        preparedAt: MAX_SAFE_INTEGER,
        deliveryPresence: state.presence,
        checkpointState: state.checkpointState,
      },
    });
    candidates.push(preparedReservation);
    candidates.push(normalizeQuestionReservation({
      ...preparedReservation,
      bodyState: 'reclaimed',
      reclaimedAt: MAX_SAFE_INTEGER,
    }));
  }
  return candidates;
}

function measureQuestionJournalReservationBytes(inputValue) {
  const input = captureRecordWithOptional(inputValue, ['snapshot', 'currentByteLimit'], ['questionCandidates']);
  assertSafeUnsignedInteger(input.currentByteLimit, INVALID_CAPACITY);
  requireValue(input.currentByteLimit > 0 && input.currentByteLimit <= MAX_SOURCE_BYTES);
  const snapshot = normalizeQuestionJournalV2Local(input.snapshot);
  const candidates = captureArray(input.questionCandidates ?? questionCandidatesForSnapshot(snapshot),
    MAX_QUESTION_RECORDS);
  requireValue(candidates.length === snapshot.reservations.length);

  const suppliedById = new Map();
  for (const value of candidates) {
    const candidate = captureRecord(value, QUESTION_CANDIDATE_FIELDS);
    const currentDetail = normalizeQuestionCandidateRecord(candidate.currentDetail, normalizeQuestionDetailV2);
    const maxFutureDetail = normalizeQuestionCandidateRecord(candidate.maxFutureDetail, normalizeQuestionDetailV2);
    const reservations = [
      candidate.retainedReservation === null ? null : normalizeQuestionReservation(candidate.retainedReservation),
      candidate.preparedReservation === null ? null : normalizeQuestionReservation(candidate.preparedReservation),
      candidate.reclaimedReservation === null ? null : normalizeQuestionReservation(candidate.reclaimedReservation),
    ];
    const rowId = candidate.internalQuestionId;
    assertIdentifier(rowId, INVALID_CAPACITY);
    requireValue(!suppliedById.has(rowId));
    requireValue(currentDetail === null || currentDetail.internalQuestionId === rowId);
    requireValue(maxFutureDetail === null || maxFutureDetail.internalQuestionId === rowId);
    for (const reservation of reservations) {
      requireValue(reservation === null || reservation.internalQuestionId === rowId);
    }
    suppliedById.set(rowId, { currentDetail, maxFutureDetail, reservations });
  }

  const detailsById = new Map(snapshot.questions.map((detail) => [detail.internalQuestionId, detail]));
  const reservationsById = new Map(snapshot.reservations.map((reservation) => [reservation.internalQuestionId, reservation]));
  requireValue(suppliedById.size === reservationsById.size &&
    [...suppliedById.keys()].every((identifier) => reservationsById.has(identifier)));
  let detailGrowthBytes = 0;
  let reservationGrowthBytes = 0;

  for (const [internalQuestionId, actualReservation] of reservationsById) {
    const supplied = suppliedById.get(internalQuestionId);
    const actualDetail = detailsById.get(internalQuestionId) ?? null;
    requireValue(supplied !== undefined && sameEmbeddedRecord(supplied.currentDetail, actualDetail) &&
      sameEmbeddedRecord(supplied.reservations[0], actualReservation));

    const derivedDetail = actualDetail === null ? null : maxFutureQuestionDetail(actualDetail);
    if (actualDetail === null) {
      requireValue(supplied.maxFutureDetail === null);
    } else {
      requireValue(supplied.maxFutureDetail !== null);
      if (actualDetail.quarantinedAt !== null) {
        requireValue(sameEmbeddedRecord(supplied.maxFutureDetail, actualDetail));
      }
      const currentDetailBytes = embeddedRecordBytes(actualDetail).sizeBytes;
      const derivedBytes = embeddedRecordBytes(derivedDetail).sizeBytes;
      const suppliedBytes = embeddedRecordBytes(supplied.maxFutureDetail).sizeBytes;
      requireValue(suppliedBytes >= derivedBytes);
      detailGrowthBytes = checkedCapacityAdd(detailGrowthBytes,
        Math.max(0, Math.max(derivedBytes, suppliedBytes) - currentDetailBytes));
    }

    const derivedReservations = requiredQuestionReservationCandidates(actualReservation, derivedDetail);
    const candidateReservations = [
      ...derivedReservations,
      ...supplied.reservations.filter((reservation) => reservation !== null),
    ];
    for (const reservation of supplied.reservations) {
      if (reservation !== null) requireValue(reservation.internalQuestionId === internalQuestionId);
    }
    if (actualReservation.bodyState === 'reclaimed') {
      requireValue(supplied.reservations[2] === null ||
        sameEmbeddedRecord(supplied.reservations[2], actualReservation));
    }
    const currentReservationBytes = embeddedRecordBytes(actualReservation).sizeBytes;
    const maxReservationBytes = Math.max(...candidateReservations.map((reservation) =>
      embeddedRecordBytes(reservation).sizeBytes));
    reservationGrowthBytes = checkedCapacityAdd(reservationGrowthBytes,
      Math.max(0, maxReservationBytes - currentReservationBytes));
  }

  const currentBytes = encodeQuestionJournalV2Local(snapshot).sizeBytes;
  const maxRevisionSnapshot = cloneNormalizedJson(snapshot);
  maxRevisionSnapshot.revision = MAX_SAFE_INTEGER;
  const revisionGrowthBytes = encodeQuestionJournalV2Local(maxRevisionSnapshot).sizeBytes - currentBytes;
  requireValue(revisionGrowthBytes >= 0);
  const reservedBytes = checkedCapacitySum([
    currentBytes,
    revisionGrowthBytes,
    detailGrowthBytes,
    reservationGrowthBytes,
  ]);
  return Object.freeze({
    currentBytes,
    revisionGrowthBytes,
    detailGrowthBytes,
    reservationGrowthBytes,
    reservedBytes,
    currentByteLimit: input.currentByteLimit,
    fits: reservedBytes <= input.currentByteLimit,
  });
}

function measureNewQuestionCandidateCapacity(inputValue) {
  const input = captureRecordWithOptional(inputValue,
    ['currentSnapshot', 'candidateSnapshot', 'newInternalQuestionId', 'currentByteLimit'],
    ['questionCandidates']);
  assertIdentifier(input.newInternalQuestionId, INVALID_CAPACITY);
  const current = normalizeQuestionJournalV2Local(input.currentSnapshot);
  const candidate = normalizeQuestionJournalV2Local(input.candidateSnapshot);
  requireValue(current.storeId === candidate.storeId && current.schemaVersion === candidate.schemaVersion);
  requireValue(current.revision < MAX_SAFE_INTEGER && candidate.revision === current.revision + 1,
    'question_revision_overflow');
  requireValue(current.questions.length < MAX_QUESTION_RECORDS &&
    candidate.questions.length === current.questions.length + 1 &&
    candidate.reservations.length === current.reservations.length + 1,
    'question_record_limit');

  const currentDetails = new Map(current.questions.map((record) => [record.internalQuestionId, record]));
  const candidateDetails = new Map(candidate.questions.map((record) => [record.internalQuestionId, record]));
  const currentReservations = new Map(current.reservations.map((record) => [record.internalQuestionId, record]));
  const candidateReservations = new Map(candidate.reservations.map((record) => [record.internalQuestionId, record]));
  requireValue(candidateDetails.has(input.newInternalQuestionId) && !currentDetails.has(input.newInternalQuestionId));
  requireValue(candidateReservations.has(input.newInternalQuestionId) && !currentReservations.has(input.newInternalQuestionId));
  for (const [identifier, detail] of currentDetails) {
    requireValue(sameEmbeddedRecord(detail, candidateDetails.get(identifier)));
  }
  for (const [identifier, reservation] of currentReservations) {
    requireValue(sameEmbeddedRecord(reservation, candidateReservations.get(identifier)));
  }
  requireValue(sameEmbeddedRecord(current.migrationAllowance, candidate.migrationAllowance));
  if (current.migrationAllowance !== null) {
    requireValue(!current.migrationAllowance.eligibleQuestionIds.includes(input.newInternalQuestionId));
  }

  const measurement = measureQuestionJournalReservationBytes({
    snapshot: candidate,
    ...(Object.hasOwn(input, 'questionCandidates') ? { questionCandidates: input.questionCandidates } : {}),
    currentByteLimit: input.currentByteLimit,
  });
  return Object.freeze({ ...measurement, accepted: measurement.fits });
}

function getSlotEncoder(slot) {
  if (slot === 'questions') return encodeQuestionJournalV2Local;
  if (slot === 'checkpoint') return encodeCheckpointV3Local;
  if (slot === 'instructions') return encodeInstructionJournalV2Local;
  throw new TypeError(INVALID_CAPACITY);
}

function getRosterField(slot) {
  return slot === 'questions' ? 'eligibleQuestionIds' : 'eligibleAttemptIds';
}

function normalizeRoster(value) {
  const roster = captureArray(value, MAX_ELIGIBLE_IDS);
  const seen = new Set();
  for (const identifier of roster) {
    assertIdentifier(identifier, INVALID_CAPACITY);
    requireValue(!seen.has(identifier));
    seen.add(identifier);
  }
  return roster.slice();
}

function validateSourceDescriptor(anchor, input) {
  const migration = anchor.migration;
  requireValue(migration !== null && migration.phase === 'prepared');
  const matching = migration.sources.filter((source) => source.slot === input.slot);
  requireValue(matching.length === 1);
  const descriptor = captureRecord(matching[0], SOURCE_FIELDS);
  const limits = SOURCE_LIMITS[input.slot];
  requireValue(input.sourcePresent === descriptor.sourcePresent && descriptor.sourcePresent);
  requireValue(input.sourceSchemaVersion === limits.sourceSchemaVersion &&
    descriptor.schemaVersion === input.sourceSchemaVersion);
  requireValue(input.sourceRevision === descriptor.revision);
  requireValue(descriptor.targetRevision === migrationTargetRevision(true, input.sourceRevision));
  requireValue(input.sourceSizeBytes === descriptor.sizeBytes && input.sourceSizeBytes <= MAX_SOURCE_BYTES);
  assertSha256(input.sourceSha256, INVALID_CAPACITY);
  requireValue(input.sourceSha256 === descriptor.sha256);
  requireValue(descriptor.targetSchemaVersion === limits.targetSchemaVersion);
  return migration.operationId;
}

function readAllowance(snapshot, slot) {
  const normalized = slot === 'questions'
    ? normalizeQuestionJournalV2Local(snapshot)
    : slot === 'checkpoint'
      ? normalizeCheckpointV3Local(snapshot)
      : normalizeInstructionJournalV2Local(snapshot);
  const fields = slot === 'questions'
    ? ['schemaVersion', 'storeId', 'revision', 'questions', 'reservations', 'migrationAllowance']
    : slot === 'checkpoint'
      ? ['schemaVersion', 'storeId', 'revision', 'registrations', 'ledger', 'migrationAllowance']
      : ['schemaVersion', 'revision', 'storeId', 'migrationAllowance', 'instructions'];
  const record = captureRecord(normalized, fields);
  return record.migrationAllowance;
}

function validateGrantCandidate(snapshot, input, operationId, roster, expectedMaximum) {
  const normalized = normalizeSlotSnapshot(snapshot, input.slot);
  const encoded = getSlotEncoder(input.slot)(normalized);
  const allowance = readAllowance(normalized, input.slot);
  if (!expectedMaximum) {
    requireValue(allowance === null);
    return { snapshot: normalized, encoded };
  }

  const fields = input.slot === 'questions' ? ALLOWANCE_FIELDS : DELIVERY_ALLOWANCE_FIELDS;
  const grant = captureRecord(allowance, fields);
  requireValue(grant.operationId === operationId);
  requireValue(grant.sourceSchemaVersion === input.sourceSchemaVersion);
  requireValue(grant.sourceSizeBytes === input.sourceSizeBytes);
  assertSha256(grant.sourceSha256, INVALID_CAPACITY);
  requireValue(grant.sourceSha256 === input.sourceSha256);
  requireValue(grant.maxExtraBytes === MAX_SAFE_INTEGER);
  const rosterField = getRosterField(input.slot);
  const candidateRoster = normalizeRoster(grant[rosterField]);
  requireValue(candidateRoster.length === roster.length && candidateRoster.every((item, index) => item === roster[index]));
  return { snapshot: normalized, encoded };
}

function normalizeSlotSnapshot(snapshot, slot) {
  if (slot === 'questions') return normalizeQuestionJournalV2Local(snapshot);
  if (slot === 'checkpoint') return normalizeCheckpointV3Local(snapshot);
  return normalizeInstructionJournalV2Local(snapshot);
}

function validateProjectionEncoding(value, expected) {
  const encoded = captureRecord(value, ['bytes', 'sizeBytes', 'sha256']);
  requireValue(Buffer.isBuffer(encoded.bytes) && encoded.bytes.length === encoded.sizeBytes &&
    encoded.sizeBytes === expected.sizeBytes);
  assertSha256(encoded.sha256, INVALID_CAPACITY);
  requireValue(encoded.sha256 === expected.sha256 && encoded.bytes.equals(expected.bytes));
}

function deriveProjectedRoster(snapshot, slot) {
  if (slot === 'questions') return snapshot.questions.map((record) => record.internalQuestionId);
  if (slot === 'checkpoint') return snapshot.ledger.deliveries.map((record) => record.deliveryAttemptId);
  return snapshot.instructions.map((record) => record.deliveryAttemptId);
}

function normalizeProjectionCandidates(values, input, operationId, roster, expectedMaximum) {
  const candidates = captureRecord(values, MIGRATION_BOUNDARIES, INVALID_CAPACITY);
  const byBoundary = new Map();
  for (const boundary of MIGRATION_BOUNDARIES) {
    const candidate = captureRecord(candidates[boundary], PROJECTION_CANDIDATE_FIELDS);
    const normalized = validateGrantCandidate(candidate.snapshot, input, operationId, roster, expectedMaximum);
    validateProjectionEncoding(candidate.encoded, normalized.encoded);
    byBoundary.set(boundary, normalized);
  }
  const migration = byBoundary.get('migration');
  const actualRoster = deriveProjectedRoster(migration.snapshot, input.slot);
  requireValue(actualRoster.length === roster.length && actualRoster.every((item, index) => item === roster[index]));
  for (const candidate of byBoundary.values()) {
    requireValue(candidate.encoded.bytes.equals(migration.encoded.bytes));
  }
  return byBoundary;
}

function cloneNormalizedJson(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(cloneNormalizedJson);
  const result = Object.create(null);
  for (const key of Object.keys(value)) result[key] = cloneNormalizedJson(value[key]);
  return result;
}

function checkpointRecordBytes(record) {
  return encodeNormalized({ ledger: { deliveries: [record] } }).sizeBytes;
}

function instructionRecordBytes(record) {
  return encodeNormalized({ instructions: [record] }).sizeBytes;
}

function nativeItemIdForRecord(index, usedIds) {
  for (let suffix = index; suffix < index + MAX_CHECKPOINT_RECORDS + 1; suffix += 1) {
    let value = suffix;
    const encodedSuffix = new Array(3);
    for (let digit = encodedSuffix.length - 1; digit >= 0; digit -= 1) {
      encodedSuffix[digit] = String.fromCharCode(0xd800 + (value % 1024));
      value = Math.floor(value / 1024);
    }
    requireValue(value === 0);
    const identifier = `${'\uD800'.repeat(509)}${encodedSuffix.join('')}`;
    if (!usedIds.has(identifier)) {
      usedIds.add(identifier);
      return identifier;
    }
  }
  throw new RangeError('reclamation_capacity_candidate_id_exhausted');
}

function targetPeriodIdForDelivery(record) {
  return record.recordType === 'detail' ? record.target.periodId : record.targetRef.periodId;
}

function maxFutureCorrelation(record, nativeItemId) {
  const current = record.acceptedCorrelation ?? record.appliedCorrelation;
  return {
    deliveryAttemptId: record.deliveryAttemptId,
    revision: record.revision,
    payloadDigest: record.payloadDigest,
    targetPeriodId: targetPeriodIdForDelivery(record),
    nativeTurnId: current?.nativeTurnId ?? MAX_ESCAPED_IDENTIFIER,
    nativeItemId: current?.nativeItemId ?? nativeItemId,
    clientRequestId: record.deliveryAttemptId,
  };
}

function futureCorrelationsForDelivery(record, nativeItemId) {
  if (record.recordType === 'reclaimed' ||
      ['cancelled_before_send', 'superseded_before_send'].includes(record.state)) {
    return {
      acceptedCorrelation: record.acceptedCorrelation,
      appliedCorrelation: record.appliedCorrelation,
    };
  }
  if (record.state === 'applied') {
    const accepted = record.acceptedCorrelation;
    const applied = record.appliedCorrelation;
    return {
      acceptedCorrelation: accepted === null ? cloneNormalizedJson(applied) : {
        ...accepted,
        nativeTurnId: accepted.nativeTurnId ?? applied.nativeTurnId,
        nativeItemId: accepted.nativeItemId ?? applied.nativeItemId,
      },
      appliedCorrelation: applied,
    };
  }
  const correlation = maxFutureCorrelation(record, nativeItemId);
  return { acceptedCorrelation: correlation, appliedCorrelation: correlation };
}

function sourceReferenceForDelivery(source) {
  return {
    launchRef: source.launchRef,
    launchKey: [source.claims.launchId, source.claims.runId, source.claims.attemptId],
    sourceClaimsDigest: compactDigest(source.claims),
    identity: source.identity,
    executionBinding: source.executionBinding,
    conversationId: source.conversationId,
    sessionId: source.sessionId,
  };
}

function targetReferenceForDelivery(target) {
  if (target.kind === 'owner') {
    return {
      kind: 'owner',
      launchRef: null,
      launchKey: null,
      targetClaimsDigest: null,
      identity: target.identity,
      periodId: target.periodId,
      actor: target.actor,
      conversationId: target.conversationId,
      sessionId: target.sessionId,
    };
  }
  return {
    kind: 'execution',
    launchRef: target.launchRef,
    launchKey: [target.claims.launchId, target.claims.runId, target.claims.attemptId],
    targetClaimsDigest: compactDigest(target.claims),
    identity: target.identity,
    periodId: target.periodId,
    actor: target.actor,
    conversationId: target.conversationId,
    sessionId: target.sessionId,
  };
}

function reclaimedDeliveryCandidate(record, correlations, operationId) {
  if (record.recordType === 'reclaimed') {
    return normalizeDeliveryRecordV2Local({
      ...record,
      acceptedCorrelation: correlations.acceptedCorrelation,
      appliedCorrelation: correlations.appliedCorrelation,
    });
  }
  const reason = record.kind === 'question' ? 'retired_question_period' : 'terminal_retention';
  return normalizeDeliveryRecordV2Local({
    recordType: 'reclaimed',
    deliveryAttemptId: record.deliveryAttemptId,
    kind: record.kind,
    logicalMessageId: record.logicalMessageId,
    revision: record.revision,
    sourceExecutionId: record.sourceExecutionId,
    payloadDigest: record.payloadDigest,
    state: record.state,
    terminalAt: record.terminalAt,
    cancelRequested: record.cancelRequested,
    ownerGeneration: record.ownerGeneration,
    acceptedCorrelation: correlations.acceptedCorrelation,
    appliedCorrelation: correlations.appliedCorrelation,
    sourceRef: sourceReferenceForDelivery(record.source),
    targetRef: targetReferenceForDelivery(record.target),
    reclamation: {
      operationId,
      reclaimedAt: MAX_SAFE_INTEGER,
      reason,
    },
  });
}

function futureDeliveryRecordCandidates(record, index, usedNativeItemIds, operationId, earliestTime = 0) {
  const candidates = [record];
  if (record.recordType === 'reclaimed') return candidates;
  const nativeItemId = nativeItemIdForRecord(index, usedNativeItemIds);
  const correlations = futureCorrelationsForDelivery(record, nativeItemId);
  const currentCorrelations = {
    acceptedCorrelation: record.acceptedCorrelation,
    appliedCorrelation: record.appliedCorrelation,
  };
  const retentionDeadlineFits = (terminalAt) =>
    terminalAt <= MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS;
  if (['cancelled_before_send', 'superseded_before_send'].includes(record.state)) {
    if (retentionDeadlineFits(record.terminalAt) &&
        (record.kind !== 'question' || earliestTime <= MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS)) {
      candidates.push(reclaimedDeliveryCandidate(record,
        record.kind === 'question' ? currentCorrelations : correlations, operationId));
    }
    return candidates;
  }

  if (record.state === 'applied') {
    const updated = normalizeDeliveryRecordV2Local({
      ...record,
      acceptedCorrelation: correlations.acceptedCorrelation,
      appliedCorrelation: correlations.appliedCorrelation,
    });
    if (!sameEmbeddedRecord(updated, record)) candidates.push(updated);
    if (retentionDeadlineFits(record.terminalAt) &&
        (record.kind !== 'question' || earliestTime <= MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS)) {
      candidates.push(reclaimedDeliveryCandidate(record,
        record.kind === 'question' ? currentCorrelations : correlations, operationId));
      if (record.kind === 'question') {
        candidates.push(reclaimedDeliveryCandidate(updated, correlations, operationId));
      }
    }
    return candidates;
  }

  const futureApplied = normalizeDeliveryRecordV2Local({
    ...record,
    state: 'applied',
    terminalAt: MAX_SAFE_INTEGER,
    acceptedCorrelation: correlations.acceptedCorrelation,
    appliedCorrelation: correlations.appliedCorrelation,
  });
  candidates.push(futureApplied);
  if (record.kind === 'question') {
    if (['available', 'unknown'].includes(record.state) &&
        earliestTime <= MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS) {
      candidates.push(reclaimedDeliveryCandidate(record, currentCorrelations, operationId));
    }
    const reclaimableTerminalAt = MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS;
    if (earliestTime <= reclaimableTerminalAt && retentionDeadlineFits(reclaimableTerminalAt)) {
      const reclaimableApplied = normalizeDeliveryRecordV2Local({
        ...futureApplied,
        terminalAt: reclaimableTerminalAt,
      });
      candidates.push(reclaimedDeliveryCandidate(reclaimableApplied, correlations, operationId));
    }
    return candidates;
  }
  if (earliestTime <= MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS) {
    const reclaimableApplied = normalizeDeliveryRecordV2Local({
      ...record,
      state: 'applied',
      terminalAt: MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS,
      acceptedCorrelation: correlations.acceptedCorrelation,
      appliedCorrelation: correlations.appliedCorrelation,
    });
    candidates.push(reclaimableApplied);
    candidates.push(reclaimedDeliveryCandidate(reclaimableApplied, correlations, operationId));
  }
  return candidates;
}

function instructionFutureRecordCandidates(record, operationId, earliestTime = 0) {
  const candidates = [record];
  if (record.recordType === 'reclaimed') return candidates;
  if (record.reclamation !== null) {
    candidates.push(normalizeInstructionRecordV2Local({
      recordType: 'reclaimed',
      deliveryAttemptId: record.deliveryAttemptId,
      launchRef: record.launchRef,
      logicalMessageId: record.logicalMessageId,
      revision: record.revision,
      source: record.source,
      envelopeDigest: record.envelopeDigest,
      nativeContentDigest: record.nativeContentDigest,
      createdAt: record.createdAt,
      deliveryCreationState: record.deliveryCreationState,
      reclamation: record.reclamation,
      reclaimedAt: MAX_SAFE_INTEGER,
    }));
    return candidates;
  }
  if (record.deliveryCreationState === 'indeterminate') return candidates;
  let checkpointed = record;
  if (record.deliveryCreationState === 'not_created' || record.deliveryCreationState === 'creating') {
    candidates.push(normalizeInstructionRecordV2Local({
      ...record,
      deliveryCreationState: 'indeterminate',
    }));
    checkpointed = normalizeInstructionRecordV2Local({
      ...record,
      deliveryCreationState: 'checkpointed',
    });
    candidates.push(checkpointed);
  }
  if (earliestTime > MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS) return candidates;
  const prepared = normalizeInstructionRecordV2Local({
    ...checkpointed,
    reclamation: {
      operationId,
      preparedAt: MAX_SAFE_INTEGER,
      terminalState: 'superseded_before_send',
      terminalAt: MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS,
    },
  });
  candidates.push(prepared);
  candidates.push(normalizeInstructionRecordV2Local({
    recordType: 'reclaimed',
    deliveryAttemptId: prepared.deliveryAttemptId,
    launchRef: prepared.launchRef,
    logicalMessageId: prepared.logicalMessageId,
    revision: prepared.revision,
    source: prepared.source,
    envelopeDigest: prepared.envelopeDigest,
    nativeContentDigest: prepared.nativeContentDigest,
    createdAt: prepared.createdAt,
    deliveryCreationState: 'checkpointed',
    reclamation: prepared.reclamation,
    reclaimedAt: MAX_SAFE_INTEGER,
  }));
  return candidates;
}

function checkpointFutureGrowthBytes(snapshot, operationId = FIXED_OPERATION_ID, earliestTime = 0,
    externalCandidates = null) {
  const normalized = normalizeCheckpointV3Local(snapshot);
  const usedNativeItemIds = new Set();
  for (const record of normalized.ledger.deliveries) {
    for (const correlation of [record.acceptedCorrelation, record.appliedCorrelation]) {
      if (correlation?.nativeItemId !== null && correlation?.nativeItemId !== undefined) {
        usedNativeItemIds.add(correlation.nativeItemId);
      }
    }
  }
  let growth = 0;
  normalized.ledger.deliveries.forEach((record, index) => {
    const currentBytes = checkpointRecordBytes(record);
    const internalBytes = futureDeliveryRecordCandidates(record, index, usedNativeItemIds,
      operationId, earliestTime).map((candidate) => checkpointRecordBytes(candidate));
    const external = externalCandidates?.get(record.deliveryAttemptId);
    if (external !== undefined) {
      for (const candidate of external.values()) internalBytes.push(checkpointRecordBytes(candidate));
    }
    const futureBytes = Math.max(currentBytes, ...internalBytes);
    const delta = Math.max(0, futureBytes - currentBytes);
    growth = checkedCapacityAdd(growth, delta);
  });
  return growth;
}

function instructionFutureGrowthBytes(snapshot, operationId = FIXED_OPERATION_ID, earliestTime = 0,
    externalCandidates = null) {
  const normalized = normalizeInstructionJournalV2Local(snapshot);
  let growth = 0;
  for (const record of normalized.instructions) {
    const currentBytes = instructionRecordBytes(record);
    const candidates = instructionFutureRecordCandidates(record, operationId, earliestTime)
      .map((candidate) => instructionRecordBytes(candidate));
    const external = externalCandidates?.get(record.deliveryAttemptId);
    if (external !== undefined) {
      for (const candidate of external.values()) candidates.push(instructionRecordBytes(candidate));
    }
    const futureBytes = Math.max(currentBytes, ...candidates);
    growth = checkedCapacityAdd(growth, Math.max(0, futureBytes - currentBytes));
  }
  return growth;
}

function normalizeFutureRecordRows(values, snapshot, slot) {
  const isCheckpoint = slot === 'checkpoint';
  const records = isCheckpoint ? snapshot.ledger.deliveries : snapshot.instructions;
  const normalizer = isCheckpoint ? normalizeDeliveryRecordV2Local : normalizeInstructionRecordV2Local;
  const rowFields = isCheckpoint ? DELIVERY_CANDIDATE_ROW_FIELDS : INSTRUCTION_CANDIDATE_ROW_FIELDS;
  const maxVariants = isCheckpoint ? 3 : 4;
  const allowedVariants = isCheckpoint
    ? ['current', 'maxFutureDetail', 'reclaimed']
    : ['current', 'maxFutureDetail', 'prepared', 'reclaimed'];
  const rows = captureArray(values, MAX_DELIVERY_RECORDS);
  requireValue(rows.length === records.length);
  const actualById = new Map(records.map((record) => [record.deliveryAttemptId, record]));
  const result = new Map();

  for (const value of rows) {
    const row = captureRecord(value, rowFields);
    assertIdentifier(row.deliveryAttemptId, INVALID_CAPACITY);
    requireValue(actualById.has(row.deliveryAttemptId) && !result.has(row.deliveryAttemptId));
    const candidates = captureArray(row.candidates, maxVariants);
    const byVariant = new Map();
    for (const candidateValue of candidates) {
      const candidate = captureRecord(candidateValue, RECORD_VARIANT_FIELDS);
      requireValue(typeof candidate.variant === 'string' && allowedVariants.includes(candidate.variant));
      requireValue(!byVariant.has(candidate.variant));
      const record = normalizer(candidate.record);
      requireValue(record.deliveryAttemptId === row.deliveryAttemptId);
      if (candidate.variant === 'current') {
        requireValue(sameEmbeddedRecord(record, actualById.get(row.deliveryAttemptId)));
      } else if (candidate.variant === 'reclaimed') {
        requireValue(record.recordType === 'reclaimed');
      } else {
        requireValue(record.recordType === 'detail');
      }
      if (candidate.variant === 'prepared') {
        requireValue(record.recordType === 'detail' && record.reclamation !== null);
      }
      byVariant.set(candidate.variant, record);
    }
    requireValue(byVariant.has('current'));
    result.set(row.deliveryAttemptId, byVariant);
  }
  requireValue(result.size === actualById.size &&
    [...actualById.keys()].every((identifier) => result.has(identifier)));
  return result;
}

function measureCheckpointReservation(inputValue, operationId = FIXED_OPERATION_ID, earliestTime = 0) {
  assertUuidV4(operationId, INVALID_CAPACITY);
  assertSafeUnsignedInteger(earliestTime, INVALID_CAPACITY);
  const input = captureRecordWithOptional(inputValue,
    ['snapshot', 'currentByteLimit'], ['deliveryCandidates']);
  assertSafeUnsignedInteger(input.currentByteLimit, INVALID_CAPACITY);
  requireValue(input.currentByteLimit > 0 && input.currentByteLimit <= MAX_SOURCE_BYTES);
  const snapshot = normalizeCheckpointV3Local(input.snapshot);
  const rows = input.deliveryCandidates ?? defaultDeliveryCandidateRows(snapshot, operationId, earliestTime);
  const external = normalizeFutureRecordRows(rows, snapshot, 'checkpoint');
  const currentBytes = encodeCheckpointV3Local(snapshot).sizeBytes;
  const revisionGrowthBytes = revisionGrowthBytesForSnapshot(snapshot, 'checkpoint');
  const detailGrowthBytes = checkpointFutureGrowthBytes(snapshot, operationId, earliestTime, external);
  requireValue(external.size === snapshot.ledger.deliveries.length);
  const reservedBytes = checkedCapacitySum([currentBytes, revisionGrowthBytes, detailGrowthBytes]);
  return Object.freeze({
    currentBytes,
    revisionGrowthBytes,
    detailGrowthBytes,
    reservedBytes,
    currentByteLimit: input.currentByteLimit,
    fits: reservedBytes <= input.currentByteLimit,
  });
}

function measureInstructionReservation(inputValue, operationId = FIXED_OPERATION_ID, earliestTime = 0) {
  assertUuidV4(operationId, INVALID_CAPACITY);
  assertSafeUnsignedInteger(earliestTime, INVALID_CAPACITY);
  const input = captureRecordWithOptional(inputValue,
    ['snapshot', 'currentByteLimit'], ['instructionCandidates']);
  assertSafeUnsignedInteger(input.currentByteLimit, INVALID_CAPACITY);
  requireValue(input.currentByteLimit > 0 && input.currentByteLimit <= MAX_SOURCE_BYTES);
  const snapshot = normalizeInstructionJournalV2Local(input.snapshot);
  const rows = input.instructionCandidates ?? defaultInstructionCandidateRows(snapshot, operationId, earliestTime);
  const external = normalizeFutureRecordRows(rows, snapshot, 'instructions');
  const currentBytes = encodeInstructionJournalV2Local(snapshot).sizeBytes;
  const revisionGrowth = revisionGrowthBytesForSnapshot(snapshot, 'instructions');
  const detailGrowthBytes = instructionFutureGrowthBytes(snapshot, operationId, earliestTime, external);
  requireValue(external.size === snapshot.instructions.length);
  const reservedBytes = checkedCapacitySum([currentBytes, revisionGrowth, detailGrowthBytes]);
  return Object.freeze({
    currentBytes,
    revisionGrowthBytes: revisionGrowth,
    detailGrowthBytes,
    reservedBytes,
    currentByteLimit: input.currentByteLimit,
    fits: reservedBytes <= input.currentByteLimit,
  });
}

function revisionGrowthBytesForSnapshot(snapshot, slot) {
  const encoder = getSlotEncoder(slot);
  const normalized = slot === 'checkpoint'
    ? normalizeCheckpointV3Local(snapshot)
    : normalizeInstructionJournalV2Local(snapshot);
  const maximum = cloneNormalizedJson(normalized);
  maximum.revision = MAX_SAFE_INTEGER;
  if (slot === 'checkpoint') maximum.ledger.revision = MAX_SAFE_INTEGER;
  const growth = encoder(maximum).sizeBytes - encoder(normalized).sizeBytes;
  requireValue(growth >= 0);
  return growth;
}

function questionCandidatesForSnapshot(snapshot) {
  const normalized = normalizeQuestionJournalV2Local(snapshot);
  const detailById = new Map(normalized.questions.map((detail) => [detail.internalQuestionId, detail]));
  return normalized.reservations.map((reservation) => {
    const currentDetail = detailById.get(reservation.internalQuestionId) ?? null;
    const maxFutureDetail = currentDetail === null ? null : maxFutureQuestionDetail(currentDetail);
    const futureReservations = requiredQuestionReservationCandidates(reservation, maxFutureDetail);
    const preparedReservation = reservation.reclamation !== null
      ? reservation
      : futureReservations[1] ?? null;
    const reclaimedReservation = reservation.bodyState === 'reclaimed'
      ? reservation
      : futureReservations[futureReservations.length - 1] ?? null;
    return {
      internalQuestionId: reservation.internalQuestionId,
      currentDetail,
      maxFutureDetail,
      retainedReservation: reservation,
      preparedReservation,
      reclaimedReservation,
    };
  });
}

function measureSlotFutureReservation(slot, snapshot, candidateRows, currentByteLimit,
    operationId = FIXED_OPERATION_ID, earliestTime = 0) {
  if (slot === 'questions') {
    return measureQuestionJournalReservationBytes({
      snapshot,
      questionCandidates: candidateRows ?? questionCandidatesForSnapshot(snapshot),
      currentByteLimit,
    });
  }
  if (slot === 'checkpoint') {
    return measureCheckpointReservation({
      snapshot,
      deliveryCandidates: candidateRows ?? defaultDeliveryCandidateRows(snapshot, operationId, earliestTime),
      currentByteLimit,
    }, operationId, earliestTime);
  }
  return measureInstructionReservation({
    snapshot,
    instructionCandidates: candidateRows ?? defaultInstructionCandidateRows(snapshot, operationId, earliestTime),
    currentByteLimit,
  }, operationId, earliestTime);
}

function defaultDeliveryCandidateRows(snapshot, operationId = FIXED_OPERATION_ID, earliestTime = 0) {
  const normalized = normalizeCheckpointV3Local(snapshot);
  const usedNativeItemIds = new Set();
  for (const record of normalized.ledger.deliveries) {
    for (const correlation of [record.acceptedCorrelation, record.appliedCorrelation]) {
      if (correlation?.nativeItemId !== null && correlation?.nativeItemId !== undefined) {
        usedNativeItemIds.add(correlation.nativeItemId);
      }
    }
  }
  return normalized.ledger.deliveries.map((record, index) => {
    let maxFutureDetail = null;
    let reclaimed = null;
    for (const candidate of futureDeliveryRecordCandidates(record, index, usedNativeItemIds,
      operationId, earliestTime)) {
      if (sameEmbeddedRecord(candidate, record)) continue;
      const bytes = checkpointRecordBytes(candidate);
      if (candidate.recordType === 'reclaimed') {
        if (reclaimed === null || bytes > checkpointRecordBytes(reclaimed)) reclaimed = candidate;
      } else if (maxFutureDetail === null || bytes > checkpointRecordBytes(maxFutureDetail)) {
        maxFutureDetail = candidate;
      }
    }
    const candidates = [{ variant: 'current', record }];
    if (maxFutureDetail !== null) candidates.push({ variant: 'maxFutureDetail', record: maxFutureDetail });
    if (reclaimed !== null) candidates.push({ variant: 'reclaimed', record: reclaimed });
    return { deliveryAttemptId: record.deliveryAttemptId, candidates };
  });
}

function defaultInstructionCandidateRows(snapshot, operationId = FIXED_OPERATION_ID, earliestTime = 0) {
  const normalized = normalizeInstructionJournalV2Local(snapshot);
  return normalized.instructions.map((record) => {
    const candidates = instructionFutureRecordCandidates(record, operationId, earliestTime);
    const bestByVariant = new Map();
    for (const candidate of candidates) {
      if (sameEmbeddedRecord(candidate, record)) continue;
      const variant = candidate.recordType === 'reclaimed' ? 'reclaimed'
        : candidate.reclamation !== null ? 'prepared' : 'maxFutureDetail';
      const previous = bestByVariant.get(variant);
      if (previous === undefined || instructionRecordBytes(candidate) > instructionRecordBytes(previous)) {
        bestByVariant.set(variant, candidate);
      }
    }
    const rows = [{ variant: 'current', record }];
    for (const variant of ['maxFutureDetail', 'prepared', 'reclaimed']) {
      const candidate = bestByVariant.get(variant);
      if (candidate !== undefined) rows.push({ variant, record: candidate });
    }
    return { deliveryAttemptId: record.deliveryAttemptId, candidates: rows };
  });
}

function measureMigrationAllowance(inputValue) {
  const input = captureRecord(inputValue, SOURCE_GRANT_INPUT_FIELDS);
  requireValue(typeof input.slot === 'string' && Object.hasOwn(SOURCE_LIMITS, input.slot));
  const limits = SOURCE_LIMITS[input.slot];
  requireValue(typeof input.sourcePresent === 'boolean');
  assertSafeUnsignedInteger(input.currentByteLimit, INVALID_CAPACITY);
  requireValue(input.currentByteLimit <= MAX_SOURCE_BYTES && input.currentByteLimit > 0);
  const anchor = normalizeQuestionReclamationAnchorV1Local(input.anchor);

  if (!input.sourcePresent) {
    requireValue(input.sourceSizeBytes === 0 && input.sourceSha256 === null &&
      input.sourceRevision === null && input.sourceSchemaVersion === null);
    requireValue(normalizeRoster(input.eligibleIds).length === 0);
    return null;
  }

  assertSafeUnsignedInteger(input.sourceSchemaVersion, INVALID_CAPACITY);
  assertSafeUnsignedInteger(input.sourceRevision, INVALID_CAPACITY);
  migrationTargetRevision(true, input.sourceRevision);
  assertSafeUnsignedInteger(input.sourceSizeBytes, INVALID_CAPACITY);
  assertSha256(input.sourceSha256, INVALID_CAPACITY);
  requireValue(input.sourceSizeBytes > 0 && input.sourceSizeBytes <= MAX_SOURCE_BYTES);
  requireValue(input.sourceSizeBytes <= input.currentByteLimit, 'migration_source_exceeds_current_limit');
  const operationId = validateSourceDescriptor(anchor, input);
  const roster = normalizeRoster(input.eligibleIds);
  const projections = captureRecordWithOptional(input.projections, PROJECTION_FIELDS, PROJECTION_ROW_FIELDS);
  const withoutGrant = normalizeProjectionCandidates(projections.withoutGrant, input, operationId, roster, false);
  const withMaximumGrant = normalizeProjectionCandidates(projections.withMaximumGrant, input, operationId, roster, true);
  const rowField = input.slot === 'questions' ? 'questionCandidates'
    : input.slot === 'checkpoint' ? 'deliveryCandidates' : 'instructionCandidates';
  const candidateRows = Object.hasOwn(projections, rowField) ? projections[rowField] : null;
  const startedAt = anchor.migration.startedAt;
  const noGrantProjection = withoutGrant.get('migration');
  const maxGrantProjection = withMaximumGrant.get('migration');
  const maxWithoutGrantBytes = measureSlotFutureReservation(input.slot,
    noGrantProjection.snapshot, candidateRows, MAX_SOURCE_BYTES, operationId, startedAt).reservedBytes;
  if (maxWithoutGrantBytes <= input.currentByteLimit) return null;

  const maximumProjectionBytes = measureSlotFutureReservation(input.slot,
    maxGrantProjection.snapshot, candidateRows, MAX_SOURCE_BYTES, operationId, startedAt).reservedBytes;
  const requiredExtraBytes = Math.max(0, maximumProjectionBytes - input.sourceSizeBytes);
  requireValue(requiredExtraBytes > 0 && requiredExtraBytes <= FIXED_H_BOUNDS[input.slot],
    'migration_grant_exceeds_fixed_bound');

  const grant = {
    operationId,
    sourceSchemaVersion: input.sourceSchemaVersion,
    sourceSizeBytes: input.sourceSizeBytes,
    sourceSha256: input.sourceSha256,
    maxExtraBytes: requiredExtraBytes,
    [getRosterField(input.slot)]: roster,
  };
  return Object.freeze(grant);
}

function canClearMigrationAllowance(inputValue) {
  const input = captureRecordWithOptional(inputValue,
    ['slot', 'snapshotWithoutGrant', 'normalByteLimit'],
    ['questionCandidates', 'deliveryCandidates', 'instructionCandidates']);
  requireValue(typeof input.slot === 'string' && Object.hasOwn(SOURCE_LIMITS, input.slot));
  assertSafeUnsignedInteger(input.normalByteLimit, INVALID_CAPACITY);
  requireValue(input.normalByteLimit > 0 && input.normalByteLimit <= MAX_SOURCE_BYTES);
  const snapshot = normalizeSlotSnapshot(input.snapshotWithoutGrant, input.slot);
  requireValue(readAllowance(snapshot, input.slot) === null);
  const candidateField = input.slot === 'questions' ? 'questionCandidates'
    : input.slot === 'checkpoint' ? 'deliveryCandidates' : 'instructionCandidates';
  const candidateRows = Object.hasOwn(input, candidateField) ? input[candidateField] : null;
  const reserve = measureSlotFutureReservation(input.slot, snapshot, candidateRows,
    input.normalByteLimit);
  return Object.freeze({
    canClear: reserve.reservedBytes <= input.normalByteLimit,
    reserveBytes: reserve.reservedBytes,
    limitBytes: input.normalByteLimit,
  });
}

function computePhysicalReclamationBounds(inputValue) {
  const input = captureRecord(inputValue, ['anchorByteLimit', 'slots']);
  assertSafeUnsignedInteger(input.anchorByteLimit, INVALID_CAPACITY);
  requireValue(input.anchorByteLimit > 0 && input.anchorByteLimit <= MAX_SOURCE_BYTES);
  const slots = captureArray(input.slots, 3);
  const seen = new Set();
  const normalized = slots.map((value) => {
    const slot = captureRecord(value, ['slot', 'sourceSizeBytes', 'normalByteLimit', 'grantBytes']);
    requireValue(typeof slot.slot === 'string' && Object.hasOwn(SOURCE_LIMITS, slot.slot) &&
      !seen.has(slot.slot));
    seen.add(slot.slot);
    assertSafeUnsignedInteger(slot.sourceSizeBytes, INVALID_CAPACITY);
    assertSafeUnsignedInteger(slot.normalByteLimit, INVALID_CAPACITY);
    assertSafeUnsignedInteger(slot.grantBytes, INVALID_CAPACITY);
    requireValue(slot.sourceSizeBytes <= MAX_SOURCE_BYTES && slot.normalByteLimit > 0 &&
      slot.normalByteLimit <= MAX_SOURCE_BYTES && slot.grantBytes <= FIXED_H_BOUNDS[slot.slot]);
    return slot;
  });

  let firstMigrationPeak = checkedCapacityMultiply(2, FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes);
  let firstMigrationReservation = FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes;
  let postMigrationPeak = checkedCapacityMultiply(2, input.anchorByteLimit);
  let postMigrationReservation = input.anchorByteLimit;
  for (const slot of normalized) {
    const fixedH = FIXED_H_BOUNDS[slot.slot];
    firstMigrationPeak = checkedCapacityAdd(firstMigrationPeak,
      checkedCapacitySum([checkedCapacityMultiply(2, slot.sourceSizeBytes), fixedH]));
    firstMigrationReservation = checkedCapacityAdd(firstMigrationReservation,
      checkedCapacityAdd(slot.sourceSizeBytes, fixedH));
    const writableLimit = checkedCapacityAdd(slot.normalByteLimit, slot.grantBytes);
    postMigrationPeak = checkedCapacityAdd(postMigrationPeak, checkedCapacityMultiply(2, writableLimit));
    postMigrationReservation = checkedCapacityAdd(postMigrationReservation, writableLimit);
  }

  return Object.freeze({
    firstMigrationPeakBytes: firstMigrationPeak,
    firstMigrationReservationBytes: firstMigrationReservation,
    postMigrationPeakBytes: postMigrationPeak,
    postMigrationReservationBytes: postMigrationReservation,
  });
}

module.exports = {
  FIXED_ANCHOR_MIGRATION_BOUNDS,
  FIXED_H_BOUNDS,
  MAX_ESCAPED_IDENTIFIER,
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
  canClearMigrationAllowance,
  checkedCapacityAdd,
  checkedCapacityMultiply,
  checkedCapacitySum,
  computePhysicalReclamationBounds,
  measureNewQuestionCandidateCapacity,
  measureCheckpointReservation,
  measureInstructionReservation,
  measureQuestionJournalReservationBytes,
  measureFixedAnchorMigrationBounds,
  measureMigrationAllowance,
  measurePendingQuestionPeriodCapacity,
  migrationTargetRevision,
};
