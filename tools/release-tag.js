'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_BRANCH = 'main';
const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function isReleaseTag(value) {
  return typeof value === 'string' && RELEASE_TAG_PATTERN.test(value);
}

// 版は 3 つの整数で比べる。桁が増えても文字列の順にならないようにするため。
function compareReleaseTags(left, right) {
  const a = RELEASE_TAG_PATTERN.exec(left).slice(1).map(BigInt);
  const b = RELEASE_TAG_PATTERN.exec(right).slice(1).map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function latestOf(tags) {
  let latest = null;
  for (const tag of tags) {
    if (isReleaseTag(tag) && (latest === null || compareReleaseTags(tag, latest) > 0)) latest = tag;
  }
  return latest;
}

// 注釈つきタグは `^{}` の行が実体のコミットを指すので、そちらを優先する。
function remoteTagCommits(output) {
  const direct = new Map();
  const peeled = new Map();
  for (const line of String(output).split(/\r?\n/)) {
    const [sha, ref] = line.trim().split(/\s+/);
    const match = /^refs\/tags\/(.+?)(\^\{\})?$/.exec(ref ?? '');
    if (match) (match[2] ? peeled : direct).set(match[1], sha);
  }
  return new Map([...direct, ...peeled]);
}

function gitRunner(dependencies = {}) {
  const execFileSync = dependencies.execFileSync ?? childProcess.execFileSync;
  return args => {
    try {
      return execFileSync('git', args, {
        cwd: ROOT,
        encoding: 'utf8',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      throw new Error('git ' + args.join(' ') + ' が失敗しました: ' + String(error.stderr ?? error.message).trim());
    }
  };
}

function packageVersion(dependencies = {}) {
  const packageJsonPath = dependencies.packageJsonPath ?? path.join(ROOT, 'package.json');
  return JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')).version;
}

// deploy-site.bat と紹介ページの版の両方が使う。origin の正式な版タグの最大を返し、無ければ null を返す。
function latestReleaseTag(dependencies = {}) {
  const git = gitRunner(dependencies);
  return latestOf(remoteTagCommits(git(['ls-remote', '--tags', 'origin'])).keys());
}

function checkReleaseTag(tag, dependencies = {}) {
  if (!isReleaseTag(tag)) throw new Error('タグは v1.2.3 の形式で指定してください: ' + tag);
  const git = gitRunner(dependencies);

  const branch = git(['branch', '--show-current']).trim();
  if (branch !== RELEASE_BRANCH) {
    throw new Error('main ブランチで実行してください。現在のブランチは ' + (branch || '(detached)') + ' です。');
  }
  git(['fetch', '--quiet', 'origin']);
  const head = git(['rev-parse', 'HEAD']).trim();
  const originMain = git(['rev-parse', 'origin/main']).trim();
  if (head !== originMain) {
    throw new Error('HEAD が origin/main と同じコミットではありません。main を origin に push するか pull してから実行してください。');
  }

  const version = packageVersion(dependencies);
  if (version !== tag.slice(1)) {
    throw new Error('package.json の version は ' + version + ' です。' + tag.slice(1)
      + ' にしたコミットを main に入れてから実行してください。');
  }

  const remoteCommits = remoteTagCommits(git(['ls-remote', '--tags', 'origin']));
  const remoteCommit = remoteCommits.get(tag);
  const remoteAtHead = remoteCommit === head;
  if (remoteCommit !== undefined && !remoteAtHead) {
    throw new Error('origin の ' + tag + ' は HEAD と別のコミットを指しています。版の番号を上げてから実行してください。');
  }
  if (!remoteAtHead) {
    const latest = latestOf(remoteCommits.keys());
    if (latest !== null && compareReleaseTags(tag, latest) <= 0) {
      throw new Error(tag + ' は origin の最新の版 ' + latest + ' 以下です。' + latest + ' より新しい版の番号にしてください。');
    }
  }

  const localExists = git(['tag', '--list', tag]).trim() !== '';
  if (localExists) {
    const localCommit = git(['rev-list', '-n', '1', tag]).trim();
    if (localCommit !== head) {
      throw new Error('ローカルの ' + tag + ' は HEAD 以外を指しています。git tag -d ' + tag + ' で消してから実行してください。');
    }
  }
  return { tag, head, localExists, remoteAtHead };
}

// 作成と push は、途中で失敗しても同じタグで実行し直せるように、済んだ手順を飛ばす。
function createReleaseTag(tag, dependencies = {}) {
  const git = gitRunner(dependencies);
  const state = checkReleaseTag(tag, dependencies);
  if (!state.localExists) git(['tag', '-a', tag, '-m', tag]);
  if (!state.remoteAtHead) git(['push', 'origin', tag]);
  return state;
}

function printUsage() {
  console.error('使い方: node tools/release-tag.js check|create <vX.Y.Z>');
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const [command, tag, ...rest] = argv;
  if (!['check', 'create'].includes(command) || tag === undefined || rest.length) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (command === 'check') {
    const state = checkReleaseTag(tag, dependencies);
    console.log('[release-tag] ' + tag + ' を作成できます (' + state.head.slice(0, 7) + ')。');
    return state;
  }
  const state = createReleaseTag(tag, dependencies);
  if (state.remoteAtHead) console.log('[release-tag] ' + tag + ' は origin に作成済みのため、push を省略しました。');
  else console.log('[release-tag] ' + tag + ' を作成して origin へ push しました。');
  return state;
}

if (require.main === module) {
  main().catch(error => {
    console.error('[release-tag] ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  checkReleaseTag,
  compareReleaseTags,
  createReleaseTag,
  isReleaseTag,
  latestReleaseTag,
  main,
  remoteTagCommits,
};
