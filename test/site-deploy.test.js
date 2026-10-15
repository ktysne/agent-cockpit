const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./support/temp');
const {
  checkReferences,
  cmdUpload,
  loadConfig,
  main,
  parseArgs,
  isFtpConnectionLost,
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
    [...items.map(item => path.basename(item.localPath) + '.uploading'), 'upload-manifest.json.uploading']);
  assert.deepEqual(events.filter(event => event.type === 'rename').map(event => event.newName),
    [...items.map(item => path.basename(item.localPath)), 'upload-manifest.json']);
  assert.equal(currentDirectory, remoteRoot);
  assert.deepEqual([...remoteFiles.keys()].sort(), [
    ...items.map(item => path.posix.join(remoteRoot, item.label)),
    path.posix.join(remoteRoot, 'upload-manifest.json'),
  ].sort());
});

const FTP_CONFIG = { host: 'ftp.example.com', port: 21, user: 'user', password: 'password', secure: true, remoteRoot: '/remote/site' };

function fakeFtpServer() {
  const remoteFiles = new Map();
  const remoteContents = new Map();
  const uploads = [];
  const failures = [];
  const pauses = [];
  let clients = 0;
  const createClient = () => {
    clients += 1;
    let currentDirectory = '/';
    let closed = false;
    const failIfPlanned = (operation, name) => {
      const index = failures.findIndex(failure => failure(operation, name, currentDirectory));
      if (index < 0) return;
      failures.splice(index, 1);
      closed = true;
      throw Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    };
    const remotePath = name => path.posix.join(currentDirectory, name);
    return {
      get closed() { return closed; },
      async access() {},
      async cd(directory) { currentDirectory = directory === '/' ? '/' : path.posix.join(currentDirectory, directory); },
      async ensureDir(directory) {
        currentDirectory = path.posix.normalize(directory.startsWith('/') ? directory : path.posix.join(currentDirectory, directory));
      },
      async uploadFrom(localPath, name) {
        failIfPlanned('upload', name);
        const content = fs.readFileSync(localPath);
        remoteFiles.set(remotePath(name), content.length);
        remoteContents.set(remotePath(name), content);
        uploads.push({ name, content });
      },
      async list() {
        failIfPlanned('list', '');
        return [...remoteFiles]
          .filter(([filePath]) => path.posix.dirname(filePath) === currentDirectory)
          .map(([filePath, size]) => ({ name: path.posix.basename(filePath), size }));
      },
      async rename(oldName, newName) {
        failIfPlanned('rename', newName);
        if (!remoteFiles.has(remotePath(oldName)) || remoteFiles.has(remotePath(newName))) throw new Error('rename failed');
        remoteFiles.set(remotePath(newName), remoteFiles.get(remotePath(oldName)));
        if (remoteContents.has(remotePath(oldName))) {
          remoteContents.set(remotePath(newName), remoteContents.get(remotePath(oldName)));
          remoteContents.delete(remotePath(oldName));
        }
        remoteFiles.delete(remotePath(oldName));
      },
      async remove(name) {
        remoteFiles.delete(remotePath(name));
        remoteContents.delete(remotePath(name));
      },
      async downloadTo(destination, name) {
        failIfPlanned('download', name);
        const content = remoteContents.get(remotePath(name));
        if (!content) throw Object.assign(new Error('550 File unavailable'), { code: 550 });
        await new Promise((resolve, reject) => {
          destination.once('finish', resolve);
          destination.once('error', reject);
          destination.end(content);
        });
      },
      close() { closed = true; },
    };
  };
  return {
    remoteFiles,
    remoteContents,
    uploads,
    failures,
    pauses,
    clientCount: () => clients,
    dependencies: { createClient, pauseBeforeReconnect: async ms => { pauses.push(ms); } },
  };
}

