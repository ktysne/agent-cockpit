'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const zlib = require('node:zlib');
const { findBrowser, launchBrowser, sleep } = require('./cdp');
const { startDemoServer } = require('./demo-server');
const { scenarioNames } = require('./demo');
const { isRecord } = require('./value-utils');

const REPOSITORY_ROOT = path.join(__dirname, '..', '..');
const MANUAL_ROOT = path.join(REPOSITORY_ROOT, 'manual');
const DEVICE_SCALE = 2;
const SCALES = new Set([1, 2]);
const DEFAULT_WIDTH = 850;
const DEFAULT_HEIGHT = 900;
const DEFAULT_WAIT_MS = 10_000;
const DISPLAY_STORAGE_KEY = 'agent-cockpit.display';
const FIRST_RENDER_WAIT_MS = 20_000;
const THEMES = new Set(['dark', 'light']);
const PART_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const SHOT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const STEP_FIELDS = Object.freeze({
  click: ['do', 'selector'],
  type: ['do', 'selector', 'text'],
  wait: ['do', 'selector', 'text', 'gone', 'timeoutMs'],
  screenshot: ['do', 'name', 'target', 'viewport', 'parts'],
});

const nonEmptyString = (value) => typeof value === 'string' && value.trim().length > 0;

/**
 * 撮影の定義(manual/shots/<定義名>.json)を検査して、既定値を補った形で返す。
 * 検査に通らない定義は撮影を始める前に止める。
 */
function validateShotDefinition(definition, { label = '撮影の定義', scenarios = scenarioNames() } = {}) {
  const fail = (message) => { throw new Error(`${label}: ${message}`); };
  if (!isRecord(definition)) fail('JSON のオブジェクトではありません');
  const known = new Set(['title', 'scenario', 'window', 'scale', 'theme', 'integrations', 'storage', 'steps']);
  for (const key of Object.keys(definition)) if (!known.has(key)) fail(`未知の項目です: ${key}`);
  if (!nonEmptyString(definition.title)) fail('title が空です');
  if (!scenarios.includes(definition.scenario)) fail(`scenario がありません: ${definition.scenario}`);

  const window = definition.window ?? {};
  if (!isRecord(window) || Object.keys(window).some((key) => !['width', 'height'].includes(key))) fail('window は width と height だけを持つオブジェクトにしてください');
  const width = window.width ?? DEFAULT_WIDTH;
  const height = window.height ?? DEFAULT_HEIGHT;
  for (const [name, value] of [['width', width], ['height', height]]) {
    if (!Number.isInteger(value) || value < 200 || value > 4000) fail(`window.${name} は 200〜4000 の整数で指定してください`);
  }

  const scale = definition.scale ?? DEVICE_SCALE;
  if (!SCALES.has(scale)) fail('scale は 1 か 2 にしてください');

  const theme = definition.theme ?? 'dark';
  if (!THEMES.has(theme)) fail('theme は dark か light にしてください');

  const integrations = definition.integrations ?? {};
  if (!isRecord(integrations) || Object.entries(integrations).some(([key, value]) => !['codexAgent', 'crossReview'].includes(key) || typeof value !== 'boolean')) {
    fail('integrations は codexAgent と crossReview の真偽値だけを持つオブジェクトにしてください');
  }

  const storage = definition.storage ?? {};
  if (!isRecord(storage) || Object.keys(storage).some((key) => !nonEmptyString(key))) fail('storage は localStorage の鍵と値のオブジェクトにしてください');

  if (!Array.isArray(definition.steps) || definition.steps.length === 0) fail('steps が空です');
  const names = new Set();
  const steps = definition.steps.map((step, index) => {
    const where = `steps[${index}]`;
    if (!isRecord(step) || !Object.hasOwn(STEP_FIELDS, step.do)) fail(`${where}: do は click、type、wait、screenshot のどれかにしてください`);
    for (const key of Object.keys(step)) if (!STEP_FIELDS[step.do].includes(key)) fail(`${where}: ${step.do} に未知の項目があります: ${key}`);
    if (step.do !== 'screenshot' && !nonEmptyString(step.selector)) fail(`${where}: selector が空です`);
    if (step.do === 'type' && typeof step.text !== 'string') fail(`${where}: text が文字列ではありません`);
    if (step.do === 'wait') {
      if (step.text !== undefined && !nonEmptyString(step.text)) fail(`${where}: text が空です`);
      if (step.gone !== undefined && typeof step.gone !== 'boolean') fail(`${where}: gone は真偽値にしてください`);
      if (step.timeoutMs !== undefined && (!Number.isInteger(step.timeoutMs) || step.timeoutMs < 100 || step.timeoutMs > 60_000)) fail(`${where}: timeoutMs は 100〜60000 の整数にしてください`);
    }
    if (step.do === 'screenshot') {
      if (typeof step.name !== 'string' || !SHOT_NAME.test(step.name) || step.name.includes('..')) fail(`${where}: name がファイル名として使えません: ${step.name}`);
      if (names.has(step.name)) fail(`${where}: name が重複しています: ${step.name}`);
      names.add(step.name);
      if (step.target !== undefined && !(nonEmptyString(step.target) || (Array.isArray(step.target) && step.target.length > 0 && step.target.every(nonEmptyString)))) fail(`${where}: target が空です`);
      if (step.viewport !== undefined && typeof step.viewport !== 'boolean') fail(`${where}: viewport は true か false にしてください`);
      if (step.viewport && step.target !== undefined) fail(`${where}: viewport と target は同時に指定できません`);
      if (step.parts !== undefined) {
        if (!isRecord(step.parts)) fail(`${where}: parts は部品の鍵と selector のオブジェクトにしてください`);
        for (const [key, selector] of Object.entries(step.parts)) {
          if (!PART_KEY.test(key)) fail(`${where}: 部品の鍵が不正です: ${key}`);
          const selectors = Array.isArray(selector) ? selector : [selector];
          if (!selectors.length || !selectors.every(nonEmptyString)) fail(`${where}: 部品 ${key} の selector が空です`);
        }
      }
    }
    return step;
  });
  if (!names.size) fail('screenshot の手順がありません');

  return {
    title: definition.title,
    scenario: definition.scenario,
    window: { width, height },
    scale,
    theme,
    integrations,
    storage,
    steps,
  };
}

