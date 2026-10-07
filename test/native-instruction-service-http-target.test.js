'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createOwnedNativeRunner } = require('../src/server/owned-native-runner');
const { startNativeInstructionServer } = require('../src/server/native-instruction-service-integration');
const { createFakeNativeProcess } = require('./support/native-instruction-integration-harness');
const { jsonBody, request, uiHeaders } = require('./support/server');

const PROVIDERS = ['claude', 'codex'];

function profiles(directory) {
  return Object.fromEntries(PROVIDERS.map((provider) => [provider, {
    provider,
    executablePath: process.execPath,
    homePath: path.join(directory, 'homes', provider),
    homeScopeId: `http-target-${provider}-home`,
    cwd: path.join(directory, 'workspaces', provider),
  }]));
}

async function withRuntime(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'native-instruction-http-target-'));
  const processesByProvider = new Map(PROVIDERS.map((provider) => [provider, []]));
  const processes = [];
  const profileMap = profiles(directory);
  await Promise.all(Object.values(profileMap).flatMap((profile) => [profile.homePath, profile.cwd]
    .map((target) => fs.mkdir(target, { recursive: true }))));
  const runtime = await startNativeInstructionServer({
    integrationOptions: {
      profiles: profileMap,
      dataDirectory: path.join(directory, 'native-state'),
      hostId: 'native-instruction-http-target-test-host',
      getAuthentication: () => ({ oauthToken: 'fixture-oauth-token' }),
      onAuthenticationRequired: ({ loginId }) => {
        const processHarness = processesByProvider.get('codex').at(-1);
        if (!processHarness?.completeLogin(loginId)) throw new Error('fixture_login_unavailable');
      },
      runnerFactory(runnerOptions) {
        const processHarness = createFakeNativeProcess(runnerOptions.provider, runnerOptions.homePath, {
          nativeIdSuffix: processes.length + 1,
          ...(options.waitOnStart && runnerOptions.provider === 'codex' ? { waitOnStart: true } : {}),
          ...(options.instructionWriteError && runnerOptions.provider === 'codex' ? { instructionWriteError: true } : {}),
        });
        processes.push(processHarness);
        processesByProvider.get(runnerOptions.provider).push(processHarness);
        const runnerOptionsWithTransport = {
          ...runnerOptions,
          ...(options.waitOnStart && runnerOptions.provider === 'codex' ? {
            profile: 'cockpit-native-wait-v1',
            onWaitRequired() {},
          } : {}),
          spawnImpl: processHarness.spawnImpl,
          timeouts: { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 250 },
        };
        return createOwnedNativeRunner(runnerOptionsWithTransport);
      },
    },
    serverOptions: {
      homeDir: path.join(directory, 'dashboard-home'),
      claudeHome: path.join(directory, 'claude-home'),
      userHome: path.join(directory, 'user-home'),
      port: 0,
      ...(options.spoofCallback ? { instructionTargetState: () => ({ status: 'unverified', nativeTurnId: null, reason: 'fixture_callback_must_not_win' }) } : {}),
    },
  });
  t.after(async () => {
    try { await runtime.close(); } finally { await fs.rm(directory, { recursive: true, force: true }); }
  });
  return { directory, runtime, processesByProvider, processes };
}

async function startLaunch(harness, provider, suffix, options = {}) {
  return harness.runtime.native.startLaunch({
    launchId: `launch-${provider}-${suffix}`,
    runId: `run-${provider}-${suffix}`,
    attemptId: `attempt-${provider}-${suffix}`,
    profileId: provider,
    origin: options.origin || 'standalone',
    purpose: 'agent',
    ...(options.originReceipt ? { originReceipt: options.originReceipt } : {}),
    inputText: `native HTTP target ${provider} ${suffix}`,
  });
}

async function readState(runtime) {
  const response = await request(runtime.info.port, {
    path: '/api/state',
    headers: uiHeaders(runtime.info, `http://127.0.0.1:${runtime.info.port}`),
  });
  assert.equal(response.status, 200);
  return jsonBody(response);
}

function targetFor(state, launchRef) {
  return state.instructionTargets.find((item) => item.launchRef === launchRef);
}

function instructionBody(started, values = {}) {
  return {
    session_id: started.result.observation.sessionId,
    execution_id: started.result.observation.executionId,
    launch_ref: started.result.launchRef,
    delivery_attempt_id: values.deliveryAttemptId || 'http-native-target-attempt',
    logical_message_id: values.logicalMessageId || 'http-native-target-logical',
    revision: 1,
    text: 'HTTP native target instruction fixture',
    mode: values.mode || 'start',
    expected_turn_id: Object.hasOwn(values, 'expectedTurnId') ? values.expectedTurnId : null,
    ...(values.overrides || {}),
  };
}

