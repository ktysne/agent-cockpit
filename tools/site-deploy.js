'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { isReleaseTag, latestReleaseTag } = require('./release-tag');

const ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(ROOT, 'site');
const MANUAL_DIR = path.join(ROOT, 'manual');
// 紹介ページの版を入れる要素。中身は配信のたびに版で置き換え、リポジトリの index.html は書き換えない。
const SITE_VERSION_ELEMENT = /<([a-z][a-z\d]*)\b([^>]*\sdata-site-version(?=[\s>])[^>]*)>[^<]*<\/\1>/gi;
const VALUE_OPTIONS = new Map([['--config', 'config'], ['--version', 'version']]);
const FTP_PREFIX = 'AGENT_COCKPIT_FTP_';
const UPLOAD_ATTEMPTS_PER_ITEM = 4;
const UPLOAD_RECONNECT_DELAY_MS = 3000;
const FTP_CONNECTION_LOST_CODES = new Set(['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'ECONNABORTED', 'ECONNREFUSED']);
const FTP_CLOSING_REPLY_CODE = 421;

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function filesIn(directory, remoteSubDir, accept = () => true) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && accept(entry.name))
    .map(entry => ({
      label: remoteSubDir ? remoteSubDir + '/' + entry.name : entry.name,
      localPath: path.join(directory, entry.name),
      remoteSubDir,
    }))
    .sort((left, right) => compareNames(left.label, right.label));
}

function imageItems(imagesDir, remotePrefix) {
  return fs.readdirSync(imagesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => compareNames(left.name, right.name))
    .flatMap(directory => filesIn(path.join(imagesDir, directory.name), remotePrefix + '/' + directory.name,
      name => name.endsWith('.png')));
}

// ページが参照するファイルを先に揃えるため、画像とアセットを送ってからページを送る。
// マニュアルの画像は manual/img/ にだけ置き、組み立て結果の manual/dist/ とは別の場所から送る。
function siteItems(siteDir = SITE_DIR, manualDir = MANUAL_DIR) {
  const manualDist = path.join(manualDir, 'dist');
  return [
    ...filesIn(path.join(siteDir, 'assets'), 'assets'),
    ...imageItems(path.join(siteDir, 'img'), 'img'),
    ...imageItems(path.join(manualDir, 'img'), 'manual/img'),
    ...filesIn(path.join(manualDist, 'assets'), 'manual/assets'),
    ...filesIn(manualDist, 'manual', name => name.endsWith('.html')),
    { label: 'license.html', localPath: path.join(siteDir, 'license.html'), remoteSubDir: '' },
    { label: 'index.html', localPath: path.join(siteDir, 'index.html'), remoteSubDir: '' },
  ];
}

