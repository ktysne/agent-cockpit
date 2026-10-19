const readline = require('node:readline');
const { cockpitHomeFromOptions } = require('../server/identity');
const { readSourceCommit } = require('../server/source-revision');
const { postToServer, requestFromServer } = require('../client/server-connection');

function reportMcpWrite(info, options, data) {
  void (async () => {
    if (!info) return;
    const deadline = Date.now() + 250;
    const commit = await options.sourceCommit;
    const diagnosticData = { ...data, version: SERVER_VERSION, ...(commit ? { commit } : {}) };
    await requestFromServer(info, '/api/diagnostics', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-cockpit-secret': info.secret },
      body: JSON.stringify({ entries: [{ msg: 'mcp.write', data: diagnosticData }] }),
    }, { fetchImpl: options.fetchImpl || fetch, attemptTimeoutMs: 250, deadline });
  })().catch(() => {});
}
const { COMPLETE_COMMIT_SHA_PATTERN, isCompleteCommitSha, parsePullRequestUrl, validRepositoryPart } = require('../server/pull-request-utils');
const { isHookSessionId } = require('../server/session-ids');
const { validLaunchTarget, validText } = require('../server/request-validation');

const SERVER_NAME = 'agent-cockpit';
const { version: SERVER_VERSION } = require('../../package.json');
const PROTOCOL_VERSION = '2025-06-18';
const MCP_TIMEOUT_MS = 5000;
const MCP_GITHUB_TIMEOUT_MS = 60000;
const UNREACHABLE_MESSAGE = 'ダッシュボードに書けなかった。作業は続けてよい';
const TIMEOUT_MESSAGE = '常駐サーバーの応答が時間内に返らず、記録できたかを確かめられなかった。処理が続いている可能性があるため、ダッシュボードで確かめてほしい';
const UNKNOWN_OUTCOME_MESSAGE = '常駐サーバーの応答を受け取れず、記録できたかを確かめられなかった。処理が済んでいる可能性があるため、ダッシュボードで確かめてほしい';
const MAX_RESULT_ITEMS = 10;
let codexClient = false;
const CODEX_UNREGISTERED_MESSAGE = 'Codex のフックが届いていないため記録できなかった。未登録または終了済みのセッションです。';
const DELEGATED_CODEX_UNREGISTERED_MESSAGE = 'Claude のセッションから委譲された実行なので、Agent Cockpit には記録しない。記録は委譲元の Claude のセッションが行うので、このツールを呼ばなくてよい。';
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

const SET_TASKS_DESCRIPTION = 'タスクと完了条件の一覧をセッションに記録します。タスクの状態や完了条件が変わったときは、一覧全体を新しい内容に置き換えます。完了条件は met が true なら達成、met が false で doing が true なら作業中として表示します。';

