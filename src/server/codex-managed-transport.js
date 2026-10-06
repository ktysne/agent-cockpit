'use strict';

const { createHash, randomBytes } = require('node:crypto');
const net = require('node:net');
const { TextDecoder } = require('node:util');

const WEBSOCKET_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_HTTP_HEADER_BYTES = 16 * 1024;
const MAX_MESSAGE_BYTES = 1024 * 1024;
const MAX_RECEIVE_BUFFER_BYTES = MAX_MESSAGE_BYTES + MAX_HTTP_HEADER_BYTES + 64;
const MAX_FRAGMENT_COUNT = 1024;
const MAX_PENDING_REQUESTS = 128;
const MAX_LOADED_PAGES = 10;
const MAX_IDENTIFIER_LENGTH = 512;
const REQUEST_METHODS = new Set(['initialize', 'thread/list', 'thread/loaded/list', 'thread/read']);
const IDENTIFICATION_FIELDS = Object.freeze([
  'threadId', 'turnId', 'requestId', 'conversationId', 'executionId',
  'itemId', 'eventId', 'event_id', 'nativeEventId', 'sequenceNumber', 'sequence_number',
]);

class ManagedTransportError extends Error {
  constructor(code) {
    super('managed Codex transport operation failed');
    this.name = 'ManagedTransportError';
    this.code = code;
  }
}

function transportError(code) {
  return new ManagedTransportError(code);
}

function parseLoopbackEndpoint(endpoint) {
  if (typeof endpoint !== 'string' || endpoint.length > 512) {
    throw transportError('loopback_endpoint_required');
  }
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw transportError('loopback_endpoint_required');
  }
  const port = Number(url.port);
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1' ||
      !Number.isInteger(port) || port < 1 || port > 65535 ||
      (url.pathname !== '' && url.pathname !== '/') || url.username || url.password || url.search || url.hash) {
    throw transportError('loopback_endpoint_required');
  }
  return { port, hostHeader: `127.0.0.1:${port}` };
}

function validateCapabilityToken(token) {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
    throw transportError('invalid_capability_token');
  }
  return token;
}

function normalizeTimeout(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 50 || value > 60_000) {
    throw transportError('invalid_timeout');
  }
  return value;
}

function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isIdentifier(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_IDENTIFIER_LENGTH &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value) && !value.startsWith('-');
}

function responseKey(id) {
  return `${typeof id}:${String(id)}`;
}

function safeRpcId(value) {
  if (Number.isSafeInteger(value)) return value;
  if (typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value)) return value;
  return null;
}

function safeMethodName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,128}$/.test(value) ? value : 'unknown';
}

function minimalServerRequestParams(value) {
  if (!isRecord(value)) return {};
  const result = {};
  for (const key of IDENTIFICATION_FIELDS) {
    const field = value[key];
    if (isIdentifier(field)) result[key] = field;
    else if (Number.isSafeInteger(field) && field >= 0) result[key] = field;
  }
  return result;
}

function isThenable(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false;
  let then;
  try { then = value.then; } catch { return true; }
  if (typeof then !== 'function') return false;
  try { Promise.resolve(value).catch(() => {}); } catch {}
  return true;
}

function parseHttpHeaders(headerText) {
  const lines = headerText.split('\r\n');
  const status = lines.shift();
  if (!status || !/^HTTP\/1\.1 [0-9]{3}(?: |$)/.test(status)) throw transportError('handshake_invalid');
  const headers = Object.create(null);
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw transportError('handshake_invalid');
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? `${headers[name]}, ${value}` : value;
  }
  return { status, headers };
}

function takeServerFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = Boolean(first & 0x80);
  const opcode = first & 0x0f;
  if ((first & 0x70) !== 0 || (second & 0x80) !== 0) throw transportError('invalid_server_frame');
  let payloadLength = second & 0x7f;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    const wideLength = buffer.readBigUInt64BE(2);
    if (wideLength > BigInt(MAX_MESSAGE_BYTES)) throw transportError('frame_too_large');
    payloadLength = Number(wideLength);
    offset = 10;
  }
  const isControl = opcode >= 0x8;
  if ((isControl && (!fin || payloadLength > 125)) || payloadLength > MAX_MESSAGE_BYTES ||
      ![0x0, 0x1, 0x2, 0x8, 0x9, 0xa].includes(opcode)) {
    throw transportError('invalid_server_frame');
  }
  if (buffer.length < offset + payloadLength) return null;
  return { fin, opcode, payload: buffer.subarray(offset, offset + payloadLength), bytesConsumed: offset + payloadLength };
}

