'use strict';

const crypto = require('node:crypto');
const { AsyncLocalStorage } = require('node:async_hooks');
const { types: utilTypes } = require('node:util');
const kernel = require('./common-question-kernel');
const { createCommonQuestionJournal } = require('./common-question-journal');
const { createCommonQuestionReclamationJournal } = require('./common-question-reclamation-adapter');
const nativePromiseThen = Promise.prototype.then;

const WRITER_FIELDS = ['token', 'identity', 'contextId', 'executionId'];
const REGISTER_FIELDS = ['questionId', 'questions', 'timeoutMinutes', 'category'];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const CLAIM_FIELDS = ['launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'origin', 'purpose', 'originBinding'];
const CONNECTION_SCOPE_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId'];
const MAX_EXTERNAL_EVIDENCE_BYTES = 64 * 1024;
const DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS = 5 * 60_000;
const AUTO_APPLY_BINDING_RECHECK_MS = 30_000;

function serviceError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function sameIdentity(left, right) {
  return Boolean(left && right) && IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function sameActor(left, right) {
  return Boolean(left && right) && left.kind === right.kind && left.id === right.id;
}

function sameBinding(left, right) {
  return Boolean(left && right) && left.periodId === right.periodId && sameActor(left.actor, right.actor);
}

function sameClaims(left, right) {
  return Boolean(left && right) && CLAIM_FIELDS.every((field) => field === 'originBinding'
    ? sameBinding(left[field], right[field]) || (left[field] === null && right[field] === null)
    : left[field] === right[field]);
}

function isThenable(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  if (utilTypes.isPromise(value)) {
    try { nativePromiseThen.call(value, undefined, () => {}); } catch {}
    return true;
  }
  let then;
  try { then = value.then; } catch { throw serviceError('question_sink_must_be_synchronous'); }
  return typeof then === 'function';
}

function syncCall(target, method, args, code) {
  try {
    if (!target || typeof target[method] !== 'function') throw serviceError(code);
    const value = target[method](...args);
    if (isThenable(value)) throw serviceError(code);
    return value;
  } catch { throw serviceError(code); }
}

function captureJsonNode(value, depth = 0, budget = { bytes: 0, nodes: 0 }) {
  if (depth > 12 || ++budget.nodes > 10_000) throw serviceError('invalid_evidence');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    budget.bytes += Buffer.byteLength(value, 'utf8');
    if (budget.bytes > MAX_EXTERNAL_EVIDENCE_BYTES) throw serviceError('invalid_evidence');
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw serviceError('invalid_evidence');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000 || Reflect.ownKeys(value).length !== value.length + 1) throw serviceError('invalid_evidence');
    const result = [];
    for (let index = 0; index < value.length; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw serviceError('invalid_evidence');
      result.push(captureJsonNode(descriptor.value, depth + 1, budget));
    }
    return result;
  }
  if (!value || typeof value !== 'object') throw serviceError('invalid_evidence');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw serviceError('invalid_evidence');
  const keys = Reflect.ownKeys(value);
  if (keys.length > 128) throw serviceError('invalid_evidence');
  const result = {};
  for (const key of keys) {
    if (typeof key !== 'string') throw serviceError('invalid_evidence');
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) throw serviceError('invalid_evidence');
    budget.bytes += Buffer.byteLength(key, 'utf8');
    if (budget.bytes > MAX_EXTERNAL_EVIDENCE_BYTES) throw serviceError('invalid_evidence');
    result[key] = captureJsonNode(descriptor.value, depth + 1, budget);
  }
  return result;
}

function captureJson(value) {
  const captured = captureJsonNode(value);
  let sizeBytes;
  try { sizeBytes = Buffer.byteLength(JSON.stringify(captured), 'utf8'); }
  catch { throw serviceError('invalid_evidence'); }
  if (sizeBytes > MAX_EXTERNAL_EVIDENCE_BYTES) throw serviceError('invalid_evidence');
  return captured;
}
function connectionIsCurrent(actor, snapshot) {
  const matching = snapshot.connections.filter((item) => item.connectionId === actor.connectionId &&
    item.generation === actor.connectionGeneration && item.state === 'active' && item.scope &&
    CONNECTION_SCOPE_FIELDS.every((field) => item.scope[field] === actor.identity[field]));
  if (matching.length !== 1) return false;
  const scope = matching[0].scope;
  const slotItems = snapshot.connections.filter((item) => item.scope &&
    CONNECTION_SCOPE_FIELDS.concat('connectionSlotId').every((field) => item.scope[field] === scope[field]));
  const maxGeneration = slotItems.reduce((max, item) => Math.max(max, item.generation), 0);
  return matching[0].generation === maxGeneration;
}

function validateLaunchBinding(launchRegistry, runtimeRegistry, launchRef, identity, binding, conversationId = undefined) {
  const source = syncCall(launchRegistry, 'get', [launchRef], 'question_binding_unavailable');
  const runtime = syncCall(runtimeRegistry, 'get', [launchRef], 'question_binding_unavailable');
  if (!source || !runtime || source.launchRef !== launchRef || runtime.launchRef !== launchRef ||
      !sameIdentity(source.identity, identity) || !sameIdentity(runtime.identity, identity) ||
      !sameBinding(source.executionBinding, binding) || !sameBinding(runtime.executionBinding, binding) ||
      (conversationId !== undefined && (source.conversationId !== conversationId || runtime.conversationId !== conversationId)) ||
      !sameClaims(source, runtime)) throw serviceError('question_binding_mismatch');
  return { source, runtime };
}

