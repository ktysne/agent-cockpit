'use strict';

const { createHash } = require('node:crypto');
const { digestPayload } = require('../codex-instruction-delivery/delivery-model');

const SCHEMA = 'agent-cockpit-poc162-recovery-v1';
const PROVIDER = 'codex';
const MAX_BINDINGS = 128;
const MAX_RECORDS = 512;
const MAX_EVENTS = 1024;
const MAX_DELIVERY_EVIDENCE = 64;
const MAX_VALUE_BYTES = 16 * 1024;
const MAX_CHECKPOINT_BYTES = 128 * 1024;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL_PREFIX = /^\s*(?:bearer(?:\s+|:)|basic(?:\s+|:)|token(?:\s+|:)|sk-\S+|gh[pousr]_\S+|github_pat_\S+|xox[baprs]-\S+|ya29\.\S+|eyj[a-z0-9_-]+\.[a-z0-9_-]+|(?:api[_-]?key|access[_-]?token|secret)\s*[:=])/i;
const CREDENTIAL_MATERIAL = /\b(?:bearer\s+[A-Za-z0-9._~+/-]{12,}|(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9_-]{8,}|github_pat_[A-Za-z0-9_-]{8,}|xox[baprs]-[A-Za-z0-9_-]{8,}|ya29\.[A-Za-z0-9._-]{8,})|(?:api[_-]?key|access[_-]?token|secret|password)\s*[:=]\s*\S+)/i;
const SENSITIVE_KEY = /(?:authorization|access[_-]?token|secret|password|credential|environment|(^|_)env($|_)|(^|_)cwd($|_)|(^|_)pid($|_)|(^|[_-])token($|[_-])|(^|[_-])auth($|[_-])|(^|[_-])api[_-]?key($|[_-]))/i;
const PARENT_PROVIDERS = new Set(['claude', 'codex']);
const ORIGINS = new Set(['standalone', 'delegated', 'review']);
const RUN_STATES = new Set(['active', 'unknown', 'ended']);
const PLAN_STATES = new Set(['active', 'unknown', 'completed', 'cancelled']);
const QUESTION_STATES = new Set(['pending', 'unknown', 'resolved', 'cancelled']);
const DELIVERY_STATES = new Set(['registered', 'sending', 'accepted', 'unknown', 'applied', 'resolved', 'ended', 'cancelled']);
const DELIVERY_TARGETS = new Set(['turn_start', 'expected_turn', 'existing_turn']);
const THREAD_STATES = new Set(['active', 'idle', 'ended', 'unknown']);
const STREAMS = new Set(['bridge', 'native', 'hook']);
const RECORD_TYPES = new Set(['run', 'plan', 'question', 'delivery']);
const ITEM_TYPES = new Set(['user_input']);
const PROOF_UNAVAILABLE_REASONS = new Set(['collector_disconnected', 'cockpit_restarted', 'hook_failed',
  'native_probe_failed', 'current_state_unavailable']);
const INVALID = Symbol('invalid');

function isRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function hasOnlyKeys(value, allowed) {
  if (!isRecord(value)) return false;
  try {
    return Reflect.ownKeys(value).every((key) => {
      if (typeof key !== 'string' || !allowed.has(key)) return false;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && Object.hasOwn(descriptor, 'value');
    });
  } catch {
    return false;
  }
}

function safeId(value) {
  return typeof value === 'string' && IDENTIFIER.test(value) && !CREDENTIAL_PREFIX.test(value);
}

function hash(value) {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function sensitiveKey(key) {
  return SENSITIVE_KEY.test(key) || key.toLowerCase() === 'auth';
}

function normalizeJson(value, context, depth = 0) {
  context.nodes += 1;
  if (context.nodes > 256 || depth > 8) return INVALID;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES || CREDENTIAL_MATERIAL.test(value)) return INVALID;
    return value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID;
  if (typeof value !== 'object' || context.visiting.has(value)) return INVALID;
  context.visiting.add(value);
  let normalized = INVALID;
  if (Array.isArray(value)) {
    try {
      const keys = Reflect.ownKeys(value);
      const result = [];
      let valid = value.length <= 256 && keys.length === value.length + 1 && keys.includes('length');
      for (let index = 0; valid && index < value.length; index += 1) {
        const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
          valid = false;
          break;
        }
        const item = normalizeJson(descriptor.value, context, depth + 1);
        if (item === INVALID) {
          valid = false;
          break;
        }
        result.push(item);
      }
      if (valid) normalized = result;
    } catch {
      normalized = INVALID;
    }
  } else if (isRecord(value)) {
    const keys = Reflect.ownKeys(value);
    const result = {};
    let valid = keys.length <= 256 && keys.every((key) => typeof key === 'string');
    for (const key of valid ? keys.sort() : []) {
      if (!key || key.length > 128 || sensitiveKey(key) || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        valid = false;
        break;
      }
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        valid = false;
        break;
      }
      const item = normalizeJson(descriptor.value, context, depth + 1);
      if (item === INVALID) {
        valid = false;
        break;
      }
      result[key] = item;
    }
    if (valid) normalized = result;
  }
  context.visiting.delete(value);
  return normalized;
}