function makeClientFrame(opcode, payload, randomBytesImpl = randomBytes) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  if (body.length > MAX_MESSAGE_BYTES) throw transportError('frame_too_large');
  const extendedBytes = body.length < 126 ? 0 : body.length <= 0xffff ? 2 : 8;
  const header = Buffer.alloc(2 + extendedBytes + 4);
  header[0] = 0x80 | opcode;
  if (extendedBytes === 0) header[1] = 0x80 | body.length;
  else if (extendedBytes === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(body.length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(body.length), 2);
  }
  const maskOffset = 2 + extendedBytes;
  const mask = randomBytesImpl(4);
  mask.copy(header, maskOffset);
  const masked = Buffer.allocUnsafe(body.length);
  for (let index = 0; index < body.length; index += 1) masked[index] = body[index] ^ mask[index & 3];
  return Buffer.concat([header, masked]);
}

function connectLoopback(port, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    let settled = false;
    const timer = setTimeout(() => finish(transportError('connect_timeout')), timeoutMs);
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
      if (error) {
        socket.destroy();
        reject(error);
      } else {
        socket.setNoDelay(true);
        resolve(socket);
      }
    }
    const onConnect = () => finish(null);
    const onError = () => finish(transportError('connection_failed'));
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

class WebSocketJsonRpcTransport {
  #capabilityToken;

  constructor(socket, options) {
    this.socket = socket;
    this.timeoutMs = options.timeoutMs;
    this.randomBytes = options.randomBytes || randomBytes;
    this.#capabilityToken = options.capabilityToken;
    this.onNotification = options.onNotification;
    this.onServerRequest = options.onServerRequest;
    this.onDisconnect = options.onDisconnect;
    this.rxBuffer = Buffer.alloc(0);
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.pending = new Map();
    this.nextId = 1;
    this.opened = false;
    this.closed = false;
    this.failureCode = null;
    this.openTimer = null;
    this.openResolve = null;
    this.openReject = null;
    this.initialized = false;
    this.announcedInitialized = false;
    this.disconnectNotified = false;
    this.loadedConfirmations = new Set();
    this.notificationCount = 0;
    this.serverRequestCount = 0;

    socket.on('data', (chunk) => this.onData(chunk));
    socket.once('end', () => this.fail('connection_closed'));
    socket.once('close', () => this.fail('connection_closed'));
    socket.on('error', () => this.fail('connection_failed'));
  }

