'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const readline = require('node:readline');
const {
  isSafeIdentity,
  parseFixturePullRequestUrl,
} = require('./mcp-probe');

const SERVER_NAME = 'poc164_native';
const FIXTURE_URL = 'https://github.com/poc164-fixture/agent-cockpit/pull/164';
const RPC_TIMEOUT_MS = 15000;
const APP_SERVER_CLOSE_TIMEOUT_MS = 3000;
const MCP_CLOSE_WAIT_MS = 3000;
const MAX_PROTOCOL_LINE_BYTES = 256 * 1024;
const MAX_STDOUT_BYTES = 4 * 1024 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const MAX_CAPTURE_BYTES = 1024 * 1024;
const CODEX_ID_ENV_NAMES = [
  'CODEX_THREAD_ID',
  'CODEX_SESSION_ID',
  'CODEX_AGENT_ID',
  'CODEX_TURN_ID',
];
const OS_ENV_NAMES = [
  'PATH',
  'PATHEXT',
  'SYSTEMROOT',
  'WINDIR',
  'SYSTEMDRIVE',
  'COMSPEC',
];
const VERSION_PATTERN = /\b(\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?)\b/;

class ProbeFailure extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--codex-path', '--out'].includes(option) ||
        values.has(option) ||
        typeof argv[index + 1] !== 'string' ||
        argv[index + 1].startsWith('--')) {
      throw new ProbeFailure('invalid_arguments');
    }
    values.set(option, argv[index + 1]);
    index += 1;
  }
  if (!values.has('--codex-path') || !values.has('--out')) {
    throw new ProbeFailure('invalid_arguments');
  }
  return {
    codexPath: values.get('--codex-path'),
    outputDirectory: values.get('--out'),
  };
}

function isWithinDirectory(root, target) {
  const relative = path.relative(root, target);
  return relative === '' ||
    (!path.isAbsolute(relative) &&
      relative !== '..' &&
      !relative.startsWith('..' + path.sep));
}

function assertNoSymlinkComponents(root, target) {
  const absoluteRoot = path.resolve(root);
  const absoluteTarget = path.resolve(target);
  if (!isWithinDirectory(absoluteRoot, absoluteTarget)) {
    throw new ProbeFailure('path_outside_repository');
  }
  const rootStat = fs.lstatSync(absoluteRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new ProbeFailure('repository_root_not_directory');
  }
  const relative = path.relative(absoluteRoot, absoluteTarget);
  if (!relative) return;
  let current = absoluteRoot;
  for (const component of relative.split(path.sep)) {
    current = path.join(current, component);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw new ProbeFailure('path_check_failed');
    }
    if (stat.isSymbolicLink()) throw new ProbeFailure('symlink_path_component');
  }
}

function validatePaths(codexPath, outputDirectory) {
  const repositoryRoot = fs.realpathSync(path.resolve(__dirname, '..', '..'));
  const outputRoot = path.join(repositoryRoot, 'poc', 'out');
  const output = path.isAbsolute(outputDirectory)
    ? path.resolve(outputDirectory)
    : path.resolve(repositoryRoot, outputDirectory);
  let outputRootStat;
  try {
    outputRootStat = fs.lstatSync(outputRoot);
  } catch {
    throw new ProbeFailure('poc_output_root_missing');
  }
  if (!outputRootStat.isDirectory() || outputRootStat.isSymbolicLink()) {
    throw new ProbeFailure('poc_output_root_invalid');
  }
  assertNoSymlinkComponents(repositoryRoot, outputRoot);
  assertNoSymlinkComponents(repositoryRoot, output);
  const relative = path.relative(outputRoot, output);
  if (!/^poc164-native-[A-Za-z0-9-]{1,54}$/.test(relative)) {
    throw new ProbeFailure('output_must_be_poc164_native_child');
  }

  const executable = path.resolve(codexPath);
  let executableStat;
  try {
    executableStat = fs.lstatSync(executable);
  } catch {
    throw new ProbeFailure('codex_executable_missing');
  }
  if (!executableStat.isFile() || executableStat.isSymbolicLink()) {
    throw new ProbeFailure('codex_executable_not_regular_file');
  }
  return { repositoryRoot, outputRoot, output, executable };
}

