'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CLIENT_EVENTS } = require('../client/diagnostic-events');

const RUN_PATTERN = /^\d{8}T\d{6}(?:\d{3})?Z-\d+$/;
const FILE_PATTERN = /^(\d{8}T\d{6}(?:\d{3})?Z-\d+)\.(\d+)\.jsonl$/;
const LEVELS = ['silent', 'error', 'warn', 'info', 'debug'];
const TAGS = ['server', 'hook', 'mcp', 'web', 'gh', 'merge', 'codex'];
const ALLOWED_DATA = Object.freeze({
  ...Object.fromEntries(Object.entries(CLIENT_EVENTS).map(([msg, spec]) => [msg, Object.keys(spec.fields)])),
  'server.start': ['pid', 'port', 'version', 'commit'],
  'server.stop': ['pid'],
  'request.failed': ['method', 'path', 'status', 'error', 'secret', 'origin'],
  'event.accepted': ['event', 'provider', 'tool', 'session', 'product', 'delayMs'],
  'event.rejected': ['reason', 'event', 'provider', 'session'],
  'event.delayed': ['event', 'provider', 'tool', 'session', 'product', 'delayMs'],
  'event.lifecycle': ['event', 'provider', 'session', 'product'],
  'event.summary': ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd', 'UserPromptSubmit', 'PostToolBatch', 'PermissionRequest', 'Interrupt'],
  'gh.failed': ['operation', 'repository', 'number', 'session', 'failure', 'code', 'signal', 'exitCode', 'consecutive'],
  'merge.check': ['operation', 'repository', 'number', 'head', 'condition', 'status'],
  'merge.reserved': ['repository', 'number'],
  'merge.cancelled': ['repository', 'number'],
  'merge.result': ['repository', 'number', 'result'],
  'session.ended': ['session', 'provider', 'reason'],
  'review.state': ['repository', 'number', 'session', 'file', 'head', 'failure', 'round', 'outcome', 'triageHead'],
  'diagnostics.rotate': ['segment'],
  'diagnostics.pruned': ['count'],
});

