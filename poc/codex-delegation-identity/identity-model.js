'use strict';

const { randomUUID } = require('node:crypto');

const ORIGINS = new Set(['standalone', 'delegated', 'review']);
const PARENT_PROVIDERS = new Set(['claude', 'claude-code', 'codex']);
const NATIVE_EVENT_TYPES = new Set([
  'thread.started', 'thread.updated', 'thread.closed',
  'turn.started', 'turn.completed', 'turn.failed', 'turn.interrupted', 'turn.cancelled',
  'Stop', 'stop',
]);
const NATIVE_STATUSES = new Set([
  'queued', 'started', 'in_progress', 'running', 'completed', 'succeeded',
  'failed', 'errored', 'error', 'cancelled', 'interrupted', 'incomplete', 'unknown',
]);
const AUDIT_KINDS = new Set(['run_started', 'wait', 'result', 'execution_end', 'unknown_end', 'handoff', 'stop']);
const WAIT_STATUSES = new Set(['waiting', 'vanished', 'orphaned', 'unverified', 'not-found']);
const RESULT_STATUSES = new Set(['ok', 'completed', 'rate-limited', 'unavailable', 'failed']);
const EXECUTION_END_STATUSES = new Set(['completed', 'succeeded', 'failed', 'interrupted', 'unknown_end']);
const ANSWER_TYPES = new Set(['tasks', 'decision', 'pull_request']);
const TERMINAL_STATUSES = new Set(['completed', 'failed', 'rate_limited', 'unavailable', 'interrupted', 'unknown_end']);
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CREDENTIAL_PREFIX = /^\s*(?:bearer(?:\s+|:)|basic(?:\s+|:)|token(?:\s+|:)|sk-\S+|gh[pousr]_\S+|github_pat_\S+|xox[baprs]-\S+|ya29\.\S+|eyj[a-z0-9_-]+\.[a-z0-9_-]+|(?:api[_-]?key|access[_-]?token|secret)\s*[:=])/i;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function hasOnlyKeys(value, allowed) {
  return isRecord(value) && Object.keys(value).every((key) => allowed.has(key));
}

function safeIdentifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) && !CREDENTIAL_PREFIX.test(value);
}

function normalizeParent(value) {
  if (value === undefined || value === null) return null;
  if (!hasOnlyKeys(value, new Set(['provider', 'sessionId', 'agentId', 'toolUseId']))) return null;
  if (!PARENT_PROVIDERS.has(value.provider) || !safeIdentifier(value.sessionId)) return null;
  const parent = { provider: value.provider, sessionId: value.sessionId };
  for (const key of ['agentId', 'toolUseId']) {
    if (value[key] !== undefined && value[key] !== null) {
      if (!safeIdentifier(value[key])) return null;
      parent[key] = value[key];
    }
  }
  if (!parent.agentId && !parent.toolUseId) return null;
  return parent;
}

function tupleKey(launchId, runId, attemptId) {
  return JSON.stringify([launchId || null, runId, attemptId || null]);
}

function runAttemptKey(runId, attemptId) {
  return JSON.stringify([runId, attemptId]);
}

function nativeKey(hostId, homeScope, threadId) {
  return JSON.stringify([hostId, homeScope, threadId]);
}

function publicLaunch(launch) {
  return {
    launchId: launch.launchId,
    runId: launch.runId,
    attemptId: launch.attemptId,
    origin: launch.origin,
    hostId: launch.hostId,
    homeScope: launch.homeScope,
    parent: launch.parent ? { ...launch.parent } : null,
  };
}

function mappedResultStatus(status) {
  if (status === 'ok' || status === 'completed' || status === 'succeeded') return 'completed';
  if (status === 'rate-limited') return 'rate_limited';
  return status;
}

function makeLaunch(record) {
  return {
    ...record,
    parent: record.parent ? { ...record.parent } : null,
    nativeKey: null,
    runStatus: 'registered',
    resultStatus: null,
    resultExitCode: null,
    waitStatus: null,
    ownerGeneration: 0,
    auditEvents: [],
    native: null,
    deliveryCount: 0,
  };
}

function makeNativeThread(hostId, homeScope, threadId) {
  return {
    key: nativeKey(hostId, homeScope, threadId),
    hostId,
    homeScope,
    threadId,
    bindingLaunchId: null,
    candidate: null,
    eventCount: 0,
    eventTypes: new Set(),
    statuses: new Set(),
    stopSeen: false,
    terminalTurnSeen: false,
  };
}

