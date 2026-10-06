'use strict';

const crypto = require('node:crypto');

const PROVIDER_NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });
const LAUNCH_FIELDS = Object.freeze([
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding',
]);
const IDENTITY_FIELDS = Object.freeze(['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']);
const EVIDENCE_FIELDS = Object.freeze([
  'evidenceId', 'source', 'method', 'adapterVersion', 'runtimeVersion', 'observedAt', 'registrationRef',
]);
const IDENTIFIER_MAX = 512;
const MAX_LAUNCHES = 10_000;
const MAX_OBSERVATIONS = 10_000;

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, fields) {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}

function isIdentifier(value, maxLength = IDENTIFIER_MAX) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
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

function normalizeClaims(value) {
  if (!hasExactKeys(value, LAUNCH_FIELDS) ||
      !isIdentifier(value.launchId) || !isIdentifier(value.runId) || !isIdentifier(value.attemptId) ||
      typeof value.provider !== 'string' || !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, value.provider) ||
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
    originBinding,
  };
}

function normalizeIdentity(value) {
  if (!hasExactKeys(value, IDENTITY_FIELDS) ||
      typeof value.provider !== 'string' || !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, value.provider) ||
      value.nativeIdKind !== PROVIDER_NATIVE_ID_KINDS[value.provider] ||
      !isIdentifier(value.hostId) || !isIdentifier(value.homeScopeId) || !isIdentifier(value.nativeId)) return null;
  return {
    provider: value.provider,
    nativeIdKind: value.nativeIdKind,
    hostId: value.hostId,
    homeScopeId: value.homeScopeId,
    nativeId: value.nativeId,
  };
}

function sameIdentity(left, right) {
  return Boolean(left && right) && IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function sanitizeEvidence(value) {
  if (!isRecord(value) || Object.keys(value).length > 32) return null;
  const metadata = {};
  for (const field of EVIDENCE_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    if (!isIdentifier(value[field], 512)) return null;
    metadata[field] = value[field];
  }
  if (Object.hasOwn(value, 'capabilities')) {
    if (!Array.isArray(value.capabilities) || value.capabilities.length > 32) return null;
    const capabilities = [];
    for (let index = 0; index < value.capabilities.length; index += 1) {
      if (!Object.hasOwn(value.capabilities, index) || !isIdentifier(value.capabilities[index], 128)) return null;
      capabilities.push(value.capabilities[index]);
    }
    metadata.capabilities = capabilities;
  }
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > 8 * 1024) return null;
  return metadata;
}

function cloneEvidence(evidence) {
  return { ...evidence, ...(evidence.capabilities ? { capabilities: [...evidence.capabilities] } : {}) };
}

function cloneActor(actor) {
  return actor ? { kind: actor.kind, id: actor.id } : null;
}

function clonePeriodBinding(binding) {
  return binding ? { periodId: binding.periodId, actor: cloneActor(binding.actor) } : null;
}

function cloneRecord(record) {
  return {
    launchRef: record.launchRef,
    launchId: record.launchId,
    runId: record.runId,
    attemptId: record.attemptId,
    provider: record.provider,
    nativeIdKind: record.nativeIdKind,
    hostId: record.hostId,
    homeScopeId: record.homeScopeId,
    origin: record.origin,
    purpose: record.purpose,
    originBinding: clonePeriodBinding(record.originBinding),
    state: record.state,
    registrationEvidence: cloneEvidence(record.registrationEvidence),
    identity: record.identity ? { ...record.identity } : null,
    executionBinding: record.executionBinding
      ? { periodId: record.executionBinding.periodId, actor: cloneActor(record.executionBinding.actor) }
      : null,
    conversationId: record.conversationId,
    sessionId: record.sessionId,
    bindingEvidence: record.bindingEvidence ? cloneEvidence(record.bindingEvidence) : null,
    currentOwner: clonePeriodBinding(record.currentOwner),
    ownerGeneration: record.ownerGeneration,
    currentProof: null,
  };
}

function registrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function createLaunchBindingKernel({ registrationRegistry } = {}) {
  if (!registrationRegistry || typeof registrationRegistry.snapshot !== 'function') {
    throw new TypeError('launch binding kernel requires a registration registry');
  }

  const launches = new Map();
  const attemptRefs = new Map();
  const evidenceClaims = new Map();
  let authorityRevision = Object.freeze({});
  const captureAuthorityRevision = () => authorityRevision;
  const checkAuthorityRevision = (stamp) => stamp === authorityRevision;
  const advanceAuthorityRevision = () => { authorityRevision = Object.freeze({}); };
  const executionBindings = new Map();
  const observations = new Map();

  function readSnapshot() {
    let snapshot;
    try {
      snapshot = registrationRegistry.snapshot();
    } catch {
      throw registrationError('registry_unavailable', 'registration snapshot is unavailable');
    }
    if (snapshot && typeof snapshot.then === 'function') {
      throw registrationError('registry_unavailable', 'registration snapshot must be synchronous');
    }
    if (!isRecord(snapshot) || !Array.isArray(snapshot.conversations) || !Array.isArray(snapshot.executions)) {
      throw registrationError('registry_unavailable', 'registration snapshot is invalid');
    }
    return snapshot;
  }

  function activePeriod(snapshot, periodId) {
    const executions = snapshot.executions.filter((item) => isRecord(item) && item.executionId === periodId);
    if (executions.length !== 1 || executions[0].state !== 'active' ||
        !isIdentifier(executions[0].conversationId) || !isIdentifier(executions[0].sessionId)) return null;
    const conversations = snapshot.conversations.filter((item) =>
      isRecord(item) && item.conversationId === executions[0].conversationId);
    if (conversations.length !== 1) return null;
    const identity = normalizeIdentity(conversations[0].identity);
    if (!identity) return null;
    return {
      conversationId: executions[0].conversationId,
      sessionId: executions[0].sessionId,
      identity,
    };
  }

  function publicObservation(item) {
    return {
      observationId: item.observationId,
      claims: { ...item.claims, originBinding: clonePeriodBinding(item.claims.originBinding) },
      status: 'unverified',
      metadata: cloneEvidence(item.metadata),
    };
  }

  function observe(claimsInput, metadataInput) {
    const claims = normalizeClaims(claimsInput);
    const metadata = sanitizeEvidence(metadataInput);
    if (!claims || !metadata || !metadata.evidenceId) {
      return { ok: false, status: 'mismatch', observationId: null };
    }
    if (observations.size >= MAX_OBSERVATIONS) return { ok: false, status: 'capacity', observationId: null };
    const observationId = 'launch-observation-' + crypto.randomUUID();
    observations.set(observationId, { observationId, claims, metadata });
    return { ok: true, status: 'unverified', observationId };
  }

  function get(launchRef) {
    if (!isIdentifier(launchRef)) return null;
    const record = launches.get(launchRef);
    return record ? cloneRecord(record) : null;
  }

  function snapshot() {
    return {
      launches: [...launches.values()].map(cloneRecord),
      observations: [...observations.values()].map(publicObservation),
    };
  }

  function registerLaunch(claimsInput, evidenceInput) {
    const claims = normalizeClaims(claimsInput);
    if (!claims) throw registrationError('invalid_launch', 'launch claims are invalid');
    const evidence = sanitizeEvidence(evidenceInput);
    if (!evidence || !evidence.evidenceId) {
      throw registrationError('invalid_evidence', 'launch evidence is invalid');
    }

    const key = JSON.stringify([claims.launchId, claims.runId, claims.attemptId]);
    const fingerprint = JSON.stringify({ claims, evidence });
    const existingRef = attemptRefs.get(key);
    if (existingRef) {
      const existing = launches.get(existingRef);
      if (existing && existing.registrationFingerprint === fingerprint) return { launchRef: existingRef };
      throw registrationError('launch_conflict', 'launch attempt conflicts with an existing registration');
    }
    if (evidenceClaims.has(evidence.evidenceId)) {
      throw registrationError('evidence_conflict', 'evidence is already claimed');
    }
    if (launches.size >= MAX_LAUNCHES) throw registrationError('capacity', 'launch capacity reached');

    if (claims.originBinding) {
      const snapshot = readSnapshot();
      if (!activePeriod(snapshot, claims.originBinding.periodId)) {
        throw registrationError('stale_origin', 'origin period is not active');
      }
    }

    const launchRef = 'launch-' + crypto.randomUUID();
    const record = {
      ...claims,
      launchRef,
      state: 'registered',
      registrationEvidence: evidence,
      identity: null,
      executionBinding: null,
      conversationId: null,
      sessionId: null,
      bindingEvidence: null,
      currentOwner: clonePeriodBinding(claims.originBinding),
      ownerGeneration: 0,
      currentProof: null,
      registrationFingerprint: fingerprint,
      bindingFingerprint: null,
    };
    advanceAuthorityRevision();
    launches.set(launchRef, record);
    attemptRefs.set(key, launchRef);
    evidenceClaims.set(evidence.evidenceId, { launchRef, stage: 'registration' });
    return { launchRef };
  }

  function bindExecution(launchRef, input) {
    if (!isIdentifier(launchRef) || !hasExactKeys(input, ['identity', 'executionBinding', 'evidence'])) {
      throw registrationError('invalid_binding', 'execution binding is invalid');
    }
    const record = launches.get(launchRef);
    if (!record) throw registrationError('unknown_launch', 'launch reference is unknown');
    if (record.state === 'ended') throw registrationError('ended_launch', 'launch has ended');

    const identity = normalizeIdentity(input.identity);
    const executionBinding = normalizePeriodBinding(input.executionBinding);
    const evidence = sanitizeEvidence(input.evidence);
    if (!identity || !executionBinding || !evidence || !evidence.evidenceId ||
        evidence.registrationRef !== launchRef) {
      throw registrationError('invalid_binding', 'execution binding claims are invalid');
    }
    if (identity.provider !== record.provider || identity.nativeIdKind !== record.nativeIdKind ||
        identity.hostId !== record.hostId || identity.homeScopeId !== record.homeScopeId) {
      throw registrationError('identity_mismatch', 'execution identity does not match launch scope');
    }

    const fingerprint = JSON.stringify({ identity, executionBinding, evidence });
    if (record.state === 'bound' && record.bindingFingerprint !== fingerprint) {
      throw registrationError('binding_conflict', 'launch is already bound to different claims');
    }

    const bindingKey = JSON.stringify([
      executionBinding.periodId, executionBinding.actor.kind, executionBinding.actor.id,
    ]);
    if (record.state === 'registered' && evidenceClaims.has(evidence.evidenceId)) {
      throw registrationError('evidence_conflict', 'evidence is already claimed');
    }
    if (record.state === 'registered' && executionBindings.has(bindingKey)) {
      throw registrationError('duplicate_execution_binding', 'execution binding is already claimed');
    }

    const snapshot = readSnapshot();
    const period = activePeriod(snapshot, executionBinding.periodId);
    if (!period) throw registrationError('stale_period', 'execution period is not active');
    if (!sameIdentity(period.identity, identity)) {
      throw registrationError('identity_mismatch', 'execution period identity does not match');
    }
    if (record.originBinding && !activePeriod(snapshot, record.originBinding.periodId)) {
      throw registrationError('stale_origin', 'origin period is not active');
    }
    if (record.state === 'bound') return cloneRecord(record);

    advanceAuthorityRevision();
    record.identity = identity;
    record.executionBinding = executionBinding;
    record.conversationId = period.conversationId;
    record.sessionId = period.sessionId;
    record.bindingEvidence = evidence;
    record.currentOwner = record.origin === 'standalone'
      ? clonePeriodBinding(executionBinding)
      : clonePeriodBinding(record.originBinding);
    record.ownerGeneration = 0;
    record.currentProof = null;
    record.bindingFingerprint = fingerprint;
    record.state = 'bound';
    evidenceClaims.set(evidence.evidenceId, { launchRef, stage: 'binding' });
    executionBindings.set(bindingKey, launchRef);
    return cloneRecord(record);
  }

  function endLaunch(launchRef) {
    if (!isIdentifier(launchRef)) return false;
    const record = launches.get(launchRef);
    if (!record) return false;
    if (record.state === 'ended') return true;
    advanceAuthorityRevision();
    record.state = 'ended';
    record.currentProof = null;
    return true;
  }

  return Object.freeze({
    registry: Object.freeze({ observe, get, snapshot, captureAuthorityRevision, checkAuthorityRevision }),
    authority: Object.freeze({ registerLaunch, bindExecution, endLaunch }),
  });
}

