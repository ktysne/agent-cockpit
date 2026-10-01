// PoC: 最小の MCP サーバー(stdio)。whoami ツールで、呼び出し元セッションを判別できる環境変数があるかを返す。
const readline = require('readline');

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');

rl.on('line', (line) => {
  let req;
  try {
    req = JSON.parse(line);
  } catch {
    return;
  }
  if (req.id === undefined) return;
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        protocolVersion: req.params?.protocolVersion ?? '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'board-poc', version: '0.0.0' },
      },
    });
  } else if (req.method === 'tools/list') {
    send({
      jsonrpc: '2.0',
      id: req.id,
      result: {
        tools: [
          {
            name: 'whoami',
            description: 'MCP サーバーから見えるセッション識別情報を返す',
            inputSchema: { type: 'object', properties: {} },
          },
        ],
      },
    });
  } else if (req.method === 'tools/call') {
    const info = {
      CLAUDE_CODE_SESSION_ID: process.env.CLAUDE_CODE_SESSION_ID ?? null,
      hasMessagingSocket: Boolean(process.env.CLAUDE_CODE_MESSAGING_SOCKET),
      hasMessagingToken: Boolean(process.env.CLAUDE_CODE_MESSAGING_TOKEN),
      ppid: process.ppid,
    };
    send({ jsonrpc: '2.0', id: req.id, result: { content: [{ type: 'text', text: JSON.stringify(info) }] } });
  } else {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: 'method not found' } });
  }
});
