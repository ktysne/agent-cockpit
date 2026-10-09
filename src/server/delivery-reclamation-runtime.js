'use strict';

const {
  createDelivery,
  registerPrTarget,
  transitionDelivery,
  validateLedger,
} = require('./delivery-ledger');
const {
  normalizeDeliveryLedgerV2Local,
  normalizeDeliveryRecordV2Local,
} = require('./delivery-reclamation-codec');

const TERMINAL_STATES = new Set(['applied', 'cancelled_before_send', 'superseded_before_send']);

function nextRevision(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= Number.MAX_SAFE_INTEGER) {
    throw runtimeError('delivery_revision_overflow');
  }
  return value + 1;
}

function runtimeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function detailFromV2(record) {
  if (record.recordType !== 'detail') throw runtimeError('delivery_reclaimed');
  const { recordType: _recordType, terminalAt: _terminalAt, ...detail } = record;
  return detail;
}

function logicalKey(record) {
  const target = record.recordType === 'reclaimed' ? record.targetRef : record.target;
  const targetKey = record.kind === 'pr-notification'
    ? record.recordType === 'reclaimed' ? target.launchKey : [
        target.claims.launchId, target.claims.runId, target.claims.attemptId,
      ]
    : null;
  return JSON.stringify([
    record.kind,
    record.kind === 'pr-notification' ? null : record.sourceExecutionId,
    record.logicalMessageId,
    record.revision,
    targetKey,
  ]);
}

function legacyLedgerView(checkpoint) {
  const ledger = checkpoint.ledger;
  const deliveries = ledger.deliveries.filter((record) => record.recordType === 'detail');
  const groups = new Set(deliveries.map(logicalKey));
  return validateLedger({
    schemaVersion: 1,
    revision: ledger.revision,
    deliveries: deliveries.map(detailFromV2),
    notificationTargets: ledger.notificationTargets,
    logicalTombstones: ledger.logicalTombstones.filter((tombstone) => groups.has(JSON.stringify([
      tombstone.kind,
      tombstone.kind === 'pr-notification' ? null : tombstone.sourceExecutionId,
      tombstone.logicalMessageId,
      tombstone.revision,
      tombstone.targetLaunchKey,
    ]))),
  });
}

function v2DetailFromLegacy(record, terminalAt = null) {
  return normalizeDeliveryRecordV2Local({
    recordType: 'detail',
    ...record,
    terminalAt,
  });
}

function ledgerWithDelivery(checkpoint, nextDelivery, nextTombstones = checkpoint.ledger.logicalTombstones) {
  const current = checkpoint.ledger;
  const existingIndex = current.deliveries.findIndex((record) =>
    record.deliveryAttemptId === nextDelivery.deliveryAttemptId);
  const deliveries = current.deliveries.slice();
  if (existingIndex === -1) deliveries.push(nextDelivery);
  else deliveries[existingIndex] = nextDelivery;
  return normalizeDeliveryLedgerV2Local({
    schemaVersion: 2,
    revision: nextRevision(current.revision),
    deliveries,
    notificationTargets: current.notificationTargets,
    logicalTombstones: nextTombstones,
  });
}

function createReclamationDelivery(checkpoint, kind, input, source, targetRecord) {
  const existing = checkpoint.ledger.deliveries.find((record) =>
    record.deliveryAttemptId === input.deliveryAttemptId);
  if (existing?.recordType === 'reclaimed') throw runtimeError('delivery_reclaimed');
  const targetLaunchKey = kind === 'pr-notification'
    ? (() => {
        const alias = checkpoint.ledger.notificationTargets.find((item) => item.targetId === input.targetId);
        return alias ? [alias.launch.claims.launchId, alias.launch.claims.runId,
          alias.launch.claims.attemptId] : null;
      })()
    : null;
  const requestedGroup = JSON.stringify([
    kind,
    kind === 'pr-notification' ? null : source.executionBinding.periodId,
    input.logicalMessageId,
    input.revision,
    targetLaunchKey,
  ]);
  if (checkpoint.ledger.deliveries.some((record) =>
    record.recordType === 'reclaimed' && logicalKey(record) === requestedGroup)) {
    throw runtimeError('logical_conflict');
  }
  const legacy = legacyLedgerView(checkpoint);
  const result = createDelivery(legacy, kind, input, source, targetRecord);
  if (!result.created) {
    return { ledger: checkpoint.ledger, delivery: checkpoint.ledger.deliveries.find((record) =>
      record.deliveryAttemptId === result.delivery.deliveryAttemptId), created: false };
  }
  const delivery = v2DetailFromLegacy(result.delivery);
  const logicalTombstones = checkpoint.ledger.logicalTombstones.slice();
  for (const tombstone of result.ledger.logicalTombstones) {
    if (!logicalTombstones.some((current) => JSON.stringify(current) === JSON.stringify(tombstone))) {
      logicalTombstones.push(tombstone);
    }
  }
  return {
    ledger: ledgerWithDelivery(checkpoint, delivery, logicalTombstones),
    delivery,
    created: true,
  };
}

