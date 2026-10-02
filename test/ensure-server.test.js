const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const ensureServerScript = path.join(__dirname, '..', 'src', 'tray', 'ensure-server.js');

async function availablePort() {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const server = net.createServer();
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', resolve);
    });
    const { port } = server.address();
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    if (port !== 47821) return port;
  }
  assert.fail('A free port other than 47821 was not available.');
}

function runEnsureServer(environment) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [ensureServerScript], {
      cwd: path.join(__dirname, '..'),
      env: environment,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

async function waitForExit(pid, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function stopServer(homeDir) {
  try {
    const contents = await fs.readFile(path.join(homeDir, 'server.json'), 'utf8');
    const pidMatch = contents.match(/"pid"\s*:\s*(\d+)/);
    if (pidMatch) {
      const pid = Number(pidMatch[1]);
      try { process.kill(pid); } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
      await waitForExit(pid);
    }
  } finally {
    // 常駐サーバーは置き場を作業ディレクトリにするので、終わるまで Windows がフォルダーを掴む。
    await fs.rm(homeDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

test('ensure-server は空きポートでサーバーを起動し、ポートだけを出力する', async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-tray-test-'));
  const port = await availablePort();
  const environment = {
    ...process.env,
    AGENT_COCKPIT_HOME: homeDir,
    AGENT_COCKPIT_PORT: String(port),
  };
  t.after(() => stopServer(homeDir));

  const result = await runEnsureServer(environment);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout, `${JSON.stringify({ port })}\n`);
  assert.deepEqual(JSON.parse(result.stdout), { port });
  assert.ok(!result.stdout.includes('secret'));
});
