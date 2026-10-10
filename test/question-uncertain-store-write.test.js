'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { normalizeQuestionJournalV2Local } = require('../src/server/common-question-reclamation-codec');
const { normalizeInstructionJournalV2Local } = require('../src/server/delivery-reclamation-codec');
const { MAX_SOURCE_BYTES } = require('../src/server/reclamation-capacity-bounds');
const { planInitialReclamationMigration } = require('../src/server/reclamation-migration-plan');
const { planInstructionBodyReclamation } = require('../src/server/instruction-body-reclamation');
const { planQuestionBodyReclamation } = require('../src/server/question-body-reclamation');
const { planQuestionPeriodRetirement } = require('../src/server/question-period-retirement');
const { transitionDelivery } = require('../src/server/delivery-ledger');
const { threeSlotLegacySources } = require('./support/native-migration-allowance-release-harness');
const { validateQuestionUncertainStoreWrite } = require('../src/server/question-uncertain-store-write');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const RETENTION_MS = 604_800_000;
const STORE_FIELDS = ['questions', 'checkpoint', 'instructions'];

function fixture({ active = false, questionState = 'available', instructionState = 'available' } = {}) {
  const legacy = { ...threeSlotLegacySources('claude') };
  const legacyCheckpoint = JSON.parse(legacy.checkpoint.toString('utf8'));
  for (const [kind, state] of [['question', questionState], ['instruction', instructionState]]) {
    if (state === 'available') continue;
    const delivery = legacyCheckpoint.ledger.deliveries.find((row) => row.kind === kind);
    let ledger = legacyCheckpoint.ledger;
    if (state === 'claimed') {
      ledger = transitionDelivery(ledger, delivery.deliveryAttemptId, 'claim').ledger;
    } else if (state === 'applied' && kind === 'instruction') {
      ledger = transitionDelivery(ledger, delivery.deliveryAttemptId, 'claim').ledger;
      ledger = transitionDelivery(ledger, delivery.deliveryAttemptId, 'sendStart').ledger;
      const sending = ledger.deliveries.find((row) => row.deliveryAttemptId === delivery.deliveryAttemptId);
      ledger = transitionDelivery(ledger, delivery.deliveryAttemptId, 'applied', {
        deliveryAttemptId: sending.deliveryAttemptId,
        revision: sending.revision,
        payloadDigest: sending.payloadDigest,
        targetPeriodId: sending.target.periodId,
        nativeTurnId: 'turn-instruction-fixture',
        nativeItemId: 'item-instruction-fixture',
        clientRequestId: delivery.deliveryAttemptId,
      }).ledger;
    } else {
      throw new TypeError('unsupported fixture state');
    }
    legacyCheckpoint.ledger = ledger;
  }
  legacy.checkpoint = Buffer.from(JSON.stringify(legacyCheckpoint), 'utf8');
  const sourceBytesBySlot = Object.fromEntries(STORE_FIELDS.map((slot) => [slot, legacy[slot]]));
  const migrationByteLimitsBySlot = Object.fromEntries(STORE_FIELDS.map((slot) => [slot, legacy[slot].length]));
  const planned = planInitialReclamationMigration({
    configuredSlots: STORE_FIELDS,
    sourceBytesBySlot,
    normalByteLimitsBySlot: migrationByteLimitsBySlot,
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: 1_000_000,
  });
  const anchor = structuredClone(planned.anchor);
  anchor.revision += 1;
  anchor.migration = null;
  const stores = structuredClone(planned.stores);
  if (active) {
    anchor.retiredQuestionPeriods = [];
    for (const detail of stores.questions.questions) detail.quarantinedAt = null;
    for (const reservation of stores.questions.reservations) reservation.quarantinedAt = null;
    stores.questions = normalizeQuestionJournalV2Local(stores.questions);
  }
  const normalByteLimitsBySlot = Object.fromEntries(STORE_FIELDS.map((slot) => [slot, MAX_SOURCE_BYTES]));
  return { anchor, stores, normalByteLimitsBySlot };
}

function assertJsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

function inputFor(snapshot, overrides = {}) {
  const previousStores = overrides.previousStores || snapshot.stores;
  const nextStores = overrides.nextStores || snapshot.stores;
  return {
    anchor: overrides.anchor || snapshot.anchor,
    previousStores,
    nextStores,
    questionCandidates: overrides.questionCandidates || [snapshot.stores.questions, snapshot.stores.questions],
    normalByteLimitsBySlot: overrides.normalByteLimitsBySlot || snapshot.normalByteLimitsBySlot,
  };
}

