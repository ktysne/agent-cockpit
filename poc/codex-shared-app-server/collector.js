'use strict';

const { createHash, randomBytes } = require('node:crypto');
const { spawn } = require('node:child_process');
const { lstatSync, realpathSync } = require('node:fs');
const net = require('node:net');
const { isAbsolute, join, relative, resolve, sep } = require('node:path');
const { TextDecoder } = require('node:util');

const EXPECTED_THREAD_NAME = 'PoC157 デスクトップとネイティブ子の識別検証';
const KNOWN_THREADS = Object.freeze([
  '01a10d78-8654-7e12-a2fb-98adc5388b83',
  '01a10d78-e095-7f21-bfc7-7b5ea0d548b1',
]);
const READONLY_ALLOWED_METHODS = Object.freeze([
  'initialize',
  'initialized',
  'thread/list',
  'thread/loaded/list',
  'thread/read',
]);
const SUPPORTED_APP_SERVER_VERSIONS = new Set(['0.160.0']);
const SAFE_STATUS_TYPES = new Set(['notLoaded', 'idle', 'systemError', 'active']);
const SAFE_THREAD_ACTIVE_FLAGS = new Set(['waitingOnApproval', 'waitingOnUserInput']);
const RPC_ERROR_CATEGORIES = Object.freeze([
  'thread_not_found', 'history_missing', 'not_initialized', 'experimental_required',
  'invalid_params', 'permission_denied', 'thread_not_persisted', 'resume_unavailable', 'unknown',
]);
const SAFE_RPC_ERROR_CATEGORIES = new Set(RPC_ERROR_CATEGORIES);
const SAFE_SOURCE_TYPES = new Set(['cli', 'vscode', 'exec', 'appServer', 'unknown']);
const SAFE_ITEM_TYPES = new Set([
  'userMessage', 'hookPrompt', 'agentMessage', 'functionCallOutput', 'plan', 'reasoning',
  'commandExecution', 'fileChange', 'mcpToolCall', 'dynamicToolCall', 'collabAgentToolCall',
  'subAgentActivity', 'webSearch', 'imageView', 'sleep', 'imageGeneration',
  'enteredReviewMode', 'exitedReviewMode', 'contextCompaction',
]);
const SAFE_NOTIFICATION_STATUSES = new Set([
  'pendingInit', 'running', 'interrupted', 'completed', 'errored', 'shutdown', 'notFound',
  'inProgress', 'failed', 'declined', 'notLoaded', 'idle', 'systemError', 'active',
]);
const REPO_ROOT = resolve(__dirname, '../..');
const CODEX_HOME_ROOT = resolve(REPO_ROOT, 'poc', 'out');
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_HTTP_HEADER_BYTES = 16 * 1024;
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_BUFFER_BYTES = MAX_FRAME_BYTES + MAX_HTTP_HEADER_BYTES + 64;
const MAX_FRAGMENT_COUNT = 1024;
const MAX_LIST_PAGES = 10;

class PocError extends Error {
  constructor(kind, details = {}) {
    super(kind);
    this.name = 'PocError';
    this.kind = kind;
    this.rpcCode = Number.isInteger(details.rpcCode) ? details.rpcCode : undefined;
    this.rpcErrorCategory = SAFE_RPC_ERROR_CATEGORIES.has(details.rpcErrorCategory)
      ? details.rpcErrorCategory
      : undefined;
  }
}

class WebSocketJsonRpcClient {
  #allowedMethods;
  #capabilityToken;

  constructor(readable, writable, options = {}) {
    if (!readable || !writable) throw new PocError('missing_stream');
    const allowedMethods = options.allowedMethods || READONLY_ALLOWED_METHODS;
    if (!Array.isArray(allowedMethods) || allowedMethods.some((method) => typeof method !== 'string')) {
      throw new PocError('invalid_method_allowlist');
    }
    this.#capabilityToken = options.capabilityToken === undefined
      ? undefined
      : validateCapabilityToken(options.capabilityToken);
    this.hostHeader = validateHostHeader(options.hostHeader || 'localhost');
    this.readable = readable;
    this.writable = writable;
    this.timeoutMs = normalizeTimeout(options.timeoutMs);
    this.randomBytes = options.randomBytes || randomBytes;
    this.#allowedMethods = new Set(allowedMethods);
    this.onNotification = typeof options.onNotification === 'function' ? options.onNotification : null;
    this.onServerRequest = typeof options.onServerRequest === 'function' ? options.onServerRequest : null;
    this.rxBuffer = Buffer.alloc(0);
    this.upgraded = false;
    this.opened = false;
    this.closed = false;
    this.nextId = 1;
    this.pending = new Map();
    this.notificationCount = 0;
    this.serverRequestCount = 0;
    this.fragmentOpcode = null;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.openTimer = null;
    this.openResolve = null;
    this.openReject = null;
    this.failure = null;
    this.acceptValue = null;

    this.readable.on('data', (chunk) => this.onData(chunk));
    this.readable.on('end', () => this.fail('connection_closed'));
    this.readable.on('close', () => this.fail('connection_closed'));
    this.readable.on('error', () => this.fail('connection_error'));
    this.writable.on('close', () => this.fail('connection_closed'));
    this.writable.on('error', () => this.fail('connection_error'));
  }

