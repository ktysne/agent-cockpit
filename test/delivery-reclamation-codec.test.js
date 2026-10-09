'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { decodeSourceBytes } = require('../src/server/reclamation-json-codec');
const {
  encodeCheckpointV3Local,
  encodeDeliveryLedgerV2Local,
  encodeInstructionJournalV2Local,
  normalizeCheckpointV3Local,
  normalizeDeliveryLedgerV2Local,
  normalizeDeliveryRecordV2Local,
  normalizeInstructionJournalV2Local,
  normalizeInstructionRecordV2Local,
} = require('../src/server/delivery-reclamation-codec');

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const RETENTION_MS = 604_800_000;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function identityFor(provider, suffix) {
  return {
    provider,
    nativeIdKind: provider === 'claude' ? 'session' : 'thread',
    hostId: `${provider}-host-${suffix}`,
    homeScopeId: `${provider}-home-${suffix}`,
    nativeId: `${provider}-native-${suffix}`,
  };
}

function claimsFor(provider, suffix, overrides = {}) {
  return {
    launchId: `launch-${suffix}`,
    runId: `run-${suffix}`,
    attemptId: `attempt-${suffix}`,
    provider,
    nativeIdKind: provider === 'claude' ? 'session' : 'thread',
    hostId: `${provider}-host-${suffix}`,
    homeScopeId: `${provider}-home-${suffix}`,
    origin: 'standalone',
    purpose: 'agent',
    originBinding: null,
    ...overrides,
  };
}

function sourceFor(provider = 'codex', suffix = 'one') {
  const claims = claimsFor(provider, suffix);
  return {
    launchRef: `launch-ref-${suffix}`,
    claims,
    identity: identityFor(provider, suffix),
    executionBinding: {
      periodId: `period-${suffix}`,
      actor: { kind: 'agent', id: `actor-${suffix}` },
    },
    conversationId: `conversation-${suffix}`,
    sessionId: `session-${suffix}`,
  };
}

function executionTargetFor(source) {
  return {
    kind: 'execution',
    launchRef: source.launchRef,
    claims: structuredClone(source.claims),
    identity: structuredClone(source.identity),
    periodId: source.executionBinding.periodId,
    actor: structuredClone(source.executionBinding.actor),
    conversationId: source.conversationId,
    sessionId: source.sessionId,
  };
}

function ownerTargetFor(source, overrides = {}) {
  return {
    kind: 'owner',
    launchRef: null,
    claims: null,
    identity: structuredClone(source.identity),
    periodId: source.executionBinding.periodId,
    actor: structuredClone(source.executionBinding.actor),
    conversationId: source.conversationId,
    sessionId: source.sessionId,
    ...overrides,
  };
}

function correlationFor(record, target, options = {}) {
  return {
    deliveryAttemptId: record.deliveryAttemptId,
    revision: record.revision,
    payloadDigest: record.payloadDigest,
    targetPeriodId: target.periodId,
    nativeTurnId: options.nativeTurnId ?? null,
    nativeItemId: options.nativeItemId ?? null,
    clientRequestId: record.deliveryAttemptId,
  };
}

function deliveryFor(options = {}) {
  const kind = options.kind || 'question';
  const source = options.source || sourceFor(options.provider || 'codex', options.suffix || 'one');
  const target = options.target || (kind === 'result' ? ownerTargetFor(source) : executionTargetFor(source));
  const state = options.state || 'available';
  const record = {
    recordType: 'detail',
    deliveryAttemptId: options.deliveryAttemptId || `delivery-${options.suffix || 'one'}`,
    kind,
    logicalMessageId: options.logicalMessageId || `logical-${options.suffix || 'one'}`,
    revision: options.revision ?? 1,
    sourceExecutionId: source.executionBinding.periodId,
    source: structuredClone(source),
    target,
    ownerGeneration: kind === 'result' ? (options.ownerGeneration ?? 0) : null,
    payloadDigest: options.payloadDigest || SHA_A,
    state,
    cancelRequested: options.cancelRequested ?? false,
    acceptedCorrelation: null,
    appliedCorrelation: null,
    terminalAt: ['applied', 'cancelled_before_send', 'superseded_before_send'].includes(state)
      ? (options.terminalAt ?? 100)
      : null,
  };
  if (state === 'accepted') record.acceptedCorrelation = correlationFor(record, target);
  if (state === 'applied') {
    record.appliedCorrelation = correlationFor(record, target, {
      nativeTurnId: `turn-${options.suffix || 'one'}`,
      nativeItemId: `item-${options.suffix || 'one'}`,
    });
  }
  if (options.acceptedCorrelation !== undefined) record.acceptedCorrelation = options.acceptedCorrelation;
  if (options.appliedCorrelation !== undefined) record.appliedCorrelation = options.appliedCorrelation;
  return record;
}

function sourceRefFor(source, digest = sha256(JSON.stringify(source.claims))) {
  return {
    launchRef: source.launchRef,
    launchKey: [source.claims.launchId, source.claims.runId, source.claims.attemptId],
    sourceClaimsDigest: digest,
    identity: structuredClone(source.identity),
    executionBinding: structuredClone(source.executionBinding),
    conversationId: source.conversationId,
    sessionId: source.sessionId,
  };
}

function targetRefFor(target, digest = target.kind === 'execution' ? sha256(JSON.stringify(target.claims)) : null) {
  return {
    kind: target.kind,
    launchRef: target.launchRef,
    launchKey: target.kind === 'execution'
      ? [target.claims.launchId, target.claims.runId, target.claims.attemptId]
      : null,
    targetClaimsDigest: digest,
    identity: structuredClone(target.identity),
    periodId: target.periodId,
    actor: structuredClone(target.actor),
    conversationId: target.conversationId,
    sessionId: target.sessionId,
  };
}

