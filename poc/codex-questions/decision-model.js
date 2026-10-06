'use strict';

const { randomUUID } = require('node:crypto');

const DENIED_CATEGORIES = new Set(['permission', 'network_permission', 'app_approval']);
const QUESTION_MODES = new Set(['single', 'multi']);
const ANSWER_SOURCES = new Set(['dashboard', 'origin_ui']);
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL_PREFIX = /^\s*(?:bearer(?:\s+|:)|basic(?:\s+|:)|token(?:\s+|:)|sk-\S+|gh[pousr]_\S+|github_pat_\S+|xox[baprs]-\S+|ya29\.\S+|eyj[a-z0-9_-]+\.[a-z0-9_-]+|(?:api[_-]?key|access[_-]?token|secret)\s*[:=])/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.has(key));
}

function safeId(value) {
  return typeof value === 'string' && SAFE_ID.test(value) && !CREDENTIAL_PREFIX.test(value);
}

function validText(value, maxLength) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength && value.trim().length > 0;
}

function requestKey(hostId, homeScope, threadId, requestId) {
  return JSON.stringify([hostId, homeScope, threadId, requestId]);
}

function cloneAnswers(answers) {
  return answers.map((answer) => ({
    questionId: answer.questionId,
    optionIds: [...answer.optionIds],
    ...(answer.freeText === undefined ? {} : { freeText: answer.freeText }),
  }));
}

function normalizeQuestions(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return null;
  const questionIds = new Set();
  const questions = [];
  for (const input of value) {
    if (!hasOnlyKeys(input, new Set(['id', 'text', 'mode', 'options', 'allowFreeText', 'recommendedOptionId']))
      || !safeId(input.id) || questionIds.has(input.id)
      || !validText(input.text, 2000)
      || !QUESTION_MODES.has(input.mode)
      || typeof input.allowFreeText !== 'boolean'
      || !Array.isArray(input.options) || input.options.length > 6
      || (input.options.length === 0 && !input.allowFreeText)) return null;
    questionIds.add(input.id);
    const optionIds = new Set();
    const options = [];
    for (const option of input.options) {
      if (!hasOnlyKeys(option, new Set(['id', 'label']))
        || !safeId(option.id) || optionIds.has(option.id)
        || !validText(option.label, 200)) return null;
      optionIds.add(option.id);
      options.push({ id: option.id, label: option.label });
    }
    const recommendedOptionId = input.recommendedOptionId === undefined || input.recommendedOptionId === null
      ? null
      : input.recommendedOptionId;
    if (recommendedOptionId !== null && (!safeId(recommendedOptionId) || !optionIds.has(recommendedOptionId))) return null;
    questions.push({
      id: input.id,
      text: input.text,
      mode: input.mode,
      options,
      allowFreeText: input.allowFreeText,
      recommendedOptionId,
    });
  }
  return questions;
}

function normalizeAnswers(questions, value) {
  if (!Array.isArray(value) || value.length !== questions.length) return null;
  const answers = [];
  for (const [index, question] of questions.entries()) {
    const input = value[index];
    if (!hasOnlyKeys(input, new Set(['questionId', 'optionIds', 'freeText']))
      || input.questionId !== question.id
      || !Array.isArray(input.optionIds)
      || input.optionIds.length > question.options.length
      || (question.mode === 'single' && input.optionIds.length > 1)) return null;
    const selected = new Set();
    for (const optionId of input.optionIds) {
      if (!safeId(optionId) || selected.has(optionId) || !question.options.some((option) => option.id === optionId)) return null;
      selected.add(optionId);
    }
    if (input.freeText !== undefined
      && (!question.allowFreeText || !validText(input.freeText, 2000))) return null;
    if (selected.size === 0 && input.freeText === undefined) return null;
    answers.push({
      questionId: question.id,
      optionIds: [...input.optionIds],
      ...(input.freeText === undefined ? {} : { freeText: input.freeText }),
    });
  }
  return answers;
}

