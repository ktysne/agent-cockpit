'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');
const { randomUUID } = require('node:crypto');
const {
  assertNoSymlinkComponents,
  resolveOutputDirectory,
  REPOSITORY_ROOT,
} = require('./setup');
const { buildRunMetadata, makeChildEnvironment, validatePaths } = require('./run-rpc');
const { isSafeIdentity } = require('./mcp-probe');

const REQUIRED_CODEX_VERSION = '0.160.0';
const SYNTHETIC_CLAUDE_SESSION_ID = 'poc157-synthetic-claude-session';
const MCP_SERVER_NAME = 'agent_cockpit';
const RPC_TIMEOUT_MS = 15000;
const SERVER_SCRIPT = path.join(REPOSITORY_ROOT, 'src', 'mcp', 'server.js');
const FIXTURE_PR_URLS = [
  'https://github.com/poc157-fixture-org/poc157-fixture-repo/pull/157',
  'https://github.com/poc157-fixture-org/poc157-fixture-repo/pull/158',
];

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--codex-path', '--out'].includes(option) || values.has(option) || !argv[index + 1]) {
      throw new Error('Usage: node run-existing-mcp.js --codex-path <codex.exe> --out poc/out/<slug>');
    }
    values.set(option, argv[index + 1]);
    index += 1;
  }
  if (!values.has('--codex-path') || !values.has('--out')) {
    throw new Error('Usage: node run-existing-mcp.js --codex-path <codex.exe> --out poc/out/<slug>');
  }
  return { codexPath: values.get('--codex-path'), outputDirectory: values.get('--out') };
}

function tomlString(value) {
  return JSON.stringify(value);
}

function renderMcpServerConfig(paths) {
  return [
    `[mcp_servers.${MCP_SERVER_NAME}]`,
    `command = ${tomlString(process.execPath)}`,
    `args = [${tomlString(SERVER_SCRIPT)}]`,
    `env = { AGENT_COCKPIT_HOME = ${tomlString(paths.cockpitHome)}, CLAUDE_CODE_SESSION_ID = ${tomlString(SYNTHETIC_CLAUDE_SESSION_ID)} }`,
    '',
  ].join('\n');
}

function appendMcpServerConfig(config, table) {
  if (typeof config !== 'string' || typeof table !== 'string') throw new TypeError('config and table must be strings');
  const tableHeader = new RegExp(`^\\s*\\[mcp_servers\\.${MCP_SERVER_NAME}\\]\\s*$`, 'm');
  if (tableHeader.test(config)) throw new Error('dedicated config already contains the existing Cockpit MCP table');
  return `${config.replace(/\s*$/, '')}\n\n${table}`;
}

function createServerDataRoot(outputDirectory, runId = randomUUID()) {
  const base = resolveOutputDirectory(outputDirectory);
  const target = path.join(base, `existing-mcp-${runId}`);
  const resolved = resolveOutputDirectory(target);
  assertNoSymlinkComponents(REPOSITORY_ROOT, resolved);
  if (fs.existsSync(resolved)) throw new Error('dedicated server data path already exists');
  return resolved;
}

function safeCounts(value) {
  const count = number => Number.isSafeInteger(number) && number >= 0 ? number : 0;
  return {
    tasks: count(value?.tasks),
    decisions: count(value?.decisions),
    pull_requests: count(value?.pull_requests),
  };
}

function summarizeRouting(nativeThreadIds, rawStats) {
  const sessions = Array.isArray(rawStats?.sessions) ? rawStats.sessions : [];
  const byId = new Map();
  for (const session of sessions) {
    if (!isSafeIdentity(session?.session_id)) continue;
    byId.set(session.session_id, safeCounts(session.counts));
  }
  const nativeThreads = nativeThreadIds.map(threadId => ({
    thread_id: threadId,
    counts: byId.get(threadId) || safeCounts(null),
  }));
  const syntheticCounts = byId.get(SYNTHETIC_CLAUDE_SESSION_ID) || safeCounts(null);
  const nativeWrites = nativeThreads.some(({ counts }) => counts.tasks + counts.decisions + counts.pull_requests > 0);
  const routedToSynthetic = syntheticCounts.decisions === 2 && syntheticCounts.pull_requests === 2 && syntheticCounts.tasks === 1;
  return {
    native_threads: nativeThreads,
    synthetic_claude_session: { session_id: SYNTHETIC_CLAUDE_SESSION_ID, counts: syntheticCounts },
    observed_legacy_routing_to_claude_id: routedToSynthetic && !nativeWrites,
  };
}

