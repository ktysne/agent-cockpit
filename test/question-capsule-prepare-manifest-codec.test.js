'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { types } = require('node:util');
const {
  createQuestionCapsulePrepareManifest,
  decodeQuestionCapsulePrepareManifest,
  encodeQuestionCapsulePrepareManifest,
  normalizeQuestionCapsulePrepareManifest,
  validateQuestionCapsulePrepareEvidence,
} = require('../src/server/question-capsule-prepare-manifest-codec');
const { planQuestionCapsuleFileMigration } = require('../src/server/question-capsule-migration-plan');
const { MAX_SOURCE_BYTES } = require('../src/server/reclamation-capacity-bounds');
const { decodeSourceBytes, encodeNormalized } = require('../src/server/reclamation-json-codec');
const { createQuestionCapsuleMigrationPlanFixture } = require('./helpers/question-capsule-migration-plan-fixtures');

const INVALID_MANIFEST = 'invalid_question_capsule_prepare_manifest';
const INVALID_EVIDENCE = 'invalid_question_capsule_prepare_evidence';
const SCOPE_LIMITATIONS = [
  'pure_manifest_and_byte_evidence_only',
  'source_path_freshness_not_verified',
  'source_and_target_availability_after_crash_not_verified',
  'persistent_outer_schema_not_verified',
  'new_outer_future_capacity_not_verified',
  'prepare_and_atomic_peak_not_verified',
  'persistence_recovery_not_verified',
  'count_capacity_release_not_verified',
  'runtime_integration_not_verified',
];
const UUID_PREFIX = 'a0000000-0000-4000-8000-';
const OPERATION_ID = '77777777-7777-4777-8777-777777777777';

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function uuidFor(index) {
  return `${UUID_PREFIX}${index.toString(16).padStart(12, '0')}`;
}

function targetBytesFor(input) {
  const plan = planQuestionCapsuleFileMigration(input);
  return {
    plan,
    targetBytes: {
      questions: plan.targets.questions.bytes,
      checkpoint: plan.targets.checkpoint?.bytes ?? null,
    },
  };
}

