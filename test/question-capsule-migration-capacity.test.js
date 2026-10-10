'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { types } = require('node:util');
const {
  assessQuestionCapsuleMigrationCapacity,
} = require('../src/server/question-capsule-migration-capacity');
const { createQuestionCapsulePrepareManifest } = require('../src/server/question-capsule-prepare-manifest-codec');
const {
  createQuestionCapsulePreparedMaterial,
  validateQuestionCapsulePreparedMaterial,
} = require('../src/server/question-capsule-prepared-material-codec');
const { planQuestionCapsuleFileMigration } = require('../src/server/question-capsule-migration-plan');
const {
  FIXED_H_BOUNDS,
  MAX_SOURCE_BYTES,
  NORMAL_ANCHOR_MAX_BYTES,
  measureInstructionReservation,
} = require('../src/server/reclamation-capacity-bounds');
const {
  measureCheckpointCapsuleExistingUpdateReservation,
  measureQuestionCapsuleExistingUpdateReservation,
} = require('../src/server/question-capsule-existing-update-capacity');
const { normalizeInstructionJournalV2Local } =
  require('../src/server/delivery-reclamation-codec');
const { decodeSourceBytes, encodeNormalized } = require('../src/server/reclamation-json-codec');
const { createQuestionCapsuleMigrationPlanFixture } =
  require('./helpers/question-capsule-migration-plan-fixtures');

const INVALID_CAPACITY = 'invalid_question_capsule_migration_capacity';
const PROTOCOL_ASSUMPTIONS = [
  'all_writers_stopped',
  'original_anchor_and_instruction_bytes_unchanged',
  'one_operation_at_a_time',
  'single_atomic_temp_at_a_time',
  'no_unknown_orphan_or_backup_files',
  'prepared_material_immutable_until_complete',
  'old_and_target_future_reservations_retained_until_complete',
];
const SCOPE_LIMITATIONS = [
  'restricted_capacity_assessment_only',
  'configuration_provenance_not_verified',
  'source_freshness_and_writer_exclusion_not_verified',
  'persistent_grant_protocol_not_applied',
  'additional_operation_lease_accounting_not_verified',
  'orphan_and_external_files_not_counted',
  'filesystem_allocation_and_os_durability_not_verified',
  'atomic_write_and_readback_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'runtime_integration_not_verified',
];

function buildPreparedFixture(options = {}, mutateInput = null) {
  const fixture = createQuestionCapsuleMigrationPlanFixture(options);
  if (mutateInput) mutateInput(fixture.input);
  const manifest = createQuestionCapsulePrepareManifest(fixture.input);
  const plan = planQuestionCapsuleFileMigration(fixture.input);
  const prepared = createQuestionCapsulePreparedMaterial({
    manifest: manifest.manifest,
    sourceBytes: fixture.input.sourceBytes,
    targetBytes: {
      questions: plan.targets.questions.bytes,
      checkpoint: plan.targets.checkpoint?.bytes ?? null,
    },
  });
  return { fixture, manifest, plan, prepared };
}

function buildQuestionLimitBundle(options = {}, questionLimit) {
  return buildPreparedFixture(options, (input) => {
    input.normalByteLimitsBySlot.questions = questionLimit;
  });
}

function buildCheckpointLimitBundle(options = {}, checkpointLimit) {
  return buildPreparedFixture(options, (input) => {
    input.normalByteLimitsBySlot.checkpoint = checkpointLimit;
  });
}

function buildAtEnvelopeLimit(options = {}, delta = 0) {
  let probe = buildPreparedFixture(options);
  let questionLimit = probe.prepared.bytes.length + delta;
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const bundle = buildQuestionLimitBundle(options, questionLimit);
    const difference = bundle.prepared.bytes.length - questionLimit;
    if (difference === delta) return bundle;
    questionLimit = bundle.prepared.bytes.length - delta;
    probe = bundle;
  }
  throw new Error(`prepared envelope limit did not converge: ${probe.prepared.bytes.length}`);
}

