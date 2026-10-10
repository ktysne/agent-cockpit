'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const {
  decodeCapsuleCheckpointV4Local,
} = require('../src/server/question-capsule-checkpoint-codec');
const {
  decodeQuestionCapsuleJournalV3Local,
} = require('../src/server/question-capsule-journal-codec');
const {
  CAPSULE_LIMITS,
  encodeQuestionRejectionCapsule,
} = require('../src/server/question-rejection-capsule-codec');
const {
  validateQuestionCapsuleFiles,
} = require('../src/server/question-capsule-files-validation');
const { planQuestionCapsuleFileMigration } = require('../src/server/question-capsule-migration-plan');
const {
  MAX_SOURCE_BYTES,
} = require('../src/server/reclamation-capacity-bounds');
const {
  validateReclamationSnapshot,
  validateReclamationStoreWrite,
} = require('../src/server/reclamation-store-consistency');
const { decodeSourceBytes, encodeNormalized } = require('../src/server/reclamation-json-codec');
const { validateQuestionCapsuleWholeRepresentation } = require('../src/server/question-capsule-whole-validation');
const { createQuestionCapsuleMigrationPlanFixture } = require('./helpers/question-capsule-migration-plan-fixtures');

const INVALID_PLAN = 'invalid_question_capsule_file_migration_plan';

function clone(value) {
  return structuredClone(value);
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function assertInvalid(input) {
  assert.throws(() => planQuestionCapsuleFileMigration(input), {
    name: 'TypeError',
    message: INVALID_PLAN,
  });
}

function assertOldOracle(fixture) {
  const whole = validateQuestionCapsuleWholeRepresentation(fixture.wholeInput);
  assert.deepEqual(plain(whole.snapshot), plain(fixture.snapshot));
  const ready = validateReclamationSnapshot(fixture.snapshot);
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.reasons, []);
  const checked = validateReclamationStoreWrite({
    anchor: fixture.snapshot.anchor,
    previousStores: fixture.snapshot.stores,
    nextStores: fixture.snapshot.stores,
    normalByteLimitsBySlot: fixture.input.normalByteLimitsBySlot,
  });
  assert.equal(checked.status, 'checked');
  assert.deepEqual(checked.reasons, []);
}

function restorePlan(fixture, plan) {
  const questionFile = decodeQuestionCapsuleJournalV3Local(plan.targets.questions.bytes);
  const checkpointFile = plan.targets.checkpoint === null
    ? null
    : decodeCapsuleCheckpointV4Local(plan.targets.checkpoint.bytes);
  return validateQuestionCapsuleFiles({
    anchor: fixture.snapshot.anchor,
    questionFile,
    checkpointFile,
    instructionStore: fixture.snapshot.stores.instructions,
    normalByteLimitsBySlot: fixture.input.normalByteLimitsBySlot,
  }).snapshot;
}

function wholeInputFromSources(input) {
  const decode = (bytes) => bytes === null ? null : decodeSourceBytes(bytes, MAX_SOURCE_BYTES).value;
  const anchor = decode(input.sourceBytes.anchor);
  const stores = {
    questions: decode(input.sourceBytes.questions),
    checkpoint: decode(input.sourceBytes.checkpoint),
    instructions: decode(input.sourceBytes.instructions),
  };
  return {
    formatVersion: 1,
    anchor,
    ordinaryStores: stores,
    capsulePairs: [],
    deliveryAttemptOrder: stores.checkpoint?.ledger.deliveries.map((row) => row.deliveryAttemptId) ?? [],
    questionReservationOrder: stores.questions?.reservations.map((row) => row.internalQuestionId) ?? [],
    normalByteLimitsBySlot: input.normalByteLimitsBySlot,
  };
}

function assertOldWholeReady(input) {
  const whole = validateQuestionCapsuleWholeRepresentation(wholeInputFromSources(input));
  const ready = validateReclamationSnapshot(whole.snapshot);
  assert.equal(ready.status, 'ready');
  assert.deepEqual(ready.reasons, []);
  const checked = validateReclamationStoreWrite({
    anchor: whole.snapshot.anchor,
    previousStores: whole.snapshot.stores,
    nextStores: whole.snapshot.stores,
    normalByteLimitsBySlot: input.normalByteLimitsBySlot,
  });
  assert.equal(checked.status, 'checked');
  assert.deepEqual(checked.reasons, []);
  return whole;
}

function tombstoneForDelivery(delivery) {
  return {
    kind: delivery.kind,
    sourceExecutionId: delivery.sourceExecutionId,
    logicalMessageId: delivery.logicalMessageId,
    revision: delivery.revision,
    targetLaunchKey: null,
    sourceLaunchKey: clone(delivery.sourceRef.launchKey),
    payloadDigest: delivery.payloadDigest,
  };
}