function withQuestionCreationState(journal, state = 'creating') {
  const candidate = structuredClone(journal);
  candidate.revision += 1;
  for (const detail of candidate.questions) {
    if (detail.deliveryIntent !== null) detail.deliveryCreationState = state;
  }
  for (const reservation of candidate.reservations) {
    if (reservation.deliveryIntent === null) continue;
    reservation.deliveryCreationState = state;
    if (state === 'creating') {
      reservation.checkpointState = null;
      reservation.sourceClaimsDigest = null;
      reservation.sessionId = null;
      reservation.terminalResultKind = null;
    }
  }
  return normalizeQuestionJournalV2Local(candidate);
}

function withQuestionCacheState(journal, state) {
  const candidate = structuredClone(journal);
  candidate.revision += 1;
  for (const reservation of candidate.reservations) reservation.checkpointState = state;
  return normalizeQuestionJournalV2Local(candidate);
}

function withQuestionQuarantine(journal, quarantinedAt) {
  const candidate = structuredClone(journal);
  candidate.revision += 1;
  for (const detail of candidate.questions) detail.quarantinedAt = quarantinedAt;
  for (const reservation of candidate.reservations) reservation.quarantinedAt = quarantinedAt;
  return normalizeQuestionJournalV2Local(candidate);
}

function withInstructionCreationState(journal) {
  const candidate = structuredClone(journal);
  candidate.revision -= 1;
  for (const instruction of candidate.instructions) {
    if (instruction.recordType === 'detail') instruction.deliveryCreationState = 'creating';
  }
  return normalizeInstructionJournalV2Local(candidate);
}

function questionRows(checkpoint, field) {
  return checkpoint.ledger[field].filter((record) => record.kind === 'question');
}

test('both question worlds admit question creation and checkpoint-cache reconciliation without returning a question snapshot', () => {
  const active = fixture({ active: true });
  const creating = withQuestionCreationState(active.stores.questions);
  const creationResult = validateQuestionUncertainStoreWrite(inputFor(active, {
    questionCandidates: [active.stores.questions, creating],
  }));
  assert.equal(Object.hasOwn(creationResult.stores, 'questions'), false);
  assert.ok(Object.isFrozen(creationResult));
  assert.ok(Object.isFrozen(creationResult.stores));
  assert.ok(Object.isFrozen(creationResult.stores.checkpoint));
  assertJsonEqual(creationResult.stores.instructions, active.stores.instructions);

  const claimed = fixture({ active: true, questionState: 'claimed' });
  const oldCacheCandidate = withQuestionCacheState(claimed.stores.questions, 'available');
  const claimedSnapshot = { ...claimed, stores: { ...claimed.stores, questions: oldCacheCandidate } };
  const cacheCandidate = claimed.stores.questions;
  const cacheResult = validateQuestionUncertainStoreWrite(inputFor(claimedSnapshot, {
    questionCandidates: [oldCacheCandidate, cacheCandidate],
  }));
  assertJsonEqual(cacheResult.stores.checkpoint, claimed.stores.checkpoint);
  assertJsonEqual(cacheResult.stores.instructions, claimed.stores.instructions);
});

test('both worlds allow the ordinary instruction creation transition from creating to checkpointed', () => {
  const active = fixture({ active: true });
  const rawCreatingInstructions = withInstructionCreationState(active.stores.instructions);
  const previousStores = { ...active.stores, instructions: rawCreatingInstructions };
  const result = validateQuestionUncertainStoreWrite(inputFor(active, {
    previousStores,
    nextStores: active.stores,
    questionCandidates: [active.stores.questions, withQuestionCreationState(active.stores.questions)],
  }));
  assert.equal(result.stores.instructions.instructions[0].deliveryCreationState,
    active.stores.instructions.instructions[0].deliveryCreationState);
  assertJsonEqual(result.stores.checkpoint, active.stores.checkpoint);
});

test('checkpointed, prepared, and body-complete question worlds pass self-transition validation', () => {
  const retired = fixture();
  const checkpointed = validateQuestionUncertainStoreWrite(inputFor(retired));
  assertJsonEqual(checkpointed.stores.checkpoint, retired.stores.checkpoint);

  const planned = planQuestionBodyReclamation({
    anchor: retired.anchor,
    stores: retired.stores,
    normalByteLimitsBySlot: retired.normalByteLimitsBySlot,
    internalQuestionId: 'internal-1',
    now: retired.anchor.retiredQuestionPeriods[0].retiredAt + RETENTION_MS,
    operationId: OPERATION_ID,
  });
  assert.equal(planned.status, 'planned');
  assert.deepEqual(planned.steps.map((step) => step.boundary), ['prepare', 'checkpoint-grave', 'reclaim']);
  for (const step of [planned.steps[0], planned.steps.at(-1)]) {
    const snapshot = { ...retired, stores: step.snapshot.stores };
    const result = validateQuestionUncertainStoreWrite(inputFor(snapshot));
    assertJsonEqual(result.stores.checkpoint, step.snapshot.stores.checkpoint);
    assertJsonEqual(result.stores.instructions, step.snapshot.stores.instructions);
  }
});

