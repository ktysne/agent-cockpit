'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const { test } = require('node:test');
const { createTemporaryNativeInstructionHarness, PROVIDERS } = require('./support/native-instruction-integration-harness');

async function withHarness(t, options = {}) {
  const harness = await createTemporaryNativeInstructionHarness(options);
  t.after(() => harness.removeDirectory());
  await harness.service.ready();
  return harness;
}

function instruction(started, values = {}) {
  return {
    deliveryAttemptId: values.deliveryAttemptId || `instruction-${started.result.launchRef}-${values.revision || 1}`,
    launchRef: started.result.launchRef,
    logicalMessageId: values.logicalMessageId || `logical-${started.result.launchRef}`,
    revision: values.revision || 1,
    text: values.text || 'integration-only native instruction',
    mode: values.mode || 'steer',
    expectedTurnId: values.expectedTurnId === undefined
      ? started.process?.turnId || started.process?.messageId || 'native-context-fixture'
      : values.expectedTurnId,
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function waitForDelivery(service, id, predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  let current;
  do {
    current = await service.get(id);
    if (predicate(current?.delivery)) return current.delivery;
    await new Promise((resolve) => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.fail(`delivery did not reach the expected state; last state: ${current?.delivery?.state}`);
}

function findDelivery(value, id, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return null;
  seen.add(value);
  if (value.deliveryAttemptId === id && typeof value.state === 'string') return value;
  for (const child of Object.values(value)) {
    const found = findDelivery(child, id, seen);
    if (found) return found;
  }
  return null;
}

async function createAndSend(harness, started, values = {}) {
  const input = instruction(started, values);
  const created = await harness.service.create(input);
  return { input, created, send: () => harness.service.send(input.deliveryAttemptId) };
}

test('Codex send-start is durable before the real runner writes and acknowledgement alone never means applied', async (t) => {
  const persisted = deferred();
  const release = deferred();
  const harness = await withHarness(t, {
    afterCheckpointWrite: async ({ attempt }) => {
      if (attempt === 2) {
        persisted.resolve();
        await release.promise;
      }
    },
  });
  const started = await harness.start('codex', { launchSuffix: 'send-start-order' });
  const { input, created, send } = await createAndSend(harness, started);

  const sending = send();
  await persisted.promise;
  const checkpoint = JSON.parse(await fs.readFile(harness.checkpointPath, 'utf8'));
  assert.equal(findDelivery(checkpoint, input.deliveryAttemptId)?.state, 'sending');
  assert.equal(created.delivery.state, 'available');
  assert.equal(started.process.instructionWrites.length, 0);

  release.resolve();
  const result = await sending;
  const accepted = await waitForDelivery(harness.service, input.deliveryAttemptId, (delivery) => delivery?.state === 'accepted');
  assert.equal(result.delivery.state, 'sending');
  assert.equal(accepted.state, 'accepted');
  assert.equal(started.process.instructionWrites.length, 1);
  assert.equal(started.process.instructionWrites[0].method, 'turn/steer');
  assert.equal(started.process.instructionWrites[0].params.clientUserMessageId, input.deliveryAttemptId);
  assert.equal(accepted.state === 'applied', false);
});

test('a checkpoint failure blocks the native write and leaves later sends unable to retry', async (t) => {
  const harness = await withHarness(t, {
    atomicWriteHook: ({ attempt }) => {
      if (attempt === 2) throw Object.assign(new Error('fixture checkpoint failure'), { code: 'fixture_checkpoint_failure' });
    },
  });
  const started = await harness.start('codex', { launchSuffix: 'checkpoint-failure' });
  const { input, send } = await createAndSend(harness, started);

  await assert.rejects(send(), (error) => Boolean(error?.code));
  assert.equal(started.process.instructionWrites.length, 0);
  await assert.rejects(harness.service.send(input.deliveryAttemptId), (error) => Boolean(error?.code));
  assert.equal(started.process.instructionWrites.length, 0);
  const checkpoint = JSON.parse(await fs.readFile(harness.checkpointPath, 'utf8'));
  assert.equal(findDelivery(checkpoint, input.deliveryAttemptId)?.state, 'available');
});

test('a detach during send-start persistence keeps the old capability bound to its owner', async (t) => {
  const persisted = deferred();
  const release = deferred();
  const harness = await withHarness(t, {
    afterCheckpointWrite: async ({ attempt }) => {
      if (attempt === 3) {
        persisted.resolve();
        await release.promise;
      }
    },
  });
  const first = await harness.start('codex', { launchSuffix: 'owner-a' });
  const second = await harness.start('codex', { launchSuffix: 'owner-b' });
  const { input, send } = await createAndSend(harness, first);
  await harness.service.create(instruction(second, {
    deliveryAttemptId: 'instruction-owner-b',
    logicalMessageId: 'logical-owner-b',
  }));

  const sending = send();
  await persisted.promise;
  assert.equal(first.process.instructionWrites.length, 0);
  assert.equal(second.process.instructionWrites.length, 0);
  assert.equal(await harness.native.stop(first.receipt), true);
  assert.deepEqual(harness.native.getLaunchState(first.receipt), { state: 'stopped' });
  release.resolve();
  const result = await sending;

  assert.equal(result.delivery.state, 'unknown');
  assert.equal(first.process.instructionWrites.length, 0);
  assert.equal(second.process.instructionWrites.length, 0);
  assert.equal((await harness.service.get(input.deliveryAttemptId)).delivery.state, 'unknown');
});

test('the real Codex writer applies only a full matching native user item', async (t) => {
  const harness = await withHarness(t, { fakeRuntime: { instructionEvidence: 'full' } });
  const started = await harness.start('codex', { launchSuffix: 'full-input-evidence' });
  const input = instruction(started, { text: 'the exact user input' });
  await harness.service.create(input);
  await harness.service.send(input.deliveryAttemptId);

  const applied = await waitForDelivery(harness.service, input.deliveryAttemptId, (delivery) => delivery?.state === 'applied');
  assert.equal(started.process.instructionWrites.length, 1);
  assert.equal(applied.state, 'applied');
  assert.equal(applied.appliedCorrelation.nativeItemId, 'codex-user-item-1');
  assert.equal(applied.appliedCorrelation.nativeTurnId, started.process.turnId);
});

test('incomplete native item evidence cannot turn acceptance into applied', async (t) => {
  const harness = await withHarness(t, { fakeRuntime: { instructionEvidence: 'missing-client-id' } });
  const started = await harness.start('codex', { launchSuffix: 'incomplete-input-evidence' });
  const input = instruction(started);
  await harness.service.create(input);
  await harness.service.send(input.deliveryAttemptId);

  const accepted = await waitForDelivery(harness.service, input.deliveryAttemptId, (delivery) =>
    ['accepted', 'unknown'].includes(delivery?.state));
  assert.equal(started.process.instructionWrites.length, 1);
  assert.notEqual(accepted.state, 'applied');
});

for (const provider of PROVIDERS) {
  test(`${provider} keeps unsupported live modes unsent and never converts next-user-input to start`, async (t) => {
    const harness = await withHarness(t);
    const started = await harness.start(provider, { launchSuffix: `unsupported-${provider}` });
    const firstInput = instruction(started, { deliveryAttemptId: `unsupported-steer-${provider}` });
    await harness.service.create(firstInput);

    if (provider === 'codex') {
      await harness.service.send(firstInput.deliveryAttemptId);
      await waitForDelivery(harness.service, firstInput.deliveryAttemptId, (delivery) => delivery?.state === 'accepted');
      assert.equal(started.process.instructionWrites.length, 1);
      assert.equal(started.process.instructionWrites[0].method, 'turn/steer');
      return;
    }

    await assert.rejects(harness.service.send(firstInput.deliveryAttemptId), { code: 'instruction_dispatch_unavailable' });
    assert.equal(started.process.instructionWrites.length, 0);

    const alternative = await harness.service.supersedeUnsent(firstInput.deliveryAttemptId, {
      newDeliveryAttemptId: `unsupported-next-input-${provider}`,
      logicalMessageId: firstInput.logicalMessageId,
      revision: firstInput.revision + 1,
      text: 'next user input stays unsupported',
      mode: 'next-user-input',
      expectedTurnId: null,
    });
    await assert.rejects(harness.service.send(alternative.instruction.deliveryAttemptId), { code: 'instruction_dispatch_unavailable' });
    assert.equal(started.process.instructionWrites.length, 0);
  });
}

for (const provider of PROVIDERS) {
  test(`${provider} starts a new standalone context only after an explicit start instruction`, async (t) => {
    const harness = await withHarness(t);
    const started = await harness.start(provider, { launchSuffix: `explicit-start-${provider}` });
    const previousContext = provider === 'codex' ? started.process.turnId : started.process.messageId;
    assert.equal(started.processHarness.endCurrentContext(), true);
    const input = instruction(started, {
      deliveryAttemptId: `explicit-start-${provider}`,
      mode: 'start',
      expectedTurnId: null,
      text: 'start a new standalone context explicitly',
    });

    await harness.service.create(input);
    await harness.service.send(input.deliveryAttemptId);
    await waitForDelivery(harness.service, input.deliveryAttemptId, (delivery) =>
      ['accepted', 'applied', 'unknown'].includes(delivery?.state));

    assert.equal(started.process.instructionWrites.length, 1);
    if (provider === 'codex') {
      assert.equal(started.process.instructionWrites[0].method, 'turn/start');
      assert.notEqual(started.process.turnId, previousContext);
    } else {
      assert.equal(started.process.instructionWrites[0].type, 'user');
      assert.equal(started.process.instructionWrites[0].session_id, started.process.sessionId);
      assert.notEqual(started.process.messageId, previousContext);
    }
  });
}

test('review launches are rejected and ended delegated contexts are never steered', async (t) => {
  const harness = await withHarness(t);
  const parent = await harness.start('codex', { launchSuffix: 'review-delegated-parent' });
  const review = await harness.native.startLaunch({
    launchId: 'review-launch',
    runId: 'review-run',
    attemptId: 'review-attempt',
    profileId: 'codex',
    origin: 'review',
    purpose: 'cross-review',
    originReceipt: parent.result.runReceipt,
    inputText: 'review fixture bootstrap',
  });
  const reviewProcess = harness.processesByProvider.get('codex').at(-1).state;
  const reviewInput = instruction({ ...review, process: reviewProcess }, { deliveryAttemptId: 'review-instruction' });
  await assert.rejects(harness.service.create(reviewInput), { code: 'instruction_review_not_supported' });
  assert.equal(review.result.accepted, true);
  assert.equal(reviewProcess.instructionWrites.length, 0);

  const delegated = await harness.native.startLaunch({
    launchId: 'delegated-launch',
    runId: 'delegated-run',
    attemptId: 'delegated-attempt',
    profileId: 'codex',
    origin: 'delegated',
    purpose: 'agent',
    originReceipt: parent.result.runReceipt,
    inputText: 'delegated fixture bootstrap',
  });
  const delegatedProcessHarness = harness.processesByProvider.get('codex').at(-1);
  assert.equal(delegatedProcessHarness.endCurrentContext(), true);
  const delegatedInput = instruction({ ...delegated, process: delegatedProcessHarness.state }, {
    deliveryAttemptId: 'ended-delegated-instruction',
    mode: 'steer',
  });
  await harness.service.create(delegatedInput);
  await assert.rejects(harness.service.send(delegatedInput.deliveryAttemptId), { code: 'instruction_dispatch_unavailable' });
  assert.equal(delegatedProcessHarness.state.instructionWrites.length, 0);
});

test('question and permission modes are rejected without native instruction writes', async (t) => {
  const harness = await withHarness(t);
  const started = await harness.start('codex', { launchSuffix: 'question-permission-hold' });

  for (const mode of ['question', 'permission']) {
    const input = instruction(started, {
      deliveryAttemptId: `${mode}-hold-instruction`,
      mode,
    });
    await assert.rejects(harness.service.create(input), { code: 'instruction_invalid_request' });
  }

  assert.equal(started.process.instructionWrites.length, 0);
});

test('a cancelled unsent instruction cannot reach the native pipe', async (t) => {
  const harness = await withHarness(t);
  const started = await harness.start('codex', { launchSuffix: 'cancel-before-send' });
  const input = instruction(started, { deliveryAttemptId: 'cancel-before-send' });
  await harness.service.create(input);
  const cancelled = await harness.service.cancel(input.deliveryAttemptId);
  assert.equal(cancelled.delivery.state, 'cancelled_before_send');
  await assert.rejects(harness.service.send(input.deliveryAttemptId), { code: 'instruction_not_sendable' });
  assert.equal(started.process.instructionWrites.length, 0);
});

for (const provider of PROVIDERS) {
  test(`${provider} cancellation queued before send wins without a native write`, async (t) => {
    const harness = await withHarness(t);
    const started = await harness.start(provider, { launchSuffix: `cancel-race-first-${provider}` });
    const mode = provider === 'claude' ? 'start' : 'steer';
    if (mode === 'start') started.processHarness.endCurrentContext();
    const input = instruction(started, {
      deliveryAttemptId: `cancel-race-first-${provider}`,
      mode,
      expectedTurnId: mode === 'start' ? null : started.process.turnId,
    });
    await harness.service.create(input);

    const cancelling = harness.service.cancel(input.deliveryAttemptId);
    const sending = harness.service.send(input.deliveryAttemptId);
    const [cancelResult, sendResult] = await Promise.allSettled([cancelling, sending]);

    assert.equal(cancelResult.status, 'fulfilled');
    assert.equal(cancelResult.value.delivery.state, 'cancelled_before_send');
    assert.equal(sendResult.status, 'rejected');
    assert.equal(sendResult.reason.code, 'instruction_not_sendable');
    assert.equal(started.process.instructionWrites.length, 0);
  });

  test(`${provider} send-start commit wins over cancellation queued during persistence`, async (t) => {
    const persisted = deferred();
    const release = deferred();
    let sendStartAttempt = null;
    const harness = await withHarness(t, {
      afterCheckpointWrite: async ({ attempt }) => {
        if (attempt === sendStartAttempt) {
          persisted.resolve();
          await release.promise;
        }
      },
    });
    const started = await harness.start(provider, { launchSuffix: `send-race-first-${provider}` });
    const mode = provider === 'claude' ? 'start' : 'steer';
    if (mode === 'start') started.processHarness.endCurrentContext();
    const input = instruction(started, {
      deliveryAttemptId: `send-race-first-${provider}`,
      mode,
      expectedTurnId: mode === 'start' ? null : started.process.turnId,
    });
    await harness.service.create(input);
    sendStartAttempt = harness.checkpointWriteCount + 1;

    const sending = harness.service.send(input.deliveryAttemptId);
    await persisted.promise;
    const cancelling = harness.service.cancel(input.deliveryAttemptId);
    release.resolve();
    const sendResult = await sending;
    const cancelResult = await cancelling;

    assert.equal(started.process.instructionWrites.length, 1);
    assert.notEqual(cancelResult.delivery.state, 'cancelled_before_send');
    assert.ok(['sending', 'accepted', 'applied', 'unknown'].includes(sendResult.delivery.state));
  });
}

test('unknown delivery state survives service restart and never causes a resend', async (t) => {
  const harness = await withHarness(t);
  const started = await harness.start('codex', { launchSuffix: 'unknown-restart' });
  const input = instruction(started, { deliveryAttemptId: 'unknown-restart-instruction' });
  await harness.service.create(input);
  await harness.service.send(input.deliveryAttemptId);
  await waitForDelivery(harness.service, input.deliveryAttemptId, (delivery) => delivery?.state === 'accepted');
  assert.equal((await harness.service.reportResponseLost(input.deliveryAttemptId)).delivery.state, 'unknown');
  assert.equal(started.process.instructionWrites.length, 1);

  await harness.restartService();
  assert.equal((await harness.service.get(input.deliveryAttemptId)).delivery.state, 'unknown');
  await assert.rejects(harness.service.send(input.deliveryAttemptId), { code: 'instruction_not_sendable' });
  assert.equal(started.process.instructionWrites.length, 1);
});

