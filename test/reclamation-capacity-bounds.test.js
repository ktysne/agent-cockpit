'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const {
  MAX_LATE_ANSWERS,
  createQuestionRecord,
  normalizeQuestionRecord,
  selectionFor,
  sha256Json,
} = require('../src/server/common-question-kernel');
const {
  createDelivery,
  createEmptyLedger,
  transitionDelivery,
} = require('../src/server/delivery-ledger');
const { makeEmptyCheckpoint } = require('../src/server/durable-checkpoint');
const {
  encodeQuestionJournalV2Local,
  normalizeQuestionDetailV2,
  normalizeQuestionJournalV2Local,
} = require('../src/server/common-question-reclamation-codec');
const {
  encodeCheckpointV3Local,
  encodeInstructionJournalV2Local,
  normalizeDeliveryRecordV2Local,
  normalizeInstructionJournalV2Local,
  normalizeInstructionRecordV2Local,
} = require('../src/server/delivery-reclamation-codec');
const { encodeNormalized } = require('../src/server/reclamation-json-codec');
const {
  FIXED_ANCHOR_MIGRATION_BOUNDS,
  FIXED_H_BOUNDS,
  MAX_ESCAPED_IDENTIFIER,
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
  canClearMigrationAllowance,
  checkedCapacityAdd,
  computePhysicalReclamationBounds,
  measureCheckpointReservation,
  measureInstructionReservation,
  measureMigrationAllowance,
  measureNewQuestionCandidateCapacity,
  measurePendingQuestionPeriodCapacity,
  measureQuestionJournalReservationBytes,
  migrationTargetRevision,
} = require('../src/server/reclamation-capacity-bounds');
const {
  createEmptyQuestionJournalV2TargetLocal,
  projectLegacyCheckpointV2Local,
  projectLegacyQuestionJournalV1Local,
  projectLegacyReclamationMigrationLocal,
} = require('../src/server/reclamation-migration-projection');
const { encodeQuestionReclamationAnchorV1Local } = require('../src/server/question-reclamation-anchor-codec');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const STARTED_AT = 1_000_000;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const TERMINAL_RETENTION_MS = 604_800_000;
const UNICODE = '😀';

function makeQuestionRecord({
  internalQuestionId = 'internal-question-1',
  text = 'Choose an option',
  largestUnicodeShape = false,
  recordIndex = 0,
} = {}) {
  const longIdentifier = largestUnicodeShape
    ? `${UNICODE.repeat(252)}${String(recordIndex).padStart(8, '0')}` : null;
  const optionIds = Array.from({ length: largestUnicodeShape ? 6 : 1 }, (_, index) =>
    largestUnicodeShape ? `${UNICODE.repeat(255)}${String.fromCharCode(97 + index)}x` : `option-${index + 1}`);
  const questionCount = largestUnicodeShape ? 4 : 1;
  const questions = Array.from({ length: questionCount }, (_, questionIndex) => ({
    id: `question-${questionIndex + 1}`,
    text: largestUnicodeShape ? `${UNICODE.repeat(1_000)}` : text,
    mode: largestUnicodeShape ? 'multi' : 'single',
    options: optionIds.map((id, optionIndex) => ({
      id,
      label: largestUnicodeShape ? UNICODE.repeat(100) : `Option ${optionIndex + 1}`,
      description: largestUnicodeShape ? UNICODE.repeat(1_000) : '',
    })),
    allowFreeText: true,
    recommendedOptionId: largestUnicodeShape ? null : optionIds[0],
  }));
  const identityValue = largestUnicodeShape ? longIdentifier : 'native-question-1';
  return createQuestionRecord({
    internalQuestionId,
    questionId: largestUnicodeShape ? longIdentifier : 'public-question-1',
    identity: {
      provider: 'claude',
      nativeIdKind: 'session',
      hostId: largestUnicodeShape ? longIdentifier : 'host-1',
      homeScopeId: largestUnicodeShape ? longIdentifier : 'home-1',
      nativeId: identityValue,
    },
    periodId: largestUnicodeShape ? longIdentifier : 'period-1',
    executionId: largestUnicodeShape ? longIdentifier : 'execution-1',
    conversationId: largestUnicodeShape ? longIdentifier : 'conversation-1',
    launchRef: largestUnicodeShape ? longIdentifier : 'launch-1',
    executionBinding: {
      periodId: largestUnicodeShape ? longIdentifier : 'period-1',
      actor: { kind: 'agent', id: largestUnicodeShape ? longIdentifier : 'actor-1' },
    },
    category: 'ordinary',
    questions,
    timeoutMinutes: 5,
    createdAt: 10_000,
  });
}

function sourceBytes(value) {
  return Buffer.from(JSON.stringify(value), 'utf8');
}

function anchorWith({ revision = 0, retiredQuestionPeriods = [] } = {}) {
  return {
    schemaVersion: 1,
    revision,
    storeId: STORE_ID,
    retiredQuestionPeriods,
    migration: null,
  };
}

function period(index, identitySuffix = 'one') {
  return {
    identity: {
      provider: 'claude',
      nativeIdKind: 'session',
      hostId: 'host-period',
      homeScopeId: 'home-period',
      nativeId: `native-${identitySuffix}-${index}`,
    },
    periodId: `period-${index}`,
  };
}

function projectQuestionBytes(bytes, migrationAllowance = null) {
  return projectLegacyReclamationMigrationLocal({
    configuredSlots: ['questions'],
    sourceBytesBySlot: { questions: bytes },
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowanceBySlot: { questions: migrationAllowance },
  });
}

function instructionLaunch() {
  return {
    launchRef: 'launch-1',
    launchId: 'launch-id',
    runId: 'run-id',
    attemptId: 'attempt-id',
    provider: 'claude',
    nativeIdKind: 'session',
    hostId: 'host-1',
    homeScopeId: 'home-1',
    origin: 'standalone',
    purpose: 'agent',
    originBinding: null,
    state: 'bound',
    identity: {
      provider: 'claude',
      nativeIdKind: 'session',
      hostId: 'host-1',
      homeScopeId: 'home-1',
      nativeId: 'native-1',
    },
    executionBinding: { periodId: 'period-1', actor: { kind: 'agent', id: 'actor-1' } },
    conversationId: 'conversation-1',
    sessionId: 'session-1',
    currentOwner: { periodId: 'period-1', actor: { kind: 'agent', id: 'actor-1' } },
    ownerGeneration: 0,
  };
}

