'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const PROVIDER_NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });
const OBSERVATION_LIMIT = 128;
const REQUEST_LIMIT = 128;
const ID_MAX = 512;
const STATUS_VALUES = new Set(['active', 'waiting', 'interrupted', 'completed', 'unknown']);
const CONNECTION_VALUES = new Set(['disconnected', 'connecting', 'connected', 'unknown']);

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value, maximum = ID_MAX) {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeScope(value, provider) {
  const fields = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'connectionSlotId'];
  if (!isRecord(value) || Reflect.ownKeys(value).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(value, field)) || value.provider !== provider ||
      value.nativeIdKind !== PROVIDER_NATIVE_ID_KINDS[provider] ||
      !isIdentifier(value.hostId) || !isIdentifier(value.homeScopeId) || !isIdentifier(value.connectionSlotId)) {
    throw new TypeError('invalid managed collector scope');
  }
  return Object.freeze({ ...value });
}

function normalizedPath(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) return null;
  return path.normalize(path.resolve(value));
}

function pathsEqual(left, right) {
  const a = normalizedPath(left);
  const b = normalizedPath(right);
  if (!a || !b) return false;
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function safeVersion(userAgent) {
  if (typeof userAgent !== 'string' || userAgent.length > 1024) return null;
  const match = userAgent.match(/(?:^|[/ ])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:$|[^0-9A-Za-z.+-])/);
  return match ? match[1] : null;
}

function statusFromNativeThread(thread) {
  const nativeStatus = thread?.status?.type;
  if (nativeStatus === 'active') return { activity: 'active', turnState: 'active' };
  if (nativeStatus === 'idle') return { activity: 'waiting', turnState: 'waiting' };
  return { activity: 'unknown', turnState: 'unknown' };
}

function statusFromNativeTurn(value) {
  if (value === 'completed') return 'completed';
  if (value === 'interrupted') return 'interrupted';
  if (value === 'inProgress' || value === 'in_progress' || value === 'active') return 'active';
  if (value === 'failed' || value === 'declined' || value === 'cancelled') return 'unknown';
  return null;
}

function safeNativeId(params) {
  if (!isRecord(params)) return null;
  const candidates = [params.threadId, params.thread_id, params.thread?.id];
  return candidates.find((value) => isIdentifier(value)) || null;
}

function claudeHookObservation(params) {
  if (!isRecord(params) || !isIdentifier(params.session_id)) return null;
  const nativeId = params.session_id;
  if (isIdentifier(params.agent_id)) return { kind: 'uncertain', nativeId, reason: 'actor_binding_unverified' };
  switch (params.hook_event_name) {
    case 'SessionStart':
    case 'UserPromptSubmit':
      return { kind: 'state', nativeId, turnId: null, activity: 'active', turnState: 'active' };
    case 'Stop':
      return { kind: 'state', nativeId, turnId: null, activity: 'waiting', turnState: 'waiting' };
    case 'Interrupt':
      return { kind: 'state', nativeId, turnId: null, activity: 'interrupted', turnState: 'interrupted' };
    case 'SessionEnd':
      return { kind: 'period-end', nativeId, reason: 'period_end_observed' };
    case 'PermissionRequest':
      return { kind: 'uncertain', nativeId, reason: 'permission_outcome_unavailable' };
    default:
      return { kind: 'uncertain', nativeId, reason: 'unsupported_hook_event' };
  }
}

function safeTurnId(params) {
  if (!isRecord(params)) return null;
  const candidates = [params.turnId, params.turn_id, params.turn?.id];
  return candidates.find((value) => isIdentifier(value)) || null;
}

function safeRequestId(value) {
  if (typeof value === 'string' && isIdentifier(value)) return `string:${value}`;
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return `number:${value}`;
  return null;
}

