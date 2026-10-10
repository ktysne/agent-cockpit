'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { test } = require('node:test');
const {
  DATA_FILES,
  PROVIDERS,
  createSeededHarness,
  limitsForPostBodyRelease,
  threeSlotLegacySources,
} = require('./support/native-migration-allowance-release-harness');

const SLOT_ORDER = Object.freeze(['checkpoint', 'instructions', 'questions']);

function grantsIn(stores) {
  return Object.fromEntries(SLOT_ORDER.map((slot) => [slot, stores[slot].migrationAllowance]));
}

function recordCounts(stores) {
  return {
    checkpointRegistrations: Object.fromEntries(Object.entries(stores.checkpoint.registrations)
      .filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])),
    deliveries: stores.checkpoint.ledger.deliveries.length,
    aliases: stores.checkpoint.ledger.notificationTargets.length,
    logicalTombstones: stores.checkpoint.ledger.logicalTombstones.length,
    instructions: stores.instructions.instructions.length,
    questions: stores.questions.questions.length,
    reservations: stores.questions.reservations.length,
  };
}

function withoutReleaseFields(value) {
  const copy = structuredClone(value);
  delete copy.revision;
  delete copy.migrationAllowance;
  return copy;
}

async function storesFrom(fixture) {
  return Object.fromEntries(await Promise.all(SLOT_ORDER.map(async (slot) =>
    [slot, await fixture.readJson(slot)])));
}

function nativeInstructionWriteCount(harness, provider) {
  return harness.processesByProvider.get(provider).reduce((count, process) =>
    count + (process.state.instructionWrites?.length || 0), 0);
}

async function prepareBodyCapacity(fixture) {
  const { harness } = fixture;
  const cancelled = await harness.instructionService.cancel('attempt-instruction');
  assert.equal(cancelled.delivery.state, 'cancelled_before_send');
  assert.equal(cancelled.delivery.terminalAt, 1_000_000);

  fixture.setNow(1_604_800_001);
  const questionResult = await harness.reclamationService.reclaimQuestionBodies({
    identity: fixture.sources.question.identity,
    periodId: 'period-1',
  });
  assert.deepEqual(questionResult, {
    status: 'complete',
    reclaimedQuestionIds: ['internal-1'],
    deferredQuestionIds: [],
  });
  const instructionResult = await harness.reclamationService.reclaimInstructionBody({
    deliveryAttemptId: 'attempt-instruction',
  });
  assert.deepEqual(instructionResult, { status: 'complete', deliveryAttemptId: 'attempt-instruction' });
  assert.equal(nativeInstructionWriteCount(harness, fixture.provider), 0);
}

async function makeHarness(t, provider, options = {}) {
  const fixture = await createSeededHarness(provider, options);
  t.after(async () => {
    try { await fixture.harness.close(); } catch {}
    finally {
      fixture.leaseObserver.restore();
      await fixture.removeDirectory();
    }
  });
  await fixture.harness.ready;
  return fixture;
}

