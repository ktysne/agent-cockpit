'use strict';

const { createQuestionRecord, selectionFor } = require('../../src/server/common-question-kernel');
const { createDelivery, createEmptyLedger } = require('../../src/server/delivery-ledger');
const { normalizeQuestionJournalV2Local } = require('../../src/server/common-question-reclamation-codec');
const { MAX_SOURCE_BYTES } = require('../../src/server/reclamation-capacity-bounds');
const { planMigrationAllowanceRelease } = require('../../src/server/migration-allowance-release');
const { planInitialReclamationMigration } = require('../../src/server/reclamation-migration-plan');
const { planQuestionBodyReclamation } = require('../../src/server/question-body-reclamation');
const { planQuestionPeriodRetirement } = require('../../src/server/question-period-retirement');
const {
  validateReclamationSnapshot,
  validateReclamationStoreWrite,
} = require('../../src/server/reclamation-store-consistency');
const {
  makeDeliveryCapsule,
  makeQuestionCapsule,
} = require('./question-rejection-capsule-fixtures');
const { threeSlotLegacySources } = require('../support/native-migration-allowance-release-harness');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const MIGRATION_ID = '22222222-2222-4222-8222-222222222222';
const COMPACTION_OPERATION_ID = '55555555-5555-4555-8555-555555555555';
const RETIRE_AT = 2_000_000;
const RETENTION_MS = 604_800_000;
const SLOTS = ['checkpoint', 'instructions', 'questions'];
const CAPSULED_QUESTION_IDS = ['internal-1', 'internal-2', 'internal-3', 'internal-4'];

function clone(value) {
  return structuredClone(value);
}

function transformStrings(value, replacements) {
  if (typeof value === 'string') return replacements.get(value) ?? value;
  if (Array.isArray(value)) return value.map((item) => transformStrings(item, replacements));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, transformStrings(item, replacements)]));
  }
  return value;
}

function periodSources(provider, suffix, sourceProvider = provider) {
  const sources = threeSlotLegacySources(sourceProvider);
  const replacements = new Map([
    ['period-1', `period-${suffix}`],
    ['internal-1', `internal-${suffix}`],
    ['execution-1', `execution-${suffix}`],
    ['conversation-1', `conversation-${suffix}`],
    ['launch-1', `launch-${suffix}`],
    ['launch-id', `launch-id-${suffix}`],
    ['run-id', `run-id-${suffix}`],
    ['attempt-id', `attempt-id-${suffix}`],
    ['session-1', `session-${suffix}`],
    ['actor-1', `actor-${suffix}`],
    [`host-${sourceProvider}`, `host-${sourceProvider}-${suffix}`],
    [`home-${sourceProvider}`, `home-${sourceProvider}-${suffix}`],
    ['native-1', `native-${suffix}`],
    ['source-context', `source-context-${suffix}`],
    ['common-question-selection-1', `common-question-selection-${suffix}`],
    ['common-question-internal-1', `common-question-internal-${suffix}`],
    ['attempt-instruction', `attempt-instruction-${suffix}`],
    ['logical-instruction', `logical-instruction-${suffix}`],
  ]);
  return {
    question: transformStrings(sources.question, replacements),
    questions: transformStrings(JSON.parse(sources.questions.toString('utf8')), replacements),
    checkpoint: transformStrings(JSON.parse(sources.checkpoint.toString('utf8')), replacements),
  };
}

function launchFromCheckpoint(checkpoint) {
  const launch = checkpoint.registrations.launches[0];
  const runtimeLaunch = checkpoint.registrations.runtimeLaunches[0];
  return {
    ...clone(launch.claims),
    launchRef: launch.launchRef,
    state: launch.state,
    identity: clone(launch.identity),
    executionBinding: clone(launch.executionBinding),
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
    currentOwner: clone(runtimeLaunch.currentOwner),
    ownerGeneration: runtimeLaunch.ownerGeneration,
  };
}

