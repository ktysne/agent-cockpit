'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createOwnedNativeWaitLatch } = require('../src/server/owned-native-wait');

function fakeClock() {
  let current = 0;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => current,
    schedule(callback, delayMs) {
      const id = nextId++;
      timers.set(id, { callback, due: current + delayMs });
      return id;
    },
    unschedule(id) { timers.delete(id); },
    jump(ms) { current += ms; },
    fireNext() {
      const entry = timers.entries().next().value;
      if (!entry) return false;
      const [id, timer] = entry;
      timers.delete(id);
      timer.callback();
      return true;
    },
    advance(ms) {
      current += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.due <= current) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    get timerCount() { return timers.size; },
  };
}

function makeLatch(clock, events) {
  return createOwnedNativeWaitLatch({
    onTerminal: (status) => events.push(status),
    now: clock.now,
    schedule: clock.schedule,
    unschedule: clock.unschedule,
  });
}

test('a wait latch accepts only its opaque receipt once', () => {
  const clock = fakeClock();
  const events = [];
  const first = makeLatch(clock, events);
  const second = makeLatch(clock, events);

  assert.equal(first.release(second.receipt), false);
  assert.equal(first.release(first.receipt), true);
  assert.equal(first.cancel(first.receipt), false);
  assert.equal(first.state, 'released');
  assert.deepEqual(events, ['released']);
  assert.equal(clock.timerCount, 1);
});

test('release observes an elapsed deadline before the scheduled callback runs', () => {
  const clock = fakeClock();
  const events = [];
  const latch = makeLatch(clock, events);

  clock.jump(5 * 60_000);
  assert.equal(latch.state, 'pending');
  assert.equal(clock.timerCount, 1);
  assert.equal(latch.release(latch.receipt), false);
  assert.equal(latch.state, 'deadline');
  assert.deepEqual(events, ['deadline']);
  assert.equal(clock.timerCount, 0);
});

test('an early timer callback reschedules until the monotonic deadline', () => {
  const clock = fakeClock();
  const events = [];
  const latch = makeLatch(clock, events);

  assert.equal(clock.fireNext(), true);
  assert.equal(latch.state, 'pending');
  assert.deepEqual(events, []);
  assert.equal(clock.timerCount, 1);

  clock.jump(5 * 60_000 - 1);
  assert.equal(clock.fireNext(), true);
  assert.equal(latch.state, 'pending');
  assert.deepEqual(events, []);
  assert.equal(clock.timerCount, 1);

  clock.jump(1);
  assert.equal(clock.fireNext(), true);
  assert.equal(latch.state, 'deadline');
  assert.deepEqual(events, ['deadline']);
  assert.equal(clock.timerCount, 0);
});

test('invalidating a wait latch cancels the timer without producing a response terminal', () => {
  const clock = fakeClock();
  const events = [];
  const latch = makeLatch(clock, events);

  assert.equal(latch.invalidate(), true);
  assert.equal(latch.release(latch.receipt), false);
  clock.jump(5 * 60_000);
  assert.equal(latch.state, 'invalidated');
  assert.deepEqual(events, []);
  assert.equal(clock.timerCount, 0);
});