const { cockpitHomeFromOptions } = require('../server/identity');
const { HOOK_TIMEOUT_MS, readServerInfo } = require('./event');

const DENY_REASON = '開発者は離席中です。AskUserQuestion で尋ねずに、推奨の選択肢を適用して作業を続けてください。判断事項の id は「{id}」です。推奨で進めたら cockpit_update_decision でこの id を provisional にし、選んだ選択肢を書いてください。判断が必要だった事項と仮に適用した推奨は、最後の報告の「あなたの判断が必要なこと」に一覧で書いてください。破壊的な操作、PR のマージ、main への push は行わず、判断待ちとして残してください。';
const AWAY_CONTEXT = 'Agent Cockpit: 開発者は離席中です({since}から)。開発者に尋ねずに、推奨を適用して作業を続けてください。破壊的な操作、PR のマージ、main への push は行わず、判断待ちとして最後の報告に書いてください。';

function decisionIdForReason(value) {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 256).replace(/[\r\n]/g, '') : '不明';
}

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

function outputForAway(input, away, snapshot = null) {
  const hookEventName = input.hook_event_name;
  if (hookEventName === 'PreToolUse') {
    if (input.tool_name !== 'AskUserQuestion' || away.enabled !== true) return null;
    return {
      hookSpecificOutput: {
        hookEventName,
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_REASON.replace('{id}', decisionIdForReason(input.tool_use_id)),
      },
    };
  }
  const context = [];
  if (snapshot && hookEventName === 'SessionStart' && ['compact', 'resume'].includes(input.source)) {
    context.push(sessionSummary(snapshot));
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
  if (hookEventName === 'PreToolUse' && input.tool_name !== 'AskUserQuestion') return null;

  const homeDir = options.homeDir || cockpitHomeFromOptions(options);
  const info = await readServerInfo(homeDir);
  if (!info || info.port < 1 || info.port > 65535) return null;

  const controller = new AbortController();
  const fetchImpl = options.fetchImpl || fetch;
  const wantsSummary = hookEventName === 'SessionStart' && ['compact', 'resume'].includes(input.source) &&
    typeof input.session_id === 'string' && /^[A-Za-z0-9-]{1,128}$/.test(input.session_id);
  const endpoint = wantsSummary
    ? `/api/sessions/${encodeURIComponent(input.session_id)}/context`
    : '/api/away';
  let timeout;
  try {
    const response = await Promise.race([
      (async () => {
        const result = await fetchImpl(`http://127.0.0.1:${info.port}${endpoint}`, {
          method: 'GET',
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!result.ok) return null;
        return result.json();
      })(),
      new Promise((resolve) => {
        timeout = setTimeout(() => {
          controller.abort();
          resolve(null);
        }, HOOK_TIMEOUT_MS);
      }),
    ]);
    if (!response || typeof response !== 'object') return null;
    if (response.enabled === true && (!Number.isFinite(response.since) || !Number.isFinite(new Date(response.since).getTime()))) return null;
    return outputForAway(input, response, wantsSummary ? response : null);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
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
    const output = await runAwayHook(input);
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {
    process.exitCode = 0;
  }
}

if (require.main === module) main();

module.exports = { DENY_REASON, AWAY_CONTEXT, decisionIdForReason, sessionSummary, runAwayHook };