function normalizeData(value, allowString = false) {
  try {
    if (allowString && typeof value === 'string') {
      if (!value.trim() || Buffer.byteLength(value, 'utf8') > MAX_VALUE_BYTES || CREDENTIAL_MATERIAL.test(value)) return null;
      return value;
    }
    if (!isRecord(value) || Reflect.ownKeys(value).length === 0) return null;
    const normalized = normalizeJson(value, { nodes: 0, visiting: new Set() });
    if (!isRecord(normalized) || Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_VALUE_BYTES) return null;
    return normalized;
  } catch {
    return null;
  }
}

function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clone(item)]));
  return value;
}

function normalizeParent(value, origin) {
  if (value === undefined || value === null) return origin === 'standalone' ? null : INVALID;
  if (!hasOnlyKeys(value, new Set(['provider', 'sessionId', 'agentId', 'toolUseId']))
    || !PARENT_PROVIDERS.has(value.provider) || !safeId(value.sessionId)) return INVALID;
  const parent = { provider: value.provider, sessionId: value.sessionId };
  for (const key of ['agentId', 'toolUseId']) {
    if (value[key] !== undefined && value[key] !== null) {
      if (!safeId(value[key])) return INVALID;
      parent[key] = value[key];
    }
  }
  if (!parent.agentId && !parent.toolUseId) return INVALID;
  return parent;
}

function normalizeBinding(value) {
  if (!hasOnlyKeys(value, new Set(['provider', 'hostId', 'homeScope', 'threadId', 'launchId', 'runId', 'attemptId', 'origin', 'parent']))
    || value.provider !== PROVIDER || !ORIGINS.has(value.origin)
    || !['hostId', 'homeScope', 'threadId', 'launchId', 'runId', 'attemptId'].every((key) => safeId(value[key]))) return null;
  const parent = normalizeParent(value.parent, value.origin);
  if (parent === INVALID) return null;
  return {
    provider: PROVIDER,
    hostId: value.hostId,
    homeScope: value.homeScope,
    threadId: value.threadId,
    launchId: value.launchId,
    runId: value.runId,
    attemptId: value.attemptId,
    origin: value.origin,
    parent,
  };
}

