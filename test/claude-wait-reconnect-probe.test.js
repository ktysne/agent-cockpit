'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { __testing } = require('../tools/manual/claude-wait-reconnect-probe');

function temporaryParentPath(parent) {
  const resolved = path.resolve(parent);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir())) return null;
  try {
    const info = fs.lstatSync(resolved);
    return info.isDirectory() && !info.isSymbolicLink() ? resolved : null;
  } catch {
    return null;
  }
}

function cleanupOwnedRoot(parent, root) {
  const parentPath = temporaryParentPath(parent);
  const rootPath = path.resolve(root);
  if (!parentPath || path.dirname(rootPath) !== parentPath) return false;
  try {
    const info = fs.lstatSync(rootPath);
    if (!info.isDirectory() || info.isSymbolicLink()) return false;
    fs.rmSync(rootPath, { recursive: true, force: false });
    return true;
  } catch {
    return false;
  }
}

function cleanupOwnedParent(parent) {
  const parentPath = temporaryParentPath(parent);
  if (!parentPath) return false;
  let entries;
  try { entries = fs.readdirSync(parentPath); } catch { return false; }
  if (entries.length === 0) {
    try { fs.rmdirSync(parentPath); return true; } catch { return false; }
  }
  if (entries.length !== 1 || entries[0] !== 'claude.exe') return false;
  const executable = path.join(parentPath, 'claude.exe');
  try {
    const info = fs.lstatSync(executable);
    if (!info.isFile() || info.isSymbolicLink()) return false;
    fs.unlinkSync(executable);
    fs.rmdirSync(parentPath);
    return true;
  } catch {
    return false;
  }
}

