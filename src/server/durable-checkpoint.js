'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteJson } = require('./json-storage');

const CHECKPOINT_SCHEMA_VERSION = 1;
const DEFAULT_MAX_CHECKPOINT_BYTES = 1024 * 1024;
const DEFAULT_MAX_RECORDS = 50_000;
const MAX_CONFIGURABLE_CHECKPOINT_BYTES = 16 * 1024 * 1024;
const MAX_IDENTIFIER_LENGTH = 512;
const PROVIDER_NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });
const CHECKPOINT_WRITERS = new Map();

function checkpointError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, fields) {
  return isRecord(value) && Reflect.ownKeys(value).length === fields.length &&
    fields.every((field) => Object.hasOwn(value, field));
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function requireIdentifier(value, code = 'invalid_checkpoint') {
  if (!isIdentifier(value)) throw checkpointError(code);
  return value;
}

function normalizeIdentity(value) {
  const fields = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
  if (!hasExactKeys(value, fields) || !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, value.provider) ||
      value.nativeIdKind !== PROVIDER_NATIVE_ID_KINDS[value.provider] ||
      !isIdentifier(value.hostId) || !isIdentifier(value.homeScopeId) || !isIdentifier(value.nativeId)) {
    throw checkpointError('invalid_checkpoint_identity');
  }
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function normalizeActor(value) {
  if (!hasExactKeys(value, ['kind', 'id']) || !['agent', 'tool-use'].includes(value.kind) || !isIdentifier(value.id)) {
    throw checkpointError('invalid_checkpoint_binding');
  }
  return { kind: value.kind, id: value.id };
}

function normalizePeriodBinding(value) {
  if (value === null) return null;
  if (!hasExactKeys(value, ['periodId', 'actor']) || !isIdentifier(value.periodId)) {
    throw checkpointError('invalid_checkpoint_binding');
  }
  const actor = normalizeActor(value.actor);
  if (!actor) throw checkpointError('invalid_checkpoint_binding');
  return { periodId: value.periodId, actor };
}

function normalizeLaunchClaims(value) {
  const fields = [
    'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
    'origin', 'purpose', 'originBinding',
  ];
  if (!hasExactKeys(value, fields) || !isIdentifier(value.launchId) || !isIdentifier(value.runId) ||
      !isIdentifier(value.attemptId) || !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, value.provider) ||
      value.nativeIdKind !== PROVIDER_NATIVE_ID_KINDS[value.provider] ||
      !isIdentifier(value.hostId) || !isIdentifier(value.homeScopeId)) {
    throw checkpointError('invalid_checkpoint_claims');
  }
  const validPurpose = (value.origin === 'standalone' && ['agent', 'pr-creator'].includes(value.purpose)) ||
    (value.origin === 'delegated' && value.purpose === 'agent') ||
    (value.origin === 'review' && value.purpose === 'cross-review');
  if (!validPurpose || (value.origin === 'standalone' && value.originBinding !== null) ||
      (value.origin !== 'standalone' && value.originBinding === null)) {
    throw checkpointError('invalid_checkpoint_claims');
  }
  return {
    launchId: value.launchId,
    runId: value.runId,
    attemptId: value.attemptId,
    provider: value.provider,
    nativeIdKind: value.nativeIdKind,
    hostId: value.hostId,
    homeScopeId: value.homeScopeId,
    origin: value.origin,
    purpose: value.purpose,
    originBinding: normalizePeriodBinding(value.originBinding),
  };
}

function normalizeImmutableClaims(value) {
  if (!isRecord(value)) throw checkpointError('invalid_checkpoint_claims');
  const { identity, executionBinding, ...launchFields } = value;
  if (Reflect.ownKeys(value).length !== 12) throw checkpointError('invalid_checkpoint_claims');
  const claims = normalizeLaunchClaims(launchFields);
  const normalizedIdentity = normalizeIdentity(identity);
  const normalizedExecutionBinding = normalizePeriodBinding(executionBinding);
  if (!normalizedExecutionBinding || normalizedIdentity.provider !== claims.provider ||
      normalizedIdentity.nativeIdKind !== claims.nativeIdKind || normalizedIdentity.hostId !== claims.hostId ||
      normalizedIdentity.homeScopeId !== claims.homeScopeId) {
    throw checkpointError('invalid_checkpoint_claims');
  }
  return { ...claims, identity: normalizedIdentity, executionBinding: normalizedExecutionBinding };
}

function normalizeState(value, allowed, code = 'invalid_checkpoint_state') {
  if (!allowed.includes(value)) throw checkpointError(code);
  return value;
}

function normalizeCollection(value, maxRecords, normalizeItem) {
  if (!Array.isArray(value) || value.length > maxRecords) throw checkpointError('checkpoint_capacity');
  const fields = Reflect.ownKeys(value);
  if (fields.length !== value.length + 1 || fields.some((field) => field !== 'length' &&
      (!/^(0|[1-9][0-9]*)$/.test(String(field)) || Number(field) >= value.length))) {
    throw checkpointError('invalid_checkpoint_collection');
  }
  return value.map(normalizeItem);
}

function normalizeConversation(value) {
  if (!hasExactKeys(value, ['conversationId', 'identity']) || !isIdentifier(value.conversationId)) {
    throw checkpointError('invalid_checkpoint_conversation');
  }
  return { conversationId: value.conversationId, identity: normalizeIdentity(value.identity) };
}

function normalizeExecution(value) {
  const fields = ['conversationId', 'executionId', 'sessionId', 'state'];
  if (!hasExactKeys(value, fields) || !isIdentifier(value.conversationId) || !isIdentifier(value.executionId) ||
      !isIdentifier(value.sessionId)) throw checkpointError('invalid_checkpoint_execution');
  return {
    conversationId: value.conversationId,
    executionId: value.executionId,
    sessionId: value.sessionId,
    state: normalizeState(value.state, ['active', 'ended', 'unknown']),
  };
}

