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
} = require('../../poc/codex-hooks-identity/setup');

const REQUEST_TIMEOUT_MS = 15_000;
const OUTPUT_FILE_NAME = 'readiness.json';
const QUESTION_TOOL_NAMES = [
  'cockpit_register_question',
  'cockpit_question_status',
  'cockpit_answer_poll',
];
const ENVIRONMENT_NAMES = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'COMSPEC', 'PROCESSOR_ARCHITECTURE',
];

function probeError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!['--codex-path', '--out'].includes(flag) || values.has(flag) || !argv[index + 1]) {
      throw probeError('invalid_arguments');
    }
    values.set(flag, argv[index + 1]);
    index += 1;
  }
  if (!values.has('--codex-path') || !values.has('--out')) throw probeError('invalid_arguments');
  return { codexPath: values.get('--codex-path'), outputDirectory: values.get('--out') };
}

function versionFromText(value) {
  if (typeof value !== 'string') return null;
  const match = value.match(/\b(\d+\.\d+\.\d+)\b/);
  return match ? match[1] : null;
}

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function prepareOutputDirectory(value) {
  const outputDirectory = resolveOutputDirectory(value, REPOSITORY_ROOT);
  const outputBase = path.join(REPOSITORY_ROOT, 'poc', 'out');
  assertNoSymlinkComponents(REPOSITORY_ROOT, outputBase);
  fs.mkdirSync(outputBase, { recursive: true });
  const baseStat = fs.lstatSync(outputBase);
  if (!baseStat.isDirectory() || baseStat.isSymbolicLink()) throw probeError('unsafe_output_base');
  assertNoSymlinkComponents(outputBase, outputDirectory);
  if (fs.existsSync(outputDirectory)) throw probeError('output_directory_exists');
  fs.mkdirSync(outputDirectory, { recursive: false, mode: 0o700 });
  const outputStat = fs.lstatSync(outputDirectory);
  if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) throw probeError('unsafe_output_directory');
  const homeRoot = path.join(outputDirectory, 'isolated-home');
  fs.mkdirSync(homeRoot, { recursive: false, mode: 0o700 });
  const homes = {
    root: homeRoot,
    codex: path.join(homeRoot, 'codex'),
    user: path.join(homeRoot, 'user'),
    appData: path.join(homeRoot, 'appdata'),
    localAppData: path.join(homeRoot, 'localappdata'),
    temp: path.join(homeRoot, 'temp'),
    cockpit: path.join(homeRoot, 'cockpit'),
  };
  for (const directory of Object.values(homes).slice(1)) {
    fs.mkdirSync(directory, { recursive: false, mode: 0o700 });
  }
  return { outputDirectory, outputFile: path.join(outputDirectory, OUTPUT_FILE_NAME), homes };
}

function makeChildEnvironment(parentEnvironment, homes, includeCockpitHome) {
  const environment = {};
  for (const name of ENVIRONMENT_NAMES) {
    if (typeof parentEnvironment[name] === 'string') environment[name] = parentEnvironment[name];
  }
  environment.CODEX_HOME = homes.codex;
  environment.USERPROFILE = homes.user;
  environment.APPDATA = homes.appData;
  environment.LOCALAPPDATA = homes.localAppData;
  environment.TEMP = homes.temp;
  environment.TMP = homes.temp;
  if (process.platform !== 'win32') environment.HOME = homes.user;
  if (includeCockpitHome) environment.AGENT_COCKPIT_HOME = homes.cockpit;
  return environment;
}

function validateCodexExecutable(value) {
  if (typeof value !== 'string' || value.trim() === '') throw probeError('codex_path_required');
  const executable = path.resolve(value);
  let stat;
  try { stat = fs.lstatSync(executable); } catch { throw probeError('codex_executable_unavailable'); }
  if (!stat.isFile() || stat.isSymbolicLink()) throw probeError('codex_executable_unavailable');
  return executable;
}

function runVersionCommand(executable, environment) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(executable, ['--version'], {
        cwd: REPOSITORY_ROOT,
        env: environment,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
    } catch { reject(probeError('codex_version_spawn_failed')); return; }
    let output = '';
    let oversized = false;
    const timer = setTimeout(() => {
      child.kill();
      reject(probeError('codex_version_timeout'));
    }, REQUEST_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => {
      if (output.length + chunk.length > 4096) {
        oversized = true;
        child.kill();
        return;
      }
      output += chunk.toString('utf8');
    });
    child.once('error', () => {
      clearTimeout(timer);
      reject(probeError('codex_version_spawn_failed'));
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      const version = versionFromText(output);
      if (oversized || code !== 0 || !version) {
        reject(probeError('codex_version_unavailable'));
        return;
      }
      resolve(version);
    });
  });
}

