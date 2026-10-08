'use strict';

const crypto = require('node:crypto');
const { types } = require('node:util');
const clock = Date.now;
const CAPABILITY_TTL_MS = 60_000;
const MAX_CAPABILITIES = 128;
const MAX_CAPABILITY_BYTES = 256 * 1024;
const METADATA_FIELDS = ['deliveryAttemptId', 'revision', 'payloadDigest', 'nativeContentDigest', 'source', 'target', 'mode', 'expectedTurnId'];
const CLAIM_FIELDS = ['launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'origin', 'purpose', 'originBinding'];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];

function dispatchError(code = 'instruction_dispatch_unavailable') {
  const error = new Error('owned native instruction dispatch rejected');
  error.code = code;
  return error;
}

function exactData(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) throw dispatchError();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) throw dispatchError();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) throw dispatchError();
  const result = {};
  for (const field of fields) {
    const descriptor = descriptors[field];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) throw dispatchError();
    result[field] = descriptor.value;
  }
  return result;
}

function identifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 1024 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function checkedIdentifier(value) { if (!identifier(value)) throw dispatchError(); return value; }
function sha256(value) { return crypto.createHash('sha256').update(value, 'utf8').digest('hex'); }
function freezeTree(value) { for (const item of Object.values(value)) if (item && typeof item === 'object') freezeTree(item); return Object.freeze(value); }
function actor(value) { const result = exactData(value, ['kind', 'id']); checkedIdentifier(result.kind); checkedIdentifier(result.id); return result; }
function binding(value) { const result = exactData(value, ['periodId', 'actor']); checkedIdentifier(result.periodId); result.actor = actor(result.actor); return result; }
function identity(value) {
  const result = exactData(value, IDENTITY_FIELDS);
  for (const field of IDENTITY_FIELDS) checkedIdentifier(result[field]);
  if (!['claude', 'codex'].includes(result.provider) || result.nativeIdKind !== (result.provider === 'codex' ? 'thread' : 'session')) throw dispatchError();
  return result;
}
function claims(value) {
  const result = exactData(value, CLAIM_FIELDS);
  for (const field of CLAIM_FIELDS.filter((name) => name !== 'originBinding')) checkedIdentifier(result[field]);
  if (!['standalone', 'delegated', 'review'].includes(result.origin)) throw dispatchError();
  result.originBinding = result.originBinding === null ? null : binding(result.originBinding);
  if ((result.origin === 'standalone') !== (result.originBinding === null)) throw dispatchError();
  return result;
}
function sourceProjection(value) {
  const result = exactData(value, ['launchRef', 'claims', 'identity', 'executionBinding', 'conversationId', 'sessionId']);
  for (const field of ['launchRef', 'conversationId', 'sessionId']) checkedIdentifier(result[field]);
  result.claims = claims(result.claims); result.identity = identity(result.identity); result.executionBinding = binding(result.executionBinding);
  for (const field of ['provider', 'nativeIdKind', 'hostId', 'homeScopeId']) if (result.claims[field] !== result.identity[field]) throw dispatchError();
  return result;
}
function normalizeMetadata(value) {
  const result = exactData(value, METADATA_FIELDS);
  checkedIdentifier(result.deliveryAttemptId);
  if (!Number.isSafeInteger(result.revision) || result.revision < 0 ||
      ![result.payloadDigest, result.nativeContentDigest].every((digest) => typeof digest === 'string' && /^[a-f0-9]{64}$/.test(digest)) ||
      !['steer', 'start'].includes(result.mode) ||
      (result.mode === 'steer' ? !identifier(result.expectedTurnId) : result.expectedTurnId !== null)) throw dispatchError();
  result.source = sourceProjection(result.source);
  const target = exactData(result.target, ['kind', 'launchRef', 'claims', 'identity', 'periodId', 'actor', 'conversationId', 'sessionId']);
  if (target.kind !== 'execution') throw dispatchError();
  const projected = sourceProjection({ launchRef: target.launchRef, claims: target.claims, identity: target.identity,
    executionBinding: { periodId: target.periodId, actor: target.actor }, conversationId: target.conversationId, sessionId: target.sessionId });
  if (JSON.stringify(projected) !== JSON.stringify(result.source)) throw dispatchError();
  result.target = { kind: 'execution', launchRef: projected.launchRef, claims: projected.claims, identity: projected.identity,
    periodId: projected.executionBinding.periodId, actor: projected.executionBinding.actor, conversationId: projected.conversationId, sessionId: projected.sessionId };
  return freezeTree(result);
}
function normalizeInput(value) {
  if (!Array.isArray(value) || types.isProxy(value) || value.length !== 1 || Reflect.ownKeys(value).length !== 2) throw dispatchError();
  const element = Object.getOwnPropertyDescriptor(value, '0');
  if (!element || !Object.hasOwn(element, 'value')) throw dispatchError();
  const item = exactData(element.value, ['type', 'text', 'text_elements']);
  if (item.type !== 'text' || typeof item.text !== 'string' || !item.text.length ||
      !Array.isArray(item.text_elements) || types.isProxy(item.text_elements) || item.text_elements.length ||
      Reflect.ownKeys(item.text_elements).length !== 1 || Buffer.byteLength(item.text, 'utf8') > MAX_CAPABILITY_BYTES) throw dispatchError();
  return Object.freeze([Object.freeze({ type: 'text', text: item.text, text_elements: Object.freeze([]) })]);
}
function normalizeCommand(value) {
  const command = exactData(value, [...METADATA_FIELDS, 'input']);
  const metadata = normalizeMetadata(Object.fromEntries(METADATA_FIELDS.map((key) => [key, command[key]])));
  const input = normalizeInput(command.input);
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_CAPABILITY_BYTES) throw dispatchError();
  if (sha256(JSON.stringify(input)) !== metadata.nativeContentDigest ||
      sha256(JSON.stringify({ schemaVersion: 1, mode: metadata.mode, expectedTurnId: metadata.expectedTurnId, input })) !== metadata.payloadDigest) throw dispatchError('instruction_payload_mismatch');
  return Object.freeze({ ...metadata, input });
}

