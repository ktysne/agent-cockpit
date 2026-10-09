'use strict';

const { createQuestionRecord } = require('../../src/server/common-question-kernel');
const { transitionDelivery } = require('../../src/server/delivery-ledger');
const { normalizeQuestionJournalV2Local } = require('../../src/server/common-question-reclamation-codec');
const { MAX_SOURCE_BYTES } = require('../../src/server/reclamation-capacity-bounds');
const { planInitialReclamationMigration } = require('../../src/server/reclamation-migration-plan');
const { planQuestionBodyReclamation } = require('../../src/server/question-body-reclamation');
const { planQuestionPeriodRetirement } = require('../../src/server/question-period-retirement');
const { validateReclamationSnapshot } = require('../../src/server/reclamation-store-consistency');
const { threeSlotLegacySources } = require('../support/native-migration-allowance-release-harness');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const MIGRATION_ID = '22222222-2222-4222-8222-222222222222';
const RECLAMATION_OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const RETIRED_AT = 2_000_000;
const RETENTION_MS = 604_800_000;
const SLOTS = ['checkpoint', 'instructions', 'questions'];
const CHECKPOINT_STATES = new Set([
  'available', 'unknown', 'applied', 'cancelled_before_send', 'superseded_before_send',
]);

function unselectedQuestion(question) {
  return createQuestionRecord({
    internalQuestionId: question.internalQuestionId,
    questionId: question.questionId,
    identity: structuredClone(question.identity),
    periodId: question.periodId,
    executionId: question.executionId,
    conversationId: question.conversationId,
    launchRef: question.launchRef,
    executionBinding: structuredClone(question.executionBinding),
    category: question.category,
    questions: structuredClone(question.questions),
    timeoutMinutes: question.timeoutMinutes,
    createdAt: question.createdAt,
  });
}

function transitionCheckpointDelivery(checkpoint, deliveryAttemptId, state) {
  let ledger = checkpoint.ledger;
  if (state === 'available') return;
  if (state === 'unknown' || state === 'applied') {
    ledger = transitionDelivery(ledger, deliveryAttemptId, 'sendStart').ledger;
    if (state === 'unknown') ledger = transitionDelivery(ledger, deliveryAttemptId, 'unknown').ledger;
    else {
      const delivery = ledger.deliveries.find((item) => item.deliveryAttemptId === deliveryAttemptId);
      ledger = transitionDelivery(ledger, deliveryAttemptId, 'applied', {
        deliveryAttemptId,
        revision: delivery.revision,
        payloadDigest: delivery.payloadDigest,
        targetPeriodId: delivery.target.periodId,
        nativeTurnId: 'turn-1',
        nativeItemId: 'item-1',
        clientRequestId: deliveryAttemptId,
      }).ledger;
    }
  } else {
    const operation = state === 'cancelled_before_send' ? 'cancel' : 'supersede';
    ledger = transitionDelivery(ledger, deliveryAttemptId, operation).ledger;
  }
  checkpoint.ledger = ledger;
}