function makeLayout(output) {
  return {
    output,
    home: path.join(output, 'home'),
    repo: path.join(output, 'repo'),
    profile: path.join(output, 'profile'),
    appDataRoaming: path.join(output, 'profile', 'AppData', 'Roaming'),
    appDataLocal: path.join(output, 'profile', 'AppData', 'Local'),
    temp: path.join(output, 'temp'),
    capturePath: path.join(output, 'mcp-capture.jsonl'),
    configPath: path.join(output, 'home', 'config.toml'),
    resultPath: path.join(
      output,
      'native-results-' + new Date().toISOString().replace(/[-:.]/g, '') + '-' + crypto.randomUUID() + '.json',
    ),
  };
}

function createFreshOutputDirectory(directory) {
  try {
    fs.mkdirSync(directory);
  } catch (error) {
    if (error.code === 'EEXIST') throw new ProbeFailure('output_directory_already_exists');
    throw new ProbeFailure('output_directory_create_failed');
  }
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new ProbeFailure('output_directory_invalid');
  }
}

function makeChildEnvironment(parentEnvironment, layout) {
  const environment = {};
  for (const name of OS_ENV_NAMES) {
    if (typeof parentEnvironment[name] === 'string') environment[name] = parentEnvironment[name];
  }
  const root = path.parse(layout.profile).root;
  environment.HOME = layout.profile;
  environment.USERPROFILE = layout.profile;
  environment.HOMEDRIVE = root.length >= 2 ? root.slice(0, 2) : root;
  environment.HOMEPATH = layout.profile.slice(environment.HOMEDRIVE.length);
  environment.APPDATA = layout.appDataRoaming;
  environment.LOCALAPPDATA = layout.appDataLocal;
  environment.TEMP = layout.temp;
  environment.TMP = layout.temp;
  environment.CODEX_HOME = layout.home;
  return environment;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function buildMcpConfig(layout, nodePath = process.execPath, probePath = path.join(__dirname, 'mcp-probe.js')) {
  return [
    '[mcp_servers.' + SERVER_NAME + ']',
    'command = ' + tomlString(nodePath),
    'args = [' + tomlString(path.resolve(probePath)) + ']',
    'env = { POC164_OUTPUT_DIRECTORY = ' + tomlString(layout.output) +
      ', POC164_CAPTURE_PATH = ' + tomlString(layout.capturePath) + ' }',
    '',
  ].join('\n');
}

function initializeLayout(paths, parentEnvironment = process.env) {
  const layout = makeLayout(paths.output);
  createFreshOutputDirectory(layout.output);
  for (const directory of [
    layout.home,
    layout.repo,
    layout.profile,
    path.join(layout.profile, 'AppData'),
    layout.appDataRoaming,
    path.join(layout.profile, 'AppData', 'Local'),
    layout.temp,
  ]) {
    fs.mkdirSync(directory);
  }
  assertNoSymlinkComponents(paths.repositoryRoot, layout.output);
  const childEnvironment = makeChildEnvironment(parentEnvironment, layout);
  const git = spawnSync('git', ['init', '--quiet'], {
    cwd: layout.repo,
    env: childEnvironment,
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
  });
  if (git.error || git.status !== 0) throw new ProbeFailure('fixture_repository_init_failed');
  fs.writeFileSync(
    layout.configPath,
    buildMcpConfig(layout),
    { encoding: 'utf8', flag: 'wx', mode: 0o600 },
  );
  return { layout, childEnvironment };
}

function safeMetaKeys(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.keys(value)
    .filter(key => /^[A-Za-z][A-Za-z0-9_./-]{0,63}$/.test(key))
    .slice(0, 32)
    .sort();
}

function summarizeFixtureResponse(response, expectedThreadId, expectedPrKey) {
  if (response && response.error) {
    return {
      status: 'rpc_error',
      error_code: Number.isInteger(response.error.code) ? response.error.code : 'unknown',
    };
  }
  const result = response && response.result;
  if (!result || result.isError === true || !Array.isArray(result.content)) {
    return { status: result && result.isError === true ? 'tool_error' : 'invalid_result' };
  }
  const textBlock = result.content.find(block =>
    block && block.type === 'text' && typeof block.text === 'string');
  if (!textBlock) return { status: 'missing_text_result' };
  let fixtureResult;
  try {
    fixtureResult = JSON.parse(textBlock.text);
  } catch {
    return { status: 'invalid_fixture_json' };
  }
  const prKey = typeof fixtureResult.pr_key === 'string' &&
    /^[a-z0-9-]+\/[a-z0-9-]+#164$/.test(fixtureResult.pr_key)
    ? fixtureResult.pr_key
    : 'unknown';
  const metaThreadId = isSafeIdentity(fixtureResult.native_meta_thread_id)
    ? fixtureResult.native_meta_thread_id
    : 'unknown';
  if (fixtureResult.fixture !== 'poc164_native_fixture' || prKey !== expectedPrKey) {
    return { status: 'unexpected_fixture_result', pr_key: prKey };
  }
  return {
    status: 'ok',
    pr_key: prKey,
    registration: fixtureResult.registration === 'created' || fixtureResult.registration === 'duplicate'
      ? fixtureResult.registration
      : 'unknown',
    native_meta_thread_id: metaThreadId,
    native_meta_matches_started_thread: metaThreadId !== 'unknown'
      ? metaThreadId === expectedThreadId
      : null,
  };
}

function connectAppServer(executable, layout, environment, timeoutMs = RPC_TIMEOUT_MS) {
  const child = spawn(executable, ['app-server', '--stdio'], {
    cwd: layout.repo,
    env: environment,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const pending = new Map();
  let nextId = 0;
  let malformedOutputCount = 0;
  let stdoutByteCount = 0;
  let stderrByteCount = 0;
  let outputLimitExceeded = false;
  let closed = false;
  let closeInfo = null;
  const closedPromise = new Promise(resolve => {
    child.once('close', (code, signal) => {
      closed = true;
      closeInfo = { code, signal };
      for (const entry of pending.values()) entry.reject(new ProbeFailure('app_server_exited'));
      pending.clear();
      resolve(closeInfo);
    });
  });
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  child.stdout.on('data', chunk => {
    stdoutByteCount += chunk.length;
    if (stdoutByteCount > MAX_STDOUT_BYTES) stopForOutputLimit();
  });
  child.stderr.on('data', chunk => {
    stderrByteCount += chunk.length;
    if (stderrByteCount > MAX_STDERR_BYTES) stopForOutputLimit();
  });
  function stopForOutputLimit() {
    if (outputLimitExceeded) return;
    outputLimitExceeded = true;
    for (const entry of pending.values()) entry.reject(new ProbeFailure('app_server_output_limit_exceeded'));
    pending.clear();
    try {
      child.kill();
    } catch {
      outputLimitExceeded = true;
    }
  }

  lines.on('line', line => {
    if (Buffer.byteLength(line, 'utf8') > MAX_PROTOCOL_LINE_BYTES) {
      malformedOutputCount += 1;
      stopForOutputLimit();
      return;
    }
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      malformedOutputCount += 1;
      return;
    }
    if (message && Object.hasOwn(message, 'id') && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      entry.resolve(message);
    }
  });
  child.on('error', () => {
    for (const entry of pending.values()) entry.reject(new ProbeFailure('app_server_spawn_failed'));
    pending.clear();
  });

  return {
    child,
    get closed() { return closed; },
    get closeInfo() { return closeInfo; },
    get malformedOutputCount() { return malformedOutputCount; },
    get stdoutByteCount() { return stdoutByteCount; },
    get stderrByteCount() { return stderrByteCount; },
    get outputLimitExceeded() { return outputLimitExceeded; },
    closedPromise,
    rpc(method, params) {
      if (closed) return Promise.reject(new ProbeFailure('app_server_exited'));
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new ProbeFailure('rpc_timeout'));
        }, timeoutMs);
        pending.set(id, {
          resolve(message) {
            clearTimeout(timer);
            resolve(message);
          },
          reject(error) {
            clearTimeout(timer);
            reject(error);
          },
        });
        try {
          child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n', error => {
            if (!error || !pending.has(id)) return;
            const entry = pending.get(id);
            pending.delete(id);
            entry.reject(new ProbeFailure('rpc_write_failed'));
          });
        } catch {
          clearTimeout(timer);
          pending.delete(id);
          reject(new ProbeFailure('rpc_write_failed'));
        }
      });
    },
    notify(method, params) {
      if (!closed) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
    },
  };
}

