'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createStopEnsureResultStore } = require('../src/server/stop-ensure-result-store');
const { createStopEnsureShutdownCoordinator } = require('../src/server/stop-ensure-shutdown-coordinator');

const INSTANCE_ID = 'a5f9b3c1-6d72-4f80-9b31-2c6d8e4f7012';
const OTHER_INSTANCE_ID = 'b6a0c4d2-7e83-4f91-8c42-3d7e9f5a8123';
const REQUEST_ID = 'c7b1d5e3-8f94-4ba2-9d53-4e8f0a6b9234';
const OTHER_REQUEST_ID = 'd8c2e6f4-9a05-4cb3-8e64-5f901b7ca345';
const WRITE_DIAGNOSTIC = 'record_write_failed';

function request(expectedInstanceId = INSTANCE_ID, requestId = REQUEST_ID) {
  return { expectedInstanceId, requestId };
}

function makeCoordinator({
  instanceId = INSTANCE_ID,
  runShutdownProcedure = () => undefined,
  writeResult = () => ({ status: 'written' }),
} = {}) {
  const resultStore = Object.freeze({ writeResult });
  return {
    coordinator: createStopEnsureShutdownCoordinator({
      instanceId,
      runShutdownProcedure,
      resultStore,
    }),
    resultStore,
  };
}

function assertTypeError(error, code) {
  return error instanceof TypeError && error.message === code;
}

function assertOwnedTempDirectory(directory) {
  const temporaryRoot = path.resolve(os.tmpdir());
  const resolvedDirectory = path.resolve(directory);
  assert.equal(resolvedDirectory, directory);
  const relative = path.relative(temporaryRoot, resolvedDirectory);
  assert.notEqual(relative, '');
  assert.notEqual(relative, '..');
  assert.equal(relative.startsWith(`..${path.sep}`), false);
  assert.equal(path.isAbsolute(relative), false);
}

async function makeRealStoreFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'stop-ensure-shutdown-coordinator-'));
  assertOwnedTempDirectory(root);
  t.after(async () => {
    assertOwnedTempDirectory(root);
    const [resolvedRoot, resolvedTemp] = await Promise.all([fs.realpath(root), fs.realpath(os.tmpdir())]);
    const relative = path.relative(resolvedTemp, resolvedRoot);
    assert.notEqual(relative, '');
    assert.notEqual(relative, '..');
    assert.equal(relative.startsWith(`..${path.sep}`), false);
    await fs.rm(root, { recursive: true, force: false });
  });
  const store = createStopEnsureResultStore({ controlDirectory: root });
  return { root, store };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => {
    resolve = accept;
    reject = fail;
  });
  return { promise, resolve, reject };
}

test('factory rejects unsafe shapes before callbacks or store access', () => {
  let procedureCalls = 0;
  let getterCalls = 0;
  let proxyTraps = 0;
  const resultStore = { writeResult() { throw new Error('must not run'); } };

  assert.throws(() => createStopEnsureShutdownCoordinator({
    instanceId: INSTANCE_ID,
    runShutdownProcedure() { procedureCalls += 1; },
    resultStore,
    extra: true,
  }), (error) => assertTypeError(error, 'invalid_stop_ensure_shutdown_options'));

  const accessorOptions = { instanceId: INSTANCE_ID, runShutdownProcedure() {}, resultStore };
  Object.defineProperty(accessorOptions, 'extra', {
    enumerable: true,
    get() { getterCalls += 1; return true; },
  });
  assert.throws(() => createStopEnsureShutdownCoordinator(accessorOptions),
    (error) => assertTypeError(error, 'invalid_stop_ensure_shutdown_options'));

  const proxyOptions = new Proxy({ instanceId: INSTANCE_ID, runShutdownProcedure() {}, resultStore }, {
    get() { proxyTraps += 1; throw new Error('proxy trap'); },
    ownKeys() { proxyTraps += 1; throw new Error('proxy trap'); },
  });
  assert.throws(() => createStopEnsureShutdownCoordinator(proxyOptions),
    (error) => assertTypeError(error, 'invalid_stop_ensure_shutdown_options'));

  const getterStore = {};
  Object.defineProperty(getterStore, 'writeResult', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('store getter'); },
  });
  assert.throws(() => createStopEnsureShutdownCoordinator({
    instanceId: INSTANCE_ID,
    runShutdownProcedure() {},
    resultStore: getterStore,
  }), (error) => assertTypeError(error, 'invalid_stop_ensure_shutdown_options'));

  assert.equal(procedureCalls, 0);
  assert.equal(getterCalls, 0);
  assert.equal(proxyTraps, 0);
});

