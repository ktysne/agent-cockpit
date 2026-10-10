'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createNativeFactoryLifetimeGate } = require('../src/server/native-factory-lifetime-gate');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function assertPending(promise) {
  let settled = false;
  promise.then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
}

test('stopAdmission synchronously rejects every later ticket and cannot be resumed', async () => {
  const gate = createNativeFactoryLifetimeGate();
  const ticket = gate.enter('question_queue');
  gate.stopAdmission();
  gate.stopAdmission();
  assert.throws(() => gate.enter('instruction_queue'), { code: 'native_factory_lifetime_closed' });
  const drained = gate.drain();
  await assertPending(drained);
  ticket.release();
  await drained;
  assert.throws(() => gate.enter('scheduler_pass'), { code: 'native_factory_lifetime_closed' });
  assert.deepEqual(Object.keys(gate).sort(), ['drain', 'enter', 'stopAdmission']);
  assert.equal(Object.isFrozen(gate), true);
});

test('drain waits for all issued tickets and release is idempotent', async () => {
  const gate = createNativeFactoryLifetimeGate();
  const first = gate.enter('question_queue');
  const second = gate.enter('instruction_callback');
  const third = gate.enter('scheduler_pass');
  gate.stopAdmission();
  const drained = gate.drain();
  assert.strictEqual(gate.drain(), drained);
  second.release();
  second.release();
  first.release();
  await assertPending(drained);
  third.release();
  await drained;
  third.release();
  first.release();
  await gate.drain();
  assert.equal(Object.isFrozen(first), true);
});

test('synchronous operation failure releases its ticket in finally', async () => {
  const gate = createNativeFactoryLifetimeGate();
  const failure = new Error('validation_failed');
  function operation() {
    const ticket = gate.enter('question_validation');
    try {
      gate.stopAdmission();
      throw failure;
    } finally {
      ticket.release();
    }
  }
  assert.throws(operation, (error) => error === failure);
  await gate.drain();
});

test('asynchronous rejection releases its ticket only after operation settlement', async () => {
  const gate = createNativeFactoryLifetimeGate();
  const barrier = deferred();
  const failure = new Error('persistence_cancelled');
  const ticket = gate.enter('instruction_queue');
  const operation = (async () => {
    try { return await barrier.promise; }
    finally { ticket.release(); }
  })();
  const rejection = assert.rejects(operation, (error) => error === failure);
  gate.stopAdmission();
  const drained = gate.drain();
  await assertPending(drained);
  barrier.reject(failure);
  await rejection;
  await drained;
});

test('queue tickets include not yet started work until its cancellation settles', async () => {
  const gate = createNativeFactoryLifetimeGate();
  const barrier = deferred();
  let accepting = true;
  let tail = Promise.resolve();
  function enqueue(operation) {
    const ticket = gate.enter('question_queue');
    const result = tail.then(() => {
      if (!accepting) throw new Error('service_closed');
      return operation();
    }).finally(() => ticket.release());
    tail = result.catch(() => {});
    return result;
  }
  const first = enqueue(() => barrier.promise);
  await Promise.resolve();
  let secondStarted = false;
  const second = enqueue(() => { secondStarted = true; });
  const cancelled = assert.rejects(second, /service_closed/);
  gate.stopAdmission();
  accepting = false;
  const drained = gate.drain();
  await assertPending(drained);
  barrier.resolve('saved');
  assert.equal(await first, 'saved');
  await cancelled;
  await drained;
  assert.equal(secondStarted, false);
});

test('empty drain resolves without stopping admission and later drains include new tickets', async () => {
  const gate = createNativeFactoryLifetimeGate();
  await gate.drain();
  const ticket = gate.enter('native_admission');
  const drained = gate.drain();
  await assertPending(drained);
  ticket.release();
  await drained;
  const later = gate.enter('provider_callback');
  const laterDrain = gate.drain();
  await assertPending(laterDrain);
  gate.stopAdmission();
  later.release();
  await laterDrain;
});

test('invalid operation kinds do not create a ticket or invoke caller coercion', async () => {
  const gate = createNativeFactoryLifetimeGate();
  let coerced = false;
  const callerObject = { toString() { coerced = true; return 'question_queue'; } };
  for (const value of [undefined, null, '', '  ', 1, callerObject]) {
    assert.throws(() => gate.enter(value), { code: 'invalid_native_factory_operation_kind' });
  }
  assert.equal(coerced, false);
  gate.stopAdmission();
  await gate.drain();
});
