'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const {
  encodeStopEnsureRecord,
  decodeStopEnsureRecord,
  normalizeStopEnsureExpectedIds,
  MAX_STOP_ENSURE_RECORD_BYTES,
} =
  require('../src/server/stop-ensure-record-codec');

const INSTANCE_ID = 'a5f9b3c1-6d72-4f80-9b31-2c6d8e4f7012';
const OTHER_INSTANCE_ID = 'b6a0c4d2-7e83-4a91-8c42-3d7e9f5a8123';
const REQUEST_ID = 'c7b1d5e3-8f94-4ba2-9d53-4e8f0a6b9234';
const ATTEMPT_ID = 'd8c2e6f4-9a05-4cb3-8e64-5f901b7ca345';
const OTHER_ATTEMPT_ID = 'e9d3f705-ab16-4dc4-9f75-60a12c8db456';
const SCOPE_ID = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const OTHER_SCOPE_ID = '1123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const EXPECTED_SHUTDOWN = { kind: 'shutdown', instanceId: INSTANCE_ID, requestId: REQUEST_ID };
const EXPECTED_STARTUP = { kind: 'startup', scopeId: SCOPE_ID, attemptId: ATTEMPT_ID };

function nullPrototypeRecord(entries) {
  const record = Object.create(null);
  for (const [key, value] of entries) {
    Object.defineProperty(record, key, {
      value,
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(record);
}

function shutdownRecord(status, reasonCode) {
  return {
    version: 1,
    kind: 'shutdown',
    instanceId: INSTANCE_ID,
    requestId: REQUEST_ID,
    status,
    reasonCode,
  };
}

function startupRecord(status, reasonCode) {
  return {
    version: 1,
    kind: 'startup',
    scopeId: SCOPE_ID,
    attemptId: ATTEMPT_ID,
    instanceId: status === 'started' ? INSTANCE_ID : null,
    status,
    reasonCode,
  };
}

const VALID_RECORDS = [
  {
    record: shutdownRecord('completed', null),
    ids: EXPECTED_SHUTDOWN,
    json: `{"version":1,"kind":"shutdown","instanceId":"${INSTANCE_ID}","requestId":"${REQUEST_ID}","status":"completed","reasonCode":null}`,
  },
  {
    record: shutdownRecord('failed', 'shutdown_incomplete'),
    ids: EXPECTED_SHUTDOWN,
    json: `{"version":1,"kind":"shutdown","instanceId":"${INSTANCE_ID}","requestId":"${REQUEST_ID}","status":"failed","reasonCode":"shutdown_incomplete"}`,
  },
  {
    record: startupRecord('started', null),
    ids: EXPECTED_STARTUP,
    json: `{"version":1,"kind":"startup","scopeId":"${SCOPE_ID}","attemptId":"${ATTEMPT_ID}","instanceId":"${INSTANCE_ID}","status":"started","reasonCode":null}`,
  },
  ...['writer_occupied', 'filesystem_unsupported', 'startup_failed', 'startup_unconfirmed'].map((reasonCode) => ({
    record: startupRecord('blocked', reasonCode),
    ids: EXPECTED_STARTUP,
    json: `{"version":1,"kind":"startup","scopeId":"${SCOPE_ID}","attemptId":"${ATTEMPT_ID}","instanceId":null,"status":"blocked","reasonCode":"${reasonCode}"}`,
  })),
];

function assertInvalid(action) {
  assert.throws(action, (error) => error instanceof TypeError &&
    error.message === 'invalid_stop_ensure_record' && error.cause === undefined);
}

function encodeJson(json) {
  return Buffer.from(json, 'utf8');
}

test('only the fixed codec API and byte limit are exported', () => {
  assert.deepEqual(Object.keys(require('../src/server/stop-ensure-record-codec')).sort(), [
    'MAX_STOP_ENSURE_RECORD_BYTES', 'decodeStopEnsureRecord', 'encodeStopEnsureRecord',
    'normalizeStopEnsureExpectedIds',
  ]);
  assert.equal(MAX_STOP_ENSURE_RECORD_BYTES, 4096);
});

test('expected ID normalization returns independent frozen null-prototype records', () => {
  for (const original of [EXPECTED_SHUTDOWN, EXPECTED_STARTUP]) {
    const input = { ...original };
    const normalized = normalizeStopEnsureExpectedIds(input);
    input[Object.keys(input)[1]] = 'changed';
    assert.equal(Object.getPrototypeOf(normalized), null);
    assert.equal(Object.isFrozen(normalized), true);
    assert.deepEqual(normalized, nullPrototypeRecord(Object.entries(original)));
    assert.throws(() => { normalized.kind = 'changed'; }, TypeError);
  }
});

test('expected ID normalization rejects malformed schemas without invoking accessors or proxy traps', () => {
  for (const invalid of [
    undefined,
    null,
    [],
    { ...EXPECTED_SHUTDOWN, extra: true },
    { ...EXPECTED_SHUTDOWN, instanceId: INSTANCE_ID.toUpperCase() },
    { ...EXPECTED_STARTUP, scopeId: SCOPE_ID.replace('a', '/') },
    Object.assign(Object.create({}), EXPECTED_SHUTDOWN),
  ]) {
    assertInvalid(() => normalizeStopEnsureExpectedIds(invalid));
  }

  let getterCalls = 0;
  const accessor = { ...EXPECTED_SHUTDOWN };
  Object.defineProperty(accessor, 'instanceId', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('getter must not run'); },
  });
  assertInvalid(() => normalizeStopEnsureExpectedIds(accessor));
  let trapCalls = 0;
  const proxy = new Proxy(EXPECTED_STARTUP, {
    getPrototypeOf() { trapCalls += 1; throw new Error('trap'); },
    ownKeys() { trapCalls += 1; throw new Error('trap'); },
  });
  assertInvalid(() => normalizeStopEnsureExpectedIds(proxy));
  assert.equal(getterCalls, 0);
  assert.equal(trapCalls, 0);
});

test('all seven schema-valid status and reason combinations roundtrip to canonical UTF-8 JSON', () => {
  for (const fixture of VALID_RECORDS) {
    const encoded = encodeStopEnsureRecord(fixture.record);
    assert.ok(Buffer.isBuffer(encoded));
    assert.equal(encoded.toString('utf8'), fixture.json);
    assert.deepEqual(
      decodeStopEnsureRecord(encoded, fixture.ids),
      nullPrototypeRecord(Object.entries(fixture.record)),
    );
  }
});

test('JSON object field order does not affect normalized decoded records', () => {
  const json = ` { "status":"completed", "reasonCode":null, "requestId":"${REQUEST_ID}", "instanceId":"${INSTANCE_ID}", "kind":"shutdown", "version":1 } `;
  assert.deepEqual(
    decodeStopEnsureRecord(encodeJson(json), EXPECTED_SHUTDOWN),
    nullPrototypeRecord([
      ['version', 1], ['kind', 'shutdown'], ['instanceId', INSTANCE_ID],
      ['requestId', REQUEST_ID], ['status', 'completed'], ['reasonCode', null],
    ]),
  );
});

test('plain records with null prototypes are accepted and normalized', () => {
  const record = Object.assign(Object.create(null), shutdownRecord('completed', null));
  const expectedIds = Object.assign(Object.create(null), EXPECTED_SHUTDOWN);
  assert.deepEqual(
    decodeStopEnsureRecord(encodeStopEnsureRecord(record), expectedIds),
    nullPrototypeRecord(Object.entries(shutdownRecord('completed', null))),
  );
});

test('encode copies primitive fields and never calls inherited toJSON', () => {
  const record = shutdownRecord('completed', null);
  const original = VALID_RECORDS[0].json;
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value() { throw new Error('toJSON must not run'); },
    });
    const encoded = encodeStopEnsureRecord(record);
    record.instanceId = OTHER_INSTANCE_ID;
    assert.equal(encoded.toString('utf8'), original);
  } finally {
    if (descriptor) Object.defineProperty(Object.prototype, 'toJSON', descriptor);
    else delete Object.prototype.toJSON;
  }
});

