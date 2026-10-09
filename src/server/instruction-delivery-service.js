'use strict';

const { types: utilTypes } = require('node:util');
const {
  createInstructionEnvelope,
  instructionError,
  isIdentifier,
  isSha256Digest,
} = require('./instruction-envelope');
const {
  appendInstructionIntent,
  appendInstructionIntentV2,
  createEmptyJournal,
  normalizeInstructionRecord,
  sourceProjectionFromDelivery,
  sourceProjectionFromLaunch,
  updateInstructionCreationStateV2,
} = require('./instruction-delivery-journal');
const {
  normalizeInstructionJournalV2Local,
  normalizeInstructionRecordV2Local,
} = require('./delivery-reclamation-codec');
const { createInstructionInputCorrelator } = require('./instruction-input-correlator');

const PROVIDERS = new Set(['claude', 'codex']);
const INPUT_FIELDS = [
  'deliveryAttemptId', 'launchRef', 'logicalMessageId', 'revision', 'text', 'mode', 'expectedTurnId',
];
const ALTERNATIVE_FIELDS = [
  'newDeliveryAttemptId', 'logicalMessageId', 'revision', 'text', 'mode', 'expectedTurnId',
];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const CORRELATION_FIELDS = [
  'deliveryAttemptId', 'revision', 'payloadDigest', 'targetPeriodId',
  'nativeTurnId', 'nativeItemId', 'clientRequestId',
];
const SHA256 = /^[a-f0-9]{64}$/;

function serviceError(code) {
  const error = instructionError(code);
  error.message = 'instruction delivery operation rejected';
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

function exactObject(value, fields, code = 'instruction_invalid_request') {
  if (!isRecord(value)) throw serviceError(code);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { throw serviceError(code); }
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
    throw serviceError(code);
  }
  const result = {};
  for (const field of fields) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); } catch { throw serviceError(code); }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw serviceError(code);
    result[field] = descriptor.value;
  }
  return result;
}

function dataMethod(target, method) {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return null;
  let current = target;
  for (let depth = 0; current && depth < 8; depth += 1) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(current, method); } catch { return null; }
    if (descriptor) return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
      ? descriptor.value : null;
    try { current = Object.getPrototypeOf(current); } catch { return null; }
  }
  return null;
}

function readData(object, key, code = 'instruction_target_unverified') {
  if (!isRecord(object)) throw serviceError(code);
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(object, key); } catch { throw serviceError(code); }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw serviceError(code);
  return descriptor.value;
}

function isPromise(value) {
  return utilTypes.isPromise(value);
}

function freezeTree(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) freezeTree(descriptor.value);
  }
  return Object.freeze(value);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function targetProjection(delivery) {
  const target = readData(delivery, 'target');
  const fields = ['kind', 'launchRef', 'claims', 'identity', 'periodId', 'actor', 'conversationId', 'sessionId'];
  const captured = exactObject(target, fields, 'instruction_delivery_mismatch');
  return captured;
}

function deliveryCorrelation(delivery, turnId, itemId = null) {
  return {
    deliveryAttemptId: delivery.deliveryAttemptId,
    revision: delivery.revision,
    payloadDigest: delivery.payloadDigest,
    targetPeriodId: delivery.target.periodId,
    nativeTurnId: turnId,
    nativeItemId: itemId,
    clientRequestId: delivery.deliveryAttemptId,
  };
}

function deliveryMatchesRecord(delivery, record) {
  if (!delivery || delivery.kind !== 'instruction' ||
      delivery.deliveryAttemptId !== record.deliveryAttemptId ||
      delivery.logicalMessageId !== record.logicalMessageId || delivery.revision !== record.revision ||
      delivery.payloadDigest !== record.envelopeDigest ||
      delivery.sourceExecutionId !== record.source.executionBinding.periodId) return false;
  try {
    const source = sourceProjectionFromDelivery(delivery);
    const target = targetProjection(delivery);
    const expectedTarget = {
      kind: 'execution',
      launchRef: record.source.launchRef,
      claims: record.source.claims,
      identity: record.source.identity,
      periodId: record.source.executionBinding.periodId,
      actor: record.source.executionBinding.actor,
      conversationId: record.source.conversationId,
      sessionId: record.source.sessionId,
    };
    return sameJson(source, record.source) && sameJson(target, expectedTarget);
  } catch {
    return false;
  }
}