function graveFor(options = {}) {
  const kind = options.kind || 'question';
  const state = options.state || (kind === 'question' ? 'available' : 'applied');
  const detail = deliveryFor({ ...options, kind, state });
  const reason = options.reason || (kind === 'question' ? 'retired_question_period' : 'terminal_retention');
  const reclaimedAt = options.reclaimedAt ?? (detail.terminalAt === null
    ? 1_000
    : detail.terminalAt + RETENTION_MS);
  return {
    recordType: 'reclaimed',
    deliveryAttemptId: detail.deliveryAttemptId,
    kind,
    logicalMessageId: detail.logicalMessageId,
    revision: detail.revision,
    sourceExecutionId: detail.sourceExecutionId,
    payloadDigest: detail.payloadDigest,
    state,
    terminalAt: detail.terminalAt,
    cancelRequested: detail.cancelRequested,
    ownerGeneration: detail.ownerGeneration,
    acceptedCorrelation: detail.acceptedCorrelation,
    appliedCorrelation: detail.appliedCorrelation,
    sourceRef: sourceRefFor(detail.source, options.sourceClaimsDigest),
    targetRef: targetRefFor(detail.target, options.targetClaimsDigest),
    reclamation: {
      operationId: UUID_A,
      reclaimedAt,
      reason,
    },
  };
}

function tombstoneFor(record) {
  const sourceKey = record.recordType === 'detail'
    ? [record.source.claims.launchId, record.source.claims.runId, record.source.claims.attemptId]
    : record.sourceRef.launchKey;
  const target = record.recordType === 'detail' ? record.target : record.targetRef;
  const isPr = record.kind === 'pr-notification';
  const targetKey = !isPr
    ? null
    : record.recordType === 'detail'
      ? [target.claims.launchId, target.claims.runId, target.claims.attemptId]
      : target.launchKey;
  return {
    kind: record.kind,
    sourceExecutionId: isPr ? null : record.sourceExecutionId,
    logicalMessageId: record.logicalMessageId,
    revision: record.revision,
    targetLaunchKey: targetKey,
    sourceLaunchKey: isPr ? null : sourceKey,
    payloadDigest: record.payloadDigest,
  };
}

function ledgerFor(record, options = {}) {
  const deliveries = options.deliveries || (record ? [record] : []);
  const logicalTombstones = options.logicalTombstones ||
    (deliveries.length === 0 ? [] : [tombstoneFor(deliveries[deliveries.length - 1])]);
  return {
    schemaVersion: 2,
    revision: 1,
    deliveries,
    notificationTargets: options.notificationTargets || [],
    logicalTombstones,
  };
}

function emptyRegistrations() {
  return {
    conversations: [],
    executions: [],
    launches: [],
    runtimeLaunches: [],
    connections: [],
    actors: [],
    handoffs: [],
    replayClaims: [],
    incompleteConversationIds: [],
  };
}

function registrationsFor(source, options = {}) {
  const registrations = emptyRegistrations();
  const binding = source.executionBinding;
  const scope = {
    provider: source.identity.provider,
    nativeIdKind: source.identity.nativeIdKind,
    hostId: source.identity.hostId,
    homeScopeId: source.identity.homeScopeId,
    connectionSlotId: `slot-${source.launchRef}`,
  };
  registrations.conversations.push({
    conversationId: source.conversationId,
    identity: structuredClone(source.identity),
  });
  registrations.executions.push({
    conversationId: source.conversationId,
    executionId: binding.periodId,
    sessionId: source.sessionId,
    state: 'active',
  });
  registrations.launches.push({
    launchRef: source.launchRef,
    claims: structuredClone(source.claims),
    state: 'bound',
    identity: structuredClone(source.identity),
    executionBinding: structuredClone(binding),
    conversationId: source.conversationId,
    sessionId: source.sessionId,
  });
  registrations.runtimeLaunches.push({
    launchRef: source.launchRef,
    claims: {
      ...structuredClone(source.claims),
      identity: structuredClone(source.identity),
      executionBinding: structuredClone(binding),
    },
    state: 'bound',
    conversationId: source.conversationId,
    sessionId: source.sessionId,
    currentOwner: structuredClone(options.currentOwner || binding),
    ownerGeneration: options.runtimeOwnerGeneration ?? 0,
  });
  registrations.incompleteConversationIds.push(source.conversationId);

  if (options.actor !== false) {
    registrations.connections.push({
      scope,
      generation: options.connectionGeneration ?? 1,
      state: 'active',
    });
    registrations.actors.push({
      identity: structuredClone(source.identity),
      periodId: binding.periodId,
      actor: structuredClone(binding.actor),
      contextId: `context-${source.launchRef}`,
      launchRef: null,
      immutableExecutionClaims: null,
      connectionScope: structuredClone(scope),
      connectionGeneration: options.actorConnectionGeneration ?? 1,
      state: 'active',
    });
  }
  return registrations;
}

function checkpointFor(record, source, options = {}) {
  const registrations = registrationsFor(source, options);
  if (options.incomplete === false) registrations.incompleteConversationIds = [];
  if (options.actor === false) registrations.actors = [];
  return {
    schemaVersion: 3,
    storeId: UUID_A,
    revision: 1,
    registrations,
    ledger: ledgerFor(record),
    migrationAllowance: options.migrationAllowance ?? null,
  };
}

function envelopeFor(mode = 'steer', text = 'Keep going', expectedTurnId = 'turn-1') {
  const envelope = {
    schemaVersion: 1,
    mode,
    expectedTurnId: mode === 'steer' ? expectedTurnId : null,
    input: [{ type: 'text', text, text_elements: [] }],
  };
  const serialized = JSON.stringify(envelope);
  const nativeContent = JSON.stringify(envelope.input);
  return {
    serialized,
    envelopeDigest: sha256(serialized),
    nativeContentDigest: sha256(nativeContent),
  };
}

function instructionSourceFor(provider = 'codex', suffix = 'instruction') {
  return sourceFor(provider, suffix);
}

function instructionFor(options = {}) {
  const source = options.source || instructionSourceFor(options.provider || 'codex', options.suffix || 'instruction');
  const envelope = envelopeFor(options.mode || 'steer', options.text || 'Keep going');
  const creationState = options.deliveryCreationState || 'not_created';
  const reclamation = options.reclamation === undefined ? null : options.reclamation;
  const recordType = options.recordType || 'detail';
  const detail = {
    recordType: 'detail',
    deliveryAttemptId: options.deliveryAttemptId || `instruction-${options.suffix || 'one'}`,
    launchRef: source.launchRef,
    logicalMessageId: options.logicalMessageId || `instruction-logical-${options.suffix || 'one'}`,
    revision: options.revision ?? 1,
    source: structuredClone(source),
    envelope: envelope.serialized,
    envelopeDigest: envelope.envelopeDigest,
    nativeContentDigest: envelope.nativeContentDigest,
    createdAt: options.createdAt ?? 1,
    deliveryCreationState: creationState,
    reclamation,
  };
  if (recordType === 'detail') return detail;
  return {
    recordType: 'reclaimed',
    deliveryAttemptId: detail.deliveryAttemptId,
    launchRef: detail.launchRef,
    logicalMessageId: detail.logicalMessageId,
    revision: detail.revision,
    source: detail.source,
    envelopeDigest: detail.envelopeDigest,
    nativeContentDigest: detail.nativeContentDigest,
    createdAt: detail.createdAt,
    deliveryCreationState: 'checkpointed',
    reclamation,
    reclaimedAt: options.reclaimedAt ?? (reclamation?.preparedAt ?? 0),
  };
}