function recommendedAnswers(questions) {
  if (questions.some((question) => question.mode !== 'single' || !question.recommendedOptionId)) return null;
  return questions.map((question) => ({
    questionId: question.id,
    optionIds: [question.recommendedOptionId],
  }));
}

function copyAnswerRecord(answer) {
  return answer ? {
    ...answer,
    answers: cloneAnswers(answer.answers),
  } : null;
}

function rejected(reason) {
  return { accepted: false, reason };
}

class DecisionQuestionsBroker {
  constructor(options = {}) {
    if (!isRecord(options)
      || (options.now !== undefined && typeof options.now !== 'function')
      || (options.randomId !== undefined && typeof options.randomId !== 'function')
      || (options.awayEnabled !== undefined && typeof options.awayEnabled !== 'boolean')) {
      throw new TypeError('invalid broker options');
    }
    this.now = options.now || Date.now;
    this.randomId = options.randomId || randomUUID;
    this.awayEnabled = options.awayEnabled === true;
    this.requests = new Map();
    this.claimIds = new Set();
  }

  setAwayEnabled(enabled) {
    if (typeof enabled !== 'boolean') return rejected('invalid_away_state');
    this.awayEnabled = enabled;
    return { accepted: true, awayEnabled: this.awayEnabled };
  }

  register(input) {
    if (!isRecord(input)) return rejected('invalid_input');
    const allowed = new Set([
      'provenance', 'category', 'hostId', 'homeScope', 'threadId', 'requestId', 'timeoutMinutes', 'questions',
    ]);
    if (!hasOnlyKeys(input, allowed)) return rejected('invalid_input');
    if (input.provenance !== 'common_mcp') return rejected('unsupported_provenance');
    if (DENIED_CATEGORIES.has(input.category)) return rejected('permission_category');
    if (input.category !== 'ordinary') return rejected('unsupported_category');
    if (!safeId(input.hostId) || !safeId(input.homeScope) || !safeId(input.threadId) || !safeId(input.requestId)
      || !Number.isInteger(input.timeoutMinutes) || input.timeoutMinutes < 1 || input.timeoutMinutes > 30) {
      return rejected('invalid_input');
    }
    const questions = normalizeQuestions(input.questions);
    if (!questions) return rejected('invalid_questions');
    const config = {
      provenance: input.provenance,
      category: input.category,
      hostId: input.hostId,
      homeScope: input.homeScope,
      threadId: input.threadId,
      requestId: input.requestId,
      timeoutMinutes: input.timeoutMinutes,
      questions,
    };
    const key = requestKey(input.hostId, input.homeScope, input.threadId, input.requestId);
    const fingerprint = JSON.stringify(config);
    const existing = this.requests.get(key);
    if (existing) {
      if (existing.registrationFingerprint !== fingerprint) return rejected('request_conflict');
      return { accepted: true, reason: 'duplicate_registration', request: this.snapshot(existing) };
    }
    const createdAt = this.readTime();
    if (createdAt === null) return rejected('invalid_clock');
    const deadlineAt = createdAt + input.timeoutMinutes * 60_000;
    if (!Number.isSafeInteger(deadlineAt)) return rejected('invalid_clock');
    const request = {
      key,
      registrationFingerprint: fingerprint,
      hostId: input.hostId,
      homeScope: input.homeScope,
      threadId: input.threadId,
      requestId: input.requestId,
      provenance: input.provenance,
      category: input.category,
      timeoutMinutes: input.timeoutMinutes,
      questions,
      createdAt,
      deadlineAt,
      awayAtRegistration: this.awayEnabled,
      deadlineEvaluated: false,
      held: false,
      heldAt: null,
      state: 'pending',
      chosen: null,
      applied: null,
      lateAnswer: null,
      externalResolution: null,
      externalEventIds: new Set(),
      submissionIds: new Map(),
      holdIds: new Set(),
      cancelIds: new Set(),
      delivery: { state: 'none', deliveryId: null, claimId: null, claimedAt: null, acknowledgedAt: null },
      version: 1,
    };
    this.requests.set(key, request);
    return { accepted: true, reason: 'registered', request: this.snapshot(request, createdAt) };
  }

