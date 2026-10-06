'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');

const REPOSITORY_ROOT = path.resolve(__dirname, '../..');
const OUTPUT_PARENT = path.join(REPOSITORY_ROOT, 'poc', 'out');
const CLAUDE_EXECUTABLE = 'C:\\Users\\mss02968\\.local\\bin\\claude.exe';
const VERSION_AT_HELP_CAPTURE = '2.1.291';
const MODEL = 'sonnet';
const EFFORT = 'low';
const FIXED_PROMPT = 'Return exactly the JSON object {"marker":"POC163_RESULT","answer":63}. Compute 9*7. Do not use any tools, delegate, read files, or change settings.';
const EXPECTED_RESULT = Object.freeze({ marker: 'POC163_RESULT', answer: 63 });
const MAX_OUTPUT_BYTES = 64 * 1024;
const MAX_VERSION_OUTPUT_BYTES = 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const SIGNALS = new Set(['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGHUP', 'SIGBREAK']);
const FAILURE_CATEGORIES = new Set([
  'cancelled', 'cli_error', 'cli_version_invalid', 'cli_version_failed', 'invalid_json',
  'invalid_result_schema', 'missing_cli', 'output_overflow', 'result_mismatch', 'spawn_error',
  'timeout', 'unsupported_result', 'ok', 'invalid_timeout', 'output_directory_invalid',
  'output_directory_not_fresh', 'output_directory_race', 'output_directory_create_failed',
  'path_outside_allowed_root', 'path_component_invalid', 'path_component_missing',
  'path_symlink_component', 'fixed_cli_path_required', 'cli_path_unavailable', 'cli_path_invalid',
]);

class NativeClaudeError extends Error {
  constructor(kind) {
    super(kind);
    this.name = 'NativeClaudeError';
    this.kind = kind;
  }
}

function safeErrorKind(error, fallback = 'native_probe_failed') {
  const kind = error && typeof error.kind === 'string' ? error.kind : null;
  return kind && /^[a-z][a-z0-9_]{0,63}$/.test(kind) ? kind : fallback;
}

function safeCode(error) {
  const code = error && typeof error.code === 'string' ? error.code : '';
  return /^[A-Z0-9_]{1,32}$/.test(code) ? code : null;
}

function safeSignal(signal) {
  return SIGNALS.has(signal) ? signal : null;
}

function safeUuid(value) {
  return typeof value === 'string'
    && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)
    ? value.toLowerCase() : null;
}

function safeModelIdentifier(value) {
  return typeof value === 'string' && value.length <= 120
    && /^(?:claude-[a-z0-9][a-z0-9._-]*|sonnet|opus|haiku)$/i.test(value)
    ? value : null;
}

function normalizeTimeout(timeoutMs) {
  const value = timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : timeoutMs;
  if (!Number.isSafeInteger(value)) throw new NativeClaudeError('invalid_timeout');
  if (value < 1_000 || value > MAX_TIMEOUT_MS) throw new NativeClaudeError('invalid_timeout');
  return value;
}

function createOutputPath() {
  const suffix = randomUUID().replace(/-/g, '').slice(0, 12);
  return path.join(OUTPUT_PARENT, 'poc163-' + Date.now() + '-' + suffix);
}

function validateOutputPath(outputDirectory) {
  if (typeof outputDirectory !== 'string' || outputDirectory.length === 0) {
    throw new NativeClaudeError('output_directory_invalid');
  }
  const resolved = path.resolve(REPOSITORY_ROOT, outputDirectory);
  if (path.dirname(resolved).toLowerCase() !== OUTPUT_PARENT.toLowerCase()
    || !/^poc163-[a-z0-9][a-z0-9-]{0,80}$/i.test(path.basename(resolved))) {
    throw new NativeClaudeError('output_directory_invalid');
  }
  return resolved;
}

function assertNoSymlinkComponents(root, target, fileSystem = fs, allowMissingLeaf = false) {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(target);
  const relative = path.relative(resolvedRoot, resolvedTarget);
  if (relative === '' || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) {
    throw new NativeClaudeError('path_outside_allowed_root');
  }
  const rootStat = fileSystem.lstatSync(resolvedRoot);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new NativeClaudeError('path_component_invalid');
  const parts = relative.split(path.sep);
  let current = resolvedRoot;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fileSystem.lstatSync(current);
    } catch (error) {
      if (allowMissingLeaf && index === parts.length - 1 && error && error.code === 'ENOENT') return;
      throw new NativeClaudeError('path_component_missing');
    }
    if (stat.isSymbolicLink()) throw new NativeClaudeError('path_symlink_component');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new NativeClaudeError('path_component_invalid');
  }
}

function createOwnedOutputDirectory(outputDirectory, fileSystem = fs) {
  const output = validateOutputPath(outputDirectory);
  assertNoSymlinkComponents(REPOSITORY_ROOT, OUTPUT_PARENT, fileSystem);
  assertNoSymlinkComponents(REPOSITORY_ROOT, output, fileSystem, true);
  if (fileSystem.existsSync(output)) throw new NativeClaudeError('output_directory_not_fresh');
  try {
    fileSystem.mkdirSync(output, { recursive: false, mode: 0o700 });
  } catch (error) {
    if (error && error.code === 'EEXIST') throw new NativeClaudeError('output_directory_race');
    throw new NativeClaudeError('output_directory_create_failed');
  }
  try {
    const stat = fileSystem.lstatSync(output);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new NativeClaudeError('output_directory_invalid');
  } catch (error) {
    throw new NativeClaudeError(safeErrorKind(error, 'output_directory_invalid'));
  }
  return output;
}

