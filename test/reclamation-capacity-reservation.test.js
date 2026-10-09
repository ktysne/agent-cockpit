'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  createReclamationCapacityBudget,
  measureReclamationAtomicReservation,
  measureReclamationStoreCapacity,
} = require('../src/server/reclamation-capacity-reservation');
const {
  FIXED_ANCHOR_MIGRATION_BOUNDS,
  FIXED_H_BOUNDS,
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
  measurePendingQuestionPeriodCapacity,
} = require('../src/server/reclamation-capacity-bounds');
const { createQuestionRecord } = require('../src/server/common-question-kernel');
const {
  encodeQuestionJournalV2Local,
  normalizeQuestionJournalV2Local,
} = require('../src/server/common-question-reclamation-codec');
const {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
} = require('../src/server/question-reclamation-anchor-codec');
const {
  planInitialReclamationMigration,
} = require('../src/server/reclamation-migration-plan');
const {
  projectLegacyReclamationMigrationLocal,
} = require('../src/server/reclamation-migration-projection');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const STARTED_AT = 1_000_000;
const ALL_SLOTS = ['questions', 'checkpoint', 'instructions'];

function record(entries) {
  return Object.fromEntries(entries);
}

function emptyPlan(configuredSlots = ['questions']) {
  return planInitialReclamationMigration({
    configuredSlots,
    sourceBytesBySlot: record(configuredSlots.map((slot) => [slot, null])),
    normalByteLimitsBySlot: record(configuredSlots.map((slot) => [slot, MAX_SOURCE_BYTES])),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
  });
}

function storesFromPlan(plan, configuredSlots) {
  if (plan.stores !== undefined) return plan.stores;
  const stores = record(ALL_SLOTS.map((slot) => [slot, null]));
  for (const slot of configuredSlots) stores[slot] = plan.slots[slot].target.snapshot;
  return stores;
}

function storeMeasurementInput(plan, configuredSlots, overrides = {}) {
  const normalByteLimitsBySlot = record(configuredSlots.map((slot) => [
    slot,
    overrides.normalByteLimitsBySlot?.[slot] ?? MAX_SOURCE_BYTES,
  ]));
  const rawSizeBytesBySlot = record(configuredSlots.map((slot) => [
    slot,
    overrides.rawSizeBytesBySlot?.[slot] ?? plan.slots[slot].target.sizeBytes,
  ]));
  return {
    anchor: overrides.anchor ?? plan.anchor,
    stores: overrides.stores ?? storesFromPlan(plan, configuredSlots),
    normalByteLimitsBySlot,
    rawSizeBytesBySlot,
    rawAnchorSizeBytes: overrides.rawAnchorSizeBytes ?? plan.anchorEncoded.sizeBytes,
  };
}

function simpleQuestion() {
  return createQuestionRecord({
    internalQuestionId: 'internal-question-1',
    questionId: 'public-question-1',
    identity: {
      provider: 'claude',
      nativeIdKind: 'session',
      hostId: 'host-1',
      homeScopeId: 'home-1',
      nativeId: 'native-1',
    },
    periodId: 'period-1',
    executionId: 'execution-1',
    conversationId: 'conversation-1',
    launchRef: 'launch-1',
    executionBinding: {
      periodId: 'period-1',
      actor: { kind: 'agent', id: 'actor-1' },
    },
    category: 'ordinary',
    questions: [{
      id: 'question-1',
      text: 'Choose an option',
      mode: 'single',
      options: [{ id: 'option-1', label: 'Yes', description: '' }],
      allowFreeText: false,
      recommendedOptionId: 'option-1',
    }],
    timeoutMinutes: 5,
    createdAt: 10_000,
  });
}

function projectQuestion({ question = null, grant = null } = {}) {
  const sourceBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    revision: 4,
    questions: question === null ? [] : [question],
  }), 'utf8');
  const projection = projectLegacyReclamationMigrationLocal({
    configuredSlots: ['questions'],
    sourceBytesBySlot: { questions: sourceBytes },
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: STARTED_AT,
    migrationAllowanceBySlot: { questions: grant },
  });
  return { projection, sourceBytes };
}

function questionGrant(source, maxExtraBytes, eligibleQuestionIds) {
  return {
    operationId: OPERATION_ID,
    sourceSchemaVersion: source.schemaVersion,
    sourceSizeBytes: source.sizeBytes,
    sourceSha256: source.sha256,
    maxExtraBytes,
    eligibleQuestionIds,
  };
}