function expectedRemoteFiles(items) {
  const files = Object.fromEntries(items.map(item => [item.label,
    crypto.createHash('sha256').update(fs.readFileSync(item.localPath)).digest('hex')]));
  const manifestText = JSON.stringify({ schema: 1, algorithm: 'sha256', files }, null, 2) + '\n';
  return [
    ...items.map(item => [path.posix.join(FTP_CONFIG.remoteRoot, item.label), fs.statSync(item.localPath).size]),
    [path.posix.join(FTP_CONFIG.remoteRoot, 'upload-manifest.json'), Buffer.byteLength(manifestText)],
  ].sort(([left], [right]) => (left < right ? -1 : 1));
}

function sortedEntries(map) {
  return [...map].sort(([left], [right]) => (left < right ? -1 : 1));
}

function seedPublishedSite(server, items, { overrides = {}, manifestText } = {}) {
  const files = {};
  for (const item of items) {
    const content = Buffer.from(overrides[item.label] ?? fs.readFileSync(item.localPath));
    const remotePath = path.posix.join(FTP_CONFIG.remoteRoot, item.label);
    server.remoteFiles.set(remotePath, content.length);
    server.remoteContents.set(remotePath, content);
    files[item.label] = crypto.createHash('sha256').update(content).digest('hex');
  }
  const text = manifestText ?? JSON.stringify({ schema: 1, algorithm: 'sha256', files }, null, 2) + '\n';
  const manifestPath = path.posix.join(FTP_CONFIG.remoteRoot, 'upload-manifest.json');
  server.remoteFiles.set(manifestPath, Buffer.byteLength(text));
  server.remoteContents.set(manifestPath, Buffer.from(text));
}

test('一致するファイルは送らず、一覧も更新しない', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  const items = siteItems(siteDir, manualDir);
  const server = fakeFtpServer();
  seedPublishedSite(server, items);

  await uploadSite(items, FTP_CONFIG, server.dependencies);

  assert.deepEqual(server.uploads, []);
});

test('同じ大きさでも内容のハッシュが違うファイルだけを送る', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  const items = siteItems(siteDir, manualDir);
  const server = fakeFtpServer();
  seedPublishedSite(server, items);
  write(siteDir, 'license.html', '<a href="./">Away</a>');

  await uploadSite(items, FTP_CONFIG, server.dependencies);

  assert.deepEqual(server.uploads.map(upload => upload.name), ['license.html.uploading', 'upload-manifest.json.uploading']);
});

test('送り始める前にサーバーの一覧を消すので、途中で止まった後の配信は全ファイルを送る', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  const items = siteItems(siteDir, manualDir);
  const server = fakeFtpServer();
  seedPublishedSite(server, items);
  const original = fs.readFileSync(path.join(siteDir, 'license.html'));
  write(siteDir, 'license.html', '<a href="./">Away</a>');
  server.failures.push(...Array.from({ length: 4 }, () => operation => operation === 'upload'));

  await assert.rejects(uploadSite(items, FTP_CONFIG, server.dependencies), /4 回切れた/);
  assert.equal(server.remoteFiles.has(path.posix.join(FTP_CONFIG.remoteRoot, 'upload-manifest.json')), false);

  fs.writeFileSync(path.join(siteDir, 'license.html'), original);
  server.uploads.length = 0;
  await uploadSite(items, FTP_CONFIG, server.dependencies);

  assert.deepEqual(server.uploads.map(upload => upload.name), [
    ...items.map(item => path.basename(item.localPath) + '.uploading'),
    'upload-manifest.json.uploading',
  ]);
});

