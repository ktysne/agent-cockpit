const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { functionSource } = require('./support/page-context');

const html = fs.readFileSync(path.join(__dirname, '../src/web/index.html'), 'utf8').replace(/\r\n/g, '\n');

function noticeContext(navigator = {}) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: '', value: '',
      focus() { this.focused = true; }, select() { this.selected = true; } });
    return nodes.get(id);
  };
  const context = vm.createContext({ document: { getElementById: get }, updateNote: get('update-note'), updatePrompt: '', navigator });
  vm.runInContext(['applyUpdateState', 'copyUpdatePrompt'].map(name => functionSource(html, name)).join('\n'), context);
  return { context, get };
}

const update = { current: '0.0.0', latest: '1.0.0', available: true,
  prompt: 'agent-cockpit を v1.0.0 に更新して。手順は C:/checkout/docs/update.md にある。',
  compareUrl: 'https://github.com/ktysne/agent-cockpit/tree/v1.0.0' };

test('新しい版だけを通知欄に表示し、通知が無くなれば隠す', () => {
  const { context, get } = noticeContext();
  assert.match(html, /class="filter-note" id="update-note" role="status"/);
  assert.match(html, /id="update-compare" target="_blank" rel="noopener noreferrer"/);
  context.applyUpdateState(update);
  assert.equal(get('update-note').hidden, false);
  assert.equal(get('update-message').textContent, '新しい版 v1.0.0 があります。');
  assert.equal(get('update-compare').href, update.compareUrl);
  for (const value of [{ available: false }, null, undefined]) {
    context.applyUpdateState(value);
    assert.equal(get('update-note').hidden, true);
  }
});

test('コピーできたときは AI へ貼り付ける案内を通知欄に出す', async () => {
  const copied = [];
  const { context, get } = noticeContext({ clipboard: { writeText: async text => copied.push(text) } });
  context.applyUpdateState(update);
  await context.copyUpdatePrompt();
  assert.deepEqual(copied, [update.prompt]);
  assert.match(get('update-copy-status').textContent, /コピーしました.*AI/);
  assert.equal(get('update-prompt').hidden, true);
});

test('クリップボードが使えなければ依頼文を選択表示し、同じ通知の再取得でも保持する', async () => {
  for (const navigator of [{}, { clipboard: { writeText: async () => { throw new Error('denied'); } } }]) {
    const { context, get } = noticeContext(navigator);
    context.applyUpdateState(update);
    await context.copyUpdatePrompt();
    const field = get('update-prompt');
    assert.equal(field.value, update.prompt);
    assert.equal(field.hidden, false);
    assert.equal(field.focused, true);
    assert.equal(field.selected, true);
    context.applyUpdateState(update);
    assert.equal(field.hidden, false);
    assert.match(get('update-copy-status').textContent, /選択しました/);
  }
});

test('版はウィンドウのタイトルにだけ付け、見出しは名前だけにする', () => {
  assert.match(html, /alt="">Agent Cockpit<\/h1>/);
  const context = vm.createContext({ appVersion: '', document: { title: '' },
    countJudgments: () => ({ permission: 1, blocking: 1 }) });
  vm.runInContext(['formatRuntime', 'applyAppVersion', 'updateTitle'].map(name => functionSource(html, name)).join('\n'), context);
  context.applyAppVersion('1.0.0');
  context.updateTitle([]);
  assert.equal(context.document.title, '(2) Agent Cockpit v1.0.0');
  context.applyAppVersion(null);
  context.countJudgments = () => ({ permission: 0, blocking: 0 });
  context.updateTitle([]);
  assert.equal(context.document.title, 'Agent Cockpit');
});

