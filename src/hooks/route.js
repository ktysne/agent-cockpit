const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROUTE_VALUES = new Set(['default', 'codex', 'claude']);
const CLAUDE_ROUTE_CONTEXT = '開発者の指定(agent-cockpit の経路設定): この作業は Claude で行い、codex-agent.sh を呼ばない';
const CODEX_ROUTE_CONTEXT = '開発者の指定(agent-cockpit の経路設定): この作業は Codex(codex-agent.sh 経由の委譲)で行う';
const CODEX_AGENT_SCRIPT = /(?:^|[\\/])?codex-agent\.sh$/i;

function cockpitHome(environment = process.env) {
  return environment.AGENT_COCKPIT_HOME
    ? path.resolve(environment.AGENT_COCKPIT_HOME)
    : path.join(os.homedir(), '.agent-cockpit');
}

function readRouting(homeDir = cockpitHome(), fileSystem = fs) {
  try {
    const value = JSON.parse(fileSystem.readFileSync(path.join(homeDir, 'routing.json'), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== 2 || !ROUTE_VALUES.has(value.agents) || !ROUTE_VALUES.has(value.review)) return null;
    return { agents: value.agents, review: value.review };
  } catch {
    return null;
  }
}

function commandInvokesCodexAgent(command) {
  if (typeof command !== 'string') return false;
  const segments = command.split(/&&|\|\||[;|\n]/);
  return segments.some((segment) => {
    const words = segment.match(/"[^"\n]*"|'[^'\n]*'|`[^`\n]*`|[^\s]+/g)
      ?.map((word) => word.replace(/^(?:"([\s\S]*)"|'([\s\S]*)'|`([\s\S]*)`)$/, '$1$2$3')) || [];
    const isScript = (word) => CODEX_AGENT_SCRIPT.test(word);
    if (isScript(words[0] || '')) return true;
    const shell = (words[0] || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
    if (!['bash', 'sh', 'dash', 'zsh'].includes(shell)) return false;
    const inlineCommand = words.indexOf('-c');
    if (inlineCommand >= 0) return commandInvokesCodexAgent(words[inlineCommand + 1] || '');
    return words.slice(1).some(isScript);
  });
}

function outputForRoute(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const isStart = input.hook_event_name === 'SubagentStart';
  const isBashUse = input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash';
  if (!isStart && !isBashUse) return null;

  const routing = readRouting(options.homeDir || cockpitHome(options.environment), options.fileSystem || fs);
  if (!routing) return null;
  if (isStart) {
    if (routing.agents === 'claude') return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CLAUDE_ROUTE_CONTEXT } };
    if (routing.agents === 'codex') return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CODEX_ROUTE_CONTEXT } };
    return null;
  }
  if (routing.agents !== 'claude' || typeof input.agent_id !== 'string' || !input.agent_id ||
    !commandInvokesCodexAgent(input.tool_input?.command)) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: CLAUDE_ROUTE_CONTEXT,
    },
  };
}

function outputForInputText(inputText, options = {}) {
  try {
    return outputForRoute(JSON.parse(inputText), options);
  } catch {
    return null;
  }
}

function main() {
  try {
    const output = outputForInputText(fs.readFileSync(0, 'utf8'));
    if (output) process.stdout.write(`${JSON.stringify(output)}\n`);
  } catch {}
}

if (require.main === module) main();

module.exports = { CLAUDE_ROUTE_CONTEXT, CODEX_ROUTE_CONTEXT, commandInvokesCodexAgent, outputForInputText, outputForRoute, readRouting };
