const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { cockpitHomeFromOptions } = require('../server/identity');
const { sanitizeQuestions, sanitizeDecisionResolution } = require('../server/events');
const { readRouting } = require('../server/routing');
const {
  firstPullRequestUrl,
  isGhPrCreateCommand,
  isGithubCreatePullRequestTool,
  shouldRefreshPullRequests,
} = require('../server/pull-request-utils');

const SERVER_SCRIPT = path.join(__dirname, '..', 'server', 'server.js');
const SERVER_PORT = Number(process.env.AGENT_COCKPIT_PORT || 47821);
const HOOK_TIMEOUT_MS = 1000;

function pickString(value) {
  return typeof value === 'string' ? value : '';
}

function inputSummary(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return toolName || '';
  let value = '';
  if (toolName === 'Bash') value = pickString(toolInput.command);
  else if (['Read', 'Edit', 'Write'].includes(toolName)) {
    value = pickString(toolInput.file_path || toolInput.path || toolInput.notebook_path);
  }
  if (!value) return toolName || '';
  const trimmedValue = value.trim();
  if (!trimmedValue) return toolName || '';
  const normalizedValue = trimmedValue.replace(/\r?\n\s*/g, ' ');
  return normalizedValue.length > 80 ? `${normalizedValue.slice(0, 79)}…` : normalizedValue;
}

// 依頼文や文字列に書かれた手順を拾わないため、ヒアドキュメントより前のコマンド位置を残す。
function commandPositionText(command) {
  const beforeHeredoc = pickString(command).split('<<')[0].replace(/\\\r?\n/g, ' ');
  const characters = [...beforeHeredoc];
  const separator = /[;|&()\r\n]/;
  // 引用符の中の区切りは消し、二重引用符の中の $( ) はコマンドとして扱う。
  const contexts = ['code'];
  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[index];
    const context = contexts.at(-1);
    if (context === 'single') {
      if (character === "'") contexts.pop();
      else if (separator.test(character)) characters[index] = '_';
      continue;
    }
    if (character === '\\') {
      if (context === 'double' && separator.test(characters[index + 1] || '')) characters[index + 1] = '_';
      index += 1;
      continue;
    }
    if (context === 'double') {
      if (character === '"') contexts.pop();
      else if (character === '$' && characters[index + 1] === '(') {
        contexts.push('substitution');
        index += 1;
      } else if (separator.test(character)) characters[index] = '_';
      continue;
    }
    if (character === '#' && (index === 0 || /\s/.test(characters[index - 1]))) {
      while (index + 1 < characters.length && !/[\r\n]/.test(characters[index + 1])) {
        index += 1;
        characters[index] = '_';
      }
    } else if (character === "'") contexts.push('single');
    else if (character === '"') contexts.push('double');
    else if (context === 'substitution' && character === '(') contexts.push('substitution');
    else if (context === 'substitution' && character === ')') contexts.pop();
  }
  return characters.join('');
}

