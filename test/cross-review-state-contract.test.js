const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCrossReviewState } = require('../src/server/cross-review-state');

const fixtures = path.join(__dirname, 'fixtures/cross-review-state');

for (const name of fs.readdirSync(path.join(fixtures, 'parse')).sort()) {
  const fixture = JSON.parse(fs.readFileSync(path.join(fixtures, 'parse', name), 'utf8'));
  test(`状態ファイルの契約: ${fixture.description} (${name})`, () => {
    assert.deepEqual(parseCrossReviewState(fixture.input), fixture.expected);
  });
}

for (const name of fs.readdirSync(path.join(fixtures, 'writer')).sort()) {
  test(`上流の書き込み結果を診断なしで読み取れる (${name})`, () => {
    const result = parseCrossReviewState(fs.readFileSync(path.join(fixtures, 'writer', name), 'utf8'));
    assert.equal(result.kind, 'ok');
    assert.deepEqual(result.issues, []);
  });
}

test('状態ファイルの検証データは完全な revision を記録する', () => {
  const source = JSON.parse(fs.readFileSync(path.join(fixtures, 'SOURCE.json'), 'utf8'));
  assert.match(source.revision, /^[0-9a-f]{40}$/i);
});
