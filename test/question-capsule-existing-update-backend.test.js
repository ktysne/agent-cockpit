'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { selectionFor } = require('../src/server/common-question-kernel');
const { encodeCapsuleCheckpointV4Local } = require('../src/server/question-capsule-checkpoint-codec');
const { encodeQuestionCapsuleJournalV3Local } = require('../src/server/question-capsule-journal-codec');
const { encodeQuestionReclamationAnchorV1Local } = require('../src/server/question-reclamation-anchor-codec');
const { encodeInstructionJournalV2Local } = require('../src/server/delivery-reclamation-codec');
const {
  measureCheckpointCapsuleExistingUpdateReservation,
  measureQuestionCapsuleExistingUpdateReservation,
} = require('../src/server/question-capsule-existing-update-capacity');
const {
  measureCheckpointReservation,
  measureInstructionReservation,
  measurePendingQuestionPeriodCapacity,
  measureQuestionJournalReservationBytes,
} = require('../src/server/reclamation-capacity-bounds');
const { measureReclamationStoreCapacity } = require('../src/server/reclamation-capacity-reservation');
const { validateQuestionCapsuleFiles } = require('../src/server/question-capsule-files-validation');
const {
  createQuestionCapsuleExistingUpdateFixture,
  createQuestionCapsuleExistingUpdateWorkspace,
} =
  require('./helpers/question-capsule-existing-update-workspace');

const BLOCKED = 'question_capsule_existing_update_backend_blocked';
const CLOSED = 'question_capsule_existing_update_backend_closed';
const STALE = 'stale_question_capsule_existing_update_head';
const INVALID = 'invalid_question_capsule_existing_update_backend';
const CAPACITY_EXCEEDED = 'reclamation_capacity_exceeded';
const CAPSULES = Object.freeze({ questions: 'questionCapsules', checkpoint: 'checkpointCapsules' });
const ORDERS = Object.freeze({ questions: 'reservationOrder', checkpoint: 'deliveryAttemptOrder' });

async function trackWorkspace(t, options) {
  const workspace = await createQuestionCapsuleExistingUpdateWorkspace(options);
  t.after(async () => {
    await workspace.cleanupInjectedOrphan();
    await workspace.dispose();
  });
  return workspace;
}

function questionCandidate(current) {
  const questionFile = structuredClone(current.questionFile);
  const question = questionFile.questions.find((row) => row.selection !== null);
  assert.ok(question);
  const legacyQuestion = { ...question };
  delete legacyQuestion.deliveryCreationState;
  delete legacyQuestion.quarantinedAt;
  const laterSelection = selectionFor(legacyQuestion, [{
    questionId: question.questions[0].id,
    optionIds: [],
    freeText: 'later response',
  }], 'manual', question.createdAt + 1, 'late-answer-backend-fixture');
  question.lateAnswers = structuredClone(laterSelection.record.lateAnswers);
  questionFile.revision += 1;
  return questionFile;
}

function checkpointCandidate(current) {
  const checkpointFile = structuredClone(current.checkpointFile);
  const delivery = checkpointFile.ledger.deliveries.find((row) => row.kind === 'instruction');
  assert.ok(delivery);
  delivery.state = 'accepted';
  delivery.acceptedCorrelation = {
    deliveryAttemptId: delivery.deliveryAttemptId,
    revision: delivery.revision,
    payloadDigest: delivery.payloadDigest,
    targetPeriodId: delivery.target.periodId,
    nativeTurnId: 'native-turn-backend-fixture',
    nativeItemId: null,
    clientRequestId: delivery.deliveryAttemptId,
  };
  checkpointFile.ledger.revision += 1;
  checkpointFile.revision += 1;
  return checkpointFile;
}

function questionRevisionCandidate(current) {
  const questionFile = structuredClone(current);
  questionFile.revision += 1;
  return questionFile;
}

