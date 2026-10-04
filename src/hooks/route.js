const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { codexAgentScriptPaths } = require('../server/identity');

const ROUTE_VALUES = new Set(['default', 'codex', 'claude']);
const ROUTE_RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLAUDE_ROUTE_CONTEXT = '開発者の指定(agent-cockpit の経路設定): この作業は Claude で行い、codex-agent.sh を呼ばない';
const CODEX_ROUTE_CONTEXT = '開発者の指定(agent-cockpit の経路設定): この作業は Codex(codex-agent.sh 経由の委譲)で行う';
const CODEX_AGENT_SCRIPT = /(?:^|[\\/])?codex-agent\.sh$/i;

function cockpitHome(environment = process.env) {
  return environment.AGENT_COCKPIT_HOME
    ? path.resolve(environment.AGENT_COCKPIT_HOME)
    : path.join(os.homedir(), '.agent-cockpit');
}

function claudeHome(options = {}) {
  if (options.claudeHome) return path.resolve(options.claudeHome);
  const environment = options.environment || process.env;
  return environment.CLAUDE_CONFIG_DIR
    ? path.resolve(environment.CLAUDE_CONFIG_DIR)
    : path.join(os.homedir(), '.claude');
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

function routeRecordPath(input, homeDir) {
  const encodeIdentifier = (value) => typeof value === 'string' && value
    ? Buffer.from(value, 'utf8').toString('hex')
    : null;
  const sessionId = encodeIdentifier(input.session_id);
  const agentId = encodeIdentifier(input.agent_id);
  if (!sessionId || !agentId) return null;
  return path.join(homeDir, 'route-agents', sessionId + '.' + agentId + '.json');
}

function cleanupOldRouteRecords(directory, fileSystem, now = Date.now()) {
  let entries;
  try {
    entries = fileSystem.readdirSync(directory);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const recordPath = path.join(directory, entry);
    try {
      if (now - fileSystem.statSync(recordPath).mtimeMs > ROUTE_RECORD_MAX_AGE_MS) {
        fileSystem.unlinkSync(recordPath);
      }
    } catch {}
  }
}

function writeRouteRecord(recordPath, route, fileSystem) {
  const temporaryPath = recordPath + '.' + process.pid + '.' + crypto.randomBytes(8).toString('hex') + '.tmp';
  try {
    fileSystem.writeFileSync(temporaryPath, JSON.stringify({ route }), { flag: 'wx' });
    fileSystem.renameSync(temporaryPath, recordPath);
    return true;
  } catch {
    try { fileSystem.unlinkSync(temporaryPath); } catch {}
    return false;
  }
}

// 掃除の期限を最後に使ってからの時間にするため、読めた記録は更新時刻を進める。
function readRouteRecord(recordPath, fileSystem) {
  try {
    const record = JSON.parse(fileSystem.readFileSync(recordPath, 'utf8'));
    if (!record || !ROUTE_VALUES.has(record.route)) return null;
    try {
      const now = new Date();
      fileSystem.utimesSync(recordPath, now, now);
    } catch {}
    return record.route;
  } catch {
    return null;
  }
}

function outputForRoute(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const isStart = input.hook_event_name === 'SubagentStart';
  const isBashUse = input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash';
  if (!isStart && !isBashUse) return null;

  const homeDir = options.homeDir || cockpitHome(options.environment);
  const fileSystem = options.fileSystem || fs;
  if (isStart) {
    const scriptExists = (scriptPath) => {
      try {
        return fileSystem.existsSync(scriptPath);
      } catch {
        return false;
      }
    };
    if (!codexAgentScriptPaths(claudeHome(options), options.userHome).some(scriptExists)) return null;
    const directory = path.join(homeDir, 'route-agents');
    try {
      fileSystem.mkdirSync(directory, { recursive: true });
      cleanupOldRouteRecords(directory, fileSystem);
    } catch {
      return null;
    }
    const recordPath = routeRecordPath(input, homeDir);
    if (!recordPath) return null;
    // 再開や SubagentStop の後の続きでも初回の経路を保つため、既にある記録は上書きせず、終了時にも消さない。
    let route = readRouteRecord(recordPath, fileSystem);
    if (!route) {
      const routing = readRouting(homeDir, fileSystem);
      if (!routing || !writeRouteRecord(recordPath, routing.agents, fileSystem)) return null;
      route = routing.agents;
    }
    if (route === 'claude') return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CLAUDE_ROUTE_CONTEXT } };
    if (route === 'codex') return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CODEX_ROUTE_CONTEXT } };
    return null;
  }
  const route = readRouteRecord(routeRecordPath(input, homeDir), fileSystem);
  if (route !== 'claude' ||
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
