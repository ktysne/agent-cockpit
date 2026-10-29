'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Diagnostics } = require('../src/server/diagnostics');
const { DashboardState } = require('../src/server/state');
const { PullRequestMergeManager } = require('../src/server/pull-request-merge');
const { PullRequestTracker, GH_TIMEOUT_MS } = require('../src/server/pull-requests');
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

async function mergeFixture(testContext, pullRequests = [ghPullRequest(1, 'feature/one', 'main')], options = {}) {
  const temporary = temporaryDirectory(testContext, 'agent-cockpit-pr-merge-', { deferCleanup: true });
  const homeDir = temporary.directory;
  let state;
  let tracker;
  testContext.after(async () => {
    tracker?.close();
    await Promise.all(manager.localUpdates);
    await diagnostics.flush();
    await state?.flushPersistence();
    await temporary.cleanup();
  });
  state = await DashboardState.load(homeDir, { now: NOW, fileSystem: options.fileSystem || fs });
  for (const pr of pullRequests) state.registerPullRequest(`session-${pr.number}`, { url: pr.url }, {
    product: { key: 'project', name: 'Project' },
  }, NOW);

  const github = { openPullRequests: [...pullRequests], mergedPullRequests: [], views: new Map() };
  const calls = [];
  const gitCalls = [];
  const operations = [];
  const notices = [];
  const control = {
    failEditNumber: null,
    failMerge: false,
    deleteStderr: '',
    failGraphqlDelete: false,
    beforeGraphqlDelete: null,
    autoDeleteBranch: false,
    failOpenList: false,
    blockAfterEdit: false,
    queueMerge: false,
    failView: false,
    defaultBranch: 'main',
    allowMerge: true,
    failMergedList: false,
    waitForMerge: null,
    beforeMerge: null,
    crossReviews: new Map(),
    afterEdit: null,
    afterMerge: null,
    remoteBranchHeads: new Map(pullRequests.map((pr) => [pr.headRefName, pr.headRefOid])),
    crossReviewReader: null,
  };
  const execFileImpl = (_file, args, _options, callback) => {
    calls.push([...args]);
    operations.push({ tool: 'gh', args: [...args] });
    const finish = (error, output = '', stderr = '') => callback(error, output, stderr);
    if (args[0] === 'pr' && args[1] === 'list') {
      if (args.includes('--head')) {
        finish(null, JSON.stringify(github.mergedPullRequests.filter(pr => pr.headRefName === args[args.indexOf('--head') + 1]).slice(0, 1)));
        return;
      }
      if (args.includes('merged') && control.failMergedList) {
        finish(Object.assign(new Error('merged list failed'), { code: 'EIO' }));
        return;
      }
      const stateIndex = args.indexOf('--state');
      if (args[stateIndex + 1] === 'open' && control.failOpenList) {
        finish(Object.assign(new Error('private-command private-secret private-output'), { code: 17 }), '', 'private-stderr');
        return;
      }
      finish(null, JSON.stringify(args[stateIndex + 1] === 'open' ? github.openPullRequests : github.mergedPullRequests));
      return;
    }
    if (args[0] === 'api' && args[1] === 'graphql') {
      const query = graphqlVariable(args, 'query') || '';
      if (query.includes('repository(owner: $owner')) {
        finish(null, JSON.stringify({ data: { repository: { id: 'R_kgDOExample' } } }));
        return;
      }
      if (query.includes('updateRefs(input:')) {
        const refName = graphqlVariable(args, 'refName');
        const branch = refName?.startsWith('refs/heads/') ? refName.slice('refs/heads/'.length) : null;
        const beforeOid = graphqlVariable(args, 'beforeOid');
        const afterOid = graphqlVariable(args, 'afterOid');
        control.beforeGraphqlDelete?.(branch, beforeOid);
        if (control.failGraphqlDelete) {
          finish(Object.assign(new Error('ref update failed'), { code: 'EIO' }), '', control.deleteStderr || 'GraphQL ref update failed');
          return;
        }
        if (!branch || afterOid !== '0'.repeat(40) || control.remoteBranchHeads.get(branch) !== beforeOid) {
          finish(Object.assign(new Error('conditional ref update rejected'), { code: 'EIO' }), '', 'GraphQL updateRefs rejected ref change');
          return;
        }
        control.remoteBranchHeads.delete(branch);
        finish(null, JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }));
        return;
      }
    }
    if (args[0] === 'api' && args[1] === 'repos/example/project') {
      finish(null, JSON.stringify({
        default_branch: control.defaultBranch, allow_merge_commit: control.allowMerge, allow_squash_merge: true, allow_rebase_merge: true,
        delete_branch_on_merge: control.autoDeleteBranch,
      }));
      return;
    }
    const branchRefPrefix = 'repos/example/project/git/ref/heads/';
    if (args[0] === 'api' && args[1]?.startsWith(branchRefPrefix)) {
      const branch = args[1].slice(branchRefPrefix.length).split('/').map(decodeURIComponent).join('/');
      const headRefOid = control.remoteBranchHeads.get(branch);
      if (!headRefOid) {
        finish(Object.assign(new Error('lookup failed'), { code: 1 }), '', 'gh: Not Found (HTTP 404)');
      } else {
        finish(null, JSON.stringify({ ref: `refs/heads/${branch}`, object: { sha: headRefOid } }));
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
      control.beforeMerge?.(number);
      const complete = async () => {
        if (control.failMerge) {
          finish(Object.assign(new Error('merge failed'), { code: 1 }));
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
        await control.afterMerge?.();
        finish(control.mergeError || null);
      };
      if (control.waitForMerge) void control.waitForMerge().then(complete);
      else void complete();
      return;
    }
    finish(Object.assign(new Error(`unexpected gh arguments: ${args.join(' ')}`), { code: 'EIO' }));
  };
  const gitExecFileImpl = (_file, args, _options, callback) => {
    gitCalls.push([...args]);
    callback(null, '', '');
  };

  const diagnostics = new Diagnostics({ homeDir, getLevel: () => 'debug' });
  tracker = new PullRequestTracker({
    state, diagnostics, now: options.now || (() => NOW), execFileImpl, gitExecFileImpl,
    readCrossReviewStateAcrossWorktrees: async (registration, pullRequest) => control.crossReviewReader
      ? control.crossReviewReader(registration, pullRequest)
      : control.crossReviews.get(pullRequest.number) || null,
  });
  const answerDelivery = {
    notifySessions(sessionIds, message) { notices.push({ sessionIds, message }); },
  };
  const manager = new PullRequestMergeManager({ state, tracker, answerDelivery, diagnostics, now: () => NOW });
  tracker.onMerged = (event) => manager.handleDetectedMerge(event);
  tracker.onClosed = (event) => manager.handleDetectedClose(event);
  tracker.onRefreshed = (owner, repo) => manager.checkReservations(owner, repo);
  return { homeDir, state, github, calls, gitCalls, operations, notices, control, tracker, manager, answerDelivery, diagnostics, execFileImpl, gitExecFileImpl };
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

function stackInput(fixture, numbers = [1, 2]) {
  return { method: 'merge', deleteBranch: true,
    targetBranch: fixture.github.openPullRequests.find((pullRequest) => pullRequest.number === numbers[0]).baseRefName,
    items: numbers.map((number) => {
    const record = fixture.state.pullRequestRegistrationsForRepo('example', 'project').find((item) => item.number === number);
    return { number, registration_key: fixture.state.pullRequestRegistrationKey(record), headRefOid: sha(number) };
  }) };
}

async function stackFixture(t, options = {}) {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', options), ghPullRequest(2, 'feature/two', 'feature/one')]);
  for (const number of [1, 2]) fixture.control.crossReviews.set(number, convergedReview(number));
  return fixture;
}

// 下から count 件の鎖。converged に挙げた番号だけクロスレビューが収束している。
async function reviewedStackFixture(t, count, converged, overrides = {}) {
  const numbers = Array.from({ length: count }, (_, index) => index + 1);
  const fixture = await mergeFixture(t, numbers.map((number) => ghPullRequest(
    number, `feature/n${number}`, number === 1 ? 'main' : `feature/n${number - 1}`, overrides[number] || {})));
  for (const number of converged) fixture.control.crossReviews.set(number, convergedReview(number));
  await fixture.tracker.refreshRepo('example', 'project');
  return fixture;
}

function stackMergeOf(fixture) {
  return fixture.tracker.snapshot()[0].trees[0].stackMerge;
}

test('一括マージは下から順に保存した SHA を照合してマージコミットで完了する', async (t) => {
  const fixture = await stackFixture(t);
  const result = await fixture.manager.mergeStack(stackInput(fixture));
  assert.equal(result.ok, true);
  const merges = fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge');
  assert.deepEqual(merges.map((args) => [args[2], args[5], args[7]]), [['1', '--merge', sha(1)], ['2', '--merge', sha(2)]]);
  assert.equal(fixture.state.pullRequestMergeReservations().length, 0);
  assert.equal(fixture.state.stackMergeResultsForRepo('example', 'project')[0].message, 'スタックの 2 件を main にマージしました');
});

test('確認後にマージ先が変わると一括マージを予約しない', async (t) => {
  const fixture = await stackFixture(t);
  const input = stackInput(fixture);
  fixture.github.openPullRequests[0].baseRefName = 'release';

  const before = fixture.state.pullRequestMergeReservations();
  const result = await fixture.manager.mergeStack(input);

  assert.equal(result.status, 409);
  assert.equal(result.error, 'マージ先が確認時から変わりました');
  assert.deepEqual(fixture.state.pullRequestMergeReservations(), before);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('base の付け替え中に中止すると進行中の段を止めて全予約を取り消す', async (t) => {
  const fixture = await stackFixture(t);
  const original = fixture.tracker.execFileImpl;
  let releaseEdit;
  let markEditStarted;
  const editStarted = new Promise((resolve) => { markEditStarted = resolve; });
  fixture.tracker.execFileImpl = (file, args, options, callback) => {
    if (args[0] === 'pr' && args[1] === 'edit' && !releaseEdit) {
      releaseEdit = () => original(file, args, options, callback);
      markEditStarted();
      return;
    }
    original(file, args, options, callback);
  };

  const merging = fixture.manager.mergeStack(stackInput(fixture));
  await editStarted;
  const { runId } = fixture.state.pullRequestMergeReservations()[0];
  const cancelling = fixture.manager.cancelStackMerge({ runId });
  assert.equal(fixture.manager.stackMergeCancellationRequests.has(runId), true);

  releaseEdit();
  await Promise.all([merging, cancelling]);

  const message = '中止しました。残りの予約 (#1、#2) を取り消しました';
  assert.deepEqual(fixture.state.pullRequestMergeReservations(), []);
  assert.equal(fixture.state.stackMergeResultsForRepo('example', 'project')[0].message, message);
  assert.equal(fixture.notices.filter((notice) => notice.message === message).length, 1);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('マージ意図の保存中に中止すると gh pr merge を呼ばずに全予約を取り消す', async (t) => {
  const fixture = await stackFixture(t);
  const originalFlush = fixture.state.flushStoreWrite.bind(fixture.state);
  let releaseFlush;
  let markFlushStarted;
  const flushStarted = new Promise((resolve) => { markFlushStarted = resolve; });
  fixture.state.flushStoreWrite = async (...args) => {
    if (!releaseFlush && fixture.state.pullRequestMergeIntent('example', 'project', 1)) {
      await new Promise((resolve) => {
        releaseFlush = resolve;
        markFlushStarted();
      });
    }
    return originalFlush(...args);
  };

  const merging = fixture.manager.mergeStack(stackInput(fixture));
  await flushStarted;
  const { runId } = fixture.state.pullRequestMergeReservations()[0];
  const cancelling = fixture.manager.cancelStackMerge({ runId });
  releaseFlush();
  await Promise.all([merging, cancelling]);

  assert.deepEqual(fixture.state.pullRequestMergeReservations(), []);
  assert.equal(fixture.state.pullRequestMergeIntent('example', 'project', 1), null);
  assert.equal(fixture.state.stackMergeResultsForRepo('example', 'project')[0].message, '中止しました。残りの予約 (#1、#2) を取り消しました');
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('親のマージ後に子の計算中と CI を待ち、一番下になってから続ける', async (t) => {
  const fixture = await stackFixture(t);
  fixture.control.afterMerge = () => {
    const child = fixture.github.openPullRequests.find((pr) => pr.number === 2);
    if (child) Object.assign(child, ghPullRequest(2, 'feature/two', 'main', { ci: 'pending', mergeable: 'UNKNOWN' }));
  };
  await fixture.manager.mergeStack(stackInput(fixture));
  assert.deepEqual(fixture.calls.filter((args) => args[1] === 'merge').map((args) => args[2]), ['1']);
  const snapshot = fixture.tracker.snapshot()[0].trees[0].stackMerge;
  assert.equal(snapshot.targetBranch, 'main');
  assert.equal(snapshot.run.index, 2);
  fixture.control.afterMerge = null;
  Object.assign(fixture.github.openPullRequests[0], ghPullRequest(2, 'feature/two', 'main'));
  await fixture.tracker.refreshRepo('example', 'project');
  assert.deepEqual(fixture.calls.filter((args) => args[1] === 'merge').map((args) => args[2]), ['1', '2']);
});

test('一括マージの確定は head 不一致、鎖の抜け、分岐、予約、中止条件、方式不可を保存前に拒否する', async (t) => {
  for (const condition of ['head', 'chain', 'branch', 'reservation', 'draft', 'method', 'conflict', 'ci']) {
    const fixture = await stackFixture(t, { ci: 'pending' });
    const input = stackInput(fixture);
    if (condition === 'head') input.items[1].headRefOid = sha(9);
    if (condition === 'chain') input.items.reverse();
    if (condition === 'branch') fixture.github.openPullRequests.push(ghPullRequest(3, 'feature/three', 'feature/one'));
    if (condition === 'reservation') await fixture.manager.reserve(mergeInput(2));
    if (condition === 'draft') fixture.github.openPullRequests[1].isDraft = true;
    if (condition === 'method') fixture.control.allowMerge = false;
    if (condition === 'conflict') fixture.github.openPullRequests[1].mergeable = 'CONFLICTING';
    if (condition === 'ci') Object.assign(fixture.github.openPullRequests[1], ghPullRequest(2, 'feature/two', 'feature/one', { ci: 'fail' }));
    const before = fixture.state.pullRequestMergeReservations();
    const result = await fixture.manager.mergeStack(input);
    assert.equal(result.status, 409, condition);
    assert.deepEqual(fixture.state.pullRequestMergeReservations(), before, condition);
  }
});

test('一括マージは子の head 変化、CI 失敗、コンフリクトで残りを取り消して一通だけ通知する', async (t) => {
  for (const condition of ['head', 'ci', 'conflict']) {
    const fixture = await stackFixture(t, { ci: 'pending' });
    await fixture.manager.mergeStack(stackInput(fixture));
    const child = fixture.github.openPullRequests[1];
    if (condition === 'head') { child.headRefOid = sha(9); fixture.control.remoteBranchHeads.set(child.headRefName, sha(9)); }
    if (condition === 'ci') Object.assign(child, ghPullRequest(2, child.headRefName, child.baseRefName, { ci: 'fail' }));
    if (condition === 'conflict') child.mergeable = 'CONFLICTING';
    await fixture.tracker.refreshRepo('example', 'project');
    await fixture.manager.checkReservations();
    assert.equal(fixture.state.pullRequestMergeReservations().length, 0, condition);
    assert.equal(fixture.notices.filter((notice) => notice.message.includes('一括マージを中止')).length, 1, condition);
    assert.equal(fixture.calls.some((args) => args[1] === 'merge'), false, condition);
  }
});

test('一括マージはキュー入りと子の base 付け替え失敗で残りを取り消す', async (t) => {
  for (const condition of ['queue', 'edit', 'gh']) {
    const fixture = await stackFixture(t);
    if (condition === 'queue') fixture.control.queueMerge = true;
    if (condition === 'edit') fixture.control.failEditNumber = 2;
    if (condition === 'gh') fixture.control.failMerge = true;
    await fixture.manager.mergeStack(stackInput(fixture));
    assert.equal(fixture.state.pullRequestMergeReservations().length, 0, condition);
    assert.equal(fixture.notices.filter((notice) => notice.message.includes('一括マージを中止')).length, 1, condition);
  }
});

test('一括マージの構成員が外部でマージされると残りを取り消す', async (t) => {
  const fixture = await stackFixture(t, { ci: 'pending' });
  await fixture.manager.mergeStack(stackInput(fixture));
  const child = fixture.github.openPullRequests.pop();
  fixture.github.views.set(2, mergedView(child));
  fixture.github.mergedPullRequests.push(mergedView(child));
  await fixture.tracker.refreshRepo('example', 'project');
  assert.equal(fixture.state.pullRequestMergeReservations().length, 0);
  assert.equal(fixture.notices.filter((notice) => notice.message.includes('一括マージを中止')).length, 1);
});

test('再起動後も一括予約の SHA と順序を保ち、中止と結果の閉鎖を保存する', async (t) => {
  const fixture = await stackFixture(t, { ci: 'pending' });
  const result = await fixture.manager.mergeStack(stackInput(fixture));
  await fixture.state.flushPersistence();
  const restored = await DashboardState.load(fixture.homeDir, { now: NOW });
  t.after(() => restored.flushPersistence());
  assert.deepEqual(restored.pullRequestMergeReservations(), fixture.state.pullRequestMergeReservations());
  await fixture.manager.cancelStackMerge({ runId: result.runId });
  fixture.state.closeStackMergeResult(result.runId);
  await fixture.state.flushPersistence();
  const closed = await DashboardState.load(fixture.homeDir, { now: NOW });
  assert.deepEqual(closed.stackMergeResultsForRepo('example', 'project'), []);
  assert.equal(closed.stackMergeResults.get(result.runId).closedAt.length > 0, true);
});

test('一括予約を保存した後で登録が消えると実行全体を中止する', async (t) => {
  const fixture = await stackFixture(t, { ci: 'pending' });
  await fixture.manager.mergeStack(stackInput(fixture));
  fixture.state.updatePullRequest('session-2', 'example', 'project', 2, { state: 'unknown' });
  fixture.state.unregisterUnknownPullRequests('example', 'project');
  await fixture.manager.checkReservations();
  assert.equal(fixture.state.pullRequestMergeReservations().length, 0);
  assert.equal(fixture.notices.filter((notice) => notice.message.includes('一括マージを中止')).length, 1);
});

test('一括予約の登録がすべて消えたリポジトリでも定期取得で残りを取り消す', async (t) => {
  const fixture = await stackFixture(t, { ci: 'pending' });
  await fixture.manager.mergeStack(stackInput(fixture));
  for (const number of [1, 2]) fixture.state.updatePullRequest(`session-${number}`, 'example', 'project', number, { state: 'unknown' });
  fixture.state.unregisterUnknownPullRequests('example', 'project');
  await fixture.tracker.refreshAll();
  assert.equal(fixture.state.pullRequestMergeReservations().length, 0);
  assert.equal(fixture.notices.filter((notice) => notice.message.includes('一括マージを中止')).length, 1);
});

test('一括予約中の個別マージは保存した SHA の承認を上書きせず拒否する', async (t) => {
  const fixture = await stackFixture(t, { ci: 'pending' });
  await fixture.manager.mergeStack(stackInput(fixture));
  assert.equal((await fixture.manager.merge(mergeInput(1, { method: 'merge' }))).status, 409);
  assert.equal(fixture.calls.some((args) => args[1] === 'merge'), false);
  assert.equal(fixture.state.pullRequestMergeReservations().length, 2);
});

test('一括予約の構成員が計算中なら通常の早い取得の上限後も再取得を予約する', async (t) => {
  const fixture = await stackFixture(t, { mergeable: 'UNKNOWN' });
  await fixture.manager.mergeStack(stackInput(fixture));
  const scheduled = [];
  fixture.tracker.deferRefresh = (_owner, _repo, delayMs) => scheduled.push(delayMs);
  for (let index = 0; index < 4; index += 1) await fixture.tracker.refreshRepoFresh('example', 'project');
  assert.equal(scheduled.at(-1), 10_000);
  assert.equal(fixture.state.pullRequestMergeReservations().length, 2);
});

test('鎖の 1 件目だけ収束していると一括マージの対象は 1 件で、押せない', async (t) => {
  for (const count of [2, 4]) {
    const stackMerge = stackMergeOf(await reviewedStackFixture(t, count, [1]));
    assert.deepEqual(stackMerge.members.map((member) => member.number), [1], `${count} 件`);
    assert.equal(stackMerge.available, false, `${count} 件`);
    assert.equal(stackMerge.total, count, `${count} 件`);
    assert.deepEqual(stackMerge.stopAt, { number: 2, reason: '#2 はクロスレビュー未実施' }, `${count} 件`);
  }
});

test('鎖の下の 2 件だけ収束していると、下から 2 件が対象になり、対象外の段と理由を持つ', async (t) => {
  const stackMerge = stackMergeOf(await reviewedStackFixture(t, 4, [1, 2]));
  assert.equal(stackMerge.available, true);
  assert.deepEqual(stackMerge.members.map((member) => member.number), [1, 2]);
  assert.equal(stackMerge.total, 4);
  assert.deepEqual(stackMerge.stopAt, { number: 3, reason: '#3 はクロスレビュー未実施' });
  assert.deepEqual(stackMerge.excluded.map(({ number, reason }) => [number, reason]),
    [[3, '#3 はクロスレビュー未実施'], [4, '下の段がマージできないため']]);
});

test('鎖の全件が収束していると、全件が対象で、対象外の段は無い', async (t) => {
  const stackMerge = stackMergeOf(await reviewedStackFixture(t, 3, [1, 2, 3]));
  assert.equal(stackMerge.available, true);
  assert.deepEqual(stackMerge.members.map((member) => member.number), [1, 2, 3]);
  assert.equal(stackMerge.total, 3);
  assert.equal(stackMerge.stopAt, null);
  assert.deepEqual(stackMerge.excluded, []);
});

test('途中の段の CI が失敗していると、その段の手前までが対象になる', async (t) => {
  const stackMerge = stackMergeOf(await reviewedStackFixture(t, 4, [1, 2, 3, 4], { 3: { ci: 'fail' } }));
  assert.deepEqual(stackMerge.members.map((member) => member.number), [1, 2]);
  assert.deepEqual(stackMerge.stopAt, { number: 3, reason: '#3 の CI が失敗' });
});

test('一括マージは鎖の下から続く一部を受け、指定の最上段より上の段をマージも付け替えもしない', async (t) => {
  const fixture = await reviewedStackFixture(t, 4, [1, 2]);
  const result = await fixture.manager.mergeStack(stackInput(fixture, [1, 2]));
  assert.equal(result.ok, true);
  const merges = fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge');
  assert.deepEqual(merges.map((args) => [args[2], args[7]]), [['1', sha(1)], ['2', sha(2)]]);
  const edits = fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'edit').map((args) => args[2]);
  assert.deepEqual(edits, ['2', '3']);
  assert.equal(fixture.state.stackMergeResultsForRepo('example', 'project')[0].message, 'スタックの 2 件を main にマージしました');
});

test('一括マージの予約は、対象に指定した件数を全体の件数として保存する', async (t) => {
  const fixture = await reviewedStackFixture(t, 3, [1, 2], { 1: { ci: 'pending' } });
  await fixture.manager.mergeStack(stackInput(fixture, [1, 2]));
  assert.deepEqual(fixture.state.pullRequestMergeReservations().map((record) => [record.number, record.order, record.total]),
    [[1, 1, 2], [2, 2, 2]]);
});

test('一括マージの確定は、クロスレビューが済んでいない段や、鎖の下から続かない指定を保存前に拒否する', async (t) => {
  for (const [numbers, expected] of [[[1, 2, 3], '#3 はクロスレビュー未実施'], [[2, 3], null], [[1, 3], null]]) {
    const fixture = await reviewedStackFixture(t, 3, [1, 2, 3].filter((number) => number !== 3 || expected === null));
    const result = await fixture.manager.mergeStack(stackInput(fixture, numbers));
    assert.equal(result.status, 409, numbers.join());
    if (expected) assert.equal(result.error, expected);
    assert.deepEqual(fixture.state.pullRequestMergeReservations(), [], numbers.join());
    assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false, numbers.join());
  }
});

test('予約の後にクロスレビューの条件が崩れた段があると、残りの予約をすべて取り消してマージしない', async (t) => {
  for (const broken of [1, 2]) {
    const fixture = await reviewedStackFixture(t, 3, [1, 2, 3], { 1: { ci: 'pending' } });
    await fixture.manager.mergeStack(stackInput(fixture, [1, 2, 3]));
    assert.equal(fixture.state.pullRequestMergeReservations().length, 3, `#${broken}`);
    fixture.control.crossReviews.delete(broken);
    await fixture.tracker.refreshRepo('example', 'project');
    assert.equal(fixture.state.pullRequestMergeReservations().length, 0, `#${broken}`);
    const notice = fixture.notices.find((item) => item.message.includes('一括マージを中止'));
    assert.match(notice.message, new RegExp(`#${broken} の クロスレビューの条件を満たさなくなった`), `#${broken}`);
    assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false, `#${broken}`);
  }
});

test('単独の収束後マージ予約があるスタックは、一括マージの対象にしない', async (t) => {
  const fixture = await reviewedStackFixture(t, 3, [1, 2, 3]);
  await fixture.manager.reserve(mergeInput(3));
  const stackMerge = stackMergeOf(fixture);
  assert.equal(stackMerge.available, false);
  assert.equal(stackMerge.blocker, '#3 は収束後マージを予約中');
});

function holdNextOpenList(fixture) {
  const original = fixture.tracker.execFileImpl;
  let release;
  let listed;
  const started = new Promise((resolve) => { listed = resolve; });
  fixture.tracker.execFileImpl = (file, args, options, callback) => {
    if (args[0] === 'pr' && args[1] === 'list' && args.includes('open') && !release) {
      const stdout = JSON.stringify(fixture.github.openPullRequests);
      release = () => callback(null, stdout, '');
      listed();
    } else original(file, args, options, callback);
  };
  return { started, release: () => release() };
}

async function mergeDuringOpenList(t, pullRequests, beforeList = () => {}) {
  const fixture = await mergeFixture(t, pullRequests);
  let staleList;
  let fetching;
  fixture.control.waitForMerge = async () => {
    beforeList(fixture);
    staleList = holdNextOpenList(fixture);
    fetching = fixture.tracker.refreshRepo('example', 'project');
    await staleList.started;
  };
  const notify = fixture.answerDelivery.notifySessions.bind(fixture.answerDelivery);
  const recorded = new Promise((resolve) => {
    fixture.answerDelivery.notifySessions = (...args) => { notify(...args); resolve(); };
  });
  const merging = fixture.manager.merge(mergeInput());
  await recorded;
  const freshList = holdNextOpenList(fixture);
  staleList.release();
  await fetching;
  return { fixture, merging, freshList };
}

function savedMergeIntent(pr, changes = {}) {
  return {
    session_id: `session-${pr.number}`, owner: 'example', repo: 'project', number: pr.number,
    url: pr.url, headRefOid: pr.headRefOid, headRefName: pr.headRefName, defaultBranch: 'main',
    method: 'squash', deleteBranch: true, automatic: false,
    createdAt: new Date(NOW).toISOString(), stackedPullRequests: [], ...changes,
  };
}

function graphqlVariable(args, name) {
  return args.find((argument) => argument.startsWith(`${name}=`))?.slice(name.length + 1);
}

function usesRawGraphqlVariable(args, name) {
  const index = args.findIndex((argument) => argument.startsWith(`${name}=`));
  return index > 0 && args[index - 1] === '-f';
}

function isBranchDeleteCall(args) {
  return args[0] === 'api' && args[1] === 'graphql' && args.some((argument) => argument.startsWith('refName=refs/heads/'));
}

test('確定操作のブランチ削除は待機中の定期取得より先にghを起動する', async (t) => {
  const { state, tracker, manager } = await mergeFixture(t);
  state.getDisplayPreferences = () => ({ ghConcurrencyLimit: 4 });
  const started = [];
  const running = [];
  const completeNext = (matches, error = null, stdout = '{}', stderr = '') => {
    const index = running.findIndex((entry) => matches(entry.args));
    assert.notEqual(index, -1);
    const [{ callback }] = running.splice(index, 1);
    callback(error, stdout, stderr);
  };
  tracker.execFileImpl = (_file, args, options, callback) => {
    started.push([...args]);
    assert.equal(options.timeout, 20_000);
    running.push({ args: [...args], callback });
    assert.ok(running.length <= 4);
  };
  const background = Array.from({ length: 6 }, (_, index) => tracker.execute(['api', `repos/example/project/${index}`]));
  await new Promise(setImmediate);
  assert.equal(started.length, 4);
  const deletion = manager.deleteRemoteBranch('example', 'project', 'feature/one', sha(1));
  completeNext((args) => args[1] === 'repos/example/project/0');
  await new Promise(setImmediate);
  assert.deepEqual(started[4], ['api', 'repos/example/project/git/ref/heads/feature/one']);
  completeNext((args) => args[1] === started[4][1], null, JSON.stringify({ object: { sha: sha(1) } }));
  await new Promise(setImmediate);
  assert.deepEqual(started[5], ['api', 'repos/example/project/4']);
  completeNext((args) => args[1] === 'repos/example/project/1');
  await new Promise(setImmediate);
  assert.equal(started[6][1], 'graphql');
  assert.ok(started[6].some((argument) => argument.includes('repository(owner: $owner')));
  completeNext((args) => args[1] === 'graphql' && args.some((argument) => argument.includes('repository(owner: $owner')),
    null, JSON.stringify({ data: { repository: { id: 'R_kgDOExample' } } }));
  await new Promise(setImmediate);
  assert.deepEqual(started[7], ['api', 'repos/example/project/5']);
  completeNext((args) => args[1] === 'repos/example/project/2');
  await new Promise(setImmediate);
  assert.equal(started[8][1], 'graphql');
  assert.ok(started[8].some((argument) => argument.includes('updateRefs(input:')));
  completeNext(isBranchDeleteCall, null, JSON.stringify({ data: { updateRefs: { clientMutationId: null } } }));
  await new Promise(setImmediate);
  while (running.length) {
    const pending = running.shift();
    pending.callback(null, '{}');
    await new Promise(setImmediate);
  }
  await Promise.all([...background, deletion]);
  assert.deepEqual(started.slice(5).map(args => args[1]), [
    'repos/example/project/4', 'graphql', 'repos/example/project/5', 'graphql',
  ]);
});

for (const automatic of [false, true]) {
  test(`集約ブランチへの${automatic ? '予約' : '即時'}マージは子の base を集約先に付け替える`, async (t) => {
    const fixture = await mergeFixture(t, [
      ghPullRequest(1, 'feature/one', 'feature/aggregate'), ghPullRequest(2, 'feature/two', 'feature/one'),
    ]);
    if (automatic) fixture.control.crossReviews.set(1, convergedReview(1));
    const result = await fixture.manager[automatic ? 'reserve' : 'merge'](mergeInput(1, { method: 'merge', deleteBranch: true }));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.merged, true);
    assert.equal(fixture.github.openPullRequests[0].baseRefName, 'feature/aggregate');
    assert.ok(fixture.calls.some(args => args[0] === 'pr' && args[1] === 'edit' && args.at(-1) === 'feature/aggregate'));
    assert.ok(fixture.calls.some(args => args[0] === 'pr' && args[1] === 'merge' && args.includes('--merge')));
    assert.deepEqual(fixture.state.pullRequestRetargetsForRepo('example', 'project')[0], {
      owner: 'example', repo: 'project', number: 2, base: 'feature/aggregate', fromNumber: 1,
      previousBaseRefName: 'feature/one', completed: true,
    });
    if (automatic) assert.equal(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].automaticResult.retargetedBase, 'feature/aggregate');
  });

  test(`同期 PR の${automatic ? '予約' : '即時'}マージは main を削除せず他の PR を付け替えない`, async (t) => {
    const fixture = await mergeFixture(t, [
      ghPullRequest(1, 'main', 'feature/aggregate'), ghPullRequest(2, 'feature/two', 'main'),
    ]);
    if (automatic) fixture.control.crossReviews.set(1, convergedReview(1));
    const result = await fixture.manager[automatic ? 'reserve' : 'merge'](mergeInput(1, { method: 'merge', deleteBranch: true }));
    assert.equal(result.ok, true, result.error);
    assert.equal(result.branchDeleted, false);
    assert.equal(fixture.github.openPullRequests[0].baseRefName, 'main');
    assert.equal(fixture.calls.some(args => args[0] === 'pr' && args[1] === 'edit' || args.includes('DELETE')), false);
    assert.equal(fixture.tracker.snapshot()[0].trees[0].mergeTarget, 'main');
    assert.equal(fixture.tracker.snapshot()[0].trees[0].canMerge, true);
    assert.doesNotMatch(fixture.notices.map(notice => notice.message).join('\n'), /main は残したので/);
  });
}

test('集約ブランチと同期 PR への squash と rebase は即時マージも予約も拒否する', async (t) => {
  for (const head of ['feature/one', 'main']) {
    for (const method of ['squash', 'rebase']) {
      const fixture = await mergeFixture(t, [ghPullRequest(1, head, 'feature/aggregate')]);
      for (const operation of ['merge', 'reserve']) {
        const result = await fixture.manager[operation](mergeInput(1, { method }));
        assert.equal(result.ok, false);
        assert.match(result.error, /マージコミットに固定/);
      }
      assert.equal(fixture.calls.some(args => args[0] === 'pr' && args[1] === 'merge'), false);
    }
  }
});

test('予約後に base を集約先へ変えると merge の予約でもマージしない', async (t) => {
  const fixture = await mergeFixture(t);
  assert.equal((await fixture.manager.reserve(mergeInput(1, { method: 'merge' }))).reserved, true);
  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1).targetBranch, 'main');
  fixture.github.openPullRequests[0].baseRefName = 'feature/aggregate';
  fixture.control.crossReviews.set(1, convergedReview(1));
  await fixture.tracker.refreshRepo('example', 'project');
  assert.ok(fixture.state.pullRequestMergeReservation('example', 'project', 1));
  assert.equal(fixture.calls.some(args => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('マージ済み一覧の取得に失敗すると集約ブランチへの操作を拒否する', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'feature/aggregate')]);
  fixture.control.failMergedList = true;
  const result = await fixture.manager.merge(mergeInput(1, { method: 'merge' }));
  assert.equal(result.ok, false);
  assert.match(result.error, /一覧を取得できません/);
  assert.equal(fixture.tracker.snapshot()[0].trees[0].mergeTarget, 'feature/aggregate');
});

