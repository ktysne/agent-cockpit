'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { functionSource, pageContext, sourceBetween } = require('./support/page-context');

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

  get firstElementChild() { return this.children[0] || null; }
  get childNodes() { return this.children; }

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
      if (selector === 'button' && node.tagName === 'button') return node;
      const dataAttribute = selector.match(/^\[data-([a-z0-9-]+)\]$/i);
      if (dataAttribute) {
        const property = dataAttribute[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        if (Object.hasOwn(node.dataset, property)) return node;
      }
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
  'updateCommonQuestionSubmit', 'clearSelectedCommonQuestionOption', 'appendCommonQuestions', 'commonQuestionDiagnosticsNotice',
  'countJudgments', 'renderSummary',
  'runCommonQuestionAction',
];

function createUiContext(options = {}) {
  assert.ok(filterDeclaration, 'production FILTERS declaration exists');
  const sources = FUNCTION_NAMES.map((name) => functionSource(pageHtml, name));
  assert.ok(sources.every(Boolean), 'production common-question functions exist');
  let nativeConfirmCalls = 0;
  const listeners = new Map();
  const summary = new FakeElement('div');
  const filterNote = new FakeElement('div');
  const context = pageContext(pageHtml, {
    document: {
      createElement: (tagName) => new FakeElement(tagName),
      createTextNode: (text) => new FakeText(text),
      getElementById: () => filterNote,
      querySelectorAll: () => [],
      addEventListener: (name, handler) => listeners.set(name, handler),
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
    badge: (text, className = '') => Object.assign(new FakeElement('span'), { textContent: text, className }),
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
  context.listeners = listeners;
  context.filterNote = filterNote;
  require('node:vm').runInContext(`${filterDeclaration}\n${sources.join('\n')}`, context);
  return context;
}

function loadCommonQuestionListeners(context) {
  const sources = [
    sourceBetween(pageHtml, "document.addEventListener('change', (event) => {", "\ndocument.addEventListener('input'"),
    sourceBetween(pageHtml, "document.addEventListener('input', (event) => {", "\ndocument.addEventListener('compositionstart'"),
    sourceBetween(pageHtml, "document.addEventListener('click', (event) => {", "\ndocument.addEventListener('click'"),
    sourceBetween(pageHtml, "document.addEventListener('keydown', (event) => {", "\ndocument.addEventListener('auxclick'"),
  ];
  assert.ok(sources.every(Boolean), 'production common-question event handlers exist');
  require('node:vm').runInContext(sources.join('\n'), context);
}

function commonQuestionInteractionCard() {
  const card = new FakeElement('article');
  card.className = 'common-question';
  card.dataset.sessionId = 'session-question';
  card.dataset.internalQuestionId = 'cq-interaction';
  const option = (questionId, optionId, type, checked = false) => {
    const input = new FakeElement('input');
    input.type = type;
    input.dataset.commonOption = 'true';
    input.dataset.questionId = questionId;
    input.dataset.optionId = optionId;
    input.checked = checked;
    card.append(input);
    return input;
  };
  const singleSelected = option('single', 'keep', 'radio', true);
  const singleAlternative = option('single', 'alternate', 'radio');
  const multiSelected = option('multi', 'two', 'checkbox', true);
  const freeText = new FakeElement('textarea');
  freeText.dataset.commonFreeText = 'single';
  freeText.value = '保持する入力';
  card.append(freeText);
  const submit = new FakeElement('button');
  submit.dataset.commonSubmit = 'cq-interaction';
  card.append(submit);
  return { card, singleSelected, singleAlternative, multiSelected, freeText, submit };
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

test('質問状態の取得不能と復旧の保留を異なる案内で伝える', () => {
  const context = createUiContext();
  const unavailable = context.commonQuestionDiagnosticsNotice({
    recovery: { status: 'unavailable', errorCode: 'common_question_state_unavailable' },
  });
  assert.equal(unavailable.children[0].textContent, '質問の状態を取得できません。');
  assert.equal(unavailable.children[1].textContent,
    '質問情報を読み込めないため、現在の状態を表示できません。再読み込みして確認してください。');
  assert.equal(unavailable.children[1].textContent.includes('保留'), false);

  const blocked = context.commonQuestionDiagnosticsNotice({ recovery: { state: 'blocked', code: 'question_writer_blocked' } });
  assert.equal(blocked.children[1].textContent, '保存済み質問の復旧確認が必要です。新しい送信は保留されています。');
});

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
    nativeWaits: 0,
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

test('種類別表示は数値時刻の共通質問と既存判断事項を待ち時間の長い順に描画する', () => {
  const functionNames = ['element', 'hasEffectiveAnswer', 'kindWaitTimestamp', 'kindDecisionWaitAge', 'renderKindSections'];
  const sources = functionNames.map((name) => functionSource(pageHtml, name));
  assert.ok(sources.every(Boolean));
  const now = Date.now();
  const question = { internalQuestionId: 'numeric-question', createdAt: now - 90 * 60_000 };
  const decision = { id: 'iso-decision', state: 'waiting', createdAt: new Date(now - 60 * 60_000).toISOString() };
  const session = { permissionWaits: [], decisions: [decision], commonQuestions: [question], agents: [], tasks: [] };
  const context = pageContext(pageHtml, {
    document: { createElement: (tagName) => new FakeElement(tagName) },
    displayPreferences: { hidden: [], hideFinished: true },
    expandedKindSections: new Set(),
    DEFAULT_SECTION_ORDER: ['sinceSeen', 'judgment', 'tasks', 'now', 'prs'],
    lastState: null,
    sessionReferences: (products) => products.flatMap((product) => product.sessions.map((item) => ({ product, session: item, multipleSessions: false }))),
    shownPermissions: () => [],
    appendPermissionWaits() {},
    shownActiveDecisions: (item) => item.decisions,
    appendDecisionCard: (list, item) => { const card = new FakeElement('article'); card.dataset.itemId = item.id; list.append(card); },
    shownCommonQuestions: (item) => item.commonQuestions,
    instructionComposer: () => null,
    appendCommonQuestions: (holder, item) => { const card = new FakeElement('article'); card.className = 'common-question'; card.dataset.itemId = item.commonQuestions[0].internalQuestionId; holder.append(card); },
    kindEndedDecisionEntries: () => [],
    kindEndedAgentCount: () => 0,
    hasHiddenJudgmentItems: () => false,
    sessionActivityTime: () => 0,
    mainRow: () => new FakeElement('div'),
    appendAgents() {},
    kindTodoTaskCount: () => 0,
    kindDoneTaskCount: () => 0,
    kindSection: (title, body) => ({ title, body }),
    orderedSectionKeys: (keys) => keys,
    sinceSeenBox: () => null,
    visiblePullRequestGroups: () => [],
    isFilterShown: () => false,
  });
  require('node:vm').runInContext(sources.join('\n'), context);

  const product = { sessions: [session], pullRequestGroups: [] };
  const judgment = context.renderKindSections([product]).find((section) => section.title === 'あなたの判断が必要なこと');
  assert.deepEqual(judgment.body.children.map((card) => card.dataset.itemId), ['numeric-question', 'iso-decision']);
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

test('外部解決済みで配送取消済みの質問は後続回答を保存し保留状態を示す', async () => {
  const requests = [];
  const savedQuestion = commonQuestion({
    externalResolution: true,
    deliveryState: 'cancelled_before_send',
    cancelled: false,
    lateAnswerCount: 1,
  });
  const context = createUiContext({ postUiAction: async (url, body) => {
    requests.push({ url, body });
    return { ok: true, status: 200, json: async () => ({ outcome: 'late', question: savedQuestion }) };
  } });
  const question = commonQuestion({ externalResolution: true, deliveryState: 'cancelled_before_send', cancelled: false });
  context.lastState = { sessions: [{ session_id: question.sessionId, commonQuestions: [question] }] };
  context.refresh = async () => { context.lastState.sessions[0].commonQuestions[0] = savedQuestion; };

  let card = renderQuestion(context, question);
  assert.ok(card.querySelectorAll('.common-question-note').some((note) => note.textContent === '元の質問は外部で解決済みです。ここで保存する回答は後続の指示として記録します。'));
  card.querySelectorAll('[data-common-option]').find((item) => item.dataset.optionId === 'alternate').checked = true;
  context.updateCommonQuestionSubmit(card);
  assert.equal(findData(card, 'commonSubmit').disabled, false);
  await context.runCommonQuestionAction(findData(card, 'commonSubmit'), 'answer');

  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, '/api/decisions/cq-internal-1/answer');
  assert.deepEqual(JSON.parse(JSON.stringify(requests[0].body.answers)), [{
    questionId: 'choice', optionIds: ['alternate'], freeText: null,
  }]);
  card = renderQuestion(context, savedQuestion);
  assert.equal(card.querySelector('.common-question-status').textContent, '外部で解決済みのため、元の回答の配送を停止しました。');
  assert.ok(card.querySelectorAll('.common-question-note').some((note) => note.textContent === '後続の回答を 1 件保存しました。配送は保留しています。'));
  assert.equal(findData(card, 'commonSubmit').disabled, true);
  assert.equal(context.commonQuestionDeliveryText({ ...savedQuestion, cancelled: true }), '質問は取り下げ済みです。');
  assert.equal(context.commonQuestionDeliveryText({ ...savedQuestion, cancelRequested: true }), '取消を要求しました。送信済みの回答は止められない場合があります。');
});

test('取消結果は返却された取消要求状態に沿った案内を表示する', async () => {
  for (const cancelRequested of [false, true]) {
    const question = commonQuestion();
    const context = createUiContext({ postUiAction: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ outcome: 'too_late', question: { ...question, cancelRequested } }),
    }) });
    context.lastState = { sessions: [{ session_id: question.sessionId, commonQuestions: [question] }] };
    const card = renderQuestion(context, question);
    await context.runCommonQuestionAction(findData(card, 'commonCancel'), 'cancel');
    const confirmationCard = renderQuestion(context, question);
    await context.runCommonQuestionAction(findData(confirmationCard, 'commonCancelConfirm'), 'cancel-confirm');

    const notice = context.commonQuestionNotices.get(context.commonQuestionKey(question));
    if (cancelRequested) assert.match(notice, /取消要求として記録しました/);
    else assert.doesNotMatch(notice, /要求として記録しました/);
    assert.equal(context.nativeConfirmCalls(), 0);
  }
});

test('期限と同じ推奨回答の重複は追加回答として数えず同じ送信を防ぐ', async () => {
  const question = commonQuestion();
  const duplicateQuestion = commonQuestion({
    selectionSource: 'away-default',
    selectedOptionIds: [{ questionId: 'choice', optionIds: ['recommended'] }],
    deliveryState: 'unknown',
    lateAnswerCount: 0,
  });
  const context = createUiContext({ postUiAction: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ outcome: 'duplicate', question: duplicateQuestion }),
  }) });
  context.lastState = { sessions: [{ session_id: question.sessionId, commonQuestions: [question] }] };
  context.refresh = async () => { context.lastState.sessions[0].commonQuestions[0] = duplicateQuestion; };

  const card = renderQuestion(context, question);
  card.querySelectorAll('[data-common-option]').find((item) => item.dataset.optionId === 'recommended').checked = true;
  context.updateCommonQuestionSubmit(card);
  await context.runCommonQuestionAction(findData(card, 'commonSubmit'), 'answer');

  const key = context.commonQuestionKey(question);
  assert.deepEqual(JSON.parse(JSON.stringify(context.commonQuestionSubmittedDrafts.get(key))), [{
    questionId: 'choice', optionIds: ['recommended'], freeText: '',
  }]);
  assert.equal(context.commonQuestionNotices.get(key), '同じ回答は保存済みです。追加の回答は保存していません。');
  const refreshedCard = renderQuestion(context, duplicateQuestion);
  assert.equal(refreshedCard.querySelector('.common-question-status').textContent, '配送結果が不明です。自動再送はしません。');
  assert.equal(findData(refreshedCard, 'commonSubmit').disabled, true);
  assert.equal(refreshedCard.querySelectorAll('.common-question-note').some((note) => note.textContent === '後続の回答を 0 件保存しました。配送は保留しています。'), false);
});