function eventFingerprint(event) {
  const normalized = { ...event };
  delete normalized.eventId;
  delete normalized.notificationId;
  return JSON.stringify(normalized);
}

function acceptEventOnce(index, scopeKey, event, fingerprint) {
  const ids = [...new Set([event.eventId, event.notificationId].filter(Boolean))];
  if (ids.length === 0) return false;
  let duplicate = false;
  for (const id of ids) {
    const key = JSON.stringify([scopeKey, id]);
    if (!index.has(key)) continue;
    if (index.get(key) !== fingerprint) return false;
    duplicate = true;
  }
  for (const id of ids) index.set(JSON.stringify([scopeKey, id]), fingerprint);
  return duplicate ? 'duplicate' : 'new';
}

function cloneSafeRow(row) {
  return {
    ...row,
    parent: row.parent ? { ...row.parent } : null,
    native: row.native ? { ...row.native, event_types: [...row.native.event_types], statuses: [...row.native.statuses] } : null,
    audit: { ...row.audit, kinds: [...row.audit.kinds], wait_statuses: [...row.audit.wait_statuses] },
  };
}

class DelegationIdentityModel {
  constructor(options = {}) {
    this.randomId = options.randomId || randomUUID;
    this.launches = new Map();
    this.attempts = new Map();
    this.nativeThreads = new Map();
    this.nativeEventIds = new Map();
    this.auditEventIds = new Map();
    this.orphanAudits = new Map();
    this.deliveryIds = new Set();
  }

  registerLaunch(input) {
    const allowed = new Set(['launchId', 'runId', 'attemptId', 'origin', 'hostId', 'homeScope', 'parent', 'bindingNonce']);
    if (!hasOnlyKeys(input, allowed)
      || !safeIdentifier(input.runId)
      || !safeIdentifier(input.attemptId)
      || !ORIGINS.has(input.origin)
      || !safeIdentifier(input.hostId)
      || !safeIdentifier(input.homeScope)
      || typeof input.bindingNonce !== 'string'
      || !/^[a-f0-9]{64}$/i.test(input.bindingNonce)) return null;
    const parent = normalizeParent(input.parent);
    if (input.origin === 'standalone' ? input.parent !== undefined && input.parent !== null : !parent) return null;
    if (input.parent !== undefined && input.parent !== null && !parent) return null;

    const launchId = input.launchId === undefined ? this.randomId() : input.launchId;
    if (!safeIdentifier(launchId)) return null;
    const attempt = runAttemptKey(input.runId, input.attemptId);
    const existing = this.launches.get(launchId);
    if (existing) {
      const same = existing.runId === input.runId && existing.attemptId === input.attemptId
        && existing.origin === input.origin && existing.hostId === input.hostId
        && existing.homeScope === input.homeScope && existing.bindingNonce === input.bindingNonce
        && JSON.stringify(existing.parent) === JSON.stringify(parent);
      return same ? publicLaunch(existing) : null;
    }
    if (this.attempts.has(attempt)) return null;

    const launch = makeLaunch({
      launchId,
      runId: input.runId,
      attemptId: input.attemptId,
      origin: input.origin,
      hostId: input.hostId,
      homeScope: input.homeScope,
      parent,
      bindingNonce: input.bindingNonce,
      attemptKey: tupleKey(launchId, input.runId, input.attemptId),
    });
    this.launches.set(launchId, launch);
    this.attempts.set(attempt, launchId);
    this.attachOrphanAudit(launch);
    return publicLaunch(launch);
  }

  bindNative(input) {
    const allowed = new Set(['launchId', 'runId', 'attemptId', 'bindingNonce', 'hostId', 'homeScope', 'threadId']);
    if (!hasOnlyKeys(input, allowed)
      || !safeIdentifier(input.launchId)
      || !safeIdentifier(input.runId)
      || !safeIdentifier(input.attemptId)
      || !safeIdentifier(input.hostId)
      || !safeIdentifier(input.homeScope)
      || !safeIdentifier(input.threadId)
      || typeof input.bindingNonce !== 'string'
      || !/^[a-f0-9]{64}$/i.test(input.bindingNonce)) return false;
    const launch = this.launches.get(input.launchId);
    if (!launch || launch.runId !== input.runId || launch.attemptId !== input.attemptId
      || launch.hostId !== input.hostId || launch.homeScope !== input.homeScope
      || launch.bindingNonce !== input.bindingNonce) return false;

    const key = nativeKey(input.hostId, input.homeScope, input.threadId);
    if (launch.nativeKey && launch.nativeKey !== key) return false;
    const collision = [...this.launches.values()].find((candidate) => candidate !== launch && candidate.nativeKey === key);
    if (collision) return false;
    let native = this.nativeThreads.get(key);
    if (native && native.bindingLaunchId && native.bindingLaunchId !== launch.launchId) return false;
    if (native?.candidate && tupleKey(
      native.candidate.launchId, native.candidate.runId, native.candidate.attemptId,
    ) !== launch.attemptKey) return false;
    if (!native) {
      native = makeNativeThread(input.hostId, input.homeScope, input.threadId);
      this.nativeThreads.set(key, native);
    }
    launch.nativeKey = key;
    native.bindingLaunchId = launch.launchId;
    native.candidate = { launchId: launch.launchId, runId: launch.runId, attemptId: launch.attemptId };
    launch.native = native;
    return true;
  }

