'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const test = require('node:test');
const {
  CLAUDE_EXECUTABLE,
  DEFAULT_TIMEOUT_MS,
  FIXED_PROMPT,
  MAX_OUTPUT_BYTES,
  NativeClaudeError,
  OUTPUT_PARENT,
  buildClaudeArguments,
  createChildEnvironment,
  createOutputPath,
  createOwnedOutputDirectory,
  createOwnedProcessRegistry,
  createRunController,
  fixtureFailureCategory,
  parseArguments,
  parseClaudeJson,
  runCancellationFixture,
  runClaudeProbe,
  runOwnedCommand,
  startClaudeProbe,
} = require('./native-runner');

const SESSION_ID = '4f32f7a1-6283-4bc8-85fa-3f0a2b18c964';

function freshOutputPath() {
  const output = createOutputPath();
  assert.equal(path.dirname(output), OUTPUT_PARENT);
  assert.equal(fs.existsSync(output), false);
  return output;
}

function removeOwnedOutput(output) {
  const resolved = path.resolve(output);
  assert.equal(path.dirname(resolved), path.resolve(OUTPUT_PARENT));
  if (!fs.existsSync(resolved)) return;
  const stat = fs.lstatSync(resolved);
  assert.equal(stat.isDirectory(), true);
  assert.equal(stat.isSymbolicLink(), false);
  fs.rmSync(resolved, { recursive: true, force: false });
}

function fakeChild(onKill = null) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.once('close', () => {
    if (!child.stdout.destroyed && !child.stdout.writableEnded) child.stdout.end();
    if (!child.stderr.destroyed && !child.stderr.writableEnded) child.stderr.end();
  });
  child.kill = (signal) => {
    if (onKill) onKill(child, signal);
    return true;
  };
  child.unrefCalls = 0;
  child.unref = () => { child.unrefCalls += 1; };
  return child;
}

function validClaudeOutput(extra = {}) {
  return JSON.stringify({
    type: 'result',
    subtype: 'success',
    session_id: SESSION_ID,
    result: '{"marker":"POC163_RESULT","answer":63}',
    modelUsage: { 'claude-sonnet-4-5-20250929': { inputTokens: 10 } },
    ...extra,
  });
}

function successSpawn(calls, options = {}) {
  return (command, args, spawnOptions) => {
    calls.push({ command, args, spawnOptions });
    const child = fakeChild(options.onKill);
    setImmediate(() => {
      child.emit('spawn');
      child.stderr.end(options.stderrOutput || '');
      if (args[0] === '--version') {
        child.stdout.end(options.versionOutput || '2.1.291 (Claude Code)\n');
        child.emit('close', 0, null);
        return;
      }
      if (options.modelOutput !== undefined) child.stdout.end(options.modelOutput);
      else child.stdout.end(validClaudeOutput());
      child.emit('close', options.modelExitCode ?? 0, null);
    });
    if (args[0] !== '--version' && options.noClose) {
      child.removeAllListeners('close');
    }
    if (args[0] !== '--version' && options.onModelChild) options.onModelChild(child);
    return child;
  };
}

function cleanupAfter(t, ...outputs) {
  t.after(() => {
    for (const output of outputs) removeOwnedOutput(output);
  });
}

test('CLI arguments fix the vendor, prompt, model, effort, tool set, and permission boundary', () => {
  const args = buildClaudeArguments();
  assert.equal(args.includes(FIXED_PROMPT), true);
  assert.equal(args[args.indexOf('--tools') + 1], '');
  assert.equal(args[args.indexOf('--model') + 1], 'sonnet');
  assert.equal(args[args.indexOf('--effort') + 1], 'low');
  assert.equal(args.includes('--safe-mode'), true);
  assert.equal(args.includes('--no-session-persistence'), true);
  assert.equal(args.includes('--strict-mcp-config'), true);
  assert.equal(args[args.indexOf('--mcp-config') + 1], '{"mcpServers":{}}');
  assert.equal(args.includes('--disable-slash-commands'), true);
  assert.equal(args[args.indexOf('--permission-mode') + 1], 'manual');
  assert.equal(args[args.indexOf('--permission-prompts') + 1], 'none');
  assert.equal(args.includes('--dangerously-skip-permissions'), false);
  assert.equal(args.includes('--bare'), false);
  assert.equal(args[args.indexOf('--output-format') + 1], 'json');
  assert.equal(args[args.indexOf('--print') + 1], '--output-format');
  assert.equal(CLAUDE_EXECUTABLE, 'C:\\Users\\mss02968\\.local\\bin\\claude.exe');
  assert.throws(() => parseArguments(['--out', '../outside']), (error) => error.kind === 'output_directory_invalid');
});

