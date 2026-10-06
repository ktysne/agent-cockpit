'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { spawn } = require('node:child_process');
const test = require('node:test');
const {
  assertNoSymlinkComponents,
  buildMcpConfig,
  connectAppServer,
  isWithinDirectory,
  makeChildEnvironment,
  makeLayout,
  parseArguments,
  summarizeCapture,
  summarizeRun,
  summarizeFixtureResponse,
  runNativeProbe,
  verifyMcpProcessExits,
} = require('./native-probe');
const {
  buildToolCallResult,
  handleRequest,
  parseFixturePullRequestUrl,
} = require('./mcp-probe');

function makeOwnedFixtureChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => {
    child.emit('close', 1, 'SIGTERM');
    return true;
  };
  return child;
}

function connectOwnedFixtureChild(child) {
  return connectAppServer(
    'fixture-codex.exe',
    { repo: os.tmpdir() },
    {},
    100,
    () => child,
  );
}

function waitForOwnedChildOutput(child, marker, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => finish(new Error('fixture readiness timeout')), timeoutMs);
    function finish(error) {
      clearTimeout(timeout);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('close', onClose);
      if (error) reject(error);
      else resolve(output);
    }
    function onData(chunk) {
      output += chunk.toString('utf8');
      if (output.length > 8192) return finish(new Error('fixture output exceeded limit'));
      if (output.includes(marker)) finish();
    }
    function onError(error) {
      finish(error);
    }
    function onClose(code, signal) {
      finish(new Error('fixture closed before readiness: ' + code + '/' + signal));
    }
    child.stdout.on('data', onData);
    child.once('error', onError);
    child.once('close', onClose);
  });
}

function waitForOwnedChildClose(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.off('close', onClose);
      reject(new Error('owned fixture child did not close within the limit'));
    }, timeoutMs);
    function onClose() {
      clearTimeout(timeout);
      resolve();
    }
    child.once('close', onClose);
  });
}

test('native probe requires one executable path and one fresh output path', () => {
  assert.deepEqual(parseArguments([
    '--codex-path', 'C:\\tools\\codex.exe',
    '--out', 'poc/out/poc164-native-a',
  ]), {
    codexPath: 'C:\\tools\\codex.exe',
    outputDirectory: 'poc/out/poc164-native-a',
  });
  assert.throws(
    () => parseArguments(['--codex-path', 'codex.exe', '--codex-path', 'other.exe', '--out', 'poc/out/run']),
    error => error.code === 'invalid_arguments',
  );
  assert.throws(
    () => parseArguments(['--codex-path', 'codex.exe', '--out', 'poc/out/run', '--other', 'value']),
    error => error.code === 'invalid_arguments',
  );
});

test('native probe rejects output paths outside the repository', () => {
  assert.equal(isWithinDirectory('C:\\repo', 'C:\\repo\\poc\\out\\poc164-native-a'), true);
  assert.equal(isWithinDirectory('C:\\repo', 'C:\\other\\poc164-native-a'), false);
  assert.throws(
    () => assertNoSymlinkComponents('C:\\repo', 'C:\\repo\\..\\other'),
    error => error.code === 'path_outside_repository',
  );
  assert.equal(
    makeLayout('C:\\repo\\poc\\out\\poc164-native-a').home,
    'C:\\repo\\poc\\out\\poc164-native-a\\home',
  );
});

test('app-server child environment uses the dedicated HOME and operating system variables', () => {
  const layout = {
    home: 'C:\\repo\\poc\\out\\poc164-native-a\\home',
    profile: 'C:\\repo\\poc\\out\\poc164-native-a\\profile',
    appDataRoaming: 'C:\\repo\\poc\\out\\poc164-native-a\\profile\\AppData\\Roaming',
    appDataLocal: 'C:\\repo\\poc\\out\\poc164-native-a\\profile\\AppData\\Local',
    temp: 'C:\\repo\\poc\\out\\poc164-native-a\\temp',
  };
  const environment = makeChildEnvironment({
    PATH: 'C:\\Windows\\System32',
    SYSTEMROOT: 'C:\\Windows',
    CODEX_HOME: 'C:\\Users\\normal\\.codex',
    USERPROFILE: 'C:\\Users\\normal',
    APPDATA: 'C:\\Users\\normal\\AppData\\Roaming',
    OPENAI_API_KEY: 'secret',
    CLAUDE_CODE_SESSION_ID: 'secret-session',
  }, layout);
  assert.equal(environment.CODEX_HOME, layout.home);
  assert.equal(environment.USERPROFILE, layout.profile);
  assert.equal(environment.APPDATA, layout.appDataRoaming);
  assert.equal(environment.TEMP, layout.temp);
  assert.equal(environment.PATH, 'C:\\Windows\\System32');
  assert.equal(Object.hasOwn(environment, 'OPENAI_API_KEY'), false);
  assert.equal(Object.hasOwn(environment, 'CLAUDE_CODE_SESSION_ID'), false);
});