function addUnselectedCheckpointRows(fixture, count) {
  const questionStore = decodeSourceBytes(fixture.input.sourceBytes.questions, MAX_SOURCE_BYTES).value;
  const checkpoint = decodeSourceBytes(fixture.input.sourceBytes.checkpoint, MAX_SOURCE_BYTES).value;
  const templateReservation = questionStore.reservations.find((reservation) =>
    reservation.internalQuestionId === 'internal-1');
  const templateDelivery = checkpoint.ledger.deliveries.find((delivery) =>
    delivery.deliveryAttemptId === templateReservation.deliveryIntent.deliveryAttemptId);

  for (let sequence = 0; sequence < count; sequence += 1) {
    const suffix = String(sequence).padStart(4, '0');
    const attemptId = `threshold-attempt-${suffix}`;
    const logicalMessageId = `threshold-logical-${suffix}`;
    const reservation = clone(templateReservation);
    const delivery = clone(templateDelivery);
    reservation.internalQuestionId = `threshold-internal-${suffix}`;
    reservation.questionId = `threshold-public-${suffix}`;
    reservation.deliveryIntent.deliveryAttemptId = attemptId;
    reservation.deliveryIntent.logicalMessageId = logicalMessageId;
    reservation.reclamation.operationId = `c0000000-0000-4000-8000-${String(sequence + 1).padStart(12, '0')}`;
    delivery.deliveryAttemptId = attemptId;
    delivery.logicalMessageId = logicalMessageId;
    delivery.reclamation.operationId = reservation.reclamation.operationId;
    for (const correlation of [delivery.acceptedCorrelation, delivery.appliedCorrelation]) {
      if (correlation) {
        correlation.deliveryAttemptId = attemptId;
        correlation.clientRequestId = attemptId;
        correlation.nativeItemId = `threshold-item-${suffix}`;
        correlation.nativeTurnId = `threshold-turn-${suffix}`;
      }
    }
    questionStore.reservations.push(reservation);
    checkpoint.ledger.deliveries.push(delivery);
    checkpoint.ledger.logicalTombstones.push(tombstoneForDelivery(delivery));
  }

  fixture.input.sourceBytes.questions = encodeNormalized(questionStore).bytes;
  fixture.input.sourceBytes.checkpoint = encodeNormalized(checkpoint).bytes;
}

function createCheckpointNullFixture() {
  const fixture = createQuestionCapsuleMigrationPlanFixture({ internalQuestionIds: ['internal-4'] });
  const questionStore = decodeSourceBytes(fixture.input.sourceBytes.questions, MAX_SOURCE_BYTES).value;
  questionStore.questions = [];
  questionStore.reservations = questionStore.reservations.filter((reservation) =>
    reservation.internalQuestionId === 'internal-4');
  fixture.input.sourceBytes.questions = encodeNormalized(questionStore).bytes;
  fixture.input.sourceBytes.checkpoint = null;
  fixture.input.sourceBytes.instructions = null;
  fixture.input.normalByteLimitsBySlot.checkpoint = null;
  fixture.input.normalByteLimitsBySlot.instructions = null;
  const whole = assertOldWholeReady(fixture.input);
  fixture.snapshot = whole.snapshot;
  fixture.wholeInput = wholeInputFromSources(fixture.input);
  return fixture;
}

function padded(raw, size) {
  assert.ok(raw.byteLength <= size);
  const result = Buffer.alloc(size, 0x20);
  raw.copy(result);
  return result;
}

function proxyWithTrapCounter(value, counter) {
  return new Proxy(value, {
    getPrototypeOf(target) { counter.count += 1; return Object.getPrototypeOf(target); },
    ownKeys(target) { counter.count += 1; return Reflect.ownKeys(target); },
    getOwnPropertyDescriptor(target, key) {
      counter.count += 1;
      return Object.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, receiver) { counter.count += 1; return Reflect.get(target, key, receiver); },
  });
}

test('both provider variants and mixed scopes restore the complete original snapshot', () => {
  for (const options of [
    { provider: 'claude' },
    { provider: 'codex' },
    { provider: 'claude', secondaryProvider: 'codex', ordinaryQuestionSelected: true },
  ]) {
    const fixture = createQuestionCapsuleMigrationPlanFixture(options);
    assertOldOracle(fixture);
    const sourceBefore = Object.fromEntries(Object.entries(fixture.input.sourceBytes).map(([slot, bytes]) =>
      [slot, bytes === null ? null : Buffer.from(bytes)]));
    const selectionBefore = clone(fixture.input.selection);
    const plan = planQuestionCapsuleFileMigration(fixture.input);
    assert.deepEqual(plain(restorePlan(fixture, plan)), plain(fixture.snapshot));
    assert.deepEqual(plan.targets.questions.value.migrationAllowance, null);
    assert.deepEqual(plan.targets.checkpoint.value.migrationAllowance, null);
    assert.deepEqual(plan.targets.questions.value.reservationOrder,
      fixture.snapshot.stores.questions.reservations.map((row) => row.internalQuestionId));
    assert.deepEqual(plan.targets.checkpoint.value.deliveryAttemptOrder,
      fixture.snapshot.stores.checkpoint.ledger.deliveries.map((row) => row.deliveryAttemptId));
    assert.equal(plan.targets.questions.value.questionCapsules.length, plan.selectionSummary.questionChunkCount);
    assert.equal(plan.targets.checkpoint.value.checkpointCapsules.length, plan.selectionSummary.checkpointChunkCount);
    assert.ok(plan.targets.questions.value.questionCapsules.every((entry) =>
      entry.capsule.compactionOperationId === fixture.input.operationId));
    assert.ok(plan.targets.checkpoint.value.checkpointCapsules.every((entry) =>
      entry.capsule.compactionOperationId === fixture.input.operationId));
    assert.deepEqual(plan.sourceFingerprints.instructions, {
      sizeBytes: sourceBefore.instructions.byteLength,
      sha256: createHash('sha256').update(sourceBefore.instructions).digest('hex'),
    });
    assert.deepEqual(fixture.input.selection, selectionBefore);
    for (const slot of Object.keys(sourceBefore)) {
      assert.deepEqual(fixture.input.sourceBytes[slot], sourceBefore[slot]);
    }
    assert.ok(Object.isFrozen(plan.scopeLimitations));
    assert.equal(Object.isFrozen(plan.targets.questions.value), false);
    plan.targets.questions.value.revision += 1;
    assert.equal(fixture.snapshot.stores.questions.revision + 1, plan.targets.questions.value.revision);
  }
});

