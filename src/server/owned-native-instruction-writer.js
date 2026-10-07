'use strict';

const { normalizeMetadata, normalizeCommand, normalizeInput, exactData, dispatchError } = require('./owned-native-instruction-dispatch');
const { types } = require('node:util');
const WRITERS = new WeakMap();
const NOW = Date.now;
const MAX_INSTRUCTION_DISPATCHES = 128;
const MAX_ENTRIES = MAX_INSTRUCTION_DISPATCHES;
const MAX_BYTES = 256 * 1024;
const TTL_MS = 60_000;
const ACK_MS = 5_000;
const payloadBudget = { bytes: 0, candidates: 0 };
function reservePayload(bytes, candidates) {
  if (payloadBudget.bytes + bytes > MAX_BYTES || payloadBudget.candidates + candidates > MAX_ENTRIES) return false;
  payloadBudget.bytes += bytes; payloadBudget.candidates += candidates;
  return { bytes, candidates, active: true };
}
function releasePayload(reservation) {
  if (!reservation.active) return false;
  reservation.active = false;
  payloadBudget.bytes -= reservation.bytes; payloadBudget.candidates -= reservation.candidates;
  return true;
}

function normalizeNativeInput(value) {
  try { return normalizeInput(value); } catch {}
  if (!Array.isArray(value) || types.isProxy(value) || value.length !== 1 || Reflect.ownKeys(value).length !== 2) throw dispatchError();
  const element = Object.getOwnPropertyDescriptor(value, '0');
  if (!element || !Object.hasOwn(element, 'value')) throw dispatchError();
  const native = exactData(element.value, ['type', 'text']);
  return normalizeInput([{ ...native, text_elements: [] }]);
}

