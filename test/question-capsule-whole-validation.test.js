'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { validateQuestionCapsuleWholeRepresentation } = require('../src/server/question-capsule-whole-validation');
const { validateQuestionRejectionCapsulePair } = require('../src/server/question-rejection-capsule-pair');
const {
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
  measureCheckpointReservation,
  measureInstructionReservation,
  measurePendingQuestionPeriodCapacity,
  measureQuestionJournalReservationBytes,
} = require('../src/server/reclamation-capacity-bounds');
const { encodeQuestionReclamationAnchorV1Local } = require('../src/server/question-reclamation-anchor-codec');
const {
  validateReclamationSnapshot,
  validateReclamationStoreWrite,
} = require('../src/server/reclamation-store-consistency');
const { createQuestionCapsuleWholeValidationFixture } = require('./helpers/question-capsule-whole-validation-fixtures');

const INVALID_WHOLE = 'invalid_question_capsule_whole_representation';
const MAX_RETIRED_PERIODS = 20_000;
const SCOPE_LIMITATIONS = [
  'declared_delivery_order_authenticity_not_verified',
  'anchor_persistence_not_verified',
  'persistent_outer_schema_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'runtime_integration_not_verified',
];

function fixture(provider = 'claude') {
  return createQuestionCapsuleWholeValidationFixture({ provider });
}

function assertInvalid(input) {
  assert.throws(() => validateQuestionCapsuleWholeRepresentation(input), {
    name: 'TypeError',
    message: INVALID_WHOLE,
  });
}

function logicalTombstoneFor(delivery, tombstones) {
  return tombstones.filter((item) => item.kind === delivery.kind &&
    item.sourceExecutionId === delivery.sourceExecutionId &&
    item.logicalMessageId === delivery.logicalMessageId && item.revision === delivery.revision &&
    item.targetLaunchKey === null);
}

function reverseObjectPropertyOrder(value) {
  if (Array.isArray(value)) return value.map((item) => reverseObjectPropertyOrder(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) =>
      [key, reverseObjectPropertyOrder(item)]));
  }
  return value;
}

function assertCapsulePairsPassLocally(input) {
  const tombstones = input.ordinaryStores.checkpoint.ledger.logicalTombstones;
  for (const pair of input.capsulePairs) {
    const selectedLogicalTombstones = pair.checkpointCapsule === null
      ? []
      : pair.checkpointCapsule.deliveries.flatMap((delivery) => logicalTombstoneFor(delivery, tombstones));
    assert.doesNotThrow(() => validateQuestionRejectionCapsulePair({
      ...pair,
      selectedLogicalTombstones,
    }));
  }
}

function markCapsulePairApplied(pair, nativeItemId) {
  const reservation = pair.questionCapsule.reservations[0];
  const delivery = pair.checkpointCapsule.deliveries[0];
  const correlation = {
    deliveryAttemptId: delivery.deliveryAttemptId,
    revision: delivery.revision,
    payloadDigest: delivery.payloadDigest,
    targetPeriodId: pair.checkpointCapsule.periodId,
    nativeTurnId: 'turn-shared',
    nativeItemId,
    clientRequestId: delivery.deliveryAttemptId,
  };
  reservation.checkpointState = 'applied';
  reservation.terminalResultKind = 'applied';
  reservation.reclamation.checkpointState = 'applied';
  delivery.state = 'applied';
  delivery.terminalAt = 1_000_000;
  delivery.appliedCorrelation = correlation;
}

test('whole validation reconstructs mixed multi-period chunks and preserves declared history order for both providers', () => {
  for (const provider of ['claude', 'codex']) {
    const generated = fixture(provider);
    const inputBefore = JSON.stringify(generated.input);
    const result = validateQuestionCapsuleWholeRepresentation(generated.input);

    assert.deepEqual(result.snapshot, generated.snapshot);
    assert.deepEqual(result.counts, generated.counts);
    assert.deepEqual(result.scopeLimitations, SCOPE_LIMITATIONS);
    assert.deepEqual(generated.input.deliveryAttemptOrder, [
      'common-question-selection-1', 'attempt-instruction', 'common-question-selection-3',
    ]);
    assert.deepEqual(generated.input.capsulePairs.map((pair) => pair.checkpointCapsule === null),
      [false, true, false, true]);
    assert.equal(new Set(generated.input.capsulePairs.map((pair) =>
      pair.questionCapsule.compactionOperationId)).size, 1);
    assert.equal(JSON.stringify(generated.input), inputBefore);
    assert.equal(Object.isFrozen(generated.input), false);
    assert.equal(Object.hasOwn(result, 'safeToDelete'), false);
    assert.equal(Object.hasOwn(result, 'canResume'), false);
    assert.equal(Object.hasOwn(result, 'isPersisted'), false);
  }
});

