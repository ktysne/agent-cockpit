'use strict';

const assert = require('node:assert/strict');
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

function originalReclamationPersistence(value) {
  let original = value;
  while (RECLAMATION_PERSISTENCE_ORIGINALS.has(original)) {
    original = RECLAMATION_PERSISTENCE_ORIGINALS.get(original);
  }
  return original;
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
    let resolveRelease;
    const entered = new Promise((resolve) => { resolveEntered = resolve; });
    const released = new Promise((resolve) => { resolveRelease = resolve; });
    writeBarrier = { slot, entered, released, resolveEntered };
    return Object.freeze({ entered, release: resolveRelease });
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
            throw Object.assign(new Error('fixture readback failure'), {
              code: 'fixture_reclamation_readback_failure',
            });
          }
        }
        return persistence.readSlotBytes(slot, ...args);
      },
      writeAnchorBytes(...args) {
        writesByStore.anchor += 1;
        return persistence.writeAnchorBytes(...args);
      },
      async writeSlotBytes(slot, bytes, maximumBytes) {
        writesBySlot[slot] += 1;
        writesByStore[slot] += 1;
        await waitAtBarrier(slot);
        if (armed === null || armed.slot !== slot) {
          readbackSlot = slot;
          return persistence.writeSlotBytes(slot, bytes, maximumBytes);
        }
        if (armed.skip > 0) {
          armed.skip -= 1;
          readbackSlot = slot;
          return persistence.writeSlotBytes(slot, bytes, maximumBytes);
        }
        const fault = armed;
        armed = null;
        if (fault.phase === 'before-write') throw Object.assign(new Error('fixture write failure'), {
          code: 'fixture_reclamation_write_failure',
        });
        readbackSlot = slot;
        await persistence.writeSlotBytes(slot, bytes, maximumBytes);
        if (fault.phase === 'after-write') {
          readbackSlot = null;
          throw Object.assign(new Error('fixture post-write failure'), {
            code: 'fixture_reclamation_post_write_failure',
          });
        }
        if (fault.phase === 'readback') readbackFailureSlot = slot;
      },
      close: () => persistence.close(),
      status: () => persistence.status(),
    });
  }

  return Object.freeze({
    arm,
    holdNextWrite,
    wrap,
    writesBySlot,
    writesByStore,
    isArmed: () => armed !== null,
  });
}

function loadFactory(faults) {
  const compositionPath = require.resolve('../../src/server/native-launch-composition');
  const persistencePath = require.resolve('../../src/server/reclamation-persistence');
  const contextPath = require.resolve('../../src/server/reclamation-service-context');
  const deliveryStorePath = require.resolve('../../src/server/durable-delivery-store');
  const integrationPath = require.resolve('../../src/server/native-instruction-service-integration');
  require(compositionPath);
  require(persistencePath);
  require(deliveryStorePath);
  const compositionEntry = require.cache[compositionPath];
  const persistenceEntry = require.cache[persistencePath];
  const previousContextEntry = require.cache[contextPath] || null;
  const previousContextExports = previousContextEntry?.exports ?? null;
  const deliveryStoreEntry = require.cache[deliveryStorePath];
  const previousIntegrationEntry = require.cache[integrationPath];
  const originalCompositionExports = compositionEntry.exports;
  const originalPersistenceExports = persistenceEntry.exports;
  const originalDeliveryStoreExports = deliveryStoreEntry.exports;
  const createComposition = originalCompositionExports.createNativeLaunchComposition;
  const createPersistence = originalPersistenceExports.createReclamationPersistence;
  const createDurableDeliveryStore = originalDeliveryStoreExports.createDurableDeliveryStore;
  const createProviderDeliveryAdapter = originalDeliveryStoreExports.createProviderDeliveryAdapter;
  let composition = null;
  let context = null;
  const deliveryAdapters = new Map();

  let integrationModule;
  try {
    compositionEntry.exports = {
      ...originalCompositionExports,
      createNativeLaunchComposition(options) {
        composition = createComposition(options);
        return composition;
      },
    };
    persistenceEntry.exports = {
      ...originalPersistenceExports,
      createReclamationPersistence(options) {
        const original = createPersistence(options);
        const wrapped = faults.wrap(original);
        RECLAMATION_PERSISTENCE_ORIGINALS.set(wrapped, originalReclamationPersistence(original));
        return wrapped;
      },
      getReclamationPersistenceControl(value) {
        return originalPersistenceExports.getReclamationPersistenceControl(originalReclamationPersistence(value));
      },
    };
    delete require.cache[contextPath];
    const reloadedContextExports = require(contextPath);
    const contextEntry = require.cache[contextPath];
    const createContext = reloadedContextExports.createReclamationServiceContext;
    contextEntry.exports = {
      ...reloadedContextExports,
      createReclamationServiceContext(options) {
        context = createContext(options);
        return context;
      },
      getReclamationServiceContextControl(value) {
        return reloadedContextExports.getReclamationServiceContextControl(value);
      },
    };
    deliveryStoreEntry.exports = {
      ...originalDeliveryStoreExports,
      createDurableDeliveryStore(options) {
        return createDurableDeliveryStore(options);
      },
      createProviderDeliveryAdapter(provider, store) {
        const adapter = createProviderDeliveryAdapter(provider, store);
        deliveryAdapters.set(provider, adapter);
        return adapter;
      },
    };
    delete require.cache[integrationPath];
    integrationModule = require(integrationPath);
  } finally {
    compositionEntry.exports = originalCompositionExports;
    persistenceEntry.exports = originalPersistenceExports;
    deliveryStoreEntry.exports = originalDeliveryStoreExports;
    if (previousContextEntry) {
      previousContextEntry.exports = previousContextExports;
      require.cache[contextPath] = previousContextEntry;
    } else {
      delete require.cache[contextPath];
    }
    if (previousIntegrationEntry) require.cache[integrationPath] = previousIntegrationEntry;
    else delete require.cache[integrationPath];
  }

  return Object.freeze({
    create: integrationModule.createNativeInstructionServiceIntegration,
    getComposition: () => composition,
    getContext: () => context,
    getDeliveryAdapters: () => deliveryAdapters,
  });
}

