'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const {
  CAPSULE_LIMITS,
  decodeQuestionDeliveryCapsule,
  decodeQuestionRejectionCapsule,
  encodeQuestionDeliveryCapsule,
  encodeQuestionRejectionCapsule,
  expandQuestionDeliveryCapsule,
  expandQuestionRejectionCapsule,
  normalizeQuestionDeliveryCapsule,
  normalizeQuestionRejectionCapsule,
} = require('../src/server/question-rejection-capsule-codec');
const { encodeNormalized } = require('../src/server/reclamation-json-codec');
const {
  MAX_ESCAPED_IDENTIFIER,
  QUESTION_GRAVE_MAX_SHAPE,
  QUESTION_RESERVATION_MAX_SHAPE,
  prettyJsonUpperBound,
} = require('./helpers/reclaimed-question-record-byte-fixtures');
const {
  createQuestionRejectionCapsuleFixture,
  makeDeliveryCapsule,
  makeQuestionCapsule,
} = require('./helpers/question-rejection-capsule-fixtures');

const PROVIDERS = ['claude', 'codex'];
const CHECKPOINT_STATES = ['available', 'unknown', 'applied', 'cancelled_before_send', 'superseded_before_send'];
const OTHER_UUID = '44444444-4444-4444-8444-444444444444';

function metadata(fixture) {
  return {
    storeId: fixture.questionCapsule.storeId,
    compactionOperationId: fixture.questionCapsule.compactionOperationId,
    identity: fixture.questionCapsule.identity,
    periodId: fixture.questionCapsule.periodId,
  };
}

function reordered(value) {
  if (Array.isArray(value)) return value.map(reordered);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)]));
}

function longIdentifier(prefix, index, length) {
  const uniquePrefix = `${prefix}-${String(index).padStart(3, '0')}-`;
  assert.ok(length >= uniquePrefix.length && length <= 512);
  return uniquePrefix + 'x'.repeat(length - uniquePrefix.length);
}

function checkpointedQuestionRecord(record, index) {
  const next = structuredClone(record);
  next.deliveryCreationState = 'checkpointed';
  next.checkpointState = 'available';
  next.sourceClaimsDigest = 'a'.repeat(64);
  next.sessionId = `session-${index}`;
  next.terminalResultKind = null;
  next.reclamation.deliveryPresence = 'checkpoint';
  next.reclamation.checkpointState = 'available';
  return next;
}

const QUESTION_CAPSULE_VARIABLES = [
  ['internalQuestionId', 'internal'],
  ['questionId', 'question'],
  ['executionId', 'execution'],
  ['conversationId', 'conversation'],
  ['launchRef', 'launch'],
  ['executionBinding.actor.id', 'actor'],
  ['deliveryIntent.deliveryAttemptId', 'attempt'],
  ['deliveryIntent.logicalMessageId', 'logical'],
  ['sessionId', 'session'],
];

function setPath(record, path, value) {
  const parts = path.split('.');
  let current = record;
  for (const part of parts.slice(0, -1)) current = current[part];
  current[parts.at(-1)] = value;
}

function createQuestionCapsuleAtSize(fixture, targetSize) {
  const records = Array.from({ length: CAPSULE_LIMITS.maxQuestionEntries }, (_, index) =>
    checkpointedQuestionRecord(fixture.reservation, index));
  const lengths = records.map(() => new Array(QUESTION_CAPSULE_VARIABLES.length));
  for (let index = 0; index < records.length; index += 1) {
    QUESTION_CAPSULE_VARIABLES.forEach(([path, prefix], fieldIndex) => {
      const uniquePrefix = `${prefix}-${String(index).padStart(3, '0')}-`;
      lengths[index][fieldIndex] = uniquePrefix.length;
      setPath(records[index], path, uniquePrefix);
    });
  }

  const build = () => makeQuestionCapsule(records, metadata(fixture));
  const initialCapsule = build();
  let remainingBytes = targetSize - encodeNormalized(initialCapsule).sizeBytes;
  assert.ok(remainingBytes >= 0, 'target must be at or above the shortest valid fixture');

  for (let index = 0; index < records.length && remainingBytes > 0; index += 1) {
    for (let fieldIndex = 0; fieldIndex < QUESTION_CAPSULE_VARIABLES.length && remainingBytes > 0; fieldIndex += 1) {
      const [path, prefix] = QUESTION_CAPSULE_VARIABLES[fieldIndex];
      const uniquePrefix = `${prefix}-${String(index).padStart(3, '0')}-`;
      const increment = Math.min(512 - lengths[index][fieldIndex], remainingBytes);
      lengths[index][fieldIndex] += increment;
      remainingBytes -= increment;
      setPath(records[index], path, longIdentifier(prefix, index, lengths[index][fieldIndex]));
    }
  }

  assert.equal(remainingBytes, 0, 'valid bounded identifiers must reach the target byte count');
  return build();
}

