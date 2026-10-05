const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { temporaryDirectory } = require('./support/temp');
const {
  validateShotDefinition,
  storageEntries,
  initializationScript,
  pngSize,
  clipFromRect,
  partBounds,
  buildRectsJson,
  writeIfChanged,
  listDefinitionNames,
} = require('../tools/manual/capture');
const { findBrowser, parseDevToolsActivePort, CdpConnection } = require('../tools/manual/cdp');

const ROOT = path.resolve(__dirname, '..');

function validDefinition(overrides = {}) {
  return {
    title: '判断事項の回答欄',
    scenario: 'basic',
    steps: [
      { do: 'click', selector: '.decision-card' },
      { do: 'type', selector: 'textarea', text: '画面の幅は 850px で撮る' },
      { do: 'wait', selector: '.done', text: '送信済み', timeoutMs: 500 },
      { do: 'screenshot', name: 'answer', target: '.decision-card', parts: { 'decision.pick': '.pick', 'decision.bottom': ['.a', '.b'] } },
    ],
    ...overrides,
  };
}

test('撮影の定義は既定値を補い、リポジトリの定義がすべて検査を通る', () => {
  const definition = validateShotDefinition(validDefinition());
  assert.deepEqual(definition.window, { width: 850, height: 900 });
  assert.equal(definition.theme, 'dark');
  assert.deepEqual(definition.integrations, {});

  const manualRoot = path.join(ROOT, 'manual');
  const names = listDefinitionNames(manualRoot);
  assert.ok(names.includes('overview'));
  for (const name of names) {
    const raw = JSON.parse(fs.readFileSync(path.join(manualRoot, 'shots', `${name}.json`), 'utf8'));
    assert.doesNotThrow(() => validateShotDefinition(raw, { label: name }), name);
  }
});

test('不正な撮影の定義は撮影を始める前に拒否する', () => {
  const rejected = (definition, pattern) => assert.throws(() => validateShotDefinition(definition), pattern);
  rejected(null, /オブジェクトではありません/);
  rejected(validDefinition({ title: ' ' }), /title/);
  rejected(validDefinition({ scenario: 'missing' }), /scenario/);
  rejected(validDefinition({ extra: 1 }), /未知の項目/);
  rejected(validDefinition({ theme: 'blue' }), /theme/);
  rejected(validDefinition({ window: { width: 50 } }), /window\.width/);
  rejected(validDefinition({ window: { depth: 1 } }), /window は/);
  rejected(validDefinition({ integrations: { codexAgent: 'yes' } }), /integrations/);
  rejected(validDefinition({ steps: [] }), /steps が空/);
  rejected(validDefinition({ steps: [{ do: 'hover', selector: 'a' }] }), /do は/);
  rejected(validDefinition({ steps: [{ do: 'click', selector: '' }, { do: 'screenshot', name: 'a' }] }), /selector が空/);
  rejected(validDefinition({ steps: [{ do: 'click', selector: 'a', text: 'x' }] }), /未知の項目/);
  rejected(validDefinition({ steps: [{ do: 'type', selector: 'a' }] }), /text/);
  rejected(validDefinition({ steps: [{ do: 'wait', selector: 'a', timeoutMs: 5 }] }), /timeoutMs/);
  rejected(validDefinition({ steps: [{ do: 'wait', selector: 'a', text: ' ' }, { do: 'screenshot', name: 'a' }] }), /text が空/);
  rejected(validDefinition({ steps: [{ do: 'click', selector: 'a' }] }), /screenshot の手順がありません/);
  rejected(validDefinition({ steps: [{ do: 'screenshot', name: '../outside' }] }), /name/);
  rejected(validDefinition({ steps: [{ do: 'screenshot', name: 'a' }, { do: 'screenshot', name: 'a' }] }), /重複/);
  rejected(validDefinition({ steps: [{ do: 'screenshot', name: 'a', parts: { 'bad key': 'x' } }] }), /部品の鍵/);
  rejected(validDefinition({ steps: [{ do: 'screenshot', name: 'a', parts: { ok: [] } }] }), /selector が空/);
  rejected(validDefinition({ steps: [{ do: 'screenshot', name: 'a', viewport: 'yes' }] }), /viewport は/);
  rejected(validDefinition({ steps: [{ do: 'screenshot', name: 'a', target: [] }] }), /target が空/);
  rejected(validDefinition({ steps: [{ do: 'screenshot', name: 'a', target: ['.a', ''] }] }), /target が空/);
  assert.doesNotThrow(() => validateShotDefinition(validDefinition({ steps: [{ do: 'screenshot', name: 'a', target: ['.a', '.b'] }] })));
  rejected(validDefinition({ steps: [{ do: 'screenshot', name: 'a', viewport: true, target: '#root' }] }), /同時に指定できません/);
});

test('localStorage には theme と storage を書き、文字列以外は JSON にする', () => {
  const entries = storageEntries({ theme: 'light', storage: { 'agent-cockpit.display': { mode: 'kind' }, plain: 'text' } });
  assert.deepEqual(entries, {
    'agent-cockpit.theme': 'light',
    'agent-cockpit.display': '{"mode":"kind"}',
    plain: 'text',
  });
});

