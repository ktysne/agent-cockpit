'use strict';

const { encodeNormalized } = require('../../src/server/reclamation-json-codec');
const { createQuestionCapsuleWholeValidationFixture } = require('./question-capsule-whole-validation-fixtures');

const DEFAULT_OPERATION_ID = '77777777-7777-4777-8777-777777777777';
const CHUNK_ID_PREFIX = 'a0000000-0000-4000-8000-';

function clone(value) {
  return structuredClone(value);
}

function scopeKey(identity, periodId) {
  return JSON.stringify([
    identity.provider,
    identity.nativeIdKind,
    identity.hostId,
    identity.homeScopeId,
    identity.nativeId,
    periodId,
  ]);
}

function selectionFor(snapshot, internalQuestionIds) {
  const reservationsById = new Map(snapshot.stores.questions.reservations.map((reservation) =>
    [reservation.internalQuestionId, reservation]));
  const scopesByKey = new Map();
  for (const internalQuestionId of internalQuestionIds) {
    const reservation = reservationsById.get(internalQuestionId);
    if (!reservation) throw new TypeError('invalid_question_capsule_migration_plan_fixture');
    const key = scopeKey(reservation.identity, reservation.periodId);
    let scope = scopesByKey.get(key);
    if (!scope) {
      scope = {
        identity: clone(reservation.identity),
        periodId: reservation.periodId,
        internalQuestionIds: [],
      };
      scopesByKey.set(key, scope);
    }
    scope.internalQuestionIds.push(internalQuestionId);
  }
  return [...scopesByKey.values()];
}

function makeWholeInput(snapshot, normalByteLimitsBySlot) {
  return {
    formatVersion: 1,
    anchor: clone(snapshot.anchor),
    ordinaryStores: clone(snapshot.stores),
    capsulePairs: [],
    deliveryAttemptOrder: snapshot.stores.checkpoint?.ledger.deliveries.map((delivery) =>
      delivery.deliveryAttemptId) ?? [],
    questionReservationOrder: snapshot.stores.questions?.reservations.map((reservation) =>
      reservation.internalQuestionId) ?? [],
    normalByteLimitsBySlot: clone(normalByteLimitsBySlot),
  };
}

function createQuestionCapsuleMigrationPlanFixture(options = {}) {
  const whole = createQuestionCapsuleWholeValidationFixture({
    provider: options.provider,
    secondaryProvider: options.secondaryProvider,
    ordinaryQuestionSelected: options.ordinaryQuestionSelected,
  });
  const snapshot = clone(whole.snapshot);
  const sourceBytes = {
    anchor: encodeNormalized(snapshot.anchor).bytes,
    questions: snapshot.stores.questions === null
      ? null
      : encodeNormalized(snapshot.stores.questions).bytes,
    checkpoint: snapshot.stores.checkpoint === null
      ? null
      : encodeNormalized(snapshot.stores.checkpoint).bytes,
    instructions: snapshot.stores.instructions === null
      ? null
      : encodeNormalized(snapshot.stores.instructions).bytes,
  };
  const normalByteLimitsBySlot = clone(whole.normalByteLimitsBySlot);
  const selectedIds = options.internalQuestionIds ?? whole.capsuleQuestionIds;
  const chunkCount = options.chunkCount ?? 8;
  const chunkIds = Array.from({ length: chunkCount }, (_, index) =>
    `${CHUNK_ID_PREFIX}${String(index + 1).padStart(12, '0')}`);
  const input = {
    sourceBytes,
    normalByteLimitsBySlot,
    selection: options.selection ?? selectionFor(snapshot, selectedIds),
    operationId: options.operationId ?? DEFAULT_OPERATION_ID,
    chunkIds: options.chunkIds ?? chunkIds,
  };
  return {
    input,
    snapshot,
    wholeInput: makeWholeInput(snapshot, normalByteLimitsBySlot),
    sourceGrants: clone(whole.sourceGrants),
  };
}

module.exports = { createQuestionCapsuleMigrationPlanFixture, selectionFor };