function createOwnedInstructionDispatch(bindingOwner) {
  const capabilities = new WeakMap();
  const nativeCapabilities = new WeakMap();
  const entries = new Map();
  const listeners = new Set();
  const closedListeners = new Set();
  let bytes = 0;
  function expire() {
    const now = clock();
    for (const entry of entries.values()) if (!entry.used && entry.expiresAt <= now) entry.retired = true;
  }
  function current(entry, metadata) {
    return entry && !entry.used && !entry.retired && entry.expiresAt > clock() &&
      entry.authorization.checkFinal() === true && entry.fingerprint === JSON.stringify(metadata) && bindingOwner.checkNative(entry.nativeToken) === true;
  }
  bindingOwner.subscribeNative((token, receipt) => {
    const entry = nativeCapabilities.get(token);
    if (!entry || !entry.used || entry.retired) return;
    if (entry.authorization.checkEvidenceScope() !== true) return;
    const observation = bindingOwner.consumeEvidence(token, receipt);
    if (!observation || entry.authorization.checkEvidenceScope() !== true) return;
    const evidence = Object.freeze({ source: entry.metadata.source, target: entry.metadata.target,
      clientRequestId: entry.metadata.deliveryAttemptId, nativeTurnId: observation.nativeTurnId,
      nativeItemId: observation.nativeItemId, input: observation.input });
    for (const listener of [...listeners]) {
      if (entry.authorization.checkEvidenceScope() !== true) return;
      try { listener(entry.capability, evidence); } catch {}
    }
  });
  bindingOwner.subscribeNativeClosed?.((token, reason) => {
    const entry = nativeCapabilities.get(token);
    if (!entry || entry.retired) return;
    entry.retired = true;
    for (const listener of [...closedListeners]) { try { listener(entry.capability, reason); } catch {} }
  });
  return Object.freeze({
    prepareInstructionDispatch(value) {
      expire();
      const metadata = normalizeMetadata(value);
      const fingerprint = JSON.stringify(metadata);
      const previous = entries.get(metadata.deliveryAttemptId);
      if (previous) return current(previous, metadata) ? previous.capability : null;
      const size = Buffer.byteLength(fingerprint, 'utf8');
      if (entries.size >= MAX_CAPABILITIES || bytes + size > MAX_CAPABILITY_BYTES) return null;
      const authorization = bindingOwner.capture(metadata);
      if (!authorization) return null;
      const nativeToken = bindingOwner.prepareNative(metadata);
      if (!nativeToken || authorization.checkFinal() !== true) return null;
      const capability = Object.freeze(Object.create(null));
      const entry = { capability, metadata, fingerprint, nativeToken, authorization, size, expiresAt: clock() + CAPABILITY_TTL_MS, used: false, retired: false };
      capabilities.set(capability, entry); nativeCapabilities.set(nativeToken, entry); entries.set(metadata.deliveryAttemptId, entry); bytes += size;
      return capability;
    },
    checkInstructionDispatch(capability, value) {
      try {
        expire();
        const metadata = normalizeMetadata(value); const entry = capabilities.get(capability);
        if (!current(entry, metadata)) return false;
        const authorization = bindingOwner.capture(metadata);
        return Boolean(authorization && authorization.checkFinal() === true);
      } catch { return false; }
    },
    dispatchInstructionNow(capability, value) {
      const command = normalizeCommand(value);
      const metadata = normalizeMetadata(Object.fromEntries(METADATA_FIELDS.map((key) => [key, command[key]])));
      const entry = capabilities.get(capability);
      if (!current(entry, metadata)) throw dispatchError();
      const authorization = bindingOwner.capture(metadata);
      if (!authorization) throw dispatchError();
      return bindingOwner.dispatchNative(entry.nativeToken, command, () => {
        if (entry.used || entry.retired || entry.expiresAt <= clock() || authorization.checkFinal() !== true) return false;
        entry.used = true;
        return true;
      });
    },
    subscribeInstructionEvidence(listener) {
      if (typeof listener !== 'function') throw dispatchError();
      listeners.add(listener); return () => listeners.delete(listener);
    },
    subscribeInstructionClosed(listener) {
      if (typeof listener !== 'function') throw dispatchError();
      closedListeners.add(listener); return () => closedListeners.delete(listener);
    },
    closeInstructionObservation(capability, value) {
      const entry = capabilities.get(capability);
      const metadata = normalizeMetadata(value);
      if (!entry || entry.retired || entry.fingerprint !== JSON.stringify(metadata)) return false;
      entry.retired = true;
      return bindingOwner.closeNative?.(entry.nativeToken) === true;
    },
  });
}

module.exports = { createOwnedInstructionDispatch, normalizeMetadata, normalizeCommand, normalizeInput, exactData, sha256, dispatchError };
