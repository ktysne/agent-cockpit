'use strict';

const assert = require('node:assert/strict');
const { createHash, randomUUID } = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createReclamationCapacityBudget } = require('../src/server/reclamation-capacity-reservation');
const { createReclamationMigrationCoordinator } = require('../src/server/reclamation-migration-coordinator');
const { createReclamationPersistence } = require('../src/server/reclamation-persistence');
const { createQuestionRecord, selectionFor } = require('../src/server/common-question-kernel');
const { createDelivery, createEmptyLedger } = require('../src/server/delivery-ledger');
const { makeEmptyCheckpoint } = require('../src/server/durable-checkpoint');
const { decodeSourceBytes } = require('../src/server/reclamation-json-codec');
const { planInitialReclamationMigration } = require('../src/server/reclamation-migration-plan');
const { MAX_SOURCE_BYTES } = require('../src/server/reclamation-capacity-bounds');
const {
  encodeQuestionReclamationAnchorV1Local,
  normalizeQuestionReclamationAnchorV1Local,
} = require('../src/server/question-reclamation-anchor-codec');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_STORE_ID = '33333333-3333-4333-8333-333333333333';
const OTHER_OPERATION_ID = '44444444-4444-4444-8444-444444444444';
const NORMAL_LIMIT = MAX_SOURCE_BYTES;

function memoryPersistence(configuredSlots, initial = {}, faultHooks = {}) {
  const events = [];
  const data = {
    anchor: initial.anchor === null || initial.anchor === undefined ? null : Buffer.from(initial.anchor),
    slots: Object.create(null),
    closed: false,
  };
  for (const slot of configuredSlots) {
    const value = initial.slots?.[slot];
    data.slots[slot] = value === null || value === undefined ? null : Buffer.from(value);
  }
  const persistence = {
    configuredSlots: Object.freeze([...configuredSlots]),
    async readAnchorBytes(maximumBytes) {
      events.push(['read-anchor', maximumBytes]);
      if (data.anchor !== null && data.anchor.length > maximumBytes) throw new RangeError('read_limit');
      const bytes = data.anchor === null ? null : Buffer.from(data.anchor);
      const replacement = faultHooks.readAnchor?.({ bytes, data, maximumBytes });
      return replacement === undefined ? bytes : replacement;
    },
    async readSlotBytes(slot, maximumBytes) {
      events.push(['read-slot', slot, maximumBytes]);
      if (!Object.hasOwn(data.slots, slot)) throw new Error('unconfigured_slot');
      const bytes = data.slots[slot];
      if (bytes !== null && bytes.length > maximumBytes) throw new RangeError('read_limit');
      const copy = bytes === null ? null : Buffer.from(bytes);
      const replacement = faultHooks.readSlot?.({ slot, bytes: copy, data, maximumBytes });
      return replacement === undefined ? copy : replacement;
    },
    async writeAnchorBytes(bytes, maximumBytes) {
      events.push(['write-anchor', Buffer.from(bytes)]);
      if (bytes.length > maximumBytes) throw new RangeError('write_limit');
      faultHooks.beforeWriteAnchor?.({ bytes: Buffer.from(bytes), data, maximumBytes });
      data.anchor = Buffer.from(bytes);
      faultHooks.afterWriteAnchor?.({ bytes: Buffer.from(bytes), data, maximumBytes });
    },
    async writeSlotBytes(slot, bytes, maximumBytes) {
      events.push(['write-slot', slot, Buffer.from(bytes)]);
      if (!Object.hasOwn(data.slots, slot)) throw new Error('unconfigured_slot');
      if (bytes.length > maximumBytes) throw new RangeError('write_limit');
      faultHooks.beforeWriteSlot?.({ slot, bytes: Buffer.from(bytes), data, maximumBytes });
      data.slots[slot] = Buffer.from(bytes);
      faultHooks.afterWriteSlot?.({ slot, bytes: Buffer.from(bytes), data, maximumBytes });
    },
    async close() {
      events.push(['close']);
      data.closed = true;
    },
    status() {
      return { closed: data.closed, writeBlocked: false };
    },
  };
  return { persistence, events, data };
}

function createWriters(configuredSlots, events, hooks = {}) {
  const writers = Object.create(null);
  for (const slot of configuredSlots) {
    writers[slot] = {
      stop() {
        events.push(['stop', slot]);
        return hooks.stop?.(slot);
      },
      drain() {
        events.push(['drain', slot]);
        return hooks.drain?.(slot);
      },
      prepareResume(snapshot) {
        events.push(['prepare', slot, snapshot]);
        return hooks.prepare?.(slot, snapshot);
      },
    };
  }
  return writers;
}

function coordinatorOptions({ persistence, writersBySlot, events, configuredSlots, hooks = {},
  capacityBytes = 1_000_000_000, normalByteLimitsBySlot = null, capacityBudget = null }) {
  const limits = normalByteLimitsBySlot || Object.fromEntries(configuredSlots.map((slot) => [slot, NORMAL_LIMIT]));
  return {
    persistence,
    writersBySlot: writersBySlot || createWriters(configuredSlots, events, hooks),
    capacityBudget: capacityBudget || createReclamationCapacityBudget({ maxAdditionalBytes: capacityBytes }),
    normalByteLimitsBySlot: limits,
    createStoreId: () => STORE_ID,
    createOperationId: () => OPERATION_ID,
    now: () => 1234,
  };
}

function trackedCapacityBudget(maxAdditionalBytes = 1_000_000_000) {
  const delegate = createReclamationCapacityBudget({ maxAdditionalBytes });
  const history = { acquired: [], resized: [], released: 0 };
  const capacityBudget = {
    acquire(bytes) {
      history.acquired.push(bytes);
      const lease = delegate.acquire(bytes);
      return {
        resize(nextBytes) {
          history.resized.push(nextBytes);
          return lease.resize(nextBytes);
        },
        release() {
          history.released += 1;
          return lease.release();
        },
        status() {
          return lease.status();
        },
      };
    },
    status() {
      return delegate.status();
    },
  };
  return { capacityBudget, history };
}

