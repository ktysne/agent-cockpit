'use strict';

const { createHash } = require('node:crypto');

const PROVIDER = 'codex';
const MAX_REQUESTS = 128;
const MAX_PAYLOAD_BYTES = 8192;
const MAX_PAYLOAD_NODES = 256;
const MAX_PAYLOAD_DEPTH = 8;
const MAX_CANCEL_OPERATIONS = 32;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CREDENTIAL_PREFIX = /^\s*(?:bearer(?:\s+|:)|basic(?:\s+|:)|token(?:\s+|:)|sk-\S+|gh[pousr]_\S+|github_pat_\S+|xox[baprs]-\S+|ya29\.\S+|eyj[a-z0-9_-]+\.[a-z0-9_-]+|(?:api[_-]?key|access[_-]?token|secret)\s*[:=])/i;
const RUN_KINDS = new Set(['standalone', 'delegated', 'review']);
const THREAD_STATES = new Set(['active', 'idle', 'ended', 'unknown']);
const UNKNOWN_REASONS = new Set(['disconnect', 'timeout', 'connection_lost', 'ambiguous_response']);
const ITEM_TYPES = new Set(['user_input']);
const IDENTITY_KEYS = ['provider', 'hostId', 'homeScope', 'threadId', 'runId', 'attemptId'];
const REQUEST_STATES = ['registered', 'sending', 'accepted', 'applied', 'unknown', 'stale', 'cancelled'];
const INVALID = Symbol('invalid');

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
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

function normalizeIdentity(input) {
  if (!isRecord(input) || input.provider !== PROVIDER
    || !safeId(input.hostId) || !safeId(input.homeScope) || !safeId(input.threadId)
    || !safeId(input.runId) || !safeId(input.attemptId)) return null;
  return {
    provider: PROVIDER,
    hostId: input.hostId,
    homeScope: input.homeScope,
    threadId: input.threadId,
    runId: input.runId,
    attemptId: input.attemptId,
  };
}

function requestKey(identity, requestId) {
  return JSON.stringify([...IDENTITY_KEYS.map((key) => identity[key]), requestId]);
}

function nativeItemScopeKey(request, turnId, itemId) {
  return JSON.stringify([
    request.identity.provider,
    request.identity.hostId,
    request.identity.homeScope,
    request.identity.threadId,
    turnId,
    itemId,
  ]);
}

function nativeItemOwnerKey(request, channel, deliveryId) {
  return JSON.stringify([
    request.identity.runId,
    request.identity.attemptId,
    request.requestId,
    channel,
    deliveryId,
  ]);
}

function normalizeJsonValue(value, context, depth = 0) {
  context.nodes += 1;
  if (context.nodes > MAX_PAYLOAD_NODES || depth > MAX_PAYLOAD_DEPTH) return INVALID;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return Buffer.byteLength(value, 'utf8') <= MAX_PAYLOAD_BYTES ? value : INVALID;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID;
  if (typeof value !== 'object') return INVALID;
  if (context.visiting.has(value)) return INVALID;
  context.visiting.add(value);
  let result = INVALID;
  if (Array.isArray(value)) {
    try {
      if (value.length <= MAX_PAYLOAD_NODES) {
        const keys = Reflect.ownKeys(value);
        const items = [];
        let valid = keys.length === value.length + 1 && keys.includes('length');
        for (let index = 0; valid && index < value.length; index += 1) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
            valid = false;
            break;
          }
          const item = normalizeJsonValue(descriptor.value, context, depth + 1);
          if (item === INVALID) {
            valid = false;
            break;
          }
          items.push(item);
        }
        if (valid) result = items;
      }
    } catch {
      result = INVALID;
    }
  } else if (isRecord(value)) {
    const record = {};
    let valid = true;
    let keys;
    try {
      keys = Reflect.ownKeys(value);
    } catch {
      keys = null;
    }
    if (!keys || keys.length > MAX_PAYLOAD_NODES || keys.some((key) => typeof key !== 'string')) valid = false;
    for (const key of valid ? keys.sort() : []) {
      if (!key || key.length > 128 || ['__proto__', 'constructor', 'prototype'].includes(key)) {
        valid = false;
        break;
      }
      let descriptor;
      try {
        descriptor = Object.getOwnPropertyDescriptor(value, key);
      } catch {
        valid = false;
        break;
      }
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) {
        valid = false;
        break;
      }
      const item = normalizeJsonValue(descriptor.value, context, depth + 1);
      if (item === INVALID) {
        valid = false;
        break;
      }
      record[key] = item;
    }
    if (valid) result = record;
  }
  context.visiting.delete(value);
  return result;
}

