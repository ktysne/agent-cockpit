const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const http = require('node:http');
const path = require('node:path');
const { AwayState, DashboardState } = require('./state');
const { RoutingState } = require('./routing');
const { AtomicJsonWriter, atomicWriteJson } = require('./json-storage');
const { isGithubCredentialEnvironmentVariable } = require('./credential-environment');

const { ANSWER_WAIT_MS, DecisionAnswerDelivery } = require('./decision-answers');

const { readTaskNotifications } = require('./transcript');
const { productFromCwd, claudeHomeFromOptions, cockpitHomeFromOptions } = require('./identity');
const { listLiveSessionFiles } = require('./session-files');
const { createRegistrationKernel } = require('./conversation-registry');
const { createClaudeLocalIssuer } = require('./claude-local-issuer');
const { createProviderEventProjection, createProviderEventAdapter } = require('./provider-event-projection');

const { crossReviewToolExists: defaultCrossReviewToolExists, PullRequestTracker } = require('./pull-requests');
const { PullRequestMergeManager } = require('./pull-request-merge');

const { isShortSessionId } = require('./session-ids');
const {
  DEFAULT_PORT, APP_NAME, MAX_BODY_BYTES, MAX_NATIVE_PENDING_REQUESTS,
  IDLE_TIMEOUT_MS, SESSION_SCAN_INTERVAL_MS, MANUAL_CONTENT_TYPES,
} = require('./server-constants');

const DEFAULT_MANUAL_DIR = path.join(__dirname, '..', '..', 'manual');

async function defaultCodexAgentScriptExists(scriptPath) {
  try {
    await fs.access(scriptPath);
    return true;
  } catch {
    return false;
  }
}

const { SECURITY_HEADERS, jsonResponse, textResponse, escapeHtmlAttribute, logLine } = require('./http-helpers');

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

const {
  validSessionId, validText, validTasks, validDecisionOptions,
  validPlanInput, hasExactKeys, sameQuestionIdentity, questionErrorStatus,
  validScopedIdentifier, instructionProjection, instructionErrorStatus,
} = require('./request-validation');

