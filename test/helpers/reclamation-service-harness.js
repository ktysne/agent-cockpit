'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  createReclamationPersistence,
} = require('../../src/server/reclamation-persistence');
const {
  createReclamationServiceContext,
} = require('../../src/server/reclamation-service-context');
const {
  createReclamationCapacityBudget,
} = require('../../src/server/reclamation-capacity-reservation');
const {
  createEmptyCheckpointV3TargetLocal,
  createEmptyInstructionJournalV2TargetLocal,
  createEmptyQuestionJournalV2TargetLocal,
} = require('../../src/server/reclamation-migration-projection');
const {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
} = require('../../src/server/question-reclamation-anchor-codec');
const { normalizeQuestionJournalV2Local } = require('../../src/server/common-question-reclamation-codec');
const { encodeQuestionJournalV2Local } = require('../../src/server/common-question-reclamation-codec');
const { encodeCheckpointV3Local, encodeInstructionJournalV2Local } = require('../../src/server/delivery-reclamation-codec');
const {
  createDurableDeliveryStore,
  createProviderDeliveryAdapter,
} = require('../../src/server/durable-delivery-store');
const {
  createCommonQuestionService,
} = require('../../src/server/common-question-service');
const {
  createInstructionDeliveryJournal,
} = require('../../src/server/instruction-delivery-journal');
const {
  createInstructionDeliveryService,
} = require('../../src/server/instruction-delivery-service');
const {
  createCommonQuestionProductHarness,
} = require('../support/common-question-product-harness');

const PROVIDERS = Object.freeze(['claude', 'codex']);
const SLOTS = Object.freeze(['checkpoint', 'instructions', 'questions']);
const STORE_ID = '11111111-1111-4111-8111-111111111111';
const BYTE_LIMIT = 1_000_000;
const MAX_SOURCE_BYTES = 16_777_216;

function trackedBackend(backend, onSave = null, onEnqueued = null) {
  return Object.freeze({
    slot: backend.slot,
    normalByteLimit: backend.normalByteLimit,
    canWrite: () => backend.canWrite(),
    getStoreId: () => backend.getStoreId(),
    load: () => backend.load(),
    save: async (candidate, assertBeforeWrite) => {
      await onSave?.(candidate);
      const result = backend.save(candidate, assertBeforeWrite);
      onEnqueued?.(candidate);
      return result;
    },
    prepareResume: (snapshot) => backend.prepareResume(snapshot),
    flush: () => backend.flush(),
    close: () => backend.close(),
    getSnapshot: () => backend.getSnapshot(),
  });
}

function createDeferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function createFaultablePersistence(persistence) {
  const counts = Object.fromEntries(['anchor', ...SLOTS].map((slot) => [slot, { reads: 0, writes: 0 }]));
  let armedFault = null;
  let readbackSlot = null;

  function maybeFail(slot, phase) {
    if (!armedFault || armedFault.slot !== slot || armedFault.phase !== phase) return;
    const fault = armedFault;
    armedFault = null;
    throw fault.error;
  }

  async function read(slot, operation) {
    counts[slot].reads += 1;
    const isReadback = readbackSlot === slot;
    readbackSlot = null;
    if (isReadback) maybeFail(slot, 'readback');
    return operation();
  }

  async function write(slot, bytes, operation) {
    counts[slot].writes += 1;
    maybeFail(slot, 'before-write');
    await operation();
    readbackSlot = slot;
    try {
      maybeFail(slot, 'after-write');
    } catch (error) {
      readbackSlot = null;
      throw error;
    }
  }

  return {
    persistence: Object.freeze({
      configuredSlots: persistence.configuredSlots,
      readAnchorBytes: (maximumBytes) => read('anchor', () => persistence.readAnchorBytes(maximumBytes)),
      readSlotBytes: (slot, maximumBytes) => read(slot, () => persistence.readSlotBytes(slot, maximumBytes)),
      writeAnchorBytes: (bytes, maximumBytes) => write('anchor', bytes,
        () => persistence.writeAnchorBytes(bytes, maximumBytes)),
      writeSlotBytes: (slot, bytes, maximumBytes) => write(slot, bytes,
        () => persistence.writeSlotBytes(slot, bytes, maximumBytes)),
      close: () => persistence.close(),
      status: () => persistence.status(),
    }),
    counts,
    armPersistenceFault({ slot, phase, error = new Error('injected_reclamation_persistence_failure') }) {
      if (!Object.hasOwn(counts, slot) ||
          !['before-write', 'after-write', 'readback'].includes(phase) || armedFault) {
        throw new TypeError('invalid reclamation persistence fault');
      }
      armedFault = { slot, phase, error };
    },
  };
}

