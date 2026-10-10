'use strict';

const crypto = require('node:crypto');
const fsPromises = require('node:fs/promises');
const path = require('node:path');
const { types } = require('node:util');
const {
  MAX_STOP_ENSURE_RECORD_BYTES,
  decodeStopEnsureRecord,
  encodeStopEnsureRecord,
  normalizeStopEnsureExpectedIds,
} = require('./stop-ensure-record-codec');

const STORE_OPTIONS_ERROR = 'invalid_stop_ensure_store_options';
const RESULT_CONFLICT_ERROR = 'stop_ensure_result_conflict';
const FILE_SYSTEM_METHODS = Object.freeze(['lstat', 'open', 'rename', 'unlink']);
const READ_BUFFER_BYTES = MAX_STOP_ENSURE_RECORD_BYTES + 1;

function storeOptionsError() {
  throw new TypeError(STORE_OPTIONS_ERROR);
}

function resultConflictError() {
  throw new TypeError(RESULT_CONFLICT_ERROR);
}

function capturePlainData(value, allowedKeys, requiredKeys, errorFactory) {
  if (value === null || typeof value !== 'object' || types.isProxy(value)) errorFactory();

  let prototype;
  let keys;
  try {
    prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) errorFactory();
    keys = Reflect.ownKeys(value);
  } catch {
    errorFactory();
  }

  if (keys.some((key) => typeof key !== 'string' || !allowedKeys.includes(key)) ||
      requiredKeys.some((key) => !keys.includes(key))) {
    errorFactory();
  }

  const captured = Object.create(null);
  try {
    for (const key of keys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) errorFactory();
      Object.defineProperty(captured, key, {
        value: descriptor.value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
  } catch {
    errorFactory();
  }
  return Object.freeze(captured);
}

function captureFileSystem(value) {
  if (value === undefined) {
    return Object.freeze({
      source: fsPromises,
      methods: Object.freeze(Object.fromEntries(FILE_SYSTEM_METHODS.map((name) => [name, fsPromises[name]]))),
    });
  }

  let source;
  let methods;
  try {
    source = capturePlainData(value, FILE_SYSTEM_METHODS, FILE_SYSTEM_METHODS, storeOptionsError);
    methods = Object.create(null);
    for (const name of FILE_SYSTEM_METHODS) {
      if (typeof source[name] !== 'function') storeOptionsError();
      methods[name] = source[name];
    }
  } catch {
    storeOptionsError();
  }
  return Object.freeze({ source, methods: Object.freeze(methods) });
}

function isDirectoryStat(stat) {
  return Boolean(stat && typeof stat.isDirectory === 'function' &&
    typeof stat.isSymbolicLink === 'function' && stat.isDirectory() && !stat.isSymbolicLink());
}

function isRegularFileStat(stat) {
  return Boolean(stat && typeof stat.isFile === 'function' &&
    typeof stat.isSymbolicLink === 'function' && stat.isFile() && !stat.isSymbolicLink());
}

function isEnoent(error) {
  return Boolean(error && error.code === 'ENOENT');
}

function makeReadUnknown(diagnostic, closeFailed = false) {
  return Object.freeze({ status: 'unknown', diagnostic, closeFailed });
}

function makeWriteUnknown(diagnostic, cleanupFailed = false) {
  return Object.freeze({ status: 'unknown', diagnostic, cleanupFailed });
}

function expectedRecordIds(recordBytes) {
  const record = JSON.parse(recordBytes.toString('utf8'));
  return normalizeStopEnsureExpectedIds(record.kind === 'shutdown' ? {
    kind: record.kind,
    instanceId: record.instanceId,
    requestId: record.requestId,
  } : {
    kind: record.kind,
    scopeId: record.scopeId,
    attemptId: record.attemptId,
  });
}

function deriveSlot(expectedIds) {
  const fields = expectedIds.kind === 'shutdown'
    ? [expectedIds.kind, expectedIds.instanceId, expectedIds.requestId]
    : [expectedIds.kind, expectedIds.scopeId, expectedIds.attemptId];
  const tuple = Buffer.from(fields.map((field) => `${Buffer.byteLength(field, 'utf8')}:${field}`).join(''), 'utf8');
  const digest = crypto.createHash('sha256').update(tuple).digest('hex');
  const basename = `${expectedIds.kind}-${digest}.json`;
  return Object.freeze({
    key: basename,
    basename,
  });
}

function createStopEnsureResultStore(options) {
  const capturedOptions = capturePlainData(
    options,
    ['controlDirectory', 'fileSystem'],
    ['controlDirectory'],
    storeOptionsError,
  );
  const controlDirectory = capturedOptions.controlDirectory;
  if (typeof controlDirectory !== 'string' || !path.isAbsolute(controlDirectory) ||
      path.resolve(controlDirectory) !== controlDirectory || controlDirectory.includes('\0')) {
    storeOptionsError();
  }

  const fileSystem = captureFileSystem(capturedOptions.fileSystem);
  const writeLatches = new Map();

  async function directoryAvailable() {
    try {
      const stat = await fileSystem.methods.lstat.call(fileSystem.source, controlDirectory);
      return isDirectoryStat(stat);
    } catch {
      return false;
    }
  }

  async function closeReadHandle(handle, closeMethod) {
    try {
      const result = await closeMethod.call(handle);
      return result === undefined;
    } catch {
      return false;
    }
  }

  async function readResultInternal(expectedIds, slot) {
    let rootAvailable = await directoryAvailable();
    if (!rootAvailable) return makeReadUnknown('directory_unavailable');

    const targetPath = path.join(controlDirectory, slot.basename);
    let targetStat;
    try {
      targetStat = await fileSystem.methods.lstat.call(fileSystem.source, targetPath);
    } catch (error) {
      if (!isEnoent(error)) return makeReadUnknown('record_io_failed');
      rootAvailable = await directoryAvailable();
      return rootAvailable
        ? Object.freeze({ status: 'missing' })
        : makeReadUnknown('directory_unavailable');
    }

    if (!isRegularFileStat(targetStat)) return makeReadUnknown('record_not_regular');

    let handle;
    try {
      handle = await fileSystem.methods.open.call(fileSystem.source, targetPath, 'r');
    } catch (error) {
      if (!isEnoent(error)) return makeReadUnknown('record_io_failed');
      rootAvailable = await directoryAvailable();
      return rootAvailable
        ? Object.freeze({ status: 'missing' })
        : makeReadUnknown('directory_unavailable');
    }

    let closeMethod;
    try {
      closeMethod = handle && handle.close;
    } catch {
      return makeReadUnknown('record_io_failed', true);
    }
    if (typeof closeMethod !== 'function') return makeReadUnknown('record_io_failed', true);

    let statMethod;
    let readMethod;
    try {
      statMethod = handle.stat;
      readMethod = handle.read;
    } catch {
      return makeReadUnknown('record_io_failed', !(await closeReadHandle(handle, closeMethod)));
    }
    if (typeof statMethod !== 'function' || typeof readMethod !== 'function') {
      return makeReadUnknown('record_io_failed', !(await closeReadHandle(handle, closeMethod)));
    }

    let diagnostic = null;
    let record = null;
    try {
      const handleStat = await statMethod.call(handle);
      if (!isRegularFileStat(handleStat)) {
        diagnostic = 'record_not_regular';
      } else if (!Number.isSafeInteger(handleStat.size) || handleStat.size < 0) {
        diagnostic = 'record_io_failed';
      } else if (handleStat.size > MAX_STOP_ENSURE_RECORD_BYTES) {
        diagnostic = 'record_too_large';
      } else {
        const bytes = Buffer.alloc(READ_BUFFER_BYTES);
        let totalBytes = 0;
        while (totalBytes < READ_BUFFER_BYTES) {
          const requested = READ_BUFFER_BYTES - totalBytes;
          const result = await readMethod.call(handle, bytes, totalBytes, requested, totalBytes);
          const bytesRead = result && result.bytesRead;
          if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > requested) {
            diagnostic = 'record_io_failed';
            break;
          }
          if (bytesRead === 0) break;
          totalBytes += bytesRead;
        }

        if (!diagnostic) {
          if (totalBytes > MAX_STOP_ENSURE_RECORD_BYTES) {
            diagnostic = 'record_too_large';
          } else {
            try {
              record = decodeStopEnsureRecord(bytes.subarray(0, totalBytes), expectedIds);
            } catch {
              diagnostic = 'record_invalid';
            }
          }
        }
      }
    } catch {
      diagnostic = 'record_io_failed';
    }

    const closed = await closeReadHandle(handle, closeMethod);
    if (!closed) {
      return makeReadUnknown(diagnostic || 'record_close_unknown', true);
    }
    if (diagnostic) return makeReadUnknown(diagnostic);
    return Object.freeze({ status: 'valid', record });
  }

  async function cleanupOwnedTemp(tempPath) {
    try {
      const result = await fileSystem.methods.unlink.call(fileSystem.source, tempPath);
      return result === undefined ? false : true;
    } catch (error) {
      return !isEnoent(error);
    }
  }

  async function closeWriteHandle(handle, closeMethod) {
    try {
      const result = await closeMethod.call(handle);
      return result === undefined;
    } catch {
      return false;
    }
  }

  async function classifyDirectoryOr(diagnostic) {
    return await directoryAvailable() ? diagnostic : 'directory_unavailable';
  }

  async function writeResultInternal(bytes, slot) {
    if (!await directoryAvailable()) return makeWriteUnknown('directory_unavailable');

    const targetPath = path.join(controlDirectory, slot.basename);
    try {
      const targetStat = await fileSystem.methods.lstat.call(fileSystem.source, targetPath);
      if (targetStat) return makeWriteUnknown('record_exists');
      return makeWriteUnknown('record_io_failed');
    } catch (error) {
      if (!isEnoent(error)) return makeWriteUnknown('record_io_failed');
      if (!await directoryAvailable()) return makeWriteUnknown('directory_unavailable');
    }

    let tempPath;
    try {
      tempPath = path.join(controlDirectory, `.${slot.basename}.${crypto.randomUUID()}.tmp`);
    } catch {
      return makeWriteUnknown('record_io_failed');
    }

    let handle;
    try {
      handle = await fileSystem.methods.open.call(fileSystem.source, tempPath, 'wx', 0o600);
    } catch {
      return makeWriteUnknown(await classifyDirectoryOr('record_open_unknown'));
    }

    let closeMethod;
    try {
      closeMethod = handle && handle.close;
    } catch {
      return makeWriteUnknown('record_open_unknown');
    }
    if (typeof closeMethod !== 'function') return makeWriteUnknown('record_open_unknown');

    let writeMethod;
    try {
      writeMethod = handle.write;
    } catch {
      await closeWriteHandle(handle, closeMethod);
      return makeWriteUnknown('record_open_unknown');
    }
    if (typeof writeMethod !== 'function') {
      await closeWriteHandle(handle, closeMethod);
      return makeWriteUnknown('record_open_unknown');
    }

    let primaryDiagnostic = null;
    let bytesWrittenTotal = 0;
    try {
      while (bytesWrittenTotal < bytes.byteLength) {
        const remaining = bytes.byteLength - bytesWrittenTotal;
        const result = await writeMethod.call(handle, bytes, bytesWrittenTotal, remaining, bytesWrittenTotal);
        const bytesWritten = result && result.bytesWritten;
        if (!Number.isInteger(bytesWritten) || bytesWritten <= 0 || bytesWritten > remaining) {
          primaryDiagnostic = 'record_write_failed';
          break;
        }
        bytesWrittenTotal += bytesWritten;
      }
    } catch {
      primaryDiagnostic = await classifyDirectoryOr('record_write_failed');
    }

    const closed = await closeWriteHandle(handle, closeMethod);
    if (!closed) {
      return makeWriteUnknown(primaryDiagnostic || 'record_close_unknown');
    }

    if (primaryDiagnostic) {
      return makeWriteUnknown(primaryDiagnostic, await cleanupOwnedTemp(tempPath));
    }

    try {
      const result = await fileSystem.methods.rename.call(fileSystem.source, tempPath, targetPath);
      if (result !== undefined) {
        const diagnostic = await classifyDirectoryOr('record_rename_unknown');
        return makeWriteUnknown(diagnostic, await cleanupOwnedTemp(tempPath));
      }
      return Object.freeze({ status: 'written' });
    } catch {
      const diagnostic = await classifyDirectoryOr('record_rename_unknown');
      return makeWriteUnknown(diagnostic, await cleanupOwnedTemp(tempPath));
    }
  }

  function readResult(expectedIds) {
    const normalizedIds = normalizeStopEnsureExpectedIds(expectedIds);
    const slot = deriveSlot(normalizedIds);
    return readResultInternal(normalizedIds, slot).catch(() => makeReadUnknown('record_io_failed'));
  }

  function writeResult(record) {
    const encoded = encodeStopEnsureRecord(record);
    const bytes = Buffer.from(encoded);
    const ids = expectedRecordIds(bytes);
    const slot = deriveSlot(ids);
    const existing = writeLatches.get(slot.key);
    if (existing) {
      if (!existing.bytes.equals(bytes)) resultConflictError();
      return existing.promise;
    }

    let resolveResult;
    const promise = new Promise((resolve) => { resolveResult = resolve; });
    writeLatches.set(slot.key, Object.freeze({ bytes, promise }));
    Promise.resolve()
      .then(() => writeResultInternal(bytes, slot))
      .then(resolveResult, () => resolveResult(makeWriteUnknown('record_io_failed')));
    return promise;
  }

  return Object.freeze({ readResult, writeResult });
}

module.exports = { createStopEnsureResultStore };
