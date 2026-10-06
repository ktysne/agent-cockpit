'use strict';

const crypto = require('node:crypto');

const PROVIDER_NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });
const CONNECTION_HANDLE_ADAPTER_OWNERS = new WeakMap();
const ACTOR_HANDLE_ADAPTER_OWNERS = new WeakMap();
const IDENTITY_FIELDS = Object.freeze(['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']);
const CLAIM_FIELDS = Object.freeze([
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding', 'identity', 'executionBinding',
]);
const SCOPE_FIELDS = Object.freeze(['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'connectionSlotId']);
const ACTOR_CLAIM_FIELDS = Object.freeze([
  'identity', 'periodId', 'actor', 'contextId', 'launchRef', 'immutableExecutionClaims',
]);
const EVIDENCE_FIELDS = Object.freeze([
  'evidenceId', 'source', 'method', 'adapterVersion', 'runtimeVersion', 'observedAt', 'registrationRef',
]);
const IDENTIFIER_MAX = 512;
const MAX_METADATA_KEYS = 32;
const MAX_CAPABILITIES = 32;
const MAX_CAPABILITY_LENGTH = 128;
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_EXECUTIONS = 10_000;
const MAX_OBSERVATIONS = 10_000;
const MAX_CONNECTIONS = 20_000;
const MAX_ACTORS = 40_000;
const MAX_HANDOFFS = 20_000;

function runtimeError(code) {
  const error = new Error('runtime binding rejected the operation');
  error.code = code;
  return error;
}

function claimAdapterHandle(handle, owners, adapterOwner, errorCode) {
  if (!handle || (typeof handle !== 'object' && typeof handle !== 'function')) throw runtimeError(errorCode);
  const existingOwner = owners.get(handle);
  if (existingOwner && existingOwner !== adapterOwner) throw runtimeError(errorCode);
  if (!existingOwner) owners.set(handle, adapterOwner);
}
function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, fields) {
  if (!isRecord(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function isIdentifier(value, maxLength = IDENTIFIER_MAX) {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value !== value.trim()) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

function normalizeIdentity(value) {
  if (!hasExactKeys(value, IDENTITY_FIELDS) ||
      typeof value.provider !== 'string' || !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, value.provider) ||
      value.nativeIdKind !== PROVIDER_NATIVE_ID_KINDS[value.provider] ||
      !isIdentifier(value.hostId) || !isIdentifier(value.homeScopeId) || !isIdentifier(value.nativeId)) return null;
  return { provider: value.provider, nativeIdKind: value.nativeIdKind, hostId: value.hostId,
    homeScopeId: value.homeScopeId, nativeId: value.nativeId };
}

function normalizeActor(value) {
  if (!hasExactKeys(value, ['kind', 'id']) ||
      (value.kind !== 'agent' && value.kind !== 'tool-use') || !isIdentifier(value.id)) return null;
  return { kind: value.kind, id: value.id };
}

function normalizePeriodBinding(value) {
  if (!hasExactKeys(value, ['periodId', 'actor']) || !isIdentifier(value.periodId)) return null;
  const actor = normalizeActor(value.actor);
  return actor ? { periodId: value.periodId, actor } : null;
}

function normalizeImmutableClaims(value) {
  if (!hasExactKeys(value, CLAIM_FIELDS) || !isIdentifier(value.launchId) || !isIdentifier(value.runId) ||
      !isIdentifier(value.attemptId) || typeof value.provider !== 'string' ||
      !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, value.provider) ||
      value.nativeIdKind !== PROVIDER_NATIVE_ID_KINDS[value.provider] ||
      !isIdentifier(value.hostId) || !isIdentifier(value.homeScopeId)) return null;
  const validPurpose =
    (value.origin === 'standalone' && ['agent', 'pr-creator'].includes(value.purpose)) ||
    (value.origin === 'delegated' && value.purpose === 'agent') ||
    (value.origin === 'review' && value.purpose === 'cross-review');
  if (!validPurpose) return null;
  let originBinding = null;
  if (value.origin === 'standalone') {
    if (value.originBinding !== null) return null;
  } else {
    originBinding = normalizePeriodBinding(value.originBinding);
    if (!originBinding) return null;
  }
  const identity = normalizeIdentity(value.identity);
  const executionBinding = normalizePeriodBinding(value.executionBinding);
  if (!identity || !executionBinding || identity.provider !== value.provider ||
      identity.nativeIdKind !== value.nativeIdKind || identity.hostId !== value.hostId ||
      identity.homeScopeId !== value.homeScopeId) return null;
  return { launchId: value.launchId, runId: value.runId, attemptId: value.attemptId,
    provider: value.provider, nativeIdKind: value.nativeIdKind, hostId: value.hostId,
    homeScopeId: value.homeScopeId, origin: value.origin, purpose: value.purpose,
    originBinding: originBinding ? clonePeriodBinding(originBinding) : null,
    identity, executionBinding };
}

function normalizeLaunchClaims(value) {
  if (!isRecord(value)) return null;
  const projected = {};
  for (const field of CLAIM_FIELDS) {
    if (!Object.hasOwn(value, field)) return null;
    projected[field] = value[field];
  }
  return normalizeImmutableClaims(projected);
}

function normalizeScope(value) {
  if (!hasExactKeys(value, SCOPE_FIELDS) || typeof value.provider !== 'string' ||
      !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, value.provider) ||
      value.nativeIdKind !== PROVIDER_NATIVE_ID_KINDS[value.provider] ||
      !isIdentifier(value.hostId) || !isIdentifier(value.homeScopeId) ||
      !isIdentifier(value.connectionSlotId)) return null;
  return { provider: value.provider, nativeIdKind: value.nativeIdKind, hostId: value.hostId,
    homeScopeId: value.homeScopeId, connectionSlotId: value.connectionSlotId };
}

function normalizeEvidence(value, requireId = true) {
  if (!isRecord(value) || Reflect.ownKeys(value).length > MAX_METADATA_KEYS) return null;
  const metadata = {};
  for (const field of EVIDENCE_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    if (!isIdentifier(value[field])) return null;
    metadata[field] = value[field];
  }
  if (Object.hasOwn(value, 'capabilities')) {
    if (!Array.isArray(value.capabilities) || value.capabilities.length > MAX_CAPABILITIES) return null;
    const capabilities = [];
    for (let index = 0; index < value.capabilities.length; index += 1) {
      if (!Object.hasOwn(value.capabilities, index) || !isIdentifier(value.capabilities[index], MAX_CAPABILITY_LENGTH)) return null;
      capabilities.push(value.capabilities[index]);
    }
    if (Reflect.ownKeys(value.capabilities).some((key) => key !== 'length' &&
        !(typeof key === 'string' && Number.isSafeInteger(Number(key)) && Number(key) >= 0 && String(Number(key)) === key && Number(key) < value.capabilities.length))) return null;
    metadata.capabilities = capabilities;
  }
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_METADATA_BYTES ||
      (requireId && !metadata.evidenceId)) return null;
  return metadata;
}

