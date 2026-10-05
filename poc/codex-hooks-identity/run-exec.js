'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { StringDecoder } = require('node:string_decoder');
const { spawn } = require('node:child_process');
const {
  assertNoSymlinkComponents,
  makeLayout,
  resolveOutputDirectory,
} = require('./setup');
const { isSafeIdentity } = require('./mcp-probe');
const { sanitizeProbe } = require('./run-rpc');
const { createFixtureServer } = require('./runtime-fixture');

const REQUIRED_CODEX_VERSION = '0.160.0';
const FIXTURE_MODEL = 'poc157-fixture-model';
const FIXTURE_TOOL = 'mcp__poc157_identity.probe_identity';
const FIXTURE_FINAL_TEXT = 'ローカルfixtureの固定シナリオが完了しました。実モデルや実APIの観測結果ではありません。';
const EXEC_TIMEOUT_MS = 40000;
const VERSION_TIMEOUT_MS = 10000;
const MAX_EVENT_LINE_CHARS = 2 * 1024 * 1024;
const MAX_EVENT_SUMMARIES = 512;
const MAX_PROBE_RESULTS = 16;
const RUNTIME_HOME_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OS_ENVIRONMENT = [
  'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'SYSTEMDRIVE', 'PROGRAMDATA',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'COMSPEC',
];
const EVENT_STATUSES = new Set([
  'queued', 'started', 'in_progress', 'running', 'completed', 'succeeded', 'failed', 'errored',
  'error', 'cancelled', 'incomplete', 'unknown',
]);

function usage() {
  return 'Usage: node run-exec.js --codex-path <codex.exe> --out poc/out/<slug> [--start-with command|mcp] [--serve]';
}

function parseArguments(argv) {
  const values = new Map();
  let serve = false;
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === '--serve') {
      if (serve) throw new Error(usage());
      serve = true;
      continue;
    }
    if (!['--codex-path', '--out', '--start-with'].includes(option) || values.has(option) || !argv[index + 1]) {
      throw new Error(usage());
    }
    values.set(option, argv[index + 1]);
    index += 1;
  }
  if (!values.has('--codex-path') || !values.has('--out')) throw new Error(usage());
  const startWith = values.get('--start-with');
  if (startWith !== undefined && !['command', 'mcp'].includes(startWith)) throw new Error(usage());
  const parsed = {
    codexPath: values.get('--codex-path'),
    outputDirectory: values.get('--out'),
    serve,
  };
  if (startWith !== undefined) parsed.startWith = startWith;
  return parsed;
}

function makeChildEnvironment(parentEnvironment, home) {
  const environment = {};
  for (const name of OS_ENVIRONMENT) {
    if (typeof parentEnvironment[name] === 'string') environment[name] = parentEnvironment[name];
  }
  environment.CODEX_HOME = home;
  return environment;
}

function execArguments(layout, startWith = 'command') {
  const instruction = startWith === 'mcp'
    ? 'Run only the available MCP identity probe, then finish the local fixture scenario.'
    : 'Run the available exec command and MCP identity probe, then finish the local fixture scenario.';
  return [
    '--no-daemon', 'exec', '--json', '--ephemeral', '-C', layout.repo, '-s', 'read-only',
    instruction,
  ];
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
  const configPath = path.join(layout.home, 'config.toml');
  const hooksPath = path.join(layout.home, 'hooks.json');
  for (const filePath of [configPath, hooksPath]) {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Dedicated Codex configuration files must be regular files');
  }
  const gitPath = path.join(layout.repo, '.git');
  const gitStat = fs.lstatSync(gitPath);
  if (!gitStat.isDirectory() || gitStat.isSymbolicLink()) throw new Error('PoC repository must be a dedicated Git repository');
  const executable = path.resolve(codexPath);
  const executableStat = fs.lstatSync(executable);
  if (!executableStat.isFile() || executableStat.isSymbolicLink()) throw new Error('--codex-path must name a regular executable file');
  return { executable, layout, configPath };
}

function readRegularFile(filePath, message) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(message);
  return fs.readFileSync(filePath);
}

