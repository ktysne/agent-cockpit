'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const { performance } = require('node:perf_hooks');
const {
  assertNoSymlinkComponents,
  commandFor,
  resolveOutputDirectory,
  setup,
  REPOSITORY_ROOT,
  REQUIRED_CODEX_VERSION,
} = require('../codex-hooks-identity/setup');
const {
  clearFixtureConfig,
  createFixtureRequestsSummary,
  execArguments,
  FIXTURE_MODEL,
  FIXTURE_TOOL,
  makeChildEnvironment: makeChildEnvironmentFromRunExec,
  startFixture,
} = require('../codex-hooks-identity/run-exec');
const { safeIdentifier } = require('./adapter');

const DEFAULT_TIMEOUT_MS = 40000;
const MAX_TIMEOUT_MS = 120000;
const MAX_CHILD_BYTES = 64 * 1024;
const MAX_RESULT_BYTES = 64 * 1024;
const MAX_NATIVE_EVENTS = 128;
const MAX_PROBE_DEPTH = 8;
const MAX_PROBE_NODES = 128;
const SYNTHETIC_CLAUDE_SESSION_ID = 'poc159-shared-claude-session';
const HOST_ID = 'codex-local';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const NATIVE_EVENT_TYPES = new Set([
  'thread.started', 'thread.closed', 'turn.started', 'turn.completed', 'turn.failed', 'turn.interrupted', 'Stop',
]);
const EVENT_STATUS = new Set([
  'queued', 'started', 'in_progress', 'running', 'completed', 'failed', 'interrupted', 'cancelled', 'unknown',
]);
const HOOK_EVENTS = [
  'SessionStart', 'SessionEnd', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
  'PreCompact', 'PostCompact', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
];
const ENV_VARS = [
  'CLAUDE_CODE_SESSION_ID', 'POC159_RUN_ID', 'POC159_ATTEMPT_ID', 'POC159_NONCE',
  'POC159_EXPECTED_NONCE', 'POC159_EXPECTED_CLAUDE_SESSION_ID',
];

function usage() {
  return 'Usage: node run-native.js --codex-path <codex.exe> --out poc/out/<slug> [--timeout-ms 40000]';
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--codex-path', '--out', '--timeout-ms'].includes(option) || values.has(option) || !argv[index + 1]) {
      throw new Error(usage());
    }
    values.set(option, argv[index + 1]);
    index += 1;
  }
  if (!values.has('--codex-path') || !values.has('--out')) throw new Error(usage());
  const timeoutMs = values.has('--timeout-ms') ? Number(values.get('--timeout-ms')) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > MAX_TIMEOUT_MS) throw new Error(usage());
  return {
    codexPath: values.get('--codex-path'),
    outputDirectory: values.get('--out'),
    timeoutMs,
  };
}

function tomlString(value) {
  return JSON.stringify(value);
}

function renderMcpConfig(adapterPath) {
  return [
    '[mcp_servers.poc157_identity]',
    'command = "node"',
    `args = [${tomlString(adapterPath)}, "--mcp"]`,
    `env_vars = [${ENV_VARS.map(tomlString).join(', ')}]`,
    '',
  ].join('\n');
}

