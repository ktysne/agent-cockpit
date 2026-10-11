'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createNativeFactoryLifetimeHarness } = require('./support/native-factory-lifetime-harness');

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'native-factory-lifetime-'));
  const harness = await createNativeFactoryLifetimeHarness(directory, options);
  t.after(async () => {
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