function makeUniqueQuestionDelivery(delivery, index) {
  const next = structuredClone(delivery);
  const suffix = String(index).padStart(3, '0');
  const launchRef = `launch-ref-${suffix}`;
  const launchKey = [`launch-${suffix}`, `run-${suffix}`, `attempt-${suffix}`];
  const claimsDigest = String(index + 1).toString(16).padStart(64, '0');
  next.deliveryAttemptId = `delivery-attempt-${suffix}`;
  next.logicalMessageId = `logical-message-${suffix}`;
  next.sourceRef.launchRef = launchRef;
  next.targetRef.launchRef = launchRef;
  next.sourceRef.launchKey = structuredClone(launchKey);
  next.targetRef.launchKey = structuredClone(launchKey);
  next.sourceRef.sourceClaimsDigest = claimsDigest;
  next.targetRef.targetClaimsDigest = claimsDigest;
  return next;
}

const DELIVERY_CAPSULE_VARIABLES = [
  ['sourceRef.launchRef', 'launch-ref', 2],
  ['sourceRef.launchKey.0', 'launch', 2],
  ['sourceRef.launchKey.1', 'run', 2],
  ['sourceRef.launchKey.2', 'attempt', 2],
  ['deliveryAttemptId', 'delivery-attempt', 1],
  ['logicalMessageId', 'logical-message', 1],
];

function setDeliveryPath(delivery, path, value) {
  if (!path.includes('.')) {
    delivery[path] = value;
  } else if (path.startsWith('sourceRef.launchKey.')) {
    const index = Number(path.split('.').at(-1));
    delivery.sourceRef.launchKey[index] = value;
    delivery.targetRef.launchKey[index] = value;
  } else if (path.startsWith('sourceRef.')) {
    const property = path.slice('sourceRef.'.length);
    delivery.sourceRef[property] = value;
    delivery.targetRef[property] = value;
  }
}

function createDeliveryCapsuleAtSize(fixture, targetSize) {
  const deliveries = Array.from({ length: CAPSULE_LIMITS.maxDeliveryEntries }, (_, index) =>
    makeUniqueQuestionDelivery(fixture.delivery, index));
  for (let index = 0; index < deliveries.length; index += 1) {
    const suffix = String(index).padStart(3, '0');
    deliveries[index].deliveryAttemptId = `delivery-attempt-${suffix}-`;
    deliveries[index].logicalMessageId = `logical-message-${suffix}-`;
    deliveries[index].sourceRef.launchRef = `launch-ref-${suffix}-`;
    deliveries[index].targetRef.launchRef = `launch-ref-${suffix}-`;
    const tuple = [`launch-${suffix}-`, `run-${suffix}-`, `attempt-${suffix}-`];
    deliveries[index].sourceRef.launchKey = structuredClone(tuple);
    deliveries[index].targetRef.launchKey = structuredClone(tuple);
  }

  const build = () => makeDeliveryCapsule(deliveries, metadata(fixture));
  const initialCapsule = build();
  let remainingBytes = targetSize - encodeNormalized(initialCapsule).sizeBytes;
  assert.ok(remainingBytes >= 0, 'target must be at or above the shortest valid fixture');

  for (const [path, prefix, byteCost] of DELIVERY_CAPSULE_VARIABLES) {
    if (remainingBytes === 0) break;
    for (let index = 0; index < deliveries.length && remainingBytes >= byteCost; index += 1) {
      const suffix = String(index).padStart(3, '0');
      const valuePrefix = path === 'deliveryAttemptId' ? `${prefix}-${suffix}-`
        : path === 'logicalMessageId' ? `${prefix}-${suffix}-`
          : path.endsWith('launchRef') ? `launch-ref-${suffix}-`
            : `${prefix}-${suffix}-`;
      const currentLength = path === 'deliveryAttemptId' ? deliveries[index].deliveryAttemptId.length
        : path === 'logicalMessageId' ? deliveries[index].logicalMessageId.length
          : path.endsWith('launchRef') ? deliveries[index].sourceRef.launchRef.length
            : deliveries[index].sourceRef.launchKey[Number(path.split('.').at(-1))].length;
      const remainingCapacity = 512 - currentLength;
      const increment = Math.min(remainingCapacity, Math.floor(remainingBytes / byteCost));
      if (increment === 0) continue;
      setDeliveryPath(deliveries[index], path, valuePrefix + 'x'.repeat(increment));
      remainingBytes -= increment * byteCost;
    }
  }

  assert.equal(remainingBytes, 0, 'valid bounded identifiers must reach the target byte count');
  return build();
}

