'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { test } = require('node:test');
const { createNativeQuestionWriteIsolationHarness } = require('./support/native-question-write-isolation-harness');
const { encodeCheckpointV3Local } = require('../src/server/delivery-reclamation-codec');
const {
  limitsForPostBodyRelease,
  threeSlotLegacySources,
} = require('./support/native-migration-allowance-release-harness');
const { PROVIDERS } = require('./support/native-instruction-integration-harness');

const SLOT_NAMES = Object.freeze(['checkpoint', 'instructions', 'questions']);
const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const QUESTION = (questionId) => ({
  questionId,
  timeoutMinutes: 1,
  category: 'ordinary',
  questions: [{
    id: `choice-${questionId}`,
    text: 'Choose an option',
    mode: 'single',
    options: [{ id: 'option-a', label: 'Option A', description: '' }],
    allowFreeText: false,
    recommendedOptionId: 'option-a',
  }],
});

function grantsFrom(bytesBySlot) {
  return Object.fromEntries(SLOT_NAMES.map((slot) => [slot,
    JSON.parse(bytesBySlot[slot].toString('utf8')).migrationAllowance]));
}

function totalNativeInstructionWrites(harness, provider) {
  return harness.processesByProvider.get(provider).reduce((total, process) =>
    total + process.state.instructionWrites.length, 0);
}

async function assertNoTemporaryFiles(harness) {
  assert.deepEqual(await fs.readdir(harness.directory).then((names) => names.filter((name) => name.endsWith('.tmp'))), []);
  await harness.nativeFileSystem.removeTemporaryFiles(harness.directory);
}

async function assertQuestionsUnavailable(harness, started) {
  const readFailure = (error) => ['question_journal_uncertain', 'question_gate_closed'].includes(error?.code);
  const publicStatus = harness.integration.getStatus().commonQuestions;
  assert.equal(publicStatus.status, 'unavailable');
  assert.equal(publicStatus.quarantine.status, 'unavailable');
  assert.equal(publicStatus.quarantine.reason, 'question_journal_uncertain');
  assert.equal(harness.integration.questionService.getQuarantineDiagnostics().status, 'unavailable');
  assert.equal(harness.integration.questionService.getQuarantineDiagnostics().reservedBytes, null);
  await assert.rejects(harness.integration.questionService.dashboardSnapshot(), {
    code: 'question_journal_uncertain',
  });
  await assert.rejects(harness.integration.questionService.status(started.writer, 'unreadable'), readFailure);
  await assert.rejects(harness.integration.questionService.register(started.writer,
    QUESTION(`blocked-${harness.provider}`)), readFailure);
}