function emptyLegacyQuestionBytes() {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 2, questions: [] }), 'utf8');
}

function legacyQuestion(provider) {
  return createQuestionRecord({
    internalQuestionId: 'internal-linked',
    questionId: 'public-linked',
    identity: {
      provider,
      nativeIdKind: provider === 'claude' ? 'session' : 'thread',
      hostId: `host-${provider}`,
      homeScopeId: `home-${provider}`,
      nativeId: 'native-linked',
    },
    periodId: 'period-linked',
    executionId: 'execution-linked',
    conversationId: 'conversation-linked',
    launchRef: 'launch-linked',
    executionBinding: { periodId: 'period-linked', actor: { kind: 'agent', id: 'actor-linked' } },
    category: 'ordinary',
    questions: [{
      id: 'choice', text: 'Choose', mode: 'single',
      options: [{ id: 'first', label: 'First', description: '' }],
      allowFreeText: true, recommendedOptionId: 'first',
    }],
    timeoutMinutes: 1,
    createdAt: 10_000,
  });
}

function sha256(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function threeSlotLegacySources(provider) {
  const created = legacyQuestion(provider);
  const selected = selectionFor(created, [{
    questionId: 'choice', optionIds: ['first'], freeText: null,
  }], 'manual', 11_000, 'selection-linked').record;
  const launch = {
    launchRef: selected.launchRef,
    launchId: 'launch-id', runId: 'run-id', attemptId: 'attempt-id',
    provider: selected.identity.provider,
    nativeIdKind: selected.identity.nativeIdKind,
    hostId: selected.identity.hostId,
    homeScopeId: selected.identity.homeScopeId,
    origin: 'standalone', purpose: 'agent', originBinding: null, state: 'bound',
    identity: selected.identity,
    executionBinding: selected.executionBinding,
    conversationId: selected.conversationId,
    sessionId: 'session-linked',
    currentOwner: selected.executionBinding,
    ownerGeneration: 0,
  };
  const claims = {
    launchId: launch.launchId, runId: launch.runId, attemptId: launch.attemptId,
    provider: launch.provider, nativeIdKind: launch.nativeIdKind,
    hostId: launch.hostId, homeScopeId: launch.homeScopeId,
    origin: launch.origin, purpose: launch.purpose, originBinding: launch.originBinding,
  };
  const immutableExecutionClaims = {
    ...claims, identity: launch.identity, executionBinding: launch.executionBinding,
  };
  const scope = {
    provider: launch.provider, nativeIdKind: launch.nativeIdKind,
    hostId: launch.hostId, homeScopeId: launch.homeScopeId, connectionSlotId: 'source-slot',
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
  const input = [{ type: 'text', text: 'linked instruction', text_elements: [] }];
  const envelope = JSON.stringify({ schemaVersion: 1, mode: 'start', expectedTurnId: null, input });
  const ledger = createDelivery(questionLedger, 'instruction', {
    deliveryAttemptId: 'instruction-attempt',
    logicalMessageId: 'instruction-logical', revision: 3, payload: envelope,
  }, launch).ledger;
  const checkpoint = structuredClone(makeEmptyCheckpoint());
  checkpoint.schemaVersion = 2;
  checkpoint.revision = 9;
  checkpoint.ledger = structuredClone(ledger);
  checkpoint.ledger.revision = 11;
  checkpoint.registrations.conversations = [{
    conversationId: launch.conversationId, identity: launch.identity,
  }];
  checkpoint.registrations.executions = [{
    conversationId: launch.conversationId, executionId: launch.executionBinding.periodId,
    sessionId: launch.sessionId, state: 'active',
  }];
  checkpoint.registrations.launches = [{
    launchRef: launch.launchRef, claims, state: 'bound', identity: launch.identity,
    executionBinding: launch.executionBinding, conversationId: launch.conversationId,
    sessionId: launch.sessionId,
  }];
  checkpoint.registrations.runtimeLaunches = [{
    launchRef: launch.launchRef, claims: immutableExecutionClaims, state: 'bound',
    conversationId: launch.conversationId, sessionId: launch.sessionId,
    currentOwner: launch.executionBinding, ownerGeneration: 0,
  }];
  checkpoint.registrations.connections = [{ scope, generation: 1, state: 'active' }];
  checkpoint.registrations.actors = [{
    identity: launch.identity, periodId: launch.executionBinding.periodId,
    actor: launch.executionBinding.actor, contextId: 'source-context', launchRef: launch.launchRef,
    immutableExecutionClaims, connectionScope: scope, connectionGeneration: 1, state: 'active',
  }];
  checkpoint.registrations.incompleteConversationIds = [launch.conversationId];
  const instructionDelivery = ledger.deliveries.find((delivery) => delivery.kind === 'instruction');
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
  return {
    checkpoint: Buffer.from(JSON.stringify(checkpoint), 'utf8'),
    instructions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, instructions: [instruction] }), 'utf8'),
    questions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, questions: [selected] }), 'utf8'),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

