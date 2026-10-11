'use strict';

const { spawn } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TextDecoder } = require('node:util');
const { createRegistrationKernel } = require('../../src/server/conversation-registry');
const { createLaunchBindingKernel } = require('../../src/server/launch-binding');
const { createRuntimeBindingKernel } = require('../../src/server/runtime-binding');
const { createNativeLaunchComposition } = require('../../src/server/native-launch-composition');
const { createOwnedNativeRunner } = require('../../src/server/owned-native-runner');

const PROFILE_ID = 'claude-wait-reconnect-probe';
const RUNNER_PROFILE = 'cockpit-native-wait-v1';
const FIXTURE_WAIT_NONCE = '314'.padEnd(48, '0');
const VERSION_OUTPUT_LIMIT = 4096;
const VERSION_TIMEOUT_MS = 8000;
const TERMINATION_GRACE_MS = 3000;
const LIVE_CASE_TIMEOUT_MS = 90000;
const FIXTURE_CASE_TIMEOUT_MS = 800;
const ENVIRONMENT_ALLOWLIST = Object.freeze(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC']);
const KNOWN_FAILURES = new Set([
  'probe_setup_failed', 'probe_start_failed', 'probe_wait_unavailable', 'probe_wait_stale',
  'probe_stop_unconfirmed', 'version_spawn_failed', 'version_process_error', 'version_stderr',
  'version_output_limit', 'version_timeout', 'version_exit_failed', 'version_output_invalid',
  'version_unconfirmed', 'authentication_unavailable', 'executable_unavailable', 'probe_cleanup_failed',
]);

function fixedError(code) {
  const error = new Error('Claude wait reconnect probe operation failed');
  error.code = KNOWN_FAILURES.has(code) ? code : 'probe_setup_failed';
  return error;
}

function promptForNonce(nonce) {
  return `Use cockpit_wait exactly once with nonce ${nonce}. If it returns, continue without calling it again.`;
}

function executablePathFor(homeDirectory = os.homedir()) {
  return path.join(homeDirectory, '.local', 'bin', 'claude.exe');
}

function parseArguments(argv) {
  if (!Array.isArray(argv) || argv.length === 0) return 'preflight';
  if (argv.length === 1 && argv[0] === '--live') return 'live';
  throw fixedError('probe_setup_failed');
}

function runPreflight(executablePath = executablePathFor()) {
  let executableAvailable = false;
  try {
    const stat = fs.statSync(executablePath);
    executableAvailable = stat.isFile();
  } catch {}
  return Object.freeze({
    schemaVersion: 'claude-wait-reconnect-preflight-v1',
    mode: 'preflight',
    executableAvailable,
    status: executableAvailable ? 'ready' : 'executable_unavailable',
    liveReady: false,
    reason: 'live_probe_not_started',
  });
}

function isWithin(parent, target) {
  const relative = path.relative(path.resolve(parent), path.resolve(target));
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function samePath(left, right) {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function inspectDirectoryChain(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  const rootStat = fs.lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
  const relative = path.relative(root, absolute);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
  }
  return true;
}

function ensureDirectory(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  const rootStat = fs.lstatSync(current);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw fixedError('probe_setup_failed');
  const relative = path.relative(root, absolute);
  for (const part of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current); }
    catch (error) { if (!error || error.code !== 'EEXIST') throw fixedError('probe_setup_failed'); }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw fixedError('probe_setup_failed');
  }
  return absolute;
}

function createOwnedRoot(parent) {
  const parentPath = path.resolve(parent);
  ensureDirectory(parentPath);
  const root = path.join(parentPath, `claude-wait-reconnect-${crypto.randomUUID()}`);
  fs.mkdirSync(root);
  if (!isWithin(parentPath, root) || !inspectDirectoryChain(root)) throw fixedError('probe_setup_failed');
  for (const directory of ['home', 'cwd', 'tmp']) ensureDirectory(path.join(root, directory));
  return root;
}