function normalizePayload(value) {
  try {
    let payload;
    if (typeof value === 'string') {
      if (!value.trim() || Buffer.byteLength(value, 'utf8') > MAX_PAYLOAD_BYTES) return null;
      payload = value;
    } else {
      if (!isRecord(value) || Reflect.ownKeys(value).length === 0) return null;
      const normalized = normalizeJsonValue(value, { nodes: 0, visiting: new Set() });
      if (!isRecord(normalized)) return null;
      payload = normalized;
    }
    const canonical = JSON.stringify(payload);
    if (Buffer.byteLength(canonical, 'utf8') > MAX_PAYLOAD_BYTES) return null;
    return {
      value: payload,
      digest: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    };
  } catch {
    return null;
  }
}

function digestPayload(value) {
  return normalizePayload(value)?.digest || null;
}

function clonePayload(value) {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(clonePayload);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clonePayload(item)]));
}

function rejected(reason, request = null) {
  return { accepted: false, reason, ...(request ? { request } : {}) };
}

function normalizedObservedThread(value) {
  if (!hasOnlyKeys(value, new Set(['state', 'activeTurnId', 'waitingOnApproval', 'waitingOnUserInput']))
    || !THREAD_STATES.has(value.state)
    || (value.activeTurnId !== undefined && value.activeTurnId !== null && !safeId(value.activeTurnId))
    || typeof value.waitingOnApproval !== 'boolean' || typeof value.waitingOnUserInput !== 'boolean') return null;
  return {
    state: value.state,
    activeTurnId: value.activeTurnId || null,
    waitingOnApproval: value.waitingOnApproval,
    waitingOnUserInput: value.waitingOnUserInput,
  };
}

function threadHoldReason(observed) {
  if (observed.state === 'unknown') return 'thread_state_unknown';
  if (observed.waitingOnApproval) return 'waiting_on_approval';
  if (observed.waitingOnUserInput) return 'waiting_on_user_input';
  return null;
}

function deliveryTarget(request) {
  if (request.runKind === 'delegated') return 'existing_turn';
  return request.expectedTurnId ? 'expected_turn' : 'turn_start';
}

function currentAttempt(request) {
  return request.fallback || request.primary;
}

class InstructionDeliveryModel {
  constructor(options = {}) {
    if (!hasOnlyKeys(options, new Set(['now'])) || (options.now !== undefined && typeof options.now !== 'function')) {
      throw new TypeError('invalid model options');
    }
    this.now = options.now || Date.now;
    this.requests = new Map();
    this.deliveryIds = new Set();
  }

