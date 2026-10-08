'use strict';

const { EVENT_NAMES } = require('./events');

const PROVIDER_NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });
const PROVIDERS = new Set(Object.keys(PROVIDER_NATIVE_ID_KINDS));
const MAX_EVENT_ID_LENGTH = 256;
const UNKNOWN_REASONS = new Set([
  'actor_correlation_unavailable',
  'actor_correlation_failed',
  'actor_binding_mismatch',
  'event_id_missing',
  'event_sequence_missing',
  'event_sequence_gap',
  'event_sequence_regressed',
  'event_order_unverified',
  'event_id_content_conflict',
  'period_end_observed',
  'permission_unresolved',
  'tool_result_missing',
  'collector_disconnected',
  'event_gap',
  'configuration_disabled',
  'observation_unavailable',
  'event_name_mismatch',
  'actor_reactivation_unverified',
  'unsupported_event',
]);
const NATIVE_COMMON_FIELDS = Object.freeze([
  'hookAt', 'hook_at', 'source', 'tool_name', 'tool_use_id', 'summary', 'agent_id',
  'agent_type', 'route', 'description', 'questions', 'decisionResolution',
  'decision_resolution', 'ghPrCreateCommand', 'refreshPullRequestsCommand',
  'refreshPullRequests', 'pullRequest', 'backgroundTaskId', 'backgroundOutputTaskId',
  'resolvedModel', 'codexOutput', 'codexReviewDefinition', 'codexWaitRunId',
  'cwd', 'notification_type', 'message', 'stoppedTaskId',
]);
const COMMON_EVENT_FIELDS = new Set(NATIVE_COMMON_FIELDS.filter((name) => name !== 'hook_at' && name !== 'decision_resolution'));

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeIdentifier(value, maxLength = MAX_EVENT_ID_LENGTH) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
}

function eventFingerprint(event) {
  const content = { ...event };
  delete content.writer;
  delete content.hookAt;
  delete content.hook_at;
  delete content.nativeEventId;
  if (isRecord(content.nativeEvent)) {
    content.nativeEvent = { ...content.nativeEvent };
    for (const key of ['hookAt', 'hook_at', 'nativeEventId', 'event_id', 'sequence_number', 'sequenceNumber']) {
      delete content.nativeEvent[key];
    }
  }
  return JSON.stringify(stableValue(content));
}

function identitiesEqual(left, right) {
  return Boolean(left && right) &&
    ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'].every((key) => left[key] === right[key]);
}

function cloneRegistration(registration) {
  return {
    provider: registration.provider,
    identity: { ...registration.identity },
    conversationId: registration.conversationId,
    executionId: registration.executionId,
    sessionId: registration.sessionId,
  };
}