test('an instruction detail and its logical tombstone can advance while question checkpoint rows stay fixed', () => {
  const terminal = fixture({ active: true, instructionState: 'applied' });
  const delivery = terminal.stores.checkpoint.ledger.deliveries.find((row) => row.kind === 'instruction');
  assert.equal(delivery.state, 'applied');
  const planned = planInstructionBodyReclamation({
    anchor: terminal.anchor,
    stores: terminal.stores,
    normalByteLimitsBySlot: terminal.normalByteLimitsBySlot,
    deliveryAttemptId: delivery.deliveryAttemptId,
    now: delivery.terminalAt + RETENTION_MS,
    operationId: OPERATION_ID,
  });
  assert.equal(planned.status, 'planned');
  let previousStores = terminal.stores;
  const possibleCreatingQuestion = withQuestionCreationState(terminal.stores.questions);
  for (const step of planned.steps) {
    const nextStores = step.snapshot.stores;
    assertJsonEqual(questionRows(previousStores.checkpoint, 'deliveries'),
      questionRows(nextStores.checkpoint, 'deliveries'));
    assertJsonEqual(questionRows(previousStores.checkpoint, 'logicalTombstones'),
      questionRows(nextStores.checkpoint, 'logicalTombstones'));
    const result = validateQuestionUncertainStoreWrite(inputFor(terminal, {
      previousStores,
      nextStores,
      questionCandidates: [terminal.stores.questions, possibleCreatingQuestion],
    }));
    assertJsonEqual(result.stores.checkpoint, nextStores.checkpoint);
    assertJsonEqual(result.stores.instructions, nextStores.instructions);
    previousStores = nextStores;
  }
  assert.ok(planned.steps.some((step) => step.snapshot.stores.checkpoint.ledger.logicalTombstones
    .some((row) => row.kind === 'instruction')));
});

test('a question retirement reconciliation reason is denied', () => {
  const active = fixture({ active: true });
  const question = active.stores.questions.questions[0];
  const retired = planQuestionPeriodRetirement({
    anchor: active.anchor,
    questionJournal: active.stores.questions,
    checkpoint: active.stores.checkpoint,
    identity: question.identity,
    periodId: question.periodId,
    retiredAt: 2_000_000,
  });
  assert.throws(() => validateQuestionUncertainStoreWrite(inputFor(active, {
    anchor: retired.anchor,
    questionCandidates: [active.stores.questions, retired.questionJournal],
  })), TypeError);
});

test('a question checkpoint grave transition is denied even when its non-question tombstone would be allowed', () => {
  const retired = fixture();
  const planned = planQuestionBodyReclamation({
    anchor: retired.anchor,
    stores: retired.stores,
    normalByteLimitsBySlot: retired.normalByteLimitsBySlot,
    internalQuestionId: 'internal-1',
    now: retired.anchor.retiredQuestionPeriods[0].retiredAt + RETENTION_MS,
    operationId: OPERATION_ID,
  });
  const beforeGrave = planned.steps[0].snapshot.stores;
  const afterGrave = planned.steps[1].snapshot.stores;
  assert.notDeepEqual(questionRows(beforeGrave.checkpoint, 'deliveries'),
    questionRows(afterGrave.checkpoint, 'deliveries'));
  assert.throws(() => validateQuestionUncertainStoreWrite(inputFor(retired, {
    previousStores: beforeGrave,
    nextStores: afterGrave,
    questionCandidates: [beforeGrave.questions, beforeGrave.questions],
  })), TypeError);
});

test('a non-question write is rejected when only one question candidate is valid in the anchor world', () => {
  const active = fixture({ active: true });
  const quarantinedWithoutAnchorRetirement = withQuestionQuarantine(active.stores.questions, 1_500_000);
  assert.throws(() => validateQuestionUncertainStoreWrite(inputFor(active, {
    questionCandidates: [active.stores.questions, quarantinedWithoutAnchorRetirement],
  })), TypeError);
});

test('question migration grants and rosters must match across candidate worlds', () => {
  const active = fixture({ active: true });
  const changedGrant = structuredClone(active.stores.questions);
  changedGrant.revision += 1;
  changedGrant.migrationAllowance = null;
  const changedRoster = structuredClone(active.stores.questions);
  changedRoster.revision += 1;
  changedRoster.migrationAllowance.eligibleQuestionIds = ['another-question'];
  assert.throws(() => validateQuestionUncertainStoreWrite(inputFor(active, {
    questionCandidates: [active.stores.questions, changedGrant],
  })), TypeError);
  assert.throws(() => validateQuestionUncertainStoreWrite(inputFor(active, {
    questionCandidates: [active.stores.questions, changedRoster],
  })), TypeError);
});

