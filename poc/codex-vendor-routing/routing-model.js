'use strict';

const path = require('node:path');

const ROUTE_VALUES = new Set(['default', 'claude', 'codex']);
const PROVIDERS = new Set(['claude', 'codex']);
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const TRANSPORTS = Object.freeze({
  claude: new Set(['externalClaude', 'bridgeBackend']),
  codex: new Set(['nativeCodex', 'bridgeBackend']),
});
const RESULT_CLASSIFICATIONS = new Set([
  'ok', 'rate_limited', 'unavailable', 'uninstalled', 'failed', 'timeout',
  'output_limit', 'invalid_result', 'cancelled', 'unknown',
]);
const EXIT_STATUSES = new Set(['exited', 'failed', 'cancelled', 'interrupted', 'unknown']);
const CANCEL_REASONS = new Set(['parent_ended', 'user_requested', 'timeout', 'superseded']);
const TRUST_SCOPE = 'registered_trusted_callers_only';
const MAX_DEPTH = 1;
const SAFE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const CREDENTIAL_PREFIX = /^\s*(?:bearer(?:\s+|:)|basic(?:\s+|:)|token(?:\s+|:)|sk-\S+|gh[pousr]_\S+|github_pat_\S+|xox[baprs]-\S+|ya29\.\S+|eyj[a-z0-9_-]+\.[a-z0-9_-]+|(?:api[_-]?key|access[_-]?token|secret)\s*[:=])/i;

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasKeys(value, required, optional = []) {
  if (!isRecord(value)) return false;
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return required.every((key) => Object.hasOwn(value, key)) && keys.every((key) => allowed.has(key));
}

function safeIdentifier(value) {
  return typeof value === 'string' && SAFE_IDENTIFIER.test(value) && !CREDENTIAL_PREFIX.test(value);
}

function safeAtom(value, maxLength = 128) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
    && !/[\u0000-\u001f\u007f]/.test(value) && !CREDENTIAL_PREFIX.test(value);
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  }
  return value;
}

function freeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function tupleKey(launchId, runId, attemptId) {
  return JSON.stringify([launchId, runId, attemptId]);
}

function parentSessionKey(parentSession) {
  return JSON.stringify([parentSession.provider, parentSession.sessionId]);
}

function nativeIdentityKey(identity) {
  const kind = Object.hasOwn(identity, 'threadId') ? 'thread' : 'session';
  const nativeId = kind === 'thread' ? identity.threadId : identity.sessionId;
  return JSON.stringify([identity.provider, kind, identity.hostId, identity.homeScope, nativeId]);
}

function normalizeParent(value) {
  if (!hasKeys(value, ['provider', 'sessionId'], ['agentId', 'toolUseId'])
    || !PROVIDERS.has(value.provider) || !safeIdentifier(value.sessionId)) return null;
  const parent = { provider: value.provider, sessionId: value.sessionId };
  for (const key of ['agentId', 'toolUseId']) {
    if (value[key] !== undefined) {
      if (!safeIdentifier(value[key])) return null;
      parent[key] = value[key];
    }
  }
  if (!parent.agentId && !parent.toolUseId) return null;
  return parent;
}

function normalizeRouteSnapshot(value) {
  if (!hasKeys(value, ['agents', 'review'])
    || !ROUTE_VALUES.has(value.agents) || !ROUTE_VALUES.has(value.review)) return null;
  return { agents: value.agents, review: value.review };
}

function normalizeProfile(value, vendor) {
  if (!hasKeys(value, ['model', 'effort', 'transport'])
    || !safeAtom(value.model) || !EFFORTS.has(value.effort)
    || !TRANSPORTS[vendor].has(value.transport)) return null;
  return { model: value.model, effort: value.effort, transport: value.transport };
}

function normalizeProfiles(value) {
  if (!hasKeys(value, ['claude', 'codex'])) return null;
  const claude = normalizeProfile(value.claude, 'claude');
  const codex = normalizeProfile(value.codex, 'codex');
  return claude && codex ? { claude, codex } : null;
}

function normalizeAncestor(value) {
  if (!hasKeys(value, ['launchId', 'runId', 'attemptId'])
    || !safeIdentifier(value.launchId) || !safeIdentifier(value.runId)
    || !safeIdentifier(value.attemptId)) return null;
  return { launchId: value.launchId, runId: value.runId, attemptId: value.attemptId };
}