function removeOwnedRoot(parent, root) {
  const parentPath = path.resolve(parent), rootPath = path.resolve(root);
  if (!isWithin(parentPath, rootPath) || !inspectDirectoryChain(parentPath) || !inspectDirectoryChain(rootPath) ||
      !samePath(fs.realpathSync(parentPath), parentPath) || !samePath(fs.realpathSync(rootPath), rootPath)) {
    throw fixedError('probe_cleanup_failed');
  }
  fs.rmSync(rootPath, { recursive: true, force: false });
}

function fixedEnvironment(homePath) {
  const environment = {};
  for (const key of ENVIRONMENT_ALLOWLIST) {
    const value = process.env[key];
    if (typeof value === 'string' && value.length > 0 && !/[\u0000]/.test(value)) environment[key] = value;
  }
  const tempPath = path.join(homePath, 'tmp');
  Object.assign(environment, {
    HOME: homePath,
    USERPROFILE: homePath,
    APPDATA: path.join(homePath, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(homePath, 'AppData', 'Local'),
    TMP: tempPath,
    TEMP: tempPath,
    TMPDIR: tempPath,
    XDG_CONFIG_HOME: path.join(homePath, '.config'),
    XDG_DATA_HOME: path.join(homePath, '.local', 'share'),
    XDG_CACHE_HOME: path.join(homePath, '.cache'),
    CLAUDE_CONFIG_DIR: homePath,
  });
  if (process.platform === 'win32') {
    const homeRoot = path.parse(homePath).root;
    environment.HOMEDRIVE = homeRoot.replace(/[\\/]$/, '');
    environment.HOMEPATH = path.sep + path.relative(homeRoot, homePath);
  }
  return environment;
}

function parseVersionOutput(chunks) {
  let output;
  try { output = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)); }
  catch { return null; }
  const line = output.trim();
  if (!line || /[\r\n]/.test(line)) return null;
  const match = /^(\d+\.\d+\.\d+)(?: \(Claude Code\))?$/.exec(line);
  return match ? match[1] : null;
}

function runVersionChild({ executablePath, root, spawnImpl = spawn, timeoutMs = VERSION_TIMEOUT_MS, graceMs = TERMINATION_GRACE_MS }) {
  const rootPath = path.resolve(root);
  try {
    if (!inspectDirectoryChain(rootPath)) return Promise.resolve({ ok: false, version: null, reason: 'version_unconfirmed', rootSafeToDelete: false });
    for (const directory of ['tmp', '.config', '.cache', '.local/share', 'AppData/Roaming', 'AppData/Local']) {
      ensureDirectory(path.join(rootPath, 'home', directory));
    }
    ensureDirectory(path.join(rootPath, 'cwd'));
  } catch {
    return Promise.resolve({ ok: false, version: null, reason: 'version_unconfirmed', rootSafeToDelete: true });
  }
  let child;
  try {
    child = spawnImpl(executablePath, ['--version'], {
      cwd: path.join(rootPath, 'cwd'),
      env: fixedEnvironment(path.join(rootPath, 'home')),
      shell: false,
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  } catch {
    return Promise.resolve({ ok: false, version: null, reason: 'version_spawn_failed', rootSafeToDelete: true });
  }
  if (!child || typeof child.on !== 'function') {
    return Promise.resolve({ ok: false, version: null, reason: 'version_spawn_failed', rootSafeToDelete: false });
  }

  return new Promise((resolve) => {
    let started = false, exited = false, closed = false, errored = false;
    let exitCode = null, exitSignal = null, firstFailure = null, killed = false, finished = false;
    let byteCount = 0;
    const chunks = [];
    let deadlineTimer = null, graceTimer = null;
    const clearTimers = () => { clearTimeout(deadlineTimer); clearTimeout(graceTimer); };
    const finish = (result) => {
      if (finished) return;
      finished = true;
      clearTimers();
      resolve(result);
    };
    const terminal = () => (exited && closed) || (errored && !started && child.pid == null && closed);
    const maybeFinish = () => {
      if (!terminal()) return;
      const rootSafeToDelete = true;
      if (firstFailure) return finish({ ok: false, version: null, reason: firstFailure, rootSafeToDelete });
      if (!started || exitCode !== 0 || exitSignal !== null) {
        return finish({ ok: false, version: null, reason: 'version_exit_failed', rootSafeToDelete });
      }
      const version = parseVersionOutput(chunks);
      if (!version) return finish({ ok: false, version: null, reason: 'version_output_invalid', rootSafeToDelete });
      finish({ ok: true, version, reason: null, rootSafeToDelete });
    };
    const failAndStop = (reason) => {
      if (finished) return;
      if (!firstFailure) firstFailure = reason;
      if (child.pid != null && !killed) {
        killed = true;
        try { child.kill(); } catch {}
      }
      if (graceTimer === null) {
        graceTimer = setTimeout(() => {
          if (terminal()) maybeFinish();
          else finish({ ok: false, version: null, reason: firstFailure || 'version_unconfirmed', rootSafeToDelete: false });
        }, graceMs);
      }
      maybeFinish();
    };

    child.on('spawn', () => { started = true; maybeFinish(); });
    child.on('error', () => { errored = true; failAndStop('version_process_error'); maybeFinish(); });
    child.on('exit', (code, signal) => { exited = true; exitCode = code; exitSignal = signal; maybeFinish(); });
    child.on('close', () => { closed = true; maybeFinish(); });
    if (child.stdout && typeof child.stdout.on === 'function') {
      child.stdout.on('error', () => failAndStop('version_process_error'));
      child.stdout.on('data', (chunk) => {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        byteCount += bytes.length;
        if (byteCount > VERSION_OUTPUT_LIMIT) { failAndStop('version_output_limit'); return; }
        chunks.push(bytes);
      });
    } else failAndStop('version_output_invalid');
    if (child.stderr && typeof child.stderr.on === 'function') {
      child.stderr.on('error', () => failAndStop('version_process_error'));
      child.stderr.on('data', (chunk) => {
        if ((Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk))) > 0) failAndStop('version_stderr');
      });
    } else failAndStop('version_stderr');
    deadlineTimer = setTimeout(() => failAndStop('version_timeout'), timeoutMs);
  });
}