for (const provider of PROVIDERS) {
  for (const phase of ['before', 'after']) {
    test(`${provider} resumes prepared question-body reclamation after the final questions rename fails ${phase}`, async (t) => {
      const sources = threeSlotLegacySources(provider);
      const harness = await createNativeQuestionWriteIsolationHarness(provider, {
        sources,
        normalByteLimitsBySlot: {
          checkpoint: sources.checkpoint.length + 16 * 1024,
          instructions: sources.instructions.length + 16 * 1024,
          questions: 16 * 1024 * 1024,
        },
      });
      t.after(() => harness.removeDirectory());

      const before = await harness.readAllBytes();
      const beforeGrants = grantsFrom(before);
      const beforeQuestionJournal = JSON.parse(before.questions.toString('utf8'));
      const beforeAnchor = JSON.parse(before.anchor.toString('utf8'));
      const beforeCapacity = structuredClone(harness.context.status().capacity);
      const retiredPeriod = beforeAnchor.retiredQuestionPeriods.find((period) =>
        period.periodId === sources.question.periodId && period.identity.nativeId === sources.question.identity.nativeId);
      assert.ok(retiredPeriod);
      assert.ok(Object.values(beforeGrants).some((grant) => grant !== null));

      harness.setNow(retiredPeriod.retiredAt + RETENTION_MS);
      harness.nativeFileSystem.armRenameRetryExhaustion({
        targetPath: harness.pathFor('questions'),
        phase,
        occurrence: 2,
      });
      await assert.rejects(harness.integration.reclamation.reclaimQuestionBodies({
        identity: sources.question.identity,
        periodId: sources.question.periodId,
      }), { code: 'EPERM' });

      const afterFailure = await harness.readAllBytes();
      const failedQuestionJournal = JSON.parse(afterFailure.questions.toString('utf8'));
      const failedReservation = failedQuestionJournal.reservations.find((reservation) =>
        reservation.internalQuestionId === sources.question.internalQuestionId);
      const operationId = failedReservation?.reclamation?.operationId;
      assert.equal(typeof operationId, 'string');
      assert.equal(failedReservation.reclamation.preparedAt, harness.now);
      assert.equal(failedQuestionJournal.revision, beforeQuestionJournal.revision + (phase === 'before' ? 1 : 2));
      assert.deepEqual(afterFailure.anchor, before.anchor);
      assert.deepEqual(grantsFrom(afterFailure), beforeGrants);
      assert.deepEqual(afterFailure.instructions, before.instructions);
      assert.deepEqual(harness.context.status().capacity, beforeCapacity);
      assert.equal(harness.context.status().state, 'degraded');
      assert.equal(harness.context.status().canWrite, true);
      assert.equal(harness.context.status().slotHealth.questions, 'uncertain');
      assert.equal(harness.context.status().slotHealth.checkpoint, 'ready');
      assert.equal(harness.context.status().slotHealth.instructions, 'ready');

      const failedDelivery = JSON.parse(afterFailure.checkpoint.toString('utf8')).ledger.deliveries.find((delivery) =>
        delivery.deliveryAttemptId === sources.question.deliveryIntent.deliveryAttemptId);
      assert.equal(failedDelivery.recordType, 'reclaimed');
      assert.equal(failedDelivery.reclamation.operationId, operationId);
      if (phase === 'before') {
        assert.equal(failedReservation.bodyState, 'retained');
        assert.ok(failedQuestionJournal.questions.some((detail) =>
          detail.internalQuestionId === sources.question.internalQuestionId));
      } else {
        assert.equal(failedReservation.bodyState, 'reclaimed');
        assert.equal(failedQuestionJournal.questions.some((detail) =>
          detail.internalQuestionId === sources.question.internalQuestionId), false);
      }
      const failedRenameEvents = harness.nativeFileSystem.events.filter((event) =>
        event.operation === 'rename' && event.targetPath === harness.pathFor('questions') &&
        event.writeOccurrence === 2);
      assert.equal(failedRenameEvents.length, 4);
      await assertNoTemporaryFiles(harness);

      const nativeWritesBeforeRestart = totalNativeInstructionWrites(harness, provider);
      await harness.restart();
      const afterColdRecovery = await harness.readAllBytes();
      const recoveredQuestionJournal = JSON.parse(afterColdRecovery.questions.toString('utf8'));
      const recoveredReservation = recoveredQuestionJournal.reservations.find((reservation) =>
        reservation.internalQuestionId === sources.question.internalQuestionId);
      assert.equal(recoveredReservation.bodyState, 'reclaimed');
      assert.equal(recoveredReservation.reclamation.operationId, operationId);
      assert.equal(recoveredQuestionJournal.questions.some((detail) =>
        detail.internalQuestionId === sources.question.internalQuestionId), false);
      assert.equal(recoveredQuestionJournal.revision, failedQuestionJournal.revision + (phase === 'before' ? 1 : 0));
      assert.deepEqual(afterColdRecovery.anchor, before.anchor);
      assert.deepEqual(afterColdRecovery.checkpoint, afterFailure.checkpoint);
      assert.deepEqual(afterColdRecovery.instructions, before.instructions);
      assert.deepEqual(grantsFrom(afterColdRecovery), beforeGrants);
      assert.equal(harness.context.status().state, 'ready');
      assert.deepEqual(harness.context.status().slotHealth,
        { checkpoint: 'ready', instructions: 'ready', questions: 'ready' });
      assert.ok(harness.context.status().capacity.activeLeaseCount > 0);
      assert.ok(harness.context.status().capacity.reservedBytes > 0);
      assert.equal(harness.integration.getStatus().commonQuestions.status, 'ready');
      assert.equal(harness.integration.questionService.getQuarantineDiagnostics().status, 'ready');
      assert.equal((await harness.integration.questionService.dashboardSnapshot()).recovery, null);
      assert.equal(totalNativeInstructionWrites(harness, provider), nativeWritesBeforeRestart);
      await assertNoTemporaryFiles(harness);

      await harness.restart();
      assert.equal(harness.context.status().state, 'ready');
      assert.deepEqual(await harness.readAllBytes(), afterColdRecovery);
      assert.equal(totalNativeInstructionWrites(harness, provider), nativeWritesBeforeRestart);
    });
  }
}