// localStorage には文字列しか入らない。文字列はそのまま、それ以外は JSON にして書く。
// 取り込みの確認は一度だけ出る全面のダイアログで撮影の画面を覆うので、表示設定は確認済みとして始める。
function storageEntries(definition) {
  const entries = { 'agent-cockpit.theme': definition.theme };
  for (const [key, value] of Object.entries(definition.storage)) entries[key] = typeof value === 'string' ? value : JSON.stringify(value);
  const display = entries[DISPLAY_STORAGE_KEY] === undefined ? {} : JSON.parse(entries[DISPLAY_STORAGE_KEY]);
  entries[DISPLAY_STORAGE_KEY] = JSON.stringify({ importAppTasksAsked: true, ...display });
  return entries;
}

// ページのスクリプトより先に動かす。時計の固定、localStorage の事前設定、キャレットの点滅の抑止を行う。
function initializationScript({ baseTime, entries }) {
  return `(() => {
  const RealDate = Date;
  const fixed = ${JSON.stringify(baseTime)};
  class FakeDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(fixed);
      else super(...args);
    }
    static now() { return fixed; }
  }
  globalThis.Date = FakeDate;
  try {
    for (const [key, value] of Object.entries(${JSON.stringify(entries)})) {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, value);
    }
  } catch {}
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync('* { caret-color: transparent !important; }');
    document.adoptedStyleSheets = [sheet];
  } catch {}
})();`;
}

