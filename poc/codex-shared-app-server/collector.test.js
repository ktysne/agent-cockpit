'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  EXPECTED_THREAD_NAME,
  KNOWN_THREADS,
  PocError,
  READONLY_ALLOWED_METHODS,
  WebSocketJsonRpcClient,
  connectViaTcp,
  connectViaWebSocket,
  collectReadOnlySnapshot,
  projectNotificationMetadata,
  validateCodexHome,
} = require('./collector');

const ROOT_ID = KNOWN_THREADS[0];
const CHILD_ID = KNOWN_THREADS[1];
const FOREIGN_ID = '8b51b7b2-5ce1-4af2-a5a6-801171c27400';

test('WebSocket collector reads only the known thread summaries and omits private fields', async (t) => {
  const fixture = createFixture({ serverRequestCollision: true });
  t.after(() => fixture.close());
  const result = await collectReadOnlySnapshot({
    timeoutMs: 500,
    connect: fixture.connect,
  });

  assert.equal(result.ok, true);
  assert.equal(result.initialized, true);
  assert.equal(result.appServerVersion, '0.160.0');
  assert.equal(result.serverRequestCount, 1);
  assert.equal(result.list.searchedPages, 2);
  assert.equal(result.list.truncated, false);
  assert.deepEqual(result.list.knownMatches.map((thread) => thread.id), [ROOT_ID, CHILD_ID]);
  assert.equal(result.list.knownMatches[0].expectedNameMatches, true);
  assert.equal(result.list.knownMatches[0].status, 'idle');
  assert.equal(result.list.knownMatches[0].sourceKind, 'appServer');
  assert.equal(result.list.knownMatches[1].sourceKind, 'subAgent');
  assert.equal(result.loaded.itemCount, 3);
  assert.deepEqual(result.loaded.knownMatches, [ROOT_ID, CHILD_ID]);
  assert.deepEqual(result.reads.map((thread) => thread.id), [ROOT_ID, CHILD_ID]);
  assert.equal(result.reads[0].turnsReturned, true);
  assert.equal(result.reads[1].parentThreadId, ROOT_ID);
  assert.equal(result.reads[1].expectedNameMatches, true);

  const methods = fixture.requests.map((request) => request.method);
  assert.deepEqual(methods, [
    'initialize',
    'initialized',
    'thread/list',
    'thread/list',
    'thread/loaded/list',
    'thread/read',
    'thread/read',
  ]);
  assert.equal(fixture.requests.filter((request) => request.method === 'thread/list')
    .every((request) => request.params.useStateDbOnly === true
      && request.params.searchTerm === EXPECTED_THREAD_NAME), true);
  assert.equal(fixture.requests.filter((request) => request.method === 'thread/read')
    .every((request) => request.params.includeTurns === false), true);
  assert.equal(fixture.invalidClientFrames, 0);
  assert.ok(fixture.pongCount > 0);

  const output = JSON.stringify(result);
  assert.doesNotMatch(output, /PRIVATE_THREAD_TITLE|PRIVATE_TURN_BODY|FOREIGN_THREAD_TITLE/);
  assert.doesNotMatch(output, new RegExp(FOREIGN_ID));
});

test('initialize-only stops before listing or reading threads', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.close());
  const initializedSeen = fixture.waitForMethod('initialized');
  const result = await collectReadOnlySnapshot({
    initializeOnly: true,
    timeoutMs: 500,
    connect: fixture.connect,
  });
  await initializedSeen;

  assert.deepEqual(result, {
    ok: true,
    transport: 'app-server proxy over WebSocket',
    initialized: true,
    appServerVersion: '0.160.0',
    serverRequestCount: 0,
  });
  assert.deepEqual(fixture.requests.map((request) => request.method), ['initialize', 'initialized']);
});