function assessmentInput(bundle) {
  const source = bundle.fixture.input.sourceBytes;
  return {
    materialBytes: Buffer.from(bundle.prepared.bytes),
    anchorBytes: Buffer.from(source.anchor),
    instructionBytes: source.instructions === null ? null : Buffer.from(source.instructions),
    expectedNormalByteLimitsBySlot: structuredClone(bundle.fixture.input.normalByteLimitsBySlot),
  };
}

function assess(bundle) {
  return assessQuestionCapsuleMigrationCapacity(assessmentInput(bundle));
}

function assertFullMaterial(bundle) {
  return validateQuestionCapsulePreparedMaterial({
    material: bundle.prepared.material,
    anchorBytes: bundle.fixture.input.sourceBytes.anchor,
    instructionBytes: bundle.fixture.input.sourceBytes.instructions,
  });
}

function assertInvalid(value) {
  assert.throws(() => assessQuestionCapsuleMigrationCapacity(value), {
    name: 'TypeError',
    message: INVALID_CAPACITY,
  });
}

function sumSlots(slots) {
  return slots.anchor + slots.instructions + slots.questions + slots.checkpoint;
}

function snapshotInput(input) {
  return {
    material: Buffer.from(input.materialBytes).toString('base64'),
    anchor: Buffer.from(input.anchorBytes).toString('base64'),
    instructions: input.instructionBytes === null ? null : Buffer.from(input.instructionBytes).toString('base64'),
    limits: structuredClone(input.expectedNormalByteLimitsBySlot),
  };
}

function accessoredView(bytes, calls) {
  const byteOffset = 5;
  const backingCopy = new Uint8Array(bytes.byteLength + byteOffset + 3);
  backingCopy.set(bytes, byteOffset);
  const backing = backingCopy.buffer;
  const byteLength = bytes.byteLength;
  Object.defineProperty(backing, 'byteLength', {
    configurable: true,
    get() { calls.count += 1; throw new Error('unexpected ArrayBuffer byteLength getter'); },
  });
  class AccessoredUint8Array extends Uint8Array {
    static get [Symbol.species]() { calls.count += 1; throw new Error('unexpected species getter'); }
  }
  const view = new AccessoredUint8Array(backing, byteOffset, byteLength);
  Object.defineProperties(view, {
    buffer: { configurable: true, get() { calls.count += 1; throw new Error('unexpected buffer getter'); } },
    byteOffset: { configurable: true, get() { calls.count += 1; throw new Error('unexpected offset getter'); } },
    byteLength: { configurable: true, get() { calls.count += 1; throw new Error('unexpected length getter'); } },
    constructor: { configurable: true, get() { calls.count += 1; throw new Error('unexpected constructor getter'); } },
    [Symbol.iterator]: { configurable: true, get() { calls.count += 1; throw new Error('unexpected iterator getter'); } },
  });
  return view;
}

function makeCheckpointNull(bundleInput) {
  const question = decodeSourceBytes(bundleInput.sourceBytes.questions, MAX_SOURCE_BYTES).value;
  question.questions = [];
  question.reservations = question.reservations.filter((reservation) =>
    reservation.internalQuestionId === 'internal-4');
  bundleInput.sourceBytes.questions = encodeNormalized(question).bytes;
  bundleInput.sourceBytes.checkpoint = null;
  bundleInput.sourceBytes.instructions = null;
  bundleInput.normalByteLimitsBySlot.checkpoint = null;
  bundleInput.normalByteLimitsBySlot.instructions = null;
}

