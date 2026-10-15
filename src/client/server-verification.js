const fs = require('node:fs/promises');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { readSourceCommit } = require('../server/source-revision');
const { requestFromServer } = require('./server-connection');

const CHECKOUT_ROOT = path.resolve(__dirname, '../..');
const REQUEST_TIMEOUT_MS = 1000;
const SOURCE_STATE_TIMEOUT_MS = 10_000;
const SOURCE_STATE_INTERVAL_MS = 100;

async function readExpected(root = CHECKOUT_ROOT, options = {}) {
  const readFile = options.readFile || fs.readFile;
  const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  return {
    version: options.expectedVersion ?? packageJson.version,
    commit: await (options.readSourceCommit || readSourceCommit)(root),
  };
}

function verifyHealth(expected, started, health) {
  if (!health) return {
    result: 'start-failed', expected, running: null, commitVerified: false, releaseVerified: false,
  };

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
    releaseVerified: identityMatches && contentMatches && expected.commit !== null && running.sourceState === 'release',
    identityMatches,
  };
}

async function verifyServer(started, options = {}) {
  const expected = options.expected || await readExpected(options.root, options);
  if (!started) return {
    result: 'start-failed', expected, running: null, commitVerified: false, releaseVerified: false,
  };
  const now = options.now || Date.now;
  const wait = options.sleep || sleep;
  const settleSourceState = options.settleSourceState === true;
  const sourceStateDeadline = settleSourceState
    ? now() + (options.sourceStateTimeoutMs ?? SOURCE_STATE_TIMEOUT_MS)
    : null;
  const request = options.requestFromServer || requestFromServer;
  const requestHealth = async (latestDeadline = Number.POSITIVE_INFINITY) => {
    const deadline = Math.min(now() + (options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS), latestDeadline);
    return request(
      started,
      '/health',
      { method: 'GET' },
      { fetchImpl: options.fetchImpl, now, deadline },
    );
  };
  const response = await requestHealth();
  if (!response.ok || !response.json) {
    return { result: 'start-failed', expected, running: null, commitVerified: false, releaseVerified: false };
  }
  let verification = verifyHealth(expected, started, response.json);
  if (!settleSourceState || verification.result !== 'ok' || verification.running.sourceState !== 'pending') {
    return verification;
  }

  while (now() < sourceStateDeadline) {
    await wait(Math.min(options.sourceStateIntervalMs ?? SOURCE_STATE_INTERVAL_MS, sourceStateDeadline - now()));
    if (now() >= sourceStateDeadline) break;
    const nextResponse = await requestHealth(sourceStateDeadline);
    if (!nextResponse.ok || !nextResponse.json) return verification;
    const nextVerification = verifyHealth(expected, started, nextResponse.json);
    if (nextVerification.result !== 'ok' || nextVerification.running.sourceState !== 'pending') return nextVerification;
    verification = nextVerification;
  }
  return verification;
}

module.exports = { readExpected, verifyHealth, verifyServer };