test('byte-budget leases share one synchronous cap and failed resize preserves the old lease', () => {
  const budget = createReclamationCapacityBudget({ maxAdditionalBytes: 100 });
  const first = budget.acquire(30);
  const second = budget.acquire(70);

  assert.deepEqual(budget.status(), {
    maxAdditionalBytes: 100,
    reservedBytes: 100,
    availableBytes: 0,
    activeLeaseCount: 2,
  });
  assert.throws(() => budget.acquire(1), { code: 'reclamation_capacity_exceeded' });
  assert.throws(() => first.resize(31), { code: 'reclamation_capacity_exceeded' });
  assert.deepEqual(first.status(), { bytes: 30, released: false });

  first.resize(20);
  assert.deepEqual(budget.status(), {
    maxAdditionalBytes: 100,
    reservedBytes: 90,
    availableBytes: 10,
    activeLeaseCount: 2,
  });
  assert.equal(first.release(), true);
  assert.equal(first.release(), false);
  assert.deepEqual(first.status(), { bytes: 0, released: true });
  assert.deepEqual(second.status(), { bytes: 70, released: false });
  assert.deepEqual(budget.status(), {
    maxAdditionalBytes: 100,
    reservedBytes: 70,
    availableBytes: 30,
    activeLeaseCount: 1,
  });
});

test('byte-budget leases accept exact safe-integer capacity without overflowing', () => {
  const budget = createReclamationCapacityBudget({ maxAdditionalBytes: Number.MAX_SAFE_INTEGER });
  const lease = budget.acquire(Number.MAX_SAFE_INTEGER);
  assert.equal(budget.status().reservedBytes, Number.MAX_SAFE_INTEGER);
  assert.throws(() => budget.acquire(1), { code: 'reclamation_capacity_exceeded' });
  lease.release();
  assert.equal(budget.status().availableBytes, Number.MAX_SAFE_INTEGER);
  assert.throws(() => budget.acquire(Number.MAX_SAFE_INTEGER + 1), {
    name: 'TypeError', message: 'invalid_reclamation_capacity_budget',
  });
});

test('store capacity reserves active anchor M and measures future stores against B plus fixed G', () => {
  const emptyLegacy = projectQuestion();
  const source = emptyLegacy.projection.slots.questions.source;
  const granted = projectQuestion({
    grant: questionGrant(source, 1, []),
  }).projection;
  const configuredSlots = ['questions'];
  const active = measureReclamationStoreCapacity(storeMeasurementInput(granted, configuredSlots, {
    rawSizeBytesBySlot: { questions: source.sizeBytes },
  }));

  assert.equal(active.anchor.limitBytes, FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes);
  assert.equal(active.anchor.reserveBytes, FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes);
  assert.equal(active.slots.questions.grantBytes, 1);
  assert.equal(active.slots.questions.limitBytes, MAX_SOURCE_BYTES + 1);
  assert.equal(active.slots.questions.fitsNormal, true);

  const normal = emptyPlan(configuredSlots);
  const normalInput = storeMeasurementInput(normal, configuredSlots);
  const normalMeasured = measureReclamationStoreCapacity(normalInput);
  assert.equal(normalMeasured.anchor.limitBytes, NORMAL_ANCHOR_MAX_BYTES);
  assert.equal(normalMeasured.anchor.reserveBytes,
    encodeQuestionReclamationAnchorV1Local({
      ...normal.anchor,
      revision: Number.MAX_SAFE_INTEGER,
    }).sizeBytes);
  assert.ok(normalMeasured.anchor.reserveBytes < active.anchor.reserveBytes);
});

test('normal anchor reserve includes a future retirement for each active question period', () => {
  const projected = projectQuestion({ question: simpleQuestion() }).projection;
  const stores = structuredClone(storesFromPlan(projected, ['questions']));
  stores.questions.questions[0].quarantinedAt = null;
  stores.questions.reservations[0].quarantinedAt = null;
  stores.questions = normalizeQuestionJournalV2Local(stores.questions);
  const anchor = normalizeQuestionReclamationAnchorV1Local({
    schemaVersion: 1,
    revision: 7,
    storeId: STORE_ID,
    retiredQuestionPeriods: [],
    migration: null,
  });
  const currentQuestionBytes = encodeQuestionJournalV2Local(stores.questions).sizeBytes;
  const input = {
    anchor,
    stores,
    normalByteLimitsBySlot: { questions: MAX_SOURCE_BYTES },
    rawSizeBytesBySlot: { questions: currentQuestionBytes },
    rawAnchorSizeBytes: encodeQuestionReclamationAnchorV1Local(anchor).sizeBytes,
  };
  const reservation = stores.questions.reservations[0];
  const pending = measurePendingQuestionPeriodCapacity(anchor, [{
    identity: reservation.identity,
    periodId: reservation.periodId,
  }]);
  const noPending = measurePendingQuestionPeriodCapacity(anchor, []);
  const measured = measureReclamationStoreCapacity(input);

  assert.equal(measured.anchor.reserveBytes, pending.projectedBytes);
  assert.ok(measured.anchor.reserveBytes > noPending.projectedBytes);
});

