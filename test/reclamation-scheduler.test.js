'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  MAX_RECLAMATION_SCHEDULER_INTERVAL_MS,
  MAX_RECLAMATION_SCHEDULER_OPERATIONS_PER_PASS,
  createReclamationScheduler,
} = require('../src/server/reclamation-scheduler');

const IDENTITY = Object.freeze({
  provider: 'claude',
  nativeIdKind: 'session',
  hostId: 'host-1',
  homeScopeId: 'home-1',
  nativeId: 'native-1',
});

function candidates({ state = 'ready', bodyCandidates = [], grantSlots = [] } = {}) {
  return { state, bodyCandidates, grantSlots };
}

function createFakeTimers() {
  const records = [];
  const setTimeoutImpl = (callback, delay) => {
    const record = { callback, delay, cancelled: false, fired: false, unrefCalls: 0 };
    records.push(record);
    return {
      record,
      unref() { record.unrefCalls += 1; },
    };
  };
  const clearTimeoutImpl = (handle) => { handle.record.cancelled = true; };
  const next = () => records.find((record) => !record.cancelled && !record.fired) || null;
  const fire = (record = next()) => {
    assert.ok(record);
    record.fired = true;
    return record.callback();
  };
  return { records, setTimeoutImpl, clearTimeoutImpl, next, fire };
}

function createScheduler(overrides = {}) {
  const timers = createFakeTimers();
  const options = {
    listCandidates: () => candidates(),
    reclaimCandidate: async () => ({ status: 'complete' }),
    releaseGrants: async () => ({ status: 'released' }),
    intervalMs: 25,
    maxOperationsPerPass: 3,
    setTimeoutImpl: timers.setTimeoutImpl,
    clearTimeoutImpl: timers.clearTimeoutImpl,
    ...overrides,
  };
  return { scheduler: createReclamationScheduler(options), timers };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, resolve, reject };
}

test('scheduler options reject invalid bounds, partial timer injection, accessors, and proxies', () => {
  const base = {
    listCandidates: () => candidates(),
    reclaimCandidate: async () => ({ status: 'complete' }),
    releaseGrants: async () => ({ status: 'already_clear' }),
    intervalMs: 25,
    maxOperationsPerPass: 3,
  };
  assert.equal(MAX_RECLAMATION_SCHEDULER_INTERVAL_MS, 2_147_483_647);
  assert.equal(MAX_RECLAMATION_SCHEDULER_OPERATIONS_PER_PASS, 100);
  assert.throws(() => createReclamationScheduler({ ...base, intervalMs: 0 }), /invalid_reclamation_scheduler_options/);
  assert.throws(() => createReclamationScheduler({ ...base, intervalMs: 2_147_483_648 }), /invalid_reclamation_scheduler_options/);
  assert.throws(() => createReclamationScheduler({ ...base, maxOperationsPerPass: 101 }), /invalid_reclamation_scheduler_options/);
  assert.throws(() => createReclamationScheduler({ ...base, setTimeoutImpl() {} }), /invalid_reclamation_scheduler_options/);

  let getterCalls = 0;
  const accessorOptions = { ...base };
  Object.defineProperty(accessorOptions, 'intervalMs', {
    enumerable: true,
    get() { getterCalls += 1; return 25; },
  });
  assert.throws(() => createReclamationScheduler(accessorOptions), /invalid_reclamation_scheduler_options/);
  assert.equal(getterCalls, 0);

  let proxyTrapCalls = 0;
  const proxy = new Proxy({ ...base }, {
    ownKeys(target) { proxyTrapCalls += 1; return Reflect.ownKeys(target); },
  });
  assert.throws(() => createReclamationScheduler(proxy), /invalid_reclamation_scheduler_options/);
  assert.equal(proxyTrapCalls, 0);
});