test('empty first creation writes configured data slots before the anchor and opens the gate last', async () => {
  const configuredSlots = ['checkpoint', 'questions'];
  const memory = memoryPersistence(configuredSlots);
  const events = memory.events;
  let releaseCheckpoint;
  let releaseQuestions;
  const checkpointReady = deferred();
  const questionsReady = deferred();
  const writers = createWriters(configuredSlots, events, {
    prepare(slot) {
      if (slot === 'checkpoint') return checkpointReady.promise;
      return questionsReady.promise;
    },
  });
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence,
    writersBySlot: writers,
    events,
    configuredSlots,
  }));

  const started = coordinator.start();
  assert.equal(coordinator.start(), started);
  assert.equal(coordinator.canWrite(), false);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.filter((event) => event[0] === 'prepare').length, 2);
  assert.equal(coordinator.canWrite(), false);
  releaseCheckpoint = checkpointReady.resolve;
  releaseQuestions = questionsReady.resolve;
  releaseCheckpoint();
  assert.equal(coordinator.canWrite(), false);
  releaseQuestions();
  const ready = await started;

  assert.equal(ready.status, 'ready');
  assert.equal(coordinator.canWrite(), true);
  ready.snapshot.stores.questions = null;
  const repeated = await coordinator.start();
  assert.notEqual(repeated.snapshot.stores.questions, null);
  assert.notEqual(repeated.snapshot, ready.snapshot);
  const writes = events.filter((event) => event[0] === 'write-slot' || event[0] === 'write-anchor');
  assert.deepEqual(writes.map((event) => event[0] === 'write-slot' ? event[1] : 'anchor'), [
    'checkpoint', 'questions', 'anchor',
  ]);
  const stops = events.filter((event) => event[0] === 'stop').map((event) => event[1]);
  const drains = events.filter((event) => event[0] === 'drain').map((event) => event[1]);
  assert.deepEqual(stops, configuredSlots);
  assert.deepEqual(drains, configuredSlots);
  await coordinator.close();
  assert.equal(coordinator.canWrite(), false);
});

test('each writer receives its own full snapshot clone', async () => {
  const configuredSlots = ['checkpoint', 'questions'];
  const memory = memoryPersistence(configuredSlots);
  const events = memory.events;
  let secondSnapshot;
  const writers = createWriters(configuredSlots, events, {
    prepare(slot, snapshot) {
      if (slot === 'checkpoint') snapshot.stores.questions = null;
      else secondSnapshot = snapshot;
    },
  });
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence,
    writersBySlot: writers,
    events,
    configuredSlots,
  }));

  const ready = await coordinator.start();
  assert.notEqual(events.find((event) => event[0] === 'prepare' && event[1] === 'checkpoint')[2], secondSnapshot);
  assert.notEqual(secondSnapshot.stores.questions, null);
  assert.notEqual(ready.snapshot.stores.questions, null);
  assert.equal(coordinator.canWrite(), true);
  await coordinator.close();
});

test('a stop exception still stops and drains every writer without reading or writing storage', async () => {
  const configuredSlots = ['checkpoint', 'instructions', 'questions'];
  const memory = memoryPersistence(configuredSlots);
  const events = memory.events;
  const writers = createWriters(configuredSlots, events, {
    stop(slot) {
      if (slot === 'instructions') throw new Error('stop failed');
    },
  });
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence,
    writersBySlot: writers,
    events,
    configuredSlots,
  }));

  await assert.rejects(coordinator.start());
  assert.equal(coordinator.canWrite(), false);
  assert.equal(coordinator.status().state, 'blocked');
  assert.deepEqual(events.filter((event) => event[0] === 'stop').map((event) => event[1]),
    [...configuredSlots, ...configuredSlots]);
  assert.deepEqual(events.filter((event) => event[0] === 'drain').map((event) => event[1]),
    [...configuredSlots, ...configuredSlots]);
  assert.equal(events.some((event) => event[0].startsWith('read-') || event[0].startsWith('write-')), false);
  const eventCount = events.length;
  await assert.rejects(coordinator.start());
  assert.equal(events.length, eventCount);
  await assert.rejects(coordinator.close());
});

test('all asynchronous stops settle before draining, even when one stop rejects', async () => {
  const configuredSlots = ['checkpoint', 'instructions', 'questions'];
  const memory = memoryPersistence(configuredSlots);
  const events = memory.events;
  const stops = Object.fromEntries(configuredSlots.map((slot) => [slot, deferred()]));
  const writers = createWriters(configuredSlots, events, {
    stop(slot) {
      return stops[slot].promise;
    },
  });
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence,
    writersBySlot: writers,
    events,
    configuredSlots,
  }));

  const started = coordinator.start();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events.filter((event) => event[0] === 'stop').map((event) => event[1]), configuredSlots);
  assert.equal(events.some((event) => event[0] === 'drain'), false);
  stops.checkpoint.resolve();
  stops.instructions.reject(new Error('async stop failed'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(events.some((event) => event[0] === 'drain'), false);
  stops.questions.resolve();

  await assert.rejects(started);
  assert.deepEqual(events.filter((event) => event[0] === 'drain').map((event) => event[1]).slice(0, configuredSlots.length),
    configuredSlots);
  const initialStopIndexes = events.flatMap((event, index) => event[0] === 'stop' ? [index] : [])
    .slice(0, configuredSlots.length);
  const firstDrainIndex = events.findIndex((event) => event[0] === 'drain');
  assert.ok(initialStopIndexes.at(-1) < firstDrainIndex);
  assert.equal(events.some((event) => event[0].startsWith('read-') || event[0].startsWith('write-')), false);
  assert.equal(coordinator.canWrite(), false);
  await assert.rejects(coordinator.close());
});

test('close during drain keeps the gate closed and prevents later reads or writer preparation', async () => {
  const configuredSlots = ['questions'];
  const memory = memoryPersistence(configuredSlots);
  const events = memory.events;
  const drain = deferred();
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence,
    events,
    configuredSlots,
    hooks: { drain: () => drain.promise },
  }));

  const started = coordinator.start();
  assert.equal(coordinator.canWrite(), false);
  const closing = coordinator.close();
  assert.equal(coordinator.canWrite(), false);
  drain.resolve();
  await assert.rejects(started);
  await closing;
  assert.equal(events.some((event) => event[0].startsWith('read-') || event[0] === 'prepare'), false);
  assert.equal(coordinator.status().closed, true);
});

test('a drain failure is sticky and keeps storage unread', async () => {
  const configuredSlots = ['checkpoint', 'questions'];
  const memory = memoryPersistence(configuredSlots);
  const events = memory.events;
  const writers = createWriters(configuredSlots, events, {
    drain(slot) {
      if (slot === 'checkpoint') return Promise.reject(new Error('drain failed'));
    },
  });
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence,
    writersBySlot: writers,
    events,
    configuredSlots,
  }));

  await assert.rejects(coordinator.start());
  assert.equal(coordinator.status().state, 'blocked');
  assert.equal(events.some((event) => event[0].startsWith('read-') || event[0].startsWith('write-')), false);
  await assert.rejects(coordinator.close());
});

