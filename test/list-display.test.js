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
    absoluteTimeLabel: () => '10:00',
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
    absoluteTimeLabel: (value) => value,
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

test('セッション見出しはタスクだけの完了行に札を残し、種類別の終了済み切替は欄の見出し行に置く', () => {
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
  assert.ok(webKind.indexOf('activity.append(activityList)') < webKind.indexOf("appendKindToggle(activityControls, 'agents'"));
  assert.match(mockKind, /const now = `<div class="now">[\s\S]*?<\/div>`;/);
  assert.match(mockKind, /now: section\('今やっていること', now, activityControls\)/);

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
    kindSection: (title, body, extra) => ({ title, body, extra }),
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
  const activitySection = kindContext.renderKinds([{ pullRequestGroups: [] }]).find((section) => section.title === '今やっていること');
  const activity = activitySection.body;
  assert.equal(activity.children[0].className, 'now');
  assert.equal(activity.children[0].children[0].textContent, 'unknown');
  assert.equal(activity.children.length, 1);
  assert.equal(activitySection.extra.className, 'kind-section-controls');
  assert.equal(activitySection.extra.children[0].className, 'ended-toggle');
});

test('リポジトリごとの PR は見出し付きの枠に同じ左端で順に並ぶ', () => {
  const webBlock = functionSource(web, 'appendPullRequestBlock');
  assert.ok(webBlock);
  const webContext = pageContext(web, {
    displayPreferences: { hideFinished: false },
    expandedPrLines: new Set(),
    MERGED_VISIBLE_COUNT: 5,
    MERGE_METHOD_LABELS: { squash: 'スカッシュ' },
    element: fakeElement,
    document: { createTextNode: (text) => fakeElement('#text', '', text) },
    durationAgoLabel: () => '少し前',
    absoluteTimeLabel: () => '10:00',
    appendPullRequestTree(target) { target.append(fakeElement('article', 'pr', 'オープン #1')); },
  });
  vm.runInContext(webBlock, webContext);
  const group = {
    owner: 'owner', repo: 'repo', product: { name: 'Product' }, fetchedAt: 'now',
    trees: [{ effectiveBase: 'main', children: [], stackPosition: { total: 1 } }],
    mergeHistory: [{ number: 2, url: '#2', title: 'Merged', mergedAt: 'now', method: 'squash', automatic: false }],
    merged: [{ number: 3, url: '#3', title: 'Closed', state: 'closed' }],
  };
  const target = fakeElement('div');
  webContext.appendPullRequestBlock(target, group, true);
  const frame = target.children[0];
  assert.equal(frame.tagName, 'section');
  assert.match(frame.className, /group-frame/);
  assert.equal(frame.children[0].tagName, 'header');
  assert.equal(frame.children[0].children[0].tagName, 'h3');
  assert.equal(frame.children[0].children[0].children[0].tagName, 'strong');
  assert.equal(frame.children[0].children[1].className, 'prod-tag');
  const content = frame.children[1];
  assert.deepEqual(content.children.map((child) => child.className), ['stack', 'merged-list', 'merged-list']);
  assert.match(content.children[0].textContent, /オープン #1/);
  assert.match(content.children[1].textContent, /マージ済み/);
  assert.match(content.children[2].textContent, /クローズ済み/);

  group.trees = [];
  const emptyTarget = fakeElement('div');
  webContext.appendPullRequestBlock(emptyTarget, group);
  assert.deepEqual(emptyTarget.children[0].children[1].children.map((child) => child.className), [
    'empty', 'merged-list', 'merged-list',
  ]);

  const mockPr = functionSource(mock, 'prBlock');
  assert.ok(mockPr);
  const mockContext = pageContext(mock, {
    ui: { hideFinished: false, merged: { '2': { method: 'squash', at: '10:00', auto: false } }, expandedMerged: [] },
    openPrs: () => [{ number: 1 }],
    parentPr: () => null,
    isMerged: (_product, pr) => pr.state === 'merged',
    effective: () => ({ base: 'main' }),
    childPrs: () => [],
    stackPos: () => ({ total: 1 }),
    prTree: () => '<div class="pr">オープン #1</div>',
    foldedPrLine: (_product, kind) => `<div class="merged-list">${kind}</div>`,
    prKey: (_product, number) => String(number),
    METHOD_LABEL: { squash: 'スカッシュ' },
    esc: (value) => String(value ?? ''),
    absoluteTimeLabel: (value) => value,
  });
  vm.runInContext(`${mockPr}\nthis.renderPr = prBlock;`, mockContext);
  const mockProduct = {
    id: 'product', name: 'Product', repo: { name: 'owner/repo', fetched: '少し前' },
    prs: [{ number: 2, state: 'merged' }, { number: 3, state: 'closed' }],
    closedPrs: [{ number: 3, title: 'Closed' }],
  };
  const mockHtml = mockContext.renderPr(mockProduct, true);
  assert.match(mockHtml, /^<section class="group-frame pr-repo-group">/);
  assert.match(mockHtml, /<h3 class="pr-repo-title"><strong>owner\/repo<\/strong><\/h3><span class="prod-tag">Product<\/span>/);
  assert.ok(mockHtml.indexOf('class="stack"') < mockHtml.indexOf('class="merged-list">merged'));
  assert.ok(mockHtml.indexOf('class="merged-list">merged') < mockHtml.indexOf('class="merged-list">closed'));
  mockContext.openPrs = () => [];
  const mockEmptyHtml = mockContext.renderPr(mockProduct, false);
  assert.ok(mockEmptyHtml.indexOf('class="empty"') < mockEmptyHtml.indexOf('class="merged-list">merged'));
  assert.match(mockEmptyHtml, /<h4 class="pr-repo-title"><strong>owner\/repo<\/strong><\/h4>/);

  for (const source of [web, mock]) {
    assert.match(source, /\.group-frame > \.empty, \.pr-repo-content > \.empty, \.pr-repo-content > \.stack, \.pr-repo-content > \.merged-list \{ padding-inline: 0; \}/);
    assert.match(source, /\.stack \{[^}]*border: 0;[^}]*background: transparent;/);
  }
});