test('start schedules a delayed one-shot without running before start and stop cancels it', async () => {
  let listCalls = 0;
  const { scheduler, timers } = createScheduler({
    listCandidates: () => { listCalls += 1; return candidates(); },
  });
  assert.equal(scheduler.status().state, 'idle');
  assert.equal(timers.records.length, 0);
  scheduler.start();
  scheduler.start();
  assert.equal(timers.records.length, 1);
  assert.equal(timers.records[0].delay, 25);
  assert.equal(timers.records[0].unrefCalls, 1);
  assert.equal(listCalls, 0);

  await timers.fire(timers.next());
  assert.equal(listCalls, 1);
  assert.equal(timers.records.length, 2);
  assert.equal(timers.records[1].delay, 25);
  scheduler.stop();
  assert.equal(timers.records[1].cancelled, true);
  scheduler.start();
  assert.equal(timers.records.length, 2);
  assert.equal(scheduler.status().stopReason, 'explicit');
});

test('duplicate timer triggers coalesce without overlapping or creating an immediate retry', async () => {
  const pendingCall = deferred();
  let calls = 0;
  const { scheduler, timers } = createScheduler({
    maxOperationsPerPass: 1,
    listCandidates: () => candidates({ bodyCandidates: [{ kind: 'instruction', deliveryAttemptId: 'attempt-1' }] }),
    reclaimCandidate: () => { calls += 1; return pendingCall.promise; },
  });
  scheduler.start();
  const firstTimer = timers.next();
  const firstPass = timers.fire(firstTimer);
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 1);

  const duplicatePass = firstTimer.callback();
  firstTimer.callback();
  assert.equal(calls, 1);
  pendingCall.resolve({ status: 'deferred' });
  await Promise.all([firstPass, duplicatePass]);
  assert.equal(calls, 1);
  assert.equal(timers.next().delay, 25);
  assert.equal(timers.records.length, 2);

  await timers.fire(timers.next());
  assert.equal(calls, 2);
  scheduler.stop();
});

test('operation budget and category plus ID cursor rotate through deferred bodies and grants', async () => {
  const operations = [];
  const bodyCandidates = [
    { kind: 'terminal-delivery', deliveryAttemptId: 'terminal-1' },
    { kind: 'instruction', deliveryAttemptId: 'instruction-2' },
    { kind: 'question-period', identity: IDENTITY, periodId: 'period-2' },
    { kind: 'instruction', deliveryAttemptId: 'instruction-1' },
    { kind: 'question-period', identity: IDENTITY, periodId: 'period-1' },
  ];
  const { scheduler, timers } = createScheduler({
    maxOperationsPerPass: 2,
    listCandidates: () => candidates({
      bodyCandidates,
      grantSlots: ['questions', 'checkpoint', 'instructions'],
    }),
    reclaimCandidate: async (candidate) => {
      operations.push(`${candidate.kind}:${candidate.kind === 'question-period'
        ? candidate.periodId : candidate.deliveryAttemptId}`);
      return { status: 'deferred' };
    },
    releaseGrants: async (slot) => {
      operations.push(`grant:${slot}`);
      return { status: 'retained' };
    },
  });
  scheduler.start();

  const passOrders = [];
  for (let pass = 0; pass < 4; pass += 1) {
    const before = operations.length;
    await timers.fire(timers.next());
    passOrders.push(operations.slice(before));
    assert.ok(scheduler.status().lastPassOperationCount <= 2);
    assert.equal(timers.next().delay, 25);
  }
  assert.deepEqual(passOrders, [
    ['question-period:period-1', 'question-period:period-2'],
    ['instruction:instruction-1', 'instruction:instruction-2'],
    ['terminal-delivery:terminal-1', 'grant:checkpoint'],
    ['grant:instructions', 'grant:questions'],
  ]);
  scheduler.stop();
});