function createCommonQuestionService(options = {}) {
  const reclamationOptions = options && typeof options === 'object' && !Array.isArray(options)
    ? options.reclamation : undefined;
  const reclamationMode = reclamationOptions !== undefined;
  const reclamationValid = reclamationMode && reclamationOptions && typeof reclamationOptions === 'object' &&
    !Array.isArray(reclamationOptions) && reclamationOptions.backend && reclamationOptions.periodGate;
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      (!reclamationMode && typeof options.journalPath !== 'string') ||
      (reclamationMode && (!reclamationValid ||
        (options.maxBytes !== undefined && options.maxBytes !== reclamationOptions.backend.normalByteLimit))) ||
      !options.registrationRegistry || typeof options.registrationRegistry.authorizeWriter !== 'function' ||
      typeof options.registrationRegistry.snapshot !== 'function' || !options.launchRegistry ||
      typeof options.launchRegistry.get !== 'function' || typeof options.launchRegistry.snapshot !== 'function' ||
      !options.runtimeRegistry || typeof options.runtimeRegistry.get !== 'function' ||
      typeof options.runtimeRegistry.snapshot !== 'function' || !options.deliveryStore ||
      !options.deliveryStore.ready || typeof options.deliveryStore.createQuestionDelivery !== 'function' ||
      typeof options.deliveryStore.get !== 'function' || typeof options.deliveryStore.snapshot !== 'function' ||
      typeof options.deliveryStore.rehydratePayload !== 'function' || typeof options.deliveryStore.sendStart !== 'function' ||
      typeof options.deliveryStore.markUnknown !== 'function' || typeof options.deliveryStore.cancel !== 'function' ||
      !options.away || typeof options.away.snapshot !== 'function' ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      (options.getAutoApplySettings !== undefined && typeof options.getAutoApplySettings !== 'function') ||
      (options.verifyNativeQuestion !== undefined && typeof options.verifyNativeQuestion !== 'function') ||
      (options.atomicWrite !== undefined && typeof options.atomicWrite !== 'function') ||
      (options.setTimeoutImpl !== undefined && typeof options.setTimeoutImpl !== 'function') ||
      (options.clearTimeoutImpl !== undefined && typeof options.clearTimeoutImpl !== 'function')) {
    throw serviceError('invalid_question_service_dependencies');
  }
  const journal = reclamationMode
    ? createCommonQuestionReclamationJournal({
      backend: reclamationOptions.backend,
      periodGate: reclamationOptions.periodGate,
      ...(options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {}),
    })
    : createCommonQuestionJournal({ filePath: options.journalPath,
      ...(options.atomicWrite ? { atomicWrite: options.atomicWrite } : {}),
      ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
      ...(options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {}),
      ...(options.fileSystem ? { fileSystem: options.fileSystem } : {}),
    });
  const now = options.now || Date.now;
  const getAutoApplySettings = () => {
    if (typeof options.getAutoApplySettings !== 'function') {
      return { enabled: false, minimumWaitMs: DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS };
    }
    try {
      const settings = kernel.exactObject(options.getAutoApplySettings(), ['enabled', 'minimumWaitMs'],
        'invalid_auto_apply_settings');
      if (typeof settings.enabled !== 'boolean' || !Number.isSafeInteger(settings.minimumWaitMs) ||
          settings.minimumWaitMs < DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS) throw serviceError('invalid_auto_apply_settings');
      return settings;
    } catch {
      return { enabled: false, minimumWaitMs: DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS };
    }
  };
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
  let accepting = true;
  let blocked = false;
  let journalState = null;
  let startupError = null;
  let tail = Promise.resolve();
  let initPromise = null;
  let timer = null;
  let closePromise = null;
  let capacityRejected = false;
  let writerStopped = false;
  let pendingOperations = 0;
  let activePeriodToken = null;
  const creatingDeliveryQuestionIds = new Set();
  const retirementStorage = reclamationMode ? new AsyncLocalStorage() : null;
  const retirementScope = Object.freeze({});
  const suppressed = new Set();
  const quarantinedQuestionIds = new Set();

  function nowValue() {
    let value;
    try { value = now(); } catch { throw serviceError('clock_unavailable'); }
    if (!Number.isSafeInteger(value) || value < 0) throw serviceError('clock_unavailable');
    return value;
  }

  function assertCurrentPeriod() {
    if (reclamationMode && activePeriodToken !== null) reclamationOptions.periodGate.assertCurrent(activePeriodToken);
  }

  function sharedWriterCanWrite() {
    if (!reclamationMode) return true;
    try { return reclamationOptions.backend.canWrite() === true; } catch { return false; }
  }

  function assertSharedWriterCanWrite() {
    if (!sharedWriterCanWrite()) throw serviceError('question_gate_closed');
  }

  function captureWriterPeriodToken(writer) {
    if (!reclamationMode) return { live: null, token: null };
    const live = findLiveWriter(writer);
    return { live, token: reclamationOptions.periodGate.capture(live.identity, live.periodId) };
  }

  function captureInternalPeriodToken(internalQuestionId) {
    if (!reclamationMode) return null;
    if (!journalState) throw serviceError('question_service_not_ready');
    const reservation = journal.getReservation(internalQuestionId);
    if (!reservation) return null;
    if (reservation.bodyState === 'reclaimed' || reservation.quarantinedAt !== null) {
      throw serviceError('question_quarantined');
    }
    return reclamationOptions.periodGate.capture(reservation.identity, reservation.periodId);
  }

  function enqueue(operation, diagnostic = false, periodToken = null) {
    if (!accepting) return Promise.reject(serviceError('question_service_closed'));
    if (reclamationMode && retirementStorage.getStore() === retirementScope) {
      return Promise.reject(serviceError('question_retirement_queue_reentry'));
    }
    if (reclamationMode && !sharedWriterCanWrite()) {
      return Promise.reject(serviceError('question_gate_closed'));
    }
    if (reclamationMode && (writerStopped || (!journalState && !diagnostic))) {
      return Promise.reject(serviceError(writerStopped ? 'question_gate_closed' : 'question_service_not_ready'));
    }
    pendingOperations += 1;
    const queued = tail.then(async () => {
      if (reclamationMode) assertSharedWriterCanWrite();
      try { await ready(); } catch (error) { if (!diagnostic) throw error; }
      if (blocked && !diagnostic) throw serviceError('question_writer_blocked');
      if (reclamationMode) assertSharedWriterCanWrite();
      const previousToken = activePeriodToken;
      activePeriodToken = periodToken;
      try {
        if (periodToken !== null) reclamationOptions.periodGate.assertCurrent(periodToken);
        return await operation();
      } finally {
        activePeriodToken = previousToken;
      }
    });
    const result = queued.finally(() => { pendingOperations -= 1; });
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function findQuestion(identity, periodId, id) {
    const key = kernel.questionKey(identity, periodId, id);
    return journalState.questions.find((record) =>
      kernel.questionKey(record.identity, record.periodId, record.questionId) === key) || null;
  }

  function assertPublicQuestionReservation(identity, periodId, questionId) {
    if (!reclamationMode) return;
    const reservation = journal.findReservation(identity, periodId, questionId);
    if (reservation && (reservation.bodyState === 'reclaimed' || reservation.quarantinedAt !== null)) {
      throw serviceError('question_quarantined');
    }
  }

  function currentQuestion(id) {
    return journalState?.questions.find((record) => record.internalQuestionId === id) || null;
  }

  function isQuarantined(record) {
    return Boolean(record && quarantinedQuestionIds.has(record.internalQuestionId));
  }

  function refreshQuarantinedQuestionIds() {
    const snapshot = journal.getSnapshot();
    quarantinedQuestionIds.clear();
    for (const detail of snapshot.questions) {
      if (detail.quarantinedAt !== null) quarantinedQuestionIds.add(detail.internalQuestionId);
    }
    for (const reservation of snapshot.reservations) {
      if (reservation.bodyState === 'reclaimed') quarantinedQuestionIds.add(reservation.internalQuestionId);
    }
  }

  function assertNotQuarantined(record) {
    if (isQuarantined(record)) throw serviceError('question_quarantined');
    if (reclamationMode && record) {
      const reservation = journal.getReservation(record.internalQuestionId);
      if (reservation && (reservation.bodyState === 'reclaimed' || reservation.quarantinedAt !== null)) {
        throw serviceError('question_quarantined');
      }
      assertCurrentPeriod();
    }
  }

  function getQuarantineDiagnostics() {
    const startupReason = startupError?.code;
    const safeStartupReason = typeof startupReason === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(startupReason)
      ? startupReason : 'question_quarantine_status_unavailable';
    const unavailable = Object.freeze({ status: blocked ? 'blocked' : 'unavailable',
      reason: safeStartupReason, quarantinedCount: quarantinedQuestionIds.size, reservedBytes: null,
      remainingBytes: null, remainingCount: null });
    if (!journalState) return unavailable;
    try {
      const reservedBytes = journal.assertCapacityReserved(journalState);
      const remainingBytes = Math.max(0, journal.maxBytes - reservedBytes);
      const retainedCount = reclamationMode ? journal.getSnapshot().reservations.length : journalState.questions.length;
      const remainingCount = Math.max(0, journal.maxRecords - retainedCount);
      const capacityReached = capacityRejected || remainingBytes === 0 || remainingCount === 0;
      return Object.freeze({ status: blocked ? 'blocked' : 'ready',
        reason: capacityReached ? 'question_quarantine_capacity' : blocked ? safeStartupReason : null,
        quarantinedCount: quarantinedQuestionIds.size, reservedBytes, remainingBytes, remainingCount });
    } catch {
      return unavailable;
    }
  }

  function findLiveWriter(input) {
    const writer = kernel.exactObject(input, WRITER_FIELDS, 'question_writer_unverified');
    if (!kernel.isIdentifier(writer.contextId) || !kernel.isIdentifier(writer.executionId) ||
        typeof writer.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(writer.token)) {
      throw serviceError('question_writer_unverified');
    }
    const identity = kernel.normalizeIdentity(writer.identity);
    let authorization;
    try { authorization = options.registrationRegistry.authorizeWriter(writer); }
    catch { throw serviceError('question_writer_unverified'); }
    if (isThenable(authorization) || authorization?.ok !== true || authorization.status !== 'accepted' ||
        authorization.executionId !== writer.executionId || !kernel.isIdentifier(authorization.conversationId)) {
      throw serviceError('question_writer_unverified');
    }
    const registration = syncCall(options.registrationRegistry, 'snapshot', [], 'question_writer_unverified');
    if (!Array.isArray(registration?.conversations) || !Array.isArray(registration?.executions)) {
      throw serviceError('question_writer_unverified');
    }
    const conversations = registration.conversations.filter((item) => item.conversationId === authorization.conversationId &&
      sameIdentity(item.identity, identity));
    const executions = registration.executions.filter((item) => item.executionId === authorization.executionId &&
      item.conversationId === authorization.conversationId && item.state === 'active');
    if (conversations.length !== 1 || executions.length !== 1) throw serviceError('question_writer_unverified');
    const runtime = syncCall(options.runtimeRegistry, 'snapshot', [], 'question_writer_unverified');
    if (!Array.isArray(runtime?.actors) || !Array.isArray(runtime?.connections)) throw serviceError('question_writer_unverified');
    const matches = runtime.actors.filter((actor) => sameIdentity(actor.identity, identity) &&
      actor.periodId === authorization.executionId && actor.contextId === writer.contextId);
    const liveMatches = matches.filter((actor) => actor.state === 'active' && connectionIsCurrent(actor, runtime));
    if (liveMatches.length > 1) throw serviceError('question_writer_ambiguous');
    if (liveMatches.length === 0 || !kernel.isIdentifier(liveMatches[0].launchRef)) {
      throw serviceError('question_writer_inactive');
    }
    const actor = liveMatches[0];
    const binding = { periodId: actor.periodId, actor: actor.actor };
    const { source, runtime: runtimeLaunch } = validateLaunchBinding(options.launchRegistry,
      options.runtimeRegistry, actor.launchRef, identity, binding, authorization.conversationId);
    if (!sameActor(actor.actor, source.executionBinding?.actor) || !sameActor(actor.actor, runtimeLaunch.executionBinding?.actor)) {
      throw serviceError('question_writer_binding_mismatch');
    }
    return { identity, periodId: actor.periodId, executionId: authorization.executionId,
      conversationId: authorization.conversationId, launchRef: actor.launchRef,
      executionBinding: binding, contextId: writer.contextId };
  }

  function validatePersistedBinding(record) {
    validateLaunchBinding(options.launchRegistry, options.runtimeRegistry, record.launchRef,
      record.identity, record.executionBinding, record.conversationId);
  }

  function currentExecutionBindingStatus(record) {
    try {
      const registration = syncCall(options.registrationRegistry, 'snapshot', [], 'question_binding_unavailable');
      if (!Array.isArray(registration?.conversations) || !Array.isArray(registration?.executions)) return 'unavailable';
      const conversations = registration.conversations.filter((item) => item.conversationId === record.conversationId &&
        sameIdentity(item.identity, record.identity));
      const executions = registration.executions.filter((item) => item.executionId === record.executionId &&
        item.conversationId === record.conversationId);
      if (conversations.length !== 1 || executions.length !== 1) return 'unavailable';
      if (executions[0].state === 'ended') return 'ended';
      if (executions[0].state !== 'active') return 'unavailable';
      const runtime = syncCall(options.runtimeRegistry, 'snapshot', [], 'question_binding_unavailable');
      if (!Array.isArray(runtime?.actors) || !Array.isArray(runtime?.connections)) return 'unavailable';
      const liveActors = runtime.actors.filter((actor) => actor.state === 'active' &&
        actor.launchRef === record.launchRef && actor.periodId === record.periodId &&
        sameIdentity(actor.identity, record.identity) &&
        sameBinding({ periodId: actor.periodId, actor: actor.actor }, record.executionBinding) &&
        connectionIsCurrent(actor, runtime));
      if (liveActors.length !== 1) return 'unavailable';
      validatePersistedBinding(record);
      return 'current';
    } catch {
      return 'unavailable';
    }
  }

  function hasCurrentExecutionBinding(record) {
    return currentExecutionBindingStatus(record) === 'current';
  }

  function currentAwayState() {
    try { return options.away.snapshot(); } catch { return null; }
  }

  function autoApplyPolicyDeadline(record, awayState, settings = getAutoApplySettings(), at = nowValue()) {
    if (!record.autoApplyEnabledAtRegistration || !settings.enabled || awayState?.enabled !== true ||
        !Number.isSafeInteger(awayState.since) || awayState.since < 0 || awayState.since > at ||
        !kernel.canApplyAwayDefault(record)) return null;
    if (awayState.since > record.createdAt && record.deadlineAt <= awayState.since) return null;
    const start = Math.max(record.createdAt, awayState.since);
    const waitMs = Math.max(record.timeoutMinutes * 60_000, settings.minimumWaitMs);
    const deadline = start + waitMs;
    return Number.isSafeInteger(deadline) ? deadline : null;
  }

  function deliveryPayload(record) {
    if (!record.selection || !record.deliveryIntent) throw serviceError('question_delivery_intent_missing');
    return JSON.stringify({ questionId: record.questionId, revision: record.deliveryIntent.revision,
      answers: record.selection.answers });
  }

  function deliveryMatchesRecord(delivery, record) {
    if (!delivery || !record.deliveryIntent || delivery.kind !== 'question' ||
        delivery.deliveryAttemptId !== record.deliveryIntent.deliveryAttemptId ||
        delivery.logicalMessageId !== record.deliveryIntent.logicalMessageId ||
        delivery.revision !== record.deliveryIntent.revision ||
        delivery.payloadDigest !== record.deliveryIntent.payloadDigest) return false;
    const { source } = validateLaunchBinding(options.launchRegistry, options.runtimeRegistry,
      record.launchRef, record.identity, record.executionBinding, record.conversationId);
    return delivery.source?.launchRef === record.launchRef &&
      sameClaims(delivery.source?.claims, source) &&
      sameIdentity(delivery.source?.identity, record.identity) &&
      sameBinding(delivery.source?.executionBinding, record.executionBinding) &&
      delivery.source?.conversationId === record.conversationId &&
      delivery.source?.sessionId === source.sessionId &&
      delivery.target?.kind === 'execution' && delivery.target?.launchRef === record.launchRef &&
      sameClaims(delivery.target?.claims, source) &&
      delivery.target?.periodId === record.periodId && sameActor(delivery.target?.actor, record.executionBinding.actor) &&
      sameIdentity(delivery.target?.identity, record.identity) &&
      delivery.target?.conversationId === record.conversationId &&
      delivery.target?.sessionId === source.sessionId;
  }

  function persistedDeliveryMatchesRecord(delivery, record) {
    if (!delivery || !record.deliveryIntent || delivery.kind !== 'question' ||
        delivery.deliveryAttemptId !== record.deliveryIntent.deliveryAttemptId ||
        delivery.logicalMessageId !== record.deliveryIntent.logicalMessageId ||
        delivery.revision !== record.deliveryIntent.revision ||
        delivery.payloadDigest !== record.deliveryIntent.payloadDigest ||
        delivery.sourceExecutionId !== record.executionBinding.periodId) return false;
    const source = delivery.source;
    const target = delivery.target;
    const claims = source?.claims;
    return source?.launchRef === record.launchRef &&
      claims?.provider === record.identity.provider && claims?.nativeIdKind === record.identity.nativeIdKind &&
      claims?.hostId === record.identity.hostId && claims?.homeScopeId === record.identity.homeScopeId &&
      sameClaims(claims, target?.claims) && sameIdentity(source?.identity, record.identity) &&
      sameBinding(source?.executionBinding, record.executionBinding) &&
      source?.conversationId === record.conversationId &&
      target?.kind === 'execution' && target?.launchRef === record.launchRef &&
      target?.periodId === record.periodId && sameActor(target?.actor, record.executionBinding.actor) &&
      sameIdentity(target?.identity, record.identity) && target?.conversationId === record.conversationId &&
      target?.sessionId === source.sessionId;
  }

  function sameQuestionDetailReservation(record, reservation) {
    const intent = record.deliveryIntent;
    const reservedIntent = reservation.deliveryIntent;
    const external = record.externalResolution;
    const reservedExternal = reservation.externalResolution;
    return reservation.internalQuestionId === record.internalQuestionId &&
      sameIdentity(reservation.identity, record.identity) && reservation.periodId === record.periodId &&
      reservation.questionId === record.questionId && reservation.contentDigest === record.contentDigest &&
      reservation.executionId === record.executionId && reservation.conversationId === record.conversationId &&
      reservation.launchRef === record.launchRef && sameBinding(reservation.executionBinding, record.executionBinding) &&
      reservation.createdAt === record.createdAt && reservation.revision === record.revision &&
      reservation.selectionSource === (record.selection?.source ?? null) &&
      reservation.selectedAt === (record.selection?.selectedAt ?? null) &&
      (intent === null ? reservedIntent === null : reservedIntent !== null &&
        intent.deliveryAttemptId === reservedIntent.deliveryAttemptId &&
        intent.logicalMessageId === reservedIntent.logicalMessageId && intent.revision === reservedIntent.revision &&
        intent.payloadDigest === reservedIntent.payloadDigest) &&
      reservation.deliveryCreationState === record.deliveryCreationState &&
      (external === null ? reservedExternal === null : reservedExternal !== null &&
        external.resolvedAt === reservedExternal.resolvedAt && external.evidenceDigest === reservedExternal.evidenceDigest) &&
      reservation.cancelledAt === record.cancelledAt && reservation.quarantinedAt === record.quarantinedAt;
  }

  function sameIdentifierTuple(left, right) {
    return Array.isArray(left) && Array.isArray(right) && left.length === 3 && right.length === 3 &&
      left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
  }

  function reclaimedDeliveryMatchesRecord(delivery, record, reservation) {
    if (!delivery || delivery.recordType !== 'reclaimed' || delivery.kind !== 'question' ||
        !reservation || !sameQuestionDetailReservation(record, reservation) ||
        reservation.bodyState !== 'retained' || reservation.reclaimedAt !== null ||
        reservation.deliveryCreationState !== 'checkpointed' || reservation.quarantinedAt === null ||
        !sameIdentity(record.identity, reservation.identity) || record.quarantinedAt !== reservation.quarantinedAt ||
        !record.deliveryIntent || reservation.reclamation === null ||
        reservation.reclamation.deliveryPresence !== 'checkpoint') return false;
    const source = delivery.sourceRef;
    const target = delivery.targetRef;
    const reclamation = delivery.reclamation;
    const intent = record.deliveryIntent;
    const preparation = reservation.reclamation;
    const terminalResultKind = ['applied', 'cancelled_before_send', 'superseded_before_send'].includes(delivery.state)
      ? delivery.state : null;
    return delivery.deliveryAttemptId === intent.deliveryAttemptId &&
      delivery.logicalMessageId === intent.logicalMessageId && delivery.revision === intent.revision &&
      delivery.payloadDigest === intent.payloadDigest && delivery.sourceExecutionId === reservation.periodId &&
      source?.launchRef === reservation.launchRef && sameIdentity(source?.identity, reservation.identity) &&
      sameBinding(source?.executionBinding, reservation.executionBinding) &&
      source?.conversationId === reservation.conversationId && source?.sessionId === reservation.sessionId &&
      source?.sourceClaimsDigest === reservation.sourceClaimsDigest && target?.kind === 'execution' &&
      target?.launchRef === reservation.launchRef && sameIdentity(target?.identity, reservation.identity) &&
      target?.periodId === reservation.periodId && sameActor(target?.actor, reservation.executionBinding.actor) &&
      target?.conversationId === reservation.conversationId && target?.sessionId === reservation.sessionId &&
      target?.targetClaimsDigest === reservation.sourceClaimsDigest &&
      sameIdentifierTuple(source?.launchKey, target?.launchKey) &&
      reservation.checkpointState === delivery.state && preparation.checkpointState === delivery.state &&
      reservation.terminalResultKind === terminalResultKind &&
      reclamation?.operationId === preparation.operationId &&
      reclamation?.reason === 'retired_question_period' &&
      reclamation.reclaimedAt >= preparation.preparedAt &&
      reclamation.reclaimedAt >= reservation.quarantinedAt;
  }

  async function createDeliveryFromIntent(record) {
    assertNotQuarantined(record);
    const payload = deliveryPayload(record);
    if (kernel.sha256Json(JSON.parse(payload)) !== record.deliveryIntent.payloadDigest) {
      throw serviceError('question_delivery_digest_mismatch');
    }
    if (reclamationMode) return createReclamationDeliveryFromIntent(record, payload);
    assertCurrentPeriod();
    const current = await options.deliveryStore.get(record.deliveryIntent.deliveryAttemptId);
    assertCurrentPeriod();
    if (current) {
      if (!deliveryMatchesRecord(current, record)) throw serviceError('question_delivery_mismatch');
      return current;
    }
    assertCurrentPeriod();
    const delivery = await options.deliveryStore.createQuestionDelivery({
      launchRef: record.launchRef,
      deliveryAttemptId: record.deliveryIntent.deliveryAttemptId,
      logicalMessageId: record.deliveryIntent.logicalMessageId,
      revision: record.deliveryIntent.revision,
      payload,
    });
    if (!deliveryMatchesRecord(delivery, record)) throw serviceError('question_delivery_mismatch');
    return delivery;
  }

  async function createReclamationDeliveryFromIntent(record, payload) {
    const id = record.deliveryIntent.deliveryAttemptId;
    let reservation = journal.getReservation(record.internalQuestionId);
    if (!reservation) throw serviceError('question_journal_missing_for_delivery');
    if (reservation.deliveryCreationState === 'indeterminate') {
      throw serviceError('question_delivery_indeterminate');
    }
    let ownCreation = false;
    if (reservation.deliveryCreationState === 'not_created') {
      assertCurrentPeriod();
      creatingDeliveryQuestionIds.add(record.internalQuestionId);
      ownCreation = true;
      try {
        record = await updateDeliveryCreationState(record, 'creating');
        reservation = journal.getReservation(record.internalQuestionId);
      } catch (error) {
        creatingDeliveryQuestionIds.delete(record.internalQuestionId);
        throw error;
      }
    } else if (reservation.deliveryCreationState === 'creating') {
      if (!creatingDeliveryQuestionIds.has(record.internalQuestionId)) {
        throw serviceError('question_delivery_indeterminate');
      }
      ownCreation = true;
    }

    try {
      assertCurrentPeriod();
      let current = await options.deliveryStore.get(id);
      assertCurrentPeriod();
      if (current && !deliveryMatchesRecord(current, record)) throw serviceError('question_delivery_mismatch');
      if (reservation.deliveryCreationState === 'checkpointed') {
        if (!current) throw serviceError('question_delivery_missing');
        return current;
      }
      if (!current) {
        assertCurrentPeriod();
        await options.deliveryStore.createQuestionDelivery({
          launchRef: record.launchRef,
          deliveryAttemptId: id,
          logicalMessageId: record.deliveryIntent.logicalMessageId,
          revision: record.deliveryIntent.revision,
          payload,
        });
        assertCurrentPeriod();
        current = await options.deliveryStore.get(id);
        assertCurrentPeriod();
      }
      if (!current || !deliveryMatchesRecord(current, record)) throw serviceError('question_delivery_mismatch');
      try {
        journalState = await journal.updateDeliveryState(record.internalQuestionId, 'checkpointed', current,
          activePeriodToken);
      } catch (error) {
        blocked = true;
        startupError = serviceError('question_delivery_creation_cache_failed');
        throw error;
      }
      return current;
    } catch (error) {
      if (ownCreation) {
        creatingDeliveryQuestionIds.delete(record.internalQuestionId);
        try {
          assertCurrentPeriod();
          const observed = await options.deliveryStore.get(id);
          assertCurrentPeriod();
          if (observed) {
            if (!deliveryMatchesRecord(observed, record)) throw serviceError('question_delivery_mismatch');
            journalState = await journal.updateDeliveryState(record.internalQuestionId, 'checkpointed', observed,
              activePeriodToken);
            return observed;
          }
          journalState = await journal.updateDeliveryState(record.internalQuestionId, 'indeterminate', null,
            activePeriodToken);
        } catch (recoveryError) {
          if (['question_quarantined', 'question_gate_closed'].includes(recoveryError?.code)) throw recoveryError;
          blocked = true;
          startupError = serviceError('question_delivery_creation_unknown');
        }
      }
      throw error;
    } finally {
      if (ownCreation) creatingDeliveryQuestionIds.delete(record.internalQuestionId);
    }
  }

  function deliveryMap(snapshot) {
    if (!snapshot || !Array.isArray(snapshot.deliveries)) throw serviceError('delivery_store_unavailable');
    return new Map(snapshot.deliveries.map((delivery) => [delivery.deliveryAttemptId, delivery]));
  }

  function projection(record, delivery = null, dashboard = false) {
    const result = {
      internalQuestionId: record.internalQuestionId,
      questionId: record.questionId,
      ...(dashboard ? {
        identity: structuredClone(record.identity), periodId: record.periodId, executionId: record.executionId,
        conversationId: record.conversationId, launchRef: record.launchRef, questions: structuredClone(record.questions),
        selectedOptionIds: record.selection ? record.selection.answers.map(({ questionId, optionIds }) =>
          ({ questionId, optionIds: [...optionIds] })) : [],
        quarantined: isQuarantined(record),
      } : { periodId: record.periodId, executionId: record.executionId }),
      revision: record.revision,
      createdAt: record.createdAt,
      deadlineAt: record.deadlineAt,
      held: record.held,
      selectionSource: record.selection?.source || null,
      selectedAt: record.selection?.selectedAt ?? null,
      deliveryAttemptId: record.deliveryIntent?.deliveryAttemptId || null,
      deliveryState: delivery?.state || null,
      externalResolution: record.externalResolution !== null,
      lateAnswerCount: record.lateAnswers.length,
      ...(dashboard ? { lateAnswerRefs: record.lateAnswers.map((late, index) => ({
        index, digest: late.digest, submittedAt: late.submittedAt,
      })) } : {}),
      cancelled: record.cancelledAt !== null || (record.externalResolution === null && delivery?.state === 'cancelled_before_send'),
      cancelRequested: delivery?.cancelRequested === true,
      cancelHistoryMissing: record.externalResolution === null && delivery?.state === 'cancelled_before_send' && record.cancelledAt === null,
    };
    return result;
  }

  async function projectRecord(record, dashboard = false) {
    assertNotQuarantined(record);
    const delivery = record.deliveryIntent ? await options.deliveryStore.get(record.deliveryIntent.deliveryAttemptId) : null;
    assertCurrentPeriod();
    if (delivery && !deliveryMatchesRecord(delivery, record)) throw serviceError('question_delivery_mismatch');
    return projection(record, delivery, dashboard);
  }

  async function saveCandidate(candidate, internalQuestionId) {
    try {
      assertCurrentPeriod();
      const saved = await journal.save(candidate, activePeriodToken);
      journalState = saved;
      return saved.questions.find((record) => record.internalQuestionId === internalQuestionId);
    } catch (error) {
      if (['journal_write_failed', 'journal_writer_blocked'].includes(error.code)) {
        blocked = true;
        rescheduleTimer();
      }
      throw error;
    }
  }

  async function commitRecord(record) {
    return saveCandidate(kernel.replaceQuestion(journalState, record, journal.maxRecords), record.internalQuestionId);
  }

  async function addRecord(record) {
    return saveCandidate(kernel.addQuestion(journalState, record, journal.maxRecords), record.internalQuestionId);
  }

  async function updateDeliveryCreationState(record, state, evidence = null) {
    if (!reclamationMode) return record;
    assertCurrentPeriod();
    journalState = await journal.updateDeliveryState(record.internalQuestionId, state, evidence, activePeriodToken);
    return currentQuestion(record.internalQuestionId);
  }

  async function reconcile() {
    journalState = kernel.normalizeJournal(await journal.load(), journal.maxRecords);
    for (const record of journalState.questions) quarantinedQuestionIds.add(record.internalQuestionId);
    await options.deliveryStore.ready;
    journal.assertCapacityReserved(journalState);
    const snapshot = await options.deliveryStore.snapshot();
    const deliveries = deliveryMap(snapshot);
    const byAttempt = new Map();
    for (const record of journalState.questions) {
      if (!record.deliveryIntent) continue;
      const id = record.deliveryIntent.deliveryAttemptId;
      if (byAttempt.has(id)) throw serviceError('question_delivery_mismatch');
      byAttempt.set(id, record);
    }
    for (const delivery of deliveries.values()) {
      if (delivery.kind !== 'question') continue;
      const record = byAttempt.get(delivery.deliveryAttemptId);
      if (!record) throw serviceError('question_journal_missing_for_delivery');
      if (!persistedDeliveryMatchesRecord(delivery, record)) throw serviceError('question_delivery_mismatch');
    }
    for (const record of journalState.questions) {
      if (!record.deliveryIntent) continue;
      const delivery = deliveries.get(record.deliveryIntent.deliveryAttemptId);
      if (delivery && (delivery.kind !== 'question' || !persistedDeliveryMatchesRecord(delivery, record))) {
        throw serviceError('question_delivery_mismatch');
      }
    }
    rescheduleTimer();
    return Object.freeze({ ready: true, revision: journalState.revision });
  }

  async function reconcileReclamation() {
    if (!journalState) throw serviceError('question_service_not_ready');
    journalState = kernel.normalizeJournal(await journal.load(), journal.maxRecords);
    await options.deliveryStore.ready;
    const snapshot = journal.getSnapshot();
    const byAttempt = new Map();
    for (const reservation of snapshot.reservations) {
      if (!reservation.deliveryIntent) continue;
      const id = reservation.deliveryIntent.deliveryAttemptId;
      if (byAttempt.has(id)) throw serviceError('question_delivery_mismatch');
      byAttempt.set(id, reservation);
    }
    const deliveries = deliveryMap(await options.deliveryStore.snapshot());
    for (const delivery of deliveries.values()) {
      if (delivery.kind !== 'question' || delivery.recordType === 'reclaimed') continue;
      const reservation = byAttempt.get(delivery.deliveryAttemptId);
      if (!reservation) throw serviceError('question_journal_missing_for_delivery');
      const record = currentQuestion(reservation.internalQuestionId);
      if (!record) throw serviceError('question_delivery_mismatch');
      const retired = isQuarantined(record) && reservation.quarantinedAt !== null &&
        reclamationOptions.periodGate.isRetired(reservation.identity, reservation.periodId);
      const matches = retired
        ? persistedDeliveryMatchesRecord(delivery, record)
        : deliveryMatchesRecord(delivery, record);
      if (!matches) throw serviceError('question_delivery_mismatch');
      if (reservation.deliveryCreationState === 'not_created' ||
          reservation.deliveryCreationState === 'indeterminate') {
        throw serviceError('question_delivery_creation_state_mismatch');
      }
    }
    for (const reservation of snapshot.reservations) {
      if (!reservation.deliveryIntent) continue;
      const delivery = deliveries.get(reservation.deliveryIntent.deliveryAttemptId);
      if (reservation.bodyState === 'reclaimed') continue;
      if (reservation.deliveryCreationState === 'creating') {
        throw serviceError('question_delivery_creation_not_recovered');
      }
      if (reservation.deliveryCreationState === 'checkpointed' && !delivery) {
        throw serviceError('question_delivery_missing');
      }
      if (reservation.deliveryCreationState === 'indeterminate' && delivery) {
        throw serviceError('question_delivery_creation_state_mismatch');
      }
      if (reservation.deliveryCreationState === 'not_created' && delivery) {
        throw serviceError('question_delivery_creation_state_mismatch');
      }
    }
    journal.assertCapacityReserved();
    rescheduleTimer();
    return Object.freeze({ ready: true, revision: journalState.revision });
  }

  function ready() {
    if (!initPromise) {
      if (reclamationMode && !journalState) return Promise.reject(serviceError('question_service_not_ready'));
      initPromise = (reclamationMode ? reconcileReclamation() : reconcile()).catch(async (error) => {
        blocked = true;
        startupError = error;
        rescheduleTimer();
        if (!reclamationMode) await journal.close().catch(() => {});
        throw error;
      });
    }
    return initPromise;
  }

  function rescheduleTimer() {
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    if (!accepting || blocked || !journalState) return;
    const at = nowValue();
    const settings = getAutoApplySettings();
    const awayState = currentAwayState();
    const delays = [];
    for (const record of journalState.questions) {
      if (isQuarantined(record)) continue;
      const deadline = autoApplyPolicyDeadline(record, awayState, settings, at);
      if (deadline === null) continue;
      if (deadline > at) {
        delays.push(deadline - at);
        continue;
      }
      const bindingStatus = currentExecutionBindingStatus(record);
      if (bindingStatus === 'ended') continue;
      delays.push(bindingStatus === 'current' ? 1_000 : AUTO_APPLY_BINDING_RECHECK_MS);
    }
    if (!delays.length) return;
    const delay = Math.min(2_147_483_647, Math.max(1_000, Math.min(...delays)));
    timer = setTimeoutImpl(() => {
      timer = null;
      let tokens;
      try { tokens = captureQuestionTokens(); }
      catch (error) {
        blocked = true;
        startupError = error;
        return;
      }
      void enqueue(() => tickNow(tokens)).catch(() => {});
    }, delay);
    timer?.unref?.();
  }

  async function createAnswerDelivery(record) {
    return createDeliveryFromIntent(record);
  }

  async function applyAnswers(record, answerInput, source, at) {
    const answers = kernel.normalizeAnswers(answerInput, record.questions);
    if (record.selection && kernel.sameAnswers(record.selection.answers, answers)) {
      return { outcome: 'duplicate', record };
    }
    const autoDeadline = autoApplyPolicyDeadline(record, currentAwayState(), getAutoApplySettings(), at);
    if (source === 'manual' && !record.selection && record.externalResolution === null &&
        record.cancelledAt === null && !record.held && autoDeadline !== null && autoDeadline <= at &&
        hasCurrentExecutionBinding(record)) {
      const defaulted = kernel.selectionFor(record, kernel.awayDefaultAnswers(record), 'away-default', at,
        crypto.randomUUID());
      const savedDefault = await commitRecord(defaulted.record);
      await createAnswerDelivery(savedDefault);
      const late = kernel.selectionFor(savedDefault, answers, 'manual', at, crypto.randomUUID());
      const savedLate = late.record === savedDefault ? savedDefault : await commitRecord(late.record);
      return { outcome: late.outcome === 'duplicate' ? 'duplicate' : 'late', record: savedLate };
    }
    const selected = kernel.selectionFor(record, answers, source, at, crypto.randomUUID());
    if (selected.record === record) return { outcome: selected.outcome, record };
    const saved = await commitRecord(selected.record);
    if (selected.outcome === 'selected') await createAnswerDelivery(saved);
    return { outcome: selected.outcome, record: saved };
  }

  async function maybeTimeout(record, at) {
    if (isQuarantined(record)) return record;
    const deadline = autoApplyPolicyDeadline(record, currentAwayState(), getAutoApplySettings(), at);
    if (deadline === null || deadline > at || !hasCurrentExecutionBinding(record)) return record;
    const selected = kernel.selectionFor(record, kernel.awayDefaultAnswers(record), 'away-default', at,
      crypto.randomUUID());
    const saved = await commitRecord(selected.record);
    await createAnswerDelivery(saved);
    return saved;
  }

  function captureQuestionTokens() {
    if (!reclamationMode) return null;
    const tokens = new Map();
    for (const record of journalState?.questions || []) {
      try {
        tokens.set(record.internalQuestionId,
          reclamationOptions.periodGate.capture(record.identity, record.periodId));
      } catch (error) {
        if (!['question_quarantined', 'question_gate_closed'].includes(error?.code)) throw error;
      }
    }
    return tokens;
  }

  async function tickNow(tokens = null) {
    const changed = [];
    try {
      const at = nowValue();
      for (const record of [...journalState.questions]) {
        const previousToken = activePeriodToken;
        if (reclamationMode) {
          activePeriodToken = tokens?.get(record.internalQuestionId) || null;
          if (activePeriodToken === null) {
            activePeriodToken = previousToken;
            continue;
          }
          try { reclamationOptions.periodGate.assertCurrent(activePeriodToken); }
          catch (error) {
            activePeriodToken = previousToken;
            if (['question_quarantined', 'question_gate_closed'].includes(error?.code)) continue;
            throw error;
          }
        }
        try {
        if (isQuarantined(record)) continue;
        if (record.deadlineAt > at || !kernel.canApplyAwayDefault(record)) continue;
        const saved = await maybeTimeout(record, at);
        if (saved !== record) changed.push(await projectRecord(saved));
        } finally {
          activePeriodToken = previousToken;
        }
      }
      return changed;
    } finally {
      rescheduleTimer();
    }
  }

  function captureWriter(input) {
    const writer = kernel.exactObject(input, WRITER_FIELDS, 'question_writer_unverified');
    const identity = kernel.exactObject(writer.identity, IDENTITY_FIELDS, 'question_writer_unverified');
    if (typeof identity.provider !== 'string') throw serviceError('question_writer_unverified');
    return { ...writer, identity: kernel.normalizeIdentity(identity) };
  }

  function deliveryQuestionResult(record, delivery) {
    return projection(record, delivery);
  }

  async function register(writerInput, input) {
    const writer = captureWriter(writerInput);
    const { token } = captureWriterPeriodToken(writer);
    const registration = kernel.exactObject(input, REGISTER_FIELDS, 'invalid_question_registration');
    if (!kernel.isIdentifier(registration.questionId) || !Number.isSafeInteger(registration.timeoutMinutes) ||
        registration.timeoutMinutes < 1 || registration.timeoutMinutes > 30) throw serviceError('invalid_question_registration');
    if (registration.category !== 'ordinary') throw serviceError('question_category_forbidden');
    const questions = kernel.normalizeQuestions(registration.questions);
    return enqueue(async () => {
      const live = findLiveWriter(writer);
      const existing = findQuestion(live.identity, live.periodId, registration.questionId);
      const reservation = reclamationMode
        ? journal.findReservation(live.identity, live.periodId, registration.questionId)
        : null;
      if (reservation && (reservation.bodyState === 'reclaimed' || reservation.quarantinedAt !== null)) {
        throw serviceError('question_quarantined');
      }
      if (reservation && !existing) throw serviceError('question_conflict');
      const digest = kernel.sha256Json({ category: 'ordinary', questions });
      if (existing) {
        assertNotQuarantined(existing);
        if (existing.contentDigest !== digest) throw serviceError('question_conflict');
        return { outcome: 'existing', question: await projectRecord(existing) };
      }
      let internalQuestionId = null;
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const candidateId = `cq-${crypto.randomUUID()}`;
        if (!reclamationMode || !journal.getReservation(candidateId)) {
          internalQuestionId = candidateId;
          break;
        }
      }
      if (internalQuestionId === null) throw serviceError('question_internal_id_unavailable');
      const record = kernel.createQuestionRecord({
        internalQuestionId,
        questionId: registration.questionId,
        identity: live.identity,
        periodId: live.periodId,
        executionId: live.executionId,
        conversationId: live.conversationId,
        launchRef: live.launchRef,
        executionBinding: live.executionBinding,
        category: 'ordinary',
        questions,
        timeoutMinutes: registration.timeoutMinutes,
        createdAt: nowValue(),
        autoApplyEnabledAtRegistration: getAutoApplySettings().enabled,
      });
      let saved;
      try { saved = await addRecord(record); }
      catch (error) {
        if (['question_capacity', 'journal_capacity_reserved', 'journal_too_large',
          'reclamation_capacity_exceeded'].includes(error.code)) {
          capacityRejected = true;
          throw serviceError('question_quarantine_capacity');
        }
        throw error;
      }
      capacityRejected = false;
      rescheduleTimer();
      const confirmed = findLiveWriter(writer);
      if (confirmed.launchRef !== live.launchRef || !sameBinding(confirmed.executionBinding, live.executionBinding)) {
        throw serviceError('question_writer_unverified');
      }
      return { outcome: 'created', question: await projectRecord(saved) };
    }, false, token);
  }

  async function status(writerInput, publicQuestionId) {
    const writer = captureWriter(writerInput);
    const { token } = captureWriterPeriodToken(writer);
    if (!kernel.isIdentifier(publicQuestionId)) throw serviceError('invalid_question_id');
    return enqueue(async () => {
      const live = findLiveWriter(writer);
      assertPublicQuestionReservation(live.identity, live.periodId, publicQuestionId);
      const record = findQuestion(live.identity, live.periodId, publicQuestionId);
      assertNotQuarantined(record);
      return record ? projectRecord(record) : null;
    }, false, token);
  }

  async function answerPoll(writerInput, publicQuestionId, trustedSink) {
    const writer = captureWriter(writerInput);
    const { token } = captureWriterPeriodToken(writer);
    if (!kernel.isIdentifier(publicQuestionId) || typeof trustedSink !== 'function') throw serviceError('invalid_answer_poll');
    return enqueue(async () => {
      const live = findLiveWriter(writer);
      assertPublicQuestionReservation(live.identity, live.periodId, publicQuestionId);
      const record = findQuestion(live.identity, live.periodId, publicQuestionId);
      if (!record) return { outcome: 'not_found', questionId: publicQuestionId,
        deliveryAttemptId: null, state: null };
      assertNotQuarantined(record);
      if (!record.deliveryIntent || record.cancelledAt !== null || record.externalResolution !== null ||
          suppressed.has(record.internalQuestionId)) {
        return { outcome: 'unavailable', ...await projectRecord(record) };
      }
      if (live.launchRef !== record.launchRef || !sameBinding(live.executionBinding, record.executionBinding)) {
        throw serviceError('question_writer_binding_mismatch');
      }
      const id = record.deliveryIntent.deliveryAttemptId;
      assertCurrentPeriod();
      let delivery = await options.deliveryStore.get(id);
      assertCurrentPeriod();
      if (!delivery) delivery = await createDeliveryFromIntent(record);
      if (!deliveryMatchesRecord(delivery, record)) throw serviceError('question_delivery_mismatch');
      if (!['available', 'claimed'].includes(delivery.state)) {
        return { outcome: 'already_started', ...deliveryQuestionResult(record, delivery) };
      }
      assertCurrentPeriod();
      await options.deliveryStore.rehydratePayload(id, deliveryPayload(record));
      assertCurrentPeriod();
      let sinkSuppressed = false;
      delivery = await options.deliveryStore.sendStart(id, (payload, metadata) => {
        if (suppressed.has(record.internalQuestionId)) {
          sinkSuppressed = true;
          return undefined;
        }
        const freshWriter = findLiveWriter(writer);
        if (freshWriter.launchRef !== record.launchRef || !sameBinding(freshWriter.executionBinding, record.executionBinding)) {
          throw serviceError('question_writer_unverified');
        }
        if (!metadata || metadata.deliveryAttemptId !== id ||
            metadata.payloadDigest !== record.deliveryIntent.payloadDigest || typeof payload !== 'string') {
          throw serviceError('question_delivery_digest_mismatch');
        }
        const parsed = JSON.parse(payload);
        if (kernel.sha256Json(parsed) !== metadata.payloadDigest) throw serviceError('question_delivery_digest_mismatch');
        const envelope = kernel.exactObject(parsed, ['questionId', 'revision', 'answers'], 'question_delivery_digest_mismatch');
        if (envelope.questionId !== record.questionId || envelope.revision !== record.deliveryIntent.revision) {
          throw serviceError('question_delivery_digest_mismatch');
        }
        const answers = kernel.normalizeAnswers(envelope.answers, record.questions);
        assertCurrentPeriod();
        const result = trustedSink(structuredClone(answers), Object.freeze({
          questionId: record.questionId,
          revision: record.deliveryIntent.revision,
          deliveryAttemptId: id,
        }));
        if (isThenable(result)) throw serviceError('question_sink_must_be_synchronous');
      });
      assertCurrentPeriod();
      if (sinkSuppressed) {
        assertCurrentPeriod();
        delivery = await options.deliveryStore.markUnknown(id);
        assertCurrentPeriod();
      }
      return { outcome: sinkSuppressed ? 'suppressed' : delivery.state === 'unknown' ? 'unknown' : 'sent',
        ...deliveryQuestionResult(record, delivery) };
    }, false, token);
  }

  async function submitAnswer(internalQuestionId, input) {
    if (!kernel.isIdentifier(internalQuestionId)) throw serviceError('invalid_internal_question_id');
    const token = captureInternalPeriodToken(internalQuestionId);
    const submission = kernel.exactObject(input, ['answers'], 'invalid_answer');
    let answers;
    try { answers = captureJson(submission.answers); }
    catch { throw serviceError('invalid_answer'); }
    return enqueue(async () => {
      const record = currentQuestion(internalQuestionId);
      if (!record) throw serviceError('question_not_found');
      assertNotQuarantined(record);
      if (record.cancelledAt !== null) throw serviceError('question_cancelled');
      const result = await applyAnswers(record, answers, 'manual', nowValue());
      rescheduleTimer();
      return { outcome: result.outcome, question: await projectRecord(result.record) };
    }, false, token);
  }

  async function hold(internalQuestionId, held) {
    if (!kernel.isIdentifier(internalQuestionId) || typeof held !== 'boolean') throw serviceError('invalid_question_hold');
    const token = captureInternalPeriodToken(internalQuestionId);
    return enqueue(async () => {
      const record = currentQuestion(internalQuestionId);
      if (!record) throw serviceError('question_not_found');
      assertNotQuarantined(record);
      if (record.held === held) return { outcome: held ? 'held' : 'released', question: await projectRecord(record) };
      const saved = await commitRecord({ ...record, held });
      rescheduleTimer();
      return { outcome: held ? 'held' : 'released', question: await projectRecord(saved) };
    }, false, token);
  }

  async function cancel(internalQuestionId) {
    if (!kernel.isIdentifier(internalQuestionId)) throw serviceError('invalid_internal_question_id');
    const token = captureInternalPeriodToken(internalQuestionId);
    return enqueue(async () => {
      const record = currentQuestion(internalQuestionId);
      if (!record) throw serviceError('question_not_found');
      assertNotQuarantined(record);
      if (record.cancelledAt !== null) return { outcome: 'cancelled', question: await projectRecord(record) };
      if (record.deliveryIntent) {
        assertCurrentPeriod();
        const current = await options.deliveryStore.get(record.deliveryIntent.deliveryAttemptId);
        assertCurrentPeriod();
        const alreadyStoppedForExternalResolution = record.externalResolution !== null &&
          current?.state === 'cancelled_before_send';
        if (current && ['applied', 'cancelled_before_send', 'superseded_before_send'].includes(current.state) &&
            !alreadyStoppedForExternalResolution) {
          return { outcome: current.state === 'cancelled_before_send' ? 'cancelled' : 'too_late',
            question: projection(record, current) };
        }
        if (current && !alreadyStoppedForExternalResolution) {
          assertCurrentPeriod();
          const updated = await options.deliveryStore.cancel(record.deliveryIntent.deliveryAttemptId);
          assertCurrentPeriod();
          if (['sending', 'accepted', 'applied', 'unknown'].includes(updated.state)) {
            return { outcome: updated.state === 'cancelled_before_send' ? 'cancelled' : 'too_late',
              question: projection(record, updated) };
          }
          if (!['cancelled_before_send', 'superseded_before_send'].includes(updated.state)) {
            throw serviceError('question_cancel_unconfirmed');
          }
        }
      }
      let saved;
      try { saved = await commitRecord({ ...record, cancelledAt: nowValue() }); }
      catch {
        blocked = true;
        startupError = serviceError('question_cancelled_journal_save_failed');
        rescheduleTimer();
        throw serviceError('question_cancelled_journal_save_failed');
      }
      rescheduleTimer();
      return { outcome: 'cancelled', question: await projectRecord(saved) };
    }, false, token);
  }

  async function resolveExternal(internalQuestionId, trustedEvidence) {
    if (!accepting) return Promise.reject(serviceError('question_service_closed'));
    if (!kernel.isIdentifier(internalQuestionId)) throw serviceError('invalid_internal_question_id');
    if (!journalState) return Promise.reject(serviceError('question_service_not_ready'));
    let token;
    try { token = captureInternalPeriodToken(internalQuestionId); }
    catch (error) { return Promise.reject(error); }
    const record = currentQuestion(internalQuestionId);
    if (!record) return Promise.reject(serviceError('question_not_found'));
    try { assertNotQuarantined(record); }
    catch (error) { return Promise.reject(error); }
    if (typeof options.verifyNativeQuestion !== 'function') return Promise.reject(serviceError('native_verifier_unavailable'));
    const evidence = captureJson(trustedEvidence);
    let verified;
    try {
      verified = options.verifyNativeQuestion(evidence, Object.freeze({
        internalQuestionId: record.internalQuestionId,
        questionId: record.questionId,
        identity: structuredClone(record.identity),
        periodId: record.periodId,
        launchRef: record.launchRef,
        revision: record.revision,
      }));
    } catch { return Promise.reject(serviceError('native_question_unverified')); }
    if (isThenable(verified) || verified !== true) return Promise.reject(serviceError('native_question_unverified'));
    try { if (token !== null) reclamationOptions.periodGate.assertCurrent(token); }
    catch (error) { return Promise.reject(error); }
    suppressed.add(internalQuestionId);
    return enqueue(async () => {
      const current = currentQuestion(internalQuestionId);
      if (!current) throw serviceError('question_not_found');
      assertNotQuarantined(current);
      if (current.externalResolution) return { outcome: 'existing', question: await projectRecord(current) };
      if (current.deliveryIntent) {
        assertCurrentPeriod();
        let delivery = await options.deliveryStore.get(current.deliveryIntent.deliveryAttemptId);
        assertCurrentPeriod();
        if (delivery && ['available', 'claimed', 'sending', 'accepted'].includes(delivery.state)) {
          assertCurrentPeriod();
          delivery = await options.deliveryStore.cancel(current.deliveryIntent.deliveryAttemptId);
          assertCurrentPeriod();
          if (['sending', 'accepted'].includes(delivery.state)) {
            assertCurrentPeriod();
            delivery = await options.deliveryStore.markUnknown(current.deliveryIntent.deliveryAttemptId);
            assertCurrentPeriod();
          }
        }
      }
      const saved = await commitRecord({ ...current, externalResolution: {
        resolvedAt: nowValue(), evidenceDigest: kernel.sha256Json(evidence),
      } });
      rescheduleTimer();
      return { outcome: 'resolved', question: await projectRecord(saved) };
    }, false, token);
  }

  async function reportResponseLost(internalQuestionId) {
    if (!kernel.isIdentifier(internalQuestionId)) throw serviceError('invalid_internal_question_id');
    const token = captureInternalPeriodToken(internalQuestionId);
    return enqueue(async () => {
      const record = currentQuestion(internalQuestionId);
      assertNotQuarantined(record);
      if (!record?.deliveryIntent) throw serviceError('question_not_found');
      assertCurrentPeriod();
      const current = await options.deliveryStore.get(record.deliveryIntent.deliveryAttemptId);
      assertCurrentPeriod();
      if (!current || !deliveryMatchesRecord(current, record)) throw serviceError('question_delivery_mismatch');
      let delivery = current;
      if (['sending', 'accepted'].includes(current.state)) {
        assertCurrentPeriod();
        delivery = await options.deliveryStore.markUnknown(current.deliveryAttemptId);
      }
      assertCurrentPeriod();
      return { outcome: delivery.state === 'unknown' ? 'unknown' : 'unchanged',
        question: projection(record, delivery) };
    }, false, token);
  }

  async function dashboardSnapshot() {
    return enqueue(async () => {
      if (!journalState) return { version: 1, questions: [], recovery: {
        state: 'blocked', code: startupError?.code || 'question_journal_unavailable',
      } };
      let recovery = blocked ? { state: 'blocked', code: startupError?.code || 'question_writer_blocked' } : null;
      let deliveries = new Map();
      let reservations = new Map();
      let questionDetails = new Map();
      try { deliveries = deliveryMap(await options.deliveryStore.snapshot()); }
      catch (error) {
        recovery ||= { state: 'blocked', code: error?.code || 'delivery_store_unavailable' };
      }
      if (reclamationMode) {
        try {
          const snapshot = journal.getSnapshot();
          reservations = new Map(snapshot.reservations.map((reservation) =>
            [reservation.internalQuestionId, reservation]));
          questionDetails = new Map(snapshot.questions.map((detail) =>
            [detail.internalQuestionId, detail]));
        } catch (error) {
          recovery ||= { state: 'blocked', code: error?.code || 'question_reservation_unavailable' };
        }
      }
      const questions = journalState.questions.map((record) => {
        const delivery = record.deliveryIntent ? deliveries.get(record.deliveryIntent.deliveryAttemptId) : null;
        try {
          if (delivery?.recordType === 'reclaimed') {
            const detail = questionDetails.get(record.internalQuestionId);
            if (!isQuarantined(record) || !reclamationOptions?.periodGate.isRetired(record.identity, record.periodId) ||
                !detail || !reclaimedDeliveryMatchesRecord(delivery, detail,
                  reservations.get(record.internalQuestionId))) {
              throw serviceError('question_delivery_mismatch');
            }
            return projection(record, null, true);
          }
          const matches = isQuarantined(record)
            ? persistedDeliveryMatchesRecord(delivery, record)
            : deliveryMatchesRecord(delivery, record);
          if (delivery && !matches) throw serviceError('question_delivery_mismatch');
          return projection(record, delivery, true);
        } catch (error) {
          recovery ||= { state: 'blocked', code: error?.code || 'question_delivery_mismatch' };
          return projection(record, null, true);
        }
      });
      return { version: 1, questions, recovery };
    }, true);
  }

  async function readLateAnswerDraft(internalQuestionId, index, digest) {
    if (!kernel.isIdentifier(internalQuestionId) || !Number.isSafeInteger(index) || index < 0 ||
        typeof digest !== 'string' || !/^[a-f0-9]{64}$/.test(digest)) {
      throw serviceError('invalid_late_answer_ref');
    }
    const token = captureInternalPeriodToken(internalQuestionId);
    return enqueue(() => {
      const record = currentQuestion(internalQuestionId);
      const late = record?.lateAnswers[index];
      assertNotQuarantined(record);
      if (!record || late?.digest !== digest) return null;
      const answers = new Map(late.answers.map((answer) => [answer.questionId, answer]));
      const text = record.questions.map((question) => {
        const answer = answers.get(question.id);
        if (!answer) throw serviceError('invalid_late_answer_ref');
        const values = answer.optionIds.map((id) => question.options.find((option) => option.id === id)?.label);
        if (answer.freeText !== null) values.push(answer.freeText);
        return `${question.text}\n${values.map((value) => `- ${value}`).join('\n')}`;
      }).join('\n\n');
      return {
        launchRef: record.launchRef,
        logicalMessageId: `common-question-${record.internalQuestionId}`,
        revision: record.revision,
        text,
      };
    }, true, token);
  }

  function tick() {
    const tokens = captureQuestionTokens();
    return enqueue(() => tickNow(tokens), false);
  }

  function notifyAwayChanged() {
    const tokens = captureQuestionTokens();
    return enqueue(() => tickNow(tokens), false);
  }

  function flush() {
    if (!accepting) return Promise.reject(serviceError('question_service_closed'));
    if (reclamationMode && writerStopped) return Promise.reject(serviceError('question_gate_closed'));
    return tail.then(() => ready()).then(() => Promise.all([
      journal.flush(),
      typeof options.deliveryStore.flush === 'function' ? options.deliveryStore.flush() : Promise.resolve(),
    ])).then(() => undefined);
  }

  function stopReclamationWriter() {
    if (!reclamationMode) return;
    writerStopped = true;
    journal.stop();
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
  }

  function drainReclamationWriter() {
    if (!reclamationMode) return Promise.reject(serviceError('question_reclamation_unavailable'));
    return tail;
  }

  function prepareReclamationWriter(fullSnapshot) {
    if (!reclamationMode || !accepting || !writerStopped || pendingOperations !== 0) {
      throw serviceError('invalid_question_resume_state');
    }
    const prepared = journal.prepareResume(fullSnapshot);
    journalState = journal.getLegacySnapshot();
    refreshQuarantinedQuestionIds();
    blocked = false;
    startupError = null;
    initPromise = null;
    writerStopped = false;
    return prepared;
  }

  async function withRetirementSnapshot(ticket, callback) {
    if (!reclamationMode || typeof callback !== 'function') throw serviceError('question_reclamation_unavailable');
    if (retirementStorage.getStore() === retirementScope) throw serviceError('question_retirement_queue_reentry');
    if (!accepting || writerStopped) throw serviceError('question_gate_closed');
    pendingOperations += 1;
    const queued = tail.then(async () => {
      if (!journalState) throw serviceError('question_service_not_ready');
      reclamationOptions.periodGate.assertRetirement(ticket);
      let accessOpen = true;
      const assertAccess = () => {
        if (!accessOpen || retirementStorage.getStore() !== retirementScope) {
          throw serviceError('question_retirement_access_expired');
        }
        reclamationOptions.periodGate.assertRetirement(ticket);
      };
      const access = Object.freeze({
        snapshot() {
          assertAccess();
          return journal.getSnapshot();
        },
        async persist(candidate) {
          assertAccess();
          const saved = await journal.persistRetirement(candidate, ticket);
          journalState = journal.getLegacySnapshot();
          refreshQuarantinedQuestionIds();
          return saved;
        },
      });
      try {
        return await retirementStorage.run(retirementScope, () => callback(access));
      } finally {
        accessOpen = false;
      }
    });
    const result = queued.finally(() => { pendingOperations -= 1; });
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function withRetiredQuestionBodies(value, callback) {
    if (!reclamationMode || typeof callback !== 'function') {
      throw serviceError('question_reclamation_unavailable');
    }
    const captured = kernel.exactObject(value, ['identity', 'periodId'], 'invalid_question_body_reclamation');
    const request = Object.freeze({
      identity: Object.freeze(kernel.exactObject(captured.identity, IDENTITY_FIELDS,
        'invalid_question_body_reclamation')),
      periodId: captured.periodId,
    });
    if (retirementStorage.getStore() === retirementScope) {
      throw serviceError('question_retirement_queue_reentry');
    }
    const assertRetired = () => {
      if (!accepting || writerStopped || !journalState || !sharedWriterCanWrite() ||
          !reclamationOptions.periodGate.isRetired(request.identity, request.periodId)) {
        throw serviceError('question_period_not_retired');
      }
    };
    assertRetired();
    pendingOperations += 1;
    const queued = tail.then(async () => {
      assertRetired();
      let accessOpen = true;
      const assertAccess = () => {
        if (!accessOpen || retirementStorage.getStore() !== retirementScope) {
          throw serviceError('question_retirement_access_expired');
        }
        assertRetired();
      };
      const access = Object.freeze({
        snapshot() {
          assertAccess();
          return journal.getSnapshot();
        },
        async persist(internalQuestionId, candidate) {
          assertAccess();
          const saved = await journal.persistBodyReclamation(candidate, request.identity, request.periodId,
            internalQuestionId, assertAccess);
          journalState = journal.getLegacySnapshot();
          refreshQuarantinedQuestionIds();
          return saved;
        },
      });
      try {
        return await retirementStorage.run(retirementScope, () => callback(access));
      } finally {
        accessOpen = false;
      }
    });
    const result = queued.finally(() => { pendingOperations -= 1; });
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function close() {
    if (closePromise) return closePromise;
    accepting = false;
    if (reclamationMode) stopReclamationWriter();
    if (timer !== null) {
      clearTimeoutImpl(timer);
      timer = null;
    }
    closePromise = tail.then(() => initPromise ? initPromise.catch(() => undefined) : undefined)
      .then(() => Promise.all([
        journal.close(),
        typeof options.deliveryStore.flush === 'function'
          ? options.deliveryStore.flush().catch(() => {}) : Promise.resolve(),
      ]));
    return closePromise;
  }

  const api = { ready, register, status, answerPoll, submitAnswer, hold, cancel, tick, notifyAwayChanged,
    resolveExternal, reportResponseLost, dashboardSnapshot, readLateAnswerDraft,
    getQuarantineDiagnostics, flush, close };
  if (reclamationMode) {
    api.reclamationWriter = Object.freeze({
      stop: stopReclamationWriter,
      drain: drainReclamationWriter,
      prepareResume: prepareReclamationWriter,
    });
    api.withRetirementSnapshot = withRetirementSnapshot;
    api.withRetiredQuestionBodies = withRetiredQuestionBodies;
  }
  return Object.freeze(api);
}

module.exports = { DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS, createCommonQuestionService };
