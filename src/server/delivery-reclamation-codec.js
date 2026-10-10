'use strict';

const { createHash } = require('node:crypto');
const {
  assertIdentifier,
  assertSafeUnsignedInteger,
  assertSha256,
  assertUuidV4,
  captureDenseArray,
  captureExactRecord,
} = require('./reclamation-codec-primitives');
const { encodeNormalized } = require('./reclamation-json-codec');
const { assertPlainDataTree: assertLogicalTombstoneData } = require('./reclamation-plain-data');

const MAX_DELIVERIES = 20_000;
const MAX_NOTIFICATION_TARGETS = 10_000;
const MAX_LOGICAL_TOMBSTONES = 20_000;
const MAX_CHECKPOINT_RECORDS = 50_000;
const MAX_INSTRUCTIONS = 20_000;
const MAX_ELIGIBLE_ATTEMPT_IDS = 20_000;
const MAX_SOURCE_BYTES = 16_777_216;
const MAX_INSTRUCTION_TEXT_BYTES = 64 * 1024;
const MAX_INSTRUCTION_ENVELOPE_BYTES = 70 * 1024;
const TERMINAL_RETENTION_MS = 604_800_000;

const CLAIM_FIELDS = [
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding',
];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const PERIOD_BINDING_FIELDS = ['periodId', 'actor'];
const ACTOR_FIELDS = ['kind', 'id'];
const SOURCE_FIELDS = ['launchRef', 'claims', 'identity', 'executionBinding', 'conversationId', 'sessionId'];
const TARGET_FIELDS = ['kind', 'launchRef', 'claims', 'identity', 'periodId', 'actor', 'conversationId', 'sessionId'];
const SOURCE_REF_FIELDS = [
  'launchRef', 'launchKey', 'sourceClaimsDigest', 'identity', 'executionBinding', 'conversationId', 'sessionId',
];
const TARGET_REF_FIELDS = [
  'kind', 'launchRef', 'launchKey', 'targetClaimsDigest', 'identity', 'periodId', 'actor', 'conversationId', 'sessionId',
];
const CORRELATION_FIELDS = [
  'deliveryAttemptId', 'revision', 'payloadDigest', 'targetPeriodId',
  'nativeTurnId', 'nativeItemId', 'clientRequestId',
];
const TOMBSTONE_FIELDS = [
  'kind', 'sourceExecutionId', 'logicalMessageId', 'revision',
  'targetLaunchKey', 'sourceLaunchKey', 'payloadDigest',
];
const DELIVERY_DETAIL_FIELDS = [
  'recordType', 'deliveryAttemptId', 'kind', 'logicalMessageId', 'revision', 'sourceExecutionId',
  'source', 'target', 'ownerGeneration', 'payloadDigest', 'state', 'cancelRequested',
  'acceptedCorrelation', 'appliedCorrelation', 'terminalAt',
];
const DELIVERY_GRAVE_FIELDS = [
  'recordType', 'deliveryAttemptId', 'kind', 'logicalMessageId', 'revision', 'sourceExecutionId',
  'payloadDigest', 'state', 'terminalAt', 'cancelRequested', 'ownerGeneration',
  'acceptedCorrelation', 'appliedCorrelation', 'sourceRef', 'targetRef', 'reclamation',
];
const SOURCE_LAUNCH_FIELDS = ['launchRef', 'claims', 'identity', 'executionBinding', 'conversationId', 'sessionId'];
const LEDGER_FIELDS = ['schemaVersion', 'revision', 'deliveries', 'notificationTargets', 'logicalTombstones'];
const CHECKPOINT_FIELDS = ['schemaVersion', 'storeId', 'revision', 'registrations', 'ledger', 'migrationAllowance'];
const REGISTRATION_FIELDS = [
  'conversations', 'executions', 'launches', 'runtimeLaunches', 'connections', 'actors', 'handoffs',
  'replayClaims', 'incompleteConversationIds',
];
const INSTRUCTION_DETAIL_FIELDS = [
  'recordType', 'deliveryAttemptId', 'launchRef', 'logicalMessageId', 'revision', 'source', 'envelope',
  'envelopeDigest', 'nativeContentDigest', 'createdAt', 'deliveryCreationState', 'reclamation',
];
const INSTRUCTION_RECLAIMED_FIELDS = [
  'recordType', 'deliveryAttemptId', 'launchRef', 'logicalMessageId', 'revision', 'source',
  'envelopeDigest', 'nativeContentDigest', 'createdAt', 'deliveryCreationState', 'reclamation', 'reclaimedAt',
];
const INSTRUCTION_SOURCE_FIELDS = [
  'launchRef', 'claims', 'identity', 'executionBinding', 'conversationId', 'sessionId',
];
const INSTRUCTION_ENVELOPE_FIELDS = ['schemaVersion', 'mode', 'expectedTurnId', 'input'];
const INSTRUCTION_INPUT_ITEM_FIELDS = ['type', 'text', 'text_elements'];
const PREPARATION_FIELDS = ['operationId', 'preparedAt', 'terminalState', 'terminalAt'];
const RECLAMATION_FIELDS = ['operationId', 'reclaimedAt', 'reason'];
const GRANT_FIELDS = [
  'operationId', 'sourceSchemaVersion', 'sourceSizeBytes', 'sourceSha256', 'maxExtraBytes', 'eligibleAttemptIds',
];
const DELIVERY_STATES = [
  'available', 'claimed', 'sending', 'accepted', 'applied', 'unknown',
  'cancelled_before_send', 'superseded_before_send',
];
const TERMINAL_DELIVERY_STATES = ['applied', 'cancelled_before_send', 'superseded_before_send'];
const DELIVERY_KINDS = ['question', 'result', 'pr-notification', 'instruction'];
const DELIVERY_CREATION_STATES = ['not_created', 'creating', 'checkpointed', 'indeterminate'];
const INVALID_LEDGER = 'invalid_delivery_ledger_v2';
const INVALID_DELIVERY = 'invalid_delivery_record_v2';
const INVALID_CHECKPOINT = 'invalid_delivery_checkpoint_v3';
const INVALID_INSTRUCTION_JOURNAL = 'invalid_instruction_journal_v2';
const INVALID_INSTRUCTION = 'invalid_instruction_record_v2';

function reject(code) {
  throw new TypeError(code);
}

function requireValue(condition, code) {
  if (!condition) reject(code);
}

function captureRecord(value, fields, code) {
  return captureExactRecord(value, fields, code);
}

function captureArray(value, maxLength, code) {
  return captureDenseArray(value, maxLength, code);
}