function createEvidence(fixture) {
  const created = createQuestionCapsulePrepareManifest(fixture.input);
  const { plan, targetBytes } = targetBytesFor(fixture.input);
  const evidence = validateQuestionCapsulePrepareEvidence({
    manifest: created.manifest,
    sourceBytes: fixture.input.sourceBytes,
    targetBytes,
  });
  return { created, plan, targetBytes, evidence };
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

function manifestFor(fixture) {
  return createQuestionCapsulePrepareManifest(fixture.input).manifest;
}

function assertInvalidManifest(value) {
  assert.throws(() => normalizeQuestionCapsulePrepareManifest(value), {
    name: 'TypeError',
    message: INVALID_MANIFEST,
  });
}

function assertInvalidEvidence(value) {
  assert.throws(() => validateQuestionCapsulePrepareEvidence(value), {
    name: 'TypeError',
    message: INVALID_EVIDENCE,
  });
}

function baseManifest() {
  const fixture = createQuestionCapsuleMigrationPlanFixture({});
  return manifestFor(fixture);
}

test('manifest creation and evidence use exact planner bytes for both providers and mixed scopes', () => {
  for (const options of [
    { provider: 'claude' },
    { provider: 'codex' },
    { provider: 'claude', secondaryProvider: 'codex', ordinaryQuestionSelected: true },
    { provider: 'codex', secondaryProvider: 'claude', ordinaryQuestionSelected: true },
  ]) {
    const fixture = createQuestionCapsuleMigrationPlanFixture(options);
    fixture.input.selection.reverse();
    for (const scope of fixture.input.selection) scope.internalQuestionIds.reverse();
    const sourceBefore = Object.fromEntries(Object.entries(fixture.input.sourceBytes).map(([slot, bytes]) =>
      [slot, bytes === null ? null : Buffer.from(bytes)]));
    const selectionBefore = structuredClone(fixture.input.selection);
    const { created, plan, targetBytes, evidence } = createEvidence(fixture);

    assert.deepEqual(Object.keys(created.manifest), [
      'formatVersion', 'operationId', 'storeId', 'sourceFingerprints', 'targetFingerprints',
      'selection', 'usedChunkIds', 'normalByteLimitsBySlot',
    ]);
    assert.equal(created.manifest.formatVersion, 1);
    assert.equal(created.manifest.storeId, plan.targets.questions.value.storeId);
    assert.deepEqual(created.manifest.sourceFingerprints, plan.sourceFingerprints);
    assert.deepEqual(created.manifest.targetFingerprints, {
      questions: { sizeBytes: plan.targets.questions.sizeBytes, sha256: plan.targets.questions.sha256 },
      checkpoint: plan.targets.checkpoint === null ? null : {
        sizeBytes: plan.targets.checkpoint.sizeBytes,
        sha256: plan.targets.checkpoint.sha256,
      },
    });
    assert.deepEqual(created.manifest.usedChunkIds, plan.usedChunkIds);
    assert.deepEqual(created.manifest.usedChunkIds, fixture.input.chunkIds.slice(0, plan.usedChunkIds.length));
    assert.deepEqual(created.manifest.selection.map((scope) => scope.internalQuestionIds),
      created.manifest.selection.map((scope) => [...scope.internalQuestionIds].sort()));
    assert.deepEqual(evidence, {
      manifest: created.manifest,
      sourceFingerprints: created.manifest.sourceFingerprints,
      targetFingerprints: created.manifest.targetFingerprints,
      scopeLimitations: SCOPE_LIMITATIONS,
    });
    assert.deepEqual(decodeQuestionCapsulePrepareManifest(created.bytes), created.manifest);
    assert.deepEqual(encodeQuestionCapsulePrepareManifest(created.manifest), {
      value: created.manifest,
      bytes: created.bytes,
      sizeBytes: created.sizeBytes,
      sha256: created.sha256,
    });
    assert.equal(created.sizeBytes, created.bytes.length);
    assert.equal(created.sizeBytes <= MAX_SOURCE_BYTES, true);
    assert.equal(created.sha256, createHash('sha256').update(created.bytes).digest('hex'));
    assert.deepEqual(created.scopeLimitations, SCOPE_LIMITATIONS);
    assert.equal(Object.isFrozen(created.scopeLimitations), true);
    assert.equal(Object.isFrozen(created.manifest), false);
    assert.deepEqual(fixture.input.selection, selectionBefore);
    for (const slot of Object.keys(sourceBefore)) assert.deepEqual(fixture.input.sourceBytes[slot], sourceBefore[slot]);
    assert.deepEqual(targetBytes, {
      questions: plan.targets.questions.bytes,
      checkpoint: plan.targets.checkpoint?.bytes ?? null,
    });
    assert.deepEqual(plain(evidence.manifest), plain(created.manifest));
  }
});

test('null checkpoint and instruction slots remain explicit in the manifest and evidence', () => {
  const fixture = checkpointNullFixture();
  const { created, plan, evidence } = createEvidence(fixture);
  assert.equal(plan.targets.checkpoint, null);
  assert.equal(created.manifest.sourceFingerprints.checkpoint, null);
  assert.equal(created.manifest.targetFingerprints.checkpoint, null);
  assert.equal(created.manifest.sourceFingerprints.instructions, null);
  assert.deepEqual(plain(created.manifest.normalByteLimitsBySlot), {
    questions: fixture.input.normalByteLimitsBySlot.questions,
    checkpoint: null,
    instructions: null,
  });
  assert.deepEqual(evidence.targetFingerprints.checkpoint, null);
});

test('raw whitespace and duplicate source keys are fingerprinted from planner bytes', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({});
  const duplicateKeyRaw = fixture.input.sourceBytes.questions.toString('utf8').replace(
    /"storeId": ("[^"]+")/,
    '"storeId": "ignored-duplicate",\n  "storeId": $1',
  );
  fixture.input.sourceBytes.questions = Buffer.from(duplicateKeyRaw, 'utf8');
  const { created, plan, targetBytes } = createEvidence(fixture);
  assert.deepEqual(created.manifest.sourceFingerprints.questions, plan.sourceFingerprints.questions);
  assert.equal(created.manifest.sourceFingerprints.questions.sizeBytes, Buffer.byteLength(duplicateKeyRaw));

  const changedSource = Object.fromEntries(Object.entries(fixture.input.sourceBytes));
  changedSource.questions = Buffer.concat([changedSource.questions, Buffer.from('\n  \t', 'utf8')]);
  assertInvalidEvidence({ manifest: created.manifest, sourceBytes: changedSource, targetBytes });

  const changedTarget = {
    ...targetBytes,
    questions: Buffer.concat([targetBytes.questions, Buffer.from(' ', 'utf8')]),
  };
  assertInvalidEvidence({ manifest: created.manifest, sourceBytes: fixture.input.sourceBytes, targetBytes: changedTarget });
});

