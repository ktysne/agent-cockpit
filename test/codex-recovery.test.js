const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runHook } = require('../src/hooks/event');
const { startServer: startRealServer } = require('../src/server/server');
const startServer = options => startRealServer({ readSourceCommit: async () => null, readSourceState: () => 'unknown', ...options });
const { hookHeaders, jsonBody, request } = require('./support/server');
const { temporaryHome } = require('./support/temp');

async function cockpit(t, { claudeFilesReadable = true } = {}) {
  const temporary = temporaryHome(t, 'cockpit-codex-recovery-', { deferCleanup: true });
  const codexHome = path.join(temporary.homeDir, '.codex');
  if (claudeFilesReadable) await fs.mkdir(path.join(temporary.claudeHome, 'sessions'), { recursive: true });
  let alive = true;
  let now = Date.now();
  let runtime;
  const start = async () => {
    runtime = await startServer({ ...temporary, codexHome, port: 0, isAlive: pid => alive && (pid === 1234 || pid === 5678) });
  };
  t.after(async () => { await runtime?.close(); await temporary.cleanup(); });
  await start();
  return {
    ...temporary,
    codexHome,
    async lock(id = 'thread') {
      const directory = path.join(codexHome, 'thread-writer-locks');
      await fs.mkdir(directory, { recursive: true });
      await fs.writeFile(path.join(directory, `${id}.lock`), '');
    },
    async unlock(id = 'thread') {
      await fs.unlink(path.join(codexHome, 'thread-writer-locks', `${id}.lock`));
    },
    get runtime() { return runtime; },
    setAlive(value) { alive = value; },
    async restart() { await runtime.close(); await start(); },
    async event(name, fields = {}, id = 'thread') {
      const response = await request(runtime.info.port, {
        method: 'POST', path: '/api/events', headers: hookHeaders(runtime.info.secret),
        body: JSON.stringify({ session_id: id, provider: 'codex', cwd: temporary.homeDir,
          hook_event_name: name, hookAt: now++, ...fields }),
      });
      assert.equal(response.status, 202);
    },
    async rows() { return jsonBody(await request(runtime.info.port, { path: '/api/state' })).sessions; },
    async store() {
      await runtime.state.flushPersistence();
      try {
        return JSON.parse(await fs.readFile(path.join(temporary.homeDir, 'store.json'), 'utf8'));
      } catch (error) {
        if (error.code === 'ENOENT') return { codexRecovery: {} };
        throw error;
      }
    },
  };
}

test('Codex の SessionStart は見つかった親の PID だけを送る', async (t) => {
  const c = await cockpit(t);
  for (const [id, findCodexParentPid] of [
    ['found', async () => 1234], ['missing', async () => null],
    ['failed', async () => { throw new Error('query failed'); }],
    ['timeout', () => new Promise(() => {})],
  ]) {
    await runHook({ session_id: id, hook_event_name: 'SessionStart', cwd: c.homeDir },
      { provider: 'codex', homeDir: c.homeDir, findCodexParentPid, codexParentTimeoutMs: 50 });
  }
  assert.deepEqual(Object.keys((await c.store()).codexRecovery), ['found']);
});

test('Claude と Codex の開始以外のフックは親を問い合わせない', async (t) => {
  const c = await cockpit(t);
  let queries = 0;
  for (const [provider, name] of [['claude', 'SessionStart'], ['codex', 'UserPromptSubmit']]) {
    await runHook({ session_id: provider, hook_event_name: name, cwd: c.homeDir }, {
      provider, homeDir: c.homeDir, findCodexParentPid: async () => { queries += 1; return 1234; },
    });
  }
  assert.equal(queries, 0);
});