function normalizeWorkspace(value) {
  if (!safeAtom(value, 2048) || !path.isAbsolute(value)
    || value.split(/[\\/]+/).includes('..')) return null;
  return value;
}

function normalizeActual(value) {
  if (value === undefined) return { model: null, effort: null };
  if (!hasKeys(value, [], ['model', 'effort'])
    || (value.model !== undefined && !safeAtom(value.model))
    || (value.effort !== undefined && !EFFORTS.has(value.effort))) return null;
  return {
    model: value.model === undefined ? null : value.model,
    effort: value.effort === undefined ? null : value.effort,
  };
}

function compatibleTransport(vendor, transport, parentProvider) {
  return TRANSPORTS[vendor]?.has(transport)
    && (transport !== 'nativeCodex' || (vendor === 'codex' && parentProvider === 'codex'));
}

function normalizeReservation(input) {
  if (!hasKeys(input, [
    'launchId', 'runId', 'attemptId', 'routeSnapshot', 'profiles', 'parent',
    'depth', 'ancestors', 'workspace',
  ])) return { value: null, reason: 'invalid_input' };
  if (!safeIdentifier(input.launchId) || !safeIdentifier(input.runId) || !safeIdentifier(input.attemptId)) {
    return { value: null, reason: 'invalid_input' };
  }
  const routeSnapshot = normalizeRouteSnapshot(input.routeSnapshot);
  const profiles = normalizeProfiles(input.profiles);
  const parent = normalizeParent(input.parent);
  const workspace = normalizeWorkspace(input.workspace);
  if (!routeSnapshot || !profiles || !parent || !workspace
    || !Number.isSafeInteger(input.depth) || input.depth < 1
    || !Array.isArray(input.ancestors) || input.ancestors.length > 32) {
    return { value: null, reason: 'invalid_input' };
  }
  const ancestors = input.ancestors.map(normalizeAncestor);
  if (ancestors.some((ancestor) => ancestor === null)) return { value: null, reason: 'invalid_input' };
  if (input.depth > MAX_DEPTH) return { value: null, reason: 'depth_limit' };

  const { launchId, runId, attemptId } = input;
  if (ancestors.some((ancestor) => ancestor.launchId === launchId
    || ancestor.runId === runId || ancestor.attemptId === attemptId)) {
    return { value: null, reason: 'ancestor_cycle' };
  }
  const seenAncestors = new Set();
  for (const ancestor of ancestors) {
    const key = tupleKey(ancestor.launchId, ancestor.runId, ancestor.attemptId);
    if (seenAncestors.has(key)) return { value: null, reason: 'ancestor_cycle' };
    seenAncestors.add(key);
  }

  const requestedRoute = routeSnapshot.agents;
  const resolvedVendor = requestedRoute === 'default' ? parent.provider : requestedRoute;
  const profile = profiles[resolvedVendor];
  if (!compatibleTransport(resolvedVendor, profile.transport, parent.provider)) {
    return { value: null, reason: 'incompatible_transport' };
  }
  return {
    value: {
      launchId,
      runId,
      attemptId,
      routeSnapshot,
      requestedRoute,
      resolvedVendor,
      transport: profile.transport,
      requestedProfile: { model: profile.model, effort: profile.effort },
      parent,
      depth: input.depth,
      ancestors,
      workspace,
    },
    reason: null,
  };
}

function action(accepted, reason, extra = {}) {
  return { accepted, reason, ...extra };
}

class RoutingModel {
  constructor() {
    this.launches = new Map();
    this.attempts = new Map();
    this.observations = new Map();
    this.nativeIdentities = new Map();
    this.resultIds = new Map();
    this.cancelIds = new Map();
    this.endedParentSessions = new Set();
  }