function legacyAppliedCheckpoint(acceptedKind) {
  let ledger = createDelivery(createEmptyLedger(), 'instruction', {
    deliveryAttemptId: 'attempt-1',
    logicalMessageId: 'logical-1',
    revision: 1,
    payload: 'instruction payload',
  }, instructionLaunch()).ledger;
  const delivery = ledger.deliveries[0];
  const appliedCorrelation = {
    deliveryAttemptId: delivery.deliveryAttemptId,
    revision: delivery.revision,
    payloadDigest: delivery.payloadDigest,
    targetPeriodId: delivery.target.periodId,
    nativeTurnId: 'turn-long',
    nativeItemId: `${'\uD800'.repeat(511)}\uDBFF`,
    clientRequestId: delivery.deliveryAttemptId,
  };
  ledger = transitionDelivery(ledger, delivery.deliveryAttemptId, 'sendStart').ledger;
  if (acceptedKind !== 'none') {
    const acceptedCorrelation = acceptedKind === 'complete'
      ? appliedCorrelation
      : { ...appliedCorrelation, nativeItemId: null };
    ledger = transitionDelivery(ledger, delivery.deliveryAttemptId, 'accepted', acceptedCorrelation).ledger;
  }
  ledger = transitionDelivery(ledger, delivery.deliveryAttemptId, 'applied', appliedCorrelation).ledger;
  const checkpoint = structuredClone(makeEmptyCheckpoint());
  checkpoint.schemaVersion = 2;
  checkpoint.ledger = ledger;
  const launch = instructionLaunch();
  const claims = {
    launchId: launch.launchId,
    runId: launch.runId,
    attemptId: launch.attemptId,
    provider: launch.provider,
    nativeIdKind: launch.nativeIdKind,
    hostId: launch.hostId,
    homeScopeId: launch.homeScopeId,
    origin: launch.origin,
    purpose: launch.purpose,
    originBinding: launch.originBinding,
  };
  const immutableExecutionClaims = {
    ...claims,
    identity: launch.identity,
    executionBinding: launch.executionBinding,
  };
  const scope = {
    provider: launch.provider,
    nativeIdKind: launch.nativeIdKind,
    hostId: launch.hostId,
    homeScopeId: launch.homeScopeId,
    connectionSlotId: 'source-slot',
  };
  checkpoint.registrations.conversations = [{
    conversationId: launch.conversationId,
    identity: launch.identity,
  }];
  checkpoint.registrations.executions = [{
    conversationId: launch.conversationId,
    executionId: launch.executionBinding.periodId,
    sessionId: launch.sessionId,
    state: 'active',
  }];
  checkpoint.registrations.launches = [{
    launchRef: launch.launchRef,
    claims,
    state: 'bound',
    identity: launch.identity,
    executionBinding: launch.executionBinding,
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
  }];
  checkpoint.registrations.runtimeLaunches = [{
    launchRef: launch.launchRef,
    claims: immutableExecutionClaims,
    state: 'bound',
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
    currentOwner: launch.executionBinding,
    ownerGeneration: 0,
  }];
  checkpoint.registrations.connections = [{ scope, generation: 1, state: 'active' }];
  checkpoint.registrations.actors = [{
    identity: launch.identity,
    periodId: launch.executionBinding.periodId,
    actor: launch.executionBinding.actor,
    contextId: 'source-context',
    launchRef: launch.launchRef,
    immutableExecutionClaims,
    connectionScope: scope,
    connectionGeneration: 1,
    state: 'active',
  }];
  checkpoint.registrations.incompleteConversationIds = [launch.conversationId];
  return checkpoint;
}

function availableQuestionCheckpoint() {
  const checkpoint = structuredClone(legacyAppliedCheckpoint('none'));
  const delivery = checkpoint.ledger.deliveries[0];
  delivery.kind = 'question';
  delivery.state = 'available';
  delivery.cancelRequested = false;
  delivery.acceptedCorrelation = null;
  delivery.appliedCorrelation = null;
  checkpoint.ledger.logicalTombstones[0].kind = 'question';
  return checkpoint;
}

function questionGraveFromDetail(detail, operationId) {
  const digest = (value) => createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
  const { source, target } = detail;
  const launchKey = [source.claims.launchId, source.claims.runId, source.claims.attemptId];
  return normalizeDeliveryRecordV2Local({
    recordType: 'reclaimed',
    deliveryAttemptId: detail.deliveryAttemptId,
    kind: detail.kind,
    logicalMessageId: detail.logicalMessageId,
    revision: detail.revision,
    sourceExecutionId: detail.sourceExecutionId,
    payloadDigest: detail.payloadDigest,
    state: detail.state,
    terminalAt: detail.terminalAt,
    cancelRequested: detail.cancelRequested,
    ownerGeneration: detail.ownerGeneration,
    acceptedCorrelation: detail.acceptedCorrelation,
    appliedCorrelation: detail.appliedCorrelation,
    sourceRef: {
      launchRef: source.launchRef,
      launchKey,
      sourceClaimsDigest: digest(source.claims),
      identity: source.identity,
      executionBinding: source.executionBinding,
      conversationId: source.conversationId,
      sessionId: source.sessionId,
    },
    targetRef: {
      kind: target.kind,
      launchRef: target.launchRef,
      launchKey,
      targetClaimsDigest: digest(target.claims),
      identity: target.identity,
      periodId: target.periodId,
      actor: target.actor,
      conversationId: target.conversationId,
      sessionId: target.sessionId,
    },
    reclamation: {
      operationId,
      reclaimedAt: MAX_SAFE_INTEGER,
      reason: 'retired_question_period',
    },
  });
}

function futureAppliedQuestionFromDetail(detail) {
  const correlation = {
    deliveryAttemptId: detail.deliveryAttemptId,
    revision: detail.revision,
    payloadDigest: detail.payloadDigest,
    targetPeriodId: detail.target.periodId,
    nativeTurnId: MAX_ESCAPED_IDENTIFIER,
    nativeItemId: MAX_ESCAPED_IDENTIFIER,
    clientRequestId: detail.deliveryAttemptId,
  };
  return normalizeDeliveryRecordV2Local({
    ...detail,
    state: 'applied',
    terminalAt: MAX_SAFE_INTEGER,
    acceptedCorrelation: correlation,
    appliedCorrelation: correlation,
  });
}

