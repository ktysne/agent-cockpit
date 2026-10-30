const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pageContext, readWebPage, sourceBetween } = require('./support/page-context');
const { reviewPr } = require('./support/review');
const source = fs.readFileSync(path.join(__dirname, '../src/shared/review-evaluation.js'), 'utf8').replace(/\r\n/g, '\n');
const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8').replace(/\r\n/g, '\n');

test('モックは共通の評価モジュールの本文を使う', () => {
  const embedded = mock.split('<!-- review-evaluation:begin -->\n<script>\n')[1]?.split('</script>\n<!-- review-evaluation:end -->')[0];
  assert.equal(embedded, source);
  assert.doesNotMatch(source, /require\s*\(/);
});

test('レビューの生の記録の読み取りは評価と読み取り関数に限る', () => {
  const removeFunctions = (text, names) => {
    for (const name of names) text = text.replace(new RegExp(`(?:async )?function ${name}\\([^]*?\\n\\}`, 'g'), '');
    return text;
  };
  const sources = [
    ['web', readWebPage()],
    ['mock', mock.replace(/<!-- review-evaluation:begin -->[^]*?<!-- review-evaluation:end -->/, '')],
    ...fs.readdirSync(path.join(__dirname, '../src/server'), { recursive: true }).filter(name => name.endsWith('.js')).map(name => [name,
      removeFunctions(fs.readFileSync(path.join(__dirname, '../src/server', name), 'utf8'), ['readCrossReviewState', 'selectCrossReview', 'mergeReviewFragments', 'classifyConvergedPush'])]),
  ];
  for (const [name, text] of sources) {
    assert.doesNotMatch(text, /\.triage(?:\?\.|\.)\s*(?:outcome|sha|round)|\btriage(?:\?\.|\.)\s*(?:outcome|sha|round)|\.reviewedSha\b/, name);
    assert.doesNotMatch(text, /classifyReviewAtHead\s*\(/, name);
  }
});

test('画面は保留の理由と次の作業を評価結果からテキストとして表示する', () => {
  const element = (tag, className = '', textContent = '') => ({ tag, className, textContent, children: [],
    append(...items) { this.children.push(...items); }, setAttribute() {} });
  const context = pageContext(readWebPage(), { element, badge: (text, cls) => element('span', cls, text),
    document: { createTextNode: text => element('text', '', text) }, appendCrossReviewSkipControl() {} });
  vm.runInContext(sourceBetween(readWebPage(), 'const MERGE_METHOD_LABELS', 'function appendPullRequestBlock'), context);
  const pr = reviewPr({ headRefOid: 'a'.repeat(40), crossReview: { deferred: true, reason: '<img src=x>', next: '実機で確認する' } });
  const line = context.crossReviewLine(pr);
  const text = node => node.textContent + node.children.map(text).join('');
  assert.match(text(line), /レビュー保留理由: <img src=x>次の作業: 実機で確認する/);
  assert.ok(line.children.every(node => node.tag === 'span' || node.tag === 'text'));
});


test('競合の記録元と解消の案内は画面とモックで安全に表示する', () => {
  const raw = { round: 2, max: 3, dismissed: 0, reviewedSha: 'a'.repeat(40),
    triage: { round: 2, outcome: 'halted', sha: 'a'.repeat(40) }, conflict: [
      { worktree: '<img src=x>', round: 2, outcome: 'halted', sha: 'a'.repeat(40) },
    ] };
  const element = (tag, className = '', textContent = '') => ({ tag, className, textContent, children: [], title: '',
    append(...items) { this.children.push(...items); }, setAttribute() {} });
  const context = pageContext(readWebPage(), { element, document: { createTextNode: text => element('text', '', text) } });
  vm.runInContext(sourceBetween(readWebPage(), 'const MERGE_METHOD_LABELS', 'function appendPullRequestBlock'), context);
  const pr = reviewPr({ headRefOid: 'a'.repeat(40), crossReview: raw });
  const details = context.crossReviewConflictDetails(pr.review.display);
  const text = node => node.textContent + node.children.map(text).join('');
  assert.match(text(details), /<img src=x> \/ 2 往復目 \/ aaaaaaa \/ 開発者の判断待ち/);
  assert.match(text(details), /古い worktree の記録を消すか、レビュー不要として確定してください/);
  const mockContext = pageContext(mock, { ui: { reviewSkips: {} }, prKey: () => 'p#1' });
  vm.runInContext(source, mockContext);
  vm.runInContext(mock.split('\n').find(line => line.startsWith('const esc =')), mockContext);
  vm.runInContext(sourceBetween(mock, 'function expandMockReviewSha', '// ---- プルリクエスト(スタック)'), mockContext);
  const rendered = mockContext.crossReviewConflictDetails({ id: 'p' }, { number: 1, sha: 'a'.repeat(40), xr: raw });
  assert.match(rendered, /&lt;img src=x&gt;/);
  assert.doesNotMatch(rendered, /<img/);
});
