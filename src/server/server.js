const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { AwayState, DashboardState } = require('./state');
const { sanitizeEvent } = require('./events');
const { productFromCwd, claudeHomeFromOptions, cockpitHomeFromOptions } = require('./identity');
const { listLiveSessionFiles, claudeAgentDefinition, codexAgentDefinition } = require('./session-files');

const APP_NAME = 'agent-cockpit';
const DEFAULT_PORT = 47821;
const MAX_BODY_BYTES = 64 * 1024;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_SCAN_INTERVAL_MS = 10_000;

// 画面を別のページの iframe に埋めて操作させる経路と、別のオリジンからの読み取りを塞ぐ。
const SECURITY_HEADERS = Object.freeze({
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'content-security-policy': "frame-ancestors 'none'",
  'cross-origin-resource-policy': 'same-origin',
  'cross-origin-opener-policy': 'same-origin',
});

function jsonResponse(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    ...SECURITY_HEADERS,
  });
  response.end(JSON.stringify(value));
}

function textResponse(response, status, value, contentType = 'text/plain; charset=utf-8') {
  response.writeHead(status, {
    'content-type': contentType,
    ...SECURITY_HEADERS,
  });
  response.end(value);
}

function requestHostIsLocal(request, port) {
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return allowed.has(host.toLowerCase());
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(request.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      request.resume();
      reject(Object.assign(new Error('request body is too large'), { statusCode: 413 }));
      return;
    }

    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        request.removeAllListeners('data');
        request.resume();
        reject(Object.assign(new Error('request body is too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (size <= MAX_BODY_BYTES) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', reject);
  });
}