function makeMaximalQuestionCapsule(fixture) {
  const reservation = checkpointedQuestionRecord(fixture.reservation, 0);
  const periodId = 'p'.repeat(512);
  reservation.internalQuestionId = 'i'.repeat(512);
  reservation.questionId = 'q'.repeat(512);
  reservation.executionId = periodId;
  reservation.conversationId = 'c'.repeat(512);
  reservation.launchRef = 'l'.repeat(512);
  reservation.executionBinding.periodId = periodId;
  reservation.executionBinding.actor.id = 'a'.repeat(512);
  reservation.deliveryIntent.deliveryAttemptId = 'd'.repeat(512);
  reservation.deliveryIntent.logicalMessageId = 'm'.repeat(512);
  reservation.sessionId = 's'.repeat(512);
  const identity = structuredClone(reservation.identity);
  identity.hostId = 'h'.repeat(512);
  identity.homeScopeId = 'o'.repeat(512);
  identity.nativeId = 'n'.repeat(512);
  return makeQuestionCapsule([reservation], { ...metadata(fixture), identity, periodId });
}

function makeMaximalDeliveryCapsule(fixture) {
  const delivery = structuredClone(fixture.delivery);
  const identity = structuredClone(fixture.questionCapsule.identity);
  identity.hostId = 'h'.repeat(512);
  identity.homeScopeId = 'o'.repeat(512);
  identity.nativeId = 'n'.repeat(512);
  const periodId = 'p'.repeat(512);
  delivery.deliveryAttemptId = 'd'.repeat(512);
  delivery.logicalMessageId = 'm'.repeat(512);
  delivery.sourceExecutionId = periodId;
  delivery.sourceRef.launchRef = 'l'.repeat(512);
  delivery.targetRef.launchRef = delivery.sourceRef.launchRef;
  delivery.sourceRef.launchKey = ['a'.repeat(512), 'b'.repeat(512), 'c'.repeat(512)];
  delivery.targetRef.launchKey = structuredClone(delivery.sourceRef.launchKey);
  delivery.sourceRef.identity = structuredClone(identity);
  delivery.targetRef.identity = structuredClone(identity);
  delivery.sourceRef.executionBinding.periodId = periodId;
  delivery.targetRef.periodId = periodId;
  delivery.sourceRef.executionBinding.actor.id = 'x'.repeat(512);
  delivery.targetRef.actor.id = 'x'.repeat(512);
  delivery.sourceRef.conversationId = 'c'.repeat(512);
  delivery.targetRef.conversationId = 'c'.repeat(512);
  delivery.sourceRef.sessionId = 's'.repeat(512);
  delivery.targetRef.sessionId = 's'.repeat(512);
  const claimsDigest = 'e'.repeat(64);
  delivery.sourceRef.sourceClaimsDigest = claimsDigest;
  delivery.targetRef.targetClaimsDigest = claimsDigest;
  return makeDeliveryCapsule([delivery], { ...metadata(fixture), identity, periodId });
}

function proxyWithTrapCounter(value, counter) {
  return new Proxy(value, {
    getPrototypeOf() { counter.count += 1; return Object.getPrototypeOf(value); },
    ownKeys() { counter.count += 1; return Reflect.ownKeys(value); },
    getOwnPropertyDescriptor(target, key) {
      counter.count += 1;
      return Object.getOwnPropertyDescriptor(target, key);
    },
    get(target, key, receiver) { counter.count += 1; return Reflect.get(target, key, receiver); },
  });
}