test('whole validation accepts capsule pairs from different providers in one snapshot', () => {
  for (const [provider, secondaryProvider] of [['claude', 'codex'], ['codex', 'claude']]) {
    const generated = createQuestionCapsuleWholeValidationFixture({ provider, secondaryProvider });
    const providers = new Set(generated.input.capsulePairs.map((pair) =>
      pair.questionCapsule.identity.provider));

    assert.deepEqual(providers, new Set(['claude', 'codex']));
    assertCapsulePairsPassLocally(generated.input);
    assert.deepEqual(validateQuestionCapsuleWholeRepresentation(generated.input).snapshot, generated.snapshot);
  }
});

test('whole validation accepts reordered object keys while preserving array order', () => {
  for (const provider of ['claude', 'codex']) {
    const generated = fixture(provider);
    const input = reverseObjectPropertyOrder(generated.input);
    const registration = input.ordinaryStores.checkpoint.registrations.conversations[0];
    assert.notDeepEqual(Object.keys(registration),
      Object.keys(generated.input.ordinaryStores.checkpoint.registrations.conversations[0]));
    assert.notEqual(input.ordinaryStores.instructions.migrationAllowance, null);

    const result = validateQuestionCapsuleWholeRepresentation(input);
    assert.deepEqual(result.snapshot, generated.snapshot);
    assert.deepEqual(result.counts, generated.counts);
  }
});

test('whole validation enforces each legacy future-reservation byte limit exactly', () => {
  const generated = fixture();
  const stores = generated.snapshot.stores;
  const measures = {
    questions: measureQuestionJournalReservationBytes({
      snapshot: stores.questions,
      currentByteLimit: MAX_SOURCE_BYTES,
    }),
    checkpoint: measureCheckpointReservation({
      snapshot: stores.checkpoint,
      currentByteLimit: MAX_SOURCE_BYTES,
    }),
    instructions: measureInstructionReservation({
      snapshot: stores.instructions,
      currentByteLimit: MAX_SOURCE_BYTES,
    }),
  };
  const grantBytesBySlot = Object.fromEntries(Object.entries(stores).map(([slot, store]) =>
    [slot, store?.migrationAllowance?.maxExtraBytes ?? 0]));
  const exactLimits = Object.fromEntries(Object.entries(measures).map(([slot, measurement]) =>
    [slot, measurement.reservedBytes - grantBytesBySlot[slot]]));
  const exactInput = structuredClone(generated.input);
  exactInput.normalByteLimitsBySlot = exactLimits;
  assert.deepEqual(validateQuestionCapsuleWholeRepresentation(exactInput).snapshot, generated.snapshot);

  for (const [slot, measurement] of Object.entries(measures)) {
    const belowLimit = exactLimits[slot] - 1;
    assert.ok(belowLimit > 0);
    assert.ok(measurement.currentBytes <= exactLimits[slot] + grantBytesBySlot[slot]);
    assert.ok(measurement.currentBytes <= belowLimit + grantBytesBySlot[slot]);
    const oldSelfTransition = validateReclamationStoreWrite({
      anchor: generated.snapshot.anchor,
      previousStores: stores,
      nextStores: stores,
      normalByteLimitsBySlot: { ...exactLimits, [slot]: belowLimit },
    });
    assert.equal(oldSelfTransition.status, 'checked');
    assert.deepEqual(oldSelfTransition.reasons, []);

    const input = structuredClone(exactInput);
    input.normalByteLimitsBySlot[slot] = belowLimit;
    assertInvalid(input);

    const limitBelowCurrent = measurement.currentBytes - grantBytesBySlot[slot] - 1;
    assert.ok(limitBelowCurrent > 0);
    assert.equal(limitBelowCurrent + grantBytesBySlot[slot], measurement.currentBytes - 1);
    const currentBytesOverLimit = structuredClone(exactInput);
    currentBytesOverLimit.normalByteLimitsBySlot[slot] = limitBelowCurrent;
    assert.ok(measurement.currentBytes > limitBelowCurrent + grantBytesBySlot[slot]);
    assertInvalid(currentBytesOverLimit);
  }
});