  reserveLaunch(input) {
    const parsed = normalizeReservation(input);
    if (!parsed.value) return action(false, parsed.reason);
    const reservation = parsed.value;
    const launchKey = tupleKey(reservation.launchId, reservation.runId, reservation.attemptId);
    const existing = this.launches.get(reservation.launchId);
    const sameAttempt = this.attempts.get(tupleKey(null, reservation.runId, reservation.attemptId));
    const snapshot = {
      launchId: reservation.launchId,
      runId: reservation.runId,
      attemptId: reservation.attemptId,
      routeSnapshot: reservation.routeSnapshot,
      requestedRoute: reservation.requestedRoute,
      resolvedVendor: reservation.resolvedVendor,
      transport: reservation.transport,
      requestedProfile: reservation.requestedProfile,
      parent: reservation.parent,
      depth: reservation.depth,
      ancestors: reservation.ancestors,
      workspace: reservation.workspace,
      permissions: { tools: 'none' },
    };
    if (existing) {
      return sameJson(existing.snapshot, snapshot)
        ? action(true, 'duplicate', { launch: this.publicLaunch(existing) })
        : action(false, 'launch_conflict');
    }
    if (sameAttempt) return action(false, 'attempt_conflict');
    if (this.endedParentSessions.has(parentSessionKey(reservation.parent))) return action(false, 'parent_ended');

    const launch = {
      snapshot: freeze(snapshot),
      startAuthorized: false,
      actualProfile: { model: null, effort: null },
      observations: new Map(),
      nativeIdentityKey: null,
      result: null,
      unknownExit: null,
      exit: null,
      cancelRequest: null,
      cancelConfirmed: false,
      parentReturnedResultId: null,
    };
    this.launches.set(reservation.launchId, launch);
    this.attempts.set(tupleKey(null, reservation.runId, reservation.attemptId), launchKey);
    return action(true, 'reserved', { launch: this.publicLaunch(launch) });
  }

  beginLaunch(input) {
    const found = this.resolveLaunch(input);
    if (!found.launch) return action(false, found.reason);
    const launch = found.launch;
    if (this.endedParentSessions.has(parentSessionKey(launch.snapshot.parent))) return action(false, 'parent_ended');
    if (launch.cancelRequest) return action(false, 'cancel_requested');
    if (launch.exit) return action(false, 'child_already_exited');
    if (launch.unknownExit) return action(false, 'child_end_unknown');
    if (launch.startAuthorized) return action(true, 'duplicate', { launch: this.publicLaunch(launch) });
    launch.startAuthorized = true;
    return action(true, 'start_authorized', { launch: this.publicLaunch(launch) });
  }

  attachObservation(input) {
    if (!hasKeys(input, [
      'launchId', 'runId', 'attemptId', 'parent', 'source', 'observationId',
    ], ['identity', 'actual'])) return action(false, 'invalid_input');
    if (!['shell', 'native'].includes(input.source) || !safeIdentifier(input.observationId)) {
      return action(false, 'invalid_input');
    }
    const found = this.resolveLaunch(input);
    if (!found.launch) return action(false, found.reason);
    const launch = found.launch;
    if (!launch.startAuthorized) return action(false, 'start_not_authorized');
    const actual = normalizeActual(input.actual);
    if (!actual) return action(false, 'invalid_actual_profile');
    const identity = input.source === 'native' ? this.normalizeNativeIdentity(input.identity, launch) : null;
    if (input.source === 'native' && !identity) return action(false, 'invalid_native_identity');
    if (input.source === 'shell' && Object.hasOwn(input, 'identity')) return action(false, 'invalid_input');
    const observation = {
      launchId: launch.snapshot.launchId,
      runId: launch.snapshot.runId,
      attemptId: launch.snapshot.attemptId,
      source: input.source,
      observationId: input.observationId,
      ...(identity ? { identity } : {}),
      actual,
    };
    const observationKey = JSON.stringify([launch.snapshot.launchId, input.source, input.observationId]);
    const fingerprint = JSON.stringify(observation);
    const existing = this.observations.get(observationKey);
    if (existing) {
      return existing.fingerprint === fingerprint
        ? action(true, 'duplicate')
        : action(false, 'observation_conflict');
    }
    if (launch.exit) return action(false, 'child_already_exited');
    if (launch.unknownExit) return action(false, 'child_end_unknown');
    if (identity) {
      const key = nativeIdentityKey(identity);
      const owner = this.nativeIdentities.get(key);
      if (owner && owner !== launch.snapshot.launchId) return action(false, 'native_identity_conflict');
      if (launch.nativeIdentityKey && launch.nativeIdentityKey !== key) {
        return action(false, 'native_identity_conflict');
      }
      if (!this.actualProfileCompatible(launch, actual)) return action(false, 'actual_profile_conflict');
      this.nativeIdentities.set(key, launch.snapshot.launchId);
      launch.nativeIdentityKey = key;
    } else if (!this.actualProfileCompatible(launch, actual)) {
      return action(false, 'actual_profile_conflict');
    }

    this.mergeActualProfile(launch, actual);
    launch.observations.set(observationKey, freeze(observation));
    this.observations.set(observationKey, { launchId: launch.snapshot.launchId, fingerprint });
    return action(true, 'attached');
  }

