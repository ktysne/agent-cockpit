'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { EventEmitter } = require('node:events');
const { sha256 } = require('../src/server/owned-native-instruction-dispatch');
const { createRegistrationKernel } = require('../src/server/conversation-registry');
const { createLaunchBindingKernel } = require('../src/server/launch-binding');
const { createRuntimeBindingKernel } = require('../src/server/runtime-binding');
const { createNativeLaunchComposition } = require('../src/server/native-launch-composition');
const { createOwnedNativeRunner } = require('../src/server/owned-native-runner');

async function fixture(t, { spawnFailure = false, discoveryBeforeInit = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-wait-'));
  const homePath = path.join(directory, 'home'), cwd = path.join(directory, 'cwd'), executablePath = path.join(directory, 'native.exe');
  fs.mkdirSync(homePath); fs.mkdirSync(cwd); fs.writeFileSync(executablePath, 'fixture');
  let contextEnds = 0;
  const actorHandles = [], waits = [], invalidations = [], writes = [], ends = [];
  let lastResponse = null;
  const originalEnd = Object.getOwnPropertyDescriptor(http.ServerResponse.prototype, 'end');
  const originalEndMethod = http.ServerResponse.prototype.end;
  const originalSetHeader = http.ServerResponse.prototype.setHeader;
  http.ServerResponse.prototype.end = function(...args) {
    try { const body = typeof args[0] === 'string' && JSON.parse(args[0]); if (body?.result?.content?.[0]?.type === 'text') ends.push(body.result); } catch {}
    return originalEndMethod.apply(this, args);
  };
  http.ServerResponse.prototype.setHeader = function(...args) { lastResponse = this; return originalSetHeader.apply(this, args); };
  t.after(() => { if (originalEnd) Object.defineProperty(http.ServerResponse.prototype, 'end', originalEnd); else delete http.ServerResponse.prototype.end; http.ServerResponse.prototype.setHeader = originalSetHeader; });
  const actualRegistration = createRegistrationKernel();
  let metadataCallback = null;
  const registrationKernel = { ...actualRegistration, registry: { ...actualRegistration.registry, snapshot() { metadataCallback?.(); return actualRegistration.registry.snapshot(); } } };
  const launchKernel = createLaunchBindingKernel({ registrationRegistry: registrationKernel.registry });
  const actualRuntime = createRuntimeBindingKernel({ registrationRegistry: registrationKernel.registry, launchRegistry: launchKernel.registry });
  const runtimeKernel = { ...actualRuntime, authority: { ...actualRuntime.authority, endContext(...args) { const ended = actualRuntime.authority.endContext(...args); if (ended) contextEnds += 1; return ended; }, attestActor(...args) { const result = actualRuntime.authority.attestActor(...args); actorHandles.push(result.actorHandle); return result; } } };
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.send = (...values) => child.stdout.emit('data', Buffer.from(values.map(JSON.stringify).join('\n') + '\n'));
  child.killCalls = 0;
  child.kill = () => { child.killCalls += 1; setImmediate(() => { child.emit('exit', 0); child.emit('close', 0); }); return true; };
  let environment, args, runner, collector, capability;
  child.stdin = Object.assign(new EventEmitter(), { write(line, callback) {
    writes.push(JSON.parse(line));
    if (writes[writes.length - 1].session_id) {
      child.send({ type: 'stream_event', session_id: 'native-id', parent_tool_use_id: null, event: { type: 'message_start', message: { role: 'assistant', id: 'context-c' } } });
      queueMicrotask(() => callback?.()); return true;
    }
    child.send({ type: 'system', subtype: 'init', session_id: 'native-id' },
      { type: 'stream_event', session_id: 'native-id', parent_tool_use_id: null, event: { type: 'message_start', message: { role: 'assistant', id: 'context-a' } } });
    queueMicrotask(() => callback?.()); return true;
  }, end() {} });
  const composition = createNativeLaunchComposition({ registrationKernel, launchKernel, runtimeKernel, hostId: 'fixture-host',
    profiles: { claude: { provider: 'claude', executablePath, homePath, cwd, homeScopeId: 'fixture-home', runnerProfile: 'cockpit-native-wait-v1' } },
    getAuthentication: () => ({ oauthToken: 'fixture-token' }),
    runnerFactory(options) {
      runner = createOwnedNativeRunner({ ...options, onSourceReady(cap) { capability = cap; options.onSourceReady(cap); }, onNative(event) { options.onNative(event); if (event.type === 'identity') collector.connect(); },
        spawnImpl(_exe, capturedArgs, config) { environment = { ...config.env }; args = capturedArgs; if (spawnFailure) throw new Error('fixture spawn failure'); setImmediate(() => child.emit('spawn')); return child; },
        timeouts: { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 100 } });
      return runner;
    },
  });
  const receipt = composition.admitLaunch({ launchId: 'launch', runId: 'run', attemptId: 'attempt', profileId: 'claude', origin: 'standalone', purpose: 'agent' });
  collector = composition.createOwnedCollector(receipt);
  const owner = composition.createWaitOwner(receipt);
  owner.subscribeVerifiedWait((handle, metadata) => waits.push({ handle, metadata }));
  owner.subscribeWaitInvalidated(handle => invalidations.push(handle));
  t.after(async () => { await composition.stop(receipt); fs.rmSync(directory, { recursive: true, force: true }); });
  if (spawnFailure) { await assert.rejects(composition.start(receipt, { inputText: 'fixture wait input' })); return { composition, receipt, runner }; }
  const started = await composition.start(receipt, { inputText: 'fixture wait input' });
  await collector.connect();
  const config = JSON.parse(args[args.indexOf('--mcp-config') + 1]);
  const url = new URL(config.mcpServers.cockpit_wait.url);
  function request(body, headers = {}, method = 'POST') {
    return new Promise((resolve, reject) => {
      const req = http.request(url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + environment.COCKPIT_NATIVE_MCP_SECRET, ...headers } }, response => {
        let text = ''; response.on('data', chunk => { text += chunk; }); response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: text ? JSON.parse(text) : null }));
      });
      req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('fixture HTTP timeout'))); req.end(JSON.stringify(body));
    });
  }
  if (discoveryBeforeInit) assert.equal((await request({ jsonrpc: '2.0', id: 'discovery', method: 'server/discover' })).status, 400);
  await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  await request({ jsonrpc: '2.0', method: 'notifications/initialized' });
  const stream = event => child.send({ type: 'stream_event', session_id: 'native-id', parent_tool_use_id: null, event });
  const full = (nonce, context = 'context-a', toolId = 'native-tool') => child.send({ type: 'assistant', session_id: 'native-id', parent_tool_use_id: null,
    message: { role: 'assistant', id: context, content: [{ type: 'tool_use', id: toolId, name: 'mcp__cockpit_wait__cockpit_wait', input: { nonce } }] } });
  async function until(predicate) { const deadline = Date.now() + 1000; while (!predicate()) { if (Date.now() >= deadline) throw new Error('fixture event timeout'); await new Promise(resolve => setImmediate(resolve)); } }
  return { child, composition, receipt, owner, collector, started, waits, invalidations, actorHandles, actualRuntime, actualRegistration, launchKernel, runtimeKernel,
    request, stream, full, until, writes, ends, contextEnds: () => contextEnds, environment, args, runner, capability: () => capability, response: () => lastResponse, onMetadata(callback) { metadataCallback = callback; },
    call(nonce, id = 2) { return request({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'cockpit_wait', arguments: { nonce } } }); } };
}

