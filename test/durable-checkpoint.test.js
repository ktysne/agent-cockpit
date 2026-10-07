'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createEmptyLedger, createDelivery, registerPrTarget } = require('../src/server/delivery-ledger');
const {
  createDurableCheckpointStore,
  makeEmptyCheckpoint,
  mergeRegistrationHistory,
  normalizeCheckpoint,
} = require('../src/server/durable-checkpoint');
const { atomicWriteJson } = require('../src/server/json-storage');

async function temporaryDirectory(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-durable-checkpoint-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function sourceLaunch() {
  const identity = {
    provider: 'claude', nativeIdKind: 'session', hostId: 'claude-host',
    homeScopeId: 'claude-home', nativeId: 'source-session',
  };
  return {
    launchRef: 'source-launch-ref', launchId: 'source-launch', runId: 'source-run', attemptId: 'source-attempt',
    provider: 'claude', nativeIdKind: 'session', hostId: 'claude-host', homeScopeId: 'claude-home',
    origin: 'standalone', purpose: 'agent', originBinding: null, state: 'bound', identity,
    executionBinding: { periodId: 'source-period', actor: { kind: 'agent', id: 'source-actor' } },
    conversationId: 'source-conversation', sessionId: 'source-session',
  };
}

function checkpointWithLegacyDeliveryKinds(includeInstruction = false) {
  const launch = sourceLaunch();
  const runtimeLaunch = { ...launch, currentOwner: launch.executionBinding, ownerGeneration: 0 };
  const targetPeriod = {
    executionId: launch.executionBinding.periodId,
    conversationId: launch.conversationId,
    sessionId: launch.sessionId,
    identity: launch.identity,
  };
  let ledger = createEmptyLedger();
  for (const kind of ['question', 'result']) {
    ledger = createDelivery(ledger, kind, {
      deliveryAttemptId: 'legacy-' + kind,
      logicalMessageId: 'legacy-' + kind + '-logical',
      revision: 0,
      payload: 'opaque-' + kind,
    }, runtimeLaunch, kind === 'result' ? targetPeriod : undefined).ledger;
  }
  const registeredTarget = registerPrTarget(ledger, 'legacy-pr-target', launch);
  ledger = createDelivery(registeredTarget.ledger, 'pr-notification', {
    deliveryAttemptId: 'legacy-pr-notification',
    logicalMessageId: 'legacy-pr-logical',
    revision: 0,
    payload: 'opaque-pr',
    targetId: 'legacy-pr-target',
  }, runtimeLaunch).ledger;
  if (includeInstruction) {
    ledger = createDelivery(ledger, 'instruction', {
      deliveryAttemptId: 'instruction-delivery',
      logicalMessageId: 'instruction-logical',
      revision: 0,
      payload: JSON.stringify({ schemaVersion: 1, mode: 'start', expectedTurnId: null,
        input: [{ type: 'text', text: 'opaque instruction text', text_elements: [] }] }),
    }, runtimeLaunch).ledger;
  }
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
  const immutableExecutionClaims = { ...claims, identity: launch.identity,
    executionBinding: launch.executionBinding };
  const scope = {
    provider: launch.provider,
    nativeIdKind: launch.nativeIdKind,
    hostId: launch.hostId,
    homeScopeId: launch.homeScopeId,
    connectionSlotId: 'source-slot',
  };
  const checkpoint = makeEmptyCheckpoint();
  checkpoint.revision = 1;
  checkpoint.registrations.conversations = [{ conversationId: launch.conversationId, identity: launch.identity }];
  checkpoint.registrations.executions = [{ conversationId: launch.conversationId,
    executionId: launch.executionBinding.periodId, sessionId: launch.sessionId, state: 'active' }];
  checkpoint.registrations.launches = [{ launchRef: launch.launchRef, claims, state: 'bound',
    identity: launch.identity, executionBinding: launch.executionBinding,
    conversationId: launch.conversationId, sessionId: launch.sessionId }];
  checkpoint.registrations.runtimeLaunches = [{ launchRef: launch.launchRef,
    claims: immutableExecutionClaims, state: 'bound', conversationId: launch.conversationId,
    sessionId: launch.sessionId, currentOwner: launch.executionBinding, ownerGeneration: 0 }];
  checkpoint.registrations.connections = [{ scope, generation: 1, state: 'active' }];
  checkpoint.registrations.actors = [{ identity: launch.identity,
    periodId: launch.executionBinding.periodId, actor: launch.executionBinding.actor,
    contextId: 'source-context', launchRef: launch.launchRef, immutableExecutionClaims,
    connectionScope: scope, connectionGeneration: 1, state: 'active' }];
  checkpoint.ledger = ledger;
  checkpoint.schemaVersion = 1;
  delete checkpoint.registrations.replayClaims;
  delete checkpoint.registrations.incompleteConversationIds;
  return checkpoint;
}
function errorCode(code) {
  return (error) => error?.code === code;
}

test('checkpoint reads v1 ledgers without instruction and validates same-target instruction records', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'legacy-v1.json');
  const legacy = checkpointWithLegacyDeliveryKinds();
  await fs.writeFile(filePath, JSON.stringify(legacy, null, 2) + '\n', 'utf8');
  const reader = createDurableCheckpointStore({ filePath });
  t.after(() => reader.close());
  const restoredLegacy = await reader.load();
  assert.deepEqual(restoredLegacy.ledger.deliveries.map((item) => item.kind).sort(),
    ['pr-notification', 'question', 'result']);
  assert.equal(restoredLegacy.schemaVersion, 2);

  const withInstruction = checkpointWithLegacyDeliveryKinds(true);
  const normalized = normalizeCheckpoint(withInstruction);
  assert.equal(normalized.schemaVersion, 2);
  assert.deepEqual(normalized.ledger.deliveries.map((item) => item.kind).sort(),
    ['instruction', 'pr-notification', 'question', 'result']);
  const wrongInstructionTarget = structuredClone(withInstruction);
  wrongInstructionTarget.ledger.deliveries.find((item) => item.kind === 'instruction').target.actor.id = 'other-actor';
  assert.throws(() => normalizeCheckpoint(wrongInstructionTarget), errorCode('invalid_ledger'));
});
test('checkpoint rejects ledger references absent from captured registrations', () => {
  const created = createDelivery(createEmptyLedger(), 'question', {
    deliveryAttemptId: 'delivery-a', logicalMessageId: 'question-a', revision: 0, payload: 'private payload',
  }, sourceLaunch());
  const checkpoint = makeEmptyCheckpoint();
  checkpoint.ledger = created.ledger;
  assert.throws(() => normalizeCheckpoint(checkpoint), errorCode('checkpoint_ledger_source_mismatch'));
});

