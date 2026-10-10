'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { test } = require('node:test');
const { types } = require('node:util');
const {
  createQuestionCapsulePrepareManifest,
  normalizeQuestionCapsulePrepareManifest,
  validateQuestionCapsulePrepareEvidence,
} = require('../src/server/question-capsule-prepare-manifest-codec');
const {
  createQuestionCapsulePreparedMaterial,
  decodeQuestionCapsulePreparedMaterial,
  encodeQuestionCapsulePreparedMaterial,
  normalizeQuestionCapsulePreparedMaterial,
  validateQuestionCapsulePreparedMaterial,
} = require('../src/server/question-capsule-prepared-material-codec');
const { planQuestionCapsuleFileMigration } = require('../src/server/question-capsule-migration-plan');
const { FIXED_H_BOUNDS, MAX_SOURCE_BYTES } = require('../src/server/reclamation-capacity-bounds');
const { decodeSourceBytes, encodeNormalized } = require('../src/server/reclamation-json-codec');
const { createQuestionCapsuleMigrationPlanFixture } = require('./helpers/question-capsule-migration-plan-fixtures');

const INVALID_MATERIAL = 'invalid_question_capsule_prepared_material';
const MATERIAL_KIND = 'question_capsule_prepared_material';
const SCOPE_LIMITATIONS = Object.freeze([
  'pure_material_representation_and_reproduction_only',
  'source_path_freshness_not_verified',
  'source_and_target_availability_after_crash_not_verified',
  'persistent_outer_schema_not_verified',
  'manifest_byte_limits_not_authenticated',
  'new_outer_future_capacity_not_verified',
  'prepare_and_atomic_peak_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'save_or_resume_authority_not_verified',
  'runtime_integration_not_verified',
]);

function clone(value) {
  return structuredClone(value);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

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
  const createdManifest = createQuestionCapsulePrepareManifest(fixture.input);
  const plan = planQuestionCapsuleFileMigration(fixture.input);
  const targetBytes = {
    questions: plan.targets.questions.bytes,
    checkpoint: plan.targets.checkpoint?.bytes ?? null,
  };
  const created = createQuestionCapsulePreparedMaterial({
    manifest: createdManifest.manifest,
    sourceBytes: fixture.input.sourceBytes,
    targetBytes,
  });
  return { fixture, plan, targetBytes, created };
}

function assertInvalid(value, operation = normalizeQuestionCapsulePreparedMaterial) {
  assert.throws(() => operation(value), { name: 'TypeError', message: INVALID_MATERIAL });
}

function freezePlainTree(value) {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  for (const child of Object.values(value)) freezePlainTree(child);
  return Object.freeze(value);
}

test('prepared material preserves source bytes and reproduces exact targets for both providers and mixed scopes', () => {
  for (const options of [
    { provider: 'claude' },
    { provider: 'codex' },
    { provider: 'claude', secondaryProvider: 'codex', ordinaryQuestionSelected: true },
    { provider: 'codex', secondaryProvider: 'claude', ordinaryQuestionSelected: true },
  ]) {
    const { fixture, plan, targetBytes, created } = preparedFixture(options);
    const { material, bytes, sizeBytes, sha256: digest } = created;
    assert.deepEqual(Object.keys(material), [
      'formatVersion', 'kind', 'manifest', 'sourceQuestionBytesBase64', 'sourceCheckpointBytesBase64',
    ]);
    assert.equal(material.formatVersion, 1);
    assert.equal(material.kind, MATERIAL_KIND);
    assert.deepEqual(Buffer.from(material.sourceQuestionBytesBase64, 'base64'), fixture.input.sourceBytes.questions);
    assert.deepEqual(Buffer.from(material.sourceCheckpointBytesBase64, 'base64'), fixture.input.sourceBytes.checkpoint);
    assert.deepEqual(material.manifest.sourceFingerprints, plan.sourceFingerprints);
    assert.deepEqual(material.manifest.targetFingerprints, {
      questions: { sizeBytes: plan.targets.questions.sizeBytes, sha256: plan.targets.questions.sha256 },
      checkpoint: {
        sizeBytes: plan.targets.checkpoint.sizeBytes,
        sha256: plan.targets.checkpoint.sha256,
      },
    });
    assert.deepEqual(decodeQuestionCapsulePreparedMaterial(bytes), material);
    assert.deepEqual(encodeQuestionCapsulePreparedMaterial(material), {
      value: material,
      bytes,
      sizeBytes,
      sha256: digest,
    });

    const validated = validateQuestionCapsulePreparedMaterial({
      material,
      anchorBytes: fixture.input.sourceBytes.anchor,
      instructionBytes: fixture.input.sourceBytes.instructions,
    });
    assert.deepEqual(validated.material, material);
    assert.deepEqual(validated.sourceFingerprints, material.manifest.sourceFingerprints);
    assert.deepEqual(validated.targetFingerprints, material.manifest.targetFingerprints);
    assert.deepEqual({ ...validated.targetBytes }, targetBytes);
    assert.equal(sizeBytes, bytes.length);
    assert.equal(digest, sha256(bytes));
    assert.deepEqual(created.scopeLimitations, SCOPE_LIMITATIONS);
    assert.equal(Object.isFrozen(created.scopeLimitations), true);
    assert.equal(Object.isFrozen(material), false);
    assert.deepEqual(fixture.input.sourceBytes.questions,
      Buffer.from(material.sourceQuestionBytesBase64, 'base64'));
  }
});

