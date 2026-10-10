'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { decodeSourceBytes, encodeNormalized } = require('../src/server/reclamation-json-codec');

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

test('decode は UTF-8 source の byte 長と raw SHA-256 を返す', () => {
  const backing = Buffer.from('xxx{"text":"\\u0061","label":"あ"} \nzzz', 'utf8');
  const source = backing.subarray(3, backing.length - 3);
  const decoded = decodeSourceBytes(source, source.length);

  assert.deepEqual(decoded.value, { text: 'a', label: 'あ' });
  assert.equal(decoded.sizeBytes, source.length);
  assert.equal(decoded.sha256, digest(source));
  assert.notEqual(decoded.sizeBytes, source.toString('utf8').length);
});

test('decode は byte cap を検査し、元 byte の指紋と正規化 JSON の指紋を分ける', () => {
  const source = Buffer.from('{"text":"\\u0061","n":1}\n', 'utf8');
  const decoded = decodeSourceBytes(source, source.length);
  const encoded = encodeNormalized(decoded.value);

  assert.throws(() => decodeSourceBytes(source, source.length - 1), RangeError);
  assert.equal(encoded.bytes.toString('utf8'), '{\n  "text": "a",\n  "n": 1\n}\n');
  assert.equal(encoded.sizeBytes, encoded.bytes.length);
  assert.equal(encoded.sha256, digest(encoded.bytes));
  assert.notEqual(decoded.sha256, encoded.sha256);
});

test('decode は strict UTF-8、不正 JSON、先頭 BOM を拒否する', () => {
  assert.throws(() => decodeSourceBytes(Buffer.from([0x22, 0xc3, 0x28, 0x22]), 10), {
    name: 'TypeError',
    message: 'invalid_source_utf8',
  });
  assert.throws(() => decodeSourceBytes(Buffer.from('{invalid}'), 20), {
    name: 'TypeError',
    message: 'invalid_source_json',
  });
  const bomJson = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"ok":true}')]);
  assert.throws(() => decodeSourceBytes(bomJson, 20), {
    name: 'TypeError',
    message: 'invalid_source_json',
  });
});

test('decode は Uint8Array view の対象 byte だけを複製して指紋を計算する', () => {
  const backing = new Uint8Array([0x78, 0x7b, 0x7d, 0x79]);
  const source = backing.subarray(1, 3);
  const decoded = decodeSourceBytes(source, 2);
  assert.deepEqual(decoded.value, {});
  assert.equal(decoded.sizeBytes, 2);
  assert.equal(decoded.sha256, digest(Buffer.from([0x7b, 0x7d])));
});

test('decode は ArrayBuffer と Uint8Array の独自 getter を実行せず byte を複製する', () => {
  class CustomBytes extends Uint8Array {}
  const backing = new CustomBytes([0x78, 0x7b, 0x7d, 0x79]);
  const source = backing.subarray(1, 3);
  const arrayBuffer = Reflect.apply(
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'buffer').get,
    source,
    [],
  );
  let getterCalls = 0;
  const recordGetter = () => {
    getterCalls += 1;
    throw new Error('unexpected user-defined getter');
  };

  Object.defineProperty(arrayBuffer, 'byteLength', { get: recordGetter });
  for (const property of ['buffer', 'byteOffset', 'byteLength', Symbol.iterator]) {
    Object.defineProperty(source, property, { configurable: true, get: recordGetter });
  }
  const species = {};
  Object.defineProperty(species, Symbol.species, { get: recordGetter });
  Object.defineProperty(source, 'constructor', {
    configurable: true,
    get() {
      getterCalls += 1;
      return species;
    },
  });

  const decoded = decodeSourceBytes(source, 2);

  assert.deepEqual(decoded.value, {});
  assert.equal(decoded.sizeBytes, 2);
  assert.equal(decoded.sha256, digest(Buffer.from([0x7b, 0x7d])));
  assert.equal(getterCalls, 0);
});

test('encode は plain JSON data を pretty JSON と LF で UTF-8 化する', () => {
  const value = Object.create(null);
  Object.defineProperty(value, '__proto__', { value: 'safe', enumerable: true });
  Object.defineProperty(value, 'nested', {
    value: [true, 'é'],
    enumerable: true,
  });
  const encoded = encodeNormalized(value);

  assert.equal(encoded.bytes.toString('utf8'), '{\n  "__proto__": "safe",\n  "nested": [\n    true,\n    "é"\n  ]\n}\n');
  assert.equal(encoded.sizeBytes, Buffer.byteLength(encoded.bytes));
  assert.equal(encoded.sha256, digest(encoded.bytes));
});

