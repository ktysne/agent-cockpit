'use strict';

const crypto = require('node:crypto');
const { isRequestSessionId } = require('./session-ids');

const PROVIDER_NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });
const IDENTITY_FIELDS = Object.freeze(['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']);
const ENVELOPE_FIELDS = Object.freeze(['token', 'identity', 'contextId', 'executionId']);
const EVIDENCE_STRING_FIELDS = Object.freeze([
  'evidenceId', 'source', 'method', 'adapterVersion', 'runtimeVersion', 'observedAt', 'registrationRef',
]);
const MAX_IDENTITY_VALUE_LENGTH = 512;
const MAX_EVIDENCE_STRING_LENGTH = 512;
const MAX_CAPABILITIES = 32;
const MAX_CAPABILITY_LENGTH = 128;
const MAX_METADATA_BYTES = 8 * 1024;
const MAX_METADATA_KEYS = 32;
const MAX_OBSERVATIONS = 10_000;
const MAX_CONVERSATIONS = 10_000;
const MAX_EXECUTIONS = 20_000;
const MAX_WRITER_BINDINGS = 20_000;

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

function isBoundedIdentifier(value, maxLength = MAX_IDENTITY_VALUE_LENGTH) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeIdentity(identity) {
  if (!hasExactKeys(identity, IDENTITY_FIELDS)) return null;
  if (typeof identity.provider !== 'string' || !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, identity.provider) ||
      typeof identity.nativeIdKind !== 'string') return null;
  const expectedKind = PROVIDER_NATIVE_ID_KINDS[identity.provider];
  if (identity.nativeIdKind !== expectedKind) return null;
  if (!isBoundedIdentifier(identity.hostId) || !isBoundedIdentifier(identity.homeScopeId) ||
      !isBoundedIdentifier(identity.nativeId)) return null;
  return {
    provider: identity.provider,
    nativeIdKind: identity.nativeIdKind,
    hostId: identity.hostId,
    homeScopeId: identity.homeScopeId,
    nativeId: identity.nativeId,
  };
}

function identityKey(identity) {
  return JSON.stringify(IDENTITY_FIELDS.map((field) => identity[field]));
}