function extractCodexWaitRunId(command) {
  const match = commandPositionText(command).match(/(?:^|&&|\|\||[;|(])[ \t]*(?:(?:bash|sh)[ \t]+)?(?:["']?[^\s"';&|<>]*[\\/])?codex-agent(?:\.sh|\.cmd|\.ps1)?["']?[ \t]+--wait[ \t]+["']?([^\s"'`;&|)]+)/im);
  return match ? match[1].slice(0, 256) : '';
}

// コマンドの区切りまでの引数を返す。`2>&1` や `> "out file"` のリダイレクトは出力先ごと除く。
function shellArguments(value) {
  const tokens = [];
  let token = { text: '', quoted: false, started: false };
  let quote = '';
  const pushToken = () => {
    if (token.started) tokens.push(token);
    token = { text: '', quoted: false, started: false };
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "'") {
      if (character === "'") quote = '';
      else token.text += character;
    } else if (character === '\\') {
      token.text += value[index + 1] || '';
      index += 1;
      token.started = true;
    } else if (quote === '"') {
      if (character === '"') quote = '';
      else token.text += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      token.quoted = true;
      token.started = true;
    } else if (/[\r\n]/.test(character)) break;
    else if (/\s/.test(character)) pushToken();
    else if (character === '&' && (token.text.endsWith('>') || value[index + 1] === '>')) {
      token.text += character;
      token.started = true;
    } else if (/[;&|()\r\n]/.test(character)) break;
    else {
      token.text += character;
      token.started = true;
    }
  }
  pushToken();

  const argumentsList = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const { text, quoted } = tokens[index];
    if (!quoted && /^(?:\d*>&\d*-?|\d*[<>]>?|&>>?)$/.test(text)) {
      if (!/&\d*-?$/.test(text) || /^&>/.test(text)) index += 1;
      continue;
    }
    if (!quoted && /^(?:\d*[<>]>?|&>>?)./.test(text)) continue;
    argumentsList.push(text);
  }
  return argumentsList;
}

function extractCodexReviewDefinition(command) {
  const commandText = commandPositionText(command);
  const pattern = /(?:^|&&|\|\||[;&|(\r\n])[ \t]*(npm[ \t]+run[ \t]+review:codex:fix|npm[ \t]+run[ \t]+review:codex|node[ \t]+(?:\.[\\/])?tools[\\/]cross-review\.js[ \t]+codex)(?=$|[\s;&|)])/gim;
  for (const match of commandText.matchAll(pattern)) {
    const commandStart = match.index + match[0].lastIndexOf(match[1]);
    const argumentsList = shellArguments(commandText.slice(commandStart + match[1].length));
    // ヘルプを出すだけの起動と、Codex のラッパーを通らない起動は、Codex を動かさない。
    if (['--no-codex-agent', '--help', '-h'].some((option) => argumentsList.includes(option))) continue;

    const fix = /review:codex:fix$/i.test(match[1]) || argumentsList.includes('--fix');
    return fix ? 'codex-subagent' : 'codex-review';
  }
  return '';
}

function collectAnswerValues(value, output, depth = 0, allowObjectValues = false) {
  if (depth > 6 || output.length >= 6) return;
  if (typeof value === 'string') {
    const answer = value.trim().slice(0, 2000);
    if (answer) output.push(answer);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectAnswerValues(item, output, depth + 1, false);
    return;
  }
  if (!value || typeof value !== 'object') return;

  const answerKeys = ['answer', 'choice', 'chosen', 'selected', 'selectedOption', 'selected_option'];
  let foundAnswer = false;
  for (const key of answerKeys) {
    if (Object.hasOwn(value, key)) {
      foundAnswer = true;
      collectAnswerValues(value[key], output, depth + 1, false);
    }
  }
  if (foundAnswer) return;

  for (const key of ['answers', 'responses', 'questions']) {
    if (Object.hasOwn(value, key)) {
      collectAnswerValues(value[key], output, depth + 1, true);
      return;
    }
  }
  if (allowObjectValues) {
    for (const item of Object.values(value)) collectAnswerValues(item, output, depth + 1, false);
  }
}

function extractAskUserQuestionResolution(toolResponse) {
  const chosen = [];
  if (typeof toolResponse !== 'string') collectAnswerValues(toolResponse, chosen);
  const resolution = sanitizeDecisionResolution({
    chosen,
    note: toolResponse && typeof toolResponse === 'object' && !Array.isArray(toolResponse)
      ? toolResponse.note
      : '',
  });
  return resolution || { chosen: [], note: '' };
}

const BACKGROUND_TASK_ID = /^[A-Za-z0-9_-]{1,64}$/;

// 背景タスクの出力ファイルは <ID>.output という名前で書かれる。公開仕様ではないので、形に合わなければ何も返さない。
function backgroundOutputTaskIdOf(toolName, toolInput) {
  if (!toolInput || typeof toolInput !== 'object') return '';
  if (toolName === 'Read') {
    const match = pickString(toolInput.file_path).match(/(?:^|[\\/])([A-Za-z0-9_-]{1,64})\.output$/);
    return match ? match[1] : '';
  }
  if (toolName === 'Bash') {
    const ids = new Set();
    for (const match of pickString(toolInput.command).matchAll(/[\\/]([A-Za-z0-9_-]{1,64})\.output(?![A-Za-z0-9_.-])/g)) ids.add(match[1]);
    return ids.size === 1 ? [...ids][0] : '';
  }
  if (toolName === 'TaskOutput' || toolName === 'BashOutput') {
    const id = pickString(toolInput.task_id) || pickString(toolInput.bash_id);
    return BACKGROUND_TASK_ID.test(id) ? id : '';
  }
  return '';
}

function codexOutputLines(value) {
  const lines = {};
  const visit = (item, depth = 0) => {
    if (depth > 6) return;
    if (typeof item === 'string') {
      for (const line of item.match(/^[\t ]*codex-agent:[\t ]*(?:agent=|result=|run=|(?:waiting|vanished|orphaned|unverified|not-found)[\t ]+run=)[^\r\n]*/gm) || []) {
        const normalized = line.trimStart();
        if (!lines.auditLine && normalized.startsWith('codex-agent: agent=')) lines.auditLine = normalized.slice(0, 1024);
        else if (!lines.resultLine && normalized.startsWith('codex-agent: result=')) lines.resultLine = normalized.slice(0, 1024);
        else if (!lines.runLine && normalized.startsWith('codex-agent: run=')) lines.runLine = normalized.slice(0, 1024);
        // codex-agent.sh は --wait の状態を最後の行で示すので、後の行で上書きする。
        else if (!normalized.startsWith('codex-agent: agent=') && !normalized.startsWith('codex-agent: result=') && !normalized.startsWith('codex-agent: run=')) {
          lines.waitStatusLine = normalized.slice(0, 1024);
        }
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const key of ['stdout', 'output', 'text', 'content', 'file']) visit(item[key], depth + 1);
  };
  visit(value);
  return Object.keys(lines).length ? lines : null;
}

function makeHookEvent(input, now = Date.now()) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const eventName = pickString(input.hook_event_name);
  if (!eventName) return null;

  const event = {
    session_id: pickString(input.session_id),
    hook_event_name: eventName,
    cwd: pickString(input.cwd),
    hookAt: now,
    input_fields: Object.keys(input).slice(0, 64),
  };
  if (eventName === 'SessionStart') event.source = pickString(input.source).slice(0, 100);
  for (const key of ['agent_id', 'agent_type']) {
    if (typeof input[key] === 'string') event[key] = input[key];
  }

  if (eventName === 'PreToolUse') {
    event.tool_name = pickString(input.tool_name);
    event.tool_use_id = pickString(input.tool_use_id);
    event.summary = inputSummary(event.tool_name, input.tool_input);
    if (event.tool_name === 'Bash') {
      const command = pickString(input.tool_input?.command);
      const codexWaitRunId = extractCodexWaitRunId(command);
      if (codexWaitRunId) event.codexWaitRunId = codexWaitRunId;
      const codexReviewDefinition = extractCodexReviewDefinition(command);
      if (codexReviewDefinition) event.codexReviewDefinition = codexReviewDefinition;
      if (isGhPrCreateCommand(command)) event.ghPrCreateCommand = true;
      if (shouldRefreshPullRequests(command)) event.refreshPullRequestsCommand = true;
    }
    if (event.tool_name === 'Agent') event.description = pickString(input.tool_input?.description).slice(0, 200);
    if (event.tool_name === 'AskUserQuestion' && !input.agent_id) {
      event.questions = sanitizeQuestions(input.tool_input?.questions);
    }
  } else if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
    event.tool_name = pickString(input.tool_name);
    event.tool_use_id = pickString(input.tool_use_id);
    if (event.tool_name === 'Bash') {
      const command = pickString(input.tool_input?.command);
      if (isGhPrCreateCommand(command)) event.ghPrCreateCommand = true;
      if (shouldRefreshPullRequests(command)) event.refreshPullRequests = true;
      const pullRequest = eventName === 'PostToolUse' ? firstPullRequestUrl(input.tool_response) : null;
      if (pullRequest) event.pullRequest = pullRequest;
    } else if (eventName === 'PostToolUse' && isGithubCreatePullRequestTool(event.tool_name)) {
      const pullRequest = firstPullRequestUrl(input.tool_response);
      if (pullRequest) event.pullRequest = pullRequest;
    }
    if (eventName === 'PostToolUse' && event.tool_name === 'AskUserQuestion' && !input.agent_id) {
      event.decisionResolution = extractAskUserQuestionResolution(input.tool_response);
    }
    if (eventName === 'PostToolUse' && event.tool_name === 'Agent') {
      const response = input.tool_response;
      if (response && typeof response === 'object' && typeof response.resolvedModel === 'string') {
        event.resolvedModel = response.resolvedModel.slice(0, 160);
      }
    }
    const backgroundTaskId = event.tool_name === 'Bash' ? input.tool_response?.backgroundTaskId : null;
    if (typeof backgroundTaskId === 'string' && BACKGROUND_TASK_ID.test(backgroundTaskId)) event.backgroundTaskId = backgroundTaskId;
    const backgroundOutputTaskId = backgroundOutputTaskIdOf(event.tool_name, input.tool_input);
    if (backgroundOutputTaskId) event.backgroundOutputTaskId = backgroundOutputTaskId;
    // 終了コードが 0 以外の Bash は PostToolUseFailure の error に出力が載ることがある。
    const codexOutput = { ...codexOutputLines(input.error), ...codexOutputLines(input.tool_response) };
    if (Object.keys(codexOutput).length) event.codexOutput = codexOutput;
  } else if (eventName === 'Notification') {
    event.notification_type = pickString(input.notification_type).slice(0, 100);
    event.message = pickString(input.message).slice(0, 200);
  } else if (eventName === 'SubagentStart' || eventName === 'SubagentStop') {
    if (typeof input.agent_type === 'string') event.agent_type = input.agent_type;
  }
  return event;
}

function serverInfoPath(homeDir) {
  return path.join(homeDir, 'server.json');
}

async function readServerInfo(homeDir, fileSystem = fsp) {
  try {
    const value = JSON.parse(await fileSystem.readFile(serverInfoPath(homeDir), 'utf8'));
    if (
      !value || !Number.isInteger(value.port) || typeof value.secret !== 'string' ||
      !Number.isInteger(value.pid) || typeof value.startedAt !== 'string'
    ) return null;
    return value;
  } catch {
    return null;
  }
}

function childEnvironment(environment) {
  const excluded = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']);
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('CLAUDE_CODE_') && !excluded.has(key)));
}

