'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  assertNoSymlinkComponents,
  buildMcpConfig,
  isWithinDirectory,
  makeChildEnvironment,
  makeLayout,
  parseArguments,
  summarizeCapture,
  summarizeRun,
  summarizeFixtureResponse,
  verifyMcpProcessExits,
} = require('./native-probe');
const {
  buildToolCallResult,
  handleRequest,
  parseFixturePullRequestUrl,
} = require('./mcp-probe');

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
  assert.match(config, /\\[mcp_servers\\.poc164_native\\]/);
  assert.ok(config.includes('command = "C:\\\\Program Files\\\\nodejs\\\\node.exe"'));
  assert.match(config, /POC164_CAPTURE_PATH/);
  assert.doesNotMatch(config, /OPENAI_API_KEY|CLAUDE_CODE_SESSION_ID/);
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
