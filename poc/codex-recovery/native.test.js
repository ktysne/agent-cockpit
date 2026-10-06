'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const test = require('node:test');
const { REPOSITORY_ROOT, REQUIRED_CODEX_VERSION } = require('../codex-hooks-identity/setup');
const {
  calculateMeasurementSuccess,
  calculateMetadataRecoverySuccess,
  calculateRecoverySuccess,
  createCapabilityToken,
  makeResult,
  removePrivateHome,
  removeCapabilityToken,
  runNativeProbe,
  safeErrorKind,
  stopOwnedServer,
} = require('./native-runner');
const {
  MAX_HTTP_RESPONSE_BYTES,
  childEnvironment,
  createCockpitChild,
  requestCockpit,
  validateOwnedPaths,
} = require('./cockpit-probe');

const OUTPUT_BASE = path.join(REPOSITORY_ROOT, 'poc', 'out');

async function withOwnedPaths(run) {
  const outputDirectory = path.join(OUTPUT_BASE, `poc162-native-test-${randomUUID()}`);
  fs.mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  const paths = {
    outputDirectory,
    homeDir: path.join(outputDirectory, 'runtime-home'),
    claudeHome: path.join(outputDirectory, 'claude-home'),
    userHome: path.join(outputDirectory, 'user-home'),
  };
  try {
    return await run(paths);
  } finally {
    const resolved = path.resolve(outputDirectory);
    assert.equal(path.dirname(resolved), path.resolve(OUTPUT_BASE));
    const stat = fs.lstatSync(resolved);
    assert.equal(stat.isDirectory(), true);
    assert.equal(stat.isSymbolicLink(), false);
    fs.rmSync(resolved, { recursive: true, force: false });
  }
}

function makeFakeChild(sendMessage, onKill = () => {}) {
  const child = new EventEmitter();
  child.connected = true;
  child.killCalls = 0;
  child.send = (message, callback) => sendMessage(child, message, callback);
  child.kill = (...args) => {
    child.killCalls += 1;
    onKill(child, ...args);
  };
  return child;
}

function fakeHttpWithResponse(chunks) {
  return {
    request(_options, onResponse) {
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.write = () => {};
      request.destroy = (error) => queueMicrotask(() => request.emit('error', error));
      request.end = () => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.headers = {};
        response.destroy = () => {};
        onResponse(response);
        queueMicrotask(() => {
          for (const chunk of chunks) response.emit('data', chunk);
          response.emit('end');
        });
      };
      return request;
    },
  };
}

async function runFirstClientInitializeProbe(makeResponse) {
  const outputDirectory = path.join(OUTPUT_BASE, `poc162-native-test-${randomUUID()}`);
  const home = path.join(outputDirectory, 'home');
  const repo = path.join(outputDirectory, 'repo');
  const signalSource = new EventEmitter();
  const fixture = { requests: [], async start() {}, release() {}, async close() { return true; } };
  let resolveExit;
  const server = {
    state: { closed: false, exitCode: null, signal: null },
    exited: new Promise((resolve) => { resolveExit = resolve; }),
    child: { kill() { server.state.closed = true; resolveExit(); return true; } },
  };
  let connectionCount = 0;
  let initializeCount = 0;
  const result = await runNativeProbe({
    mode: 'recovery',
    outputDirectory: path.relative(REPOSITORY_ROOT, outputDirectory),
    codexPath: path.join(__dirname, 'native.test.js'),
    timeoutMs: 1000,
  }, {
    signalSource,
    prepareWorkspace(output) {
      fs.mkdirSync(home, { mode: 0o700 });
      fs.mkdirSync(repo, { mode: 0o700 });
      fs.writeFileSync(path.join(home, 'config.toml'), 'safe fixture config', { mode: 0o600 });
      return { output, layout: { output, home, repo } };
    },
    createFixture: () => fixture,
    runVersionCheck: async () => ({ version: '0.160.1' }),
    writePrivateConfig: () => ({ output: outputDirectory, isolatedHome: home, configPath: path.join(home, 'config.toml') }),
    restorePrivateConfig: () => true,
    choosePort: async () => 43210,
    startServer: () => server,
    async connect() {
      connectionCount += 1;
      if (connectionCount > 1) {
        server.state.closed = true;
        resolveExit();
        throw new Error('stop after first initialization');
      }
      return {
        client: {
          async request(method) {
            if (method !== 'initialize') throw new Error('unexpected RPC');
            initializeCount += 1;
            return makeResponse(home);
          },
          async notify() {},
        },
        close() {},
      };
    },
  });
  return { outputDirectory, result, connectionCount, initializeCount };
}