test('session_index.jsonl の最新のスレッド名を Codex 行の title に表示する', async (t) => {
  const c = await cockpit(t);
  await fs.mkdir(c.codexHome, { recursive: true });
  await fs.writeFile(path.join(c.codexHome, 'session_index.jsonl'), [
    JSON.stringify({ id: 'thread', thread_name: '古い名前', updated_at: '2026-10-13T10:00:00Z' }),
    JSON.stringify({ id: 'thread', thread_name: 'Issue 713 以降と PR 765 を確認', updated_at: '2026-10-13T10:19:19.669Z' }),
  ].join('\n'));
  await c.event('SessionStart', { codexPid: 1234 });
  await c.runtime.refreshSessionFiles();
  assert.equal((await c.rows())[0].title, 'Issue 713 以降と PR 765 を確認');
});

test('session_index.jsonl に同じ ID の行が追記されると次の更新で title が変わる', async (t) => {
  const c = await cockpit(t);
  await fs.mkdir(c.codexHome, { recursive: true });
  const indexPath = path.join(c.codexHome, 'session_index.jsonl');
  await fs.writeFile(indexPath, `${JSON.stringify({ id: 'thread', thread_name: '最初の名前', updated_at: '2026-10-13T10:00:00Z' })}\n`);
  await c.event('SessionStart', { codexPid: 1234 });
  await c.runtime.refreshSessionFiles();
  assert.equal((await c.rows())[0].title, '最初の名前');

  await fs.appendFile(indexPath, `${JSON.stringify({ id: 'thread', thread_name: '更新後の名前', updated_at: '2026-10-13T10:20:00Z' })}\n`);
  await c.runtime.refreshSessionFiles();
  assert.equal((await c.rows())[0].title, '更新後の名前');
});

test('session_index.jsonl が無い Codex 行の title は null のまま', async (t) => {
  const c = await cockpit(t);
  await c.event('SessionStart', { codexPid: 1234 });
  await c.runtime.refreshSessionFiles();
  assert.equal((await c.rows())[0].title, null);
});

test('壊れた行だけの session_index.jsonl では Codex 行の title は null のまま', async (t) => {
  const c = await cockpit(t);
  await fs.mkdir(c.codexHome, { recursive: true });
  await fs.writeFile(path.join(c.codexHome, 'session_index.jsonl'), '{broken json}\n{"id":4,"thread_name":"無効"}\n');
  await c.event('SessionStart', { codexPid: 1234 });
  await c.runtime.refreshSessionFiles();
  assert.equal((await c.rows())[0].title, null);
});

for (const claudeFilesReadable of [true, false]) {
  test(`再起動後は生きている Codex のモデルと再開回数を不明の行に戻す（Claude の一覧${claudeFilesReadable ? 'あり' : 'なし'}）`, async (t) => {
    const c = await cockpit(t, { claudeFilesReadable });
    await c.event('SessionStart', { codexPid: 1234, model: 'gpt-6', source: 'resume' });
    await c.event('SessionStart', { source: 'resume' });
    const product = (await c.rows())[0].product;
    await c.restart();
    const [row] = await c.rows();
    assert.equal(row.provider, 'codex');
    assert.equal(row.status, '不明');
    assert.deepEqual(row.codex, { model: 'gpt-6', resumes: 2 });
    assert.deepEqual(row.product, product);
  });
}

test('再起動後のイベントは保存したモデルを使い再開を重複せずに足す', async (t) => {
  const c = await cockpit(t);
  await c.event('SessionStart', { codexPid: 1234, model: 'gpt-6', source: 'resume' });
  await c.restart();
  await c.event('UserPromptSubmit');
  assert.deepEqual((await c.rows())[0].codex, { model: 'gpt-6', resumes: 1 });
  await c.event('SessionStart', { source: 'resume' });
  await c.event('Stop', { model: 'gpt-6-sol' });
  assert.deepEqual((await c.rows())[0].codex, { model: 'gpt-6-sol', resumes: 2 });
  await c.restart();
  assert.deepEqual((await c.rows())[0].codex, { model: 'gpt-6-sol', resumes: 2 });
});

