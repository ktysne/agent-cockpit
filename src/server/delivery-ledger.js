'use strict';

const { createHash } = require('node:crypto');

const PROVIDER_NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_PAYLOAD_BYTES = 1024 * 1024;
const MAX_DELIVERIES = 20_000;
const MAX_NOTIFICATION_TARGETS = 10_000;
const MAX_LOGICAL_TOMBSTONES = 20_000;
const DELIVERY_STATES = new Set([
  'available', 'claimed', 'sending', 'accepted', 'applied', 'unknown',
  'cancelled_before_send', 'superseded_before_send',
]);
const DELIVERY_KINDS = new Set(['question', 'result', 'pr-notification']);
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const CLAIM_FIELDS = [
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding',
];
const DELIVERY_FIELDS = [
  'deliveryAttemptId', 'kind', 'logicalMessageId', 'revision', 'sourceExecutionId',
  'source', 'target', 'ownerGeneration', 'payloadDigest', 'state', 'cancelRequested',
  'acceptedCorrelation', 'appliedCorrelation',
];
const SOURCE_FIELDS = [
  'launchRef', 'claims', 'identity', 'executionBinding', 'conversationId', 'sessionId',
];
const TARGET_FIELDS = [
  'kind', 'launchRef', 'claims', 'identity', 'periodId', 'actor', 'conversationId', 'sessionId',
];
const TOMBSTONE_FIELDS = [
  'kind', 'sourceExecutionId', 'logicalMessageId', 'revision',
  'targetLaunchKey', 'sourceLaunchKey', 'payloadDigest',
];
const LEDGER_FIELDS = [
  'schemaVersion', 'revision', 'deliveries', 'notificationTargets', 'logicalTombstones',
];
const CORRELATION_FIELDS = [
  'deliveryAttemptId', 'revision', 'payloadDigest', 'targetPeriodId',
  'nativeTurnId', 'nativeItemId', 'clientRequestId',
];

function ledgerError(code) {
  const error = new Error('delivery ledger rejected the operation');
  error.code = code;
  return error;
}

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

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function isDenseArray(value) {
  if (!Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value);
  return keys.length === value.length + 1 && keys.includes('length') &&
    keys.slice(0, -1).every((key, index) => key === String(index));
}

function nonNegativeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeActor(value) {
  if (!hasExactKeys(value, ['kind', 'id']) ||
      !['agent', 'tool-use'].includes(value.kind) || !isIdentifier(value.id)) return null;
  return { kind: value.kind, id: value.id };
}

function normalizePeriodBinding(value) {
  if (!hasExactKeys(value, ['periodId', 'actor']) || !isIdentifier(value.periodId)) return null;
  const actor = normalizeActor(value.actor);
  return actor ? { periodId: value.periodId, actor } : null;
}

function normalizeIdentity(value) {
  if (!hasExactKeys(value, IDENTITY_FIELDS) ||
      !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, value.provider) ||
      value.nativeIdKind !== PROVIDER_NATIVE_ID_KINDS[value.provider] ||
      !isIdentifier(value.hostId) || !isIdentifier(value.homeScopeId) ||
      !isIdentifier(value.nativeId)) return null;
  return {
    provider: value.provider,
    nativeIdKind: value.nativeIdKind,
    hostId: value.hostId,
    homeScopeId: value.homeScopeId,
    nativeId: value.nativeId,
  };
}

