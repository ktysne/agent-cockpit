'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { parseArgs } = require('node:util');

const { values } = parseArgs({ options: {
  checkout: { type: 'string' },
  revision: { type: 'string' },
} });
if (!values.checkout || !/^[0-9a-f]{40}$/i.test(values.revision || '')) {
  throw new Error('使い方: node tools/import-cross-review-contract.js --checkout <checkout> --revision <完全な SHA>');
}

const sourcePath = 'contracts/cross-review-state';
const destination = path.resolve(__dirname, '../test/fixtures/cross-review-state');
const git = (...args) => execFileSync('git', ['-C', values.checkout, ...args]);
const files = git('ls-tree', '-r', '--name-only', values.revision, '--', sourcePath)
  .toString('utf8').trim().split('\n')
  .filter((file) => /^contracts\/cross-review-state\/(?:parse|writer)\/[^/]+\.json$/.test(file));
if (!files.length) throw new Error('指定 revision に状態ファイルの検証データがありません');
const contents = files.map((file) => ({ file, body: git('show', `${values.revision}:${file}`) }));

fs.rmSync(destination, { recursive: true, force: true });
for (const { file, body } of contents) {
  const target = path.join(destination, file.slice(sourcePath.length + 1));
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}
fs.writeFileSync(path.join(destination, 'SOURCE.json'), `${JSON.stringify({
  repository: 'https://github.com/ktysne/ai-cross-review',
  revision: values.revision,
  path: sourcePath,
  contract: 'docs/contracts/cross-review-state.md',
}, null, 2)}\n`);
