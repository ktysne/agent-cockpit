'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const { types } = require('node:util');
const { createOwnedNativeWaitLatch } = require('./owned-native-wait');
const { getOwnedSource } = require('./owned-native-source');

const TOOL_NAME = 'mcp__cockpit_wait__cockpit_wait';
const MAX_CALLS = 128;
const MAX_CANDIDATES = 16;
const MAX_BYTES = 256 * 1024;
const BODY_LIMIT_BYTES = 64 * 1024;
const MATCH_TIMEOUT_MS = 5000;
const WAIT_SOURCES = new WeakMap();

function data(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || types.isProxy(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(descriptors).length !== keys.length) return null;
  const result = {};
  for (const key of keys) {
    const descriptor = descriptors[key];
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, 'value')) return null;
    result[key] = descriptor.value;
  }
  return result;
}
function identifier(value) { return typeof value === 'string' && value.length > 0 && value.length <= 512 && !/[\u0000-\u0020]/.test(value); }
function nonceInput(value) { const input = data(value, ['nonce']); return input && typeof input.nonce === 'string' && /^[0-9a-f]{48}$/.test(input.nonce) ? Object.freeze(input) : null; }
function synchronousTrue(callback) { try { return callback() === true; } catch { return false; } }
function fixedResult(status) { return { content: [{ type: 'text', text: status }], isError: status !== 'released' }; }