test('initialize response requires the supported app-server version', async (t) => {
  const fixture = createFixture({
    initializeResult: {
      codexHome: 'C:\\fixture\\codex',
      platformFamily: 'windows',
      platformOs: 'windows',
      userAgent: 'codex_cli/0.159.2',
    },
  });
  t.after(() => fixture.close());
  await assert.rejects(
    collectReadOnlySnapshot({ initializeOnly: true, timeoutMs: 500, connect: fixture.connect }),
    (error) => error.kind === 'unsupported_app_server_version',
  );
});

test('default transport allowlist rejects thread resume', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.close());
  const client = await fixture.connect({ timeoutMs: 500 }).then((connection) => connection.client);
  assert.deepEqual([...client.allowedMethods], READONLY_ALLOWED_METHODS);
  await assert.rejects(
    client.request('thread/resume', { threadId: ROOT_ID }),
    (error) => error.kind === 'method_not_allowed',
  );
  client.close();
});

test('programmatic TCP transport sends only a loopback capability token header', async (t) => {
  const token = 'a'.repeat(64);
  const fixture = createFixture({ expectedAuthorization: token });
  t.after(() => fixture.close());
  const { port } = await fixture.listenAddress();
  const connection = await connectViaTcp({
    host: '127.0.0.1',
    port,
    capabilityToken: token,
    allowedMethods: ['initialize', 'initialized', 'thread/start'],
    timeoutMs: 500,
  });
  t.after(() => connection.close());

  const result = await connection.client.request('initialize', {});

  assert.equal(result.userAgent, 'codex_cli/0.160.0');
  assert.equal(connection.client.allowedMethods.includes('thread/start'), true);
  assert.equal(fixture.authorizationMatched, true);
  assert.equal(fixture.hostHeader, '127.0.0.1:' + port);
  assert.equal(Object.hasOwn(connection.client, 'capabilityToken'), false);
  assert.doesNotMatch(JSON.stringify({ result, allowedMethods: connection.client.allowedMethods }), /a{64}/);
});

test('WebSocket URL helper requires an explicit loopback URL and sends the bearer token', async (t) => {
  const token = 'b'.repeat(64);
  const fixture = createFixture({ expectedAuthorization: token });
  t.after(() => fixture.close());
  const { port } = await fixture.listenAddress();
  const connection = await connectViaWebSocket({
    url: `ws://127.0.0.1:${port}/`,
    authToken: token,
    allowedMethods: ['initialize'],
    timeoutMs: 500,
  });
  t.after(() => connection.close());

  assert.equal((await connection.client.request('initialize', {})).userAgent, 'codex_cli/0.160.0');
  assert.equal(fixture.authorizationMatched, true);
  assert.equal(fixture.hostHeader, '127.0.0.1:' + port);
  assert.equal(Object.hasOwn(connection.client, 'authToken'), false);
});

test('TCP transport rejects missing or malformed capability tokens before connecting', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.close());
  const { port } = await fixture.listenAddress();

  for (const capabilityToken of [undefined, '', 'a'.repeat(63), 'a'.repeat(64) + '\r\n', 'Bearer ' + 'a'.repeat(64)]) {
    await assert.rejects(
      connectViaTcp({ port, capabilityToken }),
      (error) => error.kind === 'invalid_capability_token'
        && error.message === 'invalid_capability_token',
    );
  }
  assert.equal(fixture.connectionCount, 0);
});

test('TCP and WebSocket helpers reject non-loopback destinations before connecting', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.close());
  const { port } = await fixture.listenAddress();
  const token = 'c'.repeat(64);

  await assert.rejects(
    connectViaTcp({ host: 'localhost', port, capabilityToken: token }),
    (error) => error.kind === 'loopback_host_required',
  );
  await assert.rejects(
    connectViaTcp({ host: '127.0.0.2', port, capabilityToken: token }),
    (error) => error.kind === 'loopback_host_required',
  );
  for (const url of [
    `ws://localhost:${port}/`,
    `ws://127.0.0.2:${port}/`,
    `ws://127.1:${port}/`,
    `ws://2130706433:${port}/`,
    `wss://127.0.0.1:${port}/`,
    `ws://user@127.0.0.1:${port}/`,
    `ws://127.0.0.1:${port}/other`,
    `ws://127.0.0.1:${port}/?x=1`,
  ]) {
    await assert.rejects(
      connectViaWebSocket({ url, authToken: token }),
      (error) => error.kind === 'loopback_websocket_url_required',
    );
  }
  assert.equal(fixture.connectionCount, 0);
});