function normalizeLaunch(value) {
  const fields = ['launchRef', 'claims', 'state', 'identity', 'executionBinding', 'conversationId', 'sessionId'];
  if (!hasExactKeys(value, fields) || !isIdentifier(value.launchRef)) {
    throw checkpointError('invalid_checkpoint_launch');
  }
  const state = normalizeState(value.state, ['registered', 'bound', 'ended', 'unknown']);
  const claims = normalizeLaunchClaims(value.claims);
  const hasIdentity = value.identity !== null;
  const hasBinding = value.executionBinding !== null;
  const hasConversation = value.conversationId !== null;
  const hasSession = value.sessionId !== null;
  if (hasIdentity !== hasBinding || hasIdentity !== hasConversation || hasIdentity !== hasSession ||
      (state === 'registered' && hasIdentity) || (state === 'bound' && !hasIdentity)) {
    throw checkpointError('invalid_checkpoint_launch');
  }
  if (!hasIdentity) {
    return { launchRef: value.launchRef, claims, state, identity: null, executionBinding: null,
      conversationId: null, sessionId: null };
  }
  const identity = normalizeIdentity(value.identity);
  const executionBinding = normalizePeriodBinding(value.executionBinding);
  if (!executionBinding || identity.provider !== claims.provider || identity.nativeIdKind !== claims.nativeIdKind ||
      identity.hostId !== claims.hostId || identity.homeScopeId !== claims.homeScopeId ||
      !isIdentifier(value.conversationId) || !isIdentifier(value.sessionId)) {
    throw checkpointError('invalid_checkpoint_launch');
  }
  return { launchRef: value.launchRef, claims, state, identity, executionBinding,
    conversationId: value.conversationId, sessionId: value.sessionId };
}

function normalizeScope(value) {
  const fields = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'connectionSlotId'];
  if (!hasExactKeys(value, fields) || !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, value.provider) ||
      value.nativeIdKind !== PROVIDER_NATIVE_ID_KINDS[value.provider] || !isIdentifier(value.hostId) ||
      !isIdentifier(value.homeScopeId) || !isIdentifier(value.connectionSlotId)) {
    throw checkpointError('invalid_checkpoint_scope');
  }
  return Object.fromEntries(fields.map((field) => [field, value[field]]));
}

function normalizeConnection(value) {
  if (!hasExactKeys(value, ['scope', 'generation', 'state']) || !Number.isSafeInteger(value.generation) ||
      value.generation < 1) throw checkpointError('invalid_checkpoint_connection');
  return { scope: normalizeScope(value.scope), generation: value.generation,
    state: normalizeState(value.state, ['active', 'ended', 'unknown', 'inactive']) };
}

function normalizeActorRecord(value) {
  const fields = ['identity', 'periodId', 'actor', 'contextId', 'launchRef', 'immutableExecutionClaims',
    'connectionScope', 'connectionGeneration', 'state'];
  if (!hasExactKeys(value, fields) || !isIdentifier(value.periodId) || !isIdentifier(value.contextId) ||
      !(value.launchRef === null || isIdentifier(value.launchRef)) || !Number.isSafeInteger(value.connectionGeneration) ||
      value.connectionGeneration < 1) throw checkpointError('invalid_checkpoint_actor');
  const identity = normalizeIdentity(value.identity);
  const actor = normalizeActor(value.actor);
  const claims = value.immutableExecutionClaims === null ? null : normalizeImmutableClaims(value.immutableExecutionClaims);
  if ((value.launchRef === null) !== (claims === null) ||
      (claims && (JSON.stringify(claims.identity) !== JSON.stringify(identity) ||
        claims.executionBinding.periodId !== value.periodId ||
        claims.executionBinding.actor.kind !== actor.kind || claims.executionBinding.actor.id !== actor.id))) {
    throw checkpointError('invalid_checkpoint_actor');
  }
  const scope = normalizeScope(value.connectionScope);
  if (scope.provider !== identity.provider || scope.nativeIdKind !== identity.nativeIdKind ||
      scope.hostId !== identity.hostId || scope.homeScopeId !== identity.homeScopeId) {
    throw checkpointError('invalid_checkpoint_actor');
  }
  return { identity, periodId: value.periodId, actor, contextId: value.contextId,
    launchRef: value.launchRef, immutableExecutionClaims: claims, connectionScope: scope,
    connectionGeneration: value.connectionGeneration,
    state: normalizeState(value.state, ['active', 'ended', 'unknown']) };
}

function normalizeHandoff(value) {
  if (!hasExactKeys(value, ['handoffId', 'owner', 'ownerGeneration', 'status']) ||
      !isIdentifier(value.handoffId) || !Number.isSafeInteger(value.ownerGeneration) || value.ownerGeneration < 1 ||
      value.status !== 'accepted') throw checkpointError('invalid_checkpoint_handoff');
  const owner = normalizePeriodBinding(value.owner);
  if (!owner) throw checkpointError('invalid_checkpoint_handoff');
  return { handoffId: value.handoffId, owner,
    ownerGeneration: value.ownerGeneration, status: value.status };
}

function boundedRecordLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_RECORDS) {
    throw checkpointError('invalid_checkpoint_limits');
  }
  return value;
}

