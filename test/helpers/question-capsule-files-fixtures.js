'use strict';

const { createQuestionCapsuleWholeValidationFixture } = require('./question-capsule-whole-validation-fixtures');

const CHUNK_ID_PREFIX = 'a0000000-0000-4000-8000-';

function chunkId(index) {
  return `${CHUNK_ID_PREFIX}${String(index + 1).padStart(12, '0')}`;
}

function clone(value) {
  return structuredClone(value);
}

function createQuestionCapsuleFilesFixture(options = {}) {
  const legacy = createQuestionCapsuleWholeValidationFixture(options);
  const { input: wholeInput, snapshot } = legacy;
  const ordinaryQuestion = wholeInput.ordinaryStores.questions;
  const ordinaryCheckpoint = wholeInput.ordinaryStores.checkpoint;
  const chunkIds = wholeInput.capsulePairs.map((_, index) => chunkId(index));

  const questionFile = ordinaryQuestion === null ? null : {
    schemaVersion: 3,
    storeId: ordinaryQuestion.storeId,
    revision: ordinaryQuestion.revision,
    questions: clone(ordinaryQuestion.questions),
    reservations: clone(ordinaryQuestion.reservations),
    migrationAllowance: clone(ordinaryQuestion.migrationAllowance),
    questionCapsules: wholeInput.capsulePairs.map((pair, index) => ({
      chunkId: chunkIds[index],
      capsule: clone(pair.questionCapsule),
    })),
    reservationOrder: clone(wholeInput.questionReservationOrder),
  };

  const checkpointFile = ordinaryCheckpoint === null ? null : {
    schemaVersion: 4,
    storeId: ordinaryCheckpoint.storeId,
    revision: ordinaryCheckpoint.revision,
    registrations: clone(ordinaryCheckpoint.registrations),
    ledger: clone(ordinaryCheckpoint.ledger),
    migrationAllowance: clone(ordinaryCheckpoint.migrationAllowance),
    checkpointCapsules: wholeInput.capsulePairs.flatMap((pair, index) =>
      pair.checkpointCapsule === null ? [] : [{
        chunkId: chunkIds[index],
        capsule: clone(pair.checkpointCapsule),
      }]),
    deliveryAttemptOrder: clone(wholeInput.deliveryAttemptOrder),
  };

  const input = {
    anchor: clone(wholeInput.anchor),
    questionFile,
    checkpointFile,
    instructionStore: clone(wholeInput.ordinaryStores.instructions),
    normalByteLimitsBySlot: clone(wholeInput.normalByteLimitsBySlot),
  };

  return { input, snapshot, wholeInput, questionFile, checkpointFile };
}

module.exports = { createQuestionCapsuleFilesFixture };