function encodedFixtureBytes(input) {
  return {
    anchor: Buffer.from(encodeQuestionReclamationAnchorV1Local(input.anchor).bytes),
    questions: Buffer.from(encodeQuestionCapsuleJournalV3Local(input.questionFile).bytes),
    checkpoint: input.checkpointFile === null
      ? null : Buffer.from(encodeCapsuleCheckpointV4Local(input.checkpointFile).bytes),
    instructions: input.instructionStore === null
      ? null : Buffer.from(encodeInstructionJournalV2Local(input.instructionStore).bytes),
  };
}

function capacityInput(snapshot, raw, limits) {
  const configuredSlots = ['questions', 'checkpoint', 'instructions'].filter((slot) =>
    snapshot.stores[slot] !== null);
  return {
    anchor: snapshot.anchor,
    stores: snapshot.stores,
    normalByteLimitsBySlot: Object.fromEntries(configuredSlots.map((slot) => [slot, limits[slot]])),
    rawSizeBytesBySlot: Object.fromEntries(configuredSlots.map((slot) => [slot, raw[slot].length])),
    rawAnchorSizeBytes: raw.anchor.length,
  };
}

function baselineLeaseForFixture(fixture, raw) {
  const snapshot = validateQuestionCapsuleFiles(fixture.input).snapshot;
  const capacity = measureReclamationStoreCapacity(capacityInput(
    snapshot, raw, fixture.input.normalByteLimitsBySlot));
  return capacity.anchor.reserveBytes + Object.keys(capacity.slots).reduce((total, slot) =>
    total + Math.max(raw[slot].length, capacity.slots[slot].reserveBytes), 0);
}

function independentlyMeasuredProtectedAmounts(snapshot, files, raw, limits) {
  const legacy = measureReclamationStoreCapacity(capacityInput(snapshot, raw, limits));
  const activePeriods = (snapshot.stores.questions?.reservations ?? []).map(({ identity, periodId }) => ({
    identity,
    periodId,
  }));
  const pendingAnchor = measurePendingQuestionPeriodCapacity(snapshot.anchor, activePeriods);
  const result = {
    anchor: Math.max(
      raw.anchor.length,
      encodeQuestionReclamationAnchorV1Local(snapshot.anchor).sizeBytes,
      pendingAnchor.projectedBytes,
      legacy.anchor.reserveBytes,
    ),
    questions: 0,
    checkpoint: 0,
    instructions: 0,
  };
  let instructionRequiredBytes = 0;
  let instructionGrantBytes = 0;

  for (const slot of ['questions', 'checkpoint']) {
    const file = files[slot === 'questions' ? 'questionFile' : 'checkpointFile'];
    if (file === null) continue;
    const currentByteLimit = limits[slot];
    const outer = slot === 'questions'
      ? measureQuestionCapsuleExistingUpdateReservation({ questionFile: file, currentByteLimit })
      : measureCheckpointCapsuleExistingUpdateReservation({ checkpointFile: file, currentByteLimit });
    const oldFuture = slot === 'questions'
      ? measureQuestionJournalReservationBytes({ snapshot: snapshot.stores.questions, currentByteLimit })
      : measureCheckpointReservation({ snapshot: snapshot.stores.checkpoint, currentByteLimit });
    result[slot] = Math.max(
      raw[slot].length,
      outer.currentBytes,
      outer.reservedBytes,
      oldFuture.reservedBytes,
      legacy.slots[slot].reserveBytes,
    );
  }

  const instructionStore = snapshot.stores.instructions;
  if (instructionStore !== null) {
    const currentByteLimit = limits.instructions;
    const oldFuture = measureInstructionReservation({ snapshot: instructionStore, currentByteLimit });
    instructionGrantBytes = instructionStore.migrationAllowance?.maxExtraBytes ?? 0;
    instructionRequiredBytes = Math.max(
      raw.instructions.length,
      encodeInstructionJournalV2Local(instructionStore).sizeBytes,
      oldFuture.reservedBytes,
      legacy.slots.instructions.reserveBytes,
    );
    result.instructions = instructionRequiredBytes + instructionGrantBytes;
  }

  return { bySlot: result, instructionRequiredBytes, instructionGrantBytes };
}