function normalizeRegistrations(value, maxRecords) {
  maxRecords = boundedRecordLimit(maxRecords);
  const fields = ['conversations', 'executions', 'launches', 'runtimeLaunches', 'connections', 'actors', 'handoffs'];
  if (!hasExactKeys(value, fields)) throw checkpointError('invalid_checkpoint_registrations');
  const registrations = {
    conversations: normalizeCollection(value.conversations, maxRecords, normalizeConversation),
    executions: normalizeCollection(value.executions, maxRecords, normalizeExecution),
    launches: normalizeCollection(value.launches, maxRecords, normalizeLaunch),
    runtimeLaunches: normalizeCollection(value.runtimeLaunches, maxRecords, normalizeRuntimeLaunch),
    connections: normalizeCollection(value.connections, maxRecords, normalizeConnection),
    actors: normalizeCollection(value.actors, maxRecords, normalizeActorRecord),
    handoffs: normalizeCollection(value.handoffs, maxRecords, normalizeHandoff),
  };
  validateRegistrationReferences(registrations, maxRecords);
  return registrations;
}

function normalizeRuntimeLaunch(value) {
  const fields = ['launchRef', 'claims', 'state', 'conversationId', 'sessionId', 'currentOwner', 'ownerGeneration'];
  if (!hasExactKeys(value, fields) || !isIdentifier(value.launchRef) ||
      !(value.conversationId === null || isIdentifier(value.conversationId)) ||
      !(value.sessionId === null || isIdentifier(value.sessionId)) ||
      !Number.isSafeInteger(value.ownerGeneration) || value.ownerGeneration < 0) {
    throw checkpointError('invalid_checkpoint_runtime_launch');
  }
  const claims = normalizeImmutableClaims(value.claims);
  const state = normalizeState(value.state, ['bound', 'ended', 'unknown']);
  const currentOwner = normalizePeriodBinding(value.currentOwner);
  if (!currentOwner || value.conversationId === null || value.sessionId === null) {
    throw checkpointError('invalid_checkpoint_runtime_launch');
  }
  return { launchRef: value.launchRef, claims, state, conversationId: value.conversationId,
    sessionId: value.sessionId, currentOwner, ownerGeneration: value.ownerGeneration };
}

function validateRegistrationReferences(registrations, maxRecords) {
  const conversations = uniqueIndex(registrations.conversations, (item) => item.conversationId,
    'duplicate_checkpoint_conversation');
  const identities = uniqueIndex(registrations.conversations, (item) => JSON.stringify(item.identity),
    'duplicate_checkpoint_identity');
  const executions = uniqueIndex(registrations.executions, (item) => item.executionId,
    'duplicate_checkpoint_execution');
  const sessions = new Set();
  for (const execution of registrations.executions) {
    const conversation = conversations.get(execution.conversationId);
    if (!conversation) throw checkpointError('dangling_checkpoint_execution');
    const identity = identities.get(JSON.stringify(conversation.identity));
    if (!identity) throw checkpointError('invalid_checkpoint_identity');
    if (sessions.has(execution.sessionId)) throw checkpointError('duplicate_checkpoint_session');
    sessions.add(execution.sessionId);
  }
  const launchRefs = uniqueIndex(registrations.launches, (item) => item.launchRef, 'duplicate_checkpoint_launch_ref');
  uniqueIndex(registrations.launches,
    (item) => JSON.stringify([item.claims.launchId, item.claims.runId, item.claims.attemptId]),
    'duplicate_checkpoint_launch_attempt');
  for (const launch of registrations.launches) {
    if (launch.claims.originBinding && !executions.has(launch.claims.originBinding.periodId)) {
      throw checkpointError('dangling_checkpoint_origin');
    }
    if (!launch.identity) continue;
    const period = executions.get(launch.executionBinding.periodId);
    const conversation = conversations.get(launch.conversationId);
    if (!period || !conversation || period.conversationId !== launch.conversationId ||
        period.sessionId !== launch.sessionId || JSON.stringify(conversation.identity) !== JSON.stringify(launch.identity)) {
      throw checkpointError('dangling_checkpoint_launch_binding');
    }
  }
  const runtimeLaunchRefs = uniqueIndex(registrations.runtimeLaunches, (item) => item.launchRef,
    'duplicate_checkpoint_runtime_launch');
  uniqueIndex(registrations.runtimeLaunches,
    (item) => JSON.stringify([item.claims.launchId, item.claims.runId, item.claims.attemptId]),
    'duplicate_checkpoint_runtime_attempt');
  for (const runtimeLaunch of registrations.runtimeLaunches) {
    const launch = launchRefs.get(runtimeLaunch.launchRef);
    const period = executions.get(runtimeLaunch.claims.executionBinding.periodId);
    if (!launch || !period || launch.state === 'registered' || !launch.identity ||
        JSON.stringify(launch.claims) !== JSON.stringify((({ identity, executionBinding, ...claims }) => claims)(runtimeLaunch.claims)) ||
        JSON.stringify(launch.identity) !== JSON.stringify(runtimeLaunch.claims.identity) ||
        JSON.stringify(launch.executionBinding) !== JSON.stringify(runtimeLaunch.claims.executionBinding) ||
        period.conversationId !== runtimeLaunch.conversationId || period.sessionId !== runtimeLaunch.sessionId ||
        launch.conversationId !== runtimeLaunch.conversationId || launch.sessionId !== runtimeLaunch.sessionId) {
      throw checkpointError('checkpoint_runtime_launch_mismatch');
    }
    if (!executions.has(runtimeLaunch.currentOwner.periodId)) {
      throw checkpointError('dangling_checkpoint_runtime_owner');
    }
    const ownerPeriod = executions.get(runtimeLaunch.currentOwner.periodId);
    if (!conversations.has(ownerPeriod.conversationId)) throw checkpointError('checkpoint_runtime_owner_mismatch');
  }
  uniqueIndex(registrations.connections,
    (item) => JSON.stringify([item.scope.provider, item.scope.nativeIdKind, item.scope.hostId,
      item.scope.homeScopeId, item.scope.connectionSlotId, item.generation]),
    'duplicate_checkpoint_connection');
  const connectionByScopeGeneration = new Map(registrations.connections.map((item) => [
    JSON.stringify([item.scope, item.generation]), item,
  ]));
  const activeConnectionBySlot = new Set();
  const generationsBySlot = new Map();
  for (const connection of registrations.connections) {
    const slot = JSON.stringify([connection.scope.provider, connection.scope.nativeIdKind, connection.scope.hostId,
      connection.scope.homeScopeId, connection.scope.connectionSlotId]);
    const generations = generationsBySlot.get(slot) || new Set();
    generations.add(connection.generation);
    generationsBySlot.set(slot, generations);
    if (connection.state !== 'active') continue;
    if (activeConnectionBySlot.has(slot)) throw checkpointError('duplicate_active_checkpoint_connection');
    activeConnectionBySlot.add(slot);
  }
  for (const generations of generationsBySlot.values()) {
    const ordered = [...generations].sort((left, right) => left - right);
    if (ordered.length !== ordered[ordered.length - 1] ||
        ordered.some((generation, index) => generation !== index + 1)) {
      throw checkpointError('checkpoint_connection_generation_gap');
    }
  }
  uniqueIndex(registrations.actors,
    (item) => JSON.stringify([item.identity, item.periodId, item.actor, item.contextId, item.launchRef,
      item.connectionScope, item.connectionGeneration]), 'duplicate_checkpoint_actor');
  const actorContexts = new Map();
  const endedActors = new Set();
  const activeActors = new Set();
  for (const actor of registrations.actors) {
    const contextKey = JSON.stringify([actor.connectionScope, actor.connectionGeneration,
      actor.identity, actor.contextId]);
    const assignment = JSON.stringify([actor.periodId, actor.actor, actor.launchRef, actor.immutableExecutionClaims]);
    const previousAssignment = actorContexts.get(contextKey);
    if (previousAssignment && previousAssignment !== assignment) {
      throw checkpointError('checkpoint_actor_context_reassigned');
    }
    actorContexts.set(contextKey, assignment);
    const actorKey = JSON.stringify([actor.identity, actor.periodId, actor.actor]);
    if (actor.state === 'ended') endedActors.add(actorKey);
    if (actor.state === 'active') activeActors.add(actorKey);
  }
  for (const key of endedActors) {
    if (activeActors.has(key)) throw checkpointError('checkpoint_actor_reopened');
  }
  for (const actor of registrations.actors) {
    const period = executions.get(actor.periodId);
    const connection = connectionByScopeGeneration.get(JSON.stringify([actor.connectionScope, actor.connectionGeneration]));
    if (!period || !connection || !conversations.get(period.conversationId) ||
        JSON.stringify(conversations.get(period.conversationId).identity) !== JSON.stringify(actor.identity) ||
        (actor.state === 'active' && (connection.state !== 'active' || period.state !== 'active')) ||
        (period.state === 'ended' && actor.state !== 'ended')) {
      throw checkpointError('dangling_checkpoint_actor');
    }
    if (actor.launchRef) {
      const launch = runtimeLaunchRefs.get(actor.launchRef);
      if (!launch || JSON.stringify(launch.claims) !== JSON.stringify(actor.immutableExecutionClaims) ||
          JSON.stringify(launch.claims.identity) !== JSON.stringify(actor.identity) ||
          launch.claims.executionBinding.periodId !== actor.periodId ||
          JSON.stringify(launch.claims.executionBinding.actor) !== JSON.stringify(actor.actor)) {
        throw checkpointError('dangling_checkpoint_actor_launch');
      }
    }
  }

  uniqueIndex(registrations.handoffs, (item) => item.handoffId, 'duplicate_checkpoint_handoff');
  for (const handoff of registrations.handoffs) {
    if (!executions.has(handoff.owner.periodId)) throw checkpointError('dangling_checkpoint_handoff_owner');
  }
  const totalRecords = Object.values(registrations).reduce((total, items) => total + items.length, 0);
  if (totalRecords > maxRecords) throw checkpointError('checkpoint_capacity');
}