function createInstructionDeliveryService(options = {}) {
  if (!isRecord(options)) throw serviceError('invalid_instruction_service_dependencies');
  let optionKeys;
  try { optionKeys = Reflect.ownKeys(options); } catch { throw serviceError('invalid_instruction_service_dependencies'); }
  const allowedOptions = ['journal', 'deliveryStore', 'providerInstructionAdapters', 'launchRegistry', 'now'];
  if (optionKeys.some((key) => typeof key !== 'string' || !allowedOptions.includes(key))) {
    throw serviceError('invalid_instruction_service_dependencies');
  }
  const journal = options.journal;
  const deliveryStore = options.deliveryStore;
  const launchRegistry = options.launchRegistry;
  const adapters = options.providerInstructionAdapters;
  if (!journal || typeof journal.load !== 'function' || typeof journal.save !== 'function' ||
      typeof journal.flush !== 'function' || typeof journal.close !== 'function' ||
      !deliveryStore || !isPromise(deliveryStore.ready) ||
      typeof deliveryStore.createInstructionDelivery !== 'function' ||
      typeof deliveryStore.get !== 'function' || typeof deliveryStore.snapshot !== 'function' ||
      typeof deliveryStore.flush !== 'function' || !launchRegistry ||
      !dataMethod(launchRegistry, 'get') || !isRecord(adapters) ||
      (options.now !== undefined && typeof options.now !== 'function')) {
    throw serviceError('invalid_instruction_service_dependencies');
  }
  for (const provider of PROVIDERS) {
    if (Object.hasOwn(adapters, provider) && adapters[provider] !== null &&
        (adapters[provider].provider !== provider ||
         typeof adapters[provider].prepareInstructionDispatch !== 'function' ||
         typeof adapters[provider].verifyDeliveryTarget !== 'function' ||
         typeof adapters[provider].dispatchInstructionNow !== 'function' ||
         typeof adapters[provider].recordAppliedInstructionGuarded !== 'function')) {
      throw serviceError('invalid_instruction_service_dependencies');
    }
  }
  const now = options.now || Date.now;
  const reclamationWriter = journal.reclamationWriter || null;
  const reclamationMode = reclamationWriter !== null;
  if (reclamationMode && (typeof journal.canWrite !== 'function' ||
      typeof reclamationWriter.stop !== 'function' ||
      typeof reclamationWriter.drain !== 'function' || typeof reclamationWriter.prepareResume !== 'function')) {
    throw serviceError('invalid_instruction_service_dependencies');
  }
  const adaptersByProvider = { claude: adapters.claude || null, codex: adapters.codex || null };
  let accepting = true;
  let reclamationPrepared = !reclamationMode;
  let blocked = false;
  let startupError = null;
  let journalState = null;
  let initPromise = null;
  let tail = Promise.resolve();
  let closePromise = null;
  const adapterUnsubscribers = [];

  function nowValue() {
    let value;
    try { value = now(); } catch { throw serviceError('instruction_clock_unavailable'); }
    if (!Number.isSafeInteger(value) || value < 0) throw serviceError('instruction_clock_unavailable');
    return value;
  }

  function findIntent(id) {
    return journalState?.instructions.find((record) => record.deliveryAttemptId === id) || null;
  }

  function isServiceVisibleRecord(record) {
    return !reclamationMode || record?.recordType === 'detail' &&
      record.deliveryCreationState !== 'indeterminate' && record.reclamation === null;
  }

  function isServiceMutableRecord(record) {
    return isServiceVisibleRecord(record) && (!reclamationMode ||
      record.deliveryCreationState === 'checkpointed');
  }

  function requireServiceMutableRecord(record) {
    if (!record) throw serviceError('instruction_not_found');
    if (!isServiceVisibleRecord(record)) throw serviceError('instruction_recreation_forbidden');
    if (!isServiceMutableRecord(record)) throw serviceError('instruction_creation_incomplete');
    return record;
  }

  function providerAdapter(provider) {
    return adaptersByProvider[provider] || null;
  }

  function sourceRecord(launchRef) {
    let launch;
    try { launch = dataMethod(launchRegistry, 'get').call(launchRegistry, launchRef); }
    catch { throw serviceError('instruction_target_unverified'); }
    if (isPromise(launch) || !launch) throw serviceError('instruction_target_unverified');
    return { launch, source: sourceProjectionFromLaunch(launch) };
  }

  function validateSourceMode(source, mode, allowAlternative = false) {
    if (source.claims.origin === 'review') throw serviceError('instruction_review_not_supported');
    if (source.claims.origin === 'delegated' && mode !== 'steer') {
      throw serviceError('instruction_origin_mode_mismatch');
    }
    if (source.claims.origin !== 'standalone' && source.claims.origin !== 'delegated') {
      throw serviceError('instruction_origin_mode_mismatch');
    }
    if (mode === 'next-user-input' && !allowAlternative) {
      throw serviceError('instruction_mode_requires_supersede');
    }
  }

  function captureInput(input, allowAlternative = false, launchOverride = null) {
    const captured = exactObject(input, INPUT_FIELDS);
    for (const field of ['deliveryAttemptId', 'launchRef', 'logicalMessageId']) {
      if (!isIdentifier(captured[field]) || captured[field].length > 512) throw serviceError('instruction_invalid_request');
    }
    if (!Number.isSafeInteger(captured.revision) || captured.revision < 0) {
      throw serviceError('instruction_invalid_request');
    }
    if (!['steer', 'start', 'next-user-input'].includes(captured.mode)) {
      throw serviceError('instruction_invalid_request');
    }
    let sourceResult;
    if (launchOverride) {
      if (captured.launchRef !== launchOverride.source.launchRef) throw serviceError('instruction_target_unverified');
      sourceResult = launchOverride;
    } else {
      sourceResult = sourceRecord(captured.launchRef);
    }
    validateSourceMode(sourceResult.source, captured.mode, allowAlternative);
    if (sourceResult.launch.state !== 'bound' && !findIntent(captured.deliveryAttemptId)) {
      throw serviceError('instruction_target_unverified');
    }
    let envelope;
    try {
      envelope = createInstructionEnvelope({
        mode: captured.mode,
        expectedTurnId: captured.expectedTurnId,
        text: captured.text,
      });
    } catch (error) {
      if (error.code === 'expected_turn_required') throw serviceError('instruction_expected_turn_required');
      if (error.code === 'unexpected_turn') throw serviceError('instruction_expected_turn_unexpected');
      if (error.code === 'invalid_instruction_mode') throw serviceError('instruction_invalid_request');
      if (error.code === 'instruction_envelope_too_large') throw serviceError('instruction_capacity_exceeded');
      throw serviceError('instruction_invalid_request');
    }
    const record = normalizeInstructionRecord({
      deliveryAttemptId: captured.deliveryAttemptId,
      launchRef: captured.launchRef,
      logicalMessageId: captured.logicalMessageId,
      revision: captured.revision,
      source: sourceResult.source,
      envelope: envelope.serialized,
      envelopeDigest: envelope.envelopeDigest,
      nativeContentDigest: envelope.nativeContentDigest,
      createdAt: nowValue(),
    });
    return { captured, sourceResult, envelope, record };
  }

  function deliveryFor(id, provider) {
    const adapter = providerAdapter(provider);
    if (!adapter) return deliveryStore.get(id);
    return adapter.get(id);
  }

  async function validateExistingDelivery(record, provider) {
    if (!isServiceVisibleRecord(record)) throw serviceError('instruction_recreation_forbidden');
    const delivery = await deliveryFor(record.deliveryAttemptId, provider);
    if (delivery && !deliveryMatchesRecord(delivery, record)) throw serviceError('instruction_delivery_mismatch');
    return delivery;
  }

  function projection(record, delivery) {
    const adapter = providerAdapter(record.source.claims.provider);
    const nativeTurnId = delivery?.acceptedCorrelation?.nativeTurnId ||
      (record.envelope && JSON.parse(record.envelope).mode === 'steer'
        ? JSON.parse(record.envelope).expectedTurnId : null);
    let heldReason = null;
    if (!delivery) heldReason = 'instruction_delivery_missing';
    else if (['sending', 'accepted', 'unknown'].includes(delivery.state)) {
      heldReason = delivery.state === 'unknown' ? 'instruction_delivery_unknown' : null;
    } else if (!adapter?.available) {
      heldReason = 'instruction_dispatch_unavailable';
    }
    return freezeTree({
      deliveryAttemptId: record.deliveryAttemptId,
      logicalMessageId: record.logicalMessageId,
      revision: record.revision,
      launchRef: record.launchRef,
      sessionId: record.source.sessionId,
      executionId: record.source.executionBinding.periodId,
      identity: { ...record.source.identity },
      origin: record.source.claims.origin,
      provider: record.source.claims.provider,
      state: delivery?.state || 'unavailable',
      mode: JSON.parse(record.envelope).mode,
      nativeTurnId: nativeTurnId || null,
      heldReason,
      createdAt: record.createdAt,
    });
  }

  async function createNow(input, allowAlternative = false, sourceOverride = null) {
    const intent = captureInput(input, allowAlternative, sourceOverride);
    const prior = findIntent(intent.record.deliveryAttemptId);
    if (reclamationMode && prior && (!isServiceVisibleRecord(prior) ||
        prior.deliveryCreationState === 'creating' || prior.deliveryCreationState === 'indeterminate')) {
      throw serviceError('instruction_recreation_forbidden');
    }
    const attempted = reclamationMode
      ? appendInstructionIntentV2(journalState, intent.record)
      : appendInstructionIntent(journalState || createEmptyJournal(), intent.record);
    if (attempted.created) {
      journalState = await journal.save(attempted.journal);
    }
    let savedIntent = attempted.record;
    if (reclamationMode) {
      if (!isServiceVisibleRecord(savedIntent)) throw serviceError('instruction_recreation_forbidden');
      if (savedIntent.deliveryCreationState === 'checkpointed') {
        const existingDelivery = await validateExistingDelivery(savedIntent, savedIntent.source.claims.provider);
        if (!existingDelivery) throw serviceError('instruction_delivery_mismatch');
        return {
          outcome: 'existing',
          delivery: existingDelivery,
          instruction: projection(savedIntent, existingDelivery),
        };
      }
      if (savedIntent.deliveryCreationState !== 'not_created') {
        throw serviceError('instruction_recreation_forbidden');
      }
      const creating = updateInstructionCreationStateV2(journalState, savedIntent.deliveryAttemptId, 'creating');
      journalState = await journal.save(creating.journal);
      savedIntent = findIntent(intent.record.deliveryAttemptId);
    }
    const provider = savedIntent.source.claims.provider;
    let adapter = providerAdapter(provider);
    let delivery = await validateExistingDelivery(savedIntent, provider);
    let createdNow = false;
    if (!delivery) {
      const create = adapter?.createInstructionDelivery || deliveryStore.createInstructionDelivery;
      const created = await create.call(adapter || deliveryStore, {
        launchRef: savedIntent.launchRef,
        deliveryAttemptId: savedIntent.deliveryAttemptId,
        logicalMessageId: savedIntent.logicalMessageId,
        revision: savedIntent.revision,
        payload: savedIntent.envelope,
      });
      delivery = created;
      createdNow = true;
    }
    if (!deliveryMatchesRecord(delivery, savedIntent)) throw serviceError('instruction_delivery_mismatch');
    if (reclamationMode) {
      const checkpointed = updateInstructionCreationStateV2(
        journalState, savedIntent.deliveryAttemptId, 'checkpointed');
      journalState = await journal.save(checkpointed.journal);
      savedIntent = findIntent(savedIntent.deliveryAttemptId);
    }
    return {
      outcome: attempted.created || createdNow ? 'created' : 'existing',
      delivery,
      instruction: projection(savedIntent, delivery),
    };
  }

  function mapForRecord(record) {
    const adapter = providerAdapter(record.source.claims.provider);
    if (!adapter) throw serviceError('instruction_dispatch_unavailable');
    return adapter;
  }

  async function markUnknownNow(id, reason) {
    const record = findIntent(id);
    if (!record || !isServiceMutableRecord(record)) return false;
    const adapter = providerAdapter(record.source.claims.provider);
    if (!adapter) return false;
    let delivery;
    try { delivery = await adapter.get(id); } catch { return false; }
    if (!delivery || delivery.state === 'applied' || delivery.state === 'unknown') return delivery || false;
    if (!['sending', 'accepted'].includes(delivery.state)) return delivery;
    try { return await adapter.markUnknown(id, reason); } catch { return false; }
  }

  const correlator = createInstructionInputCorrelator({
    now,
    onApplied: (id, evidence, sourceToken) => enqueue(async () => {
      const record = findIntent(id);
      if (!record || !isServiceMutableRecord(record) || !correlator.isApplying(id, sourceToken, evidence)) return false;
      const adapter = providerAdapter(record.source.claims.provider);
      if (!adapter) return false;
      const delivery = await adapter.get(id);
      if (!delivery || !deliveryMatchesRecord(delivery, record) ||
          !correlator.isApplying(id, sourceToken, evidence)) return false;
      const correlation = deliveryCorrelation(delivery, evidence.nativeTurnId, evidence.nativeItemId);
      try {
        if (typeof adapter.recordAppliedInstructionGuarded !== 'function') return false;
        const updated = await adapter.recordAppliedInstructionGuarded(id, correlation, () =>
          correlator.beginApplyCommit(id, sourceToken, evidence));
        return updated?.state === 'applied' && correlator.finishApplyCommit(id, sourceToken, true);
      } catch {
        correlator.finishApplyCommit(id, sourceToken, false);
        return false;
      }
    }, true),
    onUnknown: (id, reason) => enqueue(() => markUnknownNow(id, reason), true),
    onFinished: (id, state, reason, sourceToken) => {
      const record = findIntent(id);
      if (record && isServiceVisibleRecord(record)) {
        providerAdapter(record.source.claims.provider)?.closeInstructionObservation?.(id, sourceToken);
      }
    },
  });

  function bindAdapter(adapter) {
    if (!adapter) return;
    if (typeof adapter.onEvidence === 'function') {
      adapterUnsubscribers.push(adapter.onEvidence((id, sourceToken, evidence) =>
        correlator.observe({ deliveryAttemptId: id, sourceToken, evidence }) === true));
    }
    if (typeof adapter.onAccepted === 'function') {
      adapterUnsubscribers.push(adapter.onAccepted((id, sourceToken, accepted) => enqueue(async () => {
        const record = findIntent(id);
        if (!record) {
          if (reclamationMode) return false;
          throw serviceError('instruction_delivery_mismatch');
        }
        if (!isServiceMutableRecord(record)) return false;
        const current = await adapter.get(id);
        if (!current || !deliveryMatchesRecord(current, record)) throw serviceError('instruction_delivery_mismatch');
        const correlation = deliveryCorrelation(current, accepted.nativeTurnId, null);
        const updated = await adapter.recordAccepted(id, correlation);
        if (!updated || !['accepted', 'applied'].includes(updated.state)) {
          throw serviceError('instruction_acceptance_conflict');
        }
        correlator.accepted(id, sourceToken, accepted);
        return true;
      }, true)));
    }
    if (typeof adapter.onUnknown === 'function') {
      adapterUnsubscribers.push(adapter.onUnknown((id, reason) => correlator.unknown(id, reason)));
    }
  }

  for (const provider of PROVIDERS) bindAdapter(providerAdapter(provider));

  async function reconcile() {
    await deliveryStore.ready;
    const loaded = await journal.load();
    if (!isRecord(loaded) || !Array.isArray(loaded.instructions)) throw serviceError('instruction_journal_unavailable');
    journalState = reclamationMode ? normalizeInstructionJournalV2Local(loaded) : loaded;
    for (const record of journalState.instructions) {
      if (reclamationMode) {
        if (!sameJson(normalizeInstructionRecordV2Local(record), record)) {
          throw serviceError('invalid_instruction_journal');
        }
        if (!isServiceVisibleRecord(record)) continue;
        if (record.deliveryCreationState === 'creating') {
          throw serviceError('instruction_creation_recovery_required');
        }
      } else {
        const normalized = normalizeInstructionRecord(record);
        if (!sameJson(normalized, record)) throw serviceError('invalid_instruction_journal');
      }
      const normalized = reclamationMode ? record : normalizeInstructionRecord(record);
      const delivery = await validateExistingDelivery(normalized, normalized.source.claims.provider);
      if (reclamationMode && (normalized.deliveryCreationState === 'checkpointed' && !delivery ||
          normalized.deliveryCreationState === 'not_created' && delivery)) {
        throw serviceError('instruction_delivery_mismatch');
      }
      if (delivery && ['sending', 'accepted'].includes(delivery.state)) {
        if (delivery.state !== 'unknown') {
          await providerAdapter(normalized.source.claims.provider)?.markUnknown(normalized.deliveryAttemptId);
        }
      }
    }
    return Object.freeze({ ready: true, revision: journalState.revision });
  }

  function ready() {
    if (reclamationMode && !reclamationPrepared) {
      return Promise.reject(serviceError('reclamation_writer_cold'));
    }
    if (!initPromise) {
      initPromise = reconcile().catch((error) => {
        blocked = true;
        startupError = error;
        throw error;
      });
    }
    return initPromise;
  }

  function backendCanWrite() {
    let canWrite = false;
    try { canWrite = journal.canWrite() === true; } catch {}
    return canWrite;
  }

  async function prepareResume(fullSnapshot) {
    if (!reclamationMode || closePromise) throw serviceError('instruction_service_closed');
    const normalized = normalizeInstructionJournalV2Local(fullSnapshot?.stores?.instructions);
    await reclamationWriter.prepareResume(fullSnapshot);
    journalState = normalized;
    initPromise = null;
    startupError = null;
    blocked = false;
    reclamationPrepared = true;
    accepting = true;
  }

  const serviceReclamationWriter = reclamationMode ? Object.freeze({
    stop() {
      accepting = false;
      reclamationWriter.stop();
    },
    drain() {
      return tail.then(() => reclamationWriter.drain());
    },
    prepareResume,
  }) : null;

  function enqueue(operation, diagnostic = false) {
    const canWrite = !reclamationMode || backendCanWrite();
    if (reclamationMode && !reclamationPrepared) {
      return Promise.reject(serviceError('reclamation_writer_cold'));
    }
    if (!canWrite) return Promise.reject(serviceError('reclamation_service_blocked'));
    if (!accepting && (!diagnostic || reclamationMode)) {
      return Promise.reject(serviceError('instruction_service_closed'));
    }
    const result = tail.then(async () => {
      if (reclamationMode && !backendCanWrite()) {
        throw serviceError('reclamation_service_blocked');
      }
      if (reclamationMode && !reclamationPrepared) {
        throw serviceError('reclamation_writer_cold');
      }
      try { await ready(); }
      catch (error) { if (!diagnostic) throw error; }
      if (blocked && !diagnostic) throw serviceError(startupError?.code || 'instruction_service_blocked');
      return operation();
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function create(input) {
    return enqueue(() => createNow(input));
  }

  async function sendNow(id) {
    if (!isIdentifier(id)) throw serviceError('instruction_invalid_request');
    const record = requireServiceMutableRecord(findIntent(id));
    const adapter = mapForRecord(record);
    if (!adapter.available) throw serviceError('instruction_dispatch_unavailable');
    const delivery = await adapter.get(id);
    if (!delivery || !deliveryMatchesRecord(delivery, record)) throw serviceError('instruction_delivery_mismatch');
    if (!['available', 'claimed'].includes(delivery.state)) throw serviceError('instruction_not_sendable');

    const parsed = JSON.parse(record.envelope);
    const correlation = {
      deliveryAttemptId: record.deliveryAttemptId,
      source: record.source,
      target: delivery.target,
      revision: record.revision,
      payloadDigest: record.envelopeDigest,
      nativeContentDigest: record.nativeContentDigest,
      mode: parsed.mode,
      expectedTurnId: parsed.expectedTurnId,
    };
    correlator.register(correlation);
    const prepared = await adapter.prepareInstructionDispatch(delivery, {
      envelope: record.envelope,
      envelopeDigest: record.envelopeDigest,
      nativeContentDigest: record.nativeContentDigest,
    });
    if (!prepared?.ok || !prepared.sourceToken) {
      correlator.remove(id);
      adapter.abandon?.(id);
      throw serviceError(prepared?.heldReason || 'instruction_dispatch_unavailable');
    }
    correlator.attachSourceToken(id, prepared.sourceToken, prepared.recoverAfterExpiry);
    try {
      await adapter.rehydratePayload(id, record.envelope);
    } catch (error) {
      correlator.remove(id);
      adapter.abandon?.(id);
      throw error;
    }
    let started;
    try {
      started = await adapter.sendStart(id, (payload, publicDelivery) =>
        adapter.dispatchInstructionNow(publicDelivery, payload, () => correlator.markDispatching(id, prepared.sourceToken)));
    } catch (error) {
      correlator.remove(id);
      adapter.abandon?.(id);
      throw error;
    }
    if (started?.state === 'unknown') correlator.unknown(id, 'instruction_delivery_unknown');
    let current = started;
    try { current = await adapter.get(id) || started; } catch {}
    return {
      outcome: current?.state === 'unknown' ? 'unknown' : current?.state === 'sending' ? 'sending' : 'unchanged',
      delivery: current,
      instruction: projection(record, current),
    };
  }

  function send(id) {
    return enqueue(() => sendNow(id));
  }

  async function cancelNow(id) {
    if (!isIdentifier(id)) throw serviceError('instruction_invalid_request');
    const record = requireServiceMutableRecord(findIntent(id));
    const adapter = mapForRecord(record);
    const current = await adapter.get(id);
    if (!current || !deliveryMatchesRecord(current, record)) throw serviceError('instruction_delivery_mismatch');
    const updated = await adapter.cancel(id);
    return { outcome: updated?.state === 'cancelled_before_send' ? 'cancelled' : 'unchanged',
      delivery: updated, instruction: projection(record, updated) };
  }

  function cancel(id) {
    return enqueue(() => cancelNow(id));
  }

  async function supersedeUnsentNow(id, input) {
    if (!isIdentifier(id)) throw serviceError('instruction_invalid_request');
    const oldRecord = requireServiceMutableRecord(findIntent(id));
    if (oldRecord.source.claims.origin !== 'standalone') throw serviceError('instruction_origin_mode_mismatch');
    const capturedAlternative = exactObject(input, ALTERNATIVE_FIELDS);
    if (!isIdentifier(capturedAlternative.newDeliveryAttemptId) ||
        !isIdentifier(capturedAlternative.logicalMessageId) ||
        capturedAlternative.logicalMessageId !== oldRecord.logicalMessageId ||
        !Number.isSafeInteger(capturedAlternative.revision) || capturedAlternative.revision <= oldRecord.revision ||
        capturedAlternative.mode !== 'next-user-input' || capturedAlternative.expectedTurnId !== null) {
      throw serviceError('instruction_invalid_request');
    }
    const launchRef = oldRecord.launchRef;
    const sourceResult = sourceRecord(launchRef);
    if (!sameJson(sourceResult.source, oldRecord.source)) throw serviceError('instruction_target_unverified');
    const newInput = {
      deliveryAttemptId: capturedAlternative.newDeliveryAttemptId,
      launchRef,
      logicalMessageId: capturedAlternative.logicalMessageId,
      revision: capturedAlternative.revision,
      text: capturedAlternative.text,
      mode: capturedAlternative.mode,
      expectedTurnId: capturedAlternative.expectedTurnId,
    };
    const preflight = captureInput(newInput, true, sourceResult);
    const oldAdapter = mapForRecord(oldRecord);
    const oldDelivery = await oldAdapter.get(id);
    if (!oldDelivery || !deliveryMatchesRecord(oldDelivery, oldRecord) ||
        !['available', 'claimed', 'superseded_before_send'].includes(oldDelivery.state)) {
      throw serviceError('instruction_not_supersedable');
    }
    const laterIntents = journalState.instructions.filter((record) =>
      record.source.claims.provider === oldRecord.source.claims.provider &&
      record.source.executionBinding.periodId === oldRecord.source.executionBinding.periodId &&
      record.logicalMessageId === oldRecord.logicalMessageId && record.revision > oldRecord.revision);
    if (laterIntents.some((record) => record.deliveryAttemptId !== capturedAlternative.newDeliveryAttemptId)) {
      throw serviceError('instruction_logical_conflict');
    }
    let oldUpdated = oldDelivery;
    if (['available', 'claimed'].includes(oldDelivery.state)) {
      oldUpdated = await oldAdapter.supersedeUnsentDelivery(id);
      if (oldUpdated?.state !== 'superseded_before_send') throw serviceError('instruction_not_supersedable');
    }
    const created = await createNow({
      deliveryAttemptId: preflight.captured.deliveryAttemptId,
      launchRef: preflight.captured.launchRef,
      logicalMessageId: preflight.captured.logicalMessageId,
      revision: preflight.captured.revision,
      text: preflight.captured.text,
      mode: preflight.captured.mode,
      expectedTurnId: preflight.captured.expectedTurnId,
    }, true, sourceResult);
    return { outcome: 'superseded', previous: projection(oldRecord, oldUpdated), ...created };
  }

  function supersedeUnsent(id, input) {
    return enqueue(() => supersedeUnsentNow(id, input));
  }

  async function getNow(id) {
    if (!isIdentifier(id)) return null;
    const record = findIntent(id);
    if (!record || !isServiceVisibleRecord(record)) return null;
    const delivery = await deliveryFor(id, record.source.claims.provider);
    if (delivery && !deliveryMatchesRecord(delivery, record)) throw serviceError('instruction_delivery_mismatch');
    return { delivery, instruction: projection(record, delivery) };
  }

  function get(id) {
    return enqueue(() => getNow(id));
  }

  async function dashboardSnapshotNow() {
    if (!journalState) return { version: 1, instructions: [], recovery: {
      status: 'blocked', blocked: true,
      errorCode: startupError?.code || 'instruction_journal_unavailable', unmatchedCount: 0,
    } };
    let errorCode = blocked ? startupError?.code || 'instruction_service_blocked' : null;
    let unmatchedCount = 0;
    const instructions = [];
    for (const record of journalState.instructions) {
      if (!isServiceVisibleRecord(record)) continue;
      let delivery = null;
      try {
        delivery = await deliveryFor(record.deliveryAttemptId, record.source.claims.provider);
        if (delivery && !deliveryMatchesRecord(delivery, record)) throw serviceError('instruction_delivery_mismatch');
        if (!delivery) {
          errorCode ||= 'instruction_delivery_missing';
          unmatchedCount += 1;
        }
      } catch (error) {
        errorCode ||= error?.code || 'instruction_delivery_unavailable';
        unmatchedCount += 1;
      }
      instructions.push(projection(record, delivery));
    }
    return { version: 1, instructions, diagnostics: correlator.diagnostics(), recovery: {
      status: errorCode ? 'blocked' : 'ready', blocked: Boolean(errorCode), errorCode, unmatchedCount,
    } };
  }

  function dashboardSnapshot() {
    return enqueue(() => dashboardSnapshotNow(), true);
  }

  function reportResponseLost(id) {
    if (!isIdentifier(id)) return Promise.reject(serviceError('instruction_invalid_request'));
    if (!reclamationMode) correlator.unknown(id, 'instruction_response_lost');
    return enqueue(async () => {
      const record = findIntent(id);
      requireServiceMutableRecord(record);
      correlator.unknown(id, 'instruction_response_lost');
      const adapter = mapForRecord(record);
      const current = await adapter.get(id);
      if (!current || !deliveryMatchesRecord(current, record)) throw serviceError('instruction_delivery_mismatch');
      if (current.state === 'applied') return { outcome: 'unchanged', delivery: current,
        instruction: projection(record, current) };
      if (!['sending', 'accepted'].includes(current.state)) return { outcome: 'unchanged', delivery: current,
        instruction: projection(record, current) };
      const updated = await adapter.markUnknown(id);
      return { outcome: 'unknown', delivery: updated, instruction: projection(record, updated) };
    });
  }

  function flush() {
    if (!accepting) return Promise.reject(serviceError('instruction_service_closed'));
    if (reclamationMode && !reclamationPrepared) return Promise.reject(serviceError('reclamation_writer_cold'));
    return tail.then(() => ready()).then(() => Promise.all([journal.flush(), deliveryStore.flush()])).then(() => undefined);
  }

  function close() {
    if (closePromise) return closePromise;
    accepting = false;
    if (reclamationMode) reclamationWriter.stop();
    correlator.close();
    closePromise = tail.then(async () => {
      if (!reclamationMode || reclamationPrepared) {
        try { await ready(); } catch {}
      }
      if (journalState) {
        for (const record of journalState.instructions) {
          if (!isServiceVisibleRecord(record)) continue;
          const adapter = providerAdapter(record.source.claims.provider);
          if (!adapter) continue;
          try {
            const current = await adapter.get(record.deliveryAttemptId);
            if (current && ['sending', 'accepted'].includes(current.state)) {
              await adapter.markUnknown(record.deliveryAttemptId);
            }
          } catch {}
        }
      }
      for (const unsubscribe of adapterUnsubscribers) {
        try { unsubscribe(); } catch {}
      }
      correlator.close();
      for (const provider of PROVIDERS) {
        try { adaptersByProvider[provider]?.close?.(); } catch {}
      }
      await Promise.all([
        journal.flush().catch(() => {}),
        deliveryStore.flush().catch(() => {}),
      ]);
      await journal.close();
    });
    return closePromise;
  }

  return Object.freeze({
    ready,
    create,
    send,
    cancel,
    supersedeUnsent,
    get,
    dashboardSnapshot,
    reportResponseLost,
    flush,
      close,
      ...(serviceReclamationWriter ? { reclamationWriter: serviceReclamationWriter } : {}),
    });
}

module.exports = { createInstructionDeliveryService };
