const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readWebPage, cssDeclarations, functionSource, displayPageContext: pageContext } = require('./support/page-context');

const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');
const web = readWebPage();

test('接続案内は一覧の前に、注記は一覧の後ろに置き、固定表示に含めない', () => {
  for (const html of [mock, web]) {
    const header = html.indexOf('<header class="top">');
    const headerEnd = html.indexOf('</header>', header);
    const summary = html.indexOf('id="summary"');
    const root = html.indexOf('id="root"');
    const connection = html.indexOf('id="connection-note"');
    const reload = html.indexOf('id="reload-note"');
    const hiddenKinds = html.indexOf('id="filter-note"');
    const hiddenSessions = html.indexOf('id="excluded-note"');
    const finished = html.indexOf('id="finished-note"');
    const idle = html.indexOf('id="idle-note"');

    assert.ok(header >= 0 && summary > header && summary < headerEnd);
    assert.ok(headerEnd < connection);
    assert.ok(connection < reload);
    assert.ok(reload < root);
    assert.ok(root < hiddenKinds);
    assert.ok(hiddenKinds < hiddenSessions);
    assert.ok(hiddenSessions < finished);
    assert.match(html.slice(finished), /id="finished-note" role="status" aria-live="polite" hidden><\/div>\s*<div class="excluded-note" id="idle-note"/);
    assert.ok(finished < idle);
  }
});

test('推奨の札と選択サマリーを保ち、回答欄から推奨チェックを除く', () => {
  for (const html of [mock, web]) {
    assert.doesNotMatch(html, /OK で送る答え:|answer-choice|data-answer-choice|data-choice="ok"/);
    assert.match(html, /照合する head SHA:/);
    assert.match(html, /選択した条件の未達:/);
  }
  assert.match(web, /badge\('推奨', 'busy'\)/);
  assert.match(mock, /<span class="tag">推奨<\/span>/);
  assert.match(web, /選択: \$\{choices\}/);
  assert.match(mock, /選択: \$\{esc\(chosen\)\}/);
});

test('削除済みの説明文と描画要素の名残を含めない', () => {
  const removedCopy = [
    /許可はデスクトップアプリの .*ダッシュボードからは出せない/,
    /質問はデスクトップアプリの .*セッションで答える/,
    /ほかの案は押して選べる|推奨が無いので、選択肢を押して選ぶか、指示の欄に答えを書く/,
    /結果を PR を作ったセッションへ知らせる|このセッションが作った PR はありません/,
    /リモートのブランチ .* は GitHub が自動で削除する/,
  ];
  for (const html of [mock, web]) {
    assert.doesNotMatch(html, /kind-order|product-order-item|kind-product-order|kindProductOrder/);
    for (const phrase of removedCopy) assert.doesNotMatch(html, phrase);
    const filters = html.match(/const FILTERS = \[[\s\S]*?\n\];/)?.[0];
    assert.ok(filters);
    assert.equal(html.includes('判断を保留する'), false);
    assert.equal(filters.includes('保留中'), false);

    assert.equal(cssDeclarations(html, '.product-order-item').length, 0);
    assert.equal(cssDeclarations(html, '.kind-order').length, 0);
  }
  assert.match(mock, /ui\.hidden = Array\.isArray\(ui\.hidden\).*FILTERS\.some/);
  assert.ok(cssDeclarations(web, '.order').length > 0);
  assert.deepEqual(cssDeclarations(web, '.order'), cssDeclarations(mock, '.order'));

  const mockKind = functionSource(mock, 'renderKindMode');
  const webKind = functionSource(web, 'renderKindSections');
  assert.doesNotMatch(mockKind, /orderBar|kind-order|kindProductOrder/);
  assert.doesNotMatch(webKind, /kindProductOrder|kind-order|productOrder/);
  assert.doesNotMatch(mockKind, /endedDecisionToggle\(session\)|endedAgentToggle\(session\)|taskSessionBlock\(p, session, true\)/);
  assert.doesNotMatch(webKind, /appendPlanToggle\(endedDecisions|appendAgents\([^\n]*\);\s*\n\s*const list = holder\.querySelector\('\.agent-list'\);[\s\S]*data-ended-toggle/);
  assert.doesNotMatch(web, /function reviewBlock|group\.reviews|data-reserve-go=/);
});

test('モックと実装の画面スクリプトを構文解析できる', () => {
  for (const html of [mock, web]) {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new vm.Script(script));
  }
});