for (const provider of PROVIDERS) {
  test(`${provider} retains each grant while its future reservation exceeds the configured limit`, async (t) => {
    const fixture = await makeHarness(t, provider);
    const { harness } = fixture;
    const service = harness.reclamationService;
    assert.equal(typeof service?.releaseMigrationAllowance, 'function');

    const beforeStores = Object.fromEntries(await Promise.all(SLOT_ORDER.map(async (slot) =>
      [slot, await fixture.readJson(slot)])));
    const beforeGrants = grantsIn(beforeStores);
    assert.deepEqual(SLOT_ORDER.filter((slot) => beforeGrants[slot] !== null), SLOT_ORDER);
    const beforeCounts = recordCounts(beforeStores);
    const beforeBytes = await fixture.readSlotBytes();
    const beforeCapacity = harness.reclamationContext.status().coordinator.lease;
    const beforeResizeCount = fixture.leaseObserver.acquisitions[0].events.length;
    assert.ok(beforeCapacity && beforeCapacity.bytes > 0);
    assert.equal(harness.reclamationContext.status().capacity.activeLeaseCount, 1);

    const outcomes = [];
    for (const slot of SLOT_ORDER) {
      const result = await service.releaseMigrationAllowance({ slot });
      assert.deepEqual(Object.keys(result).sort(), ['slot', 'status']);
      assert.equal(result.slot, slot);
      assert.equal(result.status, 'retained');

      const afterStores = Object.fromEntries(await Promise.all(SLOT_ORDER.map(async (currentSlot) =>
        [currentSlot, await fixture.readJson(currentSlot)])));
      const afterGrants = grantsIn(afterStores);
      assert.equal(afterGrants[slot] === null, result.status === 'released');
      for (const other of SLOT_ORDER.filter((candidate) => candidate !== slot)) {
        assert.deepEqual(afterGrants[other], beforeGrants[other]);
      }
      assert.deepEqual(recordCounts(afterStores), beforeCounts);

      const afterCapacity = harness.reclamationContext.status().coordinator.lease;
      assert.ok(afterCapacity && !afterCapacity.released);
      if (result.status === 'retained') assert.equal(afterCapacity.bytes, beforeCapacity.bytes);
      if (result.status === 'released') assert.ok(afterCapacity.bytes < beforeCapacity.bytes);
      assert.equal(harness.reclamationContext.status().capacity.activeLeaseCount, 1);
      outcomes.push(result.status);
    }

    const afterBytes = await fixture.readSlotBytes();
    assert.deepEqual(afterBytes, beforeBytes);
    assert.deepEqual(outcomes, ['retained', 'retained', 'retained']);
    assert.equal(fixture.leaseObserver.acquisitions.length, 1);
    assert.equal(fixture.leaseObserver.acquisitions[0].events.length, beforeResizeCount);
    assert.equal(nativeInstructionWriteCount(harness, provider), 0);
  });

  test(`${provider} releases all grants through one lease after body capacity is reclaimed`, async (t) => {
    const sources = threeSlotLegacySources(provider);
    const fixture = await makeHarness(t, provider, {
      normalByteLimitsBySlot: limitsForPostBodyRelease(sources),
    });
    const { harness, leaseObserver } = fixture;
    const service = harness.reclamationService;
    const migrated = await storesFrom(fixture);
    assert.deepEqual(SLOT_ORDER.filter((slot) => migrated[slot].migrationAllowance !== null), SLOT_ORDER);
    assert.equal(harness.reclamationContext.status().capacity.activeLeaseCount, 1);
    const leaseRecord = leaseObserver.acquisitions[0];
    assert.ok(leaseRecord);
    const originalLease = leaseRecord.lease;

    await prepareBodyCapacity(fixture);
    let priorStores = await storesFrom(fixture);
    let priorBytes = await fixture.readAllBytes();
    const resizeCountBeforeRelease = leaseRecord.events.filter((event) => event.operation === 'resize').length;
    const released = [];
    const releaseOrder = provider === 'claude' ? SLOT_ORDER : [...SLOT_ORDER].reverse();

    for (const slot of releaseOrder) {
      const timelineStart = leaseObserver.timeline.length;
      const leaseBytesBeforeWrite = originalLease.status().bytes;
      const grantBytes = priorStores[slot].migrationAllowance.maxExtraBytes;
      const result = await service.releaseMigrationAllowance({ slot });
      assert.deepEqual(result, { status: 'released', slot });
      released.push(slot);

      const nextStores = await storesFrom(fixture);
      assert.equal(nextStores[slot].migrationAllowance, null);
      assert.deepEqual(withoutReleaseFields(nextStores[slot]), withoutReleaseFields(priorStores[slot]));
      for (const other of SLOT_ORDER.filter((candidate) => candidate !== slot)) {
        assert.deepEqual(nextStores[other], priorStores[other]);
      }
      assert.deepEqual(recordCounts(nextStores), recordCounts(priorStores));

      const nextBytes = await fixture.readAllBytes();
      assert.deepEqual(nextBytes.anchor, priorBytes.anchor);
      for (const other of SLOT_ORDER.filter((candidate) => candidate !== slot)) {
        assert.deepEqual(nextBytes[other], priorBytes[other]);
      }
      assert.ok(nextBytes[slot].length <= fixture.normalByteLimitsBySlot[slot]);

      const resizeEvents = leaseRecord.events.filter((event) => event.operation === 'resize');
      assert.equal(resizeEvents.length, resizeCountBeforeRelease + released.length);
      assert.equal(leaseRecord.lease, originalLease);
      assert.equal(leaseRecord.lease.status().released, false);
      assert.equal(harness.reclamationContext.status().capacity.activeLeaseCount, 1);
      assert.equal(leaseRecord.lease.status().bytes,
        harness.reclamationContext.status().coordinator.lease.bytes);
      assert.equal(leaseRecord.lease.status().bytes, leaseBytesBeforeWrite - grantBytes);
      const releaseEvents = leaseObserver.timeline.slice(timelineStart);
      const writeComplete = releaseEvents.findIndex((event) => event.operation === 'slot-write:complete' &&
        event.slot === slot);
      const readbackComplete = releaseEvents.findIndex((event, index) => index > writeComplete &&
        event.operation === 'slot-read:complete' && event.slot === slot);
      const leaseResize = releaseEvents.findIndex((event, index) => index > readbackComplete &&
        event.operation === 'lease-resize:start');
      const leaseResizeComplete = releaseEvents.findIndex((event, index) => index > leaseResize &&
        event.operation === 'lease-resize:complete');
      assert.ok(writeComplete >= 0);
      assert.ok(readbackComplete > writeComplete);
      assert.ok(leaseResize > readbackComplete);
      assert.equal(releaseEvents[writeComplete].leaseStatus.bytes, leaseBytesBeforeWrite);
      assert.equal(releaseEvents[readbackComplete].leaseStatus.bytes, leaseBytesBeforeWrite);
      assert.equal(releaseEvents[leaseResize].leaseStatus.bytes, leaseBytesBeforeWrite);
      assert.ok(releaseEvents[leaseResizeComplete].status.bytes < leaseBytesBeforeWrite);
      priorStores = nextStores;
      priorBytes = nextBytes;
    }

    const bytesAfterAllReleases = await fixture.readAllBytes();
    const writesBeforeNoop = { ...harness.persistenceWriteCounts };
    for (const slot of SLOT_ORDER) {
      assert.deepEqual(await service.releaseMigrationAllowance({ slot }), { status: 'already_clear', slot });
    }
    assert.deepEqual(await fixture.readAllBytes(), bytesAfterAllReleases);
    assert.deepEqual(harness.persistenceWriteCounts, writesBeforeNoop);
    assert.deepEqual(released, releaseOrder);
    const bytesBeforeRestart = await fixture.readAllBytes();
    const writesBeforeRestart = { ...harness.persistenceWriteCounts };
    await harness.restart();
    assert.equal(originalLease.status().released, true);
    assert.equal(harness.reclamationContext.status().state, 'ready');
    assert.deepEqual(await fixture.readAllBytes(), bytesBeforeRestart);
    assert.deepEqual(harness.persistenceWriteCounts, writesBeforeRestart);
    for (const slot of SLOT_ORDER) {
      assert.equal((await harness.reclamationContext.backend(slot).getSnapshot()).migrationAllowance, null);
    }
    assert.equal(leaseObserver.acquisitions.length, 2);
    const restartedLease = leaseObserver.acquisitions[1].lease;
    assert.equal(restartedLease.status().released, false);
    await harness.close();
    assert.equal(restartedLease.status().released, true);
    assert.equal(harness.reclamationContext.status().capacity.activeLeaseCount, 0);
    assert.equal(nativeInstructionWriteCount(harness, provider), 0);
  });

  for (const slot of SLOT_ORDER) {
    for (const phase of ['before-write', 'after-write', 'readback']) {
      test(`${provider} keeps ${slot} grant release fail-closed after ${phase}`, async (t) => {
      const sources = threeSlotLegacySources(provider);
      const fixture = await makeHarness(t, provider, {
        normalByteLimitsBySlot: limitsForPostBodyRelease(sources),
      });
      const { harness } = fixture;
      await prepareBodyCapacity(fixture);
      const bytesBefore = await fixture.readAllBytes();
      const storesBefore = await storesFrom(fixture);
      assert.deepEqual(SLOT_ORDER.filter((candidate) => storesBefore[candidate].migrationAllowance !== null),
        SLOT_ORDER);
      const writesBefore = { ...harness.persistenceWriteCounts };
      const leaseBytesBefore = fixture.leaseObserver.acquisitions[0].lease.status().bytes;

      harness.faults.arm({ slot, phase });
      await assert.rejects(harness.reclamationService.releaseMigrationAllowance({ slot }));
      assert.equal(harness.reclamationContext.status().state, 'blocked');
      assert.equal(fixture.leaseObserver.acquisitions[0].lease.status().bytes, leaseBytesBefore);
      assert.equal(harness.persistenceWriteCounts[slot], writesBefore[slot] + 1);
      for (const other of SLOT_ORDER.filter((candidate) => candidate !== slot)) {
        assert.equal(harness.persistenceWriteCounts[other], writesBefore[other]);
      }

      const bytesAfterFailure = await fixture.readAllBytes();
      const shouldBeCommitted = phase !== 'before-write';
      if (!shouldBeCommitted) assert.deepEqual(bytesAfterFailure, bytesBefore);
      else {
        assert.deepEqual(bytesAfterFailure.anchor, bytesBefore.anchor);
        for (const other of SLOT_ORDER.filter((candidate) => candidate !== slot)) {
          assert.deepEqual(bytesAfterFailure[other], bytesBefore[other]);
        }
        assert.notDeepEqual(bytesAfterFailure[slot], bytesBefore[slot]);
        assert.equal((await fixture.readJson(slot)).migrationAllowance, null);
      }

      const writesBeforeRestart = { ...harness.persistenceWriteCounts };
      await harness.restart();
      assert.equal(harness.reclamationContext.status().state, 'ready');
      assert.equal(harness.reclamationContext.status().capacity.activeLeaseCount, 1);
      assert.deepEqual(harness.persistenceWriteCounts, writesBeforeRestart);
      const recoveredBytes = await fixture.readAllBytes();
      assert.deepEqual(recoveredBytes, bytesAfterFailure);
      const recoveredStores = await storesFrom(fixture);
      assert.equal(recoveredStores[slot].migrationAllowance === null, shouldBeCommitted);
      if (!shouldBeCommitted) {
        assert.deepEqual(recoveredStores[slot], storesBefore[slot]);
        assert.deepEqual(await harness.reclamationService.releaseMigrationAllowance({ slot }), { status: 'released', slot });
      } else {
        assert.deepEqual(await harness.reclamationService.releaseMigrationAllowance({ slot }), { status: 'already_clear', slot });
      }
      assert.equal(nativeInstructionWriteCount(harness, provider), 0);
      });
    }
  }

  test(`${provider} drains in-flight grant releases before closing their leases`, async (t) => {
    for (const slot of SLOT_ORDER) {
      const sources = threeSlotLegacySources(provider);
      const fixture = await makeHarness(t, provider, {
        normalByteLimitsBySlot: limitsForPostBodyRelease(sources),
      });
      const { harness, leaseObserver } = fixture;
      await prepareBodyCapacity(fixture);
      const lease = leaseObserver.acquisitions[0].lease;
      const writesBefore = { ...harness.persistenceWriteCounts };
      const barrier = harness.faults.holdNextWrite(slot);
      const releasePromise = harness.reclamationService.releaseMigrationAllowance({ slot });
      await barrier.entered;
      let closePromise;
      try {
        closePromise = harness.close();
        assert.equal(harness.reclamationContext.status().closing, true);
      } finally {
        barrier.release();
      }
      const result = await releasePromise;
      await closePromise;
      assert.deepEqual(result, { status: 'released', slot });
      assert.equal((await fixture.readJson(slot)).migrationAllowance, null);
      assert.equal(harness.persistenceWriteCounts[slot], writesBefore[slot] + 1);
      for (const other of SLOT_ORDER.filter((candidate) => candidate !== slot)) {
        assert.equal(harness.persistenceWriteCounts[other], writesBefore[other]);
      }
      assert.equal(harness.reclamationContext.status().state, 'closed');
      assert.equal(harness.reclamationContext.status().capacity.activeLeaseCount, 0);
      assert.equal(lease.status().released, true);
      assert.equal(nativeInstructionWriteCount(harness, provider), 0);
    }
  });

  for (const { slot, closedErrorCode } of [
    { slot: 'questions', closedErrorCode: 'question_gate_closed' },
    { slot: 'checkpoint', closedErrorCode: 'reclamation_service_blocked' },
  ]) {
    test(`${provider} rejects a queued ${slot} grant write after its writer closes`, async (t) => {
      const sources = threeSlotLegacySources(provider);
      const fixture = await makeHarness(t, provider, {
        normalByteLimitsBySlot: limitsForPostBodyRelease(sources),
      });
      const { harness, leaseObserver } = fixture;
      await prepareBodyCapacity(fixture);

      const targetPath = harness.pathFor(slot);
      const targetBytesBefore = await fs.readFile(targetPath);
      const writesBefore = { ...harness.persistenceWriteCounts };
      const instructionSnapshot = harness.reclamationContext.snapshot().stores.instructions;
      const barrier = harness.faults.holdNextWrite('instructions');
      const blockingWrite = harness.reclamationContext.backend('instructions').save({
        ...structuredClone(instructionSnapshot),
        revision: instructionSnapshot.revision + 1,
      });
      await barrier.entered;

      const targetSaveQueued = leaseObserver.waitForNextBackendSave(slot);
      const releasePromise = harness.reclamationService.releaseMigrationAllowance({ slot });
      await targetSaveQueued;
      const writer = leaseObserver.writerForSlot(slot);
      assert.equal(typeof writer?.close, 'function');

      const writerClosePromise = writer.close();
      barrier.release();
      await assert.rejects(releasePromise, { code: closedErrorCode });
      assert.equal(harness.reclamationContext.canWrite(), false);
      await Promise.all([blockingWrite, writerClosePromise]);

      assert.equal(harness.persistenceWriteCounts[slot], writesBefore[slot]);
      assert.equal(harness.persistenceWriteCounts.instructions, writesBefore.instructions + 1);
      assert.deepEqual(await fs.readFile(targetPath), targetBytesBefore);
      assert.notEqual((await fixture.readJson(slot)).migrationAllowance, null);
    });
  }

  for (const resizeFailure of ['retained', 'unknown']) {
    test(`${provider} preserves capacity safety when lease shrink is ${resizeFailure}`, async (t) => {
      const sources = threeSlotLegacySources(provider);
      const fixture = await makeHarness(t, provider, {
        normalByteLimitsBySlot: limitsForPostBodyRelease(sources),
        leaseResizeFailure: resizeFailure,
      });
      const { harness, leaseObserver } = fixture;
      await prepareBodyCapacity(fixture);
      const leaseRecord = leaseObserver.acquisitions[0];
      const leaseBytesBefore = leaseRecord.lease.status().bytes;

      if (resizeFailure === 'retained') {
        assert.deepEqual(await harness.reclamationService.releaseMigrationAllowance({ slot: 'checkpoint' }), {
          status: 'released', slot: 'checkpoint',
        });
        assert.equal((await fixture.readJson('checkpoint')).migrationAllowance, null);
        assert.equal(leaseRecord.lease.status().bytes, leaseBytesBefore);
        assert.equal(harness.reclamationContext.status().state, 'ready');
        assert.equal(harness.reclamationContext.status().capacity.activeLeaseCount, 1);
      } else {
        await assert.rejects(harness.reclamationService.releaseMigrationAllowance({ slot: 'checkpoint' }), {
          code: 'reclamation_capacity_reservation_unknown',
        });
        assert.equal((await fixture.readJson('checkpoint')).migrationAllowance, null);
        assert.equal(harness.reclamationContext.status().state, 'blocked');
        assert.equal(harness.reclamationContext.status().capacity.activeLeaseCount, 1);
        await harness.restart();
        assert.equal(harness.reclamationContext.status().state, 'ready');
        assert.equal((await fixture.readJson('checkpoint')).migrationAllowance, null);
        assert.equal(harness.reclamationContext.status().capacity.activeLeaseCount, 1);
      }
      assert.equal(nativeInstructionWriteCount(harness, provider), 0);
    });
  }

  test(`${provider} rejects malformed release requests without writing files`, async (t) => {
    const fixture = await makeHarness(t, provider);
    const before = await fixture.readAllBytes();
    const writesBefore = { ...fixture.harness.persistenceWriteCounts };
    const service = fixture.harness.reclamationService;

    assert.throws(() => service.releaseMigrationAllowance({ slot: 'unknown' }),
      { code: 'invalid_migration_allowance_release' });
    assert.throws(() => service.releaseMigrationAllowance({ slot: 'questions', extra: true }),
      { code: 'invalid_migration_allowance_release' });
    let getterCalled = false;
    const getterRequest = { slot: 'questions' };
    Object.defineProperty(getterRequest, 'ignored', { enumerable: true, get() {
      getterCalled = true;
      throw new Error('getter_ran');
    } });
    assert.throws(() => service.releaseMigrationAllowance(getterRequest),
      { code: 'invalid_migration_allowance_release' });
    assert.equal(getterCalled, false);

    assert.deepEqual(await fixture.readAllBytes(), before);
    assert.deepEqual(fixture.harness.persistenceWriteCounts, writesBefore);
  });
}

test('source files remain at their fixed configured paths', async () => {
  assert.deepEqual(Object.keys(DATA_FILES).sort(), ['checkpoint', 'instructions', 'questions']);
  for (const basename of Object.values(DATA_FILES)) assert.ok(path.basename(basename) === basename);
  await fs.access(path.join(__dirname, '..', 'src', 'server', 'native-instruction-service-integration.js'));
});