function pngSize(buffer) {
  const signature = '89504e470d0a1a0a';
  if (buffer.length < 24 || buffer.subarray(0, 8).toString('hex') !== signature) throw new Error('PNG として読めない画像です');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

// 描画の揺れを吸収するための許容で、文字や色の変更はこれを超える(docs/design/manual.md「撮影の実行」)。
// 差が FAINT 以下の画素はグラデーションの揺れとして MAX_FAINT_PIXELS 個まで、それを超える画素は縁のにじみとして MAX_PIXELS 個まで許す。
const RENDERING_NOISE_FAINT_DIFFERENCE = 2;
const RENDERING_NOISE_MAX_FAINT_PIXELS = 1000;
const RENDERING_NOISE_MAX_PIXELS = 32;
const RENDERING_NOISE_MAX_CHANNEL_DIFFERENCE = 48;
const PNG_SIGNATURE = '89504e470d0a1a0a';
const PNG_CHANNELS_BY_COLOR_TYPE = new Map([[2, 3], [6, 4]]);

function pngPredictor(filter, left, up, upLeft) {
  if (filter === 0) return 0;
  if (filter === 1) return left;
  if (filter === 2) return up;
  if (filter === 3) return (left + up) >> 1;
  const estimate = left + up - upLeft;
  const distanceLeft = Math.abs(estimate - left);
  const distanceUp = Math.abs(estimate - up);
  const distanceUpLeft = Math.abs(estimate - upLeft);
  if (distanceLeft <= distanceUp && distanceLeft <= distanceUpLeft) return left;
  return distanceUp <= distanceUpLeft ? up : upLeft;
}

// 8 ビットの RGB と RGBA で、インターレースでない PNG だけ画素を取り出す。それ以外は null を返す。
function decodePngPixels(buffer) {
  if (buffer.length < 8 || buffer.subarray(0, 8).toString('hex') !== PNG_SIGNATURE) return null;
  let header = null;
  const dataChunks = [];
  for (let offset = 8; offset + 8 <= buffer.length;) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    const data = buffer.subarray(offset + 8, offset + 8 + length);
    if (data.length !== length) return null;
    if (type === 'IHDR') header = data;
    else if (type === 'IDAT') dataChunks.push(data);
    else if (type === 'IEND') break;
    offset += 12 + length;
  }
  if (!header || header.length < 13) return null;
  const width = header.readUInt32BE(0);
  const height = header.readUInt32BE(4);
  const channels = PNG_CHANNELS_BY_COLOR_TYPE.get(header[9]);
  if (!width || !height || header[8] !== 8 || header[12] !== 0 || !channels) return null;

  const stride = width * channels;
  let raw;
  try {
    raw = zlib.inflateSync(Buffer.concat(dataChunks));
  } catch {
    return null;
  }
  if (raw.length !== height * (stride + 1)) return null;

  const data = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)];
    if (filter > 4) return null;
    const source = y * (stride + 1) + 1;
    const row = y * stride;
    for (let i = 0; i < stride; i += 1) {
      const left = i >= channels ? data[row + i - channels] : 0;
      const up = y > 0 ? data[row - stride + i] : 0;
      const upLeft = y > 0 && i >= channels ? data[row - stride + i - channels] : 0;
      data[row + i] = (raw[source + i] + pngPredictor(filter, left, up, upLeft)) & 0xff;
    }
  }
  return { width, height, channels, data };
}

// 描画の揺れとして許す差かを返す。大きさ、チャネル数、比べられない形式は許さない(false)。
function isRenderingNoise(existingPng, nextPng) {
  const existing = decodePngPixels(existingPng);
  const next = decodePngPixels(nextPng);
  if (!existing || !next) return false;
  if (existing.width !== next.width || existing.height !== next.height || existing.channels !== next.channels) return false;
  const { channels } = existing;
  let faintPixels = 0;
  let differentPixels = 0;
  for (let offset = 0; offset < existing.data.length; offset += channels) {
    let largest = 0;
    for (let channel = 0; channel < channels; channel += 1) {
      largest = Math.max(largest, Math.abs(existing.data[offset + channel] - next.data[offset + channel]));
    }
    if (largest > RENDERING_NOISE_MAX_CHANNEL_DIFFERENCE) return false;
    if (largest > RENDERING_NOISE_FAINT_DIFFERENCE) differentPixels += 1;
    else if (largest) faintPixels += 1;
  }
  return differentPixels <= RENDERING_NOISE_MAX_PIXELS && faintPixels <= RENDERING_NOISE_MAX_FAINT_PIXELS;
}