test('ページへ先に入れるスクリプトが、時計を固定し、既にある localStorage の値を残す', () => {
  const baseTime = Date.UTC(2026, 9, 6, 5, 30);
  const stored = new Map([['kept', 'old']]);
  const sheets = [];
  const context = {
    localStorage: { getItem: (key) => (stored.has(key) ? stored.get(key) : null), setItem: (key, value) => stored.set(key, value) },
    CSSStyleSheet: class { replaceSync(text) { this.text = text; } },
    document: { set adoptedStyleSheets(value) { sheets.push(...value); } },
    Date,
  };
  context.globalThis = context;
  vm.runInNewContext(initializationScript({ baseTime, entries: { kept: 'new', added: 'value' } }), context);

  assert.equal(context.Date.now(), baseTime);
  assert.equal(new context.Date().getTime(), baseTime);
  assert.equal(new context.Date(0).getTime(), 0);
  assert.equal(context.Date.parse('2026-10-06T05:30:00Z'), baseTime);
  assert.equal(stored.get('kept'), 'old');
  assert.equal(stored.get('added'), 'value');
  assert.match(sheets[0].text, /caret-color: transparent/);
});

test('DevToolsActivePort からブラウザの接続先を読む', () => {
  assert.deepEqual(parseDevToolsActivePort('9222\n/devtools/browser/abc-123\n'), {
    port: 9222, webSocketUrl: 'ws://127.0.0.1:9222/devtools/browser/abc-123',
  });
  assert.equal(parseDevToolsActivePort(''), null);
  assert.equal(parseDevToolsActivePort('0\n/devtools/browser/x'), null);
  assert.equal(parseDevToolsActivePort('9222\n/other'), null);
});

test('ブラウザは MANUAL_BROWSER を優先し、無ければ既定の場所の最初の存在するものを使う', () => {
  assert.equal(findBrowser({ environment: { MANUAL_BROWSER: '/custom/chrome' }, exists: () => true }), '/custom/chrome');
  assert.throws(() => findBrowser({ environment: { MANUAL_BROWSER: '/custom/chrome' }, exists: () => false }), /MANUAL_BROWSER/);
  const chrome = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
  assert.equal(findBrowser({ environment: {}, platform: 'win32', exists: (candidate) => candidate === chrome }), chrome);
  assert.throws(() => findBrowser({ environment: {}, platform: 'win32', exists: () => false }), /見つかりません/);
});

test('要素の矩形は撮影の範囲として外側へ丸め、部品の矩形は画像の画素に直す', () => {
  const clip = clipFromRect({ x: 10.4, y: 20.2, width: 100.3, height: 50.5 });
  assert.deepEqual(clip, { x: 10, y: 20, width: 101, height: 51 });

  assert.deepEqual(partBounds('a', { x: 20, y: 30, width: 10, height: 5 }, clip), {
    key: 'a', bounds: { x: 20, y: 20, width: 20, height: 10 }, visible: true,
  });
  assert.deepEqual(partBounds('cut', { x: 100, y: 60, width: 50, height: 50 }, clip).bounds, { x: 180, y: 80, width: 22, height: 22 });
  assert.deepEqual(partBounds('outside', { x: 500, y: 500, width: 10, height: 10 }, clip), {
    key: 'outside', bounds: { x: 0, y: 0, width: 0, height: 0 }, visible: false,
  });
  assert.equal(partBounds('empty', { x: 20, y: 30, width: 0, height: 0 }, clip).visible, false);
});

test('部品の矩形の JSON は、ガイドマップが読む width、height、parts を持つ', () => {
  const text = buildRectsJson({
    name: 'shot', target: '.card', image: { width: 100, height: 50 },
    parts: [{ key: 'k', bounds: { x: 1, y: 2, width: 3, height: 4 }, visible: true }],
  });
  assert.ok(text.endsWith('\n'));
  assert.deepEqual(JSON.parse(text), {
    name: 'shot', target: '.card', width: 100, height: 50, parts: [{ key: 'k', bounds: { x: 1, y: 2, width: 3, height: 4 }, visible: true }],
  });
});

test('画像の大きさは PNG のヘッダから読み、PNG でないものは拒否する', () => {
  const header = Buffer.alloc(24);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(header);
  header.writeUInt32BE(1700, 16);
  header.writeUInt32BE(300, 20);
  assert.deepEqual(pngSize(header), { width: 1700, height: 300 });
  assert.throws(() => pngSize(Buffer.from('not a png file at all......')), /PNG/);
});

test('中身が前と同じファイルは書き換えない', async (t) => {
  const directory = temporaryDirectory(t, 'agent-cockpit-write-').directory;
  const file = path.join(directory, 'nested', 'a.json');
  assert.equal(await writeIfChanged(file, '{"a":1}\n'), true);
  const before = fs.statSync(file).mtimeMs;
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(await writeIfChanged(file, '{"a":1}\n'), false);
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.equal(await writeIfChanged(file, '{"a":2}\n'), true);
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}\n');
});

test('DevTools の接続は、応答を送信した命令に結び付け、失敗とイベントを区別する', async () => {
  const listeners = {};
  const sent = [];
  const socket = {
    addEventListener: (type, handler) => { listeners[type] = handler; },
    send: (text) => sent.push(JSON.parse(text)),
    close() {},
  };
  const connection = new CdpConnection(socket);
  const events = [];
  connection.on('Page.loadEventFired', (params, sessionId) => events.push([params, sessionId]));

  const ok = connection.send('Page.enable', {}, 'S1');
  const failing = connection.send('Page.navigate', { url: 'x' });
  assert.deepEqual(sent[0], { id: 1, method: 'Page.enable', params: {}, sessionId: 'S1' });
  listeners.message({ data: JSON.stringify({ id: 1, result: { done: true } }) });
  listeners.message({ data: JSON.stringify({ id: 2, error: { message: 'bad url' } }) });
  listeners.message({ data: JSON.stringify({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'S1' }) });
  listeners.message({ data: 'not json' });

  assert.deepEqual(await ok, { done: true });
  await assert.rejects(failing, /Page\.navigate が失敗しました: bad url/);
  assert.deepEqual(events, [[{ timestamp: 1 }, 'S1']]);

  const pending = connection.send('Page.reload');
  listeners.close();
  await assert.rejects(pending, /接続が切れました/);
});
