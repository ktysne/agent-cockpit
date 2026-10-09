'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');

const {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
} = require('../src/server/question-reclamation-anchor-codec');

const UUID_A = '11111111-1111-4111-8111-111111111111';
const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const MAX_SOURCE_BYTES = 16_777_216;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function identityFor(provider, suffix) {
  return {
    provider,
    nativeIdKind: provider === 'claude' ? 'session' : 'thread',
    hostId: `${provider}-host-${suffix}`,
    homeScopeId: `${provider}-home-${suffix}`,
    nativeId: `${provider}-native-${suffix}`,
  };
}

function retiredPeriodFor(provider = 'codex', suffix = 'one', overrides = {}) {
  return {
    identity: identityFor(provider, suffix),
    periodId: `period-${suffix}`,
    retiredAt: 10,
    reason: 'startup-quarantine',
    ...overrides,
  };
}

function deliveryIntentFor(suffix = 'one') {
  return {
    deliveryAttemptId: `attempt-${suffix}`,
    logicalMessageId: `logical-${suffix}`,
    revision: 2,
    payloadDigest: SHA_A,
  };
}

function targetFor(overrides = {}) {
  return {
    internalQuestionId: 'internal-question-one',
    commonKeyDigest: SHA_A,
    periodIndex: 0,
    recordDigest: SHA_B,
    deliveryPresence: 'none',
    deliveryIntent: null,
    checkpointState: null,
    ...overrides,
  };
}

function sourceDescriptor(slot, overrides = {}) {
  const versions = {
    questions: [1, 2],
    checkpoint: [2, 3],
    instructions: [1, 2],
  }[slot];
  const sourcePresent = overrides.sourcePresent ?? true;
  return {
    slot,
    sourcePresent,
    schemaVersion: sourcePresent ? versions[0] : null,
    revision: sourcePresent ? 3 : null,
    sizeBytes: sourcePresent ? 123 : 0,
    sha256: sourcePresent ? SHA_A : null,
    targetSchemaVersion: versions[1],
    targetRevision: sourcePresent ? 4 : 0,
    targetSizeBytes: 456,
    targetSha256: SHA_B,
    ...overrides,
  };
}

function migrationFor(overrides = {}) {
  return {
    operationId: UUID_A,
    startedAt: 20,
    phase: 'prepared',
    sources: [
      sourceDescriptor('questions'),
      sourceDescriptor('checkpoint'),
      sourceDescriptor('instructions'),
    ],
    targets: [targetFor()],
    ...overrides,
  };
}

function anchorFor(overrides = {}) {
  return {
    schemaVersion: 1,
    revision: 5,
    storeId: UUID_A,
    retiredQuestionPeriods: [retiredPeriodFor()],
    migration: null,
    ...overrides,
  };
}

function assertInvalid(callback) {
  assert.throws(callback, (error) => error instanceof TypeError &&
    error.message === 'invalid_question_reclamation_anchor_v1');
}

function reverseProperties(value) {
  if (Array.isArray(value)) return value.map(reverseProperties);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).reverse().map(([key, child]) => [key, reverseProperties(child)]));
  }
  return value;
}

test('normalizes an empty anchor and preserves retired period order', () => {
  const periods = [retiredPeriodFor('claude', 'one'), retiredPeriodFor('codex', 'two')];
  const normalized = normalizeQuestionReclamationAnchorV1Local(anchorFor({ retiredQuestionPeriods: periods }));

  assert.equal(Object.getPrototypeOf(normalized), null);
  assert.deepEqual(Object.keys(normalized), [
    'schemaVersion', 'revision', 'storeId', 'retiredQuestionPeriods', 'migration',
  ]);
  assert.deepEqual(normalized.retiredQuestionPeriods.map(({ identity }) => identity.provider), ['claude', 'codex']);
  assert.equal(normalized.migration, null);
});

