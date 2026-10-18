const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { branchFromCwd, productFromCwd } = require('../src/server/identity');
const { temporaryDirectory: createTemporaryDirectory } = require('./support/temp');

async function temporaryDirectory(testContext) {
  return createTemporaryDirectory(testContext, 'agent-cockpit-identity-').directory;
}

function posixFileSystem(files, directories) {
  const fileEntries = new Map(Object.entries(files));
  const directoryEntries = new Set(directories);
  return {
    statSync(filePath) {
      if (directoryEntries.has(filePath)) return { isDirectory: () => true, isFile: () => false, size: 0 };
      if (fileEntries.has(filePath)) {
        return { isDirectory: () => false, isFile: () => true, size: Buffer.byteLength(fileEntries.get(filePath)) };
      }
      const error = new Error('not found');
      error.code = 'ENOENT';
      throw error;
    },
    readFileSync(filePath) {
      if (!fileEntries.has(filePath)) throw new Error('unexpected file read');
      return fileEntries.get(filePath);
    },
  };
}

test('通常のリポジトリからブランチ名を取得する', async (t) => {
  const directory = await temporaryDirectory(t);
  const cwd = path.join(directory, 'src', 'nested');
  await fsp.mkdir(path.join(directory, '.git'), { recursive: true });
  await fsp.mkdir(cwd, { recursive: true });
  await fsp.writeFile(path.join(directory, '.git', 'HEAD'), 'ref: refs/heads/feature/session-view\n');

  assert.equal(branchFromCwd(cwd), 'feature/session-view');
});

test('POSIX の絶対パスから通常リポジトリ、worktree、detached HEAD のブランチを取得する', () => {
  const sha = '0123456789abcdef0123456789abcdef01234567';
  const worktreeRoot = '/tmp/repository/.claude/worktrees/feature-x';
  const cases = [
    {
      cwd: '/tmp/project/src',
      fileSystem: posixFileSystem({ '/tmp/project/.git/HEAD': 'ref: refs/heads/feature/posix\n' }, ['/tmp/project/.git']),
      expected: 'feature/posix',
    },
    {
      cwd: `${worktreeRoot}/src`,
      fileSystem: posixFileSystem({
        [`${worktreeRoot}/.git`]: `gitdir: ${path.posix.relative(worktreeRoot, '/tmp/repository/.git/worktrees/feature-x')}\n`,
        '/tmp/repository/.git/worktrees/feature-x/HEAD': 'ref: refs/heads/fix/posix-worktree\n',
      }, ['/tmp/repository/.git/worktrees/feature-x']),
      expected: 'fix/posix-worktree',
    },
    {
      cwd: '/tmp/detached',
      fileSystem: posixFileSystem({ '/tmp/detached/.git/HEAD': `${sha}\n` }, ['/tmp/detached/.git']),
      expected: sha.slice(0, 7),
    },
  ];

  for (const { cwd, fileSystem, expected } of cases) {
    assert.equal(branchFromCwd(cwd, { fileSystem }), expected, cwd);
  }
});

test('POSIX のプロダクトキーは大文字小文字を区別する', () => {
  const fileSystem = posixFileSystem({}, []);
  const upper = productFromCwd('/tmp/Project', { fileSystem });
  const lower = productFromCwd('/tmp/project', { fileSystem });

  assert.equal(upper.key, '/tmp/Project');
  assert.equal(lower.key, '/tmp/project');
  assert.notEqual(upper.key, lower.key);
});

test('Windows のドライブ、ルート相対、UNC パスは Windows 規則で解決する', () => {
  assert.equal(productFromCwd('C:\\Repo').key, productFromCwd('c:/repo').key);
  assert.equal(productFromCwd('\\Repo').key, path.win32.resolve('\\Repo').toLowerCase());
  assert.equal(productFromCwd('\\\\server\\share\\Repo').key, path.win32.resolve('\\\\server\\share\\Repo').toLowerCase());
  assert.equal(productFromCwd('//server/share/Repo').key, productFromCwd('\\\\server\\share\\Repo').key);
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

test('4 KB を超える HEAD は読まない', async (t) => {
  const directory = await temporaryDirectory(t);
  const cwd = path.join(directory, 'project');
  await fsp.mkdir(path.join(cwd, '.git'), { recursive: true });
  await fsp.writeFile(path.join(cwd, '.git', 'HEAD'), 'x'.repeat(4097));

  assert.equal(branchFromCwd(cwd), null);
});

test('4 KB を超える gitdir ポインターは読まない', async (t) => {
  const directory = await temporaryDirectory(t);
  const cwd = path.join(directory, 'worktree');
  await fsp.mkdir(cwd, { recursive: true });
  await fsp.writeFile(path.join(cwd, '.git'), `gitdir: ${'x'.repeat(4096)}`);

  assert.equal(branchFromCwd(cwd), null);
});

test('HEAD がディレクトリならブランチ名を null にする', async (t) => {
  const directory = await temporaryDirectory(t);
  const cwd = path.join(directory, 'project');
  await fsp.mkdir(path.join(cwd, '.git', 'HEAD'), { recursive: true });

  assert.equal(branchFromCwd(cwd), null);
});

test('gitdir が存在しない場所を指すときはブランチ名を null にする', async (t) => {
  const directory = await temporaryDirectory(t);
  const cwd = path.join(directory, 'worktree');
  await fsp.mkdir(cwd, { recursive: true });
  await fsp.writeFile(path.join(cwd, '.git'), 'gitdir: ../missing-gitdir\n');

  assert.equal(branchFromCwd(cwd), null);
});

test('Windows の UNC gitdir ポインターは読まない', () => {
  const gitFilePath = 'C:\\repo\\.git';
  const touched = [];
  const fileSystem = {
    statSync(filePath) {
      touched.push(filePath);
      if (filePath === gitFilePath) return { isDirectory: () => false, isFile: () => true, size: 64 };
      const error = new Error('not found');
      error.code = 'ENOENT';
      throw error;
    },
    readFileSync(filePath) {
      if (filePath === gitFilePath) return 'gitdir: \\\\server\\share\\repo.git\n';
      throw new Error('unexpected file read');
    },
  };

  assert.equal(branchFromCwd('C:\\repo\\src', { fileSystem }), null);
  assert.ok(!touched.some((filePath) => filePath.startsWith('\\\\')));
});