function createNativeProviderAdapter(provider) {
  if (!Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, provider)) throw new TypeError('unsupported managed collector provider');

  const capabilities = Object.freeze(provider === 'codex'
    ? { loadedList: 'supported', threadRead: 'supported', resume: 'supported', serverRequests: 'supported' }
    : { loadedList: 'unsupported', threadRead: 'unsupported', resume: 'unsupported', serverRequests: 'unsupported' });

  async function initialize(transport, expectedHome) {
    if (provider === 'claude') {
      return { ok: true, providerVersion: null, reason: null };
    }
    if (!transport || typeof transport.request !== 'function' || typeof transport.notify !== 'function') {
      return { ok: false, reason: 'transport_invalid' };
    }
    let response;
    try {
      response = await transport.request('initialize', {
        clientInfo: { name: 'agent-cockpit-managed-collector', title: 'Agent Cockpit', version: '1.0.0' },
        capabilities: { experimentalApi: false },
      });
    } catch {
      return { ok: false, reason: 'initialize_failed' };
    }
    const providerVersion = isRecord(response) ? safeVersion(response.userAgent) : null;
    if (!isRecord(response) || typeof response.codexHome !== 'string' || !normalizedPath(response.codexHome) ||
        typeof response.platformFamily !== 'string' || typeof response.platformOs !== 'string' || !providerVersion) {
      return { ok: false, reason: 'initialize_response_invalid' };
    }
    if (!pathsEqual(response.codexHome, expectedHome)) return { ok: false, reason: 'managed_home_mismatch' };
    try {
      await transport.notify('initialized', {});
    } catch {
      return { ok: false, reason: 'initialized_failed' };
    }
    return { ok: true, providerVersion, reason: null };
  }

  async function readKnownThread(transport, nativeId) {
    if (provider !== 'codex') return { status: 'unsupported', reason: 'provider_read_unsupported' };
    if (!transport || typeof transport.confirmLoadedThread !== 'function' || typeof transport.request !== 'function') {
      return { status: 'unknown', reason: 'transport_read_unavailable' };
    }
    let loaded;
    try {
      loaded = await transport.confirmLoadedThread(nativeId);
    } catch {
      return { status: 'unknown', reason: 'loaded_list_unavailable' };
    }
    if (loaded !== true) return { status: 'unknown', reason: 'thread_not_loaded' };
    let response;
    try {
      response = await transport.request('thread/read', { threadId: nativeId, includeTurns: false });
    } catch {
      return { status: 'unknown', reason: 'thread_read_failed' };
    }
    const thread = response?.thread;
    if (!isRecord(thread) || thread.id !== nativeId) return { status: 'unknown', reason: 'thread_identity_mismatch' };
    const status = statusFromNativeThread(thread);
    return {
      status: status.activity === 'unknown' ? 'unknown' : 'observed',
      reason: status.activity === 'unknown' ? 'thread_status_unavailable' : null,
      activity: status.activity,
      turnState: status.turnState,
      turnId: null,
    };
  }

  async function resumeLoadedThread(transport, nativeId, isStillVerified = () => true) {
    if (provider !== 'codex') return { status: 'unsupported', reason: 'provider_resume_unsupported' };
    if (!transport || typeof transport.confirmLoadedThread !== 'function' ||
        typeof transport.resumeLoadedThread !== 'function') {
      return { status: 'unknown', reason: 'transport_resume_unavailable' };
    }
    let loaded;
    try { loaded = await transport.confirmLoadedThread(nativeId); } catch {
      return { status: 'unknown', reason: 'loaded_list_unavailable' };
    }
    if (loaded !== true) return { status: 'unknown', reason: 'thread_not_loaded' };
    if (typeof isStillVerified !== 'function' || !isStillVerified()) {
      return { status: 'unknown', reason: 'actor_binding_unverified' };
    }
    try {
      await transport.resumeLoadedThread(nativeId, isStillVerified);
      return { status: 'resumed', reason: null };
    } catch {
      return { status: 'unknown', reason: 'thread_resume_failed' };
    }
  }

  function notification(method, params) {
    if (typeof method !== 'string' || method.length > 128) return null;
    if (provider === 'claude') {
      return method === 'claude/hook' ? claudeHookObservation(params) : null;
    }
    const nativeId = safeNativeId(params);
    const turnId = safeTurnId(params);
    if (method === 'serverRequest/resolved') {
      const requestId = isRecord(params) ? safeRequestId(params.requestId ?? params.id) : null;
      return requestId ? { kind: 'request-resolved', nativeId, requestId } : null;
    }
    if (method === 'turn/started') {
      return { kind: 'state', nativeId, turnId, activity: 'active', turnState: 'active' };
    }
    if (method === 'item/started' || method === 'item/completed') {
      return { kind: 'uncertain', nativeId, reason: 'item_actor_unverified' };
    }
    if (method === 'turn/completed') {
      const sourceStatus = isRecord(params) ? (params.turn?.status ?? params.status) : null;
      const turnState = statusFromNativeTurn(sourceStatus);
      if (!turnState) return { kind: 'uncertain', nativeId, turnId, reason: 'turn_status_unavailable' };
      return { kind: 'state', nativeId, turnId, activity: turnState, turnState };
    }
    if (method === 'turn/status/changed') {
      const sourceStatus = isRecord(params) ? (params.turn?.status ?? params.status) : null;
      const turnState = statusFromNativeTurn(sourceStatus);
      return turnState ? { kind: 'state', nativeId, turnId, activity: turnState, turnState } : null;
    }
    if (method === 'thread/status/changed') {
      const sourceStatus = isRecord(params) ? (params.status?.type ?? params.status) : null;
      const mapped = sourceStatus === 'active' ? 'active' : sourceStatus === 'idle' ? 'waiting' : null;
      return mapped ? { kind: 'state', nativeId, turnId, activity: mapped, turnState: mapped } : null;
    }
    return null;
  }

  function serverRequest(request) {
    if (provider !== 'codex') return null;
    if (!isRecord(request)) return null;
    const requestId = safeRequestId(request.id);
    const nativeId = safeNativeId(request.params);
    return requestId && nativeId
      ? { requestId, nativeId }
      : null;
  }

  return Object.freeze({ provider, capabilities, initialize, readKnownThread, resumeLoadedThread, notification, serverRequest });
}

function sanitizeObservation(value) {
  if (!isRecord(value)) return null;
  return {
    observationId: isIdentifier(value.observationId) ? value.observationId : null,
    nativeId: isIdentifier(value.nativeId) ? value.nativeId : null,
    conversationId: isIdentifier(value.conversationId) ? value.conversationId : null,
    executionId: isIdentifier(value.executionId) ? value.executionId : null,
    sessionId: isIdentifier(value.sessionId) ? value.sessionId : null,
    status: STATUS_VALUES.has(value.status) ? value.status : 'unknown',
    activity: STATUS_VALUES.has(value.activity) ? value.activity : 'unknown',
    turnState: STATUS_VALUES.has(value.turnState) ? value.turnState : 'unknown',
    turnId: isIdentifier(value.turnId) ? value.turnId : null,
    pendingRequests: Array.isArray(value.pendingRequests)
      ? value.pendingRequests.slice(0, REQUEST_LIMIT).map((request) => ({
        requestId: isIdentifier(request?.requestId) ? request.requestId : null,
        state: ['pending', 'unknown', 'resolved'].includes(request?.state) ? request.state : 'unknown',
      }))
      : [],
    reason: isIdentifier(value.reason) ? value.reason : null,
  };
}

function sanitizeManagedCollectorSnapshot(value) {
  if (!isRecord(value) || !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, value.provider) || !isRecord(value.scope) ||
      !isRecord(value.connection) || !isRecord(value.capabilities) || !Array.isArray(value.observations)) return null;
  const provider = value.provider;
  let scope;
  try { scope = normalizeScope(value.scope, provider); } catch { return null; }
  if (scope.nativeIdKind !== PROVIDER_NATIVE_ID_KINDS[provider]) return null;
  const capability = (field) => value.capabilities[field] === 'supported' ? 'supported' : 'unsupported';
  const generation = Number.isSafeInteger(value.connection.generation) && value.connection.generation >= 0
    ? value.connection.generation
    : 0;
  return {
    version: 1,
    provider,
    scope: { ...scope },
    connection: {
      state: CONNECTION_VALUES.has(value.connection.state) ? value.connection.state : 'unknown',
      generation,
      providerVersion: isIdentifier(value.connection.providerVersion) ? value.connection.providerVersion : null,
    },
    capabilities: {
      loadedList: capability('loadedList'),
      threadRead: capability('threadRead'),
      resume: capability('resume'),
      serverRequests: capability('serverRequests'),
    },
    observations: value.observations.slice(-OBSERVATION_LIMIT).map(sanitizeObservation).filter(Boolean),
  };
}