test('checkpoint store serializes saves and rejects a duplicate revision', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'checkpoint.json');
  let releaseWrite;
  let startedWrite;
  const started = new Promise((resolve) => { startedWrite = resolve; });
  const gate = new Promise((resolve) => { releaseWrite = resolve; });
  let writes = 0;
  const store = createDurableCheckpointStore({
    filePath,
    atomicWrite: async (target, value) => {
      writes += 1;
      if (writes === 1) {
        startedWrite();
        await gate;
      }
      await atomicWriteJson(path.dirname(target), path.basename(target), value);
    },
  });
  t.after(() => store.close());
  const checkpoint = makeEmptyCheckpoint();
  checkpoint.revision = 1;
  const first = store.save(checkpoint);
  await started;
  const second = store.save(checkpoint);
  releaseWrite();
  await first;
  await assert.rejects(second, errorCode('checkpoint_revision_not_advanced'));
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).revision, 1);
});

test('checkpoint store blocks after an uncertain replacement and preserves the last written file', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'checkpoint.json');
  const store = createDurableCheckpointStore({
    filePath,
    atomicWrite: async (target, value) => {
      await atomicWriteJson(path.dirname(target), path.basename(target), value);
      throw new Error('replacement outcome is unknown');
    },
  });
  t.after(() => store.close());
  const checkpoint = makeEmptyCheckpoint();
  checkpoint.revision = 1;
  await assert.rejects(store.save(checkpoint), errorCode('checkpoint_write_failed'));
  const newer = makeEmptyCheckpoint();
  newer.revision = 2;
  await assert.rejects(store.save(newer), errorCode('checkpoint_writer_blocked'));
  assert.equal(JSON.parse(await fs.readFile(filePath, 'utf8')).revision, 1);
});

