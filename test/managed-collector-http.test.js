'use strict';

const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createManagedCollector } = require('../src/server/managed-collector');
const { jsonBody, request, startTestServer, uiHeaders } = require('./support/server');

test('GET /api/state exposes snapshots from real Claude and Codex collectors with their native ID kinds', async (t) => {
  const collectors = [createRealCollector('codex'), createRealCollector('claude')];
  const server = await startTestServer(t, { managedCollectors: collectors });
  const response = await request(server.info.port, { path: '/api/state' });
  assert.equal(response.status, 200);

  const snapshot = jsonBody(response);
  assertBaseState(snapshot);
  assert.deepEqual(snapshot.managedCollectors.map(({ provider, scope, connection, capabilities }) => ({
    provider,
    nativeIdKind: scope.nativeIdKind,
    connectionSlotId: scope.connectionSlotId,
    connectionState: connection.state,
    capabilities,
  })), [
    {
      provider: 'codex',
      nativeIdKind: 'thread',
      connectionSlotId: 'codex-http-slot',
      connectionState: 'disconnected',
      capabilities: {
        loadedList: 'supported', threadRead: 'supported', resume: 'supported', serverRequests: 'supported',
      },
    },
    {
      provider: 'claude',
      nativeIdKind: 'session',
      connectionSlotId: 'claude-http-slot',
      connectionState: 'disconnected',
      capabilities: {
        loadedList: 'unsupported', threadRead: 'unsupported', resume: 'unsupported', serverRequests: 'unsupported',
      },
    },
  ]);
});

test('GET /api/state applies its managed collector allowlist to untrusted snapshots', async (t) => {
  const secrets = {
    token: 'capability-token-secret-170',
    writer: 'writer-secret-170',
    proof: 'opaque-proof-secret-170',
    native: 'raw-native-prompt-secret-170',
    command: 'raw-native-command-secret-170',
    stderr: 'raw-stderr-secret-170',
  };
  const server = await startTestServer(t, {
    managedCollectors: [{
      snapshot() {
        return {
          version: 77,
          provider: 'codex',
          scope: codexScope(),
          connection: {
            state: 'connected',
            generation: 3,
            providerVersion: 'codex-cli/0.160.1',
            token: secrets.token,
            stderr: secrets.stderr,
          },
          capabilities: {
            loadedList: 'supported',
            threadRead: 'supported',
            resume: 'supported',
            serverRequests: 'unsupported',
            token: secrets.token,
            proof: secrets.proof,
          },
          observations: [{
            observationId: 'observation-170',
            nativeId: 'thread-170',
            conversationId: 'conversation-170',
            executionId: 'execution-170',
            sessionId: 'session-170',
            status: 'active',
            activity: 'active',
            turnState: 'active',
            turnId: 'turn-170',
            pendingRequests: [{ requestId: 'request-170', state: 'pending', writer: secrets.writer }],
            reason: 'actor_binding_unverified',
            rawParams: { text: secrets.native, command: secrets.command },
            nativeContent: secrets.native,
            writer: secrets.writer,
            proof: secrets.proof,
          }],
          token: secrets.token,
          writer: secrets.writer,
          proof: secrets.proof,
          rawNativeContent: secrets.native,
        };
      },
    }],
  });

  const response = await request(server.info.port, { path: '/api/state' });
  assert.equal(response.status, 200);
  const snapshot = jsonBody(response);
  assertBaseState(snapshot);
  assert.deepEqual(snapshot.managedCollectors, [{
    version: 1,
    provider: 'codex',
    scope: codexScope(),
    connection: { state: 'connected', generation: 3, providerVersion: 'codex-cli/0.160.1' },
    capabilities: {
      loadedList: 'supported', threadRead: 'supported', resume: 'supported', serverRequests: 'unsupported',
    },
    observations: [{
      observationId: 'observation-170',
      nativeId: 'thread-170',
      conversationId: 'conversation-170',
      executionId: 'execution-170',
      sessionId: 'session-170',
      status: 'active',
      activity: 'active',
      turnState: 'active',
      turnId: 'turn-170',
      pendingRequests: [{ requestId: 'request-170', state: 'pending' }],
      reason: 'actor_binding_unverified',
    }],
  }]);
  for (const secret of Object.values(secrets)) assert.equal(response.body.includes(secret), false);
});