function parseCaptureFile(capturePath, repositoryRoot, outputDirectory) {
  assertNoSymlinkComponents(repositoryRoot, outputDirectory);
  assertNoSymlinkComponents(repositoryRoot, capturePath);
  if (path.dirname(path.resolve(capturePath)) !== path.resolve(outputDirectory)) {
    throw new ProbeFailure('capture_path_outside_output');
  }
  if (!fs.existsSync(capturePath)) return { records: [], invalidLineCount: 0, sizeExceeded: false };
  const stat = fs.lstatSync(capturePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new ProbeFailure('capture_target_invalid');
  if (stat.size > MAX_CAPTURE_BYTES) {
    return { records: [], invalidLineCount: 1, sizeExceeded: true };
  }
  const records = [];
  let invalidLineCount = 0;
  for (const line of fs.readFileSync(capturePath, 'utf8').split(/\r?\n/)) {
    if (!line) continue;
    let value;
    try {
      value = JSON.parse(line);
    } catch {
      invalidLineCount += 1;
      continue;
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      invalidLineCount += 1;
      continue;
    }
    if (value.type === 'started' && Number.isSafeInteger(value.pid) && value.pid > 0) {
      records.push({
        type: 'started',
        pid: value.pid,
        parent_pid: Number.isSafeInteger(value.parent_pid) ? value.parent_pid : null,
      });
      continue;
    }
    if (value.type === 'stdin_closed' && Number.isSafeInteger(value.pid) && value.pid > 0) {
      records.push({
        type: 'stdin_closed',
        pid: value.pid,
        call_count: Number.isSafeInteger(value.call_count) ? value.call_count : null,
      });
      continue;
    }
    if (value.type === 'process_exit' && Number.isSafeInteger(value.pid) && value.pid > 0) {
      records.push({
        type: 'process_exit',
        pid: value.pid,
        exit_code: Number.isInteger(value.exit_code) ? value.exit_code : null,
      });
      continue;
    }
    if (value.type === 'tool_call' &&
        typeof value.pr_key === 'string' &&
        /^[a-z0-9-]+\/[a-z0-9-]+#164$/.test(value.pr_key)) {
      const metaThreadId = isSafeIdentity(value.native_meta_thread_id)
        ? value.native_meta_thread_id
        : 'unknown';
      const metaKeys = safeMetaKeys(Array.isArray(value.meta_keys)
        ? Object.fromEntries(value.meta_keys.map(key => [key, true]))
        : {});
      const codexEnvironmentIds = {};
      for (const name of CODEX_ID_ENV_NAMES) {
        codexEnvironmentIds[name] = Boolean(
          value.codex_environment_ids_present &&
          value.codex_environment_ids_present[name] === true,
        );
      }
      records.push({
        type: 'tool_call',
        tool: value.tool === 'cockpit_add_pr' ? value.tool : 'unknown',
        pr_key: value.pr_key,
        native_meta_thread_id: metaThreadId,
        meta_keys: metaKeys,
        codex_environment_ids_present: codexEnvironmentIds,
        registration: value.registration === 'created' || value.registration === 'duplicate'
          ? value.registration
          : 'unknown',
        unique_native_sources_for_fixture_pr: Number.isSafeInteger(value.unique_native_sources_for_fixture_pr)
          ? value.unique_native_sources_for_fixture_pr
          : null,
      });
      continue;
    }
    invalidLineCount += 1;
  }
  return { records, invalidLineCount, sizeExceeded: false };
}

function summarizeCapture(records) {
  const starts = records.filter(record => record.type === 'started');
  const closes = records.filter(record => record.type === 'stdin_closed');
  const exits = records.filter(record => record.type === 'process_exit');
  const calls = records.filter(record => record.type === 'tool_call');
  const byPullRequest = new Map();
  for (const call of calls) {
    const entry = byPullRequest.get(call.pr_key) || {
      calls: 0,
      sources: new Set(),
      metaUnknownCount: 0,
      statuses: [],
    };
    entry.calls += 1;
    if (call.native_meta_thread_id === 'unknown') entry.metaUnknownCount += 1;
    else entry.sources.add(call.native_meta_thread_id);
    entry.statuses.push(call.registration);
    byPullRequest.set(call.pr_key, entry);
  }
  const pullRequests = [...byPullRequest.entries()].map(([key, value]) => ({
    pr_key: key,
    call_count: value.calls,
    distinct_native_meta_thread_ids: value.sources.size,
    missing_native_meta_thread_id_count: value.metaUnknownCount,
    fixture_process_registration_statuses: value.statuses,
  }));
  return {
    mcp_process_start_count: starts.length,
    mcp_process_stdin_close_count: closes.length,
    mcp_process_exit_event_count: exits.length,
    mcp_process_pids: [...new Set(starts.map(record => record.pid))],
    tool_call_count: calls.length,
    distinct_pr_count: byPullRequest.size,
    pull_requests: pullRequests,
    same_pr_multiple_native_threads_observed: pullRequests.some(pr =>
      pr.call_count > 1 && pr.distinct_native_meta_thread_ids > 1),
  };
}

function isProcessRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH' || error.code === 'EINVAL') return false;
    return null;
  }
}