function startJsonRpcProcess(command, args, environment, label) {
  let child;
  try {
    child = spawn(command, args, {
      cwd: REPOSITORY_ROOT,
      env: environment,
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    });
  } catch { throw probeError(`${label}_spawn_failed`); }
  const pending = new Map();
  const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
  let nextId = 0;
  let closed = false;
  lines.on('line', (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (!message || !Object.hasOwn(message, 'id') || !pending.has(message.id)) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    clearTimeout(waiter.timer);
    waiter.resolve(message);
  });
  const rejectPending = () => {
    closed = true;
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(probeError(`${label}_process_closed`));
    }
    pending.clear();
  };
  child.once('error', rejectPending);
  child.once('close', rejectPending);

  function request(method, params) {
    if (closed) return Promise.reject(probeError(`${label}_process_closed`));
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(probeError(`${label}_request_timeout`));
      }, REQUEST_TIMEOUT_MS);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`, (error) => {
        if (!error || !pending.has(id)) return;
        clearTimeout(timer);
        pending.delete(id);
        reject(probeError(`${label}_request_write_failed`));
      });
    });
  }

  function notify(method, params) {
    if (closed) throw probeError(`${label}_process_closed`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
  }

  async function close() {
    if (child.exitCode === null && child.signalCode === null) {
      child.stdin.end();
      await waitForClose(child, 3_000);
    }
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
      await waitForClose(child, 2_000);
    }
    return child.exitCode !== null || child.signalCode !== null;
  }

  return { child, request, notify, close };
}

function waitForClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const onClose = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      child.removeListener('close', onClose);
      resolve(false);
    }, timeoutMs);
    child.once('close', onClose);
  });
}

function validateResponse(response, label) {
  if (!response || response.error || !response.result || typeof response.result !== 'object') {
    throw probeError(`${label}_response_invalid`);
  }
  return response.result;
}

async function inspectProductMcp(environment) {
  const wrapper = path.join(REPOSITORY_ROOT, 'poc', 'codex-questions', 'product-runtime-probe.js');
  const app = startJsonRpcProcess(process.execPath, [wrapper], environment, 'product_mcp');
  try {
    const initialized = validateResponse(await app.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'agent-cockpit-readiness-probe', version: '1.0.0' },
    }), 'product_mcp_initialize');
    app.notify('notifications/initialized', {});
    const listed = validateResponse(await app.request('tools/list', {}), 'product_mcp_tools_list');
    const tools = Array.isArray(listed.tools) ? listed.tools : [];
    const names = tools.map((tool) => tool?.name).filter((name) => typeof name === 'string').sort();
    const questionTools = names.filter((name) => QUESTION_TOOL_NAMES.includes(name));
    return {
      initialized: initialized.protocolVersion === '2025-06-18' && initialized.serverInfo?.name === 'agent-cockpit',
      protocolVersion: typeof initialized.protocolVersion === 'string' ? initialized.protocolVersion : null,
      serverName: typeof initialized.serverInfo?.name === 'string' ? initialized.serverInfo.name : null,
      serverVersion: typeof initialized.serverInfo?.version === 'string' ? initialized.serverInfo.version : null,
      toolCount: tools.length,
      questionTools,
      requiredQuestionToolsPresent: QUESTION_TOOL_NAMES.every((name) => questionTools.includes(name)),
    };
  } finally {
    if (!await app.close()) throw probeError('product_mcp_cleanup_failed');
  }
}

async function inspectCodex(executable, environment, expectedHome) {
  const binaryVersion = await runVersionCommand(executable, environment);
  const app = startJsonRpcProcess(executable, ['app-server', '--stdio'], environment, 'app_server');
  try {
    const initialized = validateResponse(await app.request('initialize', {
      clientInfo: { name: 'agent-cockpit-common-question-readiness', version: '1.0.0' },
      capabilities: { experimentalApi: false },
    }), 'app_server_initialize');
    app.notify('initialized', {});
    const userAgent = initialized.userAgent;
    const appServerVersion = versionFromText(userAgent);
    const fields = Object.keys(initialized).filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)).sort();
    const codexHomeMatches = typeof initialized.codexHome === 'string' &&
      path.resolve(initialized.codexHome).toLowerCase() === path.resolve(expectedHome).toLowerCase();
    return {
      binaryVersion,
      appServerInitialized: typeof userAgent === 'string' && appServerVersion !== null,
      appServerVersion,
      versionsMatch: appServerVersion === binaryVersion,
      codexHomeMatchesIsolatedHome: codexHomeMatches,
      platformFamilyPresent: typeof initialized.platformFamily === 'string',
      platformOsPresent: typeof initialized.platformOs === 'string',
      initializeResultFields: fields,
      reportedCapabilityFields: initialized.capabilities && typeof initialized.capabilities === 'object'
        ? Object.keys(initialized.capabilities).filter((key) => /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(key)).sort()
        : [],
    };
  } finally {
    if (!await app.close()) throw probeError('app_server_cleanup_failed');
  }
}

function removeIsolatedHome(homes, outputDirectory) {
  const homeRoot = path.resolve(homes.root);
  const outputRoot = path.resolve(outputDirectory);
  if (!isInside(outputRoot, homeRoot) || path.basename(homeRoot) !== 'isolated-home') {
    throw probeError('unsafe_cleanup_target');
  }
  assertNoSymlinkComponents(outputRoot, homeRoot);
  const stat = fs.lstatSync(homeRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw probeError('unsafe_cleanup_target');
  const realOutput = fs.realpathSync(outputRoot);
  const realHome = fs.realpathSync(homeRoot);
  if (!isInside(realOutput, realHome) || path.basename(realHome) !== 'isolated-home') {
    throw probeError('unsafe_cleanup_target');
  }
  fs.rmSync(homeRoot, { recursive: true, force: false });
}

async function runProbe(options) {
  const executable = validateCodexExecutable(options.codexPath);
  const prepared = prepareOutputDirectory(options.outputDirectory);
  const result = {
    schemaVersion: 1,
    runId: path.basename(prepared.outputDirectory),
    readiness: false,
    productMcp: null,
    codexAppServer: null,
    interactionBoundary: {
      loginAttempted: false,
      threadStartAttempted: false,
      turnStartAttempted: false,
      authenticatedToolCalls: 0,
      runtimeMetadataObserved: false,
      questionPoll: 'not_probed_auth_gate',
    },
    isolation: {
      normalHomeChanged: false,
      authFilesCopied: false,
      dedicatedHomeRemoved: false,
    },
    failure: null,
  };
  try {
    const codexEnvironment = makeChildEnvironment(process.env, prepared.homes, false);
    const productEnvironment = makeChildEnvironment(process.env, prepared.homes, true);
    result.productMcp = await inspectProductMcp(productEnvironment);
    result.codexAppServer = await inspectCodex(executable, codexEnvironment, prepared.homes.codex);
    result.readiness = result.productMcp.initialized && result.productMcp.requiredQuestionToolsPresent &&
      result.codexAppServer.appServerInitialized && result.codexAppServer.codexHomeMatchesIsolatedHome;
    if (!result.readiness) result.failure = 'readiness_contract_unavailable';
  } catch (error) {
    result.failure = /^[a-z0-9_]{1,64}$/.test(error?.code || '') ? error.code : 'probe_failed';
  }
  try {
    removeIsolatedHome(prepared.homes, prepared.outputDirectory);
    result.isolation.dedicatedHomeRemoved = true;
  } catch {
    result.failure = result.failure || 'isolated_home_cleanup_failed';
  }
  try {
    fs.writeFileSync(prepared.outputFile, `${JSON.stringify(result, null, 2)}\n`, {
      encoding: 'utf8', flag: 'wx', mode: 0o600,
    });
  } catch {
    result.failure = result.failure || 'result_write_failed';
    throw probeError(result.failure);
  }
  return { outputFile: prepared.outputFile, result };
}

async function main(argv) {
  let outputFile = null;
  try {
    const options = parseArguments(argv);
    const probe = await runProbe(options);
    outputFile = path.relative(REPOSITORY_ROOT, probe.outputFile).split(path.sep).join('/');
    process.stdout.write(`${JSON.stringify({ readiness: probe.result.readiness, outputFile })}\n`);
    if (!probe.result.readiness || !probe.result.isolation.dedicatedHomeRemoved) process.exitCode = 1;
  } catch (error) {
    process.stdout.write(`${JSON.stringify({ readiness: false, failure: error?.code || 'probe_failed', outputFile })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) void main(process.argv.slice(2));

module.exports = {
  makeChildEnvironment,
  parseArguments,
  runProbe,
  versionFromText,
};