test('capsules preserve complete reclaimed records for each provider and checkpoint state', () => {
  for (const provider of PROVIDERS) {
    for (const state of CHECKPOINT_STATES) {
      const fixture = createQuestionRejectionCapsuleFixture({ provider, presence: 'checkpoint', state });
      const question = normalizeQuestionRejectionCapsule(fixture.questionCapsule);
      const checkpoint = normalizeQuestionDeliveryCapsule(fixture.checkpointCapsule);

      assert.deepEqual(expandQuestionRejectionCapsule(question), [fixture.reservation]);
      assert.deepEqual(expandQuestionDeliveryCapsule(checkpoint), [fixture.delivery]);
      assert.equal(checkpoint.references.sources.length, 1);
      assert.equal(checkpoint.references.targets.length, 1);
      assert.equal(checkpoint.deliveries[0].sourceRefIndex, 0);
      assert.equal(checkpoint.deliveries[0].targetRefIndex, 0);
    }

    for (const presence of ['none', 'indeterminate']) {
      const fixture = createQuestionRejectionCapsuleFixture({ provider, presence });
      assert.deepEqual(expandQuestionRejectionCapsule(fixture.questionCapsule), [fixture.reservation]);
      assert.equal(fixture.checkpointCapsule, null);
      assert.deepEqual(fixture.selectedLogicalTombstones, []);
    }

    const unselected = createQuestionRejectionCapsuleFixture({
      provider,
      presence: 'none',
      selected: false,
    });
    assert.equal(unselected.reservation.deliveryIntent, null);
    assert.deepEqual(expandQuestionRejectionCapsule(unselected.questionCapsule), [unselected.reservation]);
  }
});

test('encoders and decoders return canonical capsule bytes without changing the input', () => {
  const fixture = createQuestionRejectionCapsuleFixture({ provider: 'codex', presence: 'checkpoint', state: 'applied' });
  for (const [input, encode, decode, normalize, maxBytes] of [
    [fixture.questionCapsule, encodeQuestionRejectionCapsule, decodeQuestionRejectionCapsule,
      normalizeQuestionRejectionCapsule, CAPSULE_LIMITS.maxQuestionBytes],
    [fixture.checkpointCapsule, encodeQuestionDeliveryCapsule, decodeQuestionDeliveryCapsule,
      normalizeQuestionDeliveryCapsule, CAPSULE_LIMITS.maxCheckpointBytes],
  ]) {
    const before = encodeNormalized(input).bytes;
    const encoded = encode(input);
    assert.deepEqual(encoded.value, normalize(input));
    assert.deepEqual(decode(encoded.bytes), encoded.value);
    assert.equal(encoded.sizeBytes, encoded.bytes.byteLength);
    assert.equal(encoded.sha256, createHash('sha256').update(encoded.bytes).digest('hex'));
    assert.deepEqual(encodeNormalized(input).bytes, before);
    assert.equal(Object.isFrozen(input), false);
    assert.ok(encoded.sizeBytes <= maxBytes);
  }
});

test('wrapper operation IDs are independent from each reclaimed record operation ID', () => {
  const fixture = createQuestionRejectionCapsuleFixture({ provider: 'claude', presence: 'checkpoint' });
  assert.notEqual(fixture.questionCapsule.compactionOperationId, fixture.reservation.reclamation.operationId);
  assert.notEqual(fixture.checkpointCapsule.compactionOperationId, fixture.delivery.reclamation.operationId);
  assert.doesNotThrow(() => normalizeQuestionRejectionCapsule(fixture.questionCapsule));
  assert.doesNotThrow(() => normalizeQuestionDeliveryCapsule(fixture.checkpointCapsule));

  const sameQuestionOperation = structuredClone(fixture.questionCapsule);
  sameQuestionOperation.compactionOperationId = fixture.reservation.reclamation.operationId;
  assert.doesNotThrow(() => normalizeQuestionRejectionCapsule(sameQuestionOperation));

  const sameDeliveryOperation = structuredClone(fixture.checkpointCapsule);
  sameDeliveryOperation.compactionOperationId = fixture.delivery.reclamation.operationId;
  assert.doesNotThrow(() => normalizeQuestionDeliveryCapsule(sameDeliveryOperation));
});

