'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { test } = require('node:test');
const {
  encodeCheckpointV3Local,
} = require('../src/server/delivery-reclamation-codec');
const { projectNormalizedDeliveryReferences } = require('../src/server/reclamation-delivery-references');
const { transitionReclamationDelivery } = require('../src/server/delivery-reclamation-runtime');
const {
  createNativeTerminalDeliveryBodyReclamationHarness,
  correlationFor,
  otherProvider,
  PROVIDERS,
  TERMINAL_DELIVERY_KINDS,
  TERMINAL_DELIVERY_STATES,
  TERMINAL_RETENTION_MS,
} = require('./support/native-terminal-delivery-body-reclamation-harness');

const INITIAL_NOW = 1_800_000_000_000;

async function makeHarness(t, initialNow = INITIAL_NOW) {
  const harness = await createNativeTerminalDeliveryBodyReclamationHarness({ initialNow });
  t.after(() => harness.removeDirectory());
  return harness;
}

function deliveryInput(launchRef, suffix) {
  return {
    launchRef,
    deliveryAttemptId: `terminal-attempt-${suffix}`,
    logicalMessageId: `terminal-logical-${suffix}`,
    revision: 1,
    payload: `private-terminal-body-${suffix}`,
  };
}

async function createTerminalDelivery(harness, provider, kind, suffix) {
  const adapter = harness.deliveryAdapter(provider);
  const targetLaunch = await harness.start(provider, `${suffix}-target`);
  let delivery;
  let sourceLaunch = targetLaunch;
  let targetId = null;
  if (kind === 'result') {
    delivery = await adapter.createResultDelivery(deliveryInput(targetLaunch.launchRef, suffix));
  } else {
    sourceLaunch = await harness.start(otherProvider(provider), `${suffix}-source`);
    targetId = `terminal-target-${suffix}`;
    await adapter.registerPrNotificationTarget({ targetId, launchRef: targetLaunch.launchRef });
    await adapter.registerPrNotificationTarget({ targetId: `${targetId}-history`, launchRef: targetLaunch.launchRef });
    delivery = await adapter.createPrNotification({
      sourceLaunchRef: sourceLaunch.launchRef,
      targetId,
      deliveryAttemptId: `terminal-attempt-${suffix}`,
      logicalMessageId: `terminal-logical-${suffix}`,
      revision: 1,
      payload: `private-terminal-body-${suffix}`,
    });
  }
  return { adapter, delivery, targetLaunch, sourceLaunch, targetId };
}

async function seedAppliedResultByColdCheckpoint(harness, deliveries) {
  if (deliveries.length === 0) return;
  await harness.restart(async () => {
    let checkpoint = await harness.checkpoint();
    for (const { delivery } of deliveries) {
      const started = transitionReclamationDelivery(
        checkpoint, delivery.deliveryAttemptId, 'sendStart', undefined, () => harness.getNow(),
      );
      checkpoint = {
        ...checkpoint,
        revision: checkpoint.revision + 1,
        ledger: started.ledger,
      };
      const correlation = correlationFor(delivery, `stored-turn-${delivery.deliveryAttemptId}`,
        `stored-item-${delivery.deliveryAttemptId}`);
      const applied = transitionReclamationDelivery(
        checkpoint, delivery.deliveryAttemptId, 'applied', correlation, () => harness.getNow(),
      );
      checkpoint = {
        ...checkpoint,
        revision: checkpoint.revision + 1,
        ledger: applied.ledger,
      };
    }
    const encoded = encodeCheckpointV3Local(checkpoint);
    await fs.writeFile(harness.checkpointPath, encoded.bytes);
  });
}

async function seedUnknownResultByColdCheckpoint(harness, delivery) {
  await harness.restart(async () => {
    let checkpoint = await harness.checkpoint();
    const started = transitionReclamationDelivery(
      checkpoint, delivery.deliveryAttemptId, 'sendStart', undefined, () => harness.getNow(),
    );
    checkpoint = { ...checkpoint, revision: checkpoint.revision + 1, ledger: started.ledger };
    const unknown = transitionReclamationDelivery(
      checkpoint, delivery.deliveryAttemptId, 'unknown', undefined, () => harness.getNow(),
    );
    checkpoint = { ...checkpoint, revision: checkpoint.revision + 1, ledger: unknown.ledger };
    await fs.writeFile(harness.checkpointPath, encodeCheckpointV3Local(checkpoint).bytes);
  });
}