function bindingKey(binding) {
  return JSON.stringify([binding.provider, binding.hostId, binding.homeScope, binding.threadId,
    binding.launchId, binding.runId, binding.attemptId]);
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function normalizePlan(value) {
  if (!hasOnlyKeys(value, new Set(['planId', 'state', 'data', 'restoredFromState']))
    || !safeId(value.planId) || !PLAN_STATES.has(value.state)) return null;
  const data = normalizeData(value.data);
  if (!data) return null;
  const result = { planId: value.planId, state: value.state, data };
  if (value.restoredFromState !== undefined) {
    if (value.restoredFromState !== 'active') return null;
    result.restoredFromState = value.restoredFromState;
  }
  return result;
}

function normalizeQuestion(value) {
  if (!hasOnlyKeys(value, new Set(['questionId', 'state', 'data', 'restoredFromState']))
    || !safeId(value.questionId) || !QUESTION_STATES.has(value.state)) return null;
  const data = normalizeData(value.data);
  if (!data) return null;
  const result = { questionId: value.questionId, state: value.state, data };
  if (value.restoredFromState !== undefined) {
    if (value.restoredFromState !== 'pending') return null;
    result.restoredFromState = value.restoredFromState;
  }
  return result;
}

function normalizeAppliedEvidence(value) {
  if (value === null) return null;
  if (!hasOnlyKeys(value, new Set(['turnId', 'itemId', 'itemType'])) || !safeId(value.turnId)
    || !safeId(value.itemId) || !ITEM_TYPES.has(value.itemType)) return INVALID;
  return { turnId: value.turnId, itemId: value.itemId, itemType: value.itemType };
}

function normalizeDelivery(value) {
  const allowed = new Set(['requestId', 'deliveryId', 'state', 'target', 'targetTurnId', 'questionId',
    'payload', 'payloadDigest', 'acceptedTurnId', 'appliedEvidence', 'restoredFromState']);
  if (!hasOnlyKeys(value, allowed) || !safeId(value.requestId) || !DELIVERY_STATES.has(value.state)
    || !DELIVERY_TARGETS.has(value.target)) return null;
  const deliveryId = value.deliveryId === null ? null : safeId(value.deliveryId) ? value.deliveryId : INVALID;
  const targetTurnId = value.targetTurnId === null ? null : safeId(value.targetTurnId) ? value.targetTurnId : INVALID;
  const questionId = value.questionId === null ? null : safeId(value.questionId) ? value.questionId : INVALID;
  const acceptedTurnId = value.acceptedTurnId === null ? null : safeId(value.acceptedTurnId) ? value.acceptedTurnId : INVALID;
  const payload = normalizeData(value.payload, true);
  const payloadDigest = digestPayload(payload);
  if (deliveryId === INVALID || targetTurnId === INVALID || questionId === INVALID || acceptedTurnId === INVALID
    || !payload || !payloadDigest || value.payloadDigest !== undefined && value.payloadDigest !== payloadDigest
    || (value.target === 'turn_start' ? targetTurnId !== null : targetTurnId === null)) return null;
  const appliedEvidence = normalizeAppliedEvidence(value.appliedEvidence === undefined ? null : value.appliedEvidence);
  if (appliedEvidence === INVALID) return null;
  if (value.state === 'registered' && (deliveryId !== null || acceptedTurnId !== null || appliedEvidence !== null)) return null;
  if (['sending', 'accepted', 'unknown', 'applied'].includes(value.state) && !deliveryId) return null;
  if (['accepted', 'applied'].includes(value.state) && !acceptedTurnId) return null;
  if (value.state === 'applied' && (!appliedEvidence || appliedEvidence.turnId !== acceptedTurnId)) return null;
  if (value.state !== 'applied' && appliedEvidence !== null) return null;
  const result = {
    requestId: value.requestId,
    deliveryId,
    state: value.state,
    target: value.target,
    targetTurnId,
    questionId,
    payload,
    payloadDigest,
    acceptedTurnId,
    appliedEvidence,
  };
  if (value.restoredFromState !== undefined) {
    if (!['sending', 'accepted'].includes(value.restoredFromState)) return null;
    result.restoredFromState = value.restoredFromState;
  }
  return result;
}

function normalizeNativeIdentity(value) {
  if (!hasOnlyKeys(value, new Set(['provider', 'hostId', 'homeScope', 'threadId']))
    || value.provider !== PROVIDER || !safeId(value.hostId) || !safeId(value.homeScope) || !safeId(value.threadId)) return null;
  return { provider: PROVIDER, hostId: value.hostId, homeScope: value.homeScope, threadId: value.threadId };
}

function normalizeProofEvidence(value) {
  if (!hasOnlyKeys(value, new Set(['requestId', 'deliveryId', 'turnId', 'itemId', 'itemType', 'payloadDigest']))
    || !safeId(value.requestId) || !safeId(value.deliveryId) || !safeId(value.turnId) || !safeId(value.itemId)
    || !ITEM_TYPES.has(value.itemType) || typeof value.payloadDigest !== 'string' || !/^[a-f0-9]{64}$/.test(value.payloadDigest)) return null;
  return { requestId: value.requestId, deliveryId: value.deliveryId, turnId: value.turnId, itemId: value.itemId,
    itemType: value.itemType, payloadDigest: value.payloadDigest };
}

function normalizeEventRecord(recordType, value) {
  if (!RECORD_TYPES.has(recordType)) return null;
  if (recordType === 'run') {
    return hasOnlyKeys(value, new Set(['state'])) && RUN_STATES.has(value.state) ? { state: value.state } : null;
  }
  if (recordType === 'plan') return normalizePlan(value);
  if (recordType === 'question') return normalizeQuestion(value);
  return normalizeDelivery(value);
}

function serializedBindingRecord(record) {
  const result = {
    binding: clone(record.binding),
    runState: record.runState,
    plans: [...record.plans.values()].sort((a, b) => a.planId.localeCompare(b.planId)).map(clone),
    questions: [...record.questions.values()].sort((a, b) => a.questionId.localeCompare(b.questionId)).map(clone),
    deliveries: [...record.deliveries.values()].sort((a, b) => a.requestId.localeCompare(b.requestId)).map(clone),
  };
  if (record.restoredFromRunState) result.restoredFromRunState = record.restoredFromRunState;
  return result;
}

function normalizeCheckpoint(value) {
  try {
    if (!hasOnlyKeys(value, new Set(['schema', 'version', 'bindings', 'streams', 'events']))
      || value.schema !== SCHEMA || value.version !== 1
      || !Array.isArray(value.bindings) || value.bindings.length > MAX_BINDINGS
      || !Array.isArray(value.streams) || value.streams.length > MAX_BINDINGS * STREAMS.size
      || !Array.isArray(value.events) || value.events.length > MAX_EVENTS) return null;
    const bindings = [];
    const bindingKeys = new Set();
    let totalRecords = 0;
    for (const row of value.bindings) {
      if (!hasOnlyKeys(row, new Set(['binding', 'runState', 'restoredFromRunState', 'plans', 'questions', 'deliveries']))
        || !RUN_STATES.has(row.runState) || !Array.isArray(row.plans) || !Array.isArray(row.questions) || !Array.isArray(row.deliveries)) return null;
      const binding = normalizeBinding(row.binding);
      if (!binding) return null;
      const key = bindingKey(binding);
      if (bindingKeys.has(key)) return null;
      bindingKeys.add(key);
      if (row.restoredFromRunState !== undefined && row.restoredFromRunState !== 'active') return null;
      if (row.plans.length + row.questions.length + row.deliveries.length + totalRecords > MAX_RECORDS) return null;
      const plans = row.plans.map(normalizePlan);
      const questions = row.questions.map(normalizeQuestion);
      const deliveries = row.deliveries.map(normalizeDelivery);
      if (plans.some((item) => !item) || questions.some((item) => !item) || deliveries.some((item) => !item)) return null;
      if (new Set(plans.map((item) => item.planId)).size !== plans.length
        || new Set(questions.map((item) => item.questionId)).size !== questions.length
        || new Set(deliveries.map((item) => item.requestId)).size !== deliveries.length) return null;
      totalRecords += plans.length + questions.length + deliveries.length;
      if (totalRecords > MAX_RECORDS) return null;
      bindings.push({
        binding,
        runState: row.runState,
        ...(row.restoredFromRunState ? { restoredFromRunState: row.restoredFromRunState } : {}),
        plans,
        questions,
        deliveries,
      });
    }
    const streams = [];
    const streamKeys = new Set();
    for (const row of value.streams) {
      if (!hasOnlyKeys(row, new Set(['bindingKey', 'stream', 'generation', 'ordinal']))
        || !bindingKeys.has(row.bindingKey) || !STREAMS.has(row.stream)
        || !Number.isSafeInteger(row.generation) || row.generation < 0
        || !Number.isSafeInteger(row.ordinal) || row.ordinal < 1) return null;
      const key = JSON.stringify([row.bindingKey, row.stream]);
      if (streamKeys.has(key)) return null;
      streamKeys.add(key);
      streams.push({ bindingKey: row.bindingKey, stream: row.stream, generation: row.generation, ordinal: row.ordinal });
    }
    const events = [];
    const eventKeys = new Set();
    for (const row of value.events) {
      if (!hasOnlyKeys(row, new Set(['bindingKey', 'stream', 'generation', 'ordinal', 'eventId', 'fingerprint']))
        || !bindingKeys.has(row.bindingKey) || !STREAMS.has(row.stream)
        || !Number.isSafeInteger(row.generation) || row.generation < 0
        || !Number.isSafeInteger(row.ordinal) || row.ordinal < 1 || !safeId(row.eventId)
        || typeof row.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(row.fingerprint)) return null;
      const key = JSON.stringify([row.bindingKey, row.stream, row.generation, row.eventId]);
      if (eventKeys.has(key)) return null;
      eventKeys.add(key);
      const cursor = streams.find((item) => item.bindingKey === row.bindingKey && item.stream === row.stream);
      if (!cursor || row.generation > cursor.generation
        || row.generation === cursor.generation && row.ordinal > cursor.ordinal) return null;
      events.push({ bindingKey: row.bindingKey, stream: row.stream, generation: row.generation,
        ordinal: row.ordinal, eventId: row.eventId, fingerprint: row.fingerprint });
    }
    const normalized = {
      schema: SCHEMA,
      version: 1,
      bindings: bindings.sort((a, b) => bindingKey(a.binding).localeCompare(bindingKey(b.binding))),
      streams: streams.sort((a, b) => JSON.stringify([a.bindingKey, a.stream]).localeCompare(JSON.stringify([b.bindingKey, b.stream]))),
      events: events.sort((a, b) => JSON.stringify([a.bindingKey, a.stream, a.generation, a.ordinal]).localeCompare(JSON.stringify([b.bindingKey, b.stream, b.generation, b.ordinal]))),
    };
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > MAX_CHECKPOINT_BYTES) return null;
    return normalized;
  } catch {
    return null;
  }
}