function deferred() {
  let resolve, settled = false;
  const promise = new Promise((done) => { resolve = done; });
  return {
    promise,
    resolve(value) { if (settled) return false; settled = true; resolve(value); return true; },
  };
}

async function settleWithin(promise, milliseconds) {
  let timer;
  const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve({ timedOut: true }), milliseconds); });
  const result = await Promise.race([
    Promise.resolve(promise).then(value => ({ timedOut: false, value }), () => ({ timedOut: false, rejected: true })),
    timeout,
  ]);
  clearTimeout(timer);
  return result;
}

function safeFailure(error, fallback = 'probe_start_failed') {
  return error && typeof error.code === 'string' && KNOWN_FAILURES.has(error.code) ? error.code : fallback;
}

function createCaseResult(phase) {
  return {
    phase,
    status: 'unknown',
    reason: null,
    identityReady: false,
    waitObserved: false,
    verifiedWaitCallbackCount: 0,
    waitCurrentBefore: false,
    collectorDisconnected: false,
    collectorReconnectAttempted: false,
    invalidationNotificationObserved: false,
    waitCurrentAfterReconnect: null,
    settleAttempted: false,
    settleAccepted: null,
    settleAttemptCount: 0,
    distinctContextObserved: false,
    proofCheckpointCompleted: false,
    freshCurrentProofAtCheckpoint: null,
    responseWriteObserved: null,
    childExited: false,
    childClosed: false,
    ownedChildInactive: false,
    waitEndpointInactive: false,
    stopConfirmed: false,
    rootRemoved: false,
  };
}

