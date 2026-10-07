'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteJson } = require('./json-storage');
const {
  instructionError,
  isIdentifier,
  isSha256Digest,
  parseInstructionEnvelope,
} = require('./instruction-envelope');

const SCHEMA_VERSION = 1;
const DEFAULT_MAX_BYTES = 16 * 1024 * 1024;
const MAX_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_RECORDS = 20_000;
const MAX_RECORDS = 20_000;
const JOURNAL_WRITERS = new Map();
const CLAIM_FIELDS = [
  'launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId',
  'origin', 'purpose', 'originBinding',
];
const IDENTITY_FIELDS = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
const JOURNAL_FIELDS = ['schemaVersion', 'revision', 'instructions'];
const RECORD_FIELDS = [
  'deliveryAttemptId', 'launchRef', 'logicalMessageId', 'revision', 'source',
  'envelope', 'envelopeDigest', 'nativeContentDigest', 'createdAt',
];
const NATIVE_ID_KINDS = Object.freeze({ claude: 'session', codex: 'thread' });

function journalError(code) {
  const error = instructionError(code);
  error.message = 'instruction journal rejected the operation';
  return error;
}

function isRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactObject(value, fields, code = 'invalid_instruction_journal') {
  if (!isRecord(value)) throw journalError(code);
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    throw journalError(code);
  }
  if (keys.length !== fields.length || keys.some((key) => typeof key !== 'string' || !fields.includes(key))) {
    throw journalError(code);
  }
  const result = {};
  for (const field of fields) {
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, field);
    } catch {
      throw journalError(code);
    }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) {
      throw journalError(code);
    }
    result[field] = descriptor.value;
  }
  return result;
}

function normalizePeriodBinding(value) {
  const binding = exactObject(value, ['periodId', 'actor']);
  if (!isIdentifier(binding.periodId)) throw journalError('invalid_instruction_source');
  const actor = exactObject(binding.actor, ['kind', 'id'], 'invalid_instruction_source');
  if (!['agent', 'tool-use'].includes(actor.kind) || !isIdentifier(actor.id)) {
    throw journalError('invalid_instruction_source');
  }
  return { periodId: binding.periodId, actor: { kind: actor.kind, id: actor.id } };
}

function normalizeSourceProjection(value) {
  const source = exactObject(value, [
    'launchRef', 'claims', 'identity', 'executionBinding', 'conversationId', 'sessionId',
  ], 'invalid_instruction_source');
  if (!isIdentifier(source.launchRef) || !isIdentifier(source.conversationId) ||
      !isIdentifier(source.sessionId)) throw journalError('invalid_instruction_source');

  const claims = exactObject(source.claims, CLAIM_FIELDS, 'invalid_instruction_source');
  if (!isIdentifier(claims.launchId) || !isIdentifier(claims.runId) || !isIdentifier(claims.attemptId) ||
      !Object.hasOwn(NATIVE_ID_KINDS, claims.provider) ||
      claims.nativeIdKind !== NATIVE_ID_KINDS[claims.provider] ||
      !isIdentifier(claims.hostId) || !isIdentifier(claims.homeScopeId)) {
    throw journalError('invalid_instruction_source');
  }
  const validPurpose = (claims.origin === 'standalone' && ['agent', 'pr-creator'].includes(claims.purpose)) ||
    (claims.origin === 'delegated' && claims.purpose === 'agent') ||
    (claims.origin === 'review' && claims.purpose === 'cross-review');
  if (!validPurpose) throw journalError('invalid_instruction_source');
  let originBinding = null;
  if (claims.origin === 'standalone') {
    if (claims.originBinding !== null) throw journalError('invalid_instruction_source');
  } else {
    originBinding = normalizePeriodBinding(claims.originBinding);
  }

  const identity = exactObject(source.identity, IDENTITY_FIELDS, 'invalid_instruction_source');
  if (!Object.hasOwn(NATIVE_ID_KINDS, identity.provider) ||
      identity.nativeIdKind !== NATIVE_ID_KINDS[identity.provider] ||
      !isIdentifier(identity.hostId) || !isIdentifier(identity.homeScopeId) ||
      !isIdentifier(identity.nativeId) ||
      identity.provider !== claims.provider || identity.nativeIdKind !== claims.nativeIdKind ||
      identity.hostId !== claims.hostId || identity.homeScopeId !== claims.homeScopeId) {
    throw journalError('invalid_instruction_source');
  }
  const executionBinding = normalizePeriodBinding(source.executionBinding);
  return {
    launchRef: source.launchRef,
    claims: {
      launchId: claims.launchId,
      runId: claims.runId,
      attemptId: claims.attemptId,
      provider: claims.provider,
      nativeIdKind: claims.nativeIdKind,
      hostId: claims.hostId,
      homeScopeId: claims.homeScopeId,
      origin: claims.origin,
      purpose: claims.purpose,
      originBinding,
    },
    identity,
    executionBinding,
    conversationId: source.conversationId,
    sessionId: source.sessionId,
  };
}