test('一覧が無いと全ファイルを送り、最後に送る一覧が実送信内容のハッシュを持つ', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  const items = siteItems(siteDir, manualDir);
  const server = fakeFtpServer();

  await uploadSite(items, FTP_CONFIG, server.dependencies);

  assert.deepEqual(server.uploads.map(upload => upload.name), [
    ...items.map(item => path.basename(item.localPath) + '.uploading'),
    'upload-manifest.json.uploading',
  ]);
  const manifest = JSON.parse(server.uploads.at(-1).content.toString('utf8'));
  assert.deepEqual(Object.keys(manifest.files), items.map(item => item.label));
  for (const [index, item] of items.entries()) {
    assert.equal(manifest.files[item.label], crypto.createHash('sha256').update(server.uploads[index].content).digest('hex'));
  }
});

test('不正な一覧の値が 1 件でもあれば全ファイルを送る', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  const items = siteItems(siteDir, manualDir);
  const server = fakeFtpServer();
  seedPublishedSite(server, items, { manifestText: JSON.stringify({ schema: 1, algorithm: 'sha256', files: { 'index.html': 'bad' } }) });

  await uploadSite(items, FTP_CONFIG, server.dependencies);

  assert.deepEqual(server.uploads.map(upload => upload.name), [
    ...items.map(item => path.basename(item.localPath) + '.uploading'),
    'upload-manifest.json.uploading',
  ]);
});

test('--full は一覧とハッシュが一致していても全ファイルを送る', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  const items = siteItems(siteDir, manualDir);
  const server = fakeFtpServer();
  seedPublishedSite(server, items);

  await uploadSite(items, FTP_CONFIG, { ...server.dependencies, full: true });

  assert.deepEqual(server.uploads.map(upload => upload.name), [
    ...items.map(item => path.basename(item.localPath) + '.uploading'),
    'upload-manifest.json.uploading',
  ]);
});

test('一覧に載っていてもサーバーに無いファイルは送る', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  const items = siteItems(siteDir, manualDir);
  const server = fakeFtpServer();
  seedPublishedSite(server, items);
  const logoPath = path.posix.join(FTP_CONFIG.remoteRoot, 'assets/logo.png');
  server.remoteFiles.delete(logoPath);
  server.remoteContents.delete(logoPath);

  await uploadSite(items, FTP_CONFIG, server.dependencies);

  assert.deepEqual(server.uploads.map(upload => upload.name), ['logo.png.uploading', 'upload-manifest.json.uploading']);
});

test('一覧取得中に接続が切れたらつなぎ直して全ファイルを送る', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  const items = siteItems(siteDir, manualDir);
  const server = fakeFtpServer();
  seedPublishedSite(server, items);
  server.failures.push(operation => operation === 'list');

  await uploadSite(items, FTP_CONFIG, server.dependencies);

  assert.equal(server.clientCount(), 2);
  assert.deepEqual(server.uploads.map(upload => upload.name), [
    ...items.map(item => path.basename(item.localPath) + '.uploading'),
    'upload-manifest.json.uploading',
  ]);
});

test('一覧のダウンロード中に接続が切れたらつなぎ直して全ファイルを送る', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  const items = siteItems(siteDir, manualDir);
  const server = fakeFtpServer();
  seedPublishedSite(server, items);
  server.failures.push(operation => operation === 'download');

  await uploadSite(items, FTP_CONFIG, server.dependencies);

  assert.equal(server.clientCount(), 2);
  assert.deepEqual(server.uploads.map(upload => upload.name), [
    ...items.map(item => path.basename(item.localPath) + '.uploading'),
    'upload-manifest.json.uploading',
  ]);
});