function validateExecutable(executable = CLAUDE_EXECUTABLE, fileSystem = fs) {
  if (typeof executable !== 'string'
    || path.resolve(executable).toLowerCase() !== path.resolve(CLAUDE_EXECUTABLE).toLowerCase()) {
    throw new NativeClaudeError('fixed_cli_path_required');
  }
  let stat;
  try {
    stat = fileSystem.lstatSync(executable);
  } catch (error) {
    if (error && error.code === 'ENOENT') throw new NativeClaudeError('missing_cli');
    throw new NativeClaudeError('cli_path_unavailable');
  }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new NativeClaudeError('cli_path_invalid');
  return path.resolve(executable);
}

const CHILD_ENV_KEYS = new Map([
    'PATH', 'SystemRoot', 'WINDIR', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP',
  'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA',
  'ProgramFiles', 'ProgramFiles(x86)', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN',
].map((name) => [name.toLowerCase(), name]));
const ANTHROPIC_AUTH_ENV_KEYS = new Set(['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN']);

function createChildEnvironment(sourceEnvironment = process.env, options = {}) {
  const environment = {};
  const valuesByName = new Map();
  for (const [name, value] of Object.entries(sourceEnvironment || {})) {
    const canonicalName = CHILD_ENV_KEYS.get(name.toLowerCase());
    if (!canonicalName || typeof value !== 'string') continue;
    const values = valuesByName.get(canonicalName) || [];
    values.push(value);
    valuesByName.set(canonicalName, values);
  }
  for (const [name, values] of valuesByName) {
    if (values.length === 1 && (options.includeAuth !== false || !ANTHROPIC_AUTH_ENV_KEYS.has(name))) {
      environment[name] = values[0];
    }
  }
  environment.CLAUDE_CODE_SAFE_MODE = '1';
  return environment;
}

function buildVersionArguments() {
  return ['--version'];
}

function buildClaudeArguments() {
  return [
    '--safe-mode',
    '--tools', '',
    '--no-session-persistence',
    '--strict-mcp-config',
    '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands',
    '--permission-mode', 'manual',
    '--permission-prompts', 'none',
    '--model', MODEL,
    '--effort', EFFORT,
    '--print',
    '--output-format', 'json',
    FIXED_PROMPT,
  ];
}

function createRunController() {
  let cancelRequested = false;
  let cancelReason = null;
  let terminal = false;
  const listeners = new Set();
  return {
    requestCancel(reason = 'cancel_requested') {
      if (terminal) return false;
      if (cancelRequested) {
        for (const listener of [...listeners]) listener(cancelReason);
        return false;
      }
      cancelRequested = true;
      cancelReason = /^[a-z][a-z0-9_]{0,63}$/.test(reason) ? reason : 'cancel_requested';
      for (const listener of [...listeners]) listener(cancelReason);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      if (cancelRequested) listener(cancelReason);
      return () => listeners.delete(listener);
    },
    markTerminal() { terminal = true; },
    snapshot() { return { requested: cancelRequested, reason: cancelReason, terminal }; },
  };
}

