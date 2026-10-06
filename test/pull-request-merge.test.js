'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DashboardState } = require('../src/server/state');
const { PullRequestMergeManager } = require('../src/server/pull-request-merge');
const { PullRequestTracker } = require('../src/server/pull-requests');
const { DecisionAnswerDelivery } = require('../src/server/decision-answers');
const { temporaryDirectory } = require('./support/temp');
const { ghPullRequest: createGhPullRequest } = require('./support/github');

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const sha = (digit) => String(digit).repeat(40);

function ghPullRequest(number, headRefName, baseRefName, configuration = {}) {
  const options = typeof configuration === 'string' ? { sha: configuration } : configuration;
  return createGhPullRequest(number, headRefName, baseRefName, {
    createdAt: '2026-10-01T00:00:00.000Z',
    ...options,
  });
}

function mergedView(pr, headRefOid = pr.headRefOid, mergedAt = new Date(NOW).toISOString()) {
  return { ...pr, state: 'MERGED', headRefOid, mergedAt };
}

async function mergeFixture(testContext, pullRequests = [ghPullRequest(1, 'feature/one', 'main')]) {
  const temporary = temporaryDirectory(testContext, 'agent-cockpit-pr-merge-', { deferCleanup: true });
  const homeDir = temporary.directory;
  let state;
  let tracker;
  testContext.after(async () => {
    tracker?.close();
    await state?.flushPersistence();
    await temporary.cleanup();
  });
  state = await DashboardState.load(homeDir, { now: NOW });
  for (const pr of pullRequests) state.registerPullRequest(`session-${pr.number}`, { url: pr.url }, {
    product: { key: 'project', name: 'Project' },
  }, NOW);

  const github = { openPullRequests: [...pullRequests], mergedPullRequests: [], views: new Map() };
  const calls = [];
  const notices = [];
  const control = {
    failEditNumber: null,
    failMerge: false,
    failDelete: false,
    deleteStderr: '',
    branchLookup404: false,
    autoDeleteBranch: false,
    failOpenList: false,
    blockAfterEdit: false,
    queueMerge: false,
    failView: false,
    defaultBranch: 'main',
    waitForMerge: null,
    crossReviews: new Map(),
    afterEdit: null,
    crossReviewReader: null,
  };
  const execFileImpl = (_file, args, _options, callback) => {
    calls.push([...args]);
    const finish = (error, output = '', stderr = '') => callback(error, output, stderr);
    if (args[0] === 'pr' && args[1] === 'list') {
      const stateIndex = args.indexOf('--state');
      if (args[stateIndex + 1] === 'open' && control.failOpenList) {
        finish(Object.assign(new Error('list failed'), { code: 'EIO' }));
        return;
      }
      finish(null, JSON.stringify(args[stateIndex + 1] === 'open' ? github.openPullRequests : github.mergedPullRequests));
      return;
    }
    if (args[0] === 'api' && args[1] === 'repos/example/project') {
      finish(null, JSON.stringify({
        default_branch: control.defaultBranch, allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true,
        delete_branch_on_merge: control.autoDeleteBranch,
      }));
      return;
    }
    if (args[0] === 'api' && args[1] === 'repos/example/project/git/ref/heads/feature/one') {
      if (control.branchLookup404) {
        finish(Object.assign(new Error('lookup failed'), { code: 1 }), '', 'gh: Not Found (HTTP 404)');
      } else {
        finish(null, JSON.stringify({ ref: 'refs/heads/feature/one' }));
      }
      return;
    }
    if (args[0] === 'api' && args[1].includes('/compare/')) {
      finish(null, JSON.stringify({ ahead_by: 0, commits: [] }));
      return;
    }
    if (args[0] === 'pr' && args[1] === 'view') {
      if (control.failView) {
        finish(Object.assign(new Error('view failed'), { code: 'EIO' }));
        return;
      }
      const value = github.views.get(Number(args[2]));
      finish(value ? null : Object.assign(new Error('unexpected PR view'), { code: 'EIO' }), value ? JSON.stringify(value) : '');
      return;
    }
    if (args[0] === 'pr' && args[1] === 'edit') {
      if (Number(args[2]) === control.failEditNumber) finish(Object.assign(new Error('edit failed'), { code: 'EIO' }));
      else {
        const number = Number(args[2]);
        const current = github.openPullRequests.find((item) => item.number === number);
        const baseIndex = args.indexOf('--base');
        if (current && baseIndex >= 0) current.baseRefName = args[baseIndex + 1];
        if (control.blockAfterEdit) {
          const parent = github.openPullRequests.find((item) => item.number === 1);
          if (parent) Object.assign(parent, ghPullRequest(1, 'feature/one', 'main', { fields: { reviewDecision: 'CHANGES_REQUESTED' } }));
        }
        control.afterEdit?.(number);
        finish(null);
      }
      return;
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      const number = Number(args[2]);
      const complete = async () => {
        if (control.failMerge) {
          finish(Object.assign(new Error('merge failed'), { code: 'EIO' }));
          return;
        }
        if (control.queueMerge) {
          const current = github.openPullRequests.find((item) => item.number === number);
          if (current) github.views.set(number, { ...current, state: 'OPEN', mergedAt: null });
        } else {
          const current = github.openPullRequests.find((item) => item.number === number);
          if (current) github.views.set(number, mergedView(current));
          github.openPullRequests = github.openPullRequests.filter((item) => item.number !== number);
        }
        finish(null);
      };
      if (control.waitForMerge) void control.waitForMerge().then(complete);
      else void complete();
      return;
    }
    if (args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE') {
      finish(control.failDelete ? Object.assign(new Error('delete failed'), { code: 'EIO' }) : null, '', control.deleteStderr);
      return;
    }
    finish(Object.assign(new Error(`unexpected gh arguments: ${args.join(' ')}`), { code: 'EIO' }));
  };

  tracker = new PullRequestTracker({
    state, now: () => NOW, execFileImpl,
    readCrossReviewStateAcrossWorktrees: async (registration, pullRequest) => control.crossReviewReader
      ? control.crossReviewReader(registration, pullRequest)
      : control.crossReviews.get(pullRequest.number) || null,
  });
  const answerDelivery = {
    notifySessions(sessionIds, message) { notices.push({ sessionIds, message }); },
  };
  const manager = new PullRequestMergeManager({ state, tracker, answerDelivery, now: () => NOW });
  tracker.onMerged = (event) => manager.handleDetectedMerge(event);
  tracker.onClosed = (event) => manager.handleDetectedClose(event);
  tracker.onRefreshed = (owner, repo) => manager.checkReservations(owner, repo);
  return { homeDir, state, github, calls, notices, control, tracker, manager, answerDelivery };
}