function identityEqual(left, right) {
  return Boolean(left && right) && IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}
function actorEqual(left, right) {
  return Boolean(left && right) && left.kind === right.kind && left.id === right.id;
}
function bindingEqual(left, right) {
  return Boolean(left && right) && left.periodId === right.periodId && actorEqual(left.actor, right.actor);
}
function scopeMatchesIdentity(scope, identity) {
  return Boolean(scope && identity) && scope.provider === identity.provider &&
    scope.nativeIdKind === identity.nativeIdKind && scope.hostId === identity.hostId &&
    scope.homeScopeId === identity.homeScopeId;
}
function cloneIdentity(identity) { return identity ? { ...identity } : null; }
function cloneActor(actor) { return actor ? { kind: actor.kind, id: actor.id } : null; }
function clonePeriodBinding(binding) {
  return binding ? { periodId: binding.periodId, actor: cloneActor(binding.actor) } : null;
}
function cloneClaims(claims) {
  return { ...claims, originBinding: clonePeriodBinding(claims.originBinding),
    identity: cloneIdentity(claims.identity), executionBinding: clonePeriodBinding(claims.executionBinding) };
}
function cloneEvidence(evidence) {
  return evidence ? { ...evidence, ...(evidence.capabilities ? { capabilities: [...evidence.capabilities] } : {}) } : null;
}
function freezeDeep(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}
function launchClaimsFromA(record) {
  if (!isRecord(record)) return null;
  return normalizeLaunchClaims({
    launchId: record.launchId, runId: record.runId, attemptId: record.attemptId,
    provider: record.provider, nativeIdKind: record.nativeIdKind, hostId: record.hostId,
    homeScopeId: record.homeScopeId, origin: record.origin, purpose: record.purpose,
    originBinding: record.originBinding, identity: record.identity,
    executionBinding: record.executionBinding,
  });
}

function normalizeActorClaims(value) {
  if (!hasExactKeys(value, ACTOR_CLAIM_FIELDS)) return null;
  const identity = normalizeIdentity(value.identity);
  const actor = normalizeActor(value.actor);
  if (!identity || !isIdentifier(value.periodId) || !actor || !isIdentifier(value.contextId)) return null;
  if (value.launchRef === null && value.immutableExecutionClaims === null) {
    return { identity, periodId: value.periodId, actor, contextId: value.contextId,
      launchRef: null, immutableExecutionClaims: null };
  }
  if (!isIdentifier(value.launchRef)) return null;
  const immutableExecutionClaims = normalizeImmutableClaims(value.immutableExecutionClaims);
  if (!immutableExecutionClaims) return null;
  return { identity, periodId: value.periodId, actor, contextId: value.contextId,
    launchRef: value.launchRef, immutableExecutionClaims };
}

