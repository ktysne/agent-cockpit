'use strict';

const { createHash } = require('node:crypto');
const { types } = require('node:util');
const {
  assertIdentifier,
  assertSafeUnsignedInteger,
  captureDenseArray,
  captureExactRecord,
  checkedAddBytes,
} = require('./reclamation-codec-primitives');
const {
  normalizeQuestionJournalV2Local,
  questionCommonKeyDigest,
  questionRecordDigest,
} = require('./common-question-reclamation-codec');
const {
  normalizeQuestionReclamationAnchorV1Local,
} = require('./question-reclamation-anchor-codec');
const {
  normalizeCheckpointV3Local,
  normalizeInstructionJournalV2Local,
} = require('./delivery-reclamation-codec');
const { decodeSourceBytes, encodeNormalized } = require('./reclamation-json-codec');
const {
  canClearMigrationAllowance,
  FIXED_H_BOUNDS,
  measureMigrationAllowance,
} = require('./reclamation-capacity-bounds');
const {
  createEmptyCheckpointV3TargetLocal,
  createEmptyInstructionJournalV2TargetLocal,
  createEmptyQuestionJournalV2TargetLocal,
  projectLegacyCheckpointV2Local,
  projectLegacyInstructionJournalV1Local,
  projectLegacyQuestionJournalV1Local,
} = require('./reclamation-migration-projection');

const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_SOURCE_BYTES = 16_777_216;
const TERMINAL_RETENTION_MS = 604_800_000;
const PERIOD_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId', 'periodId'];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const CLAIM_FIELDS = [
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding',
];
const STORE_FIELDS = ['questions', 'checkpoint', 'instructions'];
const SLOT_FIELDS = ['checkpoint', 'instructions', 'questions'];
const SLOT_SCHEMA = Object.freeze({
  checkpoint: Object.freeze({ source: 2, target: 3 }),
  instructions: Object.freeze({ source: 1, target: 2 }),
  questions: Object.freeze({ source: 1, target: 2 }),
});
const QUESTION_DETAIL_FIELDS = [
  'internalQuestionId', 'questionId', 'identity', 'periodId', 'executionId', 'conversationId',
  'launchRef', 'executionBinding', 'category', 'contentDigest', 'questions', 'createdAt',
  'deadlineAt', 'timeoutMinutes', 'revision', 'held', 'selection', 'deliveryIntent',
  'deliveryCreationState', 'autoApplyEnabledAtRegistration', 'quarantinedAt', 'externalResolution',
  'lateAnswers', 'cancelledAt',
];
const QUESTION_RESERVATION_FIELDS = [
  'internalQuestionId', 'identity', 'periodId', 'questionId', 'contentDigest', 'executionId',
  'conversationId', 'launchRef', 'executionBinding', 'createdAt', 'revision', 'selectionSource',
  'selectedAt', 'deliveryIntent', 'deliveryCreationState', 'checkpointState', 'sourceClaimsDigest',
  'sessionId', 'externalResolution', 'cancelledAt', 'terminalResultKind', 'quarantinedAt',
  'bodyState', 'reclaimedAt', 'reclamation',
];
const INSTRUCTION_SOURCE_FIELDS = [
  'launchRef', 'claims', 'identity', 'executionBinding', 'conversationId', 'sessionId',
];
const INSTRUCTION_PREPARATION_FIELDS = ['operationId', 'preparedAt', 'terminalState', 'terminalAt'];
const DELIVERY_TERMINAL_STATES = new Set(['applied', 'cancelled_before_send', 'superseded_before_send']);
const DELIVERY_STATES = new Set([
  'available', 'claimed', 'sending', 'accepted', 'applied', 'unknown',
  'cancelled_before_send', 'superseded_before_send',
]);
const DELIVERY_TRANSITIONS = Object.freeze({
  available: Object.freeze(['available', 'claimed', 'sending', 'cancelled_before_send', 'superseded_before_send']),
  claimed: Object.freeze(['claimed', 'available', 'sending', 'cancelled_before_send', 'superseded_before_send']),
  sending: Object.freeze(['sending', 'unknown', 'accepted', 'applied']),
  accepted: Object.freeze(['accepted', 'unknown', 'applied']),
  unknown: Object.freeze(['unknown', 'accepted', 'applied']),
  applied: Object.freeze(['applied']),
  cancelled_before_send: Object.freeze(['cancelled_before_send']),
  superseded_before_send: Object.freeze(['superseded_before_send']),
});
const INVALID_SNAPSHOT = 'invalid_reclamation_snapshot';
const INVALID_TRANSITION = 'invalid_reclamation_transition';
const INVALID_MIGRATION_SNAPSHOT = 'invalid_reclamation_migration_snapshot';

function requireValue(condition, code = INVALID_SNAPSHOT) {
  if (!condition) throw new TypeError(code);
}

function captureRecord(value, fields, code = INVALID_SNAPSHOT) {
  return captureExactRecord(value, fields, code);
}