test('登録詳細の取得に失敗すると他の PR も集約ブランチへマージできない', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'feature/aggregate'), ghPullRequest(2, 'feature/two', 'main')]);
  fixture.github.openPullRequests.pop();
  const result = await fixture.manager.merge(mergeInput(1, { method: 'merge' }));
  assert.equal(result.ok, false);
  assert.equal(fixture.tracker.snapshot()[0].trees[0].mergeTarget, null);
  assert.match(fixture.tracker.snapshot()[0].trees[0].blocker, /どの PR の head でもないことを確認できない/);
});

test('マージコミットが禁止なら集約ブランチ向け PR は画面でも操作でもマージできない', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'feature/aggregate')]);
  fixture.control.allowMerge = false;
  const result = await fixture.manager.merge(mergeInput(1, { method: 'merge' }));
  assert.equal(result.ok, false);
  assert.equal(fixture.tracker.snapshot()[0].trees[0].canMerge, false);
  assert.match(fixture.tracker.snapshot()[0].trees[0].blocker, /マージコミットが必要だが、このリポジトリでは許可されていない/);
});

test('同期 PR の外部マージ検出でも main 向け PR を子として通知しない', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'main', 'feature/aggregate'), ghPullRequest(2, 'feature/two', 'main')]);
  await fixture.tracker.refreshRepo('example', 'project');
  const pr = fixture.github.openPullRequests.shift();
  fixture.github.views.set(1, mergedView(pr));
  await fixture.tracker.refreshRepo('example', 'project');
  assert.equal(fixture.calls.some(args => args[0] === 'pr' && args[1] === 'edit' || args.includes('DELETE')), false);
  assert.doesNotMatch(fixture.notices[0].message, /#2|main は残したので/);
  assert.equal(fixture.tracker.snapshot()[0].trees[0].mergeTarget, 'main');
});

