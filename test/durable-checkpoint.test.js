'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createEmptyLedger, createDelivery } = require('../src/server/delivery-ledger');
const {
  createDurableCheckpointStore,
  makeEmptyCheckpoint,
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

function errorCode(code) {
  return (error) => error?.code === code;
}

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