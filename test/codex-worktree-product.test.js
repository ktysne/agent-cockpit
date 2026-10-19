const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startServer } = require('../src/server/server');
const { DashboardState } = require('../src/server/state');
const { hookHeaders, jsonBody, request } = require('./support/server');
const { temporaryHome } = require('./support/temp');

async function cockpit(testContext, { seed, pullRequestOptions } = {}) {
  const temporary = temporaryHome(testContext, 'agent-cockpit-codex-worktree-', { deferCleanup: true });
  const codexHome = path.join(temporary.homeDir, '.codex');
  const serverCodexHome = process.platform === 'win32' ? codexHome.toLowerCase() : codexHome;
  let runtime;
  try {
    if (seed) await seed({ homeDir: temporary.homeDir, codexHome });
    runtime = await startServer({
      ...temporary,
      codexHome: serverCodexHome,
      pullRequestOptions,
      port: 0,
      readSourceCommit: async () => null,
      readSourceState: () => 'unknown',
    });
  } catch (error) {
    await temporary.cleanup();
    throw error;
  }
  testContext.after(async () => {
    try {
      await runtime.close();
    } finally {
      await temporary.cleanup();
    }
  });
  return { ...temporary, codexHome, runtime };
}

async function createWorktree(worktreeRoot, gitDirectory) {
  await fs.mkdir(worktreeRoot, { recursive: true });
  await fs.mkdir(gitDirectory, { recursive: true });
  await fs.writeFile(path.join(worktreeRoot, '.git'), `gitdir: ${path.relative(worktreeRoot, gitDirectory)}\n`);
}

async function sendEvent(cockpitInstance, sessionId, cwd) {
  const response = await request(cockpitInstance.runtime.info.port, {
    method: 'POST',
    path: '/api/events',
    headers: hookHeaders(cockpitInstance.runtime.info.secret),
    body: JSON.stringify({ session_id: sessionId, provider: 'codex', hook_event_name: 'SessionStart', cwd }),
  });
  assert.equal(response.status, 202);
  const snapshot = jsonBody(await request(cockpitInstance.runtime.info.port, { path: '/api/state' }));
  return snapshot.sessions.find(session => session.session_id === sessionId);
}

function productKey(directory) {
  const absolute = path.resolve(directory);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

test('Codex worktree のプロダクトをイベント受付から判定する', async (t) => {
  const c = await cockpit(t);
  const repositoryRoot = path.join(c.homeDir, 'source-repository');
  const gitDirectory = path.join(repositoryRoot, '.git', 'worktrees', 'linked-checkout');

  await t.test('Codex ホーム内では元のリポジトリを鍵と表示名に使う', async () => {
    const worktreeRoot = path.join(c.codexHome, 'worktrees', 'worktree-id', 'source-repository');
    await createWorktree(worktreeRoot, gitDirectory);
    const row = await sendEvent(c, 'codex-worktree', worktreeRoot);

    assert.equal(row.product.key, productKey(repositoryRoot));
    assert.equal(row.product.name, path.basename(repositoryRoot));
    await fs.rm(worktreeRoot, { recursive: true });
    const afterRemoval = await sendEvent(c, 'codex-worktree-removed', worktreeRoot);
    assert.equal(afterRemoval.product.key, productKey(repositoryRoot));
    assert.equal(afterRemoval.product.name, path.basename(repositoryRoot));
  });

  await t.test('Codex ホーム外のリンクした worktree は畳まない', async () => {
    const worktreeRoot = path.join(c.homeDir, 'manual-worktree', 'linked-checkout');
    await createWorktree(worktreeRoot, path.join(repositoryRoot, '.git', 'worktrees', 'manual-checkout'));
    const row = await sendEvent(c, 'manual-worktree', worktreeRoot);

    assert.equal(row.product.key, productKey(worktreeRoot));
    assert.equal(row.product.name, path.basename(worktreeRoot));
  });

  await t.test('Codex ホーム内でも異なる gitdir の形は畳まない', async () => {
    const worktreeRoot = path.join(c.codexHome, 'worktrees', 'other-id', 'different-checkout');
    await createWorktree(worktreeRoot, path.join(repositoryRoot, '.git', 'linked-checkout'));
    const row = await sendEvent(c, 'wrong-gitdir-shape', worktreeRoot);

    assert.equal(row.product.key, productKey(worktreeRoot));
    assert.equal(row.product.name, path.basename(worktreeRoot));
  });
});

// 旧版が worktree の鍵のまま保存した PR 登録を用意する。片方は worktree が消えている。
async function seedCodexWorktreeRegistrations({ homeDir, codexHome }) {
  const repositoryRoot = path.join(homeDir, 'source-repository');
  const savedWorktree = path.join(codexHome, 'worktrees', 'saved-id', 'source-repository');
  const removedWorktree = path.join(codexHome, 'worktrees', 'removed-id', 'source-repository');
  await createWorktree(savedWorktree, path.join(repositoryRoot, '.git', 'worktrees', 'linked-checkout'));
  const state = new DashboardState({ homeDir });
  for (const [sessionId, number, worktreeRoot] of [['saved-codex', 1, savedWorktree], ['removed-codex', 2, removedWorktree]]) {
    state.registerPullRequest(sessionId, {
      url: `https://github.com/example/source-repository/pull/${number}`,
    }, { cwd: worktreeRoot, product: { key: productKey(worktreeRoot), name: path.basename(worktreeRoot) } }, Date.now());
  }
  await state.flushPersistence();
}

test('保存済みの Codex worktree の PR 登録は、起動時に元のリポジトリの製品へ畳み直す', async (t) => {
  // gh の呼び出しは完了させず、初回取得の途中の状態で製品の鍵を確かめる。
  const callbacks = [];
  const c = await cockpit(t, {
    seed: seedCodexWorktreeRegistrations,
    pullRequestOptions: { execFileImpl(_file, _args, _options, done) { callbacks.push(done); } },
  });
  const repositoryRoot = path.join(c.homeDir, 'source-repository');
  const savedKey = productKey(repositoryRoot);
  const removedKey = productKey(path.join(c.codexHome, 'worktrees', 'removed-id', 'source-repository'));
  const fetching = c.runtime.pullRequestTracker.refreshRepo('example', 'source-repository');

  const snapshot = jsonBody(await request(c.runtime.info.port, { path: '/api/state' }));
  const groups = snapshot.pullRequests.filter((group) => group.repo === 'source-repository');
  assert.deepEqual(groups.map((group) => group.product.key).sort(), [removedKey, savedKey].sort());
  assert.equal(groups.find((group) => group.product.key === savedKey).product.name, path.basename(repositoryRoot));

  await c.runtime.state.flushPersistence();
  const saved = JSON.parse(await fs.readFile(path.join(c.homeDir, 'store.json'), 'utf8'));
  const savedKeys = Object.fromEntries(saved.prs.map((record) => [record.session_id, record.product.key]));
  assert.equal(savedKeys['saved-codex'], savedKey);
  assert.equal(savedKeys['removed-codex'], removedKey);

  while (c.runtime.pullRequestTracker.inFlight.size) {
    for (const done of callbacks.splice(0)) done(Object.assign(new Error('unavailable'), { code: 'ENOENT' }));
    await new Promise(resolve => setImmediate(resolve));
  }
  await fetching;
});
