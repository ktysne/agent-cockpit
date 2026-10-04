const crypto = require('node:crypto');
const fsSync = require('node:fs');
const fs = require('node:fs/promises');
const path = require('node:path');

const RENAME_RETRY_DELAYS_MS = [50, 100, 200];

async function atomicWriteJson(homeDir, fileName, value, fileSystem = fs, options = {}) {
  const target = path.join(homeDir, fileName);
  const temporary = path.join(homeDir, `.${fileName}.${process.pid}.${crypto.randomUUID()}.tmp`);
  const contents = `${JSON.stringify(value, null, 2)}\n`;
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
  }

  write(fileName, value) {
    const contents = JSON.stringify(value, null, 2);
    const run = this.pending.then(() => atomicWriteJson(
      this.homeDir,
      fileName,
      JSON.parse(contents),
      this.fileSystem,
      this.writeOptions,
    ));
    this.pending = run.catch((error) => {
      this.onFailure(fileName, error);
    });
    return run;
  }

  flush() {
    return this.pending;
  }
}

module.exports = { AtomicJsonWriter, RENAME_RETRY_DELAYS_MS, atomicWriteJson, atomicWriteJsonSync };
