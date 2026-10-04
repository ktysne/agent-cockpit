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

function eventListenerSource(source, eventName) {
  return source.match(new RegExp(`document\\.addEventListener\\('${eventName}', (e => \\{[\\s\\S]*?\\n\\})\\);`))?.[1];
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
    this.listeners = new Map();
  }

  append(...nodes) { this.children.push(...nodes); }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
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
  assert.match(mockKind, /const now = nowRowsByAge\.length \? `<div class="now">[\s\S]*?<\/div>` : '';/);
  assert.match(mockKind, /now: section\('今やっていること', now, activityControls, nowRowsByAge\.length \+ endedAgentCount\)/);

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
  assert.equal(activity.className, 'body now');
  assert.equal(activity.children[0].textContent, 'unknown');
  assert.equal(activity.children.length, 1);
  assert.equal(activitySection.extra.className, 'kind-section-controls');
  assert.equal(activitySection.extra.children[0].className, 'ended-toggle');
});

test('リポジトリごとの PR は見出し付きの枠に同じ左端で順に並ぶ', () => {
  const webBlock = functionSource(web, 'appendPullRequestBlock');
  const webResults = functionSource(web, 'appendPullRequestMergeResults');
  const webResultLine = functionSource(web, 'pullRequestMergeResultLine');
  assert.ok(webBlock && webResults && webResultLine);
  const webContext = pageContext(web, {
    displayPreferences: { hideFinished: false },
    expandedPrLines: new Set(),
    MERGED_VISIBLE_COUNT: 5,
    MERGE_METHOD_LABELS: { squash: 'スカッシュ' },
    element: fakeElement,
    document: { createTextNode: (text) => fakeElement('#text', '', text) },
    durationAgoLabel: () => '少し前',
    absoluteTimeLabel: () => '10:00',
    pullRequestMergeResults: new Map(),
    pullRequestRepositoryKey: (group) => `${group.owner}/${group.repo}`,
    appendPullRequestTree(target) { target.append(fakeElement('article', 'pr', 'オープン #1')); },
  });
  vm.runInContext(`${webResultLine}\n${webResults}\n${webBlock}`, webContext);
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
    pullRequestMergeResults: new Map(),
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
  assert.match(mockKind, /tasks: section\('タスクと完了条件', tasks, taskControls, todoTaskCount \+ doneTaskCount\)/);
  assert.match(mockKind, /now: section\('今やっていること', now, activityControls, nowRowsByAge\.length \+ endedAgentCount\)/);
  assert.match(mockKind, /judgment: showJudgment \? section\('あなたの判断が必要なこと', decisions, decisionControls, waits\.length \+ endedDecisionEntries\.length\)/);
});

test('種類別の空欄は本文と枠を省き、件数付きの見出し一行を表示する', () => {
  const source = functionSource(web, 'kindSection');
  assert.ok(source);
  const context = pageContext(web, {
    element: fakeElement,
    document: { createTextNode: (text) => fakeElement('#text', '', text) },
  });
  vm.runInContext(`${source}\nthis.renderSection = kindSection;`, context);

  const empty = context.renderSection('プルリクエスト', fakeElement('div'));
  assert.equal(empty.className, 'kind-empty');
  assert.equal(empty.textContent, 'プルリクエスト（なし）');
  assert.equal(empty.children.length, 1);
  assert.equal(empty.children[0].tagName, 'h2');

  const counted = context.renderSection('タスクと完了条件', fakeElement('div'), null, 2);
  assert.equal(counted.textContent, 'タスクと完了条件(2 件)');
  assert.equal(counted.children.length, 1);

  const content = fakeElement('div');
  content.append(fakeElement('article', 'decision-card'));
  const populated = context.renderSection('判断', content);
  assert.equal(populated.className, 'section kind-section');
  assert.equal(populated.children.length, 2);
  assert.equal(content.className, 'body');

  const mockKind = functionSource(mock, 'renderKindMode');
  assert.match(mockKind, /class="kind-empty"/);
  assert.doesNotMatch(mockKind, /class="empty">ありません/);
});