function quoteCommandArgument(value, platform) {
  if (platform === 'win32') {
    if (/[&|<>^%!"\r\n]/.test(value)) throw new Error('Hook command path contains an unsupported character');
    return `"${value}"`;
  }
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function renderHooksConfig(adapterPath, capturePath, enabled, platform = process.platform) {
  const hooks = {};
  if (enabled) {
    const command = `${commandFor(adapterPath, platform)} --hook --capture-file ${quoteCommandArgument(capturePath, platform)}`;
    const handler = { type: 'command', command, timeout: 3 };
    const windowsCommand = platform === 'win32' ? null
      : `${commandFor(adapterPath, 'win32')} --hook --capture-file ${quoteCommandArgument(capturePath, 'win32')}`;
    for (const eventName of HOOK_EVENTS) hooks[eventName] = [{ hooks: [windowsCommand ? { ...handler, command_windows: windowsCommand } : handler] }];
  }
  return `${JSON.stringify({
    description: 'Codex native identity probe; records allowlisted metadata only.',
    hooks,
  }, null, 2)}\n`;
}

function writeGeneratedFile(filePath, contents) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Generated PoC file must remain a regular file');
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', mode: 0o600 });
}

function makeSlots() {
  const parentSessionId = SYNTHETIC_CLAUDE_SESSION_ID;
  return [
    { label: 'standalone-a', origin: 'standalone', hooksEnabled: true, parent: null },
    {
      label: 'delegated-a', origin: 'delegated', hooksEnabled: true,
      parent: { provider: 'claude-code', sessionId: parentSessionId, toolUseId: randomUUID() },
    },
    { label: 'standalone-b', origin: 'standalone', hooksEnabled: true, parent: null },
    {
      label: 'delegated-b', origin: 'delegated', hooksEnabled: false,
      parent: { provider: 'claude-code', sessionId: parentSessionId, agentId: `poc159-agent-${randomUUID()}`, toolUseId: randomUUID() },
    },
  ].map(definition => ({
    ...definition,
    launchId: randomUUID(),
    runId: randomUUID(),
    attemptId: randomUUID(),
    homeScope: `poc159-${randomUUID()}`,
    hostId: HOST_ID,
    bindingNonce: randomBytes(32).toString('hex'),
  }));
}

function makeChildEnvironment(parentEnvironment, home, slot) {
  const environment = makeChildEnvironmentBase(parentEnvironment, home);
  Object.assign(environment, {
    CLAUDE_CODE_SESSION_ID: SYNTHETIC_CLAUDE_SESSION_ID,
    POC159_RUN_ID: slot.runId,
    POC159_ATTEMPT_ID: slot.attemptId,
    POC159_NONCE: slot.bindingNonce,
    POC159_EXPECTED_NONCE: slot.bindingNonce,
    POC159_EXPECTED_CLAUDE_SESSION_ID: SYNTHETIC_CLAUDE_SESSION_ID,
  });
  return environment;
}

function makeChildEnvironmentBase(parentEnvironment, home) {
  return makeChildEnvironmentFromRunExec(parentEnvironment, home);
}

function safeProbe(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const registration = value.registration && typeof value.registration === 'object' ? value.registration : {};
  const inherited = value.inherited_session && typeof value.inherited_session === 'object' ? value.inherited_session : {};
  const meta = value.mcp_meta && typeof value.mcp_meta === 'object' ? value.mcp_meta : {};
  return {
    run_id: safeIdentifier(registration.run_id),
    attempt_id: safeIdentifier(registration.attempt_id),
    nonce_match: registration.nonce_match === true,
    inherited_session_present: inherited.present === true,
    inherited_session_matches_expected: typeof inherited.matches_expected === 'boolean' ? inherited.matches_expected : null,
    thread_id: safeIdentifier(meta.thread_id),
  };
}

function findProbe(value, state = { nodes: 0 }, depth = 0) {
  if (depth > MAX_PROBE_DEPTH || state.nodes >= MAX_PROBE_NODES || value === null || value === undefined) return null;
  state.nodes += 1;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > 16 * 1024) return null;
    try {
      return findProbe(JSON.parse(value), state, depth + 1);
    } catch {
      return null;
    }
  }
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 16)) {
      const probe = findProbe(item, state, depth + 1);
      if (probe) return probe;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  if (Object.hasOwn(value, 'registration') && Object.hasOwn(value, 'mcp_meta')) return safeProbe(value);
  for (const key of ['item', 'result', 'content', 'output', 'text']) {
    if (!Object.hasOwn(value, key)) continue;
    const probe = findProbe(value[key], state, depth + 1);
    if (probe) return probe;
  }
  return null;
}

function nativeThreadId(event) {
  const candidate = event && (event.thread_id || event.threadId || (event.thread && event.thread.id));
  return safeIdentifier(candidate);
}

function nativeEventProjection(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event) || typeof event.type !== 'string') return null;
  if (!NATIVE_EVENT_TYPES.has(event.type)) return null;
  const projection = { type: event.type };
  const threadId = nativeThreadId(event);
  if (threadId) projection.thread_id = threadId;
  const eventId = safeIdentifier(event.id);
  if (eventId) projection.event_id = eventId;
  if (typeof event.status === 'string') projection.status = EVENT_STATUS.has(event.status) ? event.status : 'unknown';
  const turnId = safeIdentifier(event.turn_id || event.turnId || (event.turn && event.turn.id));
  if (turnId) projection.turn_id = turnId;
  return projection;
}

function nativeExecArguments(layout, slot) {
  const args = execArguments(layout, 'mcp');
  const instruction = args.pop();
  args.push('-c', `features.hooks=${slot.hooksEnabled ? 'true' : 'false'}`, instruction);
  return args;
}

function fixtureMcpProbe(event) {
  const item = event && event.item;
  if (!event || event.type !== 'item.completed' || !item || typeof item !== 'object' || Array.isArray(item) ||
    item.type !== 'mcp_tool_call' || item.server !== 'poc157_identity' || item.tool !== 'probe_identity') return null;
  return findProbe(item.result);
}