function preparationFor(options = {}) {
  const terminalAt = options.terminalAt ?? 100;
  return {
    operationId: options.operationId || UUID_B,
    preparedAt: options.preparedAt ?? terminalAt + RETENTION_MS,
    terminalState: options.terminalState || 'applied',
    terminalAt,
  };
}

function instructionJournal(instructions = [], options = {}) {
  return {
    schemaVersion: 2,
    revision: options.revision ?? 1,
    storeId: UUID_A,
    migrationAllowance: options.migrationAllowance ?? null,
    instructions,
  };
}

function grantFor(options = {}) {
  return {
    operationId: UUID_B,
    sourceSchemaVersion: options.sourceSchemaVersion ?? 2,
    sourceSizeBytes: options.sourceSizeBytes ?? 128,
    sourceSha256: options.sourceSha256 || SHA_A,
    maxExtraBytes: options.maxExtraBytes ?? 1,
    eligibleAttemptIds: options.eligibleAttemptIds || ['delivery-one'],
  };
}

function assertInvalid(callback, code) {
  assert.throws(callback, (error) => error instanceof TypeError && error.message === code);
}

function reverseProperties(value) {
  if (Array.isArray(value)) return value.map(reverseProperties);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reverseProperties(item)]));
}

test('normalizes delivery detail states and their correlation requirements', () => {
  const states = [
    'available', 'claimed', 'sending', 'accepted', 'applied', 'unknown',
    'cancelled_before_send', 'superseded_before_send',
  ];
  for (const state of states) {
    const normalized = normalizeDeliveryRecordV2Local(deliveryFor({ state, suffix: `state-${state}` }));
    assert.equal(normalized.state, state);
  }

  assertInvalid(() => normalizeDeliveryRecordV2Local(deliveryFor({ state: 'accepted', acceptedCorrelation: null })),
    'invalid_delivery_record_v2');
  assertInvalid(() => normalizeDeliveryRecordV2Local(deliveryFor({
    state: 'applied',
    appliedCorrelation: correlationFor(deliveryFor({ state: 'applied' }), executionTargetFor(sourceFor())),
  })), 'invalid_delivery_record_v2');
  assertInvalid(() => normalizeDeliveryRecordV2Local(deliveryFor({
    state: 'cancelled_before_send',
    cancelRequested: true,
  })), 'invalid_delivery_record_v2');
  const earlyTerminal = deliveryFor({ state: 'available' });
  earlyTerminal.terminalAt = 0;
  assertInvalid(() => normalizeDeliveryRecordV2Local(earlyTerminal), 'invalid_delivery_record_v2');
});

test('checks every correlation identity field and permits a partial accepted to complete applied result', () => {
  const fields = [
    ['deliveryAttemptId', 'another-attempt'],
    ['revision', 2],
    ['payloadDigest', SHA_B],
    ['targetPeriodId', 'another-period'],
    ['clientRequestId', 'another-request'],
  ];
  for (const [field, replacement] of fields) {
    const accepted = deliveryFor({ state: 'accepted', suffix: `accepted-${field}` });
    accepted.acceptedCorrelation[field] = replacement;
    assertInvalid(() => normalizeDeliveryRecordV2Local(accepted), 'invalid_delivery_record_v2');

    const applied = deliveryFor({ state: 'applied', suffix: `applied-${field}` });
    applied.appliedCorrelation[field] = replacement;
    assertInvalid(() => normalizeDeliveryRecordV2Local(applied), 'invalid_delivery_record_v2');
  }

  const completed = deliveryFor({ state: 'applied', suffix: 'accepted-to-applied' });
  completed.acceptedCorrelation = correlationFor(completed, completed.target);
  assert.equal(normalizeDeliveryRecordV2Local(completed).state, 'applied');

  const source = sourceFor('codex', 'reuse-item');
  const first = deliveryFor({
    state: 'applied', source, suffix: 'reuse-first', deliveryAttemptId: 'reuse-attempt-one',
    logicalMessageId: 'reuse-logical-one',
  });
  const second = deliveryFor({
    state: 'applied', source, suffix: 'reuse-second', deliveryAttemptId: 'reuse-attempt-two',
    logicalMessageId: 'reuse-logical-two',
  });
  second.appliedCorrelation.nativeTurnId = first.appliedCorrelation.nativeTurnId;
  second.appliedCorrelation.nativeItemId = first.appliedCorrelation.nativeItemId;
  assertInvalid(() => normalizeDeliveryLedgerV2Local(ledgerFor(null, {
    deliveries: [first, second],
    logicalTombstones: [tombstoneFor(first), tombstoneFor(second)],
  })), 'invalid_delivery_ledger_v2');
});

test('accepts question and instruction grave binding matches for both providers', () => {
  for (const provider of ['claude', 'codex']) {
    for (const kind of ['question', 'instruction']) {
      const grave = graveFor({ provider, kind, suffix: `${provider}-${kind}` });
      assert.equal(normalizeDeliveryRecordV2Local(grave).kind, kind);
    }
  }
});

test('rejects question and instruction grave period and actor binding mismatches', () => {
  for (const kind of ['question', 'instruction']) {
    for (const mismatch of [
      (grave) => { grave.targetRef.periodId = 'different-period'; },
      (grave) => { grave.targetRef.actor.kind = 'tool-use'; },
      (grave) => { grave.targetRef.actor.id = 'different-actor'; },
    ]) {
      const grave = graveFor({ kind, suffix: `binding-${kind}` });
      mismatch(grave);
      assertInvalid(() => normalizeDeliveryRecordV2Local(grave), 'invalid_delivery_record_v2');
    }
  }
});

