'use strict';

const { createHash } = require('node:crypto');
const { TextDecoder, types } = require('node:util');
const {
  assertSafeUnsignedInteger,
  captureDenseArray,
  captureExactRecord,
  checkedAddBytes,
} = require('./reclamation-codec-primitives');

const MAX_ARRAY_LENGTH = 0xffff_ffff;
const MAX_NORMALIZED_JSON_DEPTH = 64;
const INVALID_SOURCE_BYTES = 'invalid_source_bytes';
const INVALID_NORMALIZED_JSON = 'invalid_normalized_json';
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getTypedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const getTypedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const getTypedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function copyUint8Array(bytes) {
  if (!types.isUint8Array(bytes)) throw new TypeError(INVALID_SOURCE_BYTES);
  try {
    const buffer = Reflect.apply(getTypedArrayBuffer, bytes, []);
    const byteOffset = Reflect.apply(getTypedArrayByteOffset, bytes, []);
    const byteLength = Reflect.apply(getTypedArrayByteLength, bytes, []);
    return Buffer.from(Buffer.from(buffer, byteOffset, byteLength));
  } catch {
    throw new TypeError(INVALID_SOURCE_BYTES);
  }
}

function decodeSourceBytes(bytes, fixedMaxBytes) {
  assertSafeUnsignedInteger(fixedMaxBytes, 'invalid_byte_limit');
  if (!types.isUint8Array(bytes)) throw new TypeError(INVALID_SOURCE_BYTES);

  let byteLength;
  try {
    byteLength = Reflect.apply(getTypedArrayByteLength, bytes, []);
  } catch {
    throw new TypeError(INVALID_SOURCE_BYTES);
  }
  if (byteLength > fixedMaxBytes) throw new RangeError('source_too_large');

  const sourceBytes = copyUint8Array(bytes);
  if (sourceBytes.length > fixedMaxBytes) throw new RangeError('source_too_large');
  let sourceText;
  try {
    sourceText = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(sourceBytes);
  } catch {
    throw new TypeError('invalid_source_utf8');
  }

  let value;
  try {
    value = JSON.parse(sourceText);
  } catch {
    throw new TypeError('invalid_source_json');
  }
  return {
    value,
    sizeBytes: sourceBytes.length,
    sha256: sha256(sourceBytes),
  };
}

function normalizeJsonValue(value, ancestors, depth) {
  if (depth > MAX_NORMALIZED_JSON_DEPTH) throw new TypeError(INVALID_NORMALIZED_JSON);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new TypeError(INVALID_NORMALIZED_JSON);
    return value;
  }
  if (typeof value !== 'object') throw new TypeError(INVALID_NORMALIZED_JSON);
  if (ancestors.has(value)) throw new TypeError(INVALID_NORMALIZED_JSON);

  ancestors.add(value);
  try {
    let isArray;
    try {
      isArray = Array.isArray(value);
    } catch {
      throw new TypeError(INVALID_NORMALIZED_JSON);
    }

    if (isArray) {
      const items = captureDenseArray(value, MAX_ARRAY_LENGTH, INVALID_NORMALIZED_JSON);
      const result = new Array(items.length);
      Object.defineProperty(result, 'toJSON', {
        value: null,
        enumerable: false,
        writable: false,
        configurable: false,
      });
      for (let index = 0; index < items.length; index += 1) {
        Object.defineProperty(result, String(index), {
          value: normalizeJsonValue(items[index], ancestors, depth + 1),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return result;
    }

    let ownKeys;
    try {
      ownKeys = Reflect.ownKeys(value);
    } catch {
      throw new TypeError(INVALID_NORMALIZED_JSON);
    }
    const captured = captureExactRecord(value, ownKeys, INVALID_NORMALIZED_JSON);
    const result = Object.create(null);
    for (const key of Object.keys(captured)) {
      Object.defineProperty(result, key, {
        value: normalizeJsonValue(captured[key], ancestors, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function encodeNormalized(value) {
  const normalized = normalizeJsonValue(value, new WeakSet(), 0);
  const serialized = JSON.stringify(normalized, null, 2);
  const body = Buffer.from(serialized, 'utf8');
  const sizeBytes = checkedAddBytes(body.length, 1);
  const bytes = Buffer.concat([body, Buffer.from('\n')], sizeBytes);
  return {
    bytes,
    sizeBytes,
    sha256: sha256(bytes),
  };
}

module.exports = { decodeSourceBytes, encodeNormalized };
