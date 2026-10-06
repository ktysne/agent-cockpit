'use strict';

const fs = require('node:fs/promises');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { DashboardState } = require('../../src/server/state');
const { PullRequestTracker } = require('../../src/server/pull-requests');
const { PullRequestMergeManager } = require('../../src/server/pull-request-merge');
const { DecisionAnswerDelivery } = require('../../src/server/decision-answers');
const { startServer } = require('../../src/server/server');
const { ghPullRequest } = require('../../test/support/github');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const NOW = Date.now();
const sha = (digit) => String(digit).repeat(40);
const isMergeCall = (call) => call[0] === 'pr' && call[1] === 'merge';

function isInside(parent, target) {
  const relative = path.relative(parent, target);
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}

async function assertRealDirectoryChain(directory) {
  const absolute = path.resolve(directory);
  const root = path.parse(absolute).root;
  let current = root;
  for (const part of path.relative(root, absolute).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    const stat = await fs.lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Output path contains a link or non-directory');
  }
  return absolute;
}

async function removeOwnedFixture(root, outDir, identity) {
  await assertRealDirectoryChain(outDir);
  if (!isInside(outDir, root)) throw new Error('Fixture cleanup escaped output directory');
  const current = await fs.lstat(root);
  if (!current.isDirectory() || current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error('Fixture directory identity changed; refusing cleanup');
  }
  await fs.rm(root, { recursive: true, force: false, maxRetries: 5, retryDelay: 50 });
  try {
    await fs.lstat(root);
    return false;
  } catch (error) {
    if (error.code === 'ENOENT') return true;
    throw error;
  }
}

