// PoC: フックの stdin をそのまま poc/out/events.jsonl に追記する。
// 環境変数は、セッションの判別に使えるものがあるかだけを記録し、値は残さない。
const fs = require('fs');
const path = require('path');

let input = '';
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const outDir = path.join(__dirname, 'out');
  fs.mkdirSync(outDir, { recursive: true });
  let event;
  try {
    event = JSON.parse(input);
  } catch {
    event = { raw: input };
  }
  event._env = {
    hasSessionId: Boolean(process.env.CLAUDE_CODE_SESSION_ID),
    sessionIdMatches: process.env.CLAUDE_CODE_SESSION_ID === event.session_id,
    hasMessagingSocket: Boolean(process.env.CLAUDE_CODE_MESSAGING_SOCKET),
    hasMessagingToken: Boolean(process.env.CLAUDE_CODE_MESSAGING_TOKEN),
  };
  fs.appendFileSync(path.join(outDir, 'events.jsonl'), JSON.stringify(event) + '\n');
});
