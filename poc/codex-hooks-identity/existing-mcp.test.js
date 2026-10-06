'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  appendMcpServerConfig,
  createServerDataRoot,
  isSuccessfulToolResponse,
  renderMcpServerConfig,
  summarizeRouting,
  validateServerChildPaths,
} = require('./run-existing-mcp');

test('existing MCP table is appended without replacing the identity probe config', () => {
  const original = '[mcp_servers.poc157_identity]\ncommand = "node"\nargs = ["probe.js"]\n';
  const table = '[mcp_servers.agent_cockpit]\ncommand = "node"\n';
  const updated = appendMcpServerConfig(original, table);

  assert.match(updated, /\[mcp_servers\.poc157_identity\]/);
  assert.match(updated, /\[mcp_servers\.agent_cockpit\]/);
  assert.throws(() => appendMcpServerConfig(`${updated}\n`, table), /already contains/);
});

test('existing MCP config uses only dedicated Cockpit paths and the synthetic session identity', () => {
  const config = renderMcpServerConfig({ cockpitHome: 'D:\\poc\\cockpit' });

  assert.match(config, /AGENT_COCKPIT_HOME/);
  assert.match(config, /poc157-synthetic-claude-session/);
  assert.doesNotMatch(config, /env_vars|GITHUB_TOKEN|OPENAI_API_KEY/);
});

test('existing MCP data directory is confined to the selected poc/out directory', () => {
  const root = createServerDataRoot('poc/out/poc157-existing-mcp-test', 'run-1');

  assert.match(root, /poc157-existing-mcp-test[\\/]existing-mcp-run-1$/);
  assert.throws(() => createServerDataRoot('poc/out/../../outside', 'run-1'), /under poc\/out/);
  assert.throws(() => validateServerChildPaths({
    root: 'C:\\outside',
    cockpitHome: 'C:\\outside\\cockpit',
    claudeHome: 'C:\\outside\\claude',
    userHome: 'C:\\outside\\user',
  }), /under poc\/out/);
});

test('legacy MCP routing summary reports only native and synthetic ID counts', () => {
  const summary = summarizeRouting(['native-thread-one', 'native-thread-two'], {
    sessions: [
      { session_id: 'native-thread-one', counts: { tasks: 0, decisions: 0, pull_requests: 0 }, body: 'PRIVATE_BODY' },
      { session_id: 'native-thread-two', counts: { tasks: 0, decisions: 0, pull_requests: 0 } },
      { session_id: 'poc157-synthetic-claude-session', counts: { tasks: 1, decisions: 2, pull_requests: 2 } },
      { session_id: 'sk-secret', counts: { tasks: 99, decisions: 99, pull_requests: 99 } },
    ],
  });

  assert.equal(summary.observed_legacy_routing_to_claude_id, true);
  assert.equal(summary.native_threads.length, 2);
  assert.equal(summary.synthetic_claude_session.counts.decisions, 2);
  assert.doesNotMatch(JSON.stringify(summary), /PRIVATE_BODY|sk-secret/);
});

test('existing MCP tool success is false for RPC errors, tool errors, and unknown responses', () => {
  assert.equal(isSuccessfulToolResponse({ result: { content: [{ type: 'text', text: 'fixture response' }] } }), true);
  assert.equal(isSuccessfulToolResponse({ error: { code: -32603 } }), false);
  assert.equal(isSuccessfulToolResponse({ result: { isError: true, content: [{ type: 'text', text: 'error' }] } }), false);
  assert.equal(isSuccessfulToolResponse({ result: { content: [] } }), false);
  assert.equal(isSuccessfulToolResponse({}), false);
});
