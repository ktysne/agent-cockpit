const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { functionSource, pageContext, sourceBetween } = require('./support/page-context');

const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');

function constSource(name) {
  const start = mock.indexOf(`const ${name} = `);
  assert.notEqual(start, -1, `${name} declaration`);
  const end = mock.indexOf(';', start);
  assert.notEqual(end, -1, `${name} declaration end`);
  return mock.slice(start, end + 1);
}

function codeFor(name) {
  const source = functionSource(mock, name);
  assert.ok(source, `${name} source`);
  return source;
}

class CommonQuestionNode {
  constructor(tagName, className = '') {
    this.tagName = tagName.toLowerCase();
    this.className = className;
    this.children = [];
    this.dataset = {};
    this.value = '';
    this.checked = false;
    this.disabled = false;
  }

  append(...nodes) {
    for (const node of nodes) {
      node.parentNode = this;
      this.children.push(node);
    }
  }

  closest(selector) {
    for (let node = this; node; node = node.parentNode) {
      if (selector.startsWith('.') && node.className.split(/\s+/).includes(selector.slice(1))) return node;
      const dataAttribute = selector.match(/^(?:(input|textarea))?\[data-([a-z0-9-]+)\]$/i);
      if (dataAttribute) {
        const property = dataAttribute[2].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
        if ((!dataAttribute[1] || node.tagName === dataAttribute[1]) && Object.hasOwn(node.dataset, property)) return node;
      }
    }
    return null;
  }

  querySelectorAll(selector) {
    const dataAttribute = selector.match(/^\[data-([a-z0-9-]+)\]$/i);
    const property = dataAttribute?.[1].replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
    const found = [];
    const visit = node => {
      for (const child of node.children) {
        if (property && Object.hasOwn(child.dataset, property)) found.push(child);
        visit(child);
      }
    };
    visit(this);
    return found;
  }

  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
}

