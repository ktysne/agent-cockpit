'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createInstructionEnvelope } = require('../src/server/instruction-envelope');
const { createProviderInstructionAdapter } = require('../src/server/provider-instruction-adapter');
const { createInstructionHarness, PROVIDERS } = require('./support/instruction-harness');

async function withHarness(t, provider, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-provider-instruction-'));
  const harness = createInstructionHarness({ ...options, provider, origin: 'standalone', directory, state: 'stopped' });
  t.after(async () => {
    await harness.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await harness.ready();
  const created = await harness.service.create({
    deliveryAttemptId: 'provider-conformance-' + provider,
    launchRef: harness.launch.launchRef,
    logicalMessageId: 'provider-conformance-logical-' + provider,
    revision: 1,
    text: 'fixture instruction',
    mode: 'start',
    expectedTurnId: null,
  });
  return { harness, created };
}

for (const provider of PROVIDERS) {
  test(`${provider} ID-F08-NI14 late exact evidence commits observation unknown to applied without resending`, async t => {
    let now = 1000; const jobs = new Set();
    const { harness, created } = await withHarness(t, provider, { lateObservation: true, now: () => now,
      setTimeoutImpl(callback, delay) { const job = { callback, delay, unref() {} }; jobs.add(job); return job; }, clearTimeoutImpl(job) { jobs.delete(job); } });
    await harness.service.send(created.delivery.deliveryAttemptId);
    for (let index = 0; index < 100; index += 1) {
      if ((await harness.service.get(created.delivery.deliveryAttemptId)).delivery.state === 'accepted') break;
      await new Promise(resolve => setImmediate(resolve));
    }
    await new Promise(resolve => setImmediate(resolve));
    assert.equal((await harness.service.get(created.delivery.deliveryAttemptId)).delivery.state, 'accepted');
    now += 60001; const expiry = [...jobs].find(job => job.delay === 60000); assert.ok(expiry); expiry.callback();
    assert.equal((await harness.service.get(created.delivery.deliveryAttemptId)).delivery.state, 'unknown');
    assert.equal(harness.owner.emitInputEvidence(created.delivery.deliveryAttemptId), true);
    for (let index = 0; index < 100; index += 1) {
      if ((await harness.service.get(created.delivery.deliveryAttemptId)).delivery.state === 'applied') break;
      await new Promise(resolve => setImmediate(resolve));
    }
    assert.equal((await harness.service.get(created.delivery.deliveryAttemptId)).delivery.state, 'applied');
    assert.equal(harness.writes.length, 1);
    assert.equal(harness.owner.emitInputEvidence(created.delivery.deliveryAttemptId), false);
  });
  test(`${provider} observation expiry is recoverable only with an owner close subscription and stale source closure is rejected`, async t => {
    const { harness, created } = await withHarness(t, provider);
    const envelope = createInstructionEnvelope({ mode: 'start', expectedTurnId: null, text: 'fixture instruction' });
    const intent = { envelope: envelope.serialized, envelopeDigest: envelope.envelopeDigest, nativeContentDigest: envelope.nativeContentDigest };
    for (const extended of [false, true]) {
      let capability; let evidenceListener; let closedListener; let writes = 0; let closes = 0; const jobs = new Set();
      const owner = {
        prepareInstructionDispatch() { capability = Object.freeze({}); return capability; }, checkInstructionDispatch() { return true; },
        dispatchInstructionNow(cap, command) { writes += 1; return Promise.resolve({ clientRequestId: command.deliveryAttemptId, nativeTurnId: 'turn-observed', nativeItemId: null }); },
        subscribeInstructionEvidence(listener) { evidenceListener = listener; return () => {}; },
        ...(extended ? { subscribeInstructionClosed(listener) { closedListener = listener; return () => {}; }, closeInstructionObservation() { closes += 1; return true; } } : {}),
      };
      const adapter = createProviderInstructionAdapter(provider, { deliveryAdapter: harness.providerAdapters[provider], nativeOwner: owner,
        setTimeoutImpl(callback, delay) { const job = { callback, delay, unref() {} }; jobs.add(job); return job; }, clearTimeoutImpl(job) { jobs.delete(job); } });
      const unknown = []; let observed = 0; adapter.onUnknown((id, reason) => unknown.push(reason)); adapter.onAccepted(() => true); adapter.onEvidence(() => { observed += 1; return true; });
      const old = await adapter.prepareInstructionDispatch(created.delivery, intent); adapter.abandon(created.delivery.deliveryAttemptId);
      const prepared = await adapter.prepareInstructionDispatch(created.delivery, intent);
      assert.equal(prepared.recoverAfterExpiry, extended);
      assert.equal(adapter.closeInstructionObservation(created.delivery.deliveryAttemptId, old.sourceToken), false);
      await adapter.dispatchInstructionNow(created.delivery, envelope.serialized, () => true);
      const expiry = [...jobs].find(job => job.delay === 60000); assert.ok(expiry); expiry.callback();
      assert.equal(evidenceListener(capability, {}), extended); assert.equal(observed, extended ? 1 : 0); assert.equal(writes, 1);
      if (extended) { closedListener(capability, 'instruction_context_ended'); assert.equal(evidenceListener(capability, {}), false); assert.equal(adapter.closeInstructionObservation(created.delivery.deliveryAttemptId, prepared.sourceToken), false); assert.equal(closes, 2); }
      assert.deepEqual(unknown, extended ? ['instruction_evidence_expired', 'instruction_context_ended'] : ['instruction_capability_expired']);
      adapter.close();
    }
  });
}

for (const provider of PROVIDERS) {
  test(`${provider} adapter ignores JSON-shaped evidence without its prepared capability`, async (t) => {
    const { harness, created } = await withHarness(t, provider);
    const envelope = createInstructionEnvelope({ mode: 'start', expectedTurnId: null, text: 'fixture instruction' });
    let capability;
    let evidenceListener;
    const writes = [];
    const owner = {
      prepareInstructionDispatch() {
        capability = Object.freeze({});
        return capability;
      },
      checkInstructionDispatch(received) {
        return received === capability;
      },
      dispatchInstructionNow(received, command) {
        assert.equal(received, capability);
        writes.push(command);
        if (evidenceListener) evidenceListener(received, {
          source: command.source,
          target: command.target,
          clientRequestId: command.deliveryAttemptId,
          nativeTurnId: 'native-started-turn',
          nativeItemId: 'native-item-fixture',
          input: command.input,
        });
        return Promise.resolve({
          clientRequestId: command.deliveryAttemptId,
          nativeTurnId: 'native-started-turn',
          nativeItemId: null,
        });
      },
      subscribeInstructionEvidence(listener) {
        evidenceListener = listener;
        return () => { evidenceListener = null; };
      },
    };
    const adapter = createProviderInstructionAdapter(provider, {
      deliveryAdapter: harness.providerAdapters[provider],
      nativeOwner: owner,
    });
    const received = [];
    adapter.onEvidence((id, sourceToken, evidence) => {
      received.push({ id, sourceToken, evidence });
      return true;
    });
    adapter.onAccepted(() => true);
    const intent = {
      envelope: envelope.serialized,
      envelopeDigest: envelope.envelopeDigest,
      nativeContentDigest: envelope.nativeContentDigest,
    };
    const prepared = await adapter.prepareInstructionDispatch(created.delivery, intent);
    assert.equal(prepared.ok, true);
    const evidence = {
      source: created.delivery.source,
      target: created.delivery.target,
      clientRequestId: created.delivery.deliveryAttemptId,
      nativeTurnId: 'native-started-turn',
      nativeItemId: 'native-item-fixture',
      input: envelope.envelope.input,
      verified: true,
    };
    assert.equal(evidenceListener({}, evidence), false);
    assert.equal(received.length, 0);
    assert.equal(evidenceListener(capability, evidence), false);
    assert.equal(received.length, 0);

    await adapter.dispatchInstructionNow(created.delivery, envelope.serialized, () => true);
    assert.equal(writes.length, 1);
    assert.equal(received.length, 1);
    assert.equal(received[0].id, created.delivery.deliveryAttemptId);
    assert.equal(received[0].sourceToken, prepared.sourceToken);
    await adapter.close();
  });
}

test('known async authorization and dispatch functions are unavailable before native write', async (t) => {
  const { harness, created } = await withHarness(t, 'claude');
  for (const asyncMethod of ['checkInstructionDispatch', 'dispatchInstructionNow']) {
    let writeCalls = 0;
    const owner = {
      prepareInstructionDispatch() { return Object.freeze({}); },
      subscribeInstructionEvidence() { return () => {}; },
      checkInstructionDispatch: async () => true,
      dispatchInstructionNow: () => {
        writeCalls += 1;
        return Promise.resolve({ clientRequestId: created.delivery.deliveryAttemptId,
          nativeTurnId: 'native-started-turn', nativeItemId: null });
      },
    };
    if (asyncMethod === 'dispatchInstructionNow') {
      owner.checkInstructionDispatch = () => true;
      owner.dispatchInstructionNow = async () => {
        writeCalls += 1;
        return { clientRequestId: created.delivery.deliveryAttemptId,
          nativeTurnId: 'native-started-turn', nativeItemId: null };
      };
    }
    const adapter = createProviderInstructionAdapter('claude', {
      deliveryAdapter: harness.providerAdapters.claude,
      nativeOwner: owner,
    });
    assert.equal(adapter.available, false);
    assert.deepEqual(await adapter.prepareInstructionDispatch(created.delivery, {
      envelope: '{}', envelopeDigest: 'a'.repeat(64), nativeContentDigest: 'b'.repeat(64),
    }), { ok: false, heldReason: 'instruction_dispatch_unavailable' });
    assert.equal(writeCalls, 0);
    adapter.close();
  }
});