test('refresh は後に始めた取得を反映した後に届いた古い応答で状態を戻さない', async () => {
  const responses = [];
  const context = vm.createContext({
    fetchUi: () => new Promise((resolve) => responses.push(resolve)), checkUiVersion: () => false,
    syncDisplayPreferences: async () => {}, updateConnectionNote() {}, header: { dataset: {} },
    applyAwayState() {}, applyUpdateState() {}, applyAppVersion() {}, refreshConfirmPending: false,
    refreshSequence: 0, appliedRefreshSequence: 0, pullRequestUnconfirmedResults: new Map(),
    sinceSeenMode: 'off', pullRequestExpirySignature: () => '', renderedPullRequestExpirySignature: '',
    lastVersion: 0, lastState: null, lastStateEtag: null, liveStatus: {}, render() {}, countJudgments: () => ({ permission: 0, decisions: 0 }),
    isIdleHiddenSession: () => false,
  });
  vm.runInContext(functionSource(html, 'refresh'), context);
  const older = context.refresh();
  const newer = context.refresh();
  const newerState = { version: 2, sessions: [], away: {}, update, pullRequests: [] };
  responses[1]({ ok: true, headers: { get: () => 'newer' }, json: async () => newerState });
  await newer;
  responses[0]({ ok: true, headers: { get: () => 'older' }, json: async () => ({ version: 1, sessions: [], away: {}, update, pullRequests: [] }) });
  assert.equal(await older, true);
  assert.equal(context.lastState, newerState);
  assert.equal(context.appliedRefreshSequence, 2);
});

test('refresh は状態の version が同じでも新しい通知を描き直す', async () => {
  const notices = [];
  const state = { version: 1, sessions: [], away: {}, update, pullRequests: [] };
  const context = vm.createContext({
    fetchUi: async () => ({ ok: true, headers: { get: () => 'same' }, json: async () => state }), checkUiVersion: () => false,
    syncDisplayPreferences: async () => {}, updateConnectionNote() {}, header: { dataset: {} },
    applyAwayState() {}, applyUpdateState: value => notices.push(value), applyAppVersion() {}, refreshConfirmPending: false, refreshSequence: 0, appliedRefreshSequence: 0, pullRequestUnconfirmedResults: new Map(),
    sinceSeenMode: 'off', pullRequestExpirySignature: () => '', renderedPullRequestExpirySignature: '',
    lastVersion: 1, lastStateEtag: 'same', liveStatus: {}, render: () => assert.fail('状態全体は描き直さない'),
  });
  vm.runInContext(functionSource(html, 'refresh'), context);
  await context.refresh();
  assert.deepEqual(notices, [update]);
});

function refreshContext(fetch) {
  const state = { version: 1, sessions: [], away: {}, pullRequests: [] };
  const failures = [];
  const renders = [];
  const context = vm.createContext({
    fetch, reportWebFailure: (...args) => failures.push(args), checkUiVersion: () => false,
    syncDisplayPreferences: async () => {}, updateConnectionNote() {}, header: { dataset: {} },
    applyAwayState() {}, applyUpdateState() {}, applyAppVersion() {}, refreshConfirmPending: false,
    refreshSequence: 0, appliedRefreshSequence: 0, pullRequestUnconfirmedResults: new Map(),
    sinceSeenMode: 'off', pullRequestExpirySignature: () => '', renderedPullRequestExpirySignature: '',
    lastVersion: 1, lastState: state, lastStateEtag: '"first"', connectionLost: true, lastStateAt: null,
    liveStatus: {}, hasRenderedState: true, render: value => renders.push(value),
  });
  vm.runInContext(['fetchUi', 'refresh'].map(name => functionSource(html, name)).join('\n'), context);
  return { context, state, failures, renders };
}

test('304 は前回の状態を保ち、切断からの復帰と時刻に応じた表示更新を成功として扱う', async () => {
  let options;
  const { context, state, failures, renders } = refreshContext(async (_url, value) => {
    options = value;
    return { status: 304, ok: false, json: () => assert.fail('304 の本文は読まない') };
  });
  context.pullRequestExpirySignature = () => 'expired';
  assert.equal(await context.refresh(), true);
  assert.equal(options.cache, 'no-store');
  assert.equal(options.headers['If-None-Match'], '"first"');
  assert.equal(context.lastState, state);
  assert.equal(context.connectionLost, false);
  assert.ok(context.lastStateAt);
  assert.deepEqual(failures, []);
  assert.deepEqual(renders, [state]);
});