function createNativeEventCollector(maxBytes = MAX_CHILD_BYTES) {
  const { StringDecoder } = require('node:string_decoder');
  let decoder = new StringDecoder('utf8');
  let pending = '';
  let totalBytes = 0;
  let overflow = false;
  let finished = false;
  let malformedLineCount = 0;
  let omittedEventCount = 0;
  let eventCount = 0;
  let threadStartedCount = 0;
  let mcpCallCount = 0;
  const threadIds = new Set();
  const eventCounts = Object.create(null);
  const nativeEvents = [];
  const probes = [];
  let threadId = null;

  const consumeLine = (line) => {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      malformedLineCount += 1;
      return;
    }
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      malformedLineCount += 1;
      return;
    }
    eventCount += 1;
    const projection = nativeEventProjection(event);
    if (projection) {
      eventCounts[projection.type] = (eventCounts[projection.type] || 0) + 1;
      if (projection.type === 'thread.started') {
        threadStartedCount += 1;
        if (projection.thread_id) threadIds.add(projection.thread_id);
        threadId = threadIds.size === 1 ? threadIds.values().next().value : null;
      }
      if (nativeEvents.length < MAX_NATIVE_EVENTS) nativeEvents.push(projection);
      else omittedEventCount += 1;
    }
    const probe = fixtureMcpProbe(event);
    if (probe) {
      mcpCallCount += 1;
      if (probes.length < 4) probes.push(probe);
    }
  };

  const consumeText = (text) => {
    let start = 0;
    let newline;
    while ((newline = text.indexOf('\n', start)) >= 0) {
      const line = pending + text.slice(start, newline).replace(/\r$/, '');
      pending = '';
      if (Buffer.byteLength(line, 'utf8') > maxBytes) malformedLineCount += 1;
      else consumeLine(line);
      start = newline + 1;
    }
    pending += text.slice(start);
    if (Buffer.byteLength(pending, 'utf8') > maxBytes) {
      pending = '';
      malformedLineCount += 1;
    }
  };

  return {
    consume(chunk) {
      if (finished || overflow) return false;
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (totalBytes > maxBytes) {
        overflow = true;
        pending = '';
        return false;
      }
      consumeText(decoder.write(buffer));
      return true;
    },
    finish() {
      if (!finished) {
        if (!overflow) consumeText(decoder.end());
        finished = true;
      }
      if (!overflow && pending) consumeLine(pending.replace(/\r$/, ''));
      pending = '';
      return {
        bytes: totalBytes,
        overflow,
        malformed_line_count: malformedLineCount,
        omitted_event_count: omittedEventCount,
        event_count: eventCount,
        event_counts: eventCounts,
        thread_started_count: threadStartedCount,
        thread_id: threadId,
        thread_id_count: threadIds.size,
        multiple_thread_ids: threadIds.size > 1,
        mcp_call_count: mcpCallCount,
        mcp_probes: probes,
        native_events: nativeEvents,
      };
    },
  };
}

function createConcurrencyTracker() {
  const intervals = new Map();
  return {
    started(id) {
      if (!intervals.has(id)) intervals.set(id, { start: performance.now(), end: null });
    },
    ended(id) {
      const interval = intervals.get(id);
      if (interval && interval.end === null) interval.end = performance.now();
    },
    summarize(expected = 0) {
      const events = [];
      for (const interval of intervals.values()) {
        if (interval.end === null) continue;
        events.push({ time: interval.start, delta: 1 }, { time: interval.end, delta: -1 });
      }
      events.sort((left, right) => left.time - right.time || right.delta - left.delta);
      let active = 0;
      let maximum = 0;
      for (const event of events) {
        active += event.delta;
        maximum = Math.max(maximum, active);
      }
      return {
        spawned_count: intervals.size,
        completed_interval_count: events.length / 2,
        expected_count: expected,
        overlap_observed: maximum > 1,
        maximum_concurrent: maximum,
      };
    },
  };
}

function createStopController(signalSource = process) {
  let signal = null;
  let terminated = false;
  const children = new Set();
  const onInterrupt = name => {
    if (!signal) signal = name;
    terminated = true;
    for (const child of children) try { child.kill(); } catch {}
  };
  const onSigint = () => onInterrupt('SIGINT');
  const onSigterm = () => onInterrupt('SIGTERM');
  signalSource.on('SIGINT', onSigint);
  signalSource.on('SIGTERM', onSigterm);
  return {
    get signal() { return signal; },
    add(child) {
      if (signal || terminated) {
        try { child.kill(); } catch {}
      }
      children.add(child);
    },
    remove(child) { children.delete(child); },
    terminate() {
      terminated = true;
      for (const child of children) try { child.kill(); } catch {}
    },
    dispose() {
      signalSource.off('SIGINT', onSigint);
      signalSource.off('SIGTERM', onSigterm);
    },
  };
}

