const fs = require('node:fs');
const path = require('node:path');
const { claudeHomeFromOptions, codexAgentScriptPaths, cockpitHomeFromOptions } = require('../server/identity');
const { ROUTE_VALUES, readRoutingSync } = require('../server/routing');
const { isPullRequestShellTool } = require('../server/pull-request-utils');
const { commandInvocationDetails: codexAgentInvocationDetails, commandInvocations: codexAgentInvocations } = require('../shared/shell-commands');
const { atomicWriteJsonSync } = require('../server/json-storage');

const ROUTE_RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLAUDE_ROUTE_CONTEXT = '開発者の指定(agent-cockpit の経路設定): この作業は Claude で行い、codex-agent.sh を呼ばない';
const CODEX_ROUTE_CONTEXT = '開発者の指定(agent-cockpit の経路設定): この作業は Codex(codex-agent.sh 経由の委譲)で行う';
const AGENTS_ROUTE_AGENT_TYPES = new Set(['impl-hard', 'impl-standard', 'impl-light', 'codex-subagent']);
const REVIEW_ROUTE_AGENT_TYPES = new Set(['codex-review']);
const CODEX_AGENT_SCRIPT = /(?:^|[\\/])codex-agent\.sh$/i;
const readRouting = readRoutingSync;
function commandInvokesCodexAgent(command, toolName = 'Bash') {
  return codexAgentInvocations(command, (word) => CODEX_AGENT_SCRIPT.test(word), undefined, 0, toolName).length > 0;
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
  try {
    atomicWriteJsonSync(path.dirname(recordPath), path.basename(recordPath), { route }, fileSystem);
    return true;
  } catch {
    return false;
  }
}

function readRouteRecordValue(recordPath, fileSystem) {
  try {
    const record = JSON.parse(fileSystem.readFileSync(recordPath, 'utf8'));
    if (!record || !ROUTE_VALUES.has(record.route)) return null;
    return record.route;
  } catch {
    return null;
  }
}

// 掃除の期限を最後に使ってからの時間にするため、読めた記録は更新時刻を進める。
function readRouteRecord(recordPath, fileSystem) {
  const route = readRouteRecordValue(recordPath, fileSystem);
  if (!route) return null;
  try {
    const now = new Date();
    fileSystem.utimesSync(recordPath, now, now);
  } catch {}
  return route;
}

function codexAgentScriptExists(options, fileSystem) {
  return codexAgentScriptPaths(claudeHomeFromOptions(options), options.userHome).some((scriptPath) => {
    try {
      return fileSystem.existsSync(scriptPath);
    } catch {
      return false;
    }
  });
}

function routeKeyForAgentType(agentType) {
  if (AGENTS_ROUTE_AGENT_TYPES.has(agentType)) return 'agents';
  if (REVIEW_ROUTE_AGENT_TYPES.has(agentType)) return 'review';
  return null;
}

function effectiveRouteForSubagentStart(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.hook_event_name !== 'SubagentStart') return null;
  const routeKey = routeKeyForAgentType(input.agent_type);
  if (!routeKey) return null;
  const fileSystem = options.fileSystem || fs;
  if (!codexAgentScriptExists(options, fileSystem)) return null;
  const homeDir = cockpitHomeFromOptions(options);
  const recordPath = routeRecordPath(input, homeDir);
  if (!recordPath) return null;
  const recordedRoute = readRouteRecordValue(recordPath, fileSystem);
  return recordedRoute || readRouting(homeDir, fileSystem, options.readRetryOptions)?.[routeKey] || null;
}

function outputForRoute(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const isStart = input.hook_event_name === 'SubagentStart';
  const isShellToolUse = input.hook_event_name === 'PreToolUse' && isPullRequestShellTool(input.tool_name);
  if (!isStart && !isShellToolUse) return null;
  const routeKey = isStart ? routeKeyForAgentType(input.agent_type) : null;
  if (isStart && !routeKey) return null;

  const homeDir = cockpitHomeFromOptions(options);
  const fileSystem = options.fileSystem || fs;
  if (isStart) {
    if (!codexAgentScriptExists(options, fileSystem)) return null;
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
      const routing = readRouting(homeDir, fileSystem, options.readRetryOptions);
      route = routing?.[routeKey];
      if (!routing || !writeRouteRecord(recordPath, route, fileSystem)) return null;
    }
    if (route === 'claude') return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CLAUDE_ROUTE_CONTEXT } };
    if (route === 'codex') return { hookSpecificOutput: { hookEventName: 'SubagentStart', additionalContext: CODEX_ROUTE_CONTEXT } };
    return null;
  }
  const route = readRouteRecord(routeRecordPath(input, homeDir), fileSystem);
  if (route !== 'claude' ||
    !commandInvokesCodexAgent(input.tool_input?.command, input.tool_name)) return null;
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

module.exports = { CLAUDE_ROUTE_CONTEXT, CODEX_ROUTE_CONTEXT, codexAgentInvocationDetails, codexAgentInvocations, commandInvokesCodexAgent, effectiveRouteForSubagentStart, outputForInputText, outputForRoute, readRouting };
