const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const sources = fs.readdirSync(path.join(root, 'src'), { recursive: true })
  .filter((file) => file.endsWith('.js'))
  .map((file) => `src/${file.replaceAll('\\', '/')}`);

function violations(pattern, recommendation, allowedFiles = [], files = sources, allowedLines = []) {
  const found = [];
  for (const file of files) {
    if (allowedFiles.includes(file)) continue;
    const contents = fs.readFileSync(path.join(root, file), 'utf8');
    for (const match of contents.matchAll(pattern)) {
      const line = contents.slice(0, match.index).split('\n').length;
      const statement = contents.split('\n')[line - 1].trim();
      if (allowedLines.some((entry) => entry.file === file && entry.statement === statement)) continue;
      found.push(`${file}:${line}: ${recommendation}`);
    }
  }
  return found;
}

test('製品コードは tools の実装に依存しない', () => {
  const found = violations(/\brequire\s*\(\s*['"][^'"]*\btools[\/\\]/g,
    'src/ の共通処理（readRouting、parseCrossReviewState、shell-commands.js の関数）を使ってください');
  assert.deepEqual(found, [], found.join('\n'));
});

test('共有ファイルの読み取り先は adapter に集める', () => {
  const found = [
    ...violations(/['"]routing\.json['"]/g, 'readRouting / readRoutingSync を使ってください', ['src/server/routing.js']),
    ...violations(/['"]\.cross-review-state\.json['"]/g, 'readCrossReviewState と parseCrossReviewState を使ってください', ['src/server/pull-requests.js']),
    ...violations(/JSON\s*\.\s*parse\s*\(\s*(?:(?:crossReview|review|state)\w*(?:Text|Contents|Body))\s*\)/gi,
      '状態ファイルの本文は parseCrossReviewState を使ってください',
      ['src/server/cross-review-state.js']),
  ];
  const file = 'src/server/pull-requests.js';
  const contents = fs.readFileSync(path.join(root, file), 'utf8');
  const start = contents.indexOf('async function readCrossReviewState(');
  const nextFunction = /\n(?:async )?function\s/.exec(contents.slice(start + 1));
  const end = nextFunction ? start + 1 + nextFunction.index : contents.length;
  const adapter = contents.slice(start, end);
  for (const match of contents.matchAll(/['"]\.cross-review-state\.json['"]/g)) {
    if (match.index >= start && match.index < end) continue;
    const line = contents.slice(0, match.index).split('\n').length;
    found.push(`${file}:${line}: 状態ファイルは readCrossReviewState の adapter から parseCrossReviewState で読んでください`);
  }
  for (const match of adapter.matchAll(/JSON\s*\.\s*parse\s*\(/g)) {
    const line = contents.slice(0, start + match.index).split('\n').length;
    found.push(`${file}:${line}: 状態ファイルの本文は parseCrossReviewState を使ってください`);
  }
  assert.deepEqual(found, [], found.join('\n'));
});

test('フックとサーバーのコマンド解析は共通関数を使う', () => {
  const files = sources.filter((file) => /^src\/(?:hooks|server)\//.test(file));
  // 引用符の種類と生のエスケープが必要だが、共通関数は引用符を除くため同じ判断を再現できない。
  const allowedLines = [{
    file: 'src/server/pull-request-utils.js',
    statement: String.raw`const match = command.match(/^\s*cd[\t ]+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s;&|()<>]+))[\t ]*&&(?!&)/);`,
  }];
  const found = violations(/\b\w*command\w*\s*\.\s*(?:split|match)\s*\(/gi,
    'shell-commands.js の commandSegmentParts / commandWords を使ってください', [], files, allowedLines);
  assert.deepEqual(found, [], found.join('\n'));
});
