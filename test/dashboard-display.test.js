const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');
const web = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8');

function functionSource(source, name) {
  return source.match(new RegExp(`function ${name}\\([^\\n]*\\) \\{[\\s\\S]*?\\n\\}`))?.[0];
}

test('再表示案内は描画領域の後にあり、通信案内は上部に残る', () => {
  for (const html of [mock, web]) {
    const connection = html.indexOf('id="connection-note"');
    const root = html.indexOf('id="root"');
    const hiddenKinds = html.indexOf('id="filter-note"');
    const hiddenSessions = html.indexOf('id="excluded-note"');

    assert.ok(connection < root);
    assert.ok(root < hiddenKinds);
    assert.ok(hiddenKinds < hiddenSessions);
  }
});

test('モックと実装の画面スクリプトを構文解析できる', () => {
  for (const html of [mock, web]) {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new vm.Script(script));
  }
});

test('経路札は起動時の設定を表示し、現在と違う設定には変更前を付ける', () => {
  const route = web.match(/const ROUTE = \{[\s\S]*?\n\};/)?.[0];
  const routeValues = web.match(/const ROUTE_VALUES = new Set\([^\n]+/)?.[0];
  const routeName = functionSource(web, 'routeName');
  const routeTag = functionSource(web, 'routeTag');
  const appendModelLine = functionSource(web, 'appendModelLine');
  assert.ok(route && routeValues && routeName && routeTag && appendModelLine);
  const context = vm.createContext({
    routing: { agents: 'claude' },
    codexAgentAvailable: true,
    element: (tag, className, textContent = '') => ({
      tag, className, textContent, children: [],
      append(...items) { this.children.push(...items); },
    }),
  });
  vm.runInContext(`${route}\n${routeValues}\n${routeName}\n${routeTag}\n${appendModelLine}\nthis.routeTag = routeTag; this.appendModelLine = appendModelLine;`, context);

  context.routing.agents = 'default';
  assert.equal(context.routeTag({ active: true, route: 'default' }).textContent, '経路: 既定');
  context.routing.agents = 'claude';
  const tag = context.routeTag({ active: true, route: 'default' });
  assert.equal(tag.textContent, '経路: 既定 (変更前)');
  assert.equal(tag.className, 'route-tag stale');
  assert.equal(context.routeTag({ active: false, route: 'default' }), null);

  const target = { children: [], append(...items) { this.children.push(...items); } };
  context.appendModelLine(target, { agent_id: 'agent-1', active: true, route: 'default', model: 'claude-sonnet-5-5' });
  assert.deepEqual(JSON.parse(JSON.stringify(target.children[0].children.map((item) => item.className))), [
    'route-tag stale', 'model claude',
  ]);
  context.codexAgentAvailable = false;
  assert.equal(context.routeTag({ active: true, route: 'default' }), null);
});

test('経路設定は上部バーにあり、サブエージェントの三択を API に保存する', () => {
  const routing = functionSource(web, 'renderRouting');
  const updateRouting = functionSource(web, 'updateRouting');
  assert.ok(web.indexOf('id="routing"') < web.indexOf('id="settings-button"'));
  assert.match(routing, /data-route="\$\{key\}"/);
  assert.match(routing, /aria-pressed=/);
  assert.match(updateRouting, /postUiAction\('\/api\/routing'/);
  assert.match(web, /agents: \{ label: 'サブエージェント'/);
  assert.match(web, /review: \{ label: 'クロスレビュー'/);
});

test('経路の二段は実際の幅が収まる場合だけ横に並べる', () => {
  const layoutRouting = functionSource(web, 'layoutRouting');
  assert.ok(layoutRouting);
  assert.match(web, /const ROUTING_PAIR_GAP_PX = 12/);
  assert.match(web, /new ResizeObserver\(layoutRouting\)\.observe\(document\.getElementById\('routing'\)\)/);
  assert.match(web, /\.routing \.rgroup\.side-by-side \{ grid-template-columns: repeat\(4, max-content\); \}/);
  assert.match(web, /\.routing \.rgroup\.side-by-side \.rrow \+ \.rrow \.rlabel \{ margin-left: 12px; \}/);

  const widths = [80, 150, 80, 150];
  const classes = new Set();
  const group = {
    clientWidth: 502,
    querySelectorAll: () => widths.map((width) => ({ getBoundingClientRect: () => ({ width }) })),
    classList: {
      toggle(name, enabled) {
        if (enabled) classes.add(name);
        else classes.delete(name);
      },
    },
  };
  const context = vm.createContext({
    document: { querySelector: () => group },
    getComputedStyle: () => ({ columnGap: '10px' }),
  });
  vm.runInContext(`const ROUTING_PAIR_GAP_PX = 12;\n${layoutRouting}\nthis.layoutRouting = layoutRouting;`, context);

  context.layoutRouting();
  assert.equal(classes.has('side-by-side'), true);
  group.clientWidth = 501;
  context.layoutRouting();
  assert.equal(classes.has('side-by-side'), false);
  widths.splice(2);
  group.clientWidth = 1000;
  context.layoutRouting();
  assert.equal(classes.has('side-by-side'), false);
});

test('経路の欄は連携の組み合わせに応じて段を作り直す', async () => {
  const renderRouting = functionSource(web, 'renderRouting');
  const updateRouting = functionSource(web, 'updateRouting');
  const root = { innerHTML: '', hidden: false, dataset: {}, querySelectorAll: () => [] };
  const renderContext = vm.createContext({
    document: { getElementById: () => root },
    window: {},
    layoutRouting() {},
  });
  vm.runInContext(`const ROUTE = {
    agents: { label: 'サブエージェント', opts: [{ v: 'default', t: '既定' }, { v: 'codex', t: 'Codex' }, { v: 'claude', t: 'Claude' }] },
    review: { label: 'クロスレビュー', opts: [{ v: 'default', t: '既定' }, { v: 'codex', t: 'Codex' }, { v: 'claude', t: 'Claude' }] },
  };
  const ROUTE_VALUES = new Set(['default', 'codex', 'claude']);
  let routing = { agents: 'default', review: 'default' };
  ${renderRouting}
  this.renderRouting = renderRouting;`, renderContext);
  renderContext.renderRouting({ agents: 'codex', review: 'claude' }, {});
  assert.equal(root.hidden, true);
  assert.equal(root.innerHTML, '');

  renderContext.renderRouting({ agents: 'codex', review: 'claude' }, { crossReview: true });
  assert.equal(root.hidden, false);
  const reviewButtons = root.innerHTML.match(/<button[^>]*data-route="review"[^>]*>/g) || [];
  const agentButtons = root.innerHTML.match(/<button[^>]*data-route="agents"[^>]*>/g) || [];
  assert.equal(reviewButtons.length, 3);
  assert.equal(agentButtons.length, 0);

  renderContext.renderRouting({ agents: 'codex', review: 'claude' }, { codexAgent: true });
  assert.equal(root.hidden, false);
  const agentsOnly = root.innerHTML;
  assert.equal((agentsOnly.match(/data-route="agents"/g) || []).length, 3);
  assert.doesNotMatch(agentsOnly, /data-route="review"/);

  renderContext.renderRouting({ agents: 'codex', review: 'claude' }, { codexAgent: true, crossReview: true });
  assert.ok(root.innerHTML.indexOf('data-route="agents"') < root.innerHTML.indexOf('data-route="review"'));
  assert.equal((root.innerHTML.match(/data-route="agents"/g) || []).length, 3);
  assert.equal((root.innerHTML.match(/data-route="review"/g) || []).length, 3);
  assert.doesNotMatch(root.innerHTML, /aria-describedby|未対応/);

  renderContext.renderRouting({ agents: 'codex', review: 'claude' }, { crossReview: true });
  assert.equal((root.innerHTML.match(/data-route="agents"/g) || []).length, 0);
  assert.equal((root.innerHTML.match(/data-route="review"/g) || []).length, 3);

  const posts = [];
  const renders = [];
  const updateContext = vm.createContext({
    postUiAction: async (...args) => {
      posts.push(args);
      return { ok: true, json: async () => ({ agents: 'codex', review: 'claude' }) };
    },
    renderRouting: (...args) => renders.push(args),
    codexAgentAvailable: true,
    crossReviewAvailable: true,
    lastState: null,
    liveStatus: { textContent: '' },
    showWriteError() {},
  });
  vm.runInContext(`async ${updateRouting}\nthis.updateRouting = updateRouting;`, updateContext);
  await updateContext.updateRouting({ dataset: { route: 'review', v: 'claude' } });
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [['/api/routing', { key: 'review', value: 'claude' }]]);
  assert.deepEqual(JSON.parse(JSON.stringify(renders[0][1])), { codexAgent: true, crossReview: true });
});

test('未完了タスクの完了ボタンは閉じる API を呼び、ボタン用の識別子を送る', () => {
  const closeTaskButton = functionSource(web, 'closeTaskButton');
  assert.ok(closeTaskButton);
  const calls = [];
  const context = vm.createContext({
    runCloseAction: (...args) => { calls.push(args); },
  });
  vm.runInContext(`${closeTaskButton}\nthis.closeTaskButton = closeTaskButton;`, context);
  context.closeTaskButton({ dataset: { closeTask: 'session-a::タスクの題' } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], '/api/closed-tasks');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), {
    session_id: 'session-a', title: 'タスクの題',
  });
  assert.match(web, /if \(button\.dataset\.closeTask\) \{\s*closeTaskButton\(button\);/);
  assert.match(web, /'完了にする'/);
  assert.match(web, /close\.dataset\.closeTask = `\$\{session\.session_id\}::\$\{task\.title\}`/);
});

test('終了未確認のサブエージェント行に終了 API を呼ぶボタンを置く', () => {
  const closeAgentButton = functionSource(web, 'closeAgentButton');
  const calls = [];
  const context = vm.createContext({
    runCloseAction: (...args) => { calls.push(args); },
  });
  vm.runInContext(`${closeAgentButton}\nthis.closeAgentButton = closeAgentButton;`, context);
  context.closeAgentButton({ dataset: { closeAgent: 'session-a::agent-1' } });

  assert.equal(calls.length, 1);
  assert.equal(calls[0][1], '/api/closed-agents');
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0][2])), {
    session_id: 'session-a', agent_id: 'agent-1',
  });
  assert.match(web, /if \(button\.dataset\.closeAgent\) \{\s*closeAgentButton\(button\);/);
  assert.match(web, /close\.dataset\.closeAgent = `\$\{session\.session_id\}::\$\{agent\.agent_id\}`/);
});