function runNativeChild(executable, layout, slot, options = {}) {
  const tracker = options.tracker;
  const stopController = options.stopController;
  const timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS;
  const environment = makeChildEnvironment(options.environment || process.env, layout.home, slot);
  return new Promise(resolve => {
    let child;
    let timedOut = false;
    let spawnErrorCode = null;
    let interrupted = false;
    let settled = false;
    const collector = createNativeEventCollector();
    let stderrBytes = 0;
    let stderrOverflow = false;
    let escalationTimer = null;
    let timer = null;

    const finish = (exitCode, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      if (child) stopController.remove(child);
      if (tracker) tracker.ended(slot.launchId);
      resolve({
        exit_code: Number.isInteger(exitCode) ? exitCode : null,
        signal: typeof signal === 'string' ? signal : null,
        timed_out: timedOut,
        interrupted,
        spawn_error_code: spawnErrorCode || 'none',
        stderr_bytes: stderrBytes,
        stderr_overflow: stderrOverflow,
        ...collector.finish(),
      });
    };

    const terminate = () => {
      if (!child || child.exitCode !== null) return;
      try { child.kill(); } catch {}
      if (!escalationTimer) {
        escalationTimer = setTimeout(() => {
          if (child.exitCode === null) {
            try { child.kill('SIGKILL'); } catch {}
          }
        }, 1000);
      }
    };

    try {
      child = spawn(executable, nativeExecArguments(layout, slot), {
        cwd: layout.repo,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      spawnErrorCode = /^[A-Z0-9_]{1,32}$/.test(error && error.code || '') ? error.code : 'unknown';
      finish(null, null);
      return;
    }

    stopController.add(child);
    timer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, timeoutMs);
    child.once('spawn', () => tracker && tracker.started(slot.launchId));
    child.stdout.on('data', chunk => {
      if (!collector.consume(chunk)) terminate();
    });
    child.stderr.on('data', chunk => {
      const length = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(String(chunk));
      if (stderrBytes + length > MAX_CHILD_BYTES) stderrOverflow = true;
      stderrBytes = Math.min(MAX_CHILD_BYTES, stderrBytes + length);
    });
    child.on('error', error => {
      spawnErrorCode = /^[A-Z0-9_]{1,32}$/.test(error && error.code || '') ? error.code : 'unknown';
      finish(null, null);
    });
    child.on('close', (code, signal) => {
      interrupted = Boolean(stopController.signal);
      finish(code, signal);
    });
    child.stdin.end();
  });
}

function summarizeHookCapture(filePath, slot) {
  const empty = { count: 0, registration_mismatch_count: 0, event_counts: {}, session_ids: [], agent_ids: [] };
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CHILD_BYTES) return { ...empty, overflow: stat.size > MAX_CHILD_BYTES };
    const content = fs.readFileSync(filePath, 'utf8');
    const sessionIds = new Set();
    const agentIds = new Set();
    const eventCounts = Object.create(null);
    let count = 0;
    let registrationMismatchCount = 0;
    for (const line of content.split(/\r?\n/).slice(0, MAX_NATIVE_EVENTS)) {
      if (!line) continue;
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      if (!record || typeof record !== 'object' || Array.isArray(record)) continue;
      if (record.run_id !== slot.runId || record.attempt_id !== slot.attemptId) {
        registrationMismatchCount += 1;
        continue;
      }
      if (record.claude_session_present !== true || record.claude_session_matches_expected !== true) {
        registrationMismatchCount += 1;
        continue;
      }
      count += 1;
      const event = safeIdentifier(record.event);
      if (event && HOOK_EVENTS.includes(event)) eventCounts[event] = (eventCounts[event] || 0) + 1;
      const sessionId = safeIdentifier(record.session_id);
      const agentId = safeIdentifier(record.agent_id);
      if (sessionId && sessionIds.size < 8) sessionIds.add(sessionId);
      if (agentId && agentIds.size < 8) agentIds.add(agentId);
    }
    return {
      count,
      registration_mismatch_count: registrationMismatchCount,
      event_counts: eventCounts,
      session_ids: [...sessionIds],
      agent_ids: [...agentIds],
      overflow: false,
    };
  } catch (error) {
    return { ...empty, overflow: false, available: error.code !== 'ENOENT' };
  }
}

function summarizeModelProject(project) {
  const counts = project && project.counts && typeof project.counts === 'object' ? project.counts : {};
  const safeCounts = {};
  for (const key of ['independent', 'confirmed_delegated', 'related_unknown', 'audit_only', 'running', 'unknown_end']) {
    safeCounts[key] = Number.isSafeInteger(counts[key]) && counts[key] >= 0 ? counts[key] : 0;
  }
  const rows = Array.isArray(project && project.rows) ? project.rows.slice(0, 16).map(row => ({
    origin: ['standalone', 'delegated', 'review'].includes(row.origin) ? row.origin : 'unknown',
    host_id: safeIdentifier(row.hostId || row.host_id),
    home_scope: safeIdentifier(row.homeScope || row.home_scope),
    thread_id: safeIdentifier(row.threadId || row.thread_id),
    run_id: safeIdentifier(row.runId || row.run_id),
    attempt_id: safeIdentifier(row.attemptId || row.attempt_id),
    parent_agent_id: safeIdentifier(row.parent && row.parent.agentId || row.parent_agent_id),
    status: safeIdentifier(row.status) || 'unknown',
  })) : [];
  return { counts: safeCounts, rows };
}