function checkpointRecordBytes(record) {
  return encodeNormalized({ ledger: { deliveries: [record] } }).sizeBytes;
}

function instructionSource() {
  const launch = instructionLaunch();
  return {
    launchRef: launch.launchRef,
    claims: {
      launchId: launch.launchId,
      runId: launch.runId,
      attemptId: launch.attemptId,
      provider: launch.provider,
      nativeIdKind: launch.nativeIdKind,
      hostId: launch.hostId,
      homeScopeId: launch.homeScopeId,
      origin: launch.origin,
      purpose: launch.purpose,
      originBinding: launch.originBinding,
    },
    identity: launch.identity,
    executionBinding: launch.executionBinding,
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
  };
}

function instructionRecordWithState(deliveryCreationState) {
  const input = [{ type: 'text', text: 'capacity instruction', text_elements: [] }];
  const envelope = JSON.stringify({
    schemaVersion: 1,
    mode: 'start',
    expectedTurnId: null,
    input,
  });
  const digest = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
  return normalizeInstructionRecordV2Local({
    recordType: 'detail',
    deliveryAttemptId: 'capacity-instruction-attempt',
    launchRef: instructionLaunch().launchRef,
    logicalMessageId: 'capacity-instruction-logical',
    revision: 1,
    source: instructionSource(),
    envelope,
    envelopeDigest: digest(envelope),
    nativeContentDigest: digest(JSON.stringify(input)),
    createdAt: STARTED_AT,
    deliveryCreationState,
    reclamation: null,
  });
}

function instructionJournalWith(record) {
  return normalizeInstructionJournalV2Local({
    schemaVersion: 2,
    revision: 1,
    storeId: STORE_ID,
    migrationAllowance: null,
    instructions: [record],
  });
}

function checkpointRecordWithMaximumIdentity(record) {
  const longId = MAX_ESCAPED_IDENTIFIER;
  const source = {
    ...record.source,
    launchRef: longId,
    claims: { ...record.source.claims, hostId: longId, homeScopeId: longId },
    identity: {
      ...record.source.identity,
      hostId: longId,
      homeScopeId: longId,
      nativeId: longId,
    },
    executionBinding: {
      periodId: longId,
      actor: { ...record.source.executionBinding.actor, id: longId },
    },
    conversationId: longId,
    sessionId: longId,
  };
  const target = {
    ...record.target,
    launchRef: longId,
    claims: source.claims,
    identity: source.identity,
    periodId: longId,
    actor: source.executionBinding.actor,
    conversationId: longId,
    sessionId: longId,
  };
  return normalizeDeliveryRecordV2Local({
    ...record,
    logicalMessageId: longId,
    sourceExecutionId: longId,
    source,
    target,
  });
}

function activeQuestionJournalWithCreatingIntent() {
  const initial = makeQuestionRecord();
  const answers = [{ questionId: 'question-1', optionIds: ['option-1'], freeText: null }];
  const selected = selectionFor(initial, answers, 'manual', initial.createdAt + 1, 'capacity').record;
  const digest = sha256Json(answers);
  const source = normalizeQuestionRecord({
    ...selected,
    lateAnswers: Array.from({ length: MAX_LATE_ANSWERS }, () => ({
      submittedAt: initial.createdAt + 2,
      digest,
      answers,
    })),
  });
  const projected = projectLegacyQuestionJournalV1Local({
    sourceBytes: sourceBytes({ schemaVersion: 1, revision: 7, questions: [source] }),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    checkpointSnapshot: null,
    migrationAllowance: null,
  });
  const snapshot = structuredClone(projected.snapshot);
  const detail = snapshot.questions[0];
  detail.quarantinedAt = null;
  detail.deliveryCreationState = 'creating';
  const reservation = snapshot.reservations[0];
  reservation.quarantinedAt = null;
  reservation.deliveryCreationState = 'creating';
  reservation.checkpointState = null;
  reservation.sourceClaimsDigest = null;
  reservation.sessionId = null;
  reservation.terminalResultKind = null;
  return normalizeQuestionJournalV2Local(snapshot);
}

test('fixed migration and future-reservation bounds match the encoded skeletons and analytic constants', () => {
  assert.deepEqual(FIXED_ANCHOR_MIGRATION_BOUNDS, {
    kQuestionBytes: 608,
    kRetiredPeriodBytes: 279,
    kManifestBytes: 1_752,
    migrationBytes: 34_518_968,
    migrationAnchorMaxBytes: 51_296_184,
  });
  assert.deepEqual(FIXED_H_BOUNDS, {
    questions: 385_153_133,
    checkpoint: 856_167_505,
    instructions: 258_958_681,
  });
  assert.equal(MAX_ESCAPED_IDENTIFIER.length, 512);
  assert.equal(Buffer.byteLength(JSON.stringify(MAX_ESCAPED_IDENTIFIER), 'utf8'), 3_074);
  assert.throws(() => checkedCapacityAdd(MAX_SAFE_INTEGER, 1), RangeError);
  assert.equal(migrationTargetRevision(false, null), 0);
  assert.equal(migrationTargetRevision(true, 7), 8);
  assert.throws(() => migrationTargetRevision(true, MAX_SAFE_INTEGER), RangeError);
});

test('physical copy bounds combine source, fixed H, anchor, and migration allowance limits', () => {
  const result = computePhysicalReclamationBounds({
    anchorByteLimit: NORMAL_ANCHOR_MAX_BYTES,
    slots: [
      { slot: 'questions', sourceSizeBytes: 100, normalByteLimit: 200, grantBytes: 300 },
      { slot: 'instructions', sourceSizeBytes: 400, normalByteLimit: 500, grantBytes: 600 },
    ],
  });
  assert.equal(result.firstMigrationPeakBytes,
    2 * FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes +
      2 * 100 + FIXED_H_BOUNDS.questions + 2 * 400 + FIXED_H_BOUNDS.instructions);
  assert.equal(result.firstMigrationReservationBytes,
    FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes + 100 + FIXED_H_BOUNDS.questions +
      400 + FIXED_H_BOUNDS.instructions);
  assert.equal(result.postMigrationPeakBytes,
    2 * NORMAL_ANCHOR_MAX_BYTES + 2 * (200 + 300) + 2 * (500 + 600));
  assert.equal(result.postMigrationReservationBytes,
    NORMAL_ANCHOR_MAX_BYTES + 200 + 300 + 500 + 600);

  let coercions = 0;
  const hostileSlot = {};
  Object.defineProperty(hostileSlot, 'toString', {
    get() { coercions += 1; throw new Error('coercion must not run'); },
  });
  assert.throws(() => computePhysicalReclamationBounds({
    anchorByteLimit: NORMAL_ANCHOR_MAX_BYTES,
    slots: [{ slot: hostileSlot, sourceSizeBytes: 0, normalByteLimit: 1, grantBytes: 0 }],
  }), TypeError);
  assert.equal(coercions, 0);
});