test('both providers and mixed scopes return detached restricted capacity tables', () => {
  for (const options of [
    { provider: 'claude' },
    { provider: 'codex' },
    { provider: 'claude', secondaryProvider: 'codex', ordinaryQuestionSelected: true },
  ]) {
    const bundle = buildPreparedFixture(options);
    const input = assessmentInput(bundle);
    const before = snapshotInput(input);
    const result = assessQuestionCapsuleMigrationCapacity(input);

    assert.deepEqual(Object.keys(result), [
      'stableBoundsFit', 'stableBoundsFitBySlot', 'measurements', 'boundaries',
      'singleTempCandidates', 'protocolAssumptions', 'scopeLimitations',
    ]);
    assert.equal(result.stableBoundsFit, true);
    assert.deepEqual(result.stableBoundsFitBySlot, {
      anchor: true,
      questions: true,
      checkpoint: true,
      instructions: true,
    });
    assert.deepEqual(result.protocolAssumptions, PROTOCOL_ASSUMPTIONS);
    assert.deepEqual(result.scopeLimitations, SCOPE_LIMITATIONS);
    assert.equal(Object.isFrozen(result.protocolAssumptions), true);
    assert.equal(Object.isFrozen(result.scopeLimitations), true);
    assert.equal(Object.isFrozen(result), false);
    assert.equal(Object.isFrozen(result.measurements), false);
    assert.equal(Object.isFrozen(result.boundaries.source.currentBytesBySlot), false);

    const measurement = result.measurements;
    const sourceBytes = bundle.fixture.input.sourceBytes;
    assert.equal(measurement.anchor.rawCurrentBytes, sourceBytes.anchor.length);
    assert.equal(measurement.anchor.reservedBytes >= measurement.anchor.rawCurrentBytes, true);
    assert.equal(measurement.instructions.rawCurrentBytes, sourceBytes.instructions.length);
    assert.ok(measurement.instructions.grantedExtraBytes > 0);
    assert.equal(measurement.source.questions.rawCurrentBytes, sourceBytes.questions.length);
    assert.equal(measurement.source.checkpoint.rawCurrentBytes, sourceBytes.checkpoint.length);
    assert.equal(measurement.prepared.questions.rawCurrentBytes, bundle.prepared.bytes.length);
    assert.equal(measurement.target.questions.rawCurrentBytes, bundle.plan.targets.questions.bytes.length);
    assert.equal(measurement.target.checkpoint.rawCurrentBytes, bundle.plan.targets.checkpoint.bytes.length);

    const sourceBoundary = result.boundaries.source;
    assert.deepEqual(sourceBoundary.currentBytesBySlot, {
      anchor: sourceBytes.anchor.length,
      instructions: sourceBytes.instructions.length,
      questions: sourceBytes.questions.length,
      checkpoint: sourceBytes.checkpoint.length,
    });
    assert.equal(sourceBoundary.currentTotalBytes, sumSlots(sourceBoundary.currentBytesBySlot));
    assert.equal(sourceBoundary.protectedTotalBytes, sumSlots(sourceBoundary.protectedBytesBySlot));
    assert.equal(sourceBoundary.protectedBytesBySlot.anchor,
      Math.max(measurement.anchor.rawCurrentBytes, measurement.anchor.reservedBytes));
    assert.equal(sourceBoundary.protectedBytesBySlot.instructions,
      Math.max(measurement.instructions.rawCurrentBytes, measurement.instructions.reservedBytes));
    assert.equal(sourceBoundary.protectedBytesBySlot.questions,
      Math.max(measurement.source.questions.rawCurrentBytes,
        measurement.source.questions.reservedBytes, measurement.target.questions.reservedBytes));
    assert.equal(sourceBoundary.protectedBytesBySlot.checkpoint,
      Math.max(measurement.source.checkpoint.rawCurrentBytes,
        measurement.source.checkpoint.reservedBytes, measurement.target.checkpoint.reservedBytes));

    const preparedBoundary = result.boundaries.prepared;
    assert.equal(preparedBoundary.currentBytesBySlot.questions, bundle.prepared.bytes.length);
    assert.equal(preparedBoundary.currentBytesBySlot.checkpoint, sourceBytes.checkpoint.length);
    assert.equal(preparedBoundary.protectedBytesBySlot.questions,
      Math.max(bundle.prepared.bytes.length, measurement.source.questions.reservedBytes,
        measurement.target.questions.reservedBytes));
    const movedBoundary = result.boundaries.checkpoint_moved;
    assert.equal(movedBoundary.currentBytesBySlot.checkpoint, bundle.plan.targets.checkpoint.bytes.length);
    assert.equal(movedBoundary.currentBytesBySlot.questions, bundle.prepared.bytes.length);
    assert.equal(movedBoundary.protectedBytesBySlot.checkpoint,
      Math.max(measurement.target.checkpoint.rawCurrentBytes,
        measurement.source.checkpoint.reservedBytes, measurement.target.checkpoint.reservedBytes));
    const completeBoundary = result.boundaries.complete;
    assert.equal(completeBoundary.protectedBytesBySlot.questions,
      Math.max(measurement.target.questions.rawCurrentBytes, measurement.target.questions.reservedBytes));
    assert.equal(completeBoundary.protectedBytesBySlot.checkpoint,
      Math.max(measurement.target.checkpoint.rawCurrentBytes, measurement.target.checkpoint.reservedBytes));
    for (const boundary of Object.values(result.boundaries)) {
      assert.equal(boundary.currentTotalBytes, sumSlots(boundary.currentBytesBySlot));
      assert.equal(boundary.protectedTotalBytes, sumSlots(boundary.protectedBytesBySlot));
    }

    const temp = result.singleTempCandidates;
    assert.deepEqual(temp.questionPrepare, {
      beforeBoundary: 'source',
      tempBytes: bundle.prepared.bytes.length,
      logicalBytes: sourceBoundary.currentTotalBytes + bundle.prepared.bytes.length,
      conditionalReservationBytes: sourceBoundary.protectedTotalBytes + bundle.prepared.bytes.length,
    });
    assert.deepEqual(temp.checkpointTarget, {
      beforeBoundary: 'prepared',
      tempBytes: bundle.plan.targets.checkpoint.bytes.length,
      logicalBytes: preparedBoundary.currentTotalBytes + bundle.plan.targets.checkpoint.bytes.length,
      conditionalReservationBytes: preparedBoundary.protectedTotalBytes + bundle.plan.targets.checkpoint.bytes.length,
    });
    assert.deepEqual(temp.questionTarget, {
      beforeBoundary: 'checkpoint_moved',
      tempBytes: bundle.plan.targets.questions.bytes.length,
      logicalBytes: movedBoundary.currentTotalBytes + bundle.plan.targets.questions.bytes.length,
      conditionalReservationBytes: movedBoundary.protectedTotalBytes + bundle.plan.targets.questions.bytes.length,
    });
    assert.deepEqual(snapshotInput(input), before);

    result.measurements.source.questions.rawCurrentBytes = 0;
    const fresh = assessQuestionCapsuleMigrationCapacity(input);
    assert.equal(fresh.measurements.source.questions.rawCurrentBytes, sourceBytes.questions.length);
  }
});