async function seedNonterminalResultByColdCheckpoint(harness, delivery, state) {
  await harness.restart(async () => {
    let checkpoint = await harness.checkpoint();
    const transition = (operation, correlation = undefined) => {
      const result = transitionReclamationDelivery(
        checkpoint, delivery.deliveryAttemptId, operation, correlation, () => harness.getNow(),
      );
      checkpoint = { ...checkpoint, revision: checkpoint.revision + 1, ledger: result.ledger };
    };
    if (state === 'claimed') transition('claim');
    if (['sending', 'accepted', 'unknown'].includes(state)) {
      if (state === 'accepted' || state === 'unknown') transition('sendStart');
      if (state === 'accepted') {
        transition('accepted', correlationFor(delivery,
          `stored-turn-${delivery.deliveryAttemptId}`, `stored-item-${delivery.deliveryAttemptId}`));
      }
      if (state === 'unknown') transition('unknown');
      if (state === 'sending') transition('sendStart');
    }
    await fs.writeFile(harness.checkpointPath, encodeCheckpointV3Local(checkpoint).bytes);
  });
}

async function markTerminal(harness, scenario, state) {
  const { adapter, delivery } = scenario;
  if (state === 'applied') {
    if (delivery.kind === 'result') {
      await seedAppliedResultByColdCheckpoint(harness, [scenario]);
      return harness.deliveryAdapter(scenario.adapter.provider).get(delivery.deliveryAttemptId);
    }
    await adapter.sendStart(delivery.deliveryAttemptId, () => {});
    await adapter.recordApplied(delivery.deliveryAttemptId,
      correlationFor(delivery, `fake-turn-${delivery.deliveryAttemptId}`, `fake-item-${delivery.deliveryAttemptId}`));
  } else if (state === 'cancelled_before_send') {
    await adapter.cancel(delivery.deliveryAttemptId);
  } else {
    await adapter.supersedeUnsentDelivery(delivery.deliveryAttemptId);
  }
  return adapter.get(delivery.deliveryAttemptId);
}

function countFakeNativeWrites(harness, provider) {
  return harness.processesByProvider.get(provider)
    .reduce((total, process) => total + process.state.instructionWrites.length, 0);
}

function preservedCheckpointFields(checkpoint) {
  return {
    storeId: checkpoint.storeId,
    migrationAllowance: checkpoint.migrationAllowance,
    registrations: checkpoint.registrations,
    notificationTargets: checkpoint.ledger.notificationTargets,
    logicalTombstones: checkpoint.ledger.logicalTombstones,
    deliveryIds: checkpoint.ledger.deliveries.map((item) => item.deliveryAttemptId),
  };
}

function assertPreservedCheckpointFields(before, after, deliveryAttemptId) {
  assert.deepEqual(preservedCheckpointFields(after), preservedCheckpointFields(before));
  assert.equal(after.ledger.deliveries.length, before.ledger.deliveries.length);
  for (let index = 0; index < before.ledger.deliveries.length; index += 1) {
    if (before.ledger.deliveries[index].deliveryAttemptId === deliveryAttemptId) continue;
    assert.deepEqual(after.ledger.deliveries[index], before.ledger.deliveries[index]);
  }
}

function assertGraveProjection(detail, grave) {
  const expectedRefs = projectNormalizedDeliveryReferences(detail);
  assert.equal(grave.recordType, 'reclaimed');
  assert.equal(grave.kind, detail.kind);
  assert.equal(grave.deliveryAttemptId, detail.deliveryAttemptId);
  assert.equal(grave.logicalMessageId, detail.logicalMessageId);
  assert.equal(grave.revision, detail.revision);
  assert.equal(grave.sourceExecutionId, detail.sourceExecutionId);
  assert.equal(grave.payloadDigest, detail.payloadDigest);
  assert.equal(grave.state, detail.state);
  assert.equal(grave.terminalAt, detail.terminalAt);
  assert.equal(grave.ownerGeneration, detail.ownerGeneration);
  assert.deepEqual(grave.acceptedCorrelation, detail.acceptedCorrelation);
  assert.deepEqual(grave.appliedCorrelation, detail.appliedCorrelation);
  assert.equal(JSON.stringify(grave.sourceRef), JSON.stringify(expectedRefs.sourceRef));
  assert.equal(JSON.stringify(grave.targetRef), JSON.stringify(expectedRefs.targetRef));
  assert.equal(grave.reclamation.reason, 'terminal_retention');
  assert.ok(Number.isSafeInteger(grave.reclamation.reclaimedAt));
  assert.equal(typeof grave.reclamation.operationId, 'string');
}