test('集約先を持つマージ意図を保存して復元し後続の完了結果に使う', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'feature/aggregate')]);
  const intent = { session_id: 'session-1', owner: 'example', repo: 'project', number: 1,
    url: fixture.github.openPullRequests[0].url, headRefOid: sha(1), headRefName: 'feature/one',
    defaultBranch: 'main', targetBranch: 'feature/aggregate', method: 'merge', deleteBranch: false,
    automatic: true, createdAt: new Date(NOW).toISOString(), stackedPullRequests: [{ number: 2, baseRefName: 'feature/one' }] };
  assert.equal(fixture.state.setPullRequestMergeIntent(intent), true);
  await fixture.state.flushPersistence();
  const restored = await DashboardState.load(fixture.homeDir, { now: NOW });
  assert.equal(restored.pullRequestMergeIntent('example', 'project', 1).targetBranch, 'feature/aggregate');
  await fixture.manager.handleDetectedMerge({ owner: 'example', repo: 'project',
    pullRequest: fixture.github.openPullRequests[0], mergedAt: new Date(NOW).toISOString(),
    confirmedIntent: { ...intent, retargetedNumbers: [2] } });
  assert.equal(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].automaticResult.retargetedBase, 'feature/aggregate');
});

for (const scenario of [
  { name: '削除オフ', deleteBranch: false, autoDeleteBranch: false, fork: false, kept: true },
  { name: '自動削除', deleteBranch: false, autoDeleteBranch: true, fork: false, kept: false },
  { name: 'fork と自動削除', deleteBranch: false, autoDeleteBranch: true, fork: true, kept: true },
  { name: '削除オン', deleteBranch: true, autoDeleteBranch: false, fork: false, kept: false },
]) {
  for (const reserved of [false, true]) {
    test(`${scenario.name} の${reserved ? '予約' : '即時'}マージは削除の選択に従って子の base と通知を決める`, async (t) => {
      const fixture = await mergeFixture(t, [
        ghPullRequest(1, 'feature/one', 'main', { fields: { isCrossRepository: scenario.fork } }),
        ghPullRequest(2, 'feature/two', 'feature/one'),
      ]);
      fixture.control.autoDeleteBranch = scenario.autoDeleteBranch;
      const input = mergeInput(1, { deleteBranch: scenario.deleteBranch });
      const result = reserved ? await fixture.manager.reserve(input) : await fixture.manager.merge(input);
      assert.equal(result.ok, true);
      if (reserved) {
        await primeReadyReservation(fixture);
        fixture.github.openPullRequests.find((item) => item.number === 1).isCrossRepository = scenario.fork;
        await fixture.manager.checkReservations();
      }
      const child = fixture.github.openPullRequests.find((item) => item.number === 2);
      assert.equal(child.baseRefName, scenario.kept ? 'feature/one' : 'main');
      assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'edit'), !scenario.kept);
      const history = fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0];
      assert.equal(fixture.state.pullRequestRegistrationForSession('session-1', 'example', 'project', 1).mergedHead.branchKept, scenario.kept ? true : undefined);
      if (reserved) {
        assert.equal(history.automaticResult.retargetedBase, scenario.kept ? null : 'main');
        assert.deepEqual(history.automaticResult.retargetedNumbers, scenario.kept ? [] : [2]);
      }
      const notice = fixture.notices.at(-1).message;
      if (scenario.kept) {
        assert.doesNotMatch(notice, /git rebase --onto/);
        if (!scenario.fork) assert.match(notice, /feature\/one は残したので、#2 の base は feature\/one のまま/);
        assert.match(notice, /マージコミットを推奨/);
      } else {
        assert.match(notice, /git rebase --onto main feature\/one/);
      }
    });
  }
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

