const { cockpitHomeFromOptions } = require('../server/identity');
const { ensureServerRunning } = require('../hooks/event');

// フックの 1 秒はセッションを止めないための上限で、利用者の操作で開くトレイには短すぎる。
const TRAY_START_TIMEOUT_MS = 5000;

async function main() {
  const homeDir = cockpitHomeFromOptions();
  const info = await ensureServerRunning({
    homeDir,
    environment: process.env,
    deadline: Date.now() + TRAY_START_TIMEOUT_MS,
  });
  if (!info) {
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`${JSON.stringify({ port: info.port })}\n`);
}

if (require.main === module) {
  main().catch(() => { process.exitCode = 1; });
}

module.exports = { main };