  async open(hostHeader, port) {
    if (this.closed) return Promise.reject(transportError(this.failureCode || 'connection_closed'));
    const key = this.randomBytes(16).toString('base64');
    const acceptValue = createHash('sha1').update(key + WEBSOCKET_GUID).digest('base64');
    const request = [
      'GET / HTTP/1.1',
      `Host: ${hostHeader}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      `Authorization: Bearer ${this.#capabilityToken}`,
      '',
      '',
    ].join('\r\n');

    return new Promise((resolve, reject) => {
      this.openResolve = resolve;
      this.openReject = reject;
      this.expectedAcceptValue = acceptValue;
      this.openTimer = setTimeout(() => this.fail('handshake_timeout'), this.timeoutMs);
      try {
        this.socket.write(request, (error) => {
          if (error) this.fail('connection_failed');
        });
      } catch {
        this.fail('connection_failed');
      }
      if (this.failureCode) this.fail(this.failureCode);
    });
  }

  get closedState() {
    return this.closed;
  }

  get safeSnapshot() {
    return Object.freeze({
      state: this.closed ? 'closed' : this.opened ? 'open' : 'connecting',
      pendingRequestCount: this.pending.size,
      notificationCount: this.notificationCount,
      serverRequestCount: this.serverRequestCount,
    });
  }

  async request(method, params = {}) {
    if (!REQUEST_METHODS.has(method) || method === 'thread/resume') throw transportError('method_not_allowed');
    this.assertReadyFor(method);
    this.validateRequestParams(method, params);
    const result = await this.sendRequest(method, params);
    if (method === 'initialize') this.initialized = true;
    if (method === 'thread/loaded/list') this.recordLoadedPage(result);
    return result;
  }

  async notify(method, params = {}) {
    if (method !== 'initialized') throw transportError('method_not_allowed');
    if (!this.opened || this.closed || !this.initialized || this.announcedInitialized) {
      throw transportError('transport_not_ready');
    }
    this.validateParams(params);
    await this.sendJson({ method, params });
    this.announcedInitialized = true;
  }

  async confirmLoadedThread(threadId) {
    if (!isIdentifier(threadId)) throw transportError('invalid_thread_id');
    this.assertReadyFor('thread/loaded/list');
    let cursor;
    const seenCursors = new Set();
    for (let page = 0; page < MAX_LOADED_PAGES; page += 1) {
      const params = { limit: 100 };
      if (cursor) params.cursor = cursor;
      const result = await this.request('thread/loaded/list', params);
      if (!isRecord(result) || !Array.isArray(result.data) ||
          result.data.some((id) => typeof id !== 'string' || !isIdentifier(id))) {
        throw transportError('invalid_loaded_response');
      }
      if (result.data.includes(threadId)) {
        this.loadedConfirmations.add(threadId);
        return true;
      }
      if (typeof result.nextCursor !== 'string' || result.nextCursor.length === 0) return false;
      if (result.nextCursor.length > 2048 || /[\u0000-\u001f\u007f]/.test(result.nextCursor) || seenCursors.has(result.nextCursor)) {
        throw transportError('invalid_loaded_response');
      }
      seenCursors.add(result.nextCursor);
      cursor = result.nextCursor;
    }
    throw transportError('loaded_scan_limit');
  }

  async resumeLoadedThread(threadId, isStillVerified) {
    if (typeof isStillVerified !== 'function') throw transportError('resume_proof_check_required');
    if (!await this.confirmLoadedThread(threadId)) throw transportError('thread_not_loaded');
    let verified;
    try { verified = isStillVerified(); } catch { throw transportError('resume_proof_unverified'); }
    if (isThenable(verified) || verified !== true) throw transportError('resume_proof_unverified');
    return this.sendRequest('thread/resume', { threadId });
  }

  close() {
    if (this.closed) return;
    if (this.opened) this.writeControlFrame(0x8, Buffer.from([0x03, 0xe8]));
    this.fail('closed');
  }

  assertReadyFor(method) {
    if (this.closed) throw transportError(this.failureCode || 'connection_closed');
    if (!this.opened) throw transportError('connection_not_open');
    if (method !== 'initialize' && !this.announcedInitialized) throw transportError('transport_not_ready');
    if (method === 'initialize' && this.initialized) throw transportError('already_initialized');
  }

  validateRequestParams(method, params) {
    this.validateParams(params);
    if (method === 'thread/list') {
      const allowed = new Set(['cursor', 'limit', 'searchTerm', 'useStateDbOnly']);
      if (Object.keys(params).some((key) => !allowed.has(key)) ||
          (params.cursor !== undefined && (typeof params.cursor !== 'string' || params.cursor.length > 2048)) ||
          (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100)) ||
          (params.searchTerm !== undefined && (typeof params.searchTerm !== 'string' || params.searchTerm.length > 256)) ||
          (params.useStateDbOnly !== undefined && typeof params.useStateDbOnly !== 'boolean')) {
        throw transportError('invalid_request_params');
      }
    }
    if (method === 'thread/loaded/list') {
      const allowed = new Set(['cursor', 'limit']);
      if (Object.keys(params).some((key) => !allowed.has(key)) ||
          (params.cursor !== undefined && (typeof params.cursor !== 'string' || params.cursor.length > 2048)) ||
          (params.limit !== undefined && (!Number.isInteger(params.limit) || params.limit < 1 || params.limit > 100))) {
        throw transportError('invalid_request_params');
      }
    }
    if (method === 'thread/read' && (!isIdentifier(params.threadId) || params.includeTurns !== false ||
        Object.keys(params).some((key) => !['threadId', 'includeTurns'].includes(key)))) {
      throw transportError('invalid_request_params');
    }
    if (method === 'initialize' && Object.keys(params).some((key) => !['clientInfo', 'capabilities'].includes(key))) {
      throw transportError('invalid_request_params');
    }
  }

  validateParams(params) {
    if (!isRecord(params)) throw transportError('invalid_request_params');
    let serialized;
    try {
      serialized = JSON.stringify(params);
    } catch {
      throw transportError('invalid_request_params');
    }
    if (typeof serialized !== 'string' || Buffer.byteLength(serialized, 'utf8') > MAX_MESSAGE_BYTES) {
      throw transportError('request_too_large');
    }
  }

  recordLoadedPage(result) {
    if (!isRecord(result) || !Array.isArray(result.data) ||
        result.data.some((id) => typeof id !== 'string' || !isIdentifier(id))) {
      throw transportError('invalid_loaded_response');
    }
    for (const id of result.data) this.loadedConfirmations.add(id);
  }

