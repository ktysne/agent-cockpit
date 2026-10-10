'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createNativeFactoryLifetimeHarness, createBarrier } = require('./support/native-factory-lifetime-harness');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'native-factory-lifetime-'));
  const harness = await createNativeFactoryLifetimeHarness(directory, options);
  t.after(async () => {
    harness.releaseAll();
    try { await (await harness.ready).close(); } catch {}
    await fs.rm(directory, { recursive: true, force: true });
  });
  return harness;
}

function question(id) {
  return { questionId: id, timeoutMinutes: 1, category: 'ordinary', questions: [{ id: `choice-${id}`,
    text: 'Choose an option', mode: 'single', options: [{ id: 'one', label: 'One', description: '' }],
    allowFreeText: false, recommendedOptionId: 'one' }] };
}

function instruction(provider, started, id) {
  const mode = provider === 'claude' ? 'start' : 'steer';
  if (mode === 'start') started.process.endCurrentContext();
  return { deliveryAttemptId: id, launchRef: started.result.launchRef, logicalMessageId: `logical-${id}`,
    revision: 1, text: 'lifetime instruction', mode, expectedTurnId: mode === 'start' ? null : started.process.state.turnId };
}

function observe(promise) { return promise.then(value => ({ value }), error => ({ error })); }

for (const provider of ['claude', 'codex']) {
  for (const slot of ['questions', 'instructions']) {
    test(`ID-F209-L01 ${provider} ${slot} close settles running and unstarted factory queue tickets`, async t => {
      const harness = await fixture(t);
      const integration = await harness.ready;
      const started = await harness.start(provider, slot);
      const writer = harness.writerFor(started.result.launchRef);
      const previousWrites = harness.control.writes[slot];
      const barrier = harness.holdNextWrite(slot);
      let close;
      try {
        const first = observe(slot === 'questions'
          ? integration.questionService.register(writer, question('first'))
          : integration.service.create(instruction(provider, started, 'first')));
        await Promise.race([barrier.entered, first.then(result => {
          if (result.error) throw result.error;
          throw new Error('operation settled before its write barrier');
        })]);
        const queued = observe(slot === 'questions'
          ? integration.questionService.register(writer, question('queued'))
          : integration.service.create(instruction(provider, started, 'queued')));
        assert.equal(harness.control.active, 2);
        let closed = false;
        close = integration.close().then(() => { closed = true; });
        await Promise.resolve();
        assert.equal(closed, false);
        assert.equal(harness.control.context.backend('questions').canWrite(), false);
        await assert.rejects(slot === 'questions'
          ? integration.questionService.register(writer, question('late'))
          : integration.service.create(instruction(provider, started, 'late')));
        assert.equal(harness.control.active, 2);
        barrier.release();
        const results = await Promise.all([first, queued]);
        assert.ok(results[1].error);
        await close;
        assert.equal(harness.control.active, 0);
        assert.equal(harness.control.writes[slot], previousWrites + 1);
        assert.equal(harness.control.events.at(-1), 'drained');
        assert.equal(harness.control.gateCount, 1);
        assert.equal(Object.keys(integration).some(key => /gate|ticket/i.test(key)), false);
      } finally { barrier.release(); await close?.catch(() => {}); }
    });
  }

  test(`ID-F209-L01 ${provider} late provider listeners and question timer/settings do not reopen admission`, async t => {
    const harness = await fixture(t, { awayEnabled: true });
    const integration = await harness.ready;
    const started = await harness.start(provider, 'late');
    const writer = harness.writerFor(started.result.launchRef);
    await integration.questionService.register(writer, question('timer'));
    await integration.service.create(instruction(provider, started, 'late-provider'));
    assert.ok(harness.control.questionTimers.length > 0);
    const ticksBefore = harness.control.events.filter(event => event === 'enter:question-queue').length;
    harness.control.questionTimers.at(-1).callback();
    await integration.questionService.flush();
    harness.settingsCallbacks[0]();
    await integration.questionService.flush();
    assert.equal(harness.control.events.filter(event => event === 'enter:question-queue').length, ticksBefore + 2);
    const listeners = harness.control.listeners.get(provider);
    assert.ok(listeners.onAccepted && listeners.onEvidence && listeners.onUnknown);
    await integration.close();
    const events = [...harness.control.events];
    const writes = { ...harness.control.writes };
    const results = await Promise.allSettled([
      listeners.onAccepted('late-provider', {}, { nativeTurnId: 'late-turn' }),
      listeners.onEvidence('late-provider', {}, { nativeTurnId: 'late-turn', type: 'applied' }),
      listeners.onUnknown('late-provider', 'source_closed'),
    ]);
    assert.equal(results[0].status, 'rejected');
    assert.equal(results[1].status, 'fulfilled');
    assert.equal(results[1].value, false);
    assert.equal(results[2].status, 'fulfilled');
    for (const timer of harness.control.questionTimers) timer.callback();
    harness.settingsCallbacks[0]();
    await integration.close();
    assert.deepEqual(harness.control.writes, writes);
    assert.deepEqual(harness.control.events, events);
    assert.equal(harness.control.active, 0);
  });

  for (const eventKind of provider === 'codex' ? ['applied', 'unknown'] : ['unknown']) {
    test(`ID-F209-L01 ${provider} running ${eventKind} listener persistence remains ticketed through close`, async t => {
      const harness = await fixture(t, { deferEvidence: true });
      const integration = await harness.ready;
      const started = await harness.start(provider, eventKind);
      const input = instruction(provider, started, `listener-${eventKind}`);
      await integration.service.create(input);
      await integration.service.send(input.deliveryAttemptId);
      let accepted;
      for (let attempt = 0; attempt < 200; attempt += 1) {
        accepted = await integration.service.get(input.deliveryAttemptId);
        if (accepted.delivery?.state === 'accepted') break;
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.equal(accepted.delivery?.state, 'accepted');
      assert.ok(harness.control.providerCalls.some(call => call.provider === provider && call.name === 'onAccepted'));
      const listeners = harness.control.listeners.get(provider);
      const barrier = harness.holdNextWrite('checkpoint');
      let close;
      try {
        if (eventKind === 'unknown') listeners.onUnknown(input.deliveryAttemptId, 'instruction_source_invalid');
        else {
          assert.equal(started.process.emitInstructionEvidence(), true);
          const calls = harness.control.providerCalls.filter(call => call.provider === provider && call.name === 'onEvidence');
          assert.ok(calls.length > 0);
          for (const call of calls) listeners.onEvidence(...call.args);
        }
        await barrier.entered;
        assert.ok(harness.control.active > 0);
        close = integration.close();
        const writes = { ...harness.control.writes };
        barrier.release();
        await close;
        assert.equal(harness.control.active, 0);
        assert.deepEqual(harness.control.writes, writes);
      } finally { barrier.release(); await close?.catch(() => {}); }
    });
  }

  test(`ID-F209-L01 ${provider} reclamation core and scheduler share one operation ticket`, async t => {
    const harness = await fixture(t, { autoReclaim: true });
    const integration = await harness.ready;
    const started = await harness.start(provider, 'scheduler');
    const writer = harness.writerFor(started.result.launchRef);
    await integration.questionService.register(writer, question('retire'));
    await integration.reclamation.retireQuestionPeriod({ identity: writer.identity, periodId: writer.executionId });
    harness.control.now = 1_000_000 + 604_800_000;
    const barrier = harness.holdNextWrite('questions');
    let close;
    try {
      const pass = harness.control.schedulerTimers.at(-1).callback();
      await barrier.entered;
      assert.equal(harness.control.events.filter(event => event === 'enter:reclaim-question-bodies').length, 1);
      close = integration.close();
      assert.ok(harness.control.active > 0);
      barrier.release();
      await pass;
      await close;
      assert.equal(harness.control.active, 0);
      const writes = { ...harness.control.writes };
      for (const timer of harness.control.schedulerTimers) await timer.callback();
      assert.deepEqual(harness.control.writes, writes);
      assert.equal(integration.reclamation.status().scheduler.stopped, true);
    } finally { barrier.release(); await close?.catch(() => {}); }
  });
}

test('explicit factory close establishes its shared shutdown before synchronous settings reentry', async t => {
  let integration;
  let reentered;
  const harness = await fixture(t, { onUnsubscribe() { reentered = integration.close(); } });
  integration = await harness.ready;
  await Promise.all([integration.close(), integration.close()]);
  await reentered;
  assert.equal(harness.control.events.filter(event => event === 'settings-unsubscribe').length, 1);
  assert.equal(harness.control.events.filter(event => event === 'context-close').length, 1);
  assert.equal(harness.control.events.filter(event => event === 'stop-admission').length, 1);
  assert.equal(harness.control.active, 0);
});

test('startup failure rejects cold diagnostics before ticket admission and closes the ready context', async t => {
  const harness = await fixture(t, { failStart: true, probeCold: true });
  await assert.rejects(harness.ready, { code: 'fixture_start_failure' });
  assert.ok((await harness.control.coldQuestion).code);
  assert.ok((await harness.control.coldInstruction).code);
  await assert.rejects(harness.control.context.backend('questions').load());
  assert.equal(harness.control.active, 0);
  assert.equal(harness.control.events.some(event => event.startsWith('enter:')), false);
  assert.equal(harness.control.events.at(-1), 'drained');
});

test('subscription startup failure drains the accepted settings callback operation', async t => {
  const harness = await fixture(t, { failSubscription: true });
  await assert.rejects(harness.ready, { code: 'invalid_common_question_subscription' });
  assert.ok(harness.control.events.includes('enter:question-queue'));
  assert.ok(harness.control.events.includes('release:question-queue'));
  assert.equal(harness.control.active, 0);
  assert.equal(harness.control.events.at(-1), 'drained');
});

test('standard factory creates no lifetime gate and retains its public shape', async t => {
  const harness = await fixture(t, { standard: true });
  const integration = await harness.ready;
  await integration.questionService.tick();
  await integration.close();
  assert.equal(harness.control.gateCount, 0);
  assert.equal(harness.control.events.some(event => /admission|drained|enter:/.test(event)), false);
  assert.equal(Object.hasOwn(integration, 'reclamation'), false);
  assert.deepEqual(Object.keys(integration.getStatus()), ['commonQuestions']);
});

function fixtureError(code) { return Object.assign(new Error(code), { code }); }
function nextTurn() { return new Promise(resolve => setImmediate(resolve)); }
function waitForChildStop(child) {
  return Promise.all([
    child.exitEmitted ? undefined : new Promise(resolve => child.once('exit', resolve)),
    child.closeEmitted ? undefined : new Promise(resolve => child.once('close', resolve)),
  ]);
}

for (const stage of ['failPersistence', 'failContext', 'failServiceReady', 'failSchedulerStart']) {
  test(`ID-F209-L02 ${stage}: early cleanup has no native entries or collection TDZ`, async t => {
    const failure = fixtureError(stage);
    const harness = await fixture(t, { [stage]: failure, ...(stage === 'failSchedulerStart' ? { autoReclaim: true } : {}) });
    await assert.rejects(harness.ready, error => error === failure);
    assert.equal(harness.control.nativeStops.length, 0);
    assert.equal(harness.control.active, 0);
    assert.equal(harness.control.events.at(-1), 'drained');
    if (stage === 'failPersistence' || stage === 'failContext') assert.equal(harness.control.composition, undefined);
    else assert.ok(harness.control.composition);
    if (stage === 'failSchedulerStart') {
      assert.ok(harness.control.events.indexOf('release:scheduler-start') < harness.control.events.indexOf('drained'));
    }
  });
}

for (const provider of ['claude', 'codex']) {
  test(`ID-F209-L02 ${provider}: start uses private tickets and stopped collector cannot reopen`, async t => {
    const harness = await fixture(t);
    const integration = await harness.ready;
    const started = await harness.start(provider, 'native-ticket');
    assert.equal(harness.control.active, 0);
    assert.ok(harness.control.events.includes('enter:native-start'));
    assert.ok(harness.control.events.includes('release:native-start'));
    assert.ok(harness.control.events.includes('enter:native-collector-connect'));
    if (provider === 'claude') {
      assert.equal((await started.collector.observeKnownThread(started.result.observation.nativeId)).status, 'unsupported');
    } else assert.ok(harness.control.events.includes('enter:native-collector-observe'));
    await integration.close();
    const before = [...harness.control.events];
    assert.notEqual((await started.collector.connect()).status, 'connected');
    assert.notEqual((await started.collector.observeKnownThread(started.result.observation.nativeId)).status, 'observed');
    assert.equal(started.collector.resolveProof(started.result.launchRef), null);
    assert.deepEqual(harness.control.events, before);
    assert.equal(harness.control.active, 0);
  });

  test(`ID-F209-L02 ${provider}: a held runner start keeps close pending after child stop`, { timeout: 6000 }, async t => {
    const barrier = createBarrier();
    const harness = await fixture(t, { startBarrier: barrier });
    const integration = await harness.ready;
    const start = observe(harness.start(provider, 'start-held'));
    let close;
    try {
      await barrier.entered;
      let closed = false;
      close = integration.close().then(() => { closed = true; });
      const child = harness.processes.get(provider)[0].state.child;
      await waitForChildStop(child);
      assert.equal(harness.control.nativeStops.length, 1);
      assert.equal(child.exitEmitted, true);
      assert.equal(child.closeEmitted, true);
      assert.equal(closed, false);
      assert.ok(harness.control.active > 0);
      barrier.release();
      assert.ok((await start).error);
      await close;
      assert.equal(harness.control.active, 0);
      assert.equal(harness.control.nativeStops.length, 1);
    } finally { barrier.release(); await close?.catch(() => {}); }
  });
}

test('ID-F209-L02 first observe settles through stop without waiting for itself or late raw read', { timeout: 6000 }, async t => {
  const harness = await fixture(t, { holdInitialRead: 'thread/read' });
  const integration = await harness.ready;
  const start = observe(harness.start('codex', 'initial-observe'));
  let close;
  try {
    await harness.control.initialReadEntered;
    close = integration.close();
    assert.ok((await start).error);
    await close;
    assert.equal(harness.control.active, 0);
    assert.equal(harness.control.nativeStops.length, 1);
    harness.control.heldRead.release();
    await nextTurn();
    assert.equal(harness.processes.get('codex')[0].state.spawnCount, 1);
  } finally { harness.releaseAll(); await close?.catch(() => {}); }
});

for (const kind of ['observe', 'reconcile']) {
  test(`ID-F209-L02 ${kind}: close drains a real pending read before raw callback completion`, { timeout: 6000 }, async t => {
    const harness = await fixture(t);
    const integration = await harness.ready;
    const started = await harness.start('codex', kind);
    const held = harness.holdNextRead(started.process, 'thread/loaded/list', true);
    const pending = kind === 'observe'
      ? started.collector.observeKnownThread(started.result.observation.nativeId)
      : started.collector.reconcileProof(started.result.launchRef);
    let close;
    try {
      await held.entered;
      assert.ok(harness.control.active > 0);
      close = integration.close();
      assert.notEqual((await pending).status, 'observed');
      await close;
      assert.equal(harness.control.active, 0);
      const stoppedWrites = [...started.process.state.rpcMethods];
      held.release();
      await nextTurn();
      assert.deepEqual(started.process.state.rpcMethods, stoppedWrites);
    } finally { held.release(); await close?.catch(() => {}); }
  });
}

test('ID-F209-L02 admitted pending connect is ticketed and cooperatively cancelled by close', async t => {
  const harness = await fixture(t);
  const integration = await harness.ready;
  const { inputText, ...admission } = harness.startInput('codex', 'pending-connect');
  const receipt = integration.native.admitLaunch(admission);
  const collector = integration.native.createOwnedCollector(receipt);
  const pending = collector.connect();
  assert.equal(harness.control.active, 1);
  const close = integration.close();
  assert.notEqual((await pending).status, 'connected');
  await close;
  assert.equal(harness.control.active, 0);
  assert.equal(harness.processes.get('codex').length, 0);
});

test('ID-F209-L02 non-cooperating injected reader keeps start and close pending after physical stop', { timeout: 6000 }, async t => {
  const barrier = createBarrier();
  const harness = await fixture(t, { readBarrier: barrier });
  const integration = await harness.ready;
  const start = observe(harness.start('codex', 'non-cooperative-read'));
  let close;
  try {
    await barrier.entered;
    let closed = false;
    close = integration.close().then(() => { closed = true; });
    const child = harness.processes.get('codex')[0].state.child;
    await waitForChildStop(child);
    assert.equal(child.exitEmitted && child.closeEmitted, true);
    assert.equal(closed, false);
    assert.ok(harness.control.active >= 2);
    barrier.release();
    assert.ok((await start).error);
    await close;
    assert.equal(harness.control.active, 0);
  } finally { barrier.release(); await close?.catch(() => {}); }
});

test('ID-F209-L02 all collectors stop admission and all children begin stopping before held service close', { timeout: 6000 }, async t => {
  const serviceBarrier = createBarrier();
  const stopBarrier = createBarrier();
  const harness = await fixture(t, { serviceCloseBarrier: serviceBarrier, stopBarrier });
  const integration = await harness.ready;
  await harness.start('claude', 'multi-one');
  await harness.start('codex', 'multi-two');
  let attemptsAfterDetach;
  harness.control.onStop = () => {
    attemptsAfterDetach = harness.control.events.filter(event => event === 'collector-stop-admission').length;
  };
  let close;
  try {
    close = integration.close();
    await serviceBarrier.entered;
    await stopBarrier.entered;
    assert.equal(attemptsAfterDetach, 2);
    assert.equal(harness.control.nativeStops.length, 2);
    assert.ok(harness.control.events.lastIndexOf('native-stop') < harness.control.events.indexOf('service-close'));
    for (const processes of harness.processes.values()) assert.equal(processes[0].state.child.killSignals.length, 1);
    serviceBarrier.release();
    stopBarrier.release();
    await close;
  } finally { serviceBarrier.release(); stopBarrier.release(); await close?.catch(() => {}); }
});

test('ID-F209-L02 one synchronous stop exception does not prevent other entry stop initiation', async t => {
  const harness = await fixture(t);
  const integration = await harness.ready;
  await harness.start('claude', 'stop-error-one');
  await harness.start('codex', 'stop-error-two');
  const error = fixtureError('fixture_stop_throw');
  harness.control.onStop = () => {
    if (harness.control.nativeStops.length === 1) throw error;
  };
  await assert.rejects(integration.close(), failure => failure === error);
  assert.equal(harness.control.nativeStops.length, 2);
  assert.equal(harness.control.active, 0);
});

test('ID-F209-L02 synchronous start and stop reentry share placeholders and spawn once', { timeout: 6000 }, async t => {
  const harness = await fixture(t);
  const integration = await harness.ready;
  const input = harness.startInput('codex', 'reentry');
  let reenteredStart;
  let conflict;
  const entered = createBarrier();
  harness.control.onRunnerStart = () => {
    reenteredStart = integration.native.startLaunch(input);
    try { integration.native.startLaunch({ ...input, inputText: 'different input' }); }
    catch (error) { conflict = error; }
    entered.wait();
  };
  const start = integration.native.startLaunch(input);
  await entered.entered;
  entered.release();
  assert.equal(reenteredStart, start);
  assert.equal(conflict.code, 'attempt_conflict');
  const started = await start;
  let reenteredStop;
  harness.control.onStop = receipt => { reenteredStop = integration.native.stop(receipt); };
  const stop = integration.native.stop(started.receipt);
  assert.equal(reenteredStop, stop);
  await stop;
  assert.equal(harness.processes.get('codex')[0].state.spawnCount, 1);
  assert.equal(harness.control.nativeStops.length, 1);
  assert.equal(harness.control.active, 0);
});

for (const stage of ['failCollectorCreate', 'refuseBind', 'missingCollectorControl', 'failRouterAttach']) {
  test(`ID-F209-L02 ${stage}: synchronous error keeps its start ticket through preparation cleanup`, { timeout: 6000 }, async t => {
    const barrier = createBarrier();
    const error = fixtureError(stage);
    const harness = await fixture(t, { [stage]: stage === 'refuseBind' || stage === 'missingCollectorControl' ? true : error,
      stopBarrier: barrier });
    const integration = await harness.ready;
    let thrown;
    assert.throws(() => integration.native.startLaunch(harness.startInput('codex', stage)), failure => { thrown = failure; return true; });
    if (stage === 'failCollectorCreate' || stage === 'failRouterAttach') assert.equal(thrown, error);
    let close;
    try {
      await barrier.entered;
      assert.ok(harness.control.active > 0);
      let closed = false;
      close = observe(integration.close()).then(result => { closed = true; return result; });
      await nextTurn();
      assert.equal(closed, false);
      barrier.release();
      const result = await close;
      if (stage !== 'failCollectorCreate') assert.ok(result.error);
      else assert.equal(result.error, undefined);
      assert.equal(harness.control.active, 0);
      assert.equal(harness.control.nativeStops.length, 1);
      assert.equal(harness.processes.get('codex').length, 0);
    } finally { barrier.release(); await close; }
  });
}

test('ID-F209-L02 bind reentry keeps the original synchronous error and cleanup failure visible after close snapshot', { timeout: 6000 }, async t => {
  const barrier = createBarrier();
  const harness = await fixture(t, { collectorDrainBarrier: barrier });
  const integration = await harness.ready;
  const input = harness.startInput('codex', 'bind-reentry');
  const original = fixtureError('fixture_bind_throw');
  const cleanup = fixtureError('fixture_drain_failure');
  let reentered;
  let close;
  harness.control.onBind = () => {
    reentered = observe(integration.native.startLaunch(input));
    close = observe(integration.close());
    harness.control.collectorDrainError = cleanup;
    throw original;
  };
  try {
    assert.throws(() => integration.native.startLaunch(input), error => error === original);
    await barrier.entered;
    let reenteredSettled = false;
    reentered.then(() => { reenteredSettled = true; });
    await nextTurn();
    assert.equal(reenteredSettled, false);
    assert.ok(harness.control.active > 0);
    barrier.release();
    assert.equal((await reentered).error, original);
    assert.equal((await close).error, cleanup);
    assert.equal(harness.control.active, 0);
  } finally { barrier.release(); await close; }
});

test('ID-F209-L02 direct collector bind failure is explicitly drained by close without a start ticket', { timeout: 6000 }, async t => {
  const barrier = createBarrier();
  const harness = await fixture(t, { refuseBind: true, collectorDrainBarrier: barrier });
  const integration = await harness.ready;
  const { inputText, ...admission } = harness.startInput('codex', 'direct-bind');
  const receipt = integration.native.admitLaunch(admission);
  assert.throws(() => integration.native.createOwnedCollector(receipt), { code: 'owned_collector_ticket_binding_failed' });
  assert.equal(harness.control.active, 0);
  let close;
  try {
    let closed = false;
    close = observe(integration.close()).then(result => { closed = true; return result; });
    await barrier.entered;
    await nextTurn();
    assert.equal(closed, false);
    barrier.release();
    assert.equal((await close).error.code, 'owned_collector_ticket_binding_failed');
    assert.equal(harness.control.nativeStops.length, 1);
  } finally { barrier.release(); await close; }
});

for (const event of ['exit', 'close']) {
  test(`ID-F209-L02 only child ${event} cannot turn settled wrappers into stop confirmation`, async t => {
    const harness = await fixture(t, { killEvents: event });
    const integration = await harness.ready;
    const started = await harness.start('codex', event);
    await assert.rejects(integration.close(), { code: 'native_process_stop_unconfirmed' });
    assert.equal(harness.control.active, 0);
    assert.equal(integration.native.getOwnedStopState(started.receipt).stopConfirmed, false);
    const child = started.process.state.child;
    assert.equal(child.exitEmitted, event === 'exit');
    assert.equal(child.closeEmitted, event === 'close');
    child.reportExit();
    child.reportClose();
  });
}

test('ID-F209-L02 standard close retains service-first order without private collector drain', async t => {
  const barrier = createBarrier();
  const harness = await fixture(t, { standard: true, serviceCloseBarrier: barrier });
  const integration = await harness.ready;
  await harness.start('codex', 'standard-order');
  let close;
  try {
    close = integration.close();
    await barrier.entered;
    assert.equal(harness.control.nativeStops.length, 0);
    assert.equal(harness.control.gateCount, 0);
    barrier.release();
    await close;
    assert.equal(harness.control.nativeStops.length, 1);
    assert.equal(harness.control.events.includes('collector-drain'), false);
    assert.equal(harness.control.events.includes('collector-stop-admission'), false);
  } finally { barrier.release(); await close?.catch(() => {}); }
});

for (const reason of [undefined, null, false, 0, '']) {
  test(`ID-F209-L02 falsy bind failure ${String(reason)} remains a synchronous throw and close rejection`, async t => {
    const harness = await fixture(t, { bindError: reason });
    const integration = await harness.ready;
    let thrown = false;
    let actual;
    try { integration.native.startLaunch(harness.startInput('codex', 'falsy-bind')); }
    catch (error) { thrown = true; actual = error; }
    assert.equal(thrown, true);
    assert.equal(actual, reason);
    const closed = await observe(integration.close());
    assert.equal(Object.hasOwn(closed, 'error'), true);
    assert.equal(closed.error, reason);
    assert.equal(harness.control.active, 0);
  });
}

test('ID-F209-L02 private construction injection cleans a collector generated after the stop snapshot', async t => {
  const harness = await fixture(t);
  const integration = await harness.ready;
  let disconnects = 0;
  let generated;
  let close;
  harness.control.wrapCollector = collector => {
    generated = Object.freeze({ ...collector,
      disconnect() { disconnects += 1; return collector.disconnect(); },
    });
    close = observe(integration.close());
    return generated;
  };
  assert.throws(() => integration.native.startLaunch(harness.startInput('codex', 'private-construction-close')),
    { code: 'native_instruction_integration_closed' });
  assert.equal(Object.hasOwn(await close, 'value'), true);
  assert.ok(disconnects >= 1);
  assert.equal(harness.control.events.filter(event => event === 'collector-stop-admission').length, 1);
  assert.equal(harness.control.nativeStops.length, 1);
  assert.equal(harness.control.active, 0);
  const launchRef = harness.control.composition.ownedStopState(harness.control.nativeStops[0]).launchRef;
  assert.equal(generated.resolveProof(launchRef), null);
  assert.equal((await generated.connect()).status, 'unknown');
  assert.equal((await generated.observeKnownThread('fixture-native-thread')).status, 'unknown');
  assert.equal(harness.processes.get('codex').length, 0);
});

test('ID-F209-L02 cleanup disconnect rejection remains visible after synchronous bind close reentry', async t => {
  const harness = await fixture(t);
  const integration = await harness.ready;
  const reason = fixtureError('fixture_disconnect_failure');
  let close;
  harness.control.wrapCollector = collector => Object.freeze({ ...collector,
    async disconnect() { await collector.disconnect(); throw reason; },
  });
  harness.control.onBind = () => { close = observe(integration.close()); };
  assert.throws(() => integration.native.startLaunch(harness.startInput('codex', 'disconnect-failure')),
    { code: 'owned_collector_ticket_binding_failed' });
  assert.equal((await close).error, reason);
  assert.equal(harness.control.active, 0);
});

test('ID-F209-L02 a collector operated before ticket binding is refused and cleanup settles it', async t => {
  const harness = await fixture(t);
  const integration = await harness.ready;
  let connect;
  harness.control.wrapCollector = collector => { connect = collector.connect(); return collector; };
  assert.throws(() => integration.native.startLaunch(harness.startInput('codex', 'already-operated')),
    { code: 'owned_collector_ticket_binding_failed' });
  assert.notEqual((await connect).status, 'connected');
  await assert.rejects(integration.close(), { code: 'owned_collector_ticket_binding_failed' });
  assert.equal(harness.control.active, 0);
});

test('ID-F209-L02 observation callback close reentry prevents a new read and proof revival', async t => {
  const harness = await fixture(t);
  const integration = await harness.ready;
  let collector;
  let callbacks = 0;
  let reentered;
  let close;
  harness.control.onBind = value => { collector = value; };
  harness.control.onObservation = observation => {
    callbacks += 1;
    if (close) return;
    close = observe(integration.close());
    reentered = collector.observeKnownThread(observation.nativeId);
  };
  const started = await observe(harness.start('codex', 'observation-reentry'));
  assert.equal(Object.hasOwn(started, 'error'), true);
  assert.ok(callbacks > 0);
  assert.equal(Object.hasOwn(await close, 'value'), true);
  assert.notEqual((await reentered).status, 'observed');
  const stopped = [...harness.processes.get('codex')[0].state.rpcMethods];
  assert.equal(collector.resolveProof(harness.control.composition.ownedStopState(harness.control.nativeStops[0]).launchRef), null);
  assert.notEqual((await collector.connect()).status, 'connected');
  assert.deepEqual(harness.processes.get('codex')[0].state.rpcMethods, stopped);
  assert.equal(harness.control.active, 0);
});

for (const [fault, reason] of [['stopError', undefined], ['collectorDrainError', null]]) {
  test(`ID-F209-L02 falsy ${fault} remains visible to close after other cleanup settles`, async t => {
    const harness = await fixture(t);
    const integration = await harness.ready;
    await harness.start('codex', 'falsy-cleanup');
    harness.control[fault] = reason;
    const closed = await observe(integration.close());
    assert.equal(Object.hasOwn(closed, 'error'), true);
    assert.equal(closed.error, reason);
    assert.equal(harness.control.nativeStops.length, 1);
    assert.equal(harness.control.active, 0);
  });
}

test('standard factory close preserves every falsy service cleanup rejection reason', async t => {
  for (const reason of [undefined, null, false, 0, '']) {
    const harness = await fixture(t, { standard: true });
    const integration = await harness.ready;
    harness.control.serviceCloseError = reason;
    const closed = await observe(integration.close());
    assert.equal(Object.hasOwn(closed, 'error'), true);
    assert.equal(closed.error, reason);
    assert.ok(harness.control.events.includes('service-close'));
    assert.equal(harness.control.gateCount, 0);
    assert.equal(harness.control.active, 0);
  }
});