test('migration grants and rosters cannot change during a non-question transition', () => {
  const active = fixture({ active: true });
  const changedInstructions = structuredClone(active.stores.instructions);
  changedInstructions.revision += 1;
  changedInstructions.migrationAllowance.eligibleAttemptIds = ['another-attempt'];
  const nextStores = { ...active.stores, instructions: changedInstructions };
  assert.throws(() => validateQuestionUncertainStoreWrite(inputFor(active, { nextStores })), TypeError);
});

test('a question delivery or question logical tombstone cannot change during a non-question transition', () => {
  const active = fixture({ active: true });
  const claimed = fixture({ active: true, questionState: 'claimed' });
  const changedCheckpoint = structuredClone(claimed.stores.checkpoint);
  changedCheckpoint.migrationAllowance = structuredClone(active.stores.checkpoint.migrationAllowance);
  const nextStores = { ...active.stores, checkpoint: changedCheckpoint };
  assert.throws(() => validateQuestionUncertainStoreWrite(inputFor(active, { nextStores })), TypeError);
});

test('anchor transitions, question-less mode, and capacity overage reject', () => {
  const active = fixture({ active: true });
  const extraAnchor = inputFor(active);
  extraAnchor.nextAnchor = structuredClone(active.anchor);
  assert.throws(() => validateQuestionUncertainStoreWrite(extraAnchor), TypeError);

  assert.throws(() => validateQuestionUncertainStoreWrite(inputFor(active, {
    previousStores: { ...active.stores, questions: null },
    nextStores: { ...active.stores, questions: null },
    questionCandidates: [null, null],
  })), TypeError);

  const tooSmall = { ...active.normalByteLimitsBySlot, questions: 1 };
  assert.throws(() => validateQuestionUncertainStoreWrite(inputFor(active, {
    normalByteLimitsBySlot: tooSmall,
  })), TypeError);
});

test('hostile accessors and proxies reject without invoking user code', () => {
  const active = fixture({ active: true });
  let getterCalls = 0;
  const accessor = inputFor(active);
  Object.defineProperty(accessor, 'anchor', {
    enumerable: true,
    get() { getterCalls += 1; throw new Error('getter invoked'); },
  });
  assert.throws(() => validateQuestionUncertainStoreWrite(accessor), TypeError);
  assert.equal(getterCalls, 0);

  let proxyTraps = 0;
  const proxied = new Proxy(inputFor(active), {
    get() { proxyTraps += 1; throw new Error('proxy invoked'); },
    ownKeys() { proxyTraps += 1; throw new Error('proxy invoked'); },
  });
  assert.throws(() => validateQuestionUncertainStoreWrite(proxied), TypeError);
  assert.equal(proxyTraps, 0);
});

test('an unconfigured instruction slot remains null in the validated result', () => {
  const legacy = threeSlotLegacySources('claude');
  const checkpoint = JSON.parse(legacy.checkpoint.toString('utf8'));
  checkpoint.ledger.deliveries = checkpoint.ledger.deliveries.filter((row) => row.kind === 'question');
  checkpoint.ledger.logicalTombstones = checkpoint.ledger.logicalTombstones
    .filter((row) => row.kind === 'question');
  checkpoint.ledger.revision += 1;
  const checkpointBytes = Buffer.from(JSON.stringify(checkpoint), 'utf8');
  const sourceBytesBySlot = { questions: legacy.questions, checkpoint: checkpointBytes };
  const migrationByteLimitsBySlot = {
    questions: legacy.questions.length,
    checkpoint: checkpointBytes.length,
  };
  const planned = planInitialReclamationMigration({
    configuredSlots: ['questions', 'checkpoint'],
    sourceBytesBySlot,
    normalByteLimitsBySlot: migrationByteLimitsBySlot,
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: 1_000_000,
  });
  const anchor = structuredClone(planned.anchor);
  anchor.revision += 1;
  anchor.migration = null;
  const stores = { ...planned.stores, instructions: null };
  const snapshot = {
    anchor,
    stores,
    normalByteLimitsBySlot: { questions: MAX_SOURCE_BYTES, checkpoint: MAX_SOURCE_BYTES, instructions: null },
  };
  const result = validateQuestionUncertainStoreWrite(inputFor(snapshot));
  assert.equal(result.stores.instructions, null);
});