async function atomicWriteServerInfo(homeDir, info, fileSystem = fs) {
  const target = path.join(homeDir, 'server.json');
  const temporary = path.join(homeDir, `.server.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fileSystem.writeFile(temporary, `${JSON.stringify(info, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await fileSystem.rename(temporary, target);
  } catch (error) {
    await fileSystem.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function removeServerInfoIfOwned(homeDir, info, fileSystem = fs) {
  const target = path.join(homeDir, 'server.json');
  try {
    const current = JSON.parse(await fileSystem.readFile(target, 'utf8'));
    if (current.pid === info.pid && current.startedAt === info.startedAt) {
      await fileSystem.rm(target, { force: true });
    }
  } catch {
    return;
  }
}

function validOriginForWrite(request) {
  return request.headers.origin === undefined;
}

function validAwayOrigin(request, port) {
  const origin = request.headers.origin;
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function escapeHtmlAttribute(value) {
  return String(value).replace(/[&"'<>]/g, (character) => ({
    '&': '&amp;',
    '"': '&quot;',
    "'": '&#39;',
    '<': '&lt;',
    '>': '&gt;',
  })[character]);
}

function createRequestHandler(options) {
  const {
    homeDir,
    claudeHome,
    state,
    away,
    dev,
    getServerInfo,
    markRequest,
  } = options;
  const webPath = path.join(__dirname, '..', 'web', 'index.html');

  return async (request, response) => {
    const info = getServerInfo();
    if (!info || !requestHostIsLocal(request, info.port)) {
      textResponse(response, 400, 'Invalid Host');
      return;
    }
    markRequest();

    const requestUrl = new URL(request.url, `http://127.0.0.1:${info.port}`);
    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      jsonResponse(response, 200, { app: APP_NAME, pid: info.pid, startedAt: info.startedAt });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/state') {
      jsonResponse(response, 200, { ...state.snapshot(), away: away.snapshot() });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/away') {
      jsonResponse(response, 200, away.snapshot());
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/dev/fields') {
      if (!dev) {
        textResponse(response, 404, 'Not Found');
        return;
      }
      jsonResponse(response, 200, state.devFields());
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/') {
      try {
        const template = await fs.readFile(webPath, 'utf8');
        const html = template.replace(
          '<meta name="cockpit-secret" content="">',
          `<meta name="cockpit-secret" content="${escapeHtmlAttribute(info.uiSecret)}">`,
        );
        textResponse(response, 200, html, 'text/html; charset=utf-8');
      } catch {
        textResponse(response, 500, 'Dashboard unavailable');
      }
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/away') {
      if (request.headers['x-cockpit-secret'] !== info.uiSecret) {
        jsonResponse(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (!validAwayOrigin(request, info.port)) {
        jsonResponse(response, 403, { error: 'Forbidden' });
        return;
      }

      let body;
      try {
        body = JSON.parse(await readJsonBody(request));
      } catch (error) {
        jsonResponse(response, error.statusCode || 400, { error: error.statusCode === 413 ? 'Payload too large' : 'Invalid JSON' });
        return;
      }
      if (!body || typeof body !== 'object' || Array.isArray(body) || typeof body.enabled !== 'boolean') {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      try {
        jsonResponse(response, 200, await away.setEnabled(body.enabled));
      } catch {
        jsonResponse(response, 500, { error: 'Internal Server Error' });
      }
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/events') {
      if (request.headers['x-cockpit-secret'] !== info.secret) {
        jsonResponse(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (!validOriginForWrite(request)) {
        jsonResponse(response, 403, { error: 'Forbidden' });
        return;
      }

      let body;
      try {
        body = JSON.parse(await readJsonBody(request));
      } catch (error) {
        jsonResponse(response, error.statusCode || 400, { error: error.statusCode === 413 ? 'Payload too large' : 'Invalid JSON' });
        return;
      }

      state.captureFieldNames(body);
      const product = productFromCwd(body.cwd);
      const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
      const eventName = body.hook_event_name;
      const sessionName = sessionId ? state.sessionNameFor(sessionId) : null;
      let agentDefinition = null;

      if (eventName === 'SubagentStart' && body.agent_type) {
        agentDefinition = await claudeAgentDefinition(body.agent_type, claudeHome);
      } else if (eventName === 'PreToolUse') {
        const preliminary = sanitizeEvent(body, { product });
        if (preliminary?.codexDefinition) {
          agentDefinition = await codexAgentDefinition(preliminary.codexDefinition, claudeHome);
        }
      }

      state.addEvent(body, { product, sessionName, agentDefinition });
      jsonResponse(response, 202, { accepted: true });
      return;
    }

    if (requestUrl.pathname.startsWith('/api/')) {
      textResponse(response, 405, 'Method Not Allowed');
      return;
    }
    textResponse(response, 404, 'Not Found');
  };
}

function logLine(homeDir, message) {
  const line = `${new Date().toISOString()} ${message}\n`;
  fs.appendFile(path.join(homeDir, 'server.log'), line).catch(() => {});
}

async function listen(server, port) {
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function hasSessionJsonFiles(claudeHome) {
  try {
    const entries = await fs.readdir(path.join(claudeHome, 'sessions'), { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json');
  } catch {
    return true;
  }
}

async function startServer(options = {}) {
  const homeDir = cockpitHomeFromOptions(options);
  const claudeHome = claudeHomeFromOptions(options);
  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be between 0 and 65535');
  const dev = Boolean(options.dev);
  await fs.mkdir(homeDir, { recursive: true });
  if (options.truncateLog !== false) await fs.writeFile(path.join(homeDir, 'server.log'), '', { mode: 0o600 });

  const state = options.state || new DashboardState();
  const away = options.away || await AwayState.load(homeDir);
  let info = null;
  let closing = null;
  let lastRequestAt = Date.now();
  const server = options.server || http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      logLine(homeDir, 'request failed');
      if (!response.headersSent) jsonResponse(response, 500, { error: 'Internal Server Error' });
      else response.destroy();
    });
  });
  const handler = createRequestHandler({
    homeDir,
    claudeHome,
    state,
    away,
    dev,
    getServerInfo: () => info,
    markRequest: () => { lastRequestAt = Date.now(); },
  });

  try {
    await listen(server, port);
    if (options.afterListen) await options.afterListen(server);
    const address = server.address();
    info = {
      pid: process.pid,
      port: address.port,
      secret: crypto.randomBytes(32).toString('base64url'),
      // 画面に埋める値。フック用の secret と分け、画面から読めても /api/events は偽造できないようにする。
      uiSecret: crypto.randomBytes(32).toString('base64url'),
      startedAt: new Date().toISOString(),
    };
    await atomicWriteServerInfo(homeDir, info);
  } catch (error) {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    throw error;
  }

  logLine(homeDir, `started on 127.0.0.1:${info.port}`);
  async function refreshSessionFiles() {
    const files = await listLiveSessionFiles(claudeHome);
    if (files) state.syncSessionFiles(files.map((file) => ({ ...file, product: productFromCwd(file.cwd) })));
  }
  await refreshSessionFiles().catch(() => {});
  const sessionScanTimer = setInterval(() => { refreshSessionFiles().catch(() => {}); }, SESSION_SCAN_INTERVAL_MS);
  sessionScanTimer.unref();

  const idleTimer = setInterval(async () => {
    if (Date.now() - lastRequestAt < IDLE_TIMEOUT_MS) return;
    if (state.snapshot().sessions.length > 0) return;
    if (await hasSessionJsonFiles(claudeHome)) return;
    logLine(homeDir, 'stopping after idle timeout');
    await close();
  }, 60_000);
  idleTimer.unref();

  async function close() {
    if (closing) return closing;
    closing = (async () => {
      clearInterval(idleTimer);
      clearInterval(sessionScanTimer);
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await removeServerInfoIfOwned(homeDir, info);
      logLine(homeDir, 'stopped');
    })();
    return closing;
  }

  return { server, state, away, info, homeDir, close };
}

function parseArguments(argv) {
  const options = { port: process.env.AGENT_COCKPIT_PORT || DEFAULT_PORT, dev: false };
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--port') options.port = Number(argv[++index]);
    else if (argv[index] === '--dev') options.dev = true;
  }
  return options;
}

if (require.main === module) {
  startServer(parseArguments(process.argv.slice(2)))
    .then((runtime) => {
      console.log(`Agent Cockpit listening at http://127.0.0.1:${runtime.info.port}/`);
      const stop = () => runtime.close().finally(() => { process.exitCode = 0; });
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    })
    .catch((error) => {
      console.error(`Agent Cockpit failed to start: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  APP_NAME,
  DEFAULT_PORT,
  MAX_BODY_BYTES,
  requestHostIsLocal,
  validAwayOrigin,
  escapeHtmlAttribute,
  atomicWriteServerInfo,
  removeServerInfoIfOwned,
  createRequestHandler,
  startServer,
  parseArguments,
};