function mergeInput(number = 1, changes = {}) {
  return {
    number,
    headRefOid: sha(number),
    method: 'squash',
    deleteBranch: false,
    ...changes,
  };
}

function setCandidateMergeable(tracker) {
  const mergeCandidate = tracker.mergeCandidate.bind(tracker);
  tracker.mergeCandidate = (...args) => {
    const candidate = mergeCandidate(...args);
    if (candidate?.pullRequest) candidate.pullRequest.canMerge = true;
    return candidate;
  };
}

function convergedReview(number, shaValue = sha(number), round = 2) {
  return { round, reviewedSha: shaValue, dismissed: 0, triage: { round, sha: shaValue, outcome: 'converged' } };
}

function reviewWithOutcome(number, outcome) {
  const review = convergedReview(number);
  return { ...review, triage: { ...review.triage, outcome } };
}

async function primeReadyReservation(fixture) {
  fixture.control.crossReviews.set(1, convergedReview(1));
  fixture.github.openPullRequests = fixture.github.openPullRequests.map((pullRequest) => (
    pullRequest.number === 1
      ? ghPullRequest(1, pullRequest.headRefName, pullRequest.baseRefName, { reviewDecision: 'APPROVED' })
      : pullRequest
  ));
  const onRefreshed = fixture.tracker.onRefreshed;
  fixture.tracker.onRefreshed = null;
  try {
    await fixture.tracker.refreshRepo('example', 'project');
  } finally {
    fixture.tracker.onRefreshed = onRefreshed;
  }
}

test('スタック最下段でない PR は状態を取り直して拒否する', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ]);

  const result = await fixture.manager.merge(mergeInput(2));

  assert.equal(result.ok, false);
  assert.match(result.error, /下の #1 のマージ待ち/);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('既定ブランチを base にしない PR は即時マージも予約マージもしない', async (t) => {
  const cases = [
    { baseRefName: 'release', defaultBranch: 'main' },
    { baseRefName: 'main', defaultBranch: 'develop' },
  ];

  for (const scenario of cases) {
    const pullRequest = ghPullRequest(1, 'feature/one', scenario.baseRefName, { reviewDecision: 'APPROVED' });
    const immediate = await mergeFixture(t, [pullRequest]);
    immediate.control.defaultBranch = scenario.defaultBranch;
    setCandidateMergeable(immediate.tracker);
    const result = await immediate.manager.merge(mergeInput(1));
    assert.equal(result.ok, false, `即時マージ: ${scenario.defaultBranch}/${scenario.baseRefName}`);
    assert.match(result.error, /既定ブランチ/);
    assert.equal(immediate.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);

    const reserved = await mergeFixture(t, [pullRequest]);
    reserved.control.defaultBranch = scenario.defaultBranch;
    reserved.control.crossReviews.set(1, convergedReview(1));
    setCandidateMergeable(reserved.tracker);
    const reservation = await reserved.manager.reserve(mergeInput(1));
    assert.equal(reservation.ok, true, `予約: ${scenario.defaultBranch}/${scenario.baseRefName}`);
    assert.ok(reserved.state.pullRequestMergeReservation('example', 'project', 1));
    assert.equal(reserved.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
  }
});

test('表示した head SHA と取り直した SHA が違う PR は拒否する', async (t) => {
  const fixture = await mergeFixture(t);

  const result = await fixture.manager.merge(mergeInput(1, { headRefOid: sha(9) }));

  assert.equal(result.ok, false);
  assert.match(result.error, /head SHA/);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('CI 条件が残っていても表示した head SHA が一致すれば手動マージできる', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' });

  const result = await fixture.manager.merge(mergeInput(1));

  assert.equal(result.ok, true);
  const merge = fixture.calls.find((args) => args[0] === 'pr' && args[1] === 'merge');
  assert.ok(merge);
  assert.equal(merge[merge.indexOf('--match-head-commit') + 1], sha(1));
});

test('fork の head と同名ブランチが登録先にあっても削除要求を 400 で拒む', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/shared', 'main', { fields: { isCrossRepository: true } }),
    ghPullRequest(2, 'feature/shared', 'main'),
  ]);

  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));

  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.error, /fork からの PR/);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
  assert.equal(fixture.calls.some((args) => args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE'), false);
});

