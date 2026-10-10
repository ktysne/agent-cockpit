'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { types: utilTypes } = require('node:util');
const { createRegistrationKernel } = require('./conversation-registry');
const { createLaunchBindingKernel } = require('./launch-binding');
const { createRuntimeBindingKernel } = require('./runtime-binding');
const { createDurableDeliveryStore, createProviderDeliveryAdapter } = require('./durable-delivery-store');
const { DEFAULT_MAX_RECORDS: DEFAULT_CHECKPOINT_MAX_RECORDS } = require('./durable-checkpoint');
const {
  DEFAULT_MAX_RECORDS: DEFAULT_INSTRUCTION_MAX_RECORDS,
  createInstructionDeliveryJournal,
} = require('./instruction-delivery-journal');
const { createInstructionDeliveryService } = require('./instruction-delivery-service');
const { createProviderInstructionAdapter } = require('./provider-instruction-adapter');
const { createNativeLaunchComposition } = require('./native-launch-composition');
const { createCommonQuestionService } = require('./common-question-service');
const { MAX_JOURNAL_RECORDS } = require('./common-question-kernel');
const { createReclamationPersistence } = require('./reclamation-persistence');
const { createReclamationCapacityBudget } = require('./reclamation-capacity-reservation');
const { createReclamationServiceContext } = require('./reclamation-service-context');
const { createNativeFactoryLifetimeGate } = require('./native-factory-lifetime-gate');
const { getOwnedNativeCollectorControl } = require('./owned-native-source-collector');
const {
  createReclamationScheduler,
  MAX_RECLAMATION_SCHEDULER_INTERVAL_MS,
  MAX_RECLAMATION_SCHEDULER_OPERATIONS_PER_PASS,
} = require('./reclamation-scheduler');
const { MAX_SOURCE_BYTES } = require('./reclamation-capacity-bounds');

const PROVIDERS = new Set(['claude', 'codex']);
const ROUTER_METHODS = [
  'prepareInstructionDispatch',
  'checkInstructionDispatch',
  'dispatchInstructionNow',
  'subscribeInstructionEvidence',
];
const ROUTER_METADATA_FIELDS = [
  'deliveryAttemptId', 'revision', 'payloadDigest', 'nativeContentDigest',
  'source', 'target', 'mode', 'expectedTurnId',
];
const RETIRED_CAPABILITY = Symbol('retired native instruction capability');
const MAX_OBSERVATION_CAPABILITIES = 128;
const PROFILE_FIELDS = ['provider', 'executablePath', 'homePath', 'homeScopeId', 'cwd'];
const PROFILE_FIELDS_WITH_RUNNER = [...PROFILE_FIELDS, 'runnerProfile'];
const RECLAMATION_SLOTS = ['checkpoint', 'instructions', 'questions'];
const QUESTION_RECLAMATION_IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const RECLAMATION_MAX_RECORDS_BY_SLOT = Object.freeze({
  checkpoint: DEFAULT_CHECKPOINT_MAX_RECORDS,
  instructions: DEFAULT_INSTRUCTION_MAX_RECORDS,
  questions: MAX_JOURNAL_RECORDS,
});
const FACTORY_FIELDS = [
  'profiles', 'dataDirectory', 'hostId', 'runnerFactory', 'getAuthentication',
  'onAuthenticationRequired', 'now', 'checkpointAtomicWrite', 'journalAtomicWrite', 'storeLimits',
  'commonQuestions', 'reclamation',
];
const START_FIELDS = ['launchId', 'runId', 'attemptId', 'profileId', 'origin', 'purpose', 'inputText'];
const OWNED_STOP_FIELDS = ['launchRef', 'executionId', 'sessionId', 'expectedContextId',
  'expectedOwnerGeneration', 'stopRevision'];
const OWNED_PROCESS_STATES = new Set([
  'not_started', 'starting', 'running', 'stopping', 'stopped', 'stop_unconfirmed', 'disconnected', 'quarantined', 'failed',
]);

function integrationError(code) {
  const error = new Error('native instruction service integration rejected the operation');
  error.code = code;
  return error;
}

function createFailureCapture() {
  let failed = false;
  let reason;
  return {
    capture(value) { if (!failed) { failed = true; reason = value; } },
    get failed() { return failed; },
    get reason() { return reason; },
    throwIfFailed() { if (failed) throw reason; },
  };
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactData(value, fields, code) {
  if (!isRecord(value)) throw integrationError(code);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { throw integrationError(code); }
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
    throw integrationError(code);
  }
  const result = {};
  for (const field of fields) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); } catch { throw integrationError(code); }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw integrationError(code);
    }
    result[field] = descriptor.value;
  }
  return result;
}

function dataMethod(target, name) {
  if (target === null || (typeof target !== 'object' && typeof target !== 'function')) return null;
  let current = target;
  for (let depth = 0; current && depth < 8; depth += 1) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(current, name); } catch { return null; }
    if (descriptor) {
      return Object.hasOwn(descriptor, 'value') && typeof descriptor.value === 'function'
        ? descriptor.value
        : null;
    }
    try { current = Object.getPrototypeOf(current); } catch { return null; }
  }
  return null;
}

function ownDataValue(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined;
  let descriptor;
  try { descriptor = Object.getOwnPropertyDescriptor(value, name); } catch { return undefined; }
  return descriptor && descriptor.enumerable && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
}

function isOpaqueCapability(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function hasThenMember(value) {
  let current = value;
  for (let depth = 0; current && depth < 8; depth += 1) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(current, 'then'); } catch { return true; }
    if (descriptor) return true;
    try { current = Object.getPrototypeOf(current); } catch { return true; }
  }
  return false;
}

function swallowRejectedPromise(value) {
  if (!utilTypes.isPromise(value)) return;
  try { Promise.prototype.then.call(value, undefined, () => {}); } catch {}
}

function providerInMetadata(metadata) {
  const source = ownDataValue(metadata, 'source');
  const claims = ownDataValue(source, 'claims');
  return ownDataValue(claims, 'provider');
}

function fingerprintMetadata(value) {
  let normalized;
  try { normalized = exactData(value, ROUTER_METADATA_FIELDS, 'invalid_instruction_metadata'); }
  catch { return null; }
  let fingerprint;
  try { fingerprint = JSON.stringify(normalized); } catch { return null; }
  return typeof fingerprint === 'string' ? fingerprint : null;
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 512 &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function captureProfiles(value) {
  if (!isRecord(value)) throw integrationError('invalid_native_profiles');
  let profileIds;
  try { profileIds = Reflect.ownKeys(value); } catch { throw integrationError('invalid_native_profiles'); }
  if (!profileIds.length || profileIds.some((profileId) => typeof profileId !== 'string')) {
    throw integrationError('invalid_native_profiles');
  }
  const profiles = Object.create(null);
  for (const profileId of profileIds) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, profileId); } catch { throw integrationError('invalid_native_profiles'); }
    if (!isIdentifier(profileId) || !descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw integrationError('invalid_native_profiles');
    }
    let fields;
    try { fields = Reflect.ownKeys(descriptor.value); } catch { throw integrationError('invalid_native_profiles'); }
    const acceptedFields = fields.includes('runnerProfile') ? PROFILE_FIELDS_WITH_RUNNER : PROFILE_FIELDS;
    profiles[profileId] = Object.freeze(exactData(descriptor.value, acceptedFields, 'invalid_native_profiles'));
  }
  return Object.freeze(profiles);
}

function captureStoreLimits(value) {
  if (value === undefined) return undefined;
  let fields;
  try { fields = Reflect.ownKeys(value); } catch { throw integrationError('invalid_store_limits'); }
  if (fields.some((field) => typeof field !== 'string' || !['maxBytes', 'maxRecords'].includes(field))) {
    throw integrationError('invalid_store_limits');
  }
  return Object.freeze(exactData(value, fields, 'invalid_store_limits'));
}

function captureReclamationLimitMap(value, maximums) {
  const limits = exactData(value, RECLAMATION_SLOTS, 'invalid_reclamation_options');
  for (const slot of RECLAMATION_SLOTS) {
    const maximum = maximums === null ? MAX_SOURCE_BYTES : maximums[slot];
    if (!Number.isSafeInteger(limits[slot]) || limits[slot] < 1 || limits[slot] > maximum) {
      throw integrationError('invalid_reclamation_options');
    }
  }
  return Object.freeze(limits);
}

function captureAutoReclaim(value) {
  if (value === false) return false;
  if (utilTypes.isProxy(value)) throw integrationError('invalid_reclamation_options');
  const config = exactData(value, ['intervalMs', 'maxOperationsPerPass'], 'invalid_reclamation_options');
  if (!Number.isSafeInteger(config.intervalMs) || config.intervalMs < 1 ||
      config.intervalMs > MAX_RECLAMATION_SCHEDULER_INTERVAL_MS ||
      !Number.isSafeInteger(config.maxOperationsPerPass) || config.maxOperationsPerPass < 1 ||
      config.maxOperationsPerPass > MAX_RECLAMATION_SCHEDULER_OPERATIONS_PER_PASS) {
    throw integrationError('invalid_reclamation_options');
  }
  return Object.freeze(config);
}