function independentlyMeasureQuestionLease(fixture, questionFile, rawBefore) {
  const beforeInput = fixture.input;
  const afterInput = { ...beforeInput, questionFile };
  const beforeSnapshot = validateQuestionCapsuleFiles(beforeInput).snapshot;
  const afterSnapshot = validateQuestionCapsuleFiles(afterInput).snapshot;
  const targetBytes = Buffer.from(encodeQuestionCapsuleJournalV3Local(questionFile).bytes);
  const rawAfter = { ...rawBefore, questions: targetBytes };
  const beforeMeasurement = independentlyMeasuredProtectedAmounts(beforeSnapshot, {
    questionFile: beforeInput.questionFile,
    checkpointFile: beforeInput.checkpointFile,
  }, rawBefore, beforeInput.normalByteLimitsBySlot);
  const afterMeasurement = independentlyMeasuredProtectedAmounts(afterSnapshot, {
    questionFile: afterInput.questionFile,
    checkpointFile: afterInput.checkpointFile,
  }, rawAfter, afterInput.normalByteLimitsBySlot);
  const before = beforeMeasurement.bySlot;
  const after = afterMeasurement.bySlot;
  const maxBySlot = Object.fromEntries(Object.keys(before).map((slot) => [
    slot, Math.max(before[slot], after[slot]),
  ]));
  const protectedBytes = Object.values(maxBySlot).reduce((total, value) => total + value, 0);
  return {
    before,
    after,
    maxBySlot,
    protectedBytes,
    targetBytes,
    leaseBytes: protectedBytes + targetBytes.length,
    instructionRequiredBytes: beforeMeasurement.instructionRequiredBytes,
    grantBytes: beforeMeasurement.instructionGrantBytes,
  };
}

function saveInput(slot, file, head) {
  return {
    [slot === 'questions' ? 'questionFile' : 'checkpointFile']: file,
    expectedHead: head,
  };
}

function assertSameCapsuleStructure(before, after) {
  for (const slot of ['questions', 'checkpoint']) {
    const field = CAPSULES[slot];
    const order = ORDERS[slot];
    assert.deepEqual(after[slot === 'questions' ? 'questionFile' : 'checkpointFile'][field],
      before[slot === 'questions' ? 'questionFile' : 'checkpointFile'][field]);
    assert.deepEqual(after[slot === 'questions' ? 'questionFile' : 'checkpointFile'][order],
      before[slot === 'questions' ? 'questionFile' : 'checkpointFile'][order]);
  }
}

async function assertTypeError(promise, code) {
  await assert.rejects(promise, (error) => error instanceof TypeError && error.message === code);
}

async function assertErrorCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof Error && error.code === code);
}