function validateCheckpoint(value) {
  return normalizeCheckpoint(value) !== null;
}

function terminalState(recordType, state) {
  if (recordType === 'run') return state === 'ended';
  if (recordType === 'plan') return ['completed', 'cancelled'].includes(state);
  if (recordType === 'question') return ['resolved', 'cancelled'].includes(state);
  return ['applied', 'resolved', 'ended', 'cancelled'].includes(state);
}

function sameBinding(left, right) {
  return Boolean(left && right && sameJson(left, right));
}

class RecoveryModel {
  constructor(options = {}) {
    if (!hasOnlyKeys(options, new Set())) throw new TypeError('invalid model options');
    this.bindings = new Map();
    this.streams = new Map();
    this.events = new Map();
  }

  static validateCheckpoint(value) {
    return validateCheckpoint(value);
  }

  static restore(value) {
    const checkpoint = normalizeCheckpoint(value);
    if (!checkpoint) return null;
    const model = new RecoveryModel();
    for (const row of checkpoint.bindings) {
      const binding = clone(row.binding);
      const key = bindingKey(binding);
      const originalRunState = row.restoredFromRunState || row.runState;
      const runState = row.runState === 'active' ? 'unknown' : row.runState;
      const record = {
        binding,
        runState,
        restoredFromRunState: row.restoredFromRunState || (row.runState === 'active' ? 'active' : null),
        reconciliation: { status: 'unverified', reason: 'checkpoint_restored', threadState: 'unknown', activeTurnId: null,
          waitingForQuestion: null, waitingForApproval: null },
        plans: new Map(),
        questions: new Map(),
        deliveries: new Map(),
      };
      for (const plan of row.plans) {
        const restored = clone(plan);
        if (restored.state === 'active' && !restored.restoredFromState) restored.restoredFromState = 'active';
        record.plans.set(restored.planId, restored);
      }
      for (const question of row.questions) {
        const restored = clone(question);
        if (restored.state === 'pending') {
          restored.state = 'unknown';
          restored.restoredFromState ||= 'pending';
        }
        record.questions.set(restored.questionId, restored);
      }
      for (const delivery of row.deliveries) {
        const restored = clone(delivery);
        if (['sending', 'accepted'].includes(restored.state)) {
          restored.restoredFromState = restored.state;
          restored.state = 'unknown';
        }
        record.deliveries.set(restored.requestId, restored);
      }
      if (!RUN_STATES.has(originalRunState)) return null;
      model.bindings.set(key, record);
    }
    for (const stream of checkpoint.streams) {
      model.streams.set(JSON.stringify([stream.bindingKey, stream.stream]), {
        bindingKey: stream.bindingKey, stream: stream.stream, generation: stream.generation, ordinal: stream.ordinal,
      });
    }
    for (const event of checkpoint.events) {
      const key = JSON.stringify([event.bindingKey, event.stream, event.generation, event.eventId]);
      model.events.set(key, clone(event));
    }
    return model;
  }

