const { setTimeout: sleep } = require('node:timers/promises');
const { cockpitHomeFromOptions } = require('../server/identity');
const { readServerInfo, serverIsHealthy, ensureServerRunning } = require('./server-connection');

const STORE_SETTLE_MS = 1000;

async function restartServer(options = {}) {
  const homeDir = options.homeDir || cockpitHomeFromOptions(options);
  const readInfo = options.readInfo || readServerInfo;
  const healthy = options.serverIsHealthy || serverIsHealthy;
  const ensure = options.ensureServerRunning || ensureServerRunning;
  const kill = options.kill || process.kill;
  const now = options.now || Date.now;
  const wait = options.sleep || sleep;
  const info = await readInfo(homeDir);
  let stoppedPid = null;
  if (info && Number.isInteger(info.pid) && info.pid > 0 &&
      await healthy(info, { fetchImpl: options.fetchImpl, now, deadline: now() + 1000 })) {
    // 強制終了になるので、直前の書き込みが 500ms のまとめ書き(state.js)で保存されるまで待つ。
    await wait(STORE_SETTLE_MS);
    try {
      kill(info.pid);
      stoppedPid = info.pid;
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
    const deadline = now() + 15_000;
    while (true) {
      try { kill(info.pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') break;
        throw error;
      }
      if (now() >= deadline) throw new Error('常駐サーバーの終了を確認できませんでした。');
      await wait(50);
    }
  }
  const started = await ensure({ homeDir, fetchImpl: options.fetchImpl, now, deadline: now() + 15_000 });
  if (!started) throw new Error('常駐サーバーを起動できませんでした。');
  if (stoppedPid === null && info && started.pid === info.pid && started.startedAt === info.startedAt) {
    throw new Error('動いている常駐サーバーを確認できなかったため、再起動していません。もう一度実行してください。');
  }
  return { stoppedPid, pid: started.pid };
}

if (require.main === module) {
  restartServer().then(({ stoppedPid, pid }) => {
    console.log(`停止した pid: ${stoppedPid ?? 'なし'}、起動後の pid: ${pid}`);
  }).catch((error) => {
    console.error(`常駐サーバーの再起動に失敗しました: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { restartServer };
