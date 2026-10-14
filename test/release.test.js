const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  inspectRelease,
  latestReleaseTag,
  parseVersion,
  planRelease,
  rewriteVersion,
  runRelease,
} = require('../tools/release');

const HEAD = 'a'.repeat(40);
const OTHER = 'b'.repeat(40);
const TAG_OBJECT = 'c'.repeat(40);
const RELEASE_COMMIT = 'd'.repeat(40);

const PACKAGE_JSON = '{\r\n  "name": "demo",\r\n  "version": "1.0.1",\r\n  "private": true\r\n}\r\n';
const PACKAGE_LOCK = '{\r\n  "name": "demo",\r\n  "version": "1.0.1",\r\n  "lockfileVersion": 3,\r\n'
  + '  "packages": {\r\n    "": {\r\n      "name": "demo",\r\n      "version": "1.0.1"\r\n    },\r\n'
  + '    "node_modules/dep": {\r\n      "version": "1.0.1"\r\n    }\r\n  }\r\n}\r\n';
const UPDATE_DOC = '## 版ごとの追加作業\n\n今はありません。\n';

// git、npm、ファイルを偽物に差し替えた作業ツリー。呼び出しを記録し、状態を実際の git と同じように進める。
function fakeRepository(overrides = {}) {
  const repo = {
    branch: 'main',
    dirty: false,
    head: HEAD,
    originMain: HEAD,
    parents: [OTHER],
    changedFiles: ['package.json', 'package-lock.json'],
    localTags: {},
    remoteTags: {},
    remoteLines: null,
    files: {
      'package.json': PACKAGE_JSON,
      'package-lock.json': PACKAGE_LOCK,
      'update.md': UPDATE_DOC,
    },
    calls: [],
    testFails: false,
    ...overrides,
  };
  const log = [];
  const execFileSync = (file, args) => {
    const key = args.join(' ');
    repo.calls.push(key);
    switch (args[0]) {
      case 'branch': return repo.branch + '\n';
      case 'status': return repo.dirty ? ' M package.json\n' : '';
      case 'fetch': return '';
      case 'rev-parse': return (args[1] === 'HEAD' ? repo.head : repo.originMain) + '\n';
      case 'ls-remote':
        return repo.remoteLines ?? Object.entries(repo.remoteTags).map(([tag, sha]) => `${sha}\trefs/tags/${tag}\n`).join('');
      case 'tag':
        if (args[1] === '--list') return Object.hasOwn(repo.localTags, args[2]) ? args[2] + '\n' : '';
        repo.localTags[args[2]] = repo.head;
        return '';
      case 'rev-list':
        if (args[1] === '--parents') return [repo.head, ...repo.parents].join(' ') + '\n';
        return repo.localTags[args[3]] + '\n';
      case 'diff': return repo.changedFiles.join('\n') + '\n';
      case 'add': return '';
      case 'commit':
        repo.parents = [repo.head];
        repo.head = RELEASE_COMMIT;
        return '';
      case 'push':
        if (args[2] === 'main') repo.originMain = repo.head;
        else repo.remoteTags[args[2]] = repo.head;
        return '';
      default: throw new Error('予定外の git の呼び出しです: ' + key);
    }
  };
  const dependencies = {
    execFileSync,
    log: message => log.push(message),
    readFile: file => repo.files[path.basename(file)],
    writeFile: (file, text) => {
      repo.calls.push('write ' + path.basename(file));
      repo.files[path.basename(file)] = text;
    },
    runNpmTest: () => {
      repo.calls.push('npm test');
      if (repo.testFails) throw new Error('npm test が失敗しました (終了コード 1)。');
    },
  };
  return { repo, dependencies, log };
}

// 版を手で上げた main を表す。
function handBumped() {
  return fakeRepository({
    files: {
      'package.json': PACKAGE_JSON.replace('1.0.1', '1.0.2'),
      'package-lock.json': PACKAGE_LOCK.replaceAll('1.0.1', '1.0.2'),
      'update.md': UPDATE_DOC,
    },
  });
}

test('版は 1.0.2 と v1.0.2 の両方を受け、X.Y.Z とタグに正規化する', () => {
  assert.deepEqual(parseVersion('1.0.2'), { version: '1.0.2', tag: 'v1.0.2' });
  assert.deepEqual(parseVersion('v1.0.2'), { version: '1.0.2', tag: 'v1.0.2' });
});

test('形式に合わない版は、git を呼ばずに拒否する', () => {
  for (const input of ['1.0', 'v1.0', '01.0.1', '1.0.1-rc.1', 'vv1.0.1', '', undefined]) {
    const { repo, dependencies } = fakeRepository();
    assert.throws(() => inspectRelease(input, dependencies), /1\.2\.3 または v1\.2\.3 の形式/);
    assert.deepEqual(repo.calls, []);
  }
});

test('main 以外のブランチでは、手順を求めずに拒否する', () => {
  const { dependencies } = fakeRepository({ branch: 'claude/release-script' });
  assert.throws(() => inspectRelease('1.0.2', dependencies), /main ブランチで実行してください。現在のブランチは claude\/release-script です/);
});

