'use strict';

const {
  assertIdentifier,
  assertSafeUnsignedInteger,
  assertUuidV4,
  captureExactRecord,
} = require('./reclamation-codec-primitives');
const {
  normalizeCheckpointV3Local,
  normalizeDeliveryRecordV2Local,
  normalizeInstructionJournalV2Local,
} = require('./delivery-reclamation-codec');
const { validateReclamationStoreWrite } = require('./reclamation-store-consistency');
const { projectInstructionDeliveryReferences } = require('./instruction-reclamation-correlation');

const TERMINAL_RETENTION_MS = 604_800_000;
const STORE_FIELDS = ['questions', 'checkpoint', 'instructions'];
const JOURNAL_FIELDS = [
  'recordType', 'deliveryAttemptId', 'launchRef', 'logicalMessageId', 'revision', 'source', 'envelope',
  'envelopeDigest', 'nativeContentDigest', 'createdAt', 'deliveryCreationState', 'reclamation',
];
const RECLAIMED_FIELDS = [
  'recordType', 'deliveryAttemptId', 'launchRef', 'logicalMessageId', 'revision', 'source',
  'envelopeDigest', 'nativeContentDigest', 'createdAt', 'deliveryCreationState', 'reclamation', 'reclaimedAt',
];
const TERMINAL_STATES = new Set(['applied', 'cancelled_before_send', 'superseded_before_send']);
const ALLOWED_RECONCILIATION_REASONS = new Set([
  'instruction_creation_state', 'question_creation_state', 'question_checkpoint_cache',
]);
const REQUIRED_INPUT_FIELDS = [
  'anchor', 'stores', 'normalByteLimitsBySlot', 'deliveryAttemptId', 'now',
];
const INVALID_PLAN = 'invalid_instruction_body_reclamation';

function fail() {
  const error = new TypeError(INVALID_PLAN);
  error.code = INVALID_PLAN;
  throw error;
}