test('native updates preserve Q3/CP4 files across providers and cold reloads', async (t) => {
  for (const options of [
    { provider: 'claude' },
    { provider: 'codex' },
    { provider: 'claude', secondaryProvider: 'codex' },
    { provider: 'codex', secondaryProvider: 'claude' },
  ]) {
    await t.test(JSON.stringify(options), async (subtest) => {
      const workspace = await trackWorkspace(subtest, { ...options, ordinaryQuestionSelected: true });
      const backend = workspace.openBackend();
      const seedBytes = await workspace.readAllBytes();
      const loaded = await backend.load();
      const projected = backend.readProjection();
      assert.equal(Object.isFrozen(projected), true);
      assert.equal(Object.isFrozen(projected.stores.questions.reservations), true);

      const questionFile = questionCandidate(loaded);
      const afterQuestion = await backend.saveQuestion(saveInput('questions', questionFile, loaded.heads.questions));
      const afterQuestionBytes = await workspace.readAllBytes();
      assert.notDeepEqual(afterQuestionBytes.questions, seedBytes.questions);
      assert.deepEqual(afterQuestionBytes.checkpoint, seedBytes.checkpoint);
      assert.deepEqual(afterQuestionBytes.anchor, seedBytes.anchor);
      assert.deepEqual(afterQuestionBytes.instructions, seedBytes.instructions);

      const checkpointFile = checkpointCandidate(afterQuestion);
      const afterCheckpoint = await backend.saveCheckpoint(saveInput(
        'checkpoint', checkpointFile, afterQuestion.heads.checkpoint));
      const afterBothBytes = await workspace.readAllBytes();
      assert.notDeepEqual(afterBothBytes.checkpoint, seedBytes.checkpoint);
      assert.deepEqual(afterBothBytes.anchor, seedBytes.anchor);
      assert.deepEqual(afterBothBytes.instructions, seedBytes.instructions);
      assertSameCapsuleStructure(loaded, afterCheckpoint);
      assert.equal(backend.status().status, 'ready');
      assert.equal(backend.status().operationLeaseHeld, false);
      assert.equal(workspace.status().baselineLeaseHeld, true);
      assert.equal(workspace.status().budget.reservedBytes, workspace.status().baselineLeaseBytes);

      await backend.close();
      const fresh = workspace.openBackend();
      const reloaded = await fresh.load();
      assert.deepEqual(reloaded.questionFile, afterCheckpoint.questionFile);
      assert.deepEqual(reloaded.checkpointFile, afterCheckpoint.checkpointFile);
      assertSameCapsuleStructure(loaded, reloaded);
      assert.deepEqual(await workspace.readAllBytes(), afterBothBytes);
      await fresh.close();
    });
  }
});

test('concurrent question and checkpoint saves use one queue and retain the other latest slot', async (t) => {
  for (const firstSlot of ['questions', 'checkpoint']) {
    await t.test(`first ${firstSlot}`, async (subtest) => {
      const workspace = await trackWorkspace(subtest, { provider: 'claude', ordinaryQuestionSelected: true });
      const backend = workspace.openBackend();
      const loaded = await backend.load();
      const questionFile = questionCandidate(loaded);
      const checkpointFile = checkpointCandidate(loaded);
      const requests = {
        questions: saveInput('questions', questionFile, loaded.heads.questions),
        checkpoint: saveInput('checkpoint', checkpointFile, loaded.heads.checkpoint),
      };
      const orderedSlots = firstSlot === 'questions' ? ['questions', 'checkpoint'] : ['checkpoint', 'questions'];
      const results = await Promise.all(orderedSlots.map((slot) =>
        slot === 'questions' ? backend.saveQuestion(requests[slot]) : backend.saveCheckpoint(requests[slot])));
      const final = results.at(-1);
      assert.deepEqual(final.questionFile.questionCapsules, loaded.questionFile.questionCapsules);
      assert.deepEqual(final.checkpointFile.checkpointCapsules, loaded.checkpointFile.checkpointCapsules);
      assert.equal(final.questionFile.questions.find((row) => row.selection !== null).lateAnswers.length, 1);
      assert.equal(final.checkpointFile.ledger.deliveries.find((row) => row.kind === 'instruction').state, 'accepted');
      await backend.close();
      const fresh = workspace.openBackend();
      const reloaded = await fresh.load();
      assert.deepEqual(reloaded.questionFile, final.questionFile);
      assert.deepEqual(reloaded.checkpointFile, final.checkpointFile);
      await fresh.close();
    });
  }
});

