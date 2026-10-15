'use strict';

const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RELEASE_BRANCH = 'main';
const RELEASE_TAG_PATTERN = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const VERSION_FILES = ['package.json', 'package-lock.json'];
const STEP_ORDER = ['test', 'bump', 'push-commit', 'tag', 'push-tag'];

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

// site-deploy.js が紹介ページに入れる版にも使う。origin の正式な版タグの最大を返し、無ければ null を返す。
function latestReleaseTag(dependencies = {}) {
  const git = gitRunner(dependencies);
  return latestOf(remoteTagCommits(git(['ls-remote', '--tags', 'origin'])).keys());
}

// `1.2.3` と `v1.2.3` を受け、版 `X.Y.Z` とタグ `vX.Y.Z` に正規化する。
function parseVersion(input) {
  const text = String(input ?? '');
  const tag = text.startsWith('v') ? text : 'v' + text;
  if (!isReleaseTag(tag)) throw new Error('バージョンは 1.2.3 または v1.2.3 の形式で指定してください: ' + text);
  return { version: tag.slice(1), tag };
}

function fileOperations(dependencies) {
  return {
    read: dependencies.readFile ?? (file => fs.readFileSync(file, 'utf8')),
    write: dependencies.writeFile ?? ((file, text) => fs.writeFileSync(file, text)),
  };
}

function packageVersion(dependencies) {
  const { read } = fileOperations(dependencies);
  return JSON.parse(read(path.join(ROOT, 'package.json'))).version;
}

// 版の更新は package.json と package-lock.json だけを変える。コミットがほかのファイルを含まないことを再実行の判定が頼りにする。
function rewriteVersion(text, version, isLockfile) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const json = JSON.parse(text);
  json.version = version;
  if (isLockfile && json.packages?.['']) json.packages[''].version = version;
  const body = JSON.stringify(json, null, 2).replace(/\n/g, eol);
  return /\r?\n$/.test(text) ? body + eol : body;
}

function updateVersionFiles(version, dependencies) {
  const { read, write } = fileOperations(dependencies);
  const updates = VERSION_FILES.map(name => {
    const file = path.join(ROOT, name);
    return { file, text: rewriteVersion(read(file), version, name === 'package-lock.json') };
  });
  for (const { file, text } of updates) write(file, text);
}

function npmCliPath() {
  const candidates = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  const found = candidates.find(candidate => candidate && /npm-cli\.js$/.test(candidate) && fs.existsSync(candidate));
  if (!found) throw new Error('npm の cli (npm-cli.js) が見つかりません。');
  return found;
}

