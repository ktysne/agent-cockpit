const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { pageContext } = require('./support/page-context');

const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');

function functionSource(source, name) {
  return source.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
}

class FakeElement {
  constructor(tagName, className = '', text = '') {
    this.tagName = tagName;
    this.className = className;
    this.children = [];
    this.dataset = {};
    this.attributes = {};
    this._textContent = text;
    this.classList = { add: (name) => { this.className = `${this.className} ${name}`.trim(); } };
  }

  append(...nodes) { this.children.push(...nodes); }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelector() { return null; }
  get childNodes() { return this.children; }
  get textContent() { return this._textContent + this.children.map((child) => child.textContent || '').join(''); }
  set textContent(value) { this._textContent = value; this.children = []; }
}

function fakeElement(tagName, className = '', text = '') {
  return new FakeElement(tagName, className, text);
}

function descendants(node) {
  return [node, ...(node.children || []).flatMap(descendants)];
}

test('状態不明の操作と推定結果は種類別・プロダクト別のメイン行内にまとまる', () => {
  const sourceFunctions = ['mainRow', 'unknownSessionControls', 'appendUnknownSessionControls']
    .map((name) => functionSource(web, name));
  assert.ok(sourceFunctions.every(Boolean));
  const sourceContext = pageContext(web, {
    activityStatus: () => ({ label: '状態不明', tone: 'unknown' }),
    newestFirst: (items) => items,
    element: fakeElement,
    document: { createTextNode: (text) => fakeElement('#text', '', text) },
    appendContextTags() {},
    appendToolLine(target, tool) { target.append(fakeElement('span', 'tool-line', tool.tool_name)); },
    durationAgoLabel: (at) => (at ? '記録時刻' : '時刻不明'),
    estimateTimeLabel: () => '10:00',
  });
  vm.runInContext(sourceFunctions.join('\n'), sourceContext);

  const unknown = {
    session_id: 'unknown', status: '不明', tools: [{ tool_name: 'Bash', startedAt: '2026-10-04T10:00:00.000Z' }],
    tasks: [], lastActivityAt: null,
  };
  const unknownRow = sourceContext.mainRow(unknown, { key: 'product', name: 'agent-cockpit' });
  assert.match(unknownRow.textContent, /状態不明 \(時刻不明\)/);
  assert.ok(descendants(unknownRow).some((node) => node.className === 'session-extra'));
  assert.ok(descendants(unknownRow).some((node) => node.dataset.estimateSession === 'unknown'));
  assert.equal(descendants(unknownRow).filter((node) => node.className === 'since').length, 0);

  const estimated = {
    ...unknown,
    estimate: { canEstimate: true, recordedAt: '2026-10-04T10:00:00.000Z', lastTool: 'Bash', state: 'tool' },
  };
  const estimatedText = sourceContext.mainRow(estimated, { key: 'product', name: 'agent-cockpit' }).textContent;
  assert.equal((estimatedText.match(/Bash/g) || []).length, 1);
  assert.equal((estimatedText.match(/10:00/g) || []).length, 1);
  assert.match(estimatedText, /入力待ちらしい: いいえ/);

  const mockFunctions = ['mainRow', 'unknownSessionControls'].map((name) => functionSource(mock, name));
  assert.ok(mockFunctions.every(Boolean));
  const mockContext = pageContext(mock, {
    ui: { estimatedSessions: ['unknown'] },
    taskState: (_session, task) => task.state,
    sessionTag: () => '<span class="session-tag">session</span>',
    esc: (value) => String(value ?? ''),
    renderToolLine: (tool) => `<span class="tool-line">${tool}</span>`,
    ESTIMATE_WAITING: { input: 'はい', tool: 'いいえ (許可待ちかツールの実行中)', model: 'いいえ (応答の生成中)' },
  });
  vm.runInContext(mockFunctions.join('\n'), mockContext);
  const mockRow = mockContext.mainRow({ name: 'agent-cockpit' }, {
    id: 'unknown', status: 'unknown', tasks: [], main: { tool: 'Bash', since: '10:00' },
    estimate: { canEstimate: true, recordedAt: '10:00', lastTool: 'Bash', state: 'tool' },
  }, true);
  assert.match(mockRow, /class="now-row main-row"/);
  assert.match(mockRow, /session-extra/);
  assert.match(mockRow, /data-estimate="unknown"/);
  assert.equal((mockRow.match(/Bash/g) || []).length, 1);
  assert.equal((mockRow.match(/10:00/g) || []).length, 1);
  assert.match(mockRow, /入力待ちらしい: いいえ/);
});

