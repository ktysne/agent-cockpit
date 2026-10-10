'use strict';

const fs = require('node:fs/promises');
const { createOwnedNativeRunner } = require('../../src/server/owned-native-runner');
const { AwayState } = require('../../src/server/state');
const { createFakeNativeProcess, defaultProfiles, PROVIDERS } = require('./native-instruction-integration-harness');

function createBarrier() {
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await released; } };
}

function loadFactory(control) {
  const names = ['native-factory-lifetime-gate', 'reclamation-persistence', 'reclamation-service-context',
    'common-question-service', 'instruction-delivery-service', 'provider-instruction-adapter', 'reclamation-scheduler',
    'native-launch-composition'];
  const paths = names.map(name => require.resolve(`../../src/server/${name}`));
  const originals = paths.map(modulePath => require(modulePath));
  const integrationPath = require.resolve('../../src/server/native-instruction-service-integration');
  const previous = require.cache[integrationPath];
  const replace = (index, name, wrapper) => {
    require.cache[paths[index]].exports = { ...originals[index], [name]: wrapper(originals[index][name]) };
  };
  replace(0, 'createNativeFactoryLifetimeGate', create => () => {
    const gate = create();
    control.gateCount += 1;
    return Object.freeze({
      enter(kind) {
        const ticket = gate.enter(kind);
        control.active += 1;
        control.events.push(`enter:${kind}`);
        let released = false;
        return Object.freeze({ release() {
          if (released) return;
          released = true;
          ticket.release();
          control.active -= 1;
          control.events.push(`release:${kind}`);
        } });
      },
      stopAdmission() { control.events.push('stop-admission'); gate.stopAdmission(); },
      async drain() { await gate.drain(); control.events.push('drained'); },
    });
  });
  replace(1, 'createReclamationPersistence', create => options => {
    const persistence = create(options);
    return Object.freeze({ ...persistence,
      async readAnchorBytes(...args) {
        const bytes = await persistence.readAnchorBytes(...args);
        if (control.failStart) throw Object.assign(new Error('fixture start failure'), { code: 'fixture_start_failure' });
        return bytes;
      },
      async writeSlotBytes(slot, ...args) {
        control.writes[slot] += 1;
        const barrier = control.writeBarrier;
        if (barrier?.slot === slot) { control.writeBarrier = null; await barrier.wait(); }
        return persistence.writeSlotBytes(slot, ...args);
      },
      async close() { await persistence.close(); control.events.push('persistence-closed'); },
    });
  });
  replace(2, 'createReclamationServiceContext', create => options => {
    const context = create(options);
    control.context = context;
    return Object.freeze({ ...context,
      async start(writers) {
        if (control.probeCold) {
          control.coldQuestion = control.question.dashboardSnapshot().catch(error => error);
          control.coldInstruction = control.instruction.get('cold').catch(error => error);
        }
        return context.start(writers);
      },
      close() { control.events.push('context-close'); return context.close(); },
    });
  });
  replace(3, 'createCommonQuestionService', create => (options, gate) => {
    control.question = create({ ...options,
      setTimeoutImpl: callback => { const timer = { callback, unref() {} }; control.questionTimers.push(timer); return timer; },
      clearTimeoutImpl: timer => { timer.cleared = true; },
    }, gate);
    return control.question;
  });
  replace(4, 'createInstructionDeliveryService', create => (options, gate) => {
    control.instruction = create(options, gate);
    return control.instruction;
  });
  replace(5, 'createProviderInstructionAdapter', create => (provider, options) => {
    const adapter = create(provider, options);
    const listeners = {};
    control.listeners.set(provider, listeners);
    return Object.freeze({ ...adapter, ...Object.fromEntries(['onAccepted', 'onEvidence', 'onUnknown'].map(name =>
      [name, listener => {
        listeners[name] = listener;
        return adapter[name]((...args) => {
          control.providerCalls.push({ provider, name, args });
          if (name === 'onEvidence' && control.deferEvidence) return false;
          return listener(...args);
        });
      }])) });
  });
  replace(6, 'createReclamationScheduler', create => options => {
    const scheduler = create({ ...options,
      setTimeoutImpl: callback => { const timer = { callback, unref() {} }; control.schedulerTimers.push(timer); return timer; },
      clearTimeoutImpl: timer => { timer.cleared = true; },
    });
    control.scheduler = scheduler;
    return scheduler;
  });
  replace(7, 'createNativeLaunchComposition', create => options => {
    control.composition = create(options);
    return control.composition;
  });
  delete require.cache[integrationPath];
  try { return require(integrationPath).createNativeInstructionServiceIntegration; }
  finally {
    paths.forEach((modulePath, index) => { require.cache[modulePath].exports = originals[index]; });
    if (previous) require.cache[integrationPath] = previous;
    else delete require.cache[integrationPath];
  }
}

