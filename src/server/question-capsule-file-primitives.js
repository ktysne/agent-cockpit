'use strict';

const { types } = require('node:util');
const { assertPlainDataTree } = require('./reclamation-plain-data');

const MAX_FILE_ROW_VISITS = 100_000;
const MAX_FILE_ARRAY_LENGTH = 100_000;

function fail(errorCode) {
  throw new TypeError(errorCode);
}

function isProxy(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function') && types.isProxy(value);
}

function captureFileRecord(value, fields, errorCode) {
  if (isProxy(value) || value === null || typeof value !== 'object') fail(errorCode);

  let prototype;
  let keys;
  try {
    if (Array.isArray(value)) fail(errorCode);
    prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail(errorCode);
    keys = Reflect.ownKeys(value);
  } catch {
    fail(errorCode);
  }
  if (keys.length !== fields.length) fail(errorCode);

  const fieldSet = new Set(fields);
  const captured = new Map();
  for (const key of keys) {
    if (typeof key !== 'string' || !fieldSet.has(key)) fail(errorCode);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail(errorCode);
    }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(errorCode);
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

function captureFileArray(value, maxLength, errorCode) {
  if (isProxy(value) || !Number.isSafeInteger(maxLength) || maxLength < 0 ||
      maxLength > MAX_FILE_ARRAY_LENGTH || !Array.isArray(value)) fail(errorCode);

  let prototype;
  let lengthDescriptor;
  try {
    prototype = Object.getPrototypeOf(value);
    lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  } catch {
    fail(errorCode);
  }
  if (prototype !== Array.prototype || !lengthDescriptor || !Object.hasOwn(lengthDescriptor, 'value') ||
      lengthDescriptor.enumerable) fail(errorCode);

  const length = lengthDescriptor.value;
  if (!Number.isSafeInteger(length) || length < 0 || length > maxLength) fail(errorCode);

  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    fail(errorCode);
  }
  if (keys.length !== length + 1) fail(errorCode);

  const result = new Array(length);
  for (const key of keys) {
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
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) fail(errorCode);
    Object.defineProperty(result, key, {
      value: descriptor.value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function preflightFileRow(value, errorCode) {
  try {
    assertPlainDataTree(value, errorCode, MAX_FILE_ARRAY_LENGTH, MAX_FILE_ROW_VISITS);
  } catch {
    fail(errorCode);
  }
}

function recordId(value, idField, errorCode) {
  preflightFileRow(value, errorCode);
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(errorCode);
  const descriptor = Object.getOwnPropertyDescriptor(value, idField);
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'string') fail(errorCode);
  return descriptor.value;
}

function orderFileRecords(records, order, idField, errorCode) {
  const capturedRecords = captureFileArray(records, MAX_FILE_ARRAY_LENGTH, errorCode);
  const capturedOrder = captureFileArray(order, MAX_FILE_ARRAY_LENGTH, errorCode);
  if (capturedRecords.length !== capturedOrder.length) fail(errorCode);

  const byId = new Map();
  for (const record of capturedRecords) {
    const id = recordId(record, idField, errorCode);
    if (byId.has(id)) fail(errorCode);
    byId.set(id, record);
  }

  const ordered = [];
  const seen = new Set();
  for (const id of capturedOrder) {
    if (typeof id !== 'string' || seen.has(id) || !byId.has(id)) fail(errorCode);
    seen.add(id);
    ordered.push(byId.get(id));
  }
  if (seen.size !== byId.size) fail(errorCode);
  return ordered;
}

module.exports = {
  captureFileArray,
  captureFileRecord,
  orderFileRecords,
  preflightFileRow,
};
