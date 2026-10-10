'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const test = require('node:test');
const { createQuestionCapsuleRestrictedLifecycle } =
  require('./helpers/question-capsule-restricted-lifecycle');
const { createQuestionCapsuleExistingUpdateWorkspace } =
  require('./helpers/question-capsule-existing-update-workspace');
const { MAX_LATE_ANSWERS } = require('../src/server/common-question-kernel');

const NOT_STARTED = 'question_capsule_restricted_lifecycle_not_started';
const CLOSED = 'question_capsule_restricted_lifecycle_closed';
const UNSUPPORTED = 'question_capsule_restricted_lifecycle_unsupported_operation';
const INVALID = 'invalid_question_capsule_restricted_lifecycle';
const LATE_ANSWER_CAPACITY = 'question_capsule_restricted_lifecycle_late_answer_capacity';
const DISPOSE_TEST_FAILURE = 'question_capsule_restricted_lifecycle_dispose_test_failure';
const BACKEND_BLOCKED = 'question_capsule_existing_update_backend_blocked';
const BACKEND_CLOSED = 'question_capsule_existing_update_backend_closed';
const BACKEND_INVALID = 'invalid_question_capsule_existing_update_backend';
const WORKSPACE_UNKNOWN_FILE = 'question_capsule_existing_update_workspace_unknown_file';
const CAPACITY = 'reclamation_capacity_exceeded';
const UNKNOWN_MARKER_NAME = 'restricted-lifecycle-owned-test-marker';
const LATE_ANSWER = Object.freeze([Object.freeze({
  questionId: 'question-5',
  optionIds: Object.freeze([]),
  freeText: 'restricted lifecycle late answer',
})]);

async function fixture(t, provider, scenario = 'standard') {
  const lifecycle = await createQuestionCapsuleRestrictedLifecycle({ provider, scenario });
  t.after(async () => lifecycle.dispose());
  return lifecycle;
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => error instanceof Error &&
    (error.code === code || error.message === code));
}

function clone(value) {
  return structuredClone(value);
}

test('the fixture facade starts before accepting operations and hides storage controls', async (t) => {
  const lifecycle = await fixture(t, 'claude');
  const before = lifecycle.status();
  assert.equal(before.state, 'new');
  await rejectsCode(lifecycle.submitLateAnswer({ internalQuestionId: 'internal-5', answers: clone(LATE_ANSWER) }),
    NOT_STARTED);
  await rejectsCode(lifecycle.advanceFixtureDelivery(), NOT_STARTED);
  assert.deepEqual(Object.keys(lifecycle).sort(), [
    'advanceFixtureDelivery', 'close', 'dispose', 'reopen', 'start', 'status', 'submitLateAnswer', 'waitForPause',
  ].sort());
  assert.equal(Object.isFrozen(lifecycle), true);
  assert.equal('saveQuestion' in lifecycle, false);
  assert.equal('openBackend' in lifecycle, false);
  assert.equal('root' in lifecycle, false);

  const started = await lifecycle.start();
  assert.equal(started.state, 'ready');
  assert.equal(started.baselineLeaseHeld, true);
  assert.equal(started.operationLeaseHeld, false);
});