function sourceProjectionFromLaunch(record) {
  if (!isRecord(record)) throw journalError('instruction_launch_unavailable');
  let claims;
  try {
    claims = Object.fromEntries(CLAIM_FIELDS.map((field) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, field);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid_source');
      return [field, descriptor.value];
    }));
    const pick = (key) => {
      const descriptor = Object.getOwnPropertyDescriptor(record, key);
      if (!descriptor || !Object.hasOwn(descriptor, 'value')) throw new Error('invalid_source');
      return descriptor.value;
    };
    return normalizeSourceProjection({
      launchRef: pick('launchRef'),
      claims,
      identity: pick('identity'),
      executionBinding: pick('executionBinding'),
      conversationId: pick('conversationId'),
      sessionId: pick('sessionId'),
    });
  } catch {
    throw journalError('instruction_launch_unavailable');
  }
}

function sourceProjectionFromDelivery(delivery) {
  if (!isRecord(delivery) || !isRecord(delivery.source)) throw journalError('instruction_delivery_mismatch');
  const source = delivery.source;
  return normalizeSourceProjection({
    launchRef: source.launchRef,
    claims: source.claims,
    identity: source.identity,
    executionBinding: source.executionBinding,
    conversationId: source.conversationId,
    sessionId: source.sessionId,
  });
}

function normalizeInstructionRecord(value) {
  const record = exactObject(value, RECORD_FIELDS);
  if (!isIdentifier(record.deliveryAttemptId) || !isIdentifier(record.launchRef) ||
      !isIdentifier(record.logicalMessageId) || !Number.isSafeInteger(record.revision) || record.revision < 0 ||
      !Number.isSafeInteger(record.createdAt) || record.createdAt < 0 ||
      typeof record.envelope !== 'string' || !isSha256Digest(record.envelopeDigest) ||
      !isSha256Digest(record.nativeContentDigest)) {
    throw journalError('invalid_instruction_record');
  }
  const envelope = parseInstructionEnvelope(record.envelope);
  if (envelope.envelopeDigest !== record.envelopeDigest ||
      envelope.nativeContentDigest !== record.nativeContentDigest) {
    throw journalError('instruction_digest_mismatch');
  }
  const source = normalizeSourceProjection(record.source);
  if (source.launchRef !== record.launchRef) throw journalError('instruction_source_mismatch');
  return {
    deliveryAttemptId: record.deliveryAttemptId,
    launchRef: record.launchRef,
    logicalMessageId: record.logicalMessageId,
    revision: record.revision,
    source,
    envelope: envelope.serialized,
    envelopeDigest: envelope.envelopeDigest,
    nativeContentDigest: envelope.nativeContentDigest,
    createdAt: record.createdAt,
  };
}

function logicalKey(record) {
  return JSON.stringify([
    record.source.claims.provider,
    record.source.executionBinding.periodId,
    record.logicalMessageId,
    record.revision,
  ]);
}