function uniqueIndex(items, keyOf, code) {
  const index = new Map();
  for (const item of items) {
    const key = keyOf(item);
    if (index.has(key)) throw checkpointError(code);
    index.set(key, item);
  }
  return index;
}

function makeEmptyRegistrations() {
  return { conversations: [], executions: [], launches: [], runtimeLaunches: [], connections: [], actors: [], handoffs: [] };
}

function mergeRegistrationHistory(previous, incoming, maxRecords = DEFAULT_MAX_RECORDS) {
  maxRecords = boundedRecordLimit(maxRecords);
  const prior = normalizeRegistrations(previous, maxRecords);
  const next = normalizeRegistrations(incoming, maxRecords);
  const merged = {
    conversations: mergeImmutable(prior.conversations, next.conversations, (item) => item.conversationId,
      'checkpoint_conversation_changed'),
    executions: mergeExecutions(prior.executions, next.executions),
    launches: mergeLaunches(prior.launches, next.launches),
    runtimeLaunches: mergeRuntimeLaunches(prior.runtimeLaunches, next.runtimeLaunches),
    connections: mergeConnections(prior.connections, next.connections),
    actors: mergeActors(prior.actors, next.actors),
    handoffs: mergeImmutable(prior.handoffs, next.handoffs, (item) => item.handoffId,
      'checkpoint_handoff_changed'),
  };
  validateRegistrationReferences(merged, maxRecords);
  return merged;
}

function mergeImmutable(prior, next, idOf, errorCode) {
  const values = new Map(prior.map((item) => [idOf(item), item]));
  for (const item of next) {
    const id = idOf(item);
    const old = values.get(id);
    if (old && JSON.stringify(old) !== JSON.stringify(item)) throw checkpointError(errorCode);
    if (!old) values.set(id, item);
  }
  return [...values.values()];
}