  register(input) {
    const allowed = new Set([
      ...IDENTITY_KEYS, 'requestId', 'kind', 'payload', 'runKind', 'threadState', 'expectedTurnId',
      'waitingOnApproval', 'waitingOnUserInput',
    ]);
    if (!hasOnlyKeys(input, allowed)) return rejected('invalid_input');
    const identity = normalizeIdentity(input);
    if (!identity || !safeId(input.requestId)) return rejected('invalid_identity');
    if (input.kind !== 'ordinary_instruction') return rejected('unsupported_kind');
    if (!RUN_KINDS.has(input.runKind)) return rejected('invalid_run_kind');
    if (!THREAD_STATES.has(input.threadState)
      || typeof input.waitingOnApproval !== 'boolean' || typeof input.waitingOnUserInput !== 'boolean'
      || (input.expectedTurnId !== undefined && input.expectedTurnId !== null && !safeId(input.expectedTurnId))) {
      return rejected('invalid_thread_state');
    }
    if (input.runKind === 'review') return rejected('review_excluded');
    const expectedTurnId = input.expectedTurnId || null;
    if (input.runKind === 'standalone') {
      if (input.threadState === 'ended') return rejected('thread_ended');
      if (input.threadState === 'active' && !expectedTurnId) return rejected('expected_turn_required');
      if (input.threadState === 'idle' && expectedTurnId) return rejected('unexpected_expected_turn');
    } else {
      if (input.threadState === 'ended') return rejected('delegated_ended');
      if (input.threadState === 'idle') return rejected('delegated_not_active');
      if (input.threadState === 'active' && !expectedTurnId) return rejected('expected_turn_required');
      if (input.threadState === 'unknown' && !expectedTurnId) return rejected('expected_turn_required');
    }
    const normalizedPayload = normalizePayload(input.payload);
    if (!normalizedPayload) return rejected('invalid_payload');

    const key = requestKey(identity, input.requestId);
    const fingerprint = JSON.stringify({
      identity: IDENTITY_KEYS.map((name) => identity[name]),
      requestId: input.requestId,
      kind: input.kind,
      payloadDigest: normalizedPayload.digest,
      runKind: input.runKind,
      expectedTurnId,
    });
    const existing = this.requests.get(key);
    if (existing) {
      if (existing.registrationFingerprint !== fingerprint) return rejected('request_conflict');
      return { accepted: true, reason: 'duplicate_registration', request: this.snapshot(existing) };
    }
    if (this.requests.size >= MAX_REQUESTS) return rejected('capacity');
    const createdAt = this.readTime();
    if (createdAt === null) return rejected('invalid_clock');
    const request = {
      key,
      registrationFingerprint: fingerprint,
      identity,
      requestId: input.requestId,
      kind: input.kind,
      payload: normalizedPayload.value,
      payloadDigest: normalizedPayload.digest,
      runKind: input.runKind,
      expectedTurnId,
      route: deliveryTarget({ runKind: input.runKind, expectedTurnId }),
      registeredThreadState: input.threadState,
      registeredWaitingOnApproval: input.waitingOnApproval,
      registeredWaitingOnUserInput: input.waitingOnUserInput,
      createdAt,
      primary: {
        state: 'registered', deliveryId: null, acceptedTurnId: null, sendStartedAt: null,
        acceptedAt: null, appliedAt: null, appliedEvidence: null, unknownReason: null,
        staleReason: null, cancelRequested: false, cancelRequestedAt: null, cancelledAt: null,
        preAcceptanceEvidence: null, preAcceptanceEvidenceAmbiguous: false,
      },
      fallback: null,
      cancelOperationIds: new Set(),
      version: 1,
    };
    this.requests.set(key, request);
    return { accepted: true, reason: 'registered', request: this.snapshot(request) };
  }

