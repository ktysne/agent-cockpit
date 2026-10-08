'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  createNativeInstructionServiceIntegration,
  startNativeInstructionServer,
} = require('../src/server/native-instruction-service-integration');
const { startServer } = require('../src/server/server');
const { createTemporaryNativeInstructionHarness } = require('./support/native-instruction-integration-harness');
const { jsonBody, request, uiHeaders } = require('./support/server');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function codexAdmission(suffix) {
  return {
    launchId: `launch-codex-${suffix}`,
    runId: `run-codex-${suffix}`,
    attemptId: `attempt-codex-${suffix}`,
    profileId: 'codex',
    origin: 'standalone',
    purpose: 'agent',
  };
}

function profiles(directory) {
  return Object.fromEntries(['claude', 'codex'].map((provider) => [provider, {
    provider,
    executablePath: process.execPath,
    homePath: path.join(directory, 'profiles', provider),
    homeScopeId: `factory-${provider}-home`,
    cwd: path.join(directory, 'workspaces', provider),
  }]));
}

async function createDirectory() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'native-instruction-factory-'));
}

function integrationOptions(directory) {
  return {
    profiles: profiles(directory),
    dataDirectory: path.join(directory, 'native-state'),
    hostId: 'native-instruction-factory-test-host',
  };
}

function ownedStopClaims(execution) {
  return Object.fromEntries(['launchRef', 'executionId', 'sessionId', 'expectedContextId',
    'expectedOwnerGeneration', 'stopRevision'].map((field) => [field, execution[field]]));
}

function postOwnedStop(runtime, body, origin = `http://127.0.0.1:${runtime.info.port}`) {
  return request(runtime.info.port, {
    method: 'POST',
    path: '/api/executions/stop',
    headers: uiHeaders(runtime.info, origin, { 'content-type': 'application/json' }),
    body: JSON.stringify(body),
  });
}

test('opt-in native server passes its integration service to the loopback server and closes it once', async (t) => {
  const directory = await createDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let shutdownCalls = 0;
  const runtime = await startNativeInstructionServer({
    integrationOptions: integrationOptions(directory),
    serverOptions: {
      homeDir: path.join(directory, 'dashboard'),
      claudeHome: path.join(directory, 'claude-home'),
      port: 0,
      onShutdown: () => { shutdownCalls += 1; },
    },
  });
  t.after(async () => { try { await runtime.close(); } catch {} });

  assert.equal(runtime.server.address().address, '127.0.0.1');
  assert.equal(runtime.info.port, runtime.server.address().port);
  assert.equal(await runtime.instructionService.ready().then((value) => value.ready), true);
  assert.equal(typeof runtime.native.startLaunch, 'function');
  await runtime.close();
  assert.equal(shutdownCalls, 1);
  assert.equal(runtime.shutdownError, null);
  assert.throws(() => runtime.native.startLaunch({}), { code: 'native_instruction_integration_closed' });

  const reopened = await createNativeInstructionServiceIntegration(integrationOptions(directory));
  await reopened.close();
});

test('server flush failures still remove server info and run the shutdown hook once', async (t) => {
  const directory = await createDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const homeDir = path.join(directory, 'dashboard');
  let shutdownCalls = 0;
  const runtime = await startServer({
    homeDir,
    claudeHome: path.join(directory, 'claude-home'),
    port: 0,
    onShutdown: () => {
      shutdownCalls += 1;
      throw new Error('fixture shutdown hook failure');
    },
  });
  t.after(async () => { try { await runtime.close(); } catch {} });
  let stateFlushCalls = 0;
  runtime.state.flushPersistence = async () => {
    stateFlushCalls += 1;
    throw new Error('fixture state flush failure');
  };

  await assert.rejects(runtime.close(), { message: 'fixture state flush failure' });
  assert.equal(stateFlushCalls, 1);
  assert.equal(shutdownCalls, 1);
  assert.equal(runtime.shutdownError, 'shutdown_incomplete');
  await assert.rejects(fs.access(path.join(homeDir, 'server.json')), { code: 'ENOENT' });
});