  async sendRequest(method, params) {
    if (this.pending.size >= MAX_PENDING_REQUESTS) throw transportError('pending_request_limit');
    const id = this.nextId++;
    const key = responseKey(id);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.settle(key, transportError('request_timeout'));
      }, this.timeoutMs);
      this.pending.set(key, { resolve, reject, timer });
      this.sendJson({ id, method, params }).catch(() => this.settle(key, transportError('connection_failed')));
    });
  }

  async sendJson(value) {
    if (this.closed) throw transportError(this.failureCode || 'connection_closed');
    let body;
    try {
      body = Buffer.from(JSON.stringify(value), 'utf8');
    } catch {
      throw transportError('invalid_request_params');
    }
    if (body.length > MAX_MESSAGE_BYTES) throw transportError('request_too_large');
    await new Promise((resolve, reject) => {
      try {
        this.socket.write(makeClientFrame(0x1, body, this.randomBytes), (error) => {
          if (error) reject(transportError('connection_failed'));
          else resolve();
        });
      } catch {
        reject(transportError('connection_failed'));
      }
    });
  }

  onData(chunk) {
    if (this.closed) return;
    const input = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (this.rxBuffer.length + input.length > MAX_RECEIVE_BUFFER_BYTES) {
      this.fail('receive_buffer_limit');
      return;
    }
    this.rxBuffer = this.rxBuffer.length ? Buffer.concat([this.rxBuffer, input]) : input;
    if (!this.opened) this.consumeHandshake();
    if (this.opened && !this.closed) this.consumeFrames();
  }

  consumeHandshake() {
    const boundary = this.rxBuffer.indexOf('\r\n\r\n');
    if (boundary < 0) {
      if (this.rxBuffer.length > MAX_HTTP_HEADER_BYTES) this.fail('handshake_header_limit');
      return;
    }
    if (boundary > MAX_HTTP_HEADER_BYTES) {
      this.fail('handshake_header_limit');
      return;
    }
    const headerBytes = this.rxBuffer.subarray(0, boundary);
    this.rxBuffer = this.rxBuffer.subarray(boundary + 4);
    let response;
    try {
      response = parseHttpHeaders(headerBytes.toString('latin1'));
    } catch {
      this.fail('handshake_invalid');
      return;
    }
    const connectionTokens = (response.headers.connection || '').toLowerCase().split(',').map((value) => value.trim());
    if (response.status !== 'HTTP/1.1 101 Switching Protocols' ||
        (response.headers.upgrade || '').toLowerCase() !== 'websocket' ||
        !connectionTokens.includes('upgrade') ||
        response.headers['sec-websocket-accept'] !== this.expectedAcceptValue) {
      this.fail('handshake_rejected');
      return;
    }
    this.opened = true;
    this.#capabilityToken = null;
    clearTimeout(this.openTimer);
    this.openTimer = null;
    const resolve = this.openResolve;
    this.openResolve = null;
    this.openReject = null;
    if (resolve) resolve();
  }

  consumeFrames() {
    while (!this.closed) {
      let frame;
      try {
        frame = takeServerFrame(this.rxBuffer);
      } catch (error) {
        this.fail(error instanceof ManagedTransportError ? error.code : 'invalid_server_frame');
        return;
      }
      if (!frame) return;
      this.rxBuffer = this.rxBuffer.subarray(frame.bytesConsumed);
      this.handleFrame(frame);
    }
  }

  handleFrame(frame) {
    if (frame.opcode === 0x9) {
      this.writeControlFrame(0x0a, frame.payload);
      return;
    }
    if (frame.opcode === 0x0a) return;
    if (frame.opcode === 0x8) {
      this.fail('remote_closed');
      return;
    }
    if (frame.opcode === 0x1) {
      if (this.fragmentOpcode !== null) {
        this.fail('fragmented_message_interleaved');
        return;
      }
      if (frame.fin) this.dispatchText(frame.payload);
      else {
        this.fragmentOpcode = 0x1;
        this.fragments = [frame.payload];
        this.fragmentBytes = frame.payload.length;
      }
      return;
    }
    if (frame.opcode === 0x0 && this.fragmentOpcode === 0x1) {
      this.fragmentBytes += frame.payload.length;
      if (this.fragmentBytes > MAX_MESSAGE_BYTES || this.fragments.length >= MAX_FRAGMENT_COUNT) {
        this.fail('message_too_large');
        return;
      }
      this.fragments.push(frame.payload);
      if (frame.fin) {
        const payload = Buffer.concat(this.fragments, this.fragmentBytes);
        this.fragmentOpcode = null;
        this.fragments = [];
        this.fragmentBytes = 0;
        this.dispatchText(payload);
      }
      return;
    }
    this.fail('unsupported_frame');
  }

  dispatchText(payload) {
    let message;
    try {
      message = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    } catch {
      this.fail('invalid_json_message');
      return;
    }
    if (!isRecord(message)) return;
    if (Object.hasOwn(message, 'method')) {
      if (typeof message.method !== 'string') {
        this.fail('invalid_rpc_message');
        return;
      }
      if (Object.hasOwn(message, 'id')) {
        this.serverRequestCount += 1;
        try {
          this.onServerRequest({
            id: safeRpcId(message.id),
            method: safeMethodName(message.method),
            params: minimalServerRequestParams(message.params),
          });
        } catch {
          this.fail('callback_failed');
        }
      } else {
        this.notificationCount += 1;
        try {
          this.onNotification(message.method, message.params);
        } catch {
          this.fail('callback_failed');
        }
      }
      return;
    }
    if (!Object.hasOwn(message, 'id')) return;
    const key = responseKey(message.id);
    const pending = this.pending.get(key);
    if (!pending) return;
    const hasResult = Object.hasOwn(message, 'result');
    const hasError = Object.hasOwn(message, 'error');
    if (hasResult === hasError) {
      this.fail('invalid_rpc_response');
      return;
    }
    if (hasError) {
      const rpcCode = isRecord(message.error) && Number.isInteger(message.error.code) ? message.error.code : null;
      this.settle(key, transportError(rpcCode === -32602 ? 'rpc_invalid_params' : 'rpc_error'));
      return;
    }
    this.settle(key, null, message.result);
  }

  writeControlFrame(opcode, payload) {
    if (this.closed || payload.length > 125) return;
    try {
      this.socket.write(makeClientFrame(opcode, payload, this.randomBytes), (error) => {
        if (error) this.fail('connection_failed');
      });
    } catch {
      this.fail('connection_failed');
    }
  }

  settle(key, error, value) {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  fail(code) {
    if (this.closed) return;
    this.closed = true;
    this.failureCode = code;
    clearTimeout(this.openTimer);
    this.openTimer = null;
    this.#capabilityToken = null;
    if (this.openReject) {
      const reject = this.openReject;
      this.openResolve = null;
      this.openReject = null;
      reject(transportError(code));
    }
    for (const key of this.pending.keys()) this.settle(key, transportError(code));
    if (this.socket && !this.socket.destroyed) this.socket.destroy();
    if (!this.disconnectNotified) {
      this.disconnectNotified = true;
      try {
        this.onDisconnect({ code });
      } catch {}
    }
  }
}