function createOwnedProcessRegistry(spawnImpl = spawn, controller = null) {
  const records = [];
  function start(command, args, options) {
    let child;
    try {
      child = spawnImpl(command, args, options);
    } catch (error) {
      return {
        record: null,
        errorCode: safeCode(error),
        errorKind: error && error.code === 'ENOENT' ? 'missing_cli' : 'spawn_error',
      };
    }
    if (!child || typeof child.once !== 'function' || typeof child.kill !== 'function') {
      return { record: null, errorCode: null, errorKind: 'spawn_error' };
    }
    let resolveClosed;
    const state = {
      started: false,
      startFailed: false,
      closeObserved: false,
      observationFinalized: false,
      finalizedExitObserved: null,
      exitCode: null,
      signal: null,
      errorCode: null,
      killRequested: false,
      killAttempted: false,
      killSucceeded: false,
      terminationSignalRequested: false,
      terminationSignalSucceeded: false,
      forceKillSignalRequested: false,
      forceKillSignalSucceeded: false,
      stdoutPipeDestroyAttempted: false,
      stdoutPipeDestroySucceeded: false,
      stderrPipeDestroyAttempted: false,
      stderrPipeDestroySucceeded: false,
      childUnreferenceAttempted: false,
      childUnreferenceSucceeded: false,
    };
    const closed = new Promise((resolve) => { resolveClosed = resolve; });
    function sendSignal(signal, requestedField, succeededField) {
      if (state.closeObserved || state.startFailed || state.observationFinalized) return false;
      if (state[requestedField]) return state[succeededField];
      state[requestedField] = true;
      state.killAttempted = true;
      try {
        state[succeededField] = child.kill(signal) === true;
      } catch {}
      if (state[succeededField]) {
        state.killRequested = true;
        state.killSucceeded = true;
      }
      return state[succeededField];
    }
    const record = {
      child,
      state,
      closed,
      requestStop() { return sendSignal('SIGTERM', 'terminationSignalRequested', 'terminationSignalSucceeded'); },
      requestForceKill() { return sendSignal('SIGKILL', 'forceKillSignalRequested', 'forceKillSignalSucceeded'); },
      finalizeUnknownExit(stdoutListener, stderrListener) {
        if (state.closeObserved || state.startFailed || state.observationFinalized) return false;
        state.observationFinalized = true;
        state.finalizedExitObserved = false;
        const releasePipe = (stream, listener, attemptedField, succeededField) => {
          if (!stream) return;
          if (listener && typeof stream.removeListener === 'function') {
            try { stream.removeListener('data', listener); } catch {}
          }
          if (typeof stream.destroy === 'function') {
            state[attemptedField] = true;
            try {
              stream.destroy();
              state[succeededField] = true;
            } catch {}
          }
          if (typeof stream.unref === 'function') {
            try { stream.unref(); } catch {}
          }
        };
        releasePipe(child.stdout, stdoutListener, 'stdoutPipeDestroyAttempted', 'stdoutPipeDestroySucceeded');
        releasePipe(child.stderr, stderrListener, 'stderrPipeDestroyAttempted', 'stderrPipeDestroySucceeded');
        if (typeof child.unref === 'function') {
          state.childUnreferenceAttempted = true;
          try {
            child.unref();
            state.childUnreferenceSucceeded = true;
          } catch {}
        }
        return true;
      },
    };
    records.push(record);
    child.once('spawn', () => { state.started = true; });
    child.once('error', (error) => {
      state.errorCode = safeCode(error);
      if (!state.started) {
        state.startFailed = true;
        state.closeObserved = true;
        resolveClosed(state);
      }
    });
    child.once('close', (code, signal) => {
      if (state.observationFinalized) {
        resolveClosed(state);
        return;
      }
      state.closeObserved = true;
      state.exitCode = Number.isSafeInteger(code) ? code : null;
      state.signal = safeSignal(signal);
      resolveClosed(state);
    });
    if (controller && controller.snapshot().requested) record.requestStop();
    return { record, errorCode: null, errorKind: null };
  }
  return {
    start,
    requestStopAll() { return records.map((record) => record.requestStop()); },
    snapshot() {
      const observedExit = (record) => record.state.observationFinalized
        ? record.state.finalizedExitObserved === true
        : record.state.closeObserved || record.state.startFailed;
      const any = (field) => records.some((record) => record.state[field]);
      return {
        count: records.length,
        allExitObserved: records.every(observedExit),
        killRequestedCount: records.filter((record) => record.state.killRequested).length,
        killAttemptedCount: records.filter((record) => record.state.killAttempted).length,
        killSucceededCount: records.filter((record) => record.state.killSucceeded).length,
        terminationSignalRequested: any('terminationSignalRequested'),
        terminationSignalSucceeded: any('terminationSignalSucceeded'),
        forceKillSignalRequested: any('forceKillSignalRequested'),
        forceKillSignalSucceeded: any('forceKillSignalSucceeded'),
        childUnreferenceAttempted: any('childUnreferenceAttempted'),
        childUnreferenceSucceeded: any('childUnreferenceSucceeded'),
        stdoutPipeDestroyAttempted: any('stdoutPipeDestroyAttempted'),
        stdoutPipeDestroySucceeded: any('stdoutPipeDestroySucceeded'),
        stderrPipeDestroyAttempted: any('stderrPipeDestroyAttempted'),
        stderrPipeDestroySucceeded: any('stderrPipeDestroySucceeded'),
      };
    },
    records,
  };
}

function errorKindFromSpawn(errorKind, errorCode) {
  if (errorKind === 'missing_cli' || errorCode === 'ENOENT') return 'missing_cli';
  return 'spawn_error';
}

function runOwnedCommand(registry, controller, command, args, options) {
  const started = registry.start(command, args, options.spawnOptions);
  if (!started.record) {
    return Promise.resolve({
      record: null,
      stdout: null,
      stdoutBytes: 0,
      stderrBytes: 0,
      overflow: false,
      timeout: false,
      exitObserved: true,
      exitCode: null,
      signal: null,
      spawnErrorKind: errorKindFromSpawn(started.errorKind, started.errorCode),
      spawnErrorCode: started.errorCode,
      killRequested: false,
    });
  }
  const { record } = started;
  const chunks = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let totalOutputBytes = 0;
  let overflow = false;
  let timedOut = false;
  let stopTimer = null;
  let forceKillTimer = null;
  let stopStarted = false;
  let done = false;
  let unsubscribeController = () => {};
  const maxBytes = options.maxOutputBytes;
  const graceMs = options.killGraceMs;
  let resolveOutcome;
  const outcome = new Promise((resolve) => { resolveOutcome = resolve; });
  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    beginStop();
  }, options.timeoutMs);
  const finish = (exitObserved) => {
    if (done) return;
    const state = record.state;
    const confirmedExit = exitObserved && (state.closeObserved || state.startFailed);
    done = true;
    clearTimeout(timeoutTimer);
    clearTimeout(stopTimer);
    clearTimeout(forceKillTimer);
    unsubscribeController();
    if (!confirmedExit) record.finalizeUnknownExit(onData, onStderr);
    resolveOutcome({
      record,
      stdout: confirmedExit && !overflow ? Buffer.concat(chunks).toString('utf8') : null,
      stdoutBytes,
      stderrBytes,
      overflow,
      timeout: timedOut,
      exitObserved: confirmedExit,
      exitCode: confirmedExit ? state.exitCode : null,
      signal: confirmedExit ? state.signal : null,
      spawnErrorKind: state.startFailed ? errorKindFromSpawn('spawn_error', state.errorCode) : null,
      spawnErrorCode: state.errorCode,
      killRequested: state.killRequested,
      killSucceeded: state.killSucceeded,
      terminationSignalRequested: state.terminationSignalRequested,
      terminationSignalSucceeded: state.terminationSignalSucceeded,
      forceKillSignalRequested: state.forceKillSignalRequested,
      forceKillSignalSucceeded: state.forceKillSignalSucceeded,
    });
  };
  function beginStop() {
    if (done || stopStarted) return;
    stopStarted = true;
    record.requestStop();
    stopTimer = setTimeout(() => {
      if (record.state.closeObserved || record.state.startFailed) {
        finish(true);
        return;
      }
      record.requestForceKill();
      forceKillTimer = setTimeout(() => {
        finish(record.state.closeObserved || record.state.startFailed);
      }, graceMs);
    }, graceMs);
  }
  const onData = (chunk) => {
    if (done || overflow) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    stdoutBytes += buffer.length;
    totalOutputBytes += buffer.length;
    if (totalOutputBytes > maxBytes) {
      overflow = true;
      chunks.length = 0;
      beginStop();
      return;
    }
    chunks.push(buffer);
  };
  const onStderr = (chunk) => {
    if (done || overflow) return;
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    stderrBytes += buffer.length;
    totalOutputBytes += buffer.length;
    if (totalOutputBytes > maxBytes) {
      overflow = true;
      chunks.length = 0;
      beginStop();
    }
  };
  if (record.child.stdout && typeof record.child.stdout.on === 'function') record.child.stdout.on('data', onData);
  if (record.child.stderr && typeof record.child.stderr.on === 'function') record.child.stderr.on('data', onStderr);
  if (controller) unsubscribeController = controller.subscribe(() => beginStop());
  if (controller && controller.snapshot().requested) beginStop();
  record.closed.then(() => finish(true));
  return outcome;
}

