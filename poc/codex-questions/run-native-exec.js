'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const {
  assertNoSymlinkComponents,
  resolveOutputDirectory,
  setup,
  REQUIRED_CODEX_VERSION,
  REPOSITORY_ROOT,
} = require('../codex-hooks-identity/setup');
const {
  clearFixtureConfig,
  createRuntimeHome,
  makeChildEnvironment,
  runVersionCheck,
  validatePaths,
} = require('../codex-hooks-identity/run-exec');
const { cleanupRuntimeHome } = require('./run-common-mcp');
const { createNativeQuestionFixture, FIXTURE_MODEL, TOOL_NAME } = require('./native-fixture');

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;
const STARTUP_TIMEOUT_MS = 10_000;
const TERMINATION_GRACE_MS = 3_000;
const MAX_STDOUT_BYTES = 512 * 1024;
const MAX_STDERR_BYTES = 128 * 1024;
const MAX_JSON_LINE_BYTES = 32 * 1024;
const MAX_RESULT_BYTES = 32 * 1024;
const TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_.:/-]{0,127}$/;
const EVENT_TYPES = new Set([
  'thread.started', 'thread.closed', 'turn.started', 'turn.completed', 'turn.failed', 'turn.interrupted',
  'item.started', 'item.completed', 'error',
]);
const ITEM_TYPES = new Set([
  'agentMessage', 'agent_message', 'commandExecution', 'command_execution', 'dynamicToolCall', 'dynamic_tool_call',
  'fileChange', 'file_change', 'functionCall', 'function_call', 'mcpToolCall', 'mcp_tool_call', 'plan', 'reasoning',
  'subAgentActivity', 'sub_agent_activity', 'toolCall', 'tool_call', 'webSearch', 'web_search',
]);
const ITEM_STATUSES = new Set(['queued', 'inProgress', 'running', 'completed', 'failed', 'interrupted', 'cancelled', 'unknown']);
const UNSUPPORTED_REASONS = new Set([
  'tool_schema_missing', 'request_user_input_schema_unsupported', 'multi_select_schema_unsupported',
  'blocking_schema_unsupported', 'blocking_not_configurable', 'question_count_minimum_unsupported',
  'question_count_maximum_unsupported', 'question_schema_unsupported', 'question_options_unsupported',
  'question_options_minimum_unsupported', 'question_options_maximum_unsupported', 'free_form_schema_unsupported',
  'secret_field_schema_unsupported', 'tool_required_argument_unsupported', 'tool_argument_schema_mismatch',
  'multi_tool_required_argument_unsupported', 'tool_declaration_ambiguous', 'request_user_input_unavailable',
  'question_profile_unsupported',
]);
const TOOL_OUTPUT_ERROR_KINDS = new Set([
  'default_mode_unavailable', 'question_tool_unrecognized', 'question_tool_unavailable',
  'structured_output', 'unclassified_text', 'unknown', 'not_seen',
]);
const PROMPT = 'If the request_user_input tool is available, invoke it once and wait for its response. Do not answer the questions or invent a response. Do not call other tools. If it is unavailable, finish without using a tool.';

class NativeExecError extends Error {
  constructor(kind) {
    super(kind);
    this.name = 'NativeExecError';
    this.kind = kind;
  }
}

function usage() {
  return 'Usage: node run-native-exec.js --codex-path <codex.exe> --out poc/out/<fresh-slug> [--question-profile single|full] [--timeout-ms 30000]';
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--codex-path', '--out', '--question-profile', '--timeout-ms'].includes(option)
      || values.has(option) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new NativeExecError('invalid_arguments');
    }
    values.set(option, argv[index + 1]);
    index += 1;
  }
  if (!values.has('--codex-path') || !values.has('--out')) throw new NativeExecError('invalid_arguments');
  const timeoutMs = values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > MAX_TIMEOUT_MS) {
    throw new NativeExecError('invalid_timeout');
  }
  const questionProfile = values.get('--question-profile') || 'full';
  if (!['single', 'full'].includes(questionProfile)) throw new NativeExecError('invalid_question_profile');
  return {
    codexPath: path.resolve(values.get('--codex-path')),
    outputDirectory: values.get('--out'),
    questionProfile,
    timeoutMs,
  };
}

function safeToolName(value) {
  return typeof value === 'string' && TOOL_NAME_PATTERN.test(value) ? value : null;
}

