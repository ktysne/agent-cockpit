'use strict';

const { createHash } = require('node:crypto');
const { assertIdentifier, captureExactRecord } = require('./reclamation-codec-primitives');
const { encodeNormalized } = require('./reclamation-json-codec');

const CLAIM_FIELDS = [
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding',
];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const ACTOR_FIELDS = ['kind', 'id'];
const BINDING_FIELDS = ['periodId', 'actor'];
const SOURCE_FIELDS = [
  'launchRef', 'claims', 'identity', 'executionBinding', 'conversationId', 'sessionId',
];
const INVALID_BINDING = 'invalid_instruction_delivery_binding';

function fail(code) {
  const error = new TypeError(code);
  error.code = code;
  throw error;
}

function makeRecord(entries) {
  const result = Object.create(null);
  for (const [key, value] of entries) {
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function makeArray(values) {
  const result = new Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    Object.defineProperty(result, String(index), {
      value: values[index],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function exact(value, fields, code) {
  try {
    return captureExactRecord(value, fields, code);
  } catch {
    fail(code);
  }
}

function readOwnData(value, field, code) {
  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, field);
  } catch {
    fail(code);
  }
  if (!descriptor || !Object.hasOwn(descriptor, 'value')) fail(code);
  return descriptor.value;
}

function normalizeActor(value, code) {
  const actor = exact(value, ACTOR_FIELDS, code);
  assertIdentifier(actor.id, code);
  if (actor.kind !== 'agent' && actor.kind !== 'tool-use') fail(code);
  return makeRecord(ACTOR_FIELDS.map((field) => [field, actor[field]]));
}

function normalizeBinding(value, code) {
  const binding = exact(value, BINDING_FIELDS, code);
  assertIdentifier(binding.periodId, code);
  return makeRecord([
    ['periodId', binding.periodId],
    ['actor', normalizeActor(binding.actor, code)],
  ]);
}

function normalizeIdentity(value, code) {
  const identity = exact(value, IDENTITY_FIELDS, code);
  assertIdentifier(identity.hostId, code);
  assertIdentifier(identity.homeScopeId, code);
  assertIdentifier(identity.nativeId, code);
  if ((identity.provider !== 'claude' || identity.nativeIdKind !== 'session') &&
      (identity.provider !== 'codex' || identity.nativeIdKind !== 'thread')) fail(code);
  return makeRecord(IDENTITY_FIELDS.map((field) => [field, identity[field]]));
}

function compactString(value, code) {
  if (typeof value !== 'string') fail(code);
  assertIdentifier(value, code);
  return JSON.stringify(value);
}

function compactBinding(binding, code) {
  return `{"periodId":${compactString(binding.periodId, code)},"actor":{"kind":${compactString(binding.actor.kind, code)},"id":${compactString(binding.actor.id, code)}}}`;
}

function normalizeClaims(value, code) {
  const claims = exact(value, CLAIM_FIELDS, code);
  for (const field of CLAIM_FIELDS.slice(0, 9)) assertIdentifier(claims[field], code);
  if ((claims.provider !== 'claude' || claims.nativeIdKind !== 'session') &&
      (claims.provider !== 'codex' || claims.nativeIdKind !== 'thread')) fail(code);
  const validPurpose = (claims.origin === 'standalone' &&
      (claims.purpose === 'agent' || claims.purpose === 'pr-creator') && claims.originBinding === null) ||
    (claims.origin === 'delegated' && claims.purpose === 'agent' && claims.originBinding !== null) ||
    (claims.origin === 'review' && claims.purpose === 'cross-review' && claims.originBinding !== null);
  if (!validPurpose) fail(code);
  const originBinding = claims.originBinding === null ? null : normalizeBinding(claims.originBinding, code);
  return makeRecord([
    ...CLAIM_FIELDS.slice(0, 9).map((field) => [field, claims[field]]),
    ['originBinding', originBinding],
  ]);
}

function normalizeInstructionSource(value, code) {
  const source = exact(value, SOURCE_FIELDS, code);
  const launchRef = source.launchRef;
  const conversationId = source.conversationId;
  const sessionId = source.sessionId;
  assertIdentifier(launchRef, code);
  assertIdentifier(conversationId, code);
  assertIdentifier(sessionId, code);
  const claims = normalizeClaims(source.claims, code);
  const identity = normalizeIdentity(source.identity, code);
  const executionBinding = normalizeBinding(source.executionBinding, code);
  if (identity.provider !== claims.provider || identity.nativeIdKind !== claims.nativeIdKind ||
      identity.hostId !== claims.hostId || identity.homeScopeId !== claims.homeScopeId) fail(code);
  return makeRecord([
    ['launchRef', launchRef],
    ['claims', claims],
    ['identity', identity],
    ['executionBinding', executionBinding],
    ['conversationId', conversationId],
    ['sessionId', sessionId],
  ]);
}

function compactClaimsDigest(claims, code) {
  const pieces = [
    '{',
    `"launchId":${compactString(claims.launchId, code)},`,
    `"runId":${compactString(claims.runId, code)},`,
    `"attemptId":${compactString(claims.attemptId, code)},`,
    `"provider":${compactString(claims.provider, code)},`,
    `"nativeIdKind":${compactString(claims.nativeIdKind, code)},`,
    `"hostId":${compactString(claims.hostId, code)},`,
    `"homeScopeId":${compactString(claims.homeScopeId, code)},`,
    `"origin":${compactString(claims.origin, code)},`,
    `"purpose":${compactString(claims.purpose, code)},`,
    `"originBinding":${claims.originBinding === null ? 'null' : compactBinding(claims.originBinding, code)}`,
    '}',
  ];
  return createHash('sha256').update(pieces.join(''), 'utf8').digest('hex');
}

function projectInstructionDeliveryReferences(normalizedSource) {
  const source = normalizeInstructionSource(normalizedSource, INVALID_BINDING);
  const claims = source.claims;
  const identity = source.identity;
  const binding = source.executionBinding;
  const launchKey = makeArray([claims.launchId, claims.runId, claims.attemptId]);
  const claimsDigest = compactClaimsDigest(claims, INVALID_BINDING);
  const target = makeRecord([
    ['kind', 'execution'],
    ['launchRef', source.launchRef],
    ['claims', claims],
    ['identity', identity],
    ['periodId', binding.periodId],
    ['actor', binding.actor],
    ['conversationId', source.conversationId],
    ['sessionId', source.sessionId],
  ]);
  const sourceRef = makeRecord([
    ['launchRef', source.launchRef],
    ['launchKey', launchKey],
    ['sourceClaimsDigest', claimsDigest],
    ['identity', identity],
    ['executionBinding', binding],
    ['conversationId', source.conversationId],
    ['sessionId', source.sessionId],
  ]);
  const targetRef = makeRecord([
    ['kind', 'execution'],
    ['launchRef', source.launchRef],
    ['launchKey', launchKey],
    ['targetClaimsDigest', claimsDigest],
    ['identity', identity],
    ['periodId', binding.periodId],
    ['actor', binding.actor],
    ['conversationId', source.conversationId],
    ['sessionId', source.sessionId],
  ]);
  return makeRecord([
    ['source', source],
    ['target', target],
    ['sourceRef', sourceRef],
    ['targetRef', targetRef],
  ]);
}

function sameNormalized(left, right, errorCode) {
  try {
    return encodeNormalized(left).bytes.equals(encodeNormalized(right).bytes);
  } catch {
    fail(errorCode);
  }
}

function assertInstructionDeliveryBinding(normalizedInstruction, normalizedDelivery, errorCode) {
  if (typeof errorCode !== 'string') fail(INVALID_BINDING);
  const instruction = normalizedInstruction;
  const delivery = normalizedDelivery;
  const refs = projectInstructionDeliveryReferences(readOwnData(instruction, 'source', errorCode));
  if (readOwnData(delivery, 'kind', errorCode) !== 'instruction' ||
      readOwnData(delivery, 'deliveryAttemptId', errorCode) !== readOwnData(instruction, 'deliveryAttemptId', errorCode) ||
      readOwnData(delivery, 'logicalMessageId', errorCode) !== readOwnData(instruction, 'logicalMessageId', errorCode) ||
      readOwnData(delivery, 'revision', errorCode) !== readOwnData(instruction, 'revision', errorCode) ||
      readOwnData(delivery, 'payloadDigest', errorCode) !== readOwnData(instruction, 'envelopeDigest', errorCode) ||
      readOwnData(delivery, 'sourceExecutionId', errorCode) !== refs.source.executionBinding.periodId) fail(errorCode);

  if (readOwnData(delivery, 'recordType', errorCode) === 'detail') {
    if (!sameNormalized(readOwnData(delivery, 'source', errorCode), refs.source, errorCode) ||
        !sameNormalized(readOwnData(delivery, 'target', errorCode), refs.target, errorCode)) fail(errorCode);
    return;
  }
  if (readOwnData(delivery, 'recordType', errorCode) === 'reclaimed') {
    if (!sameNormalized(readOwnData(delivery, 'sourceRef', errorCode), refs.sourceRef, errorCode) ||
        !sameNormalized(readOwnData(delivery, 'targetRef', errorCode), refs.targetRef, errorCode)) fail(errorCode);
    return;
  }
  fail(errorCode);
}

module.exports = {
  assertInstructionDeliveryBinding,
  projectInstructionDeliveryReferences,
};
