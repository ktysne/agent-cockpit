'use strict';

const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { atomicWriteJson } = require('./json-storage');
const { DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS } = require('./common-question-service');

const SETTINGS_FILE = 'common-question-settings.json';
const DISABLED_SETTINGS = Object.freeze({
  enabled: false,
  minimumWaitMs: DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS,
});

function settingsError(code) {
  const error = new Error('common question settings operation rejected');
  error.code = code;
  return error;
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function exactRecord(value, required, optional = [], code = 'invalid_settings') {
  if (!isPlainRecord(value)) throw settingsError(code);
  let keys;
  try { keys = Reflect.ownKeys(value); } catch { throw settingsError(code); }
  const fields = [...required, ...optional];
  if (keys.length < required.length || keys.length > fields.length ||
      keys.some((key) => typeof key !== 'string' || !fields.includes(key)) ||
      required.some((field) => !keys.includes(field))) throw settingsError(code);
  const result = {};
  for (const field of keys) {
    let descriptor;
    try { descriptor = Object.getOwnPropertyDescriptor(value, field); } catch { throw settingsError(code); }
    if (!descriptor || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) throw settingsError(code);
    result[field] = descriptor.value;
  }
  return result;
}

function parseSettings(bytes) {
  const source = bytes.toString('utf8');
  if (!Buffer.from(source, 'utf8').equals(bytes)) throw settingsError('invalid_settings_json');

  let document;
  try { document = JSON.parse(source); } catch { throw settingsError('invalid_settings_json'); }
  const root = exactRecord(document, ['schemaVersion', 'autoApply'], [], 'invalid_settings_schema');
  if (root.schemaVersion !== 1) throw settingsError('unsupported_settings_schema');
  const autoApply = exactRecord(root.autoApply, ['enabled'], ['minimumWaitMs'], 'invalid_settings_schema');
  const minimumWaitMs = Object.hasOwn(autoApply, 'minimumWaitMs')
    ? autoApply.minimumWaitMs : DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS;
  if (typeof autoApply.enabled !== 'boolean' || !Number.isSafeInteger(minimumWaitMs) ||
      minimumWaitMs < DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS) throw settingsError('invalid_settings_value');
  return Object.freeze({ enabled: autoApply.enabled, minimumWaitMs });
}

function normalizeUpdate(input) {
  const update = exactRecord(input, ['expectedRevision', 'enabled'], ['minimumWaitMs'], 'invalid_settings_update');
  const minimumWaitMs = Object.hasOwn(update, 'minimumWaitMs')
    ? update.minimumWaitMs : DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS;
  if (typeof update.expectedRevision !== 'string' || update.expectedRevision.length === 0 ||
      update.expectedRevision.length > 128 ||
      typeof update.enabled !== 'boolean' || !Number.isSafeInteger(minimumWaitMs) ||
      minimumWaitMs < DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS) throw settingsError('invalid_settings_update');
  return Object.freeze({
    expectedRevision: update.expectedRevision,
    enabled: update.enabled,
    minimumWaitMs,
  });
}

function serializeSettings(settings) {
  return `${JSON.stringify({
    schemaVersion: 1,
    autoApply: {
      enabled: settings.enabled,
      ...(settings.minimumWaitMs === DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS
        ? {} : { minimumWaitMs: settings.minimumWaitMs }),
    },
  }, null, 2)}\n`;
}

async function readSettingsBytes(filePath, fileSystem) {
  let stat;
  try { stat = await fileSystem.lstat(filePath); } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
  let isFile;
  let isSymbolicLink;
  try {
    isFile = stat.isFile();
    isSymbolicLink = stat.isSymbolicLink();
  } catch { throw settingsError('invalid_settings_file'); }
  if (!isFile || isSymbolicLink) throw settingsError('invalid_settings_file');

  try {
    const bytes = await fileSystem.readFile(filePath);
    if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) throw settingsError('invalid_settings_file');
    return Buffer.from(bytes);
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

async function createCommonQuestionSettings(input) {
  const options = exactRecord(input, ['dataDirectory'], ['fileSystem'], 'invalid_settings_options');
  if (typeof options.dataDirectory !== 'string' || options.dataDirectory.length === 0 ||
      options.dataDirectory !== options.dataDirectory.trim() || !path.isAbsolute(options.dataDirectory)) {
    throw settingsError('invalid_settings_options');
  }
  const fileSystem = Object.hasOwn(options, 'fileSystem') ? options.fileSystem : fs;
  try {
    if (!fileSystem || ['lstat', 'readFile', 'writeFile', 'rename', 'rm']
      .some((method) => typeof fileSystem[method] !== 'function')) throw new Error();
  } catch { throw settingsError('settings_filesystem_unavailable'); }

  const filePath = path.join(options.dataDirectory, SETTINGS_FILE);
  let status = 'unavailable';
  let reason = 'settings_read_failed';
  const revisionEpoch = crypto.randomUUID();
  let revisionCounter = 0;
  let revision = `${revisionEpoch}:0`;
  let snapshot = DISABLED_SETTINGS;
  let lastKnownBytes = null;
  const subscribers = new Set();
  let updateTail = Promise.resolve();

  try {
    const bytes = await readSettingsBytes(filePath, fileSystem);
    if (bytes === null) {
      status = 'missing';
      reason = null;
    } else {
      snapshot = parseSettings(bytes);
      lastKnownBytes = bytes;
      status = 'ready';
      reason = null;
    }
  } catch (error) {
    if (error.code === 'invalid_settings_file') {
      status = 'invalid';
      reason = 'invalid_settings_file';
    } else if (error.code === 'invalid_settings_json' || error.code === 'invalid_settings_schema' ||
        error.code === 'unsupported_settings_schema' || error.code === 'invalid_settings_value') {
      status = 'invalid';
      reason = error.code;
    }
  }

  function getAutoApplySettings() {
    return Object.freeze({ enabled: status === 'ready' && snapshot.enabled, minimumWaitMs: snapshot.minimumWaitMs });
  }

  function getStatus() {
    return Object.freeze({ status, revision, reason });
  }

  function eventSnapshot() {
    return Object.freeze({ autoApply: getAutoApplySettings(), status: getStatus() });
  }

  function notifySubscribers() {
    const event = eventSnapshot();
    for (const listener of [...subscribers]) {
      try { Promise.resolve(listener(event)).catch(() => {}); } catch {}
    }
  }

  function setUnsafeStatus(nextStatus, nextReason) {
    if (status === nextStatus && reason === nextReason) return;
    status = nextStatus;
    reason = nextReason;
    notifySubscribers();
  }

  async function updateNow(update) {
    if (status !== 'ready' && status !== 'missing') {
      throw settingsError(status === 'changed' ? 'settings_changed' : 'settings_not_writable');
    }
    if (update.expectedRevision !== revision) throw settingsError('stale_settings_revision');
    if (revisionCounter === Number.MAX_SAFE_INTEGER) throw settingsError('settings_revision_exhausted');

    let currentBytes;
    try { currentBytes = await readSettingsBytes(filePath, fileSystem); } catch (error) {
      if (error.code === 'invalid_settings_file') {
        setUnsafeStatus('changed', 'external_settings_change');
        throw settingsError('settings_changed');
      }
      setUnsafeStatus('unavailable', 'settings_read_failed');
      throw settingsError('settings_unavailable');
    }
    if ((currentBytes === null) !== (lastKnownBytes === null) ||
        (currentBytes !== null && !currentBytes.equals(lastKnownBytes))) {
      setUnsafeStatus('changed', 'external_settings_change');
      throw settingsError('settings_changed');
    }
    if (status === 'ready' && snapshot.enabled === update.enabled &&
        snapshot.minimumWaitMs === update.minimumWaitMs) return eventSnapshot();

    const next = Object.freeze({ enabled: update.enabled, minimumWaitMs: update.minimumWaitMs });
    const document = {
      schemaVersion: 1,
      autoApply: {
        enabled: next.enabled,
        ...(next.minimumWaitMs === DEFAULT_AUTO_APPLY_MINIMUM_WAIT_MS
          ? {} : { minimumWaitMs: next.minimumWaitMs }),
      },
    };
    try { await atomicWriteJson(options.dataDirectory, SETTINGS_FILE, document, fileSystem); }
    catch {
      try {
        const currentBytesAfterFailure = await readSettingsBytes(filePath, fileSystem);
        if ((currentBytesAfterFailure === null) !== (lastKnownBytes === null) ||
            (currentBytesAfterFailure !== null && !currentBytesAfterFailure.equals(lastKnownBytes))) {
          setUnsafeStatus('changed', 'external_settings_change');
        }
      } catch (error) {
        setUnsafeStatus(error.code === 'invalid_settings_file' ? 'changed' : 'unavailable',
          error.code === 'invalid_settings_file' ? 'external_settings_change' : 'settings_read_failed');
      }
      throw settingsError('settings_write_failed');
    }

    snapshot = next;
    lastKnownBytes = Buffer.from(serializeSettings(next), 'utf8');
    status = 'ready';
    reason = null;
    revisionCounter += 1;
    revision = `${revisionEpoch}:${revisionCounter}`;
    notifySubscribers();
    return eventSnapshot();
  }

  function updateSettings(inputValue) {
    let update;
    try { update = normalizeUpdate(inputValue); } catch (error) { return Promise.reject(error); }
    const result = updateTail.then(() => updateNow(update));
    updateTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw settingsError('invalid_settings_subscriber');
    subscribers.add(listener);
    let subscribed = true;
    return () => {
      if (!subscribed) return;
      subscribed = false;
      subscribers.delete(listener);
    };
  }

  return Object.freeze({ getAutoApplySettings, getStatus, updateSettings, subscribe });
}

module.exports = { createCommonQuestionSettings };