// 要素の矩形を取り込み範囲の外側へ整数に丸めて広げる。画像の画素と矩形がずれないようにするため。
function clipFromRect(rect) {
  const x = Math.floor(rect.x);
  const y = Math.floor(rect.y);
  return { x, y, width: Math.ceil(rect.x + rect.width) - x, height: Math.ceil(rect.y + rect.height) - y };
}

// 部品の矩形を、画像の左上を原点とする画素の座標にする。取り込み範囲に交わらない部品は visible を false にする。
function partBounds(key, rect, clip, scale = DEVICE_SCALE) {
  const left = Math.max(rect.x, clip.x);
  const top = Math.max(rect.y, clip.y);
  const right = Math.min(rect.x + rect.width, clip.x + clip.width);
  const bottom = Math.min(rect.y + rect.height, clip.y + clip.height);
  const visible = right > left && bottom > top && rect.width > 0 && rect.height > 0;
  const bounds = visible
    ? { x: Math.round((left - clip.x) * scale), y: Math.round((top - clip.y) * scale), width: Math.round((right - left) * scale), height: Math.round((bottom - top) * scale) }
    : { x: 0, y: 0, width: 0, height: 0 };
  return { key, bounds, visible };
}

function buildRectsJson({ name, target, image, parts }) {
  return `${JSON.stringify({ name, target: target ?? null, width: image.width, height: image.height, parts }, null, 2)}\n`;
}

// 中身が前と同じファイル、または isSameContent が真を返すファイルは書き換えない。書いたかどうかを返す。
async function writeIfChanged(filePath, content, { isSameContent = () => false } = {}) {
  const buffer = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  let existing = null;
  try {
    existing = await fsp.readFile(filePath);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (existing && (existing.equals(buffer) || isSameContent(existing, buffer))) return false;
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, buffer);
  return true;
}

class PageSession {
  constructor(connection, sessionId) {
    this.connection = connection;
    this.sessionId = sessionId;
  }

  send(method, params) {
    return this.connection.send(method, params, this.sessionId);
  }

  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(String(description).split('\n')[0].replace(/^\w*Error: /, ''));
    }
    return result.result.value;
  }

  async waitUntil(expression, description, timeoutMs = DEFAULT_WAIT_MS) {
    const deadline = performance.now() + timeoutMs;
    while (performance.now() < deadline) {
      if (await this.evaluate(expression)) return;
      await sleep(50);
    }
    throw new Error(`${description}を待ちましたが、${timeoutMs}ms 以内に満たされませんでした`);
  }
}

const frames = '(async () => { await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true; })()';

function selectorLookup(selector) {
  return `(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) throw new Error('selector に一致する要素がありません: ' + ${JSON.stringify(selector)});
    return element;
  })()`;
}

async function runStep(page, step, context) {
  if (step.do === 'click') {
    await page.evaluate(`(() => { const element = ${selectorLookup(step.selector)}; element.scrollIntoView({ block: 'center' }); element.click(); return true; })()`);
    await page.evaluate(frames);
  } else if (step.do === 'type') {
    await page.evaluate(`(() => { const element = ${selectorLookup(step.selector)}; element.focus(); return document.activeElement === element; })()`);
    await page.send('Input.insertText', { text: step.text });
    await page.evaluate(frames);
  } else if (step.do === 'wait') {
    const expression = `(() => { const text = ${JSON.stringify(step.text ?? '')}; const found = [...document.querySelectorAll(${JSON.stringify(step.selector)})].some((element) => element.textContent.includes(text)); return ${step.gone ? '!found' : 'found'}; })()`;
    await page.waitUntil(expression, `${step.selector} が${step.gone ? '消える' : '現れる'}のを`, step.timeoutMs);
  } else {
    await takeScreenshot(page, step, context);
  }
}

async function fitViewportToContent(page, width, minimumHeight, scale) {
  let height = minimumHeight;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: scale, mobile: false });
    await page.evaluate(frames);
    const content = await page.evaluate('Math.ceil(Math.max(document.documentElement.scrollHeight, document.body.scrollHeight))');
    const next = Math.max(minimumHeight, content);
    if (next === height) return height;
    height = next;
  }
  return height;
}