function parseVersionOutput(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_VERSION_OUTPUT_BYTES) return null;
  const match = stdout.trim().match(/^(?:Claude Code\s+)?v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s+\(Claude Code\))?$/);
  return match ? match[1] : null;
}

function parseModelUsage(parsed) {
  if (safeModelIdentifier(parsed.model)) return parsed.model;
  const usage = parsed.modelUsage;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const models = Object.keys(usage).filter((model) => safeModelIdentifier(model));
  return models.length === 1 ? models[0] : null;
}

function parseClaudeJson(stdout) {
  if (typeof stdout !== 'string' || Buffer.byteLength(stdout, 'utf8') > MAX_OUTPUT_BYTES) {
    return { valid: false, category: 'invalid_json' };
  }
  let parsed;
  try { parsed = JSON.parse(stdout); } catch { return { valid: false, category: 'invalid_json' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.type !== 'result') {
    return { valid: false, category: 'invalid_result_schema' };
  }
  const sessionId = safeUuid(parsed.session_id);
  const actualModel = parseModelUsage(parsed);
  const actualEffort = ['low', 'medium', 'high', 'xhigh', 'max'].includes(parsed.actual_effort)
    ? parsed.actual_effort : null;
  const toolCallCount = null;
  let category = null;
  let exactMatch = false;
  if (parsed.is_error === true || (typeof parsed.subtype === 'string' && parsed.subtype.startsWith('error'))) {
    category = 'cli_error';
  } else if (typeof parsed.result !== 'string') {
    category = 'invalid_result_schema';
  } else {
    let answer;
    try { answer = JSON.parse(parsed.result.trim()); } catch { answer = null; }
    if (!answer || typeof answer !== 'object' || Array.isArray(answer)) category = 'unsupported_result';
    else {
      const keys = Object.keys(answer).sort();
      const exactJson = /^\{\s*(?:"marker"\s*:\s*"POC163_RESULT"\s*,\s*"answer"\s*:\s*63|"answer"\s*:\s*63\s*,\s*"marker"\s*:\s*"POC163_RESULT")\s*\}$/;
      exactMatch = keys.length === 2 && keys[0] === 'answer' && keys[1] === 'marker'
        && answer.marker === EXPECTED_RESULT.marker && answer.answer === EXPECTED_RESULT.answer
        && exactJson.test(parsed.result.trim());
      category = exactMatch ? 'ok' : 'result_mismatch';
    }
  }
  return {
    valid: true,
    category,
    sessionId,
    actualModel,
    actualEffort,
    toolCallCount,
    toolCallObserved: toolCallCount !== null,
    exactMatch,
    safeResult: exactMatch ? EXPECTED_RESULT : null,
  };
}

function createBaseReport(outputDirectory, mode = 'claude_probe') {
  const claudeProbe = mode === 'claude_probe';
  return {
    schema_version: 1,
    experiment: 'poc163_vendor_routing_native',
    mode,
    output_directory: outputDirectory ? path.relative(REPOSITORY_ROOT, outputDirectory).split(path.sep).join('/') : null,
    cli: {
      version_at_help_capture: claudeProbe ? VERSION_AT_HELP_CAPTURE : null,
      observed_version: null,
    },
    request: {
      model_requested: claudeProbe ? MODEL : null,
      effort_requested: claudeProbe ? EFFORT : null,
      tools_requested: [],
      customizations_disabled: claudeProbe ? true : null,
      strict_empty_mcp_config_requested: claudeProbe ? true : null,
      slash_commands_disabled: claudeProbe ? true : null,
      session_persistence_disabled: claudeProbe ? true : null,
      permission_mode_requested: claudeProbe ? 'manual' : null,
      permission_prompts_requested: claudeProbe ? 'none' : null,
      permission_bypass_requested: false,
      actual_permission_mode: null,
      os_sandbox_inheritance_observed: false,
      os_sandbox_inheritance: 'unknown',
      cwd_scope: claudeProbe ? 'dedicated_run_directory' : 'fixture_run_directory',
      fixed_prompt_id: claudeProbe ? 'poc163-fixed-json-marker' : null,
      authentication_scope_requested: claudeProbe ? 'current_user_claude_auth_context' : 'none',
      home_copy_created: false,
      home_write_behavior_observed: false,
      admin_policy_may_remain_active: claudeProbe ? true : null,
      admin_policy_observed: false,
      process_ownership_scope: 'direct_child_processes_only',
      descendant_processes_observed: false,
    },
    process: {
      version_spawn_requested: false,
      version_process_started: false,
      version_exit_observed: null,
      version_exit_code: null,
      version_exit_signal: null,
      version_stdout_observed: false,
      version_stdout_bytes: null,
      version_stderr_observed: false,
      version_stderr_bytes: null,
      model_spawn_requested: false,
      model_process_started: false,
      model_exit_observed: null,
      model_exit_code: null,
      model_exit_signal: null,
      model_stdout_observed: false,
      model_stdout_bytes: null,
      model_stderr_observed: false,
      model_stderr_bytes: null,
      fixture_child_spawn_requested: false,
      fixture_child_started: false,
      fixture_child_kind: null,
      fixture_child_exit_observed: null,
      fixture_child_exit_code: null,
      fixture_child_exit_signal: null,
      output_overflow: false,
      timeout: false,
      spawn_error_category: null,
    },
    result: {
      session_uuid: null,
      actual_model: null,
      actual_effort: null,
      requested_model: claudeProbe ? MODEL : null,
      requested_effort: claudeProbe ? EFFORT : null,
      tool_call_count: null,
      tool_call_observed: false,
      exact_match: false,
      safe_result: null,
    },
    cancel: {
      requested: false,
      reason: null,
      kill_requested: false,
      kill_attempted: false,
      kill_succeeded: false,
      termination_signal_requested: false,
      termination_signal_succeeded: false,
      force_kill_signal_requested: false,
      force_kill_signal_succeeded: false,
      exit_observed: true,
    },
    failure_category: null,
    cleanup: {
      output_owned: false,
      output_retained: false,
      retained_for_unconfirmed_child: false,
      report_written: false,
      owned_child_count: 0,
      all_child_exits_observed: true,
      child_unreference_attempted: false,
      child_unreference_call_succeeded: false,
      stdout_pipe_destroy_attempted: false,
      stdout_pipe_destroy_call_succeeded: false,
      stderr_pipe_destroy_attempted: false,
      stderr_pipe_destroy_call_succeeded: false,
      descendant_process_tree_exit_observed: false,
    },
  };
}

function writeSafeReport(outputDirectory, report, fileSystem = fs) {
  assertNoSymlinkComponents(REPOSITORY_ROOT, outputDirectory, fileSystem);
  const filePath = path.join(outputDirectory, 'result.json');
  assertNoSymlinkComponents(outputDirectory, filePath, fileSystem, true);
  fileSystem.writeFileSync(filePath, JSON.stringify(report, null, 2) + '\n', {
    encoding: 'utf8', flag: 'wx', mode: 0o600,
  });
}

function normalizeFailureCategory(category) {
  return FAILURE_CATEGORIES.has(category) ? category : 'spawn_error';
}

function startClaudeProbe(rawOptions = {}, dependencies = {}) {
  const controller = createRunController();
  let registry = null;
  const completion = executeClaudeProbe(rawOptions, dependencies, controller, (processRegistry) => {
    registry = processRegistry;
  }).catch(() => {
    const report = createBaseReport(null);
    report.failure_category = 'spawn_error';
    return report;
  });
  return {
    completion,
    requestCancel: (reason) => {
      const accepted = controller.requestCancel(reason);
      if (!registry) return { accepted, kill_requested: false, exit_observed: true };
      const snapshot = registry.snapshot();
      return {
        accepted,
        kill_requested: snapshot.killRequestedCount > 0,
        exit_observed: snapshot.allExitObserved,
      };
    },
    get status() { return controller.snapshot(); },
  };
}

async function executeClaudeProbe(rawOptions, dependencies, controller, onRegistry) {
  const fileSystem = dependencies.fs || fs;
  const spawnImpl = dependencies.spawn || spawn;
  const report = createBaseReport(null);
  let stage = 'arguments';
  let output = null;
  let registry = null;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  try {
    timeoutMs = normalizeTimeout(rawOptions.timeoutMs);
    stage = 'output_validation';
    output = createOwnedOutputDirectory(rawOptions.outputDirectory || createOutputPath(), fileSystem);
    report.output_directory = path.relative(REPOSITORY_ROOT, output).split(path.sep).join('/');
    report.cleanup.output_owned = true;
    report.cleanup.output_retained = true;
    stage = 'workspace_setup';
    const workspace = path.join(output, 'workspace');
    fileSystem.mkdirSync(workspace, { recursive: false, mode: 0o700 });
    assertNoSymlinkComponents(output, workspace, fileSystem);
    stage = 'cli_validation';
    const executable = (dependencies.validateExecutable || validateExecutable)(CLAUDE_EXECUTABLE, fileSystem);
    registry = createOwnedProcessRegistry(spawnImpl, controller);
    onRegistry(registry);
    controller.subscribe(() => registry.requestStopAll());
    const sourceEnvironment = dependencies.environment || process.env;
    const createSpawnOptions = (env) => ({
      cwd: workspace,
      env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    stage = 'version_check';
    report.process.version_spawn_requested = true;
    const version = await runOwnedCommand(registry, controller, executable, buildVersionArguments(), {
      spawnOptions: createSpawnOptions(createChildEnvironment(sourceEnvironment, { includeAuth: false })),
      timeoutMs,
      killGraceMs: dependencies.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
      maxOutputBytes: MAX_VERSION_OUTPUT_BYTES,
    });
    report.process.version_process_started = version.record?.state.started === true;
    report.process.version_exit_observed = version.record ? version.exitObserved : null;
    report.process.version_exit_code = version.exitCode;
    report.process.version_exit_signal = version.signal;
    report.process.version_stdout_observed = report.process.version_process_started;
    report.process.version_stdout_bytes = report.process.version_process_started ? version.stdoutBytes : null;
    report.process.version_stderr_observed = report.process.version_process_started;
    report.process.version_stderr_bytes = report.process.version_process_started ? version.stderrBytes : null;
    if (version.spawnErrorKind) {
      report.process.spawn_error_category = version.spawnErrorKind;
      report.failure_category = version.spawnErrorKind;
      throw new NativeClaudeError(version.spawnErrorKind);
    }
    if (controller.snapshot().requested) {
      report.failure_category = 'cancelled';
      throw new NativeClaudeError('cancelled');
    }
    if (!version.exitObserved) {
      report.failure_category = version.timeout ? 'timeout' : 'spawn_error';
      throw new NativeClaudeError(report.failure_category);
    }
    if (version.timeout || version.overflow || version.exitCode !== 0) {
      report.failure_category = version.timeout ? 'timeout' : version.overflow ? 'output_overflow' : 'cli_version_failed';
      report.process.timeout = version.timeout;
      report.process.output_overflow = version.overflow;
      throw new NativeClaudeError(report.failure_category);
    }
    report.cli.observed_version = parseVersionOutput(version.stdout);
    if (!report.cli.observed_version) {
      report.failure_category = 'cli_version_invalid';
      throw new NativeClaudeError('cli_version_invalid');
    }
    if (controller.snapshot().requested) {
      report.failure_category = 'cancelled';
      throw new NativeClaudeError('cancelled');
    }
    stage = 'model_run';
    report.process.model_spawn_requested = true;
    const model = await runOwnedCommand(registry, controller, executable, buildClaudeArguments(), {
      spawnOptions: createSpawnOptions(createChildEnvironment(sourceEnvironment)),
      timeoutMs,
      killGraceMs: dependencies.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
      maxOutputBytes: MAX_OUTPUT_BYTES,
    });
    report.process.model_process_started = model.record?.state.started === true;
    report.process.model_exit_observed = model.record ? model.exitObserved : null;
    report.process.model_exit_code = model.exitCode;
    report.process.model_exit_signal = model.signal;
    report.process.model_stdout_observed = report.process.model_process_started;
    report.process.model_stdout_bytes = report.process.model_process_started ? model.stdoutBytes : null;
    report.process.model_stderr_observed = report.process.model_process_started;
    report.process.model_stderr_bytes = report.process.model_process_started ? model.stderrBytes : null;
    report.process.output_overflow = model.overflow;
    report.process.timeout = model.timeout;
    if (model.spawnErrorKind) {
      report.process.spawn_error_category = model.spawnErrorKind;
      report.failure_category = model.spawnErrorKind;
    } else if (controller.snapshot().requested) {
      report.failure_category = 'cancelled';
    } else if (model.overflow) {
      report.failure_category = 'output_overflow';
    } else if (model.timeout) {
      report.failure_category = 'timeout';
    } else if (!model.exitObserved) {
      report.failure_category = 'spawn_error';
    } else if (model.exitCode !== 0) {
      report.failure_category = 'cli_error';
    } else {
      const parsed = parseClaudeJson(model.stdout);
      report.failure_category = normalizeFailureCategory(parsed.category);
      if (!controller.snapshot().requested && parsed.valid) {
        report.result.session_uuid = parsed.sessionId;
        report.result.actual_model = parsed.actualModel;
        report.result.actual_effort = parsed.actualEffort;
        report.result.tool_call_count = parsed.toolCallCount;
        report.result.tool_call_observed = parsed.toolCallObserved;
        report.result.exact_match = parsed.exactMatch;
        report.result.safe_result = parsed.safeResult;
      }
    }
  } catch (error) {
    if (!report.failure_category) {
      const kind = safeErrorKind(error, 'spawn_error');
      report.failure_category = kind === 'missing_cli' ? 'missing_cli' : normalizeFailureCategory(kind);
    }
    if (stage === 'cli_validation' && report.failure_category === 'missing_cli') {
      report.process.spawn_error_category = 'missing_cli';
    }
  } finally {
    const cancellation = controller.snapshot();
    const registryStatus = registry ? registry.snapshot() : {
      count: 0,
      allExitObserved: true,
      killRequestedCount: 0,
      killAttemptedCount: 0,
      killSucceededCount: 0,
    };
    report.cancel.requested = cancellation.requested;
    report.cancel.reason = cancellation.reason;
    report.cancel.kill_requested = registryStatus.killRequestedCount > 0;
    report.cancel.kill_attempted = registryStatus.killAttemptedCount > 0;
    report.cancel.kill_succeeded = registryStatus.killSucceededCount > 0;
    report.cancel.termination_signal_requested = registryStatus.terminationSignalRequested === true;
    report.cancel.termination_signal_succeeded = registryStatus.terminationSignalSucceeded === true;
    report.cancel.force_kill_signal_requested = registryStatus.forceKillSignalRequested === true;
    report.cancel.force_kill_signal_succeeded = registryStatus.forceKillSignalSucceeded === true;
    report.cancel.exit_observed = registryStatus.allExitObserved;
    report.cleanup.owned_child_count = registryStatus.count;
    report.cleanup.all_child_exits_observed = registryStatus.allExitObserved;
    report.cleanup.retained_for_unconfirmed_child = !registryStatus.allExitObserved;
    report.cleanup.child_unreference_attempted = registryStatus.childUnreferenceAttempted === true;
    report.cleanup.child_unreference_call_succeeded = registryStatus.childUnreferenceSucceeded === true;
    report.cleanup.stdout_pipe_destroy_attempted = registryStatus.stdoutPipeDestroyAttempted === true;
    report.cleanup.stdout_pipe_destroy_call_succeeded = registryStatus.stdoutPipeDestroySucceeded === true;
    report.cleanup.stderr_pipe_destroy_attempted = registryStatus.stderrPipeDestroyAttempted === true;
    report.cleanup.stderr_pipe_destroy_call_succeeded = registryStatus.stderrPipeDestroySucceeded === true;
    if (output) {
      report.cleanup.output_owned = true;
      report.cleanup.output_retained = true;
      report.cleanup.report_written = true;
      try {
        writeSafeReport(output, report, fileSystem);
      } catch {
        report.cleanup.report_written = false;
      }
    }
    if (registryStatus.allExitObserved) controller.markTerminal();
  }
  return report;
}

async function runClaudeProbe(options = {}, dependencies = {}) {
  return startClaudeProbe(options, dependencies).completion;
}

function fixtureFailureCategory(fixture) {
  const categories = {
    limit: 'rate_limit_fixture',
    authentication: 'authentication_fixture',
    missing_cli: 'missing_cli_fixture',
  };
  return categories[fixture] || null;
}

function createMockChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    setImmediate(() => {
      child.stdout.end();
      child.stderr.end();
      child.emit('close', null, 'SIGTERM');
    });
    return true;
  };
  setImmediate(() => child.emit('spawn'));
  return child;
}

async function runCancellationFixture(options = {}, dependencies = {}) {
  const childMode = options.childMode || 'node';
  if (!['node', 'mock'].includes(childMode)) throw new NativeClaudeError('invalid_fixture_mode');
  const fileSystem = dependencies.fs || fs;
  const output = createOwnedOutputDirectory(options.outputDirectory || createOutputPath(), fileSystem);
  const report = createBaseReport(output, 'owned_cancel_fixture');
  const controller = createRunController();
  const spawnImpl = dependencies.spawn || (childMode === 'mock' ? () => createMockChild() : spawn);
  const registry = createOwnedProcessRegistry(spawnImpl, controller);
  controller.subscribe(() => registry.requestStopAll());
  const executable = childMode === 'node' ? process.execPath : 'native-cancel-mock';
  const args = childMode === 'node' ? ['-e', 'setInterval(() => {}, 1000)'] : [];
  const spawnOptions = {
    cwd: output,
    env: createChildEnvironment(dependencies.environment || process.env, { includeAuth: false }),
    shell: false,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  };
  report.process.fixture_child_spawn_requested = true;
  const command = runOwnedCommand(registry, controller, executable, args, {
    spawnOptions,
    timeoutMs: normalizeTimeout(options.timeoutMs === undefined ? 10_000 : options.timeoutMs),
    killGraceMs: dependencies.killGraceMs ?? DEFAULT_KILL_GRACE_MS,
    maxOutputBytes: 1024,
  });
  const cancelDelayMs = Number.isSafeInteger(options.cancelAfterMs) ? Math.max(0, Math.min(options.cancelAfterMs, 5000)) : 100;
  await new Promise((resolve) => setTimeout(resolve, cancelDelayMs));
  controller.requestCancel('fixture_cancel');
  const child = await command;
  report.process.fixture_child_started = child.record?.state.started === true;
  report.process.fixture_child_kind = childMode;
  report.process.fixture_child_exit_observed = child.record ? child.exitObserved : null;
  report.process.fixture_child_exit_code = child.exitCode;
  report.process.fixture_child_exit_signal = child.signal;
  report.process.output_overflow = child.overflow;
  report.process.spawn_error_category = child.spawnErrorKind;
  report.failure_category = child.spawnErrorKind
    || (child.record?.state.started && controller.snapshot().requested ? 'cancelled' : 'timeout');
  const snapshot = registry.snapshot();
  report.cancel.requested = true;
  report.cancel.reason = 'fixture_cancel';
  report.cancel.kill_requested = snapshot.killRequestedCount > 0;
  report.cancel.kill_attempted = snapshot.killAttemptedCount > 0;
  report.cancel.kill_succeeded = snapshot.killSucceededCount > 0;
  report.cancel.termination_signal_requested = snapshot.terminationSignalRequested;
  report.cancel.termination_signal_succeeded = snapshot.terminationSignalSucceeded;
  report.cancel.force_kill_signal_requested = snapshot.forceKillSignalRequested;
  report.cancel.force_kill_signal_succeeded = snapshot.forceKillSignalSucceeded;
  report.cancel.exit_observed = snapshot.allExitObserved;
  report.cleanup.output_owned = true;
  report.cleanup.output_retained = true;
  report.cleanup.retained_for_unconfirmed_child = !snapshot.allExitObserved;
  report.cleanup.owned_child_count = snapshot.count;
  report.cleanup.all_child_exits_observed = snapshot.allExitObserved;
  report.cleanup.child_unreference_attempted = snapshot.childUnreferenceAttempted;
  report.cleanup.child_unreference_call_succeeded = snapshot.childUnreferenceSucceeded;
  report.cleanup.stdout_pipe_destroy_attempted = snapshot.stdoutPipeDestroyAttempted;
  report.cleanup.stdout_pipe_destroy_call_succeeded = snapshot.stdoutPipeDestroySucceeded;
  report.cleanup.stderr_pipe_destroy_attempted = snapshot.stderrPipeDestroyAttempted;
  report.cleanup.stderr_pipe_destroy_call_succeeded = snapshot.stderrPipeDestroySucceeded;
  report.cleanup.report_written = true;
  try {
    writeSafeReport(output, report, fileSystem);
  } catch {
    report.cleanup.report_written = false;
  }
  if (snapshot.allExitObserved) controller.markTerminal();
  return report;
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--out', '--timeout-ms', '--mode', '--fixture-child', '--cancel-after-ms', '--fixture-category'].includes(option)
      || values.has(option) || !argv[index + 1] || argv[index + 1].startsWith('--')) {
      throw new NativeClaudeError('invalid_arguments');
    }
    values.set(option, argv[++index]);
  }
  const mode = values.get('--mode') || 'claude';
  if (!['claude', 'cancel-fixture', 'failure-fixture'].includes(mode)) throw new NativeClaudeError('invalid_mode');
  const timeoutText = values.get('--timeout-ms');
  const timeoutMs = values.has('--timeout-ms')
    ? (/^\d+$/.test(timeoutText) ? Number(timeoutText) : Number.NaN)
    : DEFAULT_TIMEOUT_MS;
  normalizeTimeout(timeoutMs);
  const fixtureChild = values.get('--fixture-child') || 'node';
  if (!['node', 'mock'].includes(fixtureChild)) throw new NativeClaudeError('invalid_fixture_mode');
  const cancelAfterMs = values.has('--cancel-after-ms') ? Number(values.get('--cancel-after-ms')) : 100;
  if (!Number.isSafeInteger(cancelAfterMs) || cancelAfterMs < 0 || cancelAfterMs > 5000) {
    throw new NativeClaudeError('invalid_cancel_delay');
  }
  const outputDirectory = values.has('--out') ? values.get('--out') : null;
  if (outputDirectory) validateOutputPath(outputDirectory);
  const fixtureCategory = values.get('--fixture-category') || null;
  if (mode === 'failure-fixture' && !fixtureFailureCategory(fixtureCategory)) {
    throw new NativeClaudeError('invalid_fixture_category');
  }
  return { mode, outputDirectory, timeoutMs, fixtureChild, cancelAfterMs, fixtureCategory };
}