  beginDelivery(input) {
    const allowed = new Set([...IDENTITY_KEYS, 'requestId', 'deliveryId', 'observedThread', 'channel', 'claimId']);
    if (!hasOnlyKeys(input, allowed)) return rejected('invalid_input');
    const request = this.findRequest(input);
    if (!request) return rejected('not_found');
    if (!safeId(input.deliveryId)) return rejected('invalid_input', this.snapshot(request));
    const channel = input.channel === undefined ? 'primary' : input.channel;
    if (!['primary', 'next_user_input'].includes(channel)) return rejected('invalid_channel', this.snapshot(request));
    const observed = normalizedObservedThread(input.observedThread);
    if (!observed) return rejected('invalid_thread_state', this.snapshot(request));
    const attempt = this.getAttempt(request, channel, input.claimId);
    if (!attempt) return rejected('fallback_unavailable', this.snapshot(request));
    if (channel === 'primary' && request.fallback) return rejected('fallback_claimed', this.snapshot(request));
    if (attempt.state !== 'registered' || attempt.deliveryId) return rejected('delivery_not_registered', this.snapshot(request));
    if (this.deliveryIds.has(input.deliveryId)) return rejected('delivery_id_conflict', this.snapshot(request));

    const holdReason = threadHoldReason(observed);
    if (holdReason) return rejected(holdReason, this.snapshot(request));

    let route;
    let targetTurnId = null;
    if (channel === 'next_user_input') {
      if (observed.state !== 'active' || observed.activeTurnId !== attempt.inputTurnId) {
        attempt.state = 'stale';
        attempt.staleReason = observed.state === 'ended' ? 'thread_ended' : 'expected_turn_mismatch';
        request.version += 1;
        return rejected(attempt.staleReason, this.snapshot(request));
      }
      route = 'existing_turn';
      targetTurnId = attempt.inputTurnId;
    } else if (request.runKind === 'delegated' || request.expectedTurnId) {
      if (observed.state !== 'active' || observed.activeTurnId !== request.expectedTurnId) {
        attempt.state = 'stale';
        attempt.staleReason = observed.state === 'ended' ? 'thread_ended' : 'expected_turn_mismatch';
        request.version += 1;
        return rejected(attempt.staleReason, this.snapshot(request));
      }
      route = request.runKind === 'delegated' ? 'existing_turn' : 'steer_expected_turn';
      targetTurnId = request.expectedTurnId;
    } else {
      if (observed.state !== 'idle' || observed.activeTurnId !== null) {
        attempt.state = 'stale';
        attempt.staleReason = observed.state === 'ended' ? 'thread_ended' : 'target_state_mismatch';
        request.version += 1;
        return rejected(attempt.staleReason, this.snapshot(request));
      }
      route = 'turn_start';
    }

    attempt.state = 'sending';
    attempt.deliveryId = input.deliveryId;
    attempt.route = route;
    attempt.targetTurnId = targetTurnId;
    attempt.sendStartedAt = this.readTime();
    if (attempt.sendStartedAt === null) {
      attempt.state = 'registered';
      attempt.deliveryId = null;
      attempt.route = null;
      attempt.targetTurnId = null;
      attempt.sendStartedAt = null;
      return rejected('invalid_clock', this.snapshot(request));
    }
    this.deliveryIds.add(input.deliveryId);
    request.version += 1;
    return {
      accepted: true,
      reason: 'sending',
      delivery: {
        provider: PROVIDER,
        requestId: request.requestId,
        deliveryId: input.deliveryId,
        channel,
        ...(channel === 'next_user_input' ? { claimId: attempt.claimId } : {}),
        route,
        targetTurnId,
        payload: clonePayload(request.payload),
        payloadDigest: request.payloadDigest,
      },
      request: this.snapshot(request),
    };
  }

  recordAccepted(input) {
    const attemptInput = this.normalizeAttemptInput(input, new Set([...IDENTITY_KEYS, 'requestId', 'deliveryId', 'turnId', 'channel', 'claimId']));
    if (!attemptInput) return rejected('invalid_input');
    const { request, attempt, channel } = attemptInput;
    if (channel === 'primary' && request.fallback) return rejected('fallback_claimed', this.snapshot(request));
    if (!safeId(input.turnId) || attempt.state !== 'sending' || attempt.deliveryId !== input.deliveryId) {
      return rejected('delivery_not_sending', this.snapshot(request));
    }
    const expectedTurnId = channel === 'next_user_input'
      ? attempt.inputTurnId
      : attempt.route === 'turn_start' ? null : request.expectedTurnId;
    const now = this.readTime();
    if (now === null) return rejected('invalid_clock', this.snapshot(request));
    attempt.acceptedTurnId = input.turnId;
    attempt.acceptedAt = now;
    if (expectedTurnId && input.turnId !== expectedTurnId) {
      attempt.state = 'stale';
      attempt.staleReason = 'accepted_turn_mismatch';
      attempt.preAcceptanceEvidence = null;
      request.version += 1;
      return rejected('stale_expected_turn', this.snapshot(request));
    }
    attempt.state = 'accepted';
    const candidate = !attempt.preAcceptanceEvidenceAmbiguous
      && attempt.preAcceptanceEvidence?.turnId === input.turnId ? attempt.preAcceptanceEvidence : null;
    attempt.preAcceptanceEvidence = null;
    request.version += 1;
    if (candidate) {
      this.applyNativeEvidence({
        ...request.identity,
        requestId: request.requestId,
        deliveryId: input.deliveryId,
        turnId: candidate.turnId,
        itemId: candidate.itemId,
        itemType: candidate.itemType,
        payloadDigest: candidate.payloadDigest,
        ...(channel === 'next_user_input' ? {
          channel,
          claimId: attempt.claimId,
          inputItemId: candidate.inputItemId,
        } : {}),
      }, new Set(['accepted']));
    }
    return { accepted: true, reason: 'accepted', request: this.snapshot(request) };
  }

