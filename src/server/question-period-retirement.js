'use strict';

const { captureExactRecord } = require('./reclamation-codec-primitives');
const {
  normalizeQuestionJournalV2Local,
} = require('./common-question-reclamation-codec');
const {
  normalizeCheckpointV3Local,
} = require('./delivery-reclamation-codec');
const {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
} = require('./question-reclamation-anchor-codec');
const { validateQuestionPeriodRetirementInputs } = require('./reclamation-store-consistency');

const REQUIRED_FIELDS = ['anchor', 'questionJournal', 'checkpoint', 'identity', 'periodId', 'retiredAt'];

function retirementError() {
  const error = new Error('invalid_question_period_retirement');
  error.code = 'invalid_question_period_retirement';
  return error;
}

function captureInput(value) {
  let keys;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw retirementError();
    keys = Reflect.ownKeys(value);
  } catch {
    throw retirementError();
  }
  const hasReason = keys.includes('reason');
  const fields = hasReason ? [...REQUIRED_FIELDS, 'reason'] : REQUIRED_FIELDS;
  try { return captureExactRecord(value, fields, 'invalid_question_period_retirement'); } catch {
    throw retirementError();
  }
}

function nextRevision(revision) {
  if (!Number.isSafeInteger(revision) || revision < 0 || revision === Number.MAX_SAFE_INTEGER) {
    throw retirementError();
  }
  return revision + 1;
}

function recordWithChanges(record, changes) {
  const result = Object.create(null);
  for (const key of Object.keys(record)) {
    Object.defineProperty(result, key, {
      value: changes.has(key) ? changes.get(key) : record[key],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function retiredDeliveryState(state) {
  if (state === 'claimed') return 'available';
  if (state === 'sending' || state === 'accepted') return 'unknown';
  return state;
}

function terminalResultKind(state) {
  return state === 'applied' || state === 'cancelled_before_send' || state === 'superseded_before_send'
    ? state
    : null;
}

function normalizeInputRetiredAt(value) {
  if (!Number.isSafeInteger(value) || value < 0) throw retirementError();
  return value;
}

function planQuestionPeriodRetirement(value) {
  const input = captureInput(value);
  const retiredAt = normalizeInputRetiredAt(input.retiredAt);
  const reason = Object.hasOwn(input, 'reason') ? input.reason : 'confirmed-retirement';
  if (reason !== 'confirmed-retirement') throw retirementError();

  const validated = validateQuestionPeriodRetirementInputs({
    anchor: input.anchor,
    questionJournal: input.questionJournal,
    checkpoint: input.checkpoint,
    identity: input.identity,
    periodId: input.periodId,
  });
  const { anchor, questionJournal, checkpoint, identity, periodId, targetRows } = validated;
  const retiredAnchor = normalizeQuestionReclamationAnchorV1Local({
    schemaVersion: 1,
    revision: nextRevision(anchor.revision),
    storeId: anchor.storeId,
    retiredQuestionPeriods: [...anchor.retiredQuestionPeriods, { identity, periodId, retiredAt, reason }],
    migration: null,
  });
  encodeQuestionReclamationAnchorV1Local(retiredAnchor);

  const reservationChanges = new Map();
  const detailChanges = new Map();
  const deliveryStateChanges = new Map();

  for (const row of targetRows) {
    const { reservation, detail, normalizedReservation, delivery } = row;
    const updatedReservation = recordWithChanges(normalizedReservation, new Map([
      ['quarantinedAt', retiredAt],
      ['terminalResultKind', terminalResultKind(normalizedReservation.checkpointState)],
    ]));
    reservationChanges.set(reservation.internalQuestionId, updatedReservation);
    const updatedDetail = recordWithChanges(detail, new Map([
      ['quarantinedAt', retiredAt],
      ['deliveryCreationState', normalizedReservation.deliveryCreationState],
    ]));
    detailChanges.set(detail.internalQuestionId, updatedDetail);

    if (delivery !== null) {
      const state = retiredDeliveryState(delivery.state);
      if (state !== delivery.state) deliveryStateChanges.set(delivery.deliveryAttemptId, state);
      if (updatedReservation.checkpointState !== state ||
          updatedReservation.terminalResultKind !== terminalResultKind(state)) {
        reservationChanges.set(reservation.internalQuestionId, recordWithChanges(updatedReservation, new Map([
          ['checkpointState', state], ['terminalResultKind', terminalResultKind(state)],
        ])));
      }
    }
  }

  let nextQuestionJournal = questionJournal;
  if (reservationChanges.size > 0) {
    nextQuestionJournal = normalizeQuestionJournalV2Local({
      schemaVersion: 2,
      storeId: questionJournal.storeId,
      revision: nextRevision(questionJournal.revision),
      questions: questionJournal.questions.map((detail) => detailChanges.get(detail.internalQuestionId) || detail),
      reservations: questionJournal.reservations.map((reservation) =>
        reservationChanges.get(reservation.internalQuestionId) || reservation),
      migrationAllowance: questionJournal.migrationAllowance,
    });
  }

  let nextCheckpoint = checkpoint;
  if (deliveryStateChanges.size > 0) {
    const deliveries = checkpoint.ledger.deliveries.map((delivery) => {
      const state = deliveryStateChanges.get(delivery.deliveryAttemptId);
      return state === undefined ? delivery : recordWithChanges(delivery, new Map([['state', state]]));
    });
    const ledger = normalizeCheckpointV3Local({
      schemaVersion: 3,
      storeId: checkpoint.storeId,
      revision: nextRevision(checkpoint.revision),
      registrations: checkpoint.registrations,
      ledger: {
        schemaVersion: 2,
        revision: nextRevision(checkpoint.ledger.revision),
        deliveries,
        notificationTargets: checkpoint.ledger.notificationTargets,
        logicalTombstones: checkpoint.ledger.logicalTombstones,
      },
      migrationAllowance: checkpoint.migrationAllowance,
    });
    nextCheckpoint = ledger;
  }

  return Object.freeze({
    anchor: retiredAnchor,
    questionJournal: nextQuestionJournal,
    checkpoint: nextCheckpoint,
  });
}

module.exports = { planQuestionPeriodRetirement };
