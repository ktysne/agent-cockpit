'use strict';

const { createHash } = require('node:crypto');

const MODES = new Set(['steer', 'start', 'next-user-input']);
const MAX_IDENTIFIER_LENGTH = 512;
const MAX_INSTRUCTION_TEXT_BYTES = 64 * 1024;
const MAX_ENVELOPE_BYTES = 70 * 1024;
const SHA256 = /^[a-f0-9]{64}$/;

function instructionError(code) {
  const error = new Error('instruction envelope rejected');
  error.code = code;
  return error;
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactObject(value, fields, code = 'invalid_instruction_envelope') {
  if (!isRecord(value)) throw instructionError(code);
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw instructionError(code);
  }
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
    throw instructionError(code);
  }
  const result = {};
  for (const field of fields) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      throw instructionError(code);
    }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw instructionError(code);
    }
    result[field] = descriptor.value;
  }
  return result;
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH && value === value.trim() &&
    !/[\u0000-\u001f\u007f]/.test(value);
}

function validUnicode(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      if (index + 1 >= value.length) return false;
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return false;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isDenseArray(value, expectedLength) {
  if (!Array.isArray(value) || value.length !== expectedLength) return false;
  try {
    const keys = Reflect.ownKeys(value);
    return keys.length === expectedLength + 1 &&
      keys.includes('length') &&
      keys.filter((key) => key !== 'length').every((key, index) => key === String(index)) &&
      keys.slice(0, -1).every((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
      });
  } catch {
    return false;
  }
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeInput(input) {
  if (!isDenseArray(input, 1)) throw instructionError('invalid_instruction_input');
  const item = exactObject(input[0], ['type', 'text', 'text_elements'], 'invalid_instruction_input');
  if (item.type !== 'text' || typeof item.text !== 'string' || !item.text.trim() ||
      !validUnicode(item.text) || Buffer.byteLength(item.text, 'utf8') > MAX_INSTRUCTION_TEXT_BYTES ||
      !isDenseArray(item.text_elements, 0)) {
    throw instructionError('invalid_instruction_input');
  }
  return [{ type: 'text', text: item.text, text_elements: [] }];
}

function createInstructionEnvelope(input) {
  const captured = exactObject(input, ['mode', 'expectedTurnId', 'text']);
  if (!MODES.has(captured.mode)) throw instructionError('invalid_instruction_mode');
  if (captured.mode === 'steer') {
    if (!isIdentifier(captured.expectedTurnId)) throw instructionError('expected_turn_required');
  } else if (captured.expectedTurnId !== null) {
    throw instructionError('unexpected_turn');
  }
  if (typeof captured.text !== 'string') throw instructionError('invalid_instruction_input');
  const normalizedInput = normalizeInput([{
    type: 'text',
    text: captured.text,
    text_elements: [],
  }]);
  const envelope = {
    schemaVersion: 1,
    mode: captured.mode,
    expectedTurnId: captured.expectedTurnId,
    input: normalizedInput,
  };
  const serialized = JSON.stringify(envelope);
  if (Buffer.byteLength(serialized, 'utf8') > MAX_ENVELOPE_BYTES) {
    throw instructionError('instruction_envelope_too_large');
  }
  return Object.freeze({
    envelope: Object.freeze(envelope),
    serialized,
    envelopeDigest: sha256(serialized),
    nativeContentDigest: sha256(JSON.stringify(normalizedInput)),
  });
}

function digestNativeInstructionInput(input) {
  const normalizedInput = normalizeInput(input);
  const serialized = JSON.stringify(normalizedInput);
  return {
    input: normalizedInput,
    nativeContentDigest: sha256(serialized),
    sizeBytes: Buffer.byteLength(serialized, 'utf8'),
  };
}
function parseInstructionEnvelope(serialized) {
  if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_ENVELOPE_BYTES) {
    throw instructionError('invalid_instruction_envelope');
  }
  let value;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw instructionError('invalid_instruction_envelope');
  }
  const captured = exactObject(value, ['schemaVersion', 'mode', 'expectedTurnId', 'input']);
  if (captured.schemaVersion !== 1 || !MODES.has(captured.mode)) {
    throw instructionError('invalid_instruction_envelope');
  }
  if (captured.mode === 'steer') {
    if (!isIdentifier(captured.expectedTurnId)) throw instructionError('expected_turn_required');
  } else if (captured.expectedTurnId !== null) {
    throw instructionError('unexpected_turn');
  }
  const input = normalizeInput(captured.input);
  const envelope = {
    schemaVersion: 1,
    mode: captured.mode,
    expectedTurnId: captured.expectedTurnId,
    input,
  };
  const canonical = JSON.stringify(envelope);
  if (canonical !== serialized) throw instructionError('noncanonical_instruction_envelope');
  return Object.freeze({
    envelope: Object.freeze(envelope),
    serialized: canonical,
    envelopeDigest: sha256(canonical),
    nativeContentDigest: sha256(JSON.stringify(input)),
  });
}

function isSha256Digest(value) {
  return typeof value === 'string' && SHA256.test(value);
}

module.exports = {
  MAX_ENVELOPE_BYTES,
  MAX_INSTRUCTION_TEXT_BYTES,
  createInstructionEnvelope,
  digestNativeInstructionInput,
  instructionError,
  isIdentifier,
  isSha256Digest,
  parseInstructionEnvelope,
};
