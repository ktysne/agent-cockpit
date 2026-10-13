const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const {
  findManualSearchTarget,
  resolveManualHelpAnchor,
  searchManualIndex,
} = require('../manual/assets/manual.js');

const ROOT = path.resolve(__dirname, '..');

function fakeElement(tagName, textContent, children = [], open = false) {
  return { tagName, textContent, children, open, nextElementSibling: null };
}

function runManualScript() {
  const root = { dataset: {} };
  const window = {
    manualHelpAnchors: {},
    addEventListener() {},
  };
  const document = {
    documentElement: root,
    readyState: 'complete',
    querySelector: () => null,
    querySelectorAll: () => [],
  };
  vm.runInNewContext(fs.readFileSync(path.join(ROOT, 'manual/assets/manual.js'), 'utf8'), {
    window,
    location: { hash: '', href: 'http://127.0.0.1/manual/' },
    document,
  });
  return root.dataset.theme;
}

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(value => Number.parseInt(value, 16) / 255)
    .map(value => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function contrastRatio(left, right) {
  const values = [luminance(left), luminance(right)].sort((a, b) => b - a);
  return (values[0] + 0.05) / (values[1] + 0.05);
}

test('検索は全角英数字と大文字小文字をそろえ、空白区切りの語を AND で扱う', () => {
  const index = [
    { pageTitle: 'PR と離席', sectionTitle: '離席中', href: 'away.html#away', text: 'スタックの状態を確認する。' },
    { pageTitle: 'PR', sectionTitle: '確認', href: 'pull-requests.html#confirm', text: '条件を確認する。' },
  ];
  assert.deepEqual(searchManualIndex(index, 'ＰＲ 離席').map(item => item.href), ['away.html#away']);
  assert.deepEqual(searchManualIndex(index, 'PR 条件').map(item => item.href), ['pull-requests.html#confirm']);
  assert.deepEqual(searchManualIndex(index, 'PR 設定'), []);
});

test('検索結果の節内にある details.more を開く対象として返す', () => {
  const summary = fakeElement('SUMMARY', '判断の詳細');
  const paragraph = fakeElement('P', '回答が届いたことを確かめる。');
  const details = fakeElement('DETAILS', '判断の詳細 回答が届いたことを確かめる。', [summary, paragraph], false);
  const heading = fakeElement('H2', '判断事項');
  heading.nextElementSibling = details;

  const result = findManualSearchTarget(heading, '届いたこと');
  assert.equal(result.target, paragraph);
  assert.deepEqual(result.detailsToOpen, [details]);
});

test('入口の helpAnchors からページと節の URL を解決する', () => {
  const url = resolveManualHelpAnchor(
    { 'help-settings': { output: 'settings.html', fragment: 'help-settings' } },
    '#help-settings',
    'http://127.0.0.1:47821/manual/',
    'http://127.0.0.1:47821/manual/#help-settings',
  );
  assert.equal(url, 'http://127.0.0.1:47821/manual/settings.html#help-settings');
  assert.equal(resolveManualHelpAnchor({}, '#help-unknown', 'http://localhost/manual/', 'http://localhost/manual/#help-unknown'), null);
});

test('マニュアルは配色を指定せず、OS の明るさの設定に従う', () => {
  assert.equal(runManualScript(), undefined);
});

test('ガイドマップの紫の札はライトとダークの地の両方で 4.5:1 以上の差を保つ', () => {
  const css = fs.readFileSync(path.join(ROOT, 'manual/assets/manual.css'), 'utf8');
  const darkBlock = /:root\[data-theme="dark"\]\s*\{([^}]+)\}/.exec(css)?.[1];
  assert.ok(darkBlock);
  const lightBadge = /--gm:\s*(#[0-9a-f]{6})/i.exec(css)?.[1];
  const lightBackground = /--bg:\s*(#[0-9a-f]{6})/i.exec(css)?.[1];
  const darkBadge = /--gm:\s*(#[0-9a-f]{6})/i.exec(darkBlock)?.[1];
  const darkBackground = /--bg:\s*(#[0-9a-f]{6})/i.exec(darkBlock)?.[1];
  assert.ok(contrastRatio(lightBadge, lightBackground) >= 4.5);
  assert.ok(contrastRatio(darkBadge, darkBackground) >= 4.5);
  assert.match(css, /--gm-on:\s*#ffffff/);
  assert.match(darkBlock, /--gm-on:\s*#1f1e1d/);
});
