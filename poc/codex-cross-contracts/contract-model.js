'use strict';

const MAX_CHECKPOINT_BYTES = 1024 * 1024;
const MAX_PAYLOAD_BYTES = 4096;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const PROVIDERS = new Set(['codex', 'claude']);
const ORIGINS = new Set(['standalone', 'delegated', 'review']);
const PURPOSES = new Set(['agent', 'cross-review', 'pr-creator']);
const ACTOR_KINDS = new Set(['agent', 'tool-use']);
const DELIVERY_KINDS = new Set(['question', 'result', 'pr-notification']);
const DELIVERY_STATES = new Set([
  'available', 'claimed', 'sending', 'accepted', 'unknown', 'applied', 'cancelled_before_send', 'superseded_before_send',
]);

function contractError(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function requireThat(condition, code) {
  if (!condition) contractError(code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requireKeys(value, keys, code) {
  requireThat(isRecord(value), code);
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  requireThat(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    code,
  );
}

function identifier(value, code = 'invalid_identifier') {
  requireThat(typeof value === 'string' && IDENTIFIER.test(value), code);
  return value;
}

function nonNegativeInteger(value, code = 'invalid_integer') {
  requireThat(Number.isSafeInteger(value) && value >= 0, code);
  return value;
}

function positiveInteger(value, code = 'invalid_integer') {
  requireThat(Number.isSafeInteger(value) && value > 0, code);
  return value;
}

function normalizeProvider(value) {
  requireThat(PROVIDERS.has(value), 'invalid_provider');
  return value;
}

function normalizeConversation(value) {
  requireKeys(
    value,
    ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'],
    'invalid_conversation_identity',
  );
  const provider = normalizeProvider(value.provider);
  const nativeIdKind = provider === 'codex' ? 'thread' : 'session';
  requireThat(value.nativeIdKind === nativeIdKind, 'invalid_native_id_kind');
  return {
    provider,
    nativeIdKind,
    hostId: identifier(value.hostId, 'invalid_host_id'),
    homeScopeId: identifier(value.homeScopeId, 'invalid_home_scope_id'),
    nativeId: identifier(value.nativeId, 'invalid_native_id'),
  };
}

function conversationKey(identity) {
  return JSON.stringify([
    identity.provider, identity.nativeIdKind, identity.hostId, identity.homeScopeId, identity.nativeId,
  ]);
}

function normalizeActor(value) {
  requireKeys(value, ['kind', 'id'], 'invalid_actor');
  requireThat(ACTOR_KINDS.has(value.kind), 'invalid_actor_kind');
  return { kind: value.kind, id: identifier(value.id, 'invalid_actor_id') };
}

function actorKey(actor) {
  return JSON.stringify([actor.kind, actor.id]);
}

function normalizeOwner(value) {
  requireKeys(value, ['periodId', 'actor'], 'invalid_owner');
  return {
    periodId: identifier(value.periodId, 'invalid_period_id'),
    actor: normalizeActor(value.actor),
  };
}

function ownerKey(owner) {
  return JSON.stringify([owner.periodId, owner.actor.kind, owner.actor.id]);
}

function normalizeOrigin(value) {
  requireThat(ORIGINS.has(value), 'invalid_origin');
  return value;
}

function normalizePurpose(value) {
  requireThat(PURPOSES.has(value), 'invalid_purpose');
  return value;
}

function validateOriginPurpose(origin, purpose) {
  requireThat(
    (origin === 'standalone' && purpose !== 'cross-review')
      || (origin === 'delegated' && purpose === 'agent')
      || (origin === 'review' && purpose === 'cross-review'),
    'origin_purpose_mismatch',
  );
}

function normalizeOriginBinding(value, origin) {
  if (origin === 'standalone') {
    requireThat(value === null, 'invalid_origin_binding');
    return null;
  }
  return normalizeOwner(value);
}

function clone(value) {
  return structuredClone(value);
}

function executionOrigin(execution) {
  return {
    launchId: execution.launchId,
    runId: execution.runId,
    attemptId: execution.attemptId,
    provider: execution.provider,
    origin: execution.origin,
    purpose: execution.purpose,
    originBinding: clone(execution.originBinding),
  };
}

function makeExecutionProof(execution, connectionGeneration) {
  return {
    origin: executionOrigin(execution),
    currentOwner: clone(execution.currentOwner),
    ownerGeneration: execution.ownerGeneration,
    connectionGeneration,
  };
}
function logicalDeliveryKey(delivery) {
  if (delivery.kind === 'pr-notification') {
    return JSON.stringify([delivery.kind, delivery.logicalMessageId, delivery.revision, delivery.targetId]);
  }
  return JSON.stringify([
    delivery.kind, delivery.executionId, delivery.logicalMessageId, delivery.revision,
  ]);
}
function normalizeEvidence(value, delivery) {
  requireKeys(
    value,
    ['periodId', 'actor', 'ownerGeneration', 'revision'],
    'invalid_delivery_evidence',
  );
  const evidence = {
    periodId: identifier(value.periodId, 'invalid_period_id'),
    actor: normalizeActor(value.actor),
    ownerGeneration: value.ownerGeneration === null ? null : nonNegativeInteger(value.ownerGeneration),
    revision: positiveInteger(value.revision),
  };
  requireThat(
    evidence.periodId === delivery.recipient.periodId
      && actorKey(evidence.actor) === actorKey(delivery.recipient.actor)
      && evidence.ownerGeneration === delivery.recipient.ownerGeneration
      && evidence.revision === delivery.revision,
    'delivery_evidence_mismatch',
  );
  return evidence;
}

function normalizeConversationRecord(key, value) {
  requireKeys(
    value,
    ['identity', 'connectionGeneration', 'activePeriodId', 'lastEndedPeriodId'],
    'invalid_checkpoint_conversation',
  );
  const identity = normalizeConversation(value.identity);
  requireThat(key === conversationKey(identity), 'invalid_checkpoint_conversation_key');
  nonNegativeInteger(value.connectionGeneration);
  for (const periodId of [value.activePeriodId, value.lastEndedPeriodId]) {
    requireThat(periodId === null || IDENTIFIER.test(periodId), 'invalid_period_id');
  }
}

function normalizePeriodRecord(key, value, conversations) {
  requireKeys(
    value,
    ['id', 'conversationKey', 'status', 'ownerProofId', 'actors', 'reconciledConnectionGeneration'],
    'invalid_checkpoint_period',
  );
  requireThat(key === value.id, 'invalid_checkpoint_period_id');
  identifier(value.id, 'invalid_period_id');
  requireThat(value.status === 'active' || value.status === 'ended', 'invalid_period_status');
  identifier(value.ownerProofId, 'invalid_owner_proof_id');
  requireThat(Object.hasOwn(conversations, value.conversationKey), 'invalid_period_conversation');
  requireThat(isRecord(value.actors), 'invalid_checkpoint_actors');
  for (const [keyActor, actor] of Object.entries(value.actors)) {
    requireKeys(actor, ['kind', 'id', 'status'], 'invalid_checkpoint_actor');
    const normalized = normalizeActor({ kind: actor.kind, id: actor.id });
    requireThat(keyActor === actorKey(normalized), 'invalid_checkpoint_actor_key');
    requireThat(actor.status === 'active' || actor.status === 'ended', 'invalid_actor_status');
  }
  requireThat(
    value.reconciledConnectionGeneration === null
      || Number.isSafeInteger(value.reconciledConnectionGeneration),
    'invalid_reconciliation_generation',
  );
  if (value.status === 'active') {
    requireThat(
      conversations[value.conversationKey].activePeriodId === value.id,
      'invalid_active_period',
    );
  }
}

function validateCheckpoint(serialized) {
  requireThat(typeof serialized === 'string', 'invalid_checkpoint');
  requireThat(
    Buffer.byteLength(serialized, 'utf8') <= MAX_CHECKPOINT_BYTES,
    'checkpoint_too_large',
  );
  let state;
  try {
    state = JSON.parse(serialized);
  } catch {
    contractError('invalid_checkpoint_json');
  }
  requireKeys(
    state,
    [
      'schemaVersion', 'nextPeriodSequence', 'conversations', 'periods', 'executions',
      'prTargets', 'deliveryLedger',
    ],
    'invalid_checkpoint_schema',
  );
  requireThat(state.schemaVersion === 1, 'unsupported_checkpoint_schema');
  positiveInteger(state.nextPeriodSequence);
  for (const collection of [
    'conversations', 'periods', 'executions', 'prTargets', 'deliveryLedger',
  ]) {
    requireThat(isRecord(state[collection]), 'invalid_checkpoint_collection');
  }
  for (const [key, conversation] of Object.entries(state.conversations)) {
    normalizeConversationRecord(key, conversation);
  }
  let maximumPeriodSequence = 0;
  for (const [key, period] of Object.entries(state.periods)) {
    normalizePeriodRecord(key, period, state.conversations);
    requireThat(/^period-[0-9]+$/.test(key), 'invalid_period_id');
    maximumPeriodSequence = Math.max(maximumPeriodSequence, Number(key.slice(7)));
  }
  requireThat(state.nextPeriodSequence > maximumPeriodSequence, 'period_sequence_rewind');
  for (const [key, conversation] of Object.entries(state.conversations)) {
    if (conversation.activePeriodId !== null) {
      const period = state.periods[conversation.activePeriodId];
      requireThat(
        period && period.conversationKey === key && period.status === 'active',
        'invalid_active_period_reference',
      );
    }
    if (conversation.lastEndedPeriodId !== null) {
      const period = state.periods[conversation.lastEndedPeriodId];
      requireThat(
        period && period.conversationKey === key && period.status === 'ended',
        'invalid_last_ended_period_reference',
      );
    }
  }
  for (const [key, execution] of Object.entries(state.executions)) {
    requireKeys(
      execution,
      [
        'launchId', 'runId', 'attemptId', 'provider', 'origin', 'purpose', 'originBinding',
        'currentOwner', 'ownerGeneration', 'currentProof', 'status', 'handoffs',
      ],
      'invalid_checkpoint_execution',
    );
    requireThat(key === execution.runId, 'invalid_checkpoint_execution_id');
    identifier(execution.launchId, 'invalid_launch_id');
    identifier(execution.runId, 'invalid_run_id');
    identifier(execution.attemptId, 'invalid_attempt_id');
    normalizeProvider(execution.provider);
    const origin = normalizeOrigin(execution.origin);
    const purpose = normalizePurpose(execution.purpose);
    validateOriginPurpose(origin, purpose);
    const binding = normalizeOriginBinding(execution.originBinding, origin);
    const owner = normalizeOwner(execution.currentOwner);
    nonNegativeInteger(execution.ownerGeneration);
    requireThat(
      execution.status === 'active' || execution.status === 'ended',
      'invalid_execution_status',
    );
    requireThat(isRecord(execution.handoffs), 'invalid_checkpoint_handoffs');
    for (const reference of [binding, owner]) {
      if (reference !== null) {
        const period = state.periods[reference.periodId];
        requireThat(
          period && period.actors[actorKey(reference.actor)],
          'invalid_execution_period_reference',
        );
      }
    }
    if (execution.currentProof !== null) {
      const proof = execution.currentProof;
      requireKeys(
        proof,
        ['origin', 'currentOwner', 'ownerGeneration', 'connectionGeneration'],
        'invalid_checkpoint_execution_proof',
      );
      requireKeys(
        proof.origin,
        ['launchId', 'runId', 'attemptId', 'provider', 'origin', 'purpose', 'originBinding'],
        'invalid_checkpoint_execution_origin',
      );
      requireThat(
        proof.origin.launchId === execution.launchId
          && proof.origin.runId === execution.runId
          && proof.origin.attemptId === execution.attemptId
          && proof.origin.provider === execution.provider
          && proof.origin.origin === execution.origin
          && proof.origin.purpose === execution.purpose
          && JSON.stringify(proof.origin.originBinding) === JSON.stringify(execution.originBinding),
        'invalid_checkpoint_execution_origin',
      );
      requireThat(
        ownerKey(normalizeOwner(proof.currentOwner)) === ownerKey(owner)
          && proof.ownerGeneration === execution.ownerGeneration,
        'invalid_checkpoint_execution_owner',
      );
      nonNegativeInteger(proof.connectionGeneration);
      const ownerPeriod = state.periods[owner.periodId];
      const ownerConversation = state.conversations[ownerPeriod.conversationKey];
      requireThat(
        proof.connectionGeneration === ownerConversation.connectionGeneration,
        'stale_checkpoint_execution_proof',
      );
    }    for (const [handoffId, handoff] of Object.entries(execution.handoffs)) {
      identifier(handoffId, 'invalid_handoff_id');
      requireKeys(handoff, ['fingerprint', 'result'], 'invalid_checkpoint_handoff');
      requireThat(
        typeof handoff.fingerprint === 'string' && handoff.fingerprint.length <= 2048,
        'invalid_handoff_fingerprint',
      );
      requireKeys(
        handoff.result,
        ['executionId', 'currentOwner', 'ownerGeneration'],
        'invalid_handoff_result',
      );
      requireThat(handoff.result.executionId === execution.runId, 'invalid_handoff_result');
      normalizeOwner(handoff.result.currentOwner);
      nonNegativeInteger(handoff.result.ownerGeneration);
    }
  }
  for (const [key, target] of Object.entries(state.prTargets)) {
    requireThat(key === target.id, 'invalid_checkpoint_pr_target_id');
    requireKeys(target, ['id', 'periodId', 'actor'], 'invalid_checkpoint_pr_target');
    identifier(target.id, 'invalid_target_id');
    const owner = normalizeOwner({ periodId: target.periodId, actor: target.actor });
    const period = state.periods[owner.periodId];
    requireThat(period && period.actors[actorKey(owner.actor)], 'invalid_pr_target_owner');
  }
  const logicalDeliveries = new Set();
  for (const [key, delivery] of Object.entries(state.deliveryLedger)) {
    requireKeys(
      delivery,
      [
        'deliveryAttemptId', 'logicalMessageId', 'kind', 'executionId', 'revision',
        'recipient', 'targetId', 'status',
        'decision', 'decisionState', 'cancelRequested', 'claimId', 'acceptedEvidence',
        'appliedEvidence',
      ],
      'invalid_checkpoint_delivery',
    );
    requireThat(key === delivery.deliveryAttemptId, 'invalid_checkpoint_delivery_id');
    identifier(delivery.deliveryAttemptId, 'invalid_delivery_id');
    identifier(delivery.logicalMessageId, 'invalid_logical_message_id');
    requireThat(
      delivery.status === 'superseded_before_send' || !logicalDeliveries.has(logicalDeliveryKey(delivery)),
      'duplicate_logical_delivery',
    );
    if (delivery.status !== 'superseded_before_send') {
      logicalDeliveries.add(logicalDeliveryKey(delivery));
    }
    requireThat(DELIVERY_KINDS.has(delivery.kind), 'invalid_delivery_kind');
    requireThat(state.executions[delivery.executionId], 'invalid_delivery_execution');
    positiveInteger(delivery.revision);
    requireKeys(
      delivery.recipient,
      ['periodId', 'actor', 'ownerGeneration'],
      'invalid_delivery_recipient',
    );
    const recipient = normalizeOwner({
      periodId: delivery.recipient.periodId,
      actor: delivery.recipient.actor,
    });
    requireThat(
      delivery.recipient.ownerGeneration === null
        || Number.isSafeInteger(delivery.recipient.ownerGeneration),
      'invalid_recipient_generation',
    );
    requireThat(
      delivery.kind === 'pr-notification'
        ? delivery.recipient.ownerGeneration === null
        : Number.isSafeInteger(delivery.recipient.ownerGeneration)
          && delivery.recipient.ownerGeneration >= 0,
      'invalid_recipient_generation',
    );
    const recipientPeriod = state.periods[recipient.periodId];
    requireThat(
      recipientPeriod && recipientPeriod.actors[actorKey(recipient.actor)],
      'invalid_delivery_recipient',
    );
    requireThat(DELIVERY_STATES.has(delivery.status), 'invalid_delivery_status');
    requireThat(
      delivery.decision === null
        || delivery.decision === 'chosen'
        || delivery.decision === 'provisional',
      'invalid_delivery_decision',
    );
    requireThat(
      delivery.decisionState === null
        || delivery.decisionState === 'chosen'
        || delivery.decisionState === 'provisional'
        || delivery.decisionState === 'cancelled',
      'invalid_delivery_decision_state',
    );
    requireThat(typeof delivery.cancelRequested === 'boolean', 'invalid_cancel_flag');
    requireThat(
      delivery.claimId === null || IDENTIFIER.test(delivery.claimId),
      'invalid_claim_id',
    );
    requireThat(
      delivery.kind === 'question'
        ? delivery.decision !== null && delivery.decisionState !== null
        : delivery.decision === null && delivery.decisionState === null,
      'invalid_delivery_decision_kind',
    );
    requireThat(
      delivery.kind === 'pr-notification'
        ? delivery.targetId !== null && state.prTargets[delivery.targetId]
        : delivery.targetId === null,
      'invalid_delivery_target',
    );
    requireThat(
      delivery.status === 'cancelled_before_send'
        ? delivery.decisionState === 'cancelled'
          && delivery.acceptedEvidence === null && delivery.appliedEvidence === null
        : delivery.decisionState !== 'cancelled',
      'invalid_cancelled_delivery',
    );
    for (const field of ['acceptedEvidence', 'appliedEvidence']) {
      if (delivery[field] !== null) normalizeEvidence(delivery[field], delivery);
    }
    if (delivery.status === 'sending') {
      requireThat(
        delivery.acceptedEvidence === null && delivery.appliedEvidence === null,
        'invalid_sending_delivery',
      );
    }
    if (delivery.status === 'accepted') {
      requireThat(
        delivery.acceptedEvidence !== null && delivery.appliedEvidence === null,
        'invalid_accepted_delivery',
      );
    }
    if (delivery.status === 'applied') {
      requireThat(delivery.appliedEvidence !== null, 'invalid_applied_delivery');
    }
    if (delivery.status === 'available' || delivery.status === 'claimed') {
      requireThat(
        delivery.acceptedEvidence === null && delivery.appliedEvidence === null,
        'invalid_unsent_delivery',
      );
    }
  }
  return state;
}

class ContractModel {
  #state;
  #persist;
  #payloads;

  constructor({ persist = () => {} } = {}) {
    requireThat(typeof persist === 'function', 'invalid_persistence_callback');
    this.#persist = persist;
    this.#payloads = new Map();
    this.#state = {
      schemaVersion: 1,
      nextPeriodSequence: 1,
      conversations: {},
      periods: {},
      executions: {},
      prTargets: {},
      deliveryLedger: {},
    };
  }

  static restore(serialized, { persist = () => {} } = {}) {
    const state = validateCheckpoint(serialized);
    const model = new ContractModel({ persist });
    model.#state = clone(state);
    for (const conversation of Object.values(model.#state.conversations)) {
      requireThat(conversation.connectionGeneration < Number.MAX_SAFE_INTEGER, 'generation_exhausted');
      conversation.connectionGeneration += 1;
    }
    for (const period of Object.values(model.#state.periods)) {
      period.reconciledConnectionGeneration = null;
    }
    for (const execution of Object.values(model.#state.executions)) execution.currentProof = null;
    for (const delivery of Object.values(model.#state.deliveryLedger)) {
      if (delivery.status === 'sending' || delivery.status === 'accepted') {
        delivery.status = 'unknown';
      }
    }
    return model;
  }

  checkpoint() {
    return this.#encode(this.#state);
  }

  #encode(state) {
    const serialized = JSON.stringify(state);
    requireThat(
      Buffer.byteLength(serialized, 'utf8') <= MAX_CHECKPOINT_BYTES,
      'checkpoint_too_large',
    );
    return serialized;
  }

  #commit(nextState) {
    const result = this.#persist(this.#encode(nextState));
    requireThat(
      result === undefined || (result && typeof result.then !== 'function'),
      'asynchronous_persistence_unsupported',
    );
    this.#state = nextState;
  }

  #conversation(identity) {
    const normalized = normalizeConversation(identity);
    const key = conversationKey(normalized);
    const record = this.#state.conversations[key];
    requireThat(record, 'unknown_conversation');
    return { normalized, key, record };
  }

  #period(periodId, state = this.#state) {
    const id = identifier(periodId, 'invalid_period_id');
    const period = state.periods[id];
    requireThat(period, 'unknown_period');
    return period;
  }

  #execution(runId, state = this.#state) {
    const id = identifier(runId, 'invalid_run_id');
    const execution = state.executions[id];
    requireThat(execution, 'unknown_execution');
    return execution;
  }

  #delivery(deliveryId, state = this.#state) {
    const id = identifier(deliveryId, 'invalid_delivery_id');
    const delivery = state.deliveryLedger[id];
    requireThat(delivery, 'unknown_delivery');
    return delivery;
  }

  #periodIsFresh(period, state = this.#state) {
    const conversation = state.conversations[period.conversationKey];
    return period.status === 'active'
      && conversation.activePeriodId === period.id
      && period.reconciledConnectionGeneration === conversation.connectionGeneration;
  }

  #executionProofMatches(execution, state = this.#state) {
    const proof = execution.currentProof;
    if (proof === null) return false;
    const owner = execution.currentOwner;
    const period = state.periods[owner.periodId];
    const conversation = state.conversations[period.conversationKey];
    return JSON.stringify(proof.origin) === JSON.stringify(executionOrigin(execution))
      && ownerKey(normalizeOwner(proof.currentOwner)) === ownerKey(owner)
      && proof.ownerGeneration === execution.ownerGeneration
      && proof.connectionGeneration === conversation.connectionGeneration
      && this.#periodIsFresh(period, state);
  }

  #requireActiveExecution(execution, state = this.#state) {
    requireThat(execution.status === 'active', 'execution_ended');
    this.#requireActiveOwner(execution.currentOwner, state);
    requireThat(this.#executionProofMatches(execution, state), 'execution_not_reconciled');
  }
  #requireActiveOwner(owner, state = this.#state) {
    const normalized = normalizeOwner(owner);
    const period = this.#period(normalized.periodId, state);
    requireThat(period.status === 'active', 'owner_not_active');
    const conversation = state.conversations[period.conversationKey];
    requireThat(conversation.activePeriodId === period.id, 'owner_not_active');
    requireThat(
      period.reconciledConnectionGeneration === conversation.connectionGeneration,
      'owner_not_reconciled',
    );
    const actor = period.actors[actorKey(normalized.actor)];
    requireThat(actor && actor.status === 'active', 'owner_not_active');
    return normalized;
  }
  startOwnedPeriod({ conversation, ownerActor, evidence }) {
    const identity = normalizeConversation(conversation);
    const key = conversationKey(identity);
    const actor = normalizeActor(ownerActor);
    requireThat(isRecord(evidence) && evidence.verified === true, 'owner_evidence_unverified');
    const kind = evidence.kind;
    const proofId = identifier(evidence.proofId, 'invalid_owner_proof_id');
    if (kind === 'owned-start') {
      requireKeys(evidence, ['kind', 'proofId', 'verified'], 'invalid_owner_evidence');
    } else if (kind === 'owned-resume') {
      requireKeys(
        evidence,
        ['kind', 'proofId', 'verified', 'endedPeriodId'],
        'invalid_owner_evidence',
      );
      identifier(evidence.endedPeriodId, 'invalid_period_id');
    } else {
      contractError('invalid_owner_evidence_kind');
    }

    const next = clone(this.#state);
    let record = next.conversations[key];
    if (!record) {
      record = {
        identity,
        connectionGeneration: 0,
        activePeriodId: null,
        lastEndedPeriodId: null,
      };
      next.conversations[key] = record;
    }
    requireThat(record.activePeriodId === null, 'conversation_already_owned');
    if (kind === 'owned-resume') {
      requireThat(record.lastEndedPeriodId === evidence.endedPeriodId, 'resume_period_mismatch');
      const ended = next.periods[evidence.endedPeriodId];
      requireThat(
        ended && ended.status === 'ended' && ended.conversationKey === key,
        'resume_period_mismatch',
      );
    } else {
      requireThat(record.lastEndedPeriodId === null, 'resume_evidence_required');
    }

    const periodId = 'period-' + next.nextPeriodSequence;
    requireThat(!next.periods[periodId], 'period_id_reuse');
    next.nextPeriodSequence += 1;
    next.periods[periodId] = {
      id: periodId,
      conversationKey: key,
      status: 'active',
      ownerProofId: proofId,
      actors: { [actorKey(actor)]: { ...actor, status: 'active' } },
      reconciledConnectionGeneration: record.connectionGeneration,
    };
    record.activePeriodId = periodId;
    this.#commit(next);
    return periodId;
  }

  observerResume(conversation) {
    const { record } = this.#conversation(conversation);
    requireThat(record.activePeriodId !== null, 'no_active_owned_period');
    return {
      periodId: record.activePeriodId,
      connectionGeneration: record.connectionGeneration,
    };
  }

  observeCompaction(conversation) {
    return this.observerResume(conversation);
  }

  reconnect(conversation) {
    const { key } = this.#conversation(conversation);
    const next = clone(this.#state);
    const record = next.conversations[key];
    requireThat(record.connectionGeneration < Number.MAX_SAFE_INTEGER, 'generation_exhausted');
    record.connectionGeneration += 1;
    for (const execution of Object.values(next.executions)) {
      const ownerPeriod = next.periods[execution.currentOwner.periodId];
      if (ownerPeriod.conversationKey === key) execution.currentProof = null;
    }
    this.#commit(next);
    return {
      periodId: record.activePeriodId,
      connectionGeneration: record.connectionGeneration,
    };
  }

  endActor(periodId, actorValue) {
    const actor = normalizeActor(actorValue);
    const period = this.#period(periodId);
    const key = actorKey(actor);
    requireThat(period.actors[key], 'unknown_actor');
    if (period.actors[key].status === 'ended') return;
    const next = clone(this.#state);
    next.periods[period.id].actors[key].status = 'ended';
    this.#commit(next);
  }

  endPeriod(periodId) {
    const period = this.#period(periodId);
    if (period.status === 'ended') return;
    const next = clone(this.#state);
    const ended = next.periods[period.id];
    ended.status = 'ended';
    for (const actor of Object.values(ended.actors)) actor.status = 'ended';
    const conversation = next.conversations[ended.conversationKey];
    if (conversation.activePeriodId === period.id) {
      conversation.activePeriodId = null;
      conversation.lastEndedPeriodId = period.id;
    }
    this.#commit(next);
  }

  addActor(periodId, actorValue) {
    const actor = normalizeActor(actorValue);
    const period = this.#period(periodId);
    requireThat(this.#periodIsFresh(period), 'owner_not_reconciled');
    const key = actorKey(actor);
    requireThat(!period.actors[key], 'actor_already_registered');
    const next = clone(this.#state);
    next.periods[period.id].actors[key] = { ...actor, status: 'active' };
    this.#commit(next);
  }

  reconcileConversation(conversation, evidence) {
    const { key, record } = this.#conversation(conversation);
    requireKeys(
      evidence,
      ['periodId', 'connectionGeneration', 'verified'],
      'invalid_reconciliation',
    );
    requireThat(evidence.verified === true, 'reconciliation_unverified');
    requireThat(evidence.periodId === record.activePeriodId, 'stale_period_proof');
    requireThat(
      evidence.connectionGeneration === record.connectionGeneration,
      'stale_connection_proof',
    );
    const period = this.#period(evidence.periodId);
    const next = clone(this.#state);
    next.periods[period.id].reconciledConnectionGeneration = record.connectionGeneration;
    this.#commit(next);
    return { conversationKey: key, periodId: period.id };
  }

  conversationMetadata(conversation) {
    const { key, record } = this.#conversation(conversation);
    return {
      conversationKey: key,
      activePeriodId: record.activePeriodId,
      lastEndedPeriodId: record.lastEndedPeriodId,
      connectionGeneration: record.connectionGeneration,
    };
  }

  periodMetadata(periodId) {
    const period = this.#period(periodId);
    return {
      id: period.id,
      status: period.status,
      conversationKey: period.conversationKey,
      actors: clone(period.actors),
    };
  }

  registerExecution(input) {
    requireKeys(
      input,
      [
        'launchId', 'runId', 'attemptId', 'provider', 'origin', 'purpose',
        'originBinding', 'currentOwner',
      ],
      'invalid_execution',
    );
    const launchId = identifier(input.launchId, 'invalid_launch_id');
    const runId = identifier(input.runId, 'invalid_run_id');
    const attemptId = identifier(input.attemptId, 'invalid_attempt_id');
    const provider = normalizeProvider(input.provider);
    const origin = normalizeOrigin(input.origin);
    const purpose = normalizePurpose(input.purpose);
    validateOriginPurpose(origin, purpose);
    const originBinding = normalizeOriginBinding(input.originBinding, origin);
    const currentOwner = this.#requireActiveOwner(input.currentOwner);
    if (originBinding !== null) {
      requireThat(ownerKey(originBinding) === ownerKey(currentOwner), 'origin_owner_mismatch');
    }
    requireThat(!this.#state.executions[runId], 'execution_already_registered');
    const next = clone(this.#state);
    const execution = {
      launchId,
      runId,
      attemptId,
      provider,
      origin,
      purpose,
      originBinding,
      currentOwner,
      ownerGeneration: 0,
      currentProof: null,
      status: 'active',
      handoffs: {},
    };
    const ownerPeriod = next.periods[currentOwner.periodId];
    const connectionGeneration = next.conversations[ownerPeriod.conversationKey].connectionGeneration;
    execution.currentProof = makeExecutionProof(execution, connectionGeneration);
    next.executions[runId] = execution;
    this.#commit(next);
    return runId;
  }

  executionMetadata(runId) {
    return clone(this.#execution(runId));
  }
  handoff(runId, request) {
    requireKeys(
      request,
      ['handoffId', 'expectedOwnerGeneration', 'newOwnerGeneration', 'newOwner'],
      'invalid_handoff',
    );
    const execution = this.#execution(runId);
    const handoffId = identifier(request.handoffId, 'invalid_handoff_id');
    const expectedGeneration = nonNegativeInteger(request.expectedOwnerGeneration);
    const newGeneration = nonNegativeInteger(request.newOwnerGeneration);
    const newOwner = normalizeOwner(request.newOwner);
    const fingerprint = JSON.stringify([
      expectedGeneration, newGeneration, newOwner.periodId, newOwner.actor.kind, newOwner.actor.id,
    ]);
    const prior = execution.handoffs[handoffId];
    if (prior) {
      requireThat(prior.fingerprint === fingerprint, 'handoff_id_conflict');
      return clone(prior.result);
    }
    requireThat(execution.status === 'active', 'execution_ended');
    requireThat(expectedGeneration === execution.ownerGeneration, 'stale_owner_generation');
    requireThat(newGeneration === expectedGeneration + 1, 'invalid_owner_generation');
    this.#requireActiveExecution(execution);
    requireThat(ownerKey(newOwner) !== ownerKey(execution.currentOwner), 'same_owner_handoff');
    this.#requireActiveOwner(newOwner);

    const next = clone(this.#state);
    const updated = next.executions[execution.runId];
    updated.currentOwner = newOwner;
    updated.ownerGeneration = newGeneration;
    updated.currentProof = null;
    const result = {
      executionId: execution.runId,
      currentOwner: clone(newOwner),
      ownerGeneration: newGeneration,
    };
    updated.handoffs[handoffId] = { fingerprint, result };
    this.#commit(next);
    return clone(result);
  }

  reconcileExecution(runId, evidence) {
    const execution = this.#execution(runId);
    requireKeys(
      evidence,
      [
        'launchId', 'runId', 'attemptId', 'provider', 'origin', 'purpose', 'originBinding',
        'currentOwner', 'ownerGeneration', 'connectionGeneration', 'verified',
      ],
      'invalid_execution_reconciliation',
    );
    requireThat(evidence.verified === true, 'reconciliation_unverified');
    requireThat(
      evidence.launchId === execution.launchId
        && evidence.runId === execution.runId
        && evidence.attemptId === execution.attemptId
        && evidence.provider === execution.provider
        && evidence.origin === execution.origin
        && evidence.purpose === execution.purpose
        && JSON.stringify(evidence.originBinding) === JSON.stringify(execution.originBinding),
      'origin_proof_mismatch',
    );
    const owner = normalizeOwner(evidence.currentOwner);
    requireThat(ownerKey(owner) === ownerKey(execution.currentOwner), 'owner_proof_mismatch');
    requireThat(
      evidence.ownerGeneration === execution.ownerGeneration,
      'owner_generation_proof_mismatch',
    );
    const period = this.#period(owner.periodId);
    const conversation = this.#state.conversations[period.conversationKey];
    requireThat(
      evidence.connectionGeneration === conversation.connectionGeneration,
      'stale_connection_proof',
    );
    const actor = period.actors[actorKey(owner.actor)];
    requireThat(
      period.status === 'active' && actor && actor.status === 'active',
      'owner_not_active',
    );
    const next = clone(this.#state);
    next.periods[period.id].reconciledConnectionGeneration = conversation.connectionGeneration;
    next.executions[execution.runId].currentProof = makeExecutionProof(
      next.executions[execution.runId],
      conversation.connectionGeneration,
    );
    this.#commit(next);
    return { runId: execution.runId, ownerGeneration: execution.ownerGeneration };
  }

  registerPrNotificationTarget({ targetId, periodId, actor }) {
    const id = identifier(targetId, 'invalid_target_id');
    const owner = this.#requireActiveOwner({ periodId, actor });
    const existing = this.#state.prTargets[id];
    if (existing) {
      requireThat(
        existing.periodId === owner.periodId
          && actorKey(existing.actor) === actorKey(owner.actor),
        'notification_target_conflict',
      );
      return id;
    }
    const next = clone(this.#state);
    next.prTargets[id] = { id, periodId: owner.periodId, actor: owner.actor };
    this.#commit(next);
    return id;
  }

  #createDelivery({
    deliveryAttemptId,
    logicalMessageId,
    kind,
    executionId,
    revision,
    recipient,
    targetId,
    decision,
    payload,
  }) {
    const attemptId = identifier(deliveryAttemptId, 'invalid_delivery_id');
    const messageId = identifier(logicalMessageId, 'invalid_logical_message_id');
    requireThat(!this.#state.deliveryLedger[attemptId], 'delivery_already_registered');
    const execution = this.#execution(executionId);
    requireThat(execution.status === 'active', 'execution_ended');
    positiveInteger(revision, 'invalid_revision');
    requireThat(
      typeof payload === 'string'
        && Buffer.byteLength(payload, 'utf8') <= MAX_PAYLOAD_BYTES,
      'invalid_delivery_payload',
    );
    const candidate = {
      kind,
      executionId: execution.runId,
      logicalMessageId: messageId,
      revision,
      targetId,
    };
    const logicalKey = logicalDeliveryKey(candidate);
    requireThat(
      !Object.values(this.#state.deliveryLedger).some((record) =>
        record.status !== 'superseded_before_send' && logicalDeliveryKey(record) === logicalKey),
      'duplicate_logical_delivery',
    );

    const next = clone(this.#state);
    next.deliveryLedger[attemptId] = {
      deliveryAttemptId: attemptId,
      logicalMessageId: messageId,
      kind,
      executionId: execution.runId,
      revision,
      recipient: {
        periodId: recipient.periodId,
        actor: clone(recipient.actor),
        ownerGeneration: recipient.ownerGeneration,
      },
      targetId,
      status: 'available',
      decision,
      decisionState: decision,
      cancelRequested: false,
      claimId: null,
      acceptedEvidence: null,
      appliedEvidence: null,
    };
    this.#commit(next);
    this.#payloads.set(attemptId, payload);
    return this.#deliveryMetadata(next.deliveryLedger[attemptId]);
  }

  createQuestionDelivery(input) {
    requireKeys(
      input,
      ['deliveryAttemptId', 'logicalMessageId', 'executionId', 'revision', 'decision', 'payload'],
      'invalid_question_delivery',
    );
    const { deliveryAttemptId, logicalMessageId, executionId, revision, decision, payload } = input;
    requireThat(decision === 'chosen' || decision === 'provisional', 'invalid_decision');
    const execution = this.#execution(executionId);
    this.#requireActiveExecution(execution);
    return this.#createDelivery({
      deliveryAttemptId,
      logicalMessageId,
      kind: 'question',
      executionId,
      revision,
      recipient: { ...execution.currentOwner, ownerGeneration: execution.ownerGeneration },
      targetId: null,
      decision,
      payload,
    });
  }

  createResultDelivery(input) {
    requireKeys(
      input,
      ['deliveryAttemptId', 'logicalMessageId', 'executionId', 'revision', 'payload'],
      'invalid_result_delivery',
    );
    const { deliveryAttemptId, logicalMessageId, executionId, revision, payload } = input;
    const execution = this.#execution(executionId);
    this.#requireActiveExecution(execution);
    return this.#createDelivery({
      deliveryAttemptId,
      logicalMessageId,
      kind: 'result',
      executionId,
      revision,
      recipient: { ...execution.currentOwner, ownerGeneration: execution.ownerGeneration },
      targetId: null,
      decision: null,
      payload,
    });
  }

  createPrNotification(input) {
    requireKeys(
      input,
      [
        'deliveryAttemptId', 'logicalMessageId', 'executionId', 'revision', 'targetId', 'payload',
      ],
      'invalid_pr_notification',
    );
    const { deliveryAttemptId, logicalMessageId, executionId, revision, targetId, payload } = input;
    const execution = this.#execution(executionId);
    this.#requireActiveExecution(execution);
    const key = identifier(targetId, 'invalid_target_id');
    const target = this.#state.prTargets[key];
    requireThat(target, 'unknown_notification_target');
    this.#requireActiveOwner({ periodId: target.periodId, actor: target.actor });
    return this.#createDelivery({
      deliveryAttemptId,
      logicalMessageId,
      kind: 'pr-notification',
      executionId,
      revision,
      recipient: { periodId: target.periodId, actor: clone(target.actor), ownerGeneration: null },
      targetId: key,
      decision: null,
      payload,
    });
  }

  #deliveryMetadata(delivery) {
    return {
      deliveryAttemptId: delivery.deliveryAttemptId,
      logicalMessageId: delivery.logicalMessageId,
      kind: delivery.kind,
      executionId: delivery.executionId,
      revision: delivery.revision,
      recipient: clone(delivery.recipient),
      targetId: delivery.targetId,
      status: delivery.status,
      decision: delivery.decision,
      decisionState: delivery.decisionState,
      cancelRequested: delivery.cancelRequested,
      claimId: delivery.claimId,
      accepted: delivery.acceptedEvidence !== null,
      applied: delivery.appliedEvidence !== null,
    };
  }

  deliveryMetadata(deliveryAttemptId) {
    return this.#deliveryMetadata(this.#delivery(deliveryAttemptId));
  }

  claimDelivery(deliveryAttemptId, claimIdValue) {
    const delivery = this.#delivery(deliveryAttemptId);
    const claimId = identifier(claimIdValue, 'invalid_claim_id');
    if (delivery.status === 'claimed' && delivery.claimId === claimId) {
      return this.#deliveryMetadata(delivery);
    }
    requireThat(delivery.status === 'available', 'delivery_not_claimable');
    const next = clone(this.#state);
    next.deliveryLedger[delivery.deliveryAttemptId].status = 'claimed';
    next.deliveryLedger[delivery.deliveryAttemptId].claimId = claimId;
    this.#commit(next);
    return this.#deliveryMetadata(next.deliveryLedger[delivery.deliveryAttemptId]);
  }

  cancelQuestion(deliveryAttemptId) {
    const delivery = this.#delivery(deliveryAttemptId);
    requireThat(delivery.kind === 'question', 'not_a_question_delivery');
    if (delivery.status === 'cancelled_before_send' || delivery.cancelRequested) {
      return this.#deliveryMetadata(delivery);
    }
    const next = clone(this.#state);
    const updated = next.deliveryLedger[delivery.deliveryAttemptId];
    if (updated.status === 'available' || updated.status === 'claimed') {
      updated.status = 'cancelled_before_send';
      updated.decisionState = 'cancelled';
    } else {
      updated.cancelRequested = true;
    }
    this.#commit(next);
    return this.#deliveryMetadata(updated);
  }

  supersedeUnsentDelivery(deliveryAttemptId) {
    const delivery = this.#delivery(deliveryAttemptId);
    requireThat(
      delivery.status === 'available' || delivery.status === 'claimed',
      'delivery_not_supersedable',
    );
    const next = clone(this.#state);
    next.deliveryLedger[delivery.deliveryAttemptId].status = 'superseded_before_send';
    this.#commit(next);
    this.#payloads.delete(delivery.deliveryAttemptId);
    return this.#deliveryMetadata(next.deliveryLedger[delivery.deliveryAttemptId]);
  }
  #requireDeliveryRoute(delivery, state = this.#state) {
    const execution = this.#execution(delivery.executionId, state);
    this.#requireActiveExecution(execution, state);
    const recipient = normalizeOwner({
      periodId: delivery.recipient.periodId,
      actor: delivery.recipient.actor,
    });
    if (delivery.kind === 'pr-notification') {
      const target = state.prTargets[delivery.targetId];
      requireThat(
        target
          && target.periodId === recipient.periodId
          && actorKey(target.actor) === actorKey(recipient.actor),
        'notification_target_changed',
      );
      return this.#requireActiveOwner(recipient, state);
    }
    requireThat(
      execution.currentOwner.periodId === recipient.periodId
        && actorKey(execution.currentOwner.actor) === actorKey(recipient.actor)
        && execution.ownerGeneration === delivery.recipient.ownerGeneration,
      'delivery_owner_changed',
    );
    return this.#requireActiveOwner(recipient, state);
  }

  sendStart(deliveryAttemptId) {
    const delivery = this.#delivery(deliveryAttemptId);
    requireThat(
      delivery.status === 'available' || delivery.status === 'claimed',
      'delivery_not_sendable',
    );
    this.#requireDeliveryRoute(delivery);
    requireThat(this.#payloads.has(delivery.deliveryAttemptId), 'delivery_payload_unavailable');
    const next = clone(this.#state);
    next.deliveryLedger[delivery.deliveryAttemptId].status = 'sending';
    this.#commit(next);
    const payload = this.#payloads.get(delivery.deliveryAttemptId);
    this.#payloads.delete(delivery.deliveryAttemptId);
    return {
      deliveryAttemptId: delivery.deliveryAttemptId,
      kind: delivery.kind,
      recipient: clone(delivery.recipient),
      payload,
    };
  }

  recordDeliveryEvidence(deliveryAttemptId, { stage, ...evidence }) {
    requireThat(stage === 'accepted' || stage === 'applied', 'invalid_evidence_stage');
    const delivery = this.#delivery(deliveryAttemptId);
    requireThat(
      delivery.status === 'sending'
        || delivery.status === 'accepted'
        || delivery.status === 'unknown'
        || delivery.status === 'applied',
      'delivery_not_in_flight',
    );
    const normalized = normalizeEvidence(evidence, delivery);
    const field = stage === 'accepted' ? 'acceptedEvidence' : 'appliedEvidence';
    const existing = delivery[field];
    if (existing) {
      requireThat(JSON.stringify(existing) === JSON.stringify(normalized), 'evidence_conflict');
      return this.#deliveryMetadata(delivery);
    }
    const next = clone(this.#state);
    const updated = next.deliveryLedger[delivery.deliveryAttemptId];
    updated[field] = normalized;
    if (stage === 'accepted' && updated.status !== 'applied') updated.status = 'accepted';
    if (stage === 'applied') updated.status = 'applied';
    this.#commit(next);
    return this.#deliveryMetadata(updated);
  }
}

module.exports = {
  ContractModel,
  MAX_CHECKPOINT_BYTES,
  MAX_PAYLOAD_BYTES,
};
