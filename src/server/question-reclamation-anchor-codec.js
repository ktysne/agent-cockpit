'use strict';

const {
  assertIdentifier,
  assertSafeUnsignedInteger,
  assertSha256,
  assertUuidV4,
  captureDenseArray,
  captureExactRecord,
} = require('./reclamation-codec-primitives');
const { encodeNormalized } = require('./reclamation-json-codec');

const MAX_RETIRED_PERIODS = 20_000;
const MAX_MIGRATION_TARGETS = 20_000;
const MAX_SOURCE_BYTES = 16_777_216;

const ANCHOR_FIELDS = ['schemaVersion', 'revision', 'storeId', 'retiredQuestionPeriods', 'migration'];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const RETIRED_PERIOD_FIELDS = ['identity', 'periodId', 'retiredAt', 'reason'];
const MIGRATION_FIELDS = ['operationId', 'startedAt', 'phase', 'sources', 'targets'];
const SOURCE_FIELDS = [
  'slot', 'sourcePresent', 'schemaVersion', 'revision', 'sizeBytes', 'sha256',
  'targetSchemaVersion', 'targetRevision', 'targetSizeBytes', 'targetSha256',
];
const TARGET_FIELDS = [
  'internalQuestionId', 'commonKeyDigest', 'periodIndex', 'recordDigest',
  'deliveryPresence', 'deliveryIntent', 'checkpointState',
];
const DELIVERY_INTENT_FIELDS = ['deliveryAttemptId', 'logicalMessageId', 'revision', 'payloadDigest'];
const PROVIDER_NATIVE_ID_KINDS = new Map([
  ['claude', 'session'],
  ['codex', 'thread'],
]);
const SOURCE_SLOT_ORDER = new Map([
  ['checkpoint', 0],
  ['instructions', 1],
  ['questions', 2],
]);
const SOURCE_SLOT_VERSIONS = new Map([
  ['questions', { source: 1, target: 2 }],
  ['checkpoint', { source: 2, target: 3 }],
  ['instructions', { source: 1, target: 2 }],
]);
const MIGRATION_PHASES = new Set(['prepared', 'guarded', 'installing', 'completed']);
const RETIREMENT_REASONS = new Set(['startup-quarantine', 'confirmed-retirement']);
const DELIVERY_PRESENCE = new Set(['none', 'checkpoint', 'indeterminate']);
const CHECKPOINT_STATES = new Set([
  'available', 'claimed', 'sending', 'accepted', 'applied', 'unknown',
  'cancelled_before_send', 'superseded_before_send',
]);
const INVALID_ANCHOR = 'invalid_question_reclamation_anchor_v1';

function requireValue(condition) {
  if (!condition) throw new TypeError(INVALID_ANCHOR);
}

function captureRecord(value, fields) {
  return captureExactRecord(value, fields, INVALID_ANCHOR);
}

