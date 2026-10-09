'use strict';

const { createHash } = require('node:crypto');
const {
  assertIdentifier,
  assertSafeUnsignedInteger,
  assertUuidV4,
  captureDenseArray,
  captureExactRecord,
} = require('./reclamation-codec-primitives');
const { decodeSourceBytes } = require('./reclamation-json-codec');
const {
  encodeQuestionJournalV2Local,
  normalizeQuestionDetailV2,
  normalizeQuestionJournalV2Local,
  normalizeQuestionReservation,
  questionCommonKeyDigest,
  questionRecordDigest,
} = require('./common-question-reclamation-codec');
const {
  encodeCheckpointV3Local,
  encodeDeliveryLedgerV2Local,
  encodeInstructionJournalV2Local,
  normalizeCheckpointV3Local,
  normalizeDeliveryLedgerV2Local,
  normalizeDeliveryRecordV2Local,
  normalizeInstructionJournalV2Local,
  normalizeInstructionRecordV2Local,
} = require('./delivery-reclamation-codec');
const {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
} = require('./question-reclamation-anchor-codec');

const MAX_SOURCE_BYTES = 16_777_216;
const MAX_QUESTION_RECORDS = 20_000;
const MAX_DELIVERIES = 20_000;
const MAX_INSTRUCTIONS = 20_000;
const TERMINAL_RETENTION_MS = 604_800_000;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const CANDIDATE_OPERATION_ID = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
const MAX_ESCAPED_IDENTIFIER = '\uD800'.repeat(512);
const SLOT_ORDER = ['checkpoint', 'instructions', 'questions'];
const SLOT_SCHEMA = {
  checkpoint: { sourceVersion: 2, targetVersion: 3 },
  instructions: { sourceVersion: 1, targetVersion: 2 },
  questions: { sourceVersion: 1, targetVersion: 2 },
};
const QUESTION_JOURNAL_V1_FIELDS = ['schemaVersion', 'revision', 'questions'];
const QUESTION_RECORD_V1_FIELDS = [
  'internalQuestionId', 'questionId', 'identity', 'periodId', 'executionId', 'conversationId',
  'launchRef', 'executionBinding', 'category', 'contentDigest', 'questions', 'createdAt',
  'deadlineAt', 'timeoutMinutes', 'revision', 'held', 'selection', 'deliveryIntent',
  'autoApplyEnabledAtRegistration', 'externalResolution', 'lateAnswers', 'cancelledAt',
];
const QUESTION_RECORD_V1_REQUIRED_FIELDS = QUESTION_RECORD_V1_FIELDS.filter((field) =>
  field !== 'autoApplyEnabledAtRegistration');
const CHECKPOINT_V2_FIELDS = ['schemaVersion', 'revision', 'registrations', 'ledger'];
const CHECKPOINT_REGISTRATION_FIELDS = [
  'conversations', 'executions', 'launches', 'runtimeLaunches', 'connections', 'actors', 'handoffs',
  'replayClaims', 'incompleteConversationIds',
];
const LEDGER_V1_FIELDS = ['schemaVersion', 'revision', 'deliveries', 'notificationTargets', 'logicalTombstones'];
const DELIVERY_V1_FIELDS = [
  'deliveryAttemptId', 'kind', 'logicalMessageId', 'revision', 'sourceExecutionId', 'source', 'target',
  'ownerGeneration', 'payloadDigest', 'state', 'cancelRequested', 'acceptedCorrelation', 'appliedCorrelation',
];
const DELIVERY_DETAIL_V2_FIELDS = [
  'recordType', 'deliveryAttemptId', 'kind', 'logicalMessageId', 'revision', 'sourceExecutionId',
  'source', 'target', 'ownerGeneration', 'payloadDigest', 'state', 'cancelRequested',
  'acceptedCorrelation', 'appliedCorrelation', 'terminalAt',
];
const DELIVERY_GRAVE_V2_FIELDS = [
  'recordType', 'deliveryAttemptId', 'kind', 'logicalMessageId', 'revision', 'sourceExecutionId',
  'payloadDigest', 'state', 'terminalAt', 'cancelRequested', 'ownerGeneration',
  'acceptedCorrelation', 'appliedCorrelation', 'sourceRef', 'targetRef', 'reclamation',
];
const INSTRUCTION_JOURNAL_V1_FIELDS = ['schemaVersion', 'revision', 'instructions'];
const INSTRUCTION_RECORD_V1_FIELDS = [
  'deliveryAttemptId', 'launchRef', 'logicalMessageId', 'revision', 'source', 'envelope',
  'envelopeDigest', 'nativeContentDigest', 'createdAt',
];
const QUESTION_GRANT_FIELDS = [
  'operationId', 'sourceSchemaVersion', 'sourceSizeBytes', 'sourceSha256', 'maxExtraBytes', 'eligibleQuestionIds',
];
const DELIVERY_GRANT_FIELDS = [
  'operationId', 'sourceSchemaVersion', 'sourceSizeBytes', 'sourceSha256', 'maxExtraBytes', 'eligibleAttemptIds',
];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const CLAIM_FIELDS = [
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding',
];
const ACTOR_FIELDS = ['kind', 'id'];
const BINDING_FIELDS = ['periodId', 'actor'];
const INTENT_FIELDS = ['deliveryAttemptId', 'logicalMessageId', 'revision', 'payloadDigest'];
const TERMINAL_STATES = ['applied', 'cancelled_before_send', 'superseded_before_send'];
const QUESTION_STATES = [
  'available', 'claimed', 'sending', 'accepted', 'applied', 'unknown',
  'cancelled_before_send', 'superseded_before_send',
];
const INVALID_PROJECTION = 'invalid_reclamation_migration_projection';

function reject() {
  throw new TypeError(INVALID_PROJECTION);
}

function requireValue(condition) {
  if (!condition) reject();
}

function exact(value, fields) {
  return captureExactRecord(value, fields, INVALID_PROJECTION);
}

function dense(value, maxLength) {
  return captureDenseArray(value, maxLength, INVALID_PROJECTION);
}

