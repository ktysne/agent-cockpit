'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createQuestionRecord, selectionFor } = require('../../src/server/common-question-kernel');
const { createDelivery, createEmptyLedger } = require('../../src/server/delivery-ledger');
const { makeEmptyCheckpoint } = require('../../src/server/durable-checkpoint');
const { createNativeInstructionBodyReclamationHarness } = require('./native-instruction-body-reclamation-harness');

const PROVIDERS = Object.freeze(['claude', 'codex']);
const DATA_FILES = Object.freeze({
  checkpoint: 'delivery-checkpoint.json',
  instructions: 'instruction-journal.json',
  questions: 'common-question-journal.json',
});
const NORMAL_ANCHOR_MAX_BYTES = 256 * 1024;

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function legacyQuestion(provider) {
  return createQuestionRecord({
    internalQuestionId: 'internal-1',
    questionId: 'public-1',
    identity: {
      provider,
      nativeIdKind: provider === 'claude' ? 'session' : 'thread',
      hostId: `host-${provider}`,
      homeScopeId: `home-${provider}`,
      nativeId: 'native-1',
    },
    periodId: 'period-1',
    executionId: 'execution-1',
    conversationId: 'conversation-1',
    launchRef: 'launch-1',
    executionBinding: { periodId: 'period-1', actor: { kind: 'agent', id: 'actor-1' } },
    category: 'ordinary',
    questions: [{
      id: 'question-1',
      text: 'Choose one',
      mode: 'single',
      options: [{ id: 'option-1', label: 'First', description: '' }],
      allowFreeText: true,
      recommendedOptionId: 'option-1',
    }],
    timeoutMinutes: 1,
    createdAt: 10_000,
  });
}

function legacyCheckpointWithLaunch(launch, ledger) {
  const checkpoint = structuredClone(makeEmptyCheckpoint());
  checkpoint.schemaVersion = 2;
  checkpoint.revision = 9;
  checkpoint.ledger = structuredClone(ledger);
  checkpoint.ledger.revision = 11;
  const claims = {
    launchId: launch.launchId,
    runId: launch.runId,
    attemptId: launch.attemptId,
    provider: launch.provider,
    nativeIdKind: launch.nativeIdKind,
    hostId: launch.hostId,
    homeScopeId: launch.homeScopeId,
    origin: launch.origin,
    purpose: launch.purpose,
    originBinding: launch.originBinding,
  };
  const immutableExecutionClaims = {
    ...claims,
    identity: launch.identity,
    executionBinding: launch.executionBinding,
  };
  const scope = {
    provider: launch.provider,
    nativeIdKind: launch.nativeIdKind,
    hostId: launch.hostId,
    homeScopeId: launch.homeScopeId,
    connectionSlotId: 'source-slot',
  };
  checkpoint.registrations.conversations = [{ conversationId: launch.conversationId, identity: launch.identity }];
  checkpoint.registrations.executions = [{
    conversationId: launch.conversationId,
    executionId: launch.executionBinding.periodId,
    sessionId: launch.sessionId,
    state: 'active',
  }];
  checkpoint.registrations.launches = [{
    launchRef: launch.launchRef,
    claims,
    state: 'bound',
    identity: launch.identity,
    executionBinding: launch.executionBinding,
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
  }];
  checkpoint.registrations.runtimeLaunches = [{
    launchRef: launch.launchRef,
    claims: immutableExecutionClaims,
    state: 'bound',
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
    currentOwner: launch.executionBinding,
    ownerGeneration: 0,
  }];
  checkpoint.registrations.connections = [{ scope, generation: 1, state: 'active' }];
  checkpoint.registrations.actors = [{
    identity: launch.identity,
    periodId: launch.executionBinding.periodId,
    actor: launch.executionBinding.actor,
    contextId: 'source-context',
    launchRef: launch.launchRef,
    immutableExecutionClaims,
    connectionScope: scope,
    connectionGeneration: 1,
    state: 'active',
  }];
  checkpoint.registrations.incompleteConversationIds = [launch.conversationId];
  return checkpoint;
}

