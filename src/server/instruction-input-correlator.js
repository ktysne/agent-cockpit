'use strict';

const { types: utilTypes } = require('node:util');

const {
  digestNativeInstructionInput,
  instructionError,
  isIdentifier,
  isSha256Digest,
} = require('./instruction-envelope');
const { sourceProjectionFromDelivery } = require('./instruction-delivery-journal');

const MAX_PENDING = 128;
const MAX_BUFFER_BYTES = 256 * 1024;
const DEFAULT_TTL_MS = 60_000;
const FINISHED_RETENTION_MS = 60_000;
const MAX_DIAGNOSTICS = 128;

function correlatorError(code) {
  const error = instructionError(code);
  error.message = 'instruction input evidence rejected';
  return error;
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactObject(value, fields, code = 'invalid_instruction_evidence') {
  if (!isRecord(value)) throw correlatorError(code);
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw correlatorError(code);
  }
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
    throw correlatorError(code);
  }
  const result = {};
  for (const field of fields) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      throw correlatorError(code);
    }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw correlatorError(code);
    }
    result[field] = descriptor.value;
  }
  return result;
}

function normalizeTarget(value) {
  const target = exactObject(value, [
    'kind', 'launchRef', 'claims', 'identity', 'periodId', 'actor', 'conversationId', 'sessionId',
  ], 'invalid_instruction_evidence_target');
  if (target.kind !== 'execution' || !isIdentifier(target.launchRef) ||
      !isIdentifier(target.periodId) || !isIdentifier(target.conversationId) ||
      !isIdentifier(target.sessionId)) throw correlatorError('invalid_instruction_evidence_target');
  const source = sourceProjectionFromDelivery({
    source: {
      launchRef: target.launchRef,
      claims: target.claims,
      identity: target.identity,
      executionBinding: { periodId: target.periodId, actor: target.actor },
      conversationId: target.conversationId,
      sessionId: target.sessionId,
    },
  });
  return {
    kind: 'execution',
    launchRef: source.launchRef,
    claims: source.claims,
    identity: source.identity,
    periodId: source.executionBinding.periodId,
    actor: source.executionBinding.actor,
    conversationId: source.conversationId,
    sessionId: source.sessionId,
  };
}

function normalizeEvidence(value) {
  const evidence = exactObject(value, [
    'source', 'target', 'clientRequestId', 'nativeTurnId', 'nativeItemId', 'input',
  ]);
  const source = sourceProjectionFromDelivery({ source: evidence.source });
  const target = normalizeTarget(evidence.target);
  if (!isIdentifier(evidence.clientRequestId) || !isIdentifier(evidence.nativeTurnId) ||
      !isIdentifier(evidence.nativeItemId)) throw correlatorError('invalid_instruction_evidence');
  const digest = digestNativeInstructionInput(evidence.input);
  const normalized = {
    source,
    target,
    clientRequestId: evidence.clientRequestId,
    nativeTurnId: evidence.nativeTurnId,
    nativeItemId: evidence.nativeItemId,
    nativeContentDigest: digest.nativeContentDigest,
  };
  return {
    value: normalized,
    inputBytes: digest.sizeBytes,
    bufferedBytes: Buffer.byteLength(JSON.stringify(normalized), 'utf8') + digest.sizeBytes,
  };
}

