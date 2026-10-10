'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  decodeQuestionCapsuleJournalV3Local,
  encodeQuestionCapsuleJournalV3Local,
  normalizeQuestionCapsuleJournalV3Local,
} = require('../src/server/question-capsule-journal-codec');
const { expandQuestionRejectionCapsule } = require('../src/server/question-rejection-capsule-codec');
const { normalizeQuestionJournalV2Local } = require('../src/server/common-question-reclamation-codec');
const { encodeNormalized } = require('../src/server/reclamation-json-codec');
const { createQuestionCapsuleFilesFixture } = require('./helpers/question-capsule-files-fixtures');

const INVALID_QUESTION_CAPSULE_JOURNAL = 'invalid_question_capsule_journal_v3';
const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_FILE_RECORDS = 20_000;

function clone(value) {
  return structuredClone(value);
}

function fixture(options) {
  const result = createQuestionCapsuleFilesFixture(options);
  assert.notEqual(result.questionFile, null);
  return result.questionFile;
}

function assertInvalid(operation) {
  assert.throws(operation, {
    name: 'TypeError',
    message: INVALID_QUESTION_CAPSULE_JOURNAL,
  });
}

function reverseObjectPropertyOrder(value) {
  if (Array.isArray(value)) return value.map(reverseObjectPropertyOrder);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) =>
      [key, reverseObjectPropertyOrder(item)]));
  }
  return value;
}

test('Q3 local codec accepts both providers and returns independent mutable values', () => {
  for (const provider of ['claude', 'codex']) {
    const input = fixture({ provider });
    const originalJson = JSON.stringify(input);
    const encoded = encodeQuestionCapsuleJournalV3Local(input);
    const normalized = normalizeQuestionCapsuleJournalV3Local(input);

    assert.deepEqual(normalized, encoded.value);
    assert.equal(decodeQuestionCapsuleJournalV3Local(encoded.bytes).schemaVersion, 3);
    assert.equal(encoded.bytes.length, encoded.sizeBytes);
    assert.match(encoded.sha256, /^[a-f0-9]{64}$/);
    assert.equal(Object.isFrozen(normalized), false);
    assert.equal(Object.isFrozen(normalized.reservations), false);
    assert.notStrictEqual(normalized, input);
    assert.notStrictEqual(normalized.reservations, input.reservations);

    normalized.reservationOrder.pop();
    assert.equal(JSON.stringify(input), originalJson);
  }
});

test('Q3 chunks canonicalize by UUID while declared reservation order remains independent', () => {
  const input = fixture({ provider: 'claude', secondaryProvider: 'codex', ordinaryQuestionSelected: true });
  assert.ok(input.questionCapsules.length > 1);
  const reorderedChunks = clone(input);
  reorderedChunks.questionCapsules.reverse();

  const canonical = encodeQuestionCapsuleJournalV3Local(input);
  const reordered = encodeQuestionCapsuleJournalV3Local(reorderedChunks);
  const chunkIds = reordered.value.questionCapsules.map(({ chunkId }) => chunkId);

  assert.deepEqual(chunkIds, [...chunkIds].sort());
  assert.deepEqual(reordered.bytes, canonical.bytes);
  assert.deepEqual(
    encodeQuestionCapsuleJournalV3Local(reverseObjectPropertyOrder(input)).bytes,
    canonical.bytes,
  );

  const ordinaryIds = input.reservations.map(({ internalQuestionId }) => internalQuestionId);
  const declaredOrdinaryIds = input.reservationOrder.filter((id) => ordinaryIds.includes(id));
  assert.deepEqual(declaredOrdinaryIds, ordinaryIds);
});

test('Q3 ordinary reclaimed reservations remain valid when they are not carried by a capsule', () => {
  const input = clone(fixture({ ordinaryQuestionSelected: true }));
  const extracted = expandQuestionRejectionCapsule(input.questionCapsules[0].capsule)[0];
  const existingOrdinary = input.reservations[0];
  input.questionCapsules.shift();
  input.reservations = [extracted, existingOrdinary];

  assert.equal(extracted.bodyState, 'reclaimed');
  assert.doesNotThrow(() => normalizeQuestionCapsuleJournalV3Local(input));

  input.reservations.reverse();
  assertInvalid(() => normalizeQuestionCapsuleJournalV3Local(input));
});

test('Q3 accepts a normal-only file with every reservation represented in its ordinary array', () => {
  const input = clone(fixture());
  const expandedReservations = input.questionCapsules.flatMap(({ capsule }) =>
    expandQuestionRejectionCapsule(capsule));
  const reservationsById = new Map([...input.reservations, ...expandedReservations].map((reservation) =>
    [reservation.internalQuestionId, reservation]));
  input.questionCapsules = [];
  input.reservations = input.reservationOrder.map((id) => reservationsById.get(id));

  const normalized = normalizeQuestionCapsuleJournalV3Local(input);
  assert.deepEqual(normalized.questionCapsules, []);
  assert.deepEqual(normalized.reservations.map(({ internalQuestionId }) => internalQuestionId),
    input.reservationOrder);

  assert.doesNotThrow(() => normalizeQuestionCapsuleJournalV3Local({
    schemaVersion: 3,
    storeId: input.storeId,
    revision: input.revision,
    questions: [],
    reservations: [],
    migrationAllowance: null,
    questionCapsules: [],
    reservationOrder: [],
  }));
});

