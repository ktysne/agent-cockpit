const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { restartServer } = require('../src/client/restart-server');

const info = { pid: 123, port: 47821, startedAt: '2026-10-14T00:00:00.000Z' };
const missingProcess = () => Object.assign(new Error('gone'), { code: 'ESRCH' });
const health = body => async () => ({ ok: true, json: async () => body });

test('health の pid と起動時刻が一致すれば停止を待ってから起動する', async () => {
  const steps = [];
  let probes = 0;
  const result = await restartServer({ homeDir: 'test-home', readInfo: async () => info,
    fetchImpl: health({ app: 'agent-cockpit', pid: info.pid, startedAt: info.startedAt }),
    kill(pid, signal) {
      assert.equal(pid, info.pid);
      if (signal === 0) { if (++probes > 1) throw missingProcess(); }
      else steps.push('stop');
    },
    sleep: async () => steps.push('wait'),
    ensureServerRunning: async options => { assert.equal(options.homeDir, 'test-home'); steps.push('start'); return { pid: 456 }; },
  });
  assert.deepEqual(result, { stoppedPid: 123, pid: 456 });
  assert.deepEqual(steps, ['stop', 'wait', 'start']);
});

test('health が一致しないか動いていなければ停止せずに起動だけ行う', async () => {
  for (const body of [{ app: 'agent-cockpit', pid: 999, startedAt: info.startedAt },
    { app: 'agent-cockpit', pid: info.pid, startedAt: 'other' }, { app: 'other', ...info }, null]) {
    let starts = 0;
    const result = await restartServer({ homeDir: 'test-home', readInfo: async () => info,
      fetchImpl: body ? health(body) : async () => { throw new Error('not running'); },
      kill: () => assert.fail('別のプロセスは止めない'),
      ensureServerRunning: async () => { starts += 1; return { pid: 456 }; },
    });
    assert.deepEqual(result, { stoppedPid: null, pid: 456 });
    assert.equal(starts, 1);
  }
});

test('server.json が無ければ停止せず起動し、起動失敗を呼び出し側へ返す', async () => {
  await assert.rejects(restartServer({ homeDir: 'test-home', readInfo: async () => null,
    kill: () => assert.fail('停止しない'), ensureServerRunning: async () => null }), /起動できません/);
});

test('終了を確認できなければ期限で失敗し、次のサーバーを起動しない', async () => {
  let now = 0;
  await assert.rejects(restartServer({ homeDir: 'test-home', readInfo: async () => info,
    serverIsHealthy: async () => true, kill() {}, now: () => now,
    sleep: async () => { now += 15_000; }, ensureServerRunning: () => assert.fail('起動しない'),
  }), /終了を確認できません/);
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
