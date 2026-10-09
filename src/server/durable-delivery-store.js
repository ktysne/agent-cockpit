'use strict';

const { createHash } = require('node:crypto');
const { types: utilTypes } = require('node:util');
const { AsyncLocalStorage } = require('node:async_hooks');
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
const {
  normalizeCheckpointV3Local,
  normalizeDeliveryLedgerV2Local,
} = require('./delivery-reclamation-codec');
const { checkedCapacityAdd, measureCheckpointReservation } = require('./reclamation-capacity-bounds');
const {
  createReclamationDelivery,
  getReclamationDelivery,
  registerReclamationTarget,
  transitionReclamationDelivery,
} = require('./delivery-reclamation-runtime');

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
const QUESTION_RETIREMENT_SCOPE = new AsyncLocalStorage();

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

function sameNativeIdentity(left, right) {
  return ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']
    .every((field) => left[field] === right[field]);
}

function reclamationTarget(record) {
  return record?.recordType === 'reclaimed' ? record.targetRef : record?.target;
}

function captureReclamationDependencies(value) {
  if (!isRecord(value) || Reflect.ownKeys(value).length !== 2 ||
      !Object.hasOwn(value, 'backend') || !Object.hasOwn(value, 'periodGate')) {
    throw storeError('invalid_reclamation_store_dependencies');
  }
  const backend = Object.getOwnPropertyDescriptor(value, 'backend')?.value;
  const periodGate = Object.getOwnPropertyDescriptor(value, 'periodGate')?.value;
  if (!backend || backend.slot !== 'checkpoint' ||
      typeof backend.canWrite !== 'function' ||
      typeof backend.load !== 'function' || typeof backend.save !== 'function' ||
      typeof backend.prepareResume !== 'function' || typeof backend.flush !== 'function' ||
      typeof backend.close !== 'function' || !Number.isSafeInteger(backend.normalByteLimit) ||
      backend.normalByteLimit < 1 || backend.normalByteLimit > 16 * 1024 * 1024 ||
      !periodGate || typeof periodGate.capture !== 'function' ||
      typeof periodGate.assertCurrent !== 'function' || typeof periodGate.assertRetirement !== 'function') {
    throw storeError('invalid_reclamation_store_dependencies');
  }
  return { backend, periodGate };
}

