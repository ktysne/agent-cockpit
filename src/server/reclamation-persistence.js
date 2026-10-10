'use strict';

const LIFETIME_CONTROLS = new WeakMap();
function getReclamationPersistenceControl(value) { return LIFETIME_CONTROLS.get(value) || null; }

const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');
const { constants: bufferConstants } = require('node:buffer');
const { types } = require('node:util');

const ANCHOR_BASENAME = 'question-reclamation-anchor.json';
const SLOT_ORDER = Object.freeze(['checkpoint', 'instructions', 'questions']);
const SLOT_NAMES = new Set(SLOT_ORDER);
const OPTION_NAMES = new Set(['anchorPath', 'slotPathsBySlot', 'fileSystem', 'atomicWriteBytes']);
const READ_CHUNK_BYTES = 64 * 1024;
const RENAME_RETRY_DELAYS_MS = Object.freeze([50, 100, 200]);
const OWNED_PATHS = new Map();
const MAX_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_BUFFER_BYTES = bufferConstants.MAX_LENGTH;
const READ_FLAGS = fsSync.constants.O_RDONLY |
  (fsSync.constants.O_NOFOLLOW || 0) |
  (fsSync.constants.O_NONBLOCK || 0);
const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_LENGTH_GETTER = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'length').get;
const TYPED_ARRAY_SET = Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, 'set').value;
const BUFFER_ALLOC_UNSAFE = Buffer.allocUnsafe;
const BUFFER_CONCAT = Buffer.concat;
const BUFFER_COMPARE = Buffer.compare;
const DEFAULT_NATIVE_FILE_SYSTEM = Object.freeze({
  lstat: fs.lstat.bind(fs),
  open: fs.open.bind(fs),
  rename: fs.rename.bind(fs),
  unlink: fs.unlink.bind(fs),
});
const DEFAULT_ATOMIC_FAILURES = new WeakMap();
const SEEN_DEFAULT_ATOMIC_ERRORS = new WeakSet();
const AMBIGUOUS_ATOMIC_ERRORS = new WeakSet();
const BOUNDED_QUESTION_WRITE_FAILURES = new WeakMap();
const SEEN_QUESTION_WRITE_ERRORS = new WeakSet();
const AMBIGUOUS_QUESTION_WRITE_ERRORS = new WeakSet();
const PERSISTENCE_HEALTH = new WeakMap();

function persistenceError(code, Type = TypeError) {
  const error = new Type(code);
  error.code = code;
  return error;
}

function captureRecord(value, allowedNames, requiredNames, code) {
  let prototype;
  let keys;
  try {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw persistenceError(code);
    }
    prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw persistenceError(code);
    keys = Reflect.ownKeys(value);
  } catch {
    throw persistenceError(code);
  }

  const captured = new Map();
  for (const key of keys) {
    if (typeof key !== 'string' || !allowedNames.has(key)) throw persistenceError(code);
    let descriptor;
    try {
      descriptor = Object.getOwnPropertyDescriptor(value, key);
    } catch {
      throw persistenceError(code);
    }
    if (!descriptor || !Object.hasOwn(descriptor, 'value') || !descriptor.enumerable) {
      throw persistenceError(code);
    }
    captured.set(key, descriptor.value);
  }
  for (const name of requiredNames) {
    if (!captured.has(name)) throw persistenceError(code);
  }
  return captured;
}

function canonicalAbsolutePath(value) {
  if (typeof value !== 'string' || value.length === 0 || !path.isAbsolute(value)) {
    throw persistenceError('invalid_reclamation_persistence_path');
  }
  let resolved;
  try {
    resolved = path.resolve(value);
  } catch {
    throw persistenceError('invalid_reclamation_persistence_path');
  }
  if (path.normalize(value) !== value || resolved !== value) {
    throw persistenceError('invalid_reclamation_persistence_path');
  }
  return value;
}