test('再起動後にモデル名の無いイベントが先に届いても、時刻の順で最後に明示されたモデル名を出す', async (t) => {
  const c = await cockpit(t);
  const at = Date.now() + 10_000;
  await c.event('SessionStart', { codexPid: 1234, model: 'gpt-6', hookAt: at });
  await c.restart();
  await c.event('Stop', { hookAt: at + 2 });
  await c.event('UserPromptSubmit', { model: 'gpt-6-sol', hookAt: at + 1 });
  assert.equal((await c.rows())[0].codex.model, 'gpt-6-sol');
});

test('最後に記録した時刻は 1 分以上進んだイベントで保存し、再起動後の行に出す', async (t) => {
  const c = await cockpit(t);
  const at = Date.now() - 120_000;
  await c.event('SessionStart', { codexPid: 1234, hookAt: at });
  await c.event('Stop', { hookAt: at + 30_000 });
  assert.equal((await c.store()).codexRecovery.thread.updatedAt, new Date(at).toISOString());
  await c.event('Stop', { hookAt: at + 90_000 });
  assert.equal((await c.store()).codexRecovery.thread.updatedAt, new Date(at + 90_000).toISOString());
  await c.restart();
  assert.equal((await c.rows())[0].sessionFileUpdatedAt, new Date(at + 90_000).toISOString());
});

test('終了したプロセスの Codex は再起動で戻さず保存からも捨てる', async (t) => {
  const c = await cockpit(t);
  await c.event('SessionStart', { codexPid: 1234 });
  c.setAlive(false);
  await c.restart();
  assert.deepEqual(await c.rows(), []);
  assert.deepEqual((await c.store()).codexRecovery, {});
});

for (const claudeFilesReadable of [true, false]) {
  test(`稼働中の Codex はプロセスの不在から60秒後に終了扱いになる（Claude の一覧${claudeFilesReadable ? 'あり' : 'なし'}）`, async (t) => {
    const c = await cockpit(t, { claudeFilesReadable });
    await c.event('SessionStart', { codexPid: 1234 });
    const now = Date.now();
    await c.runtime.refreshSessionFiles(now);
    c.setAlive(false);
    await c.runtime.refreshSessionFiles(now + 10_000);
    assert.equal((await c.rows())[0].session_id, 'thread');
    assert.deepEqual((await c.store()).codexRecovery, {});
    await c.runtime.refreshSessionFiles(now + 60_000);
    assert.deepEqual(await c.rows(), []);
    assert.equal(c.runtime.state.sessionHasEnded('thread'), true);
  });
}

test('ロックを見た Codex はイベントの後も印を保ち、ロック消失で一覧から外れて60秒後に終了し、記録は残る', async (t) => {
  const c = await cockpit(t);
  await c.lock();
  await c.event('SessionStart', { codexPid: 1234 });
  const now = Date.now();
  await c.runtime.refreshSessionFiles(now);
  await c.event('Stop');
  assert.equal((await c.store()).codexRecovery.thread.lockSeen, true);
  await c.unlock();
  await c.runtime.refreshSessionFiles(now + 10_000);
  assert.equal(c.runtime.state.sessionFiles.has('thread'), false);
  assert.equal((await c.store()).codexRecovery.thread.lockSeen, true);
  assert.equal((await c.rows())[0].session_id, 'thread');
  await c.runtime.refreshSessionFiles(now + 60_000);
  assert.deepEqual(await c.rows(), []);
  assert.equal(c.runtime.state.sessionHasEnded('thread'), true);
});

test('ロックを一度も見ていない Codex は空のロック一覧でも PID が生きていれば残る', async (t) => {
  const c = await cockpit(t);
  await fs.mkdir(path.join(c.codexHome, 'thread-writer-locks'), { recursive: true });
  await c.event('SessionStart', { codexPid: 1234 });
  await c.runtime.refreshSessionFiles(Date.now() + 120_000);
  assert.equal((await c.rows())[0].session_id, 'thread');
  assert.equal((await c.store()).codexRecovery.thread.lockSeen, undefined);
});