async function prepareAppliedScenario(harness, provider, kind, suffix) {
  const scenario = await createTerminalDelivery(harness, provider, kind, suffix);
  const beforeTerminalization = await harness.checkpoint();
  const terminal = await markTerminal(harness, scenario, 'applied');
  const detail = await harness.deliveryAdapter(provider).get(scenario.delivery.deliveryAttemptId);
  assert.equal(detail.recordType, 'detail');
  assert.equal(detail.state, 'applied');
  assert.ok(Number.isSafeInteger(detail.terminalAt));
  return { ...scenario, terminal, detail, beforeTerminalization };
}

test('両providerのresultとPR通知を3種の終端ごとに7日前保持し、期限到達時に墓標へ置換する', { timeout: 120000 }, async (t) => {
  for (const provider of PROVIDERS) {
    const harness = await makeHarness(t);
    const scenarios = [];
    for (const kind of TERMINAL_DELIVERY_KINDS) {
      for (const state of TERMINAL_DELIVERY_STATES) {
        const scenario = await createTerminalDelivery(harness, provider, kind, `${provider}-${kind}-${state}`);
        scenarios.push({ ...scenario, state });
      }
    }

    const resultApplied = scenarios.find((item) => item.delivery.kind === 'result' && item.state === 'applied');
    for (const scenario of scenarios) {
      if (scenario.delivery.kind === 'pr-notification' && scenario.state === 'applied') {
        await scenario.adapter.sendStart(scenario.delivery.deliveryAttemptId, () => {});
        await scenario.adapter.recordApplied(scenario.delivery.deliveryAttemptId,
          correlationFor(scenario.delivery, `fake-turn-${scenario.delivery.deliveryAttemptId}`,
            `fake-item-${scenario.delivery.deliveryAttemptId}`));
      } else if (scenario.delivery.kind === 'pr-notification' && scenario.state === 'cancelled_before_send') {
        await scenario.adapter.cancel(scenario.delivery.deliveryAttemptId);
      } else if (scenario.delivery.kind === 'pr-notification' && scenario.state === 'superseded_before_send') {
        await scenario.adapter.supersedeUnsentDelivery(scenario.delivery.deliveryAttemptId);
      }
    }
    await seedAppliedResultByColdCheckpoint(harness, [resultApplied]);
    for (const scenario of scenarios) {
      scenario.adapter = harness.deliveryAdapter(provider);
      if (scenario.delivery.kind !== 'result') continue;
      if (scenario.state === 'cancelled_before_send') await scenario.adapter.cancel(scenario.delivery.deliveryAttemptId);
      if (scenario.state === 'superseded_before_send') {
        await scenario.adapter.supersedeUnsentDelivery(scenario.delivery.deliveryAttemptId);
      }
    }

    for (const scenario of scenarios) {
      const detail = await harness.deliveryAdapter(provider).get(scenario.delivery.deliveryAttemptId);
      assert.equal(detail.recordType, 'detail', `${provider}/${scenario.delivery.kind}/${scenario.state}`);
      assert.equal(detail.state, scenario.state, `${provider}/${scenario.delivery.kind}/${scenario.state}`);
      scenario.detail = detail;
    }

    const sourceCheckpoint = await harness.checkpoint();
    const writeCount = harness.persistenceWritesBySlot.checkpoint;
    const nativeWrites = new Map(PROVIDERS.map((item) => [item, countFakeNativeWrites(harness, item)]));
    const deadlines = scenarios.map((scenario) => scenario.detail.terminalAt + TERMINAL_RETENTION_MS);
    assert.ok(deadlines.every(Number.isSafeInteger));
    const lastDeadline = Math.max(...deadlines);
    harness.setNow(lastDeadline - 1);
    for (const scenario of scenarios) {
      assert.equal((await harness.reclaim(scenario.delivery.deliveryAttemptId)).status, 'deferred');
    }
    assert.deepEqual(await harness.checkpoint(), sourceCheckpoint);
    assert.equal(harness.persistenceWritesBySlot.checkpoint, writeCount);

    harness.setNow(lastDeadline);
    for (const scenario of scenarios) {
      const before = await harness.checkpoint();
      const current = before.ledger.deliveries.find((item) => item.deliveryAttemptId === scenario.delivery.deliveryAttemptId);
      const currentDeadline = current.terminalAt + TERMINAL_RETENTION_MS;
      harness.setNow(Math.max(harness.getNow(), currentDeadline));
      const result = await harness.reclaim(scenario.delivery.deliveryAttemptId);
      assert.equal(result.status, 'complete', `${provider}/${scenario.delivery.kind}/${scenario.state}`);
      const after = await harness.checkpoint();
      const grave = after.ledger.deliveries.find((item) => item.deliveryAttemptId === scenario.delivery.deliveryAttemptId);
      assertGraveProjection(scenario.detail, grave);
      assertPreservedCheckpointFields(before, after, scenario.delivery.deliveryAttemptId);
      assert.equal(after.revision, before.revision + 1);
      assert.equal(after.ledger.revision, before.ledger.revision + 1);
      assert.equal((await harness.checkpointBytes()).includes(Buffer.from(`private-terminal-body-${provider}-${scenario.delivery.kind}-${scenario.state}`)), false);
    }
    assert.equal(harness.persistenceWritesBySlot.checkpoint, writeCount + scenarios.length);
    for (const item of PROVIDERS) assert.equal(countFakeNativeWrites(harness, item), nativeWrites.get(item));
  }
});

