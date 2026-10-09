'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const {
  createNativeInstructionBodyReclamationHarness,
  PROVIDERS,
} = require('./native-instruction-body-reclamation-harness');

const TERMINAL_DELIVERY_KINDS = Object.freeze(['result', 'pr-notification']);
const TERMINAL_DELIVERY_STATES = Object.freeze([
  'applied', 'cancelled_before_send', 'superseded_before_send',
]);
const TERMINAL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

function otherProvider(provider) {
  return provider === 'claude' ? 'codex' : 'claude';
}

function correlationFor(delivery, nativeTurnId, nativeItemId) {
  return {
    deliveryAttemptId: delivery.deliveryAttemptId,
    revision: delivery.revision,
    payloadDigest: delivery.payloadDigest,
    targetPeriodId: delivery.target.periodId,
    nativeTurnId,
    nativeItemId,
    clientRequestId: delivery.deliveryAttemptId,
  };
}

async function createNativeTerminalDeliveryBodyReclamationHarness(options = {}) {
  let directory = options.directory;
  let ownsDirectory = false;
  if (directory === undefined) {
    const tempRoot = await fs.realpath(os.tmpdir());
    directory = await fs.mkdtemp(path.join(tempRoot, 'native-terminal-body-reclamation-'));
    ownsDirectory = true;
  }
  if (typeof directory !== 'string' || !path.isAbsolute(directory)) {
    throw new TypeError('an absolute data directory is required');
  }

  let now = options.initialNow ?? 1_800_000_000_000;
  assert.ok(Number.isSafeInteger(now) && now >= 0);
  const base = createNativeInstructionBodyReclamationHarness({
    directory,
    now: () => now,
    ...(options.reclamation !== undefined ? { reclamation: options.reclamation } : {}),
    ...(options.instructionEvidence !== undefined ? { instructionEvidence: options.instructionEvidence } : {}),
  });

  try {
    await base.ready;
  } catch (error) {
    if (ownsDirectory) await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }

  async function close() {
    await base.close();
  }

  async function removeDirectory() {
    try { await close(); }
    finally {
      if (ownsDirectory) await fs.rm(directory, { recursive: true, force: true });
    }
  }

  async function start(provider, suffix) {
    const started = await base.start(provider, suffix);
    return Object.freeze({ ...started, launchRef: started.result.launchRef });
  }

  return Object.freeze({
    directory,
    checkpointPath: base.pathFor('checkpoint'),
    processesByProvider: base.processesByProvider,
    faults: base.faults,
    persistenceWritesBySlot: base.persistenceWritesBySlot,
    persistenceWriteCounts: base.persistenceWriteCounts,
    start,
    restart: base.restart,
    close,
    removeDirectory,
    setNow(value) {
      if (!Number.isSafeInteger(value) || value < 0) throw new TypeError('invalid fixture time');
      now = value;
    },
    getNow() { return now; },
    deliveryAdapter(provider) { return base.deliveryAdapter(provider); },
    reclamationService() { return base.reclamationService; },
    async checkpoint() {
      return JSON.parse(await fs.readFile(base.pathFor('checkpoint'), 'utf8'));
    },
    async checkpointBytes() {
      return fs.readFile(base.pathFor('checkpoint'));
    },
    async reclaim(deliveryAttemptId) {
      return base.reclamationService.reclaimTerminalDeliveryBody({ deliveryAttemptId });
    },
  });
}

module.exports = {
  createNativeTerminalDeliveryBodyReclamationHarness,
  correlationFor,
  otherProvider,
  PROVIDERS,
  TERMINAL_DELIVERY_KINDS,
  TERMINAL_DELIVERY_STATES,
  TERMINAL_RETENTION_MS,
};