test('予約中に外部でマージされた PR は方式不明として記録しブランチを削除しない', async (t) => {
  const pr = ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' });
  const fixture = await mergeFixture(t, [pr]);
  const reserved = await fixture.manager.reserve(mergeInput(1, { deleteBranch: true }));
  assert.equal(reserved.ok, true);
  fixture.github.openPullRequests = [];
  fixture.github.views.set(1, mergedView(pr));

  await fixture.tracker.refreshRepo('example', 'project');

  const history = fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0];
  assert.equal(history.method, null);
  assert.equal(history.automatic, false);
  assert.equal(history.reservedHeadRefOid, null);
  assert.equal(fixture.calls.some((args) => args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE'), false);
  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  assert.match(fixture.notices.at(-1).message, /方式は取得できませんでした/);
});

test('GitHub から新しい状態を取り直せない場合は保存済みの状態でマージしない', async (t) => {
  const fixture = await mergeFixture(t);
  await fixture.tracker.refreshRepo('example', 'project');
  fixture.control.failOpenList = true;

  const result = await fixture.manager.merge(mergeInput(1));

  assert.equal(result.ok, false);
  assert.match(result.error, /状態を取り直せませんでした/);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('即時マージ条件が未達でも方式とブランチ削除の選択を保存して予約できる', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);

  const result = await fixture.manager.reserve(mergeInput(1, { method: 'rebase', deleteBranch: true }));
  const reservation = fixture.state.pullRequestMergeReservation('example', 'project', 1);

  assert.equal(result.ok, true);
  assert.equal(result.reserved, true);
  assert.deepEqual({ method: reservation.method, deleteBranch: reservation.deleteBranch }, { method: 'rebase', deleteBranch: true });
  assert.equal(Object.hasOwn(reservation, 'headRefOid'), false);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
  assert.equal(fixture.calls.some((args) => args.includes('--auto')), false);
});

test('予約中の PR も即時マージでき、成功すると予約が消える', async (t) => {
  const fixture = await mergeFixture(t);
  const reservation = await fixture.manager.reserve(mergeInput(1));

  assert.equal(reservation.reserved, true);
  const result = await fixture.manager.merge(mergeInput(1));

  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  assert.deepEqual(fixture.calls.find((args) => args[0] === 'pr' && args[1] === 'merge'), [
    'pr', 'merge', '1', '-R', 'example/project', '--squash', '--match-head-commit', sha(1),
  ]);
});

test('予約中の PR の即時マージに失敗したら予約を保持する', async (t) => {
  const fixture = await mergeFixture(t);
  const reservation = await fixture.manager.reserve(mergeInput(1));
  fixture.control.failMerge = true;

  const result = await fixture.manager.merge(mergeInput(1));

  assert.equal(reservation.reserved, true);
  assert.equal(result.ok, false);
  assert.match(result.error, /マージできませんでした/);
  assert.deepEqual(fixture.state.pullRequestMergeReservation('example', 'project', 1), reservation.reservation);
});

test('レビュー不要の記録だけでは予約を即時マージしない', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.state.setCrossReviewSkip({
    owner: 'example', repo: 'project', number: 1, headRefOid: sha(1),
    reason: '変更が軽微なため', recordedAt: new Date(NOW).toISOString(),
  });

  const result = await fixture.manager.reserve(mergeInput(1));

  assert.equal(result.ok, true);
  assert.equal(result.reserved, true);
  assert.ok(fixture.state.pullRequestMergeReservation('example', 'project', 1));
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('PR状態の再取得中にwriter期間が終了したらレビューskipを保存しない', async (t) => {
  const fixture = await mergeFixture(t);
  let releaseRefresh;
  let markRefreshStarted;
  const refreshStarted = new Promise((resolve) => { markRefreshStarted = resolve; });
  fixture.tracker.refreshRepoFresh = async () => {
    markRefreshStarted();
    await new Promise((resolve) => { releaseRefresh = resolve; });
    return {};
  };
  fixture.tracker.mergeCandidate = () => ({ pullRequest: { headRefOid: sha(1) } });
  let savedSkipCalls = 0;
  let reviewGroupRefreshCalls = 0;
  const setCrossReviewSkip = fixture.state.setCrossReviewSkip.bind(fixture.state);
  fixture.state.setCrossReviewSkip = (...args) => {
    savedSkipCalls += 1;
    return setCrossReviewSkip(...args);
  };
  fixture.tracker.refreshReviewGroups = async () => { reviewGroupRefreshCalls += 1; };
  let writerAvailable = true;
  let authorizationChecks = 0;
  const operation = fixture.manager.setReviewSkip(
    fixture.state.pullRequestRegistration(1),
    sha(1),
    '変更が軽微なため',
    { authorize: () => { authorizationChecks += 1; return writerAvailable; } },
  );

  await refreshStarted;
  writerAvailable = false;
  releaseRefresh();
  const result = await operation;

  assert.deepEqual(result, { ok: false, status: 403, error: 'Writer unavailable' });
  assert.equal(authorizationChecks, 2);
  assert.equal(savedSkipCalls, 0);
  assert.equal(reviewGroupRefreshCalls, 0);
  assert.equal(fixture.state.crossReviewSkip('example', 'project', 1), null);
});

test('writer認可callbackの例外は秘密値を返さず拒否する', async (t) => {
  const fixture = await mergeFixture(t);
  let refreshCalls = 0;
  let savedSkipCalls = 0;
  const refreshRepoFresh = fixture.tracker.refreshRepoFresh.bind(fixture.tracker);
  const setCrossReviewSkip = fixture.state.setCrossReviewSkip.bind(fixture.state);
  fixture.tracker.refreshRepoFresh = (...args) => {
    refreshCalls += 1;
    return refreshRepoFresh(...args);
  };
  fixture.state.setCrossReviewSkip = (...args) => {
    savedSkipCalls += 1;
    return setCrossReviewSkip(...args);
  };

  const result = await fixture.manager.setReviewSkip(
    fixture.state.pullRequestRegistration(1),
    sha(1),
    '変更が軽微なため',
    { authorize: () => { throw new Error('writer-token-secret'); } },
  );

  assert.deepEqual(result, { ok: false, status: 403, error: 'Writer unavailable' });
  assert.equal(JSON.stringify(result).includes('writer-token-secret'), false);
  assert.equal(refreshCalls, 0);
  assert.equal(savedSkipCalls, 0);
});

test('writer guardを省略したダッシュボード操作はレビューskipを保存する', async (t) => {
  const fixture = await mergeFixture(t);

  const result = await fixture.manager.setReviewSkip(
    fixture.state.pullRequestRegistration(1),
    sha(1),
    '変更が軽微なため',
  );

  assert.equal(result.ok, true);
  assert.equal(result.saved.headRefOid, sha(1));
  assert.equal(fixture.state.crossReviewSkip('example', 'project', 1).reason, '変更が軽微なため');
});

test('条件がそろったレビュー収束後マージ予約はその場で収束 SHA を照合してマージする', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pass', reviewDecision: 'APPROVED' })]);
  const triageSha = sha(1);
  fixture.control.crossReviews.set(1, convergedReview(1, triageSha));

  const result = await fixture.manager.reserve(mergeInput(1));

  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(result.reserved, undefined);
  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  assert.deepEqual(fixture.calls.find((args) => args[0] === 'pr' && args[1] === 'merge'), [
    'pr', 'merge', '1', '-R', 'example/project', '--squash', '--match-head-commit', triageSha,
  ]);
});

test('子 PR の base を付け替え、head SHA を照合してマージし、選択時だけ API でブランチを削除する', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ]);

  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));
  const operations = fixture.calls.filter((args) => args[0] === 'pr' && ['edit', 'merge'].includes(args[1]) || args[0] === 'api' && args[1] === '-X');

  assert.equal(result.ok, true);
  assert.deepEqual(operations, [
    ['pr', 'edit', '2', '-R', 'example/project', '--base', 'main'],
    ['pr', 'merge', '1', '-R', 'example/project', '--squash', '--match-head-commit', sha(1)],
    ['api', '-X', 'DELETE', 'repos/example/project/git/refs/heads/feature/one'],
  ]);
  assert.equal(operations.flat().includes('--delete-branch'), false);
  assert.equal(fixture.state.pullRequestRetargetsForRepo('example', 'project')[0].base, 'main');
  assert.equal(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].method, 'squash');
});