function lateInstructionIds(internalQuestionId, index, digest) {
  const key = crypto.createHash("sha256").update(JSON.stringify([internalQuestionId, index, digest])).digest("hex");
  return { deliveryAttemptId: 'late-delivery-' + key, logicalMessageId: 'late-message-' + key, revision: 0 };
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

const { createReadRoutes } = require('./routes/read');
const { createOwnedExecutionsRoutes } = require('./routes/owned-executions');
const { createQuestionsRoutes } = require('./routes/questions');
const { createSettingsRoutes } = require('./routes/settings');
const { createHookRoutes } = require('./routes/hooks');
const { createUiSessionRoutes } = require('./routes/ui-sessions');
const { createPullRequestRoutes } = require('./routes/pull-requests');
const { createInstructionsRoutes } = require('./routes/instructions');

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
    claudeIssuer = null,
    questionService = null,
    questionServiceReady = true,
    pendingQuestionLosses = new Set(),
    managedCollectors = [],
    launchRegistry = null,
    instructionService = null,
    instructionServiceReady = false,
    instructionTargetState = null,
    ownedExecutionSnapshot = null,
    stopOwnedExecution = null,
    pendingInstructionLosses = new Set(),
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
    resolveActorCorrelation: options.resolveActorCorrelation || claudeIssuer?.resolveActorCorrelation || null,
  });
  const providerEventAdapters = new Map(['claude', 'codex'].map((provider) => [
    provider, createProviderEventAdapter(provider, providerEventProjection),
  ]));
  function resolveWriterSessionId(routeId, body) {
    const authorization = registrationRegistry.authorizeWriter(body.writer);
    if (!authorization.ok || !validSessionId(authorization.sessionId)) return null;
    if (routeId !== 'pending' && authorization.sessionId !== routeId) return null;
    return authorization.sessionId;
  }

  // Claude の writer は、書き込みの前に親のセッションが変わっていないかを一覧の読み直しで確かめる。
  // 失効の検出を待つ間に、古いセッションへ書き込めてしまうためである。
  async function resolveFreshWriterSessionId(routeId, body) {
    if (!resolveWriterSessionId(routeId, body)) return null;
    if (claudeIssuer) await claudeIssuer.revalidateWriter(body.writer);
    return resolveWriterSessionId(routeId, body);
  }

  // フックが申告した親プロセスを照合し、通ればフック用の writer と表示用の sessionId を本文に付ける。
  // 照合が通らない申告と、issuer の無い構成(registry を注入した構成)では申告を捨て、未登録の Claude 向けの観測の経路で扱う。
  // 観測の経路は登録済みの sessionId を拒否するので、照合に失敗したフックが登録済みの期間へ書くことはない。
  async function applyClaudeLineage(body) {
    const lineage = body.claudeLineage;
    if (Object.hasOwn(body, 'writer')) return { ok: false, reason: 'claude_writer_conflict' };
    const { claudeLineage: _ignored, ...withoutLineage } = body;
    if (!claudeIssuer) return { ok: true, body: withoutLineage };
    if (!lineage || typeof lineage !== 'object' || Array.isArray(lineage) || Object.keys(lineage).length !== 1 ||
        !Number.isSafeInteger(lineage.ppid) || lineage.ppid < 1) {
      logLine(homeDir, 'claude writer rejected: source=hook reason=claude_parent_unverified ppid=invalid');
      return { ok: true, body: withoutLineage };
    }
    const attached = await claudeIssuer.attachHookWriter({ ppid: lineage.ppid, sessionId: body.session_id });
    if (!attached.ok) return { ok: true, body: withoutLineage };
    const next = { ...body, writer: attached.writer, session_id: attached.sessionId };
    delete next.claudeLineage;
    return { ok: true, body: next };
  }

  function queueQuestionResponseLost(internalQuestionId) {
    if (!questionService?.reportResponseLost || !internalQuestionId) return;
    const operation = Promise.resolve().then(() => questionService.reportResponseLost(internalQuestionId)).catch(() => {});
    pendingQuestionLosses.add(operation);
    void operation.finally(() => pendingQuestionLosses.delete(operation));
  }

  function questionRegistrationLink(question, snapshot = registrationRegistry.snapshot()) {
    if (!snapshot || !Array.isArray(snapshot.executions) || !Array.isArray(snapshot.conversations)) return null;
    const execution = snapshot.executions.find((item) =>
      item.executionId === question.executionId && item.conversationId === question.conversationId);
    const conversation = snapshot.conversations.find((item) => item.conversationId === question.conversationId);
    if (!execution || !conversation || !sameQuestionIdentity(question.identity, conversation.identity)) return null;
    return { execution, conversation, sessionId: execution.sessionId };
  }

  function registrationSnapshotForInstructions() {
    if (!registrationRegistry || typeof registrationRegistry.snapshot !== "function") return null;
    try {
      const snapshot = registrationRegistry.snapshot();
      if (snapshot instanceof Promise) { snapshot.catch(() => {}); return null; }
      if (!snapshot || typeof snapshot !== "object" || typeof snapshot.then === "function" ||
          !Array.isArray(snapshot.conversations) || !Array.isArray(snapshot.executions)) return null;
      return snapshot;
    } catch { return null; }
  }

  function linkInstructionLaunchRecord(launch, snapshot, requireActive = false) {
    if (!launch || typeof launch !== "object" || !snapshot ||
        !validScopedIdentifier(launch.launchRef) || !["bound", "ended"].includes(launch.state) ||
        !sameQuestionIdentity(launch.identity, launch.identity) ||
        !validScopedIdentifier(launch.conversationId) || !validSessionId(launch.sessionId) ||
        !validScopedIdentifier(launch.origin, 64) || !validScopedIdentifier(launch.purpose, 64) ||
        !launch.executionBinding || typeof launch.executionBinding !== "object" ||
        !hasExactKeys(launch.executionBinding, ["periodId", "actor"]) ||
        !validScopedIdentifier(launch.executionBinding.periodId) ||
        !launch.executionBinding.actor || typeof launch.executionBinding.actor !== "object" ||
        !hasExactKeys(launch.executionBinding.actor, ["kind", "id"]) ||
        !validScopedIdentifier(launch.executionBinding.actor.kind, 64) ||
        !validScopedIdentifier(launch.executionBinding.actor.id)) return null;
    const conversations = snapshot.conversations.filter((item) => item &&
      item.conversationId === launch.conversationId && sameQuestionIdentity(item.identity, launch.identity));
    const executions = snapshot.executions.filter((item) => item &&
      item.conversationId === launch.conversationId &&
      item.executionId === launch.executionBinding.periodId && item.sessionId === launch.sessionId &&
      ["active", "ended"].includes(item.state) && (!requireActive || item.state === "active"));
    if (conversations.length !== 1 || executions.length !== 1) return null;
    return { launch, conversation: conversations[0], execution: executions[0] };
  }

  function linkInstructionLaunch(launchRef, snapshot, requireActive = false) {
    if (!launchRegistry || typeof launchRegistry.get !== "function" || !validScopedIdentifier(launchRef)) return null;
    try { return linkInstructionLaunchRecord(launchRegistry.get(launchRef), snapshot, requireActive); }
    catch { return null; }
  }

  function instructionTargetProjection(launchRef) {
    const unavailable = { status: "unverified", nativeTurnId: null, reason: "instruction_dispatch_unavailable" };
    if (typeof instructionTargetState !== "function") return unavailable;
    try {
      const value = instructionTargetState(launchRef);
      if (value instanceof Promise) { value.catch(() => {}); return unavailable; }
      if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.then === "function" ||
          !["working", "stopped", "waiting", "unverified"].includes(value.status) ||
          (value.reason !== null && !validText(value.reason, 512, true))) return unavailable;
      if (value.status === "waiting") {
        if (!hasExactKeys(value, ["status", "nativeTurnId", "reason", "nativeWaiting"]) ||
            !validScopedIdentifier(value.nativeTurnId) || !Array.isArray(value.nativeWaiting) ||
            value.nativeWaiting.length < 1 || value.nativeWaiting.length > 2) return unavailable;
        const nativeWaiting = [];
        const seenKinds = new Set();
        let pendingCount = 0;
        for (const item of value.nativeWaiting) {
          if (!hasExactKeys(item, ["kind", "count"]) || !["question", "approval"].includes(item.kind) ||
              !Number.isSafeInteger(item.count) || item.count < 1 || seenKinds.has(item.kind)) return unavailable;
          pendingCount += item.count;
          if (pendingCount > MAX_NATIVE_PENDING_REQUESTS) return unavailable;
          seenKinds.add(item.kind);
          nativeWaiting.push({ kind: item.kind, count: item.count });
        }
        return { status: value.status, nativeTurnId: value.nativeTurnId, reason: value.reason, nativeWaiting };
      }
      if (!hasExactKeys(value, ["status", "nativeTurnId", "reason"]) ||
          (value.nativeTurnId !== null && !validScopedIdentifier(value.nativeTurnId))) return unavailable;
      return { status: value.status, nativeTurnId: value.nativeTurnId, reason: value.reason };
    } catch { return unavailable; }
  }

  function instructionModeAllowed(launch, target, mode, expectedTurnId, allowNextUserInput = false) {
    if (!launch || !target || launch.origin === "review" || launch.purpose === "review") return false;
    if (mode === "steer") return ["standalone", "delegated"].includes(launch.origin) && target.status === "working" &&
      validScopedIdentifier(expectedTurnId) && target.nativeTurnId === expectedTurnId;
    if (mode === "start") return launch.origin === "standalone" && target.status === "stopped" && expectedTurnId === null;
    return allowNextUserInput && mode === "next-user-input" && launch.origin === "standalone" &&
      target.status === "stopped" && expectedTurnId === null;
  }

  function instructionTargetList(snapshot) {
    if (!launchRegistry || typeof launchRegistry.snapshot !== "function" || !snapshot) return [];
    try {
      const launchSnapshot = launchRegistry.snapshot();
      if (launchSnapshot instanceof Promise) { launchSnapshot.catch(() => {}); return []; }
      if (!launchSnapshot || typeof launchSnapshot !== "object" || typeof launchSnapshot.then === "function" ||
          !Array.isArray(launchSnapshot.launches)) return [];
      return launchSnapshot.launches.flatMap((candidate) => {
        const link = candidate?.state === "bound" ? linkInstructionLaunchRecord(candidate, snapshot, true) : null;
        if (!link) return [];
        const target = instructionTargetProjection(link.launch.launchRef);
        return [{ launchRef: link.launch.launchRef, sessionId: link.execution.sessionId,
          executionId: link.execution.executionId, identity: { ...link.launch.identity },
          origin: link.launch.origin, purpose: link.launch.purpose,
          status: target.status, nativeTurnId: target.nativeTurnId, reason: target.reason,
          ...(target.status === "waiting" ? { nativeWaiting: target.nativeWaiting } : {}) }];
      });
    } catch { return []; }
  }

  function instructionMatchesLaunch(instruction, link) {
    return Boolean(instruction && link && instruction.launchRef === link.launch.launchRef &&
      instruction.sessionId === link.execution.sessionId &&
      instruction.executionId === link.launch.executionBinding.periodId &&
      instruction.origin === link.launch.origin && sameQuestionIdentity(instruction.identity, link.launch.identity));
  }

  function validatedSessionProjectionRecords(questionSnapshot, questionRegistrySnapshot, instructionDashboard, instructionRegistrySnapshot) {
    const questions = [];
    const orphanedCommonQuestions = [];
    for (const question of questionSnapshot?.questions || []) {
      const link = questionRegistrationLink(question, questionRegistrySnapshot);
      const provider = link?.conversation.identity?.provider;
      if (!link || !['claude', 'codex'].includes(provider) || !validSessionId(link.sessionId)) {
        orphanedCommonQuestions.push({ ...question, orphaned: true });
        continue;
      }
      questions.push({ question, link, provider, sessionId: link.sessionId });
    }

    const instructions = [];
    let unmatchedInstructions = 0;
    for (const rawInstruction of instructionDashboard?.instructions || []) {
      const instruction = instructionProjection(rawInstruction);
      if (!instruction || !instructionRegistrySnapshot) { unmatchedInstructions += 1; continue; }
      const link = linkInstructionLaunch(instruction.launchRef, instructionRegistrySnapshot, false);
      const provider = link?.launch.identity?.provider;
      if (!link || !instructionMatchesLaunch(instruction, link) ||
          !['claude', 'codex'].includes(provider) || !validSessionId(link.execution.sessionId)) {
        unmatchedInstructions += 1;
        continue;
      }
      instructions.push({ instruction, link, provider, sessionId: link.execution.sessionId });
    }
    return { questions, instructions, orphanedCommonQuestions, unmatchedInstructions };
  }

  async function currentValidatedSessionProjectionRecords() {
    let questionSnapshot = null;
    let questionRegistrySnapshot = null;
    let configuredSourceUnavailable = false;
    if (questionService) {
      try {
        if (!questionServiceReady) throw new Error();
        const value = await questionService.dashboardSnapshot();
        const registrySnapshot = registrationSnapshotForInstructions();
        if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.questions) ||
            !value.questions.every((question) => question && typeof question === 'object' && !Array.isArray(question)) ||
            !registrySnapshot) throw new Error();
        questionSnapshot = value;
        questionRegistrySnapshot = registrySnapshot;
      } catch {
        questionSnapshot = null;
        questionRegistrySnapshot = null;
        configuredSourceUnavailable = true;
      }
    }
    let instructionDashboard = null;
    let instructionRegistrySnapshot = null;
    if (launchRegistry || instructionService) {
      try {
        if (!launchRegistry || !instructionService || !instructionServiceReady) throw new Error();
        instructionRegistrySnapshot = registrationSnapshotForInstructions();
        if (!instructionRegistrySnapshot) throw new Error();
        const value = await instructionService.dashboardSnapshot();
        if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray(value.instructions)) throw new Error();
        instructionDashboard = value;
      } catch {
        instructionDashboard = null;
        instructionRegistrySnapshot = null;
        configuredSourceUnavailable = true;
      }
    }
    return {
      ...validatedSessionProjectionRecords(
        questionSnapshot, questionRegistrySnapshot, instructionDashboard, instructionRegistrySnapshot),
      configuredSourceUnavailable,
    };
  }

  function projectionProvidersForSession(projections, sessionId) {
    return [...new Set([
      ...[...projections.questions, ...projections.instructions]
        .filter((projection) => projection.sessionId === sessionId)
        .map((projection) => projection.provider),
      ...state.projectionDisplayRecordsForSession(sessionId).map((record) => record.provider),
    ])];
  }

  function resolveProjectionProvidersForSession(projections, sessionId) {
    const providers = projectionProvidersForSession(projections, sessionId);
    if (providers.length !== 1) return providers;
    const realRow = state.snapshot().sessions.find((session) => session.session_id === sessionId);
    if (!realRow) return providers;
    const rowProviders = state.sessionProviderSourcesFor?.(sessionId) || [];
    if (rowProviders.length !== 1 || rowProviders[0] !== providers[0]) return ['ambiguous', ...providers];
    return providers;
  }

  function safeInstructionRecovery(recovery) {
    if (!recovery || typeof recovery !== "object" || Array.isArray(recovery)) return undefined;
    const result = {};
    if (typeof recovery.status === "string" && validScopedIdentifier(recovery.status, 64)) result.status = recovery.status;
    if (typeof recovery.blocked === "boolean") result.blocked = recovery.blocked;
    if (typeof recovery.errorCode === "string" && /^[a-z0-9_]{1,80}$/.test(recovery.errorCode)) result.errorCode = recovery.errorCode;
    if (Number.isSafeInteger(recovery.unmatchedCount) && recovery.unmatchedCount >= 0) result.unmatchedCount = recovery.unmatchedCount;
    return Object.keys(result).length ? result : undefined;
  }

  function queueInstructionResponseLost(deliveryAttemptId) {
    if (!instructionService?.reportResponseLost || !validScopedIdentifier(deliveryAttemptId)) return;
    const operation = Promise.resolve().then(() => instructionService.reportResponseLost(deliveryAttemptId)).catch(() => {});
    pendingInstructionLosses.add(operation);
    void operation.finally(() => pendingInstructionLosses.delete(operation));
  }

  async function flushInstructionLosses() {
    await Promise.allSettled([...pendingInstructionLosses]);
  }

  function instructionScopeMatches(body, link) {
    return Boolean(link && body.session_id === link.execution.sessionId &&
      body.execution_id === link.execution.executionId);
  }

  function instructionServiceResult(result) {
    const instruction = instructionProjection(result?.instruction);
    if (!instruction || !['created', 'existing', 'sending', 'cancelled', 'superseded', 'unknown', 'unchanged'].includes(result?.outcome)) {
      return null;
    }
    return { outcome: result.outcome, instruction };
  }

  function sendInstructionError(response, error) {
    const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,80}$/.test(error.code)
      ? error.code : 'instruction_unavailable';
    jsonResponse(response, instructionErrorStatus(error), { error: code });
  }

  async function loadScopedInstruction(deliveryAttemptId, body) {
    const stored = await instructionService.get(deliveryAttemptId);
    if (!stored) return { missing: true };
    const instruction = instructionProjection(stored.instruction);
    const snapshot = registrationSnapshotForInstructions();
    const link = instruction && snapshot ? linkInstructionLaunch(instruction.launchRef, snapshot) : null;
    if (!instruction || !link || !instructionMatchesLaunch(instruction, link)) return { forbidden: true };
    if (!instructionScopeMatches(body, link)) return { forbidden: true };
    return { instruction, link };
  }

  async function dashboardQuestion(internalQuestionId) {
    const snapshot = await questionService.dashboardSnapshot();
    const question = snapshot.questions.find((item) => item.internalQuestionId === internalQuestionId);
    if (!question) return null;
    return { question, link: questionRegistrationLink(question) };
  }

  async function mutateCommonQuestion(response, internalQuestionId, body, operation) {
    if (!questionService || !questionServiceReady) {
      jsonResponse(response, 503, { error: 'Question service is unavailable' });
      return;
    }
    const fields = operation === 'answer'
      ? ['session_id', 'execution_id', 'answers']
      : operation === 'hold' ? ['session_id', 'execution_id', 'held'] : ['session_id', 'execution_id'];
    if (!hasExactKeys(body, fields) || !validSessionId(body.session_id) ||
        !validText(body.execution_id, 256) || (operation === 'hold' && typeof body.held !== 'boolean')) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    try {
      const found = await dashboardQuestion(internalQuestionId);
      if (!found) {
        jsonResponse(response, 404, { error: 'Question not found' });
        return;
      }
      const { question, link } = found;
      if (!link || link.execution.state !== 'active') {
        jsonResponse(response, 409, { error: 'Question execution is unavailable' });
        return;
      }
      if (body.session_id !== link.sessionId || body.execution_id !== question.executionId) {
        jsonResponse(response, 403, { error: 'Question scope mismatch' });
        return;
      }
      const result = operation === 'answer'
        ? await questionService.submitAnswer(internalQuestionId, { answers: body.answers })
        : operation === 'hold'
          ? await questionService.hold(internalQuestionId, body.held)
          : await questionService.cancel(internalQuestionId);
      jsonResponse(response, 200, { outcome: result.outcome, question: result.question });
    } catch (error) {
      jsonResponse(response, questionErrorStatus(error), { error: 'Question request is unavailable' });
    }
  }

  const ctx = {
    answerDelivery,
    applyClaudeLineage,
    away,
    claudeHome,
    claudeIssuer,
    codexAgentScriptExists,
    crossReviewToolExists,
    currentValidatedSessionProjectionRecords,
    dev,
    homeDir,
    instructionModeAllowed,
    instructionScopeMatches,
    instructionService,
    instructionServiceReady,
    instructionServiceResult,
    instructionTargetList,
    instructionTargetProjection,
    instructionTargetState,
    lateInstructionIds,
    launchRegistry,
    linkInstructionLaunch,
    loadScopedInstruction,
    managedCollectors,
    mutateCommonQuestion,
    openExternalUrl,
    ownedExecutionSnapshot,
    providerEventAdapters,
    providerEventProjection,
    pullRequestMergeManager,
    pullRequestTracker,
    questionRegistrationLink,
    questionService,
    questionServiceReady,
    queueInstructionResponseLost,
    queueQuestionResponseLost,
    registrationRegistry,
    registrationSnapshotForInstructions,
    resolveFreshWriterSessionId,
    resolveProjectionProvidersForSession,
    resolveWriterSessionId,
    routing,
    safeInstructionRecovery,
    sendInstructionError,
    state,
    stopOwnedExecution,
    userHome,
    validatedSessionProjectionRecords,
    webPath,
    scheduleTaskNotifications: (sessionId) => options.scheduleTaskNotifications?.(sessionId),
  };
  const { handleHealth, handleState, handleContext, handleDevFields, handleIndex } = createReadRoutes(ctx);
  const { handleOwnedExecutionStop } = createOwnedExecutionsRoutes(ctx);
  const { handleQuestionRequest, handleQuestionMutation } = createQuestionsRoutes(ctx);
  const { handleAwayState, handleAway, handleRouting, handleOpenUrl } = createSettingsRoutes(ctx);
  const { handleHookAnswers, handleClaudeWriter, handleEvents, handlePlan, handleSessionPullRequests } = createHookRoutes(ctx);
  const { handleDecisionAnswer, handleEstimate, handleRecordDeletions, handleHiddenSessions, handleDisplay, handleSeen, handleClosedTasks, handleClosedAgents } = createUiSessionRoutes(ctx);
  const { handleReviewSkip, handlePullRequestAction, handleMergeResultClose } = createPullRequestRoutes(ctx);
  const { handleInstructionRequest } = createInstructionsRoutes(ctx);

  const invalidSessionId = { valid: (params) => validSessionId(params[1]), status: 400, error: 'Invalid session id' };
  const unknownSessionId = { valid: (params) => isShortSessionId(params[1]), status: 404, error: 'Session not found' };

  const routes = [
    { method: 'GET', path: '/health', auth: 'none', body: 'none', handler: handleHealth },
    { method: 'GET', path: '/api/state', auth: 'none', body: 'none', handler: handleState },
    { method: 'POST', path: '/api/executions/stop', auth: 'ui', body: 'json', preBody: () => stopOwnedExecution ? null : { status: 503, error: 'owned_execution_stop_unavailable' }, handler: handleOwnedExecutionStop },
    { method: 'POST', path: /^\/api\/decisions\/([^/]+)\/late-instruction$/, auth: 'ui', body: 'json', preBody: () => instructionService && instructionServiceReady ? null : { status: 503, error: 'Instruction service is unavailable' }, handler: handleInstructionRequest },
    { method: 'POST', path: /^\/api\/instructions\/([^/]+)\/(send|cancel|alternative)$/, auth: 'ui', body: 'json', preBody: () => instructionService && instructionServiceReady ? null : { status: 503, error: 'Instruction service is unavailable' }, handler: handleInstructionRequest },
    { method: 'POST', path: '/api/instructions/create', auth: 'ui', body: 'json', preBody: () => instructionService && instructionServiceReady ? null : { status: 503, error: 'Instruction service is unavailable' }, handler: handleInstructionRequest },
    { method: 'POST', path: /^\/api\/sessions\/pending\/questions\/(register|status|answer-poll|response-lost)$/, auth: 'hook', body: 'json', preBody: () => questionService && questionServiceReady ? null : { status: 503, error: 'Question service is unavailable' }, handler: handleQuestionRequest },
    { method: 'GET', path: '/api/away', auth: 'none', body: 'none', handler: handleAwayState },
    { method: 'GET', path: /^\/api\/sessions\/([^/]+)\/context$/, auth: 'none', body: 'none', idCheck: invalidSessionId, handler: handleContext },
    { method: 'GET', path: '/api/dev/fields', auth: 'none', body: 'none', handler: handleDevFields },
    { method: 'POST', path: '/api/hooks/answers', auth: 'hook', body: 'json', handler: handleHookAnswers },
    { method: 'POST', path: /^\/api\/decisions\/([^/]+)\/answer$/, auth: 'ui', body: 'json', handler: handleDecisionAnswer },
    { method: 'POST', path: /^\/api\/decisions\/([^/]+)\/(hold|cancel)$/, auth: 'ui', body: 'json', handler: handleQuestionMutation },
    { method: 'POST', path: '/api/pull-requests/review-skip', auth: 'ui', body: 'json', handler: handleReviewSkip },
    { method: 'POST', path: /^\/api\/pull-requests\/(merge|reserve|cancel-reservation|conflict-request)$/, auth: 'ui', body: 'json', handler: handlePullRequestAction },
    { method: 'GET', path: '/', auth: 'none', body: 'none', handler: handleIndex },
    { method: 'POST', path: /^\/api\/sessions\/([^/]+)\/estimate$/, auth: 'ui', body: 'none', idCheck: unknownSessionId, handler: handleEstimate },
    { method: 'POST', path: '/api/record-deletions', auth: 'ui', body: 'json', handler: handleRecordDeletions },
    { method: 'POST', path: '/api/hidden-sessions', auth: 'ui', body: 'json', handler: handleHiddenSessions },
    { method: 'POST', path: '/api/display', auth: 'ui', body: 'json', handler: handleDisplay },
    { method: 'POST', path: '/api/pull-requests/merge-result/close', auth: 'ui', body: 'json', handler: handleMergeResultClose },
    { method: 'POST', path: '/api/seen', auth: 'ui', body: 'json', handler: handleSeen },
    { method: 'POST', path: '/api/closed-tasks', auth: 'ui', body: 'json', handler: handleClosedTasks },
    { method: 'POST', path: '/api/closed-agents', auth: 'ui', body: 'json', handler: handleClosedAgents },
    { method: 'POST', path: '/api/away', auth: 'ui-optional-origin', body: 'json', handler: handleAway },
    { method: 'POST', path: '/api/routing', auth: 'ui', body: 'json', handler: handleRouting },
    { method: 'POST', path: '/api/open-url', auth: 'ui', body: 'json', handler: handleOpenUrl },
    { method: 'POST', path: '/api/claude/writer', auth: 'hook', body: 'json', handler: handleClaudeWriter },
    { method: 'POST', path: '/api/events', auth: 'hook', body: 'json', handler: handleEvents },
    { method: 'POST', path: /^\/api\/sessions\/([^/]+)\/plan$/, auth: 'hook', body: 'json', idCheck: invalidSessionId, handler: handlePlan },
    { method: 'POST', path: /^\/api\/sessions\/([^/]+)\/prs$/, auth: 'hook', body: 'json', idCheck: invalidSessionId, handler: handleSessionPullRequests },
  ];

  // 順序は Host、markRequest、/manual、ルートの決定、秘密値(401)、Origin(403)、ID、サービスの利用可否、本文で固定する。
  // 外部の Host の要求でアイドル終了を延ばさず、照合の前に ID や本文の妥当性を応答して漏らさないため。
  const handler = async (request, response) => {
    const info = getServerInfo();
    if (!info || !requestHostIsLocal(request, info.port)) {
      textResponse(response, 400, 'Invalid Host');
      return;
    }
    markRequest();

    const requestUrl = new URL(request.url, `http://127.0.0.1:${info.port}`);
    if (await serveManualRequest(request, response, manualDir)) return;

    const matched = findRoute(routes, request.method, requestUrl.pathname);
    if (matched) {
      const { route, params } = matched;
      const failure = authFailure(route.auth, request, info);
      if (failure) {
        jsonResponse(response, failure.status, { error: failure.error });
        return;
      }
      if (route.idCheck && !route.idCheck.valid(params)) {
        jsonResponse(response, route.idCheck.status, { error: route.idCheck.error });
        return;
      }
      const unavailable = route.preBody?.();
      if (unavailable) {
        jsonResponse(response, unavailable.status, { error: unavailable.error });
        return;
      }
      let body;
      if (route.body === 'json') {
        try {
          body = JSON.parse(await readJsonBody(request));
        } catch (error) {
          jsonResponse(response, error.statusCode || 400, { error: error.statusCode === 413 ? 'Payload too large' : 'Invalid JSON' });
          return;
        }
      }
      await route.handler({ request, response, requestUrl, info, params, body });
      return;
    }

    if (requestUrl.pathname.startsWith('/api/')) {
      textResponse(response, 405, 'Method Not Allowed');
      return;
    }
    textResponse(response, 404, 'Not Found');
  };
  handler.flushQuestionLosses = async () => { await Promise.all([...pendingQuestionLosses]); };
  handler.flushInstructionLosses = flushInstructionLosses;
  return handler;
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
  if (options.onShutdown !== undefined && typeof options.onShutdown !== 'function') {
    throw new TypeError('onShutdown must be a function');
  }
  if ((options.ownedExecutionSnapshot !== undefined && typeof options.ownedExecutionSnapshot !== 'function') ||
      (options.stopOwnedExecution !== undefined && typeof options.stopOwnedExecution !== 'function')) {
    throw new TypeError('owned execution handlers must be functions');
  }
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
  const listSessionFiles = options.listSessionFiles || listLiveSessionFiles;
  let registrationRegistry = options.registrationRegistry;
  let claudeIssuer = null;
  if (!registrationRegistry) {
    const kernel = createRegistrationKernel();
    registrationRegistry = kernel.registry;
    claudeIssuer = createClaudeLocalIssuer({
      registry: kernel.registry,
      authority: kernel.authority,
      claudeHome,
      listSessionFiles,
      log: (message) => logLine(homeDir, message),
    });
  }
  const launchRegistry = options.launchRegistry || null;
  const questionService = options.questionService || null;
  const instructionService = options.instructionService || null;
  const ownedExecutionSnapshot = options.ownedExecutionSnapshot || null;
  const stopOwnedExecution = options.stopOwnedExecution || null;
  const pendingInstructionLosses = new Set();
  const pendingQuestionLosses = new Set();
  let questionServiceReady = false;
  if (questionService) {
    try {
      await questionService.ready();
      questionServiceReady = true;
    } catch {
      questionServiceReady = false;
    }
  }
  let instructionServiceReady = false;
  if (instructionService) {
    try {
      await instructionService.ready();
      instructionServiceReady = true;
    } catch {
      instructionServiceReady = false;
    }
  }
  state.isSessionAbsenceProtected = claudeIssuer
    ? (sessionId) => claudeIssuer.isActiveSession(sessionId)
    : (sessionId) => registrationRegistry.isRegisteredSessionId(sessionId);
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
  let shutdownFailed = false;
  let lastRequestAt = Date.now();
  const notificationTimers = new Map();
  const notificationReads = new Map();
  const notificationReader = options.readTaskNotifications || readTaskNotifications;
  function needsTaskNotifications(sessionId) {
    const session = state.snapshot().sessions.find((item) => item.session_id === sessionId);
    return session?.status === '待機中(サブエージェント稼働中)'
      && session.agents.some((agent) => !agent.isCodex && agent.active);
  }
  function reconcileTaskNotifications(sessionId) {
    if (closing || !needsTaskNotifications(sessionId)) return Promise.resolve();
    if (notificationReads.has(sessionId)) return notificationReads.get(sessionId);
    const reading = (async () => {
      try {
        const file = state.sessionFileFor(sessionId);
        const notifications = await notificationReader(claudeHome, file?.cwd, file?.native_session_id || sessionId);
        if (!closing && needsTaskNotifications(sessionId)) state.applyTaskNotifications(sessionId, notifications);
      } catch {}
    })().finally(() => notificationReads.delete(sessionId));
    notificationReads.set(sessionId, reading);
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
    scheduleTaskNotifications,
    getServerInfo: () => info,
    markRequest: () => { lastRequestAt = Date.now(); },
    registrationRegistry,
    claudeIssuer,
    launchRegistry,
    questionService,
    questionServiceReady,
    pendingQuestionLosses,
    instructionService,
    instructionServiceReady,
    instructionTargetState: options.instructionTargetState,
    ownedExecutionSnapshot,
    stopOwnedExecution,
    pendingInstructionLosses,
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
    try { await questionService?.close?.(); } catch {}
    try { await instructionService?.close?.(); } catch {}
    let shutdownFailure = null;
    try { await options.onShutdown?.(); } catch (shutdownError) { shutdownFailure = shutdownError; }
    if (shutdownFailure) {
      throw new AggregateError([error, shutdownFailure], 'server startup and shutdown failed', { cause: error });
    }
    throw error;
  }

  logLine(homeDir, `started on 127.0.0.1:${info.port}`);
  pullRequestTracker.start();
  pullRequestMergeManager.start?.();
  async function refreshSessionFiles() {
    const listingToken = claudeIssuer?.beginListing();
    const files = await listSessionFiles(claudeHome);
    if (files) {
      claudeIssuer?.syncSessionFiles(files, listingToken);
      // 再開した期間の表示用 sessionId は native の ID と違うので、状態の同期にはその ID を使う。
      // 会話記録のファイル名は native の ID なので、推定のために native_session_id も残す。
      state.syncSessionFiles(files.map((file) => ({
        ...file,
        native_session_id: file.session_id,
        session_id: claudeIssuer?.activeProjectionFor({ sessionId: file.session_id, pid: file.pid }) || file.session_id,
        product: productFromCwd(file.cwd),
      })), Date.now(), 'claude');
    }
    // 読めないときは生死を判定できないので同期せず、猶予の後の期限切れの片付けだけを進める。
    else state.pruneExpiredStoreRecords(Date.now());
  }
  await refreshSessionFiles().catch(() => {});
  for (const session of state.snapshot().sessions) scheduleTaskNotifications(session.session_id);
  const notificationTimer = setInterval(() => {
    for (const session of state.snapshot().sessions) void reconcileTaskNotifications(session.session_id);
  }, 60_000);
  notificationTimer.unref();
  const sessionScanTimer = setInterval(() => { refreshSessionFiles().catch(() => {}); }, options.sessionScanIntervalMs || SESSION_SCAN_INTERVAL_MS);
  sessionScanTimer.unref();

  const idleTimer = setInterval(async () => {
    if (Date.now() - lastRequestAt < IDLE_TIMEOUT_MS) return;
    if (state.snapshot().sessions.length > 0) return;
    if (await hasSessionJsonFiles(claudeHome)) return;
    logLine(homeDir, 'stopping after idle timeout');
    await close().catch(() => { shutdownFailed = true; });
  }, 60_000);
  idleTimer.unref();

  async function close() {
    if (closing) return closing;
    closing = (async () => {
      let failed = false;
      let failure;
      const attempt = async (operation) => {
        try { await operation(); } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      };
      clearInterval(idleTimer);
      clearInterval(sessionScanTimer);
      clearInterval(notificationTimer);
      for (const timer of notificationTimers.values()) clearTimeout(timer);
      notificationTimers.clear();
      await attempt(() => Promise.all(notificationReads.values()));
      await attempt(() => answerDelivery.close());
      await attempt(() => pullRequestMergeManager.close?.());
      await attempt(() => pullRequestTracker.close());
      if (server.listening) {
        await attempt(() => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
      }
      await attempt(() => handler.flushQuestionLosses());
      await attempt(() => handler.flushInstructionLosses());
      await attempt(() => instructionService?.flush?.());
      await attempt(() => instructionService?.close?.());
      await attempt(() => questionService?.close?.());
      await attempt(() => Promise.all([state.flushPersistence?.(), away.flushPersistence?.(), routing.flush?.()].filter(Boolean)));
      await attempt(() => removeServerInfoIfOwned(homeDir, info));
      await attempt(() => options.onShutdown?.());
      if (failed) {
        shutdownFailed = true;
        logLine(homeDir, 'shutdown incomplete');
        throw failure;
      }
      logLine(homeDir, 'stopped');
    })();
    return closing;
  }

  return { server, state, away, routing, answerDelivery, questionService, instructionService, pullRequestTracker,
    pullRequestMergeManager, info, homeDir, close,
    get shutdownError() { return shutdownFailed ? 'shutdown_incomplete' : null; } };
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
      const stop = () => runtime.close().then(
        () => { process.exitCode = 0; },
        () => {
          console.error('Agent Cockpit shutdown incomplete.');
          process.exitCode = 1;
        },
      );
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
