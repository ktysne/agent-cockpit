const readline = require('node:readline');
const { cockpitHomeFromOptions } = require('../server/identity');
const { postToServer } = require('../client/server-connection');
const { COMPLETE_COMMIT_SHA_PATTERN, isCompleteCommitSha, parsePullRequestUrl, validRepositoryPart } = require('../server/pull-request-utils');
const { isIdentifier, normalizeQuestions } = require('../server/common-question-kernel');

const SERVER_NAME = 'agent-cockpit';
const SERVER_VERSION = '0.0.0';
const PROTOCOL_VERSION = '2025-06-18';
const MCP_TIMEOUT_MS = 5000;
const MCP_GITHUB_TIMEOUT_MS = 60000;
const UNREACHABLE_MESSAGE = 'ダッシュボードに書けなかった。作業は続けてよい';
const WRITER_REQUIRED_MESSAGE = 'このセッションの認証済み登録情報を確認できませんでした。';
const CLAUDE_REASON_MESSAGES = new Map([
  ['claude_parent_unverified', 'この MCP サーバーの親プロセスを Claude と確認できませんでした。シェルやラッパーを挟まずに Claude から直接起動してください。'],
  ['claude_session_mismatch', 'この MCP サーバーの親の Claude のセッションを確認できませんでした。'],
  ['claude_sessions_unreadable', 'Claude のセッションファイルを読めないため、このセッションを確認できませんでした。'],
  ['claude_registration_failed', 'このセッションを登録核へ登録できませんでした。'],
]);
const TIMEOUT_MESSAGE = '常駐サーバーの応答が時間内に返らず、記録できたかを確かめられなかった。処理が続いている可能性があるため、ダッシュボードで確かめてほしい';
const MAX_RESULT_ITEMS = 10;
const PLAN_ERROR_MESSAGES = new Map([
  [400, '入力が正しくないか、上限を超えています'],
  [404, '判断事項が見つからないか、解決済みです'],
]);
const PR_ERROR_MESSAGES = new Map([[400, 'PR の URL が正しくありません']]);
const REVIEW_SKIP_ERROR_MESSAGES = new Map([
  [400, 'owner、repo、PR 番号、head SHA、理由を確認してください'],
  [404, 'このセッションで登録した PR が見つかりません'],
  [409, 'PR の head が変わったか、オープンではありません。現在の状態を確認してください'],
  [502, 'GitHub から PR の状態を確認できませんでした'],
]);

const OUTPUT_FAILURE_HANDLERS = new WeakMap();