for (const provider of PROVIDERS) {
  for (const phase of ['before', 'after']) {
    test(`${provider} isolates a bounded questions rename failure at ${phase} rename`, async (t) => {
      const sources = threeSlotLegacySources(provider);
      const maxQuestionBytes = 16 * 1024 * 1024;
      const harness = await createNativeQuestionWriteIsolationHarness(provider, {
        sources,
        normalByteLimitsBySlot: {
          checkpoint: sources.checkpoint.length + 16 * 1024,
          instructions: sources.instructions.length + 16 * 1024,
          questions: maxQuestionBytes,
        },
      });
      t.after(() => harness.removeDirectory());
      const started = await harness.start(provider, `isolated-${phase}`);
      const before = await harness.readAllBytes();
      const beforeGrants = grantsFrom(before);
      assert.notEqual(beforeGrants.checkpoint, null);
      const beforeCapacity = structuredClone(harness.context.status().capacity);
      const questionDelivery = JSON.parse(before.checkpoint.toString('utf8')).ledger.deliveries
        .find((delivery) => delivery.kind === 'question');
      const nativeWritesBefore = totalNativeInstructionWrites(harness, provider);
      harness.nativeFileSystem.armRenameRetryExhaustion({
        targetPath: harness.pathFor('questions'),
        phase,
      });

      await assert.rejects(harness.integration.questionService.register(started.writer,
        QUESTION(`uncertain-${provider}-${phase}`)), { code: 'EPERM' });

      const afterFailure = await harness.readAllBytes();
      if (phase === 'before') {
        assert.deepEqual(afterFailure.questions, before.questions);
      } else {
        assert.notDeepEqual(afterFailure.questions, before.questions);
        const questionSnapshot = JSON.parse(afterFailure.questions.toString('utf8'));
        assert.ok(questionSnapshot.questions.some((item) => item.questionId === `uncertain-${provider}-${phase}`));
      }
      assert.deepEqual(afterFailure.checkpoint, before.checkpoint);
      assert.deepEqual(afterFailure.instructions, before.instructions);
      assert.deepEqual(afterFailure.anchor, before.anchor);
      assert.deepEqual(grantsFrom(afterFailure), beforeGrants);
      assert.deepEqual(harness.context.status().capacity, beforeCapacity);
      assert.equal(harness.context.status().state, 'degraded');
      assert.equal(harness.context.status().canWrite, true);
      assert.equal(harness.context.status().slotHealth.questions, 'uncertain');
      assert.equal(harness.context.status().slotHealth.checkpoint, 'ready');
      assert.equal(harness.context.status().slotHealth.instructions, 'ready');
      const failedCheckpoint = JSON.parse(afterFailure.checkpoint.toString('utf8'));
      assert.deepEqual(failedCheckpoint.ledger.deliveries.find((delivery) => delivery.kind === 'question'),
        questionDelivery);
      assert.equal(harness.nativeFileSystem.renameCalls(harness.pathFor('questions')), 4);
      assert.equal(harness.nativeFileSystem.cleanupCalls(harness.pathFor('questions')), 1);
      await assertNoTemporaryFiles(harness);
      await assertQuestionsUnavailable(harness, started);
      assert.equal(totalNativeInstructionWrites(harness, provider), nativeWritesBefore);

      const checkpointBackend = harness.context.backend('checkpoint');
      const invalidCheckpoint = await checkpointBackend.load();
      invalidCheckpoint.revision += 1;
      invalidCheckpoint.migrationAllowance = null;
      assert.doesNotThrow(() => encodeCheckpointV3Local(invalidCheckpoint));
      await assert.rejects(checkpointBackend.save(invalidCheckpoint), {
        code: 'question_uncertain_transition_rejected',
      });
      const afterRejectedCheckpoint = await harness.readAllBytes();
      assert.deepEqual(afterRejectedCheckpoint.checkpoint, afterFailure.checkpoint);
      assert.deepEqual(grantsFrom(afterRejectedCheckpoint), beforeGrants);
      assert.deepEqual(harness.context.status().capacity, beforeCapacity);
      assert.equal(harness.context.status().state, 'degraded');

      const cancelled = await harness.integration.service.cancel('attempt-instruction');
      assert.equal(cancelled.outcome, 'cancelled');
      harness.setNow(harness.now + 604_800_000);
      const reclaimed = await harness.integration.reclamation.reclaimInstructionBody({
        deliveryAttemptId: 'attempt-instruction',
      });
      assert.deepEqual(reclaimed, { status: 'complete', deliveryAttemptId: 'attempt-instruction' });

      const afterInstructionWork = await harness.readAllBytes();
      assert.deepEqual(afterInstructionWork.questions, afterFailure.questions);
      assert.deepEqual(afterInstructionWork.anchor, afterFailure.anchor);
      assert.deepEqual(grantsFrom(afterInstructionWork), beforeGrants);
      assert.deepEqual(harness.context.status().capacity, beforeCapacity);
      assert.equal(harness.context.status().state, 'degraded');
      assert.equal(harness.context.status().slotHealth.questions, 'uncertain');
      assert.equal(JSON.parse(afterInstructionWork.instructions.toString('utf8')).instructions
        .find((record) => record.deliveryAttemptId === 'attempt-instruction').recordType, 'reclaimed');
      const instructionCheckpoint = JSON.parse(afterInstructionWork.checkpoint.toString('utf8'));
      assert.equal(instructionCheckpoint.ledger.deliveries.find((delivery) =>
        delivery.deliveryAttemptId === 'attempt-instruction').recordType, 'reclaimed');
      assert.deepEqual(instructionCheckpoint.ledger.deliveries.find((delivery) => delivery.kind === 'question'),
        questionDelivery);
      assert.equal(totalNativeInstructionWrites(harness, provider), nativeWritesBefore);
      await assertNoTemporaryFiles(harness);

      const writesBeforeRestart = totalNativeInstructionWrites(harness, provider);
      await harness.restart();
      const afterColdStart = await harness.readAllBytes();
      if (phase === 'before') {
        assert.deepEqual(afterColdStart, afterInstructionWork);
      } else {
        const anchorBeforeColdStart = JSON.parse(afterInstructionWork.anchor.toString('utf8'));
        const anchorAfterColdStart = JSON.parse(afterColdStart.anchor.toString('utf8'));
        const questionBeforeColdStart = JSON.parse(afterInstructionWork.questions.toString('utf8'));
        const questionAfterColdStart = JSON.parse(afterColdStart.questions.toString('utf8'));
        const uncertainQuestionId = `uncertain-${provider}-${phase}`;
        const reservationBeforeColdStart = questionBeforeColdStart.reservations.find((reservation) =>
          reservation.questionId === uncertainQuestionId);
        const reservationAfterColdStart = questionAfterColdStart.reservations.find((reservation) =>
          reservation.questionId === uncertainQuestionId);
        const detailBeforeColdStart = questionBeforeColdStart.questions.find((question) =>
          question.questionId === uncertainQuestionId);
        const detailAfterColdStart = questionAfterColdStart.questions.find((question) =>
          question.questionId === uncertainQuestionId);
        const retiredPeriod = anchorAfterColdStart.retiredQuestionPeriods.find((period) =>
          period.periodId === reservationAfterColdStart.periodId &&
          period.identity.nativeId === reservationAfterColdStart.identity.nativeId);
        assert.equal(questionAfterColdStart.revision, questionBeforeColdStart.revision + 1);
        assert.deepEqual(questionAfterColdStart.questions.filter((question) =>
          question.questionId !== uncertainQuestionId), questionBeforeColdStart.questions.filter((question) =>
          question.questionId !== uncertainQuestionId));
        assert.deepEqual(questionAfterColdStart.reservations.filter((reservation) =>
          reservation.questionId !== uncertainQuestionId), questionBeforeColdStart.reservations.filter((reservation) =>
          reservation.questionId !== uncertainQuestionId));
        assert.deepEqual(detailAfterColdStart, { ...detailBeforeColdStart, quarantinedAt: harness.now });
        assert.deepEqual(reservationAfterColdStart, {
          ...reservationBeforeColdStart,
          quarantinedAt: harness.now,
        });
        assert.equal(anchorAfterColdStart.revision, anchorBeforeColdStart.revision + 1);
        assert.deepEqual(anchorAfterColdStart.retiredQuestionPeriods.slice(0,
          anchorBeforeColdStart.retiredQuestionPeriods.length), anchorBeforeColdStart.retiredQuestionPeriods);
        assert.equal(anchorAfterColdStart.retiredQuestionPeriods.length,
          anchorBeforeColdStart.retiredQuestionPeriods.length + 1);
        assert.deepEqual(retiredPeriod.identity, reservationAfterColdStart.identity);
        assert.equal(retiredPeriod.periodId, reservationAfterColdStart.periodId);
        assert.equal(retiredPeriod.retiredAt, harness.now);
        assert.equal(retiredPeriod.reason, 'startup-quarantine');
        assert.deepEqual(afterColdStart.checkpoint, afterInstructionWork.checkpoint);
        assert.deepEqual(afterColdStart.instructions, afterInstructionWork.instructions);
        await assert.rejects(harness.integration.questionService.register(started.writer,
          QUESTION(`blocked-after-cold-${provider}`)), { code: 'question_writer_unverified' });
      }
      assert.deepEqual(grantsFrom(afterColdStart), beforeGrants);
      assert.equal(harness.context.status().state, 'ready');
      assert.equal(harness.context.status().canWrite, true);
      assert.deepEqual(harness.context.status().slotHealth,
        { checkpoint: 'ready', instructions: 'ready', questions: 'ready' });
      assert.ok(harness.context.status().capacity.activeLeaseCount > 0);
      assert.ok(harness.context.status().capacity.reservedBytes > 0);
      const questionStatus = harness.integration.getStatus().commonQuestions;
      assert.equal(questionStatus.status, 'ready');
      assert.equal(questionStatus.quarantine.status, 'ready');
      assert.equal(harness.integration.questionService.getQuarantineDiagnostics().status, 'ready');
      const coldDashboard = await harness.integration.questionService.dashboardSnapshot();
      assert.equal(coldDashboard.recovery, null);
      const afterColdReads = await harness.readAllBytes();
      assert.deepEqual(afterColdReads, afterColdStart);
      assert.equal(totalNativeInstructionWrites(harness, provider), writesBeforeRestart);

      await harness.restart();
      assert.equal(harness.context.status().state, 'ready');
      assert.equal(harness.integration.getStatus().commonQuestions.status, 'ready');
      assert.deepEqual(await harness.readAllBytes(), afterColdStart);
      assert.equal(totalNativeInstructionWrites(harness, provider), writesBeforeRestart);
    });
  }
}