function captureReclamationOptions(value) {
  if (utilTypes.isProxy(value)) throw integrationError('invalid_reclamation_options');
  let fields;
  try { fields = Reflect.ownKeys(value); } catch { throw integrationError('invalid_reclamation_options'); }
  if (!isRecord(value) || fields.some((field) => typeof field !== 'string' ||
      !['maxAdditionalBytes', 'normalByteLimitsBySlot', 'maxRecordsBySlot', 'autoReclaim'].includes(field)) ||
      !fields.includes('maxAdditionalBytes') || !fields.includes('normalByteLimitsBySlot')) {
    throw integrationError('invalid_reclamation_options');
  }
  const config = exactData(value, fields, 'invalid_reclamation_options');
  if (!Number.isSafeInteger(config.maxAdditionalBytes) || config.maxAdditionalBytes < 0) {
    throw integrationError('invalid_reclamation_options');
  }
  const normalByteLimitsBySlot = captureReclamationLimitMap(config.normalByteLimitsBySlot, null);
  const maxRecordsBySlot = fields.includes('maxRecordsBySlot')
    ? captureReclamationLimitMap(config.maxRecordsBySlot, RECLAMATION_MAX_RECORDS_BY_SLOT)
    : Object.freeze({ ...RECLAMATION_MAX_RECORDS_BY_SLOT });
  const autoReclaim = fields.includes('autoReclaim') ? captureAutoReclaim(config.autoReclaim) : false;
  return Object.freeze({ maxAdditionalBytes: config.maxAdditionalBytes, normalByteLimitsBySlot, maxRecordsBySlot,
    autoReclaim });
}

function captureFactoryOptions(value) {
  let fields;
  try { fields = Reflect.ownKeys(value); } catch { throw integrationError('invalid_native_integration_options'); }
  if (!isRecord(value) || fields.some((key) => typeof key !== 'string' || !FACTORY_FIELDS.includes(key)) ||
      !['profiles', 'dataDirectory', 'hostId'].every((field) => fields.includes(field))) {
    throw integrationError('invalid_native_integration_options');
  }
  const options = exactData(value, fields, 'invalid_native_integration_options');
  const reclamationEnabled = fields.includes('reclamation');
  if (reclamationEnabled && fields.some((field) =>
    ['checkpointAtomicWrite', 'journalAtomicWrite', 'storeLimits'].includes(field))) {
    throw integrationError('reclamation_option_conflict');
  }
  const profiles = captureProfiles(options.profiles);
  const dataDirectory = options.dataDirectory;
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory) || !dataDirectory.trim()) {
    throw integrationError('invalid_native_integration_options');
  }
  const commonQuestions = captureCommonQuestions(options.commonQuestions);
  const reclamation = reclamationEnabled ? captureReclamationOptions(options.reclamation) : undefined;
  if (reclamationEnabled && commonQuestions === null) throw integrationError('common_question_service_unavailable');
  if (!isIdentifier(options.hostId) ||
      (options.runnerFactory !== undefined && typeof options.runnerFactory !== 'function') ||
      (options.getAuthentication !== undefined && typeof options.getAuthentication !== 'function') ||
      (options.onAuthenticationRequired !== undefined && typeof options.onAuthenticationRequired !== 'function') ||
      (options.now !== undefined && typeof options.now !== 'function') ||
      (options.checkpointAtomicWrite !== undefined && typeof options.checkpointAtomicWrite !== 'function') ||
      (options.journalAtomicWrite !== undefined && typeof options.journalAtomicWrite !== 'function')) {
    throw integrationError('invalid_native_integration_options');
  }
  return {
    ...options,
    profiles,
    dataDirectory: path.resolve(dataDirectory),
    storeLimits: captureStoreLimits(options.storeLimits),
    commonQuestions,
    ...(reclamationEnabled ? { reclamation } : {}),
  };
}

function captureCommonQuestions(value) {
  if (value === undefined) return null;
  let fields;
  try { fields = Reflect.ownKeys(value); } catch { throw integrationError('invalid_common_question_options'); }
  if (!isRecord(value) || fields.some((field) => !['away', 'settings'].includes(field))) {
    throw integrationError('invalid_common_question_options');
  }
  const config = exactData(value, fields, 'invalid_common_question_options');
  const getAutoApplySettings = dataMethod(config.settings, 'getAutoApplySettings');
  const subscribe = dataMethod(config.settings, 'subscribe');
  if (!dataMethod(config.away, 'snapshot') || !getAutoApplySettings || !subscribe) return null;
  return Object.freeze({ ...config, getAutoApplySettings, subscribe, getSettingsStatus: dataMethod(config.settings, 'getStatus') });
}

function captureAdmissionInput(value) {
  let fields;
  try { fields = Reflect.ownKeys(value); } catch { throw integrationError('invalid_native_admission'); }
  if (fields.some((field) => typeof field !== 'string' ||
      !['launchId', 'runId', 'attemptId', 'profileId', 'origin', 'purpose', 'originReceipt'].includes(field))) {
    throw integrationError('invalid_native_admission');
  }
  const expected = fields.includes('originReceipt')
    ? ['launchId', 'runId', 'attemptId', 'profileId', 'origin', 'purpose', 'originReceipt']
    : ['launchId', 'runId', 'attemptId', 'profileId', 'origin', 'purpose'];
  return exactData(value, expected, 'invalid_native_admission');
}

function captureLaunchStart(value) {
  let fields;
  try { fields = Reflect.ownKeys(value); } catch { throw integrationError('invalid_native_launch_start'); }
  if (fields.some((field) => typeof field !== 'string' ||
      ![...START_FIELDS, 'originReceipt', 'predecessorReceipt'].includes(field))) {
    throw integrationError('invalid_native_launch_start');
  }
  const expected = [...START_FIELDS,
    ...(fields.includes('originReceipt') ? ['originReceipt'] : []),
    ...(fields.includes('predecessorReceipt') ? ['predecessorReceipt'] : [])];
  const input = exactData(value, expected, 'invalid_native_launch_start');
  if (typeof input.inputText !== 'string') throw integrationError('invalid_native_launch_start');
  const admission = {};
  for (const field of ['launchId', 'runId', 'attemptId', 'profileId', 'origin', 'purpose', 'originReceipt']) {
    if (Object.hasOwn(input, field)) admission[field] = input[field];
  }
  return { admission, inputText: input.inputText,
    predecessorReceipt: Object.hasOwn(input, 'predecessorReceipt') ? input.predecessorReceipt : null };
}

