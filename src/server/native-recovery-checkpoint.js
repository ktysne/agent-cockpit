'use strict';

const { createRegistrationKernel } = require('./conversation-registry');
const { createDurableDeliveryStore, readNativeRecoverySnapshot } = require('./durable-delivery-store');
const { createLaunchBindingKernel } = require('./launch-binding');
const { createRuntimeBindingKernel } = require('./runtime-binding');

function recoveryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function createNativeRecoveryBootstrap(options = {}) {
  const allowedOptions = ['filePath', 'limits', 'atomicWrite', 'fileSystem'];
  if (!isRecord(options) || Reflect.ownKeys(options).some((key) => !allowedOptions.includes(key))) {
    throw recoveryError('invalid_recovery_options');
  }

  const registration = createRegistrationKernel();
  const launch = createLaunchBindingKernel({ registrationRegistry: registration.registry });
  const runtime = createRuntimeBindingKernel({
    registrationRegistry: registration.registry,
    launchRegistry: launch.registry,
  });
  let store;

  return (async () => {
    try {
      store = createDurableDeliveryStore({
        ...options,
        registrationRegistry: registration.registry,
        launchRegistry: launch.registry,
        runtimeRegistry: runtime.registry,
        resolveProof: () => null,
      });
      await store.ready;
      const checkpoint = await readNativeRecoverySnapshot(store);
      const restored = registration.authority.restoreHistory(checkpoint.registrations);
      let closePromise = null;
      const close = () => {
        if (!closePromise) closePromise = store.close();
        return closePromise;
      };
      return Object.freeze({
        kernels: Object.freeze({ registration, launch, runtime }),
        store,
        recovery: Object.freeze({
          schemaVersion: checkpoint.schemaVersion,
          revision: checkpoint.revision,
          registrationHistory: restored.historyIncomplete ? 'incomplete' : 'complete',
          conversationCount: restored.conversationCount,
          executionCount: restored.executionCount,
          registrationHistoryRestored: true,
          executionAuthorityRestored: false,
          writerBindingsRestored: 0,
          proofHandlesRestored: 0,
        }),
        close,
      });
    } catch (error) {
      if (store) await store.close().catch(() => {});
      throw error;
    }
  })();
}

module.exports = { createNativeRecoveryBootstrap };