test('a malformed migration target size is rejected before it becomes a read limit', async () => {
  const sourceBytes = emptyLegacyQuestionBytes();
  const plan = planInitialReclamationMigration({
    configuredSlots: ['questions'],
    sourceBytesBySlot: { questions: sourceBytes },
    normalByteLimitsBySlot: { questions: NORMAL_LIMIT },
    storeId: OTHER_STORE_ID,
    operationId: OTHER_OPERATION_ID,
    startedAt: 9876,
  });
  const sources = structuredClone(plan.anchor.migration.sources);
  sources[0].targetSizeBytes = Number.MAX_SAFE_INTEGER;
  const malformedAnchor = normalizeQuestionReclamationAnchorV1Local({
    schemaVersion: 1,
    revision: plan.anchor.revision,
    storeId: plan.anchor.storeId,
    retiredQuestionPeriods: plan.anchor.retiredQuestionPeriods,
    migration: {
      ...plan.anchor.migration,
      sources,
    },
  });
  const memory = memoryPersistence(['questions'], {
    anchor: encodeQuestionReclamationAnchorV1Local(malformedAnchor).bytes,
    slots: { questions: sourceBytes },
  });
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence,
    events: memory.events,
    configuredSlots: ['questions'],
  }));

  await assert.rejects(coordinator.start());
  assert.equal(memory.events.some((event) => event[0] === 'read-slot'), false);
  assert.equal(coordinator.canWrite(), false);
  await coordinator.close();
});

test('a slot readback mismatch prevents the initial anchor from being written', async () => {
  const configuredSlots = ['questions'];
  const memory = memoryPersistence(configuredSlots);
  const originalRead = memory.persistence.readSlotBytes;
  let slotReadCount = 0;
  memory.persistence.readSlotBytes = async (slot, maximumBytes) => {
    const bytes = await originalRead(slot, maximumBytes);
    slotReadCount += 1;
    if (slotReadCount === 3 && bytes !== null) return Buffer.from(`${bytes.toString('utf8')} `, 'utf8');
    return bytes;
  };
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence,
    events: memory.events,
    configuredSlots,
  }));

  await assert.rejects(coordinator.start());
  assert.equal(memory.data.anchor, null);
  assert.equal(coordinator.status().state, 'blocked');
  assert.equal(memory.events.some((event) => event[0] === 'prepare'), false);
  await coordinator.close();
});

test('a bridge lease resize failure leaves the completed manifest and old lease intact', async () => {
  const configuredSlots = ['questions'];
  const memory = memoryPersistence(configuredSlots, { slots: { questions: emptyLegacyQuestionBytes() } });
  const events = memory.events;
  let reservedBytes = 0;
  let initiallyAcquiredBytes = 0;
  let released = false;
  let resizeCalls = 0;
  const lease = {
    resize() {
      resizeCalls += 1;
      throw Object.assign(new RangeError('reservation unavailable'), { code: 'reclamation_capacity_exceeded' });
    },
    release() {
      if (released) return false;
      released = true;
      reservedBytes = 0;
      return true;
    },
    status() {
      return { bytes: reservedBytes, released };
    },
  };
  const capacityBudget = {
    acquire(bytes) {
      reservedBytes = bytes;
      initiallyAcquiredBytes = bytes;
      return lease;
    },
    status() {
      return { maxAdditionalBytes: 1_000_000_000, reservedBytes, availableBytes: 0, activeLeaseCount: 1 };
    },
  };
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence,
    events,
    configuredSlots,
    capacityBudget,
  }));
  await assert.rejects(coordinator.start());
  assert.equal(resizeCalls, 1);
  assert.equal(lease.status().bytes, initiallyAcquiredBytes);
  assert.equal(coordinator.canWrite(), false);
  assert.equal(coordinator.status().state, 'blocked');
  const savedAnchor = JSON.parse(memory.data.anchor.toString('utf8'));
  assert.equal(savedAnchor.migration.phase, 'completed');
  assert.equal(events.some((event) => event[0] === 'prepare'), false);
  await coordinator.close();
  assert.equal(lease.status().released, true);
});

test('an undersized capacity budget blocks migration before any source is replaced', async () => {
  const configuredSlots = ['questions'];
  const sourceBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    revision: 7,
    questions: [legacyQuestion('claude')],
  }), 'utf8');
  const normalByteLimitsBySlot = { questions: sourceBytes.length };
  const plan = planInitialReclamationMigration({
    configuredSlots,
    sourceBytesBySlot: { questions: sourceBytes },
    normalByteLimitsBySlot,
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: 1234,
  });
  assert.ok(plan.slots.questions.grant.maxExtraBytes > 0);
  const memory = memoryPersistence(configuredSlots, { slots: { questions: sourceBytes } });
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence,
    events: memory.events,
    configuredSlots,
    normalByteLimitsBySlot,
    capacityBytes: 1,
  }));

  await assert.rejects(coordinator.start(), /reclamation_capacity_exceeded/);
  assert.equal(coordinator.status().state, 'blocked');
  assert.equal(coordinator.canWrite(), false);
  assert.equal(memory.events.filter((event) => event[0] === 'write-anchor' || event[0] === 'write-slot').length, 0);
  assert.deepEqual(memory.data.slots.questions, sourceBytes);
  assert.equal(memory.data.anchor, null);
  await coordinator.close();
});