async function createNativeInstructionServiceIntegration(inputOptions) {
  const options = captureFactoryOptions(inputOptions);
  const { profiles, dataDirectory, hostId } = options;
  await fs.mkdir(dataDirectory, { recursive: true });
  const storageDirectory = options.reclamation ? await fs.realpath(dataDirectory) : dataDirectory;

  const registrationKernel = createRegistrationKernel();
  const launchKernel = createLaunchBindingKernel({ registrationRegistry: registrationKernel.registry });
  const runtimeKernel = createRuntimeBindingKernel({
    registrationRegistry: registrationKernel.registry,
    launchRegistry: launchKernel.registry,
  });
  const profileProviders = new Map(Object.entries(profiles).map(([profileId, profile]) => [profileId, profile.provider]));
  const checkpointPath = path.join(storageDirectory, 'delivery-checkpoint.json');
  const journalPath = path.join(storageDirectory, 'instruction-journal.json');
  const commonQuestionJournalPath = options.commonQuestions
    ? path.join(storageDirectory, 'common-question-journal.json') : null;
  let composition;
  let routers = {};
  let store;
  let journal;
  let reclamationPersistence = null;
  let reclamationContext = null;
  let reclamationScheduler = null;
  const lifetimeGate = options.reclamation ? createNativeFactoryLifetimeGate() : null;
  let closing = false;
  let closePromise = null;
  const admissionByReceipt = new WeakMap();
  const admissions = new Set();
  const admissionsByLaunchRef = new Map();
  let providerDeliveryAdapters;
  let providerInstructionAdapters;
  let service;
  let questionService = null;
  let unsubscribeSettings = null;
  let acceptingSettings = true;
  const reclamationNow = options.now || Date.now;

  function getSettingsStatus() {
    const unavailable = Object.freeze({ status: 'unavailable', revision: null, reason: 'settings_status_unavailable' });
    if (!options.commonQuestions?.getSettingsStatus) return unavailable;
    try {
      const value = options.commonQuestions.getSettingsStatus.call(options.commonQuestions.settings);
      if (utilTypes.isPromise(value)) swallowRejectedPromise(value);
      if (hasThenMember(value) || !isRecord(value)) return unavailable;
      const status = ownDataValue(value, 'status');
      const revision = ownDataValue(value, 'revision');
      const reason = ownDataValue(value, 'reason');
      if (!['ready', 'missing', 'invalid', 'unavailable', 'changed'].includes(status) ||
          !isIdentifier(revision) ||
          !(reason === null || typeof reason === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(reason))) return unavailable;
      return Object.freeze({ status, revision, reason });
    } catch { return unavailable; }
  }

  function getAutoApplySettings() {
    if (getSettingsStatus().status !== 'ready') return null;
    try {
      const value = options.commonQuestions.getAutoApplySettings.call(options.commonQuestions.settings);
      if (utilTypes.isPromise(value)) swallowRejectedPromise(value);
      return hasThenMember(value) ? null : value;
    } catch { return null; }
  }

  function notifySettingsChanged() {
    if (!acceptingSettings) return;
    try { Promise.resolve(questionService.tick()).catch(() => {}); } catch {}
  }

  function stopSettingsNotifications() {
    acceptingSettings = false;
    const unsubscribe = unsubscribeSettings;
    unsubscribeSettings = null;
    unsubscribe?.();
  }

  async function cleanupPartial() {
    closing = true;
    lifetimeGate?.stopAdmission();
    const failure = createFailureCapture();
    let contextClosePromise = null;
    const attempt = async (operation) => {
      try { await operation(); } catch (error) { failure.capture(error); }
    };
    try { reclamationScheduler?.stop(); } catch (error) { failure.capture(error); }
    if (reclamationContext !== null) {
      try {
        contextClosePromise = reclamationContext.close();
        contextClosePromise.catch(() => {});
      } catch (error) { failure.capture(error); }
    }
    const nativeShutdown = lifetimeGate === null ? null : beginNativeShutdown();
    if (nativeShutdown?.failure.failed) failure.capture(nativeShutdown.failure.reason);
    await attempt(() => stopSettingsNotifications());
    await attempt(() => questionService?.close?.());
    await attempt(() => service?.close?.());
    if (nativeShutdown) await drainNativeShutdown(nativeShutdown, attempt);
    if (!service) {
      for (const adapter of Object.values(providerInstructionAdapters || {})) {
        try { adapter?.close?.(); } catch (error) { failure.capture(error); }
      }
      for (const adapter of Object.values(providerDeliveryAdapters || {})) {
        try { adapter?.close?.(); } catch (error) { failure.capture(error); }
      }
      await attempt(() => journal?.close?.());
    }
    for (const router of Object.values(routers)) {
      try { router.close(); } catch (error) { failure.capture(error); }
    }
    if (reclamationContext === null) await attempt(() => store?.flush?.());
    await attempt(() => store?.close?.());
    await attempt(() => reclamationScheduler?.drain());
    if (contextClosePromise !== null) await attempt(() => contextClosePromise);
    else if (reclamationContext === null) await attempt(() => reclamationPersistence?.close?.());
    if (lifetimeGate !== null) {
      await attempt(() => lifetimeGate.drain());
      await awaitPreparationCleanups(nativeShutdown.entries, attempt);
    }
    if (options.reclamation) failure.throwIfFailed();
  }

  try {
    if (options.reclamation) {
      const directory = storageDirectory;
      reclamationPersistence = createReclamationPersistence({
        anchorPath: path.join(directory, 'question-reclamation-anchor.json'),
        slotPathsBySlot: {
          checkpoint: checkpointPath,
          instructions: journalPath,
          questions: commonQuestionJournalPath,
        },
      });
      const capacityBudget = createReclamationCapacityBudget({
        maxAdditionalBytes: options.reclamation.maxAdditionalBytes,
      });
      reclamationContext = createReclamationServiceContext({
        persistence: reclamationPersistence,
        normalByteLimitsBySlot: options.reclamation.normalByteLimitsBySlot,
        capacityBudget,
        now: reclamationNow,
      });
    }
    composition = createNativeLaunchComposition({
      registrationKernel,
      launchKernel,
      runtimeKernel,
      hostId,
      profiles,
      ...(options.runnerFactory ? { runnerFactory: options.runnerFactory } : {}),
      ...(options.getAuthentication ? { getAuthentication: options.getAuthentication } : {}),
      ...(options.onAuthenticationRequired ? { onAuthenticationRequired: options.onAuthenticationRequired } : {}),
    });
    routers = Object.fromEntries([...PROVIDERS].map((provider) => [
      provider,
      createNativeInstructionOwnerRouter({ provider, composition }),
    ]));
    store = createDurableDeliveryStore({
      filePath: checkpointPath,
      registrationRegistry: registrationKernel.registry,
      launchRegistry: launchKernel.registry,
      runtimeRegistry: runtimeKernel.registry,
      resolveProof: (launchRef) => composition.resolveProof(launchRef),
      verifyInstructionTarget: (delivery) =>
        providerInstructionAdapters?.[delivery.source.claims.provider]?.verifyDeliveryTarget(delivery) === true,
      ...(options.reclamation ? {
        reclamation: {
          backend: reclamationContext.backend('checkpoint'),
          periodGate: reclamationContext.periodGate,
        },
        limits: {
          maxBytes: options.reclamation.normalByteLimitsBySlot.checkpoint,
          maxRecords: options.reclamation.maxRecordsBySlot.checkpoint,
        },
        now: reclamationNow,
      } : {
        ...(options.checkpointAtomicWrite ? { atomicWrite: options.checkpointAtomicWrite } : {}),
        ...(options.storeLimits ? { limits: options.storeLimits } : {}),
      }),
    });
    if (options.reclamation) store.ready.catch(() => {});
    journal = createInstructionDeliveryJournal(options.reclamation ? {
      reclamation: {
        backend: reclamationContext.backend('instructions'),
        periodGate: reclamationContext.periodGate,
      },
      maxBytes: options.reclamation.normalByteLimitsBySlot.instructions,
      maxRecords: options.reclamation.maxRecordsBySlot.instructions,
    } : {
      filePath: journalPath,
      ...(options.journalAtomicWrite ? { atomicWrite: options.journalAtomicWrite } : {}),
    });
    providerDeliveryAdapters = Object.fromEntries([...PROVIDERS].map((provider) => [
      provider,
      createProviderDeliveryAdapter(provider, store),
    ]));
    providerInstructionAdapters = Object.fromEntries([...PROVIDERS].map((provider) => [
      provider,
      createProviderInstructionAdapter(provider, {
        deliveryAdapter: providerDeliveryAdapters[provider],
        nativeOwner: routers[provider],
      }),
    ]));
    service = createInstructionDeliveryService({
      journal,
      deliveryStore: store,
      providerInstructionAdapters,
      launchRegistry: launchKernel.registry,
      ...(options.reclamation ? { now: reclamationNow } : options.now ? { now: options.now } : {}),
    }, lifetimeGate);
    if (options.reclamation) {
      questionService = createCommonQuestionService({
        reclamation: {
          backend: reclamationContext.backend('questions'),
          periodGate: reclamationContext.periodGate,
        },
        maxBytes: options.reclamation.normalByteLimitsBySlot.questions,
        maxRecords: options.reclamation.maxRecordsBySlot.questions,
        registrationRegistry: registrationKernel.registry,
        launchRegistry: launchKernel.registry,
        runtimeRegistry: runtimeKernel.registry,
        deliveryStore: store,
        away: options.commonQuestions.away,
        getAutoApplySettings,
        now: reclamationNow,
      }, lifetimeGate);
      await reclamationContext.start({
        checkpoint: store.reclamationWriter,
        instructions: service.reclamationWriter,
        questions: questionService.reclamationWriter,
      });
      const [, , questionReady] = await Promise.all([store.ready, service.ready(), questionService.ready()]);
      if (ownDataValue(questionReady, 'ready') !== true) throw integrationError('common_question_service_unavailable');
    } else {
      await service.ready();
      if (options.commonQuestions) {
        questionService = createCommonQuestionService({
          journalPath: commonQuestionJournalPath,
          registrationRegistry: registrationKernel.registry,
          launchRegistry: launchKernel.registry,
          runtimeRegistry: runtimeKernel.registry,
          deliveryStore: store,
          away: options.commonQuestions.away,
          getAutoApplySettings,
          ...(options.now ? { now: options.now } : {}),
        });
        const questionReady = await questionService.ready();
        if (ownDataValue(questionReady, 'ready') !== true) throw integrationError('common_question_service_unavailable');
      }
    }
    if (options.commonQuestions) {
      const unsubscribe = options.commonQuestions.subscribe.call(options.commonQuestions.settings, notifySettingsChanged);
      if (utilTypes.isPromise(unsubscribe)) swallowRejectedPromise(unsubscribe);
      if (typeof unsubscribe !== 'function' || hasThenMember(unsubscribe)) {
        throw integrationError('invalid_common_question_subscription');
      }
      unsubscribeSettings = unsubscribe;
    }
  } catch (error) {
    try { await cleanupPartial(); }
    catch (cleanupError) {
      throw new AggregateError([error, cleanupError], 'native instruction integration startup cleanup failed', { cause: error });
    }
    throw error;
  }

  function entryFor(receipt) {
    const entry = receipt && (typeof receipt === 'object' || typeof receipt === 'function')
      ? admissionByReceipt.get(receipt)
      : null;
    if (!entry) throw integrationError('admission_receipt_unavailable');
    return entry;
  }

  function ownedExecutionFor(entry) {
    const state = composition.ownedStopState(entry.receipt);
    if (!entry.launchRef) entry.launchRef = state.launchRef;
    if (state.launchRef !== entry.launchRef || !OWNED_PROCESS_STATES.has(state.processState) ||
        !Number.isSafeInteger(state.expectedOwnerGeneration) || state.expectedOwnerGeneration < 0 ||
        !Number.isSafeInteger(state.stopRevision) || state.stopRevision < 0 ||
        !Number.isSafeInteger(state.nativeRequestIdCount) || state.nativeRequestIdCount < 0 || state.nativeRequestIdCount > 128 ||
        !Number.isSafeInteger(state.nativeRequestIdRemaining) || state.nativeRequestIdRemaining < 0 ||
        state.nativeRequestIdRemaining > 128 || state.nativeRequestIdCount + state.nativeRequestIdRemaining !== 128 ||
        state.nativeRequestOverflow && state.nativeRequestIdCount !== 128) {
      throw integrationError('owned_stop_state_unavailable');
    }
    const nativeRequestIdCount = state.nativeRequestIdCount;
    const nativeRequestIdRemaining = state.nativeRequestIdRemaining;
    const physicalStopConfirmed = state.processState === 'stopped';
    const stopConfirmed = physicalStopConfirmed && entry.isolationConfirmed === true;
    return Object.freeze({
      launchRef: state.launchRef,
      executionId: state.executionId,
      sessionId: state.sessionId,
      expectedContextId: state.expectedContextId,
      expectedOwnerGeneration: state.expectedOwnerGeneration,
      stopRevision: state.stopRevision,
      processState: state.processState,
      canStop: !state.explicitStop && !stopConfirmed,
      stopConfirmed,
      hold: Object.freeze({
        reason: state.nativeRequestOverflow ? 'capacity' : state.unknownServerRequestHeld ? 'unknown' : null,
        retainedRequestCount: nativeRequestIdCount,
        remainingRequestCount: nativeRequestIdRemaining,
        limit: 128,
      }),
    });
  }

  function ownedExecutionSnapshot() {
    if (closing) throw integrationError('owned_stop_state_unavailable');
    const result = [];
    for (const entry of admissions) {
      const state = ownedExecutionFor(entry);
      if (state.executionId && state.sessionId) result.push(state);
    }
    return Object.freeze(result);
  }

  function getOwnedStopState(receipt) {
    return ownedExecutionFor(entryFor(receipt));
  }

  function stopOwnedExecution(value) {
    const claims = exactData(value, OWNED_STOP_FIELDS, 'invalid_owned_stop_request');
    if (!isIdentifier(claims.launchRef) || !isIdentifier(claims.executionId) ||
        !isIdentifier(claims.sessionId) ||
        (claims.expectedContextId !== null && !isIdentifier(claims.expectedContextId)) ||
        !Number.isSafeInteger(claims.expectedOwnerGeneration) || claims.expectedOwnerGeneration < 0 ||
        !Number.isSafeInteger(claims.stopRevision) || claims.stopRevision < 0) {
      throw integrationError('invalid_owned_stop_request');
    }
    const entry = admissionsByLaunchRef.get(claims.launchRef);
    if (!entry) return Promise.resolve(Object.freeze({ status: 'stale', ownedExecution: null }));
    let current;
    try { current = ownedExecutionFor(entry); }
    catch { return Promise.resolve(Object.freeze({ status: 'stale', ownedExecution: null })); }
    if (current.executionId !== claims.executionId || current.sessionId !== claims.sessionId) {
      return Promise.resolve(Object.freeze({ status: 'stale', ownedExecution: null }));
    }
    if (current.expectedContextId !== claims.expectedContextId ||
        current.expectedOwnerGeneration !== claims.expectedOwnerGeneration ||
        current.stopRevision !== claims.stopRevision) {
      return Promise.resolve(Object.freeze({ status: 'stale', ownedExecution: current }));
    }
    if (current.stopConfirmed) {
      return Promise.resolve(Object.freeze({ status: 'stop_confirmed', ownedExecution: current }));
    }
    if (!current.canStop) {
      return Promise.resolve(Object.freeze({ status: 'stop_unconfirmed', ownedExecution: current }));
    }
    let pending;
    try { pending = stop(entry.receipt); }
    catch { pending = Promise.resolve(false); }
    return Promise.resolve(pending).catch(() => {}).then(() => {
      let latest;
      try { latest = ownedExecutionFor(entry); } catch { latest = null; }
      return Object.freeze({
        status: latest?.stopConfirmed === true ? 'stop_confirmed' : 'stop_unconfirmed',
        ownedExecution: latest,
      });
    });
  }

  function admitLaunch(value) {
    return admitLaunchCore(value);
  }

  function admitLaunchCore(value, registerEntry) {
    if (closing) throw integrationError('native_instruction_integration_closed');
    const admission = captureAdmissionInput(value);
    const receipt = composition.admitLaunch(admission);
    const provider = profileProviders.get(admission.profileId);
    if (!provider || !routers[provider]) throw integrationError('native_profile_unavailable');
    const existing = admissionByReceipt.get(receipt);
    if (existing) {
      if (existing.state !== 'admitted' && existing.state !== 'starting' && existing.state !== 'running') {
        throw integrationError('admission_retired');
      }
      const state = composition.ownedStopState(receipt);
      existing.launchRef = state.launchRef;
      admissionsByLaunchRef.set(state.launchRef, existing);
      existing.detach = routers[provider].attachAdmission(receipt);
      if (lifetimeGate !== null && (closing || !['admitted', 'starting', 'running'].includes(existing.state))) {
        stop(receipt).catch(() => {});
        throw integrationError('native_instruction_integration_closed');
      }
      return receipt;
    }
    const entry = { receipt, provider, router: routers[provider], detach: null, collector: null,
      pendingCollector: null, collectorControl: null, cleanupPromise: null, cleanupFailure: createFailureCapture(),
      cleanupFinalizers: [], cleanupSettled: false,
      state: 'admitted', startInputText: null, startPromise: null, stopPromise: null,
      launchRef: null, isolationConfirmed: false, predecessorReceipt: null, predecessorReceiptBound: false };
    entry.launchRef = composition.ownedStopState(receipt).launchRef;
    admissionByReceipt.set(receipt, entry);
    admissions.add(entry);
    admissionsByLaunchRef.set(entry.launchRef, entry);
    registerEntry?.(entry);
    try {
      entry.detach = entry.router.attachAdmission(receipt);
      if (lifetimeGate !== null && (closing || !['admitted', 'starting', 'running'].includes(entry.state))) {
        stop(receipt).catch(() => {});
        throw integrationError('native_instruction_integration_closed');
      }
    } catch (error) {
      if (lifetimeGate !== null) {
        beginPreparationCleanup(entry);
        throw error;
      }
      entry.state = 'failed';
      entry.stopPromise = Promise.resolve().then(() => composition.stop(receipt)).then((snapshot) => {
        entry.state = snapshot?.processState === 'stopped' ? 'stopped' : 'stop_unconfirmed';
        if (entry.state !== 'stopped') throw integrationError('native_process_stop_unconfirmed');
        return true;
      }, (stopError) => {
        entry.state = 'stop_unconfirmed';
        throw stopError;
      });
      entry.stopPromise.catch(() => {});
      throw error;
    }
    return receipt;
  }

  function createOwnedCollector(receipt, collectorOptions = {}) {
    if (closing) throw integrationError('native_instruction_integration_closed');
    const entry = entryFor(receipt);
    if (!['admitted', 'starting', 'running'].includes(entry.state)) throw integrationError('admission_retired');
    if (lifetimeGate === null) {
      if (!entry.collector) entry.collector = composition.createOwnedCollector(receipt, collectorOptions);
      return entry.collector;
    }
    if (entry.collector) return entry.collector;
    if (entry.pendingCollector || entry.cleanupPromise) throw integrationError('owned_collector_initialization_failed');
    let bound = false;
    try {
      entry.pendingCollector = composition.createOwnedCollector(receipt, collectorOptions);
      entry.collectorControl = getOwnedNativeCollectorControl(entry.pendingCollector);
      if (!entry.collectorControl) {
        const error = integrationError('owned_collector_control_unavailable');
        entry.cleanupFailure.capture(error);
        throw error;
      }
      if (!entry.collectorControl.bindTicketAcquirer((kind) => {
        if (closing || !['admitted', 'starting', 'running'].includes(entry.state)) {
          throw integrationError('native_instruction_integration_closed');
        }
        const ticket = lifetimeGate.enter('native-collector-' + kind);
        return () => ticket.release();
      })) {
        const error = integrationError('owned_collector_ticket_binding_failed');
        entry.cleanupFailure.capture(error);
        throw error;
      }
      bound = true;
      if (closing || !['admitted', 'starting', 'running'].includes(entry.state)) {
        throw integrationError('native_instruction_integration_closed');
      }
      entry.collector = entry.pendingCollector;
      entry.pendingCollector = null;
    } catch (error) {
      if (entry.pendingCollector && !bound) entry.cleanupFailure.capture(error);
      beginPreparationCleanup(entry);
      throw error;
    }
    return entry.collector;
  }

  function stop(receipt) {
    if (lifetimeGate !== null) return stopCore(entryFor(receipt));
    return stopStandard(receipt);
  }

  function stopCore(entry) {
    if (entry.stopPromise) return entry.stopPromise;
    let resolveStop;
    let rejectStop;
    entry.stopPromise = new Promise((resolve, reject) => { resolveStop = resolve; rejectStop = reject; });
    entry.stopPromise.catch(() => {});
    entry.state = 'stopping';
    const failure = createFailureCapture();
    try { entry.collectorControl?.stopAdmission(); } catch (error) { failure.capture(error); }
    let compositionStop;
    try {
      if (!composition) throw integrationError('native_composition_unavailable');
      compositionStop = Promise.resolve(composition.stop(entry.receipt));
    } catch (error) { compositionStop = Promise.reject(error); }
    compositionStop.catch(() => {});
    let routerDetached = false;
    try { routerDetached = (entry.detach ? entry.detach() : entry.router.detachAdmission(entry.receipt)) === true; }
    catch (error) { failure.capture(error); }
    entry.detach = null;
    entry.isolationConfirmed = false;
    const collector = entry.collector || entry.pendingCollector;
    let disconnect = null;
    if (collector) {
      try { disconnect = Promise.resolve(collector.disconnect()); }
      catch (error) { disconnect = Promise.reject(error); }
      disconnect.catch(() => {});
    }
    const completion = (async () => {
      let collectorDetached = !collector;
      if (disconnect) {
        try { collectorDetached = (await disconnect)?.status === 'disconnected'; }
        catch (error) { failure.capture(error); }
      }
      try { await compositionStop; } catch (error) { failure.capture(error); }
      let latest = null;
      try { latest = composition.ownedStopState(entry.receipt); } catch (error) { failure.capture(error); }
      entry.state = latest?.processState === 'stopped' ? 'stopped' : 'stop_unconfirmed';
      entry.isolationConfirmed = routerDetached && collectorDetached;
      if (latest?.processState !== 'stopped') failure.capture(integrationError('native_process_stop_unconfirmed'));
      if (!entry.isolationConfirmed) failure.capture(integrationError('native_instruction_isolation_unconfirmed'));
      failure.throwIfFailed();
      return true;
    })();
    completion.then(resolveStop, rejectStop);
    return entry.stopPromise;
  }

  function beginPreparationCleanup(entry, finalize) {
    if (finalize) {
      if (entry.cleanupSettled) finalize();
      else entry.cleanupFinalizers.push(finalize);
    }
    if (entry.cleanupPromise) return entry.cleanupPromise;
    let resolveCleanup;
    let rejectCleanup;
    entry.cleanupPromise = new Promise((resolve, reject) => { resolveCleanup = resolve; rejectCleanup = reject; });
    entry.cleanupPromise.catch(() => {});
    const collector = entry.collector || entry.pendingCollector;
    try { entry.collectorControl?.stopAdmission(); } catch (error) { entry.cleanupFailure.capture(error); }
    let disconnected = null;
    if (collector) {
      try { disconnected = Promise.resolve(collector.disconnect()); }
      catch (error) { disconnected = Promise.reject(error); }
      disconnected.catch(() => {});
    }
    let stopped;
    try { stopped = stopCore(entry); } catch (error) { stopped = Promise.reject(error); }
    stopped.catch(() => {});
    const completion = (async () => {
      try {
        if (disconnected) {
          try {
            if ((await disconnected)?.status !== 'disconnected') {
              entry.cleanupFailure.capture(integrationError('native_instruction_isolation_unconfirmed'));
            }
          } catch (error) { entry.cleanupFailure.capture(error); }
        }
        try { await stopped; } catch (error) { entry.cleanupFailure.capture(error); }
        if (entry.collectorControl) {
          try { await entry.collectorControl.drain(); } catch (error) { entry.cleanupFailure.capture(error); }
        } else if (entry.pendingCollector) {
          entry.cleanupFailure.capture(integrationError('owned_collector_control_unavailable'));
        }
      } finally {
        entry.cleanupSettled = true;
        for (const finalizer of entry.cleanupFinalizers.splice(0)) {
          try { finalizer(); } catch (error) { entry.cleanupFailure.capture(error); }
        }
      }
      entry.cleanupFailure.throwIfFailed();
    })();
    completion.then(resolveCleanup, rejectCleanup);
    return entry.cleanupPromise;
  }

  function beginNativeShutdown() {
    const entries = [...admissions].reverse();
    const failure = createFailureCapture();
    for (const entry of entries) {
      try { entry.collectorControl?.stopAdmission(); } catch (error) { failure.capture(error); }
    }
    const stops = entries.map((entry) => {
      let pending;
      try { pending = stopCore(entry); } catch (error) { pending = Promise.reject(error); }
      pending.catch(() => {});
      return pending;
    });
    return { entries, stops, failure };
  }

  async function awaitPreparationCleanups(entries, attempt) {
    await Promise.all(entries.map((entry) => attempt(async () => {
      if (entry.cleanupPromise) await entry.cleanupPromise;
      entry.cleanupFailure.throwIfFailed();
    })));
  }

  async function drainNativeShutdown(shutdown, attempt) {
    await Promise.all(shutdown.stops.map((pending) => attempt(() => pending)));
    await Promise.all(shutdown.entries.map((entry) => attempt(() => entry.collectorControl?.drain())));
    await awaitPreparationCleanups(shutdown.entries, attempt);
  }

  function stopStandard(receipt) {
    const entry = entryFor(receipt);
    if (entry.stopPromise) return entry.stopPromise;
    entry.state = 'stopping';
    let compositionStop;
    try { compositionStop = composition.stop(receipt); }
    catch (error) { compositionStop = Promise.reject(error); }
    compositionStop.catch(() => {});
    let routerDetached = false;
    try {
      routerDetached = (entry.detach ? entry.detach() : entry.router.detachAdmission(receipt)) === true;
    } catch {}
    entry.detach = null;
    entry.isolationConfirmed = false;
    entry.stopPromise = (async () => {
      let failure = null;
      let collectorDetached = !entry.collector;
      if (entry.collector) {
        try { collectorDetached = (await entry.collector.disconnect())?.status === 'disconnected'; }
        catch (error) { failure ||= error; }
      }
      let snapshot = null;
      try { snapshot = await compositionStop; } catch (error) { failure ||= error; }
      let latest = null;
      try { latest = composition.ownedStopState(receipt); } catch (error) { failure ||= error; }
      entry.state = latest?.processState === 'stopped' ? 'stopped' : 'stop_unconfirmed';
      entry.isolationConfirmed = routerDetached && collectorDetached;
      if (latest?.processState !== 'stopped') failure ||= integrationError('native_process_stop_unconfirmed');
      if (!entry.isolationConfirmed) failure ||= integrationError('native_instruction_isolation_unconfirmed');
      if (failure) throw failure;
      return true;
    })();
    return entry.stopPromise;
  }

  function getLaunchState(receipt) {
    const entry = entryFor(receipt);
    const snapshot = composition.ownedStopState(receipt);
    if (['stopping', 'stop_unconfirmed'].includes(entry.state) && snapshot.processState === 'stopped' &&
        entry.isolationConfirmed === true) entry.state = 'stopped';
    return Object.freeze({ state: entry.state });
  }

  function instructionTargetState(launchRef) {
    const unverified = (reason = 'instruction_target_unverified') =>
      Object.freeze({ status: 'unverified', nativeTurnId: null, reason });
    if (closing) return unverified('native_instruction_integration_closed');
    const entry = admissionsByLaunchRef.get(launchRef);
    if (!entry || entry.state !== 'running') return unverified(entry ? 'native_launch_retired' : undefined);
    try { return composition.instructionTargetState(launchRef); }
    catch { return unverified(); }
  }

  function startLaunch(value) {
    if (lifetimeGate === null) return startLaunchCore(value, null);
    if (closing) throw integrationError('native_instruction_integration_closed');
    const ticket = lifetimeGate.enter('native-start');
    const lifetime = { entry: null, rejectStart: null, release: () => ticket.release() };
    try { return startLaunchCore(value, lifetime); }
    catch (error) {
      if (lifetime.entry && (lifetime.rejectStart || lifetime.entry.cleanupPromise || lifetime.entry.stopPromise)) {
        beginPreparationCleanup(lifetime.entry, () => {
          try { lifetime.rejectStart?.(error); } finally { lifetime.release(); }
        });
      } else lifetime.release();
      throw error;
    }
  }

  function startLaunchCore(value, lifetime) {
    if (closing) throw integrationError('native_instruction_integration_closed');
    const { admission, inputText, predecessorReceipt } = captureLaunchStart(value);
    let predecessor = null;
    if (predecessorReceipt !== null) {
      if (!isOpaqueCapability(predecessorReceipt)) throw integrationError('predecessor_receipt_unavailable');
      predecessor = admissionByReceipt.get(predecessorReceipt);
      if (!predecessor) throw integrationError('predecessor_receipt_unavailable');
      const priorState = ownedExecutionFor(predecessor);
      const internalState = composition.ownedStopState(predecessorReceipt);
      if (internalState.explicitStop !== true || priorState.stopConfirmed !== true ||
          predecessor.isolationConfirmed !== true) {
        throw integrationError('predecessor_stop_unconfirmed');
      }
    }
    const receipt = admitLaunchCore(admission, lifetime ? (entry) => { lifetime.entry = entry; } : null);
    const entry = entryFor(receipt);
    if (entry.startPromise) {
      if (entry.startInputText !== inputText || !entry.predecessorReceiptBound ||
          entry.predecessorReceipt !== predecessorReceipt) throw integrationError('attempt_conflict');
      lifetime?.release();
      return entry.startPromise;
    }
    if (entry.state !== 'admitted') throw integrationError('admission_retired');
    if (entry.predecessorReceiptBound && entry.predecessorReceipt !== predecessorReceipt) {
      throw integrationError('attempt_conflict');
    }
    entry.predecessorReceipt = predecessorReceipt;
    entry.predecessorReceiptBound = true;
    entry.startInputText = inputText;
    entry.state = 'starting';
    let resolveStart;
    let rejectStart;
    if (lifetime) {
      lifetime.entry = entry;
      entry.startPromise = new Promise((resolve, reject) => { resolveStart = resolve; rejectStart = reject; });
      entry.startPromise.catch(() => {});
      lifetime.rejectStart = rejectStart;
    }
    let collector;
    try {
      collector = createOwnedCollector(receipt);
    } catch (error) {
      if (lifetime === null) stop(receipt).catch(() => {});
      throw error;
    }
    const operation = (async () => {
      try {
        if (predecessor) {
          const priorState = ownedExecutionFor(predecessor);
          const internalState = composition.ownedStopState(predecessorReceipt);
          if (internalState.explicitStop !== true || priorState.stopConfirmed !== true ||
              predecessor.isolationConfirmed !== true) throw integrationError('predecessor_stop_unconfirmed');
        }
        const result = await composition.start(receipt, { inputText });
        if (entry.state !== 'starting') throw integrationError('native_launch_invalidated');
        const connection = await collector.connect();
        if (entry.state !== 'starting') throw integrationError('native_launch_invalidated');
        if (ownDataValue(connection, 'status') !== 'connected') {
          throw integrationError('native_source_initialization_unavailable');
        }
        let observation = null;
        if (entry.provider === 'codex') {
          const nativeId = result.observation?.nativeId;
          observation = nativeId ? await collector.observeKnownThread(nativeId) : null;
          if (entry.state !== 'starting') throw integrationError('native_launch_invalidated');
        }
        const activeProof = composition.resolveProof(result.launchRef) && collector.resolveProof(result.launchRef);
        const activeObserved = entry.provider !== 'codex' || ownDataValue(observation, 'status') === 'observed';
        const targetState = composition.instructionTargetState(result.launchRef);
        const stopped = ownDataValue(targetState, 'status') === 'stopped';
        if (!(activeProof && activeObserved) && !stopped) {
          throw integrationError('native_execution_proof_unavailable');
        }
        if (lifetime && (closing || entry.state !== 'starting')) throw integrationError('native_launch_invalidated');
        entry.launchRef = result.launchRef;
        admissionsByLaunchRef.set(result.launchRef, entry);
        entry.state = 'running';
        return Object.freeze({ receipt, result, collector });
      } catch (error) {
        await stop(receipt).catch(() => {});
        throw error;
      } finally {
        lifetime?.release();
      }
    })();
    if (lifetime) operation.then(resolveStart, rejectStart);
    else entry.startPromise = operation;
    return entry.startPromise;
  }

  async function close() {
    if (closePromise) return closePromise;
    let resolveClose;
    let rejectClose;
    if (lifetimeGate !== null) {
      closePromise = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    }
    closing = true;
    lifetimeGate?.stopAdmission();
    const failure = createFailureCapture();
    let contextClosePromise = null;
    try { reclamationScheduler?.stop(); } catch (error) { failure.capture(error); }
    if (reclamationContext !== null) {
      try {
        contextClosePromise = reclamationContext.close();
        contextClosePromise.catch(() => {});
      } catch (error) { failure.capture(error); }
    }
    const nativeShutdown = lifetimeGate === null ? null : beginNativeShutdown();
    if (nativeShutdown?.failure.failed) failure.capture(nativeShutdown.failure.reason);
    const shutdown = (async () => {
      const attempt = async (operation) => {
        try { await operation(); } catch (error) { failure.capture(error); }
      };
      try { stopSettingsNotifications(); } catch (error) { failure.capture(error); }
      await attempt(() => questionService?.close());
      await attempt(() => service.close());
      if (nativeShutdown) await drainNativeShutdown(nativeShutdown, attempt);
      else for (const entry of [...admissions].reverse()) await attempt(() => stop(entry.receipt));
      for (const router of Object.values(routers)) {
        try { router.close(); } catch (error) { failure.capture(error); }
      }
      if (reclamationContext === null) await attempt(() => store.flush());
      await attempt(() => store.close());
      await attempt(() => reclamationScheduler?.drain());
      if (contextClosePromise !== null) await attempt(() => contextClosePromise);
      if (lifetimeGate !== null) {
        await attempt(() => lifetimeGate.drain());
        await awaitPreparationCleanups(nativeShutdown.entries, attempt);
      }
      failure.throwIfFailed();
    })();
    if (lifetimeGate === null) closePromise = shutdown;
    else shutdown.then(resolveClose, rejectClose);
    return closePromise;
  }

  const native = Object.freeze({ admitLaunch, createOwnedCollector, startLaunch, stop, getLaunchState,
    ownedExecutionSnapshot, getOwnedStopState, stopOwnedExecution });
  function readQuestionHealth() {
    if (reclamationContext === null) return 'known';
    try {
      return reclamationContext.status().slotHealth?.questions === 'uncertain' ? 'uncertain' : 'known';
    } catch { return 'unknown'; }
  }
  function getQuestionQuarantineStatus(questionHealth) {
    if (!questionService) return null;
    if (questionHealth !== 'known') {
      return Object.freeze({ status: 'unavailable', reason: questionHealth === 'uncertain'
        ? 'question_journal_uncertain' : 'question_quarantine_status_unavailable',
        quarantinedCount: 0, reservedBytes: null, remainingBytes: null, remainingCount: null });
    }
    const unavailable = Object.freeze({ status: 'unavailable', reason: 'question_quarantine_status_unavailable',
      quarantinedCount: 0, reservedBytes: null, remainingBytes: null, remainingCount: null });
    try {
      const method = questionService.getQuarantineDiagnostics;
      if (typeof method !== 'function') return unavailable;
      const value = method.call(questionService);
      if (utilTypes.isPromise(value)) { swallowRejectedPromise(value); return unavailable; }
      if (hasThenMember(value) || !isRecord(value)) return unavailable;
      const status = ownDataValue(value, 'status');
      const reason = ownDataValue(value, 'reason');
      const quarantinedCount = ownDataValue(value, 'quarantinedCount');
      const reservedBytes = ownDataValue(value, 'reservedBytes');
      const remainingBytes = ownDataValue(value, 'remainingBytes');
      const remainingCount = ownDataValue(value, 'remainingCount');
      const validCount = (count) => Number.isSafeInteger(count) && count >= 0;
      const validSize = (size) => size === null || validCount(size);
      if (!['ready', 'blocked', 'unavailable'].includes(status) ||
          !(reason === null || typeof reason === 'string' && /^[a-z][a-z0-9_]{0,79}$/.test(reason)) ||
          !validCount(quarantinedCount) || !validSize(reservedBytes) ||
          !validSize(remainingBytes) || !validSize(remainingCount)) return unavailable;
      return Object.freeze({ status, reason, quarantinedCount, reservedBytes, remainingBytes, remainingCount });
    } catch { return unavailable; }
  }
  function getStatus() {
    const questionHealth = readQuestionHealth();
    return Object.freeze({ commonQuestions: Object.freeze({
      status: closing ? 'closed' : questionService
        ? questionHealth === 'known' ? 'ready' : 'unavailable'
        : 'unconfigured',
      settings: options.commonQuestions ? getSettingsStatus() : null,
      quarantine: getQuestionQuarantineStatus(questionHealth),
    }) });
  }
  function retireQuestionPeriod(value) {
    if (reclamationContext === null) throw integrationError('reclamation_unavailable');
    if (closing) throw integrationError('native_instruction_integration_closed');
    let keys;
    try {
      if (!isRecord(value)) throw new TypeError();
      keys = Reflect.ownKeys(value);
    } catch {
      throw integrationError('invalid_question_period_retirement');
    }
    const hasReason = keys.includes('reason');
    const request = exactData(value, hasReason ? ['identity', 'periodId', 'reason'] : ['identity', 'periodId'],
      'invalid_question_period_retirement');
    return runLifetimeOperation('retire-question-period', () =>
      reclamationContext.retireQuestionPeriod({ ...request, questionService, deliveryStore: store }));
  }
  function reclaimQuestionBodies(value) {
    if (reclamationContext === null) throw integrationError('reclamation_unavailable');
    if (closing) throw integrationError('native_instruction_integration_closed');
    const captured = exactData(value, ['identity', 'periodId'], 'invalid_question_body_reclamation');
    const request = Object.freeze({
      identity: Object.freeze(exactData(captured.identity, QUESTION_RECLAMATION_IDENTITY_FIELDS,
        'invalid_question_body_reclamation')),
      periodId: captured.periodId,
    });
    return runLifetimeOperation('reclaim-question-bodies', () => reclamationContext.reclaimQuestionBodies({
      ...request,
      questionService,
      deliveryStore: store,
    }));
  }
  function reclaimInstructionBody(value) {
    if (reclamationContext === null) throw integrationError('reclamation_unavailable');
    if (closing) throw integrationError('native_instruction_integration_closed');
    const request = Object.freeze(exactData(value, ['deliveryAttemptId'], 'invalid_instruction_body_reclamation'));
    return runLifetimeOperation('reclaim-instruction-body', () =>
      reclamationContext.reclaimInstructionBody({ ...request, instructionService: service, deliveryStore: store }));
  }
  function reclaimTerminalDeliveryBody(value) {
    if (reclamationContext === null) throw integrationError('reclamation_unavailable');
    if (closing) throw integrationError('native_instruction_integration_closed');
    const request = Object.freeze(exactData(value, ['deliveryAttemptId'], 'invalid_terminal_delivery_body_reclamation'));
    return runLifetimeOperation('reclaim-terminal-delivery-body', () =>
      reclamationContext.reclaimTerminalDeliveryBody({ ...request, deliveryStore: store }));
  }
  function releaseMigrationAllowance(value) {
    if (reclamationContext === null) throw integrationError('reclamation_unavailable');
    if (closing) throw integrationError('native_instruction_integration_closed');
    const request = exactData(value, ['slot'], 'invalid_migration_allowance_release');
    if (typeof request.slot !== 'string' || !['questions', 'instructions', 'checkpoint'].includes(request.slot)) {
      throw integrationError('invalid_migration_allowance_release');
    }
    const writer = request.slot === 'questions' ? questionService : request.slot === 'instructions' ? service : store;
    return runLifetimeOperation('release-migration-allowance', () =>
      reclamationContext.releaseMigrationAllowance({ slot: request.slot, writer }));
  }
  function runLifetimeOperation(kind, operation) {
    const ticket = lifetimeGate.enter(kind);
    try {
      return Promise.resolve(operation()).finally(() => ticket.release());
    } catch (error) {
      ticket.release();
      throw error;
    }
  }
  const reclamation = reclamationContext === null ? null : Object.freeze({
    status: () => reclamationScheduler === null ? reclamationContext.status() :
      Object.freeze({ ...reclamationContext.status(), scheduler: reclamationScheduler.status() }),
    retireQuestionPeriod,
    reclaimQuestionBodies,
    reclaimInstructionBody,
    reclaimTerminalDeliveryBody,
    releaseMigrationAllowance,
  });
  async function runScheduledReclamation(operation) {
    if (closing) return Object.freeze({ status: 'skipped' });
    try {
      const result = await operation();
      return Object.freeze({ status: result.status });
    }
    catch (error) {
      if (closing) return Object.freeze({ status: 'skipped' });
      if (reclamationContext.isQuestionUncertaintyError(error) &&
          reclamationContext.listReclamationCandidates().state === 'degraded') {
        return Object.freeze({ status: 'skipped' });
      }
      throw error;
    }
  }
  if (options.reclamation?.autoReclaim) {
    try {
      reclamationScheduler = createReclamationScheduler({
        ...options.reclamation.autoReclaim,
        listCandidates: () => reclamationContext.listReclamationCandidates(),
        reclaimCandidate: (candidate) => runScheduledReclamation(() => {
          if (candidate.kind === 'question-period') {
            return reclaimQuestionBodies({ identity: candidate.identity, periodId: candidate.periodId });
          }
          const request = { deliveryAttemptId: candidate.deliveryAttemptId };
          return candidate.kind === 'instruction' ? reclaimInstructionBody(request) :
            reclaimTerminalDeliveryBody(request);
        }),
        releaseGrants: (slot) => runScheduledReclamation(() => releaseMigrationAllowance({ slot })),
      });
      const startupTicket = lifetimeGate.enter('scheduler-start');
      try { reclamationScheduler.start(); }
      finally { startupTicket.release(); }
    } catch (error) {
      try { await cleanupPartial(); }
      catch (cleanupError) {
        throw new AggregateError([error, cleanupError], 'native instruction integration startup cleanup failed',
          { cause: error });
      }
      throw error;
    }
  }
  return Object.freeze({
    native,
    service,
    questionService,
    ...(reclamation ? { reclamation } : {}),
    registrationRegistry: registrationKernel.registry,
    launchRegistry: launchKernel.registry,
    checkpointPath,
    journalPath,
    commonQuestionJournalPath,
    getStatus,
    instructionTargetState,
    close,
  });
}