test('両providerとkindでcheckpoint write前・後・readback失敗をfresh起動から安全に扱う', { timeout: 180000 }, async (t) => {
  for (const provider of PROVIDERS) {
    for (const kind of TERMINAL_DELIVERY_KINDS) {
      for (const phase of ['before-write', 'after-write', 'readback']) {
        const harness = await makeHarness(t);
        const scenario = await prepareAppliedScenario(harness, provider, kind,
          `fault-${provider}-${kind}-${phase}`);
        const checkpointBefore = await harness.checkpoint();
        const bytesBefore = await harness.checkpointBytes();
        const nativeWrites = new Map(PROVIDERS.map((item) => [item, countFakeNativeWrites(harness, item)]));
        harness.setNow(scenario.detail.terminalAt + TERMINAL_RETENTION_MS);
        harness.faults.arm({ slot: 'checkpoint', phase });
        await assert.rejects(harness.reclaim(scenario.delivery.deliveryAttemptId));

        const bytesAfterFailure = await harness.checkpointBytes();
        const persistedAfterFailure = JSON.parse(bytesAfterFailure.toString('utf8'));
        const saved = persistedAfterFailure.ledger.deliveries.find((item) =>
          item.deliveryAttemptId === scenario.delivery.deliveryAttemptId);
        assert.equal(saved.recordType, phase === 'before-write' ? 'detail' : 'reclaimed', phase);
        if (phase === 'before-write') assert.deepEqual(bytesAfterFailure, bytesBefore);
        else assert.notDeepEqual(bytesAfterFailure, bytesBefore);
        if (saved.recordType === 'reclaimed') assert.equal(saved.reclamation.reason, 'terminal_retention');

        await harness.restart();
        const reopened = await harness.checkpoint();
        assert.deepEqual(reopened, persistedAfterFailure);
        const writesAfterRestart = harness.persistenceWritesBySlot.checkpoint;
        const recovered = await harness.deliveryAdapter(provider).get(scenario.delivery.deliveryAttemptId);
        assert.equal(recovered.recordType, phase === 'before-write' ? 'detail' : 'reclaimed');
        if (recovered.recordType === 'reclaimed') {
          const operationId = recovered.reclamation.operationId;
          assert.equal((await harness.reclaim(scenario.delivery.deliveryAttemptId)).status, 'complete');
          assert.equal(harness.persistenceWritesBySlot.checkpoint, writesAfterRestart);
          assert.equal((await harness.deliveryAdapter(provider).get(scenario.delivery.deliveryAttemptId))
            .reclamation.operationId, operationId);
        } else {
          assert.equal((await harness.reclaim(scenario.delivery.deliveryAttemptId)).status, 'complete');
          const retried = await harness.deliveryAdapter(provider).get(scenario.delivery.deliveryAttemptId);
          assert.equal(retried.recordType, 'reclaimed');
          assert.notEqual(retried.reclamation.operationId, undefined);
        }
        for (const item of PROVIDERS) assert.equal(countFakeNativeWrites(harness, item), nativeWrites.get(item));
        assert.ok(bytesAfterFailure.length > 0);
        assert.ok(checkpointBefore.ledger.deliveries.length > 0);
      }
    }
  }
});