function sameParent(expected, actual) {
  if (expected === null) return actual === null || actual === undefined;
  if (!expected || !actual || typeof actual !== 'object') return false;
  return expected.provider === actual.provider && expected.sessionId === actual.sessionId &&
    (safeIdentifier(expected.agentId) || null) === (safeIdentifier(actual.agentId) || null) &&
    expected.toolUseId === actual.toolUseId;
}

function ingestNativeEvents(model, slot, child, bound, boundThreadId) {
  let accepted = 0;
  for (let index = 0; index < child.native_events.length; index += 1) {
    const event = child.native_events[index];
    if (!event.thread_id) continue;
    const exactBinding = bound && event.thread_id === boundThreadId;
    const result = model.ingestNative({
      eventId: event.event_id || `native-${slot.runId}-${index}`,
      hostId: slot.hostId,
      homeScope: slot.homeScope,
      threadId: event.thread_id,
      ...(event.turn_id ? { turnId: event.turn_id } : {}),
      type: event.type,
      ...(event.status ? { status: event.status } : {}),
      ...(exactBinding ? { launchId: slot.launchId, runId: slot.runId, attemptId: slot.attemptId } : {}),
    });
    if (result === true) accepted += 1;
  }
  return accepted;
}

function buildJobSummary(slot, started, child, hooks, model) {
  const probe = child.mcp_probes.length === 1 ? child.mcp_probes[0] : null;
  const threadId = child.thread_id;
  const idsMatch = Boolean(threadId && probe && threadId === probe.thread_id);
  const registrationMatches = Boolean(probe && probe.run_id === slot.runId && probe.attempt_id === slot.attemptId && probe.nonce_match);
  const runnerNonceMatches = started.childEnvironment.POC159_NONCE === slot.bindingNonce &&
    started.childEnvironment.POC159_EXPECTED_NONCE === slot.bindingNonce;
  const bindAttempted = idsMatch && registrationMatches && runnerNonceMatches && child.thread_started_count > 0 &&
    child.thread_id_count === 1 && !child.multiple_thread_ids && child.malformed_line_count === 0 && !child.overflow;
  const bound = bindAttempted && model.bindNative({
    launchId: slot.launchId,
    runId: slot.runId,
    attemptId: slot.attemptId,
    bindingNonce: slot.bindingNonce,
    hostId: slot.hostId,
    homeScope: slot.homeScope,
    threadId,
  }) === true;
  const nativeEventIngestCount = ingestNativeEvents(model, slot, child, bound, threadId);
  const destination = bound ? model.resolveMcpDestination({
    hostId: slot.hostId,
    homeScope: slot.homeScope,
    threadId,
  }) : null;
  const expectedKind = slot.origin === 'standalone' ? 'independent' : 'delegated';
  const destinationMatches = Boolean(destination && destination.kind === expectedKind &&
    destination.launchId === slot.launchId && destination.runId === slot.runId && destination.attemptId === slot.attemptId &&
    destination.hostId === slot.hostId && destination.homeScope === slot.homeScope && destination.threadId === threadId &&
    sameParent(slot.parent, destination.parent));
  const expectedParent = slot.parent && slot.parent.sessionId === SYNTHETIC_CLAUDE_SESSION_ID;
  const hookRowsMatch = slot.hooksEnabled
    ? hooks.count === 0 || hooks.registration_mismatch_count === 0
    : hooks.count === 0;
  const hookOffClean = slot.hooksEnabled || hooks.count === 0;
  const fixtureSummary = createFixtureRequestsSummary(started.fixture.requests);
  return {
    label: slot.label,
    launch_id: slot.launchId,
    run_id: slot.runId,
    attempt_id: slot.attemptId,
    origin: slot.origin,
    parent_session_present: Boolean(expectedParent),
    parent_agent_present: Boolean(slot.parent && safeIdentifier(slot.parent.agentId)),
    claude_session_inherited: probe ? probe.inherited_session_present : false,
    claude_session_matches_expected: probe ? probe.inherited_session_matches_expected : null,
    hook_config_enabled: slot.hooksEnabled,
    hook_capture: hooks,
    native: {
      exit_code: child.exit_code,
      signal: child.signal || 'none',
      timed_out: child.timed_out,
      interrupted: child.interrupted,
      spawn_error_code: child.spawn_error_code,
      stdout_bytes: child.bytes,
      stdout_overflow: child.overflow,
      stderr_bytes: child.stderr_bytes,
      stderr_overflow: child.stderr_overflow,
      event_count: child.event_count,
      event_counts: child.event_counts,
      malformed_line_count: child.malformed_line_count,
      thread_started_count: child.thread_started_count,
      thread_id: threadId,
      thread_id_count: child.thread_id_count,
      multiple_thread_ids: child.multiple_thread_ids,
      mcp_call_count: child.mcp_call_count,
      mcp_thread_id: probe ? probe.thread_id : null,
      registration_matches: registrationMatches,
      runner_nonce_matches: runnerNonceMatches,
      thread_matches_mcp_meta: idsMatch,
      binding_attempted: bindAttempted,
      binding_accepted: bound,
      native_event_ingest_count: nativeEventIngestCount,
      destination_kind: destination ? destination.kind : 'unknown',
      destination_matches_launch: destinationMatches,
      fixture_request_count: fixtureSummary.request_count,
      fixture_tool_names: fixtureSummary.tool_names,
      fixture_tool_seen: fixtureSummary.tool_names.includes(FIXTURE_TOOL),
      fixture_unsupported: started.fixture.unsupported !== null,
      hook_event_observed: slot.hooksEnabled && hooks.count > 0,
      hook_rows_match_registration: hookRowsMatch,
      hook_disabled_has_no_rows: hookOffClean,
    },
  };
}