test('evidence rejects locally valid operation, selection, store, fingerprint, chunk, limit, and target tampering', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({ ordinaryQuestionSelected: true });
  const { created, targetBytes } = createEvidence(fixture);
  const sourceBytes = fixture.input.sourceBytes;
  const mutate = (edit) => {
    const manifest = structuredClone(created.manifest);
    edit(manifest);
    assert.doesNotThrow(() => normalizeQuestionCapsulePrepareManifest(manifest));
    assertInvalidEvidence({ manifest, sourceBytes, targetBytes });
  };

  mutate((manifest) => { manifest.operationId = '88888888-8888-4888-8888-888888888888'; });
  mutate((manifest) => { manifest.storeId = '99999999-9999-4999-8999-999999999999'; });
  mutate((manifest) => { manifest.selection[0].identity.nativeId = 'different-valid-native-id'; });
  mutate((manifest) => {
    manifest.sourceFingerprints.questions.sizeBytes += 1;
  });
  mutate((manifest) => { manifest.sourceFingerprints.checkpoint.sha256 = 'f'.repeat(64); });
  mutate((manifest) => { manifest.targetFingerprints.questions.sizeBytes += 1; });
  mutate((manifest) => { manifest.targetFingerprints.questions.sha256 = 'e'.repeat(64); });
  mutate((manifest) => { manifest.usedChunkIds[0] = 'b0000000-0000-4000-8000-000000000001'; });
  mutate((manifest) => { manifest.normalByteLimitsBySlot.questions = 1; });

  const changedTarget = Buffer.from(targetBytes.questions);
  changedTarget[0] ^= 1;
  assertInvalidEvidence({
    manifest: created.manifest,
    sourceBytes,
    targetBytes: { ...targetBytes, questions: changedTarget },
  });
});

test('invalid nested getters and proxies are rejected without invoking their traps', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({});
  let getterCalls = 0;
  const input = { ...fixture.input };
  Object.defineProperty(input, 'selection', {
    enumerable: true,
    get() { getterCalls += 1; return fixture.input.selection; },
  });
  assert.throws(() => createQuestionCapsulePrepareManifest(input), {
    name: 'TypeError',
    message: INVALID_MANIFEST,
  });
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const proxiedIdentity = new Proxy(fixture.input.selection[0].identity, {
    ownKeys() { proxyTraps += 1; throw new Error('unexpected trap'); },
  });
  const proxiedSelection = structuredClone(fixture.input.selection);
  proxiedSelection[0].identity = proxiedIdentity;
  const malformedManifest = baseManifest();
  malformedManifest.selection = proxiedSelection;
  assert.throws(() => normalizeQuestionCapsulePrepareManifest(malformedManifest), {
    name: 'TypeError',
    message: INVALID_MANIFEST,
  });
  assert.equal(proxyTraps, 0);

  const { created, targetBytes } = createEvidence(fixture);
  const proxiedTarget = new Proxy(targetBytes.questions, {
    get(target, key, receiver) { proxyTraps += 1; return Reflect.get(target, key, receiver); },
  });
  assertInvalidEvidence({
    manifest: created.manifest,
    sourceBytes: fixture.input.sourceBytes,
    targetBytes: { questions: proxiedTarget, checkpoint: targetBytes.checkpoint },
  });
  assert.equal(proxyTraps, 0);

  const raw = Buffer.from(created.bytes);
  const rawProxy = new Proxy(raw, {
    get(target, key, receiver) { proxyTraps += 1; return Reflect.get(target, key, receiver); },
  });
  assert.throws(() => decodeQuestionCapsulePrepareManifest(rawProxy), {
    name: 'TypeError',
    message: INVALID_MANIFEST,
  });
  assert.equal(proxyTraps, 0);
  assert.equal(types.isProxy(rawProxy), true);
});

test('target byte copying ignores shadow accessors, iterators, species, and ArrayBuffer byteLength getters', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({});
  const { created, plan } = createEvidence(fixture);
  const sourceBytes = fixture.input.sourceBytes;
  const originalTarget = plan.targets.questions.bytes;
  const backingCopy = new Uint8Array(originalTarget.byteLength);
  backingCopy.set(originalTarget);
  const backing = backingCopy.buffer;
  let getterCalls = 0;
  class AccessorUint8Array extends Uint8Array {
    static get [Symbol.species]() { getterCalls += 1; throw new Error('unexpected species getter'); }
  }
  Object.defineProperty(backing, 'byteLength', {
    configurable: true,
    get() { getterCalls += 1; throw new Error('unexpected byteLength getter'); },
  });
  const view = new AccessorUint8Array(backing, 0, originalTarget.byteLength);
  view.set(originalTarget);
  Object.defineProperties(view, {
    buffer: { configurable: true, get() { getterCalls += 1; throw new Error('unexpected buffer getter'); } },
    byteOffset: { configurable: true, get() { getterCalls += 1; throw new Error('unexpected offset getter'); } },
    byteLength: { configurable: true, get() { getterCalls += 1; throw new Error('unexpected length getter'); } },
    [Symbol.iterator]: { configurable: true, get() { getterCalls += 1; throw new Error('unexpected iterator getter'); } },
  });

  assert.doesNotThrow(() => validateQuestionCapsulePrepareEvidence({
    manifest: created.manifest,
    sourceBytes,
    targetBytes: { questions: view, checkpoint: plan.targets.checkpoint?.bytes ?? null },
  }));
  assert.equal(getterCalls, 0);
});

