'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  buildResult,
  execArguments,
  parseArguments,
} = require('./run-exec');

function fixtureRequests(count) {
  return Array.from({ length: count }, () => ({
    path: '/v1/responses',
    toolNames: [],
    headerNames: ['x-poc157-token'],
    bodyShape: { topLevel: [{ key: 'model', type: 'string' }] },
  }));
}

function build(startWith, requestCount, overrides = {}) {
  return buildResult({
    run: 'exec',
    startWith,
    version: { version: '0.160.0' },
    fixture: { requests: fixtureRequests(requestCount) },
    childResult: { exitCode: 0, signal: null, timedOut: false, interrupted: false, spawnErrorCode: null },
    eventResult: {
      events: [],
      probe_results: [{}],
      tool_error_count: 0,
      fixture_message_seen: true,
      malformed_line_count: 0,
      omitted_event_count: 0,
      warning_mentions: 0,
      error_mentions: 0,
      ...overrides,
    },
    stderrResult: { warning_mentions: 0, error_mentions: 0 },
  });
}

test('exec scenario defaults to command and accepts MCP as its first tool', () => {
  const baseArguments = ['--codex-path', 'codex.exe', '--out', 'poc/out/poc157'];
  assert.equal(parseArguments(baseArguments).startWith, undefined);
  assert.equal(parseArguments([...baseArguments, '--start-with', 'mcp']).startWith, 'mcp');
  assert.throws(() => parseArguments([...baseArguments, '--start-with', 'other']), /Usage:/);
  assert.throws(() => parseArguments([...baseArguments, '--start-with', 'mcp', '--start-with', 'command']), /Usage:/);
});

test('exec prompt asks for only MCP when the fixture begins with MCP', () => {
  const layout = { repo: 'poc/out/poc157/repo' };
  const parsedDefault = parseArguments(['--codex-path', 'codex.exe', '--out', 'poc/out/poc157']);
  const commandPrompt = execArguments(layout, parsedDefault.startWith).at(-1);
  const mcpPrompt = execArguments(layout, 'mcp').at(-1);

  assert.match(commandPrompt, /exec command and MCP identity probe/);
  assert.match(mcpPrompt, /only the available MCP identity probe/);
  assert.doesNotMatch(mcpPrompt, /exec command/);
});

test('completed exchange uses three requests for command and two for MCP', () => {
  const command = build(undefined, 3);
  const mcp = build('mcp', 2);

  assert.equal(command.success, true);
  assert.equal(command.start_with, 'command');
  assert.equal(command.fixture.requests.request_count, 3);
  assert.equal(mcp.success, true);
  assert.equal(mcp.start_with, 'mcp');
  assert.equal(mcp.fixture.requests.request_count, 2);
  assert.ok(build('command', 2).failure_reasons.includes('incomplete_fixture_exchange'));
  assert.ok(build('mcp', 1).failure_reasons.includes('incomplete_fixture_exchange'));
});

test('MCP exchange still requires final text, a probe result, and no tool errors', () => {
  const missingFinal = build('mcp', 2, { fixture_message_seen: false });
  const missingProbe = build('mcp', 2, { probe_results: [] });
  const toolError = build('mcp', 2, { tool_error_count: 1 });

  assert.ok(missingFinal.failure_reasons.includes('incomplete_fixture_exchange'));
  assert.ok(missingProbe.failure_reasons.includes('missing_mcp_probe_result'));
  assert.ok(toolError.failure_reasons.includes('tool_error'));
  assert.equal(missingFinal.success || missingProbe.success || toolError.success, false);
});
