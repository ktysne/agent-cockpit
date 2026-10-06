'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createRegistrationKernel } = require('../src/server/conversation-registry');
const { createLaunchBindingKernel } = require('../src/server/launch-binding');
const { createRuntimeBindingKernel } = require('../src/server/runtime-binding');
const { createNativeLaunchComposition } = require('../src/server/native-launch-composition');
const { createOwnedNativeRunner } = require('../src/server/owned-native-runner');
const { createManagedCollector } = require('../src/server/managed-collector');
const { createDurableDeliveryStore, createProviderDeliveryAdapter } = require('../src/server/durable-delivery-store');
const { sha256 } = require('../src/server/owned-native-instruction-dispatch');
const { getOwnedInstructionWriter } = require('../src/server/owned-native-instruction-writer');

function fixture(t, provider, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'owned-collector-'));
  const homePath = path.join(directory, 'home');
  const cwd = path.join(directory, 'workspace');
  const executablePath = path.join(directory, 'native.exe');
  fs.mkdirSync(homePath); fs.mkdirSync(cwd); fs.writeFileSync(executablePath, 'fixture');
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  let onKernelRead = null;
  const actorHandles = []; const connectionHandles = [];
  const actualRegistration = createRegistrationKernel();
  const registrationKernel = { ...actualRegistration, registry: { ...actualRegistration.registry, snapshot() { if (onKernelRead) onKernelRead(); return actualRegistration.registry.snapshot(); } } };
  const launchKernel = createLaunchBindingKernel({ registrationRegistry: registrationKernel.registry });
  const actualRuntime = createRuntimeBindingKernel({ registrationRegistry: registrationKernel.registry, launchRegistry: launchKernel.registry });
  const runtimeKernel = { ...actualRuntime, authority: { ...actualRuntime.authority, openConnection(...args) { const result = actualRuntime.authority.openConnection(...args); connectionHandles.push(result.connectionHandle); return result; }, attestActor(...args) { const result = actualRuntime.authority.attestActor(...args); actorHandles.push(result.actorHandle); return result; } } };
  const methods = []; const requests = [];
  const observations = [];
  const children = [];
  let instructionWrites = 0, instructionRequest = null, parentCreated = false;
  let collector, capability, runnerOptionsCaptured;
  let resolveHeldContext;
  const heldContextReady = new Promise((resolve) => { resolveHeldContext = resolve; });
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.killCalls = 0;
  child.send = (...messages) => child.stdout.emit('data', Buffer.from(messages.map(JSON.stringify).join('\n') + '\n'));
  child.kill = () => { child.killCalls += 1; setImmediate(() => child.emit('exit', 0)); return true; };
  child.stdin = Object.assign(new EventEmitter(), {
    write(line, callback) {
      const request = JSON.parse(line); requests.push(request);
      if (provider === 'claude' && request.type === 'user' && request.session_id) {
        instructionWrites += 1; instructionRequest = request;
        if (options.writeThrow) throw new Error('fixture write failure');
        if (options.writeError) { callback?.(new Error('fixture write failure')); return true; }
        if (!options.holdAck) child.send({ type: 'stream_event', session_id: 'native-id', parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'next-context', role: 'assistant' } } });
      } else if (request.method === 'turn/steer' || request.method === 'turn/start' && request.params.clientUserMessageId) {
        methods.push(request.method); instructionWrites += 1; instructionRequest = request;
        if (options.writeThrow) throw new Error('fixture write failure');
        if (options.writeError) { callback?.(new Error('fixture write failure')); return true; }
        const turnId = request.method === 'turn/steer' ? 'native-context' : 'next-context';
        if (options.earlyItem) child.send({ method: 'item/started', params: { threadId: 'native-id', turnId,
          item: { type: 'userMessage', id: 'native-item', clientId: request.params.clientUserMessageId, content: request.params.input } } });
        if (options.earlyTerminal) child.send({ method: 'turn/completed', params: { threadId: 'native-id', turn: { id: turnId, status: 'completed' } } });
        if (!options.holdAck) child.send({ id: request.id, result: request.method === 'turn/steer' ? { turnId } : { turn: { id: turnId } } });
        if (options.itemAfterAck) child.send({ method: 'item/completed', params: { threadId: 'native-id', turnId,
          item: { type: 'userMessage', id: 'native-item', clientId: request.params.clientUserMessageId, content: request.params.input } } });
      } else if (provider === 'claude' && request.type === 'user') {
        child.send({ type: 'system', subtype: 'init', session_id: 'native-id' });
        const sendContext = () => child.send({ type: 'stream_event', session_id: 'native-id', parent_tool_use_id: null,
          event: { type: 'message_start', message: { id: 'native-context', role: 'assistant' } } });
        sendContext();
      } else if (request.method && Object.hasOwn(request, 'id')) {
        methods.push(request.method);
        const send = (result) => child.send({ id: request.id, result });
        if (request.method === 'initialize') send({ serverInfo: { name: 'fixture', version: '1' }, codexHome: path.join(homePath, '.codex') });
        else if (request.method === 'account/login/start') send({ type: 'chatgpt', loginId: 'login-id', authUrl: 'https://auth.example.test/device' });
        else if (request.method === 'thread/start') send({ thread: { id: 'native-id' } });
        else if (request.method === 'turn/start') {
          const sendContext = () => send({ turn: { id: 'native-context' } });
          if (options.holdContext) { heldContext = sendContext; resolveHeldContext(); } else sendContext();
        }
        else if (request.method === 'thread/loaded/list') send({ data: ['native-id'], nextCursor: null });
        else if (request.method === 'thread/read') {
          const result = { thread: { id: 'native-id', status: { type: 'active' }, turns: [{ id: 'native-context', status: 'inProgress', items: [] }] } };
          send(result);
        }
      }
      queueMicrotask(() => callback?.()); return true;
    }, end() {},
  });
  const composition = createNativeLaunchComposition({ registrationKernel, launchKernel, runtimeKernel,
    hostId: 'fixture-host', profiles: { [provider]: { provider, executablePath, homePath, cwd, homeScopeId: 'fixture-home' } },
    getAuthentication: () => ({ oauthToken: 'fixture-token' }),
    onAuthenticationRequired: ({ loginId }) => child.send({ method: 'account/login/completed', params: { loginId, success: true } }),
    runnerFactory(runnerOptions) {
      if (options.childOrigin && !parentCreated) {
        parentCreated = true;
        return { async start() {
          runnerOptions.onNative({ type: 'identity', provider, identity: { provider, nativeIdKind: provider === 'codex' ? 'thread' : 'session',
            hostId: 'fixture-host', homeScopeId: 'fixture-home', nativeId: 'parent-native' } });
          runnerOptions.onNative({ type: 'context', provider, identity: { provider, nativeIdKind: provider === 'codex' ? 'thread' : 'session',
            hostId: 'fixture-host', homeScopeId: 'fixture-home', nativeId: 'parent-native' },
            context: { kind: provider === 'codex' ? 'turn' : 'assistant_message', nativeContextId: 'parent-context', parentToolUseId: null } });
          return this.snapshot();
        }, async stop() { return { state: 'stopped', childExited: true }; }, snapshot() { return { state: 'running', ownedChildActive: true }; } };
      }
      runnerOptionsCaptured = runnerOptions;
      return createOwnedNativeRunner({ ...runnerOptions,
        ...(options.wait ? { profile: 'cockpit-native-wait-v1', onWaitRequired() {} } : {}),
        onSourceReady(cap) { capability = cap; runnerOptions.onSourceReady(cap); },
        onNative(event) {
          runnerOptions.onNative(event);
          if (event.type === 'identity') collector.connect();
        },
        spawnImpl() { children.push(child); setImmediate(() => child.emit('spawn')); return child; },
        timeouts: { startupMs: 1000, rpcMs: 1000, loginMs: 1000, stopMs: 100 },
      });
    },
  });
  let receipt = composition.admitLaunch({ launchId: 'launch', runId: 'run', attemptId: 'attempt', profileId: provider, origin: options.origin || 'standalone', purpose: options.purpose || 'agent' });
  collector = composition.createOwnedCollector(receipt, { onObservation: (value) => observations.push(value) });
  t.after(() => composition.stop(receipt));
  return { composition, requests, get collector() { return collector; }, get receipt() { return receipt; }, registrationKernel, launchKernel, runtimeKernel, child, children, methods, observations, directory,
    onKernelRead(callback) { onKernelRead = callback; },
    runnerOptions: () => runnerOptionsCaptured,
    capability: () => capability,
    actorHandles, connectionHandles, actualRuntime, instructionWrites: () => instructionWrites, instructionRequest: () => instructionRequest,
    terminal() {
      if (provider === 'codex') child.send({ method: 'turn/completed', params: { threadId: 'native-id', turn: { id: 'native-context', status: 'completed' } } });
      else child.send({ type: 'result', session_id: 'native-id' });
    },
    start: async () => {
      if (options.childOrigin) {
        const parent = await composition.start(receipt, { inputText: 'parent fixture input' });
        receipt = composition.admitLaunch({ launchId: 'child-launch', runId: 'child-run', attemptId: 'child-attempt', profileId: provider,
          origin: options.childOrigin, purpose: options.childOrigin === 'review' ? 'cross-review' : 'agent', originReceipt: parent.runReceipt });
        collector = composition.createOwnedCollector(receipt);
      }
      return composition.start(receipt, { inputText: 'fixture input' });
    },
  };
}