  ingestNative(input) {
    if (!isRecord(input)) return false;
    const allowed = new Set([
      'eventId', 'notificationId', 'hostId', 'homeScope', 'threadId', 'turnId', 'type', 'status',
      'launchId', 'runId', 'attemptId',
    ]);
    const hasEventId = input.eventId !== undefined;
    const hasNotificationId = input.notificationId !== undefined;
    if (!hasOnlyKeys(input, allowed)
      || (!hasEventId && !hasNotificationId)
      || (hasEventId && !safeIdentifier(input.eventId))
      || (hasNotificationId && !safeIdentifier(input.notificationId))
      || !safeIdentifier(input.hostId) || !safeIdentifier(input.homeScope) || !safeIdentifier(input.threadId)
      || !NATIVE_EVENT_TYPES.has(input.type)) return false;
    if (input.turnId !== undefined && !safeIdentifier(input.turnId)) return false;
    if (input.status !== undefined && !NATIVE_STATUSES.has(input.status)) return false;
    const correlationKeys = ['launchId', 'runId', 'attemptId'].filter((key) => input[key] !== undefined);
    if (correlationKeys.length !== 0 && correlationKeys.length !== 3) return false;
    if (correlationKeys.some((key) => !safeIdentifier(input[key]))) return false;

    const event = {
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.notificationId ? { notificationId: input.notificationId } : {}),
      hostId: input.hostId,
      homeScope: input.homeScope,
      threadId: input.threadId,
      ...(input.turnId ? { turnId: input.turnId } : {}),
      type: input.type,
      ...(input.status ? { status: input.status } : {}),
      ...(correlationKeys.length ? {
        launchId: input.launchId, runId: input.runId, attemptId: input.attemptId,
      } : {}),
    };
    const key = nativeKey(event.hostId, event.homeScope, event.threadId);
    const existingNative = this.nativeThreads.get(key);
    const correlation = correlationKeys.length
      ? { launchId: event.launchId, runId: event.runId, attemptId: event.attemptId }
      : null;
    if (existingNative?.bindingLaunchId && correlation && tupleKey(
      correlation.launchId, correlation.runId, correlation.attemptId,
    ) !== tupleKey(
      existingNative.candidate?.launchId, existingNative.candidate?.runId, existingNative.candidate?.attemptId,
    )) return false;
    const duplicate = acceptEventOnce(this.nativeEventIds, key, event, eventFingerprint(event));
    if (duplicate === false) return false;
    if (duplicate === 'duplicate') return true;