function findPullRequestInTrees(trees, number) {
  for (const tree of trees) {
    if (tree.number === number) return tree;
    const nested = findPullRequestInTrees(tree.children, number);
    if (nested) return nested;
  }
  return null;
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

test('既定ブランチ以外への squash は即時マージも予約も拒否する', async (t) => {
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
    assert.match(result.error, /マージコミットに固定/);
    assert.equal(immediate.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);

    const reserved = await mergeFixture(t, [pullRequest]);
    reserved.control.defaultBranch = scenario.defaultBranch;
    reserved.control.crossReviews.set(1, convergedReview(1));
    setCandidateMergeable(reserved.tracker);
    const reservation = await reserved.manager.reserve(mergeInput(1));
    assert.equal(reservation.ok, false, `予約: ${scenario.defaultBranch}/${scenario.baseRefName}`);
    assert.match(reservation.error, /マージコミットに固定/);
    assert.equal(reserved.state.pullRequestMergeReservation('example', 'project', 1), null);
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
  const operations = fixture.calls.filter((args) => args[0] === 'pr' && ['edit', 'merge'].includes(args[1]));

  assert.equal(result.ok, true);
  assert.equal(result.branchDeleted, true);
  assert.deepEqual(operations, [
    ['pr', 'edit', '2', '-R', 'example/project', '--base', 'main'],
    ['pr', 'merge', '1', '-R', 'example/project', '--squash', '--match-head-commit', sha(1)],
  ]);
  const deleteCall = fixture.calls.find(isBranchDeleteCall);
  assert.equal(graphqlVariable(deleteCall, 'refName'), 'refs/heads/feature/one');
  assert.equal(graphqlVariable(deleteCall, 'beforeOid'), sha(1));
  assert.equal(graphqlVariable(deleteCall, 'afterOid'), '0'.repeat(40));
  assert.equal(['repositoryId', 'refName', 'beforeOid', 'afterOid'].every((name) => usesRawGraphqlVariable(deleteCall, name)), true);
  assert.equal(fixture.gitCalls.some((args) => args.includes('push')), false);
  assert.equal(fixture.control.remoteBranchHeads.has('feature/one'), false);
  assert.equal(operations.flat().includes('--delete-branch'), false);
  assert.equal(fixture.state.pullRequestRetargetsForRepo('example', 'project')[0].base, 'main');
  assert.equal(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].method, 'squash');
});

test('マージ後に別のコミットへ進んだリモートブランチを削除せず理由を返す', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.control.afterMerge = () => fixture.control.remoteBranchHeads.set('feature/one', sha(2));

  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));

  assert.equal(result.ok, true);
  assert.equal(result.branchDeleted, false);
  assert.match(result.warning, /head が更新されたため.*削除しませんでした/);
  assert.equal(fixture.control.remoteBranchHeads.get('feature/one'), sha(2));
  assert.equal(fixture.calls.some(isBranchDeleteCall), false);
});

test('既に無いリモートブランチの削除は成功として扱い警告を出さない', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.control.afterMerge = () => fixture.control.remoteBranchHeads.delete('feature/one');

  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));

  assert.equal(result.ok, true);
  assert.equal(result.branchDeleted, true);
  assert.equal(result.warning, null);
  assert.equal(fixture.calls.some(isBranchDeleteCall), false);
  assert.doesNotMatch(fixture.notices.at(-1).message, /既にありません/);
});

test('条件付き削除に失敗し ref が変わらなければ警告する', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.control.failGraphqlDelete = true;
  fixture.control.deleteStderr = 'remote: Service Unavailable';

  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));

  assert.equal(result.ok, true);
  assert.equal(result.branchDeleted, false);
  assert.match(result.warning, /リモートブランチ feature\/one を削除できませんでした/);
  assert.ok(fixture.calls.some((args) => args[0] === 'api' && args[1] === 'repos/example/project/git/ref/heads/feature/one'));
  assert.match(fixture.notices.at(-1).message, /削除できませんでした/);
});

test('削除との競合で ref が進んだ場合は新しい head を残して理由を記録する', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.control.beforeGraphqlDelete = () => fixture.control.remoteBranchHeads.set('feature/one', sha(2));

  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));

  assert.equal(result.ok, true);
  assert.equal(result.branchDeleted, false);
  assert.match(result.warning, /head が更新されたため.*削除しませんでした/);
  assert.equal(fixture.control.remoteBranchHeads.get('feature/one'), sha(2));
  const deleteCall = fixture.calls.find(isBranchDeleteCall);
  assert.equal(graphqlVariable(deleteCall, 'refName'), 'refs/heads/feature/one');
  assert.equal(graphqlVariable(deleteCall, 'beforeOid'), sha(1));
  assert.equal(graphqlVariable(deleteCall, 'afterOid'), '0'.repeat(40));
  assert.equal(fixture.gitCalls.some((args) => args.includes('push')), false);
  assert.match(fixture.notices.at(-1).message, /head が更新されたため.*削除しませんでした/);
});

test('予約マージの削除競合は履歴にも見送り理由を保存する', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.control.crossReviews.set(1, convergedReview(1));
  fixture.control.afterMerge = () => fixture.control.remoteBranchHeads.set('feature/one', sha(2));

  const result = await fixture.manager.reserve(mergeInput(1, { deleteBranch: true }));
  const history = fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0];

  assert.equal(result.ok, true);
  assert.equal(result.merged, true);
  assert.equal(history.automaticResult.branchDeleted, false);
  assert.match(history.automaticResult.warning, /head が更新されたため.*削除しませんでした/);
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