function createRuntimeBindingKernel({ registrationRegistry, launchRegistry } = {}) {
  if (!registrationRegistry || typeof registrationRegistry.snapshot !== 'function' ||
      !launchRegistry || typeof launchRegistry.get !== 'function') {
    throw new TypeError('runtime binding kernel requires read-only registration and launch registries');
  }
  const launches = new Map();
  const launchKeys = new Map();
  const observations = new Map();
  const connections = new Map();
  const slotStates = new Map();
  const evidenceClaims = new Map();
  const actorClaims = new Map();
  const actorTombstones = new Set();
  const contextTombstones = new Set();
  const proofByLaunch = new Map();
  const proofHandles = new WeakMap();
  const connectionHandles = new WeakMap();
  const actorHandles = new WeakMap();
  const handoffReceipts = new Map();
  const connectionIdClaims = new Map();

  function readSnapshot() {
    let snapshot;
    try { snapshot = registrationRegistry.snapshot(); } catch { throw runtimeError('registry_unavailable'); }
    if (snapshot && typeof snapshot.then === 'function' || !isRecord(snapshot) ||
        !Array.isArray(snapshot.conversations) || !Array.isArray(snapshot.executions)) {
      throw runtimeError('registry_unavailable');
    }
    return snapshot;
  }

  function activePeriod(snapshot, periodId) {
    const matching = snapshot.executions.filter((item) => isRecord(item) && item.executionId === periodId);
    if (matching.length !== 1 || matching[0].state !== 'active' ||
        !isIdentifier(matching[0].conversationId) || !isIdentifier(matching[0].sessionId)) return null;
    const conversations = snapshot.conversations.filter((item) =>
      isRecord(item) && item.conversationId === matching[0].conversationId);
    if (conversations.length !== 1) return null;
    const identity = normalizeIdentity(conversations[0].identity);
    return identity ? { periodId, conversationId: matching[0].conversationId,
      sessionId: matching[0].sessionId, identity } : null;
  }

  function readARecord(launchRef) {
    let source;
    try { source = launchRegistry.get(launchRef); } catch { throw runtimeError('registry_unavailable'); }
    if (source && typeof source.then === 'function') throw runtimeError('registry_unavailable');
    if (!source) throw runtimeError('unknown_launch');
    return source;
  }

  function readBoundA(launchRef, claims) {
    if (!isIdentifier(launchRef)) throw runtimeError('unknown_launch');
    const source = readARecord(launchRef);
    if (source.state !== 'bound') throw runtimeError('stale_launch');
    const sourceClaims = launchClaimsFromA(source);
    if (!sourceClaims || (claims && JSON.stringify(sourceClaims) !== JSON.stringify(claims)) ||
        !isIdentifier(source.conversationId) || !isIdentifier(source.sessionId)) throw runtimeError('stale_launch');
    return { source, claims: sourceClaims };
  }

  function readBoundLaunch(launchRef, claims) {
    const runtime = launches.get(launchRef);
    if (!runtime) throw runtimeError('unknown_launch');
    const { source, claims: sourceClaims } = readBoundA(launchRef, runtime.claims);
    if (claims && JSON.stringify(sourceClaims) !== JSON.stringify(claims)) throw runtimeError('stale_launch');
    if (!identityEqual(sourceClaims.identity, runtime.claims.identity) ||
        !bindingEqual(sourceClaims.executionBinding, runtime.claims.executionBinding)) throw runtimeError('stale_launch');
    return { runtime, source, claims: sourceClaims };
  }

  function verifyChildPeriod(snapshot, source, claims) {
    const period = activePeriod(snapshot, claims.executionBinding.periodId);
    if (!period) throw runtimeError('stale_period');
    if (!identityEqual(period.identity, claims.identity) || period.conversationId !== source.conversationId ||
        period.sessionId !== source.sessionId) throw runtimeError('identity_mismatch');
    return period;
  }

  function normalizedLaunchKey(claims) { return JSON.stringify([claims.launchId, claims.runId, claims.attemptId]); }
  function evidenceFingerprint(stage, evidence, subject) { return JSON.stringify({ stage, evidence, subject }); }
  function assertEvidenceAvailable(evidence, stage, subject) {
    const fingerprint = evidenceFingerprint(stage, evidence, subject);
    const prior = evidenceClaims.get(evidence.evidenceId);
    if (prior && prior.fingerprint !== fingerprint) throw runtimeError('evidence_conflict');
    return { fingerprint, prior };
  }
  function commitEvidence(evidence, fingerprint, value) {
    if (!evidenceClaims.has(evidence.evidenceId)) evidenceClaims.set(evidence.evidenceId, { fingerprint, value });
  }

  function slotKey(scope) {
    return JSON.stringify([scope.provider, scope.nativeIdKind, scope.hostId, scope.homeScopeId, scope.connectionSlotId]);
  }
  function actorKey(periodId, actor) { return JSON.stringify([periodId, actor.kind, actor.id]); }
  function contextGroupKey(actor) {
    return JSON.stringify([...IDENTITY_FIELDS.map((field) => actor.identity[field]),
      actor.periodId, actor.actor.kind, actor.actor.id, actor.contextId]);
  }
  function currentConnection(connection) {
    if (!connection || !connection.active) return false;
    const latest = slotStates.get(connection.slotKey);
    return Boolean(latest && latest.connectionId === connection.connectionId && latest.generation === connection.generation);
  }

  function currentActorState(actor, snapshot) {
    if (!actor) return { ok: false, reason: 'proof_mismatch' };
    if (actorTombstones.has(actorKey(actor.periodId, actor.actor))) {
      return { ok: false, reason: actor.isExecution ? 'execution_actor_ended' : 'owner_actor_ended' };
    }
    if (!currentConnection(actor.connection)) return { ok: false, reason: 'stale_connection' };
    const period = activePeriod(snapshot, actor.periodId);
    if (!period) return { ok: false, reason: actor.isExecution ? 'execution_period_ended' : 'owner_period_ended' };
    if (!identityEqual(period.identity, actor.identity) || !scopeMatchesIdentity(actor.connection.scope, actor.identity)) {
      return { ok: false, reason: 'proof_mismatch' };
    }
    return { ok: true, period };
  }

  function currentContextState(actor, snapshot) {
    const state = currentActorState(actor, snapshot);
    if (!state.ok) return state;
    if (contextTombstones.has(contextGroupKey(actor))) {
      return { ok: false, reason: actor.isExecution ? 'execution_context_ended' : 'owner_context_ended' };
    }
    return state;
  }

  function verifyChildPeriodForProof(snapshot, source, claims) {
    const period = activePeriod(snapshot, claims.executionBinding.periodId);
    return Boolean(period && identityEqual(period.identity, claims.identity) &&
      period.conversationId === source.conversationId && period.sessionId === source.sessionId);
  }

  function proofStatus(runtime, proof, snapshot, requireLatest = true) {
    let source;
    try { ({ source } = readBoundLaunch(runtime.launchRef, runtime.claims)); }
    catch (error) { return { ok: false, reason: error.code === 'registry_unavailable' ? 'registry_unavailable' : 'stale_launch' }; }
    if (!verifyChildPeriodForProof(snapshot, source, runtime.claims)) {
      return { ok: false, reason: 'execution_period_ended' };
    }
    if (runtime.ownerGeneration !== proof.ownerGeneration || !bindingEqual(runtime.currentOwner, proof.owner)) {
      return { ok: false, reason: 'owner_generation_mismatch' };
    }
    const execution = currentContextState({ ...proof.executionActor, isExecution: true }, snapshot);
    if (!execution.ok) return execution;
    const owner = currentContextState({ ...proof.ownerActor, isExecution: false }, snapshot);
    if (!owner.ok) return owner;
    if (!bindingEqual(runtime.currentOwner, { periodId: proof.ownerActor.periodId, actor: proof.ownerActor.actor })) {
      return { ok: false, reason: 'owner_conflict' };
    }
    if (requireLatest && proofByLaunch.get(runtime.launchRef) !== proof) return { ok: false, reason: 'proof_stale' };
    return { ok: true, reason: 'accepted' };
  }

  function publicProof(proof) {
    if (!proof) return null;
    return {
      identity: cloneIdentity(proof.claims.identity),
      executionBinding: clonePeriodBinding(proof.claims.executionBinding),
      currentOwner: clonePeriodBinding(proof.owner),
      ownerGeneration: proof.ownerGeneration,
      executionConnectionGeneration: proof.executionActor.connection.generation,
      ownerConnectionGeneration: proof.ownerActor.connection.generation,
      executionContextId: proof.executionActor.contextId,
      ownerContextId: proof.ownerActor.contextId,
    };
  }

  function currentProofSummary(runtime) {
    const proof = proofByLaunch.get(runtime.launchRef);
    if (!proof) return null;
    try {
      const status = proofStatus(runtime, proof, readSnapshot());
      return status.ok ? publicProof(proof) : null;
    } catch {
      return null;
    }
  }

  function publicLaunch(runtime) {
    let source;
    try { source = readARecord(runtime.launchRef); } catch { source = null; }
    return { launchRef: runtime.launchRef, ...cloneClaims(runtime.claims),
      state: source?.state || 'unknown', conversationId: source?.conversationId || null,
      sessionId: source?.sessionId || null, currentOwner: clonePeriodBinding(runtime.currentOwner),
      ownerGeneration: runtime.ownerGeneration, currentProof: currentProofSummary(runtime) };
  }

  function adoptExecution(launchRef, claimsInput) {
    if (!isIdentifier(launchRef)) throw runtimeError('unknown_launch');
    const claims = normalizeImmutableClaims(claimsInput);
    if (!claims) throw runtimeError('invalid_execution_claims');
    const { source, claims: sourceClaims } = readBoundA(launchRef, claims);
    verifyChildPeriod(readSnapshot(), source, sourceClaims);
    const initialOwner = sourceClaims.origin === 'standalone' ? sourceClaims.executionBinding : sourceClaims.originBinding;
    if (!initialOwner || !bindingEqual(source.currentOwner, initialOwner) || source.ownerGeneration !== 0) {
      throw runtimeError('stale_launch');
    }
    const key = normalizedLaunchKey(sourceClaims);
    const previousRef = launchKeys.get(key);
    if (previousRef && previousRef !== launchRef) throw runtimeError('launch_conflict');
    const existing = launches.get(launchRef);
    if (existing) {
      if (JSON.stringify(existing.claims) !== JSON.stringify(sourceClaims)) throw runtimeError('launch_conflict');
      return publicLaunch(existing);
    }
    if (launches.size >= MAX_EXECUTIONS) throw runtimeError('capacity');
    const runtime = { launchRef, claims: cloneClaims(sourceClaims), currentOwner: clonePeriodBinding(initialOwner),
      ownerGeneration: 0, currentProof: null };
    launches.set(launchRef, runtime);
    launchKeys.set(key, launchRef);
    return publicLaunch(runtime);
  }

  function openConnection(scopeInput, connectionId, evidenceInput) {
    const scope = normalizeScope(scopeInput);
    const evidence = normalizeEvidence(evidenceInput);
    if (!scope || !isIdentifier(connectionId)) throw runtimeError('invalid_connection');
    if (!evidence) throw runtimeError('invalid_evidence');
    const key = slotKey(scope);
    const fingerprint = JSON.stringify({ scope, connectionId, evidence });
    const priorId = connectionIdClaims.get(connectionId);
    if (priorId) {
      if (priorId.fingerprint !== fingerprint || !currentConnection(priorId.connection)) throw runtimeError('connection_conflict');
      return { connectionHandle: priorId.handle, connectionGeneration: priorId.connection.generation };
    }
    const evidenceClaim = assertEvidenceAvailable(evidence, 'connection', { scope, connectionId });
    const previousSlot = slotStates.get(key);
    const generation = previousSlot ? previousSlot.generation + 1 : 1;
    if (!Number.isSafeInteger(generation) || connections.size >= MAX_CONNECTIONS) throw runtimeError('capacity');
    const connection = { connectionId, slotKey: key, scope: { ...scope }, generation,
      active: true, evidence: cloneEvidence(evidence) };
    const handle = Object.freeze({});
    if (previousSlot) {
      const old = connections.get(previousSlot.connectionId);
      if (old) old.active = false;
    }
    connections.set(connectionId, connection);
    slotStates.set(key, { connectionId, generation });
    connectionHandles.set(handle, connection);
    connectionIdClaims.set(connectionId, { fingerprint, connection, handle });
    commitEvidence(evidence, evidenceClaim.fingerprint, connectionId);
    return { connectionHandle: handle, connectionGeneration: generation };
  }

  function getConnection(connectionHandle) {
    const connection = connectionHandles.get(connectionHandle);
    if (!connection) throw runtimeError('foreign_connection_handle');
    if (!currentConnection(connection)) throw runtimeError('stale_connection');
    return connection;
  }

  function checkCurrentConnection(connectionHandle) {
    return currentConnection(connectionHandles.get(connectionHandle));
  }

  function disconnect(connectionHandle) {
    const connection = connectionHandles.get(connectionHandle);
    if (!connection || !currentConnection(connection)) return false;
    connection.active = false;
    return true;
  }

  function attestActor(connectionHandle, claimsInput, evidenceInput) {
    const connection = getConnection(connectionHandle);
    const claims = normalizeActorClaims(claimsInput);
    const evidence = normalizeEvidence(evidenceInput);
    if (!claims) throw runtimeError('invalid_actor_claims');
    if (!evidence) throw runtimeError('invalid_evidence');
    if (!scopeMatchesIdentity(connection.scope, claims.identity)) throw runtimeError('identity_mismatch');
    const snapshot = readSnapshot();
    const period = activePeriod(snapshot, claims.periodId);
    if (!period) throw runtimeError('stale_period');
    if (!identityEqual(period.identity, claims.identity)) throw runtimeError('identity_mismatch');

    let launchClaims = null;
    if (claims.launchRef !== null) {
      launchClaims = readBoundA(claims.launchRef, claims.immutableExecutionClaims).claims;
      if (!identityEqual(launchClaims.identity, claims.identity) ||
          !bindingEqual(launchClaims.executionBinding, { periodId: claims.periodId, actor: claims.actor })) {
        throw runtimeError('invalid_actor_claims');
      }
    }
    if (actorTombstones.has(actorKey(claims.periodId, claims.actor))) throw runtimeError('actor_ended');
    if (contextTombstones.has(contextGroupKey(claims))) throw runtimeError('context_ended');
    const contextKey = JSON.stringify([connection.connectionId, connection.generation,
      ...IDENTITY_FIELDS.map((field) => claims.identity[field]), claims.contextId]);
    const subject = { connectionId: connection.connectionId, connectionGeneration: connection.generation, claims };
    const fingerprint = evidenceFingerprint('actor', evidence, subject);
    const previous = actorClaims.get(contextKey);
    if (previous) {
      if (previous.fingerprint !== fingerprint) throw runtimeError('context_claim_conflict');
      const fresh = currentActorState(previous.actor, snapshot);
      if (!fresh.ok) {
        const code = fresh.reason === 'execution_actor_ended' || fresh.reason === 'owner_actor_ended'
          ? 'actor_ended' : fresh.reason.includes('period_ended') ? 'stale_period' : fresh.reason;
        throw runtimeError(code);
      }
      return { actorHandle: previous.handle };
    }
    const evidenceClaim = assertEvidenceAvailable(evidence, 'actor', subject);
    if (actorClaims.size >= MAX_ACTORS) throw runtimeError('capacity');
    const actor = { identity: cloneIdentity(claims.identity), periodId: claims.periodId,
      actor: cloneActor(claims.actor), contextId: claims.contextId, launchRef: claims.launchRef,
      immutableExecutionClaims: launchClaims ? cloneClaims(launchClaims) : null,
      connection, evidence: cloneEvidence(evidence) };
    const handle = Object.freeze({});
    actorHandles.set(handle, actor);
    actorClaims.set(contextKey, { fingerprint, actor, handle });
    commitEvidence(evidence, evidenceClaim.fingerprint, contextKey);
    return { actorHandle: handle };
  }

  function endActor(actorHandle) {
    const actor = actorHandles.get(actorHandle);
    if (!actor) throw runtimeError('foreign_actor_handle');
    if (!currentConnection(actor.connection)) return false;
    actorTombstones.add(actorKey(actor.periodId, actor.actor));
    actor.ended = true;
    return true;
  }

  function endContext(actorHandle) {
    const actor = actorHandles.get(actorHandle);
    if (!actor) throw runtimeError('foreign_actor_handle');
    if (!currentConnection(actor.connection)) return false;
    contextTombstones.add(contextGroupKey(actor));
    return true;
  }

  function requireActor(actorHandle) {
    const actor = actorHandles.get(actorHandle);
    if (!actor) throw runtimeError('foreign_actor_handle');
    const state = currentContextState(actor, readSnapshot());
    if (!state.ok) {
      const code = state.reason === 'execution_actor_ended' || state.reason === 'owner_actor_ended'
        ? 'actor_ended' : state.reason.includes('period_ended') ? 'stale_period' :
          state.reason === 'stale_connection' ? 'stale_connection' :
          state.reason.includes('context_ended') ? 'context_ended' : 'identity_mismatch';
      throw runtimeError(code);
    }
    return actor;
  }

  function reconcileExecution(launchRef, input) {
    if (!isRecord(input) || !hasExactKeys(input,
        ['executionActorHandle', 'ownerActorHandle', 'expectedOwnerGeneration']) ||
        !Number.isSafeInteger(input.expectedOwnerGeneration) || input.expectedOwnerGeneration < 0) {
      throw runtimeError('invalid_reconciliation');
    }
    const { runtime, source, claims } = readBoundLaunch(launchRef);
    const snapshot = readSnapshot();
    verifyChildPeriod(snapshot, source, claims);
    if (runtime.ownerGeneration !== input.expectedOwnerGeneration) throw runtimeError('stale_owner_generation');
    const executionActor = requireActor(input.executionActorHandle);
    const ownerActor = requireActor(input.ownerActorHandle);
    if (executionActor.launchRef !== launchRef ||
        JSON.stringify(executionActor.immutableExecutionClaims) !== JSON.stringify(claims) ||
        !identityEqual(executionActor.identity, claims.identity) ||
        !bindingEqual({ periodId: executionActor.periodId, actor: executionActor.actor }, claims.executionBinding)) {
      throw runtimeError('invalid_actor_claims');
    }
    if (!bindingEqual(runtime.currentOwner, { periodId: ownerActor.periodId, actor: ownerActor.actor })) {
      throw runtimeError('owner_conflict');
    }
    const proof = { launchRef, claims: cloneClaims(claims), executionActor, ownerActor,
      owner: clonePeriodBinding(runtime.currentOwner), ownerGeneration: runtime.ownerGeneration };
    const status = proofStatus(runtime, proof, snapshot, false);
    if (!status.ok) throw runtimeError(status.reason === 'execution_period_ended' ? 'stale_period' :
      status.reason === 'stale_launch' ? 'stale_launch' : status.reason === 'registry_unavailable' ? 'registry_unavailable' : 'stale_connection');
    const proofHandle = Object.freeze({});
    proofHandles.set(proofHandle, proof);
    proofByLaunch.set(launchRef, proof);
    runtime.currentProof = publicProof(proof);
    return { proofHandle, currentProof: publicProof(proof) };
  }

  function normalizeTransition(value) {
    const fields = ['handoffId', 'expectedOwner', 'expectedOwnerGeneration', 'newOwner',
      'newOwnerGeneration', 'immutableExecutionClaims', 'evidence'];
    if (!hasExactKeys(value, fields) || !isIdentifier(value.handoffId) ||
        !Number.isSafeInteger(value.expectedOwnerGeneration) || value.expectedOwnerGeneration < 0 ||
        !Number.isSafeInteger(value.newOwnerGeneration) || value.newOwnerGeneration < 0) return null;
    const expectedOwner = normalizePeriodBinding(value.expectedOwner);
    const newOwner = normalizePeriodBinding(value.newOwner);
    const claims = normalizeImmutableClaims(value.immutableExecutionClaims);
    const evidence = normalizeEvidence(value.evidence);
    if (!expectedOwner || !newOwner || !claims || !evidence) return null;
    return { handoffId: value.handoffId, expectedOwner,
      expectedOwnerGeneration: value.expectedOwnerGeneration, newOwner,
      newOwnerGeneration: value.newOwnerGeneration, immutableExecutionClaims: claims, evidence };
  }

  function cloneReceipt(receipt) {
    return freezeDeep({ handoffId: receipt.handoffId, owner: clonePeriodBinding(receipt.owner),
      ownerGeneration: receipt.ownerGeneration, status: receipt.status });
  }

  function handoff(launchRef, transitionInput, newOwnerActorHandle) {
    const transition = normalizeTransition(transitionInput);
    if (!transition) throw runtimeError('invalid_handoff');
    const prior = handoffReceipts.get(transition.handoffId);
    const fingerprint = JSON.stringify({ launchRef, transition });
    if (prior) {
      if (prior.fingerprint !== fingerprint) throw runtimeError('handoff_conflict');
      return cloneReceipt(prior.receipt);
    }
    const { runtime, source, claims } = readBoundLaunch(launchRef, transition.immutableExecutionClaims);
    const snapshot = readSnapshot();
    verifyChildPeriod(snapshot, source, claims);
    if (transition.expectedOwnerGeneration !== runtime.ownerGeneration ||
        !bindingEqual(transition.expectedOwner, runtime.currentOwner)) throw runtimeError('stale_owner_generation');
    if (!Number.isSafeInteger(runtime.ownerGeneration + 1) ||
        transition.newOwnerGeneration !== runtime.ownerGeneration + 1) throw runtimeError('generation_gap');
    if (actorTombstones.has(actorKey(transition.newOwner.periodId, transition.newOwner.actor))) {
      throw runtimeError('actor_ended');
    }
    const ownerActor = requireActor(newOwnerActorHandle);
    if (!bindingEqual(transition.newOwner, { periodId: ownerActor.periodId, actor: ownerActor.actor })) {
      throw runtimeError('owner_conflict');
    }
    if (JSON.stringify(transition.immutableExecutionClaims) !== JSON.stringify(claims)) throw runtimeError('stale_launch');
    const evidenceSubject = { launchRef, transition: {
      handoffId: transition.handoffId, expectedOwner: transition.expectedOwner,
      expectedOwnerGeneration: transition.expectedOwnerGeneration, newOwner: transition.newOwner,
      newOwnerGeneration: transition.newOwnerGeneration, immutableExecutionClaims: transition.immutableExecutionClaims,
    } };
    const evidenceClaim = assertEvidenceAvailable(transition.evidence, 'handoff', evidenceSubject);
    if (handoffReceipts.size >= MAX_HANDOFFS) throw runtimeError('capacity');
    const receipt = freezeDeep({ handoffId: transition.handoffId,
      owner: clonePeriodBinding(transition.newOwner), ownerGeneration: transition.newOwnerGeneration,
      status: 'accepted' });
    runtime.currentOwner = clonePeriodBinding(transition.newOwner);
    runtime.ownerGeneration = transition.newOwnerGeneration;
    runtime.currentProof = null;
    proofByLaunch.delete(launchRef);
    handoffReceipts.set(transition.handoffId, { fingerprint, receipt });
    commitEvidence(transition.evidence, evidenceClaim.fingerprint, transition.handoffId);
    return cloneReceipt(receipt);
  }

  function checkCurrentProof(launchRef, proofHandle) {
    const runtime = launches.get(launchRef);
    const proof = proofHandles.get(proofHandle);
    if (!runtime || !proof || proof.launchRef !== launchRef) return { ok: false, reason: 'proof_mismatch' };
    let status;
    try { status = proofStatus(runtime, proof, readSnapshot()); }
    catch (error) { status = { ok: false, reason: error.code === 'registry_unavailable' ? 'registry_unavailable' : error.code === 'stale_period' ? 'execution_period_ended' : 'stale_launch' }; }
    if (!status.ok) {
      if (status.reason !== 'registry_unavailable' && proofByLaunch.get(launchRef) === proof) {
        proofByLaunch.delete(launchRef);
        runtime.currentProof = null;
      }
      return { ok: false, reason: status.reason };
    }
    return { ok: true, reason: 'accepted' };
  }

  function observe(identityInput, metadataInput) {
    const identity = normalizeIdentity(identityInput);
    const metadata = normalizeEvidence(metadataInput, false);
    if (!identity || !metadata) return { ok: false, status: 'mismatch', observationId: null };
    if (observations.size >= MAX_OBSERVATIONS) return { ok: false, status: 'capacity', observationId: null };
    const observationId = `runtime-observation-${crypto.randomUUID()}`;
    observations.set(observationId, { observationId, identity, metadata });
    return { ok: true, status: 'unverified', observationId };
  }

  function get(launchRef) {
    if (!isIdentifier(launchRef)) return null;
    const runtime = launches.get(launchRef);
    return runtime ? publicLaunch(runtime) : null;
  }

  function snapshot() {
    const registrationSnapshot = readSnapshot();
    return {
      launches: [...launches.values()].map(publicLaunch),
      observations: [...observations.values()].map((item) => ({ observationId: item.observationId,
        identity: cloneIdentity(item.identity), status: 'unverified', metadata: cloneEvidence(item.metadata) })),
      connections: [...connections.values()].map((item) => ({ connectionId: item.connectionId,
        scope: { ...item.scope }, generation: item.generation,
        state: currentConnection(item) ? 'active' : 'ended', evidence: cloneEvidence(item.evidence) })),
      actors: [...actorClaims.values()].map(({ actor }) => ({ identity: cloneIdentity(actor.identity),
        periodId: actor.periodId, actor: cloneActor(actor.actor), contextId: actor.contextId,
        launchRef: actor.launchRef, connectionId: actor.connection.connectionId,
        connectionGeneration: actor.connection.generation,
        state: actorTombstones.has(actorKey(actor.periodId, actor.actor)) || !activePeriod(registrationSnapshot, actor.periodId)
        ? 'ended' : currentConnection(actor.connection) ? 'active' : 'unknown',
        contextState: contextTombstones.has(contextGroupKey(actor)) ? 'ended' :
          currentContextState(actor, registrationSnapshot).ok ? 'active' : 'unknown',
      evidence: cloneEvidence(actor.evidence) })),
      handoffs: [...handoffReceipts.values()].map(({ receipt }) => cloneReceipt(receipt)),
    };
  }

  const registry = Object.freeze({ observe, get, snapshot, checkCurrentProof, checkCurrentConnection });
  const authority = Object.freeze({ adoptExecution, openConnection, disconnect, attestActor,
    endActor, endContext, reconcileExecution, handoff });
  return Object.freeze({ registry, authority });
}