test('コミットしていない変更があれば拒否する', () => {
  const { dependencies } = fakeRepository({ dirty: true });
  assert.throws(() => inspectRelease('1.0.2', dependencies), /コミットしていない変更があります/);
});

test('新規のリリースで HEAD が origin/main と違えば拒否する', () => {
  const { dependencies } = fakeRepository({ originMain: OTHER });
  assert.throws(() => inspectRelease('1.0.2', dependencies), /origin\/main と同じコミットではありません/);
});

test('origin の最新の版以下の版は拒否する', () => {
  const { dependencies } = fakeRepository({ remoteTags: { 'v1.0.5': OTHER } });
  assert.throws(() => inspectRelease('1.0.4', dependencies), /最新の版 v1\.0\.5 以下です/);
});

test('package.json の現在の版以下の版は拒否する', () => {
  const { dependencies } = fakeRepository();
  assert.throws(() => inspectRelease('1.0.0', dependencies), /現在の版 1\.0\.1 以下です/);
});

test('版の大小は 3 つの整数で比べ、1.0.10 は 1.0.9 より新しいと扱う', () => {
  const { dependencies } = fakeRepository({ remoteTags: { 'v1.0.9': OTHER } });
  assert.equal(inspectRelease('1.0.10', dependencies).tag, 'v1.0.10');
  assert.throws(() => inspectRelease('1.0.9', fakeRepository({ remoteTags: { 'v1.0.10': OTHER } }).dependencies), /最新の版 v1\.0\.10 以下です/);
});

test('新規のリリースでは全手順が残り、run が test、bump、commit、push main、tag、push tag の順に呼ぶ', () => {
  const { repo, dependencies } = fakeRepository();

  assert.deepEqual(inspectRelease('v1.0.2', dependencies).steps, ['test', 'bump', 'push-commit', 'tag', 'push-tag']);
  repo.calls.length = 0;
  runRelease('1.0.2', dependencies);

  const mutations = repo.calls.filter(call => /^(npm test|write |add |commit |push |tag -a)/.test(call));
  assert.deepEqual(mutations, [
    'npm test',
    'write package.json',
    'write package-lock.json',
    'add package.json package-lock.json',
    'commit -m chore(release): 版を 1.0.2 に上げる',
    'push origin main',
    'tag -a v1.0.2 -m v1.0.2',
    'push origin v1.0.2',
  ]);
  assert.equal(repo.remoteTags['v1.0.2'], RELEASE_COMMIT);
});

test('test が失敗したら、bump 以降を呼ばない', () => {
  const { repo, dependencies } = fakeRepository({ testFails: true });

  assert.throws(() => runRelease('1.0.2', dependencies), /npm test が失敗しました/);

  assert.equal(repo.calls.some(call => call.startsWith('write ') || call.startsWith('commit') || call.startsWith('push')), false);
});

test('bump は version だけを変え、元の改行コードとインデントと末尾の改行を保つ', () => {
  const { repo, dependencies } = fakeRepository();

  runRelease('1.0.2', dependencies);

  assert.equal(repo.files['package.json'], PACKAGE_JSON.replace('1.0.1', '1.0.2'));
  assert.equal(
    repo.files['package-lock.json'],
    PACKAGE_LOCK.replace('"version": "1.0.1",\r\n  "lockfileVersion"', '"version": "1.0.2",\r\n  "lockfileVersion"')
      .replace('"name": "demo",\r\n      "version": "1.0.1"', '"name": "demo",\r\n      "version": "1.0.2"'),
  );
});

test('LF の package.json は LF のまま、末尾の改行が無ければ無いまま書き直す', () => {
  assert.equal(rewriteVersion('{\n  "version": "1.0.1"\n}\n', '1.0.2', false), '{\n  "version": "1.0.2"\n}\n');
  assert.equal(rewriteVersion('{\n  "version": "1.0.1"\n}', '1.0.2', false), '{\n  "version": "1.0.2"\n}');
});

test('版のコミットだけが未 push の再実行では、push-commit 以降だけが残る', () => {
  const { repo, dependencies } = fakeRepository({
    head: RELEASE_COMMIT,
    originMain: HEAD,
    parents: [HEAD],
    files: {
      'package.json': PACKAGE_JSON.replace('1.0.1', '1.0.2'),
      'package-lock.json': PACKAGE_LOCK.replaceAll('1.0.1', '1.0.2'),
      'update.md': UPDATE_DOC,
    },
  });

  assert.deepEqual(inspectRelease('1.0.2', dependencies).steps, ['push-commit', 'tag', 'push-tag']);
  runRelease('1.0.2', dependencies);
  assert.equal(repo.originMain, RELEASE_COMMIT);
  assert.equal(repo.remoteTags['v1.0.2'], RELEASE_COMMIT);
});

