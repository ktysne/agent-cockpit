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

test('種類別の終了項目は全セッションから新しい順に集約する', () => {
  const webHelpers = [
    functionSource(web, 'kindEndedDecisionEntries'),
    functionSource(web, 'kindEndedAgentEntries'),
    functionSource(web, 'kindTaskVisibility'),
    functionSource(web, 'kindDoneTaskCount'),
  ];
  const webContext = vm.createContext({ isEndedAgent: (agent) => !agent.active && !agent.unconfirmed });
  vm.runInContext(`${webHelpers.join('\n')}\nthis.collect = (references) => JSON.stringify({
    decisions: kindEndedDecisionEntries(references).map(({ decision }) => decision.id),
    agents: kindEndedAgentEntries(references).map(({ agent }) => agent.id),
    doneCount: kindDoneTaskCount(references),
    collapsed: kindTaskVisibility(references[0].session, false).visible.map((task) => task.id),
    expanded: kindTaskVisibility(references[0].session, true).visible.map((task) => task.id),
  });`, webContext);
  const webReferences = [
    { product: { name: 'A' }, session: {
      decisions: [
        { id: 'old', state: 'resolved', createdAt: '2026-10-01T00:00:00Z' },
        { id: 'active', state: 'waiting', createdAt: '2026-10-03T00:00:00Z' },
      ],
      agents: [{ id: 'agent-old', active: false, startedAt: '2026-10-01T00:00:00Z' }],
      tasks: [{ id: 'open', state: 'todo' }, { id: 'done-a', state: 'done' }],
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
    agents: ['agent-new', 'agent-old'],
    doneCount: 2,
    collapsed: ['open'],
    expanded: ['open', 'done-a'],
  });

  const mockHelpers = [
    functionSource(mock, 'kindEndedDecisionEntries'),
    functionSource(mock, 'kindEndedAgentEntries'),
    functionSource(mock, 'kindTaskVisibility'),
    functionSource(mock, 'kindDoneTaskCount'),
  ];
  const mockContext = vm.createContext({
    effectiveDecisionState: (decision) => decision.state,
    ageMinutes: (item) => item.age,
    isEndedAgent: (_session, agent) => agent.ended,
    taskState: (session, task) => session.closed?.includes(task.id) ? 'done' : task.state,
  });
  vm.runInContext(`${mockHelpers.join('\n')}\nthis.collect = (sessions) => JSON.stringify({
    decisions: kindEndedDecisionEntries(sessions).map(({ decision }) => decision.id),
    agents: kindEndedAgentEntries(sessions).map(({ agent }) => agent.id),
    doneCount: kindDoneTaskCount(sessions),
    collapsed: kindTaskVisibility(sessions[0].session, false).visible.map((task) => task.id),
    expanded: kindTaskVisibility(sessions[0].session, true).visible.map((task) => task.id),
  });`, mockContext);
  const mockSessions = [
    { p: { name: 'A' }, session: {
      decisions: [{ id: 'old', state: 'resolved', age: 10 }, { id: 'active', state: 'waiting', age: 0 }],
      subagents: [{ id: 'agent-old', ended: true, age: 10 }],
      tasks: [{ id: 'open', state: 'todo' }, { id: 'done-a', state: 'done' }],
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
    agents: ['agent-new', 'agent-old'],
    doneCount: 2,
    collapsed: ['open'],
    expanded: ['open', 'done-a'],
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
  const mockVisibility = functionSource(mock, 'kindTaskVisibility');
  const mockContext = vm.createContext({
    taskState: (_session, task) => task.state,
    sessionTag: (_product, _session, _withTag, includeSession) => includeSession ? 'PRODUCT SESSION' : '',
    taskItem: (_product, _session, task, withTag) => `<li data-tags="${withTag}">${task.title}</li>`,
  });
  vm.runInContext(`${mockVisibility}\n${mockTaskBlock}\nthis.renderTasks = kindTaskSessionBlock;`, mockContext);
  const output = mockContext.renderTasks(
    { name: 'agent-cockpit' },
    { id: 'session-a', tasksUpdatedMin: 5, tasks: [{ title: '表示タスク', state: 'doing' }, { title: '完了タスク', state: 'done' }] },
    false,
  );
  assert.match(output.html, /class="kind-task-head">PRODUCT SESSION<span class="meta">最終更新 5 分前<\/span>/);
  assert.doesNotMatch(output.html, /タスクと完了条件/);
  assert.match(output.html, /<li data-tags="false">表示タスク<\/li>/);
  assert.doesNotMatch(output.html, /完了タスク/);
  assert.equal(output.doneCount, 1);

  const webKind = functionSource(web, 'renderKindSections');
  const webTaskBlock = functionSource(web, 'appendKindTaskSession');
  assert.match(webKind, /appendKindTaskSession\(tasks, \{ product, session, multipleSessions \}, showDoneTasks\)/);
  assert.match(webKind, /appendKindToggle\(tasks, 'tasks', showDoneTasks, doneTaskCount, '完了したタスク'\)/);
  assert.match(webTaskBlock, /appendContextTags\(heading, product, session, true, true\)/);
  assert.match(webTaskBlock, /appendTaskItem\(list, task, product, session, false, multipleSessions\)/);
  assert.match(web, /\.kind-session-tasks \+ \.kind-session-tasks \{[^}]*border-top: 1px solid var\(--border\)/);
});

test('種類別の描画では集約折り畳みだけを使い、プロダクト別のセッション単位は残す', () => {
  const mockKind = functionSource(mock, 'renderKindMode');
  const webKind = functionSource(web, 'renderKindSections');

  assert.match(mockKind, /kindToggle\('decisions', '解決済みと取り下げ', endedDecisionEntries\.length/);
  assert.match(mockKind, /kindToggle\('agents', '終了済み', endedAgentEntries\.length/);
  assert.match(mockKind, /kindToggle\('tasks', '完了したタスク', doneTaskCount/);
  assert.doesNotMatch(mockKind, /endedDecisionToggle\(session\)|endedAgentToggle\(session\)|taskSessionBlock\(p, session, true\)/);
  assert.match(webKind, /appendKindToggle\(endedDecisions, 'decisions'/);
  assert.match(webKind, /appendKindToggle\(activity, 'agents'/);
  assert.match(webKind, /appendKindToggle\(tasks, 'tasks'/);
  assert.doesNotMatch(webKind, /appendPlanToggle\(endedDecisions|appendAgents\([^\n]*\);\s*\n\s*const list = holder\.querySelector\('\.agent-list'\);[\s\S]*data-ended-toggle/);

  assert.match(mock, /function decisionSessionBlock\([^]*?endedDecisionToggle\(session\)/);
  assert.match(mock, /function taskSessionBlock\([^]*?data-done-tasks/);
  assert.match(web, /function appendDecisions\([^]*?appendPlanToggle\(body, 'decisions', session\.session_id/);
  assert.match(web, /function appendTasks\([^]*?appendPlanToggle\(body, 'tasks', session\.session_id/);
});