function buildResult({ slots, startedBySlot, childBySlot, hooksBySlot, model, tracker, outputDirectory, setupFailure, stopSignal }) {
  const sameCwd = startedBySlot.length === slots.length && startedBySlot.every(item => path.resolve(item.started.layout.repo) === path.resolve(startedBySlot[0].started.layout.repo));
  const jobs = slots.map(slot => {
    const entry = startedBySlot.find(item => item.slot.launchId === slot.launchId);
    const child = childBySlot.get(slot.launchId) || emptyChildResult();
    const hooks = hooksBySlot.get(slot.launchId) || { count: 0, registration_mismatch_count: 0, event_counts: {}, session_ids: [], agent_ids: [], overflow: false, available: false };
    if (!entry) return { label: slot.label, launch_id: slot.launchId, run_id: slot.runId, attempt_id: slot.attemptId, origin: slot.origin, started: false };
    const summary = buildJobSummary(slot, { ...entry.started, childEnvironment: entry.childEnvironment }, child, hooks, model);
    return { ...summary, started: true };
  });
  const concurrency = tracker.summarize(slots.length);
  const counts = {
    standalone: jobs.filter(job => job.origin === 'standalone' && job.started && job.native && job.native.binding_accepted).length,
    delegated: jobs.filter(job => job.origin === 'delegated' && job.started && job.native && job.native.binding_accepted).length,
  };
  const project = summarizeModelProject(model.project());
  const completed = jobs.length === 4 && jobs.every(job => job.started && job.native && job.native.exit_code === 0 &&
    !job.native.timed_out && !job.native.interrupted && !job.native.stdout_overflow && !job.native.stderr_overflow &&
    job.native.malformed_line_count === 0 && job.native.thread_started_count > 0 && job.native.thread_id_count === 1 &&
    !job.native.multiple_thread_ids && job.native.event_counts['turn.completed'] >= 1 &&
    !job.native.event_counts['turn.failed'] && !job.native.event_counts['turn.interrupted'] &&
    job.native.mcp_call_count === 1 && job.native.registration_matches &&
    job.native.runner_nonce_matches && job.native.thread_matches_mcp_meta && job.native.binding_accepted &&
    job.native.destination_matches_launch && job.native.native_event_ingest_count > 0 && job.native.fixture_request_count >= 2 &&
    job.native.fixture_tool_seen && !job.native.fixture_unsupported &&
    job.native.hook_disabled_has_no_rows && job.native.hook_rows_match_registration && !job.hook_capture.overflow);
  const overlap = concurrency.maximum_concurrent === slots.length && concurrency.spawned_count === slots.length &&
    concurrency.completed_interval_count === slots.length;
  const correctProjection = counts.standalone === 2 && counts.delegated === 2 &&
    project.counts.independent === 2 && project.counts.confirmed_delegated === 2;
  const success = setupFailure === null && !stopSignal && sameCwd && overlap && completed && correctProjection;
  const failureReasons = [];
  if (setupFailure) failureReasons.push(setupFailure);
  if (stopSignal) failureReasons.push('interrupted');
  if (!sameCwd) failureReasons.push('shared_cwd_not_confirmed');
  if (!overlap) failureReasons.push('parallel_overlap_not_observed');
  if (!completed) failureReasons.push('native_job_incomplete');
  if (!correctProjection) failureReasons.push('identity_model_projection_mismatch');
  return {
    schema: 'agent-cockpit-poc159-native-v1',
    backend: { source: 'local_responses_fixture', model: FIXTURE_MODEL, real_model_observed: false },
    target_version: REQUIRED_CODEX_VERSION,
    output_scope: path.relative(REPOSITORY_ROOT, outputDirectory).split(path.sep).join('/'),
    same_cwd: sameCwd,
    all_jobs_used_mcp_first_fixture: true,
    inherited_claude_session_id_shared: true,
    result_is_bridge_integration: false,
    setup_failure: setupFailure || 'none',
    stop_signal: stopSignal || 'none',
    concurrency,
    registration_counts: counts,
    jobs,
    model_projection: project,
    success,
    failure_reasons: failureReasons,
  };
}