function runStartedAt(run) {
  const stamp = run.split('-')[0];
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, -1) || '000'}Z`;
}

/** 起動ごとの診断ログを直列に追記し、読み出しと保持上限と削除を管理する。 */
class Diagnostics {
  constructor({ homeDir, userHome = os.homedir(), getLevel = () => 'info', startedAt = new Date(), pid = process.pid,
    maxLines = 2000, maxRuns = 10, maxSegments = 30 }) {
    this.directory = path.join(homeDir, 'diagnostics');
    this.userHome = userHome;
    this.getLevel = getLevel;
    this.run = `${new Date(startedAt).toISOString().replace(/[-:.]/g, '')}-${pid}`;
    // 区分の先頭に切り替えと削除の mark を置くため、通常の記録を加えた容量を確保する。
    this.maxLines = Math.max(3, maxLines);
    this.maxRuns = maxRuns;
    this.maxSegments = maxSegments;
    this.segment = 0;
    this.lines = 0;
    this.queue = Promise.resolve();
  }

  sanitize(msg, data) {
    const clean = {};
    const sanitizeValue = (value, errorField = false) => {
      if (value instanceof Error || errorField && value && typeof value === 'object') {
        return Object.fromEntries(['name', 'code'].flatMap(key => {
          const field = sanitizeValue(value[key]);
          return field === undefined ? [] : [[key, field]];
        }));
      }
      if (typeof value === 'string') {
        return value.replace(/([A-Za-z]:[\\/]Users[\\/]|[\\/]home[\\/]|[\\/]Users[\\/])[^\\/\s]+/gi, '$1<redacted>')
          .split(this.userHome).join(path.join(path.dirname(this.userHome), '<redacted>')).slice(0, 200);
      }
      if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') return value;
      return undefined;
    };
    for (const key of ALLOWED_DATA[msg] || []) {
      if (['secret', 'origin'].includes(key) && !['match', 'mismatch', 'missing'].includes(data[key])) continue;
      if (key === 'error' && (!data[key] || typeof data[key] !== 'object')) continue;
      const value = sanitizeValue(data[key], key === 'error');
      if (value !== undefined) clean[key] = value;
    }
    return clean;
  }

  enqueue(operation) {
    const result = this.queue.then(operation);
    this.queue = result.catch(() => {});
    return result;
  }

  record(level, tag, msg, data = {}) {
    const configured = this.getLevel() || 'info';
    if (!Object.hasOwn(ALLOWED_DATA, msg) || !TAGS.includes(tag) || configured === 'silent'
        || !['mark', 'error', 'warn', 'info', 'debug'].includes(level)
        || (level !== 'mark' && level !== 'error' && LEVELS.indexOf(level) > LEVELS.indexOf(configured))) return this.queue;
    const entry = { ts: Date.now(), level, tag, msg, data: this.sanitize(msg, data) };
    return this.enqueue(() => this.append(entry)).catch(() => {});
  }

  async files() {
    let entries;
    try { entries = await fs.readdir(this.directory, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return []; throw error; }
    return entries.filter(entry => entry.isFile() && FILE_PATTERN.test(entry.name)).map(entry => {
      const [, run, segment] = entry.name.match(FILE_PATTERN);
      return { name: entry.name, run, segment: Number(segment) };
    }).sort((a, b) => a.run.localeCompare(b.run) || a.segment - b.segment);
  }

  async prune() {
    const files = await this.files();
    const runs = [...new Set(files.map(file => file.run))];
    const oldRuns = new Set(runs.slice(0, Math.max(0, runs.length - this.maxRuns)));
    const remaining = files.filter(file => !oldRuns.has(file.run));
    const oldSegments = new Set(remaining.slice(0, Math.max(0, remaining.length - this.maxSegments)).map(file => file.name));
    const expired = files.filter(file => oldRuns.has(file.run) || oldSegments.has(file.name));
    for (const file of expired) await fs.unlink(path.join(this.directory, file.name));
    return expired.length;
  }

  async write(entry) {
    const target = path.join(this.directory, `${this.run}.${this.segment}.jsonl`);
    await fs.appendFile(target, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    this.lines += 1;
  }

  async append(entry) {
    await fs.mkdir(this.directory, { recursive: true });
    if (!this.segment || this.lines >= this.maxLines) {
      const rotated = this.segment > 0;
      this.segment += 1;
      this.lines = 0;
      await fs.appendFile(path.join(this.directory, `${this.run}.${this.segment}.jsonl`), '', { mode: 0o600 });
      const count = await this.prune();
      if (rotated) await this.write({ ts: entry.ts, level: 'mark', tag: 'server', msg: 'diagnostics.rotate', data: { segment: this.segment } });
      if (count) await this.write({ ts: entry.ts, level: 'mark', tag: 'server', msg: 'diagnostics.pruned', data: { count } });
    }
    await this.write(entry);
  }

  listRuns() {
    return this.enqueue(async () => {
      const files = await this.files();
      const runs = new Map([[this.run, { id: this.run, startedAt: runStartedAt(this.run), count: 0, current: true }]]);
      for (const file of files) {
        if (!runs.has(file.run)) runs.set(file.run, { id: file.run, startedAt: runStartedAt(file.run), count: 0, current: false });
        const entries = await this.readFile(file.name);
        runs.get(file.run).count += entries.length;
      }
      return [...runs.values()].sort((a, b) => Number(b.current) - Number(a.current) || b.id.localeCompare(a.id));
    });
  }

  async readFile(name) {
    const text = await fs.readFile(path.join(this.directory, name), 'utf8');
    return text.split('\n').flatMap(line => {
      try {
        const entry = JSON.parse(line);
        if (!Object.hasOwn(ALLOWED_DATA, entry.msg) || !TAGS.includes(entry.tag) || !Number.isFinite(entry.ts)
            || !['mark', 'error', 'warn', 'info', 'debug'].includes(entry.level)) return [];
        return [{ ts: entry.ts, level: entry.level, tag: entry.tag, msg: entry.msg, data: this.sanitize(entry.msg, entry.data || {}) }];
      } catch { return []; }
    });
  }

  readRun(run) {
    if (!RUN_PATTERN.test(run)) throw Object.assign(new Error('Invalid run'), { statusCode: 400 });
    return this.enqueue(async () => {
      const entries = [];
      for (const file of (await this.files()).filter(file => file.run === run)) entries.push(...await this.readFile(file.name));
      return entries;
    });
  }

  deleteRuns({ run, all }) {
    if (all !== true && !RUN_PATTERN.test(run)) throw Object.assign(new Error('Invalid run'), { statusCode: 400 });
    return this.enqueue(async () => {
      for (const file of await this.files()) {
        if (all === true || file.run === run) await fs.unlink(path.join(this.directory, file.name));
      }
      if (all === true || run === this.run) { this.segment += 1; this.lines = 0; }
    });
  }

  flush() { return this.queue; }
}

module.exports = { Diagnostics, RUN_PATTERN };