function captureArray(value, maxLength) {
  return captureDenseArray(value, maxLength, INVALID_ANCHOR);
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

function normalizeIdentity(value) {
  const identity = captureRecord(value, IDENTITY_FIELDS);
  requireValue(typeof identity.provider === 'string' &&
    PROVIDER_NATIVE_ID_KINDS.has(identity.provider) &&
    identity.nativeIdKind === PROVIDER_NATIVE_ID_KINDS.get(identity.provider));
  for (const field of IDENTITY_FIELDS.slice(2)) assertIdentifier(identity[field], INVALID_ANCHOR);
  return makeRecord(IDENTITY_FIELDS.map((field) => [field, identity[field]]));
}

function identityPeriodKey(identity, periodId) {
  return [...IDENTITY_FIELDS.map((field) => identity[field]), periodId]
    .map((value) => `${value.length}:${value}`)
    .join('');
}

function normalizeRetiredPeriod(value) {
  const period = captureRecord(value, RETIRED_PERIOD_FIELDS);
  const identity = normalizeIdentity(period.identity);
  assertIdentifier(period.periodId, INVALID_ANCHOR);
  assertSafeUnsignedInteger(period.retiredAt, INVALID_ANCHOR);
  requireValue(typeof period.reason === 'string' && RETIREMENT_REASONS.has(period.reason));
  return makeRecord([
    ['identity', identity],
    ['periodId', period.periodId],
    ['retiredAt', period.retiredAt],
    ['reason', period.reason],
  ]);
}

function normalizeDeliveryIntent(value) {
  if (value === null) return null;
  const intent = captureRecord(value, DELIVERY_INTENT_FIELDS);
  assertIdentifier(intent.deliveryAttemptId, INVALID_ANCHOR);
  assertIdentifier(intent.logicalMessageId, INVALID_ANCHOR);
  assertSafeUnsignedInteger(intent.revision, INVALID_ANCHOR);
  assertSha256(intent.payloadDigest, INVALID_ANCHOR);
  return makeRecord(DELIVERY_INTENT_FIELDS.map((field) => [field, intent[field]]));
}

function normalizeMigrationTarget(value, retiredPeriodCount) {
  const target = captureRecord(value, TARGET_FIELDS);
  assertIdentifier(target.internalQuestionId, INVALID_ANCHOR);
  assertSha256(target.commonKeyDigest, INVALID_ANCHOR);
  assertSafeUnsignedInteger(target.periodIndex, INVALID_ANCHOR);
  requireValue(target.periodIndex < retiredPeriodCount);
  assertSha256(target.recordDigest, INVALID_ANCHOR);
  requireValue(typeof target.deliveryPresence === 'string' && DELIVERY_PRESENCE.has(target.deliveryPresence));
  const deliveryIntent = normalizeDeliveryIntent(target.deliveryIntent);
  const checkpointState = target.checkpointState;
  if (target.deliveryPresence === 'none') {
    requireValue(checkpointState === null);
  } else if (target.deliveryPresence === 'checkpoint') {
    requireValue(deliveryIntent !== null && typeof checkpointState === 'string' &&
      CHECKPOINT_STATES.has(checkpointState));
  } else {
    requireValue(deliveryIntent !== null && checkpointState === 'unknown');
  }
  return makeRecord([
    ['internalQuestionId', target.internalQuestionId],
    ['commonKeyDigest', target.commonKeyDigest],
    ['periodIndex', target.periodIndex],
    ['recordDigest', target.recordDigest],
    ['deliveryPresence', target.deliveryPresence],
    ['deliveryIntent', deliveryIntent],
    ['checkpointState', checkpointState],
  ]);
}

function normalizeSourceDescriptor(value) {
  const source = captureRecord(value, SOURCE_FIELDS);
  requireValue(typeof source.slot === 'string' && SOURCE_SLOT_VERSIONS.has(source.slot));
  requireValue(typeof source.sourcePresent === 'boolean');
  const versions = SOURCE_SLOT_VERSIONS.get(source.slot);
  requireValue(source.targetSchemaVersion === versions.target);
  assertSafeUnsignedInteger(source.targetRevision, INVALID_ANCHOR);
  assertSafeUnsignedInteger(source.targetSizeBytes, INVALID_ANCHOR);
  assertSha256(source.targetSha256, INVALID_ANCHOR);

  if (source.sourcePresent) {
    requireValue(source.schemaVersion === versions.source);
    assertSafeUnsignedInteger(source.revision, INVALID_ANCHOR);
    requireValue(source.revision < Number.MAX_SAFE_INTEGER &&
      source.targetRevision === source.revision + 1);
    assertSafeUnsignedInteger(source.sizeBytes, INVALID_ANCHOR);
    requireValue(source.sizeBytes <= MAX_SOURCE_BYTES);
    assertSha256(source.sha256, INVALID_ANCHOR);
  } else {
    requireValue(source.schemaVersion === null && source.revision === null && source.sizeBytes === 0 &&
      source.sha256 === null && source.targetRevision === 0);
  }

  return makeRecord(SOURCE_FIELDS.map((field) => [field, source[field]]));
}

function normalizeMigration(value, retiredPeriods) {
  if (value === null) return null;
  const migration = captureRecord(value, MIGRATION_FIELDS);
  assertUuidV4(migration.operationId, INVALID_ANCHOR);
  assertSafeUnsignedInteger(migration.startedAt, INVALID_ANCHOR);
  requireValue(typeof migration.phase === 'string' && MIGRATION_PHASES.has(migration.phase));

  const sources = captureArray(migration.sources, SOURCE_SLOT_ORDER.size).map(normalizeSourceDescriptor);
  const sourceSlots = new Set();
  for (const source of sources) {
    requireValue(!sourceSlots.has(source.slot));
    sourceSlots.add(source.slot);
  }
  sources.sort((left, right) => SOURCE_SLOT_ORDER.get(left.slot) - SOURCE_SLOT_ORDER.get(right.slot));

  const targets = captureArray(migration.targets, MAX_MIGRATION_TARGETS)
    .map((target) => normalizeMigrationTarget(target, retiredPeriods.length));
  const questionIds = new Set();
  const commonKeyDigests = new Set();
  for (const target of targets) {
    requireValue(!questionIds.has(target.internalQuestionId) && !commonKeyDigests.has(target.commonKeyDigest));
    questionIds.add(target.internalQuestionId);
    commonKeyDigests.add(target.commonKeyDigest);
  }

  return makeRecord([
    ['operationId', migration.operationId],
    ['startedAt', migration.startedAt],
    ['phase', migration.phase],
    ['sources', sources],
    ['targets', targets],
  ]);
}

function normalizeQuestionReclamationAnchorV1LocalInternal(value) {
  const anchor = captureRecord(value, ANCHOR_FIELDS);
  requireValue(anchor.schemaVersion === 1);
  assertSafeUnsignedInteger(anchor.revision, INVALID_ANCHOR);
  assertUuidV4(anchor.storeId, INVALID_ANCHOR);

  const retiredPeriods = captureArray(anchor.retiredQuestionPeriods, MAX_RETIRED_PERIODS)
    .map(normalizeRetiredPeriod);
  const retiredKeys = new Set();
  for (const period of retiredPeriods) {
    const key = identityPeriodKey(period.identity, period.periodId);
    requireValue(!retiredKeys.has(key));
    retiredKeys.add(key);
  }
  const migration = normalizeMigration(anchor.migration, retiredPeriods);
  return makeRecord([
    ['schemaVersion', 1],
    ['revision', anchor.revision],
    ['storeId', anchor.storeId],
    ['retiredQuestionPeriods', retiredPeriods],
    ['migration', migration],
  ]);
}

/** anchor v1の局所構造を検査する。store間やsource fingerprintとの照合は行わない。 */
function normalizeQuestionReclamationAnchorV1Local(value) {
  return normalizeQuestionReclamationAnchorV1LocalInternal(value);
}

/** anchor v1を局所検証後に正規化JSONのUTF-8 bytesへ変換する。 */
function encodeQuestionReclamationAnchorV1Local(value) {
  return encodeNormalized(normalizeQuestionReclamationAnchorV1Local(value));
}

module.exports = {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
};
