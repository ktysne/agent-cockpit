const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const web = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');

function functionSource(source, name) {
  return source.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
}

test('仮進行中の状態名と判断待ちの内訳を上部札とそろえる', () => {
  assert.match(web, /provisional: '仮に推奨案で進行中'/);
  assert.match(mock, /provisional: '仮に推奨案で進行中'/);
  assert.doesNotMatch(web, /推奨で仮に進行中/);
  assert.doesNotMatch(mock, /推奨で仮に進行中/);

  const decisions = [
    { state: 'waiting', answer: null },
    { state: 'provisional', answer: null },
    { state: 'waiting', answer: { choice: 'hold' } },
  ];
  const webContext = {
    isPendingDecision: (decision) => decision.state === 'waiting' && !decision.answer,
    hasEffectiveAnswer: (decision) => Boolean(decision.answer),
    isHeldDecision: (decision) => decision.answer?.choice === 'hold',
  };
  vm.runInNewContext(`${functionSource(web, 'decisionCountTitle')}\nthis.title = decisionCountTitle;`, webContext);
  assert.equal(webContext.title(decisions), '止めて待っている 1 件、仮に推奨案で進行中 1 件、保留中 1 件');

  const mockAnswers = { held: { sent: { choice: 'hold' } } };
  const mockContext = {
    effectiveDecisionState: (decision) => decision.kind,
    answerOf: (id) => mockAnswers[id] || {},
  };
  vm.runInNewContext(`${functionSource(mock, 'decisionCountTitle')}\nthis.title = decisionCountTitle;`, mockContext);
  assert.equal(mockContext.title([
    { id: 'waiting', kind: 'waiting' },
    { id: 'provisional', kind: 'provisional' },
    { id: 'held', kind: 'waiting' },
  ]), '止めて待っている 1 件、仮に推奨案で進行中 1 件、保留中 1 件');
  assert.match(functionSource(web, 'productSection'), /decisionChip\.title = decisionCountTitle\(awaitingDecisions\)/);
  assert.match(functionSource(mock, 'renderProductMode'), /title="\$\{esc\(decisionCountTitle\(pend\)\)\}"/);
});

test('許可待ちと質問にプロダクト名とセッション名を出し、単一セッションのカードにも名前を出す', () => {
  for (const [source, permissionFunction, questionFunction] of [
    [web, 'appendPermissionWaits', 'appendDecisionAnswer'],
    [mock, 'permCard', 'decisionCard'],
  ]) {
    assert.match(functionSource(source, permissionFunction), /デスクトップアプリの .*sessionDisplayName\(session\)/);
    assert.match(functionSource(source, questionFunction), /デスクトップアプリの .*sessionDisplayName\(session\)/);
    assert.match(functionSource(source, 'sessionBlock'), /session-context[\s\S]*sessionDisplayName\(session\)/);
  }
});

test('プロダクトを外す操作を並べ替えから離し、直前分だけの元に戻すを用意する', () => {
  assert.doesNotMatch(functionSource(web, 'productControls'), /productCloseButton/);
  assert.ok(functionSource(web, 'productSection').indexOf('productControls(') < functionSource(web, 'productSection').indexOf('productCloseButton('));
  assert.doesNotMatch(functionSource(mock, 'orderControls'), /productCloseButton/);
  assert.ok(functionSource(mock, 'renderProductMode').indexOf('orderControls(') < functionSource(mock, 'renderProductMode').indexOf('productCloseButton('));
  assert.match(web, /product-remove \{ margin-left: 12px; \}/);
  assert.match(mock, /product-remove \{ margin-left: 12px; \}/);
  assert.match(web, /action: 'unhide', session_ids: hiddenSessionsUndo\.sessionIds/);
  assert.match(web, /button\.dataset\.undoHiddenSessions/);
  assert.match(mock, /hiddenSessionsUndo = \{ productName: product\.name, sessionIds \}/);
  assert.match(mock, /data-undo-hidden-sessions>元に戻す/);
  assert.match(mock, /const restored = new Set\(hiddenSessionsUndo\.sessionIds\)/);
});

test('経路の既定と有効になる時点を説明し、起動時の設定札にtitleを付ける', () => {
  for (const source of [web, mock]) {
    assert.match(source, /既定は Codex で実装し、利用上限や指示があれば Claude に切り替える。次に起動するサブエージェントから効く。/);
    assert.match(source, /既定はクロスレビューの手順が推奨する方法。次に回すレビューから効く。/);
  }
  assert.match(mock, /title="起動時に効いていた経路の設定"/);
  assert.match(functionSource(web, 'routeTag'), /tag\.title = '起動時に効いていた経路の設定'/);
});

test('押せる件数札は押せない札と枠で見分けられる', () => {
  for (const source of [web, mock]) assert.match(source, /\.summary button\.chip \{ border-color: var\(--text-2\); \}/);
});