test('applied墓標は固定相関補完だけを許し、終端墓標は再作成・再送・rehydrateを拒む', { timeout: 120000 }, async (t) => {
  for (const provider of PROVIDERS) {
    for (const kind of TERMINAL_DELIVERY_KINDS) {
      const harness = await makeHarness(t);
      if (kind === 'result') {
        const recreationScenario = await createTerminalDelivery(harness, provider, kind,
          `recreate-${provider}-${kind}`);
        await recreationScenario.adapter.cancel(recreationScenario.delivery.deliveryAttemptId);
        const cancelled = await recreationScenario.adapter.get(recreationScenario.delivery.deliveryAttemptId);
        harness.setNow(cancelled.terminalAt);
        assert.equal((await harness.reclaim(recreationScenario.delivery.deliveryAttemptId)).status, 'deferred');
        harness.setNow(cancelled.terminalAt + TERMINAL_RETENTION_MS);
        assert.equal((await harness.reclaim(recreationScenario.delivery.deliveryAttemptId)).status, 'complete');
        assert.equal((await recreationScenario.adapter.get(recreationScenario.delivery.deliveryAttemptId)).recordType,
          'reclaimed');
        const bytesWithTombstone = await harness.checkpointBytes();
        await assert.rejects(recreationScenario.adapter.createResultDelivery({
          ...deliveryInput(recreationScenario.targetLaunch.launchRef, `duplicate-${provider}-${kind}`),
          logicalMessageId: recreationScenario.delivery.logicalMessageId,
          revision: recreationScenario.delivery.revision,
        }), { code: 'logical_conflict' });
        assert.deepEqual(await harness.checkpointBytes(), bytesWithTombstone);
      }
      const scenario = await prepareAppliedScenario(harness, provider, kind, `late-${provider}-${kind}`);
      const nativeWritesBefore = new Map(PROVIDERS.map((item) => [item, countFakeNativeWrites(harness, item)]));
      const appliedCorrelation = correlationFor(scenario.detail, `fake-turn-${scenario.delivery.deliveryAttemptId}`,
        `fake-item-${scenario.delivery.deliveryAttemptId}`);
      if (kind === 'result') {
        const stored = await harness.checkpoint();
        const current = stored.ledger.deliveries.find((item) => item.deliveryAttemptId === scenario.delivery.deliveryAttemptId);
        appliedCorrelation.nativeTurnId = current.appliedCorrelation.nativeTurnId;
        appliedCorrelation.nativeItemId = current.appliedCorrelation.nativeItemId;
      }
      harness.setNow(scenario.detail.terminalAt + TERMINAL_RETENTION_MS);
      assert.equal((await harness.reclaim(scenario.delivery.deliveryAttemptId)).status, 'complete');
      const adapter = harness.deliveryAdapter(provider);
      const beforeAcceptedWrites = harness.persistenceWritesBySlot.checkpoint;
      const graveBefore = await adapter.get(scenario.delivery.deliveryAttemptId);
      const accepted = await adapter.recordAccepted(scenario.delivery.deliveryAttemptId, appliedCorrelation);
      assert.equal(accepted.recordType, 'reclaimed');
      assert.equal(JSON.stringify(accepted.appliedCorrelation), JSON.stringify(graveBefore.appliedCorrelation));
      assert.equal(JSON.stringify(accepted.acceptedCorrelation), JSON.stringify(graveBefore.appliedCorrelation));
      assert.equal(harness.persistenceWritesBySlot.checkpoint, beforeAcceptedWrites + 1);

      const beforeDuplicateWrites = harness.persistenceWritesBySlot.checkpoint;
      await adapter.recordAccepted(scenario.delivery.deliveryAttemptId, appliedCorrelation);
      await adapter.recordApplied(scenario.delivery.deliveryAttemptId, appliedCorrelation);
      assert.equal(harness.persistenceWritesBySlot.checkpoint, beforeDuplicateWrites);

      const stableBytes = await harness.checkpointBytes();
      const wrongCorrelation = { ...appliedCorrelation, nativeTurnId: `${appliedCorrelation.nativeTurnId}-other` };
      await assert.rejects(adapter.recordAccepted(scenario.delivery.deliveryAttemptId, wrongCorrelation),
        (error) => ['correlation_mismatch', 'delivery_reclaimed'].includes(error.code));
      await assert.rejects(harness.deliveryAdapter(otherProvider(provider))
        .recordAccepted(scenario.delivery.deliveryAttemptId, appliedCorrelation), { code: 'provider_mismatch' });
      assert.deepEqual(await harness.checkpointBytes(), stableBytes);
      if (kind === 'result') {
        await assert.rejects(adapter.createResultDelivery({
          ...deliveryInput(scenario.targetLaunch.launchRef, `${provider}-${kind}-cold-duplicate`),
          logicalMessageId: scenario.delivery.logicalMessageId,
          revision: scenario.delivery.revision,
        }), { code: 'provider_mismatch' });
        assert.deepEqual(await harness.checkpointBytes(), stableBytes);
      }

      let sinkCalls = 0;
      await assert.rejects(adapter.sendStart(scenario.delivery.deliveryAttemptId, () => { sinkCalls += 1; }),
        { code: 'delivery_reclaimed' });
      await assert.rejects(adapter.rehydratePayload(scenario.delivery.deliveryAttemptId,
        `private-terminal-body-${provider}-${kind}`), { code: 'delivery_reclaimed' });
      if (kind === 'pr-notification') {
        await assert.rejects(adapter.createPrNotification({
          sourceLaunchRef: scenario.sourceLaunch.launchRef,
          targetId: scenario.targetId,
          deliveryAttemptId: `terminal-duplicate-attempt-${provider}`,
          logicalMessageId: scenario.delivery.logicalMessageId,
          revision: scenario.delivery.revision,
          payload: 'must not be restored',
        }), { code: 'logical_conflict' });
      }
      assert.equal(sinkCalls, 0);
      assert.deepEqual(await harness.checkpointBytes(), stableBytes);
      for (const item of PROVIDERS) assert.equal(countFakeNativeWrites(harness, item), nativeWritesBefore.get(item));
    }
  }
});