function makeCompletedMetadataRecovery() {
  const result = makeResult({ mode: 'recovery' });
  result.cleanup.output_owned = true;
  result.target_version = '0.160.1';
  result.server_versions = { a: '0.160.0', b: '0.160.0', recovery: '0.160.0' };
  result.thread.started = true;
  result.turns.warmup = { terminal_observed: true, status_a: 'completed' };
  result.turns.held = { fixture_gate_observed: true, active_observed: true, terminal_observed: false };
  result.steer = {
    acknowledgement_received: true,
    same_turn_id: true,
    sender_disconnected_after_ack: true,
  };
  result.recovery = {
    old_token_websocket_rejected: true,
    current_token_initialize_succeeded: true,
    hard_kill_requested: true,
    hard_kill_signal: 'SIGKILL',
    hard_kill_exit_observed: true,
    fixture_gate_held_at_kill: true,
    fixture_released_after_exit: true,
    fixture_old_generation_drained: true,
    metadata_restored_after_resume: true,
    original_execution_continued_after_restart: null,
    probe_completed_after_restart: true,
    loaded_before_resume: { available: true, contains_thread: false },
    resume_accepted: true,
    same_thread_id: true,
    read_after_resume: { available: true, thread_matches: true },
    loaded_after_resume: { available: true, contains_thread: true },
    turn_start_rpc_count_after_restart: 0,
    turn_started_notifications_after_restart: 0,
  };
  result.settings.recovery_preserved = true;
  result.measurement_success = calculateMeasurementSuccess(result);
  return result;
}

test('Cockpit child paths require one owned output root and three distinct descendants', () => {
  withOwnedPaths((paths) => {
    const validated = validateOwnedPaths(paths);
    assert.equal(validated.output, paths.outputDirectory);
    assert.equal(validated.homeDir, paths.homeDir);
    assert.equal(validated.claudeHome, paths.claudeHome);
    assert.equal(validated.userHome, paths.userHome);
    assert.throws(() => validateOwnedPaths({ ...paths, claudeHome: paths.homeDir }), (error) => error.kind === 'cockpit_homes_must_be_distinct');
    assert.throws(() => validateOwnedPaths({ ...paths, userHome: path.join(REPOSITORY_ROOT, 'user-home') }), (error) => error.kind === 'cockpit_home_outside_output');
    assert.throws(() => validateOwnedPaths({ ...paths, outputDirectory: path.join(OUTPUT_BASE, 'nested', 'poc162-invalid') }), (error) => error.kind === 'cockpit_output_invalid');
  });
});

test('Cockpit child environment passes only the platform allowlist', () => {
  const environment = childEnvironment({
    PATH: 'safe-path',
    SystemRoot: 'C:\\Windows',
    CLAUDE_CODE_OAUTH_TOKEN: 'private-token-sentinel',
    OPENAI_API_KEY: 'private-api-key-sentinel',
    HOME: 'normal-home-sentinel',
  });
  assert.deepEqual(environment, { PATH: 'safe-path', SystemRoot: 'C:\\Windows' });
  assert.equal(JSON.stringify(environment).includes('private-token-sentinel'), false);
  assert.equal(JSON.stringify(environment).includes('private-api-key-sentinel'), false);
  assert.equal(JSON.stringify(environment).includes('normal-home-sentinel'), false);
});

test('Cockpit child captures immediate ready/stopped IPC replies', async () => {
  await withOwnedPaths(async (paths) => {
    let forkOptions;
    const child = makeFakeChild((processChild, message, callback) => {
      if (message.kind === 'start') processChild.emit('message', {
        kind: 'ready', port: 43210, secret: 'cockpit-secret-sentinel', uiSecret: 'cockpit-ui-secret-sentinel',
      });
      if (message.kind === 'stop') {
        processChild.emit('message', { kind: 'stopped', closed: true });
        processChild.connected = false;
        processChild.emit('close', 0);
      }
      callback(null);
    });
    const cockpit = createCockpitChild(paths, {
      environment: { PATH: 'safe-path', CLAUDE_CODE_OAUTH_TOKEN: 'parent-token-sentinel' },
      fork(_script, _args, options) {
        forkOptions = options;
        return child;
      },
    });

    const credentials = await cockpit.start(100);
    assert.equal(credentials.port, 43210);
    assert.deepEqual(Object.keys(forkOptions.env), ['PATH']);
    const stopped = await cockpit.stop(100);
    assert.deepEqual(stopped, { stop_acknowledged: true, exit_observed: true, exit_code: 0 });
    assert.equal(child.killCalls, 0);
  });
});

