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
const PROFILE_FIELDS = ['provider', 'executablePath', 'homePath', 'homeScopeId', 'cwd'];
const PROFILE_FIELDS_WITH_RUNNER = [...PROFILE_FIELDS, 'runnerProfile'];
const FACTORY_FIELDS = [
  'profiles', 'dataDirectory', 'hostId', 'runnerFactory', 'getAuthentication',
  'onAuthenticationRequired', 'now', 'checkpointAtomicWrite', 'journalAtomicWrite', 'storeLimits',
];
const START_FIELDS = ['launchId', 'runId', 'attemptId', 'profileId', 'origin', 'purpose', 'inputText'];

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
  };
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
      ![...START_FIELDS, 'originReceipt'].includes(field))) {
    throw integrationError('invalid_native_launch_start');
  }
  const expected = fields.includes('originReceipt') ? [...START_FIELDS, 'originReceipt'] : START_FIELDS;
  const input = exactData(value, expected, 'invalid_native_launch_start');
  if (typeof input.inputText !== 'string') throw integrationError('invalid_native_launch_start');
  const admission = {};
  for (const field of ['launchId', 'runId', 'attemptId', 'profileId', 'origin', 'purpose', 'originReceipt']) {
    if (Object.hasOwn(input, field)) admission[field] = input[field];
  }
  return { admission, inputText: input.inputText };
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
  let composition;
  let routers = {};
  let store;
  let journal;
  let providerDeliveryAdapters;
  let providerInstructionAdapters;
  let service;

  async function cleanupPartial() {
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
      existing.detach = routers[provider].attachAdmission(receipt);
      return receipt;
    }
    const entry = { receipt, provider, router: routers[provider], detach: null, collector: null,
      state: 'admitted', startInputText: null, startPromise: null, stopPromise: null };
    admissionByReceipt.set(receipt, entry);
    admissions.add(entry);
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
    try {
      if (entry.detach) entry.detach();
      else entry.router.detachAdmission(receipt);
    } catch {}
    entry.detach = null;
    entry.stopPromise = (async () => {
      let failure = null;
      try { await entry.collector?.disconnect?.(); } catch (error) { failure ||= error; }
      let snapshot = null;
      try { snapshot = await composition.stop(receipt); } catch (error) { failure ||= error; }
      entry.state = snapshot?.processState === 'stopped' ? 'stopped' : 'stop_unconfirmed';
      if (entry.state !== 'stopped') failure ||= integrationError('native_process_stop_unconfirmed');
      if (failure) throw failure;
      return true;
    })();
    return entry.stopPromise;
  }

  function getLaunchState(receipt) {
    return Object.freeze({ state: entryFor(receipt).state });
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
    const { admission, inputText } = captureLaunchStart(value);
    const receipt = admitLaunch(admission);
    const entry = entryFor(receipt);
    if (entry.startPromise) {
      if (entry.startInputText !== inputText) throw integrationError('attempt_conflict');
      return entry.startPromise;
    }
    if (entry.state !== 'admitted') throw integrationError('admission_retired');
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
        const connection = Promise.resolve(collector.connect());
        const starting = composition.start(receipt, { inputText });
        const [result] = await Promise.all([starting, connection]);
        if (entry.state !== 'starting') throw integrationError('native_launch_invalidated');
        if (entry.provider === 'codex') {
          const nativeId = result.observation?.nativeId;
          const observation = nativeId ? await collector.observeKnownThread(nativeId) : null;
          if (observation?.status !== 'observed') throw integrationError('native_source_initialization_unavailable');
        }
        if (!composition.resolveProof(result.launchRef) || !collector.resolveProof(result.launchRef)) {
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
      await attempt(() => service.close());
      for (const router of Object.values(routers)) {
        try { router.close(); } catch (error) { failure ||= error; }
      }
      for (const entry of [...admissions].reverse()) await attempt(() => stop(entry.receipt));
      await attempt(() => store.flush());
      await attempt(() => store.close());
      if (failure) throw failure;
    })();
    return closePromise;
  }

  const native = Object.freeze({ admitLaunch, createOwnedCollector, startLaunch, stop, getLaunchState });
  return Object.freeze({
    native,
    service,
    registrationRegistry: registrationKernel.registry,
    launchRegistry: launchKernel.registry,
    checkpointPath,
    journalPath,
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
  const integration = await createNativeInstructionServiceIntegration(options.integrationOptions);
  let runtime;
  let closePromise = null;
  try {
    const { startServer } = require('./server');
    runtime = await startServer({
      ...serverOptions,
      registrationRegistry: integration.registrationRegistry,
      launchRegistry: integration.launchRegistry,
      instructionService: integration.service,
      instructionTargetState: integration.instructionTargetState,
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
  let closed = false;

  function ownerMethods(owner) {
    const methods = Object.fromEntries(ROUTER_METHODS.map((name) => [name, dataMethod(owner, name)]));
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
    const entry = { owner, methods, active: false, retired: false, unsubscribe: null };
    const detach = () => retireEntry(entry);
    const onEvidence = (capability, evidence) => emitEvidence(entry, capability, evidence);
    const unsubscribe = methods.subscribeInstructionEvidence.call(owner, onEvidence);
    if (typeof unsubscribe !== 'function') throw integrationError('native_instruction_owner_invalid');

    entry.unsubscribe = unsubscribe;
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
      capabilities.set(capability, { entry, metadataFingerprint });
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

  function close() {
    if (closed) return;
    closed = true;
    for (const entry of [...entries]) retireEntry(entry);
    listeners.clear();
  }

  return Object.freeze({
    provider,
    attachAdmission,
    detachAdmission,
    prepareInstructionDispatch,
    checkInstructionDispatch,
    dispatchInstructionNow,
    subscribeInstructionEvidence,
    close,
  });
}

module.exports = {
  createNativeInstructionOwnerRouter,
  createNativeInstructionServiceIntegration,
  startNativeInstructionServer,
};