async function createCodexManagedTransport(options = {}) {
  const { port, hostHeader } = parseLoopbackEndpoint(options.endpoint);
  const capabilityToken = validateCapabilityToken(options.capabilityToken);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  if (typeof options.onDisconnect !== 'function' || typeof options.onNotification !== 'function' ||
      typeof options.onServerRequest !== 'function') {
    throw transportError('transport_callbacks_required');
  }
  let disconnectNotified = false;
  const onDisconnect = (event) => {
    if (disconnectNotified) return;
    disconnectNotified = true;
    try { options.onDisconnect(event); } catch {}
  };
  let socket;
  try {
    socket = await connectLoopback(port, timeoutMs);
  } catch (error) {
    onDisconnect({ code: error instanceof ManagedTransportError ? error.code : 'connection_failed' });
    throw error;
  }
  const transport = new WebSocketJsonRpcTransport(socket, {
    capabilityToken,
    timeoutMs,
    randomBytes: options.randomBytes,
    onNotification: options.onNotification,
    onServerRequest: options.onServerRequest,
    onDisconnect,
  });
  try {
    await transport.open(hostHeader, port);
  } catch (error) {
    transport.close();
    throw error instanceof ManagedTransportError ? error : transportError('connection_failed');
  }
  return Object.freeze({
    request: (method, params) => transport.request(method, params),
    notify: (method, params) => transport.notify(method, params),
    confirmLoadedThread: (threadId) => transport.confirmLoadedThread(threadId),
    resumeLoadedThread: (threadId, isStillVerified) => transport.resumeLoadedThread(threadId, isStillVerified),
    close: () => transport.close(),
    snapshot: () => transport.safeSnapshot,
  });
}

module.exports = {
  ManagedTransportError,
  createCodexManagedTransport,
  parseLoopbackEndpoint,
};