function mergeExecutions(prior, next) {
  const values = new Map(prior.map((item) => [item.executionId, item]));
  for (const item of next) {
    const old = values.get(item.executionId);
    if (!old) { values.set(item.executionId, item); continue; }
    const stableOld = { ...old, state: null };
    const stableNew = { ...item, state: null };
    if (JSON.stringify(stableOld) !== JSON.stringify(stableNew) ||
        (old.state === 'ended' && item.state !== 'ended')) throw checkpointError('checkpoint_execution_changed');
    values.set(item.executionId, { ...item, state: old.state === 'ended' ? 'ended' : item.state });
  }
  return [...values.values()];
}

function mergeLaunches(prior, next) {
  const values = new Map(prior.map((item) => [item.launchRef, item]));
  const attempts = new Map(prior.map((item) => [JSON.stringify([item.claims.launchId, item.claims.runId, item.claims.attemptId]), item]));
  for (const item of next) {
    const attemptKey = JSON.stringify([item.claims.launchId, item.claims.runId, item.claims.attemptId]);
    const priorAttempt = attempts.get(attemptKey);
    if (priorAttempt && priorAttempt.launchRef !== item.launchRef) throw checkpointError('checkpoint_launch_attempt_changed');
    const old = values.get(item.launchRef);
    if (!old) { values.set(item.launchRef, item); attempts.set(attemptKey, item); continue; }
    if (JSON.stringify(old.claims) !== JSON.stringify(item.claims) ||
        (old.state === 'ended' && item.state !== 'ended') ||
        (old.identity && !item.identity) ||
        (old.identity && JSON.stringify(old.identity) !== JSON.stringify(item.identity)) ||
        (old.executionBinding && JSON.stringify(old.executionBinding) !== JSON.stringify(item.executionBinding)) ||
        (old.conversationId && old.conversationId !== item.conversationId) ||
        (old.sessionId && old.sessionId !== item.sessionId)) throw checkpointError('checkpoint_launch_changed');
    const bound = old.identity ? old : item;
    values.set(item.launchRef, { ...bound, state: old.state === 'ended' ? 'ended' : item.state });
  }
  return [...values.values()];
}

function mergeRuntimeLaunches(prior, next) {
  const values = new Map(prior.map((item) => [item.launchRef, item]));
  for (const item of next) {
    const old = values.get(item.launchRef);
    if (!old) { values.set(item.launchRef, item); continue; }
    const stableOld = { ...old, state: null, currentOwner: null, ownerGeneration: null };
    const stableNew = { ...item, state: null, currentOwner: null, ownerGeneration: null };
    if (JSON.stringify(stableOld) !== JSON.stringify(stableNew) ||
        (old.state === 'ended' && item.state !== 'ended') ||
        item.ownerGeneration < old.ownerGeneration ||
        (item.ownerGeneration === old.ownerGeneration && JSON.stringify(item.currentOwner) !== JSON.stringify(old.currentOwner)) ||
        (item.ownerGeneration > old.ownerGeneration && item.ownerGeneration !== old.ownerGeneration + 1)) {
      throw checkpointError('checkpoint_runtime_launch_changed');
    }
    values.set(item.launchRef, { ...item, state: old.state === 'ended' ? 'ended' : item.state });
  }
  return [...values.values()];
}

function mergeConnections(prior, next) {
  const values = new Map(prior.map((item) => [JSON.stringify([item.scope, item.generation]), item]));
  for (const item of next) {
    const key = JSON.stringify([item.scope, item.generation]);
    const old = values.get(key);
    if (!old) { values.set(key, item); continue; }
    if (JSON.stringify(old.scope) !== JSON.stringify(item.scope) ||
        (old.state === 'ended' && item.state !== 'ended') ||
        ((old.state === 'inactive' || old.state === 'ended') && item.state === 'active')) {
      throw checkpointError('checkpoint_connection_reopened');
    }
    values.set(key, { ...item, state: old.state === 'ended' ? 'ended' : item.state });
  }
  const bySlot = new Map();
  for (const connection of values.values()) {
    const slot = JSON.stringify([connection.scope.provider, connection.scope.nativeIdKind, connection.scope.hostId,
      connection.scope.homeScopeId, connection.scope.connectionSlotId]);
    const generations = bySlot.get(slot) || new Set();
    generations.add(connection.generation);
    bySlot.set(slot, generations);
  }
  for (const generations of bySlot.values()) {
    const ordered = [...generations].sort((left, right) => left - right);
    if (ordered.length !== ordered[ordered.length - 1] ||
        ordered.some((generation, index) => generation !== index + 1)) {
      throw checkpointError('checkpoint_connection_generation_gap');
    }
  }
  return [...values.values()];
}

function mergeActors(prior, next) {
  const idOf = (item) => JSON.stringify([item.identity, item.periodId, item.actor, item.contextId, item.launchRef,
    item.connectionScope, item.connectionGeneration]);
  const values = new Map(prior.map((item) => [idOf(item), item]));
  for (const item of next) {
    const key = idOf(item);
    const old = values.get(key);
    if (!old) { values.set(key, item); continue; }
    if (old.state === 'ended' && item.state !== 'ended') throw checkpointError('checkpoint_actor_reopened');
    values.set(key, { ...item, state: old.state === 'ended' ? 'ended' : item.state });
  }
  return [...values.values()];
}