  registerBinding(input) {
    const binding = normalizeBinding(input);
    if (!binding) return { accepted: false, reason: 'invalid_binding' };
    const key = bindingKey(binding);
    const existing = this.bindings.get(key);
    if (existing) {
      return sameBinding(existing.binding, binding)
        ? { accepted: true, reason: 'duplicate_binding', binding: clone(existing.binding) }
        : { accepted: false, reason: 'binding_conflict' };
    }
    if (this.bindings.size >= MAX_BINDINGS) return { accepted: false, reason: 'binding_capacity' };
    const before = this.captureRuntimeState();
    this.bindings.set(key, {
      binding,
      runState: 'unknown',
      restoredFromRunState: null,
      reconciliation: { status: 'unverified', reason: 'current_proof_required', threadState: 'unknown', activeTurnId: null,
        waitingForQuestion: null, waitingForApproval: null },
      plans: new Map(),
      questions: new Map(),
      deliveries: new Map(),
    });
    if (!this.checkpoint() && this.rollback(before)) return { accepted: false, reason: 'checkpoint_capacity' };
    return { accepted: true, reason: 'registered', binding: clone(binding) };
  }

  upsertPlan(input) {
    if (!hasOnlyKeys(input, new Set(['binding', 'plan']))) return { accepted: false, reason: 'invalid_input' };
    const record = this.findBinding(input.binding);
    const plan = normalizePlan(input.plan);
    if (!record || !plan) return { accepted: false, reason: record ? 'invalid_plan' : 'binding_not_found' };
    const existing = record.plans.get(plan.planId);
    if (existing && terminalState('plan', existing.state)) {
      return sameJson(existing, plan) ? this.upsertSuccess('duplicate_plan', existing) : this.upsertSuccess('terminal_preserved', existing);
    }
    if (this.totalRecords() >= MAX_RECORDS && !existing) return { accepted: false, reason: 'record_capacity' };
    const before = this.captureRuntimeState();
    record.plans.set(plan.planId, clone(plan));
    if (!this.checkpoint() && this.rollback(before)) return { accepted: false, reason: 'checkpoint_capacity' };
    return this.upsertSuccess(existing ? 'updated' : 'registered', plan);
  }

  upsertQuestion(input) {
    if (!hasOnlyKeys(input, new Set(['binding', 'question']))) return { accepted: false, reason: 'invalid_input' };
    const record = this.findBinding(input.binding);
    const question = normalizeQuestion(input.question);
    if (!record || !question) return { accepted: false, reason: record ? 'invalid_question' : 'binding_not_found' };
    const existing = record.questions.get(question.questionId);
    if (existing && terminalState('question', existing.state)) {
      return sameJson(existing, question) ? this.upsertSuccess('duplicate_question', existing) : this.upsertSuccess('terminal_preserved', existing);
    }
    if (this.totalRecords() >= MAX_RECORDS && !existing) return { accepted: false, reason: 'record_capacity' };
    const before = this.captureRuntimeState();
    record.questions.set(question.questionId, clone(question));
    if (!this.checkpoint() && this.rollback(before)) return { accepted: false, reason: 'checkpoint_capacity' };
    return this.upsertSuccess(existing ? 'updated' : 'registered', question);
  }

  upsertDelivery(input) {
    if (!hasOnlyKeys(input, new Set(['binding', 'delivery']))) return { accepted: false, reason: 'invalid_input' };
    const record = this.findBinding(input.binding);
    const delivery = normalizeDelivery(input.delivery);
    if (!record || !delivery) return { accepted: false, reason: record ? 'invalid_delivery' : 'binding_not_found' };
    const before = this.captureRuntimeState();
    const result = this.applyDelivery(record, delivery, false);
    if (!result.accepted) return result;
    if (!this.checkpoint() && this.rollback(before)) return { accepted: false, reason: 'checkpoint_capacity' };
    return this.upsertSuccess(result.reason, record.deliveries.get(delivery.requestId));
  }

  ingestEvent(input) {
    const allowed = new Set(['binding', 'stream', 'generation', 'ordinal', 'eventId', 'recordType', 'record']);
    if (!hasOnlyKeys(input, allowed) || !STREAMS.has(input.stream) || !Number.isSafeInteger(input.generation)
      || input.generation < 0 || !Number.isSafeInteger(input.ordinal) || input.ordinal < 1 || !safeId(input.eventId)
      || !RECORD_TYPES.has(input.recordType)) return { accepted: false, reason: 'invalid_event' };
    const context = this.findBinding(input.binding);
    if (!context) return { accepted: false, reason: 'binding_not_found' };
    const normalizedRecord = normalizeEventRecord(input.recordType, input.record);
    if (!normalizedRecord) return { accepted: false, reason: 'invalid_event_record' };
    const key = bindingKey(context.binding);
    const eventKey = JSON.stringify([key, input.stream, input.generation, input.eventId]);
    const fingerprint = hash({ bindingKey: key, stream: input.stream, generation: input.generation,
      ordinal: input.ordinal, eventId: input.eventId, recordType: input.recordType, record: normalizedRecord });
    const previous = this.events.get(eventKey);
    if (previous) return previous.fingerprint === fingerprint
      ? { accepted: true, reason: 'duplicate_event' }
      : { accepted: false, reason: 'event_id_conflict' };
    if (this.events.size >= MAX_EVENTS) return { accepted: false, reason: 'event_capacity' };
    const streamKey = JSON.stringify([key, input.stream]);
    const cursor = this.streams.get(streamKey);
    if (cursor && input.generation < cursor.generation) return { accepted: false, reason: 'stale_generation' };
    if (cursor && input.generation === cursor.generation && input.ordinal < cursor.ordinal) {
      return { accepted: false, reason: 'stale_event_order' };
    }
    if (cursor && input.generation === cursor.generation && input.ordinal === cursor.ordinal) {
      return { accepted: false, reason: 'event_order_conflict' };
    }
    const before = this.captureRuntimeState();
    const applied = this.applyEventRecord(context, input.recordType, normalizedRecord);
    if (!applied.accepted) return applied;
    this.events.set(eventKey, { bindingKey: key, stream: input.stream, generation: input.generation,
      ordinal: input.ordinal, eventId: input.eventId, fingerprint });
    this.streams.set(streamKey, { bindingKey: key, stream: input.stream,
      generation: input.generation, ordinal: input.ordinal });
    if (!this.checkpoint() && this.rollback(before)) return { accepted: false, reason: 'checkpoint_capacity' };
    return { accepted: true, reason: applied.reason };
  }