test('factory rejects accessors for each required option and a proxied result store without side effects', () => {
  const requiredKeys = ['instanceId', 'runShutdownProcedure', 'resultStore'];
  let getterCalls = 0;
  for (const key of requiredKeys) {
    const options = {
      instanceId: INSTANCE_ID,
      runShutdownProcedure() {},
      resultStore: { writeResult() { return { status: 'written' }; } },
    };
    const value = options[key];
    Object.defineProperty(options, key, {
      configurable: true,
      enumerable: true,
      get() { getterCalls += 1; return value; },
    });
    assert.throws(() => createStopEnsureShutdownCoordinator(options),
      (error) => assertTypeError(error, 'invalid_stop_ensure_shutdown_options'));
  }
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const resultStore = new Proxy({ writeResult() { return { status: 'written' }; } }, {
    get() { proxyTraps += 1; throw new Error('store proxy trap'); },
    ownKeys() { proxyTraps += 1; throw new Error('store proxy trap'); },
    getOwnPropertyDescriptor() { proxyTraps += 1; throw new Error('store proxy trap'); },
  });
  assert.throws(() => createStopEnsureShutdownCoordinator({
    instanceId: INSTANCE_ID,
    runShutdownProcedure() {},
    resultStore,
  }), (error) => assertTypeError(error, 'invalid_stop_ensure_shutdown_options'));
  assert.equal(proxyTraps, 0);
});

test('constructor instance UUID is validated through the codec on first request', () => {
  let procedureCalls = 0;
  let notificationCalls = 0;
  const { coordinator } = makeCoordinator({
    instanceId: 'not-a-uuid',
    runShutdownProcedure() { procedureCalls += 1; },
    writeResult() { notificationCalls += 1; return { status: 'written' }; },
  });

  assert.throws(() => coordinator.requestShutdown(request()),
    (error) => assertTypeError(error, 'invalid_stop_ensure_shutdown_request'));
  assert.deepEqual(coordinator.getSnapshot(), { status: 'idle' });
  assert.equal(procedureCalls, 0);
  assert.equal(notificationCalls, 0);
});

test('request rejects unsafe shapes and malformed IDs without callback side effects', () => {
  let procedureCalls = 0;
  let notificationCalls = 0;
  let getterCalls = 0;
  let proxyTraps = 0;
  const { coordinator } = makeCoordinator({
    runShutdownProcedure() { procedureCalls += 1; },
    writeResult() { notificationCalls += 1; return { status: 'written' }; },
  });

  const extra = { ...request(), extra: true };
  const accessor = request();
  Object.defineProperty(accessor, 'requestId', {
    enumerable: true,
    get() { getterCalls += 1; return REQUEST_ID; },
  });
  const proxy = new Proxy(request(), {
    get() { proxyTraps += 1; throw new Error('request proxy trap'); },
    ownKeys() { proxyTraps += 1; throw new Error('request proxy trap'); },
  });
  const symbolKey = { ...request(), [Symbol('extra')]: true };
  const nonEnumerable = request();
  Object.defineProperty(nonEnumerable, 'hidden', { value: true });
  const invalidIds = [request('not-a-uuid'), request(INSTANCE_ID, 'not-a-uuid')];

  for (const input of [extra, accessor, proxy, symbolKey, nonEnumerable, ...invalidIds]) {
    assert.throws(() => coordinator.requestShutdown(input),
      (error) => assertTypeError(error, 'invalid_stop_ensure_shutdown_request'));
  }

  assert.deepEqual(coordinator.getSnapshot(), { status: 'idle' });
  assert.equal(procedureCalls, 0);
  assert.equal(notificationCalls, 0);
  assert.equal(getterCalls, 0);
  assert.equal(proxyTraps, 0);
});

