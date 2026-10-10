'use strict';

const { types } = require('node:util');

const MAX_PLAIN_DATA_DEPTH = 128;
const MAX_PLAIN_DATA_ARRAY_LENGTH = 100_000;

function requireValue(condition, errorCode) {
  if (!condition) throw new TypeError(errorCode);
}

/** Proxyやgetterを実行せず、正規化前の入力木が単純なデータだけであることを検査する。 */
function assertPlainDataTree(value, errorCode, maximumArrayLength) {
  requireValue(Number.isSafeInteger(maximumArrayLength) && maximumArrayLength >= 0 &&
    maximumArrayLength <= MAX_PLAIN_DATA_ARRAY_LENGTH, errorCode);
  assertPlainDataValue(value, errorCode, maximumArrayLength, new Set(), 0);
}

function assertPlainDataValue(value, errorCode, maximumArrayLength, active, depth) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return;
  if (typeof value === 'number') {
    requireValue(Number.isFinite(value), errorCode);
    return;
  }
  requireValue(typeof value === 'object' && !types.isProxy(value) && depth <= MAX_PLAIN_DATA_DEPTH, errorCode);
  requireValue(!active.has(value), errorCode);
  active.add(value);
  try {
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    requireValue(array ? prototype === Array.prototype
      : prototype === Object.prototype || prototype === null, errorCode);
    const keys = Reflect.ownKeys(value);
    if (array) {
      const descriptor = Object.getOwnPropertyDescriptor(value, 'length');
      requireValue(descriptor && Object.hasOwn(descriptor, 'value') && !descriptor.enumerable &&
        Number.isSafeInteger(descriptor.value) && descriptor.value >= 0 &&
        descriptor.value <= maximumArrayLength && keys.length === descriptor.value + 1, errorCode);
      for (let index = 0; index < descriptor.value; index += 1) {
        const item = Object.getOwnPropertyDescriptor(value, String(index));
        requireValue(item && item.enumerable && Object.hasOwn(item, 'value'), errorCode);
        assertPlainDataValue(item.value, errorCode, maximumArrayLength, active, depth + 1);
      }
    } else {
      for (const key of keys) {
        requireValue(typeof key === 'string', errorCode);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        requireValue(descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value'), errorCode);
        assertPlainDataValue(descriptor.value, errorCode, maximumArrayLength, active, depth + 1);
      }
    }
  } finally {
    active.delete(value);
  }
}

module.exports = { assertPlainDataTree };
