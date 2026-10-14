const { cockpitHomeFromOptions } = require('../server/identity');
const { isHookSessionId } = require('../server/session-ids');
const { sanitizeQuestions, sanitizeCodexQuestions, isQuestionTool, sanitizeDecisionResolution } = require('../server/events');
const { readRouting } = require('../server/routing');
const { execFile } = require('node:child_process');
const fs = require('node:fs');
const { codexOutputLines, taskOutputPath, readTaskOutputFile } = require('../shared/task-output');
const path = require('node:path');
const { appendPendingHook } = require('../client/hooks-pending');
const { promisify } = require('node:util');
const {
  HOOK_TIMEOUT_MS,
  acquireStartLock,
  childEnvironment,
  ensureServerRunning,
  launchServer,
  postToServer,
  readServerInfo,
  releaseStartLock,
  serverIsHealthy,
} = require('../client/server-connection');
const {
  firstPullRequestUrl,
  isGhPrCreateCommand,
  isGithubCreatePullRequestTool,
  pullRequestCommandCwd,
  shouldRefreshPullRequests,
} = require('../server/pull-request-utils');

const execFileAsync = promisify(execFile);
// 会話の開始時は Codex 本体とほかのフックが同時に動き、照会に 3 秒を超えることがある。待つのは SessionStart だけで、超えるとプロセス ID を記録できない。
const CODEX_PARENT_TIMEOUT_MS = 8000;

async function findCodexParentPid() {
  const deadline = Date.now() + CODEX_PARENT_TIMEOUT_MS;
  let pid = process.ppid;
  if (process.platform === 'win32') {
    // Get-CimInstance は 1 回の呼び出しに 1 秒以上かかり、段ごとに呼ぶと上限を超えるため、全プロセスを 1 回で取って手元でたどる。
    const script = '$processes = @{}; Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,Name | ' +
      'ForEach-Object { $processes[[int]$_.ProcessId] = $_ }; ' +
      `$ancestorPid = ${pid}; for ($depth = 0; $depth -lt 4 -and $ancestorPid -gt 0; $depth++) { ` +
      '$ancestor = $processes[[int]$ancestorPid]; ' +
      'if (!$ancestor) { break }; if ($ancestor.Name -match "^(?i:codex(?:\\.exe)?)$") { ' +
      '$ancestor.ProcessId; break }; $ancestorPid = $ancestor.ParentProcessId }';
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      timeout: CODEX_PARENT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4096,
    });
    const found = Number(stdout.trim());
    return Number.isInteger(found) && found > 0 ? found : null;
  }
  for (let depth = 0; depth < 4 && pid > 0; depth += 1) {
    const timeout = deadline - Date.now();
    if (timeout <= 0) return null;
    const { stdout } = await execFileAsync('ps', ['-o', 'ppid=,comm=', '-p', String(pid)], { timeout, maxBuffer: 4096 });
    const match = stdout.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) return null;
    if (/^codex(?:\.exe)?$/i.test(match[2].trim())) return pid;
    pid = Number(match[1]);
  }
  return null;
}

async function codexParentPid(findParent, timeoutMs = CODEX_PARENT_TIMEOUT_MS, diagnostic = {}) {
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(findParent),
      new Promise((resolve) => { timer = setTimeout(() => { diagnostic.result = 'timeout'; resolve(null); }, timeoutMs); }),
    ]);
  } catch (error) {
    diagnostic.result = error.killed || error.code === 'ETIMEDOUT' ? 'timeout' : 'failed';
    return null;
  } finally {
    clearTimeout(timer);
  }
}

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
const TASK_END_STATUSES = new Set(['completed', 'failed', 'killed', 'stopped']);

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

function taskNotificationValue(block, tagName) {
  return block.match(new RegExp(`<${tagName}>([\\s\\S]*?)</${tagName}>`))?.[1]?.trim() || '';
}