test('rejects repeated retired periods only when the complete identity and period match', () => {
  const original = retiredPeriodFor('claude', 'same');
  assertInvalid(() => normalizeQuestionReclamationAnchorV1Local(anchorFor({
    retiredQuestionPeriods: [original, structuredClone(original)],
  })));

  for (const [field, changed] of [
    ['providerKind', ['codex', 'thread']],
    ['hostId', 'other-host'],
    ['homeScopeId', 'other-home'],
    ['nativeId', 'other-native'],
  ]) {
    const differentIdentity = structuredClone(original);
    if (field === 'providerKind') {
      [differentIdentity.identity.provider, differentIdentity.identity.nativeIdKind] = changed;
    } else {
      differentIdentity.identity[field] = changed;
    }
    assert.doesNotThrow(() => normalizeQuestionReclamationAnchorV1Local(anchorFor({
      retiredQuestionPeriods: [original, differentIdentity],
    })));
  }

  const differentPeriod = structuredClone(original);
  differentPeriod.periodId = 'period-other';
  assert.doesNotThrow(() => normalizeQuestionReclamationAnchorV1Local(anchorFor({
    retiredQuestionPeriods: [original, differentPeriod],
  })));
});

test('checks exact anchor, retired period, and identity schemas', () => {
  for (const invalid of [
    anchorFor({ schemaVersion: 2 }),
    anchorFor({ revision: -1 }),
    anchorFor({ revision: Number.MAX_SAFE_INTEGER + 1 }),
    anchorFor({ storeId: '11111111-1111-4111-7111-111111111111' }),
    { ...anchorFor(), unknown: true },
    { schemaVersion: 1, revision: 0, storeId: UUID_A, retiredQuestionPeriods: [] },
    anchorFor({ retiredQuestionPeriods: [retiredPeriodFor('node', 'invalid')] }),
    anchorFor({ retiredQuestionPeriods: [retiredPeriodFor('claude', 'invalid', { reason: 'retired' })] }),
    anchorFor({ retiredQuestionPeriods: [retiredPeriodFor('claude', 'invalid', { retiredAt: -1 })] }),
    anchorFor({ retiredQuestionPeriods: [retiredPeriodFor('claude', 'invalid', { extra: true })] }),
  ]) {
    assertInvalid(() => normalizeQuestionReclamationAnchorV1Local(invalid));
  }
});

test('accepts all migration phases and canonicalizes source slot order', () => {
  for (const phase of ['prepared', 'guarded', 'installing', 'completed']) {
    const migration = migrationFor({
      phase,
      sources: [
        sourceDescriptor('questions'),
        sourceDescriptor('instructions'),
        sourceDescriptor('checkpoint'),
      ],
    });
    const normalized = normalizeQuestionReclamationAnchorV1Local(anchorFor({ migration }));
    assert.deepEqual(normalized.migration.sources.map(({ slot }) => slot), [
      'checkpoint', 'instructions', 'questions',
    ]);
  }
});

test('accepts each source slot and the exact absent-source representation', () => {
  for (const slot of ['questions', 'checkpoint', 'instructions']) {
    for (const descriptor of [sourceDescriptor(slot), sourceDescriptor(slot, { sourcePresent: false })]) {
      const normalized = normalizeQuestionReclamationAnchorV1Local(anchorFor({
        migration: migrationFor({ sources: [descriptor] }),
      }));
      assert.equal(normalized.migration.sources[0].slot, slot);
      assert.equal(normalized.migration.sources[0].sourcePresent, descriptor.sourcePresent);
    }
  }
});