for (const unreadable of ['missing', 'file']) {
  test(`ロック一覧を読めないときは印があっても PID の生死だけで扱う（${unreadable}）`, async (t) => {
    const c = await cockpit(t);
    await c.lock();
    await c.event('SessionStart', { codexPid: 1234 });
    const now = Date.now();
    await c.runtime.refreshSessionFiles(now);
    const directory = path.join(c.codexHome, 'thread-writer-locks');
    await c.unlock();
    await fs.rmdir(directory);
    if (unreadable === 'file') await fs.writeFile(directory, '');
    await c.runtime.refreshSessionFiles(now + 120_000);
    assert.equal((await c.rows())[0].session_id, 'thread');
    assert.equal((await c.store()).codexRecovery.thread.lockSeen, true);
    c.setAlive(false);
    await c.runtime.refreshSessionFiles(now + 180_000);
    assert.deepEqual(await c.rows(), []);
    assert.deepEqual((await c.store()).codexRecovery, {});
  });
}

test('保存したロックの印は再起動後も残り、ロック消失後の再起動では行を戻さない(記録は残す)', async (t) => {
  const c = await cockpit(t);
  await c.lock();
  await c.event('SessionStart', { codexPid: 1234 });
  await c.runtime.refreshSessionFiles();
  await c.restart();
  assert.equal((await c.store()).codexRecovery.thread.lockSeen, true);
  assert.equal((await c.rows())[0].session_id, 'thread');
  await c.unlock();
  await c.restart();
  assert.deepEqual(await c.rows(), []);
  assert.equal((await c.store()).codexRecovery.thread.lockSeen, true);
});

test('ロック消失で終了した Codex を再開すると、SessionStart が無くても行が戻り、終了扱いに戻らない', async (t) => {
  const c = await cockpit(t);
  await c.lock();
  await c.event('SessionStart', { codexPid: 1234 });
  const now = Date.now();
  await c.runtime.refreshSessionFiles(now);
  await c.unlock();
  await c.runtime.refreshSessionFiles(now + 60_000);
  assert.deepEqual(await c.rows(), []);
  await c.lock();
  await c.event('UserPromptSubmit', { hookAt: now + 60_001 });
  await c.runtime.refreshSessionFiles(now + 60_002);
  await c.runtime.refreshSessionFiles(now + 180_000);
  assert.equal((await c.rows())[0].session_id, 'thread');
  assert.equal(c.runtime.state.sessionHasEnded('thread'), false);
  assert.equal((await c.store()).codexRecovery.thread.pid, 1234);
});

for (const [label, resumed] of [['別のプロセス', { codexPid: 5678 }], ['プロセス ID の届かない', {}]]) {
  test(`ロックを見た会話を${label}再開で始めると、ロックが無くてもプロセスの生死だけで扱う`, async (t) => {
    const c = await cockpit(t);
    await c.lock();
    await c.event('SessionStart', { codexPid: 1234 });
    const now = Date.now();
    await c.runtime.refreshSessionFiles(now);
    await c.unlock();
    await c.event('SessionStart', { ...resumed, hookAt: now + 1 });
    assert.equal((await c.store()).codexRecovery.thread.lockSeen, undefined);
    await c.runtime.refreshSessionFiles(now + 180_000);
    assert.equal((await c.rows())[0].session_id, 'thread');
    assert.equal(c.runtime.state.sessionHasEnded('thread'), false);
  });
}

test('ロック一覧は隠しファイル、別の拡張子、ディレクトリを会話のロックに含めない', async (t) => {
  const c = await cockpit(t);
  const directory = path.join(c.codexHome, 'thread-writer-locks');
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, '.hidden.lock'), '');
  await fs.writeFile(path.join(directory, 'other.txt'), '');
  await fs.mkdir(path.join(directory, 'folder.lock'));
  for (const id of ['.hidden', 'other', 'folder']) await c.event('SessionStart', { codexPid: 1234 }, id);
  await c.runtime.refreshSessionFiles();
  for (const record of Object.values((await c.store()).codexRecovery)) assert.equal(record.lockSeen, undefined);
});

