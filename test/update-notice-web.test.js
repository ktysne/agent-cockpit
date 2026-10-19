const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { readWebPage, functionSource } = require('./support/page-context');

const html = readWebPage().replace(/\r\n/g, '\n');
const mockHtml = fs.readFileSync(path.join(__dirname, '../mock/index.html'), 'utf8').replace(/\r\n/g, '\n');

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

test('新しいバージョンだけを通知欄に表示し、通知が無くなれば隠す', () => {
  const { context, get } = noticeContext();
  assert.match(html, /class="filter-note" id="update-note" role="status"/);
  assert.match(html, /id="update-compare" target="_blank" rel="noopener noreferrer"/);
  context.applyUpdateState(update);
  assert.equal(get('update-note').hidden, false);
  assert.equal(get('update-message').textContent, '新しいバージョン v1.0.0 があります。');
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

test('バージョンはウィンドウのタイトルにだけ付け、見出しは名前だけにする', () => {
  assert.match(html, /alt="">Agent Cockpit<\/h1>/);
  const context = vm.createContext({ appVersion: '', document: { title: '' },
    countJudgments: () => ({ permission: 1, blocking: 1 }) });
  vm.runInContext(['formatRuntime', 'applyAppVersion', 'updateTitle'].map(name => functionSource(html, name)).join('\n'), context);
  context.applyAppVersion('1.0.0');
  context.updateTitle([]);
  assert.equal(context.document.title, '(2) Agent Cockpit v1.0.0');
  context.applyAppVersion(null, { version: '1.4.0', commit: 'c933f60abcdef', sourceState: 'dirty' });
  context.updateTitle([]);
  assert.equal(context.document.title, '(2) Agent Cockpit v1.4.0');
  context.applyAppVersion(null);
  context.countJudgments = () => ({ permission: 0, blocking: 0 });
  context.updateTitle([]);
  assert.equal(context.document.title, 'Agent Cockpit');
});

test('refresh は後に始めた取得を反映した後に届いた古い応答で状態を戻さない', async () => {
  const requests = [];
  const harness = refreshContext((_url, options) => new Promise((resolve, reject) => {
    requests.push({ options, resolve, reject });
  }));
  const { context } = harness;
  const older = context.refresh();
  const failed = context.refresh();
  const newer = context.refresh();
  const newerState = { uiVersion: 'v1', version: 2, sessions: [], away: {}, update, pullRequests: [] };
  requests[2].resolve({ ok: true, headers: { get: () => 'newer' }, json: async () => newerState });
  await newer;
  requests[0].resolve({ ok: true, headers: { get: () => 'older' }, json: async () => ({
    uiVersion: 'v2', version: 1, sessions: [], away: {}, update, pullRequests: [],
  }) });
  await older;
  requests[1].reject(new Error('offline'));
  assert.equal(await failed, true);
  assert.equal(context.lastState, newerState);
  assert.equal(context.appliedRefreshSequence, 3);
  assert.equal(context.connectionLost, false);
  assert.equal(harness.reloadCount, 0);
});

test('refresh は状態の version が同じでも新しい通知を描き直す', async () => {
  const notices = [];
  const state = { version: 1, sessions: [], away: {}, update, pullRequests: [] };
  const context = vm.createContext({
    fetchUi: async () => ({ ok: true, headers: { get: () => 'same' }, json: async () => state }), checkUiVersion: () => false,
    syncDisplayPreferences: async () => {}, updateConnectionNote() {}, header: { dataset: {} },
    applyAwayState() {}, renderRestartNote() {}, renderPersistenceNote() {}, applyUpdateState: value => notices.push(value), applyAppVersion() {}, refreshConfirmPending: false, refreshSequence: 0, appliedRefreshSequence: 0, pullRequestUnconfirmedResults: new Map(),
    pendingStateReads: 0, AbortSignal: { timeout: () => ({}) },
    sinceSeenMode: 'off', pullRequestExpirySignature: () => '', renderedPullRequestExpirySignature: '',
    lastVersion: 1, lastStateEtag: 'same', liveStatus: {}, pruneStaleConfirmations() {}, render: () => assert.fail('状態全体は描き直さない'),
  });
  vm.runInContext(functionSource(html, 'refresh'), context);
  await context.refresh();
  assert.deepEqual(notices, [update]);
});

function refreshContext(fetch, syncDisplayPreferences = async () => {}) {
  const state = { version: 1, sessions: [], away: {}, pullRequests: [] };
  const failures = [];
  const renders = [];
  let reloadCount = 0;
  const context = vm.createContext({
    fetch, reportWebFailure: (...args) => failures.push(args), initialUiVersion: 'v1', uiUpdatePending: false,
    hasUnsentAnswerDraft: () => false, location: { reload: () => { reloadCount += 1; } },
    syncDisplayPreferences, updateConnectionNote() {}, header: { dataset: {} },
    applyAwayState() {}, renderRestartNote() {}, renderPersistenceNote() {}, applyUpdateState() {}, applyAppVersion() {}, refreshConfirmPending: false,
    refreshSequence: 0, appliedRefreshSequence: 0, pendingStateReads: 0, pullRequestUnconfirmedResults: new Map(),
    AbortSignal: { timeout: (milliseconds) => ({ timeoutMs: milliseconds }) },
    sinceSeenMode: 'off', pullRequestExpirySignature: () => '', renderedPullRequestExpirySignature: '',
    lastVersion: 1, lastState: state, lastStateEtag: '"first"', connectionLost: true, lastStateAt: null,
    liveStatus: {}, hasRenderedState: true, pruneStaleConfirmations() {}, render: value => renders.push(value),
    countJudgments: () => ({ permission: 0, decisions: 0 }), isIdleHiddenSession: () => false,
  });
  vm.runInContext(['fetchUi', 'pollRefresh', 'checkUiVersion', 'refresh'].map(name => functionSource(html, name)).join('\n'), context);
  return { context, state, failures, renders, get reloadCount() { return reloadCount; } };
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
  assert.equal(options.signal.timeoutMs, 10_000);
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

test('定期 poll は状態取得中だけ待ち、表示設定の同期中は次の状態を取得する', async () => {
  const requests = [];
  let releaseDisplaySync;
  let markDisplaySyncStarted;
  const displaySyncGate = new Promise(resolve => { releaseDisplaySync = resolve; });
  const displaySyncStarted = new Promise(resolve => { markDisplaySyncStarted = resolve; });
  let displaySyncCount = 0;
  const syncDisplayPreferences = async () => {
    displaySyncCount += 1;
    if (displaySyncCount === 1) {
      markDisplaySyncStarted();
      await displaySyncGate;
    }
  };
  const { context } = refreshContext((_url, options) => new Promise((resolve, reject) => {
    requests.push({ options, resolve, reject });
  }), syncDisplayPreferences);
  const firstRefresh = context.refresh();

  context.pollRefresh();
  assert.equal(requests.length, 1);
  const firstState = { uiVersion: 'v1', version: 1, display: {}, sessions: [], away: {}, pullRequests: [] };
  requests[0].resolve({ ok: true, headers: { get: () => 'first' }, json: async () => firstState });
  await displaySyncStarted;

  const poll = context.pollRefresh();
  assert.equal(requests.length, 2);
  const polledState = { ...firstState };
  requests[1].resolve({ ok: true, headers: { get: () => 'polled' }, json: async () => polledState });
  assert.equal(await poll, true);
  releaseDisplaySync();
  assert.equal(await firstRefresh, true);
  assert.equal(context.lastState, polledState);
  assert.equal(context.lastStateEtag, 'polled');
});

test('定期 poll の通信中でも明示 refresh は新しい状態を取得する', async () => {
  const requests = [];
  const { context } = refreshContext((_url, options) => new Promise((resolve, reject) => {
    requests.push({ options, resolve, reject });
  }));
  const poll = context.pollRefresh();
  const explicit = context.refresh();

  assert.equal(requests.length, 2);
  const state = { uiVersion: 'v1', version: 1, display: {}, sessions: [], away: {}, pullRequests: [] };
  requests[1].resolve({ ok: true, headers: { get: () => 'explicit' }, json: async () => state });
  assert.equal(await explicit, true);
  requests[0].resolve({ ok: true, headers: { get: () => 'poll' }, json: async () => ({ ...state }) });
  assert.equal(await poll, true);
  assert.equal(context.lastState, state);
  assert.equal(context.lastStateEtag, 'explicit');
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
  vm.runInContext(['formatUpdateSucceededAt', 'updateCheckFailureMessage', 'checkForUpdate']
    .map(name => functionSource(html, name)).join('\n'), context);
  return { context, get, posted, applied };
}

const jsonResponse = (status, body) => ({ status, ok: status >= 200 && status < 300, json: async () => body });
const updateFailureText = '確認できませんでした。時間をおいてやり直してください。';

function localUpdateTime(succeededAt) {
  const date = new Date(succeededAt);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

test('更新を確認は、最新なら何も出さず、それ以外は結果を一行で出し、新しいバージョンでは通知欄も更新する', async () => {
  const latest = { ...update, current: '0.0.0', checkedAt: 'x', error: null };
  const cases = [
    { body: { current: '1.0.1', latest: '1.0.1', available: false, checkedAt: 'x', error: null }, status: 200,
      message: '', applied: [] },
    { body: latest, status: 200, message: '新しいバージョン v1.0.0 があります。', applied: [latest] },
    { body: { current: '1.0.1', latest: null, available: false, checkedAt: 'x', error: 'TIMEOUT' }, status: 200,
      message: updateFailureText, applied: [] },
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

test('更新を確認が失敗しても、既知の更新通知を保ち最後の成功時刻を表示する', async () => {
  const succeededAt = '2026-10-15T02:03:00.000Z';
  const failedUpdate = { ...update, succeededAt, error: 'TIMEOUT' };
  const { context, get, applied } = updateCheckContext(async () => jsonResponse(200, failedUpdate));
  await context.checkForUpdate();
  assert.equal(get('update-check-status').textContent,
    `${updateFailureText} 最後に確認できたのは ${localUpdateTime(succeededAt)} です。`);
  assert.deepEqual(applied, [failedUpdate]);
});

test('更新を確認は、通信に失敗したら確認できなかった文言を出す', async () => {
  const { context, get } = updateCheckContext(async () => { throw new Error('offline'); });
  await context.checkForUpdate();
  assert.equal(get('update-check-status').textContent, '確認できませんでした。時間をおいてやり直してください。');
  assert.equal(get('update-check').disabled, false);
});

function settingsClickContext(source, update) {
  const nodes = new Map();
  const get = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: '' });
    return nodes.get(id);
  };
  let onClick;
  const context = vm.createContext({
    settingsButton: { addEventListener(type, callback) { assert.equal(type, 'click'); onClick = callback; } },
    settingsDialog: { showModal() { this.opened = true; } },
    settingsSaveError: get('settings-save-error'),
    updateCheckStatus: get('update-check-status'),
    lastState: { update },
    DATA: { update },
    writeErrorUntil: 0,
    writeErrorMessage: '',
  });
  const handler = source.match(/settingsButton\.addEventListener\('click', \(\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(handler);
  const functions = ['formatUpdateSucceededAt', 'updateCheckFailureMessage']
    .map(name => functionSource(source, name)).join('\n');
  vm.runInContext(`${functions}\n${handler}`, context);
  return { context, get, open: () => onClick() };
}

test('設定を開くと最後の確認が失敗していた場合だけ失敗と成功時刻を表示する', () => {
  const succeededAt = '2026-10-15T02:03:00.000Z';
  const { context, get, open } = settingsClickContext(html, { error: 'TIMEOUT', succeededAt });
  open();
  assert.equal(context.settingsDialog.opened, true);
  assert.equal(get('update-check-status').textContent,
    `更新を確認できていません。 最後に確認できたのは ${localUpdateTime(succeededAt)} です。`);
  context.lastState.update = { error: 'TIMEOUT' };
  open();
  assert.equal(get('update-check-status').textContent, '更新を確認できていません。');
  context.lastState.update.error = null;
  open();
  assert.equal(get('update-check-status').textContent, '');
});

test('モックでも更新確認の失敗時にボタンの右へ状態と成功時刻を表示する', () => {
  const succeededAt = '2026-10-15T02:03:00.000Z';
  const update = { available: true, error: 'TIMEOUT', succeededAt };
  const { get, open } = settingsClickContext(mockHtml, update);
  open();
  assert.equal(get('update-check-status').textContent,
    `更新を確認できていません。 最後に確認できたのは ${localUpdateTime(succeededAt)} です。`);

  let check;
  let finish;
  const updateCheckButton = {
    disabled: false,
    textContent: '',
    addEventListener(type, callback) { assert.equal(type, 'click'); check = callback; },
  };
  const context = vm.createContext({
    updateCheckButton,
    updateCheckStatus: get('update-check-status'),
    DATA: { update },
    setTimeout(callback) { finish = callback; },
  });
  const handler = mockHtml.match(/updateCheckButton\.addEventListener\('click', \(\) => \{[\s\S]*?\n\}\);/)?.[0];
  assert.ok(handler);
  const functions = ['formatUpdateSucceededAt', 'updateCheckFailureMessage']
    .map(name => functionSource(mockHtml, name)).join('\n');
  vm.runInContext(`${functions}\n${handler}`, context);
  check();
  assert.equal(updateCheckButton.disabled, true);
  finish();
  assert.equal(updateCheckButton.disabled, false);
  assert.equal(get('update-check-status').textContent,
    `${updateFailureText} 最後に確認できたのは ${localUpdateTime(succeededAt)} です。`);
  assert.match(mockHtml, /update: null,/);
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
