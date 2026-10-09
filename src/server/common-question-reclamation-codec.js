'use strict';

const { createHash } = require('node:crypto');
const { encodeNormalized } = require('./reclamation-json-codec');
const {
  assertIdentifier,
  assertSafeUnsignedInteger,
  assertSha256,
  assertUuidV4,
  captureDenseArray,
  captureExactRecord,
} = require('./reclamation-codec-primitives');

const MAX_JOURNAL_RECORDS = 20_000;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;
const MAX_QUESTION_TEXT = 2_000;
const MAX_OPTION_LABEL = 200;
const MAX_FREE_TEXT = 2_000;
const MAX_LATE_ANSWERS = 10;
const MAX_V1_SOURCE_BYTES = 16_777_216;

const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const ACTOR_FIELDS = ['kind', 'id'];
const BINDING_FIELDS = ['periodId', 'actor'];
const QUESTION_FIELDS = ['id', 'text', 'mode', 'options', 'allowFreeText', 'recommendedOptionId'];
const OPTION_FIELDS = ['id', 'label', 'description'];
const ANSWER_FIELDS = ['questionId', 'optionIds', 'freeText'];
const SELECTION_FIELDS = ['source', 'selectedAt', 'answers'];
const DELIVERY_INTENT_FIELDS = ['deliveryAttemptId', 'logicalMessageId', 'revision', 'payloadDigest'];
const EXTERNAL_RESOLUTION_FIELDS = ['resolvedAt', 'evidenceDigest'];
const LATE_ANSWER_FIELDS = ['submittedAt', 'digest', 'answers'];
const DETAIL_FIELDS = [
  'internalQuestionId', 'questionId', 'identity', 'periodId', 'executionId', 'conversationId',
  'launchRef', 'executionBinding', 'category', 'contentDigest', 'questions', 'createdAt',
  'deadlineAt', 'timeoutMinutes', 'revision', 'held', 'selection', 'deliveryIntent',
  'deliveryCreationState', 'autoApplyEnabledAtRegistration', 'quarantinedAt', 'externalResolution',
  'lateAnswers', 'cancelledAt',
];
const RESERVATION_FIELDS = [
  'internalQuestionId', 'identity', 'periodId', 'questionId', 'contentDigest', 'executionId',
  'conversationId', 'launchRef', 'executionBinding', 'createdAt', 'revision', 'selectionSource',
  'selectedAt', 'deliveryIntent', 'deliveryCreationState', 'checkpointState', 'sourceClaimsDigest',
  'sessionId', 'externalResolution', 'cancelledAt', 'terminalResultKind', 'quarantinedAt',
  'bodyState', 'reclaimedAt', 'reclamation',
];
const RECLAMATION_FIELDS = ['operationId', 'preparedAt', 'deliveryPresence', 'checkpointState'];
const GRANT_FIELDS = [
  'operationId', 'sourceSchemaVersion', 'sourceSizeBytes', 'sourceSha256', 'maxExtraBytes',
  'eligibleQuestionIds',
];
const JOURNAL_FIELDS = [
  'schemaVersion', 'storeId', 'revision', 'questions', 'reservations', 'migrationAllowance',
];
const DELIVERY_CREATION_STATES = ['not_created', 'creating', 'checkpointed', 'indeterminate'];
const CHECKPOINT_STATES = [
  'available', 'claimed', 'sending', 'accepted', 'applied', 'unknown',
  'cancelled_before_send', 'superseded_before_send',
];
const TERMINAL_RESULT_KINDS = ['applied', 'cancelled_before_send', 'superseded_before_send'];
const PROVIDER_NATIVE_ID_KINDS = { claude: 'session', codex: 'thread' };

const INVALID_JOURNAL = 'invalid_question_journal_v2';
const INVALID_DETAIL = 'invalid_question_detail_v2';
const INVALID_RESERVATION = 'invalid_question_reservation';

function reject(code) {
  throw new TypeError(code);
}

function requireValue(condition, code) {
  if (!condition) reject(code);
}

function captureRecord(value, fields, code) {
  return captureExactRecord(value, fields, code);
}

