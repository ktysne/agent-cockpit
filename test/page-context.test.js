const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { cssDeclarations, pageContext } = require('./support/page-context');

const web = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');

test('画面にない名前をサンドボックスへ渡すと名前を含む例外になる', () => {
  assert.throws(() => pageContext(web, { missingPageName: true }), /missingPageName/);
});

test('画面で宣言された関数名とブラウザー名はサンドボックスへ渡せる', () => {
  assert.doesNotThrow(() => pageContext(web, { render: () => {}, document: {} }));
});

test('CSS 宣言は後の値を残し、指定時は重複と詳細セレクターも返す', () => {
  const html = '<style>.badge.done { color: red; color: blue; } .group .badge.done { color: green; }</style>';

  assert.deepEqual(cssDeclarations(html, '.badge.done'), [['color', 'blue']]);
  assert.deepEqual(cssDeclarations(html, '.badge.done', { includeRepeated: true }), [
    ['color', 'red'], ['color', 'blue'],
  ]);
  assert.deepEqual(cssDeclarations(html, '.badge.done', { includeMoreSpecific: true, includeRepeated: true }), [
    ['color', 'red'], ['color', 'blue'], ['color', 'green'],
  ]);
});

test('CSS 宣言の既定は @media の中を外し、通常の画面幅で効く値を返す', () => {
  const html = '<style>.order { margin-left: auto; } @media (max-width: 640px) { .order { margin-left: 0; } } .order { gap: 4px; }</style>';

  assert.deepEqual(cssDeclarations(html, '.order'), [['margin-left', 'auto'], ['gap', '4px']]);
});