test('プロダクト別の PR 欄はセッション群の外に区切って置く', () => {
  const productSection = functionSource(web, 'productSection');
  const sessionBlock = functionSource(web, 'sessionBlock');
  assert.ok(productSection && sessionBlock);
  const product = {
    key: 'product', name: 'Product', branches: new Set(),
    sessions: [{ session_id: 'one', permissionWaits: [], decisions: [] }, { session_id: 'two', permissionWaits: [], decisions: [] }],
    pullRequestGroups: [{}],
  };
  const context = pageContext(web, {
    displayPreferences: { pinned: [], collapsed: [] },
    element: fakeElement,
    sharedBranch: () => '',
    productCloseButton: () => null,
    productControls: () => fakeElement('div'),
    pullRequestMergeableCount: () => 0,
    pullRequestOpenCount: () => 1,
    sinceSeenBox: () => null,
    isAwaitingDecision: () => false,
    isFilterShown: () => true,
    sessionBlock: (_product, _session, multiple) => fakeElement('section', `session-group ${multiple ? '' : 'single'}`.trim()),
    appendPullRequestBlock(target) { target.append(fakeElement('section', 'group-frame pr-repo-group')); },
  });
  vm.runInContext(productSection, context);
  const section = context.productSection(product, 0, [product], 0);
  const body = section.children[1];
  const sessionIndexes = body.children.map((child, index) => child.className.startsWith('session-group') ? index : -1).filter((index) => index >= 0);
  const dividerIndex = body.children.findIndex((child) => child.className === 'product-pr-divider');
  const repoIndex = body.children.findIndex((child) => child.className.includes('pr-repo-group'));
  assert.equal(sessionIndexes.length, 2);
  assert.ok(sessionIndexes[1] < dividerIndex && dividerIndex < repoIndex);
  assert.equal(body.children[repoIndex].tagName, 'section');

  const mockProductMode = functionSource(mock, 'renderProductMode');
  const mockSessionBlock = functionSource(mock, 'sessionBlock');
  assert.ok(mockProductMode && mockSessionBlock);
  assert.match(mockSessionBlock, /const groupTag = multiple \? 'section' : 'div';/);
  assert.match(mockSessionBlock, /return `<\$\{groupTag\} class="session-group/);
  assert.ok(mockProductMode.indexOf('sessions.map(session => sessionBlock(p, session))')
    < mockProductMode.indexOf('product-pr-divider'));
  assert.match(sessionBlock, /element\(multipleSessions \? 'section' : 'div', `session-group \$\{multipleSessions \? '' : 'single'\}`/);
  assert.match(web, /\.session-group\.single \{ margin-top: 0; padding: 0; border-left: 0; \}/);
  assert.match(mock, /\.session-group\.single \{ border-left: 0; padding: 0; margin-top: 0; \}/);
  assert.match(web, /\.session-group:not\(\.single\) \.session-body \{ padding-left: 12px; \}/);
  assert.match(mock, /\.session-group:not\(\.single\) \.session-body \{ padding-left: 12px; \}/);
});

test('種類別のセッションごとのタスクは PR と同じ枠で、欄全体の切り替えは見出し行に置く', () => {
  const taskBlock = functionSource(web, 'appendKindTaskSession');
  const mockTaskBlock = functionSource(mock, 'kindTaskSessionBlock');
  assert.ok(taskBlock && mockTaskBlock);
  const webContext = pageContext(web, {
    element: fakeElement,
    taskVisibility: () => ({ visible: [] }),
    appendContextTags(target) { target.append(fakeElement('span', 'prod-tag', 'Product'), fakeElement('span', 'session-tag', 'Session')); },
    durationAgoLabel: () => '少し前',
  });
  vm.runInContext(`${taskBlock}\nthis.renderTaskGroup = appendKindTaskSession;`, webContext);
  const taskGroup = fakeElement('div');
  webContext.renderTaskGroup(taskGroup, {
    product: { name: 'Product' }, session: { session_id: 'session', title: 'Session', tasks: [] }, multipleSessions: true,
  }, false, false);
  assert.equal(taskGroup.children[0].tagName, 'section');
  assert.match(taskGroup.children[0].className, /group-frame/);
  assert.equal(taskGroup.children[0].children[0].tagName, 'h3');

  const mockContext = pageContext(mock, {
    ui: { expandedKindTodoTasks: false },
    taskVisibility: () => ({ doneCount: 0, visible: [] }),
    taskItem: () => '',
    sessionTag: () => '<span class="prod-tag">Product</span><span class="session-tag">Session</span>',
    esc: (value) => String(value ?? ''),
  });
  vm.runInContext(`${mockTaskBlock}\nthis.renderTaskGroup = kindTaskSessionBlock;`, mockContext);
  const mockTaskGroup = mockContext.renderTaskGroup({ name: 'Product' }, { id: 'session', title: 'Session', tasks: [], tasksUpdatedMin: NaN }, false);
  assert.match(mockTaskGroup.html, /^<section class="kind-session-tasks group-frame"><h3 class="kind-task-head">/);

  for (const source of [web, mock]) {
    assert.match(source, /\.group-frame \{ margin: 0 0 10px; padding: 10px 12px; border: 1px solid var\(--border\); border-radius: var\(--radius\); background: var\(--surface\);/);
  }

  const references = [{
    product: { key: 'product', name: 'Product', pullRequestGroups: [] },
    session: { session_id: 'session', tasks: [{}], decisions: [], permissionWaits: [], agents: [] },
    multipleSessions: true,
  }];
  const kindContext = pageContext(web, {
    DEFAULT_SECTION_ORDER: ['judgment', 'tasks', 'now'],
    expandedKindSections: new Set(),
    sessionReferences: () => references,
    shownPermissions: () => [],
    shownActiveDecisions: () => [],
    kindEndedDecisionEntries: () => [],
    kindEndedAgentCount: () => 1,
    kindTodoTaskCount: () => 1,
    kindDoneTaskCount: () => 1,
    kindProductOrder: () => fakeElement('div'),
    kindSection: (title, body, extra) => ({ title, body, extra }),
    element: fakeElement,
    appendKindToggle(target, key) {
      const toggle = fakeElement('button', 'ended-toggle', key);
      toggle.dataset.kindToggle = key;
      target.append(toggle);
    },
    hasHiddenJudgmentItems: () => false,
    sessionActivityTime: () => 1,
    hidesFinishedSession: () => false,
    appendAgents() {},
    mainRow: () => fakeElement('div', 'now-row main-row'),
    appendKindTaskSession(target) { target.append(fakeElement('section', 'kind-session-tasks group-frame')); },
    sinceSeenBox: () => null,
    visiblePullRequestGroups: () => [],
    isFilterShown: () => false,
    orderedSectionKeys: (keys) => keys,
  });
  vm.runInContext(`${functionSource(web, 'renderKindSections')}\nthis.renderKinds = renderKindSections;`, kindContext);
  const sections = kindContext.renderKinds([{ pullRequestGroups: [] }]);
  const tasks = sections.find((section) => section.title === 'タスクと完了条件');
  const activity = sections.find((section) => section.title === '今やっていること');
  assert.equal(tasks.extra.className, 'kind-section-controls');
  assert.deepEqual(tasks.extra.children.map((toggle) => toggle.dataset.kindToggle), ['todoTasks', 'tasks']);
  assert.equal(tasks.body.children[0].className, 'kind-session-tasks group-frame');
  assert.equal(tasks.body.children.some((child) => child.dataset.kindToggle), false);
  assert.equal(activity.extra.children[0].dataset.kindToggle, 'agents');
  assert.equal(activity.body.children.some((child) => child.dataset.kindToggle), false);

  const mockKind = functionSource(mock, 'renderKindMode');
  assert.ok(mockKind);
  assert.match(mockKind, /const taskControls = todoTaskToggle \|\| doneTaskToggle[\s\S]*?<div class="kind-section-controls">\$\{todoTaskToggle\}\$\{doneTaskToggle\}/);
  assert.match(mockKind, /tasks: section\('タスクと完了条件', tasks, taskControls\)/);
  assert.match(mockKind, /now: section\('今やっていること', now, activityControls\)/);
  assert.match(mockKind, /judgment: showJudgment \? section\('あなたの判断が必要なこと', decisions, decisionControls\)/);
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
    absoluteTimeLabel: () => '12:00',
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
    absoluteTimeLabel: () => '12:00',
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
  assert.match(mockText, /data-queue-left="repo#1"[^>]*>キューから外れた</);
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
