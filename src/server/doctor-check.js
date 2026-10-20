const childProcess = require('node:child_process');
const path = require('node:path');
const { childEnvironment } = require('../client/server-connection');

const FIRST_CHECK_DELAY_MS = 90_000;
const SESSION_DEBOUNCE_MS = 10_000;
const MIN_CHECK_INTERVAL_MS = 60_000;

class DoctorChecker {
  constructor({ homeDir, execFileImpl = childProcess.execFile, nowMs = Date.now,
    setTimeoutImpl = setTimeout, clearTimeoutImpl = clearTimeout } = {}) {
    Object.assign(this, { homeDir, execFileImpl, nowMs, setTimeoutImpl, clearTimeoutImpl });
    this.result = null;
    this.error = null;
    this.inFlight = null;
    this.startedAt = null;
    this.started = false;
    this.closed = false;
    this.firstTimer = null;
    this.sessionTimer = null;
  }

  start() {
    if (this.started || this.closed) return;
    this.started = true;
    this.firstTimer = this.setTimeoutImpl(() => {
      this.firstTimer = null;
      return this.check();
    }, FIRST_CHECK_DELAY_MS);
    this.firstTimer.unref?.();
  }

  sessionStarted() {
    if (this.closed) return;
    if (this.sessionTimer !== null) this.clearTimeoutImpl(this.sessionTimer);
    const delay = Math.max(SESSION_DEBOUNCE_MS,
      this.startedAt === null ? 0 : this.startedAt + MIN_CHECK_INTERVAL_MS - this.nowMs());
    this.scheduleSessionCheck(delay);
  }

  scheduleSessionCheck(delay) {
    this.sessionTimer = this.setTimeoutImpl(() => {
      this.sessionTimer = null;
      const remaining = this.startedAt === null ? 0 : this.startedAt + MIN_CHECK_INTERVAL_MS - this.nowMs();
      if (remaining > 0) return this.scheduleSessionCheck(remaining);
      return this.check();
    }, delay);
    this.sessionTimer.unref?.();
  }

  check() {
    if (this.inFlight) return this.inFlight;
    if (this.closed) return Promise.resolve(this.snapshot());
    this.startedAt = this.nowMs();
    this.error = null;
    this.inFlight = this.checkOnce().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async checkOnce() {
    try {
      const output = await new Promise((resolve, reject) => {
        this.execFileImpl(process.execPath, [path.resolve(__dirname, '../../src/client/doctor.js'), '--json'], {
          env: { ...childEnvironment(process.env), AGENT_COCKPIT_HOME: this.homeDir },
          windowsHide: true, timeout: 90_000, maxBuffer: 8 * 1024 * 1024,
        }, (error, stdout) => !error || error.code === 1 ? resolve(stdout) : reject(error));
      });
      let result;
      try { result = JSON.parse(output); }
      catch { throw Object.assign(new Error('Invalid JSON'), { code: 'INVALID_JSON' }); }
      if (result?.schemaVersion !== 1) throw Object.assign(new Error('Unsupported schema'), { code: 'UNSUPPORTED_SCHEMA' });
      if (!result.summary || !Array.isArray(result.items) || !result.checkout || !result.homes || !result.generatedAt) {
        throw Object.assign(new Error('Invalid report'), { code: 'INVALID_REPORT' });
      }
      this.result = result;
    } catch (error) {
      this.error = error.killed ? 'TIMEOUT' : String(error.code || 'CHECK_FAILED');
    }
    return { ...this.snapshot(), running: false };
  }

  snapshot(staleBefore = null) {
    return { running: Boolean(this.inFlight), generatedAt: this.result?.generatedAt || null,
      error: this.error, summary: this.result?.summary || null, staleBefore };
  }

  details() {
    if (!this.result) return null;
    const { generatedAt, checkout, homes, items } = this.result;
    return { generatedAt, checkout: { root: checkout.root, version: checkout.version }, homes,
      items: items.map(({ id, tool, provider, result, reason, actions }) => ({ id, tool, provider, result, reason,
        actions: actions.map(({ op, text }) => op === 'manual' ? { op, text } : { op }) })) };
  }

  async close() {
    this.closed = true;
    for (const timer of [this.firstTimer, this.sessionTimer]) {
      if (timer !== null) this.clearTimeoutImpl(timer);
    }
    this.firstTimer = null;
    this.sessionTimer = null;
    await this.inFlight;
  }
}

module.exports = { DoctorChecker };
