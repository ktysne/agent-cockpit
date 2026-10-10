'use strict';

const { types } = require('node:util');
const {
  assertIdentifier,
  captureDenseArray,
  captureExactRecord,
} = require('./reclamation-codec-primitives');

const MAX_RECLAMATION_SCHEDULER_INTERVAL_MS = 2_147_483_647;
const MAX_RECLAMATION_SCHEDULER_OPERATIONS_PER_PASS = 100;
const MAX_CANDIDATES = 100_000;
const INVALID_OPTIONS = 'invalid_reclamation_scheduler_options';
const INVALID_CANDIDATES = 'invalid_reclamation_scheduler_candidates';
const INVALID_RESULT = 'invalid_reclamation_scheduler_result';
const FAILURE_FALLBACK = 'reclamation_scheduler_failed';
const ERROR_CODE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;
const IDENTITY_FIELDS = Object.freeze([
  'provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId',
]);
const BODY_FIELDS_BY_KIND = Object.freeze({
  'question-period': Object.freeze(['kind', 'identity', 'periodId']),
  instruction: Object.freeze(['kind', 'deliveryAttemptId']),
  'terminal-delivery': Object.freeze(['kind', 'deliveryAttemptId']),
});
const SLOT_ORDER = Object.freeze(['checkpoint', 'instructions', 'questions']);
const OPERATION_ORDER = Object.freeze([
  'question-period', 'instruction', 'terminal-delivery',
  'grant:checkpoint', 'grant:instructions', 'grant:questions',
]);
const DEFAULT_SET_TIMEOUT = globalThis.setTimeout;
const DEFAULT_CLEAR_TIMEOUT = globalThis.clearTimeout;