function request(port, requestPath, options = {}) {
  const body = options.body || '';
  return new Promise((resolve, reject) => {
    const client = http.request({
      host: '127.0.0.1',
      port,
      method: options.method || 'GET',
      path: requestPath,
      headers: {
        host: '127.0.0.1:' + port,
        ...(body ? { 'content-length': Buffer.byteLength(body) } : {}),
        ...(options.headers || {}),
      },
    }, (response) => {
      const chunks = [];
      let receivedBytes = 0;
      response.on('data', (chunk) => {
        receivedBytes += chunk.length;
        if (receivedBytes > 2 * 1024 * 1024) {
          client.destroy(new Error('fixture HTTP response exceeded 2 MiB'));
          return;
        }
        chunks.push(chunk);
      });
      response.once('error', reject);
      response.on('end', () => resolve({
        status: response.statusCode,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    client.setTimeout(5000, () => client.destroy(new Error('fixture HTTP request timed out')));
    client.once('error', reject);
    client.end(body);
  });
}

function createFakeGh(pullRequests, control = {}) {
  const github = { open: pullRequests.map((pr) => structuredClone(pr)), views: new Map(), merged: [] };
  const calls = [];
  let openListCount = 0;
  const execFileImpl = (_file, args, _options, callback) => {
    const call = [...args];
    calls.push(call);
    const done = (error, output = '') => callback(error, output, '');
    const findOpen = (number) => github.open.find((item) => item.number === number);
    if (call[0] === 'pr' && call[1] === 'list') {
      const stateIndex = call.indexOf('--state');
      if (call[stateIndex + 1] === 'open') {
        openListCount += 1;
        control.beforeOpenList?.(openListCount, github);
        done(null, JSON.stringify(github.open));
      } else done(null, JSON.stringify(github.merged));
      return;
    }
    if (call[0] === 'api' && call[1] === 'repos/example/project') {
      done(null, JSON.stringify({
        default_branch: control.defaultBranch || 'main',
        allow_merge_commit: true,
        allow_squash_merge: true,
        allow_rebase_merge: true,
        delete_branch_on_merge: false,
      }));
      return;
    }
    if (call[0] === 'api' && call[1].includes('/compare/')) {
      done(null, JSON.stringify({ ahead_by: 0, commits: [] }));
      return;
    }
    if (call[0] === 'pr' && call[1] === 'view') {
      const number = Number(call[2]);
      if (control.failView) {
        done(Object.assign(new Error('fixture view failed'), { code: 'EIO' }));
        return;
      }
      const view = github.views.get(number) || (findOpen(number) && { ...findOpen(number), state: 'OPEN', mergedAt: null });
      done(view ? null : Object.assign(new Error('fixture view missing'), { code: 'EIO' }), view ? JSON.stringify(view) : '');
      return;
    }
    if (call[0] === 'pr' && call[1] === 'edit') {
      const pr = findOpen(Number(call[2]));
      const baseIndex = call.indexOf('--base');
      if (pr && baseIndex >= 0) pr.baseRefName = call[baseIndex + 1];
      control.afterEdit?.(Number(call[2]), github);
      done(null);
      return;
    }
    if (isMergeCall(call)) {
      const number = Number(call[2]);
      if (control.mergeOutcome === 'FAIL') {
        done(Object.assign(new Error('fixture merge failed'), { code: 'EIO' }));
        return;
      }
      if (control.mergeOutcome === 'UNKNOWN') {
        done(null);
        return;
      }
      const pr = findOpen(number);
      if (control.mergeOutcome === 'OPEN') {
        if (pr) github.views.set(number, { ...pr, state: 'OPEN', mergedAt: null });
      } else if (pr) {
        const merged = { ...pr, state: 'MERGED', mergedAt: new Date(NOW).toISOString() };
        github.views.set(number, merged);
        github.merged.push({ number, headRefOid: pr.headRefOid, mergedAt: merged.mergedAt });
        github.open = github.open.filter((item) => item.number !== number);
      }
      done(null);
      return;
    }
    done(Object.assign(new Error('unexpected fake gh command: ' + call.join(' ')), { code: 'EIO' }));
  };
  return { github, calls, execFileImpl, openListCount: () => openListCount };
}

async function makeFixture(root, name, pullRequests, sessionIds = (pr) => ['session-' + pr.number], control = {}) {
  const homeDir = path.join(root, name);
  if (!isInside(root, homeDir)) throw new Error('Fixture home escaped its isolated root');
  await fs.mkdir(homeDir);
  const state = await DashboardState.load(homeDir, { now: NOW });
  for (const pr of pullRequests) {
    for (const sessionId of sessionIds(pr)) {
      state.registerPullRequest(sessionId, { url: pr.url }, {
        cwd: path.join(root, 'cwd-' + sessionId),
        product: { key: 'project', name: 'Project' },
      }, NOW);
    }
  }
  const gh = createFakeGh(pullRequests, control);
  const delivery = new DecisionAnswerDelivery({
    state,
    away: { snapshot: () => ({ enabled: false }) },
    maxLongPollMs: 50,
  });
  const tracker = new PullRequestTracker({
    state,
    now: () => NOW,
    execFileImpl: gh.execFileImpl,
    readCrossReviewStateAcrossWorktrees: async (_registration, pr) => control.crossReviews?.get(pr.number) || null,
  });
  const manager = new PullRequestMergeManager({ state, tracker, answerDelivery: delivery, now: () => NOW });
  tracker.onMerged = (event) => manager.handleDetectedMerge(event);
  tracker.onClosed = (event) => manager.handleDetectedClose(event);
  tracker.onRefreshed = (owner, repo) => manager.checkReservations(owner, repo);
  return { state, tracker, manager, delivery, ...gh, control };
}

function registrationInput(fixture, number, changes = {}, sessionId = 'session-' + number) {
  const registration = fixture.state.pullRequestRegistrationForSession(sessionId, 'example', 'project', number);
  return {
    number,
    registration_key: fixture.state.pullRequestRegistrationKey(registration),
    headRefOid: sha(number),
    method: 'squash',
    deleteBranch: false,
    ...changes,
  };
}

async function clean(fixture) {
  fixture.tracker.close();
  fixture.delivery.close();
  await fixture.state.flushPersistence();
}

async function reservationFixture(root, name) {
  const pr = ghPullRequest(1, 'feature/one', 'main');
  const fixture = await makeFixture(root, name, [pr]);
  const reserved = await fixture.manager.reserve(registrationInput(fixture, 1));
  if (!reserved.ok || !reserved.reserved) throw new Error('fixture reservation failed: ' + JSON.stringify(reserved));
  return { fixture, pr };
}

async function httpBoundaryProbe(root) {
  const homeDir = path.join(root, 'http-home');
  const tracker = {
    snapshot: () => [{
      product: { key: 'fixture', name: 'Fixture' },
      owner: 'example',
      repo: 'project',
      trees: [{ number: 164, title: 'Fixture PR', children: [] }],
    }],
    start() {},
    close() {},
  };
  let reserveCalls = 0;
  const manager = {
    reserve: async () => { reserveCalls += 1; return { ok: true, reserved: true }; },
    start() {},
    close() {},
  };
  const runtime = await startServer({
    homeDir,
    claudeHome: path.join(root, 'isolated-claude-home'),
    userHome: path.join(root, 'isolated-user-home'),
    port: 0,
    pullRequestTracker: tracker,
    pullRequestMergeManager: manager,
    codexAgentScriptExists: async () => false,
    crossReviewToolExists: async () => false,
  });
  let result;
  try {
    const stateResponse = await request(runtime.info.port, '/api/state');
    const stateBody = JSON.parse(stateResponse.body);
    const payload = JSON.stringify({
      number: 164,
      registration_key: 'a'.repeat(64),
      headRefOid: sha(1),
      method: 'squash',
      deleteBranch: false,
    });
    const unauthorized = await request(runtime.info.port, '/api/pull-requests/reserve', {
      method: 'POST',
      body: payload,
      headers: { 'content-type': 'application/json' },
    });
    const forbidden = await request(runtime.info.port, '/api/pull-requests/reserve', {
      method: 'POST',
      body: payload,
      headers: {
        'content-type': 'application/json',
        'x-cockpit-secret': runtime.info.uiSecret,
        origin: 'http://evil.invalid',
      },
    });
    const missingOrigin = await request(runtime.info.port, '/api/pull-requests/reserve', {
      method: 'POST',
      body: payload,
      headers: {
        'content-type': 'application/json',
        'x-cockpit-secret': runtime.info.uiSecret,
      },
    });
    const badHost = await request(runtime.info.port, '/api/pull-requests/reserve', {
      method: 'POST',
      body: payload,
      headers: {
        host: 'evil.invalid',
        'content-type': 'application/json',
        'x-cockpit-secret': runtime.info.uiSecret,
        origin: 'http://evil.invalid',
      },
    });
    const crossSite = await request(runtime.info.port, '/api/pull-requests/reserve', {
      method: 'POST',
      body: payload,
      headers: {
        'content-type': 'application/json',
        'x-cockpit-secret': runtime.info.uiSecret,
        origin: 'http://127.0.0.1:' + runtime.info.port,
        'sec-fetch-site': 'cross-site',
      },
    });
    const accepted = await request(runtime.info.port, '/api/pull-requests/reserve', {
      method: 'POST',
      body: payload,
      headers: {
        'content-type': 'application/json',
        'x-cockpit-secret': runtime.info.uiSecret,
        origin: 'http://127.0.0.1:' + runtime.info.port,
      },
    });
    result = {
      stateStatus: stateResponse.status,
      snapshotIncludesFixture: stateBody.pullRequests?.[0]?.trees?.[0]?.number === 164,
      unauthorizedStatus: unauthorized.status,
      forbiddenOriginStatus: forbidden.status,
      missingOriginStatus: missingOrigin.status,
      badHostStatus: badHost.status,
      crossSiteStatus: crossSite.status,
      validWriteStatus: accepted.status,
      validWriteManagerCalls: reserveCalls,
      realGhCalls: 0,
    };
  } finally {
    await runtime.close();
  }
  return { ...result, runtimeClosed: runtime.server.listening === false };
}

async function runProbe({ outDir }) {
  if (typeof outDir !== 'string' || !path.isAbsolute(outDir)) throw new Error('--out must be an absolute path');
  await assertRealDirectoryChain(outDir);
  const root = await fs.mkdtemp(path.join(outDir, 'fixture-'));
  if (!isInside(outDir, root)) throw new Error('fixture path escaped output directory');
  const rootIdentity = await fs.lstat(root);
  const report = {
    schemaVersion: 1,
    evidence: 'fixture-only',
    observedAt: new Date().toISOString(),
    runtime: { node: process.version, platform: process.platform },
    vendorAndGh: {
      claudeCliInvoked: false,
      codexCliInvoked: false,
      realGhInvoked: false,
      nativeRunMetadataObserved: false,
      note: 'All PR and execution provenance labels below are fixture labels; no vendor execution was measured.',
    },
    cases: {},
  };
  try {
    const roles = new Map([
      [1, ['fixture-claude-session', 'fixture-independent-codex-session', 'fixture-child-codex-session']],
    ]);
    const pr = ghPullRequest(1, 'feature/one', 'main');
    const registrations = await makeFixture(root, 'registrations', [pr], (value) => roles.get(value.number));
    const repeated = registrations.state.registerPullRequest('fixture-claude-session', { url: pr.url }, {
      cwd: path.join(root, 'cwd-fixture-claude-session'),
      product: { key: 'project', name: 'Project' },
    }, NOW + 1);
    const records = registrations.state.pullRequestRegistrationsForRepo('example', 'project');
    report.cases.registration = {
      oneRecordPerSameSessionAndPr: Boolean(repeated) && records.length === 3,
      distinctFixtureSessionCount: records.length,
      providerFieldPresent: records.some((record) => Object.hasOwn(record, 'provider')),
      runOrAttemptFieldPresent: records.some((record) => Object.hasOwn(record, 'runId') || Object.hasOwn(record, 'attemptId')),
      nativeVendorIdPresent: records.some((record) => Object.keys(record).some((key) => /native|vendor.*id/i.test(key))),
      verdict: 'same PR can have one record per session; provider, run/attempt, and native vendor origin are not retained',
    };
    await clean(registrations);

    const headMismatch = await makeFixture(root, 'head-mismatch', [pr]);
    const mismatchResult = await headMismatch.manager.merge(registrationInput(headMismatch, 1, { headRefOid: sha(8) }));
    report.cases.displayHeadMismatch = { resultStatus: mismatchResult.status, mergeCalls: headMismatch.calls.filter(isMergeCall).length };
    await clean(headMismatch);

    const baseMismatch = await makeFixture(root, 'base-mismatch', [ghPullRequest(2, 'feature/two', 'release')]);
    const baseResult = await baseMismatch.manager.merge(registrationInput(baseMismatch, 2));
    report.cases.baseMismatch = { resultStatus: baseResult.status, mergeCalls: baseMismatch.calls.filter(isMergeCall).length };
    await clean(baseMismatch);

    const nonBottom = await makeFixture(root, 'non-bottom', [
      ghPullRequest(3, 'feature/parent', 'main'),
      ghPullRequest(4, 'feature/child', 'feature/parent'),
    ]);
    const childResult = await nonBottom.manager.merge(registrationInput(nonBottom, 4));
    report.cases.nonBottomPr = { resultStatus: childResult.status, mergeCalls: nonBottom.calls.filter(isMergeCall).length };
    await clean(nonBottom);

    let latestMutated = false;
    const staleAtFinalFetch = await makeFixture(root, 'head-changed-before-gh', [pr], undefined, {
      beforeOpenList: (count, github) => {
        if (count === 2 && !latestMutated) {
          latestMutated = true;
          github.open[0].headRefOid = sha(5);
        }
      },
    });
    const latestResult = await staleAtFinalFetch.manager.merge(registrationInput(staleAtFinalFetch, 1));
    report.cases.headChangedBeforeGh = {
      resultStatus: latestResult.status,
      mergeCalls: staleAtFinalFetch.calls.filter(isMergeCall).length,
      fakeOpenListCount: staleAtFinalFetch.openListCount(),
      fixtureInputUnchanged: pr.headRefOid === sha(1),
    };
    await clean(staleAtFinalFetch);

    let parentChanged = false;
    const baseChangedDuringRetarget = await makeFixture(root, 'base-changed-during-retarget', [
      ghPullRequest(1, 'feature/one', 'main'),
      ghPullRequest(2, 'feature/two', 'feature/one'),
    ], undefined, {
      afterEdit: (number, github) => {
        if (number === 2 && !parentChanged) {
          parentChanged = true;
          github.open.find((item) => item.number === 1).baseRefName = 'release';
        }
      },
    });
    const retargetResult = await baseChangedDuringRetarget.manager.merge(registrationInput(baseChangedDuringRetarget, 1));
    report.cases.baseChangedAfterChildRetarget = {
      resultStatus: retargetResult.status,
      childEditCalls: baseChangedDuringRetarget.calls.filter((call) => call[1] === 'edit').length,
      mergeCalls: baseChangedDuringRetarget.calls.filter(isMergeCall).length,
    };
    await clean(baseChangedDuringRetarget);

    const staleReservation = await reservationFixture(root, 'stale-convergence');
    staleReservation.fixture.control.crossReviews = new Map([[1, {
      round: 2, reviewedSha: sha(1), dismissed: 0,
      triage: { round: 2, sha: sha(8), outcome: 'converged' },
    }]]);
    staleReservation.fixture.tracker.onRefreshed = null;
    await staleReservation.fixture.tracker.refreshRepo('example', 'project');
    staleReservation.fixture.tracker.onRefreshed = (owner, repo) => staleReservation.fixture.manager.checkReservations(owner, repo);
    await staleReservation.fixture.manager.checkReservations();
    report.cases.staleConvergence = {
      mergeCalls: staleReservation.fixture.calls.filter(isMergeCall).length,
      reservationRetained: Boolean(staleReservation.fixture.state.pullRequestMergeReservation('example', 'project', 1)),
    };
    await clean(staleReservation.fixture);

    const headChangedReservation = await reservationFixture(root, 'reserved-head-changed');
    headChangedReservation.fixture.github.open[0].headRefOid = sha(6);
    headChangedReservation.fixture.control.crossReviews = new Map([[1, {
      round: 2, reviewedSha: sha(1), dismissed: 0,
      triage: { round: 2, sha: sha(1), outcome: 'converged' },
    }]]);
    headChangedReservation.fixture.tracker.onRefreshed = null;
    await headChangedReservation.fixture.tracker.refreshRepo('example', 'project');
    headChangedReservation.fixture.tracker.onRefreshed = (owner, repo) => headChangedReservation.fixture.manager.checkReservations(owner, repo);
    await headChangedReservation.fixture.manager.checkReservations();
    report.cases.reservedHeadChanged = {
      mergeCalls: headChangedReservation.fixture.calls.filter(isMergeCall).length,
      reservationRetained: Boolean(headChangedReservation.fixture.state.pullRequestMergeReservation('example', 'project', 1)),
    };
    await clean(headChangedReservation.fixture);

    const cancelled = await reservationFixture(root, 'reservation-cancelled');
    const cancelResult = await cancelled.fixture.manager.cancelReservation(registrationInput(cancelled.fixture, 1));
    const cancelNotice = cancelled.fixture.delivery.deliverPostToolBatch('session-1') || '';
    report.cases.reservationCancelled = {
      cancelled: cancelResult.cancelled === true,
      mergeCalls: cancelled.fixture.calls.filter(isMergeCall).length,
      noticeDelivered: cancelNotice.includes('予約を取り消しました'),
    };
    await clean(cancelled.fixture);

    const newHead = sha(7);
    const convergedNewHead = await reservationFixture(root, 'new-head-converged');
    convergedNewHead.fixture.github.open[0].headRefOid = newHead;
    convergedNewHead.fixture.control.crossReviews = new Map([[1, {
      round: 3, reviewedSha: newHead, dismissed: 0,
      triage: { round: 3, sha: newHead, outcome: 'converged' },
    }]]);
    convergedNewHead.fixture.tracker.onRefreshed = null;
    await convergedNewHead.fixture.tracker.refreshRepo('example', 'project');
    convergedNewHead.fixture.tracker.onRefreshed = (owner, repo) => convergedNewHead.fixture.manager.checkReservations(owner, repo);
    await convergedNewHead.fixture.manager.checkReservations();
    const newHeadMerge = convergedNewHead.fixture.calls.find(isMergeCall);
    report.cases.currentHeadConverged = {
      mergeCalls: convergedNewHead.fixture.calls.filter(isMergeCall).length,
      matchHeadCommit: newHeadMerge?.[newHeadMerge.indexOf('--match-head-commit') + 1] || null,
      expectedHead: newHead,
    };
    await clean(convergedNewHead.fixture);

    const mergeWithStack = await makeFixture(root, 'squash-with-stack', [
      ghPullRequest(1, 'feature/one', 'main'),
      ghPullRequest(2, 'feature/two', 'feature/one'),
    ], (value) => value.number === 1 ? ['session-1', 'session-ended'] : ['session-2']);
    mergeWithStack.state.endSession('session-ended', NOW);
    const mergedResult = await mergeWithStack.manager.merge(registrationInput(mergeWithStack, 1));
    const parentNotice = mergeWithStack.delivery.deliverPostToolBatch('session-1') || '';
    const childNotice = mergeWithStack.delivery.deliverPostToolBatch('session-2') || '';
    const endedNotice = mergeWithStack.delivery.deliverPostToolBatch('session-ended') || '';
    const mergeEvent = {
      owner: 'example',
      repo: 'project',
      pullRequest: { ...mergeWithStack.github.views.get(1), state: 'open' },
      mergedAt: new Date(NOW).toISOString(),
    };
    const priorCount = mergeWithStack.delivery.sessionNotifications.get('session-1')?.length || 0;
    await mergeWithStack.manager.handleDetectedMerge(mergeEvent);
    report.cases.squashMergeNotice = {
      merged: mergedResult.merged === true,
      mergeCalls: mergeWithStack.calls.filter(isMergeCall).length,
      matchHeadCommit: mergeWithStack.calls.find(isMergeCall)?.at(-1) || null,
      parentNotified: parentNotice.includes('PR #1 が main に入りました'),
      childNotifiedWithRestack: childNotice.includes('git rebase --onto main feature/one'),
      endedSessionAlsoNotified: endedNotice.includes('PR #1 が main に入りました'),
      sameManagerDuplicateSuppressed: (mergeWithStack.delivery.sessionNotifications.get('session-1')?.length || 0) === priorCount,
    };
    await clean(mergeWithStack);

    const rebaseWithStack = await makeFixture(root, 'rebase-with-stack', [
      ghPullRequest(1, 'feature/one', 'main'),
      ghPullRequest(2, 'feature/two', 'feature/one'),
    ]);
    const rebaseResult = await rebaseWithStack.manager.merge(registrationInput(rebaseWithStack, 1, { method: 'rebase' }));
    const rebaseNotice = rebaseWithStack.delivery.deliverPostToolBatch('session-2') || '';
    report.cases.rebaseMergeNotice = {
      merged: rebaseResult.merged === true,
      methodArgument: rebaseWithStack.calls.find(isMergeCall)?.includes('--rebase') === true,
      childNotifiedWithRestack: rebaseNotice.includes('git rebase --onto main feature/one'),
    };
    await clean(rebaseWithStack);

    const mergeCommitWithStack = await makeFixture(root, 'merge-commit-with-stack', [
      ghPullRequest(1, 'feature/one', 'main'),
      ghPullRequest(2, 'feature/two', 'feature/one'),
    ]);
    const mergeCommitResult = await mergeCommitWithStack.manager.merge(registrationInput(mergeCommitWithStack, 1, { method: 'merge' }));
    const mergeCommitNotice = mergeCommitWithStack.delivery.deliverPostToolBatch('session-2') || '';
    report.cases.mergeCommitNotice = {
      merged: mergeCommitResult.merged === true,
      methodArgument: mergeCommitWithStack.calls.find(isMergeCall)?.includes('--merge') === true,
      childNotifiedWithRestack: mergeCommitNotice.includes('git rebase --onto'),
    };
    await clean(mergeCommitWithStack);

    const queue = await makeFixture(root, 'merge-queued', [pr], undefined, { mergeOutcome: 'OPEN' });
    const queueResult = await queue.manager.merge(registrationInput(queue, 1));
    report.cases.ghReportsOpen = {
      status: queueResult.status || null,
      error: queueResult.error || null,
      queued: queueResult.queued === true,
      merged: queueResult.merged === true,
      mergeCalls: queue.calls.filter(isMergeCall).length,
      mergeIntentCleared: queue.state.pullRequestMergeIntent('example', 'project', 1) === null,
      noticeCalls: queue.delivery.sessionNotifications.get('session-1')?.length || 0,
    };
    await clean(queue);

    const unknown = await makeFixture(root, 'merge-state-unknown', [pr], undefined, { mergeOutcome: 'UNKNOWN', failView: true });
    const unknownResult = await unknown.manager.merge(registrationInput(unknown, 1));
    report.cases.ghStateUnknown = {
      status: unknownResult.status,
      error: unknownResult.error || null,
      mergeCalls: unknown.calls.filter(isMergeCall).length,
      mergeIntentRetained: Boolean(unknown.state.pullRequestMergeIntent('example', 'project', 1)),
      noticeCalls: unknown.delivery.sessionNotifications.get('session-1')?.length || 0,
    };
    await clean(unknown);

    const conflictPr = ghPullRequest(9, 'feature/nine', 'main', {
      fields: { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
    });
    const conflict = await makeFixture(root, 'conflict-request', [conflictPr], () => ['session-active', 'session-ended']);
    conflict.state.endSession('session-ended', NOW);
    const conflictRegistration = conflict.state.pullRequestRegistrationForSession('session-active', 'example', 'project', 9);
    const conflictResult = await conflict.manager.requestConflictResolution({
      key: conflict.state.pullRequestRegistrationKey(conflictRegistration),
      headRefOid: sha(9),
    });
    const activeConflictNotice = conflict.delivery.deliverPostToolBatch('session-active') || '';
    const endedConflictNotice = conflict.delivery.deliverPostToolBatch('session-ended') || '';
    report.cases.conflictNotification = {
      requested: conflictResult.ok === true,
      activeSessionNotified: activeConflictNotice.includes('衝突を解消してください'),
      endedSessionNotified: endedConflictNotice.includes('衝突を解消してください'),
      mergeCalls: conflict.calls.filter(isMergeCall).length,
    };
    await clean(conflict);

    const duplicateDelivery = new DecisionAnswerDelivery({
      state: new DashboardState(),
      away: { snapshot: () => ({ enabled: false }) },
      maxLongPollMs: 50,
    });
    duplicateDelivery.notifySessions(['session-duplicate'], 'fixture notice');
    duplicateDelivery.notifySessions(['session-duplicate'], 'fixture notice');
    const duplicateText = duplicateDelivery.deliverPostToolBatch('session-duplicate') || '';
    report.cases.deliveryDeduplication = {
      repeatedCallsCollapsed: duplicateText.split('fixture notice').length - 1 === 1,
      repeatedCallsDelivered: duplicateText.split('fixture notice').length - 1,
    };
    duplicateDelivery.close();

    report.cases.httpBoundary = await httpBoundaryProbe(root);
    report.safety = {
      fixtureRootIsUnderOutput: isInside(outDir, root),
      allFixtureHomesUnderFixtureRoot: true,
      fakeGhInjectedInMergeCases: true,
      realGhInvoked: false,
      usualClaudeHomeRead: false,
      usualCockpitHomeChanged: false,
      existingDaemonStopped: false,
      httpRuntimeClosed: report.cases.httpBoundary.runtimeClosed === true,
      fixtureRootCleaned: false,
    };
  } finally {
    report.safety ||= {};
    report.safety.fixtureRootCleaned = await removeOwnedFixture(root, outDir, rootIdentity);
  }
  const outputFile = path.join(outDir, 'existing-probe-result.json');
  await fs.writeFile(outputFile, JSON.stringify(report, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  return { report, outputFile };
}

async function main(argv) {
  const index = argv.indexOf('--out');
  if (index < 0 || !argv[index + 1]) throw new Error('Usage: node existing-probe.js --out poc/out/poc164-existing-a');
  const outDir = path.resolve(process.cwd(), argv[index + 1]);
  const canonicalOutRoot = path.join(REPO_ROOT, 'poc', 'out');
  if (path.dirname(outDir).toLowerCase() !== canonicalOutRoot.toLowerCase() ||
    !/^poc164-existing-[A-Za-z0-9._-]+$/.test(path.basename(outDir))) {
    throw new Error('Output must be a new poc/out/poc164-existing-* directory');
  }
  await assertRealDirectoryChain(canonicalOutRoot);
  await fs.mkdir(outDir);
  const { report, outputFile } = await runProbe({ outDir });
  process.stdout.write(JSON.stringify({
    outputFile: path.relative(REPO_ROOT, outputFile),
    caseNames: Object.keys(report.cases),
    safety: report.safety,
  }, null, 2) + '\n');
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write('Existing-module probe failed: ' + error.message + '\n');
    process.exitCode = 1;
  });
}

module.exports = { runProbe };
