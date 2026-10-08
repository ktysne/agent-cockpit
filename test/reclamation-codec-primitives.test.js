'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertIdentifier,
  assertSafeUnsignedInteger,
  assertSha256,
  assertUuidV4,
  captureDenseArray,
  captureExactRecord,
  checkedAddBytes,
  checkedMultiplyBytes,
} = require('../src/server/reclamation-codec-primitives');

test('exact record は指定順の null prototype へ浅く複製する', () => {
  const nested = { retained: true };
  const source = Object.create(null);
  Object.defineProperty(source, '__proto__', { value: nested, enumerable: true });
  Object.defineProperty(source, 'first', { value: 1, enumerable: true });

  const captured = captureExactRecord(source, ['first', '__proto__'], 'record_invalid');

  assert.equal(Object.getPrototypeOf(captured), null);
  assert.deepEqual(Object.keys(captured), ['first', '__proto__']);
  assert.equal(Object.hasOwn(captured, '__proto__'), true);
  assert.equal(captured.__proto__, nested);
});

test('exact record は getter を呼ばず accessor と未知 field を拒否する', () => {
  let getterCalled = false;
  const accessor = {};
  Object.defineProperty(accessor, 'field', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 'private value';
    },
  });
  assert.throws(() => captureExactRecord(accessor, ['field'], 'record_invalid'), TypeError);
  assert.equal(getterCalled, false);

  assert.throws(() => captureExactRecord({ field: 1, extra: 2 }, ['field'], 'record_invalid'), TypeError);
  assert.throws(() => captureExactRecord({ field: 1 }, ['field', 'missing'], 'record_invalid'), TypeError);
  assert.throws(() => captureExactRecord({ field: 1, [Symbol('extra')]: 2 }, ['field'], 'record_invalid'), TypeError);
  assert.throws(() => captureExactRecord(new Date(), [], 'record_invalid'), TypeError);
});

test('exact record は非 enumerable な値も拒否する', () => {
  const source = {};
  Object.defineProperty(source, 'field', { value: 1, enumerable: false });
  assert.throws(() => captureExactRecord(source, ['field'], 'record_invalid'), TypeError);
});

test('dense array は data element を複製し、疎配列と追加 property を拒否する', () => {
  const captured = captureDenseArray([1, 'two'], 2, 'array_invalid');
  assert.deepEqual(captured, [1, 'two']);
  assert.throws(() => captureDenseArray([1, 2], 1, 'array_invalid'), TypeError);
  assert.throws(() => captureDenseArray([, 2], 2, 'array_invalid'), TypeError);

  const custom = [1];
  custom.label = 'extra';
  assert.throws(() => captureDenseArray(custom, 2, 'array_invalid'), TypeError);
  const symbolProperty = [1];
  symbolProperty[Symbol('extra')] = true;
  assert.throws(() => captureDenseArray(symbolProperty, 2, 'array_invalid'), TypeError);
  assert.throws(() => captureDenseArray(Object.setPrototypeOf([1], {}), 2, 'array_invalid'), TypeError);
});

test('dense array は index getter を実行しない', () => {
  let getterCalled = false;
  const source = [0];
  Object.defineProperty(source, '0', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalled = true;
      return 1;
    },
  });

  assert.throws(() => captureDenseArray(source, 1, 'array_invalid'), TypeError);
  assert.equal(getterCalled, false);
});

test('identifier は trim、制御文字、長さを検証し、単独 surrogate を許す', () => {
  assert.equal(assertIdentifier('session-id', 'identifier_invalid'), 'session-id');
  assert.equal(assertIdentifier('\ud800', 'identifier_invalid'), '\ud800');
  assert.equal(assertIdentifier('id\u009f', 'identifier_invalid'), 'id\u009f');
  assert.equal(assertIdentifier('x'.repeat(512), 'identifier_invalid').length, 512);
  assert.throws(() => assertIdentifier('', 'identifier_invalid'), TypeError);
  assert.throws(() => assertIdentifier(' id', 'identifier_invalid'), TypeError);
  assert.throws(() => assertIdentifier('id\u001f', 'identifier_invalid'), TypeError);
  assert.throws(() => assertIdentifier('id\u007f', 'identifier_invalid'), TypeError);
  assert.throws(() => assertIdentifier('x'.repeat(513), 'identifier_invalid'), TypeError);
  assert.throws(() => assertIdentifier(1, 'identifier_invalid'), TypeError);
});

test('安全な unsigned integer は 0 以上の safe integer に限る', () => {
  assert.equal(assertSafeUnsignedInteger(0, 'integer_invalid'), 0);
  assert.equal(assertSafeUnsignedInteger(Number.MAX_SAFE_INTEGER, 'integer_invalid'), Number.MAX_SAFE_INTEGER);
  for (const value of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, '1']) {
    assert.throws(() => assertSafeUnsignedInteger(value, 'integer_invalid'), TypeError);
  }
});

test('UUID v4 と SHA-256 は小文字の固定形式だけを許す', () => {
  const uuid = '123e4567-e89b-42d3-a456-426614174000';
  const digest = 'a'.repeat(64);
  assert.equal(assertUuidV4(uuid, 'uuid_invalid'), uuid);
  assert.equal(assertSha256(digest, 'digest_invalid'), digest);
  for (const value of [uuid.toUpperCase(), '123e4567-e89b-12d3-a456-426614174000', 'not-a-uuid']) {
    assert.throws(() => assertUuidV4(value, 'uuid_invalid'), TypeError);
  }
  for (const value of [digest.toUpperCase(), 'a'.repeat(63), digest + 'a']) {
    assert.throws(() => assertSha256(value, 'digest_invalid'), TypeError);
  }
});

test('byte 加算と乗算は safe integer の範囲で計算する', () => {
  assert.equal(checkedAddBytes(), 0);
  assert.equal(checkedAddBytes(1, 2, 3), 6);
  assert.equal(checkedAddBytes(Number.MAX_SAFE_INTEGER - 1, 1), Number.MAX_SAFE_INTEGER);
  assert.equal(checkedMultiplyBytes(0, Number.MAX_SAFE_INTEGER), 0);
  assert.equal(checkedMultiplyBytes(Number.MAX_SAFE_INTEGER, 1), Number.MAX_SAFE_INTEGER);
  assert.throws(() => checkedAddBytes(Number.MAX_SAFE_INTEGER, 1), RangeError);
  assert.throws(() => checkedMultiplyBytes(Number.MAX_SAFE_INTEGER, 2), RangeError);
  assert.throws(() => checkedAddBytes(-1), RangeError);
  assert.throws(() => checkedMultiplyBytes(1.5, 2), RangeError);
});