function verifyMcpProcessExits(records, isRunning = isProcessRunning) {
  const pids = [...new Set(records
    .filter(record => record.type === 'started')
    .map(record => record.pid))];
  const exitPids = new Set(records
    .filter(record => record.type === 'process_exit')
    .map(record => record.pid));
  const processes = pids.map(pid => {
    const running = isRunning(pid);
    const exited = running === false;
    return {
      pid,
      exit_confirmed: exited,
      process_exit_event_observed: exitPids.has(pid),
      evidence: exited
        ? exitPids.has(pid) ? 'process_exit_and_pid_not_running' : 'pid_not_running'
        : running === true ? 'pid_still_running' : 'pid_status_unknown',
    };
  });
  return {
    processes,
    started_count: processes.length,
    exit_confirmed_count: processes.filter(item => item.exit_confirmed).length,
    all_exit_confirmed: processes.length > 0 && processes.every(item => item.exit_confirmed),
  };
}

function summarizeRun(output, captured, processExits) {
  const calls = output.calls;
  const successfulCallCount = calls.filter(call => call.result.status === 'ok').length;
  const allNativeIdsMatch = calls.length > 0 && calls.every(call =>
    call.result.status === 'ok' && call.result.native_meta_matches_started_thread === true);
  const capture = summarizeCapture(captured.records);
  return {
    direct_rpc_calls: calls.length,
    successful_fixture_calls: successfulCallCount,
    native_meta_thread_id_matches_started_thread: allNativeIdsMatch,
    capture,
    process_exits: processExits,
    source_relationship: {
      independent_top_level_threads_distinguishable: capture.same_pr_multiple_native_threads_observed,
      parent_or_agent_relationship_observed: false,
      claude_origin_observed: false,
    },
    deduplication: {
      production_cockpit_deduplication_tested: false,
      fixture_pr_keys_aggregated_across_captured_calls: capture.distinct_pr_count,
      note: 'MCPプロセス内のfixture状態ではCockpit共有の重複排除を示せない。',
    },
  };
}

