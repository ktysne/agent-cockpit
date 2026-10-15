const { cockpitHomeFromOptions } = require('../server/identity');
const { ensureServerRunning } = require('../client/server-connection');
const { verifyServer } = require('../client/server-verification');

// フックの 1 秒はセッションを止めないための上限で、利用者の操作で開くトレイには短すぎる。
const TRAY_START_TIMEOUT_MS = 5000;

async function main(argv = process.argv.slice(2), options = {}) {
  const homeDir = options.homeDir || cockpitHomeFromOptions(options);
  const ensure = options.ensureServerRunning || ensureServerRunning;
  const info = await ensure({
    homeDir,
    environment: options.environment || process.env,
    deadline: (options.now || Date.now)() + TRAY_START_TIMEOUT_MS,
  });
  if (!info) {
    return 1;
  }

  const write = options.write || (line => process.stdout.write(line));
  if (argv.includes('--verify')) {
    const verification = await (options.verifyServer || verifyServer)(info, {
      root: options.root,
      expected: options.expected,
      expectedVersion: options.expectedVersion,
      readSourceCommit: options.readSourceCommit,
      readFile: options.readFile,
      fetchImpl: options.fetchImpl,
      now: options.now,
      requestFromServer: options.requestFromServer,
    });
    write(`${JSON.stringify({
      port: info.port,
      pid: info.pid,
      result: verification.result,
      expected: { version: verification.expected.version },
      running: verification.running ? { version: verification.running.version } : null,
    })}\n`);
  } else {
    write(`${JSON.stringify({ port: info.port })}\n`);
  }
  return 0;
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; }).catch(() => { process.exitCode = 1; });
}

module.exports = { main };