const TOOL_DEFINITIONS = [
  {
    name: 'cockpit_set_tasks',
    description: 'タスクと完了条件の一覧をセッションに記録します。タスクの状態や完了条件が変わったときは、一覧全体を新しい内容に置き換えます。',
    inputSchema: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              title: { type: 'string', maxLength: 200 },
              state: { type: 'string', enum: ['todo', 'doing', 'done'] },
              criteria: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: { text: { type: 'string', maxLength: 2000 }, met: { type: 'boolean' } },
                  required: ['text', 'met'],
                  additionalProperties: false,
                },
                maxItems: 20,
              },
            },
            required: ['title', 'state', 'criteria'],
            additionalProperties: false,
          },
          maxItems: 50,
        },
      },
      required: ['tasks'],
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_add_decision',
    description: 'セッションで扱う判断事項を一件追加します。開発者に確認中なら waiting、推奨を適用して進めるなら provisional を指定します。',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', maxLength: 200 },
        context: { type: 'string', maxLength: 2000 },
        state: { type: 'string', enum: ['waiting', 'provisional'] },
        options: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', maxLength: 200 },
              description: { type: 'string', maxLength: 2000 },
              recommended: { type: 'boolean' },
            },
            required: ['label', 'description', 'recommended'],
            additionalProperties: false,
          },
          maxItems: 6,
        },
      },
      required: ['title', 'context', 'state', 'options'],
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_update_decision',
    description: '判断事項の状態と選んだ内容を更新します。推奨を適用して進めるときは provisional、判断が終わったときは resolved を指定します。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', maxLength: 256 },
        state: { type: 'string', enum: ['provisional', 'resolved'] },
        chosen: { type: 'string', maxLength: 2000 },
        note: { type: 'string', maxLength: 2000 },
      },
      required: ['id', 'state', 'chosen', 'note'],
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_register_question',
    description: '通常判断の質問をこの実行期間に登録します。回答はダッシュボードで選択し、回答pollで一度だけ取得します。',
    inputSchema: {
      type: 'object',
      properties: {
        questionId: { type: 'string', minLength: 1, maxLength: 512 },
        questions: {
          type: 'array', minItems: 1, maxItems: 4,
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', minLength: 1, maxLength: 512 },
              text: { type: 'string', minLength: 1, maxLength: 2000 },
              mode: { type: 'string', enum: ['single', 'multi'] },
              options: {
                type: 'array', maxItems: 6,
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', minLength: 1, maxLength: 512 },
                    label: { type: 'string', minLength: 1, maxLength: 200 },
                    description: { type: 'string', maxLength: 2000 },
                  },
                  required: ['id', 'label', 'description'],
                  additionalProperties: false,
                },
              },
              allowFreeText: { type: 'boolean' },
              recommendedOptionId: { oneOf: [{ type: 'string', maxLength: 512 }, { type: 'null' }] },
            },
            required: ['id', 'text', 'mode', 'options', 'allowFreeText', 'recommendedOptionId'],
            additionalProperties: false,
          },
        },
        timeoutMinutes: { type: 'integer', minimum: 1, maximum: 30 },
      },
      required: ['questionId', 'questions', 'timeoutMinutes'],
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_question_status',
    description: '質問の受付、選択、配信状態だけを確認します。回答内容や自由記入は返しません。',
    inputSchema: {
      type: 'object',
      properties: { questionId: { type: 'string', minLength: 1, maxLength: 512 } },
      required: ['questionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_answer_poll',
    description: '保存済み回答を一度だけ取得します。本文は送信開始が永続化された場合にだけ返り、再送しません。',
    inputSchema: {
      type: 'object',
      properties: { questionId: { type: 'string', minLength: 1, maxLength: 512 } },
      required: ['questionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_add_pr',
    description: 'このセッションが作成した GitHub のプルリクエストをダッシュボードに登録します。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', maxLength: 2000 } },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_skip_review',
    description: '理由を添えて、登録済み PR の指定した head をクロスレビュー不要として記録します。head が変わると記録は無効になります。',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,100}$' },
        repo: { type: 'string', pattern: '^[A-Za-z0-9._-]{1,100}$' },
        number: { type: 'integer', minimum: 1 },
        headRefOid: { type: 'string', pattern: COMPLETE_COMMIT_SHA_PATTERN.source },
        reason: { type: 'string', minLength: 1, maxLength: 2000 },
      },
      required: ['owner', 'repo', 'number', 'headRefOid', 'reason'],
      additionalProperties: false,
    },
  },
];