test('rejects migration source slot, version, fingerprint, and absent-source inconsistencies', () => {
  const cases = [
    migrationFor({ phase: 'unknown' }),
    migrationFor({ operationId: 'not-a-uuid' }),
    migrationFor({ startedAt: -1 }),
    migrationFor({ sources: [{ ...sourceDescriptor('questions'), slot: 'unknown' }] }),
    migrationFor({ sources: [sourceDescriptor('questions'), sourceDescriptor('questions')] }),
    migrationFor({ sources: [sourceDescriptor('questions', { schemaVersion: 2 })] }),
    migrationFor({ sources: [sourceDescriptor('questions', { targetRevision: 3 })] }),
    migrationFor({ sources: [sourceDescriptor('questions', {
      revision: Number.MAX_SAFE_INTEGER,
      targetRevision: Number.MAX_SAFE_INTEGER,
    })] }),
    migrationFor({ sources: [sourceDescriptor('questions', { sourcePresent: false, targetRevision: 1 })] }),
    migrationFor({ sources: [sourceDescriptor('checkpoint', { targetSchemaVersion: 2 })] }),
    migrationFor({ sources: [sourceDescriptor('instructions', { sizeBytes: MAX_SOURCE_BYTES + 1 })] }),
    migrationFor({ sources: [sourceDescriptor('questions', { sha256: 'A'.repeat(64) })] }),
    migrationFor({ sources: [sourceDescriptor('questions', { targetSizeBytes: -1 })] }),
    migrationFor({ sources: [sourceDescriptor('questions', { targetSha256: null })] }),
    migrationFor({ sources: [sourceDescriptor('questions', { sourcePresent: false, revision: 0 })] }),
    migrationFor({ sources: [sourceDescriptor('questions', { sourcePresent: false, sha256: SHA_A })] }),
    migrationFor({ sources: [sourceDescriptor('questions', { extra: true })] }),
  ];
  for (const migration of cases) {
    assertInvalid(() => normalizeQuestionReclamationAnchorV1Local(anchorFor({ migration })));
  }
});

test('accepts locally consistent target presence and checkpoint snapshots', () => {
  const intent = deliveryIntentFor();
  const cases = [
    targetFor(),
    targetFor({ deliveryIntent: intent }),
    ...[
      'available', 'claimed', 'sending', 'accepted', 'applied', 'unknown',
      'cancelled_before_send', 'superseded_before_send',
    ].map((checkpointState) => targetFor({
      deliveryPresence: 'checkpoint',
      deliveryIntent: intent,
      checkpointState,
    })),
    targetFor({
      deliveryPresence: 'indeterminate',
      deliveryIntent: intent,
      checkpointState: 'unknown',
    }),
  ];

  for (const target of cases) {
    assert.doesNotThrow(() => normalizeQuestionReclamationAnchorV1Local(anchorFor({
      migration: migrationFor({ targets: [target] }),
    })));
  }
});

test('rejects target presence, intent, checkpoint, digest, and period index mismatches', () => {
  const intent = deliveryIntentFor();
  const invalidTargets = [
    targetFor({ deliveryPresence: 'unknown' }),
    targetFor({ deliveryPresence: 'none', checkpointState: 'available' }),
    targetFor({ deliveryPresence: 'checkpoint', checkpointState: 'available' }),
    targetFor({ deliveryPresence: 'checkpoint', deliveryIntent: intent, checkpointState: null }),
    targetFor({ deliveryPresence: 'checkpoint', deliveryIntent: intent, checkpointState: 'not-a-state' }),
    targetFor({ deliveryPresence: 'indeterminate', deliveryIntent: null, checkpointState: 'unknown' }),
    targetFor({ deliveryPresence: 'indeterminate', deliveryIntent: intent, checkpointState: 'available' }),
    targetFor({ deliveryIntent: { ...intent, revision: -1 } }),
    targetFor({ deliveryIntent: { ...intent, payloadDigest: 'g'.repeat(64) } }),
    targetFor({ commonKeyDigest: 'A'.repeat(64) }),
    targetFor({ recordDigest: null }),
    targetFor({ periodIndex: 1 }),
    targetFor({ extra: true }),
  ];
  for (const target of invalidTargets) {
    assertInvalid(() => normalizeQuestionReclamationAnchorV1Local(anchorFor({
      migration: migrationFor({ targets: [target] }),
    })));
  }

  assertInvalid(() => normalizeQuestionReclamationAnchorV1Local(anchorFor({
    retiredQuestionPeriods: [],
    migration: migrationFor({ targets: [targetFor()] }),
  })));
});