async function takeScreenshot(page, step, context) {
  const { definition, outputDirectory, written } = context;
  await page.evaluate(`(() => { window.scrollTo(0, 0); if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur(); return true; })()`);
  // viewport は利用者が最初に目にするウィンドウの範囲だけを撮る。全体図が縦に伸びすぎないためである。
  const height = step.viewport
    ? await page.send('Emulation.setDeviceMetricsOverride', { width: definition.window.width, height: definition.window.height, deviceScaleFactor: definition.scale, mobile: false })
      .then(() => page.evaluate(frames)).then(() => definition.window.height)
    : await fitViewportToContent(page, definition.window.width, definition.window.height, definition.scale);
  const rectOf = (selector) => page.evaluate(`(() => {
    const rect = ${selectorLookup(selector)}.getBoundingClientRect();
    return { x: rect.x + window.scrollX, y: rect.y + window.scrollY, width: rect.width, height: rect.height };
  })()`);
  // 配列の selector は、隠れていない要素の矩形をすべて囲む 1 つの矩形にする。
  const unionRectOf = async (selectors) => {
    const rects = (await Promise.all(selectors.map(rectOf))).filter((rect) => rect.width > 0 && rect.height > 0);
    if (!rects.length) return { x: 0, y: 0, width: 0, height: 0 };
    const left = Math.min(...rects.map((rect) => rect.x));
    const top = Math.min(...rects.map((rect) => rect.y));
    const right = Math.max(...rects.map((rect) => rect.x + rect.width));
    const bottom = Math.max(...rects.map((rect) => rect.y + rect.height));
    return { x: left, y: top, width: right - left, height: bottom - top };
  };
  const clip = step.target ? clipFromRect(await unionRectOf([step.target].flat())) : { x: 0, y: 0, width: definition.window.width, height };
  const parts = [];
  for (const [key, selector] of Object.entries(step.parts || {})) parts.push(partBounds(key, await unionRectOf([selector].flat()), clip, definition.scale));
  const { data } = await page.send('Page.captureScreenshot', { format: 'png', clip: { ...clip, scale: 1 }, captureBeyondViewport: false });
  const png = Buffer.from(data, 'base64');
  const image = pngSize(png);
  if (image.width !== clip.width * definition.scale || image.height !== clip.height * definition.scale) {
    throw new Error(`撮った画像の大きさが想定と違います: ${image.width}x${image.height}(想定 ${clip.width * definition.scale}x${clip.height * definition.scale})`);
  }
  const base = path.join(outputDirectory, step.name);
  const pngChanged = await writeIfChanged(`${base}.png`, png, { isSameContent: isRenderingNoise });
  const jsonChanged = await writeIfChanged(`${base}.json`, buildRectsJson({ name: step.name, target: step.target, image, parts }));
  written.push({ file: `${base}.png`, changed: pngChanged }, { file: `${base}.json`, changed: jsonChanged });
}