function record(entries) {
  const result = Object.create(null);
  for (const [key, value] of entries) {
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function safeJsonValue(value) {
  if (Array.isArray(value)) {
    const result = new Array(value.length);
    Object.defineProperty(result, 'toJSON', {
      value: null,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    for (let index = 0; index < value.length; index += 1) result[index] = safeJsonValue(value[index]);
    return result;
  }
  if (value !== null && typeof value === 'object') {
    const result = Object.create(null);
    for (const key of Object.keys(value)) {
      Object.defineProperty(result, key, {
        value: safeJsonValue(value[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  return value;
}

function compactDigest(value) {
  return sha256Text(JSON.stringify(safeJsonValue(value)));
}

function checkedNextRevision(revision) {
  assertSafeUnsignedInteger(revision, INVALID_PROJECTION);
  requireValue(revision < MAX_SAFE_INTEGER);
  return revision + 1;
}

function checkedRetentionDeadline(at) {
  assertSafeUnsignedInteger(at, INVALID_PROJECTION);
  if (at > MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS) return null;
  return at + TERMINAL_RETENTION_MS;
}

function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function sameActor(left, right) {
  return left.kind === right.kind && left.id === right.id;
}

function sameBinding(left, right) {
  return left.periodId === right.periodId && sameActor(left.actor, right.actor);
}

function sameClaims(left, right) {
  return CLAIM_FIELDS.every((field) => {
    if (field === 'originBinding') {
      if (left[field] === null || right[field] === null) return left[field] === right[field];
      return sameBinding(left[field], right[field]);
    }
    return left[field] === right[field];
  });
}

function logicalDeliveryKey(kind, sourceExecutionId, logicalMessageId, revision) {
  return [kind, sourceExecutionId, logicalMessageId, String(revision)]
    .map((part) => `${part.length}:${part}`)
    .join('');
}

function createLedgerLookup(checkpoint) {
  const byAttemptId = new Map();
  const byLogicalKey = new Map();
  for (const delivery of checkpoint?.ledger.deliveries ?? []) {
    if (!byAttemptId.has(delivery.deliveryAttemptId)) byAttemptId.set(delivery.deliveryAttemptId, delivery);
    const key = logicalDeliveryKey(delivery.kind, delivery.sourceExecutionId,
      delivery.logicalMessageId, delivery.revision);
    if (!byLogicalKey.has(key)) byLogicalKey.set(key, delivery);
  }
  return { byAttemptId, byLogicalKey };
}

function correlationForDelivery(delivery, nativeTurnId, nativeItemId) {
  return record([
    ['deliveryAttemptId', delivery.deliveryAttemptId],
    ['revision', delivery.revision],
    ['payloadDigest', delivery.payloadDigest],
    ['targetPeriodId', delivery.target.periodId],
    ['nativeTurnId', nativeTurnId],
    ['nativeItemId', nativeItemId],
    ['clientRequestId', delivery.deliveryAttemptId],
  ]);
}

function normalizedDeliveryDetail(delivery, overrides = {}) {
  return normalizeDeliveryRecordV2Local(record(DELIVERY_DETAIL_V2_FIELDS.map((field) => [
    field,
    Object.hasOwn(overrides, field) ? overrides[field] : delivery[field],
  ])));
}

function maxFutureDeliveryDetail(delivery, terminalAt = MAX_SAFE_INTEGER) {
  if (TERMINAL_STATES.includes(delivery.state)) {
    if (delivery.state !== 'applied') return delivery;
    const applied = delivery.appliedCorrelation;
    const existing = delivery.acceptedCorrelation;
    const accepted = correlationForDelivery(delivery,
      existing?.nativeTurnId ?? applied.nativeTurnId,
      existing?.nativeItemId ?? applied.nativeItemId);
    if (existing?.nativeTurnId === accepted.nativeTurnId &&
        existing?.nativeItemId === accepted.nativeItemId) return delivery;
    return normalizedDeliveryDetail(delivery, { acceptedCorrelation: accepted });
  }

  const existing = delivery.acceptedCorrelation;
  const nativeTurnId = existing?.nativeTurnId ?? MAX_ESCAPED_IDENTIFIER;
  const nativeItemId = existing?.nativeItemId ?? MAX_ESCAPED_IDENTIFIER;
  const accepted = existing === null
    ? correlationForDelivery(delivery, nativeTurnId, nativeItemId)
    : correlationForDelivery(delivery,
      existing.nativeTurnId ?? nativeTurnId,
      existing.nativeItemId ?? nativeItemId);
  const applied = correlationForDelivery(delivery, nativeTurnId, nativeItemId);
  return normalizedDeliveryDetail(delivery, {
    state: 'applied',
    cancelRequested: delivery.cancelRequested,
    acceptedCorrelation: accepted,
    appliedCorrelation: applied,
    terminalAt,
  });
}

function deliveryReferenceForGrave(delivery, side) {
  const ref = delivery[side];
  if (side === 'source') {
    return record([
      ['launchRef', ref.launchRef],
      ['launchKey', [ref.claims.launchId, ref.claims.runId, ref.claims.attemptId]],
      ['sourceClaimsDigest', compactDigest(ref.claims)],
      ['identity', ref.identity],
      ['executionBinding', ref.executionBinding],
      ['conversationId', ref.conversationId],
      ['sessionId', ref.sessionId],
    ]);
  }
  return record([
    ['kind', ref.kind],
    ['launchRef', ref.kind === 'execution' ? ref.launchRef : null],
    ['launchKey', ref.kind === 'execution'
      ? [ref.claims.launchId, ref.claims.runId, ref.claims.attemptId] : null],
    ['targetClaimsDigest', ref.kind === 'execution' ? compactDigest(ref.claims) : null],
    ['identity', ref.identity],
    ['periodId', ref.periodId],
    ['actor', ref.actor],
    ['conversationId', ref.conversationId],
    ['sessionId', ref.sessionId],
  ]);
}

function deliveryGraveFromDetail(detail, reason) {
  if (TERMINAL_STATES.includes(detail.state) && checkedRetentionDeadline(detail.terminalAt) === null) return null;
  return normalizeDeliveryRecordV2Local(record([
    ['recordType', 'reclaimed'],
    ['deliveryAttemptId', detail.deliveryAttemptId],
    ['kind', detail.kind],
    ['logicalMessageId', detail.logicalMessageId],
    ['revision', detail.revision],
    ['sourceExecutionId', detail.sourceExecutionId],
    ['payloadDigest', detail.payloadDigest],
    ['state', detail.state],
    ['terminalAt', detail.terminalAt],
    ['cancelRequested', detail.cancelRequested],
    ['ownerGeneration', detail.ownerGeneration],
    ['acceptedCorrelation', detail.acceptedCorrelation],
    ['appliedCorrelation', detail.appliedCorrelation],
    ['sourceRef', deliveryReferenceForGrave(detail, 'source')],
    ['targetRef', deliveryReferenceForGrave(detail, 'target')],
    ['reclamation', record([
      ['operationId', CANDIDATE_OPERATION_ID],
      ['reclaimedAt', MAX_SAFE_INTEGER],
      ['reason', reason],
    ])],
  ]));
}

function sameExecutionProjection(delivery, launchRef, identity, binding, conversationId) {
  const source = delivery.source;
  const target = delivery.target;
  return source.launchRef === launchRef && sameIdentity(source.identity, identity) &&
    sameBinding(source.executionBinding, binding) && source.conversationId === conversationId &&
    target.kind === 'execution' && target.launchRef === launchRef &&
    sameClaims(target.claims, source.claims) && sameIdentity(target.identity, identity) &&
    target.periodId === binding.periodId && sameActor(target.actor, binding.actor) &&
    target.conversationId === conversationId && target.sessionId === source.sessionId;
}

function commonKeyString(identity, periodId, questionId) {
  return [...IDENTITY_FIELDS.map((field) => identity[field]), periodId, questionId]
    .map((part) => `${part.length}:${part}`)
    .join('');
}

function periodKeyString(identity, periodId) {
  return [...IDENTITY_FIELDS.map((field) => identity[field]), periodId]
    .map((part) => `${part.length}:${part}`)
    .join('');
}

function captureQuestionRecordV1(value) {
  let keys;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) reject();
    const prototype = Object.getPrototypeOf(value);
    requireValue(prototype === Object.prototype || prototype === null);
    keys = Reflect.ownKeys(value);
  } catch {
    reject();
  }
  const allowed = new Set(QUESTION_RECORD_V1_FIELDS);
  requireValue(keys.every((key) => typeof key === 'string' && allowed.has(key)));
  requireValue(QUESTION_RECORD_V1_REQUIRED_FIELDS.every((field) => keys.includes(field)));
  requireValue(keys.length === QUESTION_RECORD_V1_FIELDS.length ||
    keys.length === QUESTION_RECORD_V1_FIELDS.length - 1);
  const captured = new Map();
  for (const key of keys) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      reject();
    }
    requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'));
    captured.set(key, descriptor.value);
  }
  return record(QUESTION_RECORD_V1_FIELDS.map((field) => [
    field,
    field === 'autoApplyEnabledAtRegistration' && !captured.has(field)
      ? false
      : captured.get(field),
  ]));
}

function normalizeLegacyQuestionRecord(value) {
  const source = captureQuestionRecordV1(value);
  const autoApplyIndex = QUESTION_RECORD_V1_FIELDS.indexOf('autoApplyEnabledAtRegistration');
  const candidate = normalizeQuestionDetailV2(record([
    ...QUESTION_RECORD_V1_FIELDS.slice(0, autoApplyIndex).map((field) => [field, source[field]]),
    ['deliveryCreationState', source.deliveryIntent === null ? 'not_created' : 'indeterminate'],
    ['autoApplyEnabledAtRegistration', source.autoApplyEnabledAtRegistration],
    ['quarantinedAt', null],
    ...QUESTION_RECORD_V1_FIELDS.slice(autoApplyIndex + 1).map((field) => [field, source[field]]),
  ]));
  return record(QUESTION_RECORD_V1_FIELDS.map((field) => [field, candidate[field]]));
}

function normalizeQuestionSource(value) {
  const journal = exact(value, QUESTION_JOURNAL_V1_FIELDS);
  requireValue(journal.schemaVersion === 1);
  assertSafeUnsignedInteger(journal.revision, INVALID_PROJECTION);
  const questions = dense(journal.questions, MAX_QUESTION_RECORDS).map(normalizeLegacyQuestionRecord);
  const ids = new Set();
  const keys = new Set();
  for (const question of questions) {
    assertIdentifier(question.internalQuestionId, INVALID_PROJECTION);
    const key = commonKeyString(question.identity, question.periodId, question.questionId);
    requireValue(!ids.has(question.internalQuestionId) && !keys.has(key));
    ids.add(question.internalQuestionId);
    keys.add(key);
  }
  return { revision: journal.revision, questions };
}

function normalizeLegacyDelivery(value, startedAt) {
  const delivery = exact(value, DELIVERY_V1_FIELDS);
  requireValue(QUESTION_STATES.includes(delivery.state));
  const terminal = TERMINAL_STATES.includes(delivery.state);
  const original = normalizeDeliveryRecordV2Local(record([
    ['recordType', 'detail'],
    ['deliveryAttemptId', delivery.deliveryAttemptId],
    ['kind', delivery.kind],
    ['logicalMessageId', delivery.logicalMessageId],
    ['revision', delivery.revision],
    ['sourceExecutionId', delivery.sourceExecutionId],
    ['source', delivery.source],
    ['target', delivery.target],
    ['ownerGeneration', delivery.ownerGeneration],
    ['payloadDigest', delivery.payloadDigest],
    ['state', delivery.state],
    ['cancelRequested', delivery.cancelRequested],
    ['acceptedCorrelation', delivery.acceptedCorrelation],
    ['appliedCorrelation', delivery.appliedCorrelation],
    ['terminalAt', terminal ? startedAt : null],
  ]));
  const migratedState = delivery.state === 'claimed'
    ? 'available'
    : delivery.state === 'sending' || delivery.state === 'accepted'
      ? 'unknown'
      : delivery.state;
  return normalizeDeliveryRecordV2Local(record([
    ['recordType', 'detail'],
    ['deliveryAttemptId', original.deliveryAttemptId],
    ['kind', original.kind],
    ['logicalMessageId', original.logicalMessageId],
    ['revision', original.revision],
    ['sourceExecutionId', original.sourceExecutionId],
    ['source', original.source],
    ['target', original.target],
    ['ownerGeneration', original.ownerGeneration],
    ['payloadDigest', original.payloadDigest],
    ['state', migratedState],
    ['cancelRequested', original.cancelRequested],
    ['acceptedCorrelation', original.acceptedCorrelation],
    ['appliedCorrelation', original.appliedCorrelation],
    ['terminalAt', terminal ? startedAt : null],
  ]));
}

function normalizeCheckpointSource(value, storeId, startedAt, migrationAllowance) {
  const checkpoint = exact(value, CHECKPOINT_V2_FIELDS);
  requireValue(checkpoint.schemaVersion === 2);
  assertSafeUnsignedInteger(checkpoint.revision, INVALID_PROJECTION);
  const registrations = exact(checkpoint.registrations, CHECKPOINT_REGISTRATION_FIELDS);
  const ledger = exact(checkpoint.ledger, LEDGER_V1_FIELDS);
  requireValue(ledger.schemaVersion === 1);
  assertSafeUnsignedInteger(ledger.revision, INVALID_PROJECTION);
  const sourceDeliveries = dense(ledger.deliveries, MAX_DELIVERIES);
  const deliveryIds = new Set();
  const deliveries = sourceDeliveries.map((item) => {
    const normalized = normalizeLegacyDelivery(item, startedAt);
    requireValue(!deliveryIds.has(normalized.deliveryAttemptId));
    deliveryIds.add(normalized.deliveryAttemptId);
    return normalized;
  });
  const migratedLedger = normalizeDeliveryLedgerV2Local(record([
    ['schemaVersion', 2],
    ['revision', checkedNextRevision(ledger.revision)],
    ['deliveries', deliveries],
    ['notificationTargets', ledger.notificationTargets],
    ['logicalTombstones', ledger.logicalTombstones],
  ]));
  const target = normalizeCheckpointV3Local(record([
    ['schemaVersion', 3],
    ['storeId', storeId],
    ['revision', checkedNextRevision(checkpoint.revision)],
    ['registrations', registrations],
    ['ledger', migratedLedger],
    ['migrationAllowance', migrationAllowance],
  ]));
  return {
    sourceRevision: checkpoint.revision,
    sourceLedgerRevision: ledger.revision,
    eligibleIds: sourceDeliveries.map((item) => {
      const delivery = exact(item, DELIVERY_V1_FIELDS);
      assertIdentifier(delivery.deliveryAttemptId, INVALID_PROJECTION);
      return delivery.deliveryAttemptId;
    }),
    target,
  };
}

function normalizeInstructionSource(value) {
  const journal = exact(value, INSTRUCTION_JOURNAL_V1_FIELDS);
  requireValue(journal.schemaVersion === 1);
  assertSafeUnsignedInteger(journal.revision, INVALID_PROJECTION);
  const instructions = dense(journal.instructions, MAX_INSTRUCTIONS).map((item) => {
    const source = exact(item, INSTRUCTION_RECORD_V1_FIELDS);
    const normalized = normalizeInstructionRecordV2Local(record([
      ['recordType', 'detail'],
      ...INSTRUCTION_RECORD_V1_FIELDS.map((field) => [field, source[field]]),
      ['deliveryCreationState', 'indeterminate'],
      ['reclamation', null],
    ]));
    return record(INSTRUCTION_RECORD_V1_FIELDS.map((field) => [field, normalized[field]]));
  });
  const ids = new Set();
  for (const instruction of instructions) {
    assertIdentifier(instruction.deliveryAttemptId, INVALID_PROJECTION);
    requireValue(!ids.has(instruction.deliveryAttemptId));
    ids.add(instruction.deliveryAttemptId);
  }
  return { revision: journal.revision, instructions };
}

function normalizeGrantForSource(value, slot, source, eligibleIds, operationId) {
  if (source === null) {
    requireValue(value === null);
    return null;
  }
  if (value === null) return null;
  const fields = slot === 'questions' ? QUESTION_GRANT_FIELDS : DELIVERY_GRANT_FIELDS;
  const grant = exact(value, fields);
  const idsField = slot === 'questions' ? 'eligibleQuestionIds' : 'eligibleAttemptIds';
  const expectedVersion = SLOT_SCHEMA[slot].sourceVersion;
  requireValue(grant.operationId === operationId && grant.sourceSchemaVersion === expectedVersion &&
    grant.sourceSizeBytes === source.sizeBytes && grant.sourceSha256 === source.sha256 &&
    Number.isSafeInteger(grant.maxExtraBytes) && grant.maxExtraBytes > 0);
  const grantIds = dense(grant[idsField], MAX_QUESTION_RECORDS);
  requireValue(grantIds.length === eligibleIds.length && grantIds.every((id, index) => id === eligibleIds[index]));
  return grant;
}

function expectedDeliveryForQuestion(question, intent, lookup) {
  const exactAttempt = lookup.byAttemptId.get(intent.deliveryAttemptId);
  const related = lookup.byLogicalKey.get(logicalDeliveryKey('question', question.periodId,
    intent.logicalMessageId, intent.revision));
  const found = exactAttempt || related;
  if (!found) return null;
  requireValue(found.deliveryAttemptId === intent.deliveryAttemptId && found.kind === 'question' &&
    found.logicalMessageId === intent.logicalMessageId && found.revision === intent.revision &&
    found.payloadDigest === intent.payloadDigest && found.sourceExecutionId === question.periodId &&
    sameExecutionProjection(found, question.launchRef, question.identity, question.executionBinding,
      question.conversationId));
  return found;
}

function expectedDeliveryForInstruction(instruction, lookup) {
  const exactAttempt = lookup.byAttemptId.get(instruction.deliveryAttemptId);
  const source = instruction.source;
  const related = lookup.byLogicalKey.get(logicalDeliveryKey('instruction', source.executionBinding.periodId,
    instruction.logicalMessageId, instruction.revision));
  const found = exactAttempt || related;
  if (!found) return null;
  requireValue(found.deliveryAttemptId === instruction.deliveryAttemptId && found.kind === 'instruction' &&
    found.logicalMessageId === instruction.logicalMessageId && found.revision === instruction.revision &&
    found.payloadDigest === instruction.envelopeDigest &&
    sameExecutionProjection(found, source.launchRef, source.identity, source.executionBinding,
      source.conversationId) && sameIdentity(found.source.identity, source.identity) &&
    sameBinding(found.source.executionBinding, source.executionBinding) &&
    found.source.sessionId === source.sessionId && sameClaims(found.source.claims, source.claims));
  return found;
}

function questionDeliveryState(question, checkpoint, ledgerLookup) {
  const intent = question.deliveryIntent;
  if (intent === null) {
    return { presence: 'none', creationState: 'not_created', checkpointState: null,
      sourceClaimsDigest: null, sessionId: null, delivery: null };
  }
  const delivery = checkpoint === null ? null : expectedDeliveryForQuestion(question, intent, ledgerLookup);
  if (delivery === null) {
    return { presence: 'indeterminate', creationState: 'indeterminate', checkpointState: 'unknown',
      sourceClaimsDigest: null, sessionId: null, delivery: null };
  }
  return { presence: 'checkpoint', creationState: 'checkpointed', checkpointState: delivery.state,
    sourceClaimsDigest: compactDigest(delivery.source.claims), sessionId: delivery.source.sessionId, delivery };
}

function normalizeQuestionMigration(questionSource, checkpoint, storeId, startedAt, migrationAllowance) {
  const sourceQuestions = questionSource?.questions ?? [];
  const ledgerLookup = createLedgerLookup(checkpoint);
  const revision = questionSource === null ? 0 : checkedNextRevision(questionSource.revision);
  const details = [];
  const reservations = [];
  const periods = [];
  const periodIndexByKey = new Map();
  const targets = [];
  const periodKeys = new Set();
  for (const rawQuestion of sourceQuestions) {
    const delivery = questionDeliveryState(rawQuestion, checkpoint, ledgerLookup);
    const detail = normalizeQuestionDetailV2(record([
      ...QUESTION_RECORD_V1_FIELDS.slice(0, QUESTION_RECORD_V1_FIELDS.indexOf('autoApplyEnabledAtRegistration'))
        .map((field) => [field, rawQuestion[field]]),
      ['deliveryCreationState', delivery.creationState],
      ['autoApplyEnabledAtRegistration', rawQuestion.autoApplyEnabledAtRegistration],
      ['quarantinedAt', startedAt],
      ...QUESTION_RECORD_V1_FIELDS.slice(QUESTION_RECORD_V1_FIELDS.indexOf('autoApplyEnabledAtRegistration') + 1)
        .map((field) => [field, rawQuestion[field]]),
    ]));
    const reservation = normalizeQuestionReservation(record([
      ['internalQuestionId', detail.internalQuestionId],
      ['identity', detail.identity],
      ['periodId', detail.periodId],
      ['questionId', detail.questionId],
      ['contentDigest', detail.contentDigest],
      ['executionId', detail.executionId],
      ['conversationId', detail.conversationId],
      ['launchRef', detail.launchRef],
      ['executionBinding', detail.executionBinding],
      ['createdAt', detail.createdAt],
      ['revision', detail.revision],
      ['selectionSource', detail.selection === null ? null : detail.selection.source],
      ['selectedAt', detail.selection === null ? null : detail.selection.selectedAt],
      ['deliveryIntent', detail.deliveryIntent],
      ['deliveryCreationState', detail.deliveryCreationState],
      ['checkpointState', delivery.checkpointState],
      ['sourceClaimsDigest', delivery.sourceClaimsDigest],
      ['sessionId', delivery.sessionId],
      ['externalResolution', detail.externalResolution],
      ['cancelledAt', detail.cancelledAt],
      ['terminalResultKind', TERMINAL_STATES.includes(delivery.checkpointState)
        ? delivery.checkpointState : null],
      ['quarantinedAt', startedAt],
      ['bodyState', 'retained'],
      ['reclaimedAt', null],
      ['reclamation', null],
    ]));
    details.push(detail);
    reservations.push(reservation);
    const key = commonKeyString(detail.identity, detail.periodId, detail.questionId);
    const periodKey = periodKeyString(detail.identity, detail.periodId);
    let periodIndex = periodIndexByKey.get(periodKey);
    if (periodIndex === undefined) {
      periodIndex = periods.length;
      periodIndexByKey.set(periodKey, periodIndex);
      periods.push(record([
        ['identity', detail.identity], ['periodId', detail.periodId], ['retiredAt', startedAt],
        ['reason', 'startup-quarantine'],
      ]));
    }
    requireValue(!periodKeys.has(key));
    periodKeys.add(key);
    targets.push(record([
      ['internalQuestionId', detail.internalQuestionId],
      ['commonKeyDigest', questionCommonKeyDigest(detail.identity, detail.periodId, detail.questionId)],
      ['periodIndex', periodIndex],
      ['recordDigest', questionRecordDigest(detail)],
      ['deliveryPresence', delivery.presence],
      ['deliveryIntent', detail.deliveryIntent],
      ['checkpointState', delivery.checkpointState],
    ]));
  }
  const journal = normalizeQuestionJournalV2Local(record([
    ['schemaVersion', 2], ['storeId', storeId], ['revision', revision],
    ['questions', details], ['reservations', reservations], ['migrationAllowance', migrationAllowance],
  ]));
  return { journal, periods, targets };
}

function makeQuestionReservationVariant(reservation, preparedAt, reclaimed) {
  const presence = reservation.deliveryCreationState === 'not_created'
    ? 'none'
    : reservation.deliveryCreationState === 'checkpointed' ? 'checkpoint' : 'indeterminate';
  const checkpointState = presence === 'none' ? null : reservation.checkpointState;
  const reclamation = record([
    ['operationId', CANDIDATE_OPERATION_ID],
    ['preparedAt', preparedAt],
    ['deliveryPresence', presence],
    ['checkpointState', checkpointState],
  ]);
  const candidate = record([
    ...Object.entries(reservation).filter(([field]) =>
      field !== 'bodyState' && field !== 'reclaimedAt' && field !== 'reclamation'),
    ['bodyState', reclaimed ? 'reclaimed' : 'retained'],
    ['reclaimedAt', reclaimed ? MAX_SAFE_INTEGER : null],
    ['reclamation', reclamation],
  ]);
  return normalizeQuestionReservation(candidate);
}

function questionCandidateVariants(detail, reservation, checkpoint, ledgerLookup) {
  const quarantineDeadline = checkedRetentionDeadline(detail.quarantinedAt);
  let deliveryDeadline = quarantineDeadline;
  const delivery = checkpoint && reservation.deliveryIntent
    ? ledgerLookup.byAttemptId.get(reservation.deliveryIntent.deliveryAttemptId)
    : null;
  if (delivery && TERMINAL_STATES.includes(delivery.state)) {
    const terminalDeadline = checkedRetentionDeadline(delivery.terminalAt);
    deliveryDeadline = quarantineDeadline === null || terminalDeadline === null
      ? null
      : Math.max(quarantineDeadline, terminalDeadline);
  }
  const preparedAt = deliveryDeadline === null ? null : MAX_SAFE_INTEGER;
  const retainedReservation = reservation;
  if (preparedAt === null) {
    return {
      internalQuestionId: detail.internalQuestionId,
      currentDetail: detail,
      maxFutureDetail: detail,
      retainedReservation,
      preparedReservation: null,
      reclaimedReservation: null,
    };
  }
  const preparedReservation = makeQuestionReservationVariant(reservation, preparedAt, false);
  const reclaimedReservation = makeQuestionReservationVariant(reservation, preparedAt, true);
  return {
    internalQuestionId: detail.internalQuestionId,
    currentDetail: detail,
    maxFutureDetail: detail,
    retainedReservation,
    preparedReservation,
    reclaimedReservation,
  };
}

function buildQuestionCandidates(projected, checkpoint) {
  const ledgerLookup = createLedgerLookup(checkpoint);
  const variants = projected.journal.questions.map((detail, index) =>
    questionCandidateVariants(detail, projected.journal.reservations[index], checkpoint, ledgerLookup));
  const encoded = encodeQuestionJournalV2Local(projected.journal);
  const sameSnapshot = () => ({ snapshot: projected.journal, encoded });
  const candidates = {
    migration: sameSnapshot(),
    retained: sameSnapshot(),
    prepared: sameSnapshot(),
    reclaimed: sameSnapshot(),
  };
  return { candidates, questionCandidates: projected.journal.questions.map((detail, index) => variants[index]) };
}

function normalizeInstructionMigration(instructionSource, checkpoint, storeId, migrationAllowance) {
  const sourceInstructions = instructionSource?.instructions ?? [];
  const ledgerLookup = createLedgerLookup(checkpoint);
  const revision = instructionSource === null ? 0 : checkedNextRevision(instructionSource.revision);
  const instructions = sourceInstructions.map((sourceRecord) => {
    const matched = checkpoint === null ? null : expectedDeliveryForInstruction(sourceRecord, ledgerLookup);
    const creationState = matched === null ? 'indeterminate' : 'checkpointed';
    return normalizeInstructionRecordV2Local(record([
      ['recordType', 'detail'],
      ['deliveryAttemptId', sourceRecord.deliveryAttemptId],
      ['launchRef', sourceRecord.launchRef],
      ['logicalMessageId', sourceRecord.logicalMessageId],
      ['revision', sourceRecord.revision],
      ['source', sourceRecord.source],
      ['envelope', sourceRecord.envelope],
      ['envelopeDigest', sourceRecord.envelopeDigest],
      ['nativeContentDigest', sourceRecord.nativeContentDigest],
      ['createdAt', sourceRecord.createdAt],
      ['deliveryCreationState', creationState],
      ['reclamation', null],
    ]));
  });
  return normalizeInstructionJournalV2Local(record([
    ['schemaVersion', 2], ['revision', revision], ['storeId', storeId],
    ['migrationAllowance', migrationAllowance], ['instructions', instructions],
  ]));
}

function encodedTarget(snapshot, encoder) {
  const encoded = encoder(snapshot);
  return { snapshot, encoded, sizeBytes: encoded.sizeBytes, sha256: encoded.sha256 };
}

function emptyCheckpointSnapshot(storeId) {
  const ledger = normalizeDeliveryLedgerV2Local(record([
    ['schemaVersion', 2], ['revision', 0], ['deliveries', []],
    ['notificationTargets', []], ['logicalTombstones', []],
  ]));
  return normalizeCheckpointV3Local(record([
    ['schemaVersion', 3], ['storeId', storeId], ['revision', 0],
    ['registrations', record(CHECKPOINT_REGISTRATION_FIELDS.map((field) => [field, []]))],
    ['ledger', ledger], ['migrationAllowance', null],
  ]));
}

function checkpointRecordCandidates(delivery, questionByAttemptId, startedAt) {
  const maxFutureDetail = delivery.kind === 'question'
    ? delivery : maxFutureDeliveryDetail(delivery);
  let reclaimed = null;
  if (delivery.kind === 'question') {
    const question = questionByAttemptId.get(delivery.deliveryAttemptId);
    if (question !== undefined && question.preparedReservation !== null && question.reclaimedReservation !== null) {
      reclaimed = deliveryGraveFromDetail(delivery, 'retired_question_period');
    }
  } else {
    let reclaimableDetail = maxFutureDetail;
    if (!TERMINAL_STATES.includes(delivery.state)) {
      const terminalAt = MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS;
      if (startedAt <= terminalAt) reclaimableDetail = maxFutureDeliveryDetail(delivery, terminalAt);
      else reclaimableDetail = null;
    }
    if (reclaimableDetail !== null) reclaimed = deliveryGraveFromDetail(reclaimableDetail, 'terminal_retention');
  }
  const candidates = [
    { variant: 'current', record: delivery },
    { variant: 'maxFutureDetail', record: maxFutureDetail },
  ];
  if (reclaimed !== null) candidates.push({ variant: 'reclaimed', record: reclaimed });
  return { deliveryAttemptId: delivery.deliveryAttemptId, candidates };
}

function buildCheckpointCandidates(target, questionCandidates = [], startedAt = 0) {
  const questionByAttemptId = new Map();
  for (const question of questionCandidates) {
    const attemptId = question.retainedReservation.deliveryIntent?.deliveryAttemptId;
    if (attemptId !== undefined) questionByAttemptId.set(attemptId, question);
  }
  const deliveryCandidates = target.ledger.deliveries.map((delivery) =>
    checkpointRecordCandidates(delivery, questionByAttemptId, startedAt));
  const encoded = encodeCheckpointV3Local(target);
  const sameSnapshot = () => ({ snapshot: target, encoded });
  return {
    deliveryCandidates,
    candidates: {
      migration: sameSnapshot(),
      retained: sameSnapshot(),
      prepared: sameSnapshot(),
      reclaimed: sameSnapshot(),
    },
  };
}

function emptyQuestionProjection(storeId) {
  const journal = normalizeQuestionJournalV2Local(record([
    ['schemaVersion', 2], ['storeId', storeId], ['revision', 0],
    ['questions', []], ['reservations', []], ['migrationAllowance', null],
  ]));
  return { journal, periods: [], targets: [] };
}

function emptyInstructionSnapshot(storeId) {
  return normalizeInstructionJournalV2Local(record([
    ['schemaVersion', 2], ['revision', 0], ['storeId', storeId],
    ['migrationAllowance', null], ['instructions', []],
  ]));
}

function parseLegacySource(sourceBytes) {
  return decodeSourceBytes(sourceBytes, MAX_SOURCE_BYTES);
}

function localCheckpointGrant(decoded, operationId, migrationAllowance) {
  const outer = exact(decoded.value, CHECKPOINT_V2_FIELDS);
  const ledger = exact(outer.ledger, LEDGER_V1_FIELDS);
  const eligibleIds = dense(ledger.deliveries, MAX_DELIVERIES).map((item) =>
    exact(item, DELIVERY_V1_FIELDS).deliveryAttemptId);
  const source = { sizeBytes: decoded.sizeBytes, sha256: decoded.sha256 };
  return {
    outer,
    eligibleIds,
    grant: normalizeGrantForSource(migrationAllowance, 'checkpoint', source, eligibleIds, operationId),
  };
}

function localInstructionGrant(decoded, operationId, migrationAllowance) {
  const legacy = normalizeInstructionSource(decoded.value);
  return {
    legacy,
    grant: normalizeGrantForSource(migrationAllowance, 'instructions',
      { sizeBytes: decoded.sizeBytes, sha256: decoded.sha256 },
      legacy.instructions.map((item) => item.deliveryAttemptId), operationId),
  };
}

function localQuestionGrant(decoded, operationId, migrationAllowance) {
  const legacy = normalizeQuestionSource(decoded.value);
  return {
    legacy,
    grant: normalizeGrantForSource(migrationAllowance, 'questions',
      { sizeBytes: decoded.sizeBytes, sha256: decoded.sha256 },
      legacy.questions.map((item) => item.internalQuestionId), operationId),
  };
}

/** 旧checkpoint v2 sourceを検証し、v3の局所migration targetを生成する。 */
function projectLegacyCheckpointV2Local(value) {
  const options = exact(value, ['sourceBytes', 'storeId', 'operationId', 'startedAt', 'migrationAllowance']);
  assertUuidV4(options.storeId, INVALID_PROJECTION);
  assertUuidV4(options.operationId, INVALID_PROJECTION);
  assertSafeUnsignedInteger(options.startedAt, INVALID_PROJECTION);
  const raw = parseLegacySource(options.sourceBytes);
  const parsed = localCheckpointGrant(raw, options.operationId, options.migrationAllowance);
  const projection = normalizeCheckpointSource(parsed.outer, options.storeId, options.startedAt, parsed.grant);
  const target = encodedTarget(projection.target, encodeCheckpointV3Local);
  const candidates = buildCheckpointCandidates(target.snapshot, [], options.startedAt);
  return {
    source: {
      present: true, schemaVersion: 2, revision: projection.sourceRevision,
      sizeBytes: raw.sizeBytes, sha256: raw.sha256,
    },
    ...target,
    eligibleIds: projection.eligibleIds,
    candidateSnapshotsByBoundary: candidates.candidates,
    deliveryCandidates: candidates.deliveryCandidates,
  };
}

/** 旧instruction journal v1 sourceをcheckpoint v3と照合してv2へ投影する。 */
function projectLegacyInstructionJournalV1Local(value) {
  const options = exact(value, [
    'sourceBytes', 'storeId', 'operationId', 'startedAt', 'checkpointSnapshot', 'migrationAllowance',
  ]);
  assertUuidV4(options.storeId, INVALID_PROJECTION);
  assertUuidV4(options.operationId, INVALID_PROJECTION);
  assertSafeUnsignedInteger(options.startedAt, INVALID_PROJECTION);
  const raw = parseLegacySource(options.sourceBytes);
  const parsed = localInstructionGrant(raw, options.operationId, options.migrationAllowance);
  const checkpoint = options.checkpointSnapshot === null
    ? null
    : normalizeCheckpointV3Local(options.checkpointSnapshot);
  const snapshot = normalizeInstructionMigration(parsed.legacy, checkpoint, options.storeId, parsed.grant);
  const target = encodedTarget(snapshot, encodeInstructionJournalV2Local);
  const built = buildInstructionCandidates(snapshot, checkpoint, options.startedAt);
  return {
    source: {
      present: true, schemaVersion: 1, revision: parsed.legacy.revision,
      sizeBytes: raw.sizeBytes, sha256: raw.sha256,
    },
    ...target,
    eligibleIds: parsed.legacy.instructions.map((item) => item.deliveryAttemptId),
    candidateSnapshotsByBoundary: built.candidates,
    instructionCandidates: built.instructionCandidates,
  };
}

/** 旧question journal v1 sourceをcheckpoint v3と照合してv2へ投影する。 */
function projectLegacyQuestionJournalV1Local(value) {
  const options = exact(value, [
    'sourceBytes', 'storeId', 'operationId', 'startedAt', 'checkpointSnapshot', 'migrationAllowance',
  ]);
  assertUuidV4(options.storeId, INVALID_PROJECTION);
  assertUuidV4(options.operationId, INVALID_PROJECTION);
  assertSafeUnsignedInteger(options.startedAt, INVALID_PROJECTION);
  const raw = parseLegacySource(options.sourceBytes);
  const parsed = localQuestionGrant(raw, options.operationId, options.migrationAllowance);
  const checkpoint = options.checkpointSnapshot === null
    ? null
    : normalizeCheckpointV3Local(options.checkpointSnapshot);
  const projection = normalizeQuestionMigration(parsed.legacy, checkpoint, options.storeId,
    options.startedAt, parsed.grant);
  const target = encodedTarget(projection.journal, encodeQuestionJournalV2Local);
  const built = buildQuestionCandidates(projection, checkpoint);
  return {
    source: {
      present: true, schemaVersion: 1, revision: parsed.legacy.revision,
      sizeBytes: raw.sizeBytes, sha256: raw.sha256,
    },
    ...target,
    eligibleIds: parsed.legacy.questions.map((item) => item.internalQuestionId),
    retiredQuestionPeriods: projection.periods,
    targets: projection.targets,
    questionCandidates: built.questionCandidates,
    candidateSnapshotsByBoundary: built.candidates,
  };
}

/** 未作成checkpoint slot用のschema v3 snapshotを生成する。 */
function createEmptyCheckpointV3TargetLocal(value) {
  const options = exact(value, ['storeId']);
  assertUuidV4(options.storeId, INVALID_PROJECTION);
  return encodedTarget(emptyCheckpointSnapshot(options.storeId), encodeCheckpointV3Local);
}

/** 未作成instruction slot用のschema v2 snapshotを生成する。 */
function createEmptyInstructionJournalV2TargetLocal(value) {
  const options = exact(value, ['storeId']);
  assertUuidV4(options.storeId, INVALID_PROJECTION);
  return encodedTarget(emptyInstructionSnapshot(options.storeId), encodeInstructionJournalV2Local);
}

/** 未作成question slot用のschema v2 snapshotを生成する。 */
function createEmptyQuestionJournalV2TargetLocal(value) {
  const options = exact(value, ['storeId']);
  assertUuidV4(options.storeId, INVALID_PROJECTION);
  return encodedTarget(emptyQuestionProjection(options.storeId).journal, encodeQuestionJournalV2Local);
}

function instructionCandidateVariants(instruction, ledgerLookup, startedAt) {
  if (instruction.deliveryCreationState !== 'checkpointed') {
    return { retained: instruction, prepared: null, reclaimed: null };
  }
  const delivery = ledgerLookup.byAttemptId.get(instruction.deliveryAttemptId);
  if (!delivery) {
    return { retained: instruction, prepared: null, reclaimed: null };
  }
  const terminalAt = TERMINAL_STATES.includes(delivery.state)
    ? delivery.terminalAt
    : MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS;
  const terminalState = TERMINAL_STATES.includes(delivery.state) ? delivery.state : 'applied';
  const earliest = checkedRetentionDeadline(terminalAt);
  if (earliest === null || startedAt > terminalAt) return { retained: instruction, prepared: null, reclaimed: null };
  const reclamation = record([
    ['operationId', CANDIDATE_OPERATION_ID], ['preparedAt', MAX_SAFE_INTEGER],
    ['terminalState', terminalState], ['terminalAt', terminalAt],
  ]);
  const prepared = normalizeInstructionRecordV2Local(record([
    ...Object.entries(instruction).map(([key, value]) => [key, key === 'reclamation' ? reclamation : value]),
  ]));
  const reclaimed = normalizeInstructionRecordV2Local(record([
    ['recordType', 'reclaimed'],
    ['deliveryAttemptId', instruction.deliveryAttemptId],
    ['launchRef', instruction.launchRef],
    ['logicalMessageId', instruction.logicalMessageId],
    ['revision', instruction.revision],
    ['source', instruction.source],
    ['envelopeDigest', instruction.envelopeDigest],
    ['nativeContentDigest', instruction.nativeContentDigest],
    ['createdAt', instruction.createdAt],
    ['deliveryCreationState', 'checkpointed'],
    ['reclamation', reclamation],
    ['reclaimedAt', MAX_SAFE_INTEGER],
  ]));
  return { retained: instruction, prepared, reclaimed };
}

function buildInstructionCandidates(target, checkpoint, startedAt = 0) {
  const ledgerLookup = createLedgerLookup(checkpoint);
  const variants = target.instructions.map((item) => instructionCandidateVariants(item, ledgerLookup, startedAt));
  const encoded = encodeInstructionJournalV2Local(target);
  const sameSnapshot = () => ({ snapshot: target, encoded });
  const instructionCandidates = variants.map((candidate, index) => {
    const candidates = [
      { variant: 'current', record: candidate.retained },
      { variant: 'maxFutureDetail', record: candidate.retained },
    ];
    if (candidate.prepared !== null) candidates.push({ variant: 'prepared', record: candidate.prepared });
    if (candidate.reclaimed !== null) candidates.push({ variant: 'reclaimed', record: candidate.reclaimed });
    return { deliveryAttemptId: target.instructions[index].deliveryAttemptId, candidates };
  });
  return {
    instructionCandidates,
    candidates: {
      migration: sameSnapshot(),
      retained: sameSnapshot(),
      prepared: sameSnapshot(),
      reclaimed: sameSnapshot(),
    },
  };
}

function slotResult(slot, source, target, eligibleIds, candidates, questionCandidates = undefined,
  deliveryCandidates = undefined, instructionCandidates = undefined) {
  const result = {
    source,
    target: {
      snapshot: target.snapshot,
      encoded: target.encoded,
      sizeBytes: target.encoded.sizeBytes,
      sha256: target.encoded.sha256,
    },
    eligibleIds,
    candidateSnapshotsByBoundary: candidates,
  };
  if (questionCandidates !== undefined) result.questionCandidates = questionCandidates;
  if (deliveryCandidates !== undefined) result.deliveryCandidates = deliveryCandidates;
  if (instructionCandidates !== undefined) result.instructionCandidates = instructionCandidates;
  return result;
}

/**
 * 旧形式の固定source bytesを厳密に検査し、anchor migration用の局所targetと容量候補を作る。
 * grantの発行資格、store間の復旧可否、writer再開可否は判定しない。
 */
function projectLegacyReclamationMigrationLocal(value) {
  const options = exact(value, [
    'configuredSlots', 'sourceBytesBySlot', 'storeId', 'operationId', 'startedAt', 'migrationAllowanceBySlot',
  ]);
  const configuredSlots = dense(options.configuredSlots, SLOT_ORDER.length);
  requireValue(configuredSlots.length >= 1 && configuredSlots.every((slot) => SLOT_ORDER.includes(slot)) &&
    new Set(configuredSlots).size === configuredSlots.length);
  assertUuidV4(options.storeId, INVALID_PROJECTION);
  assertUuidV4(options.operationId, INVALID_PROJECTION);
  assertSafeUnsignedInteger(options.startedAt, INVALID_PROJECTION);
  const slotOrder = SLOT_ORDER.filter((slot) => configuredSlots.includes(slot));
  const sourceBytes = exact(options.sourceBytesBySlot, slotOrder);
  const allowances = exact(options.migrationAllowanceBySlot, slotOrder);
  const checkpointBytes = slotOrder.includes('checkpoint') ? sourceBytes.checkpoint : undefined;
  const checkpointResult = !slotOrder.includes('checkpoint')
    ? null
    : checkpointBytes === null
      ? (() => {
        const empty = createEmptyCheckpointV3TargetLocal({ storeId: options.storeId });
        const candidates = {
          migration: { snapshot: empty.snapshot, encoded: empty.encoded },
          retained: { snapshot: empty.snapshot, encoded: empty.encoded },
          prepared: { snapshot: empty.snapshot, encoded: empty.encoded },
          reclaimed: { snapshot: empty.snapshot, encoded: empty.encoded },
        };
        return {
          source: { present: false, schemaVersion: null, revision: null, sizeBytes: 0, sha256: null },
          ...empty, eligibleIds: [], candidateSnapshotsByBoundary: candidates, deliveryCandidates: [],
        };
      })()
      : projectLegacyCheckpointV2Local({
        sourceBytes: checkpointBytes,
        storeId: options.storeId,
        operationId: options.operationId,
        startedAt: options.startedAt,
        migrationAllowance: allowances.checkpoint,
      });
  if (slotOrder.includes('checkpoint') && checkpointBytes === null) requireValue(allowances.checkpoint === null);
  const checkpointSnapshot = checkpointResult?.snapshot ?? null;

  let questionResult = null;
  if (slotOrder.includes('questions')) {
    const bytes = sourceBytes.questions;
    if (bytes === null) {
      requireValue(allowances.questions === null);
      const projection = emptyQuestionProjection(options.storeId);
      const built = buildQuestionCandidates(projection, checkpointSnapshot);
      questionResult = {
        source: { present: false, schemaVersion: null, revision: null, sizeBytes: 0, sha256: null },
        ...encodedTarget(projection.journal, encodeQuestionJournalV2Local),
        eligibleIds: [], retiredQuestionPeriods: [], targets: [],
        questionCandidates: built.questionCandidates,
        candidateSnapshotsByBoundary: built.candidates,
      };
    } else {
      questionResult = projectLegacyQuestionJournalV1Local({
        sourceBytes: bytes,
        storeId: options.storeId,
        operationId: options.operationId,
        startedAt: options.startedAt,
        checkpointSnapshot,
        migrationAllowance: allowances.questions,
      });
    }
  }

  let instructionResult = null;
  if (slotOrder.includes('instructions')) {
    const bytes = sourceBytes.instructions;
    if (bytes === null) {
      requireValue(allowances.instructions === null);
      const snapshot = emptyInstructionSnapshot(options.storeId);
      const built = buildInstructionCandidates(snapshot, checkpointSnapshot, options.startedAt);
      instructionResult = {
        source: { present: false, schemaVersion: null, revision: null, sizeBytes: 0, sha256: null },
        ...encodedTarget(snapshot, encodeInstructionJournalV2Local),
        eligibleIds: [], candidateSnapshotsByBoundary: built.candidates,
        instructionCandidates: built.instructionCandidates,
      };
    } else {
      instructionResult = projectLegacyInstructionJournalV1Local({
        sourceBytes: bytes,
        storeId: options.storeId,
        operationId: options.operationId,
        startedAt: options.startedAt,
        checkpointSnapshot,
        migrationAllowance: allowances.instructions,
      });
    }
  }

  if (checkpointResult !== null) {
    const candidates = buildCheckpointCandidates(checkpointResult.snapshot,
      questionResult?.questionCandidates ?? [], options.startedAt);
    checkpointResult.candidateSnapshotsByBoundary = candidates.candidates;
    checkpointResult.deliveryCandidates = candidates.deliveryCandidates;
  }

  const slots = Object.create(null);
  const anchorSources = [];
  for (const slot of slotOrder) {
    const projection = slot === 'checkpoint' ? checkpointResult
      : slot === 'instructions' ? instructionResult : questionResult;
    const source = projection.source;
    const targetSnapshot = projection.snapshot;
    const encoded = projection.encoded;
    const candidates = projection.candidateSnapshotsByBoundary ?? {
      migration: { snapshot: targetSnapshot, encoded }, retained: { snapshot: targetSnapshot, encoded },
      prepared: { snapshot: targetSnapshot, encoded }, reclaimed: { snapshot: targetSnapshot, encoded },
    };
    slots[slot] = slotResult(slot, source, projection, projection.eligibleIds, candidates,
      projection.questionCandidates, projection.deliveryCandidates, projection.instructionCandidates);
    anchorSources.push(record([
      ['slot', slot],
      ['sourcePresent', source.present],
      ['schemaVersion', source.schemaVersion],
      ['revision', source.revision],
      ['sizeBytes', source.sizeBytes],
      ['sha256', source.sha256],
      ['targetSchemaVersion', SLOT_SCHEMA[slot].targetVersion],
      ['targetRevision', targetSnapshot.revision],
      ['targetSizeBytes', encoded.sizeBytes],
      ['targetSha256', encoded.sha256],
    ]));
  }

  const anchor = normalizeQuestionReclamationAnchorV1Local(record([
    ['schemaVersion', 1], ['revision', 0], ['storeId', options.storeId],
    ['retiredQuestionPeriods', questionResult?.retiredQuestionPeriods ?? []],
    ['migration', record([
      ['operationId', options.operationId], ['startedAt', options.startedAt], ['phase', 'prepared'],
      ['sources', anchorSources], ['targets', questionResult?.targets ?? []],
    ])],
  ]));
  const anchorEncoded = encodeQuestionReclamationAnchorV1Local(anchor);
  return {
    anchor,
    anchorEncoded,
    slots,
  };
}

module.exports = {
  createEmptyCheckpointV3TargetLocal,
  createEmptyInstructionJournalV2TargetLocal,
  createEmptyQuestionJournalV2TargetLocal,
  projectLegacyCheckpointV2Local,
  projectLegacyInstructionJournalV1Local,
  projectLegacyQuestionJournalV1Local,
  projectLegacyReclamationMigrationLocal,
};
