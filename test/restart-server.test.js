const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const path = require('node:path');
const { restartServer, main } = require('../src/client/restart-server');

const commit = 'a'.repeat(40);
const info = { pid: 123, port: 47821, startedAt: '2026-10-14T00:00:00.000Z' };
const started = { ...info, pid: 456, startedAt: '2026-10-15T00:00:00.000Z' };
const running = { version: '1.4.0', commit, sourceState: 'pending' };
const missingProcess = () => Object.assign(new Error('gone'), { code: 'ESRCH' });
const health = body => async () => ({ ok: true, json: async () => body });

function options(overrides = {}) {
  return {
    homeDir: 'test-home', expectedVersion: running.version, readSourceCommit: async () => commit,
    readInfo: async () => info, serverIsHealthy: async () => true,
    fetchImpl: health({ app: 'agent-cockpit', ...started, ...running }),
    kill(pid, signal) { if (signal === 0) throw missingProcess(); },
    sleep: async () => {}, ensureServerRunning: async () => started, ...overrides,
  };
}

test('停止を待ってから起動し、版とコミットと起動情報が一致すれば成功する', async () => {
  const steps = [];
  let probes = 0;
  const result = await restartServer(options({
    kill(pid, signal) {
      assert.equal(pid, info.pid);
      if (signal === 0) { if (++probes > 1) throw missingProcess(); }
      else steps.push('stop');
    },
    sleep: async () => steps.push('wait'),
    ensureServerRunning: async value => { assert.equal(value.homeDir, 'test-home'); steps.push('start'); return started; },
  }));
  assert.deepEqual(result, { result: 'ok', stoppedPid: 123, pid: 456,
    expected: { version: running.version, commit }, running, commitVerified: true });
  assert.deepEqual(steps, ['wait', 'stop', 'wait', 'start']);
});

test('期待の版はディスクの package.json から読みコミットはチェックアウトのルートで取得する', async () => {
  const root = path.resolve(__dirname, '..');
  const version = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
  const result = await restartServer(options({ expectedVersion: undefined,
    readSourceCommit: async value => { assert.equal(value, root); return commit; },
    fetchImpl: health({ app: 'agent-cockpit', ...started, ...running, version }),
  }));
  assert.deepEqual(result.expected, { version, commit });
});

test('期待のコミットを取得できなくても版が一致すれば未照合の成功を返す', async () => {
  const result = await restartServer(options({ readSourceCommit: async () => null }));
  assert.equal(result.result, 'ok');
  assert.equal(result.expected.commit, null);
  assert.equal(result.commitVerified, false);
});

test('起動後の版やコミットが違うか版が無ければ期待値と実際を示して mismatch にする', async () => {
  for (const changes of [{ version: '1.3.0' }, { commit: 'b'.repeat(40) }, { version: undefined }]) {
    await assert.rejects(restartServer(options({
      fetchImpl: health({ app: 'agent-cockpit', ...started, ...running, ...changes }),
    })), error => {
      assert.equal(error.result, 'mismatch');
      assert.match(error.message, /別のチェックアウトから起動した常駐サーバーか、更新前のコード/);
      assert.match(error.message, /期待: 版 1.4.0/);
      assert.match(error.message, /実際: 版/);
      assert.equal(error.details.running.commit, changes.commit ?? commit);
      return true;
    });
  }
});

test('起動後の health が別の pid や起動時刻なら mismatch にする', async () => {
  for (const changes of [{ pid: 999 }, { startedAt: 'other' }]) {
    await assert.rejects(restartServer(options({
      fetchImpl: health({ app: 'agent-cockpit', ...started, ...running, ...changes }),
    })), { result: 'mismatch' });
  }
});

test('最初の health 確認に失敗し同じサーバーが返れば stale にする', async () => {
  await assert.rejects(restartServer(options({
    serverIsHealthy: async () => false,
    kill: () => assert.fail('確認できないプロセスは止めない'),
    ensureServerRunning: async () => ({ ...info }),
  })), { result: 'stale' });
});

test('最初の health が一致しないか動いていなければ停止せず起動する', async () => {
  for (const body of [{ app: 'agent-cockpit', pid: 999, startedAt: info.startedAt },
    { app: 'agent-cockpit', pid: info.pid, startedAt: 'other' }, { app: 'other', ...info }, null]) {
    let calls = 0;
    const result = await restartServer(options({
      serverIsHealthy: undefined,
      fetchImpl: async () => {
        if (++calls > 1) return health({ app: 'agent-cockpit', ...started, ...running })();
        if (!body) throw new Error('not running');
        return health(body)();
      },
      kill: () => assert.fail('別のプロセスは止めない'),
    }));
    assert.equal(result.stoppedPid, null);
    assert.equal(result.result, 'ok');
  }
});

test('起動できないか health を取得できなければ start-failed にする', async () => {
  for (const overrides of [
    { ensureServerRunning: async () => null },
    { ensureServerRunning: async () => { throw new Error('launch failed'); } },
    { fetchImpl: async () => { throw new Error('not running'); } },
    { fetchImpl: async () => ({ ok: true, json: () => new Promise(() => {}) }) },
  ]) await assert.rejects(restartServer(options({ readInfo: async () => null, ...overrides })), { result: 'start-failed' });
});

test('終了を確認できなければ stop-timeout にして次のサーバーを起動しない', async () => {
  let now = 0;
  await assert.rejects(restartServer(options({
    kill() {}, now: () => now, sleep: async () => { now += 15_000; },
    ensureServerRunning: () => assert.fail('起動しない'),
  })), { result: 'stop-timeout' });
});

test('人向けの成功出力は起動情報とコミットの照合結果を示す', async () => {
  for (const expectedCommit of [commit, null]) {
    const lines = [];
    assert.equal(await main([], options({ readSourceCommit: async () => expectedCommit, log: line => lines.push(line) })), 0);
    assert.match(lines.join('\n'), /停止した pid: 123、起動後の pid: 456/);
    assert.match(lines.join('\n'), /版 1.4.0、commit aaaaaaa、sourceState pending/);
    assert.match(lines.join('\n'), expectedCommit ? /版とコミットが一致/ : /commit を照合できませんでした/);
  }
});

test('--json は成功と失敗を一行の JSON だけで返し終了コードを分ける', async () => {
  for (const overrides of [{}, { readSourceCommit: async () => null },
    { fetchImpl: health({ app: 'agent-cockpit', ...started, ...running, version: 'old' }) },
    { ensureServerRunning: async () => null }, { ensureServerRunning: async () => info },
    { kill() {}, now: (() => { let time = 0; return () => time += 15_000; })() }]) {
    const lines = [];
    const code = await main(['--json'], options({ ...overrides,
      log: line => lines.push(line), logError: () => assert.fail('人向けの文を出さない'),
    }));
    assert.equal(lines.length, 1);
    const result = JSON.parse(lines[0]);
    assert.equal(code, result.result === 'ok' ? 0 : 1);
    assert.deepEqual(Object.keys(result), ['result', 'stoppedPid', 'pid', 'expected', 'running', 'commitVerified']);
  }
});

test('Windows を含む実プロセスを既定の process.kill で終了できる', async t => {
  const child = spawn(process.execPath, ['-e', "setInterval(() => {}, 1000); process.send('ready');"], {
    windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await once(child, 'message');
  const exited = once(child, 'exit');
  process.kill(child.pid);
  await exited;
  assert.throws(() => process.kill(child.pid, 0), { code: 'ESRCH' });
});