  poll(input) {
    const request = this.findRequest(input, new Set(['hostId', 'homeScope', 'threadId', 'requestId']));
    if (!request) return { found: false, reason: 'not_found' };
    const now = this.readTime();
    if (now === null) return { found: false, reason: 'invalid_clock' };
    this.applyExpiry(request, now);
    return { found: true, request: this.snapshot(request, now) };
  }

  tick() {
    const now = this.readTime();
    if (now === null) return { processed: false, reason: 'invalid_clock', appliedCount: 0 };
    let appliedCount = 0;
    for (const request of this.requests.values()) {
      if (this.applyExpiry(request, now)) appliedCount += 1;
    }
    return { processed: true, appliedCount };
  }

  submitAnswer(input) {
    if (!isRecord(input) || !hasOnlyKeys(input, new Set([
      'hostId', 'homeScope', 'threadId', 'requestId', 'source', 'submissionId', 'answers',
    ]))) return rejected('invalid_input');
    if (!safeId(input.hostId) || !safeId(input.homeScope) || !safeId(input.threadId) || !safeId(input.requestId)
      || !ANSWER_SOURCES.has(input.source) || !safeId(input.submissionId)) return rejected('invalid_input');
    const request = this.requests.get(requestKey(input.hostId, input.homeScope, input.threadId, input.requestId));
    if (!request) return rejected('not_found');
    const answers = normalizeAnswers(request.questions, input.answers);
    if (!answers) return rejected('invalid_answer');
    const fingerprint = JSON.stringify({ source: input.source, answers });
    if (request.submissionIds.has(input.submissionId)) {
      return rejected(request.submissionIds.get(input.submissionId) === fingerprint
        ? 'duplicate_submission' : 'submission_id_conflict');
    }
    const now = this.readTime();
    if (now === null) return rejected('invalid_clock');
    if (request.state === 'cancelled' || request.state === 'external_resolved') return rejected('terminal_request');
    this.applyExpiry(request, now);
    if (request.state === 'provisional') {
      if (request.lateAnswer) return rejected('late_answer_already_recorded');
      request.lateAnswer = { submissionId: input.submissionId, source: input.source, receivedAt: now, answers };
      request.submissionIds.set(input.submissionId, fingerprint);
      request.version += 1;
      return { accepted: true, reason: 'late_answer_recorded', applied: false, request: this.snapshot(request, now) };
    }
    if (request.state !== 'pending') return rejected('answer_already_set');
    request.chosen = { submissionId: input.submissionId, source: input.source, submittedAt: now, answers };
    request.applied = { kind: 'chosen', appliedAt: now, answers: cloneAnswers(answers) };
    request.state = 'chosen';
    request.delivery.state = 'available';
    request.submissionIds.set(input.submissionId, fingerprint);
    request.version += 1;
    return { accepted: true, reason: 'chosen', applied: true, request: this.snapshot(request, now) };
  }

  hold(input) {
    if (!isRecord(input) || !hasOnlyKeys(input, new Set([
      'hostId', 'homeScope', 'threadId', 'requestId', 'source', 'operationId',
    ]))) return rejected('invalid_input');
    if (!safeId(input.hostId) || !safeId(input.homeScope) || !safeId(input.threadId) || !safeId(input.requestId)
      || !ANSWER_SOURCES.has(input.source) || !safeId(input.operationId)) return rejected('invalid_input');
    const request = this.requests.get(requestKey(input.hostId, input.homeScope, input.threadId, input.requestId));
    if (!request) return rejected('not_found');
    if (request.state !== 'pending') return rejected('terminal_request');
    if (request.holdIds.has(input.operationId)) return rejected('duplicate_operation');
    const now = this.readTime();
    if (now === null) return rejected('invalid_clock');
    request.holdIds.add(input.operationId);
    if (!request.held) {
      request.held = true;
      request.heldAt = now;
      request.version += 1;
    }
    return { accepted: true, reason: 'held', request: this.snapshot(request) };
  }