function canonicalPathKey(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function captureSlotPaths(value) {
  const captured = captureRecord(value, SLOT_NAMES, [], 'invalid_reclamation_persistence_slots');
  if (captured.size === 0) throw persistenceError('invalid_reclamation_persistence_slots');

  const pathsBySlot = new Map();
  for (const [slot, pathValue] of captured) {
    pathsBySlot.set(slot, canonicalAbsolutePath(pathValue));
  }

  const configuredSlots = Object.freeze(SLOT_ORDER.filter((slot) => pathsBySlot.has(slot)));
  return { pathsBySlot, configuredSlots };
}

function captureOptions(value) {
  const captured = captureRecord(value, OPTION_NAMES,
    ['anchorPath', 'slotPathsBySlot'], 'invalid_reclamation_persistence_options');
  const anchorPath = canonicalAbsolutePath(captured.get('anchorPath'));
  if (path.basename(anchorPath) !== ANCHOR_BASENAME) {
    throw persistenceError('invalid_reclamation_anchor_path');
  }
  const { pathsBySlot, configuredSlots } = captureSlotPaths(captured.get('slotPathsBySlot'));
  const fileSystemWasSpecified = captured.has('fileSystem');
  const atomicWriterWasSpecified = captured.has('atomicWriteBytes');
  const fileSystem = fileSystemWasSpecified && captured.get('fileSystem') !== undefined
    ? captured.get('fileSystem')
    : DEFAULT_NATIVE_FILE_SYSTEM;
  const atomicWriteBytes = atomicWriterWasSpecified && captured.get('atomicWriteBytes') !== undefined
    ? captured.get('atomicWriteBytes')
    : defaultAtomicWriteBytes;
  if (fileSystem === null || typeof fileSystem !== 'object' ||
      ['lstat', 'open', 'rename', 'unlink'].some((name) => typeof fileSystem[name] !== 'function')) {
    throw persistenceError('invalid_reclamation_persistence_filesystem');
  }
  if (typeof atomicWriteBytes !== 'function') {
    throw persistenceError('invalid_reclamation_atomic_writer');
  }
  const atomicWriterFileSystem = fileSystemWasSpecified && captured.get('fileSystem') !== undefined
    ? fileSystem
    : (atomicWriteBytes === defaultAtomicWriteBytes ? fileSystem : fs);

  const allPaths = new Map([[canonicalPathKey(anchorPath), 'anchor']]);
  for (const slot of configuredSlots) {
    const slotPath = pathsBySlot.get(slot);
    const key = canonicalPathKey(slotPath);
    if (allPaths.has(key)) throw persistenceError('reclamation_persistence_path_alias');
    allPaths.set(key, slot);
  }
  return {
    anchorPath,
    pathsBySlot,
    configuredSlots,
    fileSystem,
    atomicWriteBytes,
    atomicWriterFileSystem,
    allPaths,
    canCertifyQuestionRenameFailure: !fileSystemWasSpecified && !atomicWriterWasSpecified,
  };
}

function captureMaximumBytes(value) {
  if (!Number.isSafeInteger(value) || value < 0 || value >= MAX_SAFE_INTEGER || value > MAX_BUFFER_BYTES) {
    throw persistenceError('invalid_reclamation_persistence_limit');
  }
  return value;
}

function cloneBytes(value, maximumBytes) {
  if (!types.isUint8Array(value)) throw persistenceError('invalid_reclamation_persistence_bytes');
  let byteLength;
  try {
    byteLength = TYPED_ARRAY_LENGTH_GETTER.call(value);
  } catch {
    throw persistenceError('invalid_reclamation_persistence_bytes');
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 0 || byteLength > maximumBytes ||
      byteLength > MAX_BUFFER_BYTES) {
    throw persistenceError('reclamation_persistence_size_limit', RangeError);
  }
  let copy;
  try {
    copy = BUFFER_ALLOC_UNSAFE.call(Buffer, byteLength);
    TYPED_ARRAY_SET.call(copy, value);
  } catch {
    throw persistenceError('invalid_reclamation_persistence_bytes');
  }
  return copy;
}

async function inspectRegularFilePath(filePath, fileSystem) {
  const root = path.parse(filePath).root;
  const components = filePath.slice(root.length).split(path.sep).filter(Boolean);
  let current = root;
  let finalStat = null;

  for (let index = 0; index < components.length; index += 1) {
    current = path.join(current, components[index]);
    let stat;
    try {
      stat = await fileSystem.lstat(current);
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
    if (stat.isSymbolicLink()) throw persistenceError('reclamation_persistence_symlink');
    const isFinal = index === components.length - 1;
    if (isFinal ? !stat.isFile() : !stat.isDirectory()) {
      throw persistenceError('reclamation_persistence_not_regular_file');
    }
    if (isFinal) finalStat = stat;
  }
  return finalStat;
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readBoundedFile(filePath, maximumBytes, fileSystem) {
  const expectedStat = await inspectRegularFilePath(filePath, fileSystem);
  if (expectedStat === null) return null;

  const handle = await fileSystem.open(filePath, READ_FLAGS);
  let primaryError = null;
  try {
    const openedStat = await handle.stat();
    if (!openedStat.isFile() || !sameFileIdentity(expectedStat, openedStat)) {
      throw persistenceError('reclamation_persistence_path_changed');
    }

    const chunks = [];
    const readLimit = maximumBytes + 1;
    let totalBytes = 0;
    while (totalBytes < readLimit) {
      const requestBytes = Math.min(READ_CHUNK_BYTES, readLimit - totalBytes);
      const chunk = BUFFER_ALLOC_UNSAFE.call(Buffer, requestBytes);
      const result = await handle.read(chunk, 0, requestBytes, totalBytes);
      if (!result || !Number.isSafeInteger(result.bytesRead) || result.bytesRead < 0 ||
          result.bytesRead > requestBytes) {
        throw persistenceError('reclamation_persistence_read_failed');
      }
      if (result.bytesRead === 0) break;
      totalBytes += result.bytesRead;
      if (totalBytes > maximumBytes) {
        throw persistenceError('reclamation_persistence_size_limit', RangeError);
      }
      chunks.push(chunk.subarray(0, result.bytesRead));
    }
    return BUFFER_CONCAT.call(Buffer, chunks, totalBytes);
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    try {
      await handle.close();
    } catch (error) {
      if (primaryError === null) throw error;
    }
  }
}

async function defaultAtomicWriteBytes(targetPath, bytes, fileSystem) {
  const temporaryPath = path.join(path.dirname(targetPath),
    `.${path.basename(targetPath)}.${process.pid}.${crypto.randomUUID()}.tmp`);
  let handle = null;
  let temporaryFileClosed = false;
  let renameRetryExhausted = false;
  try {
    handle = await fileSystem.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.close();
    handle = null;
    temporaryFileClosed = true;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fileSystem.rename(temporaryPath, targetPath);
        return;
      } catch (error) {
        const retryable = Boolean(error && ['EPERM', 'EBUSY'].includes(error.code));
        if (!retryable || attempt >= RENAME_RETRY_DELAYS_MS.length) {
          renameRetryExhausted = retryable && attempt >= RENAME_RETRY_DELAYS_MS.length;
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
      }
    }
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => {});
    let cleanupConfirmed = false;
    try {
      await fileSystem.unlink(temporaryPath);
      cleanupConfirmed = true;
    } catch (cleanupError) {
      cleanupConfirmed = cleanupError?.code === 'ENOENT';
    }
    if (fileSystem === DEFAULT_NATIVE_FILE_SYSTEM && temporaryFileClosed && renameRetryExhausted &&
        cleanupConfirmed) {
      rememberDefaultAtomicFailure(error, targetPath, bytes);
    }
    throw error;
  }
}

function isWeakKey(value) {
  return value !== null && (typeof value === 'object' || typeof value === 'function');
}

function rememberDefaultAtomicFailure(error, targetPath, bytes) {
  if (!isWeakKey(error) || AMBIGUOUS_ATOMIC_ERRORS.has(error)) return;
  if (SEEN_DEFAULT_ATOMIC_ERRORS.has(error)) {
    DEFAULT_ATOMIC_FAILURES.delete(error);
    AMBIGUOUS_ATOMIC_ERRORS.add(error);
    if (BOUNDED_QUESTION_WRITE_FAILURES.has(error)) {
      BOUNDED_QUESTION_WRITE_FAILURES.delete(error);
      AMBIGUOUS_QUESTION_WRITE_ERRORS.add(error);
    }
    return;
  }
  SEEN_DEFAULT_ATOMIC_ERRORS.add(error);
  let capturedBytes;
  try { capturedBytes = cloneBytes(bytes, MAX_BUFFER_BYTES); } catch { return; }
  DEFAULT_ATOMIC_FAILURES.set(error, { targetPath, bytes: capturedBytes });
}

function takeDefaultAtomicFailure(error) {
  if (!isWeakKey(error) || AMBIGUOUS_ATOMIC_ERRORS.has(error)) return null;
  const failure = DEFAULT_ATOMIC_FAILURES.get(error) || null;
  DEFAULT_ATOMIC_FAILURES.delete(error);
  return failure;
}

function sameBytes(left, right) {
  return left.length === right.length && BUFFER_COMPARE.call(Buffer, left, right) === 0;
}

function consumeBoundedQuestionWriteFailure(persistence, error, attemptedBytes) {
  if (!isWeakKey(persistence) || !isWeakKey(error)) return false;
  const health = PERSISTENCE_HEALTH.get(persistence);
  const failure = BOUNDED_QUESTION_WRITE_FAILURES.get(error);
  if (!health || health.closed || !health.questionWriteBlocked || !failure ||
      AMBIGUOUS_ATOMIC_ERRORS.has(error) || AMBIGUOUS_QUESTION_WRITE_ERRORS.has(error) ||
      failure.persistence !== persistence || failure.slot !== 'questions') return false;
  let bytes;
  try { bytes = cloneBytes(attemptedBytes, MAX_BUFFER_BYTES); } catch { return false; }
  if (!sameBytes(failure.bytes, bytes)) return false;
  BOUNDED_QUESTION_WRITE_FAILURES.delete(error);
  health.pendingQuestionFailure = false;
  health.pendingQuestionError = null;
  return true;
}

function createReclamationPersistence(options) {
  const captured = captureOptions(options);
  const {
    anchorPath,
    pathsBySlot,
    configuredSlots,
    fileSystem,
    atomicWriteBytes,
    atomicWriterFileSystem,
    allPaths,
  } = captured;
  for (const key of allPaths.keys()) {
    if (OWNED_PATHS.has(key)) throw persistenceError('reclamation_persistence_path_owned');
  }

  const owner = Object.freeze({});
  for (const key of allPaths.keys()) OWNED_PATHS.set(key, owner);

  let closed = false;
  let writeBlocked = false;
  const health = {
    closed: false,
    questionWriteBlocked: false,
    pendingQuestionFailure: false,
    pendingQuestionError: null,
  };
  let pending = Promise.resolve();
  let closePromise = null;
  let persistenceAdapter = null;
  let everEnqueued = false;
  let managed = false;
  let drained = false;
  let finalPromise = null;
  let transferred = false;
  let ownerControl = null;
  let delegatedControl = null;
  let publicClosePromise = null;

  function enqueue(operation) {
    if (closed) return Promise.reject(persistenceError('reclamation_persistence_closed'));
    everEnqueued = true;
    const run = pending.then(operation);
    pending = run.then(() => undefined, () => undefined);
    return run;
  }

  function releaseOwnership() {
    for (const key of allPaths.keys()) {
      if (OWNED_PATHS.get(key) === owner) OWNED_PATHS.delete(key);
    }
  }

  function readBytes(filePath, maximumBytes) {
    let capturedLimit;
    try {
      capturedLimit = captureMaximumBytes(maximumBytes);
    } catch (error) {
      return Promise.reject(error);
    }
    return enqueue(() => readBoundedFile(filePath, capturedLimit, fileSystem));
  }

  function writeBytes(filePath, bytes, maximumBytes, slot) {
    let capturedBytes;
    try {
      capturedBytes = cloneBytes(bytes, captureMaximumBytes(maximumBytes));
    } catch (error) {
      return Promise.reject(error);
    }
    return enqueue(async () => {
      if (writeBlocked) throw persistenceError('reclamation_persistence_write_blocked');
      if (health.pendingQuestionFailure) {
        throw persistenceError('reclamation_persistence_question_failure_pending');
      }
      if (slot === 'questions' && health.questionWriteBlocked) {
        throw persistenceError('reclamation_persistence_question_write_blocked');
      }
      try {
        await inspectRegularFilePath(filePath, fileSystem);
        await atomicWriteBytes(filePath, capturedBytes, atomicWriterFileSystem);
      } catch (error) {
        const atomicFailure = takeDefaultAtomicFailure(error);
        let localQuestionFailure = false;
        if (!health.closed && captured.canCertifyQuestionRenameFailure && slot === 'questions' &&
            fileSystem === DEFAULT_NATIVE_FILE_SYSTEM && atomicWriteBytes === defaultAtomicWriteBytes &&
            atomicFailure && atomicFailure.targetPath === filePath &&
            sameBytes(atomicFailure.bytes, capturedBytes) && persistenceAdapter !== null &&
            !AMBIGUOUS_QUESTION_WRITE_ERRORS.has(error)) {
          if (SEEN_QUESTION_WRITE_ERRORS.has(error)) {
            BOUNDED_QUESTION_WRITE_FAILURES.delete(error);
            AMBIGUOUS_QUESTION_WRITE_ERRORS.add(error);
          } else {
            SEEN_QUESTION_WRITE_ERRORS.add(error);
            BOUNDED_QUESTION_WRITE_FAILURES.set(error, {
              persistence: persistenceAdapter,
              slot,
              bytes: cloneBytes(capturedBytes, MAX_BUFFER_BYTES),
            });
            health.questionWriteBlocked = true;
            health.pendingQuestionFailure = true;
            health.pendingQuestionError = error;
            localQuestionFailure = true;
          }
        }
        if (!localQuestionFailure) writeBlocked = true;
        throw error;
      }
    });
  }

  function readSlotBytes(slot, maximumBytes) {
    if (typeof slot !== 'string' || !pathsBySlot.has(slot)) {
      return Promise.reject(persistenceError('reclamation_persistence_slot_not_configured'));
    }
    return readBytes(pathsBySlot.get(slot), maximumBytes);
  }

  function writeSlotBytes(slot, bytes, maximumBytes) {
    if (typeof slot !== 'string' || !pathsBySlot.has(slot)) {
      return Promise.reject(persistenceError('reclamation_persistence_slot_not_configured'));
    }
    return writeBytes(pathsBySlot.get(slot), bytes, maximumBytes, slot);
  }

  function stopAndDrain() {
    if (closePromise !== null) return closePromise;
    let resolveClose;
    let rejectClose;
    closePromise = new Promise((resolve, reject) => { resolveClose = resolve; rejectClose = reject; });
    closePromise.catch(() => {});
    closed = true;
    health.closed = true;
    if (health.pendingQuestionError !== null) {
      BOUNDED_QUESTION_WRITE_FAILURES.delete(health.pendingQuestionError);
      health.pendingQuestionError = null;
    }
    health.pendingQuestionFailure = false;
    pending.then(() => { drained = true; resolveClose(); }, rejectClose);
    return closePromise;
  }

  function finalize() {
    if (finalPromise !== null) return finalPromise;
    let resolveFinal;
    let rejectFinal;
    finalPromise = new Promise((resolve, reject) => { resolveFinal = resolve; rejectFinal = reject; });
    finalPromise.catch(() => {});
    try {
      if (!drained) throw persistenceError('reclamation_persistence_drain_unconfirmed');
      releaseOwnership();
      resolveFinal();
    } catch (error) { rejectFinal(error); }
    return finalPromise;
  }

  function close() {
    if (managed) return stopAndDrain();
    if (publicClosePromise !== null) return publicClosePromise;
    publicClosePromise = stopAndDrain().then(finalize);
    publicClosePromise.catch(() => {});
    return publicClosePromise;
  }

  persistenceAdapter = Object.freeze({
    configuredSlots,
    readAnchorBytes: (maximumBytes) => readBytes(anchorPath, maximumBytes),
    readSlotBytes,
    writeAnchorBytes: (bytes, maximumBytes) => writeBytes(anchorPath, bytes, maximumBytes, 'anchor'),
    writeSlotBytes,
    close,
    status: () => ({ closed, writeBlocked }),
  });
  PERSISTENCE_HEALTH.set(persistenceAdapter, health);
  LIFETIME_CONTROLS.set(persistenceAdapter, Object.freeze({
    bindOwner() {
      if (managed || everEnqueued || closePromise !== null) return false;
      managed = true;
      delegatedControl = Object.freeze({ stopAndDrain, finalize });
      ownerControl = Object.freeze({
        stopAndDrain,
        finalize() {
          if (transferred) return Promise.reject(persistenceError('reclamation_persistence_authority_transferred'));
          return finalize();
        },
      });
      return ownerControl;
    },
    transferOwner(value) {
      if (!managed || value !== ownerControl || transferred || closePromise !== null || everEnqueued) return false;
      transferred = true;
      return delegatedControl;
    },
  }));
  return persistenceAdapter;
}

module.exports = { consumeBoundedQuestionWriteFailure, createReclamationPersistence, getReclamationPersistenceControl };