function commandFor(f, launchRef, mode = 'steer', deliveryAttemptId = 'delivery') {
  const launch = f.launchKernel.registry.get(launchRef);
  const claims = Object.fromEntries(['launchId', 'runId', 'attemptId', 'provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'origin', 'purpose', 'originBinding'].map(key => [key, launch[key]]));
  const registered = f.registrationKernel.registry.snapshot().executions.find(item => item.executionId === launch.executionBinding.periodId);
  const source = { launchRef, claims, identity: launch.identity, executionBinding: launch.executionBinding,
    conversationId: registered.conversationId, sessionId: registered.sessionId };
  const target = { kind: 'execution', launchRef, claims, identity: launch.identity, periodId: launch.executionBinding.periodId,
    actor: launch.executionBinding.actor, conversationId: source.conversationId, sessionId: source.sessionId };
  const input = [{ type: 'text', text: 'instruction input', text_elements: [] }];
  const expectedTurnId = mode === 'steer' ? 'native-context' : null;
  const metadata = { deliveryAttemptId, revision: 1,
    payloadDigest: sha256(JSON.stringify({ schemaVersion: 1, mode, expectedTurnId, input })),
    nativeContentDigest: sha256(JSON.stringify(input)), source, target, mode, expectedTurnId };
  return { metadata, command: { ...metadata, input } };
}

for (const provider of ['codex', 'claude']) {
  test('ID-F08-NI01 ' + provider + ': working sends only fixed Codex steer and rejects Claude working', async t => {
    const f = fixture(t, provider, { itemAfterAck: true }); const started = await f.start();
    const owner = f.composition.createInstructionOwner(f.receipt); const { metadata, command } = commandFor(f, started.launchRef);
    const evidence = []; owner.subscribeInstructionEvidence((cap, value) => evidence.push({ cap, value }));
    const cap = owner.prepareInstructionDispatch(metadata);
    if (provider === 'claude') { assert.equal(cap, null); assert.equal(f.instructionWrites(), 0); return; }
    assert.ok(cap); assert.equal(owner.checkInstructionDispatch(cap, metadata), true);
    const ackPromise = owner.dispatchInstructionNow(cap, command);
    assert.equal(f.instructionWrites(), 1); const ack = await ackPromise;
    assert.deepEqual(ack, { clientRequestId: 'delivery', nativeTurnId: 'native-context', nativeItemId: null });
    assert.equal(f.methods.filter(method => method === 'turn/start').length, 1);
    assert.equal(evidence.length, 1); assert.equal(evidence[0].cap, cap);
    assert.deepEqual(evidence[0].value.input, command.input);
    assert.equal(owner.checkInstructionDispatch(cap, metadata), false);
    assert.throws(() => owner.dispatchInstructionNow(cap, command)); assert.equal(f.instructionWrites(), 1);
  });
  test('ID-F08-NI02 ' + provider + ': stopped standalone starts same native identity with a distinct context', async t => {
    const f = fixture(t, provider, { earlyItem: true }); const started = await f.start();
    const oldProof = f.composition.resolveProof(started.launchRef); const oldWriter = f.composition.writerFor(started.launchRef);
    f.terminal();
    assert.equal(f.composition.checkCurrentProof(started.launchRef, oldProof).ok, false);
    const owner = f.composition.createInstructionOwner(f.receipt); const { metadata, command } = commandFor(f, started.launchRef, 'start');
    const evidence = []; owner.subscribeInstructionEvidence((cap, value) => evidence.push(value));
    const cap = owner.prepareInstructionDispatch(metadata); assert.ok(cap);
    const result = owner.dispatchInstructionNow(cap, command);
    assert.equal(f.instructionWrites(), 1); assert.equal((await result).nativeTurnId, 'next-context');
    assert.equal(f.registrationKernel.registry.snapshot().executions.length, 1);
    const after = commandFor(f, started.launchRef, 'start').metadata.source;
    assert.deepEqual(after, metadata.source);
    assert.ok(f.composition.resolveProof(started.launchRef));
    assert.equal(f.composition.authorizeWriter(started.launchRef, oldWriter).ok, false);
    assert.equal(evidence.length, provider === 'codex' ? 1 : 0);
    assert.equal(f.child.killCalls, 0);
  });
}

for (const provider of ['codex', 'claude']) {
  for (const invalidation of ['detach', 'period', 'actor', 'source', 'launch']) {
    test(`ID-F08-NI04 ${provider}: prepared stopped cap rejects ${invalidation} before synchronous sink`, async t => {
      const f = fixture(t, provider); const started = await f.start(); f.terminal();
      const owner = f.composition.createInstructionOwner(f.receipt);
      const { metadata, command } = commandFor(f, started.launchRef, 'start');
      const cap = owner.prepareInstructionDispatch(metadata); assert.ok(cap);
      if (invalidation === 'detach') await f.collector.disconnect();
      if (invalidation === 'period') f.registrationKernel.authority.end(f.registrationKernel.registry.snapshot().executions[0].executionId);
      if (invalidation === 'actor') f.actualRuntime.authority.endActor(f.actorHandles[0]);
      if (invalidation === 'source') f.actualRuntime.authority.disconnect(f.connectionHandles[0]);
      if (invalidation === 'launch') f.launchKernel.authority.endLaunch(started.launchRef);
      assert.equal(owner.checkInstructionDispatch(cap, metadata), false);
      assert.throws(() => owner.dispatchInstructionNow(cap, command)); assert.equal(f.instructionWrites(), 0);
    });
  }
  test(`ID-F08-NI05 ${provider}: captured stdin getter invalidation is rejected by final private actor/period gate`, async t => {
    const f = fixture(t, provider); const started = await f.start(); f.terminal();
    const owner = f.composition.createInstructionOwner(f.receipt); const { metadata, command } = commandFor(f, started.launchRef, 'start');
    const cap = owner.prepareInstructionDispatch(metadata); assert.ok(cap);
    const original = f.child.stdin.write;
    Object.defineProperty(f.child.stdin, 'write', { get() {
      f.registrationKernel.authority.end(f.registrationKernel.registry.snapshot().executions[0].executionId); return original;
    } });
    assert.throws(() => owner.dispatchInstructionNow(cap, command)); assert.equal(f.instructionWrites(), 0);
  });
  test(`ID-F08-NI03 ${provider}: clone and modified native/HOME metadata cannot create or consume a capability`, async t => {
    const f = fixture(t, provider); const started = await f.start(); f.terminal();
    const owner = f.composition.createInstructionOwner(f.receipt); const { metadata, command } = commandFor(f, started.launchRef, 'start');
    const cap = owner.prepareInstructionDispatch(metadata); assert.ok(cap);
    assert.equal(owner.checkInstructionDispatch({}, metadata), false);
    assert.throws(() => owner.dispatchInstructionNow({}, command));
    for (const field of ['nativeId', 'homeScopeId']) {
      const changed = structuredClone(metadata); changed.source.identity[field] = 'foreign'; changed.target.identity[field] = 'foreign';
      if (field === 'homeScopeId') { changed.source.claims[field] = 'foreign'; changed.target.claims[field] = 'foreign'; }
      assert.equal(owner.prepareInstructionDispatch(changed), null);
    }
    assert.equal(owner.checkInstructionDispatch(cap, metadata), true); assert.equal(f.instructionWrites(), 0);
  });
}

test('ID-F08-NI03 Codex wait holds an otherwise current steer with write zero', async t => {
  const f = fixture(t, 'codex', { wait: true }); const started = await f.start();
  f.child.send({ id: 501, method: 'item/tool/call', params: { threadId: 'native-id', turnId: 'native-context', callId: 'wait-call', namespace: null, tool: 'cockpit_wait', arguments: {} } });
  const owner = f.composition.createInstructionOwner(f.receipt); const { metadata } = commandFor(f, started.launchRef);
  assert.equal(owner.prepareInstructionDispatch(metadata), null); assert.equal(f.instructionWrites(), 0);
});

test('ID-F08-NI06 Codex terminal before start ack accepts no active proof or applied evidence', async t => {
  const f = fixture(t, 'codex', { earlyTerminal: true, earlyItem: true }); const started = await f.start(); f.terminal();
  const owner = f.composition.createInstructionOwner(f.receipt); const { metadata, command } = commandFor(f, started.launchRef, 'start');
  const evidence = []; owner.subscribeInstructionEvidence((cap, value) => evidence.push(value));
  const cap = owner.prepareInstructionDispatch(metadata); const ack = await owner.dispatchInstructionNow(cap, command);
  assert.equal(ack.nativeTurnId, 'next-context'); assert.equal(f.instructionWrites(), 1);
  assert.equal(f.composition.resolveProof(started.launchRef), null); assert.equal(evidence.length, 0);
  assert.equal(f.runtimeKernel.registry.snapshot().actors.length, 1);
  const next = commandFor(f, started.launchRef, 'start', 'next-delivery');
  assert.equal(owner.prepareInstructionDispatch(next.metadata), null);
});

for (const provider of ['codex', 'claude']) {
  for (const writeFailure of ['writeThrow', 'writeError']) {
    test(`ID-F08-NI07 ${provider}: ${writeFailure} starts at most one write and cannot retry the same delivery`, async t => {
      const f = fixture(t, provider, { [writeFailure]: true }); const started = await f.start(); f.terminal();
      const owner = f.composition.createInstructionOwner(f.receipt); const { metadata, command } = commandFor(f, started.launchRef, 'start');
      const cap = owner.prepareInstructionDispatch(metadata);
      await assert.rejects(owner.dispatchInstructionNow(cap, command), { code: 'instruction_write_failed' });
      assert.equal(f.instructionWrites(), 1); assert.equal(owner.prepareInstructionDispatch(metadata), null);
      assert.throws(() => owner.dispatchInstructionNow(cap, command)); assert.equal(f.instructionWrites(), 1);
    });
  }
}

test('ID-F08-NI07 Codex ack timeout fences late start response without context/proof revival', async t => {
  const f = fixture(t, 'codex', { holdAck: true }); const started = await f.start(); f.terminal();
  const owner = f.composition.createInstructionOwner(f.receipt); const { metadata, command } = commandFor(f, started.launchRef, 'start');
  const cap = owner.prepareInstructionDispatch(metadata);
  await assert.rejects(owner.dispatchInstructionNow(cap, command), { code: 'instruction_ack_timeout' });
  const request = f.instructionRequest(); f.child.send({ id: request.id, result: { turn: { id: 'next-context' } } });
  assert.equal(f.composition.resolveProof(started.launchRef), null); assert.equal(f.runtimeKernel.registry.snapshot().actors.length, 1);
  assert.equal(owner.prepareInstructionDispatch(metadata), null); assert.equal(f.instructionWrites(), 1);
});

for (const provider of ['codex', 'claude']) {
  test(`ID-F08-NI05 ${provider}: last registry metadata callback ends the period before any stopped write`, async t => {
    const f = fixture(t, provider); const started = await f.start(); f.terminal();
    const owner = f.composition.createInstructionOwner(f.receipt); const { metadata, command } = commandFor(f, started.launchRef, 'start');
    const cap = owner.prepareInstructionDispatch(metadata);
    const executionId = f.registrationKernel.registry.snapshot().executions[0].executionId;
    f.onKernelRead(() => { f.onKernelRead(null); f.registrationKernel.authority.end(executionId); });
    assert.throws(() => owner.dispatchInstructionNow(cap, command)); assert.equal(f.instructionWrites(), 0);
  });
  test(`ID-F08-NI08 ${provider}: old lease capability rejects after reconnect without changing new proof`, async t => {
    const f = fixture(t, provider); const started = await f.start();
    const owner = f.composition.createInstructionOwner(f.receipt); const first = commandFor(f, started.launchRef);
    const oldCap = provider === 'codex' ? owner.prepareInstructionDispatch(first.metadata) : null;
    await f.collector.disconnect(); await f.collector.connect();
    assert.equal(owner.prepareInstructionDispatch(commandFor(f, started.launchRef, 'steer', 'fresh-before-read').metadata), null);
    const read = await f.collector.observeKnownThread('native-id');
    assert.equal(read.status, provider === 'codex' ? 'observed' : 'unsupported');
    if (oldCap) {
      const freshProof = f.composition.resolveProof(started.launchRef);
      assert.equal(owner.checkInstructionDispatch(oldCap, first.metadata), false);
      assert.throws(() => owner.dispatchInstructionNow(oldCap, first.command));
      assert.equal(f.composition.resolveProof(started.launchRef), freshProof);
      const next = commandFor(f, started.launchRef, 'steer', 'fresh-delivery');
      const nextCap = owner.prepareInstructionDispatch(next.metadata); assert.ok(nextCap);
      await owner.dispatchInstructionNow(nextCap, next.command); assert.equal(f.instructionWrites(), 1);
    } else assert.equal(f.instructionWrites(), 0);
  });
  test(`ID-F08-NI03 ${provider}: matching terminal actor-only capability is private, standalone, and separate from proof`, async t => {
    const f = fixture(t, provider); const started = await f.start();
    const actor = f.actorHandles[0];
    assert.equal(f.actualRuntime.registry.checkActorLifeCapability(started.launchRef, actor, 0), false);
    f.terminal();
    const generation = f.actualRuntime.registry.get(started.launchRef).ownerGeneration;
    assert.equal(f.actualRuntime.registry.checkActorLifeCapability(started.launchRef, actor, generation), true);
    assert.equal(f.actualRuntime.registry.checkActorLifeCapability(started.launchRef, {}, generation), false);
    assert.equal(f.actualRuntime.registry.checkActorLifeCapability('foreign', actor, generation), false);
    assert.equal(f.composition.resolveProof(started.launchRef), null);
    f.actualRuntime.authority.endActor(actor);
    assert.equal(f.actualRuntime.registry.checkActorLifeCapability(started.launchRef, actor, generation), false);
  });
}

test('ID-F08-NI07 Codex backpressure starts exactly one write and returns a real Promise', async t => {
  const f = fixture(t, 'codex', { backpressure: true }); const started = await f.start();
  const owner = f.composition.createInstructionOwner(f.receipt); const { metadata, command } = commandFor(f, started.launchRef);
  const cap = owner.prepareInstructionDispatch(metadata); const promise = owner.dispatchInstructionNow(cap, command);
  assert.equal(require('node:util').types.isPromise(promise), true);
  assert.equal((await promise).nativeTurnId, 'native-context'); assert.equal(f.instructionWrites(), 1);
});

test('ID-F08-NI06 Codex missing clientId stays accepted without applied evidence', async t => {
  const f = fixture(t, 'codex'); const started = await f.start();
  const owner = f.composition.createInstructionOwner(f.receipt); const { metadata, command } = commandFor(f, started.launchRef);
  const evidence = []; owner.subscribeInstructionEvidence((cap, value) => evidence.push(value));
  await owner.dispatchInstructionNow(owner.prepareInstructionDispatch(metadata), command);
  f.child.send({ method: 'item/completed', params: { threadId: 'native-id', turnId: 'native-context',
    item: { type: 'userMessage', id: 'native-item', content: command.input } } });
  assert.equal(evidence.length, 0); assert.equal(f.instructionWrites(), 1);
});

test('ID-F08-NI06 Codex full input mismatch and item reuse cannot emit further native evidence', async t => {
  const f = fixture(t, 'codex'); const started = await f.start();
  const owner = f.composition.createInstructionOwner(f.receipt); const first = commandFor(f, started.launchRef);
  const evidence = []; owner.subscribeInstructionEvidence((cap, value) => evidence.push(value));
  await owner.dispatchInstructionNow(owner.prepareInstructionDispatch(first.metadata), first.command);
  const item = { type: 'userMessage', id: 'shared-item', clientId: 'delivery', content: first.command.input };
  f.child.send({ method: 'item/completed', params: { threadId: 'native-id', turnId: 'native-context', item } });
  assert.equal(evidence.length, 1);
  const second = commandFor(f, started.launchRef, 'steer', 'second');
  await owner.dispatchInstructionNow(owner.prepareInstructionDispatch(second.metadata), second.command);
  f.child.send({ method: 'item/completed', params: { threadId: 'native-id', turnId: 'native-context', item: { ...item, clientId: 'second' } } });
  f.child.send({ method: 'item/completed', params: { threadId: 'native-id', turnId: 'native-context', item: { ...item, id: 'other-item', content: [{ type: 'text', text: 'wrong', text_elements: [] }] } } });
  assert.equal(evidence.length, 1); assert.equal(f.instructionWrites(), 2);
});

test('ID-F08-NI09 lifetime capability bound fails closed without forgetting used delivery IDs', async t => {
  const { createOwnedInstructionWriter } = require('../src/server/owned-native-instruction-writer');
  const f = fixture(t, 'codex'); const started = await f.start();
  const sourceCap = Object.freeze({}); let controller; let currentToken; let writes = 0;
  controller = createOwnedInstructionWriter(sourceCap, { capture: () => ({}), check: () => true, checkEvidence: () => true,
    prepareWrite: () => ({ write(line, callback) { writes += 1; controller.acknowledge(currentToken, 'native-context'); callback(); }, line: '{}\n' }),
    register(token) { currentToken = token; }, unregister() {}, complete() {},
  });
  const writer = getOwnedInstructionWriter(sourceCap);
  const first = commandFor(f, started.launchRef, 'steer', 'direct-0'); const token = writer.prepare(first.metadata);
  await writer.dispatchNow(token, first.command, () => true);
  for (let index = 1; index < 128; index += 1) assert.ok(writer.prepare(commandFor(f, started.launchRef, 'steer', 'direct-' + index).metadata));
  assert.equal(writer.prepare(commandFor(f, started.launchRef, 'steer', 'over-bound').metadata), null);
  assert.equal(writer.prepare(first.metadata), null); assert.equal(writes, 1); assert.equal(getOwnedInstructionWriter({}), null);
  controller.invalidate();
});

test('ID-F08-NI08 Codex late item from an old lease emits no evidence after a fresh read', async t => {
  const f = fixture(t, 'codex'); const started = await f.start();
  const owner = f.composition.createInstructionOwner(f.receipt); const { metadata, command } = commandFor(f, started.launchRef);
  const evidence = []; owner.subscribeInstructionEvidence((cap, value) => evidence.push(value));
  await owner.dispatchInstructionNow(owner.prepareInstructionDispatch(metadata), command);
  await f.collector.disconnect(); await f.collector.connect(); await f.collector.observeKnownThread('native-id');
  f.child.send({ method: 'item/completed', params: { threadId: 'native-id', turnId: 'native-context',
    item: { type: 'userMessage', id: 'late-item', clientId: 'delivery', content: command.input } } });
  assert.equal(evidence.length, 0); assert.equal(f.instructionWrites(), 1);
});

test('ID-F08-NI06 Codex ack turn mismatch keeps unknown and creates no new actor', async t => {
  const f = fixture(t, 'codex', { holdAck: true, earlyItem: true }); const started = await f.start(); f.terminal();
  const owner = f.composition.createInstructionOwner(f.receipt); const { metadata, command } = commandFor(f, started.launchRef, 'start');
  const evidence = []; owner.subscribeInstructionEvidence((cap, value) => evidence.push(value));
  const pending = owner.dispatchInstructionNow(owner.prepareInstructionDispatch(metadata), command);
  f.child.send({ id: f.instructionRequest().id, result: { turn: { id: 'wrong-turn' } } });
  await assert.rejects(pending, { code: 'instruction_ack_mismatch' });
  assert.equal(evidence.length, 0);
  assert.equal(f.composition.resolveProof(started.launchRef), null);
  assert.equal(f.runtimeKernel.registry.snapshot().actors.length, 1);
});

for (const provider of ['claude', 'codex']) for (const origin of ['delegated', 'review']) {
  test(`ID-F08-NI03 ${provider}: ${origin} stopped execution never uses actor-only start`, async t => {
    const f = fixture(t, provider, { childOrigin: origin }); const started = await f.start();
    assert.ok(f.composition.resolveProof(started.launchRef)); f.terminal();
    const owner = f.composition.createInstructionOwner(f.receipt); const { metadata } = commandFor(f, started.launchRef, 'start');
    assert.equal(owner.prepareInstructionDispatch(metadata), null); assert.equal(f.instructionWrites(), 0);
    assert.equal(f.registrationKernel.registry.snapshot().executions.length, 2);
  });
}

function isolatedWriterHarness() {
  const file = require.resolve('../src/server/owned-native-instruction-writer');
  const isolated = { exports: {} };
  let now = 1000;
  const jobs = new Set();
  const timer = (callback, delay) => { const job = { callback, delay, unref() {} }; jobs.add(job); return job; };
  const cancel = job => jobs.delete(job);
  new Function('require', 'module', 'exports', 'Date', 'Buffer', 'setTimeout', 'clearTimeout', fs.readFileSync(file, 'utf8'))(
    require('node:module').createRequire(file), isolated, isolated.exports, { now: () => now }, Buffer, timer, cancel);
  const sourceCap = Object.freeze({}); let currentToken;
  const controller = isolated.exports.createOwnedInstructionWriter(sourceCap, {
    capture: () => ({}), check: () => true, checkEvidence: () => true,
    prepareWrite: () => ({ write() {}, line: '{}\n' }), register(token) { currentToken = token; }, unregister() {}, complete() {},
  });
  return { writer: isolated.exports.getOwnedInstructionWriter(sourceCap), controller, token: () => currentToken,
    advance(milliseconds) { now += milliseconds; for (const job of [...jobs]) if (job.delay <= milliseconds) { jobs.delete(job); job.callback(); } },
  };
}

test('ID-F08-NI09 private API bounds candidates globally across requests before ack', async t => {
  const f = fixture(t, 'codex'); const started = await f.start(); const h = isolatedWriterHarness();
  const pairs = ['one', 'two'].map(id => commandFor(f, started.launchRef, 'steer', id));
  const tokens = []; const promises = []; const emitted = [];
  h.writer.subscribeEvidence((token, receipt) => emitted.push(receipt));
  for (const pair of pairs) {
    const token = h.writer.prepare(pair.metadata); tokens.push(token); promises.push(h.writer.dispatchNow(token, pair.command, () => true));
    for (let index = 0; index < 64; index += 1) assert.equal(h.controller.observeItem('native-id', 'native-context', {
      type: 'userMessage', id: pair.metadata.deliveryAttemptId + index, clientId: pair.metadata.deliveryAttemptId, content: pair.command.input }), true);
  }
  assert.equal(h.controller.observeItem('native-id', 'native-context', { type: 'userMessage', id: 'overflow', clientId: 'two', content: pairs[1].command.input }), false);
  h.controller.acknowledge(tokens[0], 'native-context'); h.controller.acknowledge(tokens[1], 'native-context'); await Promise.all(promises);
  assert.equal(emitted.length, 64);
  h.controller.invalidate();
});

test('ID-F08-NI09 serialized bytes and sixty-second TTL remove payload while retaining ID and item ownership', async t => {
  const f = fixture(t, 'codex'); const started = await f.start(); const h = isolatedWriterHarness();
  const make = (id, text) => {
    const pair = commandFor(f, started.launchRef, 'steer', id);
    pair.command.input = [{ type: 'text', text, text_elements: [] }];
    pair.metadata.nativeContentDigest = sha256(JSON.stringify(pair.command.input));
    pair.metadata.payloadDigest = sha256(JSON.stringify({ schemaVersion: 1, mode: 'steer', expectedTurnId: 'native-context', input: pair.command.input }));
    pair.command = { ...pair.metadata, input: pair.command.input }; return pair;
  };
  const tooLarge = make('too-large', '\u0000'.repeat(100000)); const oversizedToken = h.writer.prepare(tooLarge.metadata);
  assert.throws(() => h.writer.dispatchNow(oversizedToken, tooLarge.command, () => true));
  const first = make('first', 'x'.repeat(90000)); const token = h.writer.prepare(first.metadata);
  const pending = h.writer.dispatchNow(token, first.command, () => true);
  assert.equal(h.controller.observeItem('native-id', 'native-context', { type: 'userMessage', id: 'retained-item', clientId: 'first', content: first.command.input }), true);
  assert.equal(h.controller.observeItem('native-id', 'native-context', { type: 'userMessage', id: 'over-byte-bound', clientId: 'first', content: first.command.input }), false);
  h.controller.acknowledge(token, 'native-context'); await pending;
  const unused = commandFor(f, started.launchRef, 'steer', 'unused'); const unusedToken = h.writer.prepare(unused.metadata);
  h.advance(60000);
  assert.equal(h.writer.check(unusedToken), false); assert.equal(h.writer.prepare(unused.metadata), null);
  assert.equal(h.writer.prepare(first.metadata), null);
  assert.equal(h.controller.observeItem('native-id', 'native-context', { type: 'userMessage', id: 'late-item', clientId: 'first', content: first.command.input }), false);
  const second = make('second', 'y'.repeat(90000)); assert.ok(h.writer.prepare(second.metadata));
  h.controller.invalidate();
});

test('ID-F08-NI06 installed native text default omits only empty text_elements and rejects spans or unknown keys', async t => {
  const f = fixture(t, 'codex'); const started = await f.start();
  const owner = f.composition.createInstructionOwner(f.receipt); const evidence = [];
  owner.subscribeInstructionEvidence((cap, value) => evidence.push(value));
  for (const [index, extra] of [[0, {}], [1, { text_elements: [{ start: 0, end: 1 }] }], [2, { unknown: true }]]) {
    const pair = commandFor(f, started.launchRef, 'steer', 'schema-default-' + index);
    await owner.dispatchInstructionNow(owner.prepareInstructionDispatch(pair.metadata), pair.command);
    f.child.send({ method: 'item/completed', params: { threadId: 'native-id', turnId: 'native-context',
      item: { type: 'userMessage', id: 'default-item-' + index, clientId: pair.metadata.deliveryAttemptId,
        content: [{ type: 'text', text: pair.command.input[0].text, ...extra }] } } });
  }
  assert.equal(evidence.length, 1); assert.deepEqual(evidence[0].input, [{ type: 'text', text: 'instruction input', text_elements: [] }]);
});

test('ID-F08-NI09 TTL preserves item ownership while removing native receipts and payload', async t => {
  const f = fixture(t, 'codex'); const started = await f.start(); const h = isolatedWriterHarness();
  const receipts = []; h.writer.subscribeEvidence((token, receipt) => receipts.push({ token, receipt }));
  const first = commandFor(f, started.launchRef, 'steer', 'first-owner');
  const token = h.writer.prepare(first.metadata); const pending = h.writer.dispatchNow(token, first.command, () => true);
  const item = { type: 'userMessage', id: 'same-item', clientId: 'first-owner', content: first.command.input };
  h.controller.observeItem('native-id', 'native-context', item); h.controller.acknowledge(token, 'native-context'); await pending;
  assert.equal(receipts.length, 1); assert.ok(h.writer.inspectEvidence(token, receipts[0].receipt));
  h.advance(60000);
  assert.equal(h.writer.inspectEvidence(token, receipts[0].receipt), null); assert.equal(h.writer.prepare(first.metadata), null);
  const second = commandFor(f, started.launchRef, 'steer', 'second-owner');
  const secondToken = h.writer.prepare(second.metadata); const secondPending = h.writer.dispatchNow(secondToken, second.command, () => true);
  h.controller.observeItem('native-id', 'native-context', { ...item, clientId: 'second-owner' });
  h.controller.acknowledge(secondToken, 'native-context'); await secondPending;
  assert.equal(receipts.length, 1); h.controller.invalidate();
});

test('ID-F08-NI08 read IDs remain exact after instruction interleaving and unissued responses still fail closed', async t => {
  const f = fixture(t, 'codex'); const started = await f.start();
  await f.collector.observeKnownThread('native-id');
  const owner = f.composition.createInstructionOwner(f.receipt); const pair = commandFor(f, started.launchRef);
  await owner.dispatchInstructionNow(owner.prepareInstructionDispatch(pair.metadata), pair.command);
  await f.collector.observeKnownThread('native-id');
  const reads = f.requests.filter(request => ['thread/read', 'thread/loaded/list'].includes(request.method));
  assert.equal(reads.length, 4);
  assert.deepEqual(reads.map(request => request.id), [2 ** 32, 2 ** 32 + 1, 2 ** 32 + 2, 2 ** 32 + 3]);
  assert.equal(f.instructionRequest().id, 2 ** 48);
  f.child.send({ id: reads[0].id, result: {} }); assert.equal(f.child.killCalls, 0);
  f.child.send({ id: 2 ** 32 + 100, result: {} });
  assert.equal(f.composition.resolveProof(started.launchRef), null); assert.equal(f.child.killCalls, 1);
});
