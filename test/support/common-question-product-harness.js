'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { createRegistrationKernel } = require('../../src/server/conversation-registry');
const { createProviderRegistrationAdapter } = require('../../src/server/provider-registration');
const { createLaunchBindingKernel, createProviderLaunchAdapter } = require('../../src/server/launch-binding');
const { createRuntimeBindingKernel, createProviderRuntimeAdapter } = require('../../src/server/runtime-binding');
const { createDurableDeliveryStore } = require('../../src/server/durable-delivery-store');
const { createCommonQuestionService } = require('../../src/server/common-question-service');

const PROVIDERS = Object.freeze(['claude', 'codex']);
const NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });
const CLAIM_FIELDS = Object.freeze([
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding', 'identity', 'executionBinding',
]);

function otherProvider(provider) {
  return provider === 'claude' ? 'codex' : 'claude';
}

function evidence(evidenceId, registrationRef = undefined) {
  return {
    evidenceId,
    source: 'authenticated-test-fixture',
    method: 'product-conformance-fixture',
    adapterVersion: 'fixture-adapter-1',
    runtimeVersion: 'fixture-runtime-1',
    ...(registrationRef === undefined ? {} : { registrationRef }),
    capabilities: ['native-binding'],
  };
}

function copyClaims(record) {
  return Object.fromEntries(CLAIM_FIELDS.map((field) => [
    field,
    ['originBinding', 'executionBinding', 'identity'].includes(field)
      ? structuredClone(record[field])
      : record[field],
  ]));
}