test('timeout defaults only when omitted and rejects malformed or out-of-range values', () => {
  assert.equal(parseArguments([]).timeoutMs, DEFAULT_TIMEOUT_MS);
  assert.equal(parseArguments(['--timeout-ms', '1000']).timeoutMs, 1000);
  for (const timeoutText of ['abc', '1000.5', '1e3', '999', '300001']) {
    assert.throws(
      () => parseArguments(['--timeout-ms', timeoutText]),
      (error) => error.kind === 'invalid_timeout',
    );
  }
});

test('child environment preserves Claude home authentication and filters inherited session and bridge secrets', () => {
  const environment = createChildEnvironment({
    PATH: 'system-path',
    USERPROFILE: 'C:\\Users\\fixture',
    ANTHROPIC_API_KEY: 'claude-auth-secret',
    CODEX_SESSION_ID: 'codex-session-secret',
    CLAUDE_CODE_SESSION_ID: 'claude-session-secret',
    CLAUDE_CONFIG_DIR: 'C:\\fixture\\claude-config',
    OPENAI_API_KEY: 'other-vendor-secret',
    BRIDGE_AUTH_TOKEN: 'bridge-secret',
    ANTHROPIC_BASE_URL: 'https://custom.invalid',
  });
  assert.deepEqual(Object.keys(environment).sort(), [
    'ANTHROPIC_API_KEY', 'CLAUDE_CODE_SAFE_MODE', 'PATH', 'USERPROFILE',
  ].sort());
  assert.equal(environment.ANTHROPIC_API_KEY, 'claude-auth-secret');
  assert.equal(environment.USERPROFILE, 'C:\\Users\\fixture');
  assert.equal(environment.CLAUDE_CODE_SAFE_MODE, '1');
  assert.equal(JSON.stringify(environment).includes('session-secret'), false);
  assert.equal(JSON.stringify(environment).includes('bridge-secret'), false);
});

test('result parser accepts only the expected object and keeps unobserved metadata unknown', () => {
  const parsed = parseClaudeJson(validClaudeOutput({ private_field: 'RAW_PRIVATE_MARKER' }));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.category, 'ok');
  assert.equal(parsed.sessionId, SESSION_ID);
  assert.equal(parsed.actualModel, 'claude-sonnet-4-5-20250929');
  assert.equal(parsed.actualEffort, null);
  assert.equal(parsed.toolCallCount, null);
  assert.equal(parsed.toolCallObserved, false);
  assert.equal(parsed.exactMatch, true);
  assert.deepEqual(parsed.safeResult, { marker: 'POC163_RESULT', answer: 63 });
  assert.equal(JSON.stringify(parsed).includes('RAW_PRIVATE_MARKER'), false);
  const jsonWithoutToolStream = parseClaudeJson(validClaudeOutput({
    effort: 'low',
    tool_call_count: 0,
    content: [{ type: 'tool_use', name: 'Bash' }],
  }));
  assert.equal(jsonWithoutToolStream.toolCallCount, null);
  assert.equal(jsonWithoutToolStream.toolCallObserved, false);
  assert.equal(jsonWithoutToolStream.actualEffort, null);
  const untrustedModelName = parseClaudeJson(validClaudeOutput({
    modelUsage: { AUTH_SECRET_MARKER: {} },
  }));
  assert.equal(untrustedModelName.actualModel, null);
  assert.equal(JSON.stringify(untrustedModelName).includes('AUTH_SECRET_MARKER'), false);
  assert.equal(parseClaudeJson('x'.repeat(MAX_OUTPUT_BYTES + 1)).category, 'invalid_json');
  assert.equal(parseClaudeJson(JSON.stringify({ type: 'progress', text: 'secret' })).category, 'invalid_result_schema');
  assert.equal(parseClaudeJson(validClaudeOutput({ result: '{"marker":"POC163_RESULT","answer":63,"secret":"x"}' })).category, 'result_mismatch');
  assert.equal(parseClaudeJson(validClaudeOutput({
    result: '{"marker":"wrong","marker":"POC163_RESULT","answer":63}',
  })).category, 'result_mismatch');
});

