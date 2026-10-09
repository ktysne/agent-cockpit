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
  require(contextPath);
  require(durableStorePath);
  require(instructionAdapterPath);
  const entries = [compositionPath, persistencePath, contextPath, durableStorePath, instructionAdapterPath]
    .map((filename) => [filename, require.cache[filename]]);
  const previousIntegrationEntry = require.cache[integrationPath];
  const originals = Object.fromEntries(entries.map(([filename, entry]) => [filename, entry.exports]));
  const composition = { create: originals[compositionPath].createNativeLaunchComposition };
  const persistence = { create: originals[persistencePath].createReclamationPersistence };
  const context = { create: originals[contextPath].createReclamationServiceContext };
  const adapters = { create: originals[instructionAdapterPath].createProviderInstructionAdapter };
  const delivery = { create: originals[durableStorePath].createProviderDeliveryAdapter };
  let nativeComposition = null;
  let reclamationContext = null;
  const deliveryAdapters = new Map();
  const instructionAdapters = new Map();
  const sourceTokens = new Map();

  require.cache[compositionPath].exports = {
    ...originals[compositionPath],
    createNativeLaunchComposition(options) {
      nativeComposition = composition.create(options);
      return nativeComposition;
    },
  };
  require.cache[persistencePath].exports = {
    ...originals[persistencePath],
    createReclamationPersistence(options) { return faults.wrap(persistence.create(options)); },
  };
  require.cache[contextPath].exports = {
    ...originals[contextPath],
    createReclamationServiceContext(options) {
      reclamationContext = context.create(options);
      return reclamationContext;
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
  try {
    integrationModule = require(integrationPath);
  } finally {
    for (const [filename, entry] of entries) entry.exports = originals[filename];
    if (previousIntegrationEntry) require.cache[integrationPath] = previousIntegrationEntry;
    else delete require.cache[integrationPath];
  }

  return Object.freeze({
    create: integrationModule.createNativeInstructionServiceIntegration,
    getComposition: () => nativeComposition,
    getContext: () => reclamationContext,
    deliveryAdapter: (provider) => deliveryAdapters.get(provider) || null,
    instructionAdapter: (provider) => instructionAdapters.get(provider) || null,
    sourceToken: (id) => sourceTokens.get(id) || null,
  });
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

module.exports = { createNativeInstructionBodyReclamationHarness, PROVIDERS };