test('紹介ページの埋め込み版が変わると他の一致ファイルを保って index.html を送る', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  write(siteDir, 'index.html', SITE_VERSION_HTML);
  const items = siteItems(siteDir, manualDir);
  const oldIndex = SITE_VERSION_HTML.replace('data-site-version></small>', 'data-site-version>v9.9.8</small>');
  const server = fakeFtpServer();
  seedPublishedSite(server, items, { overrides: { 'index.html': oldIndex } });

  await cmdUpload({ command: 'upload', version: 'v9.9.9' }, {
    siteDir,
    manualDir,
    config: FTP_CONFIG,
    ...server.dependencies,
  });

  assert.deepEqual(server.uploads.map(upload => upload.name), ['index.html.uploading', 'upload-manifest.json.uploading']);
  const indexContent = server.remoteContents.get(path.posix.join(FTP_CONFIG.remoteRoot, 'index.html'));
  const manifest = JSON.parse(server.remoteContents.get(path.posix.join(FTP_CONFIG.remoteRoot, 'upload-manifest.json')).toString('utf8'));
  assert.equal(manifest.files['index.html'], crypto.createHash('sha256').update(indexContent).digest('hex'));
  assert.match(indexContent.toString('utf8'), />v9\.9\.9</);
});

test('uploadSite は送信中に接続が切れたら、つなぎ直してそのファイルから送り直す', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  const items = siteItems(siteDir, manualDir);
  const server = fakeFtpServer();
  server.failures.push((operation, name) => operation === 'upload' && name === 'main.png.uploading');

  await uploadSite(items, FTP_CONFIG, server.dependencies);

  assert.equal(server.clientCount(), 2);
  assert.deepEqual(server.pauses, [3000]);
  assert.deepEqual(sortedEntries(server.remoteFiles), expectedRemoteFiles(items));
});

test('uploadSite は置き換えの途中で切れて退避名だけが残ったら、公開名へ戻してから送り直す', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  const items = siteItems(siteDir, manualDir);
  const server = fakeFtpServer();
  const indexPath = path.posix.join(FTP_CONFIG.remoteRoot, 'index.html');
  server.remoteFiles.set(indexPath, 1);
  server.failures.push((operation, name) => operation === 'rename' && name === 'index.html'
    && server.remoteFiles.has(indexPath + '.previous'));

  await uploadSite(items, FTP_CONFIG, server.dependencies);

  assert.equal(server.clientCount(), 2);
  assert.deepEqual(sortedEntries(server.remoteFiles), expectedRemoteFiles(items));
});

test('uploadSite は同じファイルで接続が 4 回切れたら止める', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  const items = siteItems(siteDir, manualDir);
  const server = fakeFtpServer();
  for (let count = 0; count < 4; count += 1) {
    server.failures.push((operation, name) => operation === 'upload' && name === 'license.html.uploading');
  }

  await assert.rejects(uploadSite(items, FTP_CONFIG, server.dependencies), /license\.html の送信中に FTP の接続が 4 回切れた/);
  assert.equal(server.clientCount(), 4);
  assert.equal(server.remoteFiles.has(path.posix.join(FTP_CONFIG.remoteRoot, 'index.html')), false);
});

test('isFtpConnectionLost は通信の切断と、接続を閉じる 421 の応答を接続の切断として扱う', () => {
  assert.equal(isFtpConnectionLost({ closed: false }, { code: 'ECONNRESET' }), true);
  assert.equal(isFtpConnectionLost({ closed: false }, { code: 421 }), true);
  assert.equal(isFtpConnectionLost({ closed: true }, new Error('closed')), true);
  assert.equal(isFtpConnectionLost({ closed: false }, { code: 550 }), false);
});

test('uploadSite は接続が切れたのではない失敗を送り直さない', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  const items = siteItems(siteDir, manualDir);
  const server = fakeFtpServer();
  const dependencies = {
    ...server.dependencies,
    createClient() {
      const client = server.dependencies.createClient();
      client.uploadFrom = async () => { throw new Error('550 Permission denied'); };
      return client;
    },
  };

  await assert.rejects(uploadSite(items, FTP_CONFIG, dependencies), /550 Permission denied/);
  assert.equal(server.clientCount(), 1);
  assert.deepEqual(server.pauses, []);
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
      execFileSync: () => 'a\trefs/tags/v1.0.0\n',
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
  assert.ok(output.some(line => line.includes('差分は送信時にサーバーの upload-manifest.json と比べて決めます')));
  assert.equal(output.filter(line => line.startsWith('  (remoteRoot 未設定)/')).length, siteItems().length);
});