test('packing is independent of selection order and reports the unused UUID pool', () => {
  const first = createQuestionCapsuleMigrationPlanFixture({
    provider: 'claude',
    secondaryProvider: 'codex',
    ordinaryQuestionSelected: true,
  });
  const second = createQuestionCapsuleMigrationPlanFixture({
    provider: 'claude',
    secondaryProvider: 'codex',
    ordinaryQuestionSelected: true,
  });
  second.input.selection.reverse();
  for (const scope of second.input.selection) scope.internalQuestionIds.reverse();
  const firstPlan = planQuestionCapsuleFileMigration(first.input);
  const secondPlan = planQuestionCapsuleFileMigration(second.input);
  assert.deepEqual(firstPlan.targets.questions.bytes, secondPlan.targets.questions.bytes);
  assert.deepEqual(firstPlan.targets.checkpoint.bytes, secondPlan.targets.checkpoint.bytes);
  assert.deepEqual(firstPlan.usedChunkIds, first.input.chunkIds.slice(0, firstPlan.usedChunkIds.length));
  assert.deepEqual(firstPlan.unusedChunkIds, first.input.chunkIds.slice(firstPlan.usedChunkIds.length));
  assert.ok(firstPlan.unusedChunkIds.length > 0);
});

test('raw source fingerprints cover whitespace, duplicate JSON keys, and nonzero-offset byte views', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture();
  const duplicateKeyRaw = fixture.input.sourceBytes.questions.toString('utf8').replace(
    /"storeId": ("[^"]+")/,
    '"storeId": "ignored-duplicate",\n  "storeId": $1',
  );
  const backing = Buffer.alloc(Buffer.byteLength(duplicateKeyRaw) + 11, 0x33);
  Buffer.from(duplicateKeyRaw).copy(backing, 7);
  const input = clone(fixture.input);
  input.sourceBytes.questions = backing.subarray(7, 7 + Buffer.byteLength(duplicateKeyRaw));
  const plan = planQuestionCapsuleFileMigration(input);
  assert.deepEqual(plain(restorePlan(fixture, plan)), plain(fixture.snapshot));
  assert.deepEqual(plan.sourceFingerprints.questions, {
    sizeBytes: Buffer.byteLength(duplicateKeyRaw),
    sha256: createHash('sha256').update(duplicateKeyRaw, 'utf8').digest('hex'),
  });
  const whitespaceInput = clone(fixture.input);
  whitespaceInput.sourceBytes.questions = Buffer.concat([
    whitespaceInput.sourceBytes.questions,
    Buffer.from('\n  \t', 'utf8'),
  ]);
  const whitespacePlan = planQuestionCapsuleFileMigration(whitespaceInput);
  assert.equal(whitespacePlan.sourceFingerprints.questions.sizeBytes,
    fixture.input.sourceBytes.questions.length + 4);
  assert.notEqual(whitespacePlan.sourceFingerprints.questions.sha256,
    plan.sourceFingerprints.questions.sha256);
});

test('raw Q and CP bytes must fit B even when the normalized stores fit', () => {
  for (const slot of ['questions', 'checkpoint']) {
    const fixture = createQuestionCapsuleMigrationPlanFixture();
    const byteLimit = 100_000;
    fixture.input.normalByteLimitsBySlot[slot] = byteLimit;
    fixture.input.sourceBytes[slot] = padded(fixture.input.sourceBytes[slot], byteLimit);
    const exact = planQuestionCapsuleFileMigration(fixture.input);
    assert.equal(exact.sourceFingerprints[slot].sizeBytes, byteLimit);
    assertOldOracle(fixture);
    fixture.input.normalByteLimitsBySlot[slot] -= 1;
    assertInvalid(fixture.input);
  }
});

test('encoded Q target bytes must also fit B when the old snapshot still fits', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture();
  const baseline = planQuestionCapsuleFileMigration(fixture.input);
  const targetSize = baseline.targets.questions.sizeBytes;
  fixture.input.normalByteLimitsBySlot.questions = targetSize;
  const exactOldWhole = validateQuestionCapsuleWholeRepresentation(wholeInputFromSources(fixture.input));
  assert.equal(validateReclamationSnapshot(exactOldWhole.snapshot).status, 'ready');
  const exact = planQuestionCapsuleFileMigration(fixture.input);
  assert.equal(exact.targets.questions.sizeBytes, targetSize);
  fixture.input.normalByteLimitsBySlot.questions = targetSize - 1;
  const smallerOldWhole = validateQuestionCapsuleWholeRepresentation(wholeInputFromSources(fixture.input));
  assert.equal(validateReclamationSnapshot(smallerOldWhole.snapshot).status, 'ready');
  assertInvalid(fixture.input);
});