test('表示設定はサーバーの null のときだけ旧 localStorage から移し、通常変更は差分で送る', async () => {
  const sync = `async ${functionSource(web, 'syncDisplayPreferences')}`;
  const syncCalls = [];
  let legacyReads = 0;
  const context = vm.createContext({
    displayPreferences: {},
    displayPreferencesReady: false,
    displayMigrationPending: false,
    displayMigrationData: null,
    pendingDisplayChanges: {},
    pendingDisplayRequests: 0,
    readDisplayPreferences: () => {
      legacyReads += 1;
      return { mode: 'kind', order: ['legacy'], pinned: [], collapsed: [], hidden: [] };
    },
    normalizeDisplayPreferences: (value) => value,
    enqueueDisplayPatch: async (patch) => { syncCalls.push(patch); return true; },
    clearLegacyDisplayPreferences() {},
  });
  vm.runInContext(`${sync}\nthis.syncDisplayPreferences = syncDisplayPreferences;`, context);
  await context.syncDisplayPreferences(null);
  assert.equal(legacyReads, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(syncCalls[0])), {
    mode: 'kind', order: ['legacy'], pinned: [], collapsed: [], hidden: [],
  });

  const readyContext = vm.createContext({
    displayPreferences: {},
    displayPreferencesReady: false,
    displayMigrationPending: false,
    displayMigrationData: null,
    pendingDisplayChanges: {},
    pendingDisplayRequests: 0,
    readDisplayPreferences: () => { throw new Error('旧設定は読み込まない'); },
    normalizeDisplayPreferences: (value) => value,
    enqueueDisplayPatch: async (patch) => { syncCalls.push(patch); return true; },
    clearLegacyDisplayPreferences() {},
  });
  vm.runInContext(`${sync}\nthis.syncDisplayPreferences = syncDisplayPreferences;`, readyContext);
  await readyContext.syncDisplayPreferences({ mode: 'product', order: [], pinned: [], collapsed: [], hidden: [] });

  const save = functionSource(web, 'saveDisplayPreferences');
  const saveContext = vm.createContext({
    displayPreferences: { mode: 'product', order: [], pinned: [], collapsed: [], hidden: [] },
    displayPreferencesReady: true,
    pendingDisplayChanges: {},
    enqueueDisplayPatch: (patch) => { syncCalls.push(patch); },
  });
  vm.runInContext(`${save}\nthis.saveDisplayPreferences = saveDisplayPreferences;`, saveContext);
  saveContext.saveDisplayPreferences({ mode: 'kind' });

  assert.deepEqual(JSON.parse(JSON.stringify(syncCalls[1])), { mode: 'kind' });
  assert.equal(syncCalls.length, 2);
});