function isSuccessfulToolResponse(response) {
  const blocks = response?.result?.content;
  return Boolean(response && !response.error && response.result && response.result.isError !== true &&
    Array.isArray(blocks) && blocks.some(block => block?.type === 'text' && typeof block.text === 'string'));
}

function summarizeToolResponse(response) {
  return { succeeded: isSuccessfulToolResponse(response) };
}

function makeNoopPullRequestTracker() {
  return {
    start() {},
    close() {},
    snapshot() { return []; },
    refreshRepo() { return Promise.resolve([]); },
    refreshRepoFresh() { return Promise.resolve({ error: 'disabled' }); },
    refreshReviewGroups() { return Promise.resolve([]); },
    refreshAll() { return Promise.resolve([]); },
    mergeCandidate() { return null; },
  };
}

function makeNoopPullRequestMergeManager() {
  return {
    start() {},
    close() {},
    handleDetectedMerge() {},
    handleDetectedClose() {},
    checkReservations() {},
    setReviewSkip() { return Promise.resolve({ ok: false, status: 503 }); },
  };
}

function validateServerChildPaths(paths) {
  const expectedKeys = ['claudeHome', 'cockpitHome', 'root', 'userHome'];
  if (!paths || typeof paths !== 'object' || Array.isArray(paths) ||
    Object.keys(paths).sort().join(',') !== expectedKeys.join(',')) {
    throw new Error('invalid isolated server paths');
  }
  const root = resolveOutputDirectory(paths.root);
  const expected = {
    root,
    cockpitHome: path.join(root, 'cockpit'),
    claudeHome: path.join(root, 'claude'),
    userHome: path.join(root, 'user'),
  };
  for (const key of expectedKeys) {
    if (typeof paths[key] !== 'string' || path.resolve(paths[key]) !== expected[key]) {
      throw new Error('isolated server path escaped its dedicated output directory');
    }
  }
  assertNoSymlinkComponents(REPOSITORY_ROOT, root);
  for (const directory of [root, expected.cockpitHome, expected.claudeHome, expected.userHome]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('isolated server paths must be real directories');
  }
  return expected;
}

async function runServerChild(paths) {
  paths = validateServerChildPaths(paths);
  const { startServer } = require('../../src/server/server');
  const runtime = await startServer({
    homeDir: paths.cockpitHome,
    claudeHome: paths.claudeHome,
    userHome: paths.userHome,
    port: 0,
    pullRequestTracker: makeNoopPullRequestTracker(),
    pullRequestMergeManager: makeNoopPullRequestMergeManager(),
  });
  process.stdout.write(`${JSON.stringify({ type: 'ready' })}\n`);
  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    let request;
    try { request = JSON.parse(line); } catch { continue; }
    if (request?.type === 'stats') {
      const ids = Array.isArray(request.session_ids) ? request.session_ids.filter(isSafeIdentity).slice(0, 8) : [];
      const sessions = ids.map(sessionId => {
        const summary = runtime.state.planSummary(sessionId);
        const pullRequests = runtime.state.pullRequestRegistrations().filter(record => record.session_id === sessionId);
        return {
          session_id: sessionId,
          counts: {
            tasks: Array.isArray(summary.tasks) ? summary.tasks.length : 0,
            decisions: Array.isArray(summary.decisions) ? summary.decisions.length : 0,
            pull_requests: pullRequests.length,
          },
        };
      });
      process.stdout.write(`${JSON.stringify({ type: 'stats', sessions })}\n`);
    }
    if (request?.type === 'close') {
      input.close();
      break;
    }
  }
  await runtime.close();
  process.stdout.write(`${JSON.stringify({ type: 'closed' })}\n`);
}

function startServerProcess(paths, environment) {
  const child = spawn(process.execPath, [__filename, '--server-child', JSON.stringify(paths)], {
    cwd: REPOSITORY_ROOT,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  const messages = [];
  const waiters = [];
  let failed = false;
  lines.on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(message);
    else messages.push(message);
  });
  child.stderr.on('data', () => {});
  child.on('error', () => {
    failed = true;
    while (waiters.length) waiters.shift().reject(new Error('server child launch failed'));
  });
  child.on('close', () => {
    failed = true;
    while (waiters.length) waiters.shift().reject(new Error('server child exited'));
  });
  return {
    child,
    async receive(timeoutMs = RPC_TIMEOUT_MS) {
      if (messages.length) return messages.shift();
      if (failed) throw new Error('server child exited');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = waiters.indexOf(waiter);
          if (index >= 0) waiters.splice(index, 1);
          reject(new Error('server child timeout'));
        }, timeoutMs);
        const waiter = {
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); },
        };
        waiters.push(waiter);
      });
    },
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
  };
}