test('checkpoint bounds a file read even when it grows after stat', async () => {
  const bytes = Buffer.from('x'.repeat(128));
  let largestRead = 0;
  const fileSystem = {
    async lstat() { return { isSymbolicLink: () => false, isFile: () => true }; },
    async open() {
      return {
        async stat() { return { isFile: () => true, size: 0 }; },
        async read(buffer, offset, length, position) {
          largestRead = Math.max(largestRead, length);
          const count = Math.min(length, bytes.length - position);
          bytes.copy(buffer, offset, position, position + count);
          return { bytesRead: count };
        },
        async close() {},
      };
    },
  };
  const store = createDurableCheckpointStore({
    filePath: path.join(os.tmpdir(), 'bounded-checkpoint.json'),
    maxBytes: 64,
    fileSystem,
    atomicWrite: async () => {},
  });
  try {
    await assert.rejects(store.load(), errorCode('checkpoint_too_large'));
    assert.ok(largestRead <= 65);
  } finally {
    await store.close();
  }
});


test('checkpoint rejects a connection generation gap regardless of record order', () => {
  const checkpoint = makeEmptyCheckpoint();
  const scope = { provider: 'claude', nativeIdKind: 'session', hostId: 'host',
    homeScopeId: 'home', connectionSlotId: 'slot' };
  checkpoint.registrations.connections = [
    { scope, generation: 3, state: 'inactive' },
    { scope, generation: 1, state: 'inactive' },
  ];
  assert.throws(() => normalizeCheckpoint(checkpoint), errorCode('checkpoint_connection_generation_gap'));
});