async function post(runtime, pathname, body) {
  return request(runtime.info.port, {
    method: 'POST',
    path: pathname,
    headers: uiHeaders(runtime.info, `http://127.0.0.1:${runtime.info.port}`, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

async function createInstruction(runtime, started, values = {}) {
  const body = instructionBody(started, values);
  const response = await post(runtime, '/api/instructions/create', body);
  return { body, response };
}

async function sendInstruction(runtime, started, deliveryAttemptId) {
  return post(runtime, `/api/instructions/${deliveryAttemptId}/send`, {
    session_id: started.result.observation.sessionId,
    execution_id: started.result.observation.executionId,
  });
}

test('the native HTTP helper derives Codex steer authority and rejects an old turn or another launch', async (t) => {
  const harness = await withRuntime(t);
  const first = await startLaunch(harness, 'codex', 'http-steer-first');
  const second = await startLaunch(harness, 'codex', 'http-steer-second');
  const [firstState, repeatedState] = await Promise.all([readState(harness.runtime), readState(harness.runtime)]);
  const firstTarget = targetFor(firstState, first.result.launchRef);
  const secondTarget = targetFor(firstState, second.result.launchRef);
  assert.deepEqual(Object.keys(firstTarget).sort(), ['executionId', 'identity', 'launchRef', 'nativeTurnId', 'origin', 'purpose', 'reason', 'sessionId', 'status'].sort());
  assert.equal(firstTarget.status, 'working');
  assert.equal(firstTarget.nativeTurnId, harness.processesByProvider.get('codex')[0].state.turnId);
  assert.equal(targetFor(repeatedState, first.result.launchRef).status, 'working');
  assert.equal(harness.processesByProvider.get('codex').every((item) => item.state.instructionWrites.length === 0), true);

  const stale = await createInstruction(harness.runtime, first, {
    mode: 'steer', expectedTurnId: 'stale-native-turn', deliveryAttemptId: 'stale-native-target-attempt',
  });
  assert.equal(stale.response.status, 409);
  const otherLaunch = await createInstruction(harness.runtime, first, {
    mode: 'steer', expectedTurnId: secondTarget.nativeTurnId, deliveryAttemptId: 'other-launch-target-attempt',
    overrides: { launch_ref: second.result.launchRef },
  });
  assert.equal(otherLaunch.response.status, 403);

  const valid = await createInstruction(harness.runtime, first, {
    mode: 'steer', expectedTurnId: firstTarget.nativeTurnId, deliveryAttemptId: 'valid-native-target-attempt',
  });
  assert.equal(valid.response.status, 200);
  await harness.runtime.native.stop(first.receipt);
  const afterStop = await sendInstruction(harness.runtime, first, valid.body.delivery_attempt_id);
  assert.equal(afterStop.status, 409);
  assert.equal(harness.processesByProvider.get('codex')[0].state.instructionWrites.length, 0);
});

for (const provider of PROVIDERS) {
  test(`${provider} HTTP projection permits only a verified standalone terminal start and invalidation blocks send`, async (t) => {
    const harness = await withRuntime(t);
    const started = await startLaunch(harness, provider, `terminal-${provider}`);
    const processHarness = harness.processesByProvider.get(provider).at(-1);
    assert.equal(processHarness.endCurrentContext(), true);
    const [firstState, repeatedState] = await Promise.all([readState(harness.runtime), readState(harness.runtime)]);
    const target = targetFor(firstState, started.result.launchRef);
    assert.equal(target.status, 'stopped');
    assert.equal(target.nativeTurnId, null);
    assert.equal(targetFor(repeatedState, started.result.launchRef).status, 'stopped');
    assert.equal(processHarness.state.instructionWrites.length, 0);

    const created = await createInstruction(harness.runtime, started, {
      mode: 'start', deliveryAttemptId: `terminal-start-${provider}-attempt`,
    });
    assert.equal(created.response.status, 200);
    await harness.runtime.native.stop(started.receipt);
    const send = await sendInstruction(harness.runtime, started, created.body.delivery_attempt_id);
    assert.equal(send.status, 409);
    assert.equal(processHarness.state.instructionWrites.length, 0);
  });
}

test('Claude working state and delegated terminal context remain unverified for HTTP dispatch', async (t) => {
  const harness = await withRuntime(t);
  const claude = await startLaunch(harness, 'claude', 'claude-steer');
  const claudeTarget = targetFor(await readState(harness.runtime), claude.result.launchRef);
  assert.equal(claudeTarget.status, 'unverified');
  assert.equal(claudeTarget.reason, 'instruction_steer_unsupported');
  const claudeSteer = await createInstruction(harness.runtime, claude, {
    mode: 'steer', expectedTurnId: harness.processesByProvider.get('claude').at(-1).state.messageId,
    deliveryAttemptId: 'claude-steer-target-attempt',
  });
  assert.equal(claudeSteer.response.status, 409);
  assert.equal(harness.processesByProvider.get('claude').at(-1).state.instructionWrites.length, 0);

  const parent = await startLaunch(harness, 'codex', 'delegated-parent');
  const delegated = await startLaunch(harness, 'codex', 'delegated-child', {
    origin: 'delegated', originReceipt: parent.result.runReceipt,
  });
  const delegatedProcess = harness.processesByProvider.get('codex').at(-1);
  delegatedProcess.endCurrentContext();
  const delegatedTarget = targetFor(await readState(harness.runtime), delegated.result.launchRef);
  assert.equal(delegatedTarget.status, 'unverified');
  const delegatedStart = await createInstruction(harness.runtime, delegated, {
    mode: 'start', deliveryAttemptId: 'delegated-start-target-attempt',
  });
  assert.equal(delegatedStart.response.status, 409);
  assert.equal(delegatedProcess.state.instructionWrites.length, 0);
});

test('disconnect and reconnect stay unverified until the collector observes a fresh current context', async (t) => {
  const harness = await withRuntime(t);
  const started = await startLaunch(harness, 'codex', 'reconnect');
  const processHarness = harness.processesByProvider.get('codex').at(-1);
  assert.equal(targetFor(await readState(harness.runtime), started.result.launchRef).status, 'working');

  await started.collector.disconnect();
  assert.equal(targetFor(await readState(harness.runtime), started.result.launchRef).status, 'unverified');
  await started.collector.connect();
  assert.equal(targetFor(await readState(harness.runtime), started.result.launchRef).status, 'unverified');
  const rejected = await createInstruction(harness.runtime, started, {
    mode: 'steer', expectedTurnId: processHarness.state.turnId, deliveryAttemptId: 'reconnect-before-fresh-attempt',
  });
  assert.equal(rejected.response.status, 409);
  assert.equal(processHarness.state.instructionWrites.length, 0);

  const observed = await started.collector.observeKnownThread(processHarness.state.threadId);
  assert.equal(observed.status, 'observed');
  assert.equal(targetFor(await readState(harness.runtime), started.result.launchRef).status, 'working');
});

test('an active native wait keeps HTTP target state unverified', async (t) => {
  const harness = await withRuntime(t, { waitOnStart: true });
  const started = await startLaunch(harness, 'codex', 'active-wait');
  await new Promise((resolve) => setImmediate(resolve));
  const target = targetFor(await readState(harness.runtime), started.result.launchRef);
  assert.equal(target.status, 'unverified');
  const rejected = await createInstruction(harness.runtime, started, {
    mode: 'steer', expectedTurnId: harness.processesByProvider.get('codex').at(-1).state.turnId,
    deliveryAttemptId: 'active-wait-target-attempt',
  });
  assert.equal(rejected.response.status, 409);
  assert.equal(harness.processesByProvider.get('codex').at(-1).state.instructionWrites.length, 0);
});

test('an uncertain native write cannot authorize a later HTTP instruction', async (t) => {
  const harness = await withRuntime(t, { instructionWriteError: true });
  const started = await startLaunch(harness, 'codex', 'uncertain-write');
  harness.processesByProvider.get('codex').at(-1).endCurrentContext();
  const created = await createInstruction(harness.runtime, started, {
    mode: 'start', deliveryAttemptId: 'uncertain-native-start-attempt',
  });
  assert.equal(created.response.status, 200);
  await sendInstruction(harness.runtime, started, created.body.delivery_attempt_id);
  const processHarness = harness.processesByProvider.get('codex').at(-1);
  assert.equal(processHarness.state.instructionWrites.length, 1);
  assert.equal(targetFor(await readState(harness.runtime), started.result.launchRef).status, 'unverified');
  const later = await createInstruction(harness.runtime, started, {
    mode: 'start', deliveryAttemptId: 'after-uncertain-start-attempt',
  });
  assert.equal(later.response.status, 409);
  assert.equal(processHarness.state.instructionWrites.length, 1);
});

test('the native HTTP helper overrides a conflicting caller target callback', async (t) => {
  const harness = await withRuntime(t, { spoofCallback: true });
  const started = await startLaunch(harness, 'codex', 'callback-injection');
  const target = targetFor(await readState(harness.runtime), started.result.launchRef);
  assert.equal(target.status, 'working');
  assert.notEqual(target.reason, 'fixture_callback_must_not_win');
});