function createQuestionDependencies() {
  const listeners = new Set();
  const settings = {
    getAutoApplySettings: () => ({ enabled: false, minimumWaitMs: 300_000 }),
    getStatus: () => ({ status: 'ready', revision: 'native-body-reclamation-settings', reason: null }),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return { away: new AwayState(), settings };
}

function createNativeQuestionBodyReclamationHarness(options) {
  if (!options || typeof options.directory !== 'string' || !path.isAbsolute(options.directory)) {
    throw new TypeError('an absolute data directory is required');
  }
  const directory = options.directory;
  const profiles = options.profiles || defaultProfiles(directory);
  const hostId = options.hostId || 'native-question-body-reclamation-host';
  const reclamation = options.reclamation || {
    maxAdditionalBytes: 64 * 1024 * 1024,
    normalByteLimitsBySlot: {
      checkpoint: 16 * 1024 * 1024,
      instructions: 16 * 1024 * 1024,
      questions: 16 * 1024 * 1024,
    },
  };
  const now = options.now;
  if (typeof now !== 'function') throw new TypeError('a clock function is required');

  const processesByProvider = new Map(PROVIDERS.map((provider) => [provider, []]));
  const faults = createPersistenceFaults();
  let integration = null;
  let composition = null;
  let currentFactory = null;
  let closed = false;

  function runnerFactory(runnerOptions) {
    const providerProcesses = processesByProvider.get(runnerOptions.provider);
    const process = createFakeNativeProcess(runnerOptions.provider, runnerOptions.homePath, {
      nativeIdSuffix: providerProcesses.length + 1,
    });
    providerProcesses.push(process);
    return createOwnedNativeRunner({
      ...runnerOptions,
      spawnImpl: process.spawnImpl,
      timeouts: { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 250 },
    });
  }

  function onAuthenticationRequired(challenge) {
    const process = processesByProvider.get('codex').at(-1);
    if (!process || !process.completeLogin(challenge.loginId)) {
      throw new Error('fixture_login_process_unavailable');
    }
  }

  async function createIntegration() {
    await Promise.all(Object.values(profiles).flatMap((profile) => [profile.homePath, profile.cwd])
      .map((directoryPath) => fs.mkdir(directoryPath, { recursive: true })));
    const factory = loadFactory(faults);
    currentFactory = factory;
    let created = null;
    try {
      const createPromise = factory.create({
        profiles,
        dataDirectory: directory,
        hostId,
        runnerFactory,
        getAuthentication: () => ({ oauthToken: 'fixture-oauth-token' }),
        onAuthenticationRequired,
        now,
        commonQuestions: createQuestionDependencies(),
        reclamation,
      });
      created = await createPromise;
      composition = factory.getComposition();
      assert.ok(composition);
      await created.service.ready();
      await created.questionService.ready();
      return created;
    } catch (error) {
      if (created !== null) {
        try { await created.close(); } catch {}
      }
      throw error;
    }
  }

  const ready = createIntegration().then((created) => { integration = created; });

  async function start(provider, suffix) {
    await ready;
    if (!PROVIDERS.includes(provider)) throw new TypeError('unknown provider');
    const started = await integration.native.startLaunch({
      launchId: `body-reclamation-launch-${provider}-${suffix}`,
      runId: `body-reclamation-run-${provider}-${suffix}`,
      attemptId: `body-reclamation-attempt-${provider}-${suffix}`,
      profileId: provider,
      origin: 'standalone',
      purpose: 'agent',
      inputText: `body reclamation fixture ${provider}`,
    });
    return Object.freeze({
      ...started,
      process: processesByProvider.get(provider).at(-1) || null,
    });
  }

  async function restart() {
    await ready;
    if (closed) throw new Error('fixture_closed');
    await integration.close();
    integration = await createIntegration();
  }

  async function close() {
    if (integration === null) {
      await ready.catch(() => {});
      if (integration === null) return;
    }
    if (closed) return;
    closed = true;
    await integration.close();
  }

  return Object.freeze({
    directory,
    ready,
    start,
    restart,
    close,
    writerFor(launchRef) { return composition?.writerFor(launchRef) || null; },
    get questionService() { return integration?.questionService || null; },
    get instructionService() { return integration?.service || null; },
    get reclamationService() { return integration?.reclamation || null; },
    get reclamationContext() { return currentFactory?.getContext() || null; },
    deliveryAdapter(provider) { return currentFactory?.getDeliveryAdapters().get(provider) || null; },
    get checkpointPath() { return path.join(directory, 'delivery-checkpoint.json'); },
    get questionJournalPath() { return path.join(directory, 'common-question-journal.json'); },
    processesByProvider,
    faults,
    persistenceWritesBySlot: faults.writesBySlot,
    persistenceWriteCounts: faults.writesByStore,
    currentTime: now,
  });
}

module.exports = { createNativeQuestionBodyReclamationHarness };