function restoreCheckpoint(checkpoint) {
  const restored = structuredClone(checkpoint);
  restored.registrations.executions = restored.registrations.executions.map((item) => ({
    ...item, state: item.state === 'ended' ? 'ended' : 'unknown',
  }));
  restored.registrations.launches = restored.registrations.launches.map((item) => ({
    ...item, state: item.state === 'ended' ? 'ended' : 'unknown',
  }));
  restored.registrations.runtimeLaunches = restored.registrations.runtimeLaunches.map((item) => ({
    ...item, state: item.state === 'ended' ? 'ended' : 'unknown',
  }));
  restored.registrations.connections = restored.registrations.connections.map((item) => ({ ...item, state: 'inactive' }));
  restored.registrations.actors = restored.registrations.actors.map((item) => ({
    ...item, state: item.state === 'ended' ? 'ended' : 'unknown',
  }));
  const { recoverLedger } = require('./delivery-ledger');
  restored.ledger = recoverLedger(restored.ledger);
  return restored;
}

function checkpointLaunchProjection(launch) {
  return {
    launchRef: launch.launchRef,
    claims: launch.claims,
    identity: launch.identity,
    executionBinding: launch.executionBinding,
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
  };
}

function validateLedgerRegistrationReferences(ledger, registrations) {
  const launches = new Map(registrations.launches.map((item) => [item.launchRef, item]));
  const runtimeLaunches = new Map(registrations.runtimeLaunches.map((item) => [item.launchRef, item]));
  const executions = new Map(registrations.executions.map((item) => [item.executionId, item]));
  const conversations = new Map(registrations.conversations.map((item) => [item.conversationId, item]));
  const actorExists = (identity, binding) => registrations.actors.some((actor) =>
    actor.periodId === binding.periodId && actor.actor.kind === binding.actor.kind &&
    actor.actor.id === binding.actor.id && JSON.stringify(actor.identity) === JSON.stringify(identity));
  const requireBoundLaunch = (projection, code) => {
    const launch = launches.get(projection.launchRef);
    if (!launch || !launch.identity || launch.state === 'registered' ||
        JSON.stringify(checkpointLaunchProjection(launch)) !== JSON.stringify(projection)) {
      throw checkpointError(code);
    }
    return launch;
  };
  for (const target of ledger.notificationTargets) {
    requireBoundLaunch(target.launch, 'checkpoint_ledger_target_mismatch');
  }
  for (const delivery of ledger.deliveries) {
    const sourceLaunch = requireBoundLaunch(delivery.source, 'checkpoint_ledger_source_mismatch');
    const sourcePeriod = executions.get(delivery.sourceExecutionId);
    if (delivery.sourceExecutionId !== delivery.source.executionBinding.periodId || !sourcePeriod ||
        sourcePeriod.conversationId !== delivery.source.conversationId ||
        sourcePeriod.sessionId !== delivery.source.sessionId ||
        JSON.stringify(conversations.get(delivery.source.conversationId)?.identity) !==
          JSON.stringify(delivery.source.identity)) {
      throw checkpointError('checkpoint_ledger_source_binding_mismatch');
    }
    const runtimeSource = runtimeLaunches.get(sourceLaunch.launchRef);
    if (runtimeSource && JSON.stringify(runtimeSource.claims) !== JSON.stringify({
      ...sourceLaunch.claims,
      identity: sourceLaunch.identity,
      executionBinding: sourceLaunch.executionBinding,
    })) throw checkpointError('checkpoint_ledger_source_runtime_mismatch');
    if (['question', 'instruction'].includes(delivery.kind) && !runtimeSource) {
      throw checkpointError('checkpoint_ledger_source_runtime_missing');
    }
    if (delivery.kind === 'result') {
      const targetPeriod = executions.get(delivery.target.periodId);
      if (!runtimeSource || delivery.target.kind !== 'owner' ||
          delivery.ownerGeneration > runtimeSource.ownerGeneration || !targetPeriod ||
          (delivery.ownerGeneration === runtimeSource.ownerGeneration &&
           (delivery.target.periodId !== runtimeSource.currentOwner.periodId ||
            JSON.stringify(delivery.target.actor) !== JSON.stringify(runtimeSource.currentOwner.actor))) ||
          targetPeriod.conversationId !== delivery.target.conversationId ||
          targetPeriod.sessionId !== delivery.target.sessionId ||
          JSON.stringify(conversations.get(delivery.target.conversationId)?.identity) !==
            JSON.stringify(delivery.target.identity) || !actorExists(delivery.target.identity, delivery.target) ||
          !sourceLaunch.identity) {
        throw checkpointError('checkpoint_ledger_owner_mismatch');
      }
      continue;
    }
    if (delivery.target.kind !== 'execution') throw checkpointError('checkpoint_ledger_target_mismatch');
    const targetLaunch = requireBoundLaunch({
      launchRef: delivery.target.launchRef,
      claims: delivery.target.claims,
      identity: delivery.target.identity,
      executionBinding: { periodId: delivery.target.periodId, actor: delivery.target.actor },
      conversationId: delivery.target.conversationId,
      sessionId: delivery.target.sessionId,
    }, 'checkpoint_ledger_target_mismatch');
    const targetPeriod = executions.get(delivery.target.periodId);
    if (!targetPeriod || targetPeriod.conversationId !== delivery.target.conversationId ||
        targetPeriod.sessionId !== delivery.target.sessionId ||
        JSON.stringify(conversations.get(delivery.target.conversationId)?.identity) !==
          JSON.stringify(delivery.target.identity)) {
      throw checkpointError('checkpoint_ledger_target_binding_mismatch');
    }
    if (['question', 'instruction'].includes(delivery.kind) &&
        (targetLaunch.launchRef !== sourceLaunch.launchRef ||
         JSON.stringify(delivery.target.claims) !== JSON.stringify(delivery.source.claims) ||
         delivery.target.periodId !== delivery.source.executionBinding.periodId ||
         JSON.stringify(delivery.target.actor) !== JSON.stringify(delivery.source.executionBinding.actor))) {
      throw checkpointError(delivery.kind === 'instruction'
        ? 'checkpoint_ledger_instruction_target_mismatch'
        : 'checkpoint_ledger_question_target_mismatch');
    }
    if (delivery.kind === 'pr-notification' &&
        !ledger.notificationTargets.some((item) => item.launch.launchRef === targetLaunch.launchRef &&
          JSON.stringify(item.launch) === JSON.stringify(checkpointLaunchProjection(targetLaunch)))) {
      throw checkpointError('checkpoint_ledger_target_mismatch');
    }
  }
}

