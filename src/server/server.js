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
const { createClaudeLocalIssuer } = require('./claude-local-issuer');
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
const MAX_NATIVE_PENDING_REQUESTS = 128;
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

function hasExactKeys(value, fields) {
  return hasOnlyKeys(value, fields) && Object.keys(value).length === fields.length;
}

function sameQuestionIdentity(left, right) {
  const fields = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
  return hasExactKeys(left, fields) && hasExactKeys(right, fields) &&
    fields.every((field) => left[field] === right[field]);
}

function questionErrorStatus(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code.startsWith('invalid_') || code === 'question_category_forbidden') return 400;
  if (['question_writer_unverified', 'question_writer_binding_mismatch'].includes(code)) return 403;
  if (code === 'question_not_found') return 404;
  if (['question_conflict', 'question_cancelled', 'question_delivery_mismatch', 'question_delivery_digest_mismatch'].includes(code)) return 409;
  return 503;
}

const INSTRUCTION_MODES = new Set(['steer', 'start', 'next-user-input']);
const INSTRUCTION_STATES = new Set(['available', 'claimed', 'sending', 'accepted', 'applied', 'unknown', 'unavailable', 'cancelled_before_send', 'superseded_before_send']);

function validScopedIdentifier(value, maxLength = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength &&
    value === value.trim() && !/[\u0000-\u001f\u007f]/.test(value);
}

function validInstructionIdentity(value) {
  const fields = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
  return hasExactKeys(value, fields) && ['claude', 'codex'].includes(value.provider) &&
    fields.slice(1).every((field) => validScopedIdentifier(value[field]));
}

function instructionProjection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      !validScopedIdentifier(value.deliveryAttemptId) || !validScopedIdentifier(value.logicalMessageId) ||
      !validScopedIdentifier(value.launchRef) || !validSessionId(value.sessionId) ||
      !validScopedIdentifier(value.executionId) || !validInstructionIdentity(value.identity) ||
      !['standalone', 'delegated', 'review'].includes(value.origin) || !INSTRUCTION_STATES.has(value.state) ||
      !INSTRUCTION_MODES.has(value.mode) || !Number.isSafeInteger(value.revision) || value.revision < 0 ||
      (value.nativeTurnId !== null && !validScopedIdentifier(value.nativeTurnId)) ||
      (value.heldReason !== null && value.heldReason !== undefined && !validText(value.heldReason, 512, true)) ||
      !Number.isSafeInteger(value.createdAt) || value.createdAt < 0) return null;
  return {
    deliveryAttemptId: value.deliveryAttemptId,
    logicalMessageId: value.logicalMessageId,
    revision: value.revision,
    launchRef: value.launchRef,
    sessionId: value.sessionId,
    executionId: value.executionId,
    identity: { ...value.identity },
    origin: value.origin,
    state: value.state,
    mode: value.mode,
    nativeTurnId: value.nativeTurnId,
    heldReason: value.heldReason ?? null,
    createdAt: value.createdAt ?? null,
  };
}

function instructionErrorStatus(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  if (code === 'instruction_not_found' || code === 'delivery_not_found') return 404;
  if (['instruction_scope_mismatch', 'instruction_launch_unavailable'].includes(code)) return 403;
  if (code.startsWith('invalid_') || code.startsWith('expected_turn_') ||
      code.startsWith('instruction_invalid_') || code.startsWith('instruction_expected_turn_') ||
      code === 'unexpected_turn' || code === 'instruction_envelope_too_large') return 400;
  if (['instruction_not_sendable', 'instruction_not_supersedable', 'instruction_mode_requires_supersede'].includes(code) ||
      code.includes('conflict') || code.includes('mismatch') || code.includes('unavailable') ||
      code.includes('unverified') || code.includes('forbidden') || code.includes('unsupported') ||
      code.includes('timeout') || code.includes('requires_supersede')) return 409;
  return 503;
}