test('instruction source bytes may use exactly B plus its verified grant', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture();
  const grantBytes = fixture.snapshot.stores.instructions.migrationAllowance.maxExtraBytes;
  const byteLimit = MAX_SOURCE_BYTES;
  fixture.input.normalByteLimitsBySlot.instructions = byteLimit;
  fixture.input.sourceBytes.instructions = padded(
    fixture.input.sourceBytes.instructions,
    byteLimit + grantBytes,
  );
  const plan = planQuestionCapsuleFileMigration(fixture.input);
  assert.equal(plan.sourceFingerprints.instructions.sizeBytes, byteLimit + grantBytes);
  assert.deepEqual(plain(restorePlan(fixture, plan).stores.instructions.migrationAllowance),
    plain(fixture.snapshot.stores.instructions.migrationAllowance));
  fixture.input.sourceBytes.instructions = Buffer.concat([
    fixture.input.sourceBytes.instructions,
    Buffer.from(' ', 'utf8'),
  ]);
  assertInvalid(fixture.input);
});

test('source and byte-limit null slots must match in both directions before parsing', (t) => {
  const fixtures = [
    (() => {
      const fixture = createQuestionCapsuleMigrationPlanFixture();
      assertOldOracle(fixture);
      fixture.input.normalByteLimitsBySlot.checkpoint = null;
      return fixture;
    })(),
    (() => {
      const fixture = createQuestionCapsuleMigrationPlanFixture();
      assertOldOracle(fixture);
      fixture.input.sourceBytes.checkpoint = null;
      return fixture;
    })(),
  ];
  const parse = JSON.parse;
  let parseCalls = 0;
  t.mock.method(JSON, 'parse', (...args) => {
    parseCalls += 1;
    return parse(...args);
  });
  for (const fixture of fixtures) {
    assertInvalid(fixture.input);
    assert.equal(parseCalls, 0);
  }
});

test('source bytes reject invalid UTF-8 and SharedArrayBuffer-backed views', () => {
  const invalidUtf8 = createQuestionCapsuleMigrationPlanFixture();
  invalidUtf8.input.sourceBytes.instructions = Buffer.concat([
    invalidUtf8.input.sourceBytes.instructions,
    Buffer.from([0xff]),
  ]);
  assertInvalid(invalidUtf8.input);
  const shared = createQuestionCapsuleMigrationPlanFixture();
  const sharedBytes = new Uint8Array(new SharedArrayBuffer(shared.input.sourceBytes.questions.length));
  sharedBytes.set(shared.input.sourceBytes.questions);
  shared.input.sourceBytes.questions = sharedBytes;
  assertInvalid(shared.input);
});

test('byte views use native accessors without invoking subclass getters or iterators', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture();
  let traps = 0;
  class TrappingBytes extends Uint8Array {
    get buffer() { traps += 1; throw new Error('buffer getter ran'); }
    get byteOffset() { traps += 1; throw new Error('offset getter ran'); }
    get byteLength() { traps += 1; throw new Error('length getter ran'); }
    [Symbol.iterator]() { traps += 1; throw new Error('iterator ran'); }
  }
  const raw = fixture.input.sourceBytes.questions;
  const view = new TrappingBytes(raw.length);
  Uint8Array.prototype.set.call(view, raw);
  fixture.input.sourceBytes.questions = view;
  const plan = planQuestionCapsuleFileMigration(fixture.input);
  assert.equal(plan.sourceFingerprints.questions.sizeBytes, raw.length);
  assert.equal(traps, 0);
});

test('Q and CP migration grants are rejected after an old-whole-ready control', () => {
  for (const slot of ['questions', 'checkpoint']) {
    const fixture = createQuestionCapsuleMigrationPlanFixture();
    const store = clone(fixture.snapshot.stores[slot]);
    store.migrationAllowance = clone(fixture.sourceGrants[slot]);
    fixture.input.sourceBytes[slot] = encodeNormalized(store).bytes;
    const whole = assertOldWholeReady(fixture.input);
    assert.deepEqual(plain(whole.snapshot.stores[slot].migrationAllowance),
      plain(fixture.sourceGrants[slot]));
    assertInvalid(fixture.input);
  }
});

test('duplicate scopes and cross-scope IDs reject before parsing a valid old source', (t) => {
  const duplicateScope = createQuestionCapsuleMigrationPlanFixture();
  assertOldOracle(duplicateScope);
  const duplicateScopeInput = clone(duplicateScope.input);
  duplicateScopeInput.selection = [
    clone(duplicateScope.input.selection[0]),
    clone(duplicateScope.input.selection[0]),
  ];

  const repeatedId = createQuestionCapsuleMigrationPlanFixture();
  assertOldOracle(repeatedId);
  const firstScope = clone(repeatedId.input.selection[0]);
  const crossScopeInput = clone(repeatedId.input);
  crossScopeInput.selection = [firstScope, {
    identity: clone(firstScope.identity),
    periodId: `${firstScope.periodId}-other`,
    internalQuestionIds: [firstScope.internalQuestionIds[0]],
  }];

  const parse = JSON.parse;
  let parseCalls = 0;
  t.mock.method(JSON, 'parse', (...args) => {
    parseCalls += 1;
    return parse(...args);
  });
  for (const input of [duplicateScopeInput, crossScopeInput]) {
    assertInvalid(input);
    assert.equal(parseCalls, 0);
  }
});

