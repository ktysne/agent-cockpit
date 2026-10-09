'use strict';

const { assertIdentifier, captureExactRecord } = require('./reclamation-codec-primitives');
const { normalizeQuestionReclamationAnchorV1Local } = require('./question-reclamation-anchor-codec');

const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const OPTIONS_FIELDS = ['getAnchor', 'canWrite'];
const PROVIDER_NATIVE_ID_KINDS = new Map([['claude', 'session'], ['codex', 'thread']]);

function gateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function captureIdentity(value) {
  let identity;
  try { identity = captureExactRecord(value, IDENTITY_FIELDS, 'invalid_question_gate_identity'); } catch {
    throw gateError('invalid_question_gate_identity');
  }
  if (typeof identity.provider !== 'string' ||
      PROVIDER_NATIVE_ID_KINDS.get(identity.provider) !== identity.nativeIdKind) {
    throw gateError('invalid_question_gate_identity');
  }
  try {
    for (const field of IDENTITY_FIELDS.slice(2)) assertIdentifier(identity[field], 'invalid_question_gate_identity');
  } catch {
    throw gateError('invalid_question_gate_identity');
  }
  return Object.freeze(Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, identity[field]])));
}

function capturePeriodId(value) {
  try { return assertIdentifier(value, 'invalid_question_period_id'); } catch {
    throw gateError('invalid_question_period_id');
  }
}

function periodKey(identity, periodId) {
  return [...IDENTITY_FIELDS.map((field) => identity[field]), periodId]
    .map((value) => `${value.length}:${value}`)
    .join('');
}

function createQuestionPeriodGate(value) {
  const options = captureExactRecord(value, OPTIONS_FIELDS, 'invalid_question_period_gate');
  if (typeof options.getAnchor !== 'function' || typeof options.canWrite !== 'function') {
    throw gateError('invalid_question_period_gate');
  }

  const tokens = new WeakMap();
  const tickets = new WeakMap();
  const generations = new Map();
  const retiring = new Map();
  const retired = new Set();
  let blocked = false;

  function assertOpen() {
    if (blocked) throw gateError('question_gate_closed');
    let canWrite;
    try { canWrite = options.canWrite(); } catch {
      blocked = true;
      throw gateError('question_gate_closed');
    }
    if (canWrite !== true) throw gateError('question_gate_closed');
  }

  function currentAnchor() {
    let value;
    try { value = options.getAnchor(); } catch {
      blocked = true;
      throw gateError('question_gate_closed');
    }
    if (value === null || value === undefined) throw gateError('question_gate_closed');
    try {
      const anchor = normalizeQuestionReclamationAnchorV1Local(value);
      if (anchor.migration !== null) throw gateError('question_gate_closed');
      return anchor;
    } catch {
      blocked = true;
      throw gateError('question_gate_closed');
    }
  }

  function anchorContains(anchor, identity, periodId) {
    return anchor.retiredQuestionPeriods.some((item) => item.periodId === periodId &&
      IDENTITY_FIELDS.every((field) => item.identity[field] === identity[field]));
  }

  function isRetired(identityValue, periodIdValue) {
    const identity = captureIdentity(identityValue);
    capturePeriodId(periodIdValue);
    const key = periodKey(identity, periodIdValue);
    if (retired.has(key) || retiring.has(key)) return true;
    if (blocked) return true;
    try {
      assertOpen();
      const anchor = currentAnchor();
      if (!anchorContains(anchor, identity, periodIdValue)) return false;
      retired.add(key);
      return true;
    } catch {
      return true;
    }
  }

  function capture(identityValue, periodIdValue) {
    assertOpen();
    const identity = captureIdentity(identityValue);
    capturePeriodId(periodIdValue);
    const key = periodKey(identity, periodIdValue);
    if (retired.has(key) || retiring.has(key)) throw gateError('question_quarantined');
    const anchor = currentAnchor();
    if (anchorContains(anchor, identity, periodIdValue)) {
      retired.add(key);
      throw gateError('question_quarantined');
    }
    const token = Object.freeze(Object.create(null));
    tokens.set(token, Object.freeze({ key, identity, periodId: periodIdValue, generation: generations.get(key) || 0 }));
    return token;
  }

  function assertCurrent(token) {
    const data = token !== null && (typeof token === 'object' || typeof token === 'function') ? tokens.get(token) : null;
    if (!data) throw gateError('question_gate_closed');
    if (retired.has(data.key) || retiring.has(data.key) || data.generation !== (generations.get(data.key) || 0)) {
      throw gateError('question_quarantined');
    }
    assertOpen();
    const anchor = currentAnchor();
    if (anchorContains(anchor, data.identity, data.periodId)) {
      retired.add(data.key);
      throw gateError('question_quarantined');
    }
  }

  function beginRetirement(identityValue, periodIdValue) {
    assertOpen();
    const identity = captureIdentity(identityValue);
    capturePeriodId(periodIdValue);
    const key = periodKey(identity, periodIdValue);
    if (retired.has(key) || retiring.has(key)) throw gateError('question_quarantined');
    const anchor = currentAnchor();
    if (anchorContains(anchor, identity, periodIdValue)) {
      retired.add(key);
      throw gateError('question_quarantined');
    }
    const previousGeneration = generations.get(key) || 0;
    if (previousGeneration >= Number.MAX_SAFE_INTEGER) throw gateError('question_gate_closed');
    const generation = previousGeneration + 1;
    generations.set(key, generation);
    const ticket = Object.freeze(Object.create(null));
    tickets.set(ticket, Object.freeze({ key, identity, periodId: periodIdValue, generation }));
    retiring.set(key, ticket);
    return ticket;
  }

  function assertRetirement(ticket) {
    const data = ticket !== null && (typeof ticket === 'object' || typeof ticket === 'function')
      ? tickets.get(ticket) : null;
    if (!data || retiring.get(data.key) !== ticket || data.generation !== generations.get(data.key)) {
      throw gateError('question_quarantined');
    }
    assertOpen();
    return Object.freeze({ identity: captureIdentity(data.identity), periodId: data.periodId });
  }

  function finishRetirement(ticket) {
    const data = tickets.get(ticket);
    const target = assertRetirement(ticket);
    const anchor = currentAnchor();
    if (!anchorContains(anchor, target.identity, target.periodId)) {
      throw gateError('question_retirement_not_persisted');
    }
    retiring.delete(data.key);
    retired.add(data.key);
  }

  function snapshot() {
    return Object.freeze({
      open: !blocked && (() => { try { return options.canWrite() === true; } catch { return false; } })(),
      retiringCount: retiring.size,
      retiredCount: retired.size,
      blocked,
    });
  }

  return Object.freeze({ capture, assertCurrent, isRetired, beginRetirement, assertRetirement, finishRetirement, snapshot });
}

module.exports = { createQuestionPeriodGate };