test('null checkpoint remains explicit and valid instruction grant bytes stay external', () => {
  const regular = preparedFixture();
  const decodedInstructions = decodeSourceBytes(regular.fixture.input.sourceBytes.instructions, MAX_SOURCE_BYTES).value;
  assert.ok(decodedInstructions.migrationAllowance.maxExtraBytes > 0);
  assert.equal(Object.hasOwn(regular.created.material, 'sourceInstructionBytesBase64'), false);
  assert.equal(regular.created.material.manifest.sourceFingerprints.instructions.sizeBytes,
    regular.fixture.input.sourceBytes.instructions.length);
  assert.doesNotThrow(() => validateQuestionCapsulePreparedMaterial({
    material: regular.created.material,
    anchorBytes: regular.fixture.input.sourceBytes.anchor,
    instructionBytes: regular.fixture.input.sourceBytes.instructions,
  }));

  const absent = preparedFixture({}, checkpointNullFixture);
  assert.equal(absent.created.material.sourceCheckpointBytesBase64, null);
  assert.equal(absent.created.material.manifest.sourceFingerprints.checkpoint, null);
  assert.equal(absent.created.material.manifest.targetFingerprints.checkpoint, null);
  assert.equal(absent.created.material.manifest.normalByteLimitsBySlot.checkpoint, null);
  const validated = validateQuestionCapsulePreparedMaterial({
    material: absent.created.material,
    anchorBytes: absent.fixture.input.sourceBytes.anchor,
    instructionBytes: null,
  });
  assert.equal(validated.targetBytes.checkpoint, null);
  assert.equal(validated.sourceFingerprints.checkpoint, null);
  assert.equal(validated.targetFingerprints.checkpoint, null);
});

test('source whitespace and duplicate keys survive material encoding byte for byte', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({});
  for (const slot of ['questions', 'checkpoint']) {
    const raw = fixture.input.sourceBytes[slot].toString('utf8');
    const duplicate = raw.replace(/"storeId": ("[^"]+")/, '"storeId": "ignored-duplicate",\n  "storeId": $1');
    assert.notEqual(duplicate, raw);
    fixture.input.sourceBytes[slot] = Buffer.from(`${duplicate}\n \t`, 'utf8');
  }
  const { fixture: prepared, created } = preparedFixture({}, () => fixture);
  const normalized = decodeQuestionCapsulePreparedMaterial(created.bytes);
  assert.deepEqual(Buffer.from(normalized.sourceQuestionBytesBase64, 'base64'), prepared.input.sourceBytes.questions);
  assert.deepEqual(Buffer.from(normalized.sourceCheckpointBytesBase64, 'base64'), prepared.input.sourceBytes.checkpoint);
  const noncanonicalOuter = Buffer.concat([created.bytes, Buffer.from(' \n', 'utf8')]);
  assert.deepEqual(decodeQuestionCapsulePreparedMaterial(noncanonicalOuter), normalized);
  assert.equal(Buffer.byteLength(JSON.stringify(normalized), 'utf8') < created.sizeBytes, true);
});