test('selected ordinary late answers and non-question delivery progress are serialized for both providers', async (t) => {
  for (const provider of ['claude', 'codex']) {
    for (const first of ['questions', 'checkpoint']) {
      await t.test(`${provider}: ${first} first`, async (subtest) => {
        const lifecycle = await fixture(subtest, provider);
        const initial = await lifecycle.start();
        const originalStructure = initial.structure;
        assert.equal(initial.question.selected, true);
        assert.equal(initial.question.lateAnswerCount, 0);
        assert.equal(initial.instruction.state, 'available');

        const operations = {
          questions: () => lifecycle.submitLateAnswer({
            internalQuestionId: 'internal-5',
            answers: clone(LATE_ANSWER),
          }),
          checkpoint: () => lifecycle.advanceFixtureDelivery(),
        };
        const order = first === 'questions' ? ['questions', 'checkpoint'] : ['checkpoint', 'questions'];
        const results = await Promise.all(order.map((slot) => operations[slot]()));
        assert.deepEqual(results.map(({ saved }) => saved), [true, true]);

        const after = lifecycle.status();
        assert.equal(after.state, 'ready');
        assert.equal(after.question.lateAnswerCount, 1);
        assert.equal(after.instruction.state, 'accepted');
        assert.deepEqual(after.completedSaves, { questions: 1, checkpoint: 1 });
        assert.deepEqual(after.saveAttempts, { questions: 1, checkpoint: 1 });
        assert.equal(after.operationLeaseHeld, false);
        assert.equal(after.baselineLeaseHeld, true);
        assert.equal(after.reservedBudgetBytes, after.baselineLeaseBytes);
        assert.deepEqual(after.structure, originalStructure);

        const duplicateQuestion = await lifecycle.submitLateAnswer({
          internalQuestionId: 'internal-5',
          answers: clone(LATE_ANSWER),
        });
        const duplicateDelivery = await lifecycle.advanceFixtureDelivery();
        assert.deepEqual(duplicateQuestion, { outcome: 'duplicate', saved: false });
        assert.deepEqual(duplicateDelivery, { outcome: 'duplicate', saved: false });
        assert.deepEqual(lifecycle.status().saveAttempts, { questions: 1, checkpoint: 1 });

        await lifecycle.close();
        const reloaded = await lifecycle.reopen();
        assert.equal(reloaded.state, 'ready');
        assert.equal(reloaded.question.lateAnswerCount, 1);
        assert.equal(reloaded.instruction.state, 'accepted');
        assert.deepEqual(reloaded.structure, originalStructure);
        await rejectsCode(lifecycle.submitLateAnswer({
          internalQuestionId: 'internal-1',
          answers: clone(LATE_ANSWER),
        }), UNSUPPORTED);
        assert.deepEqual(lifecycle.status().structure, originalStructure);
      });
    }
  }
});

test('the facade accepts MAX_LATE_ANSWERS and rejects the next answer without writing or latching', async (t) => {
  assert.equal(MAX_LATE_ANSWERS, 10);
  const lifecycle = await fixture(t, 'claude');
  const initial = await lifecycle.start();
  assert.equal(initial.question.selected, true);
  assert.equal(initial.question.lateAnswerCount, 0);

  for (let index = 1; index <= MAX_LATE_ANSWERS; index += 1) {
    const outcome = await lifecycle.submitLateAnswer({
      internalQuestionId: 'internal-5',
      answers: [{
        questionId: 'question-5',
        optionIds: [],
        freeText: `capacity boundary answer ${index}`,
      }],
    });
    assert.deepEqual(outcome, { outcome: 'late', saved: true });
  }

  const atCapacity = lifecycle.status();
  assert.equal(atCapacity.state, 'ready');
  assert.equal(atCapacity.question.lateAnswerCount, MAX_LATE_ANSWERS);
  assert.equal(atCapacity.question.selectionSha256, initial.question.selectionSha256);
  assert.deepEqual(atCapacity.structure, initial.structure);

  const writeCountsAtCapacity = {
    attempts: atCapacity.saveAttempts,
    completed: atCapacity.completedSaves,
  };
  await rejectsCode(lifecycle.submitLateAnswer({
    internalQuestionId: 'internal-5',
    answers: [{
      questionId: 'question-5',
      optionIds: [],
      freeText: 'capacity boundary answer 11',
    }],
  }), LATE_ANSWER_CAPACITY);

  const afterRejectedAnswer = lifecycle.status();
  assert.equal(afterRejectedAnswer.state, 'ready');
  assert.equal(afterRejectedAnswer.blocked, false);
  assert.equal(afterRejectedAnswer.blockedReason, null);
  assert.equal(afterRejectedAnswer.outcomeUnknown, false);
  assert.equal(afterRejectedAnswer.question.selected, true);
  assert.equal(afterRejectedAnswer.question.lateAnswerCount, MAX_LATE_ANSWERS);
  assert.equal(afterRejectedAnswer.question.selectionSha256, initial.question.selectionSha256);
  assert.deepEqual(afterRejectedAnswer.saveAttempts, writeCountsAtCapacity.attempts);
  assert.deepEqual(afterRejectedAnswer.completedSaves, writeCountsAtCapacity.completed);
  assert.deepEqual(afterRejectedAnswer.structure, initial.structure);
});