test('source planning ignores an own ArrayBuffer byteLength getter', () => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({});
  const { created, targetBytes } = createEvidence(fixture);
  const original = fixture.input.sourceBytes.questions;
  const sourceCopy = new Uint8Array(original.byteLength);
  sourceCopy.set(original);
  const backing = sourceCopy.buffer;
  let getterCalls = 0;
  Object.defineProperty(backing, 'byteLength', {
    configurable: true,
    get() { getterCalls += 1; return sourceCopy.byteLength; },
  });
  fixture.input.sourceBytes.questions = new Uint8Array(backing, 0, sourceCopy.byteLength);

  createQuestionCapsulePrepareManifest(fixture.input);
  validateQuestionCapsulePrepareEvidence({
    manifest: created.manifest,
    sourceBytes: fixture.input.sourceBytes,
    targetBytes,
  });
  assert.equal(getterCalls, 0);
});

test('oversized selection and chunk arrays reject before element reflection at the 20,000 limits', (t) => {
  const oversizedScopes = new Array(20_001).fill({});
  const oversizedIds = new Array(20_001).fill('id-too-many');
  const oversizedChunks = new Array(20_001).fill(uuidFor(1));
  const watched = new Set([oversizedScopes, oversizedIds, oversizedChunks]);
  const reflectionCounts = new Map([...watched].map((array) => [array, 0]));
  const ownKeys = Reflect.ownKeys;
  t.mock.method(Reflect, 'ownKeys', (value) => {
    if (watched.has(value)) reflectionCounts.set(value, reflectionCounts.get(value) + 1);
    return ownKeys(value);
  });

  const manifest = baseManifest();
  const tooManyScopes = structuredClone(manifest);
  tooManyScopes.selection = oversizedScopes;
  assertInvalidManifest(tooManyScopes);
  const tooManyIds = structuredClone(manifest);
  tooManyIds.selection[0].internalQuestionIds = oversizedIds;
  assertInvalidManifest(tooManyIds);
  const tooManyChunks = structuredClone(manifest);
  tooManyChunks.usedChunkIds = oversizedChunks;
  assertInvalidManifest(tooManyChunks);
  for (const array of watched) assert.equal(reflectionCounts.get(array), 0);

  const exactIdsManifest = structuredClone(manifest);
  exactIdsManifest.selection = [{
    ...manifest.selection[0],
    internalQuestionIds: Array.from({ length: 20_000 }, (_, index) => `selected-${index}`),
  }];
  assert.equal(normalizeQuestionCapsulePrepareManifest(exactIdsManifest).selection[0]
    .internalQuestionIds.length, 20_000);

  const identity = structuredClone(manifest.selection[0].identity);
  const exactScopes = Array.from({ length: 20_000 }, (_, index) => ({
    identity: structuredClone(identity),
    periodId: `period-${index}`,
    internalQuestionIds: [`question-${index}`],
  }));
  const exactChunks = Array.from({ length: 20_000 }, (_, index) => uuidFor(index + 1));
  const exactManifest = {
    ...manifest,
    selection: exactScopes,
    usedChunkIds: exactChunks,
  };
  const normalized = normalizeQuestionCapsulePrepareManifest(exactManifest);
  assert.equal(normalized.selection.length, 20_000);
  assert.equal(normalized.usedChunkIds.length, 20_000);
});