// Windows の npm.cmd は shell: false で起動できないため、node から npm の cli を直接実行する。
function runNpmTest() {
  const result = childProcess.spawnSync(process.execPath, [npmCliPath(), 'test'], {
    cwd: ROOT,
    shell: false,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw new Error('npm test を起動できませんでした: ' + result.error.message);
  if (result.status !== 0) throw new Error('npm test が失敗しました (終了コード ' + result.status + ')。');
}

function withoutVersion(text) {
  const json = JSON.parse(text);
  delete json.version;
  if (json.packages?.['']) delete json.packages[''].version;
  return JSON.stringify(json);
}

// 未 push のコミットは、版の項目だけを変えたときに限って受け付ける。scripts や依存の変更が混ざったコミットを版の更新として push しないため。
function isVersionCommit(git, originMain) {
  const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']).trim().split(/\s+/).slice(1);
  if (parents.length !== 1 || parents[0] !== originMain) return false;
  const files = git(['diff', '--name-only', originMain, 'HEAD']).split(/\r?\n/).filter(Boolean);
  if (files.length === 0 || !files.every(file => VERSION_FILES.includes(file))) return false;
  return files.every(file => {
    try {
      return withoutVersion(git(['show', originMain + ':' + file])) === withoutVersion(git(['show', 'HEAD:' + file]));
    } catch {
      return false;
    }
  });
}

// plan と run が同じ判定で、今の状態から残りの手順を求める。済んだ手順は状態から読み取り、記録は持たない。
function inspectRelease(input, dependencies = {}) {
  const { version, tag } = parseVersion(input);
  const git = gitRunner(dependencies);

  const branch = git(['branch', '--show-current']).trim();
  if (branch !== RELEASE_BRANCH) {
    throw new Error('main ブランチで実行してください。現在のブランチは ' + (branch || '(detached)') + ' です。');
  }
  if (git(['status', '--porcelain', '--untracked-files=normal']).trim() !== '') {
    throw new Error('コミットしていない変更があります。コミットするか破棄してから実行してください。');
  }
  git(['fetch', '--quiet', '--tags', 'origin']);
  const head = git(['rev-parse', 'HEAD']).trim();
  const originMain = git(['rev-parse', 'origin/main']).trim();
  const current = packageVersion(dependencies);
  if (!isReleaseTag('v' + current)) throw new Error('package.json の version が X.Y.Z の形式ではありません: ' + current);

  const remoteCommits = remoteTagCommits(git(['ls-remote', '--tags', 'origin']));
  const latest = latestOf(remoteCommits.keys());
  const remoteCommit = remoteCommits.get(tag);
  const atOrBelowLatest = latest !== null && compareReleaseTags(tag, latest) <= 0;
  const localTag = git(['tag', '--list', tag]).trim() !== '';
  const localCommit = localTag ? git(['rev-list', '-n', '1', tag]).trim() : null;

  if (current !== version) {
    if (head !== originMain) {
      throw new Error('HEAD が origin/main と同じコミットではありません。main を pull してから実行してください。');
    }
    if (atOrBelowLatest) {
      throw new Error(tag + ' は origin の最新のバージョン ' + latest + ' 以下です。' + latest + ' より新しいバージョンにしてください。');
    }
    if (compareReleaseTags(tag, 'v' + current) <= 0) {
      throw new Error(tag + ' は package.json の現在のバージョン ' + current + ' 以下です。' + current + ' より新しいバージョンにしてください。');
    }
    if (localTag) {
      throw new Error('ローカルに ' + tag + ' があります。git tag -d ' + tag + ' で消してから実行してください。');
    }
    return { version, tag, head, steps: STEP_ORDER.slice() };
  }

  const versionCommitPending = head !== originMain;
  if (versionCommitPending && !isVersionCommit(git, originMain)) {
    throw new Error('HEAD が origin/main と一致せず、バージョンを上げるコミットでもありません。origin/main と同じコミットにしてから実行してください。');
  }
  const remoteAtHead = remoteCommit === head;
  if (remoteCommit !== undefined && !remoteAtHead) {
    throw new Error('origin の ' + tag + ' は HEAD と別のコミットを指しています。バージョン番号を上げてから実行してください。');
  }
  if (!remoteAtHead && atOrBelowLatest) {
    throw new Error(tag + ' は origin の最新のバージョン ' + latest + ' 以下です。' + latest + ' より新しいバージョンにしてください。');
  }
  if (!remoteAtHead && localTag && localCommit !== head) {
    throw new Error('ローカルの ' + tag + ' は HEAD 以外を指しています。git tag -d ' + tag + ' で消してから実行してください。');
  }

  // 未 push のコミットを誰が作ったかは git の状態から分からないので、タグを作る前は常に test を流す。
  const steps = [];
  if (!remoteAtHead && !localTag) steps.push('test');
  if (versionCommitPending) steps.push('push-commit');
  if (!remoteAtHead && !localTag) steps.push('tag');
  if (!remoteAtHead) steps.push('push-tag');
  return { version, tag, head, steps };
}

function describeStep(step, { version, tag }) {
  switch (step) {
    case 'test': return 'npm test';
    case 'bump': return 'package.json と package-lock.json を ' + version + ' にしてコミット';
    case 'push-commit': return 'main を origin へ push';
    case 'tag': return tag + ' の注釈つきタグを作成';
    case 'push-tag': return tag + ' を origin へ push';
    default: throw new Error('未知の手順です: ' + step);
  }
}

function executeStep(step, { version, tag }, dependencies) {
  const git = gitRunner(dependencies);
  switch (step) {
    case 'test':
      (dependencies.runNpmTest ?? runNpmTest)();
      return;
    case 'bump':
      // コミットまで済まなければ版のファイルを戻す。書き換えたまま残すと、再実行が未コミットの変更で止まるため。
      try {
        updateVersionFiles(version, dependencies);
        git(['add', ...VERSION_FILES]);
        git(['commit', '-m', 'chore(release): バージョンを ' + version + ' に上げる']);
      } catch (error) {
        try {
          git(['reset', '--quiet', 'HEAD', '--', ...VERSION_FILES]);
          git(['checkout', '--', ...VERSION_FILES]);
        } catch (restoreError) {
          throw new Error(error.message + ' バージョンを書いたファイルも戻せませんでした: ' + restoreError.message);
        }
        throw error;
      }
      return;
    case 'push-commit':
      git(['push', 'origin', RELEASE_BRANCH]);
      return;
    case 'tag':
      git(['tag', '-a', tag, '-m', tag]);
      return;
    case 'push-tag':
      git(['push', 'origin', tag]);
      return;
    default:
      throw new Error('未知の手順です: ' + step);
  }
}

function hasUpdateNotes(tag, dependencies) {
  const { read } = fileOperations(dependencies);
  const headings = read(path.join(ROOT, 'docs', 'update.md')).split(/\r?\n/);
  return headings.some(line => /^#{2,6}\s+/.test(line) && line.replace(/^#+\s+/, '').trim().split(/\s/)[0] === tag);
}

function planRelease(input, dependencies = {}) {
  const log = dependencies.log ?? console.log;
  const state = inspectRelease(input, dependencies);
  if (state.steps.length === 0) {
    log('[release] ' + state.tag + ' のタグは origin に作成済みです。残りは紹介ページの配信だけです。');
  } else {
    log('[release] ' + state.tag + ' のリリースで行う手順:');
  }
  const lines = [...state.steps.map(step => describeStep(step, state)), '紹介ページを配信'];
  lines.forEach((line, index) => log('  ' + (index + 1) + '. ' + line));
  if (!hasUpdateNotes(state.tag, dependencies)) {
    log('[release] 利用者に追加の作業が要るバージョンなら、先に docs/update.md の「バージョンごとの追加作業」に手順を書いてください。');
  }
  return state;
}

// 手順の直前に状態を求め直し、予定した手順がまだ残っているときだけ実行する。plan の後に状態が変わっていても、済んだ手順を繰り返さないため。
function runRelease(input, dependencies = {}) {
  const log = dependencies.log ?? console.log;
  const planned = inspectRelease(input, dependencies);
  planned.steps.forEach((step, index) => {
    const fresh = inspectRelease(input, dependencies);
    if (!fresh.steps.includes(step)) {
      throw new Error('状態が変わったため止めます。もう一度 plan を確かめてください。手順: ' + describeStep(step, fresh));
    }
    log('[release] (' + (index + 1) + '/' + planned.steps.length + ') ' + describeStep(step, fresh));
    executeStep(step, fresh, dependencies);
  });
  log('[release] ' + planned.tag + ' の手順が済みました。');
  return planned;
}

async function reportRelease(input, dependencies = {}) {
  const log = dependencies.log ?? console.log;
  try {
    const { version, tag } = parseVersion(input);
    log(`公開したバージョン: ${tag}`);
    const { cockpitHomeFromOptions } = require('../src/server/identity');
    const { readServerInfo, requestFromServer } = require('../src/client/server-connection');
    const info = await (dependencies.readServerInfo ?? readServerInfo)(cockpitHomeFromOptions(dependencies));
    const response = await requestFromServer(info, '/health', { method: 'GET' }, { fetchImpl: dependencies.fetchImpl });
    const health = response.json;
    if (!response.ok || health?.app !== 'agent-cockpit' || health.pid !== info.pid || health.startedAt !== info.startedAt) {
      log('手元の常駐サーバーは動いていません。');
      return;
    }
    const commit = gitRunner(dependencies)(['rev-parse', `${tag}^{commit}`]).trim();
    if (health.version === version && health.commit === commit) log('手元の常駐サーバーは、公開したバージョンで動いています。');
    else log(`手元の常駐サーバーはバージョン ${health.version ?? '不明'} で動いています。公開したバージョンで動かすには、常駐サーバーを再起動してください。`);
  } catch (error) {
    log('公開したバージョンと手元の常駐サーバーを照合できませんでした: ' + error.message);
  }
}

function printUsage() {
  console.error('使い方: node tools/release.js plan|run|report <X.Y.Z または vX.Y.Z>');
}

async function main(argv = process.argv.slice(2), dependencies = {}) {
  const [command, input, ...rest] = argv;
  if (!['plan', 'run', 'report'].includes(command) || input === undefined || rest.length) {
    printUsage();
    process.exitCode = 1;
    return;
  }
  if (command === 'report') return reportRelease(input, dependencies);
  return command === 'plan' ? planRelease(input, dependencies) : runRelease(input, dependencies);
}

if (require.main === module) {
  main().catch(error => {
    console.error('[release] ' + error.message);
    process.exitCode = 1;
  });
}

module.exports = {
  compareReleaseTags,
  inspectRelease,
  isReleaseTag,
  latestReleaseTag,
  main,
  parseVersion,
  planRelease,
  remoteTagCommits,
  rewriteVersion,
  runRelease,
  reportRelease,
};