test('a failed initial load exposes a blocked state and reason', async (t) => {
  const lifecycle = await fixture(t, 'claude', 'start_invalid');
  await assert.rejects(lifecycle.start(), (error) => error instanceof Error);
  const failed = lifecycle.status();
  assert.equal(failed.state, 'blocked');
  assert.equal(failed.blocked, true);
  assert.equal(typeof failed.blockedReason, 'string');
  assert.notEqual(failed.blockedReason, '');
});

test('capsule, retired, missing, initial-selection, and malformed requests reject before writing', async (t) => {
  const lifecycle = await fixture(t, 'codex', 'unselected');
  await lifecycle.start();
  const initial = lifecycle.status();
  assert.equal(initial.question.selected, false);

  for (const internalQuestionId of ['internal-1', 'internal-2', 'internal-3', 'internal-4', 'unknown-question']) {
    await rejectsCode(lifecycle.submitLateAnswer({ internalQuestionId, answers: clone(LATE_ANSWER) }), UNSUPPORTED);
  }
  await rejectsCode(lifecycle.submitLateAnswer({
    internalQuestionId: 'internal-5',
    answers: clone(LATE_ANSWER),
  }), UNSUPPORTED);
  await rejectsCode(lifecycle.submitLateAnswer({
    internalQuestionId: 'internal-5',
    answers: clone(LATE_ANSWER),
    expectedHead: {},
  }), INVALID);
  assert.deepEqual(lifecycle.status().saveAttempts, { questions: 0, checkpoint: 0 });
  assert.equal(lifecycle.status().state, 'ready');

  const proxiedInput = new Proxy({}, {
    ownKeys() { throw new Error('input proxy must not be inspected'); },
    getOwnPropertyDescriptor() { throw new Error('input proxy must not be inspected'); },
  });
  await rejectsCode(lifecycle.submitLateAnswer(proxiedInput), INVALID);
  assert.deepEqual(lifecycle.status().saveAttempts, { questions: 0, checkpoint: 0 });

  const progressed = await lifecycle.advanceFixtureDelivery();
  assert.deepEqual(progressed, { outcome: 'accepted', saved: true });
  assert.equal(lifecycle.status().state, 'ready');
});

test('nested proxied answer data is rejected without invoking traps or latching the fixture', async (t) => {
  const lifecycle = await fixture(t, 'claude');
  await lifecycle.start();
  let traps = 0;
  const answers = new Proxy([], {
    ownKeys() { traps += 1; throw new Error('answer proxy trap'); },
    getOwnPropertyDescriptor() { traps += 1; throw new Error('answer proxy trap'); },
  });
  await rejectsCode(lifecycle.submitLateAnswer({ internalQuestionId: 'internal-5', answers }), INVALID);
  assert.equal(traps, 0);
  assert.equal(lifecycle.status().state, 'ready');
  assert.deepEqual(lifecycle.status().saveAttempts, { questions: 0, checkpoint: 0 });
});

test('a budget-short fixture retains its baseline lease and rejects before native writes', async (t) => {
  const lifecycle = await fixture(t, 'claude', 'budget_shortage');
  const initial = await lifecycle.start();
  await rejectsCode(lifecycle.submitLateAnswer({
    internalQuestionId: 'internal-5',
    answers: clone(LATE_ANSWER),
  }), CAPACITY);
  const after = lifecycle.status();
  assert.equal(after.state, 'ready');
  assert.deepEqual(after.saveAttempts, { questions: 1, checkpoint: 0 });
  assert.deepEqual(after.completedSaves, { questions: 0, checkpoint: 0 });
  assert.equal(after.operationLeaseHeld, false);
  assert.equal(after.baselineLeaseHeld, true);
  assert.equal(after.reservedBudgetBytes, initial.baselineLeaseBytes);
});