test('local normalization rejects envelope, presence, fingerprint, and noncanonical base64 tampering', () => {
  const { created } = preparedFixture();
  const invalid = (edit) => {
    const value = clone(created.material);
    edit(value);
    assertInvalid(value);
  };

  invalid((value) => { value.unexpected = true; });
  invalid((value) => { value.formatVersion = 2; });
  invalid((value) => { value.kind = 'question_capsule'; });
  invalid((value) => { value.sourceQuestionBytesBase64 = `${value.sourceQuestionBytesBase64} `; });
  invalid((value) => { value.sourceCheckpointBytesBase64 = null; });
  invalid((value) => { value.manifest.sourceFingerprints.questions.sha256 = 'f'.repeat(64); });
  invalid((value) => { value.manifest.sourceFingerprints.questions.sizeBytes += 1; });
  invalid((value) => {
    const bytes = Buffer.from(value.sourceQuestionBytesBase64, 'base64');
    bytes[0] ^= 1;
    value.sourceQuestionBytesBase64 = bytes.toString('base64');
  });
  invalid((value) => {
    const bytes = Buffer.from(value.sourceCheckpointBytesBase64, 'base64');
    bytes[0] ^= 1;
    value.sourceCheckpointBytesBase64 = bytes.toString('base64');
  });

  const oneZeroByte = clone(created.material);
  const zeroByte = Buffer.from([0]);
  oneZeroByte.manifest.sourceFingerprints.questions = { sizeBytes: 1, sha256: sha256(zeroByte) };
  oneZeroByte.sourceQuestionBytesBase64 = 'AB==';
  assertInvalid(oneZeroByte);

  invalid((value) => { value.sourceQuestionBytesBase64 = 'AA==='; });
});

test('full validation rejects changed external anchor, instruction bytes, and regenerated target fingerprints', () => {
  const { fixture, created } = preparedFixture();
  const changeFirstByte = (bytes) => {
    const changed = Buffer.from(bytes);
    changed[0] ^= 1;
    return changed;
  };
  const assertValidateRejects = (input) => assertInvalid(input, validateQuestionCapsulePreparedMaterial);

  assertValidateRejects({
    material: created.material,
    anchorBytes: changeFirstByte(fixture.input.sourceBytes.anchor),
    instructionBytes: fixture.input.sourceBytes.instructions,
  });
  assertValidateRejects({
    material: created.material,
    anchorBytes: fixture.input.sourceBytes.anchor,
    instructionBytes: changeFirstByte(fixture.input.sourceBytes.instructions),
  });

  const alteredTarget = clone(created.material);
  alteredTarget.manifest.targetFingerprints.questions.sha256 = 'e'.repeat(64);
  assert.doesNotThrow(() => normalizeQuestionCapsulePreparedMaterial(alteredTarget));
  assertValidateRejects({
    material: alteredTarget,
    anchorBytes: fixture.input.sourceBytes.anchor,
    instructionBytes: fixture.input.sourceBytes.instructions,
  });
});

test('manifest byte limits remain caller-provided configuration rather than source fingerprints', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({});
  for (const slot of ['questions', 'checkpoint', 'instructions']) {
    fixture.input.normalByteLimitsBySlot[slot] = 200_000;
  }
  const { fixture: prepared, created } = preparedFixture({}, () => fixture);
  const updated = clone(created.material);
  updated.manifest.normalByteLimitsBySlot.questions += 1;
  assert.doesNotThrow(() => normalizeQuestionCapsulePreparedMaterial(updated));
  assert.doesNotThrow(() => validateQuestionCapsulePreparedMaterial({
    material: updated,
    anchorBytes: prepared.input.sourceBytes.anchor,
    instructionBytes: prepared.input.sourceBytes.instructions,
  }));
});