test('Claude の一覧を読めない間は終了判定と生存確認の時刻を進めない', async (t) => {
  const c = await cockpit(t);
  const directory = path.join(c.claudeHome, 'sessions');
  await fs.writeFile(path.join(directory, 'claude.json'), JSON.stringify({ sessionId: 'claude', pid: 1234 }));
  await c.event('SessionStart', { provider: 'claude' }, 'claude');
  const now = Date.now();
  await c.runtime.refreshSessionFiles(now);
  await fs.rename(directory, `${directory}-unreadable`);
  await c.runtime.refreshSessionFiles(now + 60_000);
  assert.equal((await c.rows())[0].session_id, 'claude');
  await fs.mkdir(directory);
  await c.runtime.refreshSessionFiles(now + 61_000);
  assert.deepEqual(await c.rows(), []);
});

test('PID の無い Codex はプロセスの一覧から終了扱いにしない', async (t) => {
  const c = await cockpit(t);
  await c.event('SessionStart');
  c.setAlive(false);
  await c.runtime.refreshSessionFiles(Date.now() + 120_000);
  assert.equal((await c.rows())[0].session_id, 'thread');
});

test('SessionEnd は保存を捨て同じ thread の再開回数は稼働中に引き継ぐ', async (t) => {
  const c = await cockpit(t);
  await c.event('SessionStart', { codexPid: 1234, source: 'resume' });
  await c.restart();
  await c.event('SessionStart', { source: 'resume' });
  await c.event('SessionEnd');
  assert.deepEqual((await c.store()).codexRecovery, {});
  await c.event('SessionStart', { codexPid: 1234, source: 'resume' });
  assert.equal((await c.rows())[0].codex.resumes, 3);
});

test('保存の上限を超えた Codex は最後の更新が古いものから捨てる', async (t) => {
  const c = await cockpit(t);
  for (let index = 0; index < 200; index += 1) {
    await c.event('SessionStart', { codexPid: 1234 }, `thread-${index}`);
  }
  const later = Date.now() + 120_000;
  await c.event('Stop', { hookAt: later }, 'thread-0');
  await c.event('SessionStart', { codexPid: 1234, hookAt: later + 1 }, 'thread-200');
  const saved = (await c.store()).codexRecovery;
  assert.equal(Object.keys(saved).length, 200);
  assert.ok(saved['thread-0']);
  assert.equal(saved['thread-1'], undefined);
});

test('壊れた Codex の保存項目だけを捨ててほかの行を戻す', async (t) => {
  const c = await cockpit(t);
  await c.event('SessionStart', { codexPid: 1234, model: 'gpt-6' });
  const saved = await c.store();
  await c.runtime.close();
  saved.codexRecovery.broken = { ...saved.codexRecovery.thread, pid: '1234' };
  await fs.writeFile(path.join(c.homeDir, 'store.json'), JSON.stringify(saved));
  await c.restart();
  assert.deepEqual((await c.rows()).map(row => row.session_id), ['thread']);
  assert.equal((await c.store()).codexRecovery.broken, undefined);
});

test('HTTP は Codex の開始にある正の整数の PID だけを保存する', async (t) => {
  const c = await cockpit(t);
  for (const [id, name, fields] of [
    ['claude', 'SessionStart', { provider: 'claude', codexPid: 1234 }],
    ['later', 'UserPromptSubmit', { codexPid: 1234 }],
    ['string', 'SessionStart', { codexPid: '1234' }],
    ['negative', 'SessionStart', { codexPid: -1 }],
    ['fraction', 'SessionStart', { codexPid: 1.5 }],
  ]) await c.event(name, fields, id);
  assert.deepEqual((await c.store()).codexRecovery, {});
});