test('decode returns an independent frozen null-prototype record', () => {
  const bytes = encodeJson(VALID_RECORDS[0].json);
  const decoded = decodeStopEnsureRecord(bytes, EXPECTED_SHUTDOWN);
  bytes.fill(0x20);
  assert.equal(Object.getPrototypeOf(decoded), null);
  assert.equal(Object.isFrozen(decoded), true);
  assert.equal(decoded.instanceId, INSTANCE_ID);
  assert.throws(() => { decoded.instanceId = OTHER_INSTANCE_ID; }, TypeError);
});

test('encode rejects invalid record identity and schema without coercion', () => {
  const invalidIds = [
    { ...shutdownRecord('completed', null), instanceId: INSTANCE_ID.toUpperCase() },
    { ...shutdownRecord('completed', null), instanceId: `${INSTANCE_ID}x` },
    { ...shutdownRecord('completed', null), requestId: 'a5f9b3c1-6d72-1f80-9b31-2c6d8e4f7012' },
    { ...shutdownRecord('completed', null), requestId: 'a5f9b3c1-6d72-4f80-7b31-2c6d8e4f7012' },
    { ...shutdownRecord('completed', null), instanceId: new String(INSTANCE_ID) },
    { ...startupRecord('started', null), scopeId: SCOPE_ID.toUpperCase() },
    { ...startupRecord('started', null), scopeId: `g${SCOPE_ID.slice(1)}` },
  ];
  for (const record of invalidIds) assertInvalid(() => encodeStopEnsureRecord(record));

  const invalidCombinations = [
    { ...shutdownRecord('completed', null), version: 2 },
    { ...shutdownRecord('completed', null), status: 'failed' },
    { ...shutdownRecord('failed', 'shutdown_incomplete'), reasonCode: null },
    { ...startupRecord('started', null), instanceId: null },
    { ...startupRecord('started', null), reasonCode: 'startup_failed' },
    { ...startupRecord('blocked', 'writer_occupied'), instanceId: INSTANCE_ID },
    { ...startupRecord('blocked', 'writer_occupied'), reasonCode: 'other' },
    { ...startupRecord('blocked', 'writer_occupied'), status: 'failed' },
  ];
  for (const record of invalidCombinations) assertInvalid(() => encodeStopEnsureRecord(record));
});