  markUnknown(input) {
    const attemptInput = this.normalizeAttemptInput(input, new Set([...IDENTITY_KEYS, 'requestId', 'deliveryId', 'reason', 'channel', 'claimId']));
    if (!attemptInput || !UNKNOWN_REASONS.has(input.reason)) return rejected('invalid_input');
    const { request, attempt, channel } = attemptInput;
    if (channel === 'primary' && request.fallback) return rejected('fallback_claimed', this.snapshot(request));
    if (attempt.state === 'unknown' && attempt.deliveryId === input.deliveryId && attempt.unknownReason === input.reason) {
      return { accepted: true, reason: 'duplicate_unknown', request: this.snapshot(request) };
    }
    if (!['sending', 'accepted'].includes(attempt.state) || attempt.deliveryId !== input.deliveryId) {
      return rejected('delivery_not_ambiguous', this.snapshot(request));
    }
    attempt.state = 'unknown';
    attempt.unknownReason = input.reason;
    request.version += 1;
    return { accepted: true, reason: 'unknown', request: this.snapshot(request) };
  }

  observeApplied(input) {
    return this.applyNativeEvidence(input, new Set(['accepted']));
  }

  reconcileUnknown(input) {
    return this.applyNativeEvidence(input, new Set(['unknown']));
  }