test('notification callbacks receive only allowlisted identifiers and enums', () => {
  const metadata = projectNotificationMetadata({
    threadId: ROOT_ID,
    turn: { id: '3f6b72c3-c68f-4cd0-a470-7e5422143e7b', status: 'inProgress' },
    item: {
      id: 'item_abc-123',
      type: 'mcpToolCall',
      status: 'completed',
      arguments: 'PRIVATE_ARGUMENTS',
    },
    text: 'PRIVATE_NOTIFICATION_BODY',
  });
  assert.deepEqual(metadata, {
    threadId: ROOT_ID,
    turnId: '3f6b72c3-c68f-4cd0-a470-7e5422143e7b',
    itemId: 'item_abc-123',
    itemType: 'mcpToolCall',
    status: 'inProgress',
  });
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE_/);
  assert.deepEqual(projectNotificationMetadata({
    threadId: 'unknown-thread',
    turnId: 'credential-value',
    item: { id: 'token-secret', type: 'unlistedType' },
    status: 'unlistedStatus',
  }), {});
});

test('thread status notifications retain only schema-defined status and active flags', () => {
  const metadata = projectNotificationMetadata({
    threadId: ROOT_ID,
    status: {
      type: 'active',
      activeFlags: ['waitingOnApproval', 'PRIVATE_UNKNOWN_FLAG', 'waitingOnUserInput'],
      privateValue: 'PRIVATE_STATUS_BODY',
    },
    privateValue: 'PRIVATE_NOTIFICATION_BODY',
  }, 'thread/status/changed');

  assert.deepEqual(metadata, {
    threadId: ROOT_ID,
    threadStatus: {
      type: 'active',
      activeFlags: ['waitingOnApproval', 'waitingOnUserInput'],
    },
  });
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE|UNKNOWN_FLAG/);
  assert.deepEqual(projectNotificationMetadata({
    threadId: ROOT_ID,
    status: { type: 'PRIVATE_UNKNOWN_STATUS', activeFlags: ['waitingOnApproval', 'PRIVATE_FLAG'] },
  }, 'thread/status/changed'), { threadId: ROOT_ID });
  assert.deepEqual(projectNotificationMetadata({
    threadId: ROOT_ID,
    status: { type: 'idle', activeFlags: ['waitingOnApproval'] },
  }, 'thread/status/changed'), { threadId: ROOT_ID, threadStatus: { type: 'idle' } });
});

test('serverRequest/resolved retains only a safe request identifier', () => {
  const metadata = projectNotificationMetadata({
    threadId: ROOT_ID,
    requestId: 'req_42-safe',
    rawParams: 'PRIVATE_RESOLUTION_BODY',
  }, 'serverRequest/resolved');

  assert.deepEqual(metadata, { threadId: ROOT_ID, requestId: 'req_42-safe' });
  assert.doesNotMatch(JSON.stringify(metadata), /PRIVATE/);
  assert.deepEqual(projectNotificationMetadata({
    threadId: ROOT_ID,
    requestId: 'Bearer PRIVATE_TOKEN',
  }, 'serverRequest/resolved'), { threadId: ROOT_ID });
  assert.deepEqual(projectNotificationMetadata({
    threadId: ROOT_ID,
    requestId: 'req_42-safe',
  }, 'thread/status/changed'), { threadId: ROOT_ID });
  assert.deepEqual(projectNotificationMetadata({
    threadId: ROOT_ID,
    requestId: 42,
  }, 'serverRequest/resolved'), { threadId: ROOT_ID, requestId: 42 });
  assert.deepEqual(projectNotificationMetadata({
    threadId: ROOT_ID,
    requestId: Number.MAX_SAFE_INTEGER + 1,
  }, 'serverRequest/resolved'), { threadId: ROOT_ID });
});