test('checkpoint saves and restores an adopted runtime launch before owner actor attestation', async (t) => {
  const directory = await temporaryDirectory(t);
  const filePath = path.join(directory, 'checkpoint.json');
  const store = createDurableCheckpointStore({ filePath });
  t.after(() => store.close());
  const child = sourceLaunch();
  const ownerIdentity = {
    provider: 'claude', nativeIdKind: 'session', hostId: 'claude-host',
    homeScopeId: 'claude-home', nativeId: 'owner-session',
  };
  const checkpoint = makeEmptyCheckpoint();
  checkpoint.revision = 1;
  checkpoint.registrations.conversations = [
    { conversationId: 'source-conversation', identity: child.identity },
    { conversationId: 'owner-conversation', identity: ownerIdentity },
  ];
  checkpoint.registrations.executions = [
    { conversationId: 'source-conversation', executionId: 'source-period', sessionId: 'source-session', state: 'active' },
    { conversationId: 'owner-conversation', executionId: 'owner-period', sessionId: 'owner-session', state: 'active' },
  ];
  checkpoint.registrations.replayClaims = [
    { startIdDigest: 'a'.repeat(64), evidenceIdDigest: 'b'.repeat(64), fingerprintDigest: 'c'.repeat(64),
      conversationId: 'source-conversation', executionId: 'source-period', order: 1 },
    { startIdDigest: 'd'.repeat(64), evidenceIdDigest: 'e'.repeat(64), fingerprintDigest: 'f'.repeat(64),
      conversationId: 'owner-conversation', executionId: 'owner-period', order: 2 },
  ];
  checkpoint.registrations.launches = [{
    launchRef: child.launchRef,
    claims: {
      launchId: child.launchId, runId: child.runId, attemptId: child.attemptId, provider: child.provider,
      nativeIdKind: child.nativeIdKind, hostId: child.hostId, homeScopeId: child.homeScopeId,
      origin: child.origin, purpose: child.purpose, originBinding: child.originBinding,
    },
    state: child.state,
    identity: child.identity,
    executionBinding: child.executionBinding,
    conversationId: child.conversationId,
    sessionId: child.sessionId,
  }];
  checkpoint.registrations.runtimeLaunches = [{
    launchRef: child.launchRef,
    claims: {
      launchId: child.launchId, runId: child.runId, attemptId: child.attemptId, provider: child.provider,
      nativeIdKind: child.nativeIdKind, hostId: child.hostId, homeScopeId: child.homeScopeId,
      origin: child.origin, purpose: child.purpose, originBinding: child.originBinding,
      identity: child.identity, executionBinding: child.executionBinding,
    },
    state: 'bound',
    conversationId: child.conversationId,
    sessionId: child.sessionId,
    currentOwner: { periodId: 'owner-period', actor: { kind: 'agent', id: 'owner-actor' } },
    ownerGeneration: 0,
  }];

  await store.save(checkpoint);
  const restored = await store.load();
  assert.equal(restored.registrations.runtimeLaunches[0].state, 'unknown');
  assert.deepEqual(restored.registrations.actors, []);
  assert.deepEqual(restored.registrations.connections, []);
  assert.deepEqual(Object.keys(restored.registrations.runtimeLaunches[0]), [
    'launchRef', 'claims', 'state', 'conversationId', 'sessionId', 'currentOwner', 'ownerGeneration',
  ]);

  const missingOwnerPeriod = structuredClone(checkpoint);
  missingOwnerPeriod.registrations.executions = missingOwnerPeriod.registrations.executions
    .filter((execution) => execution.executionId !== 'owner-period');
  assert.throws(() => normalizeCheckpoint(missingOwnerPeriod), errorCode('dangling_checkpoint_runtime_owner'));

  const otherActorCheckpoint = structuredClone(checkpoint);
  const ownerScope = { provider: 'claude', nativeIdKind: 'session', hostId: 'claude-host',
    homeScopeId: 'claude-home', connectionSlotId: 'owner-slot' };
  otherActorCheckpoint.registrations.connections = [{ scope: ownerScope, generation: 1, state: 'inactive' }];
  otherActorCheckpoint.registrations.actors = [{
    identity: ownerIdentity,
    periodId: 'owner-period',
    actor: { kind: 'agent', id: 'unrelated-actor' },
    contextId: 'owner-context',
    launchRef: null,
    immutableExecutionClaims: null,
    connectionScope: ownerScope,
    connectionGeneration: 1,
    state: 'unknown',
  }];
  const otherFilePath = path.join(directory, 'checkpoint-with-other-actor.json');
  const otherStore = createDurableCheckpointStore({ filePath: otherFilePath });
  try {
    await otherStore.save(otherActorCheckpoint);
    const restoredWithOtherActor = await otherStore.load();
    assert.equal(restoredWithOtherActor.registrations.runtimeLaunches[0].state, 'unknown');
    assert.equal(restoredWithOtherActor.registrations.actors[0].actor.id, 'unrelated-actor');
  } finally {
    await otherStore.close();
  }

  const contradictoryActor = structuredClone(otherActorCheckpoint);
  contradictoryActor.registrations.actors[0].identity = child.identity;
  assert.throws(() => normalizeCheckpoint(contradictoryActor), errorCode('dangling_checkpoint_actor'));
});