function threeSlotLegacySources(provider) {
  const selected = selectionFor(legacyQuestion(provider), [{
    questionId: 'question-1', optionIds: ['option-1'], freeText: null,
  }], 'manual', 11_000, 'selection-1').record;
  const launch = {
    launchRef: selected.launchRef,
    launchId: 'launch-id',
    runId: 'run-id',
    attemptId: 'attempt-id',
    provider: selected.identity.provider,
    nativeIdKind: selected.identity.nativeIdKind,
    hostId: selected.identity.hostId,
    homeScopeId: selected.identity.homeScopeId,
    origin: 'standalone',
    purpose: 'agent',
    originBinding: null,
    state: 'bound',
    identity: selected.identity,
    executionBinding: selected.executionBinding,
    conversationId: selected.conversationId,
    sessionId: 'session-1',
    currentOwner: selected.executionBinding,
    ownerGeneration: 0,
  };
  const questionPayload = JSON.stringify({
    questionId: selected.questionId,
    revision: selected.deliveryIntent.revision,
    answers: selected.selection.answers,
  });
  const questionLedger = createDelivery(createEmptyLedger(), 'question', {
    deliveryAttemptId: selected.deliveryIntent.deliveryAttemptId,
    logicalMessageId: selected.deliveryIntent.logicalMessageId,
    revision: selected.deliveryIntent.revision,
    payload: questionPayload,
  }, launch).ledger;
  const input = [{ type: 'text', text: 'instruction-payload', text_elements: [] }];
  const envelope = JSON.stringify({ schemaVersion: 1, mode: 'start', expectedTurnId: null, input });
  const combinedLedger = createDelivery(questionLedger, 'instruction', {
    deliveryAttemptId: 'attempt-instruction',
    logicalMessageId: 'logical-instruction',
    revision: 3,
    payload: envelope,
  }, launch).ledger;
  const checkpoint = legacyCheckpointWithLaunch(launch, combinedLedger);
  const instructionDelivery = combinedLedger.deliveries.find((delivery) => delivery.kind === 'instruction');
  const instruction = {
    deliveryAttemptId: instructionDelivery.deliveryAttemptId,
    launchRef: instructionDelivery.source.launchRef,
    logicalMessageId: instructionDelivery.logicalMessageId,
    revision: instructionDelivery.revision,
    source: instructionDelivery.source,
    envelope,
    envelopeDigest: sha256(envelope),
    nativeContentDigest: sha256(JSON.stringify(input)),
    createdAt: 12_000,
  };
  return Object.freeze({
    checkpoint: Buffer.from(JSON.stringify(checkpoint), 'utf8'),
    instructions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, instructions: [instruction] }), 'utf8'),
    questions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, questions: [selected] }), 'utf8'),
    question: selected,
  });
}

async function temporaryDirectory() {
  const root = await fs.realpath(os.tmpdir());
  return fs.mkdtemp(path.join(root, 'native-migration-allowance-release-'));
}

async function writeLegacySources(directory, sources) {
  await fs.mkdir(directory, { recursive: true });
  await Promise.all(Object.entries(DATA_FILES).map(([slot, name]) =>
    fs.writeFile(path.join(directory, name), sources[slot])));
}

function reclamationConfig(normalByteLimitsBySlot, overrides = {}) {
  return {
    maxAdditionalBytes: 64 * 1024 * 1024,
    normalByteLimitsBySlot,
    maxRecordsBySlot: { checkpoint: 50_000, instructions: 20_000, questions: 20_000 },
    ...overrides,
  };
}

