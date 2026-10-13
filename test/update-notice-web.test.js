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
  assert.equal(get('update-message').textContent, '新しい版 v1.0.0 があります(今は v0.0.0)。');
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

test('refresh は状態の version が同じでも新しい通知を描き直す', async () => {
  const notices = [];
  const state = { version: 1, sessions: [], away: {}, update, pullRequests: [] };
  const context = vm.createContext({
    fetchUi: async () => ({ ok: true, json: async () => state }), checkUiVersion: () => false,
    syncDisplayPreferences: async () => {}, updateConnectionNote() {}, header: { dataset: {} },
    applyAwayState() {}, applyUpdateState: value => notices.push(value), refreshConfirmPending: false,
    sinceSeenMode: 'off', pullRequestExpirySignature: () => '', renderedPullRequestExpirySignature: '',
    lastVersion: 1, liveStatus: {}, render: () => assert.fail('状態全体は描き直さない'),
  });
  vm.runInContext(functionSource(html, 'refresh'), context);
  await context.refresh();
  assert.deepEqual(notices, [update]);
});
