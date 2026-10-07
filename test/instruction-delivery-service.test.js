'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { atomicWriteJson } = require('../src/server/json-storage');
const { createInstructionEnvelope } = require('../src/server/instruction-envelope');
const { createInstructionHarness, PROVIDERS } = require('./support/instruction-harness');

async function createHarness(t, options) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-instruction-'));
  const harness = createInstructionHarness({ ...options, directory });
  t.after(async () => {
    await harness.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await harness.ready();
  return harness;
}

async function waitForState(harness, id, expectedState) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const result = await harness.service.get(id);
    if (result?.delivery?.state === expectedState) return result;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  return harness.service.get(id);
}

function request(harness, overrides = {}) {
  return {
    deliveryAttemptId: 'instruction-attempt-1',
    launchRef: harness.launch.launchRef,
    logicalMessageId: 'instruction-logical-1',
    revision: 1,
    text: '指示本文',
    mode: harness.origin === 'delegated' ? 'steer' : 'start',
    expectedTurnId: harness.origin === 'delegated' ? 'native-fixture-turn' : null,
    ...overrides,
  };
}

test('instruction envelope rejects unpaired surrogates and preserves valid Unicode pairs', () => {
  assert.throws(() => createInstructionEnvelope({ mode: 'start', expectedTurnId: null, text: 'tail\uD800' }),
    { code: 'invalid_instruction_input' });
  assert.throws(() => createInstructionEnvelope({ mode: 'start', expectedTurnId: null, text: '\uDC00head' }),
    { code: 'invalid_instruction_input' });
  const valid = createInstructionEnvelope({ mode: 'start', expectedTurnId: null, text: '\uD83D\uDE00' });
  assert.equal(valid.envelope.input[0].text, '\uD83D\uDE00');
});
for (const provider of PROVIDERS) {
  test(`${provider} delegated steer is created unsent, then applies only from matching capability evidence`, async (t) => {
    const harness = await createHarness(t, {
      provider,
      origin: 'delegated',
      state: 'working',
      evidenceOnDispatch: true,
    });
    const created = await harness.service.create(request(harness));
    assert.equal(created.outcome, 'created');
    assert.equal(created.delivery.kind, 'instruction');
    assert.equal(created.delivery.state, 'available');
    assert.equal(harness.writes.length, 0);

    const sent = await harness.service.send(created.instruction.deliveryAttemptId);
    assert.equal(sent.delivery.state, 'sending');
    assert.equal(harness.writes.length, 1);
    const command = harness.writes[0];
    assert.deepEqual(Object.keys(command).sort(), [
      'deliveryAttemptId', 'expectedTurnId', 'input', 'mode', 'nativeContentDigest',
      'payloadDigest', 'revision', 'source', 'target',
    ].sort());
    assert.equal(command.deliveryAttemptId, created.instruction.deliveryAttemptId);
    assert.equal(command.mode, 'steer');
    assert.equal(command.expectedTurnId, 'native-fixture-turn');
    assert.deepEqual(command.input, [{ type: 'text', text: '指示本文', text_elements: [] }]);

    await harness.service.flush();
    const applied = await waitForState(harness, created.instruction.deliveryAttemptId, 'applied');
    assert.equal(applied.delivery.state, 'applied');
    const publicJson = JSON.stringify(await harness.service.dashboardSnapshot());
    assert.equal(publicJson.includes('指示本文'), false);
  });
}