  open() {
    if (this.closed || this.failure) {
      return Promise.reject(new PocError(this.failure || 'connection_closed'));
    }
    if (this.opened) return Promise.resolve();
    if (this.openResolve) return Promise.reject(new PocError('already_opening'));
    const key = this.randomBytes(16).toString('base64');
    this.acceptValue = createHash('sha1').update(key + GUID).digest('base64');
    const request = [
      'GET / HTTP/1.1',
      'Host: ' + this.hostHeader,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Key: ' + key,
      'Sec-WebSocket-Version: 13',
      ...(this.#capabilityToken ? ['Authorization: Bearer ' + this.#capabilityToken] : []),
      '',
      '',
    ].join('\r\n');

    return new Promise((resolveOpen, rejectOpen) => {
      this.openResolve = resolveOpen;
      this.openReject = rejectOpen;
      this.openTimer = setTimeout(() => this.fail('handshake_timeout'), this.timeoutMs);
      try {
        this.writable.write(request, (error) => {
          if (error) this.fail('connection_error');
        });
      } catch {
        this.fail('connection_error');
      }
      if (this.failure) this.fail(this.failure);
    });
  }

  get allowedMethods() {
    return Object.freeze([...this.#allowedMethods]);
  }

  async request(method, params) {
    this.assertOpen();
    if (!this.#allowedMethods.has(method) || method === 'initialized') {
      throw new PocError('method_not_allowed');
    }
    const id = this.nextId++;
    const key = responseKey(id);
    return new Promise((resolveResponse, rejectResponse) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        rejectResponse(new PocError('request_timeout'));
      }, this.timeoutMs);
      this.pending.set(key, { resolve: resolveResponse, reject: rejectResponse, timer });
      this.sendJson({ id, method, params }).catch((error) => {
        this.settle(key, error);
      });
    });
  }

  async notify(method, params = {}) {
    this.assertOpen();
    if (!this.#allowedMethods.has(method) || method !== 'initialized') {
      throw new PocError('method_not_allowed');
    }
    await this.sendJson({ method, params });
  }

  assertOpen() {
    if (this.closed) throw new PocError(this.failure || 'connection_closed');
    if (!this.opened) throw new PocError('connection_not_open');
  }

  async sendJson(value) {
    const body = Buffer.from(JSON.stringify(value), 'utf8');
    if (body.length > MAX_FRAME_BYTES) throw new PocError('request_too_large');
    await new Promise((resolveWrite, rejectWrite) => {
      this.writable.write(makeClientFrame(0x1, body, this.randomBytes), (error) => {
        if (error) rejectWrite(new PocError('connection_error'));
        else resolveWrite();
      });
    });
  }

  onData(chunk) {
    if (this.closed) return;
    if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (this.rxBuffer.length + chunk.length > MAX_BUFFER_BYTES) {
      this.fail('receive_buffer_limit');
      return;
    }
    this.rxBuffer = this.rxBuffer.length
      ? Buffer.concat([this.rxBuffer, chunk])
      : chunk;
    if (!this.upgraded) this.consumeHandshake();
    if (this.upgraded && !this.closed) this.consumeFrames();
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
    const trailingBytes = this.rxBuffer.subarray(boundary + 4);
    this.rxBuffer = trailingBytes;
    let headers;
    try {
      headers = parseHttpHeaders(headerBytes.toString('latin1'));
    } catch {
      this.fail('handshake_invalid');
      return;
    }
    const connectionTokens = (headers.connection || '').toLowerCase().split(',').map((s) => s.trim());
    if (headers.status !== 'HTTP/1.1 101 Switching Protocols'
      || (headers.upgrade || '').toLowerCase() !== 'websocket'
      || !connectionTokens.includes('upgrade')
      || headers['sec-websocket-accept'] !== this.acceptValue) {
      this.fail('handshake_rejected');
      return;
    }
    this.upgraded = true;
    this.opened = true;
    clearTimeout(this.openTimer);
    this.openTimer = null;
    const resolveOpen = this.openResolve;
    this.openResolve = null;
    this.openReject = null;
    if (resolveOpen) resolveOpen();
  }

