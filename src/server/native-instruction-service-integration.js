'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { types: utilTypes } = require('node:util');
const { createRegistrationKernel } = require('./conversation-registry');
const { createLaunchBindingKernel } = require('./launch-binding');
const { createRuntimeBindingKernel } = require('./runtime-binding');
const { createDurableDeliveryStore, createProviderDeliveryAdapter } = require('./durable-delivery-store');
const { createInstructionDeliveryJournal } = require('./instruction-delivery-journal');
const { createInstructionDeliveryService } = require('./instruction-delivery-service');
const { createProviderInstructionAdapter } = require('./provider-instruction-adapter');
const { createNativeLaunchComposition } = require('./native-launch-composition');
const { createCommonQuestionService } = require('./common-question-service');

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
const FACTORY_FIELDS = [
  'profiles', 'dataDirectory', 'hostId', 'runnerFactory', 'getAuthentication',
  'onAuthenticationRequired', 'now', 'checkpointAtomicWrite', 'journalAtomicWrite', 'storeLimits',
  'commonQuestions',
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

function captureFactoryOptions(value) {
  let fields;
  try { fields = Reflect.ownKeys(value); } catch { throw integrationError('invalid_native_integration_options'); }
  if (!isRecord(value) || fields.some((key) => typeof key !== 'string' || !FACTORY_FIELDS.includes(key)) ||
      !['profiles', 'dataDirectory', 'hostId'].every((field) => fields.includes(field))) {
    throw integrationError('invalid_native_integration_options');
  }
  const options = exactData(value, fields, 'invalid_native_integration_options');
  const profiles = captureProfiles(options.profiles);
  const dataDirectory = options.dataDirectory;
  if (typeof dataDirectory !== 'string' || !path.isAbsolute(dataDirectory) || !dataDirectory.trim()) {
    throw integrationError('invalid_native_integration_options');
  }
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
    commonQuestions: captureCommonQuestions(options.commonQuestions),
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

  const registrationKernel = createRegistrationKernel();
  const launchKernel = createLaunchBindingKernel({ registrationRegistry: registrationKernel.registry });
  const runtimeKernel = createRuntimeBindingKernel({
    registrationRegistry: registrationKernel.registry,
    launchRegistry: launchKernel.registry,
  });
  const profileProviders = new Map(Object.entries(profiles).map(([profileId, profile]) => [profileId, profile.provider]));
  const checkpointPath = path.join(dataDirectory, 'delivery-checkpoint.json');
  const journalPath = path.join(dataDirectory, 'instruction-journal.json');
  const commonQuestionJournalPath = options.commonQuestions
    ? path.join(dataDirectory, 'common-question-journal.json') : null;
  let composition;
  let routers = {};
  let store;
  let journal;
  let providerDeliveryAdapters;
  let providerInstructionAdapters;
  let service;
  let questionService = null;
  let unsubscribeSettings = null;
  let acceptingSettings = true;

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
    try { stopSettingsNotifications(); } catch {}
    try { await questionService?.close?.(); } catch {}
    try { await service?.close?.(); } catch {}
    if (!service) {
      for (const adapter of Object.values(providerInstructionAdapters || {})) {
        try { adapter?.close?.(); } catch {}
      }
      for (const adapter of Object.values(providerDeliveryAdapters || {})) {
        try { adapter?.close?.(); } catch {}
      }
      try { await journal?.close?.(); } catch {}
    }
    for (const router of Object.values(routers)) {
      try { router.close(); } catch {}
    }
    try { await store?.flush?.(); } catch {}
    try { await store?.close?.(); } catch {}
  }

  try {
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
      ...(options.checkpointAtomicWrite ? { atomicWrite: options.checkpointAtomicWrite } : {}),
      ...(options.storeLimits ? { limits: options.storeLimits } : {}),
    });
    journal = createInstructionDeliveryJournal({
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
      ...(options.now ? { now: options.now } : {}),
    });
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
      const unsubscribe = options.commonQuestions.subscribe.call(options.commonQuestions.settings, notifySettingsChanged);
      if (utilTypes.isPromise(unsubscribe)) swallowRejectedPromise(unsubscribe);
      if (typeof unsubscribe !== 'function' || hasThenMember(unsubscribe)) {
        throw integrationError('invalid_common_question_subscription');
      }
      unsubscribeSettings = unsubscribe;
    }
  } catch (error) {
    await cleanupPartial();
    throw error;
  }

  const admissionByReceipt = new WeakMap();
  const admissions = new Set();
  const admissionsByLaunchRef = new Map();
  let closing = false;
  let closePromise = null;

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
      return receipt;
    }
    const entry = { receipt, provider, router: routers[provider], detach: null, collector: null,
      state: 'admitted', startInputText: null, startPromise: null, stopPromise: null,
      launchRef: null, isolationConfirmed: false, predecessorReceipt: null, predecessorReceiptBound: false };
    entry.launchRef = composition.ownedStopState(receipt).launchRef;
    admissionByReceipt.set(receipt, entry);
    admissions.add(entry);
    admissionsByLaunchRef.set(entry.launchRef, entry);
    try {
      entry.detach = entry.router.attachAdmission(receipt);
    } catch (error) {
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
    if (!entry.collector) entry.collector = composition.createOwnedCollector(receipt, collectorOptions);
    return entry.collector;
  }

  function stop(receipt) {
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
    const receipt = admitLaunch(admission);
    const entry = entryFor(receipt);
    if (entry.startPromise) {
      if (entry.startInputText !== inputText || !entry.predecessorReceiptBound ||
          entry.predecessorReceipt !== predecessorReceipt) throw integrationError('attempt_conflict');
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
    let collector;
    try {
      collector = createOwnedCollector(receipt);
    } catch (error) {
      stop(receipt).catch(() => {});
      throw error;
    }
    entry.startPromise = (async () => {
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
        entry.launchRef = result.launchRef;
        admissionsByLaunchRef.set(result.launchRef, entry);
        entry.state = 'running';
        return Object.freeze({ receipt, result, collector });
      } catch (error) {
        await stop(receipt).catch(() => {});
        throw error;
      }
    })();
    return entry.startPromise;
  }

  async function close() {
    if (closePromise) return closePromise;
    closing = true;
    closePromise = (async () => {
      let failure = null;
      const attempt = async (operation) => {
        try { await operation(); } catch (error) { failure ||= error; }
      };
      try { stopSettingsNotifications(); } catch (error) { failure ||= error; }
      await attempt(() => questionService?.close());
      await attempt(() => service.close());
      for (const entry of [...admissions].reverse()) await attempt(() => stop(entry.receipt));
      for (const router of Object.values(routers)) {
        try { router.close(); } catch (error) { failure ||= error; }
      }
      await attempt(() => store.flush());
      await attempt(() => store.close());
      if (failure) throw failure;
    })();
    return closePromise;
  }

  const native = Object.freeze({ admitLaunch, createOwnedCollector, startLaunch, stop, getLaunchState,
    ownedExecutionSnapshot, getOwnedStopState, stopOwnedExecution });
  function getQuestionQuarantineStatus() {
    if (!questionService) return null;
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
    return Object.freeze({ commonQuestions: Object.freeze({
      status: closing ? 'closed' : questionService ? 'ready' : 'unconfigured',
      settings: options.commonQuestions ? getSettingsStatus() : null,
      quarantine: getQuestionQuarantineStatus(),
    }) });
  }
  return Object.freeze({
    native,
    service,
    questionService,
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
  return Object.freeze({ ...runtime, instructionService: integration.service, native: integration.native, close,
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