test('RPC errors retain a safe category and numeric code without the server message', async () => {
  const cases = [
    ['Thread not found: PRIVATE_THREAD_ID', undefined, 'thread_not_found'],
    ['rollout history missing: PRIVATE_PATH', undefined, 'history_missing'],
    ['app-server not initialized: PRIVATE_HINT', undefined, 'not_initialized'],
    ['experimental feature required: PRIVATE_FEATURE', undefined, 'experimental_required'],
    ['PRIVATE_INVALID_PARAMS_BODY', -32602, 'invalid_params'],
    ['permission denied for PRIVATE_USER', undefined, 'permission_denied'],
    ['Thread has not persisted its first turn: PRIVATE_HISTORY', undefined, 'thread_not_persisted'],
    ['Unable to resume: PRIVATE_REASON', undefined, 'resume_unavailable'],
    ['PRIVATE_RPC_ERROR_MESSAGE', undefined, 'unknown'],
  ];

  for (const [rpcErrorMessage, rpcErrorCode, expectedCategory] of cases) {
    const fixture = createFixture({ rpcErrorThreadId: CHILD_ID, rpcErrorMessage, rpcErrorCode });
    const connection = await fixture.connect({ timeoutMs: 500 });
    try {
      await connection.client.request('initialize', {});
      await assert.rejects(
        connection.client.request('thread/read', { threadId: CHILD_ID }),
        (error) => {
          assert.equal(error.kind, 'rpc_error');
          assert.equal(error.rpcErrorCategory, expectedCategory);
          if (rpcErrorCode !== undefined) assert.equal(error.rpcCode, rpcErrorCode);
          assert.doesNotMatch(error.message, /PRIVATE/);
          assert.doesNotMatch(JSON.stringify(error), /PRIVATE/);
          return true;
        },
      );
    } finally {
      connection.close();
      await fixture.close();
    }
  }
});

test('server requests and notifications cannot be mistaken for pending responses', async (t) => {
  const fixture = createFixture({
    serverRequestCollision: true,
    notificationOnInitialize: true,
  });
  t.after(() => fixture.close());
  const notifications = [];
  const serverRequests = [];
  const allowedMethods = ['initialize'];
  const connection = await fixture.connect({
    timeoutMs: 500,
    allowedMethods,
    onNotification: (method, metadata) => notifications.push({ method, metadata }),
    onServerRequest: (request) => serverRequests.push(request),
  });
  allowedMethods.push('thread/resume');
  const result = await connection.client.request('initialize', {});

  assert.equal(result.userAgent, 'codex_cli/0.160.0');
  assert.deepEqual(notifications, [{
    method: 'item/started',
    metadata: {
      threadId: ROOT_ID,
      turnId: '3f6b72c3-c68f-4cd0-a470-7e5422143e7b',
      itemId: 'item_abc-123',
      itemType: 'mcpToolCall',
      status: 'inProgress',
    },
  }]);
  assert.deepEqual(serverRequests, [{ id: 1, method: 'fixture/server-request' }]);
  assert.deepEqual([...connection.client.allowedMethods], ['initialize']);
  await assert.rejects(
    connection.client.request('thread/resume', { threadId: ROOT_ID }),
    (error) => error.kind === 'method_not_allowed',
  );
  assert.doesNotMatch(JSON.stringify({ notifications, serverRequests }), /PRIVATE_/);
  connection.close();
});

