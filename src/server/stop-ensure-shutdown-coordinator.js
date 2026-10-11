'use strict';

const { types } = require('node:util');
const { normalizeStopEnsureExpectedIds } = require('./stop-ensure-record-codec');

const OPTIONS_ERROR = 'invalid_stop_ensure_shutdown_options';
const REQUEST_ERROR = 'invalid_stop_ensure_shutdown_request';
const INSTANCE_MISMATCH_ERROR = 'stop_ensure_instance_mismatch';
const REQUEST_CONFLICT_ERROR = 'stop_ensure_shutdown_conflict';
const SELF_WAIT_ERROR = 'stop_ensure_shutdown_self_wait';
const NOTIFICATION_UNCONFIRMED = 'notification_unconfirmed';
const WRITE_DIAGNOSTICS = new Set([
  'directory_unavailable',
  'record_exists',
  'record_open_unknown',
  'record_write_failed',
  'record_close_unknown',
  'record_rename_unknown',
  'record_io_failed',
]);
const PROMISE_PROTOTYPE = Promise.prototype;
const PROMISE_THEN = Promise.prototype.then;

function fixedTypeError(message) {
  return new TypeError(message);
}

function capturePlainData(value, allowedKeys, requiredKeys, errorMessage) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) {
    throw fixedTypeError(errorMessage);
  }

  let prototype;
  let ownKeys;
  try {
    prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw fixedTypeError(errorMessage);
    ownKeys = Reflect.ownKeys(value);
  } catch {
    throw fixedTypeError(errorMessage);
  }

  if (ownKeys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key)) ||
      requiredKeys.some((key) => !ownKeys.includes(key))) {
    throw fixedTypeError(errorMessage);
  }

  const captured = Object.create(null);
  try {
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
        throw fixedTypeError(errorMessage);
      }
      Object.defineProperty(captured, key, {
        value: descriptor.value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
  } catch {
    throw fixedTypeError(errorMessage);
  }
  return Object.freeze(captured);
}

function captureStoreWriter(resultStore) {
  if (resultStore === null || typeof resultStore !== 'object' || types.isProxy(resultStore)) {
    throw fixedTypeError(OPTIONS_ERROR);
  }

  let descriptor;
  try {
    descriptor = Object.getOwnPropertyDescriptor(resultStore, 'writeResult');
  } catch {
    throw fixedTypeError(OPTIONS_ERROR);
  }
  if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value') ||
      typeof descriptor.value !== 'function') {
    throw fixedTypeError(OPTIONS_ERROR);
  }
  return descriptor.value;
}

function normalizeRequestIds(expectedInstanceId, requestId) {
  try {
    return normalizeStopEnsureExpectedIds({
      kind: 'shutdown',
      instanceId: expectedInstanceId,
      requestId,
    });
  } catch {
    throw fixedTypeError(REQUEST_ERROR);
  }
}

function normalizeConstructorIds(instanceId, requestId) {
  try {
    return normalizeStopEnsureExpectedIds({
      kind: 'shutdown',
      instanceId,
      requestId,
    });
  } catch {
    throw fixedTypeError(REQUEST_ERROR);
  }
}

