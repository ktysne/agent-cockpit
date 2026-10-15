const { cockpitHomeFromOptions } = require('../server/identity');
const { HOOK_TIMEOUT_MS, readServerInfo, requestFromServer } = require('../client/server-connection');
const { runAskQuestion } = require('./answer');
const { isHookSessionId } = require('../server/session-ids');
const { isQuestionTool } = require('../server/events');

const AWAY_CONTEXT = 'Agent Cockpit: 開発者は離席中です({since}から)。開発者に尋ねずに、推奨を適用して作業を続けてください。破壊的な操作は行わず、判断待ちとして最後の報告に書いてください。';
const TASK_CONTEXT = 'Agent Cockpit: 作業を始めるときはタスクと完了条件を登録してください。このアプリのタスク一覧を使うターンでは、その一覧が cockpit の 1 つのタスクの完了条件として取り込まれます。依頼ごとに、そのタスクの題だけを `cockpit_set_tasks` で 1 件 (`[{title, state:"doing"}]`) 登録してください。完了条件は書かなくて構いません。アプリのタスク一覧を使わないときは、従来どおり `cockpit_set_tasks` で一覧全体を登録し、タスクの状態か完了条件が変わったら書き直してください。サブエージェントに渡したときと、その報告を受けたとき、PR のマージを確かめたとき、作業を切り替えたときも書き直してください。質問への回答だけで終わるような、作業を伴わないターンでは登録しなくて構いません。';
const SET_TASKS_CONTEXT = 'Agent Cockpit: 作業を始めるときは `cockpit_set_tasks` でタスクと完了条件を登録してください。今取り組んでいる完了条件には `doing: true` を付けてください。タスクの状態か完了条件が変わったら、一覧全体を書き直してください。サブエージェントに渡したときと、その報告を受けたとき、PR のマージを確かめたとき、作業を切り替えたときも書き直してください。質問への回答だけで終わるような、作業を伴わないターンでは登録しなくて構いません。';

function sessionSummary(snapshot) {
  const tasks = Array.isArray(snapshot.tasks) ? snapshot.tasks : [];
  const decisions = Array.isArray(snapshot.decisions) ? snapshot.decisions : [];
  const summarize = (items, format) => {
    const visible = items.slice(0, 10).map(format);
    if (items.length > 10) visible.push(`ほか ${items.length - 10} 件`);
    return visible.length ? visible.join('、') : 'なし';
  };
  const lines = ['Agent Cockpit: 現在の状態'];
  lines.push(`タスク: ${summarize(tasks, (task) => `${task.title} (${task.state})`)}`);
  lines.push(`未解決の判断事項: ${summarize(decisions, (decision) => `${decision.id} ${decision.title} (${decision.state})`)}`);
  return lines.join('\n');
}

function outputForAway(input, away, snapshot = null, provider = 'claude') {
  const hookEventName = input.hook_event_name;
  if (hookEventName === 'PreToolUse') return null;
  const context = [];
  if (snapshot && hookEventName === 'SessionStart' && ['compact', 'resume'].includes(input.source)) {
    context.push(sessionSummary(snapshot));
  }
  if (!input.agent_id && ['SessionStart', 'UserPromptSubmit'].includes(hookEventName)) {
    const importAppTasks = typeof away.importAppTasks === 'boolean' ? away.importAppTasks
      : typeof snapshot?.importAppTasks === 'boolean' ? snapshot.importAppTasks : false;
    context.push(provider === 'codex' || !importAppTasks ? SET_TASKS_CONTEXT : TASK_CONTEXT);
  }
  if (away.enabled === true && Number.isFinite(away.since)) {
    context.push(AWAY_CONTEXT.replace('{since}', new Date(away.since).toISOString()));
  }
  if (!context.length) return null;
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: context.join('\n'),
    },
  };
}

async function runAwayHook(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const hookEventName = input.hook_event_name;
  if (!['PreToolUse', 'UserPromptSubmit', 'SessionStart'].includes(hookEventName)) return null;
  const provider = options.provider === 'codex' ? 'codex' : 'claude';
  if (hookEventName === 'PreToolUse' && !isQuestionTool(provider, input.tool_name)) return null;
  if (hookEventName === 'PreToolUse') return runAskQuestion(input, { ...options, provider, toolName: input.tool_name });

  const homeDir = options.homeDir || cockpitHomeFromOptions(options);
  const info = await readServerInfo(homeDir);
  if (!info || info.port < 1 || info.port > 65535) return outputForAway(input, { enabled: false }, null, provider);

  const fetchImpl = options.fetchImpl || fetch;
  const wantsSummary = hookEventName === 'SessionStart' && ['compact', 'resume'].includes(input.source) &&
    isHookSessionId(input.session_id);
  const endpoint = wantsSummary
    ? `/api/sessions/${encodeURIComponent(input.session_id)}/context`
    : '/api/away';
  try {
    const result = await requestFromServer(info, endpoint, { method: 'GET', cache: 'no-store' }, {
      fetchImpl,
      deadline: Date.now() + HOOK_TIMEOUT_MS,
      attemptTimeoutMs: HOOK_TIMEOUT_MS,
    });
    const response = result.ok ? result.json : null;
    if (!response || typeof response !== 'object') return outputForAway(input, { enabled: false }, null, provider);
    if (response.enabled === true && (!Number.isFinite(response.since) || !Number.isFinite(new Date(response.since).getTime()))) {
      return outputForAway(input, { enabled: false }, null, provider);
    }
    return outputForAway(input, response, wantsSummary ? response : null, provider);
  } catch {
    return outputForAway(input, { enabled: false }, null, provider);
  }
}

async function readStdin(stream = process.stdin) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main() {
  try {
    const input = JSON.parse(await readStdin());
    const output = await runAwayHook(input, { provider: process.argv[2] === 'codex' ? 'codex' : 'claude' });
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    process.exitCode = 0;
  }
}

if (require.main === module) main();

module.exports = { AWAY_CONTEXT, TASK_CONTEXT, SET_TASKS_CONTEXT, sessionSummary, outputForAway, runAwayHook };