function registerReclamationTarget(checkpoint, targetId, executionRecord) {
  const result = registerPrTarget(legacyLedgerView(checkpoint), targetId, executionRecord);
  if (!result.created) {
    return {
      ledger: checkpoint.ledger,
      target: checkpoint.ledger.notificationTargets.find((target) => target.targetId === targetId),
      created: false,
    };
  }
  const ledger = normalizeDeliveryLedgerV2Local({
    schemaVersion: 2,
    revision: nextRevision(checkpoint.ledger.revision),
    deliveries: checkpoint.ledger.deliveries,
    notificationTargets: result.ledger.notificationTargets,
    logicalTombstones: checkpoint.ledger.logicalTombstones,
  });
  return { ledger, target: ledger.notificationTargets.find((target) => target.targetId === targetId), created: true };
}

function transitionInstructionGrave(checkpoint, current, operation, correlation) {
  if (current.kind !== 'instruction' || current.state !== 'applied' ||
      !['accepted', 'applied'].includes(operation)) throw runtimeError('delivery_reclaimed');
  const fields = ['deliveryAttemptId', 'revision', 'payloadDigest', 'targetPeriodId',
    'nativeTurnId', 'nativeItemId', 'clientRequestId'];
  if (!correlation || Reflect.ownKeys(correlation).length !== fields.length ||
      fields.some((field) => !Object.getOwnPropertyDescriptor(correlation, field) ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(correlation, field), 'value'))) {
    throw runtimeError('correlation_mismatch');
  }
  if (correlation.nativeItemId !== null && correlation.nativeTurnId === null) {
    throw runtimeError('correlation_mismatch');
  }
  const applied = current.appliedCorrelation;
  for (const field of ['deliveryAttemptId', 'revision', 'payloadDigest', 'targetPeriodId', 'clientRequestId']) {
    if (correlation[field] !== applied[field]) throw runtimeError('correlation_mismatch');
  }
  for (const field of ['nativeTurnId', 'nativeItemId']) {
    if (operation === 'applied' ? correlation[field] !== applied[field]
      : correlation[field] !== null && correlation[field] !== applied[field]) {
      throw runtimeError('correlation_mismatch');
    }
  }
  if (operation === 'applied') return { ledger: checkpoint.ledger, delivery: current, changed: false };
  const previous = current.acceptedCorrelation;
  const accepted = Object.fromEntries(fields.map((field) => [field,
    ['nativeTurnId', 'nativeItemId'].includes(field) ? previous?.[field] ?? correlation[field] : correlation[field]]));
  const delivery = normalizeDeliveryRecordV2Local({ ...current, acceptedCorrelation: accepted });
  if (JSON.stringify(delivery) === JSON.stringify(current)) {
    return { ledger: checkpoint.ledger, delivery: current, changed: false };
  }
  return { ledger: ledgerWithDelivery(checkpoint, delivery), delivery, changed: true };
}

function transitionReclamationDelivery(checkpoint, deliveryAttemptId, operation, correlation, now) {
  const current = checkpoint.ledger.deliveries.find((record) =>
    record.deliveryAttemptId === deliveryAttemptId);
  if (!current) throw runtimeError('delivery_not_found');
  if (current.recordType === 'reclaimed') return transitionInstructionGrave(checkpoint, current, operation, correlation);
  const result = transitionDelivery(legacyLedgerView(checkpoint), deliveryAttemptId, operation, correlation);
  if (!result.changed) return { ledger: checkpoint.ledger, delivery: current, changed: false };
  const terminalAt = current.terminalAt !== null ? current.terminalAt
    : TERMINAL_STATES.has(result.delivery.state) ? now() : null;
  if (terminalAt !== null && (!Number.isSafeInteger(terminalAt) || terminalAt < 0)) {
    throw runtimeError('invalid_terminal_time');
  }
  const delivery = v2DetailFromLegacy(result.delivery, terminalAt);
  return {
    ledger: ledgerWithDelivery(checkpoint, delivery),
    delivery,
    changed: true,
  };
}

function getReclamationDelivery(checkpoint, deliveryAttemptId) {
  if (typeof deliveryAttemptId !== 'string') return null;
  return checkpoint.ledger.deliveries.find((record) =>
    record.deliveryAttemptId === deliveryAttemptId) || null;
}

module.exports = {
  createReclamationDelivery,
  getReclamationDelivery,
  legacyLedgerView,
  registerReclamationTarget,
  transitionReclamationDelivery,
};