  recordResult(input) {
    if (!hasKeys(input, [
      'launchId', 'runId', 'attemptId', 'parent', 'resultId', 'classification',
    ], ['outputDigest', 'actual'])) return action(false, 'invalid_input');
    if (!safeIdentifier(input.resultId) || !RESULT_CLASSIFICATIONS.has(input.classification)
      || (input.outputDigest !== undefined && !/^[a-f0-9]{64}$/i.test(input.outputDigest))) {
      return action(false, 'invalid_input');
    }
    const found = this.resolveLaunch(input);
    if (!found.launch) return action(false, found.reason);
    const launch = found.launch;
    const actual = normalizeActual(input.actual);
    if (!actual) return action(false, 'invalid_actual_profile');
    const result = {
      resultId: input.resultId,
      classification: input.classification,
      outputDigest: input.outputDigest || null,
      actual,
    };
    const fingerprint = JSON.stringify({ launchId: launch.snapshot.launchId, ...result });
    const resultKey = JSON.stringify([launch.snapshot.launchId, input.resultId]);
    const existingResultId = this.resultIds.get(resultKey);
    if (existingResultId) {
      return existingResultId.fingerprint === fingerprint
        ? action(true, 'duplicate')
        : action(false, 'result_id_conflict');
    }
    if (launch.result) {
      return sameJson(launch.result, result) ? action(true, 'duplicate') : action(false, 'duplicate_result');
    }
    if (!launch.startAuthorized) return action(false, 'start_not_authorized');
    if (launch.exit) return action(false, 'child_already_exited');
    if (!this.actualProfileCompatible(launch, actual)) return action(false, 'actual_profile_conflict');

    this.mergeActualProfile(launch, actual);
    launch.result = freeze(result);
    this.resultIds.set(resultKey, { launchId: launch.snapshot.launchId, fingerprint });
    return action(true, 'received');
  }

  recordExit(input) {
    if (!hasKeys(input, [
      'launchId', 'runId', 'attemptId', 'parent', 'source', 'exitId', 'status',
    ], ['identity', 'exitCode'])) return action(false, 'invalid_input');
    if (!['shell', 'native'].includes(input.source) || !safeIdentifier(input.exitId)
      || !EXIT_STATUSES.has(input.status)
      || (input.exitCode !== undefined && input.exitCode !== null && !Number.isSafeInteger(input.exitCode))) {
      return action(false, 'invalid_input');
    }
    const found = this.resolveLaunch(input);
    if (!found.launch) return action(false, found.reason);
    const launch = found.launch;
    if (!launch.startAuthorized) return action(false, 'start_not_authorized');
    const identity = input.source === 'native' ? this.normalizeNativeIdentity(input.identity, launch) : null;
    if (input.source === 'native' && !identity) return action(false, 'invalid_native_identity');
    if (input.source === 'shell' && Object.hasOwn(input, 'identity')) return action(false, 'invalid_input');
    if (input.source === 'native'
      && (launch.snapshot.resolvedVendor !== 'codex' || launch.snapshot.transport !== 'nativeCodex')) {
      return action(false, 'native_exit_unsupported');
    }
    if (identity) {
      const identityKey = nativeIdentityKey(identity);
      if (launch.nativeIdentityKey !== identityKey
        || this.nativeIdentities.get(identityKey) !== launch.snapshot.launchId) {
        return action(false, 'native_identity_unbound');
      }
    }
    const exit = {
      exitId: input.exitId,
      source: input.source,
      status: input.status,
      exitCode: input.exitCode === undefined ? null : input.exitCode,
      ...(identity ? { identity } : {}),
    };
    const fingerprint = JSON.stringify({ launchId: launch.snapshot.launchId, ...exit });
    if (launch.exit) {
      return sameJson(launch.exit, exit) ? action(true, 'duplicate') : action(false, 'exit_conflict');
    }
    const exitKey = JSON.stringify([launch.snapshot.launchId, 'exit', input.exitId]);
    const existingExitId = this.observations.get(exitKey);
    if (existingExitId) {
      return existingExitId.fingerprint === fingerprint
        ? action(true, 'duplicate')
        : action(false, 'exit_id_conflict');
    }
    if (input.status === 'unknown') {
      if (launch.unknownExit) return action(false, 'unknown_exit_conflict');
      launch.unknownExit = freeze(exit);
      this.observations.set(exitKey, { launchId: launch.snapshot.launchId, fingerprint });
      return action(true, 'unknown_exit_observed');
    }
    launch.exit = freeze(exit);
    this.observations.set(exitKey, { launchId: launch.snapshot.launchId, fingerprint });
    launch.cancelConfirmed = Boolean(launch.cancelRequest && input.status === 'cancelled');
    return action(true, 'exit_observed');
  }

