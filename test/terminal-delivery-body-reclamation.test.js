'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const test = require('node:test');
const { mergeRegistrationHistory } = require('../src/server/durable-checkpoint');
const { createEmptyLedger, createDelivery, registerPrTarget, transitionDelivery } = require('../src/server/delivery-ledger');
const { makeEmptyCheckpoint } = require('../src/server/durable-checkpoint');
const {
  normalizeCheckpointV3Local,
  normalizeInstructionJournalV2Local,
} = require('../src/server/delivery-reclamation-codec');
const { FIXED_H_BOUNDS, measureMigrationAllowance } = require('../src/server/reclamation-capacity-bounds');
const { projectLegacyReclamationMigrationLocal } = require('../src/server/reclamation-migration-projection');
const { validateReclamationStoreWrite } = require('../src/server/reclamation-store-consistency');
const { projectNormalizedDeliveryReferences } = require('../src/server/reclamation-delivery-references');
const { planTerminalDeliveryBodyReclamation } = require('../src/server/terminal-delivery-body-reclamation');

const STORE_ID = '11111111-1111-4111-8111-111111111111';
const MIGRATION_OPERATION_ID = '22222222-2222-4222-8222-222222222222';
const RECLAMATION_OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const STARTED_AT = 1_000_000;
const RETENTION_MS = 604_800_000;
const MAX_BYTES = 16_777_216;
const LIMITS = { questions: null, checkpoint: MAX_BYTES, instructions: MAX_BYTES };