function createDurableDeliveryStore(options = {}) {
  if (!isRecord(options) || !options.registrationRegistry ||
      typeof options.registrationRegistry.snapshot !== 'function' ||
      !options.launchRegistry || typeof options.launchRegistry.get !== 'function' ||
      typeof options.launchRegistry.snapshot !== 'function' ||
      !options.runtimeRegistry || typeof options.runtimeRegistry.get !== 'function' ||
      typeof options.runtimeRegistry.snapshot !== 'function' ||
      typeof options.runtimeRegistry.checkCurrentProof !== 'function' || typeof options.resolveProof !== 'function' ||
      (options.verifyResultOwner !== undefined && typeof options.verifyResultOwner !== 'function') ||
      (options.verifyInstructionTarget !== undefined && typeof options.verifyInstructionTarget !== 'function') ||
      (options.now !== undefined && typeof options.now !== 'function')) {
    throw storeError('invalid_store_dependencies');
  }
  const reclamation = options.reclamation === undefined
    ? null : captureReclamationDependencies(options.reclamation);
  const limits = options.limits ?? {};
  if (!isRecord(limits) || Reflect.ownKeys(limits).some((key) => !['maxBytes', 'maxRecords'].includes(key)) ||
      (limits.maxBytes !== undefined && (!Number.isSafeInteger(limits.maxBytes) ||
       limits.maxBytes < 1 || limits.maxBytes > MAX_CONFIGURABLE_CHECKPOINT_BYTES)) ||
      (limits.maxRecords !== undefined && (!Number.isSafeInteger(limits.maxRecords) ||
       limits.maxRecords < 1 || limits.maxRecords > DEFAULT_MAX_RECORDS))) {
    throw storeError('invalid_store_limits');
  }
  const maxCheckpointBytes = reclamation
    ? reclamation.backend.normalByteLimit : limits.maxBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
  if (reclamation && limits.maxBytes !== undefined && limits.maxBytes !== maxCheckpointBytes) {
    throw storeError('invalid_store_limits');
  }
  const checkpointOptions = reclamation
    ? { reclamation: options.reclamation }
    : { filePath: options.filePath };
  if (!reclamation && options.atomicWrite !== undefined) checkpointOptions.atomicWrite = options.atomicWrite;
  if (limits.maxBytes !== undefined) checkpointOptions.maxBytes = limits.maxBytes;
  if (limits.maxRecords !== undefined) checkpointOptions.maxRecords = limits.maxRecords;
  if (options.fileSystem !== undefined) checkpointOptions.fileSystem = options.fileSystem;
  const checkpointStore = createDurableCheckpointStore(checkpointOptions);
  const payloads = new Map();
  let currentCheckpoint = makeEmptyCheckpoint();
  let accepting = true;
  let reclamationPrepared = reclamation === null;
  let writerBlocked = false;
  let tail = Promise.resolve();
  let closePromise = null;
  const retirementScopeToken = {};

  const ready = checkpointStore.load().then((checkpoint) => {
    if (reclamation) {
      currentCheckpoint = assertReclamationCheckpointCapacity(checkpoint, null, true);
    }
    else assertCheckpointCapacityReserved(checkpoint, maxCheckpointBytes);
    if (!reclamation) currentCheckpoint = checkpoint;
    reclamationPrepared = reclamation !== null;
    return Object.freeze({ ready: true, revision: checkpoint.revision });
  }).catch(async (error) => {
    writerBlocked = true;
    await checkpointStore.close().catch(() => {});
    throw error;
  });

  function enqueue(operation, allowBlocked = false) {
    if (QUESTION_RETIREMENT_SCOPE.getStore() === retirementScopeToken) {
      return Promise.reject(storeError('question_retirement_queue_reentry'));
    }
    let backendCanWrite = true;
    if (reclamation) {
      try { backendCanWrite = reclamation.backend.canWrite() === true; }
      catch { backendCanWrite = false; }
    }
    if (reclamation && !reclamationPrepared) {
      return Promise.reject(storeError('reclamation_writer_cold'));
    }
    if (!backendCanWrite) return Promise.reject(storeError('reclamation_service_blocked'));
    if (!accepting) return Promise.reject(storeError('store_closed'));
    const result = tail.then(() => {
      if (reclamation) {
        let canWrite = false;
        try { canWrite = reclamation.backend.canWrite() === true; } catch {}
        if (!canWrite) throw storeError('reclamation_service_blocked');
        if (!reclamationPrepared) throw storeError('reclamation_writer_cold');
      }
      return ready;
    }).then(() => {
      if (!allowBlocked && writerBlocked) throw storeError('store_writer_blocked');
      return operation();
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function assertReclamationCheckpointCapacity(checkpoint, existingAttemptId = null, allowExistingGrant = false) {
    const normalized = normalizeCheckpointV3Local(checkpoint, limits.maxRecords ?? DEFAULT_MAX_RECORDS);
    const measurement = measureCheckpointReservation({
      snapshot: normalized,
      currentByteLimit: maxCheckpointBytes,
    });
    const grant = normalized.migrationAllowance;
    const eligible = grant !== null && (allowExistingGrant ||
      existingAttemptId !== null && grant.eligibleAttemptIds.includes(existingAttemptId));
    const limitBytes = eligible
      ? checkedCapacityAdd(maxCheckpointBytes, grant.maxExtraBytes)
      : maxCheckpointBytes;
    if (measurement.reservedBytes > limitBytes) throw storeError('checkpoint_capacity_reserved');
    return normalized;
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

  function currentDelivery(deliveryAttemptId) {
    return reclamation
      ? getReclamationDelivery(currentCheckpoint, deliveryAttemptId)
      : getDelivery(currentCheckpoint.ledger, deliveryAttemptId);
  }

  function assertQuestionTokenForDelivery(deliveryAttemptId, token) {
    if (!reclamation) return;
    const delivery = currentCheckpoint.ledger.deliveries.find((item) =>
      item.deliveryAttemptId === deliveryAttemptId);
    if (delivery?.kind !== 'question') return;
    if (token === undefined) throw storeError('question_gate_token_missing');
    reclamation.periodGate.assertCurrent(token);
  }

  function captureQuestionTokenForDelivery(deliveryAttemptId) {
    if (!reclamation) return undefined;
    if (!reclamationPrepared || !currentCheckpoint?.ledger?.deliveries) {
      throw storeError('reclamation_writer_cold');
    }
    const delivery = currentCheckpoint.ledger.deliveries.find((item) =>
      item.deliveryAttemptId === deliveryAttemptId);
    if (delivery?.kind !== 'question') return undefined;
    const target = reclamationTarget(delivery);
    if (!target?.identity || typeof target.periodId !== 'string') {
      throw storeError('question_gate_target_unavailable');
    }
    return reclamation.periodGate.capture(target.identity, target.periodId);
  }

  function captureQuestionTokenForLaunch(launchRef, provider) {
    if (!reclamation) return undefined;
    if (!reclamationPrepared) throw storeError('reclamation_writer_cold');
    const source = sourceWithRuntime(launchRef, provider);
    return reclamation.periodGate.capture(source.identity, source.executionBinding.periodId);
  }

  function checkpointCandidate(registrations, ledger, existingAttemptId = null) {
    if (reclamation) {
      if (currentCheckpoint.revision >= Number.MAX_SAFE_INTEGER) {
        throw storeError('checkpoint_revision_overflow');
      }
      return assertReclamationCheckpointCapacity({
        schemaVersion: 3,
        storeId: currentCheckpoint.storeId,
        revision: currentCheckpoint.revision + 1,
        registrations,
        ledger: normalizeDeliveryLedgerV2Local(ledger),
        migrationAllowance: currentCheckpoint.migrationAllowance,
      }, existingAttemptId);
    }
    const candidate = {
      schemaVersion: currentCheckpoint.schemaVersion,
      revision: currentCheckpoint.revision + 1,
      registrations,
      ledger: validateLedger(ledger),
    };
    assertCheckpointCapacityReserved(candidate, maxCheckpointBytes);
    return candidate;
  }

  async function persistCandidate(candidate, token = undefined) {
    try {
      const assertBeforeWrite = reclamation && token !== undefined
        ? () => reclamation.periodGate.assertCurrent(token)
        : undefined;
      assertBeforeWrite?.();
      const saved = assertBeforeWrite === undefined
        ? await checkpointStore.save(candidate)
        : await checkpointStore.save(candidate, assertBeforeWrite);
      currentCheckpoint = saved;
      return saved;
    } catch (error) {
      if (error.code === 'checkpoint_write_failed' || error.code === 'checkpoint_writer_blocked') {
        writerBlocked = true;
      }
      throw error;
    }
  }

  async function persist(registrations, ledger, options = {}) {
    return persistCandidate(checkpointCandidate(registrations, ledger, options.existingAttemptId), options.token);
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
      const publicDelivery = currentDelivery(delivery.deliveryAttemptId);
      const result = options.verifyResultOwner(publicDelivery);
      if (result && typeof result.then === 'function') return false;
      return result === true || result?.ok === true;
    } catch {
      return false;
    }
  }

  function freshInstructionTarget(delivery) {
    if (typeof options.verifyInstructionTarget !== 'function') return false;
    try {
      const publicDelivery = currentDelivery(delivery.deliveryAttemptId);
      if (!publicDelivery || publicDelivery.kind !== 'instruction') return false;
      const result = options.verifyInstructionTarget(publicDelivery);
      if (result instanceof Promise) {
        result.catch(() => {});
        return false;
      }
      if (result !== null && (typeof result === 'object' || typeof result === 'function') &&
          typeof result.then === 'function') return false;
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
    if (delivery.kind === 'instruction') return freshInstructionTarget(delivery);
    return freshExecutionProof(delivery);
  }

  async function createDeliveryNow(kind, captured, provider, questionToken = undefined) {
    if (kind === 'question' && reclamation) reclamation.periodGate.assertCurrent(questionToken);
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
    const result = reclamation
      ? createReclamationDelivery(currentCheckpoint, kind, coreInput, source, targetRecord)
      : createDelivery(currentCheckpoint.ledger, kind, coreInput, source, targetRecord);
    if (result.created || !jsonEqual(registrations, currentCheckpoint.registrations)) {
      await persist(registrations, result.ledger, {
        token: kind === 'question' ? questionToken : undefined,
      });
    }
    if (result.created) payloads.set(result.delivery.deliveryAttemptId, captured.payload);
    return result.delivery;
  }

  async function registerTargetNow(captured, provider) {
    const registrations = mergeCurrentRegistrations();
    const target = launchRecord(captured.launchRef, provider);
    const result = reclamation
      ? registerReclamationTarget(currentCheckpoint, captured.targetId, target)
      : registerPrTarget(currentCheckpoint.ledger, captured.targetId, target);
    if (result.created || !jsonEqual(registrations, currentCheckpoint.registrations)) {
      await persist(registrations, result.ledger);
    }
    return result.target;
  }

  async function transitionNow(id, operation, correlation, questionToken = undefined) {
    assertQuestionTokenForDelivery(id, questionToken);
    const result = reclamation
      ? transitionReclamationDelivery(currentCheckpoint, id, operation, correlation, options.now || Date.now)
      : transitionDelivery(currentCheckpoint.ledger, id, operation, correlation);
    if (result.changed) {
      await persist(currentCheckpoint.registrations, result.ledger, {
        existingAttemptId: reclamation ? id : undefined,
        token: questionToken,
      });
      if (['cancelled_before_send', 'superseded_before_send'].includes(result.delivery.state)) {
        payloads.delete(id);
      }
    }
    return result.delivery;
  }

  async function recordAppliedInstructionNow(id, correlation, beginCommit, provider) {
    const delivery = currentDelivery(id);
    if (!delivery) throw storeError('delivery_not_found');
    if (delivery.recordType === 'reclaimed') throw storeError('delivery_reclaimed');
    if (delivery.kind !== 'instruction') throw storeError('delivery_kind_mismatch');
    if (!deliveryMatchesProvider(delivery, provider)) throw storeError('provider_mismatch');
    const registrations = mergeCurrentRegistrations();
    const transition = reclamation
      ? transitionReclamationDelivery(currentCheckpoint, id, 'applied', correlation, options.now || Date.now)
      : transitionDelivery(currentCheckpoint.ledger, id, 'applied', correlation);
    if (!transition.changed) return transition.delivery;
    const candidate = checkpointCandidate(registrations, transition.ledger,
      reclamation && jsonEqual(registrations, currentCheckpoint.registrations) ? id : null);
    let guardResult;
    try { guardResult = beginCommit(); } catch { throw storeError('instruction_apply_commit_rejected'); }
    if (utilTypes.isPromise(guardResult)) {
      Promise.prototype.then.call(guardResult, undefined, () => {});
      throw storeError('instruction_apply_commit_rejected');
    }
    if (guardResult !== true) throw storeError('instruction_apply_commit_rejected');
    const write = persistCandidate(candidate);
    await write;
    return transition.delivery;
  }
  async function markUnknownNow(id, questionToken = undefined) {
    if (reclamation) return transitionNow(id, 'unknown', undefined, questionToken);
    const result = transitionDelivery(currentCheckpoint.ledger, id, 'unknown');
    if (result.changed) await persist(currentCheckpoint.registrations, result.ledger);
    return result.delivery;
  }

  function observeSinkPromise(value, deliveryId, questionToken = undefined) {
    if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return;
    let then;
    try { then = value.then; } catch {
      enqueue(() => markUnknownNow(deliveryId, questionToken)).catch(() => {});
      return;
    }
    if (typeof then !== 'function') return;
    try {
      const observed = then.call(value, undefined, () => {
        enqueue(() => markUnknownNow(deliveryId, questionToken)).catch(() => {});
      });
      if (observed && typeof observed.then === 'function') observed.catch(() => {});
    } catch {
      enqueue(() => markUnknownNow(deliveryId, questionToken)).catch(() => {});
    }
  }

  async function sendStartNow(id, sink, questionToken = undefined) {
    assertQuestionTokenForDelivery(id, questionToken);
    let registrations = mergeCurrentRegistrations();
    if (!jsonEqual(registrations, currentCheckpoint.registrations)) {
      await persist(registrations, currentCheckpoint.ledger, { token: questionToken });
    }
    const delivery = currentDelivery(id);
    if (!delivery) throw storeError('delivery_not_found');
    if (delivery.recordType === 'reclaimed') throw storeError('delivery_reclaimed');
    if (!payloads.has(id)) throw storeError('payload_unavailable');
    if (!freshAuthorization(delivery)) throw storeError('delivery_target_unavailable');
    registrations = mergeCurrentRegistrations();
    assertQuestionTokenForDelivery(id, questionToken);
    const started = reclamation
      ? transitionReclamationDelivery(currentCheckpoint, id, 'sendStart', undefined, options.now || Date.now)
      : transitionDelivery(currentCheckpoint.ledger, id, 'sendStart');
    await persist(registrations, started.ledger, {
      existingAttemptId: reclamation ? id : undefined,
      token: questionToken,
    });
    const sending = currentDelivery(id);
    if (!freshAuthorization(sending)) {
      payloads.delete(id);
      return markUnknownNow(id, questionToken);
    }
    const payload = payloads.get(id);
    if (typeof payload !== 'string') {
      payloads.delete(id);
      return markUnknownNow(id, questionToken);
    }
    let sinkResult;
    try {
      assertQuestionTokenForDelivery(id, questionToken);
      sinkResult = sink(payload, currentDelivery(id));
    } catch {
      payloads.delete(id);
      return markUnknownNow(id, questionToken);
    }
    payloads.delete(id);
    observeSinkPromise(sinkResult, id, questionToken);
    return currentDelivery(id);
  }

  async function captureRegistrationsNow() {
    const registrations = mergeCurrentRegistrations();
    if (!jsonEqual(registrations, currentCheckpoint.registrations)) {
      await persist(registrations, currentCheckpoint.ledger);
    }
    return structuredClone(registrations);
  }

  async function rehydratePayloadNow(id, payload, questionToken = undefined) {
    assertQuestionTokenForDelivery(id, questionToken);
    let registrations = mergeCurrentRegistrations();
    if (!jsonEqual(registrations, currentCheckpoint.registrations)) {
      await persist(registrations, currentCheckpoint.ledger, { token: questionToken });
    }
    const delivery = currentDelivery(id);
    if (!delivery) throw storeError('delivery_not_found');
    if (delivery.recordType === 'reclaimed') throw storeError('delivery_reclaimed');
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
    const token = captureQuestionTokenForLaunch(captured.launchRef, provider);
    return enqueue(() => createDeliveryNow('question', captured, provider, token));
  }

  function createQuestionDelivery(input) {
    return createQuestionDeliveryForProvider(input, undefined);
  }

  function createInstructionDeliveryForProvider(input, provider) {
    const captured = captureDeliveryInput(input, 'instruction');
    return enqueue(() => createDeliveryNow('instruction', captured, provider));
  }

  function createInstructionDelivery(input) {
    return createInstructionDeliveryForProvider(input, undefined);
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
    const token = captureQuestionTokenForDelivery(id);
    return enqueue(() => transitionNow(id, operation, correlation, token));
  }

  function deliveryMatchesProvider(delivery, provider) {
    const reclaimed = delivery?.recordType === 'reclaimed';
    const target = reclaimed ? delivery.targetRef : delivery?.target;
    const source = reclaimed ? delivery.sourceRef : delivery?.source;
    const claims = delivery?.kind === 'pr-notification' ? target?.claims : source?.claims;
    const identity = delivery?.kind === 'pr-notification' ? target?.identity : source?.identity;
    return (claims?.provider ?? identity?.provider) === provider &&
      (claims?.nativeIdKind ?? identity?.nativeIdKind) === PROVIDER_NATIVE_ID_KINDS[provider];
  }

  function scopedTransition(id, operation, provider, correlation = undefined) {
    if (!isIdentifier(id)) throw storeError('invalid_delivery_id');
    const token = captureQuestionTokenForDelivery(id);
    return enqueue(() => {
      assertQuestionTokenForDelivery(id, token);
      const delivery = currentDelivery(id);
      if (!delivery) throw storeError('delivery_not_found');
      if (delivery.recordType === 'reclaimed') throw storeError('delivery_reclaimed');
      if (!deliveryMatchesProvider(delivery, provider)) throw storeError('provider_mismatch');
      return transitionNow(id, operation, correlation, token);
    });
  }

  function scopedRecordAppliedInstruction(id, correlation, beginCommit, provider) {
    if (!isIdentifier(id) || typeof beginCommit !== 'function') {
      throw storeError('invalid_instruction_apply_commit');
    }
    const captured = captureCorrelation(correlation);
    return enqueue(() => recordAppliedInstructionNow(id, captured, beginCommit, provider));
  }
  function scopedSendStart(id, sink, provider) {
    if (!isIdentifier(id) || typeof sink !== 'function') throw storeError('invalid_send_start');
    const trustedSink = sink;
    const token = captureQuestionTokenForDelivery(id);
    return enqueue(() => {
      assertQuestionTokenForDelivery(id, token);
      const delivery = currentDelivery(id);
      if (!delivery) throw storeError('delivery_not_found');
      if (delivery.recordType === 'reclaimed') throw storeError('delivery_reclaimed');
      if (!deliveryMatchesProvider(delivery, provider)) throw storeError('provider_mismatch');
      return sendStartNow(id, trustedSink, token);
    });
  }

  function scopedRehydratePayload(id, payload, provider) {
    if (!isIdentifier(id) || typeof payload !== 'string') throw storeError('invalid_payload');
    const capturedPayload = payload;
    const token = captureQuestionTokenForDelivery(id);
    return enqueue(() => {
      assertQuestionTokenForDelivery(id, token);
      const delivery = currentDelivery(id);
      if (!delivery) throw storeError('delivery_not_found');
      if (delivery.recordType === 'reclaimed') throw storeError('delivery_reclaimed');
      if (!deliveryMatchesProvider(delivery, provider)) throw storeError('provider_mismatch');
      return rehydratePayloadNow(id, capturedPayload, token);
    });
  }

  function scopedGet(id, provider) {
    if (!isIdentifier(id)) return Promise.resolve(null);
    const token = captureQuestionTokenForDelivery(id);
    return enqueue(() => {
      assertQuestionTokenForDelivery(id, token);
      const delivery = currentDelivery(id);
      return delivery && deliveryMatchesProvider(delivery, provider) ? delivery : null;
    }, true);
  }

  function claim(id) { return transitionById(id, 'claim'); }
  function cancel(id) { return transitionById(id, 'cancel'); }
  function supersedeUnsentDelivery(id) { return transitionById(id, 'supersede'); }

  function sendStart(id, sink) {
    if (!isIdentifier(id) || typeof sink !== 'function') throw storeError('invalid_send_start');
    const trustedSink = sink;
    const token = captureQuestionTokenForDelivery(id);
    return enqueue(() => sendStartNow(id, trustedSink, token));
  }

  function recordAccepted(id, correlation) {
    if (!isIdentifier(id)) throw storeError('invalid_delivery_id');
    const captured = captureCorrelation(correlation);
    const token = captureQuestionTokenForDelivery(id);
    return enqueue(() => transitionNow(id, 'accepted', captured, token));
  }

  function recordApplied(id, correlation) {
    if (!isIdentifier(id)) throw storeError('invalid_delivery_id');
    const captured = captureCorrelation(correlation);
    const token = captureQuestionTokenForDelivery(id);
    return enqueue(() => transitionNow(id, 'applied', captured, token));
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
    const token = captureQuestionTokenForDelivery(id);
    return enqueue(() => markUnknownNow(id, token));
  }

  function rehydratePayload(id, payload) {
    if (!isIdentifier(id) || typeof payload !== 'string') throw storeError('invalid_payload');
    const capturedPayload = payload;
    const token = captureQuestionTokenForDelivery(id);
    return enqueue(() => rehydratePayloadNow(id, capturedPayload, token));
  }

  function captureRegistrations() {
    return enqueue(() => captureRegistrationsNow());
  }

  function get(id) {
    if (!isIdentifier(id)) return Promise.resolve(null);
    const token = captureQuestionTokenForDelivery(id);
    return enqueue(() => {
      assertQuestionTokenForDelivery(id, token);
      return currentDelivery(id);
    }, true);
  }

  function snapshot() {
    return enqueue(() => reclamation
      ? structuredClone(currentCheckpoint.ledger)
      : snapshotLedger(currentCheckpoint.ledger), true);
  }

  async function readNativeRecoverySnapshotNow() {
    await ready;
    await tail;
    if (!accepting) throw storeError('store_closed');
    return structuredClone(currentCheckpoint);
  }

  function flush() {
    if (!accepting) return Promise.reject(storeError('store_closed'));
    if (reclamation && !reclamationPrepared) return Promise.reject(storeError('reclamation_writer_cold'));
    if (reclamation) return tail.then(() => checkpointStore.flush());
    return tail.then(() => ready).then(() => undefined);
  }

  async function prepareResumeReclamation(fullSnapshot) {
    if (closePromise) throw storeError('store_closed');
    if (!reclamation || !isRecord(fullSnapshot) || !isRecord(fullSnapshot.stores) ||
        !Object.hasOwn(fullSnapshot.stores, 'checkpoint')) {
      throw storeError('invalid_reclamation_checkpoint_resume');
    }
    const resumed = assertReclamationCheckpointCapacity(fullSnapshot.stores.checkpoint, null, true);
    try {
      await checkpointStore.prepareResume(fullSnapshot);
      if (closePromise) throw storeError('store_closed');
      currentCheckpoint = resumed;
      payloads.clear();
      writerBlocked = false;
      reclamationPrepared = true;
      accepting = true;
    } catch (error) {
      writerBlocked = true;
      throw error;
    }
  }

  async function withQuestionRetirement(ticket, callback) {
    if (!reclamation || typeof callback !== 'function') throw storeError('invalid_question_retirement');
    reclamation.periodGate.assertRetirement(ticket);
    return enqueue(async () => {
      reclamation.periodGate.assertRetirement(ticket);
      let active = true;
      const assertAccess = () => {
        if (!active) throw storeError('question_retirement_access_expired');
        reclamation.periodGate.assertRetirement(ticket);
      };
      const access = Object.freeze({
        snapshot: () => {
          assertAccess();
          return structuredClone(currentCheckpoint);
        },
        persist: async (candidateValue) => {
          assertAccess();
          const candidate = normalizeCheckpointV3Local(candidateValue, limits.maxRecords ?? DEFAULT_MAX_RECORDS);
          if (currentCheckpoint.revision >= Number.MAX_SAFE_INTEGER ||
              currentCheckpoint.ledger.revision >= Number.MAX_SAFE_INTEGER) {
            throw storeError('checkpoint_revision_overflow');
          }
          if (candidate.storeId !== currentCheckpoint.storeId ||
              candidate.revision !== currentCheckpoint.revision + 1 ||
              candidate.ledger.revision !== currentCheckpoint.ledger.revision + 1 ||
              !jsonEqual(candidate.registrations, currentCheckpoint.registrations) ||
              !jsonEqual(candidate.migrationAllowance, currentCheckpoint.migrationAllowance)) {
            throw storeError('invalid_question_retirement_candidate');
          }
          assertReclamationCheckpointCapacity(candidate, null, true);
          assertAccess();
          try {
            const assertBeforeWrite = () => assertAccess();
            const saved = await checkpointStore.save(candidate, assertBeforeWrite);
            currentCheckpoint = saved;
            return structuredClone(saved);
          } catch (error) {
            if (error.code === 'checkpoint_write_failed' || error.code === 'checkpoint_writer_blocked') {
              writerBlocked = true;
            }
            throw error;
          }
        },
      });
      try {
        return await QUESTION_RETIREMENT_SCOPE.run(retirementScopeToken, () => callback(access));
      } finally {
        active = false;
      }
    });
  }

  async function withRetiredQuestionCheckpoint(value, callback) {
    if (!reclamation || typeof callback !== 'function') {
      throw storeError('invalid_question_body_reclamation');
    }
    const captured = captureExactRecord(value, ['identity', 'periodId'], 'invalid_question_body_reclamation');
    const request = Object.freeze({
      identity: Object.freeze(captureExactRecord(captured.identity,
        ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'], 'invalid_question_body_reclamation')),
      periodId: captured.periodId,
    });
    const assertRetired = () => {
      let canWrite = false;
      try { canWrite = reclamation.backend.canWrite() === true; } catch {}
      if (!accepting || closePromise || !reclamationPrepared || !canWrite ||
          !reclamation.periodGate.isRetired(request.identity, request.periodId)) {
        throw storeError('question_period_not_retired');
      }
    };
    assertRetired();
    return enqueue(async () => {
      assertRetired();
      let active = true;
      const assertAccess = () => {
        if (!active || QUESTION_RETIREMENT_SCOPE.getStore() !== retirementScopeToken) {
          throw storeError('question_retirement_access_expired');
        }
        assertRetired();
      };
      const access = Object.freeze({
        snapshot() {
          assertAccess();
          return structuredClone(currentCheckpoint);
        },
        async persist(candidateValue, deliveryAttemptId) {
          assertAccess();
          if (!isIdentifier(deliveryAttemptId)) throw storeError('invalid_question_body_reclamation');
          const candidate = normalizeCheckpointV3Local(candidateValue, limits.maxRecords ?? DEFAULT_MAX_RECORDS);
          const previous = currentCheckpoint;
          if (previous.revision >= Number.MAX_SAFE_INTEGER || previous.ledger.revision >= Number.MAX_SAFE_INTEGER ||
              candidate.storeId !== previous.storeId || candidate.revision !== previous.revision + 1 ||
              candidate.ledger.revision !== previous.ledger.revision + 1 ||
              !jsonEqual(candidate.registrations, previous.registrations) ||
              !jsonEqual(candidate.migrationAllowance, previous.migrationAllowance) ||
              !jsonEqual(candidate.ledger.notificationTargets, previous.ledger.notificationTargets) ||
              !jsonEqual(candidate.ledger.logicalTombstones, previous.ledger.logicalTombstones) ||
              candidate.ledger.deliveries.length !== previous.ledger.deliveries.length) {
            throw storeError('invalid_question_body_reclamation_candidate');
          }
          const previousDelivery = previous.ledger.deliveries.find((item) =>
            item.deliveryAttemptId === deliveryAttemptId);
          const nextDeliveriesByAttempt = new Map(candidate.ledger.deliveries.map((item) =>
            [item.deliveryAttemptId, item]));
          const nextDelivery = nextDeliveriesByAttempt.get(deliveryAttemptId);
          if (!previousDelivery || previousDelivery.recordType !== 'detail' || previousDelivery.kind !== 'question' ||
              !nextDelivery || nextDelivery.recordType !== 'reclaimed' || nextDelivery.kind !== 'question' ||
              previousDelivery.payloadDigest !== nextDelivery.payloadDigest ||
              previousDelivery.state !== nextDelivery.state || previousDelivery.terminalAt !== nextDelivery.terminalAt ||
              previousDelivery.cancelRequested !== nextDelivery.cancelRequested ||
              !jsonEqual(previousDelivery.acceptedCorrelation, nextDelivery.acceptedCorrelation) ||
              !jsonEqual(previousDelivery.appliedCorrelation, nextDelivery.appliedCorrelation) ||
              nextDelivery.reclamation.reason !== 'retired_question_period' ||
              !sameNativeIdentity(previousDelivery.source.identity, request.identity) ||
              previousDelivery.source.executionBinding.periodId !== request.periodId ||
              previousDelivery.target.kind !== 'execution' ||
              !sameNativeIdentity(previousDelivery.target.identity, request.identity) ||
              previousDelivery.target.periodId !== request.periodId ||
              !sameNativeIdentity(nextDelivery.sourceRef.identity, request.identity) ||
              nextDelivery.sourceRef.executionBinding.periodId !== request.periodId ||
              !sameNativeIdentity(nextDelivery.targetRef.identity, request.identity) ||
              nextDelivery.targetRef.periodId !== request.periodId ||
              previous.ledger.deliveries.some((item) => item.deliveryAttemptId !== deliveryAttemptId &&
                !jsonEqual(item, nextDeliveriesByAttempt.get(item.deliveryAttemptId)))) {
            throw storeError('invalid_question_body_reclamation_candidate');
          }
          assertReclamationCheckpointCapacity(candidate, null, true);
          assertAccess();
          try {
            const saved = await checkpointStore.save(candidate, assertAccess);
            currentCheckpoint = saved;
            return structuredClone(saved);
          } catch (error) {
            if (error.code === 'checkpoint_write_failed' || error.code === 'checkpoint_writer_blocked') {
              writerBlocked = true;
            }
            throw error;
          }
        },
      });
      try {
        return await QUESTION_RETIREMENT_SCOPE.run(retirementScopeToken, () => callback(access));
      } finally {
        active = false;
      }
    });
  }

  function close() {
    if (closePromise) return closePromise;
    accepting = false;
    if (reclamation) {
      closePromise = tail.then(async () => {
        payloads.clear();
        await checkpointStore.close();
      });
      return closePromise;
    }
    closePromise = tail.then(() => ready.catch(() => undefined)).then(async () => {
      payloads.clear();
      await checkpointStore.close();
    });
    return closePromise;
  }

  const reclamationWriter = reclamation ? Object.freeze({
    stop: () => { accepting = false; },
    drain: () => tail,
    prepareResume: prepareResumeReclamation,
  }) : undefined;

  const storeValue = {
    ready,
    createQuestionDelivery,
    createInstructionDelivery,
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
  };
  if (reclamation) {
    storeValue.reclamationWriter = reclamationWriter;
    storeValue.withQuestionRetirement = withQuestionRetirement;
    storeValue.withRetiredQuestionCheckpoint = withRetiredQuestionCheckpoint;
  }
  const store = Object.freeze(storeValue);
  STORE_INTERNALS.set(store, {
    createQuestionDelivery: createQuestionDeliveryForProvider,
    createInstructionDelivery: createInstructionDeliveryForProvider,
    createResultDelivery: createResultDeliveryForProvider,
    registerPrNotificationTarget: registerPrNotificationTargetForProvider,
    createPrNotification: createPrNotificationForProvider, scopedTransition, scopedSendStart,
    recordAcceptedForProvider, recordAppliedForProvider, recordAppliedInstruction: scopedRecordAppliedInstruction, markUnknownForProvider,
    scopedRehydratePayload, scopedGet, readNativeRecoverySnapshot: readNativeRecoverySnapshotNow });
  return store;
}

function readNativeRecoverySnapshot(store) {
  const internal = STORE_INTERNALS.get(store);
  if (!internal) return Promise.reject(storeError('invalid_recovery_store'));
  return internal.readNativeRecoverySnapshot();
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
    createInstructionDelivery: (input) => internal.createInstructionDelivery(input, provider),
    createResultDelivery: (input) => internal.createResultDelivery(input, provider),
    registerPrNotificationTarget: (input) => internal.registerPrNotificationTarget(input, provider),
    createPrNotification: (input) => internal.createPrNotification(input, provider),
    claim: (id) => internal.scopedTransition(id, 'claim', provider),
    cancel: (id) => internal.scopedTransition(id, 'cancel', provider),
    supersedeUnsentDelivery: (id) => internal.scopedTransition(id, 'supersede', provider),
    sendStart: (id, sink) => internal.scopedSendStart(id, sink, provider),
    recordAccepted: (id, correlation) => internal.recordAcceptedForProvider(id, correlation, provider),
    recordApplied: (id, correlation) => internal.recordAppliedForProvider(id, correlation, provider),
    recordAppliedInstructionGuarded: (id, correlation, beginCommit) =>
      internal.recordAppliedInstruction(id, correlation, beginCommit, provider),
    markUnknown: (id) => internal.markUnknownForProvider(id, provider),
    rehydratePayload: (id, payload) => internal.scopedRehydratePayload(id, payload, provider),
    captureRegistrations: store.captureRegistrations,
    get: (id) => internal.scopedGet(id, provider),
    snapshot: store.snapshot,
    flush: store.flush,
    close: store.close,
  });
}

module.exports = { createDurableDeliveryStore, createProviderDeliveryAdapter, readNativeRecoverySnapshot };