  requestCancel(input) {
    if (!hasKeys(input, [
      'launchId', 'runId', 'attemptId', 'parent', 'requestId', 'reason',
    ])) return action(false, 'invalid_input');
    if (!safeIdentifier(input.requestId) || !CANCEL_REASONS.has(input.reason)) {
      return action(false, 'invalid_input');
    }
    const found = this.resolveLaunch(input);
    if (!found.launch) return action(false, found.reason);
    const launch = found.launch;
    if (!launch.startAuthorized) return action(false, 'start_not_authorized');
    if (launch.exit) return action(false, 'child_already_exited');
    if (input.reason === 'parent_ended'
      && !this.endedParentSessions.has(parentSessionKey(launch.snapshot.parent))) {
      return action(false, 'parent_not_ended');
    }
    const cancelRequest = { requestId: input.requestId, reason: input.reason };
    const requestKey = JSON.stringify([launch.snapshot.launchId, ...Object.values(cancelRequest)]);
    const requestMapKey = JSON.stringify([launch.snapshot.launchId, input.requestId]);
    const existingRequestId = this.cancelIds.get(requestMapKey);
    if (existingRequestId) {
      return existingRequestId === requestKey
        ? action(true, 'duplicate')
        : action(false, 'cancel_request_conflict');
    }
    if (launch.cancelRequest) return action(false, 'cancel_already_requested');
    launch.cancelRequest = freeze(cancelRequest);
    this.cancelIds.set(requestMapKey, requestKey);
    return action(true, 'cancel_requested');
  }

  markParentSessionEnded(input) {
    if (!hasKeys(input, ['provider', 'sessionId'])
      || !PROVIDERS.has(input.provider) || !safeIdentifier(input.sessionId)) {
      return action(false, 'invalid_input');
    }
    const key = parentSessionKey(input);
    if (this.endedParentSessions.has(key)) return action(true, 'duplicate');
    this.endedParentSessions.add(key);
    return action(true, 'parent_ended');
  }

  markParentReturned(input) {
    if (!hasKeys(input, [
      'launchId', 'runId', 'attemptId', 'parent', 'resultId',
    ])) return action(false, 'invalid_input');
    if (!safeIdentifier(input.resultId)) return action(false, 'invalid_input');
    const found = this.resolveLaunch(input);
    if (!found.launch) return action(false, found.reason);
    const launch = found.launch;
    if (launch.parentReturnedResultId) {
      return launch.parentReturnedResultId === input.resultId
        ? action(true, 'duplicate')
        : action(false, 'parent_return_conflict');
    }
    if (this.endedParentSessions.has(parentSessionKey(launch.snapshot.parent))) return action(false, 'parent_ended');
    if (!launch.result || launch.result.resultId !== input.resultId) return action(false, 'result_or_exit_unobserved');
    if (!launch.exit) {
      return action(false, launch.unknownExit ? 'child_exit_unconfirmed' : 'result_or_exit_unobserved');
    }
    launch.parentReturnedResultId = input.resultId;
    return action(true, 'returned');
  }