for (const order of ['native-first', 'mcp-first']) test('CW01 actual Claude runner and kernels match ' + order + ' once', async t => {
  const f = await fixture(t), nonce = 'a'.repeat(48);
  const oldProof = f.composition.resolveProof(f.started.launchRef);
  assert.ok(oldProof);
  const beforeBinding = f.launchKernel.registry.get(f.started.launchRef).executionBinding;
  let pending;
  if (order === 'native-first') { f.full(nonce); pending = f.call(nonce); } else { pending = f.call(nonce); await new Promise(resolve => setImmediate(resolve)); f.full(nonce); }
  await f.until(() => f.waits.length === 1);
  const wait = f.waits[0];
  assert.deepEqual(Object.keys(wait.metadata).sort(), ['inputDigest', 'nativeContextId', 'nativeToolUseId', 'source', 'target'].sort());
  assert.equal(f.owner.checkWait(wait.handle), true);
  assert.equal(f.owner.checkWait(JSON.parse(JSON.stringify(wait.handle))), false);
  assert.equal(f.owner.settleWait(wait.handle, 'released'), true);
  assert.equal(f.owner.settleWait(wait.handle, 'released'), false);
  const result = await pending;
  assert.deepEqual(result.body.result, { content: [{ type: 'text', text: 'released' }], isError: false });
  f.child.send({ type: 'user', session_id: 'native-id', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native-tool', content: [{ type: 'text', text: 'released' }] }] } });
  f.stream({ type: 'message_start', message: { role: 'assistant', id: 'context-b' } });
  const newProof = f.composition.resolveProof(f.started.launchRef);
  assert.ok(newProof); assert.notEqual(newProof, oldProof);
  const afterBinding = f.launchKernel.registry.get(f.started.launchRef).executionBinding;
  assert.deepEqual(afterBinding.actor, beforeBinding.actor); assert.equal(afterBinding.periodId, beforeBinding.periodId);
  assert.equal(f.actualRuntime.registry.checkCurrentProof(f.started.launchRef, oldProof).ok, false);
  assert.equal(f.composition.checkCurrentProof(f.started.launchRef, newProof).ok, true);
  const registration = f.actualRegistration.registry.snapshot();
  assert.equal(registration.executions.length, 1);
  assert.equal(registration.executions[0].state, 'active');
  assert.equal(f.owner.checkWait(wait.handle), false);
  assert.equal(f.writes.length, 1);
  await f.composition.stop(f.receipt);
  assert.equal(f.runner.snapshot().waitEndpointActive, false);
  assert.equal(f.runner.snapshot().childClosed, true);
});

test('CW02 unauthenticated rejection leaves actual owned proof current', async t => {
  const f = await fixture(t), proof = f.composition.resolveProof(f.started.launchRef);
  const rejected = await f.request({}, { Authorization: 'Bearer wrong' });
  assert.equal(rejected.status, 401);
  assert.equal(f.composition.resolveProof(f.started.launchRef), proof);
  assert.equal(f.child.killCalls, 0);
  assert.equal(f.invalidations.length, 0);
  assert.equal(f.args.includes('--allowedTools'), true);
  assert.equal(f.environment.MCP_TOOL_TIMEOUT, '420000');
});

test('CW04 raw context invalidation during last metadata callback prevents HTTP success', async t => {
  const f = await fixture(t), nonce = 'b'.repeat(48); f.full(nonce);
  const pending = f.call(nonce).catch(() => null);
  await f.until(() => f.waits.length === 1);
  let once = false;
  f.onMetadata(() => { if (!once) { once = true; f.actualRuntime.authority.endContext(f.actorHandles[0]); } });
  assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), false);
  assert.equal(await pending, null);
  assert.equal(f.ends.length, 0);
  assert.equal(f.composition.resolveProof(f.started.launchRef), null);
  assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), false);
});

