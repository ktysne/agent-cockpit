const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { cockpitHomeFromOptions } = require('../server/identity');
const { readServerInfo, serverIsHealthy, ensureServerRunning } = require('./server-connection');
const { readExpected, verifyServer } = require('./server-verification');

const STORE_SETTLE_MS = 1000;

async function restartServer(options = {}) {
  const root = path.resolve(__dirname, '../..');
  const expected = await readExpected(root, options);
  const result = { result: 'ok', stoppedPid: null, pid: null, expected, running: null, commitVerified: false };
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
  const verification = await verifyServer(started, { expected, fetchImpl: options.fetchImpl, now });
  if (verification.result === 'start-failed') fail('start-failed', '起動後の常駐サーバーの health を期限内に取得できませんでした。');
  result.running = verification.running;
  if (verification.result === 'mismatch' && !verification.identityMatches) {
    fail('mismatch', '起動後の health の pid または startedAt、アプリ名が起動情報と一致しません。' + mismatchMessage(expected, result.running));
  }
  if (verification.result === 'mismatch') fail('mismatch', mismatchMessage(expected, result.running));
  result.commitVerified = verification.commitVerified;
  return result;
}

function mismatchMessage(expected, running) {
  return `別のチェックアウトから起動した常駐サーバーか、更新前のコードで動いている可能性があります。期待: 版 ${expected.version}、commit ${expected.commit ?? '不明'}。実際: 版 ${running.version ?? '不明'}、commit ${running.commit ?? '不明'}。`;
}

async function main(argv = process.argv.slice(2), options = {}) {
  const log = options.log || console.log;
  const logError = options.logError || console.error;
  const json = argv.includes('--json');
  try {
    const result = await restartServer(options);
    if (json) log(JSON.stringify(result));
    else {
      log(`停止した pid: ${result.stoppedPid ?? 'なし'}、起動後の pid: ${result.pid}`);
      log(`起動した常駐サーバー: 版 ${result.running.version}、commit ${result.running.commit?.slice(0, 7) ?? '不明'}、sourceState ${result.running.sourceState ?? '不明'}`);
      log(result.commitVerified ? '版とコミットが一致しました。' : '版は一致しましたが、commit を照合できませんでした。');
    }
    return 0;
  } catch (error) {
    if (json) log(JSON.stringify(error.details || {
      result: 'start-failed', stoppedPid: null, pid: null,
      expected: { version: null, commit: null }, running: null, commitVerified: false,
    }));
    else logError(`常駐サーバーの再起動に失敗しました: ${error.message}`);
    return 1;
  }
}

if (require.main === module) {
  main().then(code => { process.exitCode = code; });
}

module.exports = { restartServer, main };