test('output creation rejects an existing directory and preserves a raced directory', () => {
  const existing = freshOutputPath();
  fs.mkdirSync(existing);
  assert.throws(() => createOwnedOutputDirectory(existing), (error) => error.kind === 'output_directory_not_fresh');
  assert.equal(fs.existsSync(existing), true);
  removeOwnedOutput(existing);

  const raced = freshOutputPath();
  const fileSystem = {
    existsSync: fs.existsSync,
    lstatSync: fs.lstatSync,
    mkdirSync(target, options) {
      fs.mkdirSync(target, options);
      const error = new Error('race');
      error.code = 'EEXIST';
      throw error;
    },
  };
  assert.throws(() => createOwnedOutputDirectory(raced, fileSystem), (error) => error.kind === 'output_directory_race');
  assert.equal(fs.existsSync(raced), true);
  removeOwnedOutput(raced);
});

test('missing CLI is classified without spawning or copying authentication data', async (t) => {
  const output = freshOutputPath();
  cleanupAfter(t, output);
  let spawnCalls = 0;
  const report = await runClaudeProbe({ outputDirectory: output }, {
    spawn() { spawnCalls += 1; throw new Error('must not start'); },
    validateExecutable() { throw new NativeClaudeError('missing_cli'); },
  });
  assert.equal(spawnCalls, 0);
  assert.equal(report.failure_category, 'missing_cli');
  assert.equal(report.cleanup.all_child_exits_observed, true);
  assert.equal(report.result.safe_result, null);
  const saved = fs.readFileSync(path.join(output, 'result.json'), 'utf8');
  assert.equal(saved.includes('must not start'), false);
  assert.equal(saved.includes('C:\\Users\\mss02968'), false);
});