test('normalization ignores object property insertion order but preserves array order', () => {
  const fixture = createQuestionRejectionCapsuleFixture({ provider: 'claude', presence: 'checkpoint' });
  assert.deepEqual(
    normalizeQuestionRejectionCapsule(reordered(fixture.questionCapsule)),
    normalizeQuestionRejectionCapsule(fixture.questionCapsule),
  );
  assert.deepEqual(
    normalizeQuestionDeliveryCapsule(reordered(fixture.checkpointCapsule)),
    normalizeQuestionDeliveryCapsule(fixture.checkpointCapsule),
  );

  const reservationsFixture = createQuestionRejectionCapsuleFixture({
    provider: 'claude', presence: 'none', selected: false,
  });
  const metadataValue = metadata(reservationsFixture);
  const reservations = [
    { ...structuredClone(reservationsFixture.reservation), internalQuestionId: 'question-a', questionId: 'public-a' },
    { ...structuredClone(reservationsFixture.reservation), internalQuestionId: 'question-b', questionId: 'public-b' },
  ];
  const unsortedQuestions = makeQuestionCapsule(reservations.reverse(), metadataValue);
  assert.throws(() => normalizeQuestionRejectionCapsule(unsortedQuestions), TypeError);

  const deliveryFixture = createQuestionRejectionCapsuleFixture({ provider: 'claude', presence: 'checkpoint' });
  const deliveries = [makeUniqueQuestionDelivery(deliveryFixture.delivery, 0),
    makeUniqueQuestionDelivery(deliveryFixture.delivery, 1)];
  const unsortedDeliveries = makeDeliveryCapsule(deliveries.reverse(), metadata(deliveryFixture));
  assert.throws(() => normalizeQuestionDeliveryCapsule(unsortedDeliveries), TypeError);
});

test('reference dictionaries share equal values and require unique first-use order', () => {
  const fixture = createQuestionRejectionCapsuleFixture({ provider: 'codex', presence: 'checkpoint' });
  const firstDelivery = makeUniqueQuestionDelivery(fixture.delivery, 0);
  const repeatedReferenceDelivery = makeUniqueQuestionDelivery(fixture.delivery, 1);
  repeatedReferenceDelivery.sourceRef = structuredClone(firstDelivery.sourceRef);
  repeatedReferenceDelivery.targetRef = structuredClone(firstDelivery.targetRef);
  const shared = makeDeliveryCapsule([
    firstDelivery,
    repeatedReferenceDelivery,
  ], metadata(fixture));
  assert.equal(normalizeQuestionDeliveryCapsule(shared).references.sources.length, 1);

  const uniqueDeliveries = [makeUniqueQuestionDelivery(fixture.delivery, 0),
    makeUniqueQuestionDelivery(fixture.delivery, 1)];
  const unique = makeDeliveryCapsule(uniqueDeliveries, metadata(fixture));
  assert.equal(normalizeQuestionDeliveryCapsule(unique).references.sources.length, 2);
  assert.equal(normalizeQuestionDeliveryCapsule(unique).references.targets.length, 2);

  const reversedFirstUse = structuredClone(unique);
  reversedFirstUse.references.sources.reverse();
  reversedFirstUse.references.targets.reverse();
  reversedFirstUse.deliveries[0].sourceRefIndex = 1;
  reversedFirstUse.deliveries[0].targetRefIndex = 1;
  reversedFirstUse.deliveries[1].sourceRefIndex = 0;
  reversedFirstUse.deliveries[1].targetRefIndex = 0;
  assert.throws(() => normalizeQuestionDeliveryCapsule(reversedFirstUse), TypeError);

  const duplicate = structuredClone(unique);
  duplicate.references.sources[1] = structuredClone(duplicate.references.sources[0]);
  duplicate.references.targets[1] = structuredClone(duplicate.references.targets[0]);
  assert.throws(() => normalizeQuestionDeliveryCapsule(duplicate), TypeError);

  const unused = structuredClone(unique);
  unused.references.sources.push(structuredClone(unused.references.sources[0]));
  assert.throws(() => normalizeQuestionDeliveryCapsule(unused), TypeError);

  const outOfRange = structuredClone(fixture.checkpointCapsule);
  outOfRange.deliveries[0].sourceRefIndex = 1;
  assert.throws(() => normalizeQuestionDeliveryCapsule(outOfRange), TypeError);

  const wrongRole = structuredClone(fixture.checkpointCapsule);
  wrongRole.references.sources[0] = structuredClone(fixture.delivery.targetRef);
  assert.throws(() => normalizeQuestionDeliveryCapsule(wrongRole), TypeError);
});