test('既に無いリモートブランチの削除は成功として扱い警告を出さない', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.control.failDelete = true;
  fixture.control.deleteStderr = 'gh: Reference does not exist (HTTP 422)';

  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));

  assert.equal(result.ok, true);
  assert.equal(result.branchDeleted, true);
  assert.equal(result.warning, null);
  assert.equal(fixture.calls.some((args) => args[0] === 'api' && args[1] === 'repos/example/project/git/ref/heads/feature/one'), false);
  assert.doesNotMatch(fixture.notices.at(-1).message, /削除できませんでした/);
});

test('削除 API の別の失敗は ref が残っていれば警告する', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.control.failDelete = true;
  fixture.control.deleteStderr = 'gh: Service Unavailable (HTTP 503)';

  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));

  assert.equal(result.ok, true);
  assert.equal(result.branchDeleted, false);
  assert.match(result.warning, /リモートブランチ feature\/one を削除できませんでした/);
  assert.ok(fixture.calls.some((args) => args[0] === 'api' && args[1] === 'repos/example/project/git/ref/heads/feature/one'));
  assert.match(fixture.notices.at(-1).message, /削除できませんでした/);
});

test('削除 API のエラーが判別できず ref の確認が 404 なら警告を出さない', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.control.failDelete = true;
  fixture.control.deleteStderr = 'gh: API request failed';
  fixture.control.branchLookup404 = true;

  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));

  assert.equal(result.ok, true);
  assert.equal(result.branchDeleted, true);
  assert.equal(result.warning, null);
  assert.doesNotMatch(fixture.notices.at(-1).message, /削除できませんでした/);
});

test('自動削除設定があるリポジトリでは古い画面からの削除指定を実行しない', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.control.autoDeleteBranch = true;

  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));

  assert.equal(result.ok, true);
  assert.equal(result.warning, null);
  assert.equal(fixture.calls.some((args) => args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE'), false);
});

test('自動削除設定があるリポジトリでは古い画面からの予約の削除指定も実行しない', async (t) => {
  const pullRequest = ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' });
  const fixture = await mergeFixture(t, [pullRequest]);
  fixture.control.autoDeleteBranch = true;

  const result = await fixture.manager.reserve(mergeInput(1, { deleteBranch: true }));

  assert.equal(result.ok, true);
  assert.equal(result.reservation.deleteBranch, false);
  fixture.state.setPullRequestMergeReservation({ ...result.reservation, deleteBranch: true });
  fixture.github.openPullRequests = [];
  fixture.github.views.set(1, mergedView(pullRequest));
  await fixture.tracker.refreshRepo('example', 'project');

  assert.equal(fixture.calls.some((args) => args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE'), false);
  assert.doesNotMatch(fixture.notices.at(-1).message, /削除できませんでした/);
});

test('子 PR の base の付け替えに失敗したらマージせず完了位置を返す', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ]);
  fixture.control.failEditNumber = 2;

  const result = await fixture.manager.merge(mergeInput(1));

  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.match(result.error, /#2 の base を main に付け替えられませんでした/);
  assert.match(result.error, /マージはしていません/);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('マージキューに入って OPEN のままなら意図を持たず、後のマージは外でのマージとして方式不明で知らせ、ブランチを消さない', async (t) => {
  const lower = ghPullRequest(1, 'feature/one', 'main');
  const upper = ghPullRequest(2, 'feature/two', 'feature/one');
  const fixture = await mergeFixture(t, [lower, upper]);
  fixture.control.queueMerge = true;

  const queued = await fixture.manager.merge(mergeInput(1, { method: 'squash', deleteBranch: true }));

  assert.equal(queued.ok, true);
  assert.equal(queued.merged, false);
  assert.equal(queued.queued, true);
  assert.match(queued.message, /マージキューに入りました。まだマージされていません/);
  assert.equal(fixture.state.pullRequestMergeIntent('example', 'project', 1), null);
  assert.deepEqual(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW), []);
  assert.equal(fixture.notices.length, 0);

  fixture.github.openPullRequests = fixture.github.openPullRequests.filter((item) => item.number !== 1);
  fixture.github.views.set(1, mergedView(lower));
  await fixture.tracker.refreshRepo('example', 'project');

  assert.equal(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].method, null);
  assert.equal(fixture.calls.some((args) => args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE'), false);
  assert.ok(fixture.notices.some((notice) => /PR #1/.test(notice.message)));
});

test('画面からの予約取消は GitHub を操作せず、保存した予約を消して通知する', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  const reserved = await fixture.manager.reserve(mergeInput(1));
  assert.equal(reserved.ok, true);
  const callCount = fixture.calls.length;

  const result = await fixture.manager.cancelReservation({ number: 1 });

  assert.equal(result.ok, true);
  assert.equal(fixture.calls.length, callCount);
  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  assert.ok(fixture.notices.at(-1).sessionIds.includes('session-1'));
  assert.match(fixture.notices.at(-1).message, /開発者がダッシュボードからマージ予約を取り消した/);
  assert.match(fixture.tracker.snapshot()[0].reservationNotices[0].message, /予約を取り消しました/);
});

test('クローズされた PR の予約を取り消して画面と作成元へ知らせる', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  await fixture.manager.reserve(mergeInput(1));
  fixture.github.openPullRequests = [];
  fixture.github.views.set(1, { ...ghPullRequest(1, 'feature/one', 'main'), state: 'CLOSED', mergedAt: null });

  await fixture.tracker.refreshRepo('example', 'project');

  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  assert.match(fixture.notices.at(-1).message, /PR #1 がクローズされたため/);
  assert.ok(fixture.notices.at(-1).sessionIds.includes('session-1'));
  assert.match(fixture.tracker.snapshot()[0].reservationNotices[0].message, /PR #1 がクローズされたため/);
});

test('最後のクロスレビュー記録が halted なら予約を取り消して画面と作成元へ知らせる', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  await fixture.manager.reserve(mergeInput(1));
  fixture.control.crossReviews.set(1, { round: 2, triage: { round: 2, sha: sha(1), outcome: 'halted' } });

  await fixture.tracker.refreshRepo('example', 'project');

  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  assert.match(fixture.notices.at(-1).message, /クロスレビューが halted/);
  assert.ok(fixture.notices.at(-1).sessionIds.includes('session-1'));
  assert.match(fixture.tracker.snapshot()[0].reservationNotices[0].message, /クロスレビューが halted/);
});

test('子 PR を付け替えた後に新しいマージ理由が出たら再確認して止まる', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ]);
  fixture.control.blockAfterEdit = true;

  const result = await fixture.manager.merge(mergeInput(1));

  assert.equal(result.ok, false);
  assert.match(result.error, /#2 の base は付け替え済み/);
  assert.match(result.error, /変更を求められている/);
  assert.match(result.error, /マージはしていません/);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('base 付け替え後にマージが失敗しても再試行時に開いた子へ積み直しを知らせる', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ]);
  fixture.control.failMerge = true;

  const failed = await fixture.manager.merge(mergeInput(1, { method: 'rebase' }));
  assert.equal(failed.ok, false);
  assert.equal(fixture.github.openPullRequests.find((item) => item.number === 2).baseRefName, 'main');
  fixture.control.failMerge = false;

  const retried = await fixture.manager.merge(mergeInput(1, { method: 'rebase' }));

  assert.equal(retried.ok, true);
  assert.equal(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'edit').length, 1);
  assert.deepEqual(new Set(fixture.notices.at(-1).sessionIds), new Set(['session-1', 'session-2']));
  assert.match(fixture.notices.at(-1).message, /#2 を `git rebase --onto main feature\/one` で積み直して push する/);
});