test('checkpoint-null materials omit checkpoint stages and preserve null slot tags', () => {
  const bundle = buildPreparedFixture({ internalQuestionIds: ['internal-4'] }, (input) => makeCheckpointNull(input));
  assert.doesNotThrow(() => assertFullMaterial(bundle));
  const result = assess(bundle);

  assert.equal(result.stableBoundsFit, true);
  assert.deepEqual(result.stableBoundsFitBySlot, {
    anchor: true,
    questions: true,
    checkpoint: null,
    instructions: null,
  });
  assert.deepEqual(Object.keys(result.boundaries), ['source', 'prepared', 'complete']);
  assert.deepEqual(Object.keys(result.singleTempCandidates), ['questionPrepare', 'questionTarget']);
  assert.equal(result.singleTempCandidates.questionTarget.beforeBoundary, 'prepared');
  assert.equal(result.measurements.source.checkpoint, null);
  assert.equal(result.measurements.target.checkpoint, null);
  for (const boundary of Object.values(result.boundaries)) {
    assert.equal(boundary.currentBytesBySlot.checkpoint, 0);
    assert.equal(boundary.protectedBytesBySlot.checkpoint, 0);
  }
});

test('legacy raw whitespace and duplicate JSON keys remain counted as source bytes', () => {
  const bundle = buildPreparedFixture({ provider: 'codex' }, (input) => {
    const questionText = input.sourceBytes.questions.toString('utf8');
    const storeId = questionText.match(/"storeId":\s*"[^"]+"/);
    assert.ok(storeId);
    const duplicate = questionText.replace(storeId[0], `${storeId[0]},\n  ${storeId[0]}`);
    input.sourceBytes.questions = Buffer.from(`${duplicate}\n \t`, 'utf8');
    input.sourceBytes.checkpoint = Buffer.concat([input.sourceBytes.checkpoint, Buffer.from('\n \t', 'utf8')]);
  });
  const result = assess(bundle);

  assert.equal(result.measurements.source.questions.rawCurrentBytes,
    bundle.fixture.input.sourceBytes.questions.length);
  assert.equal(result.measurements.source.checkpoint.rawCurrentBytes,
    bundle.fixture.input.sourceBytes.checkpoint.length);
  assert.ok(result.measurements.source.questions.rawCurrentBytes >
    result.measurements.source.questions.normalizedCurrentBytes);
  assert.ok(result.measurements.source.checkpoint.rawCurrentBytes >
    result.measurements.source.checkpoint.normalizedCurrentBytes);
  assert.deepEqual(Buffer.from(bundle.prepared.material.sourceQuestionBytesBase64, 'base64'),
    bundle.fixture.input.sourceBytes.questions);
  assert.deepEqual(Buffer.from(bundle.prepared.material.sourceCheckpointBytesBase64, 'base64'),
    bundle.fixture.input.sourceBytes.checkpoint);
});

