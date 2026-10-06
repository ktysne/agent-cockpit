'use strict';

const { createHash } = require('node:crypto');
const {
  DELIVERY_LEDGER_LIMITS,
  createEmptyLedger,
  validateLedger,
  createDelivery,
  registerPrTarget,
  transitionDelivery,
  getDelivery,
  snapshotLedger,
} = require('./delivery-ledger');
const {
  DEFAULT_MAX_CHECKPOINT_BYTES,
  DEFAULT_MAX_RECORDS,
  MAX_CONFIGURABLE_CHECKPOINT_BYTES,
  createDurableCheckpointStore,
  makeEmptyCheckpoint,
  mergeRegistrationHistory,
  projectRegistrationSnapshots,
} = require('./durable-checkpoint');

const PROVIDER_NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });
const CLAIM_FIELDS = [
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding',
];
const DELIVERY_INPUT_FIELDS = ['launchRef', 'deliveryAttemptId', 'logicalMessageId', 'revision', 'payload'];
const PR_DELIVERY_INPUT_FIELDS = [
  'sourceLaunchRef', 'targetId', 'deliveryAttemptId', 'logicalMessageId', 'revision', 'payload',
];
const TARGET_INPUT_FIELDS = ['targetId', 'launchRef'];
const CORRELATION_FIELDS = [
  'deliveryAttemptId', 'revision', 'payloadDigest', 'targetPeriodId',
  'nativeTurnId', 'nativeItemId', 'clientRequestId',
];
const STORE_INTERNALS = new WeakMap();

function storeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function captureExactRecord(value, fields, errorCode) {
  if (!isRecord(value)) throw storeError(errorCode);
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || fields.some((field) => !Object.hasOwn(value, field))) {
    throw storeError(errorCode);
  }
  const copy = {};
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw storeError(errorCode);
    }
    copy[field] = descriptor.value;
  }
  return copy;
}

function captureDeliveryInput(input, kind) {
  const fields = kind === 'pr-notification' ? PR_DELIVERY_INPUT_FIELDS : DELIVERY_INPUT_FIELDS;
  const captured = captureExactRecord(input, fields, 'invalid_delivery_input');
  if (!isIdentifier(captured.deliveryAttemptId) || !isIdentifier(captured.logicalMessageId) ||
      !Number.isSafeInteger(captured.revision) || captured.revision < 0 || typeof captured.payload !== 'string' ||
      (kind === 'pr-notification'
        ? !isIdentifier(captured.sourceLaunchRef) || !isIdentifier(captured.targetId)
        : !isIdentifier(captured.launchRef))) {
    throw storeError('invalid_delivery_input');
  }
  return captured;
}

function captureCorrelation(input) {
  return captureExactRecord(input, CORRELATION_FIELDS, 'invalid_correlation');
}

function jsonEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function cloneFrozen(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneFrozen));
  if (!isRecord(value)) return value;
  const result = {};
  for (const key of Object.keys(value)) result[key] = cloneFrozen(value[key]);
  return Object.freeze(result);
}

const MAX_SAFE_REVISION = Number.MAX_SAFE_INTEGER;
const MAX_ESCAPED_NATIVE_ID = '\uD800'.repeat(512);
const MAX_RESERVED_DELIVERY_STATE = [
  'available', 'claimed', 'sending', 'accepted', 'applied', 'unknown',
  'cancelled_before_send', 'superseded_before_send',
].reduce((longest, state) => state.length > longest.length ? state : longest, '');

function serializedCheckpointBytes(checkpoint) {
  return Buffer.byteLength(`${JSON.stringify(checkpoint, null, 2)}\n`, 'utf8');
}