test('null-anchor readback failure retains the bridge lease and keeps the gate closed', async () => {
  const configuredSlots = ['questions'];
  const sourceBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    revision: 7,
    questions: [legacyQuestion('codex')],
  }), 'utf8');
  const normalByteLimitsBySlot = { questions: sourceBytes.length };

  async function migrate({ failNullReadback }) {
    let corrupted = false;
    const memory = memoryPersistence(configuredSlots, { slots: { questions: sourceBytes } }, {
      readAnchor({ bytes }) {
        if (!failNullReadback || corrupted || bytes === null) return undefined;
        const parsed = JSON.parse(bytes.toString('utf8'));
        if (parsed.migration !== null) return undefined;
        corrupted = true;
        return Buffer.from('invalid-null-anchor-readback');
      },
    });
    const tracked = trackedCapacityBudget();
    const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
      persistence: memory.persistence,
      events: memory.events,
      configuredSlots,
      normalByteLimitsBySlot,
      capacityBudget: tracked.capacityBudget,
    }));
    if (failNullReadback) {
      await assert.rejects(coordinator.start());
      const stateAtFailure = coordinator.status();
      await coordinator.close();
      return { memory, history: tracked.history, stateAtFailure };
    }
    const ready = await coordinator.start();
    const stateAtReady = coordinator.status();
    await coordinator.close();
    return { memory, history: tracked.history, stateAtReady, ready };
  }

  const completed = await migrate({ failNullReadback: false });
  const postReservationBytes = completed.history.resized.at(-1);
  const bridgeReservationBytes = completed.history.resized.at(-2);
  assert.equal(completed.history.resized.length, 2);
  assert.ok(bridgeReservationBytes >= postReservationBytes);
  assert.equal(completed.stateAtReady.lease.bytes, postReservationBytes);
  assert.equal(completed.ready.snapshot.anchor.migration, null);

  const failedClear = await migrate({ failNullReadback: true });
  assert.equal(failedClear.history.resized.length, 1);
  assert.equal(failedClear.stateAtFailure.lease.bytes, failedClear.history.resized[0]);
  assert.ok(failedClear.stateAtFailure.lease.bytes >= postReservationBytes);
  assert.equal(failedClear.stateAtFailure.canWrite, false);
  assert.equal(failedClear.memory.data.anchor &&
    JSON.parse(failedClear.memory.data.anchor.toString('utf8')).migration, null);
});

test('a writer prepare failure stops all writers again and never opens the shared gate', async () => {
  const configuredSlots = ['checkpoint', 'questions'];
  const memory = memoryPersistence(configuredSlots);
  const events = memory.events;
  const writers = createWriters(configuredSlots, events, {
    prepare(slot) {
      if (slot === 'checkpoint') throw new Error('resume failed');
    },
  });
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence,
    writersBySlot: writers,
    events,
    configuredSlots,
  }));

  await assert.rejects(coordinator.start());
  assert.equal(coordinator.canWrite(), false);
  assert.equal(coordinator.status().state, 'blocked');
  assert.deepEqual(events.filter((event) => event[0] === 'stop').map((event) => event[1]),
    [...configuredSlots, ...configuredSlots]);
  assert.equal(events.some((event) => event[0] === 'prepare' && event[1] === 'questions'), true);
  await coordinator.close();
});

test('legacy source recovery preserves the fixed operation and timestamp through a prepared-prefix restart', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'reclamation-coordinator-'));
  t.after(async () => fs.rm(tempRoot, { recursive: true, force: true }));
  const anchorPath = path.join(tempRoot, 'question-reclamation-anchor.json');
  const questionPath = path.join(tempRoot, 'questions.json');
  const sourceBytes = emptyLegacyQuestionBytes();
  const plan = planInitialReclamationMigration({
    configuredSlots: ['questions'],
    sourceBytesBySlot: { questions: sourceBytes },
    normalByteLimitsBySlot: { questions: NORMAL_LIMIT },
    storeId: OTHER_STORE_ID,
    operationId: OTHER_OPERATION_ID,
    startedAt: 9876,
  });
  await fs.writeFile(anchorPath, plan.anchorEncoded.bytes);
  await fs.writeFile(questionPath, sourceBytes);
  const persistence = createReclamationPersistence({
    anchorPath,
    slotPathsBySlot: { questions: questionPath },
  });
  const events = [];
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence,
    events,
    configuredSlots: ['questions'],
  }));

  const ready = await coordinator.start();
  assert.equal(ready.status, 'ready');
  assert.equal(ready.snapshot.anchor.storeId, OTHER_STORE_ID);
  assert.equal(ready.snapshot.anchor.migration, null);
  assert.equal(ready.snapshot.stores.questions.revision, plan.slots.questions.target.snapshot.revision);
  assert.equal(coordinator.status().state, 'ready');
  await coordinator.close();

  const savedAnchorBytes = await fs.readFile(anchorPath);
  assert.equal(decodeSourceBytes(savedAnchorBytes, NORMAL_LIMIT).value.migration, null);
});

test('both providers complete a linked three-slot migration with fixed grants at source-sized limits', async () => {
  const configuredSlots = ['checkpoint', 'instructions', 'questions'];
  for (const provider of ['claude', 'codex']) {
    const sourceBytesBySlot = threeSlotLegacySources(provider);
    const normalByteLimitsBySlot = Object.fromEntries(configuredSlots.map((slot) => [
      slot, sourceBytesBySlot[slot].length,
    ]));
    const expectedPlan = planInitialReclamationMigration({
      configuredSlots,
      sourceBytesBySlot,
      normalByteLimitsBySlot,
      storeId: STORE_ID,
      operationId: OPERATION_ID,
      startedAt: 1234,
    });
    for (const slot of configuredSlots) assert.ok(expectedPlan.slots[slot].grant.maxExtraBytes > 0);

    const memory = memoryPersistence(configuredSlots, { slots: sourceBytesBySlot });
    const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
      persistence: memory.persistence,
      events: memory.events,
      configuredSlots,
      normalByteLimitsBySlot,
    }));
    const ready = await coordinator.start();

    assert.equal(ready.status, 'ready');
    assert.equal(ready.snapshot.anchor.migration, null);
    assert.equal(ready.snapshot.stores.questions.questions.length, 1);
    assert.equal(ready.snapshot.stores.checkpoint.ledger.deliveries.length, 2);
    assert.equal(ready.snapshot.stores.instructions.instructions.length, 1);
    for (const slot of configuredSlots) {
      assert.deepEqual(ready.snapshot.stores[slot].migrationAllowance, expectedPlan.slots[slot].grant);
      const target = expectedPlan.slots[slot].target.encoded.bytes;
      assert.deepEqual(memory.data.slots[slot], target);
    }
    await coordinator.close();
  }
});

