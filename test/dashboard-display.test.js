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
  assert.match(webKind, /if \(waitingItems\.length \|\| hasEndedDecisions \|\| !hasHiddenJudgments\)/);
  assert.match(webKind, /activityItems\.push\(\{ age: sessionActivityTime\(session\), row: mainRow/);
});