  reconcileCurrent(input) {
    if (!hasOnlyKeys(input, new Set(['binding', 'currentBridgeRegistration', 'currentNativeProof']))) {
      const possibleRecord = isRecord(input) ? this.findBinding(input.binding) : null;
      if (possibleRecord) this.unverified(possibleRecord, 'invalid_input');
      return { accepted: false, reason: 'invalid_input' };
    }
    const record = this.findBinding(input.binding);
    if (!record) return { accepted: false, reason: 'binding_not_found' };
    const bridge = input.currentBridgeRegistration;
    if (!hasOnlyKeys(bridge, new Set(['registered', 'binding', 'runState'])) || typeof bridge.registered !== 'boolean'
      || !RUN_STATES.has(bridge.runState)) {
      return this.unverified(record, 'invalid_bridge_registration');
    }
    const currentBinding = normalizeBinding(bridge.binding);
    if (bridge.registered !== true || !currentBinding || !sameBinding(currentBinding, record.binding)) {
      return this.unverified(record, 'bridge_binding_mismatch');
    }
    if (bridge.runState === 'unknown') return this.unverified(record, 'bridge_run_state_unknown');
    const proof = input.currentNativeProof;
    if (!hasOnlyKeys(proof, new Set(['source', 'identity', 'threadState', 'activeTurnId', 'endObserved',
      'waitingForQuestion', 'waitingForApproval', 'deliveryEvidence']))
      || !['current_loaded', 'history', 'not_loaded', 'missing_end'].includes(proof.source)
      || !THREAD_STATES.has(proof.threadState)
      || (proof.activeTurnId !== null && !safeId(proof.activeTurnId))
      || typeof proof.endObserved !== 'boolean'
      || ![true, false, null].includes(proof.waitingForQuestion)
      || ![true, false, null].includes(proof.waitingForApproval)) return this.unverified(record, 'invalid_native_proof');
    const nativeIdentity = normalizeNativeIdentity(proof.identity);
    if (!nativeIdentity || !sameJson(nativeIdentity, {
      provider: record.binding.provider, hostId: record.binding.hostId,
      homeScope: record.binding.homeScope, threadId: record.binding.threadId,
    })) return this.unverified(record, 'native_identity_mismatch');
    if (proof.source !== 'current_loaded') {
      const reason = proof.source === 'history' ? 'history_is_not_current'
        : proof.source === 'not_loaded' ? 'thread_not_loaded' : 'missing_end_event';
      return this.unverified(record, reason);
    }
    if (proof.threadState === 'unknown'
      || (proof.threadState === 'active' && !safeId(proof.activeTurnId))
      || (proof.threadState !== 'active' && proof.activeTurnId !== null)
      || (proof.threadState === 'ended' && !proof.endObserved)) return this.unverified(record, 'current_state_incomplete');
    const evidence = proof.deliveryEvidence === undefined ? [] : proof.deliveryEvidence;
    if (!Array.isArray(evidence) || evidence.length > MAX_DELIVERY_EVIDENCE) return this.unverified(record, 'invalid_native_proof');
    const normalizedEvidence = evidence.map(normalizeProofEvidence);
    if (normalizedEvidence.some((item) => !item)) return this.unverified(record, 'invalid_native_proof');

    const before = this.captureRuntimeState();
    record.reconciliation = { status: 'verified_current', reason: null,
      threadState: proof.threadState, activeTurnId: proof.activeTurnId,
      waitingForQuestion: proof.waitingForQuestion, waitingForApproval: proof.waitingForApproval };
    if (record.runState !== 'ended' && (bridge.runState === 'ended'
      || proof.threadState === 'ended' && proof.endObserved)) {
      record.runState = 'ended';
      record.restoredFromRunState = null;
    } else if (record.runState !== 'ended' && bridge.runState === 'active') {
      record.runState = 'active';
      record.restoredFromRunState = null;
    }
    const ordinaryInputAvailable = proof.waitingForQuestion === false && proof.waitingForApproval === false;
    const applied = ordinaryInputAvailable ? this.applyCurrentDeliveryEvidence(record, normalizedEvidence) : 0;
    if (!this.checkpoint() && this.rollback(before)) {
      this.unverified(this.bindings.get(bindingKey(record.binding)), 'checkpoint_capacity');
      return { accepted: false, reason: 'checkpoint_capacity' };
    }
    return { accepted: true, reason: 'current_identity_verified', appliedDeliveries: applied };
  }