test('legacy projections, stale heads, and out-of-whitelist edits do not write or latch', async (t) => {
  const workspace = await trackWorkspace(t, { provider: 'codex', ordinaryQuestionSelected: true });
  const backend = workspace.openBackend();
  const loaded = await backend.load();
  const initialBytes = await workspace.readAllBytes();

  await assert.rejects(backend.saveQuestion(saveInput('questions', loaded.projection, loaded.heads.questions)),
    (error) => error instanceof TypeError);
  const staleCandidate = questionCandidate(loaded);
  await assertTypeError(backend.saveQuestion(saveInput('questions', staleCandidate, {
    ...loaded.heads.questions,
    revision: loaded.heads.questions.revision + 1,
  })), STALE);

  const heldCandidate = structuredClone(loaded.questionFile);
  heldCandidate.revision += 1;
  heldCandidate.questions[0].held = !heldCandidate.questions[0].held;
  await assertTypeError(backend.saveQuestion(saveInput('questions', heldCandidate, loaded.heads.questions)),
    'invalid_question_capsule_existing_update');
  assert.deepEqual(await workspace.readAllBytes(), initialBytes);
  assert.equal(backend.status().status, 'ready');

  const validCandidate = questionCandidate(loaded);
  const saved = await backend.saveQuestion(saveInput('questions', validCandidate, loaded.heads.questions));
  assert.equal(saved.questionFile.revision, loaded.questionFile.revision + 1);
  await backend.close();
});

test('external raw changes latch every slot before a write', async (t) => {
  const workspace = await trackWorkspace(t, { provider: 'claude', ordinaryQuestionSelected: true });
  const backend = workspace.openBackend();
  const loaded = await backend.load();
  const beforeQuestions = await workspace.readBytes('questions');
  const beforeInstructions = await workspace.readBytes('instructions');
  await workspace.replaceBytesForTest('instructions', Buffer.concat([beforeInstructions, Buffer.from(' ')]));

  await assertTypeError(backend.saveQuestion(saveInput(
    'questions', questionCandidate(loaded), loaded.heads.questions)), BLOCKED);
  assert.deepEqual(await workspace.readBytes('questions'), beforeQuestions);
  assert.equal(backend.status().status, 'blocked');
  assert.equal(backend.status().operationLeaseHeld, false);
  await assertTypeError(backend.saveQuestion(saveInput(
    'questions', questionCandidate(loaded), loaded.heads.questions)), BLOCKED);
  await backend.close();
});

test('budget shortage keeps the baseline lease and rejects without a native write', async (t) => {
  const reference = await trackWorkspace(t, { provider: 'codex', ordinaryQuestionSelected: true });
  const baselineBytes = reference.status().baselineLeaseBytes;
  await reference.dispose();

  const workspace = await trackWorkspace(t, {
    provider: 'codex',
    ordinaryQuestionSelected: true,
    maxAdditionalBytes: baselineBytes,
  });
  const backend = workspace.openBackend();
  const loaded = await backend.load();
  const beforeBytes = await workspace.readAllBytes();
  await assertErrorCode(backend.saveQuestion(saveInput(
    'questions', questionCandidate(loaded), loaded.heads.questions)), CAPACITY_EXCEEDED);
  assert.deepEqual(await workspace.readAllBytes(), beforeBytes);
  assert.equal(backend.status().status, 'ready');
  assert.equal(backend.status().operationLeaseHeld, false);
  assert.equal(workspace.status().budget.reservedBytes, baselineBytes);
  assert.equal(workspace.status().baselineLeaseHeld, true);
  await backend.close();
});

