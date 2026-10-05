'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const {
  assertNoSymlinkComponents,
  makeLayout,
  resolveOutputDirectory,
} = require('./setup');
const { isSafeIdentity } = require('./mcp-probe');

const REQUIRED_CODEX_VERSION = '0.160.0';
const RPC_TIMEOUT_MS = 15000;
const OS_ENVIRONMENT = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'PROGRAMDATA',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'COMSPEC',
];
const CODEX_ID_ENV_NAMES = ['CODEX_THREAD_ID', 'CODEX_SESSION_ID', 'CODEX_AGENT_ID', 'CODEX_TURN_ID'];
const APP_SERVER_HOOK_EVENTS = new Set([
  'preToolUse', 'permissionRequest', 'postToolUse', 'preCompact', 'postCompact',
  'sessionStart', 'sessionEnd', 'userPromptSubmit', 'subagentStart', 'subagentStop', 'stop', 'interrupt',
]);

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--codex-path', '--out'].includes(option) || values.has(option) || !argv[index + 1]) {
      throw new Error('Usage: node run-rpc.js --codex-path <codex.exe> --out poc/out/<slug>');
    }
    values.set(option, argv[index + 1]);
    index += 1;
  }
  if (!values.has('--codex-path') || !values.has('--out')) {
    throw new Error('Usage: node run-rpc.js --codex-path <codex.exe> --out poc/out/<slug>');
  }
  return { codexPath: values.get('--codex-path'), outputDirectory: values.get('--out') };
}

function makeChildEnvironment(parentEnvironment, home) {
  const environment = {};
  for (const name of OS_ENVIRONMENT) {
    if (typeof parentEnvironment[name] === 'string') environment[name] = parentEnvironment[name];
  }
  environment.CODEX_HOME = home;
  environment.CLAUDE_CODE_SESSION_ID = 'poc157-synthetic-claude-session';
  return environment;
}

function safeLabel(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,128}$/.test(value) ? value : 'unknown';
}

function safeMetaKeys(value) {
  if (!Array.isArray(value)) return [];
  return value.filter(key => typeof key === 'string' && /^[A-Za-z][A-Za-z0-9_./-]{0,63}$/.test(key))
    .slice(0, 32).sort();
}

function sanitizeProbe(value) {
  const explicit = value && typeof value.explicit === 'object' ? value.explicit : {};
  const environment = value && typeof value.environment === 'object' ? value.environment : {};
  const codex = environment.codex && typeof environment.codex === 'object' ? environment.codex : {};
  const claude = environment.claude_code_session && typeof environment.claude_code_session === 'object'
    ? environment.claude_code_session
    : {};
  const meta = value && typeof value.mcp_meta === 'object' ? value.mcp_meta : {};
  const explicitSession = isSafeIdentity(explicit.session_id) ? explicit.session_id : 'unknown';
  const metaThread = isSafeIdentity(meta.thread_id) ? meta.thread_id : 'unknown';
  const result = {
    explicit: {
      session_id: explicitSession,
      agent_id: isSafeIdentity(explicit.agent_id) ? explicit.agent_id : 'unknown',
    },
    environment: {
      codex: {},
      claude_code_session: {
        present: claude.present === true,
        matches_explicit_session_id: typeof claude.matches_explicit_session_id === 'boolean'
          ? claude.matches_explicit_session_id
          : null,
      },
    },
    mcp_meta: {
      keys: safeMetaKeys(meta.keys),
      thread_id: metaThread,
      matches_explicit_session_id: typeof meta.matches_explicit_session_id === 'boolean'
        ? meta.matches_explicit_session_id
        : null,
    },
  };
  for (const name of CODEX_ID_ENV_NAMES) {
    const candidate = codex[name] && typeof codex[name] === 'object' ? codex[name] : {};
    result.environment.codex[name] = {
      present: candidate.present === true,
      value: isSafeIdentity(candidate.value) ? candidate.value : 'unknown',
    };
  }
  if (result.mcp_meta.thread_id !== 'unknown' && explicitSession !== 'unknown') {
    result.mcp_meta.matches_explicit_session_id = result.mcp_meta.thread_id === explicitSession;
  }
  return result;
}

function summarizeHookList(response) {
  const groups = response && response.result && Array.isArray(response.result.data) ? response.result.data : [];
  return groups.flatMap(group => Array.isArray(group.hooks) ? group.hooks.map(hook => ({
    event_name: APP_SERVER_HOOK_EVENTS.has(hook.eventName) ? hook.eventName : 'unknown',
    source: safeLabel(hook.source),
    trust_status: safeLabel(hook.trustStatus),
    enabled: typeof hook.enabled === 'boolean' ? hook.enabled : 'unknown',
  })) : []);
}

function summarizeToolCall(response) {
  if (response && response.error) return { error_code: Number.isInteger(response.error.code) ? response.error.code : 'unknown' };
  const blocks = response && response.result && Array.isArray(response.result.content) ? response.result.content : [];
  const textBlock = blocks.find(block => block && block.type === 'text' && typeof block.text === 'string');
  if (!textBlock) return { error_code: 'unknown', probe: null };
  try {
    return { probe: sanitizeProbe(JSON.parse(textBlock.text)) };
  } catch {
    return { error_code: 'invalid_probe_response', probe: null };
  }
}

