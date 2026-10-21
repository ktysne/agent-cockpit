const crypto = require('node:crypto');
const { cockpitHomeFromOptions } = require('../server/identity');
const { MAX_LONG_POLL_MS, REVIEW_REMINDER_WAIT_MS, denyAnswerOutput } = require('../server/decision-answers');
const { postToServer } = require('../client/server-connection');
const { isHookSessionId } = require('../server/session-ids');

const ANSWER_HOOK_TIMEOUT_MS = 30 * 60_000 + 30_000;
const ANSWER_HOOK_DEADLINE_GRACE_MS = 30_000;
const CODEX_STOP_WAIT_MS = 59 * 60_000;
const POST_TOOL_BATCH_TIMEOUT_MS = 1_000;
const DELIVERY_ACK_TIMEOUT_MS = 300;
// stop-check はレビュー記録の催促の判定を待ってから応答するため。
const STOP_CHECK_TIMEOUT_MS = REVIEW_REMINDER_WAIT_MS + 2_000;
// 最初の stop-poll は催促の判定を待ってから long-poll に入る。先に打ち切ると、その後の回答が届かないまま配信済みになる。
const CLAUDE_STOP_POLL_TIMEOUT_MS = REVIEW_REMINDER_WAIT_MS + MAX_LONG_POLL_MS + 1_500;
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
  const hasExternalDeadline = Number.isFinite(options.deadline);
  const deadline = hasExternalDeadline ? options.deadline : now() + (options.timeoutMs || 1_000);
  const result = await postToServer('/api/hooks/answers', body, {
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
  if (!result.ok) return null;
  const response = result.json;
  if (typeof response?.deliveryId === 'string') {
    const sendAcknowledgement = async () => {
      try {
        const acknowledgementDeadline = hasExternalDeadline
          ? deadline
          : Array.isArray(options.deferredAcknowledgements)
            ? now() + DELIVERY_ACK_TIMEOUT_MS
            : Math.min(deadline + DELIVERY_ACK_TIMEOUT_MS, now() + DELIVERY_ACK_TIMEOUT_MS);
        await postToServer('/api/hooks/answers', {
          action: 'delivery-ack',
          event_name: 'DeliveryAck',
          session_id: body.session_id,
          id: crypto.randomUUID(),
          delivery_id: response.deliveryId,
        }, {
          homeDir,
          fetchImpl,
          cache: 'no-store',
          deadline: acknowledgementDeadline,
          attemptTimeoutMs: options.attemptTimeoutMs,
          fileSystem: options.fileSystem,
          readServerInfo: options.readServerInfo,
          ensure: false,
          now,
        });
      } catch {
      }
    };
    if (Array.isArray(options.deferredAcknowledgements)) {
      options.deferredAcknowledgements.push(sendAcknowledgement);
    } else {
      await sendAcknowledgement();
    }
  }
  return response;
}

async function runAskQuestion(input, options = {}) {
  const sessionId = input.session_id;
  const toolUseId = input.tool_use_id;
  if (!validSessionId(sessionId) || typeof toolUseId !== 'string' || !toolUseId) return null;
  const isWrapUp = options.provider !== 'codex' && options.toolName === 'mcp__ccd_turn__wrap_up';
  if (isWrapUp && (input.agent_id || typeof input.tool_input?.ask !== 'string' || !input.tool_input.ask.trim())) return null;
  const questions = isWrapUp ? [{
    question: input.tool_input.ask,
    options: Array.isArray(input.tool_input.actions) ? input.tool_input.actions.map(action => ({
      label: action?.label, description: action?.message,
    })) : [],
  }] : input.tool_input?.questions || [];
  const hookStartedAt = (options.now || Date.now)();
  const register = await postHookRequest({
    action: 'ask-register',
    event_name: 'PreToolUse',
    session_id: sessionId,
    id: toolUseId,
    questions,
    ...(isWrapUp ? { recap: input.tool_input.recap } : {}),
    provider: options.provider || 'claude',
    tool_name: options.toolName || 'AskUserQuestion',
    ...(typeof input.agent_id === 'string' ? { agent_id: input.agent_id } : {}),
  }, { ...options, timeoutMs: 1_000 });
  if (!register) return null;
  if (!register.awaiting) return register.hookOutput || null;
  const fallbackOutput = register.fallbackOutput || denyAnswerOutput(register.decisionId, options.provider, options.toolName);
  const serverDeadline = Number.isFinite(register.deadline)
    ? register.deadline
    : Date.parse(register.awaitingAnswerUntil || '');
  const hookDeadline = Number.isFinite(serverDeadline)
    ? Math.min(serverDeadline + ANSWER_HOOK_DEADLINE_GRACE_MS, hookStartedAt + ANSWER_HOOK_TIMEOUT_MS)
    : hookStartedAt + (options.askHookWaitMs || ANSWER_HOOK_TIMEOUT_MS);
  while ((options.now || Date.now)() < hookDeadline) {
    const result = await postHookRequest({
      action: 'ask-poll', event_name: 'PreToolUse', session_id: sessionId, id: toolUseId, decision_id: register.decisionId,
      provider: options.provider || 'claude', tool_name: options.toolName || 'AskUserQuestion',
    }, { ...options, timeoutMs: MAX_LONG_POLL_MS + 1_500 });
    if (!result) {
      const lost = await postHookRequest({
        action: 'ask-finish', event_name: 'PreToolUse', session_id: sessionId, id: toolUseId, outcome: 'server-lost',
        decision_id: register.decisionId,
        provider: options.provider || 'claude', tool_name: options.toolName || 'AskUserQuestion',
      }, { ...options, timeoutMs: 1_000 });
      const hookOutput = lost ? lost.hookOutput ?? null : fallbackOutput;
      return useOriginalToolInput(hookOutput, input.tool_input);
    }
    if (result.outcome === 'waiting') continue;
    const outcome = ASK_OUTCOMES.has(result.outcome) ? result.outcome : 'server-lost';
    const finished = await postHookRequest({
      action: 'ask-finish', event_name: 'PreToolUse', session_id: sessionId, id: toolUseId, decision_id: register.decisionId, outcome,
      provider: options.provider || 'claude', tool_name: options.toolName || 'AskUserQuestion',
    }, { ...options, timeoutMs: 1_000 });
    const hookOutput = finished
      ? finished.hookOutput ?? null
      : outcome === 'server-lost' ? fallbackOutput : null;
    return useOriginalToolInput(hookOutput, input.tool_input);
  }
  const timeout = await postHookRequest({
    action: 'ask-finish', event_name: 'PreToolUse', session_id: sessionId, id: toolUseId, decision_id: register.decisionId, outcome: 'timeout',
    provider: options.provider || 'claude', tool_name: options.toolName || 'AskUserQuestion',
  }, { ...options, timeoutMs: 1_000 });
  return timeout?.hookOutput || fallbackOutput;
}

async function runPostToolBatch(input, options = {}) {
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
    ...(options.noninteractive ? { suppress_task_reminder: true } : {}),
  }, { ...options, timeoutMs: POST_TOOL_BATCH_TIMEOUT_MS, attemptTimeoutMs: 750 });
  return result?.hookOutput || null;
}

