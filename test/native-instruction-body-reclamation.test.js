'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { encodeCheckpointV3Local } = require('../src/server/delivery-reclamation-codec');
const { createNativeInstructionBodyReclamationHarness, PROVIDERS } = require('./support/native-instruction-body-reclamation-harness');

const DATA_FILES = Object.freeze({
  checkpoint: 'delivery-checkpoint.json',
  instructions: 'instruction-journal.json',
  questions: 'common-question-journal.json',
});
const RETENTION_MS = 604_800_000;
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

async function temporaryDirectory() {
  return fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'native-instruction-body-reclamation-'));
}

async function createHarness(t, provider, options = {}) {
  const directory = await temporaryDirectory();
  let now = options.initialNow ?? 1_000_000;
  const harness = createNativeInstructionBodyReclamationHarness({
    directory,
    now: () => now,
    ...(options.instructionEvidence ? { instructionEvidence: options.instructionEvidence } : {}),
    ...(options.reclamation ? { reclamation: options.reclamation } : {}),
  });
  t.after(async () => {
    try { await harness.close(); } catch {}
    await fs.rm(directory, { recursive: true, force: true });
  });
  await harness.ready;
  return { directory, harness, setNow(value) { now = value; } };
}

async function startWriter(harness, provider, suffix) {
  const started = await harness.start(provider, suffix);
  const launchRef = started.result?.launchRef || started.launchRef;
  const writer = harness.writerFor(launchRef);
  assert.ok(writer);
  return { started, writer, launchRef };
}

async function createInstruction(harness, provider, started, suffix) {
  const deliveryAttemptId = `instruction-${provider}-${suffix}`;
  const mode = provider === 'claude' ? 'start' : 'steer';
  if (mode === 'start') started.process.endCurrentContext();
  const input = {
    deliveryAttemptId,
    launchRef: started.result?.launchRef || started.launchRef,
    logicalMessageId: `logical-${provider}-${suffix}`,
    revision: 1,
    text: `native instruction body ${suffix}`,
    mode,
    expectedTurnId: mode === 'start' ? null : started.process.state.turnId,
  };
  await harness.instructionService.create(input);
  return input;
}

async function waitForDelivery(service, id, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let result;
  do {
    result = await service.get(id);
    if (predicate(result?.delivery)) return result.delivery;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`delivery did not reach the expected state; last state: ${result?.delivery?.state}`);
}

async function completeState(harness, provider, started, state, suffix) {
  const input = await createInstruction(harness, provider, started, suffix);
  if (state === 'applied') {
    await harness.instructionService.send(input.deliveryAttemptId);
    const delivery = await waitForDelivery(harness.instructionService, input.deliveryAttemptId,
      (item) => item?.state === 'applied');
    return { input, delivery };
  }
  if (state === 'cancelled_before_send') {
    const result = await harness.instructionService.cancel(input.deliveryAttemptId);
    return { input, delivery: result.delivery };
  }
  if (state === 'superseded_before_send') {
    const result = await harness.instructionService.supersedeUnsent(input.deliveryAttemptId, {
      newDeliveryAttemptId: `replacement-${provider}-${suffix}`,
      logicalMessageId: input.logicalMessageId,
      revision: input.revision + 1,
      text: 'replacement remains unsent',
      mode: 'next-user-input',
      expectedTurnId: null,
    });
    const updated = await harness.instructionService.get(input.deliveryAttemptId);
    return { input, delivery: updated.delivery };
  }
  if (state === 'unknown') {
    await harness.instructionService.send(input.deliveryAttemptId);
    await waitForDelivery(harness.instructionService, input.deliveryAttemptId,
      (item) => item?.state === 'accepted');
    const result = await harness.instructionService.reportResponseLost(input.deliveryAttemptId);
    return { input, delivery: result.delivery };
  }
  throw new TypeError('unsupported instruction state');
}