test('degraded state skips question and grant candidates while continuing nonquestion candidates', async () => {
  let listCalls = 0;
  const invoked = [];
  const { scheduler, timers } = createScheduler({
    maxOperationsPerPass: 10,
    listCandidates: () => {
      listCalls += 1;
      return listCalls === 1
        ? candidates({
          bodyCandidates: [
            { kind: 'question-period', identity: IDENTITY, periodId: 'period-1' },
            { kind: 'instruction', deliveryAttemptId: 'instruction-1' },
          ],
          grantSlots: ['instructions'],
        })
        : candidates({
          state: 'degraded',
          bodyCandidates: [{ kind: 'instruction', deliveryAttemptId: 'instruction-1' }],
        });
    },
    reclaimCandidate: async (candidate) => {
      invoked.push(candidate.kind);
      return { status: 'skipped' };
    },
    releaseGrants: async (slot) => { invoked.push(`grant:${slot}`); return { status: 'already_clear' }; },
  });
  scheduler.start();
  await timers.fire(timers.next());
  assert.deepEqual(invoked, ['instruction']);
  assert.equal(scheduler.status().failureCount, 0);
  assert.equal(timers.next().delay, 25);
  scheduler.stop();
});

test('question uncertainty bounds candidate rechecks and still advances to nonquestion work', async () => {
  const maxOperationsPerPass = 3;
  const questionCandidates = Array.from({ length: 20_000 }, (_, index) => ({
    kind: 'question-period',
    identity: IDENTITY,
    periodId: `retired-${String(index).padStart(5, '0')}`,
  }));
  const instruction = { kind: 'instruction', deliveryAttemptId: 'instruction-1' };
  let listCalls = 0;
  const invoked = [];
  const { scheduler, timers } = createScheduler({
    maxOperationsPerPass,
    listCandidates: () => {
      listCalls += 1;
      if (listCalls <= 2) {
        return candidates({
          bodyCandidates: [...questionCandidates, instruction],
          grantSlots: ['checkpoint'],
        });
      }
      return candidates({
        state: 'degraded',
        bodyCandidates: [instruction],
      });
    },
    reclaimCandidate: async (candidate) => {
      invoked.push(candidate.kind === 'question-period' ? candidate.periodId : candidate.deliveryAttemptId);
      return { status: candidate.kind === 'question-period' ? 'skipped' : 'complete' };
    },
    releaseGrants: async () => {
      invoked.push('grant');
      return { status: 'released' };
    },
  });

  scheduler.start();
  await timers.fire(timers.next());

  assert.equal(listCalls, 1 + maxOperationsPerPass);
  assert.deepEqual(invoked, ['retired-00000', 'instruction-1']);
  assert.equal(scheduler.status().lastPassOperationCount, 2);
  assert.equal(scheduler.status().failureCount, 0);
  assert.equal(timers.next().delay, 25);
  scheduler.stop();
});

test('stale candidates are rechecked within budget and cursor reaches later work across passes', async () => {
  const maxOperationsPerPass = 2;
  const questionCandidates = Array.from({ length: 200 }, (_, index) => ({
    kind: 'question-period',
    identity: IDENTITY,
    periodId: `retired-${String(index).padStart(3, '0')}`,
  }));
  const instruction = { kind: 'instruction', deliveryAttemptId: 'instruction-1' };
  const initial = candidates({ bodyCandidates: [...questionCandidates, instruction] });
  const stalePassCount = Math.ceil(questionCandidates.length / 2);
  const instructionCandidateReadCall = stalePassCount * 3 + 2;
  const invoked = [];
  let listCalls = 0;
  const { scheduler, timers } = createScheduler({
    maxOperationsPerPass,
    listCandidates: () => {
      listCalls += 1;
      if (listCalls === instructionCandidateReadCall) return candidates({ bodyCandidates: [instruction] });
      return (listCalls - 1) % 3 === 0 ? initial : candidates();
    },
    reclaimCandidate: async (candidate) => {
      invoked.push(candidate.deliveryAttemptId || candidate.periodId);
      return { status: 'complete' };
    },
  });
  scheduler.start();

  for (let pass = 0; pass < stalePassCount; pass += 1) {
    const readsBeforePass = listCalls;
    await timers.fire(timers.next());
    assert.equal(listCalls - readsBeforePass, 1 + maxOperationsPerPass);
    assert.equal(scheduler.status().lastPassOperationCount, 0);
  }

  const readsBeforeProgressPass = listCalls;
  await timers.fire(timers.next());
  assert.equal(listCalls - readsBeforeProgressPass, 1 + maxOperationsPerPass);
  assert.deepEqual(invoked, ['instruction-1']);
  assert.equal(scheduler.status().lastPassOperationCount, 1);
  scheduler.stop();
});