test('record UUID and scope IDs reject trailing newlines, wrong lengths, and path separators', () => {
  const invalidUuids = [
    `${INSTANCE_ID}\n`,
    INSTANCE_ID.slice(1),
    INSTANCE_ID.replace('-', '/'),
  ];
  for (const value of invalidUuids) {
    assertInvalid(() => encodeStopEnsureRecord({ ...shutdownRecord('completed', null), instanceId: value }));
    assertInvalid(() => encodeStopEnsureRecord({ ...shutdownRecord('completed', null), requestId: value }));
    assertInvalid(() => encodeStopEnsureRecord({ ...startupRecord('started', null), attemptId: value }));
    assertInvalid(() => encodeStopEnsureRecord({ ...startupRecord('started', null), instanceId: value }));
  }

  const invalidScopes = [`${SCOPE_ID}\n`, SCOPE_ID.slice(1), SCOPE_ID.replace('a', '/')];
  for (const value of invalidScopes) {
    assertInvalid(() => encodeStopEnsureRecord({ ...startupRecord('started', null), scopeId: value }));
  }
});

test('encode rejects nonplain records, extra keys, symbols, nonenumerable fields, and accessors', () => {
  const record = shutdownRecord('completed', null);
  assertInvalid(() => encodeStopEnsureRecord(null));
  assertInvalid(() => encodeStopEnsureRecord([]));
  assertInvalid(() => encodeStopEnsureRecord(new Date()));
  assertInvalid(() => encodeStopEnsureRecord(Object.assign(Object.create({}), record)));
  assertInvalid(() => encodeStopEnsureRecord({ ...record, extra: true }));

  const symbolRecord = { ...record };
  symbolRecord[Symbol('extra')] = true;
  assertInvalid(() => encodeStopEnsureRecord(symbolRecord));

  const hiddenRecord = { ...record };
  Object.defineProperty(hiddenRecord, 'extra', { value: true });
  assertInvalid(() => encodeStopEnsureRecord(hiddenRecord));
  const hiddenKnownFieldRecord = { ...record };
  Object.defineProperty(hiddenKnownFieldRecord, 'status', {
    enumerable: false,
    value: 'completed',
  });
  assertInvalid(() => encodeStopEnsureRecord(hiddenKnownFieldRecord));

  let getterCalls = 0;
  const accessorRecord = { ...record };
  Object.defineProperty(accessorRecord, 'instanceId', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('getter must not run'); },
  });
  assertInvalid(() => encodeStopEnsureRecord(accessorRecord));
  assert.equal(getterCalls, 0);
});

