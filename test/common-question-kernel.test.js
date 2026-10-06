'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const kernel = require('../src/server/common-question-kernel');

function identity() {
  return { provider: 'claude', nativeIdKind: 'session', hostId: 'host', homeScopeId: 'home', nativeId: 'session' };
}

function questions() {
  return [{ id: 'choice', text: 'Choose one', mode: 'single',
    options: [{ id: 'yes', label: 'Yes', description: 'Accept' },
      { id: 'no', label: 'No', description: 'Reject' }],
    allowFreeText: false, recommendedOptionId: 'yes' }];
}

function record(overrides = {}) {
  return kernel.createQuestionRecord({
    internalQuestionId: 'cq-test', questionId: 'q-test', identity: identity(),
    periodId: 'period-1', executionId: 'period-1', conversationId: 'conversation-1',
    launchRef: 'launch-1', executionBinding: { periodId: 'period-1', actor: { kind: 'agent', id: 'agent-1' } },
    category: 'ordinary', questions: questions(), timeoutMinutes: 1, createdAt: 1_000, ...overrides,
  });
}

const manualAnswers = [{ questionId: 'choice', optionIds: ['no'], freeText: null }];

test('question normalization rejects unknown fields, accessors, and sparse arrays', () => {
  assert.throws(() => kernel.normalizeQuestions([{ ...questions()[0], extra: true }]), { code: 'invalid_question' });
  const accessor = questions()[0];
  delete accessor.id;
  Object.defineProperty(accessor, 'id', { enumerable: true, get() { return 'choice'; } });
  assert.throws(() => kernel.normalizeQuestions([accessor]), { code: 'invalid_question' });
  const sparse = [];
  sparse[1] = questions()[0];
  assert.throws(() => kernel.normalizeQuestions(sparse), { code: 'invalid_question' });
});

test('free-text-only questions require a complete nonempty answer', () => {
  const value = [{ id: 'notes', text: 'Add details', mode: 'single', options: [],
    allowFreeText: true, recommendedOptionId: null }];
  assert.deepEqual(kernel.normalizeAnswers([
    { questionId: 'notes', optionIds: [], freeText: 'A useful note' },
  ], kernel.normalizeQuestions(value)), [
    { questionId: 'notes', optionIds: [], freeText: 'A useful note' },
  ]);
  assert.throws(() => kernel.normalizeAnswers([
    { questionId: 'notes', optionIds: [], freeText: null },
  ], kernel.normalizeQuestions(value)), { code: 'invalid_answer' });
});

test('away defaults require all questions to use their explicit single recommendation', () => {
  const original = record();
  const result = kernel.selectionFor(original, kernel.awayDefaultAnswers(original), 'away-default',
    original.deadlineAt, 'delivery-1');
  assert.equal(result.record.selection.source, 'away-default');
  assert.deepEqual(kernel.normalizeQuestionRecord(result.record), result.record);

  const altered = structuredClone(result.record);
  altered.selection.answers = manualAnswers;
  altered.deliveryIntent.payloadDigest = kernel.sha256Json({
    questionId: altered.questionId,
    revision: altered.revision,
    answers: altered.selection.answers,
  });
  assert.throws(() => kernel.normalizeQuestionRecord(altered), { code: 'invalid_journal' });
});

test('answers before registration and canceled questions cannot create a selection', () => {
  const original = record();
  assert.throws(() => kernel.selectionFor(original, manualAnswers, 'manual', 999, 'delivery-2'),
    { code: 'invalid_selection_time' });
  const canceled = { ...original, cancelledAt: original.createdAt };
  assert.throws(() => kernel.selectionFor(canceled, manualAnswers, 'manual', 1_001, 'delivery-3'),
    { code: 'question_cancelled' });
});

test('late answers preserve the original selection and are bounded history', () => {
  let current = kernel.selectionFor(record(), manualAnswers, 'manual', 1_001, 'delivery-4').record;
  const lateAnswers = [{ questionId: 'choice', optionIds: ['yes'], freeText: null }];
  const late = kernel.selectionFor(current, lateAnswers, 'manual', 1_002, 'delivery-5');
  assert.equal(late.outcome, 'late');
  assert.equal(late.record.revision, current.revision);
  assert.deepEqual(late.record.selection.answers, current.selection.answers);
  assert.equal(late.record.lateAnswers.length, 1);
});