test('未 push のコミットが版の更新以外のファイルを含めば拒否する', () => {
  const { dependencies } = fakeRepository({
    head: RELEASE_COMMIT,
    parents: [HEAD],
    changedFiles: ['package.json', 'src/server.js'],
    files: { 'package.json': PACKAGE_JSON.replace('1.0.1', '1.0.2'), 'update.md': UPDATE_DOC },
  });
  assert.throws(() => inspectRelease('1.0.2', dependencies), /版を上げるコミットでもありません/);
});

test('タグがローカルにだけある再実行では、push-tag だけが残る', () => {
  const { repo, dependencies } = handBumped();
  repo.localTags['v1.0.2'] = HEAD;

  assert.deepEqual(inspectRelease('1.0.2', dependencies).steps, ['push-tag']);
});

test('すべて済んだ再実行では、残りの手順が無い', () => {
  const { repo, dependencies, log } = handBumped();
  repo.remoteTags['v1.0.2'] = HEAD;

  assert.deepEqual(planRelease('1.0.2', dependencies).steps, []);
  assert.match(log[0], /作成済みです。残りは紹介ページの配信だけ/);
  repo.calls.length = 0;
  runRelease('1.0.2', dependencies);
  assert.equal(repo.calls.some(call => call.startsWith('push') || call.startsWith('tag -a')), false);
});

test('注釈つきタグは、実体のコミットを見て済みと判定する', () => {
  const { repo, dependencies } = handBumped();
  repo.remoteLines = `${TAG_OBJECT}\trefs/tags/v1.0.2\n${HEAD}\trefs/tags/v1.0.2^{}\n`;

  assert.deepEqual(inspectRelease('1.0.2', dependencies).steps, []);
});

test('版を手で上げた main では、test、tag、push-tag が残る', () => {
  const { dependencies } = handBumped();

  assert.deepEqual(inspectRelease('1.0.2', dependencies).steps, ['test', 'tag', 'push-tag']);
});

test('origin の同名タグが HEAD 以外を指せば拒否する', () => {
  const { repo, dependencies } = handBumped();
  repo.remoteTags['v1.0.2'] = OTHER;

  assert.throws(() => inspectRelease('1.0.2', dependencies), /HEAD と別のコミットを指しています/);
});

test('ローカルの同名タグが HEAD 以外を指せば拒否する', () => {
  const { repo, dependencies } = handBumped();
  repo.localTags['v1.0.2'] = OTHER;

  assert.throws(() => inspectRelease('1.0.2', dependencies), /ローカルの v1\.0\.2 は HEAD 以外を指しています/);
});

test('plan は残りの手順を番号つきで表示し、更新手順の節が無い版では追加作業の案内を出す', () => {
  const { dependencies, log } = fakeRepository();

  planRelease('1.0.2', dependencies);

  assert.deepEqual(log, [
    '[release] v1.0.2 のリリースで行う手順:',
    '  1. npm test',
    '  2. package.json と package-lock.json を 1.0.2 にしてコミット',
    '  3. main を origin へ push',
    '  4. v1.0.2 の注釈つきタグを作成',
    '  5. v1.0.2 を origin へ push',
    '  6. 紹介ページを配信',
    '[release] 利用者に追加の作業が要る版なら、先に docs/update.md の「版ごとの追加作業」に手順を書いてください。',
  ]);
});

test('docs/update.md に vX.Y.Z の節があれば、追加作業の案内を出さない', () => {
  const { repo, dependencies, log } = fakeRepository();
  repo.files['update.md'] = UPDATE_DOC + '\n### v1.0.2\n\n手順。\n';

  planRelease('1.0.2', dependencies);

  assert.equal(log.some(line => line.includes('docs/update.md')), false);
});

test('run は plan の後に状態が変わって手順が済んでいたら、止まる', () => {
  const { repo, dependencies } = fakeRepository();
  let tests = 0;
  dependencies.runNpmTest = () => {
    tests += 1;
    repo.head = RELEASE_COMMIT;
    repo.originMain = RELEASE_COMMIT;
    repo.files['package.json'] = PACKAGE_JSON.replace('1.0.1', '1.0.2');
  };

  assert.throws(() => runRelease('1.0.2', dependencies), /状態が変わったため止めます/);
  assert.equal(tests, 1);
});

test('origin の版タグのうち最大の版を、注釈つきタグの実体を見て求める', () => {
  const { dependencies } = fakeRepository({
    remoteLines: [
      `${OTHER}\trefs/tags/v1.0.9`,
      `${TAG_OBJECT}\trefs/tags/v1.0.10`,
      `${HEAD}\trefs/tags/v1.0.10^{}`,
      `${OTHER}\trefs/tags/nightly`,
      `${OTHER}\trefs/tags/v2.0.0-rc1`,
    ].join('\n') + '\n',
  });

  assert.equal(latestReleaseTag(dependencies), 'v1.0.10');
});

test('origin に版タグが 1 つも無いときは、最新の版を無しとして返す', () => {
  const { dependencies } = fakeRepository({ remoteLines: `${OTHER}\trefs/tags/nightly\n` });

  assert.equal(latestReleaseTag(dependencies), null);
});
