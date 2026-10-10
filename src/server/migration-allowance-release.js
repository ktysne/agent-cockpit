'use strict';

const { types } = require('node:util');
const {
  assertSafeUnsignedInteger,
  captureDenseArray,
  captureExactRecord,
} = require('./reclamation-codec-primitives');
const { canClearMigrationAllowance } = require('./reclamation-capacity-bounds');
const { validateReclamationStoreWrite } = require('./reclamation-store-consistency');

const STORE_FIELDS = ['questions', 'checkpoint', 'instructions'];
const ALLOWED_RECONCILIATION_REASONS = new Set([
  'instruction_creation_state', 'question_creation_state', 'question_checkpoint_cache',
]);
const MAX_SOURCE_BYTES = 16_777_216;
const INVALID_PLAN = 'invalid_migration_allowance_release';

function fail() {
  const error = new TypeError(INVALID_PLAN);
  error.code = INVALID_PLAN;
  throw error;
}

function makeRecord(entries) {
  const result = Object.create(null);
  for (const [key, value] of entries) {
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function captureLimits(value, stores) {
  const limits = captureExactRecord(value, STORE_FIELDS, INVALID_PLAN);
  for (const slot of STORE_FIELDS) {
    if (stores[slot] === null) {
      if (limits[slot] !== null) fail();
    } else if (!Number.isSafeInteger(limits[slot]) || limits[slot] < 1 ||
        limits[slot] > MAX_SOURCE_BYTES) {
      fail();
    }
  }
  return limits;
}

function assertNoProxyOrAccessor(value, visited = new Set()) {
  if (value === null || typeof value !== 'object') return;
  if (types.isProxy(value)) fail();
  if (visited.has(value)) return;
  visited.add(value);

  if (Array.isArray(value)) {
    let captured;
    try {
      captured = captureDenseArray(value, 0xffff_ffff, INVALID_PLAN);
    } catch {
      fail();
    }
    for (const item of captured) assertNoProxyOrAccessor(item, visited);
    return;
  }

  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    keys = Reflect.ownKeys(value);
  } catch {
    fail();
  }
  for (const key of keys) {
    if (typeof key !== 'string') fail();
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail();
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail();
    assertNoProxyOrAccessor(descriptor.value, visited);
  }
}

function validateStoreWrite(anchor, previousStores, nextStores, limits) {
  let transition;
  try {
    transition = validateReclamationStoreWrite({
      anchor,
      previousStores,
      nextStores,
      normalByteLimitsBySlot: limits,
    });
  } catch {
    fail();
  }
  if (transition.reasons.some((reason) => !ALLOWED_RECONCILIATION_REASONS.has(reason))) fail();
  return transition;
}

function cloneRawValue(value, clones = new Map()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean' ||
      typeof value === 'number') return value;
  if (typeof value !== 'object') fail();
  if (clones.has(value)) return clones.get(value);

  if (Array.isArray(value)) {
    let captured;
    try {
      captured = captureDenseArray(value, 0xffff_ffff, INVALID_PLAN);
    } catch {
      fail();
    }
    const result = new Array(captured.length);
    clones.set(value, result);
    for (let index = 0; index < captured.length; index += 1) {
      Object.defineProperty(result, String(index), {
        value: cloneRawValue(captured[index], clones),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  }

  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    keys = Reflect.ownKeys(value);
  } catch {
    fail();
  }
  const result = Object.create(prototype);
  clones.set(value, result);
  for (const key of keys) {
    if (typeof key !== 'string') fail();
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      fail();
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) fail();
    Object.defineProperty(result, key, {
      value: cloneRawValue(descriptor.value, clones),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function nextRevision(value) {
  assertSafeUnsignedInteger(value, INVALID_PLAN);
  if (value === Number.MAX_SAFE_INTEGER) fail();
  return value + 1;
}

function planMigrationAllowanceRelease(value) {
  try {
    if (value === null || typeof value !== 'object' || types.isProxy(value)) fail();
    const input = captureExactRecord(value,
      ['anchor', 'stores', 'normalByteLimitsBySlot', 'slot'], INVALID_PLAN);
    if (typeof input.slot !== 'string' || !STORE_FIELDS.includes(input.slot)) fail();

    assertNoProxyOrAccessor(input.anchor);
    assertNoProxyOrAccessor(input.stores);
    assertNoProxyOrAccessor(input.normalByteLimitsBySlot);
    const stores = captureExactRecord(input.stores, STORE_FIELDS, INVALID_PLAN);
    const limits = captureLimits(input.normalByteLimitsBySlot, stores);
    const current = validateStoreWrite(input.anchor, stores, stores, limits);
    if (current.snapshot.anchor.migration !== null) fail();

    const target = current.snapshot.stores[input.slot];
    if (target === null) fail();
    if (target.migrationAllowance === null) {
      return makeRecord([['status', 'already_clear'], ['slot', input.slot]]);
    }

    const candidateAnchor = cloneRawValue(input.anchor);
    const candidateStores = cloneRawValue(stores);
    const candidateTarget = candidateStores[input.slot];
    candidateTarget.migrationAllowance = null;
    candidateTarget.revision = nextRevision(candidateTarget.revision);

    let capacity;
    try {
      capacity = canClearMigrationAllowance({
        slot: input.slot,
        snapshotWithoutGrant: candidateTarget,
        normalByteLimit: limits[input.slot],
      });
    } catch {
      fail();
    }
    if (!Number.isSafeInteger(capacity.reserveBytes) || capacity.canClear !== true ||
        capacity.reserveBytes > capacity.limitBytes ||
        capacity.limitBytes !== limits[input.slot]) {
      return makeRecord([['status', 'retained'], ['slot', input.slot]]);
    }

    validateStoreWrite(candidateAnchor, stores, candidateStores, limits);
    return makeRecord([
      ['status', 'released'],
      ['slot', input.slot],
      ['snapshot', makeRecord([['anchor', candidateAnchor], ['stores', candidateStores]])],
    ]);
  } catch (error) {
    if (error instanceof TypeError && error.code === INVALID_PLAN && error.message === INVALID_PLAN) throw error;
    fail();
  }
}

module.exports = { planMigrationAllowanceRelease };
