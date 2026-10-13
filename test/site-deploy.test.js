const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./support/temp');
const {
  checkReferences,
  loadConfig,
  main,
  parseArgs,
  remoteRootOf,
  siteItems,
  uploadSite,
} = require('../tools/site-deploy');

const ROOT = path.resolve(__dirname, '..');
const FTP_PREFIX = 'AGENT_COCKPIT_FTP_';

function write(root, relativePath, content) {
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function createSite(directory) {
  const siteDir = path.join(directory, 'site');
  const manualDir = path.join(directory, 'manual');
  write(siteDir, 'assets/logo.png', 'asset');
  write(siteDir, 'img/review/review.png', 'review');
  write(siteDir, 'img/review/review.json', '{}');
  write(siteDir, 'img/work/work.png', 'work');
  write(siteDir, 'shots/review.json', '{}');
  write(siteDir, 'license.html', '<a href="./">Home</a>');
  write(siteDir, 'index.html', '<img src="assets/logo.png"><a href="manual/">manual</a>');
  write(manualDir, 'img/guide/main.png', 'guide');
  write(manualDir, 'img/guide/main.json', '{}');
  write(manualDir, 'dist/assets/manual.css', 'body {}');
  write(manualDir, 'dist/index.html', '<link href="assets/manual.css"><img src="img/guide/main.png"><a href="away.html#top">away</a>');
  write(manualDir, 'dist/away.html', '<a href="index.html">top</a><a href="https://github.com/ktysne/agent-cockpit">GitHub</a>');
  write(manualDir, 'pages/index.html', '<p>原稿は送らない</p>');
  return { siteDir, manualDir };
}

test('siteItems は画像とアセットを先に、ページを後に並べ、撮影の定義と矩形 JSON と原稿を含めない', t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);

  assert.deepEqual(siteItems(siteDir, manualDir).map(item => [item.label, item.remoteSubDir]), [
    ['assets/logo.png', 'assets'],
    ['img/review/review.png', 'img/review'],
    ['img/work/work.png', 'img/work'],
    ['manual/img/guide/main.png', 'manual/img/guide'],
    ['manual/assets/manual.css', 'manual/assets'],
    ['manual/away.html', 'manual'],
    ['manual/index.html', 'manual'],
    ['license.html', ''],
    ['index.html', ''],
  ]);
});

test('checkReferences は紹介ページとマニュアルのページの参照を、ページの場所から解決して確かめる', t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  write(siteDir, 'index.html', [
    '<img src="assets/logo.png">',
    '<a href="license.html">license</a>',
    '<a href="manual/">manual</a>',
    '<a href="manual/#help-settings">settings</a>',
    '<a href="#top">top</a>',
    '<a href="./">home</a>',
    '<a href="https://example.com">external</a>',
    '<a href="mailto:help@example.com">mail</a>',
  ].join('\n'));
  const items = siteItems(siteDir, manualDir);

  assert.doesNotThrow(() => checkReferences(items));
  write(siteDir, 'license.html', '<a href="missing.html">missing</a>');
  assert.throws(() => checkReferences(items), /license\.html -> missing\.html/);
  write(siteDir, 'license.html', '<a href="./">Home</a>');
  write(manualDir, 'dist/away.html', '<img src="img/guide/missing.png">');
  assert.throws(() => checkReferences(items), /manual\/away\.html -> img\/guide\/missing\.png/);
});

test('loadConfig は設定ファイルを優先し、無ければ環境変数を読み、両方に無ければ失敗する', t => {
  const { directory } = temporaryDirectory(t);
  const configPath = path.join(directory, 'deploy.json');
  const env = {
    [FTP_PREFIX + 'HOST']: 'env.example.com',
    [FTP_PREFIX + 'USER']: 'env-user',
    [FTP_PREFIX + 'PASSWORD']: 'env-password',
    [FTP_PREFIX + 'REMOTE_ROOT']: '/env/site',
  };
  fs.writeFileSync(configPath, JSON.stringify({
    host: 'config.example.com',
    user: 'config-user',
    password: 'config-password',
    remoteRoot: '/config/site',
  }));

  assert.equal(loadConfig(configPath, env).host, 'config.example.com');
  assert.equal(loadConfig(path.join(directory, 'missing.json'), env).host, 'env.example.com');
  assert.throws(() => loadConfig(path.join(directory, 'missing.json'), {}), /FTPS の接続情報がありません/);
});

