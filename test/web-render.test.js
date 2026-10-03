const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function reloadHarness(initialUiVersion, drafts = []) {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const functions = ['renderReloadNote', 'hasUnsentAnswerDraft', 'checkUiVersion', 'reloadNow', 'decisionAnswerAvailability', 'copyAnswerPicks', 'sameAnswerPicks']
    .map((name) => html.match(new RegExp(`function ${name}\\([^)]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0]);
  assert.ok(functions.every(Boolean));

  let reloadCount = 0;
  const reloadNote = { hidden: true, innerHTML: '' };
  const context = vm.createContext({
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
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const render = html.match(/function render\(state\) \{[\s\S]*?\n\}/)?.[0];
  const renderDeferredState = html.match(/function renderDeferredState\(\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(render);
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
  const setDraft = answerDrafts.set.bind(answerDrafts);
  answerDrafts.set = (...args) => {
    answerDraftWriteCount += 1;
    return setDraft(...args);
  };
  let updatedAnswerCard = null;
  const context = vm.createContext({
    answerNoteComposing: false,
    deferredRenderPending: false,
    lastState: { sessions: [{ session_id: 'session-ui' }] },
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
    displayPreferences: { mode: 'product', pinned: [] },
    renderRouting() {},
    renderSummary() {},
    renderExcludedNote() {},
    updateTitle() {},
    orderedProducts: () => [{ key: 'product-ui' }],
    productSection: () => ({}),
  });
  vm.runInContext(`${render}\n${renderDeferredState}`, context);
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
    answerCard,
    html,
  };
}

function taskRenderHarness() {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const functions = ['element', 'appendPlanToggle', 'taskVisibility', 'appendTasks']
    .map((name) => html.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0]);
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

  const context = vm.createContext({
    document: { createElement: (tagName) => new FakeElement(tagName) },
    expandedTodoTasks: new Set(),
    expandedDoneTasks: new Set(),
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
  const harness = reloadHarness('v1', [[DRAFT_KEY, { choice: 'hold', note: '', picks: [] }]]);
  assert.equal(harness.context.checkUiVersion(answerableState()), false);
  assert.equal(harness.reloadCount, 0);
  assert.equal(harness.reloadNote.hidden, false);
  assert.equal(harness.reloadNote.innerHTML, '<span>画面が新しくなりました。書きかけの回答を送るか消すと、読み込み直します。</span><button type="button" class="link-btn" data-reload-now>今すぐ読み込み直す</button>');

  harness.context.answerDrafts.set(DRAFT_KEY, { choice: null, note: '', picks: [] });
  assert.equal(harness.context.checkUiVersion(answerableState()), true);
  assert.equal(harness.reloadCount, 1);
});

test('送った回答と同じ下書きは書きかけと数えない', () => {
  const sent = { choice: 'hold', note: 'メモ', picks: [], sentAt: '2026-10-03T00:00:00.000Z' };
  const harness = reloadHarness('v1', [[DRAFT_KEY, { choice: 'hold', note: 'メモ', picks: [] }]]);
  assert.equal(harness.context.checkUiVersion(answerableState(sent)), true);

  const changed = reloadHarness('v1', [[DRAFT_KEY, { choice: 'hold', note: '書き足し', picks: [] }]]);
  assert.equal(changed.context.checkUiVersion(answerableState(sent)), false);

  const unchecked = reloadHarness('v1', [[DRAFT_KEY, { choice: null, note: 'メモ', picks: [] }]]);
  assert.equal(unchecked.context.checkUiVersion(answerableState(sent)), true);
});

test('回答できなくなった判断事項と消えた判断事項の下書きは書きかけと数えない', () => {
  const draft = [[DRAFT_KEY, { choice: 'hold', note: '書きかけ', picks: [] }]];
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
  const harness = reloadHarness('v1', [[DRAFT_KEY, { choice: 'hold', note: '書きかけ', picks: [] }]]);
  harness.context.reloadNow({ target: { closest: (selector) => selector === '[data-reload-now]' } });
  assert.equal(harness.reloadCount, 1);
});

test('作業中ツールは表示幅を超えた部分を CSS の省略記号で示す', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');

  assert.match(source, /\.tool-content\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(source, /\.tool-content\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(source, /\.tool-content\s*\{[^}]*overflow:\s*hidden/);
  assert.match(source, /\.tool-content\s*\{[^}]*min-width:\s*0/);
  assert.match(source, /\.now-row\s*>\s*\.detail,\s*\.agent-row\s*>\s*\.detail\s*\{[^}]*min-width:\s*0/);
  assert.match(source, /\.tool-line\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(source, /\.tool-name\s*\{[^}]*flex:\s*none/);
  assert.match(mock, /\.tool-content\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.match(mock, /\.tool-content\s*\{[^}]*white-space:\s*nowrap/);
  assert.match(mock, /\.tool-content\s*\{[^}]*overflow:\s*hidden/);
  assert.match(mock, /\.tool-content\s*\{[^}]*min-width:\s*0/);
  assert.match(mock, /\.tool-line\s*\{[^}]*flex-wrap:\s*nowrap/);
  assert.match(mock, /\.tool-name\s*\{[^}]*flex:\s*none/);
  assert.doesNotMatch(mock, /\.meta\s*\{[^}]*text-overflow:\s*ellipsis/);
  assert.doesNotMatch(mock, /\.meta\s*\{[^}]*white-space:\s*nowrap/);
  assert.doesNotMatch(mock, /\.meta\s*\{[^}]*overflow:\s*hidden/);
  assert.match(mock, /\.now-row\s*\{[^}]*minmax\(0,\s*1fr\)/);
  assert.match(mock, /\.now-row\s*>\s*:nth-child\(2\)\s*\{[^}]*min-width:\s*0/);
});

test('PR のスタックにクロスレビューを表示する', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  assert.match(source, /function appendPullRequestBlock/);
  assert.match(source, /function appendPullRequestTree/);
  assert.match(source, /function crossReviewLine/);
  assert.match(source, /プルリクエスト/);
  assert.match(source, /マージできる PR/);
  assert.match(source, /マージできない理由/);
  assert.match(source, /data-merge-go/);
  assert.doesNotMatch(source, /function reviewBlock/);
  assert.doesNotMatch(source, /group\.reviews/);
  assert.doesNotMatch(source, /data-reserve-go=/);
});

test('連携が無い時は経路の欄と稼働中の経路札を表示しない', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const routingStart = html.indexOf('function routeName');
  const routingEnd = html.indexOf('\nasync function updateRouting', routingStart);
  const routeTagStart = html.indexOf('function routeTag');
  const routeTagEnd = html.indexOf('\nfunction appendModelLine', routeTagStart);
  assert.ok(routingStart >= 0 && routingEnd > routingStart);
  assert.ok(routeTagStart >= 0 && routeTagEnd > routeTagStart);

  const root = {
    innerHTML: '',
    hidden: false,
    querySelector(selector) { return selector === '.rgroup' && this.innerHTML.includes('class="rgroup"') ? {} : null; },
    querySelectorAll() { return []; },
  };
  const context = vm.createContext({
    ROUTE: {
      agents: { label: 'サブエージェント', opts: [{ v: 'default', t: '既定' }, { v: 'codex', t: 'Codex' }, { v: 'claude', t: 'Claude' }] },
      review: { label: 'クロスレビュー', opts: [{ v: 'default', t: '既定' }, { v: 'codex', t: 'Codex' }, { v: 'claude', t: 'Claude' }] },
    },
    ROUTE_VALUES: new Set(['default', 'codex', 'claude']),
    routing: { agents: 'default', review: 'default' },
    codexAgentAvailable: false,
    document: { getElementById: () => root },
    element: (_tag, className, textContent = '') => ({ className, textContent }),
  });
  vm.runInContext(`${html.slice(routingStart, routingEnd)}\n${html.slice(routeTagStart, routeTagEnd)}\nthis.renderRouting = renderRouting; this.routeTag = routeTag;`, context);

  context.renderRouting({ agents: 'codex', review: 'claude' }, { codexAgent: false });
  assert.equal(root.hidden, true);
  assert.equal(root.innerHTML, '');
  assert.equal(context.routeTag({ active: true, route: 'codex' }), null);

  context.renderRouting({ agents: 'codex', review: 'claude' }, { codexAgent: true });
  assert.equal(root.hidden, false);
  assert.equal((root.innerHTML.match(/data-route="agents"/g) || []).length, 3);
  assert.doesNotMatch(root.innerHTML, /data-route="review"|aria-describedby|未対応/);
});

test('クロスレビューの行は往復数と head の状態を表示する', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const helpersStart = html.indexOf('function element(tag, className, text)');
  const helpersEnd = html.indexOf('function durationLabel', helpersStart);
  const componentStart = html.indexOf('const MERGE_METHOD_LABELS');
  const componentEnd = html.indexOf('function appendPullRequestBlock', componentStart);
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart);
  assert.ok(componentStart >= 0 && componentEnd > componentStart);

  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
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
  const context = vm.createContext({
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
    },
  });
  vm.runInContext(`${html.slice(helpersStart, helpersEnd)}\n${html.slice(componentStart, componentEnd)}`, context);

  const textOf = (node) => node.children?.length ? node.children.map(textOf).join('') : node.textContent;
  const allNodes = (root) => [root, ...(root.children || []).flatMap(allNodes)];
  const headSha = 'a'.repeat(40);
  const line = (pullRequest) => context.crossReviewLine(pullRequest);

  const absent = { headRefOid: headSha };
  assert.equal(line(absent), null);
  assert.equal(context.crossReviewState(absent).warn, null);
  assert.match(html, /if \(pullRequest\.crossReview !== undefined\) item\.append\(crossReviewLine\(pullRequest\)\)/);

  const missing = line({ headRefOid: headSha, crossReview: null });
  const missingBadge = allNodes(missing).find((node) => node.className?.startsWith('badge'));
  assert.equal(textOf(missing), 'クロスレビュー レビュー未実施');
  assert.equal(missingBadge.className, 'badge mute');

  const changed = line({
    headRefOid: 'b'.repeat(40),
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: headSha },
  });
  const changedBadge = allNodes(changed).find((node) => node.className?.startsWith('badge'));
  assert.equal(textOf(changed), 'クロスレビュー 2 / 3 往復、非対応 1 レビューの後に変更あり (レビュー済み aaaaaaa)');
  assert.equal(changedBadge.className, 'badge warn');
  assert.ok(!textOf(changed).includes(headSha));

  const reviewed = line({
    headRefOid: headSha,
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: headSha },
  });
  const reviewedBadge = allNodes(reviewed).find((node) => node.className?.startsWith('badge'));
  assert.equal(textOf(reviewed), 'クロスレビュー 2 / 3 往復、非対応 1 この head をレビューに回した');
  assert.equal(reviewedBadge.className, 'badge mute');

  const waitingForTriage = context.crossReviewState({
    headRefOid: headSha,
    crossReview: { round: 3, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: 'b'.repeat(40), outcome: 'fixing' } },
  });
  assert.equal(waitingForTriage.text, '3 往復目の結論待ち');
  assert.equal(waitingForTriage.warn, 'クロスレビューの 3 往復目の結論がまだ出ていない');

  const fixing = context.crossReviewState({
    headRefOid: headSha,
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: headSha, outcome: 'fixing' } },
  });
  assert.equal(fixing.text, '指摘の対応中');
  assert.equal(fixing.warn, 'クロスレビューの 2 往復目の指摘に対応している途中');

  const halted = context.crossReviewState({
    headRefOid: headSha,
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: headSha, outcome: 'halted' } },
  });
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
  assert.equal(context.crossReviewState({
    headRefOid: headSha,
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: null, triage: { round: 2, sha: headSha, outcome: 'converged' } },
  }).warn, null);

  const changedAfterConvergence = context.crossReviewState({
    headRefOid: 'c'.repeat(40),
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: 'b'.repeat(64), outcome: 'converged' } },
  });
  assert.equal(changedAfterConvergence.text, '収束の後に変更あり (収束 bbbbbbb)');
  assert.equal(changedAfterConvergence.warn, 'head ccccccc はクロスレビューの収束の後に変更されている (収束は bbbbbbb)');
  const changedConvergenceLine = line({
    headRefOid: 'c'.repeat(40),
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: 'b'.repeat(64), outcome: 'converged' } },
  });
  const changedConvergenceBadge = allNodes(changedConvergenceLine).find((node) => node.className?.startsWith('badge'));
  assert.equal(changedConvergenceBadge.textContent, '収束の後に変更あり (収束 bbbbbbb)');
  assert.equal(changedConvergenceBadge.className, 'badge warn');

  const unverifiableConvergence = context.crossReviewState({
    headRefOid: 'short-sha',
    crossReview: { round: 2, max: 3, dismissed: 1, reviewedSha: headSha, triage: { round: 2, sha: headSha, outcome: 'converged' } },
  });
  assert.equal(unverifiableConvergence.text, 'head を確かめられない');
  assert.equal(unverifiableConvergence.warn, 'head を確かめられない');

  const unverifiable = line({
    headRefOid: headSha,
    crossReview: { round: 1, max: 3, dismissed: 0, reviewedSha: null },
  });
  const unverifiableBadge = allNodes(unverifiable).find((node) => node.className?.startsWith('badge'));
  assert.equal(textOf(unverifiable), 'クロスレビュー 1 / 3 往復、非対応 0 head を確かめられない');
  assert.equal(unverifiableBadge.className, 'badge mute');
  assert.ok(!textOf(unverifiable).includes('レビューの後に変更あり'));

  assert.equal(context.crossReviewState({ headRefOid: headSha }).warn, null);
});

test('マージと予約の確認欄は head がレビューの後に変わったか記録が無ければ警告を先頭に出し、一致していれば PR のコメントで確かめる一言を出す', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const helpersStart = html.indexOf('function element(tag, className, text)');
  const helpersEnd = html.indexOf('function durationLabel', helpersStart);
  const componentStart = html.indexOf('const MERGE_METHOD_LABELS');
  const componentEnd = html.indexOf('function appendPullRequestBlock', componentStart);

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
  const context = vm.createContext({
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
    },
    pullRequestMergeOptions: new Map(),
    pullRequestMergeInFlight: new Set(),
  });
  vm.runInContext(`${html.slice(helpersStart, helpersEnd)}\n${html.slice(componentStart, componentEnd)}`, context);

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
    context.appendPullRequestMergeConfirmation(target, group, pullRequest, automatic);
    return target.children[0].children.find((node) => node.className === 'effects').children;
  };
  const changedReview = { round: 1, max: 3, dismissed: 0, reviewedSha: 'b'.repeat(40) };
  for (const automatic of [false, true]) {
    const effects = confirmation(automatic, changedReview);
    assert.equal(effects[0].className, 'warn');
    assert.equal(effects[0].textContent, 'head aaaaaaa はクロスレビューの後に変更されている (レビュー済みは bbbbbbb)');

    const reviewedEffects = confirmation(automatic, {
      round: 1, max: 3, dismissed: 0, reviewedSha: headSha,
    });
    assert.equal(reviewedEffects[0].className, '');
    assert.equal(reviewedEffects[0].textContent, 'クロスレビューはこの head で回した。指摘が残っていないかは PR のコメントで確かめる。');
    assert.match(reviewedEffects[1].textContent, /^head が /);
  }
  const missingReviewEffects = confirmation(false, null);
  assert.equal(missingReviewEffects[0].className, 'warn');
  assert.equal(missingReviewEffects[0].textContent, 'クロスレビューの記録が無い');
  const absentReviewEffects = confirmation(false, undefined);
  assert.equal(absentReviewEffects[0].className, '');
  assert.doesNotMatch(absentReviewEffects[0].textContent, /クロスレビュー|head を確かめられない/);
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
  assert.equal(convergedEffects[0].className, '');
  assert.equal(convergedEffects[0].textContent, 'クロスレビューはこの head で収束した (2 往復目)');
  const changedConvergenceEffects = confirmation(false, {
    round: 2, max: 3, dismissed: 0, reviewedSha: headSha,
    triage: { round: 2, sha: 'b'.repeat(40), outcome: 'converged' },
  });
  assert.equal(changedConvergenceEffects[0].className, 'warn');
  assert.equal(changedConvergenceEffects[0].textContent, 'head aaaaaaa はクロスレビューの収束の後に変更されている (収束は bbbbbbb)');
});

test('マージできる PR の件数タグはほかの件数タグと同じ形式で表示する', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const element = html.match(/function element\(tag, className, text\) \{[\s\S]*?\n\}/)?.[0];
  const renderSummary = html.match(/function renderSummary\(sessions, pullRequestGroups = \[\]\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(element);
  assert.ok(renderSummary);

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
  }
  class FakeText {
    constructor(text) { this.textContent = text; }
  }
  const summary = new FakeElement('div');
  summary.replaceChildren = (...children) => { summary.children = children; };
  const note = new FakeElement('div');
  note.replaceChildren = (...children) => { note.children = children; };
  const context = vm.createContext({
    FILTERS: [{ key: 'prs', label: 'マージできる PR', color: 'ok' }],
    summary,
    displayPreferences: { hidden: [] },
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
      getElementById: () => note,
    },
    pullRequestMergeableCount: () => 4,
    isPendingDecision: () => false,
    isHeldDecision: () => false,
    hasEffectiveAnswer: () => false,
  });
  vm.runInContext(`${element}\n${renderSummary}`, context);
  context.renderSummary([], []);

  const chip = summary.children[0];
  assert.equal(chip.children[0].textContent, 'マージできる PR ');
  assert.equal(chip.children[1].textContent, '4');
  assert.equal(chip.children.map((node) => node.textContent).join(''), 'マージできる PR 4');
});

test('プロダクト別と種類別に前回見てからを表示し、新しい判断に印を付ける', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const productSection = source.match(/function productSection\(product,[\s\S]*?\n\}/)?.[0];
  const renderKindSections = source.match(/function renderKindSections\(products\) \{[\s\S]*?\n\}/)?.[0];
  const appendDecisionCard = source.match(/function appendDecisionCard\([\s\S]*?\n\}/)?.[0];
  const markProductSeen = source.match(/async function markProductSeen\(button\) \{[\s\S]*?\n\}/)?.[0];

  assert.ok(productSection);
  assert.ok(renderKindSections);
  assert.ok(appendDecisionCard);
  assert.ok(markProductSeen);
  assert.match(productSection, /sinceSeenBox\(product, false\)/);
  assert.match(renderKindSections, /sinceSeenBox\(product, true\)/);
  assert.match(source, /前回見てから \(\$\{entry\.items\.length\} 件\)/);
  assert.match(source, /seen\.dataset\.seen = product\.key/);
  assert.match(source, /postUiAction\('\/api\/seen'/);
  assert.match(markProductSeen, /generatedAt: lastState\?\.generatedAt/);
  assert.match(appendDecisionCard, /if \(decision\.isNew\) header\.append\(badge\('新着', 'new-mark'\)\)/);
});

test('履歴だけのプロダクトも稼働中の一覧と同じ順で上下に動かせる', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const functions = ['productGroups', 'sessionActivityTime', 'orderedProducts'].map((name) => (
    source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0]
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
    pullRequests: [{ product: { key: 'pull-request-only', name: 'PR のみ' }, owner: 'example', repo: 'project' }],
    sinceSeen: [{ product: { key: 'history-only', name: '履歴のみ' }, items: [{ text: '完了' }] }],
  };
  const saved = [];
  let handleClick;
  const context = vm.createContext({
    displayPreferences,
    lastState: state,
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

  assert.deepEqual(displayPreferences.order, ['history-only', 'hidden', 'active', 'pull-request-only']);
  assert.deepEqual(saved.map((patch) => ({ order: [...patch.order] })), [
    { order: ['history-only', 'hidden', 'active', 'pull-request-only'] },
  ]);

  saved.length = 0;
  button.dataset.productKey = 'missing';
  assert.doesNotThrow(() => handleClick({ target: button }));
  assert.deepEqual(saved, []);
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
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const render = html.match(/function render\(state\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(render);
  let activeElement;
  const pickData = {
    answerPick: 'true', sessionId: 'session-ui', decisionId: 'decision-ui',
    answerQuestion: '1', answerOption: '2',
  };
  const activePick = { dataset: pickData, hasAttribute: () => false };
  const replacementPick = { dataset: { ...pickData }, focused: false, focus() { this.focused = true; activeElement = this; } };
  activeElement = activePick;
  const context = vm.createContext({
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
    displayPreferences: { mode: 'product', pinned: [] },
    renderRouting() {},
    renderSummary() {}, renderExcludedNote() {}, updateTitle() {},
    orderedProducts: () => [{ key: 'product-ui' }],
    productSection: () => ({}),
  });
  vm.runInContext(render, context);
  context.render(context.lastState);

  assert.equal(replacementPick.focused, true);
  assert.equal(activeElement, replacementPick);
});

test('選択肢を押すと送る答えが表示され、回答を送るが有効になる', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const functionNames = [
    'answerDraftKey', 'answerDraftFor', 'emptyAnswerPicks', 'copyAnswerPicks', 'sameAnswerPicks',
    'displayRecommendedLabel', 'recommendedOptionsForQuestions', 'selectedAnswerLabels',
    'answerMetaText', 'canSendDecisionAnswer', 'updateAnswerSubmit',
  ];
  const functions = functionNames.map((name) => html.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0]);
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
  const meta = { textContent: '' };
  const error = { textContent: '' };
  const answerChoices = [{ checked: true }, { checked: true }];
  const card = {
    dataset: { sessionId: 'session-ui', decisionId: 'decision-ui' },
    querySelector(selector) {
      if (selector === '[data-send-answer]') return button;
      if (selector === '[data-answer-meta]') return meta;
      if (selector === '.answer-error') return error;
      return null;
    },
    querySelectorAll(selector) {
      return selector === '[data-answer-choice]' ? answerChoices : [];
    },
  };
  const pick = {
    type: 'radio', checked: true,
    dataset: {
      sessionId: 'session-ui', decisionId: 'decision-ui', answerQuestion: '0', answerOption: '1',
    },
    closest(selector) {
      if (selector === '[data-answer-choice]') return null;
      if (selector === '[data-answer-pick]') return this;
      if (selector === '.decision-card') return { querySelector: (inner) => (inner === '.decision-answer' ? card : null) };
      return null;
    },
  };
  let handleChange;
  const context = vm.createContext({
    answerDrafts,
    findDecision: () => decision,
    document: { addEventListener: (name, handler) => { if (name === 'change') handleChange = handler; } },
  });
  vm.runInContext(`${functions.join('\n')}\n${changeHandler}`, context);
  handleChange({ target: pick });

  assert.equal(answerDrafts.get(key).choice, 'pick');
  assert.equal(JSON.stringify(answerDrafts.get(key).picks), '[["CSV"]]');
  assert.equal(meta.textContent, '送る答え: CSV');
  assert.equal(button.disabled, false);
  assert.deepEqual(answerChoices.map((choice) => choice.checked), [false, false]);
  assert.equal(error.textContent, '');
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
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const helpersStart = html.indexOf('function element(tag, className, text)');
  const helpersEnd = html.indexOf('function durationLabel', helpersStart);
  const componentStart = html.indexOf('const MERGE_METHOD_LABELS');
  const componentEnd = html.indexOf('function appendPullRequestBlock', componentStart);
  const actionStart = html.indexOf('function findPullRequestMergeTarget');
  const actionEnd = html.indexOf('async function runSessionAction', actionStart);
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart);
  assert.ok(componentStart >= 0 && componentEnd > componentStart);
  assert.ok(actionStart >= 0 && actionEnd > actionStart);

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
    headRefOid: 'abc123', headRefName: 'feature/pr-42', effectiveBase: 'main', canMerge: true,
    isCrossRepository: true,
    blocker: null, review: 'approved', children: [], stackPosition: { depth: 1, total: 1 },
  };
  const group = {
    owner: 'acme', repo: 'widget', defaultBranch: 'main', mergeMethods: ['merge', 'squash', 'rebase'],
    lastMethod: 'merge', trees: [pullRequest],
  };
  const context = vm.createContext({
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
    },
    pullRequestMergeConfirmations: new Map([[key, 'merge']]),
    pullRequestMergeOptions: new Map([[key, { method: 'rebase', deleteBranch: false }]]),
    pullRequestMergeMessages: new Map(),
    pullRequestMergeInFlight: new Set(),
    lastState: { pullRequests: [group] },
    appendPullRequestBadges() {},
    pullRequestTimeLabel: () => '時刻不明',
    postUiAction: async (url, body) => {
      sent.push({ url, body });
      return { ok: true, json: async () => ({}) };
    },
    refresh: async () => {},
    render() {},
    liveStatus: { textContent: '' },
  });
  const source = [
    html.slice(helpersStart, helpersEnd),
    html.slice(componentStart, componentEnd),
    html.slice(actionStart, actionEnd),
  ].join('\n');
  vm.runInContext(source, context);

  const root = new FakeElement('div');
  context.appendPullRequestTree(root, group, pullRequest);
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

  await context.runPullRequestMergeAction({ dataset: { mergeGo: key } }, 'merge');
  assert.equal(JSON.stringify(sent), JSON.stringify([{
    url: '/api/pull-requests/merge',
    body: { number: 42, registration_key: key, headRefOid: 'abc123', method: 'rebase', deleteBranch: false },
  }]));
});

test('GitHub がブランチを自動削除する確認欄はチェックを隠してマージと予約に false を送る', async () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const helpersStart = html.indexOf('function element(tag, className, text)');
  const helpersEnd = html.indexOf('function durationLabel', helpersStart);
  const componentStart = html.indexOf('const MERGE_METHOD_LABELS');
  const componentEnd = html.indexOf('function appendPullRequestBlock', componentStart);
  const actionStart = html.indexOf('function findPullRequestMergeTarget');
  const actionEnd = html.indexOf('async function runSessionAction', actionStart);
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart);
  assert.ok(componentStart >= 0 && componentEnd > componentStart);
  assert.ok(actionStart >= 0 && actionEnd > actionStart);

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
  const key = 'e'.repeat(64);
  const pullRequest = {
    mergeSessionId: 'session-pr', number: 42, title: 'Feature PR', url: 'https://github.com/acme/widget/pull/42',
    mergeRecordKey: key, headRefOid: 'abc123', headRefName: 'feature/pr-42', effectiveBase: 'main', canMerge: true,
    isCrossRepository: false, blocker: null, review: 'approved', children: [], stackPosition: { depth: 1, total: 1 },
  };
  const group = {
    owner: 'acme', repo: 'widget', defaultBranch: 'main', autoDeleteBranch: true,
    mergeMethods: ['merge', 'squash'], lastMethod: 'merge', trees: [pullRequest],
  };
  const context = vm.createContext({
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
    },
    pullRequestMergeOptions: new Map([[key, { method: 'merge', deleteBranch: true }]]),
    pullRequestMergeConfirmations: new Map(),
    pullRequestMergeMessages: new Map(),
    pullRequestMergeInFlight: new Set(),
    lastState: { pullRequests: [group] },
    appendPullRequestBadges() {},
    pullRequestTimeLabel: () => '時刻不明',
    postUiAction: async (url, body) => {
      sent.push({ url, body });
      return { ok: true, json: async () => ({}) };
    },
    refresh: async () => {},
    render() {},
    liveStatus: { textContent: '' },
  });
  const source = [
    html.slice(helpersStart, helpersEnd),
    html.slice(componentStart, componentEnd),
    html.slice(actionStart, actionEnd),
  ].join('\n');
  vm.runInContext(source, context);

  const flatten = (root) => {
    const nodes = [root];
    for (const child of root.children || []) nodes.push(...flatten(child));
    return nodes;
  };
  const mergeRoot = new FakeElement('div');
  const reserveRoot = new FakeElement('div');
  context.appendPullRequestMergeConfirmation(mergeRoot, group, pullRequest, false);
  context.appendPullRequestMergeConfirmation(reserveRoot, group, pullRequest, true);
  const mergeNodes = flatten(mergeRoot);
  const reserveNodes = flatten(reserveRoot);
  const effectText = 'リモートのブランチ feature/pr-42 は GitHub が自動で削除する (リポジトリの設定)';
  assert.equal(mergeNodes.some((node) => node.type === 'checkbox'), false);
  assert.equal(reserveNodes.some((node) => node.type === 'checkbox'), false);
  assert.ok(mergeNodes.some((node) => node.textContent === effectText));
  assert.ok(reserveNodes.some((node) => node.textContent === effectText));
  const mergeButton = mergeNodes.find((node) => node.dataset?.mergeGo === key);
  const reserveButton = reserveNodes.find((node) => node.dataset?.reserveGo === key);
  assert.ok(mergeButton);
  assert.ok(reserveButton);

  await context.runPullRequestMergeAction(mergeButton, 'merge');
  await context.runPullRequestMergeAction(reserveButton, 'reserve');

  assert.deepEqual(JSON.parse(JSON.stringify(sent)), [
    {
      url: '/api/pull-requests/merge',
      body: { number: 42, registration_key: key, headRefOid: 'abc123', method: 'merge', deleteBranch: false },
    },
    {
      url: '/api/pull-requests/reserve',
      body: { number: 42, registration_key: key, headRefOid: 'abc123', method: 'merge', deleteBranch: false },
    },
  ]);
});

test('マージ済み一覧に予約時と異なる SHA の警告を表示する', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const element = html.match(/function element\(tag, className, text\) \{[\s\S]*?\n\}/)?.[0];
  const appendBlock = html.match(/function appendPullRequestBlock\(target, group, withTag = false\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(element);
  assert.ok(appendBlock);

  class FakeElement {
    constructor(tagName) { this.tagName = tagName; this.children = []; this.className = ''; this.textContent = ''; }
    append(...nodes) { this.children.push(...nodes); }
  }
  class FakeText {
    constructor(text) { this.textContent = text; }
  }
  const context = vm.createContext({
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
    },
    pullRequestTimeLabel: () => '1 分前',
    MERGE_METHOD_LABELS: { squash: 'スカッシュ' },
  });
  vm.runInContext(`${element}\n${appendBlock}`, context);
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
  assert.match(visibleText, new RegExp(reservedSha));
  assert.match(visibleText, new RegExp(mergedSha));
});

test('マージ操作ボタンにフォーカスがある描き直しでは同じボタンへ戻す', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const render = html.match(/function render\(state\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(render);

  for (const [kind, dataAttribute, htmlAttribute] of [
    ['merge-go', 'mergeGo', 'data-merge-go'],
    ['merge-cancel', 'mergeCancel', 'data-merge-cancel'],
    ['merge-reserve-go', 'reserveGo', 'data-reserve-go'],
    ['merge-cancel-reservation', 'cancelReservation', 'data-cancel-reservation'],
    ['merge-open', 'openMerge', 'data-open-merge'],
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
    const context = vm.createContext({
      answerNoteComposing: false,
      lastState: { sessions: [{ session_id: 'session-ui' }] },
      HTMLTextAreaElement: class FakeTextArea {},
      document: { get activeElement() { return activeElement; }, querySelectorAll: () => [] },
      root: { replaceChildren: () => { activeElement = null; }, querySelectorAll: () => [replacementButton] },
      displayPreferences: { mode: 'product', pinned: [] },
      renderRouting() {},
      renderSummary() {}, renderExcludedNote() {}, updateTitle() {},
      orderedProducts: () => [{ key: 'product-ui' }],
      productSection: () => ({}),
    });
    vm.runInContext(render, context);
    context.render(context.lastState);

    assert.equal(replacementButton.focused, true, kind);
    assert.equal(activeElement, replacementButton, kind);
  }
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

test('種類別では未着手の合計数を一つのボタンで切り替える', () => {
  const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  const functions = ['element', 'taskVisibility', 'kindTodoTaskCount', 'kindDoneTaskCount', 'appendKindTaskSession', 'kindToggleLabel', 'appendKindToggle']
    .map((name) => html.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0]);
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

  const context = vm.createContext({
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