test('wrapper fields, record state, identity, and record count are validated exactly', () => {
  const fixture = createQuestionRejectionCapsuleFixture({ provider: 'claude', presence: 'checkpoint' });
  const unknownWrapperField = structuredClone(fixture.questionCapsule);
  unknownWrapperField.extra = true;
  assert.throws(() => normalizeQuestionRejectionCapsule(unknownWrapperField), TypeError);

  const unknownReservationField = structuredClone(fixture.questionCapsule);
  unknownReservationField.reservations[0].extra = true;
  assert.throws(() => normalizeQuestionRejectionCapsule(unknownReservationField), TypeError);

  const unknownDeliveryField = structuredClone(fixture.checkpointCapsule);
  unknownDeliveryField.deliveries[0].extra = true;
  assert.throws(() => normalizeQuestionDeliveryCapsule(unknownDeliveryField), TypeError);

  const copiedIdentity = structuredClone(fixture.questionCapsule);
  copiedIdentity.reservations[0].identity = structuredClone(copiedIdentity.identity);
  assert.throws(() => normalizeQuestionRejectionCapsule(copiedIdentity), TypeError);

  const wrongCheckpointScope = structuredClone(fixture.checkpointCapsule);
  wrongCheckpointScope.identity.nativeId = 'different-native';
  assert.throws(() => normalizeQuestionDeliveryCapsule(wrongCheckpointScope), TypeError);

  const wrongOperationId = structuredClone(fixture.questionCapsule);
  wrongOperationId.compactionOperationId = 'not-a-uuid';
  assert.throws(() => normalizeQuestionRejectionCapsule(wrongOperationId), TypeError);

  const retained = structuredClone(fixture.questionCapsule);
  retained.reservations[0].bodyState = 'retained';
  retained.reservations[0].reclaimedAt = null;
  assert.throws(() => normalizeQuestionRejectionCapsule(retained), TypeError);

  const selectedFixture = createQuestionRejectionCapsuleFixture({
    provider: 'claude', presence: 'none', selected: true,
  });
  const duplicateAttemptRows = [
    structuredClone(selectedFixture.reservation),
    structuredClone(selectedFixture.reservation),
  ];
  duplicateAttemptRows[0].internalQuestionId = 'internal-a';
  duplicateAttemptRows[0].questionId = 'question-a';
  duplicateAttemptRows[1].internalQuestionId = 'internal-b';
  duplicateAttemptRows[1].questionId = 'question-b';
  assert.throws(() => normalizeQuestionRejectionCapsule(
    makeQuestionCapsule(duplicateAttemptRows, metadata(selectedFixture))), TypeError);

  const duplicateDeliveryRows = [
    makeUniqueQuestionDelivery(fixture.delivery, 0),
    makeUniqueQuestionDelivery(fixture.delivery, 1),
  ];
  duplicateDeliveryRows[1].deliveryAttemptId = duplicateDeliveryRows[0].deliveryAttemptId;
  assert.throws(() => normalizeQuestionDeliveryCapsule(
    makeDeliveryCapsule(duplicateDeliveryRows, metadata(fixture))), TypeError);

  assert.throws(() => normalizeQuestionDeliveryCapsule({
    ...fixture.checkpointCapsule,
    deliveries: [],
  }), TypeError);

  const countFixture = createQuestionRejectionCapsuleFixture({
    provider: 'codex', presence: 'none', selected: false,
  });
  const records = Array.from({ length: CAPSULE_LIMITS.maxQuestionEntries }, (_, index) => {
    const record = structuredClone(countFixture.reservation);
    record.internalQuestionId = `question-${String(index).padStart(3, '0')}`;
    record.questionId = `public-${String(index).padStart(3, '0')}`;
    return record;
  });
  const atLimit = makeQuestionCapsule(records, metadata(countFixture));
  assert.equal(normalizeQuestionRejectionCapsule(atLimit).reservations.length, 256);
  records.push(structuredClone(records.at(-1)));
  const overLimit = makeQuestionCapsule(records, metadata(countFixture));
  assert.throws(() => normalizeQuestionRejectionCapsule(overLimit), TypeError);

  const delivery = createQuestionRejectionCapsuleFixture({ provider: 'codex', presence: 'checkpoint' });
  const deliveries = Array.from({ length: CAPSULE_LIMITS.maxDeliveryEntries }, (_, index) =>
    makeUniqueQuestionDelivery(delivery.delivery, index));
  const deliveryAtLimit = makeDeliveryCapsule(deliveries, metadata(delivery));
  assert.equal(normalizeQuestionDeliveryCapsule(deliveryAtLimit).deliveries.length, 256);
  deliveries.push(makeUniqueQuestionDelivery(delivery.delivery, 256));
  assert.throws(() => normalizeQuestionDeliveryCapsule(
    makeDeliveryCapsule(deliveries, metadata(delivery))), TypeError);
});

