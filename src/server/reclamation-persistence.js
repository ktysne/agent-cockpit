'use strict';

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
  const fileSystem = captured.has('fileSystem') && captured.get('fileSystem') !== undefined
    ? captured.get('fileSystem')
    : fs;
  const atomicWriteBytes = captured.has('atomicWriteBytes') && captured.get('atomicWriteBytes') !== undefined
    ? captured.get('atomicWriteBytes')
    : defaultAtomicWriteBytes;
  if (fileSystem === null || typeof fileSystem !== 'object' ||
      ['lstat', 'open', 'rename', 'unlink'].some((name) => typeof fileSystem[name] !== 'function')) {
    throw persistenceError('invalid_reclamation_persistence_filesystem');
  }
  if (typeof atomicWriteBytes !== 'function') {
    throw persistenceError('invalid_reclamation_atomic_writer');
  }

  const allPaths = new Map([[canonicalPathKey(anchorPath), 'anchor']]);
  for (const slot of configuredSlots) {
    const slotPath = pathsBySlot.get(slot);
    const key = canonicalPathKey(slotPath);
    if (allPaths.has(key)) throw persistenceError('reclamation_persistence_path_alias');
    allPaths.set(key, slot);
  }
  return { anchorPath, pathsBySlot, configuredSlots, fileSystem, atomicWriteBytes, allPaths };
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
  try {
    handle = await fileSystem.open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(bytes);
    await handle.close();
    handle = null;
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fileSystem.rename(temporaryPath, targetPath);
        return;
      } catch (error) {
        if (!error || !['EPERM', 'EBUSY'].includes(error.code) ||
            attempt >= RENAME_RETRY_DELAYS_MS.length) {
          throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, RENAME_RETRY_DELAYS_MS[attempt]));
      }
    }
  } catch (error) {
    if (handle !== null) await handle.close().catch(() => {});
    await fileSystem.unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

function createReclamationPersistence(options) {
  const captured = captureOptions(options);
  const { anchorPath, pathsBySlot, configuredSlots, fileSystem, atomicWriteBytes, allPaths } = captured;
  for (const key of allPaths.keys()) {
    if (OWNED_PATHS.has(key)) throw persistenceError('reclamation_persistence_path_owned');
  }

  const owner = Object.freeze({});
  for (const key of allPaths.keys()) OWNED_PATHS.set(key, owner);

  let closed = false;
  let writeBlocked = false;
  let pending = Promise.resolve();
  let closePromise = null;

  function enqueue(operation) {
    if (closed) return Promise.reject(persistenceError('reclamation_persistence_closed'));
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

  function writeBytes(filePath, bytes, maximumBytes) {
    let capturedBytes;
    try {
      capturedBytes = cloneBytes(bytes, captureMaximumBytes(maximumBytes));
    } catch (error) {
      return Promise.reject(error);
    }
    return enqueue(async () => {
      if (writeBlocked) throw persistenceError('reclamation_persistence_write_blocked');
      try {
        await inspectRegularFilePath(filePath, fileSystem);
        await atomicWriteBytes(filePath, capturedBytes, fileSystem);
      } catch (error) {
        writeBlocked = true;
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
    return writeBytes(pathsBySlot.get(slot), bytes, maximumBytes);
  }

  function close() {
    if (closePromise !== null) return closePromise;
    closed = true;
    closePromise = pending.then(() => {
      releaseOwnership();
    });
    return closePromise;
  }

  return Object.freeze({
    configuredSlots,
    readAnchorBytes: (maximumBytes) => readBytes(anchorPath, maximumBytes),
    readSlotBytes,
    writeAnchorBytes: (bytes, maximumBytes) => writeBytes(anchorPath, bytes, maximumBytes),
    writeSlotBytes,
    close,
    status: () => ({ closed, writeBlocked }),
  });
}

module.exports = { createReclamationPersistence };
