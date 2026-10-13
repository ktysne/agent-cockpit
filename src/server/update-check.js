const childProcess = require('node:child_process');
const path = require('node:path');
const { version } = require('../../package.json');

const REPOSITORY_URL = 'https://github.com/ktysne/agent-cockpit';
const FIRST_CHECK_DELAY_MS = 60_000;
const CHECK_INTERVAL_MS = 6 * 60 * 60_000;

function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(value);
  return match ? match.slice(1).map(BigInt) : null;
}

function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) throw new Error('Invalid version');
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}

function latestVersionFromTags(output) {
  let latest = null;
  for (const line of String(output).split(/\r?\n/)) {
    const ref = line.split(/\s+/)[1];
    const match = /^refs\/tags\/v(\d+\.\d+\.\d+)$/.exec(ref || '');
    if (match && (latest === null || compareVersions(match[1], latest) > 0)) latest = match[1];
  }
  return latest;
}

class UpdateChecker {
  constructor({ current = version, execFileImpl = childProcess.execFile, nowMs = Date.now,
    setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout, diagnostics } = {}) {
    this.current = current;
    this.execFileImpl = execFileImpl;
    this.nowMs = nowMs;
    this.setTimeoutImpl = setTimeoutImpl;
    this.clearTimeoutImpl = clearTimeoutImpl;
    this.diagnostics = diagnostics;
    this.result = { current, latest: null, available: false, checkedAt: null, error: null };
    this.timer = null;
    this.running = false;
    this.inFlight = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedule(FIRST_CHECK_DELAY_MS);
  }

  schedule(delayMs) {
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null;
      if (!this.running) return;
      this.schedule(CHECK_INTERVAL_MS);
      return this.check();
    }, delayMs);
    this.timer.unref?.();
  }

  async close() {
    this.running = false;
    if (this.timer !== null) this.clearTimeoutImpl(this.timer);
    this.timer = null;
    await this.inFlight;
  }

  check() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = this.checkOnce().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async checkOnce() {
    try {
      const output = await new Promise((resolve, reject) => {
        this.execFileImpl('git', ['ls-remote', '--refs', '--tags', `${REPOSITORY_URL}.git`], {
          windowsHide: true, timeout: 15_000, maxBuffer: 1024 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' },
        }, (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      const latest = latestVersionFromTags(output);
      if (latest === null) throw Object.assign(new Error('No version tags'), { code: 'NO_VERSION_TAGS' });
      this.result = { current: this.current, latest, available: compareVersions(latest, this.current) > 0,
        checkedAt: new Date(this.nowMs()).toISOString(), error: null };
      await this.diagnostics?.record('info', 'server', 'update.checked', this.result);
    } catch (error) {
      const failure = error.killed ? 'TIMEOUT' : String(error.code || 'CHECK_FAILED');
      this.result = { current: this.current, latest: null, available: false,
        checkedAt: new Date(this.nowMs()).toISOString(), error: failure };
      await this.diagnostics?.record('warn', 'server', 'update.failed', { failure });
    }
    return this.snapshot();
  }

  snapshot() {
    const result = { ...this.result };
    if (result.available) {
      result.prompt = `agent-cockpit を v${result.latest} に更新して。手順は ${path.resolve(__dirname, '../../docs/update.md')} にある。`;
      result.compareUrl = this.current === '0.0.0'
        ? `${REPOSITORY_URL}/tree/v${result.latest}`
        : `${REPOSITORY_URL}/compare/v${this.current}...v${result.latest}`;
    }
    return result;
  }
}

module.exports = { UpdateChecker, compareVersions, latestVersionFromTags };