test('判断事項の解決内容と回答状態は余白のある一行にまとまる', () => {
  const webFunctions = ['answerDraftKey', 'appendDecisionCard', 'appendDecisionAnswer'].map((name) => functionSource(web, name));
  assert.ok(webFunctions.every(Boolean));
  const webContext = pageContext(web, {
    answerErrors: new Map(),
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
    answerErrors: new Map(),
    answerDraftKey: (sessionId, decisionId) => `${sessionId}\0${decisionId}`,
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
    pullRequestMergeConditionWaits: (pullRequest) => pullRequest.ci === 'pending' ? ['CI 実行中'] : [],
    badge: (label, tone = '') => fakeElement('span', tone, label),
    appendPullRequestBadges() {},
  });
  vm.runInContext(`${webQueued}\n${webTree}\nthis.renderPullRequest = appendPullRequestTree;`, webContext);
  const webTarget = fakeElement('div');
  webContext.renderPullRequest(webTarget, {}, {
    number: 1, title: 'キュー中', url: 'https://example.test/pr/1', headRefName: 'feature', effectiveBase: 'main',
    mergeSessionId: 'session-1', canMerge: true, mergeIntent: { at: '12:00' }, blocker: 'CI 実行中', ci: 'pending', children: [],
  });
  const webText = webTarget.textContent;
  assert.equal((webText.match(/マージキューに追加済み \(未マージ\)/g) || []).length, 1);
  assert.doesNotMatch(webText, /GitHub のマージキューに追加済みです/);
  assert.match(webText, /待ち: CI 実行中/);

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
    mergeOperationBlocker: () => null,
    mergeConditionWaits: () => [],
    stackPos: () => ({ total: 1, depth: 1 }),
    effective: () => ({ base: 'main' }),
    ui: { reserved: {}, reservationNotices: {}, confirm: null },
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

test('モックのマージ欄は即時マージと収束後マージの確認欄を共用する', () => {
  const setConfirmation = functionSource(mock, 'setMergeConfirmation');
  const item = functionSource(mock, 'prItem');
  assert.ok(setConfirmation && item);
  const key = 'example/project#42';
  const context = pageContext(mock, {
    prKey: () => key,
    mergeOperationBlocker: () => null,
    mergeConditionWaits: () => ['CI 実行中'],
    stackPos: () => ({ depth: 1, total: 1 }),
    effective: () => ({ base: 'main' }),
    ui: { reserved: {}, reservationNotices: {}, confirm: null, mergeAfterReviewDefault: false, mergeOpts: {} },
    mergeConfirm: () => '<div class="merge-confirm" data-action="shared"></div>',
    conflictButton: () => '',
    prBadges: () => '',
    crossReviewLine: () => '',
    conflictStatus: () => '',
    esc: (value) => String(value ?? ''),
  });
  vm.runInContext(`${setConfirmation}\n${item}\nthis.selectConfirmation = setMergeConfirmation; this.renderPullRequest = prItem;`, context);
  const product = { name: 'agent-cockpit' };
  const pullRequest = { number: 42, title: 'Feature', head: 'feature', sha: 'abc', conflict: false };

  context.selectConfirmation(key, 'manual');
  const html = context.renderPullRequest(product, pullRequest);
  assert.deepEqual([...html.matchAll(/class="merge-confirm" data-action="(shared)"/g)].map((match) => match[1]), ['shared']);

  const buttons = context.renderPullRequest(product, pullRequest);
  assert.match(buttons, /data-merge-action="manual"/);
  assert.doesNotMatch(buttons, /data-merge-action="reserve"|CI が通ったらマージ/);
});

test('完了済みを隠した件数を知らせ、表示する操作で設定を解除する', () => {
  const countsSource = functionSource(web, 'finishedHiddenCounts');
  const noteSource = functionSource(web, 'renderFinishedNote');
  assert.ok(countsSource && noteSource);
  const note = { hidden: true, children: [], replaceChildren(...children) { this.children = children; } };
  const hideFinishedInput = { checked: true };
  const changes = [];
  const context = pageContext(web, {
    displayPreferences: { hideFinished: true },
    isFinishedSession: (session) => session.finished,
    element: fakeElement,
    document: { getElementById: () => note },
    hideFinishedInput,
    changeDisplaySetting: (key, input) => changes.push([key, input.checked]),
  });
  vm.runInContext(`${countsSource}\n${noteSource}\nthis.countHidden = finishedHiddenCounts; this.renderFinished = renderFinishedNote;`, context);
  const counts = context.countHidden([{ finished: true }, { finished: false }], [
    { owner: 'example', repo: 'project', mergeHistory: [{ number: 10 }, { number: 11, headMismatch: true }], merged: [{ number: 12, state: 'closed' }] },
  ]);
  assert.deepEqual(JSON.parse(JSON.stringify(counts)), { sessions: 1, pullRequests: 2 });
  context.renderFinished(counts);
  assert.equal(note.hidden, false);
  assert.match(note.children[0].textContent, /終わったものを隠しています \(セッション 1 件、PR 2 件\)/);
  const show = note.children[1];
  assert.equal(show.textContent, '表示する');
  show.listeners.get('click')();
  assert.equal(hideFinishedInput.checked, false);
  assert.deepEqual(changes, [['hideFinished', false]]);
  assert.match(web, /終わったものを隠しています。下の「表示する」から表示できます。/);
  assert.match(mock, /終わったものを隠しています。下の「表示する」から表示できます。/);
  assert.match(mock, /終わったものを隠しています \(\$\{finishedParts\.join\('、'\)\}\)/);
});

test('マージ結果の一行と予約時の SHA 違いを完了表示の設定中も残す', () => {
  const lineSource = functionSource(web, 'pullRequestMergeResultLine');
  const resultsSource = functionSource(web, 'appendPullRequestMergeResults');
  const visibleSource = functionSource(web, 'visiblePullRequestGroups');
  assert.ok(lineSource && resultsSource && visibleSource);
  const key = 'example/project\0project-a';
  const context = pageContext(web, {
    MERGE_METHOD_LABELS: { squash: 'スカッシュ' },
    displayPreferences: { hideFinished: true },
    pullRequestMergeResults: new Map([[key, [{ id: 'result-1', number: 41, method: 'squash', branchDeleted: true, retargetedBase: 'main', retargetedNumbers: [42], warning: '予約時と異なる head SHA がマージされました' }]]]),
    pullRequestRepositoryKey: (group) => `${group.owner}/${group.repo}\0${group.product.key}`,
    hasPullRequestMergeResults: (group) => group.owner === 'example' && group.repo === 'project' && group.product.key === 'project-a',
    element: fakeElement,
  });
  vm.runInContext(`${lineSource}\n${resultsSource}\n${visibleSource}\nthis.resultLine = pullRequestMergeResultLine; this.appendResults = appendPullRequestMergeResults; this.visibleGroups = visiblePullRequestGroups;`, context);
  assert.equal(context.resultLine({ method: 'squash', branchDeleted: true, retargetedBase: 'main', retargetedNumbers: [42], warning: '予約時と異なる head SHA がマージされました' }),
    'スカッシュ でマージしました。ブランチを削除しました。#42 の base を main に付け替えました。予約時と異なる head SHA がマージされました。');
  const content = fakeElement('div');
  context.appendResults(content, { owner: 'example', repo: 'project', product: { key: 'project-a' } });
  assert.match(content.textContent, /PR #41: スカッシュ でマージしました/);
  assert.equal(descendants(content).find((node) => node.dataset.closeMergeResult === 'result-1').textContent, '閉じる');
  const mismatch = { owner: 'example', repo: 'project', product: { key: 'project-b' }, openCount: 0, mergeHistory: [{ number: 51, headMismatch: true }] };
  const finished = { owner: 'example', repo: 'project', product: { key: 'project-c' }, openCount: 0, mergeHistory: [{ number: 52 }] };
  const loading = { owner: 'example', repo: 'new-project', product: { key: 'project-d' }, openCount: 0, loading: true };
  assert.deepEqual(JSON.parse(JSON.stringify(context.visibleGroups([mismatch, finished, loading]))), [mismatch, loading]);
  assert.match(web, /items\.filter\(\(item\) => item\.headMismatch === true\)/);
  assert.match(mock, /visibleMerged = ui\.hideFinished \? mergedNewestFirst\.filter\(\(\{ pr \}\) => pr\.headMismatch === true\)/);
  const mockLine = functionSource(mock, 'pullRequestMergeResultLine');
  assert.ok(mockLine);
  const mockContext = pageContext(mock, { METHOD_LABEL: { squash: 'スカッシュ' } });
  vm.runInContext(`${mockLine}\nthis.resultLine = pullRequestMergeResultLine;`, mockContext);
  assert.equal(mockContext.resultLine({ method: 'squash', branchDeleted: true, retargetedBase: 'main', retargetedNumbers: [42], warning: '予約時と異なる head SHA がマージされました' }),
    context.resultLine({ method: 'squash', branchDeleted: true, retargetedBase: 'main', retargetedNumbers: [42], warning: '予約時と異なる head SHA がマージされました' }));
});

test('常駐サーバーが記録した予約マージの結果を一行で表示する', () => {
  const resultLine = functionSource(web, 'pullRequestMergeResultLine');
  const appendResults = functionSource(web, 'appendPullRequestMergeResults');
  assert.ok(resultLine && appendResults);
  const context = pageContext(web, {
    MERGE_METHOD_LABELS: { squash: 'スカッシュ' },
    pullRequestMergeResults: new Map(),
    pullRequestRepositoryKey: (group) => `${group.owner}/${group.repo}`,
    element: fakeElement,
  });
  vm.runInContext(`${resultLine}\n${appendResults}\nthis.appendResults = appendPullRequestMergeResults;`, context);
  const content = fakeElement('div');
  context.appendResults(content, {
    owner: 'example', repo: 'project',
    mergeHistory: [{
      number: 43, method: 'squash', automatic: true,
      automaticResult: { branchDeleted: true, retargetedBase: 'main', retargetedNumbers: [44] },
    }],
  });
  assert.match(content.textContent, /PR #43: スカッシュ でマージしました。ブランチを削除しました。#44 の base を main に付け替えました/);
});

test('予約中の PR は待ち条件と取消操作を出し、マージできない理由を隠す', () => {
  const treeSource = functionSource(web, 'appendPullRequestTree');
  assert.ok(treeSource);
  const mergeKey = 'reservation-key';
  const context = pageContext(web, {
    displayPreferences: { mergeableCondition: 'cross-review' },
    MERGE_METHOD_LABELS: { squash: 'スカッシュ' },
    element: fakeElement,
    badge: (text, tone) => fakeElement('span', tone, text),
    queuedPullRequestMerge: () => null,
    pullRequestMergeConditionWaits: () => ['CI 実行中', 'クロスレビュー未実施'],
    pullRequestMergeKey: () => mergeKey,
    pullRequestMergeConfirmations: new Map(),
    pullRequestMergeInFlight: new Set(),
    appendPullRequestBadges() {},
    absoluteTimeLabel: () => '2026/10/04 10:00',
    pullRequestReservationWaits: () => ['クロスレビューの収束待ち', 'CI 待ち', 'GitHub のレビュー承認待ち'],
    crossReviewLine: () => null,
    pullRequestMergeMessages: new Map(),
    appendPullRequestConflictControls() {},
    appendPullRequestMergeConfirmation() {},
    document: { createTextNode: (text) => fakeElement('#text', '', text) },
  });
  vm.runInContext(`${treeSource}\nthis.renderTree = appendPullRequestTree;`, context);
  const target = fakeElement('div');
  context.renderTree(target, { defaultBranch: 'main' }, {
    number: 7, url: 'https://github.com/example/repo/pull/7', title: 'Feature', headRefName: 'feature', effectiveBase: 'main',
    canMerge: false, blocker: 'ドラフト', operationBlocker: 'ドラフト', ci: 'pending', review: 'required',
    reservation: { method: 'squash', createdAt: '2026-10-04T01:00:00.000Z' }, children: [], mergeSessionId: 'session-a',
  });
  const rendered = target.children[0];
  assert.match(rendered.textContent, /レビュー収束後にマージ予約中 \(スカッシュ、予約時 2026\/10\/04 10:00、クロスレビューの収束待ち、CI 待ち、GitHub のレビュー承認待ち\)/);
  assert.match(rendered.textContent, /予約を取り消す/);
  assert.doesNotMatch(rendered.textContent, /マージできない理由/);
  assert.equal(descendants(rendered).find((node) => node.dataset.cancelReservation === mergeKey).disabled, false);
});

test('GitHub の自動削除設定があるマージ結果はブランチ状態を断定しない', async () => {
  const findTargetSource = functionSource(web, 'findPullRequestMergeTarget');
  const rememberSource = functionSource(web, 'rememberPullRequestMergeResult');
  const lineSource = functionSource(web, 'pullRequestMergeResultLine');
  const actionSource = `async ${functionSource(web, 'runPullRequestMergeAction')}`;
  assert.ok(findTargetSource && rememberSource && lineSource && actionSource);
  const key = 'a'.repeat(64);
  const pullRequest = { mergeRecordKey: key, mergeSessionId: 'session-a', number: 41, headRefOid: 'abcdef', children: [] };
  const group = {
    owner: 'example', repo: 'project', product: { key: 'project-a' }, autoDeleteBranch: true,
    defaultBranch: 'main', trees: [pullRequest],
  };
  const webResults = new Map();
  const webContext = pageContext(web, {
    MERGE_METHOD_LABELS: { squash: 'スカッシュ' },
    lastState: { pullRequests: [group] }, pullRequestMergeInFlight: new Set(),
    pullRequestMergeOptionsFor: () => ({ method: 'squash', deleteBranch: false }),
    pullRequestMergeConfirmations: new Map(), queuedPullRequestMerges: new Map(), pullRequestMergeMessages: new Map(),
    pullRequestMergeResults: webResults, nextPullRequestMergeResultId: 0,
    pullRequestRepositoryKey: (item) => `${item.owner}/${item.repo}\0${item.product.key}`,
    liveStatus: { textContent: '' }, render() {}, refresh: async () => {},
    postUiAction: async () => ({ ok: true, json: async () => ({ merged: true, branchDeleted: false }) }),
  });
  vm.runInContext(`${findTargetSource}\n${rememberSource}\n${lineSource}\n${actionSource}\nthis.merge = runPullRequestMergeAction; this.resultLine = pullRequestMergeResultLine;`, webContext);
  await webContext.merge({ dataset: { mergeGo: key } }, 'merge');
  const webResult = webResults.get('example/project\0project-a')[0];
  const expected = 'スカッシュ でマージしました。ブランチの削除は GitHub の自動削除の設定に任せた (結果は未確認)。';
  assert.equal(webResult.autoDeleteBranch, true);
  assert.equal(webContext.resultLine(webResult), expected);

  // fork の head ブランチは登録先の自動削除の対象にならない。
  pullRequest.isCrossRepository = true;
  webResults.clear();
  await webContext.merge({ dataset: { mergeGo: key } }, 'merge');
  const forkResult = webResults.get('example/project\0project-a')[0];
  assert.equal(forkResult.autoDeleteBranch, false);
  assert.equal(webContext.resultLine(forkResult), 'スカッシュ でマージしました。ブランチは削除していません。');
  delete pullRequest.isCrossRepository;

  const mockResults = new Map();
  const mockContext = pageContext(mock, {
    METHOD_LABEL: { squash: 'スカッシュ' },
    ui: { lastMethod: {}, merged: {}, reserved: {}, confirm: null },
    pullRequestMergeResults: mockResults, nextPullRequestMergeResultId: 0,
    prKey: () => 'project#41', childPrs: () => [], absoluteTimeLabel: () => 'now',
    save() {}, render() {},
  });
  const mockSources = [
    functionSource(mock, 'rememberPullRequestMergeResult'),
    functionSource(mock, 'finishMockMerge'),
    functionSource(mock, 'pullRequestMergeResultLine'),
  ];
  assert.ok(mockSources.every(Boolean));
  vm.runInContext(`${mockSources.join('\n')}\nthis.finish = finishMockMerge; this.resultLine = pullRequestMergeResultLine;`, mockContext);
  mockContext.finish({ id: 'project', repo: { name: 'example/project', defaultBranch: 'main', autoDeleteBranch: true } }, { number: 41 }, { method: 'squash', del: false });
  const mockResult = mockResults.get('example/project')[0];
  assert.equal(mockResult.autoDeleteBranch, true);
  assert.equal(mockContext.resultLine(mockResult), expected);
});

test('回答の送信失敗は再描画後も残り、下書き変更後に送信済み状態を置き換える', () => {
  const keySource = functionSource(web, 'answerDraftKey');
  const sameSource = functionSource(web, 'sameAnswerDraft');
  const clearSource = functionSource(web, 'clearAnswerErrorWhenDraftChanges');
  const appendSource = functionSource(web, 'appendDecisionAnswer');
  assert.ok(keySource && sameSource && clearSource && appendSource);
  const errors = new Map();
  const context = pageContext(web, {
    answerErrors: errors,
    decisionAnswerAvailability: () => ({ active: true, viaDialog: false }),
    answerDraftFor: () => ({ choice: 'pick', picks: [[]], note: '新しい指示' }),
    element: fakeElement,
    document: { createElement: (tag) => fakeElement(tag), createTextNode: (text) => fakeElement('#text', '', text) },
    sameAnswerPicks: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    copyAnswerPicks: (picks) => picks || [[]],
    recommendedOptionsForQuestions: () => [],
    canSendDecisionAnswer: () => true,
    answerMetaText: () => '送る答え',
    answerStatusText: () => '前回の回答を送信済み',
    sessionDisplayName: (session) => session.session_id,
  });
  vm.runInContext(`${keySource}\n${sameSource}\n${clearSource}\n${appendSource}\nthis.key = answerDraftKey; this.clearError = clearAnswerErrorWhenDraftChanges; this.appendAnswer = appendDecisionAnswer;`, context);
  const key = context.key('session-a', 'decision-a');
  errors.set(key, '回答を送信できませんでした。');
  const decision = { id: 'decision-a', questions: [], answer: { choice: 'ok', note: '以前の指示', picks: [], sentAt: '2026-10-04T00:00:00Z' } };
  const card = fakeElement('article');
  context.appendAnswer(card, decision, { name: 'project' }, { session_id: 'session-a' }, fakeElement('div'));
  assert.ok(descendants(card).some((node) => node.className === 'answer-error' && node.textContent === '回答を送信できませんでした。'));
  assert.ok(descendants(card).some((node) => node.className === 'answer-status' && node.textContent === '変更は未送信'));
  context.clearError(key, { choice: 'pick', note: '旧下書き', picks: [[]] }, { choice: 'pick', note: '変更後', picks: [[]] }, null);
  assert.equal(errors.has(key), false);
  assert.match(web, /answerErrors\.delete\(answerDraftKey\(sessionId, decisionId\)\)/);
  assert.match(mock, /変更は未送信/);
});

test('回答の編集時に送信済み回答の状態表示も更新する', () => {
  const updateSource = functionSource(web, 'updateAnswerSubmit');
  assert.ok(updateSource);
  const decision = {
    id: 'decision-a', questions: [],
    answer: { choice: 'ok', note: '保存済みの指示', picks: [], sentAt: '2026-10-04T00:00:00Z' },
  };
  let draft = { choice: 'pick', note: '編集中の指示', picks: [] };
  const button = { disabled: false };
  const meta = { textContent: '' };
  const status = { textContent: '' };
  const card = {
    dataset: { sessionId: 'session-a', decisionId: 'decision-a' },
    querySelector(selector) {
      return selector === '[data-send-answer]' ? button
        : selector === '[data-answer-meta]' ? meta
          : selector === '.answer-foot .answer-status' ? status : null;
    },
  };
  const context = pageContext(web, {
    findDecision: () => decision,
    answerDraftFor: () => draft,
    sameAnswerPicks: (left, right) => JSON.stringify(left) === JSON.stringify(right),
    copyAnswerPicks: (picks) => picks || [],
    answerMetaText: () => '送る答え',
    answerStatusText: () => '前回の回答を送信済み',
    canSendDecisionAnswer: () => true,
  });
  vm.runInContext(`${updateSource}\nthis.update = updateAnswerSubmit;`, context);
  context.update(card);
  assert.equal(status.textContent, '変更は未送信');
  assert.equal(button.disabled, false);

  draft = { choice: 'ok', note: '保存済みの指示', picks: [] };
  context.update(card);
  assert.equal(status.textContent, '前回の回答を送信済み');
  assert.equal(button.disabled, true);
});

test('表示設定の保存失敗は値を戻して設定ダイアログにも表示する', async () => {
  const settleSource = functionSource(web, 'settleDisplayPreferenceSaves');
  const saveSource = functionSource(web, 'saveDisplayPreferences');
  const showErrorSource = functionSource(web, 'showWriteError');
  const sendPatchSource = `async ${functionSource(web, 'sendDisplayPatch')}`;
  assert.ok(settleSource && saveSource && showErrorSource && sendPatchSource);
  let renders = 0;
  let settingsRenders = 0;
  let orderRenders = 0;
  const savedOrder = ['sinceSeen', 'judgment', 'tasks', 'now', 'prs'];
  const context = pageContext(web, {
    displayPreferences: { mode: 'product', sectionOrder: savedOrder },
    displayPreferencesReady: true,
    displayPreferenceSaveStates: new Map(),
    pendingDisplayChanges: {},
    enqueueDisplayPatch: async () => false,
    settleDisplayPreferenceSaves: null,
    renderSectionOrder: () => { orderRenders += 1; },
    renderDisplaySettings: () => { settingsRenders += 1; },
    lastState: {},
    render: () => { renders += 1; },
  });
  vm.runInContext(`${settleSource}\n${saveSource}\nthis.savePreferences = saveDisplayPreferences;`, context);
  context.settleDisplayPreferenceSaves = context.settleDisplayPreferenceSaves;
  await context.savePreferences({ sectionOrder: ['judgment', 'sinceSeen', 'tasks', 'now', 'prs'] });
  assert.deepEqual(JSON.parse(JSON.stringify(context.displayPreferences.sectionOrder)), savedOrder);
  assert.equal(orderRenders, 1);
  assert.equal(settingsRenders, 1);
  assert.equal(renders, 1);

  const settingsSaveError = { hidden: true, textContent: '' };
  const writeContext = pageContext(web, {
    settingsDialog: { open: true }, settingsSaveError, writeErrorMessage: '', writeErrorUntil: 0,
    writeErrorTimer: null, updateConnectionNote() {}, postUiAction: async () => { throw new Error('offline'); },
    setTimeout: () => 1, clearTimeout() {},
  });
  vm.runInContext(`${showErrorSource}\n${sendPatchSource}\nthis.sendPatch = sendDisplayPatch;`, writeContext);
  assert.equal(await writeContext.sendPatch({ mode: 'kind' }), false);
  assert.equal(settingsSaveError.textContent, '表示の設定を保存できませんでした');
  assert.equal(settingsSaveError.hidden, false);
  assert.match(mock, /settingsSaveError\.textContent = '表示の設定を保存できませんでした'/);
});

test('完了にする操作は 5 秒間取り消せ、再描画中も同じタスクに取り消しを出す', async () => {
  const runSource = `async ${functionSource(web, 'runCloseAction')}`;
  const cancelSource = functionSource(web, 'cancelTaskClose');
  const itemSource = functionSource(web, 'appendTaskItem');
  assert.ok(runSource && cancelSource && itemSource);
  let scheduled;
  let cleared;
  let sent = 0;
  let renders = 0;
  const pending = new Map();
  const context = pageContext(web, {
    pendingTaskCloseActions: pending, lastState: {}, render: () => { renders += 1; },
    sendCloseAction: () => { sent += 1; },
    setTimeout: (callback, delay) => { scheduled = { callback, delay }; return 'timer-1'; },
    clearTimeout: (timer) => { cleared = timer; },
  });
  vm.runInContext(`${runSource}\n${cancelSource}\nthis.runClose = runCloseAction; this.cancelClose = cancelTaskClose;`, context);
  await context.runClose({ dataset: { closeTask: 'session-a::task-a' } }, '/api/closed-tasks', {}, 'failed');
  assert.equal(scheduled.delay, 5000);
  assert.equal(pending.has('session-a::task-a'), true);
  const taskList = fakeElement('ul');
  const taskContext = pageContext(web, {
    pendingTaskCloseActions: pending, taskCloseActionsInFlight: new Set(), element: fakeElement, badge: (label, tone) => fakeElement('span', tone, label),
    appendContextTags() {},
  });
  vm.runInContext(`${itemSource}\nthis.appendTask = appendTaskItem;`, taskContext);
  taskContext.appendTask(taskList, { title: 'task-a', state: 'doing', criteria: [] }, { name: 'project' }, { session_id: 'session-a' });
  assert.ok(descendants(taskList).some((node) => node.dataset.cancelCloseTask === 'session-a::task-a' && node.textContent === '取り消す'));
  context.cancelClose({ dataset: { cancelCloseTask: 'session-a::task-a' } });
  assert.equal(cleared, 'timer-1');
  scheduled.callback();
  assert.equal(pending.size, 0);
  assert.equal(sent, 0);
  assert.equal(renders, 2);
  assert.match(web, /item\.dataset\.closeTask === focusData\.key \|\| item\.dataset\.cancelCloseTask === focusData\.key/);
});

test('完了操作の送信中はボタンを無効化し応答後に状態を解除する', async () => {
  const sendSource = `async ${functionSource(web, 'sendCloseAction')}`;
  const runSource = `async ${functionSource(web, 'runCloseAction')}`;
  const itemSource = functionSource(web, 'appendTaskItem');
  assert.ok(sendSource && runSource && itemSource);

  const exercise = async (shouldFail) => {
    const key = 'session-a::task-a';
    const pending = new Map();
    const inFlight = new Set();
    let scheduled;
    let resolveRequest;
    let rejectRequest;
    let renders = 0;
    const request = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    const context = pageContext(web, {
      pendingTaskCloseActions: pending, taskCloseActionsInFlight: inFlight, lastState: {},
      render: () => { renders += 1; },
      setTimeout: (callback, delay) => { scheduled = { callback, delay }; return 'timer'; },
      postUiAction: () => request, refresh: async () => {},
      liveStatus: { textContent: '' }, showWriteError() {},
    });
    vm.runInContext(`${sendSource}\n${runSource}\n${itemSource}\nthis.runClose = runCloseAction; this.appendTask = appendTaskItem;`, context);
    const button = { dataset: { closeTask: key }, disabled: false, isConnected: false };
    await context.runClose(button, '/api/closed-tasks', { session_id: 'session-a', title: 'task-a' }, '失敗');
    assert.equal(scheduled.delay, 5000);
    scheduled.callback();
    assert.equal(inFlight.has(key), true);

    const taskList = fakeElement('ul');
    context.element = fakeElement;
    context.badge = (label, tone) => fakeElement('span', tone, label);
    context.appendContextTags = () => {};
    context.appendTask(taskList, { title: 'task-a', state: 'doing', criteria: [] }, { name: 'project' }, { session_id: 'session-a' });
    const sendingButton = descendants(taskList).find((node) => node.className === 'link-btn close-task');
    assert.equal(sendingButton.textContent, '送信中…');
    assert.equal(sendingButton.disabled, true);

    if (shouldFail) rejectRequest(new Error('offline'));
    else resolveRequest({ ok: true, status: 200 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(inFlight.has(key), false);
    assert.equal(renders, 3);
  };

  await exercise(false);
  await exercise(true);
});

test('マージの確認欄は実行中のボタンをマージ中に変える', () => {
  const confirmationSource = functionSource(web, 'appendPullRequestMergeConfirmation');
  assert.ok(confirmationSource);
  const context = pageContext(web, {
    MERGE_METHOD_LABELS: { merge: 'マージコミット' },
    pullRequestMergeKey: (pullRequest) => pullRequest.mergeRecordKey,
    pullRequestMergeOptionsFor: () => ({ method: 'merge', deleteBranch: false }),
    pullRequestMergeInFlight: new Set(['merge-key']),
    crossReviewState: () => ({ warn: null, note: null }),
    pullRequestMergeConditionWaits: () => [],
    shortShaElement: () => fakeElement('code', '', 'abcdef0'),
    element: fakeElement,
    document: { createTextNode: (text) => fakeElement('#text', '', text) },
  });
  vm.runInContext(`${confirmationSource}\nthis.renderConfirmation = appendPullRequestMergeConfirmation;`, context);
  const target = fakeElement('div');
  context.renderConfirmation(target, { mergeMethods: ['merge'], defaultBranch: 'main', autoDeleteBranch: false }, {
    number: 7, mergeRecordKey: 'merge-key', headRefOid: 'abcdef0123456789', headRefName: 'feature', effectiveBase: 'main', children: [],
  }, false);
  const button = descendants(target).find((node) => node.dataset.mergeGo === 'merge-key');
  assert.equal(button.textContent, '処理中…');
  assert.equal(button.disabled, true);
  assert.match(mock, /merging \? '処理中…'/);
});

test('PR の初回取得中は空一覧の代わりに取得中の案内を出す', () => {
  const resultFunctions = [functionSource(web, 'pullRequestMergeResultLine'), functionSource(web, 'appendPullRequestMergeResults'), functionSource(web, 'appendPullRequestBlock')];
  assert.ok(resultFunctions.every(Boolean));
  const context = pageContext(web, {
    MERGE_METHOD_LABELS: {}, MERGED_VISIBLE_COUNT: 5, displayPreferences: { hideFinished: true },
    pullRequestMergeResults: new Map(), pullRequestRepositoryKey: (group) => `${group.owner}/${group.repo}`,
    element: fakeElement, document: { createTextNode: (text) => fakeElement('#text', '', text) },
    durationAgoLabel: () => '少し前',
  });
  vm.runInContext(`${resultFunctions.join('\n')}\nthis.renderPrGroup = appendPullRequestBlock;`, context);
  const target = fakeElement('div');
  context.renderPrGroup(target, {
    owner: 'example', repo: 'project', product: { key: 'project', name: 'Project' }, trees: [], error: null,
    loading: true, merged: [], mergeHistory: [], fetchedAt: null, checkedAt: null,
  });
  assert.match(target.textContent, /GitHub から取得しています/);
  assert.doesNotMatch(target.textContent, /オープンの PR はありません/);
  assert.match(mock, /p\.repo\.loading \? `<div class="empty">GitHub から取得しています<\/div>`/);
});

test('待ち時間の範囲外は欄の近くに示し、ラベルにも範囲を示す', async () => {
  const inputSource = functionSource(web, 'setDisplaySettingInput');
  const errorSource = functionSource(web, 'displaySettingError');
  const changeSource = functionSource(web, 'changeDisplaySetting');
  assert.ok(inputSource && errorSource && changeSource);
  const longError = { hidden: true, textContent: '' };
  const awayError = { hidden: true, textContent: '' };
  const input = { type: 'number', valueAsNumber: 121, value: '121' };
  const context = pageContext(web, {
    longWaitMinutesInput: input, longWaitMinutesError: longError, awayAnswerWaitMinutesError: awayError,
    displayPreferences: { longWaitMinutes: 15 },
  });
  vm.runInContext(`${inputSource}\n${errorSource}\n${changeSource}\nthis.changeSetting = changeDisplaySetting;`, context);
  assert.equal(await context.changeSetting('longWaitMinutes', input, 1, 120), false);
  assert.equal(longError.hidden, false);
  assert.equal(longError.textContent, '1〜120 分の値を入力してください。');
  assert.equal(input.value, '15');
  assert.match(web, /長く待たせているとみなす時間 \(1〜120 分\)/);
  assert.match(web, /離席中に質問の回答を待つ時間 \(1〜30 分\)/);
  assert.match(web, /id="settings-long-wait-error" role="alert"/);
  assert.match(mock, /id="settings-away-answer-wait-error" role="alert"/);
});

test('モックの終わった項目の表示設定が保存できたら一覧を描き直す', () => {
  const handlerSource = eventListenerSource(mock, 'click');
  assert.ok(handlerSource);
  const previous = { hideFinished: true };
  const button = { dataset: {}, hasAttribute: (name) => name === 'data-show-finished' };
  let savedPreferences;
  let renders = 0;
  const hideFinishedInput = { checked: true };
  const context = pageContext(mock, {
    ui: { hideFinished: true, mode: 'product' }, hideFinishedInput,
    captureDisplayPreferences: () => previous,
    saveDisplayPreferences: (value) => { savedPreferences = value; return true; },
    render: () => { renders += 1; },
  });
  vm.runInContext(`this.handleClick = ${handlerSource};`, context);
  context.handleClick({ target: { closest: () => button } });
  assert.equal(context.ui.hideFinished, false);
  assert.equal(hideFinishedInput.checked, false);
  assert.equal(savedPreferences, previous);
  assert.equal(renders, 1);
});

test('モックで指示欄を編集すると同じカードのエラーを消しフォーカスを保つ', () => {
  const helperSource = functionSource(mock, 'clearAnswerErrorWhenDraftChanges');
  const handlerSource = eventListenerSource(mock, 'input');
  assert.ok(helperSource && handlerSource);
  const key = 'session-a::decision-a';
  const errors = new Map([[key, '回答を送信できませんでした。']]);
  const answer = { choice: 'pick', picks: [], note: '以前の指示', sent: null };
  let removed = false;
  const error = { remove: () => { removed = true; } };
  const send = { disabled: true };
  const card = {
    dataset: { id: 'decision-a', sessionId: 'session-a' },
    querySelector(selector) { return selector === '.answer-error' ? error : selector === '[data-send]' ? send : null; },
  };
  const textarea = {
    value: '修正した指示',
    matches: (selector) => selector === 'textarea[data-note]',
    closest: (selector) => selector === '.decision' ? card : null,
  };
  const document = { activeElement: textarea };
  const context = pageContext(mock, {
    answerErrors: errors, answerOf: () => answer, answerDraftKey: () => key,
    picksOf: (value) => value.choice === 'pick' ? value.picks || [] : [],
    canSend: () => true, answerDirty: () => true, save() {}, document,
    ui: { answers: {} },
  });
  vm.runInContext(`${helperSource}\nthis.handleInput = ${handlerSource};`, context);
  context.handleInput({ target: textarea });
  assert.equal(errors.has(key), false);
  assert.equal(removed, true);
  assert.equal(document.activeElement, textarea);
  assert.equal(answer.note, '修正した指示');
  assert.equal(send.disabled, false);
});