test('unknownは期限で終端化せず、時計逆行・overflow・closeと不正入力は保存しない', { timeout: 90000 }, async (t) => {
  for (const provider of PROVIDERS) {
    const harness = await makeHarness(t);
    const scenario = await createTerminalDelivery(harness, provider, 'result', `defer-${provider}`);
    const adapter = scenario.adapter;
    await seedUnknownResultByColdCheckpoint(harness, scenario.delivery);
    const bytes = await harness.checkpointBytes();
    harness.setNow(INITIAL_NOW + TERMINAL_RETENTION_MS + 10);
    assert.equal((await harness.reclaim(scenario.delivery.deliveryAttemptId)).status, 'deferred');
    assert.deepEqual(await harness.checkpointBytes(), bytes);

    const invalid = { deliveryAttemptId: scenario.delivery.deliveryAttemptId, unexpected: true };
    assert.throws(() => harness.reclamationService().reclaimTerminalDeliveryBody(invalid),
      { code: 'invalid_terminal_delivery_body_reclamation' });
    let getterCalls = 0;
    const getterInput = {};
    Object.defineProperty(getterInput, 'deliveryAttemptId', {
      enumerable: true,
      get() { getterCalls += 1; return scenario.delivery.deliveryAttemptId; },
    });
    assert.throws(() => harness.reclamationService().reclaimTerminalDeliveryBody(getterInput),
      { code: 'invalid_terminal_delivery_body_reclamation' });
    assert.equal(getterCalls, 0);
    assert.deepEqual(await harness.checkpointBytes(), bytes);
  }

  const overflowHarness = await makeHarness(t, Number.MAX_SAFE_INTEGER - 10);
  const overflowScenario = await createTerminalDelivery(overflowHarness, 'claude', 'result', 'overflow');
  await overflowScenario.adapter.cancel(overflowScenario.delivery.deliveryAttemptId);
  overflowHarness.setNow(Number.MAX_SAFE_INTEGER);
  const overflowBytes = await overflowHarness.checkpointBytes();
  assert.equal((await overflowHarness.reclaim(overflowScenario.delivery.deliveryAttemptId)).status, 'deferred');
  assert.deepEqual(await overflowHarness.checkpointBytes(), overflowBytes);

  const rollbackHarness = await makeHarness(t);
  const rollbackScenario = await createTerminalDelivery(rollbackHarness, 'codex', 'result', 'rollback');
  const rollbackBytes = await rollbackHarness.checkpointBytes();
  rollbackHarness.setNow(INITIAL_NOW + TERMINAL_RETENTION_MS + 100);
  assert.equal((await rollbackHarness.reclaim(rollbackScenario.delivery.deliveryAttemptId)).status, 'deferred');
  rollbackHarness.setNow(INITIAL_NOW);
  await rollbackScenario.adapter.cancel(rollbackScenario.delivery.deliveryAttemptId);
  rollbackHarness.setNow(INITIAL_NOW + TERMINAL_RETENTION_MS);
  const beforeRollbackCheck = await rollbackHarness.checkpointBytes();
  assert.equal((await rollbackHarness.reclaim(rollbackScenario.delivery.deliveryAttemptId)).status, 'deferred');
  assert.deepEqual(await rollbackHarness.checkpointBytes(), beforeRollbackCheck);
  assert.notDeepEqual(beforeRollbackCheck, rollbackBytes);

  const closedHarness = await makeHarness(t);
  const closedScenario = await createTerminalDelivery(closedHarness, 'claude', 'result', 'closed');
  const closedBytes = await closedHarness.checkpointBytes();
  await closedHarness.close();
  assert.throws(() => closedHarness.reclamationService().reclaimTerminalDeliveryBody({
    deliveryAttemptId: closedScenario.delivery.deliveryAttemptId,
  }), { code: 'native_instruction_integration_closed' });
  assert.deepEqual(await closedHarness.checkpointBytes(), closedBytes);
});