test('付け替え失敗後にブランチを残してマージすると子の base を保持したことを知らせる', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ]);
  fixture.control.failEditNumber = 2;

  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));

  assert.equal(result.ok, false);
  assert.equal(result.status, 502);
  assert.match(result.error, /#2 の base を main に付け替えられませんでした/);
  assert.match(result.error, /マージはしていません/);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
  assert.equal(fixture.state.pullRequestRetargetsForRepo('example', 'project')[0].completed, false);
  await fixture.tracker.refreshRepo('example', 'project');
  const child = findPullRequestInTrees(fixture.tracker.snapshot()[0].trees, 2);
  assert.equal(child.effectiveBase, 'feature/one');
  assert.equal(child.retargetedFrom, null);
  assert.equal(child.parentNumber, 1);
  assert.equal(child.blocker, '親 PR #1 のマージ確認待ち');
  const retried = await fixture.manager.merge(mergeInput(1, { deleteBranch: false }));
  assert.equal(retried.ok, true);
  assert.equal(fixture.github.openPullRequests.find(item => item.number === 2).baseRefName, 'feature/one');
  assert.match(fixture.notices.at(-1).message, /base は feature\/one のままです/);
  assert.doesNotMatch(fixture.notices.at(-1).message, /git rebase --onto/);
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

for (const outcome of ['halted', 'fixing', 'converged']) {
  test(`記録が競合する ${outcome} の予約はマージも取り消しもしない`, async (t) => {
    const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
    await fixture.manager.reserve(mergeInput(1));
    fixture.control.crossReviews.set(1, { round: 2, triage: { round: 2, sha: sha(1), outcome }, conflict: [
      { worktree: '/old', round: 1, sha: sha(1), outcome: 'converged' },
      { worktree: '/current', round: 2, sha: sha(1), outcome: 'halted' },
    ] });
    fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main');
    await fixture.tracker.refreshRepo('example', 'project');
    await fixture.manager.checkReservations();
    assert.ok(fixture.state.pullRequestMergeReservation('example', 'project', 1));
    assert.equal(fixture.calls.some(args => args[0] === 'pr' && args[1] === 'merge'), false);
    assert.equal(fixture.notices.some(notice => /予約を取り消し/.test(notice.message)), false);
    assert.equal([...fixture.manager.diagnosticReservationConditions.values()].includes('review-conflict'), true);
  });
}

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

  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));

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

  const failed = await fixture.manager.merge(mergeInput(1, { method: 'rebase', deleteBranch: true }));
  assert.equal(failed.ok, false);
  assert.equal(fixture.github.openPullRequests.find((item) => item.number === 2).baseRefName, 'main');
  fixture.control.failMerge = false;

  const retried = await fixture.manager.merge(mergeInput(1, { method: 'rebase', deleteBranch: true }));

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

  const second = fixture.manager.merge(mergeInput());
  await new Promise(setImmediate);
  assert.equal(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').length, 1);
  release();
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert.equal(firstResult.ok, true);
  assert.equal(secondResult.ok, false);
  assert.equal(secondResult.status, 409);
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
  const editIndex = fixture.operations.findIndex((operation) => operation.tool === 'gh' && operation.args[0] === 'pr' && operation.args[1] === 'edit');
  const deleteIndex = fixture.operations.findIndex((operation) => isBranchDeleteCall(operation.args));
  assert.ok(editIndex >= 0 && deleteIndex > editIndex);
  assert.deepEqual(fixture.operations[editIndex].args, ['pr', 'edit', '2', '-R', 'example/project', '--base', 'main']);
  assert.equal(graphqlVariable(fixture.operations[deleteIndex].args, 'refName'), 'refs/heads/feature/one');
  assert.equal(graphqlVariable(fixture.operations[deleteIndex].args, 'beforeOid'), sha(1));
  assert.equal(graphqlVariable(fixture.operations[deleteIndex].args, 'afterOid'), '0'.repeat(40));
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

test('予約確認中の手動 merge と reserve は同じ順序の repo lock で完了する', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' }),
    ghPullRequest(2, 'feature/two', 'main'),
    ghPullRequest(3, 'feature/three', 'main'),
  ]);
  await fixture.manager.reserve(mergeInput(1, { deleteBranch: false }));
  fixture.control.crossReviews.set(1, convergedReview(1));
  fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main', { reviewDecision: 'APPROVED' });

  let startMerge;
  const mergeStarted = new Promise((resolve) => { startMerge = resolve; });
  let releaseMerge;
  const mergeGate = new Promise((resolve) => { releaseMerge = resolve; });
  const mergeNumbers = [];
  fixture.control.beforeMerge = (number) => {
    mergeNumbers.push(number);
    if (number === 1) startMerge();
  };
  fixture.control.waitForMerge = () => mergeNumbers.at(-1) === 1 ? mergeGate : Promise.resolve();

  const reservationCheck = fixture.tracker.refreshRepo('example', 'project');
  await mergeStarted;

  let manualMergeFinished = false;
  let manualReserveFinished = false;
  const manualMerge = fixture.manager.merge(mergeInput(2, { deleteBranch: false }))
    .then((result) => { manualMergeFinished = true; return result; });
  const manualReserve = fixture.manager.reserve(mergeInput(3, { deleteBranch: false }))
    .then((result) => { manualReserveFinished = true; return result; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(manualMergeFinished, false);
  assert.equal(manualReserveFinished, false);
  assert.deepEqual(mergeNumbers, [1]);

  releaseMerge();
  const [_, mergeResult, reserveResult] = await Promise.all([reservationCheck, manualMerge, manualReserve]);
  assert.equal(mergeResult.ok, true);
  assert.equal(mergeResult.merged, true);
  assert.equal(reserveResult.ok, true);
  assert.equal(reserveResult.reserved, true);
  assert.deepEqual(mergeNumbers, [1, 2]);

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fixture.manager.repositoryInFlight.size, 0);
  assert.equal(fixture.manager.repositoryLockWaiters.size, 0);
  assert.equal(fixture.manager.pendingRepositoryReservationChecks.size, 0);
  assert.equal(fixture.manager.inFlight.size, 0);
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
    reservedHeadRefOid: null, mergedHeadRefOid: sha(1), headMismatch: false, providers: ['claude'],
  });
  assert.equal(fixture.notices[0].sessionIds.includes('session-1'), true);
  assert.match(fixture.notices[0].message, /方式は取得できませんでした/);
});

test('processMergedPullRequest は push 後の最終 head を確定済みとして保存する', async (t) => {
  const fixture = await mergeFixture(t);
  const previousHead = 'a'.repeat(40);
  const mergedHead = 'b'.repeat(40);
  const previousPullRequest = ghPullRequest(1, 'feature/one', 'main', previousHead);
  fixture.state.updatePullRequest('session-1', 'example', 'project', 1, {
    state: 'open',
    lastOpen: {
      title: previousPullRequest.title,
      url: previousPullRequest.url,
      headRefName: previousPullRequest.headRefName,
      baseRefName: previousPullRequest.baseRefName,
      headRefOid: previousHead,
    },
  });

  await fixture.manager.processMergedPullRequest(
    'example', 'project', ghPullRequest(1, 'feature/one', 'main', mergedHead), new Date(NOW).toISOString(),
  );

  const record = fixture.state.pullRequestRegistrationForSession('session-1', 'example', 'project', 1);
  assert.equal(record.lastOpen.headRefOid, previousHead);
  assert.deepEqual(record.mergedHead, {
    headRefOid: mergedHead,
    headRefName: 'feature/one',
    baseRefName: 'main',
  });
});

test('スカッシュまたはリベースで上に積んだ PR の作成元へ積み直しを依頼する', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ]);

  const result = await fixture.manager.merge(mergeInput(1, { method: 'rebase', deleteBranch: true }));

  assert.equal(result.ok, true);
  const notice = fixture.notices[0];
  assert.deepEqual(new Set(notice.sessionIds), new Set(['session-1', 'session-2']));
  assert.match(notice.message, /PR #1 が main に入りました/);
  assert.match(notice.message, /#2 を `git rebase --onto main feature\/one` で積み直して push する/);
});

test('集約ブランチにマージされた PR はそのブランチを通知と積み直しに使う', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'codex/feature'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ]);
  const pr = fixture.github.openPullRequests[0];

  await fixture.manager.handleDetectedMerge({
    owner: 'example',
    repo: 'project',
    pullRequest: pr,
    mergedAt: new Date(NOW).toISOString(),
    confirmedIntent: { method: 'squash' },
    stackedPullRequests: [{ number: 2, baseRefName: 'feature/one' }],
  });

  assert.match(fixture.notices[0].message, /PR #1 が codex\/feature に入りました/);
  assert.match(fixture.notices[0].message, /#2 を `git rebase --onto codex\/feature feature\/one` で積み直して push する/);
});

test('ブランチを残しても前の実行で付け替えた子には積み直しを依頼する', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'main'),
    ghPullRequest(3, 'feature/three', 'feature/one'),
  ]);
  const pr = fixture.github.openPullRequests[0];

  await fixture.manager.handleDetectedMerge({
    owner: 'example',
    repo: 'project',
    pullRequest: pr,
    mergedAt: new Date(NOW).toISOString(),
    confirmedIntent: {
      method: 'squash', deleteBranch: false, headRefOid: pr.headRefOid, retargetedNumbers: [2],
      stackedPullRequests: [{ number: 2, baseRefName: 'feature/one' }, { number: 3, baseRefName: 'feature/one' }],
    },
  });

  const notice = fixture.notices[0].message;
  assert.match(notice, /#2 を `git rebase --onto main feature\/one` で積み直して push する/);
  assert.doesNotMatch(notice, /#2 の base は feature\/one のまま/);
  assert.match(notice, /#3 の base は feature\/one のまま/);
  assert.doesNotMatch(notice, /#3 を `git rebase/);
  assert.equal(fixture.state.pullRequestRegistrationForSession('session-1', 'example', 'project', 1).mergedHead?.branchKept, true);
});

test('マージ直後に確かめられず後から検出しても、同じ head の保存済み意図から残す選択を戻す', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ]);
  const pr = fixture.github.openPullRequests[0];
  fixture.state.setPullRequestMergeIntent({
    session_id: 'session-1', owner: 'example', repo: 'project', number: 1,
    url: 'https://github.com/example/project/pull/1', headRefOid: pr.headRefOid, headRefName: 'feature/one',
    defaultBranch: 'main', method: 'squash', deleteBranch: false, automatic: false,
    createdAt: new Date(NOW).toISOString(), stackedPullRequests: [{ number: 2, baseRefName: 'feature/one' }],
  });

  await fixture.manager.handleDetectedMerge({
    owner: 'example',
    repo: 'project',
    pullRequest: pr,
    mergedAt: new Date(NOW).toISOString(),
    stackedPullRequests: [{ number: 2, baseRefName: 'feature/one' }],
  });

  assert.equal(fixture.state.pullRequestRegistrationForSession('session-1', 'example', 'project', 1).mergedHead?.branchKept, true);
  assert.doesNotMatch(fixture.notices[0].message, /git rebase/);
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

test('PR 通知はフックの受領 ACK まで保留し、ACK 後に取り除く', async () => {
  const state = new DashboardState();
  const delivery = new DecisionAnswerDelivery({ state, away: { snapshot: () => ({ enabled: false }) }, maxLongPollMs: 500 });

  delivery.notifySessions(['session-batch'], 'PR #1 が main に入りました');
  const batchText = delivery.deliverPostToolBatch('session-batch');
  assert.match(batchText, /PR #1 が main に入りました\nこの知らせへの返答と、続けて開発者に見せる文は日本語で書く。/);
  assert.equal(delivery.deliverPostToolBatch('session-batch'), batchText);
  const batchRecord = delivery.recordHookDelivery({
    sessionId: 'session-batch', action: 'post-tool-batch', requestId: 'batch-1',
    response: { hookOutput: { hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext: batchText } } },
  });
  assert.equal(delivery.acknowledgeHookDelivery('session-batch', batchRecord.deliveryId), true);
  assert.equal(delivery.deliverPostToolBatch('session-batch'), null);

  delivery.notifySessions(['session-prompt'], 'PR #2 が main に入りました');
  const promptText = delivery.deliverPrompt('session-prompt', 'prompt-1');
  assert.match(promptText, /PR #2 が main に入りました/);
  assert.match(delivery.deliverPrompt('session-prompt', 'prompt-1'), /PR #2 が main に入りました/);
  const promptRecord = delivery.recordHookDelivery({
    sessionId: 'session-prompt', action: 'user-prompt-submit', requestId: 'prompt-1',
    response: { hookOutput: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: promptText } } },
  });
  assert.equal(delivery.acknowledgeHookDelivery('session-prompt', promptRecord.deliveryId), true);
  assert.equal(delivery.deliverSessionNotifications('session-prompt'), null);

  const generation = await delivery.startStop('session-stop', 'stop-1');
  const waiting = delivery.waitForStopAnswer('session-stop', generation);
  delivery.notifySessions(['session-stop'], 'PR #3 が main に入りました');
  const result = await waiting;
  assert.match(result.stderrText, /PR #3 が main に入りました/);
  assert.equal(result.done, true);
  const stopRecord = delivery.recordHookDelivery({
    sessionId: 'session-stop', action: 'stop-poll', requestId: 'stop-1', generation, response: result,
  });
  assert.equal(delivery.acknowledgeHookDelivery('session-stop', stopRecord.deliveryId), true);
  assert.equal(delivery.deliverSessionNotifications('session-stop'), null);
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

test('状態を取り直せず意図が残ったときは後のマージで方式と削除を復元する', async (t) => {
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

  assert.equal(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].method, 'squash');
  assert.equal(fixture.calls.some(isBranchDeleteCall), true);
});

test('親のマージで base が付け替わっても予約の最終マージ先が同じなら実行する', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'feature/aggregate'), ghPullRequest(2, 'feature/two', 'feature/one')]);
  const reserved = await fixture.manager.reserve(mergeInput(2, { method: 'merge' }));
  assert.equal(reserved.reservation.targetBranch, 'feature/aggregate');
  assert.equal(fixture.tracker.snapshot()[0].reservations[0].targetBranch, 'feature/aggregate');
  assert.equal(fixture.tracker.snapshot()[0].trees[0].children[0].reservation.targetBranch, 'feature/aggregate');
  await fixture.state.flushPersistence();
  const restored = await DashboardState.load(fixture.homeDir, { now: NOW });
  assert.equal(restored.pullRequestMergeReservation('example', 'project', 2).targetBranch, 'feature/aggregate');
  fixture.control.crossReviews.set(2, convergedReview(2));
  assert.equal((await fixture.manager.merge(mergeInput(1, { method: 'merge', deleteBranch: true }))).merged, true);
  await fixture.tracker.refreshRepo('example', 'project');
  assert.ok(fixture.calls.some(args => args[0] === 'pr' && args[1] === 'merge' && args[2] === '2'));
  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 2), null);
});