function identitiesEqual(left, right) {
  return Boolean(left && right) && IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function safeMetadataString(value) {
  return isBoundedIdentifier(value, MAX_EVIDENCE_STRING_LENGTH) ? value : null;
}

function sanitizeEvidenceMetadata(value) {
  if (!isRecord(value) || Object.keys(value).length > MAX_METADATA_KEYS) return null;
  const metadata = {};
  for (const field of EVIDENCE_STRING_FIELDS) {
    if (!Object.hasOwn(value, field)) continue;
    const safeValue = safeMetadataString(value[field]);
    if (!safeValue) return null;
    metadata[field] = safeValue;
  }
  if (Object.hasOwn(value, 'capabilities')) {
    if (!Array.isArray(value.capabilities) || value.capabilities.length > MAX_CAPABILITIES) return null;
    const capabilities = [];
    for (let index = 0; index < value.capabilities.length; index += 1) {
      if (!Object.hasOwn(value.capabilities, index)) return null;
      const capability = value.capabilities[index];
      if (!isBoundedIdentifier(capability, MAX_CAPABILITY_LENGTH)) return null;
      capabilities.push(capability);
    }
    metadata.capabilities = capabilities;
  }
  if (Buffer.byteLength(JSON.stringify(metadata), 'utf8') > MAX_METADATA_BYTES) return null;
  return metadata;
}

function cloneMetadata(metadata) {
  return {
    ...metadata,
    ...(metadata.capabilities ? { capabilities: [...metadata.capabilities] } : {}),
  };
}

function result(status, execution = null) {
  const ok = status === 'accepted';
  return {
    ok,
    status,
    sessionId: ok ? execution.sessionId : null,
    conversationId: ok ? execution.conversationId : null,
    executionId: execution?.executionId || null,
  };
}

function registrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function tokenDigest(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function registrationDigest(domain, value) {
  return crypto.createHash('sha256').update(domain).update('\0').update(value).digest('hex');
}

function createRegistrationKernel() {
  let authorityRevision = Object.freeze({});
  const captureAuthorityRevision = () => authorityRevision;
  const checkAuthorityRevision = (stamp) => stamp === authorityRevision;
  const advanceAuthorityRevision = () => { authorityRevision = Object.freeze({}); };
  const conversationsByIdentity = new Map();
  const conversationsById = new Map();
  const executionsById = new Map();
  const observationsById = new Map();
  const startClaims = new Map();
  const evidenceClaims = new Map();
  const activeExecutionByConversation = new Map();
  const lastExecutionByConversation = new Map();
  const sessionIdOwners = new Map();
  const writerBindingsByDigest = new Map();
  const writerDigestByContext = new Map();
  const historyIncompleteConversationIds = new Set();
  let nextRegistrationOrder = 1;
  let registrationNeedsRevalidation = false;
  let restorationUsed = false;

  function newConversationId() {
    let candidate;
    do {
      candidate = `conversation-${crypto.randomUUID()}`;
    } while (conversationsById.has(candidate));
    return candidate;
  }

  function newExecutionId() {
    let candidate;
    do {
      candidate = `exec-${crypto.randomUUID()}`;
    } while (executionsById.has(candidate) || sessionIdOwners.has(candidate));
    return candidate;
  }

  function observationResult(status, observationId = null) {
    return { ok: status === 'unverified', status, observationId };
  }

  function observe(identityInput, evidenceMetadata) {
    const identity = normalizeIdentity(identityInput);
    const metadata = sanitizeEvidenceMetadata(evidenceMetadata);
    if (!identity || !metadata) return observationResult('mismatch');
    if (observationsById.size >= MAX_OBSERVATIONS) return observationResult('capacity');
    const observationId = `observation-${crypto.randomUUID()}`;
    observationsById.set(observationId, {
      observationId,
      identity,
      status: 'unverified',
      metadata,
    });
    return observationResult('unverified', observationId);
  }

  function sessionProjection(identity, conversation, executionId, startOptions) {
    if (identity.provider !== 'claude' || startOptions.resume) return executionId;
    const candidate = startOptions.projectionId || identity.nativeId;
    if (!isRequestSessionId(candidate)) return executionId;
    const owner = sessionIdOwners.get(candidate);
    if (owner && owner.conversationId !== conversation.conversationId) return executionId;
    return candidate;
  }

  function register(identityInput, evidenceInput, startOptions = {}) {
    const identity = normalizeIdentity(identityInput);
    const evidence = sanitizeEvidenceMetadata(evidenceInput);
    if (!identity) throw registrationError('invalid_identity', 'registration identity is incomplete or unsupported');
    if (!evidence || !evidence.evidenceId) {
      throw registrationError('invalid_evidence', 'registration evidence metadata requires a safe evidenceId');
    }
    if (!isRecord(startOptions) || Object.keys(startOptions).some((field) => !['startId', 'resume', 'projectionId'].includes(field)) ||
        !isBoundedIdentifier(startOptions.startId)) {
      throw registrationError('invalid_start', 'registration startId is required');
    }
    const resume = Object.hasOwn(startOptions, 'resume') ? startOptions.resume : false;
    if (typeof resume !== 'boolean') throw registrationError('invalid_start', 'resume must be boolean');
    const projectionId = startOptions.projectionId;
    if (projectionId !== undefined && !isBoundedIdentifier(projectionId)) {
      throw registrationError('invalid_start', 'projectionId must be a safe identifier');
    }
    if (projectionId !== undefined && (identity.provider !== 'claude' || resume || projectionId !== identity.nativeId)) {
      throw registrationError('invalid_start', 'projectionId is allowed only for an initial Claude session alias');
    }

    const key = identityKey(identity);
    const startIdDigest = registrationDigest('native-registration-start-id-v1', startOptions.startId);
    const evidenceIdDigest = registrationDigest('native-registration-evidence-id-v1', evidence.evidenceId);
    const fingerprintDigest = registrationDigest('native-registration-start-fingerprint-v1',
      JSON.stringify({ key, evidence, resume, projectionId: projectionId || null }));
    if (registrationNeedsRevalidation) {
      throw registrationError('needs_revalidation', 'registration history requires fresh evidence');
    }
    const previousStart = startClaims.get(startIdDigest);
    if (previousStart) {
      if (previousStart.fingerprintDigest !== fingerprintDigest) {
        throw registrationError('start_replay_mismatch', 'startId was already used for different registration evidence');
      }
      if (previousStart.requiresRevalidation) {
        throw registrationError('needs_revalidation', 'restored start requires fresh evidence');
      }
      const previousExecution = executionsById.get(previousStart.executionId);
      return {
        conversationId: previousStart.conversationId,
        executionId: previousStart.executionId,
        sessionId: previousExecution.sessionId,
      };
    }
    const previousEvidenceStartIdDigest = evidenceClaims.get(evidenceIdDigest);
    if (previousEvidenceStartIdDigest && previousEvidenceStartIdDigest !== startIdDigest) {
      throw registrationError('evidence_replay', 'registration evidence was already used for another start');
    }
    if (startClaims.size >= MAX_EXECUTIONS || executionsById.size >= MAX_EXECUTIONS ||
        !Number.isSafeInteger(nextRegistrationOrder) || nextRegistrationOrder > MAX_EXECUTIONS) {
      throw registrationError('capacity', 'registration capacity reached');
    }

    let conversation = conversationsByIdentity.get(key);
    if (conversation && activeExecutionByConversation.has(conversation.conversationId)) {
      throw registrationError('active_execution', 'conversation already has an active execution');
    }
    const previousExecutionId = conversation
      ? lastExecutionByConversation.get(conversation.conversationId)
      : null;
    const previousExecution = previousExecutionId ? executionsById.get(previousExecutionId) : null;
    if (previousExecution && !resume) {
      throw registrationError('resume_required', 'a conversation with prior executions requires an explicit resume');
    }
    if (resume && (!previousExecution || previousExecution.state !== 'ended')) {
      throw registrationError('invalid_resume', 'resume requires a previously ended execution');
    }
    if (!conversation) {
      if (conversationsById.size >= MAX_CONVERSATIONS) {
        throw registrationError('capacity', 'conversation capacity reached');
      }
      conversation = {
        conversationId: newConversationId(),
        identity,
        identityKey: key,
      };
      advanceAuthorityRevision();
      conversationsByIdentity.set(key, conversation);
      conversationsById.set(conversation.conversationId, conversation);
    }

    const executionId = newExecutionId();
    const sessionId = sessionProjection(identity, conversation, executionId, { resume, projectionId });
    const sessionOwner = sessionIdOwners.get(sessionId);
    if (sessionOwner && sessionOwner.conversationId !== conversation.conversationId) {
      throw registrationError('projection_collision', 'session projection is already assigned to another conversation');
    }
    const registrationOrder = nextRegistrationOrder;
    const execution = {
      conversationId: conversation.conversationId,
      executionId,
      sessionId,
      identity,
      state: 'active',
      evidence,
      registrationOrder,
    };
    advanceAuthorityRevision();
    nextRegistrationOrder += 1;
    executionsById.set(executionId, execution);
    activeExecutionByConversation.set(conversation.conversationId, executionId);
    lastExecutionByConversation.set(conversation.conversationId, executionId);
    sessionIdOwners.set(sessionId, {
      conversationId: conversation.conversationId,
      identityKey: key,
    });
    startClaims.set(startIdDigest, {
      startIdDigest,
      evidenceIdDigest,
      fingerprintDigest,
      conversationId: conversation.conversationId,
      executionId,
      order: registrationOrder,
      requiresRevalidation: false,
    });
    evidenceClaims.set(evidenceIdDigest, startIdDigest);
    return { conversationId: conversation.conversationId, executionId, sessionId };
  }

  function revokeExecutionWriters(executionId) {
    for (const [digest, binding] of writerBindingsByDigest) {
      if (binding.executionId !== executionId) continue;
      writerBindingsByDigest.delete(digest);
      const contextKey = `${executionId}\0${binding.contextId}`;
      if (writerDigestByContext.get(contextKey) === digest) writerDigestByContext.delete(contextKey);
    }
  }

  function authorizeEnvelope(envelope) {
    if (!hasExactKeys(envelope, ENVELOPE_FIELDS) || !isBoundedIdentifier(envelope.executionId) ||
        !isBoundedIdentifier(envelope.contextId) || typeof envelope.token !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(envelope.token)) {
      return result('unverified', isRecord(envelope) && executionsById.get(envelope.executionId));
    }
    const execution = executionsById.get(envelope.executionId);
    if (!execution) return result('unverified');
    if (execution.state !== 'active' || activeExecutionByConversation.get(execution.conversationId) !== execution.executionId) {
      return result('stale_execution', execution);
    }
    const digest = tokenDigest(envelope.token);
    const binding = writerBindingsByDigest.get(digest);
    if (!binding) return result('unverified', execution);
    const requestedIdentity = normalizeIdentity(envelope.identity);
    if (binding.executionId !== envelope.executionId || binding.contextId !== envelope.contextId ||
        !requestedIdentity || !identitiesEqual(binding.identity, requestedIdentity) ||
        !identitiesEqual(execution.identity, requestedIdentity)) {
      return result('mismatch', execution);
    }
    return result('accepted', execution);
  }

  function snapshot() {
    return {
      conversations: [...conversationsById.values()].map((conversation) => ({
        conversationId: conversation.conversationId,
        identity: { ...conversation.identity },
      })),
      executions: [...executionsById.values()].map((execution) => ({
        conversationId: execution.conversationId,
        executionId: execution.executionId,
        sessionId: execution.sessionId,
        state: execution.state,
        evidence: execution.evidence ? cloneMetadata(execution.evidence) : null,
      })),
      observations: [...observationsById.values()].map((observation) => ({
        observationId: observation.observationId,
        identity: { ...observation.identity },
        status: observation.status,
        metadata: cloneMetadata(observation.metadata),
      })),
      replayClaims: [...startClaims.values()].map((claim) => ({
        startIdDigest: claim.startIdDigest,
        evidenceIdDigest: claim.evidenceIdDigest,
        fingerprintDigest: claim.fingerprintDigest,
        conversationId: claim.conversationId,
        executionId: claim.executionId,
        order: claim.order,
      })),
      incompleteConversationIds: [...historyIncompleteConversationIds].sort(),
    };
  }

  function restoreHistory(registrations) {
    const fields = [
      'conversations', 'executions', 'launches', 'runtimeLaunches', 'connections', 'actors', 'handoffs',
      'replayClaims', 'incompleteConversationIds',
    ];
    if (!hasExactKeys(registrations, fields) ||
        !Array.isArray(registrations.conversations) || registrations.conversations.length > MAX_CONVERSATIONS ||
        !Array.isArray(registrations.executions) || registrations.executions.length > MAX_EXECUTIONS ||
        !Array.isArray(registrations.replayClaims) || registrations.replayClaims.length > MAX_EXECUTIONS ||
        !Array.isArray(registrations.incompleteConversationIds) ||
        registrations.incompleteConversationIds.length > MAX_CONVERSATIONS) {
      throw registrationError('invalid_recovery_history', 'registration recovery history is invalid');
    }
    const maps = [
      conversationsByIdentity, conversationsById, executionsById, observationsById, startClaims, evidenceClaims,
      activeExecutionByConversation, lastExecutionByConversation, sessionIdOwners, writerBindingsByDigest,
      writerDigestByContext,
    ];
    if (restorationUsed || maps.some((map) => map.size !== 0) || historyIncompleteConversationIds.size !== 0) {
      throw registrationError('recovery_registry_not_empty', 'registration recovery requires a fresh kernel');
    }

    const conversationsByIdCandidate = new Map();
    const conversationsByIdentityCandidate = new Map();
    const executionsByIdCandidate = new Map();
    const sessionIdOwnersCandidate = new Map();
    const startClaimsCandidate = new Map();
    const evidenceClaimsCandidate = new Map();
    const lastExecutionByConversationCandidate = new Map();
    const incompleteCandidate = new Set();
    const usedOrders = new Set();
    let maxOrder = 0;
    const conversationsWithExecutions = new Set();

    for (const conversation of registrations.conversations) {
      if (!hasExactKeys(conversation, ['conversationId', 'identity']) ||
          !isBoundedIdentifier(conversation.conversationId)) {
        throw registrationError('invalid_recovery_history', 'conversation history is invalid');
      }
      const identity = normalizeIdentity(conversation.identity);
      if (!identity) throw registrationError('invalid_recovery_history', 'conversation identity is invalid');
      const key = identityKey(identity);
      if (conversationsByIdCandidate.has(conversation.conversationId) ||
          conversationsByIdentityCandidate.has(key)) {
        throw registrationError('invalid_recovery_history', 'conversation history contains duplicates');
      }
      const record = { conversationId: conversation.conversationId, identity, identityKey: key };
      conversationsByIdCandidate.set(record.conversationId, record);
      conversationsByIdentityCandidate.set(key, record);
    }

    for (const conversationId of registrations.incompleteConversationIds) {
      if (!isBoundedIdentifier(conversationId) || incompleteCandidate.has(conversationId) ||
          !conversationsByIdCandidate.has(conversationId)) {
        throw registrationError('invalid_recovery_history', 'incomplete history reference is invalid');
      }
      incompleteCandidate.add(conversationId);
    }

    const sessionIds = new Set();
    for (const execution of registrations.executions) {
      if (!hasExactKeys(execution, ['conversationId', 'executionId', 'sessionId', 'state']) ||
          !isBoundedIdentifier(execution.conversationId) || !isBoundedIdentifier(execution.executionId) ||
          !isBoundedIdentifier(execution.sessionId) || !['unknown', 'ended'].includes(execution.state)) {
        throw registrationError('invalid_recovery_history', 'execution history is invalid');
      }
      const conversation = conversationsByIdCandidate.get(execution.conversationId);
      if (!conversation || executionsByIdCandidate.has(execution.executionId) || sessionIds.has(execution.sessionId)) {
        throw registrationError('invalid_recovery_history', 'execution history reference is invalid');
      }
      sessionIds.add(execution.sessionId);
      conversationsWithExecutions.add(execution.conversationId);
      executionsByIdCandidate.set(execution.executionId, {
        conversationId: execution.conversationId,
        executionId: execution.executionId,
        sessionId: execution.sessionId,
        identity: conversation.identity,
        state: execution.state,
        evidence: null,
        registrationOrder: null,
      });
      sessionIdOwnersCandidate.set(execution.sessionId, {
        conversationId: execution.conversationId,
        identityKey: conversation.identityKey,
      });
    }

    const claimFields = [
      'startIdDigest', 'evidenceIdDigest', 'fingerprintDigest', 'conversationId', 'executionId', 'order',
    ];
    const startDigests = new Set();
    const evidenceDigests = new Set();
    const executionClaims = new Set();
    for (const claim of registrations.replayClaims) {
      if (!hasExactKeys(claim, claimFields) ||
          typeof claim.startIdDigest !== 'string' || typeof claim.evidenceIdDigest !== 'string' ||
          typeof claim.fingerprintDigest !== 'string' ||
          !/^[a-f0-9]{64}$/.test(claim.startIdDigest) ||
          !/^[a-f0-9]{64}$/.test(claim.evidenceIdDigest) ||
          !/^[a-f0-9]{64}$/.test(claim.fingerprintDigest) ||
          !isBoundedIdentifier(claim.conversationId) || !isBoundedIdentifier(claim.executionId) ||
          !Number.isSafeInteger(claim.order) || claim.order < 1 || claim.order > MAX_EXECUTIONS ||
          startDigests.has(claim.startIdDigest) || evidenceDigests.has(claim.evidenceIdDigest) ||
          executionClaims.has(claim.executionId) || usedOrders.has(claim.order)) {
        throw registrationError('invalid_recovery_history', 'registration replay claim is invalid');
      }
      const execution = executionsByIdCandidate.get(claim.executionId);
      if (!execution || execution.conversationId !== claim.conversationId) {
        throw registrationError('invalid_recovery_history', 'registration replay claim reference is invalid');
      }
      startDigests.add(claim.startIdDigest);
      evidenceDigests.add(claim.evidenceIdDigest);
      executionClaims.add(claim.executionId);
      usedOrders.add(claim.order);
      execution.registrationOrder = claim.order;
      maxOrder = Math.max(maxOrder, claim.order);
      startClaimsCandidate.set(claim.startIdDigest, {
        startIdDigest: claim.startIdDigest,
        evidenceIdDigest: claim.evidenceIdDigest,
        fingerprintDigest: claim.fingerprintDigest,
        conversationId: claim.conversationId,
        executionId: claim.executionId,
        order: claim.order,
        requiresRevalidation: true,
      });
      evidenceClaimsCandidate.set(claim.evidenceIdDigest, claim.startIdDigest);
      const previous = lastExecutionByConversationCandidate.get(claim.conversationId);
      if (!previous || previous.registrationOrder < claim.order) {
        lastExecutionByConversationCandidate.set(claim.conversationId, execution);
      }
    }

    for (const execution of executionsByIdCandidate.values()) {
      if (!executionClaims.has(execution.executionId) &&
          !incompleteCandidate.has(execution.conversationId)) {
        throw registrationError('incomplete_recovery_history', 'execution replay claim is missing');
      }
    }
    for (const conversation of conversationsByIdCandidate.values()) {
      if (!conversationsWithExecutions.has(conversation.conversationId) &&
          !incompleteCandidate.has(conversation.conversationId)) {
        throw registrationError('incomplete_recovery_history', 'conversation replay history is missing');
      }
    }
    if (incompleteCandidate.size === 0 &&
        [...usedOrders].sort((left, right) => left - right).some((order, index) => order !== index + 1)) {
      throw registrationError('invalid_recovery_history', 'registration order history is incomplete');
    }
    if (!Number.isSafeInteger(maxOrder + 1)) {
      throw registrationError('invalid_recovery_history', 'registration order is exhausted');
    }
    if (restorationUsed || maps.some((map) => map.size !== 0) || historyIncompleteConversationIds.size !== 0) {
      throw registrationError('recovery_registry_not_empty', 'registration recovery requires a fresh kernel');
    }

    for (const [key, value] of conversationsByIdentityCandidate) conversationsByIdentity.set(key, value);
    for (const [key, value] of conversationsByIdCandidate) conversationsById.set(key, value);
    for (const [key, value] of executionsByIdCandidate) executionsById.set(key, value);
    for (const [key, value] of sessionIdOwnersCandidate) sessionIdOwners.set(key, value);
    for (const [key, value] of startClaimsCandidate) startClaims.set(key, value);
    for (const [key, value] of evidenceClaimsCandidate) evidenceClaims.set(key, value);
    for (const [key, value] of lastExecutionByConversationCandidate) lastExecutionByConversation.set(key, value.executionId);
    for (const value of incompleteCandidate) historyIncompleteConversationIds.add(value);
    nextRegistrationOrder = maxOrder + 1;
    registrationNeedsRevalidation = incompleteCandidate.size > 0;
    restorationUsed = true;
    advanceAuthorityRevision();
    return Object.freeze({
      restored: true,
      conversationCount: conversationsByIdCandidate.size,
      executionCount: executionsByIdCandidate.size,
      historyIncomplete: registrationNeedsRevalidation,
    });
  }

  const registry = Object.freeze({
    observe,
    captureAuthorityRevision,
    checkAuthorityRevision,
    authorizeWriter: authorizeEnvelope,
    authorizeEvent: authorizeEnvelope,
    snapshot,
    isRegisteredSessionId(sessionId) {
      return typeof sessionId === 'string' && sessionIdOwners.has(sessionId);
    },
  });

  const authority = Object.freeze({
    register,
    restoreHistory,
    bindWriter(executionId, bindingInput) {
      if (!isBoundedIdentifier(executionId) || !isRecord(bindingInput)) {
        throw registrationError('invalid_binding', 'writer binding is incomplete');
      }
      const execution = executionsById.get(executionId);
      if (!execution || execution.state !== 'active') {
        throw registrationError('stale_execution', 'writer binding requires an active execution');
      }
      const identity = normalizeIdentity(bindingInput.identity);
      const contextId = bindingInput.contextId;
      const evidence = sanitizeEvidenceMetadata(bindingInput.evidence);
      if (!identity || !identitiesEqual(identity, execution.identity) || !isBoundedIdentifier(contextId) ||
          !evidence || !evidence.evidenceId) {
        throw registrationError('invalid_binding', 'writer binding does not match the registered execution');
      }
      const contextKey = `${executionId}\0${contextId}`;
      const previousDigest = writerDigestByContext.get(contextKey);
      if (!previousDigest && writerBindingsByDigest.size >= MAX_WRITER_BINDINGS) {
        throw registrationError('capacity', 'writer binding capacity reached');
      }
      const token = crypto.randomBytes(32).toString('base64url');
      const digest = tokenDigest(token);
      advanceAuthorityRevision();
      if (previousDigest) writerBindingsByDigest.delete(previousDigest);
      writerBindingsByDigest.set(digest, {
        executionId,
        identity,
        contextId,
        evidence,
      });
      writerDigestByContext.set(contextKey, digest);
      return { token, identity: { ...identity }, contextId, executionId };
    },
    end(executionId) {
      const execution = executionsById.get(executionId);
      if (!execution) return false;
      if (execution.state === 'ended') return true;
      advanceAuthorityRevision();
      execution.state = 'ended';
      activeExecutionByConversation.delete(execution.conversationId);
      revokeExecutionWriters(executionId);
      return true;
    },
  });

  return Object.freeze({ registry, authority });
}

const { createProviderRegistrationAdapter } = require('./provider-registration');

module.exports = { createRegistrationKernel, createProviderRegistrationAdapter };