test('successful JSON result saves only allowlisted evidence and leaves tool usage unobserved', async (t) => {
  const output = freshOutputPath();
  cleanupAfter(t, output);
  const calls = [];
  const raw = validClaudeOutput({ private_field: 'RAW_PRIVATE_MARKER' });
  const report = await runClaudeProbe({ outputDirectory: output }, {
    spawn: successSpawn(calls, {
      modelOutput: raw,
      stderrOutput: 'STDERR_PRIVATE_MARKER',
      versionOutput: '9.9.99 (Claude Code)\n',
    }),
    validateExecutable: (executable) => executable,
    environment: {
      PATH: 'safe-path',
      USERPROFILE: 'C:\\Users\\mss02968',
      ANTHROPIC_API_KEY: 'AUTH_SECRET_MARKER',
      CODEX_SESSION_ID: 'CODEX_SESSION_MARKER',
      CLAUDE_CODE_SESSION_ID: 'CLAUDE_SESSION_MARKER',
      OPENAI_API_KEY: 'OTHER_VENDOR_SECRET_MARKER',
      BRIDGE_AUTH_TOKEN: 'BRIDGE_SECRET_MARKER',
    },
  });
  assert.equal(report.failure_category, 'ok');
  assert.equal(report.cli.observed_version, '9.9.99');
  assert.equal(report.cli.version_at_help_capture, '2.1.291');
  assert.equal(report.result.session_uuid, SESSION_ID);
  assert.equal(report.result.actual_model, 'claude-sonnet-4-5-20250929');
  assert.equal(report.result.actual_effort, null);
  assert.equal(report.result.tool_call_count, null);
  assert.equal(report.result.tool_call_observed, false);
  assert.equal(report.result.exact_match, true);
  assert.equal(report.process.version_spawn_requested, true);
  assert.equal(report.process.version_process_started, true);
  assert.equal(report.process.version_exit_observed, true);
  assert.equal(report.process.model_spawn_requested, true);
  assert.equal(report.process.model_process_started, true);
  assert.equal(report.process.model_exit_observed, true);
  assert.equal(report.process.model_stderr_observed, true);
  assert.equal(report.process.model_stderr_bytes, Buffer.byteLength('STDERR_PRIVATE_MARKER'));
  assert.deepEqual(report.result.safe_result, { marker: 'POC163_RESULT', answer: 63 });
  assert.equal(report.request.permission_mode_requested, 'manual');
  assert.equal(report.request.permission_prompts_requested, 'none');
  assert.equal(report.request.permission_bypass_requested, false);
  assert.equal(report.request.os_sandbox_inheritance, 'unknown');
  assert.equal(report.request.authentication_scope_requested, 'current_user_claude_auth_context');
  assert.equal(report.request.home_copy_created, false);
  assert.equal(report.request.admin_policy_may_remain_active, true);
  assert.equal(report.request.process_ownership_scope, 'direct_child_processes_only');
  assert.equal(report.request.descendant_processes_observed, false);
  assert.equal(report.cleanup.all_child_exits_observed, true);
  assert.equal(report.cleanup.descendant_process_tree_exit_observed, false);
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].args, ['--version']);
  assert.equal('ANTHROPIC_API_KEY' in calls[0].spawnOptions.env, false);
  assert.equal(calls[1].command, CLAUDE_EXECUTABLE);
  assert.equal(calls[1].spawnOptions.shell, false);
  assert.equal(path.dirname(calls[1].spawnOptions.cwd), output);
  assert.equal(calls[1].spawnOptions.env.USERPROFILE, 'C:\\Users\\mss02968');
  assert.equal(calls[1].spawnOptions.env.CLAUDE_CODE_SAFE_MODE, '1');
  assert.equal(calls[1].spawnOptions.env.ANTHROPIC_API_KEY, 'AUTH_SECRET_MARKER');
  assert.equal('CODEX_SESSION_ID' in calls[1].spawnOptions.env, false);
  assert.equal('CLAUDE_CODE_SESSION_ID' in calls[1].spawnOptions.env, false);
  assert.equal('OPENAI_API_KEY' in calls[1].spawnOptions.env, false);
  assert.equal('BRIDGE_AUTH_TOKEN' in calls[1].spawnOptions.env, false);
  const saved = fs.readFileSync(path.join(output, 'result.json'), 'utf8');
  for (const secret of [
    'RAW_PRIVATE_MARKER', 'AUTH_SECRET_MARKER', 'CODEX_SESSION_MARKER',
    'CLAUDE_SESSION_MARKER', 'OTHER_VENDOR_SECRET_MARKER', 'BRIDGE_SECRET_MARKER',
    'STDERR_PRIVATE_MARKER',
  ]) assert.equal(saved.includes(secret), false);
  assert.equal(saved.includes('POC163_RESULT'), true);
});

test('output overflow stops the child and never persists stdout bytes', async (t) => {
  const output = freshOutputPath();
  cleanupAfter(t, output);
  const calls = [];
  const oversized = 'OVERFLOW_SECRET_MARKER' + 'x'.repeat(MAX_OUTPUT_BYTES + 1);
  const report = await runClaudeProbe({ outputDirectory: output }, {
    spawn: successSpawn(calls, { modelOutput: oversized }),
    validateExecutable: (executable) => executable,
    killGraceMs: 50,
  });
  assert.equal(report.failure_category, 'output_overflow');
  assert.equal(report.process.output_overflow, true);
  assert.equal(report.process.model_exit_observed, true);
  const saved = fs.readFileSync(path.join(output, 'result.json'), 'utf8');
  assert.equal(saved.includes('OVERFLOW_SECRET_MARKER'), false);
  assert.equal(saved.includes('x'.repeat(100)), false);
});

test('timeout records the stop request and confirms the child close separately', async (t) => {
  const output = freshOutputPath();
  cleanupAfter(t, output);
  const spawnImpl = (command, args) => {
    const child = fakeChild((target) => {
      if (args[0] !== '--version') {
        setTimeout(() => target.emit('close', null, 'SIGTERM'), 0);
      }
    });
    if (args[0] === '--version') {
      setImmediate(() => {
        child.emit('spawn');
        child.stdout.end('2.1.291\n');
        child.emit('close', 0, null);
      });
    } else {
      setImmediate(() => child.emit('spawn'));
    }
    return child;
  };
  const report = await runClaudeProbe({ outputDirectory: output, timeoutMs: 1000 }, {
    spawn: spawnImpl,
    validateExecutable: (executable) => executable,
    killGraceMs: 100,
  });
  assert.equal(report.failure_category, 'timeout');
  assert.equal(report.process.model_process_started, true);
  assert.equal(report.process.model_exit_observed, true);
  assert.equal(report.process.model_exit_signal, 'SIGTERM');
  assert.equal(report.process.timeout, true);
  assert.equal(report.cleanup.all_child_exits_observed, true);
});

