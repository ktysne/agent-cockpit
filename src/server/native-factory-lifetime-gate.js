'use strict';

function gateError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function createNativeFactoryLifetimeGate() {
  let accepting = true;
  let activeTickets = 0;
  let drainPromise = null;
  let resolveDrain = null;
  const settled = Promise.resolve();

  function enter(operationKind) {
    if (!accepting) throw gateError('native_factory_lifetime_closed');
    if (typeof operationKind !== 'string' || operationKind.trim().length === 0) {
      throw gateError('invalid_native_factory_operation_kind');
    }
    activeTickets += 1;
    let released = false;
    return Object.freeze({
      release() {
        if (released) return;
        released = true;
        activeTickets -= 1;
        if (activeTickets === 0 && resolveDrain !== null) {
          const resolve = resolveDrain;
          drainPromise = null;
          resolveDrain = null;
          resolve();
        }
      },
    });
  }

  function stopAdmission() {
    accepting = false;
  }

  function drain() {
    if (activeTickets === 0) return settled;
    if (drainPromise === null) {
      drainPromise = new Promise((resolve) => { resolveDrain = resolve; });
    }
    return drainPromise;
  }

  return Object.freeze({ enter, stopAdmission, drain });
}

module.exports = { createNativeFactoryLifetimeGate };