function referencePath(value) {
  const target = value.trim();
  if (!target || target === './' || target.startsWith('#') || target.startsWith('//')
      || /^[a-z][a-z\d+.-]*:/i.test(target)) return null;
  const pathOnly = target.split(/[?#]/, 1)[0];
  if (!pathOnly) return null;
  try {
    return decodeURIComponent(pathOnly).replaceAll('\\', '/');
  } catch {
    return pathOnly.replaceAll('\\', '/');
  }
}

function referenceTarget(pageLabel, reference) {
  const joined = reference.startsWith('/')
    ? reference.slice(1)
    : path.posix.join(path.posix.dirname(pageLabel), reference);
  const target = path.posix.normalize(joined);
  return reference.endsWith('/') || target === '.' ? path.posix.join(target, 'index.html') : target;
}

function checkReferences(items) {
  const included = new Set(items.map(item => path.posix.normalize(item.label.replaceAll('\\', '/'))));
  const missing = [];

  for (const page of items.filter(item => item.label.endsWith('.html'))) {
    const html = fs.readFileSync(page.localPath, 'utf8');
    const attributes = /\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi;
    for (const match of html.matchAll(attributes)) {
      const reference = referencePath(match[2]);
      if (reference === null) continue;
      if (!included.has(referenceTarget(page.label, reference))) missing.push(page.label + ' -> ' + match[2]);
    }
  }

  if (missing.length) {
    throw new Error('送信対象に含まれないローカル参照があります: ' + [...new Set(missing)].join(', '));
  }
}

function buildConfigFromEnv(env) {
  const required = ['HOST', 'USER', 'PASSWORD', 'REMOTE_ROOT'];
  const missing = required
    .map(name => FTP_PREFIX + name)
    .filter(name => !env[name]);
  if (missing.length) throw new Error('FTPS の接続情報がありません: ' + missing.join(', '));

  const port = env[FTP_PREFIX + 'PORT'] ? Number(env[FTP_PREFIX + 'PORT']) : 21;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(FTP_PREFIX + 'PORT は 1〜65535 の整数で指定してください。');
  }
  const secureText = env[FTP_PREFIX + 'SECURE'];
  const secure = !(secureText === 'false' || secureText === '0');
  let secureOptions;
  if (env[FTP_PREFIX + 'SECURE_OPTIONS']) {
    try {
      secureOptions = JSON.parse(env[FTP_PREFIX + 'SECURE_OPTIONS']);
    } catch {
      throw new Error(FTP_PREFIX + 'SECURE_OPTIONS を JSON として読めません。');
    }
  }
  return {
    host: env[FTP_PREFIX + 'HOST'],
    port,
    user: env[FTP_PREFIX + 'USER'],
    password: env[FTP_PREFIX + 'PASSWORD'],
    secure,
    remoteRoot: env[FTP_PREFIX + 'REMOTE_ROOT'],
    secureOptions,
  };
}

function loadConfig(configPath = path.join(ROOT, 'tools', 'deploy.config.json'), env = process.env) {
  if (fs.existsSync(configPath)) {
    const configText = fs.readFileSync(configPath, 'utf8');
    let config;
    try {
      config = JSON.parse(configText);
    } catch {
      throw new Error('tools/deploy.config.json の JSON 構文が正しくありません。');
    }
    const merged = {
      host: config.host,
      port: config.port ?? 21,
      user: config.user,
      password: config.password,
      secure: config.secure !== false,
      remoteRoot: config.remoteRoot,
      secureOptions: config.secureOptions ?? undefined,
    };
    if (merged.host && merged.user && merged.password && merged.remoteRoot) return merged;
  }
  return buildConfigFromEnv(env);
}

function remoteRootOf(config) {
  const root = String(config.remoteRoot ?? '').replaceAll('\\', '/').replace(/\/+/g, '/').replace(/\/$/, '');
  if (!root.startsWith('/') || root === '/' || root.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('remoteRoot はルートからの絶対パスで指定してください。');
  }
  return root;
}

async function listCurrentDirectory(client) {
  const entries = await client.list();
  return new Map(entries.map(entry => [entry.name, entry]));
}

async function replaceRemoteFile(client, temporaryName, finalName, finalExists) {
  try {
    await client.rename(temporaryName, finalName);
    return;
  } catch (renameError) {
    if (!finalExists) throw renameError;
  }

  const previousName = finalName + '.previous';
  try { await client.remove(previousName); } catch {}
  await client.rename(finalName, previousName);
  try {
    await client.rename(temporaryName, finalName);
  } catch (error) {
    try {
      await client.rename(previousName, finalName);
    } catch (restoreError) {
      throw new Error(finalName + ' を置き換えられず、元のファイルも戻せませんでした: ' + restoreError.message);
    }
    throw new Error(finalName + ' を置き換えられなかったため、元のファイルへ戻しました: ' + error.message);
  }
  try { await client.remove(previousName); } catch {}
}

async function uploadRemoteItem(client, item) {
  const temporaryName = item.remoteName + '.uploading';
  await client.uploadFrom(item.localPath, temporaryName);
  const entries = await listCurrentDirectory(client);
  if (entries.get(temporaryName)?.size !== item.localSize) {
    throw new Error(temporaryName + ' のサイズがローカルと一致しないため公開しません。');
  }
  await replaceRemoteFile(client, temporaryName, item.remoteName, entries.has(item.remoteName));
}

// 421 は FTP サーバーが制御接続を閉じる前に返す応答で、ソケットの終了より先に届くことがある。
function isFtpConnectionLost(client, error) {
  return client.closed === true || FTP_CONNECTION_LOST_CODES.has(error?.code) || error?.code === FTP_CLOSING_REPLY_CODE;
}

// 置き換えの途中で切れると公開名が退避名のまま残るので、送り直す前に公開名へ戻す。
async function restorePreviousName(client, item) {
  const entries = await listCurrentDirectory(client);
  const previousName = item.remoteName + '.previous';
  if (entries.has(item.remoteName) || !entries.has(previousName)) return;
  await client.rename(previousName, item.remoteName);
  console.warn('警告: ' + item.label + ' を退避名 ' + previousName + ' から公開名へ戻しました');
}

async function uploadSite(items, config, dependencies = {}) {
  const remoteRoot = remoteRootOf(config);
  const createClient = dependencies.createClient
    ?? (dependencies.client ? () => dependencies.client : () => new (dependencies.Client ?? require('basic-ftp').Client)(30_000));
  const pauseBeforeReconnect = dependencies.pauseBeforeReconnect ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const accessOptions = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    secure: config.secure,
  };
  if (config.secureOptions) accessOptions.secureOptions = config.secureOptions;

  let client = createClient();
  const enterItemDirectory = async item => {
    await client.cd('/');
    await client.ensureDir(remoteRoot);
    if (item.remoteSubDir) await client.ensureDir(item.remoteSubDir);
  };

  try {
    await client.access(accessOptions);
    await client.cd('/');
    await client.ensureDir(remoteRoot);
    for (const item of items) {
      item.remoteName = path.basename(item.localPath);
      item.localSize = fs.statSync(item.localPath).size;
      for (let attempt = 1; ; attempt += 1) {
        try {
          if (attempt > 1) {
            await pauseBeforeReconnect(UPLOAD_RECONNECT_DELAY_MS);
            client.close();
            client = createClient();
            await client.access(accessOptions);
            await enterItemDirectory(item);
            await restorePreviousName(client, item);
          } else if (item.remoteSubDir) {
            await client.ensureDir(item.remoteSubDir);
          }
          await uploadRemoteItem(client, item);
          if (item.remoteSubDir || attempt > 1) {
            await client.cd('/');
            await client.ensureDir(remoteRoot);
          }
          break;
        } catch (error) {
          // サーバーは多くのファイルを送る途中で接続を切ることがある。切れたらつなぎ直し、そのファイルから送り直す。
          if (!isFtpConnectionLost(client, error)) throw error;
          if (attempt >= UPLOAD_ATTEMPTS_PER_ITEM) {
            throw new Error(item.label + ' の送信中に FTP の接続が ' + attempt + ' 回切れたので止めます。'
              + 'もう一度実行すると、最初から送り直します (' + error.message + ')');
          }
          console.warn('警告: ' + item.label + ' の送信中に FTP の接続が切れたので、つなぎ直して送り直します (' + error.message + ')');
        }
      }
      console.log('  送信しました: ' + item.label);
    }
  } finally {
    client.close();
  }
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

function parseArgs(argv) {
  const command = argv[0];
  const options = {};
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--dry-run') {
      options.dryRun = true;
      continue;
    }
    const key = VALUE_OPTIONS.get(arg);
    if (!key) throw new Error('不明な引数です: ' + arg);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(arg + ' の値がありません。');
    options[key] = value;
    index += 1;
  }
  return { command, ...options };
}