function safeVersion(userAgent) {
  if (typeof userAgent !== 'string') return null;
  const match = VERSION_PATTERN.exec(userAgent);
  return match ? match[1] : null;
}

function makeInitialResult(paths, layout) {
  const fixturePullRequest = parseFixturePullRequestUrl(FIXTURE_URL);
  return {
    evidence_type: 'direct_app_server_rpc_to_synthetic_mcp_fixture',
    codex_executable: path.basename(paths.executable),
    isolated_home: layout.home,
    mcp_server_name: SERVER_NAME,
    fixture_pull_request: fixturePullRequest && fixturePullRequest.key,
    configuration_is_fixture_only: true,
    model_was_invoked: false,
    calls: [],
    mcp_server_call_attempted: false,
    mcp_server_call_attempt_count: 0,
    app_server_version: null,
    app_server_initialize_succeeded: false,
    capture_invalid_line_count: 0,
    capture_size_exceeded: false,
    cleanup: {
      app_server_closed: false,
      app_server_forced: false,
      app_server_exit_code: null,
      app_server_signal: null,
      mcp_process_stdin_close_count: 0,
      mcp_process_exit_confirmed_count: 0,
      mcp_all_processes_exit_confirmed: false,
      isolated_home_auth_status: 'not_checked',
      isolated_home_auth_cleanup_succeeded: false,
      dedicated_temp_removed: false,
      output_limit_exceeded: false,
      stdout_byte_count: 0,
      stderr_byte_count: 0,
    },
    summary: null,
    success: false,
    failure_code: null,
  };
}