async function captureDefinition(browser, definitionName, definition, { manualRoot, log }) {
  const demo = await startDemoServer({ scenario: definition.scenario, integrations: definition.integrations });
  const written = [];
  let browserContextId = null;
  let targetId = null;
  try {
    const { connection } = browser;
    ({ browserContextId } = await connection.send('Target.createBrowserContext'));
    ({ targetId } = await connection.send('Target.createTarget', { url: 'about:blank', browserContextId }));
    const { sessionId } = await connection.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new PageSession(connection, sessionId);

    await page.send('Page.enable');
    await page.send('Emulation.setDeviceMetricsOverride', {
      width: definition.window.width, height: definition.window.height, deviceScaleFactor: definition.scale, mobile: false,
    });
    await page.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
    await page.send('Emulation.setTimezoneOverride', { timezoneId: 'Asia/Tokyo' });
    await page.send('Emulation.setLocaleOverride', { locale: 'ja-JP' });
    await page.send('Page.addScriptToEvaluateOnNewDocument', {
      source: initializationScript({ baseTime: demo.baseTime, entries: storageEntries(definition) }),
    });
    await page.send('Page.navigate', { url: demo.url });
    await page.waitUntil('document.readyState === "complete"', 'ページの読み込み完了', FIRST_RENDER_WAIT_MS);
    // 最初の GET /api/state を描き終えると、画面が状態の更新を知らせる文を出す。
    await page.waitUntil(
      `(document.getElementById('live-status')?.textContent || '').startsWith('状態を更新しました')`,
      'ダッシュボードの最初の描画',
      FIRST_RENDER_WAIT_MS,
    );
    await page.evaluate('document.fonts.ready.then(() => true)');

    const context = { definition, outputDirectory: path.join(manualRoot, 'img', definitionName), written };
    for (const [index, step] of definition.steps.entries()) {
      try {
        await runStep(page, step, context);
        demo.assertHealthy();
      } catch (error) {
        throw new Error(`${definitionName} の steps[${index}](${step.do}): ${error.message}`);
      }
    }
    for (const { file, changed } of written) log(`${changed ? '書き込み' : '変更なし'}: ${path.relative(manualRoot, file).replaceAll('\\', '/')}`);
    return written;
  } finally {
    if (targetId) await browser.connection.send('Target.closeTarget', { targetId }).catch(() => {});
    if (browserContextId) await browser.connection.send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
    await demo.close();
  }
}

function listDefinitionNames(manualRoot) {
  const directory = path.join(manualRoot, 'shots');
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory).filter((file) => file.endsWith('.json')).map((file) => path.basename(file, '.json')).sort();
}

function loadDefinition(manualRoot, definitionName) {
  const filePath = path.join(manualRoot, 'shots', `${definitionName}.json`);
  const label = path.relative(REPOSITORY_ROOT, filePath).replaceAll('\\', '/');
  if (!fs.existsSync(filePath)) throw new Error(`撮影の定義がありません: ${label}`);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} を JSON として読めません: ${error.message}`);
  }
  return validateShotDefinition(raw, { label });
}

// 1 件の定義が失敗しても残りを撮り続ける。失敗は都度ログに出し、最後に失敗した定義名をまとめて例外にする。
async function runEachDefinition(definitions, runDefinition, { log = console.log } = {}) {
  const failed = [];
  for (const [name, definition] of definitions) {
    log(`撮影: ${name}(${definition.title})`);
    try {
      await runDefinition(name, definition);
    } catch (error) {
      failed.push(name);
      log(`失敗: ${name}: ${error.message}`);
    }
  }
  if (failed.length) throw new Error(`撮影に失敗した定義: ${failed.join(', ')}`);
}

async function capture(names, { manualRoot = MANUAL_ROOT, log = console.log } = {}) {
  const targets = names.length ? names : listDefinitionNames(manualRoot);
  if (!targets.length) throw new Error('撮影の定義がありません');
  // ブラウザを起動する前に、すべての定義を検査する。
  const definitions = targets.map((name) => [name, loadDefinition(manualRoot, name)]);
  const browser = await launchBrowser({ browserPath: findBrowser() });
  try {
    await runEachDefinition(
      definitions,
      (name, definition) => captureDefinition(browser, name, definition, { manualRoot, log }),
      { log },
    );
  } finally {
    await browser.close();
  }
}

// --root <ディレクトリ> で、撮影の定義(<ディレクトリ>/shots)と画像の置き場(<ディレクトリ>/img)を切り替える。配布ページの画像は site を指定して撮る。
function parseCaptureArguments(argv) {
  const names = [];
  let manualRoot = MANUAL_ROOT;
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--root') {
      const value = argv[++index];
      if (!value) throw new Error('--root にはディレクトリを指定してください');
      manualRoot = path.resolve(REPOSITORY_ROOT, value);
    } else if (argv[index].startsWith('-')) {
      throw new Error(`不明な引数です: ${argv[index]}`);
    } else {
      names.push(argv[index]);
    }
  }
  return { names, manualRoot };
}

if (require.main === module) {
  Promise.resolve().then(() => {
    const { names, manualRoot } = parseCaptureArguments(process.argv.slice(2));
    return capture(names, { manualRoot });
  }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = {
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
  capture,
};
