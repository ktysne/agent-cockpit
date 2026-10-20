const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { crossReviewWaitReason } = require('../src/server/pull-requests');
const { readWebPage, functionSource } = require('./support/page-context');

const web = readWebPage().replace(/\r\n/g, '\n');
const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8').replace(/\r\n/g, '\n');

const fakeElement = (tag, className = '', text = '') => {
  const node = { tag, className, children: [], attributes: {}, title: '' };
  node.append = (...items) => node.children.push(...items);
  node.setAttribute = (name, value) => { node.attributes[name] = value; };
  Object.defineProperty(node, 'textContent', {
    get: () => text + node.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join(''),
  });
  return node;
};

test('クロスレビューの記録状態ごとに待ち理由を表示する', () => {
  const headSha = 'a'.repeat(40);
  const staleSha = 'b'.repeat(40);
  const cases = [
    [null, headSha, 'クロスレビュー未実施'],
    [{ round: 2, triage: { round: 2, outcome: 'converged', sha: headSha }, conflict: [{ outcome: 'halted' }] }, headSha, 'クロスレビューの記録が食い違う'],
    [{ round: 2, triage: null }, headSha, 'クロスレビュー対応中'],
    [{ round: 2, triage: { round: 2, outcome: 'fixing', sha: headSha } }, headSha, 'クロスレビュー対応中'],
    [{ round: 2, triage: { round: 2, outcome: 'halted', sha: headSha } }, headSha, 'クロスレビューが開発者の判断待ち'],
    [{ round: 3, triage: { round: 2, outcome: 'halted', sha: headSha } }, headSha, 'クロスレビュー対応中'],
    [{ round: 3, triage: { round: 2, outcome: 'fixing', sha: headSha } }, headSha, 'クロスレビュー対応中'],
    [{ round: 2, triage: { round: 2, outcome: 'converged', sha: staleSha } }, headSha, 'クロスレビュー後に push あり'],
    [{ unavailable: true }, headSha, 'クロスレビューの状態を確認できない'],
    [{ deferred: true, reason: '実機待ち', next: '実機で確認する' }, headSha, 'レビュー保留'],
  ];

  const webReason = functionSource(web, 'pullRequestCrossReviewWaitReason');
  const webConverged = functionSource(web, 'convergedAtHead');
  const webPushed = functionSource(web, 'pushedAfterConvergence');
  const completeSha = functionSource(web, 'isCompleteCommitSha');
  const mockReason = functionSource(mock, 'crossReviewWaitReason');
  const mockConverged = functionSource(mock, 'convergedAtHead');
  const mockPushed = functionSource(mock, 'pushedAfterConvergence');
  assert.ok(webReason && webConverged && webPushed && completeSha && mockReason && mockConverged && mockPushed);
  const webContext = vm.createContext({ isCompleteCommitSha: (value) => typeof value === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) });
  vm.runInContext(`${completeSha}\n${webConverged}\n${webPushed}\n${webReason}\nthis.reason = pullRequestCrossReviewWaitReason;`, webContext);
  const mockContext = vm.createContext({ ui: { reviewSkips: {} }, prKey: () => 'repo/1' });
  vm.runInContext(`${mockConverged}\n${mockPushed}\n${mockReason}\nthis.reason = crossReviewWaitReason;`, mockContext);

  for (const [review, sha, expected] of cases) {
    assert.equal(crossReviewWaitReason(review, sha), expected);
    assert.equal(webContext.reason({ crossReview: review, headRefOid: sha }), expected);
    assert.equal(mockContext.reason({}, { number: 1, sha, xr: review }), expected);
  }
});

