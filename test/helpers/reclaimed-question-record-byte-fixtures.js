'use strict';

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const RETENTION_MS = 604_800_000;
const MAX_TIMEOUT_MS = 30 * 60_000;
const MAX_ESCAPED_IDENTIFIER = '\uD800'.repeat(512);
const MAX_ESCAPED_STRING_BYTES = 6 * 512 + 2;
const MAX_DIGEST = 'a'.repeat(64);
const UUID = '11111111-1111-4111-8111-111111111111';
const ASCII_ESCAPED_IDENTIFIER = Array.from({ length: 512 }, (_, index) =>
  index % 2 === 0 ? '"' : '\\').join('');

function identityFor(provider, identifier) {
  return {
    provider,
    nativeIdKind: provider === 'claude' ? 'session' : 'thread',
    hostId: identifier,
    homeScopeId: identifier,
    nativeId: identifier,
  };
}

function bindingFor(identifier) {
  return { periodId: identifier, actor: { kind: 'tool-use', id: identifier } };
}

function createMaximumQuestionReservation({
  identifier = MAX_ESCAPED_IDENTIFIER,
  provider = 'claude',
} = {}) {
  const identity = identityFor(provider, identifier);
  const executionBinding = bindingFor(identifier);
  return {
    internalQuestionId: identifier,
    identity,
    periodId: identifier,
    questionId: identifier,
    contentDigest: MAX_DIGEST,
    executionId: identifier,
    conversationId: identifier,
    launchRef: identifier,
    executionBinding,
    createdAt: MAX_SAFE_INTEGER - 2 * RETENTION_MS - MAX_TIMEOUT_MS,
    revision: MAX_SAFE_INTEGER,
    selectionSource: 'away-default',
    selectedAt: MAX_SAFE_INTEGER - 2 * RETENTION_MS,
    deliveryIntent: {
      deliveryAttemptId: identifier,
      logicalMessageId: identifier,
      revision: MAX_SAFE_INTEGER,
      payloadDigest: MAX_DIGEST,
    },
    deliveryCreationState: 'checkpointed',
    checkpointState: 'superseded_before_send',
    sourceClaimsDigest: MAX_DIGEST,
    sessionId: identifier,
    externalResolution: {
      resolvedAt: MAX_SAFE_INTEGER - RETENTION_MS,
      evidenceDigest: MAX_DIGEST,
    },
    cancelledAt: MAX_SAFE_INTEGER,
    terminalResultKind: 'superseded_before_send',
    quarantinedAt: MAX_SAFE_INTEGER - RETENTION_MS,
    bodyState: 'reclaimed',
    reclaimedAt: MAX_SAFE_INTEGER,
    reclamation: {
      operationId: UUID,
      preparedAt: MAX_SAFE_INTEGER,
      deliveryPresence: 'checkpoint',
      checkpointState: 'superseded_before_send',
    },
  };
}

function createMaximumQuestionGrave({
  identifier = MAX_ESCAPED_IDENTIFIER,
  provider = 'claude',
} = {}) {
  const identity = identityFor(provider, identifier);
  const executionBinding = bindingFor(identifier);
  const sourceRef = {
    launchRef: identifier,
    launchKey: [identifier, identifier, identifier],
    sourceClaimsDigest: MAX_DIGEST,
    identity,
    executionBinding,
    conversationId: identifier,
    sessionId: identifier,
  };
  const targetRef = {
    kind: 'execution',
    launchRef: identifier,
    launchKey: [identifier, identifier, identifier],
    targetClaimsDigest: MAX_DIGEST,
    identity,
    periodId: identifier,
    actor: executionBinding.actor,
    conversationId: identifier,
    sessionId: identifier,
  };
  const correlation = {
    deliveryAttemptId: identifier,
    revision: MAX_SAFE_INTEGER,
    payloadDigest: MAX_DIGEST,
    targetPeriodId: identifier,
    nativeTurnId: identifier,
    nativeItemId: identifier,
    clientRequestId: identifier,
  };
  return {
    recordType: 'reclaimed',
    deliveryAttemptId: identifier,
    kind: 'question',
    logicalMessageId: identifier,
    revision: MAX_SAFE_INTEGER,
    sourceExecutionId: identifier,
    payloadDigest: MAX_DIGEST,
    state: 'applied',
    terminalAt: MAX_SAFE_INTEGER - RETENTION_MS,
    cancelRequested: false,
    ownerGeneration: null,
    acceptedCorrelation: structuredClone(correlation),
    appliedCorrelation: structuredClone(correlation),
    sourceRef,
    targetRef,
    reclamation: {
      operationId: UUID,
      reclaimedAt: MAX_SAFE_INTEGER,
      reason: 'retired_question_period',
    },
  };
}