function normalizeJournal(value, maxRecords = MAX_RECORDS) {
  const journal = exactObject(value, JOURNAL_FIELDS);
  if (journal.schemaVersion !== SCHEMA_VERSION || !Number.isSafeInteger(journal.revision) ||
      journal.revision < 0 || !Array.isArray(journal.instructions) ||
      journal.instructions.length > maxRecords) {
    throw journalError('invalid_instruction_journal');
  }
  let keys;
  try {
    keys = Reflect.ownKeys(journal.instructions);
  } catch {
    throw journalError('invalid_instruction_journal');
  }
  if (keys.length !== journal.instructions.length + 1 || !keys.includes('length') ||
      keys.filter((key) => key !== 'length').some((key, index) => key !== String(index))) {
    throw journalError('invalid_instruction_journal');
  }
  const instructions = [];
  const attempts = new Set();
  const logicalKeys = new Set();
  for (const item of journal.instructions) {
    const record = normalizeInstructionRecord(item);
    const logical = logicalKey(record);
    if (attempts.has(record.deliveryAttemptId) || logicalKeys.has(logical)) {
      throw journalError('instruction_journal_conflict');
    }
    attempts.add(record.deliveryAttemptId);
    logicalKeys.add(logical);
    instructions.push(record);
  }
  return { schemaVersion: SCHEMA_VERSION, revision: journal.revision, instructions };
}

function createEmptyJournal() {
  return { schemaVersion: SCHEMA_VERSION, revision: 0, instructions: [] };
}