test('owned stop escalates from SIGTERM to SIGKILL and records the observed close', async () => {
  const signals = [];
  const child = fakeChild((target, signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') setImmediate(() => target.emit('close', null, 'SIGKILL'));
  });
  setImmediate(() => child.emit('spawn'));
  const controller = createRunController();
  const registry = createOwnedProcessRegistry(() => child, controller);
  const pending = runOwnedCommand(registry, controller, 'fake', [], {
    spawnOptions: {},
    timeoutMs: 10_000,
    killGraceMs: 10,
    maxOutputBytes: 1024,
  });
  controller.requestCancel('escalation_test');
  const outcome = await pending;
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(outcome.exitObserved, true);
  assert.equal(outcome.signal, 'SIGKILL');
  assert.equal(outcome.terminationSignalRequested, true);
  assert.equal(outcome.terminationSignalSucceeded, true);
  assert.equal(outcome.forceKillSignalRequested, true);
  assert.equal(outcome.forceKillSignalSucceeded, true);
  assert.equal(registry.snapshot().allExitObserved, true);
});

test('failed signal sends still reach bounded pipe and child reference release', async () => {
  for (const failureMode of ['false', 'throw']) {
    const signals = [];
    const child = fakeChild();
    child.kill = (signal) => {
      signals.push(signal);
      if (failureMode === 'throw') throw new Error('signal rejected');
      return false;
    };
    setImmediate(() => child.emit('spawn'));
    const controller = createRunController();
    const registry = createOwnedProcessRegistry(() => child, controller);
    const pending = runOwnedCommand(registry, controller, 'fake', [], {
      spawnOptions: {},
      timeoutMs: 10_000,
      killGraceMs: 10,
      maxOutputBytes: 1024,
    });
    controller.requestCancel('failed_signal_test');
    const outcome = await pending;
    const state = registry.records[0].state;
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(outcome.exitObserved, false);
    assert.equal(outcome.exitCode, null);
    assert.equal(outcome.signal, null);
    assert.equal(state.observationFinalized, true);
    assert.equal(state.finalizedExitObserved, false);
    assert.equal(state.childUnreferenceAttempted, true);
    assert.equal(state.childUnreferenceSucceeded, true);
    assert.equal(state.stdoutPipeDestroySucceeded, true);
    assert.equal(state.stderrPipeDestroySucceeded, true);
    assert.equal(child.unrefCalls, 1);
    assert.equal(child.stdout.destroyed, true);
    assert.equal(child.stderr.destroyed, true);
    assert.equal(registry.snapshot().allExitObserved, false);
  }
});

test('cancel discards a valid late result and keeps the cancellation outcome terminal', async (t) => {
  const output = freshOutputPath();
  cleanupAfter(t, output);
  let modelStarted;
  const started = new Promise((resolve) => { modelStarted = resolve; });
  let modelChild;
  const spawnImpl = (command, args) => {
    const child = fakeChild((target) => {
      if (args[0] !== '--version') {
        setTimeout(() => {
          target.stdout.end(validClaudeOutput({ private_field: 'LATE_SECRET_MARKER' }));
          target.emit('close', 0, null);
        }, 5);
      }
    });
    if (args[0] === '--version') {
      setImmediate(() => {
        child.emit('spawn');
        child.stdout.end('2.1.291\n');
        child.emit('close', 0, null);
      });
    } else {
      modelChild = child;
      setImmediate(() => {
        child.emit('spawn');
        modelStarted();
      });
    }
    return child;
  };
  const run = startClaudeProbe({ outputDirectory: output }, {
    spawn: spawnImpl,
    validateExecutable: (executable) => executable,
    killGraceMs: 100,
  });
  await started;
  const cancellation = run.requestCancel('test_cancel');
  assert.equal(cancellation.accepted, true);
  const report = await run.completion;
  assert.equal(modelChild !== undefined, true);
  assert.equal(report.failure_category, 'cancelled');
  assert.equal(report.cancel.requested, true);
  assert.equal(report.cancel.kill_requested, true);
  assert.equal(report.process.model_exit_observed, true);
  assert.equal(report.result.exact_match, false);
  assert.equal(report.result.safe_result, null);
  assert.equal(fs.readFileSync(path.join(output, 'result.json'), 'utf8').includes('LATE_SECRET_MARKER'), false);
});