function instructionPair(f, deliveryId = 'instruction') {
  const launch = f.launchKernel.registry.get(f.started.launchRef);
  const claims = Object.fromEntries(['launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'origin', 'purpose', 'originBinding'].map(key => [key, launch[key]]));
  const execution = f.actualRegistration.registry.snapshot().executions[0];
  const source = { launchRef: f.started.launchRef, claims, identity: launch.identity, executionBinding: launch.executionBinding, conversationId: execution.conversationId, sessionId: execution.sessionId };
  const target = { kind: 'execution', launchRef: source.launchRef, claims, identity: source.identity, periodId: source.executionBinding.periodId,
    actor: source.executionBinding.actor, conversationId: source.conversationId, sessionId: source.sessionId };
  const input = [{ type: 'text', text: 'fixture next input', text_elements: [] }];
  const metadata = { deliveryAttemptId: deliveryId, revision: 1, payloadDigest: sha256(JSON.stringify({ schemaVersion: 1, mode: 'start', expectedTurnId: null, input })),
    nativeContentDigest: sha256(JSON.stringify(input)), source, target, mode: 'start', expectedTurnId: null };
  return { metadata, command: { ...metadata, input } };
}
function matchingResult(f, status = 'released', tool = 'native-tool') {
  f.child.send({ type: 'user', session_id: 'native-id', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: tool,
    content: [{ type: 'text', text: status }], ...(status === 'released' ? {} : { is_error: true }) }] } });
}

test('CW01 notification reentry cannot settle before all listeners finish', async t => {
  const f = await fixture(t), nonce = 'c'.repeat(48); let inside;
  f.owner.subscribeVerifiedWait(handle => { inside = f.owner.settleWait(handle, 'released'); });
  f.full(nonce); const pending = f.call(nonce); await f.until(() => f.waits.length === 1);
  assert.equal(inside, false); assert.equal(f.ends.length, 0);
  assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), true); await pending;
  assert.equal(f.ends.length, 1);
});

test('CW01 partial/full reuse is scoped to assistant message and block index', async t => {
  const f = await fixture(t), nonce = 'd'.repeat(48);
  f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'native-tool', name: 'mcp__cockpit_wait__cockpit_wait', input: {} } });
  f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ nonce }) } });
  f.stream({ type: 'content_block_stop', index: 0 }); f.full(nonce);
  const pending = f.call(nonce); await f.until(() => f.waits.length === 1);
  assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), true); await pending;
  matchingResult(f); f.stream({ type: 'message_start', message: { role: 'assistant', id: 'context-b' } });
  f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
  f.stream({ type: 'content_block_stop', index: 0 });
  assert.ok(f.composition.resolveProof(f.started.launchRef)); assert.equal(f.child.killCalls, 0); assert.equal(f.ends.length, 1);
});

for (const conflict of ['full-duplicate', 'different-tool-same-context', 'partial-conflict']) test('CW03 rejects ' + conflict + ' before a successful response', async t => {
  const f = await fixture(t), nonce = 'e'.repeat(48);
  if (conflict === 'partial-conflict') {
    f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'wrong-tool', name: 'mcp__cockpit_wait__cockpit_wait', input: {} } });
  }
  f.full(nonce);
  if (conflict === 'full-duplicate') f.full(nonce);
  if (conflict === 'different-tool-same-context') f.full('f'.repeat(48), 'context-a', 'second-tool');
  await f.until(() => f.child.killCalls > 0);
  assert.equal(f.waits.length, 0); assert.equal(f.ends.length, 0);
  assert.equal(f.composition.resolveProof(f.started.launchRef), null);
  assert.equal(f.actualRegistration.registry.snapshot().executions[0].state, 'active');
});

test('CW04 synchronous response destruction inside metadata callback prevents end invocation', async t => {
  const f = await fixture(t), nonce = 'f'.repeat(48); f.full(nonce);
  const pending = f.call(nonce).catch(() => null); await f.until(() => f.waits.length === 1);
  let once = false; f.onMetadata(() => { if (!once) { once = true; f.response().destroy(); } });
  assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), false); await pending;
  assert.equal(f.ends.length, 0);
});