function normalizeCheckpoint(value, options = {}) {
  const maxRecords = boundedRecordLimit(options.maxRecords ?? DEFAULT_MAX_RECORDS);
  const fields = ['schemaVersion', 'revision', 'registrations', 'ledger'];
  if (!hasExactKeys(value, fields) || value.schemaVersion !== CHECKPOINT_SCHEMA_VERSION ||
      !Number.isSafeInteger(value.revision) || value.revision < 0) {
    throw checkpointError('invalid_checkpoint_version');
  }
  const registrations = normalizeRegistrations(value.registrations, maxRecords);
  const { validateLedger } = require('./delivery-ledger');
  const ledger = validateLedger(value.ledger);
  validateLedgerRegistrationReferences(ledger, registrations);
  const checkpoint = { schemaVersion: CHECKPOINT_SCHEMA_VERSION, revision: value.revision, registrations, ledger };
  return options.restore ? restoreCheckpoint(checkpoint) : checkpoint;
}
function makeEmptyCheckpoint() {
  const { createEmptyLedger } = require('./delivery-ledger');
  return { schemaVersion: CHECKPOINT_SCHEMA_VERSION, revision: 0, registrations: makeEmptyRegistrations(),
    ledger: createEmptyLedger() };
}

function projectRegistrationSnapshots(registrationSnapshot, launchSnapshot, runtimeSnapshot, options = {}) {
  const maxRecords = boundedRecordLimit(options.maxRecords ?? DEFAULT_MAX_RECORDS);
  if (!isRecord(registrationSnapshot) || !Array.isArray(registrationSnapshot.conversations) ||
      !Array.isArray(registrationSnapshot.executions) || !isRecord(launchSnapshot) ||
      !Array.isArray(launchSnapshot.launches) || !isRecord(runtimeSnapshot) ||
      !Array.isArray(runtimeSnapshot.launches) || !Array.isArray(runtimeSnapshot.connections) ||
      !Array.isArray(runtimeSnapshot.actors) || !Array.isArray(runtimeSnapshot.handoffs)) {
    throw checkpointError('registry_snapshot_unavailable');
  }
  const snapshotCollections = [registrationSnapshot.conversations, registrationSnapshot.executions,
    launchSnapshot.launches, runtimeSnapshot.launches, runtimeSnapshot.connections,
    runtimeSnapshot.actors, runtimeSnapshot.handoffs];
  let snapshotCount = 0;
  for (const collection of snapshotCollections) {
    if (collection.length > maxRecords) throw checkpointError('checkpoint_capacity');
    const keys = Reflect.ownKeys(collection);
    if (keys.length !== collection.length + 1 || keys.some((key) => key !== 'length' &&
        (!/^(0|[1-9][0-9]*)$/.test(String(key)) || Number(key) >= collection.length))) {
      throw checkpointError('invalid_checkpoint_collection');
    }
    snapshotCount += collection.length;
  }
  if (snapshotCount > maxRecords) throw checkpointError('checkpoint_capacity');
  const conversations = registrationSnapshot.conversations.map((value) => normalizeConversation({
    conversationId: value.conversationId,
    identity: value.identity,
  }));
  const executions = registrationSnapshot.executions.map((value) => normalizeExecution({
    conversationId: value.conversationId,
    executionId: value.executionId,
    sessionId: value.sessionId,
    state: value.state,
  }));
  const launches = launchSnapshot.launches.map((value) => normalizeLaunch({
    launchRef: value.launchRef,
    claims: Object.fromEntries(['launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
      'origin', 'purpose', 'originBinding'].map((field) => [field, value[field]])),
    state: value.state,
    identity: value.identity ?? null,
    executionBinding: value.executionBinding ?? null,
    conversationId: value.conversationId ?? null,
    sessionId: value.sessionId ?? null,
  }));
  const runtimeLaunches = runtimeSnapshot.launches.map((value) => normalizeRuntimeLaunch({
    launchRef: value.launchRef,
    claims: Object.fromEntries(['launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
      'origin', 'purpose', 'originBinding', 'identity', 'executionBinding'].map((field) => [field, value[field]])),
    state: value.state,
    conversationId: value.conversationId,
    sessionId: value.sessionId,
    currentOwner: value.currentOwner,
    ownerGeneration: value.ownerGeneration,
  }));
  const connectionsById = new Map();
  const connections = runtimeSnapshot.connections.map((value) => {
    const connection = normalizeConnection({ scope: value.scope, generation: value.generation, state: value.state });
    if (typeof value.connectionId === 'string') {
      if (connectionsById.has(value.connectionId)) throw checkpointError('duplicate_runtime_connection_id');
      connectionsById.set(value.connectionId, connection);
    }
    return connection;
  });
  const actors = runtimeSnapshot.actors.map((value) => {
    const connection = connectionsById.get(value.connectionId);
    if (!connection || connection.generation !== value.connectionGeneration) throw checkpointError('dangling_runtime_actor');
    const runtimeLaunch = value.launchRef === null ? null : runtimeLaunches.find((item) => item.launchRef === value.launchRef);
    if (value.launchRef !== null && !runtimeLaunch) throw checkpointError('dangling_runtime_actor_launch');
    return normalizeActorRecord({
      identity: value.identity,
      periodId: value.periodId,
      actor: value.actor,
      contextId: value.contextId,
      launchRef: value.launchRef,
      immutableExecutionClaims: runtimeLaunch?.claims || null,
      connectionScope: connection.scope,
      connectionGeneration: value.connectionGeneration,
      state: value.state,
    });
  });
  const handoffs = runtimeSnapshot.handoffs.map((value) => normalizeHandoff({
    handoffId: value.handoffId, owner: value.owner, ownerGeneration: value.ownerGeneration, status: value.status,
  }));
  const registrations = { conversations, executions, launches, runtimeLaunches, connections, actors, handoffs };
  validateRegistrationReferences(registrations, maxRecords);
  return registrations;
}