test('enforces grave reason, terminal retention, and safe timestamp addition', () => {
  const terminalQuestion = graveFor({ kind: 'question', state: 'applied', terminalAt: 100 });
  assert.equal(normalizeDeliveryRecordV2Local(terminalQuestion).reclamation.reclaimedAt, 100 + RETENTION_MS);

  const terminalInstruction = graveFor({ kind: 'instruction', state: 'applied', terminalAt: 100 });
  assert.equal(normalizeDeliveryRecordV2Local(terminalInstruction).kind, 'instruction');

  const tooEarly = graveFor({ kind: 'question', state: 'applied', terminalAt: 100, reclaimedAt: 100 + RETENTION_MS - 1 });
  assertInvalid(() => normalizeDeliveryRecordV2Local(tooEarly), 'invalid_delivery_record_v2');

  const overflow = graveFor({
    kind: 'question', state: 'applied', terminalAt: Number.MAX_SAFE_INTEGER - RETENTION_MS + 1,
    reclaimedAt: Number.MAX_SAFE_INTEGER,
  });
  assertInvalid(() => normalizeDeliveryRecordV2Local(overflow), 'invalid_delivery_record_v2');

  assertInvalid(() => normalizeDeliveryRecordV2Local(graveFor({ kind: 'question', reason: 'terminal_retention' })),
    'invalid_delivery_record_v2');
  assertInvalid(() => normalizeDeliveryRecordV2Local(graveFor({
    kind: 'instruction', state: 'available', reason: 'terminal_retention',
  })), 'invalid_delivery_record_v2');
  assertInvalid(() => normalizeDeliveryRecordV2Local(graveFor({ kind: 'question', state: 'claimed' })),
    'invalid_delivery_record_v2');
});

test('normalizes an empty ledger and a complete delivery tombstone pair', () => {
  const empty = ledgerFor(null);
  assert.deepEqual(JSON.parse(JSON.stringify(normalizeDeliveryLedgerV2Local(empty))), empty);

  const detail = deliveryFor({ suffix: 'ledger' });
  const ledger = ledgerFor(detail);
  const normalized = normalizeDeliveryLedgerV2Local(ledger);
  assert.equal(normalized.deliveries.length, 1);
  assert.equal(normalized.logicalTombstones[0].sourceLaunchKey[0], detail.source.claims.launchId);
});

test('preserves legal superseded delivery predecessors and rejects incomplete logical groups', () => {
  const predecessor = deliveryFor({
    suffix: 'group-old',
    deliveryAttemptId: 'attempt-old',
    logicalMessageId: 'same-logical',
    state: 'superseded_before_send',
  });
  const current = deliveryFor({
    suffix: 'group-new',
    deliveryAttemptId: 'attempt-new',
    logicalMessageId: 'same-logical',
  });
  predecessor.source = structuredClone(current.source);
  predecessor.target = executionTargetFor(current.source);
  predecessor.sourceExecutionId = current.sourceExecutionId;
  predecessor.payloadDigest = current.payloadDigest;
  const tombstone = tombstoneFor(current);
  assert.equal(normalizeDeliveryLedgerV2Local(ledgerFor(null, {
    deliveries: [predecessor, current],
    logicalTombstones: [tombstone],
  })).deliveries.length, 2);

  const invalidPredecessor = structuredClone(predecessor);
  invalidPredecessor.state = 'available';
  invalidPredecessor.terminalAt = null;
  assertInvalid(() => normalizeDeliveryLedgerV2Local(ledgerFor(null, {
    deliveries: [invalidPredecessor, current],
    logicalTombstones: [tombstone],
  })), 'invalid_delivery_ledger_v2');

  const duplicateAttempt = structuredClone(predecessor);
  duplicateAttempt.deliveryAttemptId = predecessor.deliveryAttemptId;
  assertInvalid(() => normalizeDeliveryLedgerV2Local(ledgerFor(null, {
    deliveries: [predecessor, duplicateAttempt],
    logicalTombstones: [tombstone],
  })), 'invalid_delivery_ledger_v2');

  assertInvalid(() => normalizeDeliveryLedgerV2Local(ledgerFor(null, {
    deliveries: [current],
    logicalTombstones: [tombstone, structuredClone(tombstone)],
  })), 'invalid_delivery_ledger_v2');
});

test('requires unique notification aliases and a single canonical launch projection', () => {
  const source = sourceFor('codex', 'pr-target');
  const alias = { targetId: 'pr-alias', launch: structuredClone(source) };
  assert.equal(normalizeDeliveryLedgerV2Local(ledgerFor(null, {
    notificationTargets: [alias],
  })).notificationTargets.length, 1);

  assertInvalid(() => normalizeDeliveryLedgerV2Local(ledgerFor(null, {
    notificationTargets: [alias, structuredClone(alias)],
  })), 'invalid_delivery_ledger_v2');

  const secondProjection = structuredClone(alias);
  secondProjection.targetId = 'other-alias';
  secondProjection.launch.launchRef = 'other-launch-ref';
  assertInvalid(() => normalizeDeliveryLedgerV2Local(ledgerFor(null, {
    notificationTargets: [alias, secondProjection],
  })), 'invalid_delivery_ledger_v2');
});

test('checks PR notification aliases against live detail and grave target claims', () => {
  const source = sourceFor('codex', 'pr-source');
  const targetSource = sourceFor('claude', 'pr-target');
  const target = executionTargetFor(targetSource);
  const alias = { targetId: 'pr-target-alias', launch: structuredClone(targetSource) };
  const detail = deliveryFor({
    kind: 'pr-notification',
    source,
    target,
    suffix: 'pr-notification',
  });
  const valid = ledgerFor(detail, { notificationTargets: [alias] });
  assert.equal(normalizeDeliveryLedgerV2Local(valid).deliveries[0].kind, 'pr-notification');

  const targetClaimsMismatch = structuredClone(valid);
  targetClaimsMismatch.deliveries[0].target.claims.attemptId = 'different-attempt';
  assertInvalid(() => normalizeDeliveryLedgerV2Local(targetClaimsMismatch), 'invalid_delivery_ledger_v2');

  const grave = graveFor({
    kind: 'pr-notification', source, target, state: 'applied', suffix: 'pr-grave',
  });
  const graveLedger = ledgerFor(grave, { notificationTargets: [alias] });
  assert.equal(normalizeDeliveryLedgerV2Local(graveLedger).deliveries[0].recordType, 'reclaimed');

  const digestMismatch = structuredClone(graveLedger);
  digestMismatch.deliveries[0].targetRef.targetClaimsDigest = SHA_B;
  assertInvalid(() => normalizeDeliveryLedgerV2Local(digestMismatch), 'invalid_delivery_ledger_v2');
});

