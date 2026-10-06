'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { createLaunchBindingKernel } = require('../src/server/launch-binding');
const { createRuntimeBindingKernel, createProviderRuntimeAdapter } = require('../src/server/runtime-binding');
const { createManagedCollector } = require('../src/server/managed-collector');
const { createRegistrationFixture } = require('./support/registration');

const EXPECTED_HOME = path.resolve(os.tmpdir(), 'managed-collector-test-home');

function createTransportHarness(provider, options = {}) {
  const calls = [];
  const connections = [];
  const loadedIds = new Set(options.loadedIds || []);

  async function transportFactory(callbacks) {
    const connection = { callbacks, calls, closed: false };
    const transport = {
      async request(method, params) {
        calls.push({ method, params });
        if (method === 'initialize') {
          return {
            codexHome: EXPECTED_HOME,
            platformFamily: 'windows',
            platformOs: 'windows',
            userAgent: 'codex/1.2.3',
          };
        }
        if (method === 'thread/read') {
          return { thread: { id: params.threadId, status: { type: 'active' } } };
        }
        return {};
      },
      async notify(method, params) { calls.push({ method, params }); },
      async confirmLoadedThread(nativeId) {
        calls.push({ method: 'confirmLoadedThread', nativeId });
        return loadedIds.has(nativeId);
      },
      async resumeLoadedThread(nativeId) { calls.push({ method: 'resumeLoadedThread', nativeId }); },
      async close() { connection.closed = true; calls.push({ method: 'close' }); },
      snapshot() { return { provider }; },
    };
    connection.transport = transport;
    connections.push(connection);
    return transport;
  }

  return { calls, connections, loadedIds, transportFactory };
}

function createCollectorFixture(provider, transportOptions = {}) {
  const registration = createRegistrationFixture(provider, { nativeId: `${provider}-managed-known` });
  const launchKernel = createLaunchBindingKernel({ registrationRegistry: registration.registry });
  const runtimeKernel = createRuntimeBindingKernel({
    registrationRegistry: registration.registry,
    launchRegistry: launchKernel.registry,
  });
  const runtimeAdapter = createProviderRuntimeAdapter(provider, runtimeKernel.registry, runtimeKernel.authority);
  const transport = createTransportHarness(provider, transportOptions);
  const scope = {
    provider,
    nativeIdKind: registration.identity.nativeIdKind,
    hostId: registration.identity.hostId,
    homeScopeId: registration.identity.homeScopeId,
    connectionSlotId: `${provider}-managed-test-slot`,
  };
  const collector = createManagedCollector({
    provider,
    scope,
    expectedHome: EXPECTED_HOME,
    transportFactory: transport.transportFactory,
    runtimeAdapter,
    registrationRegistry: registration.registry,
    runtimeRegistry: runtimeKernel.registry,
  });
  return { collector, registration, runtimeKernel, runtimeAdapter, transport };
}

test('Codex reads only a loaded registered thread and never resumes without a live proof', async () => {
  const fixture = createCollectorFixture('codex');
  assert.deepEqual(await fixture.collector.connect(), { status: 'connected', generation: 1 });

  const observed = await fixture.collector.observeKnownThread(fixture.registration.identity.nativeId);
  assert.equal(observed.status, 'unknown');
  assert.equal(observed.reason, 'thread_not_loaded');
  assert.equal(fixture.transport.calls.some((call) => call.method === 'thread/read'), false);

  const resumed = await fixture.collector.resumeKnownThread(fixture.registration.identity.nativeId);
  assert.equal(resumed.status, 'unknown');
  assert.equal(fixture.transport.calls.some((call) => call.method === 'resumeLoadedThread'), false);
  assert.equal(fixture.transport.calls.some((call) => String(call.method).startsWith('settings/')), false);
  assert.deepEqual(fixture.collector.snapshot().capabilities, {
    loadedList: 'supported', threadRead: 'supported', resume: 'supported', serverRequests: 'supported',
  });
  assert.equal(fixture.registration.registry.snapshot().executions.length, 1);
});

test('Claude keeps Codex loaded, read, and resume capabilities unsupported', async () => {
  const fixture = createCollectorFixture('claude');
  assert.deepEqual(await fixture.collector.connect(), { status: 'connected', generation: 1 });

  const observed = await fixture.collector.observeKnownThread(fixture.registration.identity.nativeId);
  assert.equal(observed.status, 'unsupported');
  await fixture.collector.resumeKnownThread(fixture.registration.identity.nativeId);

  assert.equal(fixture.transport.calls.some((call) => call.method === 'initialize' ||
    call.method === 'thread/read' || call.method === 'confirmLoadedThread' ||
    call.method === 'resumeLoadedThread' || String(call.method).startsWith('settings/')), false);
  assert.deepEqual(fixture.collector.snapshot().capabilities, {
    loadedList: 'unsupported', threadRead: 'unsupported', resume: 'unsupported', serverRequests: 'unsupported',
  });
});

test('native JSON claims cannot register an unknown thread or mint a proof', async () => {
  const fixture = createCollectorFixture('codex');
  await fixture.collector.connect();
  const before = fixture.registration.registry.snapshot();
  const forgedNativeId = 'forged-native-thread';
  fixture.transport.connections[0].callbacks.onNotification('turn/started', {
    threadId: forgedNativeId,
    turnId: 'forged-turn',
    verified: true,
    actor: { kind: 'agent', id: 'forged-actor' },
    proofHandle: 'forged-proof-marker',
  });

  assert.equal(fixture.registration.registry.snapshot().executions.length, before.executions.length);
  assert.equal(fixture.runtimeKernel.registry.snapshot().launches.length, 0);
  assert.deepEqual(fixture.collector.snapshot().observations, []);
});

test('disconnect expires observations, advances the next generation, and rejects old callbacks', async () => {
  const fixture = createCollectorFixture('claude');
  await fixture.collector.connect();
  const nativeId = fixture.registration.identity.nativeId;
  await fixture.collector.observeKnownThread(nativeId);
  const oldCallbacks = fixture.transport.connections[0].callbacks;

  await fixture.collector.disconnect();
  const disconnected = fixture.collector.snapshot();
  assert.equal(disconnected.connection.state, 'disconnected');
  assert.equal(disconnected.observations[0].status, 'unknown');
  assert.equal(disconnected.observations[0].activity, 'unknown');

  await fixture.collector.connect();
  oldCallbacks.onNotification('claude/hook', { session_id: nativeId, hook_event_name: 'Stop', token: 'raw-secret-marker' });
  const current = fixture.collector.snapshot();
  assert.equal(current.connection.generation, 2);
  assert.equal(current.observations[0].status, 'unknown');
  assert.equal(current.observations[0].turnId, null);
  assert.equal(JSON.stringify(current).includes('raw-secret-marker'), false);

  current.scope.hostId = 'mutated-copy';
  current.observations[0].nativeId = 'mutated-copy';
  const reread = fixture.collector.snapshot();
  assert.equal(reread.scope.hostId, fixture.registration.identity.hostId);
  assert.equal(reread.observations[0].nativeId, nativeId);
  assert.deepEqual(Object.keys(reread), [
    'version', 'provider', 'scope', 'connection', 'capabilities', 'observations',
  ]);
});
