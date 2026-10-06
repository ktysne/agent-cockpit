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
      'countJudgments', 'decisionCountTitle', 'commonQuestionDraft', 'commonQuestionAnswersValid',
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
    countHidden: () => 0,
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