test('whole validation rejects an oversized but locally valid retired anchor accepted by the legacy snapshot validator', () => {
  const base = fixture().snapshot.anchor;
  const anchor = { ...base, retiredQuestionPeriods: [] };
  const emptyBytes = encodeQuestionReclamationAnchorV1Local(anchor).sizeBytes;
  const identity = {
    ...base.retiredQuestionPeriods[0].identity,
    hostId: 'h'.repeat(512),
    homeScopeId: 'm'.repeat(512),
    nativeId: 'n'.repeat(512),
  };
  const period = (index) => ({
    identity,
    periodId: `p${index.toString(36).padStart(5, '0')}${'q'.repeat(506)}`,
    retiredAt: 2_000_000,
    reason: 'confirmed-retirement',
  });
  const onePeriodAnchor = {
    ...anchor,
    retiredQuestionPeriods: [period(0)],
  };
  const onePeriodBytes = encodeQuestionReclamationAnchorV1Local(onePeriodAnchor).sizeBytes;
  const twoPeriodBytes = encodeQuestionReclamationAnchorV1Local({
    ...anchor,
    retiredQuestionPeriods: [period(0), period(1)],
  }).sizeBytes;
  const additionalPeriodGrowth = twoPeriodBytes - onePeriodBytes;
  const periodCount = Math.floor((NORMAL_ANCHOR_MAX_BYTES - onePeriodBytes) /
    additionalPeriodGrowth) + 2;
  assert.ok(onePeriodBytes > emptyBytes && additionalPeriodGrowth > 0);
  assert.ok(periodCount > 0 && periodCount <= MAX_RETIRED_PERIODS);
  anchor.retiredQuestionPeriods = Array.from({ length: periodCount }, (_, index) => period(index));

  const actualAnchorBytes = encodeQuestionReclamationAnchorV1Local(anchor).sizeBytes;
  assert.ok(actualAnchorBytes > NORMAL_ANCHOR_MAX_BYTES);
  const ordinaryStores = { questions: null, checkpoint: null, instructions: null };
  const legacyOracle = validateReclamationSnapshot({ anchor, stores: ordinaryStores });
  assert.equal(legacyOracle.status, 'ready');
  assert.deepEqual(legacyOracle.reasons, []);

  assertInvalid({
    formatVersion: 1,
    anchor,
    ordinaryStores,
    capsulePairs: [],
    deliveryAttemptOrder: [],
    questionReservationOrder: [],
    normalByteLimitsBySlot: { questions: null, checkpoint: null, instructions: null },
  });
});