test('close opens the fixed temp gate, drains queued work, and preserves the baseline lease', async (t) => {
  const lifecycle = await fixture(t, 'codex', 'pause_before_temp_open');
  const initial = await lifecycle.start();
  const saving = lifecycle.submitLateAnswer({ internalQuestionId: 'internal-5', answers: clone(LATE_ANSWER) });
  assert.equal(await lifecycle.waitForPause(), true);
  const queued = lifecycle.advanceFixtureDelivery();
  const paused = lifecycle.status();
  assert.equal(paused.state, 'ready');
  assert.equal(paused.operationLeaseHeld, true);
  assert.equal(paused.baselineLeaseHeld, true);
  assert.equal(paused.pendingOperations, 1);

  const closing = lifecycle.close();
  assert.equal(lifecycle.status().state, 'closing');
  await rejectsCode(saving, BACKEND_CLOSED);
  await rejectsCode(queued, CLOSED);
  const closed = await closing;
  assert.equal(closed.state, 'closed');
  assert.equal(closed.closed, true);
  assert.equal(closed.operationLeaseHeld, false);
  assert.equal(closed.baselineLeaseHeld, true);
  assert.equal(closed.reservedBudgetBytes, initial.baselineLeaseBytes);
  assert.equal(closed.question.lateAnswerCount, 0);
});

test('unknown post-rename results are latched until cold reopen validates the complete representation', async (t) => {
  for (const item of [
    { scenario: 'question_after_rename', slot: 'questions' },
    { scenario: 'checkpoint_after_rename', slot: 'checkpoint' },
  ]) {
    await t.test(item.scenario, async (subtest) => {
      const lifecycle = await fixture(subtest, 'claude', item.scenario);
      const initial = await lifecycle.start();
      const operation = item.slot === 'questions'
        ? lifecycle.submitLateAnswer({ internalQuestionId: 'internal-5', answers: clone(LATE_ANSWER) })
        : lifecycle.advanceFixtureDelivery();
      await rejectsCode(operation, BACKEND_BLOCKED);
      const blocked = lifecycle.status();
      assert.equal(blocked.state, 'blocked');
      assert.equal(blocked.outcomeUnknown, true);
      assert.equal(blocked.completedSaves[item.slot], 0);
      assert.equal(blocked.structure.capsuleStructureSha256, initial.structure.capsuleStructureSha256);
      await rejectsCode(item.slot === 'questions'
        ? lifecycle.advanceFixtureDelivery()
        : lifecycle.submitLateAnswer({ internalQuestionId: 'internal-5', answers: clone(LATE_ANSWER) }),
      'question_capsule_restricted_lifecycle_blocked');

      await lifecycle.close();
      assert.equal(lifecycle.status().operationLeaseHeld, false);
      assert.equal(lifecycle.status().baselineLeaseHeld, true);
      const reloaded = await lifecycle.reopen();
      assert.equal(reloaded.state, 'ready');
      assert.equal(reloaded.outcomeUnknown, true);
      if (item.slot === 'questions') assert.equal(reloaded.question.lateAnswerCount, 1);
      else assert.equal(reloaded.instruction.state, 'accepted');
      assert.deepEqual(reloaded.structure, initial.structure);
    });
  }
});

test('known before-rename orphans block cold reopen and only the fixture owner removes them on dispose', async (t) => {
  for (const scenario of ['question_before_rename', 'checkpoint_before_rename']) {
    await t.test(scenario, async (subtest) => {
      const lifecycle = await fixture(subtest, 'codex', scenario);
      await lifecycle.start();
      const operation = scenario === 'question_before_rename'
        ? lifecycle.submitLateAnswer({ internalQuestionId: 'internal-5', answers: clone(LATE_ANSWER) })
        : lifecycle.advanceFixtureDelivery();
      await rejectsCode(operation, BACKEND_BLOCKED);
      await lifecycle.close();
      await rejectsCode(lifecycle.reopen(), BACKEND_INVALID);
      assert.equal(lifecycle.status().state, 'blocked');
      assert.equal(lifecycle.status().outcomeUnknown, true);
      await lifecycle.dispose();
      assert.equal(lifecycle.status().state, 'disposed');
    });
  }
});