test('raw input copying rejects proxy and SharedArrayBuffer views without traps and ignores shadow getters', () => {
  const { fixture } = preparedFixture();
  let getterCalls = 0;
  let proxyTraps = 0;
  const proxiedBytes = new Proxy(fixture.input.sourceBytes.questions, {
    get(target, key, receiver) { proxyTraps += 1; return Reflect.get(target, key, receiver); },
  });
  const proxiedSource = { ...fixture.input.sourceBytes, questions: proxiedBytes };
  assertInvalid({
    manifest: createQuestionCapsulePrepareManifest(fixture.input).manifest,
    sourceBytes: proxiedSource,
    targetBytes: {
      questions: planQuestionCapsuleFileMigration(fixture.input).targets.questions.bytes,
      checkpoint: planQuestionCapsuleFileMigration(fixture.input).targets.checkpoint.bytes,
    },
  }, createQuestionCapsulePreparedMaterial);
  assert.equal(proxyTraps, 0);

  const sourceCopy = new Uint8Array(fixture.input.sourceBytes.questions.length + 4);
  sourceCopy.set(fixture.input.sourceBytes.questions, 2);
  const backing = sourceCopy.buffer;
  Object.defineProperty(backing, 'byteLength', {
    configurable: true,
    get() { getterCalls += 1; throw new Error('unexpected getter'); },
  });
  let constructorCalls = 0;
  let speciesCalls = 0;
  class AccessorUint8Array extends Uint8Array {
    constructor(...args) {
      super(...args);
      constructorCalls += 1;
    }

    static get [Symbol.species]() {
      speciesCalls += 1;
      throw new Error('unexpected species getter');
    }
  }
  const view = new AccessorUint8Array(backing, 2, fixture.input.sourceBytes.questions.length);
  Object.defineProperties(view, {
    buffer: { configurable: true, get() { getterCalls += 1; throw new Error('unexpected getter'); } },
    byteOffset: { configurable: true, get() { getterCalls += 1; throw new Error('unexpected getter'); } },
    byteLength: { configurable: true, get() { getterCalls += 1; throw new Error('unexpected getter'); } },
    [Symbol.iterator]: { configurable: true, get() { getterCalls += 1; throw new Error('unexpected getter'); } },
  });
  getterCalls = 0;
  constructorCalls = 0;
  speciesCalls = 0;
  const input = {
    manifest: createQuestionCapsulePrepareManifest(fixture.input).manifest,
    sourceBytes: { ...fixture.input.sourceBytes, questions: view },
    targetBytes: {
      questions: planQuestionCapsuleFileMigration(fixture.input).targets.questions.bytes,
      checkpoint: planQuestionCapsuleFileMigration(fixture.input).targets.checkpoint.bytes,
    },
  };
  assert.doesNotThrow(() => createQuestionCapsulePreparedMaterial(input));
  assert.equal(getterCalls, 0);
  assert.equal(constructorCalls, 0);
  assert.equal(speciesCalls, 0);

  const rawProxy = new Proxy(Buffer.from('not read'), {
    get(target, key, receiver) { proxyTraps += 1; return Reflect.get(target, key, receiver); },
  });
  assertInvalid(rawProxy, decodeQuestionCapsulePreparedMaterial);
  assert.equal(proxyTraps, 0);

  const shared = new Uint8Array(new SharedArrayBuffer(4));
  assertInvalid(shared, decodeQuestionCapsulePreparedMaterial);
  assert.equal(types.isSharedArrayBuffer(shared.buffer), true);
});

test('record getters and proxies are rejected before access and frozen inputs remain unchanged', () => {
  const { fixture, created } = preparedFixture();
  let getterCalls = 0;
  const getterInput = { ...created.material };
  Object.defineProperty(getterInput, 'sourceQuestionBytesBase64', {
    enumerable: true,
    get() { getterCalls += 1; return created.material.sourceQuestionBytesBase64; },
  });
  assertInvalid(getterInput);
  const proxyInput = new Proxy(created.material, {
    ownKeys() { getterCalls += 1; throw new Error('unexpected trap'); },
  });
  assertInvalid(proxyInput);
  assert.equal(getterCalls, 0);

  const sourceBefore = Object.fromEntries(Object.entries(fixture.input.sourceBytes).map(([slot, bytes]) =>
    [slot, bytes === null ? null : Buffer.from(bytes)]));
  const plan = planQuestionCapsuleFileMigration(fixture.input);
  const targetBytes = {
    questions: plan.targets.questions.bytes,
    checkpoint: plan.targets.checkpoint?.bytes ?? null,
  };
  const targetBefore = Object.fromEntries(Object.entries(targetBytes).map(([slot, bytes]) =>
    [slot, bytes === null ? null : Buffer.from(bytes)]));
  const immutableInput = freezePlainTree({
    manifest: clone(created.material.manifest),
    sourceBytes: { ...fixture.input.sourceBytes },
    targetBytes,
  });
  assert.doesNotThrow(() => createQuestionCapsulePreparedMaterial(immutableInput));
  for (const slot of Object.keys(sourceBefore)) assert.deepEqual(fixture.input.sourceBytes[slot], sourceBefore[slot]);
  for (const slot of Object.keys(targetBefore)) assert.deepEqual(targetBytes[slot], targetBefore[slot]);
  assert.deepEqual(encodeQuestionCapsulePreparedMaterial(created.material).value, created.material);
  assert.equal(Object.isFrozen(created.material.manifest.selection), false);
});