function schedulerError(code) {
  const error = new TypeError(code);
  error.code = code;
  return error;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function captureRecord(value, fields, code) {
  if (!isPlainRecord(value)) throw schedulerError(code);
  try {
    return captureExactRecord(value, fields, code);
  } catch {
    throw schedulerError(code);
  }
}

function captureOptions(value) {
  if (!isPlainRecord(value)) throw schedulerError(INVALID_OPTIONS);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { throw schedulerError(INVALID_OPTIONS); }
  const required = ['listCandidates', 'reclaimCandidate', 'releaseGrants', 'intervalMs', 'maxOperationsPerPass'];
  const optional = ['setTimeoutImpl', 'clearTimeoutImpl'];
  const allowed = new Set([...required, ...optional]);
  if (keys.length < required.length || keys.some((key) => typeof key !== 'string' || !allowed.has(key)) ||
      required.some((field) => !keys.includes(field))) {
    throw schedulerError(INVALID_OPTIONS);
  }
  const fields = [...required, ...optional.filter((field) => keys.includes(field))];
  const input = captureRecord(value, fields, INVALID_OPTIONS);
  if (typeof input.listCandidates !== 'function' || typeof input.reclaimCandidate !== 'function' ||
      typeof input.releaseGrants !== 'function' ||
      !Number.isSafeInteger(input.intervalMs) || input.intervalMs < 1 ||
      input.intervalMs > MAX_RECLAMATION_SCHEDULER_INTERVAL_MS ||
      !Number.isSafeInteger(input.maxOperationsPerPass) || input.maxOperationsPerPass < 1 ||
      input.maxOperationsPerPass > MAX_RECLAMATION_SCHEDULER_OPERATIONS_PER_PASS) {
    throw schedulerError(INVALID_OPTIONS);
  }
  const hasSetTimeout = keys.includes('setTimeoutImpl');
  const hasClearTimeout = keys.includes('clearTimeoutImpl');
  if (hasSetTimeout !== hasClearTimeout ||
      (hasSetTimeout && (typeof input.setTimeoutImpl !== 'function' ||
        typeof input.clearTimeoutImpl !== 'function'))) {
    throw schedulerError(INVALID_OPTIONS);
  }
  return {
    listCandidates: input.listCandidates,
    reclaimCandidate: input.reclaimCandidate,
    releaseGrants: input.releaseGrants,
    intervalMs: input.intervalMs,
    maxOperationsPerPass: input.maxOperationsPerPass,
    setTimeoutImpl: hasSetTimeout ? input.setTimeoutImpl : DEFAULT_SET_TIMEOUT,
    clearTimeoutImpl: hasClearTimeout ? input.clearTimeoutImpl : DEFAULT_CLEAR_TIMEOUT,
  };
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareParts(left, right) {
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const compared = compareText(left[index], right[index]);
    if (compared !== 0) return compared;
  }
  return left.length - right.length;
}

function operationOrder(kind) {
  return OPERATION_ORDER.indexOf(kind);
}

function compareOperationKeys(left, right) {
  const category = operationOrder(left.category) - operationOrder(right.category);
  return category || compareParts(left.parts, right.parts);
}

function captureIdentity(value) {
  const identity = captureRecord(value, IDENTITY_FIELDS, INVALID_CANDIDATES);
  if (!['claude', 'codex'].includes(identity.provider) ||
      (identity.provider === 'claude' && identity.nativeIdKind !== 'session') ||
      (identity.provider === 'codex' && identity.nativeIdKind !== 'thread')) {
    throw schedulerError(INVALID_CANDIDATES);
  }
  for (const field of IDENTITY_FIELDS) assertCandidateIdentifier(identity[field]);
  return Object.freeze(Object.assign(Object.create(null), identity));
}

function assertCandidateIdentifier(value) {
  try { assertIdentifier(value, INVALID_CANDIDATES); } catch { throw schedulerError(INVALID_CANDIDATES); }
}

function captureBodyCandidate(value) {
  if (!isPlainRecord(value)) throw schedulerError(INVALID_CANDIDATES);
  let kindDescriptor;
  try { kindDescriptor = Object.getOwnPropertyDescriptor(value, 'kind'); } catch {
    throw schedulerError(INVALID_CANDIDATES);
  }
  if (!kindDescriptor || !Object.hasOwn(kindDescriptor, 'value') || !kindDescriptor.enumerable ||
      typeof kindDescriptor.value !== 'string' ||
      !Object.hasOwn(BODY_FIELDS_BY_KIND, kindDescriptor.value)) {
    throw schedulerError(INVALID_CANDIDATES);
  }
  const kind = kindDescriptor.value;
  const candidate = captureRecord(value, BODY_FIELDS_BY_KIND[kind], INVALID_CANDIDATES);
  if (kind === 'question-period') {
    assertCandidateIdentifier(candidate.periodId);
    const identity = captureIdentity(candidate.identity);
    return Object.freeze(Object.assign(Object.create(null), { kind, identity, periodId: candidate.periodId }));
  }
  assertCandidateIdentifier(candidate.deliveryAttemptId);
  return Object.freeze(Object.assign(Object.create(null), { kind, deliveryAttemptId: candidate.deliveryAttemptId }));
}

function captureCandidateSnapshot(value) {
  const input = captureRecord(value, ['state', 'bodyCandidates', 'grantSlots'], INVALID_CANDIDATES);
  if (!['ready', 'degraded', 'unavailable'].includes(input.state) ||
      !Array.isArray(input.bodyCandidates) || types.isProxy(input.bodyCandidates) ||
      !Array.isArray(input.grantSlots) || types.isProxy(input.grantSlots)) {
    throw schedulerError(INVALID_CANDIDATES);
  }
  let rawBodies;
  let rawSlots;
  try {
    rawBodies = captureDenseArray(input.bodyCandidates, MAX_CANDIDATES, INVALID_CANDIDATES);
    rawSlots = captureDenseArray(input.grantSlots, SLOT_ORDER.length, INVALID_CANDIDATES);
  } catch {
    throw schedulerError(INVALID_CANDIDATES);
  }
  const bodyCandidates = rawBodies.map(captureBodyCandidate);
  const grantSlots = rawSlots.map((slot) => {
    if (typeof slot !== 'string' || !SLOT_ORDER.includes(slot)) throw schedulerError(INVALID_CANDIDATES);
    return slot;
  });
  if (new Set(grantSlots).size !== grantSlots.length ||
      (input.state !== 'ready' && (grantSlots.length !== 0 ||
        bodyCandidates.some((candidate) => candidate.kind === 'question-period'))) ||
      (input.state === 'unavailable' && bodyCandidates.length !== 0)) {
    throw schedulerError(INVALID_CANDIDATES);
  }
  const operations = [
    ...bodyCandidates.map((candidate) => operationForBody(candidate)),
    ...grantSlots.map((slot) => operationForGrant(slot)),
  ].sort(compareOperationKeys);
  for (let index = 1; index < operations.length; index += 1) {
    if (compareOperationKeys(operations[index - 1], operations[index]) === 0) {
      throw schedulerError(INVALID_CANDIDATES);
    }
  }
  return Object.freeze({
    state: input.state,
    bodyCandidates: Object.freeze(bodyCandidates),
    grantSlots: Object.freeze(grantSlots),
    operations: Object.freeze(operations),
  });
}

function operationForBody(candidate) {
  const kind = candidate.kind;
  const parts = kind === 'question-period'
    ? IDENTITY_FIELDS.map((field) => candidate.identity[field]).concat(candidate.periodId)
    : [candidate.deliveryAttemptId];
  return Object.freeze({
    type: 'body',
    category: kind,
    parts: Object.freeze(parts),
    candidate,
  });
}

function operationForGrant(slot) {
  return Object.freeze({
    type: 'grant',
    category: `grant:${slot}`,
    parts: Object.freeze([slot]),
    slot,
  });
}

function operationStillListed(snapshot, operation) {
  if (operation.type === 'grant') return snapshot.grantSlots.includes(operation.slot);
  return snapshot.operations.some((candidate) => compareOperationKeys(candidate, operation) === 0);
}

function captureOperationStatus(value, operation) {
  const result = captureRecord(value, ['status'], INVALID_RESULT);
  const allowed = operation.type === 'body'
    ? ['complete', 'deferred', 'skipped']
    : ['released', 'retained', 'already_clear', 'skipped'];
  if (!allowed.includes(result.status)) throw schedulerError(INVALID_RESULT);
  return result.status;
}

function diagnosticCode(error) {
  if (error === null || (typeof error !== 'object' && typeof error !== 'function') || types.isProxy(error)) {
    return FAILURE_FALLBACK;
  }
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'code');
    return descriptor && Object.hasOwn(descriptor, 'value') &&
      typeof descriptor.value === 'string' && ERROR_CODE.test(descriptor.value)
      ? descriptor.value
      : FAILURE_FALLBACK;
  } catch {
    return FAILURE_FALLBACK;
  }
}