function normalizeRegistration(value) {
  const input = exactObject(value, [
    'deliveryAttemptId', 'source', 'target', 'revision', 'payloadDigest', 'nativeContentDigest',
    'mode', 'expectedTurnId',
  ], 'invalid_instruction_correlation');
  if (!isIdentifier(input.deliveryAttemptId) || !Number.isSafeInteger(input.revision) || input.revision < 0 ||
      !isSha256Digest(input.payloadDigest) || !isSha256Digest(input.nativeContentDigest) ||
      !['steer', 'start', 'next-user-input'].includes(input.mode) ||
      (input.mode === 'steer' ? !isIdentifier(input.expectedTurnId) : input.expectedTurnId !== null)) {
    throw correlatorError('invalid_instruction_correlation');
  }
  const source = sourceProjectionFromDelivery({ source: input.source });
  const target = normalizeTarget(input.target);
  if (source.launchRef !== target.launchRef ||
      source.executionBinding.periodId !== target.periodId ||
      JSON.stringify(source.identity) !== JSON.stringify(target.identity) ||
      JSON.stringify(source.claims) !== JSON.stringify(target.claims)) {
    throw correlatorError('instruction_target_mismatch');
  }
  return {
    deliveryAttemptId: input.deliveryAttemptId,
    source,
    target,
    revision: input.revision,
    payloadDigest: input.payloadDigest,
    nativeContentDigest: input.nativeContentDigest,
    mode: input.mode,
    expectedTurnId: input.expectedTurnId,
  };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createInstructionInputCorrelator(options = {}) {
  if (!isRecord(options) ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      (options.setTimeoutImpl !== undefined && typeof options.setTimeoutImpl !== 'function') ||
      (options.clearTimeoutImpl !== undefined && typeof options.clearTimeoutImpl !== 'function') ||
      typeof options.onApplied !== 'function' ||
      typeof options.onUnknown !== 'function' ||
      (options.onDiagnostic !== undefined && typeof options.onDiagnostic !== 'function') ||
      (options.onFinished !== undefined && typeof options.onFinished !== 'function')) {
    throw correlatorError('invalid_instruction_correlator_options');
  }
  const now = options.now || Date.now;
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
  const pending = new Map();
  const finished = new Map();
  const diagnostics = new Map();
  let bufferedBytes = 0;
  let closed = false;

  function nowValue() {
    let value;
    try { value = now(); } catch { throw correlatorError('instruction_clock_unavailable'); }
    if (!Number.isSafeInteger(value) || value < 0) throw correlatorError('instruction_clock_unavailable');
    return value;
  }

  function clearTimer(entry) {
    if (entry.timer !== null) {
      clearTimeoutImpl(entry.timer);
      entry.timer = null;
    }
  }

  function evictFinished(currentTime) {
    for (const [id, entry] of finished) {
      if (entry.expiresAt <= currentTime) finished.delete(id);
    }
    while (finished.size >= MAX_PENDING) {
      finished.delete(finished.keys().next().value);
    }
  }

  function recordDiagnostic(id, reason) {
    const currentTime = nowValue();
    for (const [key, value] of diagnostics) {
      if (value.expiresAt <= currentTime) diagnostics.delete(key);
    }
    const diagnosticKey = id + ':' + reason;
    diagnostics.delete(diagnosticKey);
    diagnostics.set(diagnosticKey, {
      deliveryAttemptId: id,
      code: reason,
      observedAt: currentTime,
      expiresAt: currentTime + FINISHED_RETENTION_MS,
    });
    while (diagnostics.size > MAX_DIAGNOSTICS) diagnostics.delete(diagnostics.keys().next().value);
    try { options.onDiagnostic?.(id, reason); } catch {}
  }

  function rememberFinished(entry, state, reason, currentTime) {
    clearTimer(entry);
    if (entry.evidence) bufferedBytes = Math.max(0, bufferedBytes - entry.evidence.bufferedBytes);
    pending.delete(entry.deliveryAttemptId);
    evictFinished(currentTime);
    finished.set(entry.deliveryAttemptId, {
      sourceToken: entry.sourceToken,
      state,
      reason,
      source: entry.source,
      target: entry.target,
      evidence: state === 'applied' && entry.evidence ? entry.evidence.value : null,
      expiresAt: currentTime + FINISHED_RETENTION_MS,
    });
    try { options.onFinished?.(entry.deliveryAttemptId, state, reason, entry.sourceToken); } catch {}
  }

  function notifyUnknown(id, reason) {
    try {
      const result = options.onUnknown?.(id, reason);
      if (utilTypes.isPromise(result)) Promise.prototype.then.call(result, undefined, () => {});
    } catch {}
  }

  function finishUnknown(entry, reason, currentTime = nowValue()) {
    if (!pending.has(entry.deliveryAttemptId) || entry.phase === 'committing') return false;
    rememberFinished(entry, 'unknown', reason, currentTime);
    if (!entry.unknownNotified) { entry.unknownNotified = true; notifyUnknown(entry.deliveryAttemptId, reason); }
    return true;
  }

  function expireEntry(entry) {
    if (['applying', 'committing'].includes(entry.phase)) return false;
    const currentTime = nowValue();
    if (entry.expiresAt > currentTime) return false;
    if (entry.recoverAfterExpiry && entry.accepted) {
      clearTimer(entry);
      if (!entry.unknownNotified) {
        entry.unknownNotified = true;
        notifyUnknown(entry.deliveryAttemptId, 'instruction_evidence_expired');
      }
      return false;
    }
    finishUnknown(entry, 'instruction_evidence_expired', currentTime);
    return true;
  }
  function conflictEntry(entry, reason) {
    if (entry.phase === 'committing') {
      recordDiagnostic(entry.deliveryAttemptId, reason);
      return false;
    }
    if (entry.phase === 'applying') {
      entry.conflict ||= reason;
      return false;
    }
    finishUnknown(entry, reason);
    return false;
  }

  function scheduleExpiry(entry) {
    clearTimer(entry);
    const delay = Math.max(0, entry.expiresAt - nowValue());
    entry.timer = setTimeoutImpl(() => {
      entry.timer = null;
      expireEntry(entry);
    }, delay);
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
  }

  function register(input) {
    if (closed) throw correlatorError('instruction_correlator_closed');
    const registration = normalizeRegistration(input);
    const existing = pending.get(registration.deliveryAttemptId);
    if (existing) {
      if (!sameJson(existing.registration, registration)) throw correlatorError('instruction_attempt_conflict');
      return true;
    }
    if (pending.size >= MAX_PENDING) throw correlatorError('instruction_correlation_capacity');
    const currentTime = nowValue();
    const entry = {
      ...registration,
      registration,
      sourceToken: null,
      phase: 'preparing',
      accepted: null,
      evidence: null,
      conflict: null,
      timer: null,
      expiresAt: currentTime + DEFAULT_TTL_MS,
    };
    pending.set(entry.deliveryAttemptId, entry);
    return true;
  }

  function attachSourceToken(id, sourceToken, recoverAfterExpiry = false) {
    const entry = pending.get(id);
    if (!entry || sourceToken === null || (typeof sourceToken !== 'symbol' && typeof sourceToken !== 'object')) {
      throw correlatorError('instruction_source_unavailable');
    }
    if (entry.sourceToken !== null && entry.sourceToken !== sourceToken) {
      throw correlatorError('instruction_source_conflict');
    }
    entry.sourceToken = sourceToken;
    entry.recoverAfterExpiry = recoverAfterExpiry === true;
    entry.phase = 'prepared';
    return true;
  }

  function markDispatching(id, sourceToken) {
    const entry = pending.get(id);
    if (!entry || entry.sourceToken !== sourceToken || entry.phase !== 'prepared') {
      throw correlatorError('instruction_dispatch_unavailable');
    }
    entry.phase = 'dispatching';
    entry.expiresAt = nowValue() + DEFAULT_TTL_MS;
    scheduleExpiry(entry);
    return true;
  }

  function maybeApply(entry) {
    if (!entry.accepted || !entry.evidence || ['applying', 'committing'].includes(entry.phase)) return false;
    if (expireEntry(entry)) return false;
    const evidence = entry.evidence.value;
    if (entry.accepted.nativeTurnId !== evidence.nativeTurnId ||
        (entry.accepted.nativeItemId !== null && entry.accepted.nativeItemId !== evidence.nativeItemId)) {
      conflictEntry(entry, 'instruction_evidence_conflict');
      return false;
    }
    if (entry.phase !== 'dispatching' && entry.phase !== 'accepted') return false;
    entry.phase = 'applying';
    clearTimer(entry);
    let result;
    try {
      result = options.onApplied(entry.deliveryAttemptId, structuredClone(evidence), entry.sourceToken);
    } catch {
      finishUnknown(entry, 'instruction_evidence_conflict');
      return false;
    }
    if (!utilTypes.isPromise(result)) {
      finishUnknown(entry, 'instruction_evidence_conflict');
      return false;
    }
    Promise.prototype.then.call(result, (committed) => {
      if (pending.get(entry.deliveryAttemptId) === entry) {
        if (committed === true && entry.phase === 'committing') {
          finishApplyCommit(entry.deliveryAttemptId, entry.sourceToken, true);
        } else {
          finishUnknown(entry, 'instruction_evidence_conflict');
        }
      }
    }, () => {
      if (entry.phase === 'committing') finishApplyCommit(entry.deliveryAttemptId, entry.sourceToken, false);
      else finishUnknown(entry, 'instruction_evidence_conflict');
    });
    return true;
  }

  function isApplying(id, sourceToken, evidence) {
    const entry = pending.get(id);
    if (!entry || entry.sourceToken !== sourceToken || entry.phase !== 'applying') return false;
    if (expireEntry(entry) || entry.conflict) return false;
    return sameJson(entry.evidence?.value, evidence);
  }

  function beginApplyCommit(id, sourceToken, evidence) {
    if (closed) return false;
    const entry = pending.get(id);
    if (!isApplying(id, sourceToken, evidence)) return false;
    entry.phase = 'committing';
    clearTimer(entry);
    return true;
  }

  function finishApplyCommit(id, sourceToken, committed) {
    const entry = pending.get(id);
    if (!entry || entry.sourceToken !== sourceToken || entry.phase !== 'committing') return false;
    if (committed === true) {
      rememberFinished(entry, 'applied', null, nowValue());
      return true;
    }
    entry.phase = 'applying';
    return finishUnknown(entry, 'instruction_evidence_conflict');
  }

  function accepted(id, sourceToken, input) {
    if (closed) return false;
    const entry = pending.get(id);
    if (!entry || entry.sourceToken !== sourceToken ||
        !['dispatching', 'accepted'].includes(entry.phase)) return false;
    if (expireEntry(entry)) return false;
    const correlation = exactObject(input, [
      'clientRequestId', 'nativeTurnId', 'nativeItemId',
    ], 'invalid_instruction_acceptance');
    if (correlation.clientRequestId !== id || !isIdentifier(correlation.nativeTurnId) ||
        correlation.nativeItemId !== null && !isIdentifier(correlation.nativeItemId)) {
      finishUnknown(entry, 'instruction_acceptance_conflict');
      return false;
    }
    if (entry.mode === 'steer' && correlation.nativeTurnId !== entry.expectedTurnId) {
      finishUnknown(entry, 'instruction_acceptance_conflict');
      return false;
    }
    entry.accepted = {
      clientRequestId: correlation.clientRequestId,
      nativeTurnId: correlation.nativeTurnId,
      nativeItemId: correlation.nativeItemId,
    };
    entry.phase = 'accepted';
    if (entry.evidence?.bufferedBytes) {
      bufferedBytes = Math.max(0, bufferedBytes - entry.evidence.bufferedBytes);
      entry.evidence.bufferedBytes = 0;
    }
    return maybeApply(entry);
  }

  function observe(input) {
    if (closed) return false;
    const observation = exactObject(input, ['deliveryAttemptId', 'sourceToken', 'evidence']);
    const id = observation.deliveryAttemptId;
    const entry = pending.get(id);
    if (!entry) {
      const prior = finished.get(id);
      if (!prior || prior.sourceToken !== observation.sourceToken) return false;
      let late;
      try { late = normalizeEvidence(observation.evidence); } catch { return false; }
      if (prior.state === 'applied' && !sameJson(prior.evidence, late.value)) {
        recordDiagnostic(id, 'instruction_evidence_after_applied');
      }
      return false;
    }
    if (entry.sourceToken !== observation.sourceToken ||
        !['dispatching', 'accepted', 'applying', 'committing'].includes(entry.phase)) return false;
    if (expireEntry(entry)) return false;

    let normalized;
    try {
      normalized = normalizeEvidence(observation.evidence);
    } catch {
      conflictEntry(entry, 'instruction_evidence_conflict');
      return false;
    }
    const evidence = normalized.value;
    if (evidence.clientRequestId !== id) return false;
    if (!sameJson(evidence.source, entry.source) || !sameJson(evidence.target, entry.target)) {
      conflictEntry(entry, 'instruction_evidence_conflict');
      return false;
    }
    if (evidence.nativeContentDigest !== entry.nativeContentDigest ||
        (entry.mode === 'steer' && evidence.nativeTurnId !== entry.expectedTurnId) ||
        (entry.accepted && entry.accepted.nativeTurnId !== evidence.nativeTurnId)) {
      conflictEntry(entry, 'instruction_evidence_conflict');
      return false;
    }
    if (entry.evidence) {
      if (!sameJson(entry.evidence.value, evidence)) conflictEntry(entry, 'instruction_evidence_conflict');
      return sameJson(entry.evidence.value, evidence);
    }
    if (!entry.accepted && (normalized.bufferedBytes > MAX_BUFFER_BYTES ||
        bufferedBytes + normalized.bufferedBytes > MAX_BUFFER_BYTES)) {
      finishUnknown(entry, 'instruction_evidence_capacity');
      return false;
    }
    entry.evidence = {
      value: evidence,
      bufferedBytes: normalized.bufferedBytes,
    };
    if (!entry.accepted) bufferedBytes += normalized.bufferedBytes;
    if (entry.accepted) {
      entry.evidence.bufferedBytes = 0;
      return maybeApply(entry);
    }
    return true;
  }

  function unknown(id, reason = 'instruction_delivery_unknown') {
    const entry = pending.get(id);
    if (!entry || entry.phase === 'committing') return false;
    if (reason === 'instruction_evidence_expired' && entry.recoverAfterExpiry && entry.accepted) {
      if (entry.phase === 'applying') return false;
      clearTimer(entry);
      if (!entry.unknownNotified) { entry.unknownNotified = true; notifyUnknown(id, reason); }
      return true;
    }
    return finishUnknown(entry, reason);
  }

  function remove(id) {
    const entry = pending.get(id);
    if (entry && entry.phase !== 'committing') {
      rememberFinished(entry, 'cancelled', null, nowValue());
      return true;
    }
    return false;
  }

  function expire() {
    const currentTime = nowValue();
    for (const entry of pending.values()) {
      if (entry.expiresAt <= currentTime) expireEntry(entry);
    }
    evictFinished(currentTime);
  }

  function diagnosticsSnapshot() {
    const currentTime = nowValue();
    for (const [key, value] of diagnostics) {
      if (value.expiresAt <= currentTime) diagnostics.delete(key);
    }
    return [...diagnostics.values()].map(({ deliveryAttemptId, code, observedAt }) => ({
      deliveryAttemptId, code, observedAt,
    }));
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const entry of [...pending.values()]) {
      clearTimer(entry);
      if (entry.phase !== 'committing') {
        pending.delete(entry.deliveryAttemptId);
        if (entry.evidence) bufferedBytes = Math.max(0, bufferedBytes - entry.evidence.bufferedBytes);
      }
    }
    finished.clear();
  }

  return Object.freeze({
    accepted,
    attachSourceToken,
    beginApplyCommit,
    close,
    diagnostics: diagnosticsSnapshot,
    expire,
    finishApplyCommit,
    isApplying,
    markDispatching,
    observe,
    register,
    remove,
    unknown,
    get pendingCount() { return pending.size; },
    get bufferedBytes() { return bufferedBytes; },
  });
}

module.exports = {
  DEFAULT_TTL_MS,
  MAX_BUFFER_BYTES,
  MAX_PENDING,
  createInstructionInputCorrelator,
};