function makeRecord(entries) {
  const record = Object.create(null);
  for (const [key, value] of entries) {
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return record;
}

function safeJsonValue(value) {
  if (Array.isArray(value)) {
    const result = new Array(value.length);
    Object.defineProperty(result, 'toJSON', {
      value: null,
      enumerable: false,
      writable: false,
      configurable: false,
    });
    for (let index = 0; index < value.length; index += 1) result[index] = safeJsonValue(value[index]);
    return result;
  }
  if (value !== null && typeof value === 'object') {
    const result = Object.create(null);
    for (const key of Object.keys(value)) {
      Object.defineProperty(result, key, {
        value: safeJsonValue(value[key]),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }
  return value;
}

function compactJson(value) {
  return JSON.stringify(safeJsonValue(value));
}

function sha256Text(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function digestJson(value) {
  return sha256Text(compactJson(value));
}

function sameJson(left, right) {
  return compactJson(left) === compactJson(right);
}

function identifierTuple(value, code, expectedLength = 3) {
  const values = captureArray(value, expectedLength, code);
  requireValue(values.length === expectedLength, code);
  values.forEach((item) => assertIdentifier(item, code));
  return values.slice();
}

function providerNativeIdKind(provider, code) {
  requireValue(typeof provider === 'string', code);
  if (provider === 'claude') return 'session';
  if (provider === 'codex') return 'thread';
  reject(code);
}

function normalizeIdentity(value, code) {
  const identity = captureRecord(value, IDENTITY_FIELDS, code);
  requireValue(identity.nativeIdKind === providerNativeIdKind(identity.provider, code), code);
  assertIdentifier(identity.hostId, code);
  assertIdentifier(identity.homeScopeId, code);
  assertIdentifier(identity.nativeId, code);
  return makeRecord(IDENTITY_FIELDS.map((field) => [field, identity[field]]));
}

function normalizeActor(value, code) {
  const actor = captureRecord(value, ACTOR_FIELDS, code);
  requireValue(actor.kind === 'agent' || actor.kind === 'tool-use', code);
  assertIdentifier(actor.id, code);
  return makeRecord(ACTOR_FIELDS.map((field) => [field, actor[field]]));
}

function normalizePeriodBinding(value, code) {
  const binding = captureRecord(value, PERIOD_BINDING_FIELDS, code);
  assertIdentifier(binding.periodId, code);
  return makeRecord([
    ['periodId', binding.periodId],
    ['actor', normalizeActor(binding.actor, code)],
  ]);
}

function normalizeClaims(value, code) {
  const claims = captureRecord(value, CLAIM_FIELDS, code);
  assertIdentifier(claims.launchId, code);
  assertIdentifier(claims.runId, code);
  assertIdentifier(claims.attemptId, code);
  requireValue(claims.nativeIdKind === providerNativeIdKind(claims.provider, code), code);
  assertIdentifier(claims.hostId, code);
  assertIdentifier(claims.homeScopeId, code);
  const validOriginPurpose =
    (claims.origin === 'standalone' && (claims.purpose === 'agent' || claims.purpose === 'pr-creator')) ||
    (claims.origin === 'delegated' && claims.purpose === 'agent') ||
    (claims.origin === 'review' && claims.purpose === 'cross-review');
  requireValue(validOriginPurpose, code);
  const originBinding = claims.origin === 'standalone'
    ? (requireValue(claims.originBinding === null, code), null)
    : normalizePeriodBinding(claims.originBinding, code);
  return makeRecord([
    ['launchId', claims.launchId],
    ['runId', claims.runId],
    ['attemptId', claims.attemptId],
    ['provider', claims.provider],
    ['nativeIdKind', claims.nativeIdKind],
    ['hostId', claims.hostId],
    ['homeScopeId', claims.homeScopeId],
    ['origin', claims.origin],
    ['purpose', claims.purpose],
    ['originBinding', originBinding],
  ]);
}

function normalizeSource(value, code) {
  const source = captureRecord(value, SOURCE_FIELDS, code);
  assertIdentifier(source.launchRef, code);
  const claims = normalizeClaims(source.claims, code);
  const identity = normalizeIdentity(source.identity, code);
  const executionBinding = normalizePeriodBinding(source.executionBinding, code);
  assertIdentifier(source.conversationId, code);
  assertIdentifier(source.sessionId, code);
  requireValue(identity.provider === claims.provider && identity.nativeIdKind === claims.nativeIdKind &&
    identity.hostId === claims.hostId && identity.homeScopeId === claims.homeScopeId, code);
  return makeRecord([
    ['launchRef', source.launchRef],
    ['claims', claims],
    ['identity', identity],
    ['executionBinding', executionBinding],
    ['conversationId', source.conversationId],
    ['sessionId', source.sessionId],
  ]);
}

function normalizeTarget(value, code) {
  const target = captureRecord(value, TARGET_FIELDS, code);
  requireValue(target.kind === 'execution' || target.kind === 'owner', code);
  const identity = normalizeIdentity(target.identity, code);
  assertIdentifier(target.periodId, code);
  const actor = normalizeActor(target.actor, code);
  assertIdentifier(target.conversationId, code);
  assertIdentifier(target.sessionId, code);
  if (target.kind === 'execution') {
    assertIdentifier(target.launchRef, code);
    const claims = normalizeClaims(target.claims, code);
    requireValue(identity.provider === claims.provider && identity.nativeIdKind === claims.nativeIdKind &&
      identity.hostId === claims.hostId && identity.homeScopeId === claims.homeScopeId, code);
    return makeRecord([
      ['kind', 'execution'], ['launchRef', target.launchRef], ['claims', claims], ['identity', identity],
      ['periodId', target.periodId], ['actor', actor], ['conversationId', target.conversationId],
      ['sessionId', target.sessionId],
    ]);
  }
  requireValue(target.launchRef === null && target.claims === null, code);
  return makeRecord([
    ['kind', 'owner'], ['launchRef', null], ['claims', null], ['identity', identity],
    ['periodId', target.periodId], ['actor', actor], ['conversationId', target.conversationId],
    ['sessionId', target.sessionId],
  ]);
}

function normalizeSourceRef(value, code) {
  const ref = captureRecord(value, SOURCE_REF_FIELDS, code);
  assertIdentifier(ref.launchRef, code);
  const launchKey = identifierTuple(ref.launchKey, code);
  assertSha256(ref.sourceClaimsDigest, code);
  const identity = normalizeIdentity(ref.identity, code);
  const executionBinding = normalizePeriodBinding(ref.executionBinding, code);
  assertIdentifier(ref.conversationId, code);
  assertIdentifier(ref.sessionId, code);
  return makeRecord([
    ['launchRef', ref.launchRef], ['launchKey', launchKey], ['sourceClaimsDigest', ref.sourceClaimsDigest],
    ['identity', identity], ['executionBinding', executionBinding], ['conversationId', ref.conversationId],
    ['sessionId', ref.sessionId],
  ]);
}

function normalizeTargetRef(value, code) {
  const ref = captureRecord(value, TARGET_REF_FIELDS, code);
  requireValue(ref.kind === 'execution' || ref.kind === 'owner', code);
  const identity = normalizeIdentity(ref.identity, code);
  assertIdentifier(ref.periodId, code);
  const actor = normalizeActor(ref.actor, code);
  assertIdentifier(ref.conversationId, code);
  assertIdentifier(ref.sessionId, code);
  if (ref.kind === 'owner') {
    requireValue(ref.launchRef === null && ref.launchKey === null && ref.targetClaimsDigest === null, code);
    return makeRecord([
      ['kind', 'owner'], ['launchRef', null], ['launchKey', null], ['targetClaimsDigest', null],
      ['identity', identity], ['periodId', ref.periodId], ['actor', actor],
      ['conversationId', ref.conversationId], ['sessionId', ref.sessionId],
    ]);
  }
  assertIdentifier(ref.launchRef, code);
  const launchKey = identifierTuple(ref.launchKey, code);
  assertSha256(ref.targetClaimsDigest, code);
  return makeRecord([
    ['kind', 'execution'], ['launchRef', ref.launchRef], ['launchKey', launchKey],
    ['targetClaimsDigest', ref.targetClaimsDigest], ['identity', identity], ['periodId', ref.periodId],
    ['actor', actor], ['conversationId', ref.conversationId], ['sessionId', ref.sessionId],
  ]);
}

function normalizeCorrelation(value, expectedState, code) {
  if (value === null) return null;
  const correlation = captureRecord(value, CORRELATION_FIELDS, code);
  assertIdentifier(correlation.deliveryAttemptId, code);
  assertSafeUnsignedInteger(correlation.revision, code);
  assertSha256(correlation.payloadDigest, code);
  assertIdentifier(correlation.targetPeriodId, code);
  requireValue(correlation.nativeTurnId === null || typeof correlation.nativeTurnId === 'string', code);
  if (correlation.nativeTurnId !== null) assertIdentifier(correlation.nativeTurnId, code);
  requireValue(correlation.nativeItemId === null || typeof correlation.nativeItemId === 'string', code);
  if (correlation.nativeItemId !== null) assertIdentifier(correlation.nativeItemId, code);
  assertIdentifier(correlation.clientRequestId, code);
  requireValue(expectedState !== 'applied' ||
    (correlation.nativeTurnId !== null && correlation.nativeItemId !== null), code);
  requireValue(correlation.nativeItemId === null || correlation.nativeTurnId !== null, code);
  return makeRecord(CORRELATION_FIELDS.map((field) => [field, correlation[field]]));
}

function launchKeyFromClaims(claims) {
  return [claims.launchId, claims.runId, claims.attemptId];
}

function sourceLaunchKey(source) {
  return launchKeyFromClaims(source.claims);
}

function targetLaunchKey(target) {
  return target.kind === 'execution' ? launchKeyFromClaims(target.claims) : null;
}

function launchTupleKey(claimsOrKey) {
  const tuple = Array.isArray(claimsOrKey) ? claimsOrKey : launchKeyFromClaims(claimsOrKey);
  return compactJson(tuple);
}

function sourceProjection(source) {
  return makeRecord(SOURCE_LAUNCH_FIELDS.map((field) => [field, source[field]]));
}

function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function sameBinding(left, right) {
  return left.periodId === right.periodId && left.actor.kind === right.actor.kind && left.actor.id === right.actor.id;
}

function sameClaims(left, right) {
  return sameJson(left, right);
}

function sameSourceProjection(left, right) {
  return sameJson(sourceProjection(left), sourceProjection(right));
}

function normalizeDeliveryReclamation(value, delivery, code) {
  const reclamation = captureRecord(value, RECLAMATION_FIELDS, code);
  assertUuidV4(reclamation.operationId, code);
  assertSafeUnsignedInteger(reclamation.reclaimedAt, code);
  requireValue(reclamation.reason === 'terminal_retention' || reclamation.reason === 'retired_question_period', code);
  if (reclamation.reason === 'terminal_retention') {
    requireValue(delivery.kind !== 'question' && TERMINAL_DELIVERY_STATES.includes(delivery.state), code);
  } else {
    requireValue(delivery.kind === 'question' &&
      (delivery.state === 'available' || delivery.state === 'unknown' || TERMINAL_DELIVERY_STATES.includes(delivery.state)),
    code);
  }
  if (TERMINAL_DELIVERY_STATES.includes(delivery.state)) {
    const minimumReclaimedAt = checkedAddSafeInteger(delivery.terminalAt, TERMINAL_RETENTION_MS, code);
    requireValue(reclamation.reclaimedAt >= minimumReclaimedAt, code);
  }
  return makeRecord(RECLAMATION_FIELDS.map((field) => [field, reclamation[field]]));
}

function checkedAddSafeInteger(left, right, code) {
  assertSafeUnsignedInteger(left, code);
  assertSafeUnsignedInteger(right, code);
  requireValue(left <= Number.MAX_SAFE_INTEGER - right, code);
  return left + right;
}

function validateTerminalAt(state, terminalAt, code) {
  if (TERMINAL_DELIVERY_STATES.includes(state)) assertSafeUnsignedInteger(terminalAt, code);
  else requireValue(terminalAt === null, code);
}

function normalizeDeliveryCorrelations(record, target, code) {
  const acceptedCorrelation = normalizeCorrelation(record.acceptedCorrelation, 'accepted', code);
  const appliedCorrelation = normalizeCorrelation(record.appliedCorrelation, 'applied', code);
  const correlations = [acceptedCorrelation, appliedCorrelation];
  for (const correlation of correlations) {
    if (correlation === null) continue;
    requireValue(correlation.deliveryAttemptId === record.deliveryAttemptId &&
      correlation.revision === record.revision && correlation.payloadDigest === record.payloadDigest &&
      correlation.targetPeriodId === target.periodId && correlation.clientRequestId === record.deliveryAttemptId, code);
  }
  if (acceptedCorrelation !== null && appliedCorrelation !== null) {
    requireValue(acceptedCorrelation.deliveryAttemptId === appliedCorrelation.deliveryAttemptId &&
      acceptedCorrelation.revision === appliedCorrelation.revision &&
      acceptedCorrelation.payloadDigest === appliedCorrelation.payloadDigest &&
      acceptedCorrelation.targetPeriodId === appliedCorrelation.targetPeriodId &&
      acceptedCorrelation.clientRequestId === appliedCorrelation.clientRequestId &&
      (acceptedCorrelation.nativeTurnId === null ||
        acceptedCorrelation.nativeTurnId === appliedCorrelation.nativeTurnId) &&
      (acceptedCorrelation.nativeItemId === null ||
        acceptedCorrelation.nativeItemId === appliedCorrelation.nativeItemId), code);
  }
  requireValue(!(['available', 'claimed', 'sending', 'cancelled_before_send', 'superseded_before_send']
    .includes(record.state)) || (acceptedCorrelation === null && appliedCorrelation === null), code);
  requireValue(record.state !== 'accepted' || acceptedCorrelation !== null, code);
  requireValue((record.state === 'applied') === (appliedCorrelation !== null), code);
  requireValue(record.state !== 'cancelled_before_send' || !record.cancelRequested, code);
  requireValue(!(['available', 'claimed', 'cancelled_before_send', 'superseded_before_send']
    .includes(record.state)) || !record.cancelRequested, code);
  return { acceptedCorrelation, appliedCorrelation };
}

function normalizeDeliveryCommon(record, source, target, code) {
  assertIdentifier(record.deliveryAttemptId, code);
  requireValue(DELIVERY_KINDS.includes(record.kind), code);
  assertIdentifier(record.logicalMessageId, code);
  assertSafeUnsignedInteger(record.revision, code);
  assertIdentifier(record.sourceExecutionId, code);
  assertSha256(record.payloadDigest, code);
  requireValue(DELIVERY_STATES.includes(record.state), code);
  requireValue(typeof record.cancelRequested === 'boolean', code);
  requireValue(record.ownerGeneration === null || Number.isSafeInteger(record.ownerGeneration) &&
    record.ownerGeneration >= 0, code);
  requireValue(source.executionBinding.periodId === record.sourceExecutionId, code);
  if (record.kind === 'result') {
    requireValue(target.kind === 'owner' && record.ownerGeneration !== null, code);
  } else {
    requireValue(target.kind === 'execution' && record.ownerGeneration === null, code);
  }
  if (record.kind === 'question' || record.kind === 'instruction') {
    const targetBinding = makeRecord([['periodId', target.periodId], ['actor', target.actor]]);
    requireValue(sameIdentity(source.identity, target.identity) && source.launchRef === target.launchRef &&
      sameClaims(source.claims, target.claims) && target.periodId === source.executionBinding.periodId &&
      sameBinding(targetBinding, source.executionBinding) && source.conversationId === target.conversationId &&
      source.sessionId === target.sessionId, code);
  }
}

function normalizeDeliveryDetail(value) {
  const detail = captureRecord(value, DELIVERY_DETAIL_FIELDS, INVALID_DELIVERY);
  requireValue(detail.recordType === 'detail', INVALID_DELIVERY);
  const source = normalizeSource(detail.source, INVALID_DELIVERY);
  const target = normalizeTarget(detail.target, INVALID_DELIVERY);
  const base = {
    deliveryAttemptId: detail.deliveryAttemptId,
    kind: detail.kind,
    logicalMessageId: detail.logicalMessageId,
    revision: detail.revision,
    sourceExecutionId: detail.sourceExecutionId,
    ownerGeneration: detail.ownerGeneration,
    payloadDigest: detail.payloadDigest,
    state: detail.state,
    cancelRequested: detail.cancelRequested,
    terminalAt: detail.terminalAt,
  };
  normalizeDeliveryCommon(base, source, target, INVALID_DELIVERY);
  validateTerminalAt(base.state, base.terminalAt, INVALID_DELIVERY);
  const { acceptedCorrelation, appliedCorrelation } = normalizeDeliveryCorrelations(detail, target, INVALID_DELIVERY);
  return makeRecord([
    ['recordType', 'detail'], ['deliveryAttemptId', detail.deliveryAttemptId], ['kind', detail.kind],
    ['logicalMessageId', detail.logicalMessageId], ['revision', detail.revision],
    ['sourceExecutionId', detail.sourceExecutionId], ['source', source], ['target', target],
    ['ownerGeneration', detail.ownerGeneration], ['payloadDigest', detail.payloadDigest], ['state', detail.state],
    ['cancelRequested', detail.cancelRequested], ['acceptedCorrelation', acceptedCorrelation],
    ['appliedCorrelation', appliedCorrelation], ['terminalAt', detail.terminalAt],
  ]);
}

function normalizeDeliveryGrave(value) {
  const grave = captureRecord(value, DELIVERY_GRAVE_FIELDS, INVALID_DELIVERY);
  requireValue(grave.recordType === 'reclaimed', INVALID_DELIVERY);
  const source = normalizeSourceRef(grave.sourceRef, INVALID_DELIVERY);
  const target = normalizeTargetRef(grave.targetRef, INVALID_DELIVERY);
  const base = {
    deliveryAttemptId: grave.deliveryAttemptId,
    kind: grave.kind,
    logicalMessageId: grave.logicalMessageId,
    revision: grave.revision,
    sourceExecutionId: grave.sourceExecutionId,
    ownerGeneration: grave.ownerGeneration,
    payloadDigest: grave.payloadDigest,
    state: grave.state,
    cancelRequested: grave.cancelRequested,
    terminalAt: grave.terminalAt,
  };
  assertIdentifier(base.deliveryAttemptId, INVALID_DELIVERY);
  requireValue(DELIVERY_KINDS.includes(base.kind), INVALID_DELIVERY);
  assertIdentifier(base.logicalMessageId, INVALID_DELIVERY);
  assertSafeUnsignedInteger(base.revision, INVALID_DELIVERY);
  assertIdentifier(base.sourceExecutionId, INVALID_DELIVERY);
  assertSha256(base.payloadDigest, INVALID_DELIVERY);
  requireValue(DELIVERY_STATES.includes(base.state), INVALID_DELIVERY);
  requireValue(typeof base.cancelRequested === 'boolean', INVALID_DELIVERY);
  requireValue(base.ownerGeneration === null || Number.isSafeInteger(base.ownerGeneration) && base.ownerGeneration >= 0,
    INVALID_DELIVERY);
  validateTerminalAt(base.state, base.terminalAt, INVALID_DELIVERY);
  requireValue(source.executionBinding.periodId === base.sourceExecutionId, INVALID_DELIVERY);
  if (base.kind === 'result') {
    requireValue(target.kind === 'owner' && base.ownerGeneration !== null, INVALID_DELIVERY);
  } else {
    requireValue(target.kind === 'execution' && base.ownerGeneration === null, INVALID_DELIVERY);
  }
  if (base.kind === 'question' || base.kind === 'instruction') {
    const targetBinding = makeRecord([['periodId', target.periodId], ['actor', target.actor]]);
    requireValue(sameIdentity(source.identity, target.identity) && source.launchRef === target.launchRef &&
      sameJson(source.launchKey, target.launchKey) && source.sourceClaimsDigest === target.targetClaimsDigest &&
      target.periodId === source.executionBinding.periodId && sameBinding(targetBinding, source.executionBinding),
    INVALID_DELIVERY);
    requireValue(source.conversationId === target.conversationId && source.sessionId === target.sessionId,
      INVALID_DELIVERY);
  }
  const { acceptedCorrelation, appliedCorrelation } = normalizeDeliveryCorrelations(grave, target, INVALID_DELIVERY);
  const reclamation = normalizeDeliveryReclamation(grave.reclamation, base, INVALID_DELIVERY);
  return makeRecord([
    ['recordType', 'reclaimed'], ['deliveryAttemptId', grave.deliveryAttemptId], ['kind', grave.kind],
    ['logicalMessageId', grave.logicalMessageId], ['revision', grave.revision],
    ['sourceExecutionId', grave.sourceExecutionId], ['payloadDigest', grave.payloadDigest],
    ['state', grave.state], ['terminalAt', grave.terminalAt], ['cancelRequested', grave.cancelRequested],
    ['ownerGeneration', grave.ownerGeneration], ['acceptedCorrelation', acceptedCorrelation],
    ['appliedCorrelation', appliedCorrelation], ['sourceRef', source], ['targetRef', target],
    ['reclamation', reclamation],
  ]);
}

function readRecordType(value, allowed, code) {
  let prototype;
  let descriptor;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) reject(code);
    prototype = Object.getPrototypeOf(value);
    descriptor = Object.getOwnPropertyDescriptor(value, 'recordType');
  } catch {
    reject(code);
  }
  requireValue((prototype === Object.prototype || prototype === null) && descriptor !== undefined &&
    descriptor.enumerable && Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'string' &&
    allowed.includes(descriptor.value), code);
  return descriptor.value;
}

function normalizeDeliveryRecordV2Internal(value) {
  const recordType = readRecordType(value, ['detail', 'reclaimed'], INVALID_DELIVERY);
  return recordType === 'detail' ? normalizeDeliveryDetail(value) : normalizeDeliveryGrave(value);
}

function normalizeNotificationTarget(value) {
  const target = captureRecord(value, ['targetId', 'launch'], INVALID_LEDGER);
  assertIdentifier(target.targetId, INVALID_LEDGER);
  const launch = normalizeSource(target.launch, INVALID_LEDGER);
  return makeRecord([['targetId', target.targetId], ['launch', launch]]);
}

function normalizeTombstone(value) {
  const tombstone = captureRecord(value, TOMBSTONE_FIELDS, INVALID_LEDGER);
  requireValue(DELIVERY_KINDS.includes(tombstone.kind), INVALID_LEDGER);
  requireValue(tombstone.sourceExecutionId === null || typeof tombstone.sourceExecutionId === 'string', INVALID_LEDGER);
  if (tombstone.sourceExecutionId !== null) assertIdentifier(tombstone.sourceExecutionId, INVALID_LEDGER);
  assertIdentifier(tombstone.logicalMessageId, INVALID_LEDGER);
  assertSafeUnsignedInteger(tombstone.revision, INVALID_LEDGER);
  assertSha256(tombstone.payloadDigest, INVALID_LEDGER);
  const targetLaunchKey = tombstone.targetLaunchKey === null
    ? null
    : identifierTuple(tombstone.targetLaunchKey, INVALID_LEDGER);
  const sourceLaunchKey = tombstone.sourceLaunchKey === null
    ? null
    : identifierTuple(tombstone.sourceLaunchKey, INVALID_LEDGER);
  if (tombstone.kind === 'pr-notification') {
    requireValue(tombstone.sourceExecutionId === null && targetLaunchKey !== null && sourceLaunchKey === null,
      INVALID_LEDGER);
  } else {
    requireValue(tombstone.sourceExecutionId !== null && targetLaunchKey === null && sourceLaunchKey !== null,
      INVALID_LEDGER);
  }
  return makeRecord([
    ['kind', tombstone.kind], ['sourceExecutionId', tombstone.sourceExecutionId],
    ['logicalMessageId', tombstone.logicalMessageId], ['revision', tombstone.revision],
    ['targetLaunchKey', targetLaunchKey], ['sourceLaunchKey', sourceLaunchKey],
    ['payloadDigest', tombstone.payloadDigest],
  ]);
}

/** 配信ledgerの論理墓標一件について局所schemaだけを検証する。 */
function normalizeLogicalTombstoneV2Local(value) {
  assertLogicalTombstoneData(value, INVALID_LEDGER, 3);
  return normalizeTombstone(value);
}

function deliveryTargetProjection(record) {
  if (record.recordType === 'detail') {
    const target = record.target;
    if (target.kind !== 'execution') return null;
    return makeRecord([
      ['launchRef', target.launchRef], ['claims', target.claims], ['identity', target.identity],
      ['executionBinding', makeRecord([['periodId', target.periodId], ['actor', target.actor]])],
      ['conversationId', target.conversationId], ['sessionId', target.sessionId],
    ]);
  }
  const target = record.targetRef;
  if (target.kind !== 'execution') return null;
  return makeRecord([
    ['launchRef', target.launchRef], ['launchKey', target.launchKey],
    ['targetClaimsDigest', target.targetClaimsDigest], ['identity', target.identity],
    ['executionBinding', makeRecord([['periodId', target.periodId], ['actor', target.actor]])],
    ['conversationId', target.conversationId], ['sessionId', target.sessionId],
  ]);
}

function deliveryLogicalKey(record) {
  const target = record.recordType === 'detail' ? record.target : record.targetRef;
  return compactJson([
    record.kind,
    record.kind === 'pr-notification' ? null : record.sourceExecutionId,
    record.logicalMessageId,
    record.revision,
    record.kind === 'pr-notification' ? (record.recordType === 'detail' ? targetLaunchKey(target) : target.launchKey) : null,
  ]);
}

function tombstoneLogicalKey(tombstone) {
  return compactJson([
    tombstone.kind,
    tombstone.kind === 'pr-notification' ? null : tombstone.sourceExecutionId,
    tombstone.logicalMessageId,
    tombstone.revision,
    tombstone.targetLaunchKey,
  ]);
}

function recordSourceLaunchKey(record) {
  return record.recordType === 'detail' ? sourceLaunchKey(record.source) : record.sourceRef.launchKey;
}

function recordTargetLaunchKey(record) {
  if (record.kind !== 'pr-notification') return null;
  return record.recordType === 'detail' ? targetLaunchKey(record.target) : record.targetRef.launchKey;
}

function validateLedgerCorrelationReuse(deliveries, code) {
  const claimedItems = new Map();
  for (const delivery of deliveries) {
    const target = delivery.recordType === 'detail' ? delivery.target : delivery.targetRef;
    for (const correlation of [delivery.acceptedCorrelation, delivery.appliedCorrelation]) {
      if (correlation === null || correlation.nativeItemId === null) continue;
      const key = compactJson([
        target.identity.provider, target.identity.nativeIdKind, target.identity.hostId,
        target.identity.homeScopeId, target.identity.nativeId, target.periodId,
        correlation.nativeTurnId, correlation.nativeItemId,
      ]);
      const prior = claimedItems.get(key);
      if (prior && (prior.deliveryAttemptId !== delivery.deliveryAttemptId ||
          prior.correlation.deliveryAttemptId !== correlation.deliveryAttemptId ||
          prior.correlation.revision !== correlation.revision ||
          prior.correlation.payloadDigest !== correlation.payloadDigest ||
          prior.correlation.targetPeriodId !== correlation.targetPeriodId ||
          prior.correlation.clientRequestId !== correlation.clientRequestId)) reject(code);
      claimedItems.set(key, { deliveryAttemptId: delivery.deliveryAttemptId, correlation });
    }
  }
}

function validateLedgerGroups(deliveries, notificationTargets, logicalTombstones, code) {
  const attemptIds = new Set();
  const groups = new Map();
  for (const delivery of deliveries) {
    requireValue(!attemptIds.has(delivery.deliveryAttemptId), code);
    attemptIds.add(delivery.deliveryAttemptId);
    const key = deliveryLogicalKey(delivery);
    const group = groups.get(key) || [];
    group.push(delivery);
    groups.set(key, group);
  }

  const aliases = new Set();
  const canonicalTargets = new Map();
  for (const target of notificationTargets) {
    requireValue(!aliases.has(target.targetId), code);
    aliases.add(target.targetId);
    const key = launchTupleKey(target.launch.claims);
    const previous = canonicalTargets.get(key);
    requireValue(previous === undefined || sameSourceProjection(previous, target.launch), code);
    canonicalTargets.set(key, target.launch);
  }

  const tombstonesByKey = new Map();
  for (const tombstone of logicalTombstones) {
    const key = tombstoneLogicalKey(tombstone);
    requireValue(!tombstonesByKey.has(key), code);
    tombstonesByKey.set(key, tombstone);
  }
  requireValue(tombstonesByKey.size === groups.size, code);

  for (const [key, records] of groups) {
    const tombstone = tombstonesByKey.get(key);
    requireValue(tombstone !== undefined && records.every((record) => record.payloadDigest === tombstone.payloadDigest), code);
    requireValue(records.length <= 1 || records.slice(0, -1).every((record) => record.state === 'superseded_before_send'),
      code);
    for (const record of records) {
      if (record.kind !== 'pr-notification') {
        requireValue(sameJson(tombstone.sourceLaunchKey, recordSourceLaunchKey(record)), code);
        continue;
      }
      const targetKey = recordTargetLaunchKey(record);
      requireValue(sameJson(tombstone.targetLaunchKey, targetKey), code);
      const registered = canonicalTargets.get(launchTupleKey(targetKey));
      requireValue(registered !== undefined, code);
      if (record.recordType === 'detail') {
        requireValue(sameSourceProjection(registered, deliveryTargetProjection(record)), code);
      } else {
        const target = record.targetRef;
        requireValue(registered.launchRef === target.launchRef &&
          sameJson(launchKeyFromClaims(registered.claims), target.launchKey) &&
          digestJson(registered.claims) === target.targetClaimsDigest && sameIdentity(registered.identity, target.identity) &&
          sameBinding(registered.executionBinding, makeRecord([
            ['periodId', target.periodId], ['actor', target.actor],
          ])) && registered.conversationId === target.conversationId && registered.sessionId === target.sessionId, code);
      }
    }
  }
  validateLedgerCorrelationReuse(deliveries, code);
}

function normalizeDeliveryLedgerV2LocalInternal(value) {
  const ledger = captureRecord(value, LEDGER_FIELDS, INVALID_LEDGER);
  requireValue(ledger.schemaVersion === 2, INVALID_LEDGER);
  assertSafeUnsignedInteger(ledger.revision, INVALID_LEDGER);
  const deliveries = captureArray(ledger.deliveries, MAX_DELIVERIES, INVALID_LEDGER)
    .map((item) => normalizeDeliveryRecordV2Internal(item));
  const notificationTargets = captureArray(ledger.notificationTargets, MAX_NOTIFICATION_TARGETS, INVALID_LEDGER)
    .map(normalizeNotificationTarget);
  const logicalTombstones = captureArray(ledger.logicalTombstones, MAX_LOGICAL_TOMBSTONES, INVALID_LEDGER)
    .map(normalizeTombstone);
  validateLedgerGroups(deliveries, notificationTargets, logicalTombstones, INVALID_LEDGER);
  return makeRecord([
    ['schemaVersion', 2], ['revision', ledger.revision], ['deliveries', deliveries],
    ['notificationTargets', notificationTargets], ['logicalTombstones', logicalTombstones],
  ]);
}

function normalizeLaunchClaims(value, code) {
  return normalizeClaims(value, code);
}

function normalizeImmutableClaims(value, code) {
  const fields = [...CLAIM_FIELDS, 'identity', 'executionBinding'];
  const input = captureRecord(value, fields, code);
  const claimFields = makeRecord(CLAIM_FIELDS.map((field) => [field, input[field]]));
  const claims = normalizeLaunchClaims(claimFields, code);
  const identity = normalizeIdentity(input.identity, code);
  const executionBinding = normalizePeriodBinding(input.executionBinding, code);
  requireValue(identity.provider === claims.provider && identity.nativeIdKind === claims.nativeIdKind &&
    identity.hostId === claims.hostId && identity.homeScopeId === claims.homeScopeId, code);
  return makeRecord([
    ...CLAIM_FIELDS.map((field) => [field, claims[field]]),
    ['identity', identity], ['executionBinding', executionBinding],
  ]);
}

function normalizeRegistrationConversation(value, code) {
  const item = captureRecord(value, ['conversationId', 'identity'], code);
  assertIdentifier(item.conversationId, code);
  return makeRecord([
    ['conversationId', item.conversationId], ['identity', normalizeIdentity(item.identity, code)],
  ]);
}

function normalizeRegistrationExecution(value, code) {
  const item = captureRecord(value, ['conversationId', 'executionId', 'sessionId', 'state'], code);
  assertIdentifier(item.conversationId, code);
  assertIdentifier(item.executionId, code);
  assertIdentifier(item.sessionId, code);
  requireValue(item.state === 'active' || item.state === 'ended' || item.state === 'unknown', code);
  return makeRecord([
    ['conversationId', item.conversationId], ['executionId', item.executionId],
    ['sessionId', item.sessionId], ['state', item.state],
  ]);
}

function normalizeRegistrationLaunch(value, code) {
  const fields = [
    'launchRef', 'claims', 'state', 'identity', 'executionBinding', 'conversationId', 'sessionId',
  ];
  const item = captureRecord(value, fields, code);
  assertIdentifier(item.launchRef, code);
  const claims = normalizeLaunchClaims(item.claims, code);
  requireValue(['registered', 'bound', 'ended', 'unknown'].includes(item.state), code);
  const hasIdentity = item.identity !== null;
  const hasBinding = item.executionBinding !== null;
  const hasConversation = item.conversationId !== null;
  const hasSession = item.sessionId !== null;
  requireValue(hasIdentity === hasBinding && hasIdentity === hasConversation && hasIdentity === hasSession &&
    !(item.state === 'registered' && hasIdentity) && !(item.state === 'bound' && !hasIdentity), code);
  if (!hasIdentity) {
    return makeRecord([
      ['launchRef', item.launchRef], ['claims', claims], ['state', item.state], ['identity', null],
      ['executionBinding', null], ['conversationId', null], ['sessionId', null],
    ]);
  }
  const identity = normalizeIdentity(item.identity, code);
  const executionBinding = normalizePeriodBinding(item.executionBinding, code);
  assertIdentifier(item.conversationId, code);
  assertIdentifier(item.sessionId, code);
  requireValue(identity.provider === claims.provider && identity.nativeIdKind === claims.nativeIdKind &&
    identity.hostId === claims.hostId && identity.homeScopeId === claims.homeScopeId, code);
  return makeRecord([
    ['launchRef', item.launchRef], ['claims', claims], ['state', item.state], ['identity', identity],
    ['executionBinding', executionBinding], ['conversationId', item.conversationId], ['sessionId', item.sessionId],
  ]);
}

function normalizeRegistrationRuntimeLaunch(value, code) {
  const item = captureRecord(value, [
    'launchRef', 'claims', 'state', 'conversationId', 'sessionId', 'currentOwner', 'ownerGeneration',
  ], code);
  assertIdentifier(item.launchRef, code);
  requireValue(item.conversationId === null || typeof item.conversationId === 'string', code);
  if (item.conversationId !== null) assertIdentifier(item.conversationId, code);
  requireValue(item.sessionId === null || typeof item.sessionId === 'string', code);
  if (item.sessionId !== null) assertIdentifier(item.sessionId, code);
  requireValue(Number.isSafeInteger(item.ownerGeneration) && item.ownerGeneration >= 0, code);
  const claims = normalizeImmutableClaims(item.claims, code);
  requireValue(item.state === 'bound' || item.state === 'ended' || item.state === 'unknown', code);
  requireValue(item.conversationId !== null && item.sessionId !== null, code);
  const currentOwner = normalizePeriodBinding(item.currentOwner, code);
  return makeRecord([
    ['launchRef', item.launchRef], ['claims', claims], ['state', item.state],
    ['conversationId', item.conversationId], ['sessionId', item.sessionId],
    ['currentOwner', currentOwner], ['ownerGeneration', item.ownerGeneration],
  ]);
}

function normalizeRegistrationScope(value, code) {
  const fields = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'connectionSlotId'];
  const scope = captureRecord(value, fields, code);
  requireValue(scope.nativeIdKind === providerNativeIdKind(scope.provider, code), code);
  assertIdentifier(scope.hostId, code);
  assertIdentifier(scope.homeScopeId, code);
  assertIdentifier(scope.connectionSlotId, code);
  return makeRecord(fields.map((field) => [field, scope[field]]));
}

function normalizeRegistrationConnection(value, code) {
  const item = captureRecord(value, ['scope', 'generation', 'state'], code);
  requireValue(Number.isSafeInteger(item.generation) && item.generation >= 1, code);
  requireValue(['active', 'ended', 'unknown', 'inactive'].includes(item.state), code);
  return makeRecord([
    ['scope', normalizeRegistrationScope(item.scope, code)], ['generation', item.generation], ['state', item.state],
  ]);
}

function normalizeRegistrationActor(value, code) {
  const item = captureRecord(value, [
    'identity', 'periodId', 'actor', 'contextId', 'launchRef', 'immutableExecutionClaims',
    'connectionScope', 'connectionGeneration', 'state',
  ], code);
  const identity = normalizeIdentity(item.identity, code);
  assertIdentifier(item.periodId, code);
  const actor = normalizeActor(item.actor, code);
  assertIdentifier(item.contextId, code);
  requireValue(item.launchRef === null || typeof item.launchRef === 'string', code);
  if (item.launchRef !== null) assertIdentifier(item.launchRef, code);
  requireValue(Number.isSafeInteger(item.connectionGeneration) && item.connectionGeneration >= 1, code);
  const claims = item.immutableExecutionClaims === null
    ? null
    : normalizeImmutableClaims(item.immutableExecutionClaims, code);
  requireValue((item.launchRef === null) === (claims === null), code);
  if (claims !== null) {
    requireValue(sameIdentity(claims.identity, identity) && claims.executionBinding.periodId === item.periodId &&
      sameJson(claims.executionBinding.actor, actor), code);
  }
  const connectionScope = normalizeRegistrationScope(item.connectionScope, code);
  requireValue(connectionScope.provider === identity.provider && connectionScope.nativeIdKind === identity.nativeIdKind &&
    connectionScope.hostId === identity.hostId && connectionScope.homeScopeId === identity.homeScopeId, code);
  requireValue(['active', 'ended', 'unknown'].includes(item.state), code);
  return makeRecord([
    ['identity', identity], ['periodId', item.periodId], ['actor', actor], ['contextId', item.contextId],
    ['launchRef', item.launchRef], ['immutableExecutionClaims', claims], ['connectionScope', connectionScope],
    ['connectionGeneration', item.connectionGeneration], ['state', item.state],
  ]);
}

function normalizeRegistrationHandoff(value, code) {
  const item = captureRecord(value, ['handoffId', 'owner', 'ownerGeneration', 'status'], code);
  assertIdentifier(item.handoffId, code);
  requireValue(Number.isSafeInteger(item.ownerGeneration) && item.ownerGeneration >= 1 && item.status === 'accepted', code);
  return makeRecord([
    ['handoffId', item.handoffId], ['owner', normalizePeriodBinding(item.owner, code)],
    ['ownerGeneration', item.ownerGeneration], ['status', item.status],
  ]);
}

function normalizeReplayClaim(value, code) {
  const fields = ['startIdDigest', 'evidenceIdDigest', 'fingerprintDigest', 'conversationId', 'executionId', 'order'];
  const item = captureRecord(value, fields, code);
  assertSha256(item.startIdDigest, code);
  assertSha256(item.evidenceIdDigest, code);
  assertSha256(item.fingerprintDigest, code);
  assertIdentifier(item.conversationId, code);
  assertIdentifier(item.executionId, code);
  requireValue(Number.isSafeInteger(item.order) && item.order >= 1 && item.order <= 20_000, code);
  return makeRecord(fields.map((field) => [field, item[field]]));
}

function normalizeStringIdentifiers(value, maxRecords, code) {
  return captureArray(value, maxRecords, code).map((item) => {
    assertIdentifier(item, code);
    return item;
  });
}

function identityKey(identity) {
  return compactJson(IDENTITY_FIELDS.map((field) => identity[field]));
}

function actorKey(identity, periodId, actor) {
  return compactJson([identityKey(identity), periodId, actor.kind, actor.id]);
}

function connectionSlotKey(scope) {
  return compactJson([
    scope.provider, scope.nativeIdKind, scope.hostId, scope.homeScopeId, scope.connectionSlotId,
  ]);
}

function connectionScopeGenerationKey(scope, generation) {
  return compactJson([connectionSlotKey(scope), generation]);
}

function immutableClaimsLaunchProjection(claims) {
  return makeRecord(CLAIM_FIELDS.map((field) => [field, claims[field]]));
}

function registrationLaunchProjection(launch) {
  return makeRecord([
    ['launchRef', launch.launchRef], ['claims', launch.claims], ['identity', launch.identity],
    ['executionBinding', launch.executionBinding], ['conversationId', launch.conversationId],
    ['sessionId', launch.sessionId],
  ]);
}

function validateRegistrationReferences(registrations, maxRecords, code) {
  const conversations = uniqueIndex(registrations.conversations, (item) => item.conversationId, code);
  const identities = uniqueIndex(registrations.conversations, (item) => identityKey(item.identity), code);
  const executions = uniqueIndex(registrations.executions, (item) => item.executionId, code);
  const sessions = new Set();
  for (const execution of registrations.executions) {
    const conversation = conversations.get(execution.conversationId);
    requireValue(conversation !== undefined && identities.has(identityKey(conversation.identity)), code);
    requireValue(!sessions.has(execution.sessionId), code);
    sessions.add(execution.sessionId);
  }

  const launches = uniqueIndex(registrations.launches, (item) => item.launchRef, code);
  const launchClaimTuples = new Set();
  for (const launch of registrations.launches) {
    const tuple = launchTupleKey(launch.claims);
    requireValue(!launchClaimTuples.has(tuple), code);
    launchClaimTuples.add(tuple);
    if (launch.claims.originBinding !== null) {
      requireValue(executions.has(launch.claims.originBinding.periodId), code);
    }
    if (launch.identity === null) continue;
    const period = executions.get(launch.executionBinding.periodId);
    const conversation = conversations.get(launch.conversationId);
    requireValue(period !== undefined && conversation !== undefined && period.conversationId === launch.conversationId &&
      period.sessionId === launch.sessionId && sameIdentity(conversation.identity, launch.identity), code);
  }

  const runtimeLaunches = uniqueIndex(registrations.runtimeLaunches, (item) => item.launchRef, code);
  const runtimeTuples = new Set();
  for (const runtimeLaunch of registrations.runtimeLaunches) {
    const tuple = launchTupleKey(runtimeLaunch.claims);
    requireValue(!runtimeTuples.has(tuple), code);
    runtimeTuples.add(tuple);
    const launch = launches.get(runtimeLaunch.launchRef);
    const period = executions.get(runtimeLaunch.claims.executionBinding.periodId);
    requireValue(launch !== undefined && period !== undefined && launch.state !== 'registered' && launch.identity !== null &&
      sameJson(launch.claims, immutableClaimsLaunchProjection(runtimeLaunch.claims)) &&
      sameIdentity(launch.identity, runtimeLaunch.claims.identity) &&
      sameBinding(launch.executionBinding, runtimeLaunch.claims.executionBinding) &&
      period.conversationId === runtimeLaunch.conversationId && period.sessionId === runtimeLaunch.sessionId &&
      launch.conversationId === runtimeLaunch.conversationId && launch.sessionId === runtimeLaunch.sessionId, code);
    const ownerPeriod = executions.get(runtimeLaunch.currentOwner.periodId);
    requireValue(ownerPeriod !== undefined && conversations.has(ownerPeriod.conversationId), code);
  }

  const connectionKeys = new Set();
  const connectionsByScopeGeneration = new Map();
  const generationsBySlot = new Map();
  const activeConnectionSlots = new Set();
  for (const connection of registrations.connections) {
    const slot = connectionSlotKey(connection.scope);
    const key = connectionScopeGenerationKey(connection.scope, connection.generation);
    requireValue(!connectionKeys.has(key), code);
    connectionKeys.add(key);
    connectionsByScopeGeneration.set(key, connection);
    const generations = generationsBySlot.get(slot) || new Set();
    generations.add(connection.generation);
    generationsBySlot.set(slot, generations);
    if (connection.state === 'active') {
      requireValue(!activeConnectionSlots.has(slot), code);
      activeConnectionSlots.add(slot);
    }
  }
  for (const generations of generationsBySlot.values()) {
    const ordered = [...generations].sort((left, right) => left - right);
    requireValue(ordered.length === ordered[ordered.length - 1] &&
      ordered.every((generation, index) => generation === index + 1), code);
  }

  const actorKeys = new Set();
  const actorContexts = new Map();
  const endedActors = new Set();
  const activeActors = new Set();
  for (const actor of registrations.actors) {
    const actorUniqueKey = compactJson([
      identityKey(actor.identity), actor.periodId, actor.actor.kind, actor.actor.id, actor.contextId,
      actor.launchRef, connectionSlotKey(actor.connectionScope), actor.connectionGeneration,
    ]);
    requireValue(!actorKeys.has(actorUniqueKey), code);
    actorKeys.add(actorUniqueKey);
    const contextKey = compactJson([
      connectionSlotKey(actor.connectionScope), actor.connectionGeneration, identityKey(actor.identity), actor.contextId,
    ]);
    const assignment = compactJson([
      actor.periodId, actor.actor.kind, actor.actor.id, actor.launchRef,
      actor.immutableExecutionClaims === null ? null : safeJsonValue(actor.immutableExecutionClaims),
    ]);
    const previousAssignment = actorContexts.get(contextKey);
    requireValue(previousAssignment === undefined || previousAssignment === assignment, code);
    actorContexts.set(contextKey, assignment);
    const actorGroup = actorKey(actor.identity, actor.periodId, actor.actor);
    if (actor.state === 'ended') endedActors.add(actorGroup);
    if (actor.state === 'active') activeActors.add(actorGroup);
  }
  for (const ended of endedActors) requireValue(!activeActors.has(ended), code);

  for (const actor of registrations.actors) {
    const period = executions.get(actor.periodId);
    const conversation = period === undefined ? undefined : conversations.get(period.conversationId);
    const connection = connectionsByScopeGeneration.get(
      connectionScopeGenerationKey(actor.connectionScope, actor.connectionGeneration));
    requireValue(period !== undefined && connection !== undefined && conversation !== undefined &&
      sameIdentity(conversation.identity, actor.identity) &&
      !(actor.state === 'active' && (connection.state !== 'active' || period.state !== 'active')) &&
      !(period.state === 'ended' && actor.state !== 'ended'), code);
    if (actor.launchRef !== null) {
      const runtimeLaunch = runtimeLaunches.get(actor.launchRef);
      requireValue(runtimeLaunch !== undefined && sameJson(runtimeLaunch.claims, actor.immutableExecutionClaims) &&
        sameIdentity(runtimeLaunch.claims.identity, actor.identity) &&
        runtimeLaunch.claims.executionBinding.periodId === actor.periodId &&
        sameJson(runtimeLaunch.claims.executionBinding.actor, actor.actor), code);
    }
  }

  const handoffs = uniqueIndex(registrations.handoffs, (item) => item.handoffId, code);
  for (const handoff of handoffs.values()) requireValue(executions.has(handoff.owner.periodId), code);

  const recordCount = REGISTRATION_FIELDS.reduce((total, field) => total + registrations[field].length, 0);
  requireValue(recordCount <= maxRecords, code);
}

function uniqueIndex(items, keyOf, code) {
  const index = new Map();
  for (const item of items) {
    const key = keyOf(item);
    requireValue(!index.has(key), code);
    index.set(key, item);
  }
  return index;
}

function validateReplayClaims(registrations, maxRecords, code) {
  const conversations = new Map(registrations.conversations.map((item) => [item.conversationId, item]));
  const executions = new Map(registrations.executions.map((item) => [item.executionId, item]));
  const incomplete = new Set(registrations.incompleteConversationIds);
  for (const conversationId of incomplete) requireValue(conversations.has(conversationId), code);

  const startDigests = new Set();
  const evidenceDigests = new Set();
  const executionClaims = new Set();
  const orders = new Set();
  for (const claim of registrations.replayClaims) {
    const execution = executions.get(claim.executionId);
    requireValue(!startDigests.has(claim.startIdDigest) && !evidenceDigests.has(claim.evidenceIdDigest) &&
      !executionClaims.has(claim.executionId) && !orders.has(claim.order) && execution !== undefined &&
      execution.conversationId === claim.conversationId, code);
    startDigests.add(claim.startIdDigest);
    evidenceDigests.add(claim.evidenceIdDigest);
    executionClaims.add(claim.executionId);
    orders.add(claim.order);
  }
  const orderedClaims = [...orders].sort((left, right) => left - right);
  if (incomplete.size === 0) {
    requireValue(orderedClaims.every((order, index) => order === index + 1), code);
  }
  const conversationsWithExecutions = new Set();
  for (const execution of registrations.executions) {
    conversationsWithExecutions.add(execution.conversationId);
    if (!executionClaims.has(execution.executionId) && !incomplete.has(execution.conversationId)) reject(code);
  }
  for (const conversation of registrations.conversations) {
    if (!conversationsWithExecutions.has(conversation.conversationId) && !incomplete.has(conversation.conversationId)) {
      reject(code);
    }
  }
  const totalRecords = REGISTRATION_FIELDS.reduce((total, field) => total + registrations[field].length, 0);
  requireValue(totalRecords <= maxRecords, code);
}

function normalizeCheckpointRegistrations(value, maxRecords, code) {
  const raw = captureRecord(value, REGISTRATION_FIELDS, code);
  const registrations = makeRecord([
    ['conversations', captureArray(raw.conversations, maxRecords, code)
      .map((item) => normalizeRegistrationConversation(item, code))],
    ['executions', captureArray(raw.executions, maxRecords, code)
      .map((item) => normalizeRegistrationExecution(item, code))],
    ['launches', captureArray(raw.launches, maxRecords, code)
      .map((item) => normalizeRegistrationLaunch(item, code))],
    ['runtimeLaunches', captureArray(raw.runtimeLaunches, maxRecords, code)
      .map((item) => normalizeRegistrationRuntimeLaunch(item, code))],
    ['connections', captureArray(raw.connections, maxRecords, code)
      .map((item) => normalizeRegistrationConnection(item, code))],
    ['actors', captureArray(raw.actors, maxRecords, code)
      .map((item) => normalizeRegistrationActor(item, code))],
    ['handoffs', captureArray(raw.handoffs, maxRecords, code)
      .map((item) => normalizeRegistrationHandoff(item, code))],
    ['replayClaims', captureArray(raw.replayClaims, maxRecords, code)
      .map((item) => normalizeReplayClaim(item, code))],
    ['incompleteConversationIds', normalizeStringIdentifiers(raw.incompleteConversationIds, maxRecords, code)],
  ]);
  requireValue(new Set(registrations.incompleteConversationIds).size === registrations.incompleteConversationIds.length,
    code);
  validateRegistrationReferences(registrations, maxRecords, code);
  validateReplayClaims(registrations, maxRecords, code);
  return registrations;
}

function normalizeMigrationAllowance(value, sourceSchemaVersion, code) {
  if (value === null) return null;
  const grant = captureRecord(value, GRANT_FIELDS, code);
  assertUuidV4(grant.operationId, code);
  requireValue(grant.sourceSchemaVersion === sourceSchemaVersion, code);
  assertSafeUnsignedInteger(grant.sourceSizeBytes, code);
  requireValue(grant.sourceSizeBytes <= MAX_SOURCE_BYTES, code);
  assertSha256(grant.sourceSha256, code);
  requireValue(Number.isSafeInteger(grant.maxExtraBytes) && grant.maxExtraBytes > 0, code);
  const eligibleAttemptIds = normalizeStringIdentifiers(grant.eligibleAttemptIds, MAX_ELIGIBLE_ATTEMPT_IDS, code);
  requireValue(new Set(eligibleAttemptIds).size === eligibleAttemptIds.length, code);
  return makeRecord([
    ['operationId', grant.operationId], ['sourceSchemaVersion', grant.sourceSchemaVersion],
    ['sourceSizeBytes', grant.sourceSizeBytes], ['sourceSha256', grant.sourceSha256],
    ['maxExtraBytes', grant.maxExtraBytes], ['eligibleAttemptIds', eligibleAttemptIds],
  ]);
}

function digestClaims(claims) {
  return digestJson(claims);
}

function launchProjectionMatchesDetail(launch, projection) {
  return launch !== undefined && launch.identity !== null && launch.state !== 'registered' &&
    sameSourceProjection(registrationLaunchProjection(launch), projection);
}

function launchProjectionMatchesRef(launch, ref, digestField) {
  const digest = digestField === 'sourceClaimsDigest' ? ref.sourceClaimsDigest : ref.targetClaimsDigest;
  return launch !== undefined && launch.identity !== null && launch.state !== 'registered' &&
    launch.launchRef === ref.launchRef && sameJson(launchKeyFromClaims(launch.claims), ref.launchKey) &&
    digestClaims(launch.claims) === digest && sameIdentity(launch.identity, ref.identity) &&
    sameBinding(launch.executionBinding, ref.executionBinding || makeRecord([
      ['periodId', ref.periodId], ['actor', ref.actor],
    ])) && launch.conversationId === ref.conversationId && launch.sessionId === ref.sessionId;
}

function targetProjectionFromDetail(target) {
  if (target.kind !== 'execution') return null;
  return makeRecord([
    ['launchRef', target.launchRef], ['claims', target.claims], ['identity', target.identity],
    ['executionBinding', makeRecord([['periodId', target.periodId], ['actor', target.actor]])],
    ['conversationId', target.conversationId], ['sessionId', target.sessionId],
  ]);
}

function sourceProjectionFromRecord(record) {
  return record.recordType === 'detail' ? record.source : record.sourceRef;
}

function targetRefFromRecord(record) {
  if (record.recordType === 'reclaimed') return record.targetRef;
  return record.target;
}

function validateCheckpointDeliveryReferences(ledger, registrations, code) {
  const launches = new Map(registrations.launches.map((item) => [item.launchRef, item]));
  const runtimeLaunches = new Map(registrations.runtimeLaunches.map((item) => [item.launchRef, item]));
  const executions = new Map(registrations.executions.map((item) => [item.executionId, item]));
  const conversations = new Map(registrations.conversations.map((item) => [item.conversationId, item]));
  const registeredAliasTuples = new Set();
  const actorKeys = new Set(registrations.actors.map((actor) => actorKey(actor.identity, actor.periodId, actor.actor)));
  const actorExists = (identity, binding) => actorKeys.has(actorKey(identity, binding.periodId, binding.actor));
  const requireBoundProjection = (projection, codeForFailure) => {
    const launch = launches.get(projection.launchRef);
    if (!launchProjectionMatchesDetail(launch, projection)) reject(codeForFailure);
    return launch;
  };

  for (const target of ledger.notificationTargets) {
    const launch = requireBoundProjection(target.launch, code);
    registeredAliasTuples.add(launchTupleKey(launch.claims));
  }

  for (const delivery of ledger.deliveries) {
    const source = sourceProjectionFromRecord(delivery);
    const target = targetRefFromRecord(delivery);
    const sourceLaunch = delivery.recordType === 'detail'
      ? requireBoundProjection(source, code)
      : launches.get(source.launchRef);
    if (delivery.recordType === 'reclaimed') {
      requireValue(launchProjectionMatchesRef(sourceLaunch, source, 'sourceClaimsDigest'), code);
    }
    const sourcePeriod = executions.get(delivery.sourceExecutionId);
    const sourceConversation = conversations.get(source.conversationId);
    requireValue(delivery.sourceExecutionId === source.executionBinding.periodId && sourcePeriod !== undefined &&
      sourceConversation !== undefined && sourcePeriod.conversationId === source.conversationId &&
      sourcePeriod.sessionId === source.sessionId && sameIdentity(sourceConversation.identity, source.identity), code);
    const runtimeSource = runtimeLaunches.get(sourceLaunch.launchRef);
    if (runtimeSource !== undefined) {
      requireValue(sameJson(runtimeSource.claims, makeRecord([
        ...CLAIM_FIELDS.map((field) => [field, sourceLaunch.claims[field]]),
        ['identity', sourceLaunch.identity], ['executionBinding', sourceLaunch.executionBinding],
      ])), code);
    }
    if (delivery.kind === 'question' || delivery.kind === 'instruction') {
      requireValue(runtimeSource !== undefined, code);
    }

    if (delivery.kind === 'result') {
      const targetPeriod = executions.get(target.periodId);
      const targetConversation = conversations.get(target.conversationId);
      requireValue(runtimeSource !== undefined && target.kind === 'owner' &&
        delivery.ownerGeneration <= runtimeSource.ownerGeneration && targetPeriod !== undefined &&
        targetConversation !== undefined && targetPeriod.conversationId === target.conversationId &&
        targetPeriod.sessionId === target.sessionId && sameIdentity(targetConversation.identity, target.identity) &&
        actorExists(target.identity, makeRecord([['periodId', target.periodId], ['actor', target.actor]])) &&
        sourceLaunch.identity !== null, code);
      if (delivery.ownerGeneration === runtimeSource.ownerGeneration) {
        requireValue(target.periodId === runtimeSource.currentOwner.periodId &&
          sameJson(target.actor, runtimeSource.currentOwner.actor), code);
      }
      continue;
    }

    requireValue(target.kind === 'execution', code);
    let targetLaunch;
    if (delivery.recordType === 'detail') {
      targetLaunch = requireBoundProjection(targetProjectionFromDetail(target), code);
    } else {
      targetLaunch = launches.get(target.launchRef);
      requireValue(launchProjectionMatchesRef(targetLaunch, target, 'targetClaimsDigest'), code);
    }
    const targetPeriod = executions.get(target.periodId);
    const targetConversation = conversations.get(target.conversationId);
    requireValue(targetPeriod !== undefined && targetConversation !== undefined &&
      targetPeriod.conversationId === target.conversationId && targetPeriod.sessionId === target.sessionId &&
      sameIdentity(targetConversation.identity, target.identity), code);

    if (delivery.kind === 'question' || delivery.kind === 'instruction') {
      requireValue(targetLaunch.launchRef === sourceLaunch.launchRef &&
        sameJson(targetLaunch.claims, sourceLaunch.claims) &&
        target.periodId === source.executionBinding.periodId &&
        sameJson(target.actor, source.executionBinding.actor), code);
    }
    if (delivery.kind === 'pr-notification') {
      requireValue(registeredAliasTuples.has(launchTupleKey(targetLaunch.claims)), code);
    }
  }
}

function normalizeCheckpointV3LocalInternal(value, maxRecords = MAX_CHECKPOINT_RECORDS) {
  requireValue(Number.isSafeInteger(maxRecords) && maxRecords >= 1 && maxRecords <= MAX_CHECKPOINT_RECORDS,
    INVALID_CHECKPOINT);
  const checkpoint = captureRecord(value, CHECKPOINT_FIELDS, INVALID_CHECKPOINT);
  requireValue(checkpoint.schemaVersion === 3, INVALID_CHECKPOINT);
  assertUuidV4(checkpoint.storeId, INVALID_CHECKPOINT);
  assertSafeUnsignedInteger(checkpoint.revision, INVALID_CHECKPOINT);
  const registrations = normalizeCheckpointRegistrations(checkpoint.registrations, maxRecords, INVALID_CHECKPOINT);
  const ledger = normalizeDeliveryLedgerV2LocalInternal(checkpoint.ledger);
  validateCheckpointDeliveryReferences(ledger, registrations, INVALID_CHECKPOINT);
  const migrationAllowance = normalizeMigrationAllowance(checkpoint.migrationAllowance, 2, INVALID_CHECKPOINT);
  return makeRecord([
    ['schemaVersion', 3], ['storeId', checkpoint.storeId], ['revision', checkpoint.revision],
    ['registrations', registrations], ['ledger', ledger], ['migrationAllowance', migrationAllowance],
  ]);
}

function validUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function normalizeInstructionSource(value) {
  const source = captureRecord(value, INSTRUCTION_SOURCE_FIELDS, INVALID_INSTRUCTION);
  assertIdentifier(source.launchRef, INVALID_INSTRUCTION);
  const claims = normalizeClaims(source.claims, INVALID_INSTRUCTION);
  const identity = normalizeIdentity(source.identity, INVALID_INSTRUCTION);
  const executionBinding = normalizePeriodBinding(source.executionBinding, INVALID_INSTRUCTION);
  assertIdentifier(source.conversationId, INVALID_INSTRUCTION);
  assertIdentifier(source.sessionId, INVALID_INSTRUCTION);
  requireValue(identity.provider === claims.provider && identity.nativeIdKind === claims.nativeIdKind &&
    identity.hostId === claims.hostId && identity.homeScopeId === claims.homeScopeId, INVALID_INSTRUCTION);
  return makeRecord([
    ['launchRef', source.launchRef], ['claims', claims], ['identity', identity],
    ['executionBinding', executionBinding], ['conversationId', source.conversationId], ['sessionId', source.sessionId],
  ]);
}

function normalizeInstructionEnvelope(serialized, envelopeDigest, nativeContentDigest) {
  requireValue(typeof serialized === 'string' && Buffer.byteLength(serialized, 'utf8') <= MAX_INSTRUCTION_ENVELOPE_BYTES,
    INVALID_INSTRUCTION);
  assertSha256(envelopeDigest, INVALID_INSTRUCTION);
  assertSha256(nativeContentDigest, INVALID_INSTRUCTION);
  let parsed;
  try {
    parsed = JSON.parse(serialized);
  } catch {
    reject(INVALID_INSTRUCTION);
  }
  const envelope = captureRecord(parsed, INSTRUCTION_ENVELOPE_FIELDS, INVALID_INSTRUCTION);
  requireValue(envelope.schemaVersion === 1 &&
    (envelope.mode === 'steer' || envelope.mode === 'start' || envelope.mode === 'next-user-input'),
  INVALID_INSTRUCTION);
  if (envelope.mode === 'steer') assertIdentifier(envelope.expectedTurnId, INVALID_INSTRUCTION);
  else requireValue(envelope.expectedTurnId === null, INVALID_INSTRUCTION);

  const input = captureArray(envelope.input, 1, INVALID_INSTRUCTION);
  requireValue(input.length === 1, INVALID_INSTRUCTION);
  const item = captureRecord(input[0], INSTRUCTION_INPUT_ITEM_FIELDS, INVALID_INSTRUCTION);
  requireValue(item.type === 'text' && typeof item.text === 'string' && item.text.trim().length > 0 &&
    validUnicode(item.text) && Buffer.byteLength(item.text, 'utf8') <= MAX_INSTRUCTION_TEXT_BYTES,
  INVALID_INSTRUCTION);
  const textElements = captureArray(item.text_elements, 0, INVALID_INSTRUCTION);
  requireValue(textElements.length === 0, INVALID_INSTRUCTION);
  const normalizedInputItem = makeRecord([
    ['type', 'text'], ['text', item.text], ['text_elements', []],
  ]);
  const normalizedInput = [normalizedInputItem];
  const normalizedEnvelope = makeRecord([
    ['schemaVersion', 1], ['mode', envelope.mode], ['expectedTurnId', envelope.expectedTurnId],
    ['input', normalizedInput],
  ]);
  const canonicalEnvelope = compactJson(normalizedEnvelope);
  const canonicalInput = compactJson(normalizedInput);
  requireValue(canonicalEnvelope === serialized && Buffer.byteLength(canonicalEnvelope, 'utf8') <=
    MAX_INSTRUCTION_ENVELOPE_BYTES && sha256Text(canonicalEnvelope) === envelopeDigest &&
    sha256Text(canonicalInput) === nativeContentDigest, INVALID_INSTRUCTION);
  return makeRecord([
    ['serialized', canonicalEnvelope], ['envelopeDigest', envelopeDigest],
    ['nativeContentDigest', nativeContentDigest],
  ]);
}

function normalizeInstructionPreparation(value) {
  if (value === null) return null;
  const preparation = captureRecord(value, PREPARATION_FIELDS, INVALID_INSTRUCTION);
  assertUuidV4(preparation.operationId, INVALID_INSTRUCTION);
  assertSafeUnsignedInteger(preparation.preparedAt, INVALID_INSTRUCTION);
  requireValue(TERMINAL_DELIVERY_STATES.includes(preparation.terminalState), INVALID_INSTRUCTION);
  assertSafeUnsignedInteger(preparation.terminalAt, INVALID_INSTRUCTION);
  const earliestPreparation = checkedAddSafeInteger(
    preparation.terminalAt, TERMINAL_RETENTION_MS, INVALID_INSTRUCTION);
  requireValue(preparation.preparedAt >= earliestPreparation, INVALID_INSTRUCTION);
  return makeRecord(PREPARATION_FIELDS.map((field) => [field, preparation[field]]));
}

function normalizeInstructionDetail(value) {
  const detail = captureRecord(value, INSTRUCTION_DETAIL_FIELDS, INVALID_INSTRUCTION);
  requireValue(detail.recordType === 'detail', INVALID_INSTRUCTION);
  assertIdentifier(detail.deliveryAttemptId, INVALID_INSTRUCTION);
  assertIdentifier(detail.launchRef, INVALID_INSTRUCTION);
  assertIdentifier(detail.logicalMessageId, INVALID_INSTRUCTION);
  assertSafeUnsignedInteger(detail.revision, INVALID_INSTRUCTION);
  const source = normalizeInstructionSource(detail.source);
  requireValue(source.launchRef === detail.launchRef, INVALID_INSTRUCTION);
  const envelope = normalizeInstructionEnvelope(detail.envelope, detail.envelopeDigest, detail.nativeContentDigest);
  assertSafeUnsignedInteger(detail.createdAt, INVALID_INSTRUCTION);
  requireValue(DELIVERY_CREATION_STATES.includes(detail.deliveryCreationState), INVALID_INSTRUCTION);
  const reclamation = normalizeInstructionPreparation(detail.reclamation);
  requireValue(reclamation === null || detail.deliveryCreationState === 'checkpointed', INVALID_INSTRUCTION);
  return makeRecord([
    ['recordType', 'detail'], ['deliveryAttemptId', detail.deliveryAttemptId], ['launchRef', detail.launchRef],
    ['logicalMessageId', detail.logicalMessageId], ['revision', detail.revision], ['source', source],
    ['envelope', envelope.serialized], ['envelopeDigest', envelope.envelopeDigest],
    ['nativeContentDigest', envelope.nativeContentDigest], ['createdAt', detail.createdAt],
    ['deliveryCreationState', detail.deliveryCreationState], ['reclamation', reclamation],
  ]);
}

function normalizeInstructionGrave(value) {
  const grave = captureRecord(value, INSTRUCTION_RECLAIMED_FIELDS, INVALID_INSTRUCTION);
  requireValue(grave.recordType === 'reclaimed', INVALID_INSTRUCTION);
  assertIdentifier(grave.deliveryAttemptId, INVALID_INSTRUCTION);
  assertIdentifier(grave.launchRef, INVALID_INSTRUCTION);
  assertIdentifier(grave.logicalMessageId, INVALID_INSTRUCTION);
  assertSafeUnsignedInteger(grave.revision, INVALID_INSTRUCTION);
  const source = normalizeInstructionSource(grave.source);
  requireValue(source.launchRef === grave.launchRef, INVALID_INSTRUCTION);
  assertSha256(grave.envelopeDigest, INVALID_INSTRUCTION);
  assertSha256(grave.nativeContentDigest, INVALID_INSTRUCTION);
  assertSafeUnsignedInteger(grave.createdAt, INVALID_INSTRUCTION);
  requireValue(grave.deliveryCreationState === 'checkpointed', INVALID_INSTRUCTION);
  const reclamation = normalizeInstructionPreparation(grave.reclamation);
  requireValue(reclamation !== null, INVALID_INSTRUCTION);
  assertSafeUnsignedInteger(grave.reclaimedAt, INVALID_INSTRUCTION);
  requireValue(grave.reclaimedAt >= reclamation.preparedAt, INVALID_INSTRUCTION);
  return makeRecord([
    ['recordType', 'reclaimed'], ['deliveryAttemptId', grave.deliveryAttemptId], ['launchRef', grave.launchRef],
    ['logicalMessageId', grave.logicalMessageId], ['revision', grave.revision], ['source', source],
    ['envelopeDigest', grave.envelopeDigest], ['nativeContentDigest', grave.nativeContentDigest],
    ['createdAt', grave.createdAt], ['deliveryCreationState', 'checkpointed'],
    ['reclamation', reclamation], ['reclaimedAt', grave.reclaimedAt],
  ]);
}

function normalizeInstructionRecordV2LocalInternal(value) {
  const recordType = readRecordType(value, ['detail', 'reclaimed'], INVALID_INSTRUCTION);
  return recordType === 'detail' ? normalizeInstructionDetail(value) : normalizeInstructionGrave(value);
}

function instructionLogicalKey(record) {
  return compactJson([
    record.source.claims.provider,
    record.source.executionBinding.periodId,
    record.logicalMessageId,
    record.revision,
  ]);
}

function normalizeInstructionJournalV2LocalInternal(value, maxRecords = MAX_INSTRUCTIONS) {
  requireValue(Number.isSafeInteger(maxRecords) && maxRecords >= 1 && maxRecords <= MAX_INSTRUCTIONS,
    INVALID_INSTRUCTION_JOURNAL);
  const journal = captureRecord(value, [
    'schemaVersion', 'revision', 'storeId', 'migrationAllowance', 'instructions',
  ], INVALID_INSTRUCTION_JOURNAL);
  requireValue(journal.schemaVersion === 2, INVALID_INSTRUCTION_JOURNAL);
  assertSafeUnsignedInteger(journal.revision, INVALID_INSTRUCTION_JOURNAL);
  assertUuidV4(journal.storeId, INVALID_INSTRUCTION_JOURNAL);
  const instructions = captureArray(journal.instructions, maxRecords, INVALID_INSTRUCTION_JOURNAL)
    .map((item) => normalizeInstructionRecordV2LocalInternal(item));
  const attemptIds = new Set();
  const logicalKeys = new Set();
  for (const instruction of instructions) {
    const key = instructionLogicalKey(instruction);
    requireValue(!attemptIds.has(instruction.deliveryAttemptId) && !logicalKeys.has(key),
      INVALID_INSTRUCTION_JOURNAL);
    attemptIds.add(instruction.deliveryAttemptId);
    logicalKeys.add(key);
  }
  const migrationAllowance = normalizeMigrationAllowance(journal.migrationAllowance, 1, INVALID_INSTRUCTION_JOURNAL);
  return makeRecord([
    ['schemaVersion', 2], ['revision', journal.revision], ['storeId', journal.storeId],
    ['migrationAllowance', migrationAllowance], ['instructions', instructions],
  ]);
}

/** 外部登録との照合を行わず、v2配信recordの局所schemaだけを検査する。 */
function normalizeDeliveryRecordV2Local(value) {
  return normalizeDeliveryRecordV2Internal(value);
}

/** 外部checkpointとの照合を行わず、ledger v2の局所schemaを検査する。 */
function normalizeDeliveryLedgerV2Local(value) {
  return normalizeDeliveryLedgerV2LocalInternal(value);
}

/** 外部storeとの照合や容量計算を行わず、checkpoint v3の局所schemaを検査する。 */
function normalizeCheckpointV3Local(value, maxRecords = MAX_CHECKPOINT_RECORDS) {
  return normalizeCheckpointV3LocalInternal(value, maxRecords);
}

/** 外部checkpointとの照合を行わず、instruction v2 recordの局所schemaだけを検査する。 */
function normalizeInstructionRecordV2Local(value) {
  return normalizeInstructionRecordV2LocalInternal(value);
}

/** 外部checkpoint/storeとの照合を行わず、instruction journal v2の局所schemaを検査する。 */
function normalizeInstructionJournalV2Local(value, maxRecords = MAX_INSTRUCTIONS) {
  return normalizeInstructionJournalV2LocalInternal(value, maxRecords);
}

/** ledger v2を局所検証し、正規化JSON codecでUTF-8化する。 */
function encodeDeliveryLedgerV2Local(value) {
  return encodeNormalized(normalizeDeliveryLedgerV2Local(value));
}

/** checkpoint v3を局所検証し、正規化JSON codecでUTF-8化する。 */
function encodeCheckpointV3Local(value, maxRecords = MAX_CHECKPOINT_RECORDS) {
  return encodeNormalized(normalizeCheckpointV3Local(value, maxRecords));
}

/** instruction journal v2を局所検証し、正規化JSON codecでUTF-8化する。 */
function encodeInstructionJournalV2Local(value, maxRecords = MAX_INSTRUCTIONS) {
  return encodeNormalized(normalizeInstructionJournalV2Local(value, maxRecords));
}

module.exports = {
  encodeCheckpointV3Local,
  encodeDeliveryLedgerV2Local,
  encodeInstructionJournalV2Local,
  normalizeLogicalTombstoneV2Local,
  normalizeCheckpointV3Local,
  normalizeDeliveryLedgerV2Local,
  normalizeDeliveryRecordV2Local,
  normalizeInstructionJournalV2Local,
  normalizeInstructionRecordV2Local,
};
