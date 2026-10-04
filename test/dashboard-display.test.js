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

test('注記は一覧と接続案内の後ろに置き、固定表示に含めない', () => {
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

    assert.ok(header >= 0 && summary > header && summary < headerEnd);
    assert.ok(headerEnd < root);
    assert.ok(root < connection);
    assert.ok(connection < reload);
    assert.ok(reload < hiddenKinds);
    assert.ok(hiddenKinds < hiddenSessions);
    assert.ok(hiddenSessions < finished);
  }
});

test('経路の切り替えには操作名を残し、補足文を表示しない', () => {
  for (const html of [mock, web]) {
    assert.doesNotMatch(html, /route-note|既定は Codex で実装|既定はクロスレビューの手順が推奨する方法/);
    assert.match(html, /role="group" aria-label="\$\{ROUTE\[[^\]]+\]\.label\}の経路"/);
  }
});

test('項目説明を消し、回答内容とマージ照合の SHA は残す', () => {
  for (const html of [mock, web]) {
    assert.doesNotMatch(html, /許可はデスクトップアプリの .*ダッシュボードからは出せない/);
    assert.doesNotMatch(html, /質問はデスクトップアプリの .*セッションで答える/);
    assert.doesNotMatch(html, /ほかの案は押して選べる|推奨が無いので、選択肢を押して選ぶか、指示の欄に答えを書く/);
    assert.doesNotMatch(html, /結果を PR を作ったセッションへ知らせる|このセッションが作った PR はありません/);
    assert.doesNotMatch(html, /リモートのブランチ .* は GitHub が自動で削除する/);
    assert.match(html, /OK で送る答え:/);
    assert.match(html, /照合する head SHA:/);
    assert.match(html, /選択した条件の未達:/);
  }
});

test('モックと実装の画面スクリプトを構文解析できる', () => {
  for (const html of [mock, web]) {
    const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
    assert.ok(script);
    assert.doesNotThrow(() => new vm.Script(script));
  }
});

