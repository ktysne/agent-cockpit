'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createOwnedNativeRunner } = require('../../src/server/owned-native-runner');
const { AwayState } = require('../../src/server/state');
const {
  createFakeNativeProcess,
  defaultProfiles,
  PROVIDERS,
} = require('./native-instruction-integration-harness');

const RECLAMATION_PERSISTENCE_ORIGINALS = new WeakMap();
const RECLAMATION_CONTEXT_ORIGINALS = new WeakMap();
const RECLAMATION_CONTEXT_FACTORY_WRAPPERS = new Set();

function originalReclamationPersistence(value) {
  let original = value;
  while (RECLAMATION_PERSISTENCE_ORIGINALS.has(original)) {
    original = RECLAMATION_PERSISTENCE_ORIGINALS.get(original);
  }
  return original;
}

function trackReclamationPersistenceWrapper(wrapper, original) {
  if (!wrapper || typeof wrapper !== 'object' || !original || typeof original !== 'object') {
    throw new TypeError('invalid reclamation persistence wrapper');
  }
  RECLAMATION_PERSISTENCE_ORIGINALS.set(wrapper, originalReclamationPersistence(original));
}

function originalReclamationServiceContext(value) {
  let original = value;
  while (RECLAMATION_CONTEXT_ORIGINALS.has(original)) {
    original = RECLAMATION_CONTEXT_ORIGINALS.get(original);
  }
  return original;
}

function trackReclamationServiceContextWrapper(wrapper, original) {
  if (!wrapper || typeof wrapper !== 'object' || !original || typeof original !== 'object') {
    throw new TypeError('invalid reclamation service context wrapper');
  }
  RECLAMATION_CONTEXT_ORIGINALS.set(wrapper, originalReclamationServiceContext(original));
}

function registerReclamationContextFactoryWrapper(wrapper) {
  if (typeof wrapper !== 'function') throw new TypeError('invalid reclamation context factory wrapper');
  RECLAMATION_CONTEXT_FACTORY_WRAPPERS.add(wrapper);
  return () => RECLAMATION_CONTEXT_FACTORY_WRAPPERS.delete(wrapper);
}

const DEFAULT_RECLAMATION = Object.freeze({
  maxAdditionalBytes: 64 * 1024 * 1024,
  normalByteLimitsBySlot: Object.freeze({
    checkpoint: 16 * 1024 * 1024,
    instructions: 16 * 1024 * 1024,
    questions: 16 * 1024 * 1024,
  }),
  maxRecordsBySlot: Object.freeze({ checkpoint: 50_000, instructions: 20_000, questions: 20_000 }),
});

