const crypto = require('node:crypto');
const { cockpitHomeFromOptions } = require('../server/identity');
const { MAX_LONG_POLL_MS, denyAnswerOutput } = require('../server/decision-answers');
const { postToServer } = require('../client/server-connection');
const { isHookSessionId } = require('../server/session-ids');

const ANSWER_HOOK_TIMEOUT_MS = 30 * 60_000 + 30_000;
const ANSWER_HOOK_DEADLINE_GRACE_MS = 30_000;
const POST_TOOL_BATCH_TIMEOUT_MS = 1_000;
const ASK_OUTCOMES = new Set(['answered', 'timeout', 'released', 'server-lost']);

function validSessionId(value) {
  return isHookSessionId(value);
}

function isParentAlive(pid, processApi = process) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try {
    processApi.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function useOriginalToolInput(output, toolInput) {
  const hookSpecificOutput = output?.hookSpecificOutput;
  const answers = hookSpecificOutput?.updatedInput?.answers;
  if (!answers || !toolInput || typeof toolInput !== 'object' || Array.isArray(toolInput)) return output;
  return {
    ...output,
    hookSpecificOutput: {
      ...hookSpecificOutput,
      updatedInput: { ...toolInput, answers },
    },
  };
}

async function postHookRequest(body, options = {}) {
  const homeDir = options.homeDir || cockpitHomeFromOptions(options);
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const deadline = now() + (options.timeoutMs || 1_000);
  const ppid = options.ppid === undefined ? process.ppid : options.ppid;
  const result = await postToServer('/api/hooks/answers', { ...body, claudeLineage: { ppid } }, {
    homeDir,
    fetchImpl,
    cache: 'no-store',
    deadline,
    attemptTimeoutMs: options.attemptTimeoutMs,
    fileSystem: options.fileSystem,
    readServerInfo: options.readServerInfo,
    ensure: false,
    now,
  });
  return result.ok ? result.json : null;
}

async function runAskQuestion(input, options) {
  const sessionId = input.session_id;
  const toolUseId = input.tool_use_id;
  if (!validSessionId(sessionId) || typeof toolUseId !== 'string' || !toolUseId) return null;
  const hookStartedAt = (options.now || Date.now)();
  const register = await postHookRequest({
    action: 'ask-register',
    event_name: 'PreToolUse',
    session_id: sessionId,
    id: toolUseId,
    questions: input.tool_input?.questions || [],
    ...(typeof input.agent_id === 'string' ? { agent_id: input.agent_id } : {}),
  }, { ...options, timeoutMs: 1_000 });
  if (!register) return null;
  if (!register.awaiting) return register.hookOutput || null;
  const fallbackOutput = register.fallbackOutput || denyAnswerOutput(register.decisionId);
  const serverDeadline = Number.isFinite(register.deadline)
    ? register.deadline
    : Date.parse(register.awaitingAnswerUntil || '');
  const hookDeadline = Number.isFinite(serverDeadline)
    ? Math.min(serverDeadline + ANSWER_HOOK_DEADLINE_GRACE_MS, hookStartedAt + ANSWER_HOOK_TIMEOUT_MS)
    : hookStartedAt + (options.askHookWaitMs || ANSWER_HOOK_TIMEOUT_MS);
  while ((options.now || Date.now)() < hookDeadline) {
    const result = await postHookRequest({
      action: 'ask-poll', event_name: 'PreToolUse', session_id: sessionId, id: toolUseId, decision_id: register.decisionId,
    }, { ...options, timeoutMs: MAX_LONG_POLL_MS + 1_500 });
    if (!result) {
      const lost = await postHookRequest({
        action: 'ask-finish', event_name: 'PreToolUse', session_id: sessionId, id: toolUseId, outcome: 'server-lost',
        decision_id: register.decisionId,
      }, { ...options, timeoutMs: 1_000 });
      const hookOutput = lost ? lost.hookOutput ?? null : fallbackOutput;
      return useOriginalToolInput(hookOutput, input.tool_input);
    }
    if (result.outcome === 'waiting') continue;
    const outcome = ASK_OUTCOMES.has(result.outcome) ? result.outcome : 'server-lost';
    const finished = await postHookRequest({
      action: 'ask-finish', event_name: 'PreToolUse', session_id: sessionId, id: toolUseId, decision_id: register.decisionId, outcome,
    }, { ...options, timeoutMs: 1_000 });
    const hookOutput = finished
      ? finished.hookOutput ?? null
      : outcome === 'server-lost' ? fallbackOutput : null;
    return useOriginalToolInput(hookOutput, input.tool_input);
  }
  const timeout = await postHookRequest({
    action: 'ask-finish', event_name: 'PreToolUse', session_id: sessionId, id: toolUseId, decision_id: register.decisionId, outcome: 'timeout',
  }, { ...options, timeoutMs: 1_000 });
  return timeout?.hookOutput || fallbackOutput;
}

async function runPostToolBatch(input, options) {
  if (!validSessionId(input.session_id)) return null;
  // サブエージェントの区切りは、拒否されて PostToolUse の来ないツールを片付けるために送る。回答はメインにだけ渡す。
  if (input.agent_id) {
    if (typeof input.agent_id !== 'string' || input.agent_id.length > 256) return null;
    await postHookRequest({
      action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: input.session_id, id: crypto.randomUUID(), agent_id: input.agent_id,
    }, { ...options, timeoutMs: POST_TOOL_BATCH_TIMEOUT_MS, attemptTimeoutMs: 750 });
    return null;
  }
  const result = await postHookRequest({
    action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: input.session_id, id: crypto.randomUUID(),
  }, { ...options, timeoutMs: POST_TOOL_BATCH_TIMEOUT_MS, attemptTimeoutMs: 750 });
  return result?.hookOutput || null;
}

async function runUserPromptSubmit(input, options) {
  if (input.agent_id || !validSessionId(input.session_id)) return null;
  const result = await postHookRequest({
    action: 'user-prompt-submit', event_name: 'UserPromptSubmit', session_id: input.session_id,
    id: crypto.randomUUID(), hook_at: (options.now || Date.now)(),
  }, { ...options, timeoutMs: 1_000 });
  return result?.hookOutput || null;
}

async function runStop(input, options) {
  if (input.agent_id || !validSessionId(input.session_id)) return { exitCode: 0, stderrText: null };
  const sessionId = input.session_id;
  const eventId = crypto.randomUUID();
  const hookAt = (options.now || Date.now)();
  const started = await postHookRequest({
    action: 'stop-start', event_name: 'Stop', session_id: sessionId, id: eventId, hook_at: hookAt,
  }, { ...options, timeoutMs: 1_000 });
  if (!Number.isInteger(started?.generation)) return { exitCode: 0, stderrText: null };
  const parentPid = options.parentPid === undefined ? process.ppid : options.parentPid;
  while (true) {
    const parentAlive = options.isParentAlive
      ? options.isParentAlive(parentPid)
      : isParentAlive(parentPid, options.processApi || process);
    if (!parentAlive) return { exitCode: 0, stderrText: null };
    const result = await postHookRequest({
      action: 'stop-poll', event_name: 'Stop', session_id: sessionId, id: eventId,
      generation: started.generation, parent_alive: parentAlive,
    }, { ...options, timeoutMs: MAX_LONG_POLL_MS + 1_500 });
    if (!result) return { exitCode: 0, stderrText: null };
    if (result.done === true) {
      if (typeof result.stderrText === 'string' && result.stderrText) return { exitCode: 2, stderrText: result.stderrText };
      return { exitCode: 0, stderrText: null };
    }
    if (options.once) return { exitCode: 0, stderrText: null };
  }
}

async function runAnswerHook(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { exitCode: 0, output: null, stderrText: null };
  let output = null;
  if (input.hook_event_name === 'PreToolUse' && input.tool_name === 'AskUserQuestion') output = await runAskQuestion(input, options);
  else if (input.hook_event_name === 'PostToolBatch') output = await runPostToolBatch(input, options);
  else if (input.hook_event_name === 'UserPromptSubmit') output = await runUserPromptSubmit(input, options);
  else if (input.hook_event_name === 'Stop') return runStop(input, options);
  return { exitCode: 0, output, stderrText: null };
}

async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    const result = await runAnswerHook(input);
    if (result.output) process.stdout.write(`${JSON.stringify(result.output)}\n`);
    if (result.stderrText) process.stderr.write(result.stderrText);
    process.exitCode = result.exitCode;
  } catch {
    process.exitCode = 0;
  }
}

if (require.main === module) main();

module.exports = {
  ANSWER_HOOK_TIMEOUT_MS,
  POST_TOOL_BATCH_TIMEOUT_MS,
  isParentAlive,
  postHookRequest,
  useOriginalToolInput,
  runAskQuestion,
  runPostToolBatch,
  runUserPromptSubmit,
  runStop,
  runAnswerHook,
};