function writeStdoutLine(value) {
  return new Promise((resolve) => process.stdout.write(value + '\n', resolve));
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  let options;
  try {
    options = parseArguments(argv);
  } catch (error) {
    await writeStdoutLine(JSON.stringify({ failure_category: safeErrorKind(error, 'invalid_arguments') }));
    process.exitCode = 2;
    return;
  }
  if (options.mode === 'failure-fixture') {
    await writeStdoutLine(JSON.stringify({
      mode: 'failure_fixture',
      failure_category: fixtureFailureCategory(options.fixtureCategory),
    }));
    return;
  }
  if (options.mode === 'cancel-fixture') {
    const report = await runCancellationFixture({
      outputDirectory: options.outputDirectory,
      timeoutMs: options.timeoutMs,
      childMode: options.fixtureChild,
      cancelAfterMs: options.cancelAfterMs,
    }, dependencies);
    await writeStdoutLine(JSON.stringify(report));
    return;
  }
  const run = startClaudeProbe({ outputDirectory: options.outputDirectory, timeoutMs: options.timeoutMs }, dependencies);
  const onSignal = () => { run.requestCancel('parent_signal'); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    const report = await run.completion;
    await writeStdoutLine(JSON.stringify(report));
  } finally {
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
  }
}

if (require.main === module) {
  main().catch(() => {
    process.stdout.write(JSON.stringify({ failure_category: 'native_probe_failed' }) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  CLAUDE_EXECUTABLE,
  DEFAULT_TIMEOUT_MS,
  EFFORT,
  EXPECTED_RESULT,
  FIXED_PROMPT,
  MAX_OUTPUT_BYTES,
  MODEL,
  NativeClaudeError,
  OUTPUT_PARENT,
  REPOSITORY_ROOT,
  VERSION_AT_HELP_CAPTURE,
  assertNoSymlinkComponents,
  buildClaudeArguments,
  buildVersionArguments,
  createBaseReport,
  createChildEnvironment,
  createOutputPath,
  createOwnedOutputDirectory,
  createOwnedProcessRegistry,
  createRunController,
  fixtureFailureCategory,
  parseArguments,
  parseClaudeJson,
  parseVersionOutput,
  runCancellationFixture,
  runClaudeProbe,
  runOwnedCommand,
  safeUuid,
  startClaudeProbe,
  validateExecutable,
  validateOutputPath,
  main,
};