test('uses registration claims digests for checkpoint grave references', () => {
  const source = sourceFor('claude', 'checkpoint-grave');
  const grave = graveFor({ kind: 'question', source, suffix: 'checkpoint-grave' });
  const checkpoint = checkpointFor(grave, source, { actor: false });
  assert.equal(normalizeCheckpointV3Local(checkpoint).ledger.deliveries[0].recordType, 'reclaimed');

  const digestMismatch = structuredClone(grave);
  digestMismatch.sourceRef.sourceClaimsDigest = SHA_B;
  digestMismatch.targetRef.targetClaimsDigest = SHA_B;
  assertInvalid(() => normalizeCheckpointV3Local(checkpointFor(digestMismatch, source, { actor: false })),
    'invalid_delivery_checkpoint_v3');
});

test('checks checkpoint detail references against launch and runtime registrations', () => {
  const source = sourceFor('codex', 'checkpoint-detail');
  const detail = deliveryFor({ source, suffix: 'checkpoint-detail' });
  const checkpoint = checkpointFor(detail, source, { actor: false });
  assert.equal(normalizeCheckpointV3Local(checkpoint).ledger.deliveries[0].recordType, 'detail');

  const launchMismatch = structuredClone(checkpoint);
  launchMismatch.registrations.launches[0].claims.attemptId = 'other-attempt';
  assertInvalid(() => normalizeCheckpointV3Local(launchMismatch), 'invalid_delivery_checkpoint_v3');

  const runtimeMismatch = structuredClone(checkpoint);
  runtimeMismatch.registrations.runtimeLaunches[0].claims.executionBinding.actor.id = 'other-actor';
  assertInvalid(() => normalizeCheckpointV3Local(runtimeMismatch), 'invalid_delivery_checkpoint_v3');

  const ledgerOnly = ledgerFor(detail);
  assert.doesNotThrow(() => normalizeDeliveryLedgerV2Local(ledgerOnly));
  const registrationsOnly = checkpointFor(null, source, { actor: false });
  registrationsOnly.registrations.launches = [];
  registrationsOnly.registrations.runtimeLaunches = [];
  assert.doesNotThrow(() => normalizeCheckpointV3Local(registrationsOnly));
  registrationsOnly.ledger = ledgerOnly;
  assertInvalid(() => normalizeCheckpointV3Local(registrationsOnly), 'invalid_delivery_checkpoint_v3');
});

test('keeps checkpoint replay, actor, connection, and owner generation boundaries', () => {
  const source = sourceFor('codex', 'result-checkpoint');
  const result = deliveryFor({ kind: 'result', source, suffix: 'result-checkpoint' });
  const checkpoint = checkpointFor(result, source);
  assert.equal(normalizeCheckpointV3Local(checkpoint).ledger.deliveries[0].kind, 'result');

  const missingReplay = checkpointFor(result, source, { incomplete: false });
  assertInvalid(() => normalizeCheckpointV3Local(missingReplay), 'invalid_delivery_checkpoint_v3');

  const missingActor = checkpointFor(result, source, { actor: false });
  assertInvalid(() => normalizeCheckpointV3Local(missingActor), 'invalid_delivery_checkpoint_v3');

  const missingConnectionGeneration = checkpointFor(result, source, { actorConnectionGeneration: 2 });
  assertInvalid(() => normalizeCheckpointV3Local(missingConnectionGeneration), 'invalid_delivery_checkpoint_v3');

  const futureOwnerGeneration = structuredClone(result);
  futureOwnerGeneration.ownerGeneration = 1;
  assertInvalid(() => normalizeCheckpointV3Local(checkpointFor(futureOwnerGeneration, source)),
    'invalid_delivery_checkpoint_v3');
});

test('validates checkpoint migration grant fields and bounds', () => {
  const empty = checkpointFor(null, sourceFor(), {
    migrationAllowance: grantFor({ sourceSizeBytes: 16_777_216 }),
  });
  assert.equal(normalizeCheckpointV3Local(empty).migrationAllowance.sourceSizeBytes, 16_777_216);

  for (const grant of [
    grantFor({ sourceSchemaVersion: 1 }),
    grantFor({ sourceSizeBytes: -1 }),
    grantFor({ sourceSizeBytes: 16_777_217 }),
    grantFor({ maxExtraBytes: 0 }),
    grantFor({ maxExtraBytes: Number.MAX_SAFE_INTEGER + 1 }),
    { ...grantFor(), eligibleAttemptIds: ['same', 'same'] },
    { ...grantFor(), operationId: 'not-a-uuid' },
    { ...grantFor(), sourceSha256: 'A'.repeat(64) },
    { ...grantFor(), unknown: true },
  ]) {
    assertInvalid(() => normalizeCheckpointV3Local(checkpointFor(null, sourceFor(), { migrationAllowance: grant })),
      'invalid_delivery_checkpoint_v3');
  }
  assertInvalid(() => normalizeCheckpointV3Local(checkpointFor(null, sourceFor()), 0),
    'invalid_delivery_checkpoint_v3');
  assertInvalid(() => normalizeCheckpointV3Local(checkpointFor(null, sourceFor()), 50_001),
    'invalid_delivery_checkpoint_v3');

  const maximumRoster = Array.from({ length: 20_000 }, (_, index) => `eligible-${index}`);
  const maximumGrant = grantFor({ eligibleAttemptIds: maximumRoster });
  assert.equal(normalizeCheckpointV3Local(checkpointFor(null, sourceFor(), {
    migrationAllowance: maximumGrant,
  })).migrationAllowance.eligibleAttemptIds.length, 20_000);
  assertInvalid(() => normalizeCheckpointV3Local(checkpointFor(null, sourceFor(), {
    migrationAllowance: grantFor({ eligibleAttemptIds: [...maximumRoster, 'eligible-overflow'] }),
  })), 'invalid_delivery_checkpoint_v3');
});