test('operation lease matches independently measured slot maxima plus temp bytes at exact total budgets', async (t) => {
  for (const scenario of ['standard', 'checkpoint-instructions-null']) {
    await t.test(scenario, async (subtest) => {
      const fixtureOptions = {
        scenario,
        provider: 'claude',
        ordinaryQuestionSelected: true,
      };
      const fixture = createQuestionCapsuleExistingUpdateFixture(fixtureOptions);
      const rawBefore = encodedFixtureBytes(fixture.input);
      const candidate = scenario === 'standard'
        ? questionCandidate({ questionFile: fixture.input.questionFile })
        : questionRevisionCandidate(fixture.input.questionFile);
      const expected = independentlyMeasureQuestionLease(fixture, candidate, rawBefore);
      const baselineBytes = baselineLeaseForFixture(fixture, rawBefore);
      const exactBudgetBytes = baselineBytes + expected.leaseBytes;

      assert.ok(expected.leaseBytes > 0);
      assert.ok(expected.targetBytes.length > 0);
      assert.equal(expected.leaseBytes, expected.protectedBytes + expected.targetBytes.length);
      for (const slot of ['anchor', 'questions', 'checkpoint', 'instructions']) {
        const isPresent = slot === 'anchor' || rawBefore[slot] !== null;
        assert.equal(expected.maxBySlot[slot] > 0, isPresent);
      }
      if (scenario === 'standard') {
        assert.ok(expected.grantBytes > 0);
        assert.equal(fixture.input.instructionStore.migrationAllowance.maxExtraBytes, expected.grantBytes);
        assert.equal(expected.before.instructions,
          expected.instructionRequiredBytes + expected.grantBytes);
      } else {
        assert.equal(fixture.input.checkpointFile, null);
        assert.equal(fixture.input.instructionStore, null);
        assert.equal(expected.maxBySlot.checkpoint, 0);
        assert.equal(expected.maxBySlot.instructions, 0);
        assert.equal(expected.grantBytes, 0);
      }

      const successWorkspace = await trackWorkspace(subtest, {
        ...fixtureOptions,
        maxAdditionalBytes: exactBudgetBytes,
      });
      assert.equal(successWorkspace.status().baselineLeaseBytes, baselineBytes);
      const successBackend = successWorkspace.openBackend();
      const successLoaded = await successBackend.load();
      assert.deepEqual(successLoaded.questionFile, fixture.input.questionFile);
      const success = await successBackend.saveQuestion(saveInput(
        'questions', candidate, successLoaded.heads.questions));
      assert.deepEqual(success.questionFile, candidate);
      assert.equal(successBackend.status().operationLeaseHeld, false);
      assert.equal(successWorkspace.status().budget.reservedBytes, baselineBytes);
      await successBackend.close();

      const pauseWorkspace = await trackWorkspace(subtest, {
        ...fixtureOptions,
        maxAdditionalBytes: exactBudgetBytes,
      });
      assert.equal(pauseWorkspace.status().baselineLeaseBytes, baselineBytes);
      const pauseBackend = pauseWorkspace.openBackend({ pausePoint: 'before_atomic_temp_open' });
      const pauseLoaded = await pauseBackend.load();
      const beforePausedBytes = await pauseWorkspace.readAllBytes();
      const pausedSaving = pauseBackend.saveQuestion(saveInput(
        'questions', candidate, pauseLoaded.heads.questions));
      const pauseReached = await Promise.race([
        pauseBackend.waitForPause(),
        pausedSaving.then(() => false, () => false),
      ]);
      assert.equal(pauseReached, true);
      assert.equal(pauseWorkspace.status().budget.reservedBytes - baselineBytes, expected.leaseBytes);
      const pausedClose = pauseBackend.close();
      assert.strictEqual(pauseBackend.close(), pausedClose);
      await Promise.all([assertTypeError(pausedSaving, CLOSED), pausedClose]);
      assert.deepEqual(await pauseWorkspace.readAllBytes(), beforePausedBytes);
      assert.equal(pauseBackend.status().status, 'closed');
      assert.equal(pauseBackend.status().queuedOperations, 0);
      assert.equal(pauseBackend.status().operationLeaseHeld, false);
      assert.equal(pauseWorkspace.status().budget.reservedBytes, baselineBytes);
      assert.equal(pauseWorkspace.status().baselineLeaseHeld, true);

      const shortWorkspace = await trackWorkspace(subtest, {
        ...fixtureOptions,
        maxAdditionalBytes: exactBudgetBytes - 1,
      });
      assert.equal(shortWorkspace.status().baselineLeaseBytes, baselineBytes);
      const shortBackend = shortWorkspace.openBackend();
      const shortLoaded = await shortBackend.load();
      const beforeShortBytes = await shortWorkspace.readAllBytes();
      await assertErrorCode(shortBackend.saveQuestion(saveInput(
        'questions', candidate, shortLoaded.heads.questions)), CAPACITY_EXCEEDED);
      assert.deepEqual(await shortWorkspace.readAllBytes(), beforeShortBytes);
      assert.equal(shortBackend.status().status, 'ready');
      assert.equal(shortBackend.status().operationLeaseHeld, false);
      assert.equal(shortWorkspace.status().budget.reservedBytes, baselineBytes);
      assert.equal(shortWorkspace.status().baselineLeaseHeld, true);
      await shortBackend.close();
    });
  }
});