test('preflight rejects getters, proxies, sparse arrays, and invalid byte sources without executing traps', () => {
  const fixture = createQuestionRejectionCapsuleFixture({ provider: 'claude', presence: 'checkpoint' });
  let getterCalls = 0;
  const getterCapsule = structuredClone(fixture.questionCapsule);
  Object.defineProperty(getterCapsule.reservations[0], 'internalQuestionId', {
    enumerable: true,
    get() { getterCalls += 1; return fixture.reservation.internalQuestionId; },
  });
  assert.throws(() => normalizeQuestionRejectionCapsule(getterCapsule), TypeError);
  assert.equal(getterCalls, 0);

  const referenceGetterCapsule = structuredClone(fixture.checkpointCapsule);
  Object.defineProperty(referenceGetterCapsule.references.sources[0], 'launchRef', {
    enumerable: true,
    get() { getterCalls += 1; return fixture.delivery.sourceRef.launchRef; },
  });
  assert.throws(() => normalizeQuestionDeliveryCapsule(referenceGetterCapsule), TypeError);
  assert.equal(getterCalls, 0);

  const proxyCounter = { count: 0 };
  assert.throws(() => normalizeQuestionRejectionCapsule(
    proxyWithTrapCounter(structuredClone(fixture.questionCapsule), proxyCounter)), TypeError);
  assert.equal(proxyCounter.count, 0);

  const nestedProxyCounter = { count: 0 };
  const proxiedReferences = structuredClone(fixture.checkpointCapsule);
  proxiedReferences.references.sources[0] = proxyWithTrapCounter(
    proxiedReferences.references.sources[0], nestedProxyCounter);
  assert.throws(() => normalizeQuestionDeliveryCapsule(proxiedReferences), TypeError);
  assert.equal(nestedProxyCounter.count, 0);

  const sparse = structuredClone(fixture.questionCapsule);
  sparse.reservations = new Array(1);
  assert.throws(() => normalizeQuestionRejectionCapsule(sparse), TypeError);
  assert.throws(() => decodeQuestionRejectionCapsule(Buffer.from([0xff])), TypeError);
  assert.throws(() => decodeQuestionDeliveryCapsule(Buffer.from('{')), TypeError);
  assert.throws(() => decodeQuestionRejectionCapsule(
    Buffer.alloc(CAPSULE_LIMITS.maxQuestionBytes + 1)), RangeError);
});

