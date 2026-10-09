'use strict';

const { types: utilTypes } = require('node:util');
const {
  instructionError,
  isIdentifier,
  isSha256Digest,
  parseInstructionEnvelope,
} = require('./instruction-envelope');
const { sourceProjectionFromDelivery } = require('./instruction-delivery-journal');

const PROVIDERS = new Set(['claude', 'codex']);
const PREPARE_TIMEOUT_MS = 5_000;
const ACK_TIMEOUT_MS = 5_000;
const CAPABILITY_TTL_MS = 60_000;
const MAX_CAPABILITIES = 128;
const OWNER_METHODS = [
  'prepareInstructionDispatch',
  'checkInstructionDispatch',
  'dispatchInstructionNow',
  'subscribeInstructionEvidence',
];

function adapterError(code) {
  const error = instructionError(code);
  error.message = 'provider instruction dispatch rejected';
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

function exactObject(value, fields, code = 'invalid_instruction_adapter_input') {
  if (!isRecord(value)) throw adapterError(code);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { throw adapterError(code); }
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
    throw adapterError(code);
  }
  const result = {};
  for (const field of fields) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); } catch { throw adapterError(code); }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw adapterError(code);
    result[field] = descriptor.value;
  }
  return result;
}

function ownValue(object, key, code = 'instruction_dispatch_unavailable') {
  if (!isRecord(object)) throw adapterError(code);
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(object, key); } catch { throw adapterError(code); }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw adapterError(code);
  return descriptor.value;
}

function dataMethod(target, name) {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return null;
  let current = target;
  for (let depth = 0; current && depth < 8; depth += 1) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(current, name); } catch { return null; }
    if (descriptor) return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
      ? descriptor.value : null;
    try { current = Object.getPrototypeOf(current); } catch { return null; }
  }
  return null;
}

function freezeTree(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor && Object.hasOwn(descriptor, 'value')) freezeTree(descriptor.value);
  }
  return Object.freeze(value);
}