function createOwnedInstructionWriter(sourceCapability, operations) {
  if (!sourceCapability || WRITERS.has(sourceCapability)) throw dispatchError();
  const tokens = new WeakMap();
  const receipts = new WeakMap();
  const entries = new Map();
  const itemOwners = new Map();
  const listeners = new Set();
  const closedListeners = new Set();
  let retainedBytes = 0;
  let invalidated = false;
  let candidateCount = 0;
  function releaseEntryReservation(entry, reservation) {
    if (!entry.reservations.delete(reservation) || !releasePayload(reservation)) return;
    retainedBytes -= reservation.bytes; candidateCount -= reservation.candidates;
    entry.payloadBytes -= reservation.bytes; entry.candidateCount -= reservation.candidates;
  }
  function clearPayload(entry, reason = 'instruction_observation_closed') {
    if (entry.payloadCleared) return;
    if (entry.used && !entry.settled) {
      settle(entry, dispatchError(reason));
      return;
    }
    entry.payloadCleared = true;
    clearTimeout(entry.expiryTimer);
    for (const reservation of entry.reservations) releaseEntryReservation(entry, reservation);
    entry.input = null; entry.candidates.length = 0; entry.prepared = null; entry.resolve = null; entry.reject = null;
    for (const receipt of entry.receipts) receipts.delete(receipt);
    entry.receipts.clear();
    for (const listener of [...closedListeners]) { try { listener(entry.token, reason); } catch {} }
  }
  function expire() { for (const entry of entries.values()) if (!entry.nativeTurnId && entry.expiresAt <= NOW()) clearPayload(entry); }

  function current(entry) {
    return !invalidated && entry && !entry.payloadCleared && !entry.used && entry.expiresAt > NOW() && operations.check(entry.capture, entry.metadata) === true;
  }
  function evidenceCurrent(entry) {
    return !invalidated && entry?.used && !entry.payloadCleared && !entry.conflict && entry.nativeTurnId &&
      operations.checkEvidence(entry.capture, entry.nativeTurnId) === true;
  }
  function settle(entry, error, nativeTurnId) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    operations.complete(entry.token, error);
    if (error) { entry.conflict = true; entry.reject(error); clearPayload(entry, error.code); return; }
    entry.nativeTurnId = nativeTurnId;
    clearTimeout(entry.expiryTimer);
    entry.resolve(Object.freeze({ clientRequestId: entry.metadata.deliveryAttemptId, nativeTurnId, nativeItemId: null }));
    flush(entry);
    if (!evidenceCurrent(entry)) clearPayload(entry, 'instruction_source_invalid');
  }
  function flush(entry) {
    if (entry.writing || !evidenceCurrent(entry)) return;
    for (const candidate of entry.candidates.splice(0)) {
      if (candidate.nativeTurnId !== entry.nativeTurnId) { entry.conflict = true; clearPayload(entry, 'instruction_evidence_conflict'); return; }
      const previous = itemOwners.get(candidate.nativeItemId);
      if (previous && previous !== entry) { previous.conflict = true; entry.conflict = true; clearPayload(previous, 'instruction_evidence_conflict'); clearPayload(entry, 'instruction_evidence_conflict'); return; }
      if (!previous && itemOwners.size >= MAX_ENTRIES) { entry.conflict = true; clearPayload(entry, 'instruction_evidence_capacity'); return; }
      itemOwners.set(candidate.nativeItemId, entry);
      if (entry.deliveredItems.has(candidate.nativeItemId)) continue;
      entry.deliveredItems.add(candidate.nativeItemId);
      const receipt = Object.freeze(Object.create(null));
      receipts.set(receipt, { entry, candidate, consumed: false }); entry.receipts.add(receipt);
      for (const listener of [...listeners]) { try { listener(entry.token, receipt); } catch {} }
    }
  }
  const facade = Object.freeze({
    prepare(value) {
      expire();
      const metadata = normalizeMetadata(value);
      const previous = entries.get(metadata.deliveryAttemptId);
      if (previous) return current(previous) && JSON.stringify(previous.metadata) === JSON.stringify(metadata) ? previous.token : null;
      const size = Buffer.byteLength(JSON.stringify(metadata));
      if (invalidated || entries.size >= MAX_ENTRIES || retainedBytes + size > MAX_BYTES) return null;
      const capture = operations.capture(metadata);
      if (!capture || operations.check(capture, metadata) !== true) return null;
      const token = Object.freeze(Object.create(null));
      const entry = { token, metadata, capture, expiresAt: NOW() + TTL_MS, used: false, writing: false,
        settled: false, conflict: false, candidates: [], deliveredItems: new Set(), receipts: new Set(), reservations: new Set(), candidateCount: 0, payloadBytes: 0, nativeTurnId: null, size };
      entries.set(metadata.deliveryAttemptId, entry); tokens.set(token, entry); retainedBytes += size;
      return token;
    },
    canPrepare(value) {
      try {
        if (invalidated) return false;
        const metadata = normalizeMetadata(value);
        const capture = operations.capture(metadata);
        return Boolean(capture && operations.check(capture, metadata) === true);
      } catch { return false; }
    },
    check(token) { try { expire(); return Boolean(current(tokens.get(token))); } catch { return false; } },
    dispatchNow(token, value, finalGuard) {
      expire();
      const entry = tokens.get(token);
      const command = normalizeCommand(value);
      if (!current(entry) || JSON.stringify(entry.metadata) !== JSON.stringify(normalizeMetadata(Object.fromEntries(Object.keys(entry.metadata).map(key => [key, command[key]]))))) throw dispatchError();
      const inputBytes = Buffer.byteLength(JSON.stringify(command.input));
      if (retainedBytes + inputBytes > MAX_BYTES) throw dispatchError();
      const prepared = operations.prepareWrite(entry.metadata, command.input, entry.capture);
      if (!prepared) throw dispatchError();
      const capturedWrite = prepared.write; const capturedLine = prepared.line;
      if (typeof capturedWrite !== 'function' || typeof capturedLine !== 'string') throw dispatchError();
      if (retainedBytes + inputBytes > MAX_BYTES) throw dispatchError();
      const inputReservation = reservePayload(inputBytes, 0);
      if (!inputReservation) throw dispatchError();
      entry.reservations.add(inputReservation);
      retainedBytes += inputBytes; entry.payloadBytes += inputBytes;
      let resolve; let reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      promise.catch(() => {});
      entry.resolve = resolve; entry.reject = reject;
      entry.timer = setTimeout(() => settle(entry, dispatchError('instruction_ack_timeout')), ACK_MS);
      entry.input = command.input; entry.prepared = prepared;
      entry.expiryTimer = setTimeout(() => clearPayload(entry), Math.max(0, entry.expiresAt - NOW())); entry.expiryTimer.unref();
      const onWrite = (error) => { if (error) settle(entry, dispatchError('instruction_write_failed')); };
      let accepted = false;
      try {
        operations.register(entry.token, prepared, entry.metadata);
        accepted = current(entry) && finalGuard() === true && !invalidated && inputReservation.active;
      } catch {}
      if (!accepted) {
        clearTimeout(entry.timer); clearTimeout(entry.expiryTimer); entry.prepared = null; entry.input = null; entry.resolve = null; entry.reject = null;
        releaseEntryReservation(entry, inputReservation);
        operations.unregister(entry.token, prepared);
        throw dispatchError();
      }
      entry.used = true; entry.writing = true;
      try {
        capturedWrite(capturedLine, onWrite);
      } catch { settle(entry, dispatchError('instruction_write_failed')); }
      entry.writing = false; entry.prepared = null;
      flush(entry);
      return promise;
    },
    subscribeEvidence(listener) { if (typeof listener !== 'function') throw dispatchError(); listeners.add(listener); return () => listeners.delete(listener); },
    subscribeClosed(listener) { if (typeof listener !== 'function') throw dispatchError(); closedListeners.add(listener); return () => closedListeners.delete(listener); },
    closeObservation(token) {
      const entry = tokens.get(token);
      if (!entry || entry.payloadCleared) return false;
      clearPayload(entry);
      return true;
    },
    inspectEvidence(token, receipt) {
      expire();
      const stored = receipts.get(receipt); const entry = tokens.get(token);
      if (!stored || stored.entry !== entry || stored.consumed || !evidenceCurrent(entry)) return null;
      return Object.freeze({ metadata: entry.metadata, ...stored.candidate });
    },
    consumeEvidence(token, receipt) {
      const stored = receipts.get(receipt); const entry = tokens.get(token);
      if (!stored || stored.entry !== entry || stored.consumed || !evidenceCurrent(entry)) return null;
      stored.consumed = true; receipts.delete(receipt); entry.receipts.delete(receipt); return stored.candidate;
    },
  });
  const controller = Object.freeze({
    canPrepare(value) { return facade.canPrepare(value); },
    isPending(token) { const entry = tokens.get(token); return Boolean(!invalidated && entry?.used && !entry.settled && !entry.conflict && entry.expiresAt > NOW()); },
    canAcknowledge(token, turnId) {
      const entry = tokens.get(token);
      return Boolean(!invalidated && entry?.used && !entry.settled && !entry.conflict && entry.expiresAt > NOW() &&
        typeof turnId === 'string' && turnId && (entry.metadata.mode !== 'steer' || turnId === entry.metadata.expectedTurnId) &&
        entry.candidates.every(candidate => candidate.nativeTurnId === turnId));
    },
    acknowledge(token, turnId, error = null) {
      const entry = tokens.get(token);
      if (!entry?.used || entry.settled) return false;
      if (error || typeof turnId !== 'string' || !turnId ||
          (entry.metadata.mode === 'steer' && turnId !== entry.metadata.expectedTurnId)) {
        settle(entry, dispatchError('instruction_ack_mismatch')); return false;
      }
      settle(entry, null, turnId); return true;
    },
    observeItem(threadId, turnId, item) {
      if (invalidated || !item || item.type !== 'userMessage' || typeof item.clientId !== 'string' ||
          typeof item.id !== 'string' || !item.id || typeof turnId !== 'string') return false;
      const entry = entries.get(item.clientId);
      if (!entry?.used || entry.payloadCleared || entry.settled && entry.conflict || entry.metadata.source.identity.nativeId !== threadId ||
          !entry.nativeTurnId && entry.expiresAt <= NOW()) return false;
      if (entry.nativeTurnId && !evidenceCurrent(entry)) { clearPayload(entry, 'instruction_source_invalid'); return false; }
      let input;
      try { input = normalizeNativeInput(item.content); } catch { entry.conflict = true; clearPayload(entry, 'instruction_evidence_conflict'); return false; }
      if (turnId !== (entry.nativeTurnId || entry.metadata.expectedTurnId) && entry.metadata.mode === 'steer' ||
          entry.nativeTurnId && turnId !== entry.nativeTurnId || JSON.stringify(input) !== JSON.stringify(entry.input)) {
        entry.conflict = true; clearPayload(entry, 'instruction_evidence_conflict'); return false;
      }
      const size = Buffer.byteLength(JSON.stringify({ nativeTurnId: turnId, nativeItemId: item.id, input }));
      if (candidateCount >= MAX_ENTRIES || retainedBytes + size > MAX_BYTES) { entry.conflict = true; clearPayload(entry, 'instruction_evidence_capacity'); return false; }
      const reservation = reservePayload(size, 1);
      if (!reservation) { entry.conflict = true; clearPayload(entry, 'instruction_evidence_capacity'); return false; }
      entry.reservations.add(reservation);
      candidateCount += 1; entry.candidateCount += 1; retainedBytes += size; entry.payloadBytes += size;
      entry.candidates.push(Object.freeze({ nativeTurnId: turnId, nativeItemId: item.id, input: entry.input }));
      flush(entry); return true;
    },
    invalidate() {
      invalidated = true;
      for (const entry of entries.values()) if (entry.used && !entry.settled) settle(entry, dispatchError());
      for (const entry of entries.values()) { clearTimeout(entry.expiryTimer); clearPayload(entry); }
      listeners.clear();
      closedListeners.clear();
    },
    endContext(turnId) {
      for (const entry of entries.values()) if (entry.nativeTurnId === turnId ||
          entry.used && entry.metadata.expectedTurnId === turnId) clearPayload(entry, 'instruction_context_ended');
    },
  });
  WRITERS.set(sourceCapability, facade);
  return controller;
}
function getOwnedInstructionWriter(sourceCapability) { return WRITERS.get(sourceCapability) || null; }
module.exports = { createOwnedInstructionWriter, getOwnedInstructionWriter, MAX_INSTRUCTION_DISPATCHES };
