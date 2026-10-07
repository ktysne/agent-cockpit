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
