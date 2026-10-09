'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createInstructionEnvelope } = require('../src/server/instruction-envelope');
const {
  appendInstructionIntentV2,
  sourceProjectionFromLaunch,
} = require('../src/server/instruction-delivery-journal');
const {
  normalizeInstructionJournalV2Local,
  normalizeInstructionRecordV2Local,
} = require('../src/server/delivery-reclamation-codec');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';

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
