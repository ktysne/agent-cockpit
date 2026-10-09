'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createEmptyLedger, createDelivery, transitionDelivery } = require('../src/server/delivery-ledger');
const { sourceProjectionFromLaunch } = require('../src/server/instruction-delivery-journal');
const { projectInstructionDeliveryReferences } = require('../src/server/instruction-reclamation-correlation');
const { normalizeDeliveryRecordV2Local, normalizeDeliveryLedgerV2Local } = require('../src/server/delivery-reclamation-codec');
const { transitionReclamationDelivery } = require('../src/server/delivery-reclamation-runtime');

function fixture(provider = 'claude', state = 'applied') {
  const launch = {
    launchRef: 'launch-ref', launchId: 'launch-id', runId: 'run-id', attemptId: 'launch-attempt',
    provider, nativeIdKind: provider === 'claude' ? 'session' : 'thread', hostId: 'host-id', homeScopeId: 'home-id',
    origin: 'standalone', purpose: 'agent', originBinding: null, state: 'bound',
    identity: { provider, nativeIdKind: provider === 'claude' ? 'session' : 'thread',
      hostId: 'host-id', homeScopeId: 'home-id', nativeId: 'native-id' },
    executionBinding: { periodId: 'period-id', actor: { kind: 'agent', id: 'actor-id' } },
    conversationId: 'conversation-id', sessionId: 'session-id',
  };
  let result = createDelivery(createEmptyLedger(), 'instruction', {
    deliveryAttemptId: 'delivery-id', logicalMessageId: 'logical-id', revision: 1, payload: 'body',
  }, launch);
  const correlation = { deliveryAttemptId: 'delivery-id', revision: 1, payloadDigest: result.delivery.payloadDigest,
    targetPeriodId: 'period-id', nativeTurnId: 'turn-id', nativeItemId: 'item-id', clientRequestId: 'delivery-id' };
  if (state === 'applied') {
    result = transitionDelivery(result.ledger, 'delivery-id', 'claim');
    result = transitionDelivery(result.ledger, 'delivery-id', 'sendStart');
    result = transitionDelivery(result.ledger, 'delivery-id', 'applied', correlation);
  } else result = transitionDelivery(result.ledger, 'delivery-id', state === 'cancelled_before_send' ? 'cancel' : 'supersede');
  const { source, target, ...fixed } = result.delivery;
  const refs = projectInstructionDeliveryReferences(sourceProjectionFromLaunch(launch));
  const grave = normalizeDeliveryRecordV2Local({ recordType: 'reclaimed', ...fixed,
    terminalAt: 1000, sourceRef: refs.sourceRef, targetRef: refs.targetRef,
    reclamation: { operationId: '11111111-1111-4111-8111-111111111111', reclaimedAt: 604801000,
      reason: 'terminal_retention' } });
  const ledger = normalizeDeliveryLedgerV2Local({ schemaVersion: 2, revision: 8, deliveries: [grave],
    notificationTargets: [], logicalTombstones: result.ledger.logicalTombstones });
  return { checkpoint: { ledger }, grave, correlation };
}

for (const provider of ['claude', 'codex']) {
  test(`${provider} applied grave accepts compatible accepted correlation without changing body or terminal facts`, () => {
    const { checkpoint, grave, correlation } = fixture(provider);
    const result = transitionReclamationDelivery(checkpoint, 'delivery-id', 'accepted', correlation, () => 999999999);
    assert.equal(result.changed, true);
    assert.equal(result.ledger.revision, 9);
    const { acceptedCorrelation, ...fixed } = result.delivery;
    assert.deepEqual(fixed, (({ acceptedCorrelation, ...rest }) => rest)(grave));
    assert.deepEqual(acceptedCorrelation, grave.appliedCorrelation);
    const duplicate = transitionReclamationDelivery({ ledger: result.ledger }, 'delivery-id', 'accepted', correlation);
    assert.equal(duplicate.changed, false);
    assert.equal(duplicate.ledger, result.ledger);
  });
  test(`${provider} applied grave accepts only the exact applied duplicate and rejects native ID replacement`, () => {
    const { checkpoint, grave, correlation } = fixture(provider);
    const duplicate = transitionReclamationDelivery(checkpoint, 'delivery-id', 'applied', correlation);
    assert.equal(duplicate.changed, false);
    assert.deepEqual(duplicate.delivery, grave);
    for (const field of ['deliveryAttemptId', 'revision', 'payloadDigest', 'targetPeriodId',
      'nativeTurnId', 'nativeItemId', 'clientRequestId']) {
      const wrong = { ...correlation, [field]: field === 'revision' ? 2 : 'different' };
      assert.throws(() => transitionReclamationDelivery(checkpoint, 'delivery-id', 'applied', wrong));
      assert.throws(() => transitionReclamationDelivery(checkpoint, 'delivery-id', 'accepted', wrong));
    }
    for (const operation of ['claim', 'sendStart', 'unknown', 'cancel', 'supersede']) {
      assert.throws(() => transitionReclamationDelivery(checkpoint, 'delivery-id', operation),
        { code: 'delivery_reclaimed' });
    }
  });
  test(`${provider} cancelled and superseded graves reject all native correlation`, () => {
    for (const state of ['cancelled_before_send', 'superseded_before_send']) {
      const { checkpoint, correlation } = fixture(provider, state);
      for (const operation of ['accepted', 'applied']) assert.throws(() =>
        transitionReclamationDelivery(checkpoint, 'delivery-id', operation, correlation), { code: 'delivery_reclaimed' });
    }
  });
}