async function runOwnedCase({ phase, rootParent, executablePath, oauthToken, prompt, spawnImpl = spawn,
  timeoutMs = LIVE_CASE_TIMEOUT_MS, driveFixtureStart = null, driveFixtureWait = null, driveFixtureAfterWait = null }) {
  const result = createCaseResult(phase);
  let root = null, composition = null, collector = null, receipt = null, runner = null, childCreated = false;
  let started = null, waitRecord = null, baselineProof = null, bObserved = false;
  const identityConnected = deferred(), verifiedWait = deferred(), proofCheckpoint = deferred();
  let invalidationNotified = false;
  let observationOpen = true;
  try {
    root = createOwnedRoot(rootParent);
    const homePath = path.join(root, 'home'), cwd = path.join(root, 'cwd');
    const registrationKernel = createRegistrationKernel();
    const launchKernel = createLaunchBindingKernel({ registrationRegistry: registrationKernel.registry });
    const runtimeKernel = createRuntimeBindingKernel({ registrationRegistry: registrationKernel.registry, launchRegistry: launchKernel.registry });
    let launchRef = null;
    const runnerTimeoutMs = Math.min(30000, Math.max(1000, timeoutMs));
    composition = createNativeLaunchComposition({
      registrationKernel, launchKernel, runtimeKernel,
      hostId: 'claude-wait-reconnect-probe',
      profiles: { [PROFILE_ID]: {
        provider: 'claude', executablePath, homePath, cwd, homeScopeId: `wait-reconnect-${crypto.randomUUID()}`,
        runnerProfile: RUNNER_PROFILE,
      } },
      getAuthentication: () => ({ oauthToken }),
      runnerFactory(options) {
        runner = createOwnedNativeRunner({
          ...options,
          spawnImpl(...arguments_) {
            const child = spawnImpl(...arguments_);
            childCreated = Boolean(child);
            return child;
          },
          onNative(event) {
            const nativeResult = options.onNative(event);
            if (!observationOpen) return nativeResult;
            if (event?.type === 'identity') {
              try {
                Promise.resolve(collector.connect()).then((connection) => {
                  identityConnected.resolve(connection?.status === 'connected');
                }, () => identityConnected.resolve(false));
              } catch {
                identityConnected.resolve(false);
              }
            }
            const contextId = event?.type === 'context' ? event.context?.nativeContextId : null;
            if (waitRecord && typeof contextId === 'string' && contextId !== waitRecord.contextId && !bObserved) {
              bObserved = true;
              result.distinctContextObserved = true;
              setImmediate(() => {
                if (!observationOpen) return;
                let proof = null, fresh = false;
                try {
                  proof = composition.resolveProof(launchRef);
                  fresh = Boolean(baselineProof && proof && proof !== baselineProof &&
                    composition.checkCurrentProof(launchRef, proof)?.ok === true);
                } catch {}
                result.proofCheckpointCompleted = true;
                result.freshCurrentProofAtCheckpoint = fresh;
                proofCheckpoint.resolve(true);
              });
            }
            return nativeResult;
          },
          timeouts: { startupMs: runnerTimeoutMs, rpcMs: runnerTimeoutMs, loginMs: runnerTimeoutMs, stopMs: Math.min(5000, runnerTimeoutMs) },
        });
        return runner;
      },
    });
    receipt = composition.admitLaunch({
      launchId: crypto.randomUUID(), runId: crypto.randomUUID(), attemptId: crypto.randomUUID(),
      profileId: PROFILE_ID, origin: 'standalone', purpose: 'agent',
    });
    collector = composition.createOwnedCollector(receipt);
    const owner = composition.createWaitOwner(receipt);
    owner.subscribeVerifiedWait((handle, metadata) => {
      if (!observationOpen) return;
      result.verifiedWaitCallbackCount += 1;
      if (waitRecord) return;
      waitRecord = { handle, contextId: typeof metadata?.nativeContextId === 'string' ? metadata.nativeContextId : null };
      verifiedWait.resolve(waitRecord);
    });
    owner.subscribeWaitInvalidated((handle) => {
      if (!observationOpen) return;
      if (waitRecord?.handle === handle) invalidationNotified = true;
    });

    started = await composition.start(receipt, { inputText: prompt });
    launchRef = started.launchRef;
    if (typeof driveFixtureStart === 'function') await driveFixtureStart(phase);
    const connected = await settleWithin(identityConnected.promise, timeoutMs);
    result.identityReady = connected.timedOut === false && connected.value === true;
    if (!result.identityReady) throw fixedError('probe_start_failed');
    await collector.connect();
    if (typeof driveFixtureWait === 'function') await driveFixtureWait(phase);

    const captured = await settleWithin(verifiedWait.promise, timeoutMs);
    if (captured.timedOut || captured.rejected || !captured.value) throw fixedError('probe_wait_unavailable');
    result.waitObserved = true;
    baselineProof = composition.resolveProof(launchRef);
    if (baselineProof === null || baselineProof === undefined) throw fixedError('probe_wait_unavailable');
    if (typeof driveFixtureAfterWait === 'function') await driveFixtureAfterWait(phase);
    result.waitCurrentBefore = owner.checkWait(captured.value.handle) === true;

    if (phase === 'control') {
      if (!result.waitCurrentBefore) throw fixedError('probe_wait_stale');
      result.settleAttempted = true;
      result.settleAttemptCount = 1;
      result.settleAccepted = owner.settleWait(captured.value.handle, 'released') === true;
      if (result.settleAccepted) {
        await settleWithin(proofCheckpoint.promise, timeoutMs);
        result.status = result.distinctContextObserved && result.proofCheckpointCompleted &&
          result.freshCurrentProofAtCheckpoint === true ? 'observed' : 'unknown';
      }
      if (result.status !== 'observed') result.reason = 'probe_wait_unavailable';
    } else {
      if (!result.waitCurrentBefore) throw fixedError('probe_wait_stale');
      result.collectorDisconnected = (await collector.disconnect())?.status === 'disconnected';
      if (!result.collectorDisconnected) throw fixedError('probe_wait_stale');
      result.collectorReconnectAttempted = true;
      const reconnectStatus = await collector.connect();
      const collectorReconnected = reconnectStatus?.status === 'connected';
      if (!collectorReconnected) throw fixedError('probe_wait_stale');
      result.invalidationNotificationObserved = invalidationNotified;
      result.waitCurrentAfterReconnect = owner.checkWait(captured.value.handle) === true;
      result.settleAttempted = true;
      result.settleAttemptCount = 1;
      result.settleAccepted = owner.settleWait(captured.value.handle, 'released') === true;
      await settleWithin(proofCheckpoint.promise, timeoutMs);
      result.status = result.waitCurrentBefore && result.collectorDisconnected && collectorReconnected &&
        result.waitCurrentAfterReconnect === false && result.settleAccepted === false ? 'observed' : 'unknown';
      if (result.status !== 'observed') result.reason = 'probe_wait_stale';
    }
  } catch (error) {
    result.status = 'unknown';
    result.reason = safeFailure(error);
  } finally {
    observationOpen = false;
    if (collector) {
      try { await collector.disconnect(); } catch {}
    }
    if (composition && receipt) {
      try { await composition.stop(receipt); } catch {}
    }
    let snapshot = null;
    try { snapshot = runner?.snapshot?.() || null; } catch {}
    result.childExited = snapshot?.childExited === true;
    result.childClosed = snapshot?.childClosed === true;
    result.ownedChildInactive = snapshot ? snapshot.ownedChildActive === false : true;
    result.waitEndpointInactive = snapshot ? snapshot.waitEndpointActive === false : true;
    result.stopConfirmed = !childCreated
      ? result.waitEndpointInactive
      : result.childExited && result.childClosed && result.ownedChildInactive && result.waitEndpointInactive;
    if (root && result.stopConfirmed) {
      try { removeOwnedRoot(rootParent, root); result.rootRemoved = true; }
      catch { result.reason = 'probe_cleanup_failed'; result.status = 'unknown'; }
    } else if (root) {
      result.reason = 'probe_stop_unconfirmed';
      result.status = 'unknown';
    }
  }
  return Object.freeze(result);
}