const QUESTION_RESERVATION_MAX_SHAPE = Object.freeze({
  internalQuestionId: MAX_ESCAPED_IDENTIFIER,
  identity: Object.freeze({
    provider: 'claude',
    nativeIdKind: 'session',
    hostId: MAX_ESCAPED_IDENTIFIER,
    homeScopeId: MAX_ESCAPED_IDENTIFIER,
    nativeId: MAX_ESCAPED_IDENTIFIER,
  }),
  periodId: MAX_ESCAPED_IDENTIFIER,
  questionId: MAX_ESCAPED_IDENTIFIER,
  contentDigest: MAX_DIGEST,
  executionId: MAX_ESCAPED_IDENTIFIER,
  conversationId: MAX_ESCAPED_IDENTIFIER,
  launchRef: MAX_ESCAPED_IDENTIFIER,
  executionBinding: Object.freeze({
    periodId: MAX_ESCAPED_IDENTIFIER,
    actor: Object.freeze({ kind: 'tool-use', id: MAX_ESCAPED_IDENTIFIER }),
  }),
  createdAt: MAX_SAFE_INTEGER,
  revision: MAX_SAFE_INTEGER,
  selectionSource: 'away-default',
  selectedAt: MAX_SAFE_INTEGER,
  deliveryIntent: Object.freeze({
    deliveryAttemptId: MAX_ESCAPED_IDENTIFIER,
    logicalMessageId: MAX_ESCAPED_IDENTIFIER,
    revision: MAX_SAFE_INTEGER,
    payloadDigest: MAX_DIGEST,
  }),
  deliveryCreationState: 'checkpointed',
  checkpointState: 'superseded_before_send',
  sourceClaimsDigest: MAX_DIGEST,
  sessionId: MAX_ESCAPED_IDENTIFIER,
  externalResolution: Object.freeze({ resolvedAt: MAX_SAFE_INTEGER, evidenceDigest: MAX_DIGEST }),
  cancelledAt: MAX_SAFE_INTEGER,
  terminalResultKind: 'superseded_before_send',
  quarantinedAt: MAX_SAFE_INTEGER,
  bodyState: 'reclaimed',
  reclaimedAt: MAX_SAFE_INTEGER,
  reclamation: Object.freeze({
    operationId: UUID,
    preparedAt: MAX_SAFE_INTEGER,
    deliveryPresence: 'checkpoint',
    checkpointState: 'superseded_before_send',
  }),
});

const QUESTION_GRAVE_MAX_SHAPE = Object.freeze({
  recordType: 'reclaimed',
  deliveryAttemptId: MAX_ESCAPED_IDENTIFIER,
  kind: 'question',
  logicalMessageId: MAX_ESCAPED_IDENTIFIER,
  revision: MAX_SAFE_INTEGER,
  sourceExecutionId: MAX_ESCAPED_IDENTIFIER,
  payloadDigest: MAX_DIGEST,
  state: 'applied',
  terminalAt: MAX_SAFE_INTEGER,
  cancelRequested: false,
  ownerGeneration: null,
  acceptedCorrelation: Object.freeze({
    deliveryAttemptId: MAX_ESCAPED_IDENTIFIER,
    revision: MAX_SAFE_INTEGER,
    payloadDigest: MAX_DIGEST,
    targetPeriodId: MAX_ESCAPED_IDENTIFIER,
    nativeTurnId: MAX_ESCAPED_IDENTIFIER,
    nativeItemId: MAX_ESCAPED_IDENTIFIER,
    clientRequestId: MAX_ESCAPED_IDENTIFIER,
  }),
  appliedCorrelation: Object.freeze({
    deliveryAttemptId: MAX_ESCAPED_IDENTIFIER,
    revision: MAX_SAFE_INTEGER,
    payloadDigest: MAX_DIGEST,
    targetPeriodId: MAX_ESCAPED_IDENTIFIER,
    nativeTurnId: MAX_ESCAPED_IDENTIFIER,
    nativeItemId: MAX_ESCAPED_IDENTIFIER,
    clientRequestId: MAX_ESCAPED_IDENTIFIER,
  }),
  sourceRef: Object.freeze({
    launchRef: MAX_ESCAPED_IDENTIFIER,
    launchKey: Object.freeze([MAX_ESCAPED_IDENTIFIER, MAX_ESCAPED_IDENTIFIER, MAX_ESCAPED_IDENTIFIER]),
    sourceClaimsDigest: MAX_DIGEST,
    identity: Object.freeze({
      provider: 'claude',
      nativeIdKind: 'session',
      hostId: MAX_ESCAPED_IDENTIFIER,
      homeScopeId: MAX_ESCAPED_IDENTIFIER,
      nativeId: MAX_ESCAPED_IDENTIFIER,
    }),
    executionBinding: Object.freeze({
      periodId: MAX_ESCAPED_IDENTIFIER,
      actor: Object.freeze({ kind: 'tool-use', id: MAX_ESCAPED_IDENTIFIER }),
    }),
    conversationId: MAX_ESCAPED_IDENTIFIER,
    sessionId: MAX_ESCAPED_IDENTIFIER,
  }),
  targetRef: Object.freeze({
    kind: 'execution',
    launchRef: MAX_ESCAPED_IDENTIFIER,
    launchKey: Object.freeze([MAX_ESCAPED_IDENTIFIER, MAX_ESCAPED_IDENTIFIER, MAX_ESCAPED_IDENTIFIER]),
    targetClaimsDigest: MAX_DIGEST,
    identity: Object.freeze({
      provider: 'claude',
      nativeIdKind: 'session',
      hostId: MAX_ESCAPED_IDENTIFIER,
      homeScopeId: MAX_ESCAPED_IDENTIFIER,
      nativeId: MAX_ESCAPED_IDENTIFIER,
    }),
    periodId: MAX_ESCAPED_IDENTIFIER,
    actor: Object.freeze({ kind: 'tool-use', id: MAX_ESCAPED_IDENTIFIER }),
    conversationId: MAX_ESCAPED_IDENTIFIER,
    sessionId: MAX_ESCAPED_IDENTIFIER,
  }),
  reclamation: Object.freeze({
    operationId: UUID,
    reclaimedAt: MAX_SAFE_INTEGER,
    reason: 'retired_question_period',
  }),
});

