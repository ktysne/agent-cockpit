const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  buildManual,
  createNavLinks,
  createSearchIndex,
  listFiles,
  preparePageContent,
} = require('../tools/manual/build');

const ROOT = path.resolve(__dirname, '..');

test('同じ原稿から同じ HTML と検索索引を生成し、矩形 JSON と画像を dist に含めない', t => {
  const temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-manual-build-'));
  t.after(() => fs.rmSync(temporaryRoot, { recursive: true, force: true }));
  const firstOutput = path.join(temporaryRoot, 'first');
  const secondOutput = path.join(temporaryRoot, 'second');

  buildManual(firstOutput, path.join(ROOT, 'manual'), ROOT);
  buildManual(secondOutput, path.join(ROOT, 'manual'), ROOT);

  const files = listFiles(firstOutput);
  assert.deepEqual(files, listFiles(secondOutput));
  for (const file of files) {
    assert.deepEqual(fs.readFileSync(path.join(firstOutput, ...file.split('/'))), fs.readFileSync(path.join(secondOutput, ...file.split('/'))));
  }
  assert.ok(files.includes('index.html'));
  assert.ok(files.includes('assets/manual.css'));
  assert.ok(files.includes('assets/manual.js'));
  assert.ok(files.includes('assets/search-index.js'));
  assert.ok(files.every(file => !file.startsWith('img/') && path.extname(file) !== '.json'));

  const html = fs.readFileSync(path.join(firstOutput, 'index.html'), 'utf8');
  const searchIndex = fs.readFileSync(path.join(firstOutput, 'assets/search-index.js'), 'utf8');
  assert.match(html, /aria-current="page"/);
  assert.match(html, /<h2 id="index-できること">できること<\/h2>/);
  assert.match(html, /<li><a href="index\.html">Agent Cockpit でできること<\/a><\/li>/);
  assert.match(searchIndex, /"sectionTitle":"ページの一覧"/);
  assert.match(searchIndex, /"href":"index\.html#index-できること"/);
});

test('ナビの区分は設計資料の順で表示する', () => {
  const pages = [
    { id: 'index', title: '入口' },
    { id: 'start', title: '使い始める', navGroup: 'はじめに' },
    { id: 'guide-away', title: '離席中', navGroup: '目的別のガイド' },
    { id: 'work', title: 'タスク', navGroup: '状況を見る' },
    { id: 'decisions', title: '判断事項', navGroup: '判断と回答' },
    { id: 'pull-requests', title: 'PR', navGroup: 'PR' },
    { id: 'settings', title: '設定', navGroup: '設定と運用' },
  ];
  const nav = createNavLinks({ pages }, pages[0]);
  const groups = ['はじめに', '目的別のガイド', '状況を見る', '判断と回答', 'PR', '設定と運用'];
  const positions = groups.map(group => nav.indexOf(`>${group}</h3>`));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual([...positions].sort((left, right) => left - right), positions);
  assert.match(nav, /href="settings\.html"/);
});

test('見出しから節 ID を作り、節ごとの本文を検索索引に入れる', () => {
  const prepared = preparePageContent('<p class="lead">導入文</p><h2>PR と回答</h2><p>レビュー後に回答する。</p><h3 id="fixed">確認欄</h3><p>画面から操作する。</p>', 'index');
  assert.match(prepared.content, /id="index-pr-と回答"/);
  assert.equal(prepared.sections[0].text, '導入文 レビュー後に回答する。');
  assert.equal(prepared.sections[1].id, 'fixed');
  const index = createSearchIndex([{ id: 'index', output: 'index.html', title: '入口', sections: prepared.sections }]);
  assert.deepEqual(index.map(item => item.href), ['index.html#index-pr-と回答', 'index.html#fixed']);
  assert.equal(index[0].text, '導入文 レビュー後に回答する。');
});