test('accepts instruction envelope modes with canonical field order', () => {
  for (const mode of ['steer', 'start', 'next-user-input']) {
    const instruction = instructionFor({ mode, suffix: `envelope-${mode}` });
    assert.equal(normalizeInstructionRecordV2Local(instruction).recordType, 'detail');
  }

  const reordered = instructionFor();
  reordered.envelope = '{"mode":"steer","schemaVersion":1,"expectedTurnId":"turn-1","input":[{"type":"text","text":"Keep going","text_elements":[]}]}';
  reordered.envelopeDigest = sha256(reordered.envelope);
  assertInvalid(() => normalizeInstructionRecordV2Local(reordered), 'invalid_instruction_record_v2');
});

test('requires preparation to follow a terminal retention interval and rejects overflow', () => {
  for (const terminalState of ['applied', 'cancelled_before_send', 'superseded_before_send']) {
    const preparation = preparationFor({ terminalState, terminalAt: 100 });
    const detail = instructionFor({
      deliveryCreationState: 'checkpointed',
      reclamation: preparation,
      suffix: `prepared-${terminalState}`,
    });
    assert.equal(normalizeInstructionRecordV2Local(detail).reclamation.preparedAt, 100 + RETENTION_MS);
  }

  const early = instructionFor({
    deliveryCreationState: 'checkpointed',
    reclamation: preparationFor({ terminalAt: 100, preparedAt: 100 + RETENTION_MS - 1 }),
  });
  assertInvalid(() => normalizeInstructionRecordV2Local(early), 'invalid_instruction_record_v2');

  const overflow = instructionFor({
    deliveryCreationState: 'checkpointed',
    reclamation: preparationFor({
      terminalAt: Number.MAX_SAFE_INTEGER - RETENTION_MS + 1,
      preparedAt: Number.MAX_SAFE_INTEGER,
    }),
  });
  assertInvalid(() => normalizeInstructionRecordV2Local(overflow), 'invalid_instruction_record_v2');
});

test('ties instruction preparation to checkpointed details and retained graves', () => {
  for (const deliveryCreationState of ['not_created', 'creating', 'checkpointed', 'indeterminate']) {
    assert.equal(normalizeInstructionRecordV2Local(instructionFor({
      deliveryCreationState,
      suffix: `creation-${deliveryCreationState}`,
    })).deliveryCreationState, deliveryCreationState);
  }

  const preparation = preparationFor();
  const prepared = instructionFor({
    deliveryCreationState: 'checkpointed',
    reclamation: preparation,
  });
  assert.equal(normalizeInstructionRecordV2Local(prepared).deliveryCreationState, 'checkpointed');

  for (const deliveryCreationState of ['not_created', 'creating', 'indeterminate']) {
    const invalid = instructionFor({ deliveryCreationState, reclamation: preparation });
    assertInvalid(() => normalizeInstructionRecordV2Local(invalid), 'invalid_instruction_record_v2');
  }

  const grave = instructionFor({
    recordType: 'reclaimed',
    deliveryCreationState: 'checkpointed',
    reclamation: preparation,
    reclaimedAt: preparation.preparedAt,
  });
  assert.equal(normalizeInstructionRecordV2Local(grave).recordType, 'reclaimed');

  const tooEarly = instructionFor({
    recordType: 'reclaimed',
    deliveryCreationState: 'checkpointed',
    reclamation: preparation,
    reclaimedAt: preparation.preparedAt - 1,
  });
  assertInvalid(() => normalizeInstructionRecordV2Local(tooEarly), 'invalid_instruction_record_v2');

  const bodyOnGrave = { ...grave, envelope: envelopeFor().serialized };
  assertInvalid(() => normalizeInstructionRecordV2Local(bodyOnGrave), 'invalid_instruction_record_v2');
});

test('checks instruction journal attempt and logical-key uniqueness', () => {
  const first = instructionFor({ suffix: 'journal-first' });
  assert.equal(normalizeInstructionJournalV2Local(instructionJournal([first])).instructions.length, 1);

  const repeatedAttempt = instructionFor({ suffix: 'journal-second', deliveryAttemptId: first.deliveryAttemptId });
  assertInvalid(() => normalizeInstructionJournalV2Local(instructionJournal([first, repeatedAttempt])),
    'invalid_instruction_journal_v2');

  const repeatedLogical = instructionFor({
    source: structuredClone(first.source),
    suffix: 'journal-third',
    logicalMessageId: first.logicalMessageId,
    deliveryAttemptId: 'different-attempt',
  });
  assertInvalid(() => normalizeInstructionJournalV2Local(instructionJournal([first, repeatedLogical])),
    'invalid_instruction_journal_v2');

  assertInvalid(() => normalizeInstructionJournalV2Local(instructionJournal([first]), 0),
    'invalid_instruction_journal_v2');
  assert.equal(normalizeInstructionJournalV2Local(instructionJournal([first]), 1).instructions.length, 1);
  assertInvalid(() => normalizeInstructionJournalV2Local(instructionJournal([first, repeatedLogical]), 1),
    'invalid_instruction_journal_v2');
});

test('validates instruction journal migration grant and identifiers', () => {
  const journal = instructionJournal([], {
    migrationAllowance: grantFor({ sourceSchemaVersion: 1, eligibleAttemptIds: ['instruction-one'] }),
  });
  assert.equal(normalizeInstructionJournalV2Local(journal).migrationAllowance.sourceSchemaVersion, 1);

  const invalidGrants = [
    grantFor({ sourceSchemaVersion: 2 }),
    grantFor({ sourceSizeBytes: 16_777_217, sourceSchemaVersion: 1 }),
    { ...grantFor({ sourceSchemaVersion: 1 }), eligibleAttemptIds: ['duplicate', 'duplicate'] },
    { ...grantFor({ sourceSchemaVersion: 1 }), extra: true },
  ];
  for (const migrationAllowance of invalidGrants) {
    assertInvalid(() => normalizeInstructionJournalV2Local(instructionJournal([], { migrationAllowance })),
      'invalid_instruction_journal_v2');
  }
  assertInvalid(() => normalizeInstructionJournalV2Local({ ...journal, storeId: 'not-a-uuid' }),
    'invalid_instruction_journal_v2');
});

