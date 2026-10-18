const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readWebPage, functionSource, pageContext } = require('./support/page-context');

const web = readWebPage();
const mock = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8');

function element(tagName, className = '', text = '') {
  return { tagName, className, ownText: text, children: [], dataset: {}, handlers: {},
    get textContent() { return this.ownText + this.children.map(child => child.textContent).join(''); },
    append(...children) { this.children.push(...children); },
    setAttribute(name, value) { this[name] = value; },
    addEventListener(name, handler) { this.handlers[name] = handler; },
  };
}

function context(overrides = {}) {
  const result = pageContext(web, {
    element, worktreeActionStatus: new Map(), worktreeActionInFlight: new Set(),
    TERMINAL_LABELS: { auto: '自動', 'windows-terminal': 'Windows Terminal', pwsh: 'PowerShell 7', powershell: 'Windows PowerShell', cmd: 'コマンドプロンプト' },
    absoluteTimeLabel: () => '12:00', shownActiveDecisions: session => session.decisions || [],
    ...overrides,
  });
  const names = ['worktreeStatus', 'worktreeButton', 'appendWorktreeButtons', 'verifyLaunchPending', 'appendVerifyPanel',
    'verifyNextText', 'appendWorktreeLinks', 'decisionAnswerAvailability', 'runWorktreeAction'];
  vm.runInContext(names.map(name => functionSource(web, name)).join('\n'), result);
  return result;
}

function fixture() {
  const worktree = { path: 'D:/worktrees/verify', branch: 'feature/verify', base: 'main', ahead: 2, uncommitted: 3, missing: false };
  const decision = { id: 'verify-id', source: 'mcp', state: 'waiting', verify: { steps: [{ cmd: 'npm start', note: '小数を入力する' }] },
    questions: [{ question: '確認してください', options: [
      { label: '確認した', recommended: true, next: 'PR の欄に出ます。' },
      { label: '直してほしい', next: '直したら再び届きます。' },
    ] }] };
  return { session: { session_id: 'session-id', worktree, decisions: [decision] }, decision };
}

test('確認欄の文言と並びは未起動、依頼中、URL 起動、プロセス起動でモックと一致する', () => {
  const { session, decision } = fixture();
  const live = context();
  const launches = new Map();
  const reference = pageContext(mock, { esc: String, verifyLaunches: launches, worktreeActionStatus: new Map(), absoluteTimeLabel: () => '12:00' });
  vm.runInContext(['worktreeButtons', 'worktreeStatus', 'launchButton', 'launchRow', 'verifyPanel'].map(name => functionSource(mock, name)).join('\n'), reference);
  for (const launch of [null, { state: 'requested' }, { state: 'running', url: 'http://localhost:3000/', at: '2026-10-18T03:00:00Z' },
    { state: 'running', process: 'Rec Studio.exe', at: '2026-10-18T03:00:00Z' }]) {
    launches.set(decision.id, launch);
    decision.launchRequestedAt = launch?.state === 'requested' ? '2026-10-18T03:00:00Z' : undefined;
    decision.verify.launched = launch?.state === 'running' ? launch : undefined;
    const root = element('article');
    live.appendVerifyPanel(root, decision, session);
    const rendered = root.textContent.replace(/\s+/g, '');
    const expected = reference.verifyPanel({ id: decision.id, verify: { ...session.worktree, ...decision.verify } })
      .replace(/<[^>]*>/g, '').replace(/\s+/g, '');
    assert.equal(rendered, expected);
  }
});

test('起動依頼が起動報告より新しい間だけ待機し、未取得の情報と削除済み worktree を示す', () => {
  const { session, decision } = fixture();
  const live = context();
  decision.verify.launched = { process: 'app', at: '2026-10-18T03:00:00Z' };
  decision.launchRequestedAt = '2026-10-18T03:01:00Z';
  session.worktree = { path: session.worktree.path, missing: true };
  const root = element('article');
  live.appendVerifyPanel(root, decision, session);
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  assert.match(root.textContent, /読み取り中/);
  assert.match(root.textContent, /worktree が見つかりません \(削除済み\)/);
  assert.ok(flatten(root).find(node => node.textContent === 'もう一度起動を頼む').disabled);
  assert.ok(flatten(root).find(node => node.textContent === 'ターミナルで開く').disabled);
  assert.doesNotMatch(root.textContent, /未コミット|すべてコミット済み/);
});

