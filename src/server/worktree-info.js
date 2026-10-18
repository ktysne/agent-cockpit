'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { findWorktreeRootSync } = require('./git-worktree');

const REFRESH_INTERVAL_MS = 5000;
const TERMINAL_INTERVAL_MS = 1500;

class WorktreeInfo {
  constructor(options = {}) {
    this.execFile = options.execFile || execFile;
    this.spawn = options.spawn || spawn;
    this.platform = options.platform || process.platform;
    this.environment = options.environment || process.env;
    this.now = options.now || Date.now;
    this.onChange = options.onChange || (() => {});
    this.cache = new Map();
    this.locations = new Map();
    this.terminalRequests = new Map();
  }

  locate(cwd) {
    if (!cwd) return null;
    const previous = this.locations.get(cwd);
    if (previous && !fs.existsSync(path.join(previous, '.git'))) return { path: previous, missing: true };
    const found = findWorktreeRootSync(cwd);
    if (!found.root || !found.marker.isFile()) return null;
    this.locations.set(cwd, found.root);
    return { path: found.root, missing: false };
  }

  branchFromFile(root) {
    try {
      const marker = fs.readFileSync(path.join(root, '.git'), 'utf8').trim();
      if (!marker.startsWith('gitdir: ')) return null;
      const gitDirectory = path.resolve(root, marker.slice('gitdir: '.length));
      const head = fs.readFileSync(path.join(gitDirectory, 'HEAD'), 'utf8').trim();
      return head.startsWith('ref: refs/heads/') ? head.slice('ref: refs/heads/'.length) : 'HEAD (detached)';
    } catch { return null; }
  }

  snapshot(cwd, verifying) {
    const location = this.locate(cwd);
    if (!location || location.missing) return location;
    if (!verifying) return location;
    const root = location.path;
    let cached = this.cache.get(root);
    if (!cached) {
      const branch = this.branchFromFile(root);
      cached = { at: -Infinity, value: branch ? { branch } : {}, pending: null };
      this.cache.set(root, cached);
    }
    if (!cached.pending && this.now() - cached.at >= REFRESH_INTERVAL_MS) {
      cached.at = this.now();
      cached.pending = Promise.resolve().then(() => this.read(root)).then(value => {
        cached.value = value;
        this.onChange();
      }).catch(() => {}).finally(() => { cached.pending = null; });
    }
    return { ...location, ...cached.value };
  }

  git(root, args) {
    return new Promise((resolve, reject) => {
      this.execFile('git', ['-C', root, ...args], {
        timeout: 3000, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024,
        env: { ...this.environment, GIT_TERMINAL_PROMPT: '0' },
      }, (error, stdout) => error ? reject(error) : resolve(stdout));
    });
  }

  async read(root) {
    const [branch, status] = await Promise.all([
      this.git(root, ['symbolic-ref', '--short', '-q', 'HEAD']).catch(error => {
        if (error.code === 1) return 'HEAD (detached)';
        throw error;
      }),
      this.git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
    ]);
    let base;
    try { base = (await this.git(root, ['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'])).trim(); }
    catch (error) { if (error.code !== 1) throw error; }
    if (!base) {
      try { await this.git(root, ['show-ref', '--verify', '--quiet', 'refs/heads/main']); base = 'main'; }
      catch (error) { if (error.code !== 1) throw error; }
    }
    let uncommitted = 0;
    const entries = status.split('\0');
    for (let index = 0; index < entries.length; index += 1) {
      if (!entries[index]) continue;
      uncommitted += 1;
      if (/[RC]/.test(entries[index].slice(0, 2))) index += 1;
    }
    const ahead = base ? Number((await this.git(root, ['rev-list', '--count', `${base}..HEAD`])).trim()) : undefined;
    return { branch: branch.trim(), uncommitted, ...(base ? { base: base.replace(/^refs\/remotes\/origin\//, ''), ahead } : {}) };
  }

  // 名前だけで起動するとカレントディレクトリから探されるため、どの候補も環境変数から作った絶対パスで起動する。
  // Windows Terminal の無い環境(Windows 10 の既定)では PowerShell へ落とす。常駐サーバーから直接起動すると標準入力が空で
  // すぐ終わるので、cmd の start で新しいコンソールを開く。worktree のパスはコマンド行に入れず、作業ディレクトリでだけ渡す。
  terminalCommand(root) {
    const { LOCALAPPDATA: localAppData, ProgramFiles: programFiles, SystemRoot: systemRoot } = this.environment;
    const exists = file => file && path.isAbsolute(file) && fs.existsSync(file);
    const wt = localAppData && path.join(localAppData, 'Microsoft', 'WindowsApps', 'wt.exe');
    if (exists(wt)) return { file: wt, args: ['-w', 'new', '-d', root], options: { detached: true, windowsHide: true, shell: false, stdio: 'ignore' } };
    const cmd = systemRoot && path.join(systemRoot, 'System32', 'cmd.exe');
    const shell = [
      programFiles && path.join(programFiles, 'PowerShell', '7', 'pwsh.exe'),
      systemRoot && path.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    ].find(exists);
    if (!exists(cmd) || !shell) return null;
    return { file: cmd, args: [`/d /c start "worktree" "${shell}" -NoExit`],
      options: { detached: true, windowsHide: true, shell: false, stdio: 'ignore', cwd: root, windowsVerbatimArguments: true } };
  }

  async openTerminal(cwd) {
    const location = this.locate(cwd);
    if (!location || location.missing) return { status: 404, error: 'worktree が見つかりません (削除済み)' };
    if (this.platform !== 'win32') return { status: 400, error: 'ターミナルで開く操作は Windows で使えます' };
    const terminal = this.terminalCommand(location.path);
    if (!terminal) return { status: 404, error: 'ターミナル (wt.exe か PowerShell) が見つかりません' };
    const last = this.terminalRequests.get(location.path);
    if (last !== undefined && this.now() - last < TERMINAL_INTERVAL_MS) return { status: 429, error: '少し待ってから、もう一度開いてください' };
    this.terminalRequests.set(location.path, this.now());
    try {
      await new Promise((resolve, reject) => {
        const child = this.spawn(terminal.file, terminal.args, terminal.options);
        child.once('error', reject);
        child.once('spawn', () => { child.unref(); resolve(); });
      });
      return { status: 200, opened: true };
    } catch { return { status: 400, error: 'ターミナルを開けませんでした' }; }
  }
}

module.exports = { WorktreeInfo };