test('種類別の並び順は最初のセクションより前に置く', () => {
  const mockKind = functionSource(mock, 'renderKindMode');
  const webKind = functionSource(web, 'renderKindSections');

  assert.match(mockKind, /return orderBar\s*\+\s*\(news \?/);
  assert.doesNotMatch(mockKind, /section\('あなたの判断が必要なこと[^\n]*, orderBar\)/);
  assert.match(webKind, /const sections = \[productOrder\]/);
  assert.match(webKind, /sections\.push\(kindSection\('あなたの判断が必要なこと/);
  assert.doesNotMatch(webKind, /kindSection\('あなたの判断が必要なこと[^\n]*, productOrder\)/);
});

test('種類別のタスクにはタスクがあるセッションだけを含める', () => {
  const mockKind = functionSource(mock, 'renderKindMode');
  const webKind = functionSource(web, 'renderKindSections');

  assert.match(mockKind, /sessions\.filter\(\(\{ session \}\) => session\.tasks\.length > 0\)/);
  assert.match(mockKind, /\|\| '<div class="empty">ありません<[/]div>'/);
  assert.match(webKind, /if \(!session\.tasks\.length\) continue/);
  assert.match(webKind, /if \(!tasks\.children\.length\) tasks\.append\(element\('div', 'empty', 'ありません'\)\)/);
});

test('許可待ちと判断事項のフィルターは非表示の行を検出する', () => {
  const context = vm.createContext({ displayPreferences: { hidden: [] } });
  const helpers = ['isFilterShown', 'hasEffectiveAnswer', 'shownActiveDecisions', 'hasHiddenJudgmentItems']
    .map((name) => functionSource(web, name));
  assert.ok(helpers.every(Boolean));
  vm.runInContext(`${helpers.join('\n')}\nthis.hasHidden = hasHiddenJudgmentItems;`, context);

  const categories = [
    ['permission', { permissionWaits: [{}], decisions: [] }],
    ['blocking', { permissionWaits: [], decisions: [{ state: 'waiting', answer: null }] }],
    ['provisional', { permissionWaits: [], decisions: [{ state: 'provisional', answer: null }] }],
    ['held', { permissionWaits: [], decisions: [{ state: 'waiting', answer: { choice: 'hold' } }] }],
  ];

  for (const [category, session] of categories) {
    context.displayPreferences.hidden = [];
    assert.equal(context.hasHidden(session), false);
    context.displayPreferences.hidden = [category];
    assert.equal(context.hasHidden(session), true);
  }
});

test('PRフィルターの札はマージできる件数を表示する', () => {
  const filters = web.match(/const FILTERS = \[[\s\S]*?\n\];/)?.[0];
  const renderSummary = functionSource(web, 'renderSummary');
  const summary = { children: [], replaceChildren(...children) { this.children = children; } };
  const filterNote = { replaceChildren() {} };
  const element = (tag, className, textContent = '') => ({
    tag, className, textContent, children: [], dataset: {}, attributes: {},
    append(...items) { this.children.push(...items); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {},
  });
  const context = vm.createContext({
    summary,
    displayPreferences: { hidden: [] },
    pullRequestMergeableCount: (groups) => groups.reduce((count, group) => count + group.mergeableCount, 0),
    pullRequestOpenCount: () => 0,
    isPendingDecision: () => false,
    isHeldDecision: () => false,
    hasEffectiveAnswer: () => false,
    element,
    document: {
      createTextNode: (textContent) => ({ textContent }),
      getElementById: () => filterNote,
    },
  });
  vm.runInContext(`${filters}\n${renderSummary}\nthis.renderSummary = renderSummary;`, context);
  context.renderSummary([], [{ mergeableCount: 2 }, { mergeableCount: 1 }]);

  const chip = summary.children.find((item) => item.dataset.filter === 'prs');
  assert.ok(chip);
  assert.equal(chip.children.find((item) => item.tag === 'strong').textContent, '3');
});

test('PRフィルターの切り替えは保存し、両表示モードのPR欄を隠す', () => {
  const toggleFilter = functionSource(web, 'toggleFilter');
  const productSection = functionSource(web, 'productSection');
  const kindSections = functionSource(web, 'renderKindSections');
  const patches = [];
  let renders = 0;
  const context = vm.createContext({
    displayPreferences: { hidden: [] },
    lastState: { sessions: [], pullRequests: [] },
    isFilterShown: (key) => !context.displayPreferences.hidden.includes(key),
    saveDisplayPreferences: (patch) => {
      patches.push(patch);
      Object.assign(context.displayPreferences, patch);
    },
    render: () => { renders += 1; },
  });
  vm.runInContext(`${toggleFilter}\nthis.toggleFilter = toggleFilter;`, context);
  context.toggleFilter('prs');
  assert.deepEqual(JSON.parse(JSON.stringify(context.displayPreferences.hidden)), ['prs']);
  context.toggleFilter('prs');
  assert.deepEqual(JSON.parse(JSON.stringify(context.displayPreferences.hidden)), []);
  assert.deepEqual(JSON.parse(JSON.stringify(patches.map((patch) => patch.hidden))), [['prs'], []]);
  assert.equal(renders, 2);
  assert.match(productSection, /if \(isFilterShown\('prs'\)\)/);
  assert.match(kindSections, /if \(isFilterShown\('prs'\)\)/);
});

test('サブエージェントを隠したときに空の案内を出さない', () => {
  const mockAgentSection = functionSource(mock, 'agentSection');
  const mockContext = {
    ui: { expandedEndedAgents: [] },
    isShown: () => false,
    visibleSubagents: (session) => session.subagents.filter((agent) => agent.state !== 'busy'),
    isEndedAgent: () => false,
    ageMinutes: () => 0,
    agentRow: () => '<div>agent</div>',
    endedAgentToggle: () => '',
  };
  const mockResult = vm.runInNewContext(`(${mockAgentSection})`, mockContext)(
    {}, { id: 'session-a', subagents: [{ state: 'busy' }] }, true,
  );
  assert.equal(mockResult, '');

  const appendAgents = functionSource(web, 'appendAgents');
  const body = { children: [], append(item) { this.children.push(item); } };
  const webContext = {
    expandedEndedSessions: new Set(),
    isFilterShown: () => false,
    newestFirst: (items) => items,
    isEndedAgent: (agent) => !agent.active && !agent.unconfirmed,
  };
  vm.runInNewContext(`(${appendAgents})`, webContext)(
    body,
    { session_id: 'session-a', agents: [{ active: true }] },
    {},
  );
  assert.equal(body.children.length, 0);
});

test('種類別の混在セクションは残し、隠した判断事項だけを空表示にしない', () => {
  const mockKind = functionSource(mock, 'renderKindMode');
  const webKind = functionSource(web, 'renderKindSections');

  assert.match(mockKind, /const showJudgment = Boolean\(decisionItems\) \|\| !hiddenJudgmentItems/);
  assert.match(mockKind, /const now = `?<div class="now">/);
  assert.match(webKind, /if \(waitingItems\.length \|\| endedDecisionItems\.length \|\| !hasHiddenJudgments\)/);
  assert.match(webKind, /activityItems\.push\(\{ age: sessionActivityTime\(session\), row: mainRow/);
});

test('種類別の終了判断は新しい順に集約し、終了済みエージェントは件数を数える', () => {
  const webHelpers = [
    functionSource(web, 'itemTimestamp'),
    functionSource(web, 'kindEndedDecisionEntries'),
    functionSource(web, 'kindEndedAgentCount'),
    functionSource(web, 'taskVisibility'),
    functionSource(web, 'kindDoneTaskCount'),
    functionSource(web, 'kindTodoTaskCount'),
  ];
  const webContext = vm.createContext({ isEndedAgent: (agent) => !agent.active && !agent.unconfirmed });
  vm.runInContext(`${webHelpers.join('\n')}\nthis.collect = (references) => JSON.stringify({
    decisions: kindEndedDecisionEntries(references).map(({ decision }) => decision.id),
    endedAgentCount: kindEndedAgentCount(references),
    fallbackTimestamp: itemTimestamp({ startedAt: '2026-10-02T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' }),
    doneCount: kindDoneTaskCount(references),
    todoCount: kindTodoTaskCount(references),
    collapsed: taskVisibility(references[0].session, false, false).visible.map((task) => task.id),
    todoExpanded: taskVisibility(references[0].session, true, false).visible.map((task) => task.id),
    expanded: taskVisibility(references[0].session, true, true).visible.map((task) => task.id),
  });`, webContext);
  const webReferences = [
    { product: { name: 'A' }, session: {
      decisions: [
        { id: 'old', state: 'resolved', createdAt: '2026-10-01T00:00:00Z' },
        { id: 'active', state: 'waiting', createdAt: '2026-10-03T00:00:00Z' },
      ],
      agents: [{ id: 'agent-old', active: false, startedAt: '2026-10-01T00:00:00Z' }],
      tasks: [{ id: 'open', state: 'todo' }, { id: 'doing', state: 'doing' }, { id: 'done-a', state: 'done' }],
    } },
    { product: { name: 'B' }, session: {
      decisions: [
        { id: 'new', state: 'withdrawn', createdAt: '2026-10-02T00:00:00Z' },
        { id: 'active-new', state: 'waiting', createdAt: '2026-10-03T00:00:00Z' },
      ],
      agents: [
        { id: 'agent-new', active: false, startedAt: '2026-10-02T00:00:00Z' },
        { id: 'running', active: true, startedAt: '2026-10-03T00:00:00Z' },
      ],
      tasks: [{ id: 'done-b', state: 'done' }],
    } },
  ];
  const webResult = JSON.parse(webContext.collect(webReferences));
  assert.deepEqual(webResult, {
    decisions: ['new', 'old'],
    endedAgentCount: 2,
    fallbackTimestamp: Date.parse('2026-10-02T00:00:00Z'),
    doneCount: 2,
    todoCount: 1,
    collapsed: ['doing'],
    todoExpanded: ['open', 'doing'],
    expanded: ['open', 'doing', 'done-a'],
  });

  const mockHelpers = [
    functionSource(mock, 'kindEndedDecisionEntries'),
    functionSource(mock, 'kindEndedAgentCount'),
    functionSource(mock, 'taskVisibility'),
    functionSource(mock, 'kindDoneTaskCount'),
    functionSource(mock, 'kindTodoTaskCount'),
  ];
  const mockContext = vm.createContext({
    effectiveDecisionState: (decision) => decision.state,
    ageMinutes: (item) => item.age,
    isEndedAgent: (_session, agent) => agent.ended,
    taskState: (session, task) => session.closed?.includes(task.id) ? 'done' : task.state,
  });
  vm.runInContext(`${mockHelpers.join('\n')}\nthis.collect = (sessions) => JSON.stringify({
    decisions: kindEndedDecisionEntries(sessions).map(({ decision }) => decision.id),
    endedAgentCount: kindEndedAgentCount(sessions),
    doneCount: kindDoneTaskCount(sessions),
    todoCount: kindTodoTaskCount(sessions),
    collapsed: taskVisibility(sessions[0].session, false, false).visible.map((task) => task.id),
    todoExpanded: taskVisibility(sessions[0].session, true, false).visible.map((task) => task.id),
    expanded: taskVisibility(sessions[0].session, true, true).visible.map((task) => task.id),
  });`, mockContext);
  const mockSessions = [
    { p: { name: 'A' }, session: {
      decisions: [{ id: 'old', state: 'resolved', age: 10 }, { id: 'active', state: 'waiting', age: 0 }],
      subagents: [{ id: 'agent-old', ended: true, age: 10 }],
      tasks: [{ id: 'open', state: 'todo' }, { id: 'doing', state: 'doing' }, { id: 'done-a', state: 'done' }],
    } },
    { p: { name: 'B' }, session: {
      decisions: [{ id: 'new', state: 'withdrawn', age: 2 }],
      subagents: [{ id: 'agent-new', ended: true, age: 2 }, { id: 'running', ended: false, age: 0 }],
      tasks: [{ id: 'closed-here', state: 'todo' }],
    } },
  ];
  mockSessions[1].session.closed = ['closed-here'];
  assert.deepEqual(JSON.parse(mockContext.collect(mockSessions)), {
    decisions: ['new', 'old'],
    endedAgentCount: 2,
    doneCount: 2,
    todoCount: 1,
    collapsed: ['doing'],
    todoExpanded: ['open', 'doing'],
    expanded: ['open', 'doing', 'done-a'],
  });
});

test('種類別の折り畳み文言と状態はセクション単位で切り替わる', () => {
  const webToggle = functionSource(web, 'appendKindToggle');
  const labelSource = functionSource(web, 'kindToggleLabel');
  const appended = [];
  const context = vm.createContext({
    expandedKindSections: new Set(),
    lastState: null,
    root: { querySelectorAll: () => [] },
    element: (_tag, className, text) => ({
      className,
      textContent: text,
      dataset: {},
      attributes: {},
      setAttribute(name, value) { this.attributes[name] = value; },
      addEventListener(_event, callback) { this.onClick = callback; },
      focus() {},
    }),
  });
  vm.runInContext(`${labelSource}\n${webToggle}\nthis.label = kindToggleLabel; this.appendToggle = appendKindToggle;`, context);
  const body = { append: (button) => appended.push(button) };
  context.appendToggle(body, 'decisions', false, 4, '解決済みと取り下げ');
  assert.equal(appended[0].textContent, '解決済みと取り下げを表示 (4 件)');
  assert.equal(appended[0].dataset.kindToggle, 'decisions');
  assert.equal(appended[0].attributes['aria-expanded'], 'false');
  appended[0].onClick();
  assert.equal(context.expandedKindSections.has('decisions'), true);
  assert.equal(context.label('解決済みと取り下げ', true, 4), '解決済みと取り下げを畳む');
  assert.equal(context.label('終了済み', false, 2), '終了済みを表示 (2 件)');
  assert.equal(context.label('完了したタスク', false, 3), '完了したタスクを表示 (3 件)');

  const mockLabel = functionSource(mock, 'kindToggleLabel');
  const mockToggle = functionSource(mock, 'kindToggle');
  const mockContext = vm.createContext({});
  vm.runInContext(`${mockLabel}\n${mockToggle}\nthis.makeToggle = kindToggle;`, mockContext);
  assert.match(mockContext.makeToggle('tasks', '完了したタスク', 3, false), /完了したタスクを表示 \(3 件\)/);
  assert.match(mockContext.makeToggle('tasks', '完了したタスク', 3, false), /data-kind-toggle="tasks"/);
  assert.match(mockContext.makeToggle('tasks', '完了したタスク', 3, true), /完了したタスクを畳む/);
});

test('種類別タスクのまとまりは先頭行に札と更新時刻を置き、カードから札を外す', () => {
  const mockTaskBlock = functionSource(mock, 'kindTaskSessionBlock');
  const mockVisibility = functionSource(mock, 'taskVisibility');
  const mockContext = vm.createContext({
    taskState: (_session, task) => task.state,
    ui: { expandedKindTodoTasks: false },
    sessionTag: (_product, _session, _withTag, includeSession) => includeSession ? 'PRODUCT SESSION' : '',
    taskItem: (_product, _session, task, withTag) => `<li data-tags="${withTag}">${task.title}</li>`,
  });
  vm.runInContext(`${mockVisibility}\n${mockTaskBlock}\nthis.renderTasks = kindTaskSessionBlock;`, mockContext);
  const output = mockContext.renderTasks(
    { name: 'agent-cockpit' },
    { id: 'session-a', tasksUpdatedMin: 5, tasks: [{ title: '表示タスク', state: 'doing' }, { title: '未着手タスク', state: 'todo' }, { title: '完了タスク', state: 'done' }] },
    false,
  );
  assert.match(output.html, /class="kind-task-head">PRODUCT SESSION<span class="meta">最終更新 5 分前<\/span>/);
  assert.doesNotMatch(output.html, /タスクと完了条件/);
  assert.match(output.html, /<li data-tags="false">表示タスク<\/li>/);
  assert.doesNotMatch(output.html, /未着手タスク/);
  assert.doesNotMatch(output.html, /完了タスク/);
  assert.equal(output.doneCount, 1);

  const webKind = functionSource(web, 'renderKindSections');
  const webTaskBlock = functionSource(web, 'appendKindTaskSession');
  assert.match(webKind, /appendKindTaskSession\(tasks, \{ product, session, multipleSessions \}, showTodoTasks, showDoneTasks\)/);
  assert.match(webKind, /appendKindToggle\(tasks, 'todoTasks', showTodoTasks, todoTaskCount, '未着手のタスク'\)/);
  assert.match(webKind, /appendKindToggle\(tasks, 'tasks', showDoneTasks, doneTaskCount, '完了したタスク'\)/);
  assert.match(webTaskBlock, /appendContextTags\(heading, product, session, true, true\)/);
  assert.match(webTaskBlock, /appendTaskItem\(list, task, product, session, false, multipleSessions\)/);
  assert.match(web, /\.kind-session-tasks \+ \.kind-session-tasks \{[^}]*border-top: 1px solid var\(--border\)/);
});

test('種類別の描画では集約折り畳みだけを使い、プロダクト別のセッション単位は残す', () => {
  const mockKind = functionSource(mock, 'renderKindMode');
  const webKind = functionSource(web, 'renderKindSections');

  assert.match(mockKind, /kindToggle\('decisions', '解決済みと取り下げ', endedDecisionEntries\.length/);
  assert.match(mockKind, /kindToggle\('agents', '終了済み', endedAgentCount/);
  assert.match(mockKind, /kindToggle\('tasks', '完了したタスク', doneTaskCount/);
  assert.match(mockKind, /kindToggle\('todoTasks', '未着手のタスク', todoTaskCount/);
  assert.doesNotMatch(mockKind, /endedDecisionToggle\(session\)|endedAgentToggle\(session\)|taskSessionBlock\(p, session, true\)/);
  assert.match(webKind, /appendKindToggle\(endedDecisions, 'decisions'/);
  assert.match(webKind, /appendKindToggle\(activity, 'agents'/);
  assert.match(webKind, /appendKindToggle\(tasks, 'tasks'/);
  assert.doesNotMatch(webKind, /appendPlanToggle\(endedDecisions|appendAgents\([^\n]*\);\s*\n\s*const list = holder\.querySelector\('\.agent-list'\);[\s\S]*data-ended-toggle/);

  assert.match(mock, /function decisionSessionBlock\([^]*?endedDecisionToggle\(session\)/);
  assert.match(mock, /function taskSessionBlock\([^]*?data-done-tasks/);
  assert.match(mock, /function taskSessionBlock\([^]*?data-todo-tasks/);
  assert.match(web, /function appendDecisions\([^]*?appendPlanToggle\(body, 'decisions', session\.session_id/);
  assert.match(web, /function appendTasks\([^]*?appendPlanToggle\(body, 'tasks', session\.session_id/);
  assert.match(web, /function appendTasks\([^]*?appendPlanToggle\(body, 'todoTasks', session\.session_id/);
});