test('同じ PR のマージ要求を同時に 2 件実行しない', async (t) => {
  const fixture = await mergeFixture(t);
  let release;
  fixture.control.waitForMerge = () => new Promise((resolve) => { release = resolve; });
  const first = fixture.manager.merge(mergeInput());
  while (!release) await new Promise((resolve) => setImmediate(resolve));

  const second = await fixture.manager.merge(mergeInput());
  release();
  const firstResult = await first;

  assert.equal(firstResult.ok, true);
  assert.equal(second.ok, false);
  assert.equal(second.status, 409);
  assert.equal(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').length, 1);
});

test('収束後に push されて head が変わったら一致する収束記録ができるまで待つ', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  await fixture.manager.reserve(mergeInput(1));
  fixture.control.crossReviews.set(1, convergedReview(1));
  fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main', { reviewDecision: 'APPROVED', fields: { headRefOid: sha(9) } });

  await fixture.tracker.refreshRepo('example', 'project');

  assert.ok(fixture.state.pullRequestMergeReservation('example', 'project', 1));
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('CI 成功と収束記録がある予約は次の PR 状態取得で収束 SHA を指定してマージする', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  await fixture.manager.reserve(mergeInput(1));
  fixture.control.crossReviews.set(1, convergedReview(1));
  fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main', { reviewDecision: 'APPROVED' });

  await fixture.tracker.refreshRepo('example', 'project');

  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  assert.deepEqual(fixture.calls.find((args) => args[0] === 'pr' && args[1] === 'merge'), [
    'pr', 'merge', '1', '-R', 'example/project', '--squash', '--match-head-commit', sha(1),
  ]);
  assert.equal(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].automatic, true);
});

test('レビュー承認、CI、ドラフト、コンフリクトが解決するまで予約はマージしない', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  await fixture.manager.reserve(mergeInput(1));
  fixture.control.crossReviews.set(1, convergedReview(1));
  fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main', {
    ci: 'fail', reviewDecision: 'REVIEW_REQUIRED',
    fields: { isDraft: true, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' },
  });

  await fixture.tracker.refreshRepo('example', 'project');

  assert.ok(fixture.state.pullRequestMergeReservation('example', 'project', 1));
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);

  fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main', { reviewDecision: 'APPROVED' });
  await fixture.tracker.refreshRepo('example', 'project');

  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  assert.equal(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').length, 1);
});

test('承認任意の予約は実行し、承認待ちと変更要求中の予約は実行しない', async (t) => {
  for (const scenario of [
    { reviewDecision: '', shouldMerge: true },
    { reviewDecision: 'REVIEW_REQUIRED', shouldMerge: false },
    { reviewDecision: 'CHANGES_REQUESTED', shouldMerge: false },
  ]) {
    const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
    await fixture.manager.reserve(mergeInput(1));
    fixture.control.crossReviews.set(1, convergedReview(1));
    fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main', {
      reviewDecision: scenario.reviewDecision,
    });

    await fixture.tracker.refreshRepo('example', 'project');

    const mergeCalls = fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge');
    assert.equal(mergeCalls.length, scenario.shouldMerge ? 1 : 0, scenario.reviewDecision || '承認任意');
    assert.equal(Boolean(fixture.state.pullRequestMergeReservation('example', 'project', 1)), !scenario.shouldMerge);
  }
});

test('起動後の最初の PR 取得で保存済み予約の条件を満たせばマージする', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  await fixture.manager.reserve(mergeInput(1, { method: 'rebase' }));
  await fixture.state.flushPersistence();
  fixture.control.crossReviews.set(1, convergedReview(1));
  fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main', { reviewDecision: 'APPROVED' });
  const restoredState = await DashboardState.load(fixture.homeDir, { now: NOW });
  const tracker = new PullRequestTracker({
    state: restoredState, now: () => NOW, execFileImpl: fixture.tracker.execFileImpl,
    readCrossReviewStateAcrossWorktrees: async (_registration, pullRequest) => fixture.control.crossReviews.get(pullRequest.number) || null,
  });
  const manager = new PullRequestMergeManager({ state: restoredState, tracker, answerDelivery: fixture.answerDelivery, now: () => NOW });
  tracker.onMerged = (event) => manager.handleDetectedMerge(event);
  tracker.onClosed = (event) => manager.handleDetectedClose(event);
  tracker.onRefreshed = (owner, repo) => manager.checkReservations(owner, repo);

  await tracker.refreshRepo('example', 'project');

  assert.equal(restoredState.pullRequestMergeReservation('example', 'project', 1), null);
  assert.deepEqual(fixture.calls.find((args) => args[0] === 'pr' && args[1] === 'merge'), [
    'pr', 'merge', '1', '-R', 'example/project', '--rebase', '--match-head-commit', sha(1),
  ]);
});