test('close at the exclusive temporary-open gate rejects queued saves and prevents target writes', async (t) => {
  const workspace = await trackWorkspace(t, { provider: 'claude', ordinaryQuestionSelected: true });
  const backend = workspace.openBackend({ pausePoint: 'before_atomic_temp_open' });
  const loaded = await backend.load();
  const beforeBytes = await workspace.readAllBytes();
  const firstSaving = backend.saveQuestion(saveInput(
    'questions', questionCandidate(loaded), loaded.heads.questions));
  assert.equal(await backend.waitForPause(), true);
  const queuedSaving = backend.saveCheckpoint(saveInput(
    'checkpoint', checkpointCandidate(loaded), loaded.heads.checkpoint));
  assert.equal(backend.status().queuedOperations, 1);
  const closing = backend.close();
  assert.strictEqual(backend.close(), closing);
  await Promise.all([
    assertTypeError(firstSaving, CLOSED),
    assertTypeError(queuedSaving, CLOSED),
    closing,
  ]);
  assert.deepEqual(await workspace.readAllBytes(), beforeBytes);
  assert.equal(backend.status().status, 'closed');
  assert.equal(backend.status().queuedOperations, 0);
  assert.equal(backend.status().operationLeaseHeld, false);
  assert.equal(workspace.status().budget.reservedBytes, workspace.status().baselineLeaseBytes);
  assert.equal(workspace.status().baselineLeaseHeld, true);
});

test('fixed write faults latch the instance and cold loads accept only complete representations', async (t) => {
  const cases = [
    { slot: 'questions', point: 'questions_before_rename' },
    { slot: 'questions', point: 'questions_after_rename_before_readback' },
    { slot: 'checkpoint', point: 'checkpoint_before_rename' },
    { slot: 'checkpoint', point: 'checkpoint_after_rename_before_readback' },
  ];
  for (const item of cases) {
    await t.test(item.point, async (subtest) => {
      const workspace = await trackWorkspace(subtest, { provider: 'codex', ordinaryQuestionSelected: true });
      const backend = workspace.openBackend({ failurePoint: item.point });
      const loaded = await backend.load();
      const seedBytes = await workspace.readBytes(item.slot);
      const candidate = item.slot === 'questions' ? questionCandidate(loaded) : checkpointCandidate(loaded);
      const field = item.slot === 'questions' ? 'questionFile' : 'checkpointFile';
      const candidateBytes = item.slot === 'questions'
        ? encodeQuestionCapsuleJournalV3Local(candidate).bytes
        : encodeCapsuleCheckpointV4Local(candidate).bytes;
      const head = loaded.heads[item.slot];
      const saving = item.slot === 'questions'
        ? backend.saveQuestion(saveInput(item.slot, candidate, head))
        : backend.saveCheckpoint(saveInput(item.slot, candidate, head));

      await assertTypeError(saving, BLOCKED);
      assert.equal(backend.status().status, 'blocked');
      assert.equal(backend.status().operationLeaseHeld, true);
      await assertTypeError(item.slot === 'questions'
        ? backend.saveQuestion(saveInput(item.slot, candidate, head))
        : backend.saveCheckpoint(saveInput(item.slot, candidate, head)), BLOCKED);
      const currentTargetBytes = await workspace.readBytes(item.slot);
      if (item.point.endsWith('_before_rename')) assert.deepEqual(currentTargetBytes, seedBytes);
      else assert.deepEqual(currentTargetBytes, candidateBytes);
      await backend.close();
      assert.equal(backend.status().operationLeaseHeld, false);

      const fresh = workspace.openBackend();
      if (item.point.endsWith('_before_rename')) {
        await assertTypeError(fresh.load(), INVALID);
        assert.equal(fresh.status().status, 'blocked');
        await fresh.close();
        assert.equal(await workspace.cleanupInjectedOrphan(), 1);
      } else {
        const reloaded = await fresh.load();
        assert.deepEqual(reloaded[field], candidate);
        await fresh.close();
      }
    });
  }
});