function createHarness() {
  const session = {
    id: 'session-a', title: 'Session A', branch: 'main', status: 'busy',
    perms: [], subagents: [], tasks: [], decisions: [{ id: 'decision-a', kind: 'waiting' }],
    main: { sinceMin: 2 },
    commonQuestions: [
      {
        internalQuestionId: 'question-open', questionId: '通常質問', createdAt: Date.now() - 3 * 60_000,
        deadlineAt: new Date(Date.now() + 5 * 60_000).toISOString(), held: false, selectionSource: null,
        selectedOptionIds: [], deliveryState: null, externalResolution: false, lateAnswerCount: 0,
        cancelled: false, cancelRequested: false,
        questions: [{ id: 'choice', text: 'どちらを使いますか', mode: 'single', allowFreeText: false, recommendedOptionId: 'one', options: [
          { id: 'one', label: '一つ目', description: '' }, { id: 'two', label: '二つ目', description: '' },
        ] }],
      },
      {
        internalQuestionId: 'question-away', questionId: '離席中の質問', createdAt: Date.now() - 10 * 60_000,
        deadlineAt: new Date(Date.now() - 2 * 60_000).toISOString(), held: false, selectionSource: 'away-default',
        selectedOptionIds: [{ questionId: 'choice', optionIds: ['one'] }], deliveryState: 'applied',
        externalResolution: false, lateAnswerCount: 0, cancelled: false, cancelRequested: false,
        questions: [{ id: 'choice', text: '離席中にどうしますか', mode: 'single', allowFreeText: false, recommendedOptionId: 'one', options: [
          { id: 'one', label: '推奨', description: '' }, { id: 'two', label: '別案', description: '' },
        ] }],
      },
    ],
  };
  const product = { id: 'agent-cockpit', name: 'Agent Cockpit', sessions: [session], prs: [], news: [], repo: { loading: false } };
  const ui = {
    mode: 'product', hidden: [], hiddenSessions: [], hiddenKinds: [], deletedSessionIds: [], deletedClosedPrs: [], hideFinished: true, commonQuestionStates: {},
    answers: {}, pinned: [], collapsed: [], expandedEndedDecisions: [], expandedKindDecisions: false,
    expandedKindAgents: false, expandedKindTasks: false, expandedKindTodoTasks: false,
  };
  const summaryNodes = Object.fromEntries(['summary', 'filter-note', 'excluded-note', 'finished-note', 'idle-note']
    .map(id => [id, { hidden: true, innerHTML: '' }]));
  const sources = [
    constSource('isShown'),
    constSource('commonQuestionView'),
    constSource('commonQuestionsOf'),
    constSource('isFinishedCommonQuestion'),
    constSource('visibleCommonQuestions'),
    constSource('visiblePermissions'),
    constSource('visibleDecisions'),
    constSource('visiblePerms'),
    constSource('hasHiddenJudgmentItems'),
    constSource('effectiveDecisionState'),
    constSource('commonQuestionDraftKey'),
    constSource('allSessions'),
    mock.match(/const FILTERS = \[[\s\S]*?\n\];/)?.[0],
    constSource('activeFilters'),
    ...['answerOf', 'isActiveDecision', 'isEndedDecision', 'isAwaitingDecision', 'decisionCategory', 'ageMinutes',
      'countJudgments', 'countHidden', 'hiddenCommonQuestionsOf', 'decisionCountTitle', 'commonQuestionDraft', 'commonQuestionAnswersValid',
      'readCommonQuestionDraft', 'updateCommonQuestionSubmit', 'clearSelectedMockCommonQuestionOption', 'sameCommonQuestionAnswers',
      'commonQuestionStatus', 'commonQuestionLabels', 'commonQuestionCancelControl', 'commonQuestionCard',
      'isFinishedSession', 'visibleClosedPrs', 'finishedDeletionTargets', 'recordDeletionControls',
      'decisionSessionBlock', 'sessionBlock', 'renderProductMode', 'renderKindMode', 'renderSummary'].map(codeFor),
  ];
  assert.ok(sources.every(Boolean));

  const listeners = new Map();
  const context = pageContext(mock, {
    ui,
    DATA: { products: [product], integrations: { commonQuestions: true } },
    DEFAULT_SECTION_ORDER: ['sinceSeen', 'judgment', 'tasks', 'now', 'prs'],
    commonQuestionDrafts: new Map(), commonQuestionSubmittedDrafts: new Map(), commonQuestionInFlight: new Set(),
    commonQuestionErrors: new Map(), commonQuestionNotices: new Map(), commonQuestionCancelConfirmations: new Set(),
    recordDeletionConfirmations: new Map(), recordDeletionTargets: new Map(),
    orderedProducts: () => [product],
    sessionsByActivity: candidate => candidate.sessions,
    pendingDecisions: candidate => candidate.sessions.flatMap(item => item.decisions),
    decisionCard: () => '<article class="decision-card">legacy decision</article>',
    endedDecisionToggle: () => '',
    sharedBranch: () => '',
    orderControls: () => '',
    productCloseButton: () => '',
    newsBox: () => '',
    openPrs: () => [],
    pullRequestMergeable: () => false,
    taskSessionBlock: () => '',
    mainRow: () => '',
    agentSection: () => '',
    sessionDisplayName: candidate => candidate.title,
    instructionComposer: () => '',
    orderedSectionKeys: keys => keys,
    isBusyAgent: () => false,
    visibleSubagents: () => [],
    kindEndedDecisionEntries: () => [],
    kindEndedAgentCount: () => 0,
    kindDoneTaskCount: () => 0,
    kindTodoTaskCount: () => 0,
    kindToggle: () => '',
    reservationNoticeRows: () => '',
    prBlock: () => '',
    finishedHiddenCounts: () => ({ sessions: 0, pullRequests: 0 }),
    idleHiddenSessions: () => [],
    absoluteTimeLabel: () => '2026年10月7日 12:00',
    sessionTag: () => '<span class="session-tag">Session A</span>',
    esc: value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]),
    document: {
      title: '',
      getElementById: id => summaryNodes[id],
      addEventListener: (name, handler) => listeners.set(name, handler),
    },
    hiddenSessionsUndo: null,
  });
  vm.runInContext(sources.join('\n'), context);
  context.hasHiddenJudgmentItems = vm.runInContext('hasHiddenJudgmentItems', context);
  context.listeners = listeners;
  return { context, session, product, summaryNodes };
}

function loadMockCommonQuestionListeners(context) {
  const sources = [
    sourceBetween(mock, "document.addEventListener('click', e => {\n  const commonOption", "\ndocument.addEventListener('keydown'"),
    sourceBetween(mock, "document.addEventListener('keydown', e => {\n  if (e.key !== ' ' && e.code !== 'Space') return;", "\ndocument.addEventListener('change'"),
    `${sourceBetween(mock, "document.addEventListener('change', e => {\n  const commonOption", "\n  const instructionTarget")}\n});`,
    `${sourceBetween(mock, "document.addEventListener('input', e => {\n  const commonFreeText", "\n  const instructionDraft")}\n});`,
  ];
  assert.ok(sources.every(Boolean), 'mock common-question event handlers exist');
  vm.runInContext(sources.join('\n'), context);
}