test('CW04 end getter invalidation happens before final canonical/private guard', async t => {
  const f = await fixture(t), nonce = '1'.repeat(48); f.full(nonce);
  const pending = f.call(nonce).catch(() => null); await f.until(() => f.waits.length === 1);
  const descriptor = Object.getOwnPropertyDescriptor(http.ServerResponse.prototype, 'end');
  Object.defineProperty(http.ServerResponse.prototype, 'end', { configurable: true, get() {
    f.actualRuntime.authority.endContext(f.actorHandles[0]); return descriptor.value;
  } });
  assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), false);
  Object.defineProperty(http.ServerResponse.prototype, 'end', descriptor);
  await pending; assert.equal(f.ends.length, 0);
});

for (const mistake of ['before-result', 'wrong-result', 'wrong-tool']) test('CW06 ' + mistake + ' cannot advance B context', async t => {
  const f = await fixture(t), nonce = '2'.repeat(48); f.full(nonce);
  const pending = f.call(nonce); await f.until(() => f.waits.length === 1);
  assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), true); await pending;
  if (mistake === 'wrong-result') matchingResult(f, 'cancelled');
  if (mistake === 'wrong-tool') matchingResult(f, 'released', 'foreign-tool');
  f.stream({ type: 'message_start', message: { role: 'assistant', id: 'context-b' } });
  assert.equal(f.composition.resolveProof(f.started.launchRef), null);
  assert.equal(f.actorHandles.length, 1); assert.equal(f.ends.length, 1);
});

test('CW07 intermediate A completion never admits a standalone input before session result', async t => {
  const f = await fixture(t), nonce = '3'.repeat(48); f.full(nonce);
  const pending = f.call(nonce); await f.until(() => f.waits.length === 1);
  assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), true); await pending;
  const instruction = f.composition.createInstructionOwner(f.receipt), pair = instructionPair(f);
  let duringTransition;
  f.onMetadata(() => { if (f.contextEnds() > 0) duringTransition = instruction.prepareInstructionDispatch(pair.metadata); });
  matchingResult(f); f.stream({ type: 'message_start', message: { role: 'assistant', id: 'context-b' } });
  f.onMetadata(null);
  assert.equal(duringTransition, null);
  assert.equal(instruction.prepareInstructionDispatch(pair.metadata), null);
  assert.equal(instruction.checkInstructionDispatch(Object.freeze({}), pair.metadata), false);
  assert.throws(() => instruction.dispatchInstructionNow(Object.freeze({}), pair.command));
  assert.equal(f.writes.length, 1);
  f.child.send({ type: 'result', session_id: 'native-id', uuid: '11111111-1111-4111-8111-111111111111' });
  const token = instruction.prepareInstructionDispatch(pair.metadata); assert.ok(token);
  const ack = await instruction.dispatchInstructionNow(token, pair.command);
  assert.deepEqual(ack, { clientRequestId: 'instruction', nativeTurnId: 'context-c', nativeItemId: null }); assert.equal(f.writes.length, 2);
  assert.ok(f.composition.resolveProof(f.started.launchRef));
});

for (const status of ['cancelled']) test('CW01 fixed cancellation sends once and permits only its matching native result', async t => {
  const f = await fixture(t), nonce = '4'.repeat(48); f.full(nonce);
  const pending = f.call(nonce); await f.until(() => f.waits.length === 1);
  assert.equal(f.owner.settleWait(f.waits[0].handle, status), true); assert.equal(f.owner.settleWait(f.waits[0].handle, status), false);
  assert.deepEqual((await pending).body.result, { content: [{ type: 'text', text: status }], isError: true });
  matchingResult(f, status); f.stream({ type: 'message_start', message: { role: 'assistant', id: 'context-b' } });
  assert.equal(f.contextEnds(), 1); assert.equal(f.actorHandles.length, 2); assert.ok(f.composition.resolveProof(f.started.launchRef));
});

for (const headers of [{ Origin: 'http://foreign.example' }, { Host: 'foreign.example' }]) test('CW02 browser scope rejection never revokes the owned source', async t => {
  const f = await fixture(t), proof = f.composition.resolveProof(f.started.launchRef);
  assert.equal((await f.request({}, headers)).status, 403);
  assert.equal(f.composition.resolveProof(f.started.launchRef), proof); assert.equal(f.invalidations.length, 0); assert.equal(f.child.killCalls, 0);
});

test('CW05 response end throw cannot create a continuation or retry', async t => {
  const f = await fixture(t), nonce = '5'.repeat(48); f.full(nonce);
  const pending = f.call(nonce).catch(() => null); await f.until(() => f.waits.length === 1);
  const original = http.ServerResponse.prototype.end; let attempts = 0;
  http.ServerResponse.prototype.end = function(line) { if (typeof line === 'string' && line.includes('"content"')) { attempts += 1; throw new Error('fixture write failed'); } return original.call(this, line); };
  try { assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), false); }
  finally { http.ServerResponse.prototype.end = original; }
  await pending; matchingResult(f); f.stream({ type: 'message_start', message: { role: 'assistant', id: 'context-b' } });
  assert.equal(attempts, 1); assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), false);
  assert.equal(f.actorHandles.length, 1); assert.equal(f.composition.resolveProof(f.started.launchRef), null);
});