function runtimeHomeParent() {
  const repositoryRoot = path.resolve(__dirname, '../..');
  return ensureDirectory(path.join(repositoryRoot, '.cross-review', 'runtime-home'));
}

async function runLiveProbe() {
  const executablePath = executablePathFor();
  const preflight = runPreflight(executablePath);
  if (!preflight.executableAvailable) {
    return Object.freeze({ schemaVersion: 'claude-wait-reconnect-live-v1', mode: 'live', status: 'unknown', reason: 'executable_unavailable', version: null, control: null, reconnect: null, responseWriteObserved: null });
  }
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (typeof oauthToken !== 'string' || oauthToken.length === 0) {
    return Object.freeze({ schemaVersion: 'claude-wait-reconnect-live-v1', mode: 'live', status: 'unknown', reason: 'authentication_unavailable', version: null, control: null, reconnect: null, responseWriteObserved: null });
  }
  let parent;
  try { parent = runtimeHomeParent(); }
  catch { return Object.freeze({ schemaVersion: 'claude-wait-reconnect-live-v1', mode: 'live', status: 'unknown', reason: 'probe_setup_failed', version: null, control: null, reconnect: null, responseWriteObserved: null }); }
  let versionRoot;
  try { versionRoot = createOwnedRoot(parent); }
  catch {
    return Object.freeze({ schemaVersion: 'claude-wait-reconnect-live-v1', mode: 'live', status: 'unknown', reason: 'probe_setup_failed', version: null, control: null, reconnect: null, responseWriteObserved: null });
  }
  const version = await runVersionChild({ executablePath, root: versionRoot });
  if (version.rootSafeToDelete) {
    try { removeOwnedRoot(parent, versionRoot); }
    catch { return Object.freeze({ schemaVersion: 'claude-wait-reconnect-live-v1', mode: 'live', status: 'unknown', reason: 'probe_cleanup_failed', version: null, control: null, reconnect: null, responseWriteObserved: null }); }
  } else {
    return Object.freeze({ schemaVersion: 'claude-wait-reconnect-live-v1', mode: 'live', status: 'unknown', reason: 'version_unconfirmed', version: null, control: null, reconnect: null, responseWriteObserved: null });
  }
  if (!version.ok) {
    return Object.freeze({ schemaVersion: 'claude-wait-reconnect-live-v1', mode: 'live', status: 'unknown', reason: version.reason, version: null, control: null, reconnect: null, responseWriteObserved: null });
  }
  const controlNonce = crypto.randomBytes(24).toString('hex');
  const control = await runOwnedCase({ phase: 'control', rootParent: parent, executablePath, oauthToken,
    prompt: promptForNonce(controlNonce) });
  if (control.status !== 'observed' || !control.stopConfirmed || !control.rootRemoved) {
    return Object.freeze({ schemaVersion: 'claude-wait-reconnect-live-v1', mode: 'live', status: 'unknown', reason: control.reason || 'probe_start_failed', version: version.version, control, reconnect: null, responseWriteObserved: null });
  }
  const reconnectNonce = crypto.randomBytes(24).toString('hex');
  const reconnect = await runOwnedCase({ phase: 'reconnect', rootParent: parent, executablePath, oauthToken,
    prompt: promptForNonce(reconnectNonce) });
  const complete = reconnect.status === 'observed' && reconnect.stopConfirmed && reconnect.rootRemoved;
  return Object.freeze({
    schemaVersion: 'claude-wait-reconnect-live-v1', mode: 'live', status: complete ? 'observed' : 'unknown',
    reason: complete ? null : reconnect.reason || 'probe_start_failed', version: version.version,
    control, reconnect, responseWriteObserved: null,
  });
}

