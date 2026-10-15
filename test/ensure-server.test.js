const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const { temporaryDirectory } = require('./support/temp');
const { main } = require('../src/tray/ensure-server');

const ensureServerScript = path.join(__dirname, '..', 'src', 'tray', 'ensure-server.js');

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
  const contents = await fs.readFile(path.join(homeDir, 'server.json'), 'utf8');
  const pidMatch = contents.match(/"pid"\s*:\s*(\d+)/);
  if (pidMatch) {
    const pid = Number(pidMatch[1]);
    try { process.kill(pid); } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    await waitForExit(pid);
  }
}

test('ensure-server は空きポートでサーバーを起動し、ポートだけを出力する', async (t) => {
  const temporary = temporaryDirectory(t, 'agent-cockpit-tray-test-', { deferCleanup: true });
  const homeDir = temporary.directory;
  const environment = {
    ...process.env,
    AGENT_COCKPIT_HOME: homeDir,
    AGENT_COCKPIT_PORT: '0',
  };
  t.after(async () => {
    try {
      await stopServer(homeDir);
    } finally {
      await temporary.cleanup();
    }
  });

  const result = await runEnsureServer(environment);
  assert.equal(result.code, 0);
  assert.equal(result.signal, null);
  assert.equal(result.stderr, '');
  const { port } = JSON.parse(result.stdout);
  assert.ok(port > 0);
  assert.notEqual(port, 47821);
  assert.equal(result.stdout, `${JSON.stringify({ port })}\n`);
  assert.ok(!result.stdout.includes('secret'));
});

test('ensure-server --verify は照合結果と版だけを JSON で出力し、mismatch でも起動情報があれば成功する', async () => {
  for (const [result, running, expectedLine] of [
    ['mismatch', { version: '1.3.0', commit: 'private', sourceState: 'dirty' },
      '{"port":47821,"pid":456,"result":"mismatch","expected":{"version":"1.4.0"},"running":{"version":"1.3.0"}}\n'],
    ['start-failed', null,
      '{"port":47821,"pid":456,"result":"start-failed","expected":{"version":"1.4.0"},"running":null}\n'],
  ]) {
    const lines = [];
    const code = await main(['--verify'], {
      homeDir: 'test-home',
      now: () => 100,
      ensureServerRunning: async options => {
        assert.equal(options.homeDir, 'test-home');
        return { port: 47821, pid: 456 };
      },
      verifyServer: async info => {
        assert.deepEqual(info, { port: 47821, pid: 456 });
        return { result, expected: { version: '1.4.0', commit: 'private' }, running };
      },
      write: line => lines.push(line),
    });
    assert.equal(code, 0);
    assert.deepEqual(lines, [expectedLine]);
  }
});

test('ensure-server は --verify が無ければ従来どおりポートだけを出力する', async () => {
  const lines = [];
  const code = await main([], {
    homeDir: 'test-home',
    ensureServerRunning: async () => ({ port: 47821, pid: 456 }),
    verifyServer: () => assert.fail('--verify が無いときは照合しない'),
    write: line => lines.push(line),
  });
  assert.equal(code, 0);
  assert.deepEqual(lines, ['{"port":47821}\n']);
});
