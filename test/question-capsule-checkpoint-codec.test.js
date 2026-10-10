'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const {
  decodeCapsuleCheckpointV4Local,
  encodeCapsuleCheckpointV4Local,
  normalizeCapsuleCheckpointV4Local,
} = require('../src/server/question-capsule-checkpoint-codec');
const { expandQuestionDeliveryCapsule } = require('../src/server/question-rejection-capsule-codec');
const { normalizeCheckpointV3Local } = require('../src/server/delivery-reclamation-codec');
const { encodeNormalized } = require('../src/server/reclamation-json-codec');
const { createQuestionCapsuleFilesFixture } = require('./helpers/question-capsule-files-fixtures');

const INVALID_CHECKPOINT = 'invalid_capsule_checkpoint_v4';
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_RECORDS = 20_000;
const MAX_CHECKPOINT_REGISTRATION_RECORDS = 50_000;
const MAX_REGISTRATION_ADDITIONS = 20_000;
const UUID_MISMATCH = '44444444-4444-4444-8444-444444444444';
const BASE_FIXTURE = createQuestionCapsuleFilesFixture();

function clone(value) {
  return structuredClone(value);
}

function expectInvalid(operation) {
  assert.throws(operation, (error) => error instanceof TypeError && error.message === INVALID_CHECKPOINT);
}

function trackOwnKeys(t) {
  const counts = new Map();
  const original = Reflect.ownKeys;
  t.mock.method(Reflect, 'ownKeys', (value) => {
    if (counts.has(value)) counts.set(value, counts.get(value) + 1);
    return original(value);
  });
  return {
    watch(value) {
      counts.set(value, 0);
      return value;
    },
    count(value) {
      return counts.get(value);
    },
  };
}

function restoredLegacyCheckpoint(file) {
  const capsuleDeliveries = file.checkpointCapsules.flatMap(({ capsule }) =>
    expandQuestionDeliveryCapsule(capsule));
  const byAttempt = new Map([...file.ledger.deliveries, ...capsuleDeliveries]
    .map((delivery) => [delivery.deliveryAttemptId, delivery]));
  const deliveries = file.deliveryAttemptOrder.map((deliveryAttemptId) => byAttempt.get(deliveryAttemptId));
  assert.ok(deliveries.every((delivery) => delivery !== undefined));
  return normalizeCheckpointV3Local({
    schemaVersion: 3,
    storeId: file.storeId,
    revision: file.revision,
    registrations: file.registrations,
    ledger: {
      schemaVersion: 2,
      revision: file.ledger.revision,
      deliveries,
      notificationTargets: file.ledger.notificationTargets,
      logicalTombstones: file.ledger.logicalTombstones,
    },
    migrationAllowance: null,
  }, MAX_CHECKPOINT_REGISTRATION_RECORDS);
}

function reorderObjectKeys(value) {
  if (Array.isArray(value)) return value.map(reorderObjectKeys);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse()
    .map(([key, item]) => [key, reorderObjectKeys(item)]));
}

test('CP4 codec restores both provider files through the independent CP3 local validator', () => {
  for (const provider of ['claude', 'codex']) {
    const fixture = provider === 'claude'
      ? BASE_FIXTURE
      : createQuestionCapsuleFilesFixture({ provider });
    const input = clone(fixture.checkpointFile);
    const before = clone(input);
    const normalized = normalizeCapsuleCheckpointV4Local(input);

    assert.deepEqual(input, before);
    assert.deepEqual(restoredLegacyCheckpoint(normalized),
      normalizeCheckpointV3Local(fixture.snapshot.stores.checkpoint, MAX_CHECKPOINT_REGISTRATION_RECORDS));
    assert.equal(normalized.schemaVersion, 4);
    assert.equal(normalized.migrationAllowance, null);
    assert.equal(Object.isFrozen(normalized), false);
    assert.notEqual(normalized.registrations, input.registrations);
  }
});

