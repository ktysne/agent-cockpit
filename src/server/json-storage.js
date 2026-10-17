const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const RENAME_RETRY_DELAYS_MS = [50, 100, 200];
const PERSISTENCE_RETRY_DELAYS_MS = [1_000, 5_000, 15_000, 60_000];

async function atomicWriteText(homeDir, fileName, contents, fileSystem = fs, options = {}) {
  const target = path.join(homeDir, fileName);
  const temporary = path.join(homeDir, `.${fileName}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const delays = options.retryDelaysMs || RENAME_RETRY_DELAYS_MS;
  const delay = options.delay || ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));

  try {
    await fileSystem.writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fileSystem.rename(temporary, target);
        return;
      } catch (error) {
        if (!['EPERM', 'EBUSY'].includes(error.code) || attempt >= delays.length) throw error;
        await delay(delays[attempt]);
      }
    }
  } catch (error) {
    await fileSystem.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function atomicWriteJson(homeDir, fileName, value, fileSystem = fs, options = {}) {
  await atomicWriteText(homeDir, fileName, `${JSON.stringify(value, null, 2)}\n`, fileSystem, options);
}

function atomicWriteJsonSync(homeDir, fileName, value, fileSystem = fsSync, options = {}) {
  const target = path.join(homeDir, fileName);
  const temporary = path.join(homeDir, `.${fileName}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
  const delays = options.retryDelaysMs || RENAME_RETRY_DELAYS_MS;
  const delay = options.delaySync || ((milliseconds) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds));

  try {
    fileSystem.writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600 });
    for (let attempt = 0; ; attempt += 1) {
      try {
        fileSystem.renameSync(temporary, target);
        return;
      } catch (error) {
        if (!['EPERM', 'EBUSY'].includes(error.code) || attempt >= delays.length) throw error;
        delay(delays[attempt]);
      }
    }
  } catch (error) {
    try { fileSystem.unlinkSync(temporary); } catch {}
    throw error;
  }
}

class AtomicJsonWriter {
  constructor(homeDir, options = {}) {
    this.homeDir = homeDir;
    this.fileSystem = options.fileSystem || fs;
    this.writeOptions = {
      ...(options.retryDelaysMs ? { retryDelaysMs: options.retryDelaysMs } : {}),
      ...(options.delay ? { delay: options.delay } : {}),
    };
    this.onFailure = options.onFailure || (() => {});
    this.pending = Promise.resolve();
    this.files = new Map();
    this.retryDelaysMs = options.persistenceRetryDelaysMs || PERSISTENCE_RETRY_DELAYS_MS;
    this.closed = false;
  }

  write(fileName, value) {
    const contents = `${JSON.stringify(value, null, 2)}\n`;
    const file = this.files.get(fileName) || {
      version: 0, savedVersion: 0, failures: 0, errorCode: null, lastFailureAt: null, timer: null,
    };
    file.version += 1;
    file.contents = contents;
    this.files.set(fileName, file);
    return this.enqueue(fileName, file.version, contents);
  }

  enqueue(fileName, version, contents) {
    const file = this.files.get(fileName);
    clearTimeout(file.timer);
    file.timer = null;
    const run = this.pending.then(async () => {
      if (version <= file.savedVersion) return;
      try {
        await atomicWriteText(this.homeDir, fileName, contents, this.fileSystem, this.writeOptions);
        file.savedVersion = version;
        if (file.savedVersion === file.version) {
          file.failures = 0;
          file.errorCode = null;
          file.lastFailureAt = null;
          file.contents = null;
          clearTimeout(file.timer);
          file.timer = null;
        }
      } catch (error) {
        file.failures += 1;
        file.errorCode = /^[A-Z][A-Z0-9_]{0,31}$/.test(error.code || '') ? error.code : 'WRITE_FAILED';
        file.lastFailureAt = new Date().toISOString();
        this.scheduleRetry(fileName);
        this.onFailure(fileName, error);
        throw error;
      }
    });
    this.pending = run.catch(() => {});
    return run;
  }

  scheduleRetry(fileName) {
    const file = this.files.get(fileName);
    if (this.closed || file.timer) return;
    const delayMs = this.retryDelaysMs[Math.min(file.failures - 1, this.retryDelaysMs.length - 1)];
    file.timer = setTimeout(() => {
      file.timer = null;
      void this.retry(fileName).catch(() => {});
    }, delayMs);
    file.timer.unref?.();
  }

  async retry(fileName) {
    await this.pending;
    const file = this.files.get(fileName);
    if (file && file.savedVersion < file.version) return this.enqueue(fileName, file.version, file.contents);
  }

  snapshot() {
    const files = [...this.files].filter(([, file]) => file.savedVersion < file.version).map(([fileName, file]) => ({
      fileName, version: file.version, savedVersion: file.savedVersion,
      errorCode: file.errorCode, lastFailureAt: file.lastFailureAt,
    }));
    return { status: files.some(file => file.errorCode) ? 'failed' : files.length ? 'pending' : 'saved', files };
  }

  async flush() {
    await this.pending;
    await Promise.all([...this.files.keys()].map(fileName => this.retry(fileName).catch(() => {})));
    return this.snapshot();
  }

  wait() {
    return this.pending;
  }

  async close() {
    this.closed = true;
    for (const file of this.files.values()) clearTimeout(file.timer);
    return this.flush();
  }
}

module.exports = { AtomicJsonWriter, RENAME_RETRY_DELAYS_MS, atomicWriteJson, atomicWriteJsonSync };
