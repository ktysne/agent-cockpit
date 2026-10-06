'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const net = require('node:net');
const test = require('node:test');
const { createCodexManagedTransport } = require('../src/server/codex-managed-transport');

const TOKEN = 'a'.repeat(64);
const THREAD_ID = '00000000-0000-4000-8000-000000000170';
const TURN_ID = '00000000-0000-4000-8000-000000000171';
const ITEM_ID = 'item_170';

test('managed transport authenticates loopback WebSocket and restricts outbound RPC', async (t) => {
  const fixture = await createWebSocketFixture({ token: TOKEN });
  t.after(() => fixture.close());
  let disconnectCount = 0;
  const transport = await createCodexManagedTransport({
    endpoint: fixture.endpoint,
    capabilityToken: TOKEN,
    onNotification() {},
    onServerRequest() {},
    onDisconnect() { disconnectCount += 1; },
  });

  const initialize = await transport.request('initialize', {
    clientInfo: { name: 'agent-cockpit-test', version: '1' },
    capabilities: { experimentalApi: false },
  });
  assert.equal(initialize.codexHome, 'C:\\managed\\codex');
  await transport.notify('initialized', {});
  assert.deepEqual(await transport.request('thread/loaded/list', { limit: 100 }), { data: [THREAD_ID] });
  await transport.resumeLoadedThread(THREAD_ID);

  assert.deepEqual(fixture.requests.map(({ method }) => method), [
    'initialize', 'initialized', 'thread/loaded/list', 'thread/loaded/list', 'thread/resume',
  ]);
  assert.deepEqual(fixture.requests.at(-1).params, { threadId: THREAD_ID });
  await assert.rejects(
    transport.request('turn/start', { threadId: THREAD_ID }),
    (error) => error.code === 'method_not_allowed',
  );
  await assert.rejects(
    transport.request('thread/read', { threadId: THREAD_ID, includeTurns: true }),
    (error) => error.code === 'invalid_request_params',
  );
  await transport.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(disconnectCount, 1);
  assert.equal(fixture.authorizationHeaders.every((value) => value === `Bearer ${TOKEN}`), true);
});

test('managed transport rejects non-loopback endpoints before connecting', async () => {
  let disconnectCount = 0;
  await assert.rejects(
    createCodexManagedTransport({
      endpoint: 'ws://0.0.0.0:9876',
      capabilityToken: TOKEN,
      onNotification() {},
      onServerRequest() {},
      onDisconnect() { disconnectCount += 1; },
    }),
    (error) => error.code === 'loopback_endpoint_required',
  );
  assert.equal(disconnectCount, 0);
});

test('wrong bearer is rejected without exposing it and notifies disconnect once', async (t) => {
  const fixture = await createWebSocketFixture({ token: TOKEN });
  t.after(() => fixture.close());
  const wrongToken = 'b'.repeat(64);
  let disconnectCount = 0;
  await assert.rejects(
    createCodexManagedTransport({
      endpoint: fixture.endpoint,
      capabilityToken: wrongToken,
      onNotification() {},
      onServerRequest() {},
      onDisconnect() { disconnectCount += 1; },
      timeoutMs: 500,
    }),
    (error) => error.code === 'handshake_rejected' && !error.message.includes(wrongToken),
  );
  assert.equal(disconnectCount, 1);
  assert.deepEqual(fixture.authorizationHeaders, [`Bearer ${wrongToken}`]);
});

test('notifications preserve internal params while server requests expose only identifiers and receive no reply', async (t) => {
  const fixture = await createWebSocketFixture({
    token: TOKEN,
    afterInitialized(socket) {
      writeServerMessage(socket, {
        method: 'item/started',
        params: { threadId: THREAD_ID, turnId: TURN_ID, command: 'private prompt' },
      });
      writeServerMessage(socket, {
        id: 'server_req_1',
        method: 'item/commandExecution/requestApproval',
        params: {
          threadId: THREAD_ID,
          turnId: TURN_ID,
          itemId: ITEM_ID,
          command: 'private command',
          question: 'private question',
        },
      });
    },
  });
  t.after(() => fixture.close());
  const notifications = [];
  const serverRequests = [];
  const transport = await createCodexManagedTransport({
    endpoint: fixture.endpoint,
    capabilityToken: TOKEN,
    onNotification(method, params) { notifications.push({ method, params }); },
    onServerRequest(request) { serverRequests.push(request); },
    onDisconnect() {},
  });
  await transport.request('initialize', { clientInfo: { name: 'test' }, capabilities: {} });
  await transport.notify('initialized', {});
  await fixture.waitFor(() => notifications.length === 1 && serverRequests.length === 1);

  assert.deepEqual(notifications, [{
    method: 'item/started',
    params: { threadId: THREAD_ID, turnId: TURN_ID, command: 'private prompt' },
  }]);
  assert.deepEqual(serverRequests, [{
    id: 'server_req_1',
    method: 'item/commandExecution/requestApproval',
    params: { threadId: THREAD_ID, turnId: TURN_ID, itemId: ITEM_ID },
  }]);
  assert.equal(fixture.requests.some((message) => message.id === 'server_req_1'), false);
  await transport.close();
});