  cancel(input) {
    if (!isRecord(input) || !hasOnlyKeys(input, new Set([
      'hostId', 'homeScope', 'threadId', 'requestId', 'source', 'operationId',
    ]))) return rejected('invalid_input');
    if (!safeId(input.hostId) || !safeId(input.homeScope) || !safeId(input.threadId) || !safeId(input.requestId)
      || !ANSWER_SOURCES.has(input.source) || !safeId(input.operationId)) return rejected('invalid_input');
    const request = this.requests.get(requestKey(input.hostId, input.homeScope, input.threadId, input.requestId));
    if (!request) return rejected('not_found');
    if (request.state !== 'pending') return rejected('terminal_request');
    if (request.cancelIds.has(input.operationId)) return rejected('duplicate_operation');
    const now = this.readTime();
    if (now === null) return rejected('invalid_clock');
    request.cancelIds.add(input.operationId);
    request.state = 'cancelled';
    request.cancelledAt = now;
    request.version += 1;
    return { accepted: true, reason: 'cancelled', request: this.snapshot(request, now) };
  }

  observeExternalResolved(input) {
    if (!isRecord(input) || !hasOnlyKeys(input, new Set([
      'hostId', 'homeScope', 'threadId', 'requestId', 'eventId',
    ]))) return rejected('invalid_input');
    if (!safeId(input.hostId) || !safeId(input.homeScope) || !safeId(input.threadId)
      || !safeId(input.requestId) || !safeId(input.eventId)) return rejected('invalid_input');
    const request = this.requests.get(requestKey(input.hostId, input.homeScope, input.threadId, input.requestId));
    if (!request) return rejected('not_found');
    if (request.externalEventIds.has(input.eventId)) return rejected('duplicate_event');
    if (request.state === 'cancelled') return rejected('terminal_request');
    const now = this.readTime();
    if (now === null) return rejected('invalid_clock');
    request.externalEventIds.add(input.eventId);
    if (request.state !== 'external_resolved') {
      request.state = 'external_resolved';
      request.externalResolution = { eventId: input.eventId, observedAt: now };
      if (request.delivery.state === 'available' || request.delivery.state === 'claimed') {
        request.delivery.state = 'invalidated';
      }
      request.version += 1;
    }
    return { accepted: true, reason: 'external_resolved', request: this.snapshot(request, now) };
  }

  claimDelivery(input) {
    if (!isRecord(input) || !hasOnlyKeys(input, new Set([
      'hostId', 'homeScope', 'threadId', 'requestId', 'deliveryId',
    ]))) return rejected('invalid_input');
    if (!safeId(input.hostId) || !safeId(input.homeScope) || !safeId(input.threadId)
      || !safeId(input.requestId) || !safeId(input.deliveryId)) return rejected('invalid_input');
    const request = this.requests.get(requestKey(input.hostId, input.homeScope, input.threadId, input.requestId));
    if (!request) return rejected('not_found');
    const now = this.readTime();
    if (now === null) return rejected('invalid_clock');
    this.applyExpiry(request, now);
    if (!['chosen', 'provisional'].includes(request.state) || request.delivery.state !== 'available') {
      return rejected('delivery_unavailable');
    }
    const claimId = this.randomId();
    if (!safeId(claimId) || this.claimIds.has(claimId)) return rejected('claim_id_conflict');
    this.claimIds.add(claimId);
    request.delivery = {
      state: 'claimed',
      deliveryId: input.deliveryId,
      claimId,
      claimedAt: now,
      acknowledgedAt: null,
    };
    request.version += 1;
    return {
      accepted: true,
      reason: 'claimed',
      delivery: {
        hostId: request.hostId,
        homeScope: request.homeScope,
        threadId: request.threadId,
        requestId: request.requestId,
        deliveryId: input.deliveryId,
        claimId,
        kind: request.applied.kind,
        answers: cloneAnswers(request.applied.answers),
      },
    };
  }

