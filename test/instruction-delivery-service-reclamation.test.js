'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { createDelivery, createEmptyLedger } = require('../src/server/delivery-ledger');
const { createInstructionEnvelope } = require('../src/server/instruction-envelope');
const { createInstructionDeliveryJournal } = require('../src/server/instruction-delivery-journal');
const { createInstructionDeliveryService } = require('../src/server/instruction-delivery-service');
const { sourceProjectionFromLaunch } = require('../src/server/instruction-delivery-journal');
const { normalizeInstructionRecordV2Local } = require('../src/server/delivery-reclamation-codec');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const BYTE_LIMIT = 16_777_216;

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

function emptyJournal() {
  return {
    schemaVersion: 2, revision: 0, storeId: STORE_ID, migrationAllowance: null, instructions: [],
  };
}

function creatingJournal() {
  const execution = launch();
  const source = sourceProjectionFromLaunch(execution);
  const envelope = createInstructionEnvelope({
    mode: 'start', expectedTurnId: null, text: 'Continue the work',
  });
  const record = normalizeInstructionRecordV2Local({
    recordType: 'detail', deliveryAttemptId: input.deliveryAttemptId,
    launchRef: source.launchRef, logicalMessageId: input.logicalMessageId, revision: input.revision,
    source, envelope: envelope.serialized, envelopeDigest: envelope.envelopeDigest,
    nativeContentDigest: envelope.nativeContentDigest, createdAt: 1_000,
    deliveryCreationState: 'creating', reclamation: null,
  });
  return {
    schemaVersion: 2, revision: 2, storeId: STORE_ID, migrationAllowance: null, instructions: [record],
  };
}

function createBackend(initial = emptyJournal()) {
  let value = structuredClone(initial);
  let writable = true;
  let nextResumeBarrier = null;
  let saveCount = 0;
  return {
    slot: 'instructions', normalByteLimit: BYTE_LIMIT,
    canWrite() { return writable; },
    setWritable(next) { writable = next; },
    async load() { return structuredClone(value); },
    async save(candidate) {
      saveCount += 1;
      value = structuredClone(candidate);
      return structuredClone(value);
    },
    async prepareResume(fullSnapshot) {
      const barrier = nextResumeBarrier;
      nextResumeBarrier = null;
      if (barrier) {
        barrier.started();
        await barrier.wait;
      }
      value = structuredClone(fullSnapshot.stores.instructions);
    },
    async flush() {},
    async close() {},
    get value() { return structuredClone(value); },
    get saveCount() { return saveCount; },
    pauseNextResume() {
      let signalStarted;
      let release;
      const started = new Promise((resolve) => { signalStarted = resolve; });
      const wait = new Promise((resolve) => { release = resolve; });
      nextResumeBarrier = { started: signalStarted, wait };
      return { started, release };
    },
  };
}

function createHarness(initial = emptyJournal(), options = {}) {
  const execution = launch();
  const backend = createBackend(initial);
  const periodGate = { capture() { return {}; }, assertCurrent() {} };
  const journal = createInstructionDeliveryJournal({ reclamation: { backend, periodGate } });
  const deliveries = new Map();
  let createCount = 0;
  let getCount = 0;
  const deliveryStore = {
    ready: Promise.resolve(),
    async createInstructionDelivery(input) {
      createCount += 1;
      if (options.createFailure === 'before') throw options.createError;
      const result = createDelivery(createEmptyLedger(), 'instruction', {
        deliveryAttemptId: input.deliveryAttemptId,
        logicalMessageId: input.logicalMessageId,
        revision: input.revision,
        payload: input.payload,
      }, execution);
      deliveries.set(input.deliveryAttemptId, result.delivery);
      if (options.createFailure === 'after') throw options.createError;
      return result.delivery;
    },
    async get(id) {
      getCount += 1;
      if (options.getError && getCount >= (options.getErrorOnCall ?? 1)) throw options.getError;
      return deliveries.get(id) || null;
    },
    snapshot() { return createEmptyLedger(); },
    async flush() {},
  };
  const service = createInstructionDeliveryService({
    journal, deliveryStore, providerInstructionAdapters: {},
    launchRegistry: { get(ref) { return ref === execution.launchRef ? structuredClone(execution) : null; } },
    now: () => 1_000,
  });
  const fullSnapshot = { anchor: {}, stores: { instructions: initial } };
  return { backend, journal, service, fullSnapshot, createError: options.createError,
    get createCount() { return createCount; } };
}

const input = {
  deliveryAttemptId: 'delivery-attempt-1', launchRef: 'launch-ref',
  logicalMessageId: 'logical-message-1', revision: 1,
  text: 'Continue the work', mode: 'start', expectedTurnId: null,
};