function assertJsonEqual(actual, expected) {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function launch(provider, suffix, ownerGeneration = 2) {
  const identity = {
    provider,
    nativeIdKind: provider === 'claude' ? 'session' : 'thread',
    hostId: `${provider}-host-${suffix}`,
    homeScopeId: `${provider}-home-${suffix}`,
    nativeId: `${provider}-native-${suffix}`,
  };
  const executionBinding = {
    periodId: `${suffix}-period`,
    actor: { kind: 'agent', id: `${suffix}-actor` },
  };
  return {
    launchRef: `${suffix}-launch-ref`,
    launchId: `${suffix}-launch-id`,
    runId: `${suffix}-run-id`,
    attemptId: `${suffix}-attempt-id`,
    provider,
    nativeIdKind: identity.nativeIdKind,
    hostId: identity.hostId,
    homeScopeId: identity.homeScopeId,
    origin: 'standalone',
    purpose: 'agent',
    originBinding: null,
    state: 'bound',
    identity,
    executionBinding,
    conversationId: `${suffix}-conversation`,
    sessionId: `${suffix}-session`,
    currentOwner: executionBinding,
    ownerGeneration,
  };
}

function legacyRegistrations(sources) {
  const registrations = {
    conversations: [], executions: [], launches: [], runtimeLaunches: [], connections: [],
    actors: [], handoffs: [], replayClaims: [], incompleteConversationIds: [],
  };
  for (const source of sources) {
    const binding = source.executionBinding;
    const scope = {
      provider: source.provider,
      nativeIdKind: source.nativeIdKind,
      hostId: source.hostId,
      homeScopeId: source.homeScopeId,
      connectionSlotId: `slot-${source.launchRef}`,
    };
    const claims = {
      launchId: source.launchId, runId: source.runId, attemptId: source.attemptId,
      provider: source.provider, nativeIdKind: source.nativeIdKind, hostId: source.hostId,
      homeScopeId: source.homeScopeId, origin: source.origin, purpose: source.purpose,
      originBinding: source.originBinding,
    };
    const immutableExecutionClaims = {
      ...claims, identity: source.identity, executionBinding: binding,
    };
    registrations.conversations.push({
      conversationId: source.conversationId, identity: source.identity,
    });
    registrations.executions.push({
      conversationId: source.conversationId, executionId: binding.periodId,
      sessionId: source.sessionId, state: 'active',
    });
    registrations.launches.push({
      launchRef: source.launchRef, claims, state: 'bound', identity: source.identity,
      executionBinding: binding, conversationId: source.conversationId, sessionId: source.sessionId,
    });
    registrations.runtimeLaunches.push({
      launchRef: source.launchRef, claims: immutableExecutionClaims, state: 'bound',
      conversationId: source.conversationId, sessionId: source.sessionId,
      currentOwner: source.currentOwner, ownerGeneration: source.ownerGeneration,
    });
    registrations.connections.push({ scope, generation: 1, state: 'active' });
    registrations.actors.push({
      identity: source.identity, periodId: binding.periodId, actor: binding.actor,
      contextId: `context-${source.launchRef}`, launchRef: null, immutableExecutionClaims: null,
      connectionScope: scope, connectionGeneration: 1, state: 'active',
    });
    registrations.incompleteConversationIds.push(source.conversationId);
  }
  return registrations;
}

function legacyCheckpoint(ledger, sources) {
  const checkpoint = structuredClone(makeEmptyCheckpoint());
  checkpoint.schemaVersion = 2;
  checkpoint.revision = 9;
  checkpoint.registrations = legacyRegistrations(sources);
  checkpoint.ledger = structuredClone(ledger);
  return checkpoint;
}

function applyState(ledger, deliveryAttemptId, state) {
  if (state === 'cancelled_before_send') return transitionDelivery(ledger, deliveryAttemptId, 'cancel').ledger;
  if (state === 'superseded_before_send') return transitionDelivery(ledger, deliveryAttemptId, 'supersede').ledger;
  if (state === 'available') return ledger;
  if (state === 'unknown') {
    const sending = transitionDelivery(ledger, deliveryAttemptId, 'sendStart').ledger;
    return transitionDelivery(sending, deliveryAttemptId, 'unknown').ledger;
  }
  const sending = transitionDelivery(ledger, deliveryAttemptId, 'sendStart').ledger;
  if (state === 'sending') return sending;
  const delivery = sending.deliveries.find((item) => item.deliveryAttemptId === deliveryAttemptId);
  const correlation = {
    deliveryAttemptId,
    revision: delivery.revision,
    payloadDigest: delivery.payloadDigest,
    targetPeriodId: delivery.target.periodId,
    nativeTurnId: 'native-turn-fixture',
    nativeItemId: 'native-item-fixture',
    clientRequestId: deliveryAttemptId,
  };
  return transitionDelivery(sending, deliveryAttemptId, 'applied', correlation).ledger;
}

function pendingInstructionFor(source) {
  const input = [{ type: 'text', text: 'pending instruction body', text_elements: [] }];
  const envelope = JSON.stringify({ schemaVersion: 1, mode: 'start', expectedTurnId: null, input });
  return {
    deliveryAttemptId: 'unrelated-instruction-attempt',
    launchRef: source.launchRef,
    logicalMessageId: 'unrelated-instruction-logical',
    revision: 1,
    source: {
      launchRef: source.launchRef,
      claims: {
        launchId: source.launchId, runId: source.runId, attemptId: source.attemptId,
        provider: source.provider, nativeIdKind: source.nativeIdKind, hostId: source.hostId,
        homeScopeId: source.homeScopeId, origin: source.origin, purpose: source.purpose,
        originBinding: source.originBinding,
      },
      identity: source.identity, executionBinding: source.executionBinding,
      conversationId: source.conversationId, sessionId: source.sessionId,
    },
    envelope,
    envelopeDigest: sha256(envelope),
    nativeContentDigest: sha256(JSON.stringify(input)),
    createdAt: STARTED_AT,
  };
}

function createSnapshot({ kind = 'pr-notification', state = 'applied', provider = 'claude', terminalAt = STARTED_AT } = {}) {
  const source = launch(provider, 'source');
  const target = kind === 'pr-notification'
    ? launch(provider === 'claude' ? 'codex' : 'claude', 'target')
    : null;
  const owner = kind === 'result' ? launch(provider, 'result-owner') : null;
  if (owner !== null) {
    source.currentOwner = owner.executionBinding;
    source.ownerGeneration = 5;
  }
  const deliveryAttemptId = `${kind}-attempt`;
  let ledger = createEmptyLedger();
  if (target !== null) ledger = registerPrTarget(ledger, 'target-alias', target).ledger;
  ledger = createDelivery(ledger, kind, {
    deliveryAttemptId,
    logicalMessageId: `${kind}-logical`,
    revision: 2,
    payload: `${kind} delivery payload`,
    ...(kind === 'pr-notification' ? { targetId: 'target-alias' } : {}),
  }, source, owner !== null ? {
    identity: owner.identity,
    executionId: owner.executionBinding.periodId,
    conversationId: owner.conversationId,
    sessionId: owner.sessionId,
  } : undefined).ledger;
  ledger = applyState(ledger, deliveryAttemptId, state);

  const sources = [source, ...(target === null ? [] : [target]), ...(owner === null ? [] : [owner])];
  const checkpointSource = legacyCheckpoint(ledger, sources);
  const instructionSource = pendingInstructionFor(source);
  const sourceBytesBySlot = {
    checkpoint: Buffer.from(JSON.stringify(checkpointSource), 'utf8'),
    instructions: Buffer.from(JSON.stringify({ schemaVersion: 1, revision: 7, instructions: [instructionSource] }), 'utf8'),
  };
  const projection = projectLegacyReclamationMigrationLocal({
    configuredSlots: ['checkpoint', 'instructions'],
    sourceBytesBySlot,
    storeId: STORE_ID,
    operationId: MIGRATION_OPERATION_ID,
    startedAt: terminalAt,
    migrationAllowanceBySlot: { checkpoint: null, instructions: null },
  });
  const instructions = structuredClone(projection.slots.instructions.target.snapshot);
  instructions.instructions[0].deliveryCreationState = 'creating';
  const stores = {
    questions: null,
    checkpoint: projection.slots.checkpoint.target.snapshot,
    instructions: normalizeInstructionJournalV2Local(instructions),
  };
  const anchor = {
    schemaVersion: 1,
    revision: 0,
    storeId: STORE_ID,
    retiredQuestionPeriods: [],
    migration: null,
  };
  const checked = validateReclamationStoreWrite({
    anchor, previousStores: stores, nextStores: stores, normalByteLimitsBySlot: LIMITS,
  });
  assert.deepEqual(checked.reasons, ['instruction_creation_state']);
  return {
    anchor: checked.snapshot.anchor,
    stores: checked.snapshot.stores,
    deliveryAttemptId,
    source,
    target,
    owner,
    terminalAt,
    sourceJsonBySlot: Object.fromEntries(Object.entries(sourceBytesBySlot)
      .map(([slot, bytes]) => [slot, bytes.toString('utf8')])),
  };
}

function plan(current, now, options = {}) {
  return planTerminalDeliveryBodyReclamation({
    anchor: current.anchor,
    stores: current.stores,
    normalByteLimitsBySlot: LIMITS,
    deliveryAttemptId: current.deliveryAttemptId,
    now,
    ...options,
  });
}

test('pr notification and result details reclaim atomically at seven days for both providers and all terminal states', () => {
  for (const provider of ['claude', 'codex']) {
    for (const kind of ['pr-notification', 'result']) {
      for (const state of ['applied', 'cancelled_before_send', 'superseded_before_send']) {
        const current = createSnapshot({ kind, state, provider });
        const deadlineAt = current.terminalAt + RETENTION_MS;
        const before = plan(current, deadlineAt - 1);
        assert.equal(before.status, 'deferred');
        assert.equal(before.deferredReason, 'retention_not_elapsed');
        assert.equal(before.steps.length, 0);

        const eligible = plan(current, deadlineAt);
        assert.equal(eligible.status, 'eligible');
        assert.equal(eligible.steps.length, 0);

        const planned = plan(current, deadlineAt, { operationId: RECLAMATION_OPERATION_ID });
        assert.equal(planned.status, 'planned');
        assert.deepEqual(planned.steps.map((step) => [step.boundary, step.slot]),
          [['checkpoint-grave', 'checkpoint']]);
        const next = planned.steps[0].snapshot;
        const grave = next.stores.checkpoint.ledger.deliveries[0];
        const previous = current.stores.checkpoint;
        assert.equal(grave.recordType, 'reclaimed');
        assert.equal(grave.kind, kind);
        assert.equal(grave.reclamation.operationId, RECLAMATION_OPERATION_ID);
        assert.equal(grave.reclamation.reclaimedAt, deadlineAt);
        assert.deepEqual(grave.acceptedCorrelation, current.stores.checkpoint.ledger.deliveries[0].acceptedCorrelation);
        assert.deepEqual(grave.appliedCorrelation, current.stores.checkpoint.ledger.deliveries[0].appliedCorrelation);
        assert.equal(next.stores.checkpoint.revision, previous.revision + 1);
        assert.equal(next.stores.checkpoint.ledger.revision, previous.ledger.revision + 1);
        assertJsonEqual(next.stores.checkpoint.registrations, previous.registrations);
        assertJsonEqual(next.stores.checkpoint.ledger.notificationTargets, previous.ledger.notificationTargets);
        assertJsonEqual(next.stores.checkpoint.ledger.logicalTombstones, previous.ledger.logicalTombstones);
        assert.equal(next.stores.instructions.instructions[0].deliveryCreationState, 'creating');
        assertJsonEqual(next.stores.questions, current.stores.questions);
        assertJsonEqual(next.stores.instructions, current.stores.instructions);

        const refs = projectNormalizedDeliveryReferences(current.stores.checkpoint.ledger.deliveries[0]);
        assertJsonEqual(grave.sourceRef, refs.sourceRef);
        assertJsonEqual(grave.targetRef, refs.targetRef);
        if (kind === 'result') {
          assert.equal(grave.targetRef.kind, 'owner');
          assert.equal(grave.targetRef.launchRef, null);
          assert.equal(grave.targetRef.launchKey, null);
          assert.equal(grave.targetRef.targetClaimsDigest, null);
          assert.notDeepEqual(grave.targetRef.identity, grave.sourceRef.identity);
          assert.notEqual(grave.targetRef.periodId, grave.sourceRef.executionBinding.periodId);
          assert.equal(grave.ownerGeneration, current.stores.checkpoint.ledger.deliveries[0].ownerGeneration);
          assert.equal(grave.ownerGeneration, 5);
        } else {
          assert.notEqual(JSON.stringify(grave.targetRef.launchKey), JSON.stringify(grave.sourceRef.launchKey));
        }
      }
    }
  }
});

test('nonterminal deliveries remain unchanged and cannot be reclaimed', () => {
  for (const kind of ['pr-notification', 'result']) {
    for (const state of ['available', 'unknown', 'sending']) {
      const current = createSnapshot({ kind, state });
      const original = structuredClone(current);
      const result = plan(current, STARTED_AT + RETENTION_MS, { operationId: RECLAMATION_OPERATION_ID });
      assert.equal(result.status, 'deferred');
      assert.equal(result.deferredReason, 'not_reclaimable');
      assert.equal(result.steps.length, 0);
      assertJsonEqual(current, original);
    }
  }
});

test('terminal reclamation preserves a source-derived checkpoint grant and its eligible attempt roster', () => {
  const current = createSnapshot({ kind: 'result' });
  const project = (checkpointAllowance) => projectLegacyReclamationMigrationLocal({
    configuredSlots: ['checkpoint', 'instructions'],
    sourceBytesBySlot: Object.fromEntries(Object.entries(current.sourceJsonBySlot)
      .map(([slot, json]) => [slot, Buffer.from(json, 'utf8')])),
    storeId: STORE_ID,
    operationId: MIGRATION_OPERATION_ID,
    startedAt: current.terminalAt,
    migrationAllowanceBySlot: { checkpoint: checkpointAllowance, instructions: null },
  });
  const withoutGrant = project(null);
  const descriptor = withoutGrant.slots.checkpoint.source;
  const maxGrantProjection = project({
    operationId: MIGRATION_OPERATION_ID,
    sourceSchemaVersion: descriptor.schemaVersion,
    sourceSizeBytes: descriptor.sizeBytes,
    sourceSha256: descriptor.sha256,
    maxExtraBytes: Number.MAX_SAFE_INTEGER,
    eligibleAttemptIds: withoutGrant.slots.checkpoint.eligibleIds,
  });
  const grant = measureMigrationAllowance({
    slot: 'checkpoint',
    sourcePresent: true,
    sourceSchemaVersion: descriptor.schemaVersion,
    sourceRevision: descriptor.revision,
    sourceSizeBytes: descriptor.sizeBytes,
    sourceSha256: descriptor.sha256,
    currentByteLimit: descriptor.sizeBytes,
    anchor: withoutGrant.anchor,
    eligibleIds: withoutGrant.slots.checkpoint.eligibleIds,
    projections: {
      withoutGrant: withoutGrant.slots.checkpoint.candidateSnapshotsByBoundary,
      withMaximumGrant: maxGrantProjection.slots.checkpoint.candidateSnapshotsByBoundary,
      deliveryCandidates: maxGrantProjection.slots.checkpoint.deliveryCandidates,
    },
  });
  assert.ok(grant !== null);
  assert.ok(grant.maxExtraBytes <= FIXED_H_BOUNDS.checkpoint);
  assert.deepEqual(grant.eligibleAttemptIds, withoutGrant.slots.checkpoint.eligibleIds);

  const checkpoint = normalizeCheckpointV3Local({
    ...current.stores.checkpoint,
    migrationAllowance: grant,
  });
  const stores = { ...current.stores, checkpoint };
  const checked = validateReclamationStoreWrite({
    anchor: current.anchor,
    previousStores: stores,
    nextStores: stores,
    normalByteLimitsBySlot: LIMITS,
  });
  assertJsonEqual(checked.snapshot.stores.checkpoint.migrationAllowance, grant);
  assert.deepEqual(checked.reasons, ['instruction_creation_state']);

  const planned = plan({ ...current, stores: checked.snapshot.stores },
    current.terminalAt + RETENTION_MS, { operationId: RECLAMATION_OPERATION_ID });
  assert.equal(planned.status, 'planned');
  const next = planned.steps[0].snapshot;
  assertJsonEqual(next.stores.checkpoint.migrationAllowance, grant);
  assert.deepEqual(next.stores.checkpoint.migrationAllowance.eligibleAttemptIds, [current.deliveryAttemptId]);
  assert.equal(next.stores.checkpoint.ledger.deliveries[0].targetRef.launchRef, null);
  assert.notDeepEqual(next.stores.checkpoint.ledger.deliveries[0].targetRef.identity,
    next.stores.checkpoint.ledger.deliveries[0].sourceRef.identity);
});

test('terminal reclamation preserves a result owner recorded before a later accepted handoff', () => {
  const current = createSnapshot({ kind: 'result' });
  const previousCheckpoint = current.stores.checkpoint;
  const nextOwner = launch('codex', 'result-owner-next');
  const checkpoint = structuredClone(previousCheckpoint);
  const nextOwnerRegistrations = legacyRegistrations([nextOwner]);
  for (const field of Object.keys(checkpoint.registrations)) {
    checkpoint.registrations[field].push(...nextOwnerRegistrations[field]);
  }
  const sourceRuntimeLaunch = checkpoint.registrations.runtimeLaunches.find((item) =>
    item.launchRef === current.source.launchRef);
  sourceRuntimeLaunch.currentOwner = nextOwner.executionBinding;
  sourceRuntimeLaunch.ownerGeneration = 6;
  checkpoint.registrations.handoffs.push({
    handoffId: 'result-owner-handoff-6',
    owner: nextOwner.executionBinding,
    ownerGeneration: 6,
    status: 'accepted',
  });
  checkpoint.registrations = mergeRegistrationHistory(
    previousCheckpoint.registrations,
    checkpoint.registrations,
  );
  checkpoint.revision += 1;

  const stores = {
    ...current.stores,
    checkpoint: normalizeCheckpointV3Local(checkpoint),
  };
  const checked = validateReclamationStoreWrite({
    anchor: current.anchor,
    previousStores: stores,
    nextStores: stores,
    normalByteLimitsBySlot: LIMITS,
  });
  assert.deepEqual(checked.reasons, ['instruction_creation_state']);
  const detail = checked.snapshot.stores.checkpoint.ledger.deliveries[0];
  assert.equal(detail.ownerGeneration, 5);
  assertJsonEqual(detail.target.identity, current.owner.identity);
  assert.equal(detail.target.periodId, current.owner.executionBinding.periodId);
  const runtimeAfterHandoff = checked.snapshot.stores.checkpoint.registrations.runtimeLaunches.find((item) =>
    item.launchRef === current.source.launchRef);
  assert.equal(runtimeAfterHandoff.ownerGeneration, 6);
  assertJsonEqual(runtimeAfterHandoff.currentOwner, nextOwner.executionBinding);

  const planned = plan({ ...current, stores: checked.snapshot.stores },
    detail.terminalAt + RETENTION_MS, { operationId: RECLAMATION_OPERATION_ID });
  assert.equal(planned.status, 'planned');
  const next = planned.steps[0].snapshot;
  const grave = next.stores.checkpoint.ledger.deliveries[0];
  assert.equal(grave.ownerGeneration, 5);
  assert.equal(grave.targetRef.kind, 'owner');
  assert.equal(grave.targetRef.launchRef, null);
  assert.equal(grave.targetRef.launchKey, null);
  assert.equal(grave.targetRef.targetClaimsDigest, null);
  assertJsonEqual(grave.targetRef.identity, detail.target.identity);
  assert.equal(grave.targetRef.periodId, detail.target.periodId);
  assert.equal(next.stores.checkpoint.registrations.runtimeLaunches.find((item) =>
    item.launchRef === current.source.launchRef).ownerGeneration, 6);
  assertJsonEqual(next.stores.checkpoint.registrations.handoffs,
    checked.snapshot.stores.checkpoint.registrations.handoffs);
});

test('terminal deadline overflow defers while a consistent grave completes without consulting the clock', () => {
  const overflowAt = Number.MAX_SAFE_INTEGER - RETENTION_MS + 1;
  const overflow = createSnapshot({ terminalAt: overflowAt });
  const deferred = plan(overflow, Number.MAX_SAFE_INTEGER, { operationId: RECLAMATION_OPERATION_ID });
  assert.equal(deferred.status, 'deferred');
  assert.equal(deferred.deferredReason, 'retention_deadline_overflow');

  const current = createSnapshot();
  const completed = plan(current, current.terminalAt + RETENTION_MS, { operationId: RECLAMATION_OPERATION_ID });
  const graveSnapshot = completed.steps[0].snapshot;
  const graveInput = { ...graveSnapshot, deliveryAttemptId: current.deliveryAttemptId, now: 0,
    normalByteLimitsBySlot: LIMITS };
  const complete = planTerminalDeliveryBodyReclamation(graveInput);
  assert.equal(complete.status, 'complete');
  assert.equal(complete.operationId, RECLAMATION_OPERATION_ID);
  assert.equal(complete.steps.length, 0);
  assert.throws(() => planTerminalDeliveryBodyReclamation({ ...graveInput, now: -1 }),
    (error) => error instanceof TypeError && error.message === 'invalid_terminal_delivery_body_reclamation');
});
