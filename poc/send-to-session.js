// PoC: 受付ソケットへメッセージを 1 件送る。
// 使い方: node send-to-session.js <遅延ミリ秒> <本文> [from]
// ソケットのパスとトークンは環境変数から読む(常駐サーバーでは SessionStart フックから受け取る想定)。
const net = require('net');

const [delayMs, text, from] = process.argv.slice(2);
const socketPath = process.env.CLAUDE_CODE_MESSAGING_SOCKET;
const token = process.env.CLAUDE_CODE_MESSAGING_TOKEN;

setTimeout(() => {
  const c = net.connect(socketPath, () => {
    const frame = { type: 'user', message: { role: 'user', content: text } };
    if (from) frame.from = from;
    c.write(JSON.stringify({ type: 'auth', token }) + '\n' + JSON.stringify(frame) + '\n');
    c.end();
  });
  c.on('error', (e) => console.error('send failed:', e.message));
}, Number(delayMs));