test('opt-in instruction creation persists not-created, creating, and checkpointed before returning', async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.close());
  harness.backend.setWritable(false);

  await assert.rejects(harness.service.create(input),
    (error) => error.code === 'reclamation_writer_cold');
  harness.backend.setWritable(true);
  await harness.service.reclamationWriter.prepareResume(harness.fullSnapshot);
  await harness.service.ready();

  const created = await harness.service.create(input);
  assert.equal(created.outcome, 'created');
  assert.equal(created.delivery.kind, 'instruction');
  assert.equal(harness.createCount, 1);
  assert.deepEqual(harness.backend.value.instructions.map((record) => record.deliveryCreationState),
    ['checkpointed']);
  assert.equal(harness.backend.value.revision, 3);

  const replay = await harness.service.create(input);
  assert.equal(replay.outcome, 'existing');
  assert.equal(harness.createCount, 1);
});

test('a failed reclamation create recovers only a fully correlated checkpointed delivery', async (t) => {
  const createError = Object.assign(new Error('adapter create failed after checkpoint'), {
    code: 'adapter_create_failed',
  });
  const harness = createHarness(emptyJournal(), { createFailure: 'after', createError });
  t.after(() => harness.service.close());
  await harness.service.reclamationWriter.prepareResume(harness.fullSnapshot);
  await harness.service.ready();

  const recovered = await harness.service.create(input);
  assert.equal(recovered.outcome, 'created');
  assert.equal(recovered.delivery.deliveryAttemptId, input.deliveryAttemptId);
  assert.equal(harness.backend.value.instructions[0].deliveryCreationState, 'checkpointed');
  assert.equal(harness.createCount, 1);

  const replay = await harness.service.create(input);
  assert.equal(replay.outcome, 'existing');
  assert.equal(harness.createCount, 1);
});

test('closing during instruction resume cannot reopen the service', async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.close());
  const barrier = harness.backend.pauseNextResume();
  const pending = harness.service.reclamationWriter.prepareResume(harness.fullSnapshot);
  await barrier.started;
  await harness.service.close();
  barrier.release();

  await assert.rejects(pending, (error) => error.code === 'instruction_service_closed');
  assert.equal(harness.backend.saveCount, 0);
  assert.equal(harness.createCount, 0);
  await assert.rejects(harness.service.dashboardSnapshot(),
    (error) => error.code === 'reclamation_writer_cold');
  await assert.rejects(harness.service.create(input),
    (error) => error.code === 'reclamation_writer_cold');
  assert.equal(harness.backend.saveCount, 0);
  assert.equal(harness.createCount, 0);
});

test('an unconfirmed reclamation create retains creating and rejects same-attempt retry', async (t) => {
  const createError = Object.assign(new Error('adapter create failed before checkpoint'), {
    code: 'adapter_create_failed',
  });
  const cases = [
    { label: 'missing delivery', options: { createFailure: 'before', createError } },
    { label: 'failed delivery lookup', options: {
      createFailure: 'before', createError,
      getErrorOnCall: 2,
      getError: Object.assign(new Error('delivery lookup failed'), { code: 'delivery_lookup_failed' }),
    } },
  ];
  for (const item of cases) {
    await t.test(item.label, async (subtest) => {
      const harness = createHarness(emptyJournal(), item.options);
      subtest.after(() => harness.service.close());
      await harness.service.reclamationWriter.prepareResume(harness.fullSnapshot);
      await harness.service.ready();

      await assert.rejects(harness.service.create(input), (error) => error === createError);
      assert.equal(harness.backend.value.instructions[0].deliveryCreationState, 'creating');
      assert.equal(harness.createCount, 1);
      await assert.rejects(harness.service.create(input),
        (error) => error.code === 'instruction_recreation_forbidden');
      assert.equal(harness.createCount, 1);
    });
  }
});

test('instruction queue checks coordinator writability before admission and again at dequeue', async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.close());
  await harness.service.reclamationWriter.prepareResume(harness.fullSnapshot);
  await harness.service.ready();

  harness.backend.setWritable(false);
  await assert.rejects(harness.service.create(input),
    (error) => error.code === 'reclamation_service_blocked');

  harness.backend.setWritable(true);
  const queued = harness.service.create(input);
  harness.backend.setWritable(false);
  await assert.rejects(queued, (error) => error.code === 'reclamation_service_blocked');

  harness.backend.setWritable(true);
  const created = await harness.service.create(input);
  assert.equal(created.outcome, 'created');
  assert.equal(harness.createCount, 1);
});

test('instruction queue rejects while writer preparation has not made the coordinator writable', async (t) => {
  const harness = createHarness();
  t.after(() => harness.service.close());
  await harness.service.reclamationWriter.prepareResume(harness.fullSnapshot);
  harness.backend.setWritable(false);

  await assert.rejects(harness.service.create(input),
    (error) => error.code === 'reclamation_service_blocked');
  assert.equal(harness.createCount, 0);
});

test('an installed creating instruction is blocked for recovery without recreating its delivery', async (t) => {
  const harness = createHarness(creatingJournal());
  t.after(() => harness.service.close());
  await harness.service.reclamationWriter.prepareResume(harness.fullSnapshot);

  await assert.rejects(harness.service.ready(),
    (error) => error.code === 'instruction_creation_recovery_required');
  await assert.rejects(harness.service.create(input),
    (error) => error.code === 'instruction_creation_recovery_required');
  assert.equal(harness.createCount, 0);
});