test('Cockpit child stop racing startup rejects startup and confirms child exit', async () => {
  await withOwnedPaths(async (paths) => {
    const child = makeFakeChild((processChild, message, callback) => {
      if (message.kind === 'stop') {
        processChild.emit('message', { kind: 'stopped', closed: true });
        processChild.connected = false;
        processChild.emit('close', 0);
      }
      callback(null);
    });
    const cockpit = createCockpitChild(paths, { fork: () => child });
    const startPromise = cockpit.start(100);
    const stopPromise = cockpit.stop(100);

    await assert.rejects(startPromise);
    assert.deepEqual(await stopPromise, { stop_acknowledged: true, exit_observed: true, exit_code: 0 });
  });
});

test('Cockpit child disconnect rejects startup and bounded stop confirms kill exit', async () => {
  await withOwnedPaths(async (paths) => {
    const child = makeFakeChild((processChild, message, callback) => {
      if (message.kind === 'start') {
        processChild.connected = false;
        processChild.emit('disconnect');
      }
      callback(null);
    }, (processChild) => {
      processChild.connected = false;
      processChild.emit('close', null, 'SIGKILL');
    });
    const cockpit = createCockpitChild(paths, { fork: () => child });
    const startupStartedAt = Date.now();

    await assert.rejects(cockpit.start(200));
    assert.ok(Date.now() - startupStartedAt < 150);
    const stopStartedAt = Date.now();
    const stopped = await cockpit.stop(50);
    assert.equal(stopped.exit_observed, true);
    assert.ok(Date.now() - stopStartedAt < 500);
    assert.ok(child.killCalls > 0);
  });
});

test('Cockpit child stop timeout remains bounded when child ignores stop and kill', async () => {
  await withOwnedPaths(async (paths) => {
    const child = makeFakeChild((processChild, message, callback) => {
      if (message.kind === 'start') processChild.emit('message', {
        kind: 'ready', port: 43211, secret: 'cockpit-secret-sentinel', uiSecret: 'cockpit-ui-secret-sentinel',
      });
      callback(null);
    });
    const cockpit = createCockpitChild(paths, { fork: () => child });
    await cockpit.start(50);
    const startedAt = Date.now();
    const stopped = await cockpit.stop(50);

    assert.equal(stopped.exit_observed, false);
    assert.ok(Date.now() - startedAt < 500);
    assert.ok(child.killCalls >= 1);
  });
});

test('Cockpit requests reject invalid targets and oversized responses', async () => {
  await assert.rejects(requestCockpit({ port: 0, pathname: '/health' }), (error) => error.kind === 'cockpit_request_invalid');
  await assert.rejects(requestCockpit({ port: 43210, pathname: '/health' }, {
    http: fakeHttpWithResponse([Buffer.alloc(MAX_HTTP_RESPONSE_BYTES + 1, 0x20)]),
  }), (error) => error.kind === 'cockpit_response_too_large');
});

test('an existing output directory is preserved and failure output contains no capability value', async () => {
  const outputDirectory = path.join(OUTPUT_BASE, `poc162-native-test-${randomUUID()}`);
  fs.mkdirSync(outputDirectory, { mode: 0o700 });
  const secret = 'capability-secret-sentinel';
  const sentinelPath = path.join(outputDirectory, 'sentinel.txt');
  fs.writeFileSync(sentinelPath, secret, { flag: 'wx', mode: 0o600 });
  const signalSource = new EventEmitter();
  try {
    const result = await runNativeProbe({
      mode: 'cockpit',
      outputDirectory: path.relative(REPOSITORY_ROOT, outputDirectory),
      timeoutMs: 1000,
      codexPath: secret,
    }, { signalSource });

    assert.equal(result.failure_code, 'output_directory_not_fresh');
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), secret);
    assert.equal(fs.existsSync(path.join(outputDirectory, 'native-result.json')), false);
    assert.equal(JSON.stringify(result).includes(secret), false);
    assert.equal(safeErrorKind(new Error(secret)), 'native_probe_failed');
  } finally {
    fs.rmSync(outputDirectory, { recursive: true, force: false });
  }
});

