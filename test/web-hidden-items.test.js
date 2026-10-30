const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { readWebPage, functionSource, displayPageContext, sourceBetween } = require('./support/page-context');
const { reviewPr } = require('./support/review');

const html = readWebPage();
class Element {
  constructor(tagName, className = '', textContent = '') {
    Object.assign(this, { tagName, className, textContent, children: [], dataset: {}, attributes: {}, handlers: {} });
  }
  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.handlers[name] = handler; }
}
const element = (...args) => new Element(...args);
const all = node => [node, ...node.children.flatMap(all)];
const text = node => all(node).map(item => item.textContent).join('');

function context(overrides = {}) {
  return displayPageContext(html, {
    element, document: { createElement: element, createTextNode: value => element('text', '', value) },
    expandedHiddenDecisions: new Set(), expandedEndedDecisions: new Set(),
    pendingDecisionCloseActions: new Map(), decisionCloseActionsInFlight: new Set(),
    isFilterShown: () => true, newestFirst: items => items,
    itemTimestamp: () => 0, lastState: null,
    root: { querySelectorAll: () => [] }, displayPreferences: { hideFinished: true },
    ...overrides,
  });
}
function load(ctx, names) {
  vm.runInContext(names.map(name => functionSource(html, name)).join('\n'), ctx);
}

test('非表示の判断事項は札の件数と通常一覧から外れる', () => {
  const ctx = context();
  load(ctx, ['isActiveDecision', 'isPendingDecision', 'isAwaitingDecision', 'hasEffectiveAnswer', 'countJudgments', 'shownActiveDecisions']);
  const session = { permissionWaits: [], decisions: [
    { state: 'waiting', hidden: true }, { state: 'provisional', hidden: true }, { state: 'waiting' },
  ] };
  assert.equal(ctx.countJudgments([session]).decisions, 1);
  assert.equal(ctx.shownActiveDecisions(session).length, 1);
  ctx.isFilterShown = () => false;
  assert.equal(ctx.shownActiveDecisions(session, true).length, 0);
});

test('非表示の判断事項はセッション内でも種類別でも末尾の折りたたみから展開できる', () => {
  const ctx = context({ appendDecisionCard: (list, decision) => list.append(element('article', '', decision.title)),
    shownPermissions: () => [], hasHiddenJudgmentItems: () => true });
  load(ctx, ['isActiveDecision', 'hasEffectiveAnswer', 'shownActiveDecisions', 'isEndedDecision', 'appendExpandToggle', 'appendPlanToggle', 'appendHiddenDecisions', 'appendDecisions']);
  const session = { session_id: 'session', decisions: [{ id: 'hidden', title: '隠した判断', state: 'waiting', hidden: true }] };
  for (const key of ['session', 'kind']) {
    const collapsed = element('div');
    if (key === 'session') ctx.appendDecisions(collapsed, session, {});
    else ctx.appendHiddenDecisions(collapsed, [{ session, product: {} }], key);
    assert.equal(text(collapsed), '非表示の判断事項を表示 (1 件)');
    assert.equal(collapsed.children[0].attributes['aria-expanded'], 'false');
    ctx.expandedHiddenDecisions.add(key);
    const expanded = element('div');
    if (key === 'session') ctx.appendDecisions(expanded, session, {});
    else ctx.appendHiddenDecisions(expanded, [{ session, product: {} }], key);
    assert.equal(text(expanded), '隠した判断非表示の判断事項を隠す (1 件)');
  }
});

test('判断カードは未解決だけに非表示を出し、秒読み中は出さず、非表示なら薄く表示して復元を出す', () => {
  const ctx = context({
    decisionElapsedLabel: () => null, decisionAnswerAvailability: () => ({ active: false }),
    appendContextTags() {}, badge: label => element('span', '', label), decisionStateLabel: state => state,
    appendDecisionAnswer() {},
  });
  load(ctx, ['isActiveDecision', 'appendDecisionCard']);
  for (const [changes, label] of [
    [{ state: 'waiting' }, '非表示にする'], [{ state: 'provisional' }, '非表示にする'],
    [{ state: 'waiting', awaitingAnswerUntil: new Date().toISOString() }, null],
    [{ state: 'resolved' }, null], [{ state: 'withdrawn' }, null],
    [{ state: 'waiting', hidden: true }, '表示に戻す'],
  ]) {
    const root = element('div');
    ctx.appendDecisionCard(root, { id: 'decision', title: '判断', ...changes }, {}, { session_id: 'session' });
    const button = all(root).find(node => node.dataset.hideDecision || node.dataset.restoreDecision);
    assert.equal(button?.textContent || null, label);
    if (changes.hidden) assert.match(root.children[0].className, /manually-hidden/);
  }
});

