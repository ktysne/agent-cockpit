'use strict';

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_ARRAY_LENGTH = 0xffff_ffff;
const IDENTIFIER_CONTROL = /[\u0000-\u001f\u007f]/;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const ERROR_CODE = /^[a-z][a-z0-9_]{0,63}$/;

function fail(errorCode) {
  const message = typeof errorCode === 'string' && ERROR_CODE.test(errorCode)
    ? errorCode
    : 'invalid_codec_value';
  throw new TypeError(message);
}

function hasOwnDataProperty(descriptor) {
  return descriptor !== undefined && Object.hasOwn(descriptor, 'value');
}

function captureDenseArray(value, maxLength, errorCode) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 0 || maxLength > MAX_ARRAY_LENGTH) fail(errorCode);

  let ownKeys;
  let lengthDescriptor;
  try {
    if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) fail(errorCode);
    ownKeys = Reflect.ownKeys(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    fail(errorCode);
  }

  if (!hasOwnDataProperty(lengthDescriptor) || lengthDescriptor.enumerable) fail(errorCode);
  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength || ownKeys.length !== length + 1) fail(errorCode);

  const result = new Array(length);
  for (const key of ownKeys) {
    if (key === 'length') continue;
    if (typeof key !== 'string') fail(errorCode);
    const index = Number(key);
    if (!Number.isSafeInteger(index) || index < 0 || index >= length || String(index) !== key) fail(errorCode);

    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(errorCode);
    }
    if (!hasOwnDataProperty(descriptor) || !descriptor.enumerable) fail(errorCode);
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function captureExactRecord(value, orderedFields, errorCode) {
  const fields = captureDenseArray(orderedFields, MAX_ARRAY_LENGTH, errorCode);
  const fieldSet = new Set();
  for (const field of fields) {
    if (typeof field !== 'string' || fieldSet.has(field)) fail(errorCode);
    fieldSet.add(field);
  }

  let prototype;
  let ownKeys;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(errorCode);
    prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(errorCode);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    fail(errorCode);
  }
  if (ownKeys.length !== fields.length) fail(errorCode);

  const captured = new Map();
  for (const key of ownKeys) {
    if (typeof key !== 'string' || !fieldSet.has(key)) fail(errorCode);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(errorCode);
    }
    if (!hasOwnDataProperty(descriptor) || !descriptor.enumerable) fail(errorCode);
    captured.set(key, descriptor.value);
  }

  const result = Object.create(null);
  for (const field of fields) {
    if (!captured.has(field)) fail(errorCode);
    Object.defineProperty(result, field, {
      value: captured.get(field),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function assertIdentifier(value, errorCode) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512
    || value !== value.trim() || IDENTIFIER_CONTROL.test(value)) fail(errorCode);
  return value;
}

function assertSafeUnsignedInteger(value, errorCode) {
  if (!Number.isSafeInteger(value) || value < 0) fail(errorCode);
  return value;
}

function assertUuidV4(value, errorCode) {
  if (typeof value !== 'string' || !UUID_V4.test(value)) fail(errorCode);
  return value;
}

function assertSha256(value, errorCode) {
  if (typeof value !== 'string' || !SHA256.test(value)) fail(errorCode);
  return value;
}

function assertByteCount(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('invalid_byte_count');
}

function checkedAddBytes(...values) {
  let total = 0;
  for (const value of values) {
    assertByteCount(value);
    if (total > MAX_SAFE_INTEGER - value) throw new RangeError('byte_count_overflow');
    total += value;
  }
  return total;
}

function checkedMultiplyBytes(value, count) {
  assertByteCount(value);
  assertByteCount(count);
  if (value !== 0 && count > Math.floor(MAX_SAFE_INTEGER / value)) {
    throw new RangeError('byte_count_overflow');
  }
  return value * count;
}

module.exports = {
  assertIdentifier,
  assertSafeUnsignedInteger,
  assertSha256,
  assertUuidV4,
  captureDenseArray,
  captureExactRecord,
  checkedAddBytes,
  checkedMultiplyBytes,
};