test('CP4 accepts chunk reordering and shared operation IDs while emitting ordinal chunks', () => {
  const input = clone(BASE_FIXTURE.checkpointFile);
  assert.ok(input.checkpointCapsules.length >= 2);
  const operationId = input.checkpointCapsules[0].capsule.compactionOperationId;
  input.checkpointCapsules.forEach(({ capsule }) => {
    capsule.compactionOperationId = operationId;
  });
  input.checkpointCapsules.reverse();

  const normalized = normalizeCapsuleCheckpointV4Local(input);
  const expectedIds = input.checkpointCapsules.map((wrapper) => wrapper.chunkId).sort();
  assert.deepEqual(normalized.checkpointCapsules.map((wrapper) => wrapper.chunkId), expectedIds);
  assert.ok(normalized.checkpointCapsules.every(({ capsule }) => capsule.compactionOperationId === operationId));
  assert.deepEqual(restoredLegacyCheckpoint(normalized),
    normalizeCheckpointV3Local(BASE_FIXTURE.snapshot.stores.checkpoint, MAX_CHECKPOINT_REGISTRATION_RECORDS));
});

test('CP4 preserves mixed-provider registrations and delivery history', () => {
  const fixture = createQuestionCapsuleFilesFixture({ provider: 'claude', secondaryProvider: 'codex' });
  const normalized = normalizeCapsuleCheckpointV4Local(fixture.checkpointFile);
  assert.deepEqual(restoredLegacyCheckpoint(normalized),
    normalizeCheckpointV3Local(fixture.snapshot.stores.checkpoint, MAX_CHECKPOINT_REGISTRATION_RECORDS));
  assert.deepEqual(normalized.registrations.conversations.map(({ identity }) => identity.provider),
    ['claude', 'codex']);
});

test('CP4 accepts a normal-only file with reclaimed deliveries', () => {
  const fixture = BASE_FIXTURE;
  const input = clone(fixture.checkpointFile);
  const oldCheckpoint = normalizeCheckpointV3Local(fixture.snapshot.stores.checkpoint,
    MAX_CHECKPOINT_REGISTRATION_RECORDS);
  input.checkpointCapsules = [];
  input.ledger.deliveries = clone(oldCheckpoint.ledger.deliveries);
  input.deliveryAttemptOrder = oldCheckpoint.ledger.deliveries.map((delivery) => delivery.deliveryAttemptId);

  const normalized = normalizeCapsuleCheckpointV4Local(input);
  assert.equal(normalized.checkpointCapsules.length, 0);
  assert.equal(normalized.ledger.deliveries.length, oldCheckpoint.ledger.deliveries.length);
  assert.deepEqual(restoredLegacyCheckpoint(normalized), oldCheckpoint);
});

test('CP4 requires ordinary deliveries to be an ordered subsequence of the declared history', () => {
  const fixture = createQuestionCapsuleFilesFixture({ ordinaryQuestionSelected: true });
  const valid = clone(fixture.checkpointFile);
  assert.ok(valid.ledger.deliveries.length >= 2);
  assert.deepEqual(restoredLegacyCheckpoint(normalizeCapsuleCheckpointV4Local(valid)),
    normalizeCheckpointV3Local(fixture.snapshot.stores.checkpoint, MAX_CHECKPOINT_REGISTRATION_RECORDS));

  const invalid = clone(valid);
  invalid.ledger.deliveries.reverse();
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(invalid));
});

test('CP4 makes normalized property order canonical without changing array order', () => {
  const normalized = normalizeCapsuleCheckpointV4Local(BASE_FIXTURE.checkpointFile);
  const reordered = normalizeCapsuleCheckpointV4Local(reorderObjectKeys(BASE_FIXTURE.checkpointFile));
  assert.deepEqual(reordered, normalized);
  assert.deepEqual(reordered.deliveryAttemptOrder, normalized.deliveryAttemptOrder);
  assert.deepEqual(reordered.registrations.connections, normalized.registrations.connections);
});

test('CP4 encode and decode round-trip a canonical file', () => {
  const encoded = encodeCapsuleCheckpointV4Local(BASE_FIXTURE.checkpointFile);
  assert.deepEqual(Object.keys(encoded), ['value', 'bytes', 'sizeBytes', 'sha256']);
  assert.equal(encoded.sizeBytes, encoded.bytes.length);
  assert.equal(encoded.sha256, createHash('sha256').update(encoded.bytes).digest('hex'));
  assert.deepEqual(decodeCapsuleCheckpointV4Local(encoded.bytes), encoded.value);
});