test('old instance and different request are rejected synchronously before side effects', () => {
  let procedureCalls = 0;
  let notificationCalls = 0;
  const waiting = deferred();
  const { coordinator } = makeCoordinator({
    runShutdownProcedure() { procedureCalls += 1; return waiting.promise; },
    writeResult() { notificationCalls += 1; return { status: 'written' }; },
  });

  assert.throws(() => coordinator.requestShutdown(request(OTHER_INSTANCE_ID)),
    (error) => assertTypeError(error, 'stop_ensure_instance_mismatch'));
  const completion = coordinator.requestShutdown(request());
  assert.throws(() => coordinator.requestShutdown(request(INSTANCE_ID, OTHER_REQUEST_ID)),
    (error) => assertTypeError(error, 'stop_ensure_shutdown_conflict'));
  assert.equal(coordinator.getSnapshot().status, 'running');
  assert.equal(procedureCalls, 1);
  assert.equal(notificationCalls, 0);

  waiting.resolve();
  return completion;
});

test('same request shares its deferred promise across synchronous reentry and settlement', async () => {
  const waiting = deferred();
  let coordinator;
  let reenteredPromise;
  let procedureCalls = 0;
  let notificationCalls = 0;
  const resultStore = Object.freeze({
    writeResult() {
      notificationCalls += 1;
      assert.equal(coordinator.requestShutdown(request()), reenteredPromise);
      return { status: 'written' };
    },
  });
  coordinator = createStopEnsureShutdownCoordinator({
    instanceId: INSTANCE_ID,
    runShutdownProcedure() {
      procedureCalls += 1;
      reenteredPromise = coordinator.requestShutdown(request());
      return waiting.promise;
    },
    resultStore,
  });

  const completion = coordinator.requestShutdown(request());
  assert.equal(reenteredPromise, completion);
  assert.equal(coordinator.requestShutdown(request()), completion);
  assert.deepEqual(coordinator.getSnapshot(), { status: 'running' });
  waiting.resolve();
  const result = await completion;
  assert.equal(coordinator.requestShutdown(request()), completion);
  assert.deepEqual(result.procedure, { status: 'completed', failed: false, reason: null });
  assert.deepEqual(result.notification, { status: 'written' });
  assert.equal(procedureCalls, 1);
  assert.equal(notificationCalls, 1);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.procedure), true);
  assert.equal(Object.isFrozen(result.notification), true);
  assert.deepEqual(Object.keys(coordinator), ['requestShutdown', 'getSnapshot']);
  assert.equal(Object.isFrozen(coordinator), true);
  assert.deepEqual(coordinator.getSnapshot(), { status: 'settled' });
});

test('captured store writer keeps its receiver and ignores later method replacement', async () => {
  let originalCalls = 0;
  let replacementCalls = 0;
  let observedReceiver;
  let observedRecord;
  const resultStore = {
    writeResult(record) {
      originalCalls += 1;
      observedReceiver = this;
      observedRecord = record;
      return { status: 'written' };
    },
  };
  const coordinator = createStopEnsureShutdownCoordinator({
    instanceId: INSTANCE_ID,
    runShutdownProcedure: () => undefined,
    resultStore,
  });
  resultStore.writeResult = () => { replacementCalls += 1; return { status: 'written' }; };

  const completion = await coordinator.requestShutdown(request());
  assert.equal(observedReceiver, resultStore);
  assert.equal(Object.isFrozen(observedRecord), true);
  assert.equal(observedRecord.version, 1);
  assert.equal(observedRecord.kind, 'shutdown');
  assert.equal(observedRecord.instanceId, INSTANCE_ID);
  assert.equal(observedRecord.requestId, REQUEST_ID);
  assert.equal(observedRecord.status, 'completed');
  assert.equal(observedRecord.reasonCode, null);
  assert.deepEqual(completion.notification, { status: 'written' });
  assert.equal(originalCalls, 1);
  assert.equal(replacementCalls, 0);
});

