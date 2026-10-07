'use strict';

const { fork } = require('node:child_process');
const path = require('node:path');

const PARENT_SCRIPT = path.join(__dirname, 'fake-claude-parent.js');
const HOOK_SCRIPTS = Object.freeze({
  event: path.join(__dirname, '..', '..', 'src', 'hooks', 'event.js'),
  answer: path.join(__dirname, '..', '..', 'src', 'hooks', 'answer.js'),
  away: path.join(__dirname, '..', '..', 'src', 'hooks', 'away.js'),
});
const MCP_SCRIPT = path.join(__dirname, '..', '..', 'src', 'mcp', 'server.js');

// 擬似の Claude 本体(node の子プロセス)を起動する。フックと MCP サーバーはその直接の子になる。
async function startFakeClaude(testContext, { claudeHome, homeDir, sessionId, procStart }) {
  const child = fork(PARENT_SCRIPT, [claudeHome, sessionId, procStart || `start-${sessionId}`], {
    stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
  });
  const pending = new Map();
  let nextRequestId = 1;
  const exited = new Promise((resolve) => child.once('exit', resolve));
  const ready = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.on('message', (message) => {
      if (message.ready) resolve(message.pid);
      else pending.get(message.requestId)?.(message);
    });
  });
  const pid = await ready;
  testContext.after(async () => {
    child.kill();
    await exited;
  });

  const environment = { AGENT_COCKPIT_HOME: homeDir };
  function send(cmd, payload = {}) {
    const requestId = nextRequestId++;
    return new Promise((resolve) => {
      pending.set(requestId, (message) => {
        pending.delete(requestId);
        resolve(message);
      });
      child.send({ cmd, requestId, ...payload });
    });
  }

  let nextMcpId = 1;
  let nextRpcId = 1;
  return {
    pid,
    runHook: (name, input, env = {}) => send('run-hook', {
      script: HOOK_SCRIPTS[name], input, env: { ...environment, ...env },
    }),
    async startMcp({ viaShim = false, env = {} } = {}) {
      const mcpId = nextMcpId++;
      await send('start-mcp', { mcpId, script: MCP_SCRIPT, viaShim, env: { ...environment, ...env } });
      return mcpId;
    },
    async callTool(mcpId, name, args) {
      const { response } = await send('call-mcp', {
        mcpId,
        request: { jsonrpc: '2.0', id: nextRpcId++, method: 'tools/call', params: { name, arguments: args } },
      });
      return response;
    },
    stopMcp: (mcpId) => send('stop-mcp', { mcpId }),
    setSession: (nextSessionId) => send('set-session', { sessionId: nextSessionId }),
    async exit() {
      child.send({ cmd: 'exit' });
      await exited;
    },
  };
}

module.exports = { startFakeClaude };