async function startNativeInstructionServer(inputOptions) {
  let fields;
  try { fields = Reflect.ownKeys(inputOptions); } catch { throw integrationError('invalid_native_server_options'); }
  if (!isRecord(inputOptions) || fields.some((field) => typeof field !== 'string' ||
      !['integrationOptions', 'serverOptions'].includes(field)) || !fields.includes('integrationOptions')) {
    throw integrationError('invalid_native_server_options');
  }
  const options = exactData(inputOptions, fields, 'invalid_native_server_options');
  const serverOptions = options.serverOptions === undefined ? {} : options.serverOptions;
  if (!isRecord(serverOptions)) throw integrationError('invalid_native_server_options');
  const homeDir = ownDataValue(serverOptions, 'homeDir');
  if (typeof homeDir !== 'string' || !path.isAbsolute(homeDir)) {
    throw integrationError('native_server_home_required');
  }
  const previousShutdown = ownDataValue(serverOptions, 'onShutdown');
  if (previousShutdown !== undefined && typeof previousShutdown !== 'function') {
    throw integrationError('invalid_native_server_options');
  }
  const commonQuestions = captureCommonQuestions(ownDataValue(options.integrationOptions, 'commonQuestions'));
  const serverAway = ownDataValue(serverOptions, 'away');
  if (commonQuestions && serverAway !== undefined && serverAway !== commonQuestions.away) {
    throw integrationError('common_question_away_mismatch');
  }
  const integration = await createNativeInstructionServiceIntegration(options.integrationOptions);
  let runtime;
  let closePromise = null;
  try {
    const { startServer } = require('./server');
    runtime = await startServer({
      ...serverOptions,
      ...(integration.questionService ? {
        away: commonQuestions.away,
        questionService: integration.questionService,
      } : {}),
      registrationRegistry: integration.registrationRegistry,
      launchRegistry: integration.launchRegistry,
      instructionService: integration.service,
      instructionTargetState: integration.instructionTargetState,
      ownedExecutionSnapshot: integration.native.ownedExecutionSnapshot,
      stopOwnedExecution: integration.native.stopOwnedExecution,
      onShutdown: async () => {
        let failure = null;
        try { await integration.close(); } catch (error) { failure = error; }
        try { await previousShutdown?.(); } catch (error) { failure ||= error; }
        if (failure) throw failure;
      },
    });
  } catch (error) {
    try {
      await integration.close();
    } catch (shutdownError) {
      throw new AggregateError([error, shutdownError], 'native instruction server startup cleanup failed', { cause: error });
    }
    throw error;
  }
  async function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      let failure = null;
      try { await runtime.close(); } catch (error) { failure = error; }
      try { await integration.close(); } catch (error) { failure ||= error; }
      if (failure) throw failure;
    })();
    return closePromise;
  }
  return Object.freeze({ ...runtime, instructionService: integration.service, native: integration.native,
    ...(integration.reclamation ? { reclamation: integration.reclamation } : {}), close,
    get shutdownError() { return runtime.shutdownError; } });
}