  consumeFrames() {
    while (!this.closed) {
      let frame;
      try {
        frame = takeServerFrame(this.rxBuffer);
      } catch (error) {
        this.fail(error instanceof PocError ? error.kind : 'invalid_server_frame');
        return;
      }
      if (!frame) return;
      this.rxBuffer = this.rxBuffer.subarray(frame.bytesConsumed);
      this.handleFrame(frame);
    }
  }

  handleFrame(frame) {
    if (frame.opcode === 0x9) {
      this.writeControlFrame(0xA, frame.payload);
      return;
    }
    if (frame.opcode === 0xA) return;
    if (frame.opcode === 0x8) {
      this.fail('remote_close');
      return;
    }
    if (frame.opcode === 0x1) {
      if (this.fragmentOpcode !== null) {
        this.fail('fragmented_message_interleaved');
        return;
      }
      if (frame.fin) {
        this.dispatchText(frame.payload);
      } else {
        this.fragmentOpcode = 0x1;
        this.fragments = [frame.payload];
        this.fragmentBytes = frame.payload.length;
      }
      return;
    }
    if (frame.opcode === 0x0 && this.fragmentOpcode === 0x1) {
      this.fragmentBytes += frame.payload.length;
      if (this.fragmentBytes > MAX_FRAME_BYTES || this.fragments.length >= MAX_FRAGMENT_COUNT) {
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
      const text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
      message = JSON.parse(text);
    } catch {
      this.fail('invalid_json_message');
      return;
    }
    if (!message || typeof message !== 'object' || Array.isArray(message)) return;
    if (Object.hasOwn(message, 'method')) {
      if (typeof message.method !== 'string') {
        this.fail('invalid_rpc_message');
        return;
      }
      if (Object.hasOwn(message, 'id')) {
        this.serverRequestCount += 1;
        if (this.onServerRequest) {
          try {
            this.onServerRequest({
              id: safeRequestId(message.id),
              method: safeMethodName(message.method),
            });
          } catch {
            this.fail('callback_failed');
          }
        }
      } else {
        this.notificationCount += 1;
        if (this.onNotification) {
          try {
            const method = safeMethodName(message.method);
            this.onNotification(method, projectNotificationMetadata(message.params, method));
          } catch {
            this.fail('callback_failed');
          }
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
    if (hasError && message.error && typeof message.error === 'object') {
      const rpcCode = Number.isInteger(message.error.code) ? message.error.code : undefined;
      const rpcErrorCategory = classifyRpcError(rpcCode, message.error.message);
      this.settle(key, new PocError('rpc_error', { rpcCode, rpcErrorCategory }));
      return;
    }
    if (hasError) {
      this.settle(key, new PocError('rpc_error', { rpcErrorCategory: 'unknown' }));
      return;
    }
    this.settle(key, null, message.result);
  }

  writeControlFrame(opcode, payload) {
    if (payload.length > 125 || this.closed) return;
    this.writable.write(makeClientFrame(opcode, payload, this.randomBytes), (error) => {
      if (error) this.fail('connection_error');
    });
  }

  settle(key, error, value) {
    const pending = this.pending.get(key);
    if (!pending) return;
    this.pending.delete(key);
    clearTimeout(pending.timer);
    if (error) pending.reject(error);
    else pending.resolve(value);
  }

  fail(kind) {
    if (this.closed) return;
    this.closed = true;
    this.failure = kind;
    clearTimeout(this.openTimer);
    if (this.openReject) {
      const rejectOpen = this.openReject;
      this.openResolve = null;
      this.openReject = null;
      rejectOpen(new PocError(kind));
    }
    for (const [key] of this.pending) this.settle(key, new PocError(kind));
  }

  close() {
    if (!this.closed && this.upgraded) {
      this.writeControlFrame(0x8, Buffer.from([0x03, 0xE8]));
    }
    this.fail('closed');
    try {
      this.writable.end();
    } catch {}
  }
}

function parseHttpHeaders(headerText) {
  const lines = headerText.split('\r\n');
  const status = lines.shift();
  if (!status) throw new Error('invalid');
  const headers = { status };
  for (const line of lines) {
    const separator = line.indexOf(':');
    if (separator <= 0) throw new Error('invalid');
    const name = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    headers[name] = headers[name] ? headers[name] + ', ' + value : value;
  }
  return headers;
}

function takeServerFrame(buffer) {
  if (buffer.length < 2) return null;
  const first = buffer[0];
  const second = buffer[1];
  const fin = Boolean(first & 0x80);
  const opcode = first & 0x0F;
  if ((first & 0x70) !== 0 || (second & 0x80) !== 0) {
    throw new PocError('invalid_server_frame');
  }
  let payloadLength = second & 0x7F;
  let offset = 2;
  if (payloadLength === 126) {
    if (buffer.length < 4) return null;
    payloadLength = buffer.readUInt16BE(2);
    offset = 4;
  } else if (payloadLength === 127) {
    if (buffer.length < 10) return null;
    const length64 = buffer.readBigUInt64BE(2);
    if (length64 > BigInt(MAX_FRAME_BYTES)) throw new PocError('frame_too_large');
    payloadLength = Number(length64);
    offset = 10;
  }
  const isControl = opcode >= 0x8;
  if ((isControl && (!fin || payloadLength > 125))
    || payloadLength > MAX_FRAME_BYTES
    || ![0x0, 0x1, 0x2, 0x8, 0x9, 0xA].includes(opcode)) {
    throw new PocError('invalid_server_frame');
  }
  if (buffer.length < offset + payloadLength) return null;
  return {
    fin,
    opcode,
    payload: buffer.subarray(offset, offset + payloadLength),
    bytesConsumed: offset + payloadLength,
  };
}

function makeClientFrame(opcode, payload, randomBytesImpl = randomBytes) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const length = body.length;
  if (length > MAX_FRAME_BYTES) throw new PocError('frame_too_large');
  let headerLength;
  if (length < 126) headerLength = 2;
  else if (length <= 0xFFFF) headerLength = 4;
  else headerLength = 10;
  const header = Buffer.alloc(headerLength + 4);
  header[0] = 0x80 | opcode;
  if (length < 126) {
    header[1] = 0x80 | length;
  } else if (length <= 0xFFFF) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  const maskOffset = headerLength;
  const mask = randomBytesImpl(4);
  mask.copy(header, maskOffset);
  const masked = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    masked[index] = body[index] ^ mask[index & 3];
  }
  return Buffer.concat([header, masked]);
}

function responseKey(id) {
  return typeof id + ':' + String(id);
}

function createProxyEnvironment(codexHome) {
  const env = {};
  for (const key of ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  env.CODEX_HOME = validateCodexHome(codexHome);
  env.TEMP = env.CODEX_HOME;
  env.TMP = env.CODEX_HOME;
  return env;
}

function validateCodexHome(codexHome) {
  if (!codexHome || !isAbsolute(codexHome)) throw new PocError('dedicated_codex_home_required');
  const resolvedHome = resolve(codexHome);
  if (!isPathWithin(CODEX_HOME_ROOT, resolvedHome) || resolvedHome === CODEX_HOME_ROOT) {
    throw new PocError('dedicated_codex_home_required');
  }
  const relativeHome = relative(CODEX_HOME_ROOT, resolvedHome);
  let current = CODEX_HOME_ROOT;
  try {
    for (const part of relativeHome.split(sep)) {
      current = join(current, part);
      if (lstatSync(current).isSymbolicLink()) throw new PocError('codex_home_symlink');
    }
    if (!lstatSync(resolvedHome).isDirectory()) throw new PocError('codex_home_not_directory');
    if (!isPathWithin(CODEX_HOME_ROOT, realpathSync(resolvedHome))) {
      throw new PocError('dedicated_codex_home_required');
    }
  } catch (error) {
    if (error instanceof PocError) throw error;
    throw new PocError('codex_home_missing');
  }
  return resolvedHome;
}

function isPathWithin(root, target) {
  const childPath = relative(root, target);
  return childPath === '' || (childPath !== '..'
    && !childPath.startsWith('..' + sep)
    && !isAbsolute(childPath));
}

async function connectViaProxy(options = {}) {
  const { cliPath, socketPath, codexHome, timeoutMs } = options;
  if (!cliPath || !isAbsolute(cliPath)) throw new PocError('cli_path_required');
  if (!socketPath || !isAbsolute(socketPath)) throw new PocError('socket_path_required');
  validateCodexHome(codexHome);
  let child;
  try {
    child = spawn(cliPath, ['app-server', 'proxy', '--sock', socketPath], {
      env: createProxyEnvironment(codexHome),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch {
    throw new PocError('proxy_spawn_failed');
  }
  let client;
  try {
    client = new WebSocketJsonRpcClient(child.stdout, child.stdin, {
      timeoutMs,
      allowedMethods: options.allowedMethods,
      onNotification: options.onNotification,
      onServerRequest: options.onServerRequest,
    });
  } catch (error) {
    child.kill();
    throw error instanceof PocError ? error : new PocError('proxy_setup_failed');
  }
  child.on('error', () => client.fail('proxy_spawn_failed'));
  child.on('exit', () => {
    if (!client.closed) client.fail('proxy_exited');
  });
  try {
    await client.open();
  } catch (error) {
    client.close();
    child.kill();
    throw error;
  }
  return {
    client,
    close() {
      client.close();
      const timer = setTimeout(() => child.kill(), 250);
      timer.unref?.();
    },
  };
}

async function connectViaTcp(options = {}) {
  const host = options.host === undefined ? '127.0.0.1' : options.host;
  if (host !== '127.0.0.1') throw new PocError('loopback_host_required');
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new PocError('valid_port_required');
  }
  const capabilityToken = validateCapabilityToken(options.capabilityToken);
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const socket = net.connect({ host, port: options.port });
  try {
    await waitForSocketConnect(socket, timeoutMs);
  } catch (error) {
    socket.destroy();
    throw error;
  }

  let client;
  try {
    client = new WebSocketJsonRpcClient(socket, socket, {
      timeoutMs,
      capabilityToken,
      hostHeader: host + ':' + options.port,
      allowedMethods: options.allowedMethods,
      onNotification: options.onNotification,
      onServerRequest: options.onServerRequest,
    });
    await client.open();
  } catch (error) {
    if (client) client.close();
    socket.destroy();
    throw error instanceof PocError ? error : new PocError('websocket_setup_failed');
  }
  return {
    client,
    close() {
      client.close();
      const timer = setTimeout(() => socket.destroy(), 250);
      timer.unref?.();
    },
  };
}

async function connectViaWebSocket(options = {}) {
  if (typeof options.url !== 'string'
    || !/^ws:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}\/?$/.test(options.url)) {
    throw new PocError('loopback_websocket_url_required');
  }
  let url;
  try {
    url = new URL(options.url);
  } catch {
    throw new PocError('invalid_websocket_url');
  }
  if (url.protocol !== 'ws:' || url.hostname !== '127.0.0.1'
    || !url.port || url.pathname !== '/' || url.username || url.password
    || url.search || url.hash) {
    throw new PocError('loopback_websocket_url_required');
  }
  return connectViaTcp({
    host: '127.0.0.1',
    port: Number(url.port),
    capabilityToken: options.authToken,
    timeoutMs: options.timeoutMs,
    allowedMethods: options.allowedMethods,
    onNotification: options.onNotification,
    onServerRequest: options.onServerRequest,
  });
}

function validateCapabilityToken(token) {
  if (typeof token !== 'string' || !/^[0-9a-fA-F]{64}$/.test(token)) {
    throw new PocError('invalid_capability_token');
  }
  return token;
}

function validateHostHeader(hostHeader) {
  if (hostHeader === 'localhost') return hostHeader;
  const match = typeof hostHeader === 'string'
    ? hostHeader.match(/^127\.0\.0\.1:([1-9][0-9]{0,4})$/)
    : null;
  if (!match || Number(match[1]) > 65535) {
    throw new PocError('invalid_host_header');
  }
  return hostHeader;
}

function waitForSocketConnect(socket, timeoutMs) {
  return new Promise((resolveConnect, rejectConnect) => {
    const timer = setTimeout(() => {
      socket.destroy();
      rejectConnect(new PocError('connect_timeout'));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      socket.removeListener('connect', onConnect);
      socket.removeListener('error', onError);
    };
    const onConnect = () => {
      cleanup();
      resolveConnect();
    };
    const onError = () => {
      cleanup();
      rejectConnect(new PocError('connection_error'));
    };
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

function projectNotificationMetadata(params, method) {
  if (!params || typeof params !== 'object' || Array.isArray(params)) return {};
  const item = params.item && typeof params.item === 'object' ? params.item : {};
  const threadId = firstUuid(params.threadId, params.thread && params.thread.id);
  const turnId = firstUuid(params.turnId, params.turn && params.turn.id);
  const itemId = safeItemId(params.itemId || item.id);
  const itemType = firstAllowed(SAFE_ITEM_TYPES, item.type, params.itemType);
  const threadStatus = projectThreadStatus(params.status);
  const requestId = method === 'serverRequest/resolved' ? safeRequestId(params.requestId) : null;
  const status = firstAllowed(
    SAFE_NOTIFICATION_STATUSES,
    params.status,
    params.turn && params.turn.status,
    item.status,
  );
  return {
    ...(threadId ? { threadId } : {}),
    ...(turnId ? { turnId } : {}),
    ...(itemId ? { itemId } : {}),
    ...(itemType ? { itemType } : {}),
    ...(status ? { status } : {}),
    ...(threadStatus ? { threadStatus } : {}),
    ...(requestId !== null ? { requestId } : {}),
  };
}

function projectThreadStatus(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const type = firstAllowed(SAFE_STATUS_TYPES, value.type);
  if (!type) return null;
  if (type !== 'active') return { type };
  const activeFlags = Array.isArray(value.activeFlags)
    ? [...new Set(value.activeFlags.filter((flag) => SAFE_THREAD_ACTIVE_FLAGS.has(flag)))]
    : [];
  return { type, activeFlags };
}

function safeMethodName(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_./:-]{1,128}$/.test(value)
    ? value
    : 'unknown';
}

function classifyRpcError(rpcCode, rawMessage) {
  if (rpcCode === -32602) return 'invalid_params';
  if (typeof rawMessage !== 'string') return 'unknown';
  const message = rawMessage.toLowerCase();
  if (/\b(?:thread|conversation)\b.{0,120}\b(?:not found|does not exist|was not found)\b/.test(message)) {
    return 'thread_not_found';
  }
  if (/\b(?:rollout|history)\b.{0,120}\b(?:missing|not found|unavailable)\b/.test(message)
    || /\b(?:missing|not found|unavailable)\b.{0,120}\b(?:rollout|history)\b/.test(message)) {
    return 'history_missing';
  }
  if (/\b(?:not initialized|not been initialized|must initialize first|initialize before)\b/.test(message)) {
    return 'not_initialized';
  }
  if (/\bexperimental feature\b.{0,120}\b(?:required|not enabled|disabled)\b/.test(message)
    || /\brequires? an? experimental feature\b/.test(message)) {
    return 'experimental_required';
  }
  if (/\b(?:permission|access|authorization) denied\b|\bnot authorized\b/.test(message)) {
    return 'permission_denied';
  }
  if (/\bnot persisted\b|\bnot materialized\b|\bhas not\b.{0,120}\bturn\b|\bno\b.{0,120}\brollout\b|\bfirst\b.{0,120}\bturn\b/.test(message)) {
    return 'thread_not_persisted';
  }
  if (/\binvalid params?\b|\binvalid (?:request )?parameters?\b/.test(message)) {
    return 'invalid_params';
  }
  if (/\b(?:cannot|can't|unable to) resume\b|\bresume (?:is )?unavailable\b/.test(message)) {
    return 'resume_unavailable';
  }
  return 'unknown';
}

function safeRequestId(value) {
  if (Number.isSafeInteger(value)) return value;
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value)
    ? value
    : null;
}

function firstUuid(...values) {
  for (const value of values) {
    const safe = safeUuid(value);
    if (safe) return safe;
  }
  return null;
}

function safeItemId(value) {
  if (safeUuid(value)) return value;
  return typeof value === 'string' && /^item_[A-Za-z0-9_-]{1,80}$/.test(value)
    ? value
    : null;
}

function firstAllowed(allowlist, ...values) {
  return values.find((value) => typeof value === 'string' && allowlist.has(value)) || null;
}

async function collectReadOnlySnapshot(options = {}) {
  const timeoutMs = normalizeTimeout(options.timeoutMs);
  const maxListPages = positiveInteger(options.maxListPages, MAX_LIST_PAGES);
  const connect = options.connect || connectViaProxy;
  const connection = await connect({
    cliPath: options.cliPath,
    socketPath: options.socketPath,
    codexHome: options.codexHome,
    timeoutMs,
  });
  const client = connection.client || connection;
  if (!client || typeof client.request !== 'function' || typeof client.notify !== 'function') {
    if (connection.close) connection.close();
    throw new PocError('invalid_connection');
  }

  try {
    const initialize = await client.request('initialize', {
      clientInfo: {
        name: 'agent-cockpit-poc158',
        title: 'Agent Cockpit read-only identity probe',
        version: '0.1.0',
      },
      capabilities: { experimentalApi: false },
    });
    const initializeSummary = validateInitializeResponse(initialize);
    await client.notify('initialized', {});
    if (options.initializeOnly) {
      return {
        ok: true,
        transport: 'app-server proxy over WebSocket',
        initialized: true,
        appServerVersion: initializeSummary.version,
        serverRequestCount: client.serverRequestCount || 0,
      };
    }
    const listed = await scanThreadList(client, maxListPages);
    const loaded = await scanLoadedThreads(client, maxListPages);
    const reads = [];
    for (const id of KNOWN_THREADS) reads.push(await readKnownThread(client, id));
    return {
      ok: true,
      transport: 'app-server proxy over WebSocket',
      initialized: true,
      appServerVersion: initializeSummary.version,
      serverRequestCount: client.serverRequestCount || 0,
      notificationCount: client.notificationCount || 0,
      list: listed,
      loaded,
      reads,
    };
  } catch (error) {
    throw error instanceof PocError ? error : new PocError('probe_failed');
  } finally {
    if (connection.close) connection.close();
    else if (typeof client.close === 'function') client.close();
  }
}

function validateInitializeResponse(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.codexHome !== 'string'
    || !isAbsolute(value.codexHome)
    || typeof value.platformFamily !== 'string'
    || typeof value.platformOs !== 'string'
    || typeof value.userAgent !== 'string') {
    throw new PocError('initialize_response_invalid');
  }
  const match = value.userAgent.match(/(?:^|[/ ])(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?:$|[^0-9A-Za-z.+-])/);
  const version = match && match[1];
  if (!version || !SUPPORTED_APP_SERVER_VERSIONS.has(version)) {
    throw new PocError('unsupported_app_server_version');
  }
  return { version };
}

async function scanThreadList(client, maxPages) {
  const projected = new Map();
  const visitedCursors = new Set();
  let cursor;
  let searchedPages = 0;
  let truncated = false;
  let morePages = false;
  for (; searchedPages < maxPages; searchedPages += 1) {
    const params = {
      searchTerm: EXPECTED_THREAD_NAME,
      useStateDbOnly: true,
      limit: 100,
    };
    if (cursor) params.cursor = cursor;
    const result = await client.request('thread/list', params);
    if (!result || !Array.isArray(result.data)) throw new PocError('invalid_thread_list');
    for (const thread of result.data) {
      if (!thread || !KNOWN_THREADS.includes(thread.id)) continue;
      projected.set(thread.id, projectThread(thread));
    }
    if (typeof result.nextCursor !== 'string' || !result.nextCursor) {
      morePages = false;
      searchedPages += 1;
      break;
    }
    if (visitedCursors.has(result.nextCursor)) {
      morePages = true;
      searchedPages += 1;
      truncated = true;
      break;
    }
    visitedCursors.add(result.nextCursor);
    cursor = result.nextCursor;
    morePages = true;
  }
  if (searchedPages === maxPages && morePages) truncated = true;
  return {
    searchTermApplied: true,
    useStateDbOnly: true,
    searchedPages,
    truncated,
    knownMatches: KNOWN_THREADS.filter((id) => projected.has(id)).map((id) => projected.get(id)),
  };
}

async function scanLoadedThreads(client, maxPages) {
  const seenIds = new Set();
  const knownMatches = new Set();
  const visitedCursors = new Set();
  let cursor;
  let searchedPages = 0;
  let truncated = false;
  let morePages = false;
  for (; searchedPages < maxPages; searchedPages += 1) {
    const params = { limit: 100 };
    if (cursor) params.cursor = cursor;
    const result = await client.request('thread/loaded/list', params);
    if (!result || !Array.isArray(result.data)) throw new PocError('invalid_loaded_list');
    for (const id of result.data) {
      if (typeof id !== 'string') continue;
      seenIds.add(id);
      if (KNOWN_THREADS.includes(id)) knownMatches.add(id);
    }
    if (typeof result.nextCursor !== 'string' || !result.nextCursor) {
      morePages = false;
      searchedPages += 1;
      break;
    }
    if (visitedCursors.has(result.nextCursor)) {
      morePages = true;
      searchedPages += 1;
      truncated = true;
      break;
    }
    visitedCursors.add(result.nextCursor);
    cursor = result.nextCursor;
    morePages = true;
  }
  if (searchedPages === maxPages && morePages) truncated = true;
  return {
    searchedPages,
    truncated,
    itemCount: seenIds.size,
    knownMatches: KNOWN_THREADS.filter((id) => knownMatches.has(id)),
  };
}

async function readKnownThread(client, id) {
  try {
    const result = await client.request('thread/read', { threadId: id, includeTurns: false });
    const thread = result && result.thread;
    if (!thread || thread.id !== id) {
      return { id, found: false, idMismatch: Boolean(thread && thread.id) };
    }
    return {
      id,
      found: true,
      ...projectThread(thread),
      turnsReturned: Array.isArray(thread.turns) && thread.turns.length > 0,
    };
  } catch (error) {
    return {
      id,
      found: false,
      errorKind: error instanceof PocError ? error.kind : 'read_failed',
      ...(error instanceof PocError && Number.isInteger(error.rpcCode) ? { rpcCode: error.rpcCode } : {}),
      ...(error instanceof PocError && SAFE_RPC_ERROR_CATEGORIES.has(error.rpcErrorCategory)
        ? { rpcErrorCategory: error.rpcErrorCategory }
        : {}),
    };
  }
}

function projectThread(thread) {
  const subAgent = thread.source && typeof thread.source === 'object'
    && thread.source.subAgent && typeof thread.source.subAgent === 'object'
    ? thread.source.subAgent
    : {};
  return {
    id: KNOWN_THREADS.includes(thread.id) ? thread.id : null,
    namePresent: typeof thread.name === 'string' && thread.name.length > 0,
    expectedNameMatches: thread.name === EXPECTED_THREAD_NAME,
    status: thread.status && SAFE_STATUS_TYPES.has(thread.status.type) ? thread.status.type : null,
    sourceKind: projectSourceKind(thread.source),
    parentThreadId: safeKnownId(subAgent.parentThreadId || thread.parentThreadId),
    sessionId: safeUuid(subAgent.sessionId || thread.sessionId),
    forkedFromId: safeKnownId(subAgent.forkedFromId || thread.forkedFromId),
  };
}

function projectSourceKind(source) {
  if (typeof source === 'string' && SAFE_SOURCE_TYPES.has(source)) return source;
  if (!source || typeof source !== 'object') return 'unknown';
  if (Object.hasOwn(source, 'subAgent')) return 'subAgent';
  if (Object.hasOwn(source, 'custom')) return 'custom';
  return 'unknown';
}

function safeKnownId(value) {
  return KNOWN_THREADS.includes(value) ? value : null;
}

function safeUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
    ? value
    : null;
}

function positiveInteger(value, fallback) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, 100) : fallback;
}

function normalizeTimeout(value) {
  return Number.isInteger(value) && value > 0 ? Math.min(value, DEFAULT_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
}

function parseArgs(argv) {
  const args = {};
  const names = {
    '--cli': 'cliPath',
    '--socket': 'socketPath',
    '--codex-home': 'codexHome',
    '--timeout-ms': 'timeoutMs',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (key === '--initialize-only') {
      args.initializeOnly = true;
      continue;
    }
    if (!Object.hasOwn(names, key)) throw new PocError('invalid_argument');
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new PocError('missing_argument_value');
    args[names[key]] = key === '--timeout-ms' ? Number(value) : value;
    index += 1;
  }
  return args;
}

if (require.main === module) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(JSON.stringify({ ok: false, error: error.kind || 'invalid_argument' }) + '\n');
    process.exitCode = 2;
  }
  if (args) {
    collectReadOnlySnapshot(args).then((result) => {
      process.stdout.write(JSON.stringify(result) + '\n');
    }).catch((error) => {
      process.stderr.write(JSON.stringify({ ok: false, error: error.kind || 'probe_failed' }) + '\n');
      process.exitCode = 1;
    });
  }
}

module.exports = {
  EXPECTED_THREAD_NAME,
  KNOWN_THREADS,
  PocError,
  READONLY_ALLOWED_METHODS,
  RPC_ERROR_CATEGORIES,
  WebSocketJsonRpcClient,
  connectViaProxy,
  connectViaTcp,
  connectViaWebSocket,
  collectReadOnlySnapshot,
  makeClientFrame,
  projectNotificationMetadata,
  takeServerFrame,
  validateCodexHome,
  validateInitializeResponse,
};