function cloneProjection(projection, registeredPeriodState = 'active') {
  const registryEnded = registeredPeriodState === 'ended';
  const registryUnknown = registeredPeriodState !== 'active' && !registryEnded;
  const actors = [...projection.actorStates.entries()]
    .map(([id, state]) => ({
      id,
      active: registryEnded ? false : state.active,
      turn: registryEnded ? 'session_ended' : state.turn,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    provider: projection.provider,
    conversationId: projection.conversationId,
    executionId: projection.executionId,
    sessionId: projection.sessionId,
    registeredPeriodState,
    lastKnownState: {
      period: registryEnded ? 'ended' : registryUnknown ? 'unknown' : projection.periodState,
      observedPeriod: projection.periodState,
      rootTurn: registryEnded ? 'ended' : registryUnknown ? 'unknown' : projection.rootTurnState,
      observedRootTurn: projection.rootTurnState,
      actors,
    },
    status: projection.reasons.size || registryUnknown ? 'unknown' : 'known',
    dedupQuality: projection.dedupQuality,
    orderingQuality: projection.orderingQuality,
    reasons: [...projection.reasons].sort(),
  };
}
function createProviderEventProjection({ registry, resolveActorCorrelation = null } = {}) {
  if (!registry || typeof registry.authorizeEvent !== 'function' || typeof registry.snapshot !== 'function') {
    throw new TypeError('provider event projection requires a registration registry');
  }
  if (resolveActorCorrelation !== null && typeof resolveActorCorrelation !== 'function') {
    throw new TypeError('resolveActorCorrelation must be a trusted in-process function');
  }

  const projectionsByExecution = new Map();

  function registrationFor(authorization) {
    const snapshot = registry.snapshot();
    const execution = snapshot.executions.find((item) => item.executionId === authorization.executionId);
    const conversation = execution && snapshot.conversations.find((item) => item.conversationId === execution.conversationId);
    if (!execution || execution.state !== 'active' || !conversation ||
        execution.sessionId !== authorization.sessionId ||
        execution.conversationId !== authorization.conversationId) return null;
    const expectedKind = PROVIDER_NATIVE_ID_KINDS[conversation.identity.provider];
    if (!expectedKind || conversation.identity.nativeIdKind !== expectedKind) return null;

    return Object.freeze({
      provider: conversation.identity.provider,
      identity: Object.freeze({ ...conversation.identity }),
      conversationId: execution.conversationId,
      executionId: execution.executionId,
      sessionId: execution.sessionId,
    });
  }

  function inspect(writer, sessionId, expectedProvider) {
    const authorization = registry.authorizeEvent(writer);
    if (!authorization.ok) {
      return { ok: false, status: authorization.status, executionId: authorization.executionId };
    }
    if (sessionId !== undefined && sessionId !== authorization.sessionId) {
      return { ok: false, status: 'mismatch', executionId: authorization.executionId };
    }
    const registration = registrationFor(authorization);
    if (!registration || (expectedProvider && registration.provider !== expectedProvider)) {
      return { ok: false, status: 'unverified', executionId: authorization.executionId };
    }
    return { ok: true, registration: cloneRegistration(registration) };
  }

  function projectionFor(registration) {
    let projection = projectionsByExecution.get(registration.executionId);
    if (!projection) {
      projection = {
        provider: registration.provider,
        conversationId: registration.conversationId,
        executionId: registration.executionId,
        sessionId: registration.sessionId,
        periodState: 'active',
        rootTurnState: 'unknown',
        actorStates: new Map(),
        dedupQuality: 'unknown',
        orderingQuality: 'unknown',
        reasons: new Set(),
        lastSequence: null,
        lastHookAtByActor: new Map(),
        orderingBlocked: false,
        sequenceGapBlocked: false,
        stateRecoveryBlocked: false,
        recoveryReason: null,
        events: new Map(),
      };
      projectionsByExecution.set(registration.executionId, projection);
    }
    return projection;
  }

  function markUnknown(registration, reason) {
    const projection = projectionFor(registration);
    const normalizedReason = UNKNOWN_REASONS.has(reason) ? reason : 'observation_unavailable';
    projection.reasons.add(normalizedReason);
    if (['collector_disconnected', 'event_gap', 'configuration_disabled', 'observation_unavailable', 'event_sequence_gap', 'event_sequence_regressed'].includes(normalizedReason)) {
      projection.stateRecoveryBlocked = true;
      projection.recoveryReason = normalizedReason;
    }
    return cloneProjection(projection);
  }

  function unknown(registration, reason) {
    return {
      action: 'unknown',
      status: 'unknown',
      reason,
      observation: markUnknown(registration, reason),
    };
  }

  function recordUnknownEvent(registration, dedupKeys, fingerprint, reason) {
    const result = unknown(registration, reason);
    for (const key of dedupKeys) {
      projectionFor(registration).events.set(key, {
        fingerprint,
        action: 'unknown',
        reason: result.reason,
      });
    }
    return result;
  }

  function updateKnownState(projection, event, actorId) {
    const eventName = event.hook_event_name;
    if (actorId) {
      const current = projection.actorStates.get(actorId) || { active: true, terminal: false, turn: 'unknown' };
      if (eventName === 'SubagentStart') projection.actorStates.set(actorId, { active: true, terminal: false, turn: 'working' });
      else if (eventName === 'SubagentStop') projection.actorStates.set(actorId, { active: false, terminal: true, turn: 'stopped' });
      else if (eventName === 'UserPromptSubmit') projection.actorStates.set(actorId, { ...current, turn: 'working' });
      else if (eventName === 'Stop') projection.actorStates.set(actorId, { ...current, turn: 'waiting' });
      else if (eventName === 'Interrupt') projection.actorStates.set(actorId, { ...current, turn: 'interrupted' });
      else if (eventName === 'SessionEnd') projection.actorStates.set(actorId, { active: false, terminal: true, turn: 'session_ended' });
      else if (['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(eventName)) {
        projection.actorStates.set(actorId, { ...current, turn: 'working' });
      }
      return;
    }

    if (eventName === 'SessionEnd') {
      projection.periodState = 'ended_observed';
      projection.rootTurnState = 'ended';
      for (const [id, state] of projection.actorStates) {
        projection.actorStates.set(id, { active: false, terminal: true, turn: 'session_ended' });
      }
    } else if (eventName === 'SessionStart' && ['startup', 'resume', 'clear'].includes(event.source)) {
      projection.rootTurnState = 'waiting';
    } else if (eventName === 'UserPromptSubmit' || ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(eventName)) {
      projection.rootTurnState = 'working';
    } else if (eventName === 'Stop') {
      projection.rootTurnState = 'waiting';
    } else if (eventName === 'Interrupt') {
      projection.rootTurnState = 'interrupted';
    }
  }

  function project({ writer, sessionId, event, provider: expectedProvider } = {}) {
    const checked = inspect(writer, sessionId, expectedProvider);
    if (!checked.ok) return { action: 'reject', status: checked.status };
    if (!isRecord(event)) return unknown(checked.registration, 'unsupported_event');

    const registration = checked.registration;
    const projection = projectionFor(registration);
    const nativeEvent = isRecord(event.nativeEvent) ? event.nativeEvent : null;
    const nativeSessionId = nativeEvent && (registration.provider === 'codex'
      ? (nativeEvent.thread_id ?? nativeEvent.session_id)
      : nativeEvent.session_id);
    if (nativeEvent && nativeSessionId !== registration.identity.nativeId) {
      return { action: 'reject', status: 'mismatch' };
    }

    const outerEventName = event.hook_event_name;
    const nativeEventName = nativeEvent && (nativeEvent.hook_event_name ?? nativeEvent.event_name);
    if (outerEventName && nativeEventName && outerEventName !== nativeEventName) {
      return unknown(registration, 'event_name_mismatch');
    }
    const hookEventName = outerEventName || nativeEventName;
    const semanticUnknownReason = hookEventName === 'PermissionRequest' ? 'permission_unresolved' : null;
    if (typeof hookEventName !== 'string' || (!EVENT_NAMES.has(hookEventName) && !semanticUnknownReason)) {
      return unknown(registration, 'unsupported_event');
    }

    const nativeAgentId = nativeEvent && nativeEvent.agent_id;
    const eventAgentId = event.agent_id;
    if (nativeAgentId && eventAgentId && nativeAgentId !== eventAgentId) {
      return unknown(registration, 'actor_binding_mismatch');
    }
    const observedAgentId = nativeAgentId || eventAgentId || '';
    let actorId = '';
    if (observedAgentId) {
      if (!resolveActorCorrelation) return unknown(registration, 'actor_correlation_unavailable');
      let correlation;
      try {
        correlation = resolveActorCorrelation({
          provider: registration.provider,
          registration: cloneRegistration(registration),
          event: { ...event, hook_event_name: hookEventName },
          nativeEvent: nativeEvent ? { ...nativeEvent } : null,
        });
      } catch {
        return unknown(registration, 'actor_correlation_failed');
      }
      if (correlation && correlation.status === 'unavailable') return unknown(registration, 'actor_correlation_unavailable');
      const binding = correlation && correlation.binding;
      const actor = correlation && correlation.actor;
      if (!correlation || correlation.status !== 'verified' || !binding ||
          binding.conversationId !== registration.conversationId ||
          binding.executionId !== registration.executionId ||
          binding.sessionId !== registration.sessionId ||
          !identitiesEqual(binding.identity, registration.identity) ||
          !actor || actor.kind !== 'agent' || actor.id !== observedAgentId || !safeIdentifier(actor.id)) {
        return unknown(registration, 'actor_binding_mismatch');
      }
      actorId = actor.id;
    }

    const normalizedEvent = { ...event, session_id: registration.sessionId, hook_event_name: hookEventName };
    delete normalizedEvent.writer;
    if (actorId) normalizedEvent.agent_id = actorId;
    else delete normalizedEvent.agent_id;

    const nativeEventId = (nativeEvent && (nativeEvent.nativeEventId ?? nativeEvent.event_id)) ?? event.nativeEventId;
    const sequence = nativeEvent && (nativeEvent.sequence_number ?? nativeEvent.sequenceNumber);
    const validEventId = safeIdentifier(nativeEventId);
    const validSequence = Number.isSafeInteger(sequence) && sequence >= 0;
    const fingerprint = eventFingerprint(normalizedEvent);
    const dedupKeys = [
      ...(validEventId ? [`id:${nativeEventId}`] : []),
      ...(validSequence ? [`sequence:${sequence}`] : []),
    ];

    for (const key of dedupKeys) {
      const existing = projection.events.get(key);
      if (!existing) continue;
      if (existing.fingerprint === fingerprint) {
        return existing.action === 'unknown'
          ? unknown(registration, existing.reason || 'event_sequence_gap')
          : { action: 'duplicate', status: 'accepted', observation: cloneProjection(projection) };
      }
      return unknown(registration, 'event_id_content_conflict');
    }

    if (projection.periodState === 'ended_observed') return unknown(registration, 'period_end_observed');
    if (projection.stateRecoveryBlocked) return unknown(registration, projection.recoveryReason || 'observation_unavailable');
    if (validEventId || validSequence) projection.dedupQuality = 'confirmed';
    else {
      projection.dedupQuality = 'unknown';
      projection.reasons.add('event_id_missing');
    }
    if (!validSequence) {
      projection.orderingQuality = 'unknown';
      projection.reasons.add('event_sequence_missing');
      projection.orderingBlocked = true;
    } else if (projection.sequenceGapBlocked) {
      projection.orderingQuality = 'unknown';
      const result = unknown(registration, 'event_sequence_gap');
      for (const key of dedupKeys) projection.events.set(key, {
        fingerprint,
        action: 'unknown',
        reason: result.reason,
      });
      return result;
    } else if (projection.lastSequence !== null && sequence <= projection.lastSequence) {
      projection.orderingQuality = 'unknown';
      projection.orderingBlocked = true;
      projection.sequenceGapBlocked = true;
      const result = unknown(registration, 'event_sequence_regressed');
      for (const key of dedupKeys) projection.events.set(key, {
        fingerprint,
        action: 'unknown',
        reason: result.reason,
      });
      return result;
    } else if (projection.lastSequence !== null && sequence !== projection.lastSequence + 1) {
      projection.orderingQuality = 'unknown';
      projection.orderingBlocked = true;
      projection.sequenceGapBlocked = true;
      projection.lastSequence = sequence;
      const result = unknown(registration, 'event_sequence_gap');
      for (const key of dedupKeys) projection.events.set(key, {
        fingerprint,
        action: 'unknown',
        reason: result.reason,
      });
      return result;
    } else {
      projection.orderingQuality = 'confirmed';
      projection.lastSequence = sequence;
    }

    const actorWatermarkKey = actorId || '';
    const hookAt = normalizedEvent.hookAt;
    const actorWatermark = projection.lastHookAtByActor.get(actorWatermarkKey);
    if (!validSequence && typeof hookAt === 'number' && Number.isFinite(hookAt) &&
        typeof actorWatermark === 'number' && hookAt < actorWatermark) {
      return recordUnknownEvent(registration, dedupKeys, fingerprint, 'event_order_unverified');
    }
    if (typeof hookAt === 'number' && Number.isFinite(hookAt) &&
        (typeof actorWatermark !== 'number' || hookAt > actorWatermark)) {
      projection.lastHookAtByActor.set(actorWatermarkKey, hookAt);
    }

    if (actorId && projection.actorStates.get(actorId)?.terminal) {
      return recordUnknownEvent(registration, dedupKeys, fingerprint, 'actor_reactivation_unverified');
    }
    if (semanticUnknownReason) {
      return recordUnknownEvent(registration, dedupKeys, fingerprint, semanticUnknownReason);
    }

    if (['PostToolUse', 'PostToolUseFailure'].includes(hookEventName) && !safeIdentifier(normalizedEvent.tool_use_id)) {
      return recordUnknownEvent(registration, dedupKeys, fingerprint, 'tool_result_missing');
    }

    for (const key of dedupKeys) projection.events.set(key, { fingerprint, action: 'apply' });
    updateKnownState(projection, normalizedEvent, actorId);
    return {
      action: 'apply',
      status: 'accepted',
      event: normalizedEvent,
      observation: cloneProjection(projection),
    };
  }

  function observeUnknown({ writer, sessionId, reason, provider: expectedProvider } = {}) {
    const checked = inspect(writer, sessionId, expectedProvider);
    if (!checked.ok) return { ok: false, status: checked.status };
    const observation = markUnknown(checked.registration, reason);
    return { ok: true, observation };
  }

  function snapshot() {
    const executions = new Map(registry.snapshot().executions.map((execution) => [execution.executionId, execution]));
    return [...projectionsByExecution.values()]
      .map((projection) => {
        const execution = executions.get(projection.executionId);
        const registeredPeriodState = execution?.state === 'active' || execution?.state === 'ended'
          ? execution.state
          : 'unknown';
        return cloneProjection(projection, registeredPeriodState);
      })
      .sort((left, right) => left.executionId.localeCompare(right.executionId));
  }

  return Object.freeze({ inspect, project, observeUnknown, snapshot });
}

function createProviderEventAdapter(provider, projection) {
  if (!PROVIDERS.has(provider)) throw new TypeError('unsupported event provider');
  if (!projection || typeof projection.project !== 'function' || typeof projection.observeUnknown !== 'function' ||
      typeof projection.inspect !== 'function') {
    throw new TypeError('provider event adapter requires a projection');
  }

  function normalize(event) {
    if (!isRecord(event)) return { ok: false, reason: 'unsupported_event' };
    const nativeEvent = isRecord(event.nativeEvent) ? event.nativeEvent : null;
    const outerName = event.hook_event_name;
    const nativeName = nativeEvent && (nativeEvent.hook_event_name ?? nativeEvent.event_name);
    if (outerName && nativeName && outerName !== nativeName) {
      return { ok: false, reason: 'event_name_mismatch' };
    }
    if (nativeEvent?.agent_id && event.agent_id && nativeEvent.agent_id !== event.agent_id) {
      return { ok: false, reason: 'actor_binding_mismatch' };
    }

    const normalized = { ...event, hook_event_name: outerName || nativeName };
    if (nativeEvent) {
      for (const field of NATIVE_COMMON_FIELDS) {
        const value = nativeEvent[field];
        if (value === undefined) continue;
        const target = field === 'hook_at' ? 'hookAt' : field === 'decision_resolution' ? 'decisionResolution' : field;
        if (COMMON_EVENT_FIELDS.has(target) || target === 'hookAt') normalized[target] = value;
      }
      normalized.nativeEvent = { ...nativeEvent };
    }
    return { ok: true, event: normalized };
  }

  function project(input = {}) {
    const event = input.event;
    const sessionId = input.sessionId ?? event?.session_id;
    const checked = projection.inspect(input.writer, sessionId, provider);
    if (!checked.ok) return { action: 'reject', status: checked.status };
    const prepared = normalize(event);
    if (!prepared.ok) {
      const observed = projection.observeUnknown({
        writer: input.writer,
        sessionId,
        provider,
        reason: prepared.reason,
      });
      return observed.ok
        ? { action: 'unknown', status: 'unknown', reason: prepared.reason, observation: observed.observation }
        : { action: 'reject', status: observed.status };
    }
    return projection.project({
      ...input,
      provider,
      sessionId,
      event: prepared.event,
    });
  }

  return Object.freeze({ provider, normalize, project });
}

module.exports = { createProviderEventProjection, createProviderEventAdapter };