test('unobserved child exit keeps the owned output and records the unknown end state', async (t) => {
  const output = freshOutputPath();
  cleanupAfter(t, output);
  let modelStarted;
  let modelChild;
  const modelSignals = [];
  const started = new Promise((resolve) => { modelStarted = resolve; });
  const spawnImpl = (command, args) => {
    const child = fakeChild((target, signal) => {
      if (args[0] !== '--version') {
        modelSignals.push(signal);
        if (signal === 'SIGKILL') setTimeout(() => target.emit('close', 0, null), 50);
      }
    });
    if (args[0] === '--version') {
      setImmediate(() => {
        child.emit('spawn');
        child.stdout.end('2.1.291\n');
        child.emit('close', 0, null);
      });
    } else {
      modelChild = child;
      setImmediate(() => {
        child.emit('spawn');
        modelStarted();
      });
    }
    return child;
  };
  const run = startClaudeProbe({ outputDirectory: output }, {
    spawn: spawnImpl,
    validateExecutable: (executable) => executable,
    killGraceMs: 20,
  });
  await started;
  run.requestCancel('parent_ended');
  const report = await run.completion;
  assert.equal(report.failure_category, 'cancelled');
  assert.equal(report.process.model_exit_observed, false);
  assert.equal(report.cleanup.retained_for_unconfirmed_child, true);
  assert.equal(report.cleanup.all_child_exits_observed, false);
  assert.equal(report.cleanup.output_retained, true);
  assert.equal(report.cancel.termination_signal_requested, true);
  assert.equal(report.cancel.termination_signal_succeeded, true);
  assert.equal(report.cancel.force_kill_signal_requested, true);
  assert.equal(report.cancel.force_kill_signal_succeeded, true);
  assert.equal(report.cleanup.child_unreference_attempted, true);
  assert.equal(report.cleanup.child_unreference_call_succeeded, true);
  assert.equal(report.cleanup.stdout_pipe_destroy_call_succeeded, true);
  assert.equal(report.cleanup.stderr_pipe_destroy_call_succeeded, true);
  assert.deepEqual(modelSignals, ['SIGTERM', 'SIGKILL']);
  assert.equal(fs.existsSync(path.join(output, 'result.json')), true);
  const saved = JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8'));
  assert.equal(saved.process.model_exit_observed, false);
  assert.equal(saved.cleanup.all_child_exits_observed, false);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(output, 'result.json'), 'utf8')), saved);
  assert.equal(modelChild.unrefCalls, 1);
});

