'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { CLIENT_EVENTS } = require('../client/diagnostic-events');

const RUN_PATTERN = /^\d{8}T\d{6}(?:\d{3})?Z-\d+$/;
const FILE_PATTERN = /^(\d{8}T\d{6}(?:\d{3})?Z-\d+)\.(\d+)\.jsonl$/;
const LEVELS = ['silent', 'error', 'warn', 'info', 'debug'];
const TAGS = ['server', 'hook', 'mcp', 'web', 'gh', 'merge', 'codex'];
const DIAGNOSTIC_REPEAT_WINDOW_MS = 10 * 60_000;
const DIAGNOSTIC_REPEAT_FLUSH_INTERVAL_MS = 60_000;
const MAX_DIAGNOSTIC_REPEAT_KEYS = 256;
const ALLOWED_DATA = Object.freeze({
  ...Object.fromEntries(Object.entries(CLIENT_EVENTS).map(([msg, spec]) => [msg, Object.keys(spec.fields)])),
  'server.start': ['pid', 'port', 'version', 'commit'],
  'server.source': ['sourceState'],
  'server.stop': ['pid'],
  'update.checked': ['current', 'latest', 'available', 'checkedAt'],
  'update.failed': ['failure'],
  'request.failed': ['method', 'path', 'status', 'error', 'secret', 'origin'],
  'event.accepted': ['event', 'provider', 'tool', 'session', 'product', 'delayMs'],
  'event.rejected': ['reason', 'event', 'provider', 'session'],
  'event.delayed': ['event', 'provider', 'tool', 'session', 'product', 'delayMs'],
  'event.lifecycle': ['event', 'provider', 'session', 'product'],
  'event.summary': ['SessionStart', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd', 'UserPromptSubmit', 'PostToolBatch', 'PermissionRequest', 'Interrupt'],
  'server.perf': ['stateCount', 'stateCacheHitCount', 'stateTotalMs', 'stateMaxMs', 'eventCount', 'eventTotalMs', 'eventMaxMs', 'storeCount', 'storeTotalMs', 'storeMaxMs', 'snapshotCount', 'snapshotTotalMs', 'snapshotMaxMs', 'loopP99Ms', 'loopMaxMs'],
  'state.cache.mismatch': ['etag', 'version'],
  'gh.failed': ['operation', 'repository', 'number', 'session', 'failure', 'code', 'signal', 'exitCode', 'consecutive'],
  'pr.refresh.failed': ['name'],
  'merge.check': ['operation', 'repository', 'number', 'head', 'condition', 'status'],
  'merge.reserved': ['repository', 'number'],
  'merge.cancelled': ['repository', 'number'],
  'merge.result': ['repository', 'number', 'result'],
  'merge.local-update': ['repository', 'result'],
  'session.ended': ['session', 'provider', 'reason'],
  'review.reminder': ['repository', 'number', 'session'],
  'review.state': ['repository', 'number', 'session', 'file', 'head', 'failure', 'round', 'outcome', 'triageHead'],
  'diagnostics.rotate': ['segment', 'version', 'commit', 'sourceState'],
  'diagnostics.pruned': ['count'],
  'diagnostics.repeated': ['msg', 'count', 'since', 'data'],
});

function runStartedAt(run) {
  const stamp = run.split('-')[0];
  return `${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}.${stamp.slice(15, -1) || '000'}Z`;
}

// 起動時の区分は保持上限で消えることがあるため、区分の切り替えの mark もバージョンの出どころにする。
function runtimeRecords(entries) {
  const identity = entries.find(entry => ['server.start', 'diagnostics.rotate'].includes(entry.msg)
    && (entry.data.version || entry.data.commit));
  const source = entries.find(entry => ['server.source', 'diagnostics.rotate'].includes(entry.msg)
    && entry.data.sourceState && entry.data.sourceState !== 'pending');
  return {
    runtime: identity ? { version: identity.data.version || null, commit: identity.data.commit || null } : null,
    sourceState: source?.data.sourceState || null,
  };
}

/** 起動ごとの診断ログを直列に追記し、読み出しと保持上限と削除を管理する。 */
class Diagnostics {
  constructor({ homeDir, userHome = os.homedir(), getLevel = () => 'info', startedAt = new Date(), pid = process.pid,
    maxLines = 2000, maxRuns = 10, maxSegments = 30, repeatWindowMs = DIAGNOSTIC_REPEAT_WINDOW_MS,
    repeatFlushIntervalMs = DIAGNOSTIC_REPEAT_FLUSH_INTERVAL_MS, maxRepeatKeys = MAX_DIAGNOSTIC_REPEAT_KEYS }) {
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
    this.fileSummaries = new Map();
    this.repeatWindowMs = repeatWindowMs;
    this.maxRepeatKeys = Math.max(1, maxRepeatKeys);
    this.repeated = new Map();
    this.repeatTimer = setInterval(() => {
      this.enqueue(() => this.flushExpiredRepeats(Date.now())).catch(() => {});
    }, repeatFlushIntervalMs);
    this.repeatTimer.unref();
  }

  setRuntime({ version, commit, sourceState }) {
    this.runtime = { version, commit, sourceState };
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
    // 件数の行は元の内容を入れ子で持ち、元の識別子の許可一覧で絞り直す。
    if (msg === 'diagnostics.repeated') {
      if (!Object.hasOwn(ALLOWED_DATA, data.msg) || data.msg === msg) return clean;
      clean.msg = data.msg;
      if (Number.isInteger(data.count) && data.count > 0) clean.count = data.count;
      if (typeof data.since === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(data.since)) clean.since = data.since;
      const inner = data.data && typeof data.data === 'object' ? this.sanitize(data.msg, data.data) : {};
      if (Object.keys(inner).length) clean.data = inner;
      return clean;
    }
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
    if (level === 'mark') return this.enqueue(() => this.append(entry)).catch(() => {});
    const key = JSON.stringify([level, tag, msg, entry.data]);
    return this.enqueue(async () => {
      const existing = this.repeated.get(key);
      if (existing && entry.ts < existing.expiresAt) {
        existing.count += 1;
        return;
      }
      if (existing) {
        await this.appendRepeated(existing);
        this.repeated.delete(key);
      }
      if (this.repeated.size >= this.maxRepeatKeys) {
        const oldestKey = this.repeated.keys().next().value;
        const oldest = this.repeated.get(oldestKey);
        await this.appendRepeated(oldest);
        this.repeated.delete(oldestKey);
      }
      await this.append(entry);
      this.repeated.set(key, { level, tag, msg, data: entry.data, expiresAt: entry.ts + this.repeatWindowMs, count: 0 });
    }).catch(() => {});
  }

  async appendRepeated(repeated) {
    if (!repeated.count) return;
    await this.append({ ts: Date.now(), level: repeated.level, tag: repeated.tag, msg: 'diagnostics.repeated',
      data: this.sanitize('diagnostics.repeated', { msg: repeated.msg, count: repeated.count,
        since: new Date(repeated.expiresAt - this.repeatWindowMs).toISOString(), data: repeated.data }) });
  }

  async flushExpiredRepeats(now) {
    for (const [key, repeated] of this.repeated) {
      if (now < repeated.expiresAt) continue;
      await this.appendRepeated(repeated);
      this.repeated.delete(key);
    }
  }

  async flushRepeated() {
    for (const [key, repeated] of this.repeated) {
      await this.appendRepeated(repeated);
      this.repeated.delete(key);
    }
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
      if (rotated) await this.write({ ts: entry.ts, level: 'mark', tag: 'server', msg: 'diagnostics.rotate', data: { segment: this.segment, ...this.runtime } });
      if (count) await this.write({ ts: entry.ts, level: 'mark', tag: 'server', msg: 'diagnostics.pruned', data: { count } });
    }
    await this.write(entry);
  }

  listRuns() {
    return this.enqueue(async () => {
      const files = await this.files();
      const currentFiles = new Set(files.map(file => file.name));
      for (const name of this.fileSummaries.keys()) {
        if (!currentFiles.has(name)) this.fileSummaries.delete(name);
      }
      const runs = new Map([[this.run, { id: this.run, startedAt: runStartedAt(this.run), count: 0, sources: new Set(), current: true, runtime: null, sourceState: null }]]);
      for (const file of files) {
        if (!runs.has(file.run)) runs.set(file.run, { id: file.run, startedAt: runStartedAt(file.run), count: 0, sources: new Set(), current: false, runtime: null, sourceState: null });
        const stat = await fs.stat(path.join(this.directory, file.name));
        let summary = this.fileSummaries.get(file.name);
        if (!summary || summary.size !== stat.size || summary.mtimeMs !== stat.mtimeMs) {
          const entries = await this.readFile(file.name);
          summary = { ...runtimeRecords(entries), size: stat.size, mtimeMs: stat.mtimeMs, count: entries.length,
            sources: [...new Set(entries.map(entry => entry.tag))] };
          this.fileSummaries.set(file.name, summary);
        }
        const run = runs.get(file.run);
        run.runtime ||= summary.runtime;
        run.sourceState ||= summary.sourceState;
        run.count += summary.count;
        for (const source of summary.sources) run.sources.add(source);
      }
      return [...runs.values()].map(({ sourceState, ...run }) => ({ ...run, sources: [...run.sources],
        runtime: this.runRuntime(run.id, run.runtime, sourceState) }))
        .sort((a, b) => Number(b.current) - Number(a.current) || b.id.localeCompare(a.id));
    });
  }

  // 過去の起動に現在のサーバーのバージョンを補わない。記録が無ければ null(バージョン不明)とする。
  runRuntime(run, runtime, sourceState) {
    if (run === this.run && this.runtime) return { ...this.runtime };
    return runtime ? { ...runtime, sourceState: sourceState || 'unknown' } : null;
  }

  /** 起動の記録から、その起動を書いたサーバーのバージョンを求める。 */
  runtimeOfEntries(run, entries) {
    const { runtime, sourceState } = runtimeRecords(entries);
    return this.runRuntime(run, runtime, sourceState);
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
      // 消した記録の件数を後から書き戻さず、削除後の最初の 1 件を書くため、まとめている件数も捨てる。
      if (all === true || run === this.run) { this.segment += 1; this.lines = 0; this.repeated.clear(); }
    });
  }

  // 稼働を続けたまま、まとめている件数だけを書き出す。定期の書き出しは止めない。
  writeRepeated() {
    return this.enqueue(() => this.flushRepeated()).catch(() => {});
  }

  flush() {
    clearInterval(this.repeatTimer);
    return this.writeRepeated();
  }
}

module.exports = { Diagnostics, RUN_PATTERN };