test('遅い別案の後の重複回答は件数と配送状態を保ち重複通知を出す', async () => {
  const question = commonQuestion({
    selectionSource: 'away-default',
    selectedOptionIds: [{ questionId: 'choice', optionIds: ['recommended'] }],
    deliveryState: 'applied',
  });
  const lateQuestion = { ...question, deliveryState: 'unknown', lateAnswerCount: 1 };
  let requestCount = 0;
  const context = createUiContext({ postUiAction: async () => {
    requestCount += 1;
    return { ok: true, status: 200, json: async () => ({
      outcome: requestCount === 1 ? 'late' : 'duplicate', question: lateQuestion,
    }) };
  } });
  context.lastState = { sessions: [{ session_id: question.sessionId, commonQuestions: [question] }] };
  context.refresh = async () => { context.lastState.sessions[0].commonQuestions[0] = lateQuestion; };

  let card = renderQuestion(context, question);
  card.querySelectorAll('[data-common-option]').find((item) => item.dataset.optionId === 'alternate').checked = true;
  context.updateCommonQuestionSubmit(card);
  await context.runCommonQuestionAction(findData(card, 'commonSubmit'), 'answer');

  card = renderQuestion(context, lateQuestion);
  card.querySelectorAll('[data-common-option]').find((item) => item.dataset.optionId === 'alternate').checked = false;
  card.querySelectorAll('[data-common-option]').find((item) => item.dataset.optionId === 'recommended').checked = true;
  context.updateCommonQuestionSubmit(card);
  await context.runCommonQuestionAction(findData(card, 'commonSubmit'), 'answer');

  const key = context.commonQuestionKey(question);
  assert.equal(requestCount, 2);
  assert.equal(lateQuestion.lateAnswerCount, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(context.commonQuestionSubmittedDrafts.get(key))), [{
    questionId: 'choice', optionIds: ['recommended'], freeText: '',
  }]);
  assert.equal(context.commonQuestionNotices.get(key), '同じ回答は保存済みです。追加の回答は保存していません。');
  card = renderQuestion(context, lateQuestion);
  assert.equal(card.querySelector('.common-question-status').textContent, '配送結果が不明です。自動再送はしません。');
  assert.ok(card.querySelectorAll('.common-question-note').some((note) => note.textContent === '後続の回答を 1 件保存しました。配送は保留しています。'));
  assert.ok(card.querySelectorAll('.common-question-note').some((note) => note.textContent === '同じ回答は保存済みです。追加の回答は保存していません。'));
  assert.equal(findData(card, 'commonSubmit').disabled, true);
});