test('whole validation rejects future anchor growth when the current anchor still fits', () => {
  const generated = createQuestionCapsuleWholeValidationFixture({ ordinaryQuestionSelected: true });
  const anchor = structuredClone(generated.snapshot.anchor);
  const originalRetiredCount = anchor.retiredQuestionPeriods.length;
  const identityTemplate = {
    ...anchor.retiredQuestionPeriods[0].identity,
    hostId: 'h'.repeat(512),
    homeScopeId: 'm'.repeat(512),
    nativeId: 'n'.repeat(512),
  };
  const makePaddingPeriod = (index) => ({
    identity: { ...identityTemplate },
    periodId: `pad-${index.toString(36).padStart(8, '0')}-${'q'.repeat(499)}`,
    retiredAt: 2_000_000,
    reason: 'confirmed-retirement',
  });
  const currentBytesAtBase = encodeQuestionReclamationAnchorV1Local(anchor).sizeBytes;
  const firstPeriodBytes = encodeQuestionReclamationAnchorV1Local({
    ...anchor,
    retiredQuestionPeriods: [...anchor.retiredQuestionPeriods, makePaddingPeriod(0)],
  }).sizeBytes;
  const secondPeriodBytes = encodeQuestionReclamationAnchorV1Local({
    ...anchor,
    retiredQuestionPeriods: [
      ...anchor.retiredQuestionPeriods,
      makePaddingPeriod(0),
      makePaddingPeriod(1),
    ],
  }).sizeBytes;
  const firstPeriodGrowth = firstPeriodBytes - currentBytesAtBase;
  const additionalPeriodGrowth = secondPeriodBytes - firstPeriodBytes;
  const targetCurrentBytes = NORMAL_ANCHOR_MAX_BYTES - 100;
  const paddingCount = Math.floor((targetCurrentBytes - currentBytesAtBase - firstPeriodGrowth) /
    additionalPeriodGrowth) + 2;
  assert.ok(firstPeriodGrowth > 0 && additionalPeriodGrowth > 0);
  assert.ok(paddingCount > 2 && paddingCount + originalRetiredCount <= MAX_RETIRED_PERIODS);
  anchor.retiredQuestionPeriods.push(...Array.from({ length: paddingCount }, (_, index) =>
    makePaddingPeriod(index)));

  const initialPaddingBytes = encodeQuestionReclamationAnchorV1Local(anchor).sizeBytes;
  const exactProjectionAnchor = structuredClone(anchor);
  const activePeriods = generated.snapshot.stores.questions.reservations.map(({ identity, periodId }) => ({
    identity,
    periodId,
  }));
  const minLengthByField = { hostId: 1, homeScopeId: 1, nativeId: 1, periodId: 13 };
  const maxLengthByField = { hostId: 512, homeScopeId: 512, nativeId: 512, periodId: 512 };
  const padCharByField = { hostId: 'h', homeScopeId: 'm', nativeId: 'n', periodId: 'q' };
  const trimPaddingBytes = (targetAnchor, bytesToTrim) => {
    for (let periodIndex = targetAnchor.retiredQuestionPeriods.length - 1;
      periodIndex >= originalRetiredCount && bytesToTrim > 0; periodIndex -= 1) {
      const retiredPeriod = targetAnchor.retiredQuestionPeriods[periodIndex];
      for (const [record, field] of [
        [retiredPeriod.identity, 'hostId'],
        [retiredPeriod.identity, 'homeScopeId'],
        [retiredPeriod.identity, 'nativeId'],
        [retiredPeriod, 'periodId'],
      ]) {
        const value = record[field];
        const removableBytes = value.length - minLengthByField[field];
        const trimBytes = Math.min(bytesToTrim, removableBytes);
        record[field] = value.slice(0, value.length - trimBytes);
        bytesToTrim -= trimBytes;
      }
    }
    return bytesToTrim;
  };
  const growPaddingBytes = (targetAnchor, bytesToGrow) => {
    for (let periodIndex = targetAnchor.retiredQuestionPeriods.length - 1;
      periodIndex >= originalRetiredCount && bytesToGrow > 0; periodIndex -= 1) {
      const retiredPeriod = targetAnchor.retiredQuestionPeriods[periodIndex];
      for (const [record, field] of [
        [retiredPeriod.identity, 'hostId'],
        [retiredPeriod.identity, 'homeScopeId'],
        [retiredPeriod.identity, 'nativeId'],
        [retiredPeriod, 'periodId'],
      ]) {
        const availableBytes = maxLengthByField[field] - record[field].length;
        const growBytes = Math.min(bytesToGrow, availableBytes);
        record[field] += padCharByField[field].repeat(growBytes);
        bytesToGrow -= growBytes;
      }
    }
    return bytesToGrow;
  };

  const baseScopeCapacity = measurePendingQuestionPeriodCapacity(generated.snapshot.anchor, activePeriods);
  const pendingGrowthBytes = baseScopeCapacity.projectedBytes - baseScopeCapacity.currentBytes;
  assert.ok(pendingGrowthBytes > 100);
  const exactProjectionCurrentBytes = NORMAL_ANCHOR_MAX_BYTES - pendingGrowthBytes;
  assert.ok(initialPaddingBytes > exactProjectionCurrentBytes);
  assert.equal(trimPaddingBytes(exactProjectionAnchor,
    initialPaddingBytes - exactProjectionCurrentBytes), 0);
  let exactProjectionCapacity = measurePendingQuestionPeriodCapacity(exactProjectionAnchor, activePeriods);
  if (exactProjectionCapacity.projectedBytes > NORMAL_ANCHOR_MAX_BYTES) {
    assert.equal(trimPaddingBytes(exactProjectionAnchor,
      exactProjectionCapacity.projectedBytes - NORMAL_ANCHOR_MAX_BYTES), 0);
  } else if (exactProjectionCapacity.projectedBytes < NORMAL_ANCHOR_MAX_BYTES) {
    assert.equal(growPaddingBytes(exactProjectionAnchor,
      NORMAL_ANCHOR_MAX_BYTES - exactProjectionCapacity.projectedBytes), 0);
  }
  exactProjectionCapacity = measurePendingQuestionPeriodCapacity(exactProjectionAnchor, activePeriods);
  assert.equal(exactProjectionCapacity.projectedBytes, NORMAL_ANCHOR_MAX_BYTES);
  assert.ok(exactProjectionCapacity.currentBytes <= NORMAL_ANCHOR_MAX_BYTES);
  const exactProjectionInput = structuredClone(generated.input);
  exactProjectionInput.anchor = exactProjectionAnchor;
  const exactProjectionOracle = validateReclamationSnapshot({
    anchor: exactProjectionAnchor,
    stores: generated.snapshot.stores,
  });
  assert.equal(exactProjectionOracle.status, 'ready');
  assert.deepEqual(exactProjectionOracle.reasons, []);
  assertCapsulePairsPassLocally(exactProjectionInput);
  const exactProjectionResult = validateQuestionCapsuleWholeRepresentation(exactProjectionInput);
  assert.ok(encodeQuestionReclamationAnchorV1Local(exactProjectionResult.snapshot.anchor)
    .bytes.equals(encodeQuestionReclamationAnchorV1Local(exactProjectionAnchor).bytes));

  const noStores = { questions: null, checkpoint: null, instructions: null };
  const paddedNullInput = {
    formatVersion: 1,
    anchor: exactProjectionAnchor,
    ordinaryStores: noStores,
    capsulePairs: [],
    deliveryAttemptOrder: [],
    questionReservationOrder: [],
    normalByteLimitsBySlot: { questions: null, checkpoint: null, instructions: null },
  };
  const paddedNullOracle = validateReclamationSnapshot({ anchor: exactProjectionAnchor, stores: noStores });
  assert.equal(paddedNullOracle.status, 'ready');
  assert.deepEqual(paddedNullOracle.reasons, []);
  const paddedNullCapacity = measurePendingQuestionPeriodCapacity(exactProjectionAnchor, []);
  assert.equal(paddedNullCapacity.fits, true);
  assert.ok(paddedNullCapacity.projectedBytes <= NORMAL_ANCHOR_MAX_BYTES);
  const paddedNullResult = validateQuestionCapsuleWholeRepresentation(paddedNullInput);
  assert.deepEqual(paddedNullResult.counts, {
    capsulePairs: 0,
    checkpointCapsules: 0,
    ordinaryQuestionReservations: 0,
    capsuleQuestionReservations: 0,
    questionReservations: 0,
    ordinaryDeliveries: 0,
    capsuleDeliveries: 0,
    deliveries: 0,
  });

  const bytesToTrim = initialPaddingBytes - targetCurrentBytes;
  assert.equal(trimPaddingBytes(anchor, bytesToTrim), 0);
  let currentBytes = encodeQuestionReclamationAnchorV1Local(anchor).sizeBytes;
  assert.equal(currentBytes, targetCurrentBytes);
  assert.ok(encodeQuestionReclamationAnchorV1Local({
    ...anchor,
    retiredQuestionPeriods: anchor.retiredQuestionPeriods.slice(0, originalRetiredCount),
  }).bytes.equals(encodeQuestionReclamationAnchorV1Local(generated.snapshot.anchor).bytes));

  const emptyActiveScopeCapacity = measurePendingQuestionPeriodCapacity(anchor, []);
  assert.equal(emptyActiveScopeCapacity.currentBytes, currentBytes);
  assert.equal(emptyActiveScopeCapacity.fits, true);
  assert.ok(emptyActiveScopeCapacity.projectedBytes <= NORMAL_ANCHOR_MAX_BYTES);
  const fullQuestionScopeCapacity = measurePendingQuestionPeriodCapacity(anchor, activePeriods);
  assert.equal(fullQuestionScopeCapacity.currentBytes, currentBytes);
  assert.equal(fullQuestionScopeCapacity.pendingCount, 1);
  assert.ok(currentBytes <= NORMAL_ANCHOR_MAX_BYTES);
  assert.ok(fullQuestionScopeCapacity.projectedBytes > NORMAL_ANCHOR_MAX_BYTES);
  assert.equal(fullQuestionScopeCapacity.fits, false);
  assert.equal(fullQuestionScopeCapacity.reason, 'byte_limit');

  const oneFewerAnchor = structuredClone(anchor);
  oneFewerAnchor.retiredQuestionPeriods.pop();
  let oneFewerCapacity = measurePendingQuestionPeriodCapacity(oneFewerAnchor, activePeriods);
  if (!oneFewerCapacity.fits) {
    assert.ok(oneFewerCapacity.projectedBytes > NORMAL_ANCHOR_MAX_BYTES);
    assert.equal(trimPaddingBytes(oneFewerAnchor,
      oneFewerCapacity.projectedBytes - (NORMAL_ANCHOR_MAX_BYTES - 100)), 0);
    oneFewerCapacity = measurePendingQuestionPeriodCapacity(oneFewerAnchor, activePeriods);
  }
  assert.equal(oneFewerCapacity.fits, true);
  assert.ok(oneFewerCapacity.currentBytes <= NORMAL_ANCHOR_MAX_BYTES);
  assert.ok(oneFewerCapacity.projectedBytes <= NORMAL_ANCHOR_MAX_BYTES);
  assert.equal(oneFewerAnchor.retiredQuestionPeriods.length, anchor.retiredQuestionPeriods.length - 1);
  const oneFewerInput = structuredClone(generated.input);
  oneFewerInput.anchor = oneFewerAnchor;
  assertCapsulePairsPassLocally(oneFewerInput);
  assert.deepEqual(validateQuestionCapsuleWholeRepresentation(oneFewerInput).snapshot.stores,
    generated.snapshot.stores);

  const snapshotWithPadding = {
    anchor,
    stores: generated.snapshot.stores,
  };
  const legacyOracle = validateReclamationSnapshot(snapshotWithPadding);
  assert.equal(legacyOracle.status, 'ready');
  assert.deepEqual(legacyOracle.reasons, []);
  assertCapsulePairsPassLocally(generated.input);

  const oversizedProjection = structuredClone(generated.input);
  oversizedProjection.anchor = anchor;
  assertInvalid(oversizedProjection);
});

