const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { functionSource, pageContext } = require('./support/page-context');

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
    mode: 'product', hidden: [], hiddenSessions: [], hideFinished: true, commonQuestionStates: {},
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
    ...['answerOf', 'isActiveDecision', 'isEndedDecision', 'isAwaitingDecision', 'decisionCategory', 'ageMinutes',
      'countJudgments', 'countHidden', 'hiddenCommonQuestionsOf', 'decisionCountTitle', 'commonQuestionDraft', 'commonQuestionAnswersValid',
      'commonQuestionStatus', 'commonQuestionLabels', 'commonQuestionCancelControl', 'commonQuestionCard',
      'decisionSessionBlock', 'sessionBlock', 'renderProductMode', 'renderKindMode', 'renderSummary'].map(codeFor),
  ];
  assert.ok(sources.every(Boolean));

  const context = pageContext(mock, {
    ui,
    DATA: { products: [product] },
    DEFAULT_SECTION_ORDER: ['sinceSeen', 'judgment', 'tasks', 'now', 'prs'],
    commonQuestionDrafts: new Map(), commonQuestionSubmittedDrafts: new Map(), commonQuestionInFlight: new Set(),
    commonQuestionErrors: new Map(), commonQuestionNotices: new Map(), commonQuestionCancelConfirmations: new Set(),
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
    },
    hiddenSessionsUndo: null,
  });
  vm.runInContext(sources.join('\n'), context);
  context.hasHiddenJudgmentItems = vm.runInContext('hasHiddenJudgmentItems', context);
  return { context, session, product, summaryNodes };
}

test('モックのプロダクト表示と種類別表示は実際の共通質問カードを判断欄へ描画する', () => {
  const { context, summaryNodes } = createHarness();
  const productHtml = context.renderProductMode();
  assert.match(productHtml, /<article class="common-question" data-question-id="question-open"/);
  assert.match(productHtml, /<article class="common-question" data-question-id="question-away"/);
  assert.match(productHtml, /あなたの判断が必要なこと <span class="count">\(3 件\)<\/span>/);
  assert.match(productHtml, /質問対応 \(1 件\)/);
  assert.match(productHtml, /仮に推奨案で進行中 \(1 件\)/);

  const kindHtml = context.renderKindMode();
  assert.match(kindHtml, /<article class="common-question" data-question-id="question-open"/);
  assert.match(kindHtml, /<article class="common-question" data-question-id="question-away"/);
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
  assert.match(html, /class="common-question-status">外部で解決済みのため、元の回答の配送を停止しました。/);
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
    assert.ok(html.includes(`class="common-question-status">${status}</p>`));
    assert.match(html, /後続の回答を 1 件保存しました。配送は保留しています。/);
  }
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
