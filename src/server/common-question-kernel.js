'use strict';

const { createHash } = require('node:crypto');

const JOURNAL_SCHEMA_VERSION = 1;
const MAX_JOURNAL_RECORDS = 20_000;
const MAX_QUESTIONS = 4;
const MAX_OPTIONS = 6;
const MAX_QUESTION_TEXT = 2_000;
const MAX_OPTION_LABEL = 200;
const MAX_FREE_TEXT = 2_000;
const MAX_LATE_ANSWERS = 10;
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
const JOURNAL_FIELDS = ['schemaVersion', 'revision', 'questions'];
const RECORD_FIELDS = [
  'internalQuestionId', 'questionId', 'identity', 'periodId', 'executionId', 'conversationId',
  'launchRef', 'executionBinding', 'category', 'contentDigest', 'questions', 'createdAt',
  'deadlineAt', 'timeoutMinutes', 'revision', 'held', 'selection', 'deliveryIntent',
  'autoApplyEnabledAtRegistration', 'externalResolution', 'lateAnswers', 'cancelledAt',
];
const PROVIDER_NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });

function questionError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch { return false; }
}

function exactObject(value, fields, code = 'invalid_question') {
  if (!isPlainObject(value)) throw questionError(code);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { throw questionError(code); }
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
    throw questionError(code);
  }
  const clone = {};
  for (const field of fields) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); } catch { throw questionError(code); }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw questionError(code);
    clone[field] = descriptor.value;
  }
  return clone;
}

function exactObjectWithDefault(value, fields, optionalDefaults, code) {
  if (!isPlainObject(value)) throw questionError(code);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { throw questionError(code); }
  const missing = fields.filter((field) => !keys.includes(field));
  if (keys.some((key) => typeof key !== 'string' || !fields.includes(key)) ||
      missing.some((field) => !Object.hasOwn(optionalDefaults, field))) throw questionError(code);
  const clone = {};
  for (const field of fields) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); } catch { throw questionError(code); }
    if (!descriptor) {
      clone[field] = optionalDefaults[field];
      continue;
    }
    if (!Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw questionError(code);
    clone[field] = descriptor.value;
  }
  return clone;
}

function denseArray(value, maxLength, code = 'invalid_question') {
  if (!Array.isArray(value) || value.length > maxLength) throw questionError(code);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { throw questionError(code); }
  if (keys.length !== value.length + 1 || keys.some((key) => key !== 'length' &&
      !(typeof key === 'string' && Number.isSafeInteger(Number(key)) && Number(key) >= 0 &&
        String(Number(key)) === key && Number(key) < value.length))) throw questionError(code);
  const result = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index)) throw questionError(code);
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, String(index)); } catch { throw questionError(code); }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw questionError(code);
    result.push(descriptor.value);
  }
  return result;
}

function isIdentifier(value, maxLength = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeIdentity(value) {
  const identity = exactObject(value, IDENTITY_FIELDS, 'invalid_question_registration');
  if (!Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, identity.provider) ||
      identity.nativeIdKind !== PROVIDER_NATIVE_ID_KINDS[identity.provider] ||
      !isIdentifier(identity.hostId) || !isIdentifier(identity.homeScopeId) || !isIdentifier(identity.nativeId)) {
    throw questionError('invalid_question_registration');
  }
  return identity;
}

function normalizeActor(value) {
  const actor = exactObject(value, ACTOR_FIELDS, 'invalid_question_registration');
  if (!['agent', 'tool-use'].includes(actor.kind) || !isIdentifier(actor.id)) {
    throw questionError('invalid_question_registration');
  }
  return actor;
}

function normalizeBinding(value) {
  const binding = exactObject(value, BINDING_FIELDS, 'invalid_question_registration');
  if (!isIdentifier(binding.periodId)) throw questionError('invalid_question_registration');
  return { periodId: binding.periodId, actor: normalizeActor(binding.actor) };
}