test('native server exposes a safe shutdown status after cleanup fails', async (t) => {
  const directory = await createDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const runtime = await startNativeInstructionServer({
    integrationOptions: integrationOptions(directory),
    serverOptions: {
      homeDir: path.join(directory, 'dashboard'),
      claudeHome: path.join(directory, 'claude-home'),
      port: 0,
    },
  });
  t.after(async () => { try { await runtime.close(); } catch {} });
  runtime.state.flushPersistence = async () => { throw new Error('fixture contains private cleanup detail'); };

  await assert.rejects(runtime.close(), /fixture contains private cleanup detail/);
  assert.equal(runtime.shutdownError, 'shutdown_incomplete');
});

test('native server startup failure closes the integration and releases its journal path', async (t) => {
  const directory = await createDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const options = integrationOptions(directory);

  await assert.rejects(startNativeInstructionServer({
    integrationOptions: options,
    serverOptions: {
      homeDir: path.join(directory, 'dashboard'),
      claudeHome: path.join(directory, 'claude-home'),
      port: 65536,
    },
  }), /port must be between 0 and 65535/);

  const reopened = await createNativeInstructionServiceIntegration(options);
  await reopened.close();
});

test('owned execution stop requires the dashboard secret and same-origin request, then stops the owned child', async (t) => {
  const harness = await createTemporaryNativeInstructionHarness();
  const runtime = await harness.startDashboard();
  t.after(async () => { await runtime.close(); await harness.removeDirectory(); });
  const started = await harness.start('codex', { launchSuffix: 'dashboard-owned-stop' });
  const snapshot = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.equal(snapshot.ownedExecutionDiagnostics.status, 'ready');
  assert.equal(snapshot.ownedExecutions.length, 1);
  const owned = snapshot.ownedExecutions[0];
  assert.equal(owned.sessionId, started.result.observation.sessionId);
  assert.equal(owned.processState, 'running');
  assert.equal(owned.stopConfirmed, false);

  const claims = ownedStopClaims(owned);
  const missingOrigin = await request(runtime.info.port, {
    method: 'POST', path: '/api/executions/stop',
    headers: uiHeaders(runtime.info, undefined, { 'content-type': 'application/json' }),
    body: JSON.stringify(claims),
  });
  assert.equal(missingOrigin.status, 403);
  const missingSecret = await request(runtime.info.port, {
    method: 'POST', path: '/api/executions/stop',
    headers: { origin: `http://127.0.0.1:${runtime.info.port}`, 'content-type': 'application/json' },
    body: JSON.stringify(claims),
  });
  assert.equal(missingSecret.status, 401);
  assert.equal((await postOwnedStop(runtime, { ...claims, processState: 'running' })).status, 400);

  const stopped = await postOwnedStop(runtime, claims);
  assert.equal(stopped.status, 200);
  assert.equal(jsonBody(stopped).status, 'stop_confirmed');
  assert.equal(jsonBody(stopped).ownedExecution.stopConfirmed, true);
  assert.ok(started.process.child.killSignals.length > 0);
});

test('owned execution stop rejects stale, foreign, and unknown displayed identities but works after current proof expires', async (t) => {
  const harness = await createTemporaryNativeInstructionHarness();
  const runtime = await harness.startDashboard();
  t.after(async () => { await runtime.close(); await harness.removeDirectory(); });
  const started = await harness.start('codex', { launchSuffix: 'dashboard-stale-stop' });
  const snapshot = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  const original = snapshot.ownedExecutions[0];
  const claims = ownedStopClaims(original);

  const foreignSession = await postOwnedStop(runtime, { ...claims, sessionId: 'foreign-session' });
  assert.equal(foreignSession.status, 409);
  assert.equal(jsonBody(foreignSession).ownedExecution, null);
  const foreignExecution = await postOwnedStop(runtime, { ...claims, executionId: 'foreign-execution' });
  assert.equal(foreignExecution.status, 409);
  assert.equal(jsonBody(foreignExecution).ownedExecution, null);
  const unknown = await postOwnedStop(runtime, { ...claims, launchRef: 'unknown-launch' });
  assert.equal(unknown.status, 409);
  assert.equal(jsonBody(unknown).ownedExecution, null);
  const staleOwner = await postOwnedStop(runtime, { ...claims, expectedOwnerGeneration: claims.expectedOwnerGeneration + 1 });
  assert.equal(staleOwner.status, 409);
  assert.equal(jsonBody(staleOwner).ownedExecution.stopRevision, original.stopRevision);

  assert.equal(started.processHarness.endCurrentContext(), true);
  const staleContext = await postOwnedStop(runtime, claims);
  assert.equal(staleContext.status, 409);
  const current = jsonBody(staleContext).ownedExecution;
  assert.equal(current.expectedContextId, null);
  assert.ok(current.stopRevision > original.stopRevision);
  const stopped = await postOwnedStop(runtime, ownedStopClaims(current));
  assert.equal(stopped.status, 200);
  assert.equal(jsonBody(stopped).status, 'stop_confirmed');
});