test('Q3 rejects duplicate chunks, duplicate order IDs, duplicate reservations, and mismatched store headers', () => {
  const base = fixture({ ordinaryQuestionSelected: true });

  const duplicateChunk = clone(base);
  duplicateChunk.questionCapsules[1].chunkId = duplicateChunk.questionCapsules[0].chunkId;
  assertInvalid(() => normalizeQuestionCapsuleJournalV3Local(duplicateChunk));

  const duplicateOrder = clone(base);
  duplicateOrder.reservationOrder[1] = duplicateOrder.reservationOrder[0];
  assertInvalid(() => encodeQuestionCapsuleJournalV3Local(duplicateOrder));

  const duplicateReservation = clone(base);
  duplicateReservation.reservations[0].internalQuestionId =
    duplicateReservation.questionCapsules[0].capsule.reservations[0].internalQuestionId;
  assertInvalid(() => normalizeQuestionCapsuleJournalV3Local(duplicateReservation));

  const mismatchedStore = clone(base);
  mismatchedStore.questionCapsules[0].capsule.storeId = '99999999-9999-4999-8999-999999999999';
  assertInvalid(() => normalizeQuestionCapsuleJournalV3Local(mismatchedStore));
});

test('the real v2 reader refuses a Q3 file', () => {
  const input = fixture();
  assert.throws(() => normalizeQuestionJournalV2Local(input));
});

test('Q3 rejects accessors and proxies without invoking getters or proxy traps', () => {
  const getterInput = clone(fixture());
  let getterCalls = 0;
  Object.defineProperty(getterInput.questions[0], 'periodId', {
    enumerable: true,
    configurable: true,
    get() { getterCalls += 1; return 'period-1'; },
  });
  assertInvalid(() => normalizeQuestionCapsuleJournalV3Local(getterInput));
  assert.equal(getterCalls, 0);

  const makeProxy = (value) => {
    const counter = { count: 0 };
    const proxy = new Proxy(value, {
      getPrototypeOf() { counter.count += 1; return Object.getPrototypeOf(value); },
      ownKeys() { counter.count += 1; return Reflect.ownKeys(value); },
      getOwnPropertyDescriptor(target, key) {
        counter.count += 1;
        return Object.getOwnPropertyDescriptor(target, key);
      },
      get(target, key, receiver) { counter.count += 1; return Reflect.get(target, key, receiver); },
    });
    return { proxy, counter };
  };

  const rootProxy = makeProxy(fixture());
  assertInvalid(() => normalizeQuestionCapsuleJournalV3Local(rootProxy.proxy));
  assert.equal(rootProxy.counter.count, 0);

  const nestedProxyInput = clone(fixture());
  const nestedProxy = makeProxy(nestedProxyInput.questionCapsules[0]);
  nestedProxyInput.questionCapsules[0] = nestedProxy.proxy;
  assertInvalid(() => normalizeQuestionCapsuleJournalV3Local(nestedProxyInput));
  assert.equal(nestedProxy.counter.count, 0);
});

test('Q3 checks oversized arrays and raw bytes before enumerating rows or parsing JSON', () => {
  const oversizedArrayInput = clone(fixture());
  const oversizedQuestions = [];
  oversizedQuestions.length = 20_001;
  oversizedArrayInput.questions = oversizedQuestions;
  const originalOwnKeys = Reflect.ownKeys;
  let enumeratedOversizedArray = false;
  Reflect.ownKeys = function (value) {
    if (value === oversizedQuestions) enumeratedOversizedArray = true;
    return originalOwnKeys(value);
  };
  try {
    assertInvalid(() => normalizeQuestionCapsuleJournalV3Local(oversizedArrayInput));
  } finally {
    Reflect.ownKeys = originalOwnKeys;
  }
  assert.equal(enumeratedOversizedArray, false);

  const oversizedBytes = Buffer.alloc(MAX_FILE_BYTES + 1, 0x20);
  const originalParse = JSON.parse;
  let parseCalls = 0;
  JSON.parse = function (...args) {
    parseCalls += 1;
    return originalParse.apply(this, args);
  };
  try {
    assertInvalid(() => decodeQuestionCapsuleJournalV3Local(oversizedBytes));
  } finally {
    JSON.parse = originalParse;
  }
  assert.equal(parseCalls, 0);
});