function checkpointPath(filePath) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath) || path.resolve(filePath) !== filePath ||
      path.basename(filePath) === '' || path.basename(filePath) === '.' || path.basename(filePath) === '..') {
    throw checkpointError('invalid_checkpoint_path');
  }
  return filePath;
}

function pathKey(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function createDurableCheckpointStore(options = {}) {
  const filePath = checkpointPath(options.filePath);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_CHECKPOINT_BYTES;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CONFIGURABLE_CHECKPOINT_BYTES ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > DEFAULT_MAX_RECORDS) {
    throw checkpointError('invalid_checkpoint_limits');
  }
  const key = pathKey(filePath);
  if (CHECKPOINT_WRITERS.has(key)) throw checkpointError('checkpoint_path_in_use');
  const owner = Object.freeze({});
  CHECKPOINT_WRITERS.set(key, owner);
  const fileSystem = options.fileSystem || fs;
  const atomicWrite = options.atomicWrite || ((targetPath, value) => atomicWriteJson(
    path.dirname(targetPath), path.basename(targetPath), value));
  if (typeof atomicWrite !== 'function') {
    CHECKPOINT_WRITERS.delete(key);
    throw checkpointError('invalid_checkpoint_writer');
  }
  let accepting = true;
  let closed = false;
  let writeBlocked = false;
  let hasLoaded = false;
  let lastCommittedRevision = -1;
  let tail = Promise.resolve();
  let closePromise = null;

  function enqueue(operation) {
    if (!accepting) return Promise.reject(checkpointError('checkpoint_store_closed'));
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function loadNow() {
    if (closed) throw checkpointError('checkpoint_store_closed');
    let handle;
    try {
      const linkStat = await fileSystem.lstat(filePath);
      if (linkStat.isSymbolicLink() || !linkStat.isFile()) throw checkpointError('invalid_checkpoint_file');
      handle = await fileSystem.open(filePath, 'r');
      const fileStat = await handle.stat();
      if (!fileStat.isFile() || fileStat.size > maxBytes) throw checkpointError('checkpoint_too_large');
      const boundedBytes = Buffer.allocUnsafe(maxBytes + 1);
      let bytesRead = 0;
      while (bytesRead < boundedBytes.length) {
        const result = await handle.read(boundedBytes, bytesRead, boundedBytes.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > maxBytes) throw checkpointError('checkpoint_too_large');
      let parsed;
      try { parsed = JSON.parse(boundedBytes.subarray(0, bytesRead).toString('utf8')); }
      catch { throw checkpointError('invalid_checkpoint_json'); }
      const normalized = normalizeCheckpoint(parsed, { maxRecords });
      if (normalized.revision < lastCommittedRevision) throw checkpointError('checkpoint_revision_regressed');
      lastCommittedRevision = normalized.revision;
      hasLoaded = true;
      return restoreCheckpoint(normalized);
    } catch (error) {
      if (error.code === 'ENOENT' && lastCommittedRevision < 0) {
        hasLoaded = true;
        return makeEmptyCheckpoint();
      }
      if (error.code === 'ENOENT') throw checkpointError('checkpoint_missing_after_commit');
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  function load() {
    return enqueue(loadNow);
  }

  function save(checkpoint) {
    if (!accepting) return Promise.reject(checkpointError('checkpoint_store_closed'));
    let normalized;
    try {
      normalized = normalizeCheckpoint(checkpoint, { maxRecords });
      const serialized = `${JSON.stringify(normalized, null, 2)}\n`;
      if (Buffer.byteLength(serialized, 'utf8') > maxBytes) throw checkpointError('checkpoint_too_large');
      normalized = structuredClone(normalized);
    } catch (error) {
      return Promise.reject(error);
    }
    return enqueue(async () => {
      if (closed) throw checkpointError('checkpoint_store_closed');
      if (!hasLoaded) await loadNow();
      if (writeBlocked) throw checkpointError('checkpoint_writer_blocked');
      if (normalized.revision <= lastCommittedRevision) throw checkpointError('checkpoint_revision_not_advanced');
      try {
        await atomicWrite(filePath, structuredClone(normalized));
      } catch {
        writeBlocked = true;
        throw checkpointError('checkpoint_write_failed');
      }
      lastCommittedRevision = normalized.revision;
      hasLoaded = true;
      return structuredClone(normalized);
    });
  }

  function flush() {
    if (!accepting) return Promise.reject(checkpointError('checkpoint_store_closed'));
    return tail;
  }

  function close() {
    if (closePromise) return closePromise;
    accepting = false;
    closePromise = tail.then(async () => {
      closed = true;
      if (CHECKPOINT_WRITERS.get(key) === owner) CHECKPOINT_WRITERS.delete(key);
    });
    return closePromise;
  }

  return Object.freeze({ filePath, load, save, flush, close });
}
module.exports = {
  CHECKPOINT_SCHEMA_VERSION,
  DEFAULT_MAX_CHECKPOINT_BYTES,
  DEFAULT_MAX_RECORDS,
  checkpointError,
  createDurableCheckpointStore,
  makeEmptyCheckpoint,
  mergeRegistrationHistory,
  normalizeCheckpoint,
  projectRegistrationSnapshots,
  restoreCheckpoint,
};