for (const firstEvent of ['exit', 'close']) {
  test(`owned stop remains unconfirmed after only ${firstEvent} and updates after both child events arrive`, async (t) => {
    const harness = await createTemporaryNativeInstructionHarness({
      fakeRuntime: { killEvents: firstEvent },
      runnerTimeouts: { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 50 },
    });
    t.after(() => harness.removeDirectory());
    const started = await harness.start('codex', { launchSuffix: `stop-${firstEvent}-only` });
    const displayed = harness.native.ownedExecutionSnapshot()[0];
    const result = await harness.native.stopOwnedExecution(ownedStopClaims(displayed));
    assert.equal(result.status, 'stop_unconfirmed');
    assert.equal(result.ownedExecution.stopConfirmed, false);
    assert.equal(result.ownedExecution.processState, 'stop_unconfirmed');
    assert.equal(harness.native.getLaunchState(started.receipt).state, 'stop_unconfirmed');

    if (firstEvent === 'exit') started.process.child.reportClose();
    else started.process.child.reportExit();
    const latest = harness.native.ownedExecutionSnapshot()[0];
    assert.equal(latest.processState, 'stopped');
    assert.equal(latest.stopConfirmed, true);
    assert.equal(harness.native.getLaunchState(started.receipt).state, 'stopped');
  });
}

test('an unconfirmed owned stop blocks its linked successor without blocking an unrelated execution', async (t) => {
  const harness = await createTemporaryNativeInstructionHarness({
    fakeRuntime: { killEvents: 'close' },
    runnerTimeouts: { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 50 },
  });
  t.after(() => harness.removeDirectory());
  const predecessor = await harness.start('codex', { launchSuffix: 'blocked-successor-predecessor' });
  const displayed = harness.native.ownedExecutionSnapshot()[0];
  await harness.native.stopOwnedExecution(ownedStopClaims(displayed));
  await assert.rejects(Promise.resolve().then(() => harness.native.startLaunch({
    ...codexAdmission('blocked-successor'), inputText: 'successor', predecessorReceipt: predecessor.receipt,
  })), { code: 'predecessor_stop_unconfirmed' });

  const unrelated = await harness.start('claude', { launchSuffix: 'unrelated-execution-after-blocked-stop' });
  assert.equal(unrelated.result.accepted, true);
  predecessor.process.child.reportExit();
});

test('a confirmed predecessor can be bound on the first successor start and remains fixed for that attempt', async (t) => {
  const harness = await createTemporaryNativeInstructionHarness();
  t.after(() => harness.removeDirectory());
  const predecessor = await harness.start('codex', { launchSuffix: 'first-bound-predecessor' });
  const otherPredecessor = await harness.start('codex', { launchSuffix: 'other-first-bound-predecessor' });
  await harness.native.stop(predecessor.receipt);
  await harness.native.stop(otherPredecessor.receipt);

  const admission = codexAdmission('first-bound-successor');
  const startRequest = {
    ...admission,
    inputText: 'start the linked successor',
    predecessorReceipt: predecessor.receipt,
  };
  const firstStart = harness.native.startLaunch(startRequest);
  const repeatedStart = harness.native.startLaunch(startRequest);
  assert.strictEqual(repeatedStart, firstStart);
  const started = await firstStart;
  assert.equal(started.receipt, harness.native.admitLaunch(admission));
  assert.equal(started.result.accepted, true);
  assert.equal(harness.processesByProvider.get('codex').length, 3);

  await assert.rejects(Promise.resolve().then(() => harness.native.startLaunch({
    ...startRequest,
    predecessorReceipt: otherPredecessor.receipt,
  })), { code: 'attempt_conflict' });
  assert.equal(harness.processesByProvider.get('codex').length, 3);
});