test('RPC errors retain only the numeric code', async (t) => {
  const fixture = createFixture({ rpcErrorThreadId: CHILD_ID });
  t.after(() => fixture.close());
  const result = await collectReadOnlySnapshot({
    timeoutMs: 500,
    connect: fixture.connect,
  });
  const child = result.reads.find((thread) => thread.id === CHILD_ID);

  assert.equal(child.found, false);
  assert.equal(child.errorKind, 'rpc_error');
  assert.equal(child.rpcCode, -32004);
  assert.equal(child.rpcErrorCategory, 'unknown');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_RPC_ERROR_MESSAGE/);
});

test('open promptly rejects after a stream failure or close', async () => {
  const failedClient = new WebSocketJsonRpcClient(new PassThrough(), new PassThrough(), { timeoutMs: 30 });
  failedClient.readable.emit('error', new Error('private stream error'));
  const failed = await settleWithin(failedClient.open(), 100);
  assert.equal(failed.status, 'rejected');
  assert.equal(failed.error.kind, 'connection_error');

  const closedClient = new WebSocketJsonRpcClient(new PassThrough(), new PassThrough(), { timeoutMs: 30 });
  closedClient.close();
  const closed = await settleWithin(closedClient.open(), 100);
  assert.equal(closed.status, 'rejected');
  assert.equal(closed.error.kind, 'closed');
});

test('dedicated CODEX_HOME must be an existing nonsymlink directory under poc/out', (t) => {
  const outRoot = path.resolve(__dirname, '../out');
  fs.mkdirSync(outRoot, { recursive: true });
  const home = fs.mkdtempSync(path.join(outRoot, 'collector-home-test-'));
  const link = path.join(outRoot, 'collector-home-link-test-' + process.pid);
  t.after(() => {
    assert.ok(isPathWithin(outRoot, home));
    fs.rmSync(home, { recursive: true, force: true });
    if (fs.existsSync(link)) fs.rmdirSync(link);
  });

  assert.equal(validateCodexHome(home), path.resolve(home));
  assert.throws(() => validateCodexHome(path.join(home, 'missing')), (error) => error.kind === 'codex_home_missing');
  assert.throws(() => validateCodexHome(os.homedir()), (error) => error.kind === 'dedicated_codex_home_required');

  const target = path.join(home, 'nested');
  fs.mkdirSync(target);
  try {
    fs.symlinkSync(target, link, 'junction');
  } catch (error) {
    if (error.code === 'EPERM' || error.code === 'EACCES' || error.code === 'UNKNOWN') {
      t.skip('directory junction creation is unavailable');
      return;
    }
    throw error;
  }
  assert.throws(() => validateCodexHome(link), (error) => error.kind === 'codex_home_symlink');
});

test('WebSocket upgrade rejects an invalid accept value', async (t) => {
  const fixture = createFixture({ invalidAccept: true });
  t.after(() => fixture.close());
  const client = await fixture.openClient();
  await assert.rejects(client.open(), (error) => error.kind === 'handshake_rejected');
  client.close();
});

test('WebSocket frame size limit rejects an oversized server frame', async (t) => {
  const fixture = createFixture({ oversizedFrameAfterUpgrade: true });
  t.after(() => fixture.close());
  const client = await fixture.connect({ timeoutMs: 500 }).then((connection) => connection.client);
  await assert.rejects(
    client.request('initialize', {}),
    (error) => error.kind === 'frame_too_large',
  );
  client.close();
});

test('WebSocket JSON-RPC request times out without a response', async (t) => {
  const fixture = createFixture({ suppressResponses: true });
  t.after(() => fixture.close());
  await assert.rejects(
    collectReadOnlySnapshot({ timeoutMs: 30, connect: fixture.connect }),
    (error) => error.kind === 'request_timeout',
  );
});

test('TCP helper bounds a WebSocket handshake that never completes', async (t) => {
  const fixture = createFixture({ suppressHandshake: true });
  t.after(() => fixture.close());
  const { port } = await fixture.listenAddress();

  await assert.rejects(
    connectViaTcp({ port, capabilityToken: 'd'.repeat(64), timeoutMs: 30 }),
    (error) => error.kind === 'handshake_timeout',
  );
});