test('モックに合わせた配色、札、タスク行を表示する', () => {
  assert.match(web, /--on-ok: #000000;/);
  assert.equal((web.match(/--on-ok: #1f1e1d;/g) || []).length, 2);
  assert.match(web, /\.merge-btn \{[^}]*color: var\(--on-ok\)/);
  assert.match(web, /\.merge-confirm \.merge-go \{[^}]*color: var\(--on-ok\)/);
  assert.doesNotMatch(web, /\.merge-confirm\.auto/);
  assert.match(web, /\.dataset\.mergeAfterReview = 'true'/);
  assert.match(web, /\.merge-confirm\.conflict \.conflict-go \{[^}]*color: var\(--on-danger\)/);
  assert.match(web, /\.badge\.new-mark \{ background: var\(--accent\); color: var\(--on-accent\); \}/);
  assert.match(web, /\.permission code \{/);
  assert.match(web, /\.settings-dialog \{ width: min\(440px,/);
  assert.match(web, /\.away-toggle \{[^}]*min-height: 40px/);
  assert.match(web, /\.criteria-list li::marker \{ content: "・"; \}/);

  const taskRowStyle = web.match(/\.task-item \{[^}]*\}/)?.[0];
  const taskTitleStyle = web.match(/\.task-title \{[^}]*\}/)?.[0];
  assert.ok(taskRowStyle && taskTitleStyle);
  assert.doesNotMatch(taskRowStyle, /background:/);
  assert.doesNotMatch(taskTitleStyle, /font-weight:/);
  assert.match(web, /\.task-item:hover \{ background: var\(--surface-2\); \}/);

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

test('経路札は起動時の設定を表示し、現在と違う設定には変更前を付ける', () => {
  const route = web.match(/const ROUTE = \{[\s\S]*?\n\};/)?.[0];
  const routeValues = web.match(/const ROUTE_VALUES = new Set\([^\n]+/)?.[0];
  const routeName = functionSource(web, 'routeName');
  const routeTag = functionSource(web, 'routeTag');
  const appendModelLine = functionSource(web, 'appendModelLine');
  assert.ok(route && routeValues && routeName && routeTag && appendModelLine);
  const context = pageContext(web, {
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

test('経路の欄は連携の組み合わせに応じて段を作り直す', async () => {
  const renderRouting = functionSource(web, 'renderRouting');
  const updateRouting = functionSource(web, 'updateRouting');
  const root = { innerHTML: '', hidden: false, dataset: {}, querySelectorAll: () => [] };
  const renderContext = pageContext(web, {
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
  const updateContext = pageContext(web, {
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

test('終了未確認のサブエージェント行に終了 API を呼ぶボタンを置く', () => {
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
  assert.match(web, /close\.dataset\.closeAgent = `\$\{session\.session_id\}::\$\{agent\.agent_id\}`/);
});

test('表示設定はサーバーの null のときだけ旧 localStorage から移し、通常変更は差分で送る', async () => {
  const sync = `async ${functionSource(web, 'syncDisplayPreferences')}`;
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
    pendingDisplaySettingSaves: new Map(),
    readDisplayPreferences: () => {
      legacyReads += 1;
      return { mode: 'kind', order: ['legacy'], pinned: [], collapsed: [], hidden: [], sectionOrder: ['now', 'judgment', 'tasks', 'sinceSeen', 'prs'] };
    },
    normalizeDisplayPreferences: (value) => value,
    renderSectionOrder() {},
    renderDisplaySettings() {},
    settleDisplaySettingSaves() {},
    settleDisplayPreferenceSaves() {},
    enqueueDisplayPatch: async (patch) => { syncCalls.push(patch); return true; },
    clearLegacyDisplayPreferences() {},
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
    pendingDisplaySettingSaves: new Map(),
    readDisplayPreferences: () => { throw new Error('旧設定は読み込まない'); },
    normalizeDisplayPreferences: (value) => value,
    renderSectionOrder() {},
    renderDisplaySettings() {},
    settleDisplaySettingSaves() {},
    settleDisplayPreferenceSaves() {},
    enqueueDisplayPatch: async (patch) => { syncCalls.push(patch); return true; },
    clearLegacyDisplayPreferences() {},
  });
  vm.runInContext(`${sync}\nthis.syncDisplayPreferences = syncDisplayPreferences;`, readyContext);
  await readyContext.syncDisplayPreferences({ mode: 'product', order: [], pinned: [], collapsed: [], hidden: [], sectionOrder: ['sinceSeen', 'judgment', 'tasks', 'now', 'prs'] });

  const save = functionSource(web, 'saveDisplayPreferences');
  const saveContext = pageContext(web, {
    displayPreferences: { mode: 'product', order: [], pinned: [], collapsed: [], hidden: [] },
    displayPreferencesReady: true,
    pendingDisplayChanges: {},
    displayPreferenceSaveStates: new Map(),
    settleDisplayPreferenceSaves: () => {},
    enqueueDisplayPatch: async (patch) => { syncCalls.push(patch); return true; },
  });
  vm.runInContext(`${save}\nthis.saveDisplayPreferences = saveDisplayPreferences;`, saveContext);
  saveContext.saveDisplayPreferences({ mode: 'kind' });

  assert.deepEqual(JSON.parse(JSON.stringify(syncCalls[1])), { mode: 'kind' });
  assert.equal(syncCalls.length, 2);
});

test('画面は未設定や不正なサーバー値を表示時間の既定値で補う', () => {
  const normalizeOrder = functionSource(web, 'normalizeSectionOrder');
  const normalizeMinutes = functionSource(web, 'normalizeDisplayMinutes');
  const normalizeDisplay = functionSource(web, 'normalizeDisplayPreferences');
  const context = pageContext(web, {
    DEFAULT_SECTION_ORDER: ['sinceSeen', 'judgment', 'tasks', 'now', 'prs'],
    DEFAULT_LONG_WAIT_MINUTES: 15,
    DEFAULT_AWAY_ANSWER_WAIT_MINUTES: 5,
    FILTERS: ['permission', 'blocking', 'provisional', 'agents', 'prs'].map((key) => ({ key })),
  });
  vm.runInContext(`${normalizeOrder}\n${normalizeMinutes}\n${normalizeDisplay}\nthis.normalizeDisplay = normalizeDisplayPreferences;`, context);
  const base = { mode: 'product', order: [], pinned: [], collapsed: [], hidden: [] };

  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeDisplay(base))), {
    ...base,
    sectionOrder: ['sinceSeen', 'judgment', 'tasks', 'now', 'prs'],
    longWaitMinutes: 15,
    awayAnswerWaitMinutes: 5,
    hideFinished: true,
    mergeableCondition: 'cross-review',
    mergeAfterReviewDefault: false,
  });
  assert.equal(context.normalizeDisplay({ ...base, hideFinished: false }).hideFinished, false);
  assert.equal(context.normalizeDisplay({ ...base, longWaitMinutes: 0, awayAnswerWaitMinutes: 31 }).longWaitMinutes, 15);
  assert.equal(context.normalizeDisplay({ ...base, longWaitMinutes: 0, awayAnswerWaitMinutes: 31 }).awayAnswerWaitMinutes, 5);
  assert.deepEqual(JSON.parse(JSON.stringify(context.normalizeDisplay({ ...base, hidden: ['held'] }).hidden)), []);
});

test('長い待ちの判定は設定値を使い、判断事項と許可待ちの表示へ反映する', () => {
  const normalizeMinutes = functionSource(web, 'normalizeDisplayMinutes');
  const isLongWait = functionSource(web, 'isLongWait');
  const elapsedLabel = functionSource(web, 'decisionElapsedLabel');
  const duration = functionSource(web, 'durationLabel');
  assert.ok(duration);
  const context = pageContext(web, { displayPreferences: { longWaitMinutes: 2 }, hasEffectiveAnswer: () => false });
  vm.runInContext(`${duration}\n${normalizeMinutes}\n${isLongWait}\n${elapsedLabel}\nthis.normalizeMinutes = normalizeDisplayMinutes; this.isLongWait = isLongWait; this.elapsedLabel = decisionElapsedLabel;`, context);

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
  assert.match(mock, /長く待たせているとみなす時間 \(1〜120 分\)/);
  assert.match(mock, /離席中に質問の回答を待つ時間 \(1〜30 分\)/);
});

test('表示時間の保存に失敗した数値設定を元に戻す', async () => {
  const setInput = functionSource(web, 'setDisplaySettingInput');
  const settingError = functionSource(web, 'displaySettingError');
  const change = functionSource(web, 'changeDisplaySetting');
  const patches = [];
  let saveCount = 0;
  const context = pageContext(web, {
    displayPreferences: { longWaitMinutes: 15 },
    displayPreferencesReady: true,
    pendingDisplaySettingSaves: new Map(),
    pendingDisplayChanges: {},
    longWaitMinutesInput: null,
    longWaitMinutesError: { hidden: true, textContent: '' },
    awayAnswerWaitMinutesError: { hidden: true, textContent: '' },
    lastState: null,
    renderDisplaySettings() {},
    enqueueDisplayPatch: async (patch) => { patches.push(patch); saveCount += 1; return saveCount === 1; },
  });
  context.longWaitMinutesInput = { valueAsNumber: 24, value: '24' };
  vm.runInContext(`${setInput}\n${settingError}\n${change}\nthis.changeDisplaySetting = changeDisplaySetting;`, context);
  const savedInput = { valueAsNumber: 24, value: '24' };
  const failedInput = { valueAsNumber: 30, value: '30' };

  assert.equal(await context.changeDisplaySetting('longWaitMinutes', savedInput, 1, 120), true);
  assert.equal(context.displayPreferences.longWaitMinutes, 24);
  assert.equal(await context.changeDisplaySetting('longWaitMinutes', failedInput, 1, 120), false);
  assert.deepEqual(JSON.parse(JSON.stringify(patches)), [{ longWaitMinutes: 24 }, { longWaitMinutes: 30 }]);
  assert.equal(context.displayPreferences.longWaitMinutes, 24);
  assert.equal(failedInput.value, '24');
});

test('モックの待ち時間設定を localStorage の UI 状態へ保存する', () => {
  const change = functionSource(mock, 'changeDisplaySetting');
  let saved = 0;
  let rendered = 0;
  const input = { valueAsNumber: 24, value: '24' };
  const context = pageContext(mock, {
    ui: { longWaitMinutes: 15 },
    captureDisplayPreferences: () => ({}),
    saveDisplayPreferences: () => { saved += 1; return true; },
    longWaitMinutesInput: input,
    longWaitMinutesError: { hidden: true, textContent: '' },
    awayAnswerWaitMinutesError: { hidden: true, textContent: '' },
    render: () => { rendered += 1; },
  });
  vm.runInContext(`${change}\nthis.changeDisplaySetting = changeDisplaySetting;`, context);
  assert.equal(context.changeDisplaySetting('longWaitMinutes', input, 1, 120), true);
  assert.equal(context.ui.longWaitMinutes, 24);
  assert.equal(saved, 1);
  assert.equal(rendered, 1);
});

test('セクションの並び順を保存し、端のボタンを無効化してフォーカスを維持する', () => {
  const sectionKinds = web.match(/const SECTION_KINDS = \[[\s\S]*?\n\];/)?.[0];
  const defaultOrder = web.match(/const DEFAULT_SECTION_ORDER = [^\n]+/)?.[0];
  const normalize = functionSource(web, 'normalizeSectionOrder');
  const renderOrder = functionSource(web, 'renderSectionOrder');
  const moveHandler = web.match(/sectionOrderList\.addEventListener\('click', \(event\) => \{[\s\S]*?\n\}\);/)?.[0];
  const resetHandler = web.match(/document\.getElementById\('settings-section-order-reset'\)\.addEventListener\('click', \(\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(sectionKinds && defaultOrder && normalize && renderOrder && moveHandler && resetHandler);
  assert.match(web, /id="settings-section-order" aria-labelledby="settings-section-order-title" aria-describedby="settings-section-order-note"/);
  assert.match(web, /\.settings-section-order \{ margin-top: 14px; \}/);
  assert.match(web, /\.section-order-list button \{ min-width: 36px; padding: 4px 8px; \}/);
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
  vm.runInContext([sectionKinds, defaultOrder, elementSource, normalize, renderOrder, moveHandler, resetHandler].join('\n'), context);
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
  assert.deepEqual(JSON.parse(JSON.stringify(context.displayPreferences.sectionOrder)), ['sinceSeen', 'judgment', 'tasks', 'now', 'prs']);
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

test('種類別の並び順札は表示せず、設定順にセクションを並べる', () => {
  const mockKind = functionSource(mock, 'renderKindMode');
  const webKind = functionSource(web, 'renderKindSections');

  assert.match(mockKind, /return orderedSectionKeys\(DEFAULT_SECTION_ORDER\)\.map\(key => sections\[key\]\)\.join\(''\)/);
  assert.doesNotMatch(mockKind, /orderBar|kind-order|kindProductOrder/);
  assert.match(webKind, /return orderedSectionKeys\(DEFAULT_SECTION_ORDER\)\.map\(\(key\) => sections\[key\]\)\.filter\(Boolean\)/);
  assert.doesNotMatch(webKind, /kindProductOrder|kind-order|productOrder/);
});

test('種類別とプロダクト別のセクションは設定順に並び、既定順では従来の順を保つ', () => {
  const constants = web.match(/const SECTION_KINDS = \[[\s\S]*?\n\];/)?.[0];
  const defaultOrder = web.match(/const DEFAULT_SECTION_ORDER = [^\n]+/)?.[0];
  const normalize = functionSource(web, 'normalizeSectionOrder');
  const ordered = functionSource(web, 'orderedSectionKeys');
  const visiblePullRequests = functionSource(web, 'visiblePullRequestGroups');
  const renderKinds = functionSource(web, 'renderKindSections');
  const renderSession = functionSource(web, 'sessionBlock');
  assert.ok(constants && defaultOrder && normalize && ordered && visiblePullRequests && renderKinds && renderSession);

  function renderWithOrder(sectionOrder) {
    const element = (tag, className = '', textContent = '') => ({
      tag, className, textContent, children: [], childNodes: [],
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
      hidesFinishedSession: () => false,
      appendAgents(target) { target.append({ marker: 'agent' }); },
      mainRow: () => ({ marker: 'main' }),
    });
    vm.runInContext([constants, defaultOrder, normalize, ordered, visiblePullRequests, renderKinds, renderSession].join('\n'), context);
    const kindSections = JSON.parse(JSON.stringify(
      context.renderKindSections([{ pullRequestGroups: [] }]).map(({ label }) => label),
    ));
    const session = { session_id: 'session-1', status: 'busy', decisions: [], tasks: [] };
    const sessionBlock = context.sessionBlock({ sessions: [session] }, session, false);
    const body = sessionBlock.children[0];
    const sessionParts = body.childNodes.map((node) => node.textContent || node.marker || (node.children[0]?.marker === 'main' ? 'now-content' : ''));
    return { kindSections, sessionParts };
  }

  const defaultResult = renderWithOrder(['sinceSeen', 'judgment', 'tasks', 'now', 'prs']);
  assert.deepEqual(defaultResult.kindSections, [
    '前回見てから', 'あなたの判断が必要なこと', 'タスクと完了条件', '今やっていること', 'プルリクエスト',
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
  const helpers = ['isFilterShown', 'hasEffectiveAnswer', 'shownActiveDecisions', 'hasHiddenJudgmentItems']
    .map((name) => functionSource(web, name));
  assert.ok(helpers.every(Boolean));
  vm.runInContext(`${helpers.join('\n')}\nthis.hasHidden = hasHiddenJudgmentItems;`, context);

  const categories = [
    ['permission', { permissionWaits: [{}], decisions: [] }],
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
  const labelSource = functionSource(web, 'kindToggleLabel');
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
  vm.runInContext(`${mockVisibility}\n${mockTaskBlock}\nthis.renderTasks = kindTaskSessionBlock;`, mockContext);
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
  assert.match(webKind, /appendKindTaskSession\(tasks, \{ product, session, multipleSessions \}, showTodoTasks, showDoneTasks\)/);
  assert.match(webKind, /appendKindToggle\(taskControls, 'todoTasks', showTodoTasks, todoTaskCount, '未着手のタスク'\)/);
  assert.match(webKind, /appendKindToggle\(taskControls, 'tasks', showDoneTasks, doneTaskCount, '完了したタスク'\)/);
  assert.match(webTaskBlock, /appendContextTags\(heading, product, session, true, true\)/);
  assert.match(webTaskBlock, /appendTaskItem\(list, task, product, session, false, multipleSessions\)/);
  assert.match(web, /\.group-frame \{[^}]*border: 1px solid var\(--border\)/);
});

test('種類別の描画では集約折り畳みだけを使い、プロダクト別のセッション単位は残す', () => {
  const mockKind = functionSource(mock, 'renderKindMode');
  const webKind = functionSource(web, 'renderKindSections');

  assert.match(mockKind, /kindToggle\('decisions', '解決済みと取り下げ', endedDecisionEntries\.length/);
  assert.match(mockKind, /kindToggle\('agents', '終了済み', endedAgentCount/);
  assert.match(mockKind, /kindToggle\('tasks', '完了したタスク', doneTaskCount/);
  assert.match(mockKind, /kindToggle\('todoTasks', '未着手のタスク', todoTaskCount/);
  assert.doesNotMatch(mockKind, /endedDecisionToggle\(session\)|endedAgentToggle\(session\)|taskSessionBlock\(p, session, true\)/);
  assert.match(webKind, /appendKindToggle\(endedDecisionControls, 'decisions'/);
  assert.match(webKind, /appendKindToggle\(activityControls, 'agents'/);
  assert.match(webKind, /appendKindToggle\(taskControls, 'tasks'/);
  assert.doesNotMatch(webKind, /appendPlanToggle\(endedDecisions|appendAgents\([^\n]*\);\s*\n\s*const list = holder\.querySelector\('\.agent-list'\);[\s\S]*data-ended-toggle/);

  assert.match(mock, /function decisionSessionBlock\([^]*?endedDecisionToggle\(session\)/);
  assert.match(mock, /function taskSessionBlock\([^]*?data-done-tasks/);
  assert.match(mock, /function taskSessionBlock\([^]*?data-todo-tasks/);
  assert.match(web, /function appendDecisions\([^]*?appendPlanToggle\(body, 'decisions', session\.session_id/);
  assert.match(web, /function appendTasks\([^]*?appendPlanToggle\(body, 'tasks', session\.session_id/);
  assert.match(web, /function appendTasks\([^]*?appendPlanToggle\(body, 'todoTasks', session\.session_id/);
});

test('定期の同期は入力中の待ち時間の欄を上書きせず、ほかの欄は保存値にそろえる', () => {
  const render = functionSource(web, 'renderDisplaySettings');
  assert.ok(render);
  const longWaitMinutesInput = { value: '120' };
  const awayAnswerWaitMinutesInput = { value: '9' };
  const hideFinishedInput = { checked: false };
  const mergeAfterReviewDefaultInput = { checked: false };
  const mergeableConditionInputs = ['operation', 'ci', 'cross-review'].map((value) => ({ value, checked: false }));
  const context = pageContext(web, {
    document: { activeElement: longWaitMinutesInput },
    longWaitMinutesInput,
    awayAnswerWaitMinutesInput,
    hideFinishedInput,
    mergeAfterReviewDefaultInput,
    mergeableConditionInputs,
    displayPreferences: { longWaitMinutes: 15, awayAnswerWaitMinutes: 5, hideFinished: false, mergeableCondition: 'ci', mergeAfterReviewDefault: true },
  });
  vm.runInContext(render, context);
  context.renderDisplaySettings();

  assert.equal(longWaitMinutesInput.value, '120');
  assert.equal(awayAnswerWaitMinutesInput.value, '5');
  assert.equal(hideFinishedInput.checked, false);
  assert.equal(mergeAfterReviewDefaultInput.checked, true);
  assert.deepEqual(mergeableConditionInputs.map((input) => input.checked), [false, true, false]);
});

test('保存に失敗したラジオはフォーカスを保ったまま保存値へ戻す', async () => {
  const render = functionSource(web, 'renderDisplaySettings');
  const settle = functionSource(web, 'settleDisplayPreferenceSaves');
  const save = functionSource(web, 'saveDisplayPreferences');
  assert.ok(render && settle && save);
  const longWaitMinutesInput = { value: '15' };
  const awayAnswerWaitMinutesInput = { value: '5' };
  const hideFinishedInput = { checked: true };
  const mergeAfterReviewDefaultInput = { checked: false };
  const mergeableConditionInputs = ['operation', 'ci', 'cross-review'].map((value) => ({ value, checked: false }));
  const displayPreferences = { mergeableCondition: 'cross-review', mergeAfterReviewDefault: true };
  let activeElement = null;
  const context = pageContext(web, {
    document: { get activeElement() { return activeElement; } },
    longWaitMinutesInput,
    awayAnswerWaitMinutesInput,
    hideFinishedInput,
    mergeAfterReviewDefaultInput,
    displayPreferences,
    displayPreferenceSaveStates: new Map(),
    displayPreferencesReady: true,
    mergeableConditionInputs,
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
