'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const test = require('node:test');

const { buildHookRecord, runHookLogger } = require('./hook-logger');
const { buildIdentityProbe, handleRequest } = require('./mcp-probe');
const { makeLayout, renderConfig, renderHooksConfig, resolveOutputDirectory, setup } = require('./setup');
const {
  buildRunMetadata,
  makeChildEnvironment,
  parseArguments: parseRpcArguments,
  sanitizeProbe,
  summarizeHookList,
  validatePaths,
} = require('./run-rpc');
const {
  FIXTURE_FINAL_TEXT,
  buildResult: buildExecResult,
  clearFixtureConfig,
  configureFixture,
  createEventCollector,
  createFixtureRequestsSummary,
  execArguments,
  makeChildEnvironment: makeExecChildEnvironment,
  parseArguments: parseExecArguments,
  summarizeEvent,
} = require('./run-exec');

test('hook records contain only bounded allowlisted identity and state fields', () => {
  const input = {
    hook_event_name: 'PostToolUse',
    session_id: 'thr-hook-123',
    agent_id: 'agent_abc',
    agent_type: 'explorer',
    model: 'gpt-6.1-sol',
    turn_id: 'turn-123',
    source: 'startup',
    reason: 'other',
    trigger: 'auto',
    tool_name: 'Bash',
    tool_use_id: 'call-123',
    permission_mode: 'default',
    stop_hook_active: false,
    prompt: 'PRIVATE_PROMPT_VALUE',
    tool_input: { command: 'PRIVATE_TOOL_INPUT' },
    tool_response: { output: 'PRIVATE_TOOL_OUTPUT', auth: 'PRIVATE_AUTH_VALUE' },
    transcript_path: 'PRIVATE_TRANSCRIPT_PATH',
    cwd: 'PRIVATE_CWD',
  };
  const record = buildHookRecord(input, '2026-10-05T00:00:00.000Z');

  assert.deepEqual(Object.keys(record), [
    'recorded_at', 'hook_event_name', 'session_id', 'agent_id', 'agent_type', 'model', 'turn_id',
    'source', 'reason', 'trigger', 'tool_name', 'tool_use_id', 'permission_mode', 'stop_hook_active',
    'tool_outcome',
  ]);
  assert.equal(record.session_id, 'thr-hook-123');
  assert.equal(record.agent_id, 'agent_abc');
  assert.equal(record.tool_outcome, 'unknown');
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_|auth/);
});

test('hook logger marks missing or malformed tool fields and outcomes unknown', () => {
  const record = buildHookRecord({
    hook_event_name: 'PostToolUse',
    tool_name: { secret: 'PRIVATE_TOOL_NAME' },
    exit_code: 0,
    success: true,
    tool_response: { status: 'succeeded', exit_code: 0 },
  });

  assert.equal(record.tool_name, 'unknown');
  assert.equal(record.tool_outcome, 'unknown');
  assert.doesNotMatch(JSON.stringify(record), /PRIVATE_TOOL_NAME|succeeded/);
});

test('hook logger rejects credential-shaped values even in allowlisted fields', () => {
  const record = buildHookRecord({
    hook_event_name: 'PostToolUse',
    session_id: 'sk-example-secret',
    agent_id: 'ghp_example_secret',
    agent_type: 'eyJprivate.value',
    model: 'Bearer private-value',
    tool_name: 'github_pat_private-value',
  });

  assert.equal(record.session_id, 'unknown');
  assert.equal(record.agent_id, 'unknown');
  assert.equal(record.agent_type, 'unknown');
  assert.equal(record.model, 'unknown');
  assert.equal(record.tool_name, 'unknown');
  assert.doesNotMatch(JSON.stringify(record), /sk-example-secret|ghp_example_secret|eyJprivate|Bearer|github_pat_private/);
});

test('Stop and SubagentStop return an empty JSON object', async () => {
  for (const eventName of ['Stop', 'SubagentStop']) {
    let output = '';
    await runHookLogger({ hook_event_name: eventName }, path.join(os.tmpdir(), 'missing-poc157-log'), {
      write(chunk) { output += chunk; },
    });
    assert.equal(output, '{}\n');
  }
});