const TOOL_DEFINITIONS = [
  {
    name: 'cockpit_set_tasks',
    description: 'タスクと完了条件の一覧をセッションに記録します。このアプリのタスク一覧を使うターンで取り込みがオンなら、その一覧が cockpit の 1 つのタスクの完了条件になります。依頼ごとに題だけを 1 件 ([{title, state:"doing"}]) 登録し、完了条件は省略できます。この場合は同じ題を更新し、既存のタスクは残します。取り込みが無いときは、タスクの状態や完了条件が変わったら一覧全体を新しい内容に置き換えます。完了条件は met が true なら達成、met が false で doing が true なら作業中として表示します。',
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
                  properties: { text: { type: 'string', maxLength: 2000 }, met: { type: 'boolean' }, doing: { type: 'boolean' } },
                  required: ['text', 'met'],
                  additionalProperties: false,
                },
                maxItems: 20,
              },
            },
            required: ['title', 'state'],
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
              next: { type: 'string', maxLength: 2000 },
            },
            required: ['label', 'description', 'recommended'],
            additionalProperties: false,
          },
          maxItems: 6,
        },
        verify: {
          type: 'object',
          properties: {
            steps: {
              type: 'array', minItems: 1, maxItems: 10,
              items: {
                type: 'object',
                properties: {
                  cmd: { type: 'string', minLength: 1, maxLength: 500 },
                  note: { type: 'string', maxLength: 500 },
                },
                required: ['cmd', 'note'],
                additionalProperties: false,
              },
            },
          },
          required: ['steps'],
          additionalProperties: false,
        },
      },
      required: ['title', 'context', 'state', 'options'],
      additionalProperties: false,
    },
  },
  {
    name: 'cockpit_report_launch',
    description: '未解決の確認依頼に、起動したアプリの URL またはプロセス名を記録します。判断事項の状態は変えません。',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', minLength: 1, maxLength: 256 },
        url: { type: 'string', maxLength: 2048, pattern: '^https?://' },
        process: { type: 'string', minLength: 1, maxLength: 500 },
      },
      required: ['id'],
      oneOf: [{ required: ['url'] }, { required: ['process'] }],
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
  if (toolName === 'cockpit_report_launch') return { kind: 'report_launch', id: args.id,
    ...(args.url !== undefined ? { url: args.url } : { process: args.process }) };
  if (toolName === 'cockpit_set_tasks') return { kind: 'tasks', tasks: args.tasks };
  if (toolName === 'cockpit_add_decision') {
    return {
      kind: 'add_decision',
      title: args.title,
      context: args.context,
      state: args.state,
      options: args.options,
      ...(args.verify !== undefined ? { verify: args.verify } : {}),
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

// 常駐サーバーは、フックで登録されていないか終了した Codex のセッションと、委譲した thread への書き込みを 403 で拒否する。
// 委譲した thread は応答の error で見分ける。
async function postMcpRequest(requestPath, body, options, deadline, attemptTimeoutMs = 2000) {
  let serverInfo;
  const result = await postToServer(requestPath, body, {
    onServerInfo: info => {
      serverInfo = info;
      reportMcpWrite(info, options, { tool: options.diagnosticTool, phase: 'attempt' });
    },
    homeDir: options.homeDir || cockpitHomeFromOptions(options),
    environment: options.environment || process.env,
    fetchImpl: options.fetchImpl || fetch,
    startServer: options.startServer,
    ensureServerRunning: options.ensureServerRunning,
    readServerInfo: options.readServerInfo,
    deadline,
    now: options.now || Date.now,
    attemptTimeoutMs,
    // タイムアウトや切断の後も処理が済んでいる可能性があるため、
    // 届いていないことが確かな接続の拒否の後だけ再送する。
    retryAfterUnknownOutcome: false,
    ensure: true,
    errorJson: true,
  });
  reportMcpWrite(serverInfo, options, { tool: options.diagnosticTool, phase: 'result', ok: result.ok, status: result.status,
    ...(!result.ok ? { failure: result.timedOut ? 'timeout' : result.outcomeUnknown ? 'unknown' : result.status ? 'http' : 'unreachable' } : {}) });
  const codexUnregistered = Boolean(options.codexSessionId) && result.status === 403;
  return { ...result, codexUnregistered, codexDelegated: codexUnregistered && result.json?.error === 'Codex session delegated' };
}

function requestDeadline(options, timeoutMs) {
  const now = options.now || Date.now;
  return options.deadline ?? now() + timeoutMs;
}

function writerIdentity(options) {
  if (options.codexSessionId) return { routeSessionId: options.codexSessionId, body: { codexSessionId: options.codexSessionId } };
  const environment = options.environment || process.env;
  const sessionId = typeof environment.CLAUDE_CODE_SESSION_ID === 'string' ? environment.CLAUDE_CODE_SESSION_ID : '';
  return {
    routeSessionId: isHookSessionId(sessionId) ? sessionId : 'pending',
    body: { ppid: options.ppid === undefined ? process.ppid : options.ppid, claudeCodeSessionId: sessionId || null },
  };
}

function codexUnregisteredResult(result) {
  return result.codexDelegated
    ? { errorMessage: DELEGATED_CODEX_UNREGISTERED_MESSAGE, isError: false }
    : { errorMessage: CODEX_UNREGISTERED_MESSAGE, isError: true };
}

async function postPlan(toolName, args, options = {}) {
  const deadline = requestDeadline(options, MCP_TIMEOUT_MS);
  const identity = writerIdentity(options);
  const routeSessionId = identity.routeSessionId;
  const body = {
    ...planArguments(toolName, args),
    ...identity.body,
  };
  const result = await postMcpRequest(`/api/sessions/${encodeURIComponent(routeSessionId)}/plan`, body, options, deadline);
  if (result.ok) return result.json;
  if (result.timedOut) return { timedOut: true };
  if (result.outcomeUnknown) return { outcomeUnknown: true };
  if (result.codexUnregistered) return codexUnregisteredResult(result);
  const errorMessage = PLAN_ERROR_MESSAGES.get(result.status);
  return errorMessage ? { errorMessage } : null;
}

async function postPullRequest(args, options = {}) {
  const pullRequest = parsePullRequestUrl(args.url);
  if (!pullRequest) return { errorMessage: PR_ERROR_MESSAGES.get(400) };
  const deadline = requestDeadline(options, MCP_TIMEOUT_MS);
  const identity = writerIdentity(options);
  const routeSessionId = identity.routeSessionId;
  const body = {
    kind: 'add_pr',
    url: pullRequest.url,
    ...identity.body,
    cwd: options.cwd === undefined ? process.cwd() : options.cwd,
  };
  const result = await postMcpRequest(`/api/sessions/${encodeURIComponent(routeSessionId)}/prs`, body, options, deadline);
  if (result.ok) return result.json;
  if (result.timedOut) return { timedOut: true };
  if (result.outcomeUnknown) return { outcomeUnknown: true };
  if (result.codexUnregistered) return codexUnregisteredResult(result);
  const errorMessage = PR_ERROR_MESSAGES.get(result.status);
  return errorMessage ? { errorMessage } : null;
}

async function postCrossReviewSkip(args, options = {}) {
  if (!validRepositoryPart(args.owner) || !validRepositoryPart(args.repo) || !Number.isSafeInteger(args.number) || args.number < 1 ||
    !isCompleteCommitSha(args.headRefOid) || typeof args.reason !== 'string' || !args.reason.trim() || args.reason.length > 2000) {
    return { errorMessage: REVIEW_SKIP_ERROR_MESSAGES.get(400) };
  }
  const deadline = requestDeadline(options, MCP_GITHUB_TIMEOUT_MS);
  const identity = writerIdentity(options);
  const routeSessionId = identity.routeSessionId;
  const body = {
    kind: 'skip_review',
    owner: args.owner,
    repo: args.repo,
    number: args.number,
    headRefOid: args.headRefOid,
    reason: args.reason,
    ...identity.body,
  };
  const result = await postMcpRequest(
    `/api/sessions/${encodeURIComponent(routeSessionId)}/prs`,
    body,
    options,
    deadline,
    MCP_GITHUB_TIMEOUT_MS,
  );
  if (result.ok) return result.json;
  if (result.timedOut) return { timedOut: true };
  if (result.outcomeUnknown) return { outcomeUnknown: true };
  if (result.codexUnregistered) return codexUnregisteredResult(result);
  const errorMessage = REVIEW_SKIP_ERROR_MESSAGES.get(result.status);
  return errorMessage ? { errorMessage } : null;
}

async function callTool(name, args, options = {}) {
  const tool = TOOL_DEFINITIONS.find((item) => item.name === name);
  if (!tool) return toolResult('指定されたツールはありません。', true);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return toolResult('入力が正しくありません。', true);
  if (name === 'cockpit_report_launch' && (!validText(args.id, 256) || !validLaunchTarget(args) ||
    !Object.keys(args).every(key => ['id', 'url', 'process'].includes(key)))) return toolResult('入力が正しくありません。', true);
  options = { ...options, diagnosticTool: name };
  if (name === 'cockpit_add_pr') {
    const saved = await postPullRequest(args, options);
    if (saved?.timedOut) return toolResult(TIMEOUT_MESSAGE, true);
    if (saved?.outcomeUnknown) return toolResult(UNKNOWN_OUTCOME_MESSAGE, true);
    if (!saved) return toolResult(UNREACHABLE_MESSAGE, true);
    if (saved.errorMessage) return toolResult(saved.errorMessage, saved.isError !== false);
    return toolResult(`PR #${saved.number} (${saved.owner}/${saved.repo}) を登録しました。`);
  }
  if (name === 'cockpit_skip_review') {
    const saved = await postCrossReviewSkip(args, options);
    if (saved?.timedOut) return toolResult(TIMEOUT_MESSAGE, true);
    if (saved?.outcomeUnknown) return toolResult(UNKNOWN_OUTCOME_MESSAGE, true);
    if (!saved) return toolResult(UNREACHABLE_MESSAGE, true);
    if (saved.errorMessage) return toolResult(saved.errorMessage, saved.isError !== false);
    return toolResult(`PR #${saved.number} (${saved.owner}/${saved.repo}) の head ${saved.headRefOid.slice(0, 7)} をクロスレビュー不要として記録しました。`);
  }
  const saved = await postPlan(name, args, options);
  if (saved?.timedOut) return toolResult(TIMEOUT_MESSAGE, true);
  if (saved?.outcomeUnknown) return toolResult(UNKNOWN_OUTCOME_MESSAGE, true);
  if (!saved) return toolResult(UNREACHABLE_MESSAGE, true);
  if (saved.errorMessage) return toolResult(saved.errorMessage, saved.isError !== false);
  return toolResult(shortSavedList(name, saved));
}

async function handleRequest(request, options = {}) {
  if (!request || request.jsonrpc !== '2.0' || typeof request.method !== 'string') {
    return { jsonrpc: '2.0', id: request?.id ?? null, error: { code: -32600, message: 'Invalid Request' } };
  }
  if (request.method.startsWith('notifications/')) return null;
  if (request.method === 'initialize') {
    codexClient = request.params?.clientInfo?.name === 'codex-mcp-client';
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
    return { jsonrpc: '2.0', id: request.id, result: { tools: TOOL_DEFINITIONS.map(tool => codexClient && tool.name === 'cockpit_set_tasks'
      ? { ...tool, description: SET_TASKS_DESCRIPTION } : tool) } };
  }
  if (request.method === 'tools/call') {
    const name = request.params?.name;
    const meta = request.params?._meta;
    if ((codexClient && !isHookSessionId(meta?.sessionId)) ||
      (!codexClient && meta && Object.hasOwn(meta, 'threadId'))) {
      return { jsonrpc: '2.0', id: request.id, result: toolResult('Codex の接続情報または sessionId が無いため記録できなかった。', true) };
    }
    const callOptions = codexClient ? { ...options, codexSessionId: meta.sessionId } : options;
    const result = await callTool(name, request.params?.arguments || {}, callOptions);
    return { jsonrpc: '2.0', id: request.id, result };
  }
  return { jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } };
}

function startMcpServer(options = {}) {
  // 診断に載せるコミットは起動時に読む。最初の書き込みまでに作業ツリーが更新されても、読み込んだコードのコミットを名乗るため。
  options = { ...options, sourceCommit: Promise.resolve().then(() => (options.readSourceCommit || readSourceCommit)()).catch(() => null) };
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
  MCP_GITHUB_TIMEOUT_MS,
  UNREACHABLE_MESSAGE,
  TIMEOUT_MESSAGE,
  UNKNOWN_OUTCOME_MESSAGE,
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
