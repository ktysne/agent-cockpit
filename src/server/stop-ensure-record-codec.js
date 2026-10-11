'use strict';

const { TextDecoder, types } = require('node:util');
const {
  assertSha256,
  assertUuidV4,
  captureExactRecord,
} = require('./reclamation-codec-primitives');

const MAX_STOP_ENSURE_RECORD_BYTES = 4096;
const INVALID_RECORD = 'invalid_stop_ensure_record';
const TYPED_ARRAY_BYTE_LENGTH_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteLength',
).get;
const TYPED_ARRAY_BUFFER_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'buffer',
).get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER = Object.getOwnPropertyDescriptor(
  Object.getPrototypeOf(Uint8Array.prototype),
  'byteOffset',
).get;
const SHUTDOWN_FIELDS = Object.freeze([
  'version', 'kind', 'instanceId', 'requestId', 'status', 'reasonCode',
]);
const STARTUP_FIELDS = Object.freeze([
  'version', 'kind', 'scopeId', 'attemptId', 'instanceId', 'status', 'reasonCode',
]);
const SHUTDOWN_EXPECTED_ID_FIELDS = Object.freeze(['kind', 'instanceId', 'requestId']);
const STARTUP_EXPECTED_ID_FIELDS = Object.freeze(['kind', 'scopeId', 'attemptId']);
const BLOCKED_REASON_CODES = new Set([
  'writer_occupied', 'filesystem_unsupported', 'startup_failed', 'startup_unconfirmed',
]);

function invalidRecord() {
  throw new TypeError(INVALID_RECORD);
}

function assertRecordUuid(value) {
  if (typeof value !== 'string' || value.length !== 36) invalidRecord();
  assertUuidV4(value, INVALID_RECORD);
}

function assertScopeId(value) {
  if (typeof value !== 'string' || value.length !== 64) invalidRecord();
  assertSha256(value, INVALID_RECORD);
}

function captureRecordForSchema(value, schemas) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) invalidRecord();

  let prototype;
  let ownKeys;
  try {
    prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) invalidRecord();
    ownKeys = Reflect.ownKeys(value);
  } catch {
    invalidRecord();
  }

  const schema = schemas.find((fields) => ownKeys.length === fields.length &&
    ownKeys.every((key) => typeof key === 'string' && fields.includes(key)));
  if (!schema) invalidRecord();

  return { fields: schema, record: captureExactRecord(value, schema, INVALID_RECORD) };
}

function normalizeRecord(value) {
  const { fields, record } = captureRecordForSchema(value, [SHUTDOWN_FIELDS, STARTUP_FIELDS]);

  if (record.version !== 1) invalidRecord();

  if (fields === SHUTDOWN_FIELDS) {
    if (record.kind !== 'shutdown') invalidRecord();
    assertRecordUuid(record.instanceId);
    assertRecordUuid(record.requestId);
    if (record.status === 'completed') {
      if (record.reasonCode !== null) invalidRecord();
    } else if (record.status === 'failed') {
      if (record.reasonCode !== 'shutdown_incomplete') invalidRecord();
    } else {
      invalidRecord();
    }
  } else {
    if (record.kind !== 'startup') invalidRecord();
    assertScopeId(record.scopeId);
    assertRecordUuid(record.attemptId);
    if (record.status === 'started') {
      assertRecordUuid(record.instanceId);
      if (record.reasonCode !== null) invalidRecord();
    } else if (record.status === 'blocked') {
      if (record.instanceId !== null || !BLOCKED_REASON_CODES.has(record.reasonCode)) invalidRecord();
    } else {
      invalidRecord();
    }
  }

  const normalized = Object.create(null);
  for (const field of fields) {
    Object.defineProperty(normalized, field, {
      value: record[field],
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(normalized);
}

function normalizeStopEnsureExpectedIds(value) {
  const { fields, record } = captureRecordForSchema(value, [
    SHUTDOWN_EXPECTED_ID_FIELDS,
    STARTUP_EXPECTED_ID_FIELDS,
  ]);

  if (fields === SHUTDOWN_EXPECTED_ID_FIELDS) {
    if (record.kind !== 'shutdown') invalidRecord();
    assertRecordUuid(record.instanceId);
    assertRecordUuid(record.requestId);
  } else {
    if (record.kind !== 'startup') invalidRecord();
    assertScopeId(record.scopeId);
    assertRecordUuid(record.attemptId);
  }
  const normalized = Object.create(null);
  for (const field of fields) {
    Object.defineProperty(normalized, field, {
      value: record[field],
      enumerable: true,
      writable: false,
      configurable: false,
    });
  }
  return Object.freeze(normalized);
}

/** 固定schemaをUTF-8へ正規化し、不正入力を固定診断で拒否する。 */
function encodeStopEnsureRecord(record) {
  try {
    const normalized = normalizeRecord(record);
    const json = JSON.stringify(normalized);
    const encoded = Buffer.from(json, 'utf8');
    if (encoded.byteLength > MAX_STOP_ENSURE_RECORD_BYTES) invalidRecord();
    return encoded;
  } catch {
    return invalidRecord();
  }
}

/** kind別の期待IDを必須とし、入力から独立したfreeze済みrecordを返す。 */
function decodeStopEnsureRecord(buffer, expectedIds) {
  try {
    const expected = normalizeStopEnsureExpectedIds(expectedIds);
    if (buffer === null || typeof buffer !== 'object' || types.isProxy(buffer) || !Buffer.isBuffer(buffer)) {
      invalidRecord();
    }
    const bufferSize = TYPED_ARRAY_BYTE_LENGTH_GETTER.call(buffer);
    if (bufferSize > MAX_STOP_ENSURE_RECORD_BYTES) invalidRecord();
    const sourceBytes = new Uint8Array(
      TYPED_ARRAY_BUFFER_GETTER.call(buffer),
      TYPED_ARRAY_BYTE_OFFSET_GETTER.call(buffer),
      bufferSize,
    );
    const bytes = new Uint8Array(bufferSize);
    bytes.set(sourceBytes);
    if (bufferSize >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
      invalidRecord();
    }

    const json = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    const normalized = normalizeRecord(JSON.parse(json));
    if (normalized.kind !== expected.kind) invalidRecord();
    for (const field of Object.keys(expected)) {
      if (normalized[field] !== expected[field]) invalidRecord();
    }
    return normalized;
  } catch {
    return invalidRecord();
  }
}

module.exports = {
  MAX_STOP_ENSURE_RECORD_BYTES,
  decodeStopEnsureRecord,
  encodeStopEnsureRecord,
  normalizeStopEnsureExpectedIds,
};
