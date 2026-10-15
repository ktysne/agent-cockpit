const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { cockpitHomeFromOptions } = require('../server/identity');
const { readServerInfo, serverIsHealthy, ensureServerRunning } = require('./server-connection');
const { readExpected, verifyServer } = require('./server-verification');

const STORE_SETTLE_MS = 1000;

async function restartServer(options = {}) {
  const root = path.resolve(__dirname, '../..');
  const expected = await readExpected(root, options);
  const result = { result: 'ok', stoppedPid: null, pid: null, expected, running: null,
    commitVerified: false, releaseVerified: false };
  const fail = (classification, message) => {
    throw Object.assign(new Error(message), { result: classification, details: { ...result, result: classification } });
  };
  const homeDir = options.homeDir || cockpitHomeFromOptions(options);
  const readInfo = options.readInfo || readServerInfo;
  const healthy = options.serverIsHealthy || serverIsHealthy;
  const ensure = options.ensureServerRunning || ensureServerRunning;
  const kill = options.kill || process.kill;
  const now = options.now || Date.now;
  const wait = options.sleep || sleep;
  // 強制終了になるので、直前の書き込みが 500ms のまとめ書き(state.js)で保存されるまで待つ。
  // 照合から停止までの間を空けないよう、待つのは照合の前にする。
  await wait(STORE_SETTLE_MS);
  const info = await readInfo(homeDir);
  if ((options.expectPid !== undefined && info?.pid !== options.expectPid) ||
      (options.expectStartedAt !== undefined && info?.startedAt !== options.expectStartedAt)) {
    fail('stale', '依頼元と異なる起動の常駐サーバーなので、停止しませんでした。');
  }
  let stoppedPid = null;
  if (info && Number.isInteger(info.pid) && info.pid > 0 &&
      await healthy(info, { fetchImpl: options.fetchImpl, now, deadline: now() + 1000 })) {
    try {
      kill(info.pid);
      stoppedPid = info.pid;
      result.stoppedPid = stoppedPid;
    } catch (error) {
      if (error.code !== 'ESRCH') fail('stop-timeout', `旧サーバーを停止できず、終了を確認できませんでした: ${error.message}`);
    }
    const deadline = now() + 15_000;
    while (true) {
      try { kill(info.pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') break;
        fail('stop-timeout', `旧サーバーの終了を確認できませんでした: ${error.message}`);
      }
      if (now() >= deadline) fail('stop-timeout', '旧サーバーの終了を確認できませんでした。');
      await wait(50);
    }
  }
  let started;
  try {
    started = await ensure({ homeDir, fetchImpl: options.fetchImpl, now, deadline: now() + 15_000 });
  } catch {
    fail('start-failed', '常駐サーバーを起動できませんでした。');
  }
  if (!started) fail('start-failed', '常駐サーバーを起動できませんでした。');
  result.pid = started.pid;
  if (info && started.pid === info.pid && started.startedAt === info.startedAt) {
    fail('stale', '元と同じ起動の常駐サーバーが返されたため、再起動していません。もう一度実行してください。');
  }
  const verification = await verifyServer(started, {
    expected, fetchImpl: options.fetchImpl, now, sleep: wait, settleSourceState: true,
  });
  if (verification.result === 'start-failed') fail('start-failed', '起動後の常駐サーバーの health を期限内に取得できませんでした。');
  result.running = verification.running;
  result.releaseVerified = verification.releaseVerified;
  if (verification.result === 'mismatch' && !verification.identityMatches) {
    fail('mismatch', mismatchMessage(expected, result.running));
  }
  if (verification.result === 'mismatch') fail('mismatch', mismatchMessage(expected, result.running));
  result.commitVerified = verification.commitVerified;
  return result;
}

function mismatchMessage(expected, running) {
  return `再起動した常駐サーバーは、このフォルダーのコードで動いていません(このフォルダー: バージョン ${expected.version}、動いているサーバー: バージョン ${running.version ?? '不明'})。別のフォルダーの agent-cockpit の常駐サーバーが動いていないか確かめてください。`;
}

async function main(argv = process.argv.slice(2), options = {}) {
  const log = options.log || console.log;
  const logError = options.logError || console.error;
  const json = argv.includes('--json');
  try {
    const value = flag => argv.includes(flag) ? argv[argv.indexOf(flag) + 1] ?? '' : undefined;
    const pid = value('--expect-pid');
    const startedAt = value('--expect-started-at');
    const result = await restartServer({ ...options,
      ...(pid !== undefined ? { expectPid: Number(pid) } : {}),
      ...(startedAt !== undefined ? { expectStartedAt: startedAt } : {}),
    });
    if (json) log(JSON.stringify(result));
    else {
      log(result.commitVerified
        ? `常駐サーバーを再起動しました(バージョン ${result.running.version})。`
        : `常駐サーバーを再起動しました(バージョン ${result.running.version})。このフォルダーのコミットを読めなかったため、更新後のコードで動いているかは確かめられませんでした。`);
    }
    return 0;
  } catch (error) {
    if (json) log(JSON.stringify(error.details || {
      result: 'start-failed', stoppedPid: null, pid: null,
      expected: { version: null, commit: null }, running: null, commitVerified: false, releaseVerified: false,
    }));
    else logError(error.result === 'mismatch'
      ? error.message
      : `常駐サーバーの再起動に失敗しました: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}

module.exports = { restartServer, main };
