'use strict';

const { createNativeQuestionWriteIsolationHarness } = require('./native-question-write-isolation-harness');

function createFakeTimerQueue(options = {}) {
  const records = [];
  let nextId = 1;

  function setTimeoutImpl(callback, delayMs) {
    if (options.setTimeoutError) throw options.setTimeoutError;
    if (typeof callback !== 'function' || !Number.isSafeInteger(delayMs) || delayMs < 0) {
      throw new TypeError('invalid fake timer');
    }
    const record = { id: nextId++, callback, delayMs, active: true, fired: false };
    records.push(record);
    return record.id;
  }

  function clearTimeoutImpl(id) {
    const record = records.find((item) => item.id === id);
    if (record) record.active = false;
  }

  async function fireNext() {
    const record = records.find((item) => item.active && !item.fired);
    if (!record) throw new Error('fake timer is not pending');
    record.active = false;
    record.fired = true;
    await record.callback();
    return record.id;
  }

  return Object.freeze({
    schedulerTimers: Object.freeze({ setTimeoutImpl, clearTimeoutImpl }),
    fireNext,
    pendingCount: () => records.filter((record) => record.active && !record.fired).length,
    scheduledDelays: () => Object.freeze(records.map((record) => record.delayMs)),
    firedCount: () => records.filter((record) => record.fired).length,
    clearedCount: () => records.filter((record) => !record.active && !record.fired).length,
  });
}

async function createNativeReclamationSchedulerHarness(provider, options = {}) {
  const timers = createFakeTimerQueue();
  const harness = await createNativeQuestionWriteIsolationHarness(provider, {
    ...options,
    schedulerTimers: timers.schedulerTimers,
  });
  return Object.freeze({
    timers,
    harness,
    close: () => harness.close(),
    removeDirectory: () => harness.removeDirectory(),
    scheduler: () => harness.modules.observer.schedulers().at(-1) || null,
  });
}

module.exports = { createFakeTimerQueue, createNativeReclamationSchedulerHarness };