test('dispose remains retryable after a fixed cleanup-boundary failure', async (t) => {
  const lifecycle = await fixture(t, 'codex', 'dispose_cleanup_once');
  await lifecycle.start();
  await rejectsCode(lifecycle.submitLateAnswer({
    internalQuestionId: 'internal-5',
    answers: clone(LATE_ANSWER),
  }), BACKEND_BLOCKED);
  await lifecycle.close();

  const firstAttempt = lifecycle.dispose();
  assert.strictEqual(lifecycle.dispose(), firstAttempt);
  await rejectsCode(firstAttempt, DISPOSE_TEST_FAILURE);
  const afterFailure = lifecycle.status();
  assert.equal(afterFailure.state, 'disposing');
  assert.equal(afterFailure.disposing, true);
  assert.equal(afterFailure.disposed, false);
  assert.equal(afterFailure.baselineLeaseHeld, true);
  assert.equal(afterFailure.operationLeaseHeld, false);
  await rejectsCode(lifecycle.start(), CLOSED);
  await rejectsCode(lifecycle.reopen(), CLOSED);

  const retry = lifecycle.dispose();
  assert.notStrictEqual(retry, firstAttempt);
  const disposed = await retry;
  assert.equal(disposed.state, 'disposed');
  assert.equal(disposed.disposing, false);
  assert.equal(disposed.disposed, true);
  assert.equal(disposed.baselineLeaseHeld, false);
});

test('workspace disposal preserves an unexpected entry and can retry after its owner removes it', async (t) => {
  const workspace = await createQuestionCapsuleExistingUpdateWorkspace({ provider: 'claude' });
  const rootPath = path.resolve(workspace.root);
  const markerPath = path.join(rootPath, UNKNOWN_MARKER_NAME);
  const markerBytes = Buffer.from('fixture-owned marker');
  let markerCreated = false;

  async function removeOwnedMarker() {
    if (!markerCreated) return;
    assert.equal(path.isAbsolute(markerPath), true);
    assert.equal(path.resolve(markerPath), markerPath);
    assert.equal(path.dirname(markerPath), rootPath);
    const realRoot = await fs.realpath(rootPath);
    assert.equal(await fs.realpath(path.dirname(markerPath)), realRoot);
    const markerStat = await fs.lstat(markerPath);
    assert.equal(markerStat.isFile(), true);
    assert.equal(markerStat.isSymbolicLink(), false);
    await fs.unlink(markerPath);
    markerCreated = false;
  }

  t.after(async () => {
    await removeOwnedMarker();
    await workspace.dispose();
  });

  assert.equal(workspace.root, rootPath);
  await fs.writeFile(markerPath, markerBytes, { flag: 'wx' });
  markerCreated = true;
  await rejectsCode(workspace.dispose(), WORKSPACE_UNKNOWN_FILE);
  assert.deepEqual(await fs.readFile(markerPath), markerBytes);
  assert.equal((await fs.stat(rootPath)).isDirectory(), true);

  await removeOwnedMarker();
  await workspace.dispose();
  await assert.rejects(fs.stat(rootPath), (error) => error?.code === 'ENOENT');
});

test('simultaneous cold reopen calls share the same completion', async (t) => {
  const lifecycle = await fixture(t, 'claude');
  await lifecycle.start();
  await lifecycle.close();

  const first = lifecycle.reopen();
  const second = lifecycle.reopen();
  assert.strictEqual(first, second);
  assert.equal((await first).state, 'ready');
});

test('dispose is terminal and repeated close shares the same completion', async (t) => {
  const lifecycle = await fixture(t, 'claude');
  await lifecycle.start();
  const firstClose = lifecycle.close();
  const secondClose = lifecycle.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
  await lifecycle.dispose();
  await rejectsCode(lifecycle.reopen(), CLOSED);
  await rejectsCode(lifecycle.start(), CLOSED);
});
