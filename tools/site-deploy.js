'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SITE_DIR = path.join(ROOT, 'site');
const FTP_PREFIX = 'AGENT_COCKPIT_FTP_';

function compareNames(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function siteItems(siteDir = SITE_DIR) {
  const assetsDir = path.join(siteDir, 'assets');
  const imagesDir = path.join(siteDir, 'img');
  const assetItems = fs.readdirSync(assetsDir, { withFileTypes: true })
    .filter(entry => entry.isFile())
    .map(entry => ({
      label: 'assets/' + entry.name,
      localPath: path.join(assetsDir, entry.name),
      remoteSubDir: 'assets',
    }))
    .sort((left, right) => compareNames(left.label, right.label));
  const imageItems = fs.readdirSync(imagesDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .sort((left, right) => compareNames(left.name, right.name))
    .flatMap(directory => fs.readdirSync(path.join(imagesDir, directory.name), { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.endsWith('.png'))
      .map(entry => ({
        label: 'img/' + directory.name + '/' + entry.name,
        localPath: path.join(imagesDir, directory.name, entry.name),
        remoteSubDir: 'img/' + directory.name,
      }))
      .sort((left, right) => compareNames(left.label, right.label)));

  return [
    ...assetItems,
    ...imageItems,
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

function checkReferences(items, siteDir = SITE_DIR) {
  const included = new Set(items.map(item => path.posix.normalize(item.label.replaceAll('\\', '/'))));
  const missing = [];

  for (const pageName of ['index.html', 'license.html']) {
    const html = fs.readFileSync(path.join(siteDir, pageName), 'utf8');
    const attributes = /\b(?:src|href)\s*=\s*(["'])(.*?)\1/gi;
    for (const match of html.matchAll(attributes)) {
      const reference = referencePath(match[2]);
      if (reference === null) continue;
      const target = path.posix.normalize(reference.startsWith('/') ? reference.slice(1) : reference);
      if (!included.has(target)) missing.push(pageName + ' -> ' + match[2]);
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

async function uploadSite(items, config, dependencies = {}) {
  const remoteRoot = remoteRootOf(config);
  const client = dependencies.client ?? new (dependencies.Client ?? require('basic-ftp').Client)(30_000);
  const accessOptions = {
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    secure: config.secure,
  };
  if (config.secureOptions) accessOptions.secureOptions = config.secureOptions;

  try {
    await client.access(accessOptions);
    await client.cd('/');
    await client.ensureDir(remoteRoot);
    for (const item of items) {
      item.remoteName = path.basename(item.localPath);
      item.localSize = fs.statSync(item.localPath).size;
      try {
        if (item.remoteSubDir) await client.ensureDir(item.remoteSubDir);
        await uploadRemoteItem(client, item);
      } finally {
        if (item.remoteSubDir) {
          await client.cd('/');
          await client.ensureDir(remoteRoot);
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
    if (arg !== '--config') throw new Error('不明な引数です: ' + arg);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(arg + ' の値がありません。');
    options.config = value;
    index += 1;
  }
  return { command, ...options };
}

function printUsage() {
  console.log([
    '使い方:',
    '  node tools/site-deploy.js upload [--dry-run] [--config <path>]',
  ].join('\n'));
}

async function cmdUpload(opt, dependencies = {}) {
  const siteDir = dependencies.siteDir ?? SITE_DIR;
  const items = siteItems(siteDir);
  checkReferences(items, siteDir);

  if (opt.dryRun) {
    let remoteRoot = null;
    let configProblem = null;
    try {
      remoteRoot = remoteRootOf(loadConfig(opt.config, dependencies.env ?? process.env));
    } catch (error) {
      configProblem = error.message;
    }
    console.log('FTPS 送信計画 (remoteRoot: ' + (remoteRoot ?? '(未設定)') + '):');
    for (const item of items) {
      const remotePath = remoteRoot ? path.posix.join(remoteRoot, item.label) : '(remoteRoot 未設定)/' + item.label;
      console.log('  ' + remotePath + ' (' + formatSize(fs.statSync(item.localPath).size) + ')');
    }
    if (configProblem) {
      console.log('要確認: tools/deploy.config.json か AGENT_COCKPIT_FTP_* の環境変数で FTPS の接続情報を用意してください: ' + configProblem);
    }
    console.log('--dry-run のため、FTPS サーバへ接続しません。');
    return { dryRun: true, items, configProblem };
  }

  const config = dependencies.config ?? loadConfig(opt.config, dependencies.env ?? process.env);
  await uploadSite(items, config, dependencies);
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