function emptyChildResult() {
  return {
    exit_code: null,
    signal: null,
    timed_out: false,
    interrupted: false,
    spawn_error_code: 'not_started',
    stderr_bytes: 0,
    stderr_overflow: false,
    bytes: 0,
    overflow: false,
    malformed_line_count: 0,
    omitted_event_count: 0,
    event_count: 0,
    event_counts: {},
    thread_started_count: 0,
    thread_id: null,
    thread_id_count: 0,
    multiple_thread_ids: false,
    mcp_call_count: 0,
    mcp_probes: [],
    native_events: [],
  };
}

function errorCategory(error) {
  const code = error && error.code;
  return typeof code === 'string' && /^[A-Z0-9_]{1,32}$/.test(code) ? `error_${code.toLowerCase()}` : 'runner_error';
}

function cleanupRuntimeHomes(outputDirectory) {
  const runtimeHomes = path.join(outputDirectory, 'runtime-homes');
  try {
    const rootStat = fs.lstatSync(runtimeHomes);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
  } catch (error) {
    return error.code === 'ENOENT';
  }
  assertNoSymlinkComponents(outputDirectory, runtimeHomes);
  for (const name of fs.readdirSync(runtimeHomes)) {
    if (!UUID.test(name)) return false;
    const home = path.join(runtimeHomes, name);
    const stat = fs.lstatSync(home);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return false;
    assertNoSymlinkComponents(outputDirectory, home);
    fs.rmSync(home, { recursive: true, force: false });
  }
  try { fs.rmdirSync(runtimeHomes); } catch (error) { if (error.code !== 'ENOENT') return false; }
  return true;
}

function writeResult(outputDirectory, result) {
  const filePath = path.join(outputDirectory, 'native-results.json');
  assertNoSymlinkComponents(REPOSITORY_ROOT, filePath);
  const contents = `${JSON.stringify(result, null, 2)}\n`;
  if (Buffer.byteLength(contents, 'utf8') > MAX_RESULT_BYTES) throw new Error('result_limit_exceeded');
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  return filePath;
}