test('oversized raw envelopes reject before JSON parsing', (t) => {
  let jsonParseCalls = 0;
  const parse = JSON.parse;
  t.mock.method(JSON, 'parse', (...args) => {
    jsonParseCalls += 1;
    return parse(...args);
  });
  assertInvalid(Buffer.alloc(MAX_SOURCE_BYTES + 1), decodeQuestionCapsulePreparedMaterial);
  assert.equal(jsonParseCalls, 0);
});

test('material creation rejects over-cap source bytes before generating base64', (t) => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({});
  const original = fixture.input.sourceBytes.questions;
  const largeSource = Buffer.concat([original, Buffer.alloc(12_700_000 - original.length, 0x20)]);
  fixture.input.sourceBytes.questions = largeSource;
  fixture.input.normalByteLimitsBySlot.questions = MAX_SOURCE_BYTES;
  const manifest = createQuestionCapsulePrepareManifest(fixture.input).manifest;
  const plan = planQuestionCapsuleFileMigration(fixture.input);
  const input = {
    manifest,
    sourceBytes: fixture.input.sourceBytes,
    targetBytes: {
      questions: plan.targets.questions.bytes,
      checkpoint: plan.targets.checkpoint?.bytes ?? null,
    },
  };
  assert.doesNotThrow(() => validateQuestionCapsulePrepareEvidence(input));
  let base64Calls = 0;
  const toString = Buffer.prototype.toString;
  t.mock.method(Buffer.prototype, 'toString', function (encoding, ...args) {
    if (encoding === 'base64') base64Calls += 1;
    return Reflect.apply(toString, this, [encoding, ...args]);
  });
  assertInvalid(input, createQuestionCapsulePreparedMaterial);
  assert.equal(base64Calls, 0);
});

function exactBoundaryMaterial(baseMaterial) {
  for (let hostLength = 1; hostLength <= 16; hostLength += 1) {
    let questionSize = 12_000_000;
    for (let pass = 0; pass < 8; pass += 1) {
      const manifest = clone(baseMaterial.manifest);
      manifest.selection[0].identity.hostId = 'h'.repeat(hostLength);
      manifest.sourceFingerprints.questions = { sizeBytes: questionSize, sha256: '0'.repeat(64) };
      const normalizedManifest = normalizeQuestionCapsulePrepareManifest(manifest);
      const skeleton = {
        formatVersion: 1,
        kind: MATERIAL_KIND,
        manifest: normalizedManifest,
        sourceQuestionBytesBase64: '',
        sourceCheckpointBytesBase64: baseMaterial.sourceCheckpointBytesBase64,
      };
      const skeletonSizeBytes = encodeNormalized(skeleton).sizeBytes;
      const base64Length = MAX_SOURCE_BYTES - skeletonSizeBytes;
      if (base64Length <= 0 || base64Length % 4 !== 0) break;
      const nextQuestionSize = (base64Length / 4) * 3;
      if (nextQuestionSize !== questionSize) {
        questionSize = nextQuestionSize;
        continue;
      }
      const questionBytes = Buffer.alloc(questionSize, 0x31);
      normalizedManifest.sourceFingerprints.questions = {
        sizeBytes: questionBytes.length,
        sha256: sha256(questionBytes),
      };
      const material = {
        ...skeleton,
        manifest: normalizedManifest,
        sourceQuestionBytesBase64: questionBytes.toString('base64'),
      };
      if (encodeNormalized(material).sizeBytes === MAX_SOURCE_BYTES) {
        return { material };
      }
      break;
    }
  }
  throw new Error('unable to construct an exact material size boundary');
}