test('親が未マージなら複数の子予約は失敗・消失後も手動・自動マージを待つ', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
    ghPullRequest(3, 'feature/three', 'feature/one'),
  ]);
  await fixture.manager.reserve(mergeInput(2, { method: 'merge' }));
  await fixture.manager.reserve(mergeInput(3, { method: 'merge' }));
  fixture.control.crossReviews.set(2, convergedReview(2));
  fixture.control.crossReviews.set(3, convergedReview(3));
  fixture.control.failMerge = true;

  const parentResult = await fixture.manager.merge(mergeInput(1, { method: 'merge', deleteBranch: true }));
  assert.equal(parentResult.status, 502);
  await fixture.manager.checkReservations('example', 'project');
  const snapshot = fixture.tracker.snapshot()[0];
  for (const number of [2, 3]) {
    const child = findPullRequestInTrees(snapshot.trees, number);
    assert.equal(child.canMerge, false);
    assert.equal(child.blocker, '親 PR #1 のマージ確認待ち');
    assert.ok(fixture.state.pullRequestMergeReservation('example', 'project', number));
    const manualResult = await fixture.manager.merge(mergeInput(number, { method: 'merge' }));
    assert.match(manualResult.error, /親 PR #1 のマージ確認待ち/);
  }
  assert.deepEqual(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').map((args) => args[2]), ['1']);
  assert.deepEqual(fixture.state.pullRequestRetargetsForRepo('example', 'project').map(({ number, fromNumber }) => ({ number, fromNumber })), [
    { number: 2, fromNumber: 1 },
    { number: 3, fromNumber: 1 },
  ]);

  fixture.github.openPullRequests = fixture.github.openPullRequests.filter((pullRequest) => pullRequest.number !== 1);
  await fixture.tracker.refreshRepo('example', 'project');
  await fixture.manager.checkReservations('example', 'project');
  for (const number of [2, 3]) {
    const child = findPullRequestInTrees(fixture.tracker.snapshot()[0].trees, number);
    assert.equal(child.canMerge, false);
    assert.equal(child.blocker, '親 PR #1 のマージ確認待ち');
  }
  assert.deepEqual(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').map((args) => args[2]), ['1']);
});

test('親マージの確認後に予約子を順に再評価してからマージする', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
    ghPullRequest(3, 'feature/three', 'feature/one'),
  ]);
  await fixture.manager.reserve(mergeInput(2, { method: 'merge' }));
  await fixture.manager.reserve(mergeInput(3, { method: 'merge' }));
  fixture.control.crossReviews.set(2, convergedReview(2));
  fixture.control.crossReviews.set(3, convergedReview(3));
  fixture.control.beforeMerge = (number) => {
    if (number > 1) assert.equal(fixture.github.views.get(1)?.state, 'MERGED');
  };

  const parentResult = await fixture.manager.merge(mergeInput(1, { method: 'merge', deleteBranch: true }));
  assert.equal(parentResult.merged, true);
  await fixture.manager.checkReservations('example', 'project');
  await new Promise(setImmediate);

  assert.deepEqual(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').map((args) => args[2]), ['1', '2', '3']);
  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 2), null);
  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 3), null);
});

test('親子の base 変更を保存できない場合は GitHub を変更しない', async (t) => {
  let failRetargetSave = false;
  const fileSystem = new Proxy(fs, {
    get(target, property) {
      if (property === 'rename') return async (from, to) => {
        if (failRetargetSave && path.basename(String(to)) === 'store.json') {
          const value = JSON.parse(await target.readFile(from, 'utf8'));
          if (value.retargetedPrs?.some((record) => record.number === 2 && record.fromNumber === 1)) {
            throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
          }
        }
        return target.rename(from, to);
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ], { fileSystem });
  failRetargetSave = true;

  const result = await fixture.manager.merge(mergeInput(1, { method: 'merge', deleteBranch: true }));

  failRetargetSave = false;
  assert.equal(result.status, 500);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'edit'), false);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
  await fixture.state.flushPersistence();
});

test('永続化した親待ちは再起動後も子のマージを止める', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ]);
  await fixture.manager.reserve(mergeInput(2, { method: 'merge' }));
  fixture.control.crossReviews.set(2, convergedReview(2));
  fixture.control.failMerge = true;
  await fixture.manager.merge(mergeInput(1, { method: 'merge', deleteBranch: true }));
  await fixture.manager.checkReservations('example', 'project');
  await fixture.state.flushPersistence();
  fixture.tracker.close();

  const state = await DashboardState.load(fixture.homeDir, { now: NOW });
  const tracker = new PullRequestTracker({
    state,
    diagnostics: fixture.diagnostics,
    now: () => NOW,
    execFileImpl: fixture.execFileImpl,
    gitExecFileImpl: fixture.gitExecFileImpl,
    readCrossReviewStateAcrossWorktrees: async (_registration, pullRequest) => fixture.control.crossReviews.get(pullRequest.number) || null,
  });
  const manager = new PullRequestMergeManager({ state, tracker, answerDelivery: fixture.answerDelivery, diagnostics: fixture.diagnostics, now: () => NOW });
  tracker.onRefreshed = (owner, repo) => manager.checkReservations(owner, repo);
  t.after(async () => {
    tracker.close();
    await state.flushPersistence();
  });
  await tracker.refreshRepo('example', 'project');
  await new Promise(setImmediate);

  const registration = state.pullRequestRegistrationsForRepo('example', 'project').find((record) => record.number === 2);
  const candidate = tracker.mergeCandidate(registration);
  assert.equal(candidate.pullRequest.canMerge, false);
  assert.equal(candidate.pullRequest.blocker, '親 PR #1 のマージ確認待ち');
  assert.ok(state.pullRequestMergeReservation('example', 'project', 2));
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge' && args[2] === '2'), false);
});

test('同じリポジトリの別 PR は進行中のマージと並行して開始しない', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main'),
    ghPullRequest(2, 'feature/two', 'main'),
  ]);
  const mergeNumbers = [];
  fixture.control.beforeMerge = (number) => mergeNumbers.push(number);
  let finishMerge;
  fixture.control.waitForMerge = () => new Promise((resolve) => { finishMerge = resolve; });
  const firstMerge = fixture.manager.merge(mergeInput(1, { method: 'merge' }));
  for (let attempt = 0; attempt < 100 && !fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'); attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(finishMerge);

  let secondFinished = false;
  const secondMerge = fixture.manager.merge(mergeInput(2, { method: 'merge' }))
    .then((result) => { secondFinished = true; return result; });
  await new Promise(setImmediate);
  assert.equal(secondFinished, false);
  assert.deepEqual(mergeNumbers, [1]);
  assert.equal(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').length, 1);

  fixture.control.waitForMerge = null;
  finishMerge();
  const [firstResult, secondResult] = await Promise.all([firstMerge, secondMerge]);
  assert.equal(firstResult.merged, true);
  assert.equal(secondResult.merged, true);
  assert.deepEqual(mergeNumbers, [1, 2]);
});

test('予約の状態取得が失敗しても即時再試行ループを作らない', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main')]);
  await fixture.manager.reserve(mergeInput(1, { method: 'merge' }));
  fixture.control.crossReviews.set(1, convergedReview(1));
  fixture.control.failMerge = true;

  const onRefreshed = fixture.tracker.onRefreshed;
  fixture.tracker.onRefreshed = null;
  try {
    await fixture.tracker.refreshRepo('example', 'project');
  } finally {
    fixture.tracker.onRefreshed = onRefreshed;
  }
  await fixture.manager.checkReservations('example', 'project');
  await new Promise(setImmediate);

  assert.equal(fixture.calls.filter((args) => args[0] === 'pr' && args[1] === 'merge').length, 1);
  assert.ok(fixture.state.pullRequestMergeReservation('example', 'project', 1));
});

test('マージ先の無い古い予約は既定ブランチ向けとして実行する', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.state.setPullRequestMergeReservation({
    session_id: 'session-1', owner: 'example', repo: 'project', number: 1,
    url: 'https://github.com/example/project/pull/1', method: 'merge', deleteBranch: false, createdAt: new Date(NOW).toISOString(),
  });
  await fixture.state.flushPersistence();
  const restored = await DashboardState.load(fixture.homeDir, { now: NOW });
  assert.ok(restored.pullRequestMergeReservation('example', 'project', 1));
  fixture.control.crossReviews.set(1, convergedReview(1));
  await fixture.tracker.refreshRepo('example', 'project');
  assert.ok(fixture.calls.some(args => args[0] === 'pr' && args[1] === 'merge'));
});

test('gh の連続失敗は操作と回数を残し、コマンド行と標準エラーを残さない', async t => {
  const fixture = await mergeFixture(t);
  fixture.control.failOpenList = true;
  for (let i = 0; i < 2; i++) await fixture.tracker.refreshRepo('example', 'project');
  fixture.control.failOpenList = false;
  await fixture.tracker.refreshRepo('example', 'project');
  fixture.control.failOpenList = true;
  await fixture.tracker.refreshRepo('example', 'project');
  await fixture.diagnostics.flush();
  const runEntries = await fixture.diagnostics.readRun(fixture.diagnostics.run);
  const entries = runEntries.filter(entry => entry.msg === 'gh.failed');
  assert.deepEqual(entries.map(entry => entry.data.consecutive), [1, 2]);
  assert.ok(entries.every(entry => entry.data.operation === 'pr.list' && entry.data.repository === 'example/project'));
  assert.ok(entries.every(entry => entry.data.exitCode === 17 && entry.data.failure === 'exit'));
  assert.ok(runEntries.some(entry => entry.msg === 'diagnostics.repeated'
    && entry.data.msg === 'gh.failed' && entry.data.count === 1));
  assert.doesNotMatch(JSON.stringify(runEntries), /private|stderr|message|stack|--json/);
});

test('マージ予約と head の照合と未成立の条件は本文を残さない', async t => {
  const fixture = await mergeFixture(t);
  await fixture.manager.reserve(mergeInput(1));
  await fixture.manager.merge(mergeInput(1, { headRefOid: sha(9) }));
  const entries = await fixture.diagnostics.readRun(fixture.diagnostics.run);
  assert.ok(entries.some(entry => entry.msg === 'merge.reserved'));
  assert.ok(entries.some(entry => entry.msg === 'merge.check' && entry.data.head === 'mismatch'));
  assert.ok(entries.some(entry => entry.msg === 'merge.check' && entry.data.condition === 'review-not-converged'));
  assert.doesNotMatch(JSON.stringify(entries), /表示していた|Project|feature\/one|session-1/);
});