function createFixture(options = {}) {
  const requests = [];
  const state = {
    invalidClientFrames: 0,
    pongCount: 0,
    connectionCount: 0,
    authorizationMatched: false,
    hostHeader: null,
    sockets: new Set(),
    requestWaiters: new Map(),
  };
  const server = net.createServer((socket) => {
    state.connectionCount += 1;
    state.sockets.add(socket);
    socket.on('close', () => state.sockets.delete(socket));
    const connection = { socket, buffer: Buffer.alloc(0), upgraded: false, fragments: [] };
    socket.on('data', (chunk) => {
      connection.buffer = connection.buffer.length
        ? Buffer.concat([connection.buffer, chunk])
        : chunk;
      if (!connection.upgraded) performHandshake(connection, options, state);
      if (connection.upgraded) consumeClientFrames(connection, requests, state, options);
    });
  });
  server.listen(0, '127.0.0.1');

  return {
    requests,
    get invalidClientFrames() {
      return state.invalidClientFrames;
    },
    get pongCount() {
      return state.pongCount;
    },
    get connectionCount() {
      return state.connectionCount;
    },
    get authorizationMatched() {
      return state.authorizationMatched;
    },
    get hostHeader() {
      return state.hostHeader;
    },
    listenAddress() {
      return waitForListen(server);
    },
    waitForMethod(method) {
      const existing = requests.find((request) => request.method === method);
      if (existing) return Promise.resolve(existing);
      return new Promise((resolve) => state.requestWaiters.set(method, resolve));
    },
    async connect(clientOptions = {}) {
      const client = await connectClient(server, clientOptions.timeoutMs, clientOptions);
      return { client, close: () => client.close() };
    },
    async openClient(clientOptions = {}) {
      const address = await waitForListen(server);
      const socket = net.connect(address.port, '127.0.0.1');
      await new Promise((resolve, reject) => {
        socket.once('connect', resolve);
        socket.once('error', reject);
      });
      return new WebSocketJsonRpcClient(socket, socket, { timeoutMs: 100, ...clientOptions });
    },
    async close() {
      for (const socket of state.sockets) socket.destroy();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function connectClient(server, timeoutMs, clientOptions = {}) {
  const address = await waitForListen(server);
  const socket = net.connect(address.port, '127.0.0.1');
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const client = new WebSocketJsonRpcClient(socket, socket, { ...clientOptions, timeoutMs });
  await client.open();
  return client;
}

function waitForListen(server) {
  if (server.listening) return Promise.resolve(server.address());
  return new Promise((resolve, reject) => {
    server.once('listening', () => resolve(server.address()));
    server.once('error', reject);
  });
}

function performHandshake(connection, options, state) {
  if (options.suppressHandshake) return;
  const boundary = connection.buffer.indexOf('\r\n\r\n');
  if (boundary < 0) return;
  const request = connection.buffer.subarray(0, boundary).toString('latin1');
  connection.buffer = connection.buffer.subarray(boundary + 4);
  const key = request.match(/Sec-WebSocket-Key:\s*(.+)\r\n/i)?.[1];
  const authorization = request.match(/(?:^|\r\n)Authorization:\s*([^\r\n]*)/i)?.[1];
  state.authorizationMatched = Object.hasOwn(options, 'expectedAuthorization')
    ? authorization === 'Bearer ' + options.expectedAuthorization
    : authorization === undefined;
  state.hostHeader = request.match(/(?:^|\r\n)Host:\s*([^\r\n]*)/i)?.[1] || null;
  if (!request.startsWith('GET / HTTP/1.1\r\n')
    || !/Upgrade:\s*websocket/i.test(request)
    || !key) {
    connection.socket.destroy();
    return;
  }
  const accept = options.invalidAccept
    ? 'invalid'
    : require('node:crypto').createHash('sha1')
      .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
      .digest('base64');
  const response = Buffer.from([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    'Sec-WebSocket-Accept: ' + accept,
    '',
    '',
  ].join('\r\n'));
  connection.upgraded = true;
  connection.socket.write(response.subarray(0, 13));
  setImmediate(() => {
    if (!connection.socket.destroyed) {
      connection.socket.write(response.subarray(13));
      if (options.oversizedFrameAfterUpgrade) {
        const frameHeader = Buffer.alloc(10);
        frameHeader[0] = 0x81;
        frameHeader[1] = 127;
        frameHeader.writeBigUInt64BE(1024n * 1024n + 1n, 2);
        connection.socket.write(frameHeader);
      }
      if (connection.buffer.length) consumeClientFrames(connection, [], { invalidClientFrames: 0, pongCount: 0 }, options);
    }
  });
}

function consumeClientFrames(connection, requests, state, options) {
  while (connection.buffer.length >= 2) {
    const first = connection.buffer[0];
    const second = connection.buffer[1];
    const opcode = first & 0x0F;
    if ((second & 0x80) === 0) {
      state.invalidClientFrames += 1;
      connection.socket.destroy();
      return;
    }
    let length = second & 0x7F;
    let offset = 2;
    if (length === 126) {
      if (connection.buffer.length < 4) return;
      length = connection.buffer.readUInt16BE(2);
      offset = 4;
    } else if (length === 127) {
      if (connection.buffer.length < 10) return;
      const length64 = connection.buffer.readBigUInt64BE(2);
      if (length64 > 1024n * 1024n) {
        connection.socket.destroy();
        return;
      }
      length = Number(length64);
      offset = 10;
    }
    if (connection.buffer.length < offset + 4 + length) return;
    const mask = connection.buffer.subarray(offset, offset + 4);
    offset += 4;
    const payload = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      payload[index] = connection.buffer[offset + index] ^ mask[index & 3];
    }
    connection.buffer = connection.buffer.subarray(offset + length);

    if (opcode === 0xA) {
      state.pongCount += 1;
      continue;
    }
    if (opcode === 0x8) {
      connection.socket.end();
      return;
    }
    if (opcode !== 0x1) {
      state.invalidClientFrames += 1;
      connection.socket.destroy();
      return;
    }
    let message;
    try {
      message = JSON.parse(payload.toString('utf8'));
    } catch {
      connection.socket.destroy();
      return;
    }
    requests.push(message);
    const waitForMethod = state.requestWaiters.get(message.method);
    if (waitForMethod) {
      state.requestWaiters.delete(message.method);
      waitForMethod(message);
    }
    if (message.method === 'initialized' || options.suppressResponses) continue;
    if (message.method === 'thread/read'
      && message.params.threadId === options.rpcErrorThreadId) {
      connection.socket.write(makeServerFrame(0x1, JSON.stringify({
        id: message.id,
        error: {
          code: Number.isInteger(options.rpcErrorCode) ? options.rpcErrorCode : -32004,
          message: typeof options.rpcErrorMessage === 'string'
            ? options.rpcErrorMessage
            : 'PRIVATE_RPC_ERROR_MESSAGE',
        },
      })));
      continue;
    }
    const result = fixtureResult(message, options);
    if (message.method === 'initialize') {
      if (options.serverRequestCollision) {
        connection.socket.write(makeServerFrame(0x1, JSON.stringify({
          id: message.id,
          method: 'fixture/server-request',
          params: { body: 'PRIVATE_SERVER_REQUEST_BODY' },
        })));
      }
      if (options.notificationOnInitialize) {
        connection.socket.write(makeServerFrame(0x1, JSON.stringify({
          method: 'item/started',
          params: {
            threadId: ROOT_ID,
            turn: { id: '3f6b72c3-c68f-4cd0-a470-7e5422143e7b', status: 'inProgress' },
            item: {
              id: 'item_abc-123',
              type: 'mcpToolCall',
              status: 'completed',
              arguments: 'PRIVATE_NOTIFICATION_BODY',
            },
            text: 'PRIVATE_NOTIFICATION_BODY',
          },
        })));
      }
      connection.socket.write(makeServerFrame(0x9, Buffer.from('probe')));
      sendFragmentedJson(connection.socket, { id: message.id, result });
    } else {
      connection.socket.write(makeServerFrame(0x1, JSON.stringify({ id: message.id, result })));
    }
  }
}

function fixtureResult(request, options) {
  if (request.method === 'initialize') {
    return Object.hasOwn(options, 'initializeResult') ? options.initializeResult : {
      codexHome: process.platform === 'win32' ? 'C:\\fixture\\codex' : '/tmp/fixture/codex',
      platformFamily: process.platform === 'win32' ? 'windows' : 'unix',
      platformOs: process.platform === 'win32' ? 'windows' : 'linux',
      userAgent: 'codex_cli/0.160.0',
    };
  }
  if (request.method === 'thread/list') {
    if (request.params.cursor === 'page-2') {
      return {
        data: [thread(CHILD_ID, {
          source: {
            subAgent: {
              parentThreadId: ROOT_ID,
              sessionId: 'f321b495-2f46-4e3c-af40-d00a8eb337d2',
              forkedFromId: ROOT_ID,
            },
          },
        })],
        nextCursor: null,
      };
    }
    return {
      data: [
        thread(ROOT_ID, { source: 'appServer' }),
        thread(FOREIGN_ID, { name: 'FOREIGN_THREAD_TITLE' }),
      ],
      nextCursor: 'page-2',
    };
  }
  if (request.method === 'thread/loaded/list') {
    return { data: [ROOT_ID, CHILD_ID, FOREIGN_ID], nextCursor: null };
  }
  if (request.method === 'thread/read') {
    return {
      thread: thread(request.params.threadId, {
        source: request.params.threadId === CHILD_ID
          ? {
            subAgent: {
              parentThreadId: ROOT_ID,
              sessionId: 'f321b495-2f46-4e3c-af40-d00a8eb337d2',
              forkedFromId: ROOT_ID,
            },
          }
          : 'appServer',
        turns: [{ items: [{ text: 'PRIVATE_TURN_BODY' }] }],
      }),
    };
  }
  return {};
}

function thread(id, overrides = {}) {
  return {
    id,
    name: overrides.name || EXPECTED_THREAD_NAME,
    status: { type: id === CHILD_ID ? 'active' : 'idle' },
    source: 'unknown',
    sessionId: '3f6b72c3-c68f-4cd0-a470-7e5422143e7b',
    parentThreadId: null,
    forkedFromId: null,
    turns: [],
    preview: 'PRIVATE_THREAD_TITLE',
    ...overrides,
  };
}

function sendFragmentedJson(socket, message) {
  const payload = Buffer.from(JSON.stringify(message), 'utf8');
  const splitAt = payload.indexOf(Buffer.from('実')) + 1;
  socket.write(Buffer.concat([
    makeServerFrame(0x1, payload.subarray(0, splitAt), false),
    makeServerFrame(0x0, payload.subarray(splitAt), true),
  ]));
}

function makeServerFrame(opcode, payload, fin = true) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = body.length;
  let header;
  if (length < 126) {
    header = Buffer.from([(fin ? 0x80 : 0) | opcode, length]);
  } else if (length <= 0xFFFF) {
    header = Buffer.alloc(4);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin ? 0x80 : 0) | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  return Buffer.concat([header, body]);
}

function isPathWithin(root, target) {
  const childPath = path.relative(root, target);
  return childPath === '' || (childPath !== '..'
    && !childPath.startsWith('..' + path.sep)
    && !path.isAbsolute(childPath));
}

function settleWithin(promise, timeoutMs) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve({ status: 'timeout' }), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve({ status: 'resolved', value });
      },
      (error) => {
        clearTimeout(timer);
        resolve({ status: 'rejected', error });
      },
    );
  });
}