async function createCommonQuestionProductHarness(options = {}) {
  const { provider, directory } = options;
  if (!PROVIDERS.includes(provider) || typeof directory !== 'string' || directory.length === 0) {
    throw new TypeError('provider and directory are required');
  }
  if (options.nativeId !== undefined && (provider !== 'codex' || typeof options.nativeId !== 'string' || !options.nativeId)) {
    throw new TypeError('nativeId override is only valid for a Codex fixture');
  }
  await fs.mkdir(directory, { recursive: true });

  const registrationKernel = createRegistrationKernel();
  const registrationAdapters = Object.fromEntries(PROVIDERS.map((item) => [
    item,
    createProviderRegistrationAdapter(item, registrationKernel.registry, registrationKernel.authority),
  ]));
  let serial = 0;
  let restoreSequence = 0;
  const periodsById = new Map();
  function registerPeriod(periodProvider, suffix, role, nativeOverride = undefined, resume = false) {
    serial += 1;
    const nativeIdentity = typeof nativeOverride === 'object' && nativeOverride !== null
      ? {
        nativeIdKind: nativeOverride.nativeIdKind,
        hostId: nativeOverride.hostId,
        homeScopeId: nativeOverride.homeScopeId,
        nativeId: nativeOverride.nativeId,
      }
      : {
        nativeIdKind: NATIVE_ID_KINDS[periodProvider],
        hostId: 'host-' + suffix,
        homeScopeId: 'home-' + suffix,
        nativeId: nativeOverride === undefined ? periodProvider + '-native-' + suffix : nativeOverride,
      };
    const identity = { provider: periodProvider, ...nativeIdentity };
    const registration = registrationAdapters[periodProvider].register(
      nativeIdentity,
      evidence('period-evidence-' + serial + '-' + suffix),
      {
        startId: 'start-' + serial + '-' + suffix,
        ...(periodProvider === 'claude' && !(typeof nativeOverride === 'object' && nativeOverride !== null)
          ? { projectionId: nativeIdentity.nativeId } : {}),
        ...(resume ? { resume: true } : {}),
      },
    );
    const contextId = 'context-' + serial + '-' + suffix;
    const actor = role === 'execution'
      ? { kind: 'agent', id: 'agent-' + serial + '-' + suffix }
      : { kind: 'tool-use', id: 'tool-use-' + serial + '-' + suffix };
    const writer = role === 'execution'
      ? registrationAdapters[periodProvider].bindWriter(registration.executionId, {
        identity,
        contextId,
        evidence: evidence('writer-evidence-' + serial + '-' + suffix),
      })
      : null;
    const period = { provider: periodProvider, identity, nativeIdentity, registration, contextId, actor, writer };
    periodsById.set(registration.executionId, period);
    return period;
  }

  const launchKernel = createLaunchBindingKernel({ registrationRegistry: registrationKernel.registry });
  const launchAdapters = Object.fromEntries(PROVIDERS.map((item) => [
    item,
    createProviderLaunchAdapter(item, launchKernel.registry, launchKernel.authority),
  ]));
  const runtimeKernel = createRuntimeBindingKernel({
    registrationRegistry: registrationKernel.registry,
    launchRegistry: launchKernel.registry,
  });
  const runtimeAdapters = Object.fromEntries(PROVIDERS.map((item) => [
    item,
    createProviderRuntimeAdapter(item, runtimeKernel.registry, runtimeKernel.authority),
  ]));
  const launches = new Map();
  const proofs = new Map();

  function actorClaims(launch, period, isExecution) {
    return {
      identity: structuredClone(period.identity),
      periodId: period.registration.executionId,
      actor: structuredClone(period.actor),
      contextId: period.contextId,
      launchRef: isExecution ? launch.launchRef : null,
      immutableExecutionClaims: isExecution ? structuredClone(launch.claims) : null,
    };
  }

  function openActor(launch, period, label, isExecution) {
    const adapter = runtimeAdapters[period.provider];
    const scope = {
      provider: period.identity.provider,
      nativeIdKind: period.identity.nativeIdKind,
      hostId: period.identity.hostId,
      homeScopeId: period.identity.homeScopeId,
      connectionSlotId: 'slot-' + period.registration.executionId + '-' + (isExecution ? 'execution' : 'owner'),
    };
    const opened = adapter.openConnection(scope, 'connection-' + label, evidence('connection-evidence-' + label));
    const claims = actorClaims(launch, period, isExecution);
    const attested = adapter.attestActor(
      opened.connectionHandle,
      claims,
      evidence('actor-evidence-' + label),
    );
    return {
      adapter,
      scope,
      connectionId: 'connection-' + label,
      connectionHandle: opened.connectionHandle,
      connectionGeneration: opened.connectionGeneration,
      actorHandle: attested.actorHandle,
      actorClaims: claims,
      period,
    };
  }

  function createExecution(suffix, childNativeId = undefined, { resume = false } = {}) {
    if (childNativeId && typeof childNativeId === 'object' &&
        (childNativeId.provider !== provider || childNativeId.nativeIdKind !== NATIVE_ID_KINDS[provider])) {
      throw new TypeError('identity override must match the fixture provider');
    }
    const child = registerPeriod(provider, suffix + '-child', 'execution', childNativeId, resume);
    const owner = registerPeriod(otherProvider(provider), suffix + '-owner', 'owner');
    const claims = {
      launchId: 'launch-' + suffix,
      runId: 'run-' + suffix,
      attemptId: 'attempt-initial',
      provider,
      nativeIdKind: NATIVE_ID_KINDS[provider],
      hostId: child.identity.hostId,
      homeScopeId: child.identity.homeScopeId,
      origin: 'delegated',
      purpose: 'agent',
      originBinding: { periodId: owner.registration.executionId, actor: structuredClone(owner.actor) },
    };
    const registered = launchAdapters[provider].registerLaunch(claims, evidence('launch-start-' + suffix));
    launchAdapters[provider].bindExecution(registered.launchRef, {
      identity: structuredClone(child.identity),
      executionBinding: { periodId: child.registration.executionId, actor: structuredClone(child.actor) },
      evidence: evidence('launch-binding-' + suffix, registered.launchRef),
    });
    const record = launchKernel.registry.get(registered.launchRef);
    const launch = {
      provider,
      launchRef: registered.launchRef,
      claims: copyClaims(record),
      child,
      owner,
    };
    launches.set(launch.launchRef, launch);
    runtimeAdapters[provider].adoptExecution(launch.launchRef, structuredClone(launch.claims));
    const childActor = openActor(launch, child, suffix + '-child', true);
    const ownerActor = openActor(launch, owner, suffix + '-owner', false);
    const proof = runtimeAdapters[provider].reconcileExecution(launch.launchRef, {
      executionActorHandle: childActor.actorHandle,
      ownerActorHandle: ownerActor.actorHandle,
      expectedOwnerGeneration: 0,
    });
    proofs.set(launch.launchRef, proof.proofHandle);
    return { ...launch, childActor, ownerActor, proofHandle: proof.proofHandle };
  }

  const runtimeRegistry = Object.freeze({
    get: (launchRef) => runtimeKernel.registry.get(launchRef),
    snapshot: () => runtimeKernel.registry.snapshot(),
    checkCurrentProof: (launchRef, proofHandle) => runtimeKernel.registry.checkCurrentProof(launchRef, proofHandle),
  });
  const executions = [];
  const primary = createExecution('primary-' + provider, options.nativeId);
  executions.push(primary);

  const checkpointPath = path.join(directory, 'delivery-checkpoint-' + provider + '.json');
  const journalPath = path.join(directory, 'question-journal-' + provider + '.json');
  const away = options.away || { snapshot: () => ({ enabled: false }) };
  let deliveryStore = null;
  let questionService = null;
  let closed = false;

  async function openPersistence() {
    deliveryStore = createDurableDeliveryStore({
      ...(options.deliveryStoreOptions || {}),
      filePath: checkpointPath,
      registrationRegistry: registrationKernel.registry,
      launchRegistry: launchKernel.registry,
      runtimeRegistry,
      resolveProof: (launchRef) => proofs.get(launchRef) || null,
      verifyResultOwner: () => false,
    });
    await deliveryStore.ready;
    questionService = createCommonQuestionService({
      ...(options.questionServiceOptions || {}),
      journalPath,
      registrationRegistry: registrationKernel.registry,
      launchRegistry: launchKernel.registry,
      runtimeRegistry,
      deliveryStore,
      away,
      now: options.now || Date.now,
      setTimeoutImpl: options.setTimeoutImpl || ((callback, delay) => ({ callback, delay })),
      clearTimeoutImpl: options.clearTimeoutImpl || (() => {}),
    });
    await questionService.ready();
    closed = false;
  }

  await openPersistence();

  async function closePersistence() {
    if (questionService) {
      const current = questionService;
      questionService = null;
      await current.close().catch(() => {});
    }
    if (deliveryStore) {
      const current = deliveryStore;
      deliveryStore = null;
      await current.close().catch(() => {});
    }
    closed = true;
  }

  function refreshExecutionConnections(execution) {
    runtimeAdapters[execution.provider].disconnect(execution.childActor.connectionHandle);
    runtimeAdapters[execution.owner.provider].disconnect(execution.ownerActor.connectionHandle);
    const current = runtimeKernel.registry.get(execution.launchRef);
    const owner = periodsById.get(current.currentOwner.periodId);
    if (!owner) throw new Error('runtime owner period is unavailable');
    restoreSequence += 1;
    const childActor = openActor(execution, execution.child, 'restore-' + restoreSequence + '-child', true);
    const ownerActor = openActor(execution, owner, 'restore-' + restoreSequence + '-owner', false);
    const proof = runtimeAdapters[execution.provider].reconcileExecution(execution.launchRef, {
      executionActorHandle: childActor.actorHandle,
      ownerActorHandle: ownerActor.actorHandle,
      expectedOwnerGeneration: current.ownerGeneration,
    });
    proofs.set(execution.launchRef, proof.proofHandle);
    execution.childActor = childActor;
    execution.ownerActor = ownerActor;
    execution.proofHandle = proof.proofHandle;
  }

  return {
    provider,
    registrationKernel,
    registrationAdapters,
    launchKernel,
    launchAdapters,
    runtimeKernel,
    runtimeAdapters,
    runtimeRegistry,
    primary,
    executions,
    checkpointPath,
    journalPath,
    away,
    fixtureEvidence: 'authenticated-test-fixture; not native product evidence',
    get deliveryStore() { return deliveryStore; },
    get questionService() { return questionService; },
    get writer() { return primary.child.writer; },
    createExecution(suffix, childNativeId = undefined, executionOptions = {}) {
      if (closed) throw new Error('harness is closed');
      const execution = createExecution(suffix, childNativeId, executionOptions);
      executions.push(execution);
      return execution;
    },
    openActor(execution, period, suffix, isExecution) {
      return openActor(execution, period, suffix, isExecution);
    },
    reconcile(execution, { childActor = execution.childActor, ownerActor = execution.ownerActor,
      expectedOwnerGeneration = runtimeKernel.registry.get(execution.launchRef).ownerGeneration } = {}) {
      const proof = runtimeAdapters[provider].reconcileExecution(execution.launchRef, {
        executionActorHandle: childActor.actorHandle,
        ownerActorHandle: ownerActor.actorHandle,
        expectedOwnerGeneration,
      });
      proofs.set(execution.launchRef, proof.proofHandle);
      return proof;
    },
    disconnectActor(actor) {
      return actor.adapter.disconnect(actor.connectionHandle);
    },
    async reopen() {
      await closePersistence();
      for (const execution of executions) refreshExecutionConnections(execution);
      await openPersistence();
      return { deliveryStore, questionService };
    },
    async close() {
      await closePersistence();
    },
  };
}

module.exports = { createCommonQuestionProductHarness, NATIVE_ID_KINDS, PROVIDERS };