function createReclamationScheduler(inputValue) {
  const input = captureOptions(inputValue);
  const {
    listCandidates,
    reclaimCandidate,
    releaseGrants,
    intervalMs,
    maxOperationsPerPass,
    setTimeoutImpl,
    clearTimeoutImpl,
  } = input;
  let started = false;
  let stopped = false;
  let explicitlyStopped = false;
  let stopReason = null;
  let timerRecord = null;
  let activePass = null;
  let cursor = null;
  let passCount = 0;
  let lastPassOperationCount = 0;
  let lastFailureCode = null;
  let failureCount = 0;

  function clearTimer() {
    const pending = timerRecord;
    if (pending === null) return;
    timerRecord = null;
    pending.cancelled = true;
    try { clearTimeoutImpl(pending.handle); } catch (error) { recordFailure(error); }
  }

  function recordFailure(error) {
    if (failureCount === 0) {
      lastFailureCode = diagnosticCode(error);
      failureCount += 1;
    }
    stopped = true;
    stopReason = 'failure';
    const pending = timerRecord;
    if (pending !== null) {
      timerRecord = null;
      pending.cancelled = true;
      try { clearTimeoutImpl(pending.handle); } catch {}
    }
  }

  function stopUnavailable() {
    stopped = true;
    stopReason = 'unavailable';
    clearTimer();
  }

  function readCandidates() {
    const value = listCandidates();
    if (types.isPromise(value)) {
      try { Promise.prototype.then.call(value, undefined, () => {}); } catch {}
      throw schedulerError(INVALID_CANDIDATES);
    }
    return captureCandidateSnapshot(value);
  }

  function timerCallback(record) {
    if (record.cancelled || stopped) return Promise.resolve();
    if (record.fired) return activePass ?? Promise.resolve();
    if (timerRecord !== record) return Promise.resolve();
    record.fired = true;
    timerRecord = null;
    return beginPass();
  }

  function scheduleNext(delay, propagateFailure = false) {
    if (stopped || !started || timerRecord !== null || activePass !== null) return true;
    const record = { handle: undefined, fired: false, cancelled: false };
    timerRecord = record;
    try {
      record.handle = setTimeoutImpl(() => timerCallback(record), delay);
      if (record.handle === null || record.handle === undefined) throw schedulerError('reclamation_scheduler_timer_failed');
      if (!record.fired && record.handle && typeof record.handle.unref === 'function') record.handle.unref();
      return true;
    } catch (error) {
      if (record.handle !== undefined && record.handle !== null) {
        try { clearTimeoutImpl(record.handle); } catch {}
      }
      if (timerRecord === record) timerRecord = null;
      record.cancelled = true;
      recordFailure(error);
      if (propagateFailure) throw error;
      return false;
    }
  }

  async function runPassBody() {
    const initial = readCandidates();
    if (stopped) return;
    if (initial.state === 'unavailable') {
      stopUnavailable();
      return;
    }
    const operations = initial.operations;
    if (operations.length === 0) return;
    let latestCandidateCheckCount = 0;
    let degradedSeen = initial.state === 'degraded';
    const startIndex = cursor === null
      ? 0
      : Math.max(0, operations.findIndex((operation) => compareOperationKeys(operation, cursor) > 0));
    const offset = cursor !== null && startIndex === 0 &&
      compareOperationKeys(operations[0], cursor) <= 0 ? 0 : startIndex;
    const ordered = operations.map((_, index) => operations[(offset + index) % operations.length]);

    for (const operation of ordered) {
      if (stopped || lastPassOperationCount >= maxOperationsPerPass) return;
      const isQuestionOrGrant = operation.type === 'grant' || operation.category === 'question-period';
      if (degradedSeen && isQuestionOrGrant) {
        cursor = operation;
        continue;
      }
      if (latestCandidateCheckCount >= maxOperationsPerPass) return;
      latestCandidateCheckCount += 1;
      const current = readCandidates();
      if (stopped) return;
      if (current.state === 'unavailable') {
        stopUnavailable();
        return;
      }
      if (current.state === 'degraded') degradedSeen = true;
      if (degradedSeen && isQuestionOrGrant) {
        cursor = operation;
        continue;
      }
      if (!operationStillListed(current, operation)) {
        cursor = operation;
        continue;
      }

      cursor = operation;
      lastPassOperationCount += 1;
      let result;
      try {
        result = operation.type === 'body'
          ? await reclaimCandidate(operation.candidate)
          : await releaseGrants(operation.slot);
      } catch (error) {
        if (explicitlyStopped) return;
        throw error;
      }
      captureOperationStatus(result, operation);
      if (stopped) return;
    }
  }

  function beginPass() {
    if (stopped) return Promise.resolve();
    if (activePass !== null) return activePass;
    passCount += 1;
    lastPassOperationCount = 0;
    const pass = Promise.resolve()
      .then(runPassBody)
      .catch((error) => { recordFailure(error); })
      .then(() => {
        activePass = null;
        if (stopped) return;
        scheduleNext(intervalMs);
      });
    activePass = pass;
    return pass;
  }

  function start() {
    if (started || stopped) return;
    started = true;
    scheduleNext(intervalMs, true);
  }

  function stop() {
    if (explicitlyStopped) return;
    explicitlyStopped = true;
    stopped = true;
    if (stopReason === null) stopReason = 'explicit';
    clearTimer();
  }

  function drain() {
    return activePass ?? Promise.resolve();
  }

  function status() {
    return Object.freeze({
      state: stopped ? 'stopped' : activePass !== null ? 'running' : timerRecord !== null ? 'scheduled' : 'idle',
      started,
      stopped,
      running: activePass !== null,
      timerPending: timerRecord !== null,
      stopReason,
      passCount,
      lastPassOperationCount,
      failureCount,
      lastFailureCode,
    });
  }

  return Object.freeze({ start, stop, drain, status });
}

module.exports = {
  MAX_RECLAMATION_SCHEDULER_INTERVAL_MS,
  MAX_RECLAMATION_SCHEDULER_OPERATIONS_PER_PASS,
  createReclamationScheduler,
};