test('モックは共通質問が未構成のとき「質問対応」のチップと共通質問を出さない', () => {
  const { context, summaryNodes } = createHarness();
  context.DATA.integrations.commonQuestions = false;
  context.renderSummary();
  assert.doesNotMatch(summaryNodes.summary.innerHTML, /質問対応/);
  assert.doesNotMatch(context.renderProductMode(), /class="common-question"/);
  context.DATA.integrations.commonQuestions = true;
  context.renderSummary();
  assert.match(summaryNodes.summary.innerHTML, /質問対応/);
});

test('モックのプロダクト表示と種類別表示は実際の共通質問カードを判断欄へ描画する', () => {
  const { context, summaryNodes } = createHarness();
  const productHtml = context.renderProductMode();
  assert.match(productHtml, /<article class="decision common-question" data-question-id="question-open"/);
  assert.match(productHtml, /<article class="decision common-question" data-question-id="question-away"/);
  assert.match(productHtml, /class="dhead"><span class="dtitle">/);
  assert.match(productHtml, /class="answer-foot">/);
  assert.doesNotMatch(productHtml, /class="common-question-(?:head|form|option|actions)"/);
  assert.doesNotMatch(productHtml, /離席中は期限後、すべての質問が単一選択で推奨案を持つ場合だけ仮選択します/);
  assert.match(productHtml, /あなたの判断が必要なこと <span class="count">\(3 件\)<\/span>/);
  assert.match(productHtml, /質問対応 \(1 件\)/);
  assert.match(productHtml, /仮に推奨案で進行中 \(1 件\)/);

  const kindHtml = context.renderKindMode();
  assert.match(kindHtml, /<article class="decision common-question" data-question-id="question-open"/);
  assert.match(kindHtml, /<article class="decision common-question" data-question-id="question-away"/);
  assert.match(kindHtml, /あなたの判断が必要なこと<span class="count">\(3 件\)<\/span>/);

  context.renderSummary();
  assert.equal(context.document.title, '(3) Agent Cockpit');
  assert.match(summaryNodes.summary.innerHTML, /data-filter="questions"[^>]*>質問対応 <strong>1<\/strong>/);
  assert.match(summaryNodes.summary.innerHTML, /data-filter="provisional"[^>]*>仮に推奨案で進行中 <strong>1<\/strong>/);
});

test('モックの隠れた質問件数は表示中の共通質問を除外する', () => {
  const { context, session } = createHarness();
  assert.equal(context.hasHiddenJudgmentItems(session), false);
  assert.equal(context.countHidden(), 0);

  context.ui.hidden = ['questions'];
  assert.equal(context.hasHiddenJudgmentItems(session), true);
  assert.equal(context.countHidden(), 1);

  context.ui.hidden = ['provisional'];
  assert.equal(context.hasHiddenJudgmentItems(session), true);
  assert.equal(context.countHidden(), 1);
});

test('外部解決後に保存した回答は配送保留中と表示し後続フォームを残す', () => {
  const { context, session, product } = createHarness();
  const question = {
    ...session.commonQuestions[0], externalResolution: true, deliveryState: 'cancelled_before_send',
    cancelled: false, lateAnswerCount: 1,
  };
  const html = context.commonQuestionCard(product, session, question);
  assert.match(html, /class="ctx common-question-status">外部で解決済みのため、元の回答の配送を停止しました。/);
  assert.match(html, /後続の回答を 1 件保存しました。配送は保留しています。/);
  assert.match(html, /元の質問は外部で解決済みです。ここで保存する回答は後続の指示として記録します。/);
  assert.equal(context.commonQuestionStatus({ ...question, cancelled: true }), '質問は取り下げ済みです。');
  assert.equal(context.commonQuestionStatus({ ...question, cancelRequested: true }), '取消要求済みです。送信開始後の回答は止められない場合があります。');
  assert.match(html, /data-common-submit="question-open"/);
});

test('モックはlate件数と送信中・結果不明の配送状態を別に表示する', () => {
  const { context, session, product } = createHarness();
  for (const [deliveryState, status] of [
    ['sending', '送信開始済みです。返却結果を確認しています。'],
    ['unknown', '配送結果が不明です。自動再送はしません。'],
  ]) {
    const question = {
      ...session.commonQuestions[1],
      deliveryState,
      lateAnswerCount: 1,
    };
    const html = context.commonQuestionCard(product, session, question);
    assert.ok(html.includes(`class="ctx common-question-status">${status}</p>`));
    assert.match(html, /後続の回答を 1 件保存しました。配送は保留しています。/);
  }
});