const NULLABLE_PATHS = new Set([
  'selectionSource', 'selectedAt', 'deliveryIntent', 'checkpointState', 'sourceClaimsDigest', 'sessionId',
  'externalResolution', 'cancelledAt', 'terminalResultKind', 'reclamation.checkpointState',
  'terminalAt', 'acceptedCorrelation', 'appliedCorrelation',
  'acceptedCorrelation.nativeTurnId', 'acceptedCorrelation.nativeItemId',
  'appliedCorrelation.nativeTurnId', 'appliedCorrelation.nativeItemId',
]);

function assertShapeFits(value, shape, path = []) {
  const keyPath = path.join('.');
  if (value === null) {
    if (shape === null || NULLABLE_PATHS.has(keyPath)) return;
    throw new TypeError(`unexpected_null:${keyPath}`);
  }
  if (Array.isArray(shape)) {
    if (!Array.isArray(value) || value.length !== shape.length) throw new TypeError(`shape_mismatch:${keyPath}`);
    for (let index = 0; index < shape.length; index += 1) assertShapeFits(value[index], shape[index], [...path, String(index)]);
    return;
  }
  if (shape !== null && typeof shape === 'object') {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new TypeError(`shape_mismatch:${keyPath}`);
    const valueKeys = Object.keys(value).sort();
    const shapeKeys = Object.keys(shape).sort();
    if (JSON.stringify(valueKeys) !== JSON.stringify(shapeKeys)) throw new TypeError(`field_mismatch:${keyPath}`);
    for (const key of shapeKeys) assertShapeFits(value[key], shape[key], [...path, key]);
    return;
  }
  if (typeof shape === 'string') {
    if (typeof value !== 'string' || value.length > 512) throw new TypeError(`string_bound:${keyPath}`);
    return;
  }
  if (typeof shape === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`integer_bound:${keyPath}`);
    return;
  }
  if (typeof shape === 'boolean' && typeof value !== 'boolean') throw new TypeError(`boolean_bound:${keyPath}`);
}

function prettyJsonUpperBound(value, depth = 0) {
  if (typeof value === 'string') return MAX_ESCAPED_STRING_BYTES;
  if (typeof value === 'number') return 16;
  if (typeof value === 'boolean') return 5;
  if (value === null) return 4;
  if (Array.isArray(value)) {
    if (value.length === 0) return 2;
    return 1 + value.reduce((sum, item, index) => sum + 1 + 2 * (depth + 1) +
      prettyJsonUpperBound(item, depth + 1) + (index < value.length - 1 ? 1 : 0), 0) + 1 + 2 * depth + 1;
  }
  const entries = Object.entries(value);
  if (entries.length === 0) return 2;
  return 1 + entries.reduce((sum, [key, child], index) => sum + 1 + 2 * (depth + 1) +
    Buffer.byteLength(JSON.stringify(key), 'utf8') + 2 + prettyJsonUpperBound(child, depth + 1) +
    (index < entries.length - 1 ? 1 : 0), 0) + 1 + 2 * depth + 1;
}

function measureJson(normalized, encodeNormalized) {
  const pretty = JSON.stringify(normalized, null, 2);
  const prettyBytes = Buffer.byteLength(pretty, 'utf8') + 1;
  const compactBytes = Buffer.byteLength(JSON.stringify(normalized), 'utf8');
  const encoded = encodeNormalized(normalized);
  return {
    prettyBytes,
    compactBytes,
    encodedBytes: encoded.sizeBytes,
    encodedLength: encoded.bytes.length,
    encodedText: encoded.bytes.toString('utf8'),
    prettyWithLf: `${pretty}\n`,
  };
}

module.exports = {
  ASCII_ESCAPED_IDENTIFIER,
  MAX_ESCAPED_IDENTIFIER,
  MAX_ESCAPED_STRING_BYTES,
  MAX_SAFE_INTEGER,
  QUESTION_GRAVE_MAX_SHAPE,
  QUESTION_RESERVATION_MAX_SHAPE,
  assertShapeFits,
  createMaximumQuestionGrave,
  createMaximumQuestionReservation,
  prettyJsonUpperBound,
  measureJson,
};