test('MCP probe keeps explicit IDs separate and compares a safe meta threadId', () => {
  const probe = buildIdentityProbe({
    session_id: 'thr-explicit-1',
    agent_id: 'agent-explicit-1',
  }, {
    CODEX_THREAD_ID: 'thr-environment-1',
    CODEX_SESSION_ID: 'thr-environment-2',
    CODEX_AGENT_ID: 'agent-environment-1',
    CODEX_TURN_ID: 'turn-environment-1',
    CLAUDE_CODE_SESSION_ID: 'claude-secret-session-value',
  }, {
    progressToken: 'PRIVATE_PROGRESS_VALUE',
    'trace/thread': 'PRIVATE_SLASH_VALUE',
    threadId: 'thr-meta-1',
  });

  assert.equal(probe.explicit.session_id, 'thr-explicit-1');
  assert.equal(probe.explicit.agent_id, 'agent-explicit-1');
  assert.equal(probe.environment.codex.CODEX_THREAD_ID.value, 'thr-environment-1');
  assert.equal(probe.mcp_meta.thread_id, 'thr-meta-1');
  assert.equal(probe.mcp_meta.matches_explicit_session_id, false);
  assert.deepEqual(probe.mcp_meta.keys, ['progressToken', 'threadId', 'trace/thread']);
  assert.equal(probe.environment.claude_code_session.present, true);
  assert.equal(probe.environment.claude_code_session.matches_explicit_session_id, false);
  assert.doesNotMatch(JSON.stringify(probe), /PRIVATE_|claude-secret-session-value/);
});

