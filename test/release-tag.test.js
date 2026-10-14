const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { temporaryDirectory } = require('./support/temp');
const {
  checkReleaseTag,
  createReleaseTag,
  latestReleaseTag,
} = require('../tools/release-tag');

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TAG_OBJECT = 'c'.repeat(40);

function packageJsonFixture(t, version) {
  const { directory } = temporaryDirectory(t);
  const packageJsonPath = path.join(directory, 'package.json');
  fs.writeFileSync(packageJsonPath, JSON.stringify({ version }));
  return packageJsonPath;
}

// 応答に無い git の呼び出しは失敗させ、想定しない手順を見つける。
function fakeGit(responses) {
  const calls = [];
  const execFileSync = (file, args) => {
    const key = args.join(' ');
    calls.push(key);
    if (!Object.hasOwn(responses, key)) throw new Error('予定外の git の呼び出しです: ' + key);
    return responses[key];
  };
  return { calls, execFileSync };
}

// 既定の応答は、main で HEAD が origin/main と同じ、origin にも手元にもタグが無い状態を表す。
function releaseResponses(tag, overrides = {}) {
  return {
    'branch --show-current': 'main\n',
    'fetch --quiet origin': '',
    'rev-parse HEAD': HEAD + '\n',
    'rev-parse origin/main': HEAD + '\n',
    'ls-remote --tags origin': '',
    ['tag --list ' + tag]: '',
    ['tag -a ' + tag + ' -m ' + tag]: '',
    ['push origin ' + tag]: '',
    ...overrides,
  };
}

function setup(t, tag, overrides = {}, version = tag.slice(1)) {
  const git = fakeGit(releaseResponses(tag, overrides));
  return { git, dependencies: { execFileSync: git.execFileSync, packageJsonPath: packageJsonFixture(t, version) } };
}

test('形式に合わないタグは、git を呼ばずに拒否する', t => {
  for (const tag of ['1.0.1', 'v1.0', 'v01.0.1', 'v1.0.1-rc.1']) {
    const { git, dependencies } = setup(t, 'v1.0.1');
    assert.throws(() => checkReleaseTag(tag, dependencies), /v1\.2\.3 の形式/);
    assert.deepEqual(git.calls, []);
  }
});

test('main 以外のブランチでは、タグの作成を拒否する', t => {
  const { dependencies } = setup(t, 'v1.0.1', { 'branch --show-current': 'feature/site\n' });
  assert.throws(() => checkReleaseTag('v1.0.1', dependencies), /main ブランチで実行してください/);
});

test('HEAD が origin/main と同じコミットでなければ、タグの作成を拒否する', t => {
  const { dependencies } = setup(t, 'v1.0.1', { 'rev-parse origin/main': OTHER + '\n' });
  assert.throws(() => checkReleaseTag('v1.0.1', dependencies), /origin\/main と同じコミットではありません/);
});

test('package.json の version がタグと違えば、タグの作成を拒否する', t => {
  const { dependencies } = setup(t, 'v1.0.1', {}, '1.0.0');
  assert.throws(() => checkReleaseTag('v1.0.1', dependencies), /package\.json の version は 1\.0\.0 です/);
});

test('origin の最新の版以下のタグは、作成を拒否する', t => {
  const { dependencies } = setup(t, 'v1.0.1', { 'ls-remote --tags origin': `${OTHER}\trefs/tags/v1.0.2\n` });
  assert.throws(() => checkReleaseTag('v1.0.1', dependencies), /最新の版 v1\.0\.2 以下です/);
});

test('版の大小は 3 つの整数で比べ、1.0.10 は 1.0.9 より新しいと扱う', t => {
  const { dependencies } = setup(t, 'v1.0.10', { 'ls-remote --tags origin': `${OTHER}\trefs/tags/v1.0.9\n` }, '1.0.10');
  assert.equal(checkReleaseTag('v1.0.10', dependencies).remoteAtHead, false);
});

test('origin に HEAD を指す同名タグがあれば、確認は合格し、作成も push もしない', t => {
  const remoteTag = `${TAG_OBJECT}\trefs/tags/v1.0.1\n${HEAD}\trefs/tags/v1.0.1^{}\n`;
  const { git, dependencies } = setup(t, 'v1.0.1', {
    'ls-remote --tags origin': remoteTag,
    'tag --list v1.0.1': 'v1.0.1\n',
    'rev-list -n 1 v1.0.1': HEAD + '\n',
  });

  const state = createReleaseTag('v1.0.1', dependencies);

  assert.equal(state.remoteAtHead, true);
  assert.equal(git.calls.some(call => call.startsWith('tag -a') || call.startsWith('push')), false);
});

test('origin に HEAD と別のコミットを指す同名タグがあれば、拒否する', t => {
  const { dependencies } = setup(t, 'v1.0.1', { 'ls-remote --tags origin': `${OTHER}\trefs/tags/v1.0.1\n` });
  assert.throws(() => checkReleaseTag('v1.0.1', dependencies), /HEAD と別のコミットを指しています/);
});

test('ローカルに HEAD 以外を指す同名タグがあれば、拒否する', t => {
  const { dependencies } = setup(t, 'v1.0.1', {
    'tag --list v1.0.1': 'v1.0.1\n',
    'rev-list -n 1 v1.0.1': OTHER + '\n',
  });
  assert.throws(() => checkReleaseTag('v1.0.1', dependencies), /HEAD 以外を指しています/);
});

test('create は、ローカルにタグを作ってから origin へ push する', t => {
  const { git, dependencies } = setup(t, 'v1.0.1');

  createReleaseTag('v1.0.1', dependencies);

  assert.deepEqual(git.calls.slice(-2), ['tag -a v1.0.1 -m v1.0.1', 'push origin v1.0.1']);
});

test('ローカルに HEAD を指すタグがあれば、作り直さずに push だけする', t => {
  const { git, dependencies } = setup(t, 'v1.0.1', {
    'tag --list v1.0.1': 'v1.0.1\n',
    'rev-list -n 1 v1.0.1': HEAD + '\n',
  });

  createReleaseTag('v1.0.1', dependencies);

  assert.equal(git.calls.some(call => call.startsWith('tag -a')), false);
  assert.equal(git.calls.at(-1), 'push origin v1.0.1');
});

test('origin の版タグのうち最大の版を、注釈つきタグの実体を見て求める', () => {
  const git = fakeGit({
    'ls-remote --tags origin': [
      `${OTHER}\trefs/tags/v1.0.9`,
      `${TAG_OBJECT}\trefs/tags/v1.0.10`,
      `${HEAD}\trefs/tags/v1.0.10^{}`,
      `${OTHER}\trefs/tags/nightly`,
      `${OTHER}\trefs/tags/v2.0.0-rc1`,
    ].join('\n') + '\n',
  });

  assert.equal(latestReleaseTag({ execFileSync: git.execFileSync }), 'v1.0.10');
});

test('origin に版タグが 1 つも無いときは、最新の版を無しとして返す', () => {
  const git = fakeGit({ 'ls-remote --tags origin': `${OTHER}\trefs/tags/nightly\n` });

  assert.equal(latestReleaseTag({ execFileSync: git.execFileSync }), null);
});