test('unavailable candidate state stops without starting a reclamation operation', async () => {
  let operations = 0;
  const { scheduler, timers } = createScheduler({
    listCandidates: () => candidates({ state: 'unavailable' }),
    reclaimCandidate: async () => { operations += 1; return { status: 'complete' }; },
    releaseGrants: async () => { operations += 1; return { status: 'released' }; },
  });
  scheduler.start();
  await timers.fire(timers.next());
  assert.equal(operations, 0);
  assert.equal(scheduler.status().state, 'stopped');
  assert.equal(scheduler.status().stopReason, 'unavailable');
  assert.equal(scheduler.status().failureCount, 0);
  assert.equal(timers.next(), null);
});

test('operation callback rejection stops even in degraded state and preserves diagnostics', async () => {
  const failure = Object.assign(new Error('unrecognized rejection'), { code: 'EPERM' });
  const { scheduler, timers } = createScheduler({
    listCandidates: () => candidates({
      state: 'degraded',
      bodyCandidates: [{ kind: 'instruction', deliveryAttemptId: 'instruction-1' }],
    }),
    reclaimCandidate: async () => { throw failure; },
  });
  scheduler.start();
  await assert.doesNotReject(timers.fire(timers.next()));
  assert.equal(scheduler.status().state, 'stopped');
  assert.equal(scheduler.status().stopReason, 'failure');
  assert.equal(scheduler.status().failureCount, 1);
  assert.equal(scheduler.status().lastFailureCode, 'EPERM');
  assert.equal(timers.next(), null);
});

test('stop prevents later operations and drain settles an in-flight rejection as close work', async () => {
  const pendingCall = deferred();
  const invoked = [];
  const { scheduler, timers } = createScheduler({
    maxOperationsPerPass: 5,
    listCandidates: () => candidates({
      bodyCandidates: [
        { kind: 'instruction', deliveryAttemptId: 'instruction-1' },
        { kind: 'terminal-delivery', deliveryAttemptId: 'terminal-1' },
      ],
    }),
    reclaimCandidate: (candidate) => { invoked.push(candidate.deliveryAttemptId); return pendingCall.promise; },
  });
  scheduler.start();
  const pass = timers.fire(timers.next());
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(invoked, ['instruction-1']);

  scheduler.stop();
  const drained = scheduler.drain();
  pendingCall.reject(new Error('context closed during operation'));
  await Promise.all([pass, drained]);
  assert.deepEqual(invoked, ['instruction-1']);
  assert.equal(scheduler.status().failureCount, 0);
  assert.equal(timers.next(), null);
});