function makeHookEvent(input, now = Date.now(), options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const eventName = pickString(input.hook_event_name);
  if (!eventName || eventName === 'BackgroundTaskEnd' || (eventName === 'Interrupt' && options.provider !== 'codex')) return null;

  const event = {
    session_id: pickString(input.session_id),
    hook_event_name: eventName,
    cwd: pickString(input.cwd),
    hookAt: now,
    input_fields: Object.keys(input).slice(0, 64),
  };
  const isCodex = options.provider === 'codex';
  if (!isCodex && eventName === 'SessionStart' && typeof input.model === 'string') {
    event.model = pickString(input.model).slice(0, 160);
  }
  if (isCodex) {
    event.provider = 'codex';
    event.model = pickString(input.model).slice(0, 160);
    const parentSessionId = (options.environment || process.env).CLAUDE_CODE_SESSION_ID;
    if (isHookSessionId(parentSessionId)) event.claudeParentSessionId = parentSessionId;
  }
  if (eventName === 'SessionStart') event.source = pickString(input.source).slice(0, 100);
  for (const key of ['agent_id', 'agent_type']) {
    if (typeof input[key] === 'string') event[key] = input[key];
  }

  if (eventName === 'PermissionRequest') {
    event.tool_name = pickString(input.tool_name);
    event.summary = inputSummary(event.tool_name, input.tool_input);
  } else if (!isCodex && eventName === 'UserPromptSubmit' && typeof input.prompt === 'string'
    && input.prompt.trimStart().startsWith('<task-notification>')) {
    // 完了通知だけで始まる入力に限る。開発者が入力に引用した通知で、動いている行を終わらせないため。
    const backgroundTaskEnds = [];
    let inspected = 0;
    for (const match of input.prompt.matchAll(/<task-notification>([\s\S]*?)<\/task-notification>/g)) {
      const block = match[1];
      const taskId = taskNotificationValue(block, 'task-id');
      if (!BACKGROUND_TASK_ID.test(taskId)) continue;
      const status = taskNotificationValue(block, 'status');
      if (!TASK_END_STATUSES.has(status)) continue;
      const end = { taskId, status };
      const outputFile = taskNotificationValue(block, 'output-file');
      if (inspected < 8 && taskOutputPath(taskId, outputFile)) {
        inspected += 1;
        try {
          const output = (options.readTaskOutput || readTaskOutputFile)(outputFile);
          const codexOutput = codexOutputLines(output);
          if (codexOutput) end.codexOutput = codexOutput;
        } catch {}
      }
      backgroundTaskEnds.push(end);
    }
    if (backgroundTaskEnds.length) event.backgroundTaskEnds = backgroundTaskEnds;
  } else if (isCodex && ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'].includes(eventName)) {
    event.tool_name = pickString(input.tool_name);
    event.tool_use_id = pickString(input.tool_use_id);
    if (eventName === 'PreToolUse') {
      event.summary = inputSummary(event.tool_name, input.tool_input);
      if (event.tool_name === 'Bash') {
        const command = pickString(input.tool_input?.command);
        if (isGhPrCreateCommand(command)) event.ghPrCreateCommand = true;
        if (shouldRefreshPullRequests(command)) event.refreshPullRequestsCommand = true;
      }
      if (isQuestionTool('codex', event.tool_name) && !input.agent_id) {
        event.questions = sanitizeCodexQuestions(event.tool_name, input.tool_input?.questions);
      }
    } else if (event.tool_name === 'Bash') {
      const command = pickString(input.tool_input?.command);
      if (isGhPrCreateCommand(command)) event.ghPrCreateCommand = true;
      if (shouldRefreshPullRequests(command)) event.refreshPullRequests = true;
      const pullRequest = eventName === 'PostToolUse' ? firstPullRequestUrl(input.tool_response) : null;
      if (pullRequest) {
        event.pullRequest = pullRequest;
        const commandCwd = pullRequestCommandCwd(command, input.cwd);
        if (commandCwd) event.commandCwd = commandCwd;
      }
    }
  } else if (eventName === 'PreToolUse') {
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
      if (pullRequest) {
        event.pullRequest = pullRequest;
        const commandCwd = pullRequestCommandCwd(command, input.cwd);
        if (commandCwd) event.commandCwd = commandCwd;
      }
    } else if (eventName === 'PostToolUse' && isGithubCreatePullRequestTool(event.tool_name)) {
      const pullRequest = firstPullRequestUrl(input.tool_response);
      if (pullRequest) event.pullRequest = pullRequest;
    }
    if (eventName === 'PostToolUse' && event.tool_name === 'AskUserQuestion' && !input.agent_id) {
      event.decisionResolution = extractAskUserQuestionResolution(input.tool_response);
    }
    if (eventName === 'PostToolUse' && event.tool_name === 'Agent') {
      const response = input.tool_response;
      if (response && typeof response === 'object') {
        if (typeof response.agentId === 'string') event.agentId = response.agentId.slice(0, 256);
        if (typeof response.resolvedModel === 'string') event.resolvedModel = response.resolvedModel.slice(0, 160);
      }
    }
    const backgroundTaskId = event.tool_name === 'Bash' ? input.tool_response?.backgroundTaskId : null;
    if (typeof backgroundTaskId === 'string' && BACKGROUND_TASK_ID.test(backgroundTaskId)) event.backgroundTaskId = backgroundTaskId;
    // TaskStop は非推奨の shell_id でも止める対象を受け付ける。
    const stoppedTaskId = eventName === 'PostToolUse' && event.tool_name === 'TaskStop'
      ? input.tool_input?.task_id || input.tool_input?.shell_id
      : null;
    if (typeof stoppedTaskId === 'string' && BACKGROUND_TASK_ID.test(stoppedTaskId)) event.stoppedTaskId = stoppedTaskId;
    const backgroundOutputTaskId = backgroundOutputTaskIdOf(event.tool_name, input.tool_input);
    if (backgroundOutputTaskId) event.backgroundOutputTaskId = backgroundOutputTaskId;
    // 終了コードが 0 以外の Bash は PostToolUseFailure の error に出力が載ることがある。
    const codexOutput = { ...codexOutputLines(input.error), ...codexOutputLines(input.tool_response) };
    if (Object.keys(codexOutput).length) event.codexOutput = codexOutput;
  } else if (eventName === 'Notification') {
    event.notification_type = pickString(input.notification_type).slice(0, 100);
    event.message = pickString(input.message).slice(0, 200);
  }
  return event;
}