const SITE_VERSION_HTML = '<a class="btn primary" href="#install">導入<small class="site-version" data-site-version></small></a>';

function recordingFtpServer() {
  const server = fakeFtpServer();
  const sent = new Map();
  const createClient = () => {
    const client = server.dependencies.createClient();
    const uploadFrom = client.uploadFrom;
    client.uploadFrom = async (localPath, name) => {
      sent.set(name, fs.readFileSync(localPath, 'utf8'));
      return uploadFrom(localPath, name);
    };
    return client;
  };
  return { server, sent, createClient };
}

test('紹介ページの版の要素に指定した版を入れて送り、リポジトリの index.html は書き換えない', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  write(siteDir, 'index.html', SITE_VERSION_HTML);
  const { sent, createClient } = recordingFtpServer();

  await cmdUpload({ command: 'upload', version: 'v9.9.9' }, {
    siteDir,
    manualDir,
    config: FTP_CONFIG,
    createClient,
    pauseBeforeReconnect: async () => {},
  });

  assert.equal(sent.get('index.html.uploading'), SITE_VERSION_HTML.replace('data-site-version></small>', 'data-site-version>v9.9.9</small>'));
  assert.equal(fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8'), SITE_VERSION_HTML);
});

test('紹介ページに版の要素が無いときは、何も送らずに止まる', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  write(siteDir, 'index.html', '<p>導入</p>');
  const { server, createClient } = recordingFtpServer();

  await assert.rejects(cmdUpload({ command: 'upload', version: 'v9.9.9' }, {
    siteDir,
    manualDir,
    config: FTP_CONFIG,
    createClient,
  }), /data-site-version/);
  assert.equal(server.clientCount(), 0);
});

test('--version が無いときは origin の最新の版タグを紹介ページに入れる', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  write(siteDir, 'index.html', SITE_VERSION_HTML);
  const lsRemoteCalls = [];
  const execFileSync = (file, args) => {
    lsRemoteCalls.push(args.join(' '));
    return [
      'a\trefs/tags/v1.0.9',
      'b\trefs/tags/v1.0.10',
      'c\trefs/tags/v1.0.10^{}',
      'd\trefs/tags/v2.0.0-rc1',
    ].join('\n') + '\n';
  };
  const output = [];
  const previousLog = console.log;
  console.log = message => output.push(message);
  try {
    await cmdUpload({ command: 'upload', dryRun: true, config: path.join(directory, 'missing.json') }, {
      siteDir,
      manualDir,
      env: {},
      execFileSync,
    });
  } finally {
    console.log = previousLog;
  }

  assert.deepEqual(lsRemoteCalls, ['ls-remote --tags origin']);
  assert.ok(output.includes('埋め込む紹介ページの版: v1.0.10'));
});

test('origin の版タグを取得できないときは、版を決めずに止まる', async t => {
  const { directory } = temporaryDirectory(t);
  const { siteDir, manualDir } = createSite(directory);
  const execFileSync = () => { throw new Error('fatal: unable to access'); };

  await assert.rejects(cmdUpload({ command: 'upload', dryRun: true, config: path.join(directory, 'missing.json') }, {
    siteDir,
    manualDir,
    env: {},
    execFileSync,
  }), /git ls-remote --tags origin が失敗しました/);
});

test('parseArgs は upload の dry-run と config を読み、未知のコマンドには使い方を表示する', async () => {
  assert.deepEqual(parseArgs(['upload', '--dry-run', '--config', 'custom.json']), {
    command: 'upload',
    dryRun: true,
    config: 'custom.json',
  });
  assert.equal(parseArgs(['upload', '--version', 'v1.0.1']).version, 'v1.0.1');
  assert.equal(parseArgs(['upload', '--full']).full, true);

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
