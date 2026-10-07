'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createInstructionEnvelope } = require('../src/server/instruction-envelope');
const { createProviderInstructionAdapter } = require('../src/server/provider-instruction-adapter');
const { createInstructionHarness, PROVIDERS } = require('./support/instruction-harness');

async function withHarness(t, provider) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-provider-instruction-'));
  const harness = createInstructionHarness({ provider, origin: 'standalone', directory, state: 'stopped' });
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
