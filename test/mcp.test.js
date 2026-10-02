const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { startMcpServer, UNREACHABLE_MESSAGE } = require('../src/mcp/server');

async function exchange(requests, options = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.setEncoding('utf8').on('data', (chunk) => { text += chunk; });
  const running = startMcpServer({ input, output, ...options });
  input.end(requests.map((request) => JSON.stringify(request)).join('\n') + '\n');
  await running;
  return text.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

test('MCP stdio は initialize、tools/list、tools/call に応答する', async () => {
  let sent = null;
  const responses = await exchange([
    { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } },
    { jsonrpc: '2.0', id: 2, method: 'tools/list' },
    {
      jsonrpc: '2.0', id: 3, method: 'tools/call',
      params: { name: 'cockpit_set_tasks', arguments: { tasks: [{ title: 'テストを書く', state: 'doing', criteria: [] }] } },
    },
  ], {
    homeDir: 'C:\\temporary-cockpit',
    environment: {
      CLAUDE_CODE_SESSION_ID: 'mcp-session',
      CLAUDE_CODE_MESSAGING_TOKEN: 'must-not-be-sent',
      PRIVATE_ENV_VALUE: 'also-must-not-be-sent',
    },
    ppid: 321,
    ensureServerRunning: async () => ({ port: 49124, secret: 'test-secret' }),
    fetchImpl: async (url, init) => {
      sent = { url, headers: init.headers, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ tasks: [{ title: 'テストを書く', state: 'doing' }] }), { status: 200 });
    },
  });
  assert.equal(responses.length, 3);
  assert.equal(responses[0].id, 1);
  assert.equal(responses[0].result.serverInfo.name, 'agent-cockpit');
  assert.deepEqual(responses[1].result.tools.map((tool) => tool.name), [
    'cockpit_set_tasks', 'cockpit_add_decision', 'cockpit_update_decision',
  ]);
  assert.equal(responses[2].id, 3);
  assert.match(responses[2].result.content[0].text, /テストを書く \(doing\)/);
  assert.equal(sent.url, 'http://127.0.0.1:49124/api/sessions/mcp-session/plan');
  assert.equal(sent.headers['x-cockpit-secret'], 'test-secret');
  assert.deepEqual(
    [sent.body.kind, sent.body.ppid, sent.body.claudeCodeSessionId],
    ['tasks', 321, 'mcp-session'],
  );
  assert.ok(!JSON.stringify(sent).includes('must-not-be-sent'));
  assert.ok(!JSON.stringify(sent).includes('PRIVATE_ENV_VALUE'));
  assert.ok(!JSON.stringify(responses).includes('test-secret'));
});

test('常駐サーバーに届かない tools/call は isError で継続可能と伝える', async () => {
  const responses = await exchange([{
    jsonrpc: '2.0', id: 1, method: 'tools/call',
    params: { name: 'cockpit_set_tasks', arguments: { tasks: [] } },
  }], {
    homeDir: 'C:\\temporary-cockpit',
    environment: {},
    ensureServerRunning: async () => null,
  });
  assert.equal(responses[0].result.isError, true);
  assert.equal(responses[0].result.content[0].text, UNREACHABLE_MESSAGE);
});