test('pending period reservation deduplicates the complete identity-period key and reserves maximum root revision digits', () => {
  const first = period(1, 'a');
  const samePeriodDifferentIdentity = period(1, 'b');
  const emptyAnchor = anchorWith();
  const deduplicated = measurePendingQuestionPeriodCapacity(emptyAnchor,
    [first, first, samePeriodDifferentIdentity]);
  assert.equal(deduplicated.pendingCount, 2);
  assert.equal(deduplicated.projectedCount, 2);
  assert.ok(deduplicated.pendingBytes > deduplicated.revisionGrowthBytes);

  const noPending = measurePendingQuestionPeriodCapacity(emptyAnchor, []);
  assert.equal(noPending.pendingCount, 0);
  assert.equal(noPending.pendingBytes, noPending.revisionGrowthBytes);
  assert.ok(noPending.revisionGrowthBytes > 0);
  assert.ok(noPending.projectedBytes > noPending.currentBytes);

  const retired = {
    ...first,
    retiredAt: 10,
    reason: 'confirmed-retirement',
  };
  assert.equal(measurePendingQuestionPeriodCapacity(anchorWith({ retiredQuestionPeriods: [retired] }),
    [first]).pendingCount, 0);
});

test('period count accepts 20,000 distinct identities and rejects one additional unretired period', () => {
  const twentyThousand = Array.from({ length: 20_000 }, (_, index) => period(index));
  const atLimit = measurePendingQuestionPeriodCapacity(anchorWith(), twentyThousand);
  assert.equal(atLimit.pendingCount, 20_000);
  assert.equal(atLimit.projectedCount, 20_000);

  const retiredQuestionPeriods = twentyThousand.map(({ identity, periodId }) => ({
    identity,
    periodId,
    retiredAt: 10,
    reason: 'confirmed-retirement',
  }));
  const overLimit = measurePendingQuestionPeriodCapacity(anchorWith({ retiredQuestionPeriods }),
    [period(20_001)]);
  assert.equal(overLimit.projectedCount, 20_001);
  assert.equal(overLimit.projectedBytes, null);
  assert.equal(overLimit.fits, false);
  assert.equal(overLimit.reason, 'period_count_limit');
});

test('period reservation rejects root revision overflow before encoding a projected anchor', () => {
  const measurement = measurePendingQuestionPeriodCapacity(anchorWith({ revision: MAX_SAFE_INTEGER }), [period(1)]);
  assert.equal(measurement.fits, false);
  assert.equal(measurement.reason, 'revision_overflow');
  assert.equal(measurement.projectedBytes, null);
});

test('maximum legal Unicode question record receives a source-derived grant within fixed H', () => {
  const source = sourceBytes({ schemaVersion: 1, revision: 7, questions: [makeQuestionRecord({ largestUnicodeShape: true })] });
  const initial = projectQuestionBytes(source);
  const descriptor = initial.slots.questions.source;
  const maximumAllowance = {
    operationId: OPERATION_ID,
    sourceSchemaVersion: descriptor.schemaVersion,
    sourceSizeBytes: descriptor.sizeBytes,
    sourceSha256: descriptor.sha256,
    maxExtraBytes: MAX_SAFE_INTEGER,
    eligibleQuestionIds: initial.slots.questions.eligibleIds,
  };
  const maximum = projectQuestionBytes(source, maximumAllowance);
  const capacityInput = {
    slot: 'questions',
    sourcePresent: true,
    sourceSchemaVersion: descriptor.schemaVersion,
    sourceRevision: descriptor.revision,
    sourceSizeBytes: descriptor.sizeBytes,
    sourceSha256: descriptor.sha256,
    currentByteLimit: descriptor.sizeBytes,
    anchor: initial.anchor,
    eligibleIds: initial.slots.questions.eligibleIds,
    projections: {
      withoutGrant: initial.slots.questions.candidateSnapshotsByBoundary,
      withMaximumGrant: maximum.slots.questions.candidateSnapshotsByBoundary,
      questionCandidates: maximum.slots.questions.questionCandidates,
    },
  };
  const noGrantReserve = measureQuestionJournalReservationBytes({
    snapshot: initial.slots.questions.target.snapshot,
    questionCandidates: maximum.slots.questions.questionCandidates,
    currentByteLimit: MAX_SOURCE_BYTES,
  }).reservedBytes;
  const maximumGrantReserve = measureQuestionJournalReservationBytes({
    snapshot: maximum.slots.questions.target.snapshot,
    questionCandidates: maximum.slots.questions.questionCandidates,
    currentByteLimit: MAX_SOURCE_BYTES,
  }).reservedBytes;
  assert.ok(noGrantReserve > descriptor.sizeBytes && noGrantReserve <= MAX_SOURCE_BYTES);
  const grant = measureMigrationAllowance({ ...capacityInput, currentByteLimit: descriptor.sizeBytes });
  assert.ok(grant !== null);
  assert.ok(grant.maxExtraBytes > 0 && grant.maxExtraBytes <= FIXED_H_BOUNDS.questions);
  assert.equal(grant.maxExtraBytes, maximumGrantReserve - descriptor.sizeBytes);
  assert.deepEqual(grant.eligibleQuestionIds, ['internal-question-1']);

  const belowThreshold = measureMigrationAllowance({
    ...capacityInput,
    currentByteLimit: noGrantReserve - 1,
  });
  assert.deepEqual(belowThreshold, grant);
  assert.equal(measureMigrationAllowance({
    ...capacityInput,
    currentByteLimit: noGrantReserve,
  }), null);
  assert.equal(measureMigrationAllowance({
    ...capacityInput,
    currentByteLimit: MAX_SOURCE_BYTES,
  }), null);
  assert.throws(() => measureMigrationAllowance({
    ...capacityInput,
    currentByteLimit: descriptor.sizeBytes - 1,
  }), /migration_source_exceeds_current_limit/);

  const absent = measureMigrationAllowance({
    slot: 'questions',
    sourcePresent: false,
    sourceSchemaVersion: null,
    sourceRevision: null,
    sourceSizeBytes: 0,
    sourceSha256: null,
    currentByteLimit: MAX_SOURCE_BYTES,
    anchor: initial.anchor,
    eligibleIds: [],
    projections: { withoutGrant: {}, withMaximumGrant: {} },
  });
  assert.equal(absent, null);
});