test('予約による自動マージは子 PR を付け替え、選択した head のブランチを削除して知らせる', async (t) => {
  const lower = ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' });
  const upper = ghPullRequest(2, 'feature/two', 'feature/one');
  const fixture = await mergeFixture(t, [lower, upper]);
  const reserved = await fixture.manager.reserve(mergeInput(1, { method: 'squash', deleteBranch: true }));
  fixture.control.crossReviews.set(1, convergedReview(1));
  fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main', { reviewDecision: 'APPROVED' });

  await fixture.tracker.refreshRepo('example', 'project');

  assert.equal(reserved.ok, true);
  assert.equal(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].automatic, true);
  const editIndex = fixture.calls.findIndex((args) => args[0] === 'pr' && args[1] === 'edit');
  const deleteIndex = fixture.calls.findIndex((args) => args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE');
  assert.ok(editIndex >= 0 && deleteIndex > editIndex);
  assert.deepEqual(fixture.calls[editIndex], ['pr', 'edit', '2', '-R', 'example/project', '--base', 'main']);
  assert.deepEqual(fixture.calls.find((args) => args[0] === 'pr' && args[1] === 'merge'), [
    'pr', 'merge', '1', '-R', 'example/project', '--squash', '--match-head-commit', sha(1),
  ]);
  assert.match(fixture.notices.at(-1).message, /#2 を `git rebase --onto main feature\/one` で積み直して push する/);
  assert.deepEqual(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].automaticResult.retargetedNumbers, [2]);
});

test('予約マージは最初の状態取り直しで同じ SHA の fixing への回帰を待つ', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  await fixture.manager.reserve(mergeInput(1));
  await primeReadyReservation(fixture);
  const refreshRepoFresh = fixture.tracker.refreshRepoFresh.bind(fixture.tracker);
  fixture.tracker.refreshRepoFresh = async (...args) => {
    fixture.control.crossReviews.set(1, reviewWithOutcome(1, 'fixing'));
    return refreshRepoFresh(...args);
  };

  await fixture.manager.checkReservations();

  assert.ok(fixture.state.pullRequestMergeReservation('example', 'project', 1));
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('再取得後にクロスレビューが halted になった予約を取り消して知らせる', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  await fixture.manager.reserve(mergeInput(1));
  await primeReadyReservation(fixture);
  const refreshRepoFresh = fixture.tracker.refreshRepoFresh.bind(fixture.tracker);
  fixture.tracker.refreshRepoFresh = async (...args) => {
    fixture.control.crossReviews.set(1, reviewWithOutcome(1, 'halted'));
    return refreshRepoFresh(...args);
  };

  await fixture.manager.checkReservations();

  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  assert.match(fixture.notices.at(-1).message, /クロスレビューが halted/);
  assert.match(fixture.tracker.snapshot()[0].reservationNotices[0].message, /予約を取り消しました/);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('子 PR の付け替え後は同じ SHA の CI 再実行中を待って予約を残す', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' }),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ]);
  await fixture.manager.reserve(mergeInput(1, { deleteBranch: true }));
  await primeReadyReservation(fixture);
  fixture.control.afterEdit = (number) => {
    if (number !== 2) return;
    const parent = fixture.github.openPullRequests.find((pullRequest) => pullRequest.number === 1);
    parent.statusCheckRollup = [{ state: 'IN_PROGRESS', status: 'IN_PROGRESS' }];
  };

  await fixture.manager.checkReservations();

  assert.equal(fixture.github.openPullRequests.find((pullRequest) => pullRequest.number === 2).baseRefName, 'main');
  assert.ok(fixture.state.pullRequestMergeReservation('example', 'project', 1));
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);

  // CI が通った後の再実行でマージしても、前の実行で付け替えた子 PR を結果に含める。
  fixture.control.afterEdit = null;
  fixture.github.openPullRequests.find((pullRequest) => pullRequest.number === 1).statusCheckRollup = [{ state: 'SUCCESS', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  await fixture.tracker.refreshRepo('example', 'project');

  assert.equal(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').length, 1);
  const result = fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].automaticResult;
  assert.deepEqual(result.retargetedNumbers, [2]);
  assert.equal(result.retargetedBase, 'main');
});

test('予約マージがキューに入ったら予約を消し、後のマージを方式不明として扱う', async (t) => {
  const lower = ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' });
  const fixture = await mergeFixture(t, [lower, ghPullRequest(2, 'feature/two', 'feature/one')]);
  const reserved = await fixture.manager.reserve(mergeInput(1, { deleteBranch: true }));
  assert.equal(reserved.ok, true);
  fixture.control.queueMerge = true;
  fixture.control.crossReviews.set(1, convergedReview(1));
  fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main', { reviewDecision: 'APPROVED' });

  await fixture.tracker.refreshRepo('example', 'project');

  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  assert.equal(fixture.state.pullRequestMergeIntent('example', 'project', 1), null);
  assert.equal(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').length, 1);
  assert.match(fixture.tracker.snapshot()[0].reservationNotices[0].message, /マージキューに入りました/);
  const editCount = fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'edit').length;

  await fixture.tracker.refreshRepo('example', 'project');
  assert.equal(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').length, 1);

  fixture.github.openPullRequests = fixture.github.openPullRequests.filter((pullRequest) => pullRequest.number !== 1);
  fixture.github.views.set(1, mergedView(lower));
  await fixture.tracker.refreshRepo('example', 'project');

  const history = fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0];
  assert.equal(history.method, null);
  assert.equal(history.automatic, false);
  assert.equal(Object.hasOwn(history, 'automaticResult'), false);
  assert.equal(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'edit').length, editCount);
  assert.equal(fixture.calls.some((args) => args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE'), false);
});

test('同じ PR の予約チェックが重なってもマージを一度だけ実行する', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  await fixture.manager.reserve(mergeInput(1));
  fixture.control.crossReviews.set(1, convergedReview(1));
  fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main', { reviewDecision: 'APPROVED' });
  let release;
  fixture.control.waitForMerge = () => new Promise((resolve) => { release = resolve; });
  const refresh = fixture.tracker.refreshRepo('example', 'project');
  while (!release) await new Promise((resolve) => setImmediate(resolve));
  const secondCheck = fixture.manager.checkReservations();
  release();
  await Promise.all([refresh, secondCheck]);

  assert.equal(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').length, 1);
  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
});

test('ダッシュボード外でマージされた PR は方式なしで履歴へ記録し、作成元セッションへ知らせる', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main')]);
  const pr = fixture.github.openPullRequests[0];
  fixture.github.openPullRequests = [];
  fixture.github.views.set(1, mergedView(pr));

  await fixture.tracker.refreshRepo('example', 'project');

  assert.deepEqual(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0], {
    owner: 'example', repo: 'project', number: 1, title: 'PR 1', url: pr.url,
    mergedAt: new Date(NOW).toISOString(), method: null, automatic: false,
    reservedHeadRefOid: null, mergedHeadRefOid: sha(1), headMismatch: false,
  });
  assert.equal(fixture.notices[0].sessionIds.includes('session-1'), true);
  assert.match(fixture.notices[0].message, /方式は取得できませんでした/);
});

test('スカッシュまたはリベースで上に積んだ PR の作成元へ積み直しを依頼する', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ]);

  const result = await fixture.manager.merge(mergeInput(1, { method: 'rebase' }));

  assert.equal(result.ok, true);
  const notice = fixture.notices[0];
  assert.deepEqual(new Set(notice.sessionIds), new Set(['session-1', 'session-2']));
  assert.match(notice.message, /PR #1 が main に入りました/);
  assert.match(notice.message, /#2 を `git rebase --onto main feature\/one` で積み直して push する/);
});