for (const provider of ['claude', 'codex']) {
  test(`${provider} observation witness reads existing context without renewing a used send capability`, async (t) => {
    const fs = require('node:fs/promises');
    const os = require('node:os');
    const path = require('node:path');
    const { createInstructionHarness } = require('./support/instruction-harness');
    const { createInstructionEnvelope } = require('../src/server/instruction-envelope');
    const { createProviderInstructionAdapter } = require('../src/server/provider-instruction-adapter');
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'instruction-terminal-witness-'));
    const harness = createInstructionHarness({ provider, origin: 'standalone', directory, state: 'stopped' });
    t.after(async () => { await harness.close(); await fs.rm(directory, { recursive: true, force: true }); });
    await harness.ready();
    const created = await harness.service.create({ deliveryAttemptId: 'witness-id', launchRef: harness.launch.launchRef,
      logicalMessageId: 'witness-logical', revision: 1, text: 'witness input', mode: 'start', expectedTurnId: null });
    const envelope = createInstructionEnvelope({ mode: 'start', expectedTurnId: null, text: 'witness input' });
    let checks = 0;
    let writes = 0;
    let prepares = 0;
    let closedListener;
    const capability = Object.freeze({});
    const owner = {
      prepareInstructionDispatch() { prepares += 1; return capability; },
      checkInstructionDispatch(value) { checks += 1; return value === capability; },
      dispatchInstructionNow(value, command) {
        assert.equal(value, capability); writes += 1;
        return Promise.resolve({ clientRequestId: command.deliveryAttemptId, nativeTurnId: 'witness-turn', nativeItemId: null });
      },
      subscribeInstructionEvidence() { return () => {}; },
      subscribeInstructionClosed(listener) { closedListener = listener; return () => {}; },
      closeInstructionObservation() { return true; },
    };
    const adapter = createProviderInstructionAdapter(provider, {
      deliveryAdapter: harness.providerAdapters[provider], nativeOwner: owner,
      setTimeoutImpl() { return { unref() {} }; }, clearTimeoutImpl() {},
    });
    t.after(() => adapter.close());
    adapter.onAccepted(() => true);
    const prepared = await adapter.prepareInstructionDispatch(created.delivery, {
      envelope: envelope.serialized, envelopeDigest: envelope.envelopeDigest, nativeContentDigest: envelope.nativeContentDigest,
    });
    assert.equal(adapter.hasInstructionObservation('witness-id', prepared.sourceToken), false);
    await adapter.dispatchInstructionNow(created.delivery, envelope.serialized, () => true);
    const checksAfterSend = checks;
    assert.equal(adapter.hasInstructionObservation('witness-id', prepared.sourceToken), true);
    assert.equal(adapter.hasInstructionObservation('witness-id', Symbol('different-source')), false);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 120000;
      assert.equal(adapter.hasInstructionObservation('witness-id', prepared.sourceToken), true);
    } finally { Date.now = realNow; }
    assert.equal(checks, checksAfterSend);
    assert.equal(prepares, 1);
    assert.equal(writes, 1);
    closedListener(capability, 'instruction_context_ended');
    assert.equal(adapter.hasInstructionObservation('witness-id', prepared.sourceToken), false);
    assert.equal(adapter.closeInstructionObservation('witness-id', prepared.sourceToken), false);
    assert.equal(prepares, 1);
    assert.equal(writes, 1);
  });
}