test('最大長の単一recordと完全reference辞書を含むcapsuleも固定byte上限内に入る', () => {
  const fixture = createQuestionRejectionCapsuleFixture({ provider: 'claude', presence: 'checkpoint' });
  const question = encodeQuestionRejectionCapsule(makeMaximalQuestionCapsule(fixture));
  const checkpoint = encodeQuestionDeliveryCapsule(makeMaximalDeliveryCapsule(fixture));
  assert.ok(question.sizeBytes < CAPSULE_LIMITS.maxQuestionBytes);
  assert.ok(checkpoint.sizeBytes < CAPSULE_LIMITS.maxCheckpointBytes);
  assert.equal(expandQuestionRejectionCapsule(question.value)[0].identity.hostId, 'h'.repeat(512));
  assert.equal(expandQuestionDeliveryCapsule(checkpoint.value)[0].sourceRef.launchKey[2], 'c'.repeat(512));

  const questionEntry = Object.fromEntries(Object.entries(QUESTION_RESERVATION_MAX_SHAPE)
    .filter(([key]) => key !== 'identity' && key !== 'periodId'));
  const questionUpperBound = prettyJsonUpperBound({
    formatVersion: 1,
    compactionOperationId: MAX_ESCAPED_IDENTIFIER,
    storeId: MAX_ESCAPED_IDENTIFIER,
    identity: QUESTION_RESERVATION_MAX_SHAPE.identity,
    periodId: MAX_ESCAPED_IDENTIFIER,
    reservations: [questionEntry],
  }) + 1;
  const deliveryEntry = Object.fromEntries(Object.entries(QUESTION_GRAVE_MAX_SHAPE)
    .filter(([key]) => key !== 'sourceRef' && key !== 'targetRef'));
  deliveryEntry.sourceRefIndex = 0;
  deliveryEntry.targetRefIndex = 0;
  const deliveryUpperBound = prettyJsonUpperBound({
    formatVersion: 1,
    compactionOperationId: MAX_ESCAPED_IDENTIFIER,
    storeId: MAX_ESCAPED_IDENTIFIER,
    identity: QUESTION_GRAVE_MAX_SHAPE.sourceRef.identity,
    periodId: QUESTION_GRAVE_MAX_SHAPE.sourceRef.executionBinding.periodId,
    references: {
      sources: [QUESTION_GRAVE_MAX_SHAPE.sourceRef],
      targets: [QUESTION_GRAVE_MAX_SHAPE.targetRef],
    },
    deliveries: [deliveryEntry],
  }) + 1;
  assert.equal(questionUpperBound, 96_657);
  assert.equal(deliveryUpperBound, 186_690);
  assert.ok(questionUpperBound < CAPSULE_LIMITS.maxQuestionBytes);
  assert.ok(deliveryUpperBound < CAPSULE_LIMITS.maxCheckpointBytes);
});

test('question capsule pretty bytes accept immediately below and at the cap and reject one byte above', () => {
  const fixture = createQuestionRejectionCapsuleFixture({
    provider: 'codex', presence: 'none', selected: true,
  });
  for (const targetSize of [CAPSULE_LIMITS.maxQuestionBytes - 1, CAPSULE_LIMITS.maxQuestionBytes]) {
    const capsule = createQuestionCapsuleAtSize(fixture, targetSize);
    const encoded = encodeQuestionRejectionCapsule(capsule);
    assert.equal(encoded.sizeBytes, targetSize);
  }
  const overLimit = createQuestionCapsuleAtSize(fixture, CAPSULE_LIMITS.maxQuestionBytes + 1);
  assert.throws(() => normalizeQuestionRejectionCapsule(overLimit), {
    name: 'RangeError', message: 'question_capsule_too_large',
  });
  assert.throws(() => encodeQuestionRejectionCapsule(overLimit), {
    name: 'RangeError', message: 'question_capsule_too_large',
  });
});

test('checkpoint capsule pretty bytes accept immediately below and at the cap and reject one byte above', () => {
  const fixture = createQuestionRejectionCapsuleFixture({ provider: 'claude', presence: 'checkpoint' });
  for (const targetSize of [CAPSULE_LIMITS.maxCheckpointBytes - 1, CAPSULE_LIMITS.maxCheckpointBytes]) {
    const capsule = createDeliveryCapsuleAtSize(fixture, targetSize);
    const encoded = encodeQuestionDeliveryCapsule(capsule);
    assert.equal(encoded.sizeBytes, targetSize);
  }
  const overLimit = createDeliveryCapsuleAtSize(fixture, CAPSULE_LIMITS.maxCheckpointBytes + 1);
  assert.throws(() => normalizeQuestionDeliveryCapsule(overLimit), {
    name: 'RangeError', message: 'question_delivery_capsule_too_large',
  });
  assert.throws(() => encodeQuestionDeliveryCapsule(overLimit), {
    name: 'RangeError', message: 'question_delivery_capsule_too_large',
  });
});