function reserveRegistrationStateGrowthForSizing(registrations) {
  const keepLongerState = (record, restoredState) => {
    if (restoredState.length > record.state.length) record.state = restoredState;
  };
  for (const execution of registrations.executions) {
    keepLongerState(execution, execution.state === 'ended' ? 'ended' : 'unknown');
  }
  for (const launch of registrations.launches) {
    keepLongerState(launch, launch.state === 'ended' ? 'ended' : 'unknown');
  }
  for (const launch of registrations.runtimeLaunches) {
    keepLongerState(launch, launch.state === 'ended' ? 'ended' : 'unknown');
  }
  for (const connection of registrations.connections) keepLongerState(connection, 'inactive');
  for (const actor of registrations.actors) {
    keepLongerState(actor, actor.state === 'ended' ? 'ended' : 'unknown');
  }
}

function reserveCheckpointBytes(checkpoint) {
  const sized = structuredClone(checkpoint);
  sized.revision = MAX_SAFE_REVISION;
  sized.ledger.revision = MAX_SAFE_REVISION;
  for (const delivery of sized.ledger.deliveries) {
    if (['cancelled_before_send', 'superseded_before_send'].includes(delivery.state)) continue;
    const nativeTurnId = delivery.appliedCorrelation?.nativeTurnId ??
      delivery.acceptedCorrelation?.nativeTurnId ?? MAX_ESCAPED_NATIVE_ID;
    const nativeItemId = delivery.appliedCorrelation?.nativeItemId ??
      delivery.acceptedCorrelation?.nativeItemId ?? MAX_ESCAPED_NATIVE_ID;
    const correlation = {
      deliveryAttemptId: delivery.deliveryAttemptId,
      revision: delivery.revision,
      payloadDigest: delivery.payloadDigest,
      targetPeriodId: delivery.target.periodId,
      nativeTurnId,
      nativeItemId,
      clientRequestId: delivery.deliveryAttemptId,
    };
    delivery.state = MAX_RESERVED_DELIVERY_STATE;
    delivery.cancelRequested = false;
    delivery.acceptedCorrelation = correlation;
    delivery.appliedCorrelation = { ...correlation };
  }
  reserveRegistrationStateGrowthForSizing(sized.registrations);
  return serializedCheckpointBytes(sized);
}

function assertCheckpointCapacityReserved(checkpoint, maxBytes) {
  let reservedBytes;
  try {
    reservedBytes = reserveCheckpointBytes(checkpoint);
  } catch {
    throw storeError('checkpoint_capacity_reserved');
  }
  if (reservedBytes > maxBytes) throw storeError('checkpoint_capacity_reserved');
}

function digestPayload(payload) {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function syncRegistryCall(registry, method, args, unavailableCode) {
  try {
    const result = registry?.[method]?.(...args);
    if (result && typeof result.then === 'function') throw storeError(unavailableCode);
    return result;
  } catch {
    throw storeError(unavailableCode);
  }
}

function immutableLaunchProjection(record) {
  if (!isRecord(record) || !isIdentifier(record.launchRef)) throw storeError('launch_unavailable');
  const claims = {};
  for (const field of CLAIM_FIELDS) claims[field] = record[field];
  return {
    launchRef: record.launchRef,
    claims,
    identity: record.identity,
    executionBinding: record.executionBinding,
    conversationId: record.conversationId,
    sessionId: record.sessionId,
  };
}

function executionTargetForLaunch(record) {
  const projection = immutableLaunchProjection(record);
  const binding = projection.executionBinding;
  if (!isRecord(binding) || !isRecord(binding.actor)) throw storeError('launch_unavailable');
  return {
    kind: 'execution',
    launchRef: projection.launchRef,
    claims: projection.claims,
    identity: projection.identity,
    periodId: binding.periodId,
    actor: binding.actor,
    conversationId: projection.conversationId,
    sessionId: projection.sessionId,
  };
}

function safeExecutionRecord(snapshot, binding, identity = undefined) {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.conversations) || !Array.isArray(snapshot.executions)) {
    throw storeError('registration_unavailable');
  }
  const matches = snapshot.executions.filter((item) => item.executionId === binding.periodId);
  if (matches.length !== 1) throw storeError('owner_unavailable');
  const execution = matches[0];
  const conversations = snapshot.conversations.filter((item) => item.conversationId === execution.conversationId);
  if (conversations.length !== 1 || (identity !== undefined && !jsonEqual(conversations[0].identity, identity))) {
    throw storeError('owner_unavailable');
  }
  return {
    executionId: execution.executionId,
    conversationId: execution.conversationId,
    sessionId: execution.sessionId,
    identity: conversations[0].identity,
  };
}