for (const invalidation of ['detach', 'period', 'actor']) test('CW08 ' + invalidation + ' rejects captured wait without a response write', async t => {
  const f = await fixture(t), nonce = '6'.repeat(48); f.full(nonce);
  const pending = f.call(nonce).catch(() => null); await f.until(() => f.waits.length === 1);
  if (invalidation === 'detach') f.collector.disconnect();
  if (invalidation === 'actor') f.actualRuntime.authority.endActor(f.actorHandles[0]);
  if (invalidation === 'period') {
    const execution = f.actualRegistration.registry.snapshot().executions[0];
    f.actualRegistration.authority.end(execution.executionId);
  }
  assert.equal(f.owner.checkWait(f.waits[0].handle), false); assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), false);
  await pending; assert.equal(f.ends.length, 0);
});

async function controlledWait(t, f, { stopBeforeReady = false } = {}) {
  const { createRequire } = require('node:module');
  const filename = require.resolve('../src/server/owned-native-mcp-wait');
  const localRequire = createRequire(filename), latch = localRequire('./owned-native-wait');
  let now = 0, sequence = 0; const jobs = new Map();
  const schedule = (callback, milliseconds) => { const id = ++sequence; jobs.set(id, { callback, at: now + milliseconds }); return id; };
  const cancel = id => jobs.delete(id);
  const isolated = { exports: {} };
  new Function('require', 'module', 'exports', 'setTimeout', 'clearTimeout', fs.readFileSync(filename, 'utf8'))(name => name === './owned-native-wait' ? {
    createOwnedNativeWaitLatch: options => latch.createOwnedNativeWaitLatch({ ...options, now: () => now, schedule, unschedule: cancel }),
  } : localRequire(name), isolated, isolated.exports, schedule, cancel);
  const proof = f.composition.resolveProof(f.started.launchRef), handles = [];
  let registrationStamp, launchStamp;
  const checkFinal = () => f.actualRegistration.registry.checkAuthorityRevision(registrationStamp) && f.launchKernel.registry.checkAuthorityRevision(launchStamp) &&
    f.actualRuntime.registry.checkProofCapability(f.started.launchRef, proof) === true;
  const wait = isolated.exports.createOwnedNativeMcpWait(f.capability(), { capture() {
    return { metadata: {}, checkCurrent() {
      registrationStamp = f.actualRegistration.registry.captureAuthorityRevision(); launchStamp = f.launchKernel.registry.captureAuthorityRevision();
      return f.composition.resolveProof(f.started.launchRef) === proof && checkFinal();
    }, checkFinal };
  }, onInvalidated() {} });
  wait.facade.subscribe(handle => handles.push(handle));
  t.after(() => wait.controller.stop());
  const startup = wait.controller.start();
  if (stopBeforeReady) { const stopping = wait.controller.stop(); await assert.rejects(startup, /unavailable/); await stopping; return { wait, stopping }; }
  const config = await startup, url = new URL(JSON.parse(config.mcpConfig).mcpServers.cockpit_wait.url);
  const request = body => new Promise((resolve, reject) => {
    const req = http.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.secret } }, response => {
      let text = ''; response.on('data', chunk => text += chunk); response.on('end', () => resolve(text ? JSON.parse(text) : { status: response.statusCode }));
    }); req.on('error', reject); req.setTimeout(2000, () => req.destroy(new Error('fixture timeout'))); req.end(JSON.stringify(body));
  });
  await request({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } });
  return { wait, handles, request, advance(milliseconds) { now += milliseconds; for (;;) { const next = [...jobs].find(([, job]) => job.at <= now); if (!next) break; jobs.delete(next[0]); next[1].callback(); } } };
}