test('セッション見出しはタスクだけの完了行に札を残し、種類別の終了済み切替は行一覧の直後に置く', () => {
  const webSession = functionSource(web, 'sessionBlock');
  const mockSession = functionSource(mock, 'sessionBlock');
  assert.ok(webSession && mockSession);
  assert.match(webSession, /if \(hidesFinishedSession\(session\)\) head\.append\(productStatusBadge\(session\)\)/);
  assert.match(mockSession, /hidesFinishedSession\(session\) \? `<span class="badge/);

  for (const [source, kindName] of [[web, 'renderKindSections'], [mock, 'renderKindMode']]) {
    const kind = functionSource(source, kindName);
    assert.ok(kind);
    assert.doesNotMatch(kind, /kind-unknown|unknownActions/);
  }
  const webKind = functionSource(web, 'renderKindSections');
  const mockKind = functionSource(mock, 'renderKindMode');
  assert.match(webKind, /mainRow\(session, product, true, multipleSessions\)/);
  assert.match(mockKind, /mainRow\(p, session, true\)/);
  assert.ok(webKind.indexOf('activity.append(activityList)') < webKind.indexOf("appendKindToggle(activity, 'agents'"));
  assert.match(mockKind, /const now = `<div class="now">[\s\S]*?<\/div>\$\{endedAgentToggle\}`/);

  const webContext = pageContext(web, {
    displayPreferences: { hideFinished: true },
    element: fakeElement,
    document: { createElement: fakeElement },
    hidesFinishedSession: (session) => session.hideMain,
    sharedBranch: () => '',
    productStatusBadge: () => fakeElement('span', 'badge unknown', '状態不明'),
    shownPermissions: () => [],
    shownActiveDecisions: () => [],
    hasHiddenJudgmentItems: () => false,
    orderedSectionKeys: (keys) => keys,
    appendPermissionWaits() {},
    appendDecisions() {},
    appendTasks(target) { target.append(fakeElement('div', 'task-list')); },
    mainRow: () => fakeElement('div', 'now-row main-row'),
    appendAgents() {},
  });
  vm.runInContext(`${webSession}\nthis.renderSession = sessionBlock;`, webContext);
  const webVisible = webContext.renderSession({ key: 'p', name: 'P' }, {
    session_id: 'active', status: '不明', title: '稼働中', decisions: [], tasks: [], permissionWaits: [], agents: [],
  }, true);
  const webFinished = webContext.renderSession({ key: 'p', name: 'P' }, {
    session_id: 'finished', status: '不明', title: '完了', decisions: [], tasks: [], permissionWaits: [], agents: [], hideMain: true,
  }, true);
  assert.equal(webVisible.children[0].children.length, 1);
  assert.equal(webFinished.children[0].children.length, 2);

  const mockContext = pageContext(mock, {
    ui: { hideFinished: true },
    hidesFinishedSession: (session) => session.hideMain,
    sharedBranch: () => '',
    visibleDecisions: () => [],
    visiblePerms: () => [],
    hasHiddenJudgmentItems: () => false,
    taskSessionBlock: () => '<div class="task-list"></div>',
    orderedSectionKeys: (keys) => keys,
    decisionSessionBlock: () => '',
    mainRow: () => '<div class="now-row main-row"></div>',
    agentSection: () => '',
    esc: (value) => String(value ?? ''),
  });
  vm.runInContext(`${mockSession}\nthis.renderSession = sessionBlock;`, mockContext);
  const mockVisible = mockContext.renderSession({ sessions: [{}, {}] }, {
    id: 'active', status: 'unknown', title: '稼働中', decisions: [], tasks: [], perms: [], subagents: [],
  });
  const mockFinished = mockContext.renderSession({ sessions: [{}, {}] }, {
    id: 'finished', status: 'unknown', title: '完了', decisions: [], tasks: [], perms: [], subagents: [], hideMain: true,
  });
  assert.doesNotMatch(mockVisible, /class="badge unknown">状態不明/);
  assert.match(mockFinished, /class="badge unknown">状態不明/);

  const kindContext = pageContext(web, {
    DEFAULT_SECTION_ORDER: ['judgment', 'tasks', 'now'],
    expandedKindSections: new Set(),
    sessionReferences: () => [{
      product: { key: 'p', name: 'P', pullRequestGroups: [] },
      session: { session_id: 'unknown', status: '不明', tasks: [], decisions: [], permissionWaits: [], agents: [] },
      multipleSessions: false,
    }],
    shownPermissions: () => [],
    shownActiveDecisions: () => [],
    kindEndedDecisionEntries: () => [],
    kindEndedAgentCount: () => 1,
    kindTodoTaskCount: () => 0,
    kindDoneTaskCount: () => 0,
    kindProductOrder: () => fakeElement('div'),
    kindSection: (title, body) => ({ title, body }),
    element: fakeElement,
    appendKindToggle(target) { target.append(fakeElement('button', 'ended-toggle', '終了済みを表示')); },
    hasHiddenJudgmentItems: () => false,
    sessionActivityTime: () => 1,
    hidesFinishedSession: () => false,
    appendAgents() {},
    mainRow: (session) => fakeElement('div', 'now-row main-row', session.session_id),
    appendKindTaskSession() {},
    sinceSeenBox: () => null,
    visiblePullRequestGroups: () => [],
    isFilterShown: () => false,
    orderedSectionKeys: (keys) => keys,
  });
  vm.runInContext(`${functionSource(web, 'renderKindSections')}\nthis.renderKinds = renderKindSections;`, kindContext);
  const activity = kindContext.renderKinds([{ pullRequestGroups: [] }]).find((section) => section.title === '今やっていること').body;
  assert.equal(activity.children[0].className, 'now');
  assert.equal(activity.children[0].children[0].textContent, 'unknown');
  assert.equal(activity.children[1].className, 'ended-toggle');
});

test('判断事項の解決内容と回答状態は余白のある一行にまとまる', () => {
  const webFunctions = ['appendDecisionCard', 'appendDecisionAnswer'].map((name) => functionSource(web, name));
  assert.ok(webFunctions.every(Boolean));
  const webContext = pageContext(web, {
    element: fakeElement,
    decisionElapsedLabel: () => null,
    decisionAnswerAvailability: () => ({ active: false, viaDialog: false }),
    answerDraftFor: () => ({}),
    appendContextTags() {},
    badge: (_label, tone = '') => fakeElement('span', tone),
    decisionStateLabel: () => '解決済み',
    answerStatusText: () => '12:00 に送信済み',
  });
  vm.runInContext(`${webFunctions.join('\n')}\nthis.renderDecision = appendDecisionCard;`, webContext);
  const webList = fakeElement('div');
  webContext.renderDecision(webList, {
    id: 'decision-1', state: 'resolved', title: '解決事項', questions: [],
    resolution: { chosen: ['案 A'], note: '解決メモ' }, answer: { sentAt: '2026-10-04T12:00:00.000Z' },
  }, { name: 'agent-cockpit' }, { session_id: 'session-1' });
  const webSummary = descendants(webList).filter((node) => node.className === 'decision-summary');
  assert.equal(webSummary.length, 1);
  assert.deepEqual(webSummary[0].children.map((node) => node.textContent), ['選択: 案 A', '解決メモ', '12:00 に送信済み']);

  const mockDecision = functionSource(mock, 'decisionCard');
  assert.ok(mockDecision);
  const answer = { choice: 'pick', note: '送信メモ', picks: [0], sent: { at: '12:00', choice: 'pick', picks: [0], note: '送信メモ' } };
  const mockContext = pageContext(mock, {
    answerOf: () => answer,
    effectiveDecisionState: () => 'resolved',
    picksOf: (item) => item.picks || [],
    isNew: () => false,
    sessionTag: () => '',
    answerDirty: () => false,
    isLongWait: () => false,
    waitLabel: () => '',
    canSend: () => false,
    esc: (value) => String(value ?? ''),
  });
  vm.runInContext(`${mockDecision}\nthis.renderDecision = decisionCard;`, mockContext);
  const mockCard = mockContext.renderDecision({ name: 'agent-cockpit' }, {}, {
    id: 'decision-1', title: '解決事項', ctx: '', state: 'resolved', waitMin: 0,
    options: [{ t: '案 A', rec: false, why: '' }], resolution: { chosen: ['案 A'], note: '解決メモ' },
  }, false);
  const mockSummary = mockCard.match(/<div class="decision-summary">([\s\S]*?)<\/div>/)?.[1];
  assert.ok(mockSummary);
  assert.match(mockSummary, /選択: 案 A/);
  assert.match(mockSummary, /解決メモ/);
  assert.match(mockSummary, /12:00 に送信済み/);
  assert.equal((mockCard.match(/answer-status/g) || []).length, 1);
  assert.match(web, /\.decision-summary \{[^}]*padding: 8px 10px/);
  assert.match(mock, /\.decision-summary \{[^}]*padding: 8px 10px/);
  assert.match(web, /\.answer-foot \{[^}]*padding: 8px 10px/);
  assert.match(mock, /\.answer-foot \{[^}]*padding: 8px 10px/);
});

test('マージキュー中の PR は未マージ札だけで状態を示す', async () => {
  const webTree = functionSource(web, 'appendPullRequestTree');
  const webQueued = functionSource(web, 'queuedPullRequestMerge');
  assert.ok(webTree && webQueued);
  const webContext = pageContext(web, {
    element: fakeElement,
    document: { createTextNode: (text) => fakeElement('#text', '', text) },
    pullRequestMergeKey: () => 'repo#1',
    pullRequestMergeConfirmations: new Map(),
    pullRequestMergeInFlight: new Set(),
    pullRequestMergeMessages: new Map(),
    queuedPullRequestMerges: new Map(),
    badge: (label, tone = '') => fakeElement('span', tone, label),
    appendPullRequestBadges() {},
  });
  vm.runInContext(`${webQueued}\n${webTree}\nthis.renderPullRequest = appendPullRequestTree;`, webContext);
  const webTarget = fakeElement('div');
  webContext.renderPullRequest(webTarget, {}, {
    number: 1, title: 'キュー中', url: 'https://example.test/pr/1', headRefName: 'feature', effectiveBase: 'main',
    mergeSessionId: 'session-1', canMerge: true, mergeIntent: { at: '12:00' }, blocker: 'CI 実行中', children: [],
  });
  const webText = webTarget.textContent;
  assert.equal((webText.match(/マージキューに追加済み \(未マージ\)/g) || []).length, 1);
  assert.doesNotMatch(webText, /GitHub のマージキューに追加済みです/);
  assert.match(webText, /マージできない理由: CI 実行中/);

  webContext.queuedPullRequestMerges.set('repo#1', { headRefOid: 'abc' });
  const queuedTarget = fakeElement('div');
  webContext.renderPullRequest(queuedTarget, {}, {
    number: 1, title: 'キュー中', url: 'https://example.test/pr/1', headRefName: 'feature', effectiveBase: 'main',
    mergeSessionId: 'session-1', canMerge: true, mergeIntent: null, headRefOid: 'abc', children: [],
  });
  assert.equal((queuedTarget.textContent.match(/マージキューに追加済み \(未マージ\)/g) || []).length, 1);
  assert.doesNotMatch(queuedTarget.textContent, /マージする|マージできます/);
  assert.match(queuedTarget.textContent, /キューから外れた/);

  const pushedTarget = fakeElement('div');
  webContext.renderPullRequest(pushedTarget, {}, {
    number: 1, title: 'キュー中', url: 'https://example.test/pr/1', headRefName: 'feature', effectiveBase: 'main',
    mergeSessionId: 'session-1', canMerge: true, mergeIntent: null, headRefOid: 'def', children: [],
  });
  assert.doesNotMatch(pushedTarget.textContent, /マージキューに追加済み/);
  assert.match(pushedTarget.textContent, /マージする/);
  assert.equal(webContext.queuedPullRequestMerges.has('repo#1'), false);

  const mockItem = functionSource(mock, 'prItem');
  assert.ok(mockItem);
  const mockContext = pageContext(mock, {
    prKey: () => 'repo#1',
    mergeBlocker: () => 'GitHub のマージキュー',
    stackPos: () => ({ total: 1, depth: 1 }),
    effective: () => ({ base: 'main' }),
    ui: { reserved: {}, confirm: null },
    canReserve: () => false,
    conflictButton: () => '',
    prBadges: () => '',
    crossReviewLine: () => '',
    conflictStatus: () => '',
    esc: (value) => String(value ?? ''),
  });
  vm.runInContext(`${mockItem}\nthis.renderPullRequest = prItem;`, mockContext);
  const mockText = mockContext.renderPullRequest({ name: 'agent-cockpit' }, {
    number: 1, title: 'キュー中', mergeIntent: { at: '12:00' }, head: 'feature', sha: 'abc', conflict: false,
  });
  assert.equal((mockText.match(/マージキューに追加済み \(未マージ\)/g) || []).length, 1);
  assert.doesNotMatch(mockText, /GitHub のマージキューに追加済みです/);
  assert.doesNotMatch(mockText, /マージできない理由/);

  const action = web.match(/async function runPullRequestMergeAction\([^]*?\n\}/)?.[0];
  assert.ok(action);
  const actionContext = pageContext(web, {
    findPullRequestMergeTarget: () => ({ group: {}, pullRequest: {}, number: 1 }),
    pullRequestMergeInFlight: new Set(),
    pullRequestMergeOptionsFor: () => ({ method: 'merge', deleteBranch: false }),
    postUiAction: async () => ({
      ok: true,
      json: async () => ({ queued: true, message: 'GitHub のマージキューに追加済みです。まだマージされていません。' }),
    }),
    pullRequestMergeMessages: new Map(),
    queuedPullRequestMerges: new Map(),
    pullRequestMergeConfirmations: new Map([['key', 'merge']]),
    liveStatus: { textContent: '' },
    lastState: null,
    render() {},
    refresh: async () => {},
  });
  vm.runInContext(action, actionContext);
  await actionContext.runPullRequestMergeAction({ dataset: { mergeGo: 'key' } }, 'merge');
  assert.equal(actionContext.pullRequestMergeMessages.size, 0);
  assert.ok(actionContext.queuedPullRequestMerges.has('key'));
  assert.equal(actionContext.liveStatus.textContent, 'PR #1 をマージキューに追加しました。');
});