  acknowledgeDelivery(input) {
    if (!isRecord(input) || !hasOnlyKeys(input, new Set([
      'hostId', 'homeScope', 'threadId', 'requestId', 'deliveryId', 'claimId',
    ]))) return rejected('invalid_input');
    if (!safeId(input.hostId) || !safeId(input.homeScope) || !safeId(input.threadId)
      || !safeId(input.requestId) || !safeId(input.deliveryId) || !safeId(input.claimId)) return rejected('invalid_input');
    const request = this.requests.get(requestKey(input.hostId, input.homeScope, input.threadId, input.requestId));
    if (!request) return rejected('not_found');
    if (request.delivery.state !== 'claimed' || request.delivery.deliveryId !== input.deliveryId
      || request.delivery.claimId !== input.claimId || request.state === 'external_resolved'
      || request.state === 'cancelled') return rejected('claim_not_active');
    const now = this.readTime();
    if (now === null) return rejected('invalid_clock');
    request.delivery.state = 'acknowledged';
    request.delivery.acknowledgedAt = now;
    request.version += 1;
    return { accepted: true, reason: 'acknowledged', request: this.snapshot(request, now) };
  }

  project() {
    const now = this.readTime();
    const rows = [...this.requests.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((request) => this.snapshot(request, now));
    return {
      counts: {
        total: rows.length,
        pending: rows.filter((row) => row.state === 'pending').length,
        chosen: rows.filter((row) => row.state === 'chosen').length,
        provisional: rows.filter((row) => row.state === 'provisional').length,
        cancelled: rows.filter((row) => row.state === 'cancelled').length,
        external_resolved: rows.filter((row) => row.state === 'external_resolved').length,
        held: rows.filter((row) => row.held).length,
      },
      rows,
    };
  }

  findRequest(input, allowed) {
    if (!hasOnlyKeys(input, allowed)
      || !safeId(input.hostId) || !safeId(input.homeScope)
      || !safeId(input.threadId) || !safeId(input.requestId)) return null;
    return this.requests.get(requestKey(input.hostId, input.homeScope, input.threadId, input.requestId)) || null;
  }

  readTime() {
    const value = this.now();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  applyExpiry(request, now) {
    if (request.state !== 'pending' || !this.awayEnabled || now < request.deadlineAt) return false;
    if (request.deadlineEvaluated) return false;
    request.deadlineEvaluated = true;
    const answers = recommendedAnswers(request.questions);
    if (answers) {
      request.state = 'provisional';
      request.applied = { kind: 'provisional', appliedAt: now, answers: cloneAnswers(answers) };
      request.delivery.state = 'available';
    }
    request.version += 1;
    return request.state === 'provisional';
  }

  snapshot(request, now = this.readTime()) {
    return {
      hostId: request.hostId,
      homeScope: request.homeScope,
      threadId: request.threadId,
      requestId: request.requestId,
      provenance: request.provenance,
      category: request.category,
      state: request.state,
      createdAt: request.createdAt,
      deadlineAt: request.deadlineAt,
      timeoutMinutes: request.timeoutMinutes,
      deadlineReached: now === null ? null : now >= request.deadlineAt,
      deadlineEvaluated: request.deadlineEvaluated,
      awayAtRegistration: request.awayAtRegistration,
      currentAway: this.awayEnabled,
      questions: request.questions.map((question) => ({
        ...question,
        options: question.options.map((option) => ({ ...option })),
      })),
      held: request.held,
      heldAt: request.heldAt,
      chosen: copyAnswerRecord(request.chosen),
      applied: copyAnswerRecord(request.applied),
      lateAnswer: copyAnswerRecord(request.lateAnswer),
      externalResolution: request.externalResolution ? { ...request.externalResolution } : null,
      deliveryState: request.delivery.state,
      version: request.version,
    };
  }
}

module.exports = { DecisionQuestionsBroker };