function createLeaseObserver(resizeFailure = null) {
  const contextPath = require.resolve('../../src/server/reclamation-service-context');
  require(contextPath);
  const entry = require.cache[contextPath];
  const originalExports = entry.exports;
  const acquisitions = [];
  const timeline = [];
  const capturedWriters = new Map();
  const backendSaveWaiters = new Map();
  let resizeFailureUsed = false;
  let leaseStatusUnknown = false;
  function currentLeaseStatus() {
    const latest = acquisitions.at(-1);
    try { return latest?.lease?.status() ?? null; } catch { return null; }
  }
  entry.exports = {
    ...originalExports,
    createReclamationServiceContext(options) {
      const budget = options.capacityBudget;
      const observedBudget = Object.freeze({
        status: () => budget.status(),
        acquire(bytes) {
          const record = { id: acquisitions.length + 1, events: [], lease: null };
          timeline.push({ operation: 'lease-acquire:start', requestedBytes: bytes });
          const lease = budget.acquire(bytes);
          timeline.push({ operation: 'lease-acquire:complete', status: lease.status() });
          const observedLease = Object.freeze({
            resize(nextBytes) {
              const event = { operation: 'resize', requestedBytes: nextBytes, before: lease.status(), after: null };
              record.events.push(event);
              timeline.push({ operation: 'lease-resize:start', requestedBytes: nextBytes,
                leaseStatus: event.before });
              try {
                if (!resizeFailureUsed && resizeFailure && nextBytes < event.before.bytes) {
                  resizeFailureUsed = true;
                  throw Object.assign(new Error('fixture migration allowance resize failure'), {
                    code: 'fixture_migration_allowance_resize_failure',
                  });
                }
                return lease.resize(nextBytes);
              }
              finally {
                event.after = lease.status();
                timeline.push({ operation: 'lease-resize:complete', status: event.after });
                if (resizeFailure === 'unknown' && resizeFailureUsed && event.after.bytes >= event.before.bytes) {
                  leaseStatusUnknown = true;
                }
              }
            },
            release() {
              const event = { operation: 'release', before: lease.status(), after: null };
              record.events.push(event);
              timeline.push({ operation: 'lease-release:start' });
              try { return lease.release(); }
              finally {
                event.after = lease.status();
                timeline.push({ operation: 'lease-release:complete', status: event.after });
              }
            },
            status: () => leaseStatusUnknown
              ? Object.freeze({ bytes: Number.NaN, released: false })
              : lease.status(),
          });
          record.lease = observedLease;
          acquisitions.push(record);
          return observedLease;
        },
      });
      const persistence = options.persistence;
      const observedPersistence = Object.freeze({
        configuredSlots: persistence.configuredSlots,
        async readAnchorBytes(...args) {
          timeline.push({ operation: 'anchor-read:start', leaseStatus: currentLeaseStatus() });
          try {
            const result = await persistence.readAnchorBytes(...args);
            timeline.push({ operation: 'anchor-read:complete', leaseStatus: currentLeaseStatus() });
            return result;
          } catch (error) {
            timeline.push({ operation: 'anchor-read:failed' });
            throw error;
          }
        },
        async readSlotBytes(slot, ...args) {
          timeline.push({ operation: 'slot-read:start', slot, leaseStatus: currentLeaseStatus() });
          try {
            const result = await persistence.readSlotBytes(slot, ...args);
            timeline.push({ operation: 'slot-read:complete', slot, leaseStatus: currentLeaseStatus() });
            return result;
          } catch (error) {
            timeline.push({ operation: 'slot-read:failed', slot });
            throw error;
          }
        },
        async writeAnchorBytes(...args) {
          timeline.push({ operation: 'anchor-write:start', leaseStatus: currentLeaseStatus() });
          try {
            const result = await persistence.writeAnchorBytes(...args);
            timeline.push({ operation: 'anchor-write:complete', leaseStatus: currentLeaseStatus() });
            return result;
          } catch (error) {
            timeline.push({ operation: 'anchor-write:failed' });
            throw error;
          }
        },
        async writeSlotBytes(slot, ...args) {
          timeline.push({ operation: 'slot-write:start', slot, leaseStatus: currentLeaseStatus() });
          try {
            const result = await persistence.writeSlotBytes(slot, ...args);
            timeline.push({ operation: 'slot-write:complete', slot, leaseStatus: currentLeaseStatus() });
            return result;
          } catch (error) {
            timeline.push({ operation: 'slot-write:failed', slot });
            throw error;
          }
        },
        close: () => persistence.close(),
        status: () => persistence.status(),
      });
      const created = originalExports.createReclamationServiceContext({
        ...options,
        persistence: observedPersistence,
        capacityBudget: observedBudget,
      });
      const observedBackends = new Map();
      return Object.freeze({
        ...created,
        backend(slot) {
          if (!observedBackends.has(slot)) {
            const backend = created.backend(slot);
            observedBackends.set(slot, Object.freeze({
              ...backend,
              save(...args) {
                timeline.push({ operation: 'context-backend-save', slot });
                const waiters = backendSaveWaiters.get(slot);
                if (waiters?.length) waiters.shift()();
                return backend.save(...args);
              },
            }));
          }
          return observedBackends.get(slot);
        },
        releaseMigrationAllowance(value) {
          if (value && typeof value === 'object' && typeof value.slot === 'string') {
            capturedWriters.set(value.slot, value.writer);
          }
          return created.releaseMigrationAllowance(value);
        },
      });
    },
  };
  return {
    acquisitions,
    timeline,
    writerForSlot(slot) { return capturedWriters.get(slot) || null; },
    waitForNextBackendSave(slot) {
      return new Promise((resolve) => {
        const waiters = backendSaveWaiters.get(slot) || [];
        waiters.push(resolve);
        backendSaveWaiters.set(slot, waiters);
      });
    },
    restore() {
      if (require.cache[contextPath] === entry) entry.exports = originalExports;
    },
  };
}