test('accepts bounded escaped identifiers and UTF-8 instruction text', () => {
  const longIdentifier = '"Ω'.repeat(256);
  const source = sourceFor('claude', 'escaped');
  source.launchRef = longIdentifier;
  const instruction = instructionFor({
    source,
    suffix: 'escaped',
    text: '🙂'.repeat(16_384),
  });
  assert.equal(normalizeInstructionRecordV2Local(instruction).source.launchRef, longIdentifier);

  const tooLongText = instructionFor({ text: '🙂'.repeat(16_385) });
  assertInvalid(() => normalizeInstructionRecordV2Local(tooLongText), 'invalid_instruction_record_v2');

  const loneSurrogate = instructionFor({ text: '\ud800' });
  assertInvalid(() => normalizeInstructionRecordV2Local(loneSurrogate), 'invalid_instruction_record_v2');

  const escapedEnvelopeLimit = instructionFor({ text: '"'.repeat(40_000) });
  assert.equal(Buffer.byteLength('"'.repeat(40_000), 'utf8'), 40_000);
  assert.ok(Buffer.byteLength(escapedEnvelopeLimit.envelope, 'utf8') > 70 * 1024);
  assertInvalid(() => normalizeInstructionRecordV2Local(escapedEnvelopeLimit), 'invalid_instruction_record_v2');
});

test('rejects unknown fields, accessors, sparse arrays, foreign prototypes, and coercion objects', () => {
  const withExtraField = deliveryFor();
  withExtraField.unexpected = true;
  assertInvalid(() => normalizeDeliveryRecordV2Local(withExtraField), 'invalid_delivery_record_v2');

  let getterCalls = 0;
  const withAccessor = deliveryFor();
  Object.defineProperty(withAccessor, 'deliveryAttemptId', {
    enumerable: true,
    get() {
      getterCalls += 1;
      return 'never-read';
    },
  });
  assertInvalid(() => normalizeDeliveryRecordV2Local(withAccessor), 'invalid_delivery_record_v2');
  assert.equal(getterCalls, 0);

  const sparseLedger = ledgerFor(null);
  sparseLedger.deliveries = new Array(1);
  assertInvalid(() => normalizeDeliveryLedgerV2Local(sparseLedger), 'invalid_delivery_ledger_v2');

  const foreignPrototype = Object.create({ marker: true });
  Object.assign(foreignPrototype, deliveryFor());
  assertInvalid(() => normalizeDeliveryRecordV2Local(foreignPrototype), 'invalid_delivery_record_v2');

  let coercionCalls = 0;
  const hostileProvider = {
    toString() { coercionCalls += 1; throw new Error('toString invoked'); },
    [Symbol.toPrimitive]() { coercionCalls += 1; throw new Error('coercion invoked'); },
  };
  const hostile = deliveryFor();
  hostile.source.identity.provider = hostileProvider;
  assertInvalid(() => normalizeDeliveryRecordV2Local(hostile), 'invalid_delivery_record_v2');
  assert.equal(coercionCalls, 0);

  let specialGetterCalls = 0;
  const recordTypeAccessor = deliveryFor();
  Object.defineProperty(recordTypeAccessor, 'recordType', {
    enumerable: true,
    get() {
      specialGetterCalls += 1;
      return 'detail';
    },
  });
  assertInvalid(() => normalizeDeliveryRecordV2Local(recordTypeAccessor), 'invalid_delivery_record_v2');

  const checkpointSource = sourceFor('codex', 'deep-getter');
  const checkpointDelivery = deliveryFor({ source: checkpointSource, suffix: 'deep-getter' });
  const deepRegistrationAccessor = checkpointFor(checkpointDelivery, checkpointSource, { actor: false });
  Object.defineProperty(deepRegistrationAccessor.registrations.launches[0].claims, 'launchId', {
    enumerable: true,
    get() {
      specialGetterCalls += 1;
      return 'never-read';
    },
  });
  assertInvalid(() => normalizeCheckpointV3Local(deepRegistrationAccessor), 'invalid_delivery_checkpoint_v3');

  const ownToJson = deliveryFor();
  Object.defineProperty(ownToJson, 'toJSON', {
    enumerable: false,
    get() {
      specialGetterCalls += 1;
      return () => { specialGetterCalls += 1; };
    },
  });
  assertInvalid(() => normalizeDeliveryRecordV2Local(ownToJson), 'invalid_delivery_record_v2');
  assert.equal(specialGetterCalls, 0);
});

test('all public normalizers and encoders reject hostile values without coercion', () => {
  let coercionCalls = 0;
  const hostileProvider = {
    toString() {
      coercionCalls += 1;
      throw new Error('toString invoked');
    },
    [Symbol.toPrimitive]() {
      coercionCalls += 1;
      throw new Error('coercion invoked');
    },
  };
  const detail = deliveryFor({ suffix: 'coercion-detail' });
  detail.source.identity.provider = hostileProvider;
  const ledgerDetail = deliveryFor({ suffix: 'coercion-ledger' });
  ledgerDetail.source.identity.provider = hostileProvider;
  const ledger = ledgerFor(ledgerDetail);
  const checkpointSource = sourceFor('codex', 'coercion-checkpoint');
  const checkpoint = checkpointFor(null, checkpointSource, { actor: false });
  checkpoint.registrations.conversations[0].identity.provider = hostileProvider;
  const instruction = instructionFor({ suffix: 'coercion-instruction' });
  instruction.source.identity.provider = hostileProvider;
  const journalInstruction = instructionFor({ suffix: 'coercion-journal' });
  journalInstruction.source.identity.provider = hostileProvider;
  const journal = instructionJournal([journalInstruction]);
  const cases = [
    [normalizeDeliveryRecordV2Local, detail, 'invalid_delivery_record_v2'],
    [normalizeDeliveryLedgerV2Local, ledger, 'invalid_delivery_record_v2'],
    [normalizeCheckpointV3Local, checkpoint, 'invalid_delivery_checkpoint_v3'],
    [normalizeInstructionRecordV2Local, instruction, 'invalid_instruction_record_v2'],
    [normalizeInstructionJournalV2Local, journal, 'invalid_instruction_record_v2'],
    [encodeDeliveryLedgerV2Local, ledger, 'invalid_delivery_record_v2'],
    [encodeCheckpointV3Local, checkpoint, 'invalid_delivery_checkpoint_v3'],
    [encodeInstructionJournalV2Local, journal, 'invalid_instruction_record_v2'],
  ];

  for (const [codec, input, code] of cases) assertInvalid(() => codec(input), code);
  assert.equal(coercionCalls, 0);
});

