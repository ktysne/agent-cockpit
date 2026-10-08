'use strict';

const fsSync = require('node:fs');
const path = require('node:path');
const { createDurableDeliveryStore, createProviderDeliveryAdapter } = require('../../src/server/durable-delivery-store');

const { createInstructionDeliveryJournal } = require('../../src/server/instruction-delivery-journal');
const { createInstructionDeliveryService } = require('../../src/server/instruction-delivery-service');
const { createProviderInstructionAdapter } = require('../../src/server/provider-instruction-adapter');

const PROVIDERS = Object.freeze(['claude', 'codex']);
const NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });

function clone(value) {
  return structuredClone(value);
}

function createLaunch(provider, origin) {
  const nativeIdKind = NATIVE_ID_KINDS[provider];
  const identity = {
    provider,
    nativeIdKind,
    hostId: provider + '-fixture-host',
    homeScopeId: provider + '-fixture-home',
    nativeId: provider + '-fixture-native',
  };
  const periodId = provider + '-fixture-period';
  const actor = { kind: 'agent', id: provider + '-fixture-agent' };
  const originPeriodId = provider + '-fixture-origin-period';
  const originActor = { kind: 'agent', id: provider + '-fixture-origin-agent' };
  const originBinding = origin === 'standalone' ? null : { periodId: originPeriodId, actor: originActor };
  const claims = {
    launchId: provider + '-fixture-launch-id',
    runId: provider + '-fixture-run-id',
    attemptId: provider + '-fixture-attempt-id',
    provider,
    nativeIdKind,
    hostId: identity.hostId,
    homeScopeId: identity.homeScopeId,
    origin,
    purpose: origin === 'review' ? 'cross-review' : 'agent',
    originBinding,
  };
  const executionBinding = { periodId, actor };
  const launch = {
    launchRef: provider + '-fixture-launch-ref',
    ...claims,
    state: 'bound',
    identity,
    executionBinding,
    conversationId: provider + '-fixture-conversation',
    sessionId: provider + '-fixture-session',
    currentOwner: originBinding || executionBinding,
    ownerGeneration: 0,
  };
  return { launch, identity, periodId, actor, originBinding, originPeriodId };
}