test('evidence arriving while accepted persistence is pending remains correlatable', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-instruction-accepting-'));
  let holdAccepted = false;
  let acceptedWriteStarted;
  const acceptedStarted = new Promise((resolve) => { acceptedWriteStarted = resolve; });
  let releaseAcceptedWrite;
  const acceptedWriteGate = new Promise((resolve) => { releaseAcceptedWrite = resolve; });
  const harness = createInstructionHarness({
    provider: 'claude', origin: 'delegated', state: 'working', directory,
    atomicWrite: async (target, value) => {
      const accepted = value.ledger.deliveries.some((item) =>
        item.deliveryAttemptId === 'accepting-evidence-attempt' && item.state === 'accepted');
      if (holdAccepted && accepted) {
        holdAccepted = false;
        acceptedWriteStarted();
        await acceptedWriteGate;
      }
      await atomicWriteJson(path.dirname(target), path.basename(target), value);
    },
  });
  t.after(async () => {
    releaseAcceptedWrite();
    await harness.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await harness.ready();
  const created = await harness.service.create(request(harness, {
    deliveryAttemptId: 'accepting-evidence-attempt',
    logicalMessageId: 'accepting-evidence-logical',
  }));
  holdAccepted = true;
  await harness.service.send(created.instruction.deliveryAttemptId);
  await acceptedStarted;
  assert.equal(harness.owner.emitInputEvidence(created.instruction.deliveryAttemptId), true);
  releaseAcceptedWrite();
  await harness.service.flush();
  const result = await waitForState(harness, created.instruction.deliveryAttemptId, 'applied');
  assert.equal(result.delivery.state, 'applied');
  assert.equal(harness.writes.length, 1);
});
test('conflict during the applied checkpoint write remains an applied delivery with a body-free diagnostic', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-instruction-commit-'));
  let holdApplied = false;
  let appliedWriteStarted;
  const appliedStarted = new Promise((resolve) => { appliedWriteStarted = resolve; });
  let releaseAppliedWrite;
  const appliedWriteGate = new Promise((resolve) => { releaseAppliedWrite = resolve; });
  const harness = createInstructionHarness({
    provider: 'codex', origin: 'delegated', state: 'working', directory,
    atomicWrite: async (target, value) => {
      const applied = value.ledger.deliveries.some((item) =>
        item.deliveryAttemptId === 'commit-conflict-attempt' && item.state === 'applied');
      if (holdApplied && applied) {
        holdApplied = false;
        appliedWriteStarted();
        await appliedWriteGate;
      }
      await atomicWriteJson(path.dirname(target), path.basename(target), value);
    },
  });
  t.after(async () => {
    releaseAppliedWrite();
    await harness.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await harness.ready();
  const created = await harness.service.create(request(harness, {
    deliveryAttemptId: 'commit-conflict-attempt',
    logicalMessageId: 'commit-conflict-logical',
  }));
  await harness.service.send(created.instruction.deliveryAttemptId);
  await waitForState(harness, created.instruction.deliveryAttemptId, 'accepted');
  holdApplied = true;
  assert.equal(harness.owner.emitInputEvidence(created.instruction.deliveryAttemptId), true);
  await appliedStarted;
  const responseLost = harness.service.reportResponseLost(created.instruction.deliveryAttemptId);
  assert.equal(harness.owner.emitInputEvidence(created.instruction.deliveryAttemptId, {
    input: [{ type: 'text', text: 'private conflicting body', text_elements: [] }],
  }), false);
  releaseAppliedWrite();
  await harness.service.flush();
  const lostResult = await responseLost;
  const current = await waitForState(harness, created.instruction.deliveryAttemptId, 'applied');
  assert.equal(lostResult.outcome, 'unchanged');
  assert.equal(lostResult.delivery.state, 'applied');
  assert.equal(current.delivery.state, 'applied');
  const snapshot = await harness.service.dashboardSnapshot();
  assert.deepEqual(snapshot.diagnostics.map(({ deliveryAttemptId, code }) => ({ deliveryAttemptId, code })), [{
    deliveryAttemptId: created.instruction.deliveryAttemptId,
    code: 'instruction_evidence_conflict',
  }]);
  assert.equal(JSON.stringify(snapshot).includes('private conflicting body'), false);
});

test('response loss closes a pre-commit evidence match before queued store reads resume', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-instruction-response-loss-'));
  let holdCancel = false;
  let cancelWriteStarted;
  const cancelStarted = new Promise((resolve) => { cancelWriteStarted = resolve; });
  let releaseCancelWrite;
  const cancelWriteGate = new Promise((resolve) => { releaseCancelWrite = resolve; });
  let appliedCheckpointWrites = 0;
  const harness = createInstructionHarness({
    provider: 'claude', origin: 'delegated', state: 'working', directory,
    atomicWrite: async (target, value) => {
      const delivery = value.ledger.deliveries.find((item) => item.deliveryAttemptId === 'response-loss-race');
      if (delivery?.state === 'applied') appliedCheckpointWrites += 1;
      if (holdCancel && delivery?.cancelRequested) {
        holdCancel = false;
        cancelWriteStarted();
        await cancelWriteGate;
      }
      await atomicWriteJson(path.dirname(target), path.basename(target), value);
    },
  });
  t.after(async () => {
    releaseCancelWrite();
    await harness.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await harness.ready();
  const created = await harness.service.create(request(harness, {
    deliveryAttemptId: 'response-loss-race', logicalMessageId: 'response-loss-race-logical',
  }));
  await harness.service.send(created.instruction.deliveryAttemptId);
  await waitForState(harness, created.instruction.deliveryAttemptId, 'accepted');

  holdCancel = true;
  const cancel = harness.providerAdapters.claude.cancel(created.instruction.deliveryAttemptId);
  await cancelStarted;
  assert.equal(harness.owner.emitInputEvidence(created.instruction.deliveryAttemptId), true);
  await new Promise((resolve) => setImmediate(resolve));
  const responseLost = harness.service.reportResponseLost(created.instruction.deliveryAttemptId);
  releaseCancelWrite();
  await cancel;
  const result = await responseLost;
  await harness.service.flush();

  assert.equal(appliedCheckpointWrites, 0);
  assert.equal(result.delivery.state, 'unknown');
  assert.equal((await waitForState(harness, created.instruction.deliveryAttemptId, 'unknown')).delivery.state, 'unknown');
});

test('closing the service synchronously closes pre-commit evidence while store reads are queued', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-instruction-close-race-'));
  let holdCancel = false;
  let cancelWriteStarted;
  const cancelStarted = new Promise((resolve) => { cancelWriteStarted = resolve; });
  let releaseCancelWrite;
  const cancelWriteGate = new Promise((resolve) => { releaseCancelWrite = resolve; });
  let appliedCheckpointWrites = 0;
  const harness = createInstructionHarness({
    provider: 'codex', origin: 'delegated', state: 'working', directory,
    atomicWrite: async (target, value) => {
      const delivery = value.ledger.deliveries.find((item) => item.deliveryAttemptId === 'close-race');
      if (delivery?.state === 'applied') appliedCheckpointWrites += 1;
      if (holdCancel && delivery?.cancelRequested) {
        holdCancel = false;
        cancelWriteStarted();
        await cancelWriteGate;
      }
      await atomicWriteJson(path.dirname(target), path.basename(target), value);
    },
  });
  t.after(async () => {
    releaseCancelWrite();
    await harness.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await harness.ready();
  const created = await harness.service.create(request(harness, {
    deliveryAttemptId: 'close-race', logicalMessageId: 'close-race-logical',
  }));
  await harness.service.send(created.instruction.deliveryAttemptId);
  await waitForState(harness, created.instruction.deliveryAttemptId, 'accepted');

  holdCancel = true;
  const cancel = harness.providerAdapters.codex.cancel(created.instruction.deliveryAttemptId);
  await cancelStarted;
  assert.equal(harness.owner.emitInputEvidence(created.instruction.deliveryAttemptId), true);
  await new Promise((resolve) => setImmediate(resolve));
  const closing = harness.service.close();
  releaseCancelWrite();
  await cancel;
  await closing;

  assert.equal(appliedCheckpointWrites, 0);
  assert.equal((await harness.store.get(created.instruction.deliveryAttemptId)).state, 'unknown');
});

test('closing the service waits for a guarded applied checkpoint already in progress', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-instruction-close-commit-'));
  let holdApplied = false;
  let appliedWriteStarted;
  const appliedStarted = new Promise((resolve) => { appliedWriteStarted = resolve; });
  let releaseAppliedWrite;
  const appliedWriteGate = new Promise((resolve) => { releaseAppliedWrite = resolve; });
  const harness = createInstructionHarness({
    provider: 'claude', origin: 'delegated', state: 'working', directory,
    atomicWrite: async (target, value) => {
      const applied = value.ledger.deliveries.some((item) =>
        item.deliveryAttemptId === 'close-commit' && item.state === 'applied');
      if (holdApplied && applied) {
        holdApplied = false;
        appliedWriteStarted();
        await appliedWriteGate;
      }
      await atomicWriteJson(path.dirname(target), path.basename(target), value);
    },
  });
  t.after(async () => {
    releaseAppliedWrite();
    await harness.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  await harness.ready();
  const created = await harness.service.create(request(harness, {
    deliveryAttemptId: 'close-commit', logicalMessageId: 'close-commit-logical',
  }));
  await harness.service.send(created.instruction.deliveryAttemptId);
  await waitForState(harness, created.instruction.deliveryAttemptId, 'accepted');
  holdApplied = true;
  assert.equal(harness.owner.emitInputEvidence(created.instruction.deliveryAttemptId), true);
  await appliedStarted;

  const closing = harness.service.close();
  releaseAppliedWrite();
  await closing;

  assert.equal((await harness.store.get(created.instruction.deliveryAttemptId)).state, 'applied');
});
test('accepted acknowledgement alone never marks an instruction applied', async (t) => {
  const harness = await createHarness(t, { provider: 'codex', origin: 'delegated', state: 'working' });
  const created = await harness.service.create(request(harness));
  await harness.service.send(created.instruction.deliveryAttemptId);
  const accepted = await waitForState(harness, created.instruction.deliveryAttemptId, 'accepted');
  assert.equal(accepted.delivery.state, 'accepted');
  assert.equal(harness.writes.length, 1);
  assert.equal(harness.owner.emitInputEvidence(created.instruction.deliveryAttemptId), true);
  await harness.service.flush();
  const applied = await waitForState(harness, created.instruction.deliveryAttemptId, 'applied');
  assert.equal(applied.delivery.state, 'applied');
});

test('standalone start is explicit and delegated or review start is rejected before persistence', async (t) => {
  const standalone = await createHarness(t, { provider: 'claude', origin: 'standalone', state: 'stopped' });
  const created = await standalone.service.create(request(standalone));
  assert.equal(created.delivery.state, 'available');
  assert.equal(standalone.writes.length, 0);
  const sent = await standalone.service.send(created.instruction.deliveryAttemptId);
  assert.equal(sent.delivery.state, 'sending');
  assert.equal(standalone.writes.length, 1);

  const delegated = await createHarness(t, { provider: 'claude', origin: 'delegated', state: 'working' });
  await assert.rejects(delegated.service.create(request(delegated, {
    deliveryAttemptId: 'delegated-start', logicalMessageId: 'delegated-start', mode: 'start', expectedTurnId: null,
  })), { code: 'instruction_origin_mode_mismatch' });
  const review = await createHarness(t, { provider: 'codex', origin: 'review', state: 'working' });
  await assert.rejects(review.service.create(request(review, {
    deliveryAttemptId: 'review-steer', logicalMessageId: 'review-steer', mode: 'steer',
  })), { code: 'instruction_review_not_supported' });
  assert.equal((await review.service.dashboardSnapshot()).instructions.length, 0);
  assert.equal(review.writes.length, 0);
});

test('standalone alternative persists supersede before new create and resumes with the same attempt', async (t) => {
  const harness = await createHarness(t, { provider: 'codex', origin: 'standalone', state: 'stopped' });
  const original = await harness.service.create(request(harness));
  const alternative = {
    newDeliveryAttemptId: 'instruction-attempt-2',
    logicalMessageId: original.instruction.logicalMessageId,
    revision: original.instruction.revision + 1,
    text: '次の入力',
    mode: 'next-user-input',
    expectedTurnId: null,
  };
  const first = await harness.service.supersedeUnsent(original.instruction.deliveryAttemptId, alternative);
  assert.equal(first.previous.state, 'superseded_before_send');
  assert.equal(first.delivery.state, 'available');
  assert.equal(harness.writes.length, 0);
  const resumed = await harness.service.supersedeUnsent(original.instruction.deliveryAttemptId, alternative);
  assert.equal(resumed.instruction.deliveryAttemptId, alternative.newDeliveryAttemptId);
  assert.equal(resumed.delivery.state, 'available');
  assert.equal(harness.writes.length, 0);
});
