const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { AwayState, DashboardState } = require('./state');
const { DecisionAnswerDelivery } = require('./decision-answers');
const { sanitizeEvent } = require('./events');
const { estimateTranscript } = require('./transcript');
const { productFromCwd, claudeHomeFromOptions, cockpitHomeFromOptions } = require('./identity');
const { listLiveSessionFiles, findLiveSessionIdByPid, claudeAgentDefinition, codexAgentDefinition } = require('./session-files');

const APP_NAME = 'agent-cockpit';
const DEFAULT_PORT = 47821;
const MAX_BODY_BYTES = 64 * 1024;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_SCAN_INTERVAL_MS = 10_000;
const MAX_SESSION_ID_LENGTH = 128;
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]+$/;

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

function validUiOrigin(request, port) {
  const origin = request.headers.origin;
  return origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

function validRequiredUiOrigin(request, port) {
  const host = typeof request.headers.host === 'string' ? request.headers.host.toLowerCase() : '';
  const origin = request.headers.origin;
  const fetchSite = request.headers['sec-fetch-site'];
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(host) && origin === `http://${host}` &&
    (fetchSite === undefined || fetchSite === 'same-origin');
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

function validSessionId(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_SESSION_ID_LENGTH && SESSION_ID_PATTERN.test(value);
}

function validText(value, maxLength, allowEmpty = false) {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.trim().length > 0);
}

function validTasks(value) {
  return Array.isArray(value) && value.length <= 50 && value.every((task) => (
    task && typeof task === 'object' && !Array.isArray(task) &&
    validText(task.title, 200) && ['todo', 'doing', 'done'].includes(task.state) &&
    Array.isArray(task.criteria) && task.criteria.length <= 20 && task.criteria.every((criterion) => (
      criterion && typeof criterion === 'object' && !Array.isArray(criterion) &&
      validText(criterion.text, 2000) && typeof criterion.met === 'boolean'
    ))
  ));
}

function validDecisionOptions(value) {
  if (!Array.isArray(value) || value.length > 6) return false;
  let recommendedCount = 0;
  for (const option of value) {
    if (
      !option || typeof option !== 'object' || Array.isArray(option) ||
      !validText(option.label, 200) || !validText(option.description, 2000, true) ||
      (option.recommended !== undefined && typeof option.recommended !== 'boolean')
    ) return false;
    if (option.recommended) recommendedCount += 1;
  }
  return recommendedCount <= 1;
}

function validChosen(value) {
  if (typeof value === 'string') return value.length <= 2000;
  return Array.isArray(value) && value.length <= 6 && value.every((item) => validText(item, 2000, true));
}

function validPlanInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return false;
  if (body.kind === 'tasks') return validTasks(body.tasks);
  if (body.kind === 'add_decision') {
    return validText(body.title, 200) && validText(body.context, 2000, true) &&
      ['waiting', 'provisional'].includes(body.state) && validDecisionOptions(body.options);
  }
  if (body.kind === 'update_decision') {
    return validText(body.id, 256) && ['provisional', 'resolved'].includes(body.state) &&
      validChosen(body.chosen) && validText(body.note, 2000, true);
  }
  return false;
}

function decisionSummaries(state, sessionId) {
  return state.decisionsFor(sessionId)
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .map(({ id, title, state: decisionState }) => ({ id, title, state: decisionState }));
}