test('マージコミットでは上の PR に積み直しを依頼しない', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ]);

  const result = await fixture.manager.merge(mergeInput(1, { method: 'merge' }));

  assert.equal(result.ok, true);
  assert.doesNotMatch(fixture.notices[0].message, /git rebase/);
});

test('マージ履歴、予約、前回方式を保存し、履歴は24時間で消す', async (t) => {
  const homeDir = temporaryDirectory(t, 'agent-cockpit-pr-history-').directory;
  const state = await DashboardState.load(homeDir, { now: NOW });
  const pr = ghPullRequest(7, 'feature/seven', 'main');
  state.registerPullRequest('session-7', { url: pr.url }, { product: { key: 'project', name: 'Project' } }, NOW);
  state.recordMergedPullRequest({
    owner: 'example', repo: 'project', number: 7, title: pr.title, url: pr.url,
    mergedAt: new Date(NOW).toISOString(), method: 'squash', automatic: true,
  }, NOW);
  state.setLastPullRequestMethod('example', 'project', 'squash');
  state.setPullRequestMergeReservation({
    session_id: 'session-7', owner: 'example', repo: 'project', number: 8,
    url: 'https://github.com/example/project/pull/8', method: 'rebase', deleteBranch: false, createdAt: new Date(NOW).toISOString(),
  });
  state.setPullRequestMergeIntent({
    session_id: 'session-9', owner: 'example', repo: 'project', number: 9,
    url: 'https://github.com/example/project/pull/9', headRefOid: sha(9), headRefName: 'feature/nine',
    defaultBranch: 'main', method: 'squash', deleteBranch: true, createdAt: new Date(NOW).toISOString(),
    stackedPullRequests: [],
  });
  await state.flushPersistence();

  const restored = await DashboardState.load(homeDir, { now: NOW + 23 * 60 * 60_000 });
  assert.equal(restored.mergedPullRequestHistoryForRepo('example', 'project', NOW + 23 * 60 * 60_000).length, 1);
  assert.equal(restored.lastPullRequestMethod('example', 'project'), 'squash');
  assert.deepEqual(restored.pullRequestMergeReservation('example', 'project', 8), {
    session_id: 'session-7', owner: 'example', repo: 'project', number: 8,
    url: 'https://github.com/example/project/pull/8', method: 'rebase', deleteBranch: false, createdAt: new Date(NOW).toISOString(),
  });
  assert.equal(restored.pullRequestMergeIntent('example', 'project', 9).deleteBranch, true);
  assert.deepEqual(restored.mergedPullRequestHistoryForRepo('example', 'project', NOW + 24 * 60 * 60_000), []);
  await restored.flushPersistence();
  const saved = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
  assert.deepEqual(saved.mergedPrs, []);
  assert.equal(saved.lastPullRequestMethods['example/project'], 'squash');
  assert.equal(saved.mergeReservations[0].number, 8);
  assert.equal(saved.mergeIntents[0].number, 9);
  assert.equal((await fs.readdir(homeDir)).some((name) => name.startsWith('store.json.broken-')), false);
});

test('古い store にマージ項目が無くても空として読み、退避しない', async (t) => {
  const homeDir = temporaryDirectory(t, 'agent-cockpit-pr-old-store-').directory;
  await fs.writeFile(path.join(homeDir, 'store.json'), JSON.stringify({
    version: 1, display: null, plans: {}, decisionLifecycles: {}, closedTasks: [], hiddenSessions: [],
    prs: [], relatedPrs: [], retargetedPrs: [],
  }));

  const state = await DashboardState.load(homeDir, { now: NOW });

  assert.deepEqual(state.mergedPullRequestHistoryForRepo('example', 'project', NOW), []);
  assert.deepEqual(state.pullRequestMergeReservations(), []);
  assert.equal(state.lastPullRequestMethod('example', 'project'), null);
  assert.equal((await fs.readdir(homeDir)).some((name) => name.startsWith('store.json.broken-')), false);
});

test('旧形式の GitHub 自動マージ予約だけを読み捨てて store を退避しない', async (t) => {
  const homeDir = temporaryDirectory(t, 'agent-cockpit-pr-legacy-reservation-').directory;
  await fs.writeFile(path.join(homeDir, 'store.json'), JSON.stringify({
    version: 1, display: null, plans: {}, decisionLifecycles: {}, closedTasks: [], hiddenSessions: [],
    mergeReservations: [{
      session_id: 'session-1', owner: 'example', repo: 'project', number: 1,
      url: 'https://github.com/example/project/pull/1', headRefOid: sha(1), headRefName: 'feature/one',
      defaultBranch: 'main', method: 'squash', deleteBranch: false,
      createdAt: new Date(NOW).toISOString(), stackedPullRequests: [],
    }],
  }));

  const state = await DashboardState.load(homeDir, { now: NOW });
  await state.flushPersistence();

  assert.deepEqual(state.pullRequestMergeReservations(), []);
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8')).mergeReservations, []);
  assert.equal((await fs.readdir(homeDir)).some((name) => name.startsWith('store.json.broken-')), false);
});