async function launchServer({ homeDir, environment = process.env, spawnProcess = spawn }) {
  await fsp.mkdir(homeDir, { recursive: true });
  const logPath = path.join(homeDir, 'server.log');
  const logFd = fs.openSync(logPath, 'w');
  try {
    const child = spawnProcess(process.execPath, [SERVER_SCRIPT, '--port', String(SERVER_PORT)], {
      cwd: homeDir,
      detached: true,
      windowsHide: true,
      stdio: ['ignore', logFd, logFd],
      env: childEnvironment(environment),
    });
    await new Promise((resolve, reject) => {
      child.once('spawn', resolve);
      child.once('error', reject);
    });
    child.unref();
  } finally {
    fs.closeSync(logFd);
  }
}

async function acquireStartLock(homeDir, now = Date.now()) {
  const lockPath = path.join(homeDir, 'start.lock');
  await fsp.mkdir(homeDir, { recursive: true });
  const token = `${process.pid}-${now}-${Math.random().toString(36).slice(2)}`;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const handle = await fsp.open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, token, createdAt: now }));
      await handle.close();
      return token;
    } catch (error) {
      if (error.code !== 'EEXIST') return null;
      try {
        const stat = await fsp.stat(lockPath);
        if (now - stat.mtimeMs <= 10_000) return null;
        await fsp.rm(lockPath);
      } catch {
        return null;
      }
    }
  }
  return null;
}