test('string byte budget rejects before pretty encoding and the encoded manifest policy caps every entrance', (t) => {
  const fixture = createQuestionCapsuleMigrationPlanFixture({});
  const manifest = manifestFor(fixture);
  const longIdentifier = '\uD800'.repeat(512);
  const scopeCount = 1_830;
  const overPrettyLimit = {
    ...manifest,
    selection: Array.from({ length: scopeCount }, (_, index) => ({
      identity: {
        provider: 'claude',
        nativeIdKind: 'session',
        hostId: longIdentifier,
        homeScopeId: longIdentifier,
        nativeId: longIdentifier,
      },
      periodId: `period-${index}`,
      internalQuestionIds: [`selected-${index}`],
    })),
    usedChunkIds: Array.from({ length: scopeCount }, (_, index) => uuidFor(index + 1)),
  };
  assert.throws(() => normalizeQuestionCapsulePrepareManifest(overPrettyLimit), {
    name: 'TypeError',
    message: INVALID_MANIFEST,
  });

  let wholeManifestStringifications = 0;
  const stringify = JSON.stringify;
  t.mock.method(JSON, 'stringify', (value, ...args) => {
    if (value !== null && typeof value === 'object') wholeManifestStringifications += 1;
    return stringify(value, ...args);
  });
  assert.throws(() => encodeQuestionCapsulePrepareManifest(overPrettyLimit), {
    name: 'TypeError',
    message: INVALID_MANIFEST,
  });
  assert.equal(wholeManifestStringifications, 0);
  t.mock.restoreAll();

  const prettyOverCompactWithinLimit = { ...overPrettyLimit };
  const shorterIdentifier = '\uD800'.repeat(500);
  prettyOverCompactWithinLimit.selection = overPrettyLimit.selection.slice(0, 1_810).map((scope) => ({
    ...scope,
    identity: { ...scope.identity, hostId: shorterIdentifier, homeScopeId: shorterIdentifier,
      nativeId: shorterIdentifier },
  }));
  prettyOverCompactWithinLimit.usedChunkIds = overPrettyLimit.usedChunkIds.slice(0, 1_810);
  const compactWithinLimit = Buffer.from(JSON.stringify(prettyOverCompactWithinLimit), 'utf8');
  const prettyEncoded = encodeNormalized(prettyOverCompactWithinLimit);
  if (prettyEncoded.sizeBytes <= MAX_SOURCE_BYTES) {
    throw new Error('fixture did not exceed the pretty-encoded manifest policy');
  }
  assert.ok(compactWithinLimit.length <= MAX_SOURCE_BYTES);
  assert.throws(() => normalizeQuestionCapsulePrepareManifest(prettyOverCompactWithinLimit), {
    name: 'TypeError',
    message: INVALID_MANIFEST,
  });
  assert.throws(() => encodeQuestionCapsulePrepareManifest(prettyOverCompactWithinLimit), {
    name: 'TypeError',
    message: INVALID_MANIFEST,
  });
  assert.throws(() => decodeQuestionCapsulePrepareManifest(compactWithinLimit), {
    name: 'TypeError',
    message: INVALID_MANIFEST,
  });
  assertInvalidEvidence({
    manifest: prettyOverCompactWithinLimit,
    sourceBytes: fixture.input.sourceBytes,
    targetBytes: targetBytesFor(fixture.input).targetBytes,
  });
});

test('malformed wrapper fields, fingerprints, presence, and operation collisions fail with fixed codes', () => {
  const manifest = baseManifest();
  const unknownField = { ...manifest, unexpected: true };
  assertInvalidManifest(unknownField);
  const invalidFingerprint = structuredClone(manifest);
  invalidFingerprint.sourceFingerprints.anchor.extra = 1;
  assertInvalidManifest(invalidFingerprint);
  const nullQuestion = structuredClone(manifest);
  nullQuestion.sourceFingerprints.questions = null;
  assertInvalidManifest(nullQuestion);
  const mismatchedPresence = structuredClone(manifest);
  mismatchedPresence.normalByteLimitsBySlot.instructions = null;
  assertInvalidManifest(mismatchedPresence);
  const collision = structuredClone(manifest);
  collision.usedChunkIds[0] = collision.operationId;
  assertInvalidManifest(collision);
  assert.throws(() => decodeQuestionCapsulePrepareManifest(Buffer.alloc(MAX_SOURCE_BYTES + 1)), {
    name: 'TypeError',
    message: INVALID_MANIFEST,
  });

  const fixture = createQuestionCapsuleMigrationPlanFixture({});
  assert.throws(() => createQuestionCapsulePrepareManifest({
    ...fixture.input,
    operationId: fixture.input.chunkIds[0],
  }), { name: 'TypeError', message: INVALID_MANIFEST });
  assertInvalidEvidence({
    manifest,
    sourceBytes: fixture.input.sourceBytes,
    targetBytes: { questions: null, checkpoint: null },
  });
});