async function prepareServiceAcceptedGrave(t, suffix) {
  const { harness, setNow } = await createHarness(t, 'codex', { instructionEvidence: 'full' });
  const { started } = await startWriter(harness, 'codex', suffix);
  const input = await createInstruction(harness, 'codex', started, suffix);
  const hold = harness.holdNextAccepted('codex', input.deliveryAttemptId);
  const sent = await harness.instructionService.send(input.deliveryAttemptId);
  assert.equal(sent.outcome, 'sending');

  const acceptedEvent = await hold.received;
  const sourceToken = harness.sourceToken(input.deliveryAttemptId);
  assert.ok(sourceToken);
  assert.strictEqual(acceptedEvent.sourceToken, sourceToken);
  assert.equal(acceptedEvent.accepted.clientRequestId, input.deliveryAttemptId);
  const observed = harness.instructionEvidence(input.deliveryAttemptId);
  assert.ok(observed);
  assert.strictEqual(observed.sourceToken, sourceToken);
  assert.equal(observed.evidence.nativeTurnId, acceptedEvent.accepted.nativeTurnId);

  const adapter = harness.deliveryAdapter('codex');
  const sending = await adapter.get(input.deliveryAttemptId);
  assert.equal(sending.state, 'sending');
  assert.equal(sending.acceptedCorrelation, null);
  const appliedCorrelation = {
    deliveryAttemptId: sending.deliveryAttemptId,
    revision: sending.revision,
    payloadDigest: sending.payloadDigest,
    targetPeriodId: sending.target.periodId,
    nativeTurnId: observed.evidence.nativeTurnId,
    nativeItemId: observed.evidence.nativeItemId,
    clientRequestId: acceptedEvent.accepted.clientRequestId,
  };
  await adapter.recordApplied(input.deliveryAttemptId, appliedCorrelation);
  const applied = await adapter.get(input.deliveryAttemptId);
  assert.equal(applied.state, 'applied');
  assert.equal(applied.acceptedCorrelation, null);
  assert.deepEqual({ ...applied.appliedCorrelation }, appliedCorrelation);

  setNow(applied.terminalAt + RETENTION_MS);
  assert.deepEqual(await harness.reclamationService.reclaimInstructionBody({
    deliveryAttemptId: input.deliveryAttemptId,
  }), { status: 'complete', deliveryAttemptId: input.deliveryAttemptId });
  const grave = await adapter.get(input.deliveryAttemptId);
  assert.equal(grave.recordType, 'reclaimed');
  assert.equal(grave.state, 'applied');
  assert.equal(grave.acceptedCorrelation, null);
  assert.deepEqual({ ...grave.appliedCorrelation }, appliedCorrelation);
  assert.equal(harness.instructionAdapter('codex').hasInstructionObservation(
    input.deliveryAttemptId, sourceToken), true);
  return { harness, input, acceptedEvent, sourceToken, hold, appliedCorrelation };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function readSlots(harness) {
  const result = {};
  for (const [slot, basename] of Object.entries(DATA_FILES)) {
    result[slot] = await fs.readFile(path.join(harness.directory, basename));
  }
  result.anchor = await fs.readFile(harness.pathFor('anchor'));
  return result;
}

function totalInstructionWrites(harness, provider) {
  return harness.processesByProvider.get(provider).reduce((count, process) =>
    count + process.state.instructionWrites.length, 0);
}

async function finishReclamation(harness, input, setNow, delivery) {
  setNow(delivery.terminalAt + RETENTION_MS);
  return harness.reclamationService.reclaimInstructionBody({ deliveryAttemptId: input.deliveryAttemptId });
}

async function restartWithDeliveryState(harness, input, state, terminalAt = null) {
  await harness.restart(async () => {
    const checkpointPath = harness.pathFor('checkpoint');
    const checkpoint = await readJson(checkpointPath);
    const delivery = checkpoint.ledger.deliveries.find((item) =>
      item.deliveryAttemptId === input.deliveryAttemptId);
    assert.ok(delivery);
    const correlation = {
      deliveryAttemptId: delivery.deliveryAttemptId,
      revision: delivery.revision,
      payloadDigest: delivery.payloadDigest,
      targetPeriodId: delivery.target.periodId,
      nativeTurnId: `fixture-turn-${delivery.deliveryAttemptId}`,
      nativeItemId: null,
      clientRequestId: delivery.deliveryAttemptId,
    };
    delivery.state = state;
    delivery.cancelRequested = false;
    delivery.terminalAt = terminalAt;
    delivery.acceptedCorrelation = ['accepted', 'unknown'].includes(state) ? correlation : null;
    delivery.appliedCorrelation = state === 'applied'
      ? { ...correlation, nativeItemId: `fixture-item-${delivery.deliveryAttemptId}` }
      : null;
    checkpoint.revision += 1;
    checkpoint.ledger.revision += 1;
    await fs.writeFile(checkpointPath, encodeCheckpointV3Local(checkpoint).bytes);
  });
  return harness.deliveryAdapter(input.provider).get(input.deliveryAttemptId);
}

for (const provider of PROVIDERS) {
  const appliedFixture = provider === 'claude'
    ? ' with a locally valid applied checkpoint seeded before cold startup'
    : '';
  test(`${provider} reclaims only terminal instruction bodies at the seven-day deadline${appliedFixture}`, async (t) => {
    const { harness, setNow } = await createHarness(t, provider);
    const { started } = await startWriter(harness, provider, 'terminal-matrix');
    const terminalStates = ['cancelled_before_send', 'superseded_before_send', 'applied'];
    for (const state of terminalStates) {
      const nativeWritesBefore = totalInstructionWrites(harness, provider);
      const { input, delivery } = state === 'applied' && provider === 'claude'
        ? await (async () => {
          const input = await createInstruction(harness, provider, started, state);
          const instruction = (await readJson(harness.pathFor('instructions'))).instructions.find((item) =>
            item.deliveryAttemptId === input.deliveryAttemptId);
          await restartWithDeliveryState(harness, { ...input, provider }, state, instruction.createdAt);
          return { input, delivery: await harness.deliveryAdapter(provider).get(input.deliveryAttemptId) };
        })()
        : await completeState(harness, provider, started, state, state);
      assert.equal(delivery.state, state);
      const deadline = delivery.terminalAt + RETENTION_MS;
      setNow(deadline - 1);
      const before = await readSlots(harness);
      const journalBefore = await readJson(harness.pathFor('instructions'));
      const checkpointBefore = await readJson(harness.pathFor('checkpoint'));
      const questionJournalBefore = await readJson(harness.pathFor('questions'));
      const early = await harness.reclamationService.reclaimInstructionBody({
        deliveryAttemptId: input.deliveryAttemptId,
      });
      assert.deepEqual(early, { status: 'deferred', deliveryAttemptId: input.deliveryAttemptId });
      assert.deepEqual(await readSlots(harness), before);

      setNow(deadline);
      const writesBefore = { ...harness.persistenceWriteCounts };
      const nativeWritesBeforeReclaim = totalInstructionWrites(harness, provider);
      const reclaimed = await harness.reclamationService.reclaimInstructionBody({
        deliveryAttemptId: input.deliveryAttemptId,
      });
      assert.deepEqual(reclaimed, { status: 'complete', deliveryAttemptId: input.deliveryAttemptId });
      const journal = await readJson(harness.pathFor('instructions'));
      const record = journal.instructions.find((item) => item.deliveryAttemptId === input.deliveryAttemptId);
      assert.equal(record.recordType, 'reclaimed');
      assert.equal(Object.hasOwn(record, 'envelope'), false);
      assert.equal(record.reclamation.terminalState, state);
      assert.equal(record.reclamation.terminalAt, delivery.terminalAt);
      assert.equal(record.reclaimedAt, deadline);
      const checkpoint = await readJson(harness.pathFor('checkpoint'));
      const grave = checkpoint.ledger.deliveries.find((item) => item.deliveryAttemptId === input.deliveryAttemptId);
      assert.equal(grave.recordType, 'reclaimed');
      assert.equal(grave.reclamation.operationId, record.reclamation.operationId);
      assert.equal(grave.state, state);
      assert.equal(checkpoint.ledger.deliveries.length, checkpointBefore.ledger.deliveries.length);
      assert.equal(journal.instructions.length, journalBefore.instructions.length);
      assert.deepEqual(checkpoint.registrations, checkpointBefore.registrations);
      assert.deepEqual(checkpoint.ledger.logicalTombstones, checkpointBefore.ledger.logicalTombstones);
      assert.deepEqual(checkpoint.migrationAllowance, checkpointBefore.migrationAllowance);
      assert.deepEqual(journal.migrationAllowance, journalBefore.migrationAllowance);
      assert.deepEqual((await readJson(harness.pathFor('questions'))).migrationAllowance,
        questionJournalBefore.migrationAllowance);
      for (const previous of checkpointBefore.ledger.deliveries.filter((item) =>
        item.deliveryAttemptId !== input.deliveryAttemptId)) {
        assert.deepEqual(checkpoint.ledger.deliveries.find((item) => item.deliveryAttemptId === previous.deliveryAttemptId),
          previous);
      }
      for (const previous of journalBefore.instructions.filter((item) =>
        item.deliveryAttemptId !== input.deliveryAttemptId)) {
        assert.deepEqual(journal.instructions.find((item) => item.deliveryAttemptId === previous.deliveryAttemptId),
          previous);
      }
      assert.equal(harness.persistenceWriteCounts.instructions, writesBefore.instructions + 2);
      assert.equal(totalInstructionWrites(harness, provider), nativeWritesBeforeReclaim);
      assert.equal(totalInstructionWrites(harness, provider) - nativeWritesBefore,
        provider === 'codex' && state === 'applied' ? 1 : 0);
      if (provider === 'claude' && state === 'applied') {
        const listener = harness.serviceAcceptedListener(provider);
        assert.equal(typeof listener, 'function');
        const beforeLateAcceptance = await readSlots(harness);
        const writesBeforeLateAcceptance = { ...harness.persistenceWriteCounts };
        await assert.rejects(listener(input.deliveryAttemptId, null, {
          clientRequestId: grave.appliedCorrelation.clientRequestId,
          nativeTurnId: grave.appliedCorrelation.nativeTurnId,
          nativeItemId: null,
        }), { code: 'instruction_acceptance_source_unavailable' });
        assert.deepEqual(await readSlots(harness), beforeLateAcceptance);
        assert.deepEqual(harness.persistenceWriteCounts, writesBeforeLateAcceptance);
      }
      await assert.rejects(harness.instructionService.send(input.deliveryAttemptId));
      await assert.rejects(harness.instructionService.create(input));
      assert.equal(await harness.instructionService.get(input.deliveryAttemptId), null);
      const retainedEnvelope = journalBefore.instructions.find((item) =>
        item.deliveryAttemptId === input.deliveryAttemptId).envelope;
      await assert.rejects(harness.deliveryAdapter(provider).rehydratePayload(input.deliveryAttemptId, retainedEnvelope));
    }
    if (provider === 'claude') assert.equal(totalInstructionWrites(harness, provider), 0);
  });
}

for (const provider of PROVIDERS) {
  test(`${provider} trusted provider adapter persists a compatible accepted completion for an applied grave`, async (t) => {
    const { harness, setNow } = await createHarness(t, provider);
    const { started } = await startWriter(harness, provider, 'applied-grave-accepted');
    let input;
    let delivery;
    if (provider === 'claude') {
      input = await createInstruction(harness, provider, started, 'applied-grave-accepted');
      const instruction = (await readJson(harness.pathFor('instructions'))).instructions.find((item) =>
        item.deliveryAttemptId === input.deliveryAttemptId);
      delivery = await restartWithDeliveryState(harness, { ...input, provider }, 'applied', instruction.createdAt);
    } else {
      ({ input, delivery } = await completeState(harness, provider, started, 'applied', 'applied-grave-accepted'));
    }

    setNow(delivery.terminalAt + RETENTION_MS);
    assert.deepEqual(await harness.reclamationService.reclaimInstructionBody({
      deliveryAttemptId: input.deliveryAttemptId,
    }), { status: 'complete', deliveryAttemptId: input.deliveryAttemptId });

    const checkpointBefore = await readJson(harness.pathFor('checkpoint'));
    const graveBefore = checkpointBefore.ledger.deliveries.find((item) =>
      item.deliveryAttemptId === input.deliveryAttemptId);
    assert.equal(graveBefore.recordType, 'reclaimed');
    assert.equal(graveBefore.state, 'applied');
    assert.ok(graveBefore.appliedCorrelation);
    const before = await readSlots(harness);
    const writesBefore = { ...harness.persistenceWriteCounts };
    const nativeWritesBefore = totalInstructionWrites(harness, provider);
    const adapter = harness.deliveryAdapter(provider);

    const accepted = await adapter.recordAccepted(input.deliveryAttemptId, graveBefore.appliedCorrelation);
    assert.equal(accepted.recordType, 'reclaimed');
    assert.deepEqual({ ...accepted.acceptedCorrelation }, graveBefore.appliedCorrelation);
    const checkpointAfterAccepted = await readJson(harness.pathFor('checkpoint'));
    const graveAfterAccepted = checkpointAfterAccepted.ledger.deliveries.find((item) =>
      item.deliveryAttemptId === input.deliveryAttemptId);
    const withoutAcceptedCorrelation = (record) => {
      const copy = structuredClone(record);
      delete copy.acceptedCorrelation;
      return copy;
    };
    assert.deepEqual(withoutAcceptedCorrelation(graveAfterAccepted), withoutAcceptedCorrelation(graveBefore));
    assert.equal(checkpointAfterAccepted.revision, checkpointBefore.revision + 1);
    assert.equal(checkpointAfterAccepted.ledger.revision, checkpointBefore.ledger.revision + 1);
    assert.deepEqual(checkpointAfterAccepted.registrations, checkpointBefore.registrations);
    assert.deepEqual(checkpointAfterAccepted.ledger.logicalTombstones, checkpointBefore.ledger.logicalTombstones);
    assert.deepEqual(checkpointAfterAccepted.migrationAllowance, checkpointBefore.migrationAllowance);
    assert.deepEqual(checkpointAfterAccepted.ledger.deliveries.filter((item) =>
      item.deliveryAttemptId !== input.deliveryAttemptId), checkpointBefore.ledger.deliveries.filter((item) =>
      item.deliveryAttemptId !== input.deliveryAttemptId));
    assert.equal(harness.persistenceWriteCounts.checkpoint, writesBefore.checkpoint + 1);
    for (const slot of ['anchor', 'instructions', 'questions']) {
      assert.deepEqual(await fs.readFile(harness.pathFor(slot)), before[slot]);
    }
    assert.equal(totalInstructionWrites(harness, provider), nativeWritesBefore);

    const afterAccepted = await fs.readFile(harness.pathFor('checkpoint'));
    const writesAfterAccepted = { ...harness.persistenceWriteCounts };
    await adapter.recordAccepted(input.deliveryAttemptId, graveBefore.appliedCorrelation);
    assert.deepEqual(await fs.readFile(harness.pathFor('checkpoint')), afterAccepted);
    assert.deepEqual(harness.persistenceWriteCounts, writesAfterAccepted);

    await adapter.recordApplied(input.deliveryAttemptId, graveBefore.appliedCorrelation);
    assert.deepEqual(await fs.readFile(harness.pathFor('checkpoint')), afterAccepted);
    assert.deepEqual(harness.persistenceWriteCounts, writesAfterAccepted);

    await assert.rejects(adapter.recordAccepted(input.deliveryAttemptId, {
      ...graveBefore.appliedCorrelation,
      nativeTurnId: 'replacement-native-turn',
    }));
    assert.deepEqual(await fs.readFile(harness.pathFor('checkpoint')), afterAccepted);
    assert.deepEqual(harness.persistenceWriteCounts, writesAfterAccepted);
    assert.equal(totalInstructionWrites(harness, provider), nativeWritesBefore);
  });
}

async function waitUntil(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  assert.fail('condition did not become true before timeout');
}

test('Codex rejects a late accepted transition after native evidence cleanup', async (t) => {
  const { harness } = await createHarness(t, 'codex', { instructionEvidence: 'full' });
  const { started } = await startWriter(harness, 'codex', 'late-accepted-after-cleanup');
  const { input, delivery } = await completeState(harness, 'codex', started, 'applied', 'late-accepted');
  const instructionAdapter = harness.instructionAdapter('codex');
  const sourceToken = harness.sourceToken(input.deliveryAttemptId);
  assert.ok(sourceToken);
  assert.equal(instructionAdapter.hasInstructionObservation(input.deliveryAttemptId, sourceToken), false);

  const before = await readSlots(harness);
  const writesBefore = { ...harness.persistenceWriteCounts };
  const nativeWritesBefore = totalInstructionWrites(harness, 'codex');
  await assert.rejects(harness.deliveryAdapter('codex').recordAcceptedInstructionGuarded(
    input.deliveryAttemptId,
    delivery.appliedCorrelation,
    () => instructionAdapter.hasInstructionObservation(input.deliveryAttemptId, sourceToken),
  ), { code: 'instruction_acceptance_source_unavailable' });
  assert.deepEqual(await readSlots(harness), before);
  assert.deepEqual(harness.persistenceWriteCounts, writesBefore);
  assert.equal(totalInstructionWrites(harness, 'codex'), nativeWritesBefore);
  assert.equal(harness.reclamationContext.canWrite(), true);
});

test('Codex rechecks an accepted witness after a shared persistence queue wait', async (t) => {
  const { harness } = await createHarness(t, 'codex', { instructionEvidence: 'full' });
  const { started } = await startWriter(harness, 'codex', 'late-accepted-witness-queue');
  const { input, delivery } = await completeState(harness, 'codex', started, 'applied', 'witness-queue');
  const instructionsBackend = harness.reclamationContext.backend('instructions');
  const instructions = await instructionsBackend.load();
  const noContentChange = structuredClone(instructions);
  noContentChange.revision += 1;
  const barrier = harness.faults.holdNextWrite('instructions');
  const blocker = instructionsBackend.save(noContentChange);
  await barrier.entered;

  const checkpointBytesBefore = await fs.readFile(harness.pathFor('checkpoint'));
  const checkpointWritesBefore = harness.persistenceWriteCounts.checkpoint;
  let witnessActive = true;
  let witnessCalls = 0;
  const accepted = harness.deliveryAdapter('codex').recordAcceptedInstructionGuarded(
    input.deliveryAttemptId,
    delivery.appliedCorrelation,
    () => {
      witnessCalls += 1;
      return witnessActive;
    },
  );
  try {
    await waitUntil(() => witnessCalls >= 1);
    witnessActive = false;
  } finally {
    barrier.release();
  }
  await blocker;
  await assert.rejects(accepted, { code: 'instruction_acceptance_source_unavailable' });
  assert.ok(witnessCalls >= 2);
  assert.deepEqual(await fs.readFile(harness.pathFor('checkpoint')), checkpointBytesBefore);
  assert.equal(harness.persistenceWriteCounts.checkpoint, checkpointWritesBefore);
  assert.equal(harness.reclamationContext.canWrite(), true);
});

test('Codex registered service accepted listener writes a late applied grave only with its live observation', async (t) => {
  const { harness, input, acceptedEvent, sourceToken, hold, appliedCorrelation } =
    await prepareServiceAcceptedGrave(t, 'service-terminal-evidence');
  const listener = harness.serviceAcceptedListener('codex');
  assert.equal(typeof listener, 'function');
  const before = await readSlots(harness);
  const checkpointBefore = await readJson(harness.pathFor('checkpoint'));
  const graveBefore = checkpointBefore.ledger.deliveries.find((item) =>
    item.deliveryAttemptId === input.deliveryAttemptId);
  const writesBefore = { ...harness.persistenceWriteCounts };
  const wrongTokenResult = listener(input.deliveryAttemptId, null, acceptedEvent.accepted);
  await assert.rejects(wrongTokenResult, { code: 'instruction_acceptance_source_unavailable' });
  assert.deepEqual(await readSlots(harness), before);
  assert.deepEqual(harness.persistenceWriteCounts, writesBefore);

  assert.equal(await hold.release(), true);
  await new Promise((resolve) => setImmediate(resolve));
  const checkpoint = await readJson(harness.pathFor('checkpoint'));
  const grave = checkpoint.ledger.deliveries.find((item) => item.deliveryAttemptId === input.deliveryAttemptId);
  assert.deepEqual(grave.acceptedCorrelation, {
    deliveryAttemptId: appliedCorrelation.deliveryAttemptId,
    revision: appliedCorrelation.revision,
    payloadDigest: appliedCorrelation.payloadDigest,
    targetPeriodId: appliedCorrelation.targetPeriodId,
    nativeTurnId: acceptedEvent.accepted.nativeTurnId,
    nativeItemId: null,
    clientRequestId: acceptedEvent.accepted.clientRequestId,
  });
  assert.equal(grave.recordType, 'reclaimed');
  assert.equal(grave.state, 'applied');
  const withoutAcceptedCorrelation = (record) => {
    const copy = structuredClone(record);
    delete copy.acceptedCorrelation;
    return copy;
  };
  assert.deepEqual(withoutAcceptedCorrelation(grave), withoutAcceptedCorrelation(graveBefore));
  assert.deepEqual(checkpoint.registrations, checkpointBefore.registrations);
  assert.deepEqual(checkpoint.ledger.logicalTombstones, checkpointBefore.ledger.logicalTombstones);
  assert.deepEqual(checkpoint.migrationAllowance, checkpointBefore.migrationAllowance);
  assert.deepEqual(checkpoint.ledger.deliveries.filter((item) =>
    item.deliveryAttemptId !== input.deliveryAttemptId), checkpointBefore.ledger.deliveries.filter((item) =>
    item.deliveryAttemptId !== input.deliveryAttemptId));
  assert.equal(harness.persistenceWriteCounts.checkpoint, writesBefore.checkpoint + 1);
  assert.deepEqual(harness.persistenceWriteCounts.instructions, writesBefore.instructions);
  assert.deepEqual(harness.persistenceWriteCounts.questions, writesBefore.questions);
  for (const slot of ['anchor', 'instructions', 'questions']) {
    assert.deepEqual(await fs.readFile(harness.pathFor(slot)), before[slot]);
  }
  const afterAcceptedSlots = await readSlots(harness);
  const afterAccepted = afterAcceptedSlots.checkpoint;
  const writesAfterAccepted = { ...harness.persistenceWriteCounts };

  assert.equal(await listener(input.deliveryAttemptId, sourceToken, acceptedEvent.accepted), true);
  assert.deepEqual(await fs.readFile(harness.pathFor('checkpoint')), afterAccepted);
  assert.deepEqual(harness.persistenceWriteCounts, writesAfterAccepted);

  assert.equal(harness.instructionAdapter('codex').closeInstructionObservation(
    input.deliveryAttemptId, sourceToken), true);
  await assert.rejects(listener(input.deliveryAttemptId, sourceToken, acceptedEvent.accepted),
    { code: 'instruction_acceptance_source_unavailable' });
  assert.deepEqual(await fs.readFile(harness.pathFor('checkpoint')), afterAccepted);
  assert.deepEqual(harness.persistenceWriteCounts, writesAfterAccepted);

  await harness.instructionService.close();
  assert.deepEqual(await readSlots(harness), afterAcceptedSlots);
  await assert.rejects(listener(input.deliveryAttemptId, sourceToken, acceptedEvent.accepted),
    { code: 'instruction_service_closed' });
  assert.deepEqual(await fs.readFile(harness.pathFor('checkpoint')), afterAccepted);
  assert.deepEqual(harness.persistenceWriteCounts, writesAfterAccepted);
});

test('Codex registered service accepted listener rechecks observation after a queued checkpoint save', async (t) => {
  const { harness, input, acceptedEvent, sourceToken, hold } =
    await prepareServiceAcceptedGrave(t, 'service-terminal-evidence-queue');
  const instructionsBackend = harness.reclamationContext.backend('instructions');
  const instructions = await instructionsBackend.load();
  const blockerSnapshot = structuredClone(instructions);
  blockerSnapshot.revision += 1;
  const barrier = harness.faults.holdNextWrite('instructions');
  const blocker = instructionsBackend.save(blockerSnapshot);
  await barrier.entered;

  const checkpointSaveCount = harness.backendSaveCount('checkpoint');
  const checkpointBytesBefore = await fs.readFile(harness.pathFor('checkpoint'));
  const checkpointWritesBefore = harness.persistenceWriteCounts.checkpoint;
  const queuedAccepted = hold.release();
  await waitUntil(() => harness.backendSaveCount('checkpoint') > checkpointSaveCount);
  assert.equal(harness.instructionAdapter('codex').hasInstructionObservation(
    input.deliveryAttemptId, sourceToken), true);
  assert.equal(harness.instructionAdapter('codex').closeInstructionObservation(
    input.deliveryAttemptId, sourceToken), true);
  barrier.release();
  await blocker;
  await assert.rejects(queuedAccepted, { code: 'instruction_acceptance_source_unavailable' });
  await harness.instructionService.flush();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(await fs.readFile(harness.pathFor('checkpoint')), checkpointBytesBefore);
  assert.equal(harness.persistenceWriteCounts.checkpoint, checkpointWritesBefore);
  assert.equal((await harness.deliveryAdapter('codex').get(input.deliveryAttemptId)).acceptedCorrelation, null);
});

for (const provider of PROVIDERS) {
  const boundaries = [
    { name: 'journal prepare', slot: 'instructions', occurrence: 1 },
    { name: 'checkpoint grave', slot: 'checkpoint', occurrence: 1 },
    { name: 'journal body deletion', slot: 'instructions', occurrence: 2 },
  ];
  for (const boundary of boundaries) {
    for (const phase of ['before-write', 'after-write', 'readback']) {
      test(`${provider} resumes the persisted operation after ${boundary.name} ${phase}`, async (t) => {
        const { harness, setNow } = await createHarness(t, provider);
        const { started } = await startWriter(harness, provider, `${boundary.slot}-${phase}`);
        const state = provider === 'codex' ? 'applied' : 'cancelled_before_send';
        const { input, delivery } = await completeState(harness, provider, started, state,
          `${boundary.slot}-${phase}`);
        setNow(delivery.terminalAt + RETENTION_MS);
        const beforeWrites = { ...harness.persistenceWriteCounts };
        harness.faults.arm({ slot: boundary.slot, phase, occurrence: boundary.occurrence });

        await assert.rejects(harness.reclamationService.reclaimInstructionBody({
          deliveryAttemptId: input.deliveryAttemptId,
        }), (error) => Boolean(error?.code));
        const interruptedJournal = await readJson(harness.pathFor('instructions'));
        const interruptedRecord = interruptedJournal.instructions.find((item) =>
          item.deliveryAttemptId === input.deliveryAttemptId);
        const operationId = interruptedRecord.recordType === 'reclaimed'
          ? interruptedRecord.reclamation.operationId
          : interruptedRecord.reclamation?.operationId ?? null;
        if (boundary.name === 'journal prepare' && phase === 'before-write') assert.equal(operationId, null);
        else assert.match(operationId, /^[0-9a-f-]{36}$/);

        const writesBeforeRestart = { ...harness.persistenceWriteCounts };
        const nativeWritesBeforeRestart = totalInstructionWrites(harness, provider);
        await harness.restart();
        assert.equal(totalInstructionWrites(harness, provider), nativeWritesBeforeRestart);
        if (operationId === null) {
          const notPrepared = await readJson(harness.pathFor('instructions'));
          assert.equal(notPrepared.instructions.find((item) =>
            item.deliveryAttemptId === input.deliveryAttemptId).recordType, 'detail');
          assert.deepEqual(harness.persistenceWriteCounts, writesBeforeRestart);
          const explicit = await harness.reclamationService.reclaimInstructionBody({
            deliveryAttemptId: input.deliveryAttemptId,
          });
          assert.equal(explicit.status, 'complete');
        }
        const completedJournal = await readJson(harness.pathFor('instructions'));
        const completedRecord = completedJournal.instructions.find((item) =>
          item.deliveryAttemptId === input.deliveryAttemptId);
        const completedCheckpoint = await readJson(harness.pathFor('checkpoint'));
        const grave = completedCheckpoint.ledger.deliveries.find((item) =>
          item.deliveryAttemptId === input.deliveryAttemptId);
        assert.equal(completedRecord.recordType, 'reclaimed');
        assert.equal(grave.recordType, 'reclaimed');
        if (operationId !== null) assert.equal(completedRecord.reclamation.operationId, operationId);
        assert.equal(grave.reclamation.operationId, completedRecord.reclamation.operationId);
        assert.equal(harness.persistenceWriteCounts.instructions >= writesBeforeRestart.instructions, true);
        assert.equal(harness.persistenceWriteCounts.checkpoint >= writesBeforeRestart.checkpoint, true);
        assert.deepEqual(harness.persistenceWriteCounts.anchor, beforeWrites.anchor);
        const afterCompleteWrites = { ...harness.persistenceWriteCounts };
        assert.deepEqual(await harness.reclamationService.reclaimInstructionBody({
          deliveryAttemptId: input.deliveryAttemptId,
        }), { status: 'complete', deliveryAttemptId: input.deliveryAttemptId });
        assert.deepEqual(harness.persistenceWriteCounts, afterCompleteWrites);
      });
    }
  }
}

for (const provider of PROVIDERS) {
  test(`${provider} defers cold persisted available, claimed, sending, accepted, and unknown instructions`, async (t) => {
    const { harness, setNow } = await createHarness(t, provider);
    for (const state of ['available', 'claimed', 'sending', 'accepted', 'unknown']) {
      const { started } = await startWriter(harness, provider, `nonterminal-${state}`);
      const created = await createInstruction(harness, provider, started, state);
      const input = { ...created, provider };
      await restartWithDeliveryState(harness, input, state);
      const current = await harness.deliveryAdapter(provider).get(input.deliveryAttemptId);
      const expectedState = ['sending', 'accepted'].includes(state) ? 'unknown' : state;
      assert.equal(current.state, expectedState);

      setNow(2_000_000_000);
      const before = await readSlots(harness);
      const writesBefore = { ...harness.persistenceWriteCounts };
      const result = await harness.reclamationService.reclaimInstructionBody({
        deliveryAttemptId: input.deliveryAttemptId,
      });
      assert.deepEqual(result, { status: 'deferred', deliveryAttemptId: input.deliveryAttemptId });
      assert.deepEqual(await readSlots(harness), before);
      assert.deepEqual(harness.persistenceWriteCounts, writesBefore);
      assert.equal(harness.reclamationContext.canWrite(), true);
    }

    const missing = await readSlots(harness);
    await assert.rejects(harness.reclamationService.reclaimInstructionBody({
      deliveryAttemptId: 'missing-instruction-id',
    }), { code: 'instruction_not_found' });
    assert.deepEqual(await readSlots(harness), missing);
    assert.equal(harness.reclamationContext.canWrite(), true);

    let access;
    const scoped = `instruction-${provider}-nonterminal-available`;
    await harness.instructionService.withInstructionBody({ deliveryAttemptId: scoped }, (value) => {
      access = value;
    });
    assert.throws(() => access.snapshot(), { code: 'instruction_body_access_expired' });
    assert.equal(harness.reclamationContext.canWrite(), true);
  });
}

for (const provider of PROVIDERS) {
  test(`${provider} waits for an in-flight first boundary on close and resumes its operation after restart`, async (t) => {
    const { harness, setNow } = await createHarness(t, provider);
    const { started } = await startWriter(harness, provider, 'close-during-boundary');
    const state = provider === 'codex' ? 'applied' : 'cancelled_before_send';
    const { input, delivery } = await completeState(harness, provider, started, state, 'close-during-boundary');
    const deadline = delivery.terminalAt + RETENTION_MS;
    setNow(deadline);
    const before = await readSlots(harness);
    const writesBefore = { ...harness.persistenceWriteCounts };
    const barrier = harness.faults.holdNextWrite('instructions');
    const reclaiming = harness.reclamationService.reclaimInstructionBody({
      deliveryAttemptId: input.deliveryAttemptId,
    });
    await barrier.entered;
    const closing = harness.closeCurrent();
    barrier.release();
    await assert.rejects(reclaiming, (error) => Boolean(error?.code));
    await closing;

    const journalAfterClose = await readJson(harness.pathFor('instructions'));
    const prepared = journalAfterClose.instructions.find((item) => item.deliveryAttemptId === input.deliveryAttemptId);
    assert.ok(prepared.reclamation);
    assert.equal(prepared.recordType, 'detail');
    assert.equal(harness.persistenceWriteCounts.instructions, writesBefore.instructions + 1);
    assert.equal(harness.persistenceWriteCounts.checkpoint, writesBefore.checkpoint);
    assert.deepEqual(await fs.readFile(harness.pathFor('checkpoint')), before.checkpoint);
    const operationId = prepared.reclamation.operationId;

    await harness.restart();
    const completed = await readJson(harness.pathFor('instructions'));
    const reclaimed = completed.instructions.find((item) => item.deliveryAttemptId === input.deliveryAttemptId);
    assert.equal(reclaimed.recordType, 'reclaimed');
    assert.equal(reclaimed.reclamation.operationId, operationId);
    assert.equal(totalInstructionWrites(harness, provider), state === 'applied' ? 1 : 0);
  });
}

for (const provider of PROVIDERS) {
  test(`${provider} preserves a prepared operation while a cold restart observes clock rollback`, async (t) => {
    const { harness, setNow } = await createHarness(t, provider);
    const { started } = await startWriter(harness, provider, 'prepared-clock-rollback');
    const state = provider === 'codex' ? 'applied' : 'cancelled_before_send';
    const { input, delivery } = await completeState(harness, provider, started, state, 'prepared-clock-rollback');
    const deadline = delivery.terminalAt + RETENTION_MS;
    setNow(deadline);
    harness.faults.arm({ slot: 'instructions', phase: 'after-write' });
    await assert.rejects(harness.reclamationService.reclaimInstructionBody({
      deliveryAttemptId: input.deliveryAttemptId,
    }), /fixture/);
    const prepared = (await readJson(harness.pathFor('instructions'))).instructions.find((item) =>
      item.deliveryAttemptId === input.deliveryAttemptId);
    const operationId = prepared.reclamation.operationId;
    const beforeRestart = await readSlots(harness);
    const writesBeforeRestart = { ...harness.persistenceWriteCounts };
    setNow(prepared.reclamation.preparedAt - 1);
    await harness.restart();
    assert.deepEqual(await readSlots(harness), beforeRestart);
    assert.deepEqual(harness.persistenceWriteCounts, writesBeforeRestart);
    assert.equal(harness.reclamationContext.canWrite(), true);
    assert.equal(await harness.instructionService.get(input.deliveryAttemptId), null);
    const checkpoint = await readJson(harness.pathFor('checkpoint'));
    assert.equal(checkpoint.ledger.deliveries.find((item) => item.deliveryAttemptId ===
      input.deliveryAttemptId).state, state);
    const journalAfterRestart = await readJson(harness.pathFor('instructions'));
    assert.equal(journalAfterRestart.instructions.find((item) => item.deliveryAttemptId ===
      input.deliveryAttemptId).reclamation.operationId, operationId);

    setNow(prepared.reclamation.preparedAt);
    const result = await harness.reclamationService.reclaimInstructionBody({
      deliveryAttemptId: input.deliveryAttemptId,
    });
    assert.equal(result.status, 'complete');
    const completed = (await readJson(harness.pathFor('instructions'))).instructions.find((item) =>
      item.deliveryAttemptId === input.deliveryAttemptId);
    assert.equal(completed.reclamation.operationId, operationId);
    assert.equal(totalInstructionWrites(harness, provider), state === 'applied' ? 1 : 0);
  });
}

for (const provider of PROVIDERS) {
  test(`${provider} rejects exact-binding and cross-store mismatch during cold startup without rewriting files`, async (t) => {
    const { harness, setNow } = await createHarness(t, provider);
    const { started } = await startWriter(harness, provider, 'cold-cross-store-mismatch');
    const { input, delivery } = await completeState(harness, provider, started, 'cancelled_before_send', 'cold-mismatch');
    await finishReclamation(harness, input, setNow, delivery);
    const originalCheckpointBytes = await fs.readFile(harness.pathFor('checkpoint'));
    const checkpoint = JSON.parse(originalCheckpointBytes.toString('utf8'));
    const grave = checkpoint.ledger.deliveries.find((item) => item.deliveryAttemptId === input.deliveryAttemptId);
    const alteredDigest = grave.payloadDigest === '0'.repeat(64) ? '1'.repeat(64) : '0'.repeat(64);
    grave.payloadDigest = alteredDigest;
    for (const name of ['acceptedCorrelation', 'appliedCorrelation']) {
      if (grave[name] !== null) grave[name].payloadDigest = alteredDigest;
    }
    const tombstone = checkpoint.ledger.logicalTombstones.find((item) =>
      item.kind === grave.kind && item.sourceExecutionId === grave.sourceExecutionId &&
      item.logicalMessageId === grave.logicalMessageId && item.revision === grave.revision);
    assert.ok(tombstone);
    tombstone.payloadDigest = alteredDigest;
    const locallyEncoded = encodeCheckpointV3Local(checkpoint);
    assert.equal(JSON.parse(locallyEncoded.bytes.toString('utf8')).ledger.deliveries
      .find((item) => item.deliveryAttemptId === input.deliveryAttemptId).payloadDigest, alteredDigest);
    let beforeStartup;
    const writesBeforeStartup = { ...harness.persistenceWriteCounts };
    await assert.rejects(harness.restart(async () => {
      await fs.writeFile(harness.pathFor('checkpoint'), locallyEncoded.bytes);
      beforeStartup = await readSlots(harness);
    }), (error) => Boolean(error?.code));
    assert.deepEqual(await readSlots(harness), beforeStartup);
    assert.deepEqual(harness.persistenceWriteCounts, writesBeforeStartup);
    assert.equal(harness.processesByProvider.get(provider).length, 1);
  });
}

for (const provider of PROVIDERS) {
  test(`${provider} captures strict facade input and rejects unsafe clock rollback without storage writes`, async (t) => {
    const { harness, setNow } = await createHarness(t, provider);
    const { started } = await startWriter(harness, provider, 'strict-facade');
    const { input, delivery } = await completeState(harness, provider, started, 'cancelled_before_send', 'strict-facade');
    const original = await readSlots(harness);
    assert.throws(() => harness.reclamationService.reclaimInstructionBody({
      deliveryAttemptId: input.deliveryAttemptId, extra: true,
    }), { code: 'invalid_instruction_body_reclamation' });
    let getterCount = 0;
    const malicious = {};
    Object.defineProperty(malicious, 'deliveryAttemptId', {
      enumerable: true,
      get() { getterCount += 1; return input.deliveryAttemptId; },
    });
    assert.throws(() => harness.reclamationService.reclaimInstructionBody(malicious),
      { code: 'invalid_instruction_body_reclamation' });
    assert.equal(getterCount, 0);
    assert.deepEqual(await readSlots(harness), original);
    assert.equal(harness.reclamationContext.canWrite(), true);

    const deadline = delivery.terminalAt + RETENTION_MS;
    setNow(deadline + 10);
    const first = await harness.reclamationService.reclaimInstructionBody({ deliveryAttemptId: input.deliveryAttemptId });
    assert.equal(first.status, 'complete');
    const persisted = await readJson(harness.pathFor('instructions'));
    const record = persisted.instructions.find((item) => item.deliveryAttemptId === input.deliveryAttemptId);
    const completedBytes = await readSlots(harness);
    setNow(deadline);
    const rollback = await harness.reclamationService.reclaimInstructionBody({ deliveryAttemptId: input.deliveryAttemptId });
    assert.equal(rollback.status, 'complete');
    assert.deepEqual(await readSlots(harness), completedBytes);
    assert.equal(record.reclaimedAt, deadline + 10);
  });
}