function createInstructionHarness(options = {}) {
  const provider = options.provider;
  const origin = options.origin ?? 'standalone';
  const ownerEnabled = options.nativeOwner !== false;
  const state = options.state ?? (origin === 'standalone' ? 'stopped' : 'working');
  const directory = options.directory;
  if (!PROVIDERS.includes(provider) || !['standalone', 'delegated', 'review'].includes(origin) ||
      !['working', 'stopped', 'waiting', 'unverified'].includes(state) ||
      typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new TypeError('provider, origin, state, and an absolute directory are required');
  }
  fsSync.mkdirSync(directory, { recursive: true });
  const fixture = createLaunch(provider, origin);
  const { launch, identity, periodId, originBinding, originPeriodId } = fixture;
  const sourceExecution = {
    conversationId: launch.conversationId,
    executionId: periodId,
    sessionId: launch.sessionId,
    state: 'active',
  };
  const conversations = [{ conversationId: launch.conversationId, identity }];
  const executions = [sourceExecution];
  if (originBinding) {
    const ownerIdentity = {
      provider,
      nativeIdKind: NATIVE_ID_KINDS[provider],
      hostId: identity.hostId,
      homeScopeId: identity.homeScopeId,
      nativeId: provider + '-fixture-origin-native',
    };
    conversations.push({ conversationId: provider + '-fixture-origin-conversation', identity: ownerIdentity });
    executions.push({
      conversationId: provider + '-fixture-origin-conversation',
      executionId: originPeriodId,
      sessionId: provider + '-fixture-origin-session',
      state: 'active',
    });
  }
  const runtimeClaims = { ...claimsFor(launch), identity: clone(identity), executionBinding: clone(launch.executionBinding) };
  const runtimeLaunch = {
    launchRef: launch.launchRef,
    ...runtimeClaims,
    state: 'bound',
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
    currentOwner: clone(launch.currentOwner),
    ownerGeneration: 0,
  };
  const launchRegistry = Object.freeze({
    get: (launchRef) => launchRef === launch.launchRef ? clone(launch) : null,
    snapshot: () => ({ launches: [publicLaunch(launch)] }),
  });
  const registrationRegistry = Object.freeze({
    snapshot: () => ({ conversations: clone(conversations), executions: clone(executions) }),
    authorizeEvent: () => ({ ok: false }),
  });
  const runtimeRegistry = Object.freeze({
    get: (launchRef) => launchRef === launch.launchRef ? clone(runtimeLaunch) : null,
    snapshot: () => ({ launches: [clone(runtimeLaunch)], connections: [], actors: [], handoffs: [] }),
    checkCurrentProof: () => ({ ok: false }),
  });
  const writes = [];
  const evidenceListeners = new Set();
  const closedListeners = new Set();
  const capabilities = new WeakSet();
  const capabilitiesByAttempt = new Map();
  const ackWaiters = new Map();
  let stateValue = state;
  let currentTurnId = options.nativeTurnId ?? 'native-fixture-turn';

  let closed = false;
  const nativeOwner = ownerEnabled ? Object.freeze({
    ...(options.lateObservation ? {
      subscribeInstructionClosed(listener) { closedListeners.add(listener); return () => closedListeners.delete(listener); },
      closeInstructionObservation(capability, metadata) {
        if (capabilitiesByAttempt.get(metadata.deliveryAttemptId) !== capability) return false;
        capabilitiesByAttempt.delete(metadata.deliveryAttemptId);
        return true;
      },
    } : {}),
    prepareInstructionDispatch(metadata) {
      if (closed || metadata.source.launchRef !== launch.launchRef) return null;
      const capability = Object.freeze({});
      capabilities.add(capability);

      return capability;
    },
    checkInstructionDispatch(capability, metadata) {
      if (closed || !capabilities.has(capability) || metadata.source.launchRef !== launch.launchRef) return false;
      if (metadata.mode === 'steer') {
        return stateValue === 'working' && metadata.expectedTurnId === currentTurnId;
      }
      return origin === 'standalone' && stateValue === 'stopped' && metadata.expectedTurnId === null;
    },
    dispatchInstructionNow(capability, command) {
      if (closed || !capabilities.has(capability)) throw new Error('fixture capability expired');
      writes.push(clone(command));
      capabilitiesByAttempt.set(command.deliveryAttemptId, capability);
      const nativeTurnId = command.mode === 'steer' ? command.expectedTurnId : 'native-fixture-started-turn';
      currentTurnId = nativeTurnId;
      if (command.mode !== 'steer') stateValue = 'working';
      if (options.autoAck === false) {
        return new Promise((resolve, reject) => ackWaiters.set(command.deliveryAttemptId, { resolve, reject }));
      }
      if (options.evidenceOnDispatch === true) emitInputEvidence(command.deliveryAttemptId);
      return Promise.resolve({ clientRequestId: command.deliveryAttemptId, nativeTurnId, nativeItemId: null });
    },
    subscribeInstructionEvidence(listener) {
      evidenceListeners.add(listener);
      return () => evidenceListeners.delete(listener);
    },
  }) : null;
  const checkpointPath = path.join(directory, 'instruction-checkpoint.json');
  const journalPath = path.join(directory, 'instruction-journal.json');
  let instructionAdapters = {};
  const store = createDurableDeliveryStore({
    ...(options.atomicWrite ? { atomicWrite: options.atomicWrite } : {}),
    filePath: checkpointPath,
    registrationRegistry,
    launchRegistry,
    runtimeRegistry,
    resolveProof: () => null,
    verifyInstructionTarget: (delivery) =>
      instructionAdapters[delivery.source.claims.provider]?.verifyDeliveryTarget(delivery) === true,
  });
  const providerAdapters = Object.fromEntries(PROVIDERS.map((name) => [
    name,
    createProviderDeliveryAdapter(name, store),
  ]));
  instructionAdapters = Object.fromEntries(PROVIDERS.map((name) => [
    name,
    createProviderInstructionAdapter(name, {
      deliveryAdapter: providerAdapters[name],
      nativeOwner: name === provider ? nativeOwner : null,
      ...(options.setTimeoutImpl ? { setTimeoutImpl: options.setTimeoutImpl, clearTimeoutImpl: options.clearTimeoutImpl } : {}),
    }),
  ]));
  const journal = createInstructionDeliveryJournal({ filePath: journalPath });
  const service = createInstructionDeliveryService({
    journal,
    deliveryStore: store,
    providerInstructionAdapters: instructionAdapters,
    launchRegistry,
    ...(options.now ? { now: options.now } : {}),
  });
  function emitEvidence(capability, value) {
    let accepted = false;
    for (const listener of evidenceListeners) {
      try { if (listener(capability, value) === true) accepted = true; } catch {}
    }
    return accepted;
  }
  function emitInputEvidence(deliveryAttemptId, overrides = {}) {
    const command = [...writes].reverse().find((item) => item.deliveryAttemptId === deliveryAttemptId);
    const capability = capabilitiesByAttempt.get(deliveryAttemptId);
    if (!command || !capability) return false;
    const evidence = {
      source: overrides.source ?? command.source,
      target: overrides.target ?? command.target,
      clientRequestId: overrides.clientRequestId ?? deliveryAttemptId,
      nativeTurnId: overrides.nativeTurnId ?? (command.mode === 'steer' ? command.expectedTurnId : 'native-fixture-started-turn'),
      nativeItemId: overrides.nativeItemId ?? provider + '-fixture-item-' + deliveryAttemptId,
      input: overrides.input ?? command.input,
    };
    return emitEvidence(capability, evidence);
  }
  const targetState = () => Object.freeze({
    status: stateValue,
    nativeTurnId: stateValue === 'working' ? currentTurnId : null,
    reason: stateValue === 'unverified' ? 'instruction_target_unverified' : null,
  });
  const owner = Object.freeze({
    setState(nextState, nextTurnId = currentTurnId) {
      if (!['working', 'stopped', 'waiting', 'unverified'].includes(nextState)) throw new TypeError('invalid state');
      stateValue = nextState;
      currentTurnId = nextTurnId;
    },
    emitEvidence,
    emitInputEvidence,
    acknowledge(deliveryAttemptId, values = {}) {
      const waiter = ackWaiters.get(deliveryAttemptId);
      if (!waiter) return false;
      ackWaiters.delete(deliveryAttemptId);
      waiter.resolve({
        clientRequestId: values.clientRequestId ?? deliveryAttemptId,
        nativeTurnId: values.nativeTurnId ?? currentTurnId,
        nativeItemId: values.nativeItemId ?? null,
      });
      return true;
    },
    rejectAcknowledgement(deliveryAttemptId, error = new Error('fixture acknowledgement rejected')) {
      const waiter = ackWaiters.get(deliveryAttemptId);
      if (!waiter) return false;
      ackWaiters.delete(deliveryAttemptId);
      waiter.reject(error);
      return true;
    },
  });
  async function close() {
    if (closed) return;
    closed = true;
    await service.close().catch(() => {});
    await store.close().catch(() => {});
  }
  return Object.freeze({
    provider,
    origin,
    launchRegistry,
    registrationRegistry,
    runtimeRegistry,
    store,
    providerAdapters,
    providerInstructionAdapters: instructionAdapters,
    service,
    launch: clone(launch),
    source: clone(launch),
    targetState,
    owner,
    writes,
    journalPath,
    checkpointPath,
    fixtureEvidence: 'test fixture only; not native product evidence',
    ready: () => service.ready(),
    close,
  });
}

function claimsFor(launch) {
  return Object.fromEntries([
    'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
    'origin', 'purpose', 'originBinding',
  ].map((key) => [key, clone(launch[key])]));
}

function publicLaunch(launch) {
  return {
    launchRef: launch.launchRef,
    ...claimsFor(launch),
    state: launch.state,
    identity: clone(launch.identity),
    executionBinding: clone(launch.executionBinding),
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
  };
}

module.exports = { createInstructionHarness, NATIVE_ID_KINDS, PROVIDERS };