test('prepared-envelope equality and one-byte excess are measured from rebuilt material', () => {
  const equalBundle = buildAtEnvelopeLimit({}, 0);
  assert.equal(equalBundle.prepared.bytes.length, equalBundle.fixture.input.normalByteLimitsBySlot.questions);
  assert.doesNotThrow(() => assertFullMaterial(equalBundle));
  const equalResult = assess(equalBundle);
  assert.equal(equalResult.measurements.prepared.questions.rawCurrentBytes,
    equalBundle.fixture.input.normalByteLimitsBySlot.questions);
  assert.equal(equalResult.stableBoundsFitBySlot.questions, true);
  assert.equal(equalResult.stableBoundsFit, true);

  const plusOneBundle = buildAtEnvelopeLimit({}, 1);
  const questionLimit = plusOneBundle.fixture.input.normalByteLimitsBySlot.questions;
  assert.equal(plusOneBundle.prepared.bytes.length, questionLimit + 1);
  assert.doesNotThrow(() => assertFullMaterial(plusOneBundle));
  const plusOneResult = assess(plusOneBundle);
  assert.equal(plusOneResult.measurements.source.questions.reservedBytes <= questionLimit, true);
  assert.equal(plusOneResult.measurements.target.questions.rawCurrentBytes <= questionLimit, true);
  assert.equal(plusOneResult.measurements.target.questions.reservedBytes <= questionLimit, true);
  assert.equal(plusOneResult.stableBoundsFitBySlot.questions, false);
  assert.equal(plusOneResult.stableBoundsFit, false);
});