test('record and expected ID proxies are rejected without invoking traps', () => {
  let trapCalls = 0;
  const proxy = new Proxy(shutdownRecord('completed', null), {
    getPrototypeOf() { trapCalls += 1; throw new Error('trap'); },
    ownKeys() { trapCalls += 1; throw new Error('trap'); },
    getOwnPropertyDescriptor() { trapCalls += 1; throw new Error('trap'); },
  });
  assertInvalid(() => encodeStopEnsureRecord(proxy));
  assertInvalid(() => decodeStopEnsureRecord(encodeJson(VALID_RECORDS[0].json), proxy));
  assert.equal(trapCalls, 0);
});

test('decode requires a strict expected ID record and exact current identifiers', () => {
  const bytes = encodeJson(VALID_RECORDS[0].json);
  const invalidExpected = [
    undefined,
    null,
    [],
    { kind: 'shutdown', instanceId: INSTANCE_ID },
    { kind: 'shutdown', instanceId: INSTANCE_ID, requestId: REQUEST_ID, extra: true },
    { kind: 'startup', scopeId: SCOPE_ID, attemptId: ATTEMPT_ID },
    { kind: 'shutdown', instanceId: INSTANCE_ID.toUpperCase(), requestId: REQUEST_ID },
    { kind: 'startup', scopeId: SCOPE_ID.toUpperCase(), attemptId: ATTEMPT_ID },
  ];
  for (const expected of invalidExpected) assertInvalid(() => decodeStopEnsureRecord(bytes, expected));

  const accessorExpected = { ...EXPECTED_SHUTDOWN };
  Object.defineProperty(accessorExpected, 'instanceId', {
    enumerable: true,
    get() { throw new Error('getter must not run'); },
  });
  assertInvalid(() => decodeStopEnsureRecord(bytes, accessorExpected));
  const hiddenExpected = { ...EXPECTED_SHUTDOWN };
  Object.defineProperty(hiddenExpected, 'extra', { value: true });
  assertInvalid(() => decodeStopEnsureRecord(bytes, hiddenExpected));
  const hiddenKnownExpected = { ...EXPECTED_SHUTDOWN };
  Object.defineProperty(hiddenKnownExpected, 'requestId', {
    enumerable: false,
    value: REQUEST_ID,
  });
  assertInvalid(() => decodeStopEnsureRecord(bytes, hiddenKnownExpected));
  assertInvalid(() => decodeStopEnsureRecord(bytes, Object.assign(Object.create({}), EXPECTED_SHUTDOWN)));
  assertInvalid(() => decodeStopEnsureRecord(bytes, { ...EXPECTED_SHUTDOWN, instanceId: OTHER_INSTANCE_ID }));
  assertInvalid(() => decodeStopEnsureRecord(bytes, EXPECTED_STARTUP));
});