  markCurrentProofUnavailable(input) {
    if (!hasOnlyKeys(input, new Set(['binding', 'reason']))) {
      return { accepted: false, reason: 'invalid_input' };
    }
    const record = this.findBinding(input.binding);
    if (!record) return { accepted: false, reason: 'binding_not_found' };
    const reason = PROOF_UNAVAILABLE_REASONS.has(input.reason) ? input.reason : 'current_state_unavailable';
    this.unverified(record, reason);
    if (!PROOF_UNAVAILABLE_REASONS.has(input.reason)) return { accepted: false, reason: 'invalid_reason' };
    return { accepted: true, reason: input.reason };
  }

  captureRuntimeState() {
    const bindings = new Map();
    for (const [key, record] of this.bindings) {
      bindings.set(key, {
        binding: clone(record.binding),
        runState: record.runState,
        restoredFromRunState: record.restoredFromRunState,
        reconciliation: clone(record.reconciliation),
        plans: new Map([...record.plans].map(([id, value]) => [id, clone(value)])),
        questions: new Map([...record.questions].map(([id, value]) => [id, clone(value)])),
        deliveries: new Map([...record.deliveries].map(([id, value]) => [id, clone(value)])),
      });
    }
    return {
      bindings,
      streams: new Map([...this.streams].map(([key, value]) => [key, clone(value)])),
      events: new Map([...this.events].map(([key, value]) => [key, clone(value)])),
    };
  }

  rollback(snapshot) {
    this.bindings = snapshot.bindings;
    this.streams = snapshot.streams;
    this.events = snapshot.events;
    return true;
  }

  project() {
    const rows = [...this.bindings.values()].sort((a, b) => bindingKey(a.binding).localeCompare(bindingKey(b.binding)))
      .map((record) => ({
        binding: clone(record.binding),
        runState: record.runState,
        restoredFromRunState: record.restoredFromRunState,
        reconciliation: { ...record.reconciliation },
        plans: [...record.plans.values()].map((plan) => ({ ...clone(plan),
          held: plan.state === 'active' && !this.ordinaryInputAvailable(record) })),
        questions: [...record.questions.values()].map((question) => ({ ...clone(question),
          held: ['pending', 'unknown'].includes(question.state) && !this.ordinaryInputAvailable(record) })),
        deliveries: [...record.deliveries.values()].map((delivery) => ({
          ...clone(delivery),
          readyToDeliver: delivery.state === 'registered' && this.deliveryTargetMatches(record, delivery),
          held: ['registered', 'sending', 'accepted', 'unknown'].includes(delivery.state)
            && (delivery.state !== 'registered' || !this.deliveryTargetMatches(record, delivery)),
        })),
      }));
    return { counts: { bindings: rows.length, events: this.events.size }, rows };
  }

  findBinding(input) {
    const binding = normalizeBinding(input);
    if (!binding) return null;
    const record = this.bindings.get(bindingKey(binding));
    return record && sameBinding(record.binding, binding) ? record : null;
  }

  totalRecords() {
    let total = 0;
    for (const record of this.bindings.values()) total += record.plans.size + record.questions.size + record.deliveries.size;
    return total;
  }

  upsertSuccess(reason, value) {
    return { accepted: true, reason, record: clone(value) };
  }

  applyEventRecord(record, recordType, value) {
    if (recordType === 'run') {
      if (record.runState === 'ended' && value.state !== 'ended') return { accepted: true, reason: 'terminal_preserved' };
      if (record.runState === value.state) return { accepted: true, reason: 'duplicate_state' };
      record.runState = value.state;
      record.restoredFromRunState = null;
      return { accepted: true, reason: 'updated' };
    }
    if (recordType === 'plan') return this.upsertPlan({ binding: record.binding, plan: value });
    if (recordType === 'question') return this.upsertQuestion({ binding: record.binding, question: value });
    if (value.state === 'applied') return { accepted: false, reason: 'native_current_proof_required' };
    return this.upsertDelivery({ binding: record.binding, delivery: value });
  }

  applyDelivery(bindingRecord, delivery, fromCurrentProof) {
    if (delivery.state === 'applied' && !fromCurrentProof) return { accepted: false, reason: 'native_current_proof_required' };
    const existing = bindingRecord.deliveries.get(delivery.requestId);
    if (existing) {
      if (existing.deliveryId && delivery.deliveryId && existing.deliveryId !== delivery.deliveryId) {
        return { accepted: false, reason: 'delivery_identity_conflict' };
      }
      if (existing.target !== delivery.target || existing.targetTurnId !== delivery.targetTurnId
        || existing.questionId !== delivery.questionId || existing.payloadDigest !== delivery.payloadDigest
        || !sameJson(existing.payload, delivery.payload)) return { accepted: false, reason: 'request_conflict' };
      if (existing.acceptedTurnId && delivery.acceptedTurnId && existing.acceptedTurnId !== delivery.acceptedTurnId) {
        return { accepted: false, reason: 'accepted_turn_conflict' };
      }
      if (terminalState('delivery', existing.state)) {
        return sameJson(existing, delivery) ? { accepted: true, reason: 'duplicate_delivery' }
          : { accepted: true, reason: 'terminal_preserved' };
      }
      if (existing.state === 'unknown' && delivery.state === 'applied' && !fromCurrentProof) {
        return { accepted: false, reason: 'current_native_proof_required' };
      }
      if (existing.state === 'unknown' && ['sending', 'accepted', 'registered'].includes(delivery.state)) {
        return { accepted: false, reason: 'delivery_state_regression' };
      }
      if (existing.state === 'accepted' && delivery.state === 'sending'
        || existing.state === 'sending' && delivery.state === 'registered') {
        return { accepted: false, reason: 'delivery_state_regression' };
      }
    }
    if (!existing && this.totalRecords() >= MAX_RECORDS) return { accepted: false, reason: 'record_capacity' };
    bindingRecord.deliveries.set(delivery.requestId, clone(delivery));
    return { accepted: true, reason: existing ? 'updated' : 'registered' };
  }