function waitFor(promise, timeoutMs) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve({ completed: false, value: null }), timeoutMs);
    promise.then(value => {
      clearTimeout(timer);
      resolve({ completed: true, value });
    });
  });
}

async function closeAppServer(app) {
  if (!app) return { closed: false, forced: false, exitCode: null, signal: null };
  if (!app.closed) {
    try {
      app.child.stdin.end();
    } catch {
    }
  }
  let waited = await waitFor(app.closedPromise, APP_SERVER_CLOSE_TIMEOUT_MS);
  let forced = false;
  if (!waited.completed && !app.closed) {
    forced = true;
    try {
      app.child.kill();
    } catch {
      return { closed: false, forced, exitCode: null, signal: null };
    }
    waited = await waitFor(app.closedPromise, APP_SERVER_CLOSE_TIMEOUT_MS);
  }
  return {
    closed: waited.completed,
    forced,
    exitCode: waited.completed && Number.isInteger(waited.value.code) ? waited.value.code : null,
    signal: waited.completed && typeof waited.value.signal === 'string' ? waited.value.signal : null,
  };
}

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

async function waitForMcpExit(capturePath, repositoryRoot, outputDirectory) {
  const deadline = Date.now() + MCP_CLOSE_WAIT_MS;
  let captured = { records: [], invalidLineCount: 0, sizeExceeded: false };
  let exits = verifyMcpProcessExits(captured.records);
  do {
    captured = parseCaptureFile(capturePath, repositoryRoot, outputDirectory);
    exits = verifyMcpProcessExits(captured.records);
    if (exits.all_exit_confirmed || exits.started_count === 0) break;
    await delay(50);
  } while (Date.now() < deadline);
  return { captured, exits };
}