test('predicted serialized size matches the real 16 MiB boundary and rejects 16 MiB plus one', (t) => {
  const { created } = preparedFixture();
  const boundary = exactBoundaryMaterial(created.material);
  const actual = encodeNormalized(boundary.material);
  assert.equal(actual.sizeBytes, MAX_SOURCE_BYTES);
  const accepted = encodeQuestionCapsulePreparedMaterial(boundary.material);
  assert.equal(accepted.bytes.length, MAX_SOURCE_BYTES);
  assert.deepEqual(accepted.bytes, actual.bytes);

  const oversized = clone(boundary.material);
  oversized.manifest.selection[0].identity.hostId += 'h';
  const normalizedManifest = normalizeQuestionCapsulePrepareManifest(oversized.manifest);
  oversized.manifest = normalizedManifest;
  const oversizedActual = encodeNormalized(oversized);
  assert.equal(oversizedActual.sizeBytes, MAX_SOURCE_BYTES + 1);

  let oversizedEnvelopeStringifications = 0;
  const stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    if (value && typeof value === 'object' && value.kind === MATERIAL_KIND && value.manifest !== null) {
      oversizedEnvelopeStringifications += 1;
    }
    return stringify(value, ...args);
  });
  assertInvalid(oversized);
  assert.equal(oversizedEnvelopeStringifications, 0);
});

test('raw instruction bytes accept exactly B plus the verified I grant upper bound', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({});
  const grant = decodeSourceBytes(fixture.input.sourceBytes.instructions, MAX_SOURCE_BYTES).value.migrationAllowance;
  const grantBytes = grant.maxExtraBytes;
  const sourceLimit = fixture.input.normalByteLimitsBySlot.instructions + grantBytes;
  fixture.input.sourceBytes.instructions = Buffer.concat([
    fixture.input.sourceBytes.instructions,
    Buffer.alloc(sourceLimit - fixture.input.sourceBytes.instructions.length, 0x20),
  ]);
  const manifest = createQuestionCapsulePrepareManifest(fixture.input).manifest;
  assert.ok(grant.maxExtraBytes > 0);
  assert.equal(fixture.input.sourceBytes.instructions.length, sourceLimit);
  assert.ok(fixture.input.sourceBytes.instructions.length <=
    MAX_SOURCE_BYTES + FIXED_H_BOUNDS.instructions);
  const plan = planQuestionCapsuleFileMigration(fixture.input);
  const created = createQuestionCapsulePreparedMaterial({
    manifest,
    sourceBytes: fixture.input.sourceBytes,
    targetBytes: {
      questions: plan.targets.questions.bytes,
      checkpoint: plan.targets.checkpoint?.bytes ?? null,
    },
  });
  const validated = validateQuestionCapsulePreparedMaterial({
    material: created.material,
    anchorBytes: fixture.input.sourceBytes.anchor,
    instructionBytes: fixture.input.sourceBytes.instructions,
  });
  assert.equal(validated.sourceFingerprints.instructions.sizeBytes,
    fixture.input.sourceBytes.instructions.length);

  const loweredNormalLimit = clone(created.material);
  loweredNormalLimit.manifest.normalByteLimitsBySlot.instructions -= 1;
  assertInvalid({
    material: loweredNormalLimit,
    anchorBytes: fixture.input.sourceBytes.anchor,
    instructionBytes: fixture.input.sourceBytes.instructions,
  }, validateQuestionCapsulePreparedMaterial);

  const overGrant = createQuestionCapsuleMigrationPlanFixture({});
  const originalInstructions = overGrant.input.sourceBytes.instructions;
  const overGrantLimit = overGrant.input.normalByteLimitsBySlot.instructions + grantBytes + 1;
  overGrant.input.sourceBytes.instructions = Buffer.concat([
    originalInstructions,
    Buffer.alloc(overGrantLimit - originalInstructions.length, 0x20),
  ]);
  assert.throws(() => createQuestionCapsulePrepareManifest(overGrant.input), {
    name: 'TypeError',
    message: 'invalid_question_capsule_prepare_manifest',
  });
});
