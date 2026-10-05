const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

function temporaryDirectory(testContext, prefix = 'agent-cockpit-test-', options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const environment = options.environment || {};
  const previousEnvironment = new Map();

  for (const [name, value] of Object.entries(environment)) {
    previousEnvironment.set(name, process.env[name]);
    process.env[name] = typeof value === 'function' ? value(directory) : value;
  }

  let cleanupPromise;
  const cleanup = () => {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
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
