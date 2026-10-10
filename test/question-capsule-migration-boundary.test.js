'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { types } = require('node:util');
const { classifyQuestionCapsuleMigrationBoundary } = require('../src/server/question-capsule-migration-boundary');
const {
  createQuestionCapsulePrepareManifest,
} = require('../src/server/question-capsule-prepare-manifest-codec');
const {
  createQuestionCapsulePreparedMaterial,
  encodeQuestionCapsulePreparedMaterial,
} = require('../src/server/question-capsule-prepared-material-codec');
const { planQuestionCapsuleFileMigration } = require('../src/server/question-capsule-migration-plan');
const { FIXED_H_BOUNDS, MAX_SOURCE_BYTES, NORMAL_ANCHOR_MAX_BYTES } = require('../src/server/reclamation-capacity-bounds');
const { decodeSourceBytes, encodeNormalized } = require('../src/server/reclamation-json-codec');
const { createQuestionCapsuleMigrationPlanFixture } = require('./helpers/question-capsule-migration-plan-fixtures');

const INVALID_BOUNDARY = 'invalid_question_capsule_migration_boundary';
const INSTRUCTION_MAX_BYTES = MAX_SOURCE_BYTES + FIXED_H_BOUNDS.instructions;
const SCOPE_LIMITATIONS = [
  'boundary_bytes_only',
  'material_durable_availability_not_verified',
  'source_freshness_not_verified',
  'trusted_limits_not_verified',
  'orphan_and_external_files_not_counted',
  'atomic_peak_and_admission_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'runtime_integration_not_verified',
];

function checkpointNullFixture() {
  const fixture = createQuestionCapsuleMigrationPlanFixture({ internalQuestionIds: ['internal-4'] });
  const questions = decodeSourceBytes(fixture.input.sourceBytes.questions, MAX_SOURCE_BYTES).value;
  questions.questions = [];
  questions.reservations = questions.reservations.filter((row) => row.internalQuestionId === 'internal-4');
  fixture.input.sourceBytes.questions = encodeNormalized(questions).bytes;
  fixture.input.sourceBytes.checkpoint = null;
  fixture.input.sourceBytes.instructions = null;
  fixture.input.normalByteLimitsBySlot.checkpoint = null;
  fixture.input.normalByteLimitsBySlot.instructions = null;
  return fixture;
}

function preparedFixture(options = {}, fixtureFactory = createQuestionCapsuleMigrationPlanFixture) {
  const fixture = fixtureFactory(options);
  const manifest = createQuestionCapsulePrepareManifest(fixture.input);
  const plan = planQuestionCapsuleFileMigration(fixture.input);
  const targetBytes = {
    questions: plan.targets.questions.bytes,
    checkpoint: plan.targets.checkpoint?.bytes ?? null,
  };
  const prepared = createQuestionCapsulePreparedMaterial({
    manifest: manifest.manifest,
    sourceBytes: fixture.input.sourceBytes,
    targetBytes,
  });
  return { fixture, manifest, plan, prepared, targetBytes };
}

function argsFor(bundle, boundary) {
  const { fixture, plan, prepared } = bundle;
  const source = fixture.input.sourceBytes;
  const targetCheckpoint = plan.targets.checkpoint?.bytes ?? null;
  const questionByBoundary = {
    source: source.questions,
    prepared: prepared.bytes,
    checkpoint_moved: prepared.bytes,
    complete: plan.targets.questions.bytes,
  };
  const checkpointByBoundary = {
    source: source.checkpoint,
    prepared: source.checkpoint,
    checkpoint_moved: targetCheckpoint,
    complete: targetCheckpoint,
  };
  return {
    materialBytes: prepared.bytes,
    anchorBytes: source.anchor,
    instructionBytes: source.instructions,
    questionBytes: questionByBoundary[boundary],
    checkpointBytes: checkpointByBoundary[boundary],
  };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function expectedFingerprint(bytes) {
  return bytes === null ? null : { sizeBytes: bytes.length, sha256: sha256(bytes) };
}

function assertInvalid(value) {
  assert.throws(() => classifyQuestionCapsuleMigrationBoundary(value), {
    name: 'TypeError',
    message: INVALID_BOUNDARY,
  });
}

function reverseObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (value === null || typeof value !== 'object') return value;
  const reversed = {};
  for (const key of Object.keys(value).reverse()) reversed[key] = reverseObjectKeys(value[key]);
  return reversed;
}

