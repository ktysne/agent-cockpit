'use strict';

const {
  assertIdentifier,
  assertSafeUnsignedInteger,
  assertUuidV4,
  captureExactRecord,
} = require('./reclamation-codec-primitives');
const {
  normalizeCheckpointV3Local,
  normalizeDeliveryLedgerV2Local,
  normalizeDeliveryRecordV2Local,
} = require('./delivery-reclamation-codec');
const { validateReclamationStoreWrite } = require('./reclamation-store-consistency');
const { projectNormalizedDeliveryReferences } = require('./reclamation-delivery-references');

const TERMINAL_RETENTION_MS = 604_800_000;
const MAX_SOURCE_BYTES = 16_777_216;
const STORE_FIELDS = ['questions', 'checkpoint', 'instructions'];
const TERMINAL_STATES = new Set(['applied', 'cancelled_before_send', 'superseded_before_send']);
const RECLAIMABLE_KINDS = new Set(['pr-notification', 'result']);
const ALLOWED_RECONCILIATION_REASONS = new Set([
  'instruction_creation_state', 'question_creation_state', 'question_checkpoint_cache',
]);
const REQUIRED_INPUT_FIELDS = [
  'anchor', 'stores', 'normalByteLimitsBySlot', 'deliveryAttemptId', 'now',
];
const INVALID_PLAN = 'invalid_terminal_delivery_body_reclamation';

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
    } else if (!Number.isSafeInteger(limits[slot]) || limits[slot] < 1 || limits[slot] > MAX_SOURCE_BYTES) {
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

function checkedDeadline(terminalAt) {
  assertSafeUnsignedInteger(terminalAt, INVALID_PLAN);
  return terminalAt > Number.MAX_SAFE_INTEGER - TERMINAL_RETENTION_MS
    ? null
    : terminalAt + TERMINAL_RETENTION_MS;
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

function validateSnapshot(anchor, stores, limits) {
  try {
    const transition = validateReclamationStoreWrite({
      anchor,
      previousStores: stores,
      nextStores: stores,
      normalByteLimitsBySlot: limits,
    });
    if (transition.reasons.some((reason) => !ALLOWED_RECONCILIATION_REASONS.has(reason))) fail();
    return transition;
  } catch {
    fail();
  }
}

function findDelivery(snapshotValue, deliveryAttemptId) {
  const checkpoint = snapshotValue.stores.checkpoint;
  if (checkpoint === null) return null;
  return checkpoint.ledger.deliveries.find((record) => record.deliveryAttemptId === deliveryAttemptId) || null;
}

function deliveryGrave(detail, operationId, reclaimedAt) {
  if (detail.recordType !== 'detail' || !RECLAIMABLE_KINDS.has(detail.kind) ||
      !TERMINAL_STATES.has(detail.state)) fail();
  const refs = projectNormalizedDeliveryReferences(detail);
  return normalizeDeliveryRecordV2Local(makeRecord([
    ['recordType', 'reclaimed'],
    ['deliveryAttemptId', detail.deliveryAttemptId],
    ['kind', detail.kind],
    ['logicalMessageId', detail.logicalMessageId],
    ['revision', detail.revision],
    ['sourceExecutionId', detail.sourceExecutionId],
    ['payloadDigest', detail.payloadDigest],
    ['state', detail.state],
    ['terminalAt', detail.terminalAt],
    ['cancelRequested', detail.cancelRequested],
    ['ownerGeneration', detail.ownerGeneration],
    ['acceptedCorrelation', detail.acceptedCorrelation],
    ['appliedCorrelation', detail.appliedCorrelation],
    ['sourceRef', refs.sourceRef],
    ['targetRef', refs.targetRef],
    ['reclamation', makeRecord([
      ['operationId', operationId],
      ['reclaimedAt', reclaimedAt],
      ['reason', 'terminal_retention'],
    ])],
  ]));
}

function checkpointCandidate(checkpoint, deliveryAttemptId, grave) {
  const deliveries = checkpoint.ledger.deliveries.map((record) =>
    record.deliveryAttemptId === deliveryAttemptId ? grave : record);
  const ledger = normalizeDeliveryLedgerV2Local(makeRecord([
    ['schemaVersion', checkpoint.ledger.schemaVersion],
    ['revision', nextRevision(checkpoint.ledger.revision)],
    ['deliveries', makeArray(deliveries)],
    ['notificationTargets', checkpoint.ledger.notificationTargets],
    ['logicalTombstones', checkpoint.ledger.logicalTombstones],
  ]));
  return normalizeCheckpointV3Local(makeRecord([
    ['schemaVersion', checkpoint.schemaVersion],
    ['storeId', checkpoint.storeId],
    ['revision', nextRevision(checkpoint.revision)],
    ['registrations', checkpoint.registrations],
    ['ledger', ledger],
    ['migrationAllowance', checkpoint.migrationAllowance],
  ]));
}

function planTerminalDeliveryBodyReclamation(inputValue) {
  try {
    return planTerminalDeliveryBodyReclamationInternal(inputValue);
  } catch (error) {
    if (error instanceof TypeError && error.message !== INVALID_PLAN) fail();
    throw error;
  }
}

function planTerminalDeliveryBodyReclamationInternal(value) {
  const input = captureInput(value);
  assertIdentifier(input.deliveryAttemptId, INVALID_PLAN);
  assertSafeUnsignedInteger(input.now, INVALID_PLAN);
  if (Object.hasOwn(input, 'operationId')) assertUuidV4(input.operationId, INVALID_PLAN);

  const stores = captureExactRecord(input.stores, STORE_FIELDS, INVALID_PLAN);
  const limits = captureLimits(input.normalByteLimitsBySlot, stores);
  const initial = validateSnapshot(input.anchor, stores, limits);
  const current = initial.snapshot;
  const delivery = findDelivery(current, input.deliveryAttemptId);
  if (delivery === null || !RECLAIMABLE_KINDS.has(delivery.kind)) {
    return defer(current, null, 'not_reclaimable');
  }
  if (delivery.recordType === 'reclaimed') {
    if (delivery.reclamation.reason !== 'terminal_retention') return defer(current, null, 'not_reclaimable');
    return planResult('complete', current, checkedDeadline(delivery.terminalAt), null,
      delivery.reclamation.operationId);
  }
  if (delivery.recordType !== 'detail' || !TERMINAL_STATES.has(delivery.state)) {
    return defer(current, null, 'not_reclaimable');
  }
  if (input.now < delivery.terminalAt) return defer(current, null, 'clock_before_terminal_at');

  const deadlineAt = checkedDeadline(delivery.terminalAt);
  if (deadlineAt === null) return defer(current, null, 'retention_deadline_overflow');
  if (input.now < deadlineAt) return defer(current, deadlineAt, 'retention_not_elapsed');
  if (!Object.hasOwn(input, 'operationId')) return planResult('eligible', current, deadlineAt, null);

  try {
    const grave = deliveryGrave(delivery, input.operationId, input.now);
    const checkpoint = checkpointCandidate(current.stores.checkpoint, delivery.deliveryAttemptId, grave);
    const nextStores = makeRecord(STORE_FIELDS.map((slot) =>
      [slot, slot === 'checkpoint' ? checkpoint : current.stores[slot]]));
    const transition = validateReclamationStoreWrite({
      anchor: current.anchor,
      previousStores: current.stores,
      nextStores,
      normalByteLimitsBySlot: limits,
    });
    if (transition.reasons.some((reason) => !ALLOWED_RECONCILIATION_REASONS.has(reason))) fail();
    const nextSnapshot = transition.snapshot;
    const step = {
      boundary: 'checkpoint-grave',
      slot: 'checkpoint',
      snapshot: snapshot(nextSnapshot.anchor, nextSnapshot.stores),
    };
    return planResult('planned', step.snapshot, deadlineAt, null, input.operationId, [step]);
  } catch (error) {
    if (error instanceof TypeError && error.message !== INVALID_PLAN) fail();
    throw error;
  }
}

module.exports = { planTerminalDeliveryBodyReclamation };