function createReclaimedQuestionPairFixture(options = {}) {
  const provider = options.provider ?? 'claude';
  const presence = options.presence ?? 'checkpoint';
  const state = options.state ?? (presence === 'checkpoint' ? 'available' : null);
  const selected = options.selected ?? true;
  if (!['claude', 'codex'].includes(provider) || typeof selected !== 'boolean' ||
      !['checkpoint', 'none', 'indeterminate'].includes(presence) ||
      presence === 'checkpoint' && !CHECKPOINT_STATES.has(state) ||
      presence !== 'checkpoint' && state !== null || presence !== 'none' && !selected) {
    throw new TypeError('invalid_reclaimed_question_pair_fixture');
  }

  const sources = threeSlotLegacySources(provider);
  const question = selected ? sources.question : unselectedQuestion(sources.question);
  const legacyQuestions = JSON.parse(sources.questions.toString('utf8'));
  legacyQuestions.questions[0] = question;

  const checkpoint = JSON.parse(sources.checkpoint.toString('utf8'));
  if (presence === 'checkpoint') {
    transitionCheckpointDelivery(checkpoint, question.deliveryIntent.deliveryAttemptId, state);
  } else {
    checkpoint.ledger.deliveries = checkpoint.ledger.deliveries.filter((delivery) =>
      delivery.deliveryAttemptId !== sources.question.deliveryIntent.deliveryAttemptId);
    checkpoint.ledger.logicalTombstones = checkpoint.ledger.logicalTombstones.filter((tombstone) =>
      tombstone.kind !== 'question' || tombstone.logicalMessageId !== sources.question.deliveryIntent.logicalMessageId ||
      tombstone.revision !== sources.question.deliveryIntent.revision);
  }

  const sourceBytesBySlot = {
    checkpoint: Buffer.from(JSON.stringify(checkpoint), 'utf8'),
    instructions: sources.instructions,
    questions: Buffer.from(JSON.stringify(legacyQuestions), 'utf8'),
  };
  const migration = planInitialReclamationMigration({
    configuredSlots: SLOTS,
    sourceBytesBySlot,
    normalByteLimitsBySlot: Object.fromEntries(SLOTS.map((slot) =>
      [slot, sourceBytesBySlot[slot].byteLength])),
    storeId: STORE_ID,
    operationId: MIGRATION_ID,
    startedAt: 1_000_000,
  });

  const anchor = structuredClone(migration.anchor);
  anchor.revision += 1;
  anchor.retiredQuestionPeriods = [];
  anchor.migration = null;
  const stores = structuredClone(migration.stores);
  for (const detail of stores.questions.questions) detail.quarantinedAt = null;
  for (const reservation of stores.questions.reservations) {
    reservation.quarantinedAt = null;
    if (presence === 'none' && selected && reservation.internalQuestionId === question.internalQuestionId) {
      reservation.deliveryCreationState = 'not_created';
      reservation.checkpointState = null;
      reservation.sourceClaimsDigest = null;
      reservation.sessionId = null;
      reservation.terminalResultKind = null;
    }
  }
  if (presence === 'none' && selected) {
    const detail = stores.questions.questions.find((item) => item.internalQuestionId === question.internalQuestionId);
    detail.deliveryCreationState = 'not_created';
  }
  stores.questions = normalizeQuestionJournalV2Local(stores.questions);

  const normalByteLimitsBySlot = Object.fromEntries(SLOTS.map((slot) => [slot, MAX_SOURCE_BYTES]));
  const retirement = planQuestionPeriodRetirement({
    anchor,
    questionJournal: stores.questions,
    checkpoint: stores.checkpoint,
    identity: question.identity,
    periodId: question.periodId,
    retiredAt: RETIRED_AT,
  });
  const retiredStores = {
    questions: retirement.questionJournal,
    checkpoint: retirement.checkpoint,
    instructions: stores.instructions,
  };
  const reclamation = planQuestionBodyReclamation({
    anchor: retirement.anchor,
    stores: retiredStores,
    normalByteLimitsBySlot,
    internalQuestionId: question.internalQuestionId,
    now: RETIRED_AT + RETENTION_MS + 100,
    operationId: RECLAMATION_OPERATION_ID,
  });
  if (reclamation.status !== 'planned') throw new TypeError('reclaimed_question_pair_fixture_failed');

  const snapshot = reclamation.steps.at(-1).snapshot;
  if (validateReclamationSnapshot(snapshot).status !== 'ready') {
    throw new TypeError('reclaimed_question_pair_fixture_invalid_snapshot');
  }
  const reservation = snapshot.stores.questions.reservations.find((item) =>
    item.internalQuestionId === question.internalQuestionId);
  const deliveryAttemptId = reservation.deliveryIntent?.deliveryAttemptId;
  const delivery = deliveryAttemptId === undefined ? null :
    snapshot.stores.checkpoint.ledger.deliveries.find((item) => item.deliveryAttemptId === deliveryAttemptId) ?? null;

  return { reservation, delivery, snapshot, normalByteLimitsBySlot };
}

module.exports = { createReclaimedQuestionPairFixture };