function replaceFirstIndentSpaceWithTab(bytes) {
  const changed = Buffer.from(bytes);
  const marker = changed.indexOf(Buffer.from('\n '));
  assert.ok(marker >= 0);
  changed[marker + 1] = 0x09;
  return changed;
}

function accessoredView(bytes, calls) {
  const byteOffset = 3;
  const backingCopy = new Uint8Array(bytes.byteLength + byteOffset + 2);
  backingCopy.set(bytes, byteOffset);
  const byteLength = bytes.byteLength;
  const backing = backingCopy.buffer;
  Object.defineProperty(backing, 'byteLength', {
    configurable: true,
    get() { calls.count += 1; throw new Error('unexpected ArrayBuffer getter'); },
  });
  class AccessoredUint8Array extends Uint8Array {
    static get [Symbol.species]() { calls.count += 1; throw new Error('unexpected species getter'); }
  }
  const view = new AccessoredUint8Array(backing, byteOffset, byteLength);
  Object.defineProperties(view, {
    buffer: { configurable: true, get() { calls.count += 1; throw new Error('unexpected buffer getter'); } },
    byteOffset: { configurable: true, get() { calls.count += 1; throw new Error('unexpected offset getter'); } },
    byteLength: { configurable: true, get() { calls.count += 1; throw new Error('unexpected length getter'); } },
    [Symbol.iterator]: { configurable: true, get() { calls.count += 1; throw new Error('unexpected iterator getter'); } },
  });
  return view;
}

test('the four present-checkpoint boundaries are classified from exact bytes for both providers and mixed scopes', () => {
  for (const options of [
    { provider: 'claude' },
    { provider: 'codex' },
    { provider: 'claude', secondaryProvider: 'codex', ordinaryQuestionSelected: true },
    { provider: 'codex', secondaryProvider: 'claude', ordinaryQuestionSelected: true },
  ]) {
    const bundle = preparedFixture(options);
    for (const boundary of ['source', 'prepared', 'checkpoint_moved', 'complete']) {
      const input = argsFor(bundle, boundary);
      const before = Object.fromEntries(Object.entries(input).map(([field, bytes]) =>
        [field, bytes === null ? null : Buffer.from(bytes)]));
      const result = classifyQuestionCapsuleMigrationBoundary(input);
      const current = {
        anchor: input.anchorBytes,
        instructions: input.instructionBytes,
        questions: input.questionBytes,
        checkpoint: input.checkpointBytes,
      };
      const expectedSizes = Object.fromEntries(Object.entries(current).map(([slot, bytes]) =>
        [slot, bytes?.length ?? 0]));

      assert.deepEqual(Object.keys(result), [
        'boundary', 'checkpointPresent', 'observedFingerprints', 'currentBytesBySlot',
        'currentTotalBytes', 'scopeLimitations',
      ]);
      assert.equal(result.boundary, boundary);
      assert.equal(result.checkpointPresent, true);
      assert.deepEqual(result.currentBytesBySlot, expectedSizes);
      assert.equal(result.currentTotalBytes, Object.values(expectedSizes).reduce((sum, size) => sum + size, 0));
      assert.deepEqual(result.observedFingerprints, Object.fromEntries(Object.entries(current).map(
        ([slot, bytes]) => [slot, expectedFingerprint(bytes)])));
      assert.deepEqual(result.scopeLimitations, SCOPE_LIMITATIONS);
      assert.equal(Object.isFrozen(result.scopeLimitations), true);
      assert.equal(Object.isFrozen(result), false);
      assert.equal(Object.isFrozen(result.currentBytesBySlot), false);
      assert.equal(Object.isFrozen(result.observedFingerprints.anchor), false);
      assert.deepEqual(Object.fromEntries(Object.entries(input).map(([field, bytes]) =>
        [field, bytes === null ? null : Buffer.from(bytes)])), before);
    }
  }
});

test('checkpoint-null material has exactly source, prepared, and complete boundaries', () => {
  const bundle = preparedFixture({}, checkpointNullFixture);
  for (const boundary of ['source', 'prepared', 'complete']) {
    const result = classifyQuestionCapsuleMigrationBoundary(argsFor(bundle, boundary));
    assert.equal(result.boundary, boundary);
    assert.equal(result.checkpointPresent, false);
    assert.equal(result.currentBytesBySlot.checkpoint, 0);
    assert.equal(result.observedFingerprints.checkpoint, null);
  }
  assertInvalid({
    ...argsFor(bundle, 'prepared'),
    checkpointBytes: Buffer.from('unexpected checkpoint'),
  });
});