test('empty capsule representation accepts a legacy anchor with every store slot absent', () => {
  const anchor = fixture().snapshot.anchor;
  const input = {
    formatVersion: 1,
    anchor,
    ordinaryStores: { questions: null, checkpoint: null, instructions: null },
    capsulePairs: [],
    deliveryAttemptOrder: [],
    questionReservationOrder: [],
    normalByteLimitsBySlot: { questions: null, checkpoint: null, instructions: null },
  };
  const oracle = validateReclamationSnapshot({ anchor, stores: input.ordinaryStores });
  assert.equal(oracle.status, 'ready');
  assert.deepEqual(oracle.reasons, []);

  const result = validateQuestionCapsuleWholeRepresentation(input);
  assert.deepEqual(result.snapshot, oracle.snapshot);
  assert.equal(result.counts.capsulePairs, 0);
  assert.equal(result.counts.questionReservations, 0);
  assert.equal(result.counts.deliveries, 0);
});

test('whole validation rejects declared history that reverses a superseded and active capsule attempt', () => {
  const generated = fixture();
  const snapshot = structuredClone(generated.snapshot);
  const input = structuredClone(generated.input);
  const currentAttemptId = 'common-question-selection-1';
  const previousAttemptId = 'common-question-selection-3';
  const currentDelivery = snapshot.stores.checkpoint.ledger.deliveries.find((delivery) =>
    delivery.deliveryAttemptId === currentAttemptId);
  const previousDelivery = snapshot.stores.checkpoint.ledger.deliveries.find((delivery) =>
    delivery.deliveryAttemptId === previousAttemptId);
  const previousReservation = snapshot.stores.questions.reservations.find((reservation) =>
    reservation.internalQuestionId === 'internal-3');
  const currentIntent = snapshot.stores.questions.reservations.find((reservation) =>
    reservation.internalQuestionId === 'internal-1').deliveryIntent;
  const markSuperseded = (reservation, delivery) => {
    reservation.deliveryIntent.logicalMessageId = currentIntent.logicalMessageId;
    reservation.deliveryIntent.payloadDigest = currentIntent.payloadDigest;
    reservation.checkpointState = 'superseded_before_send';
    reservation.terminalResultKind = 'superseded_before_send';
    reservation.reclamation.checkpointState = 'superseded_before_send';
    delivery.logicalMessageId = currentIntent.logicalMessageId;
    delivery.payloadDigest = currentIntent.payloadDigest;
    delivery.state = 'superseded_before_send';
    delivery.terminalAt = 1_000_000;
  };
  markSuperseded(previousReservation, previousDelivery);
  const inputPreviousReservation = input.capsulePairs[2].questionCapsule.reservations[0];
  const inputPreviousDelivery = input.capsulePairs[2].checkpointCapsule.deliveries[0];
  markSuperseded(inputPreviousReservation, inputPreviousDelivery);
  snapshot.stores.checkpoint.ledger.logicalTombstones =
    snapshot.stores.checkpoint.ledger.logicalTombstones.filter((tombstone) =>
      tombstone.logicalMessageId !== 'common-question-internal-3');
  input.ordinaryStores.checkpoint.ledger.logicalTombstones =
    input.ordinaryStores.checkpoint.ledger.logicalTombstones.filter((tombstone) =>
      tombstone.logicalMessageId !== 'common-question-internal-3');
  const instructionAttemptId = 'attempt-instruction';
  const originalOrder = [previousAttemptId, instructionAttemptId, currentAttemptId];
  const deliveriesByAttempt = new Map(snapshot.stores.checkpoint.ledger.deliveries.map((delivery) =>
    [delivery.deliveryAttemptId, delivery]));
  snapshot.stores.checkpoint.ledger.deliveries = originalOrder.map((id) => deliveriesByAttempt.get(id));
  input.deliveryAttemptOrder = originalOrder;

  const legacyOracle = validateReclamationSnapshot(snapshot);
  assert.equal(legacyOracle.status, 'ready');
  assert.deepEqual(legacyOracle.reasons, []);
  assertCapsulePairsPassLocally(input);
  assert.deepEqual(validateQuestionCapsuleWholeRepresentation(input).snapshot, legacyOracle.snapshot);

  const flipped = structuredClone(input);
  const currentOrderIndex = flipped.deliveryAttemptOrder.indexOf(currentAttemptId);
  const previousOrderIndex = flipped.deliveryAttemptOrder.indexOf(previousAttemptId);
  [flipped.deliveryAttemptOrder[currentOrderIndex], flipped.deliveryAttemptOrder[previousOrderIndex]] =
    [flipped.deliveryAttemptOrder[previousOrderIndex], flipped.deliveryAttemptOrder[currentOrderIndex]];
  assertCapsulePairsPassLocally(flipped);
  assertInvalid(flipped);
});