const falsyReasons = [undefined, null, false, 0, ''];
for (const [reasonIndex, reason] of falsyReasons.entries()) {
  test(`sync throw preserves falsy reason ${reasonIndex} while recording a failed procedure`, async () => {
    let record;
    const { coordinator } = makeCoordinator({
      runShutdownProcedure() { throw reason; },
      writeResult(value) {
        record = value;
        return { status: 'unknown', diagnostic: WRITE_DIAGNOSTIC, cleanupFailed: false };
      },
    });

    const result = await coordinator.requestShutdown(request());
    assert.equal(result.procedure.status, 'failed');
    assert.equal(result.procedure.failed, true);
    assert.equal(result.procedure.reason, reason);
    assert.deepEqual(result.notification, {
      status: 'unknown', diagnostic: WRITE_DIAGNOSTIC, cleanupFailed: false,
    });
    assert.deepEqual(record, {
      version: 1,
      kind: 'shutdown',
      instanceId: INSTANCE_ID,
      requestId: REQUEST_ID,
      status: 'failed',
      reasonCode: 'shutdown_incomplete',
    });
    assert.equal(Object.hasOwn(record, 'reason'), false);
  });

  test(`async rejection preserves falsy reason ${reasonIndex} while notification stays independent`, async () => {
    let record;
    const { coordinator } = makeCoordinator({
      runShutdownProcedure() { return Promise.reject(reason); },
      writeResult(value) {
        record = value;
        return Promise.resolve({ status: 'unknown', diagnostic: 'record_exists', cleanupFailed: true });
      },
    });

    const result = await coordinator.requestShutdown(request());
    assert.equal(result.procedure.status, 'failed');
    assert.equal(result.procedure.failed, true);
    assert.equal(result.procedure.reason, reason);
    assert.deepEqual(result.notification, {
      status: 'unknown', diagnostic: 'record_exists', cleanupFailed: true,
    });
    assert.equal(record.status, 'failed');
    assert.equal(record.reasonCode, 'shutdown_incomplete');
    assert.equal(Object.hasOwn(record, 'reason'), false);
  });
}

test('procedure success returns completed record even when its return value is falsy', async () => {
  let record;
  const { coordinator } = makeCoordinator({
    runShutdownProcedure: () => false,
    writeResult(value) { record = value; return { status: 'written' }; },
  });

  const result = await coordinator.requestShutdown(request());
  assert.deepEqual(result.procedure, { status: 'completed', failed: false, reason: null });
  assert.equal(record.status, 'completed');
  assert.equal(record.reasonCode, null);
});

test('procedure and notification outcomes remain independent in all four combinations', async (t) => {
  const cases = [
    { failed: false, notification: { status: 'written' } },
    { failed: false, notification: { status: 'unknown', diagnostic: 'record_exists', cleanupFailed: false } },
    { failed: true, notification: { status: 'written' } },
    { failed: true, notification: { status: 'unknown', diagnostic: 'record_write_failed', cleanupFailed: true } },
  ];

  for (const [index, scenario] of cases.entries()) {
    await t.test(`case ${index + 1}`, async () => {
      const reason = scenario.failed ? false : undefined;
      let record;
      const { coordinator } = makeCoordinator({
        runShutdownProcedure() {
          if (scenario.failed) throw reason;
          return undefined;
        },
        writeResult(value) { record = value; return scenario.notification; },
      });

      const result = await coordinator.requestShutdown(request());
      assert.equal(result.procedure.status, scenario.failed ? 'failed' : 'completed');
      assert.equal(result.procedure.failed, scenario.failed);
      assert.equal(result.procedure.reason, scenario.failed ? reason : null);
      assert.deepEqual(result.notification, scenario.notification);
      assert.equal(record.status, scenario.failed ? 'failed' : 'completed');
    });
  }
});

