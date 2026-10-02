const { cockpitHomeFromOptions } = require('../server/identity');
const { HOOK_TIMEOUT_MS, readServerInfo } = require('./event');

const DENY_REASON = '開発者は離席中です。AskUserQuestion で尋ねずに、推奨の選択肢を適用して作業を続けてください。判断が必要だった事項と、仮に適用した推奨は、最後の報告の「あなたの判断が必要なこと」に一覧で書いてください。破壊的な操作、PR のマージ、main への push は行わず、判断待ちとして残してください。';
const AWAY_CONTEXT = 'Agent Cockpit: 開発者は離席中です({since}から)。開発者に尋ねずに、推奨を適用して作業を続けてください。破壊的な操作、PR のマージ、main への push は行わず、判断待ちとして最後の報告に書いてください。';

function outputForAway(input, since) {
  const hookEventName = input.hook_event_name;
  if (hookEventName === 'PreToolUse') {
    if (input.tool_name !== 'AskUserQuestion') return null;
    return {
      hookSpecificOutput: {
        hookEventName,
        permissionDecision: 'deny',
        permissionDecisionReason: DENY_REASON,
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName,
      additionalContext: AWAY_CONTEXT.replace('{since}', new Date(since).toISOString()),
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
  let timeout;
  try {
    const response = await Promise.race([
      (async () => {
        const result = await fetchImpl(`http://127.0.0.1:${info.port}/api/away`, {
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
    if (!response || response.enabled !== true || !Number.isFinite(response.since)) return null;
    if (!Number.isFinite(new Date(response.since).getTime())) return null;
    return outputForAway(input, response.since);
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

module.exports = { DENY_REASON, AWAY_CONTEXT, runAwayHook };