function captureArray(value, maxLength, code) {
  return captureDenseArray(value, maxLength, code);
}

function plainRecord(entries) {
  const result = {};
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

function digestSafeArray(items) {
  const result = new Array(items.length);
  Object.defineProperty(result, 'toJSON', {
    value: null,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  for (let index = 0; index < items.length; index += 1) {
    Object.defineProperty(result, String(index), {
      value: items[index],
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return result;
}

function digestSafeRecord(entries) {
  const result = Object.create(null);
  for (const [key, value] of entries) {
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return result;
}

function digestSafeValue(value) {
  if (Array.isArray(value)) {
    const items = new Array(value.length);
    for (let index = 0; index < value.length; index += 1) items[index] = digestSafeValue(value[index]);
    return digestSafeArray(items);
  }
  if (value !== null && typeof value === 'object') {
    const entries = [];
    for (const key of Object.keys(value)) entries.push([key, digestSafeValue(value[key])]);
    return digestSafeRecord(entries);
  }
  return value;
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(digestSafeValue(value)), 'utf8').digest('hex');
}

function normalizeIdentity(value, code) {
  const identity = captureRecord(value, IDENTITY_FIELDS, code);
  requireValue(typeof identity.provider === 'string' && Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, identity.provider) &&
    identity.nativeIdKind === PROVIDER_NATIVE_ID_KINDS[identity.provider], code);
  assertIdentifier(identity.hostId, code);
  assertIdentifier(identity.homeScopeId, code);
  assertIdentifier(identity.nativeId, code);
  return plainRecord(IDENTITY_FIELDS.map((field) => [field, identity[field]]));
}

function normalizeActor(value, code) {
  const actor = captureRecord(value, ACTOR_FIELDS, code);
  requireValue(actor.kind === 'agent' || actor.kind === 'tool-use', code);
  assertIdentifier(actor.id, code);
  return plainRecord(ACTOR_FIELDS.map((field) => [field, actor[field]]));
}

function normalizeBinding(value, code) {
  const binding = captureRecord(value, BINDING_FIELDS, code);
  assertIdentifier(binding.periodId, code);
  return plainRecord([
    ['periodId', binding.periodId],
    ['actor', normalizeActor(binding.actor, code)],
  ]);
}

function normalizeOption(value, code) {
  const option = captureRecord(value, OPTION_FIELDS, code);
  assertIdentifier(option.id, code);
  requireValue(typeof option.label === 'string' && option.label.trim().length > 0 &&
    option.label.length <= MAX_OPTION_LABEL, code);
  requireValue(typeof option.description === 'string' && option.description.length <= MAX_QUESTION_TEXT, code);
  return plainRecord(OPTION_FIELDS.map((field) => [field, option[field]]));
}

function normalizeQuestion(value, code) {
  const question = captureRecord(value, QUESTION_FIELDS, code);
  assertIdentifier(question.id, code);
  requireValue(typeof question.text === 'string' && question.text.trim().length > 0 &&
    question.text.length <= MAX_QUESTION_TEXT, code);
  requireValue(question.mode === 'single' || question.mode === 'multi', code);
  requireValue(typeof question.allowFreeText === 'boolean', code);

  const options = captureArray(question.options, MAX_OPTIONS, code).map((item) => normalizeOption(item, code));
  const optionIds = new Set(options.map(({ id }) => id));
  requireValue(optionIds.size === options.length, code);
  if (question.recommendedOptionId !== null) {
    assertIdentifier(question.recommendedOptionId, code);
    requireValue(optionIds.has(question.recommendedOptionId), code);
  }
  requireValue(options.length > 0 || question.allowFreeText, code);

  return plainRecord([
    ['id', question.id],
    ['text', question.text],
    ['mode', question.mode],
    ['options', options],
    ['allowFreeText', question.allowFreeText],
    ['recommendedOptionId', question.recommendedOptionId],
  ]);
}

function normalizeQuestions(value, code) {
  const questions = captureArray(value, MAX_QUESTIONS, code).map((item) => normalizeQuestion(item, code));
  const ids = new Set(questions.map(({ id }) => id));
  requireValue(questions.length > 0 && ids.size === questions.length, code);
  return questions;
}

function normalizeAnswers(value, questions, code) {
  const answers = captureArray(value, MAX_QUESTIONS, code);
  requireValue(answers.length === questions.length, code);
  const questionById = new Map(questions.map((question) => [question.id, question]));
  const seenQuestionIds = new Set();
  const normalized = answers.map((raw) => {
    const answer = captureRecord(raw, ANSWER_FIELDS, code);
    const question = questionById.get(answer.questionId);
    requireValue(question && !seenQuestionIds.has(answer.questionId), code);
    seenQuestionIds.add(answer.questionId);
    const optionIds = captureArray(answer.optionIds, MAX_OPTIONS, code);
    requireValue(optionIds.every((id) => typeof id === 'string' && id === id.trim() && id.length > 0 &&
      id.length <= 512 && !/[\u0000-\u001f\u007f]/.test(id) && question.options.some((option) => option.id === id)), code);
    requireValue(new Set(optionIds).size === optionIds.length, code);
    requireValue(answer.freeText === null || (typeof answer.freeText === 'string' &&
      answer.freeText.trim().length > 0 && answer.freeText.length <= MAX_FREE_TEXT), code);
    requireValue(answer.freeText === null || question.allowFreeText, code);

    const hasFreeText = typeof answer.freeText === 'string';
    if (question.options.length === 0) {
      requireValue(optionIds.length === 0 && hasFreeText, code);
    } else if (question.mode === 'single') {
      requireValue((optionIds.length === 1 || hasFreeText) && optionIds.length <= 1, code);
    } else {
      requireValue(optionIds.length > 0 || hasFreeText, code);
    }

    return plainRecord([
      ['questionId', answer.questionId],
      ['optionIds', optionIds.slice()],
      ['freeText', answer.freeText],
    ]);
  });
  requireValue(seenQuestionIds.size === questions.length, code);
  return normalized;
}

function normalizeSelection(value, questions, createdAt, deadlineAt, code) {
  if (value === null) return null;
  const selection = captureRecord(value, SELECTION_FIELDS, code);
  requireValue(selection.source === 'manual' || selection.source === 'away-default', code);
  assertSafeUnsignedInteger(selection.selectedAt, code);
  const answers = normalizeAnswers(selection.answers, questions, code);
  requireValue(selection.selectedAt >= createdAt, code);
  if (selection.source === 'away-default') {
    const eligible = questions.every((question) => question.mode === 'single' && question.recommendedOptionId !== null);
    const expected = questions.map((question) => plainRecord([
      ['questionId', question.id],
      ['optionIds', [question.recommendedOptionId]],
      ['freeText', null],
    ]));
    requireValue(eligible && selection.selectedAt >= deadlineAt && sha256Json(answers) === sha256Json(expected), code);
  }
  return plainRecord([
    ['source', selection.source],
    ['selectedAt', selection.selectedAt],
    ['answers', answers],
  ]);
}

function normalizeDeliveryIntent(value, revision, code) {
  if (value === null) return null;
  const intent = captureRecord(value, DELIVERY_INTENT_FIELDS, code);
  assertIdentifier(intent.deliveryAttemptId, code);
  assertIdentifier(intent.logicalMessageId, code);
  assertSafeUnsignedInteger(intent.revision, code);
  requireValue(intent.revision === revision, code);
  assertSha256(intent.payloadDigest, code);
  return plainRecord(DELIVERY_INTENT_FIELDS.map((field) => [field, intent[field]]));
}

function normalizeExternalResolution(value, createdAt, code) {
  if (value === null) return null;
  const resolution = captureRecord(value, EXTERNAL_RESOLUTION_FIELDS, code);
  assertSafeUnsignedInteger(resolution.resolvedAt, code);
  requireValue(resolution.resolvedAt >= createdAt, code);
  assertSha256(resolution.evidenceDigest, code);
  return plainRecord(EXTERNAL_RESOLUTION_FIELDS.map((field) => [field, resolution[field]]));
}

function normalizeLateAnswer(value, questions, createdAt, code) {
  const late = captureRecord(value, LATE_ANSWER_FIELDS, code);
  const answers = normalizeAnswers(late.answers, questions, code);
  assertSafeUnsignedInteger(late.submittedAt, code);
  requireValue(late.submittedAt >= createdAt, code);
  assertSha256(late.digest, code);
  requireValue(sha256Json(answers) === late.digest, code);
  return plainRecord([
    ['submittedAt', late.submittedAt],
    ['digest', late.digest],
    ['answers', answers],
  ]);
}

function normalizeQuestionDetailV2Internal(value) {
  const record = captureRecord(value, DETAIL_FIELDS, INVALID_DETAIL);
  for (const field of ['internalQuestionId', 'questionId', 'periodId', 'executionId', 'conversationId', 'launchRef']) {
    assertIdentifier(record[field], INVALID_DETAIL);
  }
  requireValue(record.category === 'ordinary', INVALID_DETAIL);
  assertSha256(record.contentDigest, INVALID_DETAIL);
  requireValue(Number.isSafeInteger(record.timeoutMinutes) && record.timeoutMinutes >= 1 &&
    record.timeoutMinutes <= 30, INVALID_DETAIL);
  assertSafeUnsignedInteger(record.revision, INVALID_DETAIL);
  requireValue(typeof record.held === 'boolean' && typeof record.autoApplyEnabledAtRegistration === 'boolean',
    INVALID_DETAIL);
  requireValue(DELIVERY_CREATION_STATES.includes(record.deliveryCreationState), INVALID_DETAIL);
  requireValue(record.cancelledAt === null || Number.isSafeInteger(record.cancelledAt) && record.cancelledAt >= 0,
    INVALID_DETAIL);

  const identity = normalizeIdentity(record.identity, INVALID_DETAIL);
  const executionBinding = normalizeBinding(record.executionBinding, INVALID_DETAIL);
  requireValue(executionBinding.periodId === record.periodId, INVALID_DETAIL);
  const questions = normalizeQuestions(record.questions, INVALID_DETAIL);
  requireValue(sha256Json(plainRecord([
    ['category', record.category],
    ['questions', questions],
  ])) === record.contentDigest, INVALID_DETAIL);

  assertSafeUnsignedInteger(record.createdAt, INVALID_DETAIL);
  requireValue(record.cancelledAt === null || record.cancelledAt >= record.createdAt, INVALID_DETAIL);
  assertSafeUnsignedInteger(record.deadlineAt, INVALID_DETAIL);
  requireValue(record.deadlineAt >= record.createdAt &&
    record.deadlineAt - record.createdAt === record.timeoutMinutes * 60_000, INVALID_DETAIL);
  requireValue(record.quarantinedAt === null || Number.isSafeInteger(record.quarantinedAt) && record.quarantinedAt >= 0,
    INVALID_DETAIL);

  const selection = normalizeSelection(record.selection, questions, record.createdAt, record.deadlineAt, INVALID_DETAIL);
  const deliveryIntent = normalizeDeliveryIntent(record.deliveryIntent, record.revision, INVALID_DETAIL);
  requireValue((selection === null) === (deliveryIntent === null), INVALID_DETAIL);
  requireValue(selection !== null || record.deliveryCreationState === 'not_created', INVALID_DETAIL);
  if (deliveryIntent !== null) {
    requireValue(deliveryIntent.payloadDigest === sha256Json(plainRecord([
      ['questionId', record.questionId],
      ['revision', record.revision],
      ['answers', selection.answers],
    ])), INVALID_DETAIL);
  }

  const externalResolution = normalizeExternalResolution(record.externalResolution, record.createdAt, INVALID_DETAIL);
  const lateAnswers = captureArray(record.lateAnswers, MAX_LATE_ANSWERS, INVALID_DETAIL)
    .map((late) => normalizeLateAnswer(late, questions, record.createdAt, INVALID_DETAIL));

  return plainRecord([
    ['internalQuestionId', record.internalQuestionId],
    ['questionId', record.questionId],
    ['identity', identity],
    ['periodId', record.periodId],
    ['executionId', record.executionId],
    ['conversationId', record.conversationId],
    ['launchRef', record.launchRef],
    ['executionBinding', executionBinding],
    ['category', record.category],
    ['contentDigest', record.contentDigest],
    ['questions', questions],
    ['createdAt', record.createdAt],
    ['deadlineAt', record.deadlineAt],
    ['timeoutMinutes', record.timeoutMinutes],
    ['revision', record.revision],
    ['held', record.held],
    ['selection', selection],
    ['deliveryIntent', deliveryIntent],
    ['deliveryCreationState', record.deliveryCreationState],
    ['autoApplyEnabledAtRegistration', record.autoApplyEnabledAtRegistration],
    ['quarantinedAt', record.quarantinedAt],
    ['externalResolution', externalResolution],
    ['lateAnswers', lateAnswers],
    ['cancelledAt', record.cancelledAt],
  ]);
}

function normalizeReclamation(value, reservation) {
  if (value === null) return null;
  const reclamation = captureRecord(value, RECLAMATION_FIELDS, INVALID_RESERVATION);
  assertUuidV4(reclamation.operationId, INVALID_RESERVATION);
  assertSafeUnsignedInteger(reclamation.preparedAt, INVALID_RESERVATION);
  requireValue(reservation.quarantinedAt !== null, INVALID_RESERVATION);
  requireValue(reclamation.deliveryPresence === 'none' || reclamation.deliveryPresence === 'checkpoint' ||
    reclamation.deliveryPresence === 'indeterminate', INVALID_RESERVATION);

  if (reclamation.deliveryPresence === 'none') {
    requireValue(reservation.deliveryCreationState === 'not_created' && reclamation.checkpointState === null,
      INVALID_RESERVATION);
  } else if (reclamation.deliveryPresence === 'checkpoint') {
    requireValue(reservation.deliveryCreationState === 'checkpointed' &&
      CHECKPOINT_STATES.includes(reclamation.checkpointState) &&
      reclamation.checkpointState === reservation.checkpointState, INVALID_RESERVATION);
  } else {
    requireValue(reservation.deliveryCreationState === 'indeterminate' &&
      reclamation.checkpointState === 'unknown' && reservation.checkpointState === 'unknown', INVALID_RESERVATION);
  }

  return plainRecord(RECLAMATION_FIELDS.map((field) => [field, reclamation[field]]));
}

function expectedTerminalResultKind(checkpointState) {
  return TERMINAL_RESULT_KINDS.includes(checkpointState) ? checkpointState : null;
}

/** reservation一件の局所schemaと同snapshot内の相関を検査する。 */
function normalizeQuestionReservation(value) {
  const record = captureRecord(value, RESERVATION_FIELDS, INVALID_RESERVATION);
  assertIdentifier(record.internalQuestionId, INVALID_RESERVATION);
  assertIdentifier(record.periodId, INVALID_RESERVATION);
  assertIdentifier(record.questionId, INVALID_RESERVATION);
  assertIdentifier(record.executionId, INVALID_RESERVATION);
  assertIdentifier(record.conversationId, INVALID_RESERVATION);
  assertIdentifier(record.launchRef, INVALID_RESERVATION);
  assertSha256(record.contentDigest, INVALID_RESERVATION);
  assertSafeUnsignedInteger(record.createdAt, INVALID_RESERVATION);
  assertSafeUnsignedInteger(record.revision, INVALID_RESERVATION);
  requireValue(DELIVERY_CREATION_STATES.includes(record.deliveryCreationState), INVALID_RESERVATION);
  requireValue(record.checkpointState === null || CHECKPOINT_STATES.includes(record.checkpointState), INVALID_RESERVATION);
  requireValue(record.sourceClaimsDigest === null || typeof record.sourceClaimsDigest === 'string', INVALID_RESERVATION);
  requireValue(record.sessionId === null || typeof record.sessionId === 'string', INVALID_RESERVATION);
  if (record.sessionId !== null) assertIdentifier(record.sessionId, INVALID_RESERVATION);
  requireValue(record.cancelledAt === null || Number.isSafeInteger(record.cancelledAt) && record.cancelledAt >= 0,
    INVALID_RESERVATION);
  requireValue(record.quarantinedAt === null || Number.isSafeInteger(record.quarantinedAt) && record.quarantinedAt >= 0,
    INVALID_RESERVATION);
  requireValue(record.bodyState === 'retained' || record.bodyState === 'reclaimed', INVALID_RESERVATION);
  requireValue(record.reclaimedAt === null || Number.isSafeInteger(record.reclaimedAt) && record.reclaimedAt >= 0,
    INVALID_RESERVATION);

  const identity = normalizeIdentity(record.identity, INVALID_RESERVATION);
  const executionBinding = normalizeBinding(record.executionBinding, INVALID_RESERVATION);
  requireValue(executionBinding.periodId === record.periodId, INVALID_RESERVATION);
  const deliveryIntent = normalizeDeliveryIntent(record.deliveryIntent, record.revision, INVALID_RESERVATION);
  const selectionSource = record.selectionSource;
  const selectedAt = record.selectedAt;
  requireValue(selectionSource === null || selectionSource === 'manual' || selectionSource === 'away-default',
    INVALID_RESERVATION);
  requireValue(selectedAt === null || Number.isSafeInteger(selectedAt) && selectedAt >= record.createdAt,
    INVALID_RESERVATION);
  requireValue((selectionSource === null) === (selectedAt === null) &&
    (selectionSource === null) === (deliveryIntent === null), INVALID_RESERVATION);
  requireValue(selectionSource !== null || record.deliveryCreationState === 'not_created', INVALID_RESERVATION);

  if (record.deliveryCreationState === 'not_created') {
    requireValue(record.checkpointState === null && record.sourceClaimsDigest === null && record.sessionId === null &&
      ((deliveryIntent === null) === (selectionSource === null)), INVALID_RESERVATION);
  } else if (record.deliveryCreationState === 'creating') {
    requireValue(deliveryIntent !== null && record.checkpointState === null && record.sourceClaimsDigest === null &&
      record.sessionId === null, INVALID_RESERVATION);
  } else if (record.deliveryCreationState === 'checkpointed') {
    requireValue(deliveryIntent !== null && record.checkpointState !== null &&
      record.sourceClaimsDigest !== null && record.sessionId !== null, INVALID_RESERVATION);
  } else {
    requireValue(deliveryIntent !== null && record.checkpointState === 'unknown' &&
      record.sourceClaimsDigest === null && record.sessionId === null, INVALID_RESERVATION);
  }
  if (record.sourceClaimsDigest !== null) assertSha256(record.sourceClaimsDigest, INVALID_RESERVATION);
  requireValue(record.terminalResultKind === expectedTerminalResultKind(record.checkpointState), INVALID_RESERVATION);

  const externalResolution = normalizeExternalResolution(record.externalResolution, record.createdAt, INVALID_RESERVATION);
  requireValue(record.cancelledAt === null || record.cancelledAt >= record.createdAt, INVALID_RESERVATION);
  const reclamation = normalizeReclamation(record.reclamation, record);
  if (record.bodyState === 'retained') {
    requireValue(record.reclaimedAt === null, INVALID_RESERVATION);
  } else {
    requireValue(reclamation !== null && Number.isSafeInteger(record.reclaimedAt) &&
      record.reclaimedAt >= reclamation.preparedAt, INVALID_RESERVATION);
  }

  return plainRecord([
    ['internalQuestionId', record.internalQuestionId],
    ['identity', identity],
    ['periodId', record.periodId],
    ['questionId', record.questionId],
    ['contentDigest', record.contentDigest],
    ['executionId', record.executionId],
    ['conversationId', record.conversationId],
    ['launchRef', record.launchRef],
    ['executionBinding', executionBinding],
    ['createdAt', record.createdAt],
    ['revision', record.revision],
    ['selectionSource', selectionSource],
    ['selectedAt', selectedAt],
    ['deliveryIntent', deliveryIntent],
    ['deliveryCreationState', record.deliveryCreationState],
    ['checkpointState', record.checkpointState],
    ['sourceClaimsDigest', record.sourceClaimsDigest],
    ['sessionId', record.sessionId],
    ['externalResolution', externalResolution],
    ['cancelledAt', record.cancelledAt],
    ['terminalResultKind', record.terminalResultKind],
    ['quarantinedAt', record.quarantinedAt],
    ['bodyState', record.bodyState],
    ['reclaimedAt', record.reclaimedAt],
    ['reclamation', reclamation],
  ]);
}

function normalizeMigrationAllowance(value) {
  if (value === null) return null;
  const grant = captureRecord(value, GRANT_FIELDS, INVALID_JOURNAL);
  assertUuidV4(grant.operationId, INVALID_JOURNAL);
  requireValue(grant.sourceSchemaVersion === 1, INVALID_JOURNAL);
  assertSafeUnsignedInteger(grant.sourceSizeBytes, INVALID_JOURNAL);
  requireValue(grant.sourceSizeBytes <= MAX_V1_SOURCE_BYTES, INVALID_JOURNAL);
  assertSha256(grant.sourceSha256, INVALID_JOURNAL);
  requireValue(Number.isSafeInteger(grant.maxExtraBytes) && grant.maxExtraBytes > 0, INVALID_JOURNAL);
  const eligibleQuestionIds = captureArray(grant.eligibleQuestionIds, MAX_JOURNAL_RECORDS, INVALID_JOURNAL);
  eligibleQuestionIds.forEach((id) => assertIdentifier(id, INVALID_JOURNAL));
  requireValue(new Set(eligibleQuestionIds).size === eligibleQuestionIds.length, INVALID_JOURNAL);
  return plainRecord([
    ['operationId', grant.operationId],
    ['sourceSchemaVersion', grant.sourceSchemaVersion],
    ['sourceSizeBytes', grant.sourceSizeBytes],
    ['sourceSha256', grant.sourceSha256],
    ['maxExtraBytes', grant.maxExtraBytes],
    ['eligibleQuestionIds', eligibleQuestionIds.slice()],
  ]);
}

function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function sameBinding(left, right) {
  return left.periodId === right.periodId && left.actor.kind === right.actor.kind && left.actor.id === right.actor.id;
}

function sameFieldRecord(left, right, fields) {
  if (left === null || right === null) return left === right;
  return fields.every((field) => left[field] === right[field]);
}

function sameDetailReservation(detail, reservation) {
  return detail.internalQuestionId === reservation.internalQuestionId &&
    sameIdentity(detail.identity, reservation.identity) && detail.periodId === reservation.periodId &&
    detail.questionId === reservation.questionId && detail.contentDigest === reservation.contentDigest &&
    detail.executionId === reservation.executionId && detail.conversationId === reservation.conversationId &&
    detail.launchRef === reservation.launchRef && sameBinding(detail.executionBinding, reservation.executionBinding) &&
    detail.createdAt === reservation.createdAt && detail.revision === reservation.revision &&
    (detail.selection === null ? null : detail.selection.source) === reservation.selectionSource &&
    (detail.selection === null ? null : detail.selection.selectedAt) === reservation.selectedAt &&
    sameFieldRecord(detail.deliveryIntent, reservation.deliveryIntent, DELIVERY_INTENT_FIELDS) &&
    detail.deliveryCreationState === reservation.deliveryCreationState &&
    sameFieldRecord(detail.externalResolution, reservation.externalResolution, EXTERNAL_RESOLUTION_FIELDS) &&
    detail.cancelledAt === reservation.cancelledAt && detail.quarantinedAt === reservation.quarantinedAt;
}

function commonKeyParts(identity, periodId, questionId) {
  return [...IDENTITY_FIELDS.map((field) => identity[field]), periodId, questionId];
}

function commonKeyString(identity, periodId, questionId) {
  return commonKeyParts(identity, periodId, questionId).map((value) => `${value.length}:${value}`).join('');
}

/** v2 journalの局所構造とdetail-reservation対応を検査する。外部store照合や容量計算は行わない。 */
function normalizeQuestionJournalV2Local(value, maxRecords = MAX_JOURNAL_RECORDS) {
  requireValue(Number.isSafeInteger(maxRecords) && maxRecords >= 1 && maxRecords <= MAX_JOURNAL_RECORDS,
    INVALID_JOURNAL);
  const journal = captureRecord(value, JOURNAL_FIELDS, INVALID_JOURNAL);
  requireValue(journal.schemaVersion === 2, INVALID_JOURNAL);
  assertUuidV4(journal.storeId, INVALID_JOURNAL);
  assertSafeUnsignedInteger(journal.revision, INVALID_JOURNAL);

  const questions = captureArray(journal.questions, maxRecords, INVALID_JOURNAL)
    .map((record) => normalizeQuestionDetailV2Internal(record));
  const reservations = captureArray(journal.reservations, maxRecords, INVALID_JOURNAL)
    .map((record) => normalizeQuestionReservation(record));
  requireValue(questions.length <= reservations.length, INVALID_JOURNAL);

  const reservationById = new Map();
  const reservationIds = new Set();
  const commonKeys = new Set();
  for (const reservation of reservations) {
    const commonKey = commonKeyString(reservation.identity, reservation.periodId, reservation.questionId);
    requireValue(!reservationIds.has(reservation.internalQuestionId) && !commonKeys.has(commonKey), INVALID_JOURNAL);
    reservationIds.add(reservation.internalQuestionId);
    commonKeys.add(commonKey);
    reservationById.set(reservation.internalQuestionId, reservation);
  }

  const detailById = new Map();
  for (const detail of questions) {
    requireValue(!detailById.has(detail.internalQuestionId), INVALID_JOURNAL);
    detailById.set(detail.internalQuestionId, detail);
  }

  for (const reservation of reservations) {
    const detail = detailById.get(reservation.internalQuestionId);
    if (reservation.bodyState === 'retained') {
      requireValue(detail !== undefined && sameDetailReservation(detail, reservation), INVALID_JOURNAL);
    } else {
      requireValue(detail === undefined, INVALID_JOURNAL);
    }
  }
  for (const detail of questions) {
    requireValue(reservationById.get(detail.internalQuestionId)?.bodyState === 'retained', INVALID_JOURNAL);
  }

  const migrationAllowance = normalizeMigrationAllowance(journal.migrationAllowance);
  return plainRecord([
    ['schemaVersion', 2],
    ['storeId', journal.storeId],
    ['revision', journal.revision],
    ['questions', questions],
    ['reservations', reservations],
    ['migrationAllowance', migrationAllowance],
  ]);
}

/** detail v2の局所schemaと現行質問・回答digestを検査する。 */
function normalizeQuestionDetailV2(value) {
  return normalizeQuestionDetailV2Internal(value);
}

/** 正規化したv2 detail全体のcompact JSON SHA-256を返す。 */
function questionRecordDigest(value) {
  return sha256Json(normalizeQuestionDetailV2Internal(value));
}

/** 完全identity、period、公開question IDから現行共通keyと同形のdigestを返す。 */
function questionCommonKeyDigest(identityValue, periodId, questionId) {
  const identity = normalizeIdentity(identityValue, INVALID_DETAIL);
  assertIdentifier(periodId, INVALID_DETAIL);
  assertIdentifier(questionId, INVALID_DETAIL);
  const identityValues = digestSafeArray(IDENTITY_FIELDS.map((field) => identity[field]));
  const key = digestSafeArray([identityValues, periodId, questionId]);
  return createHash('sha256').update(JSON.stringify(key), 'utf8').digest('hex');
}

/** 局所検証済みjournalを正規化JSON codecでserializeする。外部store照合は行わない。 */
function encodeQuestionJournalV2Local(value, maxRecords = MAX_JOURNAL_RECORDS) {
  return encodeNormalized(normalizeQuestionJournalV2Local(value, maxRecords));
}

module.exports = {
  encodeQuestionJournalV2Local,
  normalizeQuestionDetailV2,
  normalizeQuestionJournalV2Local,
  normalizeQuestionReservation,
  questionCommonKeyDigest,
  questionRecordDigest,
};