test('whole validation rejects input that requires question creation or cache reconciliation', () => {
  for (const [repairKind, expectedReason] of [
    ['creating', 'question_creation_state'],
    ['cache', 'question_checkpoint_cache'],
  ]) {
    const generated = createQuestionCapsuleWholeValidationFixture({ ordinaryQuestionSelected: true });
    const snapshot = structuredClone(generated.snapshot);
    const input = structuredClone(generated.input);
    const snapshotReservation = snapshot.stores.questions.reservations.find((row) =>
      row.internalQuestionId === 'internal-5');
    const inputReservation = input.ordinaryStores.questions.reservations.find((row) =>
      row.internalQuestionId === 'internal-5');
    if (repairKind === 'creating') {
      const snapshotDetail = snapshot.stores.questions.questions.find((row) =>
        row.internalQuestionId === 'internal-5');
      const inputDetail = input.ordinaryStores.questions.questions.find((row) =>
        row.internalQuestionId === 'internal-5');
      for (const reservation of [snapshotReservation, inputReservation]) {
        reservation.deliveryCreationState = 'creating';
        reservation.checkpointState = null;
        reservation.sourceClaimsDigest = null;
        reservation.sessionId = null;
        reservation.terminalResultKind = null;
      }
      snapshotDetail.deliveryCreationState = 'creating';
      inputDetail.deliveryCreationState = 'creating';
    } else {
      snapshotReservation.checkpointState = 'claimed';
      inputReservation.checkpointState = 'claimed';
    }

    const legacyOracle = validateReclamationSnapshot(snapshot);
    assert.equal(legacyOracle.status, 'reconciliation-required');
    assert.deepEqual(legacyOracle.reasons, [expectedReason]);
    assertCapsulePairsPassLocally(input);
    assertInvalid(input);
  }
});