function createQuestionDependencies() {
  const listeners = new Set();
  const settings = {
    getAutoApplySettings: () => ({ enabled: false, minimumWaitMs: 300_000 }),
    getStatus: () => ({ status: 'ready', revision: 'instruction-body-reclamation-settings', reason: null }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { away: new AwayState(), settings };
}

function createPersistenceFaults() {
  let armed = null;
  let writeBarrier = null;
  const writesBySlot = { checkpoint: 0, instructions: 0, questions: 0 };
  const writesByStore = { anchor: 0, checkpoint: 0, instructions: 0, questions: 0 };
  let readbackSlot = null;
  let readbackFailureSlot = null;

  function arm({ slot, phase, occurrence = 1 }) {
    if (!Object.hasOwn(writesBySlot, slot) || !['before-write', 'after-write', 'readback'].includes(phase) ||
        !Number.isSafeInteger(occurrence) || occurrence < 1) {
      throw new TypeError('invalid persistence fault');
    }
    armed = { slot, phase, skip: occurrence - 1 };
  }

  function holdNextWrite(slot) {
    if (!Object.hasOwn(writesBySlot, slot) || writeBarrier !== null) {
      throw new TypeError('invalid persistence write barrier');
    }
    let resolveEntered;
    let release;
    const entered = new Promise((resolve) => { resolveEntered = resolve; });
    const released = new Promise((resolve) => { release = resolve; });
    writeBarrier = { slot, entered, released, resolveEntered };
    return Object.freeze({ entered, release });
  }

  async function waitAtBarrier(slot) {
    if (writeBarrier === null || writeBarrier.slot !== slot) return;
    const barrier = writeBarrier;
    writeBarrier = null;
    barrier.resolveEntered();
    await barrier.released;
  }

  function wrap(persistence) {
    return Object.freeze({
      configuredSlots: persistence.configuredSlots,
      readAnchorBytes: (...args) => persistence.readAnchorBytes(...args),
      async readSlotBytes(slot, ...args) {
        if (readbackSlot === slot) {
          readbackSlot = null;
          if (readbackFailureSlot === slot) {
            readbackFailureSlot = null;
            throw Object.assign(new Error('fixture instruction body readback failure'), {
              code: 'fixture_instruction_body_readback_failure',
            });
          }
        }
        return persistence.readSlotBytes(slot, ...args);
      },
      async writeAnchorBytes(...args) {
        writesByStore.anchor += 1;
        return persistence.writeAnchorBytes(...args);
      },
      async writeSlotBytes(slot, bytes, maximumBytes) {
        writesBySlot[slot] += 1;
        writesByStore[slot] += 1;
        await waitAtBarrier(slot);
        let fault = null;
        if (armed !== null && armed.slot === slot) {
          if (armed.skip > 0) armed.skip -= 1;
          else {
            fault = armed;
            armed = null;
          }
        }
        if (fault?.phase === 'before-write') throw Object.assign(new Error('fixture instruction body write failure'), {
          code: 'fixture_instruction_body_write_failure',
        });
        readbackSlot = slot;
        await persistence.writeSlotBytes(slot, bytes, maximumBytes);
        if (fault?.phase === 'after-write') {
          readbackSlot = null;
          throw Object.assign(new Error('fixture instruction body post-write failure'), {
            code: 'fixture_instruction_body_post_write_failure',
          });
        }
        if (fault?.phase === 'readback') readbackFailureSlot = slot;
      },
      close: () => persistence.close(),
      status: () => persistence.status(),
    });
  }

  return Object.freeze({ arm, holdNextWrite, wrap, writesBySlot, writesByStore });
}

function loadFactory(faults) {
  const compositionPath = require.resolve('../../src/server/native-launch-composition');
  const persistencePath = require.resolve('../../src/server/reclamation-persistence');
  const contextPath = require.resolve('../../src/server/reclamation-service-context');
  const durableStorePath = require.resolve('../../src/server/durable-delivery-store');
  const instructionAdapterPath = require.resolve('../../src/server/provider-instruction-adapter');
  const integrationPath = require.resolve('../../src/server/native-instruction-service-integration');
  require(compositionPath);
  require(persistencePath);
  require(durableStorePath);
  require(instructionAdapterPath);
  const entries = [compositionPath, persistencePath, durableStorePath, instructionAdapterPath]
    .map((filename) => [filename, require.cache[filename]]);
  const previousContextEntry = require.cache[contextPath] || null;
  const previousContextExports = previousContextEntry?.exports ?? null;
  const previousIntegrationEntry = require.cache[integrationPath];
  const originals = Object.fromEntries(entries.map(([filename, entry]) => [filename, entry.exports]));
  const composition = { create: originals[compositionPath].createNativeLaunchComposition };
  const persistence = { create: originals[persistencePath].createReclamationPersistence };
  const adapters = { create: originals[instructionAdapterPath].createProviderInstructionAdapter };
  const delivery = { create: originals[durableStorePath].createProviderDeliveryAdapter };
  let nativeComposition = null;
  let reclamationContext = null;
  const deliveryAdapters = new Map();
  const instructionAdapters = new Map();
  const sourceTokens = new Map();
  const serviceAcceptedListeners = new Map();
  const evidenceByDelivery = new Map();
  const acceptedHolds = new Map();
  const backendSaveCounts = { checkpoint: 0, instructions: 0, questions: 0 };

  function holdNextAccepted(provider, deliveryAttemptId) {
    if (!PROVIDERS.includes(provider) || typeof deliveryAttemptId !== 'string' || acceptedHolds.has(provider)) {
      throw new TypeError('invalid accepted event hold');
    }
    let resolveCaptured;
    let resolveCompletion;
    let rejectCompletion;
    const received = new Promise((resolve) => { resolveCaptured = resolve; });
    const completion = new Promise((resolve, reject) => {
      resolveCompletion = resolve;
      rejectCompletion = reject;
    });
    completion.catch(() => {});
    let completionSettled = false;
    const settleCompletion = (settle, value) => {
      if (completionSettled) return;
      completionSettled = true;
      settle(value);
    };
    const hold = {
      deliveryAttemptId,
      received,
      resolveCaptured,
      completion,
      resolveCompletion: (value) => settleCompletion(resolveCompletion, value),
      rejectCompletion: (error) => settleCompletion(rejectCompletion, error),
      captured: null,
      released: false,
    };
    acceptedHolds.set(provider, hold);
    return Object.freeze({
      received,
      release() {
        if (!hold.captured || hold.released) throw new TypeError('accepted event is not releasable');
        hold.released = true;
        const listener = serviceAcceptedListeners.get(provider);
        if (typeof listener !== 'function') throw new TypeError('service accepted listener unavailable');
        let result;
        try {
          result = listener(hold.captured.deliveryAttemptId, hold.captured.sourceToken, hold.captured.accepted);
        } catch (error) {
          hold.rejectCompletion(error);
          throw error;
        }
        const observed = Promise.resolve(result);
        observed.then(hold.resolveCompletion, hold.rejectCompletion);
        return observed;
      },
    });
  }

  function abandonAcceptedHolds() {
    for (const hold of acceptedHolds.values()) {
      if (!hold.released) hold.released = true;
      hold.rejectCompletion(new Error('hold_abandoned'));
    }
  }

  try {
    require.cache[compositionPath].exports = {
      ...originals[compositionPath],
      createNativeLaunchComposition(options) {
        nativeComposition = composition.create(options);
        return nativeComposition;
      },
    };
    require.cache[persistencePath].exports = {
      ...originals[persistencePath],
      createReclamationPersistence(options) {
        const original = persistence.create(options);
        const wrapped = faults.wrap(original);
        trackReclamationPersistenceWrapper(wrapped, original);
        return wrapped;
      },
      getReclamationPersistenceControl(value) {
        return originals[persistencePath].getReclamationPersistenceControl(originalReclamationPersistence(value));
      },
    };
    delete require.cache[contextPath];
    const reloadedContextExports = require(contextPath);
    let createContext = reloadedContextExports.createReclamationServiceContext;
    for (const wrapContextFactory of RECLAMATION_CONTEXT_FACTORY_WRAPPERS) {
      createContext = wrapContextFactory(createContext);
    }
    const context = { create: createContext };
    require.cache[contextPath].exports = {
      ...reloadedContextExports,
      createReclamationServiceContext(options) {
        const created = context.create(options);
        const wrappedBackends = new Map();
        reclamationContext = Object.freeze({
          ...created,
          backend(slot) {
            if (!wrappedBackends.has(slot)) {
              const backend = created.backend(slot);
              wrappedBackends.set(slot, Object.freeze({
                ...backend,
                save(...args) {
                  if (Object.hasOwn(backendSaveCounts, slot)) backendSaveCounts[slot] += 1;
                  return backend.save(...args);
                },
              }));
            }
            return wrappedBackends.get(slot);
          },
        });
        trackReclamationServiceContextWrapper(reclamationContext, created);
        return reclamationContext;
      },
      getReclamationServiceContextControl(value) {
        return reloadedContextExports.getReclamationServiceContextControl(originalReclamationServiceContext(value));
      },
    };
    require.cache[durableStorePath].exports = {
      ...originals[durableStorePath],
      createProviderDeliveryAdapter(provider, store) {
        const adapter = delivery.create(provider, store);
        deliveryAdapters.set(provider, adapter);
        return adapter;
      },
    };
    require.cache[instructionAdapterPath].exports = {
      ...originals[instructionAdapterPath],
      createProviderInstructionAdapter(provider, options) {
        const adapter = adapters.create(provider, options);
        const wrapped = Object.freeze({
          ...adapter,
          onAccepted(listener) {
            serviceAcceptedListeners.set(provider, listener);
            return adapter.onAccepted((deliveryAttemptId, sourceToken, accepted) => {
              const captured = { deliveryAttemptId, sourceToken, accepted: structuredClone(accepted) };
              const hold = acceptedHolds.get(provider);
              if (hold && hold.deliveryAttemptId === deliveryAttemptId && hold.captured === null) {
                hold.captured = captured;
                hold.resolveCaptured(captured);
                return hold.completion;
              }
              return listener(deliveryAttemptId, sourceToken, accepted);
            });
          },
          onEvidence(listener) {
            return adapter.onEvidence((deliveryAttemptId, sourceToken, evidence) => {
              evidenceByDelivery.set(deliveryAttemptId, { sourceToken, evidence: structuredClone(evidence) });
              return listener(deliveryAttemptId, sourceToken, evidence);
            });
          },
          hasInstructionObservation(deliveryAttemptId, sourceToken) {
            return adapter.hasInstructionObservation(deliveryAttemptId, sourceToken);
          },
          async prepareInstructionDispatch(...args) {
            const prepared = await adapter.prepareInstructionDispatch(...args);
            if (prepared?.ok && prepared.sourceToken) sourceTokens.set(args[0]?.deliveryAttemptId, prepared.sourceToken);
            return prepared;
          },
        });
        instructionAdapters.set(provider, wrapped);
        return wrapped;
      },
    };
    delete require.cache[integrationPath];
    let integrationModule;
    integrationModule = require(integrationPath);
    return Object.freeze({
      create: integrationModule.createNativeInstructionServiceIntegration,
      getComposition: () => nativeComposition,
      getContext: () => reclamationContext,
      deliveryAdapter: (provider) => deliveryAdapters.get(provider) || null,
      instructionAdapter: (provider) => instructionAdapters.get(provider) || null,
      sourceToken: (id) => sourceTokens.get(id) || null,
      serviceAcceptedListener: (provider) => serviceAcceptedListeners.get(provider) || null,
      instructionEvidence: (id) => evidenceByDelivery.get(id) || null,
      holdNextAccepted,
      abandonAcceptedHolds,
      backendSaveCount: (slot) => backendSaveCounts[slot] || 0,
    });
  } finally {
    for (const [filename, entry] of entries) entry.exports = originals[filename];
    if (previousContextEntry) {
      previousContextEntry.exports = previousContextExports;
      require.cache[contextPath] = previousContextEntry;
    } else {
      delete require.cache[contextPath];
    }
    if (previousIntegrationEntry) require.cache[integrationPath] = previousIntegrationEntry;
    else delete require.cache[integrationPath];
  }
}

function createNativeInstructionBodyReclamationHarness(options) {
  if (!options || typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) {
    throw new TypeError('an absolute data directory is required');
  }
  const directory = options.directory;
  const profiles = options.profiles || defaultProfiles(directory);
  const hostId = options.hostId || 'native-instruction-body-reclamation-host';
  const reclamation = options.reclamation || DEFAULT_RECLAMATION;
  if (typeof options.now !== 'function') throw new TypeError('a clock function is required');
  const processesByProvider = new Map(PROVIDERS.map((provider) => [provider, []]));
  const faults = createPersistenceFaults();
  let integration = null;
  let currentFactory = null;
  let closed = false;

  function runnerFactory(runnerOptions) {
    const providerProcesses = processesByProvider.get(runnerOptions.provider);
    const fakeProcess = createFakeNativeProcess(runnerOptions.provider, runnerOptions.homePath, {
      nativeIdSuffix: providerProcesses.length + 1,
      instructionEvidence: options.instructionEvidence ?? (runnerOptions.provider === 'codex' ? 'full' : 'none'),
    });
    providerProcesses.push(fakeProcess);
    return createOwnedNativeRunner({
      ...runnerOptions,
      spawnImpl: fakeProcess.spawnImpl,
      timeouts: { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 250 },
    });
  }

  function onAuthenticationRequired(challenge) {
    const process = processesByProvider.get('codex').at(-1);
    if (!process || !process.completeLogin(challenge.loginId)) throw new Error('fixture_login_process_unavailable');
  }

  async function createIntegration() {
    await Promise.all(Object.values(profiles).flatMap((profile) => [profile.homePath, profile.cwd])
      .map((directoryPath) => fs.mkdir(directoryPath, { recursive: true })));
    const factory = loadFactory(faults);
    currentFactory = factory;
    let created = null;
    try {
      created = await factory.create({
        profiles,
        dataDirectory: directory,
        hostId,
        runnerFactory,
        getAuthentication: () => ({ oauthToken: 'fixture-oauth-token' }),
        onAuthenticationRequired,
        now: options.now,
        commonQuestions: options.commonQuestions || createQuestionDependencies(),
        reclamation,
      });
      assertComposition(factory.getComposition());
      await Promise.all([created.service.ready(), created.questionService.ready()]);
      return created;
    } catch (error) {
      if (created !== null) {
        try { await created.close(); } catch {}
      }
      throw error;
    }
  }

  function assertComposition(value) {
    if (!value || typeof value.writerFor !== 'function') throw new Error('native_launch_composition_unavailable');
  }

  const ready = createIntegration().then((created) => { integration = created; });

  async function start(provider, suffix) {
    await ready;
    if (!PROVIDERS.includes(provider)) throw new TypeError('unknown provider');
    const started = await integration.native.startLaunch({
      launchId: `instruction-body-launch-${provider}-${suffix}`,
      runId: `instruction-body-run-${provider}-${suffix}`,
      attemptId: `instruction-body-attempt-${provider}-${suffix}`,
      profileId: provider,
      origin: 'standalone',
      purpose: 'agent',
      inputText: `instruction body fixture ${provider}`,
    });
    return Object.freeze({ ...started, process: processesByProvider.get(provider).at(-1) || null });
  }

  async function restart(beforeStart = undefined) {
    await ready;
    if (closed) throw new Error('fixture_closed');
    await integration.close();
    if (beforeStart !== undefined) await beforeStart();
    integration = await createIntegration();
  }

  async function close() {
    if (integration === null) await ready.catch(() => {});
    if (closed || integration === null) return;
    closed = true;
    await integration.close();
  }

  async function closeCurrent() {
    if (integration === null) await ready.catch(() => {});
    if (integration !== null) await integration.close();
  }

  return Object.freeze({
    directory,
    ready,
    start,
    restart,
    abandonAcceptedHolds() { currentFactory?.abandonAcceptedHolds(); },
    close,
    closeCurrent,
    faults,
    processesByProvider,
    get instructionService() { return integration?.service || null; },
    get reclamationService() { return integration?.reclamation || null; },
    get reclamationContext() { return currentFactory?.getContext() || null; },
    deliveryAdapter(provider) { return currentFactory?.deliveryAdapter(provider) || null; },
    instructionAdapter(provider) { return currentFactory?.instructionAdapter(provider) || null; },
    sourceToken(id) { return currentFactory?.sourceToken(id) || null; },
    serviceAcceptedListener(provider) { return currentFactory?.serviceAcceptedListener(provider) || null; },
    instructionEvidence(id) { return currentFactory?.instructionEvidence(id) || null; },
    holdNextAccepted(provider, id) {
      if (!currentFactory) throw new Error('native_factory_unavailable');
      return currentFactory.holdNextAccepted(provider, id);
    },
    backendSaveCount(slot) { return currentFactory?.backendSaveCount(slot) || 0; },
    writerFor(launchRef) { return currentFactory?.getComposition()?.writerFor(launchRef) || null; },
    pathFor(slot) {
      const names = { checkpoint: 'delivery-checkpoint.json', instructions: 'instruction-journal.json',
        questions: 'common-question-journal.json', anchor: 'question-reclamation-anchor.json' };
      return path.join(directory, names[slot]);
    },
    persistenceWritesBySlot: faults.writesBySlot,
    persistenceWriteCounts: faults.writesByStore,
  });
}

module.exports = {
  createNativeInstructionBodyReclamationHarness,
  PROVIDERS,
  registerReclamationContextFactoryWrapper,
  trackReclamationPersistenceWrapper,
  trackReclamationServiceContextWrapper,
};
