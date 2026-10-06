'use strict';

const { randomBytes, randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const {
  createCodexManagedProcessManager,
} = require('../../src/server/codex-managed-process');
const {
  createCodexManagedTransport,
} = require('../../src/server/codex-managed-transport');

const CLIENT_INFO = Object.freeze({
  name: 'agent-cockpit-managed-collector-probe',
  title: 'Agent Cockpit managed collector probe',
  version: '0.1.0',
});

async function runManagedCollectorProbe(options = {}) {
  const executablePath = options.executablePath;
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath)) {
    throw safeError('absolute_codex_path_required');
  }
  const repositoryRoot = path.resolve(__dirname, '../..');
  const runId = randomUUID();
  const managedHomeRoot = path.join(repositoryRoot, '.cross-review', 'runtime-home', runId);
  ensureProbeDirectory(repositoryRoot, managedHomeRoot);
  const managedHomePath = path.join(managedHomeRoot, 'codex-home');
  const manager = createCodexManagedProcessManager({
    executablePath,
    managedHomeRoot,
    managedHomePath,
    hostId: 'local-managed-probe',
    homeScopeId: `managed-probe-${runId}`,
    startTimeoutMs: 10_000,
    stopTimeoutMs: 3000,
  });

  let mainTransport = null;
  let mainDisconnectCount = 0;
  let probeResult = {
    status: 'failed',
    serverStarted: false,
    appServerVersion: null,
    capabilityAuthenticationVerified: false,
    managedHomeMatched: false,
    loadedListRead: false,
    loadedItemCount: null,
    wrongTokenRejected: false,
    mainTransportClosed: false,
    mainDisconnectCallbackCount: 0,
    ownedServerStopped: false,
    modelTurnStarted: false,
    remoteCliTurnVerified: false,
    nativeActorProofVerified: false,
  };
  try {
    await manager.start();
    probeResult.serverStarted = true;
    mainTransport = await manager.connect({
      onNotification() {},
      onServerRequest() {},
      onDisconnect() { mainDisconnectCount += 1; },
    });
    const expectedHome = manager.snapshot().managedHomePath;
    const initialize = await mainTransport.request('initialize', {
      clientInfo: CLIENT_INFO,
      capabilities: { experimentalApi: false },
    });
    const version = readVersion(initialize && initialize.userAgent);
    probeResult = {
      ...probeResult,
      appServerVersion: version,
      capabilityAuthenticationVerified: true,
      managedHomeMatched: pathsEqual(initialize && initialize.codexHome, expectedHome),
    };
    if (!version) throw safeError('initialize_response_invalid');
    if (!probeResult.managedHomeMatched) throw safeError('managed_home_mismatch');
    await mainTransport.notify('initialized', {});
    const loaded = await mainTransport.request('thread/loaded/list', { limit: 100 });
    if (!loaded || !Array.isArray(loaded.data) || loaded.data.some((id) => typeof id !== 'string')) {
      throw safeError('invalid_loaded_list');
    }
    probeResult = { ...probeResult, loadedListRead: true, loadedItemCount: loaded.data.length };

    let wrongTokenDisconnectCount = 0;
    let wrongTransport = null;
    try {
      wrongTransport = await createCodexManagedTransport({
        endpoint: manager.snapshot().endpoint,
        capabilityToken: randomBytes(32).toString('hex'),
        onNotification() {},
        onServerRequest() {},
        onDisconnect() { wrongTokenDisconnectCount += 1; },
        timeoutMs: 2000,
      });
      wrongTransport.close();
      throw safeError('wrong_token_accepted');
    } catch (error) {
      if (error.code === 'wrong_token_accepted') throw error;
      if (error.code !== 'handshake_rejected' || wrongTokenDisconnectCount !== 1) {
        throw safeError('wrong_token_rejection_unverified');
      }
      probeResult = { ...probeResult, wrongTokenRejected: true };
    }

    mainTransport.close();
    mainTransport = null;
    probeResult = {
      ...probeResult,
      mainTransportClosed: true,
      mainDisconnectCallbackCount: mainDisconnectCount,
    };
    if (mainDisconnectCount !== 1) throw safeError('disconnect_callback_count_invalid');
    probeResult.status = 'passed';
  } catch (error) {
    const code = error && typeof error.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code)
      ? error.code
      : 'probe_failed';
    probeResult = { ...probeResult, errorCode: code };
  } finally {
    if (mainTransport) {
      try { mainTransport.close(); } catch {}
      mainTransport = null;
    }
    const stopped = await manager.stop().catch(() => null);
    probeResult = {
      ...probeResult,
      mainDisconnectCallbackCount: mainDisconnectCount,
      ownedServerStopped: probeResult.serverStarted && Boolean(stopped && stopped.state === 'stopped'),
    };
  }
  writeSafeReport(probeResult);
  return probeResult;
}

function readVersion(userAgent) {
  if (typeof userAgent !== 'string') return null;
  const match = userAgent.match(/(?:^|[/ ])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:$|[^0-9A-Za-z.+-])/);
  return match ? match[1] : null;
}

function pathsEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !path.isAbsolute(left) || !path.isAbsolute(right)) {
    return false;
  }
  const normalizedLeft = path.normalize(left);
  const normalizedRight = path.normalize(right);
  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
}

function ensureProbeDirectory(repositoryRoot, target) {
  const relative = path.relative(repositoryRoot, target);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw safeError('probe_directory_outside_repository');
  }
  const rootStat = fs.lstatSync(repositoryRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw safeError('probe_directory_invalid');
  let current = repositoryRoot;
  for (const part of relative.split(path.sep)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current); } catch (error) {
      if (!error || error.code !== 'EEXIST') throw safeError('probe_directory_create_failed');
    }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw safeError('probe_directory_invalid');
  }
}

function writeSafeReport(result) {
  const reportDirectory = path.join(path.resolve(__dirname, '../..'), '.cross-review');
  const output = path.join(reportDirectory, 'runtime-probe.json');
  const directoryStat = fs.lstatSync(reportDirectory);
  if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw safeError('report_directory_invalid');
  try {
    const stat = fs.lstatSync(output);
    if (!stat.isFile() || stat.isSymbolicLink()) throw safeError('report_file_invalid');
  } catch (error) {
    if (error && error.code === 'report_file_invalid') throw error;
    if (!error || error.code !== 'ENOENT') throw safeError('report_file_invalid');
  }
  const report = {
    ...result,
    runtimeScope: 'managed_codex_app_server_only',
    remoteCliActualTurn: 'not_tested',
    nativeActorAuthentication: 'not_tested',
  };
  fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
}

function safeError(code) {
  const error = new Error('managed collector probe failed');
  error.code = code;
  return error;
}

function readArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== '--codex-path') throw safeError('invalid_argument');
    const key = argv[index].slice(2);
    const value = argv[index + 1];
    if (!value || value.startsWith('--') || values.has(key)) throw safeError('invalid_argument');
    values.set(key, value);
    index += 1;
  }
  return {
    executablePath: values.get('codex-path'),
  };
}

if (require.main === module) {
  let options;
  try {
    options = readArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.code || 'invalid_argument'}\n`);
    process.exitCode = 1;
  }
  if (options) {
    runManagedCollectorProbe(options).then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (result.status !== 'passed' || !result.ownedServerStopped) process.exitCode = 1;
    }).catch((error) => {
      process.stderr.write(`${error.code || 'probe_failed'}\n`);
      process.exitCode = 1;
    });
  }
}

module.exports = { runManagedCollectorProbe };