for (const revoked of [false, true]) test('CW04 actual monotonic latch deadline with revoked=' + revoked + ' gates synchronous HTTP end', async t => {
  const f = await fixture(t), c = await controlledWait(t, f), nonce = '7'.repeat(48);
  c.wait.controller.observeNative({ sessionId: 'native-id', nativeContextId: 'context-a', nativeToolUseId: 'clock-tool', inputEpoch: 1, input: { nonce } });
  const pending = c.request({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cockpit_wait', arguments: { nonce } } }).catch(() => null);
  await f.until(() => c.handles.length === 1);
  c.advance(299999); assert.equal(f.ends.length, 0);
  if (revoked) f.actualRuntime.authority.endContext(f.actorHandles[0]);
  c.advance(1);
  const result = await pending;
  if (revoked) { assert.equal(result, null); assert.equal(f.ends.length, 0); assert.equal(c.wait.controller.inspectSent(c.handles[0]), null); }
  else { assert.deepEqual(result.result, { content: [{ type: 'text', text: 'deadline' }], isError: true }); assert.equal(f.ends.length, 1); }
});

test('CW09 bounded native candidates reject the seventeenth unmatched call', async t => {
  const f = await fixture(t), c = await controlledWait(t, f);
  for (let i = 0; i < 16; i++) assert.equal(c.wait.controller.observeNative({ sessionId: 'native-id', nativeContextId: 'context-a', nativeToolUseId: 'tool-' + i, inputEpoch: 1, input: { nonce: i.toString(16).padStart(48, '0') } }), true);
  assert.equal(c.wait.controller.observeNative({ sessionId: 'native-id', nativeContextId: 'context-a', nativeToolUseId: 'tool-16', inputEpoch: 1, input: { nonce: 'f'.repeat(48) } }), false);
  assert.equal(c.handles.length, 0); assert.equal(f.ends.length, 0);
});

test('CW03 completed contradictory partial input blocks full native authority', async t => {
  const f = await fixture(t), nonce = '8'.repeat(48);
  f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'native-tool', name: 'mcp__cockpit_wait__cockpit_wait', input: {} } });
  f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ nonce: '9'.repeat(48) }) } });
  f.stream({ type: 'content_block_stop', index: 0 }); f.full(nonce);
  assert.equal(f.waits.length, 0); assert.equal(f.ends.length, 0); assert.equal(f.composition.resolveProof(f.started.launchRef), null);
});

test('CW01 unfinished partial is never authority and a full native call remains authoritative', async t => {
  const f = await fixture(t), nonce = 'a'.repeat(48);
  f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'native-tool', name: 'mcp__cockpit_wait__cockpit_wait', input: {} } });
  f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"nonce":' } });
  assert.equal(f.waits.length, 0); assert.equal(f.ends.length, 0);
  f.full(nonce); const pending = f.call(nonce); await f.until(() => f.waits.length === 1);
  assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), true); await pending; assert.equal(f.ends.length, 1);
});

test('CW08 old sent wait cannot continue after logical detach and a new lease', async t => {
  const f = await fixture(t), nonce = 'b'.repeat(48); f.full(nonce);
  const pending = f.call(nonce); await f.until(() => f.waits.length === 1);
  assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), true); await pending;
  f.collector.disconnect(); await f.collector.connect();
  matchingResult(f); f.stream({ type: 'message_start', message: { role: 'assistant', id: 'context-b' } });
  assert.equal(f.owner.checkWait(f.waits[0].handle), false); assert.equal(f.actorHandles.length, 1);
  assert.equal(f.composition.resolveProof(f.started.launchRef), null); assert.equal(f.ends.length, 1);
});

test('CW06 external terminal during continuation metadata callback prevents B attestation', async t => {
  const f = await fixture(t), nonce = 'c'.repeat(48); f.full(nonce);
  const pending = f.call(nonce); await f.until(() => f.waits.length === 1);
  assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), true); await pending;
  let injected = false;
  f.onMetadata(() => { if (!injected && f.contextEnds() > 0) { injected = true; f.child.send({ type: 'result', session_id: 'native-id', uuid: '22222222-2222-4222-8222-222222222222' }); } });
  matchingResult(f); f.stream({ type: 'message_start', message: { role: 'assistant', id: 'context-b' } }); f.onMetadata(null);
  assert.equal(injected, true); assert.equal(f.actorHandles.length, 1); assert.equal(f.composition.resolveProof(f.started.launchRef), null);
  assert.equal(f.contextEnds(), 1); assert.equal(f.actualRegistration.registry.snapshot().executions[0].state, 'active');
});

test('CW09 source-lifetime 128 waits retain 129 ended-context capacity without eviction', async t => {
  const f = await fixture(t), binding = f.launchKernel.registry.get(f.started.launchRef).executionBinding;
  let context = 'context-a';
  for (let i = 0; i < 128; i++) {
    const nonce = i.toString(16).padStart(48, '0'), tool = 'chain-tool-' + i;
    f.full(nonce, context, tool); const pending = f.call(nonce, i + 2); await f.until(() => f.waits.length === i + 1);
    const handle = f.waits[i].handle, oldProof = f.composition.resolveProof(f.started.launchRef);
    assert.equal(f.owner.settleWait(handle, 'released'), true); await pending;
    matchingResult(f, 'released', tool); context = 'chain-' + i;
    f.stream({ type: 'message_start', message: { role: 'assistant', id: context } });
    assert.ok(f.composition.resolveProof(f.started.launchRef)); assert.equal(f.actualRuntime.registry.checkCurrentProof(f.started.launchRef, oldProof).ok, false);
  }
  assert.equal(f.contextEnds(), 128); assert.equal(f.actorHandles.length, 129); assert.equal(f.ends.length, 128); assert.equal(f.child.killCalls, 0);
  f.child.send({ type: 'result', session_id: 'native-id', uuid: '33333333-3333-4333-8333-333333333333' });
  assert.equal(f.contextEnds(), 129);
  const instruction = f.composition.createInstructionOwner(f.receipt), pair = instructionPair(f, 'capacity-next');
  assert.equal(instruction.prepareInstructionDispatch(pair.metadata), null); assert.equal(f.writes.length, 1);
  const after = f.launchKernel.registry.get(f.started.launchRef).executionBinding;
  assert.deepEqual(after.actor, binding.actor); assert.equal(after.periodId, binding.periodId);
});