test('an output creation race never writes a result into another process directory', async () => {
  const outputDirectory = path.join(OUTPUT_BASE, `poc162-native-test-${randomUUID()}`);
  const sentinelPath = path.join(outputDirectory, 'sentinel.txt');
  let competitorCreatedOutput = false;
  const racingFs = new Proxy(fs, {
    get(target, property) {
      if (property === 'mkdirSync') {
        return (directory, options) => {
          if (!competitorCreatedOutput && path.resolve(directory) === outputDirectory) {
            competitorCreatedOutput = true;
            target.mkdirSync(directory, options);
            target.writeFileSync(sentinelPath, 'owned by another process', { flag: 'wx', mode: 0o600 });
          }
          return target.mkdirSync(directory, options);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

  try {
    const result = await runNativeProbe({
      mode: 'recovery',
      outputDirectory: path.relative(REPOSITORY_ROOT, outputDirectory),
      codexPath: path.join(__dirname, 'native.test.js'),
    }, { fs: racingFs, signalSource: new EventEmitter() });

    assert.equal(competitorCreatedOutput, true);
    assert.equal(result.cleanup.output_owned, false);
    assert.equal(result.cleanup.result_written, false);
    assert.equal(fs.readFileSync(sentinelPath, 'utf8'), 'owned by another process');
    assert.equal(fs.existsSync(path.join(outputDirectory, 'native-result.json')), false);
  } finally {
    if (fs.existsSync(outputDirectory)) fs.rmSync(outputDirectory, { recursive: true, force: false });
  }
});

test('the initialize response path accepts a different server version but rejects malformed identity', async () => {
  const commonResponse = (codexHome) => ({
    codexHome,
    platformFamily: 'windows',
    platformOs: 'windows',
    userAgent: 'codex/0.160.0',
  });
  const mismatched = await runFirstClientInitializeProbe((home) => commonResponse(home));
  try {
    assert.equal(mismatched.result.target_version, '0.160.1');
    assert.equal(mismatched.result.server_versions.a, '0.160.0');
    assert.equal(mismatched.initializeCount, 1);
    assert.equal(mismatched.result.failure_stage, 'client_b_connect');
  } finally {
    fs.rmSync(mismatched.outputDirectory, { recursive: true, force: false });
  }

  const outsidePreviousAllowlist = await runFirstClientInitializeProbe((home) => ({
    ...commonResponse(home),
    userAgent: 'codex/0.160.1',
  }));
  try {
    assert.equal(outsidePreviousAllowlist.result.target_version, '0.160.1');
    assert.equal(outsidePreviousAllowlist.result.server_versions.a, '0.160.1');
    assert.equal(outsidePreviousAllowlist.initializeCount, 1);
    assert.equal(outsidePreviousAllowlist.result.clients.a_initialized, true);
    assert.equal(outsidePreviousAllowlist.result.failure_stage, 'client_b_connect');
  } finally {
    fs.rmSync(outsidePreviousAllowlist.outputDirectory, { recursive: true, force: false });
  }

  const malformed = await runFirstClientInitializeProbe(() => commonResponse('relative-home'));
  try {
    assert.equal(malformed.initializeCount, 1);
    assert.equal(malformed.result.clients.a_initialized, false);
    assert.equal(malformed.result.server_versions.a, null);
    assert.equal(malformed.result.failure_code, 'app_server_initialize_response_invalid');
  } finally {
    fs.rmSync(malformed.outputDirectory, { recursive: true, force: false });
  }

  const wrongHome = await runFirstClientInitializeProbe((home) => commonResponse(`${home}-other`));
  try {
    assert.equal(wrongHome.result.server_versions.a, '0.160.0');
    assert.equal(wrongHome.result.clients.a_initialized, false);
    assert.equal(wrongHome.result.failure_code, 'private_app_server_identity_mismatch');
  } finally {
    fs.rmSync(wrongHome.outputDirectory, { recursive: true, force: false });
  }
});

test('private home removal only removes the exact owned home directory', async () => {
  await withOwnedPaths(async ({ outputDirectory }) => {
    const home = path.join(outputDirectory, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    fs.writeFileSync(path.join(home, 'private.txt'), 'owned');
    const outside = path.join(outputDirectory, 'other-home');
    fs.mkdirSync(outside, { mode: 0o700 });
    fs.writeFileSync(path.join(outside, 'sentinel.txt'), 'preserve');

    assert.equal(removePrivateHome(outputDirectory, outside), false);
    assert.equal(fs.readFileSync(path.join(outside, 'sentinel.txt'), 'utf8'), 'preserve');
    assert.equal(removePrivateHome(outputDirectory, home), true);
    assert.equal(fs.existsSync(home), false);
  });
});

test('capability rotation creates a distinct owned file and removes each registered token', async () => {
  await withOwnedPaths(async ({ outputDirectory }) => {
    const firstToken = createCapabilityToken(outputDirectory, fs, () => Buffer.alloc(32, 1));
    const secondToken = createCapabilityToken(outputDirectory, fs, () => Buffer.alloc(32, 2));

    assert.notEqual(firstToken.tokenPath, secondToken.tokenPath);
    assert.notEqual(firstToken.token, secondToken.token);
    assert.equal(fs.readFileSync(firstToken.tokenPath, 'utf8'), firstToken.token);
    assert.equal(fs.readFileSync(secondToken.tokenPath, 'utf8'), secondToken.token);
    assert.equal(removeCapabilityToken(outputDirectory, firstToken), true);
    assert.equal(fs.existsSync(secondToken.tokenPath), true);
    assert.equal(removeCapabilityToken(outputDirectory, secondToken), true);
    assert.deepEqual(fs.readdirSync(outputDirectory), []);
  });
});

test('server stop reports an unconfirmed exit within its bounded waits', async () => {
  let kills = 0;
  const server = {
    state: { closed: false, exitCode: null, signal: null },
    exited: new Promise(() => {}),
    child: { kill() { kills += 1; return true; } },
  };
  const startedAt = Date.now();
  const stopped = await stopOwnedServer(server, 25);

  assert.equal(stopped.exit_observed, false);
  assert.ok(kills >= 2);
  assert.ok(Date.now() - startedAt < 500);
});

test('unconfirmed owned server exit keeps its token and shared private home', async () => {
  const outputDirectory = path.join(OUTPUT_BASE, `poc162-native-test-${randomUUID()}`);
  const home = path.join(outputDirectory, 'home');
  const repo = path.join(outputDirectory, 'repo');
  const signalSource = new EventEmitter();
  let server;
  let tokenPath;
  let restoreCalls = 0;
  let releaseCalls = 0;
  let closeCalls = 0;
  const fixtureServer = {
    listening: true,
    closeAllConnections() {},
    close(callback) {
      this.listening = false;
      callback();
    },
  };
  const fixture = {
    server: fixtureServer,
    requests: [],
    async start() {},
    release() { releaseCalls += 1; },
    async close() { closeCalls += 1; this.release(); return true; },
  };
  try {
    const result = await runNativeProbe({
      mode: 'recovery',
      outputDirectory: path.relative(REPOSITORY_ROOT, outputDirectory),
      codexPath: path.join(__dirname, 'native.test.js'),
      timeoutMs: 1000,
    }, {
      signalSource,
      prepareWorkspace(output) {
        fs.mkdirSync(home, { mode: 0o700 });
        fs.mkdirSync(repo, { mode: 0o700 });
        fs.writeFileSync(path.join(home, 'config.toml'), 'safe fixture config', { mode: 0o600 });
        return { output, layout: { output, home, repo } };
      },
      createFixture: () => fixture,
      runVersionCheck: async () => ({ version: REQUIRED_CODEX_VERSION }),
      writePrivateConfig: () => ({ output: outputDirectory, isolatedHome: home, configPath: path.join(home, 'config.toml') }),
      restorePrivateConfig() { restoreCalls += 1; return true; },
      choosePort: async () => 43210,
      startServer(_executable, _repo, _home, port, currentTokenPath) {
        tokenPath = currentTokenPath;
        server = {
          port,
          state: { closed: false, exitCode: null, signal: null },
          exited: new Promise(() => {}),
          child: { kill: () => true },
        };
        return server;
      },
      async connect() { throw Object.assign(new Error('mock unavailable'), { kind: 'mock_connection_failed' }); },
    });

    assert.equal(result.failure_stage, 'client_a_connect');
    assert.equal(result.cleanup.server_exit_observed, false);
    assert.equal(result.cleanup.token_files_removed, false);
    assert.equal(result.cleanup.private_home_removed, false);
    assert.equal(result.cleanup.fixture_released_after_servers_exit, false);
    assert.equal(result.cleanup.fixture_closed, true);
    assert.equal(releaseCalls, 0);
    assert.equal(closeCalls, 0);
    assert.equal(fixtureServer.listening, false);
    assert.equal(fs.existsSync(home), true);
    assert.equal(fs.existsSync(tokenPath), true);
    assert.equal(fs.readFileSync(path.join(home, 'config.toml'), 'utf8'), 'safe fixture config');
    assert.equal(restoreCalls, 0);
    assert.equal(server.state.closed, false);
    const token = fs.readFileSync(tokenPath, 'utf8');
    assert.equal(JSON.stringify(result).includes(token), false);
    assert.equal(fs.readFileSync(path.join(outputDirectory, 'native-result.json'), 'utf8').includes(token), false);
  } finally {
    if (fs.existsSync(outputDirectory)) fs.rmSync(outputDirectory, { recursive: true, force: false });
  }
});

test('measurement, recovery, and Cockpit persistence evidence remain separate', () => {
  const recovery = makeCompletedMetadataRecovery();
  assert.equal(recovery.measurement_success, true);
  for (const status of ['unknown', 'failed']) {
    recovery.turns.warmup = { terminal_observed: true, status_a: status };
    assert.equal(calculateMeasurementSuccess(recovery), false);
  }
  recovery.turns.warmup = { terminal_observed: false, status_a: 'completed' };
  assert.equal(calculateMeasurementSuccess(recovery), false);
  recovery.turns.warmup = { terminal_observed: true, status_a: 'completed' };
  assert.equal(calculateMetadataRecoverySuccess(recovery), true);
  recovery.metadata_recovery_success = true;
  assert.equal(calculateRecoverySuccess(recovery), false);

  const approval = makeResult({ mode: 'approval' });
  approval.cleanup.output_owned = true;
  approval.target_version = REQUIRED_CODEX_VERSION;
  approval.thread.started = true;
  approval.turns.warmup = { terminal_observed: true };
  approval.turns.approval = { terminal_observed: true };
  approval.fixture.request_count = 1;
  approval.approval.request_observed = true;
  approval.approval.runner_replied = false;
  assert.equal(calculateMeasurementSuccess(approval), true);
  assert.equal(approval.approval.runner_replied, false);

  const cockpit = makeResult({ mode: 'cockpit' });
  cockpit.cleanup.output_owned = true;
  cockpit.cockpit.measurement_observed = true;
  assert.equal(calculateMeasurementSuccess(cockpit), true);
  assert.equal(calculateRecoverySuccess(cockpit), false);
});

test('incomplete or failed measurements cannot be reported as successful', () => {
  const result = makeResult({ mode: 'recovery' });
  result.cleanup.output_owned = true;
  result.failure_code = 'probe_failed';
  assert.equal(calculateMeasurementSuccess(result), false);
  result.failure_code = null;
  assert.equal(calculateMeasurementSuccess(result), false);
});

test('recovery success requires the post-resume loaded snapshot to contain the target thread', () => {
  const result = makeCompletedMetadataRecovery();
  result.recovery.metadata_restored_after_resume = false;
  result.recovery.loaded_after_resume.contains_thread = false;

  assert.equal(calculateMetadataRecoverySuccess(result), false);
});

test('version differences and an unobserved held-turn terminal do not invalidate metadata recovery', () => {
  const result = makeCompletedMetadataRecovery();

  assert.equal(result.target_version, '0.160.1');
  assert.deepEqual(result.server_versions, { a: '0.160.0', b: '0.160.0', recovery: '0.160.0' });
  assert.equal(result.turns.held.terminal_observed, false);
  assert.equal(result.recovery.loaded_before_resume.contains_thread, false);
  assert.equal(result.recovery.loaded_after_resume.contains_thread, true);
  assert.equal(result.recovery.original_execution_continued_after_restart, null);
  assert.equal(result.measurement_success, true);
  assert.equal(calculateMetadataRecoverySuccess(result), true);
  assert.equal(calculateRecoverySuccess(result), false);
  result.metadata_recovery_success = true;
  result.steer.native_item_thread_turn_match = true;
  result.steer.native_item_client_id_match = true;
  assert.equal(calculateRecoverySuccess(result), true);
});