for (const provider of PROVIDERS) {
  for (const phase of ['before', 'after']) {
    test(`${provider} keeps checkpoint rename failure global and validates the persisted ${phase} result on cold start`, async (t) => {
      const maxSlotBytes = 16 * 1024 * 1024;
      const harness = await createNativeQuestionWriteIsolationHarness(provider, {
        normalByteLimitsBySlot: {
          checkpoint: maxSlotBytes,
          instructions: maxSlotBytes,
          questions: maxSlotBytes,
        },
      });
      t.after(() => harness.removeDirectory());
      const before = await harness.readAllBytes();
      const beforeCapacity = structuredClone(harness.context.status().capacity);
      harness.nativeFileSystem.armRenameRetryExhaustion({
        targetPath: harness.pathFor('checkpoint'),
        phase,
      });

      await assert.rejects(harness.integration.service.cancel('attempt-instruction'), { code: 'EPERM' });
      const afterFailure = await harness.readAllBytes();
      assert.equal(harness.context.status().state, 'blocked');
      assert.equal(harness.context.status().canWrite, false);
      assert.equal(harness.context.status().failureCode, 'EPERM');
      assert.deepEqual(harness.context.status().slotHealth,
        { checkpoint: 'blocked', instructions: 'blocked', questions: 'blocked' });
      assert.equal(harness.context.status().questionFailureCode, null);
      assert.deepEqual(harness.context.status().capacity, beforeCapacity);
      assert.deepEqual(afterFailure.anchor, before.anchor);
      assert.deepEqual(afterFailure.instructions, before.instructions);
      assert.deepEqual(afterFailure.questions, before.questions);
      if (phase === 'before') {
        assert.deepEqual(afterFailure.checkpoint, before.checkpoint);
      } else {
        assert.notDeepEqual(afterFailure.checkpoint, before.checkpoint);
        const persisted = JSON.parse(afterFailure.checkpoint.toString('utf8'));
        assert.equal(persisted.ledger.deliveries.find((delivery) =>
          delivery.deliveryAttemptId === 'attempt-instruction').state, 'cancelled_before_send');
      }
      await assertNoTemporaryFiles(harness);

      const writesBeforeColdStart = totalNativeInstructionWrites(harness, provider);
      await harness.restart();
      assert.equal(harness.context.status().state, 'ready');
      assert.equal(harness.context.status().canWrite, true);
      assert.equal(harness.integration.getStatus().commonQuestions.status, 'ready');
      assert.deepEqual(await harness.readAllBytes(), afterFailure);
      assert.equal(totalNativeInstructionWrites(harness, provider), writesBeforeColdStart);
    });
  }
}

