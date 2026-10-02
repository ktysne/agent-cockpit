const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { branchFromCwd } = require('../src/server/identity');

async function temporaryDirectory(testContext) {
  const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-identity-'));
  testContext.after(() => fsp.rm(directory, { recursive: true, force: true }));
  return directory;
}

test('通常のリポジトリからブランチ名を取得する', async (t) => {
  const directory = await temporaryDirectory(t);
  const cwd = path.join(directory, 'src', 'nested');
  await fsp.mkdir(path.join(directory, '.git'), { recursive: true });
  await fsp.mkdir(cwd, { recursive: true });
  await fsp.writeFile(path.join(directory, '.git', 'HEAD'), 'ref: refs/heads/feature/session-view\n');

  assert.equal(branchFromCwd(cwd), 'feature/session-view');
});

test('worktree の .git ファイルが指す gitdir からブランチ名を取得する', async (t) => {
  const directory = await temporaryDirectory(t);
  const repository = path.join(directory, 'repository');
  const worktree = path.join(repository, '.claude', 'worktrees', 'feature-x');
  const cwd = path.join(worktree, 'src');
  const gitDirectory = path.join(repository, '.git', 'worktrees', 'feature-x');
  await fsp.mkdir(cwd, { recursive: true });
  await fsp.mkdir(gitDirectory, { recursive: true });
  await fsp.writeFile(path.join(worktree, '.git'), `gitdir: ${path.relative(worktree, gitDirectory)}\n`);
  await fsp.writeFile(path.join(gitDirectory, 'HEAD'), 'ref: refs/heads/fix/worktree-state\n');

  assert.equal(branchFromCwd(cwd), 'fix/worktree-state');
});

test('detached HEAD のコミット SHA は短縮して返す', async (t) => {
  const directory = await temporaryDirectory(t);
  const cwd = path.join(directory, 'project');
  const sha = '0123456789abcdef0123456789abcdef01234567';
  await fsp.mkdir(path.join(cwd, '.git'), { recursive: true });
  await fsp.writeFile(path.join(cwd, '.git', 'HEAD'), `${sha}\n`);

  assert.equal(branchFromCwd(cwd), sha.slice(0, 7));
});

test('HEAD を読めないときはブランチ名を null にする', async (t) => {
  const directory = await temporaryDirectory(t);
  const cwd = path.join(directory, 'project');
  await fsp.mkdir(path.join(cwd, '.git'), { recursive: true });
  await fsp.writeFile(path.join(cwd, '.git', 'HEAD'), 'ref: refs/heads/hidden\n');
  const fileSystem = {
    statSync: (...args) => fs.statSync(...args),
    readFileSync(filePath, ...args) {
      if (path.basename(filePath) === 'HEAD') {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        throw error;
      }
      return fs.readFileSync(filePath, ...args);
    },
  };

  assert.equal(branchFromCwd(cwd, { fileSystem }), null);
});