function captureNotification(result) {
  if (result === null || typeof result !== 'object' || types.isProxy(result)) return null;

  let prototype;
  let ownKeys;
  try {
    prototype = Object.getPrototypeOf(result);
    if (prototype !== Object.prototype && prototype !== null) return null;
    ownKeys = Reflect.ownKeys(result);
  } catch {
    return null;
  }

  const isWritten = ownKeys.length === 1 && ownKeys[0] === 'status';
  const isUnknown = ownKeys.length === 3 &&
    ownKeys.every((key) => typeof key === 'string' && ['status', 'diagnostic', 'cleanupFailed'].includes(key));
  if (!isWritten && !isUnknown) return null;

  const values = Object.create(null);
  try {
    for (const key of ownKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(result, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
      Object.defineProperty(values, key, {
        value: descriptor.value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
  } catch {
    return null;
  }

  if (values.status === 'written' && isWritten) {
    return Object.freeze({ status: 'written' });
  }
  if (values.status === 'unknown' && isUnknown &&
      WRITE_DIAGNOSTICS.has(values.diagnostic) && typeof values.cleanupFailed === 'boolean') {
    return Object.freeze({
      status: 'unknown',
      diagnostic: values.diagnostic,
      cleanupFailed: values.cleanupFailed,
    });
  }
  return null;
}

function isTrustedNativePromise(value) {
  if (value === null || typeof value !== 'object' || types.isProxy(value) || !types.isPromise(value)) {
    return false;
  }
  try {
    return Object.getPrototypeOf(value) === PROMISE_PROTOTYPE;
  } catch {
    return false;
  }
}

function unconfirmedNotification() {
  return Object.freeze({
    status: 'unknown',
    diagnostic: NOTIFICATION_UNCONFIRMED,
    cleanupFailed: null,
  });
}

function freezeCompletion(procedure, notification) {
  return Object.freeze({
    procedure: Object.freeze(procedure),
    notification: Object.freeze(notification),
  });
}

function createStopEnsureShutdownCoordinator(options) {
  const capturedOptions = capturePlainData(
    options,
    ['instanceId', 'runShutdownProcedure', 'resultStore'],
    ['instanceId', 'runShutdownProcedure', 'resultStore'],
    OPTIONS_ERROR,
  );
  const instanceId = capturedOptions.instanceId;
  const runShutdownProcedure = capturedOptions.runShutdownProcedure;
  const resultStore = capturedOptions.resultStore;
  if (typeof instanceId !== 'string' || typeof runShutdownProcedure !== 'function') {
    throw fixedTypeError(OPTIONS_ERROR);
  }
  const writeResult = captureStoreWriter(resultStore);

  let operation = null;
  let snapshotStatus = 'idle';

  function getSnapshot() {
    return Object.freeze({ status: snapshotStatus });
  }

  function finish(currentOperation, procedure, notification) {
    if (operation !== currentOperation || currentOperation.finished) return;
    const completion = freezeCompletion(procedure, notification);
    currentOperation.finished = true;
    snapshotStatus = 'settled';
    currentOperation.resolve(completion);
  }

  function settleNotification(currentOperation, procedure, result, rejected) {
    let notification;
    try {
      notification = rejected
        ? unconfirmedNotification()
        : captureNotification(result) || unconfirmedNotification();
    } catch {
      notification = unconfirmedNotification();
    }

    try {
      finish(currentOperation, procedure, notification);
    } catch {
      try {
        finish(currentOperation, procedure, unconfirmedNotification());
      } catch {
        return;
      }
    }
  }

  function observeNotification(currentOperation, procedure, returned) {
    if (returned === currentOperation.promise) {
      settleNotification(currentOperation, procedure, undefined, true);
      return;
    }

    if (!isTrustedNativePromise(returned)) {
      settleNotification(currentOperation, procedure, returned, false);
      return;
    }

    try {
      PROMISE_THEN.call(
        returned,
        (result) => { settleNotification(currentOperation, procedure, result, false); },
        () => { settleNotification(currentOperation, procedure, undefined, true); },
      );
    } catch {
      settleNotification(currentOperation, procedure, undefined, true);
    }
  }

  function notify(currentOperation, procedure) {
    snapshotStatus = 'notifying';
    const record = Object.freeze({
      version: 1,
      kind: 'shutdown',
      instanceId: currentOperation.ids.instanceId,
      requestId: currentOperation.ids.requestId,
      status: procedure.status,
      reasonCode: procedure.failed ? 'shutdown_incomplete' : null,
    });

    let returned;
    try {
      returned = writeResult.call(resultStore, record);
    } catch {
      settleNotification(currentOperation, procedure, undefined, true);
      return;
    }
    observeNotification(currentOperation, procedure, returned);
  }

  function procedureFailed(currentOperation, reason) {
    notify(currentOperation, Object.freeze({ status: 'failed', failed: true, reason }));
  }

  function procedureCompleted(currentOperation) {
    notify(currentOperation, Object.freeze({ status: 'completed', failed: false, reason: null }));
  }

  function beginShutdown(ids) {
    let resolve;
    const promise = new Promise((accept) => { resolve = accept; });
    const currentOperation = {
      ids,
      promise,
      resolve,
      finished: false,
    };
    operation = currentOperation;
    snapshotStatus = 'running';

    let returned;
    try {
      returned = runShutdownProcedure();
    } catch (reason) {
      procedureFailed(currentOperation, reason);
      return promise;
    }

    if (returned === promise) {
      procedureFailed(currentOperation, fixedTypeError(SELF_WAIT_ERROR));
      return promise;
    }

    Promise.resolve(returned).then(
      () => procedureCompleted(currentOperation),
      (reason) => procedureFailed(currentOperation, reason),
    );
    return promise;
  }

  function requestShutdown(input) {
    const capturedRequest = capturePlainData(
      input,
      ['expectedInstanceId', 'requestId'],
      ['expectedInstanceId', 'requestId'],
      REQUEST_ERROR,
    );
    const requestIds = normalizeRequestIds(capturedRequest.expectedInstanceId, capturedRequest.requestId);
    const constructorIds = normalizeConstructorIds(instanceId, requestIds.requestId);
    if (constructorIds.instanceId !== requestIds.instanceId) {
      throw fixedTypeError(INSTANCE_MISMATCH_ERROR);
    }

    if (operation) {
      if (operation.ids.requestId !== requestIds.requestId) {
        throw fixedTypeError(REQUEST_CONFLICT_ERROR);
      }
      return operation.promise;
    }
    return beginShutdown(requestIds);
  }

  return Object.freeze({ requestShutdown, getSnapshot });
}

module.exports = { createStopEnsureShutdownCoordinator };
