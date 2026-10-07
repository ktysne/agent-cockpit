'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { atomicWriteJson } = require('../src/server/json-storage');
const { createInstructionHarness } = require('./support/instruction-harness');
const { functionSource } = require('./support/page-context');

const page = fsSync.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8').replace(/\r\n/g, '\n');
const oldAttemptId = 'restart-old-attempt';
const newAttemptId = 'restart-new-attempt';
const logicalMessageId = 'restart-logical-message';
const fixedText = '再起動後も同じ本文で保存結果を確認する';

function loadInstructionAlternativeRetryState() {
  const names = [
    'instructionTargetFor',
    'instructionTargetMode',
    'findInstructionRecord',
    'sameInstructionIdentity',
    'instructionAlternativeRetryState',
  ];
  const sources = names.map((name) => functionSource(page, name));
  assert.ok(sources.every(Boolean), '実UIのretry helper一式を読み込める');
  const context = vm.createContext({});
  vm.runInContext(sources.join('\n') + '\nthis.retryState = instructionAlternativeRetryState;', context);
  return context.retryState;
}

function dashboardToUiState(harness, dashboard) {
  const launch = harness.launch;
  const executions = harness.registrationRegistry.snapshot().executions.filter((item) =>
    item.executionId === launch.executionBinding.periodId && item.sessionId === launch.sessionId);
  assert.equal(executions.length, 1);
  const execution = executions[0];
  const targetState = harness.targetState();
  const session = {
    session_id: execution.sessionId,
    instructions: dashboard.instructions.map((instruction) => {
      assert.equal(instruction.launchRef, launch.launchRef);
      assert.equal(instruction.sessionId, execution.sessionId);
      assert.equal(instruction.executionId, launch.executionBinding.periodId);
      return {
        ...instruction,
        registrationExecutionId: execution.executionId,
        executionState: execution.state,
      };
    }),
  };
  const target = {
    launchRef: launch.launchRef,
    sessionId: execution.sessionId,
    executionId: execution.executionId,
    identity: { ...launch.identity },
    origin: launch.origin,
    purpose: launch.purpose,
    status: targetState.status,
    nativeTurnId: targetState.nativeTurnId,
    reason: targetState.reason,
  };
  const recovery = dashboard.recovery || {};
  return {
    sessions: [session],
    instructionTargets: [target],
    instructionDiagnostics: {
      service: recovery.status || 'ready',
      targets: 'available',
      ...(recovery.blocked === true ? { blocked: true } : {}),
      ...(recovery.errorCode ? { errorCode: recovery.errorCode } : {}),
      ...(recovery.unmatchedCount ? { unmatchedCount: recovery.unmatchedCount } : {}),
    },
  };
}

function retryRequest(uiState) {
  const session = uiState.sessions[0];
  const old = session.instructions.find((item) => item.deliveryAttemptId === oldAttemptId);
  const created = session.instructions.find((item) => item.deliveryAttemptId === newAttemptId);
  assert.ok(old);
  assert.ok(created);
  return {
    oldDeliveryAttemptId: old.deliveryAttemptId,
    newDeliveryAttemptId: created.deliveryAttemptId,
    logicalMessageId: created.logicalMessageId,
    revision: created.revision,
    launchRef: created.launchRef,
    sessionId: session.session_id,
    executionId: created.executionId,
    registrationExecutionId: created.registrationExecutionId,
    text: fixedText,
    mode: created.mode,
    expectedTurnId: null,
  };
}

