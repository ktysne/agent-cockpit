'use strict';

const { normalizeMetadata, normalizeCommand, normalizeInput, exactData, dispatchError } = require('./owned-native-instruction-dispatch');
const { types } = require('node:util');
const WRITERS = new WeakMap();
const NOW = Date.now;
const MAX_ENTRIES = 128;
const MAX_BYTES = 256 * 1024;
const TTL_MS = 60_000;
const ACK_MS = 5_000;

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
  let retainedBytes = 0;
  let invalidated = false;
  let candidateCount = 0;
  function clearPayload(entry) {
    if (entry.payloadCleared) return;
    if (entry.used && !entry.settled) settle(entry, dispatchError('instruction_ack_timeout'));
    entry.payloadCleared = true;
    retainedBytes -= entry.payloadBytes || 0;
    candidateCount -= entry.candidateCount || 0;
    entry.input = null; entry.candidates.length = 0; entry.prepared = null; entry.resolve = null; entry.reject = null;
    for (const receipt of entry.receipts) receipts.delete(receipt);
    entry.receipts.clear();
  }
  function expire() { for (const entry of entries.values()) if (entry.expiresAt <= NOW()) clearPayload(entry); }

  function current(entry) {
    return !invalidated && entry && !entry.payloadCleared && !entry.used && entry.expiresAt > NOW() && operations.check(entry.capture, entry.metadata) === true;
  }
  function evidenceCurrent(entry) {
    return !invalidated && entry?.used && !entry.payloadCleared && !entry.conflict && entry.nativeTurnId && entry.expiresAt > NOW() &&
      operations.checkEvidence(entry.capture, entry.nativeTurnId) === true;
  }
  function settle(entry, error, nativeTurnId) {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    operations.complete(entry.token, error);
    if (error) { entry.conflict = true; entry.reject(error); return; }
    entry.nativeTurnId = nativeTurnId;
    entry.resolve(Object.freeze({ clientRequestId: entry.metadata.deliveryAttemptId, nativeTurnId, nativeItemId: null }));
    flush(entry);
  }
  function flush(entry) {
    if (entry.writing || !evidenceCurrent(entry)) return;
    for (const candidate of entry.candidates.splice(0)) {
      if (candidate.nativeTurnId !== entry.nativeTurnId) { entry.conflict = true; return; }
      const previous = itemOwners.get(candidate.nativeItemId);
      if (previous && previous !== entry) { previous.conflict = true; entry.conflict = true; return; }
      if (!previous && itemOwners.size >= MAX_ENTRIES) { entry.conflict = true; return; }
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
        settled: false, conflict: false, candidates: [], deliveredItems: new Set(), receipts: new Set(), candidateCount: 0, payloadBytes: 0, nativeTurnId: null, size };
      entries.set(metadata.deliveryAttemptId, entry); tokens.set(token, entry); retainedBytes += size;
      return token;
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
      let resolve; let reject;
      const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
      promise.catch(() => {});
      entry.resolve = resolve; entry.reject = reject;
      entry.timer = setTimeout(() => settle(entry, dispatchError('instruction_ack_timeout')), ACK_MS);
      entry.input = command.input; entry.prepared = prepared;
      entry.expiryTimer = setTimeout(() => clearPayload(entry), TTL_MS); entry.expiryTimer.unref();
      const onWrite = (error) => { if (error) settle(entry, dispatchError('instruction_write_failed')); };
      operations.register(entry.token, prepared, entry.metadata);
      let accepted = false;
      try { accepted = current(entry) && finalGuard() === true; } catch {}
      if (!accepted) {
        clearTimeout(entry.timer); clearTimeout(entry.expiryTimer); operations.unregister(entry.token, prepared); entry.prepared = null; entry.input = null; entry.resolve = null; entry.reject = null;
        throw dispatchError();
      }
      entry.used = true; retainedBytes += inputBytes; entry.payloadBytes += inputBytes; entry.writing = true;
      try {
        capturedWrite(capturedLine, onWrite);
      } catch { settle(entry, dispatchError('instruction_write_failed')); }
      entry.writing = false; entry.prepared = null;
      flush(entry);
      return promise;
    },
    subscribeEvidence(listener) { if (typeof listener !== 'function') throw dispatchError(); listeners.add(listener); return () => listeners.delete(listener); },
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
      if (!entry?.used || entry.settled && entry.conflict || entry.metadata.source.identity.nativeId !== threadId ||
          entry.expiresAt <= NOW()) return false;
      let input;
      try { input = normalizeNativeInput(item.content); } catch { entry.conflict = true; return false; }
      if (JSON.stringify(input) !== JSON.stringify(entry.input)) { entry.conflict = true; return false; }
      const size = Buffer.byteLength(JSON.stringify({ nativeTurnId: turnId, nativeItemId: item.id, input }));
      if (candidateCount >= MAX_ENTRIES || retainedBytes + size > MAX_BYTES) { entry.conflict = true; return false; }
      candidateCount += 1; entry.candidateCount += 1; retainedBytes += size; entry.payloadBytes += size;
      entry.candidates.push(Object.freeze({ nativeTurnId: turnId, nativeItemId: item.id, input: entry.input }));
      flush(entry); return true;
    },
    invalidate() {
      invalidated = true;
      for (const entry of entries.values()) if (entry.used && !entry.settled) settle(entry, dispatchError());
      for (const entry of entries.values()) { clearTimeout(entry.expiryTimer); clearPayload(entry); }
      listeners.clear();
    },
  });
  WRITERS.set(sourceCapability, facade);
  return controller;
}
function getOwnedInstructionWriter(sourceCapability) { return WRITERS.get(sourceCapability) || null; }
module.exports = { createOwnedInstructionWriter, getOwnedInstructionWriter };