function assertRuntimeHome(output, home, configPath) {
  const outputPath = resolveOutputDirectory(output);
  const runtimeHomes = path.join(outputPath, 'runtime-homes');
  const isolatedHome = path.resolve(home);
  const relativeHome = path.relative(runtimeHomes, isolatedHome);
  if (!RUNTIME_HOME_ID_PATTERN.test(relativeHome) || path.isAbsolute(relativeHome)) {
    throw new Error('Isolated Codex home must be a direct runtime-homes child');
  }
  const repositoryRoot = fs.realpathSync(path.resolve(__dirname, '..', '..'));
  assertNoSymlinkComponents(repositoryRoot, outputPath);
  assertNoSymlinkComponents(outputPath, isolatedHome);
  for (const directory of [runtimeHomes, isolatedHome]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Isolated Codex home path must contain real directories');
  }
  if (configPath && path.resolve(configPath) !== path.join(isolatedHome, 'config.toml')) {
    throw new Error('Fixture config cleanup is restricted to the isolated Codex home');
  }
  return { output: outputPath, home: isolatedHome, configPath: path.join(isolatedHome, 'config.toml') };
}

function createRuntimeHome(sourceLayout) {
  const output = resolveOutputDirectory(sourceLayout.output);
  const repositoryRoot = fs.realpathSync(path.resolve(__dirname, '..', '..'));
  assertNoSymlinkComponents(repositoryRoot, output);
  if (path.resolve(sourceLayout.home) !== path.join(output, 'home') ||
    path.resolve(sourceLayout.repo) !== path.join(output, 'repo')) {
    throw new Error('Source home and repository must be the selected PoC output directories');
  }
  for (const directory of [sourceLayout.home, sourceLayout.repo]) {
    const stat = fs.lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('PoC home and repository must be real directories');
  }
  const sourceConfigPath = path.join(sourceLayout.home, 'config.toml');
  const sourceHooksPath = path.join(sourceLayout.home, 'hooks.json');
  const files = [
    { name: 'config.toml', contents: readRegularFile(sourceConfigPath, 'Dedicated config must be a regular file') },
    { name: 'hooks.json', contents: readRegularFile(sourceHooksPath, 'Dedicated hooks config must be a regular file') },
  ];
  const runtimeHomes = path.join(output, 'runtime-homes');
  assertNoSymlinkComponents(repositoryRoot, runtimeHomes);
  try {
    fs.mkdirSync(runtimeHomes, { mode: 0o700 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const runtimeHomesStat = fs.lstatSync(runtimeHomes);
  if (!runtimeHomesStat.isDirectory() || runtimeHomesStat.isSymbolicLink()) {
    throw new Error('Runtime homes directory must be a real directory');
  }
  const home = path.join(runtimeHomes, randomUUID());
  fs.mkdirSync(home, { mode: 0o700 });
  assertNoSymlinkComponents(output, home);
  for (const file of files) {
    fs.writeFileSync(path.join(home, file.name), file.contents, { flag: 'wx', mode: 0o600 });
  }
  return {
    ...sourceLayout,
    output,
    sourceHome: sourceLayout.home,
    home,
    configPath: path.join(home, 'config.toml'),
    hooksPath: path.join(home, 'hooks.json'),
  };
}

function splitConfigSections(configText) {
  const rootLines = [];
  const tables = [];
  let currentTable = null;
  for (const line of configText.split(/\r?\n/)) {
    const table = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
    if (table) {
      currentTable = { name: table[1], lines: [line] };
      tables.push(currentTable);
    } else if (currentTable) {
      currentTable.lines.push(line);
    } else {
      rootLines.push(line);
    }
  }
  return { rootLines, tables };
}

function normalizeTrailingBlankLines(lines) {
  const normalized = [...lines];
  while (normalized.length > 1 && normalized.at(-1).trim() === '' && normalized.at(-2).trim() === '') normalized.pop();
  return normalized;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function replaceConfigAtomically(configPath, expectedContents, nextContents) {
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Dedicated config must be a regular file');
  if (fs.readFileSync(configPath, 'utf8') !== expectedContents) {
    throw new Error('Dedicated config changed while the fixture was being prepared');
  }
  const temporaryPath = `${configPath}.poc157-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, nextContents, { encoding: 'utf8', flag: 'wx', mode: stat.mode & 0o777 });
    fs.renameSync(temporaryPath, configPath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function configureFixture(layout, configPath, fixture) {
  const isolated = assertRuntimeHome(layout.output, layout.home, configPath);
  const current = fs.readFileSync(configPath, 'utf8');
  if (!/^\[mcp_servers\.poc157_identity\]\s*$/m.test(current)) {
    throw new Error('Dedicated config is missing the poc157_identity MCP server table');
  }
  const { rootLines, tables } = splitConfigSections(current);
  const preservedRoot = normalizeTrailingBlankLines(rootLines.filter(line => !/^\s*(?:model|model_provider)\s*=/.test(line)));
  const preservedTables = tables.filter(table => table.name !== 'model_providers.poc157_fixture')
    .flatMap(table => table.lines);
  const headerValue = fixture.requestHeaders['X-Poc157-Token'];
  if (!isSafeIdentity(headerValue) || !fixture.baseUrl) throw new Error('Local fixture did not expose safe connection details');
  const provider = [
    `model = ${tomlString(FIXTURE_MODEL)}`,
    'model_provider = "poc157_fixture"',
    '',
    '[model_providers.poc157_fixture]',
    'name = "Local deterministic fixture"',
    `base_url = ${tomlString(fixture.baseUrl)}`,
    'wire_api = "responses"',
    `http_headers = { "X-Poc157-Token" = ${tomlString(headerValue)} }`,
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n');
  const contents = [...preservedRoot, ...provider.trimEnd().split('\n'), ...preservedTables].join('\n');
  replaceConfigAtomically(configPath, current, contents);
  return {
    sourceHome: layout.sourceHome,
    home: isolated.home,
    repo: layout.repo,
    configSnapshot: {
      output: isolated.output,
      isolatedHome: isolated.home,
      configPath: isolated.configPath,
      originalConfig: current,
      appliedConfig: contents,
    },
  };
}

function clearFixtureConfig(configPath, configSnapshot) {
  if (!configSnapshot || typeof configSnapshot.originalConfig !== 'string' || typeof configSnapshot.appliedConfig !== 'string' ||
    typeof configSnapshot.output !== 'string' || typeof configSnapshot.isolatedHome !== 'string' ||
    typeof configSnapshot.configPath !== 'string') {
    throw new Error('Fixture config snapshot is required for safe cleanup');
  }
  assertRuntimeHome(configSnapshot.output, configSnapshot.isolatedHome, configPath);
  if (path.resolve(configSnapshot.configPath) !== path.resolve(configPath)) {
    throw new Error('Fixture config snapshot does not match its isolated config path');
  }
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Dedicated config must be a regular file');
  const current = fs.readFileSync(configPath, 'utf8');
  if (current === configSnapshot.originalConfig) return true;
  if (current !== configSnapshot.appliedConfig) return false;
  replaceConfigAtomically(configPath, current, configSnapshot.originalConfig);
  return true;
}

function safeLabel(value) {
  return typeof value === 'string' && isSafeIdentity(value) && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(value)
    ? value
    : 'unknown';
}

function safeStatus(value) {
  return typeof value === 'string' && EVENT_STATUSES.has(value) ? value : 'unknown';
}

function safeErrorCode(error) {
  const code = error && typeof error === 'object' ? error.code : undefined;
  if (Number.isSafeInteger(code)) return code;
  if (typeof code === 'string' && safeLabel(code) !== 'unknown') return code;
  return 'unknown';
}

function findProbeInResult(value, depth = 0) {
  if (depth > 8 || value === null || value === undefined) return null;
  if (typeof value === 'string') {
    if (value.length > 65536) return null;
    try {
      return findProbeInResult(JSON.parse(value), depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const child of value.slice(0, 32)) {
      const probe = findProbeInResult(child, depth + 1);
      if (probe) return probe;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  if (Object.hasOwn(value, 'explicit') && Object.hasOwn(value, 'environment') && Object.hasOwn(value, 'mcp_meta')) {
    return sanitizeProbe(value);
  }
  for (const key of ['result', 'content', 'text', 'output', 'item']) {
    if (!Object.hasOwn(value, key)) continue;
    const probe = findProbeInResult(value[key], depth + 1);
    if (probe) return probe;
  }
  return null;
}

function itemIsMcp(item) {
  if (!item || typeof item !== 'object') return false;
  const type = typeof item.type === 'string' ? item.type.toLowerCase() : '';
  const name = [item.tool, item.tool_name, item.name].find(value => typeof value === 'string') || '';
  return type.includes('mcp') || name.includes('poc157_identity') || name.includes('probe_identity');
}

function summarizeEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return null;
  const summary = { event_type: safeLabel(event.type) };
  for (const key of ['thread_id', 'turn_id', 'item_id', 'call_id', 'response_id']) {
    if (isSafeIdentity(event[key])) summary[key] = event[key];
  }
  if (event.id !== undefined && isSafeIdentity(event.id)) summary.event_id = event.id;
  if (event.status !== undefined) summary.status = safeStatus(event.status);
  const item = event.item && typeof event.item === 'object' && !Array.isArray(event.item) ? event.item : null;
  if (item) {
    if (item.type !== undefined) summary.item_type = safeLabel(item.type);
    if (item.status !== undefined) summary.item_status = safeStatus(item.status);
    for (const key of ['id', 'call_id']) {
      if (isSafeIdentity(item[key])) summary['item_' + key] = item[key];
    }
    if (itemIsMcp(item)) {
      summary.mcp_call = true;
      const probe = findProbeInResult(item);
      if (probe) summary.mcp_probe = probe;
    }
    if (item.error !== undefined && item.error !== null) {
      summary.api_error_present = true;
      summary.api_error_code = safeErrorCode(item.error);
    }
  }
  if (event.response && typeof event.response === 'object') {
    const response = event.response;
    if (isSafeIdentity(response.id)) summary.response_id = response.id;
    if (response.status !== undefined) summary.response_status = safeStatus(response.status);
    if (response.error !== undefined && response.error !== null) {
      summary.api_error_present = true;
      summary.api_error_code = safeErrorCode(response.error);
    }
  }
  if (event.error !== undefined && event.error !== null) {
    summary.api_error_present = true;
    summary.api_error_code = safeErrorCode(event.error);
  }
  const messageCandidates = [event.message, event.text, event.delta, item && item.text];
  if (item && Array.isArray(item.content)) {
    for (const part of item.content.slice(0, 16)) {
      if (part && typeof part === 'object') messageCandidates.push(part.text);
    }
  }
  if (messageCandidates.some(message => message === FIXTURE_FINAL_TEXT)) summary.message = FIXTURE_FINAL_TEXT;
  return summary;
}

function createEventCollector() {
  let decoder = new StringDecoder('utf8');
  let finished = false;
  let pending = '';
  let discarding = false;
  let outputWarningMentions = 0;
  let outputErrorMentions = 0;
  let malformedLines = 0;
  let omittedEvents = 0;
  const events = [];
  const probeResults = [];
  let toolErrorCount = 0;
  let fixtureMessageSeen = false;

  const addEventLine = (line) => {
    if (!line.trim()) return;
    let parsed;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines += 1;
      outputWarningMentions += /\bwarning\b/i.test(line) ? 1 : 0;
      outputErrorMentions += /\berror\b/i.test(line) ? 1 : 0;
      return;
    }
    const summary = summarizeEvent(parsed);
    if (!summary) {
      malformedLines += 1;
      return;
    }
    if (summary.api_error_present || summary.event_type === 'error' || /\.(?:failed|error)$/.test(summary.event_type) ||
      ['failed', 'errored', 'error'].includes(summary.item_status)) {
      toolErrorCount += 1;
    }
    if (summary.mcp_probe && probeResults.length < MAX_PROBE_RESULTS) probeResults.push(summary.mcp_probe);
    if (summary.message === FIXTURE_FINAL_TEXT) fixtureMessageSeen = true;
    if (events.length < MAX_EVENT_SUMMARIES) events.push(summary);
    else omittedEvents += 1;
  };

  const consumeText = (text) => {
      let start = 0;
      if (discarding) {
        const newline = text.indexOf('\n');
        if (newline < 0) return;
        discarding = false;
        start = newline + 1;
      }
      let newline;
      while ((newline = text.indexOf('\n', start)) >= 0) {
        const line = pending + text.slice(start, newline).replace(/\r$/, '');
        pending = '';
        if (line.length > MAX_EVENT_LINE_CHARS) malformedLines += 1;
        else addEventLine(line);
        start = newline + 1;
      }
      const tail = text.slice(start);
      if (pending.length + tail.length > MAX_EVENT_LINE_CHARS) {
        pending = '';
        discarding = true;
        malformedLines += 1;
      } else {
        pending += tail;
      }
  };

  return {
    consume(chunk) {
      if (finished) return;
      if (Buffer.isBuffer(chunk)) {
        consumeText(decoder.write(chunk));
      } else if (ArrayBuffer.isView(chunk)) {
        consumeText(decoder.write(Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength)));
      } else {
        const bufferedText = decoder.end();
        decoder = new StringDecoder('utf8');
        consumeText(bufferedText + String(chunk));
      }
    },
    finish() {
      if (!finished) {
        consumeText(decoder.end());
        finished = true;
      }
      if (pending && !discarding) addEventLine(pending.replace(/\r$/, ''));
      pending = '';
      return {
        events,
        probe_results: probeResults,
        tool_error_count: toolErrorCount,
        fixture_message_seen: fixtureMessageSeen,
        malformed_line_count: malformedLines,
        omitted_event_count: omittedEvents,
        warning_mentions: outputWarningMentions,
        error_mentions: outputErrorMentions,
      };
    },
  };
}

function createStderrCounter() {
  let tail = '';
  let warningMentions = 0;
  let errorMentions = 0;
  const countMentions = (text) => {
    warningMentions += (text.match(/\bwarning\b/gi) || []).length;
    errorMentions += (text.match(/\berror\b/gi) || []).length;
  };
  return {
    consume(chunk) {
      const combined = tail + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      const split = Math.max(0, combined.length - 16);
      countMentions(combined.slice(0, split));
      tail = combined.slice(split);
    },
    finish() {
      countMentions(tail);
      tail = '';
      return { warning_mentions: warningMentions, error_mentions: errorMentions };
    },
  };
}

function runVersionCheck(executable, home, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], {
      cwd: options.cwd,
      env: makeChildEnvironment(options.environment || process.env, home),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let matched = false;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error('Codex version check timed out'));
    }, options.timeoutMs || VERSION_TIMEOUT_MS);
    child.stdout.on('data', chunk => {
      if (stdout.length >= 4096) return;
      stdout += chunk.toString('utf8').slice(0, 4096 - stdout.length);
    });
    child.stderr.on('data', () => {});
    child.on('error', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error('Codex version executable could not start'));
    });
    child.on('close', code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      matched = code === 0 && new RegExp(`\\b${REQUIRED_CODEX_VERSION.replaceAll('.', '\\.')}(?:\\b|$)`).test(stdout);
      if (!matched) reject(new Error('Codex version must be 0.160.0'));
      else resolve({ version: REQUIRED_CODEX_VERSION });
    });
  });
}

function createFixtureRequestsSummary(requests) {
  const safeToolNames = new Set();
  const paths = [];
  const topLevelFieldTypes = [];
  const headerNames = new Set();
  for (const request of requests) {
    if (request.path === '/responses' || request.path === '/v1/responses') paths.push(request.path);
    for (const name of Array.isArray(request.toolNames) ? request.toolNames : []) {
      if (safeLabel(name) !== 'unknown') safeToolNames.add(name);
    }
    for (const name of Array.isArray(request.headerNames) ? request.headerNames : []) {
      if (safeLabel(name.replace(/-/g, '_')) !== 'unknown') headerNames.add(name.toLowerCase());
    }
    const fields = request.bodyShape && Array.isArray(request.bodyShape.topLevel) ? request.bodyShape.topLevel : [];
    const normalized = fields.filter(field => field && safeLabel(field.key.replace(/-/g, '_')) !== 'unknown')
      .map(field => ({ key: field.key, type: ['string', 'number', 'boolean', 'object', 'array', 'null', 'undefined'].includes(field.type) ? field.type : 'unknown' }))
      .sort((left, right) => left.key.localeCompare(right.key));
    if (normalized.length) topLevelFieldTypes.push(normalized);
  }
  return {
    request_count: requests.length,
    paths,
    tool_names: [...safeToolNames].sort(),
    request_field_types: topLevelFieldTypes,
    header_names: [...headerNames].sort(),
  };
}

function buildResult({ run, version, fixture, childResult, eventResult, stderrResult, startWith = 'command',
  sourceHome = 'unknown', isolatedHome = 'unknown' }) {
  const unsupported = typeof fixture.unsupported === 'string';
  const fixtureRequests = createFixtureRequestsSummary(fixture.requests);
  const timedOut = childResult.timedOut;
  const failedByTool = eventResult.tool_error_count > 0;
  const expectedRequestCount = startWith === 'mcp' ? 2 : 3;
  const completeExchange = fixtureRequests.request_count >= expectedRequestCount && eventResult.fixture_message_seen;
  const success = childResult.exitCode === 0 && !timedOut && !childResult.interrupted && !unsupported && !failedByTool &&
    eventResult.probe_results.length > 0 && completeExchange;
  const reasons = [];
  if (timedOut) reasons.push('timeout');
  if (childResult.interrupted) reasons.push('interrupted');
  if (childResult.exitCode !== 0) reasons.push('nonzero_exit');
  if (unsupported) reasons.push('unsupported_tool_schema');
  if (failedByTool) reasons.push('tool_error');
  if (!eventResult.probe_results.length) reasons.push('missing_mcp_probe_result');
  if (!completeExchange) reasons.push('incomplete_fixture_exchange');
  return {
    backend: {
      source: 'local_responses_fixture',
      model: FIXTURE_MODEL,
      real_model_observed: false,
    },
    target_version: version.version,
    run_mode: run,
    start_with: startWith,
    source_home: sourceHome,
    isolated_home: isolatedHome,
    child: {
      exit_code: Number.isInteger(childResult.exitCode) ? childResult.exitCode : 'unknown',
      signal: childResult.signal || 'none',
      timed_out: timedOut,
      interrupted: childResult.interrupted === true,
      spawn_error_code: childResult.spawnErrorCode || 'none',
    },
    success,
    failure_reasons: reasons,
    fixture: {
      unsupported,
      requests: fixtureRequests,
    },
    events: eventResult.events,
    mcp_probe_results: eventResult.probe_results,
    stderr: stderrResult,
    stdout_diagnostics: {
      malformed_line_count: eventResult.malformed_line_count,
      omitted_event_count: eventResult.omitted_event_count,
      warning_mentions: eventResult.warning_mentions,
      error_mentions: eventResult.error_mentions,
    },
  };
}

function resultsFileName(date = new Date()) {
  const stamp = date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  return `exec-results-${stamp}.json`;
}

function runExecChild(executable, layout, options = {}) {
  return new Promise(resolve => {
    const child = spawn(executable, execArguments(layout, options.startWith), {
      cwd: layout.repo,
      env: makeChildEnvironment(options.environment || process.env, layout.home),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const collector = createEventCollector();
    const stderrCounter = createStderrCounter();
    let timedOut = false;
    let spawnErrorCode = null;
    let settled = false;
    let interrupted = false;
    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off('SIGINT', onInterrupt);
      process.off('SIGTERM', onInterrupt);
      resolve({
        exitCode: code,
        signal,
        timedOut,
        interrupted,
        spawnErrorCode,
        eventResult: collector.finish(),
        stderrResult: stderrCounter.finish(),
      });
    };
    const onInterrupt = () => {
      interrupted = true;
      if (child.pid && !child.killed) child.kill();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      if (child.pid && !child.killed) child.kill();
    }, options.timeoutMs || EXEC_TIMEOUT_MS);
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onInterrupt);
    child.stdout.on('data', collector.consume);
    child.stderr.on('data', stderrCounter.consume);
    child.on('error', error => {
      spawnErrorCode = typeof error.code === 'string' && /^[A-Z0-9_]{1,32}$/.test(error.code) ? error.code : 'unknown';
      finish(null, null);
    });
    child.on('close', finish);
    child.stdin.end();
  });
}

async function startFixture(outputDirectory, codexPath, options = {}) {
  const paths = validatePaths(codexPath, outputDirectory);
  const layout = createRuntimeHome(paths.layout);
  const startWith = options.startWith || 'command';
  const version = await runVersionCheck(paths.executable, layout.home, {
    cwd: layout.repo,
    environment: options.environment,
  });
  const fixture = await createFixtureServer({
    model: FIXTURE_MODEL,
    mcpProbeToolName: FIXTURE_TOOL,
    startWith,
  }).start();
  try {
    const configured = configureFixture(layout, layout.configPath, fixture);
    return {
      ...paths,
      layout,
      configPath: layout.configPath,
      sourceHome: paths.layout.home,
      isolatedHome: layout.home,
      version,
      fixture,
      startWith,
      configSnapshot: configured.configSnapshot,
    };
  } catch (error) {
    await fixture.close();
    throw error;
  }
}

async function holdServeMode(fixture, output, signalSource = process) {
  process.stdout.write(`${JSON.stringify(output)}\n`);
  await new Promise((resolve, reject) => {
    let stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      signalSource.off('SIGINT', stop);
      signalSource.off('SIGTERM', stop);
      fixture.close().then(resolve, reject);
    };
    signalSource.on('SIGINT', stop);
    signalSource.on('SIGTERM', stop);
  });
}

async function runExecProbe(options) {
  const started = await startFixture(options.outputDirectory, options.codexPath, options);
  let result;
  let configRestored = false;
  let configCleanupFailed = false;
  try {
    const childResult = await runExecChild(started.executable, started.layout, options);
    result = buildResult({
      run: 'exec',
      startWith: started.startWith,
      version: started.version,
      fixture: started.fixture,
      sourceHome: started.sourceHome,
      isolatedHome: started.isolatedHome,
      childResult,
      eventResult: childResult.eventResult,
      stderrResult: childResult.stderrResult,
    });
  } finally {
    try {
      await started.fixture.close();
    } finally {
      try {
        configRestored = clearFixtureConfig(started.configPath, started.configSnapshot);
      } catch {
        configCleanupFailed = true;
      }
    }
  }
  result.isolated_config_restored = configRestored;
  if (!configRestored) {
    result.success = false;
    result.failure_reasons.push(configCleanupFailed ? 'isolated_config_cleanup_failed' : 'isolated_config_changed_during_run');
  }
  const filePath = path.join(started.layout.output, resultsFileName());
  fs.writeFileSync(filePath, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return { filePath, result };
}

async function serveFixture(options) {
  const started = await startFixture(options.outputDirectory, options.codexPath, options);
  let configRestored = false;
  let configCleanupFailed = false;
  try {
    await holdServeMode(started.fixture, {
      mode: 'serve',
      backend: 'local_responses_fixture',
      model: FIXTURE_MODEL,
      real_model_observed: false,
      codex_version: started.version.version,
      start_with: started.startWith,
      source_home: started.sourceHome,
      isolated_home: started.isolatedHome,
      home: started.isolatedHome,
      repo: started.layout.repo,
      exec_started: false,
    });
  } finally {
    try {
      await started.fixture.close();
    } finally {
      try {
        configRestored = clearFixtureConfig(started.configPath, started.configSnapshot);
      } catch {
        configCleanupFailed = true;
      }
    }
  }
  if (!configRestored) {
    throw new Error(configCleanupFailed
      ? 'Isolated fixture config cleanup failed; the source home was not modified'
      : 'Isolated fixture config changed while serving; it was left untouched');
  }
}

if (require.main === module) {
  let args;
  try {
    args = parseArguments(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
  if (args) {
    const task = args.serve ? serveFixture(args) : runExecProbe(args).then(({ filePath, result }) => {
      process.stdout.write(`${JSON.stringify({
        file: filePath,
        success: result.success,
        isolated_config_restored: result.isolated_config_restored,
        failure_reasons: result.failure_reasons,
      })}\n`);
      if (!result.success) process.exitCode = 1;
    });
    task.catch(() => {
      process.stderr.write('Codex fixture run failed; raw diagnostics were omitted.\n');
      process.exitCode = 1;
    });
  }
}

module.exports = {
  FIXTURE_FINAL_TEXT,
  FIXTURE_MODEL,
  FIXTURE_TOOL,
  buildResult,
  clearFixtureConfig,
  configureFixture,
  createEventCollector,
  createRuntimeHome,
  createFixtureRequestsSummary,
  execArguments,
  holdServeMode,
  makeChildEnvironment,
  parseArguments,
  resultsFileName,
  startFixture,
  serveFixture,
  runExecChild,
  runExecProbe,
  runVersionCheck,
  safeErrorCode,
  normalizeTrailingBlankLines,
  splitConfigSections,
  summarizeEvent,
  validatePaths,
};