test('送信中と結果不明の配送状態をlate件数と別に表示する', () => {
  for (const [deliveryState, status] of [
    ['sending', '送信開始済みです。返却結果を確認しています。'],
    ['unknown', '配送結果が不明です。自動再送はしません。'],
  ]) {
    const question = commonQuestion({ selectionSource: 'away-default', deliveryState, lateAnswerCount: 1 });
    const card = renderQuestion(createUiContext(), question);
    assert.equal(card.querySelector('.common-question-status').textContent, status);
    assert.ok(card.querySelectorAll('.common-question-note').some((note) => note.textContent === '後続の回答を 1 件保存しました。配送は保留しています。'));
  }
});

test('selectedの回答保存は下書きと再送防止用回答を消す', async () => {
  const question = commonQuestion();
  const context = createUiContext();
  context.lastState = { sessions: [{ session_id: question.sessionId, commonQuestions: [question] }] };
  const card = renderQuestion(context, question);
  card.querySelectorAll('[data-common-option]').find((item) => item.dataset.optionId === 'alternate').checked = true;
  context.updateCommonQuestionSubmit(card);
  const key = context.commonQuestionKey(question);
  assert.equal(context.commonQuestionDrafts.has(key), true);

  await context.runCommonQuestionAction(findData(card, 'commonSubmit'), 'answer');
  assert.equal(context.commonQuestionDrafts.has(key), false);
  assert.equal(context.commonQuestionSubmittedDrafts.has(key), false);
});

