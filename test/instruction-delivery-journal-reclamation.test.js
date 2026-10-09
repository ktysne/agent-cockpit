'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createInstructionEnvelope } = require('../src/server/instruction-envelope');
const {
  appendInstructionIntentV2,
  createInstructionDeliveryJournal,
  sourceProjectionFromLaunch,
} = require('../src/server/instruction-delivery-journal');
const {
  normalizeInstructionJournalV2Local,
  normalizeInstructionRecordV2Local,
} = require('../src/server/delivery-reclamation-codec');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const BYTE_LIMIT = 16_777_216;

function emptyJournal() {
  return { schemaVersion: 2, revision: 0, storeId: STORE_ID, migrationAllowance: null, instructions: [] };
}

function createResumeBarrierBackend() {
  let value = emptyJournal();
  let nextBarrier = null;
  let saveCount = 0;
  let flushCount = 0;
  return {
    slot: 'instructions',
    normalByteLimit: BYTE_LIMIT,
    canWrite() { return true; },
    async load() { return structuredClone(value); },
    async save(candidate) {
      saveCount += 1;
      value = structuredClone(candidate);
      return structuredClone(value);
    },
    async prepareResume(snapshot) {
      const barrier = nextBarrier;
      nextBarrier = null;
      if (barrier) {
        barrier.started();
        await barrier.wait;
      }
      value = structuredClone(snapshot.stores.instructions);
    },
    async flush() { flushCount += 1; },
    async close() {},
    get saveCount() { return saveCount; },
    get flushCount() { return flushCount; },
    pauseNextResume() {
      let signalStarted;
      let release;
      const started = new Promise((resolve) => { signalStarted = resolve; });
      const wait = new Promise((resolve) => { release = resolve; });
      nextBarrier = { started: signalStarted, wait };
      return { started, release };
    },
  };
}

function launch() {
  return {
    launchRef: 'launch-ref', launchId: 'launch-id', runId: 'run-id', attemptId: 'attempt-id',
    provider: 'claude', nativeIdKind: 'session', hostId: 'host-id', homeScopeId: 'home-id',
    origin: 'standalone', purpose: 'agent', originBinding: null, state: 'bound',
    identity: {
      provider: 'claude', nativeIdKind: 'session', hostId: 'host-id',
      homeScopeId: 'home-id', nativeId: 'native-id',
    },
    executionBinding: { periodId: 'period-id', actor: { kind: 'agent', id: 'actor-id' } },
    conversationId: 'conversation-id', sessionId: 'session-id',
  };
}

function intent(source, deliveryAttemptId, logicalMessageId, revision = 1) {
  const envelope = createInstructionEnvelope({
    mode: 'start', expectedTurnId: null, text: 'Continue the work',
  });
  return {
    deliveryAttemptId, launchRef: source.launchRef, logicalMessageId, revision, source,
    envelope: envelope.serialized, envelopeDigest: envelope.envelopeDigest,
    nativeContentDigest: envelope.nativeContentDigest, createdAt: 1_000,
  };
}

function journalWithGrave(source) {
  const oldIntent = intent(source, 'attempt-grave', 'logical-grave');
  const preparation = {
    operationId: OPERATION_ID,
    terminalState: 'applied',
    terminalAt: 10,
    preparedAt: 604_800_010,
  };
  const grave = normalizeInstructionRecordV2Local({
    recordType: 'reclaimed',
    deliveryAttemptId: oldIntent.deliveryAttemptId,
    launchRef: oldIntent.launchRef,
    logicalMessageId: oldIntent.logicalMessageId,
    revision: oldIntent.revision,
    source: oldIntent.source,
    envelopeDigest: oldIntent.envelopeDigest,
    nativeContentDigest: oldIntent.nativeContentDigest,
    createdAt: oldIntent.createdAt,
    deliveryCreationState: 'checkpointed',
    reclamation: preparation,
    reclaimedAt: preparation.preparedAt,
  });
  return normalizeInstructionJournalV2Local({
    schemaVersion: 2, revision: 1, storeId: STORE_ID, migrationAllowance: null, instructions: [grave],
  });
}

test('a grave retains its logical key without blocking unrelated new instructions', () => {
  const source = sourceProjectionFromLaunch(launch());
  const journal = journalWithGrave(source);

  const appended = appendInstructionIntentV2(
    journal, intent(source, 'attempt-new', 'logical-new'));

  assert.equal(appended.created, true);
  assert.equal(appended.journal.instructions.length, 2);
  assert.equal(appended.journal.instructions[0].recordType, 'reclaimed');
  assert.equal(appended.journal.instructions[1].deliveryAttemptId, 'attempt-new');
  assert.throws(() => appendInstructionIntentV2(
    journal, intent(source, 'attempt-conflict', 'logical-grave')),
  (error) => error.code === 'instruction_logical_conflict');
});

test('a closed instruction journal rejects delayed resume without reopening flush or writes', async () => {
  const backend = createResumeBarrierBackend();
  const journal = createInstructionDeliveryJournal({ reclamation: {
    backend,
    periodGate: { capture() { return {}; }, assertCurrent() {} },
  } });
  const fullSnapshot = { anchor: {}, stores: { instructions: emptyJournal() } };
  const barrier = backend.pauseNextResume();
  const pending = journal.reclamationWriter.prepareResume(fullSnapshot);
  await barrier.started;
  await journal.close();
  barrier.release();

  await assert.rejects(pending, (error) => error.code === 'instruction_journal_closed');
  await assert.rejects(journal.flush(), (error) => error.code === 'instruction_journal_closed');
  await assert.rejects(journal.save(emptyJournal()),
    (error) => error.code === 'instruction_journal_closed');
  assert.equal(backend.saveCount, 0);
  assert.equal(backend.flushCount, 0);
});