test('GET /api/state skips throwing, null, and malformed collector snapshots without failing the API', async (t) => {
  const thrownDetail = 'collector-private-throw-detail-170';
  const server = await startTestServer(t, {
    managedCollectors: [
      { snapshot() { throw new Error(thrownDetail); } },
      { snapshot() { return null; } },
      { snapshot() { return { provider: 'codex', scope: codexScope(), connection: {}, capabilities: {}, observations: 'invalid' }; } },
    ],
  });

  const response = await request(server.info.port, { path: '/api/state' });
  assert.equal(response.status, 200);
  const snapshot = jsonBody(response);
  assertBaseState(snapshot);
  assert.deepEqual(snapshot.managedCollectors, []);
  assert.equal(response.body.includes(thrownDetail), false);
});

test('HTTP has no managed collector connect, resume, permission, proof, or registration write endpoints', async (t) => {
  const calls = { connect: 0, resume: 0, permission: 0, proof: 0, registration: 0 };
  const server = await startTestServer(t, {
    managedCollectors: [{
      snapshot: () => emptySnapshot('codex'),
      connect() { calls.connect += 1; },
      resumeKnownThread() { calls.resume += 1; },
      answerPermission() { calls.permission += 1; },
      resolveProof() { calls.proof += 1; },
      register() { calls.registration += 1; },
    }],
  });
  const origin = `http://127.0.0.1:${server.info.port}`;
  const writeSecrets = ['request-token-secret-170', 'request-writer-secret-170', 'request-proof-secret-170'];
  const body = JSON.stringify({ token: writeSecrets[0], writer: writeSecrets[1], proof: writeSecrets[2] });
  const routes = [
    ['connect', '/api/managed-collectors/connect'],
    ['resume', '/api/managed-collectors/resume'],
    ['permission', '/api/managed-collectors/permission'],
    ['proof', '/api/managed-collectors/proof'],
    ['registration', '/api/managed-collectors/register'],
  ];

  for (const [, route] of routes) {
    const response = await request(server.info.port, {
      method: 'POST',
      path: route,
      headers: uiHeaders(server.info, origin, { 'content-type': 'application/json' }),
      body,
    });
    assert.equal(response.status, 405, route);
    for (const secret of writeSecrets) assert.equal(response.body.includes(secret), false, route);
  }
  assert.deepEqual(calls, { connect: 0, resume: 0, permission: 0, proof: 0, registration: 0 });
});

function createRealCollector(provider) {
  const nativeIdKind = provider === 'codex' ? 'thread' : 'session';
  const slot = `${provider}-http-slot`;
  return createManagedCollector({
    provider,
    scope: {
      provider,
      nativeIdKind,
      hostId: `${provider}-http-host`,
      homeScopeId: `${provider}-http-home`,
      connectionSlotId: slot,
    },
    expectedHome: path.resolve(os.tmpdir(), 'managed-collector-http-home'),
    transportFactory: async () => { throw new Error('not used by snapshot test'); },
    runtimeAdapter: {
      openConnection() { throw new Error('not used by snapshot test'); },
      disconnect() {},
      checkCurrentProof() { return null; },
      get() { return null; },
    },
    registrationRegistry: { snapshot: () => ({ conversations: [], executions: [] }) },
    runtimeRegistry: { snapshot: () => ({ launches: [] }) },
  });
}

function codexScope() {
  return {
    provider: 'codex',
    nativeIdKind: 'thread',
    hostId: 'host-http-codex',
    homeScopeId: 'home-http-codex',
    connectionSlotId: 'slot-http-codex',
  };
}

function emptySnapshot(provider) {
  const nativeIdKind = provider === 'codex' ? 'thread' : 'session';
  return {
    provider,
    scope: {
      provider,
      nativeIdKind,
      hostId: `${provider}-host`,
      homeScopeId: `${provider}-home`,
      connectionSlotId: `${provider}-slot`,
    },
    connection: { state: 'disconnected', generation: 0, providerVersion: null },
    capabilities: {
      loadedList: 'unsupported', threadRead: 'unsupported', resume: 'unsupported', serverRequests: 'unsupported',
    },
    observations: [],
  };
}

function assertBaseState(snapshot) {
  assert.ok(Array.isArray(snapshot.sessions));
  assert.ok(Array.isArray(snapshot.providerEvents));
  assert.ok(Array.isArray(snapshot.managedCollectors));
}
