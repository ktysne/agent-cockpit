const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { AwayState, DashboardState } = require('./state');
const { RoutingState, isValidRouteUpdate } = require('./routing');
const { AtomicJsonWriter, atomicWriteJson } = require('./json-storage');
const { isGithubCredentialEnvironmentVariable } = require('./credential-environment');
const { validDisplayPatch } = require('./display-preferences');
const { ANSWER_WAIT_MS, DecisionAnswerDelivery, validPicks } = require('./decision-answers');
const { sanitizeEvent } = require('./events');
const { estimateTranscript } = require('./transcript');
const { productFromCwd, claudeHomeFromOptions, codexAgentScriptPaths, cockpitHomeFromOptions } = require('./identity');
const { listLiveSessionFiles, claudeAgentDefinition, codexAgentDefinition } = require('./session-files');
const { createRegistrationKernel } = require('./conversation-registry');
const { createProviderEventProjection, createProviderEventAdapter } = require('./provider-event-projection');
const { sanitizeManagedCollectorSnapshot } = require('./managed-collector');
const { crossReviewToolExists: defaultCrossReviewToolExists, PullRequestTracker } = require('./pull-requests');
const { PullRequestMergeManager } = require('./pull-request-merge');
const { isCompleteCommitSha, isSha256Digest, parsePullRequestUrl, isGithubCreatePullRequestTool, validRepositoryPart } = require('./pull-request-utils');
const { isRequestSessionId, isShortSessionId } = require('./session-ids');
const { DEFAULT_PORT } = require('./server-constants');

const APP_NAME = 'agent-cockpit';
const DEFAULT_MANUAL_DIR = path.join(__dirname, '..', '..', 'manual');
const MAX_BODY_BYTES = 64 * 1024;
const MAX_EXTERNAL_URL_LENGTH = 2048;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_SCAN_INTERVAL_MS = 10_000;
const WRITER_CLAIM_FIELDS = Object.freeze([
  'provider', 'nativeIdKind', 'native_id_kind', 'hostId', 'host_id',
  'homeScopeId', 'home_scope_id', 'nativeId', 'native_id', 'identity',
  'sessionId', 'conversationId', 'conversation_id', 'executionId', 'execution_id',
  'periodId', 'period_id', 'contextId', 'context_id', 'evidence', 'evidenceId',
  'evidence_id', 'evidenceMetadata', 'evidence_metadata', 'observationId',
  'observation_id', 'registration', 'registrationId', 'registration_id',
  'verified', 'verification', 'writerToken', 'writer_token', 'claudeCodeSessionId',
  'claude_code_session_id', 'originBinding', 'executionBinding', 'actorId', 'launchId', 'runId',
]);
const MANUAL_CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.png': 'image/png',
});

async function defaultCodexAgentScriptExists(scriptPath) {
  try {
    await fs.access(scriptPath);
    return true;
  } catch {
    return false;
  }
}

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