test('empty selections and empty scope IDs reject before parsing a valid old source', (t) => {
  const fixture = createQuestionCapsuleMigrationPlanFixture();
  assertOldOracle(fixture);
  const emptySelection = clone(fixture.input);
  emptySelection.selection = [];
  const emptyScopeIds = clone(fixture.input);
  emptyScopeIds.selection[0].internalQuestionIds = [];

  const parse = JSON.parse;
  let parseCalls = 0;
  t.mock.method(JSON, 'parse', (...args) => {
    parseCalls += 1;
    return parse(...args);
  });
  for (const input of [emptySelection, emptyScopeIds]) {
    assertInvalid(input);
    assert.equal(parseCalls, 0);
  }
});

test('a none-only selection supports a null checkpoint file and instruction slot', () => {
  const fixture = createCheckpointNullFixture();
  const plan = planQuestionCapsuleFileMigration(fixture.input);
  assert.equal(plan.targets.checkpoint, null);
  assert.equal(plan.sourceFingerprints.checkpoint, null);
  assert.equal(plan.sourceFingerprints.instructions, null);
  assert.equal(plan.selectionSummary.questionReservationCount, 1);
  assert.equal(plan.selectionSummary.checkpointDeliveryCount, 0);
  assert.equal(plan.selectionSummary.checkpointChunkCount, 0);
  assert.deepEqual(plain(restorePlan(fixture, plan)), plain(fixture.snapshot));
  assert.deepEqual(plan.unusedChunkIds, fixture.input.chunkIds.slice(1));
});

test('an indeterminate selected reservation keeps its delivery lookup absent', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({ internalQuestionIds: ['internal-4'] });
  const questionStore = decodeSourceBytes(fixture.input.sourceBytes.questions, MAX_SOURCE_BYTES).value;
  const reservation = questionStore.reservations.find((row) => row.internalQuestionId === 'internal-4');
  reservation.deliveryCreationState = 'indeterminate';
  reservation.checkpointState = 'unknown';
  reservation.sourceClaimsDigest = null;
  reservation.sessionId = null;
  reservation.terminalResultKind = null;
  reservation.reclamation.deliveryPresence = 'indeterminate';
  reservation.reclamation.checkpointState = 'unknown';
  fixture.input.sourceBytes.questions = encodeNormalized(questionStore).bytes;
  const oldWhole = validateQuestionCapsuleWholeRepresentation(wholeInputFromSources(fixture.input));
  assert.equal(validateReclamationSnapshot(oldWhole.snapshot).status, 'ready');
  const plan = planQuestionCapsuleFileMigration(fixture.input);
  assert.equal(plan.selectionSummary.checkpointDeliveryCount, 0);
  assert.equal(plan.selectionSummary.checkpointChunkCount, 0);
  assert.deepEqual(plain(restorePlan(fixture, plan)), plain(oldWhole.snapshot));
});

test('unused chunk IDs are validated and insufficient or duplicate pools reject', () => {
  const unusedInvalid = createQuestionCapsuleMigrationPlanFixture();
  unusedInvalid.input.chunkIds[unusedInvalid.input.chunkIds.length - 1] = 'not-a-uuid';
  assertInvalid(unusedInvalid.input);
  const duplicate = createQuestionCapsuleMigrationPlanFixture();
  duplicate.input.chunkIds[1] = duplicate.input.chunkIds[0];
  assertInvalid(duplicate.input);
  const insufficient = createQuestionCapsuleMigrationPlanFixture();
  insufficient.input.chunkIds = [];
  assertInvalid(insufficient.input);
});

test('a selected reservation must exist and be reclaimed in its exact retired scope', () => {
  const missing = createQuestionCapsuleMigrationPlanFixture();
  assertOldOracle(missing);
  missing.input.selection[0].internalQuestionIds[0] = 'missing-reservation';
  assertInvalid(missing.input);

  const unreclaimed = createQuestionCapsuleMigrationPlanFixture({ internalQuestionIds: ['internal-5'] });
  assertOldOracle(unreclaimed);
  const retained = unreclaimed.snapshot.stores.questions.reservations.find((row) =>
    row.internalQuestionId === 'internal-5');
  assert.equal(retained.bodyState, 'retained');
  assert.deepEqual(unreclaimed.input.selection[0].identity, retained.identity);
  assert.equal(unreclaimed.input.selection[0].periodId, retained.periodId);
  assertInvalid(unreclaimed.input);
});

