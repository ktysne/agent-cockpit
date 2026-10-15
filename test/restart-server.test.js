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
const running = { version: '1.4.0', commit, sourceState: 'release' };
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
    expected: { version: running.version, commit }, running, commitVerified: true, releaseVerified: true });
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
      assert.equal(error.message,
        `再起動した常駐サーバーは、このフォルダーのコードで動いていません(このフォルダー: バージョン 1.4.0、動いているサーバー: バージョン ${Object.hasOwn(changes, 'version') ? changes.version ?? '不明' : running.version})。別のフォルダーの agent-cockpit の常駐サーバーが動いていないか確かめてください。`);
      assert.equal(error.details.running.commit, changes.commit ?? commit);
      return true;
    });
  }
});

test('起動後の health が別の pid や起動時刻なら mismatch にする', async () => {
  for (const changes of [{ pid: 999 }, { startedAt: 'other' }, { app: 'other' }]) {
    await assert.rejects(restartServer(options({
      fetchImpl: health({ app: 'agent-cockpit', ...started, ...running, ...changes }),
    })), error => {
      assert.equal(error.result, 'mismatch');
      assert.equal(error.message,
        '再起動した常駐サーバーは、このフォルダーのコードで動いていません(このフォルダー: バージョン 1.4.0、動いているサーバー: バージョン 1.4.0)。別のフォルダーの agent-cockpit の常駐サーバーが動いていないか確かめてください。');
      return true;
    });
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

test('人向けの成功出力はバージョンを示し、コミットを照合できなければその旨を添える', async () => {
  for (const expectedCommit of [commit, null]) {
    const lines = [];
    assert.equal(await main([], options({ readSourceCommit: async () => expectedCommit, log: line => lines.push(line) })), 0);
    assert.deepEqual(lines, [expectedCommit
      ? '常駐サーバーを再起動しました(バージョン 1.4.0)。'
      : '常駐サーバーを再起動しました(バージョン 1.4.0)。このフォルダーのコミットを読めなかったため、更新後のコードで動いているかは確かめられませんでした。']);
  }
});

test('人向けの mismatch 出力は指定文を使い、ほかの失敗出力は維持する', async () => {
  for (const scenario of [
    {
      overrides: { fetchImpl: health({ app: 'agent-cockpit', ...started, ...running, commit: 'b'.repeat(40) }) },
      expected: '再起動した常駐サーバーは、このフォルダーのコードで動いていません(このフォルダー: バージョン 1.4.0、動いているサーバー: バージョン 1.4.0)。別のフォルダーの agent-cockpit の常駐サーバーが動いていないか確かめてください。',
    },
    {
      overrides: { ensureServerRunning: async () => null },
      expected: '常駐サーバーの再起動に失敗しました: 常駐サーバーを起動できませんでした。',
    },
  ]) {
    const lines = [];
    const code = await main([], options({ ...scenario.overrides, logError: line => lines.push(line) }));
    assert.equal(code, 1);
    assert.deepEqual(lines, [scenario.expected]);
  }
});

test('--json は成功と失敗を一行の JSON だけで返し終了コードを分ける', async () => {
  for (const overrides of [{}, { readSourceCommit: async () => null },
    { fetchImpl: health({ app: 'agent-cockpit', ...started, ...running, version: 'old' }) },
    { ensureServerRunning: async () => null }, { ensureServerRunning: async () => info },
    { readSourceCommit: async () => { throw new Error('expected unavailable'); } },
    { kill() {}, now: (() => { let time = 0; return () => time += 15_000; })() }]) {
    const lines = [];
    const code = await main(['--json'], options({ ...overrides,
      log: line => lines.push(line), logError: () => assert.fail('人向けの文を出さない'),
    }));
    assert.equal(lines.length, 1);
    const result = JSON.parse(lines[0]);
    assert.equal(code, result.result === 'ok' ? 0 : 1);
    assert.deepEqual(Object.keys(result), ['result', 'stoppedPid', 'pid', 'expected', 'running', 'commitVerified', 'releaseVerified']);
    if (result.result !== 'ok') assert.equal(result.releaseVerified, false);
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