test('target Q future overage is distinct from source and target-current fit', () => {
  const options = { provider: 'claude', secondaryProvider: 'codex', ordinaryQuestionSelected: true };
  const probe = buildPreparedFixture(options);
  const probeResult = assess(probe);
  const targetFuture = probeResult.measurements.target.questions.reservedBytes;
  const questionLimit = targetFuture - 1;
  assert.ok(probeResult.measurements.prepared.questions.rawCurrentBytes < questionLimit);
  assert.ok(probeResult.measurements.source.questions.reservedBytes < questionLimit);
  assert.ok(probeResult.measurements.target.questions.rawCurrentBytes < questionLimit);

  const bundle = buildQuestionLimitBundle(options, questionLimit);
  assert.doesNotThrow(() => assertFullMaterial(bundle));
  const result = assess(bundle);
  assert.equal(result.measurements.prepared.questions.rawCurrentBytes <= questionLimit, true);
  assert.equal(result.measurements.source.questions.reservedBytes <= questionLimit, true);
  assert.equal(result.measurements.target.questions.rawCurrentBytes <= questionLimit, true);
  assert.equal(result.measurements.target.questions.reservedBytes, targetFuture);
  assert.ok(result.measurements.target.questions.reservedBytes > questionLimit);
  assert.equal(result.stableBoundsFitBySlot.questions, false);
  assert.equal(result.stableBoundsFit, false);

  const exactBundle = buildQuestionLimitBundle(options, targetFuture);
  assert.doesNotThrow(() => assertFullMaterial(exactBundle));
  const exactResult = assess(exactBundle);
  assert.equal(exactResult.measurements.target.questions.reservedBytes, targetFuture);
  assert.equal(exactResult.stableBoundsFitBySlot.questions, true);
  assert.equal(exactResult.stableBoundsFit, true);
});

test('CP target future boundary is measured independently while old capacity still fits', () => {
  const options = { internalQuestionIds: ['internal-4'] };
  const probe = buildPreparedFixture(options);
  const probeResult = assess(probe);
  const targetFuture = probeResult.measurements.target.checkpoint.reservedBytes;
  assert.ok(probeResult.measurements.source.checkpoint.reservedBytes < targetFuture);
  assert.ok(probeResult.measurements.target.checkpoint.rawCurrentBytes < targetFuture);

  const bundle = buildCheckpointLimitBundle(options, targetFuture);
  assert.doesNotThrow(() => assertFullMaterial(bundle));
  const result = assess(bundle);
  assert.equal(result.measurements.source.checkpoint.reservedBytes <= targetFuture, true);
  assert.equal(result.measurements.target.checkpoint.rawCurrentBytes <= targetFuture, true);
  assert.equal(result.measurements.target.checkpoint.reservedBytes, targetFuture);
  assert.equal(result.stableBoundsFitBySlot.checkpoint, true);
  assert.equal(result.stableBoundsFit, true);

  const belowBundle = buildCheckpointLimitBundle(options, targetFuture - 1);
  assert.doesNotThrow(() => assertFullMaterial(belowBundle));
  const belowResult = assess(belowBundle);
  assert.ok(belowResult.measurements.source.checkpoint.reservedBytes < targetFuture - 1);
  assert.ok(belowResult.measurements.target.checkpoint.rawCurrentBytes < targetFuture - 1);
  assert.equal(belowResult.measurements.target.checkpoint.reservedBytes, targetFuture);
  assert.equal(belowResult.stableBoundsFitBySlot.checkpoint, false);
  assert.equal(belowResult.stableBoundsFit, false);
});

test('instruction grant remains in its slot and covers the exact B plus G boundary', () => {
  const baseline = buildPreparedFixture();
  const sourceInstruction = normalizeInstructionJournalV2Local(
    decodeSourceBytes(baseline.fixture.input.sourceBytes.instructions, MAX_SOURCE_BYTES).value,
  );
  const grantBytes = sourceInstruction.migrationAllowance.maxExtraBytes;
  assert.ok(grantBytes > 0 && grantBytes <= FIXED_H_BOUNDS.instructions);
  const initialMeasure = measureInstructionReservation({
    snapshot: sourceInstruction,
    currentByteLimit: baseline.fixture.input.normalByteLimitsBySlot.instructions,
  });
  const instructionLimit = initialMeasure.reservedBytes - grantBytes;
  assert.ok(instructionLimit > 0);

  const bundle = buildPreparedFixture({}, (input) => {
    input.normalByteLimitsBySlot.instructions = instructionLimit;
  });
  assert.doesNotThrow(() => assertFullMaterial(bundle));
  const result = assess(bundle);
  assert.equal(result.measurements.instructions.grantedExtraBytes, grantBytes);
  assert.equal(result.measurements.instructions.reservedBytes, instructionLimit + grantBytes);
  assert.equal(result.measurements.instructions.rawCurrentBytes <= instructionLimit + grantBytes, true);
  assert.equal(result.boundaries.source.protectedBytesBySlot.instructions,
    Math.max(result.measurements.instructions.rawCurrentBytes, result.measurements.instructions.reservedBytes));
  assert.equal(result.stableBoundsFitBySlot.instructions, true);
  assert.equal(result.stableBoundsFitBySlot.questions, true);
  assert.equal(result.stableBoundsFitBySlot.checkpoint, true);
});