test('store notification rejects untrusted direct shapes without evaluating getters or thenables', async () => {
  let getterCalls = 0;
  let proxyTraps = 0;
  const accessorResult = { status: 'written' };
  Object.defineProperty(accessorResult, 'diagnostic', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('notification getter'); },
  });
  const thenableResult = { status: 'written' };
  Object.defineProperty(thenableResult, 'then', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('then getter'); },
  });
  const proxyResult = new Proxy({ status: 'written' }, {
    get() { proxyTraps += 1; throw new Error('notification proxy'); },
    ownKeys() { proxyTraps += 1; throw new Error('notification proxy'); },
  });
  const invalidResults = [
    accessorResult,
    Promise.resolve(accessorResult),
    thenableResult,
    proxyResult,
    { status: 'unknown', diagnostic: 'arbitrary message', cleanupFailed: false },
    { status: 'unknown', diagnostic: 'record_exists', cleanupFailed: 0 },
    { status: 'written', extra: true },
    Object.create({ status: 'written' }),
  ];

  for (const invalidResult of invalidResults) {
    const { coordinator } = makeCoordinator({ writeResult: () => invalidResult });
    const result = await coordinator.requestShutdown(request());
    assert.deepEqual(result.notification, {
      status: 'unknown', diagnostic: 'notification_unconfirmed', cleanupFailed: null,
    });
  }
  assert.equal(getterCalls, 0);
  assert.equal(proxyTraps, 0);
});

test('native store promise settlement bypasses an own then accessor and validates its result', async () => {
  let thenGetterCalls = 0;
  const storePromise = Promise.resolve({ status: 'written' });
  Object.defineProperty(storePromise, 'then', {
    configurable: true,
    get() { thenGetterCalls += 1; throw new Error('own then getter'); },
  });
  const { coordinator } = makeCoordinator({ writeResult: () => storePromise });

  const result = await coordinator.requestShutdown(request());
  assert.deepEqual(result.notification, { status: 'written' });
  assert.equal(thenGetterCalls, 0);
});

test('store unknown accepts only its fixed write diagnostics and a boolean cleanup state', async () => {
  const diagnostics = [
    'directory_unavailable',
    'record_exists',
    'record_open_unknown',
    'record_write_failed',
    'record_close_unknown',
    'record_rename_unknown',
    'record_io_failed',
  ];

  for (const diagnostic of diagnostics) {
    const { coordinator } = makeCoordinator({
      writeResult: () => ({ status: 'unknown', diagnostic, cleanupFailed: false }),
    });
    const result = await coordinator.requestShutdown(request());
    assert.deepEqual(result.notification, { status: 'unknown', diagnostic, cleanupFailed: false });
  }
});

test('unknown notification is terminal and same request does not rerun either callback', async () => {
  let procedureCalls = 0;
  let notificationCalls = 0;
  const { coordinator } = makeCoordinator({
    runShutdownProcedure() { procedureCalls += 1; },
    writeResult() {
      notificationCalls += 1;
      return { status: 'unknown', diagnostic: 'record_close_unknown', cleanupFailed: true };
    },
  });

  const completion = coordinator.requestShutdown(request());
  assert.equal(coordinator.requestShutdown(request()), completion);
  const result = await completion;
  assert.equal(coordinator.requestShutdown(request()), completion);
  assert.deepEqual(result.notification, {
    status: 'unknown', diagnostic: 'record_close_unknown', cleanupFailed: true,
  });
  assert.equal(procedureCalls, 1);
  assert.equal(notificationCalls, 1);
});

test('store rejection or throw maps to unconfirmed without replacing procedure failure', async (t) => {
  const secretReason = new Error('must not escape notification');
  const writers = [
    () => { throw secretReason; },
    () => Promise.reject(secretReason),
    () => Promise.resolve({ status: 'unknown', diagnostic: 'other', cleanupFailed: false }),
  ];

  for (const [index, writeResult] of writers.entries()) {
    await t.test(`notification failure ${index + 1}`, async () => {
      const procedureReason = false;
      const { coordinator } = makeCoordinator({
        runShutdownProcedure() { throw procedureReason; },
        writeResult,
      });
      const result = await coordinator.requestShutdown(request());
      assert.equal(result.procedure.reason, procedureReason);
      assert.equal(result.procedure.failed, true);
      assert.deepEqual(result.notification, {
        status: 'unknown', diagnostic: 'notification_unconfirmed', cleanupFailed: null,
      });
      assert.equal(JSON.stringify(result).includes(secretReason.message), false);
    });
  }
});