function captureArray(value, maxLength, code = INVALID_SNAPSHOT) {
  return captureDenseArray(value, maxLength, code);
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

function cloneRecordWith(record, orderedFields, changes = new Map()) {
  return makeRecord(orderedFields.map((field) => [field,
    changes.has(field) ? changes.get(field) : record[field]]));
}

function sameCanonicalJson(left, right) {
  return encodeNormalized(left).bytes.equals(encodeNormalized(right).bytes);
}

function checkedAddTime(value, delta, code) {
  assertSafeUnsignedInteger(value, code);
  requireValue(value <= MAX_SAFE_INTEGER - delta, code);
  return value + delta;
}

function identityPeriodKey(identity, periodId) {
  return [...IDENTITY_FIELDS.map((field) => identity[field]), periodId]
    .map((value) => `${value.length}:${value}`)
    .join('');
}

function identityPeriodKeyFromParts(record) {
  return identityPeriodKey(record.identity, record.periodId);
}

function sameIdentity(left, right) {
  return IDENTITY_FIELDS.every((field) => left[field] === right[field]);
}

function sameActor(left, right) {
  return left.kind === right.kind && left.id === right.id;
}

function sameBinding(left, right) {
  return left.periodId === right.periodId && sameActor(left.actor, right.actor);
}

function sameIntent(left, right) {
  if (left === null || right === null) return left === right;
  return left.deliveryAttemptId === right.deliveryAttemptId &&
    left.logicalMessageId === right.logicalMessageId && left.revision === right.revision &&
    left.payloadDigest === right.payloadDigest;
}

function correlationTerminalResult(state) {
  return DELIVERY_TERMINAL_STATES.has(state) ? state : null;
}

function compactString(value) {
  return JSON.stringify(value);
}

function compactBinding(binding) {
  return `{"periodId":${compactString(binding.periodId)},"actor":{"kind":${compactString(binding.actor.kind)},"id":${compactString(binding.actor.id)}}}`;
}

function claimsDigest(claims) {
  const pieces = [
    '{',
    `"launchId":${compactString(claims.launchId)},`,
    `"runId":${compactString(claims.runId)},`,
    `"attemptId":${compactString(claims.attemptId)},`,
    `"provider":${compactString(claims.provider)},`,
    `"nativeIdKind":${compactString(claims.nativeIdKind)},`,
    `"hostId":${compactString(claims.hostId)},`,
    `"homeScopeId":${compactString(claims.homeScopeId)},`,
    `"origin":${compactString(claims.origin)},`,
    `"purpose":${compactString(claims.purpose)},`,
    `"originBinding":${claims.originBinding === null ? 'null' : compactBinding(claims.originBinding)}`,
    '}',
  ];
  return createHash('sha256').update(pieces.join(''), 'utf8').digest('hex');
}

function launchKeyFromClaims(claims) {
  return makeArray([claims.launchId, claims.runId, claims.attemptId]);
}

function sourceProjectionFromInstructionSource(source) {
  return makeRecord(INSTRUCTION_SOURCE_FIELDS.map((field) => [field, source[field]]));
}

function migrationSourceBySlot(migration) {
  const result = new Map();
  if (migration === null) return result;
  for (const source of migration.sources) result.set(source.slot, source);
  return result;
}

function normalizeStores(anchor, value, code) {
  const input = captureRecord(value, STORE_FIELDS, code);
  const questions = input.questions === null ? null : normalizeQuestionJournalV2Local(input.questions);
  const checkpoint = input.checkpoint === null ? null : normalizeCheckpointV3Local(input.checkpoint);
  const instructions = input.instructions === null ? null : normalizeInstructionJournalV2Local(input.instructions);
  const stores = makeRecord([
    ['questions', questions], ['checkpoint', checkpoint], ['instructions', instructions],
  ]);

  for (const slot of STORE_FIELDS) {
    const store = stores[slot];
    if (store !== null) requireValue(store.storeId === anchor.storeId, code);
  }

  if (anchor.migration !== null) {
    const configured = migrationSourceBySlot(anchor.migration);
    requireValue(configured.size > 0, code);
    for (const slot of SLOT_FIELDS) {
      requireValue(configured.has(slot) === (stores[slot] !== null), code);
    }
    for (const source of anchor.migration.sources) {
      const store = stores[source.slot];
      requireValue(store !== null, code);
      if (source.slot === 'questions') {
        requireValue(store.schemaVersion === source.targetSchemaVersion && store.revision === source.targetRevision,
          code);
      } else if (source.slot === 'checkpoint') {
        requireValue(store.schemaVersion === source.targetSchemaVersion && store.revision === source.targetRevision,
          code);
      } else {
        requireValue(store.schemaVersion === source.targetSchemaVersion && store.revision === source.targetRevision,
          code);
      }
    }
  }

  validateGrantBindings(anchor, stores, code);
  return stores;
}

function validateGrantBindings(anchor, stores, code) {
  const grants = [];
  if (stores.questions?.migrationAllowance !== null && stores.questions !== null) {
    grants.push(['questions', stores.questions.migrationAllowance]);
  }
  if (stores.checkpoint?.migrationAllowance !== null && stores.checkpoint !== null) {
    grants.push(['checkpoint', stores.checkpoint.migrationAllowance]);
  }
  if (stores.instructions?.migrationAllowance !== null && stores.instructions !== null) {
    grants.push(['instructions', stores.instructions.migrationAllowance]);
  }

  let operationId = null;
  for (const [slot, grant] of grants) {
    requireValue(grant.sourceSchemaVersion === SLOT_SCHEMA[slot].source &&
      grant.sourceSizeBytes > 0 && grant.sourceSizeBytes <= MAX_SOURCE_BYTES &&
      grant.maxExtraBytes <= FIXED_H_BOUNDS[slot], code);
    if (operationId === null) operationId = grant.operationId;
    requireValue(grant.operationId === operationId, code);
    if (anchor.migration !== null) {
      requireValue(grant.operationId === anchor.migration.operationId, code);
      const source = migrationSourceBySlot(anchor.migration).get(slot);
      requireValue(source !== undefined && source.sourcePresent &&
        grant.sourceSchemaVersion === source.schemaVersion && grant.sourceSizeBytes === source.sizeBytes &&
        grant.sourceSha256 === source.sha256, code);
    }
  }
}

function indexCheckpointDeliveries(checkpoint, code) {
  const byAttempt = new Map();
  if (checkpoint === null) return byAttempt;
  for (const delivery of checkpoint.ledger.deliveries) {
    byAttempt.set(delivery.deliveryAttemptId, delivery);
  }
  return byAttempt;
}

function questionDeliveryProjection(delivery) {
  if (delivery.recordType === 'detail') {
    const source = delivery.source;
    const target = delivery.target;
    return {
      sourceLaunchRef: source.launchRef,
      sourceIdentity: source.identity,
      sourceClaimsDigest: claimsDigest(source.claims),
      sourcePeriodId: source.executionBinding.periodId,
      sourceActor: source.executionBinding.actor,
      sourceConversationId: source.conversationId,
      sourceSessionId: source.sessionId,
      targetKind: target.kind,
      targetLaunchRef: target.launchRef,
      targetIdentity: target.identity,
      targetClaims: target.claims,
      targetClaimsDigest: claimsDigest(target.claims),
      targetPeriodId: target.periodId,
      targetActor: target.actor,
      targetConversationId: target.conversationId,
      targetSessionId: target.sessionId,
      launchKey: launchKeyFromClaims(source.claims),
      targetLaunchKey: launchKeyFromClaims(target.claims),
    };
  }

  const source = delivery.sourceRef;
  const target = delivery.targetRef;
  return {
    sourceLaunchRef: source.launchRef,
    sourceIdentity: source.identity,
    sourceClaimsDigest: source.sourceClaimsDigest,
    sourcePeriodId: source.executionBinding.periodId,
    sourceActor: source.executionBinding.actor,
    sourceConversationId: source.conversationId,
    sourceSessionId: source.sessionId,
    targetKind: target.kind,
    targetLaunchRef: target.launchRef,
    targetIdentity: target.identity,
    targetClaims: null,
    targetClaimsDigest: target.targetClaimsDigest,
    targetPeriodId: target.periodId,
    targetActor: target.actor,
    targetConversationId: target.conversationId,
    targetSessionId: target.sessionId,
    launchKey: source.launchKey,
    targetLaunchKey: target.launchKey,
  };
}

function validateQuestionDelivery(reservation, delivery, code) {
  const intent = reservation.deliveryIntent;
  const projection = questionDeliveryProjection(delivery);
  requireValue(delivery.kind === 'question' && delivery.deliveryAttemptId === intent.deliveryAttemptId &&
    delivery.logicalMessageId === intent.logicalMessageId && delivery.revision === intent.revision &&
    delivery.payloadDigest === intent.payloadDigest && delivery.sourceExecutionId === reservation.periodId,
  code);
  requireValue(projection.sourceLaunchRef === reservation.launchRef &&
    sameIdentity(projection.sourceIdentity, reservation.identity) &&
    projection.sourcePeriodId === reservation.periodId &&
    sameActor(projection.sourceActor, reservation.executionBinding.actor) &&
    projection.sourceConversationId === reservation.conversationId &&
    projection.sourceSessionId === reservation.sessionId &&
    projection.sourceClaimsDigest === reservation.sourceClaimsDigest,
  code);
  requireValue(projection.targetKind === 'execution' &&
    projection.targetLaunchRef === reservation.launchRef &&
    sameIdentity(projection.targetIdentity, reservation.identity) &&
    projection.targetPeriodId === reservation.periodId &&
    sameActor(projection.targetActor, reservation.executionBinding.actor) &&
    projection.targetConversationId === reservation.conversationId &&
    projection.targetSessionId === reservation.sessionId &&
    projection.targetClaimsDigest === reservation.sourceClaimsDigest,
  code);
  if (delivery.recordType === 'detail') {
    requireValue(sameCanonicalJson(delivery.source.claims, delivery.target.claims) &&
      sameCanonicalJson(projection.launchKey, projection.targetLaunchKey), code);
  } else {
    requireValue(sameCanonicalJson(projection.launchKey, projection.targetLaunchKey) &&
      projection.sourceClaimsDigest === projection.targetClaimsDigest, code);
  }
  return projection;
}

function validateQuestionPeriodRetirementInputs(value) {
  const code = 'invalid_question_retirement_snapshot';
  const input = captureRecord(value,
    ['anchor', 'questionJournal', 'checkpoint', 'identity', 'periodId'], code);
  const anchor = normalizeQuestionReclamationAnchorV1Local(input.anchor);
  const questionJournal = normalizeQuestionJournalV2Local(input.questionJournal);
  const checkpoint = normalizeCheckpointV3Local(input.checkpoint);
  const identity = captureRecord(input.identity, IDENTITY_FIELDS, code);
  const periodId = input.periodId;
  questionCommonKeyDigest(identity, periodId, 'retirement-validation');
  requireValue(anchor.migration === null && anchor.storeId === questionJournal.storeId &&
    anchor.storeId === checkpoint.storeId, code);
  const targetKey = identityPeriodKey(identity, periodId);
  requireValue(!anchor.retiredQuestionPeriods.some((period) =>
    identityPeriodKey(period.identity, period.periodId) === targetKey), code);

  const detailById = new Map(questionJournal.questions.map((detail) => [detail.internalQuestionId, detail]));
  const deliveryByAttempt = indexCheckpointDeliveries(checkpoint, code);
  const targetRows = [];
  const targetAttemptIds = new Set();
  for (const reservation of questionJournal.reservations) {
    if (identityPeriodKey(reservation.identity, reservation.periodId) !== targetKey) continue;
    const detail = detailById.get(reservation.internalQuestionId);
    requireValue(detail !== undefined && reservation.quarantinedAt === null && detail.quarantinedAt === null &&
      reservation.bodyState === 'retained' && reservation.reclaimedAt === null && reservation.reclamation === null,
    code);

    const intent = reservation.deliveryIntent;
    const delivery = intent === null ? null : deliveryByAttempt.get(intent.deliveryAttemptId) || null;
    let normalizedReservation = reservation;
    if (intent !== null) {
      if (delivery === null) {
        requireValue(reservation.deliveryCreationState !== 'checkpointed', code);
        if (reservation.deliveryCreationState === 'creating') {
          normalizedReservation = cloneRecordWith(reservation, QUESTION_RESERVATION_FIELDS, new Map([
            ['deliveryCreationState', 'indeterminate'], ['checkpointState', 'unknown'],
            ['sourceClaimsDigest', null], ['sessionId', null], ['terminalResultKind', null],
          ]));
        } else {
          requireValue(reservation.deliveryCreationState === 'not_created' ||
            reservation.deliveryCreationState === 'indeterminate', code);
        }
      } else {
        requireValue(delivery.recordType === 'detail' && delivery.kind === 'question' &&
          (reservation.deliveryCreationState === 'creating' || reservation.deliveryCreationState === 'checkpointed'),
        code);
        targetAttemptIds.add(intent.deliveryAttemptId);
        if (reservation.deliveryCreationState === 'creating') {
          const projection = questionDeliveryProjection(delivery);
          normalizedReservation = cloneRecordWith(reservation, QUESTION_RESERVATION_FIELDS, new Map([
            ['deliveryCreationState', 'checkpointed'], ['checkpointState', delivery.state],
            ['sourceClaimsDigest', projection.sourceClaimsDigest], ['sessionId', projection.sourceSessionId],
            ['terminalResultKind', correlationTerminalResult(delivery.state)],
          ]));
        } else {
          requireValue(reservation.sourceClaimsDigest === questionDeliveryProjection(delivery).sourceClaimsDigest &&
            reservation.sessionId === delivery.source.sessionId &&
            (reservation.checkpointState === delivery.state ||
              canReachDeliveryState(reservation.checkpointState, delivery.state)), code);
        }
        validateQuestionDelivery(normalizedReservation, delivery, code);
      }
    }
    targetRows.push(makeRecord([
      ['reservation', reservation], ['detail', detail], ['normalizedReservation', normalizedReservation],
      ['delivery', delivery],
    ]));
  }

  for (const delivery of checkpoint.ledger.deliveries) {
    if (delivery.kind !== 'question') continue;
    const source = delivery.recordType === 'detail' ? delivery.source : delivery.sourceRef;
    const target = delivery.recordType === 'detail' ? delivery.target : delivery.targetRef;
    const sourceMatches = identityPeriodKey(source.identity, source.executionBinding.periodId) === targetKey;
    const targetMatches = target.kind === 'execution' &&
      identityPeriodKey(target.identity, target.periodId) === targetKey;
    if (!sourceMatches && !targetMatches) continue;
    requireValue(sourceMatches && targetMatches && targetAttemptIds.has(delivery.deliveryAttemptId), code);
  }

  return makeRecord([
    ['anchor', anchor], ['questionJournal', questionJournal], ['checkpoint', checkpoint],
    ['identity', identity], ['periodId', periodId], ['targetRows', targetRows],
  ]);
}

function validateQuestionGrave(reservation, delivery, code) {
  const preparation = reservation.reclamation;
  requireValue(preparation !== null && preparation.deliveryPresence === 'checkpoint' &&
    delivery.recordType === 'reclaimed' && delivery.reclamation.reason === 'retired_question_period' &&
    delivery.reclamation.operationId === preparation.operationId &&
    delivery.reclamation.reclaimedAt >= preparation.preparedAt &&
    delivery.state === preparation.checkpointState && reservation.checkpointState === preparation.checkpointState,
  code);
  const normalized = validateQuestionDelivery(reservation, delivery, code);
  requireValue(normalized.sourceClaimsDigest === normalized.targetClaimsDigest, code);
  return normalized;
}

function expectedInstructionTarget(source) {
  return makeRecord([
    ['kind', 'execution'],
    ['launchRef', source.launchRef],
    ['claims', source.claims],
    ['identity', source.identity],
    ['periodId', source.executionBinding.periodId],
    ['actor', source.executionBinding.actor],
    ['conversationId', source.conversationId],
    ['sessionId', source.sessionId],
  ]);
}

function validateInstructionDelivery(instruction, delivery, code) {
  requireValue(delivery.kind === 'instruction' && delivery.deliveryAttemptId === instruction.deliveryAttemptId &&
    delivery.logicalMessageId === instruction.logicalMessageId && delivery.revision === instruction.revision &&
    delivery.payloadDigest === instruction.envelopeDigest &&
    delivery.sourceExecutionId === instruction.source.executionBinding.periodId, code);
  if (delivery.recordType === 'detail') {
    requireValue(sameCanonicalJson(delivery.source, sourceProjectionFromInstructionSource(instruction.source)) &&
      sameCanonicalJson(delivery.target, expectedInstructionTarget(instruction.source)), code);
  } else {
    const sourceRef = delivery.sourceRef;
    const targetRef = delivery.targetRef;
    const sourceClaimsSha = claimsDigest(instruction.source.claims);
    const sourceKey = launchKeyFromClaims(instruction.source.claims);
    requireValue(sourceRef.launchRef === instruction.source.launchRef &&
      sameCanonicalJson(sourceRef.launchKey, sourceKey) && sourceRef.sourceClaimsDigest === sourceClaimsSha &&
      sameCanonicalJson(sourceRef.identity, instruction.source.identity) &&
      sameBinding(sourceRef.executionBinding, instruction.source.executionBinding) &&
      sourceRef.conversationId === instruction.source.conversationId &&
      sourceRef.sessionId === instruction.source.sessionId &&
      targetRef.kind === 'execution' && targetRef.launchRef === instruction.source.launchRef &&
      sameCanonicalJson(targetRef.launchKey, sourceKey) && targetRef.targetClaimsDigest === sourceClaimsSha &&
      sameCanonicalJson(targetRef.identity, instruction.source.identity) &&
      targetRef.periodId === instruction.source.executionBinding.periodId &&
      sameActor(targetRef.actor, instruction.source.executionBinding.actor) &&
      targetRef.conversationId === instruction.source.conversationId &&
      targetRef.sessionId === instruction.source.sessionId, code);
  }

  const preparation = instruction.reclamation;
  if (instruction.recordType === 'reclaimed') {
    requireValue(delivery.recordType === 'reclaimed' && preparation !== null &&
      delivery.reclamation.operationId === preparation.operationId &&
      delivery.reclamation.reason === 'terminal_retention' &&
      delivery.reclamation.reclaimedAt >= preparation.preparedAt &&
      delivery.state === preparation.terminalState && delivery.terminalAt === preparation.terminalAt &&
      instruction.reclaimedAt >= preparation.preparedAt, code);
  } else if (preparation === null) {
    requireValue(delivery.recordType === 'detail', code);
  } else {
    requireValue(delivery.state === preparation.terminalState && delivery.terminalAt === preparation.terminalAt &&
      (delivery.recordType === 'detail' || (delivery.recordType === 'reclaimed' &&
        delivery.reclamation.operationId === preparation.operationId &&
        delivery.reclamation.reason === 'terminal_retention' &&
        delivery.reclamation.reclaimedAt >= preparation.preparedAt)), code);
  }
  if (preparation !== null) {
    requireValue(DELIVERY_TERMINAL_STATES.has(preparation.terminalState) &&
      delivery.state === preparation.terminalState && delivery.terminalAt === preparation.terminalAt &&
      preparation.preparedAt >= checkedAddTime(preparation.terminalAt, TERMINAL_RETENTION_MS, code), code);
  }
}

function normalizeQuestionAndInstructionCreations(anchor, stores, code) {
  const checkpoint = stores.checkpoint;
  const deliveryByAttempt = indexCheckpointDeliveries(checkpoint, code);
  const questionDetailsById = new Map();
  const questionReservationsByAttempt = new Map();
  const questionReservationById = new Map();
  const instructionByAttempt = new Map();

  if (stores.questions !== null) {
    for (const detail of stores.questions.questions) questionDetailsById.set(detail.internalQuestionId, detail);
    for (const reservation of stores.questions.reservations) {
      questionReservationById.set(reservation.internalQuestionId, reservation);
      if (reservation.deliveryIntent !== null) {
        const attempt = reservation.deliveryIntent.deliveryAttemptId;
        requireValue(!questionReservationsByAttempt.has(attempt), code);
        questionReservationsByAttempt.set(attempt, reservation);
      }
    }
  }
  if (stores.instructions !== null) {
    for (const instruction of stores.instructions.instructions) {
      instructionByAttempt.set(instruction.deliveryAttemptId, instruction);
    }
  }

  const retiredByPeriod = new Map();
  for (const period of anchor.retiredQuestionPeriods) {
    retiredByPeriod.set(identityPeriodKey(period.identity, period.periodId), period);
  }

  const changedQuestionDetails = new Map();
  const changedQuestionReservations = new Map();
  const questionDeliveryStateChanges = new Map();
  const reasons = new Set();

  if (stores.questions !== null) {
    for (const reservation of stores.questions.reservations) {
      const detail = questionDetailsById.get(reservation.internalQuestionId) || null;
      const period = retiredByPeriod.get(identityPeriodKey(reservation.identity, reservation.periodId)) || null;
      const isRetired = period !== null;
      const isPrepared = reservation.reclamation !== null || reservation.bodyState === 'reclaimed';
      const alreadyQuarantined = reservation.quarantinedAt !== null;

      if (reservation.quarantinedAt !== null) {
        requireValue(isRetired && reservation.quarantinedAt === period.retiredAt, code);
      } else if (isRetired) {
        requireValue(!isPrepared && reservation.bodyState === 'retained' && detail !== null, code);
        changedQuestionReservations.set(reservation.internalQuestionId,
          cloneRecordWith(reservation, QUESTION_RESERVATION_FIELDS,
            new Map([['quarantinedAt', period.retiredAt]])));
        changedQuestionDetails.set(reservation.internalQuestionId,
          cloneRecordWith(detail, QUESTION_DETAIL_FIELDS,
            new Map([['quarantinedAt', period.retiredAt]])));
        reasons.add('question_retirement_snapshot');
      }

      const intent = reservation.deliveryIntent;
      const delivery = intent === null ? null : deliveryByAttempt.get(intent.deliveryAttemptId) || null;
      if (intent === null) {
        if (reservation.reclamation !== null) validateQuestionPreparationWithoutDelivery(reservation, code);
        requireValue(reservation.deliveryCreationState === 'not_created' && delivery === null, code);
      } else if (delivery === null) {
        if (reservation.reclamation !== null) {
          validateQuestionPreparationWithoutDelivery(reservation, code);
        }
        if (reservation.deliveryCreationState === 'creating') {
          requireValue(!isPrepared && !alreadyQuarantined, code);
          const creationChanges = new Map([
            ['deliveryCreationState', 'indeterminate'],
            ['checkpointState', 'unknown'],
            ['sourceClaimsDigest', null],
            ['sessionId', null],
            ['terminalResultKind', null],
          ]);
          const effectiveReservation = changedQuestionReservations.get(reservation.internalQuestionId) || reservation;
          changedQuestionReservations.set(reservation.internalQuestionId,
            cloneRecordWith(effectiveReservation, QUESTION_RESERVATION_FIELDS, creationChanges));
          if (detail !== null) {
            const effectiveDetail = changedQuestionDetails.get(reservation.internalQuestionId) || detail;
            changedQuestionDetails.set(reservation.internalQuestionId,
              cloneRecordWith(effectiveDetail, QUESTION_DETAIL_FIELDS,
                new Map([['deliveryCreationState', 'indeterminate']])));
          }
          reasons.add('question_creation_state');
        } else {
          requireValue(reservation.deliveryCreationState !== 'checkpointed' &&
            (reservation.reclamation === null || reservation.reclamation.deliveryPresence !== 'checkpoint'), code);
        }
      } else {
        requireValue(delivery.kind === 'question', code);
        const initialCreation = reservation.deliveryCreationState;
        const creationChanges = new Map();
        let creationState = initialCreation;
        const effectiveReservation = changedQuestionReservations.get(reservation.internalQuestionId) || reservation;
        const effectiveDetail = detail === null
          ? null
          : (changedQuestionDetails.has(reservation.internalQuestionId)
            ? changedQuestionDetails.get(reservation.internalQuestionId)
            : detail);
        if (initialCreation === 'creating') {
          requireValue(!isPrepared && !alreadyQuarantined && delivery.recordType === 'detail', code);
          creationState = 'checkpointed';
          creationChanges.set('deliveryCreationState', 'checkpointed');
          creationChanges.set('checkpointState', delivery.state);
          creationChanges.set('sourceClaimsDigest', claimsDigest(delivery.source.claims));
          creationChanges.set('sessionId', delivery.source.sessionId);
          creationChanges.set('terminalResultKind', correlationTerminalResult(delivery.state));
          reasons.add('question_creation_state');
        } else {
          requireValue(initialCreation === 'checkpointed', code);
          const deliveryClaimsDigest = delivery.recordType === 'detail'
            ? claimsDigest(delivery.source.claims)
            : delivery.sourceRef.sourceClaimsDigest;
          requireValue(reservation.sourceClaimsDigest === deliveryClaimsDigest &&
            (delivery.recordType === 'detail'
              ? reservation.sessionId === delivery.source.sessionId
              : reservation.sessionId === delivery.sourceRef.sessionId), code);
        }

        const currentPeriod = retiredByPeriod.get(identityPeriodKey(effectiveReservation.identity,
          effectiveReservation.periodId)) || null;
        let effectiveDeliveryState = delivery.state;
        if (currentPeriod !== null && !isPrepared) {
          if (effectiveDeliveryState === 'claimed') effectiveDeliveryState = 'available';
          else if (effectiveDeliveryState === 'sending' || effectiveDeliveryState === 'accepted') {
            effectiveDeliveryState = 'unknown';
          }
          if (effectiveDeliveryState !== delivery.state) {
            requireValue(!alreadyQuarantined && delivery.recordType === 'detail' &&
              (delivery.state === 'claimed' || delivery.state === 'sending' || delivery.state === 'accepted'), code);
            questionDeliveryStateChanges.set(delivery.deliveryAttemptId, effectiveDeliveryState);
            reasons.add('question_retirement_snapshot');
          }
        }

        if (initialCreation !== 'creating' && effectiveReservation.checkpointState !== effectiveDeliveryState) {
          requireValue(!isPrepared && !alreadyQuarantined && delivery.recordType === 'detail' &&
            canReachDeliveryState(effectiveReservation.checkpointState, delivery.state), code);
          creationChanges.set('checkpointState', effectiveDeliveryState);
          creationChanges.set('terminalResultKind', correlationTerminalResult(effectiveDeliveryState));
          reasons.add('question_checkpoint_cache');
        } else if (initialCreation === 'creating' && effectiveDeliveryState !== delivery.state) {
          creationChanges.set('checkpointState', effectiveDeliveryState);
          creationChanges.set('terminalResultKind', correlationTerminalResult(effectiveDeliveryState));
        }

        const nextReservation = cloneRecordWith(effectiveReservation, QUESTION_RESERVATION_FIELDS, creationChanges);
        if (delivery.recordType === 'detail') {
          validateQuestionDelivery(nextReservation, delivery, code);
        } else {
          validateQuestionGrave(nextReservation, delivery, code);
        }
        if (effectiveReservation.reclamation !== null) {
          requireValue(effectiveReservation.reclamation.deliveryPresence === 'checkpoint' &&
            effectiveReservation.reclamation.checkpointState === delivery.state &&
            effectiveReservation.checkpointState === delivery.state &&
            (delivery.recordType !== 'detail' ||
              delivery.state === 'available' || delivery.state === 'unknown' ||
              DELIVERY_TERMINAL_STATES.has(delivery.state)), code);
          validateQuestionPreparation(effectiveReservation, delivery, code);
        }
        if (effectiveReservation.bodyState === 'reclaimed') {
          requireValue(delivery.recordType === 'reclaimed', code);
        }

        if (initialCreation === 'creating' && effectiveDetail !== null) {
          changedQuestionDetails.set(reservation.internalQuestionId,
            cloneRecordWith(effectiveDetail, QUESTION_DETAIL_FIELDS,
              new Map([['deliveryCreationState', creationState]])));
        }
        if (creationChanges.size > 0) {
          changedQuestionReservations.set(reservation.internalQuestionId,
            cloneRecordWith(effectiveReservation, QUESTION_RESERVATION_FIELDS, creationChanges));
        }
      }
    }
  }

  for (const delivery of checkpoint?.ledger.deliveries || []) {
    if (delivery.kind === 'question') {
      const reservation = questionReservationsByAttempt.get(delivery.deliveryAttemptId);
      requireValue(reservation !== undefined, code);
    } else if (delivery.kind === 'instruction') {
      requireValue(instructionByAttempt.has(delivery.deliveryAttemptId), code);
    }
  }

  const changedInstructions = new Map();
  if (stores.instructions !== null) {
    for (const instruction of stores.instructions.instructions) {
      const delivery = deliveryByAttempt.get(instruction.deliveryAttemptId) || null;
      if (delivery === null) {
        if (instruction.deliveryCreationState === 'creating') {
          requireValue(instruction.recordType === 'detail' && instruction.reclamation === null, code);
          changedInstructions.set(instruction.deliveryAttemptId,
            cloneRecordWith(instruction, Object.keys(instruction),
              new Map([['deliveryCreationState', 'indeterminate']])));
          reasons.add('instruction_creation_state');
        } else {
          requireValue(instruction.recordType === 'detail' &&
            instruction.deliveryCreationState !== 'checkpointed' && instruction.reclamation === null, code);
        }
        continue;
      }

      requireValue(delivery.kind === 'instruction', code);
      if (instruction.deliveryCreationState === 'not_created' ||
          instruction.deliveryCreationState === 'indeterminate') requireValue(false, code);
      if (instruction.deliveryCreationState === 'creating') {
        requireValue(instruction.recordType === 'detail' && instruction.reclamation === null &&
          delivery.recordType === 'detail', code);
        changedInstructions.set(instruction.deliveryAttemptId,
          cloneRecordWith(instruction, Object.keys(instruction),
            new Map([['deliveryCreationState', 'checkpointed']])));
        reasons.add('instruction_creation_state');
      }

      const normalizedInstruction = changedInstructions.get(instruction.deliveryAttemptId) || instruction;
      validateInstructionDelivery(normalizedInstruction, delivery, code);
    }
  }

  return {
    changedQuestionDetails,
    changedQuestionReservations,
    questionDeliveryStateChanges,
    changedInstructions,
    reasons,
  };
}

function validateQuestionPreparationWithoutDelivery(reservation, code) {
  const preparation = reservation.reclamation;
  requireValue(preparation.deliveryPresence === 'none' || preparation.deliveryPresence === 'indeterminate', code);
  requireValue(reservation.quarantinedAt !== null &&
    preparation.preparedAt >= checkedAddTime(reservation.quarantinedAt, TERMINAL_RETENTION_MS, code), code);
}

function validateQuestionPreparation(reservation, delivery, code) {
  const preparation = reservation.reclamation;
  requireValue(preparation !== null && reservation.quarantinedAt !== null, code);
  const deadline = checkedAddTime(reservation.quarantinedAt, TERMINAL_RETENTION_MS, code);
  requireValue(preparation.preparedAt >= deadline, code);
  if (DELIVERY_TERMINAL_STATES.has(delivery.state)) {
    const terminalDeadline = checkedAddTime(delivery.terminalAt, TERMINAL_RETENTION_MS, code);
    requireValue(preparation.preparedAt >= terminalDeadline, code);
  }
  requireValue(delivery.state === 'available' || delivery.state === 'unknown' ||
    DELIVERY_TERMINAL_STATES.has(delivery.state), code);
}

function canReachDeliveryState(previous, next) {
  if (!DELIVERY_STATES.has(previous) || !DELIVERY_STATES.has(next)) return false;
  if (previous === next) return true;
  const visited = new Set([previous]);
  const pending = [previous];
  while (pending.length > 0) {
    const state = pending.shift();
    for (const candidate of DELIVERY_TRANSITIONS[state]) {
      if (candidate === next) return true;
      if (!visited.has(candidate)) {
        visited.add(candidate);
        pending.push(candidate);
      }
    }
  }
  return false;
}

function rebuildQuestionJournal(journal, detailsById, reservationsById, code) {
  const questions = [];
  for (const detail of journal.questions) questions.push(detailsById.get(detail.internalQuestionId) || detail);
  const reservations = [];
  for (const reservation of journal.reservations) {
    reservations.push(reservationsById.get(reservation.internalQuestionId) || reservation);
  }
  const revision = checkedRevisionIncrement(journal.revision, code);
  return normalizeQuestionJournalV2Local(makeRecord([
    ['schemaVersion', journal.schemaVersion], ['storeId', journal.storeId], ['revision', revision],
    ['questions', makeArray(questions)], ['reservations', makeArray(reservations)],
    ['migrationAllowance', journal.migrationAllowance],
  ]));
}

function rebuildInstructionJournal(journal, changedInstructions, code) {
  const instructions = [];
  for (const instruction of journal.instructions) {
    instructions.push(changedInstructions.get(instruction.deliveryAttemptId) || instruction);
  }
  return normalizeInstructionJournalV2Local(makeRecord([
    ['schemaVersion', journal.schemaVersion], ['revision', checkedRevisionIncrement(journal.revision, code)],
    ['storeId', journal.storeId], ['migrationAllowance', journal.migrationAllowance],
    ['instructions', makeArray(instructions)],
  ]));
}

function rebuildCheckpoint(checkpoint, stateChanges, code) {
  if (stateChanges.size === 0) return checkpoint;
  const deliveries = [];
  for (const delivery of checkpoint.ledger.deliveries) {
    const state = stateChanges.get(delivery.deliveryAttemptId);
    if (state === undefined) {
      deliveries.push(delivery);
    } else {
      requireValue(delivery.recordType === 'detail', code);
      deliveries.push(cloneRecordWith(delivery, [
        'recordType', 'deliveryAttemptId', 'kind', 'logicalMessageId', 'revision', 'sourceExecutionId',
        'source', 'target', 'ownerGeneration', 'payloadDigest', 'state', 'cancelRequested',
        'acceptedCorrelation', 'appliedCorrelation', 'terminalAt',
      ], new Map([['state', state]])));
    }
  }
  const ledger = makeRecord([
    ['schemaVersion', checkpoint.ledger.schemaVersion],
    ['revision', checkedRevisionIncrement(checkpoint.ledger.revision, code)],
    ['deliveries', makeArray(deliveries)],
    ['notificationTargets', checkpoint.ledger.notificationTargets],
    ['logicalTombstones', checkpoint.ledger.logicalTombstones],
  ]);
  return normalizeCheckpointV3Local(makeRecord([
    ['schemaVersion', checkpoint.schemaVersion], ['storeId', checkpoint.storeId],
    ['revision', checkedRevisionIncrement(checkpoint.revision, code)],
    ['registrations', checkpoint.registrations], ['ledger', ledger],
    ['migrationAllowance', checkpoint.migrationAllowance],
  ]));
}

function checkedRevisionIncrement(value, code) {
  assertSafeUnsignedInteger(value, code);
  requireValue(value < MAX_SAFE_INTEGER, code);
  return value + 1;
}

function assertQuestionMigrationTargets(anchor, stores, code) {
  const migration = anchor.migration;
  if (migration === null) return;
  const sourceBySlot = migrationSourceBySlot(migration);
  const questionStore = stores.questions;
  if (!sourceBySlot.has('questions')) {
    requireValue(migration.targets.length === 0 && questionStore === null, code);
    return;
  }
  requireValue(questionStore !== null && migration.targets.length === questionStore.questions.length &&
    questionStore.questions.length === questionStore.reservations.length, code);

  const questionById = new Map();
  const reservationById = new Map();
  for (const detail of questionStore.questions) questionById.set(detail.internalQuestionId, detail);
  for (const reservation of questionStore.reservations) reservationById.set(reservation.internalQuestionId, reservation);
  const targetIds = new Set();
  for (const target of migration.targets) {
    requireValue(!targetIds.has(target.internalQuestionId), code);
    targetIds.add(target.internalQuestionId);
    const detail = questionById.get(target.internalQuestionId);
    const reservation = reservationById.get(target.internalQuestionId);
    const period = anchor.retiredQuestionPeriods[target.periodIndex];
    requireValue(detail !== undefined && reservation !== undefined && period !== undefined &&
      reservation.bodyState === 'retained' && reservation.reclamation === null &&
      detail.quarantinedAt === migration.startedAt && reservation.quarantinedAt === migration.startedAt &&
      sameIdentity(period.identity, detail.identity) && period.periodId === detail.periodId &&
      questionRecordDigest(detail) === target.recordDigest &&
      questionCommonKeyDigest(detail.identity, detail.periodId, detail.questionId) === target.commonKeyDigest &&
      sameIntent(detail.deliveryIntent, target.deliveryIntent), code);

    const presence = reservation.deliveryCreationState === 'checkpointed'
      ? 'checkpoint'
      : reservation.deliveryCreationState === 'indeterminate'
        ? 'indeterminate'
        : reservation.deliveryCreationState === 'not_created'
          ? 'none'
          : null;
    requireValue(presence === target.deliveryPresence &&
      (presence === 'indeterminate'
        ? target.checkpointState === 'unknown' && reservation.checkpointState === 'unknown'
        : reservation.checkpointState === target.checkpointState), code);
  }
}

function validateMigrationTargetShapes(anchor, stores, code) {
  const migration = anchor.migration;
  if (migration === null) return;
  for (const source of migration.sources) {
    const store = stores[source.slot];
    requireValue(store !== null, code);
    if (source.slot === 'questions') {
      requireValue(store.schemaVersion === 2 &&
        store.questions.every((record) => record.quarantinedAt === migration.startedAt) &&
        store.reservations.every((record) => record.bodyState === 'retained' &&
          record.quarantinedAt === migration.startedAt && record.reclamation === null), code);
    } else if (source.slot === 'checkpoint') {
      requireValue(store.schemaVersion === 3 && store.ledger.schemaVersion === 2 &&
        store.ledger.deliveries.every((record) => record.recordType === 'detail'), code);
    } else {
      requireValue(store.schemaVersion === 2 &&
        store.instructions.every((record) => record.recordType === 'detail' && record.reclamation === null), code);
    }
  }
}

function validateNormalizedSnapshot(anchor, stores, code) {
  const normalizedStores = normalizeStores(anchor, stores, code);
  const changes = normalizeQuestionAndInstructionCreations(anchor, normalizedStores, code);
  if (anchor.migration !== null) {
    requireValue(changes.reasons.size === 0, code);
  }

  let candidateQuestions = normalizedStores.questions;
  let candidateInstructions = normalizedStores.instructions;
  let candidateCheckpoint = normalizedStores.checkpoint;
  if (normalizedStores.questions !== null &&
      (changes.changedQuestionDetails.size > 0 || changes.changedQuestionReservations.size > 0)) {
    candidateQuestions = rebuildQuestionJournal(normalizedStores.questions,
      changes.changedQuestionDetails, changes.changedQuestionReservations, code);
  }
  if (normalizedStores.instructions !== null && changes.changedInstructions.size > 0) {
    candidateInstructions = rebuildInstructionJournal(normalizedStores.instructions,
      changes.changedInstructions, code);
  }
  if (normalizedStores.checkpoint !== null && changes.questionDeliveryStateChanges.size > 0) {
    candidateCheckpoint = rebuildCheckpoint(normalizedStores.checkpoint,
      changes.questionDeliveryStateChanges, code);
  }
  const candidateStores = makeRecord([
    ['questions', candidateQuestions], ['checkpoint', candidateCheckpoint],
    ['instructions', candidateInstructions],
  ]);

  validateGrantBindings(anchor, candidateStores, code);
  assertQuestionMigrationTargets(anchor, candidateStores, code);
  validateMigrationTargetShapes(anchor, candidateStores, code);
  return {
    stores: candidateStores,
    reasons: changes.reasons,
  };
}

function validateReclamationSnapshot(value) {
  const input = captureRecord(value, ['anchor', 'stores'], INVALID_SNAPSHOT);
  const anchor = normalizeQuestionReclamationAnchorV1Local(input.anchor);
  const validated = validateNormalizedSnapshot(anchor, input.stores, INVALID_SNAPSHOT);
  const reasons = makeArray([...validated.reasons]);
  if (anchor.migration !== null && !reasons.includes('migration_in_progress')) {
    reasons.push('migration_in_progress');
  }
  const snapshot = makeRecord([['anchor', anchor], ['stores', validated.stores]]);
  return makeRecord([
    ['status', reasons.length === 0 ? 'ready' : 'reconciliation-required'],
    ['snapshot', snapshot],
    ['reasons', reasons],
  ]);
}

function validateQuestionPeriodRetirementAnchorTransition(value) {
  const code = 'invalid_question_retirement_anchor_transition';
  const input = captureRecord(value,
    ['previous', 'next', 'identity', 'periodId', 'retiredAt', 'reason'], code);
  const previous = normalizeQuestionReclamationAnchorV1Local(input.previous);
  const next = normalizeQuestionReclamationAnchorV1Local(input.next);
  const identity = captureRecord(input.identity, IDENTITY_FIELDS, code);
  assertSafeUnsignedInteger(input.retiredAt, code);
  requireValue(input.reason === 'confirmed-retirement' && previous.migration === null &&
    next.migration === null && previous.storeId === next.storeId &&
    previous.revision < MAX_SAFE_INTEGER && next.revision === previous.revision + 1 &&
    next.retiredQuestionPeriods.length === previous.retiredQuestionPeriods.length + 1, code);
  compareAnchorTransition(previous, next, code);
  for (let index = 0; index < previous.retiredQuestionPeriods.length; index += 1) {
    requireValue(sameCanonicalJson(previous.retiredQuestionPeriods[index],
      next.retiredQuestionPeriods[index]), code);
  }
  const appended = next.retiredQuestionPeriods[next.retiredQuestionPeriods.length - 1];
  requireValue(sameIdentity(appended.identity, identity) && appended.periodId === input.periodId &&
    appended.retiredAt === input.retiredAt && appended.reason === input.reason, code);
  return next;
}

function validateReclamationStoreWrite(value) {
  const code = 'invalid_reclamation_store_write';
  const input = captureRecord(value, [
    'anchor', 'previousStores', 'nextStores', 'normalByteLimitsBySlot',
  ], code);
  const anchor = normalizeQuestionReclamationAnchorV1Local(input.anchor);
  requireValue(anchor.migration === null, code);
  const previousStores = normalizeStores(anchor, input.previousStores, code);
  const nextStores = normalizeStores(anchor, input.nextStores, code);
  const limits = captureRecord(input.normalByteLimitsBySlot, STORE_FIELDS, code);
  validateNormalByteLimits(limits, previousStores, nextStores, code);
  const previousChanges = normalizeQuestionAndInstructionCreations(anchor, previousStores, code);
  const nextChanges = normalizeQuestionAndInstructionCreations(anchor, nextStores, code);
  validateGrantBindings(anchor, previousStores, code);
  validateGrantBindings(anchor, nextStores, code);
  compareGrantTransition(previousStores, nextStores, anchor, anchor, limits, code);
  validateStoreTransition(
    makeRecord([['anchor', anchor], ['stores', previousStores]]),
    makeRecord([['anchor', anchor], ['stores', nextStores]]),
    code,
  );
  return makeRecord([
    ['status', 'checked'],
    ['snapshot', makeRecord([['anchor', anchor], ['stores', nextStores]])],
    ['reasons', makeArray([...new Set([...previousChanges.reasons, ...nextChanges.reasons])])],
  ]);
}

const MIGRATION_BOUNDARIES = ['migration', 'retained', 'prepared', 'reclaimed'];

function slotEncoder(slot) {
  if (slot === 'questions') return normalizeQuestionJournalV2Local;
  if (slot === 'checkpoint') return normalizeCheckpointV3Local;
  requireValue(slot === 'instructions', INVALID_MIGRATION_SNAPSHOT);
  return normalizeInstructionJournalV2Local;
}

function emptyTargetForSlot(slot, storeId) {
  if (slot === 'checkpoint') return createEmptyCheckpointV3TargetLocal({ storeId });
  if (slot === 'instructions') return createEmptyInstructionJournalV2TargetLocal({ storeId });
  requireValue(slot === 'questions', INVALID_MIGRATION_SNAPSHOT);
  return createEmptyQuestionJournalV2TargetLocal({ storeId });
}

function projectSourceSlot(slot, sourceBytes, anchor, checkpointSnapshot, allowance) {
  const options = {
    sourceBytes,
    storeId: anchor.storeId,
    operationId: anchor.migration.operationId,
    startedAt: anchor.migration.startedAt,
    migrationAllowance: allowance,
  };
  if (slot === 'checkpoint') return projectLegacyCheckpointV2Local(options);
  const dependentOptions = { ...options, checkpointSnapshot };
  if (slot === 'instructions') return projectLegacyInstructionJournalV1Local(dependentOptions);
  requireValue(slot === 'questions', INVALID_MIGRATION_SNAPSHOT);
  return projectLegacyQuestionJournalV1Local(dependentOptions);
}

function grantWithMaximum(slot, descriptor, eligibleIds, operationId) {
  const rosterField = slot === 'questions' ? 'eligibleQuestionIds' : 'eligibleAttemptIds';
  return makeRecord([
    ['operationId', operationId],
    ['sourceSchemaVersion', descriptor.schemaVersion],
    ['sourceSizeBytes', descriptor.sizeBytes],
    ['sourceSha256', descriptor.sha256],
    ['maxExtraBytes', MAX_SAFE_INTEGER],
    [rosterField, eligibleIds],
  ]);
}

function candidateProjectionRecord(slot, projection, descriptor, operationId, maximumGrant) {
  return makeRecord(MIGRATION_BOUNDARIES.map((boundary) => {
    const candidate = projection.candidateSnapshotsByBoundary[boundary];
    requireValue(candidate !== null && typeof candidate === 'object' && candidate.snapshot !== undefined,
      INVALID_MIGRATION_SNAPSHOT);
    const snapshot = maximumGrant
      ? replaceStoreGrant(candidate.snapshot,
        grantWithMaximum(slot, descriptor, projection.eligibleIds, operationId),
        slot, INVALID_MIGRATION_SNAPSHOT)
      : candidate.snapshot;
    return [boundary, makeRecord([
      ['snapshot', snapshot],
      ['encoded', maximumGrant ? encodeNormalized(snapshot) : candidate.encoded],
    ])];
  }));
}

function sourceDescriptorMatchesProjection(descriptor, projection, code) {
  const source = projection.source;
  requireValue(source.present === descriptor.sourcePresent &&
    source.schemaVersion === descriptor.schemaVersion && source.revision === descriptor.revision &&
    source.sizeBytes === descriptor.sizeBytes && source.sha256 === descriptor.sha256, code);
}

function targetDescriptorMatchesProjection(descriptor, projection, code) {
  requireValue(projection.snapshot.schemaVersion === descriptor.targetSchemaVersion &&
    projection.snapshot.revision === descriptor.targetRevision &&
    projection.encoded.sizeBytes === descriptor.targetSizeBytes &&
    projection.encoded.sha256 === descriptor.targetSha256, code);
}

function anchorForGrantMeasurement(anchor) {
  const migration = cloneRecordWith(anchor.migration,
    ['operationId', 'startedAt', 'phase', 'sources', 'targets'],
    new Map([['phase', 'prepared']]));
  const preparedAnchor = cloneRecordWith(anchor,
    ['schemaVersion', 'revision', 'storeId', 'retiredQuestionPeriods', 'migration'],
    new Map([['migration', migration]]));
  return normalizeQuestionReclamationAnchorV1Local(preparedAnchor);
}

function reconstructTargetFromSource(slot, sourceBytes, anchor, descriptor, checkpointSnapshot, code) {
  if (!descriptor.sourcePresent) {
    const empty = emptyTargetForSlot(slot, anchor.storeId);
    targetDescriptorMatchesProjection(descriptor, empty, code);
    return empty.snapshot;
  }

  const withoutGrant = projectSourceSlot(slot, sourceBytes, anchor, checkpointSnapshot, null);
  sourceDescriptorMatchesProjection(descriptor, withoutGrant, code);
  if (withoutGrant.encoded.sizeBytes === descriptor.targetSizeBytes &&
      withoutGrant.encoded.sha256 === descriptor.targetSha256) {
    targetDescriptorMatchesProjection(descriptor, withoutGrant, code);
    return withoutGrant.snapshot;
  }

  const capacity = measureMigrationAllowance({
    slot,
    sourcePresent: true,
    sourceSchemaVersion: descriptor.schemaVersion,
    sourceRevision: descriptor.revision,
    sourceSizeBytes: descriptor.sizeBytes,
    sourceSha256: descriptor.sha256,
    currentByteLimit: descriptor.sizeBytes,
    anchor: anchorForGrantMeasurement(anchor),
    eligibleIds: withoutGrant.eligibleIds,
    projections: makeRecord([
      ['withoutGrant', candidateProjectionRecord(slot, withoutGrant, descriptor,
        anchor.migration.operationId, false)],
      ['withMaximumGrant', candidateProjectionRecord(slot, withoutGrant, descriptor,
        anchor.migration.operationId, true)],
    ]),
  });
  requireValue(capacity !== null, code);
  const withGrant = projectSourceSlot(slot, sourceBytes, anchor, checkpointSnapshot, capacity);
  sourceDescriptorMatchesProjection(descriptor, withGrant, code);
  targetDescriptorMatchesProjection(descriptor, withGrant, code);
  return withGrant.snapshot;
}

function decodeTargetSnapshot(slot, bytes, descriptor, code) {
  const maximumBytes = checkedAddBytes(MAX_SOURCE_BYTES, FIXED_H_BOUNDS[slot]);
  const decoded = decodeSourceBytes(bytes, maximumBytes);
  requireValue(decoded.sizeBytes === descriptor.targetSizeBytes && decoded.sha256 === descriptor.targetSha256,
    code);
  const snapshot = slotEncoder(slot)(decoded.value);
  const encoded = encodeNormalized(snapshot);
  requireValue(encoded.sizeBytes === decoded.sizeBytes && encoded.sha256 === decoded.sha256, code);
  return snapshot;
}

function sourceFingerprintMatches(bytes, descriptor, code) {
  if (!descriptor.sourcePresent) {
    requireValue(bytes === null, code);
    return;
  }
  requireValue(bytes !== null && types.isUint8Array(bytes), code);
  const decoded = decodeSourceBytes(bytes, MAX_SOURCE_BYTES);
  requireValue(decoded.sizeBytes === descriptor.sizeBytes && decoded.sha256 === descriptor.sha256, code);
}

function inspectReclamationMigrationSnapshot(value) {
  const input = captureRecord(value, ['anchor', 'slotBytesBySlot'], INVALID_MIGRATION_SNAPSHOT);
  const anchor = normalizeQuestionReclamationAnchorV1Local(input.anchor);
  requireValue(anchor.migration !== null, INVALID_MIGRATION_SNAPSHOT);
  const bytesBySlot = captureRecord(input.slotBytesBySlot, SLOT_FIELDS, INVALID_MIGRATION_SNAPSHOT);
  for (const slot of SLOT_FIELDS) {
    requireValue(bytesBySlot[slot] === null || types.isUint8Array(bytesBySlot[slot]), INVALID_MIGRATION_SNAPSHOT);
  }

  const descriptorBySlot = migrationSourceBySlot(anchor.migration);
  for (const slot of SLOT_FIELDS) {
    if (!descriptorBySlot.has(slot)) requireValue(bytesBySlot[slot] === null, INVALID_MIGRATION_SNAPSHOT);
  }

  const descriptors = anchor.migration.sources;
  const sourceStates = [];
  let prefixLength = 0;
  let sawSource = false;
  for (const descriptor of descriptors) {
    const bytes = bytesBySlot[descriptor.slot];
    let isTarget = false;
    if (bytes !== null) {
      try {
        const decoded = decodeSourceBytes(bytes, checkedAddBytes(MAX_SOURCE_BYTES,
          FIXED_H_BOUNDS[descriptor.slot]));
        isTarget = decoded.sizeBytes === descriptor.targetSizeBytes && decoded.sha256 === descriptor.targetSha256;
      } catch {
        isTarget = false;
      }
    }
    if (isTarget) {
      requireValue(!sawSource, INVALID_MIGRATION_SNAPSHOT);
      prefixLength += 1;
      sourceStates.push(makeRecord([['slot', descriptor.slot], ['state', 'target']]));
    } else {
      sawSource = true;
      sourceFingerprintMatches(bytes, descriptor, INVALID_MIGRATION_SNAPSHOT);
      sourceStates.push(makeRecord([['slot', descriptor.slot], ['state', 'source']]));
    }
  }

  if (anchor.migration.phase === 'prepared') {
    requireValue(prefixLength === 0, INVALID_MIGRATION_SNAPSHOT);
  } else if (anchor.migration.phase === 'completed') {
    requireValue(prefixLength === descriptors.length, INVALID_MIGRATION_SNAPSHOT);
  } else {
    requireValue(anchor.migration.phase === 'guarded' || anchor.migration.phase === 'installing',
      INVALID_MIGRATION_SNAPSHOT);
  }

  const targetStores = makeRecord(STORE_FIELDS.map((slot) => [slot, null]));
  for (const descriptor of descriptors) {
    const slot = descriptor.slot;
    const bytes = bytesBySlot[slot];
    const state = sourceStates.find((entry) => entry.slot === slot).state;
    if (state === 'target') {
      targetStores[slot] = decodeTargetSnapshot(slot, bytes, descriptor, INVALID_MIGRATION_SNAPSHOT);
      continue;
    }
    const checkpointSnapshot = descriptorBySlot.has('checkpoint')
      ? targetStores.checkpoint
      : null;
    targetStores[slot] = reconstructTargetFromSource(slot, bytes, anchor, descriptor,
      checkpointSnapshot, INVALID_MIGRATION_SNAPSHOT);
  }

  const checked = validateNormalizedSnapshot(anchor, targetStores, INVALID_MIGRATION_SNAPSHOT);
  requireValue(checked.reasons.size === 0, INVALID_MIGRATION_SNAPSHOT);
  return makeRecord([
    ['status', 'reconciliation-required'],
    ['phase', anchor.migration.phase],
    ['prefixLength', prefixLength],
    ['sourceStates', makeArray(sourceStates)],
    ['snapshot', makeRecord([['anchor', anchor], ['stores', checked.stores]])],
    ['reasons', makeArray(['migration_in_progress'])],
  ]);
}

function transitionFieldsEqual(previous, next, fields) {
  return fields.every((field) => sameCanonicalJson(previous[field], next[field]));
}

function compareAnchorTransition(previous, next, code) {
  requireValue(previous.storeId === next.storeId, code);
  requireValue(next.revision >= previous.revision, code);
  const previousMigration = previous.migration;
  const nextMigration = next.migration;
  const previousRetired = previous.retiredQuestionPeriods;
  const nextRetired = next.retiredQuestionPeriods;

  requireValue(nextRetired.length >= previousRetired.length, code);
  for (let index = 0; index < previousRetired.length; index += 1) {
    requireValue(sameCanonicalJson(previousRetired[index], nextRetired[index]), code);
  }

  if (previousMigration !== null) {
    if (nextMigration === null) {
      requireValue(previousMigration.phase === 'completed' &&
        sameCanonicalJson(previousRetired, nextRetired), code);
    } else {
      requireValue(previousMigration.operationId === nextMigration.operationId &&
        previousMigration.startedAt === nextMigration.startedAt &&
        transitionFieldsEqual(previousMigration, nextMigration, ['sources', 'targets']), code);
      const phases = ['prepared', 'guarded', 'installing', 'completed'];
      const previousPhase = phases.indexOf(previousMigration.phase);
      const nextPhase = phases.indexOf(nextMigration.phase);
      requireValue(nextPhase === previousPhase || nextPhase === previousPhase + 1, code);
      requireValue(sameCanonicalJson(previousRetired, nextRetired), code);
    }
  } else if (nextMigration !== null) {
    requireValue(false, code);
  }

  if (!sameCanonicalJson(previousRetired, nextRetired) ||
      !sameCanonicalJson(previousMigration, nextMigration)) {
    requireValue(next.revision > previous.revision, code);
  }
}

function compareGrantTransition(previousStores, nextStores, previousAnchor, nextAnchor, normalByteLimitsBySlot, code) {
  for (const slot of STORE_FIELDS) {
    const previousStore = previousStores[slot];
    const nextStore = nextStores[slot];
    if (previousStore === null || nextStore === null) {
      requireValue(previousStore === nextStore, code);
      continue;
    }
    const previousGrant = previousStore.migrationAllowance;
    const nextGrant = nextStore.migrationAllowance;
    if (previousGrant === null && nextGrant === null) continue;
    if (previousGrant !== null && nextGrant !== null) {
      requireValue(sameCanonicalJson(previousGrant, nextGrant), code);
      continue;
    }
    if (previousGrant === null) {
      requireValue(false, code);
    }

    requireValue(nextGrant === null && previousAnchor.migration === null && nextAnchor.migration === null,
      code);
    const normalByteLimit = normalByteLimitsBySlot[slot];
    requireValue(Number.isSafeInteger(normalByteLimit) && normalByteLimit > 0 &&
      normalByteLimit <= MAX_SOURCE_BYTES, code);
    const snapshotWithoutGrant = replaceStoreGrant(nextStore, null, slot, code);
    const result = canClearMigrationAllowance({
      slot,
      snapshotWithoutGrant,
      normalByteLimit,
    });
    requireValue(result !== null && result.canClear === true &&
      Number.isSafeInteger(result.reserveBytes) && Number.isSafeInteger(result.limitBytes) &&
      result.reserveBytes <= result.limitBytes && result.limitBytes === normalByteLimit, code);
  }
}

function replaceStoreGrant(store, migrationAllowance, slot, code) {
  if (slot === 'questions') {
    return normalizeQuestionJournalV2Local(makeRecord([
      ['schemaVersion', store.schemaVersion], ['storeId', store.storeId], ['revision', store.revision],
      ['questions', store.questions], ['reservations', store.reservations], ['migrationAllowance', migrationAllowance],
    ]));
  }
  if (slot === 'checkpoint') {
    return normalizeCheckpointV3Local(makeRecord([
      ['schemaVersion', store.schemaVersion], ['storeId', store.storeId], ['revision', store.revision],
      ['registrations', store.registrations], ['ledger', store.ledger], ['migrationAllowance', migrationAllowance],
    ]));
  }
  requireValue(slot === 'instructions', code);
  return normalizeInstructionJournalV2Local(makeRecord([
    ['schemaVersion', store.schemaVersion], ['revision', store.revision], ['storeId', store.storeId],
    ['migrationAllowance', migrationAllowance], ['instructions', store.instructions],
  ]));
}

function validateNormalByteLimits(limits, previousStores, nextStores, code) {
  for (const slot of STORE_FIELDS) {
    const configured = previousStores[slot] !== null || nextStores[slot] !== null;
    if (!configured) {
      requireValue(limits[slot] === null, code);
      continue;
    }
    const limit = limits[slot];
    requireValue(Number.isSafeInteger(limit) && limit > 0 && limit <= MAX_SOURCE_BYTES, code);
  }
}

function validateReclamationTransition(value) {
  const input = captureRecord(value, [
    'previous', 'next', 'previousStores', 'nextStores', 'normalByteLimitsBySlot',
  ], INVALID_TRANSITION);
  const previousAnchor = input.previous === null
    ? null
    : normalizeQuestionReclamationAnchorV1Local(input.previous);
  const nextAnchor = normalizeQuestionReclamationAnchorV1Local(input.next);
  const limits = captureRecord(input.normalByteLimitsBySlot, STORE_FIELDS, INVALID_TRANSITION);
  const previousStores = input.previousStores === null
    ? makeRecord(STORE_FIELDS.map((slot) => [slot, null]))
    : normalizeStores(previousAnchor || nextAnchor, input.previousStores, INVALID_TRANSITION);
  const nextStores = normalizeStores(nextAnchor, input.nextStores, INVALID_TRANSITION);
  validateNormalByteLimits(limits, previousStores, nextStores, INVALID_TRANSITION);

  let previousValidated = null;
  const transitionPrevious = previousAnchor === null
    ? makeRecord([['anchor', null], ['stores', previousStores]])
    : null;
  if (previousAnchor !== null) {
    const previousResult = validateNormalizedSnapshot(previousAnchor, previousStores, INVALID_TRANSITION);
    previousValidated = makeRecord([['anchor', previousAnchor], ['stores', previousResult.stores]]);
  } else {
    requireValue(STORE_FIELDS.every((slot) => previousStores[slot] === null), INVALID_TRANSITION);
  }
  const nextResult = validateNormalizedSnapshot(nextAnchor, nextStores, INVALID_TRANSITION);
  const nextValidated = makeRecord([['anchor', nextAnchor], ['stores', nextResult.stores]]);

  if (previousAnchor !== null) compareAnchorTransition(previousAnchor, nextAnchor, INVALID_TRANSITION);
  if (previousAnchor !== null) {
    compareGrantTransition(previousStores, nextResult.stores, previousAnchor, nextAnchor,
      limits, INVALID_TRANSITION);
  }
  validateStoreTransition(previousValidated || transitionPrevious, nextValidated, INVALID_TRANSITION);

  const reasons = new Set(nextResult.reasons);
  if (nextAnchor.migration !== null) reasons.add('migration_in_progress');
  return makeRecord([
    ['status', reasons.size === 0 ? 'ready' : 'reconciliation-required'],
    ['previous', previousValidated],
    ['snapshot', nextValidated],
    ['reasons', makeArray([...reasons])],
  ]);
}

function sameFields(left, right, fields) {
  return fields.every((field) => sameCanonicalJson(left[field], right[field]));
}

function indexBy(items, getKey) {
  const result = new Map();
  for (const item of items) result.set(getKey(item), item);
  return result;
}

function assertStoreRevision(previous, next, code) {
  requireValue(next.revision >= previous.revision, code);
  if (!sameCanonicalJson(previous, next)) requireValue(next.revision > previous.revision, code);
}

function sourceReference(delivery) {
  if (delivery.recordType === 'reclaimed') return delivery.sourceRef;
  const source = delivery.source;
  return makeRecord([
    ['launchRef', source.launchRef],
    ['launchKey', launchKeyFromClaims(source.claims)],
    ['sourceClaimsDigest', claimsDigest(source.claims)],
    ['identity', source.identity],
    ['executionBinding', source.executionBinding],
    ['conversationId', source.conversationId],
    ['sessionId', source.sessionId],
  ]);
}

function targetReference(delivery) {
  if (delivery.recordType === 'reclaimed') return delivery.targetRef;
  const target = delivery.target;
  return makeRecord([
    ['kind', target.kind],
    ['launchRef', target.launchRef],
    ['launchKey', target.kind === 'execution' ? launchKeyFromClaims(target.claims) : null],
    ['targetClaimsDigest', target.kind === 'execution' ? claimsDigest(target.claims) : null],
    ['identity', target.identity],
    ['periodId', target.periodId],
    ['actor', target.actor],
    ['conversationId', target.conversationId],
    ['sessionId', target.sessionId],
  ]);
}

function correlationProgresses(previous, next, code) {
  if (previous === null) return true;
  requireValue(next !== null, code);
  for (const field of ['deliveryAttemptId', 'revision', 'payloadDigest', 'targetPeriodId', 'clientRequestId']) {
    requireValue(previous[field] === next[field], code);
  }
  for (const field of ['nativeTurnId', 'nativeItemId']) {
    requireValue(previous[field] === null || previous[field] === next[field], code);
  }
  return true;
}

function compareDeliveryTransition(previous, next, code) {
  const immutableFields = [
    'deliveryAttemptId', 'kind', 'logicalMessageId', 'revision', 'sourceExecutionId',
    'ownerGeneration', 'payloadDigest',
  ];
  requireValue(sameFields(previous, next, immutableFields) &&
    sameCanonicalJson(sourceReference(previous), sourceReference(next)) &&
    sameCanonicalJson(targetReference(previous), targetReference(next)), code);
  requireValue(canReachDeliveryState(previous.state, next.state), code);
  requireValue(!previous.cancelRequested || next.cancelRequested, code);
  requireValue(correlationProgresses(previous.acceptedCorrelation, next.acceptedCorrelation, code) &&
    correlationProgresses(previous.appliedCorrelation, next.appliedCorrelation, code), code);
  if (DELIVERY_TERMINAL_STATES.has(previous.state)) {
    requireValue(previous.state === next.state && previous.terminalAt === next.terminalAt, code);
  } else if (!DELIVERY_TERMINAL_STATES.has(next.state)) {
    requireValue(next.terminalAt === null, code);
  }

  if (previous.recordType === 'reclaimed') {
    requireValue(next.recordType === 'reclaimed' &&
      sameCanonicalJson(previous.reclamation, next.reclamation), code);
  } else if (next.recordType === 'reclaimed') {
    const expectedReason = previous.kind === 'question' ? 'retired_question_period' : 'terminal_retention';
    requireValue(next.reclamation.reason === expectedReason, code);
    if (previous.kind !== 'question') requireValue(DELIVERY_TERMINAL_STATES.has(previous.state), code);
  } else {
    requireValue(next.recordType === 'detail', code);
  }
}

const QUESTION_RESERVATION_ALWAYS_IMMUTABLE = [
  'internalQuestionId', 'identity', 'periodId', 'questionId', 'contentDigest', 'executionId',
  'conversationId', 'launchRef', 'executionBinding', 'createdAt',
];
const QUESTION_RESERVATION_FROZEN = QUESTION_RESERVATION_FIELDS.filter((field) =>
  !['reclamation', 'bodyState', 'reclaimedAt'].includes(field));
const QUESTION_DETAIL_ALWAYS_IMMUTABLE = [
  'internalQuestionId', 'questionId', 'identity', 'periodId', 'executionId', 'conversationId',
  'launchRef', 'executionBinding', 'category', 'contentDigest', 'questions', 'createdAt', 'deadlineAt',
  'timeoutMinutes', 'autoApplyEnabledAtRegistration',
];
const QUESTION_DETAIL_RETIREMENT_IMMUTABLE = QUESTION_DETAIL_FIELDS.filter((field) =>
  !['quarantinedAt', 'deliveryCreationState'].includes(field));

function compareQuestionReservationTransition(previous, next, code) {
  requireValue(sameFields(previous, next, QUESTION_RESERVATION_ALWAYS_IMMUTABLE), code);
  requireValue(next.revision >= previous.revision, code);
  requireValue(previous.deliveryIntent === null || sameCanonicalJson(previous.deliveryIntent, next.deliveryIntent), code);
  requireValue(previous.selectionSource === null || previous.selectionSource === next.selectionSource, code);
  requireValue(previous.selectedAt === null || previous.selectedAt === next.selectedAt, code);
  requireValue(previous.externalResolution === null ||
    sameCanonicalJson(previous.externalResolution, next.externalResolution), code);
  requireValue(previous.cancelledAt === null || previous.cancelledAt === next.cancelledAt, code);
  requireValue(canReachQuestionCreation(previous.deliveryCreationState, next.deliveryCreationState), code);
  if (previous.sourceClaimsDigest !== null) {
    requireValue(previous.sourceClaimsDigest === next.sourceClaimsDigest && previous.sessionId === next.sessionId, code);
  }
  if (previous.checkpointState !== null && next.checkpointState !== null) {
    requireValue(canReachDeliveryState(previous.checkpointState, next.checkpointState), code);
  }
  requireValue(previous.quarantinedAt === null || previous.quarantinedAt === next.quarantinedAt, code);
  if (previous.quarantinedAt !== null) {
    requireValue(sameFields(previous, next, QUESTION_RESERVATION_FROZEN), code);
  }
  if (previous.reclamation !== null) {
    requireValue(sameCanonicalJson(previous.reclamation, next.reclamation), code);
    requireValue(previous.reclaimedAt === null || previous.reclaimedAt === next.reclaimedAt, code);
    requireValue(previous.bodyState === next.bodyState ||
      (previous.bodyState === 'retained' && next.bodyState === 'reclaimed' &&
        next.reclaimedAt >= previous.reclamation.preparedAt), code);
  } else {
    requireValue(next.reclamation === null || previous.quarantinedAt !== null || next.quarantinedAt !== null, code);
    requireValue(previous.bodyState === next.bodyState ||
      (previous.bodyState === 'retained' && next.bodyState === 'reclaimed' &&
        previous.reclamation !== null), code);
  }
}

function canReachQuestionCreation(previous, next) {
  const transitions = {
    not_created: ['not_created', 'creating'],
    creating: ['creating', 'checkpointed', 'indeterminate'],
    checkpointed: ['checkpointed'],
    indeterminate: ['indeterminate'],
  };
  return transitions[previous]?.includes(next) === true;
}

function compareQuestionDetailTransition(previous, next, previousReservation, nextReservation, code) {
  if (next === undefined) {
    requireValue(previousReservation.reclamation !== null &&
      previousReservation.bodyState === 'retained' && nextReservation.bodyState === 'reclaimed', code);
    return;
  }
  requireValue(sameFields(previous, next, QUESTION_DETAIL_ALWAYS_IMMUTABLE), code);
  requireValue(next.revision >= previous.revision, code);
  requireValue(previous.selection === null || sameCanonicalJson(previous.selection, next.selection), code);
  requireValue(previous.deliveryIntent === null || sameCanonicalJson(previous.deliveryIntent, next.deliveryIntent), code);
  requireValue(previous.externalResolution === null ||
    sameCanonicalJson(previous.externalResolution, next.externalResolution), code);
  requireValue(previous.cancelledAt === null || previous.cancelledAt === next.cancelledAt, code);
  requireValue(next.lateAnswers.length >= previous.lateAnswers.length, code);
  for (let index = 0; index < previous.lateAnswers.length; index += 1) {
    requireValue(sameCanonicalJson(previous.lateAnswers[index], next.lateAnswers[index]), code);
  }
  requireValue(previous.quarantinedAt === null || previous.quarantinedAt === next.quarantinedAt, code);
  if (previous.quarantinedAt !== null) {
    requireValue(sameFields(previous, next, QUESTION_DETAIL_FIELDS), code);
  } else if (next.quarantinedAt !== null) {
    requireValue(sameFields(previous, next, QUESTION_DETAIL_RETIREMENT_IMMUTABLE), code);
  }
  if (previousReservation.reclamation !== null) {
    requireValue(sameFields(previous, next, QUESTION_DETAIL_FIELDS), code);
  }
}

function compareQuestionStoreTransition(previous, next, retiredPeriods, code) {
  assertStoreRevision(previous, next, code);
  const previousReservations = indexBy(previous.reservations, (item) => item.internalQuestionId);
  const nextReservations = indexBy(next.reservations, (item) => item.internalQuestionId);
  const previousDetails = indexBy(previous.questions, (item) => item.internalQuestionId);
  const nextDetails = indexBy(next.questions, (item) => item.internalQuestionId);
  const retiredKeys = new Set(retiredPeriods.map((period) =>
    identityPeriodKey(period.identity, period.periodId)));

  for (const [id, nextReservation] of nextReservations) {
    if (!previousReservations.has(id)) {
      requireValue(!retiredKeys.has(identityPeriodKey(nextReservation.identity, nextReservation.periodId)), code);
    }
  }

  for (const [id, previousReservation] of previousReservations) {
    const nextReservation = nextReservations.get(id);
    requireValue(nextReservation !== undefined, code);
    compareQuestionReservationTransition(previousReservation, nextReservation, code);
    const previousDetail = previousDetails.get(id);
    const nextDetail = nextDetails.get(id);
    if (previousDetail !== undefined) {
      compareQuestionDetailTransition(previousDetail, nextDetail, previousReservation, nextReservation, code);
    } else {
      requireValue(nextDetail === undefined, code);
    }
  }
}

const INSTRUCTION_IMMUTABLE_FIELDS = [
  'deliveryAttemptId', 'launchRef', 'logicalMessageId', 'revision', 'source', 'envelopeDigest',
  'nativeContentDigest', 'createdAt',
];

function canReachInstructionCreation(previous, next) {
  const transitions = {
    not_created: ['not_created', 'creating'],
    creating: ['creating', 'checkpointed', 'indeterminate'],
    checkpointed: ['checkpointed'],
    indeterminate: ['indeterminate'],
  };
  return transitions[previous]?.includes(next) === true;
}

function compareInstructionTransition(previous, next, code) {
  requireValue(sameFields(previous, next, INSTRUCTION_IMMUTABLE_FIELDS), code);
  requireValue(canReachInstructionCreation(previous.deliveryCreationState, next.deliveryCreationState), code);
  requireValue(previous.reclamation === null || sameCanonicalJson(previous.reclamation, next.reclamation), code);
  if (previous.recordType === 'reclaimed') {
    requireValue(next.recordType === 'reclaimed' && previous.reclaimedAt === next.reclaimedAt &&
      sameCanonicalJson(previous.reclamation, next.reclamation), code);
  } else if (next.recordType === 'reclaimed') {
    requireValue(previous.reclamation !== null && next.reclamation !== null &&
      sameCanonicalJson(previous.reclamation, next.reclamation) && next.reclaimedAt >= previous.reclamation.preparedAt,
    code);
  } else {
    requireValue(next.recordType === 'detail' &&
      (previous.recordType !== 'detail' || sameCanonicalJson(previous.envelope, next.envelope)), code);
  }
}

function compareInstructionStoreTransition(previous, next, code) {
  assertStoreRevision(previous, next, code);
  const nextByAttempt = indexBy(next.instructions, (item) => item.deliveryAttemptId);
  for (const previousRecord of previous.instructions) {
    const nextRecord = nextByAttempt.get(previousRecord.deliveryAttemptId);
    requireValue(nextRecord !== undefined, code);
    compareInstructionTransition(previousRecord, nextRecord, code);
  }
}

function compareCheckpointTransition(previous, next, code, frozenQuestionReservations = new Map(),
    previousInstructionsByAttempt = new Map()) {
  assertStoreRevision(previous, next, code);
  requireValue(next.ledger.revision >= previous.ledger.revision, code);
  if (!sameCanonicalJson(previous.ledger, next.ledger)) {
    requireValue(next.ledger.revision > previous.ledger.revision, code);
  }
  const nextByAttempt = indexBy(next.ledger.deliveries, (item) => item.deliveryAttemptId);
  for (const previousDelivery of previous.ledger.deliveries) {
    const nextDelivery = nextByAttempt.get(previousDelivery.deliveryAttemptId);
    requireValue(nextDelivery !== undefined, code);
    if (previousDelivery.kind === 'question' && frozenQuestionReservations.has(previousDelivery.deliveryAttemptId)) {
      const reservation = frozenQuestionReservations.get(previousDelivery.deliveryAttemptId);
      if (previousDelivery.recordType === 'detail' && nextDelivery.recordType === 'reclaimed') {
        compareDeliveryTransition(previousDelivery, nextDelivery, code);
        requireValue(reservation.reclamation !== null && reservation.reclamation.deliveryPresence === 'checkpoint' &&
          reservation.reclamation.operationId === nextDelivery.reclamation.operationId &&
          nextDelivery.reclamation.reason === 'retired_question_period' &&
          previousDelivery.state === nextDelivery.state && previousDelivery.terminalAt === nextDelivery.terminalAt &&
          previousDelivery.cancelRequested === nextDelivery.cancelRequested &&
          sameCanonicalJson(previousDelivery.acceptedCorrelation, nextDelivery.acceptedCorrelation) &&
          sameCanonicalJson(previousDelivery.appliedCorrelation, nextDelivery.appliedCorrelation), code);
      } else {
        requireValue(sameCanonicalJson(previousDelivery, nextDelivery), code);
      }
      continue;
    }
    if (previousDelivery.kind === 'instruction' && previousDelivery.recordType === 'detail' &&
        nextDelivery.recordType === 'reclaimed') {
      const instruction = previousInstructionsByAttempt.get(previousDelivery.deliveryAttemptId);
      requireValue(instruction !== undefined && instruction.reclamation !== null &&
        instruction.reclamation.operationId === nextDelivery.reclamation.operationId &&
        nextDelivery.reclamation.reason === 'terminal_retention', code);
    }
    compareDeliveryTransition(previousDelivery, nextDelivery, code);
  }
}

function validateStoreTransition(previous, next, code) {
  if (previous.anchor === null) {
    requireValue(next.anchor.migration === null, code);
    for (const slot of STORE_FIELDS) {
      requireValue(next.stores[slot] === null || next.stores[slot].migrationAllowance === null, code);
    }
    return;
  }

  const frozenQuestionReservations = new Map();
  for (const reservation of previous.stores.questions?.reservations || []) {
    if (reservation.quarantinedAt !== null && reservation.deliveryIntent !== null) {
      frozenQuestionReservations.set(reservation.deliveryIntent.deliveryAttemptId, reservation);
    }
  }
  const previousInstructionsByAttempt = new Map(
    (previous.stores.instructions?.instructions || []).map((item) => [item.deliveryAttemptId, item]),
  );
  for (const slot of STORE_FIELDS) {
    const previousStore = previous.stores[slot];
    const nextStore = next.stores[slot];
    requireValue((previousStore === null) === (nextStore === null), code);
    if (previousStore === null) continue;
    requireValue(previousStore.storeId === nextStore.storeId, code);
    if (previous.anchor.migration !== null || next.anchor.migration !== null) {
      requireValue(sameCanonicalJson(previousStore, nextStore), code);
      continue;
    }
    if (slot === 'questions') compareQuestionStoreTransition(previousStore, nextStore,
      [...previous.anchor.retiredQuestionPeriods, ...next.anchor.retiredQuestionPeriods], code);
    else if (slot === 'checkpoint') compareCheckpointTransition(previousStore, nextStore, code,
      frozenQuestionReservations, previousInstructionsByAttempt);
    else compareInstructionStoreTransition(previousStore, nextStore, code);
  }
}

module.exports = {
  inspectReclamationMigrationSnapshot,
  validateQuestionPeriodRetirementInputs,
  validateQuestionPeriodRetirementAnchorTransition,
  validateReclamationSnapshot,
  validateReclamationStoreWrite,
  validateReclamationTransition,
};