function lateInstructionIds(internalQuestionId, index, digest) {
  const key = crypto.createHash("sha256").update(JSON.stringify([internalQuestionId, index, digest])).digest("hex");
  return { deliveryAttemptId: 'late-delivery-' + key, logicalMessageId: 'late-message-' + key, revision: 0 };
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
    claudeIssuer = null,
    questionService = null,
    questionServiceReady = true,
    pendingQuestionLosses = new Set(),
    managedCollectors = [],
    launchRegistry = null,
    instructionService = null,
    instructionServiceReady = false,
    instructionTargetState = null,
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

  async function readInstructionBody(request, response) {
    try {
      const body = JSON.parse(await readJsonBody(request));
      if (body && typeof body === 'object' && !Array.isArray(body)) return body;
    } catch (error) {
      jsonResponse(response, error.statusCode || 400, { error: error.statusCode === 413 ? 'Payload too large' : 'Invalid JSON' });
      return null;
    }
    jsonResponse(response, 400, { error: 'Invalid request' });
    return null;
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

  async function handleInstructionRequest(request, response, requestUrl, info) {
    const createPath = request.method === 'POST' && requestUrl.pathname === '/api/instructions/create';
    const actionPath = request.method === 'POST' && requestUrl.pathname.match(/^\/api\/instructions\/([^/]+)\/(send|cancel|alternative)$/);
    const latePath = request.method === 'POST' && requestUrl.pathname.match(/^\/api\/decisions\/([^/]+)\/late-instruction$/);
    if (!createPath && !actionPath && !latePath) return false;
    if (request.headers['x-cockpit-secret'] !== info.uiSecret) {
      jsonResponse(response, 401, { error: 'Unauthorized' });
      return true;
    }
    if (!validRequiredUiOrigin(request, info.port)) {
      jsonResponse(response, 403, { error: 'Forbidden' });
      return true;
    }
    if (!instructionService || !instructionServiceReady) {
      jsonResponse(response, 503, { error: 'Instruction service is unavailable' });
      return true;
    }
    const body = await readInstructionBody(request, response);
    if (!body) return true;

    try {
      if (createPath) {
        const fields = ['session_id', 'execution_id', 'launch_ref', 'delivery_attempt_id',
          'logical_message_id', 'revision', 'text', 'mode', 'expected_turn_id'];
        if (!hasExactKeys(body, fields) || !validSessionId(body.session_id) ||
            !validScopedIdentifier(body.execution_id) || !validScopedIdentifier(body.launch_ref) ||
            !validScopedIdentifier(body.delivery_attempt_id) || !validScopedIdentifier(body.logical_message_id) ||
            !Number.isSafeInteger(body.revision) || body.revision < 0 ||
            typeof body.text !== 'string' || !body.text.trim() || Buffer.byteLength(body.text, 'utf8') > 64 * 1024 ||
            !INSTRUCTION_MODES.has(body.mode) ||
            (body.expected_turn_id !== null && !validScopedIdentifier(body.expected_turn_id))) {
          jsonResponse(response, 400, { error: 'instruction_invalid_request' });
          return true;
        }
        const snapshot = registrationSnapshotForInstructions();
        const link = snapshot ? linkInstructionLaunch(body.launch_ref, snapshot, true) : null;
        if (!link || link.launch.state !== 'bound' || !instructionScopeMatches(body, link)) {
          jsonResponse(response, 403, { error: 'instruction_scope_mismatch' });
          return true;
        }
        const target = instructionTargetProjection(body.launch_ref);
        if (!instructionModeAllowed(link.launch, target, body.mode, body.expected_turn_id)) {
          jsonResponse(response, 409, { error: target.reason || 'instruction_target_unverified' });
          return true;
        }
        const result = await instructionService.create({
          deliveryAttemptId: body.delivery_attempt_id,
          launchRef: body.launch_ref,
          logicalMessageId: body.logical_message_id,
          revision: body.revision,
          text: body.text,
          mode: body.mode,
          expectedTurnId: body.expected_turn_id,
        });
        const safe = instructionServiceResult(result);
        if (!safe) {
          jsonResponse(response, 503, { error: 'instruction_projection_unavailable' });
          return true;
        }
        jsonResponse(response, 200, safe);
        return true;
      }

      if (actionPath) {
        let deliveryAttemptId;
        try { deliveryAttemptId = decodeURIComponent(actionPath[1]); }
        catch { jsonResponse(response, 400, { error: 'instruction_invalid_request' }); return true; }
        if (!validScopedIdentifier(deliveryAttemptId) || !hasExactKeys(body,
          actionPath[2] === 'alternative'
            ? ['session_id', 'execution_id', 'new_delivery_attempt_id', 'logical_message_id', 'revision', 'text', 'mode', 'expected_turn_id']
            : ['session_id', 'execution_id']) ||
            !validSessionId(body.session_id) || !validScopedIdentifier(body.execution_id)) {
          jsonResponse(response, 400, { error: 'instruction_invalid_request' });
          return true;
        }
        const scoped = await loadScopedInstruction(deliveryAttemptId, body);
        if (scoped.missing) { jsonResponse(response, 404, { error: 'instruction_not_found' }); return true; }
        if (scoped.forbidden) { jsonResponse(response, 403, { error: 'instruction_scope_mismatch' }); return true; }
        if (actionPath[2] === 'send') {
          const { launch } = scoped.link;
          const target = instructionTargetProjection(launch.launchRef);
          const expectedTurnId = scoped.instruction.mode === 'steer' ? scoped.instruction.nativeTurnId : null;
          const allowNext = scoped.instruction.mode === 'next-user-input';
          if (launch.state !== 'bound' || scoped.link.execution.state !== 'active' ||
              !instructionModeAllowed(launch, target, scoped.instruction.mode, expectedTurnId, allowNext)) {
            jsonResponse(response, 409, { error: target.reason || 'instruction_target_unverified' });
            return true;
          }
          response.once('close', () => {
            if (!response.writableFinished) queueInstructionResponseLost(deliveryAttemptId);
          });
          const result = await instructionService.send(deliveryAttemptId);
          if (response.destroyed) return true;
          const safe = instructionServiceResult(result);
          if (!safe) {
            queueInstructionResponseLost(deliveryAttemptId);
            jsonResponse(response, 503, { error: 'instruction_projection_unavailable' });
            return true;
          }
          jsonResponse(response, 200, safe);
          return true;
        }
        if (actionPath[2] === 'cancel') {
          const result = await instructionService.cancel(deliveryAttemptId);
          const safe = instructionServiceResult(result);
          if (!safe) { jsonResponse(response, 503, { error: 'instruction_projection_unavailable' }); return true; }
          jsonResponse(response, 200, safe);
          return true;
        }
        if (!validScopedIdentifier(body.new_delivery_attempt_id) || !validScopedIdentifier(body.logical_message_id) ||
            !Number.isSafeInteger(body.revision) || body.revision < 0 || typeof body.text !== 'string' ||
            !body.text.trim() || Buffer.byteLength(body.text, 'utf8') > 64 * 1024 ||
            !INSTRUCTION_MODES.has(body.mode) ||
            (body.expected_turn_id !== null && !validScopedIdentifier(body.expected_turn_id))) {
          jsonResponse(response, 400, { error: 'instruction_invalid_request' });
          return true;
        }
        const { launch, execution } = scoped.link;
        const target = instructionTargetProjection(launch.launchRef);
        if (launch.state !== 'bound' || execution.state !== 'active' ||
            !instructionModeAllowed(launch, target, body.mode, body.expected_turn_id, true)) {
          jsonResponse(response, 409, { error: target.reason || 'instruction_target_unverified' });
          return true;
        }
        const result = await instructionService.supersedeUnsent(deliveryAttemptId, {
          newDeliveryAttemptId: body.new_delivery_attempt_id,
          logicalMessageId: body.logical_message_id,
          revision: body.revision,
          text: body.text,
          mode: body.mode,
          expectedTurnId: body.expected_turn_id,
        });
        const safe = instructionServiceResult(result);
        if (!safe) { jsonResponse(response, 503, { error: 'instruction_projection_unavailable' }); return true; }
        jsonResponse(response, 200, safe);
        return true;
      }

      let internalQuestionId;
      try { internalQuestionId = decodeURIComponent(latePath[1]); }
      catch { jsonResponse(response, 400, { error: 'instruction_invalid_request' }); return true; }
      const lateFields = ['session_id', 'execution_id', 'index', 'digest', 'mode', 'expected_turn_id'];
      if (!hasExactKeys(body, lateFields) || !validSessionId(body.session_id) ||
          !validScopedIdentifier(body.execution_id) || !Number.isSafeInteger(body.index) || body.index < 0 ||
          typeof body.digest !== 'string' || !/^[a-f0-9]{64}$/.test(body.digest) ||
          !INSTRUCTION_MODES.has(body.mode) ||
          (body.expected_turn_id !== null && !validScopedIdentifier(body.expected_turn_id))) {
        jsonResponse(response, 400, { error: 'instruction_invalid_request' });
        return true;
      }
      if (!questionService || !questionServiceReady || typeof questionService.readLateAnswerDraft !== 'function') {
        jsonResponse(response, 503, { error: 'Late answer conversion is unavailable' });
        return true;
      }
      const questionSnapshot = await questionService.dashboardSnapshot();
      const question = questionSnapshot?.questions?.find((item) => item.internalQuestionId === internalQuestionId);
      const questionLink = question && questionRegistrationLink(question);
      if (!question || !questionLink || questionLink.sessionId !== body.session_id ||
          questionLink.execution.executionId !== body.execution_id ||
          !question.lateAnswerRefs?.some((ref) => ref.index === body.index && ref.digest === body.digest)) {
        jsonResponse(response, 404, { error: 'late_answer_not_found' });
        return true;
      }
      const launchSnapshot = registrationSnapshotForInstructions();
      const launchLink = launchSnapshot ? linkInstructionLaunch(question.launchRef, launchSnapshot, true) : null;
      if (!launchLink || launchLink.launch.state !== 'bound' || launchLink.execution.sessionId !== body.session_id ||
          launchLink.execution.executionId !== body.execution_id) {
        jsonResponse(response, 403, { error: 'instruction_scope_mismatch' });
        return true;
      }
      const target = instructionTargetProjection(question.launchRef);
      if (!instructionModeAllowed(launchLink.launch, target, body.mode, body.expected_turn_id)) {
        jsonResponse(response, 409, { error: target.reason || 'instruction_target_unverified' });
        return true;
      }
      const draft = await questionService.readLateAnswerDraft(internalQuestionId, body.index, body.digest);
      if (!draft || draft.launchRef !== question.launchRef || typeof draft.text !== 'string') {
        jsonResponse(response, 404, { error: 'late_answer_not_found' });
        return true;
      }
      const ids = lateInstructionIds(internalQuestionId, body.index, body.digest);
      const result = await instructionService.create({
        ...ids,
        launchRef: draft.launchRef,
        text: draft.text,
        mode: body.mode,
        expectedTurnId: body.expected_turn_id,
      });
      const safe = instructionServiceResult(result);
      if (!safe) { jsonResponse(response, 503, { error: 'instruction_projection_unavailable' }); return true; }
      jsonResponse(response, 200, safe);
      return true;
    } catch (error) {
      sendInstructionError(response, error);
      return true;
    }
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

  const handler = async (request, response) => {
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
      let commonQuestionSnapshot = null;
      let questionRegistrationSnapshot = null;
      let commonQuestionSnapshotUnavailable = false;
      if (questionService) {
        try {
          const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
          commonQuestionSnapshot = await questionService.dashboardSnapshot();
          if (!isRecord(commonQuestionSnapshot) || !Array.isArray(commonQuestionSnapshot.questions) ||
              commonQuestionSnapshot.questions.some((question) => !isRecord(question))) throw new Error();
          questionRegistrationSnapshot = registrationSnapshotForInstructions();
          if (!questionRegistrationSnapshot ||
              questionRegistrationSnapshot.conversations.some((conversation) => !isRecord(conversation)) ||
              questionRegistrationSnapshot.executions.some((execution) => !isRecord(execution))) throw new Error();
        } catch {
          commonQuestionSnapshot = null;
          questionRegistrationSnapshot = null;
          commonQuestionSnapshotUnavailable = true;
        }
      }
      let instructionDashboard = null;
      let instructionRegistrationSnapshot = null;
      let instructionTargets = [];
      let instructionDashboardUnavailable = !instructionService || !instructionServiceReady;
      let instructionTargetsUnavailable = !launchRegistry;
      if (launchRegistry) {
        try {
          instructionRegistrationSnapshot = registrationSnapshotForInstructions();
          if (!instructionRegistrationSnapshot) throw new Error();
          instructionTargets = instructionTargetList(instructionRegistrationSnapshot);
          instructionTargetsUnavailable = false;
        } catch {
          instructionRegistrationSnapshot = null;
          instructionTargets = [];
          instructionTargetsUnavailable = true;
        }
      }
      if (instructionService && instructionServiceReady) {
        try {
          instructionDashboard = await instructionService.dashboardSnapshot();
          if (!instructionDashboard || typeof instructionDashboard !== "object" ||
              !Array.isArray(instructionDashboard.instructions)) throw new Error();
          instructionDashboardUnavailable = false;
        } catch { instructionDashboardUnavailable = true; }
      }
      if (launchRegistry && instructionService && instructionServiceReady &&
          (!instructionDashboard || !instructionRegistrationSnapshot)) {
        instructionDashboard = null;
        instructionRegistrationSnapshot = null;
      }
      const pullRequests = pullRequestTracker?.snapshot() || [];
      const now = Date.now();
      const awayState = away.snapshot();
      const sinceSeen = state.snapshotSinceSeen(snapshot.sessions, pullRequests, now, awayState.periods);
      // 版と時刻は中身と同じ同期処理の中で確定する。後で待つと、待つ間の更新の版が古い中身に付く。
      snapshot.version = state.version;
      snapshot.generatedAt = state.generatedAt;
      void away.prune?.([...state.seenAtByProduct.values()], now);
      const stateSessionIds = new Set(snapshot.sessions.map((session) => session.session_id));
      const sessions = snapshot.sessions.filter((session) => {
        const rowProviders = state.sessionProviderSourcesFor?.(session.session_id) || [];
        return !(rowProviders.length === 1 && state.projectionDisplayRecordsForSession(session.session_id)
          .some((record) => record.provider === rowProviders[0] && record.deletedAt !== undefined));
      }).map((session) => {
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
      const sessionsById = new Map(sessions.map((session) => [session.session_id, session]));
      const projectionRecords = validatedSessionProjectionRecords(
        commonQuestionSnapshot, questionRegistrationSnapshot, instructionDashboard, instructionRegistrationSnapshot);
      const projectionProvidersBySession = new Map();
      for (const projection of [...projectionRecords.questions, ...projectionRecords.instructions]) {
        const providers = projectionProvidersBySession.get(projection.sessionId) || new Set();
        providers.add(projection.provider);
        projectionProvidersBySession.set(projection.sessionId, providers);
      }
      function projectionCanMerge(sessionId, provider) {
        const providers = new Set([
          ...(projectionProvidersBySession.get(sessionId) || []),
          ...state.projectionDisplayRecordsForSession(sessionId).map((record) => record.provider),
        ]);
        if (providers.size !== 1 || !providers.has(provider)) return false;
        const rowProviders = state.sessionProviderSourcesFor?.(sessionId) || [];
        if (stateSessionIds.has(sessionId)) return rowProviders.length === 1 && rowProviders[0] === provider;
        return rowProviders.length === 0 || (rowProviders.length === 1 && rowProviders[0] === provider);
      }
      const orphanedCommonQuestions = projectionRecords.orphanedCommonQuestions;
      for (const { question, link, provider, sessionId } of projectionRecords.questions) {
        if (!projectionCanMerge(sessionId, provider)) continue;
        const display = state.projectionDisplayFor(provider, sessionId);
        if (display?.deletedAt) continue;
        let session = sessionsById.get(sessionId);
        if (!session) {
          session = {
            session_id: sessionId,
            provider,
            title: question.identity.nativeId,
            product: null,
            status: '待機中',
            tools: [],
            agents: [],
            permissionWaits: [],
            decisions: [],
            tasks: [],
            tasksUpdatedAt: null,
          };
          sessionsById.set(sessionId, session);
          sessions.push(session);
        }
        if (display?.hiddenAt) {
          session.hidden = true;
          if (!session.hiddenAt || Date.parse(display.hiddenAt) > Date.parse(session.hiddenAt)) session.hiddenAt = display.hiddenAt;
        }
        if (!Array.isArray(session.commonQuestions)) session.commonQuestions = [];
        const seenAt = session.product && sinceSeen.seenAtByProduct[session.product.key];
        const seenMilliseconds = Date.parse(seenAt || '');
        session.commonQuestions.push({
          ...question,
          sessionId,
          executionState: link.execution.state,
          isNew: Number.isFinite(seenMilliseconds) && question.createdAt > seenMilliseconds,
        });
      }
      const unmatchedInstructions = projectionRecords.unmatchedInstructions;
      for (const { instruction, link, provider, sessionId } of projectionRecords.instructions) {
        if (!projectionCanMerge(sessionId, provider)) continue;
        const display = state.projectionDisplayFor(provider, sessionId);
        if (display?.deletedAt) continue;
        let session = sessionsById.get(sessionId);
        if (!session) {
          session = { session_id: sessionId, provider, title: instruction.identity.nativeId, product: null,
            status: "待機中", tools: [], agents: [], permissionWaits: [], decisions: [], tasks: [], tasksUpdatedAt: null };
          sessionsById.set(sessionId, session);
          sessions.push(session);
        }
        if (display?.hiddenAt) {
          session.hidden = true;
          if (!session.hiddenAt || Date.parse(display.hiddenAt) > Date.parse(session.hiddenAt)) session.hiddenAt = display.hiddenAt;
        }
        if (!Array.isArray(session.instructions)) session.instructions = [];
        session.instructions.push({ ...instruction, registrationExecutionId: link.execution.executionId,
          executionState: link.execution.state });
      }
      const instructionRecovery = safeInstructionRecovery(instructionDashboard?.recovery);
      const instructionConfigured = Boolean(instructionService || launchRegistry || instructionTargetState);
      const instructionDiagnostics = {
        configuration: instructionConfigured ? "configured" : "unconfigured",
        service: instructionDashboardUnavailable ? "unavailable" : instructionRecovery?.status || "ready",
        targets: instructionTargetsUnavailable ? "unavailable" : "available",
        ...(instructionRecovery?.blocked === true ? { blocked: true } : {}),
        ...(instructionRecovery?.errorCode ? { errorCode: instructionRecovery.errorCode } : {}),
        ...(unmatchedInstructions ? { unmatchedCount: unmatchedInstructions } : {}),
      };
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
      const commonQuestionDiagnostics = commonQuestionSnapshotUnavailable
        ? { recovery: { status: 'unavailable', errorCode: 'common_question_state_unavailable' } }
        : commonQuestionSnapshot?.recovery || orphanedCommonQuestions.length
        ? { ...(commonQuestionSnapshot?.recovery ? { recovery: commonQuestionSnapshot.recovery } : {}),
          ...(orphanedCommonQuestions.length ? { orphanedQuestions: orphanedCommonQuestions } : {}) }
        : undefined;
      jsonResponse(response, 200, { ...snapshot, sessions, pullRequests, sinceSeen: sinceSeen.sinceSeen, away: away.snapshot(), routing: routing.snapshot(), integrations: { codexAgent, crossReview }, providerEvents: providerEventProjection.snapshot(), managedCollectors: managedCollectorSnapshots, uiVersion, instructionTargets, instructionDiagnostics, ...(commonQuestionDiagnostics ? { commonQuestionDiagnostics } : {}) });
      return;
    }
    if (await handleInstructionRequest(request, response, requestUrl, info)) return;
    const commonQuestionRoute = requestUrl.pathname.match(/^\/api\/sessions\/pending\/questions\/(register|status|answer-poll|response-lost)$/);
    if (request.method === 'POST' && commonQuestionRoute) {
      if (request.headers['x-cockpit-secret'] !== info.secret) {
        jsonResponse(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (!validOriginForWrite(request)) {
        jsonResponse(response, 403, { error: 'Forbidden' });
        return;
      }
      if (!questionService || !questionServiceReady) {
        jsonResponse(response, 503, { error: 'Question service is unavailable' });
        return;
      }
      let body;
      try { body = JSON.parse(await readJsonBody(request)); }
      catch (error) {
        jsonResponse(response, error.statusCode || 400, { error: error.statusCode === 413 ? 'Payload too large' : 'Invalid JSON' });
        return;
      }
      const operation = commonQuestionRoute[1];
      const expectedFields = operation === 'register'
        ? ['writer', 'questionId', 'questions', 'timeoutMinutes']
        : ['writer', 'questionId'];
      if (!hasExactKeys(body, expectedFields)) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      let writerSessionId = null;
      try { writerSessionId = await resolveFreshWriterSessionId('pending', body); } catch {}
      if (!writerSessionId) {
        jsonResponse(response, 403, { error: 'Writer unavailable' });
        return;
      }
      try {
        if (operation === 'register') {
          const result = await questionService.register(body.writer, {
            questionId: body.questionId, questions: body.questions,
            timeoutMinutes: body.timeoutMinutes, category: 'ordinary',
          });
          jsonResponse(response, 200, result);
          return;
        }
        if (operation === 'status') {
          const result = await questionService.status(body.writer, body.questionId);
          jsonResponse(response, 200, result);
          return;
        }
        const registeredQuestion = await questionService.status(body.writer, body.questionId);
        if (!registeredQuestion) {
          if (operation === 'response-lost') {
            jsonResponse(response, 404, { error: 'Question not found' });
          } else {
            jsonResponse(response, 200, {
              status: { outcome: 'not_found', questionId: body.questionId, deliveryAttemptId: null, state: null },
              delivery: null,
            });
          }
          return;
        }
        if (operation === 'response-lost') {
          const result = await questionService.reportResponseLost(registeredQuestion.internalQuestionId);
          jsonResponse(response, 200, result);
          return;
        }
        let responseClosed = false;
        let responseLostQueued = false;
        let sinkResponded = false;
        const reportLost = () => {
          if (!sinkResponded || !responseClosed || responseLostQueued) return;
          responseLostQueued = true;
          queueQuestionResponseLost(registeredQuestion.internalQuestionId);
        };
        response.once('close', () => {
          if (!response.writableFinished) {
            responseClosed = true;
            reportLost();
          }
        });
        try {
          const result = await questionService.answerPoll(body.writer, body.questionId, (answers, metadata) => {
            if (sinkResponded || responseClosed || response.destroyed || response.writableEnded ||
                !metadata || !Array.isArray(answers)) throw new Error();
            sinkResponded = true;
            jsonResponse(response, 200, {
              status: { outcome: 'sent', questionId: metadata.questionId,
                deliveryAttemptId: metadata.deliveryAttemptId, state: 'sending' },
              delivery: {
                questionId: metadata.questionId,
                revision: metadata.revision,
                deliveryAttemptId: metadata.deliveryAttemptId,
                answers: structuredClone(answers),
              },
            });
          });
          if (!sinkResponded && !response.destroyed && !response.writableEnded) {
            jsonResponse(response, 200, { status: result, delivery: null });
          }
        } catch (error) {
          if (sinkResponded) {
            if (responseClosed || response.destroyed || !response.writableFinished) {
              responseClosed = true;
              reportLost();
            }
            return;
          }
          throw error;
        }
      } catch (error) {
        jsonResponse(response, questionErrorStatus(error), { error: 'Question request is unavailable' });
      }
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
      const displayId = claudeIssuer?.activeProjectionFor({ sessionId }) || sessionId;
      jsonResponse(response, 200, { ...away.snapshot(), ...state.planSummary(displayId) });
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
      if (Object.hasOwn(body, 'claudeLineage')) {
        const attached = await applyClaudeLineage(body);
        if (!attached.ok) {
          jsonResponse(response, 403, { error: 'Writer unavailable', reason: attached.reason });
          return;
        }
        body = attached.body;
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
      if (decisionId.startsWith('cq-')) {
        await mutateCommonQuestion(response, decisionId, body, 'answer');
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
    const commonQuestionMutationPath = requestUrl.pathname.match(/^\/api\/decisions\/([^/]+)\/(hold|cancel)$/);
    if (request.method === 'POST' && commonQuestionMutationPath) {
      if (request.headers['x-cockpit-secret'] !== info.uiSecret) {
        jsonResponse(response, 401, { error: 'Unauthorized' });
        return;
      }
      if (!validRequiredUiOrigin(request, info.port)) {
        jsonResponse(response, 403, { error: 'Forbidden' });
        return;
      }
      let body;
      try { body = JSON.parse(await readJsonBody(request)); }
      catch (error) {
        jsonResponse(response, error.statusCode || 400, { error: error.statusCode === 413 ? 'Payload too large' : 'Invalid JSON' });
        return;
      }
      let internalQuestionId;
      try { internalQuestionId = decodeURIComponent(commonQuestionMutationPath[1]); }
      catch {
        jsonResponse(response, 400, { error: 'Invalid question id' });
        return;
      }
      if (!internalQuestionId.startsWith('cq-')) {
        jsonResponse(response, 404, { error: 'Question not found' });
        return;
      }
      await mutateCommonQuestion(response, internalQuestionId, body, commonQuestionMutationPath[2]);
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
      const estimate = await estimateTranscript(claudeHome, file?.cwd, file?.native_session_id || sessionId);
      const saved = state.saveEstimate(sessionId, estimate);
      if (!saved) {
        jsonResponse(response, 409, { error: 'Session state is known' });
        return;
      }
      jsonResponse(response, 200, saved);
      return;
    }
    if (request.method === 'POST' && requestUrl.pathname === '/api/record-deletions') {
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
      const keys = ['session_ids', 'merge_history', 'closed_pull_requests'];
      const validPullRequest = (record) => record && typeof record === 'object' && !Array.isArray(record)
        && Object.keys(record).length === 3 && Object.keys(record).every((key) => ['owner', 'repo', 'number'].includes(key))
        && validRepositoryPart(record.owner) && validRepositoryPart(record.repo)
        && Number.isSafeInteger(record.number) && record.number > 0;
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some((key) => !keys.includes(key))
        || keys.some((key) => Object.hasOwn(body, key) && (!Array.isArray(body[key]) || body[key].length > 50
          || !body[key].every(key === 'session_ids' ? isShortSessionId : validPullRequest)))
        || !keys.some((key) => body[key]?.length > 0)) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const sessionIds = [...new Set(body.session_ids || [])];
      const projections = sessionIds.length ? await currentValidatedSessionProjectionRecords() : null;
      if (projections?.configuredSourceUnavailable) {
        jsonResponse(response, 503, { error: 'Session target is unavailable' });
        return;
      }
      const projectionProviders = new Map(sessionIds.map((sessionId) => [
        sessionId, projections ? resolveProjectionProvidersForSession(projections, sessionId) : [],
      ]));
      if ([...projectionProviders.values()].some((providers) => providers.length > 1)) {
        jsonResponse(response, 409, { error: 'Session target is ambiguous' });
        return;
      }
      const now = Date.now();
      let sessions = 0;
      for (const sessionId of sessionIds) {
        const provider = projectionProviders.get(sessionId)?.[0];
        if (provider) {
          if (state.deleteProjectionDisplay(provider, sessionId, now)) sessions += 1;
        } else if (state.deleteSession(sessionId, now)) sessions += 1;
      }
      const deletedPullRequests = new Set();
      const changedRepositories = new Map();
      for (const record of body.merge_history || []) {
        if (state.dismissMergedPullRequestHistory(record.owner, record.repo, record.number, now)) {
          deletedPullRequests.add(`${record.owner.toLowerCase()}/${record.repo.toLowerCase()}#${record.number}`);
        }
      }
      for (const record of body.closed_pull_requests || []) {
        if (!state.deleteClosedPullRequest(record.owner, record.repo, record.number)) continue;
        const repository = `${record.owner.toLowerCase()}/${record.repo.toLowerCase()}`;
        deletedPullRequests.add(`${repository}#${record.number}`);
        changedRepositories.set(repository, record);
      }
      for (const { owner, repo } of changedRepositories.values()) {
        try {
          await pullRequestTracker?.refreshReviewGroups?.(owner, repo);
        } catch {
          logLine(homeDir, `pull request group refresh failed for ${owner}/${repo}`);
        }
      }
      jsonResponse(response, 200, { deleted: { sessions, pullRequests: deletedPullRequests.size } });
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
        const sessionIds = [...new Set(body.session_ids)];
        const projections = await currentValidatedSessionProjectionRecords();
        if (projections.configuredSourceUnavailable) {
          jsonResponse(response, 503, { error: 'Session target is unavailable' });
          return;
        }
        const projectionProviders = new Map();
        for (const sessionId of sessionIds) {
          const currentProviders = resolveProjectionProvidersForSession(projections, sessionId);
          const hiddenProviders = state.projectionDisplayRecordsForSession(sessionId)
            .filter((record) => record.hiddenAt !== undefined).map((record) => record.provider);
          const providers = currentProviders.length ? currentProviders : [...new Set(hiddenProviders)];
          if (providers.length > 1) {
            jsonResponse(response, 409, { error: 'Session target is ambiguous' });
            return;
          }
          projectionProviders.set(sessionId, providers[0] || null);
        }
        const unhiddenIds = new Set();
        const stateHiddenIds = new Set(sessionIds.filter((sessionId) => state.hiddenSessions.has(sessionId)));
        state.unhideSessions(sessionIds);
        for (const sessionId of sessionIds) {
          const provider = projectionProviders.get(sessionId);
          const projectionUnhidden = provider && state.setProjectionHidden(provider, sessionId, false);
          if (projectionUnhidden || stateHiddenIds.has(sessionId)) unhiddenIds.add(sessionId);
        }
        jsonResponse(response, 200, { unhidden: unhiddenIds.size });
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
      const sessionIds = [...new Set(isSingleHide ? [body.session_id] : body.session_ids)];
      const projections = await currentValidatedSessionProjectionRecords();
      if (projections.configuredSourceUnavailable) {
        jsonResponse(response, 503, { error: 'Session target is unavailable' });
        return;
      }
      const projectionProviders = new Map(sessionIds.map((sessionId) => [
        sessionId, resolveProjectionProvidersForSession(projections, sessionId),
      ]));
      if ([...projectionProviders.values()].some((providers) => providers.length > 1)) {
        jsonResponse(response, 409, { error: 'Session target is ambiguous' });
        return;
      }
      let hiddenCount = 0;
      for (const sessionId of sessionIds) {
        const provider = projectionProviders.get(sessionId)?.[0];
        const projectionHidden = provider ? state.setProjectionHidden(provider, sessionId, true) : false;
        const stateHidden = state.hideSession(sessionId) !== null;
        if (projectionHidden || stateHidden) hiddenCount += 1;
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
    if (request.method === 'POST' && requestUrl.pathname === '/api/claude/writer') {
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
      if (!hasExactKeys(body, ['ppid', 'contextPid']) || !Number.isSafeInteger(body.ppid) || body.ppid < 1 ||
          !Number.isSafeInteger(body.contextPid) || body.contextPid < 1) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      if (!claudeIssuer) {
        jsonResponse(response, 503, { error: 'Claude writer issuer unavailable' });
        return;
      }
      const attested = await claudeIssuer.attestMcp({ ppid: body.ppid, contextPid: body.contextPid });
      if (!attested.ok) {
        jsonResponse(response, 403, { error: 'Writer unavailable', reason: attested.reason });
        return;
      }
      jsonResponse(response, 200, { writer: attested.writer });
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
      if (Object.hasOwn(body, 'claudeLineage')) {
        const attached = await applyClaudeLineage(body);
        if (!attached.ok) {
          jsonResponse(response, 403, { error: 'Writer unavailable', reason: attached.reason });
          return;
        }
        body = attached.body;
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
      const incomingEvent = sanitizeEvent(eventBody, { product, sessionName });
      const deletedAt = incomingEvent && state.deletedSessions.get(incomingEvent.session_id);
      if (deletedAt && incomingEvent.hookAt <= Date.parse(deletedAt)) {
        jsonResponse(response, 202, { accepted: true });
        return;
      }
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
      if (registration) {
        const display = state.projectionDisplayFor(registration.provider, stateEventBody.session_id);
        if (display?.deletedAt && (typeof stateEventBody.hookAt !== 'number' || !Number.isFinite(stateEventBody.hookAt) ||
            stateEventBody.hookAt <= Date.parse(display.deletedAt))) {
          jsonResponse(response, 202, { accepted: true });
          return;
        }
      }
      state.captureFieldNames(stateEventBody);
      const eventMetadata = {
        product,
        ...(registration ? { provider: registration.provider } : {}),
        sessionName,
        agentDefinition,
        codexAgentDefinition: codexDefinitionMetadata,
        ...(preserveProjectionOrder ? { preserveProjectionOrder: true } : {}),
        ...(registration ? { onVerifiedStateWrite: (event) => event.hook_event_name !== 'SessionEnd' &&
          state.clearProjectionDeletionAfterVerifiedWrite(registration.provider, event.session_id, event.hookAt) } : {}),
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
      const sessionId = await resolveFreshWriterSessionId(routeSessionId, body);
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
      const sessionId = await resolveFreshWriterSessionId(routeSessionId, body);
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
  handler.flushQuestionLosses = async () => { await Promise.all([...pendingQuestionLosses]); };
  handler.flushInstructionLosses = flushInstructionLosses;
  return handler;
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
  if (options.onShutdown !== undefined && typeof options.onShutdown !== 'function') {
    throw new TypeError('onShutdown must be a function');
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
  let shutdownError = null;
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
    claudeIssuer,
    launchRegistry,
    questionService,
    questionServiceReady,
    pendingQuestionLosses,
    instructionService,
    instructionServiceReady,
    instructionTargetState: options.instructionTargetState,
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
  const sessionScanTimer = setInterval(() => { refreshSessionFiles().catch(() => {}); }, options.sessionScanIntervalMs || SESSION_SCAN_INTERVAL_MS);
  sessionScanTimer.unref();

  const idleTimer = setInterval(async () => {
    if (Date.now() - lastRequestAt < IDLE_TIMEOUT_MS) return;
    if (state.snapshot().sessions.length > 0) return;
    if (await hasSessionJsonFiles(claudeHome)) return;
    logLine(homeDir, 'stopping after idle timeout');
    await close().catch((error) => { shutdownError ||= error; });
  }, 60_000);
  idleTimer.unref();

  async function close() {
    if (closing) return closing;
    closing = (async () => {
      let failure = null;
      const attempt = async (operation) => {
        try { await operation(); } catch (error) { failure ||= error; }
      };
      clearInterval(idleTimer);
      clearInterval(sessionScanTimer);
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
      if (failure) {
        shutdownError = failure;
        logLine(homeDir, 'shutdown incomplete');
        throw failure;
      }
      logLine(homeDir, 'stopped');
    })();
    return closing;
  }

  return { server, state, away, routing, answerDelivery, questionService, instructionService, pullRequestTracker,
    pullRequestMergeManager, info, homeDir, close,
    get shutdownError() { return shutdownError ? 'shutdown_incomplete' : null; } };
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