function createRequestHandler(options) {
  const {
    homeDir,
    claudeHome,
    state,
    away,
    answerDelivery,
    dev,
    getServerInfo,
    markRequest,
    findSessionIdByPid = (pid) => findLiveSessionIdByPid(pid, claudeHome),
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
    const contextPath = requestUrl.pathname.match(/^\/api\/sessions\/([^/]+)\/context$/);
    if (request.method === 'GET' && contextPath) {
      const sessionId = contextPath[1];
      if (!validSessionId(sessionId)) {
        jsonResponse(response, 400, { error: 'Invalid session id' });
        return;
      }
      jsonResponse(response, 200, { ...away.snapshot(), ...state.planSummary(sessionId) });
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
    if (request.method === 'POST' && requestUrl.pathname === '/api/hooks/answers') {
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
      if (!body || typeof body !== 'object' || Array.isArray(body) || !validSessionId(body.session_id) || !validText(body.id, 256)) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      try {
        let result;
        if (body.action === 'ask-register' && body.event_name === 'PreToolUse' && Array.isArray(body.questions)) {
          result = answerDelivery.registerAsk({ sessionId: body.session_id, toolUseId: body.id, questions: body.questions, agentId: body.agent_id });
        } else if (body.action === 'ask-poll' && body.event_name === 'PreToolUse') {
          result = await answerDelivery.waitForAsk({ sessionId: body.session_id, toolUseId: body.id });
        } else if (body.action === 'ask-finish' && body.event_name === 'PreToolUse' && ['answered', 'hold', 'timeout', 'released', 'server-lost'].includes(body.outcome)) {
          result = answerDelivery.finishAsk({ sessionId: body.session_id, toolUseId: body.id, decisionId: body.decision_id, outcome: body.outcome });
        } else if (body.action === 'post-tool-batch' && body.event_name === 'PostToolBatch') {
          const additionalContext = answerDelivery.deliverPending(body.session_id);
          result = { hookOutput: additionalContext ? { hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext } } : null };
        } else if (body.action === 'user-prompt-submit' && body.event_name === 'UserPromptSubmit') {
          const additionalContext = answerDelivery.deliverPrompt(body.session_id, body.id, Number.isFinite(body.hook_at) ? body.hook_at : undefined);
          result = { hookOutput: additionalContext ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } } : null };
        } else if (body.action === 'stop-start' && body.event_name === 'Stop') {
          result = { generation: answerDelivery.startStop(body.session_id, body.id, Number.isFinite(body.hook_at) ? body.hook_at : undefined) };
        } else if (body.action === 'stop-poll' && body.event_name === 'Stop' && Number.isInteger(body.generation) && typeof body.parent_alive === 'boolean') {
          result = await answerDelivery.waitForStopAnswer(body.session_id, body.generation, body.parent_alive);
        } else {
          jsonResponse(response, 400, { error: 'Invalid request' });
          return;
        }
        jsonResponse(response, 200, result);
      } catch {
        jsonResponse(response, 500, { error: 'Internal Server Error' });
      }
      return;
    }
    const answerPath = requestUrl.pathname.match(/^\/api\/decisions\/([^/]+)\/answer$/);
    if (request.method === 'POST' && answerPath) {
      if (request.headers['x-cockpit-secret'] !== info.uiSecret) {
        jsonResponse(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (!validRequiredUiOrigin(request, info.port)) {
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
      let decisionId;
      try {
        decisionId = decodeURIComponent(answerPath[1]);
      } catch {
        jsonResponse(response, 400, { error: 'Invalid decision id' });
        return;
      }
      if (
        !body || typeof body !== 'object' || Array.isArray(body) ||
        !validSessionId(body.session_id) || body.choice !== null && !['ok', 'hold'].includes(body.choice) ||
        !validText(body.note, 2000, true)
      ) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      if (body.choice === null && !body.note.trim()) {
        jsonResponse(response, 400, { error: 'An answer is required' });
        return;
      }
      const decision = state.decisionFor(body.session_id, decisionId);
      if (!decision || decision.session_id !== body.session_id) {
        jsonResponse(response, 404, { error: 'Decision not found' });
        return;
      }
      const answer = answerDelivery.submitAnswer(body.session_id, decisionId, body.choice, body.note);
      if (answer === false) {
        jsonResponse(response, 400, { error: 'A recommended option is required for this choice' });
        return;
      }
      if (!answer) {
        jsonResponse(response, 409, { error: 'Decision cannot be answered now' });
        return;
      }
      jsonResponse(response, 200, { decision: { id: answer.id, state: answer.state, answer: answer.answer } });
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
    const estimatePath = requestUrl.pathname.match(/^\/api\/sessions\/([^/]+)\/estimate$/);
    if (request.method === 'POST' && estimatePath) {
      if (request.headers['x-cockpit-secret'] !== info.uiSecret) {
        jsonResponse(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (!validUiOrigin(request, info.port)) {
        jsonResponse(response, 403, { error: 'Forbidden' });
        return;
      }
      const sessionId = estimatePath[1];
      if (!/^[A-Za-z0-9_-]{1,100}$/.test(sessionId)) {
        jsonResponse(response, 404, { error: 'Session not found' });
        return;
      }
      const session = state.snapshot().sessions.find((item) => item.session_id === sessionId);
      if (!session) {
        jsonResponse(response, 404, { error: 'Session not found' });
        return;
      }
      if (session.status !== '不明') {
        jsonResponse(response, 409, { error: 'Session state is known' });
        return;
      }
      const file = state.sessionFileFor(sessionId);
      const estimate = await estimateTranscript(claudeHome, file?.cwd, sessionId);
      const saved = state.saveEstimate(sessionId, estimate);
      if (!saved) {
        jsonResponse(response, 409, { error: 'Session state is known' });
        return;
      }
      jsonResponse(response, 200, saved);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/hidden-sessions') {
      if (request.headers['x-cockpit-secret'] !== info.uiSecret) {
        jsonResponse(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (!validUiOrigin(request, info.port)) {
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
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const keys = Object.keys(body).sort();
      if (body.action === 'clear' && keys.length === 1 && keys[0] === 'action') {
        jsonResponse(response, 200, { cleared: state.clearHiddenSessions() });
        return;
      }
      if (
        body.action !== 'hide' || keys.length !== 2 || keys[0] !== 'action' || keys[1] !== 'session_id' ||
        typeof body.session_id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(body.session_id)
      ) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const hidden = state.hideUnknownSession(body.session_id);
      if (hidden === null) {
        jsonResponse(response, 404, { error: 'Session not found' });
        return;
      }
      if (!hidden) {
        jsonResponse(response, 409, { error: 'Session state is known' });
        return;
      }
      jsonResponse(response, 200, { hidden: true });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/away') {
      if (request.headers['x-cockpit-secret'] !== info.uiSecret) {
        jsonResponse(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (!validUiOrigin(request, info.port)) {
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
        const snapshot = await away.setEnabled(body.enabled);
        if (!snapshot.enabled) answerDelivery.signalAll();
        jsonResponse(response, 200, snapshot);
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
      const event = sanitizeEvent(body, { product, sessionName, agentDefinition });
      if (event) answerDelivery.afterEvent(event);
      jsonResponse(response, 202, { accepted: true });
      return;
    }

    const planPath = requestUrl.pathname.match(/^\/api\/sessions\/([^/]+)\/plan$/);
    if (request.method === 'POST' && planPath) {
      if (request.headers['x-cockpit-secret'] !== info.secret) {
        jsonResponse(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (!validOriginForWrite(request)) {
        jsonResponse(response, 403, { error: 'Forbidden' });
        return;
      }
      const routeSessionId = planPath[1];
      if (!validSessionId(routeSessionId)) {
        jsonResponse(response, 400, { error: 'Invalid session id' });
        return;
      }

      let body;
      try {
        body = JSON.parse(await readJsonBody(request));
      } catch (error) {
        jsonResponse(response, error.statusCode || 400, { error: error.statusCode === 413 ? 'Payload too large' : 'Invalid JSON' });
        return;
      }
      if (!validPlanInput(body) || (body.ppid !== undefined && (!Number.isInteger(body.ppid) || body.ppid < 1))) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      if (Object.hasOwn(body, 'claudeCodeSessionId') && body.claudeCodeSessionId !== null && typeof body.claudeCodeSessionId !== 'string') {
        jsonResponse(response, 400, { error: 'Invalid session id' });
        return;
      }

      const mappedSessionId = Number.isInteger(body.ppid) ? await findSessionIdByPid(body.ppid) : null;
      const fallbackSessionId = Object.hasOwn(body, 'claudeCodeSessionId') ? body.claudeCodeSessionId : routeSessionId;
      const sessionId = validSessionId(mappedSessionId) ? mappedSessionId : fallbackSessionId;
      if (!validSessionId(sessionId)) {
        jsonResponse(response, 400, { error: 'Session id unavailable' });
        return;
      }
      if (!validSessionId(mappedSessionId) && typeof fallbackSessionId === 'string' && routeSessionId !== 'pending' && fallbackSessionId !== routeSessionId) {
        jsonResponse(response, 400, { error: 'Invalid session id' });
        return;
      }

      if (body.kind === 'tasks') {
        const saved = state.setTasks(sessionId, body.tasks);
        jsonResponse(response, 200, { tasks: saved.tasks.map(({ title, state: taskState }) => ({ title, state: taskState })), updatedAt: saved.updatedAt });
        return;
      }
      if (body.kind === 'add_decision') {
        const decision = state.addDecision(sessionId, {
          title: body.title,
          context: body.context,
          state: body.state,
          options: body.options.map((option) => ({
            label: option.label,
            description: option.description,
            recommended: option.recommended === true,
          })),
        });
        const decisions = decisionSummaries(state, sessionId);
        jsonResponse(response, 200, { decision: { id: decision.id, title: decision.title, state: decision.state }, decisions });
        return;
      }
      const decision = state.updateDecision(sessionId, body.id, body.state, body.chosen, body.note);
      if (!decision) {
        jsonResponse(response, 404, { error: 'Decision not found or already resolved' });
        return;
      }
      answerDelivery.afterDecisionUpdate(sessionId, decision.id);
      const decisions = decisionSummaries(state, sessionId);
      jsonResponse(response, 200, { decision: { id: decision.id, title: decision.title, state: decision.state }, decisions });
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
  const answerDelivery = options.answerDelivery || new DecisionAnswerDelivery({
    state,
    away,
    ...(options.answerDeliveryOptions || {}),
  });
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
    answerDelivery,
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
      answerDelivery.close();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await removeServerInfoIfOwned(homeDir, info);
      logLine(homeDir, 'stopped');
    })();
    return closing;
  }

  return { server, state, away, answerDelivery, info, homeDir, close };
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
  validUiOrigin,
  validRequiredUiOrigin,
  validSessionId,
  validTasks,
  validDecisionOptions,
  validPlanInput,
  escapeHtmlAttribute,
  atomicWriteServerInfo,
  removeServerInfoIfOwned,
  createRequestHandler,
  startServer,
  parseArguments,
};