test('reading an admitted launch state does not retire it before start', async (t) => {
  const harness = await createTemporaryNativeInstructionHarness();
  t.after(() => harness.removeDirectory());
  const admission = codexAdmission('read-state-before-start');
  const receipt = harness.native.admitLaunch(admission);

  assert.equal(harness.native.getLaunchState(receipt).state, 'admitted');
  const started = await harness.native.startLaunch({ ...admission, inputText: 'start after reading state' });
  assert.equal(started.receipt, receipt);
  assert.equal(started.result.accepted, true);
});

test('stop revision rejects a stale null-context display after a context starts and ends between snapshots', async (t) => {
  const harness = await createTemporaryNativeInstructionHarness();
  t.after(() => harness.removeDirectory());
  const started = await harness.start('codex', { launchSuffix: 'stop-revision-context-aba' });
  const previousContext = started.process.turnId;
  assert.equal(started.processHarness.endCurrentContext(), true);
  const nullContextDisplay = harness.native.ownedExecutionSnapshot()[0];
  assert.equal(nullContextDisplay.expectedContextId, null);

  const input = {
    deliveryAttemptId: 'stop-revision-context-aba-next-turn',
    launchRef: started.result.launchRef,
    logicalMessageId: 'stop-revision-context-aba-next-turn',
    revision: 1,
    text: 'start another native context',
    mode: 'start',
    expectedTurnId: null,
  };
  await harness.service.create(input);
  await harness.service.send(input.deliveryAttemptId);
  assert.notEqual(started.process.turnId, previousContext);
  assert.equal(started.processHarness.endCurrentContext(), true);

  const staleStop = await harness.native.stopOwnedExecution(ownedStopClaims(nullContextDisplay));
  assert.equal(staleStop.status, 'stale');
  assert.ok(staleStop.ownedExecution.stopRevision > nullContextDisplay.stopRevision);
  assert.equal(started.process.child.killSignals.length, 0);
  const latest = harness.native.ownedExecutionSnapshot()[0];
  assert.equal((await harness.native.stopOwnedExecution(ownedStopClaims(latest))).status, 'stop_confirmed');
});

test('a failed runner state remains diagnosable while malformed owned diagnostics fail closed', async (t) => {
  const failedHarness = await createTemporaryNativeInstructionHarness({
    runnerFactory() { throw new Error('fixture runner creation failure'); },
  });
  t.after(() => failedHarness.removeDirectory());
  const failedStart = failedHarness.native.startLaunch({
    ...codexAdmission('failed-runner-diagnostics'), inputText: 'fail before spawning',
  });
  assert.doesNotThrow(() => failedHarness.native.ownedExecutionSnapshot());
  await assert.rejects(failedStart, { code: 'runner_start_failed' });

  const harness = await createTemporaryNativeInstructionHarness();
  const started = await harness.start('codex', { launchSuffix: 'failed-state-projection' });
  const baseline = harness.native.ownedExecutionSnapshot()[0];
  const failedExecution = { ...baseline, processState: 'failed', canStop: true, stopConfirmed: false };
  let malformed = false;
  const runtime = await startServer({
    homeDir: path.join(harness.directory, 'failed-state-dashboard'),
    claudeHome: path.join(harness.directory, 'failed-state-claude'),
    userHome: path.join(harness.directory, 'failed-state-user'),
    port: 0,
    ownedExecutionSnapshot: () => malformed
      ? [failedExecution, { ...failedExecution, processState: 'invalid' }]
      : [failedExecution],
  });
  t.after(async () => { await runtime.close(); await harness.removeDirectory(); });

  const failedState = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.equal(failedState.ownedExecutionDiagnostics.status, 'ready');
  assert.equal(failedState.ownedExecutions[0].processState, 'failed');
  malformed = true;
  const invalidDiagnostics = jsonBody(await request(runtime.info.port, { path: '/api/state' }));
  assert.equal(invalidDiagnostics.ownedExecutionDiagnostics.status, 'unavailable');
  assert.deepEqual(invalidDiagnostics.ownedExecutions, []);
  await harness.native.stop(started.receipt);
});