test('candidate reads, timer setup, invalid results, and unknown statuses stop with no unhandled rejection', async (t) => {
  await t.test('candidate read rejection', async () => {
    const { scheduler, timers } = createScheduler({
      listCandidates: () => { throw new Error('candidate read failed'); },
    });
    scheduler.start();
    await assert.doesNotReject(timers.fire(timers.next()));
    assert.equal(scheduler.status().stopReason, 'failure');
    assert.equal(scheduler.status().failureCount, 1);
    assert.equal(timers.next(), null);
  });

  await t.test('timer setup rejection', () => {
    const scheduler = createReclamationScheduler({
      listCandidates: () => candidates(),
      reclaimCandidate: async () => ({ status: 'complete' }),
      releaseGrants: async () => ({ status: 'released' }),
      intervalMs: 25,
      maxOperationsPerPass: 1,
      setTimeoutImpl() { throw Object.assign(new Error('timer failed'), { code: 'timer_setup_failed' }); },
      clearTimeoutImpl() {},
    });
    assert.throws(() => scheduler.start(), (error) => error.code === 'timer_setup_failed');
    assert.equal(scheduler.status().lastFailureCode, 'timer_setup_failed');
    assert.equal(scheduler.status().stopReason, 'failure');
  });

  await t.test('timer unref rejection clears the created timer', () => {
    const timers = createFakeTimers();
    const scheduler = createReclamationScheduler({
      listCandidates: () => candidates(),
      reclaimCandidate: async () => ({ status: 'complete' }),
      releaseGrants: async () => ({ status: 'released' }),
      intervalMs: 25,
      maxOperationsPerPass: 1,
      setTimeoutImpl: (callback, delay) => {
        const handle = timers.setTimeoutImpl(callback, delay);
        return { record: handle.record, unref() { throw new Error('unref failed'); } };
      },
      clearTimeoutImpl: timers.clearTimeoutImpl,
    });
    assert.throws(() => scheduler.start(), /unref failed/);
    assert.equal(timers.records[0].cancelled, true);
    assert.equal(scheduler.status().lastFailureCode, 'reclamation_scheduler_failed');
  });

  await t.test('invalid callback result status', async () => {
    let getterCalls = 0;
    const result = {};
    Object.defineProperty(result, 'status', {
      enumerable: true,
      get() { getterCalls += 1; return 'complete'; },
    });
    const { scheduler, timers } = createScheduler({
      listCandidates: () => candidates({ bodyCandidates: [{ kind: 'instruction', deliveryAttemptId: 'instruction-1' }] }),
      reclaimCandidate: async () => result,
    });
    scheduler.start();
    await assert.doesNotReject(timers.fire(timers.next()));
    assert.equal(getterCalls, 0);
    assert.equal(scheduler.status().stopReason, 'failure');
    assert.equal(scheduler.status().lastFailureCode, 'invalid_reclamation_scheduler_result');
  });

  await t.test('callback result rejects fields outside its status record', async () => {
    const { scheduler, timers } = createScheduler({
      listCandidates: () => candidates({
        bodyCandidates: [{ kind: 'instruction', deliveryAttemptId: 'instruction-1' }],
      }),
      reclaimCandidate: async () => ({ status: 'complete', detail: 'unexpected' }),
    });
    scheduler.start();
    await assert.doesNotReject(timers.fire(timers.next()));
    assert.equal(scheduler.status().lastFailureCode, 'invalid_reclamation_scheduler_result');
    assert.equal(scheduler.status().failureCount, 1);
  });

  await t.test('malformed candidates are rejected without executing accessors', async () => {
    let getterCalls = 0;
    const snapshot = candidates();
    Object.defineProperty(snapshot, 'state', {
      enumerable: true,
      get() { getterCalls += 1; return 'ready'; },
    });
    const { scheduler, timers } = createScheduler({ listCandidates: () => snapshot });
    scheduler.start();
    await assert.doesNotReject(timers.fire(timers.next()));
    assert.equal(getterCalls, 0);
    assert.equal(scheduler.status().lastFailureCode, 'invalid_reclamation_scheduler_candidates');
  });

  await t.test('async candidate listing is rejected and its rejection is observed', async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const { scheduler, timers } = createScheduler({
        listCandidates: () => Promise.reject(new Error('async candidate read failed')),
      });
      scheduler.start();
      await assert.doesNotReject(timers.fire(timers.next()));
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(scheduler.status().stopReason, 'failure');
      assert.equal(scheduler.status().lastFailureCode, 'invalid_reclamation_scheduler_candidates');
      assert.deepEqual(unhandled, []);
      assert.equal(timers.next(), null);
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }
  });

  await t.test('non-string candidate kind is rejected without coercion', async () => {
    let coercionCalls = 0;
    const kind = {
      [Symbol.toPrimitive]() { coercionCalls += 1; return 'instruction'; },
    };
    const { scheduler, timers } = createScheduler({
      listCandidates: () => candidates({
        bodyCandidates: [{ kind, deliveryAttemptId: 'attempt-1' }],
      }),
    });
    scheduler.start();
    await assert.doesNotReject(timers.fire(timers.next()));
    assert.equal(coercionCalls, 0);
    assert.equal(scheduler.status().lastFailureCode, 'invalid_reclamation_scheduler_candidates');
  });
});