test('available・claimed・sending・accepted・unknownは両providerとkindで保持する', { timeout: 120000 }, async (t) => {
  const nonterminalStates = ['available', 'claimed', 'sending', 'accepted', 'unknown'];
  for (const provider of PROVIDERS) {
    for (const kind of TERMINAL_DELIVERY_KINDS) {
      for (const state of nonterminalStates) {
        const harness = await makeHarness(t);
        const scenario = await createTerminalDelivery(harness, provider, kind,
          `nonterminal-${provider}-${kind}-${state}`);
        if (state === 'claimed') await scenario.adapter.claim(scenario.delivery.deliveryAttemptId);
        if (kind === 'pr-notification' && state === 'sending') {
          await scenario.adapter.sendStart(scenario.delivery.deliveryAttemptId, () => {});
        } else if (kind === 'pr-notification' && state === 'accepted') {
          await scenario.adapter.sendStart(scenario.delivery.deliveryAttemptId, () => {});
          await scenario.adapter.recordAccepted(scenario.delivery.deliveryAttemptId,
            correlationFor(scenario.delivery, `turn-${scenario.delivery.deliveryAttemptId}`,
              `item-${scenario.delivery.deliveryAttemptId}`));
        } else if (kind === 'pr-notification' && state === 'unknown') {
          await scenario.adapter.sendStart(scenario.delivery.deliveryAttemptId, () => {});
          await scenario.adapter.markUnknown(scenario.delivery.deliveryAttemptId);
        } else if (kind === 'result' && state !== 'available' && state !== 'claimed') {
          await seedNonterminalResultByColdCheckpoint(harness, scenario.delivery, state);
        }

        const adapter = harness.deliveryAdapter(provider);
        const current = await adapter.get(scenario.delivery.deliveryAttemptId);
        assert.equal(current.state, state, `${provider}/${kind}/${state}`);
        assert.equal(current.terminalAt, null, `${provider}/${kind}/${state}`);
        const bytes = await harness.checkpointBytes();
        const writes = harness.persistenceWritesBySlot.checkpoint;
        assert.equal((await harness.reclaim(scenario.delivery.deliveryAttemptId)).status, 'deferred');
        harness.setNow(INITIAL_NOW + TERMINAL_RETENTION_MS * 2);
        assert.equal((await harness.reclaim(scenario.delivery.deliveryAttemptId)).status, 'deferred');
        assert.deepEqual(await harness.checkpointBytes(), bytes, `${provider}/${kind}/${state}`);
        assert.equal(harness.persistenceWritesBySlot.checkpoint, writes, `${provider}/${kind}/${state}`);
      }
    }
  }
});
