'use strict';

const { performance } = require('node:perf_hooks');

const WAIT_TIMEOUT_MS = 5 * 60_000;

function createOwnedNativeWaitLatch(options) {
  if (!options || typeof options !== 'object' || Array.isArray(options) ||
      typeof options.onTerminal !== 'function') {
    throw new TypeError('wait latch callback required');
  }
  const now = options.now || (() => performance.now());
  const schedule = options.schedule || setTimeout;
  const unschedule = options.unschedule || clearTimeout;
  if (typeof now !== 'function' || typeof schedule !== 'function' || typeof unschedule !== 'function') {
    throw new TypeError('wait latch clock invalid');
  }

  const receipt = Object.freeze(Object.create(null));
  const deadline = now() + WAIT_TIMEOUT_MS;
  let state = 'pending';
  let timer = null;

  function settle(status, notify = true) {
    if (state !== 'pending') return false;
    state = status;
    if (timer !== null) {
      unschedule(timer);
      timer = null;
    }
    if (notify) {
      try { options.onTerminal(status); } catch {}
    }
    return true;
  }

  function scheduleDeadline() {
    if (state !== 'pending') return;
    const remaining = Math.max(1, Math.ceil(deadline - now()));
    timer = schedule(() => {
      timer = null;
      if (state !== 'pending') return;
      if (now() < deadline) scheduleDeadline();
      else settle('deadline');
    }, remaining);
  }

  function finish(receivedReceipt, status) {
    if (receivedReceipt !== receipt || state !== 'pending') return false;
    if (now() >= deadline) {
      settle('deadline');
      return false;
    }
    return settle(status);
  }

  scheduleDeadline();
  return Object.freeze({
    receipt,
    release: (receivedReceipt) => finish(receivedReceipt, 'released'),
    cancel: (receivedReceipt) => finish(receivedReceipt, 'cancelled'),
    invalidate: () => settle('invalidated', false),
    get state() { return state; },
  });
}

module.exports = { createOwnedNativeWaitLatch };