test('an old-whole source rejects after its selected reclaimed scope loses retired evidence', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({ internalQuestionIds: ['internal-4'] });
  assertOldOracle(fixture);
  const selectedScope = clone(fixture.input.selection[0]);
  const anchor = decodeSourceBytes(fixture.input.sourceBytes.anchor, MAX_SOURCE_BYTES).value;
  anchor.retiredQuestionPeriods = anchor.retiredQuestionPeriods.filter((period) =>
    !(period.periodId === selectedScope.periodId &&
      period.identity.nativeId === selectedScope.identity.nativeId));
  fixture.input.sourceBytes.anchor = encodeNormalized(anchor).bytes;

  const questionStore = decodeSourceBytes(fixture.input.sourceBytes.questions, MAX_SOURCE_BYTES).value;
  const selected = questionStore.reservations.find((row) =>
    row.internalQuestionId === selectedScope.internalQuestionIds[0]);
  assert.equal(selected.bodyState, 'reclaimed');
  assert.deepEqual(selected.identity, selectedScope.identity);
  assert.equal(selected.periodId, selectedScope.periodId);
  assert.throws(() => validateReclamationSnapshot({ anchor, stores: {
    questions: questionStore,
    checkpoint: decodeSourceBytes(fixture.input.sourceBytes.checkpoint, MAX_SOURCE_BYTES).value,
    instructions: decodeSourceBytes(fixture.input.sourceBytes.instructions, MAX_SOURCE_BYTES).value,
  } }), { name: 'TypeError', message: 'invalid_reclamation_snapshot' });
  assertInvalid(fixture.input);
});

test('a live unretired reservation cannot be selected for migration', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({
    ordinaryQuestionSelected: true,
    internalQuestionIds: ['internal-5'],
  });
  assertOldOracle(fixture);
  const reservation = fixture.snapshot.stores.questions.reservations.find((row) =>
    row.internalQuestionId === 'internal-5');
  assert.equal(reservation.bodyState, 'retained');
  assert.equal(reservation.quarantinedAt, null);
  assert.ok(!fixture.snapshot.anchor.retiredQuestionPeriods.some((period) =>
    period.periodId === reservation.periodId && period.identity.nativeId === reservation.identity.nativeId));
  assert.deepEqual(fixture.input.selection[0].identity, reservation.identity);
  assert.equal(fixture.input.selection[0].periodId, reservation.periodId);
  assertInvalid(fixture.input);
});

test('unselected deliveries in a selected logical group reject the whole plan', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({ internalQuestionIds: ['internal-1'] });
  const checkpoint = decodeSourceBytes(fixture.input.sourceBytes.checkpoint, MAX_SOURCE_BYTES).value;
  const questionStore = decodeSourceBytes(fixture.input.sourceBytes.questions, MAX_SOURCE_BYTES).value;
  const reservation = questionStore.reservations.find((row) => row.internalQuestionId === 'internal-1');
  const index = checkpoint.ledger.deliveries.findIndex((row) =>
    row.deliveryAttemptId === reservation.deliveryIntent.deliveryAttemptId);
  const siblingReservation = clone(reservation);
  siblingReservation.internalQuestionId = 'unselected-sibling-reservation';
  siblingReservation.questionId = 'unselected-sibling-question';
  siblingReservation.deliveryIntent.deliveryAttemptId = 'unselected-sibling-attempt';
  siblingReservation.reclamation.operationId = 'c0000000-0000-4000-8000-000000000001';
  siblingReservation.reclamation.checkpointState = 'superseded_before_send';
  siblingReservation.checkpointState = 'superseded_before_send';
  siblingReservation.terminalResultKind = 'superseded_before_send';
  questionStore.reservations.push(siblingReservation);
  const siblingDelivery = clone(checkpoint.ledger.deliveries[index]);
  siblingDelivery.deliveryAttemptId = siblingReservation.deliveryIntent.deliveryAttemptId;
  siblingDelivery.state = 'superseded_before_send';
  siblingDelivery.terminalAt = 2_000_100;
  siblingDelivery.reclamation.operationId = siblingReservation.reclamation.operationId;
  checkpoint.ledger.deliveries.splice(index, 0, siblingDelivery);
  fixture.input.sourceBytes.questions = encodeNormalized(questionStore).bytes;
  fixture.input.sourceBytes.checkpoint = encodeNormalized(checkpoint).bytes;
  const oldWhole = validateQuestionCapsuleWholeRepresentation(wholeInputFromSources(fixture.input));
  assert.equal(validateReclamationSnapshot(oldWhole.snapshot).status, 'ready');
  assertInvalid(fixture.input);
});