test('MCP config points to the fixture process and its dedicated capture file', () => {
  const layout = {
    output: 'C:\\repo\\poc\\out\\poc164-native-a',
    capturePath: 'C:\\repo\\poc\\out\\poc164-native-a\\mcp-capture.jsonl',
  };
  const config = buildMcpConfig(layout, 'C:\\Program Files\\nodejs\\node.exe', 'C:\\repo\\poc\\mcp-probe.js');
  const headerPattern = /^\[mcp_servers\.poc164_native\]$/m;
  assert.match(config, headerPattern);
  assert.doesNotMatch(config.replace(headerPattern, ''), headerPattern);
  assert.doesNotMatch(
    config.replace(headerPattern, '[mcp_servers.poc164_native_changed]'),
    headerPattern,
  );
  assert.ok(config.includes('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"'));
  assert.match(config, /POC164_CAPTURE_PATH/);
  assert.doesNotMatch(config, /OPENAI_API_KEY|CLAUDE_CODE_SESSION_ID/);
});

test('an owned Node child closing its stdin pipe produces a safe RPC failure and exits', async t => {
  const fixtureSource = [
    "const control = require('node:fs').createReadStream(null, { fd: 3 });",
    "control.once('data', () => process.exit(0));",
    'process.stdin.resume();',
    "process.stdin.once('close', () => process.stdout.write('FIXTURE_READY\\n'));",
    'process.stdin.destroy();',
  ].join(' ');
  const environment = {};
  for (const name of ['PATH', 'SYSTEMROOT', 'WINDIR']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  let child;
  let rpcWriteCount = 0;
  const app = connectAppServer(
    process.execPath,
    { repo: os.tmpdir() },
    environment,
    1500,
    (executable, _args, options) => {
      child = spawn(executable, ['-e', fixtureSource], {
        ...options,
        env: environment,
        stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
      });
      const originalWrite = child.stdin.write.bind(child.stdin);
      child.stdin.write = (...args) => {
        rpcWriteCount += 1;
        return originalWrite(...args);
      };
      return child;
    },
  );
  let skipReason = null;
  let failureCode = null;
  try {
    try {
      await waitForOwnedChildOutput(child, 'FIXTURE_READY\n', 1500);
    } catch (error) {
      skipReason = 'owned Node fixture did not reach readiness: ' + error.message;
    }
    if (!skipReason) {
      const pendingRpc = app.rpc('fixture/after-stdin-close', {});
      if (rpcWriteCount === 1 && child.stdio[3]) child.stdio[3].end('exit');
      try {
        await pendingRpc;
        failureCode = 'rpc_resolved';
      } catch (error) {
        failureCode = error.code || 'unclassified_error';
      }
      if (rpcWriteCount !== 1) {
        t.diagnostic('OS pipe result remains unconfirmed; RPC writes observed: ' + rpcWriteCount);
        skipReason = 'RPC write to the closed-input fixture was not observed';
      }
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null && !child.killed) child.kill();
    await waitForOwnedChildClose(child, 2500);
    assert.equal(app.closed, true);
    assert.deepEqual(app.closeInfo, { code: child.exitCode, signal: child.signalCode });
  }
  if (skipReason) return t.skip(skipReason);
  t.diagnostic('Owned Node child RPC write count: ' + rpcWriteCount);
  t.diagnostic('Owned Node child failure classification: ' + failureCode);
  assert.equal(rpcWriteCount, 1);
  assert.ok([
    'app_server_stdin_error',
    'app_server_stdin_closed',
    'app_server_exited',
  ].includes(failureCode));
});
test('closed owned fixture input safely rejects the initialized notification', async () => {
  const child = makeOwnedFixtureChild();
  child.stdin.destroy(new Error('fixture input was closed before initialization'));
  const app = connectOwnedFixtureChild(child);
  await assert.rejects(
    app.notify('initialized', {}),
    error => error.code === 'app_server_stdin_closed',
  );
  await new Promise(resolve => setImmediate(resolve));
  child.emit('close', 0, null);
});

test('stdin error rejects every pending RPC without an uncaught stream error', async () => {
  const child = makeOwnedFixtureChild();
  const app = connectOwnedFixtureChild(child);
  const initialize = app.rpc('initialize', {});
  const listTools = app.rpc('mcpServer/tools/list', {});
  child.stdin.destroy(new Error('fixture input closed during pending RPCs'));
  await Promise.all([
    assert.rejects(initialize, error => error.code === 'app_server_stdin_error'),
    assert.rejects(listTools, error => error.code === 'app_server_stdin_error'),
  ]);
  child.emit('close', 1, null);
});
test('closed fixture stdin during initialize preserves cleanup and result output', async t => {
  const repositoryRoot = fs.realpathSync(path.resolve(__dirname, '..', '..'));
  const output = path.join(
    repositoryRoot,
    'poc',
    'out',
    'poc164-native-test-' + process.pid + '-' + crypto.randomUUID(),
  );
  t.after(() => {
    assert.match(path.basename(output), /^poc164-native-test-[A-Za-z0-9-]+$/);
    assert.equal(isWithinDirectory(path.join(repositoryRoot, 'poc', 'out'), output), true);
    assertNoSymlinkComponents(repositoryRoot, output);
    if (fs.existsSync(output)) fs.rmSync(output, { recursive: true });
  });

  const child = makeOwnedFixtureChild();
  child.stdin.once('error', () => setImmediate(() => child.emit('close', 1, null)));
  child.stdin.destroy(new Error('fixture input was closed before initialization'));
  let fixtureSpawnCount = 0;

  const run = await runNativeProbe({
    codexPath: process.execPath,
    outputDirectory: output,
    initializeLayoutForTest(paths, environment) {
      const layout = makeLayout(paths.output);
      fs.mkdirSync(layout.output);
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
      return {
        layout,
        childEnvironment: makeChildEnvironment(environment, layout),
      };
    },
    spawnForTest() {
      fixtureSpawnCount += 1;
      return child;
    },
  });

  assert.equal(fixtureSpawnCount, 1);
  assert.equal(run.result.success, false);
  assert.equal(run.result.failure_code, 'app_server_stdin_closed');
  assert.equal(run.result.cleanup.app_server_closed, true);
  assert.equal(run.result.cleanup.dedicated_temp_removed, true);
  assert.equal(fs.existsSync(run.resultPath), true);
  assert.equal(JSON.parse(fs.readFileSync(run.resultPath, 'utf8')).failure_code, 'app_server_stdin_closed');
});
test('fixture PR URL accepts only the fixed synthetic GitHub PR', () => {
  assert.deepEqual(
    parseFixturePullRequestUrl('https://github.com/poc164-fixture/agent-cockpit/pull/164'),
    {
      owner: 'poc164-fixture',
      repo: 'agent-cockpit',
      number: 164,
      key: 'poc164-fixture/agent-cockpit#164',
    },
  );
  assert.equal(
    parseFixturePullRequestUrl('https://github.com/real-org/real-repo/pull/164'),
    null,
  );
  assert.equal(
    parseFixturePullRequestUrl('https://user:token@github.com/poc164-fixture/agent-cockpit/pull/164'),
    null,
  );
});

test('fixture MCP captures the safe native thread ID and excludes metadata values', t => {
  const output = fs.mkdtempSync(path.join(os.tmpdir(), 'poc164-native-'));
  t.after(() => fs.rmSync(output, { recursive: true, force: true }));
  const environment = {
    POC164_OUTPUT_DIRECTORY: output,
    POC164_CAPTURE_PATH: path.join(output, 'mcp-capture.jsonl'),
  };
  const summary = buildToolCallResult({
    arguments: { url: 'https://github.com/poc164-fixture/agent-cockpit/pull/164' },
    _meta: { threadId: 'native-thread-164', progressToken: 'do-not-record-this-value' },
  }, environment);
  assert.equal(summary.registration, 'created');
  assert.equal(summary.native_meta_thread_id, 'native-thread-164');

  const capture = fs.readFileSync(environment.POC164_CAPTURE_PATH, 'utf8');
  assert.match(capture, /native-thread-164/);
  assert.match(capture, /progressToken/);
  assert.doesNotMatch(capture, /do-not-record-this-value/);
  assert.doesNotMatch(capture, /github\\.com/);
});

test('fixture MCP exposes only cockpit_add_pr and rejects nonfixture PRs', () => {
  const listed = handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(listed.result.tools.map(tool => tool.name), ['cockpit_add_pr']);
  const rejected = handleRequest({
    jsonrpc: '2.0',
    id: 2,
    method: 'tools/call',
    params: {
      name: 'cockpit_add_pr',
      arguments: { url: 'https://github.com/real-org/real-repo/pull/164' },
    },
  });
  assert.equal(rejected.result.isError, true);
});

test('capture summary joins one PR across separate MCP processes and native threads', () => {
  const records = [
    { type: 'started', pid: 101, parent_pid: 100 },
    { type: 'started', pid: 102, parent_pid: 100 },
    {
      type: 'tool_call',
      tool: 'cockpit_add_pr',
      pr_key: 'poc164-fixture/agent-cockpit#164',
      native_meta_thread_id: 'thread-one',
      meta_keys: ['threadId'],
      codex_environment_ids_present: {},
      registration: 'created',
      unique_native_sources_for_fixture_pr: 1,
    },
    {
      type: 'tool_call',
      tool: 'cockpit_add_pr',
      pr_key: 'poc164-fixture/agent-cockpit#164',
      native_meta_thread_id: 'thread-two',
      meta_keys: ['threadId'],
      codex_environment_ids_present: {},
      registration: 'created',
      unique_native_sources_for_fixture_pr: 1,
    },
    { type: 'stdin_closed', pid: 101, call_count: 1 },
    { type: 'stdin_closed', pid: 102, call_count: 1 },
    { type: 'process_exit', pid: 101, exit_code: 0 },
    { type: 'process_exit', pid: 102, exit_code: 0 },
  ];
  const summary = summarizeCapture(records);
  assert.equal(summary.tool_call_count, 2);
  assert.equal(summary.distinct_pr_count, 1);
  assert.equal(summary.same_pr_multiple_native_threads_observed, true);
  assert.equal(summary.pull_requests[0].distinct_native_meta_thread_ids, 2);
  assert.deepEqual(
    verifyMcpProcessExits(records, () => false).processes.map(process => process.exit_confirmed),
    [true, true],
  );

  const runSummary = summarizeRun({
    calls: [
      { result: { status: 'ok', native_meta_matches_started_thread: true } },
      { result: { status: 'ok', native_meta_matches_started_thread: true } },
    ],
  }, { records, invalidLineCount: 0, sizeExceeded: false }, {
    processes: [],
    started_count: 2,
    exit_confirmed_count: 2,
    all_exit_confirmed: true,
  });
  assert.equal(runSummary.source_relationship.parent_or_agent_relationship_observed, false);
  assert.equal(runSummary.deduplication.production_cockpit_deduplication_tested, false);
});

test('fixture response sanitizer does not retain unexpected metadata values', () => {
  const response = {
    result: {
      content: [{
        type: 'text',
        text: JSON.stringify({
          fixture: 'poc164_native_fixture',
          pr_key: 'poc164-fixture/agent-cockpit#164',
          registration: 'created',
          native_meta_thread_id: 'sk-should-not-appear',
        }),
      }],
    },
  };
  const summary = summarizeFixtureResponse(
    response,
    'expected-thread',
    'poc164-fixture/agent-cockpit#164',
  );
  assert.equal(summary.status, 'ok');
  assert.equal(summary.native_meta_thread_id, 'unknown');
  assert.doesNotMatch(JSON.stringify(summary), /should-not-appear/);
});