function normalizeQuestion(value) {
  const question = exactObject(value, QUESTION_FIELDS);
  if (!isIdentifier(question.id) || typeof question.text !== 'string' || !question.text.trim() ||
      question.text.length > MAX_QUESTION_TEXT || !['single', 'multi'].includes(question.mode) ||
      typeof question.allowFreeText !== 'boolean') throw questionError('invalid_question');
  const rawOptions = denseArray(question.options, MAX_OPTIONS);
  const options = rawOptions.map((raw) => {
    const option = exactObject(raw, OPTION_FIELDS);
    if (!isIdentifier(option.id) || typeof option.label !== 'string' || !option.label.trim() ||
        option.label.length > MAX_OPTION_LABEL || typeof option.description !== 'string' ||
        option.description.length > MAX_QUESTION_TEXT) throw questionError('invalid_question');
    return option;
  });
  if (new Set(options.map(({ id }) => id)).size !== options.length) throw questionError('invalid_question');
  if (question.recommendedOptionId !== null &&
      (!isIdentifier(question.recommendedOptionId) || !options.some(({ id }) => id === question.recommendedOptionId))) {
    throw questionError('invalid_question');
  }
  if (!options.length && !question.allowFreeText) throw questionError('invalid_question');
  return { ...question, options };
}

function normalizeQuestions(value) {
  const questions = denseArray(value, MAX_QUESTIONS).map(normalizeQuestion);
  if (!questions.length || new Set(questions.map(({ id }) => id)).size !== questions.length) {
    throw questionError('invalid_question');
  }
  return questions;
}

function normalizeAnswers(value, questions) {
  const answers = denseArray(value, MAX_QUESTIONS, 'invalid_answer');
  if (answers.length !== questions.length) throw questionError('invalid_answer');
  const byId = new Map(questions.map((question) => [question.id, question]));
  const seen = new Set();
  const normalized = answers.map((raw) => {
    const answer = exactObject(raw, ANSWER_FIELDS, 'invalid_answer');
    const question = byId.get(answer.questionId);
    if (!question || seen.has(answer.questionId)) throw questionError('invalid_answer');
    seen.add(answer.questionId);
    const optionIds = denseArray(answer.optionIds, MAX_OPTIONS, 'invalid_answer');
    if (optionIds.some((id) => !isIdentifier(id) || !question.options.some((option) => option.id === id)) ||
        new Set(optionIds).size !== optionIds.length) throw questionError('invalid_answer');
    if (answer.freeText !== null && (typeof answer.freeText !== 'string' || !answer.freeText.trim() ||
        answer.freeText.length > MAX_FREE_TEXT)) throw questionError('invalid_answer');
    if (answer.freeText !== null && !question.allowFreeText) throw questionError('invalid_answer');
    const hasFreeText = typeof answer.freeText === 'string';
    if (question.options.length === 0) {
      if (optionIds.length !== 0 || !hasFreeText) throw questionError('invalid_answer');
    } else if (question.mode === 'single') {
      if ((optionIds.length !== 1 && !hasFreeText) || optionIds.length > 1) throw questionError('invalid_answer');
    } else if (optionIds.length === 0 && !hasFreeText) {
      throw questionError('invalid_answer');
    }
    return { questionId: answer.questionId, optionIds, freeText: answer.freeText };
  });
  if (seen.size !== questions.length) throw questionError('invalid_answer');
  return normalized;
}