test('モックに合わせた配色、札、タスク行を表示する', () => {
  const webMergeButton = Object.fromEntries(cssDeclarations(web, '.merge-btn'));
  const mockMergeButton = Object.fromEntries(cssDeclarations(mock, '.merge-btn'));
  assert.equal(webMergeButton.color, 'var(--on-ok)');
  assert.deepEqual(Object.entries(webMergeButton).sort(), Object.entries(mockMergeButton).sort());
  assert.equal((web.match(/--on-ok: #1f1e1d;/g) || []).length, 2);
  assert.equal(Object.fromEntries(cssDeclarations(web, '.merge-confirm .merge-go')).color, 'var(--on-ok)');
  assert.match(web, /reservationToggle\.dataset\.reservationToggle = mergeKey/);
  assert.doesNotMatch(web, /mergeAfterReviewDefault|data-merge-after-review/);
  assert.equal(Object.fromEntries(cssDeclarations(web, '.merge-confirm.conflict .conflict-go')).color, 'var(--on-danger)');
  assert.deepEqual(Object.fromEntries(cssDeclarations(web, '.badge.new-mark')), {
    background: 'var(--accent)', color: 'var(--on-accent)',
  });
  assert.ok(cssDeclarations(web, '.permission code').length > 0);
  assert.equal(Object.fromEntries(cssDeclarations(web, '.settings-dialog')).width, 'min(440px, calc(100vw - 32px))');
  assert.equal(Object.fromEntries(cssDeclarations(web, '.away-toggle'))['min-height'], '40px');
  assert.equal(Object.fromEntries(cssDeclarations(web, '.criteria-list li::marker')).content, '"・"');
  assert.equal(Object.fromEntries(cssDeclarations(web, '.criteria-list li.doing')).color, 'var(--text)');
  assert.equal(Object.fromEntries(cssDeclarations(web, '.criteria-list li.doing::marker')).content, '"→ "');
  assert.deepEqual(Object.fromEntries(cssDeclarations(web, '.criteria-list li.doing')),
    Object.fromEntries(cssDeclarations(mock, '.criteria li.doing')));
  assert.deepEqual(Object.fromEntries(cssDeclarations(web, '.criteria-list li.doing::marker')),
    Object.fromEntries(cssDeclarations(mock, '.criteria li.doing::marker')));

  const taskRowStyle = Object.fromEntries(cssDeclarations(web, '.task-item'));
  const taskTitleStyle = Object.fromEntries(cssDeclarations(web, '.task-title'));
  assert.ok(Object.keys(taskRowStyle).length && Object.keys(taskTitleStyle).length);
  assert.equal(taskRowStyle.background, undefined);
  assert.equal(taskTitleStyle['font-weight'], undefined);
  assert.equal(Object.fromEntries(cssDeclarations(web, '.task-item:hover')).background, 'var(--surface-2)');
  for (const [source, row, title] of [[web, '.task-head', '.task-title'], [mock, '.task .line', '.task .line > .title']]) {
    assert.equal(Object.fromEntries(cssDeclarations(source, row))['flex-wrap'], undefined, `${row} は題の中で折り返す`);
    assert.equal(Object.fromEntries(cssDeclarations(source, `${row} > *`)).flex, 'none');
    assert.match(source, new RegExp(`${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^{]*\\{[^}]*flex: 0 1 auto; min-width: 0;`));
  }
  for (const selector of ['.task-body', '.task-text', '.task-actions', '.task-actions .link-btn', '.task-actions .link-btn:hover', '.close-note > span', '.pr-body', '.pr-text','.pr-text > .badges', '.pr-actions', '.pr-actions .merge-btn, .pr-actions .conflict-btn', '.merge-state', '.merge-state.ok', '.pr .pline', '.pr .pline > *', '.pr .pline > .ptitle']) {
    assert.deepEqual(cssDeclarations(web, selector), cssDeclarations(mock, selector), `${selector} はモックとそろえる`);
  }
  assert.equal(Object.fromEntries(cssDeclarations(web, '.pr-text'))['min-width'], '0', '題は左の列の中で折り返す');
  assert.equal(Object.fromEntries(cssDeclarations(web, '.pr-actions')).flex, 'none');
  assert.equal(Object.fromEntries(cssDeclarations(web, '.pr-actions'))['min-width'], 'calc(6.5em + 11px)', 'マージできる行どうしで操作の列の幅をそろえる');
  assert.match(web, /@media \(max-width: 480px\) \{\s*\.task-head \{ flex-wrap: wrap; \}/);
  assert.match(mock, /@media \(max-width: 480px\) \{\s*\.task \.line \{ flex-wrap: wrap; \}/);

  const appendTaskItem = functionSource(web, 'appendTaskItem');
  const appendDecisionCard = functionSource(web, 'appendDecisionCard');
  assert.ok(appendTaskItem && appendDecisionCard);
  assert.ok(appendTaskItem.indexOf('header.append(badge(') < appendTaskItem.indexOf('appendContextTags(header'));
  assert.ok(appendTaskItem.indexOf('appendContextTags(header') < appendTaskItem.indexOf("element('span', 'task-title'"));
  assert.ok(appendDecisionCard.indexOf("badge('推奨', 'busy')") < appendDecisionCard.indexOf('body.append(element(\'span\', \'\', displayLabel))'));
  assert.match(web, /agent\.startedAt \? durationAgoLabel\(agent\.startedAt\)/);
  assert.match(web, /GitHub から \$\{durationAgoLabel\(group\.fetchedAt \|\| group\.checkedAt\)\}に取得/);
  assert.match(mock, /class="badge permission">\$\{stateLabel\}/);
  assert.match(mock, /マージ済み \(24 時間\)/);
  assert.match(mock, /\['squash', 'rebase'\]\.includes\(o\.method\)/);
  assert.match(mock, /PR #57 の CI が失敗した'/);
});

test('経路札は agent_type に対応する現在値と比べ、違えば変更前を付ける', () => {
  const route = web.match(/const ROUTE = \{[\s\S]*?\n\};/)?.[0];
  const routeValues = web.match(/const ROUTE_VALUES = new Set\([^\n]+/)?.[0];
  const routeName = functionSource(web, 'routeName');
  const routeTag = functionSource(web, 'routeTag');
  const appendModelLine = functionSource(web, 'appendModelLine');
  assert.ok(route && routeValues && routeName && routeTag && appendModelLine);
  const context = pageContext(web, {
    routing: { agents: 'claude', review: 'codex' },
    codexAgentAvailable: true,
    element: (tag, className, textContent = '') => ({
      tag, className, textContent, children: [],
      append(...items) { this.children.push(...items); },
    }),
  });
  vm.runInContext(`${route}\n${routeValues}\n${routeName}\n${routeTag}\n${appendModelLine}\nthis.routeTag = routeTag; this.appendModelLine = appendModelLine;`, context);

  context.routing.agents = 'default';
  assert.equal(context.routeTag({ active: true, agent_type: 'impl-hard', route: 'default' }).textContent, '経路: 既定');
  context.routing.agents = 'claude';
  const tag = context.routeTag({ active: true, agent_type: 'impl-hard', route: 'default' });
  assert.equal(tag.textContent, '経路: 既定 (変更前)');
  assert.equal(tag.className, 'route-tag stale');
  assert.equal(context.routeTag({ active: true, agent_type: 'codex-review', route: 'codex' }).textContent, '経路: Codex');
  assert.equal(context.routeTag({ active: false, agent_type: 'codex-review', route: 'codex' }), null);
  context.routing.review = 'default';
  assert.equal(context.routeTag({ active: true, agent_type: 'codex-review', route: 'default' }).textContent, '経路: 既定');
  context.routing.review = 'claude';
  assert.equal(context.routeTag({ active: true, agent_type: 'codex-review', route: 'codex' }).textContent, '経路: Codex (変更前)');

  const mockRoute = mock.match(/const ROUTE = \{[\s\S]*?\n\};/)?.[0];
  const mockRouteName = mock.match(/const routeName = [^\n]+/)?.[0];
  const mockRouteTag = functionSource(mock, 'routeTag');
  assert.ok(mockRoute && mockRouteName && mockRouteTag);
  const mockContext = pageContext(mock, {
    DATA: { integrations: { codexAgent: true } },
    ui: { routing: { agents: 'claude', review: 'codex' } },
    esc: (value) => value,
  });
  vm.runInContext(`${mockRoute}\n${mockRouteName}\n${mockRouteTag}\nthis.routeTag = routeTag;`, mockContext);
  assert.doesNotMatch(mockContext.routeTag({ state: 'busy', agent_type: 'codex-review', route: 'codex' }), /変更前/);
  assert.match(mockContext.routeTag({ state: 'busy', agent_type: 'impl-hard', route: 'codex' }), /変更前/);
  mockContext.ui.routing.review = 'default';
  assert.doesNotMatch(mockContext.routeTag({ state: 'busy', agent_type: 'codex-review', route: 'default' }), /変更前/);

  const target = { children: [], append(...items) { this.children.push(...items); } };
  context.appendModelLine(target, { agent_id: 'agent-1', active: true, route: 'default', model: 'claude-sonnet-5-5' });
  assert.deepEqual(JSON.parse(JSON.stringify(target.children[0].children.map((item) => item.className))), [
    'route-tag stale', 'model claude',
  ]);
  context.codexAgentAvailable = false;
  assert.equal(context.routeTag({ active: true, route: 'default' }), null);
});

test('経路設定は上部バーにあり、サブエージェントの三択を API に保存する', async () => {
  const routing = functionSource(web, 'renderRouting');
  const updateRouting = functionSource(web, 'updateRouting');
  assert.ok(web.indexOf('id="routing"') < web.indexOf('id="settings-button"'));
  assert.match(routing, /data-route="\$\{key\}"/);
  assert.match(routing, /aria-pressed=/);
  assert.match(updateRouting, /postUiAction\('\/api\/routing'/);
  assert.match(web, /agents: \{ label: 'サブエージェント'/);
  assert.match(web, /review: \{ label: 'クロスレビュー'/);

  const posts = [];
  const renders = [];
  const context = pageContext(web, {
    postUiAction: async (...args) => {
      posts.push(args);
      return { ok: true, json: async () => ({ agents: 'codex', review: 'claude' }) };
    },
    renderRouting: (...args) => renders.push(args),
    routingInFlight: new Set(),
    routing: { agents: 'default', review: 'default' },
    codexAgentAvailable: true,
    crossReviewAvailable: true,
    lastState: null,
    liveStatus: { textContent: '' },
    showWriteError() {},
  });
  vm.runInContext(`${updateRouting}\nthis.updateRouting = updateRouting;`, context);
  await context.updateRouting({ dataset: { route: 'review', v: 'claude' } });
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [['/api/routing', { key: 'review', value: 'claude' }]]);
  assert.deepEqual(JSON.parse(JSON.stringify(renders[0][1])), { codexAgent: true, crossReview: true });
});

test('経路の保存中は同じ組の全ボタンを無効にし、他の組の変更を受け付ける', async () => {
  const renderSource = functionSource(web, 'renderRouting');
  const updateSource = functionSource(web, 'updateRouting');
  assert.ok(renderSource && updateSource);

  const buttons = ['agents', 'agents', 'agents', 'review', 'review', 'review'].map((route, index) => ({
    dataset: { route, v: ['default', 'codex', 'claude'][index % 3] },
    attributes: {},
    setAttribute(name, value) { this.attributes[name] = value; },
  }));
  const root = {
    hidden: false,
    dataset: { routes: 'agents,review' },
    querySelectorAll: () => buttons,
  };
  const routingInFlight = new Set(['agents']);
  const context = pageContext(web, {
    ROUTE_VALUES: new Set(['default', 'codex', 'claude']),
    ROUTE: {
      agents: { label: 'サブエージェント', opts: [] },
      review: { label: 'クロスレビュー', opts: [] },
    },
    routing: { agents: 'default', review: 'default' },
    routingInFlight,
    codexAgentAvailable: true,
    crossReviewAvailable: true,
    document: { getElementById: () => root },
    layoutRouting() {},
  });
  vm.runInContext(renderSource, context);
  context.renderRouting(context.routing, { codexAgent: true, crossReview: true });
  assert.deepEqual(buttons.map((button) => button.disabled), [true, true, true, false, false, false]);

  const requests = new Map();
  const posts = [];
  const updateContext = pageContext(web, {
    routingInFlight: new Set(),
    routing: { agents: 'default', review: 'default' },
    renderRouting() {},
    postUiAction: (url, body) => {
      posts.push([url, body]);
      return new Promise((resolve) => requests.set(body.key, resolve));
    },
    codexAgentAvailable: true,
    crossReviewAvailable: true,
    lastState: null,
    liveStatus: { textContent: '' },
    showWriteError() {},
  });
  vm.runInContext(`${updateSource}\nthis.updateRouting = updateRouting;`, updateContext);
  const agentsRequest = updateContext.updateRouting({ dataset: { route: 'agents', v: 'codex' } });
  await updateContext.updateRouting({ dataset: { route: 'agents', v: 'claude' } });
  const reviewRequest = updateContext.updateRouting({ dataset: { route: 'review', v: 'claude' } });
  assert.deepEqual(JSON.parse(JSON.stringify(posts)), [
    ['/api/routing', { key: 'agents', value: 'codex' }],
    ['/api/routing', { key: 'review', value: 'claude' }],
  ]);
  requests.get('agents')({ ok: true, json: async () => ({ agents: 'codex', review: 'default' }) });
  requests.get('review')({ ok: true, json: async () => ({ agents: 'default', review: 'claude' }) });
  await Promise.all([agentsRequest, reviewRequest]);
  assert.deepEqual([...updateContext.routingInFlight], []);
});

test('経路の二段は実際の幅が収まる場合だけ横に並べる', () => {
  const layoutRouting = functionSource(web, 'layoutRouting');
  assert.ok(layoutRouting);
  assert.match(web, /const ROUTING_PAIR_GAP_PX = 12/);
  assert.match(web, /new ResizeObserver\(layoutRouting\)\.observe\(document\.getElementById\('routing'\)\)/);
  assert.equal(Object.fromEntries(cssDeclarations(web, '.routing .rgroup.side-by-side'))['grid-template-columns'], 'repeat(4, max-content)');
  assert.equal(Object.fromEntries(cssDeclarations(web, '.routing .rgroup.side-by-side .rrow + .rrow .rlabel'))['margin-left'], '12px');

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
  const context = pageContext(web, {
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

test('未完了タスクの完了ボタンは閉じる API を呼び、ボタン用の識別子を送る', () => {
  const closeTaskButton = functionSource(web, 'closeTaskButton');
  assert.ok(closeTaskButton);
  const calls = [];
  const context = pageContext(web, {
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
  assert.match(web, /close\.dataset\.closeTask = closeKey/);
});

test('終了にできるエージェント行に終了 API を呼ぶボタンを置く', () => {
  const closeAgentButton = functionSource(web, 'closeAgentButton');
  const calls = [];
  const context = pageContext(web, {
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
  assert.match(web, /if \(agent\.closable\)/);
  assert.match(web, /name\.append\(close\)/);
  assert.match(web, /close\.dataset\.closeAgent = `\$\{session\.session_id\}::\$\{agent\.agent_id\}`/);
});

test('表示設定はサーバーの null のときだけ旧 localStorage から移し、通常変更は差分で送る', async () => {
  const sync = functionSource(web, 'syncDisplayPreferences');
  const syncCalls = [];
  let legacyReads = 0;
  const context = pageContext(web, {
    displayPreferences: {},
    displayPreferencesReady: false,
    displayMigrationPending: false,
    displayMigrationData: null,
    pendingDisplayChanges: {},
    pendingDisplayRequests: 0,
    displayPreferenceSaveStates: new Map(),
    readDisplayPreferences: () => {
      legacyReads += 1;
      return { mode: 'kind', order: ['legacy'], pinned: [], collapsed: [], hidden: [], sectionOrder: ['now', 'judgment', 'tasks', 'sinceSeen', 'prs'], importAppTasks: false, importAppTasksAsked: false };
    },
    normalizeDisplayPreferences: (value) => value,
    renderSectionOrder() {},
    renderDisplaySettings() {},
    settleDisplaySaves() {},
    enqueueDisplayPatch: async (patch) => { syncCalls.push(patch); return true; },
    clearLegacyDisplayPreferences() {},
    maybeAskImportAppTasks() {},
  });
  vm.runInContext(`${sync}\nthis.syncDisplayPreferences = syncDisplayPreferences;`, context);
  await context.syncDisplayPreferences(null);
  assert.equal(legacyReads, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(syncCalls[0])), {
    mode: 'kind', order: ['legacy'], pinned: [], collapsed: [], hidden: [], sectionOrder: ['now', 'judgment', 'tasks', 'sinceSeen', 'prs'],
  });

  const readyContext = pageContext(web, {
    displayPreferences: {},
    displayPreferencesReady: false,
    displayMigrationPending: false,
    displayMigrationData: null,
    pendingDisplayChanges: {},
    pendingDisplayRequests: 0,
    displayPreferenceSaveStates: new Map(),
    readDisplayPreferences: () => { throw new Error('旧設定は読み込まない'); },
    normalizeDisplayPreferences: (value) => value,
    renderSectionOrder() {},
    renderDisplaySettings() {},
    settleDisplaySaves() {},
    enqueueDisplayPatch: async (patch) => { syncCalls.push(patch); return true; },
    clearLegacyDisplayPreferences() {},
    maybeAskImportAppTasks() {},
  });
  vm.runInContext(`${sync}\nthis.syncDisplayPreferences = syncDisplayPreferences;`, readyContext);
  await readyContext.syncDisplayPreferences({ mode: 'product', order: [], pinned: [], collapsed: [], hidden: [], sectionOrder: ['sinceSeen', 'judgment', 'tasks', 'now', 'prs'] });

  const save = functionSource(web, 'saveDisplayPreferences');
  const saveContext = pageContext(web, {
    displayPreferences: { mode: 'product', order: [], pinned: [], collapsed: [], hidden: [] },
    displayPreferencesReady: true,
    pendingDisplayChanges: {},
    displayPreferenceSaveStates: new Map(),
    settleDisplaySaves: () => {},
    enqueueDisplayPatch: async (patch) => { syncCalls.push(patch); return true; },
  });
  vm.runInContext(`${save}\nthis.saveDisplayPreferences = saveDisplayPreferences;`, saveContext);
  saveContext.saveDisplayPreferences({ mode: 'kind' });

  assert.deepEqual(JSON.parse(JSON.stringify(syncCalls[1])), { mode: 'kind' });
  assert.equal(syncCalls.length, 2);
});

test('画面は未設定や不正なサーバー値を表示設定の既定値で補う', () => {
  const normalizeOrder = functionSource(web, 'normalizeSectionOrder');
  const normalizeMinutes = functionSource(web, 'normalizeDisplayInteger');
  const normalizeDisplay = functionSource(web, 'normalizeDisplayPreferences');
  const settings = web.match(/const DISPLAY_INTEGER_SETTINGS = \[[\s\S]*?\n\];/)?.[0];
  assert.ok(settings);
  const minuteInputs = {
    longWaitMinutesInput: {}, awayAnswerWaitMinutesInput: {}, idleHideMinutesInput: {},
    ghConcurrencyLimitInput: {},
    longWaitMinutesError: {}, awayAnswerWaitMinutesError: {}, idleHideMinutesError: {},
    ghConcurrencyLimitError: {},
  };
  const context = pageContext(web, {
    ...minuteInputs,
    SECTION_ORDER_KEYS: new Set(['sinceSeen', 'judgment', 'tasks', 'now', 'prs']),
    DEFAULT_SECTION_ORDER: ['sinceSeen', 'judgment', 'prs', 'tasks', 'now'],
    DEFAULT_LONG_WAIT_MINUTES: 15,
    DEFAULT_AWAY_ANSWER_WAIT_MINUTES: 3,
    DEFAULT_IDLE_HIDE_MINUTES: 10,
    DEFAULT_GH_CONCURRENCY_LIMIT: 8,
    TERMINAL_LABELS: { auto: '自動', 'windows-terminal': 'Windows Terminal', pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'コマンドプロンプト' },
    FILTERS: ['permission', 'blocking', 'provisional', 'agents', 'prs'].map((key) => ({ key })),
  });
  vm.runInContext(`${settings}\n${normalizeOrder}\n${normalizeMinutes}\n${normalizeDisplay}\nthis.normalizeDisplay = normalizeDisplayPreferences;`, context);
  const base = { mode: 'product', order: [], pinned: [], collapsed: [], hidden: [] };

  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeDisplay(base))), {
    ...base,
    sectionOrder: ['sinceSeen', 'judgment', 'prs', 'tasks', 'now'],
    longWaitMinutes: 15,
    awayAnswerWaitMinutes: 3,
    idleHideMinutes: 10,
    ghConcurrencyLimit: 8,
    pullDefaultBranchAfterMerge: false,
    hideFinished: true,
    importAppTasks: false,
    importAppTasksAsked: false,
    diagnosticsLevel: 'info',
    mergeableCondition: 'cross-review',
    terminal: 'auto',
  });
  const initial = context.normalizeDisplay({});
  assert.equal(initial.mode, 'kind');
  assert.deepEqual(JSON.parse(JSON.stringify(initial.sectionOrder)), ['sinceSeen', 'judgment', 'prs', 'tasks', 'now']);
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeDisplay({ ...base, sectionOrder: ['tasks'] }).sectionOrder)), [
    'tasks', 'sinceSeen', 'judgment', 'prs', 'now',
  ]);
  assert.equal(context.normalizeDisplay({ ...base, hideFinished: false }).hideFinished, false);
  assert.equal(context.normalizeDisplay({ ...base, terminal: 'unknown' }).terminal, 'auto');
  assert.equal(context.normalizeDisplay({ ...base, terminal: 'cmd' }).terminal, 'cmd');
  assert.equal(context.normalizeDisplay({ ...base, longWaitMinutes: 0, awayAnswerWaitMinutes: 31 }).longWaitMinutes, 15);
  assert.equal(context.normalizeDisplay({ ...base, longWaitMinutes: 0, awayAnswerWaitMinutes: 31 }).awayAnswerWaitMinutes, 3);
  for (const idleHideMinutes of [4, 1441, 30.5]) {
    assert.equal(context.normalizeDisplay({ ...base, idleHideMinutes }).idleHideMinutes, 10);
  }
  for (const idleHideMinutes of [5, 1440]) {
    assert.equal(context.normalizeDisplay({ ...base, idleHideMinutes }).idleHideMinutes, idleHideMinutes);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeDisplay({ ...base, hidden: ['held'] }).hidden)), []);
});

test('長い待ちの判定は設定値を使い、判断事項と許可待ちの表示へ反映する', () => {
  const normalizeMinutes = functionSource(web, 'normalizeDisplayInteger');
  const isLongWait = functionSource(web, 'isLongWait');
  const elapsedLabel = functionSource(web, 'decisionElapsedLabel');
  const duration = functionSource(web, 'durationLabel');
  assert.ok(duration);
  const context = pageContext(web, { displayPreferences: { longWaitMinutes: 2 }, hasEffectiveAnswer: () => false });
  vm.runInContext(`${duration}\n${normalizeMinutes}\n${isLongWait}\n${elapsedLabel}\nthis.normalizeMinutes = normalizeDisplayInteger; this.isLongWait = isLongWait; this.elapsedLabel = decisionElapsedLabel;`, context);

  assert.equal(context.normalizeMinutes(120, 1, 120, 15), 120);
  assert.equal(context.normalizeMinutes(1.5, 1, 120, 15), 15);
  assert.equal(context.isLongWait(120_000), false);
  assert.equal(context.isLongWait(120_001), true);
  assert.equal(context.elapsedLabel({ state: 'waiting', createdAt: new Date(Date.now() - 121_000).toISOString() }).stale, true);
  assert.match(functionSource(web, 'appendPermissionWaits'), /isLongWait\(age\)/);

  const mockThreshold = functionSource(mock, 'isLongWait');
  const mockContext = pageContext(mock, { ui: { longWaitMinutes: 3 } });
  vm.runInContext(`${mockThreshold}\nthis.isLongWait = isLongWait;`, mockContext);
  assert.equal(mockContext.isLongWait(3), false);
  assert.equal(mockContext.isLongWait(4), true);
  assert.match(functionSource(mock, 'permCard'), /isLongWait\(x\.waitMin\)/);
  assert.match(functionSource(mock, 'decisionCard'), /isLongWait\(d\.waitMin\)/);
  assert.match(web, /長く待たせているとみなす時間 \(1〜120 分\)/);
  assert.match(web, /離席中に質問の回答を待つ時間 \(1〜30 分\)/);
  assert.match(web, /id="settings-import-app-tasks" name="importAppTasks" type="checkbox"/);
  assert.match(web, /オンでは、アプリの一覧を 1 つのタスクの完了条件として取り込む。依頼ごとの題はモデルが登録する。オフでは、モデルが Agent Cockpit に直接登録したタスクだけを出す。Codex のセッションには取り込める一覧が無いので、この設定にかかわらず取り込まない。/);
  assert.match(mock, /長く待たせているとみなす時間 \(1〜120 分\)/);
  assert.match(mock, /離席中に質問の回答を待つ時間 \(1〜30 分\)/);
  assert.match(mock, /id="settings-import-app-tasks" name="importAppTasks" type="checkbox"/);
  assert.match(mock, /オンでは、アプリの一覧を 1 つのタスクの完了条件として取り込む。依頼ごとの題はモデルが登録する。オフでは、モデルが Agent Cockpit に直接登録したタスクだけを出す。Codex のセッションには取り込める一覧が無いので、この設定にかかわらず取り込まない。/);
});

test('整数の表示設定の保存に失敗した値を元に戻す', async () => {
  const settings = web.match(/const DISPLAY_INTEGER_SETTINGS = \[[\s\S]*?\n\];/)?.[0];
  const setInput = functionSource(web, 'setDisplaySettingInput');
  const settingError = functionSource(web, 'displaySettingError');
  const change = functionSource(web, 'changeDisplaySetting');
  const settle = functionSource(web, 'settleDisplaySaves');
  const save = functionSource(web, 'saveDisplayPreferences');
  assert.ok(settings && setInput && settingError && change && settle && save);
  const patches = [];
  let saveCount = 0;
  const longWaitMinutesInput = { valueAsNumber: 15, value: '15' };
  const awayAnswerWaitMinutesInput = {};
  const idleHideMinutesInput = {};
  const longWaitMinutesError = { hidden: true, textContent: '' };
  const awayAnswerWaitMinutesError = { hidden: true, textContent: '' };
  const idleHideMinutesError = { hidden: true, textContent: '' };
  const ghConcurrencyLimitInput = { valueAsNumber: 8, value: '8' };
  const ghConcurrencyLimitError = { hidden: true, textContent: '' };
  const context = pageContext(web, {
    displayPreferences: { longWaitMinutes: 15, ghConcurrencyLimit: 8 },
    DEFAULT_LONG_WAIT_MINUTES: 15,
    DEFAULT_AWAY_ANSWER_WAIT_MINUTES: 3,
    DEFAULT_IDLE_HIDE_MINUTES: 10,
    DEFAULT_GH_CONCURRENCY_LIMIT: 8,
    displayPreferencesReady: true,
    displayPreferenceSaveStates: new Map(),
    pendingDisplayChanges: {},
    longWaitMinutesInput, awayAnswerWaitMinutesInput, idleHideMinutesInput,
    ghConcurrencyLimitInput,
    longWaitMinutesError, awayAnswerWaitMinutesError, idleHideMinutesError,
    ghConcurrencyLimitError,
    lastState: null,
    renderDisplaySettings() {},
    renderSectionOrder() {},
    enqueueDisplayPatch: async (patch) => { patches.push(patch); saveCount += 1; return saveCount === 1; },
  });
  vm.runInContext(`${settings}\n${setInput}\n${settingError}\n${change}\n${settle}\n${save}\nthis.changeDisplaySetting = changeDisplaySetting;`, context);
  const savedInput = { valueAsNumber: 24, value: '24' };
  const failedInput = { valueAsNumber: 30, value: '30' };

  assert.equal(await context.changeDisplaySetting('longWaitMinutes', savedInput), true);
  assert.equal(context.displayPreferences.longWaitMinutes, 24);
  assert.equal(await context.changeDisplaySetting('longWaitMinutes', failedInput), false);
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ longWaitMinutes: 24 }, { longWaitMinutes: 30 }]);
  assert.equal(context.displayPreferences.longWaitMinutes, 24);
  assert.equal(failedInput.value, '24');

  const failedGhInput = { valueAsNumber: 12, value: '12' };
  assert.equal(await context.changeDisplaySetting('ghConcurrencyLimit', failedGhInput), false);
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [
    { longWaitMinutes: 24 }, { longWaitMinutes: 30 }, { ghConcurrencyLimit: 12 },
  ]);
  assert.equal(context.displayPreferences.ghConcurrencyLimit, 8);
  assert.equal(failedGhInput.value, '8');
});

test('モックの整数表示設定を UI 状態へ保存し表示に反映する', () => {
  const settings = mock.match(/const DISPLAY_INTEGER_SETTINGS = \[[\s\S]*?\n\];/)?.[0];
  const capture = functionSource(mock, 'captureDisplayPreferences');
  const settingError = functionSource(mock, 'displaySettingError');
  const change = functionSource(mock, 'changeDisplaySetting');
  assert.ok(settings && capture && settingError && change);
  let saved = 0;
  let rendered = 0;
  const input = { valueAsNumber: 24, value: '24' };
  const idleSettingInput = {};
  const awaySettingInput = {};
  const longError = { hidden: true, textContent: '' };
  const awayError = { hidden: true, textContent: '' };
  const idleError = { hidden: true, textContent: '' };
  const ghSettingInput = { valueAsNumber: 8, value: '8' };
  const ghError = { hidden: true, textContent: '' };
  const context = pageContext(mock, {
    ui: {
      mode: 'kind', order: [], pinned: [], collapsed: [], hidden: [], sectionOrder: [],
      hideFinished: true, importAppTasks: false, importAppTasksAsked: false,
      longWaitMinutes: 15, awayAnswerWaitMinutes: 5, idleHideMinutes: 30,
      ghConcurrencyLimit: 8, mergeableCondition: 'cross-review',
    },
    DEFAULT_SECTION_ORDER: [],
    saveDisplayPreferences: () => { saved += 1; return true; },
    render: () => { rendered += 1; },
    longWaitMinutesInput: input,
    awayAnswerWaitMinutesInput: awaySettingInput,
    idleHideMinutesInput: idleSettingInput,
    ghConcurrencyLimitInput: ghSettingInput,
    longWaitMinutesError: longError,
    awayAnswerWaitMinutesError: awayError,
    idleHideMinutesError: idleError,
    ghConcurrencyLimitError: ghError,
  });
  vm.runInContext(`${settings}\n${capture}\n${settingError}\n${change}\nthis.changeDisplaySetting = changeDisplaySetting;`, context);
  assert.equal(context.changeDisplaySetting('longWaitMinutes', input), true);
  assert.equal(context.ui.longWaitMinutes, 24);
  assert.equal(saved, 1);
  assert.equal(rendered, 1);
  const idleInput = { valueAsNumber: 5, value: '5' };
  assert.equal(context.changeDisplaySetting('idleHideMinutes', idleInput), true);
  assert.equal(context.ui.idleHideMinutes, 5);
  assert.equal(saved, 2);
  assert.equal(rendered, 2);
  const ghInput = { valueAsNumber: 12, value: '12' };
  assert.equal(context.changeDisplaySetting('ghConcurrencyLimit', ghInput), true);
  assert.equal(context.ui.ghConcurrencyLimit, 12);
  assert.equal(context.captureDisplayPreferences().ghConcurrencyLimit, 12);
  assert.equal(saved, 3);
  assert.equal(rendered, 3);
});

test('セクションの並び順を保存し、端のボタンを無効化してフォーカスを維持する', () => {
  const sectionKinds = web.match(/const SECTION_KINDS = \[[\s\S]*?\n\];/)?.[0];
  const sectionOrderKeys = web.match(/const SECTION_ORDER_KEYS = [^\n]+/)?.[0];
  const defaultOrder = web.match(/const DEFAULT_SECTION_ORDER = [^\n]+/)?.[0];
  const normalize = functionSource(web, 'normalizeSectionOrder');
  const renderOrder = functionSource(web, 'renderSectionOrder');
  const moveHandler = web.match(/sectionOrderList\.addEventListener\('click', \(event\) => \{[\s\S]*?\n\}\);/)?.[0];
  const resetHandler = web.match(/document\.getElementById\('settings-section-order-reset'\)\.addEventListener\('click', \(\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(sectionKinds && sectionOrderKeys && defaultOrder && normalize && renderOrder && moveHandler && resetHandler);
  assert.match(web, /id="settings-section-order" aria-labelledby="settings-section-order-title" aria-describedby="settings-section-order-note"/);
  assert.deepEqual(Object.fromEntries(cssDeclarations(web, '.settings-section-order')), { 'margin-top': '14px' });
  assert.deepEqual(Object.fromEntries(cssDeclarations(web, '.section-order-list button')), {
    'min-width': '36px', padding: '4px 8px',
  });
  const elementSource = functionSource(web, 'element');
  assert.ok(elementSource);

  let moveClick;
  let resetClick;
  let focused;
  let renderCount = 0;
  class FakeElement {
    constructor(tagName) {
      this.tagName = tagName;
      this.children = [];
      this.dataset = {};
      this.attributes = {};
      this.className = '';
      this.textContent = '';
      this.disabled = false;
    }
    append(...nodes) { this.children.push(...nodes); }
    replaceChildren(...nodes) { this.children = nodes; }
    setAttribute(name, value) { this.attributes[name] = value; }
    contains(node) { return node === this || this.children.some((child) => child.contains?.(node)); }
    focus() {
      focused = { key: this.dataset.sectionMove, direction: this.dataset.dir };
      fakeDocument.activeElement = this;
    }
  }
  const preferences = { sectionOrder: ['sinceSeen', 'judgment', 'tasks', 'now', 'prs'] };
  const sectionOrderList = new FakeElement('ol');
  sectionOrderList.addEventListener = (_type, handler) => { moveClick = handler; };
  const resetButton = { addEventListener: (_type, handler) => { resetClick = handler; } };
  const fakeDocument = { activeElement: null, getElementById: () => resetButton, createElement: (tagName) => new FakeElement(tagName) };
  const context = pageContext(web, {
    displayPreferences: preferences,
    sectionOrderList,
    document: fakeDocument,
    saveDisplayPreferences: (patch) => Object.assign(preferences, patch),
    lastState: {},
    render: () => { renderCount += 1; },
  });
  vm.runInContext([sectionKinds, sectionOrderKeys, defaultOrder, elementSource, normalize, renderOrder, moveHandler, resetHandler].join('\n'), context);
  context.renderSectionOrder();
  const buttonOf = (key, direction) => sectionOrderList.children.flatMap((item) => item.children)
    .find((node) => node.dataset.sectionMove === key && node.dataset.dir === direction);
  assert.equal(sectionOrderList.children[0].children[0].textContent, '1. 前回見てから');
  assert.equal(buttonOf('judgment', '-1').attributes['aria-label'], 'あなたの判断が必要なことを上へ');
  assert.equal(buttonOf('judgment', '1').attributes['aria-label'], 'あなたの判断が必要なことを下へ');

  const move = (key, direction) => {
    const button = { dataset: { sectionMove: key, dir: direction }, closest: () => button };
    moveClick({ target: button });
  };
  move('judgment', '-1');
  assert.deepEqual(JSON.parse(JSON.stringify(context.displayPreferences.sectionOrder)), ['judgment', 'sinceSeen', 'tasks', 'now', 'prs']);
  assert.deepEqual(focused, { key: 'judgment', direction: '1' });
  assert.equal(buttonOf('judgment', '-1').disabled, true);
  assert.equal(buttonOf('prs', '1').disabled, true);

  move('tasks', '-1');
  assert.deepEqual(focused, { key: 'tasks', direction: '-1' });
  resetClick();
  assert.deepEqual(JSON.parse(JSON.stringify(context.displayPreferences.sectionOrder)), ['sinceSeen', 'judgment', 'prs', 'tasks', 'now']);
  assert.equal(renderCount, 3);

  // 別の画面で順が変わり、同期で一覧を作り直しても、フォーカスは同じ種類と向きのボタンに戻る。
  buttonOf('now', '1').focus();
  focused = null;
  preferences.sectionOrder = ['now', 'sinceSeen', 'judgment', 'tasks', 'prs'];
  context.renderSectionOrder();
  assert.deepEqual(focused, { key: 'now', direction: '1' });

  fakeDocument.activeElement = null;
  focused = null;
  context.renderSectionOrder();
  assert.equal(focused, null);
});

test('種類別のセクションは設定順に並べる', () => {
  const mockKind = functionSource(mock, 'renderKindMode');
  const webKind = functionSource(web, 'renderKindSections');

  assert.match(mockKind, /return orderedSectionKeys\(DEFAULT_SECTION_ORDER\)\.map\(key => sections\[key\]\)\.join\(''\)/);
  assert.match(webKind, /return orderedSectionKeys\(DEFAULT_SECTION_ORDER\)\.map\(\(key\) => sections\[key\]\)\.filter\(Boolean\)/);
});

test('種類別とプロダクト別のセクションは既定の欄順に従う', () => {
  const constants = web.match(/const SECTION_KINDS = \[[\s\S]*?\n\];/)?.[0];
  const sectionOrderKeys = web.match(/const SECTION_ORDER_KEYS = [^\n]+/)?.[0];
  const defaultOrder = web.match(/const DEFAULT_SECTION_ORDER = [^\n]+/)?.[0];
  const normalize = functionSource(web, 'normalizeSectionOrder');
  const ordered = functionSource(web, 'orderedSectionKeys');
  const visiblePullRequests = functionSource(web, 'visiblePullRequestGroups');
  const renderKinds = functionSource(web, 'renderKindSections');
  const renderSession = functionSource(web, 'sessionBlock');
  const endedDecision = functionSource(web, 'isEndedDecision');
  assert.ok(constants && sectionOrderKeys && defaultOrder && normalize && ordered && visiblePullRequests && renderKinds && renderSession && endedDecision);

  function renderWithOrder(sectionOrder) {
    const element = (tag, className = '', textContent = '') => ({
      tag, className, textContent, children: [], childNodes: [], dataset: {},
      append(...nodes) { this.childNodes.push(...nodes); this.children.push(...nodes); },
      querySelector() { return null; },
    });
    const context = pageContext(web, {
      displayPreferences: { sectionOrder },
      element,
      sessionReferences: () => [],
      kindEndedDecisionEntries: () => [],
      expandedKindSections: new Set(),
      sessionDisplayName: (item) => item.title || item.session_id || 'session',
      kindEndedAgentCount: () => 0,
      kindTodoTaskCount: () => 0,
      kindDoneTaskCount: () => 0,
      hasHiddenJudgmentItems: () => false,
      kindSection: (label, content) => ({ label, content }),
      sinceSeenBox: () => element('div', 'news'),
      isFilterShown: () => true,
      appendPullRequestBlock() {},
      shownPermissions: () => [{}],
      shownActiveDecisions: () => [],
      appendPermissionWaits(target) { target.append({ marker: 'permission' }); },
      appendDecisions(target) { target.append({ marker: 'decision' }); },
      appendTasks(target) { target.append({ marker: 'task' }); },
      appendAgents(target) { target.append({ marker: 'agent' }); },
      mainRow: () => ({ marker: 'main' }),
    });
    vm.runInContext([constants, sectionOrderKeys, defaultOrder, normalize, ordered, visiblePullRequests, endedDecision,
      ...['hasEffectiveAnswer', 'kindWaitAge', 'kindDecisionWaitAge', 'kindPermissionWaitKey', 'kindJudgmentSortKey', 'compareKindJudgmentItems']
        .map((name) => functionSource(web, name)), functionSource(web, 'sessionOrigin'), renderKinds, renderSession].join('\n'), context);
    const kindSections = JSON.parse(JSON.stringify(
      context.renderKindSections([{ pullRequestGroups: [] }]).map(({ label }) => label),
    ));
    const session = { session_id: 'session-1', status: 'busy', decisions: [], tasks: [] };
    const sessionBlock = context.sessionBlock({ sessions: [session] }, session, false);
    const body = sessionBlock.children[0];
    const sessionParts = body.childNodes.map((node) => node.textContent || node.marker || (node.children[0]?.marker === 'main' ? 'now-content' : ''));
    return { kindSections, sessionParts };
  }

  const defaultResult = renderWithOrder(['sinceSeen', 'judgment', 'prs', 'tasks', 'now']);
  assert.deepEqual(defaultResult.kindSections, [
    '前回見てから', 'あなたの判断が必要なこと', 'プルリクエスト', 'タスクと完了条件', '今やっていること',
  ]);
  assert.deepEqual(defaultResult.sessionParts, ['session-1', 'あなたの判断が必要なこと', 'permission', 'decision', 'task', '今やっていること', 'now-content', 'agent']);

  const customResult = renderWithOrder(['prs', 'now', 'tasks', 'judgment', 'sinceSeen']);
  assert.deepEqual(customResult.kindSections, [
    'プルリクエスト', '今やっていること', 'タスクと完了条件', 'あなたの判断が必要なこと', '前回見てから',
  ]);
  assert.deepEqual(customResult.sessionParts, ['session-1', '今やっていること', 'now-content', 'agent', 'task', 'あなたの判断が必要なこと', 'permission', 'decision']);
});

test('種類別のタスクにはタスクがあるセッションだけを含める', () => {
  const mockKind = functionSource(mock, 'renderKindMode');
  const webKind = functionSource(web, 'renderKindSections');

  assert.match(mockKind, /sessions\.filter\(\(\{ session \}\) => session\.tasks\.length > 0\)/);
  assert.doesNotMatch(mockKind, /class="empty">ありません/);
  assert.match(webKind, /if \(!session\.tasks\.length\) continue/);
  assert.doesNotMatch(webKind, /tasks\.append\(element\('div', 'empty', 'ありません'\)\)/);
});

test('許可待ちと判断事項のフィルターは非表示の行を検出する', () => {
  const context = pageContext(web, { displayPreferences: { hidden: [] } });
  const helpers = ['isFilterShown', 'hasEffectiveAnswer', 'isActiveDecision', 'shownActiveDecisions', 'hasHiddenJudgmentItems']
    .map((name) => functionSource(web, name));
  assert.ok(helpers.every(Boolean));
  vm.runInContext(`${helpers.join('\n')}\nthis.hasHidden = hasHiddenJudgmentItems;`, context);

  const categories = [
    ['permission', { permissionWaits: [{ phase: 'prompted' }], decisions: [] }],
    ['blocking', { permissionWaits: [], decisions: [{ state: 'waiting', answer: null }] }],
    ['provisional', { permissionWaits: [], decisions: [{ state: 'provisional', answer: null }] }],
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
  const judgmentHelpers = ['isActiveDecision', 'isAwaitingDecision', 'countJudgments', 'hasEffectiveAnswer']
    .map((name) => functionSource(web, name));
  const summary = { children: [], replaceChildren(...children) { this.children = children; } };
  const filterNote = { replaceChildren() {} };
  const element = (tag, className, textContent = '') => ({
    tag, className, textContent, children: [], dataset: {}, attributes: {},
    append(...items) { this.children.push(...items); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {},
  });
  const context = pageContext(web, {
    summary,
    displayPreferences: { hidden: [] },
    pullRequestMergeableCount: (groups) => groups.reduce((count, group) => count + group.mergeableCount, 0),
    pullRequestOpenCount: () => 0,
    isPendingDecision: () => false,
    hasEffectiveAnswer: () => false,
    element,
    document: {
      createTextNode: (textContent) => ({ textContent }),
      getElementById: () => filterNote,
    },
  });
  vm.runInContext(`${judgmentHelpers.join('\n')}\n${filters}\n${renderSummary}\nthis.renderSummary = renderSummary;`, context);
  context.renderSummary([], [{ mergeableCount: 2 }, { mergeableCount: 1 }]);

  const chip = summary.children.find((item) => item.dataset.filter === 'prs');
  assert.ok(chip);
  assert.equal(chip.children.find((item) => item.tag === 'strong').textContent, '3');
});

test('件数の札は1件以上の種類と隠している種類だけを出す', () => {
  const filters = web.match(/const FILTERS = \[[\s\S]*?\n\];/)?.[0];
  const renderSummary = functionSource(web, 'renderSummary');
  const judgmentHelpers = ['isActiveDecision', 'isAwaitingDecision', 'countJudgments', 'hasEffectiveAnswer']
    .map((name) => functionSource(web, name));
  const summary = { children: [], replaceChildren(...children) { this.children = children; } };
  const filterNote = { replaceChildren() {} };
  const element = (tag, className, textContent = '') => ({
    tag, className, textContent, children: [], dataset: {}, attributes: {},
    append(...items) { this.children.push(...items); },
    setAttribute(name, value) { this.attributes[name] = value; },
    addEventListener() {},
  });
  const context = pageContext(web, {
    summary,
    displayPreferences: { hidden: ['agents'] },
    pullRequestMergeableCount: (groups) => groups.reduce((count, group) => count + group.mergeableCount, 0),
    pullRequestOpenCount: () => 0,
    isPendingDecision: () => false,
    hasEffectiveAnswer: () => false,
    element,
    document: {
      createTextNode: (textContent) => ({ textContent }),
      getElementById: () => filterNote,
    },
  });
  vm.runInContext(`${judgmentHelpers.join('\n')}\n${filters}\n${renderSummary}\nthis.renderSummary = renderSummary;`, context);
  context.renderSummary([], [{ mergeableCount: 1 }]);

  assert.deepEqual(summary.children.map((item) => item.dataset.filter), ['agents', 'prs']);
});

test('フォーカスのある札が消えたら並びの次の札、無ければ直前の札へ移す', () => {
  const filters = web.match(/const FILTERS = \[[\s\S]*?\n\];/)?.[0];
  const context = pageContext(web, {});
  vm.runInContext(`${filters}\n${functionSource(web, 'filterFocusFallback')}\nthis.filterFocusFallback = filterFocusFallback;`, context);
  const button = (filter) => ({ dataset: filter ? { filter } : {} });
  const buttons = [button(), button('permission'), button('agents'), button('prs')];

  assert.equal(context.filterFocusFallback(buttons, 'blocking').dataset.filter, 'agents');
  assert.equal(context.filterFocusFallback(buttons.slice(0, 3), 'prs').dataset.filter, 'agents');
  assert.equal(context.filterFocusFallback([button()], 'prs'), null);
});

test('PRフィルターの切り替えは保存し、両表示モードのPR欄を隠す', () => {
  const toggleFilter = functionSource(web, 'toggleFilter');
  const productSection = functionSource(web, 'productSection');
  const kindSections = functionSource(web, 'renderKindSections');
  const patches = [];
  let renders = 0;
  const context = pageContext(web, {
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
  const mockContext = pageContext(mock, {
    ui: { expandedEndedAgents: [] },
    isShown: () => false,
    visibleSubagents: (session) => session.subagents.filter((agent) => agent.state !== 'busy'),
    isEndedAgent: () => false,
    ageMinutes: () => 0,
    agentRow: () => '<div>agent</div>',
    endedAgentToggle: () => '',
  });
  const mockResult = vm.runInContext(`(${mockAgentSection})`, mockContext)(
    {}, { id: 'session-a', subagents: [{ state: 'busy' }] }, true,
  );
  assert.equal(mockResult, '');

  const appendAgents = functionSource(web, 'appendAgents');
  const body = { children: [], append(item) { this.children.push(item); } };
  const webContext = pageContext(web, {
    expandedEndedSessions: new Set(),
    displayPreferences: { hideFinished: false },
    isFilterShown: () => false,
    newestFirst: (items) => items,
    isEndedAgent: (agent) => !agent.active && !agent.unconfirmed,
  });
  vm.runInContext(`(${appendAgents})`, webContext)(
    body,
    { session_id: 'session-a', agents: [{ active: true }] },
    {},
  );
  assert.equal(body.children.length, 0);
});

test('種類別の混在セクションは残し、隠した判断事項だけを空表示にしない', () => {
  const mockKind = functionSource(mock, 'renderKindMode');
  const webKind = functionSource(web, 'renderKindSections');

  assert.match(mockKind, /const showJudgment = Boolean\(decisionItems \|\| endedDecisionToggle\) \|\| !hiddenJudgmentItems/);
  assert.match(mockKind, /const now = nowRowsByAge\.length \? `<div class="now">/);
  assert.match(webKind, /judgment: waitingItems\.length \|\| endedDecisionItems\.length \|\| !hasHiddenJudgments/);
  assert.match(webKind, /activityItems\.push\(\{ age: sessionActivityTime\(session\), row: mainRow/);
});

test('種類別の終了判断は新しい順に集約し、終了済みエージェントは件数を数える', () => {
  const webHelpers = [
    functionSource(web, 'itemTimestamp'),
    functionSource(web, 'isEndedDecision'),
    functionSource(web, 'kindEndedDecisionEntries'),
    functionSource(web, 'kindEndedAgentCount'),
    functionSource(web, 'taskVisibility'),
    functionSource(web, 'kindDoneTaskCount'),
    functionSource(web, 'kindTodoTaskCount'),
  ];
  const webContext = pageContext(web, {
    displayPreferences: { hideFinished: false },
    isEndedAgent: (agent) => !agent.active && !agent.unconfirmed,
  });
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
    functionSource(mock, 'isEndedDecision'),
    functionSource(mock, 'kindEndedDecisionEntries'),
    functionSource(mock, 'kindEndedAgentCount'),
    functionSource(mock, 'taskVisibility'),
    functionSource(mock, 'kindDoneTaskCount'),
    functionSource(mock, 'kindTodoTaskCount'),
  ];
  const mockContext = pageContext(mock, {
    ui: { hideFinished: false },
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
  const expandToggle = functionSource(web, 'appendExpandToggle');
  const labelSource = functionSource(web, 'kindToggleLabel');
  assert.ok(webToggle && expandToggle && labelSource);
  const appended = [];
  const context = pageContext(web, {
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
  vm.runInContext(`${labelSource}\n${expandToggle}\n${webToggle}\nthis.label = kindToggleLabel; this.appendToggle = appendKindToggle;`, context);
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
  const mockContext = pageContext(mock, {});
  vm.runInContext(`${mockLabel}\n${mockToggle}\nthis.makeToggle = kindToggle;`, mockContext);
  assert.match(mockContext.makeToggle('tasks', '完了したタスク', 3, false), /完了したタスクを表示 \(3 件\)/);
  assert.match(mockContext.makeToggle('tasks', '完了したタスク', 3, false), /data-kind-toggle="tasks"/);
  assert.match(mockContext.makeToggle('tasks', '完了したタスク', 3, true), /完了したタスクを畳む/);
});

test('種類別タスクのまとまりは先頭行に札と更新時刻を置き、カードから札を外す', () => {
  const mockTaskBlock = functionSource(mock, 'kindTaskSessionBlock');
  const mockVisibility = functionSource(mock, 'taskVisibility');
  const mockContext = pageContext(mock, {
    taskState: (_session, task) => task.state,
    ui: { expandedKindTodoTasks: false },
    sessionTag: (_product, _session, _withTag, includeSession) => includeSession ? 'PRODUCT SESSION' : '',
    taskItem: (_product, _session, task, withTag) => `<li data-tags="${withTag}">${task.title}</li>`,
  });
  vm.runInContext(`${mockVisibility}\n${functionSource(mock, 'sessionOrigin')}\n${mockTaskBlock}\nthis.renderTasks = kindTaskSessionBlock;`, mockContext);
  const output = mockContext.renderTasks(
    { name: 'agent-cockpit' },
    { id: 'session-a', tasksUpdatedMin: 5, tasks: [{ title: '表示タスク', state: 'doing' }, { title: '未着手タスク', state: 'todo' }, { title: '完了タスク', state: 'done' }] },
    false,
  );
  assert.match(output.html, /<section class="kind-session-tasks group-frame"><h3 class="kind-task-head">PRODUCT SESSION<span class="meta">最終更新 5 分前<\/span>/);
  assert.doesNotMatch(output.html, /タスクと完了条件/);
  assert.match(output.html, /<li data-tags="false">表示タスク<\/li>/);
  assert.doesNotMatch(output.html, /未着手タスク/);
  assert.doesNotMatch(output.html, /完了タスク/);
  assert.equal(output.doneCount, 1);

  const webKind = functionSource(web, 'renderKindSections');
  const webTaskBlock = functionSource(web, 'appendKindTaskSession');
  assert.match(webKind, /appendKindTaskSession\(tasks, \{ product, session, multipleSessions \}, showTodoTasks, showDoneTasks, showOriginBands\)/);
  assert.match(webKind, /appendKindToggle\(taskControls, 'todoTasks', showTodoTasks, todoTaskCount, '未着手のタスク'\)/);
  assert.match(webKind, /appendKindToggle\(taskControls, 'tasks', showDoneTasks, doneTaskCount, '完了したタスク'\)/);
  assert.match(webTaskBlock, /appendContextTags\(heading, product, session, true, true\)/);
  assert.match(webTaskBlock, /appendTaskItem\(list, task, product, session, false, multipleSessions\)/);
  assert.equal(Object.fromEntries(cssDeclarations(web, '.group-frame')).border, '1px solid var(--border)');
});

test('種類別の描画では集約折り畳みだけを使い、プロダクト別のセッション単位は残す', () => {
  const mockKind = functionSource(mock, 'renderKindMode');
  const webKind = functionSource(web, 'renderKindSections');

  assert.match(mockKind, /kindToggle\('decisions', '解決済みと取り下げ', endedDecisionEntries\.length/);
  assert.match(mockKind, /kindToggle\('agents', '終了済み', endedAgentCount/);
  assert.match(mockKind, /kindToggle\('tasks', '完了したタスク', doneTaskCount/);
  assert.match(mockKind, /kindToggle\('todoTasks', '未着手のタスク', todoTaskCount/);
  assert.match(webKind, /appendKindToggle\(endedDecisionControls, 'decisions'/);
  assert.match(webKind, /appendKindToggle\(activityControls, 'agents'/);
  assert.match(webKind, /appendKindToggle\(taskControls, 'tasks'/);

  assert.match(mock, /function decisionSessionBlock\([^]*?endedDecisionToggle\(session\)/);
  assert.match(mock, /function taskSessionBlock\([^]*?data-done-tasks/);
  assert.match(mock, /function taskSessionBlock\([^]*?data-todo-tasks/);
  assert.match(web, /function appendDecisions\([^]*?appendPlanToggle\(body, 'decisions', session\.session_id/);
  assert.match(web, /function appendTasks\([^]*?appendPlanToggle\(body, 'tasks', session\.session_id/);
  assert.match(web, /function appendTasks\([^]*?appendPlanToggle\(body, 'todoTasks', session\.session_id/);
});

test('定期の同期は入力中の待ち時間の欄を上書きせず、ほかの欄は保存値にそろえる', () => {
  const render = functionSource(web, 'renderDisplaySettings');
  const settings = web.match(/const DISPLAY_INTEGER_SETTINGS = \[[\s\S]*?\n\];/)?.[0];
  assert.ok(render && settings);
  const longWaitMinutesInput = { value: '120' };
  const awayAnswerWaitMinutesInput = { value: '9' };
  const idleHideMinutesInput = { value: '90' };
  const ghConcurrencyLimitInput = { value: '7' };
  const errors = {
    longWaitMinutesError: {}, awayAnswerWaitMinutesError: {}, idleHideMinutesError: {},
    ghConcurrencyLimitError: {},
  };
  const hideFinishedInput = { checked: false };
  const importAppTasksInput = { checked: true };
  const terminalSelect = { value: 'auto' };
  const mergeableConditionInputs = ['operation', 'ci', 'cross-review'].map((value) => ({ value, checked: false }));
  const context = pageContext(web, {
    document: { activeElement: longWaitMinutesInput },
    longWaitMinutesInput,
    awayAnswerWaitMinutesInput,
    idleHideMinutesInput,
    ghConcurrencyLimitInput,
    ...errors,
    DEFAULT_LONG_WAIT_MINUTES: 15,
    DEFAULT_AWAY_ANSWER_WAIT_MINUTES: 3,
    DEFAULT_IDLE_HIDE_MINUTES: 10,
    DEFAULT_GH_CONCURRENCY_LIMIT: 8,
    pullDefaultBranchInput: { type: 'checkbox', checked: false },
    hideFinishedInput,
    importAppTasksInput,
    terminalSelect,
    mergeableConditionInputs,
    diagnosticsLevelSelect: { value: 'info', closest: () => ({ open: false }) },
    displayPreferences: { longWaitMinutes: 15, awayAnswerWaitMinutes: 5, idleHideMinutes: 30, ghConcurrencyLimit: 12, hideFinished: false, importAppTasks: true, mergeableCondition: 'ci', terminal: 'auto' },
  });
  vm.runInContext(`${settings}\n${render}`, context);
  context.renderDisplaySettings();

  assert.equal(longWaitMinutesInput.value, '120');
  assert.equal(awayAnswerWaitMinutesInput.value, '5');
  assert.equal(idleHideMinutesInput.value, '30');
  assert.equal(ghConcurrencyLimitInput.value, '12');
  assert.equal(hideFinishedInput.checked, false);
  assert.equal(importAppTasksInput.checked, true);
  assert.deepEqual(mergeableConditionInputs.map((input) => input.checked), [false, true, false]);
});

test('保存に失敗したラジオはフォーカスを保ったまま保存値へ戻す', async () => {
  const render = functionSource(web, 'renderDisplaySettings');
  const settle = functionSource(web, 'settleDisplaySaves');
  const save = functionSource(web, 'saveDisplayPreferences');
  assert.ok(render && settle && save);
  const longWaitMinutesInput = { value: '15' };
  const awayAnswerWaitMinutesInput = { value: '5' };
  const idleHideMinutesInput = { value: '30' };
  const hideFinishedInput = { checked: true };
  const importAppTasksInput = { checked: true };
  const terminalSelect = { value: 'auto' };
  const mergeableConditionInputs = ['operation', 'ci', 'cross-review'].map((value) => ({ value, checked: false }));
  const displayPreferences = { mergeableCondition: 'cross-review', terminal: 'auto' };
  let activeElement = null;
  const context = pageContext(web, {
    document: { get activeElement() { return activeElement; } },
    longWaitMinutesInput,
    awayAnswerWaitMinutesInput,
    idleHideMinutesInput,
    pullDefaultBranchInput: { type: 'checkbox', checked: false },
    hideFinishedInput,
    importAppTasksInput,
    terminalSelect,
    displayPreferences: { ...displayPreferences, importAppTasks: true },
    displayPreferenceSaveStates: new Map(),
    displayPreferencesReady: true,
    DISPLAY_INTEGER_SETTINGS: [
      { key: 'longWaitMinutes', input: longWaitMinutesInput, error: null, min: 1, max: 120, default: 15 },
      { key: 'awayAnswerWaitMinutes', input: awayAnswerWaitMinutesInput, error: null, min: 1, max: 30, default: 3 },
      { key: 'idleHideMinutes', input: idleHideMinutesInput, error: null, min: 5, max: 1440, default: 10 },
    ],
    mergeableConditionInputs,
    diagnosticsLevelSelect: { value: 'info', closest: () => ({ open: false }) },
    lastState: null,
    enqueueDisplayPatch: async () => false,
    renderSectionOrder() {},
  });
  vm.runInContext(`${render}\n${settle}\n${save}\nthis.renderSettings = renderDisplaySettings; this.savePreferences = saveDisplayPreferences;`, context);
  context.renderSettings();
  activeElement = mergeableConditionInputs[1];
  mergeableConditionInputs[1].checked = true;
  mergeableConditionInputs[2].checked = false;

  assert.equal(await context.savePreferences({ mergeableCondition: 'ci' }), false);

  assert.equal(activeElement, mergeableConditionInputs[1]);
  assert.equal(displayPreferences.mergeableCondition, 'cross-review');
  assert.deepEqual(mergeableConditionInputs.map((input) => input.checked), [false, false, true]);
});
