'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { createQuestionRecord } = require('../src/server/common-question-kernel');
const { normalizeQuestionJournalV2Local } = require('../src/server/common-question-reclamation-codec');
const { createEmptyCheckpointV3TargetLocal } = require('../src/server/reclamation-migration-projection');
const { projectLegacyQuestionJournalV1Local } = require('../src/server/reclamation-migration-projection');
const { encodeNormalized } = require('../src/server/reclamation-json-codec');
const { planQuestionPeriodRetirement } = require('../src/server/question-period-retirement');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';

function emptyAnchor() {
  return {
    schemaVersion: 1,
    revision: 0,
    storeId: STORE_ID,
    retiredQuestionPeriods: [],
    migration: null,
  };
}

function legacyQuestion(overrides = {}) {
  return createQuestionRecord({
    internalQuestionId: overrides.internalQuestionId || 'internal-a',
    questionId: overrides.questionId || 'public-a',
    identity: overrides.identity || {
      provider: 'claude', nativeIdKind: 'session', hostId: 'host-a',
      homeScopeId: 'scope-a', nativeId: 'native-a',
    },
    periodId: overrides.periodId || 'period-a',
    executionId: overrides.executionId || 'period-a',
    conversationId: overrides.conversationId || 'conversation-a',
    launchRef: overrides.launchRef || 'launch-a',
    executionBinding: overrides.executionBinding || { periodId: 'period-a', actor: { kind: 'agent', id: 'actor-a' } },
    category: 'ordinary',
    questions: [{
      id: 'question-a', text: 'Choose one', mode: 'single',
      options: [{ id: 'option-a', label: 'Option A', description: '' }],
      allowFreeText: true, recommendedOptionId: 'option-a',
    }],
    timeoutMinutes: 1,
    createdAt: 100,
  });
}

function unretiredQuestionJournal(questions = [legacyQuestion()]) {
  const projected = projectLegacyQuestionJournalV1Local({
    sourceBytes: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 3, questions })),
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: 200,
    checkpointSnapshot: null,
    migrationAllowance: null,
  });
  const snapshot = structuredClone(projected.snapshot);
  for (const detail of snapshot.questions) detail.quarantinedAt = null;
  for (const reservation of snapshot.reservations) reservation.quarantinedAt = null;
  return normalizeQuestionJournalV2Local(snapshot);
}

function emptyCheckpoint() {
  return createEmptyCheckpointV3TargetLocal({ storeId: STORE_ID }).snapshot;
}

test('retirement quarantines only matching questions and preserves the other stores', () => {
  const first = legacyQuestion();
  const second = legacyQuestion({
    internalQuestionId: 'internal-b',
    questionId: 'public-b',
    identity: {
      provider: 'claude', nativeIdKind: 'session', hostId: 'host-b',
      homeScopeId: 'scope-b', nativeId: 'native-b',
    },
    periodId: 'period-b',
    executionId: 'period-b',
    conversationId: 'conversation-b',
    launchRef: 'launch-b',
    executionBinding: { periodId: 'period-b', actor: { kind: 'agent', id: 'actor-b' } },
  });
  const questionJournal = unretiredQuestionJournal([first, second]);
  const checkpoint = emptyCheckpoint();
  const plan = planQuestionPeriodRetirement({
    anchor: emptyAnchor(),
    questionJournal,
    checkpoint,
    identity: first.identity,
    periodId: first.periodId,
    retiredAt: 500,
  });

  assert.equal(plan.anchor.revision, 1);
  assert.equal(plan.anchor.retiredQuestionPeriods.length, 1);
  assert.equal(plan.anchor.retiredQuestionPeriods[0].reason, 'confirmed-retirement');
  assert.equal(plan.questionJournal.revision, questionJournal.revision + 1);
  assert.equal(plan.questionJournal.reservations.find((item) => item.internalQuestionId === 'internal-a').quarantinedAt, 500);
  assert.equal(plan.questionJournal.questions.find((item) => item.internalQuestionId === 'internal-a').quarantinedAt, 500);
  assert.equal(plan.questionJournal.reservations.find((item) => item.internalQuestionId === 'internal-b').quarantinedAt, null);
  assert.equal(plan.questionJournal.questions.find((item) => item.internalQuestionId === 'internal-b').quarantinedAt, null);
  assert.deepEqual(encodeNormalized(plan.checkpoint).bytes, encodeNormalized(checkpoint).bytes);
});

test('retirement converts a target creation with no checkpoint evidence to indeterminate', () => {
  const questionJournal = unretiredQuestionJournal();
  const detail = questionJournal.questions[0];
  const reservation = questionJournal.reservations[0];
  const answers = [{ questionId: detail.questions[0].id, optionIds: ['option-a'], freeText: null }];
  const payloadDigest = createHash('sha256').update(JSON.stringify({
    questionId: detail.questionId, revision: detail.revision, answers,
  }), 'utf8').digest('hex');
  const selectedIntent = {
    deliveryAttemptId: 'attempt-a',
    logicalMessageId: 'logical-a',
    revision: detail.revision,
    payloadDigest,
  };
  const creating = normalizeQuestionJournalV2Local({
    ...questionJournal,
    questions: [{ ...detail, deliveryIntent: selectedIntent, selection: {
      source: 'manual', selectedAt: detail.createdAt + 1,
      answers,
    }, deliveryCreationState: 'creating' }],
    reservations: [{ ...reservation, selectionSource: 'manual', selectedAt: detail.createdAt + 1,
      deliveryIntent: selectedIntent, deliveryCreationState: 'creating' }],
  });
  const plan = planQuestionPeriodRetirement({
    anchor: emptyAnchor(),
    questionJournal: creating,
    checkpoint: emptyCheckpoint(),
    identity: detail.identity,
    periodId: detail.periodId,
    retiredAt: 600,
  });

  assert.equal(plan.questionJournal.reservations[0].deliveryCreationState, 'indeterminate');
  assert.equal(plan.questionJournal.reservations[0].checkpointState, 'unknown');
  assert.equal(plan.questionJournal.questions[0].deliveryCreationState, 'indeterminate');
  assert.equal(plan.questionJournal.reservations[0].quarantinedAt, 600);
});

test('retirement refuses duplicate period markers and prepared questions', () => {
  const questionJournal = unretiredQuestionJournal();
  const detail = questionJournal.questions[0];
  const anchor = {
    ...emptyAnchor(),
    retiredQuestionPeriods: [{ identity: detail.identity, periodId: detail.periodId, retiredAt: 500,
      reason: 'confirmed-retirement' }],
  };

  assert.throws(() => planQuestionPeriodRetirement({
    anchor, questionJournal, checkpoint: emptyCheckpoint(), identity: detail.identity,
    periodId: detail.periodId, retiredAt: 600,
  }));
  assert.throws(() => planQuestionPeriodRetirement({
    anchor: emptyAnchor(),
    questionJournal: normalizeQuestionJournalV2Local({
      ...questionJournal,
      reservations: [{ ...questionJournal.reservations[0], reclamation: {
        operationId: OPERATION_ID, preparedAt: 500, deliveryPresence: 'none', checkpointState: null,
      } }],
    }),
    checkpoint: emptyCheckpoint(), identity: detail.identity, periodId: detail.periodId, retiredAt: 600,
  }));
});