function safeSpawnErrorKind(code) {
  if (['EACCES', 'EINVAL', 'ENOENT', 'ENOMEM', 'EPERM', 'ETIMEDOUT'].includes(code)) return `spawn_${code.toLowerCase()}`;
  return code ? 'spawn_error' : 'none';
}

function createJsonlCollector(killChild = () => {}) {
  const decoder = new StringDecoder('utf8');
  const eventCounts = new Map();
  const threadIds = new Set();
  const itemIds = new Set();
  const questionToolItemIds = new Set();
  const itemTypes = new Map();
  const itemStatuses = new Map();
  let questionToolItemEventCount = 0;
  let turnStatus = 'unknown';
  let nativeErrorEventCount = 0;
  let pending = '';
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let malformedLineCount = 0;
  let omittedLineCount = 0;
  let outputLimitExceeded = false;

  function count(map, key) {
    map.set(key, (map.get(key) || 0) + 1);
  }

  function consumeLine(line) {
    if (!line.trim()) return;
    if (Buffer.byteLength(line, 'utf8') > MAX_JSON_LINE_BYTES) {
      omittedLineCount += 1;
      return;
    }
    let event;
    try { event = JSON.parse(line); } catch { malformedLineCount += 1; return; }
    if (!event || typeof event !== 'object' || Array.isArray(event) || !EVENT_TYPES.has(event.type)) return;
    count(eventCounts, event.type);
    if (event.type === 'thread.started') {
      const threadId = event.thread_id || event.threadId || event.thread?.id;
      if (typeof threadId === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(threadId)) threadIds.add(threadId);
    }
    if (event.type === 'turn.started') turnStatus = 'inProgress';
    if (event.type === 'turn.completed') turnStatus = 'completed';
    if (event.type === 'turn.failed') turnStatus = 'failed';
    if (event.type === 'turn.interrupted') turnStatus = 'interrupted';
    if (event.type === 'error') nativeErrorEventCount += 1;
    if (event.type !== 'item.started' && event.type !== 'item.completed') return;
    const item = event.item && typeof event.item === 'object' && !Array.isArray(event.item) ? event.item : null;
    if (!item) return;
    if (typeof item.id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(item.id)) itemIds.add(item.id);
    const itemType = ITEM_TYPES.has(item.type) ? item.type : 'unknown';
    count(itemTypes, itemType);
    const status = ITEM_STATUSES.has(item.status) ? item.status : 'unknown';
    count(itemStatuses, status);
    const toolNames = [item.tool, item.name, item.server_tool_name, item.serverToolName];
    if (toolNames.includes(TOOL_NAME)) {
      questionToolItemEventCount += 1;
      if (typeof item.id === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(item.id)) questionToolItemIds.add(item.id);
    }
  }

  return {
    consumeStdout(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutBytes += data.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        outputLimitExceeded = true;
        killChild();
        return;
      }
      pending += decoder.write(data);
      let newline;
      while ((newline = pending.indexOf('\n')) >= 0) {
        consumeLine(pending.slice(0, newline).replace(/\r$/, ''));
        pending = pending.slice(newline + 1);
      }
      if (Buffer.byteLength(pending, 'utf8') > MAX_JSON_LINE_BYTES) {
        pending = '';
        omittedLineCount += 1;
      }
    },
    consumeStderr(chunk) {
      const data = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      stderrBytes += data.length;
      if (stderrBytes > MAX_STDERR_BYTES) stderrBytes = MAX_STDERR_BYTES;
    },
    finish() {
      pending += decoder.end();
      consumeLine(pending.replace(/\r$/, ''));
      pending = '';
      return {
        stdout_bytes: Math.min(stdoutBytes, MAX_STDOUT_BYTES),
        stderr_bytes: stderrBytes,
        malformed_line_count: malformedLineCount,
        omitted_line_count: omittedLineCount,
        output_limit_exceeded: outputLimitExceeded,
        event_counts: Object.fromEntries([...eventCounts.entries()].sort(([left], [right]) => left.localeCompare(right))),
        native_thread_count: threadIds.size,
        native_item_count: itemIds.size,
        item_type_counts: Object.fromEntries([...itemTypes.entries()].sort(([left], [right]) => left.localeCompare(right))),
        item_status_counts: Object.fromEntries([...itemStatuses.entries()].sort(([left], [right]) => left.localeCompare(right))),
        request_user_input_item_count: questionToolItemIds.size,
        request_user_input_item_event_count: questionToolItemEventCount,
        turn_status: turnStatus,
        native_error_event_count: nativeErrorEventCount,
      };
    },
  };
}