function startAppServer(executable, layout, environment) {
  const child = spawn(executable, ['app-server', '--stdio'], {
    cwd: layout.repo,
    env: environment,
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
      const waiter = pending.get(message.id);
      pending.delete(message.id);
      waiter.resolve(message);
    }
  });
  child.stderr.on('data', () => {});
  child.on('error', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('app-server launch failed'));
    pending.clear();
  });
  child.on('close', () => {
    for (const waiter of pending.values()) waiter.reject(new Error('app-server exited'));
    pending.clear();
  });
  return {
    child,
    rpc(method, params) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`app-server ${method} timed out`));
        }, RPC_TIMEOUT_MS);
        pending.set(id, {
          resolve(value) { clearTimeout(timer); resolve(value); },
          reject(error) { clearTimeout(timer); reject(error); },
        });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, error => {
          if (!error && pending.has(id)) return;
          if (pending.has(id)) {
            pending.get(id).reject(new Error(`app-server ${method} write failed`));
            pending.delete(id);
          }
        });
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
  };
}

async function waitForExit(child, timeoutMs = 3000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const wait = duration => Promise.race([
    new Promise(resolve => child.once('close', resolve)),
    new Promise(resolve => setTimeout(resolve, duration)),
  ]);
  await wait(timeoutMs);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill();
    await wait(2000);
  }
}

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('dedicated directory is not a real directory');
}

function prepareServerDirectories(outputDirectory) {
  const serverRoot = createServerDataRoot(outputDirectory);
  fs.mkdirSync(serverRoot, { recursive: false, mode: 0o700 });
  const paths = {
    root: serverRoot,
    cockpitHome: path.join(serverRoot, 'cockpit'),
    claudeHome: path.join(serverRoot, 'claude'),
    userHome: path.join(serverRoot, 'user'),
  };
  assertNoSymlinkComponents(REPOSITORY_ROOT, serverRoot);
  ensureDirectory(paths.cockpitHome);
  ensureDirectory(paths.claudeHome);
  ensureDirectory(paths.userHome);
  return paths;
}

function restoreConfig(configPath, original, installed) {
  const current = fs.readFileSync(configPath, 'utf8');
  if (current === original) return;
  if (current !== installed) throw new Error('dedicated config changed while the runner was active');
  replaceConfigAtomically(configPath, original);
}

