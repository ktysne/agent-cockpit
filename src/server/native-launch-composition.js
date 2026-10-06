'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { createProviderRegistrationAdapter } = require('./provider-registration');
const { createProviderLaunchAdapter } = require('./launch-binding');
const { createProviderRuntimeAdapter } = require('./runtime-binding');

const PROVIDER_NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });
const MAX_PROFILES = 16;
const MAX_ATTEMPTS = 256;
const MAX_PENDING_CONTEXTS = 16;
const MAX_ENDED_CONTEXT_IDS = 8;
const MAX_INPUT_TEXT_BYTES = 1024 * 1024;
const IDENTIFIER_MAX = 512;
const PROFILE_FIELDS = Object.freeze(['provider', 'executablePath', 'homePath', 'homeScopeId', 'cwd']);
const IDENTITY_FIELDS = Object.freeze(['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']);
const CLAIM_FIELDS = Object.freeze([
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding', 'identity', 'executionBinding',
]);

function compositionError(code) {
  const error = new Error('native launch composition rejected the operation');
  error.code = code;
  return error;
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, fields) {
  return isRecord(value) && Reflect.ownKeys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= IDENTIFIER_MAX &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function cloneActor(actor) {
  return actor ? { kind: actor.kind, id: actor.id } : null;
}

function cloneBinding(binding) {
  return binding ? { periodId: binding.periodId, actor: cloneActor(binding.actor) } : null;
}

function cloneIdentity(identity) {
  return identity ? { ...identity } : null;
}

function nativeMainActor(identity, launchRef) {
  return {
    kind: 'agent',
    id: `owned-main-${digest([
      identity.provider,
      identity.nativeIdKind,
      identity.hostId,
      identity.homeScopeId,
      identity.nativeId,
      launchRef,
    ]).slice(0, 40)}`,
  };
}

function identityEquals(left, right) {
  return Boolean(left && right) && IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function bindingEquals(left, right) {
  return Boolean(left && right) && left.periodId === right.periodId &&
    left.actor.kind === right.actor.kind && left.actor.id === right.actor.id;
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function digest(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function isAbsolutePath(value) {
  return typeof value === 'string' && (path.isAbsolute(value) || path.win32.isAbsolute(value));
}

function normalizeProfiles(value) {
  if (!isRecord(value)) throw new TypeError('profiles must be a fixed profile map');
  const entries = Object.entries(value);
  if (!entries.length || entries.length > MAX_PROFILES) throw new TypeError('profiles are outside the supported bound');
  const profiles = new Map();
  for (const [profileId, config] of entries) {
    if (!isIdentifier(profileId) || !hasExactKeys(config, PROFILE_FIELDS) ||
        !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, config.provider) ||
        !isAbsolutePath(config.executablePath) || !isAbsolutePath(config.homePath) ||
        !isAbsolutePath(config.cwd) || !isIdentifier(config.homeScopeId)) {
      throw new TypeError('profile configuration is invalid');
    }
    profiles.set(profileId, Object.freeze({
      profileId,
      provider: config.provider,
      nativeIdKind: PROVIDER_NATIVE_ID_KINDS[config.provider],
      executablePath: path.normalize(config.executablePath),
      homePath: path.normalize(config.homePath),
      homeScopeId: config.homeScopeId,
      cwd: path.normalize(config.cwd),
    }));
  }
  return profiles;
}

function requireKernelSurface(kernel, registryMethods, authorityMethods, name) {
  if (!kernel || !kernel.registry || !kernel.authority ||
      registryMethods.some((method) => typeof kernel.registry[method] !== 'function') ||
      authorityMethods.some((method) => typeof kernel.authority[method] !== 'function')) {
    throw new TypeError(`${name} does not expose the required kernel contract`);
  }
}

function defaultRunnerFactory(options) {
  return require('./owned-native-runner').createOwnedNativeRunner(options);
}

function createNativeLaunchComposition(options = {}) {
  const {
    registrationKernel,
    launchKernel,
    runtimeKernel,
    runnerFactory = defaultRunnerFactory,
    getAuthentication = () => undefined,
    onAuthenticationRequired,
    hostId,
    profiles: profileInput,
  } = options;
  requireKernelSurface(registrationKernel, ['captureAuthorityRevision', 'checkAuthorityRevision', 'snapshot', 'authorizeWriter'], ['register', 'bindWriter'], 'registrationKernel');
  requireKernelSurface(launchKernel, ['captureAuthorityRevision', 'checkAuthorityRevision', 'get', 'snapshot'], ['registerLaunch', 'bindExecution'], 'launchKernel');
  requireKernelSurface(runtimeKernel, ['get', 'checkCurrentProof', 'checkCurrentConnection', 'checkProofCapability', 'snapshot'], [
    'adoptExecution', 'openConnection', 'disconnect', 'attestActor', 'endActor', 'endContext', 'reconcileExecution', 'handoff',
  ], 'runtimeKernel');
  if (!isIdentifier(hostId) || typeof runnerFactory !== 'function' || typeof getAuthentication !== 'function' ||
      (onAuthenticationRequired !== undefined && typeof onAuthenticationRequired !== 'function')) {
    throw new TypeError('native launch composition requires a host, runner factory, and authentication callback');
  }
  const profiles = normalizeProfiles(profileInput);
  const registrationAdapters = Object.fromEntries(Object.keys(PROVIDER_NATIVE_ID_KINDS).map((provider) => [
    provider,
    createProviderRegistrationAdapter(provider, registrationKernel.registry, registrationKernel.authority),
  ]));
  const launchAdapters = Object.fromEntries(Object.keys(PROVIDER_NATIVE_ID_KINDS).map((provider) => [
    provider,
    createProviderLaunchAdapter(provider, launchKernel.registry, launchKernel.authority),
  ]));
  const runtimeAdapters = Object.fromEntries(Object.keys(PROVIDER_NATIVE_ID_KINDS).map((provider) => [
    provider,
    createProviderRuntimeAdapter(provider, runtimeKernel.registry, runtimeKernel.authority),
  ]));

  const admissionRecords = new WeakMap();
  const runReceiptRecords = new WeakMap();
  const proofResolutionInProgress = new Set();
  const proofResolutionReentered = new Set();
  const sourceObservationInProgress = new Set();
  const sourceObservationReentered = new Set();
  const admissionByAttempt = new Map();
  const launchRecords = new Map();
  const launchIds = new Map();
  const nativeIdentityLaunches = new Map();
  const handoffResults = new Map();
  const brokerId = crypto.randomUUID();

  function stageEvidence(record, stage, subject = null) {
    const evidence = {
      evidenceId: `native-${digest([
        brokerId, record.launchRef, stage, record.connectionGeneration || 0,
        record.ownerGeneration || 0, subject,
      ]).slice(0, 56)}`,
      source: 'owned-native-runner',
      method: record.profile.provider === 'codex' ? 'app-server-stdio' : 'stream-json-owned-process',
      adapterVersion: 'native-launch-composition-v1',
      runtimeVersion: 'native-runner-v1',
    };
    if (record.launchRef) evidence.registrationRef = record.launchRef;
    return evidence;
  }

  function immutableClaims(record) {
    const claim = record.launchRecord;
    if (!claim || claim.state !== 'bound' || !claim.identity || !claim.executionBinding) return null;
    const result = {};
    for (const field of CLAIM_FIELDS) result[field] = field === 'identity'
      ? cloneIdentity(claim.identity)
      : field === 'originBinding' || field === 'executionBinding'
        ? cloneBinding(claim[field])
        : claim[field];
    return result;
  }

  function registeredExecution(executionId) {
    let snapshot;
    try { snapshot = registrationKernel.registry.snapshot(); } catch { return null; }
    if (!isRecord(snapshot) || !Array.isArray(snapshot.conversations) || !Array.isArray(snapshot.executions)) return null;
    const executions = snapshot.executions.filter((item) => item && item.executionId === executionId);
    if (executions.length !== 1 || executions[0].state !== 'active') return null;
    const execution = executions[0];
    const conversations = snapshot.conversations.filter((item) => item && item.conversationId === execution.conversationId);
    if (conversations.length !== 1) return null;
    return { execution, conversation: conversations[0] };
  }

  function periodMatches(record) {
    const registered = record.registration && registeredExecution(record.registration.executionId);
    return Boolean(registered && registered.execution.conversationId === record.registration.conversationId &&
      registered.execution.sessionId === record.registration.sessionId &&
      identityEquals(registered.conversation.identity, record.identity));
  }

  function nativeIdentityKey(identity) {
    return JSON.stringify(IDENTITY_FIELDS.map((field) => identity[field]));
  }

  function runtimeRecord(record) {
    try { return runtimeKernel.registry.get(record.launchRef); } catch { return null; }
  }

  function runtimeProofSummaryMatches(record, launch) {
    const proof = launch && launch.currentProof;
    const expectedOwner = record.currentOwnerRecord?.executionBinding ||
      (record.claims.origin === 'standalone' ? record.executionBinding : null);
    return Boolean(proof && record.identity && record.executionBinding &&
      identityEquals(proof.identity, record.identity) &&
      bindingEquals(proof.executionBinding, record.executionBinding) &&
      expectedOwner && bindingEquals(proof.currentOwner, expectedOwner) &&
      proof.executionConnectionGeneration === record.connectionGeneration &&
      proof.executionContextId === record.currentContextId &&
      proof.ownerGeneration === launch.ownerGeneration &&
      record.ownerGeneration === launch.ownerGeneration);
  }

  function captureLiveOwnerChain(record, visited = new Set(), chain = []) {
    if (!record || visited.size >= MAX_ATTEMPTS || visited.has(record) || !record.runReceipt ||
        !record.proofHandle || record.status !== 'observed' || record.epoch !== record.activeEpoch ||
        !record.connectionHandle || !record.executionActorHandle || !periodMatches(record) ||
        !sourceCanObserve(record, record.epoch)) return null;
    visited.add(record);
    const launch = runtimeRecord(record);
    if (!runtimeProofSummaryMatches(record, launch)) return null;
    let checked;
    try { checked = runtimeKernel.registry.checkCurrentProof(record.launchRef, record.proofHandle); }
    catch { checked = null; }
    if (!checked || checked.ok !== true) return null;

    const owner = ownerRecordFor(record);
    if (!owner) return null;
    const node = {
      record,
      processState: record.processState,
      identity: record.identity,
      runtimeScope: record.runtimeScope,
      claims: record.claims,
      proofHandle: record.proofHandle,
      epoch: record.epoch,
      activeEpoch: record.activeEpoch,
      status: record.status,
      connectionHandle: record.connectionHandle,
      connectionGeneration: record.connectionGeneration,
      executionActorHandle: record.executionActorHandle,
      registration: record.registration,
      executionBinding: record.executionBinding,
      currentContextId: record.currentContextId,
      ownerGeneration: record.ownerGeneration,
      currentOwnerRecord: record.currentOwnerRecord,
      runtimeState: launch.state,
      runtimeOwnerGeneration: launch.ownerGeneration,
      runtimeCurrentOwner: launch.currentOwner,
    };
    chain.push(node);
    if (owner === record) {
      if (record.claims.origin !== 'standalone') return null;
      return chain;
    }
    if (!captureLiveOwnerChain(owner, visited, chain)) return null;
    return chain;
  }

  function sameLiveOwnerChain(left, right) {
    const fields = [
      'record', 'proofHandle', 'epoch', 'activeEpoch', 'status', 'connectionHandle',
      'connectionGeneration', 'executionActorHandle', 'registration', 'executionBinding',
      'currentContextId', 'ownerGeneration', 'currentOwnerRecord', 'runtimeState',
      'runtimeOwnerGeneration',
    ];
    return left.length === right.length && left.every((node, index) => {
      const current = right[index];
      return fields.every((field) => node[field] === current[field]) &&
        bindingEquals(node.runtimeCurrentOwner, current.runtimeCurrentOwner);
    });
  }

  function receiptIsLive(receiptRecord) {
    return Boolean(receiptRecord && resolveProof(receiptRecord.launchRef));
  }

  function launchCanContinue(record, epoch) {
    if (!record || record.activeEpoch !== epoch || record.epoch !== epoch ||
        !['starting', 'running'].includes(record.processState)) return false;
    if (record.registration && !periodMatches(record)) return false;
    const owner = ownerRecordFor(record);
    return owner ? owner === record || receiptIsLive(owner) : record.claims.origin === 'standalone';
  }

  function sourceCanObserve(record, epoch) {
    if (!record || sourceObservationInProgress.has(record)) {
      if (record) sourceObservationReentered.add(record);
      return false;
    }
    sourceObservationInProgress.add(record);
    try {
      if (record.activeEpoch !== epoch || record.epoch !== epoch ||
          !['starting', 'running'].includes(record.processState)) return false;
      if (!record.registration) {
        const allowed = launchCanContinue(record, epoch);
        return allowed && !sourceObservationReentered.has(record) && record.epoch === epoch;
      }
      if (!periodMatches(record) || !record.identity || !record.executionBinding ||
          !record.connectionHandle || record.runtimeDisconnected || !record.runtimeScope) return false;
      const handle = record.connectionHandle;
      const generation = record.connectionGeneration;
      const scope = record.runtimeScope;
      let snapshot;
      try { snapshot = runtimeKernel.registry.snapshot(); } catch { return false; }
      if (!snapshot || typeof snapshot.then === 'function' || !Array.isArray(snapshot.connections)) return false;
      const matching = snapshot.connections.filter((connection) => connection.state === 'active' &&
        connection.generation === generation &&
        ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'connectionSlotId'].every((field) =>
          connection.scope?.[field] === scope[field]));
      const periodCurrent = periodMatches(record);
      let connectionCurrent;
      try { connectionCurrent = runtimeKernel.registry.checkCurrentConnection(handle); } catch { return false; }
      return connectionCurrent === true && matching.length === 1 && periodCurrent && !sourceObservationReentered.has(record) &&
        record.activeEpoch === epoch && record.epoch === epoch && record.processState === 'running' &&
        !record.runtimeDisconnected && record.connectionHandle === handle &&
        record.connectionGeneration === generation && record.runtimeScope === scope;
    } finally {
      sourceObservationInProgress.delete(record);
      sourceObservationReentered.delete(record);
    }
  }

  function guardContext(record, context) {
    if (context === undefined) return true;
    const fields = [
      'launchRef', 'connectionHandle', 'connectionGeneration', 'scope', 'identity',
      'periodId', 'actor', 'contextId', 'isCurrent',
    ];
    if (!hasExactKeys(context, fields) || typeof context.isCurrent !== 'function' ||
        context.launchRef !== record.launchRef || context.connectionHandle !== record.connectionHandle ||
        context.connectionGeneration !== record.connectionGeneration || context.periodId !== record.executionBinding?.periodId ||
        context.contextId !== record.currentContextId || !identityEquals(context.identity, record.identity) ||
        !bindingEquals({ periodId: context.periodId, actor: context.actor }, record.executionBinding)) return false;
    const scope = context.scope;
    if (!hasExactKeys(scope, ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'connectionSlotId']) ||
        scope.provider !== record.runtimeScope.provider || scope.nativeIdKind !== record.runtimeScope.nativeIdKind ||
        scope.hostId !== record.runtimeScope.hostId || scope.homeScopeId !== record.runtimeScope.homeScopeId ||
        scope.connectionSlotId !== record.runtimeScope.connectionSlotId) return false;
    try {
      const result = context.isCurrent();
      return result === true && (!result || typeof result.then !== 'function');
    } catch {
      return false;
    }
  }

  function internalCurrent(record, context) {
    return record && record.status === 'observed' && record.activeEpoch === record.epoch &&
      record.connectionHandle && record.proofHandle && record.executionActorHandle &&
      periodMatches(record) && guardContext(record, context);
  }

  function readyForReconciliation(record, context) {
    const canReconcile = record && (record.status === 'observed' ||
      ['handoff_requires_reconciliation', 'current_proof_unavailable'].includes(record.reason));
    return canReconcile &&
      record.activeEpoch === record.epoch && record.connectionHandle && record.executionActorHandle &&
      record.currentContextId && periodMatches(record) && guardContext(record, context);
  }

  function finalChainCurrent(chain) {
    const fields = ['proofHandle', 'epoch', 'activeEpoch', 'status', 'processState', 'identity',
      'runtimeScope', 'claims', 'connectionHandle', 'connectionGeneration', 'executionActorHandle',
      'registration', 'executionBinding', 'currentContextId', 'ownerGeneration', 'currentOwnerRecord'];
    return chain.every((node) => fields.every((field) => node.record[field] === node[field]) &&
      !node.record.runtimeDisconnected && !sourceObservationReentered.has(node.record) &&
      !proofResolutionReentered.has(node.record));
  }

  function resolveProof(launchRef, context) {
    const record = launchRecords.get(launchRef);
    if (!record) return null;
    if (proofResolutionInProgress.has(record)) {
      proofResolutionReentered.add(record);
      return null;
    }
    proofResolutionInProgress.add(record);
    try {
      const registrationRevision = registrationKernel.registry.captureAuthorityRevision();
      const launchRevision = launchKernel.registry.captureAuthorityRevision();
      if (!internalCurrent(record)) return null;
      const before = captureLiveOwnerChain(record);
      if (!before || !guardContext(record, context) || proofResolutionReentered.has(record)) return null;
      const after = captureLiveOwnerChain(record);
      if (!after || !sameLiveOwnerChain(before, after) || proofResolutionReentered.has(record)) return null;
      if (registrationKernel.registry.checkAuthorityRevision(registrationRevision) !== true ||
          launchKernel.registry.checkAuthorityRevision(launchRevision) !== true) return null;
      for (const node of after) {
        if (runtimeKernel.registry.checkProofCapability(node.record.launchRef, node.proofHandle) !== true) return null;
      }
      if (!finalChainCurrent(after) || proofResolutionReentered.has(record)) return null;
      return before[0].proofHandle;
    } catch {
      return null;
    } finally {
      proofResolutionInProgress.delete(record);
      proofResolutionReentered.delete(record);
    }
  }

  function checkCurrentProof(launchRef, proofHandle) {
    const record = launchRecords.get(launchRef);
    if (!record || !proofHandle || record.proofHandle !== proofHandle) {
      return { ok: false, reason: 'proof_mismatch' };
    }
    const current = resolveProof(launchRef);
    return current === proofHandle && record.proofHandle === proofHandle
      ? { ok: true, reason: 'accepted' }
      : { ok: false, reason: 'proof_unavailable' };
  }

  function contextCanContinue(record, epoch) {
    if (!record || record.activeEpoch !== epoch || record.epoch !== epoch ||
        record.processState !== 'running' || !record.currentContextId || !record.proofHandle) return false;
    const contextId = record.currentContextId;
    const proofHandle = record.proofHandle;
    let checked;
    try { checked = checkCurrentProof(record.launchRef, proofHandle); } catch { return false; }
    return checked?.ok === true && record.activeEpoch === epoch && record.epoch === epoch &&
      record.processState === 'running' && record.currentContextId === contextId &&
      record.proofHandle === proofHandle;
  }

  function createRunReceipt(record) {
    if (record.runReceipt) return record.runReceipt;
    const receipt = Object.freeze({});
    record.runReceipt = receipt;
    runReceiptRecords.set(receipt, record);
    return receipt;
  }

  function setUnknown(record, reason) {
    record.status = 'unknown';
    record.reason = reason;
  }

  function invalidateOwnedProofs(source) {
    for (const record of launchRecords.values()) {
      const visited = new Set();
      let owner = record;
      while (owner && !visited.has(owner) && visited.size < MAX_ATTEMPTS) {
        if (owner === source) {
          record.proofHandle = null;
          record.writerEnvelope = null;
          record.writerContextId = null;
          if (record !== source) setUnknown(record, 'current_proof_unavailable');
          break;
        }
        visited.add(owner);
        owner = ownerRecordFor(owner);
      }
    }
  }

  function disconnectRuntime(record) {
    invalidateOwnedProofs(record);
    if (record.connectionHandle && !record.runtimeDisconnected) {
      record.runtimeDisconnected = true;
      try { runtimeAdapters[record.profile.provider].disconnect(record.connectionHandle); } catch {}
    }
    record.proofHandle = null;
    record.executionActorHandle = null;
    record.writerEnvelope = null;
  }

  function markDisconnected(record, epoch, reason) {
    if (!record || record.activeEpoch !== epoch || record.epoch !== epoch) return;
    record.epoch += 1;
    disconnectRuntime(record);
    record.status = 'unknown';
    record.reason = isIdentifier(reason) ? reason : 'owned_process_disconnected';
    record.processState = 'disconnected';
  }

  function quarantine(record, epoch, reason) {
    if (!record || record.activeEpoch !== epoch || record.epoch !== epoch) return;
    record.epoch += 1;
    record.activeEpoch = record.epoch;
    disconnectRuntime(record);
    record.pendingContexts = [];
    record.status = 'unknown';
    record.reason = isIdentifier(reason) ? reason : 'native_event_unrecognized';
    record.processState = 'quarantined';
    if (record.runner) {
      try { Promise.resolve(record.runner.stop()).catch(() => {}); } catch {}
    }
  }

  function expectedIdentity(record, identity) {
    return hasExactKeys(identity, IDENTITY_FIELDS) && identity.provider === record.profile.provider &&
      identity.nativeIdKind === record.profile.nativeIdKind && identity.hostId === hostId &&
      identity.homeScopeId === record.profile.homeScopeId && isIdentifier(identity.nativeId);
  }

  function bindNativeIdentity(record, identity, epoch) {
    if (record.activeEpoch !== epoch || record.epoch !== epoch) return false;
    if (!sourceCanObserve(record, epoch)) return false;
    if (!expectedIdentity(record, identity)) {
      quarantine(record, epoch, 'native_identity_scope_mismatch');
      return false;
    }
    if (record.identity) {
      if (!identityEquals(record.identity, identity)) quarantine(record, epoch, 'native_identity_conflict');
      return identityEquals(record.identity, identity);
    }
    if (record.status === 'stopped' || record.processState === 'disconnected') return false;
    const identityKey = nativeIdentityKey(identity);
    const existingLaunchRef = nativeIdentityLaunches.get(identityKey);
    if (existingLaunchRef && existingLaunchRef !== record.launchRef) {
      quarantine(record, epoch, 'native_identity_already_owned');
      return false;
    }

    const identityCopy = cloneIdentity(identity);
    const startId = `native-start-${digest([brokerId, record.launchRef]).slice(0, 48)}`;
    const nativeIdentity = {
      nativeIdKind: identityCopy.nativeIdKind,
      hostId: identityCopy.hostId,
      homeScopeId: identityCopy.homeScopeId,
      nativeId: identityCopy.nativeId,
    };
    const registration = registrationAdapters[record.profile.provider].register(nativeIdentity,
      stageEvidence(record, 'registration', identity.nativeId), {
      startId,
      resume: false,
      ...(record.profile.provider === 'claude' ? { projectionId: identity.nativeId } : {}),
    });
    const registered = registeredExecution(registration.executionId);
    if (!registered || registered.execution.conversationId !== registration.conversationId ||
        registered.execution.sessionId !== registration.sessionId ||
        !identityEquals(registered.conversation.identity, identityCopy) ||
        record.activeEpoch !== epoch || !periodMatches({ ...record, registration, identity: identityCopy })) {
      setUnknown(record, 'registered_period_unverified');
      return false;
    }
    nativeIdentityLaunches.set(identityKey, record.launchRef);

    const executionBinding = {
      periodId: registration.executionId,
      actor: nativeMainActor(identity, record.launchRef),
    };
    const bound = launchAdapters[record.profile.provider].bindExecution(record.launchRef, {
      identity: identityCopy,
      executionBinding,
      evidence: {
        ...stageEvidence(record, 'execution-binding', identity.nativeId),
        registrationRef: record.launchRef,
      },
    });
    if (record.activeEpoch !== epoch || !periodMatches({ ...record, registration, identity: identityCopy })) {
      setUnknown(record, 'registration_changed');
      return false;
    }
    record.identity = identityCopy;
    record.registration = registration;
    record.executionBinding = cloneBinding(executionBinding);
    record.launchRecord = bound;
    const claims = immutableClaims(record);
    if (!claims) {
      setUnknown(record, 'launch_binding_unverified');
      return false;
    }
    runtimeAdapters[record.profile.provider].adoptExecution(record.launchRef, claims);
    if (record.activeEpoch !== epoch || !periodMatches(record)) {
      setUnknown(record, 'registration_changed');
      return false;
    }
    record.runtimeScope = {
      provider: record.profile.provider,
      nativeIdKind: record.profile.nativeIdKind,
      hostId,
      homeScopeId: record.profile.homeScopeId,
      connectionSlotId: `owned-${digest([brokerId, record.launchRef]).slice(0, 48)}`,
    };
    const opened = runtimeAdapters[record.profile.provider].openConnection(
      record.runtimeScope,
      `owned-connection-${digest([brokerId, record.launchRef]).slice(0, 48)}`,
      stageEvidence(record, 'owned-process-connection', identity.nativeId),
    );
    if (record.activeEpoch !== epoch || !periodMatches(record)) {
      try { runtimeAdapters[record.profile.provider].disconnect(opened.connectionHandle); } catch {}
      setUnknown(record, 'registration_changed');
      return false;
    }
    record.connectionHandle = opened.connectionHandle;
    record.connectionGeneration = opened.connectionGeneration;
    record.status = 'registered';
    record.reason = null;
    record.processState = 'running';
    const pending = record.pendingContexts;
    record.pendingContexts = [];
    for (const item of pending) {
      if (identityEquals(item.identity, record.identity)) bindNativeContext(record, item.context, epoch);
    }
    return true;
  }

  function ownerRecordFor(record) {
    return record.currentOwnerRecord || (record.claims.origin === 'standalone' ? record : null);
  }

  function ownerChainReaches(record, target, visited = new Set()) {
    if (!record || visited.size >= MAX_ATTEMPTS || visited.has(record)) return true;
    if (record === target) return true;
    visited.add(record);
    const owner = ownerRecordFor(record);
    if (!owner) return true;
    if (owner === record) return record.claims.origin !== 'standalone';
    return ownerChainReaches(owner, target, visited);
  }

  function reconcileExecution(record, executionActorHandle, ownerActorHandle, expectedOwnerGeneration, ownerRecord) {
    const input = { executionActorHandle, ownerActorHandle, expectedOwnerGeneration };
    if (ownerRecord && ownerRecord.profile.provider === record.profile.provider) {
      return runtimeAdapters[record.profile.provider].reconcileExecution(record.launchRef, input);
    }
    return runtimeKernel.authority.reconcileExecution(record.launchRef, input);
  }

  function nativeContextFor(record) {
    return {
      provider: record.identity.provider,
      nativeIdKind: record.identity.nativeIdKind,
      hostId: record.identity.hostId,
      homeScopeId: record.identity.homeScopeId,
      nativeId: record.identity.nativeId,
      contextId: record.currentContextId,
    };
  }

  function bindNativeContext(record, context, epoch) {
    if (record.activeEpoch !== epoch || record.epoch !== epoch || !record.identity || !record.connectionHandle) return false;
    if (!periodMatches(record)) {
      quarantine(record, epoch, 'registered_period_unverified');
      return false;
    }
    const expectedKind = record.profile.provider === 'codex' ? 'turn' : 'assistant_message';
    if (!hasExactKeys(context, ['kind', 'nativeContextId', 'parentToolUseId']) ||
        context.kind !== expectedKind || !isIdentifier(context.nativeContextId) || context.parentToolUseId !== null) {
      quarantine(record, epoch, 'native_context_unavailable');
      return false;
    }
    if (record.uncertainContextIds.has(context.nativeContextId)) {
      if (!record.currentContextId) setUnknown(record, 'native_observation_gap');
      return false;
    }
    if (record.terminalContextIds.has(context.nativeContextId)) {
      if (!record.currentContextId) setUnknown(record, 'native_context_ended');
      return false;
    }
    if (record.currentContextId) {
      if (record.currentContextId === context.nativeContextId) return resolveProof(record.launchRef) !== null;
      quarantine(record, epoch, 'native_context_conflict');
      return false;
    }

    const currentOwner = ownerRecordFor(record);
    const claims = immutableClaims(record);
    if (!claims || !periodMatches(record) || record.activeEpoch !== epoch) {
      setUnknown(record, 'binding_unavailable');
      return false;
    }
    const executionActor = runtimeAdapters[record.profile.provider].attestActor(record.connectionHandle, {
      identity: record.identity,
      periodId: record.executionBinding.periodId,
      actor: record.executionBinding.actor,
      contextId: context.nativeContextId,
      launchRef: record.launchRef,
      immutableExecutionClaims: claims,
    }, stageEvidence(record, 'execution-actor', context.nativeContextId));
    if (record.activeEpoch !== epoch || !periodMatches(record)) {
      setUnknown(record, 'registration_changed');
      return false;
    }
    record.currentContextKind = context.kind;
    record.currentContextId = context.nativeContextId;
    record.executionActorHandle = executionActor.actorHandle;
    record.proofHandle = null;
    record.writerEnvelope = null;
    record.writerContextId = null;
    const ownerActorHandle = currentOwner === record ? executionActor.actorHandle : currentOwner?.executionActorHandle;
    if (!ownerActorHandle || (currentOwner !== record && !receiptIsLive(currentOwner))) {
      setUnknown(record, 'current_proof_unavailable');
      return false;
    }
    const runtime = runtimeRecord(record);
    if (!runtime || runtime.state !== 'bound' || !bindingEquals(runtime.currentOwner,
      currentOwner.executionBinding)) {
      setUnknown(record, 'owner_binding_mismatch');
      return false;
    }
    const reconciled = reconcileExecution(record, executionActor.actorHandle, ownerActorHandle, runtime.ownerGeneration, currentOwner);
    if (record.activeEpoch !== epoch || !periodMatches(record)) {
      setUnknown(record, 'registration_changed');
      return false;
    }
    record.currentContextKind = context.kind;
    record.currentContextId = context.nativeContextId;
    record.executionActorHandle = executionActor.actorHandle;
    record.proofHandle = reconciled.proofHandle;
    record.ownerGeneration = reconciled.currentProof.ownerGeneration;
    record.writerEnvelope = null;
    record.status = 'observed';
    record.reason = null;
    record.processState = 'running';
    if (record.claims.origin === 'standalone') record.currentOwnerRecord = record;
    createRunReceipt(record);
    return true;
  }

  function endNativeContext(record, event, epoch) {
    if (record.activeEpoch !== epoch || record.epoch !== epoch || record.processState !== 'running') return false;
    if (!isRecord(event) || event.provider !== record.profile.provider ||
        !hasExactKeys(event, ['type', 'provider', 'identity', 'context']) || !expectedIdentity(record, event.identity)) {
      quarantine(record, epoch, 'native_context_end_unrecognized');
      return false;
    }
    const context = event.context;
    const expectedKind = record.profile.provider === 'codex' ? 'turn' : 'assistant_message';
    if (!hasExactKeys(context, ['kind', 'nativeContextId']) || context.kind !== expectedKind ||
        !isIdentifier(context.nativeContextId)) {
      quarantine(record, epoch, 'native_context_end_unrecognized');
      return false;
    }
    if (record.identity && !identityEquals(record.identity, event.identity)) {
      quarantine(record, epoch, 'native_identity_mismatch');
      return false;
    }
    if (record.terminalContextIds.has(context.nativeContextId)) return true;
    if (record.terminalContextIds.size >= MAX_ENDED_CONTEXT_IDS) {
      quarantine(record, epoch, 'native_context_end_limit');
      return false;
    }
    record.terminalContextIds.add(context.nativeContextId);
    if (!record.identity || !record.currentContextId) {
      setUnknown(record, 'native_context_ended');
      return true;
    }
    if (record.currentContextId !== context.nativeContextId) return true;
    if (record.executionActorHandle) {
      try {
        if (runtimeAdapters[record.profile.provider].endContext(record.executionActorHandle) !== true) {
          throw compositionError('native_context_end_unverified');
        }
      } catch {
        quarantine(record, epoch, 'native_context_end_unverified');
        return false;
      }
    }
    record.executionActorHandle = null;
    record.proofHandle = null;
    record.writerEnvelope = null;
    invalidateOwnedProofs(record);
    record.currentContextId = null;
    record.currentContextKind = null;
    record.writerContextId = null;
    setUnknown(record, 'native_context_ended');
    return true;
  }

  function fenceNativeObservationGap(record, event) {
    const affectsContext = event?.type === 'context' || event?.type === 'context_ended';
    const changesIdentity = event?.type === 'identity' && !identityEquals(record.identity, event.identity);
    if (!affectsContext && !changesIdentity) return;
    if (record.currentContextId) {
      if (!record.uncertainContextIds.has(record.currentContextId) &&
          record.uncertainContextIds.size >= MAX_ENDED_CONTEXT_IDS) {
        quarantine(record, record.epoch, 'native_observation_gap_limit');
        return;
      }
      record.uncertainContextIds.add(record.currentContextId);
    }
    invalidateOwnedProofs(record);
    record.currentContextId = null;
    record.currentContextKind = null;
    record.executionActorHandle = null;
    record.pendingContexts = [];
    setUnknown(record, 'native_observation_gap');
  }

  function processNativeEvent(record, event, epoch) {
    if (record.activeEpoch !== epoch || record.epoch !== epoch || record.processState !== 'running') return;
    if (!sourceCanObserve(record, epoch)) {
      fenceNativeObservationGap(record, event);
      return;
    }
    if (!isRecord(event) || event.provider !== record.profile.provider) {
      quarantine(record, epoch, 'native_event_unrecognized');
      return;
    }
    if (event.type === 'identity' && hasExactKeys(event, ['type', 'provider', 'identity'])) {
      bindNativeIdentity(record, event.identity, epoch);
      return;
    }
    if (event.type === 'context' && hasExactKeys(event, ['type', 'provider', 'identity', 'context'])) {
      if (!expectedIdentity(record, event.identity)) {
        quarantine(record, epoch, 'native_identity_scope_mismatch');
        return;
      }
      if (!record.identity) {
        if (record.pendingContexts.length >= MAX_PENDING_CONTEXTS) {
          quarantine(record, epoch, 'native_context_buffer_full');
          return;
        }
        record.pendingContexts.push({ identity: cloneIdentity(event.identity), context: { ...event.context } });
        return;
      }
      if (!identityEquals(record.identity, event.identity)) {
        quarantine(record, epoch, 'native_identity_mismatch');
        return;
      }
      bindNativeContext(record, event.context, epoch);
      return;
    }
    if (event.type === 'context_ended') {
      endNativeContext(record, event, epoch);
      return;
    }
    quarantine(record, epoch, 'native_event_unrecognized');
  }

  function snapshotRecord(record) {
    if (record.runner && ['stopping', 'stop_unconfirmed'].includes(record.processState)) {
      let runnerSnapshot;
      try { runnerSnapshot = record.runner.snapshot(); } catch { runnerSnapshot = null; }
      if (isRecord(runnerSnapshot) &&
          (runnerSnapshot.childExited === true || runnerSnapshot.childClosed === true)) {
        record.processState = 'stopped';
        if (record.reason === 'owned_process_stop_unconfirmed') record.reason = 'owned_process_stopped';
      }
    }
    const launch = runtimeRecord(record);
    const proofCurrent = resolveProof(record.launchRef) !== null;
    return deepFreeze({
      launchId: record.claims.launchId,
      runId: record.claims.runId,
      attemptId: record.claims.attemptId,
      provider: record.profile.provider,
      status: proofCurrent ? record.status : record.status === 'observed' ? 'unknown' : record.status,
      reason: proofCurrent ? record.reason : record.status === 'observed' ? 'current_proof_unavailable' : record.reason,
      conversationId: record.registration?.conversationId || null,
      executionId: record.registration?.executionId || null,
      sessionId: record.registration?.sessionId || null,
      nativeId: record.identity?.nativeId || null,
      contextKind: record.currentContextKind || null,
      ownerGeneration: launch?.ownerGeneration ?? null,
      processState: record.processState,
    });
  }

  function apiResult(record) {
    const proof = resolveProof(record.launchRef);
    return Object.freeze({
      launchRef: record.launchRef,
      accepted: Boolean(proof),
      status: proof ? 'observed' : record.status,
      reason: proof ? null : record.reason,
      runReceipt: proof ? createRunReceipt(record) : null,
      observation: snapshotRecord(record),
    });
  }

  function admitLaunch(input) {
    const baseFields = ['launchId', 'runId', 'attemptId', 'profileId', 'origin', 'purpose'];
    const fields = input && Object.hasOwn(input, 'originReceipt') ? [...baseFields, 'originReceipt'] : baseFields;
    if (!hasExactKeys(input, fields) || !baseFields.every((field) => isIdentifier(input[field]))) {
      throw compositionError('invalid_admission');
    }
    const profile = profiles.get(input.profileId);
    if (!profile) throw compositionError('profile_not_allowed');
    const validOrigin = (input.origin === 'standalone' && ['agent', 'pr-creator'].includes(input.purpose)) ||
      (input.origin === 'delegated' && input.purpose === 'agent') ||
      (input.origin === 'review' && input.purpose === 'cross-review');
    if (!validOrigin || (input.origin === 'standalone' && Object.hasOwn(input, 'originReceipt')) ||
        (input.origin !== 'standalone' && !Object.hasOwn(input, 'originReceipt'))) {
      throw compositionError('invalid_origin');
    }
    const originRecord = input.origin === 'standalone' ? null : runReceiptRecords.get(input.originReceipt);
    if (input.origin !== 'standalone' && !originRecord) throw compositionError('origin_receipt_unavailable');
    const attemptKey = JSON.stringify([input.launchId, input.runId, input.attemptId]);
    const originBinding = originRecord
      ? { periodId: originRecord.executionBinding.periodId, actor: cloneActor(originRecord.executionBinding.actor) }
      : null;
    const claims = {
      launchId: input.launchId,
      runId: input.runId,
      attemptId: input.attemptId,
      profileId: input.profileId,
      provider: profile.provider,
      nativeIdKind: profile.nativeIdKind,
      hostId,
      homeScopeId: profile.homeScopeId,
      executablePath: profile.executablePath,
      homePath: profile.homePath,
      origin: input.origin,
      purpose: input.purpose,
      originBinding,
      originIdentity: originRecord ? cloneIdentity(originRecord.identity) : null,
      originConversationId: originRecord?.registration?.conversationId || null,
      originExecutionId: originRecord?.registration?.executionId || null,
      originSessionId: originRecord?.registration?.sessionId || null,
    };
    const fingerprint = JSON.stringify(claims);
    const existing = admissionByAttempt.get(attemptKey);
    if (existing) {
      if (existing.fingerprint !== fingerprint) throw compositionError('attempt_conflict');
      return existing.receipt;
    }
    if (originRecord && !receiptIsLive(originRecord)) throw compositionError('origin_receipt_unavailable');
    if (admissionByAttempt.size >= MAX_ATTEMPTS) throw compositionError('capacity');
    const priorLaunch = launchIds.get(input.launchId);
    if (priorLaunch && priorLaunch !== attemptKey) throw compositionError('launch_id_conflict');

    const launchClaims = {
      launchId: input.launchId,
      runId: input.runId,
      attemptId: input.attemptId,
      provider: profile.provider,
      nativeIdKind: profile.nativeIdKind,
      hostId,
      homeScopeId: profile.homeScopeId,
      origin: input.origin,
      purpose: input.purpose,
      originBinding,
    };
    const launchRegistration = launchAdapters[profile.provider].registerLaunch(launchClaims, {
      evidenceId: `native-launch-${digest([brokerId, launchClaims]).slice(0, 48)}`,
      source: 'owned-native-runner',
      method: 'fixed-profile-admission',
      adapterVersion: 'native-launch-composition-v1',
      runtimeVersion: 'native-runner-v1',
    });
    const launchRef = launchRegistration.launchRef;
    const record = {
      receiptId: crypto.randomUUID(),
      launchRef,
      claims: Object.freeze({ ...claims }),
      profile,
      launchClaims,
      launchRecord: null,
      originRecord,
      currentOwnerRecord: originRecord,
      status: 'admitted',
      reason: null,
      processState: 'not_started',
      epoch: 1,
      activeEpoch: 1,
      runner: null,
      startPromise: null,
      stopPromise: null,
      explicitStop: false,
      identity: null,
      registration: null,
      executionBinding: null,
      runtimeScope: null,
      connectionHandle: null,
      connectionGeneration: null,
      runtimeDisconnected: false,
      currentContextKind: null,
      currentContextId: null,
      terminalContextIds: new Set(),
      uncertainContextIds: new Set(),
      pendingContexts: [],
      executionActorHandle: null,
      proofHandle: null,
      writerEnvelope: null,
      writerContextId: null,
      runReceipt: null,
      ownerGeneration: 0,
    };
    const receipt = Object.freeze({});
    admissionRecords.set(receipt, record);
    record.admissionReceipt = receipt;
    admissionByAttempt.set(attemptKey, { fingerprint, receipt, record });
    launchRecords.set(launchRef, record);
    launchIds.set(input.launchId, attemptKey);
    return receipt;
  }

  function start(admissionReceipt, input) {
    const record = admissionRecords.get(admissionReceipt);
    if (!record || !hasExactKeys(input, ['inputText']) || typeof input.inputText !== 'string' ||
        Buffer.byteLength(input.inputText, 'utf8') > MAX_INPUT_TEXT_BYTES) {
      return Promise.reject(compositionError('invalid_start'));
    }
    const inputFingerprint = digest(input.inputText);
    if (record.startPromise) {
      if (record.startInputFingerprint !== inputFingerprint) return Promise.reject(compositionError('attempt_conflict'));
      return record.startPromise;
    }
    if (record.processState !== 'not_started') return Promise.reject(compositionError('attempt_already_started'));
    if (record.originRecord && !receiptIsLive(record.originRecord)) {
      setUnknown(record, 'origin_receipt_unavailable');
      record.processState = 'failed';
      return Promise.reject(compositionError('origin_receipt_unavailable'));
    }
    record.startInputFingerprint = inputFingerprint;
    const epoch = record.epoch;
    record.activeEpoch = epoch;
    record.processState = 'starting';
    let runner;
    try {
      runner = runnerFactory({
        provider: record.profile.provider,
        executablePath: record.profile.executablePath,
        hostId,
        homeScopeId: record.profile.homeScopeId,
        homePath: record.profile.homePath,
        cwd: record.profile.cwd,
        profile: 'cockpit-native-v1',
        ...(record.profile.provider === 'claude' ? {
          getAuthentication: () => getAuthentication({ provider: record.profile.provider, profileId: record.profile.profileId }),
        } : {}),
        ...(record.profile.provider === 'codex' ? {
          onAuthenticationRequired: (challenge) => {
            if (!launchCanContinue(record, epoch)) throw compositionError('launch_authority_expired');
            if (!hasExactKeys(challenge, ['loginId', 'authUrl']) ||
              !isIdentifier(challenge.loginId) || typeof challenge.authUrl !== 'string' ||
              challenge.authUrl.length > 4096 || /[\u0000-\u0020\u007f]/.test(challenge.authUrl)) {
              throw compositionError('authentication_challenge_invalid');
            }
            let url;
            try { url = new URL(challenge.authUrl); } catch { throw compositionError('authentication_challenge_invalid'); }
            if (url.protocol !== 'https:' || url.username || url.password || !onAuthenticationRequired) {
              throw compositionError('authentication_presentation_unavailable');
            }
            if (!launchCanContinue(record, epoch)) throw compositionError('launch_authority_expired');
            return onAuthenticationRequired(Object.freeze({ loginId: challenge.loginId, authUrl: challenge.authUrl }));
          },
        } : {}),
        isCurrent: () => launchCanContinue(record, epoch),
        isSourceCurrent: () => sourceCanObserve(record, epoch),
        isContextCurrent: () => contextCanContinue(record, epoch),
        onNative: (event) => {
          try { processNativeEvent(record, event, epoch); }
          catch (error) {
            quarantine(record, epoch, isIdentifier(error && error.code) ? error.code : 'native_binding_failed');
          }
        },
        onDisconnect: (event) => {
          const reason = isRecord(event) && event.provider === record.profile.provider && isIdentifier(event.reason)
            ? event.reason
            : 'owned_process_disconnected';
          markDisconnected(record, epoch, reason);
        },
      });
      if (!runner || typeof runner.start !== 'function' || typeof runner.stop !== 'function' ||
          typeof runner.snapshot !== 'function') throw compositionError('runner_contract_invalid');
      record.runner = runner;
      record.processState = 'running';
    } catch (error) {
      record.epoch += 1;
      setUnknown(record, error.code || 'runner_start_failed');
      record.processState = 'failed';
      return Promise.reject(compositionError(error.code || 'runner_start_failed'));
    }
    const operation = Promise.resolve().then(() => {
      if (record.activeEpoch !== epoch || record.epoch !== epoch || record.processState !== 'running') {
        throw compositionError('start_invalidated');
      }
      return runner.start({ inputText: input.inputText });
    }).then(() => {
      if (record.activeEpoch === epoch && record.epoch === epoch && !record.identity) {
        setUnknown(record, 'native_identity_unavailable');
      } else if (record.activeEpoch === epoch && record.epoch === epoch && !record.proofHandle && record.status !== 'unknown') {
        setUnknown(record, 'native_context_unavailable');
      }
      record.pendingContexts = [];
      return apiResult(record);
    }).catch((error) => {
      if (record.activeEpoch === epoch && record.epoch === epoch) {
        record.epoch += 1;
        disconnectRuntime(record);
        setUnknown(record, isIdentifier(error && error.code) ? error.code : 'runner_start_failed');
        record.processState = 'failed';
      }
      throw compositionError(isIdentifier(error && error.code) ? error.code : 'runner_start_failed');
    });
    record.startPromise = operation;
    return operation;
  }

  function stop(admissionReceipt) {
    const record = admissionRecords.get(admissionReceipt);
    if (!record) throw compositionError('admission_receipt_unavailable');
    if (record.stopPromise) return record.stopPromise;
    if (record.explicitStop) return Promise.resolve(snapshotRecord(record));
    record.explicitStop = true;
    record.epoch += 1;
    record.activeEpoch = record.epoch;
    disconnectRuntime(record);
    record.status = 'unknown';
    record.reason = 'owned_process_stopped';
    if (!record.runner) {
      record.processState = 'stopped';
      record.stopPromise = Promise.resolve(snapshotRecord(record));
      return record.stopPromise;
    }
    record.processState = 'stopping';
    record.stopPromise = Promise.resolve().then(() => record.runner.stop()).then((runnerResult) => {
      let runnerSnapshot = runnerResult;
      if (!isRecord(runnerSnapshot)) {
        try { runnerSnapshot = record.runner.snapshot(); } catch { runnerSnapshot = null; }
      }
      const childStillActive = runnerSnapshot?.ownedChildActive === true ||
        runnerSnapshot?.state === 'stop_unconfirmed';
      record.processState = childStillActive ? 'stop_unconfirmed' : 'stopped';
      if (childStillActive) record.reason = 'owned_process_stop_unconfirmed';
      return snapshotRecord(record);
    }, () => {
      record.processState = 'stop_unconfirmed';
      record.reason = 'owned_process_stop_unconfirmed';
      return snapshotRecord(record);
    });
    return record.stopPromise;
  }

  async function reconcileProof(launchRef, context) {
    const record = launchRecords.get(launchRef);
    if (!readyForReconciliation(record, context)) return null;
    const epoch = record.epoch;
    const currentOwner = ownerRecordFor(record);
    if (!currentOwner || (currentOwner !== record && !receiptIsLive(currentOwner))) return null;
    const runtime = runtimeRecord(record);
    if (!runtime || runtime.state !== 'bound' || !periodMatches(record) ||
        !guardContext(record, context) || record.epoch !== epoch) return null;
    const ownerActorHandle = currentOwner === record ? record.executionActorHandle : currentOwner.executionActorHandle;
    if (!ownerActorHandle) return null;
    let reconciled;
    try {
      reconciled = reconcileExecution(record, record.executionActorHandle, ownerActorHandle,
        runtime.ownerGeneration, currentOwner);
    } catch {
      return null;
    }
    if (record.epoch !== epoch || !periodMatches(record) || !guardContext(record, context)) return null;
    record.proofHandle = reconciled.proofHandle;
    record.ownerGeneration = reconciled.currentProof.ownerGeneration;
    record.status = 'observed';
    record.reason = null;
    createRunReceipt(record);
    return resolveProof(launchRef, context);
  }

  function writerFor(launchRef) {
    const proof = resolveProof(launchRef);
    const record = launchRecords.get(launchRef);
    if (!record || !proof || !record.registration || !record.identity || !record.currentContextId) return null;
    if (record.writerEnvelope && record.writerContextId === record.currentContextId) {
      return deepFreeze({ ...record.writerEnvelope, identity: cloneIdentity(record.writerEnvelope.identity) });
    }
    const writer = registrationAdapters[record.profile.provider].bindWriter(record.registration.executionId, {
      identity: cloneIdentity(record.identity),
      contextId: record.currentContextId,
      evidence: stageEvidence(record, 'writer-binding', record.currentContextId),
    });
    if (resolveProof(launchRef) !== proof || record.currentContextId !== writer.contextId || !periodMatches(record)) return null;
    const envelope = {
      token: writer.token,
      identity: cloneIdentity(writer.identity),
      contextId: writer.contextId,
      executionId: writer.executionId,
    };
    const authorized = registrationAdapters[record.profile.provider].authorizeWrite(envelope, nativeContextFor(record));
    if (!authorized || authorized.status !== 'accepted' || resolveProof(launchRef) !== proof) return null;
    record.writerEnvelope = envelope;
    record.writerContextId = writer.contextId;
    return deepFreeze({ ...envelope, identity: cloneIdentity(envelope.identity) });
  }

  function authorizeWriter(launchRef, envelope) {
    const record = launchRecords.get(launchRef);
    const current = record && record.writerEnvelope;
    if (!record || !current || !hasExactKeys(envelope, ['token', 'identity', 'contextId', 'executionId']) ||
        envelope.token !== current.token || envelope.contextId !== current.contextId ||
        envelope.executionId !== current.executionId || !identityEquals(envelope.identity, current.identity) ||
        record.currentContextId !== current.contextId || !resolveProof(launchRef)) {
      return { ok: false, status: 'unverified', executionId: record?.registration?.executionId || null };
    }
    return registrationAdapters[record.profile.provider].authorizeWrite(envelope, nativeContextFor(record));
  }

  function handoff(executionReceipt, currentOwnerReceipt, targetOwnerReceipt, request) {
    const execution = runReceiptRecords.get(executionReceipt);
    const currentOwner = runReceiptRecords.get(currentOwnerReceipt);
    const targetOwner = runReceiptRecords.get(targetOwnerReceipt);
    if (!execution || !currentOwner || !targetOwner ||
        !hasExactKeys(request, ['handoffId', 'expectedOwnerGeneration']) ||
        !isIdentifier(request.handoffId) || !Number.isSafeInteger(request.expectedOwnerGeneration) ||
        request.expectedOwnerGeneration < 0) throw compositionError('invalid_handoff');
    const resultKey = JSON.stringify([execution.launchRef, request.handoffId]);
    const fingerprint = JSON.stringify([
      execution.receiptId, currentOwner.receiptId, targetOwner.receiptId, request.expectedOwnerGeneration,
    ]);
    const previous = handoffResults.get(resultKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw compositionError('handoff_conflict');
      return previous.receipt;
    }
    if (ownerChainReaches(targetOwner, execution)) throw compositionError('handoff_cycle');
    if (handoffResults.size >= MAX_ATTEMPTS * 2 || !receiptIsLive(execution) ||
        !receiptIsLive(currentOwner) || !receiptIsLive(targetOwner)) throw compositionError('handoff_proof_unavailable');
    const runtime = runtimeRecord(execution);
    const expectedOwner = currentOwner.executionBinding;
    const newOwner = targetOwner.executionBinding;
    if (!runtime || !expectedOwner || !newOwner ||
        !bindingEquals(runtime.currentOwner, expectedOwner) ||
        runtime.ownerGeneration !== request.expectedOwnerGeneration ||
        currentOwner !== execution.currentOwnerRecord) throw compositionError('stale_owner');
    const transition = {
      handoffId: `native-handoff-${digest([brokerId, execution.launchRef, request.handoffId]).slice(0, 48)}`,
      expectedOwner: cloneBinding(expectedOwner),
      expectedOwnerGeneration: request.expectedOwnerGeneration,
      newOwner: cloneBinding(newOwner),
      newOwnerGeneration: request.expectedOwnerGeneration + 1,
      immutableExecutionClaims: immutableClaims(execution),
      evidence: stageEvidence(execution, 'handoff', request.handoffId),
    };
    const result = runtimeKernel.authority.handoff(execution.launchRef, transition, targetOwner.executionActorHandle);
    const receipt = Object.freeze({});
    handoffResults.set(resultKey, { fingerprint, receipt });
    execution.currentOwnerRecord = targetOwner;
    execution.ownerGeneration = result.ownerGeneration;
    execution.proofHandle = null;
    execution.writerEnvelope = null;
    execution.status = 'unknown';
    execution.reason = 'handoff_requires_reconciliation';
    return receipt;
  }

  function snapshot() {
    return deepFreeze({
      schemaVersion: 'native-launch-composition-v1',
      launches: [...launchRecords.values()].map(snapshotRecord),
    });
  }

  return Object.freeze({
    admitLaunch,
    start,
    stop,
    handoff,
    reconcileProof,
    resolveProof,
    checkCurrentProof,
    writerFor,
    authorizeWriter,
    snapshot,
  });
}

module.exports = { createNativeLaunchComposition };