test('all public codecs ignore inherited toJSON accessors without invoking them', () => {
  const source = sourceFor('claude', 'tojson');
  const detail = deliveryFor({ source, suffix: 'tojson' });
  const ledger = ledgerFor(detail);
  const checkpoint = checkpointFor(detail, source, { actor: false });
  const instruction = instructionFor({ suffix: 'tojson-instruction' });
  const journal = instructionJournal([instruction]);
  const inputs = [detail, ledger, checkpoint, instruction, journal];
  const snapshots = inputs.map((value) => JSON.stringify(value));
  const baseline = [
    encodeDeliveryLedgerV2Local(ledger),
    encodeCheckpointV3Local(checkpoint),
    encodeInstructionJournalV2Local(journal),
  ];
  const priorObjectToJSON = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const priorArrayToJSON = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  let objectGetterCalls = 0;
  let arrayGetterCalls = 0;
  let encoded;

  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get() {
        objectGetterCalls += 1;
        throw new Error('inherited object toJSON invoked');
      },
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      get() {
        arrayGetterCalls += 1;
        throw new Error('inherited array toJSON invoked');
      },
    });

    normalizeDeliveryRecordV2Local(detail);
    normalizeDeliveryLedgerV2Local(ledger);
    normalizeCheckpointV3Local(checkpoint);
    normalizeInstructionRecordV2Local(instruction);
    normalizeInstructionJournalV2Local(journal);
    encoded = [
      encodeDeliveryLedgerV2Local(ledger),
      encodeCheckpointV3Local(checkpoint),
      encodeInstructionJournalV2Local(journal),
    ];
  } finally {
    if (priorObjectToJSON === undefined) delete Object.prototype.toJSON;
    else Object.defineProperty(Object.prototype, 'toJSON', priorObjectToJSON);
    if (priorArrayToJSON === undefined) delete Array.prototype.toJSON;
    else Object.defineProperty(Array.prototype, 'toJSON', priorArrayToJSON);
  }

  assert.equal(objectGetterCalls, 0);
  assert.equal(arrayGetterCalls, 0);
  assert.deepEqual(inputs.map((value) => JSON.stringify(value)), snapshots);
  for (let index = 0; index < baseline.length; index += 1) {
    assert.ok(encoded[index].bytes.equals(baseline[index].bytes));
    assert.equal(encoded[index].sizeBytes, baseline[index].sizeBytes);
    assert.equal(encoded[index].sha256, baseline[index].sha256);
  }
});

test('round-trips a maximum-length correlation identifier with a lone surrogate', () => {
  const detail = deliveryFor({ state: 'applied', suffix: 'max-correlation' });
  const correlationId = '\ud800'.repeat(512);
  detail.appliedCorrelation.nativeTurnId = correlationId;
  detail.appliedCorrelation.nativeItemId = correlationId;
  const ledger = ledgerFor(detail);
  const before = JSON.stringify(ledger);
  const encoded = encodeDeliveryLedgerV2Local(ledger);
  const decoded = decodeSourceBytes(encoded.bytes, encoded.sizeBytes);
  const normalized = normalizeDeliveryLedgerV2Local(decoded.value);

  assert.equal(normalized.deliveries[0].appliedCorrelation.nativeTurnId, correlationId);
  assert.equal(normalized.deliveries[0].appliedCorrelation.nativeItemId, correlationId);
  assert.equal(JSON.stringify(ledger), before);
});

test('encodes canonical UTF-8 bytes and leaves caller inputs unchanged', () => {
  const source = sourceFor('codex', 'encoding');
  const ledger = ledgerFor(deliveryFor({ source, suffix: 'encoding' }));
  const checkpoint = checkpointFor(ledger.deliveries[0], source, { actor: false });
  const instruction = instructionFor({ suffix: 'encoding-instruction' });
  const journal = instructionJournal([instruction]);
  const values = [
    [ledger, () => encodeDeliveryLedgerV2Local(ledger)],
    [checkpoint, () => encodeCheckpointV3Local(checkpoint)],
    [journal, () => encodeInstructionJournalV2Local(journal)],
  ];

  for (const [input, encode] of values) {
    const before = JSON.stringify(input);
    const encoded = encode();
    assert.equal(JSON.stringify(input), before);
    assert.equal(encoded.sizeBytes, encoded.bytes.length);
    assert.equal(encoded.sha256, createHash('sha256').update(encoded.bytes).digest('hex'));
    assert.equal(encoded.bytes.at(-1), 0x0a);
    const parsed = JSON.parse(encoded.bytes.toString('utf8'));
    assert.deepEqual(parsed, JSON.parse(before));
  }
});

test('encoders use canonical field order when input property order differs', () => {
  const emptyLedger = {
    schemaVersion: 2,
    revision: 1,
    deliveries: [],
    notificationTargets: [],
    logicalTombstones: [],
  };
  const registrations = {
    conversations: [],
    executions: [],
    launches: [],
    runtimeLaunches: [],
    connections: [],
    actors: [],
    handoffs: [],
    replayClaims: [],
    incompleteConversationIds: [],
  };
  const emptyCheckpoint = {
    schemaVersion: 3,
    storeId: UUID_A,
    revision: 1,
    registrations,
    ledger: emptyLedger,
    migrationAllowance: null,
  };
  const emptyJournal = {
    schemaVersion: 2,
    revision: 1,
    storeId: UUID_A,
    migrationAllowance: null,
    instructions: [],
  };
  const vectors = [
    [emptyLedger, encodeDeliveryLedgerV2Local],
    [emptyCheckpoint, encodeCheckpointV3Local],
    [emptyJournal, encodeInstructionJournalV2Local],
  ];

  for (const [canonicalValue, encode] of vectors) {
    const input = reverseProperties(canonicalValue);
    const before = JSON.stringify(input);
    const expectedBytes = Buffer.from(`${JSON.stringify(canonicalValue, null, 2)}\n`, 'utf8');
    const encoded = encode(input);
    assert.ok(encoded.bytes.equals(expectedBytes));
    assert.equal(encoded.sizeBytes, expectedBytes.length);
    assert.equal(encoded.sha256, createHash('sha256').update(expectedBytes).digest('hex'));
    assert.equal(JSON.stringify(input), before);
  }
});