test('expected limits, canonical material bytes, and raw input records fail with one error', () => {
  const bundle = buildPreparedFixture();
  const valid = assessmentInput(bundle);
  const mismatchedLimits = structuredClone(valid.expectedNormalByteLimitsBySlot);
  mismatchedLimits.questions += 1;
  assertInvalid({ ...valid, expectedNormalByteLimitsBySlot: mismatchedLimits });
  assertInvalid({ ...valid, materialBytes: Buffer.concat([valid.materialBytes, Buffer.from(' \n')]) });
  assertInvalid({ ...valid, expectedNormalByteLimitsBySlot: { ...valid.expectedNormalByteLimitsBySlot, checkpoint: null } });

  let trapCalls = 0;
  const proxyRecord = new Proxy(valid, {
    ownKeys() { trapCalls += 1; throw new Error('unexpected record proxy trap'); },
    get() { trapCalls += 1; throw new Error('unexpected record proxy trap'); },
  });
  assertInvalid(proxyRecord);
  const proxyMaterial = new Proxy(valid.materialBytes, {
    get() { trapCalls += 1; throw new Error('unexpected byte proxy trap'); },
  });
  assertInvalid({ ...valid, materialBytes: proxyMaterial });
  const proxyLimits = new Proxy(valid.expectedNormalByteLimitsBySlot, {
    ownKeys() { trapCalls += 1; throw new Error('unexpected limit proxy trap'); },
  });
  assertInvalid({ ...valid, expectedNormalByteLimitsBySlot: proxyLimits });
  const getterRecord = { ...valid };
  Object.defineProperty(getterRecord, 'anchorBytes', {
    enumerable: true,
    get() { trapCalls += 1; throw new Error('unexpected input getter'); },
  });
  assertInvalid(getterRecord);
  const getterLimits = { ...valid.expectedNormalByteLimitsBySlot };
  Object.defineProperty(getterLimits, 'questions', {
    enumerable: true,
    get() { trapCalls += 1; throw new Error('unexpected limit getter'); },
  });
  assertInvalid({ ...valid, expectedNormalByteLimitsBySlot: getterLimits });
  assert.equal(trapCalls, 0);

  const calls = { count: 0 };
  const accessored = {
    ...valid,
    materialBytes: accessoredView(valid.materialBytes, calls),
    anchorBytes: accessoredView(valid.anchorBytes, calls),
    instructionBytes: accessoredView(valid.instructionBytes, calls),
  };
  assert.doesNotThrow(() => assessQuestionCapsuleMigrationCapacity(accessored));
  assert.equal(calls.count, 0);

  const sharedBytes = new Uint8Array(new SharedArrayBuffer(valid.materialBytes.length));
  assert.equal(types.isSharedArrayBuffer(sharedBytes.buffer), true);
  assertInvalid({ ...valid, materialBytes: sharedBytes });
});

test('external raw inputs one byte over their limits are rejected', () => {
  const valid = assessmentInput(buildPreparedFixture());
  const oversizedMaterial = new Uint8Array(MAX_SOURCE_BYTES + 1);
  assertInvalid({ ...valid, materialBytes: oversizedMaterial });
  const oversizedAnchor = new Uint8Array(NORMAL_ANCHOR_MAX_BYTES + 1);
  assertInvalid({ ...valid, anchorBytes: oversizedAnchor });
  const oversizedInstructions = new Uint8Array(MAX_SOURCE_BYTES + FIXED_H_BOUNDS.instructions + 1);
  assertInvalid({ ...valid, instructionBytes: oversizedInstructions });
});