  project() {
    const rows = [...this.launches.values()].map((launch) => this.projectLaunch(launch));
    const counts = {
      reserved: rows.filter((row) => row.launchStatus === 'reserved').length,
      start_authorized: rows.filter((row) => row.launchStatus === 'start_authorized').length,
      result_received: rows.filter((row) => row.result !== null).length,
      owned_child_exited: rows.filter((row) => row.ownedChildExit.observed).length,
      parent_returned: rows.filter((row) => row.parentReturn === 'returned').length,
      cancel_requested: rows.filter((row) => row.cancel.requested).length,
      cancel_confirmed: rows.filter((row) => row.cancel.confirmed).length,
      parent_ended: rows.filter((row) => row.parentEnded).length,
    };
    return {
      trust: {
        scope: TRUST_SCOPE,
        authenticatesCallers: false,
        provesOsSandbox: false,
      },
      counts,
      rows,
    };
  }

  resolveLaunch(input) {
    if (!isRecord(input) || !safeIdentifier(input.launchId)
      || !safeIdentifier(input.runId) || !safeIdentifier(input.attemptId)) {
      return { launch: null, reason: 'invalid_input' };
    }
    const parent = normalizeParent(input.parent);
    if (!parent) return { launch: null, reason: 'invalid_input' };
    const launch = this.launches.get(input.launchId);
    if (!launch) return { launch: null, reason: 'launch_not_found' };
    if (launch.snapshot.runId !== input.runId || launch.snapshot.attemptId !== input.attemptId
      || !sameJson(launch.snapshot.parent, parent)) {
      return { launch: null, reason: 'launch_mismatch' };
    }
    return { launch, reason: null };
  }

  normalizeNativeIdentity(value, launch) {
    if (!isRecord(value) || !PROVIDERS.has(value.provider)
      || value.provider !== launch.snapshot.resolvedVendor
      || !safeIdentifier(value.hostId) || !safeIdentifier(value.homeScope)) return null;
    const idField = value.provider === 'codex' ? 'threadId' : 'sessionId';
    const allowedTransports = value.provider === 'codex'
      ? ['nativeCodex', 'bridgeBackend']
      : ['externalClaude', 'bridgeBackend'];
    if (!hasKeys(value, ['provider', 'hostId', 'homeScope', idField])
      || !safeIdentifier(value[idField]) || !allowedTransports.includes(launch.snapshot.transport)) return null;
    return {
      provider: value.provider,
      hostId: value.hostId,
      homeScope: value.homeScope,
      [idField]: value[idField],
    };
  }

  actualProfileCompatible(launch, actual) {
    return ['model', 'effort'].every((key) => actual[key] === null
      || launch.actualProfile[key] === null || launch.actualProfile[key] === actual[key]);
  }

  mergeActualProfile(launch, actual) {
    for (const key of ['model', 'effort']) {
      if (actual[key] !== null) launch.actualProfile[key] = actual[key];
    }
  }

  publicLaunch(launch) {
    return this.projectLaunch(launch);
  }

  projectLaunch(launch) {
    const parentEnded = this.endedParentSessions.has(parentSessionKey(launch.snapshot.parent));
    const parentReturn = launch.parentReturnedResultId
      ? 'returned'
      : (parentEnded && launch.result && launch.exit
        ? 'held_parent_ended'
        : (launch.result && launch.exit
          ? 'ready'
          : (launch.result && launch.unknownExit ? 'held_unknown_exit' : 'pending')));
    return {
      ...clone(launch.snapshot),
      launchStatus: launch.startAuthorized ? 'start_authorized' : 'reserved',
      actualProfile: clone(launch.actualProfile),
      observations: [...launch.observations.values()].map(clone),
      result: clone(launch.result),
      ownedChildExit: {
        observed: launch.exit !== null,
        ...(launch.exit ? clone(launch.exit) : (launch.unknownExit
          ? clone(launch.unknownExit)
          : { status: null, exitCode: null })),
      },
      cancel: {
        requested: launch.cancelRequest !== null,
        ...(launch.cancelRequest ? clone(launch.cancelRequest) : {}),
        confirmed: launch.cancelConfirmed,
      },
      parentEnded,
      parentReturn,
    };
  }
}

module.exports = {
  CANCEL_REASONS,
  EXIT_STATUSES,
  MAX_DEPTH,
  RESULT_CLASSIFICATIONS,
  ROUTE_VALUES,
  TRUST_SCOPE,
  RoutingModel,
};
