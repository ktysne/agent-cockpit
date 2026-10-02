const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

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

test('PR のスタックとレビューを表示し、マージ操作は表示しない', () => {
  const source = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');
  assert.match(source, /function appendPullRequestBlock/);
  assert.match(source, /function appendPullRequestTree/);
  assert.match(source, /function reviewBlock/);
  assert.match(source, /プルリクエスト/);
  assert.match(source, /マージできる PR/);
  assert.match(source, /マージできない理由/);
  assert.doesNotMatch(source, /data-merge(?:-go)?=/);
  assert.doesNotMatch(source, /data-reserve-go=/);
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