test('expected UUID and scope IDs reject trailing newlines, wrong lengths, and path separators', () => {
  const invalidUuids = [
    `${INSTANCE_ID}\n`,
    INSTANCE_ID.slice(1),
    INSTANCE_ID.replace('-', '/'),
  ];
  for (const value of invalidUuids) {
    assertInvalid(() => decodeStopEnsureRecord(encodeJson(VALID_RECORDS[0].json), {
      kind: 'shutdown', instanceId: value, requestId: REQUEST_ID,
    }));
    assertInvalid(() => decodeStopEnsureRecord(encodeJson(VALID_RECORDS[0].json), {
      kind: 'shutdown', instanceId: INSTANCE_ID, requestId: value,
    }));
    assertInvalid(() => decodeStopEnsureRecord(encodeJson(VALID_RECORDS[2].json), {
      kind: 'startup', scopeId: SCOPE_ID, attemptId: value,
    }));
  }

  const invalidScopes = [`${SCOPE_ID}\n`, SCOPE_ID.slice(1), SCOPE_ID.replace('a', '/')];
  for (const value of invalidScopes) {
    assertInvalid(() => decodeStopEnsureRecord(encodeJson(VALID_RECORDS[2].json), {
      kind: 'startup', scopeId: value, attemptId: ATTEMPT_ID,
    }));
  }
});

test('decode requires matching shutdown request ID and startup scope and attempt IDs', () => {
  assertInvalid(() => decodeStopEnsureRecord(encodeJson(VALID_RECORDS[0].json), {
    kind: 'shutdown', instanceId: INSTANCE_ID, requestId: 'e9d3f705-ab16-4dc4-9f75-60a12c8db456',
  }));
  assertInvalid(() => decodeStopEnsureRecord(encodeJson(VALID_RECORDS[2].json), {
    kind: 'startup', scopeId: OTHER_SCOPE_ID, attemptId: ATTEMPT_ID,
  }));
  assertInvalid(() => decodeStopEnsureRecord(encodeJson(VALID_RECORDS[2].json), {
    kind: 'startup', scopeId: SCOPE_ID, attemptId: OTHER_ATTEMPT_ID,
  }));
});

test('decode enforces the UTF-8 byte limit before accepting JSON', () => {
  const valid = encodeJson(VALID_RECORDS[0].json);
  const atLimit = Buffer.concat([valid, Buffer.alloc(MAX_STOP_ENSURE_RECORD_BYTES - valid.byteLength, 0x20)]);
  const overLimitValidJson = Buffer.concat([
    valid,
    Buffer.alloc(MAX_STOP_ENSURE_RECORD_BYTES + 1 - valid.byteLength, 0x20),
  ]);
  assert.equal(atLimit.byteLength, MAX_STOP_ENSURE_RECORD_BYTES);
  assert.equal(overLimitValidJson.byteLength, MAX_STOP_ENSURE_RECORD_BYTES + 1);
  assert.equal(decodeStopEnsureRecord(atLimit, EXPECTED_SHUTDOWN).status, 'completed');
  assertInvalid(() => decodeStopEnsureRecord(overLimitValidJson, EXPECTED_SHUTDOWN));
  assertInvalid(() => decodeStopEnsureRecord(Buffer.from(' '), EXPECTED_SHUTDOWN));
});