function createOwnedNativeMcpWait(sourceCapability, options) {
  if (getOwnedSource(sourceCapability)?.provider !== 'claude' || WAIT_SOURCES.has(sourceCapability) ||
      !options || typeof options.capture !== 'function' || typeof options.onInvalidated !== 'function') throw new TypeError('owned MCP wait configuration invalid');
  const handles = new WeakMap();
  const calls = new Map();
  const nativeIds = new Map();
  const requestIds = new Set();
  const pendingBodies = new Set();
  const listeners = new Set();
  const invalidationListeners = new Set();
  const secret = crypto.randomBytes(32).toString('hex');
  const route = '/' + crypto.randomUUID() + '/mcp';
  let server = null, port = null, initialized = false, invalidated = false, stopped = false;
  let bodyBytes = 0, partialBytes = 0;
  let retainedBytes = 0, candidates = 0, current = null, startPromise = null;

  function notifyInvalidated(entry) {
    for (const listener of [...invalidationListeners]) { try { listener(entry?.handle || null); } catch {} }
  }
  function clearCandidate(entry) {
    if (!entry.candidate) return;
    entry.candidate = false; candidates -= 1; clearTimeout(entry.timer); entry.timer = null;
  }
  function closeEntry(entry) {
    clearCandidate(entry); retainedBytes -= entry.bytes; entry.bytes = 0; entry.latch?.invalidate(); entry.responseOpen = false;
    if (entry.response && !entry.response.writableEnded) entry.response.destroy();
    entry.response = null; entry.native = null; entry.authorization = null; entry.checkCurrent = null; entry.checkFinal = null;
  }
  function invalidate() {
    if (invalidated) return false;
    invalidated = true; partialBytes = 0;
    for (const cancelBody of pendingBodies) cancelBody();
    for (const entry of calls.values()) closeEntry(entry);
    notifyInvalidated(current);
    current = null;
    try { options.onInvalidated(); } catch {}
    return true;
  }
  function entryFor(nonce, bytes) {
    let entry = calls.get(nonce);
    if (entry) {
      if (retainedBytes + bodyBytes + partialBytes + bytes > MAX_BYTES) { invalidate(); return null; }
      retainedBytes += bytes; entry.bytes += bytes; return entry;
    }
    if (invalidated || stopped || calls.size >= MAX_CALLS || candidates >= MAX_CANDIDATES || retainedBytes + bodyBytes + partialBytes + bytes > MAX_BYTES) { invalidate(); return null; }
    entry = { nonce, bytes, candidate: true, native: null, response: null, responseOpen: false, responseFinished: false,
      authorization: null, checkCurrent: null, checkFinal: null, callbackComplete: false, handle: null, latch: null, used: false, sent: false, status: null, timer: null };
    candidates += 1; retainedBytes += bytes; calls.set(nonce, entry);
    entry.timer = setTimeout(invalidate, MATCH_TIMEOUT_MS);
    return entry;
  }
  function privateCurrent(entry) {
    return Boolean(entry && !invalidated && !stopped && current === entry && !entry.used && entry.responseOpen && entry.callbackComplete);
  }
  function checkEntry(entry) {
    if (!privateCurrent(entry) || !synchronousTrue(entry.checkCurrent)) return false;
    const response = entry.response;
    const open = Boolean(response && !response.destroyed && !response.writableEnded && response.socket && !response.socket.destroyed);
    return open && synchronousTrue(entry.checkFinal) && privateCurrent(entry);
  }
  function writeResult(entry, status) {
    if (!['released', 'cancelled', 'deadline'].includes(status)) return false;
    const response = entry.response;
    if (!response) { invalidate(); return false; }
    const line = JSON.stringify({ jsonrpc: '2.0', id: entry.requestId, result: fixedResult(status) });
    const responseEnd = response.end;
    if (typeof responseEnd !== 'function') { invalidate(); return false; }
    const end = responseEnd.bind(response);
    response.statusCode = 200;
    response.setHeader('Content-Type', 'application/json');
    response.setHeader('Content-Length', Buffer.byteLength(line));
    response.setHeader('Cache-Control', 'no-store');
    if (!checkEntry(entry)) { invalidate(); return false; }
    entry.used = true; entry.sent = true; entry.status = status;
    try { end(line); return true; } catch { invalidate(); return false; }
  }
  function match(entry) {
    if (!entry || !entry.native || !entry.response || invalidated || stopped) return;
    if (current || entry.handle || entry.used) { invalidate(); return; }
    let authorization;
    try { authorization = options.capture(entry.native); } catch { invalidate(); return; }
    const captured = data(authorization, ['metadata', 'checkCurrent', 'checkFinal']);
    if (!captured || typeof captured.checkCurrent !== 'function' || typeof captured.checkFinal !== 'function' ||
        !synchronousTrue(captured.checkCurrent) || !synchronousTrue(captured.checkFinal)) { invalidate(); return; }
    entry.authorization = captured; entry.checkCurrent = captured.checkCurrent; entry.checkFinal = captured.checkFinal;
    entry.handle = Object.freeze(Object.create(null)); handles.set(entry.handle, entry);
    current = entry; clearCandidate(entry);
    entry.latch = createOwnedNativeWaitLatch({ onTerminal(status) { writeResult(entry, status); } });
    for (const listener of [...listeners]) {
      try { const result = listener(entry.handle, entry.native); if (result && typeof result.then === 'function') { invalidate(); return; } } catch { invalidate(); return; }
    }
    entry.callbackComplete = true;
    if (!entry.used && !checkEntry(entry)) invalidate();
  }
  const facade = Object.freeze({
    subscribe(callback) { if (typeof callback !== 'function') throw new TypeError('wait listener invalid'); listeners.add(callback); return () => listeners.delete(callback); },
    check(handle) { return checkEntry(handles.get(handle)); },
    settle(handle, status) {
      const entry = handles.get(handle);
      if (!['released', 'cancelled'].includes(status) || !checkEntry(entry)) return false;
      const accepted = status === 'released' ? entry.latch.release(entry.latch.receipt) : entry.latch.cancel(entry.latch.receipt);
      return accepted && entry.sent && !invalidated;
    },
    subscribeInvalidated(callback) { if (typeof callback !== 'function') throw new TypeError('wait listener invalid'); invalidationListeners.add(callback); return () => invalidationListeners.delete(callback); },
  });
  WAIT_SOURCES.set(sourceCapability, facade);

  function respond(response, id, result) {
    const line = JSON.stringify({ jsonrpc: '2.0', id, result });
    response.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(line), 'Cache-Control': 'no-store' }); response.end(line);
  }
  function requestHandler(request, response) {
    const reject = status => { if (!response.headersSent && !response.destroyed) { response.writeHead(status); response.end(); } request.resume(); };
    if (request.headers.host !== `127.0.0.1:${port}` || request.headers.origin !== undefined || request.url !== route) { reject(403); return; }
    const received = typeof request.headers.authorization === 'string' ? Buffer.from(request.headers.authorization) : Buffer.alloc(0);
    const expected = Buffer.from('Bearer ' + secret);
    const authenticated = received.length === expected.length && crypto.timingSafeEqual(received, expected);
    received.fill(0); expected.fill(0);
    if (!authenticated) { reject(401); return; }
    if (request.method === 'GET') { reject(405); return; }
    if (request.method !== 'POST' || !/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) { reject(405); return; }
    if (invalidated || stopped) { reject(503); return; }
    let chunks = [], size = 0, reservedBytes = 0, reading = true, rejected = false, entry = null;
    const releaseBody = () => { bodyBytes -= reservedBytes; reservedBytes = 0; chunks = []; reading = false; pendingBodies.delete(cancelBody); };
    const cancelBody = () => { rejected = true; clearTimeout(timer); releaseBody(); request.destroy(); response.destroy(); };
    const timer = setTimeout(() => { rejected = true; releaseBody(); reject(408); invalidate(); }, MATCH_TIMEOUT_MS);
    pendingBodies.add(cancelBody);
    const lost = () => { const lostBody = reading && !rejected; clearTimeout(timer); releaseBody(); if (lostBody || entry && entry.responseOpen && !entry.responseFinished) invalidate(); };
    request.on('error', lost); response.on('close', lost); response.on('error', lost);
    request.on('data', chunk => {
      if (rejected || invalidated || stopped) { rejected = true; releaseBody(); return; }
      size += chunk.length;
      if (size > BODY_LIMIT_BYTES || retainedBytes + bodyBytes + partialBytes + chunk.length > MAX_BYTES) { rejected = true; releaseBody(); clearTimeout(timer); reject(413); invalidate(); return; }
      bodyBytes += chunk.length; reservedBytes += chunk.length; chunks.push(chunk);
    });
    request.on('end', () => {
      clearTimeout(timer); if (rejected) return;
      try {
        const text = Buffer.concat(chunks).toString('utf8'); releaseBody();
        const body = JSON.parse(text);
        if (!body || Array.isArray(body) || body.jsonrpc !== '2.0' || typeof body.method !== 'string') throw new Error();
        if (body.method === 'notifications/initialized' && !Object.hasOwn(body, 'id') && initialized) { response.writeHead(202); response.end(); return; }
        if (!(identifier(body.id) || Number.isSafeInteger(body.id) && body.id >= 0)) throw new Error();
        if (body.method === 'initialize') {
          if (initialized || typeof body.params?.protocolVersion !== 'string') throw new Error();
          initialized = true;
          const supported = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
          respond(response, body.id, { protocolVersion: supported.includes(body.params.protocolVersion) ? body.params.protocolVersion : '2025-11-25', capabilities: { tools: {} }, serverInfo: { name: 'cockpit-wait', version: '1' } }); return;
        }
        if (!initialized) throw new Error();
        if (body.method === 'ping') { respond(response, body.id, {}); return; }
        if (body.method === 'tools/list') {
          respond(response, body.id, { tools: [{ name: 'cockpit_wait', description: 'Wait for the trusted host to resume this task.', inputSchema: { type: 'object', properties: { nonce: { type: 'string', pattern: '^[0-9a-f]{48}$' } }, required: ['nonce'], additionalProperties: false } }] }); return;
        }
        if (body.method !== 'tools/call' || body.params?.name !== 'cockpit_wait') throw new Error();
        const input = nonceInput(body.params.arguments); if (!input) throw new Error();
        const requestKey = JSON.stringify([typeof body.id, body.id]);
        if (requestIds.has(requestKey) || requestIds.size >= MAX_CALLS) throw new Error();
        requestIds.add(requestKey);
        entry = entryFor(input.nonce, size);
        if (!entry || entry.response || entry.used) throw new Error();
        entry.requestId = body.id; entry.response = response; entry.responseOpen = true;
        response.on('finish', () => { entry.responseFinished = true; entry.responseOpen = false; });
        match(entry);
      } catch { releaseBody(); reject(400); invalidate(); }
    });
  }
  const controller = Object.freeze({
    start() {
      if (startPromise) return startPromise;
      if (invalidated || stopped) return Promise.reject(new Error('owned wait unavailable'));
      server = http.createServer({ maxHeaderSize: 8192 }, requestHandler);
      server.maxConnections = 8; server.headersTimeout = MATCH_TIMEOUT_MS; server.requestTimeout = MATCH_TIMEOUT_MS;
      server.keepAliveTimeout = MATCH_TIMEOUT_MS;
      server.on('clientError', (_, socket) => socket.destroy()); server.on('error', invalidate);
      startPromise = new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
          port = server.address().port;
          resolve(Object.freeze({ secret, mcpConfig: JSON.stringify({ mcpServers: { cockpit_wait: { type: 'http', url: `http://127.0.0.1:${port}${route}`, headers: { Authorization: 'Bearer ${COCKPIT_NATIVE_MCP_SECRET}' } } } }) }));
        });
      });
      return startPromise;
    },
    reservePartial(bytes) {
      if (!Number.isSafeInteger(bytes) || bytes < 0 || invalidated || stopped || retainedBytes + bodyBytes + partialBytes + bytes > MAX_BYTES) { invalidate(); return false; }
      partialBytes += bytes; return true;
    },
    clearPartial() { partialBytes = 0; },
    observeNative(value) {
      const native = data(value, ['sessionId', 'nativeContextId', 'nativeToolUseId', 'inputEpoch', 'input']);
      const input = native && nonceInput(native.input);
      if (!native || !input || !identifier(native.sessionId) || !identifier(native.nativeContextId) || !identifier(native.nativeToolUseId) ||
          !Number.isSafeInteger(native.inputEpoch) || native.inputEpoch < 1 || invalidated || stopped) { invalidate(); return false; }
      if (nativeIds.has(native.nativeToolUseId) || nativeIds.size >= MAX_CALLS) { invalidate(); return false; }
      nativeIds.set(native.nativeToolUseId, input.nonce);
      const entry = entryFor(input.nonce, Buffer.byteLength(JSON.stringify(native)));
      if (!entry || entry.native || entry.used) { invalidate(); return false; }
      entry.native = Object.freeze({ ...native, input }); match(entry); return !invalidated;
    },
    inspectSent(handle) {
      const entry = handles.get(handle);
      const matches = () => entry && !invalidated && !stopped && current === entry && entry.sent && entry.native && entry.authorization;
      if (!matches() || !synchronousTrue(entry.checkFinal) || !matches()) return null;
      return Object.freeze({ native: entry.native, status: entry.status, result: Object.freeze({ type: 'text', text: entry.status }) });
    },
    consumeSent(handle) {
      const entry = handles.get(handle);
      if (!controller.inspectSent(handle)) return false;
      current = null; closeEntry(entry); return true;
    },
    endInput() {
      for (const entry of calls.values()) if (entry.response || entry.candidate) closeEntry(entry);
      notifyInvalidated(current); current = null;
    },
    isListening() { return server?.listening === true; },
    invalidate,
    async stop() {
      if (stopped) return;
      stopped = true; invalidate();
      if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(() => resolve())); }
      listeners.clear(); invalidationListeners.clear();
    },
  });
  return Object.freeze({ facade, controller });
}
function getOwnedNativeMcpWait(sourceCapability) { return WAIT_SOURCES.get(sourceCapability) || null; }
module.exports = { createOwnedNativeMcpWait, getOwnedNativeMcpWait, TOOL_NAME };