async function runFixtureProbe(input) {
  const allowed = ['rootParent', 'executablePath', 'oauthToken', 'spawnImpl', 'driveFixtureStart', 'driveFixtureWait', 'driveFixtureAfterWait', 'timeoutMs'];
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      Reflect.ownKeys(input).some((key) => !allowed.includes(key)) ||
      typeof input.rootParent !== 'string' || !path.isAbsolute(input.rootParent) ||
      typeof input.executablePath !== 'string' || !path.isAbsolute(input.executablePath) ||
      typeof input.oauthToken !== 'string' || input.oauthToken.length === 0 || typeof input.spawnImpl !== 'function' ||
      typeof input.driveFixtureStart !== 'function' || typeof input.driveFixtureWait !== 'function' ||
      input.driveFixtureAfterWait !== undefined && typeof input.driveFixtureAfterWait !== 'function' ||
      (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1))) {
    throw fixedError('probe_setup_failed');
  }
  if (!inspectDirectoryChain(input.rootParent) || !fs.statSync(input.executablePath).isFile()) throw fixedError('probe_setup_failed');
  const parent = path.resolve(input.rootParent), timeoutMs = input.timeoutMs || FIXTURE_CASE_TIMEOUT_MS;
  let versionRoot = null;
  try { versionRoot = createOwnedRoot(parent); }
  catch { return Object.freeze({ schemaVersion: 'claude-wait-reconnect-fixture-v1', mode: 'fixture', status: 'unknown', reason: 'probe_setup_failed', version: null, control: null, reconnect: null }); }
  const version = await runVersionChild({ executablePath: input.executablePath, root: versionRoot, spawnImpl: input.spawnImpl, timeoutMs, graceMs: TERMINATION_GRACE_MS });
  if (version.rootSafeToDelete) {
    try { removeOwnedRoot(parent, versionRoot); }
    catch { return Object.freeze({ schemaVersion: 'claude-wait-reconnect-fixture-v1', mode: 'fixture', status: 'unknown', reason: 'probe_cleanup_failed', version: null, control: null, reconnect: null }); }
  } else {
    return Object.freeze({ schemaVersion: 'claude-wait-reconnect-fixture-v1', mode: 'fixture', status: 'unknown', reason: 'version_unconfirmed', version: null, control: null, reconnect: null });
  }
  if (!version.ok) return Object.freeze({ schemaVersion: 'claude-wait-reconnect-fixture-v1', mode: 'fixture', status: 'unknown', reason: version.reason, version: null, control: null, reconnect: null });
  const shared = {
    rootParent: parent,
    executablePath: input.executablePath,
    oauthToken: input.oauthToken,
    prompt: promptForNonce(FIXTURE_WAIT_NONCE),
    spawnImpl: input.spawnImpl,
    timeoutMs,
    driveFixtureStart: input.driveFixtureStart,
    driveFixtureWait: input.driveFixtureWait,
    driveFixtureAfterWait: input.driveFixtureAfterWait,
  };
  const control = await runOwnedCase({ ...shared, phase: 'control' });
  if (control.status !== 'observed' || !control.stopConfirmed || !control.rootRemoved) {
    return Object.freeze({ schemaVersion: 'claude-wait-reconnect-fixture-v1', mode: 'fixture', status: 'unknown', reason: control.reason || 'probe_start_failed', version: version.version, control, reconnect: null });
  }
  const reconnect = await runOwnedCase({ ...shared, phase: 'reconnect' });
  const complete = reconnect.status === 'observed' && reconnect.stopConfirmed && reconnect.rootRemoved;
  return Object.freeze({
    schemaVersion: 'claude-wait-reconnect-fixture-v1', mode: 'fixture', status: complete ? 'observed' : 'unknown',
    reason: complete ? null : reconnect.reason || 'probe_start_failed', version: version.version, control, reconnect,
  });
}

async function main(argv = process.argv.slice(2)) {
  let mode;
  try { mode = parseArguments(argv); }
  catch { process.stdout.write(JSON.stringify({ schemaVersion: 'claude-wait-reconnect-cli-v1', status: 'invalid_arguments' }) + '\n'); process.exitCode = 2; return; }
  const result = mode === 'preflight' ? runPreflight() : await runLiveProbe();
  process.stdout.write(JSON.stringify(result) + '\n');
  if (result.status !== 'ready' && result.status !== 'observed') process.exitCode = 1;
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({ schemaVersion: 'claude-wait-reconnect-cli-v1', status: 'failed', reason: 'probe_setup_failed' }) + '\n');
    process.exitCode = 1;
  });
}

module.exports = Object.freeze({
  __testing: Object.freeze({
    parseArguments,
    runPreflight,
    executablePathFor,
    runVersionChild,
    runFixtureProbe,
    fixedPrompt: promptForNonce(FIXTURE_WAIT_NONCE),
    waitNonce: FIXTURE_WAIT_NONCE,
    versionOutputLimit: VERSION_OUTPUT_LIMIT,
    environmentAllowlist: ENVIRONMENT_ALLOWLIST,
  }),
});
