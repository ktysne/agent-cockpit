'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { TextDecoder } = require('node:util');
const {
  OUTPUT_BASE,
  REPOSITORY_ROOT,
  assertNoSymlinkComponents,
} = require('../codex-hooks-identity/setup');

const MAX_CHECKPOINT_BYTES = 128 * 1024;
const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function requireValidator(options) {
  if (!options || typeof options !== 'object' || typeof options.validate !== 'function') {
    throw new TypeError('checkpoint_validator_required');
  }
  return options.validate;
}

function resolveCheckpointPath(filePath, requireTarget) {
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new TypeError('checkpoint_path_must_be_absolute');
  }
  const resolved = path.resolve(filePath);
  if (resolved !== filePath) throw new Error('checkpoint_path_must_be_canonical');

  const relativeToOutput = path.relative(OUTPUT_BASE, resolved);
  if (!relativeToOutput || relativeToOutput === '..' || relativeToOutput.startsWith(`..${path.sep}`)
    || path.isAbsolute(relativeToOutput)) {
    throw new Error('checkpoint_path_outside_poc162_output');
  }
  const outputSegments = relativeToOutput.split(path.sep);
  if (outputSegments.length < 2 || !/^poc162-[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(outputSegments[0])
    || outputSegments.some((segment) => !SAFE_PATH_SEGMENT.test(segment))) {
    throw new Error('checkpoint_path_outside_poc162_output');
  }

  assertNoSymlinkComponents(REPOSITORY_ROOT, resolved);
  const relativeToRepository = path.relative(REPOSITORY_ROOT, resolved);
  const repositorySegments = relativeToRepository.split(path.sep);
  let current = REPOSITORY_ROOT;
  for (let index = 0; index < repositorySegments.length; index += 1) {
    current = path.join(current, repositorySegments[index]);
    const isTarget = index === repositorySegments.length - 1;
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT' && isTarget && !requireTarget) continue;
      if (error.code === 'ENOENT') throw new Error('checkpoint_path_component_missing');
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('checkpoint_path_contains_symlink');
    if (isTarget ? !stat.isFile() : !stat.isDirectory()) {
      throw new Error(isTarget ? 'checkpoint_target_not_regular_file' : 'checkpoint_parent_not_directory');
    }
  }
  return resolved;
}

function validateValue(value, validate) {
  let serialized;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new TypeError('checkpoint_serialization_failed');
  }
  if (typeof serialized !== 'string') throw new TypeError('checkpoint_serialization_failed');
  const bytes = Buffer.from(serialized, 'utf8');
  if (bytes.length > MAX_CHECKPOINT_BYTES) throw new RangeError('checkpoint_too_large');

  let snapshot;
  try {
    snapshot = JSON.parse(serialized);
  } catch {
    throw new TypeError('checkpoint_serialization_failed');
  }
  let accepted;
  try {
    accepted = validate(snapshot);
  } catch {
    throw new Error('checkpoint_validation_failed');
  }
  if (accepted !== true) throw new Error('checkpoint_validation_failed');
  return { serialized, bytes };
}

function validateLoaded(value, validate) {
  let accepted;
  try {
    accepted = validate(value);
  } catch {
    throw new Error('checkpoint_validation_failed');
  }
  if (accepted !== true) throw new Error('checkpoint_validation_failed');
  return value;
}

function removeOwnedTemporaryFile(tempPath, identity) {
  if (!identity) return;
  try {
    const stat = fs.lstatSync(tempPath);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.dev === identity.dev && stat.ino === identity.ino) {
      fs.unlinkSync(tempPath);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function writeCheckpoint(filePath, value, options) {
  const validate = requireValidator(options);
  const target = resolveCheckpointPath(filePath, false);
  const { serialized, bytes } = validateValue(value, validate);
  resolveCheckpointPath(target, false);

  const tempPath = path.join(path.dirname(target), `.${path.basename(target)}.${randomUUID()}.tmp`);
  let fileDescriptor = null;
  let tempIdentity = null;
  try {
    fileDescriptor = fs.openSync(tempPath, 'wx', 0o600);
    tempIdentity = fs.fstatSync(fileDescriptor);
    fs.writeFileSync(fileDescriptor, bytes);
    fs.fsyncSync(fileDescriptor);
    fs.closeSync(fileDescriptor);
    fileDescriptor = null;

    resolveCheckpointPath(target, false);
    fs.renameSync(tempPath, target);
    return { bytes: bytes.length };
  } finally {
    if (fileDescriptor !== null) fs.closeSync(fileDescriptor);
    removeOwnedTemporaryFile(tempPath, tempIdentity);
  }
}

function readCheckpoint(filePath, options) {
  const validate = requireValidator(options);
  const target = resolveCheckpointPath(filePath, true);
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const fileDescriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(fileDescriptor);
    if (!stat.isFile()) throw new Error('checkpoint_target_not_regular_file');
    if (stat.size > MAX_CHECKPOINT_BYTES) throw new RangeError('checkpoint_too_large');

    const chunks = [];
    let totalBytes = 0;
    while (totalBytes <= MAX_CHECKPOINT_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(8192, MAX_CHECKPOINT_BYTES + 1 - totalBytes));
      const bytesRead = fs.readSync(fileDescriptor, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      totalBytes += bytesRead;
      if (totalBytes > MAX_CHECKPOINT_BYTES) throw new RangeError('checkpoint_too_large');
      chunks.push(chunk.subarray(0, bytesRead));
    }

    let value;
    try {
      const contents = Buffer.concat(chunks, totalBytes);
      value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents));
    } catch {
      throw new TypeError('checkpoint_json_invalid');
    }
    return validateLoaded(value, validate);
  } finally {
    fs.closeSync(fileDescriptor);
  }
}

module.exports = {
  MAX_CHECKPOINT_BYTES,
  readCheckpoint,
  writeCheckpoint,
};