test('whole validation rejects incomplete, repeated, extra, and unknown declared orders', () => {
  const valid = fixture().input;
  const cases = [
    (input) => { input.deliveryAttemptOrder.pop(); },
    (input) => { input.deliveryAttemptOrder[1] = input.deliveryAttemptOrder[0]; },
    (input) => { input.deliveryAttemptOrder.push('attempt-not-in-snapshot'); },
    (input) => { input.questionReservationOrder.pop(); },
    (input) => { input.questionReservationOrder[1] = input.questionReservationOrder[0]; },
    (input) => { input.questionReservationOrder.push('question-not-in-snapshot'); },
  ];
  for (const mutate of cases) {
    const input = structuredClone(valid);
    mutate(input);
    assertInvalid(input);
  }
});

test('whole validation rejects normal and capsule question common-key collisions', () => {
  const input = structuredClone(fixture().input);
  const normalQuestionId = input.ordinaryStores.questions.reservations[0].questionId;
  input.capsulePairs[0].questionCapsule.reservations[0].questionId = normalQuestionId;
  assertCapsulePairsPassLocally(input);
  assertInvalid(input);
});

test('whole validation rejects common-key collisions between locally valid capsule pairs', () => {
  const input = structuredClone(fixture().input);
  input.capsulePairs[2].questionCapsule.reservations[0].questionId =
    input.capsulePairs[0].questionCapsule.reservations[0].questionId;

  assertCapsulePairsPassLocally(input);
  assertInvalid(input);
});

test('whole validation rejects duplicate capsule question identifiers after local pairs pass', () => {
  const input = structuredClone(fixture().input);
  input.capsulePairs[3] = structuredClone(input.capsulePairs[1]);

  assertCapsulePairsPassLocally(input);
  assertInvalid(input);
});

test('whole validation rejects duplicate question delivery attempts across ordinary and capsule rows', () => {
  const input = structuredClone(fixture().input);
  const duplicateAttemptId = input.ordinaryStores.checkpoint.ledger.deliveries[0].deliveryAttemptId;
  input.capsulePairs[0].questionCapsule.reservations[0].deliveryIntent.deliveryAttemptId = duplicateAttemptId;
  input.capsulePairs[0].checkpointCapsule.deliveries[0].deliveryAttemptId = duplicateAttemptId;
  input.deliveryAttemptOrder[0] = duplicateAttemptId;
  input.deliveryAttemptOrder[1] = duplicateAttemptId;
  assertCapsulePairsPassLocally(input);
  assertInvalid(input);
});

test('whole validation rejects capsule delivery-attempt reuse across locally valid pairs', () => {
  const input = structuredClone(fixture().input);
  const duplicateAttemptId = input.capsulePairs[0].checkpointCapsule.deliveries[0].deliveryAttemptId;
  input.capsulePairs[2].questionCapsule.reservations[0].deliveryIntent.deliveryAttemptId = duplicateAttemptId;
  input.capsulePairs[2].checkpointCapsule.deliveries[0].deliveryAttemptId = duplicateAttemptId;

  assertCapsulePairsPassLocally(input);
  assertInvalid(input);
});