test('an error after slot rename blocks this instance and the next instance resumes the exact prefix', async (t) => {
  const tempRoot = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'reclamation-prefix-restart-'));
  t.after(async () => fs.rm(tempRoot, { recursive: true, force: true }));
  const anchorPath = path.join(tempRoot, 'question-reclamation-anchor.json');
  const questionPath = path.join(tempRoot, 'questions.json');
  const sourceBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    revision: 7,
    questions: [legacyQuestion('codex')],
  }), 'utf8');
  const expectedPlan = planInitialReclamationMigration({
    configuredSlots: ['questions'],
    sourceBytesBySlot: { questions: sourceBytes },
    normalByteLimitsBySlot: { questions: sourceBytes.length },
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: 1234,
  });
  assert.ok(expectedPlan.slots.questions.grant.maxExtraBytes > 0);
  await fs.writeFile(questionPath, sourceBytes);
  let failedAfterRename = false;
  const firstPersistence = createReclamationPersistence({
    anchorPath,
    slotPathsBySlot: { questions: questionPath },
    atomicWriteBytes: async (targetPath, bytes, fileSystem) => {
      const temporaryPath = path.join(tempRoot, `.coordinator-${randomUUID()}.tmp`);
      const handle = await fileSystem.open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(bytes);
      await handle.close();
      await fileSystem.rename(temporaryPath, targetPath);
      if (targetPath === questionPath && !failedAfterRename) {
        failedAfterRename = true;
        throw Object.assign(new Error('rename result is uncertain'), { code: 'EIO' });
      }
    },
  });
  const firstEvents = [];
  const firstCoordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: firstPersistence,
    events: firstEvents,
    configuredSlots: ['questions'],
    normalByteLimitsBySlot: { questions: sourceBytes.length },
  }));

  await assert.rejects(firstCoordinator.start());
  assert.equal(firstCoordinator.canWrite(), false);
  const interruptedAnchor = decodeSourceBytes(await fs.readFile(anchorPath), NORMAL_LIMIT).value;
  const installedQuestion = decodeSourceBytes(await fs.readFile(questionPath), MAX_SOURCE_BYTES).value;
  assert.equal(interruptedAnchor.migration.phase, 'installing');
  assert.equal(installedQuestion.schemaVersion, 2);
  assert.equal(firstEvents.some((event) => event[0] === 'prepare'), false);
  await firstCoordinator.close();

  const secondPersistence = createReclamationPersistence({
    anchorPath,
    slotPathsBySlot: { questions: questionPath },
  });
  const secondEvents = [];
  const secondCoordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: secondPersistence,
    events: secondEvents,
    configuredSlots: ['questions'],
    normalByteLimitsBySlot: { questions: sourceBytes.length },
  }));
  const ready = await secondCoordinator.start();
  assert.equal(ready.snapshot.anchor.migration, null);
  assert.equal(ready.snapshot.stores.questions.questions[0].quarantinedAt, 1234);
  assert.equal(ready.snapshot.stores.questions.migrationAllowance.operationId, OPERATION_ID);
  await secondCoordinator.close();
});

test('a new instance blocks on partial empty initialization without its final anchor', async () => {
  const configuredSlots = ['checkpoint', 'questions'];
  let failedAfterFirstSlot = false;
  const initial = memoryPersistence(configuredSlots, {}, {
    afterWriteSlot({ slot }) {
      if (!failedAfterFirstSlot && slot === 'checkpoint') {
        failedAfterFirstSlot = true;
        throw Object.assign(new Error('interrupted empty initialization'), { code: 'EIO' });
      }
    },
  });
  const first = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: initial.persistence,
    events: initial.events,
    configuredSlots,
  }));
  await assert.rejects(first.start());
  assert.equal(first.canWrite(), false);
  assert.equal(initial.data.anchor, null);
  assert.notEqual(initial.data.slots.checkpoint, null);
  assert.equal(initial.data.slots.questions, null);
  await first.close();

  const recovery = memoryPersistence(configuredSlots, { slots: initial.data.slots });
  const second = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: recovery.persistence,
    events: recovery.events,
    configuredSlots,
  }));
  await assert.rejects(second.start());
  assert.equal(second.canWrite(), false);
  assert.equal(second.status().state, 'blocked');
  assert.equal(recovery.data.anchor, null);
  assert.equal(recovery.events.some((event) => event[0].startsWith('write-') || event[0] === 'prepare'), false);
  await second.close();
});

test('a normal anchor requires every configured slot before writers resume', async () => {
  const configuredSlots = ['questions'];
  const emptyPlan = planInitialReclamationMigration({
    configuredSlots,
    sourceBytesBySlot: { questions: null },
    normalByteLimitsBySlot: { questions: NORMAL_LIMIT },
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: 1234,
  });
  const memory = memoryPersistence(configuredSlots, { anchor: emptyPlan.anchorEncoded.bytes });
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence,
    events: memory.events,
    configuredSlots,
  }));

  await assert.rejects(coordinator.start(), /reclamation_missing_mandatory_slot/);
  assert.equal(coordinator.canWrite(), false);
  assert.equal(memory.events.some((event) => event[0] === 'prepare'), false);
  await coordinator.close();
});