test('接続に失敗しても ETag を保ち、復帰後の 200 で新しい ETag を保存する', async () => {
  let offline = true;
  const next = { version: 1, sessions: [], away: {}, pullRequests: [] };
  const { context, renders } = refreshContext(async () => {
    if (offline) throw new Error('offline');
    return { status: 200, ok: true, headers: { get: () => '"next"' }, json: async () => next };
  });
  assert.equal(await context.refresh(), false);
  assert.equal(context.lastStateEtag, '"first"');
  offline = false;
  assert.equal(await context.refresh(), true);
  assert.equal(context.lastStateEtag, '"next"');
  assert.equal(context.connectionLost, false);
  assert.deepEqual(renders, [next]);
});

function updateCheckContext(send) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { disabled: false, textContent: '' });
    return nodes.get(id);
  };
  const posted = [];
  const applied = [];
  const context = vm.createContext({
    updateCheckButton: get('update-check'), updateCheckStatus: get('update-check-status'),
    postUiAction: async (url, body) => { posted.push([url, body]); return send(); },
    applyUpdateState: update => applied.push(update),
  });
  vm.runInContext(functionSource(html, 'checkForUpdate'), context);
  return { context, get, posted, applied };
}

const jsonResponse = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });

test('更新を確認は、最新なら何も出さず、それ以外は結果を一行で出し、新しい版では通知欄も更新する', async () => {
  const latest = { ...update, current: '0.0.0', checkedAt: 'x', error: null };
  const cases = [
    { body: { current: '1.0.1', latest: '1.0.1', available: false, checkedAt: 'x', error: null }, status: 200,
      message: '', applied: [] },
    { body: latest, status: 200, message: '新しい版 v1.0.0 があります。', applied: [latest] },
    { body: { current: '1.0.1', latest: null, available: false, checkedAt: 'x', error: 'TIMEOUT' }, status: 200,
      message: '確認できませんでした。時間をおいてやり直してください。', applied: [] },
    { body: { error: 'Internal Server Error' }, status: 500,
      message: '確認できませんでした。時間をおいてやり直してください。', applied: [] },
    { body: { error: 'update-check-disabled' }, status: 409,
      message: 'この常駐サーバーでは更新を確認できません。', applied: [] },
  ];
  for (const { body, status, message, applied: expected } of cases) {
    const { context, get, posted, applied } = updateCheckContext(async () => jsonResponse(status, body));
    await context.checkForUpdate();
    assert.equal(JSON.stringify(posted), JSON.stringify([['/api/update/check', {}]]));
    assert.equal(get('update-check-status').textContent, message);
    assert.equal(get('update-check').disabled, false);
    assert.equal(get('update-check').textContent, '更新を確認');
    assert.equal(JSON.stringify(applied), JSON.stringify(expected));
  }
});

test('更新を確認は、通信に失敗したら確認できなかった文言を出す', async () => {
  const { context, get } = updateCheckContext(async () => { throw new Error('offline'); });
  await context.checkForUpdate();
  assert.equal(get('update-check-status').textContent, '確認できませんでした。時間をおいてやり直してください。');
  assert.equal(get('update-check').disabled, false);
});

test('更新を確認は、確認の間だけボタンを無効にして確認中と表示する', async () => {
  let finish;
  const { context, get } = updateCheckContext(() => new Promise(resolve => { finish = resolve; }));
  const running = context.checkForUpdate();
  assert.equal(get('update-check').disabled, true);
  assert.equal(get('update-check').textContent, '確認中…');
  finish(jsonResponse(200, { current: '1.0.1', latest: '1.0.1', available: false, checkedAt: 'x', error: null }));
  await running;
  assert.equal(get('update-check').disabled, false);
  assert.equal(get('update-check').textContent, '更新を確認');
});