test('noncanonical legacy Q and CP raw bytes remain exact source boundary evidence', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({});
  for (const slot of ['questions', 'checkpoint']) {
    const raw = fixture.input.sourceBytes[slot].toString('utf8');
    const duplicateStoreId = raw.replace(/"storeId": ("[^"]+")/,
      '"storeId": "ignored-duplicate",\n  "storeId": $1');
    assert.notEqual(duplicateStoreId, raw);
    fixture.input.sourceBytes[slot] = Buffer.from(`${duplicateStoreId}\n \t`, 'utf8');
  }
  const bundle = preparedFixture({}, () => fixture);
  const result = classifyQuestionCapsuleMigrationBoundary(argsFor(bundle, 'source'));
  assert.equal(result.boundary, 'source');
  assert.deepEqual(Buffer.from(bundle.prepared.material.sourceQuestionBytesBase64, 'base64'),
    fixture.input.sourceBytes.questions);
  assert.deepEqual(Buffer.from(bundle.prepared.material.sourceCheckpointBytesBase64, 'base64'),
    fixture.input.sourceBytes.checkpoint);
});

test('a same-size semantically valid CP reformat is rejected as a different boundary', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({});
  const originalCheckpoint = fixture.input.sourceBytes.checkpoint;
  const reformattedCheckpoint = replaceFirstIndentSpaceWithTab(originalCheckpoint);
  assert.equal(reformattedCheckpoint.length, originalCheckpoint.length);
  assert.equal(reformattedCheckpoint.equals(originalCheckpoint), false);
  assert.deepEqual(decodeSourceBytes(reformattedCheckpoint, MAX_SOURCE_BYTES).value,
    decodeSourceBytes(originalCheckpoint, MAX_SOURCE_BYTES).value);
  fixture.input.sourceBytes.checkpoint = reformattedCheckpoint;
  const bundle = preparedFixture({}, () => fixture);
  assert.equal(classifyQuestionCapsuleMigrationBoundary(argsFor(bundle, 'source')).boundary, 'source');

  const reformattedCurrentCheckpoint = Buffer.from(originalCheckpoint);
  assert.equal(reformattedCurrentCheckpoint.length, bundle.fixture.input.sourceBytes.checkpoint.length);
  assert.deepEqual(decodeSourceBytes(reformattedCurrentCheckpoint, MAX_SOURCE_BYTES).value,
    decodeSourceBytes(bundle.fixture.input.sourceBytes.checkpoint, MAX_SOURCE_BYTES).value);
  assertInvalid({ ...argsFor(bundle, 'source'), checkpointBytes: reformattedCurrentCheckpoint });
});

test('mixed Q and CP boundary pairs, noncanonical material bytes, and mismatched anchor or instructions fail closed', () => {
  const bundle = preparedFixture();
  assertInvalid({ ...argsFor(bundle, 'source'), checkpointBytes: bundle.plan.targets.checkpoint.bytes });
  assertInvalid({ ...argsFor(bundle, 'source'), questionBytes: bundle.plan.targets.questions.bytes });
  assertInvalid({
    ...argsFor(bundle, 'source'),
    materialBytes: Buffer.concat([bundle.prepared.bytes, Buffer.from(' \n')]),
  });
  assertInvalid({
    ...argsFor(bundle, 'source'),
    anchorBytes: Buffer.concat([bundle.fixture.input.sourceBytes.anchor, Buffer.from(' ')]),
  });
  assertInvalid({
    ...argsFor(bundle, 'source'),
    instructionBytes: Buffer.concat([bundle.fixture.input.sourceBytes.instructions, Buffer.from(' ')]),
  });

  const otherOperation = structuredClone(bundle.prepared.material);
  otherOperation.manifest.operationId = '88888888-8888-4888-8888-888888888888';
  const encodedOperation = encodeQuestionCapsulePreparedMaterial(otherOperation);
  assertInvalid({ ...argsFor(bundle, 'source'), materialBytes: encodedOperation.bytes });

  const otherStore = structuredClone(bundle.prepared.material);
  otherStore.manifest.storeId = '99999999-9999-4999-8999-999999999999';
  const encodedStore = encodeQuestionCapsulePreparedMaterial(otherStore);
  assertInvalid({ ...argsFor(bundle, 'source'), materialBytes: encodedStore.bytes });
});