function createdCheckpointWriter(attempts) {
  let injectedFailureCount = 0;
  return async (filePath, checkpoint) => {
    const deliveryAttemptIds = checkpoint.ledger.deliveries.map((item) => item.deliveryAttemptId);
    const attempt = { deliveryAttemptIds, failed: false, committed: false };
    attempts.push(attempt);
    if (deliveryAttemptIds.includes(newAttemptId) && injectedFailureCount === 0) {
      injectedFailureCount += 1;
      attempt.failed = true;
      throw new Error('checkpoint write fixture failure');
    }
    await atomicWriteJson(path.dirname(filePath), path.basename(filePath), checkpoint);
    attempt.committed = true;
  };
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

test('checkpoint失敗後は再起動して固定要求だけで欠損配送を補完する', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-instruction-recovery-'));
  const checkpointAttempts = [];
  const retryState = loadInstructionAlternativeRetryState();
  const harnesses = [];
  t.after(async () => {
    await Promise.all(harnesses.map((harness) => harness.close()));
    await fs.rm(directory, { recursive: true, force: true });
  });

  const checkpointWriter = createdCheckpointWriter(checkpointAttempts);
  const first = createInstructionHarness({
    provider: 'codex',
    origin: 'standalone',
    state: 'stopped',
    directory,
    atomicWrite: checkpointWriter,
  });
  harnesses.push(first);
  await first.ready();

  const original = await first.service.create({
    deliveryAttemptId: oldAttemptId,
    launchRef: first.launch.launchRef,
    logicalMessageId,
    revision: 1,
    text: '元の指示',
    mode: 'start',
    expectedTurnId: null,
  });
  const alternative = {
    newDeliveryAttemptId: newAttemptId,
    logicalMessageId,
    revision: original.instruction.revision + 1,
    text: fixedText,
    mode: 'next-user-input',
    expectedTurnId: null,
  };

  await assert.rejects(first.service.supersedeUnsent(oldAttemptId, alternative), {
    code: 'checkpoint_write_failed',
  });
  assert.equal(checkpointAttempts.filter((item) => item.failed).length, 1);

  const failedDashboard = await first.service.dashboardSnapshot();
  assert.equal(failedDashboard.recovery.status, 'blocked');
  assert.equal(failedDashboard.recovery.blocked, true);
  assert.equal(failedDashboard.recovery.errorCode, 'instruction_delivery_missing');
  assert.equal(failedDashboard.recovery.unmatchedCount, 1);
  assert.equal(failedDashboard.instructions.find((item) => item.deliveryAttemptId === oldAttemptId).state,
    'superseded_before_send');
  const missing = failedDashboard.instructions.find((item) => item.deliveryAttemptId === newAttemptId);
  assert.equal(missing.state, 'unavailable');
  assert.equal(missing.heldReason, 'instruction_delivery_missing');

  const failedUiState = dashboardToUiState(first, failedDashboard);
  const savedRequest = retryRequest(failedUiState);
  assert.equal(savedRequest.executionId, missing.executionId);
  assert.equal(savedRequest.registrationExecutionId, failedUiState.instructionTargets[0].executionId);
  assert.equal(retryState(failedUiState, savedRequest).allowed, true);

  for (const changedRequest of [
    { ...savedRequest, oldDeliveryAttemptId: 'another-old-attempt' },
    { ...savedRequest, newDeliveryAttemptId: 'another-new-attempt' },
    { ...savedRequest, sessionId: 'another-session' },
    { ...savedRequest, executionId: 'another-period' },
    { ...savedRequest, registrationExecutionId: 'another-registration' },
    { ...savedRequest, revision: savedRequest.revision + 1 },
  ]) {
    assert.equal(retryState(failedUiState, changedRequest).allowed, false);
  }
  for (const targetChange of [{ status: 'working' }, { origin: 'delegated' }]) {
    const changedTargetState = {
      ...failedUiState,
      instructionTargets: failedUiState.instructionTargets.map((target) => ({ ...target, ...targetChange })),
    };
    assert.equal(retryState(changedTargetState, savedRequest).allowed, false);
  }
  const otherBlockedReason = {
    ...failedUiState,
    instructionDiagnostics: {
      ...failedUiState.instructionDiagnostics,
      errorCode: 'instruction_delivery_unavailable',
    },
  };
  assert.equal(retryState(otherBlockedReason, savedRequest).allowed, false);

  const checkpointCallsBeforeBlockedRetry = checkpointAttempts.length;
  await assert.rejects(first.service.supersedeUnsent(oldAttemptId, alternative), {
    code: 'store_writer_blocked',
  });
  assert.equal(first.writes.length, 0);
  assert.equal(checkpointAttempts.length, checkpointCallsBeforeBlockedRetry);

  const journalBeforeRestart = await readJson(first.journalPath);
  const checkpointBeforeRestart = await readJson(first.checkpointPath);
  assert.equal(journalBeforeRestart.instructions.filter((item) =>
    item.deliveryAttemptId === newAttemptId).length, 1);
  assert.deepEqual(checkpointBeforeRestart.ledger.deliveries.map((item) => [
    item.deliveryAttemptId,
    item.state,
  ]), [[oldAttemptId, 'superseded_before_send']]);

  await first.close();

  const recovered = createInstructionHarness({
    provider: 'codex',
    origin: 'standalone',
    state: 'stopped',
    directory,
    atomicWrite: checkpointWriter,
  });
  harnesses.push(recovered);
  await recovered.ready();

  const restartDashboard = await recovered.service.dashboardSnapshot();
  const restartUiState = dashboardToUiState(recovered, restartDashboard);
  assert.equal(retryState(restartUiState, savedRequest).allowed, true);

  const restored = await recovered.service.supersedeUnsent(oldAttemptId, alternative);
  assert.equal(restored.instruction.deliveryAttemptId, newAttemptId);
  assert.equal(restored.delivery.state, 'available');
  assert.equal(recovered.writes.length, 0);

  const readyDashboard = await recovered.service.dashboardSnapshot();
  assert.equal(readyDashboard.recovery.status, 'ready');
  assert.equal(readyDashboard.recovery.blocked, false);
  assert.equal(readyDashboard.recovery.unmatchedCount, 0);

  const journalAfterRecovery = await readJson(recovered.journalPath);
  assert.equal(journalAfterRecovery.instructions.filter((item) =>
    item.deliveryAttemptId === newAttemptId).length, 1);
  const checkpointAfterRecovery = await readJson(recovered.checkpointPath);
  assert.deepEqual(checkpointAfterRecovery.ledger.deliveries.map((item) => [
    item.deliveryAttemptId,
    item.state,
  ]), [
    [oldAttemptId, 'superseded_before_send'],
    [newAttemptId, 'available'],
  ]);
  assert.equal(checkpointAttempts.filter((item) =>
    item.deliveryAttemptIds.includes(newAttemptId) && item.committed).length, 1);

  const checkpointCallsAfterRecovery = checkpointAttempts.length;
  const journalBytesAfterRecovery = await fs.readFile(recovered.journalPath, 'utf8');
  const checkpointBytesAfterRecovery = await fs.readFile(recovered.checkpointPath, 'utf8');
  await assert.rejects(recovered.service.supersedeUnsent(oldAttemptId, {
    ...alternative,
    newDeliveryAttemptId: 'changed-new-attempt',
  }), { code: 'instruction_logical_conflict' });
  await assert.rejects(recovered.service.supersedeUnsent(oldAttemptId, {
    ...alternative,
    text: fixedText + '変更',
  }), { code: 'instruction_attempt_conflict' });
  await assert.rejects(recovered.service.supersedeUnsent(oldAttemptId, {
    ...alternative,
    revision: alternative.revision + 1,
  }), { code: 'instruction_attempt_conflict' });
  await assert.rejects(recovered.service.supersedeUnsent(oldAttemptId, {
    ...alternative,
    launchRef: 'another-launch',
  }), { code: 'instruction_invalid_request' });
  await assert.rejects(recovered.service.supersedeUnsent('another-old-attempt', alternative), {
    code: 'instruction_not_found',
  });
  assert.equal(checkpointAttempts.length, checkpointCallsAfterRecovery);
  assert.equal(recovered.writes.length, 0);
  assert.equal(await fs.readFile(recovered.journalPath, 'utf8'), journalBytesAfterRecovery);
  assert.equal(await fs.readFile(recovered.checkpointPath, 'utf8'), checkpointBytesAfterRecovery);
});
