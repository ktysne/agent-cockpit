const { reviewPr } = require('./support/review');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createFakeClock } = require('../tools/manual/fake-clock');
const { readWebPage, cssDeclarations, functionSource, displayPageContext: pageContext, sourceBetween } = require('./support/page-context');

// 作業ツリーは autocrlf で CRLF になることがあり、ソースの断片を照合する正規表現は LF を前提にする。
const pageHtml = readWebPage().replace(/\r\n/g, '\n');
const mockHtml = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8').replace(/\r\n/g, '\n');

test('PR の取得エラーに unknown の記録がある場合だけ登録解除ボタンを表示し、開くとやめるへ、やめると元のボタンへフォーカスを移す', () => {
  const element = (tagName, className = '', textContent = '') => ({
    tagName, className, textContent, children: [], handlers: {}, dataset: {},
    append(...nodes) { this.children.push(...nodes); },
    addEventListener(name, handler) { this.handlers[name] = handler; },
  });
  const confirmations = new Map();
  const focused = [];
  const context = pageContext(pageHtml, { element, repositoryUnregisterConfirmations: confirmations, render() {}, lastState: {},
    focusRepositoryUnregister: (key, action) => focused.push(`${key}:${action}`) });
  vm.runInContext(functionSource(pageHtml, 'appendPullRequestError'), context);
  for (const [error, count, shown] of [['取得できません', 1, true], ['取得できません', 0, false], [null, 1, false]]) {
    const root = element('div');
    context.appendPullRequestError(root, { owner: 'example', repo: 'project', error, unregisterableCount: count });
    const flatten = node => [node, ...node.children.flatMap(flatten)];
    const button = flatten(root).find(node => node.textContent === 'このリポジトリの登録を外す');
    assert.equal(Boolean(button), shown);
    if (!button) continue;
    button.handlers.click();
    const confirmed = element('div');
    context.appendPullRequestError(confirmed, { owner: 'example', repo: 'project', error, unregisterableCount: count });
    assert.ok(flatten(confirmed).some(node => node.textContent.includes('元に戻せません')));
    flatten(confirmed).find(node => node.textContent === 'やめる').handlers.click();
    assert.equal(confirmations.size, 0);
    assert.deepEqual(focused.splice(0), ['example/project:cancel', 'example/project:open']);
  }
});

function mergeTargetConfirmation(pullRequest) {
  const element = (tagName, className = '', textContent = '') => ({
    tagName, className, textContent, children: [], dataset: {}, attributes: {},
    append(...nodes) { this.children.push(...nodes); },
    setAttribute(name, value) { this.attributes[name] = value; },
  });
  const context = pageContext(pageHtml, {
    element, document: { createTextNode: text => element('text', '', text) },
    pullRequestMergeKey: () => 'pr-key', pullRequestMergeOptions: new Map([['pr-key', { method: 'squash', deleteBranch: true }]]),
    pullRequestMergeInFlight: new Set(), pullRequestResultUnconfirmed: () => false, pullRequestUnconfirmedResults: new Map(), refreshSequence: 0, pullRequestMergeConditionWaits: () => [], crossReviewState: () => ({}),
    shortShaElement: () => element('code', '', 'a'.repeat(7)),
    MERGE_METHOD_LABELS: { merge: 'マージコミット', squash: 'スカッシュ', rebase: 'リベース' },
  });
  vm.runInContext(['pullRequestMergeOptionsFor', 'appendPullRequestMergeConfirmation'].map(name => functionSource(pageHtml, name)).join('\n'), context);
  const root = element('div');
  context.appendPullRequestMergeConfirmation(root, { defaultBranch: 'main', mergeMethods: ['merge', 'squash', 'rebase'], lastMethod: 'squash' }, reviewPr(pullRequest));
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  return flatten(root);
}

test('集約先の確認欄はマージ先と付け替え先を表示しマージコミットだけを選べる', () => {
  const nodes = mergeTargetConfirmation({ number: 42, headRefName: 'feature/one', mergeTarget: 'feature/aggregate',
    effectiveBase: 'feature/aggregate', mergeMethodFixed: 'merge', children: [{ number: 43 }] });
  assert.deepEqual(nodes.filter(node => node.type === 'radio').map(node => node.value), ['merge']);
  assert.equal(nodes.find(node => node.type === 'radio').checked, true);
  assert.ok(nodes.some(node => node.textContent === 'feature/aggregate'));
  assert.ok(nodes.some(node => node.textContent === '#43 の base を feature/aggregate に付け替える'));
  assert.ok(nodes.some(node => node.textContent === '集約ブランチと同期 PR はマージコミットで入れます'));
});

test('同期 PR の確認欄には main の削除選択と子の付け替え説明を出さない', () => {
  const nodes = mergeTargetConfirmation({ number: 42, headRefName: 'main', mergeTarget: 'feature/aggregate',
    mergeMethodFixed: 'merge', children: [{ number: 43 }] });
  assert.equal(nodes.some(node => node.type === 'checkbox'), false);
  assert.equal(nodes.some(node => node.textContent.includes('base を')), false);
  assert.deepEqual(nodes.filter(node => node.type === 'radio').map(node => node.value), ['merge']);
});

test('予約の方式がマージコミットの固定と違うと画面に実行しない理由を表示する', () => {
  const context = pageContext(pageHtml, {});
  vm.runInContext(functionSource(pageHtml, 'pullRequestReservationWaitReasons'), context);
  const waiting = context.pullRequestReservationWaitReasons(reviewPr({ headRefOid: 'a'.repeat(40), crossReview: { round: 1, triage: { round: 1, outcome: 'converged', sha: 'a'.repeat(40) } }, canMerge: true, ci: 'pass', review: 'none',
    baseRefName: 'feature/aggregate', effectiveBase: 'feature/aggregate', mergeTarget: 'feature/aggregate', mergeMethodFixed: 'merge' }),
  { defaultBranch: 'main', mergeMethods: ['merge', 'squash'] }, 'squash');
  assert.deepEqual(Array.from(waiting), ['マージ方式がマージコミットに固定のため、予約の方式では実行しない']);
});

test('終了した行だけを持つ待機中セッションは更新の無い設定で隠れる', () => {
  const context = pageContext(pageHtml, {
    displayPreferences: { idleHideMinutes: 30 }, isActiveDecision: () => false,
  });
  vm.runInContext(['isEndedAgent', 'isIdleHiddenSession'].map(name => functionSource(pageHtml, name)).join('\n'), context);
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const session = { status: '待機中', lastUpdatedAt: new Date(now - 31 * 60_000).toISOString(),
    agents: [{ active: false, unconfirmed: false }] };
  assert.equal(context.isIdleHiddenSession(session, now), true);
  assert.equal(context.isIdleHiddenSession({ ...session, agents: [{ active: true }] }, now), false);
});

test('外したセッションは hiddenAt と更新時刻の遅い方から待ち、更新の無い帯へ移る', () => {
  const context = pageContext(pageHtml, {
    displayPreferences: { idleHideMinutes: 30, hideFinished: true },
    isActiveDecision: decision => ['waiting', 'provisional'].includes(decision.state),
    isEndedAgent: agent => agent.active !== true,
    isFinishedSession: session => session.finished === true,
  });
  vm.runInContext(['isIdleHiddenSession', 'idleHiddenSessions'].map(name => functionSource(pageHtml, name)).join('\n'), context);
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const old = new Date(now - 31 * 60_000).toISOString();
  const session = { session_id: 'hidden-idle', hidden: true, lastUpdatedAt: old, hiddenAt: old, status: '待機中' };
  assert.equal(context.isIdleHiddenSession(session, now), true);
  assert.equal(context.idleHiddenSessions([session], now).length, 1);
  assert.equal(context.idleHiddenSessions([{ ...session, finished: true }], now).length, 1);
  assert.equal(context.idleHiddenSessions([{ ...session, hidden: false, finished: true }], now).length, 0);
  for (const changes of [
    { hiddenAt: new Date(now).toISOString() }, { lastUpdatedAt: new Date(now).toISOString() },
    { status: '作業中' }, { permissionWaits: [{}] }, { decisions: [{ state: 'waiting' }] }, { agents: [{ active: true }] },
  ]) assert.equal(context.isIdleHiddenSession({ ...session, ...changes }, now), false);
  assert.equal(context.isIdleHiddenSession({ ...session, lastUpdatedAt: null, sessionFileUpdatedAt: old }, now), true);
});

test('終わった帯の削除対象は表示件数と一致し、警告履歴と表示中の自動マージ結果を除く', () => {
  const context = pageContext(pageHtml, {
    displayPreferences: { hideFinished: true }, isFinishedSession: session => session.finished === true,
    pullRequestMergeResultVisible: result => result.visible === true,
  });
  vm.runInContext(['finishedDeletionTargets', 'finishedHiddenCounts'].map(name => functionSource(pageHtml, name)).join('\n'), context);
  const sessions = [{ session_id: 'finished', finished: true }, { session_id: 'hidden', hidden: true, finished: true }];
  const group = { owner: 'example', repo: 'project', mergeHistory: [
    { number: 1 }, { number: 2, headMismatch: true },
    { number: 5, automatic: true, automaticResult: {}, visible: true },
    { number: 6, automatic: true, automaticResult: {}, visible: false },
  ],
    merged: [{ number: 3, state: 'closed' }, { number: 4, state: 'merged' }] };
  const targets = context.finishedDeletionTargets(sessions, [group, group]);
  assert.deepEqual(JSON.parse(JSON.stringify(targets)), {
    session_ids: ['finished'], merge_history: [
      { owner: 'example', repo: 'project', number: 1 }, { owner: 'example', repo: 'project', number: 6 },
    ],
    closed_pull_requests: [{ owner: 'example', repo: 'project', number: 3 }],
  });
  const counts = context.finishedHiddenCounts(sessions, [group, group]);
  assert.deepEqual(JSON.parse(JSON.stringify(counts)), { sessions: 1, pullRequests: 3 });
  assert.equal(counts.pullRequests, targets.merge_history.length + targets.closed_pull_requests.length);
});

test('外したセッションだけのプロダクトには閉じるボタンを表示しない', () => {
  class FakeElement {
    constructor(tagName, className, textContent) { Object.assign(this, { tagName, className, textContent, dataset: {} }); }
    setAttribute() {}
  }
  const source = functionSource(pageHtml, 'productCloseButton');
  const context = pageContext(pageHtml, { element: (...args) => new FakeElement(...args) });
  vm.runInContext(source, context);
  assert.equal(context.productCloseButton({ sessions: [{ hidden: true }] }), null);
  assert.equal(context.productCloseButton({ sessions: [{ hidden: false }] }).textContent, '×');

  // 更新の無いセッションを表示しているときは、外したセッションも visibleSessions に入る。
  const mockContext = pageContext(mockHtml, {
    ui: { hiddenSessions: ['hidden-idle'] },
    visibleSessions: product => product.sessions,
  });
  vm.runInContext(functionSource(mockHtml, 'productCloseButton'), mockContext);
  assert.equal(mockContext.productCloseButton({ id: 'product', sessions: [{ id: 'hidden-idle' }] }), '');
  assert.match(mockContext.productCloseButton({ id: 'product', sessions: [{ id: 'hidden-idle' }, { id: 'shown' }] }), /data-close-product/);
});

test('モックの削除確認は押した時点で残っている対象だけを数えて削除する', () => {
  const ui = { deletedSessionIds: [], hiddenSessions: [], hiddenSessionUpdatedAt: {}, dismissedMergeHistory: [], deletedClosedPrs: [] };
  const recordDeletionConfirmations = new Map([['finished', {
    targets: { sessions: ['old', 'current'], prs: ['example/project#1'], closed: [] },
    pending: false, error: '',
  }]]);
  const recordDeletionTargets = new Map([['finished', {
    targets: { sessions: ['current'], prs: [], closed: [] }, count: 1,
  }]]);
  const context = pageContext(mockHtml, { ui, hiddenSessionsUndo: null, recordDeletionConfirmations, recordDeletionTargets });
  vm.runInContext([
    functionSource(mockHtml, 'intersectRecordDeletionTargets'),
    functionSource(mockHtml, 'countRecordDeletionTargets'),
    functionSource(mockHtml, 'recordDeletionControls'),
    functionSource(mockHtml, 'deleteNoteRecords'),
  ].join('\n'), context);

  assert.match(context.recordDeletionControls('finished', recordDeletionTargets.get('finished').targets, 1),
    /1 件の記録を削除します/);
  assert.deepEqual(JSON.parse(JSON.stringify(recordDeletionConfirmations.get('finished').targets.sessions)), ['old', 'current']);
  assert.deepEqual(JSON.parse(JSON.stringify(recordDeletionTargets.get('finished').targets.sessions)), ['current']);
  context.deleteNoteRecords('finished');
  assert.deepEqual(JSON.parse(JSON.stringify(ui.deletedSessionIds)), ['current']);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.dismissedMergeHistory)), []);

  recordDeletionConfirmations.set('finished', { targets: { sessions: ['gone'], prs: [], closed: [] }, pending: false });
  recordDeletionTargets.set('finished', { targets: { sessions: [], prs: [], closed: [] }, count: 0 });
  context.deleteNoteRecords('finished');
  assert.equal(recordDeletionConfirmations.has('finished'), false);
  assert.deepEqual(JSON.parse(JSON.stringify(ui.deletedSessionIds)), ['current']);
});

test('モックの終わった帯は表示中の自動マージ結果を削除対象から除く', () => {
  const product = {
    id: 'project', repo: { name: 'example/project' },
    prs: [{ number: 1 }, { number: 2 }, { number: 3 }],
  };
  const ui = {
    hideFinished: true, hiddenSessions: [], dismissedMergeHistory: [], deletedClosedPrs: [],
    merged: { 'project#1': { auto: false }, 'project#2': { auto: true }, 'project#3': { auto: true } },
  };
  const context = pageContext(mockHtml, {
    DATA: { products: [product] }, ui, pullRequestMergeResults: new Map([['example/project', [
      { productId: 'project', number: 2, visible: true }, { productId: 'project', number: 3, visible: false },
    ]]]),
    allSessions: () => [], isFinishedSession: () => false, visibleClosedPrs: () => [],
    prKey: (item, number) => `${item.id}#${number}`,
    isMerged: (item, pullRequest) => Boolean(ui.merged[`${item.id}#${pullRequest.number}`]),
    pullRequestMergeResultVisible: result => result.visible === true,
    allSessions: () => [], isFinishedSession: () => false, visibleClosedPrs: () => [],
  });
  vm.runInContext([
    functionSource(mockHtml, 'finishedDeletionTargets'),
    functionSource(mockHtml, 'finishedHiddenCounts'),
    functionSource(mockHtml, 'hasVisibleAutomaticMergeResult'),
  ].join('\n'), context);

  const targets = context.finishedDeletionTargets();
  assert.deepEqual(JSON.parse(JSON.stringify(targets)), {
    sessions: [], prs: ['example/project#1', 'example/project#3'], closed: [],
  });
  assert.equal(context.finishedHiddenCounts().pullRequests, targets.prs.length + targets.closed.length);
});

test('モックの削除確認から通信中と失敗の状態を表示できる', () => {
  const recordDeletionConfirmations = new Map([['finished', { targets: { sessions: ['a', 'b'] }, count: 2, pending: false, error: '' }]]);
  const context = pageContext(mockHtml, {
    recordDeletionTargets: new Map([['finished', { targets: { sessions: ['a', 'b'] }, count: 2 }]]),
    recordDeletionConfirmations,
    esc: value => String(value),
    document: { addEventListener: (_name, callback) => { context.handleClick = callback; } },
    render() {}, save() {},
  });
  const clickListener = mockHtml.match(/document\.addEventListener\('click', e => \{[\s\S]*?^\}\);/m)?.[0];
  assert.ok(clickListener);
  vm.runInContext(`${functionSource(mockHtml, 'intersectRecordDeletionTargets')}\n${functionSource(mockHtml, 'countRecordDeletionTargets')}\n${functionSource(mockHtml, 'recordDeletionControls')}\n${clickListener}`, context);
  const press = action => {
    const button = { dataset: { recordBand: 'finished', recordAction: action }, closest: () => button };
    context.handleClick({ target: button });
  };

  press('mock-pending');
  const pending = context.recordDeletionControls('finished', { sessions: ['a', 'b'] }, 2);
  assert.match(pending, /削除中…/);
  assert.match(pending, /aria-disabled="true"/);
  press('mock-error');
  const failed = context.recordDeletionControls('finished', { sessions: ['a', 'b'] }, 2);
  assert.match(failed, /role="alert"/);
  assert.match(failed, /記録を削除できませんでした/);
});

function recordDeletionHarness(sessions, postUiAction = async () => ({ ok: true, json: async () => ({ deleted: { sessions: 1, pullRequests: 0 } }) })) {
  let activeElement = null;
  class Node {
    constructor(tag, className = '', textContent = '') {
      Object.assign(this, { tag, className, textContent, dataset: {}, children: [], attributes: {}, listeners: {} });
      this.classList = { add: value => { this.className += ` ${value}`; } };
    }
    setAttribute(key, value) { this.attributes[key] = value; }
    hasAttribute(key) { return Object.hasOwn(this.attributes, key); }
    addEventListener(key, callback) { this.listeners[key] = callback; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
    focus() { if (!this.disabled) activeElement = this; }
  }
  const notes = Object.fromEntries(['excluded-note', 'finished-note', 'idle-note'].map(id => [id, new Node('div')]));
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  const mode = new Node('button');
  const buttons = () => Object.values(notes).flatMap(flatten).filter(node => node.tag === 'button');
  const context = pageContext(pageHtml, {
    lastState: { sessions, pullRequests: [] }, displayPreferences: { mode: 'product', idleHideMinutes: 30, hideFinished: true },
    answerNoteComposing: false,
    hiddenSessionsUndo: null, recordDeletionTargets: new Map(), recordDeletionConfirmations: new Map(), showIdleSessions: false,
    element: (tag, className, text) => new Node(tag, className, text),
    HTMLTextAreaElement: class TextArea {},
    document: {
      get activeElement() { return activeElement; }, getElementById: id => notes[id],
      querySelectorAll: selector => selector === 'button' ? buttons() : selector === '[data-record-band]' ? buttons().filter(button => button.dataset.recordBand) : [],
      querySelector: () => mode,
    },
    root: { replaceChildren() {}, querySelectorAll: () => [] },
    renderRouting() {}, renderSummary() {}, updateTitle() {}, visibleSinceSeen: () => [], orderedProducts: () => [],
    isActiveDecision: () => false, isEndedAgent: () => true, isFinishedSession: session => session.finished === true,
    countJudgments: () => ({ permission: 0, blocking: 0 }), liveStatus: { textContent: '' },
    postUiAction, refresh: async () => {},
  });
  vm.runInContext([functionSource(pageHtml, 'focusDataFor'), ...['isIdleHiddenSession', 'idleHiddenSessions', 'sessionsAfterIdleFilter',
    'finishedToggle', 'renderExcludedNote', 'renderFinishedNote', 'renderIdleNote', 'finishedHiddenCounts', 'finishedDeletionTargets',
    'recordDeletionTargetKey', 'intersectRecordDeletionTargets', 'countRecordDeletionTargets', 'appendRecordDeletion',
    'focusRecordDeletion', 'deleteNoteRecords', 'hasCodexOrigin', 'render'].map(name => functionSource(pageHtml, name))].join('\n'), context);
  context.render(context.lastState);
  return { context, notes, buttons, nodes: () => Object.values(notes).flatMap(flatten), get activeElement() { return activeElement; } };
}

test('帯の削除確認は再描画でも対象とフォーカスを保ち、やめるでは送信しない', () => {
  let requests = 0;
  const harness = recordDeletionHarness([{ session_id: 'excluded', hidden: true, hiddenAt: new Date().toISOString() }], () => { requests += 1; });
  const open = harness.buttons().find(button => button.dataset.recordAction === 'open');
  assert.equal(open.attributes['aria-label'], 'この 1 件の記録を削除する');
  open.listeners.click();
  assert.equal(harness.activeElement.dataset.recordAction, 'cancel');
  const confirmation = harness.context.recordDeletionConfirmations.get('excluded');
  harness.context.render(harness.context.lastState);
  assert.equal(harness.context.recordDeletionConfirmations.get('excluded'), confirmation);
  assert.equal(harness.notes['excluded-note'].hidden, false);
  assert.equal(harness.activeElement.dataset.recordAction, 'cancel');
  assert.ok(harness.buttons().includes(harness.activeElement));
  harness.activeElement.listeners.click();
  assert.equal(requests, 0);
  assert.equal(harness.context.recordDeletionConfirmations.size, 0);
});

test('帯の削除は50件ずつ送信し、削除したIDを元に戻す記録から除く', async () => {
  const bodies = [];
  const sessions = Array.from({ length: 51 }, (_, index) => ({ session_id: `session-${index}`, hidden: true, hiddenAt: new Date().toISOString() }));
  const harness = recordDeletionHarness(sessions, async (url, body) => {
    assert.equal(url, '/api/record-deletions');
    bodies.push(body);
    return { ok: true, json: async () => ({ deleted: { sessions: body.session_ids.length, pullRequests: 0 } }) };
  });
  harness.context.hiddenSessionsUndo = { productName: '作業', sessionIds: ['session-0', 'other'] };
  harness.buttons().find(button => button.dataset.recordAction === 'open').listeners.click();
  await harness.context.deleteNoteRecords('excluded');
  assert.deepEqual(bodies.map(body => body.session_ids.length), [50, 1]);
  assert.deepEqual(Array.from(harness.context.hiddenSessionsUndo.sessionIds), ['other']);
  assert.equal(harness.context.recordDeletionConfirmations.size, 0);
  assert.equal(harness.context.liveStatus.textContent, '51 件の記録を削除しました。');
});

test('削除確認は現在の帯との交わりだけを数えて送る', async () => {
  const bodies = [];
  const sessions = ['still-hidden', 'active-again'].map(session_id => ({ session_id, hidden: true, hiddenAt: new Date().toISOString() }));
  const harness = recordDeletionHarness(sessions, async (_url, body) => {
    bodies.push(body);
    return { ok: true, json: async () => ({ deleted: { sessions: body.session_ids.length, pullRequests: 0 } }) };
  });
  harness.buttons().find(button => button.dataset.recordAction === 'open').listeners.click();
  harness.context.render({ sessions: [sessions[0], { ...sessions[1], hidden: false }], pullRequests: [] });

  const count = harness.nodes().find(node => node.tag === 'span' && node.textContent.includes('件の記録を削除します'));
  assert.equal(count.textContent, '1 件の記録を削除します。元に戻せません');
  await harness.context.deleteNoteRecords('excluded');

  assert.deepEqual(bodies.map(body => body.session_ids), [['still-hidden']]);
});

test('削除確認を開いた後に対象がなくなったら、描き直しで送らずに確認と帯を閉じる', async () => {
  let requests = 0;
  const session = { session_id: 'active-again', hidden: true, hiddenAt: new Date().toISOString() };
  const harness = recordDeletionHarness([session], async () => { requests += 1; });
  harness.buttons().find(button => button.dataset.recordAction === 'open').listeners.click();
  harness.context.render({ sessions: [{ ...session, hidden: false }], pullRequests: [] });
  assert.equal(harness.nodes().some(node => node.tag === 'span' && node.textContent.includes('件の記録を削除します')), false);
  assert.equal(harness.notes['excluded-note'].hidden, true);

  await harness.context.deleteNoteRecords('excluded');

  assert.equal(requests, 0);
  assert.equal(harness.context.recordDeletionConfirmations.has('excluded'), false);
});

test('帯の削除に失敗したら確認対象と元に戻す記録を残して再試行できる', async () => {
  const harness = recordDeletionHarness([{ session_id: 'retry', hidden: true, hiddenAt: new Date().toISOString() }], async () => { throw new Error('network'); });
  harness.context.hiddenSessionsUndo = { productName: '作業', sessionIds: ['retry'] };
  harness.buttons().find(button => button.dataset.recordAction === 'open').listeners.click();
  await harness.context.deleteNoteRecords('excluded');
  const confirmation = harness.context.recordDeletionConfirmations.get('excluded');
  assert.equal(confirmation.pending, false);
  assert.match(confirmation.error, /削除できませんでした/);
  assert.deepEqual(Array.from(harness.context.hiddenSessionsUndo.sessionIds), ['retry']);
  assert.equal(harness.buttons().find(button => button.dataset.recordAction === 'confirm').attributes['aria-disabled'], 'false');
});

test('削除の通信中も再描画でフォーカスを保ち、二重送信と取消を防ぐ', async () => {
  let resolveResponse;
  let requests = 0;
  const harness = recordDeletionHarness([{ session_id: 'pending', hidden: true, hiddenAt: new Date().toISOString() }], () => {
    requests += 1;
    return new Promise(resolve => { resolveResponse = resolve; });
  });
  harness.buttons().find(button => button.dataset.recordAction === 'open').listeners.click();
  harness.buttons().find(button => button.dataset.recordAction === 'confirm').focus();
  const request = harness.context.deleteNoteRecords('excluded');
  harness.context.render(harness.context.lastState);
  assert.equal(harness.activeElement.dataset.recordAction, 'confirm');
  assert.ok(harness.buttons().includes(harness.activeElement));
  assert.equal(harness.activeElement.attributes['aria-disabled'], 'true');
  await harness.context.deleteNoteRecords('excluded');
  harness.buttons().find(button => button.dataset.recordAction === 'cancel').listeners.click();
  assert.equal(requests, 1);
  assert.equal(harness.context.recordDeletionConfirmations.has('excluded'), true);
  resolveResponse({ ok: true, json: async () => ({ deleted: { sessions: 1, pullRequests: 0 } }) });
  await request;
});

test('設定画面から配信先のマニュアルの設定の節を新しいウィンドウで開く', () => {
  const settingsDialog = pageHtml.match(/<dialog class="settings-dialog" id="settings-dialog"[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(settingsDialog);
  assert.match(settingsDialog, /<a\b(?=[^>]*\bhref="https:\/\/ktysne\.info\/agent-cockpit\/manual\/#help-settings")(?=[^>]*\btarget="_blank")(?=[^>]*\brel="noopener")[^>]*>マニュアル<\/a>/);
});

test('モックの設定画面で診断ログがマニュアルの右にある', () => {
  const settingsActions = mockHtml.match(/<div class="settings-actions">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(settingsActions);
  const manualIndex = settingsActions.indexOf('>マニュアル</a>');
  const diagnosticsIndex = settingsActions.indexOf('>診断ログ</a>');
  assert.ok(manualIndex >= 0 && diagnosticsIndex > manualIndex);
  assert.match(settingsActions, /id="diagnostics-open"[^>]*href="#diagnostics-dialog"[^>]*>診断ログ<\/a>/);
});

test('モックの診断ログとポリシーに必要な操作がある', () => {
  const diagnosticsDialog = mockHtml.match(/<dialog class="diagnostics-dialog" id="diagnostics-dialog"[\s\S]*?<\/dialog>/)?.[0];
  const policyDialog = mockHtml.match(/<dialog class="diagnostics-policy-dialog" id="diagnostics-policy-dialog"[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(diagnosticsDialog && policyDialog);
  for (const id of [
    'diagnostics-level', 'diagnostics-run', 'diagnostics-source', 'diagnostics-refresh',
    'diagnostics-copy', 'diagnostics-export-run', 'diagnostics-export-all',
    'diagnostics-delete-run', 'diagnostics-delete-all', 'diagnostics-delete-confirm',
    'diagnostics-delete-cancel', 'diagnostics-policy-open',
  ]) assert.match(diagnosticsDialog, new RegExp(`id="${id}"`));
  assert.match(diagnosticsDialog, /選んだ起動を書き出す/);
  assert.match(diagnosticsDialog, /すべての起動を書き出す/);
  assert.match(diagnosticsDialog, /\(記録はまだありません\)/);
  assert.match(policyDialog, /あなたの操作なしに記録が外に出ることはありません/);
  assert.match(policyDialog, /2000 行まで/);
  assert.match(policyDialog, /記録しない情報/);
  assert.match(policyDialog, /記録する情報/);
});

test('判断事項は待ち時間を表示し、回答のない長い待ちだけを強調する', () => {
  const elapsed = functionSource(pageHtml, 'decisionElapsedLabel');
  const isLongWait = functionSource(pageHtml, 'isLongWait');
  const duration = functionSource(pageHtml, 'durationLabel');
  assert.ok(elapsed && isLongWait && duration);
  const fixedNow = Date.parse('2026-10-04T12:00:00.000Z');
  const { FakeDate } = createFakeClock(Date, fixedNow);
  const old = new FakeDate(fixedNow - (14 * 60 + 3) * 60_000 - 1_000).toISOString();
  const context = pageContext(pageHtml, {
    Date: FakeDate,
    displayPreferences: { longWaitMinutes: 15 },
    hasEffectiveAnswer: (decision) => Boolean(decision.answer?.sentAt && !decision.answer.ignoredAt),
  });
  vm.runInContext(`${duration}\n${isLongWait}\n${elapsed}`, context);

  const waiting = context.decisionElapsedLabel({ state: 'waiting', createdAt: old });
  const answered = context.decisionElapsedLabel({
    state: 'waiting', createdAt: old, answer: { sentAt: new FakeDate().toISOString() },
  });
  const now = fixedNow;
  const provisional = context.decisionElapsedLabel({
    state: 'provisional',
    provisionalAt: new FakeDate(now - 23 * 60_000 - 30_000).toISOString(),
    updatedAt: new FakeDate(now - 2 * 60_000 - 30_000).toISOString(),
  });
  const legacyProvisional = context.decisionElapsedLabel({
    state: 'provisional',
    updatedAt: new FakeDate(now - 2 * 60_000 - 30_000).toISOString(),
  });

  assert.deepEqual(JSON.parse(JSON.stringify(waiting)), {
    className: 'wait stale', label: '14 時間 3 分待機中', stale: true,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(answered)), {
    className: 'wait', label: '14 時間 3 分待機中', stale: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(provisional)), {
    className: 'since', label: '仮適用から 23 分', stale: false,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(legacyProvisional)), {
    className: 'since', label: '仮適用から 2 分', stale: false,
  });
  assert.equal(context.decisionElapsedLabel({ state: 'resolved', updatedAt: old }), null);
  assert.equal(context.decisionElapsedLabel({ state: 'withdrawn', updatedAt: old }), null);
});

test('ブラウザーに残った旧形式の表示設定を読んでも、サーバーの設定と同じ項目がそろう', () => {
  const sources = ['readDisplayPreferences', 'normalizeDisplayPreferences', 'normalizeSectionOrder', 'normalizeDisplayInteger']
    .map((name) => functionSource(pageHtml, name));
  const settings = pageHtml.match(/const DISPLAY_INTEGER_SETTINGS = \[[\s\S]*?\n\];/)?.[0];
  assert.ok(sources.every(Boolean) && settings);
  const minuteInputs = {
    longWaitMinutesInput: {}, awayAnswerWaitMinutesInput: {}, idleHideMinutesInput: {},
    ghConcurrencyLimitInput: {},
    longWaitMinutesError: {}, awayAnswerWaitMinutesError: {}, idleHideMinutesError: {},
    ghConcurrencyLimitError: {},
  };
  const storage = new Map();
  const context = pageContext(pageHtml, {
    ...minuteInputs,
    localStorage: { getItem: (key) => storage.get(key) ?? null },
    DISPLAY_STORAGE_KEY: 'agent-cockpit.display',
    FILTERS: [],
    SECTION_ORDER_KEYS: new Set(['sinceSeen', 'judgment', 'tasks', 'now', 'prs']),
    DEFAULT_SECTION_ORDER: ['sinceSeen', 'judgment', 'prs', 'tasks', 'now'],
    DEFAULT_LONG_WAIT_MINUTES: 15,
    DEFAULT_AWAY_ANSWER_WAIT_MINUTES: 3,
    DEFAULT_IDLE_HIDE_MINUTES: 10,
    DEFAULT_GH_CONCURRENCY_LIMIT: 8,
    TERMINAL_LABELS: { auto: '自動', 'windows-terminal': 'Windows Terminal', pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'コマンドプロンプト' },
  });
  vm.runInContext(`${settings}\n${sources.join('\n')}`, context);
  const expectedKeys = Object.keys(context.normalizeDisplayPreferences(null)).sort();

  storage.set('agent-cockpit.display', JSON.stringify({ mode: 'kind', longWaitMinutes: 20, mergeAfterReviewDefault: true }));
  const legacy = context.readDisplayPreferences();
  assert.deepEqual(Object.keys(legacy).sort(), expectedKeys);
  assert.equal(legacy.mode, 'kind');
  assert.equal(legacy.longWaitMinutes, 20);
  assert.equal(Object.hasOwn(legacy, 'mergeAfterReviewDefault'), false);

  storage.set('agent-cockpit.display', '{壊れた JSON');
  assert.deepEqual(Object.keys(context.readDisplayPreferences()).sort(), expectedKeys);
});

test('終わったセッションは待機中で未完了のものが無い場合だけと判定する', () => {
  const endedAgent = functionSource(pageHtml, 'isEndedAgent');
  const endedDecision = functionSource(pageHtml, 'isEndedDecision');
  const isFinished = [functionSource(pageHtml, 'runningBackgrounds'), functionSource(pageHtml, 'isFinishedSession')].join('\n');
  const status = functionSource(pageHtml, 'activityStatus');
  assert.ok(endedAgent && endedDecision && isFinished && status);
  const context = pageContext(pageHtml, {});
  vm.runInContext(`${endedAgent}\n${endedDecision}\n${status}\n${isFinished}`, context);

  const finished = {
    status: '待機中',
    tasks: [{ state: 'done' }],
    decisions: [{ state: 'resolved' }, { state: 'withdrawn' }],
    permissionWaits: [],
    agents: [{ active: false, unconfirmed: false }],
  };
  assert.equal(context.isFinishedSession(finished), true);
  for (const update of [
    { backgrounds: [{ taskId: 'task-a' }] },
    { tasks: [{ state: 'todo' }] },
    { tasks: [{ state: 'doing' }] },
    { tasks: [{ state: 'blocked' }] },
    { decisions: [{ state: 'waiting' }] },
    { decisions: [{ state: 'provisional' }] },
    { permissionWaits: [{}] },
    { agents: [{ active: true, unconfirmed: false }] },
    { agents: [{ active: false, unconfirmed: true }] },
    { status: '作業中' },
    { status: '中断' },
    { status: '不明' },
  ]) {
    assert.equal(context.isFinishedSession({ ...finished, ...update }), false, JSON.stringify(update));
  }
});

test('種類別の判断欄は期限、待ち時間、状態の順に並び、同順位では順序が安定する', () => {
  const names = ['hasEffectiveAnswer', 'kindWaitAge', 'kindDecisionWaitAge', 'kindPermissionWaitKey', 'kindJudgmentSortKey', 'compareKindJudgmentItems'];
  const functions = names.map((name) => functionSource(pageHtml, name));
  assert.ok(functions.every(Boolean));
  const context = pageContext(pageHtml, {});
  vm.runInContext(functions.join('\n'), context);

  const now = Date.now();
  const at = (minutes) => new Date(now + minutes * 60_000).toISOString();
  const sameStart = at(-90);
  const wait = (id, sessionId, startedAt) => ({ kind: 'permission', session: { session_id: sessionId }, wait: { target_tool_use_id: id, startedAt }, card: { id } });
  const decision = (id, sessionId, state, fields = {}) => ({ kind: 'decision', session: { session_id: sessionId }, decision: { id, state, createdAt: at(-30), updatedAt: at(-30), ...fields }, card: { id } });
  const items = [
    decision('sent', 'a', 'waiting', { createdAt: at(-600), answer: { sentAt: at(-1) } }),
    decision('provisional-at', 'a', 'provisional', { provisionalAt: at(-2), updatedAt: at(-100) }),
    decision('provisional-fallback', 'a', 'provisional', { updatedAt: at(-20) }),
    decision('ignored', 'a', 'provisional', { provisionalAt: at(-10), answer: { sentAt: at(-5), ignoredAt: at(-4) } }),
    decision('waiting-invalid-start', 'a', 'waiting', { createdAt: '時刻不明', awaitingAnswerUntil: '期限不明' }),
    decision('waiting-invalid-deadline', 'a', 'waiting', { createdAt: at(-30), awaitingAnswerUntil: '期限不明' }),
    wait('permission-old', 'z', at(-120)),
    wait('permission-tie', 'z', sameStart),
    decision('waiting-tie', 'a', 'waiting', { createdAt: sameStart }),
    decision('deadline-late', 'z', 'waiting', { createdAt: at(-120), awaitingAnswerUntil: at(15) }),
    decision('deadline-tie-z', 'z', 'waiting', { awaitingAnswerUntil: at(5) }),
    decision('deadline-tie-a', 'a', 'waiting', { awaitingAnswerUntil: at(5) }),
    decision('deadline-near', 'z', 'waiting', { createdAt: at(-1), awaitingAnswerUntil: at(2) }),
  ];
  const ordered = () => [...items].sort(context.compareKindJudgmentItems).map(({ card }) => card.id);
  const expected = [
    'deadline-near', 'deadline-tie-a', 'deadline-tie-z', 'deadline-late',
    'permission-old', 'waiting-tie', 'permission-tie', 'waiting-invalid-deadline', 'waiting-invalid-start',
    'provisional-fallback', 'ignored', 'provisional-at', 'sent',
  ];

  assert.deepEqual(ordered(), expected);
  assert.deepEqual(ordered(), expected);
});

test('種類別の今やっていることは行が無いとき本文を出さない', () => {
  const element = functionSource(pageHtml, 'element');
  const render = functionSource(pageHtml, 'renderKindSections');
  assert.ok(element && render);

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.className = '';
      this.textContent = '';
    }
    append(...nodes) { this.children.push(...nodes); }
  }
  const context = pageContext(pageHtml, {
    document: { createElement: (tagName) => new FakeElement(tagName) },
    DEFAULT_SECTION_ORDER: ['sinceSeen', 'judgment', 'prs', 'tasks', 'now'],
    expandedKindSections: new Set(),
    sessionReferences: () => [],
    kindEndedDecisionEntries: () => [],
    kindEndedAgentCount: () => 0,
    kindTodoTaskCount: () => 0,
    kindDoneTaskCount: () => 0,
    kindSection: (title, body) => ({ title, body }),
    orderedSectionKeys: (keys) => keys,
    isFilterShown: () => false,
  });
  const kindSort = ['hasEffectiveAnswer', 'kindWaitAge', 'kindDecisionWaitAge', 'kindPermissionWaitKey', 'kindJudgmentSortKey', 'compareKindJudgmentItems']
    .map((name) => functionSource(pageHtml, name)).join('\n');
  vm.runInContext(`${element}\n${kindSort}\n${render}`, context);

  const now = context.renderKindSections([]).find((section) => section.title === '今やっていること');
  assert.equal(now.body.className, 'body now');
  assert.equal(now.body.children.length, 0);
});

function reloadHarness(initialUiVersion, drafts = []) {
  const html = readWebPage();
  const functions = ['renderReloadNote', 'hasUnsentAnswerDraft', 'answerDraftChanged', 'answerValueFor', 'checkUiVersion', 'reloadNow', 'decisionAnswerAvailability', 'copyAnswerPicks', 'sameAnswerPicks', 'recommendedOptionsForQuestions']
    .map((name) => functionSource(html, name));
  assert.ok(functions.every(Boolean));

  let reloadCount = 0;
  const reloadNote = { hidden: true, innerHTML: '' };
  const context = pageContext(pageHtml, {
    initialUiVersion,
    uiUpdatePending: false,
    answerDrafts: new Map(drafts),
    reloadNote,
    location: { reload: () => { reloadCount += 1; } },
  });
  vm.runInContext(functions.join('\n'), context);
  return {
    context,
    reloadNote,
    get reloadCount() { return reloadCount; },
  };
}

function renderHarness(initialDraftNote = '保存済みの下書き') {
  const html = readWebPage();
  const focusDataFor = functionSource(html, 'focusDataFor');
  const render = functionSource(html, 'render');
  const renderDeferredState = functionSource(html, 'renderDeferredState');
  const visibleSinceSeen = functionSource(html, 'visibleSinceSeen');
  const hasCodexOrigin = functionSource(html, 'hasCodexOrigin');
  assert.ok(focusDataFor && render && visibleSinceSeen && hasCodexOrigin);
  assert.ok(renderDeferredState);

  let activeElement;
  class FakeTextArea {
    constructor() {
      this.dataset = { sessionId: 'session-ui', decisionId: 'decision-ui' };
      this.value = '';
      this.scrollTop = 0;
      this.style = { height: '' };
      this.undoHistory = [];
      this.selectionStart = 2;
      this.selectionEnd = 5;
      this.selectionDirection = 'backward';
      this.selection = [2, 5, 'backward'];
      this.focused = false;
    }

    hasAttribute(attribute) {
      return attribute === 'data-answer-note';
    }

    focus() {
      this.focused = true;
      activeElement = this;
    }

    setSelectionRange(start, end, direction) {
      this.selectionStart = start;
      this.selectionEnd = end;
      this.selectionDirection = direction;
      this.selection = [start, end, direction];
    }
  }
  const note = new FakeTextArea();
  note.value = '入力中の指示';
  note.scrollTop = 73;
  note.style.height = '154px';
  note.undoHistory = ['直前の入力'];
  activeElement = note;
  const placeholder = new FakeTextArea();
  const answerCard = {};
  note.closest = (selector) => selector === '.decision-answer' ? answerCard : null;
  let currentNote = note;
  let replacedNote = null;
  placeholder.replaceWith = (replacement) => {
    currentNote = replacement;
    replacedNote = replacement;
  };
  let renderCount = 0;
  const answerDrafts = new Map([['session-ui\0decision-ui', { choice: 'ok', note: initialDraftNote }]]);
  let answerDraftWriteCount = 0;
  let orderedSinceSeen = null;
  const setDraft = answerDrafts.set.bind(answerDrafts);
  answerDrafts.set = (...args) => {
    answerDraftWriteCount += 1;
    return setDraft(...args);
  };
  let updatedAnswerCard = null;
  const context = pageContext(pageHtml, {
    answerNoteComposing: false,
    deferredRenderPending: false,
    lastState: { sessions: [{ session_id: 'session-ui' }] },
    sinceSeenMode: 'always',
    header: { dataset: { away: 'false' } },
    HTMLTextAreaElement: FakeTextArea,
    answerDrafts,
    answerDraftKey: (sessionId, decisionId) => `${sessionId}\0${decisionId}`,
    answerDraftFor: () => answerDrafts.get('session-ui\0decision-ui'),
    findDecision: () => ({ id: 'decision-ui', answer: null }),
    updateAnswerSubmit: (card) => { updatedAnswerCard = card; },
    document: {
      get activeElement() { return activeElement; },
      querySelectorAll: () => [],
    },
    root: {
      replaceChildren: () => {
        renderCount += 1;
        note.focused = false;
        activeElement = null;
        currentNote = placeholder;
      },
      querySelectorAll: () => [currentNote],
    },
    displayPreferences: { mode: 'product', pinned: [], idleHideMinutes: 30 },
    renderRouting() {},
    renderSummary() {},
    renderExcludedNote() {},
    idleHiddenSessions: () => [],
    isIdleHiddenSession: () => false,
    sessionsAfterIdleFilter: (sessions) => sessions,
    renderIdleNote() {},
    finishedHiddenCounts: () => ({ sessions: 0, pullRequests: 0 }),
    finishedDeletionTargets: () => ({ session_ids: [], merge_history: [], closed_pull_requests: [] }),
    renderFinishedNote() {},
    updateTitle() {},
    orderedProducts: (_sessions, _pullRequests, sinceSeen) => {
      orderedSinceSeen = sinceSeen;
      return [{ key: 'product-ui' }];
    },
    productSection: () => ({}),
  });
  vm.runInContext(`${focusDataFor}\n${visibleSinceSeen}\n${hasCodexOrigin}\n${render}\n${renderDeferredState}`, context);
  return {
    context,
    get renderCount() { return renderCount; },
    note,
    placeholder,
    get currentNote() { return currentNote; },
    get replacedNote() { return replacedNote; },
    get answerDraftWriteCount() { return answerDraftWriteCount; },
    get answerDraft() { return answerDrafts.get('session-ui\0decision-ui'); },
    get updatedAnswerCard() { return updatedAnswerCard; },
    get orderedSinceSeen() { return orderedSinceSeen; },
    answerCard,
    html,
  };
}

function taskRenderHarness() {
  const html = readWebPage();
  const functions = ['element', 'appendExpandToggle', 'appendPlanToggle', 'taskVisibility', 'appendTasks']
    .map((name) => functionSource(html, name));
  assert.ok(functions.every(Boolean));

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.textContent = '';
      this.className = '';
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(_event, callback) { this.onClick = callback; }
    focus() {}
  }

  const context = pageContext(pageHtml, {
    document: { createElement: (tagName) => new FakeElement(tagName) },
    expandedTodoTasks: new Set(),
    expandedDoneTasks: new Set(),
    pendingTaskCloseActions: new Map(),
    taskCloseActionsInFlight: new Set(),
    lastState: null,
    root: { querySelectorAll: () => [] },
    durationAgoLabel: () => '',
    appendTaskItem: (list, task) => {
      const item = new FakeElement('li');
      item.dataset.taskId = task.id;
      list.append(item);
    },
  });
  vm.runInContext(functions.join('\n'), context);

  const render = (session) => {
    const body = new FakeElement('div');
    context.appendTasks(body, session, { name: 'product' });
    return body;
  };
  const descendants = (node) => [node, ...(node.children || []).flatMap(descendants)];
  return { context, render, descendants };
}

function externalLinkHarness(responseStatus) {
  const html = readWebPage();
  const postUiAction = functionSource(html, 'postUiAction');
  const openExternalLink = functionSource(html, 'openExternalLink');
  const defaultBrowserUrl = functionSource(html, 'defaultBrowserUrl');
  const handleExternalLink = functionSource(html, 'handleExternalLink');
  const clickHandler = sourceBetween(html, "document.addEventListener('click', (event) => {", '\n});', true);
  const auxclickHandler = sourceBetween(html, "document.addEventListener('auxclick', (event) => {", '\n});', true);
  assert.ok(clickHandler && auxclickHandler);

  const listeners = {};
  const requests = [];
  const openedWindows = [];
  const context = pageContext(pageHtml, {
    URL,
    document: {
      addEventListener: (type, listener) => { listeners[type] = listener; },
      querySelector: () => ({ content: 'ui-secret' }),
    },
    window: {
      location: { href: 'http://127.0.0.1:47821/', origin: 'http://127.0.0.1:47821' },
      open: (...args) => openedWindows.push(args),
    },
    fetch: async (url, options) => {
      requests.push({ url, options });
      return { status: responseStatus, ok: responseStatus >= 200 && responseStatus < 300 };
    },
  });
  vm.runInContext([
    functionSource(html, 'reportWebFailure'),
    postUiAction,
    openExternalLink,
    defaultBrowserUrl,
    handleExternalLink,
    clickHandler,
    auxclickHandler,
  ].join('\n'), context);
  return { listeners, requests, openedWindows };
}

test('外部 HTTPS リンクのクリックをサーバーへ送り、失敗時だけウィンドウで開く', async () => {
  const harness = externalLinkHarness(500);
  const link = {
    href: 'https://github.com/acme/widget/pull/42',
    closest: (selector) => selector === 'a[target="_blank"]' ? link : null,
  };
  let defaultPrevented = false;
  harness.listeners.click({ target: link, button: 0, preventDefault: () => { defaultPrevented = true; } });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(defaultPrevented, true);
  assert.equal(harness.requests[0].url, '/api/open-url');
  assert.equal(harness.requests[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(harness.requests[0].options.body), { url: link.href });
  assert.deepEqual(harness.openedWindows, [[link.href, '_blank', 'noopener,noreferrer']]);

  const httpLink = {
    href: 'http://example.com',
    closest: (selector) => selector === 'a[target="_blank"]' ? httpLink : null,
  };
  let httpDefaultPrevented = false;
  harness.listeners.click({ target: httpLink, button: 0, preventDefault: () => { httpDefaultPrevented = true; } });
  assert.equal(httpDefaultPrevented, false);
  assert.equal(harness.requests.length, 1);

  const middleLink = { ...link };
  let middleDefaultPrevented = false;
  harness.listeners.auxclick({
    target: middleLink,
    button: 1,
    preventDefault: () => { middleDefaultPrevented = true; },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(middleDefaultPrevented, true);
  assert.equal(harness.requests.length, 2);
});

test('配信先のマニュアルリンクはサーバーへ送り、同じオリジンのリンクは /manual/ も含めて送らない', async () => {
  const harness = externalLinkHarness(204);
  const manualLink = {
    href: 'https://ktysne.info/agent-cockpit/manual/#help-settings',
    closest: (selector) => selector === 'a[target="_blank"]' ? manualLink : null,
  };
  let manualDefaultPrevented = false;
  harness.listeners.click({
    target: manualLink,
    button: 0,
    preventDefault: () => { manualDefaultPrevented = true; },
  });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(manualDefaultPrevented, true);
  assert.equal(harness.requests.length, 1);
  assert.deepEqual(JSON.parse(harness.requests[0].options.body), { url: manualLink.href });
  assert.deepEqual(harness.openedWindows, []);

  for (const href of ['http://127.0.0.1:47821/settings', 'http://127.0.0.1:47821/manual/#help-settings']) {
    const sameOriginLink = {
      href,
      closest: (selector) => selector === 'a[target="_blank"]' ? sameOriginLink : null,
    };
    let sameOriginDefaultPrevented = false;
    harness.listeners.click({
      target: sameOriginLink,
      button: 0,
      preventDefault: () => { sameOriginDefaultPrevented = true; },
    });
    assert.equal(sameOriginDefaultPrevented, false, href);
  }
  assert.equal(harness.requests.length, 1);
});

test('外部 HTTPS リンクをサーバーが開けたときはフォールバックを使わない', async () => {
  const harness = externalLinkHarness(204);
  const link = {
    href: 'https://github.com/acme/widget/actions',
    closest: (selector) => selector === 'a[target="_blank"]' ? link : null,
  };
  harness.listeners.click({ target: link, button: 0, preventDefault() {} });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(harness.requests.length, 1);
  assert.deepEqual(harness.openedWindows, []);
});

test('同じ画面の版では読み込み直さない', () => {
  const harness = reloadHarness('v1');
  assert.equal(harness.context.checkUiVersion({ uiVersion: 'v1' }), false);
  assert.equal(harness.reloadCount, 0);
  assert.equal(harness.reloadNote.hidden, true);
});

test('サーバーの画面の版が null なら読み込み直さない', () => {
  const harness = reloadHarness('v1');
  assert.equal(harness.context.checkUiVersion({ uiVersion: null }), false);
  assert.equal(harness.reloadCount, 0);
  assert.equal(harness.reloadNote.hidden, true);
});

test('新しい画面の版は下書きが無ければ読み込み直す', () => {
  const harness = reloadHarness('v1');
  assert.equal(harness.context.checkUiVersion({ uiVersion: 'v2' }), true);
  assert.equal(harness.reloadCount, 1);
});

const DRAFT_KEY = 'session-1\u0000d1';
const answerableState = (answer = null, state = 'provisional') => ({
  uiVersion: 'v2',
  sessions: [{ session_id: 'session-1', decisions: [{ id: 'd1', state, questions: [], answer }] }],
});

test('新しい画面の版は書きかけがあれば知らせ、書きかけを消した後に読み込む', () => {
  const harness = reloadHarness('v1', [[DRAFT_KEY, { choice: 'ok', note: '', picks: [] }]]);
  assert.equal(harness.context.checkUiVersion(answerableState()), false);
  assert.equal(harness.reloadCount, 0);
  assert.equal(harness.reloadNote.hidden, false);
  assert.equal(harness.reloadNote.innerHTML, '<span>画面が新しくなりました。この画面からは送信できないので、書きかけの回答を控えてから読み込み直してください。</span><button type="button" class="link-btn" data-reload-now>今すぐ読み込み直す</button>');

  harness.context.answerDrafts.set(DRAFT_KEY, { choice: null, note: '', picks: [] });
  assert.equal(harness.context.checkUiVersion(answerableState()), true);
  assert.equal(harness.reloadCount, 1);
});

test('送った回答と同じ下書きは書きかけと数えない', () => {
  const sent = { choice: 'ok', note: 'メモ', picks: [], sentAt: '2026-10-03T00:00:00.000Z' };
  const harness = reloadHarness('v1', [[DRAFT_KEY, { choice: 'ok', note: 'メモ', picks: [] }]]);
  assert.equal(harness.context.checkUiVersion(answerableState(sent)), true);

  const changed = reloadHarness('v1', [[DRAFT_KEY, { choice: 'ok', note: '書き足し', picks: [] }]]);
  assert.equal(changed.context.checkUiVersion(answerableState(sent)), false);

  const unchecked = reloadHarness('v1', [[DRAFT_KEY, { choice: null, note: 'メモ', picks: [] }]]);
  assert.equal(unchecked.context.checkUiVersion(answerableState(sent)), true);
});

test('回答できなくなった判断事項と消えた判断事項の下書きは書きかけと数えない', () => {
  const draft = [[DRAFT_KEY, { choice: 'ok', note: '書きかけ', picks: [] }]];
  assert.equal(reloadHarness('v1', draft).context.checkUiVersion(answerableState(null, 'resolved')), true);
  assert.equal(reloadHarness('v1', draft).context.checkUiVersion({ uiVersion: 'v2', sessions: [] }), true);
});

test('自分の画面の版が空なら読み込み直さない', () => {
  const harness = reloadHarness('');
  assert.equal(harness.context.checkUiVersion({ uiVersion: 'v2' }), false);
  assert.equal(harness.reloadCount, 0);
  assert.equal(harness.reloadNote.hidden, true);
});

test('今すぐ読み込み直す操作は下書きがあっても再読み込みする', () => {
  const harness = reloadHarness('v1', [[DRAFT_KEY, { choice: 'ok', note: '書きかけ', picks: [] }]]);
  harness.context.reloadNow({ target: { closest: (selector) => selector === '[data-reload-now]' } });
  assert.equal(harness.reloadCount, 1);
});

test('作業中ツールは表示幅を超えた部分を CSS の省略記号で示す', () => {
  const source = readWebPage();
  const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');
  const style = (html, selector) => Object.fromEntries(cssDeclarations(html, selector));
  const sortedStyle = (html, selector) => Object.entries(style(html, selector)).sort();

  for (const selector of ['.tool-content', '.tool-line', '.tool-name']) {
    assert.deepEqual(sortedStyle(source, selector), sortedStyle(mock, selector), selector);
  }
  assert.equal(style(source, '.tool-content')['text-overflow'], 'ellipsis');
  assert.equal(style(source, '.tool-content')['white-space'], 'nowrap');
  assert.equal(style(source, '.tool-content').overflow, 'hidden');
  assert.equal(style(source, '.tool-content')['min-width'], '0');
  assert.equal(style(source, '.now-row > .detail')['min-width'], '0');
  assert.equal(style(source, '.agent-row > .detail')['min-width'], '0');
  assert.equal(style(source, '.now-row > .detail')['grid-column'], '1 / -1');
  assert.equal(style(source, '.agent-row > .detail')['grid-column'], '1 / -1');
  assert.equal(style(mock, '.now-row > .detail')['grid-column'], '1 / -1');
  assert.equal(style(mock, '.agent-row > .detail')['grid-column'], '1 / -1');
  assert.equal(style(source, '.session-extra')['grid-column'], '1 / -1');
  assert.equal(style(mock, '.session-extra')['grid-column'], '1 / -1');
  assert.equal(style(source, '.tool-line')['flex-wrap'], 'nowrap');
  assert.equal(style(source, '.tool-name').flex, 'none');
  assert.equal(style(source, '.tool-name')['max-width'], '60%');
  assert.equal(style(source, '.tool-name')['text-overflow'], 'ellipsis');
  assert.equal(style(source, '.tool-name')['white-space'], 'nowrap');
  assert.equal(style(source, '.now-row')['grid-template-columns'], 'minmax(0, 1fr) auto');
  assert.equal(style(source, '.agent-row')['grid-template-columns'], 'minmax(0, 1fr) auto');
  assert.equal(style(mock, '.now-row')['grid-template-columns'], 'minmax(0, 1fr) auto');
  assert.equal(style(mock, '.agent-row')['grid-template-columns'], 'minmax(0, 1fr) auto');
  assert.equal(style(source, '.who strong').display, undefined);
  assert.equal(style(source, '.now-row .who .prod-tag').display, undefined);
  const mockMeta = style(mock, '.meta');
  assert.equal(mockMeta['text-overflow'], undefined);
  assert.equal(mockMeta['white-space'], undefined);
  assert.equal(mockMeta.overflow, undefined);
  assert.equal(style(mock, '.now-row > :nth-child(2)')['min-width'], undefined);
});

test('終了ボタンは状態と名前を含む flex 行の右端に置く', () => {
  const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');
  const mobileRules = sourceBetween(pageHtml, '@media (max-width: 640px) {', '\n}')?.slice('@media (max-width: 640px) {'.length);
  assert.ok(mobileRules);

  assert.match(pageHtml, /if \(agent\.closable\) \{[\s\S]*?name\.append\(close\);/);
  assert.equal(Object.fromEntries(cssDeclarations(pageHtml, '.agent-name'))['flex-wrap'], 'wrap');
  assert.equal(Object.fromEntries(cssDeclarations(pageHtml, '.close-agent'))['margin-left'], 'auto');
  const mobileHtml = `<style>${mobileRules}</style>`;
  for (const selector of ['.now-row', '.agent-row']) {
    assert.equal(Object.fromEntries(cssDeclarations(mobileHtml, selector))['grid-template-columns'], undefined);
  }
  assert.match(mock, /const isClosable = \(session, agent\) => \(\(agent\.state !== 'busy' && !!agent\.unconfirmed\) \|\| isMainBackgroundCodex\(agent\) \|\| \(!agent\.isCodex && agent\.backgrounded === true && agent\.state === 'busy'\)\)/);
  assert.match(mock, /<span class="agent-name"><span class="badge \$\{state\[1\]\}">[\s\S]*?\$\{close\}<\/span>/);
  assert.equal(Object.fromEntries(cssDeclarations(mock, '.agent-name'))['flex-wrap'], 'wrap');
  assert.equal(Object.fromEntries(cssDeclarations(mock, '.close-agent'))['margin-left'], 'auto');
});

test('作業行は先頭に名前と時刻を置き、詳細と状態不明の操作を全幅で続ける', () => {
  const functions = ['element', 'appendToolLine', 'sessionDisplayName', 'appendContextTags', 'appendUnknownSessionControls', 'sessionOrigin', 'runningBackgrounds', 'mainRow', 'backgroundRow', 'appendBackgrounds', 'appendAgents']
    .map((name) => functionSource(pageHtml, name));
  assert.ok(functions.every(Boolean));

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.childNodes = this.children;
      this.className = '';
      this.dataset = {};
    }
    append(...nodes) { this.children.push(...nodes); }
  }

  const context = pageContext(pageHtml, {
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => ({ nodeType: 'text', textContent: text }),
    },
    activityStatus: (session) => session.rowStatus,
    durationAgoLabel: () => '1 分前',
    relativeTimeElement: (value, className, label) => {
      const time = new FakeElement('time');
      time.className = className;
      time.textContent = label;
      return time;
    },
    badge: (text, className) => {
      const tag = new FakeElement('span');
      tag.className = `badge ${className}`;
      tag.textContent = text;
      return tag;
    },
    unknownSessionControls: (session) => session.controls || null,
    expandedEndedSessions: new Set(),
    displayPreferences: { hideFinished: true },
    isFilterShown: () => true,
    isEndedAgent: (agent) => !agent.active && !agent.unconfirmed,
    newestFirst: (items) => items,
    appendModelLine: (target, agent) => {
      if (agent.model || agent.route) target.append(Object.assign(new FakeElement('div'), { className: 'models' }));
    },
  });
  vm.runInContext(functions.join('\n'), context);

  const product = { name: 'agent-cockpit' };
  const session = {
    session_id: 'session-main',
    title: 'メインセッション',
    rowStatus: { tone: 'busy', label: '作業中' },
    lastActivityAt: '2026-10-05T00:00:00.000Z',
    tasks: [{ state: 'doing', title: 'タスクの題' }],
    tools: [{ tool_name: 'Bash', summary: 'npm test', startedAt: '2026-10-05T00:00:00.000Z' }],
  };
  const main = context.mainRow(session, product, true, true);
  assert.deepEqual(main.children.map((child) => child.className), ['who', 'since', 'detail']);
  assert.deepEqual(main.children[2].children.map((child) => child.className), ['activity-title', 'tool-line']);
  assert.deepEqual(main.children[0].children.map((child) => child.className || child.textContent), ['dot busy', 'メイン', 'prod-tag', 'session-tag', '作業中']);
  assert.equal(main.children[0].children.at(-1).textContent, '作業中');

  const waiting = context.mainRow({
    ...session,
    rowStatus: { tone: 'wait', label: '待機中' },
    tasks: [],
    tools: [],
  }, product);
  assert.deepEqual(waiting.children.map((child) => child.className), ['who', 'since']);

  const background = { taskId: 'task-a', agent_id: 'background:task-a', description: 'テストを実行',
    tool_name: 'Bash', summary: 'npm test', startedAt: session.lastActivityAt };
  const backgroundSession = { ...session, rowStatus: { tone: 'wait', label: '待機中' }, backgrounds: [background] };
  const waitingBackground = context.mainRow(backgroundSession, product);
  assert.equal(waitingBackground.children[0].children.at(-1).textContent, '待機中(バックグラウンドタスク 1 件)');
  const backgroundBody = new FakeElement('div');
  context.appendBackgrounds(backgroundBody, backgroundSession, product);
  assert.equal(backgroundBody.children[0].textContent, 'バックグラウンドタスク');
  const backgroundRow = backgroundBody.children[1].children[0];
  assert.deepEqual(backgroundRow.children.map((child) => child.className), ['who', 'since', 'detail']);
  assert.equal(backgroundRow.children[0].children[1].textContent, 'バックグラウンドタスク');
  const name = backgroundRow.children[0].children.at(-1);
  assert.equal(name.children[0].textContent, '稼働中');
  assert.equal(name.children[1].dataset.closeAgent, 'session-main::background:task-a');
  assert.equal(backgroundRow.children[2].children[0].textContent, 'テストを実行');
  assert.equal(backgroundRow.children[2].children[1].className, 'tool-line');

  const controls = Object.assign(new FakeElement('div'), { className: 'session-extra' });
  const unknown = context.mainRow({
    ...session,
    rowStatus: { tone: 'unknown', label: '状態不明' },
    tasks: [],
    tools: [],
    controls,
  }, product);
  assert.deepEqual(unknown.children.map((child) => child.className), ['who', 'session-extra']);
  assert.equal(unknown.children[0].children.at(-1).textContent, '状態不明 (1 分前)');

  const body = new FakeElement('div');
  context.appendAgents(body, {
    ...session,
    permissionWaits: [],
    agents: [
      { agent_id: 'with-description', agent_type: '実装', active: true, closable: true, description: '依頼の説明', model: 'Sonnet', route: 'Claude', startedAt: '2026-10-05T00:00:00.000Z' },
      { agent_id: 'with-tool', agent_type: '確認', active: true, lastTool: { tool_name: 'Read', summary: 'src/web/index.html' }, startedAt: '2026-10-05T00:00:00.000Z' },
    ],
  }, product, true, true, false, false);
  const [agentList] = body.children.filter((child) => child.className === 'agent-list');
  const [described, toolOnly] = agentList.children;
  assert.deepEqual(described.children.map((child) => child.className), ['who', 'since', 'detail']);
  assert.deepEqual(described.children[2].children.map((child) => child.className), ['agent-description', 'models']);
  assert.deepEqual(described.children[0].children.map((child) => child.className), ['dot busy', 'prod-tag', 'session-tag', 'agent-name']);
  assert.deepEqual(described.children[0].children.at(-1).children.map((child) => child.className || child.textContent), ['badge busy', '実装', 'link-btn close-agent']);
  assert.deepEqual(toolOnly.children[2].children.map((child) => child.className), ['tool-line']);
});

test('モックの作業行も名前と時刻の後に全幅の詳細を並べる', () => {
  const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8').replace(/\r\n/g, '\n');
  const functions = ['sessionOrigin', 'runningBackgrounds', 'mainRow', 'agentRow'].map((name) => functionSource(mock, name));
  assert.ok(functions.every(Boolean));
  const context = pageContext(mock, {
    ui: { estimatedSessions: [] },
    taskState: (session, task) => task.state,
    esc: (value) => String(value),
    sessionTag: () => '<span class="prod-tag">種類</span><span class="session-tag">セッション</span>',
    renderToolLine: () => '<div class="tool-line"></div>',
    unknownSessionControls: (session) => session.unknown ? '<div class="session-extra"></div>' : '',
    isClosedByUser: () => false,
    isBusyAgent: () => true,
    isUnconfirmed: () => false,
    isClosable: () => true,
    closedAgentKey: () => 'session::agent',
    modelLine: () => '<div class="models"></div>',
    routeTag: () => '',
  });
  vm.runInContext(functions.join('\n'), context);

  const busyMain = context.mainRow({}, {
    id: 'session', status: 'busy', tasks: [{ state: 'doing', title: 'タスクの題' }],
    main: { tool: 'Bash: npm test', since: '1 分前' },
  }, true);
  assert.ok(busyMain.indexOf('class="who"') < busyMain.indexOf('class="since"'));
  assert.ok(busyMain.indexOf('class="since"') < busyMain.indexOf('class="detail"'));
  assert.ok(busyMain.indexOf('class="activity-title"') < busyMain.indexOf('class="tool-line"'));

  const waitingMain = context.mainRow({}, {
    id: 'session', status: 'wait', tasks: [], main: { tool: '—', since: '27 分前' },
  }, false);
  assert.ok(!waitingMain.includes('class="detail"'));

  const unknownMain = context.mainRow({}, {
    id: 'unknown', status: 'unknown', tasks: [], main: {}, unknown: true,
  }, false);
  assert.ok(!unknownMain.includes('class="since"'));
  assert.ok(unknownMain.indexOf('class="who"') < unknownMain.indexOf('class="session-extra"'));

  const describedAgent = context.agentRow({}, { id: 'session', perms: [] }, {
    id: 'agent', type: '実装', text: '依頼の説明', since: '1 分前',
  }, true);
  assert.ok(describedAgent.indexOf('class="who"') < describedAgent.indexOf('class="since"'));
  assert.ok(describedAgent.indexOf('class="since"') < describedAgent.indexOf('class="detail"'));
  assert.ok(describedAgent.indexOf('class="agent-description"') < describedAgent.indexOf('class="models"'));

  const toolOnlyAgent = context.agentRow({}, { id: 'session', perms: [] }, {
    id: 'agent', type: '確認', text: '', tool: 'Read: src/web/index.html', since: '2 分前',
  }, false);
  assert.ok(toolOnlyAgent.indexOf('class="tool-line"') < toolOnlyAgent.indexOf('class="models"'));
});

test('経路の段は連携に応じて表示し、無効なサブエージェントの札を隠す', () => {
  const html = readWebPage();
  const routing = sourceBetween(html, 'function routeName', '\nasync function updateRouting');
  const routeTag = sourceBetween(html, 'function routeTag', '\nfunction appendModelLine');
  assert.ok(routing && routeTag);

  const root = {
    innerHTML: '',
    hidden: false,
    dataset: {},
    querySelectorAll() { return []; },
  };
  const document = { getElementById: () => root, querySelector: () => null };
  const context = pageContext(pageHtml, {
    ROUTE: {
      agents: { label: 'サブエージェント', opts: [{ v: 'default', t: '既定' }, { v: 'codex', t: 'Codex' }, { v: 'claude', t: 'Claude' }] },
      review: { label: 'クロスレビュー', opts: [{ v: 'default', t: '既定' }, { v: 'codex', t: 'Codex' }, { v: 'claude', t: 'Claude' }] },
    },
    ROUTE_VALUES: new Set(['default', 'codex', 'claude']),
    routing: { agents: 'default', review: 'default' },
    codexAgentAvailable: false,
    crossReviewAvailable: false,
    document,
    getComputedStyle: () => ({ columnGap: '10px' }),
    window: {},
    element: (_tag, className, textContent = '') => ({ className, textContent }),
  });
  vm.runInContext(`${routing}\n${routeTag}\nthis.renderRouting = renderRouting; this.routeTag = routeTag;`, context);

  context.renderRouting({ agents: 'codex', review: 'claude' }, { codexAgent: false });
  assert.equal(root.hidden, true);
  assert.equal(root.innerHTML, '');
  assert.equal(context.routeTag({ active: true, route: 'codex' }), null);

  context.renderRouting({ agents: 'codex', review: 'claude' }, { crossReview: true });
  assert.equal(root.hidden, false);
  assert.equal((root.innerHTML.match(/data-route="review"/g) || []).length, 3);
  assert.doesNotMatch(root.innerHTML, /data-route="agents"/);

  context.renderRouting({ agents: 'codex', review: 'claude' }, { codexAgent: true });
  assert.equal(root.hidden, false);
  assert.equal((root.innerHTML.match(/data-route="agents"/g) || []).length, 3);
  assert.doesNotMatch(root.innerHTML, /data-route="review"/);

  context.renderRouting({ agents: 'codex', review: 'claude' }, { codexAgent: true, crossReview: true });
  assert.ok(root.innerHTML.indexOf('data-route="agents"') < root.innerHTML.indexOf('data-route="review"'));
  assert.equal((root.innerHTML.match(/data-route="agents"/g) || []).length, 3);
  assert.equal((root.innerHTML.match(/data-route="review"/g) || []).length, 3);
  assert.doesNotMatch(root.innerHTML, /aria-describedby|未対応/);
});

test('クロスレビューの行は往復数と head の状態を表示する', () => {
  const html = readWebPage();
  const helpers = sourceBetween(html, 'function element(tag, className, text)', 'function durationLabel');
  const component = sourceBetween(html, 'const MERGE_METHOD_LABELS', 'function appendPullRequestBlock');
  assert.ok(helpers && component);

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.textContent = '';
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  class FakeText {
    constructor(text) { this.textContent = text; }
  }
  const context = pageContext(pageHtml, {
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
    },
    pullRequestReviewSkipInFlight: new Set(),
  });
  vm.runInContext(`${helpers}\n${component}`, context);

  const textOf = (node) => node.children?.length ? node.children.map(textOf).join('') : node.textContent;
  const allNodes = (root) => [root, ...(root.children || []).flatMap(allNodes)];
  const headSha = 'a'.repeat(40);
  const line = (pullRequest) => context.crossReviewLine(reviewPr(pullRequest));

  const absent = { headRefOid: headSha };
  assert.equal(line(absent), null);
  assert.equal(context.crossReviewState(reviewPr(absent)).warn, null);
  assert.match(html, /if \(pullRequest\.review\.display\.visible\) text\.append\(crossReviewLine\(pullRequest\)\)/);

  const missing = line({ headRefOid: headSha, crossReview: null });
  const missingBadge = allNodes(missing).find((node) => node.className?.startsWith('badge'));
  assert.match(textOf(missing), /現在の head の記録がありません。クロスレビューを実施するか、レビュー不要にする操作で記録してください。レビュー未実施/);
  assert.equal(missingBadge.className, 'badge warn');

  const changed = line({
    headRefOid: 'b'.repeat(40),
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: headSha },
  });
  const changedBadge = allNodes(changed).find((node) => node.className?.startsWith('badge'));
  assert.match(textOf(changed), /現在の head の記録がありません。.*2 \/ 3 往復、非対応 1 レビューの後に変更あり \(レビュー済み aaaaaaa\)/);
  assert.equal(changedBadge.className, 'badge warn');
  assert.ok(!textOf(changed).includes(headSha));

  const reviewed = line({
    headRefOid: headSha,
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: headSha },
  });
  const reviewedBadge = allNodes(reviewed).find((node) => node.className?.startsWith('badge'));
  assert.equal(textOf(reviewed), 'クロスレビュー 2 / 3 往復、非対応 1 この head をレビューに回した');
  assert.equal(reviewedBadge.className, 'badge mute');

  const notRequired = line({ headRefOid: headSha, crossReview: { notRequired: true, source: 'tool-absent' } });
  const notRequiredBadge = allNodes(notRequired).find((node) => node.className?.startsWith('badge'));
  assert.equal(textOf(notRequired), 'クロスレビュー レビュー不要');
  assert.equal(notRequiredBadge.className, 'badge mute');

  const recordedNotRequired = line({
    headRefOid: headSha,
    mergeRecordKey: 'recorded-key',
    crossReview: { notRequired: true, source: 'recorded', reason: '軽微な変更のため' },
  });
  const undo = allNodes(recordedNotRequired).find((node) => node.dataset?.reviewSkip === 'clear');
  assert.equal(undo.textContent, 'レビュー不要を取り消す');
  assert.equal(allNodes(recordedNotRequired).find((node) => node.className?.startsWith('badge')).title, '軽微な変更のため');

  const waitingForTriage = context.crossReviewState(reviewPr({
    headRefOid: headSha,
    crossReview: { round: 3, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: 'b'.repeat(40), outcome: 'fixing' } },
  }));
  assert.equal(waitingForTriage.text, '3 往復目の結論待ち');
  assert.equal(waitingForTriage.warn, 'クロスレビューの 3 往復目の結論がまだ出ていない');

  const convergedButNextRound = context.crossReviewState(reviewPr({
    headRefOid: headSha,
    crossReview: { round: 3, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: headSha, outcome: 'converged' } },
  }));
  assert.deepEqual([convergedButNextRound.text, convergedButNextRound.cls], ['3 往復目の結論待ち', 'warn']);

  const triageAheadOfRound = context.crossReviewState(reviewPr({
    headRefOid: headSha,
    crossReview: { round: 1, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 3, sha: 'b'.repeat(40), outcome: 'fixing' } },
  }));
  assert.equal(triageAheadOfRound.text, 'この head をレビューに回した');

  const fixing = context.crossReviewState(reviewPr({
    headRefOid: headSha,
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: headSha, outcome: 'fixing' } },
  }));
  assert.equal(fixing.text, '指摘の対応中');
  assert.equal(fixing.warn, 'クロスレビューの 2 往復目の指摘に対応している途中');

  const halted = context.crossReviewState(reviewPr({
    headRefOid: headSha,
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: headSha, outcome: 'halted' } },
  }));
  assert.equal(halted.text, '開発者の判断待ち');
  assert.equal(halted.warn, 'クロスレビューは開発者の判断を待って止まっている');

  const converged = line({
    headRefOid: 'c'.repeat(64),
    crossReview: {
      round: 2, max: 3, dismissed: 1, reviewedSha: null,
      triage: { round: 2, sha: 'c'.repeat(64).toUpperCase(), outcome: 'converged' },
    },
  });
  const convergedBadge = allNodes(converged).find((node) => node.className?.startsWith('badge'));
  assert.equal(convergedBadge.textContent, 'レビュー済み');
  assert.equal(convergedBadge.className, 'badge ok');
  assert.equal(context.crossReviewState(reviewPr({
    headRefOid: headSha,
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: null, triage: { round: 2, sha: headSha, outcome: 'converged' } },
  })).warn, null);

  const changedAfterConvergence = context.crossReviewState(reviewPr({
    headRefOid: 'c'.repeat(40),
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: 'b'.repeat(64), outcome: 'converged' } },
  }));
  assert.equal(changedAfterConvergence.text, '収束の後に変更あり (収束 bbbbbbb)');
  assert.equal(changedAfterConvergence.warn, 'head ccccccc はクロスレビューの収束の後に変更されている (収束は bbbbbbb)');
  const changedConvergenceLine = line({
    headRefOid: 'c'.repeat(40),
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: 'b'.repeat(64), outcome: 'converged' } },
  });
  const changedConvergenceBadge = allNodes(changedConvergenceLine).find((node) => node.className?.startsWith('badge'));
  assert.equal(changedConvergenceBadge.textContent, '収束の後に変更あり (収束 bbbbbbb)');
  assert.equal(changedConvergenceBadge.className, 'badge warn');

  const unverifiableConvergence = context.crossReviewState(reviewPr({
    headRefOid: 'short-sha',
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: headSha, outcome: 'converged' } },
  }));
  assert.equal(unverifiableConvergence.text, 'head を確かめられない');
  assert.equal(unverifiableConvergence.warn, 'head を確かめられない');

  const unverifiable = line({
    headRefOid: headSha,
    crossReview: { round: 1, max: 3, dismissed: 0, reviewedSha: null },
  });
  const unverifiableBadge = allNodes(unverifiable).find((node) => node.className?.startsWith('badge'));
  assert.match(textOf(unverifiable), /現在の head の記録がありません。.*1 \/ 3 往復、非対応 0 head を確かめられない$/);
  assert.equal(unverifiableBadge.className, 'badge mute');
  assert.ok(!textOf(unverifiable).includes('レビューの後に変更あり'));

  const skipButtonOf = (crossReview, headRefOid = headSha) => allNodes(line({ headRefOid, mergeRecordKey: 'skip-key', crossReview }))
    .find((node) => node.dataset?.reviewSkip === 'set');
  assert.ok(skipButtonOf(null));
  assert.ok(skipButtonOf({ unavailable: true }));
  assert.ok(skipButtonOf({ round: 2, max: 3, dismissed: 1, reviewedSha: headSha }, 'b'.repeat(40)));
  assert.ok(skipButtonOf({ round: 2, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: headSha, outcome: 'fixing' } }));
  assert.ok(skipButtonOf({ round: 2, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: 'b'.repeat(40), outcome: 'converged' } }));
  assert.equal(skipButtonOf({ round: 2, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: headSha, outcome: 'converged' } }), undefined);
  assert.equal(skipButtonOf({ round: 2, max: 3, dismissed: 1, reviewedSha: headSha }), undefined);
  assert.ok(skipButtonOf({ round: 1, max: 3, dismissed: 0, reviewedSha: null }));

  const changedAfter64DigitReview = context.crossReviewState(reviewPr({
    headRefOid: 'e'.repeat(64),
    crossReview: { round: 1, max: 3, dismissed: 0, reviewedSha: 'd'.repeat(64) },
  }));
  assert.equal(changedAfter64DigitReview.text, 'レビューの後に変更あり (レビュー済み ddddddd)');
  assert.match(changedAfter64DigitReview.warn, /head eeeeeee はクロスレビューの後に変更されている/);

  assert.equal(context.crossReviewState(reviewPr({ headRefOid: headSha })).warn, null);
});

test('マージと予約の確認欄は警告と照合用 SHA を表示する', () => {
  const html = readWebPage();
  const helpers = sourceBetween(html, 'function element(tag, className, text)', 'function durationLabel');
  const component = sourceBetween(html, 'const MERGE_METHOD_LABELS', 'function appendPullRequestBlock');
  assert.ok(helpers && component);

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.textContent = '';
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  class FakeText {
    constructor(text) { this.textContent = text; }
  }
  const context = pageContext(pageHtml, {
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
    },
    displayPreferences: {},
    pullRequestMergeOptions: new Map(),
    pullRequestMergeInFlight: new Set(), actionFocusRestores: new Map(), rememberActionFocus() {}, pullRequestResultUnconfirmed: () => false, pullRequestUnconfirmedResults: new Map(), refreshSequence: 0, pullRequestReservationPending: new Map(),
  });
  vm.runInContext(`${helpers}\n${component}`, context);

  const headSha = 'a'.repeat(40);
  const group = { defaultBranch: 'main', mergeMethods: ['merge'], lastMethod: 'merge' };
  const confirmation = (automatic, review) => {
    const pullRequest = {
      mergeRecordKey: `pr-${automatic}-${review?.reviewedSha || 'unknown'}`,
      number: 42,
      headRefOid: headSha,
      headRefName: 'feat/pr-42',
      children: [],
      isCrossRepository: false,
      crossReview: review,
    };
    const target = new FakeElement('div');
    context.appendPullRequestMergeConfirmation(target, group, reviewPr(pullRequest), automatic);
    return target.children[0].children.find((node) => node.className === 'effects').children;
  };
  const changedReview = { round: 1, max: 3, dismissed: 0, reviewedSha: 'b'.repeat(40) };
  for (const automatic of [false, true]) {
    const effects = confirmation(automatic, changedReview);
    assert.equal(effects[0].className, 'warn');
    assert.equal(effects[0].textContent, 'head aaaaaaa はクロスレビューの後に変更されている (レビュー済みは bbbbbbb)');
    assert.equal(effects[1].children[0].textContent, '照合する head SHA: ');
    assert.equal(effects[1].children[1].textContent, 'aaaaaaa');

    const reviewedEffects = confirmation(automatic, {
      round: 1, max: 3, dismissed: 0, reviewedSha: headSha,
    });
    assert.equal(reviewedEffects.length, 1);
    assert.equal(reviewedEffects[0].children[0].textContent, '照合する head SHA: ');
    assert.equal(reviewedEffects[0].children[1].textContent, 'aaaaaaa');
    assert.equal(reviewedEffects[0].children[1].title, headSha);
  }
  const missingReviewEffects = confirmation(false, null);
  assert.equal(missingReviewEffects[0].className, 'warn');
  assert.equal(missingReviewEffects[0].textContent, 'クロスレビューの記録が無い');
  assert.equal(missingReviewEffects.length, 2);
  const absentReviewEffects = confirmation(false, undefined);
  assert.equal(absentReviewEffects.length, 1);
  assert.equal(absentReviewEffects[0].children[0].textContent, '照合する head SHA: ');
  const unverifiableEffects = confirmation(false, {
    round: 1, max: 3, dismissed: 0, reviewedSha: null,
  });
  assert.equal(unverifiableEffects[0].className, 'warn');
  assert.equal(unverifiableEffects[0].textContent, 'head を確かめられない');

  const triageWarnings = [
    [{ round: 3, max: 3, dismissed: 0, reviewedSha: headSha, triage: { round: 2, sha: 'b'.repeat(40), outcome: 'fixing' } }, 'クロスレビューの 3 往復目の結論がまだ出ていない'],
    [{ round: 2, max: 3, dismissed: 0, reviewedSha: headSha, triage: { round: 2, sha: headSha, outcome: 'fixing' } }, 'クロスレビューの 2 往復目の指摘に対応している途中'],
    [{ round: 2, max: 3, dismissed: 0, reviewedSha: headSha, triage: { round: 2, sha: headSha, outcome: 'halted' } }, 'クロスレビューは開発者の判断を待って止まっている'],
  ];
  for (const [review, message] of triageWarnings) {
    const effects = confirmation(false, review);
    assert.equal(effects[0].className, 'warn');
    assert.equal(effects[0].textContent, message);
  }
  const convergedEffects = confirmation(false, {
    round: 2, max: 3, dismissed: 0, reviewedSha: null,
    triage: { round: 2, sha: headSha, outcome: 'converged' },
  });
  assert.equal(convergedEffects.length, 1);
  assert.equal(convergedEffects[0].children[0].textContent, '照合する head SHA: ');
  const changedConvergenceEffects = confirmation(false, {
    round: 2, max: 3, dismissed: 0, reviewedSha: headSha,
    triage: { round: 2, sha: 'b'.repeat(40), outcome: 'converged' },
  });
  assert.equal(changedConvergenceEffects[0].className, 'warn');
  assert.equal(changedConvergenceEffects[0].textContent, 'head aaaaaaa はクロスレビューの収束の後に変更されている (収束は bbbbbbb)');
});

test('マージできる PR の件数タグはほかの件数タグと同じ形式で表示する', () => {
  const html = readWebPage();
  const element = functionSource(html, 'element');
  const renderSummary = functionSource(html, 'renderSummary');
  const judgments = functionSource(html, 'countJudgments');
  assert.ok(element && judgments && renderSummary);

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.className = '';
      this.textContent = '';
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute() {}
    addEventListener() {}
  }
  class FakeText {
    constructor(text) { this.textContent = text; }
  }
  const summary = new FakeElement('div');
  summary.replaceChildren = (...children) => { summary.children = children; };
  const note = new FakeElement('div');
  note.replaceChildren = (...children) => { note.children = children; };
  const context = pageContext(pageHtml, {
    FILTERS: [{ key: 'prs', label: 'マージできる PR', color: 'ok' }],
    summary,
    displayPreferences: { hidden: [] },
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
      getElementById: () => note,
    },
    pullRequestMergeableCount: () => 4,
    pullRequestOpenCount: (groups) => groups.reduce((total, group) => total + group.openCount, 0),
    isPendingDecision: () => false,
    hasEffectiveAnswer: () => false,
  });
  vm.runInContext(`${judgments}\n${element}\n${renderSummary}`, context);
  context.renderSummary([], []);

  const chip = summary.children[0];
  assert.equal(chip.children[0].textContent, 'マージできる PR ');
  assert.equal(chip.children[1].textContent, '4');
  assert.equal(chip.children.map((node) => node.textContent).join(''), 'マージできる PR 4');

  // 同じ PR が 2 つのプロダクトの PR 群に載ると 2 行に出るので、隠れる行も 2 件と数える。
  context.displayPreferences.hidden = ['prs'];
  context.renderSummary([], [{ openCount: 1 }, { openCount: 1 }]);
  assert.equal(note.children[0].textContent, '非表示: マージできる PR (2 件)');
});

test('PR カードは条件達成、条件待ち、操作不可を分け、待ち条件を確認欄の先頭に出す', () => {
  const html = readWebPage();
  const helpers = sourceBetween(html, 'function element(tag, className, text)', 'function durationLabel');
  const component = sourceBetween(html, 'const MERGE_METHOD_LABELS', 'function appendPullRequestBlock');
  assert.ok(helpers && component);

  class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.attributes = {}; this.className = ''; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  class FakeText { constructor(text) { this.textContent = text; } }
  const key = 'd'.repeat(64);
  const group = { owner: 'example', repo: 'project', defaultBranch: 'main', mergeMethods: ['merge'], lastMethod: 'merge', autoDeleteBranch: true };
  const context = pageContext(pageHtml, {
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
    },
    pullRequestMergeConfirmations: new Map(),
    pullRequestMergeOptions: new Map(),
    pullRequestMergeMessages: new Map(),
    queuedPullRequestMerges: new Map(),
    queuedPullRequestMerge: () => null,
    pullRequestMergeInFlight: new Set(), pullRequestResultUnconfirmed: () => false, pullRequestUnconfirmedResults: new Map(), refreshSequence: 0, pullRequestReservationPending: new Map(),
    pullRequestReviewSkipInFlight: new Set(),
    pullRequestConflictConfirmations: new Set(),
    pullRequestConflictMessages: new Map(),
    pullRequestConflictInFlight: new Set(),
    lastState: { pullRequests: [group] },
    displayPreferences: { mergeableCondition: 'cross-review' },
    appendPullRequestBadges() {},
  });
  vm.runInContext(`${helpers}\n${component}`, context);
  const textOf = (node) => [node.textContent, ...(node.children || []).map(textOf)].join('');
  const render = (changes = {}, confirmation = false) => {
    const pullRequest = {
      mergeSessionId: 'session-pr', number: 42, title: 'Feature PR', url: 'https://github.com/example/project/pull/42',
      mergeRecordKey: key, headRefOid: 'a'.repeat(40), headRefName: 'feature/pr-42', effectiveBase: 'main', baseRefName: 'main',
      canMerge: true, isCrossRepository: false, blocker: null, ci: 'pending', crossReview: null,
      children: [], stackPosition: { depth: 1, total: 1 }, ...changes,
    };
    if (confirmation) context.pullRequestMergeConfirmations.set(key, 'merge');
    else context.pullRequestMergeConfirmations.delete(key);
    const root = new FakeElement('div');
    context.appendPullRequestTree(root, group, reviewPr(pullRequest));
    const all = (node) => [node, ...(node.children || []).flatMap(all)];
    return { all: all(root), text: textOf(root) };
  };

  let card = render({ ci: 'pass', crossReview: { notRequired: true, source: 'recorded' } });
  assert.match(card.all[1].className, /can-merge/);
  assert.ok(card.all.some((node) => node.textContent === 'マージできます'));
  assert.ok(card.all.some((node) => node.dataset?.openMerge === key && node.className === 'merge-btn'));
  const reviewLine = card.all.find((node) => node.className === 'xr');
  assert.ok(reviewLine);
  assert.equal(reviewLine.children[1].textContent, 'レビュー不要');
  assert.equal(reviewLine.children[1].className, 'badge mute');

  card = render();
  assert.match(card.all[1].className, /merge-pending/);
  assert.ok(card.all.some((node) => node.textContent === 'マージ操作は可能'));
  assert.ok(card.all.some((node) => node.dataset?.openMerge === key && node.className === 'merge-btn outline'));
  assert.match(card.text, /待ち: CI 実行中(?!、)/);
  assert.equal(card.text.includes('クロスレビュー未実施'), false);

  const headSha = 'a'.repeat(40);
  card = render({ crossReview: { round: 3, max: 3, dismissed: 0, reviewedSha: headSha, triage: { round: 2, sha: 'b'.repeat(40), outcome: 'fixing' } } });
  assert.ok(card.text.includes('3 往復目の結論待ち'));
  assert.equal(card.text.includes('クロスレビュー対応中'), false);

  card = render({ ci: 'pass', crossReview: { round: 3, max: 3, dismissed: 0, reviewedSha: headSha, triage: { round: 2, sha: 'b'.repeat(40), outcome: 'fixing' } } });
  assert.match(card.all[1].className, /merge-pending/);
  assert.equal(card.text.includes('待ち:'), false);

  card = render({ ci: 'pass', crossReview: { round: 1, max: 3, dismissed: 0, reviewedSha: headSha, triage: null } });
  assert.ok(card.text.includes('この head をレビューに回した'));
  assert.match(card.text, /待ち: クロスレビュー対応中/);

  card = render({ canMerge: false, blocker: 'レビューの承認待ち', ci: 'pass' });
  assert.ok(card.text.includes('マージできない理由: レビューの承認待ち'));
  assert.equal(card.all.some((node) => node.dataset?.openMerge === key), false);
  assert.equal(card.all.some((node) => node.textContent === 'マージ操作は可能'), false);

  card = render({}, true);
  const panel = card.all.find((node) => node.dataset?.mergeConfirm === key);
  assert.equal(panel.children[1].className, 'merge-condition-warning');
  assert.equal(panel.children[1].textContent, '選択した条件の未達: CI 実行中、クロスレビュー未実施');
  assert.ok(card.all.some((node) => node.dataset?.mergeGo === key && node.className === 'merge-go outline'));
});

test('マージできる PR は選択条件を満たし、登録セッションにマージボタンがあるものだけを数える', () => {
  const source = readWebPage();
  const functions = ['pullRequestKeys', 'isCompleteCommitSha', 'pullRequestMergeConditionWaits', 'pullRequestMergeableCount'].map((name) => (
    functionSource(source, name)
  ));
  assert.ok(functions.every(Boolean));
  const context = pageContext(pageHtml, {
    displayPreferences: { mergeableCondition: 'operation' },
    CI_LABELS: {
      pass: { wait: 'CI 成功' }, pending: { wait: 'CI 実行中' }, fail: { wait: 'CI が失敗' }, unknown: { wait: 'CI 状態不明' },
    },
  });
  vm.runInContext(functions.join('\n'), context);

  const headRefOid = 'a'.repeat(40);
  const shared = { number: 1, canMerge: true, mergeSessionId: 'session-a', ci: 'pending', crossReview: null, headRefOid, children: [
    { number: 2, canMerge: true, mergeSessionId: null, ci: 'pass', crossReview: null, headRefOid, children: [] },
  ] };
  const groups = [
    { owner: 'Example', repo: 'Project', trees: [shared] },
    { owner: 'example', repo: 'project', trees: [shared, { number: 3, canMerge: false, mergeSessionId: 'session-b', children: [] }] },
  ];

  assert.equal(context.pullRequestMergeableCount(groups.map(group => ({ ...group, trees: group.trees.map(reviewPr) }))), 1);
  context.displayPreferences.mergeableCondition = 'ci';
  assert.equal(context.pullRequestMergeableCount(groups.map(group => ({ ...group, trees: group.trees.map(reviewPr) }))), 0);
  shared.ci = 'pass';
  assert.equal(context.pullRequestMergeableCount(groups.map(group => ({ ...group, trees: group.trees.map(reviewPr) }))), 1);
  context.displayPreferences.mergeableCondition = 'cross-review';
  assert.equal(context.pullRequestMergeableCount(groups.map(group => ({ ...group, trees: group.trees.map(reviewPr) }))), 0);
  shared.crossReview = { round: 2, triage: { round: 2, outcome: 'converged', sha: headRefOid } };
  assert.equal(context.pullRequestMergeableCount(groups.map(group => ({ ...group, trees: group.trees.map(reviewPr) }))), 1);
  shared.crossReview = null;
  assert.equal(context.pullRequestMergeableCount(groups.map(group => ({ ...group, trees: group.trees.map(reviewPr) }))), 0);
});

test('見出しの判断待ちは有効な回答を数えず、無視された回答は数える', () => {
  const source = readWebPage();
  const functions = ['hasEffectiveAnswer', 'isActiveDecision', 'isAwaitingDecision'].map((name) => (
    functionSource(source, name)
  ));
  assert.ok(functions.every(Boolean));
  const context = pageContext(pageHtml, {});
  vm.runInContext(functions.join('\n'), context);
  const sentAt = '2026-10-03T12:00:00.000Z';

  assert.equal(context.isAwaitingDecision({ state: 'waiting', answer: null }), true);
  assert.equal(context.isAwaitingDecision({ state: 'provisional', answer: null }), true);
  assert.equal(context.isAwaitingDecision({ state: 'waiting', answer: { choice: 'pick', sentAt } }), false);
  assert.equal(context.isAwaitingDecision({ state: 'waiting', answer: { choice: 'pick', sentAt, ignoredAt: sentAt } }), true);
  assert.equal(context.isAwaitingDecision({ state: 'resolved', answer: null }), false);
});

test('プロダクト別と種類別に前回見てからを表示し、新しい判断に印を付ける', () => {
  const source = readWebPage();
  const render = functionSource(source, 'render');
  const productSection = functionSource(source, 'productSection');
  const renderKindSections = functionSource(source, 'renderKindSections');
  const markAllSeenButton = functionSource(source, 'markAllSeenButton');
  const appendDecisionCard = functionSource(source, 'appendDecisionCard');
  const markProductSeen = source.match(/async function markProductSeen\(button\) \{[\s\S]*?\n\}/)?.[0];
  const markAllProductsSeen = source.match(/async function markAllProductsSeen\(button\) \{[\s\S]*?\n\}/)?.[0];

  assert.ok(render);
  assert.ok(productSection);
  assert.ok(renderKindSections);
  assert.ok(markAllSeenButton);
  assert.ok(appendDecisionCard);
  assert.ok(markProductSeen);
  assert.ok(markAllProductsSeen);
  assert.match(productSection, /sinceSeenBox\(product, false, showOriginBands, product\.key === markAllSeenProductKey\)/);
  assert.match(renderKindSections, /sinceSeenBox\(product, true, showOriginBands\)/);
  assert.match(renderKindSections, /if \(sinceSeenCount > 1\) sinceSeenControls\.append\(markAllSeenButton\(\)\)/);
  assert.match(render, /sinceSeenProductKeys\.size > 1/);
  assert.match(render, /products\.find\(\(product\) => sinceSeenProductKeys\.has\(product\.key\) && !displayPreferences\.collapsed\.includes\(product\.key\)\)/);
  assert.match(source, /前回見てから \(\$\{entry\.items\.length\} 件\)/);
  assert.match(source, /seen\.dataset\.seen = product\.key/);
  assert.match(markAllSeenButton, /button\.dataset\.seenAll = 'true'/);
  assert.match(source, /postUiAction\('\/api\/seen'/);
  assert.match(markProductSeen, /generatedAt: lastState\?\.generatedAt/);
  assert.match(markAllProductsSeen, /productKey: product\.key, generatedAt/);
  assert.match(markAllProductsSeen, /setSinceSeenButtonsDisabled\(true\)/);
  assert.match(appendDecisionCard, /if \(decision\.isNew\) header\.append\(badge\('新着', 'new-mark'\)\)/);
});

test('すべて既読にするは各プロダクトへ同じ状態版を送り、一部失敗時も残りを処理する', async () => {
  const source = readWebPage();
  const visibleSinceSeen = functionSource(source, 'visibleSinceSeen');
  const markAllProductsSeen = source.match(/async function markAllProductsSeen\(button\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(visibleSinceSeen && markAllProductsSeen);

  const entries = ['one', 'failed', 'three'].map((key) => ({
    product: { key },
    items: [{ text: key }],
  }));
  const requests = [];
  const buttons = [
    { disabled: false, isConnected: true, dataset: { seenAll: 'true' } },
    ...entries.map(({ product }) => ({ disabled: false, isConnected: true, dataset: { seen: product.key } })),
  ];
  let resolveFirst;
  let refreshCount = 0;
  let context;
  const errors = [];
  const liveStatus = { textContent: '' };
  context = pageContext(pageHtml, {
    lastState: { generatedAt: 'state-530', sinceSeen: entries },
    sinceSeenMode: 'show',
    root: { querySelectorAll: () => buttons },
    postUiAction: async (_path, body) => {
      requests.push(body);
      if (body.productKey === 'one') return new Promise((resolve) => { resolveFirst = resolve; });
      return { ok: body.productKey !== 'failed' };
    },
    refresh: async () => {
      refreshCount += 1;
      context.lastState = {
        ...context.lastState,
        sinceSeen: context.lastState.sinceSeen.filter((entry) => entry.product.key === 'failed'),
      };
    },
    liveStatus,
    render() {},
    showWriteError: (message) => errors.push(message),
  });
  vm.runInContext(`let sinceSeenActionInFlight = false;\n${visibleSinceSeen}\n${markAllProductsSeen}\nfunction setSinceSeenButtonsDisabled(disabled) { root.querySelectorAll('[data-seen], [data-seen-all]').forEach((button) => { button.disabled = disabled; }); }`, context);

  const pending = context.markAllProductsSeen(buttons[0]);
  assert.equal(buttons.every((button) => button.disabled), true);
  await context.markAllProductsSeen(buttons[0]);
  assert.equal(requests.length, 1);
  resolveFirst({ ok: true });
  await pending;

  assert.deepEqual(requests.map(({ productKey, generatedAt }) => [productKey, generatedAt]), [
    ['one', 'state-530'], ['failed', 'state-530'], ['three', 'state-530'],
  ]);
  assert.equal(refreshCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.visibleSinceSeen(context.lastState))).map((entry) => entry.product.key), ['failed']);
  assert.equal(liveStatus.textContent, '項目を既読にできませんでした');
  assert.deepEqual(errors, ['項目を既読にできませんでした']);
  assert.equal(buttons.every((button) => !button.disabled), true);
});

test('前回見てからの設定は表示するを既定にし、以前の保存値を読み替える', () => {
  const source = readWebPage();
  const names = ['applySinceSeenMode', 'storedSinceSeenMode', 'setSinceSeenMode', 'visibleSinceSeen'];
  const functions = names.map((name) => functionSource(source, name));
  assert.ok(functions.every(Boolean));
  assert.match(source, /let sinceSeenMode = 'show'/);
  assert.match(source, /id="settings-since-seen-select"[\s\S]*?<option value="show">表示する<\/option>[\s\S]*?<option value="hide">表示しない<\/option>/);
  assert.match(source, /離席中に起きた変化を、既読にするまで表示します。/);
  assert.match(source, /applySinceSeenMode\(storedSinceSeenMode\(\)\)/);

  const storage = new Map();
  const localStorage = {
    getItem(key) { return storage.get(key) ?? null; },
    setItem(key, value) { storage.set(key, value); },
  };
  const sinceSeenSelect = { value: '' };
  let renderCount = 0;
  const context = pageContext(pageHtml, {
    SINCE_SEEN_STORAGE_KEY: 'agent-cockpit.since-seen',
    localStorage,
    sinceSeenSelect,
    header: { dataset: { away: 'false' } },
    lastState: { sinceSeen: [] },
    render: () => { renderCount += 1; },
  });
  vm.runInContext(`let sinceSeenMode = 'show';\n${functions.join('\n')}`, context);

  assert.equal(context.storedSinceSeenMode(), 'show');
  context.applySinceSeenMode(context.storedSinceSeenMode());
  assert.equal(sinceSeenSelect.value, 'show');

  storage.set('agent-cockpit.since-seen', 'show');
  assert.equal(context.storedSinceSeenMode(), 'show');
  storage.set('agent-cockpit.since-seen', 'hide');
  assert.equal(context.storedSinceSeenMode(), 'hide');

  storage.set('agent-cockpit.since-seen', 'always');
  assert.equal(context.storedSinceSeenMode(), 'show');
  context.applySinceSeenMode(context.storedSinceSeenMode());
  assert.equal(sinceSeenSelect.value, 'show');

  storage.set('agent-cockpit.since-seen', 'away');
  assert.equal(context.storedSinceSeenMode(), 'show');
  context.applySinceSeenMode(context.storedSinceSeenMode());
  assert.equal(sinceSeenSelect.value, 'show');

  storage.set('agent-cockpit.since-seen', 'sometimes');
  assert.equal(context.storedSinceSeenMode(), 'show');
  context.setSinceSeenMode('show');
  assert.equal(storage.get('agent-cockpit.since-seen'), 'show');
  assert.equal(renderCount, 1);
  storage.set('agent-cockpit.since-seen', 'never');
  assert.equal(context.storedSinceSeenMode(), 'hide');
  context.applySinceSeenMode(context.storedSinceSeenMode());
  assert.equal(sinceSeenSelect.value, 'hide');
  context.setSinceSeenMode('hide');
  assert.equal(storage.get('agent-cockpit.since-seen'), 'hide');
  assert.deepEqual(JSON.parse(JSON.stringify(context.visibleSinceSeen({ sinceSeen: [{ items: [{ text: '履歴' }] }] }))), []);
  assert.equal(renderCount, 2);
  context.setSinceSeenMode('invalid');
  assert.equal(storage.get('agent-cockpit.since-seen'), 'show');
  assert.equal(sinceSeenSelect.value, 'show');
  assert.equal(renderCount, 3);

  localStorage.getItem = () => { throw new Error('storage unavailable'); };
  assert.equal(context.storedSinceSeenMode(), 'show');
});

test('終わったもののチェックは表示設定として保存し、失敗時に戻してフォーカス中は同期しない', async () => {
  const names = ['normalizeDisplayInteger', 'normalizeSectionOrder', 'normalizeDisplayPreferences', 'renderDisplaySettings', 'setDisplaySettingInput', 'displaySettingError', 'changeDisplaySetting', 'changeTerminalPreference'];
  const functions = names.map((name) => functionSource(pageHtml, name));
  const settings = pageHtml.match(/const DISPLAY_INTEGER_SETTINGS = \[[\s\S]*?\n\];/)?.[0];
  const saveFunctions = ['settleDisplaySaves', 'saveDisplayPreferences'].map((name) => functionSource(pageHtml, name));
  assert.ok(functions.every(Boolean) && saveFunctions.every(Boolean) && settings);
  assert.match(pageHtml, /id="settings-hide-finished" name="hideFinished" type="checkbox"/);
  assert.match(pageHtml, /id="settings-import-app-tasks" name="importAppTasks" type="checkbox" aria-describedby="settings-import-app-tasks-note"/);
  assert.match(pageHtml, /id="settings-terminal-select" name="terminal"/);

  let activeElement = null;
  let resolveSave;
  let savedPatch;
  const hideFinishedInput = { type: 'checkbox', checked: false };
  const importAppTasksInput = { type: 'checkbox', checked: true };
  const longWaitMinutesInput = { type: 'number', value: '' };
  const awayAnswerWaitMinutesInput = { type: 'number', value: '' };
  const idleHideMinutesInput = { type: 'number', value: '' };
  const ghConcurrencyLimitInput = { type: 'number', value: '' };
  const terminalSelect = { value: 'auto' };
  const longWaitMinutesError = { textContent: '', hidden: true };
  const awayAnswerWaitMinutesError = { textContent: '', hidden: true };
  const idleHideMinutesError = { textContent: '', hidden: true };
  const ghConcurrencyLimitError = { textContent: '', hidden: true };
  const mergeableConditionInputs = ['operation', 'ci', 'cross-review'].map((value) => ({ value, checked: false }));
  const displayPreferences = { hideFinished: false, importAppTasks: true, longWaitMinutes: 15, awayAnswerWaitMinutes: 5, idleHideMinutes: 30, ghConcurrencyLimit: 8, mergeableCondition: 'cross-review', terminal: 'pwsh' };
  const context = pageContext(pageHtml, {
    displayPreferences,
    SECTION_ORDER_KEYS: new Set(['sinceSeen', 'judgment', 'tasks', 'now', 'prs']),
    DEFAULT_SECTION_ORDER: ['sinceSeen', 'judgment', 'prs', 'tasks', 'now'],
    DEFAULT_LONG_WAIT_MINUTES: 15,
    DEFAULT_AWAY_ANSWER_WAIT_MINUTES: 3,
    DEFAULT_IDLE_HIDE_MINUTES: 10,
    DEFAULT_GH_CONCURRENCY_LIMIT: 8,
    TERMINAL_LABELS: { auto: '自動', 'windows-terminal': 'Windows Terminal', pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'コマンドプロンプト' },
    FILTERS: [],
    displayPreferencesReady: true,
    pendingDisplayChanges: {},
    displayPreferenceSaveStates: new Map(),
    renderSectionOrder() {},
    render() {},
    pullDefaultBranchInput: { type: 'checkbox', checked: false },
    hideFinishedInput,
    importAppTasksInput,
    longWaitMinutesInput,
    awayAnswerWaitMinutesInput,
    idleHideMinutesInput,
    ghConcurrencyLimitInput,
    terminalSelect,
    mergeableConditionInputs,
    diagnosticsLevelSelect: { value: 'info', closest: () => ({ open: false }) },
    longWaitMinutesError,
    awayAnswerWaitMinutesError,
    idleHideMinutesError,
    ghConcurrencyLimitError,
    lastState: null,
    document: { get activeElement() { return activeElement; } },
    enqueueDisplayPatch: (patch) => {
      savedPatch = patch;
      return new Promise((resolve) => { resolveSave = resolve; });
    },
  });
  vm.runInContext(`${settings}\n${functions.join('\n')}\n${saveFunctions.join('\n')}`, context);

  assert.equal(context.normalizeDisplayPreferences(null).pullDefaultBranchAfterMerge, false);
  assert.equal(context.normalizeDisplayPreferences({ pullDefaultBranchAfterMerge: true }).pullDefaultBranchAfterMerge, true);
  assert.equal(context.normalizeDisplayPreferences(null).hideFinished, true);
  assert.equal(context.normalizeDisplayPreferences(null).importAppTasks, false);
  assert.equal(context.normalizeDisplayPreferences(null).idleHideMinutes, 10);
  assert.equal(context.normalizeDisplayPreferences({ hideFinished: false }).hideFinished, false);
  assert.equal(context.normalizeDisplayPreferences({ hideFinished: true }).hideFinished, true);
  assert.equal(context.normalizeDisplayPreferences({ importAppTasks: false }).importAppTasks, false);
  assert.equal(context.normalizeDisplayPreferences({ importAppTasks: 'false' }).importAppTasks, false);
  assert.equal(context.normalizeDisplayPreferences({}).mergeableCondition, 'cross-review');
  assert.equal(context.normalizeDisplayPreferences({ terminal: 'unknown' }).terminal, 'auto');
  assert.equal(context.normalizeDisplayPreferences({ terminal: 'cmd' }).terminal, 'cmd');
  assert.equal(Object.hasOwn(context.normalizeDisplayPreferences({ mergeAfterReviewDefault: true }), 'mergeAfterReviewDefault'), false);
  context.renderDisplaySettings();
  assert.deepEqual(mergeableConditionInputs.map((input) => input.checked), [false, false, true]);
  assert.equal(importAppTasksInput.checked, true);
  assert.equal(terminalSelect.value, 'pwsh');
  activeElement = hideFinishedInput;
  hideFinishedInput.checked = true;
  context.renderDisplaySettings();
  assert.equal(hideFinishedInput.checked, true);

  let terminalPatch;
  const saveDisplayPreferences = context.saveDisplayPreferences;
  context.saveDisplayPreferences = patch => { terminalPatch = patch; };
  terminalSelect.value = 'powershell';
  context.changeTerminalPreference();
  assert.deepEqual(JSON.parse(JSON.stringify(terminalPatch)), { terminal: 'powershell' });
  context.saveDisplayPreferences = saveDisplayPreferences;

  context.showFinishedTemporarily = true;
  const saving = context.changeDisplaySetting('hideFinished', hideFinishedInput);
  assert.equal(context.showFinishedTemporarily, false);
  assert.deepEqual(JSON.parse(JSON.stringify(savedPatch)), { hideFinished: true });
  hideFinishedInput.checked = false;
  context.renderDisplaySettings();
  assert.equal(hideFinishedInput.checked, false);
  hideFinishedInput.checked = true;
  resolveSave(true);
  assert.equal(await saving, true);
  assert.equal(displayPreferences.hideFinished, true);
  assert.equal(hideFinishedInput.checked, true);

  context.enqueueDisplayPatch = async (patch) => {
    savedPatch = patch;
    return false;
  };
  hideFinishedInput.checked = false;
  await context.changeDisplaySetting('hideFinished', hideFinishedInput);
  assert.equal(displayPreferences.hideFinished, true);
  assert.equal(hideFinishedInput.checked, true);

  context.enqueueDisplayPatch = async (patch) => {
    savedPatch = patch;
    return true;
  };
  importAppTasksInput.checked = false;
  await context.changeDisplaySetting('importAppTasks', importAppTasksInput);
  assert.deepEqual(JSON.parse(JSON.stringify(savedPatch)), { importAppTasks: false });
  assert.equal(displayPreferences.importAppTasks, false);
  assert.equal(importAppTasksInput.checked, false);

  context.enqueueDisplayPatch = async () => false;
  importAppTasksInput.checked = true;
  await context.changeDisplaySetting('importAppTasks', importAppTasksInput);
  assert.equal(displayPreferences.importAppTasks, false);
  assert.equal(importAppTasksInput.checked, false);

});

test('履歴は離席状態にかかわらず表示され、表示しない設定では隠れる', async () => {
  const harness = renderHarness();
  const product = { key: 'history-only', name: '履歴のみ' };
  const state = {
    routing: {},
    integrations: {},
    sessions: [{ product: { key: 'active', name: '稼働中' }, hidden: false }],
    pullRequests: [],
    sinceSeen: [{ product, items: [{ text: '完了' }] }],
  };

  harness.context.lastState = state;
  harness.context.render(state);
  assert.equal(harness.orderedSinceSeen.length, 1);

  harness.context.sinceSeenMode = 'show';
  harness.context.render(state);
  assert.equal(harness.orderedSinceSeen.length, 1);

  harness.context.header.dataset.away = 'true';
  harness.context.render(state);
  assert.equal(harness.orderedSinceSeen.length, 1);

  harness.context.sinceSeenMode = 'hide';
  harness.context.render(state);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.orderedSinceSeen)), []);

  const sinceSeenBox = functionSource(harness.html, 'sinceSeenBox');
  const visibleSinceSeen = functionSource(harness.html, 'visibleSinceSeen');
  const awayChange = sourceBetween(harness.html, "awayToggle.addEventListener('change', async () => {", '\n});', true);
  assert.ok(sinceSeenBox && visibleSinceSeen && awayChange);
  assert.match(sinceSeenBox, /visibleSinceSeen\(lastState\)\.find/);
  assert.match(awayChange, /applyAwayState\(away\);\s*if \(lastState\) render\(lastState\);/);

  const boxContext = pageContext(pageHtml, {
    lastState: state,
    sinceSeenMode: 'show',
    header: { dataset: { away: 'false' } },
    document: { createTextNode: (text) => ({ textContent: text }) },
    element: (tagName, className = '', textContent = '') => ({
      tagName,
      className,
      textContent,
      dataset: {},
      children: [],
      append(...children) { this.children.push(...children); },
    }),
  });
  vm.runInContext(`let sinceSeenActionInFlight = false;\n${visibleSinceSeen}\n${functionSource(harness.html, 'providerOrigin')}\n${sinceSeenBox}`, boxContext);
  const box = boxContext.sinceSeenBox(product, false);
  assert.ok(box);
  assert.equal(box.children[0].children[0].textContent, '前回見てから (1 件)');

  const appliedAway = [];
  let rerenders = 0;
  let awayChangeHandler;
  const awayContext = pageContext(pageHtml, {
    awayToggle: { checked: true, disabled: false, addEventListener: (_event, handler) => { awayChangeHandler = handler; } },
    lastState: state,
    postAway: async (enabled) => ({ ok: true, json: async () => ({ enabled }) }),
    applyAwayState: (away) => { appliedAway.push(away.enabled); },
    render: () => { rerenders += 1; },
    liveStatus: { textContent: '' },
    showWriteError() {},
  });
  vm.runInContext(awayChange, awayContext);
  await awayChangeHandler();
  assert.deepEqual(appliedAway, [true]);
  assert.equal(rerenders, 1);
});

test('履歴だけのプロダクトも稼働中の一覧と同じ順で上下に動かせる', () => {
  const source = readWebPage();
  const functions = ['pullRequestOpenCount', 'pullRequestGroupHasVisibleContent', 'visiblePullRequestGroups', 'productGroups', 'hasProductContent', 'sessionActivityTime', 'orderedProducts', 'visibleSinceSeen'].map((name) => (
    functionSource(source, name)
  ));
  const clickListener = source.match(/document\.addEventListener\('click', \(event\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(functions.every(Boolean));
  assert.ok(clickListener);

  const displayPreferences = {
    order: ['active', 'hidden', 'history-only', 'pull-request-only'],
    pinned: [], collapsed: [],
  };
  const state = {
    sessions: [
      { product: { key: 'active', name: '稼働中' }, hidden: false, tools: [], lastActivityAt: '2026-10-03T12:00:00.000Z' },
      { product: { key: 'hidden', name: '非表示' }, hidden: true, tools: [], lastActivityAt: '2026-10-03T12:00:00.000Z' },
    ],
    pullRequests: [{ product: { key: 'pull-request-only', name: 'PR のみ' }, owner: 'example', repo: 'project', openCount: 1 }],
    sinceSeen: [{ product: { key: 'history-only', name: '履歴のみ' }, items: [{ text: '完了' }] }],
  };
  const saved = [];
  let handleClick;
  const context = pageContext(pageHtml, {
    displayPreferences,
    lastState: state,
    sinceSeenMode: 'always',
    header: { dataset: { away: 'false' } },
    idleHiddenSessions: () => [],
    isIdleHiddenSession: () => false,
    sessionsAfterIdleFilter: (sessions) => sessions,
    isFilterShown: () => true,
    handleExternalLink: () => false,
    document: { addEventListener: (_name, callback) => { handleClick = callback; } },
    saveDisplayPreferences: (patch) => {
      saved.push(patch);
      Object.assign(displayPreferences, patch);
    },
    render() {},
  });
  vm.runInContext(`${functions.join('\n')}\n${clickListener}`, context);

  const button = {
    dataset: { productAction: 'move', productKey: 'history-only', direction: '-1' },
    closest: (selector) => selector === 'button' ? button : null,
  };
  handleClick({ target: button });

  assert.deepEqual([...displayPreferences.order], ['history-only', 'hidden', 'active', 'pull-request-only']);
  assert.deepEqual(saved.map((patch) => ({ order: [...patch.order] })), [
    { order: ['history-only', 'hidden', 'active', 'pull-request-only'] },
  ]);

  saved.length = 0;
  button.dataset.productKey = 'missing';
  assert.doesNotThrow(() => handleClick({ target: button }));
  assert.deepEqual(saved, []);
});

test('プロダクトを外す操作はまだ外していないセッションだけを送る', () => {
  const clickListener = pageHtml.match(/document\.addEventListener\('click', \(event\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(clickListener);
  const runClose = (sessions) => {
    const calls = [];
    const product = { key: 'project', name: 'Project', sessions };
    let handleClick;
    const context = pageContext(pageHtml, {
      lastState: { sessions, pullRequests: [] },
      productGroups: () => [product],
      isIdleHiddenSession: () => true,
      runSessionAction: (...args) => calls.push(args),
      document: { addEventListener: (_name, callback) => { handleClick = callback; } },
    });
    vm.runInContext(clickListener, context);
    const button = {
      dataset: { productAction: 'close', productKey: 'project' },
      closest: (selector) => selector === 'button' ? button : null,
    };
    handleClick({ target: button });
    return calls;
  };
  const active = { session_id: 'active', hidden: false };
  const alreadyHidden = { session_id: 'already-hidden', hidden: true };
  const calls = runClose([active, alreadyHidden]);

  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), { action: 'hide', session_ids: ['active'] });
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][5])), { productName: 'Project', sessionIds: ['active'] });
  assert.deepEqual(runClose([alreadyHidden]), []);
});

test('表示中のセッション、PR、PR のエラー、未読の変化が無いプロダクトはカードを出さない', () => {
  const source = readWebPage();
  const functions = ['pullRequestOpenCount', 'pullRequestGroupHasVisibleContent', 'visiblePullRequestGroups', 'productGroups', 'hasProductContent', 'sessionActivityTime', 'orderedProducts'].map((name) => (
    functionSource(source, name)
  ));
  assert.ok(functions.every(Boolean));
  let pullRequestsShown = true;
  const context = pageContext(pageHtml, {
    displayPreferences: { order: [], pinned: [], collapsed: [] },
    idleHiddenSessions: () => [],
    isIdleHiddenSession: () => false,
    sessionsAfterIdleFilter: (sessions) => sessions,
    saveDisplayPreferences: (patch) => Object.assign(context.displayPreferences, patch),
    isFilterShown: (key) => key !== 'prs' || pullRequestsShown,
    hasPullRequestMergeResults: () => false,
  });
  vm.runInContext(functions.join('\n'), context);

  const visibleSessions = [
    { product: { key: 'active', name: '稼働中' }, tools: [], lastActivityAt: '2026-10-03T12:00:00.000Z' },
  ];
  const pullRequests = [
    { product: { key: 'finished', name: '終了済み' }, owner: 'example', repo: 'finished', openCount: 0 },
    { product: { key: 'open', name: 'オープンあり' }, owner: 'example', repo: 'open', openCount: 2 },
    { product: { key: 'unreachable', name: '取得失敗' }, owner: 'example', repo: 'unreachable', openCount: 0, error: 'PR の一覧を取得できません', openStateUnknown: true },
    { product: { key: 'unrelated-error', name: '他の PR の失敗' }, owner: 'example', repo: 'shared', openCount: 0, error: '#9 の積み直し状態を確認できません', openStateUnknown: false },
  ];
  const keys = (sinceSeen) => [...context.orderedProducts(visibleSessions, pullRequests, sinceSeen)].map((product) => product.key).sort();

  assert.deepEqual(keys([]), ['active', 'open', 'unreachable', 'unrelated-error']);
  assert.deepEqual(keys([{ product: { key: 'finished', name: '終了済み' }, items: [{ text: 'PR #1 をマージした' }] }]), ['active', 'finished', 'open', 'unreachable', 'unrelated-error']);
  assert.deepEqual(keys([{ product: { key: 'finished', name: '終了済み' }, items: [] }]), ['active', 'open', 'unreachable', 'unrelated-error']);

  pullRequestsShown = false;
  assert.deepEqual(keys([]), ['active']);
});

test('予約通知、予約マージ結果、PR 取得エラーがカードを残す条件を共有する', () => {
  const names = ['pullRequestGroupHasVisibleContent', 'visiblePullRequestGroups', 'hasProductContent'];
  const functions = names.map((name) => functionSource(pageHtml, name));
  assert.ok(functions.every(Boolean));
  const context = pageContext(pageHtml, {
    displayPreferences: { hideFinished: true },
    isFilterShown: () => true,
    pullRequestTransientNoticeExpired: () => false,
    pullRequestMergeResultVisible: () => true,
    hasPullRequestMergeResults: (group) => group.localMergeResult === true,
  });
  vm.runInContext(functions.join('\n'), context);

  const base = { openCount: 0, openStateUnknown: false, loading: false, trees: [], mergeHistory: [], reservationNotices: [] };
  const groups = [
    { ...base, reservationNotices: [{ number: 1, at: '2026-10-05T00:00:00.000Z' }] },
    { ...base, mergeHistory: [{ number: 2, automatic: true, automaticResult: {}, mergedAt: '2026-10-05T00:00:00.000Z' }] },
    { ...base, error: 'PR の一覧を取得できません' },
    { ...base, localMergeResult: true },
  ];

  for (const [index, group] of groups.entries()) {
    const product = { key: `finished-${index}`, sessions: [], pullRequestGroups: [group] };
    assert.deepEqual(context.visiblePullRequestGroups([group]), [group]);
    assert.equal(context.hasProductContent(product, []), true);
  }
  const empty = { ...base };
  assert.deepEqual(context.visiblePullRequestGroups([empty]), []);
  assert.equal(context.hasProductContent({ key: 'empty', sessions: [], pullRequestGroups: [empty] }, []), false);
});

test('PR 群が無いプロダクトの空表示は完了表示の設定にかかわらずモックとそろう', () => {
  const productSection = functionSource(pageHtml, 'productSection');
  const productOrder = functionSource(pageHtml, 'productCardSectionOrder');
  const element = functionSource(pageHtml, 'element');
  const judgments = functionSource(pageHtml, 'countJudgments');
  assert.ok(productSection && productOrder && element && judgments);

  class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.className = ''; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute() {}
  }
  class FakeText {
    constructor(text) { this.textContent = text; }
  }
  const context = pageContext(pageHtml, {
    DEFAULT_SECTION_ORDER: ['sinceSeen', 'judgment', 'prs', 'tasks', 'now'],
    displayPreferences: { pinned: [], collapsed: [], hideFinished: true },
    orderedSectionKeys: (keys) => keys,
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
    },
    sharedBranch: () => '',
    productControls: () => new FakeElement('div'),
    productCloseButton: () => null,
    pullRequestMergeableCount: () => 0,
    isAwaitingDecision: () => false,
    sinceSeenBox: () => null,
    sessionBlock: () => new FakeElement('div'),
    isFilterShown: () => true,
    pullRequestOpenCount: () => 0,
    appendPullRequestBlock() {},
  });
  vm.runInContext(`${productOrder}\n${judgments}\n${element}\n${productSection}`, context);
  const textOf = (node) => (node.textContent || '') + (node.children || []).map(textOf).join('');
  const product = { key: 'product', name: 'Project', branches: new Set(), sessions: [], pullRequestGroups: [] };
  const values = [];

  for (const hideFinished of [true, false]) {
    context.displayPreferences.hideFinished = hideFinished;
    values.push(textOf(context.productSection(product, 0, [product], 0)).match(/オープンの PR はありません/g)?.length || 0);
  }

  const loadingProduct = { ...product, pullRequestsLoading: true };
  assert.doesNotMatch(textOf(context.productSection(loadingProduct, 0, [loadingProduct], 0)), /プルリクエスト|オープンの PR はありません/);

  const mockPrBlock = functionSource(fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8'), 'prBlock');
  assert.deepEqual(values, [1, 1]);
  assert.match(mockPrBlock, /const empty = !roots\.length[\s\S]*?オープンの PR はありません/);
});

test('終わったセッションはタスクの有無にかかわらず両方の表示から除く', () => {
  const names = [
    'isEndedAgent', 'isEndedDecision', 'activityStatus', 'runningBackgrounds', 'isFinishedSession', 'pullRequestGroupHasVisibleContent', 'visiblePullRequestGroups', 'pullRequestOpenCount',
    'productGroups', 'hasProductContent', 'sessionActivityTime', 'orderedProducts', 'sessionReferences',
    'taskVisibility', 'kindDoneTaskCount', 'element', 'badge', 'appendTaskItem',
  ];
  const functions = names.map((name) => functionSource(pageHtml, name));
  assert.ok(functions.every(Boolean));
  class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.className = ''; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
  }
  const context = pageContext(pageHtml, {
    displayPreferences: { hideFinished: true, order: [], pinned: [], collapsed: [] },
    showIdleSessions: false,
    idleHiddenSessions: () => [],
    isIdleHiddenSession: () => false,
    sessionsAfterIdleFilter: (sessions) => sessions,
    saveDisplayPreferences: (patch) => Object.assign(context.displayPreferences, patch),
    isFilterShown: () => true,
    hasPullRequestMergeResults: () => false,
    document: { createElement: (tagName) => new FakeElement(tagName) },
    appendContextTags() {},
  });
  vm.runInContext(functions.join('\n'), context);
  const finished = {
    session_id: 'finished', status: '待機中', hidden: false, title: '完了', product: { key: 'finished', name: '完了' },
    tools: [], lastActivityAt: '2026-10-04T00:00:00.000Z', tasks: [{ state: 'done' }], decisions: [{ state: 'resolved' }],
    permissionWaits: [], agents: [{ active: false, unconfirmed: false }],
  };
  const finishedWithoutTasks = { ...finished, session_id: 'no-tasks', tasks: [], product: { key: 'no-tasks', name: 'タスク無し' } };
  const partial = {
    ...finished, session_id: 'partial', title: '一部完了', product: { key: 'partial', name: '一部完了' },
    tasks: [{ id: 'done', state: 'done' }, { id: 'todo', state: 'todo' }],
  };
  const visible = context.orderedProducts([finished, finishedWithoutTasks, partial]);
  assert.deepEqual(JSON.parse(JSON.stringify(visible.map((product) => product.key))), ['partial']);
  const references = context.sessionReferences(visible);
  assert.deepEqual(JSON.parse(JSON.stringify(references.map(({ session }) => session.session_id))), ['partial']);
  assert.equal(context.kindDoneTaskCount(references), 1);
  const taskList = new FakeElement('ul');
  context.appendTaskItem(taskList, { ...partial.tasks[0], title: '完了済み', criteria: [] }, {}, partial);
  const descendants = (node) => [node, ...(node.children || []).flatMap(descendants)];
  assert.ok(descendants(taskList).some((node) => node.className === 'badge done' && node.textContent === '完了'));

  const manuallyClosedTaskList = new FakeElement('ul');
  context.appendTaskItem(manuallyClosedTaskList, {
    title: '画面で閉じたタスク', state: 'done', closedByUser: true, criteria: [{ met: true }],
  }, {}, partial);
  const closedActions = descendants(manuallyClosedTaskList).find((node) => node.className === 'task-actions');
  assert.deepEqual(closedActions.children.map((node) => node.textContent), ['完了条件 1/1', '画面で完了にした']);
  const closedItem = manuallyClosedTaskList.children[0];
  assert.deepEqual(closedItem.children.map((node) => node.className), ['task-body', 'criteria-list'], '完了条件の一覧は題の行の下に行の幅いっぱいで並べる');

  context.displayPreferences.hideFinished = false;
  const shownWhenDisabled = context.orderedProducts([finished, finishedWithoutTasks, partial]);
  assert.deepEqual(JSON.parse(JSON.stringify(shownWhenDisabled.map((product) => product.key).sort())), ['finished', 'no-tasks', 'partial']);
  assert.deepEqual(JSON.parse(JSON.stringify(context.sessionReferences(shownWhenDisabled).map(({ session }) => session.session_id).sort())), [
    'finished', 'no-tasks', 'partial',
  ]);
});

test('タスクの有無にかかわらず終わったセッションと履歴だけの PR は両方の表示から除く', () => {
  const names = [
    'isEndedAgent', 'isEndedDecision', 'isActiveDecision', 'activityStatus', 'runningBackgrounds', 'isFinishedSession', 'pullRequestGroupHasVisibleContent', 'visiblePullRequestGroups', 'pullRequestOpenCount', 'productGroups',
    'hasProductContent', 'sessionActivityTime', 'isIdleHiddenSession', 'idleHiddenSessions', 'isActiveDecision', 'countJudgments', 'sessionsAfterIdleFilter',
    'orderedProducts', 'sessionReferences', 'element', 'productCardSectionOrder', 'productSection',
  ];
  const functions = names.map((name) => functionSource(pageHtml, name));
  assert.ok(functions.every(Boolean));

  class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.className = ''; }
    append(...nodes) { this.children.push(...nodes); }
  }
  const context = pageContext(pageHtml, {
    DEFAULT_SECTION_ORDER: ['sinceSeen', 'judgment', 'prs', 'tasks', 'now'],
    displayPreferences: { hideFinished: true, idleHideMinutes: 30, order: [], pinned: [], collapsed: [] },
    showIdleSessions: false,
    saveDisplayPreferences: (patch) => Object.assign(context.displayPreferences, patch),
    isFilterShown: () => true,
    hasPullRequestMergeResults: () => false,
    document: { createElement: (tagName) => new FakeElement(tagName) },
    sharedBranch: () => '',
    productControls: () => new FakeElement('div'),
    productCloseButton: () => null,
    sinceSeenBox: () => null,
    sessionBlock: () => new FakeElement('div'),
    isAwaitingDecision: () => false,
    pullRequestMergeableCount: () => 0,
    orderedSectionKeys: (keys) => keys,
  });
  vm.runInContext(functions.join('\n'), context);

  const finished = {
    session_id: 'finished', status: '待機中', hidden: false, title: '完了',
    product: { key: 'finished', name: '完了' }, tools: [], lastActivityAt: '2026-10-04T00:00:00.000Z',
    tasks: [{ state: 'done' }], decisions: [{ state: 'resolved' }], permissionWaits: [], agents: [{ active: false, unconfirmed: false }],
  };
  const finishedWithoutTasks = { ...finished, session_id: 'no-tasks', tasks: [], product: { key: 'no-tasks', name: 'タスク無し' } };
  const unknown = { ...finished, session_id: 'unknown', status: '不明', product: { key: 'unknown', name: '不明' } };
  const busy = { ...finished, session_id: 'busy', status: '作業中', product: { key: 'busy', name: '作業中' } };
  const unfinished = { ...finished, session_id: 'unfinished', tasks: [{ state: 'todo' }], product: { key: 'unfinished', name: '未完了' } };
  const visible = [unknown, busy, unfinished];
  const products = context.orderedProducts([finished, finishedWithoutTasks, ...visible]);
  assert.deepEqual(JSON.parse(JSON.stringify(products.map((product) => product.key).sort())), ['busy', 'unfinished', 'unknown']);

  const stale = {
    ...unknown, session_id: 'idle', lastUpdatedAt: new Date(Date.now() - 31 * 60_000).toISOString(),
    product: { key: 'idle', name: '更新なし' },
  };
  assert.deepEqual(JSON.parse(JSON.stringify(context.orderedProducts([stale]).map((product) => product.key))), []);

  const now = Date.parse('2026-10-05T00:00:00.000Z');
  const oldSessionFileTime = {
    ...unknown, lastUpdatedAt: null, sessionFileUpdatedAt: new Date(now - 31 * 60_000).toISOString(),
  };
  const recentSessionFileTime = {
    ...unknown, lastUpdatedAt: null, sessionFileUpdatedAt: new Date(now - 29 * 60_000).toISOString(),
  };
  const noUpdateTime = { ...unknown, lastUpdatedAt: null, sessionFileUpdatedAt: null };
  const hookTimeTakesPrecedence = {
    ...unknown, lastUpdatedAt: new Date(now - 29 * 60_000).toISOString(),
    sessionFileUpdatedAt: new Date(now - 31 * 60_000).toISOString(),
  };
  assert.equal(context.isIdleHiddenSession(oldSessionFileTime, now), true);
  assert.equal(context.isIdleHiddenSession(recentSessionFileTime, now), false);
  assert.equal(context.isIdleHiddenSession(noUpdateTime, now), false);
  assert.equal(context.isIdleHiddenSession(hookTimeTakesPrecedence, now), false);

  const staleWithNews = context.orderedProducts([stale], [], [{
    product: stale.product, items: [{ text: '前回見てからの変化' }],
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(staleWithNews.map((product) => [product.key, product.sessions.length]))), [['idle', 0]]);
  assert.deepEqual(JSON.parse(JSON.stringify(context.sessionReferences(staleWithNews))), []);
  const staleWithPr = context.orderedProducts([stale], [{
    product: stale.product, owner: 'example', repo: 'idle', openCount: 1, openStateUnknown: false,
    loading: false, trees: [], mergeHistory: [], reservationNotices: [],
  }]);
  assert.deepEqual(JSON.parse(JSON.stringify(staleWithPr.map((product) => [product.key, product.sessions.length]))), [['idle', 0]]);

  const oldPullRequest = {
    product: { key: 'old-pr', name: '古い PR' }, owner: 'acme', repo: 'old', openCount: 0,
    openStateUnknown: false, trees: [], merged: [{ number: 7, state: 'closed' }], mergeHistory: [{}],
  };
  assert.deepEqual(JSON.parse(JSON.stringify(context.orderedProducts([], [oldPullRequest]))), []);

  const displayedProduct = {
    key: 'shown', name: '表示中', branches: new Set(), sessions: [{ permissionWaits: [], decisions: [] }], pullRequestGroups: [],
  };
  const section = context.productSection(displayedProduct, 0, [displayedProduct], 0);
  const text = [section, ...section.children].flatMap((node) => [node.textContent || '', ...(node.children || []).map((child) => child.textContent || '')]).join(' ');
  assert.match(text, /オープンの PR はありません/);
});

test('指示欄にフォーカスがある描き直しでは要素と選択範囲を保つ', () => {
  const harness = renderHarness();
  harness.context.render(harness.context.lastState);

  assert.equal(harness.renderCount, 1);
  assert.equal(harness.replacedNote, harness.note);
  assert.equal(harness.currentNote, harness.note);
  assert.notEqual(harness.currentNote, harness.placeholder);
  assert.equal(harness.note.focused, true);
  assert.deepEqual(harness.note.selection, [2, 5, 'backward']);
  assert.equal(harness.note.value, '入力中の指示');
  assert.equal(harness.note.scrollTop, 73);
  assert.equal(harness.note.style.height, '154px');
  assert.deepEqual(harness.note.undoHistory, ['直前の入力']);
  assert.equal(harness.answerDraft.choice, 'ok');
  assert.equal(harness.answerDraft.note, '入力中の指示');
  assert.equal(harness.answerDraftWriteCount, 1);
  assert.equal(harness.updatedAnswerCard, harness.answerCard);
  assert.doesNotMatch(harness.html, /addEventListener\(\s*['"]focusout['"]/);
});

test('指示欄と下書きの note が同じなら下書きを更新しない', () => {
  const harness = renderHarness('入力中の指示');
  harness.context.render(harness.context.lastState);

  assert.equal(harness.answerDraftWriteCount, 0);
  assert.equal(harness.updatedAnswerCard, harness.answerCard);
});

test('選択肢にフォーカスがある描き直しでは同じ input に戻す', () => {
  const html = readWebPage();
  const render = functionSource(html, 'render');
  assert.ok(render);
  let activeElement;
  const pickData = {
    answerPick: 'true', sessionId: 'session-ui', decisionId: 'decision-ui',
    answerQuestion: '1', answerOption: '2',
  };
  const activePick = { dataset: pickData, hasAttribute: () => false };
  const replacementPick = { dataset: { ...pickData }, hasAttribute: () => false, focused: false, focus() { this.focused = true; activeElement = this; } };
  activeElement = activePick;
  const context = pageContext(pageHtml, {
    answerNoteComposing: false,
    lastState: { sessions: [{ session_id: 'session-ui' }] },
    HTMLTextAreaElement: class FakeTextArea {},
    document: {
      get activeElement() { return activeElement; },
      querySelectorAll: () => [],
    },
    root: {
      replaceChildren: () => { activeElement = null; },
      querySelectorAll: () => [replacementPick],
    },
    displayPreferences: { mode: 'product', pinned: [], idleHideMinutes: 30 },
    visibleSinceSeen: (state) => Array.isArray(state?.sinceSeen) ? state.sinceSeen : [],
    idleHiddenSessions: () => [],
    isIdleHiddenSession: () => false,
    sessionsAfterIdleFilter: (sessions) => sessions,
    renderIdleNote() {},
    finishedHiddenCounts: () => ({ sessions: 0, pullRequests: 0 }),
    finishedDeletionTargets: () => ({ session_ids: [], merge_history: [], closed_pull_requests: [] }),
    renderFinishedNote() {},
    renderRouting() {},
    renderSummary() {}, renderExcludedNote() {}, updateTitle() {},
    orderedProducts: () => [{ key: 'product-ui' }],
    productSection: () => ({}),
  });
  vm.runInContext(`${functionSource(pageHtml, 'focusDataFor')}\n${functionSource(pageHtml, 'hasCodexOrigin')}\n${render}`, context);
  context.render(context.lastState);

  assert.equal(replacementPick.focused, true);
  assert.equal(activeElement, replacementPick);
});

test('選択肢を押すと送る答えが表示され、回答を送るが有効になる', () => {
  const html = readWebPage();
  const functionNames = [
    'answerDraftKey', 'answerDraftFor', 'answerValueFor', 'emptyAnswerPicks', 'copyAnswerPicks', 'sameAnswerPicks',
    'sameAnswerDraft', 'answerDraftChanged', 'clearAnswerErrorWhenDraftChanges',
    'displayRecommendedLabel', 'recommendedOptionsForQuestions', 'selectedAnswerLabels',
    'answerMetaText', 'canSendDecisionAnswer', 'updateAnswerSubmit',
  ];
  const functions = functionNames.map((name) => functionSource(html, name));
  const changeHandler = html.match(/document\.addEventListener\('change', \(event\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(functions.every(Boolean));
  assert.ok(changeHandler);

  const decision = {
    id: 'decision-ui',
    state: 'provisional',
    questions: [{
      question: '形式を決める', multiSelect: false,
      options: [{ label: 'JSON (推奨)', recommended: true }, { label: 'CSV', recommended: false }],
    }],
    answer: null,
  };
  const key = 'session-ui\0decision-ui';
  // 単一選択で選び直したときに、前の選択が残らないことも確かめるため、推奨を選んだ状態から始める。
  const answerDrafts = new Map([[key, { choice: 'pick', picks: [['JSON (推奨)']], note: '' }]]);
  const button = { disabled: true };
  const meta = { textContent: '', hidden: true };
  const error = { textContent: '' };
  const card = {
    dataset: { sessionId: 'session-ui', decisionId: 'decision-ui' },
    querySelector(selector) {
      if (selector === '[data-send-answer]') return button;
      if (selector === '[data-answer-meta]') return meta;
      if (selector === '.answer-error') return error;
      return null;
    },
  };
  const pick = {
    type: 'radio', checked: true,
    dataset: {
      sessionId: 'session-ui', decisionId: 'decision-ui', answerQuestion: '0', answerOption: '1',
    },
    closest(selector) {
      if (selector === '[data-answer-pick]') return this;
      if (selector === '.decision-card') return { querySelector: (inner) => (inner === '.decision-answer' ? card : null) };
      return null;
    },
  };
  let handleChange;
  const context = pageContext(pageHtml, {
    answerDrafts,
    answerErrors: new Map(),
    decisionAnswerInFlight: new Set(),
    findDecision: () => decision,
    document: { addEventListener: (name, handler) => { if (name === 'change') handleChange = handler; } },
  });
  vm.runInContext(`${functions.join('\n')}\n${changeHandler}`, context);
  handleChange({ target: pick });

  assert.equal(answerDrafts.get(key).choice, 'pick');
  assert.equal(JSON.stringify(answerDrafts.get(key).picks), '[["CSV"]]');
  assert.equal(meta.textContent, '送る答え: CSV');
  assert.equal(meta.hidden, false);
  assert.equal(button.disabled, false);
  assert.equal(error.textContent, '');
});

function decisionAnswerPickHarness(decision, postResponse = async () => ({ ok: true })) {
  const html = readWebPage().replace(/\r\n/g, '\n');
  const functionNames = [
    'answerDraftKey', 'answerDraftFor', 'answerValueFor', 'emptyAnswerPicks', 'copyAnswerPicks', 'sameAnswerPicks',
    'sameAnswerDraft', 'answerDraftChanged', 'clearAnswerErrorWhenDraftChanges',
    'displayRecommendedLabel', 'recommendedOptionsForQuestions', 'selectedAnswerLabels',
    'answerMetaText', 'canSendDecisionAnswer', 'answerStatusText', 'focusDataFor', 'rememberActionFocus', 'updateAnswerSubmit', 'clearSelectedAnswerPick', 'sendDecisionAnswer',
  ];
  const functions = functionNames.map((name) => functionSource(html, name));
  const clickHandler = html.match(/document\.addEventListener\('click', \(event\) => \{\n  const pick = event\.target\.closest\('\[data-answer-pick\]'\);[\s\S]*?\n\}\);/)?.[0];
  const keydownHandler = html.match(/document\.addEventListener\('keydown', \(event\) => \{\n  if \(event\.key !== ' ' && event\.code !== 'Space'\) return;[\s\S]*?\n\}\);/)?.[0];
  const changeHandler = html.match(/document\.addEventListener\('change', \(event\) => \{\n  const pick = event\.target\.closest\('\[data-answer-pick\]'\);[\s\S]*?\n\}\);/)?.[0];
  const inputHandler = html.match(/document\.addEventListener\('input', \(event\) => \{\n  const note = event\.target\.closest\('\[data-answer-note\]'\);[\s\S]*?\n\}\);/)?.[0];
  assert.ok(functions.every(Boolean));
  assert.ok(clickHandler && keydownHandler && changeHandler && inputHandler);

  const answerDrafts = new Map();
  const answerErrors = new Map();
  const decisionAnswerInFlight = new Set();
  let card;
  const button = {
    disabled: true, attributes: {}, dataset: { sessionId: 'session-pick', sendAnswer: decision.id }, isConnected: true,
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    closest(selector) { return selector === '.decision-answer' ? card : null; },
  };
  const meta = { textContent: '', hidden: true };
  const status = { textContent: '' };
  const error = { textContent: '' };
  card = {
    dataset: { sessionId: 'session-pick', decisionId: decision.id },
    querySelector(selector) {
      if (selector === '[data-send-answer]') return button;
      if (selector === '[data-answer-meta]') return meta;
      if (selector === '.answer-foot .answer-status') return status;
      if (selector === '.answer-error') return error;
      return null;
    },
  };
  const decisionCard = { querySelector: (selector) => (selector === '.decision-answer' ? card : null) };
  const listeners = new Map();
  let renderCount = 0;
  let postCount = 0;
  const context = pageContext(html, {
    answerDrafts,
    answerErrors,
    decisionAnswerInFlight,
    actionFocusRestores: new Map(),
    findDecision: (sessionId, decisionId) => (sessionId === 'session-pick' && decisionId === decision.id ? decision : null),
    absoluteTimeLabel: () => '保存済みの時刻',
    lastState: { sessions: [] },
    render: () => { renderCount += 1; },
    root: { querySelectorAll: () => [] },
    refresh: async () => {},
    liveStatus: { textContent: '' },
    showWriteError() {},
    postUiAction: async () => { postCount += 1; return postResponse(); },
    document: { addEventListener: (name, handler) => listeners.set(name, handler) },
  });
  vm.runInContext(`${functions.join('\n')}\n${clickHandler}\n${keydownHandler}\n${changeHandler}\n${inputHandler}`, context);

  const makePick = (optionIndex, checked = true) => ({
    type: 'radio', checked,
    dataset: { sessionId: 'session-pick', decisionId: decision.id, answerQuestion: '0', answerOption: String(optionIndex) },
    closest(selector) {
      if (selector === '[data-answer-pick]') return this;
      if (selector === '.decision-card') return decisionCard;
      return null;
    },
  });
  const note = {
    value: '',
    dataset: { sessionId: 'session-pick', decisionId: decision.id },
    hasAttribute: name => name === 'data-answer-note',
    closest(selector) {
      if (selector === '[data-answer-note]') return this;
      if (selector === '.decision-answer') return card;
      return null;
    },
  };
  return {
    context, listeners, answerDrafts, answerErrors, decisionAnswerInFlight, button, meta, status, card, makePick, note,
    get renderCount() { return renderCount; },
    get postCount() { return postCount; },
  };
}

test('選択済みの単一選択をもう一度押すと外れ、指示だけで送れる', () => {
  const decision = {
    id: 'decision-deselect',
    questions: [{
      question: '形式を決める', multiSelect: false,
      options: [{ label: 'JSON (推奨)', recommended: true }, { label: 'CSV', recommended: false }],
    }],
    answer: null,
  };
  const harness = decisionAnswerPickHarness(decision);
  const pick = harness.makePick(1);
  harness.listeners.get('change')({ target: pick });

  assert.equal(harness.answerDrafts.get('session-pick\0decision-deselect').choice, 'pick');
  assert.equal(harness.meta.textContent, '送る答え: CSV');
  assert.equal(harness.button.disabled, false);

  harness.listeners.get('click')({ target: pick });
  assert.equal(pick.checked, false);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.answerDrafts.get('session-pick\0decision-deselect').picks)), [[]]);
  assert.equal(harness.answerDrafts.get('session-pick\0decision-deselect').choice, null);
  assert.equal(harness.meta.textContent, '');
  assert.equal(harness.meta.hidden, true);
  assert.equal(harness.button.disabled, true);

  harness.note.value = '選択肢は決めず、対応方針だけ確認してください';
  harness.listeners.get('input')({ target: harness.note });
  const draft = harness.answerDrafts.get('session-pick\0decision-deselect');
  assert.equal(draft.choice, null);
  assert.equal(draft.note, harness.note.value);
  assert.equal(harness.button.disabled, false);
});

test('回答の送信中は選択肢、指示、再送信の変更を捨てる', async () => {
  const decision = {
    id: 'decision-in-flight',
    questions: [{
      question: '形式を決める', multiSelect: false,
      options: [{ label: 'JSON (推奨)', recommended: true }, { label: 'CSV', recommended: false }],
    }],
    answer: null,
  };
  const harness = decisionAnswerPickHarness(decision);
  const key = 'session-pick\0decision-in-flight';
  const submittedDraft = { choice: 'pick', picks: [['JSON (推奨)']], note: '送信した指示' };
  harness.answerDrafts.set(key, submittedDraft);
  harness.decisionAnswerInFlight.add(key);

  const pick = harness.makePick(1);
  harness.listeners.get('change')({ target: pick });
  harness.listeners.get('click')({ target: pick });
  harness.note.value = '送信中に変えた指示';
  harness.listeners.get('input')({ target: harness.note });
  await harness.context.sendDecisionAnswer(harness.button);

  assert.deepEqual(JSON.parse(JSON.stringify(harness.answerDrafts.get(key))), submittedDraft);
  assert.equal(harness.postCount, 0);
  assert.equal(harness.renderCount, 3);
});

test('回答の送信中は aria-disabled のボタンへフォーカスを保ち、二重送信しない', async () => {
  const decision = { id: 'decision-send', questions: [{ question: '形式', options: [{ label: 'JSON' }] }], answer: null };
  let resolveResponse;
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const harness = decisionAnswerPickHarness(decision, () => response);
  harness.answerDrafts.set('session-pick\0decision-send', { choice: 'pick', picks: [['JSON']], note: '' });
  const pending = harness.context.sendDecisionAnswer(harness.button);

  assert.equal(harness.button.disabled, false);
  assert.equal(harness.button.attributes['aria-disabled'], 'true');
  await harness.context.sendDecisionAnswer(harness.button);
  assert.equal(harness.postCount, 1);
  resolveResponse({ ok: true });
  await pending;
  assert.equal(harness.button.attributes['aria-disabled'], 'false');
});

test('保存済みの choice ok の推奨選択肢は押すと外れ、変更状態に更新される', () => {
  const decision = {
    id: 'decision-saved-ok',
    questions: [{
      question: '形式を決める', multiSelect: false,
      options: [{ label: 'JSON (推奨)', recommended: true }, { label: 'CSV', recommended: false }],
    }],
    answer: { choice: 'ok', picks: [], note: '', sentAt: '2026-10-08T00:00:00.000Z' },
  };
  const harness = decisionAnswerPickHarness(decision);
  const pick = harness.makePick(0);
  harness.listeners.get('click')({ target: pick });

  const draft = harness.answerDrafts.get('session-pick\0decision-saved-ok');
  assert.equal(pick.checked, false);
  assert.deepEqual(JSON.parse(JSON.stringify(draft.picks)), [[]]);
  assert.equal(draft.choice, null);
  assert.equal(harness.meta.textContent, '');
  assert.equal(harness.meta.hidden, true);
  assert.equal(harness.status.textContent, '変更は未送信');
  assert.equal(harness.button.disabled, true);
});

test('選択済みラジオ上の Space は選択を外し、矢印キーは解除処理に入らない', () => {
  const decision = {
    id: 'decision-space',
    questions: [{
      question: '形式を決める', multiSelect: false,
      options: [{ label: 'JSON (推奨)', recommended: true }, { label: 'CSV', recommended: false }],
    }],
    answer: null,
  };
  const harness = decisionAnswerPickHarness(decision);
  harness.answerDrafts.set('session-pick\0decision-space', { choice: 'pick', picks: [['CSV']], note: '' });
  const pick = harness.makePick(1);
  let prevented = false;
  harness.listeners.get('keydown')({ target: pick, key: ' ', code: 'Space', preventDefault: () => { prevented = true; } });

  assert.equal(prevented, true);
  assert.equal(pick.checked, false);
  assert.equal(harness.answerDrafts.get('session-pick\0decision-space').choice, null);
  assert.deepEqual(JSON.parse(JSON.stringify(harness.answerDrafts.get('session-pick\0decision-space').picks)), [[]]);

  prevented = false;
  harness.listeners.get('keydown')({ target: pick, key: 'ArrowDown', code: 'ArrowDown', preventDefault: () => { prevented = true; } });
  assert.equal(prevented, false);
});

test('モックでも保存済みの choice ok は推奨選択肢を押すと外れ、指示のみで送れる', () => {
  const html = mockHtml.replace(/\r\n/g, '\n');
  const helpers = sourceBetween(html, 'function answerOf(id)', '\n\nconst allSessions');
  const clearPick = functionSource(html, 'clearSelectedMockPick');
  const clickHandler = html.match(/document\.addEventListener\('click', e => \{\n  const pick = e\.target\.closest\('input\[data-pick\]'\);[\s\S]*?\n\}\);/)?.[0];
  const keydownHandler = html.match(/document\.addEventListener\('keydown', e => \{\n  if \(e\.key !== ' ' && e\.code !== 'Space'\) return;[\s\S]*?\n\}\);/)?.[0];
  assert.ok(helpers);
  assert.ok(clearPick && clickHandler && keydownHandler);

  const decision = {
    id: 'decision-mock',
    options: [{ t: 'JSON', rec: true }, { t: 'CSV', rec: false }],
  };
  const ui = { answers: { 'decision-mock': {
    choice: 'ok', picks: [], note: '',
    sent: { choice: 'ok', picks: [], note: '', at: '2026-10-08 09:00' },
  } } };
  const card = {
    dataset: { id: decision.id, sessionId: 'session-mock' },
    querySelector: () => null,
  };
  const pick = {
    type: 'radio', checked: true, dataset: { pick: '0' },
    closest(selector) {
      if (selector === 'input[data-pick]') return this;
      if (selector === '.decision') return card;
      return null;
    },
  };
  const listeners = new Map();
  let saveCount = 0;
  let renderCount = 0;
  const context = pageContext(html, {
    ui,
    answerErrors: new Map(),
    allSessions: () => [{ decisions: [decision] }],
    save: () => { saveCount += 1; },
    render: () => { renderCount += 1; },
    document: { addEventListener: (name, handler) => listeners.set(name, handler) },
  });
  vm.runInContext(`${helpers}\n${clearPick}\n${clickHandler}\n${keydownHandler}\nthis.canSendAnswerDraft = canSend; this.answerDraftIsDirty = answerDirty;`, context);
  listeners.get('click')({ target: pick });

  let answer = ui.answers[decision.id];
  assert.equal(answer.choice, null);
  assert.deepEqual([...answer.picks], []);
  assert.equal(pick.checked, false);
  assert.equal(context.canSendAnswerDraft(answer), false);
  assert.equal(context.answerDraftIsDirty(answer, decision), true);

  ui.answers[decision.id] = {
    choice: 'ok', picks: [], note: '',
    sent: { choice: 'ok', picks: [], note: '', at: '2026-10-08 09:00' },
  };
  pick.checked = true;
  let prevented = false;
  listeners.get('keydown')({
    target: pick, key: ' ', code: 'Space', preventDefault: () => { prevented = true; },
  });
  answer = ui.answers[decision.id];
  assert.equal(prevented, true);
  assert.equal(answer.choice, null);
  assert.deepEqual([...answer.picks], []);
  assert.equal(pick.checked, false);

  answer.note = '選択肢は決めず、対応方針だけ確認してください';
  assert.equal(context.canSendAnswerDraft(answer), true);
  assert.equal(saveCount, 2);
  assert.equal(renderCount, 2);
});

test('送信済みの推奨案で OK は推奨選択肢を選んだ下書きとして表示する', () => {
  const html = readWebPage();
  const names = [
    'answerDraftFor', 'answerValueFor', 'copyAnswerPicks', 'recommendedOptionsForQuestions',
    'answerDraftChanged', 'sameAnswerPicks', 'displayRecommendedLabel', 'selectedAnswerLabels', 'answerMetaText', 'canSendDecisionAnswer', 'answerStatusText',
  ];
  const functions = names.map((name) => functionSource(html, name));
  assert.ok(functions.every(Boolean));

  const decision = {
    id: 'decision-legacy',
    questions: [
      {
        question: '形式を決める', multiSelect: false,
        options: [{ label: 'JSON (推奨)', recommended: true }, { label: 'CSV', recommended: false }],
      },
      {
        question: '排他制御の方式を決める', multiSelect: false,
        options: [{ label: '行ロック', recommended: true }, { label: '楽観ロック', recommended: false }],
      },
    ],
    answer: { choice: 'ok', picks: [], note: '保存済みの指示', sentAt: '2026-10-03T00:00:00.000Z' },
  };
  const context = pageContext(html, {
    answerDrafts: new Map(),
    absoluteTimeLabel: () => '保存済みの時刻',
  });
  vm.runInContext(`${functions.join('\n')}\nthis.makeDraft = answerDraftFor; this.changed = answerDraftChanged; this.meta = answerMetaText; this.canSend = canSendDecisionAnswer; this.status = answerStatusText;`, context);
  const draft = context.makeDraft(decision, { session_id: 'session-legacy' });

  assert.equal(draft.choice, 'pick');
  assert.deepEqual(JSON.parse(JSON.stringify(draft.picks)), [['JSON (推奨)'], ['行ロック']]);
  assert.equal(context.changed(decision, draft), false);
  assert.equal(context.meta(decision, draft), '送る答え: JSON、行ロック');
  assert.equal(context.canSend(decision, draft), true);
  assert.equal(context.status(decision.answer, decision), '保存済みの時刻 に送信済み: 推奨案で OK (指示あり)');
});

test('指示欄の変換中は描き直しを保留し、変換終了後に反映する', () => {
  const harness = renderHarness();
  harness.context.answerNoteComposing = true;
  harness.context.render(harness.context.lastState);
  harness.context.renderDeferredState();

  assert.equal(harness.renderCount, 0);
  assert.equal(harness.context.deferredRenderPending, true);

  harness.context.answerNoteComposing = false;
  harness.context.renderDeferredState();

  assert.equal(harness.renderCount, 1);
  assert.equal(harness.currentNote, harness.note);
  assert.equal(harness.note.focused, true);
  assert.deepEqual(harness.note.selection, [2, 5, 'backward']);
});

test('PR マージ確認欄を表示し、登録キーと画面の head SHA だけを含む値を送る', async () => {
  const html = readWebPage();
  const helpers = sourceBetween(html, 'function element(tag, className, text)', 'function durationLabel');
  const component = sourceBetween(html, 'const MERGE_METHOD_LABELS', 'function appendPullRequestBlock');
  const action = sourceBetween(html, 'function findPullRequestMergeTarget', 'async function runSessionAction');
  assert.ok(helpers && component && action);

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.textContent = '';
      this.disabled = false;
    }

    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  class FakeText {
    constructor(text) { this.textContent = text; }
  }
  const sent = [];
  const key = 'd'.repeat(64);
  const pullRequest = {
    mergeSessionId: 'session-pr', number: 42, title: 'Feature PR', url: 'https://github.com/acme/widget/pull/42',
    mergeRecordKey: key,
    headRefOid: 'abc123', headRefName: 'feature/pr-42', effectiveBase: 'main', mergeTarget: 'main', canMerge: true,
    isCrossRepository: true,
    blocker: null, review: 'approved', children: [], stackPosition: { depth: 1, total: 1 },
  };
  const group = {
    owner: 'acme', repo: 'widget', defaultBranch: 'main', mergeMethods: ['merge', 'squash', 'rebase'],
    lastMethod: 'merge', trees: [pullRequest],
  };
  const context = pageContext(pageHtml, {
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
    },
    pullRequestMergeConfirmations: new Map([[key, 'merge']]),
    pullRequestMergeOptions: new Map([[key, { method: 'rebase', deleteBranch: false }]]),
    pullRequestMergeMessages: new Map(), queuedPullRequestMerges: new Map(), queuedPullRequestMerge: () => null,
    pullRequestMergeInFlight: new Set(), actionFocusRestores: new Map(), rememberActionFocus() {}, pullRequestResultUnconfirmed: () => false, pullRequestUnconfirmedResults: new Map(), refreshSequence: 0, pullRequestReservationPending: new Map(),
    displayPreferences: {},
    lastState: { pullRequests: [group] },
    appendPullRequestBadges() {},
    absoluteTimeLabel: () => '時刻不明',
    durationAgoLabel: () => '時刻不明',
    postUiAction: async (url, body) => {
      sent.push({ url, body });
      return { ok: true, json: async () => ({}) };
    },
    refresh: async () => {},
    render() {},
    liveStatus: { textContent: '' },
  });
  const source = [
    helpers,
    component,
    action,
  ].join('\n');
  vm.runInContext(source, context);

  const root = new FakeElement('div');
  context.appendPullRequestTree(root, group, reviewPr(pullRequest));
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  const panel = nodes.find((node) => node.dataset?.mergeConfirm === key);
  assert.ok(panel);
  assert.equal(panel.attributes['aria-label'], 'PR #42 のマージ確認');
  assert.ok(nodes.some((node) => node.dataset?.mergeGo === key));
  assert.ok(nodes.some((node) => node.type === 'radio' && node.checked && node.value === 'rebase'));
  assert.ok(nodes.some((node) => node.type === 'checkbox' && node.checked === false && node.disabled));
  assert.ok(nodes.some((node) => node.textContent === 'fork のブランチは登録先から削除できません'));

  const confirmationText = () => {
    const target = new FakeElement('div');
    context.appendPullRequestMergeConfirmation(target, group, reviewPr(pullRequest));
    const texts = [];
    const collect = (node) => {
      texts.push(node.textContent);
      for (const child of node.children || []) collect(child);
    };
    collect(target);
    return texts.join('\n');
  };
  pullRequest.children = [];
  assert.doesNotMatch(confirmationText(), /マージコミットを推奨/);
  pullRequest.children = [{ number: 43 }];
  assert.match(confirmationText(), /ブランチを残すので、#43 の base は feature\/pr-42 のまま付け替えない/);
  assert.match(confirmationText(), /マージコミットを推奨/);
  pullRequest.isCrossRepository = false;
  context.pullRequestMergeOptions.set(key, { method: 'rebase', deleteBranch: true });
  assert.match(confirmationText(), /#43 の base を main に付け替える/);
  assert.match(confirmationText(), /セッションに積み直しを依頼する/);
  assert.doesNotMatch(confirmationText(), /マージコミットを推奨/);
  context.pullRequestMergeOptions.set(key, { method: 'rebase', deleteBranch: false });
  assert.match(confirmationText(), /ブランチを残すので/);
  assert.doesNotMatch(confirmationText(), /セッションに積み直しを依頼する/);
  group.autoDeleteBranch = true;
  assert.match(confirmationText(), /#43 の base を main に付け替える/);
  pullRequest.isCrossRepository = true;
  assert.match(confirmationText(), /ブランチを残すので/);
  group.autoDeleteBranch = false;

  await context.runPullRequestMergeAction({ dataset: { mergeGo: key } }, 'merge');
  assert.equal(JSON.stringify(sent), JSON.stringify([{
    url: '/api/pull-requests/merge',
    body: { number: 42, registration_key: key, headRefOid: 'abc123', method: 'rebase', deleteBranch: false },
  }]));
});

test('衝突した PR にだけ依頼ボタンを出し、終了扱いの依頼先を無効化し、依頼済みの状態を表示する', async () => {
  const html = readWebPage();
  const absoluteTimeSource = functionSource(html, 'absoluteTimeLabel');
  const helpers = sourceBetween(html, 'function element(tag, className, text)', 'function durationLabel');
  const component = sourceBetween(html, 'const MERGE_METHOD_LABELS', 'function appendPullRequestBlock');
  const action = sourceBetween(html, 'function findPullRequestMergeTarget', 'async function runSessionAction');
  const clickHandler = html.match(/document\.addEventListener\('click', \(event\) => \{\r?\n  if \(event\.button === 0 && handleExternalLink\(event\)\) return;[\s\S]*?\r?\n\}\);/)?.[0];
  assert.ok(helpers && component && action && clickHandler);
  assert.ok(absoluteTimeSource);

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.textContent = '';
      this.disabled = false;
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  class FakeText { constructor(text) { this.textContent = text; } }
  const key = 'a'.repeat(64);
  const uiKey = 'example/project#42';
  const pullRequest = {
    mergeSessionId: null, number: 42, title: 'Feature PR', url: 'https://github.com/example/project/pull/42',
    conflictRequestKey: key, headRefOid: 'b'.repeat(40), headRefName: 'feature/conflict',
    effectiveBase: 'main', baseRefName: 'main', conflict: true, canMerge: false,
    blocker: 'コンフリクトあり', children: [], conflictRequestTargets: [{ sessionId: 'session-pr', alive: true }],
  };
  const group = { owner: 'example', repo: 'project', defaultBranch: 'main', mergeMethods: [], trees: [pullRequest] };
  const sent = [];
  const conflictConfirmations = new Set();
  const conflictMessages = new Map();
  const conflictInFlight = new Set();
  let documentClickHandler;
  let renderCount = 0;
  const context = pageContext(pageHtml, {
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
      addEventListener: (name, handler) => { if (name === 'click') documentClickHandler = handler; },
    },
    pullRequestMergeConfirmations: new Map(), pullRequestMergeOptions: new Map(), pullRequestMergeMessages: new Map(), queuedPullRequestMerges: new Map(), queuedPullRequestMerge: () => null, pullRequestMergeInFlight: new Set(), actionFocusRestores: new Map(), rememberActionFocus() {}, pullRequestResultUnconfirmed: () => false, pullRequestUnconfirmedResults: new Map(), refreshSequence: 0, pullRequestReservationPending: new Map(),
    pullRequestConflictConfirmations: conflictConfirmations, pullRequestConflictMessages: conflictMessages, pullRequestConflictInFlight: conflictInFlight,
    lastState: { sessions: [{ session_id: 'session-pr', title: 'Feature session' }, { session_id: 'session-codex', provider: 'codex' }], pullRequests: [group] },
    appendPullRequestBadges() {},
    crossReviewState: () => ({}),
    pullRequestTransientNoticeExpired: () => false,
    postUiAction: async (url, body) => { sent.push({ url, body }); return { ok: true, json: async () => ({ requestedAt: '2026-10-03T03:04:00.000Z' }) }; },
    refresh: async () => {}, render() { renderCount += 1; }, liveStatus: { textContent: '' },
  });
  vm.runInContext([
    absoluteTimeSource,
    helpers, component, action, clickHandler,
  ].join('\n'), context);
  vm.runInContext("Date.now = () => new Date(2026, 9, 5).getTime()", context);
  const flatten = (node) => [node, ...(node.children || []).flatMap(flatten)];
  const textOf = (node) => [node.textContent, ...(node.children || []).map(textOf)].join('');
  const renderPullRequest = (value) => {
    const root = new FakeElement('div');
    context.appendPullRequestTree(root, group, reviewPr(value));
    return flatten(root);
  };

  let nodes = renderPullRequest(pullRequest);
  const requestButton = nodes.find((node) => node.dataset?.conflictOpen === uiKey);
  assert.ok(requestButton);
  assert.equal(requestButton.textContent, 'コンフリクト解決');

  conflictConfirmations.add(uiKey);
  conflictMessages.set(uiKey, { message: '依頼のエラー', shownAt: Date.now() });
  conflictInFlight.add(uiKey);
  nodes = renderPullRequest(pullRequest);
  const cancelWhileSending = nodes.find((node) => node.dataset?.conflictCancel === uiKey);
  const goWhileSending = nodes.find((node) => node.dataset?.conflictGo === uiKey);
  assert.ok(cancelWhileSending);
  assert.equal(cancelWhileSending.disabled, true);
  assert.equal(goWhileSending.disabled, false);
  assert.equal(goWhileSending.attributes['aria-disabled'], 'true');
  const cancelButton = { dataset: { conflictCancel: uiKey } };
  documentClickHandler({ button: 1, target: { closest: (selector) => selector === 'button' ? cancelButton : null } });
  assert.equal(conflictConfirmations.has(uiKey), true);
  assert.equal(conflictMessages.get(uiKey).message, '依頼のエラー');
  assert.equal(renderCount, 0);
  conflictInFlight.delete(uiKey);
  conflictConfirmations.delete(uiKey);
  conflictMessages.delete(uiKey);

  const nonConflict = renderPullRequest({ ...pullRequest, conflict: false });
  assert.equal(nonConflict.some((node) => node.dataset?.conflictOpen), false);

  const noTarget = renderPullRequest({ ...pullRequest, conflictRequestTargets: [{ sessionId: 'session-pr', alive: false }] });
  assert.equal(noTarget.find((node) => node.dataset?.conflictOpen === uiKey).disabled, true);
  assert.ok(noTarget.some((node) => textOf(node).includes('依頼先の Feature session のセッションが終了している')));

  // 依頼の後に登録したセッションは、依頼済みの表示に含めない。
  const sentOnlyToFirst = renderPullRequest({
    ...pullRequest,
    conflictRequestTargets: [{ sessionId: 'session-pr', alive: true }, { sessionId: 'session-later', alive: true }],
    conflictRequest: { requestedAt: '2026-10-03T03:04:00.000Z', sessionIds: ['session-pr'] },
  });
  const sentStatus = textOf(sentOnlyToFirst.find((node) => node.attributes?.role === 'status'));
  assert.match(sentStatus, /Feature session のセッションへ/);
  assert.doesNotMatch(sentStatus, /session-later/);

  // 名前の無い Codex のセッションは表示名が「Codex のセッション」なので、「のセッション」を重ねない。
  const sentToCodex = renderPullRequest({
    ...pullRequest,
    conflictRequestTargets: [{ sessionId: 'session-codex', alive: false }],
    conflictRequest: { requestedAt: '2026-10-03T03:04:00.000Z', sessionIds: ['session-codex'] },
  });
  const codexText = sentToCodex.map(textOf).join('\n');
  assert.ok(codexText.includes('Codex のセッションへ衝突の解消を依頼した'));
  assert.ok(codexText.includes('依頼先の Codex のセッションが終了している'));
  assert.doesNotMatch(codexText, /のセッション のセッション/);
  conflictConfirmations.add(uiKey);
  const confirmToCodex = renderPullRequest({ ...pullRequest, conflictRequestTargets: [{ sessionId: 'session-codex', alive: true }] });
  assert.ok(confirmToCodex.some((node) => textOf(node).includes('Codex のセッションに、base の main')));
  conflictConfirmations.delete(uiKey);

  pullRequest.conflictRequest = { requestedAt: '2026-10-03T03:04:00.000Z', sessionIds: ['session-pr'] };
  context.pullRequestConflictConfirmations.add(uiKey);
  nodes = renderPullRequest(pullRequest);
  assert.equal(nodes.find((node) => node.dataset?.conflictOpen === uiKey).textContent, 'もう一度依頼する');
  assert.ok(nodes.some((node) => textOf(node).includes('Feature session のセッションへ衝突の解消を依頼した')));
  const expectedRequestTime = context.absoluteTimeLabel('2026-10-03T03:04:00.000Z', new Date(2026, 9, 5).getTime(), '時刻不明');
  assert.ok(textOf(nodes.find((node) => node.attributes?.role === 'status')).startsWith(`${expectedRequestTime} に Feature session`));
  assert.ok(nodes.find((node) => node.dataset?.conflictConfirm === uiKey));
  assert.equal(nodes.filter((node) => node.tagName === 'li').length, 3);
  assert.ok(nodes.some((node) => node.dataset?.conflictGo === uiKey && node.textContent === '依頼を送る'));
  assert.ok(nodes.some((node) => node.dataset?.conflictCancel === uiKey && node.textContent === 'やめる'));
  await context.runPullRequestConflictRequest({ dataset: { conflictGo: uiKey } });
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [{
    url: '/api/pull-requests/conflict-request', body: { key, headRefOid: 'b'.repeat(40) },
  }]);
});

test('PR 行のチェックで予約し、確認欄は常に即時マージする', async () => {
  const html = readWebPage();
  const helpers = sourceBetween(html, 'function element(tag, className, text)', 'function durationLabel');
  const component = sourceBetween(html, 'const MERGE_METHOD_LABELS', 'function appendPullRequestBlock');
  const action = sourceBetween(html, 'function findPullRequestMergeTarget', 'async function runSessionAction');
  const reservationSources = ['isCompleteCommitSha', 'pullRequestReservationWaitReasons', 'pullRequestReservationWaits']
    .map((name) => functionSource(html, name));
  const resultSources = ['pullRequestRepositoryKey', 'rememberPullRequestMergeResult', 'pullRequestTimestampExpired', 'pullRequestTransientNoticeExpired']
    .map((name) => functionSource(html, name));
  assert.ok(helpers && component && action && reservationSources.every(Boolean) && resultSources.every(Boolean));

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.textContent = '';
      this.disabled = false;
    }

    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  class FakeText {
    constructor(text) { this.textContent = text; }
  }
  const sent = [];
  const responses = [
    { ok: true, body: { merged: false } },
    { ok: true, body: { reserved: true } },
    { ok: true, body: { cancelled: true, message: 'PR #42 のマージ予約を取り消しました。' } },
    { ok: true, body: { merged: true, branchDeleted: false, warning: null } },
    { ok: true, body: { queued: true } },
  ];
  let holdReservation = false;
  let releaseReservation;
  const key = 'e'.repeat(64);
  const pullRequest = {
    mergeSessionId: 'session-pr', number: 42, title: 'Feature PR', url: 'https://github.com/acme/widget/pull/42',
    mergeRecordKey: key, headRefOid: 'abc123', headRefName: 'feature/pr-42', effectiveBase: 'main', canMerge: true,
    isCrossRepository: false, blocker: null, review: 'approved', ci: 'pass', children: [], stackPosition: { depth: 1, total: 1 },
  };
  const group = {
    owner: 'acme', repo: 'widget', defaultBranch: 'main', autoDeleteBranch: true,
    mergeMethods: ['merge', 'squash'], lastMethod: 'merge', trees: [pullRequest],
  };
  const context = pageContext(pageHtml, {
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
    },
    TRANSIENT_NOTICE_MS: 60_000,
    pullRequestMergeOptions: new Map([[key, { method: 'merge', deleteBranch: true }]]),
    pullRequestMergeConfirmations: new Map(),
    pullRequestMergeMessages: new Map(), queuedPullRequestMerges: new Map(), queuedPullRequestMerge: () => null,
    pullRequestMergeInFlight: new Set(), actionFocusRestores: new Map(), rememberActionFocus() {}, pullRequestResultUnconfirmed: () => false, pullRequestUnconfirmedResults: new Map(), refreshSequence: 0, pullRequestReservationPending: new Map(),
    pullRequestMergeResults: new Map(),
    nextPullRequestMergeResultId: 0,
    CI_LABELS: { pass: { wait: 'CI 成功' }, unknown: { wait: 'CI 状態不明' } },
    displayPreferences: { mergeableCondition: 'cross-review' },
    lastState: { pullRequests: [group] },
    appendPullRequestBadges() {},
    absoluteTimeLabel: () => '時刻不明',
    durationAgoLabel: () => '時刻不明',
    postUiAction: (url, body) => {
      sent.push({ url, body });
      if (holdReservation && url === '/api/pull-requests/reserve') {
        holdReservation = false;
        return new Promise((resolve) => {
          releaseReservation = () => resolve({ ok: false, json: async () => ({ error: '表示していた head SHA と現在の head SHA が異なります。' }) });
        });
      }
      const response = responses.shift();
      return Promise.resolve({ ok: response.ok, json: async () => response.body });
    },
    refresh: async () => {},
    render() {},
    liveStatus: { textContent: '' },
    recordPullRequestTransientMessage: (messages, messageKey, message) => messages.set(messageKey, { message, shownAt: Date.now() }),
  });
  const source = [
    helpers,
    ...reservationSources,
    ...resultSources,
    component,
    action,
  ].join('\n');
  vm.runInContext(source, context);

  const flatten = (root) => {
    const nodes = [root];
    for (const child of root.children || []) nodes.push(...flatten(child));
    return nodes;
  };
  const textOf = (node) => [node.textContent, ...(node.children || []).map(textOf)].join('');
  const mergeRoot = new FakeElement('div');
  context.appendPullRequestMergeConfirmation(mergeRoot, group, reviewPr(pullRequest));
  const mergeNodes = flatten(mergeRoot);
  const shaEffect = mergeNodes.find((node) => node.children?.[0]?.textContent === '照合する head SHA: ');
  assert.ok(shaEffect);
  assert.equal(shaEffect.children[1].textContent, 'abc123');
  assert.ok(mergeNodes.some((node) => node.className === 'merge-condition-warning'));
  const effectText = mergeNodes.map((node) => node.textContent).join(' ');
  assert.doesNotMatch(effectText, /GitHub が自動で削除する|結果を PR を作ったセッションへ知らせる/);
  assert.doesNotMatch(mergeNodes.map(textOf).join(' '), /レビュー収束後マージ/);
  assert.equal(mergeNodes.some((node) => node.dataset?.mergeAfterReview), false);
  const mergeButton = mergeNodes.find((node) => node.dataset?.mergeGo === key);
  assert.ok(mergeButton);
  assert.equal(mergeButton.textContent, 'マージを実行');
  await context.runPullRequestMergeAction(mergeButton);
  assert.equal(context.liveStatus.textContent, 'PR #42 をマージしました。');

  pullRequest.children = [{ number: 43, children: [] }, { number: 44, children: [] }];
  context.pullRequestMergeOptions.set(key, { method: 'squash', deleteBranch: false });
  const restackRoot = new FakeElement('div');
  context.appendPullRequestMergeConfirmation(restackRoot, group, reviewPr(pullRequest));
  assert.ok(flatten(restackRoot).some((node) => node.textContent.includes('#43、#44 に #42 のコミットが残る')));

  context.pullRequestMergeOptions.set(key, { method: 'merge', deleteBranch: true });
  const rowRoot = new FakeElement('div');
  context.appendPullRequestTree(rowRoot, group, reviewPr(pullRequest));
  const rowNodes = flatten(rowRoot);
  const line = rowNodes.find((node) => node.className === 'pline');
  const reservationToggle = rowNodes.find((node) => node.dataset?.reservationToggle === key);
  assert.ok(reservationToggle);
  assert.equal(reservationToggle.checked, false);
  const mergeActions = rowNodes.find((node) => node.className === 'pr-actions');
  assert.ok(mergeActions, 'マージの操作と予約のチェックは右の列に置く');
  assert.equal(flatten(line).some((node) => node.dataset?.openMerge === key || node.dataset?.reservationToggle === key), false, '題の行には操作を混ぜない');
  assert.deepEqual(mergeActions.children.map((node) => node.className), ['merge-state', 'merge-btn outline', 'reservation-toggle']);
  assert.equal(mergeActions.children[0].textContent, 'マージ操作は可能');
  assert.equal(mergeActions.children.includes(rowNodes.find((node) => node.dataset?.openMerge === key)), true);
  const reservationLabel = mergeActions.children.find((node) => node.className === 'reservation-toggle');
  assert.ok(flatten(reservationLabel).some((node) => node.textContent === '収束後マージ'));
  assert.equal(reservationLabel.children.includes(reservationToggle), true);
  reservationToggle.checked = true;
  holdReservation = true;
  const failingReservation = context.runPullRequestReservationAction(reservationToggle, true);
  assert.equal(reservationToggle.disabled, false);
  assert.equal(reservationToggle.attributes['aria-disabled'], 'true');
  assert.equal(reservationToggle.checked, true);
  assert.equal(context.pullRequestReservationPending.get(key), true);
  releaseReservation();
  await failingReservation;
  const restoredRoot = new FakeElement('div');
  context.appendPullRequestTree(restoredRoot, group, reviewPr(pullRequest));
  const restoredNodes = flatten(restoredRoot);
  assert.equal(restoredNodes.find((node) => node.dataset?.reservationToggle === key).checked, false);
  assert.ok(restoredNodes.some((node) => node.className === 'merge-error' && node.textContent.includes('表示していた head SHA')));

  const reserveToggle = restoredNodes.find((node) => node.dataset?.reservationToggle === key);
  reserveToggle.checked = true;
  await context.runPullRequestReservationAction(reserveToggle, true);
  assert.equal(context.liveStatus.textContent, 'PR #42 のレビュー収束後マージを予約しました。');
  pullRequest.reservation = { method: 'merge', deleteBranch: false, createdAt: '2026-10-05T00:00:00.000Z' };
  const reservedRoot = new FakeElement('div');
  context.pullRequestMergeConfirmations.set(key, 'merge');
  context.appendPullRequestTree(reservedRoot, group, reviewPr(pullRequest));
  const reservedNodes = flatten(reservedRoot);
  const checkedReservation = reservedNodes.find((node) => node.dataset?.reservationToggle === key);
  assert.equal(checkedReservation.checked, true);
  assert.equal(reservedNodes.find((node) => node.dataset?.openMerge === key).textContent, 'マージする');
  checkedReservation.checked = false;
  await context.runPullRequestReservationAction(checkedReservation, false);
  assert.equal(context.liveStatus.textContent, 'PR #42 のマージ予約を取り消しました。');

  pullRequest.reservation = { method: 'merge', deleteBranch: false, createdAt: '2026-10-05T00:00:00.000Z' };
  const reservedMergeRoot = new FakeElement('div');
  context.pullRequestMergeConfirmations.set(key, 'merge');
  context.appendPullRequestTree(reservedMergeRoot, group, reviewPr(pullRequest));
  const reservedMergeNodes = flatten(reservedMergeRoot);
  const reservedMergeButton = reservedMergeNodes.find((node) => node.dataset?.mergeGo === key);
  assert.ok(reservedMergeButton);
  assert.equal(reservedMergeButton.textContent, 'マージを実行');
  await context.runPullRequestMergeAction(reservedMergeButton);
  assert.equal(context.liveStatus.textContent, 'PR #42 をマージしました。');
  assert.equal(context.pullRequestMergeResults.get('acme/widget')[0].number, 42);
  await context.runPullRequestMergeAction(reservedMergeButton);
  assert.equal(context.liveStatus.textContent, 'PR #42 をマージキューに追加しました。');
  assert.deepEqual(JSON.parse(JSON.stringify(context.queuedPullRequestMerges.get(key))), { headRefOid: 'abc123' });

  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    {
      url: '/api/pull-requests/merge',
      body: { number: 42, registration_key: key, headRefOid: 'abc123', method: 'merge', deleteBranch: false },
    },
    {
      url: '/api/pull-requests/reserve',
      body: { number: 42, registration_key: key, headRefOid: 'abc123', method: 'merge', deleteBranch: false },
    },
    {
      url: '/api/pull-requests/reserve',
      body: { number: 42, registration_key: key, headRefOid: 'abc123', method: 'merge', deleteBranch: false },
    },
    {
      url: '/api/pull-requests/cancel-reservation',
      body: { number: 42, registration_key: key },
    },
    {
      url: '/api/pull-requests/merge',
      body: { number: 42, registration_key: key, headRefOid: 'abc123', method: 'merge', deleteBranch: false },
    },
    {
      url: '/api/pull-requests/merge',
      body: { number: 42, registration_key: key, headRefOid: 'abc123', method: 'merge', deleteBranch: false },
    },
  ]);

  context.pullRequestMergeResults.clear();
  delete pullRequest.reservation;
  responses.push(
    { ok: true, body: { merged: true, branchDeleted: false, warning: null } },
    { ok: true, body: { ok: true, cancelled: true, message: 'PR #42 のクロスレビューが halted になったため、レビュー収束後マージの予約を取り消しました。' } },
  );
  const immediateRoot = new FakeElement('div');
  context.appendPullRequestTree(immediateRoot, group, reviewPr(pullRequest));
  const immediateToggle = flatten(immediateRoot).find((node) => node.dataset?.reservationToggle === key);
  immediateToggle.checked = true;
  await context.runPullRequestReservationAction(immediateToggle, true);
  assert.equal(context.liveStatus.textContent, 'PR #42 をマージしました。');
  assert.equal(context.pullRequestMergeResults.size, 0);
  await context.runPullRequestReservationAction(immediateToggle, true);
  assert.equal(context.liveStatus.textContent, 'PR #42 のクロスレビューが halted になったため、レビュー収束後マージの予約を取り消しました。');

  const noMethodsGroup = { ...group, mergeMethods: [] };
  const unreservedRoot = new FakeElement('div');
  context.appendPullRequestTree(unreservedRoot, noMethodsGroup, reviewPr(pullRequest));
  assert.equal(flatten(unreservedRoot).find((node) => node.dataset?.reservationToggle === key).disabled, true);
  pullRequest.reservation = { method: 'merge', deleteBranch: false, createdAt: '2026-10-05T00:00:00.000Z' };
  const reservedNoMethodsRoot = new FakeElement('div');
  context.appendPullRequestTree(reservedNoMethodsRoot, noMethodsGroup, reviewPr(pullRequest));
  assert.equal(flatten(reservedNoMethodsRoot).find((node) => node.dataset?.reservationToggle === key).disabled, false);
});

test('マージ済み・クローズ済みだけの PR では空表示し、Claude だけなら履歴に起点帯を付けない', () => {
  const element = functionSource(pageHtml, 'element');
  const shortShaElement = functionSource(pageHtml, 'shortShaElement');
  const appendBlock = sourceBetween(pageHtml, 'function appendPullRequestBlock(target, group, withTag = false, showOriginBands = true) {', '\nfunction productGroups(');
  assert.ok(element && shortShaElement && appendBlock);

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.className = '';
      this.textContent = '';
    }
    append(...nodes) { this.children.push(...nodes); }
    addEventListener() {}
    setAttribute() {}
  }
  const context = pageContext(pageHtml, {
    displayPreferences: { hideFinished: false },
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => ({ textContent: text }),
    },
    expandedPrLines: new Set(),
    MERGED_VISIBLE_COUNT: 5,
    durationAgoLabel: () => '1 分前',
    absoluteTimeLabel: () => '1 分前',
    appendPullRequestMergeResults() {},
  });
  vm.runInContext(`${element}\n${shortShaElement}\n${functionSource(pageHtml, 'providerOrigin')}\n${appendBlock}`, context);

  for (const state of ['merged', 'closed']) {
    const root = new FakeElement('div');
    context.appendPullRequestBlock(root, {
      owner: 'acme', repo: 'widget', trees: [], registeredCount: 1, mergeHistory: [],
      merged: [{ number: 42, state, url: 'https://github.com/acme/widget/pull/42', title: 'Feature PR' }],
    });
    const content = root.children[0].children.find((node) => node.className === 'pr-repo-content');
    assert.ok(content.children.some((node) => node.className === 'empty' && node.textContent === 'オープンの PR はありません'));
  }

  const claudeHistory = new FakeElement('div');
  context.appendPullRequestBlock(claudeHistory, {
    owner: 'acme', repo: 'widget', trees: [], registeredCount: 1,
    mergeHistory: [{ number: 41, providers: ['claude'], mergedAt: '2026-10-03T00:00:00.000Z' }],
    merged: [{ number: 40, state: 'closed', providers: ['claude'], url: 'https://github.com/acme/widget/pull/40', title: 'Closed PR' }],
  }, false, false);
  const historyNodes = [];
  const visitHistory = (node) => { historyNodes.push(node); for (const child of node.children || []) visitHistory(child); };
  visitHistory(claudeHistory);
  assert.equal(historyNodes.some((node) => /origin-(claude|codex|both)/.test(node.className || '') || node.dataset?.origin), false);

  const counted = new FakeElement('div');
  context.appendPullRequestBlock(counted, {
    owner: 'acme', repo: 'widget', trees: [], registeredCount: 1, mergeableCount: 2, mergeHistory: [], merged: [],
  });
  const header = counted.children[0].children.find((node) => node.className === 'prs-head');
  assert.ok(header.children.some((node) => node.className === 'chip ok' && node.textContent === 'マージできる PR (2 件)'));

  const unavailable = new FakeElement('div');
  context.appendPullRequestBlock(unavailable, {
    owner: 'acme', repo: 'widget', trees: [], registeredCount: 1,
    error: 'GitHub から PR を取得できませんでした',
    merged: [{ number: 42, state: 'merged', url: 'https://github.com/acme/widget/pull/42', title: 'Feature PR' }],
  });
  const unavailableContent = unavailable.children[0].children.find((node) => node.className === 'pr-repo-content');
  assert.equal(unavailableContent.children.some((node) => node.className === 'empty' && node.textContent === 'オープンの PR はありません'), false);
});

test('警告がある即時と予約マージの結果は閉じるまで表示する', () => {
  const names = [
    'element', 'pullRequestRepositoryKey', 'pullRequestMergeResultHasWarning', 'pullRequestMergeResultVisible',
    'pullRequestMergeResultLine', 'appendPullRequestMergeResults',
  ];
  const functions = names.map((name) => functionSource(pageHtml, name));
  assert.ok(functions.every(Boolean));

  class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.className = ''; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute() {}
  }
  const context = pageContext(pageHtml, {
    pullRequestMergeResults: new Map([['acme/widget\0product', [
      { id: 'local-warning', number: 10, method: 'squash', warning: 'ブランチを削除できませんでした' },
      { id: 'local-success', number: 11, method: 'squash' },
    ]]]),
    MERGE_METHOD_LABELS: { squash: 'スカッシュ' },
    document: { createElement: (tagName) => new FakeElement(tagName) },
  });
  vm.runInContext(functions.join('\n'), context);
  const group = {
    owner: 'acme', repo: 'widget', product: { key: 'product' },
    mergeHistory: [
      { number: 20, automatic: true, automaticResult: { method: 'squash', warning: '予約マージの警告' } },
      { number: 21, automatic: true, headMismatch: true, automaticResult: { method: 'squash' } },
      { number: 22, automatic: true, mergeResultClosedAt: '2026-10-01T00:00:00Z', automaticResult: { warning: '閉じた警告' } },
    ],
  };
  const content = new FakeElement('div');
  context.appendPullRequestMergeResults(content, group);
  const rows = content.children;
  const texts = rows.map((row) => row.children[0].textContent);
  assert.equal(rows.length, 3);
  assert.ok(texts.some((text) => text.startsWith('PR #10:')));
  assert.ok(texts.some((text) => text.startsWith('PR #20:')));
  assert.ok(texts.some((text) => text.startsWith('PR #21:')));
  assert.equal(texts.some((text) => text.startsWith('PR #11:')), false);
  assert.equal(texts.some((text) => text.startsWith('PR #22:')), false);
  for (const row of rows) {
    const close = row.children[1];
    assert.equal(close.textContent, '閉じる');
    if (row.children[0].textContent.startsWith('PR #10:')) {
      assert.equal(close.dataset.closeMergeResult, 'local-warning');
    } else {
      assert.equal(close.dataset.owner, 'acme');
      assert.equal(close.dataset.repo, 'widget');
    }
  }
});

test('警告のない即時と予約マージの結果行は表示しない', () => {
  const names = [
    'element', 'pullRequestRepositoryKey', 'pullRequestMergeResultHasWarning', 'pullRequestMergeResultVisible',
    'appendPullRequestMergeResults',
  ];
  const functions = names.map((name) => functionSource(pageHtml, name));
  assert.ok(functions.every(Boolean));
  class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.className = ''; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute() {}
  }
  const context = pageContext(pageHtml, {
    pullRequestMergeResults: new Map([['acme/widget', [{ id: 'local-success', number: 11, method: 'squash' }]]]),
    MERGE_METHOD_LABELS: { squash: 'スカッシュ' },
    document: { createElement: (tagName) => new FakeElement(tagName) },
  });
  vm.runInContext(functions.join('\n'), context);
  const content = new FakeElement('div');
  context.appendPullRequestMergeResults(content, {
    owner: 'acme', repo: 'widget',
    mergeHistory: [{ number: 20, automatic: true, automaticResult: { method: 'squash' } }],
  });
  assert.deepEqual(content.children, []);
});

test('期限の再描画判定はマージ結果を追わず、短時間の知らせを追う', () => {
  const names = [
    'pullRequestRepositoryKey', 'pullRequestTimestampExpired', 'pullRequestTransientNoticeExpired', 'pullRequestExpirySignature',
  ];
  const functions = names.map((name) => functionSource(pageHtml, name));
  assert.ok(functions.every(Boolean));
  const context = pageContext(pageHtml, {
    TRANSIENT_NOTICE_MS: 60_000,
    pullRequestMergeResults: new Map([['acme/widget', [{ id: 'local-success' }]]]),
    pullRequestMergeMessages: new Map(),
    pullRequestConflictMessages: new Map(),
  });
  vm.runInContext(functions.join('\n'), context);
  const now = Date.now();
  const mergedAt = new Date(now).toISOString();
  const resultGroup = { owner: 'acme', repo: 'widget', mergeHistory: [{
    number: 42, mergedAt, automatic: true, automaticResult: { warning: null },
  }] };
  assert.equal(context.pullRequestExpirySignature([resultGroup], now + 300_000), '');
  const noticeGroup = {
    owner: 'acme', repo: 'widget', product: { key: 'product' }, mergeHistory: [],
    reservationNotices: [{ number: 41, at: new Date(now).toISOString() }],
  };
  context.pullRequestMergeMessages.set('merge-one', { shownAt: now });
  context.pullRequestConflictMessages.set('conflict-one', { shownAt: now });
  const visibleNoticeSignature = context.pullRequestExpirySignature([noticeGroup], now);
  const expiredNoticeSignature = context.pullRequestExpirySignature([noticeGroup], now + 60_000);
  assert.match(visibleNoticeSignature, /reservation:41:.*:visible/);
  assert.match(expiredNoticeSignature, /reservation:41:.*:expired/);
  assert.match(expiredNoticeSignature, /merge:merge-one/);
  assert.match(expiredNoticeSignature, /conflict:conflict-one/);
  assert.notEqual(expiredNoticeSignature, context.pullRequestExpirySignature([{ ...noticeGroup, reservationNotices: [] }], now + 60_000));
});

test('接続エラーの最終更新時刻は共通の絶対時刻表示を使う', () => {
  const updateSource = functionSource(pageHtml, 'updateConnectionNote');
  assert.ok(updateSource);
  let formattedValue;
  const connectionNote = { textContent: '', hidden: true };
  const context = pageContext(pageHtml, {
    connectionLost: true,
    lastStateAt: '2026-10-03T03:04:00.000Z',
    connectionNote,
    absoluteTimeLabel: (value) => { formattedValue = value; return '10/3 12:04'; },
  });
  vm.runInContext(`${updateSource}\nthis.updateNote = updateConnectionNote;`, context);
  context.updateNote();
  assert.equal(formattedValue, '2026-10-03T03:04:00.000Z');
  assert.equal(connectionNote.textContent, '常駐サーバーに接続できません。表示は 10/3 12:04 時点のものです。');
  assert.equal(connectionNote.hidden, false);
});

test('予約取消とマージ・衝突依頼の失敗は1分後に隠し、操作ボタンを残す', () => {
  const element = functionSource(pageHtml, 'element');
  const repositoryKey = functionSource(pageHtml, 'pullRequestRepositoryKey');
  const timestampExpired = functionSource(pageHtml, 'pullRequestTimestampExpired');
  const transientNoticeExpired = functionSource(pageHtml, 'pullRequestTransientNoticeExpired');
  const component = sourceBetween(pageHtml, 'const MERGE_METHOD_LABELS', '\nfunction productGroups(');
  assert.ok(element && repositoryKey && timestampExpired && transientNoticeExpired && component);

  class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.attributes = {}; this.className = ''; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  const flatten = (node) => [node, ...(node.children || []).flatMap(flatten)];
  const startedAt = 1_800_000_000_000;
  const mergeKey = 'd'.repeat(64);
  const conflictKey = 'example/project#42';
  const context = pageContext(pageHtml, {
    TRANSIENT_NOTICE_MS: 60_000,
    displayPreferences: { hideFinished: true },
    document: { createElement: (tagName) => new FakeElement(tagName), createTextNode: (text) => ({ textContent: text }) },
    pullRequestMergeResults: new Map(),
    pullRequestMergeConfirmations: new Map(),
    pullRequestMergeOptions: new Map(),
    pullRequestMergeMessages: new Map([[mergeKey, { message: 'PR の状態が変わりました。表示を確認してください。', shownAt: startedAt }]]),
    queuedPullRequestMerges: new Map(),
    queuedPullRequestMerge: () => null,
    pullRequestMergeInFlight: new Set(), pullRequestResultUnconfirmed: () => false, pullRequestUnconfirmedResults: new Map(), refreshSequence: 0, pullRequestReservationPending: new Map(),
    pullRequestReviewSkipInFlight: new Set(),
    pullRequestConflictConfirmations: new Set(),
    pullRequestConflictMessages: new Map([[conflictKey, { message: '操作結果を取得できませんでした。PR の状態を取り直してください。', shownAt: startedAt }]]),
    pullRequestConflictInFlight: new Set(),
    lastState: { sessions: [{ session_id: 'session-pr', title: 'worker' }] },
    pullRequestMergeConditionWaits: () => [],
    appendPullRequestBadges() {},
    badge: (text, className = '') => Object.assign(new FakeElement('span'), { textContent: text, className }),
    pullRequestReservationWaits: () => [],
    appendPullRequestMergeResults() {},
    durationAgoLabel: () => '1 分前',
    expandedPrLines: new Set(),
  });
  vm.runInContext([
    'let testNow = 0; Date.now = () => testNow; function setTestNow(value) { testNow = value; }',
    element, repositoryKey, timestampExpired, transientNoticeExpired, component,
  ].join('\n'), context);
  context.setTestNow(startedAt);

  const pullRequest = {
    mergeSessionId: 'session-pr', number: 42, title: 'Feature PR', url: 'https://github.com/example/project/pull/42',
    mergeRecordKey: mergeKey, conflictRequestKey: 'e'.repeat(64), headRefOid: 'a'.repeat(40), headRefName: 'feature/pr-42',
    effectiveBase: 'main', canMerge: true, blocker: null, conflict: true,
    conflictRequestTargets: [{ sessionId: 'session-pr', alive: true }], children: [], stackPosition: { depth: 1, total: 1 },
  };
  const group = { owner: 'example', repo: 'project', defaultBranch: 'main', mergeMethods: ['merge'], trees: [pullRequest] };
  const renderTree = () => {
    const root = new FakeElement('div');
    context.appendPullRequestTree(root, group, reviewPr(pullRequest));
    return flatten(root);
  };
  const renderNotice = (at) => {
    const root = new FakeElement('div');
    context.appendPullRequestBlock(root, {
      owner: 'example', repo: 'project', trees: [], merged: [], mergeHistory: [],
      reservationNotices: [{ number: 41, at: new Date(at).toISOString(), url: 'https://github.com/example/project/pull/41', message: '予約を取り消しました。' }],
    });
    return flatten(root);
  };
  const hasStatus = (nodes, className) => nodes.some((node) => node.className === className);

  assert.ok(hasStatus(renderNotice(startedAt), 'merge-result'));
  let nodes = renderTree();
  assert.equal(nodes.filter((node) => node.className === 'merge-error').length, 2);
  assert.ok(nodes.some((node) => node.dataset?.openMerge === mergeKey));
  assert.ok(nodes.some((node) => node.dataset?.conflictOpen === conflictKey));

  context.setTestNow(startedAt + 59_999);
  assert.ok(hasStatus(renderNotice(startedAt), 'merge-result'));
  assert.equal(renderTree().filter((node) => node.className === 'merge-error').length, 2);

  context.setTestNow(startedAt + 60_000);
  assert.equal(hasStatus(renderNotice(startedAt), 'merge-result'), false);
  nodes = renderTree();
  assert.equal(nodes.some((node) => node.className === 'merge-error'), false);
  assert.ok(nodes.some((node) => node.dataset?.openMerge === mergeKey));
  assert.ok(nodes.some((node) => node.dataset?.conflictOpen === conflictKey));
});

test('通知が状態版の変化なしに期限切れになっても、次の取得で描き直す', async () => {
  const refresh = pageHtml.match(/async function refresh\(\) \{[\s\S]*?\n\}/)?.[0];
  const applyAwayState = functionSource(pageHtml, 'applyAwayState');
  assert.ok(refresh && applyAwayState);
  let renders = 0;
  let signature = 'reservation:visible';
  const context = pageContext(pageHtml, {
    refreshSequence: 0, appliedRefreshSequence: 0, pendingStateReads: 0, lastStateEtag: 'same', pullRequestUnconfirmedResults: new Map(), fetch: async () => ({ ok: true, headers: { get: () => 'same' }, json: async () => ({ version: 7, sessions: [], pullRequests: [], away: { enabled: false } }) }),
    checkUiVersion: () => false,
    syncDisplayPreferences: async () => {},
    pullRequestExpirySignature: () => signature,
    renderedPullRequestExpirySignature: 'reservation:visible',
    applyUpdateState() {}, applyDoctorState() {},
    renderRestartNote() {},
    renderPersistenceNote() {},
    applyAppVersion() {},
    updateConnectionNote() {},
    isAwaitingDecision: () => false,
    pruneStaleConfirmations() {}, completedDisplaySaves: 0,
    render() { renders += 1; },
    header: { dataset: { away: 'false' } },
    awayToggle: { disabled: false, checked: false },
    root: { replaceChildren() {} },
    liveStatus: { textContent: '' },
  });
  context.AbortSignal = { timeout: () => ({}) };
  vm.runInContext(`${functionSource(pageHtml, 'fetchUi')}\n${functionSource(pageHtml, 'reportWebFailure')}\n${applyAwayState}\n${refresh}\nvar lastState = null, lastVersion = 7, lastStateAt = null, connectionLost = false, hasRenderedState = true, refreshConfirmPending = false, sinceSeenMode = 'always';`, context);

  await context.refresh();
  assert.equal(renders, 0);
  signature = '';
  await context.refresh();
  assert.equal(renders, 1);
});

test('終わったものを隠すとマージ済みとクローズ済みの PR 行を出さない', () => {
  const element = functionSource(pageHtml, 'element');
  const appendBlock = sourceBetween(pageHtml, 'function appendPullRequestBlock(target, group, withTag = false, showOriginBands = true) {', '\nfunction productGroups(');
  assert.ok(element && appendBlock);

  class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.className = ''; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
    addEventListener() {}
    setAttribute() {}
  }
  const context = pageContext(pageHtml, {
    displayPreferences: { hideFinished: true },
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => ({ textContent: text }),
    },
    expandedPrLines: new Set(['merged:acme/widget', 'closed:acme/widget']),
    MERGED_VISIBLE_COUNT: 5,
    durationAgoLabel: () => '1 分前',
    appendPullRequestMergeResults() {},
  });
  vm.runInContext(`${element}\n${functionSource(pageHtml, 'providerOrigin')}\n${appendBlock}`, context);
  const target = new FakeElement('div');
  context.appendPullRequestBlock(target, {
    owner: 'acme', repo: 'widget', fetchedAt: new Date().toISOString(), openCount: 0, registeredCount: 2,
    trees: [], error: null,
    mergeHistory: [{ number: 8, url: 'https://example.com/8', title: 'merged', mergedAt: new Date().toISOString(), method: 'squash' }],
    merged: [{ number: 7, state: 'closed', url: 'https://example.com/7', title: 'closed' }],
  });
  const descendants = (node) => [node, ...(node.children || []).flatMap(descendants)];
  const nodes = descendants(target);
  const text = nodes.map((node) => node.textContent || '').join(' ');
  assert.doesNotMatch(text, /マージ済み|クローズ済み|#8|#7/);
  assert.match(text, /オープンの PR はありません/);
  assert.equal(nodes.some((node) => node.tagName === 'button'), false);
});

test('マージ済み一覧に予約時と異なる SHA の警告を表示する', () => {
  const html = readWebPage();
  const element = functionSource(html, 'element');
  const shortShaElement = functionSource(html, 'shortShaElement');
  const appendBlock = sourceBetween(html, 'function appendPullRequestBlock(target, group, withTag = false, showOriginBands = true) {', '\nfunction productGroups(');
  assert.ok(element && shortShaElement);
  assert.ok(appendBlock);

  class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.className = ''; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
  }
  class FakeText {
    constructor(text) { this.textContent = text; }
  }
  const context = pageContext(pageHtml, {
    displayPreferences: { hideFinished: false },
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
    },
    absoluteTimeLabel: () => '1 分前',
    durationAgoLabel: () => '1 分前',
    MERGE_METHOD_LABELS: { squash: 'スカッシュ' },
    expandedPrLines: new Set(),
    MERGED_VISIBLE_COUNT: 5,
    appendPullRequestMergeResults() {},
  });
  vm.runInContext(`${element}\n${shortShaElement}\n${functionSource(html, 'providerOrigin')}\n${appendBlock}`, context);
  const root = new FakeElement('div');
  const reservedSha = 'a'.repeat(40);
  const mergedSha = 'b'.repeat(40);
  context.appendPullRequestBlock(root, {
    trees: [], merged: [], registeredCount: 1,
    mergeHistory: [{
      number: 42, title: 'Feature PR', url: 'https://github.com/acme/widget/pull/42',
      mergedAt: '2026-10-03T11:59:00.000Z', method: 'squash', automatic: true,
      reservedHeadRefOid: reservedSha, mergedHeadRefOid: mergedSha, headMismatch: true,
    }],
  });
  const nodes = [];
  const visit = (node) => {
    nodes.push(node);
    for (const child of node.children || []) visit(child);
  };
  visit(root);
  const visibleText = nodes.map((node) => node.textContent).join(' ');

  assert.match(visibleText, /予約時に確認した/);
  assert.match(visibleText, /aaaaaaa/);
  assert.match(visibleText, /bbbbbbb/);
  assert.ok(nodes.some((node) => node.tagName === 'code' && node.textContent === 'aaaaaaa' && node.title === reservedSha));
  assert.ok(nodes.some((node) => node.tagName === 'code' && node.textContent === 'bbbbbbb' && node.title === mergedSha));
});

test('マージ済み一覧は新しい順に5件を出し、古いPRをボタンで切り替える', () => {
  const html = readWebPage();
  const element = functionSource(html, 'element');
  const expandToggle = functionSource(html, 'appendExpandToggle');
  const appendBlock = sourceBetween(html, 'function appendPullRequestBlock(target, group, withTag = false, showOriginBands = true) {', '\nfunction productGroups(');
  assert.ok(element && expandToggle);
  assert.ok(appendBlock);

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.textContent = '';
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(_event, callback) { this.onClick = callback; }
    focus(options) { this.focusOptions = options; }
  }
  class FakeText {
    constructor(text) { this.textContent = text; }
  }

  const expandedPrLines = new Set();
  let root;
  let focusedToggle;
  const state = {};
  const context = pageContext(pageHtml, {
    displayPreferences: { hideFinished: false },
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
    },
    expandedPrLines,
    MERGED_VISIBLE_COUNT: 5,
    MERGE_METHOD_LABELS: { squash: 'スカッシュ' },
    absoluteTimeLabel: (value) => value,
    durationAgoLabel: () => '1 分前',
    appendPullRequestMergeResults() {},
    lastState: state,
    root: { querySelectorAll: () => descendants(root).filter((node) => node.dataset?.olderPrLine) },
    render: () => {
      root = new FakeElement('div');
      context.appendPullRequestBlock(root, group);
      focusedToggle = descendants(root).find((node) => node.dataset?.olderPrLine === 'merged:acme/widget');
    },
  });
  vm.runInContext(`${element}\n${expandToggle}\n${functionSource(html, 'providerOrigin')}\n${appendBlock}`, context);

  const group = {
    owner: 'Acme', repo: 'Widget', trees: [], merged: [], registeredCount: 1,
    mergeHistory: Array.from({ length: 7 }, (_, index) => ({
      number: 7 - index,
      title: `PR ${7 - index}`,
      url: `https://github.com/acme/widget/pull/${7 - index}`,
      mergedAt: `2026-10-03T0${7 - index}:00:00.000Z`,
      method: 'squash',
    })),
  };
  const history = group.mergeHistory;
  const descendants = (node) => [node, ...(node.children || []).flatMap(descendants)];
  const renderHistory = (history) => {
    group.mergeHistory = history;
    root = new FakeElement('div');
    context.appendPullRequestBlock(root, group);
    return descendants(root);
  };

  const fiveNodes = renderHistory(history.slice(0, 5));
  assert.equal(fiveNodes.filter((node) => node.tagName === 'a').length, 5);
  assert.equal(fiveNodes.some((node) => node.dataset?.olderPrLine), false);

  const collapsedNodes = renderHistory(history);
  const collapsedLinks = collapsedNodes.filter((node) => node.tagName === 'a');
  const collapsedToggle = collapsedNodes.find((node) => node.dataset?.olderPrLine === 'merged:acme/widget');
  assert.deepEqual(collapsedLinks.map((node) => node.textContent), ['#7', '#6', '#5', '#4', '#3']);
  assert.equal(collapsedToggle.textContent, '古いマージ済みを表示 (2 件)');
  assert.equal(collapsedToggle.attributes['aria-expanded'], 'false');

  collapsedToggle.onClick();
  assert.equal(expandedPrLines.has('merged:acme/widget'), true);
  assert.equal(focusedToggle.focusOptions.preventScroll, true);
  const expandedNodes = renderHistory(history);
  const expandedToggle = expandedNodes.find((node) => node.dataset?.olderPrLine === 'merged:acme/widget');
  assert.deepEqual(expandedNodes.filter((node) => node.tagName === 'a').map((node) => node.textContent), [
    '#7', '#6', '#5', '#4', '#3', '#2', '#1',
  ]);
  assert.equal(expandedToggle.textContent, '古いマージ済みを隠す (2 件)');
  assert.equal(expandedToggle.attributes['aria-expanded'], 'true');
});

test('クローズ済み一覧はPR番号順に5件を出し、種類ごとに開閉状態を分ける', () => {
  const html = readWebPage();
  const element = functionSource(html, 'element');
  const expandToggle = functionSource(html, 'appendExpandToggle');
  const appendBlock = sourceBetween(html, 'function appendPullRequestBlock(target, group, withTag = false, showOriginBands = true) {', '\nfunction productGroups(');
  assert.ok(element && expandToggle);
  assert.ok(appendBlock);

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.textContent = '';
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(_event, callback) { this.onClick = callback; }
    focus(options) { this.focusOptions = options; }
  }
  class FakeText {
    constructor(text) { this.textContent = text; }
  }

  const expandedPrLines = new Set();
  const state = {};
  let root;
  let focusedClosedToggle;
  const group = {
    owner: 'Acme', repo: 'Widget', trees: [], registeredCount: 1,
    mergeHistory: Array.from({ length: 7 }, (_, index) => ({
      number: index + 1, url: `https://github.com/acme/widget/pull/${index + 1}`,
      mergedAt: '2026-10-03T00:00:00.000Z', method: 'squash',
    })),
    merged: Array.from({ length: 7 }, (_, index) => ({
      number: index + 1, state: 'closed', title: `Closed PR ${index + 1}`,
      url: `https://github.com/acme/widget/pull/${index + 1}`,
    })),
  };
  const descendants = (node) => [node, ...(node.children || []).flatMap(descendants)];
  const context = pageContext(pageHtml, {
    displayPreferences: { hideFinished: false },
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
    },
    expandedPrLines,
    MERGED_VISIBLE_COUNT: 5,
    MERGE_METHOD_LABELS: { squash: 'スカッシュ' },
    absoluteTimeLabel: (value) => value,
    durationAgoLabel: () => '1 分前',
    appendPullRequestMergeResults() {},
    lastState: state,
    root: { querySelectorAll: () => descendants(root).filter((node) => node.dataset?.olderPrLine) },
    render: () => {
      root = new FakeElement('div');
      context.appendPullRequestBlock(root, group);
      focusedClosedToggle = descendants(root).find((node) => node.dataset?.olderPrLine === 'closed:acme/widget');
    },
  });
  vm.runInContext(`${element}\n${expandToggle}\n${functionSource(html, 'providerOrigin')}\n${appendBlock}`, context);

  const renderGroup = () => {
    root = new FakeElement('div');
    context.appendPullRequestBlock(root, group);
    return descendants(root);
  };
  group.merged = group.merged.slice(0, 5);
  assert.equal(renderGroup().some((node) => node.dataset?.olderPrLine === 'closed:acme/widget'), false);
  group.merged = Array.from({ length: 7 }, (_, index) => ({
    number: index + 1, state: 'closed', title: `Closed PR ${index + 1}`,
    url: `https://github.com/acme/widget/pull/${index + 1}`,
  }));

  const collapsedNodes = renderGroup();
  const closedLinks = collapsedNodes.filter((node) => node.tagName === 'a' && node.className === 'badge mute');
  const collapsedToggle = collapsedNodes.find((node) => node.dataset?.olderPrLine === 'closed:acme/widget');
  assert.deepEqual(closedLinks.map((node) => node.textContent), ['#7', '#6', '#5', '#4', '#3']);
  assert.equal(collapsedToggle.textContent, '古いクローズ済みを表示 (2 件)');
  assert.equal(collapsedToggle.attributes['aria-expanded'], 'false');

  collapsedToggle.onClick();
  assert.equal(expandedPrLines.has('closed:acme/widget'), true);
  assert.equal(expandedPrLines.has('merged:acme/widget'), false);
  assert.equal(focusedClosedToggle.focusOptions.preventScroll, true);
  const expandedNodes = renderGroup();
  const expandedLinks = expandedNodes.filter((node) => node.tagName === 'a' && node.className === 'badge mute');
  const expandedToggle = expandedNodes.find((node) => node.dataset?.olderPrLine === 'closed:acme/widget');
  assert.deepEqual(expandedLinks.map((node) => node.textContent), ['#7', '#6', '#5', '#4', '#3', '#2', '#1']);
  assert.equal(expandedToggle.textContent, '古いクローズ済みを隠す (2 件)');
  assert.equal(expandedToggle.attributes['aria-expanded'], 'true');
});

test('衝突の依頼の確認欄では、描き直しの後も同じ操作のボタンへフォーカスを戻す', () => {
  const html = readWebPage();
  const render = functionSource(html, 'render');
  assert.ok(render);

  const key = 'conflict-key';
  for (const [dataAttribute, htmlAttribute] of [['conflictCancel', 'data-conflict-cancel'], ['conflictGo', 'data-conflict-go']]) {
    let activeElement = { dataset: { [dataAttribute]: key }, hasAttribute: (name) => name === htmlAttribute };
    const makeButton = (name) => ({
      dataset: { [name]: key },
      focused: false,
      focus() { this.focused = true; activeElement = this; },
    });
    const go = makeButton('conflictGo');
    const cancel = makeButton('conflictCancel');
    const context = pageContext(pageHtml, {
      answerNoteComposing: false,
      lastState: { sessions: [{ session_id: 'session-ui' }] },
      HTMLTextAreaElement: class FakeTextArea {},
      document: { get activeElement() { return activeElement; }, querySelectorAll: () => [] },
      root: { replaceChildren: () => { activeElement = null; }, querySelectorAll: () => [go, cancel] },
      displayPreferences: { mode: 'product', pinned: [] },
      visibleSinceSeen: (state) => Array.isArray(state?.sinceSeen) ? state.sinceSeen : [],
      idleHiddenSessions: () => [],
      isIdleHiddenSession: () => false,
      sessionsAfterIdleFilter: (sessions) => sessions,
      renderIdleNote() {},
      renderRouting() {},
      renderSummary() {}, renderExcludedNote() {}, updateTitle() {},
      finishedHiddenCounts: () => ({ sessions: 0, pullRequests: 0 }), finishedDeletionTargets: () => ({ session_ids: [], merge_history: [], closed_pull_requests: [] }),
      renderFinishedNote() {},
      orderedProducts: () => [{ key: 'product-ui' }],
      productSection: () => ({}),
    });
    vm.runInContext(`${functionSource(pageHtml, 'focusDataFor')}\n${functionSource(pageHtml, 'hasCodexOrigin')}\n${render}`, context);
    context.render(context.lastState);

    const expected = dataAttribute === 'conflictCancel' ? cancel : go;
    assert.equal(expected.focused, true, dataAttribute);
    assert.equal(activeElement, expected, dataAttribute);
  }
});

test('マージ操作ボタンにフォーカスがある描き直しでは同じボタンへ戻す', () => {
  const html = readWebPage();
  const render = functionSource(html, 'render');
  assert.ok(render);

  for (const [kind, dataAttribute, htmlAttribute] of [
    ['merge-go', 'mergeGo', 'data-merge-go'],
    ['merge-cancel', 'mergeCancel', 'data-merge-cancel'],
    ['merge-reservation-toggle', 'reservationToggle', 'data-reservation-toggle'],
    ['merge-open', 'openMerge', 'data-open-merge'],
    ['conflict-open', 'conflictOpen', 'data-conflict-open'],
  ]) {
    let activeElement;
    const key = `merge-${kind}`;
    const activeButton = { dataset: { [dataAttribute]: key, mergeKey: key }, hasAttribute: (name) => name === htmlAttribute };
    const replacementButton = {
      dataset: { [dataAttribute]: key, mergeKey: key },
      hasAttribute: (name) => name === htmlAttribute,
      focused: false,
      focus() { this.focused = true; activeElement = this; },
    };
    activeElement = activeButton;
    const context = pageContext(pageHtml, {
      answerNoteComposing: false,
      lastState: { sessions: [{ session_id: 'session-ui' }] },
      HTMLTextAreaElement: class FakeTextArea {},
      document: { get activeElement() { return activeElement; }, querySelectorAll: () => [] },
      root: { replaceChildren: () => { activeElement = null; }, querySelectorAll: () => [replacementButton] },
      displayPreferences: { mode: 'product', pinned: [] },
      visibleSinceSeen: (state) => Array.isArray(state?.sinceSeen) ? state.sinceSeen : [],
      idleHiddenSessions: () => [],
      isIdleHiddenSession: () => false,
      sessionsAfterIdleFilter: (sessions) => sessions,
      renderIdleNote() {},
      renderRouting() {},
      renderSummary() {}, renderExcludedNote() {}, updateTitle() {},
      finishedHiddenCounts: () => ({ sessions: 0, pullRequests: 0 }), finishedDeletionTargets: () => ({ session_ids: [], merge_history: [], closed_pull_requests: [] }),
      renderFinishedNote() {},
      orderedProducts: () => [{ key: 'product-ui' }],
      productSection: () => ({}),
    });
    vm.runInContext(`${functionSource(pageHtml, 'focusDataFor')}\n${functionSource(pageHtml, 'hasCodexOrigin')}\n${render}`, context);
    context.render(context.lastState);

    assert.equal(replacementButton.focused, true, kind);
    assert.equal(activeElement, replacementButton, kind);
  }
});

function renderFocusHarness() {
  let activeElement;
  let controls = [];
  let modeControls = [];
  const body = {};
  const context = pageContext(pageHtml, {
    answerNoteComposing: false,
    lastState: { sessions: [{ session_id: 'session-ui' }] },
    HTMLTextAreaElement: class FakeTextArea {},
    document: {
      body,
      get activeElement() { return activeElement; },
      querySelectorAll: (selector) => selector === '[data-action="mode"]' ? modeControls : [...controls, ...modeControls],
      querySelector: (selector) => selector.startsWith('[data-action="mode"]') ? modeControls[0] || null : null,
    },
    element: (tagName, className, textContent) => ({ tagName, className, textContent }),
    root: { replaceChildren: () => { activeElement = body; }, querySelectorAll: () => controls },
    displayPreferences: { mode: 'product', pinned: [] },
    visibleSinceSeen: (state) => Array.isArray(state?.sinceSeen) ? state.sinceSeen : [],
    idleHiddenSessions: () => [], isIdleHiddenSession: () => false,
    sessionsAfterIdleFilter: (sessions) => sessions,
    renderIdleNote() {}, renderRouting() {}, renderSummary() {}, renderExcludedNote() {}, updateTitle() {},
    finishedHiddenCounts: () => ({ sessions: 0, pullRequests: 0 }),
    finishedDeletionTargets: () => ({ session_ids: [], merge_history: [], closed_pull_requests: [] }),
    renderFinishedNote() {}, orderedProducts: () => [{ key: 'product-ui' }], productSection: () => ({}),
  });
  vm.runInContext(`const actionFocusRestores = new Map();\n${pageHtml.match(/const FILTERS = \[[\s\S]*?\n\];/)?.[0]}\n${functionSource(pageHtml, 'filterFocusFallback')}\n${functionSource(pageHtml, 'focusDataFor')}\n${functionSource(pageHtml, 'hasCodexOrigin')}\n${functionSource(pageHtml, 'render')}\nthis.actionFocusRestores = actionFocusRestores; this.rememberFocus = value => actionFocusRestores.set('operation', value);`, context);
  return {
    context,
    draw(active, nextControls, remembered = null, nextModeControls = []) {
      context.actionFocusRestores?.clear();
      if (remembered) context.rememberFocus(remembered);
      return this.paint(active, nextControls, nextModeControls);
    },
    paint(active, nextControls, nextModeControls = []) {
      activeElement = active;
      controls = nextControls;
      modeControls = nextModeControls;
      [...controls, ...modeControls].forEach((control) => { control.onFocus = (target) => { activeElement = target; }; });
      context.render(context.lastState);
      return activeElement;
    },
    body,
  };
}

test('札が消えた再描画では代わりの札へ、札が無ければ現在の表示切り替えへフォーカスを戻す', () => {
  const harness = renderFocusHarness();
  const activeFilter = focusControl({ filter: 'blocking' });
  const fallbackFilter = focusControl({ filter: 'agents' });
  assert.equal(harness.draw(activeFilter, [fallbackFilter]), fallbackFilter);

  const modeButton = focusControl({ action: 'mode', mode: 'product' }, { 'data-action': '', 'data-mode': 'product' });
  assert.equal(harness.draw(activeFilter, [], null, [modeButton]), modeButton);
});

test('「元に戻す」にフォーカスがあれば、プロダクトが無くなる描き直しの後も同じ種類のボタンへ戻す', () => {
  const harness = renderFocusHarness();
  harness.context.orderedProducts = () => [];
  const activeUndo = focusControl({}, { 'data-undo-hidden-sessions': '' });
  const replacementUndo = focusControl({}, { 'data-undo-hidden-sessions': '' });

  assert.equal(harness.draw(activeUndo, [replacementUndo]), replacementUndo);
});

function focusControl(dataset, attributes = {}, disabled = false) {
  return {
    dataset, disabled, focused: false,
    hasAttribute(name) { return Object.hasOwn(attributes, name); },
    getAttribute(name) { return attributes[name] ?? null; },
    setAttribute() {},
    focus() { this.focused = true; this.onFocus?.(this); },
  };
}

test('マージ確認は disabled の戻し先を飛ばし、キャンセルと実行中の戻し先を順に探す', () => {
  const harness = renderFocusHarness();
  const key = 'merge-focus';
  const method = focusControl({ mergeKey: key, mergeMethod: 'squash' }, { 'data-merge-method': '' }, true);
  const alternativeMethod = focusControl({ mergeKey: key, mergeMethod: 'rebase' }, { 'data-merge-method': '' });
  const opener = focusControl({ mergeKey: key, openMerge: key }, { 'data-open-merge': '' }, true);
  const cancel = focusControl({ mergeKey: key, mergeCancel: key }, { 'data-merge-cancel': '' });
  const go = focusControl({ mergeKey: key, mergeGo: key }, { 'data-merge-go': '' }, true);

  assert.equal(harness.draw(focusControl({ openMerge: key, mergeKey: key }, { 'data-open-merge': '' }), [method, alternativeMethod]), alternativeMethod);
  const availableOpener = focusControl({ mergeKey: key, openMerge: key }, { 'data-open-merge': '' });
  const availableMethod = focusControl({ mergeKey: key, mergeMethod: 'squash' }, { 'data-merge-method': '' });
  assert.equal(harness.draw(focusControl({ openMerge: key, mergeKey: key }, { 'data-open-merge': '' }), [availableMethod, availableOpener]), availableOpener);
  const disabledCancel = focusControl({ mergeCancel: key, mergeKey: key }, { 'data-merge-cancel': '' }, true);
  assert.equal(harness.draw(focusControl({ mergeCancel: key, mergeKey: key }, { 'data-merge-cancel': '' }), [disabledCancel, availableOpener, alternativeMethod]), availableOpener);
  assert.equal(harness.draw(focusControl({ mergeCancel: key, mergeKey: key }, { 'data-merge-cancel': '' }), [disabledCancel, opener, alternativeMethod]), alternativeMethod);
  assert.equal(harness.draw(harness.body, [go, cancel], { kind: 'merge-go', key }), cancel);
});

test('応答待ちの間に別の場所を押したら、応答後の再描画で操作した部品へフォーカスを戻さない', () => {
  const harness = renderFocusHarness();
  const listeners = {};
  harness.context.document.addEventListener = (type, listener) => { listeners[type] = listener; };
  vm.runInContext(pageHtml.match(/^document\.addEventListener\('pointerdown'.*$/m)[0], harness.context);
  const key = 'merge-key';
  const reservationToggle = () => focusControl({ mergeKey: key, reservationToggle: key }, { 'data-reservation-toggle': '' });

  const restored = reservationToggle();
  assert.equal(harness.draw(harness.body, [restored], { kind: 'merge-reservation-toggle', key }), restored);

  harness.context.rememberFocus({ kind: 'merge-reservation-toggle', key });
  listeners.pointerdown();
  assert.equal(harness.paint(harness.body, [reservationToggle()]), harness.body);
});

test('既読、サブエージェント、キュー、PR リンクのフォーカスを再描画後も戻す', () => {
  const harness = renderFocusHarness();
  const cases = [
    [focusControl({ seen: 'one' }), [focusControl({ seen: 'two' })], 'seen'],
    [focusControl({ closeAgent: 'session-ui::agent' }), [focusControl({ endedToggle: 'session-ui' }, { 'data-ended-toggle': 'session-ui' })], 'close-agent'],
    [focusControl({ queueLeft: 'merge-key' }), [focusControl({ openMerge: 'merge-key' })], 'queue-left'],
    [focusControl({ pullRequestLink: 'merge-key' }), [focusControl({ pullRequestLink: 'merge-key' })], 'pull-request-link'],
  ];
  for (const [active, controls, kind] of cases) {
    const restored = harness.draw(active, controls);
    assert.equal(restored, controls[0], kind);
  }
});

test('モックのマージ確認と衝突確認を閉じると開いた操作へフォーカスを戻す', () => {
  const restore = functionSource(mockHtml, 'restoreConfirmationFocus');
  assert.ok(restore);
  const controls = new Map();
  const context = pageContext(mockHtml, {
    CSS: { escape: value => value }, ui: { mode: 'product' },
    document: { querySelector: selector => controls.get(selector) || null },
  });
  vm.runInContext(restore, context);

  const key = 'example/project#42';
  const opener = { disabled: false, focused: false, focus() { this.focused = true; } };
  const method = { disabled: false, focused: false, focus() { this.focused = true; } };
  controls.set(`[data-merge="${key}"]`, opener);
  controls.set(`.merge-confirm[data-pr="${key}"] [data-method]`, method);
  context.restoreConfirmationFocus({ kind: 'merge-cancel', key });
  assert.equal(opener.focused, true);

  opener.focused = false;
  method.focused = false;
  context.restoreConfirmationFocus({ kind: 'merge-open', key });
  assert.equal(opener.focused, true);

  opener.disabled = true;
  context.restoreConfirmationFocus({ kind: 'merge-cancel', key });
  assert.equal(method.focused, true);

  opener.focused = false;
  method.focused = false;
  context.restoreConfirmationFocus({ kind: 'merge-open', key });
  assert.equal(method.focused, true);

  const conflict = { disabled: false, focused: false, focus() { this.focused = true; } };
  controls.set(`[data-conflict="${key}"]`, conflict);
  context.restoreConfirmationFocus({ kind: 'conflict-cancel', key });
  assert.equal(conflict.focused, true);

  const mergeCancel = { disabled: false, focused: false, focus() { this.focused = true; } };
  controls.set(`[data-merge-cancel="${key}"]`, mergeCancel);
  context.restoreConfirmationFocus({ kind: 'merge-go', key });
  assert.equal(mergeCancel.focused, true);

  mergeCancel.disabled = true;
  const mode = { disabled: false, focused: false, focus() { this.focused = true; } };
  controls.set(`[data-mode="product"]`, mode);
  context.restoreConfirmationFocus({ kind: 'merge-go', key });
  assert.equal(mode.focused, true);
});

test('aria-disabled の操作はクリックと Enter、Space で実行されない', () => {
  const click = pageHtml.match(/document\.addEventListener\('click', \(event\) => \{\n  if \(event\.button === 0 && handleExternalLink\(event\)\) return;[\s\S]*?\n\}\);/)?.[0];
  const keydown = pageHtml.match(/document\.addEventListener\('keydown', \(event\) => \{[\s\S]*?\n\}\);/g)?.find((handler) => handler.includes("event.target.closest('[aria-disabled=\"true\"]')"));
  const mockClick = [...mockHtml.matchAll(/document\.addEventListener\('click', e => \{[\s\S]*?^\}\);/gm)]
    .map((match) => match[0]).find((handler) => handler.includes("const t = e.target.closest('button')"));
  assert.ok(click && keydown && mockClick);
  const handlers = new Map();
  const context = pageContext(pageHtml, { document: { addEventListener: (name, handler) => handlers.set(name, handler) } });
  vm.runInContext(`${click}\n${keydown}`, context);
  const button = { getAttribute: () => 'true' };
  const target = { closest: () => button };
  let prevented = false;
  handlers.get('click')({ button: 1, target });
  handlers.get('keydown')({ key: 'Enter', code: 'Enter', target, preventDefault: () => { prevented = true; } });
  assert.equal(prevented, true);

  const mockHandlers = new Map();
  const mockContext = pageContext(mockHtml, { document: { addEventListener: (name, handler) => mockHandlers.set(name, handler) } });
  vm.runInContext(mockClick, mockContext);
  mockHandlers.get('click')({ target: { closest: () => button } });
});

test('レビュー不要の通信後は有効な同じPRの操作へフォーカスを戻す', async () => {
  const render = functionSource(pageHtml, 'render');
  const runAction = pageHtml.match(/async function runCrossReviewSkipAction\(button\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(render && runAction);

  const key = 'example/project/42';
  async function runScenario({ result, availableAction, moveFocus }) {
    const body = { dataset: {}, hasAttribute: () => false };
    const inFlight = new Set();
    let activeElement;
    let buttons = [];
    let focusedReviewButton = null;
    let disabledFocusAttempts = 0;
    let resolveRequest;
    let rejectRequest;
    let context;

    const reviewButton = (action) => {
      let disabled = inFlight.has(key);
      return {
        dataset: { mergeKey: key, reviewSkip: action },
        hasAttribute: () => false,
        get disabled() { return disabled; },
        set disabled(value) {
          disabled = value;
          if (value && activeElement === this) activeElement = body;
        },
        focus() {
          if (disabled) {
            disabledFocusAttempts += 1;
            return;
          }
          activeElement = this;
          focusedReviewButton = this;
        },
      };
    };
    const filterButton = () => ({
      dataset: { filter: 'prs' },
      hasAttribute: () => false,
      focus() { activeElement = this; },
    });
    const activeButton = reviewButton('set');
    buttons = [activeButton, filterButton()];
    activeElement = activeButton;

    context = pageContext(pageHtml, {
      answerNoteComposing: false,
      lastState: { sessions: [{ session_id: 'session-ui' }], pullRequests: [] },
      HTMLTextAreaElement: class FakeTextArea {},
      document: {
        body,
        get activeElement() { return activeElement; },
        querySelectorAll: (selector) => selector === 'button' ? buttons : [],
      },
      root: {
        replaceChildren() {
          buttons = [reviewButton(availableAction), filterButton()];
          activeElement = body;
        },
        querySelectorAll: () => [],
      },
      displayPreferences: { mode: 'product', pinned: [] },
      visibleSinceSeen: () => [],
      idleHiddenSessions: () => [],
      isIdleHiddenSession: () => false,
      sessionsAfterIdleFilter: (sessions) => sessions,
      renderIdleNote() {},
      renderRouting() {}, renderSummary() {}, renderExcludedNote() {}, finishedDeletionTargets: () => ({ session_ids: [], merge_history: [], closed_pull_requests: [] }),
      renderFinishedNote() {}, updateTitle() {},
      finishedHiddenCounts: () => ({ sessions: 0, pullRequests: 0 }),
      orderedProducts: () => [{ key: 'product-ui' }],
      productSection: () => ({}),
      findPullRequestMergeTarget: () => ({ pullRequest: { headRefOid: 'a'.repeat(40) }, number: 42 }),
      pullRequestReviewSkipInFlight: inFlight,
      liveStatus: { textContent: '' },
      postUiAction: () => new Promise((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; }),
      refresh: async () => context.render(context.lastState),
      showWriteError() {},
    });
    vm.runInContext(`${functionSource(pageHtml, 'focusDataFor')}\n${functionSource(pageHtml, 'hasCodexOrigin')}\n${render}\n${runAction}`, context);

    const pending = context.runCrossReviewSkipAction(activeButton);
    if (moveFocus) activeElement = buttons.find((button) => button.dataset.filter === 'prs');
    if (result instanceof Error) rejectRequest(result);
    else resolveRequest(result);
    await pending;

    return { activeElement, focusedReviewButton, disabledFocusAttempts, body };
  }

  for (const scenario of [
    { result: { ok: true, json: async () => ({}) }, availableAction: 'clear' },
    { result: { ok: false, json: async () => ({ error: '操作できませんでした' }) }, availableAction: 'set' },
    { result: new Error('network unavailable'), availableAction: 'set' },
  ]) {
    const outcome = await runScenario(scenario);
    assert.equal(outcome.activeElement, outcome.focusedReviewButton);
    assert.equal(outcome.focusedReviewButton.dataset.reviewSkip, scenario.availableAction);
    assert.equal(outcome.disabledFocusAttempts, 0);
  }

  const movedFocus = await runScenario({
    result: { ok: true, json: async () => ({}) },
    availableAction: 'clear',
    moveFocus: true,
  });
  assert.equal(movedFocus.activeElement.dataset.filter, 'prs');
  assert.equal(movedFocus.focusedReviewButton, null);
});

test('古い PR の開閉ボタンにフォーカスがある描き直しでは同じボタンへ戻す', () => {
  const html = readWebPage();
  const render = functionSource(html, 'render');
  assert.ok(render);

  let activeElement;
  const key = 'merged:acme/widget';
  const attributes = { 'data-older-pr-line': key };
  const activeButton = { dataset: { olderPrLine: key }, hasAttribute: (name) => name in attributes, getAttribute: (name) => attributes[name] };
  const otherButton = {
    dataset: { olderPrLine: 'closed:acme/widget' },
    hasAttribute: (name) => name === 'data-older-pr-line',
    getAttribute: () => 'closed:acme/widget',
    focus() { activeElement = this; },
  };
  const replacementButton = {
    ...activeButton,
    focused: false,
    focus() { this.focused = true; activeElement = this; },
  };
  activeElement = activeButton;
  const context = pageContext(pageHtml, {
    answerNoteComposing: false,
    lastState: { sessions: [{ session_id: 'session-ui' }] },
    HTMLTextAreaElement: class FakeTextArea {},
    document: { get activeElement() { return activeElement; }, querySelectorAll: (selector) => (selector === 'button' ? [otherButton, replacementButton] : []) },
    root: { replaceChildren: () => { activeElement = null; }, querySelectorAll: () => [] },
    displayPreferences: { mode: 'product', pinned: [] },
    visibleSinceSeen: (state) => Array.isArray(state?.sinceSeen) ? state.sinceSeen : [],
    idleHiddenSessions: () => [],
    isIdleHiddenSession: () => false,
    sessionsAfterIdleFilter: (sessions) => sessions,
    renderIdleNote() {},
    renderRouting() {},
    renderSummary() {}, renderExcludedNote() {}, updateTitle() {},
    finishedHiddenCounts: () => ({ sessions: 0, pullRequests: 0 }), finishedDeletionTargets: () => ({ session_ids: [], merge_history: [], closed_pull_requests: [] }),
    renderFinishedNote() {},
    orderedProducts: () => [{ key: 'product-ui' }],
    productSection: () => ({}),
  });
  vm.runInContext(`${functionSource(pageHtml, 'focusDataFor')}\n${functionSource(pageHtml, 'hasCodexOrigin')}\n${render}`, context);
  context.render(context.lastState);

  assert.equal(replacementButton.focused, true);
  assert.equal(activeElement, replacementButton);
});

test('作業中のタスクがあるセッションでは未着手を畳み、ボタンで表示する', () => {
  const harness = taskRenderHarness();
  const session = {
    session_id: 'session-a',
    tasks: [
      { id: 'doing', state: 'doing' },
      { id: 'todo', state: 'todo' },
      { id: 'done', state: 'done' },
    ],
  };
  const collapsed = harness.render(session);
  const collapsedNodes = harness.descendants(collapsed);
  const toggles = collapsedNodes.filter((node) => node.dataset.planToggle);

  assert.deepEqual(collapsedNodes.filter((node) => node.dataset.taskId).map((node) => node.dataset.taskId), ['doing']);
  assert.deepEqual(toggles.map((button) => button.textContent), [
    '未着手のタスクを表示 (1 件)',
    '完了したタスクを表示 (1 件)',
  ]);

  toggles[0].onClick();
  const expanded = harness.descendants(harness.render(session));
  assert.deepEqual(expanded.filter((node) => node.dataset.taskId).map((node) => node.dataset.taskId), ['doing', 'todo']);
  assert.equal(harness.context.expandedTodoTasks.has('session-a'), true);
  assert.equal(harness.context.expandedDoneTasks.has('session-a'), false);
});

test('完了操作の送信中はタスクボタンを aria-disabled にしてフォーカス可能にする', () => {
  class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.dataset = {}; this.attributes = {}; this.classList = { add() {} }; }
    append(...children) { this.children.push(...children); }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  const closeKey = 'session-task::完了確認';
  const context = pageContext(pageHtml, {
    document: { createElement: tagName => new FakeElement(tagName) },
    pendingTaskCloseActions: new Map(), taskCloseActionsInFlight: new Set([closeKey]),
    badge: text => new FakeElement('span'), appendContextTags() {},
  });
  vm.runInContext(`${functionSource(pageHtml, 'element')}\n${functionSource(pageHtml, 'appendTaskItem')}`, context);
  const root = new FakeElement('ul');
  context.appendTaskItem(root, { title: '完了確認', state: 'doing', criteria: [] }, {}, { session_id: 'session-task' });
  const descendants = node => [node, ...(node.children || []).flatMap(descendants)];
  const nodes = descendants(root);
  const button = nodes.find(node => node.dataset?.closeTask === closeKey);
  assert.equal(button.disabled, undefined);
  assert.equal(button.attributes['aria-disabled'], 'true');
});

test('実行中の worktree 操作は aria-disabled になりクリックを無視する', () => {
  const calls = [];
  const element = (_tag, className, textContent) => ({
    className, textContent, dataset: {}, attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
    getAttribute(name) { return this.attributes[name] ?? null; },
    addEventListener(name, handler) { this[name] = handler; },
  });
  const context = pageContext(pageHtml, {
    element,
    worktreeActionInFlight: new Set(['decision-copy:copy']),
    runWorktreeAction: (...args) => calls.push(args),
  });
  vm.runInContext(functionSource(pageHtml, 'worktreeButton'), context);
  const button = context.worktreeButton('コピー', 'copy', { session_id: 'session' }, { id: 'decision-copy' }, '文字列');

  assert.equal(button.attributes['aria-disabled'], 'true');
  button.click();
  assert.equal(calls.length, 0);
});

test('作業中がなく未着手だけのセッションでは未着手を畳まない', () => {
  const harness = taskRenderHarness();
  const session = {
    session_id: 'session-todo-only',
    tasks: [{ id: 'todo-a', state: 'todo' }, { id: 'todo-b', state: 'todo' }],
  };
  const nodes = harness.descendants(harness.render(session));

  assert.deepEqual(nodes.filter((node) => node.dataset.taskId).map((node) => node.dataset.taskId), ['todo-a', 'todo-b']);
  assert.equal(nodes.some((node) => node.dataset.planToggle && node.dataset.planToggle.startsWith('todoTasks:')), false);
});

test('一部完了のセッションでは完了タスクを表示できる', () => {
  const names = [
    'element', 'activityStatus', 'isEndedAgent', 'runningBackgrounds', 'isFinishedSession', 'appendAgents', 'appendDecisions', 'taskVisibility', 'appendExpandToggle', 'appendPlanToggle', 'appendTasks',
    'kindEndedDecisionEntries', 'kindEndedAgentCount', 'sessionOrigin',
  ];
  const functions = names.map((name) => functionSource(pageHtml, name));
  assert.ok(functions.every(Boolean));
  class FakeElement {
    constructor(tagName, _className = '', textContent = '') {
      this.tagName = tagName; this.children = []; this.dataset = {}; this.attributes = {}; this.className = ''; this.textContent = textContent;
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener() {}
  }
  const context = pageContext(pageHtml, {
    displayPreferences: { hideFinished: true },
    document: { createElement: (tagName) => new FakeElement(tagName) },
    expandedEndedSessions: new Set(['session-partial']),
    expandedEndedDecisions: new Set(['session-partial']),
    expandedDoneTasks: new Set(),
    expandedTodoTasks: new Set(),
    newestFirst: (items) => [...items],
    isFilterShown: () => true,
    shownActiveDecisions: () => [],
    shownPermissions: () => [],
    hasHiddenJudgmentItems: () => false,
    durationAgoLabel: () => '1 分前',
    appendTaskItem: (list, task) => list.append(new FakeElement('li', '', task.title)),
    lastState: null,
    root: { querySelectorAll: () => [] },
  });
  vm.runInContext(functions.join('\n'), context);
  const session = {
    session_id: 'session-partial',
    status: '待機中',
    agents: [{ active: false, unconfirmed: false }],
    decisions: [{ state: 'resolved' }],
    permissionWaits: [],
    tasks: [{ title: '作業中', state: 'doing', criteria: [] }, { title: '完了済み', state: 'done', criteria: [] }],
  };
  assert.equal(context.isFinishedSession(session), false);

  const agentBody = new FakeElement('div');
  context.appendAgents(agentBody, session, { name: 'product' });
  assert.equal(agentBody.children.some((node) => node.dataset.endedToggle), false);

  const decisionBody = new FakeElement('div');
  context.appendDecisions(decisionBody, session, { name: 'product' });
  assert.equal(decisionBody.children.some((node) => node.dataset.planToggle), false);
  const references = [{ session }];
  assert.deepEqual(JSON.parse(JSON.stringify(context.kindEndedDecisionEntries(references))), []);
  assert.equal(context.kindEndedAgentCount(references), 0);

  const taskBody = new FakeElement('div');
  context.appendTasks(taskBody, session, { name: 'product' });
  assert.equal(taskBody.children.some((node) => node.dataset.planToggle === 'tasks:session-partial'), true);
  context.expandedDoneTasks.add('session-partial');
  const expandedTaskBody = new FakeElement('div');
  context.appendTasks(expandedTaskBody, session, { name: 'product' });
  assert.equal(expandedTaskBody.children.some((node) => node.className === 'task-list'
    && node.children.some((item) => item.textContent === '完了済み')), true);
});

test('種類別では未着手の合計数を一つのボタンで切り替える', () => {
  const html = readWebPage();
  const functions = ['element', 'appendExpandToggle', 'taskVisibility', 'kindTodoTaskCount', 'kindDoneTaskCount', 'sessionOrigin', 'appendKindTaskSession', 'kindToggleLabel', 'appendKindToggle']
    .map((name) => functionSource(html, name));
  assert.ok(functions.every(Boolean));

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.textContent = '';
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(_event, callback) { this.onClick = callback; }
    focus() {}
  }

  const context = pageContext(pageHtml, {
    document: { createElement: (tagName) => new FakeElement(tagName) },
    expandedKindSections: new Set(),
    lastState: null,
    root: { querySelectorAll: () => [] },
    appendContextTags() {},
    durationAgoLabel: () => '',
    appendTaskItem: (list, task) => {
      const item = new FakeElement('li');
      item.dataset.taskId = task.id;
      list.append(item);
    },
  });
  vm.runInContext(functions.join('\n'), context);
  const references = [
    { product: { name: 'A' }, multipleSessions: false, session: { session_id: 'a', tasks: [
      { id: 'doing-a', state: 'doing' }, { id: 'todo-a', state: 'todo' }, { id: 'done-a', state: 'done' },
    ] } },
    { product: { name: 'B' }, multipleSessions: false, session: { session_id: 'b', tasks: [
      { id: 'todo-b1', state: 'todo' }, { id: 'todo-b2', state: 'todo' },
    ] } },
    { product: { name: 'C' }, multipleSessions: false, session: { session_id: 'c', tasks: [
      { id: 'doing-c', state: 'doing' }, { id: 'todo-c1', state: 'todo' }, { id: 'todo-c2', state: 'todo' }, { id: 'done-c', state: 'done' },
    ] } },
  ];
  const descendants = (node) => [node, ...(node.children || []).flatMap(descendants)];
  const renderSessions = (body, showTodo, showDone) => {
    for (const reference of references) context.appendKindTaskSession(body, reference, showTodo, showDone);
  };
  const body = new FakeElement('div');
  const todoCount = context.kindTodoTaskCount(references);
  const doneCount = context.kindDoneTaskCount(references);
  renderSessions(body, false, false);
  context.appendKindToggle(body, 'todoTasks', false, todoCount, '未着手のタスク');
  context.appendKindToggle(body, 'tasks', false, doneCount, '完了したタスク');

  assert.equal(todoCount, 3);
  assert.deepEqual(descendants(body).filter((node) => node.dataset.taskId).map((node) => node.dataset.taskId), [
    'doing-a', 'todo-b1', 'todo-b2', 'doing-c',
  ]);
  const toggles = body.children.filter((node) => node.dataset.kindToggle);
  assert.deepEqual(toggles.map((button) => button.textContent), [
    '未着手のタスクを表示 (3 件)',
    '完了したタスクを表示 (2 件)',
  ]);
  assert.equal(toggles.filter((button) => button.dataset.kindToggle === 'todoTasks').length, 1);

  toggles[0].onClick();
  assert.equal(context.expandedKindSections.has('todoTasks'), true);
  assert.equal(context.expandedKindSections.has('tasks'), false);
  const expandedBody = new FakeElement('div');
  renderSessions(expandedBody, context.expandedKindSections.has('todoTasks'), context.expandedKindSections.has('tasks'));
  assert.deepEqual(descendants(expandedBody).filter((node) => node.dataset.taskId).map((node) => node.dataset.taskId), [
    'doing-a', 'todo-a', 'todo-b1', 'todo-b2', 'doing-c', 'todo-c1', 'todo-c2',
  ]);
});

test('離席の切り替えだけでは一覧を描き直さない', async () => {
  const html = readWebPage();
  const refresh = html.match(/async function refresh\(\) \{[\s\S]*?\n\}/)?.[0];
  const applyAwayState = functionSource(html, 'applyAwayState');
  assert.ok(refresh && applyAwayState);
  assert.doesNotMatch(refresh, /sinceSeenVisibilityChanged/);

  const run = async (awaySequence) => {
    let renders = 0;
    let index = 0;
    const context = pageContext(pageHtml, {
      refreshSequence: 0, appliedRefreshSequence: 0, pendingStateReads: 0, lastStateEtag: 'same', pullRequestUnconfirmedResults: new Map(), fetch: async () => ({ ok: true, headers: { get: () => 'same' }, json: async () => ({ version: 7, sessions: [], away: { enabled: awaySequence[index++] } }) }),
      checkUiVersion: () => false,
      syncDisplayPreferences: async () => {},
      pullRequestExpirySignature: () => '',
      renderedPullRequestExpirySignature: '',
      applyUpdateState() {}, applyDoctorState() {},
    renderRestartNote() {},
    renderPersistenceNote() {},
      applyAppVersion() {},
      updateConnectionNote() {},
      isPendingDecision: () => false,
      pruneStaleConfirmations() {}, completedDisplaySaves: 0,
      render() { renders += 1; },
      header: { dataset: { away: 'false' } },
      awayToggle: { disabled: false, checked: false },
      root: { replaceChildren() {} },
      liveStatus: { textContent: '' },
    });
    context.AbortSignal = { timeout: () => ({}) };
    vm.runInContext(`${functionSource(pageHtml, 'fetchUi')}\n${functionSource(pageHtml, 'reportWebFailure')}\n${applyAwayState}\n${refresh}\nvar lastState = null, lastVersion = null, lastStateAt = null, connectionLost = false, hasRenderedState = false, refreshConfirmPending = false;`, context);
    for (let step = 0; step < awaySequence.length; step += 1) await context.refresh();
    return renders;
  };

  assert.equal(await run([false, true, false]), 1);
  assert.equal(await run([false, false]), 1);
});

test('文や名前を差し込むバッジは折り返し、枠の外へはみ出さない', () => {
  const source = readWebPage();
  const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');

  for (const html of [source, mock]) {
    const badgeStyle = Object.fromEntries(cssDeclarations(html, '.badge.long'));
    assert.equal(badgeStyle['white-space'], 'normal');
    assert.equal(badgeStyle['overflow-wrap'], 'anywhere');
    assert.equal(badgeStyle['max-width'], '100%');
    // マージ履歴のバッジは子要素を複数持つ。inline-flex のままだと子ごとに縦へ細く割れるので、1 つの文として流す。
    assert.equal(badgeStyle.display, 'inline-block');
    // .session-tag の nowrap に上書きされないよう、2 つのクラスで詳細度を上げる。
    const contextStyle = Object.fromEntries(cssDeclarations(html, '.session-tag.session-context'));
    assert.equal(contextStyle['white-space'], 'normal');
    assert.equal(contextStyle['max-width'], '100%');
  }
  // 予約中、衝突の解消の依頼、base の付け替え、マージ履歴は、時刻やセッション名やブランチ名が入って長くなる。
  assert.match(source, /badge\(reservedText, 'accent long'\)/);
  assert.match(source, /へ衝突の解消を依頼した`, 'accent long'\)/);
  assert.match(source, /に付け替え済み`, 'accent long'\)/);
  assert.match(source, /'badge long warn' : 'badge long mute'/);
  assert.match(mock, /class="badge accent long">レビュー収束後にマージ予約中/);
  assert.match(mock, /class="badge accent long">\$\{esc\(absoluteTimeLabel\(at/);
  assert.match(mock, /class="badge accent long">base を/);
  assert.match(mock, /class="badge long \$\{pr\.headMismatch/);
});

test('非対話の実行中の行は状態名と時刻と API の札を出し、状態推定と一覧からの除外を出さない', () => {
  const functions = ['element', 'activityStatus', 'unknownSessionControls', 'appendUnknownSessionControls', 'appendToolLine', 'sessionOrigin',
    'sessionDisplayName', 'appendContextTags', 'appendSessionModelLine', 'runningBackgrounds', 'mainRow']
    .map((name) => functionSource(pageHtml, name));
  assert.ok(functions.every(Boolean));

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.childNodes = this.children;
      this.className = '';
      this.dataset = {};
    }
    append(...nodes) { this.children.push(...nodes); }
  }

  const context = pageContext(pageHtml, {
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => ({ nodeType: 'text', textContent: text }),
    },
    durationAgoLabel: (value) => (value ? '3 分前' : '時刻不明'),
    relativeTimeElement: (value, className, label) => {
      const time = new FakeElement('time');
      time.className = className;
      time.textContent = label;
      time.value = value;
      return time;
    },
    badge: (text, className) => {
      const tag = new FakeElement('span');
      tag.className = `badge ${className}`;
      tag.textContent = text;
      return tag;
    },
    expandedEndedSessions: new Set(),
    displayPreferences: { hideFinished: true },
    isFilterShown: () => true,
    isEndedAgent: (agent) => !agent.active && !agent.unconfirmed,
    newestFirst: (items) => items,
  });
  vm.runInContext(functions.join('\n'), context);

  assert.deepEqual({ ...context.activityStatus({ status: '不明', nonInteractive: true }) }, { label: '非対話の実行中', tone: 'busy' });
  assert.deepEqual({ ...context.activityStatus({ status: '不明' }) }, { label: '状態不明', tone: 'unknown' });

  const product = { name: 'agent-cockpit' };
  const session = {
    session_id: 'batch-session', title: 'クロスレビュー', status: '不明', nonInteractive: true,
    sessionFileUpdatedAt: '2026-10-05T00:00:00.000Z', lastActivityAt: null, lastUpdatedAt: null,
    tasks: [], tools: [], permissionWaits: [], decisions: [], agents: [],
  };
  const main = context.mainRow(session, product);
  assert.deepEqual(main.children.map((child) => child.className), ['who', 'since', 'detail']);
  assert.equal(main.children[0].children[0].className, 'dot busy');
  assert.equal(main.children[0].children.at(-1).textContent, '非対話の実行中');
  assert.equal(main.children[1].textContent, '3 分前');
  assert.equal(main.children[1].value, '2026-10-05T00:00:00.000Z');
  assert.deepEqual(main.children[2].children.map((child) => child.className), ['models']);
  const [claude] = main.children[2].children[0].children;
  assert.equal(claude.className, 'model claude');
  assert.equal(claude.textContent, 'Claude (API)');
  assert.ok(!main.children.some((child) => child.className === 'session-extra'));

  const named = context.mainRow({ ...session, modelName: 'Sonnet 5.5' }, product);
  assert.equal(named.children[2].children[0].children[0].textContent, 'Claude Sonnet 5.5');

  const interactive = context.mainRow({ ...session, nonInteractive: undefined, sessionFileUpdatedAt: null }, product);
  assert.deepEqual(interactive.children.map((child) => child.className), ['who', 'session-extra']);
  assert.equal(interactive.children[0].children.at(-1).textContent, '状態不明 (時刻不明)');
  const interactiveNamed = context.mainRow({ ...session, nonInteractive: undefined, modelName: 'Opus 5.5' }, product);
  const detail = interactiveNamed.children.find(child => child.className === 'detail');
  assert.equal(detail.children[0].children[0].textContent, 'Claude Opus 5.5');
});

test('対話の Claude のモデルの札は名前があるときだけ出す', () => {
  const node = (textContent = '') => ({ textContent, children: [], append(...children) { this.children.push(...children); } });
  const context = pageContext(pageHtml, { element: (tag, className, text) => node(text) });
  vm.runInContext(functionSource(pageHtml, 'appendSessionModelLine'), context);
  for (const modelName of ['Opus 5.5', undefined]) {
    const target = node();
    context.appendSessionModelLine(target, { provider: 'claude', modelName });
    if (modelName) assert.equal(target.children[0].children[0].textContent, 'Claude Opus 5.5');
    else assert.equal(target.children.length, 0);
  }
});

test('モックの非対話の行は稼働中の札で出し、状態推定と一覧からの除外を出さない', () => {
  const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8').replace(/\r\n/g, '\n');
  const context = pageContext(mock, {
    ui: { estimatedSessions: [] },
    taskState: (session, task) => task.state,
    esc: (value) => String(value),
    sessionTag: () => '',
    renderToolLine: () => '<div class="tool-line"></div>',
    absoluteTimeLabel: () => '',
    ESTIMATE_WAITING: {},
  });
  vm.runInContext(['sessionOrigin', 'runningBackgrounds', 'mainRow', 'unknownSessionControls'].map((name) => functionSource(mock, name)).join('\n'), context);

  const nonInteractive = context.mainRow({}, {
    id: 'batch', status: 'unknown', nonInteractive: true, tasks: [], main: { tool: '', since: '3 分前' },
  }, false);
  assert.match(nonInteractive, /class="dot busy"/);
  assert.match(nonInteractive, /<strong>非対話の実行中<\/strong>/);
  assert.match(nonInteractive, /class="since">3 分前<\/div>/);
  assert.match(nonInteractive, /<span class="model claude">Claude \(API\)<\/span>/);
  assert.doesNotMatch(nonInteractive, /状態を推定|session-extra/);

  const unknown = context.mainRow({}, { id: 'unknown', status: 'unknown', tasks: [], main: {} }, false);
  assert.match(unknown, /<strong>状態不明 \(時刻不明\)<\/strong>/);
  assert.match(unknown, /状態を推定/);
  assert.doesNotMatch(unknown, /class="models"/);
  const named = context.mainRow({}, { id: 'named', status: 'wait', modelName: 'Opus 5.5', tasks: [], main: {} }, false);
  assert.match(named, /<span class="model claude">Claude Opus 5.5<\/span>/);
  const namedNonInteractive = context.mainRow({}, { id: 'named-batch', status: 'unknown', nonInteractive: true,
    modelName: 'Sonnet 5.5', tasks: [], main: {} }, false);
  assert.match(namedNonInteractive, /<span class="model claude">Claude Sonnet 5.5<\/span>/);
});

test('Codex の状態不明行は履歴推定の非対応を案内し、一覧から外せる', () => {
  const element = (tagName, className = '', textContent = '') => ({
    tagName, className, textContent, children: [], dataset: {},
    append(...nodes) { this.children.push(...nodes); },
  });
  const implementation = pageContext(pageHtml, { element });
  vm.runInContext(functionSource(pageHtml, 'unknownSessionControls'), implementation);
  const implementationCodex = implementation.unknownSessionControls({
    session_id: 'codex-session', provider: 'codex', status: '不明',
  });
  const flatten = (node) => [node, ...node.children.flatMap(flatten)];
  const implementationNodes = flatten(implementationCodex);
  assert.equal(implementationNodes.some((node) => node.dataset.estimateSession), false);
  assert.equal(implementationNodes.some((node) => node.dataset.hideSession === 'codex-session'), true);
  assert.ok(implementationNodes.some((node) => node.textContent === 'Codexの履歴からの推定には未対応です'));
  const legacyImplementation = flatten(implementation.unknownSessionControls({ session_id: 'legacy', status: '不明' }));
  assert.equal(legacyImplementation.some((node) => node.dataset.estimateSession === 'legacy'), true);

  const mock = pageContext(mockHtml, { ui: { estimatedSessions: [] }, esc: (value) => String(value) });
  vm.runInContext(functionSource(mockHtml, 'unknownSessionControls'), mock);
  const mockCodex = mock.unknownSessionControls({ id: 'codex-session', provider: 'codex', status: 'unknown' });
  assert.doesNotMatch(mockCodex, /data-estimate=/);
  assert.match(mockCodex, /data-hide-session="codex-session"/);
  assert.match(mockCodex, /Codexの履歴からの推定には未対応です/);
  const legacyMock = mock.unknownSessionControls({ id: 'legacy', status: 'unknown' });
  assert.match(legacyMock, /data-estimate="legacy"/);
});

test('非対話で状態が不明の行は更新時刻が古くても更新の無い帯へ隠さず、対話の不明な行は従来どおり隠す', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const old = new Date(now - 31 * 60_000).toISOString();
  const context = pageContext(pageHtml, {
    displayPreferences: { idleHideMinutes: 30 }, isActiveDecision: () => false,
  });
  vm.runInContext(['isEndedAgent', 'isIdleHiddenSession'].map(name => functionSource(pageHtml, name)).join('\n'), context);
  const nonInteractive = { status: '不明', nonInteractive: true, sessionFileUpdatedAt: old, agents: [], decisions: [], permissionWaits: [] };
  assert.equal(context.isIdleHiddenSession(nonInteractive, now), false);
  assert.equal(context.isIdleHiddenSession({ ...nonInteractive, nonInteractive: undefined }, now), true);

  const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8').replace(/\r\n/g, '\n');
  const mockContext = pageContext(mock, {
    ui: { idleHideMinutes: 30, hiddenSessions: [], hiddenSessionUpdatedAt: {} },
    isActiveDecision: () => false,
    isBusyAgent: () => false,
  });
  vm.runInContext(functionSource(mock, 'isIdleHiddenSession'), mockContext);
  const mockNonInteractive = { id: 'batch', status: 'unknown', nonInteractive: true, perms: [], decisions: [], subagents: [], lastUpdatedAt: old };
  assert.equal(mockContext.isIdleHiddenSession(mockNonInteractive, now), false);
  assert.equal(mockContext.isIdleHiddenSession({ ...mockNonInteractive, nonInteractive: false }, now), true);
});

test('非対話の行は作業中と待機中を対話と同じ文言と色にし、状態不明の時だけ非対話の実行中にする', () => {
  const implContext = pageContext(pageHtml, {});
  vm.runInContext(functionSource(pageHtml, 'activityStatus'), implContext);

  const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8').replace(/\r\n/g, '\n');
  const mockContext = pageContext(mock, {
    ui: { estimatedSessions: [] },
    taskState: (session, task) => task.state,
    esc: (value) => String(value),
    sessionTag: () => '',
    renderToolLine: () => '<div class="tool-line"></div>',
    absoluteTimeLabel: () => '',
    ESTIMATE_WAITING: {},
  });
  vm.runInContext(['sessionOrigin', 'runningBackgrounds', 'mainRow', 'unknownSessionControls'].map((name) => functionSource(mock, name)).join('\n'), mockContext);

  const cases = [
    { implSession: { status: '作業中', nonInteractive: true }, mockSession: { status: 'busy', nonInteractive: true }, label: '作業中', tone: 'busy' },
    { implSession: { status: '待機中', nonInteractive: true }, mockSession: { status: 'wait', nonInteractive: true }, label: '待機中', tone: 'wait' },
    { implSession: { status: '不明', nonInteractive: true }, mockSession: { status: 'unknown', nonInteractive: true }, label: '非対話の実行中', tone: 'busy' },
  ];
  for (const { implSession, mockSession, label, tone } of cases) {
    const implStatus = implContext.activityStatus(implSession);
    assert.equal(implStatus.label, label, `実装の文言: ${JSON.stringify(implSession)}`);
    assert.equal(implStatus.tone, tone, `実装の色: ${JSON.stringify(implSession)}`);

    const row = mockContext.mainRow({}, { id: 'batch', tasks: [], main: { tool: '', since: '3 分前' }, ...mockSession }, false);
    assert.equal(row.match(/<strong>([^<]*)<\/strong>/)[1], label, `モックの文言: ${JSON.stringify(mockSession)}`);
    assert.equal(row.match(/<span class="dot ([^"]+)"><\/span>/)[1], tone, `モックの色: ${JSON.stringify(mockSession)}`);
  }
});

test('再起動直後の作業中と待機中は、経過時間にセッションファイルの状態の時刻を使う', () => {
  const context = pageContext(pageHtml, {
    element: (tag, className, text) => {
      const node = { tag, className: className || '', textContent: text, children: [], childNodes: [], dataset: {} };
      node.append = (...nodes) => { node.children.push(...nodes); node.childNodes.push(...nodes); };
      return node;
    },
    document: { createTextNode: (text) => ({ nodeType: 'text', textContent: text }) },
    appendContextTags: () => {},
    sessionOrigin: () => '',
    appendUnknownSessionControls: () => {},
    appendToolLine: () => {},
    appendSessionModelLine: () => {},
    newestFirst: (items) => items,
    durationAgoLabel: (value) => (value ? '5 分前' : '時刻不明'),
    relativeTimeElement: (value, className, label) => ({ tag: 'time', className, textContent: label, value }),
  });
  vm.runInContext(['activityStatus', 'runningBackgrounds', 'mainRow'].map((name) => functionSource(pageHtml, name)).join('\n'), context);
  const statusSince = '2026-10-05T00:00:00.000Z';
  const session = { session_id: 'restarted', status: '作業中', lastActivityAt: null, statusSince, tools: [], tasks: [], decisions: [] };
  const row = context.mainRow(session, { name: 'agent-cockpit' });
  assert.equal(row.children.find((child) => child.className === 'since').value, statusSince);
  assert.equal(row.children.find((child) => child.className === 'since').textContent, '5 分前');
});

test('セッションファイルの状態で決めたセッションは、フックの更新時刻が無くても状態の時刻で隠す判定をする', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const context = pageContext(pageHtml, { displayPreferences: { idleHideMinutes: 30 }, isActiveDecision: () => false });
  vm.runInContext(['isEndedAgent', 'isIdleHiddenSession'].map((name) => functionSource(pageHtml, name)).join('\n'), context);
  const idle = {
    status: '待機中', lastUpdatedAt: null, statusSince: new Date(now - 31 * 60_000).toISOString(),
    sessionFileUpdatedAt: new Date(now - 60_000).toISOString(), agents: [], decisions: [], permissionWaits: [],
  };
  assert.equal(context.isIdleHiddenSession(idle, now), true);
  assert.equal(context.isIdleHiddenSession({ ...idle, statusSince: null }, now), false);
});

test('読み込み直すボタンは書きかけの回答が無ければ読み込み直し、あれば案内で確かめる', () => {
  const handler = pageHtml.match(/refreshButton\.addEventListener\('click', (\(\) => \{[\s\S]*?\n\})\);/)?.[1];
  assert.ok(handler);
  const run = (hasDraft) => {
    let reloads = 0;
    const context = pageContext(pageHtml, {
      lastState: { sessions: [] },
      hasUnsentAnswerDraft: () => hasDraft,
      location: { reload() { reloads += 1; } },
      reloadNote: { hidden: true, innerHTML: '' },
      uiUpdatePending: false,
      refreshConfirmPending: false,
    });
    vm.runInContext(['renderReloadNote', 'setRefreshConfirmPending'].map((name) => functionSource(pageHtml, name)).join('\n'), context);
    vm.runInContext(`(${handler})()`, context);
    return { reloads, hidden: context.reloadNote.hidden, html: context.reloadNote.innerHTML };
  };

  assert.deepEqual(run(false), { reloads: 1, hidden: true, html: '' });
  const withDraft = run(true);
  assert.equal(withDraft.reloads, 0);
  assert.equal(withDraft.hidden, false);
  assert.match(withDraft.html, /data-reload-now>回答を消して読み込み直す</);
});

test('Codex が状態にあるときセッション、PR、「前回見てから」に起点帯を付ける', () => {
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.childNodes = this.children;
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.textContent = '';
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
  }
  class FakeText { constructor(text) { this.textContent = text; } }
  const document = {
    createElement: (tagName) => new FakeElement(tagName),
    createTextNode: (text) => new FakeText(text),
  };
  const helpers = functionSource(pageHtml, 'element');
  assert.ok(helpers);

  const sessionContext = pageContext(pageHtml, {
    document,
    displayPreferences: { hideFinished: true },
    sessionDisplayName: (session) => session.title,
    sharedBranch: () => '',
    shownPermissions: () => [],
    shownActiveDecisions: () => [],
    hasHiddenJudgmentItems: () => true,
    isEndedDecision: () => false,
    appendTasks() {},
    mainRow: () => new FakeElement('div'),
    appendAgents() {}, appendBackgrounds() {},
    orderedSectionKeys: (keys) => keys,
  });
  vm.runInContext(`${helpers}\n${functionSource(pageHtml, 'sessionOrigin')}\n${functionSource(pageHtml, 'sessionBlock')}`, sessionContext);
  const claudeSession = sessionContext.sessionBlock({}, { title: 'Claude', decisions: [] }, true, true);
  const codexSession = sessionContext.sessionBlock({}, { title: 'Codex', provider: 'codex', decisions: [] }, false, true);
  assert.match(claudeSession.className, /origin-claude/);
  assert.equal(claudeSession.dataset.origin, 'claude');
  assert.match(codexSession.className, /origin-codex/);
  assert.equal(codexSession.dataset.origin, 'codex');
  assert.equal(codexSession.children[0].children[0].dataset.origin, undefined);
  const claudeOnlySession = sessionContext.sessionBlock({}, { title: 'Claude', decisions: [] }, false, false);
  assert.doesNotMatch(claudeOnlySession.className, /origin-(claude|codex|both)/);
  assert.equal(claudeOnlySession.dataset.origin, undefined);
  assert.equal(claudeOnlySession.children[0].children[0].dataset.origin, undefined);

  const component = sourceBetween(pageHtml, 'const MERGE_METHOD_LABELS', 'function appendPullRequestBlock');
  assert.ok(component);
  const prContext = pageContext(pageHtml, {
    document,
    queuedPullRequestMerge: () => null,
    pullRequestMergeInFlight: new Set(), pullRequestResultUnconfirmed: () => false, pullRequestUnconfirmedResults: new Map(), refreshSequence: 0,
    pullRequestMergeConfirmations: new Map(),
    pullRequestMergeMessages: new Map(),
    pullRequestMergeConditionWaits: () => [],
    appendPullRequestBadges() {},
  });
  vm.runInContext(`${helpers}\n${component}`, prContext);
  const renderPr = (providers, showOriginBands = true) => {
    const root = new FakeElement('div');
    prContext.appendPullRequestTree(root, {}, reviewPr({ number: 1, title: 'PR', canMerge: false, providers, children: [] }), showOriginBands);
    return root.children[0];
  };
  for (const [providers, origin] of [
    [['codex'], 'codex'],
    [['claude', 'codex'], 'both'],
  ]) {
    const row = renderPr(providers);
    assert.match(row.className, new RegExp(`origin-${origin}`));
    assert.equal(row.dataset.origin, origin);
  }
  const unmarkedPr = renderPr([]);
  assert.doesNotMatch(unmarkedPr.className, /origin-/);
  assert.equal(unmarkedPr.dataset.origin, undefined);
  const claudeOnlyPr = renderPr(['claude'], false);
  assert.doesNotMatch(claudeOnlyPr.className, /origin-(claude|codex|both)/);
  assert.equal(claudeOnlyPr.dataset.origin, undefined);
  const codexPrOnlyState = { sessions: [], pullRequests: [{ trees: [{ providers: ['codex'], children: [] }] }], sinceSeen: [] };
  assert.equal(prContext.hasCodexOrigin(codexPrOnlyState), true);
  const claudePrWithCodexOnlyInState = renderPr(['claude'], prContext.hasCodexOrigin(codexPrOnlyState));
  assert.match(claudePrWithCodexOnlyInState.className, /origin-claude/);

  const product = { key: 'origin-test', name: 'Origin test' };
  const seenContext = pageContext(pageHtml, {
    document,
    lastState: {},
    visibleSinceSeen: () => [{ product, items: [
      { text: 'Claude', provider: 'claude' },
      { text: 'Codex', provider: 'codex' },
      { text: 'Both', providers: ['claude', 'codex'] },
      { text: 'Unknown' },
    ] }],
  });
  vm.runInContext(`let sinceSeenActionInFlight = false;\n${helpers}\n${functionSource(pageHtml, 'providerOrigin')}\n${functionSource(pageHtml, 'sinceSeenBox')}`, seenContext);
  const hiddenOrigins = seenContext.sinceSeenBox(product, false, false).children[1].children;
  assert.equal(hiddenOrigins.some((item) => /origin-(claude|codex|both)/.test(item.className) || item.dataset?.origin), false);
  const listItems = seenContext.sinceSeenBox(product, false, true).children[1].children;
  for (const [item, origin] of listItems.slice(0, 3).map((item, index) => [item, ['claude', 'codex', 'both'][index]])) {
    assert.match(item.className, new RegExp(`origin-${origin}`));
    assert.equal(item.dataset.origin, origin);
  }
  assert.equal(listItems[3].className, '');
  assert.equal(listItems[3].dataset.origin, undefined);
});

test('起点帯の判定は非表示セッション、PR の履歴、新着まで状態全体を調べる', () => {
  const context = pageContext(pageHtml, {});
  vm.runInContext(functionSource(pageHtml, 'hasCodexOrigin'), context);
  const claudeOnly = { sessions: [{ provider: 'claude' }], pullRequests: [{
    trees: [{ providers: ['claude'], children: [] }],
    mergeHistory: [{ providers: ['claude'] }],
    merged: [{ providers: ['claude'] }],
  }], sinceSeen: [{ items: [{ provider: 'claude' }] }] };
  assert.equal(context.hasCodexOrigin(claudeOnly), false);
  for (const state of [
    { ...claudeOnly, sessions: [{ provider: 'codex', hidden: true, finished: true }] },
    { ...claudeOnly, pullRequests: [{ trees: [{ providers: ['codex'], children: [] }], mergeHistory: [], merged: [] }] },
    { ...claudeOnly, pullRequests: [{ trees: [], mergeHistory: [{ providers: ['codex'] }], merged: [] }] },
    { ...claudeOnly, pullRequests: [{ trees: [], mergeHistory: [], merged: [{ providers: ['claude', 'codex'] }] }] },
    { ...claudeOnly, sinceSeen: [{ items: [{ providers: ['codex'] }] }] },
  ]) assert.equal(context.hasCodexOrigin(state), true);

  const mockContext = pageContext(mockHtml, { DATA: { products: [{
    sessions: [{ provider: 'claude' }], extraSessions: [], prs: [{ providers: ['claude'] }], closedPrs: [], news: [],
  }] } });
  vm.runInContext(functionSource(mockHtml, 'hasCodexOrigin'), mockContext);
  assert.equal(mockContext.hasCodexOrigin(), false);
  vm.runInContext(`${functionSource(mockHtml, 'providerOrigin')}\n${functionSource(mockHtml, 'originAttributes')}`, mockContext);
  assert.equal(mockContext.originAttributes(['claude'], false), '');
  assert.equal(mockContext.originAttributes(['claude'], true), ' class="origin-claude" data-origin="claude"');
  mockContext.DATA.products[0].prs.push({ providers: ['codex'] });
  assert.equal(mockContext.hasCodexOrigin(), true);

  const mockSessionContext = pageContext(mockHtml, {
    ui: { hideFinished: true },
    esc: (value) => String(value),
    visibleDecisions: () => [], visiblePerms: () => [], hasHiddenJudgmentItems: () => true,
    sessionDisplayName: (session) => session.title, sharedBranch: () => '', orderedSectionKeys: (keys) => keys,
    taskSessionBlock: () => '', mainRow: () => '', agentSection: () => '', backgroundSection: () => '', worktreeLinks: () => '',
  });
  vm.runInContext(`${functionSource(mockHtml, 'sessionOrigin')}\n${functionSource(mockHtml, 'sessionBlock')}`, mockSessionContext);
  const mockSessionProduct = { sessions: [{}] };
  const mockClaudeSession = { title: 'Claude', decisions: [] };
  assert.doesNotMatch(mockSessionContext.sessionBlock(mockSessionProduct, mockClaudeSession, false), /origin-claude|data-origin/);
  const markedMockSession = mockSessionContext.sessionBlock(mockSessionProduct, mockClaudeSession, true);
  assert.match(markedMockSession, /class="session-group single origin-claude" data-origin="claude"/);
  assert.doesNotMatch(markedMockSession, /session-context" data-origin=/);
});

function renderedKindOriginRows(provider, showOriginBands, permissionWaits = [], ended = false) {
  class FakeElement {
    constructor(tagName, className = '', textContent = '') {
      this.tagName = tagName;
      this.className = className;
      this.textContent = textContent;
      this.children = [];
      this.childNodes = this.children;
      this.dataset = {};
    }
    append(...nodes) { this.children.push(...nodes); }
  }
  const element = (tagName, className = '', textContent = '') => new FakeElement(tagName, className, textContent);
  const context = pageContext(pageHtml, {
    document: { createTextNode: text => ({ textContent: text }) },
    element,
    activityStatus: () => ({ tone: 'wait', label: '待機中' }),
    newestFirst: items => items,
    durationAgoLabel: () => '',
    relativeTimeElement: () => element('time'),
    appendContextTags() {},
    appendUnknownSessionControls() {},
    appendSessionModelLine() {},
    appendModelLine() {},
    badge: (text, tone) => element('span', `badge ${tone}`, text),
    displayPreferences: { hideFinished: !ended },
    isFilterShown: () => true,
    taskVisibility: () => ({ visible: [], todoCount: 0, doneCount: 0 }),
  });
  const functions = ['sessionOrigin', 'runningBackgrounds', 'mainRow', 'isEndedAgent', 'appendAgents', 'appendKindTaskSession']
    .map(name => functionSource(pageHtml, name));
  vm.runInContext(functions.join('\n'), context);
  const session = {
    provider, session_id: 'session', status: '待機中', tasks: [], tools: [], permissionWaits, agents: [{ agent_id: 'worker', active: !ended, agent_type: 'worker' }],
  };
  const activity = context.mainRow(session, {}, true, false, showOriginBands);
  const agentBody = element('div');
  context.appendAgents(agentBody, session, {}, false, false, ended, false, showOriginBands);
  const agent = agentBody.children.find(node => node.className === 'agent-list').children[0];
  const taskBody = element('div');
  context.appendKindTaskSession(taskBody, { product: {}, session, multipleSessions: false }, false, false, showOriginBands);
  return [activity, agent, taskBody.children[0]];
}

function renderedMockKindOriginRows(provider, showOriginBands, perms = [], ended = false) {
  const context = pageContext(mockHtml, {
    ui: { estimatedSessions: [], closedAgents: [], expandedKindTodoTasks: false },
    taskState: (_session, task) => task.state,
    taskVisibility: () => ({ visible: [], doneCount: 0 }),
    taskItem: () => '',
    sessionTag: () => '',
    esc: value => String(value ?? ''),
    renderToolLine: () => '',
    modelLine: () => '',
    routeTag: () => '',
    unknownSessionControls: () => '',
    isClosedByUser: () => ended,
    isBusyAgent: () => true,
    isUnconfirmed: () => false,
    isClosable: () => false,
  });
  const functions = ['sessionOrigin', 'runningBackgrounds', 'mainRow', 'agentRow', 'kindTaskSessionBlock']
    .map(name => functionSource(mockHtml, name));
  vm.runInContext(functions.join('\n'), context);
  const session = { provider, status: 'wait', tasks: [], perms, main: { tool: '—', since: '1 分前' } };
  return [
    context.mainRow({}, session, true, showOriginBands),
    context.agentRow({}, session, { type: 'worker', state: 'busy', since: '1 分前' }, true, showOriginBands),
    context.kindTaskSessionBlock({}, session, false, showOriginBands).html,
  ];
}

test('サブエージェントの札は終了状態を優先し、稼働中は確認中より許可待ちを優先する', () => {
  const waits = [
    { agent_id: 'worker', phase: 'checking', target_tool_use_id: 'first' },
    { agent_id: 'worker', phase: 'checking', target_tool_use_id: 'second' },
    { agent_id: 'worker', phase: 'prompted', target_tool_use_id: null },
  ];
  for (const [ended, label, tone] of [[false, '許可待ち', 'wait'], [true, '終了', 'done']]) {
    const [, agent] = renderedKindOriginRows('claude', true, waits, ended);
    const badge = agent.children[0].children.find(node => node.className === 'agent-name').children[0];
    assert.equal(badge.textContent, label);
    assert.equal(badge.className, `badge ${tone}`);
    const [, mockAgent] = renderedMockKindOriginRows('claude', true, waits.map(wait => ({ ...wait, who: 'worker' })), ended);
    assert.match(mockAgent, new RegExp(`class="badge ${tone}">${label}</span>`));
  }
});

test('種類別のタスクと作業行はセッションの起点色で帯を表示する', () => {
  for (const [provider, origin] of [['claude', 'claude'], ['codex', 'codex']]) {
    for (const row of renderedKindOriginRows(provider, true)) {
      assert.match(row.className, new RegExp(`origin-${origin}`));
      assert.equal(row.dataset.origin, origin);
    }
    for (const row of renderedMockKindOriginRows(provider, true)) {
      assert.match(row, new RegExp(`origin-${origin}`));
      assert.match(row, new RegExp(`data-origin="${origin}"`));
    }
  }
});

test('サブエージェントの種類別の帯は親セッションの provider を使う', () => {
  const [, agent] = renderedKindOriginRows('codex', true);
  assert.match(agent.className, /origin-codex/);
  assert.equal(agent.dataset.origin, 'codex');
});

test('種類別の起点帯を表示しないときはタスクと作業行に起点属性を付けない', () => {
  for (const row of renderedKindOriginRows('codex', false)) {
    assert.doesNotMatch(row.className, /origin-(claude|codex|both)/);
    assert.equal(row.dataset.origin, undefined);
  }
  for (const row of renderedMockKindOriginRows('codex', false)) {
    assert.doesNotMatch(row, /origin-(claude|codex|both)|data-origin=/);
  }
});

test('種類別のタスクと作業行の帯は画面とモックで既存の起点色を使う', () => {
  for (const html of [pageHtml, mockHtml]) {
    for (const origin of ['claude', 'codex']) {
      for (const selector of [`.kind-session-tasks.origin-${origin}::before`, `.now-row.origin-${origin}::before`, `.agent-row.origin-${origin}::before`]) {
        const style = Object.fromEntries(cssDeclarations(html, selector));
        const rowStyle = Object.fromEntries(cssDeclarations(html, selector.replace('::before', '')));
        assert.equal(style.position, 'absolute');
        assert.equal(style.width, '3px');
        assert.equal(style.background, `var(--origin-${origin})`);
        assert.equal(rowStyle['padding-left'], '10px');
      }
    }
  }
});

test('中断したセッションは「中断」と輪郭だけの点で出し、終わったものにも更新の無い帯にも入れない', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const old = new Date(now - 31 * 60_000).toISOString();
  const element = (tag, className, text) => {
    const node = { tag, className: className || '', textContent: text, title: '', children: [], childNodes: [], dataset: {} };
    node.append = (...nodes) => { node.children.push(...nodes); node.childNodes.push(...nodes); };
    return node;
  };
  const context = pageContext(pageHtml, {
    element,
    displayPreferences: { idleHideMinutes: 30 },
    isActiveDecision: () => false,
    document: { createTextNode: (text) => ({ nodeType: 'text', textContent: text }) },
    appendContextTags: () => {},
    sessionOrigin: () => '',
    appendUnknownSessionControls: () => {},
    appendToolLine: () => {},
    appendSessionModelLine: () => {},
    newestFirst: (items) => items,
    durationAgoLabel: () => '5 分前',
    relativeTimeElement: (value, className, label) => ({ tag: 'time', className, textContent: label, value }),
  });
  vm.runInContext(['activityStatus', 'isEndedAgent', 'isEndedDecision', 'runningBackgrounds', 'isFinishedSession', 'isIdleHiddenSession', 'mainRow']
    .map((name) => functionSource(pageHtml, name)).join('\n'), context);
  const session = {
    session_id: 'interrupted', status: '中断', lastActivityAt: old, lastUpdatedAt: old, tools: [], tasks: [{ state: 'done' }],
    decisions: [], permissionWaits: [], agents: [], sessionFileUpdatedAt: old,
  };

  assert.deepEqual({ ...context.activityStatus(session) }, { label: '中断', tone: 'interrupted' });
  assert.equal(context.isFinishedSession(session), false);
  assert.equal(context.isFinishedSession({ ...session, status: '待機中' }), true);
  assert.equal(context.isIdleHiddenSession(session, now), false);
  assert.equal(context.isIdleHiddenSession({ ...session, status: '待機中' }, now), true);

  const who = context.mainRow(session, { name: 'agent-cockpit' }).children.find((child) => child.className === 'who');
  assert.equal(who.children[0].className, 'dot interrupted');
  const label = who.children.find((child) => child.tag === 'strong');
  assert.equal(label.textContent, '中断');
  assert.equal(label.title, '利用者が中断した。セッションは生きていて、次の入力を待っている');
  assert.match(pageHtml, /\.dot\.interrupted \{ background: transparent; box-shadow: inset 0 0 0 2px var\(--warn\); \}/);
});

test('モックの中断の行は画面と同じ文言と点で出し、終わったものにも更新の無い帯にも入れない', () => {
  const now = Date.parse('2026-10-08T12:00:00.000Z');
  const old = new Date(now - 31 * 60_000).toISOString();
  const context = pageContext(mockHtml, {
    ui: { estimatedSessions: [], idleHideMinutes: 30, hiddenSessions: [], hiddenSessionUpdatedAt: {} },
    taskState: (session, task) => task.state,
    esc: (value) => String(value),
    sessionTag: () => '',
    renderToolLine: () => '<div class="tool-line"></div>',
    absoluteTimeLabel: () => '',
    ESTIMATE_WAITING: {},
    isActiveDecision: () => false,
    isBusyAgent: () => false,
    isEndedDecision: () => true,
    isEndedAgent: () => true,
  });
  vm.runInContext(['sessionOrigin', 'runningBackgrounds', 'mainRow', 'unknownSessionControls', 'isIdleHiddenSession', 'isFinishedSession']
    .map((name) => functionSource(mockHtml, name)).join('\n'), context);
  const session = { id: 'interrupted', status: 'interrupted', tasks: [], perms: [], decisions: [], subagents: [], lastUpdatedAt: old, main: { tool: '—', since: '3 分前' } };

  const row = context.mainRow({}, session, false);
  assert.match(row, /<span class="dot interrupted"><\/span>/);
  assert.match(row, /<strong title="利用者が中断した。セッションは生きていて、次の入力を待っている">中断<\/strong>/);
  assert.equal(context.isFinishedSession(session), false);
  assert.equal(context.isFinishedSession({ ...session, status: 'wait' }), true);
  assert.equal(context.isIdleHiddenSession(session, now), false);
  assert.equal(context.isIdleHiddenSession({ ...session, status: 'wait' }, now), true);
  assert.match(mockHtml, /\.dot\.interrupted \{ background: transparent; box-shadow: inset 0 0 0 2px var\(--warn\); \}/);
});


test('完了条件が空のタスクは実画面とモックで件数と一覧を出さず、操作列の幅を維持する', () => {
  const element = (tagName, className = '', textContent = '') => ({
    tagName, className, textContent, children: [], dataset: {}, append(...nodes) { this.children.push(...nodes); },
    setAttribute() {},
  });
  const context = pageContext(pageHtml, { element, badge: () => element('span'), appendContextTags() {},
    pendingTaskCloseActions: new Map(), taskCloseActionsInFlight: new Set() });
  vm.runInContext(functionSource(pageHtml, 'appendTaskItem'), context);
  const mockContext = pageContext(mockHtml, { taskState: (session, task) => task.state,
    closedTaskKey: () => 'key', pendingClosedTasks: new Map(), sessionTag: () => '', esc: text => text });
  vm.runInContext(functionSource(mockHtml, 'taskItem'), mockContext);
  for (const state of ['todo', 'done']) {
    const root = element('ul');
    const task = { title: '段階', state, criteria: [] };
    context.appendTaskItem(root, task, {}, { session_id: 'session' });
    const flatten = node => [node, ...node.children.flatMap(flatten)];
    assert.ok(!flatten(root).some(node => node.textContent.includes('完了条件') || node.className === 'criteria-list'));
    assert.ok(flatten(root).some(node => node.className === 'task-actions'));
    const markup = mockContext.taskItem({}, {}, task, false);
    assert.doesNotMatch(markup, /完了条件|<ul class="criteria">/);
    assert.match(markup, /class="task-actions"/);
  }
  for (const html of [pageHtml, mockHtml]) {
    assert.equal(new Map(cssDeclarations(html, '.task-actions')).get('min-width'), 'calc(6em + 11px)');
  }
});

test('作業中の完了条件は実画面とモックで doing クラスを付け、達成済みを優先する', () => {
  const element = (tagName, className = '', textContent = '') => ({
    tagName, className, textContent, children: [], dataset: {}, append(...nodes) { this.children.push(...nodes); },
    setAttribute() {},
  });
  const context = pageContext(pageHtml, { element, badge: () => element('span'), appendContextTags() {},
    pendingTaskCloseActions: new Map(), taskCloseActionsInFlight: new Set() });
  vm.runInContext(functionSource(pageHtml, 'appendTaskItem'), context);
  const mockContext = pageContext(mockHtml, { taskState: (session, task) => task.state,
    closedTaskKey: () => 'key', pendingClosedTasks: new Map(), sessionTag: () => '', esc: text => text });
  vm.runInContext(functionSource(mockHtml, 'taskItem'), mockContext);
  const task = {
    title: '実装する', state: 'doing', criteria: [
      { text: '作業中の条件', met: false, doing: true },
      { text: '達成済みの条件', met: true, doing: true },
    ],
  };
  const root = element('ul');
  context.appendTaskItem(root, task, {}, { session_id: 'session' });
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  assert.deepEqual(flatten(root).filter(node => ['doing', 'met'].includes(node.className)).map(node => node.className), ['doing', 'met']);

  const markup = mockContext.taskItem({}, {}, {
    ...task, criteria: task.criteria.map(criterion => ({ ...criterion, t: criterion.text })),
  }, false);
  assert.match(markup, /<li class="doing">作業中の条件<\/li>/);
  assert.match(markup, /<li class="met">達成済みの条件<\/li>/);
});


test('取り込みの確認は未確認なら一度だけ開き、確認済みなら開かない', () => {
  for (const asked of [false, true]) {
    let opened = 0;
    const context = pageContext(pageHtml, {
      displayPreferences: { importAppTasksAsked: asked },
      importAppTasksPromptShown: false,
      importAppTasksDialog: { showModal() { opened += 1; } },
    });
    vm.runInContext(functionSource(pageHtml, 'maybeAskImportAppTasks'), context);
    context.maybeAskImportAppTasks();
    context.maybeAskImportAppTasks();
    assert.equal(opened, asked ? 0 : 1);
  }
  const dialog = html => html.match(/<dialog[^>]*id="import-app-tasks-dialog"[\s\S]*?<\/dialog>/)?.[0];
  assert.equal(dialog(pageHtml), dialog(mockHtml));
});

test('取り込み確認の回答を保存し、チェックボックスと確認済みの状態を更新する', async () => {
  for (const value of [false, true]) {
    let closed = false;
    let patch;
    const input = { type: 'checkbox', checked: false };
    const preferences = { importAppTasks: false, importAppTasksAsked: false };
    const context = pageContext(pageHtml, {
      displayPreferences: preferences,
      importAppTasksPromptAnswered: false,
      importAppTasksInput: input,
      importAppTasksDialog: { close() { closed = true; } },
      saveDisplayPreferences: async (changes, setting) => {
        patch = changes;
        Object.assign(preferences, changes);
        setting.input.checked = changes.importAppTasks;
        return true;
      },
    });
    vm.runInContext(functionSource(pageHtml, 'answerImportAppTasks'), context);
    await context.answerImportAppTasks(value);
    assert.deepEqual(JSON.parse(JSON.stringify(patch)), { importAppTasks: value });
    assert.equal(closed, true);
    assert.equal(input.checked, value);
    assert.equal(preferences.importAppTasksAsked, true);
  }
});

test('取り込み確認を Esc で閉じると取り込まない回答を送る', () => {
  let handler;
  let answer;
  let prevented = false;
  const context = pageContext(pageHtml, {
    importAppTasksDialog: { addEventListener(type, callback) { assert.equal(type, 'cancel'); handler = callback; } },
    answerImportAppTasks(value) { answer = value; },
  });
  const binding = pageHtml.match(/importAppTasksDialog.addEventListener\('cancel',[\s\S]*?\n\}\);/)[0];
  vm.runInContext(binding, context);
  handler({ preventDefault() { prevented = true; } });
  assert.equal(prevented, true);
  assert.equal(answer, false);
});


test('取り込み確認を直接閉じても取り込まない回答を送り、回答後の close では重複保存しない', async () => {
  let handler;
  const patches = [];
  const context = pageContext(pageHtml, {
    importAppTasksPromptAnswered: false,
    displayPreferences: { importAppTasksAsked: false },
    importAppTasksInput: { type: 'checkbox', checked: false },
    importAppTasksDialog: {
      addEventListener(type, callback) { handler = callback; },
      close() {},
    },
    saveDisplayPreferences: async (patch) => { patches.push(patch); return true; },
  });
  const binding = pageHtml.match(/importAppTasksDialog.addEventListener\('close',[^\n]+/)[0];
  vm.runInContext(functionSource(pageHtml, 'answerImportAppTasks') + '\n' + binding, context);
  handler();
  await context.answerImportAppTasks(false);
  handler();
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ importAppTasks: false }]);
});

test('再起動待ちの帯はバージョンが違えば配置済みのバージョンを示し、コミットは出さず、解消したら消す', () => {
  for (const source of [pageHtml, mockHtml]) {
    const f = restartNoteHarness(source);
    f.state.runtime = { version: '1.4.0', commit: 'c933f60' };
    f.state.installed = { version: '1.5.0', commit: 'a1b2c3d' };
    f.render();
    assert.equal(f.note.hidden, false);
    assert.equal(f.note.message, 'バージョン 1.5.0 のファイルが配置されています。常駐サーバーを再起動すると反映されます。');
    f.state.installed.version = '1.4.0';
    f.render();
    assert.equal(f.note.message, '更新したファイルが配置されています。常駐サーバーを再起動すると反映されます。');
    f.state.uiVersion = 'old';
    f.state.installed.uiVersion = 'new';
    f.render();
    assert.equal(f.note.message, '更新したファイルが配置されています。常駐サーバーを再起動すると反映されます。');
    assert.doesNotMatch(f.note.message, /実行中|配置済み|c933f60|a1b2c3d/);
    f.state.restartRequired = false;
    f.render();
    assert.equal(f.note.hidden, true);
    assert.equal(f.note.textContent, '');
  }
});

function restartNoteHarness(source, response = async () => ({ status: 202 }), clipboard = { writeText: async () => {} }) {
  let focused = null;
  let activeElement = null;
  const nodeText = node => typeof node === 'string' ? node : node.textContent;
  const element = tagName => ({
    tagName, dataset: {}, className: '', ownText: '', children: [],
    get textContent() { return this.ownText + this.children.map(nodeText).join(''); },
    set textContent(value) { this.ownText = value; this.children = []; },
    append(...nodes) { this.children.push(...nodes); },
    querySelectorAll(selector) {
      return this.children.filter(node => typeof node !== 'string')
        .flatMap(node => [...(node.tagName === selector ? [node] : []), ...node.querySelectorAll(selector)]);
    },
    addEventListener(type, fn) { this.click = fn; },
    focus() { focused = this.textContent; activeElement = this; },
  });
  const note = Object.assign(element('div'), { hidden: true, rebuilt: 0 });
  Object.defineProperty(note, 'textContent', {
    get() { return this.ownText + this.children.map(nodeText).join(''); },
    set(value) { this.ownText = value; this.children = []; activeElement = null; this.rebuilt += 1; },
  });
  Object.defineProperty(note, 'message', { get() { return this.ownText; } });
  const timers = new Map();
  const context = pageContext(source, {
    document: {
      get activeElement() { return activeElement; },
      getElementById: () => note,
      createElement: element,
    },
    navigator: { clipboard },
    requestServerRestart: response,
    setTimeout: (fn, ms) => { timers.set(fn, ms); return fn; }, clearTimeout: id => timers.delete(id),
  });
  vm.runInContext(functionSource(source, 'renderRestartNote'), context);
  const state = { restartRequired: true, restartAvailable: true, runtime: { startedAt: 'before' },
    sessions: [{ permissionWaits: [{ phase: 'prompted' }, { phase: 'prompted' }, { phase: 'checking' }] }] };
  const render = () => context.renderRestartNote(state);
  render();
  const click = label => {
    const button = note.querySelectorAll('button').find(item => item.textContent === label);
    button.focus();
    return button.click();
  };
  const rows = () => note.children.map(row => ({ className: row.className, items: row.children.map(nodeText) }));
  return { note, get buttons() { return note.querySelectorAll('button'); }, rows, timers, state, render, click, context, focused: () => focused };
}

const toolsButton = '導入の点検を開く';

for (const [label, source] of [['画面', pageHtml], ['モック', mockHtml]]) {
  test(`${label}の再起動待ちの帯から導入の点検を開く`, () => {
    const f = restartNoteHarness(source);
    let opened = 0;
    f.context.openDoctorDialog = () => { opened += 1; };
    f.click(toolsButton);
    assert.equal(opened, 1);
  });

  test(`${label}の再起動待ちでは再起動と導入の点検のボタンを順に表示する`, () => {
    const f = restartNoteHarness(source);
    assert.deepEqual(f.rows(), [
      { className: 'restart-note-actions', items: ['常駐サーバーを再起動する', 'または', toolsButton] },
    ]);
    f.state.restartAvailable = false;
    f.render();
    assert.deepEqual(f.rows(), [{ className: 'restart-note-actions', items: [toolsButton] }]);
  });
}

test('保存失敗の帯は未保存と再試行を示し、復旧後に警告を消す', async () => {
  for (const source of [pageHtml, mockHtml]) {
    const text = { textContent: '' };
    const button = {};
    const note = { hidden: true, querySelector: selector => selector === 'button' ? button : text };
    const context = pageContext(source, { document: { getElementById: () => note },
      retryPersistence: async () => ({ persistence: { status: 'saved', files: [] } }) });
    vm.runInContext(functionSource(source, 'renderPersistenceNote'), context);
    context.renderPersistenceNote({ persistence: { status: 'failed', files: [
      { fileName: 'store.json', errorCode: 'ENOSPC', lastFailureAt: '2026-10-18T00:00:00Z' },
    ] } });
    assert.equal(note.hidden, false);
    assert.match(text.textContent, /現在の状態を保存できていません/);
    assert.match(text.textContent, /store.json: ENOSPC/);
    await button.onclick();
    assert.equal(button.disabled, false);
    assert.equal(note.hidden, true);
  }
});

test('保存失敗中は再起動操作を出さず、通常の保存待ちでは確認を維持する', () => {
  for (const [label, source] of [['画面', pageHtml], ['モック', mockHtml]]) {
    const f = restartNoteHarness(source);
    f.state.persistence = { status: 'failed' };
    f.render();
    assert.match(f.note.textContent, /未保存の変更があるため、再起動できません/);
    assert.equal(f.buttons.length, 0);
    f.state.persistence = { status: 'pending' };
    f.render();
    assert.deepEqual(f.buttons.map(button => button.textContent), ['常駐サーバーを再起動する', toolsButton]);
    f.click('常駐サーバーを再起動する');
    const rebuilt = f.note.rebuilt;
    f.state.persistence = { status: 'saved' };
    f.render();
    assert.equal(f.note.rebuilt, rebuilt);
    assert.deepEqual(f.buttons.map(button => button.textContent), ['再起動する', 'やめる']);
  }
});

for (const [label, source] of [['画面', pageHtml], ['モック', mockHtml]]) {
  test(`${label}は再起動時の保存が完了しなければ待ってからの再試行を案内する`, async () => {
    const f = restartNoteHarness(source, async () => ({ status: 409, json: async () => ({ persistence: { status: 'pending' } }) }));
    f.click('常駐サーバーを再起動する');
    await f.click('再起動する');
    assert.equal(f.note.message, '保存処理が進行中です。少し待ってから再起動してください。');
    assert.deepEqual(f.buttons.map(button => button.textContent), ['常駐サーバーを再起動する', toolsButton]);
  });

  test(`${label}の再起動は帯で消える行と許可待ちを確認し、やめると元に戻る`, () => {
    const f = restartNoteHarness(source);
    f.click('常駐サーバーを再起動する');
    assert.equal(f.note.message, '再起動すると、実行中のツールとサブエージェントの行は消え、次のイベントから組み立て直されます。許可待ち 2 件は、再起動後に表示されません。');
    f.click('やめる');
    assert.deepEqual(f.buttons.map(button => button.textContent), ['常駐サーバーを再起動する', toolsButton]);
    f.state.restartAvailable = false;
    f.render();
    assert.deepEqual(f.buttons.map(button => button.textContent), [toolsButton]);
  });

  test(`${label}の帯は同じ表示なら作り直さず、確認と取り消しで次に押すボタンへフォーカスを移す`, () => {
    const f = restartNoteHarness(source);
    const rebuilt = f.note.rebuilt;
    f.render();
    assert.equal(f.note.rebuilt, rebuilt);
    f.click('常駐サーバーを再起動する');
    assert.equal(f.focused(), '再起動する');
    f.render();
    assert.deepEqual(f.buttons.map(button => button.textContent), ['再起動する', 'やめる']);
    f.click('やめる');
    assert.equal(f.focused(), '常駐サーバーを再起動する');
  });

  test(`${label}の再起動確認で許可待ちの件数が変わってもフォーカスを保つ`, () => {
    const f = restartNoteHarness(source);
    f.click('常駐サーバーを再起動する');
    const cancel = f.buttons.find(button => button.textContent === 'やめる');
    cancel.focus();
    f.state.sessions[0].permissionWaits.splice(1, 1);
    f.render();
    assert.notEqual(f.buttons[1], cancel);
    assert.equal(f.focused(), 'やめる');
  });

  test(`${label}は受付後に再起動中を示し、起動時刻が変わると帯を消す`, async () => {
    const f = restartNoteHarness(source);
    f.click('常駐サーバーを再起動する');
    await f.click('再起動する');
    assert.equal(f.note.message, '常駐サーバーを再起動しています。');
    assert.equal(f.buttons.length, 0);
    f.state.restartAvailable = false;
    f.render();
    assert.equal(f.note.message, '常駐サーバーを再起動しています。');
    f.state.runtime.startedAt = 'after';
    f.state.restartRequired = false;
    f.render();
    assert.equal(f.note.hidden, true);
    assert.equal(f.timers.size, 0);
  });

  test(`${label}は拒否や通信失敗を帯で案内し再起動ボタンを戻す`, async () => {
    for (const response of [async () => ({ status: 409 }), async () => { throw new Error('offline'); }]) {
      const f = restartNoteHarness(source, response);
      f.click('常駐サーバーを再起動する');
      await f.click('再起動する');
      assert.equal(f.note.message, '再起動を始められませんでした。タスクトレイのメニューから再起動してください。');
      assert.deepEqual(f.buttons.map(button => button.textContent), ['常駐サーバーを再起動する', toolsButton]);
    }
  });

  test(`${label}は起動時刻が変わらなければ 30 秒で失敗を示し、サーバーが受け付けるまで再起動ボタンを出さない`, async () => {
    const f = restartNoteHarness(source);
    f.click('常駐サーバーを再起動する');
    await f.click('再起動する');
    f.state.restartAvailable = false;
    const [timeout, ms] = [...f.timers][0];
    assert.equal(ms, 30_000);
    timeout();
    assert.equal(f.note.message, '再起動できませんでした。タスクトレイのメニューから再起動してください。');
    assert.deepEqual(f.buttons.map(button => button.textContent), [toolsButton]);
    f.state.restartAvailable = true;
    f.render();
    assert.deepEqual(f.buttons.map(button => button.textContent), ['常駐サーバーを再起動する', toolsButton]);
  });
}

test('画面の再起動は認証を取り直せる共通の送信を使う', async () => {
  const sent = [];
  const context = pageContext(pageHtml, { postUiAction: async (url, body) => { sent.push([url, body]); return { status: 202 }; } });
  vm.runInContext(functionSource(pageHtml, 'requestServerRestart'), context);
  assert.equal((await context.requestServerRestart()).status, 202);
  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [['/api/server/restart', {}]]);
});

for (const version of ['v1', 'v2', '']) {
  test(`401 で取り直した画面の版 ${version || '空'} と現在の版を照合して再送を決める`, async () => {
    const harness = reloadHarness(version === '' ? '' : 'v1', [[DRAFT_KEY, { choice: 'ok', note: '', picks: [] }]]);
    const secret = { content: 'old-secret' };
    const unauthorized = { status: 401, ok: false };
    let sends = 0;
    Object.assign(harness.context, {
      lastState: answerableState(),
      document: { querySelector: () => secret },
      DOMParser: class { parseFromString() { return { querySelector: selector => ({ content: selector.includes('ui-version') ? version : 'new-secret' }) }; } },
      fetchUi: async () => ({ ok: true, text: async () => '<html>' }),
      fetch: async () => { sends += 1; return unauthorized; },
      reportWebFailure: () => {},
    });
    vm.runInContext(['postUiAction', 'refreshUiSecret'].map(name => functionSource(pageHtml, name)).join('\n'), harness.context);
    assert.equal(await harness.context.postUiAction('/api/away', {}), unauthorized);
    assert.equal(sends, version === 'v2' ? 1 : 2);
    assert.equal(secret.content, version === 'v2' ? 'old-secret' : 'new-secret');
    assert.equal(harness.reloadNote.hidden, version !== 'v2');
    assert.equal(harness.reloadCount, 0);
  });
}

test('401 で画面が変わり下書きが無ければ再送せず読み込み直す', async () => {
  const harness = reloadHarness('v1');
  Object.assign(harness.context, {
    lastState: {},
    DOMParser: class { parseFromString() { return { querySelector: () => ({ content: 'v2' }) }; } },
    fetchUi: async () => ({ ok: true, text: async () => '<html>' }),
  });
  vm.runInContext(functionSource(pageHtml, 'refreshUiSecret'), harness.context);
  assert.equal(await harness.context.refreshUiSecret(), false);
  assert.equal(harness.reloadCount, 1);
});


function hiddenSessionRestoreHarness(sessions, statuses = []) {
  const requests = [];
  const note = { hidden: true, children: [], replaceChildren(...children) { this.children = children; } };
  let focused;
  const element = (tagName, className, textContent) => ({ tagName, className, textContent, dataset: {}, focus() { focused = this; } });
  const context = pageContext(pageHtml, {
    lastState: { sessions }, hiddenSessionsUndo: null, recordDeletionConfirmations: new Map(),
    document: { getElementById: () => note, querySelector: selector => {
      const key = { '[data-clear-hidden-sessions]': 'clearHiddenSessions', '[data-undo-restored-sessions]': 'undoRestoredSessions' }[selector];
      return note.children.find(child => child.dataset?.[key]);
    } },
    root: { querySelector: () => null }, element, isIdleHiddenSession: session => session.idle === true,
    countJudgments: () => ({}), appendRecordDeletion() {}, liveStatus: {}, showWriteError() {},
    postUiAction: async (url, body) => {
      requests.push({ url, body });
      const status = statuses.shift() || 200;
      if (status === 200) for (const session of sessions) {
        if (body.action === 'clear') session.hidden = false;
        else if (body.session_ids?.includes(session.session_id) || body.session_id === session.session_id) session.hidden = body.action === 'hide';
      }
      return { ok: status === 200, status };
    },
    refresh: async () => context.renderExcludedNote(sessions),
  });
  vm.runInContext(['renderExcludedNote', 'runSessionAction'].map(name => functionSource(pageHtml, name)).join('\n'), context);
  const handler = pageHtml.match(/document\.addEventListener\('click', (\(event\) => \{[\s\S]*?\n\})\);/)[1];
  vm.runInContext(`this.handleClick = ${handler};`, context);
  const action = context.runSessionAction;
  let pending;
  context.runSessionAction = (...args) => (pending = action(...args));
  context.renderExcludedNote(sessions);
  return { context, requests, note, get focused() { return focused; },
    async click(key) { const button = note.children.find(child => child.dataset?.[key]); context.handleClick({ target: { closest: () => button } }); await pending; } };
}

test('外した全セッションを戻した後は、更新の無いものを除いて記録した ID だけを50件ずつ隠し直す', async () => {
  const sessions = Array.from({ length: 52 }, (_, index) => ({ session_id: `hidden-${index}`, hidden: true, idle: index === 51 }));
  sessions.push({ session_id: 'shown', hidden: false });
  const harness = hiddenSessionRestoreHarness(sessions);
  harness.context.hiddenSessionsUndo = { productName: '作業', sessionIds: ['hidden-0'] };
  await harness.click('clearHiddenSessions');
  assert.equal(harness.context.hiddenSessionsUndo, null);
  assert.ok(harness.note.children.some(child => child.textContent === '外したセッション (51 件) を戻しました。'));
  assert.equal(harness.focused.dataset.undoRestoredSessions, 'true');
  await harness.click('undoRestoredSessions');
  assert.deepEqual(harness.requests.slice(1).map(({ body }) => body.session_ids.length), [50, 1]);
  assert.ok(harness.requests.every(({ url }) => url === '/api/hidden-sessions'));
  assert.ok(sessions.slice(0, 51).every(session => session.hidden));
  assert.equal(sessions[51].hidden, false);
  assert.equal(sessions[52].hidden, false);
  assert.equal(harness.context.restoredHiddenSessionsUndo, null);
  assert.equal(harness.focused.dataset.clearHiddenSessions, 'true');
});

test('隠し直す途中の404と409を無視して残るセッションを処理する', async () => {
  const sessions = Array.from({ length: 101 }, (_, index) => ({ session_id: `hidden-${index}`, hidden: true }));
  const harness = hiddenSessionRestoreHarness(sessions, [200, 404, 409, 200]);
  await harness.click('clearHiddenSessions');
  await harness.click('undoRestoredSessions');
  assert.deepEqual(harness.requests.slice(1).map(({ body }) => body.session_ids.length), [50, 50, 1]);
  assert.equal(harness.context.liveStatus.textContent, undefined);
  assert.equal(harness.context.restoredHiddenSessionsUndo, null);
});

test('全件復元の取り消し対象が別の画面で消えていたら、取り消しの案内を消す', async () => {
  const sessions = [{ session_id: 'gone', hidden: true }];
  const harness = hiddenSessionRestoreHarness(sessions, [200, 404]);
  await harness.click('clearHiddenSessions');
  sessions.splice(0);
  await harness.click('undoRestoredSessions');
  assert.equal(harness.context.restoredHiddenSessionsUndo, null);
  assert.equal(harness.note.hidden, true);
});

test('全件を戻した後にセッションやプロダクトを外すと新しい操作だけを取り消せる', async () => {
  for (const undoInfo of [null, { productName: '作業', sessionIds: ['hidden'] }]) {
    const harness = hiddenSessionRestoreHarness([{ session_id: 'hidden', hidden: true }]);
    await harness.click('clearHiddenSessions');
    await harness.context.runSessionAction({ dataset: {} }, '/api/hidden-sessions', { action: 'hide', session_ids: ['hidden'] }, '失敗', false, undoInfo);
    assert.equal(harness.context.restoredHiddenSessionsUndo, null);
    assert.equal(harness.context.hiddenSessionsUndo, undoInfo);
    assert.equal(harness.note.children.filter(child => child.textContent === '元に戻す').length, undoInfo ? 1 : 0);
  }
});

test('記録削除で全件復元の取り消し対象から削除済み ID を除き、空なら案内を消す', async () => {
  const harness = recordDeletionHarness([{ session_id: 'deleted', hidden: true }, { session_id: 'retained', hidden: false }], async () => ({ ok: true, json: async () => ({ deleted: { sessions: 1, pullRequests: 0 } }) }));
  harness.context.restoredHiddenSessionsUndo = ['deleted', 'retained'];
  harness.buttons().find(button => button.dataset.recordAction === 'open').listeners.click();
  await harness.context.deleteNoteRecords('excluded');
  assert.deepEqual(Array.from(harness.context.restoredHiddenSessionsUndo), ['retained']);
  harness.context.restoredHiddenSessionsUndo = ['deleted'];
  harness.buttons().find(button => button.dataset.recordAction === 'open').listeners.click();
  await harness.context.deleteNoteRecords('excluded');
  assert.equal(harness.context.restoredHiddenSessionsUndo, null);
});


test('終わったものを一時表示しても帯の件数と記録削除の対象を保つ', () => {
  const harness = recordDeletionHarness([{ session_id: 'finished', finished: true }], async () => ({ ok: true }));
  const targets = JSON.stringify(harness.context.recordDeletionTargets.get('finished'));
  for (const message of ['終わったものを隠しています', '終わったものを表示しています']) {
    assert.ok(harness.nodes().some(node => node.textContent.includes(message)));
    assert.ok(harness.buttons().some(button => button.dataset.recordBand === 'finished' && button.dataset.recordAction === 'open'));
    assert.equal(JSON.stringify(harness.context.recordDeletionTargets.get('finished')), targets);
    harness.buttons().find(button => button.dataset.showFinished === 'note').listeners.click();
  }
});

for (const scenario of [
  { name: '道具なしで予約なし', source: 'tool-absent', show: false },
  { name: '道具なしで予約あり', source: 'tool-absent', reserved: true, show: true },
  { name: '不要の記録あり', source: 'recorded', show: true },
]) {
  test(`PR 行が「${scenario.name}」なら収束後マージのチェックを${scenario.show ? '表示する' : '表示しない'}`, () => {
    const element = (tagName, className = '', textContent = '') => ({ tagName, className, textContent, children: [], dataset: {},
      append(...nodes) { this.children.push(...nodes); }, setAttribute() {} });
    const context = pageContext(pageHtml, {
      element, document: { createTextNode: (text) => element('text', '', text) },
      queuedPullRequestMerge: () => null, pullRequestMergeKey: () => 'key', pullRequestResultUnconfirmed: () => false,
      pullRequestMergeConfirmations: new Map(), pullRequestMergeInFlight: new Set(), pullRequestMergeMessages: new Map(),
      pullRequestReservationPending: new Map(), pullRequestMergeConditionWaits: () => [], providerOrigin: () => '',
      appendPullRequestBadges() {}, crossReviewState: () => ({}), crossReviewLine: () => element('div'),
      badge: (_text) => element('span'), absoluteTimeLabel: () => '', pullRequestReservationWaits: () => [], MERGE_METHOD_LABELS: {},
    });
    vm.runInContext(functionSource(pageHtml, 'appendPullRequestTree'), context);
    const root = element('div');
    context.appendPullRequestTree(root, { mergeMethods: ['merge'] }, reviewPr({ number: 31, mergeSessionId: 'session-pr', canMerge: true, children: [],
      crossReview: { notRequired: true, source: scenario.source }, reservation: scenario.reserved ? { method: 'merge' } : null }));
    const flatten = (node) => [node, ...node.children.flatMap(flatten)];
    const toggle = flatten(root).find((node) => node.dataset.reservationToggle === 'key');
    assert.equal(Boolean(toggle), scenario.show);
    if (scenario.reserved) assert.equal(toggle.checked, true);
    assert.ok(flatten(root).some((node) => node.dataset.openMerge === 'key'));
  });
}

test('前提が消えた衝突の確認欄と登録を外す確認は、条件が再びそろっても閉じた状態で出る', async () => {
  const html = readWebPage();
  const helpers = sourceBetween(html, 'function element(tag, className, text)', 'function durationLabel');
  const component = sourceBetween(html, 'const MERGE_METHOD_LABELS', 'function appendPullRequestBlock');
  const action = sourceBetween(html, 'function findPullRequestMergeTarget', 'async function runSessionAction');
  assert.ok(helpers && component && action);
  class FakeElement {
    constructor(tagName) {
      Object.assign(this, { tagName, children: [], dataset: {}, attributes: {}, handlers: {}, className: '', textContent: '', disabled: false });
    }
    append(...nodes) { this.children.push(...nodes); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { this.handlers[name] = handler; }
  }
  const flatten = (node) => [node, ...(node.children || []).flatMap(flatten)];
  const uiKey = 'example/project#42';
  const pullRequestWith = (conflict) => ({
    mergeSessionId: null, number: 42, title: 'Feature PR', url: 'https://github.com/example/project/pull/42',
    conflictRequestKey: 'a'.repeat(64), headRefOid: 'b'.repeat(40), headRefName: 'feature/conflict',
    effectiveBase: 'main', baseRefName: 'main', conflict, canMerge: false, children: [],
    conflictRequestTargets: [{ sessionId: 'session-pr', alive: true }],
  });
  const groupWith = ({ conflict = true, listed = true, error = null } = {}) => ({
    owner: 'example', repo: 'project', defaultBranch: 'main', mergeMethods: [], error, unregisterableCount: error ? 1 : 0,
    trees: listed ? [pullRequestWith(conflict)] : [],
  });
  const states = [];
  let etag = 0;
  let rendered = [];
  const conflictInFlight = new Set();
  const context = pageContext(html, {
    document: { createElement: (tagName) => new FakeElement(tagName), createTextNode: (text) => ({ textContent: text }), addEventListener() {} },
    pullRequestMergeConfirmations: new Map(), pullRequestMergeOptions: new Map(), pullRequestMergeMessages: new Map(), queuedPullRequestMerges: new Map(),
    queuedPullRequestMerge: () => null, pullRequestMergeInFlight: new Set(), pullRequestResultUnconfirmed: () => false, pullRequestUnconfirmedResults: new Map(),
    pullRequestReservationPending: new Map(), actionFocusRestores: new Map(), rememberActionFocus() {},
    pullRequestConflictConfirmations: new Set(), pullRequestConflictMessages: new Map(), pullRequestConflictInFlight: conflictInFlight,
    repositoryUnregisterConfirmations: new Map(), focusRepositoryUnregister() {},
    appendPullRequestBadges() {}, crossReviewState: () => ({}), pullRequestTransientNoticeExpired: () => false,
    fetchUi: async () => {
      const state = states.shift();
      etag += 1;
      return { ok: true, status: 200, headers: { get: () => `"${etag}"` }, json: async () => state };
    },
    checkUiVersion: () => false, syncDisplayPreferences: async () => {}, updateConnectionNote() {}, hasUnsentAnswerDraft: () => false,
    applyAwayState() {}, applyUpdateState() {}, applyDoctorState() {}, renderRestartNote() {}, renderPersistenceNote() {}, applyAppVersion() {},
    refreshConfirmPending: false, refreshSequence: 0, appliedRefreshSequence: 0, pendingStateReads: 0,
    pullRequestExpirySignature: () => '', renderedPullRequestExpirySignature: '',
    lastVersion: 1, lastState: null, lastStateEtag: null, liveStatus: { textContent: '' }, reportWebFailure() {}, hasRenderedState: true, connectionLost: false, lastStateAt: null, completedDisplaySaves: 0,
    render(state) {
      const root = new FakeElement('div');
      for (const group of state.pullRequests) {
        context.appendPullRequestError(root, group);
        for (const pullRequest of group.trees) context.appendPullRequestTree(root, group, reviewPr(pullRequest));
      }
      rendered = flatten(root);
    },
  });
  context.AbortSignal = { timeout: () => ({}) };
  vm.runInContext([helpers, component, action, functionSource(html, 'appendPullRequestError'), functionSource(html, 'refresh')].join('\n'), context);
  const showState = async (group) => {
    states.push({ version: 1, sessions: [{ session_id: 'session-pr', title: 'worker' }], pullRequests: [group] });
    assert.equal(await context.refresh(), true);
  };
  const conflictOpen = () => rendered.find((node) => node.dataset?.conflictOpen === uiKey);
  const conflictConfirmationShown = () => rendered.some((node) => node.dataset?.conflictGo === uiKey);
  const unregisterOpen = () => rendered.find((node) => node.dataset?.repoUnregister === 'example/project' && node.dataset.repoUnregisterAction === 'open');

  for (const lost of [{ conflict: false }, { listed: false }]) {
    await showState(groupWith());
    context.pullRequestConflictConfirmations.add(uiKey);
    context.pullRequestConflictMessages.set(uiKey, { message: '依頼のエラー', shownAt: Date.now() });
    await showState(groupWith());
    assert.equal(conflictConfirmationShown(), true);
    await showState(groupWith(lost));
    await showState(groupWith());
    assert.equal(conflictConfirmationShown(), false, JSON.stringify(lost));
    assert.equal(conflictOpen().disabled, false, JSON.stringify(lost));
    assert.equal(context.pullRequestConflictMessages.has(uiKey), false);
  }

  context.pullRequestConflictConfirmations.add(uiKey);
  conflictInFlight.add(uiKey);
  await showState(groupWith({ conflict: false }));
  assert.equal(context.pullRequestConflictConfirmations.has(uiKey), true);
  conflictInFlight.delete(uiKey);
  await showState(groupWith({ conflict: false }));
  assert.equal(context.pullRequestConflictConfirmations.has(uiKey), false);

  await showState(groupWith({ error: '取得できません' }));
  unregisterOpen().handlers.click();
  await showState(groupWith({ error: '取得できません' }));
  assert.equal(unregisterOpen(), undefined);
  await showState(groupWith());
  await showState(groupWith({ error: '取得できません' }));
  assert.ok(unregisterOpen());
});

test('導入の点検の HTML と CSS と共通の描画はモックと一致する', () => {
  assert.equal(pageHtml.match(/<dialog class="diagnostics-dialog doctor-dialog"[^]*?<\/dialog>/)[0],
    mockHtml.match(/<dialog class="diagnostics-dialog doctor-dialog"[^]*?<\/dialog>/)[0]);
  assert.deepEqual(pageHtml.split('\n').filter(line => line.startsWith('.doctor-')),
    mockHtml.split('\n').filter(line => line.startsWith('.doctor-')));
  assert.deepEqual(pageHtml.split('\n').filter(line => line.startsWith('const esc = ')),
    mockHtml.split('\n').filter(line => line.startsWith('const esc = ')));
  for (const name of ['doctorIsStale', 'doctorSummaryText', 'doctorActionText', 'doctorItemHtml',
    'renderDoctorDialog', 'copyDoctorPrompt', 'renderDoctorNote', 'renderRestartNote']) {
    assert.equal(functionSource(pageHtml, name), functionSource(mockHtml, name).replaceAll('DATA.doctor', 'doctorState'), name);
  }
});

test('点検の項目の案内は、理由の文に含まれる手作業の案内を繰り返さない', () => {
  const context = pageContext(pageHtml, {});
  vm.runInContext(functionSource(pageHtml, 'doctorActionText'), context);
  const guidance = 'docs/setup.md の「更新するとき」を確かめてください。';
  assert.equal(context.doctorActionText({ reason: `照会できませんでした。 ${guidance}`,
    actions: [{ op: 'manual', text: guidance }] }), '');
  assert.equal(context.doctorActionText({ reason: 'フックが違います。',
    actions: [{ op: 'json-replace' }, { op: 'manual', text: '/hooks で信頼し直してください。' }] }),
  'update-tools スキルで直せます。 /hooks で信頼し直してください。');
});

for (const [label, source] of [['画面', pageHtml], ['モック', mockHtml]]) {
  test(`${label}の点検通知は不一致だけを示し、点検中と再起動待ちと更新前の結果では隠す`, () => {
    const span = { textContent: '' };
    const note = { hidden: true, querySelector: () => span };
    const context = pageContext(source, { document: { getElementById: () => note } });
    vm.runInContext(['doctorIsStale', 'renderDoctorNote'].map(name => functionSource(source, name)).join('\n'), context);
    for (const [doctor, restartRequired, hidden] of [
      [{ summary: { mismatch: 2 } }, false, false], [{ summary: { mismatch: 0 } }, false, true],
      [{ summary: { mismatch: 2 }, running: true }, false, true], [{ summary: { mismatch: 2 } }, true, true],
      [{ summary: { mismatch: 2 }, generatedAt: '2026-10-20', staleBefore: '2026-10-21' }, false, true],
    ]) {
      context.renderDoctorNote({ doctor, restartRequired });
      assert.equal(note.hidden, hidden);
      assert.equal(span.textContent, hidden ? '' : '導入の点検で、直す必要のある項目が 2 件見つかりました。');
    }
  });

  test(`${label}の点検の依頼文は不一致の ID だけを含み、コピーできないときは選択する`, async () => {
    const status = {};
    const field = { focus() { this.focused = true; }, select() { this.selected = true; } };
    let written;
    const context = pageContext(source, { doctorResult: { items: [{ id: 'a', result: 'mismatch' }, { id: 'b', result: 'ok' }] },
      document: { getElementById: id => id === 'doctor-copy-status' ? status : field },
      navigator: { clipboard: { writeText: async text => { written = text; } } } });
    vm.runInContext(functionSource(source, 'copyDoctorPrompt'), context);
    await context.copyDoctorPrompt();
    assert.equal(written, '/update-tools スキルで、導入の点検の不一致を直してください。対象: a');
    assert.equal(field.hidden, true);
    context.navigator.clipboard = null;
    await context.copyDoctorPrompt();
    assert.equal(field.value, written);
    assert.equal(field.hidden, false);
    assert.equal(field.selected, true);
    assert.equal(field.focused, true);
  });
}

test('点検のダイアログは全文を取得し、更新前の結果なら点検し直す', async () => {
  const fields = new Map(['doctor-copy-status', 'doctor-prompt'].map(id => [id, {}]));
  let loaded = 0;
  let checked = 0;
  const context = pageContext(pageHtml, { document: { getElementById: id => fields.get(id) },
    doctorState: { generatedAt: '2026-10-20', staleBefore: '2026-10-21' },
    doctorDialog: { open: false, showModal() { this.open = true; } }, renderDoctorDialog() {},
    loadDoctorResult: async () => { loaded += 1; }, runDoctorCheck: async () => { checked += 1; } });
  vm.runInContext(['doctorIsStale', 'openDoctorDialog'].map(name => functionSource(pageHtml, name)).join('\n'), context);
  await context.openDoctorDialog();
  assert.equal(context.doctorDialog.open, true);
  assert.equal(loaded, 1);
  assert.equal(checked, 1);
  context.doctorState.staleBefore = null;
  await context.openDoctorDialog();
  assert.equal(loaded, 2);
  assert.equal(checked, 1);
});

test('点検の全文を取得できなければ前の項目を消し、要約と同じ点検の全文が取れるまで取り直す', async () => {
  let response = { ok: false };
  let fetches = 0;
  const context = pageContext(pageHtml, { doctorLoading: null, doctorChecking: null,
    doctorResult: { generatedAt: 'before', items: [{ id: 'old', result: 'mismatch' }] },
    doctorState: { generatedAt: 'after', error: null },
    doctorDialog: { open: true }, renderDoctorDialog() {}, renderDoctorNote() {},
    fetch: async () => { fetches += 1; return { ok: response.ok, json: async () => response.body }; } });
  vm.runInContext(['loadDoctorResult', 'applyDoctorState'].map(name => functionSource(pageHtml, name)).join('\n'), context);
  await context.loadDoctorResult();
  assert.equal(context.doctorResult, null);
  assert.equal(context.doctorState.error, 'FETCH_FAILED');
  response = { ok: true, body: { generatedAt: 'after', items: [] } };
  context.applyDoctorState({ doctor: { generatedAt: 'after', error: null } });
  await context.doctorLoading;
  assert.equal(fetches, 2);
  assert.equal(context.doctorResult.generatedAt, 'after');
  context.applyDoctorState({ doctor: { generatedAt: 'after', error: null } });
  assert.equal(fetches, 2);
});

test('点検の全文の取得中に要約が新しくなったら、古い全文を採らずに取り直す', async () => {
  const bodies = [{ generatedAt: 'old', items: [{ id: 'stale', result: 'mismatch' }] }, { generatedAt: 'new', items: [] }];
  const context = pageContext(pageHtml, { doctorLoading: null, doctorResult: null,
    doctorState: { generatedAt: 'old', error: null }, renderDoctorDialog() {},
    fetch: async () => {
      const body = bodies.shift();
      context.doctorState = { generatedAt: 'new', error: null };
      return { ok: true, json: async () => body };
    } });
  vm.runInContext(functionSource(pageHtml, 'loadDoctorResult'), context);
  await context.loadDoctorResult();
  assert.equal(context.doctorResult.generatedAt, 'new');
  assert.deepEqual(bodies, []);
});

test('点検し直す操作は画面用 POST を一度だけ送り、完了後に全文を読み直す', async () => {
  let finish;
  let posts = 0;
  let loaded = 0;
  const context = pageContext(pageHtml, { doctorChecking: null, doctorLoading: null,
    doctorState: { running: false }, lastState: {}, renderDoctorDialog() {}, renderDoctorNote() {},
    loadDoctorResult: async () => { loaded += 1; },
    postUiAction: (url, body) => {
      assert.equal(url, '/api/doctor/check');
      assert.equal(JSON.stringify(body), '{}');
      posts += 1;
      return new Promise(resolve => { finish = () => resolve({ ok: true, json: async () => ({ running: false, error: null }) }); });
    } });
  vm.runInContext(functionSource(pageHtml, 'runDoctorCheck'), context);
  const pending = context.runDoctorCheck();
  assert.equal(context.runDoctorCheck(), pending);
  assert.equal(context.doctorState.running, true);
  assert.equal(posts, 1);
  finish();
  await pending;
  assert.equal(loaded, 1);
  assert.equal(context.doctorState.running, false);
});

test('点検の実行要求の失敗は前の結果を残して再試行できる表示に戻す', async () => {
  const context = pageContext(pageHtml, { doctorChecking: null, doctorState: { running: false, generatedAt: 'before' },
    lastState: {}, renderDoctorDialog() {}, renderDoctorNote() {},
    postUiAction: async () => { throw new Error('offline'); } });
  vm.runInContext(functionSource(pageHtml, 'runDoctorCheck'), context);
  await context.runDoctorCheck();
  assert.equal(context.doctorState.generatedAt, 'before');
  assert.equal(context.doctorState.error, 'CHECK_FAILED');
  assert.equal(context.doctorState.running, false);
  assert.equal(context.doctorChecking, null);
});