test('マージの gh 失敗と成功は結果分類と PR 番号を残す', async t => {
  const fixture = await mergeFixture(t);
  fixture.control.failMerge = true;
  await fixture.manager.merge(mergeInput(1));
  fixture.control.failMerge = false;
  await fixture.manager.merge(mergeInput(1));
  const entries = (await fixture.diagnostics.readRun(fixture.diagnostics.run)).filter(entry => entry.msg === 'merge.result');
  assert.deepEqual(entries.map(entry => entry.data.result), ['gh-exit', 'gh-success', 'merged']);
  assert.ok(entries.every(entry => entry.data.number === 1));
  assert.doesNotMatch(JSON.stringify(entries), /merge failed|message|stderr|--match-head-commit/);
});

test('halted の後に次の往復が始まった PR の予約は取り消さず待つ', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  await fixture.manager.reserve(mergeInput(1));
  fixture.control.crossReviews.set(1, { round: 3, triage: { round: 2, sha: sha(1), outcome: 'halted' } });
  await fixture.tracker.refreshRepo('example', 'project');
  assert.ok(fixture.state.pullRequestMergeReservation('example', 'project', 1));
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
  assert.deepEqual(fixture.tracker.snapshot()[0].reservationNotices, []);
});

test('gh が SIGTERM で止まっても次の取得で保存した方式と削除を使う', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main'), ghPullRequest(2, 'feature/two', 'feature/one')]);
  fixture.control.mergeError = Object.assign(new Error('terminated'), { code: null, killed: true, signal: 'SIGTERM' });
  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));
  assert.equal(result.error, 'マージの結果を確認できませんでした。次の取得で確かめます');
  assert.ok(fixture.state.pullRequestMergeIntent('example', 'project', 1));
  const results = (await fixture.diagnostics.readRun(fixture.diagnostics.run)).filter((entry) => entry.msg === 'merge.result');
  assert.equal(results[0].data.result, 'merge-unconfirmed');
  await fixture.tracker.refreshRepo('example', 'project');
  assert.equal(fixture.state.pullRequestMergeIntent('example', 'project', 1), null);
  assert.equal(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].method, 'squash');
  assert.ok(fixture.calls.some(isBranchDeleteCall));
  assert.match(fixture.notices[0].message, /git rebase --onto main feature\/one/);
});

test('gh の数値終了コードと起動失敗だけが意図を消してマージ失敗を返す', async (t) => {
  for (const error of [Object.assign(new Error('exit'), { code: 1 }),
    Object.assign(new Error('spawn'), { code: 'EPERM', syscall: 'spawn gh' })]) {
    const fixture = await mergeFixture(t);
    const original = fixture.tracker.execFileImpl;
    fixture.tracker.execFileImpl = (file, args, options, callback) => args[1] === 'merge'
      ? callback(error) : original(file, args, options, callback);
    const result = await fixture.manager.merge(mergeInput());
    assert.match(result.error, /マージできませんでした/);
    assert.equal(fixture.state.pullRequestMergeIntent('example', 'project', 1), null);
  }
});

test('停止や出力超過など結果を確定できない例外では意図を残す', async (t) => {
  for (const details of [{ code: 1, signal: 'SIGINT' }, { code: 'ETIMEDOUT' },
    { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }, {}]) {
    const fixture = await mergeFixture(t);
    fixture.control.mergeError = Object.assign(new Error('unknown'), details);
    const result = await fixture.manager.merge(mergeInput());
    assert.equal(result.error, 'マージの結果を確認できませんでした。次の取得で確かめます');
    assert.ok(fixture.state.pullRequestMergeIntent('example', 'project', 1));
  }
});

test('マージ実行中の取得は登録と通知を変えず実行側が方式と削除を確定する', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.control.afterMerge = async () => {
    await fixture.tracker.refreshRepo('example', 'project');
    assert.notEqual(fixture.state.pullRequestRegistrationForSession('session-1', 'example', 'project', 1).state, 'merged');
    assert.equal(fixture.notices.length, 0);
    assert.ok(fixture.state.pullRequestMergeIntent('example', 'project', 1));
  };
  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));
  assert.equal(result.branchDeleted, true);
  assert.equal(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].method, 'squash');
  assert.equal(fixture.notices.length, 1);
});

test('実行中に取得がマージを検出しても確認失敗後の取得で処理し直せる', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.control.afterMerge = async () => {
    await fixture.tracker.refreshRepo('example', 'project');
    fixture.control.failView = true;
  };
  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));
  assert.match(result.error, /次の取得で確かめます/);
  fixture.control.failView = false;
  await fixture.tracker.refreshRepo('example', 'project');
  assert.ok(fixture.calls.some(isBranchDeleteCall));
  assert.equal(fixture.notices.length, 1);
});

test('保存した意図は検出したマージと head が一致するときだけ削除と方式に使う', async (t) => {
  for (const matches of [true, false]) {
    const pr = ghPullRequest(1, 'feature/one', 'main');
    const fixture = await mergeFixture(t, [pr]);
    await fixture.tracker.refreshRepo('example', 'project');
    fixture.state.setPullRequestMergeIntent(savedMergeIntent(pr, { headRefOid: matches ? pr.headRefOid : sha(9), automatic: true }));
    fixture.github.openPullRequests = [];
    fixture.github.views.set(1, mergedView(pr));
    await fixture.tracker.refreshRepo('example', 'project');
    const history = fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0];
    assert.equal(history.method, matches ? 'squash' : null);
    assert.equal(fixture.calls.some(isBranchDeleteCall), matches);
    assert.equal(history.automatic, matches);
    if (matches) assert.equal(history.automaticResult.branchDeleted, true);
  }
});

test('再起動後のオープン PR の意図は取得開始が期限後なら消し一度だけ通知する', async (t) => {
  let now = NOW;
  const pr = ghPullRequest(1, 'feature/one', 'main');
  const fixture = await mergeFixture(t, [pr], { now: () => now });
  fixture.state.setPullRequestMergeIntent(savedMergeIntent(pr));
  await fixture.state.flushPersistence();
  const restored = await DashboardState.load(fixture.homeDir, { now });
  fixture.tracker.state = restored;
  t.after(() => restored.flushPersistence());
  now = NOW + GH_TIMEOUT_MS - 1;
  await fixture.tracker.refreshRepo('example', 'project');
  assert.ok(restored.pullRequestMergeIntent('example', 'project', 1));
  now = NOW + GH_TIMEOUT_MS + 1;
  await fixture.tracker.refreshRepo('example', 'project');
  assert.equal(restored.pullRequestMergeIntent('example', 'project', 1), null);
  const group = fixture.tracker.snapshot()[0];
  assert.equal(group.trees[0].mergeIntent, null);
  assert.equal(group.reservationNotices[0].message, '前回のマージ操作の結果を確認できませんでした');
  now += 61_000;
  await fixture.tracker.refreshRepo('example', 'project');
  assert.deepEqual(fixture.tracker.snapshot()[0].reservationNotices, []);
});

test('期限前に始まったオープン一覧の取得は期限後に終わっても意図を消さない', async (t) => {
  let now = NOW + GH_TIMEOUT_MS - 1;
  const pr = ghPullRequest(1, 'feature/one', 'main');
  const fixture = await mergeFixture(t, [pr], { now: () => now });
  fixture.state.setPullRequestMergeIntent(savedMergeIntent(pr));
  const original = fixture.tracker.execFileImpl;
  let release;
  let started;
  const fetching = new Promise((resolve) => { started = resolve; });
  fixture.tracker.execFileImpl = (file, args, options, callback) => {
    if (args[0] === 'pr' && args[1] === 'list' && args.includes('open')) {
      release = () => original(file, args, options, callback);
      started();
    } else original(file, args, options, callback);
  };
  const pending = fixture.tracker.refreshRepo('example', 'project');
  await fetching;
  now += GH_TIMEOUT_MS;
  release();
  await pending;
  assert.ok(fixture.state.pullRequestMergeIntent('example', 'project', 1));
  assert.deepEqual(fixture.tracker.snapshot()[0].reservationNotices, []);
});

test('gh の実行中は期限を過ぎたオープン一覧の取得でも意図を残す', async (t) => {
  let now = NOW;
  const fixture = await mergeFixture(t, undefined, { now: () => now });
  fixture.control.waitForMerge = async () => {
    now += GH_TIMEOUT_MS + 1;
    await fixture.tracker.refreshRepo('example', 'project');
    assert.ok(fixture.state.pullRequestMergeIntent('example', 'project', 1));
    assert.deepEqual(fixture.tracker.snapshot()[0].reservationNotices, []);
  };
  assert.equal((await fixture.manager.merge(mergeInput(1, { deleteBranch: true }))).branchDeleted, true);
});

test('マージの記録後に古いオープン一覧が届いても登録とマージ操作を復活させない', async (t) => {
  const { fixture, merging, freshList } = await mergeDuringOpenList(t);
  try {
    assert.equal(fixture.state.pullRequestRegistrationsForRepo('example', 'project')[0].state, 'merged');
    assert.deepEqual(fixture.tracker.repositoryState('example', 'project').openPullRequests, []);
    assert.equal(findPullRequestInTrees(fixture.tracker.snapshot()[0].trees, 1), null);
  } finally {
    await freshList.started;
    freshList.release();
    assert.equal((await merging).ok, true);
  }
});

test('マージ後は実行中の取得の完了を待って新しいオープン一覧を取得する', async (t) => {
  const { merging, freshList } = await mergeDuringOpenList(t);
  await freshList.started;
  freshList.release();
  assert.equal((await merging).ok, true);
});

test('古い取得でもマージと無関係な PR の題と head の更新は反映する', async (t) => {
  const other = ghPullRequest(2, 'feature/two', 'main', { sha: sha(3), fields: { title: '更新した題' } });
  const { fixture, merging, freshList } = await mergeDuringOpenList(t, [
    ghPullRequest(1, 'feature/one', 'main'), ghPullRequest(2, 'feature/two', 'main'),
  ], (fixture) => { fixture.github.openPullRequests[1] = other; });
  try {
    const pr = findPullRequestInTrees(fixture.tracker.snapshot()[0].trees, 2);
    assert.equal(pr.title, other.title);
    assert.equal(pr.headRefOid, other.headRefOid);
    assert.equal(fixture.state.pullRequestRegistrationsForRepo('example', 'project').find((record) => record.number === 2).lastOpen.headRefOid, other.headRefOid);
  } finally {
    await freshList.started;
    freshList.release();
    await merging;
  }
});

test('取得開始後にクローズを検出した PR は古い一覧で登録と行を復活させない', async (t) => {
  const fixture = await mergeFixture(t);
  await fixture.tracker.refreshRepo('example', 'project');
  fixture.state.rememberRelatedPullRequest(fixture.state.pullRequestRegistrationsForRepo('example', 'project')[0], NOW);
  const held = holdNextOpenList(fixture);
  const fetching = fixture.tracker.refreshRepo('example', 'project');
  await held.started;
  const pr = fixture.github.openPullRequests[0];
  fixture.github.openPullRequests = [];
  fixture.github.views.set(1, { ...pr, state: 'CLOSED', mergedAt: null });
  const detector = new PullRequestTracker({ state: fixture.state, now: () => NOW, execFileImpl: fixture.execFileImpl });
  t.after(() => detector.close());
  await detector.refreshRepo('example', 'project');
  held.release();
  await fetching;
  assert.equal(fixture.state.pullRequestRegistrationsForRepo('example', 'project')[0].state, 'closed');
  assert.equal(fixture.state.relatedPullRequestRegistrationsForRepo('example', 'project')[0].state, 'closed');
  assert.deepEqual(fixture.tracker.repositoryState('example', 'project').openPullRequests, []);
  assert.equal(findPullRequestInTrees(fixture.tracker.snapshot()[0].trees, 1), null);
});