function printUsage() {
  console.log([
    '使い方:',
    '  node tools/site-deploy.js upload [--dry-run] [--config <path>] [--version vX.Y.Z]',
  ].join('\n'));
}

// --version が無いときは origin の最新の版タグを使う。版タグが 1 つも無いときは空にする。
function siteVersion(opt, dependencies) {
  if (opt.version !== undefined) {
    if (!isReleaseTag(opt.version)) throw new Error('--version は v1.2.3 の形式で指定してください: ' + opt.version);
    return opt.version;
  }
  const latest = latestReleaseTag(dependencies);
  if (latest === null) {
    console.warn('警告: origin に版タグが無いため、紹介ページの版は空のまま送ります。');
    return '';
  }
  return latest;
}

function embedSiteVersion(html, version) {
  const count = [...html.matchAll(SITE_VERSION_ELEMENT)].length;
  if (count !== 1) {
    throw new Error('紹介ページの data-site-version の要素がちょうど 1 個ではありません (' + count + ' 個)');
  }
  return html.replace(SITE_VERSION_ELEMENT, (_, tag, attributes) => '<' + tag + attributes + '>' + version + '</' + tag + '>');
}

async function cmdUpload(opt, dependencies = {}) {
  const items = siteItems(dependencies.siteDir ?? SITE_DIR, dependencies.manualDir ?? MANUAL_DIR);
  checkReferences(items);
  const version = siteVersion(opt, dependencies);
  const index = items.find(item => item.label === 'index.html');
  const indexHtml = embedSiteVersion(fs.readFileSync(index.localPath, 'utf8'), version);

  if (opt.dryRun) {
    let remoteRoot = null;
    let configProblem = null;
    try {
      remoteRoot = remoteRootOf(loadConfig(opt.config, dependencies.env ?? process.env));
    } catch (error) {
      configProblem = error.message;
    }
    console.log('埋め込む紹介ページの版: ' + (version || '(版のタグが無いため空)'));
    console.log('FTPS 送信計画 (remoteRoot: ' + (remoteRoot ?? '(未設定)') + '):');
    for (const item of items) {
      const size = item === index ? Buffer.byteLength(indexHtml) : fs.statSync(item.localPath).size;
      const remotePath = remoteRoot ? path.posix.join(remoteRoot, item.label) : '(remoteRoot 未設定)/' + item.label;
      console.log('  ' + remotePath + ' (' + formatSize(size) + ')');
    }
    if (configProblem) {
      console.log('要確認: tools/deploy.config.json か AGENT_COCKPIT_FTP_* の環境変数で FTPS の接続情報を用意してください: ' + configProblem);
    }
    console.log('--dry-run のため、FTPS サーバへ接続しません。');
    return { dryRun: true, items, configProblem };
  }

  const config = dependencies.config ?? loadConfig(opt.config, dependencies.env ?? process.env);
  // uploadSite は送るファイル名を localPath の basename から決めるため、一時ファイルも index.html という名前で作る。
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-site-'));
  try {
    const indexPath = path.join(temporaryDirectory, 'index.html');
    fs.writeFileSync(indexPath, indexHtml);
    const sendItems = items.map(item => (item === index ? { ...item, localPath: indexPath } : item));
    await uploadSite(sendItems, config, dependencies);
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
  return { dryRun: false, items };
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  let opt;
  try {
    opt = parseArgs(argv);
  } catch (error) {
    printUsage();
    throw error;
  }
  if (opt.command !== 'upload') {
    printUsage();
    process.exitCode = 1;
    return;
  }
  const result = await cmdUpload(opt, dependencies);
  if (result.configProblem) process.exitCode = 1;
  return result;
}

if (require.main === module) {
  main().catch(error => {
    console.error('[site-deploy] ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  buildConfigFromEnv,
  checkReferences,
  cmdUpload,
  formatSize,
  isFtpConnectionLost,
  listCurrentDirectory,
  loadConfig,
  main,
  parseArgs,
  remoteRootOf,
  replaceRemoteFile,
  siteItems,
  uploadRemoteItem,
  uploadSite,
};