test('checkpoint rejects replay digest values without coercing objects', () => {
  const checkpoint = makeEmptyCheckpoint();
  const identity = {
    provider: 'claude', nativeIdKind: 'session', hostId: 'replay-host',
    homeScopeId: 'replay-home', nativeId: 'replay-session',
  };
  checkpoint.registrations.conversations = [{ conversationId: 'replay-conversation', identity }];
  checkpoint.registrations.executions = [{ conversationId: 'replay-conversation', executionId: 'replay-execution',
    sessionId: 'replay-session', state: 'unknown' }];
  let coercions = 0;
  checkpoint.registrations.replayClaims = [{
    startIdDigest: { toString() { coercions += 1; return 'a'.repeat(64); } },
    evidenceIdDigest: 'b'.repeat(64),
    fingerprintDigest: 'c'.repeat(64),
    conversationId: 'replay-conversation',
    executionId: 'replay-execution',
    order: 1,
  }];

  assert.throws(() => normalizeCheckpoint(checkpoint), errorCode('invalid_checkpoint_replay_claim'));
  assert.equal(coercions, 0);
});

test('complete replay history requires contiguous registration order', () => {
  const checkpoint = makeEmptyCheckpoint();
  const identity = {
    provider: 'claude', nativeIdKind: 'session', hostId: 'order-host',
    homeScopeId: 'order-home', nativeId: 'order-session',
  };
  checkpoint.registrations.conversations = [{ conversationId: 'order-conversation', identity }];
  checkpoint.registrations.executions = [{ conversationId: 'order-conversation', executionId: 'order-execution',
    sessionId: 'order-session', state: 'unknown' }];
  checkpoint.registrations.replayClaims = [{
    startIdDigest: 'a'.repeat(64), evidenceIdDigest: 'b'.repeat(64), fingerprintDigest: 'c'.repeat(64),
    conversationId: 'order-conversation', executionId: 'order-execution', order: 2,
  }];

  assert.throws(() => normalizeCheckpoint(checkpoint), errorCode('checkpoint_replay_order_gap'));
});

test('merge appends fresh replay claims after saved order and rejects evidence collisions', () => {
  function registrationHistory(tag, order, evidenceIdDigest) {
    const identity = {
      provider: 'codex', nativeIdKind: 'thread', hostId: `${tag}-host`,
      homeScopeId: `${tag}-home`, nativeId: `${tag}-thread`,
    };
    const registrations = makeEmptyCheckpoint().registrations;
    registrations.conversations = [{ conversationId: `${tag}-conversation`, identity }];
    registrations.executions = [{ conversationId: `${tag}-conversation`, executionId: `${tag}-execution`,
      sessionId: `${tag}-session`, state: 'unknown' }];
    registrations.replayClaims = [{
      startIdDigest: tag === 'first' ? 'a'.repeat(64) : 'd'.repeat(64),
      evidenceIdDigest,
      fingerprintDigest: tag === 'first' ? 'c'.repeat(64) : 'e'.repeat(64),
      conversationId: `${tag}-conversation`,
      executionId: `${tag}-execution`,
      order,
    }];
    return registrations;
  }

  const first = registrationHistory('first', 1, 'b'.repeat(64));
  assert.throws(() => mergeRegistrationHistory(first, registrationHistory('second', 1, 'b'.repeat(64))),
    errorCode('duplicate_checkpoint_replay_claim'));

  const fresh = registrationHistory('second', 1, 'f'.repeat(64));
  const merged = mergeRegistrationHistory(first, fresh);
  assert.deepEqual(merged.replayClaims.map((claim) => claim.order), [1, 2]);
  assert.deepEqual(merged.replayClaims[0], first.replayClaims[0]);
  assert.deepEqual(merged.replayClaims[1], { ...fresh.replayClaims[0], order: 2 });
  assert.throws(() => mergeRegistrationHistory(first, registrationHistory('malformed', 2, 'e'.repeat(64))),
    errorCode('checkpoint_replay_order_gap'));
});

