'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { functionSource, pageContext } = require('./support/page-context');

const pageHtml = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8').replace(/\r\n/g, '\n');
const filterDeclaration = pageHtml.match(/^const FILTERS = \[[\s\S]*?^\];/m)?.[0];

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName.toLowerCase();
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this.className = '';
    this.textContent = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }

  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }

  setAttribute(name, value) { this.attributes[name] = String(value); }
  addEventListener() {}
  focus() {}

  closest(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (selector.startsWith('.') && node.className.split(/\s+/).includes(selector.slice(1))) return node;
    }
    return null;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }

  querySelectorAll(selector) {
    const selectors = selector.split(',').map((item) => item.trim());
    const matches = (node, candidate) => {
      if (candidate === 'input' || candidate === 'textarea') return node.tagName === candidate;
      if (candidate.startsWith('.')) return node.className.split(/\s+/).includes(candidate.slice(1));
      const dataAttribute = candidate.match(/^\[data-([a-z0-9-]+)\]$/i);
      if (dataAttribute) {
        const property = dataAttribute[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        return Object.hasOwn(node.dataset, property);
      }
      return false;
    };
    const found = [];
    const visit = (node) => {
      for (const child of node.children || []) {
        if (selectors.some((candidate) => matches(child, candidate))) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }
}

class FakeText {
  constructor(text) { this.textContent = text; this.children = []; }
}

const FUNCTION_NAMES = [
  'element', 'hasEffectiveAnswer', 'isActiveDecision', 'isPendingDecision', 'isAwaitingDecision',
  'commonQuestionKey', 'isFinishedCommonQuestion', 'isFilterShown', 'shownCommonQuestions',
  'commonQuestionDraft', 'commonQuestionDeliveryText', 'commonQuestionSelectedLabels',
  'sameCommonQuestionAnswers', 'commonQuestionAnswersValid', 'readCommonQuestionDraft',
  'updateCommonQuestionSubmit', 'appendCommonQuestions', 'countJudgments', 'renderSummary',
  'runCommonQuestionAction',
];

function createUiContext(options = {}) {
  assert.ok(filterDeclaration, 'production FILTERS declaration exists');
  const sources = FUNCTION_NAMES.map((name) => functionSource(pageHtml, name));
  assert.ok(sources.every(Boolean), 'production common-question functions exist');
  let nativeConfirmCalls = 0;
  const summary = new FakeElement('div');
  const filterNote = new FakeElement('div');
  const context = pageContext(pageHtml, {
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
      getElementById: () => filterNote,
      querySelectorAll: () => [],
    },
    window: { confirm: () => { nativeConfirmCalls += 1; throw new Error('native confirmation is unavailable'); } },
    confirm: () => { nativeConfirmCalls += 1; throw new Error('native confirmation is unavailable'); },
    displayPreferences: { hidden: [], hideFinished: true },
    summary,
    lastState: null,
    commonQuestionComposing: false,
    commonQuestionDrafts: new Map(),
    commonQuestionErrors: new Map(),
    commonQuestionNotices: new Map(),
    commonQuestionSubmittedDrafts: new Map(),
    commonQuestionInFlight: new Set(),
    commonQuestionCancelConfirmations: new Set(),
    appendContextTags() {},
    absoluteTimeLabel: () => '期限',
    pullRequestMergeableCount: () => 0,
    pullRequestOpenCount: () => 0,
    postUiAction: options.postUiAction || (async () => ({ ok: true, status: 200, json: async () => ({ outcome: 'selected' }) })),
    refresh: async () => {},
    render() {},
    showWriteError() {},
    liveStatus: { textContent: '' },
  });
  context.nativeConfirmCalls = () => nativeConfirmCalls;
  context.filterNote = filterNote;
  require('node:vm').runInContext(`${filterDeclaration}\n${sources.join('\n')}`, context);
  return context;
}

function commonQuestion(overrides = {}) {
  return {
    sessionId: 'session-question',
    internalQuestionId: 'cq-internal-1',
    questionId: 'native-question-1',
    executionId: 'execution-1',
    questions: [{
      id: 'choice',
      text: 'Choose an option',
      mode: 'single',
      options: [
        { id: 'recommended', label: 'Recommended', description: '' },
        { id: 'alternate', label: 'Alternate', description: '' },
      ],
      allowFreeText: true,
      recommendedOptionId: 'recommended',
    }],
    selectedOptionIds: [],
    selectionSource: null,
    deliveryState: null,
    externalResolution: false,
    lateAnswerCount: 0,
    held: false,
    cancelled: false,
    cancelRequested: false,
    deadlineAt: 1_800_000_000_000,
    ...overrides,
  };
}

function renderQuestion(context, question) {
  const body = new FakeElement('div');
  context.appendCommonQuestions(body, {
    session_id: question.sessionId,
    commonQuestions: [question],
  }, null);
  return body.querySelector('.common-question');
}

function findData(root, name, value = undefined) {
  return root.querySelectorAll(`[data-${name.replace(/[A-Z]/g, (letter) => '-' + letter.toLowerCase())}]`)
    .find((node) => value === undefined || node.dataset[name] === value) || null;
}

test('共通質問の仮選択件数と質問フィルターは既存判断事項と二重計上しない', () => {
  const context = createUiContext();
  const regular = commonQuestion({ internalQuestionId: 'regular' });
  const provisional = commonQuestion({
    internalQuestionId: 'provisional',
    selectionSource: 'away-default',
    selectedOptionIds: [{ questionId: 'choice', optionIds: ['recommended'] }],
    deliveryState: 'applied',
  });
  const session = {
    permissionWaits: [],
    agents: [],
    commonQuestions: [regular, provisional],
    decisions: [{ id: 'legacy-provisional', state: 'provisional', answer: null }],
  };

  const counts = context.countJudgments([session]);
  assert.deepEqual(JSON.parse(JSON.stringify(counts)), {
    permission: 0,
    blocking: 0,
    provisional: 2,
    questions: 1,
    questionProvisional: 1,
    decisions: 1,
    total: 3,
  });
  assert.deepEqual(context.shownCommonQuestions(session).map((item) => item.internalQuestionId), ['regular', 'provisional']);

  context.renderSummary([session]);
  const questionsChip = context.summary.children.find((item) => item.dataset.filter === 'questions');
  const provisionalChip = context.summary.children.find((item) => item.dataset.filter === 'provisional');
  assert.equal(questionsChip.children[1].textContent, '1');
  assert.equal(provisionalChip.children[1].textContent, '2');

  context.displayPreferences.hidden = ['questions'];
  assert.deepEqual(context.shownCommonQuestions(session).map((item) => item.internalQuestionId), ['provisional']);
  context.renderSummary([session]);
  assert.equal(context.filterNote.children[0].textContent, '非表示: 質問対応 (1 件)');
  context.displayPreferences.hidden = ['provisional'];
  assert.deepEqual(context.shownCommonQuestions(session).map((item) => item.internalQuestionId), ['regular']);
});

test('質問取消の最初のクリックは確認だけで、戻るは送信せず、明示確定だけ取消を送る', async () => {
  const requests = [];
  const context = createUiContext({ postUiAction: async (url, body) => {
    requests.push({ url, body });
    return { ok: true, status: 200, json: async () => ({ outcome: 'cancelled' }) };
  } });
  const question = commonQuestion();
  context.lastState = { sessions: [{ session_id: question.sessionId, commonQuestions: [question] }] };

  const initialCard = renderQuestion(context, question);
  await context.runCommonQuestionAction(findData(initialCard, 'commonCancel'), 'cancel');
  assert.equal(requests.length, 0);
  assert.equal(context.nativeConfirmCalls(), 0);

  let confirmationCard = renderQuestion(context, question);
  assert.ok(findData(confirmationCard, 'commonCancelConfirm'));
  await context.runCommonQuestionAction(findData(confirmationCard, 'commonCancelDismiss'), 'cancel-dismiss');
  assert.equal(requests.length, 0);
  assert.equal(context.nativeConfirmCalls(), 0);

  const cardBeforeSecondRequest = renderQuestion(context, question);
  await context.runCommonQuestionAction(findData(cardBeforeSecondRequest, 'commonCancel'), 'cancel');
  confirmationCard = renderQuestion(context, question);
  await context.runCommonQuestionAction(findData(confirmationCard, 'commonCancelConfirm'), 'cancel-confirm');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/decisions/cq-internal-1/cancel');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].body)), { session_id: 'session-question', execution_id: 'execution-1' });
  assert.equal(context.nativeConfirmCalls(), 0);
});

test('後続回答を保存した下書きは仮選択へ戻らず同じ回答の再保存を無効にする', async () => {
  const requests = [];
  const context = createUiContext({ postUiAction: async (url, body) => {
    requests.push({ url, body });
    return { ok: true, status: 200, json: async () => ({ outcome: 'late' }) };
  } });
  const question = commonQuestion({
    selectionSource: 'away-default',
    selectedOptionIds: [{ questionId: 'choice', optionIds: ['recommended'] }],
    deliveryState: 'applied',
  });
  context.lastState = { sessions: [{ session_id: question.sessionId, commonQuestions: [question] }] };
  let card = renderQuestion(context, question);
  let option = card.querySelectorAll('[data-common-option]').find((item) => item.dataset.optionId === 'alternate');
  let freeText = card.querySelector('[data-common-free-text]');
  option.checked = true;
  freeText.value = 'a later instruction';
  context.updateCommonQuestionSubmit(card);
  const submit = findData(card, 'commonSubmit');
  assert.equal(submit.disabled, false);

  await context.runCommonQuestionAction(submit, 'answer');
  assert.equal(requests.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].body.answers)), [{
    questionId: 'choice', optionIds: ['alternate'], freeText: 'a later instruction',
  }]);

  context.lastState.sessions[0].commonQuestions[0] = { ...question, lateAnswerCount: 1 };
  card = renderQuestion(context, context.lastState.sessions[0].commonQuestions[0]);
  option = card.querySelectorAll('[data-common-option]').find((item) => item.dataset.optionId === 'alternate');
  freeText = card.querySelector('[data-common-free-text]');
  assert.equal(option.checked, true);
  assert.equal(freeText.value, 'a later instruction');
  assert.equal(findData(card, 'commonSubmit').disabled, true);
  assert.equal(context.nativeConfirmCalls(), 0);
});

test('回答保存に失敗しても選択と自由記入の下書きを再描画後に保つ', async () => {
  const context = createUiContext({ postUiAction: async () => ({ ok: false, status: 503 }) });
  const question = commonQuestion();
  context.lastState = { sessions: [{ session_id: question.sessionId, commonQuestions: [question] }] };
  let card = renderQuestion(context, question);
  card.querySelectorAll('[data-common-option]').find((item) => item.dataset.optionId === 'alternate').checked = true;
  card.querySelector('[data-common-free-text]').value = 'keep this draft';
  context.updateCommonQuestionSubmit(card);
  await context.runCommonQuestionAction(findData(card, 'commonSubmit'), 'answer');

  card = renderQuestion(context, question);
  assert.equal(card.querySelectorAll('[data-common-option]').find((item) => item.dataset.optionId === 'alternate').checked, true);
  assert.equal(card.querySelector('[data-common-free-text]').value, 'keep this draft');
  assert.equal(card.querySelector('.common-question-error').textContent, '保存できませんでした。入力内容を保持しています。');
  assert.equal(context.nativeConfirmCalls(), 0);
});