function rawRequestPath(requestUrl) {
  const pathAndQuery = String(requestUrl).split(/[?#]/, 1)[0];
  if (pathAndQuery.startsWith('/')) return pathAndQuery;
  try {
    return new URL(pathAndQuery).pathname;
  } catch {
    return '';
  }
}

function isPathWithin(root, target) {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function serveManualRequest(request, response, manualDir) {
  const requestPath = rawRequestPath(request.url);
  if (requestPath !== '/manual' && !requestPath.startsWith('/manual/')) return false;
  if (request.method !== 'GET') {
    textResponse(response, 404, 'Not Found');
    return true;
  }
  if (/%(?:2f|5c)/i.test(requestPath)) {
    textResponse(response, 404, 'Not Found');
    return true;
  }
  let decodedPath;
  try {
    decodedPath = decodeURIComponent(requestPath);
  } catch {
    textResponse(response, 404, 'Not Found');
    return true;
  }
  if (decodedPath.includes('\\') || decodedPath.includes('//')
      || decodedPath.split('/').some(segment => segment === '.' || segment === '..')) {
    textResponse(response, 404, 'Not Found');
    return true;
  }

  // 入口のページは相対パスで assets を指すので、末尾の / が無いと /assets/ を読みに行って崩れる。
  if (decodedPath === '/manual') {
    response.writeHead(308, { location: '/manual/', ...SECURITY_HEADERS });
    response.end();
    return true;
  }
  const manualPath = decodedPath;
  let root;
  let relativePath;
  if (manualPath === '/manual/') {
    root = path.join(manualDir, 'dist');
    relativePath = 'index.html';
  } else if (manualPath.startsWith('/manual/img/')) {
    root = path.join(manualDir, 'img');
    relativePath = manualPath.slice('/manual/img/'.length);
  } else {
    root = path.join(manualDir, 'dist');
    relativePath = manualPath.slice('/manual/'.length);
  }

  const segments = relativePath.split('/');
  const extension = path.extname(relativePath).toLowerCase();
  if (!relativePath || segments.some(segment => !segment || segment === '.' || segment === '..')
      || !Object.prototype.hasOwnProperty.call(MANUAL_CONTENT_TYPES, extension)) {
    textResponse(response, 404, 'Not Found');
    return true;
  }
  const resolvedRoot = path.resolve(root);
  const filePath = path.resolve(resolvedRoot, ...segments);
  if (!isPathWithin(resolvedRoot, filePath)) {
    textResponse(response, 404, 'Not Found');
    return true;
  }
  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) throw new Error('not a file');
    const content = await fs.readFile(filePath);
    textResponse(response, 200, content, MANUAL_CONTENT_TYPES[extension]);
  } catch {
    textResponse(response, 404, 'Not Found');
  }
  return true;
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
  return atomicWriteJson(homeDir, 'server.json', info, fileSystem);
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
  return request.headers.origin === undefined && request.headers['sec-fetch-site'] !== 'cross-site';
}

function validUiOrigin(request, port) {
  const origin = request.headers.origin;
  return request.headers['sec-fetch-site'] !== 'cross-site' &&
    (origin === undefined || origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`);
}

function validRequiredUiOrigin(request, port) {
  const host = typeof request.headers.host === 'string' ? request.headers.host.toLowerCase() : '';
  const origin = request.headers.origin;
  const fetchSite = request.headers['sec-fetch-site'];
  return [`127.0.0.1:${port}`, `localhost:${port}`].includes(host) && origin === `http://${host}` &&
    (fetchSite === undefined || fetchSite === 'same-origin');
}

// 起動するプログラムには検査した値そのものを渡すため、正規化した href を返す。
// rundll32 は引数を ShellExecute へそのまま渡すので、空白や引用符が残る値は受けない。
function normalizeExternalUrl(value, port) {
  if (typeof value !== 'string' || value.length > MAX_EXTERNAL_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.href.length > MAX_EXTERNAL_URL_LENGTH || /[\s"]/.test(url.href)) return null;
    if (url.protocol === 'https:') return url.href;

    const urlPort = Number(url.port || 80);
    const matchesLocalhost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
    const isManualPath = url.pathname.startsWith('/manual/');
    if (url.protocol !== 'http:' || !matchesLocalhost || urlPort !== port || !isManualPath || url.username || url.password) return null;

    const normalizedUrl = `http://127.0.0.1:${port}${url.pathname}${url.search}${url.hash}`;
    if (normalizedUrl.length > MAX_EXTERNAL_URL_LENGTH || /[\s"]/.test(normalizedUrl)) return null;
    return normalizedUrl;
  } catch {
    return null;
  }
}

// xdg-open のようにすぐ終わらない起動もあるので、終了は待たずに起動できたかだけを見る。
function defaultOpenExternalUrl(url) {
  const [command, args] = process.platform === 'win32'
    ? ['rundll32.exe', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { detached: true, shell: false, stdio: 'ignore', windowsHide: true });
    child.once('spawn', () => {
      child.unref();
      resolve();
    });
    child.once('error', reject);
  });
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
  return isRequestSessionId(value);
}

function validText(value, maxLength, allowEmpty = false) {
  return typeof value === 'string' && value.length <= maxLength && (allowEmpty || value.trim().length > 0);
}

function validTasks(value) {
  if (!Array.isArray(value) || value.length > 50) return false;
  const titles = new Set();
  for (const task of value) {
    if (
      !task || typeof task !== 'object' || Array.isArray(task) ||
      !validText(task.title, 200) || titles.has(task.title) || !['todo', 'doing', 'done'].includes(task.state) ||
      !Array.isArray(task.criteria) || task.criteria.length > 20 || !task.criteria.every((criterion) => (
        criterion && typeof criterion === 'object' && !Array.isArray(criterion) &&
        validText(criterion.text, 2000) && typeof criterion.met === 'boolean'
      ))
    ) return false;
    titles.add(task.title);
  }
  return true;
}

function validSeenRequest(value) {
  const generatedAt = Date.parse(value?.generatedAt || '');
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && Object.hasOwn(value, 'productKey') && Object.hasOwn(value, 'generatedAt') &&
    typeof value.productKey === 'string' && value.productKey.trim().length > 0 && value.productKey.length <= 500 &&
    typeof value.generatedAt === 'string' && Number.isFinite(generatedAt) && generatedAt <= Date.now();
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

function hasOnlyKeys(value, fields) {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value)) &&
    Object.keys(value).every((field) => fields.includes(field));
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
    userHome,
    state,
    away,
    routing,
    answerDelivery,
    dev,
    getServerInfo,
    markRequest,
    registrationRegistry = createRegistrationKernel().registry,
    managedCollectors = [],
    pullRequestTracker,
    pullRequestMergeManager,
    codexAgentScriptExists = defaultCodexAgentScriptExists,
    crossReviewToolExists = defaultCrossReviewToolExists,
    openExternalUrl = defaultOpenExternalUrl,
  } = options;
  const webPath = options.webPath || path.join(__dirname, '..', 'web', 'index.html');
  const manualDir = options.manualDir || DEFAULT_MANUAL_DIR;
  const providerEventProjection = options.providerEventProjection || createProviderEventProjection({
    registry: registrationRegistry,
    resolveActorCorrelation: options.resolveActorCorrelation || null,
  });
  const providerEventAdapters = new Map(['claude', 'codex'].map((provider) => [
    provider, createProviderEventAdapter(provider, providerEventProjection),
  ]));
  let cachedUiFileStamp = null;
  let uiVersion = null;

  async function currentUiVersion() {
    try {
      const stat = await fs.stat(webPath);
      const stamp = `${stat.mtimeMs}:${stat.size}`;
      if (stamp !== cachedUiFileStamp) {
        const content = await fs.readFile(webPath);
        uiVersion = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
        cachedUiFileStamp = stamp;
      }
    } catch {}
    return uiVersion;
  }

  function resolveWriterSessionId(routeId, body) {
    const authorization = registrationRegistry.authorizeWriter(body.writer);
    if (!authorization.ok || !validSessionId(authorization.sessionId)) return null;
    if (routeId !== 'pending' && authorization.sessionId !== routeId) return null;
    return authorization.sessionId;
  }

  return async (request, response) => {
    const info = getServerInfo();
    if (!info || !requestHostIsLocal(request, info.port)) {
      textResponse(response, 400, 'Invalid Host');
      return;
    }
    markRequest();

    const requestUrl = new URL(request.url, `http://127.0.0.1:${info.port}`);
    if (await serveManualRequest(request, response, manualDir)) return;
    if (request.method === 'GET' && requestUrl.pathname === '/health') {
      jsonResponse(response, 200, { app: APP_NAME, pid: info.pid, startedAt: info.startedAt });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/api/state') {
      const snapshot = state.snapshot();
      const pullRequests = pullRequestTracker?.snapshot() || [];
      const now = Date.now();
      const awayState = away.snapshot();
      const sinceSeen = state.snapshotSinceSeen(snapshot.sessions, pullRequests, now, awayState.periods);
      // 版と時刻は中身と同じ同期処理の中で確定する。後で待つと、待つ間の更新の版が古い中身に付く。
      snapshot.version = state.version;
      snapshot.generatedAt = state.generatedAt;
      void away.prune?.([...state.seenAtByProduct.values()], now);
      const sessions = snapshot.sessions.map((session) => {
        const seenAt = session.product && sinceSeen.seenAtByProduct[session.product.key];
        const seenMilliseconds = Date.parse(seenAt || '');
        return {
          ...session,
          decisions: session.decisions.map((decision) => ({
            ...decision,
            isNew: Number.isFinite(seenMilliseconds) && Date.parse(decision.createdAt) > seenMilliseconds,
          })),
        };
      });
      const uiVersion = await currentUiVersion();
      let codexAgent = false;
      for (const scriptPath of codexAgentScriptPaths(claudeHome, userHome)) {
        if (await codexAgentScriptExists(scriptPath) === true) {
          codexAgent = true;
          break;
        }
      }
      let crossReview = false;
      for (const cwd of state.knownCwds()) {
        if (await crossReviewToolExists(cwd) === true) {
          crossReview = true;
          break;
        }
      }
      const managedCollectorSnapshots = Array.isArray(managedCollectors)
        ? managedCollectors.map((collector) => {
          try {
            return typeof collector?.snapshot === 'function'
              ? sanitizeManagedCollectorSnapshot(collector.snapshot())
              : null;
          } catch { return null; }
        }).filter(Boolean)
        : [];
      jsonResponse(response, 200, { ...snapshot, sessions, pullRequests, sinceSeen: sinceSeen.sinceSeen, away: away.snapshot(), routing: routing.snapshot(), integrations: { codexAgent, crossReview }, providerEvents: providerEventProjection.snapshot(), managedCollectors: managedCollectorSnapshots, uiVersion });
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
      const answerRequest = { ...body };
      let authorizationDenied = false;
      let authorizeAnswer;
      if (Object.hasOwn(body, 'writer')) {
        const authorization = registrationRegistry.authorizeEvent(body.writer);
        if (WRITER_CLAIM_FIELDS.some((field) => Object.hasOwn(body, field)) ||
            !authorization.ok || body.session_id !== authorization.sessionId) {
          jsonResponse(response, 403, { error: 'Writer unavailable' });
          return;
        }
        answerRequest.session_id = authorization.sessionId;
        delete answerRequest.writer;
        authorizeAnswer = () => {
          const current = registrationRegistry.authorizeEvent(body.writer);
          const authorized = current.ok && current.sessionId === body.session_id;
          if (!authorized) authorizationDenied = true;
          return authorized;
        };
      } else if (WRITER_CLAIM_FIELDS.some((field) => Object.hasOwn(body, field)) ||
          registrationRegistry.isRegisteredSessionId(body.session_id)) {
        jsonResponse(response, 403, { error: 'Writer unavailable' });
        return;
      } else {
        authorizeAnswer = () => {
          const authorized = !registrationRegistry.isRegisteredSessionId(body.session_id);
          if (!authorized) authorizationDenied = true;
          return authorized;
        };
      }
      try {
        let result;
        if (answerRequest.action === 'ask-register' && answerRequest.event_name === 'PreToolUse' && Array.isArray(answerRequest.questions)) {
          result = answerDelivery.registerAsk({ sessionId: answerRequest.session_id, toolUseId: answerRequest.id, questions: answerRequest.questions, agentId: answerRequest.agent_id });
        } else if (answerRequest.action === 'ask-poll' && answerRequest.event_name === 'PreToolUse') {
          result = await answerDelivery.waitForAsk({ sessionId: answerRequest.session_id, toolUseId: answerRequest.id, authorize: authorizeAnswer });
        } else if (answerRequest.action === 'ask-finish' && answerRequest.event_name === 'PreToolUse' && ['answered', 'timeout', 'released', 'server-lost'].includes(answerRequest.outcome)) {
          result = answerDelivery.finishAsk({ sessionId: answerRequest.session_id, toolUseId: answerRequest.id, decisionId: answerRequest.decision_id, outcome: answerRequest.outcome });
        } else if (answerRequest.action === 'post-tool-batch' && answerRequest.event_name === 'PostToolBatch') {
          state.addEvent({
            session_id: answerRequest.session_id,
            hook_event_name: 'PostToolBatch',
            hookAt: Date.now(),
          });
          const additionalContext = answerDelivery.deliverPostToolBatch(answerRequest.session_id);
          result = { hookOutput: additionalContext ? { hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext } } : null };
        } else if (answerRequest.action === 'user-prompt-submit' && answerRequest.event_name === 'UserPromptSubmit') {
          const additionalContext = answerDelivery.deliverPrompt(answerRequest.session_id, answerRequest.id, Number.isFinite(answerRequest.hook_at) ? answerRequest.hook_at : undefined);
          result = { hookOutput: additionalContext ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } } : null };
        } else if (answerRequest.action === 'stop-start' && answerRequest.event_name === 'Stop') {
          result = { generation: answerDelivery.startStop(answerRequest.session_id, answerRequest.id, Number.isFinite(answerRequest.hook_at) ? answerRequest.hook_at : undefined) };
        } else if (answerRequest.action === 'stop-poll' && answerRequest.event_name === 'Stop' && Number.isInteger(answerRequest.generation) && typeof answerRequest.parent_alive === 'boolean') {
          result = await answerDelivery.waitForStopAnswer(answerRequest.session_id, answerRequest.generation, answerRequest.parent_alive, authorizeAnswer);
        } else {
          jsonResponse(response, 400, { error: 'Invalid request' });
          return;
        }
        if (authorizationDenied) {
          jsonResponse(response, 403, { error: 'Writer unavailable' });
          return;
        }
        await state.waitForPersistence();
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
        !validSessionId(body.session_id) || body.choice !== null && !['ok', 'pick'].includes(body.choice) ||
        (body.choice === 'pick' ? !Array.isArray(body.picks) : Object.hasOwn(body, 'picks')) ||
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
      if (body.choice === 'pick' && !validPicks(decision, body.picks, body.note)) {
        jsonResponse(response, 400, { error: 'Invalid picks' });
        return;
      }
      const answer = answerDelivery.submitAnswer(body.session_id, decisionId, body.choice, body.note, body.picks);
      if (answer === false) {
        jsonResponse(response, 400, { error: 'A recommended option is required for this choice' });
        return;
      }
      if (!answer) {
        jsonResponse(response, 409, { error: 'Decision cannot be answered now' });
        return;
      }
      await state.waitForPersistence();
      jsonResponse(response, 200, { decision: { id: answer.id, state: answer.state, answer: answer.answer } });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/pull-requests/review-skip') {
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
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'action,headRefOid,registration_key' ||
        !['set', 'clear'].includes(body.action) || !isSha256Digest(body.registration_key) ||
        !isCompleteCommitSha(body.headRefOid)) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const registration = state.pullRequestRegistrationByKey(body.registration_key);
      if (!registration) {
        jsonResponse(response, 404, { error: 'Registered pull request not found' });
        return;
      }
      if (!pullRequestTracker?.refreshRepoFresh || !pullRequestTracker.mergeCandidate) {
        jsonResponse(response, 503, { error: 'Pull request state is unavailable' });
        return;
      }
      if (body.action === 'set') {
        if (!pullRequestMergeManager?.setReviewSkip) {
          jsonResponse(response, 503, { error: 'Pull request state is unavailable' });
          return;
        }
        const result = await pullRequestMergeManager.setReviewSkip(
          registration,
          body.headRefOid,
          '開発者がダッシュボードでこの head のレビューを不要と判断した',
        );
        if (!result.ok) {
          jsonResponse(response, result.status, { error: result.error });
          return;
        }
        jsonResponse(response, 200, { action: body.action, number: registration.number });
        return;
      }
      try {
        const refreshed = await pullRequestTracker.refreshRepoFresh(registration.owner, registration.repo);
        const candidate = refreshed?.error ? null : pullRequestTracker.mergeCandidate(registration);
        if (!candidate?.pullRequest) {
          jsonResponse(response, 409, { error: 'Pull request is no longer open' });
          return;
        }
        if (candidate.pullRequest.headRefOid.toLowerCase() !== body.headRefOid.toLowerCase()) {
          jsonResponse(response, 409, { error: 'Pull request head has changed' });
          return;
        }
        if (!state.clearCrossReviewSkip(registration.owner, registration.repo, registration.number, candidate.pullRequest.headRefOid)) {
          jsonResponse(response, 409, { error: 'Review skip is no longer active' });
          return;
        }
        await state.waitForPersistence();
        await pullRequestTracker.refreshReviewGroups(registration.owner, registration.repo);
        jsonResponse(response, 200, { action: body.action, number: registration.number });
      } catch {
        jsonResponse(response, 502, { error: 'Pull request state could not be refreshed' });
      }
      return;
    }

    const pullRequestMergePath = requestUrl.pathname.match(/^\/api\/pull-requests\/(merge|reserve|cancel-reservation|conflict-request)$/);
    if (request.method === 'POST' && pullRequestMergePath) {
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
      const action = pullRequestMergePath[1];
      const isConflictRequest = action === 'conflict-request';
      const expectedFields = isConflictRequest ? ['headRefOid', 'key'] : action === 'cancel-reservation'
        ? ['number', 'registration_key']
        : ['deleteBranch', 'headRefOid', 'method', 'number', 'registration_key'];
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== expectedFields.join(',') ||
        (isConflictRequest
          ? (!isSha256Digest(body.key) || typeof body.headRefOid !== 'string' || body.headRefOid.length > 64)
          : (!Number.isSafeInteger(body.number) || body.number < 1 || !isSha256Digest(body.registration_key) ||
            (action !== 'cancel-reservation' && (typeof body.headRefOid !== 'string' || body.headRefOid.length > 64 ||
              typeof body.method !== 'string' || typeof body.deleteBranch !== 'boolean'))))) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const result = isConflictRequest
        ? await pullRequestMergeManager.requestConflictResolution(body)
        : action === 'merge'
          ? await pullRequestMergeManager.merge(body)
          : action === 'reserve'
            ? await pullRequestMergeManager.reserve(body)
            : await pullRequestMergeManager.cancelReservation(body);
      await state.waitForPersistence();
      jsonResponse(response, result.ok ? 200 : result.status, result.ok ? result : { error: result.error });
      return;
    }
    if (request.method === 'GET' && requestUrl.pathname === '/') {
      try {
        let beforeStat = null;
        try {
          beforeStat = await fs.stat(webPath);
        } catch {}
        const content = await fs.readFile(webPath);
        let afterStat = null;
        try {
          afterStat = await fs.stat(webPath);
        } catch {}
        uiVersion = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
        const sameFile = beforeStat && afterStat && beforeStat.mtimeMs === afterStat.mtimeMs && beforeStat.size === afterStat.size && content.length === afterStat.size;
        cachedUiFileStamp = sameFile ? `${afterStat.mtimeMs}:${afterStat.size}` : null;
        const template = content.toString('utf8');
        const html = template.replace(
          '<meta name="cockpit-secret" content="">',
          `<meta name="cockpit-secret" content="${escapeHtmlAttribute(info.uiSecret)}">`,
        ).replace(
          '<meta name="cockpit-ui-version" content="">',
          `<meta name="cockpit-ui-version" content="${uiVersion}">`,
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
      if (!validRequiredUiOrigin(request, info.port)) {
        jsonResponse(response, 403, { error: 'Forbidden' });
        return;
      }
      const sessionId = estimatePath[1];
      if (!isShortSessionId(sessionId)) {
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
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const keys = Object.keys(body).sort();
      if (body.action === 'clear' && keys.length === 1 && keys[0] === 'action') {
        jsonResponse(response, 200, { cleared: state.clearHiddenSessions() });
        return;
      }
      const validHiddenSessionId = isShortSessionId;
      const isBatchUnhide = body.action === 'unhide' && keys.length === 2 && keys[0] === 'action' && keys[1] === 'session_ids' &&
        Array.isArray(body.session_ids) && body.session_ids.length >= 1 && body.session_ids.length <= 50 &&
        body.session_ids.every(validHiddenSessionId);
      if (body.action === 'unhide') {
        if (!isBatchUnhide) {
          jsonResponse(response, 400, { error: 'Invalid request' });
          return;
        }
        jsonResponse(response, 200, { unhidden: state.unhideSessions(body.session_ids) });
        return;
      }
      const isSingleHide = keys.length === 2 && keys[0] === 'action' && keys[1] === 'session_id' && validHiddenSessionId(body.session_id);
      const isBatchHide = keys.length === 2 && keys[0] === 'action' && keys[1] === 'session_ids' &&
        Array.isArray(body.session_ids) && body.session_ids.length >= 1 && body.session_ids.length <= 50 &&
        body.session_ids.every(validHiddenSessionId);
      if (body.action !== 'hide' || (!isSingleHide && !isBatchHide)) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const sessionIds = isSingleHide ? [body.session_id] : body.session_ids;
      let hiddenCount = 0;
      for (const sessionId of new Set(sessionIds)) {
        if (state.hideSession(sessionId) !== null) hiddenCount += 1;
      }
      if (hiddenCount === 0) {
        jsonResponse(response, 404, { error: 'Session not found' });
        return;
      }
      jsonResponse(response, 200, { hidden: isSingleHide ? true : hiddenCount });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/display') {
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
      if (!validDisplayPatch(body)) {
        jsonResponse(response, 400, { error: 'Invalid display preferences' });
        return;
      }
      jsonResponse(response, 200, { display: state.patchDisplayPreferences(body) });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/pull-requests/merge-result/close') {
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
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'number,owner,repo' ||
        !validRepositoryPart(body.owner) || !validRepositoryPart(body.repo) ||
        !Number.isSafeInteger(body.number) || body.number < 1) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const closed = state.closeAutomaticPullRequestMergeResult(body.owner, body.repo, body.number);
      if (closed === null) {
        jsonResponse(response, 404, { error: 'Automatic pull request merge result not found' });
        return;
      }
      await state.waitForPersistence?.();
      jsonResponse(response, 200, { closed: true });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/seen') {
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
      if (!validSeenRequest(body)) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const seenAt = state.setProductSeen(body.productKey, body.generatedAt);
      await away.prune?.([...state.seenAtByProduct.values()]);
      jsonResponse(response, 200, { productKey: body.productKey, seenAt });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/closed-tasks') {
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
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'session_id,title' || !validSessionId(body.session_id) || !validText(body.title, 200)) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      if (!state.snapshot().sessions.some((session) => session.session_id === body.session_id)) {
        jsonResponse(response, 404, { error: 'Session not found' });
        return;
      }
      const closed = state.closeTask(body.session_id, body.title);
      if (closed === null) {
        jsonResponse(response, 404, { error: 'Task not found' });
        return;
      }
      if (!closed) {
        jsonResponse(response, 409, { error: 'Task is already complete' });
        return;
      }
      jsonResponse(response, 200, { closed: true });
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/closed-agents') {
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
      if (!body || typeof body !== 'object' || Array.isArray(body) ||
        Object.keys(body).sort().join(',') !== 'agent_id,session_id' || !validSessionId(body.session_id) || !validText(body.agent_id, 256)) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const closed = state.closeAgent(body.session_id, body.agent_id);
      if (closed === null) {
        jsonResponse(response, 404, { error: 'Unconfirmed agent not found' });
        return;
      }
      if (!closed) {
        jsonResponse(response, 409, { error: 'Agent state changed' });
        return;
      }
      jsonResponse(response, 200, { closed: true });
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
    if (request.method === 'POST' && requestUrl.pathname === '/api/routing') {
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
      if (!isValidRouteUpdate(body)) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      try {
        const snapshot = await routing.set(body.key, body.value);
        state.touch?.();
        jsonResponse(response, 200, snapshot);
      } catch {
        jsonResponse(response, 500, { error: 'Internal Server Error' });
      }
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/open-url') {
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
      const externalUrl = body && typeof body === 'object' && !Array.isArray(body)
        ? normalizeExternalUrl(body.url, info.port)
        : null;
      if (!externalUrl) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      try {
        await openExternalUrl(externalUrl);
        response.writeHead(204, SECURITY_HEADERS);
        response.end();
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

      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const eventBody = { ...body };
      const writerEnvelope = Object.hasOwn(body, 'writer') ? body.writer : null;
      if (Object.hasOwn(body, 'writer')) {
        const authorization = registrationRegistry.authorizeEvent(writerEnvelope);
        if (WRITER_CLAIM_FIELDS.some((field) => Object.hasOwn(body, field)) ||
            !authorization.ok || body.session_id !== authorization.sessionId) {
          jsonResponse(response, 403, { error: 'Writer unavailable' });
          return;
        }
        eventBody.session_id = authorization.sessionId;
        delete eventBody.writer;
      } else {
        if (WRITER_CLAIM_FIELDS.some((field) => Object.hasOwn(body, field)) ||
            registrationRegistry.isRegisteredSessionId(body.session_id)) {
          jsonResponse(response, 403, { error: 'Writer unavailable' });
          return;
        }
      }

      let eventAdapter = null;
      let registration = null;
      if (writerEnvelope) {
        const checked = providerEventProjection.inspect(writerEnvelope, eventBody.session_id);
        if (!checked.ok) {
          jsonResponse(response, 403, { error: 'Writer unavailable' });
          return;
        }
        registration = checked.registration;
        eventAdapter = providerEventAdapters.get(registration.provider);
        const normalized = eventAdapter.normalize(eventBody);
        if (!normalized.ok) {
          const result = eventAdapter.project({ writer: writerEnvelope, sessionId: eventBody.session_id, event: eventBody });
          if (result.action === 'reject') {
            jsonResponse(response, 403, { error: 'Writer unavailable' });
          } else {
            jsonResponse(response, 202, { accepted: false, status: 'unknown', reason: result.reason });
          }
          return;
        }
        Object.assign(eventBody, normalized.event);
      }
      const product = productFromCwd(eventBody.cwd || eventBody.nativeEvent?.cwd);
      const sessionId = typeof eventBody.session_id === 'string' ? eventBody.session_id : '';
      const eventName = eventBody.hook_event_name;
      const agentId = eventBody.agent_id || eventBody.nativeEvent?.agent_id;
      const agentType = eventBody.agent_type || eventBody.nativeEvent?.agent_type;
      const sessionName = sessionId ? state.sessionNameFor(sessionId) : null;
      let agentDefinition = null;
      let codexDefinitionMetadata = null;

      if (
        (registration?.provider === 'claude' || !registration) && agentId && agentType && eventName !== 'SubagentStop' &&
        (eventName === 'SubagentStart' || !state.hasAgentRow(sessionId, agentId))
      ) {
        agentDefinition = await claudeAgentDefinition(agentType, claudeHome);
      }
      if (eventName === 'PreToolUse') {
        const preliminary = sanitizeEvent(eventBody, { product });
        const codexAgentName = preliminary?.codexDefinition || preliminary?.codexWaitDefinition;
        if (codexAgentName) {
          codexDefinitionMetadata = await codexAgentDefinition(codexAgentName, claudeHome);
        }
      }

      let stateEventBody = eventBody;
      let preserveProjectionOrder = false;
      if (writerEnvelope) {
        const authorization = registrationRegistry.authorizeEvent(writerEnvelope);
        const checked = providerEventProjection.inspect(writerEnvelope, eventBody.session_id, registration.provider);
        if (!authorization.ok || eventBody.session_id !== authorization.sessionId || !checked.ok) {
          jsonResponse(response, 403, { error: 'Writer unavailable' });
          return;
        }
        const result = eventAdapter.project({ writer: writerEnvelope, sessionId: eventBody.session_id, event: eventBody });
        if (result.action === 'reject') {
          jsonResponse(response, 403, { error: 'Writer unavailable' });
          return;
        }
        if (result.action === 'duplicate') {
          jsonResponse(response, 202, { accepted: true, duplicate: true });
          return;
        }
        if (result.action === 'unknown') {
          jsonResponse(response, 202, { accepted: false, status: 'unknown', reason: result.reason });
          return;
        }
        preserveProjectionOrder = true;
        stateEventBody = { ...result.event };
        delete stateEventBody.nativeEvent;
        delete stateEventBody.nativeEventId;
      } else if (registrationRegistry.isRegisteredSessionId(eventBody.session_id)) {
        jsonResponse(response, 403, { error: 'Writer unavailable' });
        return;
      }
      state.captureFieldNames(stateEventBody);
      const eventMetadata = {
        product,
        sessionName,
        agentDefinition,
        codexAgentDefinition: codexDefinitionMetadata,
        ...(preserveProjectionOrder ? { preserveProjectionOrder: true } : {}),
      };
      state.addEvent(stateEventBody, eventMetadata);
      const event = sanitizeEvent(stateEventBody, eventMetadata);
      if (event?.hook_event_name === 'PostToolUse' && event.pullRequest && (
        (event.tool_name === 'Bash' && (event.ghPrCreateCommand || state.wasPullRequestCreate(event.session_id, event.tool_use_id))) ||
        isGithubCreatePullRequestTool(event.tool_name)
      )) {
        const registered = state.registerPullRequest(event.session_id, event.pullRequest, { cwd: stateEventBody.cwd, product }, event.hookAt);
        if (registered) void pullRequestTracker?.refreshRepo(registered.owner, registered.repo).catch(() => {});
      }
      if ((event?.hook_event_name === 'PostToolUse' || event?.hook_event_name === 'PostToolUseFailure') && (
        event.refreshPullRequests || state.wasPullRequestRefreshCommand(event.session_id, event.tool_use_id)
      )) void pullRequestTracker?.refreshAll().catch(() => {});
      if (event) answerDelivery.afterEvent(event);
      await state.waitForPersistence();
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

      if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'writer')) {
        jsonResponse(response, 403, { error: 'Writer unavailable' });
        return;
      }
      if (Object.hasOwn(body, 'session_id') || WRITER_CLAIM_FIELDS.some((field) => Object.hasOwn(body, field))) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const sessionId = resolveWriterSessionId(routeSessionId, body);
      if (!sessionId) {
        jsonResponse(response, 403, { error: 'Writer unavailable' });
        return;
      }
      const planFields = {
        tasks: ['kind', 'tasks', 'writer', 'ppid'],
        add_decision: ['kind', 'title', 'context', 'state', 'options', 'writer', 'ppid'],
        update_decision: ['kind', 'id', 'state', 'chosen', 'note', 'writer', 'ppid'],
      }[body.kind];
      if (!hasOnlyKeys(body, planFields)) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }

      if (body.kind === 'tasks') {
        const saved = state.setTasks(sessionId, body.tasks);
        answerDelivery.afterTasksWrite(sessionId, Date.parse(saved.updatedAt));
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
      await state.waitForPersistence();
      const decisions = decisionSummaries(state, sessionId);
      jsonResponse(response, 200, { decision: { id: decision.id, title: decision.title, state: decision.state }, decisions });
      return;
    }

    const prsPath = requestUrl.pathname.match(/^\/api\/sessions\/([^/]+)\/prs$/);
    if (request.method === 'POST' && prsPath) {
      if (request.headers['x-cockpit-secret'] !== info.secret) {
        jsonResponse(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (!validOriginForWrite(request)) {
        jsonResponse(response, 403, { error: 'Forbidden' });
        return;
      }
      const routeSessionId = prsPath[1];
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
      const isAddPullRequest = body?.kind === 'add_pr';
      const isSkipReview = body?.kind === 'skip_review';
      const pullRequest = isAddPullRequest ? parsePullRequestUrl(body.url) : null;
      const skipReviewKeys = ['headRefOid', 'kind', 'number', 'owner', 'reason', 'repo', 'writer'];
      const validSkipReview = isSkipReview && Object.keys(body).sort().join(',') === skipReviewKeys.join(',') &&
        validRepositoryPart(body.owner) && validRepositoryPart(body.repo) && Number.isSafeInteger(body.number) && body.number > 0 &&
        isCompleteCommitSha(body.headRefOid) && validText(body.reason, 2000);
      if ((!pullRequest && !validSkipReview) ||
        (body.ppid !== undefined && (!Number.isInteger(body.ppid) || body.ppid < 1)) ||
        (body.cwd !== undefined && (typeof body.cwd !== 'string' || body.cwd.length > 4096)) ||
        (body.claudeCodeSessionId !== undefined && body.claudeCodeSessionId !== null && typeof body.claudeCodeSessionId !== 'string')) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      if (!Object.hasOwn(body, 'writer')) {
        jsonResponse(response, 403, { error: 'Writer unavailable' });
        return;
      }
      if (Object.hasOwn(body, 'session_id') || WRITER_CLAIM_FIELDS.some((field) => Object.hasOwn(body, field))) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const addPullRequestFields = ['kind', 'url', 'writer', 'cwd', 'ppid'];
      if (!isSkipReview && !hasOnlyKeys(body, addPullRequestFields)) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const sessionId = resolveWriterSessionId(routeSessionId, body);
      if (!sessionId) {
        jsonResponse(response, 403, { error: 'Writer unavailable' });
        return;
      }
      if (isSkipReview) {
        const registration = state.pullRequestRegistrationForSession(sessionId, body.owner, body.repo, body.number);
        if (!registration) {
          jsonResponse(response, 404, { error: 'PR is not registered by this session' });
          return;
        }
        if (!pullRequestTracker?.refreshRepoFresh || !pullRequestTracker.mergeCandidate) {
          jsonResponse(response, 503, { error: 'Pull request state is unavailable' });
          return;
        }
        try {
          if (!pullRequestMergeManager?.setReviewSkip) {
            jsonResponse(response, 503, { error: 'Pull request state is unavailable' });
            return;
          }
          const result = await pullRequestMergeManager.setReviewSkip(registration, body.headRefOid, body.reason, {
            authorize: () => resolveWriterSessionId(routeSessionId, body) === sessionId,
          });
          if (!result.ok) {
            jsonResponse(response, result.status, { error: result.error });
            return;
          }
          jsonResponse(response, 200, { ...result.saved });
        } catch {
          jsonResponse(response, 502, { error: 'Pull request state could not be refreshed' });
        }
        return;
      }
      const product = productFromCwd(body.cwd);
      const registered = state.registerPullRequest(sessionId, pullRequest, { cwd: body.cwd, product });
      if (!registered) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      void pullRequestTracker?.refreshRepo(registered.owner, registered.repo).catch(() => {});
      jsonResponse(response, 200, { owner: registered.owner, repo: registered.repo, number: registered.number, url: registered.url });
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
  for (const key of Object.keys(process.env)) {
    if (isGithubCredentialEnvironmentVariable(key)) delete process.env[key];
  }
  const homeDir = cockpitHomeFromOptions(options);
  const claudeHome = claudeHomeFromOptions(options);
  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be between 0 and 65535');
  const dev = Boolean(options.dev);
  await fs.mkdir(homeDir, { recursive: true });
  if (options.truncateLog !== false) await fs.writeFile(path.join(homeDir, 'server.log'), '', { mode: 0o600 });

  const storageWriter = new AtomicJsonWriter(homeDir, {
    onFailure: (fileName) => logLine(homeDir, `${fileName} write failed`),
  });
  const state = options.state || await DashboardState.load(homeDir, { writer: storageWriter });
  state.attachWriter?.(storageWriter);
  const away = options.away || await AwayState.load(homeDir, fs, storageWriter);
  away.attachWriter?.(storageWriter);
  const routing = options.routing || await RoutingState.load(homeDir, { writer: storageWriter });
  const registrationRegistry = options.registrationRegistry || createRegistrationKernel().registry;
  state.isSessionAbsenceProtected = (sessionId) => registrationRegistry.isRegisteredSessionId(sessionId);
  const answerDelivery = options.answerDelivery || new DecisionAnswerDelivery({
    state,
    away,
    answerWaitMs: () => {
      const minutes = state.getDisplayPreferences?.().awayAnswerWaitMinutes;
      return Number.isInteger(minutes) ? minutes * 60_000 : ANSWER_WAIT_MS;
    },
    ...(options.answerDeliveryOptions || {}),
  });
  state.onSessionEndedByAbsence = (sessionId, endedAt) => answerDelivery.sessionEnded?.(sessionId, endedAt);
  state.onSessionReopened = (sessionId) => answerDelivery.sessionReopened?.(sessionId);
  const pullRequestTracker = options.pullRequestTracker || new PullRequestTracker({ state, ...(options.pullRequestOptions || {}) });
  const pullRequestMergeManager = options.pullRequestMergeManager || new PullRequestMergeManager({
    state,
    tracker: pullRequestTracker,
    answerDelivery,
    ...(options.pullRequestMergeOptions || {}),
  });
  pullRequestTracker.onMerged = (event) => pullRequestMergeManager.handleDetectedMerge?.(event);
  pullRequestTracker.onClosed = (event) => pullRequestMergeManager.handleDetectedClose?.(event);
  pullRequestTracker.onRefreshed = (owner, repo) => pullRequestMergeManager.checkReservations?.(owner, repo);
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
    routing,
    answerDelivery,
    pullRequestTracker,
    pullRequestMergeManager,
    userHome: options.userHome,
    codexAgentScriptExists: options.codexAgentScriptExists,
    crossReviewToolExists: options.crossReviewToolExists,
    openExternalUrl: options.openExternalUrl,
    webPath: options.webPath,
    manualDir: options.manualDir,
    dev,
    getServerInfo: () => info,
    markRequest: () => { lastRequestAt = Date.now(); },
    registrationRegistry,
    providerEventProjection: options.providerEventProjection,
    resolveActorCorrelation: options.resolveActorCorrelation,
    managedCollectors: options.managedCollectors,
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
  pullRequestTracker.start();
  pullRequestMergeManager.start?.();
  async function refreshSessionFiles() {
    const files = await listLiveSessionFiles(claudeHome);
    if (files) state.syncSessionFiles(files.map((file) => ({ ...file, product: productFromCwd(file.cwd) })));
    // 読めないときは生死を判定できないので同期せず、猶予の後の期限切れの片付けだけを進める。
    else state.pruneExpiredStoreRecords(Date.now());
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
      pullRequestMergeManager.close?.();
      pullRequestTracker.close();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await Promise.all([state.flushPersistence?.(), away.flushPersistence?.(), routing.flush?.()].filter(Boolean));
      await removeServerInfoIfOwned(homeDir, info);
      logLine(homeDir, 'stopped');
    })();
    return closing;
  }

  return { server, state, away, routing, answerDelivery, pullRequestTracker, pullRequestMergeManager, info, homeDir, close };
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