function targetProjection(value) {
  const target = exactObject(value, [
    'kind', 'launchRef', 'claims', 'identity', 'periodId', 'actor', 'conversationId', 'sessionId',
  ], 'instruction_target_unverified');
  if (target.kind !== 'execution' || !isIdentifier(target.launchRef) ||
      !isIdentifier(target.periodId) || !isIdentifier(target.conversationId) ||
      !isIdentifier(target.sessionId)) throw adapterError('instruction_target_unverified');
  const source = sourceProjectionFromDelivery({ source: {
    launchRef: target.launchRef,
    claims: target.claims,
    identity: target.identity,
    executionBinding: { periodId: target.periodId, actor: target.actor },
    conversationId: target.conversationId,
    sessionId: target.sessionId,
  } });
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

function nativeCapability(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function createProviderInstructionAdapter(provider, options = {}) {
  if (!PROVIDERS.has(provider) || !isRecord(options)) throw adapterError('invalid_provider_instruction_adapter');
  const allowedOptions = [
    'deliveryAdapter', 'nativeOwner', 'prepareTimeoutMs', 'ackTimeoutMs',
    'setTimeoutImpl', 'clearTimeoutImpl',
  ];
  let optionKeys;
  try { optionKeys = Reflect.ownKeys(options); } catch { throw adapterError('invalid_provider_instruction_adapter'); }
  if (optionKeys.some((key) => typeof key !== 'string' || !allowedOptions.includes(key))) {
    throw adapterError('invalid_provider_instruction_adapter');
  }
  const deliveryAdapter = options.deliveryAdapter;
  const prepareTimeoutMs = options.prepareTimeoutMs ?? PREPARE_TIMEOUT_MS;
  const ackTimeoutMs = options.ackTimeoutMs ?? ACK_TIMEOUT_MS;
  const setTimeoutImpl = options.setTimeoutImpl || setTimeout;
  const clearTimeoutImpl = options.clearTimeoutImpl || clearTimeout;
  if (!deliveryAdapter || deliveryAdapter.provider !== provider ||
      typeof deliveryAdapter.createInstructionDelivery !== 'function' ||
      typeof deliveryAdapter.get !== 'function' || typeof deliveryAdapter.sendStart !== 'function' ||
      typeof deliveryAdapter.rehydratePayload !== 'function' || typeof deliveryAdapter.cancel !== 'function' ||
      typeof deliveryAdapter.supersedeUnsentDelivery !== 'function' ||
      typeof deliveryAdapter.recordAppliedInstructionGuarded !== 'function' ||
      !Number.isSafeInteger(prepareTimeoutMs) || prepareTimeoutMs < 1 || prepareTimeoutMs > 30_000 ||
      !Number.isSafeInteger(ackTimeoutMs) || ackTimeoutMs < 1 || ackTimeoutMs > 30_000 ||
      typeof setTimeoutImpl !== 'function' || typeof clearTimeoutImpl !== 'function') {
    throw adapterError('invalid_provider_instruction_adapter');
  }

  const owner = options.nativeOwner || null;
  const ownerMethods = owner ? Object.fromEntries(OWNER_METHODS.map((name) => [name, dataMethod(owner, name)])) : null;
  if (ownerMethods) for (const name of ['closeInstructionObservation', 'subscribeInstructionClosed', 'supportsLateInstructionEvidence']) ownerMethods[name] = dataMethod(owner, name);
  const available = Boolean(owner && OWNER_METHODS.every((name) => typeof ownerMethods[name] === 'function') &&
    !utilTypes.isAsyncFunction(ownerMethods.checkInstructionDispatch) &&
    !utilTypes.isAsyncFunction(ownerMethods.dispatchInstructionNow));
  const observationClosureAvailable = Boolean(ownerMethods && ['closeInstructionObservation', 'subscribeInstructionClosed'].every(name =>
    typeof ownerMethods[name] === 'function' && !utilTypes.isAsyncFunction(ownerMethods[name])));
  const contexts = new Map();
  const capabilityContexts = new WeakMap();
  const acceptedListeners = new Set();
  const evidenceListeners = new Set();
  const unknownListeners = new Set();
  let closed = false;
  let unsubscribe = null;
  let unsubscribeClosed = null;

  function invokeOwner(name, args) {
    try { return ownerMethods[name].apply(owner, args); }
    catch { throw adapterError('instruction_dispatch_unavailable'); }
  }

  function notifyUnknown(id, reason) {
    for (const listener of unknownListeners) {
      try {
        const result = listener(id, reason);
        if (utilTypes.isPromise(result)) Promise.prototype.then.call(result, undefined, () => {});
      } catch {}
    }
  }

  function discardContext(context, reason = null) {
    if (contexts.get(context.metadata.deliveryAttemptId) !== context) return;
    if (context.timer !== null) {
      clearTimeoutImpl(context.timer);
      context.timer = null;
    }
    contexts.delete(context.metadata.deliveryAttemptId);
    if (context.capability) capabilityContexts.delete(context.capability);
    try { ownerMethods?.closeInstructionObservation?.call(owner, context.capability, context.metadata); } catch {}
    if (reason && ['dispatching', 'accepting', 'accepted'].includes(context.phase)) {
      notifyUnknown(context.metadata.deliveryAttemptId, reason);
    }
  }

  function scheduleExpiry(context, ttlMs = CAPABILITY_TTL_MS) {
    if (context.timer !== null) clearTimeoutImpl(context.timer);
    context.timer = setTimeoutImpl(() => {
      context.timer = null;
      if (context.phase === 'accepted' && context.recoverAfterExpiry) {
        if (!context.observationUnknown) {
          context.observationUnknown = true;
          notifyUnknown(context.metadata.deliveryAttemptId, 'instruction_evidence_expired');
        }
        return;
      }
      discardContext(context, context.phase === 'prepared' || context.phase === 'preparing'
        ? null : 'instruction_capability_expired');
    }, ttlMs);
    context.timer?.unref?.();
  }

  function buildMetadata(delivery, intent) {
    const source = sourceProjectionFromDelivery(delivery);
    const target = targetProjection(ownValue(delivery, 'target'));
    const deliveryKind = ownValue(delivery, 'kind');
    const deliveryAttemptId = ownValue(delivery, 'deliveryAttemptId');
    const revision = ownValue(delivery, 'revision');
    const payloadDigest = ownValue(delivery, 'payloadDigest');
    const sourceExecutionId = ownValue(delivery, 'sourceExecutionId');
    if (deliveryKind !== 'instruction' || !isIdentifier(deliveryAttemptId) ||
        !Number.isSafeInteger(revision) || revision < 0 || !isSha256Digest(payloadDigest) ||
        source.claims.provider !== provider || source.claims.nativeIdKind !== (provider === 'claude' ? 'session' : 'thread') ||
        sourceExecutionId !== source.executionBinding.periodId || target.launchRef !== source.launchRef ||
        target.periodId !== source.executionBinding.periodId ||
        JSON.stringify(target.claims) !== JSON.stringify(source.claims) ||
        JSON.stringify(target.identity) !== JSON.stringify(source.identity) ||
        JSON.stringify(target.actor) !== JSON.stringify(source.executionBinding.actor)) {
      throw adapterError('instruction_target_unverified');
    }
    const capturedIntent = exactObject(intent, ['envelope', 'envelopeDigest', 'nativeContentDigest']);
    const parsed = parseInstructionEnvelope(capturedIntent.envelope);
    if (source.claims.origin === 'review') throw adapterError('instruction_review_not_supported');
    if (source.claims.origin === 'delegated' && parsed.envelope.mode !== 'steer' ||
        source.claims.origin !== 'standalone' && source.claims.origin !== 'delegated') {
      throw adapterError('instruction_origin_mode_mismatch');
    }
    if (parsed.envelopeDigest !== capturedIntent.envelopeDigest ||
        parsed.nativeContentDigest !== capturedIntent.nativeContentDigest ||
        parsed.envelopeDigest !== payloadDigest) throw adapterError('instruction_payload_mismatch');
    return freezeTree({
      deliveryAttemptId,
      revision,
      payloadDigest,
      nativeContentDigest: parsed.nativeContentDigest,
      source,
      target,
      mode: parsed.envelope.mode,
      expectedTurnId: parsed.envelope.expectedTurnId,
    });
  }

  function currentContext(delivery, requiredPhase = 'prepared') {
    const id = ownValue(delivery, 'deliveryAttemptId');
    const context = contexts.get(id);
    if (!context || context.phase !== requiredPhase || context.expiresAt <= Date.now()) return null;
    let metadata;
    try { metadata = buildMetadata(delivery, context.intent); } catch { return null; }
    return JSON.stringify(metadata) === context.fingerprint ? context : null;
  }

  function checkContext(context) {
    if (!available || context.expiresAt <= Date.now() || !context.capability || context.used) return false;
    let result;
    try { result = invokeOwner('checkInstructionDispatch', [context.capability, context.metadata]); }
    catch { return false; }
    if (utilTypes.isPromise(result)) {
      Promise.prototype.then.call(result, undefined, () => {});
      return false;
    }
    return result === true;
  }

  function processEvidence(capability, evidence) {
    if (!nativeCapability(capability)) return false;
    const context = capabilityContexts.get(capability);
    if (!context || !['dispatching', 'accepting', 'accepted'].includes(context.phase) ||
        context.expiresAt <= Date.now() && !(context.phase === 'accepted' && context.recoverAfterExpiry)) {
      return false;
    }
    let acceptedAny = false;
    for (const listener of evidenceListeners) {
      try {
        if (listener(context.metadata.deliveryAttemptId, context.sourceToken, evidence) === true) acceptedAny = true;
      } catch {}
    }
    return acceptedAny;
  }

  function receiveAck(context, rawPromise) {
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error, value = undefined) => {
        if (settled) return;
        settled = true;
        clearTimeoutImpl(timer);
        if (error) { discardContext(context); reject(error); }
        else resolve(value);
      };
      const timer = setTimeoutImpl(() => {
        notifyUnknown(context.metadata.deliveryAttemptId, 'instruction_ack_timeout');
        finish(adapterError('instruction_ack_timeout'));
      }, ackTimeoutMs);
      timer?.unref?.();
      Promise.prototype.then.call(rawPromise, (value) => {
        if (settled) return;
        if (contexts.get(context.metadata.deliveryAttemptId) !== context) {
          finish(adapterError('instruction_source_invalid'));
          return;
        }
        let correlation;
        try {
          correlation = exactObject(value, ['clientRequestId', 'nativeTurnId', 'nativeItemId'],
            'instruction_acceptance_conflict');
        } catch (error) {
          notifyUnknown(context.metadata.deliveryAttemptId, error.code);
          finish(error);
          return;
        }
        if (correlation.clientRequestId !== context.metadata.deliveryAttemptId ||
            !isIdentifier(correlation.nativeTurnId) || correlation.nativeItemId !== null ||
            context.metadata.mode === 'steer' && correlation.nativeTurnId !== context.metadata.expectedTurnId) {
          notifyUnknown(context.metadata.deliveryAttemptId, 'instruction_acceptance_conflict');
          finish(adapterError('instruction_acceptance_conflict'));
          return;
        }
        if (acceptedListeners.size === 0) {
          notifyUnknown(context.metadata.deliveryAttemptId, 'instruction_ack_unhandled');
          finish(adapterError('instruction_ack_unhandled'));
          return;
        }
        context.phase = 'accepting';
        const results = [];
        for (const listener of acceptedListeners) {
          try {
            const result = listener(context.metadata.deliveryAttemptId, context.sourceToken, correlation);
            if (utilTypes.isPromise(result)) results.push(result);
            else if (result !== true) throw adapterError('instruction_ack_unhandled');
          } catch (error) {
            notifyUnknown(context.metadata.deliveryAttemptId, error?.code || 'instruction_ack_unhandled');
            finish(adapterError('instruction_ack_unhandled'));
            return;
          }
        }
        let remaining = results.length;
        if (remaining === 0) {
          context.phase = 'accepted';
          finish(null, correlation);
          return;
        }
        for (const result of results) {
          Promise.prototype.then.call(result, () => {
            if (settled) return;
            remaining -= 1;
            if (remaining === 0) {
              context.phase = 'accepted';
              finish(null, correlation);
            }
          }, (error) => {
            notifyUnknown(context.metadata.deliveryAttemptId, error?.code || 'instruction_ack_unhandled');
            finish(adapterError('instruction_ack_unhandled'));
          });
        }
      }, (error) => {
        notifyUnknown(context.metadata.deliveryAttemptId, 'instruction_ack_failed');
        finish(adapterError('instruction_ack_failed'));
      });
    });
  }

  if (available) {
    try {
      const release = invokeOwner('subscribeInstructionEvidence', [(capability, evidence) => processEvidence(capability, evidence)]);
      if (typeof release !== 'function') throw adapterError('instruction_evidence_source_unavailable');
      unsubscribe = release;
      if (observationClosureAvailable) {
        unsubscribeClosed = ownerMethods.subscribeInstructionClosed.call(owner, (capability, reason) => {
          const context = capabilityContexts.get(capability);
          if (context) discardContext(context, reason);
        });
        if (typeof unsubscribeClosed !== 'function') throw adapterError('instruction_evidence_source_unavailable');
      }
    } catch {
      for (const context of contexts.values()) discardContext(context);
      throw adapterError('instruction_evidence_source_unavailable');
    }
  }

  async function prepareInstructionDispatch(delivery, intent) {
    if (closed || !available) return { ok: false, heldReason: 'instruction_dispatch_unavailable' };
    if (contexts.size >= MAX_CAPABILITIES) return { ok: false, heldReason: 'instruction_correlation_capacity' };
    let metadata;
    try { metadata = buildMetadata(delivery, intent); }
    catch (error) { return { ok: false, heldReason: error.code || 'instruction_target_unverified' }; }
    const existing = contexts.get(metadata.deliveryAttemptId);
    if (existing && ['dispatching', 'accepting', 'accepted'].includes(existing.phase)) {
      return { ok: false, heldReason: 'instruction_delivery_already_dispatched' };
    }
    if (existing) discardContext(existing);
    const context = {
      metadata,
      fingerprint: JSON.stringify(metadata),
      intent: { ...intent },
      capability: null,
      sourceToken: Symbol('instruction-source'),
      phase: 'preparing',
      used: false,
      timer: null,
      expiresAt: Date.now() + CAPABILITY_TTL_MS,
    };
    contexts.set(metadata.deliveryAttemptId, context);
    scheduleExpiry(context, prepareTimeoutMs + CAPABILITY_TTL_MS);
    let prepared;
    try {
      prepared = invokeOwner('prepareInstructionDispatch', [metadata]);
    } catch {
      discardContext(context);
      return { ok: false, heldReason: 'instruction_dispatch_unavailable' };
    }
    let capability;
    try {
      if (utilTypes.isPromise(prepared)) {
        capability = await new Promise((resolve, reject) => {
        let settled = false;
        const timer = setTimeoutImpl(() => {
          if (settled) return;
          settled = true;
          reject(adapterError('instruction_prepare_timeout'));
        }, prepareTimeoutMs);
        timer?.unref?.();
        Promise.prototype.then.call(prepared, (value) => {
          if (settled) return;
          settled = true;
          clearTimeoutImpl(timer);
          resolve({ value });
        }, () => {
          if (settled) return;
          settled = true;
          clearTimeoutImpl(timer);
          reject(adapterError('instruction_dispatch_unavailable'));
        });
      }).then((result) => result.value);
      } else {
        capability = prepared;
      }
    } catch (error) {
      discardContext(context);
      return { ok: false, heldReason: error?.code || 'instruction_dispatch_unavailable' };
    }
    if (contexts.get(metadata.deliveryAttemptId) !== context || !nativeCapability(capability) ||
        capabilityContexts.has(capability)) {
      discardContext(context);
      return { ok: false, heldReason: 'instruction_dispatch_unavailable' };
    }
    context.capability = capability;
    context.recoverAfterExpiry = Boolean(unsubscribeClosed &&
      (typeof ownerMethods.supportsLateInstructionEvidence !== 'function' ||
        ownerMethods.supportsLateInstructionEvidence.call(owner, capability) === true));
    context.phase = 'prepared';
    context.expiresAt = Date.now() + CAPABILITY_TTL_MS;
    capabilityContexts.set(capability, context);
    scheduleExpiry(context);
    return { ok: true, sourceToken: context.sourceToken, recoverAfterExpiry: context.recoverAfterExpiry };
  }

  function verifyDeliveryTarget(delivery) {
    if (closed || !available) return false;
    const context = currentContext(delivery);
    return context ? checkContext(context) : false;
  }

  function dispatchInstructionNow(delivery, payload, beforeWrite) {
    if (closed || !available || typeof beforeWrite !== 'function') throw adapterError('instruction_dispatch_unavailable');
    const context = currentContext(delivery);
    if (!context) throw adapterError('instruction_target_unverified');
    let parsed;
    try { parsed = parseInstructionEnvelope(payload); } catch { throw adapterError('instruction_payload_mismatch'); }
    if (parsed.envelopeDigest !== context.metadata.payloadDigest ||
        parsed.nativeContentDigest !== context.metadata.nativeContentDigest ||
        parsed.envelope.mode !== context.metadata.mode || parsed.envelope.expectedTurnId !== context.metadata.expectedTurnId) {
      throw adapterError('instruction_payload_mismatch');
    }
    if (!checkContext(context)) throw adapterError('instruction_target_unverified');
    const command = freezeTree({ ...context.metadata, input: parsed.envelope.input });
    try { beforeWrite(); } catch { throw adapterError('instruction_dispatch_unavailable'); }
    context.phase = 'dispatching';
    context.used = true;
    let ack;
    try { ack = invokeOwner('dispatchInstructionNow', [context.capability, command]); }
    catch (error) {
      context.phase = 'failed';
      throw error;
    }
    if (!utilTypes.isPromise(ack)) {
      context.phase = 'failed';
      notifyUnknown(context.metadata.deliveryAttemptId, 'instruction_ack_unavailable');
      throw adapterError('instruction_ack_unavailable');
    }
    return receiveAck(context, ack);
  }

  function subscribe(set, listener, code) {
    if (typeof listener !== 'function' || closed) throw adapterError(code);
    set.add(listener);
    return () => set.delete(listener);
  }

  function abandon(id) {
    const context = contexts.get(id);
    if (!context || ['dispatching', 'accepting', 'accepted'].includes(context.phase)) return false;
    discardContext(context);
    return true;
  }
  function hasInstructionObservation(id, sourceToken) {
    const context = contexts.get(id);
    return !closed && available && !!context && context.sourceToken === sourceToken &&
      ['dispatching', 'accepting', 'accepted'].includes(context.phase) &&
      (context.expiresAt > Date.now() || context.phase === 'accepted' && context.recoverAfterExpiry);
  }

  function closeInstructionObservation(id, sourceToken) {
    const context = contexts.get(id);
    if (!context || context.sourceToken !== sourceToken) return false;
    discardContext(context);
    return true;
  }

  function close() {
    if (closed) return;
    closed = true;
    try { unsubscribeClosed?.(); } catch {}
    unsubscribeClosed = null;
    if (unsubscribe) {
      try { unsubscribe(); } catch {}
      unsubscribe = null;
    }
    for (const context of [...contexts.values()]) discardContext(context,
      ['dispatching', 'accepting', 'accepted'].includes(context.phase) ? 'instruction_adapter_closed' : null);
    acceptedListeners.clear();
    evidenceListeners.clear();
    unknownListeners.clear();
  }

  return Object.freeze({
    provider,
    available,
    deliveryAdapter,
    prepareInstructionDispatch,
    verifyDeliveryTarget,
    dispatchInstructionNow,
    onAccepted: (listener) => subscribe(acceptedListeners, listener, 'instruction_ack_unhandled'),
    onEvidence: (listener) => subscribe(evidenceListeners, listener, 'instruction_evidence_source_unavailable'),
    onUnknown: (listener) => subscribe(unknownListeners, listener, 'instruction_dispatch_unavailable'),
    abandon,
    closeInstructionObservation,
    hasInstructionObservation,
    createInstructionDelivery: deliveryAdapter.createInstructionDelivery,
    get: deliveryAdapter.get,
    cancel: deliveryAdapter.cancel,
    supersedeUnsentDelivery: deliveryAdapter.supersedeUnsentDelivery,
    sendStart: deliveryAdapter.sendStart,
    rehydratePayload: deliveryAdapter.rehydratePayload,
    recordAccepted: deliveryAdapter.recordAccepted,
    recordAcceptedInstructionGuarded: deliveryAdapter.recordAcceptedInstructionGuarded,
    recordApplied: deliveryAdapter.recordApplied,
    recordAppliedInstructionGuarded: deliveryAdapter.recordAppliedInstructionGuarded,
    markUnknown: deliveryAdapter.markUnknown,
    flush: deliveryAdapter.flush,
    close,
  });
}

module.exports = {
  ACK_TIMEOUT_MS,
  CAPABILITY_TTL_MS,
  MAX_CAPABILITIES,
  PREPARE_TIMEOUT_MS,
  createProviderInstructionAdapter,
};
