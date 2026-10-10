'use strict';

const fs = require('node:fs/promises');
const { createOwnedNativeRunner } = require('../../src/server/owned-native-runner');
const { createOwnedNativeSource } = require('../../src/server/owned-native-source');
const { AwayState } = require('../../src/server/state');
const { createFakeNativeProcess, defaultProfiles, PROVIDERS } = require('./native-instruction-integration-harness');

function createBarrier() {
  let enter;
  let release;
  const entered = new Promise(resolve => { enter = resolve; });
  const released = new Promise(resolve => { release = resolve; });
  return { entered, release, async wait() { enter(); await released; } };
}

function holdNextNativeRead(child, method = 'thread/read', responseFirst = false) {
  const barrier = createBarrier();
  const originalWrite = child.stdin.write.bind(child.stdin);
  let requestId;
  let response;
  let writeCallback;
  let responseReleased = false;
  let writeReleased = false;
  const releaseResponse = () => {
    if (!response || responseReleased) return;
    responseReleased = true;
    child.send(response);
  };
  const releaseWrite = () => {
    if (!writeCallback || writeReleased) return;
    writeReleased = true;
    writeCallback();
  };
  child.stdin.write = (line, callback) => {
    const request = JSON.parse(line.toString());
    if (request.method !== method || requestId !== undefined) return originalWrite(line, callback);
    requestId = request.id;
    writeCallback = callback;
    const originalSend = child.send;
    child.send = (...messages) => {
      for (const message of messages) {
        if (message.id === requestId && Object.hasOwn(message, 'result')) response = message;
        else originalSend.call(child, message);
      }
    };
    try { originalWrite(line); } finally { child.send = originalSend; }
    if (responseFirst) releaseResponse();
    barrier.wait();
    return true;
  };
  return { entered: barrier.entered, release() {
    try { releaseResponse(); } finally { releaseWrite(); barrier.release(); }
  } };
}