function toolResult(text, isError = false) {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

function planArguments(toolName, args) {
  if (toolName === 'cockpit_set_tasks') return { kind: 'tasks', tasks: args.tasks };
  if (toolName === 'cockpit_add_decision') {
    return {
      kind: 'add_decision',
      title: args.title,
      context: args.context,
      state: args.state,
      options: args.options,
    };
  }
  return {
    kind: 'update_decision',
    id: args.id,
    state: args.state,
    chosen: args.chosen,
    note: args.note,
  };
}

function shortSavedList(toolName, saved) {
  if (toolName === 'cockpit_set_tasks') {
    const tasks = Array.isArray(saved.tasks) ? saved.tasks : [];
    const summary = tasks.slice(0, MAX_RESULT_ITEMS).map((task) => `${task.title} (${task.state})`).join('、');
    const remainder = tasks.length > MAX_RESULT_ITEMS ? `、ほか ${tasks.length - MAX_RESULT_ITEMS} 件` : '';
    return `タスクを記録しました${summary ? `: ${summary}${remainder}` : '。'}`;
  }
  const decisions = Array.isArray(saved.decisions)
    ? saved.decisions
    : saved.decision ? [saved.decision] : [];
  if (!decisions.length) return '判断事項を更新しました。';
  const action = toolName === 'cockpit_add_decision' ? '判断事項を追加しました' : '判断事項を更新しました';
  const summary = decisions.slice(0, MAX_RESULT_ITEMS).map((decision) => `${decision.id} ${decision.title} (${decision.state})`).join('、');
  const remainder = decisions.length > MAX_RESULT_ITEMS ? `、ほか ${decisions.length - MAX_RESULT_ITEMS} 件` : '';
  return `${action}: ${summary}${remainder}`;
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPlainDataRecord(value, fields) {
  try {
    if (!isRecord(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) return false;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== fields.length || fields.some((field) => !keys.includes(field))) return false;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return fields.every((field) => Object.hasOwn(descriptors[field], 'value') && descriptors[field].enumerable);
  } catch { return false; }
}

function copiedWriterEnvelope(input) {
  const writerFields = ['token', 'identity', 'contextId', 'executionId'];
  const identityFields = ['provider', 'nativeIdKind', 'hostId', 'homeScopeId', 'nativeId'];
  if (!isPlainDataRecord(input, writerFields) || !isPlainDataRecord(input.identity, identityFields)) return null;
  const descriptors = Object.getOwnPropertyDescriptors(input);
  const identityDescriptors = Object.getOwnPropertyDescriptors(input.identity);
  const writer = Object.fromEntries(writerFields.map((field) => [field, descriptors[field].value]));
  writer.identity = Object.fromEntries(identityFields.map((field) => [field, identityDescriptors[field].value]));
  return writer;
}

function resolveMcpWriter(options = {}) {
  const hasGetter = Object.hasOwn(options, 'getWriter');
  const hasFixedWriter = Object.hasOwn(options, 'writer');
  if (hasGetter && hasFixedWriter) return null;
  let source;
  if (hasGetter) {
    if (typeof options.getWriter !== 'function') return null;
    try { source = options.getWriter(); } catch { return null; }
    try {
      if (source instanceof Promise) {
        Promise.prototype.then.call(source, undefined, () => {});
        return null;
      }
      if (source && typeof source.then === 'function') return null;
    } catch { return null; }
  } else {
    source = options.writer;
  }
  const writer = copiedWriterEnvelope(source);
  if (!writer) return null;

  const { provider, nativeIdKind, hostId, homeScopeId, nativeId } = writer.identity;
  if (typeof writer.token !== 'string' || writer.token.length === 0 ||
    typeof writer.contextId !== 'string' || writer.contextId.length === 0 ||
    typeof writer.executionId !== 'string' || writer.executionId.length === 0 ||
    ![provider, nativeIdKind, hostId, homeScopeId, nativeId].every((value) => typeof value === 'string' && value.length > 0)) {
    return null;
  }

  const meta = options.runtimeMeta;
  if (meta !== undefined && meta !== null && !isRecord(meta)) return null;
  if (isRecord(meta) && Object.hasOwn(meta, 'provider') &&
    (!['claude', 'codex'].includes(meta.provider) || meta.provider !== provider)) {
    return null;
  }

  if (provider === 'codex') {
    if (nativeIdKind !== 'thread' || !isRecord(meta) ||
      typeof meta.threadId !== 'string' || meta.threadId !== nativeId) {
      return null;
    }
  } else if (provider === 'claude') {
    if (nativeIdKind !== 'session' || (isRecord(meta) && meta.threadId !== undefined)) return null;
  } else {
    return null;
  }

  return {
    token: writer.token,
    identity: { provider, nativeIdKind, hostId, homeScopeId, nativeId },
    contextId: writer.contextId,
    executionId: writer.executionId,
  };
}

function writerErrorMessage(options = {}) {
  const reason = typeof options.getWriterFailure === 'function' ? options.getWriterFailure() : null;
  return CLAUDE_REASON_MESSAGES.get(reason) || WRITER_REQUIRED_MESSAGE;
}

function writerError(options) {
  return { errorMessage: writerErrorMessage(options) };
}

function postMcpRequest(requestPath, body, options, deadline, { maxAttempts = 2, attemptTimeoutMs = 2000 } = {}) {
  return postToServer(requestPath, body, {
    homeDir: options.homeDir || cockpitHomeFromOptions(options),
    environment: options.environment || process.env,
    fetchImpl: options.fetchImpl || fetch,
    startServer: options.startServer,
    ensureServerRunning: options.ensureServerRunning,
    readServerInfo: options.readServerInfo,
    deadline,
    now: options.now || Date.now,
    attemptTimeoutMs,
    maxAttempts,
    // タイムアウト後も常駐サーバーで処理が続くため、同じ書き込みを再送しない。
    retryAfterTimeout: false,
    ensure: true,
  });
}

// writer が無いとき、または 403 で拒否されたときに限り、refreshWriter で照合し直して 1 回だけ送り直す。
async function postWithWriter(requestPath, buildBody, options, deadline, firstWriter, requestOptions = {}) {
  let writer = firstWriter;
  if (!writer && options.refreshWriter) {
    await options.refreshWriter(deadline, { discard: false });
    writer = resolveMcpWriter(options);
  }
  if (!writer) return { writer: null, result: null, writerRejected: true };
  let result = await postMcpRequest(requestPath, buildBody(writer), options, deadline, requestOptions);
  if (!result.ok && result.status === 403 && options.refreshWriter) {
    await options.refreshWriter(deadline, { discard: true });
    writer = resolveMcpWriter(options);
    if (!writer) return { writer: null, result, writerRejected: true };
    result = await postMcpRequest(requestPath, buildBody(writer), options, deadline, requestOptions);
    return { writer, result, writerRejected: !result.ok && result.status === 403 };
  }
  return { writer, result, writerRejected: false };
}

function requestDeadline(options, timeoutMs) {
  const now = options.now || Date.now;
  return options.deadline ?? now() + timeoutMs;
}

async function postPlan(toolName, args, options = {}) {
  const deadline = requestDeadline(options, MCP_TIMEOUT_MS);
  const plan = planArguments(toolName, args);
  const { result, writerRejected } = await postWithWriter(
    '/api/sessions/pending/plan', (writer) => ({ ...plan, writer }), options, deadline, resolveMcpWriter(options),
    { maxAttempts: 2 },
  );
  if (writerRejected) return writerError(options);
  if (result.ok) return result.json;
  if (result.timedOut) return { timedOut: true };
  const errorMessage = PLAN_ERROR_MESSAGES.get(result.status);
  return errorMessage ? { errorMessage } : null;
}

async function postPullRequest(args, options = {}) {
  const firstWriter = resolveMcpWriter(options);
  if (!firstWriter && !options.refreshWriter) return writerError(options);
  const pullRequest = parsePullRequestUrl(args.url);
  if (!pullRequest) return { errorMessage: PR_ERROR_MESSAGES.get(400) };
  const deadline = requestDeadline(options, MCP_TIMEOUT_MS);
  const cwd = options.cwd === undefined ? process.cwd() : options.cwd;
  const { result, writerRejected } = await postWithWriter(
    '/api/sessions/pending/prs',
    (writer) => ({ kind: 'add_pr', url: pullRequest.url, cwd, writer }),
    options, deadline, firstWriter, { maxAttempts: 2 },
  );
  if (writerRejected) return writerError(options);
  if (result.ok) return result.json;
  if (result.timedOut) return { timedOut: true };
  const errorMessage = PR_ERROR_MESSAGES.get(result.status);
  return errorMessage ? { errorMessage } : null;
}

async function postCrossReviewSkip(args, options = {}) {
  const firstWriter = resolveMcpWriter(options);
  if (!firstWriter && !options.refreshWriter) return writerError(options);
  if (!validRepositoryPart(args.owner) || !validRepositoryPart(args.repo) || !Number.isSafeInteger(args.number) || args.number < 1 ||
    !isCompleteCommitSha(args.headRefOid) || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 2000) {
    return { errorMessage: REVIEW_SKIP_ERROR_MESSAGES.get(400) };
  }
  const deadline = requestDeadline(options, MCP_GITHUB_TIMEOUT_MS);
  const { result, writerRejected } = await postWithWriter(
    '/api/sessions/pending/prs',
    (writer) => ({
      kind: 'skip_review',
      owner: args.owner,
      repo: args.repo,
      number: args.number,
      headRefOid: args.headRefOid,
      reason: args.reason,
      writer,
    }),
    options, deadline, firstWriter, { maxAttempts: 2, attemptTimeoutMs: MCP_GITHUB_TIMEOUT_MS },
  );
  if (writerRejected) return writerError(options);
  if (result.ok) return result.json;
  if (result.timedOut) return { timedOut: true };
  const errorMessage = REVIEW_SKIP_ERROR_MESSAGES.get(result.status);
  return errorMessage ? { errorMessage } : null;
}

function exactArgumentKeys(args, expected) {
  return Object.keys(args).length === expected.length && expected.every((key) => Object.hasOwn(args, key));
}

function validCommonQuestionArguments(name, args) {
  if (name === 'cockpit_register_question') {
    if (!exactArgumentKeys(args, ['questionId', 'questions', 'timeoutMinutes']) ||
        !isIdentifier(args.questionId) || !Number.isSafeInteger(args.timeoutMinutes) ||
        args.timeoutMinutes < 1 || args.timeoutMinutes > 30) return false;
    try { normalizeQuestions(args.questions); return true; } catch { return false; }
  }
  return exactArgumentKeys(args, ['questionId']) && isIdentifier(args.questionId);
}

function questionStatusText(question, registered = false) {
  if (!question || typeof question !== 'object') return registered ? '質問を登録しました。' : '質問が見つかりません。';
  return JSON.stringify({
    questionId: question.questionId,
    revision: question.revision,
    createdAt: question.createdAt,
    deadlineAt: question.deadlineAt,
    held: question.held,
    selectionSource: question.selectionSource,
    deliveryAttemptId: question.deliveryAttemptId,
    deliveryState: question.deliveryState,
  });
}

async function notifyQuestionResponseLost(questionId, writer, options) {
  try {
    await postMcpRequest('/api/sessions/pending/questions/response-lost', {
      writer, questionId,
    }, options, requestDeadline(options, MCP_TIMEOUT_MS), { maxAttempts: 1 });
  } catch {}
}

async function postCommonQuestion(name, args, options = {}) {
  const firstWriter = resolveMcpWriter(options);
  if (!firstWriter && !options.refreshWriter) return toolResult(writerErrorMessage(options), true);
  if (!validCommonQuestionArguments(name, args)) return toolResult('入力が正しくありません。', true);

  const maxAttempts = name === 'cockpit_answer_poll' ? 1 : 2;
  const routes = {
    cockpit_register_question: '/api/sessions/pending/questions/register',
    cockpit_question_status: '/api/sessions/pending/questions/status',
    cockpit_answer_poll: '/api/sessions/pending/questions/answer-poll',
  };
  const buildBody = (writer) => (name === 'cockpit_register_question'
    ? { writer, questionId: args.questionId, questions: args.questions, timeoutMinutes: args.timeoutMinutes }
    : { writer, questionId: args.questionId });
  const deadline = requestDeadline(options, MCP_TIMEOUT_MS);
  let response;
  let writer = null;
  try {
    const outcome = await postWithWriter(routes[name], buildBody, options, deadline, firstWriter, { maxAttempts });
    if (outcome.writerRejected) return toolResult(writerErrorMessage(options), true);
    response = outcome.result;
    writer = outcome.writer;
  } catch { response = null; writer = firstWriter; }

  if (!response || !response.ok) {
    if (name === 'cockpit_answer_poll' && (!response || response.status === null || response.status >= 500)) {
      if (writer) await notifyQuestionResponseLost(args.questionId, writer, options);
    }
    const message = response?.timedOut ? TIMEOUT_MESSAGE
      : response?.status === 400 ? '質問の入力を確認してください。'
        : response?.status === 403 ? WRITER_REQUIRED_MESSAGE
          : response?.status === 404 ? 'この実行期間の質問が見つかりません。'
            : response?.status === 409 ? '質問の内容が変わったため登録できません。'
              : response?.status === 503 ? '質問サービスを利用できません。'
                : UNREACHABLE_MESSAGE;
    return toolResult(message, true);
  }

  const result = response.json;
  if (name === 'cockpit_register_question') {
    return toolResult(questionStatusText(result?.question || result, true));
  }
  if (name === 'cockpit_question_status') {
    return toolResult(questionStatusText(result));
  }

  const status = result?.status || result;
  const delivery = result?.delivery || null;
  if (!delivery || !Array.isArray(delivery.answers)) {
    return toolResult(JSON.stringify({
      questionId: status?.questionId || args.questionId,
      deliveryAttemptId: status?.deliveryAttemptId || null,
      state: status?.deliveryState || status?.state || null,
      delivered: false,
    }));
  }
  const delivered = {
    questionId: delivery.questionId,
    revision: delivery.revision,
    deliveryAttemptId: delivery.deliveryAttemptId,
    answers: delivery.answers,
  };
  const toolResponse = toolResult(JSON.stringify(delivered));
  OUTPUT_FAILURE_HANDLERS.set(toolResponse, () => notifyQuestionResponseLost(args.questionId, writer, options));
  return toolResponse;
}

async function callTool(name, args, options = {}) {
  const tool = TOOL_DEFINITIONS.find((item) => item.name === name);
  if (!tool) return toolResult('指定されたツールはありません。', true);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return toolResult('入力が正しくありません。', true);
  if (!Object.keys(args).every((key) => Object.hasOwn(tool.inputSchema.properties, key))) {
    return toolResult('入力が正しくありません。', true);
  }
  if (['cockpit_register_question', 'cockpit_question_status', 'cockpit_answer_poll'].includes(name)) {
    return postCommonQuestion(name, args, options);
  }
  if (name === 'cockpit_add_pr') {
    const saved = await postPullRequest(args, options);
    if (saved?.timedOut) return toolResult(TIMEOUT_MESSAGE, true);
    if (!saved) return toolResult(UNREACHABLE_MESSAGE, true);
    if (saved.errorMessage) return toolResult(saved.errorMessage, true);
    return toolResult(`PR #${saved.number} (${saved.owner}/${saved.repo}) を登録しました。`);
  }
  if (name === 'cockpit_skip_review') {
    const saved = await postCrossReviewSkip(args, options);
    if (saved?.timedOut) return toolResult(TIMEOUT_MESSAGE, true);
    if (!saved) return toolResult(UNREACHABLE_MESSAGE, true);
    if (saved.errorMessage) return toolResult(saved.errorMessage, true);
    return toolResult(`PR #${saved.number} (${saved.owner}/${saved.repo}) の head ${saved.headRefOid.slice(0, 7)} をクロスレビュー不要として記録しました。`);
  }
  const saved = await postPlan(name, args, options);
  if (saved?.timedOut) return toolResult(TIMEOUT_MESSAGE, true);
  if (!saved) return toolResult(UNREACHABLE_MESSAGE, true);
  if (saved.errorMessage) return toolResult(saved.errorMessage, true);
  return toolResult(shortSavedList(name, saved));
}

async function handleRequest(request, options = {}) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (request.method.startsWith('notifications/')) return null;
  if (request.method === 'initialize') {
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: {
        protocolVersion: request.params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      },
    };
  }
  if (request.method === 'ping') return { jsonrpc: '2.0', id: request.id, result: {} };
  if (request.method === 'tools/list') {
    return { jsonrpc: '2.0', id: request.id, result: { tools: TOOL_DEFINITIONS } };
  }
  if (request.method === 'tools/call') {
    const name = request.params?.name;
    const callOptions = { ...options, runtimeMeta: request.params?._meta };
    const result = await callTool(name, request.params?.arguments || {}, callOptions);
    const response = { jsonrpc: '2.0', id: request.id, result };
    const outputFailure = OUTPUT_FAILURE_HANDLERS.get(result);
    if (outputFailure) OUTPUT_FAILURE_HANDLERS.set(response, outputFailure);
    return response;
  }
  return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
}

function startMcpServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const reader = readline.createInterface({ input });
  const pending = new Set();
  const outputFailures = new Set();
  const onOutputError = () => {
    for (const fail of [...outputFailures]) fail();
  };
  output.on('error', onOutputError);

  function writeResponse(response) {
    if (!response) return Promise.resolve();
    const line = JSON.stringify(response) + '\n';
    const reportLost = OUTPUT_FAILURE_HANDLERS.get(response);
    return new Promise((resolve) => {
      let settled = false;
      const fail = () => {
        if (settled) return;
        settled = true;
        outputFailures.delete(fail);
        Promise.resolve(reportLost?.()).catch(() => {}).finally(resolve);
      };
      const complete = (error) => {
        if (error) { fail(); return; }
        if (settled) return;
        settled = true;
        outputFailures.delete(fail);
        resolve();
      };
      outputFailures.add(fail);
      try { output.write(line, complete); }
      catch { fail(); }
    });
  }

  reader.on('line', (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      void writeResponse({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (request?.method === 'exit' && request.id === undefined) {
      reader.close();
      return;
    }
    if (request?.id === undefined) return;
    const operation = handleRequest(request, options)
      .then((response) => writeResponse(response))
      .catch(() => writeResponse({
        jsonrpc: '2.0',
        id: request.id,
        result: toolResult(UNREACHABLE_MESSAGE, true),
      }));
    pending.add(operation);
    operation.finally(() => pending.delete(operation));
  });
  return new Promise((resolve) => reader.once('close', async () => {
    await Promise.all([...pending]);
    output.removeListener('error', onOutputError);
    resolve();
  }));
}

// 親の Claude が申告する経路で writer を取得し、メモリーだけに持つ。token はファイルにもログにも出さない。
function createClaudeWriterSession({ ppid = process.ppid, contextPid = process.pid, ...postOptions } = {}) {
  let writer = null;
  let failureReason = null;
  let inflight = null;

  async function requestWriter(deadline) {
    const result = await postToServer('/api/claude/writer', { ppid, contextPid }, {
      homeDir: postOptions.homeDir || cockpitHomeFromOptions(postOptions),
      environment: postOptions.environment || process.env,
      fetchImpl: postOptions.fetchImpl || fetch,
      startServer: postOptions.startServer,
      ensureServerRunning: postOptions.ensureServerRunning,
      readServerInfo: postOptions.readServerInfo,
      deadline,
      attemptTimeoutMs: 2000,
      maxAttempts: 2,
      ensure: true,
      parseErrorJson: true,
    });
    if (result.ok && result.json && typeof result.json === 'object') {
      writer = result.json.writer || null;
      failureReason = null;
      return;
    }
    writer = null;
    failureReason = result.status === 403 && typeof result.errorJson?.reason === 'string' ? result.errorJson.reason : null;
  }

  // 同時に来た呼び出しは、進行中の 1 回の照合を共有する。
  function refresh(deadline = Date.now() + MCP_TIMEOUT_MS, { discard = false } = {}) {
    if (discard) writer = null;
    if (!inflight) {
      inflight = requestWriter(deadline).catch(() => { writer = null; }).finally(() => { inflight = null; });
    }
    return inflight;
  }

  return { getWriter: () => writer, getWriterFailure: () => failureReason, refreshWriter: refresh };
}

if (require.main === module) {
  const claudeWriter = createClaudeWriterSession();
  void claudeWriter.refreshWriter();
  startMcpServer(claudeWriter);
}

module.exports = {
  SERVER_NAME,
  SERVER_VERSION,
  PROTOCOL_VERSION,
  MCP_TIMEOUT_MS,
  MCP_GITHUB_TIMEOUT_MS,
  UNREACHABLE_MESSAGE,
  WRITER_REQUIRED_MESSAGE,
  TIMEOUT_MESSAGE,
  TOOL_DEFINITIONS,
  PR_ERROR_MESSAGES,
  REVIEW_SKIP_ERROR_MESSAGES,
  shortSavedList,
  planArguments,
  postPlan,
  postPullRequest,
  postCrossReviewSkip,
  callTool,
  handleRequest,
  startMcpServer,
  createClaudeWriterSession,
};