async function createTemporaryDirectory(directory, temporaryRoot) {
  const lexicalPath = path.resolve(directory);
  const assertInsideTemporaryRoot = (value) => {
    const relative = path.relative(temporaryRoot, value);
    if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new TypeError('reclamation harness directory must be inside the temporary directory');
    }
  };
  assertInsideTemporaryRoot(lexicalPath);
  await fs.mkdir(lexicalPath, { recursive: true });
  const resolvedPath = await fs.realpath(lexicalPath);
  assertInsideTemporaryRoot(resolvedPath);
  return resolvedPath;
}

async function closeProductResource(resource) {
  if (resource.closePromise === null) {
    resource.closePromise = (async () => {
      await resource.product?.close().catch(() => {});
      await fs.rm(resource.directory, { recursive: true, force: true });
      resource.closed = true;
    })();
  }
  await resource.closePromise;
}

async function createReclamationServiceHarness(provider, options = {}) {
  if (!PROVIDERS.includes(provider)) throw new TypeError('unsupported provider');
  const initialNow = options.initialNow ?? 1_000_000;
  if (!Number.isSafeInteger(initialNow)) throw new TypeError('initialNow must be a safe integer');
  const temporaryRoot = await fs.realpath(os.tmpdir());
  const directory = options.directory === undefined
    ? await fs.mkdtemp(path.join(temporaryRoot, 'reclamation-service-conformance-'))
    : await createTemporaryDirectory(options.directory, temporaryRoot);
  const productResource = options.sharedProductResource ?? {
    directory: await fs.mkdtemp(path.join(temporaryRoot, 'reclamation-provider-fixture-')),
    product: null,
    fixture: null,
    clockNow: initialNow,
    closePromise: null,
    closed: false,
  };
  if (productResource.closed) throw new TypeError('reclamation provider fixture is closed');
  productResource.clockNow = initialNow;
  const productDirectory = productResource.directory;
  let product = null;
  let persistence = null;
  let context = null;
  let deliveryStore = null;
  let questionService = null;
  let instructionJournal = null;
  let instructionService = null;
  let localClosePromise = null;
  const maxRecords = options.maxRecords ?? 1_000;
  const saveCounts = { checkpoint: 0, instructions: 0, questions: 0 };
  let faultablePersistence = null;
  const checkpointSaveEntered = createDeferred();
  const checkpointSaveRelease = createDeferred();
  let holdNextCheckpointSave = false;
  let questionSaveEnqueuedWaiter = null;
  let nextPersistenceBarrier = null;

  async function close(closeOptions = {}) {
    if (localClosePromise === null) {
      localClosePromise = (async () => {
        await instructionService?.close().catch(() => {});
        await questionService?.close().catch(() => {});
        await deliveryStore?.close().catch(() => {});
        await context?.close().catch(() => {});
      })();
    }
    await localClosePromise;
    if (!closeOptions.preserveProduct) await closeProductResource(productResource);
    if (!closeOptions.preserveDirectory && !options.preserveDirectory) {
      await fs.rm(directory, { recursive: true, force: true });
    }
  }

  try {
    if (productResource.product === null) {
      productResource.product = await createCommonQuestionProductHarness({
        provider,
        directory: productDirectory,
        now: () => productResource.clockNow,
        setTimeoutImpl: (callback, delay) => ({ callback, delay, unref() {} }),
        clearTimeoutImpl() {},
      });
    }
    product = productResource.product;
    if (productResource.fixture === null) {
      const primary = product.primary;
      product.registrationKernel.authority.end(primary.child.registration.executionId);
      const resumed = product.createExecution(
        `resumed-${provider}`,
        primary.child.identity,
        { resume: true },
      );
      const unrelated = product.createExecution(`unrelated-${provider}`);
      const prTarget = product.createExecution(`pr-target-${provider}`);
      const fixtureExecutions = [primary, resumed, unrelated, prTarget];
      const proofByLaunchRef = new Map(fixtureExecutions.map((execution) => [
        execution.launchRef,
        execution.proofHandle,
      ]));
      productResource.fixture = { primary, resumed, unrelated, prTarget, fixtureExecutions, proofByLaunchRef };
    }
    const { primary, resumed, unrelated, prTarget, fixtureExecutions, proofByLaunchRef } = productResource.fixture;

    function createExecution(suffix, identity, executionOptions = {}) {
      const execution = product.createExecution(suffix, identity, executionOptions);
      fixtureExecutions.push(execution);
      proofByLaunchRef.set(execution.launchRef, execution.proofHandle);
      return execution;
    }

    const anchorPath = path.join(directory, 'question-reclamation-anchor.json');
    const slotPathsBySlot = Object.fromEntries(SLOTS.map((slot) => [
      slot,
      path.join(directory, `${slot}.json`),
    ]));
    const slotForPath = (targetPath) => {
      const resolved = path.resolve(targetPath);
      if (resolved === path.resolve(anchorPath)) return 'anchor';
      return SLOTS.find((slot) => resolved === path.resolve(slotPathsBySlot[slot])) || null;
    };
    const fileSystem = Object.freeze({
      lstat: (...args) => fs.lstat(...args),
      open: (...args) => fs.open(...args),
      async rename(sourcePath, targetPath) {
        const barrier = nextPersistenceBarrier;
        if (barrier && barrier.slot === slotForPath(targetPath)) {
          nextPersistenceBarrier = null;
          barrier.entered.resolve();
          await barrier.release.promise;
        }
        return fs.rename(sourcePath, targetPath);
      },
      unlink: (...args) => fs.unlink(...args),
    });
    persistence = createReclamationPersistence({ anchorPath, slotPathsBySlot, fileSystem });
    const emptyAnchor = normalizeQuestionReclamationAnchorV1Local({
      schemaVersion: 1,
      revision: 0,
      storeId: STORE_ID,
      retiredQuestionPeriods: [],
      migration: null,
    });
    const emptyStores = {
      checkpoint: createEmptyCheckpointV3TargetLocal({ storeId: STORE_ID }).snapshot,
      instructions: createEmptyInstructionJournalV2TargetLocal({ storeId: STORE_ID }).snapshot,
      questions: createEmptyQuestionJournalV2TargetLocal({ storeId: STORE_ID }).snapshot,
    };
    const seeded = options.initialSnapshotsFactory?.({
      provider,
      product,
      primary,
      resumed,
      unrelated,
      prTarget,
      emptyAnchor,
      emptyStores,
    }) ?? {};
    const anchor = normalizeQuestionReclamationAnchorV1Local(seeded.anchor ?? emptyAnchor);
    const initialStores = {
      ...emptyStores,
      ...(seeded.stores ?? {}),
    };
    initialStores.questions = normalizeQuestionJournalV2Local(initialStores.questions, maxRecords);
    if (!options.skipSeed) {
      await persistence.writeAnchorBytes(encodeQuestionReclamationAnchorV1Local(anchor).bytes, MAX_SOURCE_BYTES);
      for (const slot of SLOTS) {
        const encoded = slot === 'checkpoint'
          ? encodeCheckpointV3Local(initialStores.checkpoint).bytes
          : slot === 'instructions'
            ? encodeInstructionJournalV2Local(initialStores.instructions).bytes
            : encodeQuestionJournalV2Local(initialStores.questions, maxRecords).bytes;
        await persistence.writeSlotBytes(slot, encoded, MAX_SOURCE_BYTES);
      }
    }
    faultablePersistence = createFaultablePersistence(persistence);

    context = createReclamationServiceContext({
      persistence: faultablePersistence.persistence,
      capacityBudget: createReclamationCapacityBudget({ maxAdditionalBytes: 100_000_000 }),
      normalByteLimitsBySlot: {
        checkpoint: BYTE_LIMIT,
        instructions: BYTE_LIMIT,
        questions: BYTE_LIMIT,
      },
      now: () => productResource.clockNow,
      createStoreId: () => STORE_ID,
    });

    const checkpointBackend = trackedBackend(context.backend('checkpoint'), async () => {
      saveCounts.checkpoint += 1;
      if (!holdNextCheckpointSave) return;
      holdNextCheckpointSave = false;
      checkpointSaveEntered.resolve();
      await checkpointSaveRelease.promise;
    });
    const instructionBackend = trackedBackend(context.backend('instructions'), async () => {
      saveCounts.instructions += 1;
    });
    const questionBackend = trackedBackend(context.backend('questions'), () => {
      saveCounts.questions += 1;
    }, () => {
      questionSaveEnqueuedWaiter?.resolve();
      questionSaveEnqueuedWaiter = null;
    });

    const resolveProof = (launchRef) => proofByLaunchRef.get(launchRef) || null;
    deliveryStore = createDurableDeliveryStore({
      registrationRegistry: product.registrationKernel.registry,
      launchRegistry: product.launchKernel.registry,
      runtimeRegistry: product.runtimeRegistry,
      resolveProof,
      verifyResultOwner: () => false,
      verifyInstructionTarget: (delivery) => {
        const launchRef = delivery?.target?.launchRef;
        const proof = proofByLaunchRef.get(launchRef);
        if (!proof) return false;
        try {
          const runtime = product.runtimeRegistry.get(launchRef);
          const proofCheck = product.runtimeRegistry.checkCurrentProof(launchRef, proof);
          return runtime?.executionBinding?.periodId === delivery.target.periodId &&
            JSON.stringify(runtime.identity) === JSON.stringify(delivery.target.identity) &&
            proofCheck?.ok === true;
        } catch {
          return false;
        }
      },
      now: () => productResource.clockNow,
      limits: { maxBytes: BYTE_LIMIT, maxRecords },
      reclamation: { backend: checkpointBackend, periodGate: context.periodGate },
    });
    const providerDeliveryStore = createProviderDeliveryAdapter(provider, deliveryStore);
    questionService = createCommonQuestionService({
      registrationRegistry: product.registrationKernel.registry,
      launchRegistry: product.launchKernel.registry,
      runtimeRegistry: product.runtimeRegistry,
      deliveryStore: providerDeliveryStore,
      away: product.away,
      verifyNativeQuestion: () => true,
      now: () => productResource.clockNow,
      maxRecords,
      setTimeoutImpl: (callback, delay) => ({ callback, delay, unref() {} }),
      clearTimeoutImpl() {},
      reclamation: { backend: questionBackend, periodGate: context.periodGate },
    });
    instructionJournal = createInstructionDeliveryJournal({
      reclamation: { backend: instructionBackend, periodGate: context.periodGate },
      maxBytes: BYTE_LIMIT,
      maxRecords,
    });
    instructionService = createInstructionDeliveryService({
      journal: instructionJournal,
      deliveryStore: providerDeliveryStore,
      providerInstructionAdapters: {},
      launchRegistry: product.launchKernel.registry,
      now: () => productResource.clockNow,
    });

    const writersBySlot = Object.freeze({
      checkpoint: deliveryStore.reclamationWriter,
      instructions: instructionService.reclamationWriter,
      questions: questionService.reclamationWriter,
    });
    await context.start(writersBySlot);
    await Promise.all([deliveryStore.ready, questionService.ready(), instructionService.ready()]);

    return {
      provider,
      directory,
      product,
      primary,
      resumed,
      unrelated,
      prTarget,
      fixtureExecutions,
      createExecution,
      endExecution(execution) {
        product.registrationKernel.authority.end(execution.child.registration.executionId);
      },
      context,
      persistence: faultablePersistence.persistence,
      writersBySlot,
      deliveryStore,
      providerDeliveryStore,
      questionService,
      instructionJournal,
      instructionService,
      questionBackend,
      checkpointBackend,
      instructionBackend,
      saveCounts,
      persistenceCounts: faultablePersistence.counts,
      armPersistenceFault: faultablePersistence.armPersistenceFault,
      checkpointSaveEntered: checkpointSaveEntered.promise,
      holdNextCheckpointSave() { holdNextCheckpointSave = true; },
      releaseCheckpointSave() { checkpointSaveRelease.resolve(); },
      holdNextPersistenceWrite(slot) {
        if (!Object.hasOwn(faultablePersistence.counts, slot) || nextPersistenceBarrier) {
          throw new TypeError('invalid reclamation persistence barrier');
        }
        const entered = createDeferred();
        const release = createDeferred();
        nextPersistenceBarrier = { slot, entered, release };
        return Object.freeze({ entered: entered.promise, release: () => release.resolve() });
      },
      waitForNextQuestionSaveEnqueued() {
        if (questionSaveEnqueuedWaiter) throw new TypeError('question save waiter already registered');
        questionSaveEnqueuedWaiter = createDeferred();
        return questionSaveEnqueuedWaiter.promise;
      },
      setNow(value) { productResource.clockNow = value; },
      async removeDirectory() { await fs.rm(directory, { recursive: true, force: true }); },
      async restart(restartOptions = {}) {
        const restartNow = restartOptions.initialNow ?? productResource.clockNow;
        if (!Number.isSafeInteger(restartNow)) throw new TypeError('initialNow must be a safe integer');
        await close({ preserveProduct: true, preserveDirectory: true });
        return createReclamationServiceHarness(provider, {
          directory,
          preserveDirectory: options.preserveDirectory ?? false,
          skipSeed: true,
          maxRecords,
          initialNow: restartNow,
          sharedProductResource: productResource,
        });
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

module.exports = { createReclamationServiceHarness, PROVIDERS };