function createProviderRuntimeAdapter(provider, registry, authority) {
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, provider) ||
      !registry || typeof registry.observe !== 'function' || typeof registry.get !== 'function' ||
      typeof registry.snapshot !== 'function' || typeof registry.checkCurrentProof !== 'function' ||
      !authority || typeof authority.adoptExecution !== 'function' ||
      typeof authority.openConnection !== 'function' || typeof authority.disconnect !== 'function' ||
      typeof authority.attestActor !== 'function' || typeof authority.endActor !== 'function' ||
      typeof authority.reconcileExecution !== 'function' || typeof authority.handoff !== 'function') {
    throw new TypeError('provider runtime adapter requires a supported provider, registry, and authority');
  }
  const expectedKind = PROVIDER_NATIVE_ID_KINDS[provider];
  const adapterOwner = Object.freeze({});
  const connectionHandles = new WeakSet();
  const actorHandles = new WeakSet();

  function requireProviderIdentity(identity) {
    const normalized = normalizeIdentity(identity);
    if (!normalized || normalized.provider !== provider || normalized.nativeIdKind !== expectedKind) {
      throw runtimeError('provider_mismatch');
    }
    return normalized;
  }
  function requireProviderClaims(claims) {
    const normalized = normalizeImmutableClaims(claims);
    if (!normalized || normalized.provider !== provider || normalized.nativeIdKind !== expectedKind) {
      throw runtimeError('provider_mismatch');
    }
    requireProviderIdentity(normalized.identity);
    return normalized;
  }
  function requireLaunch(launchRef) {
    const launch = registry.get(launchRef);
    if (!launch || launch.provider !== provider || launch.nativeIdKind !== expectedKind) {
      throw runtimeError('provider_mismatch');
    }
    return launch;
  }
  function normalizeTransitionForAdapter(value) {
    if (!isRecord(value)) return null;
    const claims = normalizeImmutableClaims(value.immutableExecutionClaims);
    return claims ? { immutableExecutionClaims: claims } : null;
  }

  return Object.freeze({
    observe(identity, metadata) {
      try { requireProviderIdentity(identity); }
      catch { return { ok: false, status: 'mismatch', observationId: null }; }
      return registry.observe(identity, metadata);
    },
    adoptExecution(launchRef, claims) {
      requireProviderClaims(claims);
      return authority.adoptExecution(launchRef, claims);
    },
    openConnection(scope, connectionId, evidence) {
      const normalized = normalizeScope(scope);
      if (!normalized || normalized.provider !== provider || normalized.nativeIdKind !== expectedKind) {
        throw runtimeError('provider_mismatch');
      }
      const opened = authority.openConnection(scope, connectionId, evidence);
      claimAdapterHandle(opened.connectionHandle, CONNECTION_HANDLE_ADAPTER_OWNERS, adapterOwner, 'foreign_connection_handle');
      connectionHandles.add(opened.connectionHandle);
      return opened;
    },
    disconnect(connectionHandle) {
      if (!connectionHandles.has(connectionHandle)) return false;
      return authority.disconnect(connectionHandle);
    },
    attestActor(connectionHandle, claims, evidence) {
      if (!connectionHandles.has(connectionHandle)) throw runtimeError('foreign_connection_handle');
      const normalized = normalizeActorClaims(claims);
      if (!normalized || normalized.identity.provider !== provider || normalized.identity.nativeIdKind !== expectedKind ||
          (normalized.immutableExecutionClaims &&
           (normalized.immutableExecutionClaims.provider !== provider ||
            normalized.immutableExecutionClaims.nativeIdKind !== expectedKind))) throw runtimeError('provider_mismatch');
      const attested = authority.attestActor(connectionHandle, claims, evidence);
      claimAdapterHandle(attested.actorHandle, ACTOR_HANDLE_ADAPTER_OWNERS, adapterOwner, 'foreign_actor_handle');
      actorHandles.add(attested.actorHandle);
      return attested;
    },
    endActor(actorHandle) {
      if (!actorHandles.has(actorHandle)) throw runtimeError('foreign_actor_handle');
      return authority.endActor(actorHandle);
    },
    endContext(actorHandle) {
      if (!actorHandles.has(actorHandle)) throw runtimeError('foreign_actor_handle');
      if (typeof authority.endContext !== 'function') throw runtimeError('context_end_unavailable');
      return authority.endContext(actorHandle);
    },
    reconcileExecution(launchRef, input) {
      requireLaunch(launchRef);
      if (!isRecord(input) || !actorHandles.has(input.executionActorHandle)) throw runtimeError('foreign_actor_handle');
      const reconciled = authority.reconcileExecution(launchRef, input);
      return reconciled;
    },
    handoff(launchRef, transition, newOwnerActorHandle) {
      requireLaunch(launchRef);
      const normalized = normalizeTransitionForAdapter(transition);
      if (!normalized || normalized.immutableExecutionClaims.provider !== provider ||
          normalized.immutableExecutionClaims.nativeIdKind !== expectedKind) throw runtimeError('provider_mismatch');
      return authority.handoff(launchRef, transition, newOwnerActorHandle);
    },
    checkCurrentProof(launchRef, proofHandle) {
      const launch = registry.get(launchRef);
      if (!launch || launch.provider !== provider || launch.nativeIdKind !== expectedKind) {
        return { ok: false, reason: 'provider_mismatch' };
      }
      return registry.checkCurrentProof(launchRef, proofHandle);
    },
    get(launchRef) {
      const launch = registry.get(launchRef);
      if (!launch || launch.provider !== provider || launch.nativeIdKind !== expectedKind) return null;
      return launch;
    },
  });
}

module.exports = { createRuntimeBindingKernel, createProviderRuntimeAdapter };