for (const provider of PROVIDERS) {
  for (const phase of ['before', 'after']) {
    test(`${provider} does not isolate a question grant release rename failure at ${phase} rename`, async (t) => {
      const sources = threeSlotLegacySources(provider);
      const harness = await createNativeQuestionWriteIsolationHarness(provider, {
        sources,
        normalByteLimitsBySlot: limitsForPostBodyRelease(sources),
      });
      t.after(() => harness.removeDirectory());
      const migrated = await harness.readAllBytes();
      const originalGrants = grantsFrom(migrated);
      assert.ok(SLOT_NAMES.every((slot) => originalGrants[slot] !== null));

      harness.setNow(harness.now + 604_800_000);
      assert.deepEqual(await harness.integration.reclamation.reclaimQuestionBodies({
        identity: sources.question.identity,
        periodId: sources.question.periodId,
      }), {
        status: 'complete',
        reclaimedQuestionIds: ['internal-1'],
        deferredQuestionIds: [],
      });
      const beforeRelease = await harness.readAllBytes();
      const beforeCapacity = structuredClone(harness.context.status().capacity);
      assert.ok(JSON.parse(beforeRelease.questions.toString('utf8')).questions.length === 0);
      assert.deepEqual(grantsFrom(beforeRelease), originalGrants);
      harness.nativeFileSystem.armRenameRetryExhaustion({
        targetPath: harness.pathFor('questions'),
        phase,
      });

      await assert.rejects(harness.integration.reclamation.releaseMigrationAllowance({ slot: 'questions' }), {
        code: 'EPERM',
      });
      const afterFailure = await harness.readAllBytes();
      assert.equal(harness.context.status().state, 'blocked');
      assert.equal(harness.context.status().canWrite, false);
      assert.equal(harness.context.status().failureCode, 'EPERM');
      assert.equal(harness.context.status().questionFailureCode, null);
      assert.deepEqual(harness.context.status().slotHealth,
        { checkpoint: 'blocked', instructions: 'blocked', questions: 'blocked' });
      assert.deepEqual(harness.context.status().capacity, beforeCapacity);
      assert.deepEqual(afterFailure.anchor, beforeRelease.anchor);
      assert.deepEqual(afterFailure.checkpoint, beforeRelease.checkpoint);
      assert.deepEqual(afterFailure.instructions, beforeRelease.instructions);
      if (phase === 'before') {
        assert.deepEqual(afterFailure.questions, beforeRelease.questions);
        assert.notEqual(grantsFrom(afterFailure).questions, null);
      } else {
        assert.notDeepEqual(afterFailure.questions, beforeRelease.questions);
        assert.equal(grantsFrom(afterFailure).questions, null);
      }
      await assertNoTemporaryFiles(harness);
      await assert.rejects(harness.integration.service.cancel('attempt-instruction'), {
        code: 'reclamation_service_blocked',
      });

      const writesBeforeColdStart = totalNativeInstructionWrites(harness, provider);
      await harness.restart();
      assert.equal(harness.context.status().state, 'ready');
      assert.equal(harness.context.status().canWrite, true);
      assert.deepEqual(await harness.readAllBytes(), afterFailure);
      assert.equal(totalNativeInstructionWrites(harness, provider), writesBeforeColdStart);
    });
  }
}
