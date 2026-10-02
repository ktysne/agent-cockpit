const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { cockpitHomeFromOptions } = require('../server/identity');
const { sanitizeQuestions, sanitizeDecisionResolution } = require('../server/events');

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
  return value.trim().split(/\r?\n/, 1)[0].slice(0, 80);
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

function codexOutputLines(value) {
  const lines = {};
  const visit = (item, depth = 0) => {
    if (depth > 6 || (lines.auditLine && lines.resultLine)) return;
    if (typeof item === 'string') {
      for (const line of item.match(/^[\t ]*codex-agent:[\t ]*(?:agent=|result=)[^\r\n]*/gm) || []) {
        const normalized = line.trimStart();
        if (!lines.auditLine && normalized.startsWith('codex-agent: agent=')) lines.auditLine = normalized.slice(0, 1024);
        if (!lines.resultLine && normalized.startsWith('codex-agent: result=')) lines.resultLine = normalized.slice(0, 1024);
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const key of ['stdout', 'output', 'text', 'content']) visit(item[key], depth + 1);
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
  for (const key of ['agent_id', 'agent_type']) {
    if (typeof input[key] === 'string') event[key] = input[key];
  }

  if (eventName === 'PreToolUse') {
    event.tool_name = pickString(input.tool_name);
    event.tool_use_id = pickString(input.tool_use_id);
    event.summary = inputSummary(event.tool_name, input.tool_input);
    if (event.tool_name === 'Agent') event.description = pickString(input.tool_input?.description).slice(0, 200);
    if (event.tool_name === 'AskUserQuestion' && !input.agent_id) {
      event.questions = sanitizeQuestions(input.tool_input?.questions);
    }
  } else if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
    event.tool_name = pickString(input.tool_name);
    event.tool_use_id = pickString(input.tool_use_id);
    if (eventName === 'PostToolUse' && event.tool_name === 'AskUserQuestion' && !input.agent_id) {
      event.decisionResolution = extractAskUserQuestionResolution(input.tool_response);
    }
    if (eventName === 'PostToolUse' && event.tool_name === 'Agent') {
      const response = input.tool_response;
      if (response && typeof response === 'object' && typeof response.resolvedModel === 'string') {
        event.resolvedModel = response.resolvedModel.slice(0, 160);
      }
    }
    // 終了コードが 0 以外の Bash は PostToolUseFailure の error に出力が載ることがある。
    const codexOutput = codexOutputLines(input.tool_response) || codexOutputLines(input.error);
    if (codexOutput) event.codexOutput = codexOutput;
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
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !key.startsWith('CLAUDE_CODE_')));
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
  codexOutputLines,
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