test('encode は単独 surrogate を JSON escape にして decode と往復する', () => {
  const value = { id: '\ud800' };
  const encoded = encodeNormalized(value);
  assert.equal(encoded.bytes.toString('utf8'), '{\n  "id": "\\ud800"\n}\n');

  const decoded = decodeSourceBytes(encoded.bytes, encoded.sizeBytes);
  assert.equal(decoded.value.id, value.id);
  assert.equal(decoded.sizeBytes, encoded.sizeBytes);
  assert.equal(decoded.sha256, encoded.sha256);
});

test('encode は root 0 の深さ64を受け入れ、65を固定形式で拒否する', () => {
  const nestedArray = (depth) => {
    let value = 0;
    for (let index = 0; index < depth; index += 1) value = [value];
    return value;
  };
  const nestedObject = (depth) => {
    let value = 0;
    for (let index = 0; index < depth; index += 1) value = { child: value };
    return value;
  };

  assert.doesNotThrow(() => encodeNormalized(nestedArray(64)));
  assert.doesNotThrow(() => encodeNormalized(nestedObject(64)));
  assert.throws(() => encodeNormalized(nestedArray(65)), {
    name: 'TypeError',
    message: 'invalid_normalized_json',
  });
  assert.throws(() => encodeNormalized(nestedObject(65)), {
    name: 'TypeError',
    message: 'invalid_normalized_json',
  });
});

test('decode した数千段の JSON は encodeNormalized でスタックを使い切らず拒否する', () => {
  const depth = 5000;
  const source = Buffer.from('['.repeat(depth) + '0' + ']'.repeat(depth), 'utf8');
  const decoded = decodeSourceBytes(source, source.length);

  assert.throws(() => encodeNormalized(decoded.value), {
    name: 'TypeError',
    message: 'invalid_normalized_json',
  });
});

test('encode は getter、toJSON function、custom prototype を実行せず拒否する', () => {
  let getterCalled = false;
  let toJsonCalled = false;
  const accessor = {};
  Object.defineProperty(accessor, 'secret', {
    enumerable: true,
    get() {
      getterCalled = true;
      return 'private value';
    },
  });
  assert.throws(() => encodeNormalized(accessor), {
    name: 'TypeError',
    message: 'invalid_normalized_json',
  });
  assert.equal(getterCalled, false);

  const withToJson = {
    toJSON() {
      toJsonCalled = true;
      return { replaced: true };
    },
  };
  assert.throws(() => encodeNormalized(withToJson), TypeError);
  assert.equal(toJsonCalled, false);
  assert.throws(() => encodeNormalized(Object.assign(Object.create({ custom: true }), { value: 1 })), TypeError);
});

test('encode は JSON.stringify が捨てる値と非有限数を拒否する', () => {
  const symbol = Symbol('hidden');
  const symbolField = { value: 1, [symbol]: 2 };
  const nonEnumerable = {};
  Object.defineProperty(nonEnumerable, 'value', { value: 1, enumerable: false });
  const cycle = {};
  cycle.self = cycle;
  const invalidValues = [
    { value: undefined },
    { value: NaN },
    { value: Infinity },
    symbolField,
    nonEnumerable,
    cycle,
    [1, , 3],
  ];
  for (const value of invalidValues) assert.throws(() => encodeNormalized(value), TypeError);
});

test('encode は custom array property と index getter を拒否し、共有参照は複製する', () => {
  let getterCalled = false;
  const accessorArray = [0];
  Object.defineProperty(accessorArray, '0', {
    enumerable: true,
    configurable: true,
    get() {
      getterCalled = true;
      return 1;
    },
  });
  const customArray = [1];
  customArray.label = 'extra';
  assert.throws(() => encodeNormalized(accessorArray), TypeError);
  assert.throws(() => encodeNormalized(customArray), TypeError);
  assert.equal(getterCalled, false);

  const shared = { value: 1 };
  const encoded = encodeNormalized({ left: shared, right: shared });
  assert.equal(encoded.bytes.toString('utf8'), '{\n  "left": {\n    "value": 1\n  },\n  "right": {\n    "value": 1\n  }\n}\n');
});