function createProviderLaunchAdapter(provider, registry, authority) {
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, provider) ||
      !registry || typeof registry.observe !== 'function' || typeof registry.get !== 'function' ||
      typeof authority?.registerLaunch !== 'function' ||
      typeof authority?.bindExecution !== 'function' ||
      typeof authority?.endLaunch !== 'function') {
    throw new TypeError('provider launch adapter requires a supported provider, registry, and authority');
  }
  const expectedKind = PROVIDER_NATIVE_ID_KINDS[provider];
  const matchesProvider = (claims) =>
    isRecord(claims) && claims.provider === provider && claims.nativeIdKind === expectedKind;

  return Object.freeze({
    observe(claims, metadata) {
      if (!matchesProvider(claims)) return { ok: false, status: 'mismatch', observationId: null };
      return registry.observe(claims, metadata);
    },
    registerLaunch(claims, evidence) {
      if (!matchesProvider(claims)) {
        throw registrationError('invalid_launch', 'launch claims do not match this provider adapter');
      }
      return authority.registerLaunch(claims, evidence);
    },
    bindExecution(launchRef, binding) {
      if (!isRecord(binding) || !isRecord(binding.identity) ||
          binding.identity.provider !== provider || binding.identity.nativeIdKind !== expectedKind) {
        throw registrationError('invalid_binding', 'execution identity does not match this provider adapter');
      }
      return authority.bindExecution(launchRef, binding);
    },
    endLaunch(launchRef) {
      const record = registry.get(launchRef);
      if (!record || record.provider !== provider || record.nativeIdKind !== expectedKind) return false;
      return authority.endLaunch(launchRef);
    },
  });
}

module.exports = { createLaunchBindingKernel, createProviderLaunchAdapter };