test('a normal anchor with a mismatched store ID cannot resume its journal', async () => {
  const configuredSlots = ['questions'];
  const plan = planInitialReclamationMigration({
    configuredSlots,
    sourceBytesBySlot: { questions: null },
    normalByteLimitsBySlot: { questions: NORMAL_LIMIT },
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: 1234,
  });
  const wrongAnchor = normalizeQuestionReclamationAnchorV1Local({
    schemaVersion: plan.anchor.schemaVersion,
    revision: plan.anchor.revision,
    storeId: OTHER_STORE_ID,
    retiredQuestionPeriods: plan.anchor.retiredQuestionPeriods,
    migration: null,
  });
  const memory = memoryPersistence(configuredSlots, {
    anchor: encodeQuestionReclamationAnchorV1Local(wrongAnchor).bytes,
    slots: { questions: plan.slots.questions.target.encoded.bytes },
  });
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence,
    events: memory.events,
    configuredSlots,
  }));

  await assert.rejects(coordinator.start());
  assert.equal(coordinator.canWrite(), false);
  assert.equal(memory.events.some((event) => event[0] === 'prepare'), false);
  await coordinator.close();
});

test('corrupt normal anchors and source bytes outside a migration prefix remain blocked', async () => {
  const configuredSlots = ['questions'];
  const emptyPlan = planInitialReclamationMigration({
    configuredSlots,
    sourceBytesBySlot: { questions: null },
    normalByteLimitsBySlot: { questions: NORMAL_LIMIT },
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: 1234,
  });
  const corrupt = memoryPersistence(configuredSlots, {
    anchor: Buffer.from('not-json'),
    slots: { questions: emptyPlan.slots.questions.target.encoded.bytes },
  });
  const corruptCoordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: corrupt.persistence,
    events: corrupt.events,
    configuredSlots,
  }));
  await assert.rejects(corruptCoordinator.start());
  assert.equal(corruptCoordinator.canWrite(), false);
  assert.equal(corrupt.events.some((event) => event[0] === 'prepare'), false);
  await corruptCoordinator.close();

  const sourceBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    revision: 7,
    questions: [legacyQuestion('claude')],
  }), 'utf8');
  const migration = planInitialReclamationMigration({
    configuredSlots,
    sourceBytesBySlot: { questions: sourceBytes },
    normalByteLimitsBySlot: { questions: sourceBytes.length },
    storeId: STORE_ID,
    operationId: OPERATION_ID,
    startedAt: 1234,
  });
  const alteredSource = Buffer.from(sourceBytes.toString('utf8').replace('"revision":7', '"revision":8'), 'utf8');
  assert.equal(alteredSource.length, sourceBytes.length);
  const invalidPrefix = memoryPersistence(configuredSlots, {
    anchor: migration.anchorEncoded.bytes,
    slots: { questions: alteredSource },
  });
  const prefixCoordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: invalidPrefix.persistence,
    events: invalidPrefix.events,
    configuredSlots,
    normalByteLimitsBySlot: { questions: sourceBytes.length },
  }));
  await assert.rejects(prefixCoordinator.start());
  assert.equal(prefixCoordinator.canWrite(), false);
  assert.equal(invalidPrefix.events.some((event) => event[0] === 'write-anchor' || event[0] === 'write-slot'), false);
  assert.equal(invalidPrefix.events.some((event) => event[0] === 'prepare'), false);
  await prefixCoordinator.close();
});