async function runNativeProbe(options, dependencies = {}) {
  const outputDirectory = resolveOutputDirectory(options.outputDirectory);
  if (fs.existsSync(outputDirectory)) throw new Error('Output directory must be new and owned by this run');
  const modelModule = dependencies.modelModule || require('./identity-model');
  const model = dependencies.model || new modelModule.DelegationIdentityModel();
  const setupRun = dependencies.setup || setup;
  const startFixtureRun = dependencies.startFixture || startFixture;
  const runChild = dependencies.runChild || runNativeChild;
  const clearConfig = dependencies.clearFixtureConfig || clearFixtureConfig;
  const signalSource = dependencies.signalSource || process;
  const stopController = createStopController(signalSource);
  const slots = (dependencies.makeSlots || makeSlots)();
  const startedBySlot = [];
  const childBySlot = new Map();
  const hooksBySlot = new Map();
  const tracker = createConcurrencyTracker();
  let outputPath = null;
  let setupFailure = null;
  let layout = null;
  const parentEnvironment = options.environment || process.env;

  try {
    layout = setupRun({ outputDirectory, codexVersion: REQUIRED_CODEX_VERSION });
    const adapterPath = path.join(__dirname, 'adapter.js');
    writeGeneratedFile(path.join(layout.home, 'config.toml'), renderMcpConfig(adapterPath));
    writeGeneratedFile(path.join(layout.home, 'hooks.json'), renderHooksConfig(adapterPath, path.join(layout.hooks, 'events.jsonl'), true));

    const startResults = await Promise.allSettled(slots.map(async slot => {
      const started = await startFixtureRun(outputDirectory, options.codexPath, {
        startWith: 'mcp',
        environment: parentEnvironment,
      });
      const capturePath = path.join(started.layout.home, 'hook-events.jsonl');
      const entry = { slot, started, capturePath, childEnvironment: makeChildEnvironment(parentEnvironment, started.layout.home, slot) };
      startedBySlot.push(entry);
      writeGeneratedFile(started.layout.hooksPath, renderHooksConfig(adapterPath, capturePath, slot.hooksEnabled));
      return entry;
    }));
    if (startResults.some(result => result.status === 'rejected')) throw startResults.find(result => result.status === 'rejected').reason;
    if (stopController.signal) throw Object.assign(new Error('interrupted'), { code: 'INTERRUPTED' });

    for (const slot of slots) {
      const registered = model.registerLaunch({
        launchId: slot.launchId,
        runId: slot.runId,
        attemptId: slot.attemptId,
        origin: slot.origin,
        hostId: slot.hostId,
        homeScope: slot.homeScope,
        parent: slot.parent,
        bindingNonce: slot.bindingNonce,
      });
      if (!registered || registered.launchId !== slot.launchId || registered.runId !== slot.runId || registered.attemptId !== slot.attemptId) {
        throw Object.assign(new Error('registration_rejected'), { code: 'REGISTRATION_REJECTED' });
      }
    }

    const children = [];
    for (const entry of startedBySlot) {
      try {
        children.push(Promise.resolve(runChild(entry.started.executable, entry.started.layout, entry.slot, {
          timeoutMs: options.timeoutMs || DEFAULT_TIMEOUT_MS,
          environment: parentEnvironment,
          tracker,
          stopController,
        })));
      } catch (error) {
        stopController.terminate();
        children.push(Promise.reject(error));
      }
    }
    const childResults = await Promise.allSettled(children);
    for (let index = 0; index < childResults.length; index += 1) {
      const result = childResults[index];
      if (result.status === 'rejected') setupFailure = setupFailure || 'native_child_runner_failed';
      childBySlot.set(startedBySlot[index].slot.launchId, result.status === 'fulfilled' ? result.value : emptyChildResult());
    }
    for (const entry of startedBySlot) {
      hooksBySlot.set(entry.slot.launchId, summarizeHookCapture(entry.capturePath, entry.slot));
    }
  } catch (error) {
    setupFailure = errorCategory(error);
    for (const childResult of childBySlot.values()) {
      if (!childResult || !childResult.exit_code) continue;
    }
  } finally {
    for (const entry of startedBySlot) {
      try { await entry.started.fixture.close(); } catch { setupFailure = setupFailure || 'fixture_cleanup_failed'; }
      try {
        const restored = clearConfig(entry.started.configPath, entry.started.configSnapshot);
        if (!restored) setupFailure = setupFailure || 'fixture_config_cleanup_failed';
      } catch {
        setupFailure = setupFailure || 'fixture_config_cleanup_failed';
      }
    }
    if (layout) {
      try {
        if (!cleanupRuntimeHomes(outputDirectory)) setupFailure = setupFailure || 'runtime_home_cleanup_failed';
      } catch {
        setupFailure = setupFailure || 'runtime_home_cleanup_failed';
      }
    }
    stopController.dispose();
  }

  if (!layout) throw Object.assign(new Error('setup_failed'), { code: setupFailure || 'SETUP_FAILED' });
  const result = buildResult({
    slots,
    startedBySlot,
    childBySlot,
    hooksBySlot,
    model,
    tracker,
    outputDirectory,
    setupFailure,
    stopSignal: stopController.signal,
  });
  outputPath = writeResult(outputDirectory, result);
  return { filePath: outputPath, result };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  const { filePath, result } = await runNativeProbe(options);
  process.stdout.write(`${JSON.stringify({
    file: path.relative(REPOSITORY_ROOT, filePath).split(path.sep).join('/'),
    success: result.success,
    failure_reasons: result.failure_reasons,
  })}\n`);
  if (!result.success) process.exitCode = 1;
}

if (require.main === module) {
  main().catch(error => {
    const category = errorCategory(error);
    process.stderr.write(`Native identity fixture failed (${category}); private diagnostics were omitted.\n`);
    process.exitCode = 1;
  });
}

module.exports = {
  DEFAULT_TIMEOUT_MS,
  HOST_ID,
  MAX_CHILD_BYTES,
  MAX_RESULT_BYTES,
  SYNTHETIC_CLAUDE_SESSION_ID,
  buildResult,
  createConcurrencyTracker,
  createNativeEventCollector,
  createStopController,
  errorCategory,
  findProbe,
  makeChildEnvironment,
  makeSlots,
  nativeEventProjection,
  parseArguments,
  renderHooksConfig,
  renderMcpConfig,
  runNativeChild,
  runNativeProbe,
  safeProbe,
  summarizeHookCapture,
  summarizeModelProject,
};