function addQuestion(template, index, selected) {
  const createdAt = 10_000 + index * 1_000;
  const questionId = `question-${index}`;
  const record = createQuestionRecord({
    internalQuestionId: `internal-${index}`,
    questionId: `public-${index}`,
    identity: clone(template.identity),
    periodId: template.periodId,
    executionId: template.executionId,
    conversationId: template.conversationId,
    launchRef: template.launchRef,
    executionBinding: clone(template.executionBinding),
    category: template.category,
    questions: [
      { ...clone(template.questions[0]), id: questionId },
    ],
    timeoutMinutes: template.timeoutMinutes,
    createdAt,
  });
  if (!selected) return record;
  return selectionFor(record, [{
    questionId,
    optionIds: ['option-1'],
    freeText: null,
  }], 'manual', createdAt + 1_000, `selection-${index}`).record;
}

function addQuestionDelivery(checkpoint, question, launch) {
  const { deliveryIntent } = question;
  const payload = JSON.stringify({
    questionId: question.questionId,
    revision: deliveryIntent.revision,
    answers: question.selection.answers,
  });
  checkpoint.ledger = createDelivery(checkpoint.ledger, 'question', {
    deliveryAttemptId: deliveryIntent.deliveryAttemptId,
    logicalMessageId: deliveryIntent.logicalMessageId,
    revision: deliveryIntent.revision,
    payload,
  }, launch).ledger;
}

function mergePeriodRegistrations(target, source) {
  const fields = [
    'conversations', 'executions', 'launches', 'runtimeLaunches', 'actors', 'handoffs', 'replayClaims',
    'connections', 'incompleteConversationIds',
  ];
  for (const field of fields) target.registrations[field].push(...clone(source.registrations[field]));
}

function makeRepresentation(snapshot, normalByteLimitsBySlot) {
  const reservationsById = new Map(snapshot.stores.questions.reservations.map((row) =>
    [row.internalQuestionId, row]));
  const deliveriesByAttempt = new Map(snapshot.stores.checkpoint.ledger.deliveries.map((row) =>
    [row.deliveryAttemptId, row]));
  const pairs = CAPSULED_QUESTION_IDS.map((internalQuestionId) => {
    const reservation = reservationsById.get(internalQuestionId);
    if (!reservation || reservation.bodyState !== 'reclaimed') throw new TypeError('invalid_whole_capsule_fixture');
    const delivery = reservation.reclamation.deliveryPresence === 'checkpoint'
      ? deliveriesByAttempt.get(reservation.deliveryIntent.deliveryAttemptId)
      : null;
    const metadata = {
      storeId: snapshot.stores.questions.storeId,
      compactionOperationId: COMPACTION_OPERATION_ID,
      identity: clone(reservation.identity),
      periodId: reservation.periodId,
    };
    return {
      questionCapsule: makeQuestionCapsule([clone(reservation)], metadata),
      checkpointCapsule: delivery === null ? null : makeDeliveryCapsule([clone(delivery)], metadata),
    };
  });
  const capsuleQuestionIds = new Set(CAPSULED_QUESTION_IDS);
  const capsuleAttemptIds = new Set(pairs.flatMap((pair) => pair.checkpointCapsule?.deliveries ?? [])
    .map((delivery) => delivery.deliveryAttemptId));
  const ordinaryStores = clone(snapshot.stores);
  ordinaryStores.questions.reservations = ordinaryStores.questions.reservations.filter((reservation) =>
    !capsuleQuestionIds.has(reservation.internalQuestionId));
  ordinaryStores.checkpoint.ledger.deliveries = ordinaryStores.checkpoint.ledger.deliveries.filter((delivery) =>
    !capsuleAttemptIds.has(delivery.deliveryAttemptId));

  return {
    formatVersion: 1,
    anchor: clone(snapshot.anchor),
    ordinaryStores,
    capsulePairs: pairs,
    deliveryAttemptOrder: snapshot.stores.checkpoint.ledger.deliveries.map((delivery) => delivery.deliveryAttemptId),
    questionReservationOrder: snapshot.stores.questions.reservations.map((reservation) =>
      reservation.internalQuestionId),
    normalByteLimitsBySlot: clone(normalByteLimitsBySlot),
  };
}

