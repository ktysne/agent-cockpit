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
