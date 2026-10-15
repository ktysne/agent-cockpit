const EVENT_SUMMARY_INTERVAL_MS = 10 * 60_000;
const PERF_SUMMARY_INTERVAL_MS = 60_000;
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { AwayState, DashboardState } = require('./state');
const { RoutingState } = require('./routing');
const { PerfMetrics } = require('./perf-metrics');
const { AtomicJsonWriter, atomicWriteJson } = require('./json-storage');
const { isGithubCredentialEnvironmentVariable } = require('./credential-environment');
const { ANSWER_WAIT_MS, DecisionAnswerDelivery } = require('./decision-answers');
const { readTaskNotifications, readSessionModel, readTranscriptInterruption } = require('./transcript');
const { TASK_OUTPUT_MISSING, codexOutputLines, readTaskOutputFileAsync } = require('../shared/task-output');
const { parseCodexRunLine } = require('./events');
const { productFromCwd, claudeHomeFromOptions, cockpitHomeFromOptions } = require('./identity');
const { isShortSessionId } = require('./session-ids');
const { listLiveSessionFiles, readCodexSessionNames, findLiveSessionIdByPid, processIsAlive } = require('./session-files');
const { crossReviewToolExists: defaultCrossReviewToolExists, PullRequestTracker } = require('./pull-requests');
const { PullRequestMergeManager } = require('./pull-request-merge');
const { DEFAULT_PORT, APP_NAME } = require('./server-constants');
const { SECURITY_HEADERS, jsonResponse, textResponse, escapeHtmlAttribute, logLine } = require('./http-helpers');
const { validSessionId, validTasks, validDecisionOptions, validPlanInput } = require('./request-validation');
const { createServerRestart } = require('./routes/server-restart');
const { createReadRoutes } = require('./routes/read');
const { createHookRoutes } = require('./routes/hooks');
const { createPullRequestRoutes } = require('./routes/pull-requests');
const { createUiSessionRoutes } = require('./routes/ui-sessions');
const { createSettingsRoutes } = require('./routes/settings');
const { Diagnostics } = require('./diagnostics');
const { UpdateChecker } = require('./update-check');
const { readSourceCommit, readSourceState } = require('./source-revision');
const { recordClientEntries, MAX_DIAGNOSTICS_PER_EVENT, MAX_DIAGNOSTICS_BODY_BYTES } = require('../client/diagnostic-events');
const { importPendingHooks } = require('../client/hooks-pending');
const { version } = require('../../package.json');

const MAX_BODY_BYTES = 64 * 1024;
const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_SCAN_INTERVAL_MS = 10_000;
const INTERRUPT_TAIL_WAIT_MS = 2 * 60_000;

async function defaultCodexAgentScriptExists(scriptPath) {
  try {
    await fs.access(scriptPath);
    return true;
  } catch {
    return false;
  }
}

function requestHostIsLocal(request, port) {
  const host = request.headers.host;
  if (typeof host !== 'string') return false;
  const allowed = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  return allowed.has(host.toLowerCase());
}

