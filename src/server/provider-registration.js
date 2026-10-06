'use strict';

const PROVIDER_NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });
const IDENTITY_FIELDS = Object.freeze(['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']);
const NATIVE_IDENTITY_FIELDS = Object.freeze(['nativeIdKind', 'hostId', 'homeScopeId', 'nativeId']);
const NATIVE_CONTEXT_FIELDS = Object.freeze(['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId', 'contextId']);
const BINDING_FIELDS = Object.freeze(['identity', 'contextId', 'evidence']);
const MAX_IDENTIFIER_LENGTH = 512;

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

function isBoundedIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function normalizeIdentity(identity) {
  if (!hasExactKeys(identity, IDENTITY_FIELDS)) return null;
  if (typeof identity.provider !== 'string' || !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, identity.provider) ||
      typeof identity.nativeIdKind !== 'string') return null;
  if (PROVIDER_NATIVE_ID_KINDS[identity.provider] !== identity.nativeIdKind) return null;
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

function identitiesEqual(left, right) {
  return Boolean(left && right) && IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function registrationError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function rejected(status, executionId = null) {
  return { ok: false, status, sessionId: null, conversationId: null, executionId };
}

function createProviderRegistrationAdapter(provider, registry, authority) {
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, provider) || !registry || !authority) {
    throw new TypeError('provider registration adapter requires a supported provider, registry, and authority');
  }
  const expectedKind = PROVIDER_NATIVE_ID_KINDS[provider];

  function identityFromNative(nativeIdentity) {
    if (!hasExactKeys(nativeIdentity, NATIVE_IDENTITY_FIELDS)) return null;
    return normalizeIdentity({ provider, ...nativeIdentity });
  }

  return Object.freeze({
    observe(nativeIdentity, evidenceMetadata) {
      const identity = identityFromNative(nativeIdentity);
      if (!identity) return { ok: false, status: 'mismatch', observationId: null };
      return registry.observe(identity, evidenceMetadata);
    },
    register(nativeIdentity, evidence, startOptions) {
      const identity = identityFromNative(nativeIdentity);
      if (!identity) throw registrationError('invalid_identity', 'native identity does not match this provider adapter');
      return authority.register(identity, evidence, startOptions);
    },
    bindWriter(executionId, binding) {
      if (!hasExactKeys(binding, BINDING_FIELDS)) throw registrationError('invalid_binding', 'writer binding is incomplete');
      const identity = normalizeIdentity(binding.identity);
      if (!identity || identity.provider !== provider || identity.nativeIdKind !== expectedKind) {
        throw registrationError('invalid_binding', 'writer identity does not match this provider adapter');
      }
      return authority.bindWriter(executionId, { ...binding, identity });
    },
    authorizeWrite(envelope, nativeContext) {
      const executionId = isRecord(envelope) && isBoundedIdentifier(envelope.executionId)
        ? envelope.executionId
        : null;
      if (!hasExactKeys(nativeContext, NATIVE_CONTEXT_FIELDS)) return rejected('mismatch', executionId);
      const nativeIdentity = normalizeIdentity({
        provider: nativeContext.provider,
        nativeIdKind: nativeContext.nativeIdKind,
        hostId: nativeContext.hostId,
        homeScopeId: nativeContext.homeScopeId,
        nativeId: nativeContext.nativeId,
      });
      const envelopeIdentity = isRecord(envelope) ? normalizeIdentity(envelope.identity) : null;
      if (nativeContext.provider !== provider || !nativeIdentity || !envelopeIdentity ||
          !identitiesEqual(nativeIdentity, envelopeIdentity) || nativeContext.contextId !== envelope.contextId) {
        return rejected('mismatch', executionId);
      }
      return registry.authorizeWriter(envelope);
    },
  });
}

module.exports = { createProviderRegistrationAdapter };