function createQuestionCapsuleWholeValidationFixture({
  provider = 'claude',
  ordinaryQuestionSelected = false,
  secondaryProvider = null,
} = {}) {
  if (!['claude', 'codex'].includes(provider) ||
      (secondaryProvider !== null && (!['claude', 'codex'].includes(secondaryProvider) ||
        secondaryProvider === provider))) {
    throw new TypeError('invalid_whole_capsule_fixture');
  }
  const sources = threeSlotLegacySources(provider);
  const baseQuestion = clone(sources.question);
  const questionSource = JSON.parse(sources.questions.toString('utf8'));
  const firstCheckpoint = JSON.parse(sources.checkpoint.toString('utf8'));
  const nextPeriod = periodSources(provider, '2', secondaryProvider ?? provider);
  const secondCheckpoint = nextPeriod.checkpoint;
  const secondPeriodQuestion = addQuestion(nextPeriod.question, 2, true);
  nextPeriod.questions.questions = [secondPeriodQuestion];
  secondCheckpoint.ledger = createEmptyLedger();
  addQuestionDelivery(secondCheckpoint, secondPeriodQuestion, launchFromCheckpoint(secondCheckpoint));
  mergePeriodRegistrations(firstCheckpoint, secondCheckpoint);
  firstCheckpoint.ledger.deliveries.push(...clone(secondCheckpoint.ledger.deliveries));
  firstCheckpoint.ledger.logicalTombstones.push(...clone(secondCheckpoint.ledger.logicalTombstones));
  questionSource.questions.push(...clone(nextPeriod.questions.questions));

  const secondAttemptId = secondPeriodQuestion.deliveryIntent.deliveryAttemptId;
  firstCheckpoint.ledger.deliveries = firstCheckpoint.ledger.deliveries.filter((delivery) =>
    delivery.deliveryAttemptId !== secondAttemptId);
  firstCheckpoint.ledger.logicalTombstones = firstCheckpoint.ledger.logicalTombstones.filter((tombstone) =>
    tombstone.logicalMessageId !== secondPeriodQuestion.deliveryIntent.logicalMessageId ||
    tombstone.sourceExecutionId !== secondPeriodQuestion.periodId);

  const checkpointLaunch = launchFromCheckpoint(firstCheckpoint);
  const secondSelected = addQuestion(baseQuestion, 3, true);
  addQuestionDelivery(firstCheckpoint, secondSelected, checkpointLaunch);
  const noDeliverySelected = addQuestion(baseQuestion, 4, true);
  let ordinaryQuestion = addQuestion(baseQuestion, 5, false);
  if (ordinaryQuestionSelected) {
    const activePeriod = periodSources(provider, '3');
    mergePeriodRegistrations(firstCheckpoint, activePeriod.checkpoint);
    ordinaryQuestion = addQuestion(activePeriod.question, 5, true);
    addQuestionDelivery(firstCheckpoint, ordinaryQuestion, launchFromCheckpoint(activePeriod.checkpoint));
  }
  questionSource.questions.push(secondSelected, noDeliverySelected, ordinaryQuestion);

  const sourceBytesBySlot = {
    checkpoint: Buffer.from(JSON.stringify(firstCheckpoint), 'utf8'),
    instructions: sources.instructions,
    questions: Buffer.from(JSON.stringify(questionSource), 'utf8'),
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

  let anchor = clone(migration.anchor);
  anchor.revision += 1;
  anchor.retiredQuestionPeriods = [];
  anchor.migration = null;
  let stores = clone(migration.stores);
  for (const detail of stores.questions.questions) detail.quarantinedAt = null;
  for (const reservation of stores.questions.reservations) reservation.quarantinedAt = null;
  for (const reservation of stores.questions.reservations) {
    if (reservation.internalQuestionId === 'internal-4') {
      reservation.deliveryCreationState = 'not_created';
      reservation.checkpointState = null;
      reservation.sourceClaimsDigest = null;
      reservation.sessionId = null;
      reservation.terminalResultKind = null;
      stores.questions.questions.find((detail) => detail.internalQuestionId === reservation.internalQuestionId)
        .deliveryCreationState = 'not_created';
    }
  }
  stores.questions = normalizeQuestionJournalV2Local(stores.questions);
  const normalByteLimitsBySlot = Object.fromEntries(SLOTS.map((slot) => [slot, MAX_SOURCE_BYTES]));

  for (const { periodId, identity } of [
    { periodId: 'period-1', identity: baseQuestion.identity },
    { periodId: 'period-2', identity: nextPeriod.question.identity },
  ]) {
    const retirement = planQuestionPeriodRetirement({
      anchor,
      questionJournal: stores.questions,
      checkpoint: stores.checkpoint,
      identity,
      periodId,
      retiredAt: RETIRE_AT,
    });
    anchor = retirement.anchor;
    stores = {
      questions: retirement.questionJournal,
      checkpoint: retirement.checkpoint,
      instructions: stores.instructions,
    };
  }

  for (const [index, internalQuestionId] of CAPSULED_QUESTION_IDS.entries()) {
    const reclaimed = planQuestionBodyReclamation({
      anchor,
      stores,
      normalByteLimitsBySlot,
      internalQuestionId,
      now: RETIRE_AT + RETENTION_MS + 100,
      operationId: `33333333-3333-4333-8333-33333333333${index + 1}`,
    });
    if (reclaimed.status !== 'planned') throw new TypeError('invalid_whole_capsule_fixture');
    const snapshot = reclaimed.steps.at(-1).snapshot;
    anchor = snapshot.anchor;
    stores = snapshot.stores;
  }

  let releasedSnapshot = { anchor, stores };
  const sourceGrants = {
    questions: clone(releasedSnapshot.stores.questions.migrationAllowance),
    checkpoint: clone(releasedSnapshot.stores.checkpoint.migrationAllowance),
  };
  for (const slot of ['questions', 'checkpoint']) {
    const release = planMigrationAllowanceRelease({
      anchor: releasedSnapshot.anchor,
      stores: releasedSnapshot.stores,
      normalByteLimitsBySlot,
      slot,
    });
    if (release.status !== 'released') throw new TypeError('invalid_whole_capsule_fixture');
    releasedSnapshot = release.snapshot;
  }

  const snapshot = releasedSnapshot;
  const legacyOracle = validateReclamationSnapshot(snapshot);
  if (legacyOracle.status !== 'ready' || legacyOracle.reasons.length !== 0) {
    throw new TypeError('invalid_whole_capsule_fixture');
  }
  const storeWriteOracle = validateReclamationStoreWrite({
    anchor: snapshot.anchor,
    previousStores: snapshot.stores,
    nextStores: snapshot.stores,
    normalByteLimitsBySlot,
  });
  if (storeWriteOracle.status !== 'checked' || storeWriteOracle.reasons.length !== 0) {
    throw new TypeError('invalid_whole_capsule_fixture');
  }

  return {
    input: makeRepresentation(snapshot, normalByteLimitsBySlot),
    snapshot,
    counts: {
      capsulePairs: 4,
      checkpointCapsules: 2,
      ordinaryQuestionReservations: 1,
      capsuleQuestionReservations: 4,
      questionReservations: 5,
      ordinaryDeliveries: ordinaryQuestionSelected ? 2 : 1,
      capsuleDeliveries: 2,
      deliveries: ordinaryQuestionSelected ? 4 : 3,
    },
    capsuleQuestionIds: [...CAPSULED_QUESTION_IDS],
    normalByteLimitsBySlot,
    sourceGrants,
  };
}

module.exports = { createQuestionCapsuleWholeValidationFixture };