test('CP4 rejects unknown fields, duplicate chunks, header mismatches, and invalid history coverage', () => {
  const unknownField = clone(BASE_FIXTURE.checkpointFile);
  unknownField.extra = true;
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(unknownField));

  const unknownWrapperField = clone(BASE_FIXTURE.checkpointFile);
  unknownWrapperField.checkpointCapsules[0].extra = true;
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(unknownWrapperField));

  const duplicateChunk = clone(BASE_FIXTURE.checkpointFile);
  duplicateChunk.checkpointCapsules[1].chunkId = duplicateChunk.checkpointCapsules[0].chunkId;
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(duplicateChunk));

  const wrongStore = clone(BASE_FIXTURE.checkpointFile);
  wrongStore.checkpointCapsules[0].capsule.storeId = UUID_MISMATCH;
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(wrongStore));

  const missingOrderEntry = clone(BASE_FIXTURE.checkpointFile);
  missingOrderEntry.deliveryAttemptOrder.pop();
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(missingOrderEntry));

  const duplicateOrderEntry = clone(BASE_FIXTURE.checkpointFile);
  duplicateOrderEntry.deliveryAttemptOrder[1] = duplicateOrderEntry.deliveryAttemptOrder[0];
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(duplicateOrderEntry));

  const excessiveReferences = clone(BASE_FIXTURE.checkpointFile);
  const capsule = excessiveReferences.checkpointCapsules[0].capsule;
  capsule.references.sources.push(clone(capsule.references.sources[0]));
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(excessiveReferences));
});

test('CP4 rejects malformed capsule records and legacy CP3 readers reject the new schema', () => {
  const invalidIndex = clone(BASE_FIXTURE.checkpointFile);
  invalidIndex.checkpointCapsules[0].capsule.deliveries[0].sourceRefIndex = Number.MAX_SAFE_INTEGER;
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(invalidIndex));

  const invalidAllowance = clone(BASE_FIXTURE.checkpointFile);
  invalidAllowance.migrationAllowance = {};
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(invalidAllowance));

  assert.throws(() => normalizeCheckpointV3Local(BASE_FIXTURE.checkpointFile), TypeError);
});

test('CP4 rejects proxies and getters without invoking their traps', () => {
  let trapCount = 0;
  const proxy = new Proxy(BASE_FIXTURE.checkpointFile, {
    get() { trapCount += 1; throw new Error('proxy read'); },
    ownKeys() { trapCount += 1; throw new Error('proxy keys'); },
  });
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(proxy));
  assert.equal(trapCount, 0);

  let getterCount = 0;
  const getterFile = clone(BASE_FIXTURE.checkpointFile);
  Object.defineProperty(getterFile, 'schemaVersion', {
    enumerable: true,
    configurable: true,
    get() { getterCount += 1; return 4; },
  });
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(getterFile));
  assert.equal(getterCount, 0);

  const deepProxyFile = clone(BASE_FIXTURE.checkpointFile);
  deepProxyFile.registrations.conversations[0] = new Proxy(deepProxyFile.registrations.conversations[0], {
    ownKeys() { trapCount += 1; throw new Error('row keys'); },
  });
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(deepProxyFile));
  assert.equal(trapCount, 0);
});

test('CP4 maps raw byte-limit failures to its fixed TypeError', () => {
  const encoded = encodeCapsuleCheckpointV4Local(BASE_FIXTURE.checkpointFile);
  const exactLimitBytes = Buffer.concat([
    encoded.bytes,
    Buffer.alloc(MAX_FILE_BYTES - encoded.sizeBytes, 0x20),
  ]);
  assert.equal(exactLimitBytes.length, MAX_FILE_BYTES);
  assert.deepEqual(decodeCapsuleCheckpointV4Local(exactLimitBytes), encoded.value);
  const validOverLimitBytes = Buffer.concat([exactLimitBytes, Buffer.from(' ')]);
  assert.equal(validOverLimitBytes.length, MAX_FILE_BYTES + 1);
  expectInvalid(() => decodeCapsuleCheckpointV4Local(validOverLimitBytes));
});