  applyCurrentDeliveryEvidence(record, evidence) {
    const candidatesByRequest = new Map();
    for (const item of evidence) {
      const delivery = record.deliveries.get(item.requestId);
      if (!delivery || delivery.deliveryId !== item.deliveryId || delivery.payloadDigest !== item.payloadDigest
        || !['unknown', 'sending', 'accepted'].includes(delivery.state)
        || (delivery.targetTurnId && delivery.targetTurnId !== item.turnId)
        || (delivery.acceptedTurnId && delivery.acceptedTurnId !== item.turnId)) continue;
      const key = JSON.stringify([item.turnId, item.itemId, item.itemType, item.payloadDigest]);
      const candidates = candidatesByRequest.get(item.requestId) || new Map();
      candidates.set(key, item);
      candidatesByRequest.set(item.requestId, candidates);
    }
    const ownerCandidates = new Map();
    for (const [requestId, candidates] of candidatesByRequest) {
      if (candidates.size !== 1) continue;
      const [item] = candidates.values();
      const ownerKey = JSON.stringify([record.binding.provider, record.binding.hostId,
        record.binding.homeScope, record.binding.threadId, item.turnId, item.itemId]);
      const requests = ownerCandidates.get(ownerKey) || new Set();
      requests.add(requestId);
      ownerCandidates.set(ownerKey, requests);
    }
    let appliedCount = 0;
    for (const [requestId, candidates] of candidatesByRequest) {
      if (candidates.size !== 1) continue;
      const item = [...candidates.values()][0];
      const ownerKey = JSON.stringify([record.binding.provider, record.binding.hostId,
        record.binding.homeScope, record.binding.threadId, item.turnId, item.itemId]);
      if (ownerCandidates.get(ownerKey)?.size !== 1 || this.itemAlreadyOwned(record, item, requestId)) continue;
      const delivery = record.deliveries.get(requestId);
      delivery.state = 'applied';
      delivery.acceptedTurnId = item.turnId;
      delivery.appliedEvidence = { turnId: item.turnId, itemId: item.itemId, itemType: item.itemType };
      appliedCount += 1;
    }
    return appliedCount;
  }

  itemAlreadyOwned(currentRecord, item, requestId) {
    const itemKey = JSON.stringify([currentRecord.binding.provider, currentRecord.binding.hostId,
      currentRecord.binding.homeScope, currentRecord.binding.threadId, item.turnId, item.itemId]);
    for (const record of this.bindings.values()) {
      for (const delivery of record.deliveries.values()) {
        if (delivery.state !== 'applied' || !delivery.appliedEvidence) continue;
        const ownerItem = JSON.stringify([record.binding.provider, record.binding.hostId,
          record.binding.homeScope, record.binding.threadId, delivery.appliedEvidence.turnId, delivery.appliedEvidence.itemId]);
        if (ownerItem !== itemKey) continue;
        if (record === currentRecord && delivery.requestId === requestId) continue;
        return true;
      }
    }
    return false;
  }

  deliveryTargetMatches(record, delivery) {
    if (!this.ordinaryInputAvailable(record)) return false;
    const { threadState, activeTurnId } = record.reconciliation;
    if (record.binding.origin === 'delegated') {
      return delivery.target === 'existing_turn' && threadState === 'active' && activeTurnId === delivery.targetTurnId;
    }
    if (delivery.target === 'turn_start') return threadState === 'idle' && activeTurnId === null;
    return delivery.target === 'expected_turn' && threadState === 'active' && activeTurnId === delivery.targetTurnId;
  }

  unverified(record, reason) {
    record.reconciliation = { status: 'unknown', reason, threadState: 'unknown', activeTurnId: null,
      waitingForQuestion: null, waitingForApproval: null };
    return { accepted: false, reason };
  }

  ordinaryInputAvailable(record) {
    return record.reconciliation.status === 'verified_current'
      && record.runState === 'active'
      && record.binding.origin !== 'review'
      && record.reconciliation.waitingForQuestion === false
      && record.reconciliation.waitingForApproval === false;
  }

  checkpoint() {
    const checkpoint = {
      schema: SCHEMA,
      version: 1,
      bindings: [...this.bindings.values()].sort((a, b) => bindingKey(a.binding).localeCompare(bindingKey(b.binding)))
        .map(serializedBindingRecord),
      streams: [...this.streams.values()].map(clone),
      events: [...this.events.values()].map(clone),
    };
    const normalized = normalizeCheckpoint(checkpoint);
    return normalized ? clone(normalized) : null;
  }
}

module.exports = { RecoveryModel, validateCheckpoint };