test('rejects duplicate migration target question IDs and common-key digests', () => {
  assertInvalid(() => normalizeQuestionReclamationAnchorV1Local(anchorFor({
    migration: migrationFor({ targets: [targetFor(), targetFor({ internalQuestionId: 'another-question' })] }),
  })));
  assertInvalid(() => normalizeQuestionReclamationAnchorV1Local(anchorFor({
    migration: migrationFor({ targets: [targetFor(), targetFor({ commonKeyDigest: SHA_B })] }),
  })));
});

test('enforces period and target limits while accepting their maximum legal counts', () => {
  const periods = Array.from({ length: 20_000 }, (_, index) => retiredPeriodFor('codex', `period-${index}`));
  assert.equal(normalizeQuestionReclamationAnchorV1Local(anchorFor({ retiredQuestionPeriods: periods }))
    .retiredQuestionPeriods.length, 20_000);
  assertInvalid(() => normalizeQuestionReclamationAnchorV1Local(anchorFor({
    retiredQuestionPeriods: [...periods, retiredPeriodFor('codex', 'period-over-limit')],
  })));

  const targets = Array.from({ length: 20_000 }, (_, index) => targetFor({
    internalQuestionId: `question-${index}`,
    commonKeyDigest: index.toString(16).padStart(64, '0'),
  }));
  assert.equal(normalizeQuestionReclamationAnchorV1Local(anchorFor({
    migration: migrationFor({ targets }),
  })).migration.targets.length, 20_000);
  assertInvalid(() => normalizeQuestionReclamationAnchorV1Local(anchorFor({
    migration: migrationFor({ targets: [...targets, targetFor({
      internalQuestionId: 'question-over-limit', commonKeyDigest: 'f'.repeat(64),
    })] }),
  })));
});

test('accepts maximum legal identifiers, safe integers, and source byte metadata', () => {
  const long = 'x'.repeat(512);
  const period = retiredPeriodFor('claude', long, {
    identity: {
      provider: 'claude', nativeIdKind: 'session',
      hostId: long, homeScopeId: long, nativeId: long,
    },
    periodId: long,
    retiredAt: Number.MAX_SAFE_INTEGER,
  });
  const target = targetFor({
    internalQuestionId: long,
    commonKeyDigest: SHA_A,
    deliveryPresence: 'indeterminate',
    deliveryIntent: {
      deliveryAttemptId: long,
      logicalMessageId: long,
      revision: Number.MAX_SAFE_INTEGER,
      payloadDigest: SHA_B,
    },
    checkpointState: 'unknown',
  });
  const migration = migrationFor({
    startedAt: Number.MAX_SAFE_INTEGER,
    sources: [sourceDescriptor('questions', {
      revision: Number.MAX_SAFE_INTEGER - 1,
      sizeBytes: MAX_SOURCE_BYTES,
      targetRevision: Number.MAX_SAFE_INTEGER,
      targetSizeBytes: Number.MAX_SAFE_INTEGER,
    })],
    targets: [target],
  });
  assert.doesNotThrow(() => normalizeQuestionReclamationAnchorV1Local(anchorFor({
    revision: Number.MAX_SAFE_INTEGER,
    retiredQuestionPeriods: [period],
    migration,
  })));
});