async function releaseStartLock(homeDir, token) {
  if (!token) return;
  const lockPath = path.join(homeDir, 'start.lock');
  try {
    const lock = JSON.parse(await fsp.readFile(lockPath, 'utf8'));
    if (lock.token === token) await fsp.rm(lockPath, { force: true });
  } catch {
    return;
  }
}

async function fetchWithTimeout(fetchImpl, url, options, deadline, maximumTimeout = 300) {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error('hook deadline elapsed');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Math.min(maximumTimeout, remaining));
  try {
    return await fetchImpl(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function serverIsHealthy(info, { fetchImpl = fetch, deadline = Date.now() + 250 } = {}) {
  if (!info) return false;
  try {
    const response = await fetchWithTimeout(
      fetchImpl,
      `http://127.0.0.1:${info.port}/health`,
      { method: 'GET' },
      deadline,
      120,
    );
    if (!response.ok) return false;
    const health = await response.json();
    return health.app === 'agent-cockpit' && health.pid === info.pid && health.startedAt === info.startedAt;
  } catch {
    return false;
  }
}

async function waitForHealthyServer(homeDir, { fetchImpl = fetch, deadline, intervalMs = 35 } = {}) {
  while (Date.now() < deadline) {
    const info = await readServerInfo(homeDir);
    if (await serverIsHealthy(info, { fetchImpl, deadline: Math.min(deadline, Date.now() + 150) })) return info;
    await new Promise((resolve) => setTimeout(resolve, Math.min(intervalMs, Math.max(0, deadline - Date.now()))));
  }
  return null;
}

async function ensureServerRunning({
  homeDir,
  fetchImpl = fetch,
  startServer = (args) => launchServer(args),
  environment = process.env,
  deadline = Date.now() + HOOK_TIMEOUT_MS,
} = {}) {
  let info = await readServerInfo(homeDir);
  if (await serverIsHealthy(info, { fetchImpl, deadline })) return info;

  const token = await acquireStartLock(homeDir);
  if (!token) return waitForHealthyServer(homeDir, { fetchImpl, deadline });

  try {
    info = await readServerInfo(homeDir);
    if (await serverIsHealthy(info, { fetchImpl, deadline })) return info;
    await startServer({ homeDir, environment });
    return await waitForHealthyServer(homeDir, { fetchImpl, deadline });
  } catch {
    return null;
  } finally {
    await releaseStartLock(homeDir, token);
  }
}

async function postEvent(event, options = {}) {
  const homeDir = options.homeDir || cockpitHomeFromOptions(options);
  const fetchImpl = options.fetchImpl || fetch;
  const startServer = options.startServer || ((args) => launchServer(args));
  const deadline = options.deadline || Date.now() + HOOK_TIMEOUT_MS;
  let info = await ensureServerRunning({
    homeDir,
    fetchImpl,
    startServer,
    environment: options.environment || process.env,
    deadline,
  });

  for (let attempt = 0; attempt < 2 && Date.now() < deadline; attempt += 1) {
    if (!info) return false;
    try {
      const response = await fetchWithTimeout(
        fetchImpl,
        `http://127.0.0.1:${info.port}/api/events`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-cockpit-secret': info.secret,
          },
          body: JSON.stringify(event),
        },
        deadline,
        500,
      );
      if (response.ok) return true;
      if (response.status !== 401 || attempt > 0) return false;
      const replacement = await readServerInfo(homeDir);
      info = replacement || info;
    } catch {
      if (attempt > 0) return false;
      info = await ensureServerRunning({
        homeDir,
        fetchImpl,
        startServer,
        environment: options.environment || process.env,
        deadline,
      });
    }
  }
  return false;
}

