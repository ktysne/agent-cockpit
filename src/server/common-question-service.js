'use strict';

const crypto = require('node:crypto');
const { types: utilTypes } = require('node:util');
const kernel = require('./common-question-kernel');
const { createCommonQuestionJournal } = require('./common-question-journal');
const nativePromiseThen = Promise.prototype.then;

const WRITER_FIELDS = ['token', 'identity', 'contextId', 'executionId'];
const REGISTER_FIELDS = ['questionId', 'questions', 'timeoutMinutes', 'category'];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const CLAIM_FIELDS = ['launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'origin', 'purpose', 'originBinding'];
const CONNECTION_SCOPE_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId'];
const MAX_EXTERNAL_EVIDENCE_BYTES = 64 * 1024;

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
  if (!options || typeof options !== 'object' || Array.isArray(options) || typeof options.journalPath !== 'string' ||
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
      (options.verifyNativeQuestion !== undefined && typeof options.verifyNativeQuestion !== 'function') ||
      (options.atomicWrite !== undefined && typeof options.atomicWrite !== 'function') ||
      (options.setTimeoutImpl !== undefined && typeof options.setTimeoutImpl !== 'function') ||
      (options.clearTimeoutImpl !== undefined && typeof options.clearTimeoutImpl !== 'function')) {
    throw serviceError('invalid_question_service_dependencies');
  }
  const journal = createCommonQuestionJournal({ filePath: options.journalPath,
    ...(options.atomicWrite ? { atomicWrite: options.atomicWrite } : {}),
    ...(options.maxBytes !== undefined ? { maxBytes: options.maxBytes } : {}),
    ...(options.maxRecords !== undefined ? { maxRecords: options.maxRecords } : {}),
    ...(options.fileSystem ? { fileSystem: options.fileSystem } : {}),
  });
  const now = options.now || Date.now;
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
  const suppressed = new Set();

  function nowValue() {
    let value;
    try { value = now(); } catch { throw serviceError('clock_unavailable'); }
    if (!Number.isSafeInteger(value) || value < 0) throw serviceError('clock_unavailable');
    return value;
  }

  function enqueue(operation, diagnostic = false) {
    if (!accepting) return Promise.reject(serviceError('question_service_closed'));
    const result = tail.then(async () => {
      try { await ready(); } catch (error) { if (!diagnostic) throw error; }
      if (blocked && !diagnostic) throw serviceError('question_writer_blocked');
      return operation();
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function findQuestion(identity, periodId, id) {
    const key = kernel.questionKey(identity, periodId, id);
    return journalState.questions.find((record) =>
      kernel.questionKey(record.identity, record.periodId, record.questionId) === key) || null;
  }

  function currentQuestion(id) {
    return journalState?.questions.find((record) => record.internalQuestionId === id) || null;
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

  async function createDeliveryFromIntent(record) {
    const payload = deliveryPayload(record);
    if (kernel.sha256Json(JSON.parse(payload)) !== record.deliveryIntent.payloadDigest) {
      throw serviceError('question_delivery_digest_mismatch');
    }
    const current = await options.deliveryStore.get(record.deliveryIntent.deliveryAttemptId);
    if (current) {
      if (!deliveryMatchesRecord(current, record)) throw serviceError('question_delivery_mismatch');
      return current;
    }
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
      cancelled: record.cancelledAt !== null || (record.externalResolution === null && delivery?.state === 'cancelled_before_send'),
      cancelRequested: delivery?.cancelRequested === true,
      cancelHistoryMissing: record.externalResolution === null && delivery?.state === 'cancelled_before_send' && record.cancelledAt === null,
    };
    return result;
  }

  async function projectRecord(record, dashboard = false) {
    const delivery = record.deliveryIntent ? await options.deliveryStore.get(record.deliveryIntent.deliveryAttemptId) : null;
    if (delivery && !deliveryMatchesRecord(delivery, record)) throw serviceError('question_delivery_mismatch');
    return projection(record, delivery, dashboard);
  }

  async function saveCandidate(candidate, internalQuestionId) {
    try {
      const saved = await journal.save(candidate);
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

  async function reconcile() {
    journalState = kernel.normalizeJournal(await journal.load(), journal.maxRecords);
    await options.deliveryStore.ready;
    journal.assertCapacityReserved(journalState);
    const snapshot = await options.deliveryStore.snapshot();
    const deliveries = deliveryMap(snapshot);
    const byAttempt = new Map(journalState.questions.filter((record) => record.deliveryIntent)
      .map((record) => [record.deliveryIntent.deliveryAttemptId, record]));
    for (const delivery of snapshot.deliveries) {
      if (/^common-question-cq-[a-f0-9-]{36}$/.test(delivery.logicalMessageId || '')) {
        const record = byAttempt.get(delivery.deliveryAttemptId);
        if (!record || record.deliveryIntent.logicalMessageId !== delivery.logicalMessageId ||
            !deliveryMatchesRecord(delivery, record)) throw serviceError('question_journal_missing_for_delivery');
      }
    }
    for (const record of journalState.questions) validatePersistedBinding(record);
    for (const record of journalState.questions) {
      if (!record.deliveryIntent) continue;
      let delivery = deliveries.get(record.deliveryIntent.deliveryAttemptId) ||
        await options.deliveryStore.get(record.deliveryIntent.deliveryAttemptId);
      if (!delivery && record.cancelledAt === null && record.externalResolution === null) {
        const runtime = syncCall(options.runtimeRegistry, 'snapshot', [], 'question_binding_unavailable');
        const candidates = runtime.actors.filter((actor) => actor.state === 'active' &&
          actor.launchRef === record.launchRef && actor.periodId === record.periodId &&
          sameIdentity(actor.identity, record.identity) &&
          sameBinding({ periodId: actor.periodId, actor: actor.actor }, record.executionBinding) &&
          connectionIsCurrent(actor, runtime));
        if (candidates.length === 1) delivery = await createDeliveryFromIntent(record);
      }
      if (!delivery) continue;
      if (!deliveryMatchesRecord(delivery, record)) throw serviceError('question_delivery_mismatch');
      if (['available', 'claimed'].includes(delivery.state) && record.cancelledAt === null &&
          record.externalResolution === null) {
        try {
          await options.deliveryStore.rehydratePayload(record.deliveryIntent.deliveryAttemptId, deliveryPayload(record));
        } catch (error) {
          if (!['delivery_target_unavailable', 'payload_rehydrate_forbidden'].includes(error.code)) throw error;
        }
      }
    }
    rescheduleTimer();
    return Object.freeze({ ready: true, revision: journalState.revision });
  }

  function ready() {
    if (!initPromise) {
      initPromise = reconcile().catch(async (error) => {
        blocked = true;
        startupError = error;
        rescheduleTimer();
        await journal.close().catch(() => {});
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
    const pending = journalState.questions.filter(kernel.canApplyAwayDefault);
    const deadlines = pending.map((record) => record.deadlineAt).filter((deadline) => deadline > at);
    const hasExpiredPending = pending.some((record) => record.deadlineAt <= at);
    if (!deadlines.length && !hasExpiredPending) return;
    const delay = hasExpiredPending ? 1_000 : Math.min(2_147_483_647, Math.min(...deadlines) - at);
    timer = setTimeoutImpl(() => {
      timer = null;
      void enqueue(tickNow).catch(() => {});
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
    if (source === 'manual' && !record.selection && record.externalResolution === null &&
        record.cancelledAt === null && !record.held && record.deadlineAt <= at &&
        options.away.snapshot()?.enabled === true && kernel.canApplyAwayDefault(record)) {
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
    if (options.away.snapshot()?.enabled !== true || record.deadlineAt > at || !kernel.canApplyAwayDefault(record)) {
      return record;
    }
    const selected = kernel.selectionFor(record, kernel.awayDefaultAnswers(record), 'away-default', at,
      crypto.randomUUID());
    const saved = await commitRecord(selected.record);
    await createAnswerDelivery(saved);
    return saved;
  }

  async function tickNow() {
    const changed = [];
    try {
      const at = nowValue();
      for (const record of [...journalState.questions]) {
        if (record.deadlineAt > at || !kernel.canApplyAwayDefault(record)) continue;
        const saved = await maybeTimeout(record, at);
        if (saved !== record) changed.push(await projectRecord(saved));
      }
      return changed;
    } finally {
      rescheduleTimer();
    }
  }

  function captureWriter(input) {
    const writer = kernel.exactObject(input, WRITER_FIELDS, 'question_writer_unverified');
    return { ...writer, identity: kernel.normalizeIdentity(writer.identity) };
  }

  function deliveryQuestionResult(record, delivery) {
    return projection(record, delivery);
  }

  async function register(writerInput, input) {
    const writer = captureWriter(writerInput);
    const registration = kernel.exactObject(input, REGISTER_FIELDS, 'invalid_question_registration');
    if (!kernel.isIdentifier(registration.questionId) || !Number.isSafeInteger(registration.timeoutMinutes) ||
        registration.timeoutMinutes < 1 || registration.timeoutMinutes > 30) throw serviceError('invalid_question_registration');
    if (registration.category !== 'ordinary') throw serviceError('question_category_forbidden');
    const questions = kernel.normalizeQuestions(registration.questions);
    return enqueue(async () => {
      const live = findLiveWriter(writer);
      const existing = findQuestion(live.identity, live.periodId, registration.questionId);
      const digest = kernel.sha256Json({ category: 'ordinary', questions });
      if (existing) {
        if (existing.contentDigest !== digest) throw serviceError('question_conflict');
        return { outcome: 'existing', question: await projectRecord(existing) };
      }
      const record = kernel.createQuestionRecord({
        internalQuestionId: `cq-${crypto.randomUUID()}`,
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
      });
      const saved = await addRecord(record);
      rescheduleTimer();
      const confirmed = findLiveWriter(writer);
      if (confirmed.launchRef !== live.launchRef || !sameBinding(confirmed.executionBinding, live.executionBinding)) {
        throw serviceError('question_writer_unverified');
      }
      return { outcome: 'created', question: await projectRecord(saved) };
    });
  }

  async function status(writerInput, publicQuestionId) {
    const writer = captureWriter(writerInput);
    if (!kernel.isIdentifier(publicQuestionId)) throw serviceError('invalid_question_id');
    return enqueue(async () => {
      const live = findLiveWriter(writer);
      const record = findQuestion(live.identity, live.periodId, publicQuestionId);
      return record ? projectRecord(record) : null;
    });
  }

  async function answerPoll(writerInput, publicQuestionId, trustedSink) {
    const writer = captureWriter(writerInput);
    if (!kernel.isIdentifier(publicQuestionId) || typeof trustedSink !== 'function') throw serviceError('invalid_answer_poll');
    return enqueue(async () => {
      const live = findLiveWriter(writer);
      const record = findQuestion(live.identity, live.periodId, publicQuestionId);
      if (!record) return { outcome: 'not_found', questionId: publicQuestionId,
        deliveryAttemptId: null, state: null };
      if (!record.deliveryIntent || record.cancelledAt !== null || record.externalResolution !== null ||
          suppressed.has(record.internalQuestionId)) {
        return { outcome: 'unavailable', ...await projectRecord(record) };
      }
      if (live.launchRef !== record.launchRef || !sameBinding(live.executionBinding, record.executionBinding)) {
        throw serviceError('question_writer_binding_mismatch');
      }
      const id = record.deliveryIntent.deliveryAttemptId;
      let delivery = await options.deliveryStore.get(id);
      if (!delivery) delivery = await createDeliveryFromIntent(record);
      if (!deliveryMatchesRecord(delivery, record)) throw serviceError('question_delivery_mismatch');
      if (!['available', 'claimed'].includes(delivery.state)) {
        return { outcome: 'already_started', ...deliveryQuestionResult(record, delivery) };
      }
      await options.deliveryStore.rehydratePayload(id, deliveryPayload(record));
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
        const result = trustedSink(structuredClone(answers), Object.freeze({
          questionId: record.questionId,
          revision: record.deliveryIntent.revision,
          deliveryAttemptId: id,
        }));
        if (isThenable(result)) throw serviceError('question_sink_must_be_synchronous');
      });
      if (sinkSuppressed) delivery = await options.deliveryStore.markUnknown(id);
      return { outcome: sinkSuppressed ? 'suppressed' : delivery.state === 'unknown' ? 'unknown' : 'sent',
        ...deliveryQuestionResult(record, delivery) };
    });
  }

  async function submitAnswer(internalQuestionId, input) {
    if (!kernel.isIdentifier(internalQuestionId)) throw serviceError('invalid_internal_question_id');
    const submission = kernel.exactObject(input, ['answers'], 'invalid_answer');
    let answers;
    try { answers = captureJson(submission.answers); }
    catch { throw serviceError('invalid_answer'); }
    return enqueue(async () => {
      const record = currentQuestion(internalQuestionId);
      if (!record) throw serviceError('question_not_found');
      if (record.cancelledAt !== null) throw serviceError('question_cancelled');
      const result = await applyAnswers(record, answers, 'manual', nowValue());
      rescheduleTimer();
      return { outcome: result.outcome, question: await projectRecord(result.record) };
    });
  }

  async function hold(internalQuestionId, held) {
    if (!kernel.isIdentifier(internalQuestionId) || typeof held !== 'boolean') throw serviceError('invalid_question_hold');
    return enqueue(async () => {
      const record = currentQuestion(internalQuestionId);
      if (!record) throw serviceError('question_not_found');
      if (record.held === held) return { outcome: held ? 'held' : 'released', question: await projectRecord(record) };
      const saved = await commitRecord({ ...record, held });
      rescheduleTimer();
      return { outcome: held ? 'held' : 'released', question: await projectRecord(saved) };
    });
  }

  async function cancel(internalQuestionId) {
    if (!kernel.isIdentifier(internalQuestionId)) throw serviceError('invalid_internal_question_id');
    return enqueue(async () => {
      const record = currentQuestion(internalQuestionId);
      if (!record) throw serviceError('question_not_found');
      if (record.cancelledAt !== null) return { outcome: 'cancelled', question: await projectRecord(record) };
      if (record.deliveryIntent) {
        const current = await options.deliveryStore.get(record.deliveryIntent.deliveryAttemptId);
        if (current && ['applied', 'cancelled_before_send', 'superseded_before_send'].includes(current.state)) {
          return { outcome: current.state === 'cancelled_before_send' ? 'cancelled' : 'too_late',
            question: projection(record, current) };
        }
        if (current) {
          const updated = await options.deliveryStore.cancel(record.deliveryIntent.deliveryAttemptId);
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
    });
  }

  async function resolveExternal(internalQuestionId, trustedEvidence) {
    if (!accepting) return Promise.reject(serviceError('question_service_closed'));
    if (!kernel.isIdentifier(internalQuestionId)) throw serviceError('invalid_internal_question_id');
    if (!journalState) return Promise.reject(serviceError('question_service_not_ready'));
    const record = currentQuestion(internalQuestionId);
    if (!record) return Promise.reject(serviceError('question_not_found'));
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
    suppressed.add(internalQuestionId);
    return enqueue(async () => {
      const current = currentQuestion(internalQuestionId);
      if (!current) throw serviceError('question_not_found');
      if (current.externalResolution) return { outcome: 'existing', question: await projectRecord(current) };
      if (current.deliveryIntent) {
        let delivery = await options.deliveryStore.get(current.deliveryIntent.deliveryAttemptId);
        if (delivery && ['available', 'claimed', 'sending', 'accepted'].includes(delivery.state)) {
          delivery = await options.deliveryStore.cancel(current.deliveryIntent.deliveryAttemptId);
          if (['sending', 'accepted'].includes(delivery.state)) {
            delivery = await options.deliveryStore.markUnknown(current.deliveryIntent.deliveryAttemptId);
          }
        }
      }
      const saved = await commitRecord({ ...current, externalResolution: {
        resolvedAt: nowValue(), evidenceDigest: kernel.sha256Json(evidence),
      } });
      rescheduleTimer();
      return { outcome: 'resolved', question: await projectRecord(saved) };
    });
  }

  async function reportResponseLost(internalQuestionId) {
    if (!kernel.isIdentifier(internalQuestionId)) throw serviceError('invalid_internal_question_id');
    return enqueue(async () => {
      const record = currentQuestion(internalQuestionId);
      if (!record?.deliveryIntent) throw serviceError('question_not_found');
      const current = await options.deliveryStore.get(record.deliveryIntent.deliveryAttemptId);
      if (!current || !deliveryMatchesRecord(current, record)) throw serviceError('question_delivery_mismatch');
      const delivery = ['sending', 'accepted'].includes(current.state)
        ? await options.deliveryStore.markUnknown(current.deliveryAttemptId)
        : current;
      return { outcome: delivery.state === 'unknown' ? 'unknown' : 'unchanged',
        question: projection(record, delivery) };
    });
  }

  async function dashboardSnapshot() {
    return enqueue(async () => {
      if (!journalState) return { version: 1, questions: [], recovery: {
        state: 'blocked', code: startupError?.code || 'question_journal_unavailable',
      } };
      let recovery = blocked ? { state: 'blocked', code: startupError?.code || 'question_writer_blocked' } : null;
      let deliveries = new Map();
      try { deliveries = deliveryMap(await options.deliveryStore.snapshot()); }
      catch (error) {
        recovery ||= { state: 'blocked', code: error?.code || 'delivery_store_unavailable' };
      }
      const questions = journalState.questions.map((record) => {
        const delivery = record.deliveryIntent ? deliveries.get(record.deliveryIntent.deliveryAttemptId) : null;
        try {
          if (delivery && !deliveryMatchesRecord(delivery, record)) throw serviceError('question_delivery_mismatch');
          return projection(record, delivery, true);
        } catch (error) {
          recovery ||= { state: 'blocked', code: error?.code || 'question_delivery_mismatch' };
          return projection(record, null, true);
        }
      });
      return { version: 1, questions, recovery };
    }, true);
  }

  function tick() {
    return enqueue(tickNow);
  }

  function flush() {
    if (!accepting) return Promise.reject(serviceError('question_service_closed'));
    return tail.then(() => ready()).then(() => Promise.all([
      journal.flush(),
      typeof options.deliveryStore.flush === 'function' ? options.deliveryStore.flush() : Promise.resolve(),
    ])).then(() => undefined);
  }

  function close() {
    if (closePromise) return closePromise;
    accepting = false;
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

  return Object.freeze({ ready, register, status, answerPoll, submitAnswer, hold, cancel, tick,
    resolveExternal, reportResponseLost, dashboardSnapshot, flush, close });
}

module.exports = { createCommonQuestionService };