function createSignalController(signalSource = process) {
  let signal = null;
  let child = null;
  const handlers = new Map();
  for (const name of ['SIGINT', 'SIGTERM']) {
    const handler = () => {
      signal ||= name;
      if (child && !child.killed) child.kill();
    };
    handlers.set(name, handler);
    signalSource.on(name, handler);
  }
  return {
    get signal() { return signal; },
    setChild(value) {
      child = value;
      if (signal && child && !child.killed) child.kill();
    },
    dispose() {
      for (const [name, handler] of handlers) signalSource.off(name, handler);
      handlers.clear();
      child = null;
    },
  };
}

function throwIfInterrupted(controller) {
  if (controller.signal) throw new NativeExecError('interrupted_during_startup');
}

function runExecChild(executable, layout, environment, timeoutMs, signalController, spawnImpl = spawn) {
  return new Promise((resolve) => {
    const args = [
      '--no-daemon', 'exec', '--json', '--ephemeral', '-C', layout.repo, '-s', 'read-only', PROMPT,
    ];
    let child;
    try {
      child = spawnImpl(executable, args, {
        cwd: layout.repo,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        exit_code: 'unknown', signal: 'none', timed_out: false, interrupted: false,
        spawn_error_kind: safeSpawnErrorKind(error && error.code), child_exited: true,
        events: createJsonlCollector().finish(),
      });
      return;
    }
    const collector = createJsonlCollector(() => { if (child.pid && !child.killed) child.kill(); });
    let settled = false;
    let timedOut = false;
    let forcedSettle = false;
    let spawnErrorKind = 'none';
    let exitCode = 'unknown';
    let exitSignal = 'none';
    const finish = (childExited) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(graceTimer);
      signalController.setChild(null);
      resolve({
        exit_code: exitCode,
        signal: exitSignal,
        timed_out: timedOut,
        interrupted: Boolean(signalController.signal),
        forced_settle: forcedSettle,
        spawn_error_kind: spawnErrorKind,
        child_exited: childExited,
        events: collector.finish(),
      });
    };
    const terminate = (timeout) => {
      if (timeout) timedOut = true;
      if (child.pid && !child.killed) child.kill();
      if (!graceTimer) {
        graceTimer = setTimeout(() => {
          if (settled) return;
          forcedSettle = true;
          if (child.pid && !child.killed) child.kill();
          finish(false);
        }, TERMINATION_GRACE_MS);
      }
    };
    let graceTimer = null;
    const timer = setTimeout(() => terminate(true), timeoutMs);
    signalController.setChild(child);
    child.stdout.on('data', collector.consumeStdout);
    child.stderr.on('data', collector.consumeStderr);
    child.on('error', (error) => {
      spawnErrorKind = safeSpawnErrorKind(error && error.code);
      finish(true);
    });
    child.on('close', (code, signal) => {
      exitCode = Number.isInteger(code) ? code : 'unknown';
      exitSignal = typeof signal === 'string' ? signal : 'none';
      finish(true);
    });
    if (signalController.signal) terminate(false);
    try { child.stdin.end(); } catch { terminate(false); }
  });
}

function renderFixtureConfig(fixture) {
  const token = fixture.requestHeaders['X-Poc160-Token'];
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token) || typeof fixture.baseUrl !== 'string') {
    throw new NativeExecError('fixture_connection_details_invalid');
  }
  const quote = (value) => JSON.stringify(value);
  return [
    `model = ${quote(FIXTURE_MODEL)}`,
    'model_provider = "poc160_native_question_fixture"',
    '',
    '[model_providers.poc160_native_question_fixture]',
    'name = "Local deterministic native-question fixture"',
    `base_url = ${quote(fixture.baseUrl)}`,
    'wire_api = "responses"',
    `http_headers = { "X-Poc160-Token" = ${quote(token)} }`,
    'request_max_retries = 0',
    'stream_max_retries = 0',
    '',
  ].join('\n');
}