test('remoteRootOf はルート、相対パス、親ディレクトリ参照を拒む', () => {
  for (const remoteRoot of ['/', 'relative/site', '/site/../outside']) {
    assert.throws(() => remoteRootOf({ remoteRoot }), /remoteRoot/);
  }
  assert.equal(remoteRootOf({ remoteRoot: '/ktysne.info/agent-cockpit/' }), '/ktysne.info/agent-cockpit');
});

test('uploadSite は各ファイルを .uploading で送り、リネーム後に remoteRoot へ戻る', async () => {
  const items = siteItems(path.join(ROOT, 'site'));
  const remoteRoot = '/remote/site';
  const remoteFiles = new Map();
  const events = [];
  let currentDirectory = '/';
  const client = {
    async access(options) { events.push({ type: 'access', options }); },
    async cd(directory) {
      currentDirectory = directory === '/' ? '/' : path.posix.join(currentDirectory, directory);
      events.push({ type: 'cd', directory, currentDirectory });
    },
    async ensureDir(directory) {
      currentDirectory = path.posix.normalize(directory.startsWith('/')
        ? directory
        : path.posix.join(currentDirectory, directory));
      events.push({ type: 'ensureDir', directory, currentDirectory });
    },
    async uploadFrom(localPath, remoteName) {
      const remotePath = path.posix.join(currentDirectory, remoteName);
      remoteFiles.set(remotePath, fs.statSync(localPath).size);
      events.push({ type: 'upload', localPath, remoteName, remotePath });
    },
    async list() {
      return [...remoteFiles]
        .filter(([remotePath]) => path.posix.dirname(remotePath) === currentDirectory)
        .map(([remotePath, size]) => ({ name: path.posix.basename(remotePath), size }));
    },
    async rename(oldName, newName) {
      const oldPath = path.posix.join(currentDirectory, oldName);
      const newPath = path.posix.join(currentDirectory, newName);
      if (!remoteFiles.has(oldPath) || remoteFiles.has(newPath)) throw new Error('rename failed');
      remoteFiles.set(newPath, remoteFiles.get(oldPath));
      remoteFiles.delete(oldPath);
      events.push({ type: 'rename', oldName, newName, newPath });
    },
    async remove(name) { remoteFiles.delete(path.posix.join(currentDirectory, name)); },
    close() { events.push({ type: 'close' }); },
  };

  await uploadSite(items, {
    host: 'ftp.example.com',
    port: 21,
    user: 'user',
    password: 'password',
    secure: true,
    remoteRoot,
  }, { client });

  assert.deepEqual(events.filter(event => event.type === 'upload').map(event => event.remoteName),
    items.map(item => path.basename(item.localPath) + '.uploading'));
  assert.deepEqual(events.filter(event => event.type === 'rename').map(event => event.newName),
    items.map(item => path.basename(item.localPath)));
  assert.equal(events.filter(event => event.type === 'ensureDir' && event.directory === remoteRoot).length,
    items.filter(item => item.remoteSubDir).length + 1);
  assert.equal(currentDirectory, remoteRoot);
  assert.deepEqual([...remoteFiles.keys()].sort(), items.map(item => path.posix.join(remoteRoot, item.label)).sort());
});

test('dry-run は対象と要確認を表示し、FTPS クライアントへ接続しない', async t => {
  const { directory } = temporaryDirectory(t);
  const missingConfig = path.join(directory, 'missing.json');
  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  const output = [];
  let accessCount = 0;
  console.log = message => output.push(message);
  process.exitCode = undefined;
  try {
    const result = await main(['upload', '--dry-run', '--config', missingConfig], {
      env: {},
      client: { async access() { accessCount += 1; } },
    });
    assert.equal(result.dryRun, true);
    assert.ok(result.configProblem);
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = previousLog;
    process.exitCode = previousExitCode;
  }

  assert.equal(accessCount, 0);
  assert.ok(output.some(line => line.includes('要確認')));
  assert.equal(output.filter(line => line.startsWith('  (remoteRoot 未設定)/')).length, siteItems().length);
});

test('parseArgs は upload の dry-run と config を読み、未知のコマンドには使い方を表示する', async () => {
  assert.deepEqual(parseArgs(['upload', '--dry-run', '--config', 'custom.json']), {
    command: 'upload',
    dryRun: true,
    config: 'custom.json',
  });

  const previousExitCode = process.exitCode;
  const previousLog = console.log;
  const output = [];
  console.log = message => output.push(message);
  process.exitCode = undefined;
  try {
    await main([]);
    assert.equal(process.exitCode, 1);
  } finally {
    console.log = previousLog;
    process.exitCode = previousExitCode;
  }
  assert.ok(output.some(line => line.includes('node tools/site-deploy.js upload')));
});
