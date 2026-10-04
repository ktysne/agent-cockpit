const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { buildManual } = require('../tools/manual/build');
const { lintManual } = require('../tools/manual/lint');

function writeFile(root, relativePath, content) {
  const filePath = path.join(root, ...relativePath.split('/'));
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  return filePath;
}

function makeFixture(t) {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-manual-lint-'));
  t.after(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
  const repoRoot = path.join(fixtureRoot, 'repo');
  const manualRoot = path.join(repoRoot, 'manual');
  const distRoot = path.join(manualRoot, 'dist');
  const dashboardPath = path.join(repoRoot, 'src/web/index.html');
  const site = {
    pages: [
      { id: 'index', source: 'pages/index.html', title: '入口' },
      { id: 'guide', source: 'pages/guide.html', title: 'ガイド', navGroup: 'はじめに' },
    ],
    helpAnchors: { 'help-guide': { output: 'guide.html', fragment: 'help-guide' } },
  };
  const indexSource = [
    '<section>',
    '<h1>入口</h1>',
    '<h2 id="help-index">内容</h2>',
    '<p><span class="ui">Open</span></p>',
    '<a href="#help-index">ページ内</a>',
    '<a href="guide.html#help-guide">ガイド</a>',
    '<img src="img/sample/panel.png" alt="説明画面">',
    '<ol>{{PAGE_LIST}}</ol>',
    '</section>',
  ].join('\n');
  writeFile(repoRoot, 'manual/site.json', JSON.stringify(site, null, 2));
  writeFile(repoRoot, 'manual/layout.html', '<html><head><title>{{DOCUMENT_TITLE}}</title>{{HELP_ANCHORS}}</head><body><nav>{{NAV_LINKS}}</nav><main>{{CONTENT}}{{PAGE_NAV}}</main><aside>{{SECTION_LINKS}}</aside></html>');
  writeFile(repoRoot, 'manual/assets/manual.css', 'body { color: black; }');
  writeFile(repoRoot, 'manual/assets/manual.js', '');
  writeFile(repoRoot, 'manual/pages/index.html', indexSource);
  writeFile(repoRoot, 'manual/pages/guide.html', '<section><h1>ガイド</h1><h2 id="help-guide">節</h2></section>');
  writeFile(repoRoot, 'manual/shots/screen.json', JSON.stringify({ steps: [{ do: 'screenshot', name: 'overview' }] }));
  writeFile(repoRoot, 'manual/img/screen/overview.png', Buffer.from([137, 80, 78, 71]));
  writeFile(repoRoot, 'manual/img/sample/panel.png', Buffer.from([137, 80, 78, 71]));
  writeFile(repoRoot, 'src/web/index.html', '<a href="/manual/#help-guide">Open</a>');
  buildManual(distRoot, manualRoot, repoRoot);
  return { fixtureRoot, repoRoot, manualRoot, distRoot, dashboardPath, site, indexSource };
}

function errorsFor(fixture) {
  return lintManual(fixture).errors;
}

test('npm test から実リポジトリのマニュアル検査を実行する', () => {
  assert.deepEqual(lintManual().errors, []);
});

test('マニュアル検査は原稿、ページ一覧、画像、helpAnchors、生成物が揃えば通る', t => {
  const fixture = makeFixture(t);
  assert.deepEqual(errorsFor(fixture), []);
});

test('組み立てた結果と manual/dist の違いをファイル名付きで報告する', t => {
  const fixture = makeFixture(t);
  writeFile(fixture.distRoot, 'index.html', '<html>stale</html>');
  writeFile(fixture.distRoot, 'old.txt', 'stale');
  const errors = errorsFor(fixture);
  assert.ok(errors.some(error => error.includes('manual/dist/index.html')));
  assert.ok(errors.some(error => error.includes('manual/dist/old.txt')));
});

test('画面に無い span.ui の文言を原稿ファイル付きで報告する', t => {
  const fixture = makeFixture(t);
  writeFile(fixture.repoRoot, 'src/web/index.html', '<a href="/manual/#help-guide">Close</a>');
  const errors = errorsFor(fixture);
  assert.ok(errors.some(error => error.includes('manual/pages/index.html') && error.includes('span.ui') && error.includes('Open')));
});

test('参照画像の不足、未使用画像、撮影定義の画像不足を検出する', t => {
  const fixture = makeFixture(t);
  fs.rmSync(path.join(fixture.manualRoot, 'img/sample/panel.png'));
  fs.rmSync(path.join(fixture.manualRoot, 'img/screen/overview.png'));
  writeFile(fixture.manualRoot, 'img/orphan.png', Buffer.from([137, 80, 78, 71]));
  const errors = errorsFor(fixture);
  assert.ok(errors.some(error => error.includes('manual/img/sample/panel.png')));
  assert.ok(errors.some(error => error.includes('manual/shots/screen.json') && error.includes('overview.png')));
  assert.ok(errors.some(error => error.includes('manual/img/orphan.png') && error.includes('参照されていません')));
});

test('ガイドマップに矩形が無い鍵を原稿ファイル付きで報告する', t => {
  const fixture = makeFixture(t);
  writeFile(fixture.manualRoot, 'img/map/screen.png', Buffer.from([137, 80, 78, 71]));
  writeFile(fixture.manualRoot, 'img/map/screen.json', JSON.stringify({ width: 100, height: 50, parts: [] }));
  writeFile(fixture.manualRoot, 'pages/index.html', fixture.indexSource.replace(
    '<h2 id="help-index">内容</h2>',
    '<h2 id="help-index">内容</h2><figure class="guide-map" data-shot="map/screen" data-alt="画面"><ol class="guide-list"><li data-part="missing"><b>項目</b></li></ol></figure>',
  ));
  const errors = errorsFor(fixture);
  assert.ok(errors.some(error => error.includes('manual/pages/index.html') && error.includes('missing')));
});

test('ページ内リンクとページ間リンクの無い節を検出する', t => {
  const fixture = makeFixture(t);
  writeFile(fixture.manualRoot, 'pages/index.html', fixture.indexSource.replace(
    '<a href="#help-index">ページ内</a>',
    '<a href="#absent">ページ内</a><a href="guide.html#absent">ページ間</a>',
  ));
  const errors = errorsFor(fixture);
  assert.ok(errors.some(error => error.includes('manual/pages/index.html') && error.includes('#absent')));
  assert.ok(errors.some(error => error.includes('manual/pages/index.html') && error.includes('guide.html#absent')));
});

test('helpAnchors のページと節が無い場合を検出する', t => {
  const fixture = makeFixture(t);
  fixture.site.helpAnchors['help-guide'] = { output: 'missing.html', fragment: 'help-guide' };
  writeFile(fixture.manualRoot, 'site.json', JSON.stringify(fixture.site, null, 2));
  const errors = errorsFor(fixture);
  assert.ok(errors.some(error => error.includes('manual/site.json') && error.includes('missing.html')));
});

test('ダッシュボードが使う help 鍵のうち helpAnchors に無いものを検出する', t => {
  const fixture = makeFixture(t);
  writeFile(fixture.repoRoot, 'src/web/index.html', '<a href="/manual/#help-guide">Open</a><a href="/manual/#help-missing">Missing</a>');
  const errors = errorsFor(fixture);
  assert.ok(errors.some(error => error.includes('src/web/index.html') && error.includes('help-missing')));
});

test('manual/ の外を指す相対リンクを検出する', t => {
  const fixture = makeFixture(t);
  writeFile(fixture.manualRoot, 'pages/index.html', fixture.indexSource.replace(
    '<a href="#help-index">ページ内</a>',
    '<a href="#help-index">ページ内</a><a href="../docs/usage.md">外部資料</a>',
  ));
  const errors = errorsFor(fixture);
  assert.ok(errors.some(error => error.includes('manual/pages/index.html') && error.includes('manual/ の外')));
});