async function createNativeFactoryLifetimeHarness(directory, options = {}) {
  const control = { gateCount: 0, active: 0, events: [], writes: { checkpoint: 0, instructions: 0, questions: 0 },
    questionTimers: [], schedulerTimers: [], listeners: new Map(), providerCalls: [], ...options };
  const factory = loadFactory(control);
  const profiles = defaultProfiles(directory);
  await Promise.all(Object.values(profiles).flatMap(profile => [profile.homePath, profile.cwd])
    .map(directoryPath => fs.mkdir(directoryPath, { recursive: true })));
  const processes = new Map(PROVIDERS.map(provider => [provider, []]));
  const settingsCallbacks = [];
  const away = options.awayEnabled ? new AwayState(undefined, {
    enabled: true, since: 1_000_000, periods: [{ start: 1_000_000, end: null }],
  }) : new AwayState();
  const settings = {
    getStatus: () => ({ status: 'ready', revision: 'lifetime-fixture', reason: null }),
    getAutoApplySettings: () => ({ enabled: true, minimumWaitMs: 300_000 }),
    subscribe(callback) {
      settingsCallbacks.push(callback);
      if (options.failSubscription) { callback(); return null; }
      return () => { control.events.push('settings-unsubscribe'); options.onUnsubscribe?.(); };
    },
  };
  const ready = factory({ profiles, dataDirectory: directory, hostId: 'native-lifetime-host',
    now: () => control.now ?? 1_000_000,
    commonQuestions: { away, settings },
    ...(options.standard ? {} : { reclamation: {
      maxAdditionalBytes: 64 * 1024 * 1024,
      normalByteLimitsBySlot: { checkpoint: 16 * 1024 * 1024, instructions: 16 * 1024 * 1024, questions: 16 * 1024 * 1024 },
      ...(options.autoReclaim ? { autoReclaim: { intervalMs: 1_000, maxOperationsPerPass: 8 } } : {}),
    } }),
    getAuthentication: () => ({ oauthToken: 'fixture-oauth-token' }),
    onAuthenticationRequired: challenge => processes.get('codex').at(-1).completeLogin(challenge.loginId),
    runnerFactory(runnerOptions) {
      const list = processes.get(runnerOptions.provider);
      const process = createFakeNativeProcess(runnerOptions.provider, runnerOptions.homePath, { nativeIdSuffix: list.length + 1 });
      list.push(process);
      return createOwnedNativeRunner({ ...runnerOptions, spawnImpl: process.spawnImpl,
        timeouts: { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 250 } });
    },
  });
  return { control, ready, settingsCallbacks, away,
    writerFor(launchRef) { return control.composition.writerFor(launchRef); },
    holdNextWrite(slot) { const barrier = createBarrier(); control.writeBarrier = { ...barrier, slot }; return barrier; },
    async start(provider, suffix) {
      const integration = await ready;
      const started = await integration.native.startLaunch({ launchId: `life-launch-${provider}-${suffix}`,
        runId: `life-run-${provider}-${suffix}`, attemptId: `life-attempt-${provider}-${suffix}`, profileId: provider,
        origin: 'standalone', purpose: 'agent', inputText: 'lifetime fixture' });
      return { ...started, process: processes.get(provider).at(-1) };
    },
  };
}

module.exports = { createNativeFactoryLifetimeHarness, createBarrier };
