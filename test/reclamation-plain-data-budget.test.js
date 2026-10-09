'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { assertPlainDataTree } = require('../src/server/reclamation-plain-data');

test('plain-data budget counts the root and every primitive value exactly once', () => {
  const value = [null, true, 1, 'x'];

  assert.doesNotThrow(() => assertPlainDataTree(value, 'invalid_test_data', 4, 5));
  assert.throws(() => assertPlainDataTree(value, 'invalid_test_data', 4, 4), TypeError);
});

test('plain-data budget counts each occurrence of a shared acyclic object', () => {
  const shared = { value: 1 };
  const value = { left: shared, right: shared };

  assert.doesNotThrow(() => assertPlainDataTree(value, 'invalid_test_data', 3, 5));
  assert.throws(() => assertPlainDataTree(value, 'invalid_test_data', 3, 4), TypeError);
});

test('three-argument callers retain the default budget for dense arrays', () => {
  const value = new Array(100_000).fill(null);

  assert.doesNotThrow(() => assertPlainDataTree(value, 'invalid_test_data', 100_000));
});

test('plain-data budget finitely rejects a compact acyclic DAG with repeated visits', () => {
  let value = { leaf: null };
  for (let depth = 0; depth < 20; depth += 1) value = { left: value, right: value };

  assert.throws(() => assertPlainDataTree(value, 'invalid_test_data', 2, 100_000), TypeError);
});

test('array length is compared with remaining budget before own-key enumeration', () => {
  const value = [1, 2];
  const ownKeys = Reflect.ownKeys;
  let enumerated = false;
  Reflect.ownKeys = function trackedOwnKeys(candidate) {
    if (candidate === value) enumerated = true;
    return ownKeys(candidate);
  };
  try {
    assert.throws(() => assertPlainDataTree(value, 'invalid_test_data', 3, 1), TypeError);
    assert.equal(enumerated, false);
  } finally {
    Reflect.ownKeys = ownKeys;
  }
});

test('object key count is compared with remaining budget before child descriptors', () => {
  const value = { first: 1, second: 2 };
  const getOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
  let descriptorCalls = 0;
  Object.getOwnPropertyDescriptor = function trackedDescriptor(candidate, key) {
    if (candidate === value) descriptorCalls += 1;
    return getOwnPropertyDescriptor(candidate, key);
  };
  try {
    assert.throws(() => assertPlainDataTree(value, 'invalid_test_data', 3, 1), TypeError);
    assert.equal(descriptorCalls, 0);
  } finally {
    Object.getOwnPropertyDescriptor = getOwnPropertyDescriptor;
  }
});

test('visited-value budget rejects invalid limits and accessors without invoking them', () => {
  for (const maximumVisitedValues of [0, 1_000_001, 1.5, Number.NaN]) {
    assert.throws(() => assertPlainDataTree({}, 'invalid_test_data', 3, maximumVisitedValues), TypeError);
  }

  let getterCalls = 0;
  const accessor = {};
  Object.defineProperty(accessor, 'value', {
    enumerable: true,
    get() { getterCalls += 1; return 1; },
  });
  assert.throws(() => assertPlainDataTree(accessor, 'invalid_test_data', 3, 10), TypeError);
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const proxied = new Proxy({}, {
    getPrototypeOf() { proxyTraps += 1; return Object.prototype; },
    ownKeys() { proxyTraps += 1; return []; },
    getOwnPropertyDescriptor() { proxyTraps += 1; return undefined; },
  });
  assert.throws(() => assertPlainDataTree(proxied, 'invalid_test_data', 3, 10), TypeError);
  assert.equal(proxyTraps, 0);
});