test('Q3 stops visiting chunks when the combined ordinary and capsule count exceeds the limit', () => {
  const storeId = '11111111-1111-4111-8111-111111111111';
  const makeCapsule = () => ({
    formatVersion: 1,
    compactionOperationId: '22222222-2222-4222-8222-222222222222',
    storeId,
    identity: {},
    periodId: 'period-1',
    reservations: [{}],
  });
  const makeFile = (ordinaryCount) => ({
    schemaVersion: 3,
    storeId,
    revision: 0,
    questions: [],
    reservations: Array.from({ length: ordinaryCount }, () => ({})),
    migrationAllowance: null,
    questionCapsules: [],
    reservationOrder: [],
  });
  const originalOwnKeys = Reflect.ownKeys;

  const laterCapsuleAfterOverflow = makeCapsule();
  const countOverflowFile = makeFile(MAX_FILE_RECORDS);
  countOverflowFile.questionCapsules = [
    { chunkId: 'b0000000-0000-4000-8000-000000000001', capsule: makeCapsule() },
    { chunkId: 'b0000000-0000-4000-8000-000000000002', capsule: laterCapsuleAfterOverflow },
  ];
  let overflowChunkOwnKeys = 0;
  Reflect.ownKeys = function (value) {
    if (value === laterCapsuleAfterOverflow) overflowChunkOwnKeys += 1;
    return originalOwnKeys(value);
  };
  try {
    assertInvalid(() => normalizeQuestionCapsuleJournalV3Local(countOverflowFile));
  } finally {
    Reflect.ownKeys = originalOwnKeys;
  }
  assert.equal(overflowChunkOwnKeys, 0);

  const laterCapsuleAtLimit = makeCapsule();
  const exactLimitFile = makeFile(MAX_FILE_RECORDS - 1);
  exactLimitFile.questionCapsules = [
    { chunkId: 'b0000000-0000-4000-8000-000000000001', capsule: makeCapsule() },
    { chunkId: 'b0000000-0000-4000-8000-000000000002', capsule: laterCapsuleAtLimit },
  ];
  let atLimitChunkOwnKeys = 0;
  Reflect.ownKeys = function (value) {
    if (value === laterCapsuleAtLimit) atLimitChunkOwnKeys += 1;
    return originalOwnKeys(value);
  };
  try {
    assertInvalid(() => normalizeQuestionCapsuleJournalV3Local(exactLimitFile));
  } finally {
    Reflect.ownKeys = originalOwnKeys;
  }
  assert.ok(atLimitChunkOwnKeys > 0);
});

test('Q3 unifies malformed input, encoding, and decoding errors', () => {
  assertInvalid(() => normalizeQuestionCapsuleJournalV3Local(null));
  assertInvalid(() => encodeQuestionCapsuleJournalV3Local({}));
  assertInvalid(() => decodeQuestionCapsuleJournalV3Local(Buffer.from('{')));
  assertInvalid(() => decodeQuestionCapsuleJournalV3Local(Buffer.alloc(MAX_FILE_BYTES + 1)));
});

test('Q3 rejects a valid normal-only file whose pretty encoding exceeds the file cap', () => {
  const input = fixture({ ordinaryQuestionSelected: true });
  const expandedReservations = input.questionCapsules.flatMap(({ capsule }) =>
    expandQuestionRejectionCapsule(capsule));
  const reservationsById = new Map([...input.reservations, ...expandedReservations].map((reservation) =>
    [reservation.internalQuestionId, reservation]));
  const orderedReservations = input.reservationOrder.map((id) => reservationsById.get(id));
  const legacy = normalizeQuestionJournalV2Local({
    schemaVersion: 2,
    storeId: input.storeId,
    revision: input.revision,
    questions: input.questions,
    reservations: orderedReservations,
    migrationAllowance: null,
  });
  const reclaimedTemplate = legacy.reservations.find((reservation) =>
    reservation.bodyState === 'reclaimed' && reservation.deliveryCreationState === 'not_created');
  assert.ok(reclaimedTemplate);

  const reservations = legacy.reservations.slice();
  const reservationOrder = legacy.reservations.map(({ internalQuestionId }) => internalQuestionId);
  for (let index = reservations.length; index < 10_600; index += 1) {
    const reservation = clone(reclaimedTemplate);
    const suffix = String(index).padStart(5, '0');
    reservation.internalQuestionId = `internal-${suffix}`;
    reservation.questionId = `public-${suffix}`;
    reservations.push(reservation);
    reservationOrder.push(reservation.internalQuestionId);
  }
  const largeFile = {
    schemaVersion: 3,
    storeId: legacy.storeId,
    revision: legacy.revision,
    questions: legacy.questions,
    reservations,
    migrationAllowance: null,
    questionCapsules: [],
    reservationOrder,
  };
  const compactBytes = Buffer.from(JSON.stringify(largeFile), 'utf8');

  assert.equal(normalizeQuestionJournalV2Local({
    schemaVersion: 2,
    storeId: legacy.storeId,
    revision: legacy.revision,
    questions: legacy.questions,
    reservations,
    migrationAllowance: null,
  }).reservations.length, 10_600);
  assert.ok(compactBytes.length <= MAX_FILE_BYTES);
  assert.ok(encodeNormalized(largeFile).sizeBytes > MAX_FILE_BYTES);
  assertInvalid(() => normalizeQuestionCapsuleJournalV3Local(largeFile));
  assertInvalid(() => encodeQuestionCapsuleJournalV3Local(largeFile));
  assertInvalid(() => decodeQuestionCapsuleJournalV3Local(compactBytes));
});