test('CP4 rejects shallow record overages before reading rows or the ledger', (t) => {
  const ownKeys = trackOwnKeys(t);
  const tooManyDeliveries = clone(BASE_FIXTURE.checkpointFile);
  const oversizedDeliveryArray = ownKeys.watch(new Array(MAX_FILE_RECORDS + 1));
  tooManyDeliveries.ledger.deliveries = oversizedDeliveryArray;
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(tooManyDeliveries));
  assert.equal(ownKeys.count(oversizedDeliveryArray), 0);

  const tooManyChunks = clone(BASE_FIXTURE.checkpointFile);
  const oversizedChunkArray = ownKeys.watch(new Array(MAX_FILE_RECORDS + 1));
  tooManyChunks.checkpointCapsules = oversizedChunkArray;
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(tooManyChunks));
  assert.equal(ownKeys.count(oversizedChunkArray), 0);

  const exactDeliveryLimit = clone(BASE_FIXTURE.checkpointFile);
  const exactLimitDeliveryArray = ownKeys.watch(new Array(MAX_FILE_RECORDS).fill(null));
  exactDeliveryLimit.ledger.deliveries = exactLimitDeliveryArray;
  exactDeliveryLimit.checkpointCapsules = [];
  exactDeliveryLimit.deliveryAttemptOrder = [];
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(exactDeliveryLimit));
  assert.equal(ownKeys.count(exactLimitDeliveryArray), 1);

  const tooManyRegistrations = clone(BASE_FIXTURE.checkpointFile);
  const oversizedRegistrationArray = ownKeys.watch(
    new Array(MAX_CHECKPOINT_REGISTRATION_RECORDS).fill(null));
  tooManyRegistrations.registrations.conversations = oversizedRegistrationArray;
  const overflowLedger = ownKeys.watch(tooManyRegistrations.ledger);
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(tooManyRegistrations));
  assert.equal(ownKeys.count(oversizedRegistrationArray), 1);
  assert.equal(ownKeys.count(overflowLedger), 0);

  const exactRegistrationLimit = clone(BASE_FIXTURE.checkpointFile);
  const otherRegistrationCount = Object.entries(exactRegistrationLimit.registrations)
    .filter(([field]) => field !== 'conversations')
    .reduce((total, [, rows]) => total + rows.length, 0);
  const exactRegistrationArray = ownKeys.watch(
    new Array(MAX_CHECKPOINT_REGISTRATION_RECORDS - otherRegistrationCount).fill(null));
  exactRegistrationLimit.registrations.conversations = exactRegistrationArray;
  exactRegistrationLimit.deliveryAttemptOrder = [];
  const exactLimitLedger = ownKeys.watch(exactRegistrationLimit.ledger);
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(exactRegistrationLimit));
  assert.equal(ownKeys.count(exactRegistrationArray), 1);
  assert.equal(ownKeys.count(exactLimitLedger), 1);
});

test('CP4 stops at the chunk that crosses the combined delivery limit', (t) => {
  const ownKeys = trackOwnKeys(t);
  const makeLimitedInput = (ordinaryCount) => {
    const input = clone(BASE_FIXTURE.checkpointFile);
    input.ledger.deliveries = new Array(ordinaryCount).fill(null);
    input.deliveryAttemptOrder = [];

    const firstCapsule = input.checkpointCapsules[0].capsule;
    firstCapsule.deliveries = firstCapsule.deliveries.slice(0, 1);
    firstCapsule.references.sources = firstCapsule.references.sources.slice(0, 1);
    firstCapsule.references.targets = firstCapsule.references.targets.slice(0, 1);

    const laterChunk = ownKeys.watch({ chunkId: 'not-a-uuid', capsule: {} });
    input.checkpointCapsules[1] = laterChunk;
    return { input, laterChunk };
  };

  const overLimit = makeLimitedInput(MAX_FILE_RECORDS);
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(overLimit.input));
  assert.equal(ownKeys.count(overLimit.laterChunk), 0);

  const atLimit = makeLimitedInput(MAX_FILE_RECORDS - 1);
  expectInvalid(() => normalizeCapsuleCheckpointV4Local(atLimit.input));
  assert.equal(ownKeys.count(atLimit.laterChunk), 1);
});