test('direct notification self-promise and direct procedure self-promise do not deadlock', async (t) => {
  await t.test('procedure directly returns its own completion', async () => {
    let coordinator;
    let record;
    coordinator = createStopEnsureShutdownCoordinator({
      instanceId: INSTANCE_ID,
      runShutdownProcedure() { return coordinator.requestShutdown(request()); },
      resultStore: { writeResult(value) { record = value; return { status: 'written' }; } },
    });

    const result = await coordinator.requestShutdown(request());
    assert.equal(result.procedure.status, 'failed');
    assert.equal(result.procedure.reason.message, 'stop_ensure_shutdown_self_wait');
    assert.equal(record.status, 'failed');
    assert.equal(record.reasonCode, 'shutdown_incomplete');
  });

  await t.test('store directly returns its own completion', async () => {
    let coordinator;
    let completion;
    let writeCalls = 0;
    coordinator = createStopEnsureShutdownCoordinator({
      instanceId: INSTANCE_ID,
      runShutdownProcedure: () => undefined,
      resultStore: {
        writeResult() { writeCalls += 1; return completion; },
      },
    });
    completion = coordinator.requestShutdown(request());
    const result = await completion;
    assert.deepEqual(result.procedure, { status: 'completed', failed: false, reason: null });
    assert.deepEqual(result.notification, {
      status: 'unknown', diagnostic: 'notification_unconfirmed', cleanupFailed: null,
    });
    assert.equal(writeCalls, 1);
  });
});

test('indirect procedure self-wait remains pending without success or notification', async () => {
  let coordinator;
  let notificationCalls = 0;
  coordinator = createStopEnsureShutdownCoordinator({
    instanceId: INSTANCE_ID,
    runShutdownProcedure: async () => {
      await coordinator.requestShutdown(request());
    },
    resultStore: {
      writeResult() { notificationCalls += 1; return { status: 'written' }; },
    },
  });

  const completion = coordinator.requestShutdown(request());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(coordinator.getSnapshot(), { status: 'running' });
  assert.equal(notificationCalls, 0);
  assert.equal(completion instanceof Promise, true);
});

test('indirect notification self-wait remains notifying and is never retried', async () => {
  let coordinator;
  let completion;
  let writeCalls = 0;
  coordinator = createStopEnsureShutdownCoordinator({
    instanceId: INSTANCE_ID,
    runShutdownProcedure: () => undefined,
    resultStore: {
      async writeResult() {
        writeCalls += 1;
        await coordinator.requestShutdown(request());
        return { status: 'written' };
      },
    },
  });

  completion = coordinator.requestShutdown(request());
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(coordinator.getSnapshot(), { status: 'notifying' });
  assert.equal(writeCalls, 1);
  assert.equal(completion instanceof Promise, true);
});

test('codec and real result store preserve the terminal procedure record', async (t) => {
  const { store } = await makeRealStoreFixture(t);
  const { coordinator } = makeCoordinator({
    writeResult: store.writeResult,
  });

  const result = await coordinator.requestShutdown(request());
  assert.deepEqual(result, {
    procedure: { status: 'completed', failed: false, reason: null },
    notification: { status: 'written' },
  });

  const ids = { kind: 'shutdown', instanceId: INSTANCE_ID, requestId: REQUEST_ID };
  const read = await store.readResult(ids);
  assert.equal(read.status, 'valid');
  assert.equal(read.record.status, 'completed');
  assert.equal(read.record.reasonCode, null);
  assert.equal(Object.getPrototypeOf(read.record), null);
  assert.equal(Object.isFrozen(read.record), true);
  assert.equal(Object.hasOwn(read.record, 'reason'), false);
});