test('古い store の24時間以内の merged PR を方式不明の履歴へ移す', async (t) => {
  const homeDir = temporaryDirectory(t, 'agent-cockpit-pr-old-merged-').directory;
  const source = new DashboardState();
  for (const [number, ageHours] of [[9, 2], [10, 25]]) {
    const pr = ghPullRequest(number, `feature/${number}`, 'main');
    source.registerPullRequest(`session-${number}`, { url: pr.url }, { product: { key: 'project', name: 'Project' } }, NOW);
    source.updatePullRequest(`session-${number}`, 'example', 'project', number, {
      state: 'merged',
      mergedAt: new Date(NOW - ageHours * 60 * 60_000).toISOString(),
      lastOpen: {
        title: pr.title, url: pr.url, headRefName: pr.headRefName, baseRefName: pr.baseRefName, headRefOid: sha(1),
      },
    });
  }
  const legacyStore = source.serializeStore();
  delete legacyStore.mergedPrs;
  await fs.writeFile(path.join(homeDir, 'store.json'), JSON.stringify(legacyStore));

  const restored = await DashboardState.load(homeDir, { now: NOW });
  const history = restored.mergedPullRequestHistoryForRepo('example', 'project', NOW);

  assert.deepEqual(history.map(({ number, method, automatic }) => ({ number, method, automatic })), [
    { number: 9, method: null, automatic: false },
  ]);
  assert.equal(history[0].title, 'PR 9');
  await restored.flushPersistence();
  const saved = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
  assert.equal(saved.mergedPrs[0].number, 9);
  assert.equal((await fs.readdir(homeDir)).some((name) => name.startsWith('store.json.broken-')), false);
});

test('同じセッションに同じ番号の別リポジトリ PR があれば記録キーで特定する', async (t) => {
  const homeDir = temporaryDirectory(t, 'agent-cockpit-pr-key-').directory;
  const state = await DashboardState.load(homeDir, { now: NOW });
  state.registerPullRequest('session-shared', { url: 'https://github.com/example/first/pull/1' }, {}, NOW);
  state.registerPullRequest('session-shared', { url: 'https://github.com/example/second/pull/1' }, {}, NOW + 1);
  const first = state.pullRequestRegistrationsForRepo('example', 'first')[0];
  const second = state.pullRequestRegistrationsForRepo('example', 'second')[0];
  const firstKey = state.pullRequestRegistrationKey(first);
  const secondKey = state.pullRequestRegistrationKey(second);

  assert.equal(state.pullRequestRegistration(1), null);
  assert.notEqual(firstKey, secondKey);
  assert.equal(state.pullRequestRegistration(1, firstKey).repo, 'first');
  assert.equal(state.pullRequestRegistration(1, secondKey).repo, 'second');
  await state.flushPersistence();
});

test('PR 通知は PostToolBatch、UserPromptSubmit、Stop の待機で一度ずつ配信する', async () => {
  const state = new DashboardState();
  const delivery = new DecisionAnswerDelivery({ state, away: { snapshot: () => ({ enabled: false }) }, maxLongPollMs: 500 });

  delivery.notifySessions(['session-batch'], 'PR #1 が main に入りました');
  assert.match(delivery.deliverPostToolBatch('session-batch'), /PR #1 が main に入りました\nこの知らせへの返答と、続けて開発者に見せる文は日本語で書く。/);
  assert.equal(delivery.deliverPostToolBatch('session-batch'), null);

  delivery.notifySessions(['session-prompt'], 'PR #2 が main に入りました');
  assert.match(delivery.deliverPrompt('session-prompt', 'prompt-1'), /PR #2 が main に入りました/);

  const generation = delivery.startStop('session-stop', 'stop-1');
  const waiting = delivery.waitForStopAnswer('session-stop', generation);
  delivery.notifySessions(['session-stop'], 'PR #3 が main に入りました');
  const result = await waiting;
  assert.match(result.stderrText, /PR #3 が main に入りました/);
  assert.equal(result.done, true);
  delivery.close();
});

test('即時のマージでも、選んだ方式を前回の方式として覚える', async (t) => {
  const fixture = await mergeFixture(t);

  const result = await fixture.manager.merge(mergeInput(1, { method: 'rebase' }));

  assert.equal(result.merged, true);
  assert.equal(fixture.state.lastPullRequestMethods.get('example/project'), 'rebase');
});

test('マージの意図を保存し終えてから gh pr merge を呼び、保存に失敗したら呼ばない', async (t) => {
  const fixture = await mergeFixture(t);
  const callCountsAtWrite = [];
  fixture.state.attachWriter({
    write: () => {
      callCountsAtWrite.push(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').length);
      return Promise.resolve();
    },
    flush: () => Promise.resolve(),
  });
  await fixture.manager.merge(mergeInput(1));
  assert.equal(callCountsAtWrite[0], 0);

  const failing = await mergeFixture(t);
  failing.state.attachWriter({ write: () => Promise.reject(new Error('disk full')), flush: () => Promise.resolve() });
  const result = await failing.manager.merge(mergeInput(1));

  assert.equal(result.status, 500);
  assert.equal(failing.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('キューに入れた後に状態を取り直せず意図が残っても、後のマージは方式不明でブランチを消さない', async (t) => {
  const lower = ghPullRequest(1, 'feature/one', 'main');
  const fixture = await mergeFixture(t, [lower]);
  fixture.control.queueMerge = true;
  fixture.control.failView = true;

  const result = await fixture.manager.merge(mergeInput(1, { method: 'squash', deleteBranch: true }));
  assert.equal(result.status, 502);
  assert.ok(fixture.state.pullRequestMergeIntent('example', 'project', 1));

  fixture.control.failView = false;
  fixture.github.openPullRequests = [];
  fixture.github.views.set(1, mergedView(lower));
  await fixture.tracker.refreshRepo('example', 'project');

  assert.equal(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].method, null);
  assert.equal(fixture.calls.some((args) => args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE'), false);
});