function createNativeInstructionOwnerRouter(options) {
  const { provider, composition } = exactData(options, ['provider', 'composition'], 'invalid_router_options');
  const createOwner = dataMethod(composition, 'createInstructionOwner');
  if (!PROVIDERS.has(provider) || !createOwner) throw integrationError('invalid_router_options');

  const admissions = new WeakMap();
  const capabilities = new WeakMap();
  const entries = new Set();
  const listeners = new Set();
  const closedListeners = new Set();
  let closed = false;

  function ownerMethods(owner) {
    const methods = Object.fromEntries(ROUTER_METHODS.map((name) => [name, dataMethod(owner, name)]));
    for (const name of ['closeInstructionObservation', 'subscribeInstructionClosed']) methods[name] = dataMethod(owner, name);
    if (ROUTER_METHODS.some((name) => typeof methods[name] !== 'function') ||
        ROUTER_METHODS.some((name) => utilTypes.isAsyncFunction(methods[name]))) {
      throw integrationError('native_instruction_owner_invalid');
    }
    return methods;
  }

  function emitEvidence(entry, capability, evidence) {
    const route = isOpaqueCapability(capability) ? capabilities.get(capability) : null;
    if (closed || !entry.active || entry.retired || !route || route === RETIRED_CAPABILITY ||
        route.entry !== entry) return false;
    let accepted = false;
    for (const listener of [...listeners]) {
      if (closed || !entry.active || entry.retired || capabilities.get(capability) !== route) return accepted;
      if (!listeners.has(listener)) continue;
      try {
        if (listener(capability, evidence) === true) accepted = true;
      } catch {}
    }
    return accepted;
  }

  function retireEntry(entry) {
    if (!entry.active) return false;
    entry.active = false;
    for (const capability of entry.capabilities || []) {
      for (const listener of [...closedListeners]) { try { listener(capability, 'instruction_source_invalid'); } catch {} }
    }
    entry.unsubscribeClosed?.();
    entries.delete(entry);
    const unsubscribe = entry.unsubscribe;
    entry.unsubscribe = null;
    if (unsubscribe) {
      try { unsubscribe(); } catch {}
    }
    return true;
  }

  function attachAdmission(admissionReceipt) {
    if (closed) throw integrationError('native_instruction_router_closed');
    if (!isOpaqueCapability(admissionReceipt)) throw integrationError('admission_receipt_unavailable');
    const prior = admissions.get(admissionReceipt);
    if (prior) {
      if (prior.entry.active) return prior.detach;
      throw integrationError('admission_already_detached');
    }

    const owner = createOwner.call(composition, admissionReceipt);
    const methods = ownerMethods(owner);
    const entry = { owner, methods, active: false, retired: false, unsubscribe: null, unsubscribeClosed: null, capabilities: new Set() };
    const detach = () => retireEntry(entry);
    const onEvidence = (capability, evidence) => emitEvidence(entry, capability, evidence);
    const unsubscribe = methods.subscribeInstructionEvidence.call(owner, onEvidence);
    if (typeof unsubscribe !== 'function') throw integrationError('native_instruction_owner_invalid');

    entry.unsubscribe = unsubscribe;
    if (['subscribeInstructionClosed', 'closeInstructionObservation'].every(name =>
      typeof methods[name] === 'function' && !utilTypes.isAsyncFunction(methods[name]))) {
      entry.unsubscribeClosed = methods.subscribeInstructionClosed.call(owner, (capability, reason) => {
        const route = capabilities.get(capability);
        if (!route || route === RETIRED_CAPABILITY || route.entry !== entry || !entry.active) return;
        for (const listener of [...closedListeners]) { try { listener(capability, reason); } catch {} }
      });
      if (typeof entry.unsubscribeClosed !== 'function') { unsubscribe(); throw integrationError('native_instruction_owner_invalid'); }
    }
    entry.active = true;
    entries.add(entry);
    admissions.set(admissionReceipt, { entry, detach });
    return detach;
  }

  function detachAdmission(admissionReceipt) {
    if (!isOpaqueCapability(admissionReceipt)) return false;
    const admission = admissions.get(admissionReceipt);
    return admission ? admission.detach() : false;
  }

  function prepareInstructionDispatch(metadata) {
    if (closed || providerInMetadata(metadata) !== provider) return null;
    const metadataFingerprint = fingerprintMetadata(metadata);
    if (metadataFingerprint === null) return null;
    for (const entry of entries) {
      if (!entry.active || entry.retired) continue;
      let capability;
      try {
        capability = entry.methods.prepareInstructionDispatch.call(entry.owner, metadata);
      } catch {
        return null;
      }
      if (capability === null) continue;
      if (utilTypes.isPromise(capability)) {
        swallowRejectedPromise(capability);
        return null;
      }
      if (!isOpaqueCapability(capability) || hasThenMember(capability)) return null;
      const previous = capabilities.get(capability);
      if (previous !== undefined) {
        if (previous !== RETIRED_CAPABILITY && previous.entry === entry &&
            previous.metadataFingerprint === metadataFingerprint && entry.active && !entry.retired) {
          return capability;
        }
        if (previous !== RETIRED_CAPABILITY) previous.entry.retired = true;
        entry.retired = true;
        capabilities.set(capability, RETIRED_CAPABILITY);
        return null;
      }
      if (closed || !entry.active || entry.retired) {
        capabilities.set(capability, RETIRED_CAPABILITY);
        return null;
      }
      if (entry.unsubscribeClosed && entry.capabilities.size >= MAX_OBSERVATION_CAPABILITIES) {
        try { entry.methods.closeInstructionObservation.call(entry.owner, capability, metadata); } catch {}
        return null;
      }
      capabilities.set(capability, { entry, metadataFingerprint });
      if (entry.unsubscribeClosed) entry.capabilities.add(capability);
      return capability;
    }
    return null;
  }

  function checkInstructionDispatch(capability, metadata) {
    const route = isOpaqueCapability(capability) ? capabilities.get(capability) : null;
    if (!route || route === RETIRED_CAPABILITY || closed || !route.entry.active || route.entry.retired) return false;
    const entry = route.entry;
    let result;
    try {
      result = entry.methods.checkInstructionDispatch.call(entry.owner, capability, metadata);
    } catch {
      return false;
    }
    if (utilTypes.isPromise(result)) {
      swallowRejectedPromise(result);
      return false;
    }
    return result === true && !closed && entry.active && !entry.retired && capabilities.get(capability) === route;
  }

  function dispatchInstructionNow(capability, command) {
    const route = isOpaqueCapability(capability) ? capabilities.get(capability) : null;
    if (!route || route === RETIRED_CAPABILITY || closed || !route.entry.active || route.entry.retired) {
      throw integrationError('instruction_dispatch_unavailable');
    }
    return route.entry.methods.dispatchInstructionNow.call(route.entry.owner, capability, command);
  }

  function subscribeInstructionEvidence(listener) {
    if (closed || typeof listener !== 'function') {
      throw integrationError('instruction_evidence_source_unavailable');
    }
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function supportsLateInstructionEvidence(capability) {
    const route = isOpaqueCapability(capability) ? capabilities.get(capability) : null;
    return Boolean(route && route !== RETIRED_CAPABILITY && route.entry.active && !route.entry.retired && route.entry.unsubscribeClosed);
  }
  function closeInstructionObservation(capability, metadata) {
    const route = isOpaqueCapability(capability) ? capabilities.get(capability) : null;
    if (!route || route === RETIRED_CAPABILITY || route.metadataFingerprint !== fingerprintMetadata(metadata)) return false;
    const method = route.entry.methods.closeInstructionObservation;
    if (typeof method !== 'function') return false;
    capabilities.set(capability, RETIRED_CAPABILITY);
    route.entry.capabilities.delete(capability);
    return method.call(route.entry.owner, capability, metadata) === true;
  }
  function subscribeInstructionClosed(listener) {
    if (closed || typeof listener !== 'function') throw integrationError('instruction_evidence_source_unavailable');
    closedListeners.add(listener); return () => closedListeners.delete(listener);
  }

  function close() {
    if (closed) return;
    closed = true;
    for (const entry of [...entries]) retireEntry(entry);
    listeners.clear();
    closedListeners.clear();
  }

  return Object.freeze({
    provider,
    attachAdmission,
    detachAdmission,
    prepareInstructionDispatch,
    checkInstructionDispatch,
    dispatchInstructionNow,
    subscribeInstructionEvidence,
    supportsLateInstructionEvidence,
    closeInstructionObservation,
    subscribeInstructionClosed,
    close,
  });
}

module.exports = {
  createNativeInstructionOwnerRouter,
  createNativeInstructionServiceIntegration,
  startNativeInstructionServer,
};