function replaceConfigAtomically(configPath, contents) {
  const temporaryPath = `${configPath}.poc157-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryPath, configPath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function removeServerDirectories(paths, outputDirectory) {
  const root = path.resolve(paths.root);
  const output = path.resolve(outputDirectory);
  const relative = path.relative(output, root);
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('server data cleanup path escaped the selected output directory');
  }
  assertNoSymlinkComponents(REPOSITORY_ROOT, root);
  const stat = fs.lstatSync(root);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('server data cleanup target is not a real dedicated directory');
  }
  fs.rmSync(root, { recursive: true, force: false });
}

function outputFilePath(outputDirectory) {
  const file = path.join(outputDirectory, `existing-mcp-results-${new Date().toISOString().replace(/[-:.]/g, '')}.json`);
  assertNoSymlinkComponents(REPOSITORY_ROOT, file);
  return file;
}

function writeResult(filePath, result) {
  fs.writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

async function runExistingMcpProbe(options) {
  const { executable, layout } = validatePaths(options.codexPath, options.outputDirectory);
  const gitDirectory = path.join(layout.repo, '.git');
  const gitStat = fs.lstatSync(gitDirectory);
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) throw new Error('dedicated repository must contain a real .git directory');
  const configPath = path.join(layout.home, 'config.toml');
  const configStat = fs.lstatSync(configPath);
  if (!configStat.isFile() || configStat.isSymbolicLink()) throw new Error('dedicated Codex config must be a regular file');
  const originalConfig = fs.readFileSync(configPath, 'utf8');
  appendMcpServerConfig(originalConfig, `[mcp_servers.${MCP_SERVER_NAME}]`);
  const serverPaths = prepareServerDirectories(layout.output);
  const serverTable = renderMcpServerConfig(serverPaths);
  const installedConfig = appendMcpServerConfig(originalConfig, serverTable);
  const result = {
    version_verified: false,
    thread_ids: [],
    tool_calls: [],
    routing: null,
    success: false,
  };
  let configInstalled = false;
  let serverProcess = null;
  let app = null;
  let serverClosed = false;
  let cleanupFailure = false;
  try {
    replaceConfigAtomically(configPath, installedConfig);
    configInstalled = true;
    serverProcess = startServerProcess(serverPaths, makeChildEnvironment(options.environment || process.env, layout.home));
    const ready = await serverProcess.receive();
    if (ready?.type !== 'ready') throw new Error('isolated Cockpit server did not start');

    app = startAppServer(executable, layout, makeChildEnvironment(options.environment || process.env, layout.home));
    const initialized = await app.rpc('initialize', {
      clientInfo: { name: 'agent_cockpit_poc157_existing_mcp', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    if (initialized.error) throw new Error('app-server initialize failed');
    const userAgent = initialized.result && initialized.result.userAgent;
    buildRunMetadata(userAgent);
    result.version_verified = true;
    app.notify('initialized', {});

    for (let index = 0; index < 2; index += 1) {
      const started = await app.rpc('thread/start', {
        cwd: layout.repo,
        ephemeral: true,
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
      });
      const threadId = started.result?.thread?.id;
      if (started.error || !isSafeIdentity(threadId)) throw new Error('thread/start returned no safe thread ID');
      result.thread_ids.push(threadId);

      const calls = [
        {
          tool: 'cockpit_set_tasks',
          arguments: { tasks: [{ title: `fixture-task-${index}`, state: 'doing', criteria: [{ text: 'fixture criterion', met: false }] }] },
        },
        {
          tool: 'cockpit_add_decision',
          arguments: {
            title: `fixture-decision-${index}`,
            context: 'fixture context',
            state: 'waiting',
            options: [{ label: 'fixture option', description: 'fixture description', recommended: true }],
          },
        },
        { tool: 'cockpit_add_pr', arguments: { url: FIXTURE_PR_URLS[index] } },
      ];
      for (const call of calls) {
        const response = await app.rpc('mcpServer/tool/call', {
          threadId,
          server: MCP_SERVER_NAME,
          tool: call.tool,
          arguments: call.arguments,
          _meta: { threadId },
        });
        result.tool_calls.push({ thread_id: threadId, succeeded: summarizeToolResponse(response).succeeded });
      }
    }

    serverProcess.send({ type: 'stats', session_ids: [...result.thread_ids, SYNTHETIC_CLAUDE_SESSION_ID] });
    const rawStats = await serverProcess.receive();
    result.routing = summarizeRouting(result.thread_ids, rawStats);
    result.success = result.version_verified &&
      result.thread_ids.length === 2 && result.tool_calls.length === 6 &&
      result.tool_calls.every(call => call.succeeded) && result.routing.observed_legacy_routing_to_claude_id;
  } finally {
    if (app) {
      app.child.stdin.end();
      await waitForExit(app.child);
    }
    if (serverProcess) {
      try {
        serverProcess.send({ type: 'close' });
        const closed = await serverProcess.receive();
        serverClosed = closed?.type === 'closed';
        serverProcess.child.stdin.end();
        await waitForExit(serverProcess.child);
      } catch {
        serverProcess.child.kill();
        await waitForExit(serverProcess.child);
      }
    }
    if (configInstalled) {
      try { restoreConfig(configPath, originalConfig, installedConfig); } catch { cleanupFailure = true; }
    }
    if (serverClosed || serverProcess && (serverProcess.child.exitCode !== null || serverProcess.child.signalCode !== null)) {
      try { removeServerDirectories(serverPaths, layout.output); } catch { cleanupFailure = true; }
    } else {
      cleanupFailure = true;
    }
  }

  if (cleanupFailure) result.success = false;
  result.cleanup_succeeded = !cleanupFailure;
  const filePath = outputFilePath(layout.output);
  writeResult(filePath, result);
  return { filePath, result };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] === '--server-child') {
    let paths;
    try { paths = JSON.parse(args[1]); } catch { process.exitCode = 1; }
    if (paths) runServerChild(paths).catch(() => { process.stderr.write('server_child_failed\n'); process.exitCode = 1; });
  } else {
    try {
      runExistingMcpProbe(parseArguments(args)).then(({ filePath, result }) => {
        process.stdout.write(`${filePath}\n`);
        if (!result.success) process.exitCode = 1;
      }).catch(() => {
        process.stderr.write('existing_mcp_probe_failed\n');
        process.exitCode = 1;
      });
    } catch {
      process.stderr.write('invalid_existing_mcp_probe_arguments\n');
      process.exitCode = 1;
    }
  }
}

module.exports = {
  appendMcpServerConfig,
  createServerDataRoot,
  isSuccessfulToolResponse,
  parseArguments,
  renderMcpServerConfig,
  safeCounts,
  summarizeRouting,
  summarizeToolResponse,
  validateServerChildPaths,
};