function loadFactory(control) {
  const names = ['native-factory-lifetime-gate', 'reclamation-persistence', 'reclamation-service-context',
    'common-question-service', 'instruction-delivery-service', 'provider-instruction-adapter', 'reclamation-scheduler',
    'native-launch-composition', 'owned-native-source-collector'];
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
    if (control.failPersistence) throw control.failPersistence;
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
    if (control.failContext) throw control.failContext;
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
    return Object.freeze({ ...control.instruction,
      ready() { if (control.failServiceReady) return Promise.reject(control.failServiceReady); return control.instruction.ready(); },
      async close() {
        control.events.push('service-close');
        if (control.serviceCloseBarrier) await control.serviceCloseBarrier.wait();
        return control.instruction.close();
      },
    });
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
    return Object.freeze({ ...scheduler, start() {
      if (control.failSchedulerStart) throw control.failSchedulerStart;
      return scheduler.start();
    } });
  });
  replace(7, 'createNativeLaunchComposition', create => options => {
    const composition = create(options);
    control.composition = Object.freeze({ ...composition,
      createInstructionOwner(receipt) {
        if (control.failRouterAttach) throw control.failRouterAttach;
        return composition.createInstructionOwner(receipt);
      },
      createOwnedCollector(receipt, collectorOptions) {
        if (control.failCollectorCreate) throw control.failCollectorCreate;
        const collector = composition.createOwnedCollector(receipt, { ...collectorOptions,
          ...(control.onObservation ? { onObservation: control.onObservation } : {}) });
        const wrapper = control.wrapCollector?.(collector, receipt) || collector;
        if (wrapper !== collector) originals[8].aliasOwnedNativeCollectorControl(collector, wrapper);
        return wrapper;
      },
      stop(receipt) {
        control.nativeStops.push(receipt);
        control.events.push('native-stop');
        const pending = composition.stop(receipt);
        pending.catch(() => {});
        control.onStop?.(receipt);
        if (Object.hasOwn(control, 'stopError')) throw control.stopError;
        if (control.stopBarrier) {
          const barrier = control.stopBarrier;
          control.releases.add(barrier.release);
          control.stopBarrier = null;
          return pending.then(async result => { await barrier.wait(); return result; });
        }
        return pending;
      },
    });
    return control.composition;
  });
  replace(8, 'getOwnedNativeCollectorControl', lookup => collector => {
    const owned = lookup(collector);
    if (!owned || control.missingCollectorControl) return null;
    return Object.freeze({
      bindTicketAcquirer(acquirer) {
        control.onBind?.(collector);
        if (Object.hasOwn(control, 'bindError')) throw control.bindError;
        if (control.refuseBind) return false;
        return owned.bindTicketAcquirer(acquirer);
      },
      stopAdmission() {
        const changed = owned.stopAdmission();
        if (changed) control.events.push('collector-stop-admission');
        control.onCollectorStop?.(collector);
        return changed;
      },
      async drain() {
        control.events.push('collector-drain');
        await owned.drain();
        if (control.collectorDrainBarrier) await control.collectorDrainBarrier.wait();
        if (Object.hasOwn(control, 'collectorDrainError')) throw control.collectorDrainError;
      },
    });
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
    questionTimers: [], schedulerTimers: [], listeners: new Map(), providerCalls: [], nativeStops: [],
    releases: new Set(), ...options };
  let initialReadEntered;
  control.initialReadEntered = new Promise(resolve => { initialReadEntered = resolve; });
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
      const process = createFakeNativeProcess(runnerOptions.provider, runnerOptions.homePath, {
        nativeIdSuffix: list.length + 1, killEvents: control.killEvents,
      });
      list.push(process);
      let source = null;
      let identity = null;
      let context = null;
      if (control.readBarrier) source = createOwnedNativeSource({
        provider: runnerOptions.provider, hostId: runnerOptions.hostId, homeScopeId: runnerOptions.homeScopeId,
        ownedSourceClaim: runnerOptions.ownedSourceClaim,
        async readNativeCurrent({ requestToken }) {
          await control.readBarrier.wait();
          return { requestToken, identity, context, activity: 'inProgress' };
        },
      });
      const runner = createOwnedNativeRunner({ ...runnerOptions,
        onSourceReady(capability) {
          if (source) { source.controller.markReady(); runnerOptions.onSourceReady(source.capability); }
          else runnerOptions.onSourceReady(capability);
        },
        onNative(event) {
          if (source) {
            if (event.type === 'identity') { identity = event.identity; source.controller.observeIdentity(identity); }
            if (event.type === 'context') { context = event.context; source.controller.observeContext(identity, context); }
            if (event.type === 'context_ended') source.controller.observeTerminal(identity, event.context);
          }
          return runnerOptions.onNative(event);
        },
        spawnImpl(...args) {
          const child = process.spawnImpl(...args);
          if (control.holdInitialRead) {
            control.heldRead = holdNextNativeRead(child, control.holdInitialRead);
            control.releases.add(() => control.heldRead.release());
            control.heldRead.entered.then(initialReadEntered);
          }
          control.onSpawn?.(child, process);
          return child;
        },
        timeouts: { startupMs: 5000, rpcMs: 5000, loginMs: 5000, stopMs: 100 } });
      return Object.freeze({ ...runner,
        start(request) {
          control.onRunnerStart?.(request);
          const pending = runner.start(request);
          if (control.startBarrier) return pending.then(async result => { await control.startBarrier.wait(); return result; });
          return pending;
        },
        stop() { source?.controller.invalidate(); return runner.stop(); },
      });
    },
  });
  ready.catch(() => {});
  return { control, ready, settingsCallbacks, away, processes,
    releaseAll() {
      for (const release of control.releases) release();
      if (control.killEvents === 'exit' || control.killEvents === 'close') {
        for (const list of processes.values()) for (const process of list) {
          process.state.child?.reportExit();
          process.state.child?.reportClose();
        }
      }
      for (const name of ['writeBarrier', 'serviceCloseBarrier', 'stopBarrier', 'collectorDrainBarrier', 'readBarrier', 'startBarrier']) control[name]?.release();
    },
    startInput(provider, suffix) {
      return { launchId: `life-launch-${provider}-${suffix}`, runId: `life-run-${provider}-${suffix}`,
        attemptId: `life-attempt-${provider}-${suffix}`, profileId: provider,
        origin: 'standalone', purpose: 'agent', inputText: 'lifetime fixture' };
    },
    writerFor(launchRef) { return control.composition.writerFor(launchRef); },
    holdNextWrite(slot) {
      const barrier = createBarrier();
      control.releases.add(barrier.release);
      control.writeBarrier = { ...barrier, slot };
      return barrier;
    },
    holdNextRead(process, method, responseFirst) {
      const held = holdNextNativeRead(process.state.child, method, responseFirst);
      control.releases.add(held.release);
      return held;
    },
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