async function runHook(input, options = {}) {
  const event = makeHookEvent(input, options.now === undefined ? Date.now() : options.now);
  if (!event) return { exitCode: 0, additionalContext: null };
  const homeDir = options.homeDir || cockpitHomeFromOptions(options);
  if (event.hook_event_name === 'SubagentStart') event.route = (await readRouting(homeDir)).agents;
  let dashboardUrl = null;

  if (event.hook_event_name === 'SessionStart') {
    const deadline = Date.now() + HOOK_TIMEOUT_MS;
    const info = await ensureServerRunning({
      homeDir,
      fetchImpl: options.fetchImpl || fetch,
      startServer: options.startServer || ((args) => launchServer(args)),
      environment: options.environment || process.env,
      deadline,
    });
    if (info) dashboardUrl = `http://127.0.0.1:${info.port}/`;
    await postEvent(event, {
      ...options,
      homeDir,
      deadline,
    });
  } else {
    await postEvent(event, { ...options, homeDir });
  }

  return {
    exitCode: 0,
    additionalContext: dashboardUrl ? `Agent Cockpit: ${dashboardUrl}` : null,
  };
}

async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    const result = await runHook(input);
    if (result.additionalContext) {
      process.stdout.write(`${JSON.stringify({
        hookSpecificOutput: {
          hookEventName: 'SessionStart',
          additionalContext: result.additionalContext,
        },
      })}\n`);
    }
  } catch {
    process.exitCode = 0;
  }
}

if (require.main === module) main();

module.exports = {
  HOOK_TIMEOUT_MS,
  inputSummary,
  extractCodexWaitRunId,
  codexOutputLines,
  backgroundOutputTaskIdOf,
  extractAskUserQuestionResolution,
  makeHookEvent,
  readServerInfo,
  childEnvironment,
  acquireStartLock,
  releaseStartLock,
  serverIsHealthy,
  ensureServerRunning,
  postEvent,
  runHook,
};