test('rejects getters, coercion objects, sparse arrays, and custom prototypes without invoking code', () => {
  let getterCalls = 0;
  const withGetter = anchorFor();
  Object.defineProperty(withGetter, 'storeId', {
    enumerable: true,
    get() { getterCalls += 1; return UUID_A; },
  });
  assertInvalid(() => normalizeQuestionReclamationAnchorV1Local(withGetter));
  assert.equal(getterCalls, 0);

  let coercionCalls = 0;
  const coercion = {
    toString() { coercionCalls += 1; throw new Error('must not coerce'); },
    [Symbol.toPrimitive]() { coercionCalls += 1; throw new Error('must not coerce'); },
  };
  assertInvalid(() => normalizeQuestionReclamationAnchorV1Local(anchorFor({
    retiredQuestionPeriods: [retiredPeriodFor('codex', 'coercion', { periodId: coercion })],
  })));
  assert.equal(coercionCalls, 0);

  const sparsePeriods = new Array(1);
  assertInvalid(() => normalizeQuestionReclamationAnchorV1Local(anchorFor({ retiredQuestionPeriods: sparsePeriods })));
  const foreignPrototype = Object.assign(Object.create({ inherited: true }), anchorFor());
  assertInvalid(() => normalizeQuestionReclamationAnchorV1Local(foreignPrototype));
});

test('normalizes and encodes safely when Object and Array inherit toJSON accessors', () => {
  const anchor = anchorFor({
    retiredQuestionPeriods: [retiredPeriodFor('claude', 'to-json')],
    migration: migrationFor({
      sources: [sourceDescriptor('questions', { sourcePresent: false })],
      targets: [targetFor({
        deliveryPresence: 'indeterminate',
        deliveryIntent: deliveryIntentFor('to-json'),
        checkpointState: 'unknown',
      })],
    }),
  });
  const baseline = encodeQuestionReclamationAnchorV1Local(anchor);
  let calls = 0;
  const objectDescriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  const arrayDescriptor = Object.getOwnPropertyDescriptor(Array.prototype, 'toJSON');
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      get() { calls += 1; throw new Error('inherited object toJSON invoked'); },
    });
    Object.defineProperty(Array.prototype, 'toJSON', {
      configurable: true,
      get() { calls += 1; throw new Error('inherited array toJSON invoked'); },
    });
    assert.doesNotThrow(() => normalizeQuestionReclamationAnchorV1Local(anchor));
    const encoded = encodeQuestionReclamationAnchorV1Local(anchor);
    assert.deepEqual(encoded.bytes, baseline.bytes);
    assert.equal(encoded.sizeBytes, baseline.sizeBytes);
    assert.equal(encoded.sha256, baseline.sha256);
    assert.equal(calls, 0);
  } finally {
    if (objectDescriptor) Object.defineProperty(Object.prototype, 'toJSON', objectDescriptor);
    else delete Object.prototype.toJSON;
    if (arrayDescriptor) Object.defineProperty(Array.prototype, 'toJSON', arrayDescriptor);
    else delete Array.prototype.toJSON;
  }
});

test('encodes canonical fields and sorted sources without mutating caller input', () => {
  const expected = anchorFor({
    retiredQuestionPeriods: [retiredPeriodFor('codex', 'canonical')],
    migration: migrationFor({
      sources: [
        sourceDescriptor('checkpoint'),
        sourceDescriptor('instructions'),
        sourceDescriptor('questions'),
      ],
      targets: [targetFor()],
    }),
  });
  const input = reverseProperties(structuredClone(expected));
  input.migration.sources.reverse();
  const before = structuredClone(input);
  const encoded = encodeQuestionReclamationAnchorV1Local(input);
  const expectedBytes = Buffer.from(`${JSON.stringify(expected, null, 2)}\n`, 'utf8');

  assert.deepEqual(input, before);
  assert.deepEqual(encoded.bytes, expectedBytes);
  assert.equal(encoded.sizeBytes, expectedBytes.length);
  assert.equal(encoded.sha256, sha256(expectedBytes));
  assert.deepEqual(JSON.parse(encoded.bytes.toString('utf8')), expected);
});