  applyNativeEvidence(input, allowedStates) {
    const attemptInput = this.normalizeAttemptInput(input, new Set([
      ...IDENTITY_KEYS, 'requestId', 'deliveryId', 'turnId', 'itemId', 'itemType', 'payloadDigest',
      'channel', 'claimId', 'inputItemId',
    ]));
    if (!attemptInput) return rejected('invalid_input');
    const { request, attempt, channel } = attemptInput;
    if (!safeId(input.turnId) || !safeId(input.itemId) || !ITEM_TYPES.has(input.itemType)
      || typeof input.payloadDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.payloadDigest)) {
      return rejected('invalid_native_evidence', this.snapshot(request));
    }
    if (channel === 'next_user_input' && input.inputItemId !== attempt.inputItemId) {
      return rejected('evidence_mismatch', this.snapshot(request));
    }
    if (channel === 'primary' && request.fallback) return rejected('fallback_claimed', this.snapshot(request));
    if (attempt.deliveryId !== input.deliveryId) return rejected('evidence_not_expected', this.snapshot(request));
    if (attempt.state === 'applied') {
      const same = attempt.deliveryId === input.deliveryId && attempt.acceptedTurnId === input.turnId
        && attempt.appliedEvidence?.itemId === input.itemId && request.payloadDigest === input.payloadDigest;
      return same ? { accepted: true, reason: 'duplicate_applied_evidence', request: this.snapshot(request) }
        : rejected('already_applied', this.snapshot(request));
    }
    if (attempt.state === 'sending' && !allowedStates.has('accepted')) {
      return rejected('evidence_not_expected', this.snapshot(request));
    }
    if (attempt.preAcceptanceEvidenceAmbiguous) {
      return rejected('pre_acceptance_evidence_ambiguous', this.snapshot(request));
    }
    if (attempt.state === 'sending') {
      if (request.payloadDigest !== input.payloadDigest
        || (attempt.targetTurnId && attempt.targetTurnId !== input.turnId)) {
        return rejected('evidence_mismatch', this.snapshot(request));
      }
      const candidate = {
        turnId: input.turnId,
        itemId: input.itemId,
        itemType: input.itemType,
        payloadDigest: input.payloadDigest,
        ...(channel === 'next_user_input' ? { inputItemId: input.inputItemId } : {}),
      };
      if (attempt.preAcceptanceEvidence) {
        if (JSON.stringify(attempt.preAcceptanceEvidence) === JSON.stringify(candidate)) {
          return { accepted: true, reason: 'duplicate_buffered_evidence', request: this.snapshot(request) };
        }
        attempt.preAcceptanceEvidence = null;
        attempt.preAcceptanceEvidenceAmbiguous = true;
        request.version += 1;
        return rejected('pre_acceptance_evidence_ambiguous', this.snapshot(request));
      }
      attempt.preAcceptanceEvidence = candidate;
      request.version += 1;
      return { accepted: true, reason: 'evidence_buffered', request: this.snapshot(request) };
    }
    if (!allowedStates.has(attempt.state) || attempt.deliveryId !== input.deliveryId) {
      return rejected('evidence_not_expected', this.snapshot(request));
    }
    const evidenceTurnId = attempt.acceptedTurnId || attempt.targetTurnId;
    if (!evidenceTurnId || evidenceTurnId !== input.turnId || request.payloadDigest !== input.payloadDigest) {
      return rejected('evidence_mismatch', this.snapshot(request));
    }
    const itemScopeKey = nativeItemScopeKey(request, input.turnId, input.itemId);
    const candidateOwnerKey = nativeItemOwnerKey(request, channel, input.deliveryId);
    for (const existing of this.requests.values()) {
      const attempts = [
        ['primary', existing.primary],
        ...(existing.fallback ? [['next_user_input', existing.fallback]] : []),
      ];
      for (const [existingChannel, existingAttempt] of attempts) {
        const existingEvidence = existingAttempt.appliedEvidence;
        if (!existingEvidence
          || nativeItemScopeKey(existing, existingEvidence.turnId, existingEvidence.itemId) !== itemScopeKey) continue;
        const existingOwnerKey = nativeItemOwnerKey(existing, existingChannel, existingAttempt.deliveryId);
        if (existingOwnerKey !== candidateOwnerKey) {
          return rejected('native_item_already_owned', this.snapshot(request));
        }
      }
    }
    const now = this.readTime();
    if (now === null) return rejected('invalid_clock', this.snapshot(request));
    attempt.state = 'applied';
    attempt.acceptedTurnId ||= input.turnId;
    attempt.appliedAt = now;
    attempt.appliedEvidence = { itemId: input.itemId, turnId: input.turnId, itemType: input.itemType, channel };
    attempt.preAcceptanceEvidence = null;
    request.version += 1;
    return { accepted: true, reason: 'applied', request: this.snapshot(request) };
  }

  claimNextUserInputFallback(input) {
    const allowed = new Set([
      ...IDENTITY_KEYS, 'requestId', 'claimId', 'inputItemId', 'inputItemType', 'inputTurnId', 'observedThread',
    ]);
    if (!hasOnlyKeys(input, allowed)) return rejected('invalid_input');
    const request = this.findRequest(input);
    if (!request) return rejected('not_found');
    if (!safeId(input.claimId) || !safeId(input.inputItemId) || !safeId(input.inputTurnId)
      || input.inputItemType !== 'user_input') {
      return rejected('invalid_input', this.snapshot(request));
    }
    const observed = normalizedObservedThread(input.observedThread);
    if (!observed) return rejected('invalid_thread_state', this.snapshot(request));
    const holdReason = threadHoldReason(observed);
    if (holdReason) return rejected(holdReason, this.snapshot(request));
    if (observed.state !== 'active' || observed.activeTurnId !== input.inputTurnId) {
      return rejected('fallback_turn_mismatch', this.snapshot(request));
    }
    if (request.fallback) {
      const same = request.fallback.claimId === input.claimId
        && request.fallback.inputItemId === input.inputItemId
        && request.fallback.inputItemType === input.inputItemType
        && request.fallback.inputTurnId === input.inputTurnId;
      return same ? { accepted: true, reason: 'duplicate_fallback_claim', request: this.snapshot(request) }
        : rejected('fallback_conflict', this.snapshot(request));
    }
    if (request.runKind !== 'standalone') return rejected('fallback_not_supported', this.snapshot(request));
    if (request.registeredThreadState === 'unknown') return rejected('thread_state_unknown', this.snapshot(request));
    if (request.primary.state === 'unknown') return rejected('unknown_no_fallback', this.snapshot(request));
    if (!['registered', 'stale'].includes(request.primary.state) || request.primary.deliveryId !== null) {
      return rejected('fallback_unavailable', this.snapshot(request));
    }
    if (request.primary.cancelRequested || request.primary.state === 'cancelled') {
      return rejected('terminal_request', this.snapshot(request));
    }
    request.fallback = {
      state: 'registered',
      claimId: input.claimId,
      inputItemId: input.inputItemId,
      inputItemType: input.inputItemType,
      inputTurnId: input.inputTurnId,
      deliveryId: null,
      route: 'existing_turn',
      targetTurnId: input.inputTurnId,
      sendStartedAt: null,
      acceptedAt: null,
      acceptedTurnId: null,
      appliedAt: null,
      appliedEvidence: null,
      unknownReason: null,
      staleReason: null,
      cancelRequested: false,
      cancelRequestedAt: null,
      cancelledAt: null,
      preAcceptanceEvidence: null,
      preAcceptanceEvidenceAmbiguous: false,
    };
    request.primary.supersededByFallback = true;
    request.version += 1;
    return { accepted: true, reason: 'fallback_claimed', request: this.snapshot(request) };
  }

  cancel(input) {
    const allowed = new Set([...IDENTITY_KEYS, 'requestId', 'operationId']);
    if (!hasOnlyKeys(input, allowed)) return rejected('invalid_input');
    const request = this.findRequest(input);
    if (!request) return rejected('not_found');
    if (!safeId(input.operationId)) return rejected('invalid_input', this.snapshot(request));
    if (request.cancelOperationIds.has(input.operationId)) return rejected('duplicate_operation', this.snapshot(request));
    if (request.cancelOperationIds.size >= MAX_CANCEL_OPERATIONS) return rejected('operation_capacity', this.snapshot(request));
    const attempt = currentAttempt(request);
    if (attempt.state === 'applied') return rejected('already_applied', this.snapshot(request));
    const deliveryMayHaveBeenSent = ['sending', 'accepted', 'unknown'].includes(attempt.state)
      || (attempt.state === 'stale' && attempt.deliveryId);
    const cancellableBeforeSend = ['registered', 'stale'].includes(attempt.state) && !attempt.deliveryId;
    if (!deliveryMayHaveBeenSent && !cancellableBeforeSend) return rejected('terminal_request', this.snapshot(request));
    const now = this.readTime();
    if (now === null) return rejected('invalid_clock', this.snapshot(request));
    request.cancelOperationIds.add(input.operationId);
    if (deliveryMayHaveBeenSent) {
      attempt.cancelRequested = true;
      attempt.cancelRequestedAt ||= now;
      request.version += 1;
      return { accepted: true, reason: 'delivery_may_have_been_sent', request: this.snapshot(request) };
    }
    attempt.state = 'cancelled';
    attempt.cancelledAt = now;
    request.version += 1;
    return { accepted: true, reason: 'cancelled_before_send', request: this.snapshot(request) };
  }

  project() {
    const rows = [...this.requests.values()]
      .sort((left, right) => left.key.localeCompare(right.key))
      .map((request) => this.snapshot(request));
    const counts = Object.fromEntries(REQUEST_STATES.map((state) => [state, rows.filter((row) => row.state === state).length]));
    return { counts: { total: rows.length, ...counts }, rows };
  }

  readTime() {
    try {
      const value = this.now();
      return Number.isSafeInteger(value) && value >= 0 ? value : null;
    } catch {
      return null;
    }
  }

  findRequest(input) {
    const identity = normalizeIdentity(input);
    if (!identity || !safeId(input.requestId)) return null;
    return this.requests.get(requestKey(identity, input.requestId)) || null;
  }

  getAttempt(request, channel, claimId) {
    if (channel === 'primary') return request.primary;
    if (!request.fallback || request.fallback.claimId !== claimId) return null;
    return request.fallback;
  }

  normalizeAttemptInput(input, allowed) {
    if (!hasOnlyKeys(input, allowed)) return null;
    const request = this.findRequest(input);
    if (!request || !safeId(input.deliveryId)) return null;
    const channel = input.channel === undefined ? 'primary' : input.channel;
    if (!['primary', 'next_user_input'].includes(channel)) return null;
    const attempt = this.getAttempt(request, channel, input.claimId);
    if (!attempt) return null;
    return { request, attempt, channel };
  }

  snapshot(request) {
    const attempt = currentAttempt(request);
    return {
      provider: PROVIDER,
      hostId: request.identity.hostId,
      homeScope: request.identity.homeScope,
      threadId: request.identity.threadId,
      runId: request.identity.runId,
      attemptId: request.identity.attemptId,
      requestId: request.requestId,
      kind: request.kind,
      runKind: request.runKind,
      target: request.route,
      expectedTurnId: request.expectedTurnId,
      registeredThreadState: request.registeredThreadState,
      registeredWaitingOnApproval: request.registeredWaitingOnApproval,
      registeredWaitingOnUserInput: request.registeredWaitingOnUserInput,
      state: attempt.state,
      primaryState: request.primary.state,
      primarySupersededByFallback: Boolean(request.primary.supersededByFallback),
      deliveryId: attempt.deliveryId,
      route: attempt.route || null,
      targetTurnId: attempt.targetTurnId || null,
      acceptedTurnId: attempt.acceptedTurnId || null,
      appliedAt: attempt.appliedAt,
      appliedEvidence: attempt.appliedEvidence ? { ...attempt.appliedEvidence } : null,
      unknownReason: attempt.unknownReason,
      staleReason: attempt.staleReason,
      cancelRequested: attempt.cancelRequested,
      cancelRequestedAt: attempt.cancelRequestedAt,
      cancelledAt: attempt.cancelledAt,
      preAcceptanceEvidenceCount: attempt.preAcceptanceEvidence ? 1 : 0,
      preAcceptanceEvidenceAmbiguous: attempt.preAcceptanceEvidenceAmbiguous,
      fallback: request.fallback ? {
        state: request.fallback.state,
        claimId: request.fallback.claimId,
        inputItemId: request.fallback.inputItemId,
        inputItemType: request.fallback.inputItemType,
        inputTurnId: request.fallback.inputTurnId,
        deliveryId: request.fallback.deliveryId,
        route: request.fallback.route,
        targetTurnId: request.fallback.targetTurnId,
        acceptedTurnId: request.fallback.acceptedTurnId,
        appliedAt: request.fallback.appliedAt,
        appliedEvidence: request.fallback.appliedEvidence ? { ...request.fallback.appliedEvidence } : null,
        unknownReason: request.fallback.unknownReason,
        staleReason: request.fallback.staleReason,
        cancelRequested: request.fallback.cancelRequested,
        cancelRequestedAt: request.fallback.cancelRequestedAt,
        cancelledAt: request.fallback.cancelledAt,
        preAcceptanceEvidenceCount: request.fallback.preAcceptanceEvidence ? 1 : 0,
        preAcceptanceEvidenceAmbiguous: request.fallback.preAcceptanceEvidenceAmbiguous,
      } : null,
      createdAt: request.createdAt,
      version: request.version,
    };
  }
}

module.exports = { InstructionDeliveryModel, digestPayload };
