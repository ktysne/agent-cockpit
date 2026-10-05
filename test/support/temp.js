const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const environmentOverrides = new Map();

function temporaryDirectory(testContext, prefix = 'agent-cockpit-test-', options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const environment = options.environment || {};
  const environmentEntries = new Map();

  for (const [name, value] of Object.entries(environment)) {
    const entry = {
      previousValue: process.env[name],
      value: typeof value === 'function' ? value(directory) : value,
    };
    const entries = environmentOverrides.get(name) || [];
    entries.push(entry);
    environmentOverrides.set(name, entries);
    environmentEntries.set(name, entry);
    process.env[name] = entry.value;
  }

  let cleanupPromise;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      for (const [name, entry] of environmentEntries) {
        const entries = environmentOverrides.get(name);
        const index = entries.indexOf(entry);
        const nextEntry = entries[index + 1];
        if (nextEntry) nextEntry.previousValue = entry.previousValue;
        if (!nextEntry && process.env[name] === entry.value) {
          if (entry.previousValue === undefined) delete process.env[name];
          else process.env[name] = entry.previousValue;
        }
        entries.splice(index, 1);
        if (!entries.length) environmentOverrides.delete(name);
      }
      await fsp.rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    })();
    return cleanupPromise;
  };

  if (!options.deferCleanup) testContext.after(cleanup);
  return { directory, cleanup };
}

function temporaryHome(testContext, prefix = 'agent-cockpit-test-', options = {}) {
  const temporary = temporaryDirectory(testContext, prefix, options);
  return {
    ...temporary,
    homeDir: temporary.directory,
    claudeHome: path.join(temporary.directory, '.claude'),
  };
}

module.exports = { temporaryDirectory, temporaryHome };