async function runCodexPostToolUse(input, options) {
  if (input.agent_id || !validSessionId(input.session_id)) return null;
  const result = await postHookRequest({
    action: 'post-tool-use',
    event_name: 'PostToolUse',
    session_id: input.session_id,
    id: crypto.randomUUID(),
    provider: 'codex',
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

async function runCodexStopCheck(input, options) {
  if (input.agent_id || !validSessionId(input.session_id)) {
    return { exitCode: 0, output: null, stderrText: null };
  }
  const now = options.now || Date.now;
  const result = await postHookRequest({
    action: 'stop-check',
    event_name: 'Stop',
    session_id: input.session_id,
    id: crypto.randomUUID(),
    hook_at: now(),
    provider: 'codex',
  }, { ...options, timeoutMs: STOP_CHECK_TIMEOUT_MS });
  if (result?.hookOutput) return { exitCode: 0, output: result.hookOutput, stderrText: null };
  if (options.noninteractive || result?.wait !== true || !Number.isInteger(result.generation)) {
    return { exitCode: 0, output: null, stderrText: null };
  }

  const waitMs = Number.isFinite(options.codexStopWaitMs) ? Math.max(0, options.codexStopWaitMs) : CODEX_STOP_WAIT_MS;
  const deadline = now() + waitMs;
  const parentPid = options.parentPid === undefined ? process.ppid : options.parentPid;
  const pollTimeoutMs = (Number.isFinite(options.maxLongPollMs) ? options.maxLongPollMs : MAX_LONG_POLL_MS) + 1_500;
  // 問い合わせを途中で打ち切ると、常駐サーバーは打ち切りの後に届いたものを配信済みにして失うため、丸ごと待てるときだけ問い合わせる。
  while (deadline - now() >= pollTimeoutMs) {
    const parentAlive = options.isParentAlive
      ? options.isParentAlive(parentPid)
      : isParentAlive(parentPid, options.processApi || process);
    if (!parentAlive) return { exitCode: 0, output: null, stderrText: null };
    const polled = await postHookRequest({
      action: 'stop-poll', event_name: 'Stop', session_id: input.session_id, id: crypto.randomUUID(),
      generation: result.generation, parent_alive: parentAlive, provider: 'codex',
    }, { ...options, timeoutMs: pollTimeoutMs });
    if (!polled) return { exitCode: 0, output: null, stderrText: null };
    if (polled.done === true) {
      const output = typeof polled.stderrText === 'string' && polled.stderrText
        ? { decision: 'block', reason: polled.stderrText }
        : null;
      return { exitCode: 0, output, stderrText: null };
    }
    if (options.once) return { exitCode: 0, output: null, stderrText: null };
  }
  return { exitCode: 0, output: null, stderrText: null };
}

async function runStop(input, options) {
  if (input.agent_id || !validSessionId(input.session_id)) return { exitCode: 0, stderrText: null };
  const sessionId = input.session_id;
  const eventId = crypto.randomUUID();
  const hookAt = (options.now || Date.now)();
  if (options.noninteractive) {
    const result = await postHookRequest({
      action: 'stop-check', event_name: 'Stop', session_id: sessionId, id: eventId, hook_at: hookAt,
      provider: 'claude',
    }, { ...options, timeoutMs: STOP_CHECK_TIMEOUT_MS });
    const stderrText = result?.hookOutput?.reason || null;
    return { exitCode: stderrText ? 2 : 0, stderrText };
  }
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
    }, { ...options, timeoutMs: CLAUDE_STOP_POLL_TIMEOUT_MS });
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
  const provider = options.provider === 'codex' ? 'codex' : 'claude';
  if (provider === 'codex') {
    let output = null;
    if (input.hook_event_name === 'PostToolUse') output = await runCodexPostToolUse(input, options);
    else if (input.hook_event_name === 'UserPromptSubmit') output = await runUserPromptSubmit(input, options);
    else if (input.hook_event_name === 'Stop') return runCodexStopCheck(input, options);
    return { exitCode: 0, output, stderrText: null };
  }
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

async function writeStream(stream, text) {
  await new Promise((resolve, reject) => {
    stream.write(text, (error) => error ? reject(error) : resolve());
  });
}

async function runAnswerHookMain(input, outputStream = process.stdout, errorStream = process.stderr, options = {}) {
  try {
    const parsedInput = typeof input === 'string' ? JSON.parse(input) : input;
    const deferredAcknowledgements = [];
    const result = await runAnswerHook(parsedInput, { ...options, deferredAcknowledgements });
    if (result.output) await writeStream(outputStream, `${JSON.stringify(result.output)}\n`);
    if (result.stderrText) await writeStream(errorStream, result.stderrText);
    for (const sendAcknowledgement of deferredAcknowledgements) await sendAcknowledgement();
    return result.exitCode;
  } catch {
    return 0;
  }
}

async function main() {
  try {
    process.exitCode = await runAnswerHookMain(await readStdin(), process.stdout, process.stderr, {
      provider: process.argv[2] === 'codex' ? 'codex' : 'claude',
      noninteractive: process.env.AGENT_COCKPIT_NONINTERACTIVE === '1',
    });
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
  runAnswerHookMain,
};