test('CW09 partial/body logical UTF8 reservation is shared and release is idempotent', async t => {
  const f = await fixture(t), c = await controlledWait(t, f);
  assert.equal(c.wait.controller.reservePartial(256 * 1024), true);
  c.wait.controller.clearPartial(); c.wait.controller.clearPartial();
  assert.equal(c.wait.controller.reservePartial(256 * 1024), true);
  assert.equal(c.wait.controller.reservePartial(1), false); assert.equal(c.handles.length, 0); assert.equal(f.ends.length, 0);
});

test('CW09 retained partial plus authenticated HTTP body exceeds the shared logical cap', async t => {
  const f = await fixture(t), c = await controlledWait(t, f);
  assert.equal(c.wait.controller.reservePartial(256 * 1024 - 100), true);
  const response = await c.request({ jsonrpc: '2.0', id: 2, method: 'ping', padding: 'x'.repeat(1000) }).catch(() => null);
  assert.equal(response.status, 413); assert.equal(c.wait.controller.reservePartial(1), false); assert.equal(f.ends.length, 0);
});

test('CW09 composition accepts the wait profile only for Claude', async t => {
  const f = await fixture(t);
  assert.throws(() => createNativeLaunchComposition({ registrationKernel: f.actualRegistration, launchKernel: f.launchKernel, runtimeKernel: f.actualRuntime,
    hostId: 'fixture-host', profiles: { codex: { provider: 'codex', executablePath: process.execPath, homePath: os.tmpdir(), cwd: process.cwd(), homeScopeId: 'fixture-home', runnerProfile: 'cockpit-native-wait-v1' } },
    getAuthentication: () => ({ oauthToken: 'fixture-token' }), runnerFactory: createOwnedNativeRunner }), /profile/);
  assert.equal(f.child.killCalls, 0);
});

test('CW05 authenticated pending response close after send-start invalidates continuation', async t => {
  const f = await fixture(t), nonce = 'd'.repeat(48); f.full(nonce);
  const pending = f.call(nonce).catch(() => null); await f.until(() => f.waits.length === 1);
  const original = http.ServerResponse.prototype.end; let starts = 0;
  http.ServerResponse.prototype.end = function(line) {
    if (typeof line === 'string' && line.includes('"content"')) { starts += 1; this.emit('close'); return this; }
    return original.call(this, line);
  };
  try { assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), false); }
  finally { http.ServerResponse.prototype.end = original; }
  await pending; matchingResult(f); f.stream({ type: 'message_start', message: { role: 'assistant', id: 'context-b' } });
  assert.equal(starts, 1); assert.equal(f.actorHandles.length, 1); assert.equal(f.composition.resolveProof(f.started.launchRef), null);
  assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), false);
});

test('CW03 a second authenticated initialize cannot reconnect or retain proof', async t => {
  const f = await fixture(t);
  assert.equal((await f.request({ jsonrpc: '2.0', id: 10, method: 'initialize', params: { protocolVersion: '2025-11-25' } })).status, 400);
  assert.equal(f.composition.resolveProof(f.started.launchRef), null); assert.equal(f.waits.length, 0); assert.equal(f.ends.length, 0);
  assert.equal(f.actualRegistration.registry.snapshot().executions[0].state, 'active');
});


test('CW01 a subsequent instruction input establishes partial/full wait stream scope before context emission', async t => {
  const f = await fixture(t);
  f.child.send({ type: 'result', session_id: 'native-id', uuid: '44444444-4444-4444-8444-444444444444' });
  const owner = f.composition.createInstructionOwner(f.receipt), pair = instructionPair(f, 'second-input');
  const token = owner.prepareInstructionDispatch(pair.metadata); assert.ok(token);
  const ack = await owner.dispatchInstructionNow(token, pair.command); assert.equal(ack.nativeTurnId, 'context-c');
  const nonce = 'e'.repeat(48);
  f.stream({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'second-tool', name: 'mcp__cockpit_wait__cockpit_wait', input: {} } });
  f.stream({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify({ nonce }) } });
  f.stream({ type: 'content_block_stop', index: 0 }); f.full(nonce, 'context-c', 'second-tool');
  const pending = f.call(nonce); await f.until(() => f.waits.length === 1);
  assert.equal(f.waits[0].metadata.nativeContextId, 'context-c'); assert.equal(f.child.killCalls, 0);
  assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), true); await pending;
  matchingResult(f, 'released', 'second-tool'); f.stream({ type: 'message_start', message: { role: 'assistant', id: 'context-d' } });
  assert.ok(f.composition.resolveProof(f.started.launchRef)); assert.equal(f.ends.length, 1); assert.equal(f.writes.length, 2);
});

test('CW09 spawn failure closes the dedicated endpoint before explicit composition stop', async t => {
  const f = await fixture(t, { spawnFailure: true });
  const deadline = Date.now() + 1000;
  while (f.runner.snapshot().waitEndpointActive) { assert.ok(Date.now() < deadline); await new Promise(resolve => setImmediate(resolve)); }
  assert.equal(f.runner.snapshot().state, 'stop_unconfirmed');
});

