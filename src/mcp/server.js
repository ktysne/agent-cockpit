const readline = require('node:readline');
const { cockpitHomeFromOptions } = require('../server/identity');
const { ensureServerRunning, readServerInfo } = require('../hooks/event');

const SERVER_NAME = 'agent-cockpit';
const SERVER_VERSION = '0.0.0';
const PROTOCOL_VERSION = '2025-06-18';
const MCP_TIMEOUT_MS = 5000;
const UNREACHABLE_MESSAGE = 'ダッシュボードに書けなかった。作業は続けてよい';
const MAX_RESULT_ITEMS = 10;
const PLAN_ERROR_MESSAGES = new Map([
  [400, '入力が正しくないか、上限を超えています'],
  [404, '判断事項が見つからないか、解決済みです'],
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

async function fetchWithDeadline(fetchImpl, url, init, deadline) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('deadline elapsed');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(2000, remaining));
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function postPlan(toolName, args, options = {}) {
  const homeDir = options.homeDir || cockpitHomeFromOptions(options);
  const environment = options.environment || process.env;
  const fetchImpl = options.fetchImpl || fetch;
  const ensure = options.ensureServerRunning || ensureServerRunning;
  const readInfo = options.readServerInfo || readServerInfo;
  const deadline = options.deadline || Date.now() + MCP_TIMEOUT_MS;
  const sessionId = typeof environment.CLAUDE_CODE_SESSION_ID === 'string'
    ? environment.CLAUDE_CODE_SESSION_ID
    : '';
  const routeSessionId = /^[A-Za-z0-9-]{1,128}$/.test(sessionId) ? sessionId : 'pending';
  const ppid = options.ppid === undefined ? process.ppid : options.ppid;
  const infoOptions = {
    homeDir,
    fetchImpl,
    environment,
    deadline,
    startServer: options.startServer,
  };
  let info;
  try {
    info = await ensure(infoOptions);
  } catch {
    return null;
  }

  const body = {
    ...planArguments(toolName, args),
    ppid,
    claudeCodeSessionId: sessionId || null,
  };
  for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt += 1) {
    if (!info) return null;
    try {
      const response = await fetchWithDeadline(
        fetchImpl,
        `http://127.0.0.1:${info.port}/api/sessions/${encodeURIComponent(routeSessionId)}/plan`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-cockpit-secret': info.secret,
          },
          body: JSON.stringify(body),
        },
        deadline,
      );
      if (response.ok) return await response.json();
      if (response.status === 401 && attempt === 0) {
        info = await readInfo(homeDir);
        continue;
      }
      const errorMessage = PLAN_ERROR_MESSAGES.get(response.status);
      if (errorMessage) return { errorMessage };
      return null;
    } catch {
      if (attempt > 0) return null;
      try {
        info = await ensure(infoOptions);
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function callTool(name, args, options = {}) {
  const tool = TOOL_DEFINITIONS.find((item) => item.name === name);
  if (!tool) return toolResult('指定されたツールはありません。', true);
  if (!args || typeof args !== 'object' || Array.isArray(args)) return toolResult('入力が正しくありません。', true);
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
    const result = await callTool(name, request.params?.arguments || {}, options);
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
  TOOL_DEFINITIONS,
  shortSavedList,
  planArguments,
  postPlan,
  callTool,
  handleRequest,
  startMcpServer,
};
