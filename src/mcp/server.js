const readline = require('node:readline');
const { cockpitHomeFromOptions } = require('../server/identity');
const { postToServer } = require('../client/server-connection');
const { COMPLETE_COMMIT_SHA_PATTERN, isCompleteCommitSha, parsePullRequestUrl, validRepositoryPart } = require('../server/pull-request-utils');

const SERVER_NAME = 'agent-cockpit';
const SERVER_VERSION = '0.0.0';
const PROTOCOL_VERSION = '2025-06-18';
const MCP_TIMEOUT_MS = 5000;
const UNREACHABLE_MESSAGE = 'ダッシュボードに書けなかった。作業は続けてよい';
const WRITER_REQUIRED_MESSAGE = 'このセッションの認証済み登録情報を確認できませんでした。';
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

function resolveMcpWriter(options = {}) {
  const writer = options.writer;
  if (!isRecord(writer) || !isRecord(writer.identity)) return null;

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
    const sessionId = (options.environment || process.env).CLAUDE_CODE_SESSION_ID;
    if (typeof sessionId === 'string' && sessionId.length > 0 && sessionId !== nativeId) return null;
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

function writerError() {
  return { errorMessage: WRITER_REQUIRED_MESSAGE };
}

function postMcpRequest(requestPath, body, options, deadline) {
  return postToServer(requestPath, body, {
    homeDir: options.homeDir || cockpitHomeFromOptions(options),
    environment: options.environment || process.env,
    fetchImpl: options.fetchImpl || fetch,
    startServer: options.startServer,
    ensureServerRunning: options.ensureServerRunning,
    readServerInfo: options.readServerInfo,
    deadline,
    attemptTimeoutMs: 2000,
    ensure: true,
  });
}

async function postPlan(toolName, args, options = {}) {
  const writer = resolveMcpWriter(options);
  if (!writer) return writerError();
  const deadline = options.deadline || Date.now() + MCP_TIMEOUT_MS;
  const body = {
    ...planArguments(toolName, args),
    writer,
  };
  const result = await postMcpRequest('/api/sessions/pending/plan', body, options, deadline);
  if (result.ok) return result.json;
  const errorMessage = PLAN_ERROR_MESSAGES.get(result.status);
  return errorMessage ? { errorMessage } : null;
}

async function postPullRequest(args, options = {}) {
  const writer = resolveMcpWriter(options);
  if (!writer) return writerError();
  const pullRequest = parsePullRequestUrl(args.url);
  if (!pullRequest) return { errorMessage: PR_ERROR_MESSAGES.get(400) };
  const deadline = options.deadline || Date.now() + MCP_TIMEOUT_MS;
  const body = {
    kind: 'add_pr',
    url: pullRequest.url,
    cwd: options.cwd === undefined ? process.cwd() : options.cwd,
    writer,
  };
  const result = await postMcpRequest('/api/sessions/pending/prs', body, options, deadline);
  if (result.ok) return result.json;
  const errorMessage = PR_ERROR_MESSAGES.get(result.status);
  return errorMessage ? { errorMessage } : null;
}

async function postCrossReviewSkip(args, options = {}) {
  const writer = resolveMcpWriter(options);
  if (!writer) return writerError();
  if (!validRepositoryPart(args.owner) || !validRepositoryPart(args.repo) || !Number.isSafeInteger(args.number) || args.number < 1 ||
    !isCompleteCommitSha(args.headRefOid) || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 2000) {
    return { errorMessage: REVIEW_SKIP_ERROR_MESSAGES.get(400) };
  }
  const deadline = options.deadline || Date.now() + MCP_TIMEOUT_MS;
  const body = {
    kind: 'skip_review',
    owner: args.owner,
    repo: args.repo,
    number: args.number,
    headRefOid: args.headRefOid,
    reason: args.reason,
    writer,
  };
  const result = await postMcpRequest('/api/sessions/pending/prs', body, options, deadline);
  if (result.ok) return result.json;
  const errorMessage = REVIEW_SKIP_ERROR_MESSAGES.get(result.status);
  return errorMessage ? { errorMessage } : null;
}

async function callTool(name, args, options = {}) {
  const tool = TOOL_DEFINITIONS.find((item) => item.name === name);
  if (!tool) return toolResult('指定されたツールはありません。', true);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return toolResult('入力が正しくありません。', true);
  if (!Object.keys(args).every((key) => Object.hasOwn(tool.inputSchema.properties, key))) {
    return toolResult('入力が正しくありません。', true);
  }
  if (name === 'cockpit_add_pr') {
    const saved = await postPullRequest(args, options);
    if (!saved) return toolResult(UNREACHABLE_MESSAGE, true);
    if (saved.errorMessage) return toolResult(saved.errorMessage, true);
    return toolResult(`PR #${saved.number} (${saved.owner}/${saved.repo}) を登録しました。`);
  }
  if (name === 'cockpit_skip_review') {
    const saved = await postCrossReviewSkip(args, options);
    if (!saved) return toolResult(UNREACHABLE_MESSAGE, true);
    if (saved.errorMessage) return toolResult(saved.errorMessage, true);
    return toolResult(`PR #${saved.number} (${saved.owner}/${saved.repo}) の head ${saved.headRefOid.slice(0, 7)} をクロスレビュー不要として記録しました。`);
  }
  const saved = await postPlan(name, args, options);
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
    return { jsonrpc: '2.0', id: request.id, result };
  }
  return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
}

function startMcpServer(options = {}) {
  const input = options.input || process.stdin;
  const output = options.output || process.stdout;
  const reader = readline.createInterface({ input });
  const pending = new Set();
  reader.on('line', (line) => {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      output.write(`${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } })}\n`);
      return;
    }
    if (request?.method === 'exit' && request.id === undefined) {
      reader.close();
      return;
    }
    if (request?.id === undefined) return;
    const operation = handleRequest(request, options)
      .then((response) => { if (response) output.write(`${JSON.stringify(response)}\n`); })
      .catch(() => {
        output.write(`${JSON.stringify({
          jsonrpc: '2.0',
          id: request.id,
          result: toolResult(UNREACHABLE_MESSAGE, true),
        })}\n`);
      });
    pending.add(operation);
    operation.finally(() => pending.delete(operation));
  });
  return new Promise((resolve) => reader.once('close', async () => {
    await Promise.all([...pending]);
    resolve();
  }));
}

if (require.main === module) startMcpServer();

module.exports = {
  SERVER_NAME,
  SERVER_VERSION,
  PROTOCOL_VERSION,
  MCP_TIMEOUT_MS,
  UNREACHABLE_MESSAGE,
  WRITER_REQUIRED_MESSAGE,
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
};