function limitsForPostBodyRelease(sources) {
  return Object.freeze({
    checkpoint: sources.checkpoint.length + 4_000,
    instructions: sources.instructions.length + 700,
    questions: sources.questions.length + 700,
  });
}

async function createSeededHarness(provider, options = {}) {
  if (!PROVIDERS.includes(provider)) throw new TypeError('unknown provider');
  const directory = options.directory || await temporaryDirectory();
  const sources = options.sources || threeSlotLegacySources(provider);
  await writeLegacySources(directory, sources);
  const normalByteLimitsBySlot = options.normalByteLimitsBySlot || Object.freeze({
    checkpoint: sources.checkpoint.length,
    instructions: sources.instructions.length,
    questions: sources.questions.length,
  });
  let now = options.initialNow ?? 1_000_000;
  const leaseObserver = createLeaseObserver(options.leaseResizeFailure || null);
  let harness;
  try {
    harness = createNativeInstructionBodyReclamationHarness({
      directory,
      now: () => now,
      reclamation: reclamationConfig(normalByteLimitsBySlot, options.reclamationOverrides),
    });
    await harness.ready;
  } catch (error) {
    if (harness) await harness.close().catch(() => {});
    leaseObserver.restore();
    if (!options.directory) await fs.rm(directory, { recursive: true, force: true });
    throw error;
  }
  return Object.freeze({
    directory,
    provider,
    sources,
    normalByteLimitsBySlot,
    harness,
    leaseObserver,
    setNow(value) { now = value; },
    getNow() { return now; },
    async readJson(slot) {
      return JSON.parse(await fs.readFile(path.join(directory, DATA_FILES[slot]), 'utf8'));
    },
    async readSlotBytes() {
      return Object.fromEntries(await Promise.all(Object.entries(DATA_FILES).map(async ([slot, name]) =>
        [slot, await fs.readFile(path.join(directory, name))])));
    },
    async readAllBytes() {
      const result = await Object.fromEntries(await Promise.all(Object.entries(DATA_FILES).map(async ([slot, name]) =>
        [slot, await fs.readFile(path.join(directory, name))])));
      result.anchor = await fs.readFile(path.join(directory, 'question-reclamation-anchor.json'));
      return result;
    },
    async removeDirectory() {
      await fs.rm(directory, { recursive: true, force: true });
    },
  });
}

module.exports = {
  DATA_FILES,
  NORMAL_ANCHOR_MAX_BYTES,
  PROVIDERS,
  createSeededHarness,
  limitsForPostBodyRelease,
  reclamationConfig,
  threeSlotLegacySources,
};