test('the reported logical byte table includes actual instruction grant bytes and all four canonical raw slots', () => {
  const bundle = preparedFixture();
  const decodedInstructions = decodeSourceBytes(bundle.fixture.input.sourceBytes.instructions,
    MAX_SOURCE_BYTES).value;
  assert.ok(decodedInstructions.migrationAllowance.maxExtraBytes > 0);
  const input = argsFor(bundle, 'source');
  const result = classifyQuestionCapsuleMigrationBoundary(input);
  assert.equal(result.currentBytesBySlot.instructions, input.instructionBytes.length);
  assert.equal(result.currentBytesBySlot.anchor, input.anchorBytes.length);
  assert.equal(result.currentBytesBySlot.questions, input.questionBytes.length);
  assert.equal(result.currentBytesBySlot.checkpoint, input.checkpointBytes.length);
  assert.equal(result.currentTotalBytes, input.anchorBytes.length + input.instructionBytes.length +
    input.questionBytes.length + input.checkpointBytes.length);
  result.currentBytesBySlot.questions = 0;
  result.observedFingerprints.anchor.sha256 = '0'.repeat(64);
  const freshResult = classifyQuestionCapsuleMigrationBoundary(input);
  assert.equal(freshResult.currentBytesBySlot.questions, input.questionBytes.length);
  assert.equal(freshResult.observedFingerprints.anchor.sha256, sha256(input.anchorBytes));
});

test('input records, byte views, backing buffers, and raw proxies are inspected without invoking traps', () => {
  const bundle = preparedFixture();
  const validInput = argsFor(bundle, 'source');
  let trapCalls = 0;
  const proxyRecord = new Proxy(validInput, {
    ownKeys() { trapCalls += 1; throw new Error('unexpected ownKeys trap'); },
    get() { trapCalls += 1; throw new Error('unexpected get trap'); },
  });
  assertInvalid(proxyRecord);
  assert.equal(trapCalls, 0);

  const getterRecord = { ...validInput };
  Object.defineProperty(getterRecord, 'anchorBytes', {
    enumerable: true,
    get() { trapCalls += 1; throw new Error('unexpected record getter'); },
  });
  assertInvalid(getterRecord);
  assert.equal(trapCalls, 0);

  const proxyBytes = new Proxy(validInput.materialBytes, {
    get() { trapCalls += 1; throw new Error('unexpected byte proxy trap'); },
  });
  assertInvalid({ ...validInput, materialBytes: proxyBytes });
  assert.equal(trapCalls, 0);
  assert.equal(types.isProxy(proxyBytes), true);

  const calls = { count: 0 };
  const accessoredInput = Object.fromEntries(Object.entries(validInput).map(([field, bytes]) =>
    [field, bytes === null ? null : accessoredView(bytes, calls)]));
  assert.doesNotThrow(() => classifyQuestionCapsuleMigrationBoundary(accessoredInput));
  assert.equal(calls.count, 0);

  const shared = new Uint8Array(new SharedArrayBuffer(validInput.materialBytes.length));
  assertInvalid({ ...validInput, materialBytes: shared });
});

test('raw byte limits are enforced for material, anchor, instructions, questions, and checkpoint', () => {
  const bundle = preparedFixture();
  const baseline = argsFor(bundle, 'source');
  const oversizedNormal = new Uint8Array(MAX_SOURCE_BYTES + 1);
  const oversizedAnchor = new Uint8Array(NORMAL_ANCHOR_MAX_BYTES + 1);
  const oversizedInstructions = new Uint8Array(INSTRUCTION_MAX_BYTES + 1);
  for (const [slot, bytes] of [
    ['materialBytes', oversizedNormal],
    ['anchorBytes', oversizedAnchor],
    ['instructionBytes', oversizedInstructions],
    ['questionBytes', oversizedNormal],
    ['checkpointBytes', oversizedNormal],
  ]) {
    assertInvalid({ ...baseline, [slot]: bytes });
  }
  for (const slot of ['materialBytes', 'anchorBytes', 'instructionBytes', 'questionBytes', 'checkpointBytes']) {
    assertInvalid({ ...baseline, [slot]: Buffer.alloc(0) });
  }
});