function applyFixtureConfig(layout, fixture) {
  const configPath = layout.configPath;
  assertNoSymlinkComponents(REPOSITORY_ROOT, configPath);
  const stat = fs.lstatSync(configPath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new NativeExecError('private_config_invalid');
  const originalConfig = fs.readFileSync(configPath, 'utf8');
  const appliedConfig = renderFixtureConfig(fixture);
  const temporaryPath = `${configPath}.poc160-native-exec-${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, appliedConfig, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryPath, configPath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const hooksPath = path.join(layout.home, 'hooks.json');
  const hooksStat = fs.lstatSync(hooksPath);
  if (!hooksStat.isFile() || hooksStat.isSymbolicLink()) throw new NativeExecError('private_hooks_invalid');
  fs.writeFileSync(hooksPath, '{"hooks":{}}\n', { encoding: 'utf8', mode: 0o600 });
  return {
    output: path.resolve(layout.output),
    isolatedHome: path.resolve(layout.home),
    configPath: path.resolve(configPath),
    originalConfig,
    appliedConfig,
  };
}

function safeFixtureSummary(fixture) {
  const requests = Array.isArray(fixture?.requests) ? fixture.requests : [];
  const names = new Set();
  for (const request of requests.slice(0, 8)) {
    if (Array.isArray(request?.tool_names)) {
      for (const name of request.tool_names.slice(0, 48)) {
        const safe = safeToolName(name);
        if (safe) names.add(safe);
      }
    }
  }
  const call = fixture?.callSummary;
  const targetTool = call?.target_tool || call?.targetTool;
  const emitted = Boolean(call && targetTool === TOOL_NAME);
  const questions = emitted && Array.isArray(call.questions) ? call.questions.slice(0, 3) : [];
  const unsupportedValue = typeof fixture?.unsupported === 'string' ? fixture.unsupported : null;
  return {
    request_count: Math.min(8, requests.length),
    available_tool_names: [...names].sort(),
    request_user_input_declared: [...names].some((name) => name.split('.').at(-1) === TOOL_NAME),
    question_profile: ['single', 'full'].includes(call?.question_profile) ? call.question_profile : null,
    unsupported_reason: unsupportedValue && UNSUPPORTED_REASONS.has(unsupportedValue) ? unsupportedValue
      : unsupportedValue ? 'unknown' : null,
    fixture_function_call_emitted: emitted,
    call_target_tool: emitted ? TOOL_NAME : null,
    question_count: questions.length,
    option_counts: questions.map((question) => Number.isSafeInteger(question.option_count) ? question.option_count : 0),
    free_form_question_count: questions.filter((question) => question.free_form_enabled === true).length,
    follow_up_request_count: Math.max(0, Math.min(8, requests.length) - 1),
    response_output_seen: fixture?.answerOutput?.call_output_seen === true,
    tool_output_error_kind: TOOL_OUTPUT_ERROR_KINDS.has(fixture?.answerOutput?.tool_output_error_kind)
      ? fixture.answerOutput.tool_output_error_kind
      : fixture?.answerOutput?.call_output_seen === true ? 'unknown' : 'not_seen',
  };
}

function boundedCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? Math.min(value, 1_000_000) : 0;
}

function safeCountMap(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value)
    .filter(([key, count]) => keys.has(key) && Number.isSafeInteger(count) && count >= 0)
    .map(([key, count]) => [key, boundedCount(count)])
    .sort(([left], [right]) => left.localeCompare(right)));
}

function safeNativeEvents(events) {
  const source = events && typeof events === 'object' && !Array.isArray(events) ? events : {};
  return {
    stdout_bytes: boundedCount(source.stdout_bytes),
    stderr_bytes: boundedCount(source.stderr_bytes),
    malformed_line_count: boundedCount(source.malformed_line_count),
    omitted_line_count: boundedCount(source.omitted_line_count),
    output_limit_exceeded: source.output_limit_exceeded === true,
    event_counts: safeCountMap(source.event_counts, EVENT_TYPES),
    native_thread_count: boundedCount(source.native_thread_count),
    native_item_count: boundedCount(source.native_item_count),
    item_type_counts: safeCountMap(source.item_type_counts, new Set([...ITEM_TYPES, 'unknown'])),
    item_status_counts: safeCountMap(source.item_status_counts, ITEM_STATUSES),
    request_user_input_item_count: boundedCount(source.request_user_input_item_count),
    request_user_input_item_event_count: boundedCount(source.request_user_input_item_event_count),
    turn_status: ['inProgress', 'completed', 'failed', 'interrupted'].includes(source.turn_status)
      ? source.turn_status : 'unknown',
    native_error_event_count: boundedCount(source.native_error_event_count),
  };
}

function safeChildSummary(child) {
  const source = child && typeof child === 'object' && !Array.isArray(child) ? child : {};
  return {
    exit_code: Number.isInteger(source.exit_code) && source.exit_code >= 0 && source.exit_code <= 255 ? source.exit_code : 'unknown',
    signal: ['SIGINT', 'SIGTERM', 'SIGKILL'].includes(source.signal) ? source.signal : 'none',
    timed_out: source.timed_out === true,
    interrupted: source.interrupted === true,
    forced_settle: source.forced_settle === true,
    child_exited: source.child_exited === true,
    spawn_error_kind: typeof source.spawn_error_kind === 'string' && /^[a-z][a-z0-9_]{0,48}$/.test(source.spawn_error_kind)
      ? source.spawn_error_kind : 'none',
    events: safeNativeEvents(source.events),
  };
}

function classifyObservation(fixture, child) {
  const fixtureSummary = Array.isArray(fixture?.available_tool_names)
    ? {
      request_count: boundedCount(fixture.request_count),
      available_tool_names: fixture.available_tool_names.map(safeToolName).filter(Boolean).slice(0, 48).sort(),
      request_user_input_declared: fixture.request_user_input_declared === true,
      question_profile: ['single', 'full'].includes(fixture.question_profile) ? fixture.question_profile : null,
      unsupported_reason: typeof fixture.unsupported_reason === 'string' && UNSUPPORTED_REASONS.has(fixture.unsupported_reason)
        ? fixture.unsupported_reason : fixture.unsupported_reason ? 'unknown' : null,
      fixture_function_call_emitted: fixture.fixture_function_call_emitted === true,
      call_target_tool: fixture.call_target_tool === TOOL_NAME ? TOOL_NAME : null,
      question_count: boundedCount(fixture.question_count),
      option_counts: Array.isArray(fixture.option_counts) ? fixture.option_counts.slice(0, 3).map(boundedCount) : [],
      free_form_question_count: boundedCount(fixture.free_form_question_count),
      follow_up_request_count: boundedCount(fixture.follow_up_request_count),
      response_output_seen: fixture.response_output_seen === true,
      tool_output_error_kind: TOOL_OUTPUT_ERROR_KINDS.has(fixture.tool_output_error_kind)
        ? fixture.tool_output_error_kind : fixture.response_output_seen ? 'unknown' : 'not_seen',
    }
    : safeFixtureSummary(fixture);
  const childSummary = safeChildSummary(child);
  let errorKind = 'none';
  if (childSummary.timed_out) errorKind = 'timeout';
  else if (childSummary.interrupted) errorKind = 'interrupted';
  else if (childSummary.events.output_limit_exceeded) errorKind = 'output_limit';
  else if (childSummary.spawn_error_kind !== 'none') errorKind = childSummary.spawn_error_kind;
  else if (childSummary.events.native_error_event_count > 0) errorKind = 'native_error_event';
  else if (childSummary.exit_code !== 0 && childSummary.exit_code !== 'unknown') errorKind = 'nonzero_exit';

  let availability = 'unknown';
  let outcome = 'unverified';
  const unsupportedReason = fixtureSummary.unsupported_reason;
  if (fixtureSummary.request_count === 0) {
    availability = 'unknown';
    outcome = errorKind === 'none' ? 'fixture_request_not_observed' : 'exec_failed_before_fixture_request';
  } else if (unsupportedReason && unsupportedReason !== 'request_user_input_unavailable' && unsupportedReason !== 'unknown') {
    availability = 'unsupported_schema';
    outcome = 'unsupported_schema';
  } else if (unsupportedReason === 'unknown') {
    availability = 'unknown';
    outcome = 'fixture_unsupported_reason_unknown';
  } else if (!fixtureSummary.request_user_input_declared || unsupportedReason === 'request_user_input_unavailable') {
    availability = 'unavailable';
    outcome = 'tool_unavailable';
  } else if (!fixtureSummary.fixture_function_call_emitted) {
    availability = 'declared';
    outcome = errorKind === 'none' ? 'question_call_not_emitted' : 'exec_failed_before_question_call';
  } else if (childSummary.events.request_user_input_item_count > 0) {
    availability = 'native_item_observed';
    outcome = 'native_question_item_observed';
  } else if (childSummary.timed_out) {
    availability = 'call_emitted_unresolved';
    outcome = 'exec_timeout_after_question_call';
  } else if (childSummary.interrupted) {
    availability = 'call_emitted_unresolved';
    outcome = 'exec_interrupted_after_question_call';
  } else if (errorKind !== 'none') {
    availability = 'call_emitted_unresolved';
    outcome = 'exec_failed_after_question_call';
  } else if (childSummary.events.turn_status === 'completed') {
    availability = 'call_emitted_unresolved';
    outcome = 'question_call_not_observed_in_exec';
  } else {
    availability = 'call_emitted_unresolved';
    outcome = 'question_call_unresolved';
  }
  return { availability, outcome, error_kind: errorKind, fixture: fixtureSummary, native: childSummary };
}

function resultTemplate(outputDirectory, questionProfile = 'full') {
  return {
    schema: 'agent-cockpit-poc160-native-exec-v1',
    target_codex_version: REQUIRED_CODEX_VERSION,
    version_verified: false,
    execution_mode: 'codex_exec_json_ephemeral_read_only',
    question_profile: questionProfile,
    real_model_observed: false,
    availability: 'unknown',
    outcome: 'unverified',
    error_kind: 'none',
    fixture: safeFixtureSummary(null),
    native: safeChildSummary(null),
    cleanup: {
      fixture_closed: false,
      config_restored: false,
      runtime_home_removed: false,
      signal_handlers_removed: false,
    },
    output_directory: path.relative(REPOSITORY_ROOT, outputDirectory).split(path.sep).join('/'),
  };
}

function writeResult(outputDirectory, result) {
  const filePath = path.join(outputDirectory, 'native-exec-observation.json');
  assertNoSymlinkComponents(REPOSITORY_ROOT, filePath);
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (Buffer.byteLength(serialized, 'utf8') > MAX_RESULT_BYTES) throw new NativeExecError('result_too_large');
  fs.writeFileSync(filePath, serialized, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return filePath;
}

async function runExecChildWithSignals(executable, layout, environment, timeoutMs, signalController, spawnImpl = spawn) {
  return runExecChild(executable, layout, environment, timeoutMs, signalController, spawnImpl);
}

async function runNativeExecProbe(options, dependencies = {}) {
  if (!options || typeof options !== 'object' || typeof options.codexPath !== 'string'
    || typeof options.outputDirectory !== 'string' || !Number.isSafeInteger(options.timeoutMs)
    || options.timeoutMs < 1_000 || options.timeoutMs > MAX_TIMEOUT_MS
    || (options.questionProfile !== undefined && !['single', 'full'].includes(options.questionProfile))) {
    throw new NativeExecError('invalid_options');
  }
  const questionProfile = options.questionProfile || 'full';
  const signalSource = dependencies.signalSource || process;
  const controller = createSignalController(signalSource);
  const output = resolveOutputDirectory(options.outputDirectory);
  const result = resultTemplate(output, questionProfile);
  let outputDirectory = null;
  let outputCreated = false;
  let runtimeLayout = null;
  let fixture = null;
  let configSnapshot = null;
  let fixtureClosed = false;
  let configRestored = false;
  let runtimeHomeRemoved = false;
  let stage = 'output_validation';
  let child = null;
  try {
    outputDirectory = resolveOutputDirectory(options.outputDirectory);
    const codexPath = path.resolve(options.codexPath);
    const layout = (dependencies.setup || setup)({ outputDirectory, codexVersion: REQUIRED_CODEX_VERSION });
    outputCreated = true;
    throwIfInterrupted(controller);
    const paths = validatePaths(codexPath, outputDirectory);
    runtimeLayout = createRuntimeHome(layout);
    throwIfInterrupted(controller);
    const versionCheck = dependencies.runVersionCheck || runVersionCheck;
    stage = 'version_check';
    await versionCheck(paths.executable, runtimeLayout.home, { cwd: runtimeLayout.repo, timeoutMs: STARTUP_TIMEOUT_MS });
    result.version_verified = true;
    throwIfInterrupted(controller);

    stage = 'fixture_start';
    fixture = (dependencies.fixtureFactory || createNativeQuestionFixture)({ questionProfile });
    await fixture.start();
    throwIfInterrupted(controller);

    stage = 'fixture_config';
    configSnapshot = applyFixtureConfig(runtimeLayout, fixture);
    throwIfInterrupted(controller);

    stage = 'native_exec';
    const environment = makeChildEnvironment(process.env, runtimeLayout.home);
    child = await runExecChildWithSignals(paths.executable, runtimeLayout, environment, options.timeoutMs,
      controller, dependencies.spawn || spawn);
    result.native = safeChildSummary(child);
    if (controller.signal && !result.native.interrupted) result.native.interrupted = true;
  } catch (error) {
    const kind = error instanceof NativeExecError ? error.kind : null;
    result.error_kind = kind || (stage === 'version_check' ? 'version_check_failed'
      : stage === 'fixture_start' ? 'fixture_start_failed'
        : stage === 'fixture_config' ? 'fixture_config_failed'
          : stage === 'native_exec' ? 'native_exec_failed' : 'startup_failed');
    if (controller.signal) result.error_kind = 'interrupted';
  } finally {
    if (fixture) {
      try { await fixture.close(); fixtureClosed = true; } catch { fixtureClosed = false; }
    } else {
      fixtureClosed = true;
    }
    if (runtimeLayout) {
      if (configSnapshot) {
        try { configRestored = clearFixtureConfig(runtimeLayout.configPath, configSnapshot); } catch { configRestored = false; }
      } else {
        configRestored = true;
      }
      if (configRestored && (!child || child.child_exited)) {
        try { runtimeHomeRemoved = cleanupRuntimeHome(outputDirectory, runtimeLayout.home); } catch { runtimeHomeRemoved = false; }
      }
    } else {
      configRestored = true;
      runtimeHomeRemoved = true;
    }
    controller.dispose();
  }

  if (fixture) {
    const classified = classifyObservation(safeFixtureSummary(fixture), result.native);
    result.fixture = classified.fixture;
    result.native = classified.native;
    result.availability = classified.availability;
    result.outcome = classified.outcome;
    result.error_kind = result.error_kind === 'none' ? classified.error_kind : result.error_kind;
  } else {
    result.outcome = controller.signal ? 'interrupted_during_startup' : 'fixture_not_started';
  }
  result.cleanup = {
    fixture_closed: fixtureClosed,
    config_restored: configRestored,
    runtime_home_removed: runtimeHomeRemoved,
    signal_handlers_removed: true,
  };
  if (!fixtureClosed || !configRestored || !runtimeHomeRemoved) {
    result.cleanup_error = !configRestored ? 'config_restore_failed'
      : !runtimeHomeRemoved ? child && !child.child_exited ? 'child_exit_unconfirmed' : 'runtime_home_cleanup_failed'
        : 'fixture_close_failed';
  }
  if (!outputCreated) throw new NativeExecError(result.error_kind || 'output_setup_failed');
  const filePath = writeResult(outputDirectory, result);
  return { filePath, result };
}

async function main(argv = process.argv.slice(2)) {
  let options;
  try { options = parseArguments(argv); } catch {
    process.stderr.write(`${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  try {
    const { filePath, result } = await runNativeExecProbe(options);
    process.stdout.write(`${JSON.stringify({
      file: path.relative(REPOSITORY_ROOT, filePath).split(path.sep).join('/'),
      question_profile: result.question_profile,
      availability: result.availability,
      outcome: result.outcome,
      error_kind: result.error_kind,
      runtime_home_removed: result.cleanup.runtime_home_removed,
    })}\n`);
    if (!result.cleanup.runtime_home_removed || result.error_kind !== 'none') process.exitCode = 1;
  } catch (error) {
    const kind = error instanceof NativeExecError ? error.kind : 'native_exec_runner_failed';
    process.stderr.write(`${JSON.stringify({ ok: false, error: kind })}\n`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  NativeExecError,
  classifyObservation,
  createJsonlCollector,
  parseArguments,
  renderFixtureConfig,
  runExecChild,
  runNativeExecProbe,
  safeFixtureSummary,
  safeToolName,
};