test('closing a connection rejects pending requests and invokes disconnect once', async (t) => {
  const fixture = await createWebSocketFixture({
    token: TOKEN,
    respond(method) {
      if (method === 'thread/list') return null;
      return undefined;
    },
  });
  t.after(() => fixture.close());
  let disconnectCount = 0;
  const transport = await createCodexManagedTransport({
    endpoint: fixture.endpoint,
    capabilityToken: TOKEN,
    onNotification() {},
    onServerRequest() {},
    onDisconnect() { disconnectCount += 1; },
    timeoutMs: 1000,
  });
  await transport.request('initialize', { clientInfo: { name: 'test' }, capabilities: {} });
  await transport.notify('initialized', {});
  const pending = transport.request('thread/list', {});
  await fixture.waitFor(() => fixture.requests.some((request) => request.method === 'thread/list'));
  fixture.closeConnections();
  await assert.rejects(pending, (error) => error.code === 'connection_closed');
  assert.equal(transport.snapshot().pendingRequestCount, 0);
  await transport.close();
  assert.equal(disconnectCount, 1);
});

test('loaded-thread confirmation is required before resume', async (t) => {
  const fixture = await createWebSocketFixture({
    token: TOKEN,
    loadedPages: [
      { data: ['another-thread'], nextCursor: 'cursor-1' },
      { data: [THREAD_ID] },
    ],
  });
  t.after(() => fixture.close());
  const transport = await createCodexManagedTransport({
    endpoint: fixture.endpoint,
    capabilityToken: TOKEN,
    onNotification() {},
    onServerRequest() {},
    onDisconnect() {},
  });
  await transport.request('initialize', { clientInfo: { name: 'test' }, capabilities: {} });
  await transport.notify('initialized', {});
  assert.equal(await transport.confirmLoadedThread(THREAD_ID), true);
  await transport.resumeLoadedThread(THREAD_ID);
  assert.deepEqual(fixture.requests.filter((request) => request.method === 'thread/loaded/list').map((request) => request.params), [
    { limit: 100 }, { limit: 100, cursor: 'cursor-1' },
    { limit: 100 }, { limit: 100, cursor: 'cursor-1' },
  ]);
  await transport.close();
});

async function createWebSocketFixture(options) {
  const sockets = new Set();
  const requests = [];
  const authorizationHeaders = [];
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    let buffer = Buffer.alloc(0);
    let upgraded = false;
    socket.on('data', (chunk) => {
      buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
      if (!upgraded) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        const headersText = buffer.subarray(0, end).toString('latin1');
        buffer = buffer.subarray(end + 4);
        const headers = Object.create(null);
        for (const line of headersText.split('\r\n').slice(1)) {
          const colon = line.indexOf(':');
          if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
        }
        authorizationHeaders.push(headers.authorization);
        if (headers.authorization !== `Bearer ${options.token}`) {
          socket.end('HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        const key = headers['sec-websocket-key'];
        const accept = createHash('sha1')
          .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest('base64');
        socket.write([
          'HTTP/1.1 101 Switching Protocols',
          'Upgrade: websocket',
          'Connection: Upgrade',
          `Sec-WebSocket-Accept: ${accept}`,
          '',
          '',
        ].join('\r\n'));
        upgraded = true;
      }
      if (!upgraded) return;
      while (true) {
        const frame = takeClientFrame(buffer);
        if (!frame) return;
        buffer = buffer.subarray(frame.bytesConsumed);
        if (frame.opcode !== 0x1) continue;
        let message;
        try { message = JSON.parse(frame.payload.toString('utf8')); } catch { continue; }
        requests.push(message);
        if (!Object.hasOwn(message, 'id')) {
          if (message.method === 'initialized' && options.afterInitialized) options.afterInitialized(socket);
          continue;
        }
        const configured = options.respond && options.respond(message.method, message.params);
        if (configured === null) continue;
        let result;
        if (message.method === 'initialize') result = { codexHome: 'C:\\managed\\codex', userAgent: 'codex_cli/0.160.1' };
        else if (message.method === 'thread/loaded/list') {
          const pages = options.loadedPages || [{ data: [THREAD_ID] }];
          const pageIndex = message.params && message.params.cursor ? 1 : 0;
          result = pages[Math.min(pageIndex, pages.length - 1)];
        } else if (message.method === 'thread/resume') result = { thread: { id: message.params.threadId } };
        else result = { data: [] };
        if (configured === undefined) writeServerMessage(socket, { id: message.id, result });
        else if (configured !== null) writeServerMessage(socket, { id: message.id, result: configured });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  return {
    endpoint: `ws://127.0.0.1:${address.port}`,
    requests,
    authorizationHeaders,
    waitFor(predicate) {
      const start = Date.now();
      return new Promise((resolve, reject) => {
        const poll = () => {
          if (predicate()) return resolve();
          if (Date.now() - start > 500) return reject(new Error('fixture timeout'));
          setTimeout(poll, 5);
        };
        poll();
      });
    },
    closeConnections() { for (const socket of sockets) socket.destroy(); },
    async close() {
      this.closeConnections();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

function takeClientFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  if ((second & 0x80) === 0) throw new Error('client frame must be masked');
  let length = second & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < 4) return null;
    length = buffer.readUInt16BE(2);
    offset = 4;
  } else if (length === 127) {
    if (buffer.length < 10) return null;
    const wideLength = buffer.readBigUInt64BE(2);
    if (wideLength > 1024n * 1024n) throw new Error('fixture frame too large');
    length = Number(wideLength);
    offset = 10;
  }
  if (buffer.length < offset + 4 + length) return null;
  const mask = buffer.subarray(offset, offset + 4);
  const payload = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) payload[index] = buffer[offset + 4 + index] ^ mask[index & 3];
  return { opcode: first & 0x0f, payload, bytesConsumed: offset + 4 + length };
}

function writeServerMessage(socket, value) {
  const body = Buffer.from(JSON.stringify(value), 'utf8');
  let header;
  if (body.length < 126) header = Buffer.from([0x81, body.length]);
  else if (body.length <= 0xffff) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    throw new Error('fixture response too large');
  }
  socket.write(Buffer.concat([header, body]));
}