function makeRecord(entries) {
  const result = Object.create(null);
  for (const [key, value] of entries) {
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function makeArray(values) {
  const result = new Array(values.length);
  for (let index = 0; index < values.length; index += 1) {
    Object.defineProperty(result, String(index), {
      value: values[index],
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return result;
}

function captureInput(value) {
  let keys;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) fail();
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) fail();
    keys = Reflect.ownKeys(value);
  } catch {
    fail();
  }
  const hasOperationId = keys.includes('operationId');
  const fields = hasOperationId ? [...REQUIRED_INPUT_FIELDS, 'operationId'] : REQUIRED_INPUT_FIELDS;
  return captureExactRecord(value, fields, INVALID_PLAN);
}

function captureLimits(value, stores) {
  const limits = captureExactRecord(value, STORE_FIELDS, INVALID_PLAN);
  for (const slot of STORE_FIELDS) {
    if (stores[slot] === null) {
      if (limits[slot] !== null) fail();
    } else if (!Number.isSafeInteger(limits[slot]) || limits[slot] < 1 || limits[slot] > 16_777_216) {
      fail();
    }
  }
  return limits;
}

function nextRevision(value) {
  assertSafeUnsignedInteger(value, INVALID_PLAN);
  if (value >= Number.MAX_SAFE_INTEGER) fail();
  return value + 1;
}

function checkedDeadline(value) {
  assertSafeUnsignedInteger(value, INVALID_PLAN);
  return value > Number.MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS
    ? null
    : value + TERMINAL_RETENTION_MS;
}

function locateAttempt(snapshot, deliveryAttemptId) {
  const journal = snapshot.stores.instructions;
  if (journal === null) fail();
  let instruction = null;
  for (const record of journal.instructions) {
    if (record.deliveryAttemptId === deliveryAttemptId) instruction = record;
  }
  if (instruction === null) fail();

  let delivery = null;
  const checkpoint = snapshot.stores.checkpoint;
  if (checkpoint !== null) {
    for (const record of checkpoint.ledger.deliveries) {
      if (record.deliveryAttemptId === deliveryAttemptId) delivery = record;
    }
  }
  return { journal, instruction, delivery };
}

function validateBoundary(previousSnapshot, nextStores, limits) {
  let transition;
  try {
    transition = validateReclamationStoreWrite({
      anchor: previousSnapshot.anchor,
      previousStores: previousSnapshot.stores,
      nextStores,
      normalByteLimitsBySlot: limits,
    });
  } catch {
    fail();
  }
  if (transition.reasons.some((reason) => !ALLOWED_RECONCILIATION_REASONS.has(reason))) fail();
  return transition.snapshot.stores;
}

function validateInitialSnapshot(anchor, stores, limits) {
  let transition;
  try {
    transition = validateReclamationStoreWrite({
      anchor,
      previousStores: stores,
      nextStores: stores,
      normalByteLimitsBySlot: limits,
    });
  } catch {
    fail();
  }
  if (transition.reasons.some((reason) => !ALLOWED_RECONCILIATION_REASONS.has(reason))) fail();
  return transition.snapshot;
}

function snapshot(anchor, stores) {
  return makeRecord([['anchor', anchor], ['stores', stores]]);
}

function planResult(status, current, deadlineAt, deferredReason, operationId = null, steps = []) {
  return makeRecord([
    ['status', status],
    ['operationId', operationId],
    ['deadlineAt', deadlineAt],
    ['deferredReason', deferredReason],
    ['snapshot', current],
    ['steps', makeArray(steps)],
  ]);
}

function defer(current, deadlineAt, reason, operationId = null) {
  return planResult('deferred', current, deadlineAt, reason, operationId);
}

function preparation(operationId, preparedAt, terminalState, terminalAt) {
  return makeRecord([
    ['operationId', operationId],
    ['preparedAt', preparedAt],
    ['terminalState', terminalState],
    ['terminalAt', terminalAt],
  ]);
}

function prepareStep(current, limits, row, operationId, preparedAt) {
  const records = row.journal.instructions.map((record) => record.deliveryAttemptId === row.instruction.deliveryAttemptId
    ? makeRecord(JOURNAL_FIELDS.map((field) => [field,
      field === 'reclamation'
        ? preparation(operationId, preparedAt, row.delivery.state, row.delivery.terminalAt)
        : record[field]]))
    : record);
  const journal = normalizeInstructionJournalV2Local(makeRecord([
    ['schemaVersion', row.journal.schemaVersion],
    ['revision', nextRevision(row.journal.revision)],
    ['storeId', row.journal.storeId],
    ['migrationAllowance', row.journal.migrationAllowance],
    ['instructions', makeArray(records)],
  ]));
  const stores = makeRecord(STORE_FIELDS.map((field) => [field, field === 'instructions' ? journal : current.stores[field]]));
  return {
    boundary: 'prepare',
    slot: 'instructions',
    snapshot: snapshot(current.anchor, validateBoundary(current, stores, limits)),
  };
}

function deliveryGrave(delivery, operationId, reclaimedAt) {
  if (delivery.recordType !== 'detail' || delivery.kind !== 'instruction' ||
      !TERMINAL_STATES.has(delivery.state)) fail();
  const refs = projectInstructionDeliveryReferences(delivery.source);
  return normalizeDeliveryRecordV2Local(makeRecord([
    ['recordType', 'reclaimed'],
    ['deliveryAttemptId', delivery.deliveryAttemptId],
    ['kind', delivery.kind],
    ['logicalMessageId', delivery.logicalMessageId],
    ['revision', delivery.revision],
    ['sourceExecutionId', delivery.sourceExecutionId],
    ['payloadDigest', delivery.payloadDigest],
    ['state', delivery.state],
    ['terminalAt', delivery.terminalAt],
    ['cancelRequested', delivery.cancelRequested],
    ['ownerGeneration', delivery.ownerGeneration],
    ['acceptedCorrelation', delivery.acceptedCorrelation],
    ['appliedCorrelation', delivery.appliedCorrelation],
    ['sourceRef', refs.sourceRef],
    ['targetRef', refs.targetRef],
    ['reclamation', makeRecord([
      ['operationId', operationId],
      ['reclaimedAt', reclaimedAt],
      ['reason', 'terminal_retention'],
    ])],
  ]));
}

function graveStep(current, limits, checkpoint, delivery, operationId, reclaimedAt) {
  const grave = deliveryGrave(delivery, operationId, reclaimedAt);
  const deliveries = checkpoint.ledger.deliveries.map((record) =>
    record.deliveryAttemptId === delivery.deliveryAttemptId ? grave : record);
  const ledger = makeRecord([
    ['schemaVersion', checkpoint.ledger.schemaVersion],
    ['revision', nextRevision(checkpoint.ledger.revision)],
    ['deliveries', makeArray(deliveries)],
    ['notificationTargets', checkpoint.ledger.notificationTargets],
    ['logicalTombstones', checkpoint.ledger.logicalTombstones],
  ]);
  const nextCheckpoint = normalizeCheckpointV3Local(makeRecord([
    ['schemaVersion', checkpoint.schemaVersion],
    ['storeId', checkpoint.storeId],
    ['revision', nextRevision(checkpoint.revision)],
    ['registrations', checkpoint.registrations],
    ['ledger', ledger],
    ['migrationAllowance', checkpoint.migrationAllowance],
  ]));
  const stores = makeRecord(STORE_FIELDS.map((field) => [field, field === 'checkpoint' ? nextCheckpoint : current.stores[field]]));
  return {
    boundary: 'checkpoint-grave',
    slot: 'checkpoint',
    snapshot: snapshot(current.anchor, validateBoundary(current, stores, limits)),
  };
}

function reclaimStep(current, limits, row, reclaimedAt) {
  const records = row.journal.instructions.map((record) => {
    if (record.deliveryAttemptId !== row.instruction.deliveryAttemptId) return record;
    const preparationValue = record.reclamation;
    if (preparationValue === null) fail();
    return makeRecord(RECLAIMED_FIELDS.map((field) => [field,
      field === 'recordType' ? 'reclaimed'
        : field === 'reclaimedAt' ? reclaimedAt
          : record[field]]));
  });
  const journal = normalizeInstructionJournalV2Local(makeRecord([
    ['schemaVersion', row.journal.schemaVersion],
    ['revision', nextRevision(row.journal.revision)],
    ['storeId', row.journal.storeId],
    ['migrationAllowance', row.journal.migrationAllowance],
    ['instructions', makeArray(records)],
  ]));
  const stores = makeRecord(STORE_FIELDS.map((field) => [field, field === 'instructions' ? journal : current.stores[field]]));
  return {
    boundary: 'reclaim',
    slot: 'instructions',
    snapshot: snapshot(current.anchor, validateBoundary(current, stores, limits)),
  };
}

function planInstructionBodyReclamation(inputValue) {
  try {
    return planInstructionBodyReclamationInternal(inputValue);
  } catch (error) {
    if (error instanceof TypeError && error.message !== INVALID_PLAN) fail();
    throw error;
  }
}

function planInstructionBodyReclamationInternal(value) {
  const input = captureInput(value);
  assertIdentifier(input.deliveryAttemptId, INVALID_PLAN);
  assertSafeUnsignedInteger(input.now, INVALID_PLAN);
  if (Object.hasOwn(input, 'operationId')) assertUuidV4(input.operationId, INVALID_PLAN);

  const stores = captureExactRecord(input.stores, STORE_FIELDS, INVALID_PLAN);
  const limits = captureLimits(input.normalByteLimitsBySlot, stores);
  const current = validateInitialSnapshot(input.anchor, stores, limits);
  let row = locateAttempt(current, input.deliveryAttemptId);
  const instruction = row.instruction;
  const preparationValue = instruction.reclamation;
  let deadlineAt = null;
  let operationId = null;

  if (preparationValue !== null) {
    operationId = preparationValue.operationId;
    if (Object.hasOwn(input, 'operationId') && input.operationId !== operationId) fail();
    deadlineAt = checkedDeadline(preparationValue.terminalAt);
    if (deadlineAt === null) return defer(current, null, 'retention_deadline_overflow', operationId);
    if (instruction.recordType === 'reclaimed') {
      return planResult('complete', current, deadlineAt, null, operationId);
    }
    if (input.now < preparationValue.terminalAt) {
      return defer(current, deadlineAt, 'clock_before_terminal_at', operationId);
    }
    if (input.now < preparationValue.preparedAt) {
      return defer(current, deadlineAt, 'clock_before_prepared_at', operationId);
    }
  } else {
    if (instruction.recordType !== 'detail' || instruction.deliveryCreationState !== 'checkpointed' ||
        row.delivery === null || row.delivery.recordType !== 'detail' ||
        !TERMINAL_STATES.has(row.delivery.state)) {
      return defer(current, null, 'not_reclaimable');
    }
    deadlineAt = checkedDeadline(row.delivery.terminalAt);
    if (deadlineAt === null) return defer(current, null, 'retention_deadline_overflow');
    if (input.now < row.delivery.terminalAt) return defer(current, deadlineAt, 'clock_before_terminal_at');
    if (input.now < deadlineAt) return defer(current, deadlineAt, 'retention_not_elapsed');
    if (!Object.hasOwn(input, 'operationId')) return planResult('eligible', current, deadlineAt, null);
    operationId = input.operationId;
  }

  const steps = [];
  let cursor = current;
  if (preparationValue === null) {
    const prepared = prepareStep(cursor, limits, row, operationId, input.now);
    steps.push(prepared);
    cursor = prepared.snapshot;
    row = locateAttempt(cursor, input.deliveryAttemptId);
  }

  if (row.delivery?.recordType === 'detail') {
    const checkpoint = cursor.stores.checkpoint;
    const grave = graveStep(cursor, limits, checkpoint, row.delivery, operationId, input.now);
    steps.push(grave);
    cursor = grave.snapshot;
    row = locateAttempt(cursor, input.deliveryAttemptId);
  }
  if (row.delivery?.recordType !== 'reclaimed' ||
      row.delivery.reclamation.operationId !== operationId ||
      row.delivery.reclamation.reason !== 'terminal_retention') fail();

  const reclaimed = reclaimStep(cursor, limits, row, input.now);
  steps.push(reclaimed);
  cursor = reclaimed.snapshot;
  return planResult('planned', cursor, deadlineAt, null, operationId, steps);
}

module.exports = { planInstructionBodyReclamation };