test('CLI main exits naturally after detaching a child and pipes that never close', async (t) => {
  const output = freshOutputPath();
  cleanupAfter(t, output);
  const runnerPath = JSON.stringify(path.join(__dirname, 'native-runner.js'));
  const outputPath = JSON.stringify(output);
  const source = `
    const runner = require(${runnerPath});
    const { EventEmitter } = require('node:events');
    const { PassThrough } = require('node:stream');
    function trackedStream() {
      const stream = new PassThrough();
      const reference = setInterval(() => {}, 1000);
      const destroy = stream.destroy.bind(stream);
      stream.destroy = (...args) => {
        clearInterval(reference);
        return destroy(...args);
      };
      return stream;
    }
    function fakeSpawn() {
      const child = new EventEmitter();
      child.stdout = trackedStream();
      child.stderr = trackedStream();
      const reference = setInterval(() => {}, 1000);
      child.unref = () => reference.unref();
      child.kill = () => true;
      setImmediate(() => {
        child.emit('spawn');
        setTimeout(() => process.emit('SIGTERM'), 0);
        setTimeout(() => process.emit('SIGTERM'), 25);
      });
      return child;
    }
    runner.main(['--out', ${outputPath}, '--timeout-ms', '1000'], {
      spawn: fakeSpawn,
      validateExecutable: () => 'fake-claude',
      killGraceMs: 15,
      environment: {},
    }).catch(() => { process.exitCode = 1; });
  `;
  const result = await new Promise((resolve, reject) => {
    let stdout = '';
    const stderrChunks = [];
    let stderrBytes = 0;
    let capturedStderrBytes = 0;
    let settled = false;
    const child = spawn(process.execPath, ['-e', source], {
      cwd: path.resolve(__dirname, '../..'),
      env: createChildEnvironment(process.env, { includeAuth: false }),
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const finish = (resultValue) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      resolve(resultValue);
    };
    const deadline = setTimeout(() => {
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
      finish({ timedOut: true, code: null, signal: null, stdout, stderrBytes, stderr: Buffer.concat(stderrChunks).toString('utf8') });
    }, 1500);
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      stderrBytes += buffer.length;
      if (capturedStderrBytes < 4096) {
        const captured = buffer.subarray(0, 4096 - capturedStderrBytes);
        stderrChunks.push(captured);
        capturedStderrBytes += captured.length;
      }
    });
    child.once('error', (error) => {
      clearTimeout(deadline);
      if (!settled) {
        settled = true;
        reject(error);
      }
    });
    child.once('close', (code, signal) => finish({
      timedOut: false,
      code,
      signal,
      stdout,
      stderrBytes,
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    }));
  });
  const safeStderr = result.stderr
    .replaceAll(path.resolve(__dirname, '../..'), '<repo>')
    .replaceAll(output, '<run>')
    .replace(/[^\x09\x0a\x0d\x20-\x7e]/g, '?')
    .slice(0, 4096);
  assert.equal(result.timedOut, false, `CLI fixture did not exit naturally; stderr=${safeStderr}`);
  assert.equal(result.code, 0, `CLI fixture exited with ${result.code}; stderr=${safeStderr || '(empty)'}`);
  assert.equal(result.stderrBytes, 0, `CLI fixture wrote stderr: ${safeStderr}`);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.failure_category, 'cancelled');
  assert.equal(report.process.version_exit_observed, false);
  assert.equal(report.cancel.termination_signal_requested, true);
  assert.equal(report.cancel.force_kill_signal_requested, true);
  assert.equal(report.cleanup.child_unreference_call_succeeded, true);
  assert.equal(report.cleanup.stdout_pipe_destroy_call_succeeded, true);
  assert.equal(report.cleanup.stderr_pipe_destroy_call_succeeded, true);
  assert.equal(report.cleanup.all_child_exits_observed, false);
});

test('owned cancellation fixture exposes mock and real-node modes without invoking Claude', async (t) => {
  const output = freshOutputPath();
  cleanupAfter(t, output);
  const report = await runCancellationFixture({
    outputDirectory: output,
    childMode: 'mock',
    cancelAfterMs: 30,
    timeoutMs: 1000,
  }, { killGraceMs: 100 });
  assert.equal(report.mode, 'owned_cancel_fixture');
  assert.equal(report.failure_category, 'cancelled');
  assert.equal(report.request.model_requested, null);
  assert.equal(report.cli.version_at_help_capture, null);
  assert.equal(report.process.fixture_child_started, true);
  assert.equal(report.process.fixture_child_spawn_requested, true);
  assert.equal(report.process.fixture_child_exit_observed, true);
  assert.equal(report.process.fixture_child_kind, 'mock');
  assert.equal(report.cancel.requested, true);
  assert.equal(report.cancel.kill_requested, true);
  assert.equal(report.cancel.exit_observed, true);
  assert.equal(report.cleanup.all_child_exits_observed, true);
});

test('limit, authentication, and missing-CLI examples remain synthetic fixtures', () => {
  assert.equal(fixtureFailureCategory('limit'), 'rate_limit_fixture');
  assert.equal(fixtureFailureCategory('authentication'), 'authentication_fixture');
  assert.equal(fixtureFailureCategory('missing_cli'), 'missing_cli_fixture');
  assert.equal(fixtureFailureCategory('actual-account'), null);
});