test('期限後に自動選択と競合した回答は下書きを保ち同じ回答の再保存を無効にする', async () => {
  const appliedQuestion = commonQuestion({
    selectionSource: 'away-default',
    selectedOptionIds: [{ questionId: 'choice', optionIds: ['recommended'] }],
    deliveryState: 'applied',
    lateAnswerCount: 1,
  });
  const context = createUiContext({ postUiAction: async () => ({
    ok: true,
    status: 200,
    json: async () => ({ outcome: 'late', question: appliedQuestion }),
  }) });
  const question = commonQuestion();
  context.lastState = { sessions: [{ session_id: question.sessionId, commonQuestions: [question] }] };
  context.refresh = async () => { context.lastState.sessions[0].commonQuestions[0] = appliedQuestion; };

  let card = renderQuestion(context, question);
  card.querySelectorAll('[data-common-option]').find((item) => item.dataset.optionId === 'alternate').checked = true;
  card.querySelector('[data-common-free-text]').value = 'a later instruction';
  context.updateCommonQuestionSubmit(card);
  await context.runCommonQuestionAction(findData(card, 'commonSubmit'), 'answer');

  const key = context.commonQuestionKey(question);
  assert.deepEqual(JSON.parse(JSON.stringify(context.commonQuestionSubmittedDrafts.get(key))), [{
    questionId: 'choice', optionIds: ['alternate'], freeText: 'a later instruction',
  }]);
  assert.match(context.commonQuestionNotices.get(key), /後続の回答/);
  card = renderQuestion(context, appliedQuestion);
  assert.equal(card.querySelectorAll('[data-common-option]').find((item) => item.dataset.optionId === 'alternate').checked, true);
  assert.equal(card.querySelector('[data-common-free-text]').value, 'a later instruction');
  assert.equal(findData(card, 'commonSubmit').disabled, true);

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

test('共通質問の単一選択は再クリックとSpaceで解除し、独立回答と後続回答の重複防止を保つ', () => {
  const context = createUiContext();
  const question = commonQuestion({
    internalQuestionId: 'cq-interaction',
    questions: [
      { id: 'single', text: '単一選択', mode: 'single', allowFreeText: true, options: [
        { id: 'keep', label: '維持', description: '' }, { id: 'alternate', label: '別案', description: '' },
      ] },
      { id: 'multi', text: '複数選択', mode: 'multi', allowFreeText: false, options: [
        { id: 'one', label: '一つ目', description: '' }, { id: 'two', label: '二つ目', description: '' },
      ] },
    ],
  });
  context.lastState = { sessions: [{ session_id: question.sessionId, commonQuestions: [question] }] };
  const key = context.commonQuestionKey(question);
  context.commonQuestionDrafts.set(key, [
    { questionId: 'single', optionIds: ['keep'], freeText: '保持する入力' },
    { questionId: 'multi', optionIds: ['two'], freeText: '' },
  ]);
  const controls = commonQuestionInteractionCard();
  loadCommonQuestionListeners(context);

  let prevented = false;
  context.listeners.get('click')({
    button: 1,
    target: controls.singleSelected,
    preventDefault: () => { prevented = true; },
  });
  assert.equal(controls.singleSelected.checked, false);
  assert.equal(prevented, false);
  assert.deepEqual(JSON.parse(JSON.stringify(context.commonQuestionDrafts.get(key))), [
    { questionId: 'single', optionIds: [], freeText: '保持する入力' },
    { questionId: 'multi', optionIds: ['two'], freeText: '' },
  ]);
  assert.equal(controls.submit.disabled, false);

  controls.singleSelected.checked = true;
  context.listeners.get('change')({ target: controls.singleSelected });
  prevented = false;
  context.listeners.get('keydown')({
    target: controls.singleSelected, key: ' ', code: 'Space',
    preventDefault: () => { prevented = true; },
  });
  assert.equal(controls.singleSelected.checked, false);
  assert.equal(prevented, true);
  assert.equal(context.commonQuestionDrafts.get(key)[1].optionIds[0], 'two');

  controls.singleAlternative.checked = true;
  context.listeners.get('change')({ target: controls.singleAlternative });
  const submitted = JSON.parse(JSON.stringify(context.commonQuestionDrafts.get(key)));
  context.commonQuestionSubmittedDrafts.set(key, submitted);
  context.updateCommonQuestionSubmit(controls.card);
  assert.equal(controls.submit.disabled, true);
  context.listeners.get('click')({ button: 1, target: controls.singleAlternative });
  assert.equal(controls.singleAlternative.checked, false);
  assert.equal(controls.submit.disabled, false);

  let renderCount = 0;
  context.render = () => { renderCount += 1; };
  controls.freeText.value = '日本語入力中';
  context.listeners.get('input')({ target: controls.freeText });
  assert.equal(context.commonQuestionDrafts.get(key)[0].freeText, '日本語入力中');
  assert.equal(renderCount, 0);
});