test('起動依頼の待ち中も頼み直せ、Codex には届く操作を案内し、操作ボタンにフォーカス復元の印を付ける', () => {
  const { session, decision } = fixture();
  const live = context();
  decision.launchRequestedAt = '2026-10-18T03:01:00Z';
  const flatten = node => [node, ...node.children.flatMap(flatten)];
  const root = element('article');
  live.appendVerifyPanel(root, decision, session);
  const again = flatten(root).find(node => node.textContent === 'もう一度起動を頼む');
  assert.equal(again.disabled, false);
  assert.match(root.textContent, /セッションが起動すると、ここに起動先が出ます/);
  assert.deepEqual({ ...again.dataset }, { worktreeKey: decision.id, worktreeAction: 'launch', worktreeIndex: '' });
  assert.deepEqual(flatten(root).filter(node => node.dataset?.worktreeAction === 'step').map(node => node.dataset.worktreeIndex),
    decision.verify.steps.map((step, index) => String(index)));
  const codex = element('article');
  live.appendVerifyPanel(codex, decision, { ...session, provider: 'codex' });
  assert.match(codex.textContent, /Codex のセッションには、次にプロンプトを送ると依頼が届きます/);
});

test('回答後は推奨または選んだ選択肢の next を表示し、説明文は使わない', () => {
  const { decision } = fixture();
  const live = context();
  decision.answer = { sentAt: '2026-10-18T03:00:00Z', choice: 'ok' };
  assert.equal(live.verifyNextText(decision), '次: PR の欄に出ます。');
  decision.answer = { ...decision.answer, choice: 'pick', picks: [['直してほしい']] };
  assert.equal(live.verifyNextText(decision), '次: 直したら再び届きます。');
  decision.questions[0].options[1].next = undefined;
  decision.questions[0].options[1].description = '説明';
  assert.equal(live.verifyNextText(decision), '');
});

test('セッション見出しの操作は確認依頼を表示している間だけ隠し、MCP waiting は回答可能にする', () => {
  const { session, decision } = fixture();
  const live = context();
  const root = element('div');
  live.appendWorktreeLinks(root, session);
  assert.equal(root.children.length, 0);
  session.decisions = [];
  live.appendWorktreeLinks(root, session);
  assert.equal(root.textContent, 'ターミナルで開くパスをコピー');
  assert.equal(live.decisionAnswerAvailability(decision).active, true);
  decision.source = 'ask';
  assert.equal(live.decisionAnswerAvailability(decision).active, false);
  assert.equal(live.decisionAnswerAvailability(decision).viaDialog, true);
});

test('画面は起動依頼と端末には ID だけを送り、コピーはブラウザー内で行う', async () => {
  const { session, decision } = fixture();
  const requests = [];
  const copied = [];
  const live = context({ lastState: null, refresh: async () => {}, navigator: { clipboard: { writeText: async text => copied.push(text) } },
    postUiAction: async (url, body) => { requests.push({ url, body }); return { ok: true, json: async () => ({ terminal: 'powershell' }) }; } });
  await live.runWorktreeAction('launch', session, decision);
  await live.runWorktreeAction('terminal', session, decision);
  await live.runWorktreeAction('terminal', session, null);
  await live.runWorktreeAction('copy', session, decision, session.worktree.path);
  await live.runWorktreeAction('step', session, decision, 'npm start');
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { url: '/api/verify/launch', body: { session_id: session.session_id, decision_id: decision.id } },
    { url: '/api/worktree/terminal', body: { decision_id: decision.id } },
    { url: '/api/worktree/terminal', body: { session_id: session.session_id } },
  ]);
  assert.deepEqual(copied, [session.worktree.path, 'npm start']);
});

test('ターミナルを開いた成功表示に応答の端末名を使う', async () => {
  const { session, decision } = fixture();
  const live = context({ lastState: null, postUiAction: async () => ({ ok: true, json: async () => ({ terminal: 'windows-terminal' }) }) });
  await live.runWorktreeAction('terminal', session, decision);
  assert.equal(live.worktreeActionStatus.get(decision.id), 'Windows Terminal で開きました');
});
