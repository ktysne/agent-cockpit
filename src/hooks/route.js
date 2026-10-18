const fs = require('node:fs');
const path = require('node:path');
const { claudeHomeFromOptions, codexAgentScriptPaths, cockpitHomeFromOptions } = require('../server/identity');
const { ROUTE_VALUES, readRoutingSync } = require('../server/routing');
const { commandSegments, commandWords } = require('../server/pull-request-utils');
const { atomicWriteJsonSync } = require('../server/json-storage');

const ROUTE_RECORD_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLAUDE_ROUTE_CONTEXT = '開発者の指定(agent-cockpit の経路設定): この作業は Claude で行い、codex-agent.sh を呼ばない';
const CODEX_ROUTE_CONTEXT = '開発者の指定(agent-cockpit の経路設定): この作業は Codex(codex-agent.sh 経由の委譲)で行う';
const CODEX_AGENT_SCRIPT = /(?:^|[\\/])codex-agent\.sh$/i;
const readRouting = readRoutingSync;
const TRANSPARENT_COMMANDS = new Set(['command', 'nohup', 'time', 'builtin', '!']);
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

function commandName(word) {
  return (word || '').split(/[\\/]/).pop().toLowerCase().replace(/\.exe$/, '');
}

function withoutEnvOptions(words) {
  let rest = words;
  while (rest[0] !== undefined && (rest[0].startsWith('-') || ASSIGNMENT_WORD.test(rest[0]))) {
    rest = rest.slice(['-u', '--unset', '-C', '--chdir'].includes(rest[0]) ? 2 : 1);
  }
  return rest;
}

// 後ろのコマンドをそのまま実行するだけの前置きを外し、実際に起動されるコマンドの語から始める。
// commandWords は先頭の代入と env を外すので、元の区切りが env で始まるかを startsWithEnv で受け、残った env のオプションを外す。
function withoutCommandPrefixes(words, startsWithEnv) {
  let rest = startsWithEnv ? withoutEnvOptions(words) : words;
  for (;;) {
    const name = commandName(rest[0]);
    if (TRANSPARENT_COMMANDS.has(name)) {
      rest = rest.slice(1);
    } else if (name === 'exec' || name === 'nice' || name === 'timeout') {
      rest = rest.slice(1);
      while (rest[0]?.startsWith('-')) rest = rest.slice(['-a', '-n', '-s', '-k', '--signal', '--kill-after'].includes(rest[0]) ? 2 : 1);
      if (name === 'timeout') rest = rest.slice(1);
    } else if (name === 'env') {
      rest = withoutEnvOptions(rest.slice(1));
    } else {
      return rest;
    }
  }
}

function segmentStartsWithEnv(segment) {
  const firstCommand = segment.split(/\s+/).find((word) => !ASSIGNMENT_WORD.test(word));
  return commandName(firstCommand) === 'env';
}

function commandInvokesCodexAgent(command, depth = 0) {
  if (typeof command !== 'string') return false;
  if (depth >= 8) return false;
  return commandSegments(command).some((segment) => {
    let ungrouped = segment.trim();
    while (/^[({]/.test(ungrouped)) ungrouped = ungrouped.slice(1).trimStart();
    while (/[)}]$/.test(ungrouped)) ungrouped = ungrouped.slice(0, -1).trimEnd();
    const words = withoutCommandPrefixes(commandWords(ungrouped), segmentStartsWithEnv(ungrouped));
    const isScript = (word) => CODEX_AGENT_SCRIPT.test(word);
    if (isScript(words[0] || '')) return true;
    if (['source', '.'].includes(words[0])) return isScript(words[1] || '');
    const shell = commandName(words[0]);
    if (!['bash', 'sh', 'dash', 'zsh'].includes(shell)) return false;
    for (let index = 1; index < words.length;) {
      const option = words[index];
      if (option === '-c' || option === '--command' || /^-[^-]*c[^-]*$/.test(option)) {
        return commandInvokesCodexAgent(words[index + 1] || '', depth + 1);
      }
      if (option === '--help' || option === '--version' || option === '-help' || option === '-version') return false;
      if (option === '--') return isScript(words[index + 1] || '');
      if (option === '-o' || option === '-O' || option === '--rcfile' || option === '--init-file') {
        index += 2;
      } else if (option.startsWith('-') && option !== '-') {
        index += 1;
      } else {
        return isScript(option);
      }
    }
    return false;
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

function effectiveRouteForSubagentStart(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || input.hook_event_name !== 'SubagentStart') return null;
  const fileSystem = options.fileSystem || fs;
  if (!codexAgentScriptExists(options, fileSystem)) return null;
  const homeDir = cockpitHomeFromOptions(options);
  const recordPath = routeRecordPath(input, homeDir);
  if (!recordPath) return null;
  return readRouteRecordValue(recordPath, fileSystem) || readRouting(homeDir, fileSystem)?.agents || null;
}

function outputForRoute(input, options = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const isStart = input.hook_event_name === 'SubagentStart';
  const isBashUse = input.hook_event_name === 'PreToolUse' && input.tool_name === 'Bash';
  if (!isStart && !isBashUse) return null;

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

module.exports = { CLAUDE_ROUTE_CONTEXT, CODEX_ROUTE_CONTEXT, commandInvokesCodexAgent, effectiveRouteForSubagentStart, outputForInputText, outputForRoute, readRouting };