test('非表示の PR の復元行は終わったものを隠す設定でも表示する', () => {
  const ctx = context({ durationAgoLabel: () => '今', appendPullRequestError() {}, appendPullRequestMergeResults() {} });
  load(ctx, ['appendPullRequestBlock']);
  const root = element('div');
  ctx.appendPullRequestBlock(root, { owner: 'example', repo: 'project', trees: [], merged: [], hiddenPrs: [{ number: 142, descendants: 1 }] });
  const restore = all(root).find(node => node.dataset.restorePr);
  assert.equal(restore.textContent, '#142');
  assert.equal(restore.title, '押すと表示に戻す');
  assert.match(text(root), /非表示: #142 \(上に 1 件\)/);
});

test('PR の非表示ボタンは子孫がある場合だけ影響を title に出し、隠した木は描画と集計から外す', () => {
  const ctx = context({
    queuedPullRequestMerge: () => null, pullRequestMergeConfirmations: new Map(),
    pullRequestMergeInFlight: new Set(), pullRequestResultUnconfirmed: () => false,
    pullRequestMergeMessages: new Map(), appendPullRequestBadges() {},
  });
  vm.runInContext(sourceBetween(html, 'const MERGE_METHOD_LABELS', 'function appendPullRequestBlock'), ctx);
  load(ctx, ['pullRequestKeys', 'pullRequestMergeableCount']);
  const leaf = reviewPr({ number: 2, title: '子', children: [], canMerge: true, ci: 'pass', mergeSessionId: null });
  const rootPr = reviewPr({ number: 1, title: '親', children: [leaf], canMerge: true, ci: 'pass', mergeSessionId: null });
  const group = { owner: 'example', repo: 'project', trees: [rootPr] };
  const root = element('div');
  ctx.appendPullRequestTree(root, group, rootPr);
  const buttons = all(root).filter(node => node.dataset.hidePr);
  assert.equal(buttons[0].title, '上に積んだ PR も一緒に隠します');
  assert.equal(buttons[1].title, undefined);
  rootPr.hidden = true;
  const hidden = element('div');
  ctx.appendPullRequestTree(hidden, group, rootPr);
  assert.equal(hidden.children.length, 0);
  assert.equal(ctx.pullRequestMergeableCount([group]), 0);
});

test('非表示操作が失敗したらエラーを示し、同じボタンで再試行できる', async () => {
  const status = {};
  const errors = [];
  const ctx = context({ postUiAction: async () => ({ ok: false, status: 409 }), liveStatus: status,
    showWriteError: message => errors.push(message) });
  load(ctx, ['changeItemVisibility']);
  const button = element('button');
  await ctx.changeItemVisibility(button, '/api/hidden-decisions', { action: 'hide' });
  assert.equal(button.disabled, false);
  assert.match(status.textContent, /もう一度/);
  assert.equal(errors.length, 1);
});

test('非表示操作の後は判断の折りたたみへ、PR では復元ボタンへフォーカスを移す', async () => {
  for (const isDecision of [true, false]) {
    let focused = false;
    const target = element('button');
    target.dataset.hiddenDecisions = 'kind';
    target.getAttribute = () => 'example/project#1';
    target.focus = options => { focused = options.preventScroll; };
    const ctx = context({ postUiAction: async () => ({ ok: true }), refresh: async () => {},
      root: { querySelectorAll: selector => selector === (isDecision ? '[data-hidden-decisions]' : '[data-restore-pr]') ? [target] : [] } });
    load(ctx, ['changeItemVisibility']);
    await ctx.changeItemVisibility(element('button'), isDecision ? '/api/hidden-decisions' : '/api/hidden-pull-requests',
      { action: 'hide', session_id: 'session', id: 'decision', owner: 'example', repo: 'project', number: 1 });
    assert.equal(focused, true);
  }
});

test('判断を非表示にしたら両表示方式の折りたたみを閉じてボタンへフォーカスを移す', async () => {
  const expanded = new Set(['session', 'kind', 'other']);
  let focused = false;
  const toggle = { dataset: { hiddenDecisions: 'kind' }, focus: () => { focused = true; } };
  const ctx = context({ expandedHiddenDecisions: expanded, postUiAction: async () => ({ ok: true }),
    refresh: async () => { assert.deepEqual([...expanded], ['other']); },
    root: { querySelectorAll: selector => selector === '[data-hidden-decisions]' ? [toggle] : [] } });
  load(ctx, ['changeItemVisibility']);
  await ctx.changeItemVisibility(element('button'), '/api/hidden-decisions', { action: 'hide', session_id: 'session', id: 'decision' });
  assert.equal(focused, true);
});

test('判断を表示に戻す操作と非表示の失敗では折りたたみの状態を保つ', async () => {
  for (const [action, ok] of [['unhide', true], ['hide', false]]) {
    const expanded = new Set(['session', 'kind']);
    const ctx = context({ expandedHiddenDecisions: expanded, postUiAction: async () => ({ ok }), refresh: async () => {},
      root: { querySelectorAll: () => [], querySelector: () => null }, liveStatus: {}, showWriteError() {} });
    load(ctx, ['changeItemVisibility']);
    await ctx.changeItemVisibility(element('button'), '/api/hidden-decisions', { action, session_id: 'session', id: 'decision' });
    assert.deepEqual([...expanded], ['session', 'kind']);
  }
});

test('解決操作は仮適用と MCP の待機にだけ出て、画面で解決した印を表示する', () => {
  const ctx = context({ decisionElapsedLabel: () => null, decisionAnswerAvailability: () => ({ active: false }),
    appendContextTags() {}, badge: label => element('span', '', label), decisionStateLabel: state => state, appendDecisionAnswer() {} });
  load(ctx, ['isActiveDecision', 'appendDecisionCard']);
  for (const [changes, expected] of [
    [{ state: 'provisional', source: 'ask' }, true], [{ state: 'provisional', source: 'mcp' }, true],
    [{ state: 'waiting', source: 'mcp' }, true], [{ state: 'waiting', source: 'ask' }, false],
    [{ state: 'waiting', source: 'mcp', awaitingAnswerUntil: new Date().toISOString() }, false],
    [{ state: 'resolved', closedByUser: true }, false], [{ state: 'withdrawn' }, false],
  ]) {
    const root = element('div');
    ctx.appendDecisionCard(root, { id: 'decision', title: '判断', ...changes }, {}, { session_id: 'session' });
    assert.equal(all(root).some(node => node.dataset.closeDecision === 'session::decision'), expected);
    assert.equal(text(root).includes('画面で解決済みにした'), changes.closedByUser === true);
  }
});

test('判断の解決は再描画後も取り消せ、5 秒後だけ送信して送信中の重複を防ぐ', async () => {
  let timer;
  let sent = 0;
  const pending = new Map();
  const inFlight = new Set();
  const ctx = context({ pendingDecisionCloseActions: pending, decisionCloseActionsInFlight: inFlight,
    lastState: {}, render() {}, actionFocusRestores: new Map(), rememberActionFocus() {},
    setTimeout: (callback, delay) => { timer = { callback, delay }; return 1; }, clearTimeout() {},
    sendCloseAction: () => { sent += 1; },
    decisionElapsedLabel: () => null, decisionAnswerAvailability: () => ({ active: false }),
    appendContextTags() {}, badge: label => element('span', '', label), decisionStateLabel: state => state, appendDecisionAnswer() {} });
  load(ctx, ['runCloseAction', 'cancelDecisionClose', 'appendDecisionCard', 'isActiveDecision']);
  const button = element('button');
  button.dataset.closeDecision = 'session::decision';
  const run = () => ctx.runCloseAction(button, '/api/closed-decisions', { session_id: 'session', id: 'decision' }, '失敗');
  await run();
  assert.equal(timer.delay, 5000);
  const root = element('div');
  ctx.appendDecisionCard(root, { id: 'decision', title: '判断', state: 'provisional' }, {}, { session_id: 'session' });
  assert.match(text(root), /取り消す5 秒後に解決済みにします。/);
  const cancel = all(root).find(node => node.dataset.cancelCloseDecision);
  ctx.cancelDecisionClose(cancel);
  timer.callback();
  assert.equal(sent, 0);
  await run();
  timer.callback();
  await run();
  assert.equal(sent, 1);
  assert.equal(inFlight.has('session::decision'), true);
});

test('判断の解決送信に失敗したら送信中を解除し同じカードで再試行できる', async () => {
  const key = 'session::decision';
  const inFlight = new Set([key]);
  const status = {};
  const ctx = context({ decisionCloseActionsInFlight: inFlight, postUiAction: async () => { throw new Error('offline'); },
    liveStatus: status, showWriteError() {}, actionFocusRestores: new Map(), lastState: {}, render() {} });
  load(ctx, ['sendCloseAction']);
  await ctx.sendCloseAction(element('button'), '/api/closed-decisions', {}, '判断事項を解決済みにできませんでした', key, `close:${key}`);
  assert.equal(inFlight.size, 0);
  assert.equal(status.textContent, '判断事項を解決済みにできませんでした');
});

test('画面のクリックは判断事項と PR の非表示と復元をそれぞれの HTTP 操作へ渡す', () => {
  let click;
  const calls = [];
  const ctx = context({ document: { addEventListener: (_name, handler) => { click = handler; } },
    changeItemVisibility: (_button, url, body) => calls.push({ url, ...body }) });
  vm.runInContext(sourceBetween(html, "document.addEventListener('click', (event) => {", "document.addEventListener('keydown', (event) => {"), ctx);
  for (const action of ['hide', 'restore']) {
    for (const kind of ['Decision', 'Pr']) {
      const button = element('button');
      button.dataset = { [`${action}${kind}`]: kind === 'Decision' ? 'decision' : 'example/project#1',
        decisionSession: 'session', owner: 'example', repo: 'project', number: '1' };
      click({ target: { closest: () => button } });
      const call = calls.at(-1);
      assert.equal(call.action, action === 'hide' ? 'hide' : 'unhide');
      assert.equal(call.url, kind === 'Decision' ? '/api/hidden-decisions' : '/api/hidden-pull-requests');
      if (kind === 'Decision') assert.equal(call.session_id, 'session');
      else assert.equal(call.number, 1);
    }
  }
});

test('画面の判断解決ボタンはセッションと判断 ID を解決 API に渡す', () => {
  let click;
  let call;
  const ctx = context({ document: { addEventListener: (_name, handler) => { click = handler; } },
    runCloseAction: (_button, url, body) => { call = { url, ...body }; } });
  load(ctx, ['closeDecisionButton']);
  vm.runInContext(sourceBetween(html, "document.addEventListener('click', (event) => {", "document.addEventListener('keydown', (event) => {"), ctx);
  const button = element('button');
  button.dataset.closeDecision = 'session::decision::part';
  click({ target: { closest: () => button } });
  assert.deepEqual({ ...call }, { url: '/api/closed-decisions', session_id: 'session', id: 'decision::part' });
});

test('未配達回答のある仮適用を解決するとほかに内容がないセッションは種類別の対象から外れる', () => {
  const ctx = context({ activityStatus: () => ({ tone: 'wait' }), runningBackgrounds: () => [],
    visiblePullRequestGroups: () => [],
    sessionsAfterIdleFilter: sessions => sessions, productGroups: sessions => sessions.length ? [{ key: 'product', sessions }] : [],
    displayPreferences: { hideFinished: true, order: ['product'], pinned: [] } });
  load(ctx, ['isEndedDecision', 'isFinishedSession', 'hasProductContent', 'orderedProducts']);
  const decision = { id: 'decision', state: 'provisional', answer: { sentAt: new Date().toISOString(), deliveredAt: null } };
  const session = { session_id: 'session', tasks: [], agents: [], permissionWaits: [], decisions: [decision] };
  assert.equal(ctx.orderedProducts([session]).length, 1);
  decision.state = 'resolved';
  decision.closedByUser = true;
  assert.equal(ctx.orderedProducts([session]).length, 0);
});