test('gh の実行中に始まった取得は実行が結果不明で終わった後に届いても意図を残す', async (t) => {
  let now = NOW;
  const fixture = await mergeFixture(t, undefined, { now: () => now });
  const original = fixture.tracker.execFileImpl;
  let release;
  let listed;
  const listing = new Promise((resolve) => { listed = resolve; });
  let fetching;
  fixture.control.waitForMerge = async () => {
    now += GH_TIMEOUT_MS + 1;
    fixture.tracker.execFileImpl = (file, args, options, callback) => {
      if (args[0] === 'pr' && args[1] === 'list' && args.includes('open') && !release) {
        const stdout = JSON.stringify(fixture.github.openPullRequests);
        release = () => callback(null, stdout, '');
        listed();
      } else original(file, args, options, callback);
    };
    fetching = fixture.tracker.refreshRepo('example', 'project');
    await listing;
    fixture.control.failView = true;
  };
  const result = await fixture.manager.merge(mergeInput(1, { deleteBranch: true }));
  assert.equal(result.ok, false);
  assert.match(result.error, /マージの結果を確認できませんでした/);
  release();
  await fetching;
  assert.ok(fixture.state.pullRequestMergeIntent('example', 'project', 1));
  assert.deepEqual(fixture.tracker.snapshot()[0].reservationNotices, []);
});

async function localPullFixture(t, options = {}) {
  const fixture = await mergeFixture(t);
  const checkout = path.join(fixture.homeDir, 'checkout');
  await fs.mkdir(path.join(checkout, '.git'), { recursive: true });
  fixture.state.registerPullRequest('session-1', { url: ghPullRequest(1, 'feature/one', 'main').url }, {
    cwd: checkout, product: { key: 'project', name: 'Project' },
  }, NOW);
  fixture.state.patchDisplayPreferences({ pullDefaultBranchAfterMerge: options.enabled !== false });
  await fixture.tracker.refreshRepo('example', 'project');
  const worktrees = options.worktrees || [
    { path: checkout, branch: 'main' },
    { path: path.join(fixture.homeDir, 'feature'), branch: 'feature/one' },
    { path: path.join(fixture.homeDir, 'pruned'), branch: 'main', prunable: true },
  ];
  const localCalls = [];
  fixture.manager.gitExecFileImpl = (file, args, executionOptions, callback) => {
    localCalls.push(args);
    assert.equal(file, 'git');
    assert.equal(executionOptions.shell, false);
    assert.equal(executionOptions.windowsHide, true);
    const operation = args[2];
    if (operation === 'config') {
      callback(null, options.noRemote && args[1] === checkout && localCalls.some(call => call[2] === 'status')
        ? 'remote.origin.url https://github.com/other/project.git' : 'remote.upstream.url https://github.com/example/project.git');
    } else if (operation === 'worktree') {
      callback(null, worktrees.map(tree => 'worktree ' + tree.path + '\nbranch refs/heads/' + tree.branch + (tree.prunable ? '\nprunable missing' : '') + '\n').join('\n'));
    } else if (operation === 'symbolic-ref') {
      const switched = options.switchedTo || (options.switchAfterFetch && localCalls.some(call => call[2] === 'fetch') ? 'feature/other' : null);
      callback(null, (switched || 'main') + '\n');
    }
    else if (operation === 'status') callback(null, options.dirty ? ' M tracked.js\n' : '');
    else if (operation === 'fetch') {
      assert.equal(executionOptions.env.GIT_TERMINAL_PROMPT, '0');
      if (options.holdPull) options.holdPull(callback);
      else callback(options.failPull ? new Error('private output') : null, '');
    } else if (operation === 'rev-parse') callback(null, 'a'.repeat(40) + '\n');
    else if (operation === 'update-ref') callback(null, '');
    else if (operation === 'merge') callback(null, '');
    else assert.fail('unexpected local git command');
  };
  const detected = (changes = {}) => fixture.manager.handleDetectedMerge({
    owner: 'example', repo: 'project', pullRequest: { ...ghPullRequest(1, 'feature/one', 'main'), ...changes },
    mergedAt: new Date(NOW).toISOString(),
    registrations: fixture.state.pullRequestRegistrationsForRepo('example', 'project'),
  });
  return { ...fixture, checkout, localCalls, detected };
}

test('マージ後のローカル更新がオフなら git を実行しない', async (t) => {
  const f = await localPullFixture(t, { enabled: false });
  await f.detected();
  await Promise.all(f.manager.localUpdates);
  assert.deepEqual(f.localCalls, []);
});

test('既定ブランチへのマージは既定ブランチの有効な worktree だけを重複せず pull する', async (t) => {
  const f = await localPullFixture(t);
  await f.detected();
  await Promise.all(f.manager.localUpdates);
  const fetchCall = f.localCalls.find(call => call[2] === 'fetch');
  const fetchedRef = fetchCall[6].split(':')[1];
  assert.match(fetchedRef, /^refs\/agent-cockpit\/default-branch-/);
  assert.deepEqual(f.localCalls.filter(call => ['fetch', 'merge', 'update-ref'].includes(call[2])), [
    ['-C', f.checkout, 'fetch', '--no-write-fetch-head', '--', 'upstream', `+refs/heads/main:${fetchedRef}`],
    ['-C', f.checkout, 'merge', '--ff-only', 'a'.repeat(40)],
    ['-C', f.checkout, 'update-ref', '-d', fetchedRef],
  ]);
  assert.match(f.notices.at(-1).message, /ローカルの main を最新にしました/);
  const entries = await f.diagnostics.readRun(f.diagnostics.run);
  assert.ok(entries.some(entry => entry.msg === 'merge.local-update' && entry.data.result === 'updated'));
  assert.deepEqual(f.notices.at(-1).sessionIds, f.notices.at(-2).sessionIds);
});

test('未コミットの変更がある worktree は pull せずセッションへ知らせる', async (t) => {
  const f = await localPullFixture(t, { dirty: true });
  await f.detected();
  await Promise.all(f.manager.localUpdates);
  assert.equal(f.localCalls.some(call => call[2] === 'merge'), false);
  assert.match(f.notices.at(-1).message, /未コミットの変更があるため main を更新しませんでした/);
});

test('探索の後に別のブランチへ切り替えた worktree は pull も通知もしない', async (t) => {
  const f = await localPullFixture(t, { switchedTo: 'feature/other' });
  await f.detected();
  const noticeCount = f.notices.length;
  await Promise.all(f.manager.localUpdates);
  assert.equal(f.localCalls.some(call => call[2] === 'merge'), false);
  assert.equal(f.notices.length, noticeCount);
});

test('取得を待つ間に別のブランチへ切り替えた worktree には取り込まない', async (t) => {
  const f = await localPullFixture(t, { switchAfterFetch: true });
  await f.detected();
  await Promise.all(f.manager.localUpdates);
  assert.equal(f.localCalls.some(call => call[2] === 'fetch'), true);
  assert.equal(f.localCalls.some(call => call[2] === 'merge'), false);
});

test('リポジトリの状態を取得する前に検出したマージはイベントの既定ブランチで更新する', async (t) => {
  const f = await localPullFixture(t);
  f.tracker.repositoryState = () => null;
  await f.manager.handleDetectedMerge({
    owner: 'example', repo: 'project', pullRequest: ghPullRequest(1, 'feature/one', 'main'),
    mergedAt: new Date(NOW).toISOString(), defaultBranch: 'main',
    registrations: f.state.pullRequestRegistrationsForRepo('example', 'project'),
  });
  await Promise.all(f.manager.localUpdates);
  assert.equal(f.localCalls.filter(call => call[2] === 'merge').length, 1);
});

test('pull の失敗はセッションへ知らせマージの成功を変えない', async (t) => {
  const f = await localPullFixture(t, { failPull: true });
  const outcome = await f.detected();
  await Promise.all(f.manager.localUpdates);
  assert.equal(outcome.warning, null);
  assert.match(f.notices.at(-1).message, /main を更新できませんでした/);
  assert.equal(f.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].number, 1);
  const entries = (await f.diagnostics.readRun(f.diagnostics.run)).filter(entry => entry.msg === 'merge.local-update');
  assert.deepEqual(entries.map(entry => entry.data), [{ repository: 'example/project', result: 'failed' }]);
  assert.doesNotMatch(JSON.stringify(entries), /private output|checkout|stdout|stderr/);
});

test('既定ブランチ以外へのマージでは git を実行しない', async (t) => {
  const f = await localPullFixture(t);
  await f.detected({ baseRefName: 'feature/aggregate' });
  await Promise.all(f.manager.localUpdates);
  assert.deepEqual(f.localCalls, []);
});

test('一致する remote がない worktree は pull せずセッションへ知らせる', async (t) => {
  const f = await localPullFixture(t, { noRemote: true });
  await f.detected();
  await Promise.all(f.manager.localUpdates);
  assert.equal(f.localCalls.some(call => call[2] === 'merge'), false);
  assert.match(f.notices.at(-1).message, /一致する remote がないため/);
});

test('pull が終わる前にマージ検出を返し同じ worktree の更新を直列化する', async (t) => {
  const releases = [];
  const f = await localPullFixture(t, { holdPull: callback => releases.push(callback) });
  await f.detected();
  await f.detected({ number: 2 });
  while (!releases.length) await new Promise(resolve => setImmediate(resolve));
  assert.equal(releases.length, 1);
  releases[0](null, '');
  while (releases.length < 2) await new Promise(resolve => setImmediate(resolve));
  releases[1](null, '');
  await Promise.all(f.manager.localUpdates);
  assert.equal(f.localCalls.filter(call => call[2] === 'merge').length, 2);
});

test('既定ブランチの worktree が無ければローカル更新の通知を送らない', async (t) => {
  const f = await localPullFixture(t, { worktrees: [] });
  await f.detected();
  await Promise.all(f.manager.localUpdates);
  assert.equal(f.localCalls.some(call => call[2] === 'merge'), false);
  assert.equal(f.notices.length, 1);
});

for (const next of [undefined, 'GitHub の回復後にレビューする']) {
  test(`head が不一致なら${next ? '保留' : 'レビュー不要'}を古い head に記録しない`, async t => {
    const f = await mergeFixture(t);
    f.control.remoteBranchHeads.set('feature/one', sha(2));
    const registration = f.state.pullRequestRegistrations()[0];
    const result = await f.manager.setReviewRecord(registration, sha(3), '理由', next);
    assert.equal(result.status, 409);
    assert.match(result.error, /GitHub の PR 情報がブランチに追いついていない .*ため記録しません/);
    assert.equal(f.state.crossReviewSkip('example', 'project', 1), null);
    assert.equal(f.state.crossReviewDeferral('example', 'project', 1), null);
  });
}

test('ブランチだけ進んだ PR は手動マージを実行しない', async t => {
  const f = await mergeFixture(t);
  f.control.crossReviews.set(1, convergedReview(1));
  f.control.remoteBranchHeads.set('feature/one', sha(2));
  const result = await f.manager.merge(mergeInput());
  assert.equal(result.ok, false);
  assert.match(result.error, /PR 情報がブランチに追いついていない/);
  assert.equal(f.calls.some(args => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('予約後にブランチだけ進んだ PR は収束の記録があってもマージしない', async t => {
  const f = await mergeFixture(t);
  assert.equal((await f.manager.reserve(mergeInput())).reserved, true);
  f.control.crossReviews.set(1, convergedReview(1));
  f.control.remoteBranchHeads.set('feature/one', sha(2));
  await f.manager.checkReservations();
  assert.equal(f.calls.some(args => args[0] === 'pr' && args[1] === 'merge'), false);
  assert.ok(f.state.pullRequestMergeReservation('example', 'project', 1));
});
