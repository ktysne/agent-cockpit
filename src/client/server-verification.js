const fs = require('node:fs/promises');
const path = require('node:path');
const { readSourceCommit } = require('../server/source-revision');
const { requestFromServer } = require('./server-connection');

const CHECKOUT_ROOT = path.resolve(__dirname, '../..');

async function readExpected(root = CHECKOUT_ROOT, options = {}) {
  const readFile = options.readFile || fs.readFile;
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  return {
    version: options.expectedVersion ?? packageJson.version,
    commit: await (options.readSourceCommit || readSourceCommit)(root),
  };
}

function verifyHealth(expected, started, health) {
  if (!health) return { result: 'start-failed', expected, running: null, commitVerified: false };

  const running = {
    version: health.version ?? null,
    commit: health.commit ?? null,
    sourceState: health.sourceState ?? null,
  };
  const identityMatches = health.app === 'agent-cockpit' &&
    health.pid === started.pid && health.startedAt === started.startedAt;
  const contentMatches = health.version === expected.version &&
    (expected.commit === null || health.commit === expected.commit);
  return {
    result: identityMatches && contentMatches ? 'ok' : 'mismatch',
    expected,
    running,
    commitVerified: identityMatches && contentMatches && expected.commit !== null,
    identityMatches,
  };
}

async function verifyServer(started, options = {}) {
  const expected = options.expected || await readExpected(options.root, options);
  if (!started) return { result: 'start-failed', expected, running: null, commitVerified: false };
  const response = await (options.requestFromServer || requestFromServer)(
    started,
    '/health',
    { method: 'GET' },
    { fetchImpl: options.fetchImpl, now: options.now, deadline: (options.now || Date.now)() + 1000 },
  );
  if (!response.ok || !response.json) {
    return { result: 'start-failed', expected, running: null, commitVerified: false };
  }
  return verifyHealth(expected, started, response.json);
}

module.exports = { readExpected, verifyHealth, verifyServer };
