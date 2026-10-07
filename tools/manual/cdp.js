'use strict';

const { spawn, execFile } = require('node:child_process');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { removeDirectory } = require('./fs-utils');

const DEFAULT_BROWSER_PATHS = Object.freeze({
  win32: [
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  ],
  darwin: [
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ],
  linux: [
    '/usr/bin/microsoft-edge',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ],
});

const LAUNCH_TIMEOUT_MS = 30_000;
const COMMAND_TIMEOUT_MS = 30_000;

// MANUAL_BROWSER を優先し、無ければ Edge と Chrome の既定の場所を順に探す。
function findBrowser({ environment = process.env, platform = process.platform, exists = fs.existsSync } = {}) {
  const specified = environment.MANUAL_BROWSER;
  if (specified) {
    if (!exists(specified)) throw new Error(`MANUAL_BROWSER が指すブラウザがありません: ${specified}`);
    return specified;
  }
  const found = (DEFAULT_BROWSER_PATHS[platform] || []).find((candidate) => exists(candidate));
  if (!found) throw new Error('Edge か Chrome が見つかりません。MANUAL_BROWSER にブラウザの実行ファイルを指定してください');
  return found;
}

// DevToolsActivePort は 1 行目がポート、2 行目がブラウザの WebSocket のパスである。
function parseDevToolsActivePort(text) {
  const lines = String(text).split(/\r?\n/);
  const port = Number(lines[0]);
  const webSocketPath = lines[1];
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !webSocketPath?.startsWith('/devtools/browser/')) return null;
  return { port, webSocketUrl: `ws://127.0.0.1:${port}${webSocketPath}` };
}

class CdpConnection {
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => this.receive(event.data));
    socket.addEventListener('close', () => this.rejectAll(new Error('ブラウザとの接続が切れました')));
    socket.addEventListener('error', () => this.rejectAll(new Error('ブラウザとの接続でエラーが起きました')));
  }

  static connect(webSocketUrl) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(webSocketUrl);
      socket.addEventListener('open', () => resolve(new CdpConnection(socket)), { once: true });
      socket.addEventListener('error', () => reject(new Error('ブラウザの DevTools に接続できません')), { once: true });
    });
  }

  receive(data) {
    let message;
    try {
      message = JSON.parse(typeof data === 'string' ? data : Buffer.from(data).toString('utf8'));
    } catch {
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(`${pending.method} が失敗しました: ${message.error.message}`));
      else pending.resolve(message.result || {});
      return;
    }
    for (const handler of this.listeners.get(message.method) || []) handler(message.params || {}, message.sessionId);
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} の応答がありません`));
      }, COMMAND_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, method });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  on(method, handler) {
    const handlers = this.listeners.get(method) || [];
    handlers.push(handler);
    this.listeners.set(method, handlers);
  }

  close() {
    try {
      this.socket.close();
    } catch {}
  }
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function killProcessTree(child) {
  return new Promise((resolve) => {
    if (!child.pid || child.exitCode !== null) {
      resolve();
      return;
    }
    if (process.platform === 'win32') {
      execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    } else {
      try {
        process.kill(child.pid, 'SIGKILL');
      } catch {}
      resolve();
    }
  });
}

/**
 * ブラウザをヘッドレスで起動して DevTools につなぐ。
 * 普段のプロファイルの localStorage と拡張機能が画面に混ざらないよう、一時のユーザーデータを使う。
 */
async function launchBrowser({ browserPath, temporaryParent = os.tmpdir() }) {
  const userDataDirectory = await fsp.mkdtemp(path.join(temporaryParent, 'agent-cockpit-manual-browser-'));
  const child = spawn(browserPath, [
    '--headless=new',
    '--remote-debugging-port=0',
    `--user-data-dir=${userDataDirectory}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--disable-sync',
    '--disable-background-networking',
    '--hide-scrollbars',
    '--force-color-profile=srgb',
    'about:blank',
  ], { stdio: 'ignore', windowsHide: true });
  let spawnError = null;
  child.once('error', (error) => { spawnError = error; });

  async function dispose() {
    await killProcessTree(child);
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once('exit', resolve);
      setTimeout(resolve, 5_000).unref();
    });
    await removeDirectory(userDataDirectory, { maxRetries: 20, retryDelay: 200 });
  }

  try {
    // 同じプロセスで固定した Date が動くので、待ち時間は Date に頼らず performance.now() で測る。
    const deadline = performance.now() + LAUNCH_TIMEOUT_MS;
    let endpoint = null;
    while (!endpoint) {
      if (spawnError) throw new Error(`ブラウザを起動できません: ${spawnError.message}`);
      // Edge は起動したプロセスが本体を別のプロセスで立てて終了コード 0 で抜けることがあるため、0 なら待ち受けを待ち続ける。
      if (child.exitCode !== null && child.exitCode !== 0) throw new Error(`ブラウザが起動直後に終了しました(終了コード ${child.exitCode})`);
      if (performance.now() > deadline) throw new Error('ブラウザの DevTools の待ち受けを確認できません');
      try {
        endpoint = parseDevToolsActivePort(await fsp.readFile(path.join(userDataDirectory, 'DevToolsActivePort'), 'utf8'));
      } catch {}
      if (!endpoint) await sleep(100);
    }
    const connection = await CdpConnection.connect(endpoint.webSocketUrl);
    return {
      connection,
      async close() {
        try {
          await connection.send('Browser.close').catch(() => {});
        } finally {
          connection.close();
          await dispose();
        }
      },
    };
  } catch (error) {
    await dispose().catch(() => {});
    throw error;
  }
}

module.exports = { findBrowser, parseDevToolsActivePort, CdpConnection, launchBrowser, sleep };