test('shared replay claims keep saved order and reject reversed shared order', () => {
  function registrationHistory(tag, order, evidenceIdDigest) {
    const identity = {
      provider: 'codex', nativeIdKind: 'thread', hostId: `${tag}-host`,
      homeScopeId: `${tag}-home`, nativeId: `${tag}-thread`,
    };
    const registrations = makeEmptyCheckpoint().registrations;
    registrations.conversations = [{ conversationId: `${tag}-conversation`, identity }];
    registrations.executions = [{ conversationId: `${tag}-conversation`, executionId: `${tag}-execution`,
      sessionId: `${tag}-session`, state: 'unknown' }];
    registrations.replayClaims = [{
      startIdDigest: tag === 'first' ? 'a'.repeat(64) : tag === 'second' ? 'd'.repeat(64) : '1'.repeat(64),
      evidenceIdDigest,
      fingerprintDigest: tag === 'first' ? 'c'.repeat(64) : tag === 'second' ? 'e'.repeat(64) : '2'.repeat(64),
      conversationId: `${tag}-conversation`,
      executionId: `${tag}-execution`,
      order,
    }];
    return registrations;
  }

  const first = registrationHistory('first', 1, 'b'.repeat(64));
  const second = registrationHistory('second', 1, 'f'.repeat(64));
  const saved = mergeRegistrationHistory(first, second);
  const third = registrationHistory('third', 1, '3'.repeat(64));
  const reorderedIncoming = {
    ...structuredClone(saved),
    conversations: [...saved.conversations, ...third.conversations],
    executions: [...saved.executions, ...third.executions],
    replayClaims: [
      { ...third.replayClaims[0], order: 1 },
      { ...saved.replayClaims[0], order: 2 },
      { ...saved.replayClaims[1], order: 3 },
    ],
  };
  const merged = mergeRegistrationHistory(saved, reorderedIncoming);
  assert.deepEqual(merged.replayClaims.map((claim) => claim.order), [1, 2, 3]);
  assert.deepEqual(merged.replayClaims.slice(0, 2), saved.replayClaims);
  assert.deepEqual(merged.replayClaims[2], { ...third.replayClaims[0], order: 3 });

  const reversed = structuredClone(saved);
  reversed.replayClaims = [
    { ...saved.replayClaims[1], order: 1 },
    { ...saved.replayClaims[0], order: 2 },
  ];
  assert.throws(() => mergeRegistrationHistory(saved, reversed), errorCode('checkpoint_replay_order_changed'));
});

test('merge does not assign a fresh replay claim past the bounded order limit', () => {
  function registrationHistory(tag, order, evidenceIdDigest) {
    const identity = {
      provider: 'codex', nativeIdKind: 'thread', hostId: `${tag}-host`,
      homeScopeId: `${tag}-home`, nativeId: `${tag}-thread`,
    };
    const registrations = makeEmptyCheckpoint().registrations;
    registrations.conversations = [{ conversationId: `${tag}-conversation`, identity }];
    registrations.executions = [{ conversationId: `${tag}-conversation`, executionId: `${tag}-execution`,
      sessionId: `${tag}-session`, state: 'unknown' }];
    registrations.replayClaims = [{
      startIdDigest: tag === 'first' ? 'a'.repeat(64) : 'd'.repeat(64),
      evidenceIdDigest,
      fingerprintDigest: tag === 'first' ? 'c'.repeat(64) : 'e'.repeat(64),
      conversationId: `${tag}-conversation`,
      executionId: `${tag}-execution`,
      order,
    }];
    registrations.incompleteConversationIds = [`${tag}-conversation`];
    return registrations;
  }

  const saved = registrationHistory('first', 20_000, 'b'.repeat(64));
  const incoming = registrationHistory('second', 1, 'f'.repeat(64));
  assert.throws(() => mergeRegistrationHistory(saved, incoming), errorCode('checkpoint_capacity'));
});
