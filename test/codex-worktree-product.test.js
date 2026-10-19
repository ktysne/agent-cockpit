const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { startServer } = require('../src/server/server');
const { hookHeaders, jsonBody, request } = require('./support/server');
const { temporaryHome } = require('./support/temp');

async function cockpit(testContext) {
  const temporary = temporaryHome(testContext, 'agent-cockpit-codex-worktree-', { deferCleanup: true });
  const codexHome = path.join(temporary.homeDir, '.codex');
  const serverCodexHome = process.platform === 'win32' ? codexHome.toLowerCase() : codexHome;
  let runtime;
  try {
    runtime = await startServer({
      ...temporary,
      codexHome: serverCodexHome,
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