test('capacity rejects active grants whose eligible roster differs from the source records', () => {
  const projected = projectQuestion().projection;
  const stores = structuredClone(storesFromPlan(projected, ['questions']));
  const source = projected.slots.questions.source;
  stores.questions.migrationAllowance = questionGrant(source, 1, ['outside-roster']);
  const encodedAnchorBytes = projected.anchorEncoded.sizeBytes;

  const input = {
    anchor: projected.anchor,
    stores,
    normalByteLimitsBySlot: { questions: MAX_SOURCE_BYTES },
    rawSizeBytesBySlot: { questions: source.sizeBytes },
    rawAnchorSizeBytes: encodedAnchorBytes,
  };
  assert.throws(() => measureReclamationStoreCapacity(input), {
    name: 'TypeError', message: 'invalid_reclamation_store_capacity',
  });

  const withQuestion = projectQuestion({ question: simpleQuestion() }).projection;
  const missingRosterStores = structuredClone(storesFromPlan(withQuestion, ['questions']));
  const questionSource = withQuestion.slots.questions.source;
  missingRosterStores.questions.migrationAllowance = questionGrant(questionSource, 1, []);
  assert.throws(() => measureReclamationStoreCapacity({
    anchor: withQuestion.anchor,
    stores: missingRosterStores,
    normalByteLimitsBySlot: { questions: MAX_SOURCE_BYTES },
    rawSizeBytesBySlot: { questions: questionSource.sizeBytes },
    rawAnchorSizeBytes: withQuestion.anchorEncoded.sizeBytes,
  }), { name: 'TypeError', message: 'invalid_reclamation_store_capacity' });

  const overBoundStores = structuredClone(storesFromPlan(projected, ['questions']));
  overBoundStores.questions.migrationAllowance = questionGrant(
    source, FIXED_H_BOUNDS.questions + 1, [],
  );
  assert.throws(() => measureReclamationStoreCapacity({
    anchor: projected.anchor,
    stores: overBoundStores,
    normalByteLimitsBySlot: { questions: MAX_SOURCE_BYTES },
    rawSizeBytesBySlot: { questions: source.sizeBytes },
    rawAnchorSizeBytes: encodedAnchorBytes,
  }));
});

test('capacity rejects raw files above B plus G and future reserves above the same limit', () => {
  const normal = emptyPlan(['questions']);
  const currentBytes = normal.slots.questions.target.sizeBytes;
  assert.throws(() => measureReclamationStoreCapacity(storeMeasurementInput(normal, ['questions'], {
    normalByteLimitsBySlot: { questions: MAX_SOURCE_BYTES },
    rawSizeBytesBySlot: { questions: MAX_SOURCE_BYTES + 1 },
  })), { code: 'reclamation_capacity_exceeded' });

  const mismatched = storeMeasurementInput(normal, ['questions']);
  mismatched.rawSizeBytesBySlot = { questions: currentBytes, checkpoint: 0 };
  assert.throws(() => measureReclamationStoreCapacity(mismatched), {
    name: 'TypeError', message: 'invalid_reclamation_store_capacity',
  });

  const active = projectQuestion().projection;
  const sourceBytes = active.slots.questions.source.sizeBytes;
  const targetBytes = active.slots.questions.target.sizeBytes;
  assert.ok(sourceBytes <= targetBytes);
  assert.throws(() => measureReclamationStoreCapacity({
    anchor: active.anchor,
    stores: storesFromPlan(active, ['questions']),
    normalByteLimitsBySlot: { questions: targetBytes },
    rawSizeBytesBySlot: { questions: sourceBytes },
    rawAnchorSizeBytes: active.anchorEncoded.sizeBytes,
  }), { code: 'reclamation_capacity_exceeded' });
  assert.ok(currentBytes > 0);
});

test('atomic reservation uses the largest prefix-phase peak instead of summing phases', () => {
  const measured = measureReclamationAtomicReservation({
    anchorSizeBytes: 50,
    slotSizeBytesBySlot: { checkpoint: 900, instructions: 200, questions: 100 },
    targetSizeBytesBySlot: { checkpoint: 10, instructions: 10, questions: 1_500 },
    migrationAnchorMaxBytes: 1_000,
    normalAnchorSizeBytes: 100,
  });

  assert.deepEqual(measured, { peakBytes: 3_520, additionalBytes: 2_270 });
});

test('initial creation writes the normal anchor after all configured empty stores', () => {
  const measured = measureReclamationAtomicReservation({
    anchorSizeBytes: 0,
    slotSizeBytesBySlot: { checkpoint: 0, instructions: 0, questions: 0 },
    targetSizeBytesBySlot: { checkpoint: 40, instructions: 20, questions: 60 },
    migrationAnchorMaxBytes: 0,
    normalAnchorSizeBytes: 25,
  });

  assert.deepEqual(measured, { peakBytes: 145, additionalBytes: 145 });
});

test('atomic reservation rejects aggregate safe-integer overflow', () => {
  assert.throws(() => measureReclamationAtomicReservation({
    anchorSizeBytes: 0,
    slotSizeBytesBySlot: { questions: Number.MAX_SAFE_INTEGER },
    targetSizeBytesBySlot: { questions: 1 },
    migrationAnchorMaxBytes: FIXED_ANCHOR_MIGRATION_BOUNDS.migrationAnchorMaxBytes,
    normalAnchorSizeBytes: 1,
  }), { name: 'TypeError', code: 'reclamation_capacity_overflow' });
});