function providerMatches(record, provider) {
  return !provider || Boolean(record && record.provider === provider &&
    record.nativeIdKind === PROVIDER_NATIVE_ID_KINDS[provider]);
}

function createDurableDeliveryStore(options = {}) {
  if (!isRecord(options) || !options.registrationRegistry ||
      typeof options.registrationRegistry.snapshot !== 'function' ||
      !options.launchRegistry || typeof options.launchRegistry.get !== 'function' ||
      typeof options.launchRegistry.snapshot !== 'function' ||
      !options.runtimeRegistry || typeof options.runtimeRegistry.get !== 'function' ||
      typeof options.runtimeRegistry.snapshot !== 'function' ||
      typeof options.runtimeRegistry.checkCurrentProof !== 'function' || typeof options.resolveProof !== 'function' ||
      (options.verifyResultOwner !== undefined && typeof options.verifyResultOwner !== 'function')) {
    throw storeError('invalid_store_dependencies');
  }
  const limits = options.limits ?? {};
  if (!isRecord(limits) || Reflect.ownKeys(limits).some((key) => !['maxBytes', 'maxRecords'].includes(key)) ||
      (limits.maxBytes !== undefined && (!Number.isSafeInteger(limits.maxBytes) ||
       limits.maxBytes < 1 || limits.maxBytes > MAX_CONFIGURABLE_CHECKPOINT_BYTES)) ||
      (limits.maxRecords !== undefined && (!Number.isSafeInteger(limits.maxRecords) ||
       limits.maxRecords < 1 || limits.maxRecords > DEFAULT_MAX_RECORDS))) {
    throw storeError('invalid_store_limits');
  }
  const maxCheckpointBytes = limits.maxBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
  const checkpointOptions = { filePath: options.filePath };
  if (options.atomicWrite !== undefined) checkpointOptions.atomicWrite = options.atomicWrite;
  if (limits.maxBytes !== undefined) checkpointOptions.maxBytes = limits.maxBytes;
  if (limits.maxRecords !== undefined) checkpointOptions.maxRecords = limits.maxRecords;
  if (options.fileSystem !== undefined) checkpointOptions.fileSystem = options.fileSystem;
  const checkpointStore = createDurableCheckpointStore(checkpointOptions);
  const payloads = new Map();
  let currentCheckpoint = makeEmptyCheckpoint();
  let accepting = true;
  let writerBlocked = false;
  let tail = Promise.resolve();
  let closePromise = null;

  const ready = checkpointStore.load().then((checkpoint) => {
    assertCheckpointCapacityReserved(checkpoint, maxCheckpointBytes);
    currentCheckpoint = checkpoint;
    return Object.freeze({ ready: true, revision: checkpoint.revision });
  }).catch(async (error) => {
    writerBlocked = true;
    await checkpointStore.close().catch(() => {});
    throw error;
  });

  function enqueue(operation, allowBlocked = false) {
    if (!accepting) return Promise.reject(storeError('store_closed'));
    const result = tail.then(() => ready).then(() => {
      if (!allowBlocked && writerBlocked) throw storeError('store_writer_blocked');
      return operation();
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function registrationSnapshot() {
    const registration = syncRegistryCall(options.registrationRegistry, 'snapshot', [], 'registration_unavailable');
    const launches = syncRegistryCall(options.launchRegistry, 'snapshot', [], 'launch_unavailable');
    const runtime = syncRegistryCall(options.runtimeRegistry, 'snapshot', [], 'runtime_unavailable');
    return projectRegistrationSnapshots(registration, launches, runtime, {
      maxRecords: limits.maxRecords,
    });
  }

  function mergeCurrentRegistrations() {
    const incoming = registrationSnapshot();
    return mergeRegistrationHistory(currentCheckpoint.registrations, incoming, limits.maxRecords);
  }

  async function persist(registrations, ledger) {
    const candidate = {
      schemaVersion: currentCheckpoint.schemaVersion,
      revision: currentCheckpoint.revision + 1,
      registrations,
      ledger: validateLedger(ledger),
    };
    assertCheckpointCapacityReserved(candidate, maxCheckpointBytes);
    try {
      const saved = await checkpointStore.save(candidate);
      currentCheckpoint = saved;
      return saved;
    } catch (error) {
      if (error.code === 'checkpoint_write_failed' || error.code === 'checkpoint_writer_blocked') {
        writerBlocked = true;
      }
      throw error;
    }
  }

  function launchRecord(launchRef, provider) {
    const record = syncRegistryCall(options.launchRegistry, 'get', [launchRef], 'launch_unavailable');
    if (!record || record.launchRef !== launchRef || !providerMatches(record, provider)) {
      throw storeError(provider ? 'provider_mismatch' : 'launch_unavailable');
    }
    return structuredClone(record);
  }

  function sourceWithRuntime(launchRef, provider) {
    const source = launchRecord(launchRef, provider);
    const runtime = syncRegistryCall(options.runtimeRegistry, 'get', [launchRef], 'runtime_unavailable');
    if (!runtime || runtime.launchRef !== launchRef ||
        !jsonEqual(immutableLaunchProjection(source), {
          launchRef: runtime.launchRef,
          claims: Object.fromEntries(CLAIM_FIELDS.map((field) => [field, runtime[field]])),
          identity: runtime.identity,
          executionBinding: runtime.executionBinding,
          conversationId: runtime.conversationId,
          sessionId: runtime.sessionId,
        })) throw storeError('runtime_unavailable');
    return { ...source, currentOwner: runtime.currentOwner, ownerGeneration: runtime.ownerGeneration };
  }

  function freshExecutionProof(delivery) {
    const target = delivery.target;
    if (!target || target.kind !== 'execution') return false;
    let launch;
    let runtime;
    try {
      launch = launchRecord(target.launchRef);
      runtime = syncRegistryCall(options.runtimeRegistry, 'get', [target.launchRef], 'runtime_unavailable');
    } catch {
      return false;
    }
    if (!runtime || runtime.launchRef !== target.launchRef ||
        !jsonEqual(immutableLaunchProjection(launch), {
          launchRef: runtime.launchRef,
          claims: Object.fromEntries(CLAIM_FIELDS.map((field) => [field, runtime[field]])),
          identity: runtime.identity,
          executionBinding: runtime.executionBinding,
          conversationId: runtime.conversationId,
          sessionId: runtime.sessionId,
        }) || !jsonEqual(executionTargetForLaunch(launch), target)) return false;
    let proof;
    let proofCheck;
    try {
      proof = options.resolveProof(target.launchRef);
      if (proof && typeof proof.then === 'function' || proof === null || proof === undefined) return false;
      proofCheck = options.runtimeRegistry.checkCurrentProof(target.launchRef, proof);
      if (proofCheck && typeof proofCheck.then === 'function') return false;
    } catch {
      return false;
    }
    return proofCheck?.ok === true;
  }

  function freshResultOwner(delivery) {
    if (typeof options.verifyResultOwner !== 'function' || delivery.target?.kind !== 'owner') return false;
    try {
      const runtime = syncRegistryCall(options.runtimeRegistry, 'get', [delivery.source.launchRef], 'runtime_unavailable');
      if (!runtime || runtime.launchRef !== delivery.source.launchRef ||
          !jsonEqual(immutableLaunchProjection(runtime), immutableLaunchProjection(
            launchRecord(delivery.source.launchRef))) || !runtime.currentOwner ||
          runtime.ownerGeneration !== delivery.ownerGeneration ||
          runtime.currentOwner.periodId !== delivery.target.periodId ||
          !jsonEqual(runtime.currentOwner.actor, delivery.target.actor)) return false;
      const registration = syncRegistryCall(options.registrationRegistry, 'snapshot', [], 'registration_unavailable');
      const targetPeriod = safeExecutionRecord(registration, delivery.target, delivery.target.identity);
      if (!jsonEqual(targetPeriod, {
        executionId: delivery.target.periodId,
        conversationId: delivery.target.conversationId,
        sessionId: delivery.target.sessionId,
        identity: delivery.target.identity,
      })) return false;
      const publicDelivery = getDelivery(currentCheckpoint.ledger, delivery.deliveryAttemptId);
      const result = options.verifyResultOwner(publicDelivery);
      if (result && typeof result.then === 'function') return false;
      return result === true || result?.ok === true;
    } catch {
      return false;
    }
  }

  function freshAuthorization(delivery) {
    try {
      const source = launchRecord(delivery.source.launchRef);
      if (!jsonEqual(immutableLaunchProjection(source), delivery.source)) return false;
    } catch {
      return false;
    }
    if (delivery.kind === 'result') return freshResultOwner(delivery);
    return freshExecutionProof(delivery);
  }

  async function createDeliveryNow(kind, captured, provider) {
    const registrations = mergeCurrentRegistrations();
    let source;
    let targetRecord;
    if (kind === 'pr-notification') {
      source = launchRecord(captured.sourceLaunchRef);
      const registeredTarget = currentCheckpoint.ledger.notificationTargets.find((item) =>
        item.targetId === captured.targetId);
      if (!registeredTarget) throw storeError('target_unavailable');
      if (provider && !providerMatches(registeredTarget.launch.claims, provider)) {
        throw storeError('provider_mismatch');
      }
    } else if (kind === 'result') {
      source = sourceWithRuntime(captured.launchRef, provider);
      targetRecord = safeExecutionRecord(
        syncRegistryCall(options.registrationRegistry, 'snapshot', [], 'registration_unavailable'),
        source.currentOwner,
      );
    } else {
      source = sourceWithRuntime(captured.launchRef, provider);
    }
    const coreInput = kind === 'pr-notification'
      ? {
          targetId: captured.targetId,
          deliveryAttemptId: captured.deliveryAttemptId,
          logicalMessageId: captured.logicalMessageId,
          revision: captured.revision,
          payload: captured.payload,
        }
      : {
          deliveryAttemptId: captured.deliveryAttemptId,
          logicalMessageId: captured.logicalMessageId,
          revision: captured.revision,
          payload: captured.payload,
        };
    const result = createDelivery(currentCheckpoint.ledger, kind, coreInput, source, targetRecord);
    if (result.created || !jsonEqual(registrations, currentCheckpoint.registrations)) {
      await persist(registrations, result.ledger);
    }
    if (result.created) payloads.set(result.delivery.deliveryAttemptId, captured.payload);
    return result.delivery;
  }

  async function registerTargetNow(captured, provider) {
    const registrations = mergeCurrentRegistrations();
    const target = launchRecord(captured.launchRef, provider);
    const result = registerPrTarget(currentCheckpoint.ledger, captured.targetId, target);
    if (result.created || !jsonEqual(registrations, currentCheckpoint.registrations)) {
      await persist(registrations, result.ledger);
    }
    return result.target;
  }

  async function transitionNow(id, operation, correlation) {
    const result = transitionDelivery(currentCheckpoint.ledger, id, operation, correlation);
    if (result.changed) {
      await persist(currentCheckpoint.registrations, result.ledger);
      if (['cancelled_before_send', 'superseded_before_send'].includes(result.delivery.state)) {
        payloads.delete(id);
      }
    }
    return result.delivery;
  }

  async function markUnknownNow(id) {
    const result = transitionDelivery(currentCheckpoint.ledger, id, 'unknown');
    if (result.changed) await persist(currentCheckpoint.registrations, result.ledger);
    return result.delivery;
  }

  function observeSinkPromise(value, deliveryId) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
    let then;
    try { then = value.then; } catch {
      enqueue(() => markUnknownNow(deliveryId)).catch(() => {});
      return;
    }
    if (typeof then !== 'function') return;
    try {
      const observed = then.call(value, undefined, () => {
        enqueue(() => markUnknownNow(deliveryId)).catch(() => {});
      });
      if (observed && typeof observed.then === 'function') observed.catch(() => {});
    } catch {
      enqueue(() => markUnknownNow(deliveryId)).catch(() => {});
    }
  }

  async function sendStartNow(id, sink) {
    let registrations = mergeCurrentRegistrations();
    if (!jsonEqual(registrations, currentCheckpoint.registrations)) {
      await persist(registrations, currentCheckpoint.ledger);
    }
    const delivery = getDelivery(currentCheckpoint.ledger, id);
    if (!delivery) throw storeError('delivery_not_found');
    if (!payloads.has(id)) throw storeError('payload_unavailable');
    if (!freshAuthorization(delivery)) throw storeError('delivery_target_unavailable');
    registrations = mergeCurrentRegistrations();
    const started = transitionDelivery(currentCheckpoint.ledger, id, 'sendStart');
    await persist(registrations, started.ledger);
    const sending = getDelivery(currentCheckpoint.ledger, id);
    if (!freshAuthorization(sending)) {
      payloads.delete(id);
      return markUnknownNow(id);
    }
    const payload = payloads.get(id);
    if (typeof payload !== 'string') {
      payloads.delete(id);
      return markUnknownNow(id);
    }
    let sinkResult;
    try {
      sinkResult = sink(payload, getDelivery(currentCheckpoint.ledger, id));
    } catch {
      payloads.delete(id);
      return markUnknownNow(id);
    }
    payloads.delete(id);
    observeSinkPromise(sinkResult, id);
    return getDelivery(currentCheckpoint.ledger, id);
  }

  async function captureRegistrationsNow() {
    const registrations = mergeCurrentRegistrations();
    if (!jsonEqual(registrations, currentCheckpoint.registrations)) {
      await persist(registrations, currentCheckpoint.ledger);
    }
    return structuredClone(registrations);
  }

  async function rehydratePayloadNow(id, payload) {
    let registrations = mergeCurrentRegistrations();
    if (!jsonEqual(registrations, currentCheckpoint.registrations)) {
      await persist(registrations, currentCheckpoint.ledger);
    }
    const delivery = getDelivery(currentCheckpoint.ledger, id);
    if (!delivery) throw storeError('delivery_not_found');
    if (!['available', 'claimed'].includes(delivery.state)) throw storeError('payload_rehydrate_forbidden');
    if (typeof payload !== 'string' || digestPayload(payload) !== delivery.payloadDigest) {
      throw storeError('payload_digest_mismatch');
    }
    if (!freshAuthorization(delivery)) throw storeError('delivery_target_unavailable');
    payloads.set(id, payload);
    return delivery;
  }

  function createQuestionDeliveryForProvider(input, provider) {
    const captured = captureDeliveryInput(input, 'question');
    return enqueue(() => createDeliveryNow('question', captured, provider));
  }

  function createQuestionDelivery(input) {
    return createQuestionDeliveryForProvider(input, undefined);
  }

  function createResultDeliveryForProvider(input, provider) {
    const captured = captureDeliveryInput(input, 'result');
    return enqueue(() => createDeliveryNow('result', captured, provider));
  }

  function createResultDelivery(input) {
    return createResultDeliveryForProvider(input, undefined);
  }

  function registerPrNotificationTargetForProvider(input, provider) {
    const captured = captureExactRecord(input, TARGET_INPUT_FIELDS, 'invalid_target_input');
    if (!isIdentifier(captured.targetId) || !isIdentifier(captured.launchRef)) {
      throw storeError('invalid_target_input');
    }
    return enqueue(() => registerTargetNow(captured, provider));
  }

  function registerPrNotificationTarget(input) {
    return registerPrNotificationTargetForProvider(input, undefined);
  }

  function createPrNotificationForProvider(input, provider) {
    const captured = captureDeliveryInput(input, 'pr-notification');
    return enqueue(() => createDeliveryNow('pr-notification', captured, provider));
  }

  function createPrNotification(input) {
    return createPrNotificationForProvider(input, undefined);
  }

  function transitionById(id, operation, correlation) {
    if (!isIdentifier(id)) throw storeError('invalid_delivery_id');
    return enqueue(() => transitionNow(id, operation, correlation));
  }

  function deliveryMatchesProvider(delivery, provider) {
    const claims = delivery?.kind === 'pr-notification' ? delivery.target?.claims : delivery?.source?.claims;
    return claims?.provider === provider && claims.nativeIdKind === PROVIDER_NATIVE_ID_KINDS[provider];
  }

  function scopedTransition(id, operation, provider, correlation = undefined) {
    if (!isIdentifier(id)) throw storeError('invalid_delivery_id');
    return enqueue(() => {
      const delivery = getDelivery(currentCheckpoint.ledger, id);
      if (!delivery) throw storeError('delivery_not_found');
      if (!deliveryMatchesProvider(delivery, provider)) throw storeError('provider_mismatch');
      return transitionNow(id, operation, correlation);
    });
  }

  function scopedSendStart(id, sink, provider) {
    if (!isIdentifier(id) || typeof sink !== 'function') throw storeError('invalid_send_start');
    const trustedSink = sink;
    return enqueue(() => {
      const delivery = getDelivery(currentCheckpoint.ledger, id);
      if (!delivery) throw storeError('delivery_not_found');
      if (!deliveryMatchesProvider(delivery, provider)) throw storeError('provider_mismatch');
      return sendStartNow(id, trustedSink);
    });
  }

  function scopedRehydratePayload(id, payload, provider) {
    if (!isIdentifier(id) || typeof payload !== 'string') throw storeError('invalid_payload');
    const capturedPayload = payload;
    return enqueue(() => {
      const delivery = getDelivery(currentCheckpoint.ledger, id);
      if (!delivery) throw storeError('delivery_not_found');
      if (!deliveryMatchesProvider(delivery, provider)) throw storeError('provider_mismatch');
      return rehydratePayloadNow(id, capturedPayload);
    });
  }

  function scopedGet(id, provider) {
    if (!isIdentifier(id)) return Promise.resolve(null);
    return enqueue(() => {
      const delivery = getDelivery(currentCheckpoint.ledger, id);
      return delivery && deliveryMatchesProvider(delivery, provider) ? delivery : null;
    }, true);
  }

  function claim(id) { return transitionById(id, 'claim'); }
  function cancel(id) { return transitionById(id, 'cancel'); }
  function supersedeUnsentDelivery(id) { return transitionById(id, 'supersede'); }

  function sendStart(id, sink) {
    if (!isIdentifier(id) || typeof sink !== 'function') throw storeError('invalid_send_start');
    const trustedSink = sink;
    return enqueue(() => sendStartNow(id, trustedSink));
  }

  function recordAccepted(id, correlation) {
    if (!isIdentifier(id)) throw storeError('invalid_delivery_id');
    const captured = captureCorrelation(correlation);
    return enqueue(() => transitionNow(id, 'accepted', captured));
  }

  function recordApplied(id, correlation) {
    if (!isIdentifier(id)) throw storeError('invalid_delivery_id');
    const captured = captureCorrelation(correlation);
    return enqueue(() => transitionNow(id, 'applied', captured));
  }

  function recordAcceptedForProvider(id, correlation, provider) {
    if (!isIdentifier(id)) throw storeError('invalid_delivery_id');
    const captured = captureCorrelation(correlation);
    return scopedTransition(id, 'accepted', provider, captured);
  }

  function recordAppliedForProvider(id, correlation, provider) {
    if (!isIdentifier(id)) throw storeError('invalid_delivery_id');
    const captured = captureCorrelation(correlation);
    return scopedTransition(id, 'applied', provider, captured);
  }

  function markUnknownForProvider(id, provider) {
    return scopedTransition(id, 'unknown', provider);
  }

  function markUnknown(id) {
    if (!isIdentifier(id)) throw storeError('invalid_delivery_id');
    return enqueue(() => markUnknownNow(id));
  }

  function rehydratePayload(id, payload) {
    if (!isIdentifier(id) || typeof payload !== 'string') throw storeError('invalid_payload');
    const capturedPayload = payload;
    return enqueue(() => rehydratePayloadNow(id, capturedPayload));
  }

  function captureRegistrations() {
    return enqueue(() => captureRegistrationsNow());
  }

  function get(id) {
    if (!isIdentifier(id)) return Promise.resolve(null);
    return enqueue(() => getDelivery(currentCheckpoint.ledger, id), true);
  }

  function snapshot() {
    return enqueue(() => snapshotLedger(currentCheckpoint.ledger), true);
  }

  function flush() {
    if (!accepting) return Promise.reject(storeError('store_closed'));
    return tail.then(() => ready).then(() => undefined);
  }

  function close() {
    if (closePromise) return closePromise;
    accepting = false;
    closePromise = tail.then(() => ready.catch(() => undefined)).then(async () => {
      payloads.clear();
      await checkpointStore.close();
    });
    return closePromise;
  }

  const store = Object.freeze({
    ready,
    createQuestionDelivery,
    createResultDelivery,
    registerPrNotificationTarget,
    createPrNotification,
    claim,
    cancel,
    supersedeUnsentDelivery,
    sendStart,
    recordAccepted,
    recordApplied,
    markUnknown,
    rehydratePayload,
    captureRegistrations,
    get,
    snapshot,
    flush,
    close,
  });
  STORE_INTERNALS.set(store, { createQuestionDelivery: createQuestionDeliveryForProvider,
    createResultDelivery: createResultDeliveryForProvider,
    registerPrNotificationTarget: registerPrNotificationTargetForProvider,
    createPrNotification: createPrNotificationForProvider, scopedTransition, scopedSendStart,
    recordAcceptedForProvider, recordAppliedForProvider, markUnknownForProvider,
    scopedRehydratePayload, scopedGet });
  return store;
}

function createProviderDeliveryAdapter(provider, store) {
  if (!Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, provider) || !store || !STORE_INTERNALS.has(store)) {
    throw storeError('invalid_provider_adapter');
  }
  const internal = STORE_INTERNALS.get(store);
  return Object.freeze({
    provider,
    ready: store.ready,
    createQuestionDelivery: (input) => internal.createQuestionDelivery(input, provider),
    createResultDelivery: (input) => internal.createResultDelivery(input, provider),
    registerPrNotificationTarget: (input) => internal.registerPrNotificationTarget(input, provider),
    createPrNotification: (input) => internal.createPrNotification(input, provider),
    claim: (id) => internal.scopedTransition(id, 'claim', provider),
    cancel: (id) => internal.scopedTransition(id, 'cancel', provider),
    supersedeUnsentDelivery: (id) => internal.scopedTransition(id, 'supersede', provider),
    sendStart: (id, sink) => internal.scopedSendStart(id, sink, provider),
    recordAccepted: (id, correlation) => internal.recordAcceptedForProvider(id, correlation, provider),
    recordApplied: (id, correlation) => internal.recordAppliedForProvider(id, correlation, provider),
    markUnknown: (id) => internal.markUnknownForProvider(id, provider),
    rehydratePayload: (id, payload) => internal.scopedRehydratePayload(id, payload, provider),
    captureRegistrations: store.captureRegistrations,
    get: (id) => internal.scopedGet(id, provider),
    snapshot: store.snapshot,
    flush: store.flush,
    close: store.close,
  });
}

module.exports = { createDurableDeliveryStore, createProviderDeliveryAdapter };
