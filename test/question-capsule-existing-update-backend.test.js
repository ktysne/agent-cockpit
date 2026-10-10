'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { selectionFor } = require('../src/server/common-question-kernel');
const { encodeCapsuleCheckpointV4Local } = require('../src/server/question-capsule-checkpoint-codec');
const { encodeQuestionCapsuleJournalV3Local } = require('../src/server/question-capsule-journal-codec');
const { createQuestionCapsuleExistingUpdateWorkspace } =
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

test('close at the exclusive temporary-open gate prevents the target write', async (t) => {
  const workspace = await trackWorkspace(t, { provider: 'claude', ordinaryQuestionSelected: true });
  const backend = workspace.openBackend({ pausePoint: 'before_atomic_temp_open' });
  const loaded = await backend.load();
  const beforeBytes = await workspace.readAllBytes();
  const saving = backend.saveQuestion(saveInput('questions', questionCandidate(loaded), loaded.heads.questions));
  assert.equal(await backend.waitForPause(), true);
  const closing = backend.close();
  await assertTypeError(saving, CLOSED);
  await closing;
  assert.deepEqual(await workspace.readAllBytes(), beforeBytes);
  assert.equal(backend.status().status, 'closed');
  assert.equal(backend.status().operationLeaseHeld, false);
  assert.equal(workspace.status().budget.reservedBytes, workspace.status().baselineLeaseBytes);
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