test('every durable anchor and slot boundary fails closed and recovers only the persisted prefix', async () => {
  const questionSourceBytes = Buffer.from(JSON.stringify({
    schemaVersion: 1,
    revision: 7,
    questions: [legacyQuestion('claude')],
  }), 'utf8');
  const questionOnly = {
    configuredSlots: ['questions'],
    sourceBytesBySlot: { questions: questionSourceBytes },
    normalByteLimitsBySlot: { questions: questionSourceBytes.length },
  };
  const linkedSlots = ['checkpoint', 'instructions', 'questions'];
  const linkedSources = threeSlotLegacySources('claude');
  const linkedSourceSized = {
    configuredSlots: linkedSlots,
    sourceBytesBySlot: linkedSources,
    normalByteLimitsBySlot: Object.fromEntries(linkedSlots.map((slot) => [slot, linkedSources[slot].length])),
  };

  const failWith = () => Object.assign(new Error('injected persistence fault'), { code: 'EIO' });
  function anchorFault(phase, timing, corruptReadback = false) {
    let injected = false;
    let corruptNextRead = false;
    const matchesPhase = (bytes) => {
      const parsed = JSON.parse(bytes.toString('utf8'));
      return (parsed.migration === null ? 'null' : parsed.migration?.phase) === phase;
    };
    const hooks = {
      beforeWriteAnchor({ bytes }) {
        if (!injected && timing === 'before' && matchesPhase(bytes)) {
          injected = true;
          throw failWith();
        }
      },
      afterWriteAnchor({ bytes }) {
        if (!injected && timing === 'after' && matchesPhase(bytes)) {
          injected = true;
          throw failWith();
        }
        if (!injected && corruptReadback && matchesPhase(bytes)) {
          injected = true;
          corruptNextRead = true;
        }
      },
      readAnchor({ bytes }) {
        if (!corruptNextRead) return undefined;
        corruptNextRead = false;
        return Buffer.from('not-json');
      },
    };
    return hooks;
  }
  function slotFault(slot, timing, corruptReadback = false) {
    let injected = false;
    let corruptNextRead = false;
    return {
      beforeWriteSlot({ slot: writtenSlot }) {
        if (!injected && timing === 'before' && writtenSlot === slot) {
          injected = true;
          throw failWith();
        }
      },
      afterWriteSlot({ slot: writtenSlot }) {
        if (!injected && timing === 'after' && writtenSlot === slot) {
          injected = true;
          throw failWith();
        }
        if (!injected && corruptReadback && writtenSlot === slot) {
          injected = true;
          corruptNextRead = true;
        }
      },
      readSlot({ slot: readSlotName }) {
        if (!corruptNextRead || readSlotName !== slot) return undefined;
        corruptNextRead = false;
        return Buffer.from('not-json');
      },
    };
  }

  const cases = [
    ...['prepared', 'guarded', 'installing', 'completed', 'null'].flatMap((phase) => [
      { name: `anchor ${phase} before commit`, context: questionOnly, fault: anchorFault(phase, 'before') },
      { name: `anchor ${phase} after commit`, context: questionOnly, fault: anchorFault(phase, 'after') },
      { name: `anchor ${phase} readback`, context: questionOnly, fault: anchorFault(phase, 'none', true) },
    ]),
    ...linkedSlots.flatMap((slot) => [
      { name: `${slot} slot before commit`, context: linkedSourceSized, fault: slotFault(slot, 'before') },
      { name: `${slot} slot after commit`, context: linkedSourceSized, fault: slotFault(slot, 'after') },
      { name: `${slot} target readback`, context: linkedSourceSized, fault: slotFault(slot, 'none', true) },
    ]),
  ];

  for (const fixture of cases) {
    const { configuredSlots, sourceBytesBySlot, normalByteLimitsBySlot } = fixture.context;
    const fixedPlan = planInitialReclamationMigration({
      configuredSlots,
      sourceBytesBySlot,
      normalByteLimitsBySlot,
      storeId: STORE_ID,
      operationId: OPERATION_ID,
      startedAt: 1234,
    });
    for (const slot of configuredSlots) assert.ok(fixedPlan.slots[slot].grant.maxExtraBytes > 0);
    const first = memoryPersistence(configuredSlots, { slots: sourceBytesBySlot }, fixture.fault);
    const firstCoordinator = createReclamationMigrationCoordinator(coordinatorOptions({
      persistence: first.persistence,
      events: first.events,
      configuredSlots,
      normalByteLimitsBySlot,
    }));
    await assert.rejects(firstCoordinator.start(), fixture.name);
    assert.equal(firstCoordinator.canWrite(), false, fixture.name);
    assert.equal(firstCoordinator.status().state, 'blocked', fixture.name);
    assert.equal(first.events.some((event) => event[0] === 'prepare'), false, fixture.name);
    const failedEventCount = first.events.length;
    await assert.rejects(firstCoordinator.start(), fixture.name);
    assert.equal(first.events.length, failedEventCount, fixture.name);

    const storedAnchor = first.data.anchor === null ? null : JSON.parse(first.data.anchor.toString('utf8'));
    const targetVersions = { checkpoint: 3, instructions: 2, questions: 2 };
    const sourceWasDurablyFixed = (storedAnchor !== null && storedAnchor.migration !== null) ||
      configuredSlots.some((slot) => first.data.slots[slot] !== null &&
        JSON.parse(first.data.slots[slot].toString('utf8')).schemaVersion === targetVersions[slot]);
    const expectedOperationId = sourceWasDurablyFixed ? OPERATION_ID : OTHER_OPERATION_ID;
    const expectedStartedAt = sourceWasDurablyFixed ? 1234 : 98765;
    if (sourceWasDurablyFixed && storedAnchor?.migration) {
      assert.equal(storedAnchor.migration.operationId, expectedOperationId, fixture.name);
      assert.equal(storedAnchor.migration.startedAt, expectedStartedAt, fixture.name);
    }
    await firstCoordinator.close();

    const recovered = memoryPersistence(configuredSlots, {
      anchor: first.data.anchor,
      slots: Object.fromEntries(configuredSlots.map((slot) => [slot, first.data.slots[slot]])),
    });
    const recoveryOptions = coordinatorOptions({
      persistence: recovered.persistence,
      events: recovered.events,
      configuredSlots,
      normalByteLimitsBySlot,
    });
    recoveryOptions.createStoreId = () => OTHER_STORE_ID;
    recoveryOptions.createOperationId = () => OTHER_OPERATION_ID;
    recoveryOptions.now = () => 98765;
    const recoveryCoordinator = createReclamationMigrationCoordinator(recoveryOptions);
    const ready = await recoveryCoordinator.start();
    assert.equal(ready.snapshot.anchor.migration, null, fixture.name);
    assert.equal(ready.snapshot.stores.questions.questions[0].quarantinedAt, expectedStartedAt, fixture.name);
    assert.equal(ready.snapshot.stores.questions.migrationAllowance.operationId, expectedOperationId, fixture.name);
    await recoveryCoordinator.close();
  }
});

test('ID-F209-O01 managed coordinator close never releases shared persistence or capacity', async () => {
  const { getReclamationMigrationCoordinatorControl } = require('../src/server/reclamation-migration-coordinator');
  const slots = ['questions'];
  const memory = memoryPersistence(slots);
  const tracked = trackedCapacityBudget();
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence, configuredSlots: slots, events: memory.events, capacityBudget: tracked.capacityBudget,
  }));
  const owner = getReclamationMigrationCoordinatorControl(coordinator).bindOwner();
  assert.ok(owner);
  await coordinator.start();
  await coordinator.close();
  assert.equal(memory.data.closed, false);
  assert.equal(tracked.history.released, 0);
  assert.deepEqual(owner.retentionReasons(), []);
  assert.equal(coordinator.canWrite(), false);
});

test('ID-F209-O01 managed coordinator close during startup never reopens its gate or releases downstream ownership', async () => {
  const { getReclamationMigrationCoordinatorControl } = require('../src/server/reclamation-migration-coordinator');
  const slots = ['questions'];
  const memory = memoryPersistence(slots);
  const entered = deferred();
  const barrier = deferred();
  const coordinator = createReclamationMigrationCoordinator(coordinatorOptions({
    persistence: memory.persistence, configuredSlots: slots, events: memory.events,
    hooks: { drain() { entered.resolve(); return barrier.promise; } },
  }));
  const owner = getReclamationMigrationCoordinatorControl(coordinator).bindOwner();
  const started = coordinator.start();
  started.catch(() => {});
  let closed;
  try {
    await entered.promise;
    closed = coordinator.close();
    assert.equal(coordinator.canWrite(), false);
    barrier.resolve();
    await assert.rejects(started);
    await closed;
    assert.equal(coordinator.canWrite(), false);
    assert.equal(memory.data.closed, false);
    assert.deepEqual(owner.retentionReasons(), []);
    assert.equal(memory.events.some(event => event[0].startsWith('read-') || event[0].startsWith('write-')), false);
  } finally { barrier.resolve(); await started.catch(() => {}); await closed; }
});