test('モックの単一選択は再クリックとSpaceで解除し、独立回答と重複回答の保留を保つ', () => {
  const { context, session } = createHarness();
  const question = session.commonQuestions[0];
  question.questions = [
    { id: 'single', text: '単一選択', mode: 'single', allowFreeText: true, recommendedOptionId: null, options: [
      { id: 'keep', label: '維持', description: '' }, { id: 'alternate', label: '別案', description: '' },
    ] },
    { id: 'multi', text: '複数選択', mode: 'multi', allowFreeText: false, recommendedOptionId: null, options: [
      { id: 'one', label: '一つ目', description: '' }, { id: 'two', label: '二つ目', description: '' },
    ] },
  ];
  const key = `common:${question.internalQuestionId}`;
  context.commonQuestionDrafts.set(key, [
    { questionId: 'single', optionIds: ['keep'], freeText: '保持する入力' },
    { questionId: 'multi', optionIds: ['two'], freeText: '' },
  ]);
  const card = new CommonQuestionNode('article', 'common-question');
  card.dataset.questionId = question.internalQuestionId;
  card.dataset.sessionId = session.id;
  const option = (questionId, optionId, type, checked = false) => {
    const input = new CommonQuestionNode('input');
    input.type = type;
    input.dataset.commonOption = 'true';
    input.dataset.questionId = questionId;
    input.dataset.optionId = optionId;
    input.checked = checked;
    card.append(input);
    return input;
  };
  const selected = option('single', 'keep', 'radio', true);
  const alternate = option('single', 'alternate', 'radio');
  option('multi', 'two', 'checkbox', true);
  const freeText = new CommonQuestionNode('textarea');
  freeText.dataset.commonFreeText = 'single';
  freeText.value = '保持する入力';
  card.append(freeText);
  const submit = new CommonQuestionNode('button');
  submit.dataset.commonSubmit = question.internalQuestionId;
  card.append(submit);
  loadMockCommonQuestionListeners(context);

  let prevented = false;
  context.listeners.get('click')({ target: selected, preventDefault: () => { prevented = true; } });
  assert.equal(selected.checked, false);
  assert.equal(prevented, false);
  assert.deepEqual(JSON.parse(JSON.stringify(context.commonQuestionDrafts.get(key))), [
    { questionId: 'single', optionIds: [], freeText: '保持する入力' },
    { questionId: 'multi', optionIds: ['two'], freeText: '' },
  ]);
  assert.equal(submit.disabled, false);

  selected.checked = true;
  context.listeners.get('change')({ target: selected });
  prevented = false;
  context.listeners.get('keydown')({
    target: selected, key: ' ', code: 'Space', preventDefault: () => { prevented = true; },
  });
  assert.equal(selected.checked, false);
  assert.equal(prevented, true);
  assert.equal(context.commonQuestionDrafts.get(key)[1].optionIds[0], 'two');

  alternate.checked = true;
  context.listeners.get('change')({ target: alternate });
  context.commonQuestionSubmittedDrafts.set(key, JSON.parse(JSON.stringify(context.commonQuestionDrafts.get(key))));
  context.updateCommonQuestionSubmit(card);
  assert.equal(submit.disabled, true);
  context.listeners.get('click')({ target: alternate });
  assert.equal(alternate.checked, false);
  assert.equal(submit.disabled, false);

  let renderCount = 0;
  context.render = () => { renderCount += 1; };
  freeText.value = '日本語入力中';
  context.listeners.get('input')({ target: freeText });
  assert.equal(context.commonQuestionDrafts.get(key)[0].freeText, '日本語入力中');
  assert.equal(renderCount, 0);
});

test('質問フィルターと仮選択フィルターは両方のモック表示で該当カードだけを切り替える', () => {
  const { context } = createHarness();
  for (const render of ['renderProductMode', 'renderKindMode']) {
    context.ui.hidden = ['questions'];
    let html = context[render]();
    assert.doesNotMatch(html, /data-question-id="question-open"/);
    assert.match(html, /data-question-id="question-away"/);

    context.ui.hidden = ['provisional'];
    html = context[render]();
    assert.match(html, /data-question-id="question-open"/);
    assert.doesNotMatch(html, /data-question-id="question-away"/);
  }
});