function readJsonBody(request, maxBytes = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    const contentLength = Number(request.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      request.resume();
      reject(Object.assign(new Error('request body is too large'), { statusCode: 413 }));
      return;
    }

    const chunks = [];
    let size = 0;
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        request.removeAllListeners('data');
        request.resume();
        reject(Object.assign(new Error('request body is too large'), { statusCode: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (size <= maxBytes) resolve(Buffer.concat(chunks).toString('utf8'));
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

// 書き込み口の照合を 1 か所にまとめる。hook はフックと MCP 用の secret、ui と ui-optional-origin は画面用の uiSecret を求める。
// ui-optional-origin は Origin が無くても通す(トレイが呼ぶ /api/away だけ)。none は照合しない。
const WRITE_AUTH = Object.freeze({
  hook: { secret: (info) => info.secret, origin: (request) => validOriginForWrite(request) },
  ui: { secret: (info) => info.uiSecret, origin: validRequiredUiOrigin },
  'ui-optional-origin': { secret: (info) => info.uiSecret, origin: validUiOrigin },
});

function authFailure(auth, request, info) {
  if (auth === 'none') return null;
  const check = WRITE_AUTH[auth];
  if (!check) throw new Error(`unknown auth kind: ${auth}`);
  if (request.headers['x-cockpit-secret'] !== check.secret(info)) return { status: 401, error: 'Unauthorized' };
  return check.origin(request, info.port) ? null : { status: 403, error: 'Forbidden' };
}

function findRoute(routes, method, pathname) {
  for (const route of routes) {
    if (route.method !== method) continue;
    if (typeof route.path === 'string') {
      if (route.path === pathname) return { route, params: [] };
      continue;
    }
    const params = pathname.match(route.path);
    if (params) return { route, params };
  }
  return null;
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
    findSessionIdByPid = (pid) => findLiveSessionIdByPid(pid, claudeHome),
    pullRequestTracker,
    pullRequestMergeManager,
    codexAgentScriptExists = defaultCodexAgentScriptExists,
    crossReviewToolExists = defaultCrossReviewToolExists,
    openExternalUrl = defaultOpenExternalUrl,
  } = options;
  const webPath = options.webPath || path.join(__dirname, '..', 'web', 'index.html');

  const ctx = {
    updateChecker: options.updateChecker,
    getRuntime: options.getRuntime,
    getSourceState: options.getSourceState,
    appVersion: options.appVersion,
    sourceRoot: options.sourceRoot,
    uiTemplate: options.uiTemplate,
    diagnostics: options.diagnostics,
    eventCounts: options.eventCounts,
    perf: options.perf,
    stateCacheNow: options.stateCacheNow,
    homeDir,
    claudeHome,
    userHome,
    state,
    away,
    routing,
    answerDelivery,
    dev,
    findSessionIdByPid,
    pullRequestTracker,
    pullRequestMergeManager,
    codexAgentScriptExists,
    crossReviewToolExists,
    openExternalUrl,
    webPath,
    scheduleTaskNotifications: (sessionId) => options.scheduleTaskNotifications?.(sessionId),
    scheduleSessionModel: (event) => options.scheduleSessionModel?.(event),
  };
  const serverRestart = createServerRestart(ctx, options.serverRestart);
  ctx.restartAvailable = serverRestart.restartAvailable;
  const { handleHealth, handleState, handleTrayState, handleContext, handleDevFields, handleIndex, restartRequired } = createReadRoutes(ctx);
  ctx.restartRequired = restartRequired;
  const { handleHookAnswers, handleEvents, handlePlan, handleSessionPullRequests } = createHookRoutes(ctx);
  const { handleReviewSkip, handlePullRequestAction, handleMergeResultClose, handleRepositoryUnregister } = createPullRequestRoutes(ctx);
  const {
    handleEstimate, handleHiddenSessions, handleRecordDeletions, handleClosedTasks,
    handleClosedAgents, handleSeen, handleDisplay, handleDecisionAnswer,
  } = createUiSessionRoutes(ctx);
  const { handleAwayState, handleAway, handleRouting, handleOpenUrl, handleUpdateCheck } = createSettingsRoutes(ctx);

  const invalidSessionId = { valid: (params) => validSessionId(params[1]), status: 400, error: 'Invalid session id' };
  const unknownSessionId = { valid: (params) => isShortSessionId(params[1]), status: 404, error: 'Session not found' };

  // method と path の両方が一致した最初の行を使う。
  // 本文は body が 'json' の行だけが読む。estimate は本文を使わないので 'none' にする。
  const routes = [
    { method: 'POST', path: '/api/server/restart', auth: 'ui', body: 'json', handler: serverRestart.handleServerRestart },
    { method: 'POST', path: '/api/diagnostics', auth: 'hook', body: 'json', maxBytes: MAX_DIAGNOSTICS_BODY_BYTES,
      handler: async ({ request, response, body }) => {
        if (!Array.isArray(body?.entries) || body.entries.length > MAX_DIAGNOSTICS_PER_EVENT) {
          jsonResponse(response, 400, { error: 'Invalid diagnostics' });
          return;
        }
        recordClientEntries(options.diagnostics, body.entries, request.diagnosticSender);
        jsonResponse(response, 202, { accepted: true });
      } },
    { method: 'GET', path: '/api/diagnostics', auth: 'none', body: 'none', handler: async ({ response, request }) => {
      const run = new URL(request.url, 'http://localhost').searchParams.get('run');
      try {
        const { version, commit } = options.getRuntime();
        const responseRuntime = { version, commit, sourceState: options.getSourceState() };
        if (run === null) {
          jsonResponse(response, 200, { runs: await options.diagnostics.listRuns(), version, responseRuntime });
        } else {
          const entries = await options.diagnostics.readRun(run);
          jsonResponse(response, 200, { entries, version,
            runtime: options.diagnostics.runtimeOfEntries(run, entries), responseRuntime });
        }
      } catch (error) {
        request.setDiagnosticError?.(error);
        jsonResponse(response, error.statusCode || 500, { error: 'Cannot read diagnostics' });
      }
    } },
    { method: 'POST', path: '/api/diagnostics/delete', auth: 'ui', body: 'json', handler: async ({ request, response, body }) => {
      if (!body || typeof body !== 'object' || Array.isArray(body)
          || !(Object.keys(body).length === 1 && (typeof body.run === 'string' || body.all === true))) {
        jsonResponse(response, 400, { error: 'Invalid deletion' });
        return;
      }
      try {
        await options.diagnostics.deleteRuns(body);
        jsonResponse(response, 200, { ok: true });
      } catch (error) {
        request.setDiagnosticError?.(error);
        jsonResponse(response, error.statusCode || 500, { error: 'Cannot delete diagnostics' });
      }
    } },
    { method: 'GET', path: '/health', auth: 'none', body: 'none', handler: handleHealth },
    { method: 'GET', path: '/api/state', auth: 'none', body: 'none', handler: handleState },
    { method: 'GET', path: '/api/tray', auth: 'none', body: 'none', handler: handleTrayState },
    { method: 'GET', path: '/api/away', auth: 'none', body: 'none', handler: handleAwayState },
    { method: 'GET', path: /^\/api\/sessions\/([^/]+)\/context$/, auth: 'none', body: 'none', idCheck: invalidSessionId, handler: handleContext },
    { method: 'GET', path: '/api/dev/fields', auth: 'none', body: 'none', handler: handleDevFields },
    { method: 'POST', path: '/api/hooks/answers', auth: 'hook', body: 'json', handler: handleHookAnswers },
    // decision id の復号の失敗は、本文を読んだ後にハンドラーで 400 にする。
    { method: 'POST', path: /^\/api\/decisions\/([^/]+)\/answer$/, auth: 'ui', body: 'json', handler: handleDecisionAnswer },
    { method: 'POST', path: '/api/pull-requests/review-skip', auth: 'ui', body: 'json', handler: handleReviewSkip },
    { method: 'POST', path: /^\/api\/pull-requests\/(merge|reserve|cancel-reservation|conflict-request)$/, auth: 'ui', body: 'json', handler: handlePullRequestAction },
    { method: 'GET', path: '/', auth: 'none', body: 'none', handler: handleIndex },
    { method: 'POST', path: /^\/api\/sessions\/([^/]+)\/estimate$/, auth: 'ui', body: 'none', idCheck: unknownSessionId, handler: handleEstimate },
    { method: 'POST', path: '/api/record-deletions', auth: 'ui', body: 'json', handler: handleRecordDeletions },
    { method: 'POST', path: '/api/hidden-sessions', auth: 'ui', body: 'json', handler: handleHiddenSessions },
    { method: 'POST', path: '/api/display', auth: 'ui', body: 'json', handler: handleDisplay },
    { method: 'POST', path: '/api/pull-requests/merge-result/close', auth: 'ui', body: 'json', handler: handleMergeResultClose },
    { method: 'POST', path: '/api/pull-requests/repository/unregister', auth: 'ui', body: 'json', handler: handleRepositoryUnregister },
    { method: 'POST', path: '/api/seen', auth: 'ui', body: 'json', handler: handleSeen },
    { method: 'POST', path: '/api/closed-tasks', auth: 'ui', body: 'json', handler: handleClosedTasks },
    { method: 'POST', path: '/api/closed-agents', auth: 'ui', body: 'json', handler: handleClosedAgents },
    { method: 'POST', path: '/api/away', auth: 'ui-optional-origin', body: 'json', handler: handleAway },
    { method: 'POST', path: '/api/routing', auth: 'ui', body: 'json', handler: handleRouting },
    { method: 'POST', path: '/api/open-url', auth: 'ui', body: 'json', handler: handleOpenUrl },
    { method: 'POST', path: '/api/update/check', auth: 'ui', body: 'json', handler: handleUpdateCheck },
    { method: 'POST', path: '/api/events', auth: 'hook', body: 'json', handler: handleEvents },
    { method: 'POST', path: /^\/api\/sessions\/([^/]+)\/plan$/, auth: 'hook', body: 'json', idCheck: invalidSessionId, handler: handlePlan },
    { method: 'POST', path: /^\/api\/sessions\/([^/]+)\/prs$/, auth: 'hook', body: 'json', idCheck: invalidSessionId, handler: handleSessionPullRequests },
  ];

  // 順序は Host、markRequest、ルートの決定、秘密値(401)、Origin(403)、ID の検査、本文で固定する。
  // 外部の Host の要求でアイドル終了を延ばさず、照合の前に ID や本文の妥当性を応答して漏らさないため。
  return async (request, response) => {
    const info = getServerInfo();
    let requestError;
    let diagnosticAuth = 'none';
    let diagnosticPath = 'unknown';
    let diagnosticRecorded = false;
    const recordFailure = (status) => {
      if (status < 400 || diagnosticRecorded) return;
      diagnosticRecorded = true;
      const auth = WRITE_AUTH[diagnosticAuth];
      const supplied = request.headers['x-cockpit-secret'];
      options.diagnostics?.record('error', 'server', 'request.failed', {
        method: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(request.method) ? request.method : 'other',
        path: diagnosticPath, status, error: requestError,
        secret: supplied === undefined ? 'missing' : info && (auth ? supplied === auth.secret(info)
          : supplied === info.secret || supplied === info.uiSecret) ? 'match' : 'mismatch',
        origin: request.headers.origin === undefined ? 'missing' : info && (auth
          ? auth.origin(request, info.port) : validRequiredUiOrigin(request, info.port)) ? 'match' : 'mismatch',
      });
    };
    response.once('finish', () => recordFailure(response.statusCode));
    request.setDiagnosticError = error => { requestError = error; if (response.headersSent) recordFailure(500); };
    if (!info || !requestHostIsLocal(request, info.port)) {
      textResponse(response, 400, 'Invalid Host');
      return;
    }
    markRequest();

    const requestUrl = new URL(request.url, `http://127.0.0.1:${info.port}`);

    const matched = findRoute(routes, request.method, requestUrl.pathname);
    const diagnosticRoute = matched || findRoute(routes, 'GET', requestUrl.pathname) || findRoute(routes, 'POST', requestUrl.pathname);
    if (diagnosticRoute) {
      diagnosticAuth = diagnosticRoute.route.auth;
      diagnosticPath = typeof diagnosticRoute.route.path === 'string' ? diagnosticRoute.route.path
        : requestUrl.pathname.replace(/^\/api\/(sessions|decisions)\/[^/]+/, '/api/$1/:id');
    }
    if (matched) {
      const { route, params } = matched;
      const auth = route.method === 'POST' && route.path === '/api/diagnostics'
        && request.headers['x-cockpit-secret'] === info.uiSecret ? 'ui' : route.auth;
      diagnosticAuth = auth;
      request.diagnosticSender = auth === 'ui' ? 'web' : 'mcp';
      const failure = authFailure(auth, request, info);
      if (failure) {
        jsonResponse(response, failure.status, { error: failure.error });
        return;
      }
      if (route.idCheck && !route.idCheck.valid(params)) {
        jsonResponse(response, route.idCheck.status, { error: route.idCheck.error });
        return;
      }
      let body;
      if (route.body === 'json') {
        try {
          body = JSON.parse(await readJsonBody(request, route.maxBytes));
        } catch (error) {
          requestError = error;
          jsonResponse(response, error.statusCode || 400, { error: error.statusCode === 413 ? 'Payload too large' : 'Invalid JSON' });
          return;
        }
      }
      try { await route.handler({ request, response, info, params, body }); }
      catch (error) { requestError = error; throw error; }
      return;
    }

    if (requestUrl.pathname.startsWith('/api/')) {
      textResponse(response, 405, 'Method Not Allowed');
      return;
    }
    textResponse(response, 404, 'Not Found');
  };
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

// フォルダーが無いのは Claude Code を使わない環境なので止めてよいが、読めないときはセッションがあり得るので止めない。
async function hasSessionJsonFiles(claudeHome) {
  try {
    const entries = await fs.readdir(path.join(claudeHome, 'sessions'), { withFileTypes: true });
    return entries.some((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json');
  } catch (error) {
    return error.code !== 'ENOENT';
  }
}

// thread-writer-locks は公開仕様ではないため、読めないときはロックで判断しない。
// デスクトップのアーカイブでは SessionEnd が届かないため、ロックの消失で終了を判断する。
async function listCodexThreadLocks(codexHome) {
  try {
    const entries = await fs.readdir(path.join(codexHome, 'thread-writer-locks'), { withFileTypes: true });
    return new Set(entries.filter((entry) => entry.isFile() && !entry.name.startsWith('.') && entry.name.endsWith('.lock'))
      .map((entry) => entry.name.slice(0, -5)));
  } catch {
    return null;
  }
}

async function startServer(options = {}) {
  for (const key of Object.keys(process.env)) {
    if (isGithubCredentialEnvironmentVariable(key)) delete process.env[key];
  }
  const homeDir = cockpitHomeFromOptions(options);
  const claudeHome = claudeHomeFromOptions(options);
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const codexSessionNameCache = {};
  const port = options.port === undefined ? DEFAULT_PORT : Number(options.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('port must be between 0 and 65535');
  const dev = Boolean(options.dev);
  const appVersion = options.appVersion === undefined ? version : options.appVersion;
  const sourceRoot = options.sourceRoot || path.join(__dirname, '../..');
  const commit = await (options.readSourceCommit || readSourceCommit)(sourceRoot);
  const webPath = options.webPath || path.join(__dirname, '..', 'web', 'index.html');
  let uiTemplate = null;
  if (!dev) {
    try { uiTemplate = await fs.readFile(webPath); } catch {}
  }
  let runtime = null;
  let sourceState = 'pending';
  await fs.mkdir(homeDir, { recursive: true });

  const storageWriter = new AtomicJsonWriter(homeDir, {
    onFailure: (fileName) => logLine(homeDir, `${fileName} write failed`),
  });
  const perf = new PerfMetrics();
  const state = options.state || await DashboardState.load(homeDir, { writer: storageWriter, perf });
  const diagnostics = new Diagnostics({ ...options.diagnosticsOptions, homeDir, userHome: options.userHome,
    getLevel: () => state.getDisplayPreferences?.()?.diagnosticsLevel || 'info' });
  state.diagnostics = diagnostics;
  const updateChecker = options.updateCheck ? new UpdateChecker({ diagnostics, ...options.updateCheck }) : null;
  state.attachWriter?.(storageWriter);
  const away = options.away || await AwayState.load(homeDir, fs, storageWriter);
  away.attachWriter?.(storageWriter);
  const routing = options.routing || await RoutingState.load(homeDir, { writer: storageWriter });
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
  const pullRequestTracker = options.pullRequestTracker || new PullRequestTracker({ state, diagnostics, ...(options.pullRequestOptions || {}) });
  const pullRequestMergeManager = options.pullRequestMergeManager || new PullRequestMergeManager({
    state,
    tracker: pullRequestTracker,
    diagnostics,
    answerDelivery,
    ...(options.pullRequestMergeOptions || {}),
  });
  pullRequestTracker.onMerged = (event) => pullRequestMergeManager.handleDetectedMerge?.(event);
  pullRequestTracker.onClosed = (event) => pullRequestMergeManager.handleDetectedClose?.(event);
  pullRequestTracker.onRefreshed = (owner, repo) => pullRequestMergeManager.checkReservations?.(owner, repo);
  let info = null;
  let closing = null;
  let lastRequestAt = Date.now();
  const notificationTimers = new Map();
  const notificationReads = new Map();
  const notificationReader = options.readTaskNotifications || readTaskNotifications;
  const modelTimers = new Map();
  const modelReads = new Map();
  const observedModelSessions = new Map();
  const modelReader = options.readSessionModel || readSessionModel;
  function scheduleSessionModel(event) {
    const sessionId = event.session_id;
    const known = state.sessions.has(sessionId) || Boolean(state.sessionFileFor(sessionId));
    if (closing || !known || state.providerForSession(sessionId) === 'codex' || event.agent_id) return;
    const cwd = state.sessionFileFor(sessionId)?.cwd;
    const firstSeen = !observedModelSessions.has(sessionId) || observedModelSessions.get(sessionId) !== cwd;
    observedModelSessions.set(sessionId, cwd);
    if (!firstSeen && !['Stop', 'SessionStart'].includes(event.hook_event_name)) return;
    if (modelTimers.has(sessionId)) return;
    const timer = setTimeout(async () => {
      await modelReads.get(sessionId);
      modelTimers.delete(sessionId);
      if (closing) return;
      const reading = (async () => {
        try {
          const model = await modelReader(claudeHome, state.sessionFileFor(sessionId)?.cwd, sessionId);
          if (!closing) state.recordSessionModel(sessionId, model);
        } catch {}
      })().finally(() => modelReads.delete(sessionId));
      modelReads.set(sessionId, reading);
      await reading;
    }, options.sessionModelDelayMs ?? 500);
    timer.unref();
    modelTimers.set(sessionId, timer);
  }
  function needsTaskNotifications(sessionId) {
    const session = state.sessionView(sessionId);
    if (!session || session.provider === 'codex') return false;
    return state.backgroundCodexAgents(sessionId).length > 0 ||
      (['待機中(サブエージェント稼働中)', '中断'].includes(session.status) &&
        session.agents.some((agent) => !agent.isCodex && agent.active));
  }
  // 読めた出力は task-id ごとに使い回し、読めなかった通知は次の照合で未試行の通知の後に読む。
  // 読み取りの上限を、同じ通知の読み直しで使い切らないため。
  const taskOutputCache = new Map();
  function reconcileTaskNotifications(sessionId) {
    if (closing || !needsTaskNotifications(sessionId)) return Promise.resolve();
    if (notificationReads.has(sessionId)) return notificationReads.get(sessionId);
    const reading = (async () => {
      try {
        const notifications = await notificationReader(claudeHome, state.transcriptCwdFor(sessionId), sessionId);
        if (closing || !needsTaskNotifications(sessionId)) return;
        if (['待機中(サブエージェント稼働中)', '中断'].includes(state.sessions.get(sessionId)?.status)) {
          state.applyTaskNotifications(sessionId, notifications);
        }
        let outputReads = 0;
        const cache = taskOutputCache.get(sessionId) || { outputs: new Map(), failed: new Set() };
        taskOutputCache.set(sessionId, cache);
        const ordered = [...notifications].sort(([a], [b]) => cache.failed.has(a) - cache.failed.has(b));
        for (const [taskId, notification] of ordered) {
          if (!['completed', 'failed', 'killed', 'stopped'].includes(notification.status)) continue;
          const candidates = () => state.backgroundCodexAgents(sessionId).filter(agent =>
            (!agent.backgroundTaskId || agent.backgroundTaskId === taskId) &&
            !(Date.parse(notification.recordedAt) < Date.parse(agent.startedAt)));
          if (!candidates().length) continue;
          const end = { taskId, status: notification.status };
          if (notification.outputFile) {
            if (!cache.outputs.has(taskId)) {
              // 出力を読めない通知は記録せず、次の照合へ繰り越す。出力に waiting があれば行を閉じてはならないため。
              if (outputReads >= 8) continue;
              outputReads += 1;
              const output = await (options.readTaskOutput || readTaskOutputFileAsync)(notification.outputFile);
              if (output === null) {
                cache.failed.add(taskId);
                continue;
              }
              cache.failed.delete(taskId);
              cache.outputs.set(taskId, output === TASK_OUTPUT_MISSING ? output : codexOutputLines(output));
            }
            const cached = cache.outputs.get(taskId);
            if (cached === TASK_OUTPUT_MISSING) end.outputMissing = true;
            else end.codexOutput = cached;
          }
          if (closing) return;
          const runId = parseCodexRunLine(end.codexOutput?.runLine);
          if (candidates().some(agent => agent.backgroundTaskId === taskId || (!agent.backgroundTaskId && runId && agent.runId === runId))) {
            state.recordBackgroundTaskEnd(sessionId, end);
          }
        }
        if (!state.backgroundCodexAgents(sessionId).length) taskOutputCache.delete(sessionId);
      } catch {}
    })().finally(() => notificationReads.delete(sessionId));
    notificationReads.set(sessionId, reading);
    return reading;
  }
  const interruptReader = options.readTranscriptInterruption || readTranscriptInterruption;
  const interruptReads = new Map();
  const interruptChecked = new Map();
  // Claude は中断で Stop を送らないので、ファイルが idle になったセッションの transcript の末尾で中断を確かめる。
  function reconcileInterruption(sessionId) {
    if (closing || interruptReads.has(sessionId)) return interruptReads.get(sessionId) || Promise.resolve();
    const candidate = state.interruptCandidate(sessionId);
    if (!candidate || interruptChecked.get(sessionId) === candidate.statusUpdatedAt) return Promise.resolve();
    const reading = (async () => {
      try {
        const result = await interruptReader(claudeHome, candidate.cwd, sessionId);
        // 読めなかったときは同じ状態でもう一度読む。
        if (closing || !result) return;
        const recordedAt = Date.parse(result.recordedAt);
        // 中断の行は idle より遅れて書かれることがあるので、末尾が idle より古い間は猶予の間だけ読み直す。
        const statusAt = Date.parse(candidate.statusUpdatedAt);
        const awaitingTail = !result.interrupted && !(recordedAt >= statusAt) && Date.now() - statusAt < INTERRUPT_TAIL_WAIT_MS;
        if (!awaitingTail) interruptChecked.set(sessionId, candidate.statusUpdatedAt);
        if (!result.interrupted || !Number.isFinite(recordedAt) || recordedAt < candidate.lastPromptAt) return;
        if (state.interruptCandidate(sessionId)?.statusUpdatedAt !== candidate.statusUpdatedAt) return;
        state.recordInterruption(sessionId, recordedAt);
        scheduleTaskNotifications(sessionId);
      } catch {}
    })().finally(() => interruptReads.delete(sessionId));
    interruptReads.set(sessionId, reading);
    return reading;
  }
  function scheduleTaskNotifications(sessionId) {
    if (closing || notificationTimers.has(sessionId) || !needsTaskNotifications(sessionId)) return;
    const timer = setTimeout(() => {
      notificationTimers.delete(sessionId);
      void reconcileTaskNotifications(sessionId);
    }, options.taskNotificationDelayMs ?? 500);
    timer.unref();
    notificationTimers.set(sessionId, timer);
  }
  const server = options.server || http.createServer((request, response) => {
    Promise.resolve(handler(request, response)).catch((error) => {
      request.setDiagnosticError?.(error);
      logLine(homeDir, 'request failed');
      if (!response.headersSent) jsonResponse(response, 500, { error: 'Internal Server Error' });
      else response.destroy();
    });
  });
  const eventCounts = {};
  const eventSummaryTimer = setInterval(() => {
    diagnostics.record('info', 'server', 'event.summary', { ...eventCounts });
    for (const event of Object.keys(eventCounts)) delete eventCounts[event];
  }, options.eventSummaryIntervalMs ?? EVENT_SUMMARY_INTERVAL_MS);
  eventSummaryTimer.unref();
  const perfSummaryTimer = setInterval(() => {
    diagnostics.record('info', 'server', 'server.perf', perf.summary());
  }, options.perfSummaryIntervalMs ?? PERF_SUMMARY_INTERVAL_MS);
  perfSummaryTimer.unref();
  const handler = createRequestHandler({
    serverRestart: options.serverRestart,
    updateChecker,
    appVersion,
    getRuntime: () => runtime,
    getSourceState: () => sourceState,
    eventCounts,
    perf,
    diagnostics,
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
    webPath,
    uiTemplate,
    sourceRoot,
    stateCacheNow: options.stateCacheNow,
    dev,
    scheduleTaskNotifications,
    scheduleSessionModel,
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
    runtime = Object.freeze({ version: appVersion, commit, pid: info.pid, startedAt: info.startedAt });
    diagnostics.setRuntime({ ...runtime, sourceState });
    await atomicWriteServerInfo(homeDir, info);
    try {
      const logPath = path.join(homeDir, 'server.log');
      if ((await fs.stat(logPath)).size > (options.maxServerLogBytes ?? 1024 * 1024)) {
        await fs.rename(logPath, `${logPath}.1`);
      }
    } catch {}
  } catch (error) {
    if (server.listening) await new Promise((resolve) => server.close(resolve));
    throw error;
  }

  logLine(homeDir, `started on 127.0.0.1:${info.port}`);
  await diagnostics.record('mark', 'server', 'server.start', {
    pid: info.pid, port: info.port, version: runtime.version, commit: runtime.commit,
  });
  const sourceReading = Promise.resolve().then(() => (options.readSourceState || readSourceState)({
    root: sourceRoot, version: runtime.version, commit: runtime.commit,
  })).catch(() => 'unknown').then(async result => {
    sourceState = result;
    diagnostics.setRuntime({ ...runtime, sourceState });
    await diagnostics.record('mark', 'server', 'server.source', { sourceState });
  });
  pullRequestTracker.start();
  updateChecker?.start();
  pullRequestMergeManager.start?.();
  async function refreshSessionFiles(now = Date.now()) {
    await importPendingHooks(homeDir, diagnostics).catch(() => {});
    const files = await listLiveSessionFiles(claudeHome, { isAlive: options.isAlive || processIsAlive });
    const locks = await listCodexThreadLocks(codexHome);
    const codexNames = await readCodexSessionNames(codexHome, codexSessionNameCache);
    const codexFiles = state.liveCodexSessionFiles(options.isAlive || processIsAlive, locks).map((file) => {
      const name = codexNames?.get(file.session_id);
      return typeof name === 'string' ? { ...file, name } : file;
    });
    state.syncSessionFiles([...(files || []), ...codexFiles]
      .map((file) => ({ ...file, product: productFromCwd(file.cwd) })), now, { codexOnly: files === null });
    // Claude の一覧を読めないときは生死を保留し、保存の期限切れの片付けだけを進める。
    if (!files) state.pruneExpiredStoreRecords(now);
    for (const session of state.snapshot().sessions) scheduleSessionModel(session);
    for (const sessionId of interruptChecked.keys()) {
      if (!state.sessionFileFor(sessionId)) interruptChecked.delete(sessionId);
    }
    await Promise.all([...state.sessions.keys()].map((sessionId) => reconcileInterruption(sessionId)));
  }
  await refreshSessionFiles().catch(() => {});
  for (const session of state.snapshot().sessions) scheduleTaskNotifications(session.session_id);
  const notificationTimer = setInterval(() => {
    state.pruneExpiredStoreRecords(Date.now());
    for (const session of state.snapshot().sessions) void reconcileTaskNotifications(session.session_id);
  }, 60_000);
  notificationTimer.unref();
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
      clearInterval(eventSummaryTimer);
      clearInterval(perfSummaryTimer);
      perf.close();
      clearInterval(idleTimer);
      clearInterval(sessionScanTimer);
      clearInterval(notificationTimer);
      for (const timer of notificationTimers.values()) clearTimeout(timer);
      notificationTimers.clear();
      for (const timer of modelTimers.values()) clearTimeout(timer);
      modelTimers.clear();
      await Promise.all(modelReads.values());
      await Promise.all(notificationReads.values());
      await Promise.all(interruptReads.values());
      answerDelivery.close();
      pullRequestMergeManager.close?.();
      pullRequestTracker.close();
      await updateChecker?.close();
      await sourceReading;
      if (server.listening) await new Promise((resolve) => server.close(resolve));
      await Promise.all([state.flushPersistence?.(), away.flushPersistence?.(), routing.flush?.()].filter(Boolean));
      await removeServerInfoIfOwned(homeDir, info);
      logLine(homeDir, 'stopped');
      await diagnostics.record('mark', 'server', 'server.stop', { pid: info.pid });
      await diagnostics.flush();
    })();
    return closing;
  }

  return { server, state, away, routing, answerDelivery, pullRequestTracker, pullRequestMergeManager, updateChecker, diagnostics, info, homeDir, close, refreshSessionFiles };
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
  startServer({ ...parseArguments(process.argv.slice(2)), updateCheck: {}, serverRestart: {} })
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
  hasSessionJsonFiles,
  createRequestHandler,
  startServer,
  parseArguments,
};
