'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { atomicWriteJson } = require('./json-storage');
const {
  MAX_JOURNAL_RECORDS,
  createEmptyJournal,
  normalizeJournal,
  questionError,
} = require('./common-question-kernel');

const DEFAULT_MAX_JOURNAL_BYTES = 16 * 1024 * 1024;
const MAX_CONFIGURABLE_JOURNAL_BYTES = 16 * 1024 * 1024;
const JOURNAL_WRITERS = new Map();

function journalPath(input) {
  if (typeof input !== 'string' || !input.trim()) throw questionError('invalid_journal_path');
  return path.resolve(input);
}

function pathKey(value) {
  const absolute = path.resolve(value);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

function serialize(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function createCommonQuestionJournal(options = {}) {
  if (!options || typeof options !== 'object' || Array.isArray(options)) throw questionError('invalid_journal_options');
  const filePath = journalPath(options.filePath);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_JOURNAL_BYTES;
  const maxRecords = options.maxRecords ?? MAX_JOURNAL_RECORDS;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_CONFIGURABLE_JOURNAL_BYTES ||
      !Number.isSafeInteger(maxRecords) || maxRecords < 1 || maxRecords > MAX_JOURNAL_RECORDS) {
    throw questionError('invalid_journal_limits');
  }
  const fileSystem = options.fileSystem || fs;
  const atomicWrite = options.atomicWrite || ((target, value) => atomicWriteJson(
    path.dirname(target), path.basename(target), value, fileSystem));
  if (typeof atomicWrite !== 'function' || !fileSystem || typeof fileSystem.lstat !== 'function' ||
      typeof fileSystem.open !== 'function') throw questionError('invalid_journal_writer');
  const key = pathKey(filePath);
  if (JOURNAL_WRITERS.has(key)) throw questionError('journal_path_in_use');
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
    if (!accepting) return Promise.reject(questionError('journal_closed'));
    const result = tail.then(operation);
    tail = result.then(() => undefined, () => undefined);
    return result;
  }

  async function loadNow() {
    if (closed) throw questionError('journal_closed');
    if (hasLoaded) return structuredClone(currentJournal);
    let handle;
    try {
      const linkStat = await fileSystem.lstat(filePath);
      if (linkStat.isSymbolicLink() || !linkStat.isFile()) throw questionError('invalid_journal_file');
      handle = await fileSystem.open(filePath, 'r');
      const fileStat = await handle.stat();
      if (!fileStat.isFile() || fileStat.size > maxBytes) throw questionError('journal_too_large');
      const bytes = Buffer.allocUnsafe(maxBytes + 1);
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const result = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (result.bytesRead === 0) break;
        bytesRead += result.bytesRead;
      }
      if (bytesRead > maxBytes) throw questionError('journal_too_large');
      let parsed;
      try {
        const sourceBytes = bytes.subarray(0, bytesRead);
        const sourceText = sourceBytes.toString('utf8');
        if (!Buffer.from(sourceText, 'utf8').equals(sourceBytes)) throw new Error('invalid_utf8');
        parsed = JSON.parse(sourceText);
      } catch { throw questionError('invalid_journal_json'); }
      const normalized = normalizeJournal(parsed, maxRecords);
      if (normalized.revision < lastCommittedRevision) throw questionError('journal_revision_regressed');
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
      if (error.code === 'ENOENT') throw questionError('journal_missing_after_commit');
      throw error;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  function load() {
    return enqueue(loadNow);
  }

  function save(input) {
    if (!accepting) return Promise.reject(questionError('journal_closed'));
    let normalized;
    let sizeBytes;
    try {
      normalized = normalizeJournal(input, maxRecords);
      assertCapacityReserved(normalized, maxBytes, maxRecords);
      const serialized = serialize(normalized);
      sizeBytes = Buffer.byteLength(serialized, 'utf8');
      if (sizeBytes > maxBytes) throw questionError('journal_too_large');
      normalized = structuredClone(normalized);
    } catch (error) {
      return Promise.reject(error);
    }
    return enqueue(async () => {
      if (closed) throw questionError('journal_closed');
      if (!hasLoaded) await loadNow();
      if (writeBlocked) throw questionError('journal_writer_blocked');
      if (sizeBytes > maxBytes) throw questionError('journal_too_large');
      if (normalized.revision <= lastCommittedRevision) throw questionError('journal_revision_not_advanced');
      try {
        await atomicWrite(filePath, structuredClone(normalized));
      } catch {
        writeBlocked = true;
        throw questionError('journal_write_failed');
      }
      currentJournal = normalized;
      lastCommittedRevision = normalized.revision;
      return structuredClone(currentJournal);
    });
  }

  function flush() {
    if (!accepting) return Promise.reject(questionError('journal_closed'));
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

  return Object.freeze({ filePath, maxBytes, maxRecords, load, save, flush, close,
    assertCapacityReserved: (value) => assertCapacityReserved(value, maxBytes, maxRecords) });
}

module.exports = {
  DEFAULT_MAX_JOURNAL_BYTES,
  MAX_CONFIGURABLE_JOURNAL_BYTES,
  createCommonQuestionJournal,
};

function embeddedRecordBytes(record) {
  const text = JSON.stringify(record, null, 2).split('\n').map((line) => '    ' + line).join('\n');
  return Buffer.byteLength(text, 'utf8');
}

function worstAnswers(questions) {
  const { MAX_FREE_TEXT } = require('./common-question-kernel');
  const text = '\uD800'.repeat(MAX_FREE_TEXT);
  return questions.map((question) => {
    let optionIds = [];
    if (question.mode === 'multi') optionIds = question.options.map((option) => option.id);
    else if (question.options.length) {
      optionIds = [question.options.reduce((best, option) =>
        Buffer.byteLength(JSON.stringify(option.id), 'utf8') > Buffer.byteLength(JSON.stringify(best.id), 'utf8')
          ? option : best).id];
    }
    return { questionId: question.id, optionIds, freeText: question.allowFreeText ? text : null };
  });
}

function sizeRecordForFuture(record) {
  const sized = structuredClone(record);
  const answers = worstAnswers(record.questions);
  if (!sized.selection && sized.cancelledAt === null && sized.externalResolution === null) {
    sized.revision = 1;
    sized.selection = { source: 'away-default', selectedAt: Number.MAX_SAFE_INTEGER, answers };
    sized.deliveryIntent = {
      deliveryAttemptId: '\uD800'.repeat(512),
      logicalMessageId: '\uD800'.repeat(512),
      revision: 1,
      payloadDigest: 'f'.repeat(64),
    };
  }
  if (sized.cancelledAt === null) sized.cancelledAt = Number.MAX_SAFE_INTEGER;
  if (sized.externalResolution === null) sized.externalResolution = {
    resolvedAt: Number.MAX_SAFE_INTEGER, evidenceDigest: 'f'.repeat(64),
  };
  if (sized.cancelledAt === null || sized.externalResolution !== null || sized.selection !== null) {
    sized.lateAnswers = sized.lateAnswers.slice();
    while (sized.lateAnswers.length < require('./common-question-kernel').MAX_LATE_ANSWERS) {
      sized.lateAnswers.push({ submittedAt: Number.MAX_SAFE_INTEGER, digest: 'f'.repeat(64), answers });
    }
  }
  return sized;
}

function assertCapacityReserved(value, maxBytes, maxRecords) {
  const normalized = normalizeJournal(value, maxRecords);
  const baseBytes = Buffer.byteLength(serialize(normalized), 'utf8');
  let reservedBytes = baseBytes + String(Number.MAX_SAFE_INTEGER).length - String(normalized.revision).length;
  if (reservedBytes > maxBytes) throw questionError('journal_capacity_reserved');
  for (const record of normalized.questions) {
    reservedBytes += Math.max(0, embeddedRecordBytes(sizeRecordForFuture(record)) - embeddedRecordBytes(record));
    if (reservedBytes > maxBytes) throw questionError('journal_capacity_reserved');
  }
  return reservedBytes;
}

module.exports.assertCapacityReserved = assertCapacityReserved;