function createManagedCollector(options = {}) {
  if (Object.hasOwn(options, 'ownedSourceAccessor')) {
    const { createOwnedNativeSourceCollector } = require('./owned-native-source-collector');
    return createOwnedNativeSourceCollector(options, sanitizeManagedCollectorSnapshot);
  }
  const {
    provider,
    expectedHome,
    transportFactory,
    runtimeAdapter,
    registrationRegistry,
    runtimeRegistry,
    eventAdapter,
    trustedBindingResolver,
    onObservation,
  } = options;
  const scope = normalizeScope(options.scope, provider);
  if (provider === 'codex' && !normalizedPath(expectedHome)) throw new TypeError('Codex collector expectedHome must be absolute');
  if (typeof transportFactory !== 'function' || !runtimeAdapter ||
      typeof runtimeAdapter.openConnection !== 'function' || typeof runtimeAdapter.disconnect !== 'function' ||
      typeof runtimeAdapter.checkCurrentProof !== 'function' || typeof runtimeAdapter.get !== 'function' ||
      !registrationRegistry || typeof registrationRegistry.snapshot !== 'function' ||
      !runtimeRegistry || typeof runtimeRegistry.snapshot !== 'function' ||
      (eventAdapter !== undefined && (typeof eventAdapter.project !== 'function' || eventAdapter.provider !== provider))) {
    throw new TypeError('managed collector dependencies are required');
  }
  if (onObservation !== undefined && typeof onObservation !== 'function') throw new TypeError('onObservation must be a function');

  const adapter = createNativeProviderAdapter(provider);
  let connectionState = 'disconnected';
  let connectionGeneration = 0;
  let connectionHandle = null;
  let connectionId = null;
  let providerVersion = null;
  let transport = null;
  let epoch = 0;
  let connectPromise = null;
  let observationSerial = 0;
  const observations = new Map();
  const proofHandles = new Map();
  const requestRecords = new Map();
  const periodTombstones = new Set();
  const nativeReadStates = new Map();

  function activeNativeStateCount() {
    let count = 0;
    for (const state of nativeReadStates.values()) {
      if (state.activeCount > 0) count += 1;
    }
    return count;
  }

  function trimNativeReadStates() {
    const limit = OBSERVATION_LIMIT + activeNativeStateCount();
    if (nativeReadStates.size <= limit) return;
    for (const [nativeId, state] of nativeReadStates) {
      if (!observations.has(nativeId) && state.activeCount === 0) nativeReadStates.delete(nativeId);
      if (nativeReadStates.size <= limit) break;
    }
  }

  function nativeReadStateFor(nativeId, create = false) {
    let state = nativeReadStates.get(nativeId);
    if (state || !create) return state || null;
    trimNativeReadStates();
    if (nativeReadStates.size >= OBSERVATION_LIMIT * 2 + 1) return null;
    state = {
      nativeRevision: 0,
      nextReadSequence: 0,
      adoptedReadSequence: 0,
      proofOperationSequence: 0,
      activeCount: 0,
    };
    nativeReadStates.set(nativeId, state);
    return state;
  }

  function beginNativeStateLease(nativeId) {
    const state = nativeReadStateFor(nativeId, true);
    if (!state) return null;
    if (state.activeCount === 0 && activeNativeStateCount() >= OBSERVATION_LIMIT) return null;
    state.activeCount += 1;
    return { nativeId, state };
  }

  function releaseNativeStateLease(lease) {
    if (!lease || nativeReadStates.get(lease.nativeId) !== lease.state) return;
    lease.state.activeCount = Math.max(0, lease.state.activeCount - 1);
    trimNativeReadStates();
  }

  function advanceNativeRevision(nativeId) {
    const state = nativeReadStateFor(nativeId);
    if (state) state.nativeRevision += 1;
  }

  function captureNativeStateToken(lease, period) {
    const { nativeId, state } = lease;
    return {
      nativeId,
      state,
      period,
      epoch,
      connectionGeneration,
      connectionHandle,
      nativeRevision: state.nativeRevision,
      adoptedReadSequence: state.adoptedReadSequence,
    };
  }

  function nativeStateBaseCurrent(token) {
    const currentPeriod = findRegisteredPeriod(token.nativeId);
    return nativeReadStates.get(token.nativeId) === token.state &&
      token.epoch === epoch && token.connectionGeneration === connectionGeneration &&
      token.connectionHandle === connectionHandle && connectionState === 'connected' &&
      token.state.nativeRevision === token.nativeRevision &&
      samePeriod(currentPeriod, token.period) &&
      identitiesEqual(currentPeriod?.identity, token.period.identity) && !isPeriodTombstoned(token.period);
  }

  function nativeStateTokenCurrent(token) {
    return nativeStateBaseCurrent(token) && token.state.adoptedReadSequence === token.adoptedReadSequence;
  }

  function beginObservationRead(nativeId, period) {
    const lease = beginNativeStateLease(nativeId);
    if (!lease) return null;
    lease.state.nextReadSequence += 1;
    return { ...lease, token: captureNativeStateToken(lease, period), readSequence: lease.state.nextReadSequence };
  }

  function canAdoptObservationRead(read) {
    const { token, state, readSequence } = read;
    return nativeStateBaseCurrent(token) && readSequence > state.adoptedReadSequence;
  }

  function adoptObservationRead(read) {
    if (!canAdoptObservationRead(read)) return false;
    read.state.adoptedReadSequence = read.readSequence;
    return true;
  }

  function adoptedObservationReadCurrent(read) {
    const { token, state, readSequence } = read;
    return nativeStateBaseCurrent(token) && state.adoptedReadSequence === readSequence;
  }

  function observationReadUnavailableReason(read) {
    const { token } = read;
    const currentPeriod = findRegisteredPeriod(token.nativeId);
    if (token.epoch !== epoch || token.connectionHandle !== connectionHandle) return 'connection_epoch_changed';
    if (!samePeriod(currentPeriod, token.period) || !identitiesEqual(currentPeriod?.identity, token.period.identity)) {
      return 'registered_period_changed';
    }
    return 'observation_superseded';
  }

  function periodKey(conversationId, executionId, sessionId) {
    return JSON.stringify([conversationId, executionId, sessionId]);
  }

  function isPeriodTombstoned(period) {
    return periodTombstones.has(periodKey(period.conversationId, period.executionId, period.sessionId));
  }

  function samePeriod(left, right) {
    return Boolean(left && right) && left.conversationId === right.conversationId &&
      left.executionId === right.executionId && left.sessionId === right.sessionId;
  }

  function tombstonePeriod(period) {
    periodTombstones.add(periodKey(period.conversationId, period.executionId, period.sessionId));
    for (const launch of readRuntimeSnapshot()?.launches || []) {
      if (launch?.conversationId === period.conversationId &&
          launch?.executionBinding?.periodId === period.executionId && launch?.sessionId === period.sessionId) {
        proofHandles.delete(launch.launchRef);
      }
    }
    const observation = observations.get(period.identity.nativeId);
    if (samePeriod(observation, period)) {
      observation.pendingRequests = observation.pendingRequests.map((item) =>
        item.state === 'pending' ? { ...item, state: 'unknown' } : item);
    }
    for (const [key, request] of requestRecords) {
      if (samePeriod(request, period) && request.state === 'pending') {
        requestRecords.set(key, { ...request, state: 'unknown' });
      }
    }
  }

  function readRegistrationSnapshot() {
    const value = registrationRegistry.snapshot();
    if (!isRecord(value) || !Array.isArray(value.conversations) || !Array.isArray(value.executions)) return null;
    return value;
  }

  function findRegisteredPeriod(nativeId) {
    if (!isIdentifier(nativeId)) return null;
    let snapshot;
    try { snapshot = readRegistrationSnapshot(); } catch { return null; }
    if (!snapshot) return null;
    const identityMatches = (identity) => isRecord(identity) &&
      identity.provider === scope.provider && identity.nativeIdKind === scope.nativeIdKind &&
      identity.hostId === scope.hostId && identity.homeScopeId === scope.homeScopeId && identity.nativeId === nativeId;
    const conversations = snapshot.conversations.filter((conversation) => identityMatches(conversation?.identity));
    if (conversations.length !== 1 || !isIdentifier(conversations[0].conversationId)) return null;
    const conversation = conversations[0];
    const executions = snapshot.executions.filter((execution) => execution?.conversationId === conversation.conversationId &&
      execution.state === 'active' && isIdentifier(execution.executionId) && isIdentifier(execution.sessionId));
    if (executions.length !== 1) return null;
    return {
      identity: { ...conversation.identity },
      conversationId: conversation.conversationId,
      executionId: executions[0].executionId,
      sessionId: executions[0].sessionId,
    };
  }

  function publicSnapshot() {
    return sanitizeManagedCollectorSnapshot({
      version: 1,
      provider,
      scope,
      connection: { state: connectionState, generation: connectionGeneration, providerVersion },
      capabilities: adapter.capabilities,
      observations: [...observations.values()].map(observationForSnapshot),
    });
  }

  function observationForSnapshot(record) {
    const projected = { ...record };
    const currentPeriod = findRegisteredPeriod(record.nativeId);
    const periodMatches = samePeriod(currentPeriod, record);
    const proofLive = periodMatches && record.verifiedLaunchRef &&
      record.verifiedGeneration === connectionGeneration && Boolean(resolveProof(record.verifiedLaunchRef));
    if (!proofLive) {
      if (record.verifiedLaunchRef) proofHandles.delete(record.verifiedLaunchRef);
      if (projected.status !== 'unknown') projected.status = 'unknown';
      projected.reason ||= periodMatches ? 'actor_binding_unverified' : 'registered_period_changed';
    }
    return projected;
  }

  function publicObservation(record) {
    return sanitizeObservation(record);
  }

  function notifyObservation(record) {
    nativeReadStateFor(record.nativeId, true);
    trimNativeReadStates();
    if (!onObservation) return;
    try { onObservation(publicObservation(record)); } catch {}
  }

  function setUnknown(period, nativeId, reason, verifiedLaunchRef = null, preserveLastKnown = false) {
    if (!period || !isIdentifier(nativeId)) return null;
    const key = nativeId;
    const existing = observations.get(key);
    const sameExecution = samePeriod(existing, period);
    const keepLastKnown = sameExecution && preserveLastKnown;
    const verified = verifiedLaunchRef && resolveProof(verifiedLaunchRef) ? verifiedLaunchRef : null;
    const record = {
      observationId: sameExecution ? existing.observationId : `${connectionGeneration}:${++observationSerial}`,
      nativeId,
      conversationId: period.conversationId,
      executionId: period.executionId,
      sessionId: period.sessionId,
      status: 'unknown',
      activity: keepLastKnown ? existing.activity : 'unknown',
      turnState: keepLastKnown ? existing.turnState : 'unknown',
      turnId: keepLastKnown ? existing.turnId : null,
      pendingRequests: sameExecution ? existing.pendingRequests : [],
      reason,
      verifiedLaunchRef: verified,
      verifiedGeneration: verified ? connectionGeneration : null,
    };
    observations.delete(key);
    observations.set(key, record);
    while (observations.size > OBSERVATION_LIMIT) observations.delete(observations.keys().next().value);
    trimNativeReadStates();
    notifyObservation(record);
    return record;
  }

  function setRequestState(requestId, nativeId, state, expectedPeriod = null) {
    const period = findRegisteredPeriod(nativeId);
    if (!period || (expectedPeriod && !samePeriod(period, expectedPeriod))) return;
    if (isPeriodTombstoned(period)) return;
    let record = observations.get(nativeId);
    if (record && !samePeriod(record, period)) record = null;
    if (!record) record = setUnknown(period, nativeId, 'actor_binding_unverified');
    if (!record) return;
    const verifiedLaunchRef = verifiedLaunchForPeriod(period, record);
    record.verifiedLaunchRef = verifiedLaunchRef;
    record.verifiedGeneration = verifiedLaunchRef ? connectionGeneration : null;
    const verified = Boolean(verifiedLaunchRef);
    const observedState = verified ? state : 'unknown';
    const requests = record.pendingRequests.filter((item) => item.requestId !== requestId);
    requests.push({ requestId, state: observedState });
    record.pendingRequests = requests.slice(-REQUEST_LIMIT);
    if (!verified) {
      record.status = 'unknown';
      record.verifiedLaunchRef = null;
      record.verifiedGeneration = null;
      record.reason = 'actor_binding_unverified';
    }
    notifyObservation(record);
  }

  function callbackForEpoch(currentEpoch) {
    return {
      onNotification(method, rawParams) {
        if (currentEpoch !== epoch) return;
        const event = adapter.notification(method, rawParams);
        if (!event) return;
        if (event.kind === 'request-resolved') {
          const matchingRequests = [...requestRecords.entries()].filter(([, record]) => {
            if (record.requestId !== event.requestId || record.epoch !== currentEpoch ||
                (event.nativeId && record.nativeId !== event.nativeId)) return false;
            const currentPeriod = findRegisteredPeriod(record.nativeId);
            return samePeriod(currentPeriod, record) && !isPeriodTombstoned(currentPeriod);
          });
          if (matchingRequests.length !== 1) return;
          const [requestKey, record] = matchingRequests[0];
          advanceNativeRevision(record.nativeId);
          const observation = observations.get(record.nativeId);
          const verified = samePeriod(observation, record) && observation.verifiedLaunchRef &&
            Boolean(resolveProof(observation.verifiedLaunchRef));
          const state = verified ? 'resolved' : 'unknown';
          requestRecords.set(requestKey, { ...record, state });
          setRequestState(event.requestId, record.nativeId, state, record);
          return;
        }
        if (!event.nativeId) return;
        const period = findRegisteredPeriod(event.nativeId);
        if (!period) return;
        advanceNativeRevision(event.nativeId);
        if (isPeriodTombstoned(period)) {
          setUnknown(period, event.nativeId, 'period_end_observed');
          return;
        }
        let record = observations.get(event.nativeId);
        if (!samePeriod(record, period)) record = setUnknown(period, event.nativeId, 'actor_binding_unverified');
        if (!record || currentEpoch !== epoch) return;
        const verifiedLaunchRef = verifiedLaunchForPeriod(period, record);
        if (event.kind === 'period-end') {
          tombstonePeriod(period);
          setUnknown(period, event.nativeId, event.reason || 'period_end_observed');
          return;
        }
        if (event.kind === 'uncertain') {
          setUnknown(period, event.nativeId, event.reason, verifiedLaunchRef, true);
          if (verifiedLaunchRef) void projectNativeUnknown(verifiedLaunchRef, period, currentEpoch);
          return;
        }
        const verified = verifiedLaunchRef && Boolean(resolveProof(verifiedLaunchRef));
        if (provider === 'codex' && verified && ['completed', 'interrupted'].includes(event.turnState) && record.turnState === 'active' &&
          (!record.turnId || record.turnId !== event.turnId)) {
          record.status = 'unknown';
          record.reason = 'turn_identity_unverified';
          notifyObservation(record);
          void projectNativeUnknown(verifiedLaunchRef, period, currentEpoch);
          return;
        }
        if (verified) {
          record.status = event.activity;
          record.activity = event.activity;
          record.turnState = event.turnState;
          record.turnId = event.turnId;
          record.reason = null;
          record.verifiedLaunchRef = verifiedLaunchRef;
          record.verifiedGeneration = connectionGeneration;
        } else {
          record.status = 'unknown';
          record.reason ||= 'actor_binding_unverified';
          record.verifiedLaunchRef = null;
          record.verifiedGeneration = null;
        }
        notifyObservation(record);
        if (verified) void projectNativeUnknown(verifiedLaunchRef, period, currentEpoch);
      },
      onServerRequest(request) {
        if (currentEpoch !== epoch) return;
        const normalized = adapter.serverRequest(request);
        if (!normalized) return;
        const period = findRegisteredPeriod(normalized.nativeId);
        if (!period || isPeriodTombstoned(period)) return;
        advanceNativeRevision(normalized.nativeId);
        const requestKey = JSON.stringify([currentEpoch, period.executionId, normalized.requestId]);
        if (!requestRecords.has(requestKey) && requestRecords.size >= REQUEST_LIMIT) {
          requestRecords.delete(requestRecords.keys().next().value);
        }
        const existing = requestRecords.get(requestKey);
        if (existing && (existing.nativeId !== normalized.nativeId || existing.epoch !== currentEpoch)) return;
        requestRecords.set(requestKey, existing || {
          ...period,
          requestId: normalized.requestId,
          nativeId: normalized.nativeId,
          epoch: currentEpoch,
          state: 'pending',
        });
        setRequestState(normalized.requestId, normalized.nativeId, existing?.state || 'pending', period);
      },
      onDisconnect(event) {
        if (currentEpoch !== epoch) return;
        void disconnectCurrent('unknown', isRecord(event) && isIdentifier(event.code) ? event.code : 'transport_disconnected');
      },
    };
  }

  async function disconnectCurrent(nextState, reason) {
    const oldTransport = transport;
    const oldHandle = connectionHandle;
    epoch += 1;
    if (oldHandle) {
      try { runtimeAdapter.disconnect(oldHandle); } catch {}
    }
    transport = null;
    connectionHandle = null;
    connectionId = null;
    proofHandles.clear();
    connectionState = nextState;
    for (const record of observations.values()) {
      record.pendingRequests = record.pendingRequests.map((item) => item.state === 'pending' ? { ...item, state: 'unknown' } : item);
      record.status = 'unknown';
      record.verifiedLaunchRef = null;
      record.verifiedGeneration = null;
      record.reason = reason || 'transport_disconnected';
      notifyObservation(record);
    }
    for (const [key, request] of requestRecords) {
      if (request.state === 'pending') requestRecords.set(key, { ...request, state: 'unknown' });
    }
    if (oldTransport && typeof oldTransport.close === 'function') {
      try { await oldTransport.close(); } catch {}
    }
  }

  async function connect() {
    if (connectionState === 'connected') return { status: 'connected', generation: connectionGeneration };
    if (connectPromise) return connectPromise;
    const currentEpoch = ++epoch;
    connectionState = 'connecting';
    connectPromise = (async () => {
      let createdTransport;
      try {
        createdTransport = await transportFactory(callbackForEpoch(currentEpoch));
        if (currentEpoch !== epoch) {
          try { await createdTransport?.close?.(); } catch {}
          return { status: 'unknown', reason: 'connection_epoch_changed' };
        }
        if (!createdTransport || typeof createdTransport.close !== 'function') {
          throw Object.assign(new Error(), { code: 'transport_invalid' });
        }
        transport = createdTransport;
        const initialized = await adapter.initialize(transport, expectedHome);
        if (currentEpoch !== epoch) {
          try { await transport.close(); } catch {}
          return { status: 'unknown', reason: 'connection_epoch_changed' };
        }
        if (!initialized.ok) {
          connectionState = 'unknown';
          try { await transport.close(); } catch {}
          transport = null;
          return { status: 'rejected', reason: initialized.reason };
        }
        const id = crypto.randomUUID();
        const evidence = {
          evidenceId: crypto.randomUUID(),
          source: provider === 'codex' ? 'codex-app-server' : 'claude-native-transport',
          method: provider === 'codex' ? 'initialize' : 'transport-connect',
          adapterVersion: 'managed-collector-1',
          runtimeVersion: initialized.providerVersion || 'unknown',
          observedAt: new Date().toISOString(),
        };
        const opened = runtimeAdapter.openConnection(scope, id, evidence);
        if (!isRecord(opened) || !opened.connectionHandle || !Number.isSafeInteger(opened.connectionGeneration) ||
            opened.connectionGeneration < 1) throw Object.assign(new Error(), { code: 'connection_binding_failed' });
        if (currentEpoch !== epoch) {
          try { await runtimeAdapter.disconnect(opened.connectionHandle); } catch {}
          try { await transport.close(); } catch {}
          transport = null;
          return { status: 'unknown', reason: 'connection_epoch_changed' };
        }
        connectionHandle = opened.connectionHandle;
        connectionId = id;
        connectionGeneration = opened.connectionGeneration;
        providerVersion = initialized.providerVersion;
        connectionState = 'connected';
        return { status: 'connected', generation: connectionGeneration };
      } catch (error) {
        if (currentEpoch === epoch) {
          connectionState = 'unknown';
          transport = null;
        }
        try { await createdTransport?.close?.(); } catch {}
        return { status: 'unknown', reason: isIdentifier(error?.code) ? error.code : 'connection_failed' };
      }
    })().finally(() => { connectPromise = null; });
    return connectPromise;
  }

  function readRuntimeSnapshot() {
    const value = runtimeRegistry.snapshot();
    return isRecord(value) && Array.isArray(value.launches) ? value : null;
  }

  function identitiesEqual(left, right) {
    return Boolean(left && right) && ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']
      .every((field) => left[field] === right[field]);
  }

  function currentRegistrationForLaunch(launchRef) {
    if (!isIdentifier(launchRef) || connectionState !== 'connected' || !connectionHandle) return null;
    let launch;
    let current;
    let snapshot;
    try {
      snapshot = readRuntimeSnapshot();
      launch = snapshot?.launches.find((item) => item?.launchRef === launchRef);
      current = runtimeAdapter.get(launchRef);
    } catch { return null; }
    const executionBinding = launch?.executionBinding;
    if (!isRecord(launch) || !isRecord(current) || !isRecord(launch.identity) || !isRecord(executionBinding) ||
        !isIdentifier(executionBinding.periodId) || launch.state === 'ended' || current.state === 'ended' ||
        periodTombstones.has(periodKey(launch.conversationId, executionBinding.periodId, launch.sessionId)) ||
        current.state === 'unknown' || !identitiesEqual(launch.identity, current.identity) ||
        current.executionBinding?.periodId !== executionBinding.periodId) return null;
    let registration;
    try { registration = readRegistrationSnapshot(); } catch { return null; }
    if (!registration) return null;
    const conversations = registration.conversations.filter((item) => item?.conversationId === launch.conversationId &&
      identitiesEqual(item.identity, launch.identity));
    if (conversations.length !== 1) return null;
    const conversation = conversations[0];
    const executions = registration.executions.filter((item) => item?.executionId === executionBinding.periodId &&
      item?.conversationId === conversation.conversationId && item.state === 'active' &&
      item.sessionId === launch.sessionId);
    if (executions.length !== 1 || launch.identity.provider !== scope.provider ||
        launch.identity.nativeIdKind !== scope.nativeIdKind || launch.identity.hostId !== scope.hostId ||
        launch.identity.homeScopeId !== scope.homeScopeId) return null;
    return {
      launch,
      current,
      identity: { ...conversation.identity },
      conversationId: conversation.conversationId,
      executionId: executions[0].executionId,
      sessionId: executions[0].sessionId,
    };
  }

  function proofMetadataMatches(current, registered) {
    const proof = current?.currentProof;
    const proofBinding = proof?.executionBinding;
    return isRecord(proof) && identitiesEqual(proof.identity, registered.identity) &&
      isRecord(proofBinding) && proofBinding.periodId === registered.executionId &&
      proofBinding.actor?.kind === registered.launch.executionBinding.actor?.kind &&
      proofBinding.actor?.id === registered.launch.executionBinding.actor?.id &&
      proof.executionConnectionGeneration === connectionGeneration;
  }

  function resolveProof(launchRef) {
    const cached = proofHandles.get(launchRef);
    if (!cached || cached.generation !== connectionGeneration || cached.connectionHandle !== connectionHandle) return null;
    const registered = currentRegistrationForLaunch(launchRef);
    if (!registered || !proofMetadataMatches(registered.current, registered)) {
      proofHandles.delete(launchRef);
      return null;
    }
    let live;
    try { live = runtimeAdapter.checkCurrentProof(launchRef, cached.handle); } catch { live = null; }
    if (!isRecord(live) || live.ok !== true || live.then) {
      proofHandles.delete(launchRef);
      return null;
    }
    return cached.handle;
  }

  async function reconcileProofGuarded(launchRef, isCurrent) {
    const guardAllows = () => {
      try {
        const result = isCurrent();
        return result === true && !(result && typeof result.then === 'function');
      } catch { return false; }
    };
    if (!guardAllows()) return false;
    const registered = currentRegistrationForLaunch(launchRef);
    if (!registered || isPeriodTombstoned(registered)) return false;
    const nativeId = registered.identity.nativeId;
    const state = nativeReadStateFor(nativeId, true);
    if (!state || !guardAllows()) return false;
    const proofOperationSequence = ++state.proofOperationSequence;
    const proofOperationCurrent = () => nativeReadStates.get(nativeId) === state &&
      state.proofOperationSequence === proofOperationSequence && guardAllows();
    if (!proofOperationCurrent()) return false;
    let resolverActive = true;
    const resolverProofOperationCurrent = () => resolverActive && proofOperationCurrent();
    try {
      proofHandles.delete(launchRef);
      const resolver = trustedBindingResolver?.resolveProof;
      if (typeof resolver !== 'function') return false;
      const currentEpoch = epoch;
      const expectedConnectionHandle = connectionHandle;
      const context = Object.freeze({
        provider,
        scope: { ...scope },
        identity: { ...registered.identity },
        nativeId,
        conversationId: registered.conversationId,
        executionId: registered.executionId,
        sessionId: registered.sessionId,
        connectionGeneration,
        connectionHandle: expectedConnectionHandle,
        isCurrent: resolverProofOperationCurrent,
      });
      let handle;
      try { handle = await resolver.call(trustedBindingResolver, launchRef, context); } catch { return false; }
      if (!proofOperationCurrent() || (typeof handle !== 'object' && typeof handle !== 'function') || handle === null ||
          currentEpoch !== epoch || expectedConnectionHandle !== connectionHandle) return false;
      const latest = currentRegistrationForLaunch(launchRef);
      if (!latest || !samePeriod(latest, registered) || !identitiesEqual(latest.identity, registered.identity) ||
          !proofOperationCurrent()) return false;
      let live;
      try { live = runtimeAdapter.checkCurrentProof(launchRef, handle); } catch { return false; }
      if (!proofOperationCurrent() || !proofMetadataMatches(latest.current, latest) ||
          !isRecord(live) || live.ok !== true || live.then || currentEpoch !== epoch ||
          expectedConnectionHandle !== connectionHandle) return false;
      proofHandles.set(launchRef, {
        handle,
        generation: connectionGeneration,
        connectionHandle: expectedConnectionHandle,
      });
      if (!proofOperationCurrent()) return false;
      return Boolean(resolveProof(launchRef));
    } finally {
      resolverActive = false;
    }
  }

  async function reconcileProof(launchRef) {
    const registered = currentRegistrationForLaunch(launchRef);
    if (!registered || isPeriodTombstoned(registered)) return false;
    const nativeId = registered.identity.nativeId;
    const lease = beginNativeStateLease(nativeId);
    if (!lease) return false;
    const token = captureNativeStateToken(lease, registered);
    try {
      return await reconcileProofGuarded(launchRef, () => nativeStateTokenCurrent(token));
    } finally {
      releaseNativeStateLease(lease);
    }
  }

  function findLaunchesForPeriod(period) {
    let snapshot;
    try { snapshot = readRuntimeSnapshot(); } catch { return []; }
    if (!snapshot) return [];
    return snapshot.launches.filter((launch) => launch?.executionBinding?.periodId === period.executionId &&
      launch?.identity?.nativeId === period.identity.nativeId && identitiesEqual(launch.identity, period.identity));
  }

  function invalidateProofsForPeriod(period) {
    for (const launch of findLaunchesForPeriod(period)) proofHandles.delete(launch.launchRef);
  }

  function verifiedLaunchForPeriod(period, record) {
    if (record?.verifiedLaunchRef && resolveProof(record.verifiedLaunchRef)) return record.verifiedLaunchRef;
    const candidates = findLaunchesForPeriod(period);
    return candidates.length === 1 && resolveProof(candidates[0].launchRef) ? candidates[0].launchRef : null;
  }

  async function projectNativeUnknown(launchRef, period, currentEpoch) {
    const writerResolver = trustedBindingResolver?.resolveEventWriter;
    if (!eventAdapter || typeof writerResolver !== 'function' || !resolveProof(launchRef)) return null;
    const context = Object.freeze({
      provider,
      scope: { ...scope },
      identity: { ...period.identity },
      nativeId: period.identity.nativeId,
      conversationId: period.conversationId,
      executionId: period.executionId,
      sessionId: period.sessionId,
      connectionGeneration,
      connectionHandle,
    });
    let writer;
    try { writer = await writerResolver.call(trustedBindingResolver, launchRef, context); } catch { return null; }
    if (!writer || currentEpoch !== epoch || !resolveProof(launchRef)) return null;
    try {
      return eventAdapter.project({
        writer,
        sessionId: period.sessionId,
        provider,
        event: { hook_event_name: 'ManagedNativeObservation' },
      });
    } catch { return null; }
  }

  async function observeKnownThread(nativeId) {
    if (!isIdentifier(nativeId)) return { status: 'rejected', reason: 'invalid_native_id' };
    if (connectionState !== 'connected' || !transport) return { status: 'unknown', reason: 'not_connected' };
    const registered = findRegisteredPeriod(nativeId);
    if (!registered) {
      return { status: 'unknown', reason: 'registration_unavailable' };
    }
    if (isPeriodTombstoned(registered)) {
      setUnknown(registered, nativeId, 'period_end_observed');
      return { status: 'unknown', observation: publicObservation(observations.get(nativeId)), reason: 'period_end_observed' };
    }
    const read = beginObservationRead(nativeId, registered);
    if (!read) return { status: 'unknown', reason: 'observation_capacity' };
    try {
      const result = await adapter.readKnownThread(transport, nativeId);
      if (!canAdoptObservationRead(read)) {
        return { status: 'unknown', reason: observationReadUnavailableReason(read) };
      }
      if (!adoptObservationRead(read)) return { status: 'unknown', reason: observationReadUnavailableReason(read) };
      if (result.status === 'unsupported') {
        const record = setUnknown(registered, nativeId, result.reason);
        return { status: 'unsupported', observation: record ? publicObservation(record) : null, reason: result.reason };
      }
      if (result.status !== 'observed') {
        invalidateProofsForPeriod(registered);
        const record = setUnknown(registered, nativeId, result.reason || 'observation_unknown', null, true);
        return { status: 'unknown', observation: record ? publicObservation(record) : null, reason: result.reason || 'observation_unknown' };
      }
      const candidates = findLaunchesForPeriod(registered);
      let verified = false;
      let verifiedLaunchRef = null;
      if (candidates.length === 1) {
        verified = await reconcileProofGuarded(candidates[0].launchRef, () => adoptedObservationReadCurrent(read));
        if (!adoptedObservationReadCurrent(read)) {
          return { status: 'unknown', reason: observationReadUnavailableReason(read) };
        }
        if (verified && adoptedObservationReadCurrent(read) && resolveProof(candidates[0].launchRef)) {
          verifiedLaunchRef = candidates[0].launchRef;
        }
        else verified = false;
      }
      if (!adoptedObservationReadCurrent(read)) {
        return { status: 'unknown', reason: observationReadUnavailableReason(read) };
      }
      const previous = observations.get(nativeId);
      const sameExecution = samePeriod(previous, registered);
      const record = {
        observationId: sameExecution
          ? previous.observationId
          : `${connectionGeneration}:${++observationSerial}`,
        nativeId,
        conversationId: registered.conversationId,
        executionId: registered.executionId,
        sessionId: registered.sessionId,
        status: verified ? result.activity : 'unknown',
        activity: verified ? result.activity : sameExecution ? previous.activity : 'unknown',
        turnState: verified ? result.turnState : sameExecution ? previous.turnState : 'unknown',
        turnId: verified ? result.turnId : sameExecution ? previous.turnId : null,
        pendingRequests: sameExecution ? previous.pendingRequests : [],
        reason: verified ? null : 'actor_binding_unverified',
        verifiedLaunchRef,
        verifiedGeneration: verified ? connectionGeneration : null,
      };
      observations.delete(nativeId);
      observations.set(nativeId, record);
      while (observations.size > OBSERVATION_LIMIT) observations.delete(observations.keys().next().value);
      trimNativeReadStates();
      notifyObservation(record);
      return { status: record.status === 'unknown' ? 'unknown' : 'observed', observation: publicObservation(record), reason: record.reason };
    } finally {
      releaseNativeStateLease(read);
    }
  }

  async function resumeKnownThread(nativeId) {
    if (!isIdentifier(nativeId)) return { status: 'rejected', reason: 'invalid_native_id' };
    if (connectionState !== 'connected' || !transport) return { status: 'unknown', reason: 'not_connected' };
    const currentEpoch = epoch;
    const registered = findRegisteredPeriod(nativeId);
    if (!registered) return { status: 'unknown', reason: 'registration_unavailable' };
    if (isPeriodTombstoned(registered)) return { status: 'unknown', reason: 'period_end_observed' };
    const candidates = findLaunchesForPeriod(registered);
    if (candidates.length !== 1 || !resolveProof(candidates[0].launchRef)) {
      advanceNativeRevision(nativeId);
      invalidateProofsForPeriod(registered);
      const observation = setUnknown(registered, nativeId, 'actor_binding_unverified', null, true);
      return { status: 'unknown', observation: publicObservation(observation), reason: 'actor_binding_unverified' };
    }
    const launchRef = candidates[0].launchRef;
    const result = await adapter.resumeLoadedThread(transport, nativeId,
      () => currentEpoch === epoch && Boolean(resolveProof(launchRef)));
    if (currentEpoch !== epoch) return { status: 'unknown', reason: 'connection_epoch_changed' };
    const latestPeriod = findRegisteredPeriod(nativeId);
    if (!samePeriod(latestPeriod, registered) || !identitiesEqual(latestPeriod?.identity, registered.identity)) {
      return { status: 'unknown', reason: 'registered_period_changed' };
    }
    if (isPeriodTombstoned(registered)) return { status: 'unknown', reason: 'period_end_observed' };
    if (result.status !== 'resumed') {
      if (result.status === 'unknown') {
        advanceNativeRevision(nativeId);
        invalidateProofsForPeriod(registered);
        const observation = setUnknown(registered, nativeId, result.reason || 'resume_outcome_unknown', null, true);
        return { ...result, observation: publicObservation(observation) };
      }
      return result;
    }
    return { status: 'resumed', reason: null };
  }

  async function disconnect() {
    await disconnectCurrent('disconnected', 'collector_disconnected');
    return { status: 'disconnected' };
  }

  return Object.freeze({
    connect,
    observeKnownThread,
    resumeKnownThread,
    disconnect,
    snapshot: publicSnapshot,
    resolveProof,
    reconcileProof,
  });
}

module.exports = {
  createManagedCollector,
  createNativeProviderAdapter,
  sanitizeManagedCollectorSnapshot,
};