test('target projection becomes unverified as integration cleanup begins', async (t) => {
  const directory = await createDirectory();
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const integration = await createNativeInstructionServiceIntegration(integrationOptions(directory));
  assert.deepEqual(integration.instructionTargetState('unknown-launch'), {
    status: 'unverified', nativeTurnId: null, reason: 'instruction_target_unverified',
  });

  const closing = integration.close();
  assert.deepEqual(integration.instructionTargetState('unknown-launch'), {
    status: 'unverified', nativeTurnId: null, reason: 'native_instruction_integration_closed',
  });
  await closing;
});

test('Codex collector connects after a login delayed beyond the source attach timeout', async (t) => {
  let harness;
  harness = await createTemporaryNativeInstructionHarness({
    runnerTimeouts: { startupMs: 2000, rpcMs: 2000, loginMs: 12000, stopMs: 1000 },
    onAuthenticationRequired: async ({ loginId }) => {
      await new Promise((resolve) => setTimeout(resolve, 5200));
      assert.equal(harness.processesByProvider.get('codex').at(-1).completeLogin(loginId), true);
    },
  });
  t.after(() => harness.removeDirectory());

  const started = await harness.start('codex', { launchSuffix: 'identity-after-attach-window' });

  assert.equal(started.process.spawnCount, 1);
  assert.equal(started.process.rpcMethods.filter((method) => method === 'thread/start').length, 1);
  assert.equal(started.result.accepted, true);
  assert.equal(started.result.status, 'observed');
});

test('Codex start rejects when the collector cannot establish a connected source', async (t) => {
  const harness = await createTemporaryNativeInstructionHarness({
    onNative() {},
    dropNative: (event) => event.type === 'identity',
  });
  t.after(() => harness.removeDirectory());

  await assert.rejects(harness.start('codex', { launchSuffix: 'source-never-connected' }), {
    code: 'native_source_initialization_unavailable',
  });
});

test('Codex start preserves its original result for an actor-life-authenticated terminal target', async (t) => {
  let harness;
  let ended = false;
  harness = await createTemporaryNativeInstructionHarness({
    onNative() {},
    afterNative(event) {
      if (event.type !== 'context' || ended) return;
      ended = true;
      assert.equal(harness.processesByProvider.get('codex').at(-1).endCurrentContext(), true);
    },
  });
  t.after(() => harness.removeDirectory());

  const started = await harness.start('codex', { launchSuffix: 'standalone-terminal-with-actor-life' });

  assert.equal(started.result.accepted, false);
  assert.equal(started.result.status, 'unknown');
  assert.equal(typeof started.result.observation.nativeId, 'string');
  assert.equal(started.result.observation.contextKind, null);
  assert.equal(harness.instructionTargetState(started.result.launchRef).status, 'stopped');
});

test('Codex early terminal without actor life is rejected as unverified', async (t) => {
  const harness = await createTemporaryNativeInstructionHarness({
    fakeRuntime: { earlyTurnCompletion: true },
  });
  t.after(() => harness.removeDirectory());
  const suffix = 'early-terminal-without-actor-life';
  const admission = codexAdmission(suffix);
  const { receipt } = await harness.admit('codex', suffix);

  await assert.rejects(harness.native.startLaunch({
    ...admission,
    inputText: 'initial context with an unmatched early terminal',
  }), { code: 'native_execution_proof_unavailable' });
  assert.equal(harness.native.getLaunchState(receipt).state, 'stopped');
});

for (const invalidator of ['stop', 'close']) {
  test(`Codex start rejects when ${invalidator} invalidates a pending login`, async (t) => {
    const challengeSeen = deferred();
    const harness = await createTemporaryNativeInstructionHarness({
      onAuthenticationRequired: (challenge) => { challengeSeen.resolve(challenge); },
      runnerTimeouts: { startupMs: 2000, rpcMs: 2000, loginMs: 12000, stopMs: 1000 },
    });
    t.after(() => harness.removeDirectory());
    const suffix = `pending-login-${invalidator}`;
    const admission = codexAdmission(suffix);
    const { receipt } = await harness.admit('codex', suffix);
    const pending = harness.native.startLaunch({
      ...admission,
      inputText: 'explicit standalone context start',
    });
    await challengeSeen.promise;

    if (invalidator === 'stop') await harness.native.stop(receipt);
    else await harness.close();

    await assert.rejects(pending);
    assert.equal(harness.native.getLaunchState(receipt).state, 'stopped');
  });
}