function cleanupDedicatedFiles(paths, layout, mcpProcessesExited) {
  const result = {
    isolated_home_auth_status: 'not_checked',
    isolated_home_auth_cleanup_succeeded: false,
    dedicated_temp_removed: false,
  };
  if (!mcpProcessesExited) {
    result.isolated_home_auth_status = 'skipped_process_exit_unverified';
    return result;
  }

  const authPath = path.join(layout.home, 'auth.json');
  assertNoSymlinkComponents(paths.repositoryRoot, layout.home);
  assertNoSymlinkComponents(paths.repositoryRoot, authPath);
  if (fs.existsSync(authPath)) {
    const authStat = fs.lstatSync(authPath);
    if (!authStat.isFile() || authStat.isSymbolicLink()) {
      result.isolated_home_auth_status = 'invalid_target';
      return result;
    }
    fs.unlinkSync(authPath);
    result.isolated_home_auth_status = 'removed';
  } else {
    result.isolated_home_auth_status = 'not_present';
  }
  result.isolated_home_auth_cleanup_succeeded = !fs.existsSync(authPath);

  const expectedTemp = path.join(layout.output, 'temp');
  if (path.resolve(expectedTemp) !== path.resolve(layout.temp) ||
      !isWithinDirectory(layout.output, layout.temp)) {
    result.dedicated_temp_removed = false;
    return result;
  }
  assertNoSymlinkComponents(paths.repositoryRoot, layout.output);
  assertNoSymlinkComponents(paths.repositoryRoot, layout.temp);
  if (fs.existsSync(layout.temp)) {
    const tempStat = fs.lstatSync(layout.temp);
    if (!tempStat.isDirectory() || tempStat.isSymbolicLink()) return result;
    fs.rmSync(layout.temp, { recursive: true });
  }
  result.dedicated_temp_removed = !fs.existsSync(layout.temp);
  return result;
}