test('a scope with 257 reclaimed no-delivery reservations splits at the 256-entry cap', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({ internalQuestionIds: ['internal-4'] });
  const questionStore = decodeSourceBytes(fixture.input.sourceBytes.questions, MAX_SOURCE_BYTES).value;
  const template = questionStore.reservations.find((row) => row.internalQuestionId === 'internal-4');
  const ids = [];
  for (let index = 0; index < 257; index += 1) {
    const suffix = String(index).padStart(4, '0');
    const internalQuestionId = `split-internal-${suffix}`;
    const reservation = clone(template);
    reservation.internalQuestionId = internalQuestionId;
    reservation.questionId = `split-public-${suffix}`;
    reservation.deliveryIntent.deliveryAttemptId = `split-attempt-${suffix}`;
    reservation.deliveryIntent.logicalMessageId = `split-logical-${suffix}`;
    reservation.reclamation.operationId = `c0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    questionStore.reservations.push(reservation);
    ids.push(internalQuestionId);
  }
  fixture.input.sourceBytes.questions = encodeNormalized(questionStore).bytes;
  fixture.input.selection = [{
    identity: clone(template.identity),
    periodId: template.periodId,
    internalQuestionIds: ids,
  }];
  fixture.input.chunkIds = fixture.input.chunkIds.slice(0, 2);
  const oldWhole = validateQuestionCapsuleWholeRepresentation(wholeInputFromSources(fixture.input));
  assert.equal(validateReclamationSnapshot(oldWhole.snapshot).status, 'ready');
  const plan = planQuestionCapsuleFileMigration(fixture.input);
  assert.equal(plan.selectionSummary.questionReservationCount, 257);
  assert.equal(plan.selectionSummary.questionChunkCount, 2);
  assert.deepEqual(plan.targets.questions.value.questionCapsules.map((entry) =>
    entry.capsule.reservations.length), [256, 1]);
});

test('a scope splits at the 1 MiB capsule byte limit before reaching 256 entries', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({ internalQuestionIds: ['internal-4'] });
  const questionStore = decodeSourceBytes(fixture.input.sourceBytes.questions, MAX_SOURCE_BYTES).value;
  const template = questionStore.reservations.find((row) => row.internalQuestionId === 'internal-4');
  const ids = ['internal-4'];
  const escapedSuffix = '\uD800';
  const longIdentifier = (kind, index) => {
    const prefix = `${kind}-${String(index).padStart(3, '0')}-`;
    return prefix + escapedSuffix.repeat(512 - prefix.length);
  };

  for (let index = 0; index < 100; index += 1) {
    const reservation = clone(template);
    reservation.internalQuestionId = longIdentifier('large-internal', index);
    reservation.questionId = longIdentifier('large-public', index);
    reservation.deliveryIntent.deliveryAttemptId = longIdentifier('large-attempt', index);
    reservation.deliveryIntent.logicalMessageId = longIdentifier('large-logical', index);
    reservation.reclamation.operationId =
      `c0000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`;
    questionStore.reservations.push(reservation);
    ids.push(reservation.internalQuestionId);
  }

  fixture.input.sourceBytes.questions = encodeNormalized(questionStore).bytes;
  fixture.input.selection = [{
    identity: clone(template.identity),
    periodId: template.periodId,
    internalQuestionIds: ids,
  }];
  fixture.input.chunkIds = fixture.input.chunkIds.slice(0, 4);
  const oldWhole = validateQuestionCapsuleWholeRepresentation(wholeInputFromSources(fixture.input));
  assert.equal(validateReclamationSnapshot(oldWhole.snapshot).status, 'ready');

  const plan = planQuestionCapsuleFileMigration(fixture.input);
  const questionCapsules = plan.targets.questions.value.questionCapsules;
  const chunkLengths = questionCapsules.map((entry) => entry.capsule.reservations.length);
  assert.equal(plan.selectionSummary.questionReservationCount, ids.length);
  assert.equal(chunkLengths.length, 2);
  assert.ok(chunkLengths.every((length) => length < CAPSULE_LIMITS.maxQuestionEntries));
  assert.ok(questionCapsules.every((entry) =>
    encodeQuestionRejectionCapsule(entry.capsule).sizeBytes <= CAPSULE_LIMITS.maxQuestionBytes));
  assert.deepEqual(plain(restorePlan(fixture, plan)), plain(oldWhole.snapshot));

  const firstChunk = questionCapsules[0].capsule;
  const firstRowOfNextChunk = questionCapsules[1].capsule.reservations[0];
  assert.throws(() => encodeQuestionRejectionCapsule({
    ...firstChunk,
    reservations: [...firstChunk.reservations, firstRowOfNextChunk],
  }), { name: 'RangeError', message: 'question_capsule_too_large' });
});

test('encoded CP target bytes fit B exactly and reject B-1 after both old controls pass', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture();
  addUnselectedCheckpointRows(fixture, 768);
  const baseline = planQuestionCapsuleFileMigration(fixture.input);
  const targetSize = baseline.targets.checkpoint.sizeBytes;
  const rawCheckpointSize = fixture.input.sourceBytes.checkpoint.byteLength;
  assert.ok(rawCheckpointSize < targetSize - 1);

  fixture.input.normalByteLimitsBySlot.checkpoint = targetSize;
  const exactOldWhole = assertOldWholeReady(fixture.input);
  assert.ok(rawCheckpointSize <= fixture.input.normalByteLimitsBySlot.checkpoint);
  const exact = planQuestionCapsuleFileMigration(fixture.input);
  assert.equal(exact.targets.checkpoint.sizeBytes, targetSize);
  fixture.snapshot = exactOldWhole.snapshot;
  assert.deepEqual(plain(restorePlan(fixture, exact)), plain(exactOldWhole.snapshot));

  fixture.input.normalByteLimitsBySlot.checkpoint = targetSize - 1;
  const smallerOldWhole = assertOldWholeReady(fixture.input);
  assert.ok(rawCheckpointSize <= fixture.input.normalByteLimitsBySlot.checkpoint);
  assert.deepEqual(plain(smallerOldWhole.snapshot), plain(exactOldWhole.snapshot));
  assertInvalid(fixture.input);
});

test('input proxies and accessors are rejected before their traps run', () => {
  const cases = [
    (fixture, counter) => proxyWithTrapCounter(fixture.input, counter),
    (fixture, counter) => ({
      ...fixture.input,
      sourceBytes: proxyWithTrapCounter(fixture.input.sourceBytes, counter),
    }),
    (fixture, counter) => ({
      ...fixture.input,
      normalByteLimitsBySlot: proxyWithTrapCounter(fixture.input.normalByteLimitsBySlot, counter),
    }),
    (fixture, counter) => ({ ...fixture.input, selection: proxyWithTrapCounter(fixture.input.selection, counter) }),
    (fixture, counter) => ({
      ...fixture.input,
      selection: [proxyWithTrapCounter(fixture.input.selection[0], counter)],
    }),
    (fixture, counter) => ({
      ...fixture.input,
      selection: [{
        ...fixture.input.selection[0],
        identity: proxyWithTrapCounter(fixture.input.selection[0].identity, counter),
      }],
    }),
    (fixture, counter) => ({
      ...fixture.input,
      selection: [{
        ...fixture.input.selection[0],
        internalQuestionIds: proxyWithTrapCounter(fixture.input.selection[0].internalQuestionIds, counter),
      }],
    }),
    (fixture, counter) => ({ ...fixture.input, chunkIds: proxyWithTrapCounter(fixture.input.chunkIds, counter) }),
    (fixture, counter) => ({
      ...fixture.input,
      sourceBytes: {
        ...fixture.input.sourceBytes,
        questions: proxyWithTrapCounter(fixture.input.sourceBytes.questions, counter),
      },
    }),
  ];
  for (const makeInput of cases) {
    const fixture = createQuestionCapsuleMigrationPlanFixture();
    const counter = { count: 0 };
    assertInvalid(makeInput(fixture, counter));
    assert.equal(counter.count, 0);
  }

  const getterFixture = createQuestionCapsuleMigrationPlanFixture();
  let getterCount = 0;
  Object.defineProperty(getterFixture.input, 'operationId', {
    enumerable: true,
    get() { getterCount += 1; return '77777777-7777-4777-8777-777777777777'; },
  });
  assertInvalid(getterFixture.input);
  assert.equal(getterCount, 0);
});

test('bounded arrays check their length before reflecting elements', (t) => {
  const fixture = createQuestionCapsuleMigrationPlanFixture();
  const oversizedScopes = new Array(20_001).fill({});
  const oversizedChunkIds = new Array(20_001).fill('a0000000-0000-4000-8000-000000000001');
  const oversizedIds = new Array(20_001).fill('oversized-selection-id');
  const oversizedIdInput = {
    ...fixture.input,
    selection: [{
      ...fixture.input.selection[0],
      internalQuestionIds: oversizedIds,
    }],
  };
  const exactScopes = new Array(20_000).fill({});
  const exactIds = Array.from({ length: 20_000 }, (_, index) => `boundary-id-${index}`);
  const exactIdsInput = {
    ...fixture.input,
    selection: [{ ...fixture.input.selection[0], internalQuestionIds: exactIds }],
  };
  const exactChunkIds = new Array(20_000).fill('a0000000-0000-4000-8000-000000000001');
  const watchedArrays = new Set([oversizedScopes, oversizedChunkIds, oversizedIds, exactScopes, exactIds, exactChunkIds]);
  const reflectionCounts = new Map([...watchedArrays].map((array) => [array, 0]));
  const originalOwnKeys = Reflect.ownKeys;
  t.mock.method(Reflect, 'ownKeys', (value) => {
    if (watchedArrays.has(value)) reflectionCounts.set(value, reflectionCounts.get(value) + 1);
    return originalOwnKeys(value);
  });

  assertInvalid({ ...fixture.input, selection: oversizedScopes });
  assert.equal(reflectionCounts.get(oversizedScopes), 0);
  assertInvalid({ ...fixture.input, chunkIds: oversizedChunkIds });
  assert.equal(reflectionCounts.get(oversizedChunkIds), 0);
  assertInvalid(oversizedIdInput);
  assert.equal(reflectionCounts.get(oversizedIds), 0);
  assertInvalid({ ...fixture.input, selection: exactScopes });
  assert.ok(reflectionCounts.get(exactScopes) > 0);
  assertInvalid(exactIdsInput);
  assert.ok(reflectionCounts.get(exactIds) > 0);
  assertInvalid({ ...fixture.input, chunkIds: exactChunkIds });
  assert.ok(reflectionCounts.get(exactChunkIds) > 0);
});

test('aggregate selected IDs are bounded at 20,000 before parsing source bytes', (t) => {
  const fixture = createQuestionCapsuleMigrationPlanFixture();
  const firstIdentity = clone(fixture.input.selection[0].identity);
  const secondIdentity = { ...firstIdentity, nativeId: `${firstIdentity.nativeId}-other` };
  const makeSelection = (firstCount, secondCount) => [
    {
      identity: clone(firstIdentity),
      periodId: 'aggregate-a',
      internalQuestionIds: Array.from({ length: firstCount }, (_, index) => `aggregate-a-${index}`),
    },
    {
      identity: clone(secondIdentity),
      periodId: 'aggregate-b',
      internalQuestionIds: Array.from({ length: secondCount }, (_, index) => `aggregate-b-${index}`),
    },
  ];
  const parse = JSON.parse;
  let sourceParseCalls = 0;
  t.mock.method(JSON, 'parse', (...args) => {
    sourceParseCalls += 1;
    return parse(...args);
  });
  fixture.input.selection = makeSelection(10_001, 10_000);
  assertInvalid(fixture.input);
  assert.equal(sourceParseCalls, 0);
  fixture.input.selection = makeSelection(10_000, 10_000);
  assertInvalid(fixture.input);
  assert.ok(sourceParseCalls > 0);
});