test('MCP tool list declares the identity probe read-only and side-effect free', () => {
  const listed = handleRequest({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  assert.deepEqual(listed.result.tools[0].annotations, {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
});

test('MCP meta threadId can match the explicit session ID without exposing other meta values', () => {
  const probe = buildIdentityProbe({ session_id: 'thr-same-1' }, {}, {
    threadId: 'thr-same-1',
    progressToken: 'PRIVATE_PROGRESS_VALUE',
  });

  assert.equal(probe.mcp_meta.thread_id, 'thr-same-1');
  assert.equal(probe.mcp_meta.matches_explicit_session_id, true);
  assert.deepEqual(probe.mcp_meta.keys, ['progressToken', 'threadId']);
  assert.doesNotMatch(JSON.stringify(probe), /PRIVATE_PROGRESS_VALUE/);
});

test('MCP probe reports missing metadata as unknown and never adopts a Claude session ID', () => {
  const probe = buildIdentityProbe({ session_id: 'thr-explicit-2' }, {
    CLAUDE_CODE_SESSION_ID: 'claude-private-session',
  }, {});

  assert.equal(probe.explicit.session_id, 'thr-explicit-2');
  assert.equal(probe.mcp_meta.thread_id, 'unknown');
  assert.equal(probe.mcp_meta.matches_explicit_session_id, null);
  assert.equal(probe.environment.claude_code_session.matches_explicit_session_id, false);
  assert.equal(probe.environment.codex.CODEX_THREAD_ID.present, false);
  assert.doesNotMatch(JSON.stringify(probe), /claude-private-session/);
});

test('MCP probe rejects overlong and credential-shaped environment values', () => {
  const probe = buildIdentityProbe({}, {
    CODEX_THREAD_ID: 'sk-example-secret',
    CODEX_SESSION_ID: 'x'.repeat(129),
  }, { threadId: 'y'.repeat(129) });

  assert.equal(probe.environment.codex.CODEX_THREAD_ID.present, true);
  assert.equal(probe.environment.codex.CODEX_THREAD_ID.value, 'unknown');
  assert.equal(probe.environment.codex.CODEX_SESSION_ID.value, 'unknown');
  assert.equal(probe.mcp_meta.thread_id, 'unknown');
});

test('MCP stdio protocol handles initialize, tools/list, and tools/call', () => {
  const initialize = handleRequest({
    jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' },
  });
  const listed = handleRequest({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  const called = handleRequest({
    jsonrpc: '2.0',
    id: 3,
    method: 'tools/call',
    params: { name: 'probe_identity', arguments: { session_id: 'thr-mcp-1', agent_id: 'agent-mcp-1' } },
  }, {});

  assert.equal(initialize.result.protocolVersion, '2025-06-18');
  assert.equal(listed.result.tools[0].name, 'probe_identity');
  assert.equal(JSON.parse(called.result.content[0].text).explicit.session_id, 'thr-mcp-1');
});

test('setup guard confines the generated home and repository to an explicit poc/out child', () => {
  const root = path.resolve(os.tmpdir(), 'agent-cockpit-fixture-root');
  const output = resolveOutputDirectory('poc/out/poc157-live', root);
  const layout = makeLayout(output);

  assert.equal(output, path.join(root, 'poc', 'out', 'poc157-live'));
  assert.equal(layout.home, path.join(output, 'home'));
  assert.equal(layout.repo, path.join(output, 'repo'));
  assert.throws(() => resolveOutputDirectory('poc/out/../../outside', root), /under poc\/out/);
  assert.throws(() => resolveOutputDirectory(path.join(os.tmpdir(), '.codex'), root), /under poc\/out/);
  assert.throws(() => setup({ outputDirectory: 'poc/out/blocked', codexVersion: '0.159.0' }), /0\.160\.0/);
});

test('setup generates command hooks for every documented lifecycle event', () => {
  const config = JSON.parse(renderHooksConfig(path.join(os.tmpdir(), 'codex-poc157-hook.js')));
  assert.deepEqual(Object.keys(config.hooks), [
    'SessionStart', 'SessionEnd', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
    'PreCompact', 'PostCompact', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop', 'Stop', 'Interrupt',
  ]);
  assert.equal(config.hooks.Stop[0].hooks[0].type, 'command');
});

test('setup config forwards only the synthetic Claude identity candidate and leaves provider selection open', () => {
  const config = renderConfig(path.join(os.tmpdir(), 'mcp-probe.js'));
  assert.match(config, /env_vars = \["CLAUDE_CODE_SESSION_ID"\]/);
  assert.doesNotMatch(config, /model_provider|auth\.json|CODEX_MESSAGING_TOKEN/);
});

test('RPC runner accepts only explicit paths and removes host credentials from its child environment', () => {
  const args = parseRpcArguments(['--codex-path', 'C:\\Codex\\codex.exe', '--out', 'poc/out/poc157-live']);
  assert.equal(args.codexPath, 'C:\\Codex\\codex.exe');
  assert.throws(() => parseRpcArguments(['--out', 'poc/out/poc157-live']), /Usage:/);
  assert.throws(() => validatePaths('C:\\Codex\\codex.exe', path.join(os.tmpdir(), '.codex')), /under poc\/out/);

  const environment = makeChildEnvironment({
    PATH: 'C:\\Windows', OPENAI_API_KEY: 'PRIVATE_API_KEY',
    CLAUDE_CODE_MESSAGING_TOKEN: 'PRIVATE_MESSAGING_TOKEN',
  }, 'D:\\poc\\out\\home');
  assert.deepEqual(environment, {
    PATH: 'C:\\Windows',
    CODEX_HOME: 'D:\\poc\\out\\home',
    CLAUDE_CODE_SESSION_ID: 'poc157-synthetic-claude-session',
  });
});

test('RPC result sanitizer keeps the Claude identifier as a boolean and omits unknown payload fields', () => {
  const probe = sanitizeProbe({
    explicit: { session_id: 'thr-explicit-3', agent_id: 'agent-explicit-3' },
    environment: {
      codex: { CODEX_THREAD_ID: { present: true, value: 'thr-env-3' } },
      claude_code_session: { present: true, matches_explicit_session_id: false, value: 'PRIVATE_CLAUDE_ID' },
    },
    mcp_meta: { keys: ['progressToken', 'threadId'], thread_id: 'thr-meta-3', matches_explicit_session_id: false },
    secret: 'PRIVATE_TOOL_RESPONSE',
  });

  assert.equal(probe.environment.claude_code_session.present, true);
  assert.equal(probe.environment.claude_code_session.matches_explicit_session_id, false);
  assert.equal(probe.mcp_meta.matches_explicit_session_id, false);
  assert.deepEqual(probe.environment.codex.CODEX_SESSION_ID, { present: false, value: 'unknown' });
  assert.doesNotMatch(JSON.stringify(probe), /PRIVATE_/);
});

test('RPC hook listing recognizes app-server lowerCamel event names without retaining source paths', () => {
  const hooks = summarizeHookList({
    result: { data: [{ hooks: [
      { eventName: 'preToolUse', source: 'user', trustStatus: 'trusted', enabled: true, sourcePath: 'PRIVATE_PATH' },
      { eventName: 'PreToolUse', source: 'user', trustStatus: 'trusted', enabled: true },
    ] }] },
  });

  assert.equal(hooks[0].event_name, 'preToolUse');
  assert.equal(hooks[1].event_name, 'unknown');
  assert.doesNotMatch(JSON.stringify(hooks), /PRIVATE_PATH/);
});

test('RPC run metadata records only the verified version and platform', () => {
  const metadata = buildRunMetadata('private agent metadata 0.160.0', 'win32', 'x64');

  assert.deepEqual(metadata, { version: '0.160.0', platform: 'win32', architecture: 'x64' });
  assert.throws(() => buildRunMetadata('0.159.0'), /0\.160\.0/);
  assert.doesNotMatch(JSON.stringify(metadata), /private agent metadata/);
});

test('exec runner accepts explicit isolated paths and a serve-only mode', () => {
  const args = parseExecArguments(['--codex-path', 'C:\\Codex\\codex.exe', '--out', 'poc/out/poc157-live', '--serve']);
  assert.deepEqual(args, {
    codexPath: 'C:\\Codex\\codex.exe',
    outputDirectory: 'poc/out/poc157-live',
    serve: true,
  });
  assert.throws(() => parseExecArguments(['--out', 'poc/out/poc157-live']), /Usage:/);
  assert.throws(() => parseExecArguments(['--codex-path', 'codex.exe', '--out', 'poc/out/a', '--serve', '--serve']), /Usage:/);
});

test('exec child receives only OS variables and the dedicated Codex home', () => {
  const environment = makeExecChildEnvironment({
    PATH: 'C:\\Windows', APPDATA: 'C:\\Users\\fixture\\AppData', OPENAI_API_KEY: 'PRIVATE_API_KEY',
    CLAUDE_CODE_SESSION_ID: 'PRIVATE_CLAUDE_ID', CLAUDE_CODE_MESSAGING_TOKEN: 'PRIVATE_MESSAGING_TOKEN',
  }, 'D:\\poc\\out\\home');

  assert.deepEqual(environment, {
    PATH: 'C:\\Windows', APPDATA: 'C:\\Users\\fixture\\AppData', CODEX_HOME: 'D:\\poc\\out\\home',
  });
  assert.doesNotMatch(JSON.stringify(environment), /PRIVATE_/);
});

test('exec command uses the read-only fixture path without trust or approval bypasses', () => {
  const args = execArguments({ repo: 'D:\\poc\\out\\repo' });

  assert.deepEqual(args.slice(0, 8), [
    '--no-daemon', 'exec', '--json', '--ephemeral', '-C', 'D:\\poc\\out\\repo', '-s', 'read-only',
  ]);
  assert.ok(args[8].includes('local fixture scenario'));
  assert.doesNotMatch(args.join(' '), /dangerously|bypass|approval|sandbox/);
});

test('fixture provider config is added and removed without changing the MCP table', () => {
  const configPath = path.join(os.tmpdir(), `poc157-exec-config-${process.pid}-${Date.now()}.toml`);
  const original = [
    'profile = "poc157"',
    'model = "original-model"',
    'model_provider = "original_provider"',
    '',
    '[model_providers.original_provider]',
    'name = "Original provider"',
    'base_url = "http://127.0.0.1:1"',
    '',
    '[mcp_servers.poc157_identity]',
    'command = "node"',
    'args = ["probe.js"]',
    '',
  ].join('\r\n');
  const token = 'a'.repeat(64);
  fs.writeFileSync(configPath, original, { encoding: 'utf8', flag: 'wx' });
  try {
    const snapshot = configureFixture({ home: path.dirname(configPath), repo: path.dirname(configPath) }, configPath, {
      baseUrl: 'http://127.0.0.1:12345',
      requestHeaders: { 'X-Poc157-Token': token },
    });
    const configured = fs.readFileSync(configPath, 'utf8');
    assert.match(configured, /model = "poc157-fixture-model"/);
    assert.match(configured, /\[model_providers\.poc157_fixture\]/);
    assert.match(configured, /\[mcp_servers\.poc157_identity\]/);
    assert.match(configured, /args = \["probe\.js"\]/);
    assert.match(configured, new RegExp(token));
    assert.equal(clearFixtureConfig(configPath, snapshot.configSnapshot), true);
    assert.equal(fs.readFileSync(configPath, 'utf8'), original);
    assert.doesNotMatch(fs.readFileSync(configPath, 'utf8'), /X-Poc157-Token|poc157-fixture-model/);
    assert.match(fs.readFileSync(configPath, 'utf8'), /model = "original-model"/);
    assert.match(fs.readFileSync(configPath, 'utf8'), /model_provider = "original_provider"/);
  } finally {
    fs.unlinkSync(configPath);
  }
});

test('fixture config cleanup preserves concurrent edits instead of restoring over them', () => {
  const configPath = path.join(os.tmpdir(), `poc157-exec-edited-config-${process.pid}-${Date.now()}.toml`);
  const original = 'model = "original-model"\nmodel_provider = "original_provider"\n[mcp_servers.poc157_identity]\ncommand = "node"\n';
  fs.writeFileSync(configPath, original, { encoding: 'utf8', flag: 'wx' });
  try {
    const configured = configureFixture({ home: path.dirname(configPath), repo: path.dirname(configPath) }, configPath, {
      baseUrl: 'http://127.0.0.1:12345',
      requestHeaders: { 'X-Poc157-Token': 'b'.repeat(64) },
    });
    const interveningEdit = `${fs.readFileSync(configPath, 'utf8')}\n[notice]\nenabled = true\n`;
    fs.writeFileSync(configPath, interveningEdit, 'utf8');

    assert.equal(clearFixtureConfig(configPath, configured.configSnapshot), false);
    assert.equal(fs.readFileSync(configPath, 'utf8'), interveningEdit);
    assert.throws(() => clearFixtureConfig(configPath), /snapshot is required/);
  } finally {
    fs.unlinkSync(configPath);
  }
});

test('exec event summaries keep public fields and the sanitized MCP probe only', () => {
  const probe = {
    explicit: { session_id: 'thr-exec-1', agent_id: 'agent-exec-1' },
    environment: {
      codex: { CODEX_THREAD_ID: { present: true, value: 'thr-env-1' } },
      claude_code_session: { present: true, matches_explicit_session_id: false, value: 'PRIVATE_CLAUDE_ID' },
    },
    mcp_meta: { keys: ['progressToken', 'threadId'], thread_id: 'thr-exec-1', matches_explicit_session_id: true },
    private: 'PRIVATE_TOOL_RESPONSE',
  };
  const event = {
    type: 'item.completed',
    thread_id: 'thr-exec-1',
    item: {
      id: 'item-exec-1', type: 'mcp_tool_call', status: 'completed',
      arguments: 'PRIVATE_TOOL_ARGUMENTS',
      result: { content: [{ type: 'text', text: JSON.stringify(probe) }] },
    },
    message: 'PRIVATE_MESSAGE',
  };
  const summary = summarizeEvent(event);

  assert.equal(summary.event_type, 'item.completed');
  assert.equal(summary.thread_id, 'thr-exec-1');
  assert.equal(summary.item_status, 'completed');
  assert.equal(summary.mcp_probe.explicit.session_id, 'thr-exec-1');
  assert.equal(summary.mcp_probe.environment.claude_code_session.present, true);
  assert.equal(summary.message, undefined);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_/);
});

test('exec event collector records only the fixed fixture message and safe error code', () => {
  const collector = createEventCollector();
  collector.consume(Buffer.from(`${JSON.stringify({ type: 'assistant_message', message: FIXTURE_FINAL_TEXT })}\n`));
  collector.consume(Buffer.from(`${JSON.stringify({ type: 'turn.failed', error: { code: 'fixture_error', message: 'PRIVATE_API_ERROR' } })}\n`));
  const result = collector.finish();

  assert.equal(result.fixture_message_seen, true);
  assert.equal(result.tool_error_count, 1);
  assert.equal(result.events[0].message, FIXTURE_FINAL_TEXT);
  assert.equal(result.events[1].api_error_code, 'fixture_error');
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_API_ERROR/);
});

test('exec event collector preserves Japanese fixture text when a UTF-8 character spans chunks', () => {
  const collector = createEventCollector();
  const payload = Buffer.from(`${JSON.stringify({ type: 'assistant_message', message: FIXTURE_FINAL_TEXT })}\n`, 'utf8');
  const split = payload.indexOf(Buffer.from('ロ', 'utf8')) + 1;

  collector.consume(payload.subarray(0, split));
  collector.consume(payload.subarray(split));
  const result = collector.finish();

  assert.equal(result.fixture_message_seen, true);
  assert.equal(result.events[0].message, FIXTURE_FINAL_TEXT);
  assert.equal(result.malformed_line_count, 0);
});

test('exec success requires a completed fixture exchange without unsupported tools or tool errors', () => {
  const fixture = {
    unsupported: 'PRIVATE_UNSUPPORTED_DETAIL',
    requests: [{ path: '/v1/responses', toolNames: ['exec_command'], headerNames: ['x-poc157-token'],
      bodyShape: { topLevel: [{ key: 'model', type: 'string' }] }, identityHeaders: { 'x-session-id': 'PRIVATE_ID' } },
    { path: '/v1/responses', toolNames: ['mcp__poc157_identity.probe_identity'], headerNames: [], bodyShape: { topLevel: [] } },
    { path: '/v1/responses', toolNames: [], headerNames: [], bodyShape: { topLevel: [] } }],
  };
  const result = buildExecResult({
    run: 'exec',
    version: { version: '0.160.0' },
    fixture,
    childResult: { exitCode: 0, signal: null, timedOut: false, interrupted: false, spawnErrorCode: null },
    eventResult: { events: [], probe_results: [{}], tool_error_count: 1, fixture_message_seen: true,
      malformed_line_count: 0, omitted_event_count: 0, warning_mentions: 0, error_mentions: 0 },
    stderrResult: { warning_mentions: 0, error_mentions: 0 },
  });

  assert.equal(result.success, false);
  assert.equal(result.backend.real_model_observed, false);
  assert.equal(result.fixture.unsupported, true);
  assert.ok(result.failure_reasons.includes('unsupported_tool_schema'));
  assert.ok(result.failure_reasons.includes('tool_error'));
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_/);
});

test('fixture request summaries omit identity values and credential-shaped tool names', () => {
  const summary = createFixtureRequestsSummary([{
    path: '/v1/responses',
    toolNames: ['exec_command', 'sk-private-tool-name'],
    headerNames: ['x-poc157-token'],
    identityHeaders: { 'x-session-id': 'PRIVATE_SESSION_ID' },
    bodyShape: { topLevel: [{ key: 'tools', type: 'array' }] },
  }]);

  assert.deepEqual(summary.tool_names, ['exec_command']);
  assert.deepEqual(summary.header_names, ['x-poc157-token']);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_|sk-private/);
});