function createChild({ termination = 'both' } = {}) {
  const child = new EventEmitter();
  const emit = child.emit.bind(child);
  child.exitObserved = false;
  child.closeObserved = false;
  child.emit = (event, ...values) => {
    if (event === 'exit') child.exitObserved = true;
    if (event === 'close') child.closeObserved = true;
    return emit(event, ...values);
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = Object.assign(new EventEmitter(), {
    destroyed: false,
    write(line, callback) {
      const message = JSON.parse(line);
      if (!Object.hasOwn(message, 'session_id')) {
        child.startupInputObserved = true;
        child.send({ type: 'system', subtype: 'init', session_id: 'fixture-session' });
        emitContext(child, 'fixture-context-a');
      }
      queueMicrotask(() => callback?.());
      return true;
    },
    end() { this.destroyed = true; },
  });
  child.pid = 1234;
  child.killCalls = 0;
  child.kill = () => {
    child.killCalls += 1;
    child.pendingRequest?.destroy();
    setImmediate(() => {
      if (termination !== 'close-only') child.emit('exit', 0, null);
      if (termination !== 'exit-only') child.emit('close', 0, null);
    });
    return true;
  };
  child.send = (message) => child.stdout.emit('data', Buffer.from(JSON.stringify(message) + '\n'));
  return child;
}

function emitContext(child, contextId) {
  child.contextSequence.push(contextId);
  child.send({
    type: 'stream_event', session_id: 'fixture-session', parent_tool_use_id: null,
    event: { type: 'message_start', message: { role: 'assistant', id: contextId } },
  });
}

function emitContextEnd(child) {
  child.send({
    type: 'stream_event', session_id: 'fixture-session', parent_tool_use_id: null,
    event: { type: 'message_stop' },
  });
}

function postWaitRequest(child, body) {
  return new Promise((resolve, reject) => {
    const request = http.request(child.waitUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${child.waitSecret}` },
    }, (response) => {
      let text = '';
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => {
        child.pendingRequest = null;
        resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null });
      });
    });
    child.pendingRequest = request;
    request.on('error', reject);
    request.end(JSON.stringify(body));
  });
}

async function fixtureReady(child) {
  const configIndex = child.args.indexOf('--mcp-config');
  assert.ok(configIndex > -1);
  const configuration = JSON.parse(child.args[configIndex + 1]);
  child.waitUrl = new URL(configuration.mcpServers.cockpit_wait.url);
  child.waitSecret = child.environment.COCKPIT_NATIVE_MCP_SECRET;
  assert.equal((await postWaitRequest(child, {
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' },
  })).status, 200);
  await postWaitRequest(child, { jsonrpc: '2.0', method: 'notifications/initialized' });
}

function makeSpawnHarness({ runnerTermination = 'both', terminalizeContextB = false, duplicateWaitAfterCapture = false,
  duplicateWaitOnReconnect = false, contextCBeforeCheckpoint = false } = {}) {
  const versions = [], runners = [], calls = [], drivenStart = [], drivenWait = [];
  function spawnImpl(executablePath, args, options) {
    calls.push({ executablePath, args: [...args], options });
    if (args.length === 1 && args[0] === '--version') {
      const child = createChild();
      versions.push(child);
      setImmediate(() => {
        child.emit('spawn');
        child.stdout.emit('data', Buffer.from('2.7.4 (Claude Code)\n'));
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return child;
    }
    const child = createChild({ termination: runnerTermination });
    child.contextSequence = [];
    child.args = [...args];
    child.environment = { ...options.env };
    runners.push(child);
    setImmediate(() => child.emit('spawn'));
    return child;
  }
  async function driveStart(phase) {
    drivenStart.push(phase);
    const child = runners[phase === 'control' ? 0 : 1];
    assert.ok(child);
    assert.equal(child.startupInputObserved, true);
    await fixtureReady(child);
  }
  async function driveWait(phase) {
    drivenWait.push(phase);
    const child = runners[phase === 'control' ? 0 : 1];
    emitWaitTool(child, phase);
    const waitRequest = postWaitRequest(child, {
      jsonrpc: '2.0', id: 2, method: 'tools/call',
      params: { name: 'cockpit_wait', arguments: { nonce: __testing.waitNonce } },
    });
    child.waitCall = waitRequest.then((response) => {
      if (phase === 'control' && response.body?.result?.content?.[0]?.text === 'released') {
        child.send({
          type: 'user', session_id: 'fixture-session', parent_tool_use_id: null,
          message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'fixture-wait-control', content: [{ type: 'text', text: 'released' }] }] },
        });
        emitContext(child, 'fixture-context-b');
        if (contextCBeforeCheckpoint) {
          emitContextEnd(child);
          emitContext(child, 'fixture-context-c');
        }
        if (terminalizeContextB) child.send({
          type: 'result', session_id: 'fixture-session',
          uuid: '00000000-0000-4000-8000-000000000001',
        });
      }
      return response;
    }, () => null);
  }
  function emitWaitTool(child, phase) {
    child.send({
      type: 'assistant', session_id: 'fixture-session', parent_tool_use_id: null,
      message: {
        role: 'assistant', id: 'fixture-context-a',
        content: [{ type: 'tool_use', id: `fixture-wait-${phase}`, name: 'mcp__cockpit_wait__cockpit_wait', input: { nonce: __testing.waitNonce } }],
      },
    });
  }
  async function driveAfterWait(phase) {
    if (!(duplicateWaitAfterCapture && phase === 'control') && !(duplicateWaitOnReconnect && phase === 'reconnect')) return;
    emitWaitTool(runners[phase === 'control' ? 0 : 1], phase);
  }
  return { spawnImpl, versions, runners, calls, drivenStart, drivenWait, driveStart, driveWait, driveAfterWait };
}

test('CLI accepts only preflight or explicit live mode and preflight performs only executable stat', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-reconnect-preflight-'));
  t.after(() => cleanupOwnedParent(directory));
  const executable = path.join(directory, 'claude.exe');
  fs.writeFileSync(executable, 'fixture');
  assert.equal(__testing.parseArguments([]), 'preflight');
  assert.equal(__testing.parseArguments(['--live']), 'live');
  assert.throws(() => __testing.parseArguments(['--live', '--profile', 'other']));
  assert.deepEqual(__testing.runPreflight(executable), {
    schemaVersion: 'claude-wait-reconnect-preflight-v1', mode: 'preflight', executableAvailable: true,
    status: 'ready', liveReady: false, reason: 'live_probe_not_started',
  });
  assert.equal(__testing.runPreflight(path.join(directory, 'missing.exe')).executableAvailable, false);
});

test('version probe accepts a bounded strict line and exposes only the numeric version', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-reconnect-version-'));
  const root = fs.mkdtempSync(path.join(parent, 'owned-'));
  t.after(() => cleanupOwnedParent(parent));
  const child = createChild();
  const resultPromise = __testing.runVersionChild({
    executablePath: path.join(parent, 'claude.exe'), root,
    spawnImpl() {
      setImmediate(() => {
        child.emit('spawn');
        child.stdout.emit('data', Buffer.from('2.7.4 (Claude Code)\r\n'));
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  const result = await resultPromise;
  assert.deepEqual(result, { ok: true, version: '2.7.4', reason: null, rootSafeToDelete: true });
  assert.equal(child.killCalls, 0);
  assert.equal(cleanupOwnedRoot(parent, root), true);
});

test('Windows version environment reconstructs the isolated home from its drive pair', { skip: process.platform !== 'win32' }, async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-reconnect-windows-home-'));
  const root = fs.mkdtempSync(path.join(parent, 'owned-'));
  const child = createChild();
  let capturedEnvironment = null;
  t.after(() => cleanupOwnedParent(parent));
  const result = await __testing.runVersionChild({
    executablePath: path.join(parent, 'claude.exe'), root,
    spawnImpl(executablePath, args, options) {
      capturedEnvironment = { ...options.env };
      setImmediate(() => {
        child.emit('spawn');
        child.stdout.emit('data', Buffer.from('2.7.4\n'));
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  assert.equal(result.ok, true);
  const homePair = `${capturedEnvironment.HOMEDRIVE}${capturedEnvironment.HOMEPATH}`;
  assert.equal(path.win32.isAbsolute(homePair), true);
  assert.equal(path.win32.normalize(homePair).toLowerCase(), path.win32.normalize(capturedEnvironment.HOME).toLowerCase());
  assert.equal(path.win32.normalize(capturedEnvironment.USERPROFILE).toLowerCase(), path.win32.normalize(capturedEnvironment.HOME).toLowerCase());
  assert.equal(cleanupOwnedRoot(parent, root), true);
});

test('version probe keeps the first stderr failure and kills only once', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-reconnect-stderr-'));
  const root = fs.mkdtempSync(path.join(parent, 'owned-'));
  t.after(() => cleanupOwnedParent(parent));
  const child = createChild();
  const result = await __testing.runVersionChild({
    executablePath: path.join(parent, 'claude.exe'), root, timeoutMs: 500,
    spawnImpl() {
      setImmediate(() => {
        child.emit('spawn');
        child.stderr.emit('data', Buffer.from('private diagnostic'));
        child.stdout.emit('data', Buffer.from('2.7.4\n'));
      });
      return child;
    },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'version_stderr');
  assert.equal(result.rootSafeToDelete, true);
  assert.equal(child.killCalls, 1);
  assert.equal(JSON.stringify(result).includes('private diagnostic'), false);
  assert.equal(cleanupOwnedRoot(parent, root), true);
});

test('stdout and stderr stream errors use a fixed failure and wait for child shutdown', async t => {
  for (const streamName of ['stdout', 'stderr']) {
    await t.test(streamName, async tCase => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), `wait-reconnect-${streamName}-error-`));
      const root = fs.mkdtempSync(path.join(parent, 'owned-'));
      const child = createChild();
      tCase.after(() => cleanupOwnedParent(parent));
      const result = await __testing.runVersionChild({
        executablePath: path.join(parent, 'claude.exe'), root, timeoutMs: 500,
        spawnImpl() {
          setImmediate(() => {
            child.emit('spawn');
            child[streamName].emit('error', new Error('private-stream-sentinel'));
          });
          return child;
        },
      });
      assert.deepEqual(result, { ok: false, version: null, reason: 'version_process_error', rootSafeToDelete: true });
      assert.equal(child.killCalls, 1);
      assert.equal(child.exitObserved, true);
      assert.equal(child.closeObserved, true);
      assert.equal(JSON.stringify(result).includes('private-stream-sentinel'), false);
      assert.equal(cleanupOwnedRoot(parent, root), true);
    });
  }
});

test('version stream error listeners remain attached after successful settlement', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-reconnect-late-stream-error-'));
  const root = fs.mkdtempSync(path.join(parent, 'owned-'));
  const child = createChild();
  t.after(() => cleanupOwnedParent(parent));
  const result = await __testing.runVersionChild({
    executablePath: path.join(parent, 'claude.exe'), root,
    spawnImpl() {
      setImmediate(() => {
        child.emit('spawn');
        child.stdout.emit('data', Buffer.from('2.7.4\n'));
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      });
      return child;
    },
  });
  assert.deepEqual(result, { ok: true, version: '2.7.4', reason: null, rootSafeToDelete: true });
  assert.equal(child.stdout.listenerCount('error'), 1);
  assert.equal(child.stderr.listenerCount('error'), 1);
  child.stdout.emit('error', new Error('late-private-stream-sentinel'));
  child.stderr.emit('error', new Error('late-private-stream-sentinel'));
  assert.equal(JSON.stringify(result).includes('late-private-stream-sentinel'), false);
  assert.equal(cleanupOwnedRoot(parent, root), true);
});

test('version timeout remains failure after a late zero exit and close', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-reconnect-late-exit-'));
  const root = fs.mkdtempSync(path.join(parent, 'owned-'));
  const child = createChild();
  child.kill = () => { child.killCalls += 1; return true; };
  t.after(() => cleanupOwnedParent(parent));
  const resultPromise = __testing.runVersionChild({
    executablePath: path.join(parent, 'claude.exe'), root, timeoutMs: 10, graceMs: 200,
    spawnImpl() {
      setImmediate(() => {
        child.emit('spawn');
        child.stdout.emit('data', Buffer.from('2.7.4\n'));
      });
      setTimeout(() => {
        child.emit('exit', 0, null);
        child.emit('close', 0, null);
      }, 30);
      return child;
    },
  });
  const result = await resultPromise;
  assert.deepEqual(result, { ok: false, version: null, reason: 'version_timeout', rootSafeToDelete: true });
  assert.equal(child.killCalls, 1);
  assert.equal(cleanupOwnedRoot(parent, root), true);
});

test('fake child and real owned wait fixture distinguish control proof from stale-handle reconnect', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-reconnect-fixture-'));
  const executable = path.join(parent, 'claude.exe');
  fs.writeFileSync(executable, 'fixture');
  const harness = makeSpawnHarness();
  t.after(() => cleanupOwnedParent(parent));
  const result = await __testing.runFixtureProbe({
    rootParent: parent,
    executablePath: executable,
    oauthToken: 'fixture-oauth-secret',
    spawnImpl: harness.spawnImpl,
    driveFixtureStart: harness.driveStart,
    driveFixtureWait: harness.driveWait,
  });
  assert.equal(result.schemaVersion, 'claude-wait-reconnect-fixture-v1');
  assert.equal(result.mode, 'fixture');
  assert.equal(result.status, 'observed', JSON.stringify({ result, drivenStart: harness.drivenStart, drivenWait: harness.drivenWait, runnerCount: harness.runners.length }));
  assert.equal(result.version, '2.7.4');
  assert.equal(result.control.waitObserved, true);
  assert.equal(result.control.verifiedWaitCallbackCount, 1);
  assert.equal(result.control.waitCurrentBefore, true);
  assert.equal(result.control.settleAccepted, true);
  assert.equal(result.control.settleAttemptCount, 1);
  assert.equal(result.control.distinctContextObserved, true);
  assert.equal(result.control.proofCheckpointCompleted, true);
  assert.equal(result.control.freshCurrentProofAtCheckpoint, true);
  assert.equal(result.control.responseWriteObserved, null);
  assert.equal(result.control.stopConfirmed, true);
  assert.equal(result.control.rootRemoved, true);
  assert.equal(result.reconnect.collectorDisconnected, true);
  assert.equal(result.reconnect.collectorReconnectAttempted, true);
  assert.equal(result.reconnect.waitCurrentBefore, true);
  assert.equal(result.reconnect.invalidationNotificationObserved, false);
  assert.equal(result.reconnect.waitCurrentAfterReconnect, false);
  assert.equal(result.reconnect.verifiedWaitCallbackCount, 1);
  assert.equal(result.reconnect.settleAccepted, false);
  assert.equal(result.reconnect.settleAttemptCount, 1);
  assert.equal(result.reconnect.distinctContextObserved, false);
  assert.equal(result.reconnect.proofCheckpointCompleted, false);
  assert.equal(result.reconnect.freshCurrentProofAtCheckpoint, null);
  assert.equal(result.reconnect.responseWriteObserved, null);
  assert.equal(result.reconnect.stopConfirmed, true);
  assert.equal(result.reconnect.rootRemoved, true);
  assert.equal(harness.versions.length, 1);
  assert.equal(harness.runners.length, 2);
  assert.ok(harness.calls.every(call => call.options.shell === false && call.options.windowsHide === true));
  assert.equal(harness.calls[0].args.join(' '), '--version');
  assert.equal(Object.hasOwn(harness.calls[0].options.env, 'CLAUDE_CODE_OAUTH_TOKEN'), false);
  assert.equal(JSON.stringify(result).includes('fixture-oauth-secret'), false);
  assert.equal(JSON.stringify(result).includes('fixture-session'), false);
  assert.equal(JSON.stringify(result).includes(__testing.waitNonce), false);
  assert.deepEqual(fs.readdirSync(parent).sort(), ['claude.exe']);
});

test('a distinct context without a fresh current proof blocks reconnect', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-reconnect-proof-rejected-'));
  const executable = path.join(parent, 'claude.exe');
  fs.writeFileSync(executable, 'fixture');
  const harness = makeSpawnHarness({ terminalizeContextB: true });
  t.after(() => cleanupOwnedParent(parent));
  const result = await __testing.runFixtureProbe({
    rootParent: parent, executablePath: executable, oauthToken: 'fixture-oauth-secret',
    spawnImpl: harness.spawnImpl, driveFixtureStart: harness.driveStart, driveFixtureWait: harness.driveWait,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.control.status, 'unknown');
  assert.equal(result.control.distinctContextObserved, true);
  assert.equal(result.control.proofCheckpointCompleted, true);
  assert.equal(result.control.freshCurrentProofAtCheckpoint, false);
  assert.equal(result.control.responseWriteObserved, null);
  assert.equal(result.control.stopConfirmed, true);
  assert.equal(result.control.rootRemoved, true);
  assert.equal(result.reconnect, null);
  assert.equal(harness.runners.length, 1);
  assert.equal(JSON.stringify(result).includes('fixture-oauth-secret'), false);
  assert.deepEqual(fs.readdirSync(parent), ['claude.exe']);
});

test('the first distinct context stays latched when a later context has no fresh proof at checkpoint', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-reconnect-context-checkpoint-'));
  const executable = path.join(parent, 'claude.exe');
  fs.writeFileSync(executable, 'fixture');
  const harness = makeSpawnHarness({ contextCBeforeCheckpoint: true });
  t.after(() => cleanupOwnedParent(parent));
  const result = await __testing.runFixtureProbe({
    rootParent: parent, executablePath: executable, oauthToken: 'fixture-oauth-secret',
    spawnImpl: harness.spawnImpl, driveFixtureStart: harness.driveStart, driveFixtureWait: harness.driveWait,
  });
  assert.equal(result.control.status, 'unknown', JSON.stringify({ control: result.control, contextSequence: harness.runners[0]?.contextSequence }));
  assert.equal(result.status, 'unknown');
  assert.equal(result.control.reason, 'probe_wait_unavailable');
  assert.deepEqual(harness.runners[0].contextSequence, ['fixture-context-a', 'fixture-context-b', 'fixture-context-c']);
  assert.equal(result.control.distinctContextObserved, true);
  assert.equal(result.control.proofCheckpointCompleted, true);
  assert.equal(result.control.freshCurrentProofAtCheckpoint, false);
  assert.equal(result.reconnect, null);
  assert.equal(JSON.stringify(result).includes('fixture-context-b'), false);
  assert.equal(JSON.stringify(result).includes('fixture-context-c'), false);
});

test('a repeated native wait message makes the verified handle unusable before its single settlement', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-reconnect-duplicate-wait-'));
  const executable = path.join(parent, 'claude.exe');
  fs.writeFileSync(executable, 'fixture');
  const harness = makeSpawnHarness({ duplicateWaitAfterCapture: true });
  t.after(() => cleanupOwnedParent(parent));
  const result = await __testing.runFixtureProbe({
    rootParent: parent, executablePath: executable, oauthToken: 'fixture-oauth-secret',
    spawnImpl: harness.spawnImpl, driveFixtureStart: harness.driveStart, driveFixtureWait: harness.driveWait,
    driveFixtureAfterWait: harness.driveAfterWait,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.control.waitObserved, true);
  assert.equal(result.control.verifiedWaitCallbackCount, 1);
  assert.equal(result.control.invalidationNotificationObserved, false);
  assert.equal(result.control.waitCurrentBefore, false);
  assert.equal(result.control.settleAttempted, false);
  assert.equal(result.control.settleAccepted, null);
  assert.equal(result.control.settleAttemptCount, 0);
  assert.equal(result.control.responseWriteObserved, null);
  assert.equal(result.reconnect, null);
  assert.equal(harness.runners.length, 1);
  assert.equal(JSON.stringify(result).includes('fixture-oauth-secret'), false);
  assert.equal(JSON.stringify(result).includes(__testing.waitNonce), false);
  assert.deepEqual(fs.readdirSync(parent), ['claude.exe']);
});

test('a wait handle invalidated before reconnect prevents disconnect and settlement', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-reconnect-pre-stale-'));
  const executable = path.join(parent, 'claude.exe');
  fs.writeFileSync(executable, 'fixture');
  const harness = makeSpawnHarness({ duplicateWaitOnReconnect: true });
  t.after(() => cleanupOwnedParent(parent));
  const result = await __testing.runFixtureProbe({
    rootParent: parent, executablePath: executable, oauthToken: 'fixture-oauth-secret',
    spawnImpl: harness.spawnImpl, driveFixtureStart: harness.driveStart, driveFixtureWait: harness.driveWait,
    driveFixtureAfterWait: harness.driveAfterWait,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.control.status, 'observed');
  assert.equal(result.reconnect.status, 'unknown');
  assert.equal(result.reconnect.reason, 'probe_wait_stale');
  assert.equal(result.reconnect.waitObserved, true);
  assert.equal(result.reconnect.verifiedWaitCallbackCount, 1);
  assert.equal(result.reconnect.waitCurrentBefore, false);
  assert.equal(result.reconnect.collectorDisconnected, false);
  assert.equal(result.reconnect.collectorReconnectAttempted, false);
  assert.equal(result.reconnect.settleAttempted, false);
  assert.equal(result.reconnect.settleAttemptCount, 0);
  assert.equal(result.reconnect.stopConfirmed, true);
  assert.equal(result.reconnect.rootRemoved, true);
  assert.equal(harness.runners.length, 2);
  assert.deepEqual(fs.readdirSync(parent), ['claude.exe']);
});

test('control startup failure is sanitized and prevents reconnect', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-reconnect-control-failure-'));
  const executable = path.join(parent, 'claude.exe');
  fs.writeFileSync(executable, 'fixture');
  const harness = makeSpawnHarness();
  t.after(() => cleanupOwnedParent(parent));
  const result = await __testing.runFixtureProbe({
    rootParent: parent, executablePath: executable, oauthToken: 'fixture-oauth-secret',
    spawnImpl: harness.spawnImpl,
    driveFixtureStart: async () => { throw new Error('private-sentinel-message'); },
    driveFixtureWait: harness.driveWait,
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'probe_start_failed');
  assert.equal(result.control.status, 'unknown');
  assert.equal(result.control.stopConfirmed, true);
  assert.equal(result.control.rootRemoved, true);
  assert.equal(result.reconnect, null);
  assert.equal(harness.runners.length, 1);
  assert.equal(JSON.stringify(result).includes('private-sentinel-message'), false);
  assert.equal(JSON.stringify(result).includes('fixture-oauth-secret'), false);
  assert.deepEqual(fs.readdirSync(parent), ['claude.exe']);
});

test('exit-only and close-only termination preserve the owned root and block reconnect', async t => {
  for (const termination of ['exit-only', 'close-only']) {
    await t.test(termination, async tCase => {
      const parent = fs.mkdtempSync(path.join(os.tmpdir(), `wait-reconnect-${termination}-`));
      const executable = path.join(parent, 'claude.exe');
      fs.writeFileSync(executable, 'fixture');
      const harness = makeSpawnHarness({ runnerTermination: termination });
      tCase.after(() => cleanupOwnedParent(parent));
      const result = await __testing.runFixtureProbe({
        rootParent: parent, executablePath: executable, oauthToken: 'fixture-oauth-secret',
        spawnImpl: harness.spawnImpl,
        driveFixtureStart: async () => { throw new Error('private-stop-sentinel'); },
        driveFixtureWait: harness.driveWait,
        timeoutMs: 100,
      });
      const child = harness.runners[0];
      assert.equal(result.status, 'unknown');
      assert.equal(result.control.stopConfirmed, false);
      assert.equal(result.control.rootRemoved, false);
      assert.equal(result.control.reason, 'probe_stop_unconfirmed');
      assert.equal(result.reconnect, null);
      assert.equal(harness.runners.length, 1);
      assert.equal(child.exitObserved, termination === 'exit-only');
      assert.equal(child.closeObserved, termination === 'close-only');
      assert.equal(JSON.stringify(result).includes('private-stop-sentinel'), false);
      const caseRoot = path.resolve(path.dirname(harness.calls[1].options.cwd));
      const parentPath = path.resolve(parent);
      const relative = path.relative(parentPath, caseRoot);
      assert.ok(relative && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      assert.equal(fs.existsSync(caseRoot), true);
      assert.ok(fs.readdirSync(parent).includes(path.basename(caseRoot)));
      if (termination === 'exit-only') child.emit('close', 0, null);
      else child.emit('exit', 0, null);
      assert.equal(child.exitObserved, true);
      assert.equal(child.closeObserved, true);
      assert.equal(fs.existsSync(caseRoot), true);
    });
  }
});

test('version failure stops before any owned native runner starts', async t => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'wait-reconnect-gate-'));
  const executable = path.join(parent, 'claude.exe');
  fs.writeFileSync(executable, 'fixture');
  const runners = [];
  const child = createChild();
  t.after(() => cleanupOwnedParent(parent));
  const result = await __testing.runFixtureProbe({
    rootParent: parent, executablePath: executable, oauthToken: 'fixture-token', timeoutMs: 500,
    spawnImpl(exe, args) {
      if (args[0] !== '--version') { runners.push(args); throw new Error('must not start'); }
      setImmediate(() => {
        child.emit('spawn');
        child.stdout.emit('data', Buffer.alloc(__testing.versionOutputLimit + 1, 0x61));
      });
      return child;
    },
    driveFixtureStart: async () => assert.fail('control started after version failure'),
    driveFixtureWait: async () => assert.fail('wait started after version failure'),
  });
  assert.equal(result.status, 'unknown');
  assert.equal(result.reason, 'version_output_limit');
  assert.equal(result.control, null);
  assert.equal(runners.length, 0);
  assert.equal(child.killCalls, 1);
  assert.deepEqual(fs.readdirSync(parent).sort(), ['claude.exe']);
});