async function postEvent(event, options = {}) {
  const homeDir = options.homeDir || cockpitHomeFromOptions(options);
  event.diagnostics ||= [];
  const startServer = options.startServer || ((args) => launchServer(args));
  const deadline = options.deadline || Date.now() + HOOK_TIMEOUT_MS;
  const result = await postToServer('/api/events', event, {
    homeDir,
    fetchImpl: options.fetchImpl || fetch,
    startServer: async args => {
      await startServer(args);
      const stage = event.diagnostics.find(entry => entry.msg === 'hook.server');
      if (stage) stage.data.started = true;
      else event.diagnostics.push({ msg: 'hook.server', data: { started: true } });
    },
    environment: options.environment || process.env,
    deadline,
    attemptTimeoutMs: 500,
    ensureServerRunning: options.ensureServerRunning,
    readServerInfo: options.readServerInfo,
    ensure: options.ensure ?? true,
    parseJson: false,
    reuseInfoOnUnauthorized: true,
    ...(Object.hasOwn(options, 'initialInfo') ? { initialInfo: options.initialInfo } : {}),
  });
  if (!result.ok && result.status === null) await appendPendingHook(homeDir, { msg: 'hook.delivery', data: {
    failure: result.timedOut || Date.now() >= deadline ? 'timeout' : 'unreachable', at: new Date().toISOString(),
  } });
  return result.ok;
}

async function runHook(input, options = {}) {
  const event = makeHookEvent(input, options.now === undefined ? Date.now() : options.now, options);
  if (!event) return { exitCode: 0, additionalContext: null };
  event.diagnostics = [{ msg: 'hook.input', data: { result: 'parsed' } }, { msg: 'hook.server', data: { started: false } }];
  if (event.provider === 'codex' && event.hook_event_name === 'SessionStart') {
    const startedAt = Date.now();
    const diagnostic = {};
    const pid = await codexParentPid(options.findCodexParentPid || findCodexParentPid, options.codexParentTimeoutMs, diagnostic);
    event.diagnostics.push({ msg: 'hook.pid', data: { result: diagnostic.result || (pid ? 'found' : 'missing'), durationMs: Date.now() - startedAt } });
    if (Number.isInteger(pid) && pid > 0) event.codexPid = pid;
  }
  const homeDir = options.homeDir || cockpitHomeFromOptions(options);
  if (event.provider !== 'codex' && event.hook_event_name === 'SubagentStart') event.route = (await readRouting(homeDir)).agents;
  let dashboardUrl = null;

  if (event.hook_event_name === 'SessionStart') {
    const deadline = Date.now() + HOOK_TIMEOUT_MS;
    const info = await ensureServerRunning({
      homeDir,
      fetchImpl: options.fetchImpl || fetch,
      startServer: async args => {
        await (options.startServer || launchServer)(args);
        event.diagnostics.find(entry => entry.msg === 'hook.server').data.started = true;
      },
      environment: options.environment || process.env,
      deadline,
    });
    if (info) dashboardUrl = `http://127.0.0.1:${info.port}/`;
    await postEvent(event, {
      ...options,
      homeDir,
      deadline,
      initialInfo: info,
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

async function runHookText(text, options = {}) {
  let input;
  try { input = JSON.parse(text); }
  catch {
    await postEvent({ diagnostics: [{ msg: 'hook.input', data: { result: 'invalid' } }] }, { ...options, ensure: false });
    return { exitCode: 0, additionalContext: null };
  }
  return runHook(input, options);
}

async function main() {
  try {
    const result = await runHookText(await readStdin(), { provider: process.argv[2] === 'codex' ? 'codex' : 'claude' });
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
  launchServer,
  childEnvironment,
  acquireStartLock,
  releaseStartLock,
  serverIsHealthy,
  ensureServerRunning,
  postEvent,
  runHook,
  runHookText,
};
