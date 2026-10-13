const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const zlib = require('node:zlib');
const { temporaryDirectory } = require('./support/temp');
const {
  validateShotDefinition,
  storageEntries,
  initializationScript,
  pngSize,
  decodePngPixels,
  isRenderingNoise,
  clipFromRect,
  partBounds,
  buildRectsJson,
  writeIfChanged,
  listDefinitionNames,
  runEachDefinition,
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
  assert.equal(definition.scale, 2);
  assert.equal(validateShotDefinition(validDefinition({ scale: 1 })).scale, 1);
  assert.equal(definition.theme, 'dark');
  assert.deepEqual(definition.integrations, {});

  for (const [root, expected] of [['manual', 'overview'], ['site', 'review']]) {
    const manualRoot = path.join(ROOT, root);
    const names = listDefinitionNames(manualRoot);
    assert.ok(names.includes(expected));
    for (const name of names) {
      const raw = JSON.parse(fs.readFileSync(path.join(manualRoot, 'shots', `${name}.json`), 'utf8'));
      assert.doesNotThrow(() => validateShotDefinition(raw, { label: name }), `${root}/${name}`);
    }
  }
});

test('不正な撮影の定義は撮影を始める前に拒否する', () => {
  const rejected = (definition, pattern) => assert.throws(() => validateShotDefinition(definition), pattern);
  rejected(null, /オブジェクトではありません/);
  rejected(validDefinition({ title: ' ' }), /title/);
  rejected(validDefinition({ scenario: 'missing' }), /scenario/);
  rejected(validDefinition({ extra: 1 }), /未知の項目/);
  rejected(validDefinition({ theme: 'blue' }), /theme/);
  rejected(validDefinition({ scale: 3 }), /scale/);
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

// PNG の仕様どおりの予測子。デコーダの実装とは別に書き、符号化の側から復号を検証する。
function predict(filter, left, up, upLeft) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return Math.floor((left + up) / 2);
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  return distanceUp <= distanceUpLeft ? up : upLeft;
}

// テスト用の PNG を zlib でその場で作る。filterAt(y) で行ごとのフィルタを選ぶ。デコーダは CRC を検査しないため、CRC は 0 にする。
function makePng({ width, height, colorType = 2, bitDepth = 8, pixel, filterAt = () => 0 }) {
  const channels = colorType === 6 ? 4 : 3;
  const stride = width * channels;
  const image = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const rgba = pixel(x, y);
      for (let channel = 0; channel < channels; channel += 1) image[(y * width + x) * channels + channel] = rgba[channel];
    }
  }
  const filtered = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y += 1) {
    const filter = filterAt(y);
    filtered[y * (stride + 1)] = filter;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? image[y * stride + i - channels] : 0;
      const up = y > 0 ? image[(y - 1) * stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? image[(y - 1) * stride + i - channels] : 0;
      filtered[y * (stride + 1) + 1 + i] = (image[y * stride + i] - predict(filter, left, up, upLeft)) & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = bitDepth;
  header[9] = colorType;
  const chunk = (type, data) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    return Buffer.concat([length, Buffer.from(type, 'latin1'), data, Buffer.alloc(4)]);
  };
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(filtered)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SHADE_WIDTH = 20;
const SHADE_HEIGHT = 5;

function baseColor(x, y) {
  return [(x * 37 + y * 11) & 255, (x * 5 + y * 29) & 255, (x * 17 + y * 3) & 255, 100];
}

// changes の [x, y, チャネル, 差] だけ基準の画素を変える。255 を超えて折り返さないように、200 を超える値は引く。
function shade({ width = SHADE_WIDTH, colorType = 2, filterAt, changes = [] } = {}) {
  return makePng({
    width,
    height: SHADE_HEIGHT,
    colorType,
    filterAt,
    pixel: (x, y) => {
      const rgba = baseColor(x, y);
      for (const [changeX, changeY, channel, delta] of changes) {
        if (changeX === x && changeY === y) rgba[channel] = rgba[channel] <= 200 ? rgba[channel] + delta : rgba[channel] - delta;
      }
      return rgba;
    },
  });
}

// 先頭から count 個の画素の赤チャネルを delta だけ変える。
function changedPixels(count, delta) {
  return Array.from({ length: count }, (_, index) => [index % SHADE_WIDTH, Math.floor(index / SHADE_WIDTH), 0, delta]);
}

test('PNG の画素は行ごとに違うフィルタで符号化されていても同じ値に復元する', () => {
  const plain = shade({ filterAt: () => 0 });
  const mixed = shade({ filterAt: (y) => y % 5 });
  const decoded = decodePngPixels(mixed);
  assert.equal(decoded.channels, 3);
  assert.deepEqual(decoded.data, decodePngPixels(plain).data);
  const offset = (1 * SHADE_WIDTH + 1) * 3;
  assert.deepEqual([...decoded.data.subarray(offset, offset + 3)], baseColor(1, 1).slice(0, 3));
  assert.equal(decodePngPixels(makePng({ width: 2, height: 1, bitDepth: 16, pixel: () => [0, 0, 0] })), null);
});

test('描画の揺れは、画素数とチャネルの差の両方の許容で判定し、大きさや形式が違うものは許さない', () => {
  const plain = shade({ filterAt: () => 0 });
  assert.equal(isRenderingNoise(plain, shade({ filterAt: (y) => y % 5 })), true);
  assert.equal(isRenderingNoise(plain, shade({ changes: [[3, 2, 0, 5]] })), true);
  assert.equal(isRenderingNoise(plain, shade({ changes: changedPixels(SHADE_WIDTH * SHADE_HEIGHT, 2) })), true);
  assert.equal(isRenderingNoise(plain, shade({ changes: changedPixels(33, 3) })), false);
  assert.equal(isRenderingNoise(plain, shade({ changes: changedPixels(1, 49) })), false);
  // 背景色を 1 だけ変えたような、画像全体に広がる淡い差は揺れとして扱わない。
  const wide = { width: 40, height: 26, filterAt: () => 0 };
  const tinted = (x, y) => baseColor(x, y).map((value, channel) => (channel === 0 ? value ^ 1 : value));
  assert.equal(isRenderingNoise(makePng({ ...wide, pixel: baseColor }), makePng({ ...wide, pixel: tinted })), false);
  assert.equal(isRenderingNoise(plain, shade({ width: SHADE_WIDTH - 1 })), false);
  assert.equal(isRenderingNoise(plain, shade({ colorType: 6 })), false);
  assert.equal(isRenderingNoise(plain, makePng({ width: SHADE_WIDTH, height: SHADE_HEIGHT, bitDepth: 16, pixel: baseColor })), false);

  const rgba = shade({ colorType: 6 });
  assert.equal(isRenderingNoise(rgba, shade({ colorType: 6, changes: [[0, 0, 3, 49]] })), false);
});

test('描画の揺れの範囲にある撮り直しは PNG を書き換えず、文字の変更などは書き換える', async (t) => {
  const file = path.join(temporaryDirectory(t, 'agent-cockpit-png-').directory, 'shot.png');
  const original = shade({ filterAt: () => 0 });
  assert.equal(await writeIfChanged(file, original, { isSameContent: isRenderingNoise }), true);
  assert.equal(await writeIfChanged(file, shade({ filterAt: (y) => y % 5, changes: [[3, 2, 0, 5]] }), { isSameContent: isRenderingNoise }), false);
  assert.ok(fs.readFileSync(file).equals(original));
  const changed = shade({ changes: changedPixels(33, 3) });
  assert.equal(await writeIfChanged(file, changed, { isSameContent: isRenderingNoise }), true);
  assert.ok(fs.readFileSync(file).equals(changed));
});

test('1 件の定義が失敗しても残りを撮り、失敗した定義名をまとめて報告する', async () => {
  const logs = [];
  const ran = [];
  const definitions = ['a', 'b', 'c', 'd'].map((name) => [name, { title: `定義 ${name}` }]);
  await assert.rejects(
    runEachDefinition(definitions, async (name) => {
      ran.push(name);
      if (name === 'b' || name === 'c') throw new Error(`${name} の失敗`);
    }, { log: (line) => logs.push(line) }),
    /撮影に失敗した定義: b, c$/,
  );
  assert.deepEqual(ran, ['a', 'b', 'c', 'd']);
  assert.ok(logs.includes('撮影: d(定義 d)'));
  assert.ok(logs.includes('失敗: b: b の失敗'));
  assert.ok(logs.includes('失敗: c: c の失敗'));
});

test('すべての定義が成功したら例外にしない', async () => {
  const ran = [];
  await runEachDefinition([['a', { title: 'A' }]], async (name) => { ran.push(name); }, { log() {} });
  assert.deepEqual(ran, ['a']);
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