test('保留のカードは理由と次の作業をテキストで示しマージの条件を待たせる', () => {
  const context = vm.createContext({
    element: fakeElement, badge: (text, cls) => fakeElement('span', `badge ${cls}`, text),
    document: { createTextNode: text => text }, appendCrossReviewSkipControl() {},
  });
  for (const name of ['crossReviewState', 'crossReviewLine', 'pullRequestCrossReviewWaitReason', 'pullRequestReservationWaitReasons']) {
    vm.runInContext(functionSource(web, name), context);
  }
  const pr = { crossReview: { deferred: true, reason: '<img src=x onerror=alert(1)>', next: '実機で確認する' },
    ci: 'pass', review: 'none', canMerge: true };
  const line = context.crossReviewLine(pr);
  assert.match(line.textContent, /レビュー保留/);
  assert.match(line.textContent, /理由: <img src=x onerror=alert\(1\)>/);
  assert.match(line.textContent, /次の作業: 実機で確認する/);
  assert.equal(context.pullRequestCrossReviewWaitReason(pr), 'レビュー保留');
  assert.equal(context.pullRequestReservationWaitReasons(pr)[0], 'レビュー保留');
  assert.ok(line.children.every(node => typeof node === 'string' || node.tag === 'span'));
  const mockContext = vm.createContext({ ui: { reviewSkips: {} }, prKey: () => 'repo/1' });
  vm.runInContext(mock.match(/^const esc = .+$/m)[0], mockContext);
  for (const name of ['crossReviewState', 'crossReviewLine']) {
    vm.runInContext(functionSource(mock, name), mockContext);
  }
  const mockPr = { ...pr, sha: 'a'.repeat(40), xr: pr.crossReview };
  const mockLine = mockContext.crossReviewLine({}, mockPr);
  assert.match(mockLine, /レビュー保留/);
  assert.match(mockLine, /次の作業: 実機で確認する/);
  assert.match(mockLine, /&lt;img/);
  assert.doesNotMatch(mockLine, /<img/);
});

test('クロスレビューの状態を確認できない PR は、往復の数を出さずに札だけを出す', () => {
  const context = vm.createContext({
    element: fakeElement,
    badge: (text, cls) => fakeElement('span', `badge ${cls}`, text),
    document: { createTextNode: (text) => text },
    appendCrossReviewSkipControl() {},
    isCompleteCommitSha: () => true,
  });
  vm.runInContext(`${functionSource(web, 'crossReviewState')}\n${functionSource(web, 'crossReviewLine')}\nthis.line = crossReviewLine;`, context);
  const text = context.line({ crossReview: { unavailable: true }, headRefOid: 'a'.repeat(40) }).textContent;
  assert.match(text, /状態を確認できない/);
  assert.doesNotMatch(text, /undefined|往復/);
});

test('競合する PR は収束と表示せず記録元と解消の案内をテキストで表示する', () => {
  const headSha = 'a'.repeat(40);
  const review = { round: 2, max: 3, dismissed: 0, triage: { round: 2, sha: headSha, outcome: 'converged' }, conflict: [
    { worktree: '<img src=x onerror=alert(1)>', round: 2, sha: headSha, outcome: 'halted' },
    { worktree: '/old', round: 1, sha: headSha, outcome: 'converged' },
  ] };
  const context = vm.createContext({ element: fakeElement, document: { createTextNode: text => text } });
  for (const name of ['isCompleteCommitSha', 'shortShaElement', 'convergedAtHead', 'pushedAfterConvergence',
    'crossReviewState', 'crossReviewConflictDetails', 'pullRequestCrossReviewSettled', 'pullRequestReservationWaitReasons']) {
    vm.runInContext(functionSource(web, name), context);
  }
  const pr = { crossReview: review, headRefOid: headSha, ci: 'pass', review: 'approved', canMerge: true };
  assert.equal(context.pullRequestCrossReviewSettled(pr), false);
  assert.equal(context.convergedAtHead(pr), false);
  assert.equal(context.pushedAfterConvergence(pr), false);
  assert.equal(context.crossReviewState(pr).text, '記録が食い違う');
  assert.equal(context.pullRequestReservationWaitReasons(pr)[0], 'クロスレビューの記録が食い違う');
  const details = context.crossReviewConflictDetails(review);
  assert.match(details.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(details.textContent, /2 往復目 \/ aaaaaaa \/ 開発者の判断待ち/);
  assert.match(details.textContent, /古い worktree の記録を消すか、レビュー不要として確定してください/);
  assert.ok(details.children[0].children.every(node => node.tag === 'li' && node.children[0].tag === 'code'));
});