test('compact near-limit source retains its exact fingerprint and receives a bounded grant', () => {
  const prefix = '{"schemaVersion":1,"revision":7,"questions":[';
  const suffix = ']}';
  const records = [];
  let compactBytes = Buffer.byteLength(prefix + suffix, 'utf8');
  let nextRecordBytes = null;
  for (let index = 0; index < 20_000; index += 1) {
    const encoded = JSON.stringify(makeQuestionRecord({
      internalQuestionId: `internal-question-${index}`,
      largestUnicodeShape: true,
      recordIndex: index,
    }));
    const addition = Buffer.byteLength(encoded, 'utf8') + (records.length === 0 ? 0 : 1);
    if (compactBytes + addition > MAX_SOURCE_BYTES) {
      nextRecordBytes = addition;
      break;
    }
    records.push(encoded);
    compactBytes += addition;
  }
  assert.ok(records.length > 1);
  assert.ok(nextRecordBytes !== null);
  const bytes = Buffer.from(`${prefix}${records.join(',')}${suffix}`, 'utf8');
  assert.equal(bytes.length, compactBytes);
  assert.ok(bytes.length > MAX_SOURCE_BYTES * 0.98);
  assert.ok(bytes.length + nextRecordBytes > MAX_SOURCE_BYTES);

  const projection = projectQuestionBytes(bytes);
  const source = projection.slots.questions.source;
  assert.equal(source.sizeBytes, bytes.length);
  assert.equal(source.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.equal(projection.slots.questions.target.snapshot.questions.length, records.length);

  const maximumAllowance = {
    operationId: OPERATION_ID,
    sourceSchemaVersion: source.schemaVersion,
    sourceSizeBytes: source.sizeBytes,
    sourceSha256: source.sha256,
    maxExtraBytes: MAX_SAFE_INTEGER,
    eligibleQuestionIds: projection.slots.questions.eligibleIds,
  };
  const maximumProjection = projectQuestionBytes(bytes, maximumAllowance);
  const maximumReserve = measureQuestionJournalReservationBytes({
    snapshot: maximumProjection.slots.questions.target.snapshot,
    questionCandidates: maximumProjection.slots.questions.questionCandidates,
    currentByteLimit: MAX_SOURCE_BYTES,
  }).reservedBytes;
  const grant = measureMigrationAllowance({
    slot: 'questions',
    sourcePresent: true,
    sourceSchemaVersion: source.schemaVersion,
    sourceRevision: source.revision,
    sourceSizeBytes: source.sizeBytes,
    sourceSha256: source.sha256,
    currentByteLimit: source.sizeBytes,
    anchor: projection.anchor,
    eligibleIds: projection.slots.questions.eligibleIds,
    projections: {
      withoutGrant: projection.slots.questions.candidateSnapshotsByBoundary,
      withMaximumGrant: maximumProjection.slots.questions.candidateSnapshotsByBoundary,
      questionCandidates: maximumProjection.slots.questions.questionCandidates,
    },
  });
  assert.ok(grant !== null);
  assert.equal(grant.maxExtraBytes, maximumReserve - source.sizeBytes);
  assert.ok(grant.maxExtraBytes <= FIXED_H_BOUNDS.questions);
});

test('unselected question at MAX_SAFE revision still reserves late-answer growth and rejects caller under-reservation', () => {
  const projection = projectLegacyQuestionJournalV1Local({
    sourceBytes: sourceBytes({ schemaVersion: 1, revision: 7, questions: [makeQuestionRecord()] }),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    checkpointSnapshot: null,
    migrationAllowance: null,
  });
  const snapshot = structuredClone(projection.snapshot);
  snapshot.revision = MAX_SAFE_INTEGER;
  snapshot.questions[0].quarantinedAt = null;
  snapshot.questions[0].revision = MAX_SAFE_INTEGER;
  snapshot.reservations[0].quarantinedAt = null;
  snapshot.reservations[0].revision = MAX_SAFE_INTEGER;
  const normalized = normalizeQuestionJournalV2Local(snapshot);
  const currentDetail = normalized.questions[0];
  const retainedReservation = normalized.reservations[0];
  const underReservedCandidates = [{
    internalQuestionId: currentDetail.internalQuestionId,
    currentDetail,
    maxFutureDetail: currentDetail,
    retainedReservation,
    preparedReservation: null,
    reclaimedReservation: null,
  }];
  assert.throws(() => measureQuestionJournalReservationBytes({
    snapshot: normalized,
    questionCandidates: underReservedCandidates,
    currentByteLimit: MAX_SOURCE_BYTES,
  }), TypeError);

  const measurement = measureQuestionJournalReservationBytes({
    snapshot: normalized,
    currentByteLimit: MAX_SOURCE_BYTES,
  });
  assert.ok(measurement.detailGrowthBytes > 0);
  assert.ok(measurement.reservationGrowthBytes > 0);
  const currentBytes = encodeQuestionJournalV2Local(normalized).sizeBytes;
  const clear = canClearMigrationAllowance({
    slot: 'questions',
    snapshotWithoutGrant: normalized,
    normalByteLimit: currentBytes,
  });
  assert.equal(clear.canClear, false);
  assert.ok(clear.reserveBytes > clear.limitBytes);
});

test('future question detail quarantines legally and preserves the frozen intent state', () => {
  const snapshot = activeQuestionJournalWithCreatingIntent();
  const currentDetail = snapshot.questions[0];
  const currentReservation = snapshot.reservations[0];
  const underReservedDetail = normalizeQuestionDetailV2({
    ...currentDetail,
    cancelledAt: MAX_SAFE_INTEGER,
    externalResolution: { resolvedAt: MAX_SAFE_INTEGER, evidenceDigest: 'f'.repeat(64) },
  });
  const row = {
    internalQuestionId: currentDetail.internalQuestionId,
    currentDetail,
    maxFutureDetail: underReservedDetail,
    retainedReservation: currentReservation,
    preparedReservation: null,
    reclaimedReservation: null,
  };
  assert.throws(() => measureQuestionJournalReservationBytes({
    snapshot,
    questionCandidates: [row],
    currentByteLimit: MAX_SOURCE_BYTES,
  }), TypeError);

  const futureDetail = normalizeQuestionDetailV2({
    ...underReservedDetail,
    deliveryCreationState: 'indeterminate',
    quarantinedAt: MAX_SAFE_INTEGER,
  });
  const measurement = measureQuestionJournalReservationBytes({
    snapshot,
    questionCandidates: [{ ...row, maxFutureDetail: futureDetail }],
    currentByteLimit: MAX_SOURCE_BYTES,
  });
  assert.ok(measurement.detailGrowthBytes > 0);

  const unselected = projectLegacyQuestionJournalV1Local({
    sourceBytes: sourceBytes({ schemaVersion: 1, revision: 0, questions: [makeQuestionRecord()] }),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    checkpointSnapshot: null,
    migrationAllowance: null,
  }).snapshot.questions[0];
  assert.equal(unselected.deliveryIntent, null);
  assert.throws(() => normalizeQuestionDetailV2({
    ...unselected,
    deliveryCreationState: 'indeterminate',
  }), TypeError);

  const alreadyQuarantined = structuredClone(snapshot);
  alreadyQuarantined.questions[0].quarantinedAt = STARTED_AT;
  alreadyQuarantined.questions[0].deliveryCreationState = 'indeterminate';
  alreadyQuarantined.reservations[0].quarantinedAt = STARTED_AT;
  alreadyQuarantined.reservations[0].deliveryCreationState = 'indeterminate';
  alreadyQuarantined.reservations[0].checkpointState = 'unknown';
  const frozen = measureQuestionJournalReservationBytes({
    snapshot: normalizeQuestionJournalV2Local(alreadyQuarantined),
    currentByteLimit: MAX_SOURCE_BYTES,
  });
  assert.equal(frozen.detailGrowthBytes, 0);
});

test('new question admission uses internally derived reservation rows when candidates are omitted', () => {
  const current = createEmptyQuestionJournalV2TargetLocal({ storeId: STORE_ID });
  const projected = projectLegacyQuestionJournalV1Local({
    sourceBytes: sourceBytes({ schemaVersion: 1, revision: 0, questions: [makeQuestionRecord()] }),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    checkpointSnapshot: null,
    migrationAllowance: null,
  });
  const measurement = measureNewQuestionCandidateCapacity({
    currentSnapshot: current.snapshot,
    candidateSnapshot: projected.snapshot,
    newInternalQuestionId: 'internal-question-1',
    currentByteLimit: projected.encoded.sizeBytes,
  });
  assert.equal(measurement.accepted, false);
  assert.ok(measurement.reservedBytes > measurement.currentByteLimit);
});

test('checkpoint reserve deduplicates complete, nullable, and absent accepted correlations safely', () => {
  for (const acceptedKind of ['complete', 'partial', 'none']) {
    const raw = legacyAppliedCheckpoint(acceptedKind);
    const projection = projectLegacyCheckpointV2Local({
      sourceBytes: sourceBytes(raw),
      storeId: STORE_ID,
      operationId: OPERATION_ID,
      startedAt: STARTED_AT,
      migrationAllowance: null,
    });
    const row = projection.deliveryCandidates[0];
    const current = row.candidates.find(({ variant }) => variant === 'current').record;
    const future = row.candidates.find(({ variant }) => variant === 'maxFutureDetail').record;
    assert.equal(current.cancelRequested, false);
    assert.equal(future.cancelRequested, false);
    const clear = canClearMigrationAllowance({
      slot: 'checkpoint',
      snapshotWithoutGrant: projection.snapshot,
      normalByteLimit: MAX_SOURCE_BYTES,
    });
    assert.equal(clear.canClear, true);
    if (acceptedKind === 'partial') {
      assert.equal(current.acceptedCorrelation.nativeItemId, null);
      assert.equal(future.acceptedCorrelation.nativeItemId, current.appliedCorrelation.nativeItemId);
      const expanded = structuredClone(projection.snapshot);
      expanded.ledger.deliveries[0] = future;
      assert.ok(encodeCheckpointV3Local(expanded).sizeBytes > projection.encoded.sizeBytes);
    }

    const noGrant = projectLegacyReclamationMigrationLocal({
      configuredSlots: ['checkpoint'],
      sourceBytesBySlot: { checkpoint: sourceBytes(raw) },
      storeId: STORE_ID,
      operationId: OPERATION_ID,
      startedAt: STARTED_AT,
      migrationAllowanceBySlot: { checkpoint: null },
    });
    const sourceDescriptor = noGrant.slots.checkpoint.source;
    const provisionalGrant = {
      operationId: OPERATION_ID,
      sourceSchemaVersion: sourceDescriptor.schemaVersion,
      sourceSizeBytes: sourceDescriptor.sizeBytes,
      sourceSha256: sourceDescriptor.sha256,
      maxExtraBytes: MAX_SAFE_INTEGER,
      eligibleAttemptIds: noGrant.slots.checkpoint.eligibleIds,
    };
    const withMaximumGrant = projectLegacyReclamationMigrationLocal({
      configuredSlots: ['checkpoint'],
      sourceBytesBySlot: { checkpoint: sourceBytes(raw) },
      storeId: STORE_ID,
      operationId: OPERATION_ID,
      startedAt: STARTED_AT,
      migrationAllowanceBySlot: { checkpoint: provisionalGrant },
    });
    const grant = measureMigrationAllowance({
      slot: 'checkpoint',
      sourcePresent: true,
      sourceSchemaVersion: sourceDescriptor.schemaVersion,
      sourceRevision: sourceDescriptor.revision,
      sourceSizeBytes: sourceDescriptor.sizeBytes,
      sourceSha256: sourceDescriptor.sha256,
      currentByteLimit: sourceDescriptor.sizeBytes,
      anchor: noGrant.anchor,
      eligibleIds: noGrant.slots.checkpoint.eligibleIds,
      projections: {
        withoutGrant: noGrant.slots.checkpoint.candidateSnapshotsByBoundary,
        withMaximumGrant: withMaximumGrant.slots.checkpoint.candidateSnapshotsByBoundary,
        deliveryCandidates: withMaximumGrant.slots.checkpoint.deliveryCandidates,
      },
    });
    assert.ok(grant !== null);
    assert.ok(grant.maxExtraBytes > 0 && grant.maxExtraBytes <= FIXED_H_BOUNDS.checkpoint);
  }
});

test('active question checkpoint reserve covers future correlation and terminal growth at the current byte limit', () => {
  const raw = availableQuestionCheckpoint();
  const projection = projectLegacyCheckpointV2Local({
    sourceBytes: sourceBytes(raw),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowance: null,
  });
  const current = projection.snapshot.ledger.deliveries[0];
  assert.equal(current.kind, 'question');
  assert.equal(current.state, 'available');
  const measurement = measureCheckpointReservation({
    snapshot: projection.snapshot,
    currentByteLimit: MAX_SOURCE_BYTES,
  }, OPERATION_ID);
  assert.ok(measurement.detailGrowthBytes > 3_000);
  const currentBytes = encodeCheckpointV3Local(projection.snapshot).sizeBytes;
  const clear = canClearMigrationAllowance({
    slot: 'checkpoint',
    snapshotWithoutGrant: projection.snapshot,
    normalByteLimit: currentBytes,
  });
  assert.equal(clear.canClear, false);
  assert.ok(clear.reserveBytes > currentBytes);
});

test('question checkpoint reserve includes max-correlation graves while preserving current correlations', () => {
  const projection = projectLegacyCheckpointV2Local({
    sourceBytes: sourceBytes(availableQuestionCheckpoint()),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowance: null,
  });
  const current = projection.snapshot.ledger.deliveries[0];
  const projectedFuture = futureAppliedQuestionFromDetail(current);
  const reclaimableFuture = normalizeDeliveryRecordV2Local({
    ...projectedFuture,
    terminalAt: MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS,
  });
  const sameStateGrave = questionGraveFromDetail(current, OPERATION_ID);
  const futureGrave = questionGraveFromDetail(reclaimableFuture, OPERATION_ID);
  assert.equal(sameStateGrave.acceptedCorrelation, null);
  assert.equal(sameStateGrave.appliedCorrelation, null);
  assert.deepEqual(futureGrave.acceptedCorrelation, projectedFuture.acceptedCorrelation);
  assert.deepEqual(futureGrave.appliedCorrelation, projectedFuture.appliedCorrelation);
  assert.ok(checkpointRecordBytes(futureGrave) > checkpointRecordBytes(sameStateGrave));

  const row = {
    deliveryAttemptId: current.deliveryAttemptId,
    candidates: [
      { variant: 'current', record: current },
      { variant: 'maxFutureDetail', record: projectedFuture },
      { variant: 'reclaimed', record: futureGrave },
    ],
  };
  const baseRecordBytes = checkpointRecordBytes(current);
  const expectedGrowth = Math.max(
    checkpointRecordBytes(projectedFuture),
    checkpointRecordBytes(sameStateGrave),
    checkpointRecordBytes(futureGrave),
  ) - baseRecordBytes;
  const explicit = measureCheckpointReservation({
    snapshot: projection.snapshot,
    deliveryCandidates: [row],
    currentByteLimit: MAX_SOURCE_BYTES,
  }, OPERATION_ID);
  const generated = measureCheckpointReservation({
    snapshot: projection.snapshot,
    currentByteLimit: MAX_SOURCE_BYTES,
  }, OPERATION_ID);
  assert.equal(explicit.detailGrowthBytes, expectedGrowth);
  assert.equal(generated.detailGrowthBytes, expectedGrowth);

  const appliedCurrent = normalizeDeliveryRecordV2Local({
    ...current,
    state: 'applied',
    terminalAt: STARTED_AT,
    acceptedCorrelation: { ...projectedFuture.appliedCorrelation, nativeItemId: null },
    appliedCorrelation: projectedFuture.appliedCorrelation,
  });
  const appliedSnapshot = structuredClone(projection.snapshot);
  appliedSnapshot.ledger.deliveries[0] = appliedCurrent;
  const appliedFuture = normalizeDeliveryRecordV2Local({
    ...appliedCurrent,
    acceptedCorrelation: {
      ...appliedCurrent.acceptedCorrelation,
      nativeItemId: appliedCurrent.appliedCorrelation.nativeItemId,
    },
  });
  const appliedCurrentGrave = questionGraveFromDetail(appliedCurrent, OPERATION_ID);
  const appliedFutureGrave = questionGraveFromDetail(appliedFuture, OPERATION_ID);
  assert.equal(appliedCurrentGrave.acceptedCorrelation.nativeItemId, null);
  assert.equal(appliedFutureGrave.acceptedCorrelation.nativeItemId,
    appliedCurrent.appliedCorrelation.nativeItemId);
  assert.ok(checkpointRecordBytes(appliedFutureGrave) > checkpointRecordBytes(appliedCurrentGrave));

  const appliedRow = {
    deliveryAttemptId: appliedCurrent.deliveryAttemptId,
    candidates: [
      { variant: 'current', record: appliedCurrent },
      { variant: 'maxFutureDetail', record: appliedFuture },
      { variant: 'reclaimed', record: appliedFutureGrave },
    ],
  };
  const appliedExpectedGrowth = Math.max(
    checkpointRecordBytes(appliedFuture),
    checkpointRecordBytes(appliedCurrentGrave),
    checkpointRecordBytes(appliedFutureGrave),
  ) - checkpointRecordBytes(appliedCurrent);
  const appliedExplicit = measureCheckpointReservation({
    snapshot: appliedSnapshot,
    deliveryCandidates: [appliedRow],
    currentByteLimit: MAX_SOURCE_BYTES,
  }, OPERATION_ID);
  const appliedGenerated = measureCheckpointReservation({
    snapshot: appliedSnapshot,
    currentByteLimit: MAX_SOURCE_BYTES,
  }, OPERATION_ID);
  assert.equal(appliedExplicit.detailGrowthBytes, appliedExpectedGrowth);
  assert.equal(appliedGenerated.detailGrowthBytes, appliedExpectedGrowth);

  const deadlineOverflow = normalizeDeliveryRecordV2Local({
    ...appliedCurrent,
    acceptedCorrelation: appliedCurrent.appliedCorrelation,
    terminalAt: MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS + 1,
  });
  const overflowSnapshot = structuredClone(projection.snapshot);
  overflowSnapshot.ledger.deliveries[0] = deadlineOverflow;
  assert.equal(measureCheckpointReservation({
    snapshot: overflowSnapshot,
    currentByteLimit: MAX_SOURCE_BYTES,
  }, OPERATION_ID).detailGrowthBytes, 0);
});

test('checkpoint and instruction external candidate rows can increase but never reduce internal reserves', () => {
  const questionProjection = projectLegacyCheckpointV2Local({
    sourceBytes: sourceBytes(availableQuestionCheckpoint()),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowance: null,
  });
  const questionRecord = questionProjection.snapshot.ledger.deliveries[0];
  const questionRow = {
    deliveryAttemptId: questionRecord.deliveryAttemptId,
    candidates: [{ variant: 'current', record: questionRecord }],
  };
  const internalCheckpoint = measureCheckpointReservation({
    snapshot: questionProjection.snapshot,
    currentByteLimit: MAX_SOURCE_BYTES,
  }, OPERATION_ID);
  const smallerCheckpointRows = measureCheckpointReservation({
    snapshot: questionProjection.snapshot,
    deliveryCandidates: [questionRow],
    currentByteLimit: MAX_SOURCE_BYTES,
  }, OPERATION_ID);
  assert.equal(smallerCheckpointRows.detailGrowthBytes, internalCheckpoint.detailGrowthBytes);
  const largerQuestionRecord = checkpointRecordWithMaximumIdentity(questionRecord);
  const largerCheckpointRows = measureCheckpointReservation({
    snapshot: questionProjection.snapshot,
    deliveryCandidates: [{
      deliveryAttemptId: questionRecord.deliveryAttemptId,
      candidates: [
        { variant: 'current', record: questionRecord },
        { variant: 'maxFutureDetail', record: largerQuestionRecord },
      ],
    }],
    currentByteLimit: MAX_SOURCE_BYTES,
  }, OPERATION_ID);
  assert.ok(largerCheckpointRows.detailGrowthBytes > internalCheckpoint.detailGrowthBytes);

  const instruction = instructionJournalWith(instructionRecordWithState('creating'));
  const instructionRecord = instruction.instructions[0];
  const instructionRow = {
    deliveryAttemptId: instructionRecord.deliveryAttemptId,
    candidates: [{ variant: 'current', record: instructionRecord }],
  };
  const internalInstruction = measureInstructionReservation({
    snapshot: instruction,
    currentByteLimit: MAX_SOURCE_BYTES,
  }, OPERATION_ID);
  const smallerInstructionRows = measureInstructionReservation({
    snapshot: instruction,
    instructionCandidates: [instructionRow],
    currentByteLimit: MAX_SOURCE_BYTES,
  }, OPERATION_ID);
  assert.equal(smallerInstructionRows.detailGrowthBytes, internalInstruction.detailGrowthBytes);
  const largerInstructionRecord = normalizeInstructionRecordV2Local({
    ...instructionRecord,
    logicalMessageId: MAX_ESCAPED_IDENTIFIER,
  });
  const largerInstructionRows = measureInstructionReservation({
    snapshot: instruction,
    instructionCandidates: [{
      deliveryAttemptId: instructionRecord.deliveryAttemptId,
      candidates: [
        { variant: 'current', record: instructionRecord },
        { variant: 'maxFutureDetail', record: largerInstructionRecord },
      ],
    }],
    currentByteLimit: MAX_SOURCE_BYTES,
  }, OPERATION_ID);
  assert.ok(largerInstructionRows.detailGrowthBytes > internalInstruction.detailGrowthBytes);
});

test('instruction creation states reserve checkpoint and terminal growth before the safe deadline cutoff', () => {
  const measurements = new Map();
  for (const state of ['not_created', 'creating', 'checkpointed', 'indeterminate']) {
    const snapshot = instructionJournalWith(instructionRecordWithState(state));
    measurements.set(state, measureInstructionReservation({
      snapshot,
      currentByteLimit: MAX_SOURCE_BYTES,
    }, OPERATION_ID));
  }
  assert.ok(measurements.get('not_created').detailGrowthBytes > 0);
  assert.ok(measurements.get('creating').detailGrowthBytes > 0);
  assert.ok(measurements.get('checkpointed').detailGrowthBytes > 0);
  assert.equal(measurements.get('indeterminate').detailGrowthBytes, 0);

  const creating = instructionJournalWith(instructionRecordWithState('creating'));
  const earliestTime = MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS + 1;
  const bounded = measureInstructionReservation({
    snapshot: creating,
    currentByteLimit: MAX_SOURCE_BYTES,
  }, OPERATION_ID, earliestTime);
  const baseBytes = encodeInstructionJournalV2Local(creating).sizeBytes;
  const stateGrowthBytes = ['indeterminate', 'checkpointed'].map((state) => {
    const projected = structuredClone(creating);
    projected.instructions[0].deliveryCreationState = state;
    return encodeInstructionJournalV2Local(normalizeInstructionJournalV2Local(projected)).sizeBytes - baseBytes;
  });
  assert.equal(bounded.detailGrowthBytes, Math.max(...stateGrowthBytes));
});

test('migration and physical capacity inputs reject coercible slot values without invoking them', () => {
  let coercions = 0;
  const slot = {};
  Object.defineProperty(slot, Symbol.toPrimitive, {
    value() { coercions += 1; throw new Error('coercion must not run'); },
  });
  assert.throws(() => measureMigrationAllowance({
    slot,
    sourcePresent: false,
    sourceSchemaVersion: null,
    sourceRevision: null,
    sourceSizeBytes: 0,
    sourceSha256: null,
    currentByteLimit: MAX_SOURCE_BYTES,
    anchor: anchorWith(),
    eligibleIds: [],
    projections: { withoutGrant: {}, withMaximumGrant: {} },
  }), TypeError);
  assert.equal(coercions, 0);
});