function normalizeClaims(value) {
  if (!hasExactKeys(value, CLAIM_FIELDS) ||
      !isIdentifier(value.launchId) || !isIdentifier(value.runId) || !isIdentifier(value.attemptId) ||
      !Object.hasOwn(PROVIDER_NATIVE_ID_KINDS, value.provider) ||
      value.nativeIdKind !== PROVIDER_NATIVE_ID_KINDS[value.provider] ||
      !isIdentifier(value.hostId) || !isIdentifier(value.homeScopeId)) return null;

  const validOriginPurpose =
    (value.origin === 'standalone' && ['agent', 'pr-creator'].includes(value.purpose)) ||
    (value.origin === 'delegated' && value.purpose === 'agent') ||
    (value.origin === 'review' && value.purpose === 'cross-review');
  if (!validOriginPurpose) return null;

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

function identitiesEqual(left, right) {
  return Boolean(left && right) && IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function tupleKey(claims) {
  return JSON.stringify([claims.launchId, claims.runId, claims.attemptId]);
}

function normalizeLaunchProjection(value) {
  const allowedFields = [
    'launchRef', 'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId',
    'homeScopeId', 'origin', 'purpose', 'originBinding', 'state', 'registrationEvidence',
    'identity', 'executionBinding', 'conversationId', 'sessionId', 'bindingEvidence',
    'currentOwner', 'ownerGeneration', 'currentProof',
  ];
  if (!isRecord(value) || Reflect.ownKeys(value).some((key) => !allowedFields.includes(key)) ||
      !['bound', 'ended'].includes(value.state) || !isIdentifier(value.launchRef) ||
      !isIdentifier(value.conversationId) || !isIdentifier(value.sessionId)) return null;

  const claimsInput = {};
  for (const field of CLAIM_FIELDS) claimsInput[field] = value[field];
  const claims = normalizeClaims(claimsInput);
  const identity = normalizeIdentity(value.identity);
  const executionBinding = normalizePeriodBinding(value.executionBinding);
  if (!claims || !identity || !executionBinding ||
      identity.provider !== claims.provider || identity.nativeIdKind !== claims.nativeIdKind ||
      identity.hostId !== claims.hostId || identity.homeScopeId !== claims.homeScopeId) return null;

  return {
    launchRef: value.launchRef,
    claims,
    identity,
    executionBinding,
    conversationId: value.conversationId,
    sessionId: value.sessionId,
  };
}

function normalizeSource(value) {
  if (!hasExactKeys(value, SOURCE_FIELDS) ||
      !isIdentifier(value.launchRef) || !isIdentifier(value.conversationId) ||
      !isIdentifier(value.sessionId)) return null;
  const claims = normalizeClaims(value.claims);
  const identity = normalizeIdentity(value.identity);
  const executionBinding = normalizePeriodBinding(value.executionBinding);
  if (!claims || !identity || !executionBinding ||
      identity.provider !== claims.provider || identity.nativeIdKind !== claims.nativeIdKind ||
      identity.hostId !== claims.hostId || identity.homeScopeId !== claims.homeScopeId) return null;
  return {
    launchRef: value.launchRef,
    claims,
    identity,
    executionBinding,
    conversationId: value.conversationId,
    sessionId: value.sessionId,
  };
}

function sourceProjectionFromRecord(value, requireOwner = false) {
  const projected = normalizeLaunchProjection(value);
  if (!projected) return null;
  let currentOwner = null;
  let ownerGeneration = null;
  if (requireOwner) {
    currentOwner = normalizePeriodBinding(value.currentOwner);
    ownerGeneration = value.ownerGeneration;
    if (!currentOwner || !nonNegativeInteger(ownerGeneration)) return null;
  }
  return { ...projected, currentOwner, ownerGeneration };
}

function normalizeTarget(value) {
  if (!hasExactKeys(value, TARGET_FIELDS) ||
      !['execution', 'owner'].includes(value.kind) ||
      !isIdentifier(value.periodId) || !isIdentifier(value.conversationId) ||
      !isIdentifier(value.sessionId)) return null;
  const identity = normalizeIdentity(value.identity);
  const actor = normalizeActor(value.actor);
  if (!identity || !actor) return null;

  if (value.kind === 'execution') {
    if (!isIdentifier(value.launchRef)) return null;
    const claims = normalizeClaims(value.claims);
    if (!claims || identity.provider !== claims.provider ||
        identity.nativeIdKind !== claims.nativeIdKind ||
        identity.hostId !== claims.hostId || identity.homeScopeId !== claims.homeScopeId) return null;
    return {
      kind: 'execution',
      launchRef: value.launchRef,
      claims,
      identity,
      periodId: value.periodId,
      actor,
      conversationId: value.conversationId,
      sessionId: value.sessionId,
    };
  }

  if (value.launchRef !== null || value.claims !== null) return null;
  return {
    kind: 'owner',
    launchRef: null,
    claims: null,
    identity,
    periodId: value.periodId,
    actor,
    conversationId: value.conversationId,
    sessionId: value.sessionId,
  };
}

function executionTarget(launch, binding = launch.executionBinding) {
  return {
    kind: 'execution',
    launchRef: launch.launchRef,
    claims: launch.claims,
    identity: launch.identity,
    periodId: binding.periodId,
    actor: binding.actor,
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
  };
}

function normalizeTargetPeriod(value) {
  if (!hasExactKeys(value, ['executionId', 'conversationId', 'sessionId', 'identity']) ||
      !isIdentifier(value.executionId) || !isIdentifier(value.conversationId) ||
      !isIdentifier(value.sessionId)) return null;
  const identity = normalizeIdentity(value.identity);
  if (!identity) return null;
  return {
    executionId: value.executionId,
    conversationId: value.conversationId,
    sessionId: value.sessionId,
    identity,
  };
}

function digestPayload(payload) {
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > MAX_PAYLOAD_BYTES) {
    throw ledgerError('invalid_delivery');
  }
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

function normalizeCorrelation(value, expectedState) {
  if (!hasExactKeys(value, CORRELATION_FIELDS) ||
      !isIdentifier(value.deliveryAttemptId) || !nonNegativeInteger(value.revision) ||
      typeof value.payloadDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.payloadDigest) ||
      !isIdentifier(value.targetPeriodId) || !isIdentifier(value.clientRequestId)) return null;

  const nativeTurnId = value.nativeTurnId === null || isIdentifier(value.nativeTurnId)
    ? value.nativeTurnId
    : undefined;
  const nativeItemId = value.nativeItemId === null || isIdentifier(value.nativeItemId)
    ? value.nativeItemId
    : undefined;
  if (nativeTurnId === undefined || nativeItemId === undefined) return null;
  if (expectedState === 'applied' && (nativeTurnId === null || nativeItemId === null)) return null;
  if (nativeItemId !== null && nativeTurnId === null) return null;

  return {
    deliveryAttemptId: value.deliveryAttemptId,
    revision: value.revision,
    payloadDigest: value.payloadDigest,
    targetPeriodId: value.targetPeriodId,
    nativeTurnId,
    nativeItemId,
    clientRequestId: value.clientRequestId,
  };
}

function correlationMatchesDelivery(correlation, delivery) {
  return correlation.deliveryAttemptId === delivery.deliveryAttemptId &&
    correlation.revision === delivery.revision &&
    correlation.payloadDigest === delivery.payloadDigest &&
    correlation.targetPeriodId === delivery.target.periodId &&
    correlation.clientRequestId === delivery.deliveryAttemptId;
}

function fixedCorrelationFieldsEqual(left, right) {
  return left.deliveryAttemptId === right.deliveryAttemptId &&
    left.revision === right.revision &&
    left.payloadDigest === right.payloadDigest &&
    left.targetPeriodId === right.targetPeriodId &&
    left.clientRequestId === right.clientRequestId;
}

function mergeAcceptedCorrelation(previous, incoming) {
  if (!previous) return incoming;
  if (!fixedCorrelationFieldsEqual(previous, incoming)) return null;
  if (previous.nativeTurnId && incoming.nativeTurnId &&
      previous.nativeTurnId !== incoming.nativeTurnId) return null;
  if (previous.nativeItemId && incoming.nativeItemId &&
      previous.nativeItemId !== incoming.nativeItemId) return null;
  return {
    ...previous,
    nativeTurnId: previous.nativeTurnId || incoming.nativeTurnId,
    nativeItemId: previous.nativeItemId || incoming.nativeItemId,
  };
}

function correlationCompatibleWithApplied(candidate, applied) {
  return fixedCorrelationFieldsEqual(candidate, applied) &&
    (!candidate.nativeTurnId || candidate.nativeTurnId === applied.nativeTurnId) &&
    (!candidate.nativeItemId || candidate.nativeItemId === applied.nativeItemId);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function logicalKeyFor(delivery) {
  return JSON.stringify([
    delivery.kind,
    delivery.kind === 'pr-notification' ? null : delivery.sourceExecutionId,
    delivery.logicalMessageId,
    delivery.revision,
    delivery.kind === 'pr-notification' ? tupleKey(delivery.target.claims) : null,
  ]);
}

function logicalKeyFromTombstone(tombstone) {
  return JSON.stringify([
    tombstone.kind,
    tombstone.sourceExecutionId,
    tombstone.logicalMessageId,
    tombstone.revision,
    tombstone.targetLaunchKey ? JSON.stringify(tombstone.targetLaunchKey) : null,
  ]);
}

function normalizeTombstone(value) {
  if (!hasExactKeys(value, TOMBSTONE_FIELDS) ||
      !DELIVERY_KINDS.has(value.kind) ||
      (value.sourceExecutionId !== null && !isIdentifier(value.sourceExecutionId)) ||
      !isIdentifier(value.logicalMessageId) || !nonNegativeInteger(value.revision) ||
      typeof value.payloadDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.payloadDigest)) return null;

  let targetLaunchKey = null;
  if (value.targetLaunchKey !== null) {
    if (!Array.isArray(value.targetLaunchKey) || value.targetLaunchKey.length !== 3 ||
        !value.targetLaunchKey.every(isIdentifier)) return null;
    targetLaunchKey = [...value.targetLaunchKey];
  }
  let sourceLaunchKey = null;
  if (value.sourceLaunchKey !== null) {
    if (!Array.isArray(value.sourceLaunchKey) || value.sourceLaunchKey.length !== 3 ||
        !value.sourceLaunchKey.every(isIdentifier)) return null;
    sourceLaunchKey = [...value.sourceLaunchKey];
  }
  if (value.kind === 'pr-notification') {
    if (value.sourceExecutionId !== null || !targetLaunchKey || sourceLaunchKey !== null) return null;
  } else if (!isIdentifier(value.sourceExecutionId) || targetLaunchKey !== null || !sourceLaunchKey) {
    return null;
  }
  return {
    kind: value.kind,
    sourceExecutionId: value.sourceExecutionId,
    logicalMessageId: value.logicalMessageId,
    revision: value.revision,
    targetLaunchKey,
    sourceLaunchKey,
    payloadDigest: value.payloadDigest,
  };
}

function normalizeDelivery(value) {
  if (!hasExactKeys(value, DELIVERY_FIELDS) ||
      !isIdentifier(value.deliveryAttemptId) || !DELIVERY_KINDS.has(value.kind) ||
      !isIdentifier(value.logicalMessageId) || !nonNegativeInteger(value.revision) ||
      !isIdentifier(value.sourceExecutionId) || !/^[a-f0-9]{64}$/.test(value.payloadDigest) ||
      !DELIVERY_STATES.has(value.state) || typeof value.cancelRequested !== 'boolean' ||
      !(value.ownerGeneration === null || nonNegativeInteger(value.ownerGeneration))) return null;

  const source = normalizeSource(value.source);
  const target = normalizeTarget(value.target);
  if (!source || !target || source.executionBinding.periodId !== value.sourceExecutionId) return null;
  if (value.kind === 'result') {
    if (target.kind !== 'owner' || value.ownerGeneration === null) return null;
  } else if (target.kind !== 'execution' || value.ownerGeneration !== null) return null;
  if (value.kind === 'question' &&
      (!identitiesEqual(source.identity, target.identity) ||
       source.launchRef !== target.launchRef ||
       !sameJson(source.claims, target.claims) ||
       source.conversationId !== target.conversationId ||
       source.sessionId !== target.sessionId ||
       target.periodId !== source.executionBinding.periodId ||
       target.actor.kind !== source.executionBinding.actor.kind ||
       target.actor.id !== source.executionBinding.actor.id)) return null;

  const acceptedCorrelation = value.acceptedCorrelation === null
    ? null
    : normalizeCorrelation(value.acceptedCorrelation, 'accepted');
  const appliedCorrelation = value.appliedCorrelation === null
    ? null
    : normalizeCorrelation(value.appliedCorrelation, 'applied');
  if ((value.acceptedCorrelation !== null && !acceptedCorrelation) ||
      (value.appliedCorrelation !== null && !appliedCorrelation)) return null;
  if (acceptedCorrelation && !correlationMatchesDelivery(acceptedCorrelation, value)) return null;
  if (appliedCorrelation && !correlationMatchesDelivery(appliedCorrelation, value)) return null;
  if (acceptedCorrelation && appliedCorrelation &&
      !correlationCompatibleWithApplied(acceptedCorrelation, appliedCorrelation)) return null;

  if (['available', 'claimed', 'sending', 'cancelled_before_send', 'superseded_before_send']
      .includes(value.state) && (acceptedCorrelation || appliedCorrelation)) return null;
  if (value.state === 'accepted' && !acceptedCorrelation) return null;
  if ((value.state === 'applied') !== Boolean(appliedCorrelation)) return null;
  if (value.state === 'cancelled_before_send' && value.cancelRequested) return null;
  if (['available', 'claimed', 'cancelled_before_send', 'superseded_before_send']
      .includes(value.state) && value.cancelRequested) return null;

  return {
    deliveryAttemptId: value.deliveryAttemptId,
    kind: value.kind,
    logicalMessageId: value.logicalMessageId,
    revision: value.revision,
    sourceExecutionId: value.sourceExecutionId,
    source,
    target,
    ownerGeneration: value.ownerGeneration,
    payloadDigest: value.payloadDigest,
    state: value.state,
    cancelRequested: value.cancelRequested,
    acceptedCorrelation,
    appliedCorrelation,
  };
}

function normalizeNotificationTarget(value) {
  if (!hasExactKeys(value, ['targetId', 'launch']) || !isIdentifier(value.targetId)) return null;
  const launch = normalizeSource(value.launch);
  return launch ? { targetId: value.targetId, launch } : null;
}

function correlationItemKey(delivery, correlation) {
  if (!correlation || correlation.nativeItemId === null) return null;
  return JSON.stringify([
    delivery.target.identity.provider,
    delivery.target.identity.nativeIdKind,
    delivery.target.identity.hostId,
    delivery.target.identity.homeScopeId,
    delivery.target.identity.nativeId,
    delivery.target.periodId,
    correlation.nativeTurnId,
    correlation.nativeItemId,
  ]);
}

function validateCorrelations(deliveries) {
  const claims = new Map();
  for (const delivery of deliveries) {
    for (const correlation of [delivery.acceptedCorrelation, delivery.appliedCorrelation]) {
      const key = correlationItemKey(delivery, correlation);
      if (!key) continue;
      const prior = claims.get(key);
      if (prior && prior.deliveryAttemptId !== delivery.deliveryAttemptId) {
        throw ledgerError('correlation_reused');
      }
      if (prior && !fixedCorrelationFieldsEqual(prior.correlation, correlation)) {
        throw ledgerError('correlation_reused');
      }
      claims.set(key, { deliveryAttemptId: delivery.deliveryAttemptId, correlation });
    }
  }
}

function deepFreeze(value) {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function cloneFrozen(value) {
  return deepFreeze(structuredClone(value));
}

function validateLedger(input) {
  if (!hasExactKeys(input, LEDGER_FIELDS) || input.schemaVersion !== 1 ||
      !nonNegativeInteger(input.revision) ||
      !isDenseArray(input.deliveries) || !isDenseArray(input.notificationTargets) ||
      !isDenseArray(input.logicalTombstones) ||
      input.deliveries.length > MAX_DELIVERIES ||
      input.notificationTargets.length > MAX_NOTIFICATION_TARGETS ||
      input.logicalTombstones.length > MAX_LOGICAL_TOMBSTONES) {
    throw ledgerError(input && isRecord(input) &&
      (input.deliveries?.length > MAX_DELIVERIES ||
       input.notificationTargets?.length > MAX_NOTIFICATION_TARGETS ||
       input.logicalTombstones?.length > MAX_LOGICAL_TOMBSTONES)
      ? 'capacity'
      : 'invalid_ledger');
  }

  const deliveries = input.deliveries.map(normalizeDelivery);
  const notificationTargets = input.notificationTargets.map(normalizeNotificationTarget);
  const logicalTombstones = input.logicalTombstones.map(normalizeTombstone);
  if (deliveries.some((item) => !item) ||
      notificationTargets.some((item) => !item) ||
      logicalTombstones.some((item) => !item)) throw ledgerError('invalid_ledger');

  const deliveryIds = new Set();
  const groups = new Map();
  for (const delivery of deliveries) {
    if (deliveryIds.has(delivery.deliveryAttemptId)) throw ledgerError('invalid_ledger');
    deliveryIds.add(delivery.deliveryAttemptId);
    const key = logicalKeyFor(delivery);
    const group = groups.get(key) || [];
    group.push(delivery);
    groups.set(key, group);
  }

  const aliases = new Set();
  const canonicalTargets = new Map();
  for (const target of notificationTargets) {
    if (aliases.has(target.targetId)) throw ledgerError('invalid_ledger');
    aliases.add(target.targetId);
    const key = tupleKey(target.launch.claims);
    const previous = canonicalTargets.get(key);
    if (previous && !sameJson(previous, target.launch)) throw ledgerError('invalid_ledger');
    canonicalTargets.set(key, target.launch);
  }

  const tombstonesByKey = new Map();
  for (const tombstone of logicalTombstones) {
    const key = logicalKeyFromTombstone(tombstone);
    if (tombstonesByKey.has(key)) throw ledgerError('invalid_ledger');
    tombstonesByKey.set(key, tombstone);
  }
  if (tombstonesByKey.size !== groups.size) throw ledgerError('invalid_ledger');

  for (const [key, records] of groups) {
    const tombstone = tombstonesByKey.get(key);
    if (!tombstone || records.some((item) => item.payloadDigest !== tombstone.payloadDigest)) {
      throw ledgerError('invalid_ledger');
    }
    if (records.length > 1 && records.slice(0, -1).some((item) =>
        item.state !== 'superseded_before_send')) throw ledgerError('invalid_ledger');
    for (const record of records) {
      if (record.kind !== 'pr-notification' &&
          !sameJson(tombstone.sourceLaunchKey, [
            record.source.claims.launchId, record.source.claims.runId, record.source.claims.attemptId,
          ])) throw ledgerError('invalid_ledger');
      if (record.kind === 'pr-notification') {
        const targetKey = tupleKey(record.target.claims);
        const registeredTarget = canonicalTargets.get(targetKey);
        if (!sameJson(tombstone.targetLaunchKey, [
              record.target.claims.launchId, record.target.claims.runId, record.target.claims.attemptId,
            ]) || !registeredTarget || !sameJson(registeredTarget, {
              launchRef: record.target.launchRef,
              claims: record.target.claims,
              identity: record.target.identity,
              executionBinding: { periodId: record.target.periodId, actor: record.target.actor },
              conversationId: record.target.conversationId,
              sessionId: record.target.sessionId,
            })) throw ledgerError('invalid_ledger');
      }
    }
  }
  validateCorrelations(deliveries);

  return cloneFrozen({
    schemaVersion: 1,
    revision: input.revision,
    deliveries,
    notificationTargets,
    logicalTombstones,
  });
}

function createEmptyLedger() {
  return cloneFrozen({
    schemaVersion: 1,
    revision: 0,
    deliveries: [],
    notificationTargets: [],
    logicalTombstones: [],
  });
}

function snapshotLedger(ledger) {
  return validateLedger(ledger);
}

function getDelivery(ledger, deliveryAttemptId) {
  const normalized = validateLedger(ledger);
  if (!isIdentifier(deliveryAttemptId)) return null;
  return normalized.deliveries.find((item) => item.deliveryAttemptId === deliveryAttemptId) || null;
}

function candidateResult(candidate, delivery, changed, created = undefined) {
  const result = {
    ledger: validateLedger(candidate),
    delivery: delivery ? cloneFrozen(delivery) : undefined,
    changed,
  };
  if (created !== undefined) result.created = created;
  return Object.freeze(result);
}

function normalizeCreateInput(kind, value) {
  const fields = kind === 'pr-notification'
    ? ['deliveryAttemptId', 'logicalMessageId', 'revision', 'payload', 'targetId']
    : ['deliveryAttemptId', 'logicalMessageId', 'revision', 'payload'];
  if (!DELIVERY_KINDS.has(kind) || !hasExactKeys(value, fields) ||
      !isIdentifier(value.deliveryAttemptId) || !isIdentifier(value.logicalMessageId) ||
      !nonNegativeInteger(value.revision) ||
      (kind === 'pr-notification' && !isIdentifier(value.targetId))) {
    throw ledgerError('invalid_delivery');
  }
  return {
    deliveryAttemptId: value.deliveryAttemptId,
    logicalMessageId: value.logicalMessageId,
    revision: value.revision,
    payloadDigest: digestPayload(value.payload),
    targetId: kind === 'pr-notification' ? value.targetId : null,
  };
}

function createSourceProjection(record) {
  const projected = sourceProjectionFromRecord(record, false);
  if (!projected) throw ledgerError('invalid_delivery');
  return {
    launchRef: projected.launchRef,
    claims: projected.claims,
    identity: projected.identity,
    executionBinding: projected.executionBinding,
    conversationId: projected.conversationId,
    sessionId: projected.sessionId,
  };
}

function logicalKeyForDraft(kind, sourceExecutionId, logicalMessageId, revision, target) {
  return JSON.stringify([
    kind,
    kind === 'pr-notification' ? null : sourceExecutionId,
    logicalMessageId,
    revision,
    kind === 'pr-notification' ? tupleKey(target.claims) : null,
  ]);
}

function tombstoneForDraft(kind, source, sourceExecutionId, logicalMessageId, revision, target, payloadDigest) {
  const isPr = kind === 'pr-notification';
  return {
    kind,
    sourceExecutionId: isPr ? null : sourceExecutionId,
    logicalMessageId,
    revision,
    targetLaunchKey: isPr
      ? [target.claims.launchId, target.claims.runId, target.claims.attemptId]
      : null,
    sourceLaunchKey: isPr
      ? null
      : [source.claims.launchId, source.claims.runId, source.claims.attemptId],
    payloadDigest,
  };
}

function deliveryDraftFingerprint(delivery) {
  return JSON.stringify({
    deliveryAttemptId: delivery.deliveryAttemptId,
    kind: delivery.kind,
    logicalMessageId: delivery.logicalMessageId,
    revision: delivery.revision,
    sourceExecutionId: delivery.sourceExecutionId,
    source: delivery.source,
    target: delivery.target,
    ownerGeneration: delivery.ownerGeneration,
    payloadDigest: delivery.payloadDigest,
  });
}

function sameCreateBase(existing, kind, input, source, sourceExecutionId) {
  return existing.kind === kind &&
    existing.logicalMessageId === input.logicalMessageId &&
    existing.revision === input.revision &&
    existing.payloadDigest === input.payloadDigest &&
    existing.sourceExecutionId === sourceExecutionId &&
    sameJson(existing.source, source);
}

function createDelivery(ledger, kind, input, executionRecord, targetRecord = undefined) {
  const current = validateLedger(ledger);
  const normalizedInput = normalizeCreateInput(kind, input);
  const source = createSourceProjection(executionRecord);
  const sourceExecutionId = source.executionBinding.periodId;
  let sourceWithOwner = null;
  let target = null;

  if (kind === 'question') {
    if (targetRecord !== undefined) throw ledgerError('invalid_delivery');
    target = executionTarget(source);
  } else if (kind === 'result') {
    sourceWithOwner = sourceProjectionFromRecord(executionRecord, true);
    if (!sourceWithOwner) throw ledgerError('invalid_delivery');
    if (targetRecord !== undefined) {
      const targetPeriod = normalizeTargetPeriod(targetRecord);
      if (!targetPeriod || targetPeriod.executionId !== sourceWithOwner.currentOwner.periodId) {
        throw ledgerError('target_unavailable');
      }
      target = {
        kind: 'owner',
        launchRef: null,
        claims: null,
        identity: targetPeriod.identity,
        periodId: targetPeriod.executionId,
        actor: sourceWithOwner.currentOwner.actor,
        conversationId: targetPeriod.conversationId,
        sessionId: targetPeriod.sessionId,
      };
    }
  } else {
    if (targetRecord !== undefined) {
      throw ledgerError('invalid_delivery');
    }
    const alias = current.notificationTargets.find((item) => item.targetId === normalizedInput.targetId);
    if (!alias) throw ledgerError('target_unavailable');
    target = executionTarget(alias.launch);
  }

  const existingId = current.deliveries.find((item) =>
    item.deliveryAttemptId === normalizedInput.deliveryAttemptId);
  if (existingId) {
    if (!sameCreateBase(existingId, kind, normalizedInput, source, sourceExecutionId)) {
      throw ledgerError('delivery_conflict');
    }
    if (target && !sameJson(existingId.target, target)) {
      if (kind !== 'result') throw ledgerError('delivery_conflict');
    }
    return candidateResult(current, existingId, false, false);
  }

  if (!target || kind === 'result' && targetRecord === undefined) {
    throw ledgerError('target_unavailable');
  }
  const ownerGeneration = kind === 'result' ? sourceWithOwner.ownerGeneration : null;
  const draft = {
    deliveryAttemptId: normalizedInput.deliveryAttemptId,
    kind,
    logicalMessageId: normalizedInput.logicalMessageId,
    revision: normalizedInput.revision,
    sourceExecutionId,
    source,
    target,
    ownerGeneration,
    payloadDigest: normalizedInput.payloadDigest,
    state: 'available',
    cancelRequested: false,
    acceptedCorrelation: null,
    appliedCorrelation: null,
  };

  const logicalKey = logicalKeyForDraft(kind, sourceExecutionId,
    normalizedInput.logicalMessageId, normalizedInput.revision, target);
  const tombstone = tombstoneForDraft(kind, source, sourceExecutionId,
    normalizedInput.logicalMessageId, normalizedInput.revision, target, normalizedInput.payloadDigest);
  const priorTombstone = current.logicalTombstones.find((item) =>
    logicalKeyFromTombstone(item) === logicalKey);
  if (priorTombstone) {
    if (priorTombstone.payloadDigest !== tombstone.payloadDigest ||
        !sameJson(priorTombstone.sourceLaunchKey, tombstone.sourceLaunchKey)) {
      throw ledgerError('logical_conflict');
    }
    const priorRecords = current.deliveries.filter((item) => logicalKeyFor(item) === logicalKey);
    if (!priorRecords.length || priorRecords.some((item) => item.state !== 'superseded_before_send')) {
      throw ledgerError('logical_conflict');
    }
  }

  if (current.deliveries.length >= MAX_DELIVERIES ||
      (!priorTombstone && current.logicalTombstones.length >= MAX_LOGICAL_TOMBSTONES)) {
    throw ledgerError('capacity');
  }

  const candidate = structuredClone(current);
  candidate.deliveries.push(draft);
  if (!priorTombstone) candidate.logicalTombstones.push(tombstone);
  candidate.revision += 1;
  return candidateResult(candidate, draft, true, true);
}

function registerPrTarget(ledger, targetId, executionRecord) {
  const current = validateLedger(ledger);
  if (!isIdentifier(targetId)) throw ledgerError('invalid_delivery');
  const projected = createSourceProjection(executionRecord);
  const target = { targetId, launch: projected };
  const existing = current.notificationTargets.find((item) => item.targetId === targetId);
  if (existing) {
    if (!sameJson(existing, target)) throw ledgerError('pr_target_conflict');
    return Object.freeze({ ledger: current, target: cloneFrozen(existing), created: false });
  }
  if (current.notificationTargets.length >= MAX_NOTIFICATION_TARGETS) {
    throw ledgerError('capacity');
  }
  const candidate = structuredClone(current);
  candidate.notificationTargets.push(target);
  candidate.revision += 1;
  return Object.freeze({
    ledger: validateLedger(candidate),
    target: cloneFrozen(target),
    created: true,
  });
}

function transitionDelivery(ledger, deliveryAttemptId, operation, correlationInput = undefined) {
  const current = validateLedger(ledger);
  if (!isIdentifier(deliveryAttemptId)) throw ledgerError('invalid_delivery');
  const existing = current.deliveries.find((item) => item.deliveryAttemptId === deliveryAttemptId);
  if (!existing) throw ledgerError('delivery_not_found');
  const needsCorrelation = operation === 'accepted' || operation === 'applied';
  if (!['claim', 'sendStart', 'cancel', 'supersede', 'accepted', 'applied', 'unknown']
      .includes(operation) || (needsCorrelation ? correlationInput === undefined : correlationInput !== undefined)) {
    throw ledgerError('invalid_transition');
  }

  const updated = structuredClone(existing);
  let changed = false;
  if (operation === 'claim') {
    if (updated.state === 'available') {
      updated.state = 'claimed';
      changed = true;
    } else if (!['available', 'claimed'].includes(updated.state)) throw ledgerError('invalid_transition');
  } else if (operation === 'sendStart') {
    if (!['available', 'claimed'].includes(updated.state)) throw ledgerError('invalid_transition');
    updated.state = 'sending';
    changed = true;
  } else if (operation === 'cancel') {
    if (['available', 'claimed'].includes(updated.state)) {
      updated.state = 'cancelled_before_send';
      changed = true;
    } else if (['sending', 'accepted', 'unknown', 'applied'].includes(updated.state)) {
      if (!updated.cancelRequested) {
        updated.cancelRequested = true;
        changed = true;
      }
    } else if (updated.state !== 'cancelled_before_send') {
      throw ledgerError('invalid_transition');
    }
  } else if (operation === 'supersede') {
    if (!['available', 'claimed'].includes(updated.state)) throw ledgerError('invalid_transition');
    updated.state = 'superseded_before_send';
    changed = true;
  } else if (operation === 'unknown') {
    if (['sending', 'accepted'].includes(updated.state)) {
      updated.state = 'unknown';
      changed = true;
    } else if (updated.state !== 'unknown' && updated.state !== 'applied') {
      throw ledgerError('invalid_transition');
    }
  } else if (operation === 'accepted') {
    if (!['sending', 'unknown', 'accepted', 'applied'].includes(updated.state)) {
      throw ledgerError('invalid_transition');
    }
    const incoming = normalizeCorrelation(correlationInput, 'accepted');
    if (!incoming || !correlationMatchesDelivery(incoming, updated)) {
      throw ledgerError('correlation_mismatch');
    }
    if (updated.appliedCorrelation &&
        !correlationCompatibleWithApplied(incoming, updated.appliedCorrelation)) {
      throw ledgerError('correlation_mismatch');
    }
    const merged = mergeAcceptedCorrelation(updated.acceptedCorrelation, incoming);
    if (!merged) throw ledgerError('correlation_mismatch');
    if (!updated.acceptedCorrelation || !sameJson(updated.acceptedCorrelation, merged)) {
      updated.acceptedCorrelation = merged;
      changed = true;
    }
    if (updated.state === 'sending' || updated.state === 'unknown') {
      updated.state = 'accepted';
      changed = true;
    }
  } else if (operation === 'applied') {
    if (!['sending', 'accepted', 'unknown', 'applied'].includes(updated.state)) {
      throw ledgerError('invalid_transition');
    }
    const incoming = normalizeCorrelation(correlationInput, 'applied');
    if (!incoming || !correlationMatchesDelivery(incoming, updated)) {
      throw ledgerError('correlation_mismatch');
    }
    if (updated.acceptedCorrelation &&
        !correlationCompatibleWithApplied(updated.acceptedCorrelation, incoming)) {
      throw ledgerError('correlation_mismatch');
    }
    if (updated.appliedCorrelation) {
      if (!sameJson(updated.appliedCorrelation, incoming)) throw ledgerError('correlation_mismatch');
    } else {
      updated.appliedCorrelation = incoming;
      updated.state = 'applied';
      changed = true;
    }
  }

  if (!changed) return candidateResult(current, existing, false);
  const candidate = structuredClone(current);
  const index = candidate.deliveries.findIndex((item) => item.deliveryAttemptId === deliveryAttemptId);
  candidate.deliveries[index] = updated;
  candidate.revision += 1;
  return candidateResult(candidate, updated, true);
}

function recoverLedger(ledger) {
  const current = validateLedger(ledger);
  const candidate = structuredClone(current);
  let changed = false;
  for (const delivery of candidate.deliveries) {
    if (delivery.state === 'claimed') {
      delivery.state = 'available';
      changed = true;
    } else if (delivery.state === 'sending' || delivery.state === 'accepted') {
      delivery.state = 'unknown';
      changed = true;
    }
  }
  if (changed) candidate.revision += 1;
  return validateLedger(candidate);
}

const DELIVERY_LEDGER_LIMITS = Object.freeze({
  maxDeliveries: MAX_DELIVERIES,
  maxNotificationTargets: MAX_NOTIFICATION_TARGETS,
  maxLogicalTombstones: MAX_LOGICAL_TOMBSTONES,
  maxPayloadBytes: MAX_PAYLOAD_BYTES,
});

module.exports = {
  DELIVERY_LEDGER_LIMITS,
  createEmptyLedger,
  validateLedger,
  createDelivery,
  registerPrTarget,
  transitionDelivery,
  getDelivery,
  snapshotLedger,
  recoverLedger,
};