function createExpandedOverLimitFile() {
  const oldCheckpoint = normalizeCheckpointV3Local(BASE_FIXTURE.snapshot.stores.checkpoint,
    MAX_CHECKPOINT_REGISTRATION_RECORDS);
  const file = {
    schemaVersion: 4,
    storeId: oldCheckpoint.storeId,
    revision: oldCheckpoint.revision,
    registrations: clone(oldCheckpoint.registrations),
    ledger: clone(oldCheckpoint.ledger),
    migrationAllowance: null,
    checkpointCapsules: [],
    deliveryAttemptOrder: oldCheckpoint.ledger.deliveries.map((delivery) => delivery.deliveryAttemptId),
  };
  const template = clone(file.registrations.conversations[0]);

  function build(identifierLength) {
    const candidate = clone(file);
    candidate.registrations.conversations = candidate.registrations.conversations.slice();
    candidate.registrations.incompleteConversationIds =
      candidate.registrations.incompleteConversationIds.slice();
    for (let index = 0; index < MAX_REGISTRATION_ADDITIONS; index += 1) {
      const prefix = `file-limit-${String(index).padStart(5, '0')}-`;
      const identifier = prefix + 'x'.repeat(identifierLength - prefix.length);
      const conversation = clone(template);
      conversation.conversationId = identifier;
      conversation.identity.nativeId = `file-limit-native-${String(index).padStart(5, '0')}`;
      candidate.registrations.conversations.push(conversation);
      candidate.registrations.incompleteConversationIds.push(identifier);
    }
    return candidate;
  }

  let identifierLength = 512;
  let candidate = build(identifierLength);
  let compactSize = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
  let adjustment = Math.max(1, Math.ceil((compactSize - (MAX_FILE_BYTES - 200_000)) /
    (MAX_REGISTRATION_ADDITIONS * 2)));
  identifierLength = Math.max(32, identifierLength - adjustment);
  candidate = build(identifierLength);
  compactSize = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
  while (compactSize > MAX_FILE_BYTES) {
    identifierLength -= 1;
    candidate = build(identifierLength);
    compactSize = Buffer.byteLength(JSON.stringify(candidate), 'utf8');
  }
  while (identifierLength < 512) {
    const next = build(identifierLength + 1);
    const nextCompactSize = Buffer.byteLength(JSON.stringify(next), 'utf8');
    if (nextCompactSize > MAX_FILE_BYTES) break;
    identifierLength += 1;
    candidate = next;
    compactSize = nextCompactSize;
  }

  const normalizedSizeBytes = encodeNormalized(candidate).sizeBytes;
  return { candidate, compactSize, normalizedSizeBytes };
}

test('CP4 normalize and decode reject a valid legacy file whose normalized representation exceeds 16 MiB', () => {
  const { candidate, compactSize, normalizedSizeBytes } = createExpandedOverLimitFile();
  assert.ok(compactSize <= MAX_FILE_BYTES);
  assert.ok(normalizedSizeBytes > MAX_FILE_BYTES);
  assert.equal(normalizeCheckpointV3Local({
    schemaVersion: 3,
    storeId: candidate.storeId,
    revision: candidate.revision,
    registrations: candidate.registrations,
    ledger: candidate.ledger,
    migrationAllowance: null,
  }, MAX_CHECKPOINT_REGISTRATION_RECORDS).registrations.conversations.length, MAX_REGISTRATION_ADDITIONS + 2);

  expectInvalid(() => normalizeCapsuleCheckpointV4Local(candidate));
  expectInvalid(() => encodeCapsuleCheckpointV4Local(candidate));
  expectInvalid(() => decodeCapsuleCheckpointV4Local(Buffer.from(JSON.stringify(candidate), 'utf8')));
});