    let native = this.nativeThreads.get(key);
    if (!native) {
      native = makeNativeThread(event.hostId, event.homeScope, event.threadId);
      this.nativeThreads.set(key, native);
    }
    if (correlation) native.candidate = correlation;
    native.eventCount += 1;
    native.eventTypes.add(event.type);
    if (event.status) native.statuses.add(event.status);
    if (event.type === 'Stop' || event.type === 'stop') native.stopSeen = true;
    if (['turn.completed', 'turn.failed', 'turn.interrupted', 'turn.cancelled'].includes(event.type)) {
      native.terminalTurnSeen = true;
    }
    const launch = native.bindingLaunchId ? this.launches.get(native.bindingLaunchId) : null;
    if (launch) launch.native = native;
    return true;
  }

  ingestAudit(input) {
    if (!isRecord(input)) return false;
    const allowed = new Set([
      'eventId', 'notificationId', 'launchId', 'runId', 'attemptId', 'kind', 'status', 'exitCode',
      'generation', 'parent',
    ]);
    const hasEventId = input.eventId !== undefined;
    const hasNotificationId = input.notificationId !== undefined;
    if (!hasOnlyKeys(input, allowed)
      || (!hasEventId && !hasNotificationId)
      || (hasEventId && !safeIdentifier(input.eventId))
      || (hasNotificationId && !safeIdentifier(input.notificationId))
      || !AUDIT_KINDS.has(input.kind)) return false;
    const hasLaunch = input.launchId !== undefined;
    if (hasLaunch && (!safeIdentifier(input.launchId) || !safeIdentifier(input.runId) || !safeIdentifier(input.attemptId))) return false;
    if (!hasLaunch && input.runId !== undefined && !safeIdentifier(input.runId)) return false;
    if (!hasLaunch && input.attemptId !== undefined && !safeIdentifier(input.attemptId)) return false;
    if (!safeIdentifier(input.runId)) return false;
    if (input.kind === 'wait' && !WAIT_STATUSES.has(input.status)) return false;
    if (input.kind === 'result' && !RESULT_STATUSES.has(input.status)) return false;
    if (input.kind === 'execution_end' && !EXECUTION_END_STATUSES.has(input.status)) return false;
    if (input.kind === 'unknown_end' && input.status !== undefined && !WAIT_STATUSES.has(input.status)) return false;
    if (input.kind === 'handoff' && (!Number.isSafeInteger(input.generation) || input.generation < 1)) return false;
    if (input.kind === 'stop' && input.status !== undefined && input.status !== 'Stop') return false;
    if (input.exitCode !== undefined && (!Number.isSafeInteger(input.exitCode) || input.exitCode < 0)) return false;
    const parent = input.parent === undefined ? null : normalizeParent(input.parent);
    if (input.parent !== undefined && !parent) return false;
    if (input.kind === 'handoff' ? !hasLaunch || !parent : input.parent !== undefined) return false;
    if (input.kind !== 'handoff' && input.generation !== undefined) return false;
    if (!['result', 'execution_end'].includes(input.kind) && input.exitCode !== undefined) return false;
    if (input.kind === 'run_started' && input.status !== undefined) return false;
    if (input.kind === 'stop' && (input.generation !== undefined || input.exitCode !== undefined)) return false;

    const event = {
      ...(input.eventId ? { eventId: input.eventId } : {}),
      ...(input.notificationId ? { notificationId: input.notificationId } : {}),
      ...(hasLaunch ? { launchId: input.launchId } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      ...(input.attemptId ? { attemptId: input.attemptId } : {}),
      kind: input.kind,
      ...(input.status ? { status: input.status } : {}),
      ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
      ...(input.generation !== undefined ? { generation: input.generation } : {}),
      ...(parent ? { parent } : {}),
    };
    const auditKey = tupleKey(hasLaunch ? input.launchId : null, input.runId, input.attemptId);
    const attempt = hasLaunch ? this.launches.get(input.launchId) : null;
    const matches = attempt && attempt.runId === input.runId && attempt.attemptId === input.attemptId;
    const resultStatus = input.kind === 'result' ? mappedResultStatus(input.status) : null;
    const resultExitCode = input.exitCode === undefined ? null : input.exitCode;
    if (matches && resultStatus && attempt.resultStatus
      && (attempt.resultStatus !== resultStatus || attempt.resultExitCode !== resultExitCode)) return false;
    if (matches && input.kind === 'handoff') {
      if (input.generation < attempt.ownerGeneration) return false;
      if (input.generation === attempt.ownerGeneration) {
        return JSON.stringify(attempt.parent) === JSON.stringify(parent);
      }
    }
    if (input.kind === 'handoff' && !matches) return false;
    const duplicate = acceptEventOnce(this.auditEventIds, auditKey, event, eventFingerprint(event));
    if (duplicate === false) return false;
    if (duplicate === 'duplicate') return true;

    if (matches) {
      attempt.auditEvents.push(event);
      this.applyAuditEvent(attempt, event);
      return true;
    }
    let orphan = this.orphanAudits.get(auditKey);
    if (!orphan) {
      orphan = {
        launchId: hasLaunch ? input.launchId : null,
        runId: input.runId || null,
        attemptId: input.attemptId || null,
        events: [],
      };
      this.orphanAudits.set(auditKey, orphan);
    }
    orphan.events.push(event);
    return true;
  }

  resolveMcpDestination(input) {
    const allowed = new Set(['hostId', 'homeScope', 'threadId', 'launchId', 'bindingNonce']);
    if (!hasOnlyKeys(input, allowed)
      || !safeIdentifier(input.hostId) || !safeIdentifier(input.homeScope) || !safeIdentifier(input.threadId)) return null;
    if (input.launchId !== undefined && !safeIdentifier(input.launchId)) return null;
    if (input.bindingNonce !== undefined && (typeof input.bindingNonce !== 'string' || !/^[a-f0-9]{64}$/i.test(input.bindingNonce))) return null;
    const key = nativeKey(input.hostId, input.homeScope, input.threadId);
    const native = this.nativeThreads.get(key);
    if (!native) return null;
    const launch = native.bindingLaunchId ? this.launches.get(native.bindingLaunchId) : null;
    if (native.candidate && !launch) return null;
    if (input.launchId !== undefined && (!launch || launch.launchId !== input.launchId)) return null;
    if (input.bindingNonce !== undefined && (!launch || launch.bindingNonce !== input.bindingNonce)) return null;
    if (launch) return this.destinationFor(launch, native);
    return null;
  }

  project() {
    const rows = [];
    const projectedLaunchIds = new Set();
    for (const native of this.nativeThreads.values()) {
      const launch = native.bindingLaunchId ? this.launches.get(native.bindingLaunchId) : null;
      if (launch) projectedLaunchIds.add(launch.launchId);
      const kind = launch
        ? (launch.origin === 'standalone' ? 'independent' : 'confirmed_delegated')
        : 'related_unknown';
      const source = launch;
      rows.push({
        row_id: launch ? `launch:${launch.launchId}` : `native:${native.key}`,
        kind,
        origin: source?.origin || null,
        host_id: native.hostId,
        home_scope: native.homeScope,
        thread_id: native.threadId,
        launch_id: source?.launchId || native.candidate?.launchId || null,
        run_id: source?.runId || native.candidate?.runId || null,
        attempt_id: source?.attemptId || native.candidate?.attemptId || null,
        parent: source?.parent ? { ...source.parent } : null,
        execution_status: source?.runStatus || 'unknown',
        native: {
          event_count: native.eventCount,
          event_types: [...native.eventTypes].sort(),
          statuses: [...native.statuses].sort(),
          stop_seen: native.stopSeen,
          terminal_turn_seen: native.terminalTurnSeen,
        },
        audit: source ? this.auditSummary(source.auditEvents) : { event_count: 0, kinds: [], wait_statuses: [] },
        delivery_count: source?.deliveryCount || 0,
      });
    }

    for (const launch of this.launches.values()) {
      if (projectedLaunchIds.has(launch.launchId)) continue;
      rows.push({
        row_id: `launch:${launch.launchId}`,
        kind: launch.auditEvents.length ? 'audit_only' : 'related_unknown',
        origin: launch.origin,
        host_id: launch.hostId,
        home_scope: launch.homeScope,
        thread_id: null,
        launch_id: launch.launchId,
        run_id: launch.runId,
        attempt_id: launch.attemptId,
        parent: launch.parent ? { ...launch.parent } : null,
        execution_status: launch.runStatus,
        native: null,
        audit: this.auditSummary(launch.auditEvents),
        delivery_count: launch.deliveryCount,
      });
    }

    for (const orphan of this.orphanAudits.values()) {
      rows.push({
        row_id: `audit:${JSON.stringify([orphan.launchId, orphan.runId, orphan.attemptId])}`,
        kind: 'audit_only',
        origin: null,
        host_id: null,
        home_scope: null,
        thread_id: null,
        launch_id: orphan.launchId,
        run_id: orphan.runId,
        attempt_id: orphan.attemptId,
        parent: null,
        execution_status: this.orphanStatus(orphan.events),
        native: null,
        audit: this.auditSummary(orphan.events),
        delivery_count: 0,
      });
    }

    rows.sort((left, right) => left.row_id.localeCompare(right.row_id));
    const counts = {
      total: rows.length,
      independent: rows.filter((row) => row.kind === 'independent').length,
      confirmed_delegated: rows.filter((row) => row.kind === 'confirmed_delegated').length,
      related_unknown: rows.filter((row) => row.kind === 'related_unknown').length,
      audit_only: rows.filter((row) => row.kind === 'audit_only').length,
      running: rows.filter((row) => row.execution_status === 'running').length,
      unknown_end: rows.filter((row) => row.execution_status === 'unknown_end').length,
    };
    return { counts, rows: rows.map(cloneSafeRow) };
  }

  routeAnswer(input) {
    const allowed = new Set(['hostId', 'homeScope', 'threadId', 'launchId', 'bindingNonce', 'deliveryId', 'type']);
    const rejected = (reason) => ({ accepted: false, reason });
    if (!hasOnlyKeys(input, allowed)
      || !safeIdentifier(input.deliveryId)
      || !safeIdentifier(input.hostId)
      || !safeIdentifier(input.homeScope)
      || !safeIdentifier(input.threadId)
      || (input.launchId !== undefined && !safeIdentifier(input.launchId))
      || (input.bindingNonce !== undefined
        && (typeof input.bindingNonce !== 'string' || !/^[a-f0-9]{64}$/i.test(input.bindingNonce)))
      || !ANSWER_TYPES.has(input.type)) return rejected('invalid_input');
    const destination = this.resolveMcpDestination({
      hostId: input.hostId,
      homeScope: input.homeScope,
      threadId: input.threadId,
      ...(input.launchId === undefined ? {} : { launchId: input.launchId }),
      ...(input.bindingNonce === undefined ? {} : { bindingNonce: input.bindingNonce }),
    });
    if (!destination) return rejected('unknown_destination');
    if (this.deliveryIds.has(input.deliveryId)) return rejected('duplicate_delivery');
    const launch = destination.launchId ? this.launches.get(destination.launchId) : null;
    if (launch && TERMINAL_STATUSES.has(launch.runStatus)) return rejected('terminal_execution');
    this.deliveryIds.add(input.deliveryId);
    if (launch) launch.deliveryCount += 1;
    return { accepted: true, reason: 'accepted', destination };
  }

  destinationFor(launch, native) {
    return {
      kind: launch.origin === 'standalone' ? 'independent' : 'delegated',
      hostId: native.hostId,
      homeScope: native.homeScope,
      threadId: native.threadId,
      launchId: launch.launchId,
      runId: launch.runId,
      attemptId: launch.attemptId,
      parent: launch.parent ? { ...launch.parent } : null,
    };
  }

  applyAuditEvent(launch, event) {
    if (event.kind === 'handoff') {
      if (event.generation > launch.ownerGeneration) {
        launch.parent = { ...event.parent };
        launch.ownerGeneration = event.generation;
      }
      return;
    }
    if (event.kind === 'stop') return;
    if (TERMINAL_STATUSES.has(launch.runStatus)
      && (launch.runStatus !== 'unknown_end' || event.kind !== 'result')) return;
    if (event.kind === 'run_started') {
      if (launch.runStatus === 'registered') launch.runStatus = 'running';
    } else if (event.kind === 'wait') {
      launch.waitStatus = event.status;
      if (event.status === 'waiting') launch.runStatus = 'waiting';
      else launch.runStatus = 'unknown_end';
    } else if (event.kind === 'unknown_end') {
      launch.runStatus = 'unknown_end';
      launch.waitStatus = event.status || launch.waitStatus;
    } else if (event.kind === 'result') {
      const status = mappedResultStatus(event.status);
      if (launch.resultStatus) return;
      launch.resultStatus = status;
      launch.resultExitCode = event.exitCode === undefined ? null : event.exitCode;
      launch.runStatus = status;
    } else if (event.kind === 'execution_end') {
      const status = event.status === 'succeeded' ? 'completed' : event.status;
      launch.runStatus = launch.origin === 'standalone' ? status : 'unknown_end';
    }
  }

  attachOrphanAudit(launch) {
    const orphan = this.orphanAudits.get(launch.attemptKey);
    if (!orphan) return;
    launch.auditEvents.push(...orphan.events);
    for (const event of orphan.events) this.applyAuditEvent(launch, event);
    this.orphanAudits.delete(launch.attemptKey);
  }

  auditSummary(events) {
    return {
      event_count: events.length,
      kinds: [...new Set(events.map((event) => event.kind))].sort(),
      wait_statuses: [...new Set(events.filter((event) => event.kind === 'wait').map((event) => event.status))].sort(),
    };
  }

  orphanStatus(events) {
    let status = 'unknown';
    let explicitResult = null;
    for (const event of events) {
      if (event.kind === 'result') explicitResult ||= mappedResultStatus(event.status);
      else if (explicitResult) continue;
      else if (event.kind === 'run_started' && status === 'unknown') status = 'running';
      else if (event.kind === 'wait' && event.status === 'waiting') status = 'waiting';
      else if (event.kind === 'wait' && event.status !== 'waiting') status = 'unknown_end';
      else if (event.kind === 'unknown_end' || event.kind === 'execution_end') status = 'unknown_end';
    }
    return explicitResult || status;
  }
}

module.exports = { DelegationIdentityModel };