function validatePaths(codexPath, outputDirectory) {
  const output = resolveOutputDirectory(outputDirectory);
  const repositoryRoot = fs.realpathSync(path.resolve(__dirname, '..', '..'));
  assertNoSymlinkComponents(repositoryRoot, output);
  const layout = makeLayout(output);
  for (const directory of [layout.home, layout.repo]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('PoC home and repository must be real directories');
  }
  const executable = path.resolve(codexPath);
  const executableStat = fs.lstatSync(executable);
  if (!executableStat.isFile() || executableStat.isSymbolicLink()) throw new Error('--codex-path must name a regular executable file');
  return { executable, layout };
}

function connectAppServer(executable, layout, options = {}) {
  const child = spawn(executable, ['app-server', '--stdio'], {
    cwd: layout.repo,
    env: makeChildEnvironment(options.environment || process.env, layout.home),
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  let nextId = 0;
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message && Object.hasOwn(message, 'id') && pending.has(message.id)) {
      const complete = pending.get(message.id);
      pending.delete(message.id);
      complete.resolve(message);
    }
  });
  child.stderr.on('data', () => {});
  child.on('error', () => {
    for (const complete of pending.values()) complete.reject(new Error('app-server could not start'));
    pending.clear();
  });
  child.on('close', () => {
    for (const complete of pending.values()) complete.reject(new Error('app-server exited'));
    pending.clear();
  });

  return {
    child,
    async rpc(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`RPC timeout: ${method}`));
        }, options.timeoutMs || RPC_TIMEOUT_MS);
        pending.set(id, {
          resolve(message) { clearTimeout(timer); resolve(message); },
          reject(error) { clearTimeout(timer); reject(error); },
        });
        try {
          child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
            if (!error || !pending.has(id)) return;
            pending.get(id).reject(new Error(`RPC write failed: ${method}`));
            pending.delete(id);
          });
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          reject(new Error(`RPC write failed: ${method}`));
        }
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
  };
}

function resultsFileName(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `rpc-results-${stamp}.json`;
}

function buildRunMetadata(userAgent, platform = process.platform, architecture = process.arch) {
  if (typeof userAgent !== 'string' || !userAgent.includes(REQUIRED_CODEX_VERSION)) {
    throw new Error('app-server version did not match Codex 0.160.0');
  }
  return { version: REQUIRED_CODEX_VERSION, platform, architecture };
}

async function runRpcProbe(options) {
  const { executable, layout } = validatePaths(options.codexPath, options.outputDirectory);
  const app = connectAppServer(executable, layout, options);
  const output = {
    target_version: REQUIRED_CODEX_VERSION,
    initialize: null,
    hooks: [],
    calls: [],
  };
  try {
    const initialized = await app.rpc('initialize', {
      clientInfo: { name: 'agent_cockpit_poc157', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    const userAgent = initialized.result && initialized.result.userAgent;
    if (initialized.error) throw new Error('app-server initialization failed');
    output.initialize = buildRunMetadata(userAgent);
    app.notify('initialized', {});

    const hooks = await app.rpc('hooks/list', { cwds: [layout.repo] });
    output.hooks = summarizeHookList(hooks);

    for (let index = 0; index < 2; index += 1) {
      const started = await app.rpc('thread/start', {
        cwd: layout.repo,
        ephemeral: true,
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
      });
      const rawThreadId = started.result && started.result.thread && started.result.thread.id;
      if (started.error || !isSafeIdentity(rawThreadId)) throw new Error('thread/start did not return a safe thread ID');
      const threadId = rawThreadId;
      output.calls.push({ step: 'thread/start', index, thread_id: threadId });

      for (const arguments_ of [{}, { session_id: threadId }, { session_id: 'poc157-wrong-thread' }]) {
        const response = await app.rpc('mcpServer/tool/call', {
          threadId,
          server: 'poc157_identity',
          tool: 'probe_identity',
          arguments: arguments_,
          _meta: { threadId: 'poc157-spoofed-meta', progressToken: 'poc157-spoofed-progress' },
        });
        output.calls.push({
          step: 'mcpServer/tool/call',
          index,
          explicit_session_id: isSafeIdentity(arguments_.session_id) ? arguments_.session_id : 'unknown',
          result: summarizeToolCall(response),
        });
      }
    }

    const filePath = path.join(layout.output, resultsFileName());
    fs.writeFileSync(filePath, `${JSON.stringify(output, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    return filePath;
  } finally {
    app.child.kill();
  }
}

if (require.main === module) {
  try {
    const filePath = runRpcProbe(parseArguments(process.argv.slice(2)));
    filePath.then(result => process.stdout.write(`${result}\n`)).catch(error => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    });
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildRunMetadata,
  makeChildEnvironment,
  parseArguments,
  resultsFileName,
  runRpcProbe,
  sanitizeProbe,
  summarizeHookList,
  summarizeToolCall,
  validatePaths,
};