function sha256Json(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function normalizeTimestamp(value, code = 'invalid_journal') {
  if (!Number.isSafeInteger(value) || value < 0) throw questionError(code);
  return value;
}

function normalizeSelection(value, questions, createdAt, deadlineAt) {
  if (value === null) return null;
  const selection = exactObject(value, SELECTION_FIELDS, 'invalid_journal');
  if (!['manual', 'away-default'].includes(selection.source)) throw questionError('invalid_journal');
  const selectedAt = normalizeTimestamp(selection.selectedAt);
  const answers = normalizeAnswers(selection.answers, questions);
  if (selectedAt < createdAt) throw questionError('invalid_journal');
  if (selection.source === 'away-default') {
    const eligible = questions.every((question) => question.mode === 'single' && question.recommendedOptionId !== null);
    const expected = questions.map((question) => ({ questionId: question.id,
      optionIds: [question.recommendedOptionId], freeText: null }));
    if (!eligible || selectedAt < deadlineAt || sha256Json(answers) !== sha256Json(expected)) {
      throw questionError('invalid_journal');
    }
  }
  return { source: selection.source, selectedAt, answers };
}

function normalizeDeliveryIntent(value, revision) {
  if (value === null) return null;
  const intent = exactObject(value, DELIVERY_INTENT_FIELDS, 'invalid_journal');
  if (!isIdentifier(intent.deliveryAttemptId) || !isIdentifier(intent.logicalMessageId) ||
      !Number.isSafeInteger(intent.revision) || intent.revision !== revision ||
      typeof intent.payloadDigest !== 'string' || !/^[a-f0-9]{64}$/.test(intent.payloadDigest)) {
    throw questionError('invalid_journal');
  }
  return intent;
}

function normalizeExternalResolution(value, createdAt) {
  if (value === null) return null;
  const resolution = exactObject(value, EXTERNAL_RESOLUTION_FIELDS, 'invalid_journal');
  if (typeof resolution.evidenceDigest !== 'string' || !/^[a-f0-9]{64}$/.test(resolution.evidenceDigest)) {
    throw questionError('invalid_journal');
  }
  const resolvedAt = normalizeTimestamp(resolution.resolvedAt);
  if (resolvedAt < createdAt) throw questionError('invalid_journal');
  return { resolvedAt, evidenceDigest: resolution.evidenceDigest };
}

function normalizeLateAnswer(value, questions, createdAt) {
  const late = exactObject(value, LATE_ANSWER_FIELDS, 'invalid_journal');
  const answers = normalizeAnswers(late.answers, questions);
  const submittedAt = normalizeTimestamp(late.submittedAt);
  if (submittedAt < createdAt || typeof late.digest !== 'string' || !/^[a-f0-9]{64}$/.test(late.digest) ||
      sha256Json(answers) !== late.digest) throw questionError('invalid_journal');
  return { submittedAt, digest: late.digest, answers };
}

function normalizeQuestionRecord(value) {
  const record = exactObjectWithDefault(value, RECORD_FIELDS, { autoApplyEnabledAtRegistration: false }, 'invalid_journal');
  if (!isIdentifier(record.internalQuestionId) || !isIdentifier(record.questionId) ||
      !isIdentifier(record.periodId) || !isIdentifier(record.executionId) ||
      !isIdentifier(record.conversationId) || !isIdentifier(record.launchRef) ||
      record.category !== 'ordinary' || typeof record.contentDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(record.contentDigest) || !Number.isSafeInteger(record.timeoutMinutes) ||
      record.timeoutMinutes < 1 || record.timeoutMinutes > 30 || !Number.isSafeInteger(record.revision) ||
      record.revision < 0 || typeof record.held !== 'boolean' ||
      typeof record.autoApplyEnabledAtRegistration !== 'boolean' ||
      (record.cancelledAt !== null && (!Number.isSafeInteger(record.cancelledAt) || record.cancelledAt < 0))) {
    throw questionError('invalid_journal');
  }
  const identity = normalizeIdentity(record.identity);
  const executionBinding = normalizeBinding(record.executionBinding);
  if (executionBinding.periodId !== record.periodId) throw questionError('invalid_journal');
  const questions = normalizeQuestions(record.questions);
  if (sha256Json({ category: record.category, questions }) !== record.contentDigest) throw questionError('invalid_journal');
  const createdAt = normalizeTimestamp(record.createdAt);
  if (record.cancelledAt !== null && record.cancelledAt < createdAt) throw questionError('invalid_journal');
  const deadlineAt = normalizeTimestamp(record.deadlineAt);
  if (deadlineAt < createdAt || deadlineAt - createdAt !== record.timeoutMinutes * 60_000) {
    throw questionError('invalid_journal');
  }
  const selection = normalizeSelection(record.selection, questions, createdAt, deadlineAt);
  const deliveryIntent = normalizeDeliveryIntent(record.deliveryIntent, record.revision);
  if ((selection === null) !== (deliveryIntent === null) ||
      (deliveryIntent !== null && deliveryIntent.payloadDigest !== sha256Json({
        questionId: record.questionId,
        revision: record.revision,
        answers: selection.answers,
      }))) throw questionError('invalid_journal');
  const externalResolution = normalizeExternalResolution(record.externalResolution, createdAt);
  const lateAnswers = denseArray(record.lateAnswers, MAX_LATE_ANSWERS, 'invalid_journal')
    .map((late) => normalizeLateAnswer(late, questions, createdAt));
  return {
    ...record,
    identity,
    executionBinding,
    questions,
    createdAt,
    deadlineAt,
    selection,
    deliveryIntent,
    externalResolution,
    lateAnswers,
  };
}

function createEmptyJournal() {
  return { schemaVersion: JOURNAL_SCHEMA_VERSION, revision: 0, questions: [] };
}

function normalizeJournal(value, maxRecords = MAX_JOURNAL_RECORDS) {
  const journal = exactObject(value, JOURNAL_FIELDS, 'invalid_journal');
  if (journal.schemaVersion !== JOURNAL_SCHEMA_VERSION || !Number.isSafeInteger(journal.revision) ||
      journal.revision < 0 || !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_JOURNAL_RECORDS) {
    throw questionError('invalid_journal');
  }
  const records = denseArray(journal.questions, maxRecords, 'invalid_journal').map(normalizeQuestionRecord);
  const keys = new Set();
  const ids = new Set();
  for (const record of records) {
    const key = questionKey(record.identity, record.periodId, record.questionId);
    if (keys.has(key) || ids.has(record.internalQuestionId)) throw questionError('invalid_journal');
    keys.add(key);
    ids.add(record.internalQuestionId);
  }
  return { schemaVersion: JOURNAL_SCHEMA_VERSION, revision: journal.revision, questions: records };
}

function questionKey(identity, periodId, questionId) {
  return JSON.stringify([IDENTITY_FIELDS.map((field) => identity[field]), periodId, questionId]);
}

function createQuestionRecord(input) {
  const fields = [
    'internalQuestionId', 'questionId', 'identity', 'periodId', 'executionId', 'conversationId',
    'launchRef', 'executionBinding', 'category', 'questions', 'timeoutMinutes', 'createdAt',
    'autoApplyEnabledAtRegistration',
  ];
  const value = exactObjectWithDefault(input, fields, { autoApplyEnabledAtRegistration: false }, 'invalid_question_registration');
  if (!isIdentifier(value.internalQuestionId) || !isIdentifier(value.questionId) ||
      !isIdentifier(value.periodId) || !isIdentifier(value.executionId) ||
      !isIdentifier(value.conversationId) || !isIdentifier(value.launchRef) ||
      value.category !== 'ordinary' || !Number.isSafeInteger(value.timeoutMinutes) ||
      value.timeoutMinutes < 1 || value.timeoutMinutes > 30) throw questionError('invalid_question_registration');
  const identity = normalizeIdentity(value.identity);
  const executionBinding = normalizeBinding(value.executionBinding);
  if (executionBinding.periodId !== value.periodId) throw questionError('invalid_question_registration');
  const questions = normalizeQuestions(value.questions);
  const createdAt = normalizeTimestamp(value.createdAt, 'invalid_question_registration');
  return normalizeQuestionRecord({
    ...value,
    category: 'ordinary',
    identity,
    executionBinding,
    questions,
    contentDigest: sha256Json({ category: 'ordinary', questions }),
    deadlineAt: createdAt + value.timeoutMinutes * 60_000,
    revision: 0,
    held: false,
    selection: null,
    deliveryIntent: null,
    externalResolution: null,
    lateAnswers: [],
    cancelledAt: null,
  });
}

function makeDeliveryIntent(record, answers, uuid) {
  if (!record || typeof uuid !== 'string' || !isIdentifier(uuid)) throw questionError('invalid_delivery_intent');
  const revision = record.revision + 1;
  const normalizedAnswers = normalizeAnswers(answers, record.questions);
  const payloadDigest = sha256Json({ questionId: record.questionId, revision, answers: normalizedAnswers });
  return {
    ...record,
    revision,
    selection: { source: 'manual', selectedAt: record.createdAt, answers: normalizedAnswers },
    deliveryIntent: {
      deliveryAttemptId: `common-question-${uuid}`,
      logicalMessageId: `common-question-${record.internalQuestionId}`,
      revision,
      payloadDigest,
    },
  };
}

function selectionFor(record, answers, source, at, uuid) {
  if (!['manual', 'away-default'].includes(source)) throw questionError('invalid_selection_source');
  if (!Number.isSafeInteger(at) || at < record.createdAt) throw questionError('invalid_selection_time');
  if (record.cancelledAt !== null) throw questionError('question_cancelled');
  const normalizedAnswers = normalizeAnswers(answers, record.questions);
  const digest = sha256Json(normalizedAnswers);
  if (record.selection) {
    if (sha256Json(record.selection.answers) === digest) return { record, outcome: 'duplicate' };
    if (record.lateAnswers.some((late) => late.digest === digest)) return { record, outcome: 'duplicate' };
    if (record.lateAnswers.length >= MAX_LATE_ANSWERS) throw questionError('late_answer_capacity');
    const next = normalizeQuestionRecord({
      ...record,
      lateAnswers: [...record.lateAnswers, { submittedAt: at, digest, answers: normalizedAnswers }],
    });
    return { record: next, outcome: 'late' };
  }
  if (record.cancelledAt !== null || record.externalResolution !== null) {
    if (record.lateAnswers.some((late) => late.digest === digest)) return { record, outcome: 'duplicate' };
    if (record.lateAnswers.length >= MAX_LATE_ANSWERS) throw questionError('late_answer_capacity');
    const next = normalizeQuestionRecord({
      ...record,
      lateAnswers: [...record.lateAnswers, { submittedAt: at, digest, answers: normalizedAnswers }],
    });
    return { record: next, outcome: 'late' };
  }
  const revision = record.revision + 1;
  const selected = normalizeQuestionRecord({
    ...record,
    revision,
    selection: { source, selectedAt: at, answers: normalizedAnswers },
    deliveryIntent: {
      deliveryAttemptId: `common-question-${uuid}`,
      logicalMessageId: `common-question-${record.internalQuestionId}`,
      revision,
      payloadDigest: sha256Json({ questionId: record.questionId, revision, answers: normalizedAnswers }),
    },
  });
  return { record: selected, outcome: 'selected' };
}

function canApplyAwayDefault(record) {
  return record.category === 'ordinary' && record.selection === null && record.externalResolution === null &&
    record.cancelledAt === null && !record.held && record.questions.every((question) =>
      question.mode === 'single' && question.recommendedOptionId !== null);
}

function awayDefaultAnswers(record) {
  if (!canApplyAwayDefault(record)) throw questionError('away_default_unavailable');
  return record.questions.map((question) => ({
    questionId: question.id,
    optionIds: [question.recommendedOptionId],
    freeText: null,
  }));
}

function addQuestion(journalInput, recordInput, maxRecords = MAX_JOURNAL_RECORDS) {
  const journal = normalizeJournal(journalInput, maxRecords);
  const record = normalizeQuestionRecord(recordInput);
  const key = questionKey(record.identity, record.periodId, record.questionId);
  if (journal.questions.some((item) => questionKey(item.identity, item.periodId, item.questionId) === key)) {
    throw questionError('question_conflict');
  }
  if (journal.questions.length >= maxRecords) throw questionError('question_capacity');
  return normalizeJournal({
    schemaVersion: journal.schemaVersion,
    revision: journal.revision + 1,
    questions: [...journal.questions, record],
  }, maxRecords);
}

function replaceQuestion(journalInput, recordInput, maxRecords = MAX_JOURNAL_RECORDS) {
  const journal = normalizeJournal(journalInput, maxRecords);
  const record = normalizeQuestionRecord(recordInput);
  const index = journal.questions.findIndex((item) => item.internalQuestionId === record.internalQuestionId);
  if (index < 0) throw questionError('question_not_found');
  const questions = journal.questions.slice();
  questions[index] = record;
  return normalizeJournal({
    schemaVersion: journal.schemaVersion,
    revision: journal.revision + 1,
    questions,
  }, maxRecords);
}

function sameAnswers(left, right) {
  return sha256Json(left) === sha256Json(right);
}

module.exports = {
  JOURNAL_SCHEMA_VERSION,
  MAX_JOURNAL_RECORDS,
  MAX_QUESTIONS,
  MAX_OPTIONS,
  MAX_QUESTION_TEXT,
  MAX_OPTION_LABEL,
  MAX_FREE_TEXT,
  MAX_LATE_ANSWERS,
  createEmptyJournal,
  addQuestion,
  awayDefaultAnswers,
  canApplyAwayDefault,
  createQuestionRecord,
  denseArray,
  exactObject,
  isIdentifier,
  makeDeliveryIntent,
  normalizeAnswers,
  normalizeIdentity,
  normalizeJournal,
  normalizeQuestionRecord,
  normalizeQuestions,
  questionError,
  questionKey,
  replaceQuestion,
  sameAnswers,
  selectionFor,
  sha256Json,
};
