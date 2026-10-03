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

const NOW = Date.parse('2026-10-03T12:00:00.000Z');
const sha = (digit) => String(digit).repeat(40);

function ghPullRequest(number, headRefName, baseRefName, changes = {}) {
  const check = changes.ci === 'pending'
    ? [{ state: 'IN_PROGRESS', status: 'IN_PROGRESS' }]
    : [{ state: 'SUCCESS', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/example/project/pull/${number}`,
    headRefName,
    baseRefName,
    headRefOid: sha(number),
    createdAt: '2026-10-01T00:00:00.000Z',
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: changes.ci === 'pending' ? 'BLOCKED' : 'CLEAN',
    reviewDecision: changes.reviewDecision || '',
    statusCheckRollup: check,
    ...changes.fields,
  };
}

function registration(number) {
  return {
    session_id: `session-${number}`,
    owner: 'example',
    repo: 'project',
    number,
    url: `https://github.com/example/project/pull/${number}`,
    addedAt: new Date(NOW).toISOString(),
    cwd: null,
    product: { key: 'project', name: 'Project' },
    state: 'unknown',
    mergedAt: null,
    lastOpen: null,
  };
}

function mergedView(pr, headRefOid = pr.headRefOid, mergedAt = new Date(NOW).toISOString()) {
  return { ...pr, state: 'MERGED', headRefOid, mergedAt };
}

async function mergeFixture(testContext, pullRequests = [ghPullRequest(1, 'feature/one', 'main')]) {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-pr-merge-'));
  testContext.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const state = await DashboardState.load(homeDir, { now: NOW });
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
    failOpenList: false,
    blockAfterEdit: false,
    queueMerge: false,
    keepAutoMerge: false,
    failView: false,
    defaultBranch: 'main',
    waitForMerge: null,
  };
  const execFileImpl = (_file, args, _options, callback) => {
    calls.push([...args]);
    const finish = (error, output = '') => callback(error, output);
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
      }));
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
          if (parent) Object.assign(parent, ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' }));
        }
        finish(null);
      }
      return;
    }
    if (args[0] === 'pr' && args[1] === 'merge') {
      const number = Number(args[2]);
      if (args.includes('--disable-auto')) {
        const current = github.views.get(number) || github.openPullRequests.find((item) => item.number === number);
        if (current) {
          github.views.set(number, {
            ...current, state: current.state || 'OPEN', mergedAt: current.mergedAt || null,
            autoMergeRequest: control.keepAutoMerge ? { enabledAt: new Date(NOW).toISOString() } : null,
          });
        }
        finish(null);
        return;
      }
      const complete = async () => {
        if (control.failMerge) {
          finish(Object.assign(new Error('merge failed'), { code: 'EIO' }));
          return;
        }
        if (args.includes('--auto')) {
          const current = github.openPullRequests.find((item) => item.number === number);
          if (current) github.views.set(number, { ...current, state: 'OPEN', mergedAt: null, autoMergeRequest: { enabledAt: new Date(NOW).toISOString() } });
        } else if (control.queueMerge) {
          const current = github.openPullRequests.find((item) => item.number === number);
          if (current) github.views.set(number, { ...current, state: 'OPEN', mergedAt: null });
        } else if (!args.includes('--auto')) {
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
      finish(control.failDelete ? Object.assign(new Error('delete failed'), { code: 'EIO' }) : null);
      return;
    }
    finish(Object.assign(new Error(`unexpected gh arguments: ${args.join(' ')}`), { code: 'EIO' }));
  };

  const tracker = new PullRequestTracker({ state, now: () => NOW, execFileImpl });
  const answerDelivery = {
    notifySessions(sessionIds, message) { notices.push({ sessionIds, message }); },
  };
  const manager = new PullRequestMergeManager({ state, tracker, answerDelivery, now: () => NOW });
  tracker.onMerged = (event) => manager.handleDetectedMerge(event);
  tracker.onClosed = (event) => manager.handleDetectedClose(event);
  return { state, github, calls, notices, control, tracker, manager };
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

test('表示した head SHA と取り直した SHA が違う PR は拒否する', async (t) => {
  const fixture = await mergeFixture(t);

  const result = await fixture.manager.merge(mergeInput(1, { headRefOid: sha(9) }));

  assert.equal(result.ok, false);
  assert.match(result.error, /head SHA/);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
});

test('表示後にマージを止める理由が現れた PR は取り直した状態で拒否する', async (t) => {
  const fixture = await mergeFixture(t);
  fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' });

  const result = await fixture.manager.merge(mergeInput(1));

  assert.equal(result.ok, false);
  assert.match(result.error, /CI 実行中/);
  assert.equal(fixture.calls.some((args) => args[0] === 'pr' && args[1] === 'merge'), false);
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

test('fork の PR が予約経由でマージされても登録先の同名ブランチを削除しない', async (t) => {
  const pr = ghPullRequest(1, 'feature/shared', 'main', { fields: { isCrossRepository: true } });
  const fixture = await mergeFixture(t, [pr]);
  fixture.state.setPullRequestMergeReservation({
    session_id: 'session-1', owner: 'example', repo: 'project', number: 1,
    url: pr.url, headRefOid: sha(1), headRefName: 'feature/shared', defaultBranch: 'main',
    method: 'squash', deleteBranch: true, createdAt: new Date(NOW).toISOString(), stackedPullRequests: [],
  });
  fixture.github.openPullRequests = [];
  fixture.github.views.set(1, mergedView(pr));

  await fixture.tracker.refreshRepo('example', 'project');

  assert.equal(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].automatic, true);
  assert.equal(fixture.calls.some((args) => args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE'), false);
  assert.match(fixture.notices.at(-1).message, /登録先リポジトリから削除しませんでした/);
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

test('状態を取り直して CI 実行中だけの理由が消えていれば予約条件を拒否する', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main');

  const result = await fixture.manager.reserve(mergeInput(1));

  assert.equal(result.ok, false);
  assert.match(result.error, /CI 実行中だけが理由/);
  assert.equal(fixture.calls.some((args) => args.includes('--auto')), false);
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

test('予約の取り消しで GitHub に自動マージが残っていれば、取り消せたとは扱わず知らせない', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  const reserved = await fixture.manager.reserve(mergeInput(1));
  assert.equal(reserved.ok, true);
  fixture.control.keepAutoMerge = true;

  const result = await fixture.manager.cancelReservation({ number: 1 });

  assert.equal(result.status, 502);
  assert.ok(fixture.state.pullRequestMergeReservation('example', 'project', 1));
  assert.equal(fixture.notices.length, 0);
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
  assert.match(result.error, /CI 実行中/);
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

test('CI 実行中だけなら SHA を指定して予約し、head の変化で予約を無効化する', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);

  const result = await fixture.manager.reserve(mergeInput(1, { method: 'rebase', deleteBranch: true }));
  const reservation = fixture.state.pullRequestMergeReservation('example', 'project', 1);
  const visibleReservation = fixture.tracker.snapshot()[0].trees[0].reservation;
  fixture.github.openPullRequests[0] = ghPullRequest(1, 'feature/one', 'main', { fields: { headRefOid: sha(9) } });
  await fixture.manager.checkReservations();

  assert.equal(result.ok, true);
  assert.equal(reservation.headRefOid, sha(1));
  assert.equal(visibleReservation.headRefOid, sha(1));
  assert.equal(fixture.tracker.snapshot()[0].lastMethod, 'rebase');
  assert.deepEqual(fixture.calls.find((args) => args.includes('--auto')), [
    'pr', 'merge', '1', '-R', 'example/project', '--auto', '--rebase', '--match-head-commit', sha(1),
  ]);
  assert.ok(fixture.calls.some((args) => args.includes('--disable-auto')));
  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  assert.equal(fixture.tracker.snapshot()[0].trees[0].reservation, null);
  assert.match(fixture.notices.at(-1).message, /head SHA が予約時から変わったため/);
});

test('head SHA が同じでも予約後に PR の base が変われば予約を取り消して知らせる', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  await fixture.manager.reserve(mergeInput(1));
  fixture.github.openPullRequests[0].baseRefName = 'release';

  await fixture.manager.checkReservations();

  assert.equal(fixture.github.openPullRequests[0].headRefOid, sha(1));
  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  assert.ok(fixture.calls.some((args) => args.includes('--disable-auto')));
  assert.match(fixture.notices.at(-1).message, /base が予約時の既定ブランチ main から release に変わったため/);
});

test('PR の base が同じでもリポジトリの既定ブランチが変われば予約を取り消して知らせる', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  await fixture.manager.reserve(mergeInput(1));
  fixture.control.defaultBranch = 'trunk';

  await fixture.manager.checkReservations();

  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  assert.ok(fixture.calls.some((args) => args.includes('--disable-auto')));
  assert.match(fixture.notices.at(-1).message, /既定ブランチが main から trunk に変わったため/);
});

test('画面からの予約取消は gh pr merge --disable-auto を実行し、予約を消して知らせる', async (t) => {
  const fixture = await mergeFixture(t, [ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' })]);
  await fixture.manager.reserve(mergeInput(1));

  const result = await fixture.manager.cancelReservation({ number: 1 });

  assert.equal(result.ok, true);
  assert.ok(fixture.calls.some((args) => args.join(' ') === 'pr merge 1 -R example/project --disable-auto'));
  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  assert.match(fixture.notices.at(-1).message, /開発者がダッシュボードからマージ予約を取り消した/);
});

test('予約による自動マージは子 PR を先に付け替え、選択した head のブランチを削除して知らせる', async (t) => {
  const lower = ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' });
  const upper = ghPullRequest(2, 'feature/two', 'feature/one');
  const fixture = await mergeFixture(t, [lower, upper]);
  const reserved = await fixture.manager.reserve(mergeInput(1, { method: 'squash', deleteBranch: true }));
  fixture.github.openPullRequests = [upper];
  fixture.github.views.set(1, mergedView(lower));

  await fixture.tracker.refreshRepoFresh('example', 'project');

  assert.equal(reserved.ok, true);
  assert.equal(fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0].automatic, true);
  const editIndex = fixture.calls.findIndex((args) => args[0] === 'pr' && args[1] === 'edit');
  const deleteIndex = fixture.calls.findIndex((args) => args[0] === 'api' && args[1] === '-X' && args[2] === 'DELETE');
  assert.ok(editIndex >= 0 && deleteIndex > editIndex);
  assert.deepEqual(fixture.calls[editIndex], ['pr', 'edit', '2', '-R', 'example/project', '--base', 'main']);
  assert.match(fixture.notices.at(-1).message, /#2 を `git rebase --onto main feature\/one` で積み直して push する/);
});

test('取消コマンドの前に別の head がマージされたら予約との差をセッションへ知らせる', async (t) => {
  const fixture = await mergeFixture(t, [
    ghPullRequest(1, 'feature/one', 'main', { ci: 'pending' }),
    ghPullRequest(2, 'feature/two', 'feature/one'),
  ]);
  await fixture.manager.reserve(mergeInput(1));
  const pr = fixture.github.openPullRequests[0];
  fixture.github.openPullRequests = [fixture.github.openPullRequests[1]];
  fixture.github.views.set(1, mergedView(pr, sha(9)));

  const result = await fixture.manager.cancelReservation({ number: 1 });

  assert.equal(result.ok, false);
  assert.match(result.error, /取り消しより先に PR がマージ/);
  assert.equal(fixture.state.pullRequestMergeReservation('example', 'project', 1), null);
  const history = fixture.state.mergedPullRequestHistoryForRepo('example', 'project', NOW)[0];
  assert.equal(history.automatic, true);
  assert.equal(history.reservedHeadRefOid, sha(1));
  assert.equal(history.mergedHeadRefOid, sha(9));
  assert.equal(history.headMismatch, true);
  assert.deepEqual(fixture.tracker.snapshot()[0].mergeHistory[0], history);
  assert.match(fixture.notices.at(-1).message, /予約時の head SHA .* とマージされた head SHA .* が異なります/);
  assert.match(fixture.notices.at(-1).message, /予約の取り消しより先にマージされました/);
  assert.match(fixture.notices.at(-1).message, /#2 を `git rebase --onto main feature\/one` で積み直して push する/);
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
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-pr-history-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
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
    url: 'https://github.com/example/project/pull/8', headRefOid: sha(8), headRefName: 'feature/eight',
    defaultBranch: 'main', method: 'rebase', deleteBranch: false, createdAt: new Date(NOW).toISOString(),
    stackedPullRequests: [],
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
  assert.equal(restored.pullRequestMergeReservation('example', 'project', 8).headRefOid, sha(8));
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
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-pr-old-store-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
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

test('古い store の24時間以内の merged PR を方式不明の履歴へ移す', async (t) => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-pr-old-merged-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
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
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-pr-key-'));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
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
  assert.match(delivery.deliverPostToolBatch('session-batch'), /PR #1 が main に入りました/);
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