test('decode uses intrinsic Buffer size and rejects proxies before reading byte-length properties', () => {
  const valid = encodeJson(VALID_RECORDS[0].json);
  const overLimitValidJson = Buffer.concat([
    valid,
    Buffer.alloc(MAX_STOP_ENSURE_RECORD_BYTES + 1 - valid.byteLength, 0x20),
  ]);
  Object.defineProperty(overLimitValidJson, 'byteLength', { configurable: true, value: MAX_STOP_ENSURE_RECORD_BYTES });
  Object.defineProperty(overLimitValidJson, 'length', { configurable: true, value: MAX_STOP_ENSURE_RECORD_BYTES });
  assert.equal(overLimitValidJson.byteLength, MAX_STOP_ENSURE_RECORD_BYTES);
  assert.equal(overLimitValidJson.length, MAX_STOP_ENSURE_RECORD_BYTES);
  assertInvalid(() => decodeStopEnsureRecord(overLimitValidJson, EXPECTED_SHUTDOWN));

  class BufferSubclass extends Buffer {}
  const subclassed = Buffer.concat([
    valid,
    Buffer.alloc(MAX_STOP_ENSURE_RECORD_BYTES + 1 - valid.byteLength, 0x20),
  ]);
  Object.setPrototypeOf(subclassed, BufferSubclass.prototype);
  assert.equal(Buffer.isBuffer(subclassed), true);
  assert.equal(subclassed.byteLength, MAX_STOP_ENSURE_RECORD_BYTES + 1);
  assertInvalid(() => decodeStopEnsureRecord(subclassed, EXPECTED_SHUTDOWN));

  let byteLengthGetterCalls = 0;
  const getterBuffer = Buffer.from(VALID_RECORDS[0].json);
  Object.defineProperty(getterBuffer, 'byteLength', {
    configurable: true,
    get() { byteLengthGetterCalls += 1; throw new Error('byteLength getter must not run'); },
  });
  assert.equal(decodeStopEnsureRecord(getterBuffer, EXPECTED_SHUTDOWN).status, 'completed');
  assert.equal(byteLengthGetterCalls, 0);

  let trapCalls = 0;
  const proxied = new Proxy(Buffer.from(VALID_RECORDS[0].json), {
    get() { trapCalls += 1; throw new Error('buffer proxy trap must not run'); },
  });
  assertInvalid(() => decodeStopEnsureRecord(proxied, EXPECTED_SHUTDOWN));
  assert.equal(trapCalls, 0);
});

test('decode rejects invalid UTF-8, BOM, malformed JSON, and non-Buffer input', () => {
  for (const input of [
    Buffer.from([0xc3, 0x28]),
    Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), encodeJson(VALID_RECORDS[0].json)]),
    Buffer.from('{'),
    Buffer.from(''),
    new Uint8Array(encodeJson(VALID_RECORDS[0].json)),
    VALID_RECORDS[0].json,
  ]) {
    assertInvalid(() => decodeStopEnsureRecord(input, EXPECTED_SHUTDOWN));
  }
  assertInvalid(() => decodeStopEnsureRecord(encodeJson(`${VALID_RECORDS[0].json.slice(0, -1)},"extra":true}`), EXPECTED_SHUTDOWN));

  const invalidRecords = [
    { ...shutdownRecord('completed', null), version: 2 },
    { ...shutdownRecord('completed', null), status: 'failed' },
    { ...startupRecord('blocked', 'writer_occupied'), reasonCode: 'other' },
  ];
  for (const record of invalidRecords) {
    assertInvalid(() => decodeStopEnsureRecord(encodeJson(JSON.stringify(record)),
      record.kind === 'shutdown' ? EXPECTED_SHUTDOWN : EXPECTED_STARTUP));
  }
});

test('decode does not invoke inherited toJSON while constructing normalized records', () => {
  const descriptor = Object.getOwnPropertyDescriptor(Object.prototype, 'toJSON');
  try {
    Object.defineProperty(Object.prototype, 'toJSON', {
      configurable: true,
      value() { throw new Error('toJSON must not run'); },
    });
    assert.equal(decodeStopEnsureRecord(encodeJson(VALID_RECORDS[0].json), EXPECTED_SHUTDOWN).status, 'completed');
  } finally {
    if (descriptor) Object.defineProperty(Object.prototype, 'toJSON', descriptor);
    else delete Object.prototype.toJSON;
  }
});
