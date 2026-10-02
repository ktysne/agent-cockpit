const { cockpitHomeFromOptions } = require('../server/identity');
const { ensureServerRunning } = require('../hooks/event');

async function main() {
  const homeDir = cockpitHomeFromOptions();
  const info = await ensureServerRunning({ homeDir, environment: process.env });
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