test('CW09 natural child exit closes the dedicated endpoint before explicit composition stop', async t => {
  const f = await fixture(t); assert.equal(f.runner.snapshot().waitEndpointActive, true);
  f.child.emit('exit', 0); f.child.emit('close', 0);
  await f.until(() => f.runner.snapshot().waitEndpointActive === false);
  assert.equal(f.runner.snapshot().childExited, true); assert.equal(f.runner.snapshot().childClosed, true);
  assert.equal(f.child.killCalls, 0); assert.equal(f.composition.resolveProof(f.started.launchRef), null);
});

for (const kind of ['success', 'auth', 'origin']) test('CW02 dedicated MCP ' + kind + ' responses carry the fixed browser protections', async t => {
  const f = await fixture(t);
  const response = await f.request({ jsonrpc: '2.0', id: 9, method: 'tools/list' }, kind === 'auth' ? { Authorization: 'Bearer wrong' } : kind === 'origin' ? { Origin: 'http://foreign.example' } : {});
  assert.equal(response.status, kind === 'success' ? 200 : kind === 'auth' ? 401 : 403);
  for (const [key, value] of Object.entries({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-frame-options': 'DENY', 'content-security-policy': "frame-ancestors 'none'", 'cross-origin-resource-policy': 'same-origin', 'cross-origin-opener-policy': 'same-origin' })) assert.equal(response.headers[key], value);
});


test('CW09 reentrant and duplicate endpoint stop share the same close completion Promise', async t => {
  const f = await fixture(t), c = await controlledWait(t, f);
  const originalClose = http.Server.prototype.close;
  let completeClose = null, nested = null, resolved = false;
  http.Server.prototype.close = function(callback) { return originalClose.call(this, () => { completeClose = callback; }); };
  t.after(() => { http.Server.prototype.close = originalClose; completeClose?.(); });
  c.wait.facade.subscribeInvalidated(() => { nested = c.wait.controller.stop(); });
  let first;
  try {
    first = c.wait.controller.stop(); const second = c.wait.controller.stop();
    assert.equal(first, second); assert.equal(first, nested); first.then(() => { resolved = true; });
    await f.until(() => completeClose !== null); assert.equal(resolved, false);
  } finally { http.Server.prototype.close = originalClose; completeClose?.(); }
  await first;
  assert.equal(resolved, true); assert.equal(c.wait.controller.isListening(), false);
});


test('CW09 stop before the listen callback completes cannot leave a late owned endpoint', { timeout: 2000 }, async t => {
  const f = await fixture(t), c = await controlledWait(t, f, { stopBeforeReady: true });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(c.wait.controller.isListening(), false);
  assert.equal(c.wait.controller.stop(), c.stopping); await c.wait.controller.stop();
});

test('CW01 authenticated discovery fallback preserves initialization and current proof', async t => {
  const f = await fixture(t, { discoveryBeforeInit: true });
  assert.ok(f.composition.resolveProof(f.started.launchRef));
  assert.equal(f.waits.length, 0);
  assert.equal(f.child.killCalls, 0);
});
for (const caller of [{ type: 'direct' }, { type: 'code_execution' }, { type: 'direct', extra: true }]) {
  test('CW02 caller shape ' + JSON.stringify(caller) + ' preserves only direct authority', async t => {
    const f = await fixture(t), nonce = 'd'.repeat(48);
    f.child.send({ type: 'assistant', session_id: 'native-id', parent_tool_use_id: null,
      message: { role: 'assistant', id: 'context-a', content: [{ type: 'tool_use', id: 'direct-tool',
        name: 'mcp__cockpit_wait__cockpit_wait', input: { nonce }, caller }] } });
    if (caller.type === 'direct' && !Object.hasOwn(caller, 'extra')) {
      const pending = f.call(nonce);
      await f.until(() => f.waits.length === 1);
      assert.equal(f.owner.checkWait(f.waits[0].handle), true);
      assert.equal(f.owner.settleWait(f.waits[0].handle, 'released'), true);
      await pending;
    } else {
      assert.equal(f.composition.resolveProof(f.started.launchRef), null);
      assert.equal(f.waits.length, 0);
    }
  });
}
for (const [content, isError, expected] of [['cancelled', true, true], ['released', true, false], ['cancelled', false, false]]) {
  test('CW01 string cancellation result ' + content + '/' + isError + ' requires exact sent status and error flag', async t => {
    const f = await fixture(t), nonce = 'e'.repeat(48); f.full(nonce);
    const pending = f.call(nonce); await f.until(() => f.waits.length === 1);
    assert.equal(f.owner.settleWait(f.waits[0].handle, 'cancelled'), true); await pending;
    f.child.send({ type: 'user', session_id: 'native-id', parent_tool_use_id: null,
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'native-tool', content, is_error: isError }] } });
    f.stream({ type: 'message_start', message: { role: 'assistant', id: 'context-b' } });
    assert.equal(Boolean(f.composition.resolveProof(f.started.launchRef)), expected);
    assert.equal(f.actorHandles.length, expected ? 2 : 1);
  });
}
