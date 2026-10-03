const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pageContext } = require('./support/page-context');

const web = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');

test('画面にない名前をサンドボックスへ渡すと名前を含む例外になる', () => {
  assert.throws(() => pageContext(web, { missingPageName: true }), /missingPageName/);
});

test('画面で宣言された関数名とブラウザー名はサンドボックスへ渡せる', () => {
  assert.doesNotThrow(() => pageContext(web, { render: () => {}, document: {} }));
});