test('whole logical closure rejects missing, extra, and value-mismatched tombstones', () => {
  const valid = fixture().input;
  const tombstoneIndex = valid.ordinaryStores.checkpoint.ledger.logicalTombstones.findIndex((item) =>
    item.logicalMessageId === 'common-question-internal-1');
  const cases = [
    (input) => { input.ordinaryStores.checkpoint.ledger.logicalTombstones.splice(tombstoneIndex, 1); },
    (input) => { input.ordinaryStores.checkpoint.ledger.logicalTombstones.push(
      structuredClone(input.ordinaryStores.checkpoint.ledger.logicalTombstones[0])); },
    (input) => { input.ordinaryStores.checkpoint.ledger.logicalTombstones[tombstoneIndex].payloadDigest = 'f'.repeat(64); },
    (input) => { input.ordinaryStores.checkpoint.ledger.logicalTombstones[tombstoneIndex].sourceLaunchKey[0] =
      'launch-key-from-another-source'; },
  ];
  for (const mutate of cases) {
    const input = structuredClone(valid);
    mutate(input);
    assertInvalid(input);
  }
});

test('whole validation catches native correlation reuse after each local pair passes', () => {
  const input = structuredClone(fixture().input);
  markCapsulePairApplied(input.capsulePairs[0], 'native-item-shared');
  markCapsulePairApplied(input.capsulePairs[2], 'native-item-shared');

  assertCapsulePairsPassLocally(input);
  assertInvalid(input);
});

test('whole validation requires matching retired scopes for every capsule target', () => {
  const missingScope = structuredClone(fixture().input);
  missingScope.anchor.retiredQuestionPeriods = [];
  assertInvalid(missingScope);

  const wrongIdentity = structuredClone(fixture().input);
  wrongIdentity.anchor.retiredQuestionPeriods[1].identity.nativeId = 'different-native';
  assertInvalid(wrongIdentity);
});

test('whole validation rejects migration in progress and a remaining question migration grant', () => {
  const migration = structuredClone(fixture().input);
  migration.anchor.migration = {
    operationId: '66666666-6666-4666-8666-666666666666',
    startedAt: 1,
    phase: 'prepared',
    sources: [],
    targets: [],
  };
  assertInvalid(migration);

  const grant = structuredClone(fixture().input);
  grant.ordinaryStores.questions.migrationAllowance = {
    operationId: '66666666-6666-4666-8666-666666666666',
    sourceSchemaVersion: 1,
    sourceSizeBytes: 1,
    sourceSha256: 'a'.repeat(64),
    maxExtraBytes: 0,
    eligibleQuestionIds: [],
  };
  assertInvalid(grant);
});

test('whole validation rejects a valid migration grant on each capsule target store', () => {
  for (const slot of ['questions', 'checkpoint']) {
    const generated = fixture();
    const grant = generated.sourceGrants[slot];
    assert.ok(grant);

    const snapshot = structuredClone(generated.snapshot);
    snapshot.stores[slot].migrationAllowance = structuredClone(grant);
    const legacyOracle = validateReclamationSnapshot(snapshot);
    assert.equal(legacyOracle.status, 'ready');
    assert.deepEqual(legacyOracle.reasons, []);
    const storeWriteOracle = validateReclamationStoreWrite({
      anchor: snapshot.anchor,
      previousStores: snapshot.stores,
      nextStores: snapshot.stores,
      normalByteLimitsBySlot: generated.normalByteLimitsBySlot,
    });
    assert.equal(storeWriteOracle.status, 'checked');
    assert.deepEqual(storeWriteOracle.reasons, []);

    const input = structuredClone(generated.input);
    input.ordinaryStores[slot].migrationAllowance = structuredClone(grant);
    assertCapsulePairsPassLocally(input);
    assertInvalid(input);
  }
});

test('whole input rejects unknown fields, getters, and proxies without running traps', () => {
  const extraField = structuredClone(fixture().input);
  extraField.unrecognized = true;
  assertInvalid(extraField);

  const input = fixture().input;
  let getterCalls = 0;
  const getterInput = { ...input };
  delete getterInput.anchor;
  Object.defineProperty(getterInput, 'anchor', {
    enumerable: true,
    get() { getterCalls += 1; return input.anchor; },
  });
  assertInvalid(getterInput);
  assert.equal(getterCalls, 0);

  const proxy = (value, counter) => new Proxy(value, {
    getPrototypeOf() { counter.count += 1; return Object.getPrototypeOf(value); },
    ownKeys() { counter.count += 1; return Reflect.ownKeys(value); },
    getOwnPropertyDescriptor(target, key) {
      counter.count += 1;
      return Object.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, receiver) { counter.count += 1; return Reflect.get(target, key, receiver); },
  });
  const topCounter = { count: 0 };
  assertInvalid(proxy(input, topCounter));
  assert.equal(topCounter.count, 0);

  const nestedInput = structuredClone(input);
  const nestedCounter = { count: 0 };
  nestedInput.ordinaryStores.questions = proxy(nestedInput.ordinaryStores.questions, nestedCounter);
  assertInvalid(nestedInput);
  assert.equal(nestedCounter.count, 0);
});