function writeResult(result, filePath) {
  fs.writeFileSync(filePath, JSON.stringify(result, null, 2) + '\n', {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

async function runNativeProbe(options) {
  const paths = validatePaths(options.codexPath, options.outputDirectory);
  const { layout, childEnvironment } = initializeLayout(paths, options.environment || process.env);
  const output = makeInitialResult(paths, layout);
  let app = null;
  let failureCode = null;
  try {
    app = connectAppServer(paths.executable, layout, childEnvironment, options.timeoutMs || RPC_TIMEOUT_MS);
    const initialized = await app.rpc('initialize', {
      clientInfo: { name: 'agent_cockpit_poc164_native', version: '0.1.0' },
      capabilities: { experimentalApi: true },
    });
    if (initialized.error || !initialized.result) throw new ProbeFailure('app_server_initialize_failed');
    output.app_server_initialize_succeeded = true;
    output.app_server_version = safeVersion(initialized.result.userAgent);
    app.notify('initialized', {});

    const fixturePullRequest = parseFixturePullRequestUrl(FIXTURE_URL);
    if (!fixturePullRequest) throw new ProbeFailure('fixture_url_invalid');
    for (let index = 0; index < 2; index += 1) {
      const started = await app.rpc('thread/start', {
        cwd: layout.repo,
        ephemeral: true,
        approvalPolicy: 'on-request',
        sandbox: 'read-only',
      });
      const threadId = started.result && started.result.thread && started.result.thread.id;
      if (started.error || !isSafeIdentity(threadId)) throw new ProbeFailure('thread_start_failed');
      output.mcp_server_call_attempted = true;
      output.mcp_server_call_attempt_count += 1;
      const call = {
        harness_thread: 'independent_codex_' + (index + 1),
        started_thread_id: threadId,
        result: { status: 'pending' },
      };
      output.calls.push(call);
      try {
        const response = await app.rpc('mcpServer/tool/call', {
          threadId,
          server: SERVER_NAME,
          tool: 'cockpit_add_pr',
          arguments: { url: FIXTURE_URL },
        });
        call.result = summarizeFixtureResponse(response, threadId, fixturePullRequest.key);
      } catch (error) {
        call.result = {
          status: 'rpc_failed',
          failure_code: error instanceof ProbeFailure ? error.code : 'rpc_failed',
        };
        throw error;
      }
    }
  } catch (error) {
    failureCode = error instanceof ProbeFailure ? error.code : 'native_probe_failed';
  }

  const appClose = await closeAppServer(app);
  output.cleanup.app_server_closed = appClose.closed;
  output.cleanup.app_server_forced = appClose.forced;
  output.cleanup.app_server_exit_code = appClose.exitCode;
  output.cleanup.app_server_signal = appClose.signal;
  output.cleanup.output_limit_exceeded = Boolean(app && app.outputLimitExceeded);
  output.cleanup.stdout_byte_count = app ? app.stdoutByteCount : 0;
  output.cleanup.stderr_byte_count = app ? app.stderrByteCount : 0;

  let captured = { records: [], invalidLineCount: 0, sizeExceeded: false };
  let processExits = {
    processes: [],
    started_count: 0,
    exit_confirmed_count: 0,
    all_exit_confirmed: false,
  };
  try {
    const waited = await waitForMcpExit(layout.capturePath, paths.repositoryRoot, layout.output);
    captured = waited.captured;
    processExits = waited.exits;
  } catch (error) {
    if (!failureCode) failureCode = error instanceof ProbeFailure ? error.code : 'capture_read_failed';
  }
  output.capture_invalid_line_count = captured.invalidLineCount;
  output.capture_size_exceeded = captured.sizeExceeded;
  output.cleanup.mcp_process_stdin_close_count = captured.records.filter(record =>
    record.type === 'stdin_closed').length;
  output.cleanup.mcp_process_exit_confirmed_count = processExits.exit_confirmed_count;
  output.cleanup.mcp_all_processes_exit_confirmed = processExits.all_exit_confirmed;

  const safeToCleanDedicatedFiles = appClose.closed && !appClose.forced &&
    (processExits.all_exit_confirmed ||
      (!output.mcp_server_call_attempted &&
        !captured.sizeExceeded &&
        captured.invalidLineCount === 0 &&
        captured.records.length === 0));
  try {
    const privateCleanup = cleanupDedicatedFiles(paths, layout, safeToCleanDedicatedFiles);
    Object.assign(output.cleanup, privateCleanup);
  } catch {
    output.cleanup.isolated_home_auth_status = 'cleanup_failed';
    output.cleanup.isolated_home_auth_cleanup_succeeded = false;
    output.cleanup.dedicated_temp_removed = false;
  }

  output.summary = summarizeRun(output, captured, processExits);
  const callsSucceeded = output.calls.length === 2 &&
    output.calls.every(call => call.result.status === 'ok');
  const cleanupSucceeded = output.cleanup.app_server_closed &&
    !output.cleanup.app_server_forced &&
    output.cleanup.mcp_all_processes_exit_confirmed &&
    output.cleanup.isolated_home_auth_cleanup_succeeded &&
    output.cleanup.dedicated_temp_removed;
  output.success = output.app_server_initialize_succeeded &&
    output.app_server_version !== null &&
    callsSucceeded &&
    output.summary.native_meta_thread_id_matches_started_thread &&
    output.summary.capture.tool_call_count === 2 &&
    cleanupSucceeded &&
    !output.cleanup.output_limit_exceeded &&
    !output.capture_size_exceeded &&
    captured.invalidLineCount === 0;
  output.failure_code = output.success ? null :
    failureCode ||
    (!output.cleanup.mcp_all_processes_exit_confirmed
      ? 'mcp_process_exit_unverified'
      : !cleanupSucceeded
        ? 'cleanup_unverified'
        : 'native_metadata_not_confirmed');

  writeResult(output, layout.resultPath);
  return { resultPath: layout.resultPath, result: output };
}

if (require.main === module) {
  let options;
  try {
    options = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write((error instanceof ProbeFailure ? error.code : 'invalid_arguments') + '\n');
    process.exitCode = 2;
  }
  if (options) {
    runNativeProbe(options)
      .then(({ resultPath, result }) => {
        process.stdout.write(JSON.stringify({
          result_path: resultPath,
          success: result.success,
          failure_code: result.failure_code,
          app_server_version: result.app_server_version,
        }) + '\n');
        if (!result.success) process.exitCode = 1;
      })
      .catch(error => {
        process.stderr.write((error instanceof ProbeFailure ? error.code : 'native_probe_failed') + '\n');
        process.exitCode = 1;
      });
  }
}

module.exports = {
  assertNoSymlinkComponents,
  buildMcpConfig,
  isWithinDirectory,
  makeChildEnvironment,
  makeLayout,
  parseArguments,
  parseCaptureFile,
  safeVersion,
  summarizeCapture,
  summarizeRun,
  summarizeFixtureResponse,
  validatePaths,
  verifyMcpProcessExits,
};