test('same paths cannot have two live persistence owners', async (t) => {
  const workspace = await trackWorkspace(t, { provider: 'claude' });
  const first = workspace.openBackend();
  assert.throws(() => workspace.openBackend(), (error) =>
    error instanceof Error && error.code === 'reclamation_persistence_path_owned');
  await first.close();
});

test('cold load refuses legacy expanded Q2 and CP3 files', async (t) => {
  for (const slot of ['questions', 'checkpoint']) {
    await t.test(slot, async (subtest) => {
      const workspace = await trackWorkspace(subtest, { provider: 'claude' });
      const backend = workspace.openBackend();
      const loaded = await backend.load();
      await backend.close();
      const oldStore = loaded.projection.stores[slot];
      await workspace.replaceBytesForTest(slot, Buffer.from(JSON.stringify(oldStore), 'utf8'));
      const fresh = workspace.openBackend();
      await assertTypeError(fresh.load(), INVALID);
      assert.equal(fresh.status().status, 'blocked');
      await fresh.close();
    });
  }
});

test('cold load rejects capsule chunk mismatches and invalid delivery order', async (t) => {
  await t.test('a locally valid checkpoint capsule cannot reference an unknown question chunk', async (subtest) => {
    const workspace = await trackWorkspace(subtest, { provider: 'claude' });
    const initial = workspace.openBackend();
    const loaded = await initial.load();
    await initial.close();

    const checkpointFile = structuredClone(loaded.checkpointFile);
    checkpointFile.checkpointCapsules[0].chunkId = 'b0000000-0000-4000-8000-000000000001';
    const checkpointBytes = encodeCapsuleCheckpointV4Local(checkpointFile).bytes;
    await workspace.replaceBytesForTest('checkpoint', checkpointBytes);

    const fresh = workspace.openBackend();
    await assertTypeError(fresh.load(), INVALID);
    assert.equal(fresh.status().status, 'blocked');
    await fresh.close();
  });

  await t.test('a locally invalid delivery order cannot be loaded from disk', async (subtest) => {
    const workspace = await trackWorkspace(subtest, { provider: 'codex' });
    const initial = workspace.openBackend();
    const loaded = await initial.load();
    await initial.close();

    const checkpointFile = structuredClone(loaded.checkpointFile);
    checkpointFile.deliveryAttemptOrder.reverse();
    assert.throws(() => encodeCapsuleCheckpointV4Local(checkpointFile), TypeError);
    await workspace.replaceBytesForTest('checkpoint', Buffer.from(JSON.stringify(checkpointFile), 'utf8'));

    const fresh = workspace.openBackend();
    await assertTypeError(fresh.load(), INVALID);
    assert.equal(fresh.status().status, 'blocked');
    await fresh.close();
  });
});
