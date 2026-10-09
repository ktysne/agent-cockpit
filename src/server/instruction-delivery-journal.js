'use strict';

const fs = require('node:fs/promises');
const { AsyncLocalStorage } = require('node:async_hooks');
const path = require('node:path');
const { atomicWriteJson } = require('./json-storage');
const {
  instructionError,
  isIdentifier,
  isSha256Digest,
  parseInstructionEnvelope,
} = require('./instruction-envelope');
const {
  encodeInstructionJournalV2Local,
  normalizeInstructionJournalV2Local,
  normalizeInstructionRecordV2Local,
} = require('./delivery-reclamation-codec');
const { captureExactRecord } = require('./reclamation-codec-primitives');
const { checkedCapacityAdd, measureInstructionReservation } = require('./reclamation-capacity-bounds');

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

function logicalKeyV2(record) {
  return JSON.stringify([
    record.source.identity.provider,
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

function appendInstructionIntentV2(journalValue, recordValue, maxRecords = MAX_RECORDS) {
  const journal = normalizeInstructionJournalV2Local(journalValue, maxRecords);
  const legacy = normalizeInstructionRecord(recordValue);
  const record = normalizeInstructionRecordV2Local({
    recordType: 'detail',
    ...legacy,
    deliveryCreationState: 'not_created',
    reclamation: null,
  });
  const existing = journal.instructions.find((item) => item.deliveryAttemptId === record.deliveryAttemptId);
  if (existing) {
    if (existing.recordType !== 'detail' || existing.deliveryCreationState === 'indeterminate' ||
        existing.reclamation !== null) {
      throw journalError('instruction_recreation_forbidden');
    }
    const { recordType: _recordType, deliveryCreationState: _state, reclamation: _reclamation, ...existingIntent } = existing;
    if (!sameInstructionIntent(existingIntent, legacy)) throw journalError('instruction_attempt_conflict');
    return { journal, record: existing, created: false };
  }
  if (journal.instructions.some((item) => logicalKeyV2(item) === logicalKeyV2(record))) {
    throw journalError('instruction_logical_conflict');
  }
  if (journal.instructions.length >= maxRecords) throw journalError('instruction_journal_full');
  const candidate = normalizeInstructionJournalV2Local({
    schemaVersion: 2,
    revision: journal.revision + 1,
    storeId: journal.storeId,
    migrationAllowance: journal.migrationAllowance,
    instructions: [...journal.instructions, record],
  }, maxRecords);
  return { journal: candidate, record, created: true };
}

function updateInstructionCreationStateV2(journalValue, deliveryAttemptId, nextState, maxRecords = MAX_RECORDS) {
  const journal = normalizeInstructionJournalV2Local(journalValue, maxRecords);
  if (!['creating', 'checkpointed'].includes(nextState)) throw journalError('invalid_instruction_creation_state');
  const index = journal.instructions.findIndex((item) => item.deliveryAttemptId === deliveryAttemptId);
  const current = journal.instructions[index];
  if (!current || current.recordType !== 'detail' || current.reclamation !== null) {
    throw journalError('instruction_recreation_forbidden');
  }
  const allowed = current.deliveryCreationState === 'not_created' && nextState === 'creating' ||
    current.deliveryCreationState === 'creating' && nextState === 'checkpointed';
  if (!allowed) throw journalError('invalid_instruction_creation_state');
  const instructions = journal.instructions.slice();
  instructions[index] = normalizeInstructionRecordV2Local({ ...current, deliveryCreationState: nextState });
  const candidate = normalizeInstructionJournalV2Local({
    schemaVersion: 2,
    revision: journal.revision + 1,
    storeId: journal.storeId,
    migrationAllowance: journal.migrationAllowance,
    instructions,
  }, maxRecords);
  return { journal: candidate, record: instructions[index], changed: true };
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
  const allowed = ['filePath', 'maxBytes', 'maxRecords', 'atomicWrite', 'fileSystem', 'reclamation'];
  let optionKeys;
  try {
    optionKeys = Reflect.ownKeys(options);
  } catch {
    throw journalError('invalid_instruction_journal_options');
  }
  if (optionKeys.some((key) => typeof key !== 'string' || !allowed.includes(key))) {
    throw journalError('invalid_instruction_journal_options');
  }
  if (Object.hasOwn(options, 'reclamation')) return createReclamationInstructionDeliveryJournal(options);
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

function createReclamationInstructionDeliveryJournal(options) {
  const reclamation = options.reclamation;
  if (!isRecord(reclamation) || Reflect.ownKeys(reclamation).length !== 2 ||
      !Object.hasOwn(reclamation, 'backend') || !Object.hasOwn(reclamation, 'periodGate')) {
    throw journalError('invalid_reclamation_instruction_backend');
  }
  const backend = Object.getOwnPropertyDescriptor(reclamation, 'backend')?.value;
  const periodGate = Object.getOwnPropertyDescriptor(reclamation, 'periodGate')?.value;
  if (!backend || backend.slot !== 'instructions' || typeof backend.canWrite !== 'function' ||
      typeof backend.load !== 'function' ||
      typeof backend.save !== 'function' || typeof backend.prepareResume !== 'function' ||
      typeof backend.flush !== 'function' || typeof backend.close !== 'function' ||
      !Number.isSafeInteger(backend.normalByteLimit) || backend.normalByteLimit < 1 ||
      backend.normalByteLimit > MAX_BYTES || !periodGate || typeof periodGate.capture !== 'function' ||
      typeof periodGate.assertCurrent !== 'function') {
    throw journalError('invalid_reclamation_instruction_backend');
  }
  const maxBytes = options.maxBytes ?? backend.normalByteLimit;
  const maxRecords = options.maxRecords ?? MAX_RECORDS;
  if (maxBytes !== backend.normalByteLimit || !Number.isSafeInteger(maxRecords) ||
      maxRecords < 1 || maxRecords > MAX_RECORDS) throw journalError('invalid_instruction_journal_options');

  const bodyScope = new AsyncLocalStorage();
  const bodyScopeToken = {};
  let accepting = true;
  let prepared = false;
  let hasLoaded = false;
  let closed = false;
  let writeBlocked = false;
  let currentJournal = null;
  let lastCommittedRevision = -1;
  let tail = Promise.resolve();
  let closePromise = null;

  function assertBackendCanWrite() {
    let canWrite = false;
    try { canWrite = backend.canWrite() === true; } catch {}
    if (!canWrite) throw journalError('reclamation_service_blocked');
  }

  function enqueue(operation) {
    if (bodyScope.getStore() === bodyScopeToken) return Promise.reject(journalError(
      'instruction_body_access_reentry'));
    if (!accepting) return Promise.reject(journalError('instruction_journal_closed'));
    try { assertBackendCanWrite(); }
    catch (error) { return Promise.reject(error); }
    const result = tail.then(() => {
      assertBackendCanWrite();
      return operation();
    });
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  function measure(value, limitBytes) {
    const normalized = normalizeInstructionJournalV2Local(value, maxRecords);
    const reserved = measureInstructionReservation({ snapshot: normalized, currentByteLimit: maxBytes }).reservedBytes;
    if (reserved > limitBytes) throw journalError('instruction_journal_capacity_reserved');
    return normalized;
  }

  function transitionLimit(candidate) {
    const grant = candidate.migrationAllowance;
    if (grant === null) return maxBytes;
    if (!currentJournal) return checkedCapacityAdd(maxBytes, grant.maxExtraBytes);
    const previous = new Map(currentJournal.instructions.map((item) => [item.deliveryAttemptId, item]));
    const roster = new Set(grant.eligibleAttemptIds);
    const changed = candidate.instructions.filter((item) => {
      const old = previous.get(item.deliveryAttemptId);
      return old === undefined || !sameJson(old, item);
    });
    const allChangesEligible = changed.every((item) => previous.has(item.deliveryAttemptId) &&
      roster.has(item.deliveryAttemptId));
    return allChangesEligible ? checkedCapacityAdd(maxBytes, grant.maxExtraBytes) : maxBytes;
  }

  function assertTransition(candidate) {
    if (!currentJournal || candidate.storeId !== currentJournal.storeId ||
        candidate.revision !== currentJournal.revision + 1 ||
        !sameJson(candidate.migrationAllowance, currentJournal.migrationAllowance)) {
      throw journalError('instruction_journal_transition_rejected');
    }
    const nextById = new Map(candidate.instructions.map((item) => [item.deliveryAttemptId, item]));
    for (const old of currentJournal.instructions) {
      const next = nextById.get(old.deliveryAttemptId);
      if (!next) throw journalError('instruction_journal_record_removed');
      if (old.recordType === 'reclaimed' || old.deliveryCreationState === 'indeterminate' ||
          old.reclamation !== null) {
        if (!sameJson(old, next)) throw journalError('instruction_recreation_forbidden');
        continue;
      }
      const sameBase = (() => {
        const oldCopy = { ...old, deliveryCreationState: null };
        const nextCopy = { ...next, deliveryCreationState: null };
        return sameJson(oldCopy, nextCopy);
      })();
      const stateForward = old.deliveryCreationState === 'not_created' &&
        next.deliveryCreationState === 'creating' || old.deliveryCreationState === 'creating' &&
        next.deliveryCreationState === 'checkpointed';
      if (!sameBase || !(sameJson(old, next) || stateForward)) {
        throw journalError('instruction_creation_state_regressed');
      }
    }
    for (const next of candidate.instructions) {
      if (currentJournal.instructions.some((old) => old.deliveryAttemptId === next.deliveryAttemptId)) continue;
      if (next.recordType !== 'detail' || next.deliveryCreationState !== 'not_created' ||
          next.reclamation !== null) throw journalError('instruction_creation_state_invalid');
    }
  }

  async function loadNow() {
    if (closed) throw journalError('instruction_journal_closed');
    if (hasLoaded) return structuredClone(currentJournal);
    const loadedValue = await backend.load();
    const grantBytes = loadedValue?.migrationAllowance?.maxExtraBytes ?? 0;
    const loaded = measure(loadedValue, checkedCapacityAdd(backend.normalByteLimit, grantBytes));
    currentJournal = loaded;
    lastCommittedRevision = loaded.revision;
    hasLoaded = true;
    prepared = true;
    return structuredClone(loaded);
  }

  function load() {
    return enqueue(loadNow);
  }

  function save(value) {
    if (!accepting) return Promise.reject(journalError('instruction_journal_closed'));
    if (!prepared) return Promise.reject(journalError('reclamation_writer_cold'));
    let normalized;
    try {
      normalized = normalizeInstructionJournalV2Local(value, maxRecords);
      const encoded = encodeInstructionJournalV2Local(normalized, maxRecords);
      if (encoded.sizeBytes > checkedCapacityAdd(maxBytes, normalized.migrationAllowance?.maxExtraBytes ?? 0)) {
        throw journalError('instruction_journal_too_large');
      }
      normalized = structuredClone(normalized);
    } catch (error) {
      return Promise.reject(error);
    }
    return enqueue(async () => {
      if (closed) throw journalError('instruction_journal_closed');
      if (!hasLoaded) await loadNow();
      if (writeBlocked) throw journalError('instruction_journal_writer_blocked');
      if (normalized.revision <= lastCommittedRevision) {
        throw journalError('instruction_journal_revision_not_advanced');
      }
      assertTransition(normalized);
      const limitBytes = transitionLimit(normalized);
      const checked = measure(normalized, limitBytes);
      try {
        const saved = normalizeInstructionJournalV2Local(await backend.save(checked), maxRecords);
        currentJournal = saved;
        lastCommittedRevision = saved.revision;
        return structuredClone(saved);
      } catch (error) {
        writeBlocked = true;
        throw error;
      }
    });
  }

  function withInstructionBody(value, callback) {
    const request = captureExactRecord(value, ['deliveryAttemptId'], 'invalid_instruction_body_reclamation');
    const id = request.deliveryAttemptId;
    if (!isIdentifier(id) || typeof callback !== 'function') {
      throw journalError('invalid_instruction_body_reclamation');
    }
    return enqueue(async () => {
      if (!hasLoaded) await loadNow();
      let active = true;
      const assertAccess = () => {
        if (!active || bodyScope.getStore() !== bodyScopeToken) {
          throw journalError('instruction_body_access_expired');
        }
        if (!accepting || closed || closePromise || writeBlocked || !prepared) {
          throw journalError('instruction_journal_closed');
        }
        assertBackendCanWrite();
      };
      const access = Object.freeze({
        snapshot() { assertAccess(); return structuredClone(currentJournal); },
        async persist(value) {
          assertAccess();
          const candidate = normalizeInstructionJournalV2Local(value, maxRecords);
          const old = currentJournal.instructions.find((item) => item.deliveryAttemptId === id);
          const nextById = new Map(candidate.instructions.map((item) => [item.deliveryAttemptId, item]));
          const next = nextById.get(id);
          if (!old || !next || old.recordType !== 'detail' || old.deliveryCreationState !== 'checkpointed' ||
              candidate.storeId !== currentJournal.storeId || candidate.revision !== currentJournal.revision + 1 ||
              candidate.instructions.length !== currentJournal.instructions.length ||
              !sameJson(candidate.migrationAllowance, currentJournal.migrationAllowance) ||
              currentJournal.instructions.some((item) => item.deliveryAttemptId !== id &&
                !sameJson(item, nextById.get(item.deliveryAttemptId)))) {
            throw journalError('invalid_instruction_body_reclamation_candidate');
          }
          const preparing = old.reclamation === null && next.recordType === 'detail' && next.reclamation !== null;
          const reclaiming = old.reclamation !== null && next.recordType === 'reclaimed' &&
            sameJson(old.reclamation, next.reclamation);
          const strip = (item) => {
            const { recordType, reclamation, reclaimedAt, envelope, ...fixed } = item;
            return fixed;
          };
          if (!(preparing || reclaiming) || !sameJson(strip(old), strip(next)) ||
              preparing && old.envelope !== next.envelope ||
              reclaiming && next.reclaimedAt < old.reclamation.preparedAt) {
            throw journalError('invalid_instruction_body_reclamation_candidate');
          }
          const checked = measure(candidate, transitionLimit(candidate));
          assertAccess();
          try {
            const saved = normalizeInstructionJournalV2Local(await backend.save(checked, assertAccess), maxRecords);
            currentJournal = saved;
            lastCommittedRevision = saved.revision;
            return structuredClone(saved);
          } catch (error) { writeBlocked = true; throw error; }
        },
      });
      try { return await bodyScope.run(bodyScopeToken, () => callback(access)); }
      finally { active = false; }
    });
  }

  function flush() {
    if (bodyScope.getStore() === bodyScopeToken) return Promise.reject(journalError('instruction_body_access_reentry'));
    if (!accepting) return Promise.reject(journalError('instruction_journal_closed'));
    if (!prepared) return Promise.reject(journalError('reclamation_writer_cold'));
    return tail.then(() => backend.flush());
  }

  async function prepareResume(fullSnapshot) {
    if (closed || !isRecord(fullSnapshot) || !isRecord(fullSnapshot.stores) ||
        !Object.hasOwn(fullSnapshot.stores, 'instructions')) {
      throw journalError('invalid_reclamation_instruction_resume');
    }
    const raw = fullSnapshot.stores.instructions;
    const grantBytes = raw?.migrationAllowance?.maxExtraBytes ?? 0;
    const normalized = measure(raw, checkedCapacityAdd(backend.normalByteLimit, grantBytes));
    await backend.prepareResume(fullSnapshot);
    if (closed || closePromise) throw journalError('instruction_journal_closed');
    currentJournal = normalized;
    lastCommittedRevision = normalized.revision;
    hasLoaded = true;
    prepared = true;
    accepting = true;
    writeBlocked = false;
  }

  function close() {
    if (bodyScope.getStore() === bodyScopeToken) return Promise.reject(journalError('instruction_body_access_reentry'));
    if (closePromise) return closePromise;
    accepting = false;
    closePromise = tail.then(() => { closed = true; });
    return closePromise;
  }

  const reclamationWriter = Object.freeze({
    stop: () => { accepting = false; },
    drain: () => tail,
    prepareResume,
  });

  function assertCapacityReserved(value) {
    const normalized = normalizeInstructionJournalV2Local(value, maxRecords);
    const limitBytes = checkedCapacityAdd(maxBytes, normalized.migrationAllowance?.maxExtraBytes ?? 0);
    const reservedBytes = measureInstructionReservation({ snapshot: normalized, currentByteLimit: maxBytes }).reservedBytes;
    if (reservedBytes > limitBytes) throw journalError('instruction_journal_capacity_reserved');
    return reservedBytes;
  }

  return Object.freeze({
    filePath: null,
    maxBytes,
    maxRecords,
    canWrite: () => backend.canWrite() === true,
    load,
    save,
    flush,
    close,
    assertCapacityReserved,
    reclamationWriter,
    withInstructionBody,
  });
}

module.exports = {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_RECORDS,
  appendInstructionIntent,
  appendInstructionIntentV2,
  createEmptyJournal,
  createInstructionDeliveryJournal,
  normalizeInstructionRecord,
  normalizeJournal,
  sourceProjectionFromDelivery,
  sourceProjectionFromLaunch,
  updateInstructionCreationStateV2,
};