function sameJson(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameInstructionIntent(left, right) {
  const { createdAt: _leftCreatedAt, ...leftRest } = left;
  const { createdAt: _rightCreatedAt, ...rightRest } = right;
  return sameJson(leftRest, rightRest);
}

function appendInstructionIntent(journalValue, recordValue, maxRecords = MAX_RECORDS) {
  const journal = normalizeJournal(journalValue, maxRecords);
  const record = normalizeInstructionRecord(recordValue);
  const existing = journal.instructions.find((item) => item.deliveryAttemptId === record.deliveryAttemptId);
  if (existing) {
    if (!sameInstructionIntent(existing, record)) throw journalError('instruction_attempt_conflict');
    return { journal, record: existing, created: false };
  }
  if (journal.instructions.some((item) => logicalKey(item) === logicalKey(record))) {
    throw journalError('instruction_logical_conflict');
  }
  if (journal.instructions.length >= maxRecords) throw journalError('instruction_journal_full');
  return {
    journal: {
      schemaVersion: SCHEMA_VERSION,
      revision: journal.revision + 1,
      instructions: [...journal.instructions, record],
    },
    record,
    created: true,
  };
}

function serialize(value) {
  return JSON.stringify(value, null, 2) + '\n';
}

function pathKey(value) {
  const absolute = path.resolve(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function createInstructionDeliveryJournal(options = {}) {
  if (!isRecord(options)) throw journalError('invalid_instruction_journal_options');
  const allowed = ['filePath', 'maxBytes', 'maxRecords', 'atomicWrite', 'fileSystem'];
  let optionKeys;
  try {
    optionKeys = Reflect.ownKeys(options);
  } catch {
    throw journalError('invalid_instruction_journal_options');
  }
  if (optionKeys.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    throw journalError('invalid_instruction_journal_options');
  }
  const filePath = options.filePath;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxRecords = options.maxRecords ?? DEFAULT_MAX_RECORDS;
  const fileSystem = options.fileSystem || fs;
  const atomicWrite = options.atomicWrite || ((target, value) => atomicWriteJson(
    path.dirname(target), path.basename(target), value, fileSystem));
  if (typeof filePath !== 'string' || !filePath.trim() ||
      !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_RECORDS ||
      typeof atomicWrite !== 'function' || !fileSystem ||
      typeof fileSystem.lstat !== 'function' || typeof fileSystem.open !== 'function') {
    throw journalError('invalid_instruction_journal_options');
  }
  const resolvedPath = path.resolve(filePath);
  const key = pathKey(resolvedPath);
  if (JOURNAL_WRITERS.has(key)) throw journalError('instruction_journal_path_in_use');
  const owner = Object.freeze({});
  JOURNAL_WRITERS.set(key, owner);

  let accepting = true;
  let closed = false;
  let writeBlocked = false;
  let hasLoaded = false;
  let lastCommittedRevision = -1;
  let currentJournal = createEmptyJournal();
  let tail = Promise.resolve();
  let closePromise = null;

  function enqueue(operation) {
    if (!accepting) return Promise.reject(journalError('instruction_journal_closed'));
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function loadNow() {
    if (closed) throw journalError('instruction_journal_closed');
    if (hasLoaded) return structuredClone(currentJournal);
    let handle;
    try {
      const linkStat = await fileSystem.lstat(resolvedPath);
      if (linkStat.isSymbolicLink() || !linkStat.isFile()) throw journalError('invalid_instruction_journal_file');
      handle = await fileSystem.open(resolvedPath, 'r');
      const fileStat = await handle.stat();
      if (!fileStat.isFile() || fileStat.size > maxBytes) throw journalError('instruction_journal_too_large');
      const bytes = Buffer.allocUnsafe(maxBytes + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > maxBytes) throw journalError('instruction_journal_too_large');
      let parsed;
      try {
        const sourceBytes = bytes.subarray(0, bytesRead);
        const sourceText = sourceBytes.toString('utf8');
        if (!Buffer.from(sourceText, 'utf8').equals(sourceBytes)) throw new Error('invalid_utf8');
        parsed = JSON.parse(sourceText);
      } catch {
        throw journalError('invalid_instruction_journal_json');
      }
      const normalized = normalizeJournal(parsed, maxRecords);
      assertCapacityReserved(normalized, maxBytes, maxRecords);
      if (normalized.revision < lastCommittedRevision) throw journalError('instruction_journal_revision_regressed');
      currentJournal = normalized;
      lastCommittedRevision = normalized.revision;
      hasLoaded = true;
      return structuredClone(currentJournal);
    } catch (error) {
      if (error.code === 'ENOENT' && lastCommittedRevision < 0) {
        currentJournal = createEmptyJournal();
        hasLoaded = true;
        return structuredClone(currentJournal);
      }
      if (error.code === 'ENOENT') throw journalError('instruction_journal_missing_after_commit');
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  function load() {
    return enqueue(loadNow);
  }

  function assertCapacityReserved(value, overrideMaxBytes = maxBytes, overrideMaxRecords = maxRecords) {
    const normalized = normalizeJournal(value, overrideMaxRecords);
    const serializedBytes = Buffer.byteLength(serialize(normalized), 'utf8');
    const revisionReserve = Math.max(0, String(Number.MAX_SAFE_INTEGER).length - String(normalized.revision).length);
    if (serializedBytes + revisionReserve > overrideMaxBytes) {
      throw journalError('instruction_journal_capacity_reserved');
    }
    if (normalized.instructions.length > overrideMaxRecords) {
      throw journalError('instruction_journal_capacity_reserved');
    }
    return serializedBytes + revisionReserve;
  }

  function save(value) {
    if (!accepting) return Promise.reject(journalError('instruction_journal_closed'));
    let normalized;
    let serializedBytes;
    try {
      normalized = normalizeJournal(value, maxRecords);
      assertCapacityReserved(normalized, maxBytes, maxRecords);
      serializedBytes = Buffer.byteLength(serialize(normalized), 'utf8');
      if (serializedBytes > maxBytes) throw journalError('instruction_journal_too_large');
      normalized = structuredClone(normalized);
    } catch (error) {
      return Promise.reject(error);
    }
    return enqueue(async () => {
      if (closed) throw journalError('instruction_journal_closed');
      if (!hasLoaded) await loadNow();
      if (writeBlocked) throw journalError('instruction_journal_writer_blocked');
      if (normalized.revision <= lastCommittedRevision) throw journalError('instruction_journal_revision_not_advanced');
      try {
        await atomicWrite(resolvedPath, structuredClone(normalized));
      } catch {
        writeBlocked = true;
        throw journalError('instruction_journal_write_failed');
      }
      currentJournal = normalized;
      lastCommittedRevision = normalized.revision;
      return structuredClone(currentJournal);
    });
  }

  function flush() {
    if (!accepting) return Promise.reject(journalError('instruction_journal_closed'));
    return tail;
  }

  function close() {
    if (closePromise) return closePromise;
    accepting = false;
    closePromise = tail.then(async () => {
      closed = true;
      if (JOURNAL_WRITERS.get(key) === owner) JOURNAL_WRITERS.delete(key);
    });
    return closePromise;
  }

  return Object.freeze({
    filePath: resolvedPath,
    maxBytes,
    maxRecords,
    load,
    save,
    flush,
    close,
    assertCapacityReserved: (value) => assertCapacityReserved(value),
  });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_RECORDS,
  appendInstructionIntent,
  createEmptyJournal,
  createInstructionDeliveryJournal,
  normalizeInstructionRecord,
  normalizeJournal,
  sourceProjectionFromDelivery,
  sourceProjectionFromLaunch,
};
