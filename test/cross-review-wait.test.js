const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { crossReviewWaitReason } = require('../src/server/pull-requests');
const { readWebPage, functionSource } = require('./support/page-context');

const web = readWebPage().replace(/\r\n/g, '\n');
const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8').replace(/\r\n/g, '\n');

test('クロスレビューの記録状態ごとに待ち理由を表示する', () => {
  const headSha = 'a'.repeat(40);
  const staleSha = 'b'.repeat(40);
  const cases = [
    [null, headSha, 'クロスレビュー未実施'],
    [{ round: 2, triage: null }, headSha, 'クロスレビュー対応中'],
    [{ round: 2, triage: { round: 2, outcome: 'fixing', sha: headSha } }, headSha, 'クロスレビュー対応中'],
    [{ round: 2, triage: { round: 2, outcome: 'halted', sha: headSha } }, headSha, 'クロスレビューが開発者の判断待ち'],
    [{ round: 3, triage: { round: 2, outcome: 'halted', sha: headSha } }, headSha, 'クロスレビュー対応中'],
    [{ round: 3, triage: { round: 2, outcome: 'fixing', sha: headSha } }, headSha, 'クロスレビュー対応中'],
    [{ round: 2, triage: { round: 2, outcome: 'converged', sha: staleSha } }, headSha, 'クロスレビュー後に push あり'],
    [{ unavailable: true }, headSha, 'クロスレビューの状態を確認できない'],
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

test('クロスレビューの状態を確認できない PR は、往復の数を出さずに札だけを出す', () => {
  const fakeElement = (tag, className = '', text = '') => {
    const node = { tag, className, children: [], attributes: {}, title: '' };
    node.append = (...items) => node.children.push(...items);
    node.setAttribute = (name, value) => { node.attributes[name] = value; };
    Object.defineProperty(node, 'textContent', {
      get: () => text + node.children.map((child) => (typeof child === 'string' ? child : child.textContent)).join(''),
    });
    return node;
  };
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
