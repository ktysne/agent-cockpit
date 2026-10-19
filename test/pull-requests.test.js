const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  PullRequestTracker,
  classifyInspectedPullRequest,
  evaluateRestack,
  interpretFetchResults,
  productGroupsFor,
  selectPullRequestsToInspect,
  stackedPullRequestsForMerge,
  historicalMergedPullRequests,
  mergedPullRequestCandidates,
  parseCompareResult,
  restackCompareBase,
  restackResult,
  assemblePullRequestStacks,
  crossReviewToolExists,
  parsePullRequestList,
  readCrossReviewState,
  readCrossReviewStateAcrossWorktrees,
  runGh,
} = require('../src/server/pull-requests');const {
  findPullRequestUrl,
  firstPullRequestUrl,
  isGhPrCreateCommand,
  isPullRequestShellTool,
  parsePullRequestUrl,
  pullRequestCommandCwd,
  pullRequestRefreshScope,
  shouldRefreshPullRequests,
} = require('../src/server/pull-request-utils');
const { DashboardState } = require('../src/server/state');
const { temporaryDirectory: createTemporaryDirectory } = require('./support/temp');
const { ghPullRequest, pullRequest, pullRequestRegistration } = require('./support/github');

test('PR 登録の追加、更新、削除をキャッシュ後の一覧と provider に反映する', () => {
  const state = new DashboardState();
  const url = 'https://github.com/example/project/pull/31';
  state.addEvent({ session_id: 'cache-codex', provider: 'codex', hook_event_name: 'SessionStart', hookAt: 1000 });

  assert.deepEqual(state.pullRequestRegistrations(), []);
  assert.deepEqual(state.pullRequestProviders('example', 'project', 31), []);
  state.registerPullRequest('cache-claude', { url });
  const exposed = state.pullRequestRegistrations();
  exposed[0].state = 'closed';
  assert.equal(state.pullRequestRegistrations()[0].state, 'unknown');
  assert.deepEqual(state.pullRequestProviders('example', 'project', 31), ['claude']);

  state.registerPullRequest('cache-codex', { url });
  assert.deepEqual(state.pullRequestProviders('example', 'project', 31), ['claude', 'codex']);
  state.updatePullRequest('cache-codex', 'example', 'project', 31, { state: 'closed' });
  assert.equal(state.pullRequestRegistrations().find((record) => record.session_id === 'cache-codex').state, 'closed');
  assert.equal(state.deleteClosedPullRequest('example', 'project', 31), true);
  assert.deepEqual(state.pullRequestRegistrations().map((record) => record.session_id), ['cache-claude']);
  assert.deepEqual(state.pullRequestProviders('example', 'project', 31), ['claude']);
});

test('PR 作成コマンドの先頭 cd から作業ディレクトリを解決する', () => {
  const hookCwd = path.resolve(os.tmpdir(), 'session-repo', 'worktree');
  const targetCwd = path.resolve(os.tmpdir(), 'pull-request-repo', 'worktree');
  const commandPath = targetCwd.replaceAll('\\', '/');

  for (const command of [
    `cd "${commandPath}" && gh pr create`,
    `cd '${commandPath}' && gh pr create`,
    `cd ${commandPath} && gh pr create`,
  ]) {
    assert.equal(pullRequestCommandCwd(command, hookCwd), targetCwd);
  }
  assert.equal(pullRequestCommandCwd('cd ../pull-request-repo && gh pr create', hookCwd),
    path.resolve(hookCwd, '../pull-request-repo'));

  const gitBashCwd = pullRequestCommandCwd('cd /d/Desktop/Develop/project && gh pr create', hookCwd);
  assert.equal(gitBashCwd, process.platform === 'win32'
    ? path.resolve('D:/Desktop/Develop/project')
    : '/d/Desktop/Develop/project');
});

test('PR 作成コマンドの cd を確定できない形式では cwd を推測しない', () => {
  const hookCwd = path.resolve(os.tmpdir(), 'session-repo');
  const targetCwd = path.resolve(os.tmpdir(), 'pull-request-repo').replaceAll('\\', '/');
  for (const command of [
    `echo start && cd ${targetCwd} && gh pr create`,
    `cd ${targetCwd}; gh pr create`,
    `cd ${targetCwd} & gh pr create`,
    'cd "$PROJECT_ROOT" && gh pr create',
    'cd `pwd` && gh pr create',
    'cd ~/project && gh pr create',
    'cd D:\\Desktop\\project && gh pr create',
    'cd "a\\"b" && gh pr create',
    'cd "D:\\Desktop\\project" && gh pr create',
  ]) {
    assert.equal(pullRequestCommandCwd(command, hookCwd), null, command);
  }
  assert.equal(pullRequestCommandCwd('gh pr create', hookCwd), null);
});

test('取り直しの対象のコマンドから、指すリポジトリを 1 つに決める', () => {
  const hookCwd = path.resolve(os.tmpdir(), 'session-repo');
  for (const command of [
    'gh pr view 1 --repo o/r',
    'gh pr view 1 -R o/r',
    'gh --repo o/r pr view 1',
    'gh --repo=o/r pr view 1',
    'gh pr view 1 -R o/r && gh pr checks 1 --repo O/R',
  ]) {
    assert.deepEqual(pullRequestRefreshScope(command, hookCwd), { repository: 'o/r' }, command);
  }
  const targetCwd = path.resolve(os.tmpdir(), 'target-repo').replaceAll('\\', '/');
  for (const command of ['git push', `cd "${targetCwd}" && git push && gh pr view 1`, 'echo "gh pr view 1 --repo o/r" && git push']) {
    assert.deepEqual(pullRequestRefreshScope(command, hookCwd), { cwd: true }, command);
  }
  for (const command of [
    'git -C /work/b push',
    'git -C../other push',
    'cd ../other; git push',
    'pushd ../other && git push',
    'git --git-dir=/work/b/.git push',
    'gh pr view 1 -R o/a && gh pr view 1 -R o/b',
    'git push && gh pr view 1 -R o/b',
    'git push && cd /work/b && git push',
    'gh pr view 1 --repo o/r/extra',
  ]) {
    assert.deepEqual(pullRequestRefreshScope(command, hookCwd), { unknown: true }, command);
  }
});

async function temporaryDirectory(testContext) {
  return createTemporaryDirectory(testContext, 'agent-cockpit-pr-test-').directory;
}

function mergedPullRequest(number, headRefOid, mergedAt = '2026-10-03T11:00:00.000Z', headRefName = '', baseRefName = '') {
  return { number, headRefOid, headRefName, baseRefName, mergedAt };
}

function aggregateStack(changes = {}) {
  const openPullRequests = [pullRequest(31, 'feat/child', 'feature/aggregate')];
  return assemblePullRequestStacks({
    defaultBranch: 'main', openPullRequests, registrations: [pullRequestRegistration(31)],
    listAvailable: true, mergedPullRequests: [], mergedCandidates: [], mergeTargetHeadChecks: new Map([['feature/aggregate', true]]), mergeMethods: ['merge', 'squash'],
    restackResults: new Map([[31, { checked: true, parent: null }]]), ...changes,
  });
}

test('全状態の head 検索で PR が無い集約ブランチはマージコミットでマージできる', () => {
  const result = aggregateStack();
  assert.equal(result.trees[0].mergeTarget, 'feature/aggregate');
  assert.equal(result.trees[0].mergeMethodFixed, 'merge');
  assert.equal(result.trees[0].canMerge, true);
  assert.deepEqual(result.orphanedOpenNumbers, []);
});

test('PR の一覧や登録詳細を確認できなければ集約ブランチへマージできない', () => {
  const atLimit = Array.from({ length: 500 }, (_, index) => pullRequest(index + 1, `feat/${index}`, 'feature/aggregate'));
  for (const changes of [
    { listAvailable: false }, { mergeTargetHeadChecks: new Map() },
    { uninspectedNumbers: new Set([99]) }, { openPullRequests: atLimit },
  ]) {
    const result = aggregateStack(changes);
    assert.equal(result.trees[0].mergeTarget, null);
    assert.equal(result.trees[0].canMerge, false);
    assert.equal(result.trees[0].blocker, 'base の feature/aggregate がどの PR の head でもないことを確認できない');
    assert.deepEqual(result.orphanedOpenNumbers, [31]);
  }
});

test('マージ済み検索で見つかった head ブランチは集約先として認めない', () => {
  const merged = mergedPullRequest(30, 'a'.repeat(40), undefined, 'feature/aggregate', 'main');
  const result = aggregateStack({ mergedPullRequests: [merged], mergedCandidates: [merged] });
  assert.equal(result.trees[0].mergeTarget, null);
  assert.equal(result.trees[0].blocker, 'base の feature/aggregate はマージ済みの PR の head のため、ダッシュボードではマージしない');
});

test('別のプロダクトに登録された閉じた PR の head も集約先として認めない', () => {
  const record = pullRequestRegistration(30, { state: 'closed', lastOpen: {
    headRefName: 'feature/aggregate', baseRefName: 'main', headRefOid: 'a'.repeat(40),
  } });
  const result = aggregateStack({ knownRegistrations: [record] });
  assert.equal(result.trees[0].mergeTarget, null);
  assert.equal(result.trees[0].blocker, 'base の feature/aggregate に対応する PR が見つからない');
});

test('集約ブランチの最終 PR を開くとその配下は最終 PR のマージ待ちになる', () => {
  const result = aggregateStack({ openPullRequests: [
    pullRequest(30, 'feature/aggregate', 'main'), pullRequest(31, 'feat/child', 'feature/aggregate'),
  ] });
  const child = result.trees[0].children[0];
  assert.equal(child.mergeTarget, null);
  assert.equal(child.canMerge, false);
  assert.equal(child.blocker, '下の #30 のマージ待ち');
});

test('集約先でマージコミットが許可されていなければマージできない', () => {
  const result = aggregateStack({ mergeMethods: ['squash', 'rebase'] });
  assert.equal(result.trees[0].canMerge, false);
  assert.match(result.trees[0].blocker, /マージコミットが必要だが、このリポジトリでは許可されていない/);
  assert.deepEqual(result.orphanedOpenNumbers, []);
});

test('同期 PR は既定ブランチを base にする PR の親にも表示上の関連にもならない', () => {
  const prs = [pullRequest(30, 'main', 'feature/aggregate'), pullRequest(31, 'feat/child', 'main')];
  const result = aggregateStack({ openPullRequests: prs, restackResults: checkedRestackResults(prs) });
  assert.equal(result.trees.length, 1);
  assert.equal(result.trees[0].number, 31);
  assert.equal(result.trees[0].parentNumber, null);
  assert.equal(result.trees[0].mergeTarget, 'main');
  assert.equal(result.trees[0].canMerge, true);
});

test('非表示にしたマージ履歴は再記録と復元で戻らず、新しいマージ日時で表示する', async (t) => {
  const homeDir = await temporaryDirectory(t);
  const now = Date.parse('2026-10-08T00:00:00.000Z');
  const state = new DashboardState({ homeDir });
  const record = { owner: 'example', repo: 'project', number: 31,
    url: 'https://github.com/example/project/pull/31', mergedAt: new Date(now - 100).toISOString() };
  state.registerPullRequest('merged-session', { url: record.url }, {}, now);
  state.recordMergedPullRequest(record, now);
  assert.equal(state.dismissMergedPullRequestHistory('example', 'project', 999, now), false);
  assert.equal(state.dismissMergedPullRequestHistory('example', 'project', 31, now), true);
  assert.equal(state.dismissMergedPullRequestHistory('example', 'project', 31, now), false);
  state.recordMergedPullRequest({ ...record, title: '更新したタイトル' }, now);
  assert.deepEqual(state.mergedPullRequestHistoryForRepo('example', 'project', now), []);
  assert.equal(state.mergedPullRequests.size, 1);
  assert.equal(state.pullRequestRegistrations()[0].state, 'merged');
  await state.flushPersistence();
  const restored = await DashboardState.load(homeDir, { now: now + 1 });
  assert.deepEqual(restored.mergedPullRequestHistoryForRepo('example', 'project', now + 1), []);
  assert.equal(restored.mergedPullRequests.values().next().value.historyDismissedAt, new Date(now).toISOString());
  restored.recordMergedPullRequest({ ...record, mergedAt: new Date(now + 2).toISOString() }, now + 2);
  const history = restored.mergedPullRequestHistoryForRepo('example', 'project', now + 2);
  assert.equal(history.length, 1);
  assert.equal(history[0].historyDismissedAt, undefined);
  await restored.flushPersistence();
});

test('head が食い違うマージ履歴は非表示にしない', () => {
  const state = new DashboardState();
  const now = Date.parse('2026-10-08T00:00:00.000Z');
  state.recordMergedPullRequest({ owner: 'example', repo: 'project', number: 31,
    url: 'https://github.com/example/project/pull/31', headMismatch: true, mergedAt: new Date(now).toISOString() }, now);
  assert.equal(state.dismissMergedPullRequestHistory('example', 'project', 31, now), false);
  assert.equal(state.mergedPullRequestHistoryForRepo('example', 'project', now).length, 1);
});

test('closed 登録を削除してグループに反映し、merged 登録とスタック追跡を残す', async () => {
  const state = new DashboardState();
  const now = Date.parse('2026-10-08T00:00:00.000Z');
  const product = { key: 'project', name: 'project' };
  for (const [number, status] of [[31, 'merged'], [32, 'closed'], [33, 'open']]) {
    state.registerPullRequest(`session-${number}`, { url: `https://github.com/example/project/pull/${number}` }, { product }, now);
    state.updatePullRequest(`session-${number}`, 'example', 'project', number, {
      state: status, mergedAt: status === 'merged' ? new Date(now - 100).toISOString() : null,
      lastOpen: { title: `PR ${number}`, headRefName: `feat/${number}`, baseRefName: number === 33 ? 'feat/31' : 'main', headRefOid: 'a'.repeat(40) },
      ...(status === 'merged' ? { mergedHead: { headRefName: 'feat/31', baseRefName: 'main', headRefOid: 'a'.repeat(40) } } : {}),
    });
  }
  state.rememberRelatedPullRequest({ owner: 'example', repo: 'project', number: 34,
    url: 'https://github.com/example/project/pull/34', lastOpen: pullRequest(34, 'feat/34', 'main') }, now);
  state.updateRelatedPullRequest('example', 'project', 34, { state: 'closed' });
  const tracker = new PullRequestTracker({ state, now: () => now, readCrossReviewState: async () => null });
  tracker.repositories.set('example/project', {
    defaultBranch: 'main', openPullRequests: [pullRequest(33, 'feat/33', 'feat/31')],
    mergeMethods: ['merge'], uninspectedNumbers: new Set(), restackResults: new Map(), liveMergedBranches: new Map(), listAvailable: true,
  });
  await tracker.refreshReviewGroups('example', 'project');
  const before = tracker.snapshot()[0];
  const merged = state.pullRequestRegistrations().find(record => record.number === 31);
  assert.ok(before.merged.some(record => record.number === 32));
  assert.equal(state.deleteClosedPullRequest('example', 'project', 32), true);
  assert.equal(state.deleteClosedPullRequest('example', 'project', 34), true);
  assert.equal(state.deleteClosedPullRequest('example', 'project', 31), false);
  await tracker.refreshReviewGroups('example', 'project');
  const after = tracker.snapshot()[0];
  assert.ok(!after.merged.some(record => [32, 34].includes(record.number)));
  assert.deepEqual(after.trees, before.trees);
  assert.deepEqual(state.pullRequestRegistrations().find(record => record.number === 31), merged);
});

function compareResult(commits = [], aheadBy = commits.length) {
  return { ahead_by: aheadBy, commits: commits.map((sha) => ({ sha })) };
}

function checkedRestackResults(pullRequests, parent = null) {
  return new Map(pullRequests.map((pr) => [pr.number, { checked: true, parent }]));
}

async function trackerFixture(testContext, registeredNumbers = [31], cwd = process.cwd()) {
  const homeDir = await temporaryDirectory(testContext);
  const state = new DashboardState({ homeDir });
  for (const number of registeredNumbers) {
    state.registerPullRequest(`session-${number}`, { url: `https://github.com/example/project/pull/${number}` }, {
      cwd, product: { key: 'project', name: 'project' },
    });
  }
  const github = {
    openPullRequests: [],
    mergedPullRequests: [],
    comparisons: new Map(),
    compareErrors: new Set(),
    headPullRequests: new Map(),
    headSearchErrors: new Set(),
    branchHeads: new Map(),
    branchHeadErrors: new Map(),
    views: new Map(),
  };
  const calls = [];
  const unexpectedCalls = [];
  const tracker = new PullRequestTracker({
    state,
    now: () => Date.parse('2026-10-03T12:00:00.000Z'),
    execFileImpl: (_file, args, _options, callback) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'list') {
        if (args.includes('--head')) {
          const branch = args[args.indexOf('--head') + 1];
          if (github.headSearchErrors.has(branch)) callback(new Error('head search failed'));
          else callback(null, JSON.stringify(github.headPullRequests.get(branch) ||
            github.mergedPullRequests.filter(pr => pr.headRefName === branch).slice(0, 1)));
          return;
        }
        const stateOption = args.indexOf('--state');
        const values = args[stateOption + 1] === 'open' ? github.openPullRequests : github.mergedPullRequests;
        callback(null, JSON.stringify(values));
      } else if (args[0] === 'api' && args[1] === 'repos/example/project') {
        callback(null, JSON.stringify({
          default_branch: 'main', allow_merge_commit: true, allow_squash_merge: true, allow_rebase_merge: true,
        }));
      } else if (args[0] === 'api' && args[1].includes('/git/ref/heads/')) {
        const branchPath = args[1].split('/git/ref/heads/').at(-1);
        const branch = branchPath.split('/').map(decodeURIComponent).join('/');
        const error = github.branchHeadErrors.get(branch);
        if (error) callback(error);
        else if (github.branchHeads.has(branch)) callback(null, JSON.stringify({ object: { sha: github.branchHeads.get(branch) } }));
        else callback(Object.assign(new Error('HTTP 404: Not Found'), { code: 'GHESAPI' }));
      } else if (args[0] === 'api' && args[1].includes('/compare/')) {
        const [compareBase, headSha] = args[1].split('/compare/').at(-1).split('...');
        const compareKey = `${decodeURIComponent(compareBase)}...${headSha}`;
        if (github.compareErrors.has(compareKey) || github.compareErrors.has(headSha)) {
          callback(Object.assign(new Error('compare failed'), { code: 'EIO' }));
        } else {
          callback(null, JSON.stringify(github.comparisons.get(compareKey) || github.comparisons.get(headSha) || compareResult()));
        }
      } else if (args[0] === 'pr' && args[1] === 'view') {
        const value = github.views.get(Number(args[2]));
        if (value) callback(null, JSON.stringify(value));
        else {
          unexpectedCalls.push([...args]);
          callback(new Error(`unexpected gh arguments: ${args.join(' ')}`));
        }
      } else {
        unexpectedCalls.push([...args]);
        callback(new Error(`unexpected gh arguments: ${args.join(' ')}`));
      }
    },
  });
  return { state, github, calls, unexpectedCalls, tracker };
}

function holdGhExecutions(tracker) {
  const started = [];
  const pending = [];
  tracker.execFileImpl = (_file, args, _options, callback) => {
    started.push(args[1]);
    pending.push(callback);
  };
  return {
    started,
    pending,
    finishNext() { pending.shift()(null, '{}'); },
  };
}

async function settleGhExecutions() {
  for (let index = 0; index < 5; index += 1) await new Promise(setImmediate);
}

for (const exists of [true, false]) {
  test(`残す選択をしたマージ済みブランチが${exists ? '同じ head で実在すれば追跡を止める' : '404 なら base をたどる'}`, async (t) => {
    const { state, github, calls, tracker } = await trackerFixture(t);
    const branch = 'codex/feature';
    const mergedSha = 'a'.repeat(40);
    const childSha = 'b'.repeat(40);
    rememberHistoricalMerge(state, 30, branch, 'main', mergedSha, '2026-10-03T11:00:00.000Z', true);
    state.updatePullRequest('session-30', 'example', 'project', 30, {
      mergedHead: { headRefOid: mergedSha, headRefName: branch, baseRefName: 'main', branchKept: true },
    });
    github.openPullRequests = [ghPullRequest(31, 'feat/child', branch, childSha)];
    github.mergedPullRequests = [mergedPullRequest(30, mergedSha, '2026-10-03T11:00:00.000Z', branch, 'main')];
    if (exists) github.branchHeads.set(branch, mergedSha);
    github.comparisons.set(`main...${childSha}`, compareResult([mergedSha, childSha]));
    github.comparisons.set(`${branch}...${childSha}`, compareResult([childSha]));

    await tracker.refreshRepo('example', 'project');

    const tree = tracker.snapshot()[0].trees[0];
    assert.equal(tree.effectiveBase, exists ? branch : 'main');
    assert.equal(tree.needsRestack, !exists);
    if (exists) assert.match(tree.blocker, /base の codex\/feature はマージ済みの PR の head/);
    assert.ok(calls.some((args) => args[0] === 'api' && args[1].endsWith(`/compare/${exists ? 'codex%2Ffeature' : 'main'}...${childSha}`)));
  });
}

test('旧マージ済み記録を refresh ごとに最大5件補完し onMerged を再発火しない', async (t) => {
  const { state, github, calls, tracker } = await trackerFixture(t, [1, 2, 3, 4, 5, 6]);
  let mergedEvents = 0;
  tracker.onMerged = () => { mergedEvents += 1; };
  for (let number = 1; number <= 6; number += 1) {
    state.updatePullRequest(`session-${number}`, 'example', 'project', number, { state: 'merged', mergedAt: '2026-10-03T11:00:00.000Z' });
    github.views.set(number, { ...ghPullRequest(number, `feat/${number}`, 'main', 'a'.repeat(40)), state: 'MERGED', mergedAt: '2026-10-03T11:00:00.000Z' });
  }
  await tracker.refreshRepo('example', 'project');
  assert.equal(calls.filter((args) => args[0] === 'pr' && args[1] === 'view').length, 5);
  assert.equal(state.pullRequestRegistrationsForRepo('example', 'project').filter((record) => record.mergedHead).length, 5);
  await tracker.refreshRepo('example', 'project');
  assert.equal(calls.filter((args) => args[0] === 'pr' && args[1] === 'view').length, 6);
  assert.equal(state.pullRequestRegistrationsForRepo('example', 'project').filter((record) => record.mergedHead).length, 6);
  assert.equal(mergedEvents, 0);
});

for (const response of ['failure', 'OPEN', 'invalid-head']) {
  test(`旧記録の補完が ${response} なら記録を保ちエラーを出さず再試行は1回に限る`, async (t) => {
    const { state, github, calls, tracker } = await trackerFixture(t, [30, 31]);
    state.updatePullRequest('session-30', 'example', 'project', 30, { state: 'merged', mergedAt: '2026-10-03T11:00:00.000Z' });
    const before = state.pullRequestRegistrationForSession('session-30', 'example', 'project', 30);
    github.openPullRequests = [ghPullRequest(31, 'feat/child', 'main')];
    if (response !== 'failure') github.views.set(30, {
      ...ghPullRequest(30, 'feat/parent', 'main', response === 'invalid-head' ? 'bad' : 'a'.repeat(40)),
      state: response === 'OPEN' ? 'OPEN' : 'MERGED', mergedAt: '2026-10-03T11:00:00.000Z',
    });
    for (let round = 0; round < 3; round += 1) {
      await tracker.refreshRepo('example', 'project');
      assert.equal(tracker.snapshot()[0].error, null);
      assert.equal(tracker.snapshot()[0].openStateUnknown, false);
      assert.deepEqual(state.pullRequestRegistrationForSession('session-30', 'example', 'project', 30), before);
    }
    assert.equal(calls.filter((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === '30').length, 2);
  });
}

test('旧記録の補完失敗後の1回の再試行で mergedHead を保存できる', async (t) => {
  const { state, github, tracker } = await trackerFixture(t, [30]);
  state.updatePullRequest('session-30', 'example', 'project', 30, { state: 'merged', mergedAt: '2026-10-03T11:00:00.000Z' });
  await tracker.refreshRepo('example', 'project');
  github.views.set(30, { ...ghPullRequest(30, 'feat/parent', 'main', 'a'.repeat(40)), state: 'MERGED', mergedAt: '2026-10-03T11:00:00.000Z' });
  await tracker.refreshRepo('example', 'project');
  assert.deepEqual(state.pullRequestRegistrationForSession('session-30', 'example', 'project', 30).mergedHead, {
    headRefOid: 'a'.repeat(40), headRefName: 'feat/parent', baseRefName: 'main',
  });
});

function rememberHistoricalMerge(state, number, headRefName, baseRefName, headRefOid, mergedAt, registered = false) {
  const url = `https://github.com/example/project/pull/${number}`;
  const lastOpen = { title: `PR ${number}`, url, headRefName, baseRefName, headRefOid };
  const mergedHead = { headRefOid, headRefName, baseRefName };
  if (registered) {
    state.registerPullRequest(`session-${number}`, { url }, { product: { key: 'project', name: 'project' } });
    state.updatePullRequest(`session-${number}`, 'example', 'project', number, { state: 'merged', mergedAt, lastOpen, mergedHead });
    return;
  }
  state.rememberRelatedPullRequest({ owner: 'example', repo: 'project', number, url, lastOpen });
  state.updateRelatedPullRequest('example', 'project', number, { state: 'merged', mergedAt, mergedHead });
}

test('PR URL の抽出は出力中の GitHub URL を限定して返す', () => {
  assert.deepEqual(findPullRequestUrl('Created pull request: https://github.com/Example/repo-name/pull/42'), {
    owner: 'Example', repo: 'repo-name', number: 42, url: 'https://github.com/Example/repo-name/pull/42',
  });
  assert.deepEqual(firstPullRequestUrl({ content: [{ text: 'Created #43 https://github.com/example/project/pull/43' }] }), {
    owner: 'example', repo: 'project', number: 43, url: 'https://github.com/example/project/pull/43',
  });
  assert.equal(firstPullRequestUrl({ content: [{ text: 'created PR but did not include a URL' }] }), null);
  assert.equal(parsePullRequestUrl('https://github.com/example/project/issues/43'), null);
  assert.equal(parsePullRequestUrl('https://github.com/example/project/pull/43/anything'), null);
});

test('gh pr create と git push の検出は引用した説明文をコマンドとして扱わない', () => {
  assert.equal(isGhPrCreateCommand('cd repo && GH_PROMPT=1 gh pr create --fill'), true);
  assert.equal(isGhPrCreateCommand('echo "gh pr create"'), false);
  assert.equal(shouldRefreshPullRequests('git -C repo push origin feature'), true);
  assert.equal(shouldRefreshPullRequests('gh --repo example/project pr view 42'), true);
  assert.equal(shouldRefreshPullRequests('echo "git push"'), false);
});

test('PR 作成と取り直しの対象は Bash と PowerShell に限る', () => {
  assert.equal(isPullRequestShellTool('Bash'), true);
  assert.equal(isPullRequestShellTool('PowerShell'), true);
  assert.equal(isPullRequestShellTool('Read'), false);
});

test('gh 呼び出しは引数配列とトークンを除いた環境を使う', async () => {
  let captured;
  const output = await runGh(['pr', 'list'], {
    execFileImpl: (file, args, options, callback) => {
      captured = { file, args, options };
      callback(null, '[]');
    },
    environment: { PATH: 'path', GH_TOKEN: 'secret', GITHUB_TOKEN: 'other' },
  });
  assert.equal(output, '[]');
  assert.equal(captured.file, 'gh');
  assert.deepEqual(captured.args, ['pr', 'list']);
  assert.equal(captured.options.shell, false);
  assert.deepEqual(captured.options.env, { PATH: 'path' });

  const calls = [];
  await runGh(['pr', 'view', '4'], {
    execFileImpl: (file, args, options, callback) => {
      calls.push({ file, args, options });
      callback(null, '{}');
    },
    environment: { PATH: 'path', GH_TOKEN: 'secret' },
  });
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.GH_TOKEN, undefined);
});

test('gh の一覧 JSON から記録した PR の親と分岐した子を含める', () => {
  const openPullRequests = parsePullRequestList(JSON.stringify([
    { number: 10, title: 'PR 10', url: 'https://github.com/example/project/pull/10', headRefName: 'feat/base', baseRefName: 'main', headRefOid: '0'.repeat(40), isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', statusCheckRollup: [{ state: 'SUCCESS', conclusion: 'SUCCESS' }] },
    { number: 11, title: 'PR 11', url: 'https://github.com/example/project/pull/11', headRefName: 'feat/left', baseRefName: 'feat/base', headRefOid: '1'.repeat(40), isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', statusCheckRollup: [{ state: 'SUCCESS', conclusion: 'SUCCESS' }] },
    { number: 12, title: 'PR 12', url: 'https://github.com/example/project/pull/12', headRefName: 'feat/right', baseRefName: 'feat/base', headRefOid: '2'.repeat(40), isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', statusCheckRollup: [{ state: 'SUCCESS', conclusion: 'SUCCESS' }] },
    { number: 99, title: 'PR 99', url: 'https://github.com/example/project/pull/99', headRefName: 'docs/other', baseRefName: 'main', headRefOid: '9'.repeat(40), isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '', statusCheckRollup: [{ state: 'SUCCESS', conclusion: 'SUCCESS' }] },
  ]));
  const result = assemblePullRequestStacks({
    defaultBranch: 'main',
    openPullRequests,
    registrations: [pullRequestRegistration(11)],
    restackResults: checkedRestackResults(openPullRequests),
  });
  assert.equal(result.openCount, 3);
  assert.equal(result.trees.length, 1);
  assert.equal(result.trees[0].number, 10);
  assert.deepEqual(result.trees[0].children.map((child) => child.number), [11, 12]);
  assert.deepEqual(result.trees[0].children.map((child) => child.stackPosition), [
    { depth: 2, total: 2 }, { depth: 2, total: 2 },
  ]);
  assert.equal(result.mergeableCount, 1);
});

test('merged parent の base をたどり、常駐サーバーの付け替え記録を維持する', () => {
  const child = pullRequest(33, 'feat/child', 'feat/merged');
  const merged = pullRequestRegistration(32, { state: 'merged', lastOpen: {
    title: 'merged', url: 'https://github.com/example/project/pull/32',
    headRefName: 'feat/merged', baseRefName: 'main', headRefOid: 'a'.repeat(40),
    isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '',
    ci: 'pass', review: 'none', conflict: false,
  } });
  const withoutRetarget = assemblePullRequestStacks({
    defaultBranch: 'main', openPullRequests: [child], registrations: [pullRequestRegistration(33), merged],
    restackResults: checkedRestackResults([child]),
  }).trees[0];
  assert.equal(withoutRetarget.effectiveBase, 'main');
  assert.equal(withoutRetarget.retargetedFrom, null);
  assert.equal(withoutRetarget.blocker, 'base を main に付け替える必要がある');

  const withRetarget = assemblePullRequestStacks({
    defaultBranch: 'main', openPullRequests: [child], registrations: [pullRequestRegistration(33), merged],
    retargetedPrs: [{ owner: 'example', repo: 'project', number: 33, base: 'main', fromNumber: 32 }],
    listAvailable: true, mergedCandidates: [mergedPullRequest(32, 'a'.repeat(40), undefined, 'feat/merged', 'main')],
    restackResults: checkedRestackResults([child]),
  }).trees[0];
  assert.equal(withRetarget.effectiveBase, 'main');
  assert.equal(withRetarget.retargetedFrom, 32);
  assert.equal(withRetarget.blocker, 'base を main に付け替える必要がある');
});

test('マージできない理由は base、スタック、ドラフト、積み直し、CI、レビューの順にひとつ返す', () => {
  const cases = [
    {
      pullRequests: [pullRequest(20, 'child', 'missing/base', { draft: true, conflict: true, ci: 'fail', review: 'changes' })],
      number: 20,
      expected: 'base の missing/base がどの PR の head でもないことを確認できない',
    },
    {
      pullRequests: [pullRequest(36, 'child', 'closed/base')],
      relatedPullRequests: [pullRequestRegistration(35, { state: 'closed', lastOpen: {
        headRefName: 'closed/base', baseRefName: 'main', headRefOid: 'a'.repeat(40),
      } })],
      number: 36,
      expected: 'base の closed/base に対応する PR が見つからない',
    },
    {
      pullRequests: [pullRequest(21, 'parent', 'main'), pullRequest(22, 'child', 'parent', { draft: true })],
      number: 22,
      expected: '下の #21 のマージ待ち',
    },
    {
      pullRequests: [pullRequest(32, 'retarget', 'old-base', { draft: true })],
      number: 32,
      retargetedPrs: [{ owner: 'example', repo: 'project', number: 32, base: 'main', fromNumber: 30 }],
      listAvailable: true,
      mergedCandidates: [mergedPullRequest(30, 'a'.repeat(40), undefined, 'feat/parent', 'main')],
      expected: 'base を main に付け替える必要がある',
    },
    { pullRequests: [pullRequest(23, 'draft', 'main', { draft: true, conflict: true })], number: 23, expected: 'ドラフト' },
    { pullRequests: [pullRequest(34, 'draft-restack', 'main', { draft: true })], number: 34, restackParent: 30, expected: 'ドラフト' },
    { pullRequests: [pullRequest(35, 'draft-unknown', 'main', { draft: true })], number: 35, unknown: true, expected: 'ドラフト' },
    { pullRequests: [pullRequest(29, 'restack', 'main', { conflict: true, ci: 'fail', review: 'changes' })], number: 29, restackParent: 30, expected: '積み直し待ち (#30 が main に入った後も、そのコミットが差分に残っている)' },
    { pullRequests: [pullRequest(33, 'unknown', 'main', { conflict: true, ci: 'fail' })], number: 33, unknown: true, expected: '積み直しが必要か確かめられない' },
    { pullRequests: [pullRequest(24, 'conflict', 'main', { conflict: true, ci: 'fail' })], number: 24, expected: 'コンフリクトあり' },
    { pullRequests: [pullRequest(25, 'failed', 'main', { ci: 'fail', review: 'changes' })], number: 25, expected: 'CI が失敗' },
    { pullRequests: [pullRequest(26, 'running', 'main', { ci: 'pending', review: 'changes' })], number: 26, expected: 'CI 実行中' },
    { pullRequests: [pullRequest(27, 'changes', 'main', { review: 'changes' })], number: 27, expected: '変更を求められている' },
    { pullRequests: [pullRequest(28, 'required', 'main', { review: 'required' })], number: 28, expected: 'レビューの承認待ち' },
  ];
  for (const item of cases) {
    const restackResults = checkedRestackResults(item.pullRequests);
    if (item.restackParent) restackResults.set(item.number, {
      checked: true, parent: mergedPullRequest(item.restackParent, 'a'.repeat(40)),
    });
    if (item.unknown) restackResults.set(item.number, { checked: false, parent: null });
    const result = assemblePullRequestStacks({
      defaultBranch: 'main',
      listAvailable: item.listAvailable || false,
      openPullRequests: item.pullRequests,
      registrations: [pullRequestRegistration(item.number), ...(item.number === 22 ? [pullRequestRegistration(21)] : [])],
      relatedPullRequests: item.relatedPullRequests || [],
      retargetedPrs: item.retargetedPrs || [],
      mergedCandidates: item.mergedCandidates || [],
      restackResults,
    });
    const find = (tree) => tree.number === item.number ? tree : tree.children.map(find).find(Boolean);
    assert.equal(find(result.trees[0]).blocker, item.expected);
  }
});

test('登録の保持期限後に refreshAll するとリポジトリと表示用データを消して版を進める', async (t) => {
  const { state, tracker } = await trackerFixture(t);
  await tracker.refreshRepo('example', 'project');
  assert.equal(tracker.snapshot().length, 1);

  const registration = state.pullRequestRegistrations()[0];
  state.pruneExpiredStoreRecords(Date.parse(registration.addedAt) + 15 * 24 * 60 * 60 * 1000);
  assert.equal(state.pullRequestRegistrations().length, 0);
  const versionBeforeRefresh = state.version;

  await tracker.refreshAll();

  assert.deepEqual(tracker.snapshot(), []);
  assert.equal(tracker.repositories.has('example/project'), false);
  assert.ok(state.version > versionBeforeRefresh);
});

test('閉じた登録だけのリポジトリは15分間の定期取得を飛ばし登録と表示を残す', async (t) => {
  for (const closedState of ['closed', 'merged']) {
    const { state, tracker, github, calls } = await trackerFixture(t);
    let now = Date.parse('2026-10-03T12:00:00.000Z');
    tracker.now = () => now;
    github.views.set(31, {
      ...ghPullRequest(31, 'feature/31', 'main', '1'.repeat(40)),
      state: closedState.toUpperCase(), mergedAt: closedState === 'merged' ? new Date(now).toISOString() : null,
    });
    await tracker.refreshAll();
    const before = tracker.snapshot();
    const registrations = state.pullRequestRegistrations();
    const callCount = calls.length;
    assert.equal(registrations[0].state, closedState);
    assert.equal(before.length, 1);

    now += 15 * 60_000 - 1;
    await tracker.refreshAll();
    assert.equal(calls.length, callCount);
    assert.deepEqual(tracker.snapshot(), before);
    assert.deepEqual(state.pullRequestRegistrations(), registrations);

    now += 1;
    await tracker.refreshAll();
    assert.ok(calls.length > callCount);
  }
});

test('開いているか未確定の登録または関連PRがあれば毎回定期取得する', async (t) => {
  for (const related of [false, true]) {
    for (const prState of ['open', 'unknown', null]) {
      const { state, tracker, calls } = await trackerFixture(t, related ? [] : [31]);
      if (related) state.rememberRelatedPullRequest({
        owner: 'example', repo: 'project', number: 31, url: 'https://github.com/example/project/pull/31',
      });
      await tracker.refreshAll();
      if (related) state.updateRelatedPullRequest('example', 'project', 31, { state: prState });
      else state.updatePullRequest('session-31', 'example', 'project', 31, { state: prState });
      if (related) {
        state.registerPullRequest('session-32', { url: 'https://github.com/example/project/pull/32' });
        state.updatePullRequest('session-32', 'example', 'project', 32, { state: 'closed' });
      } else {
        state.rememberRelatedPullRequest({
          owner: 'example', repo: 'project', number: 32, url: 'https://github.com/example/project/pull/32',
        });
        state.updateRelatedPullRequest('example', 'project', 32, { state: 'closed' });
      }
      const callCount = calls.length;
      await tracker.refreshAll();
      assert.ok(calls.length > callCount, `${related ? '関連PR' : '登録'}: ${prState}`);
    }
  }
});

test('閉じた関連PRだけでも取得状態を残し個別取得の開始から15分後に定期取得する', async (t) => {
  const { state, tracker, github, calls } = await trackerFixture(t, []);
  let now = Date.parse('2026-10-03T12:00:00.000Z');
  tracker.now = () => now;
  state.rememberRelatedPullRequest({
    owner: 'example', repo: 'project', number: 31, url: 'https://github.com/example/project/pull/31',
  });
  github.views.set(31, { ...ghPullRequest(31, 'feature/31', 'main'), state: 'CLOSED' });
  await tracker.refreshAll();
  const before = tracker.snapshot();
  const repository = tracker.repositoryState('example', 'project');
  assert.ok(repository);
  const related = state.relatedPullRequestRegistrations();
  const callCount = calls.length;
  now += 10 * 60_000;
  await tracker.refreshAll();
  assert.equal(calls.length, callCount);
  assert.equal(tracker.repositoryState('example', 'project'), repository);
  assert.deepEqual(tracker.snapshot(), before);
  assert.deepEqual(state.relatedPullRequestRegistrations(), related);

  await tracker.refreshRepoFresh('example', 'project');
  assert.ok(calls.length > callCount);
  const freshCount = calls.length;
  now += 5 * 60_000;
  await tracker.refreshAll();
  assert.equal(calls.length, freshCount);
  now += 10 * 60_000;
  await tracker.refreshAll();
  assert.ok(calls.length > freshCount);

  state.registerPullRequest('session-32', { url: 'https://github.com/example/project/pull/32' });
  github.openPullRequests.push(ghPullRequest(32, 'feature/32', 'main'));
  const beforeRegistrationFetch = calls.length;
  await tracker.refreshRepo('example', 'project');
  assert.ok(calls.length > beforeRegistrationFetch);
  assert.equal(state.pullRequestRegistrations()[0].state, 'open');
});

test('設定した上限まで gh を起動し20秒を超えて待った取得も失敗後に順に実行する', async (t) => {
  const { state, tracker } = await trackerFixture(t, []);
  state.getDisplayPreferences = () => ({ ghConcurrencyLimit: 4 });
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const started = [];
  const running = [];
  let peak = 0;
  tracker.execFileImpl = (_file, args, options, callback) => {
    started.push(args[1]);
    assert.equal(options.timeout, 20_000);
    running.push(callback);
    peak = Math.max(peak, running.length);
  };
  const requests = Array.from({ length: 7 }, (_, index) => tracker.execute(['api', `repos/example/project/${index}`]));
  const results = Promise.allSettled(requests);
  await new Promise(setImmediate);
  assert.equal(started.length, 4);
  t.mock.timers.tick(25_000);
  await new Promise(setImmediate);
  assert.equal(started.length, 4);
  running.shift()(Object.assign(new Error('gh timeout'), { killed: true }));
  await new Promise(setImmediate);
  assert.equal(started.length, 5);
  while (running.length) {
    running.shift()(null, '{}');
    await new Promise(setImmediate);
  }
  assert.equal(peak, 4);
  assert.deepEqual(started, Array.from({ length: 7 }, (_, index) => `repos/example/project/${index}`));
  assert.equal((await results)[0].status, 'rejected');
  t.mock.timers.reset();
});

test('gh は設定値まで起動し、未設定なら既定の8本まで起動する', async (t) => {
  for (const { limit, expected } of [{ limit: 2, expected: 2 }, { limit: undefined, expected: 8 }]) {
    const { state, tracker } = await trackerFixture(t, []);
    state.getDisplayPreferences = () => limit === undefined ? {} : { ghConcurrencyLimit: limit };
    const held = holdGhExecutions(tracker);
    const requests = Array.from({ length: expected + 1 }, (_, index) => (
      tracker.execute(['api', `repos/example/project/${index}`])
    ));
    await settleGhExecutions();
    assert.equal(held.started.length, expected);
    while (held.pending.length) {
      held.finishNext();
      await settleGhExecutions();
    }
    await Promise.all(requests);
  }
});

test('実行中に gh の上限を上げると次の解放で待ち行列から新しい上限まで起動する', async (t) => {
  const { state, tracker } = await trackerFixture(t, []);
  let limit = 1;
  state.getDisplayPreferences = () => ({ ghConcurrencyLimit: limit });
  const held = holdGhExecutions(tracker);
  const requests = Array.from({ length: 3 }, (_, index) => (
    tracker.execute(['api', `repos/example/project/${index}`])
  ));
  await settleGhExecutions();
  assert.equal(held.started.length, 1);

  limit = 3;
  held.finishNext();
  await settleGhExecutions();
  assert.equal(held.started.length, 3);
  while (held.pending.length) {
    held.finishNext();
    await settleGhExecutions();
  }
  await Promise.all(requests);
});

test('実行中に gh の上限を下げても既存処理を止めず、新しい上限を下回るまで待ち行列から起動しない', async (t) => {
  const { state, tracker } = await trackerFixture(t, []);
  let limit = 3;
  state.getDisplayPreferences = () => ({ ghConcurrencyLimit: limit });
  const held = holdGhExecutions(tracker);
  const requests = Array.from({ length: 4 }, (_, index) => (
    tracker.execute(['api', `repos/example/project/${index}`])
  ));
  await settleGhExecutions();
  assert.equal(held.started.length, 3);

  limit = 1;
  held.finishNext();
  await settleGhExecutions();
  assert.equal(held.started.length, 3);
  held.finishNext();
  await settleGhExecutions();
  assert.equal(held.started.length, 3);
  held.finishNext();
  await settleGhExecutions();
  assert.equal(held.started.length, 4);
  held.finishNext();
  await settleGhExecutions();
  await Promise.all(requests);
});

test('初回の PR 取得中を snapshot に示し、成功と失敗の完了後に外す', async (t) => {
  const success = await trackerFixture(t, [31]);
  const firstFetch = success.tracker.refreshRepo('example', 'project');
  const pending = success.tracker.snapshot();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].loading, true);
  await firstFetch;
  assert.equal(success.tracker.snapshot()[0].loading, false);

  const failure = await trackerFixture(t, [32]);
  failure.tracker.execFileImpl = (_file, _args, _options, callback) => callback(new Error('GitHub unavailable'));
  const failedFetch = failure.tracker.refreshRepo('example', 'project');
  assert.equal(failure.tracker.snapshot()[0].loading, true);
  await failedFetch;
  const [failedGroup] = failure.tracker.snapshot();
  assert.equal(failedGroup.loading, false);
  assert.match(failedGroup.error, /PR の一覧を取得できません/);
});

test('同じリポジトリで登録が消えたプロダクトの表示用データだけを refreshRepo で消す', async (t) => {
  const { state, tracker } = await trackerFixture(t, []);
  state.registerPullRequest('session-a', { url: 'https://github.com/example/project/pull/31' }, {
    product: { key: 'product\0with-null', name: 'Product A' },
  });
  state.registerPullRequest('session-b', { url: 'https://github.com/example/project/pull/32' }, {
    product: { key: 'product-b', name: 'Product B' },
  });
  await tracker.refreshRepo('example', 'project');
  assert.deepEqual(tracker.snapshot().map((group) => group.product.key).sort(), ['product-b', 'product\0with-null'].sort());

  state.deleteStoredSession('session-a');
  const versionBeforeRefresh = state.version;
  await tracker.refreshRepo('example', 'project');

  assert.deepEqual(tracker.snapshot().map((group) => group.product.key), ['product-b']);
  assert.ok(state.version > versionBeforeRefresh);
});

test('gh pr view で検出したマージの最終 head を lastOpen と分けて保存する', async (t) => {
  const { state, github, tracker } = await trackerFixture(t, [30]);
  const previousHead = 'a'.repeat(40);
  const mergedHead = 'b'.repeat(40);
  github.openPullRequests = [ghPullRequest(30, 'feat/parent', 'main', previousHead)];
  await tracker.refreshRepo('example', 'project');

  github.openPullRequests = [];
  github.views.set(30, {
    ...ghPullRequest(30, 'feat/parent', 'main', mergedHead),
    state: 'MERGED',
    mergedAt: '2026-10-03T11:59:00.000Z',
  });
  await tracker.refreshRepo('example', 'project');

  const record = state.pullRequestRegistrationForSession('session-30', 'example', 'project', 30);
  assert.equal(record.lastOpen.headRefOid, previousHead);
  assert.deepEqual(record.mergedHead, {
    headRefOid: mergedHead,
    headRefName: 'feat/parent',
    baseRefName: 'main',
  });
});

test('一覧にないマージ済み PR の最終 head から比較 base をたどり積み直しを検出する', async (t) => {
  const { state, github, calls, tracker } = await trackerFixture(t, [30]);
  const previousHead = 'a'.repeat(40);
  const mergedHead = 'b'.repeat(40);
  const childHead = 'c'.repeat(40);
  github.openPullRequests = [ghPullRequest(30, 'feat/parent', 'main', previousHead)];
  await tracker.refreshRepo('example', 'project');

  github.openPullRequests = [];
  github.views.set(30, {
    ...ghPullRequest(30, 'feat/parent', 'main', mergedHead),
    state: 'MERGED',
    mergedAt: '2026-10-03T11:59:00.000Z',
  });
  await tracker.refreshRepo('example', 'project');

  github.openPullRequests = [ghPullRequest(31, 'feat/child', 'feat/parent', childHead)];
  github.branchHeads.set('feat/parent', mergedHead);
  github.comparisons.set(`main...${childHead}`, compareResult([mergedHead, childHead]));
  github.comparisons.set(`feat/parent...${childHead}`, compareResult([childHead]));
  await tracker.refreshRepo('example', 'project');

  assert.ok(calls.some((args) => args[0] === 'api' && args[1].endsWith(`/compare/main...${childHead}`)));
  assert.equal(tracker.repositoryState('example', 'project').restackResults.get(31).parent.number, 30);
  assert.deepEqual(state.pullRequestRegistrationForSession('session-30', 'example', 'project', 30).mergedHead, {
    headRefOid: mergedHead,
    headRefName: 'feat/parent',
    baseRefName: 'main',
  });
});

test('確定済み head の印がない記録は積み直し候補にしない', async (t) => {
  const { state, github, tracker } = await trackerFixture(t, [30]);
  const unconfirmedHead = 'a'.repeat(40);
  const childHead = 'b'.repeat(40);
  const mergedAt = '2026-10-03T11:00:00.000Z';
  state.updatePullRequest('session-30', 'example', 'project', 30, {
    state: 'merged',
    mergedAt,
    lastOpen: {
      title: 'PR 30',
      url: 'https://github.com/example/project/pull/30',
      headRefName: 'feat/parent',
      baseRefName: 'main',
      headRefOid: unconfirmedHead,
    },
  });
  github.openPullRequests = [ghPullRequest(31, 'feat/child', 'main', childHead)];
  github.comparisons.set(`main...${childHead}`, compareResult([unconfirmedHead, childHead]));

  await tracker.refreshRepo('example', 'project');

  assert.equal(state.pullRequestRegistrationForSession('session-30', 'example', 'project', 30).mergedHead, undefined);
  assert.equal(tracker.repositoryState('example', 'project').restackResults.get(31).parent, null);
});

test('スカッシュした親のコミットはbaseをmainに変えても残り、pushで消える', async (t) => {
  const { github, calls, unexpectedCalls, tracker, state } = await trackerFixture(t);
  const parentSha = 'a'.repeat(40);
  const originalChildSha = 'b'.repeat(40);
  const pushedChildSha = 'c'.repeat(40);
  github.openPullRequests = [
    ghPullRequest(31, 'feat/child', 'feat/parent', originalChildSha),
    ghPullRequest(30, 'feat/parent', 'main', parentSha),
  ];
  github.comparisons.set(originalChildSha, compareResult([parentSha, originalChildSha]));
  await tracker.refreshRepo('example', 'project');
  assert.ok(calls.some((args) => args[0] === 'api' && args[1].endsWith(`/compare/main...${originalChildSha}`)));
  const [related] = state.relatedPullRequestRegistrationsForRepo('example', 'project');
  assert.equal(related.number, 30);
  assert.equal(related.lastOpen.headRefName, 'feat/parent');
  assert.equal(related.lastOpen.baseRefName, 'main');
  assert.equal(related.lastOpen.headRefOid, parentSha);
  const [firstGroup] = tracker.snapshot();
  assert.equal(firstGroup.registeredCount, 1);
  assert.equal(firstGroup.openCount, 2);
  github.openPullRequests = [ghPullRequest(31, 'feat/child', 'main', originalChildSha)];
  github.mergedPullRequests = [mergedPullRequest(30, parentSha)];
  github.comparisons.set(originalChildSha, compareResult([parentSha, originalChildSha]));
  github.views.set(30, { state: 'MERGED', mergedAt: '2026-10-03T11:59:00Z', headRefOid: parentSha });
  await tracker.refreshRepo('example', 'project');
  let [group] = tracker.snapshot();
  assert.equal(group.trees[0].baseRefName, 'main');
  assert.equal(group.trees[0].needsRestack, true);
  assert.equal(group.trees[0].blocker, '積み直し待ち (#30 が main に入った後も、そのコミットが差分に残っている)');

  github.openPullRequests = [ghPullRequest(31, 'feat/child', 'main', pushedChildSha)];
  github.comparisons.set(pushedChildSha, compareResult([pushedChildSha]));
  await tracker.refreshRepo('example', 'project');
  [group] = tracker.snapshot();
  assert.equal(group.trees[0].needsRestack, false);
  assert.equal(group.trees[0].blocker, null);
  assert.equal(calls.filter((args) => args[0] === 'pr' && args[1] === 'list' && args[args.indexOf('--state') + 1] === 'merged').length, 3);
  assert.equal(calls.filter((args) => args[0] === 'api' && args[1].includes('/compare/')).length, 4);
  assert.ok(calls.some((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === '30'));
  assert.deepEqual(unexpectedCalls, []);
  assert.equal(state.relatedPullRequestRegistrationsForRepo('example', 'project')[0].state, 'merged');
  const mergedListCall = calls.find((args) => args[0] === 'pr' && args[1] === 'list' && args[args.indexOf('--state') + 1] === 'merged');
  assert.deepEqual(mergedListCall, [
    'pr', 'list', '-R', 'example/project', '--state', 'merged', '--limit', '1000', '--json', 'number,headRefOid,headRefName,baseRefName,mergedAt',
  ]);
});

test('関連 PR の CI が pending から fail に変わると表示グループごとに履歴へ記録する', async (t) => {
  const { state, github, tracker } = await trackerFixture(t, []);
  const productA = { key: 'C:\\project-a', name: 'project-a' };
  const productB = { key: 'C:\\project-b', name: 'project-b' };
  state.registerPullRequest('session-a', { url: 'https://github.com/example/project/pull/31' }, { product: productA });
  state.registerPullRequest('session-b', { url: 'https://github.com/example/project/pull/32' }, { product: productB });
  const parent = (statusCheckRollup) => ({
    ...ghPullRequest(30, 'feat/parent', 'main', 'a'.repeat(40)),
    statusCheckRollup,
  });
  github.openPullRequests = [
    ghPullRequest(31, 'feat/child-a', 'feat/parent', 'b'.repeat(40)),
    ghPullRequest(32, 'feat/child-b', 'feat/parent', 'c'.repeat(40)),
    parent([{ state: 'IN_PROGRESS', conclusion: '' }]),
  ];

  await tracker.refreshRepo('example', 'project');
  assert.equal(state.relatedPullRequestRegistrationsForRepo('example', 'project')
    .find((record) => record.number === 30).lastOpen.ci, 'pending');

  github.openPullRequests = [
    ghPullRequest(31, 'feat/child-a', 'feat/parent', 'b'.repeat(40)),
    ghPullRequest(32, 'feat/child-b', 'feat/parent', 'c'.repeat(40)),
    parent([{ state: 'COMPLETED', conclusion: 'FAILURE' }]),
  ];
  await tracker.refreshRepo('example', 'project');

  assert.deepEqual(state.ciFailures.filter((failure) => failure.number === 30)
    .map((failure) => failure.product.key).sort(), [productA.key, productB.key].sort());
});

test('常駐サーバーが見ていない親でも merged 一覧と compare から積み直し待ちを判定する', async (t) => {
  const { github, tracker } = await trackerFixture(t);
  const childSha = 'b'.repeat(40);
  const oldestParentSha = 'a'.repeat(40);
  const newerParentSha = 'c'.repeat(40);
  github.openPullRequests = [ghPullRequest(31, 'feat/child', 'main', childSha)];
  github.mergedPullRequests = [
    mergedPullRequest(29, newerParentSha, '2026-10-03T11:30:00.000Z'),
    mergedPullRequest(30, oldestParentSha, '2026-10-03T11:00:00.000Z'),
  ];
  github.comparisons.set(childSha, compareResult([oldestParentSha, newerParentSha, childSha]));

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.equal(group.trees[0].needsRestack, true);
  assert.equal(group.trees[0].restackPr, 30);
  assert.equal(group.trees[0].blocker, '積み直し待ち (#30 が main に入った後も、そのコミットが差分に残っている)');
});

test('merge commit の親コミットが差分に残らなければ積み直し待ちにならない', async (t) => {
  const { github, tracker } = await trackerFixture(t);
  const childSha = 'b'.repeat(40);
  const parentSha = 'a'.repeat(40);
  github.openPullRequests = [ghPullRequest(31, 'feat/child', 'main', childSha)];
  github.mergedPullRequests = [mergedPullRequest(30, parentSha)];
  github.comparisons.set(childSha, compareResult([childSha]));

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.equal(group.trees[0].needsRestack, false);
  assert.equal(group.trees[0].canMerge, true);
  assert.equal(group.trees[0].blocker, null);
});

test('集約ブランチを base にした PR は集約ブランチとの差分で積み直しを判定する', async (t) => {
  const { github, calls, tracker } = await trackerFixture(t);
  const childSha = 'b'.repeat(40);
  const parentSha = 'a'.repeat(40);
  const compareBase = 'codex/feature';
  github.openPullRequests = [ghPullRequest(31, 'feat/child', compareBase, childSha)];
  github.mergedPullRequests = [mergedPullRequest(30, parentSha, '2026-10-03T11:00:00.000Z', 'feat/parent', compareBase)];
  github.comparisons.set(`main...${childSha}`, compareResult([parentSha, childSha]));
  github.comparisons.set(`${compareBase}...${childSha}`, compareResult([childSha]));

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.equal(group.trees[0].needsRestack, false);
  assert.ok(calls.some((args) => args[0] === 'api' && args[1].endsWith(`/compare/codex%2Ffeature...${childSha}`)));
  assert.equal(group.trees[0].blocker, null);
  assert.equal(group.trees[0].mergeTarget, 'codex/feature');
});

test('比較経路に含まれない既定ブランチへマージした PR の head は積み直し扱いにしない', async (t) => {
  const { github, tracker } = await trackerFixture(t, [31, 32]);
  const mainMergedSha = 'a'.repeat(40);
  const syncSha = 'b'.repeat(40);
  const childSha = 'c'.repeat(40);
  const aggregateBranch = 'codex/feature';
  const syncBranch = 'codex/sync-main-2026-10-03';
  github.openPullRequests = [
    ghPullRequest(31, syncBranch, aggregateBranch, syncSha),
    ghPullRequest(32, 'feat/child', syncBranch, childSha),
  ];
  github.mergedPullRequests = [mergedPullRequest(235, mainMergedSha, '2026-10-03T11:00:00.000Z', 'feat/main-pr', 'main')];
  github.comparisons.set(`${aggregateBranch}...${syncSha}`, compareResult([mainMergedSha, syncSha]));
  github.comparisons.set(`${aggregateBranch}...${childSha}`, compareResult([mainMergedSha, syncSha, childSha]));

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  const pullRequests = [group.trees[0], ...group.trees[0].children];
  assert.deepEqual(pullRequests.map((pullRequest) => pullRequest.number), [31, 32]);
  assert.deepEqual(pullRequests.map((pullRequest) => pullRequest.needsRestack), [false, false]);
});

test('親が親ブランチへマージされた後にその親ブランチが既定ブランチへ入っても積み直しを検出する', async (t) => {
  const { github, tracker } = await trackerFixture(t);
  const parentHead = 'a'.repeat(40);
  const intermediateHead = 'b'.repeat(40);
  const childHead = 'c'.repeat(40);
  github.openPullRequests = [ghPullRequest(32, 'feat/child', 'main', childHead)];
  github.mergedPullRequests = [
    mergedPullRequest(30, parentHead, '2026-10-03T11:00:00.000Z', 'feat/parent', 'feat/intermediate'),
    mergedPullRequest(31, intermediateHead, '2026-10-03T11:30:00.000Z', 'feat/intermediate', 'main'),
  ];
  github.comparisons.set(`main...${childHead}`, compareResult([parentHead, childHead]));

  await tracker.refreshRepo('example', 'project');

  const result = tracker.repositoryState('example', 'project').restackResults.get(32);
  assert.equal(result.checked, true);
  assert.equal(result.parent.number, 30);
});

test('過去の既定ブランチから集約ブランチへの同期をたどって無関係な PR を親にしない', async (t) => {
  const { github, tracker } = await trackerFixture(t);
  const unrelatedHead = 'a'.repeat(40);
  const childHead = 'c'.repeat(40);
  const aggregateBranch = 'codex/feature';
  github.openPullRequests = [ghPullRequest(32, 'feat/child', aggregateBranch, childHead)];
  github.mergedPullRequests = [
    mergedPullRequest(30, unrelatedHead, '2026-10-03T11:00:00.000Z', 'feat/unrelated', 'main'),
    mergedPullRequest(31, 'b'.repeat(40), '2026-10-03T11:30:00.000Z', 'main', aggregateBranch),
  ];
  github.comparisons.set(`${aggregateBranch}...${childHead}`, compareResult([unrelatedHead, childHead]));

  await tracker.refreshRepo('example', 'project');

  const result = tracker.repositoryState('example', 'project').restackResults.get(32);
  assert.equal(result.checked, true);
  assert.equal(result.parent, null);
});

test('比較経路より前にマージされた同名ブランチの PR は親経路に使わない', async (t) => {
  const { github, tracker } = await trackerFixture(t);
  const parentHead = 'a'.repeat(40);
  const childHead = 'c'.repeat(40);
  github.openPullRequests = [ghPullRequest(32, 'feat/child', 'main', childHead)];
  github.mergedPullRequests = [
    mergedPullRequest(30, 'b'.repeat(40), '2026-10-03T10:30:00.000Z', 'feat/parent', 'main'),
    mergedPullRequest(31, parentHead, '2026-10-03T11:00:00.000Z', 'feat/child-parent', 'feat/parent'),
  ];
  github.comparisons.set(`main...${childHead}`, compareResult([parentHead, childHead]));

  await tracker.refreshRepo('example', 'project');

  const result = tracker.repositoryState('example', 'project').restackResults.get(32);
  assert.equal(result.checked, true);
  assert.equal(result.parent, null);
});

test('同名ブランチのマージ経路が複数成立する場合は確認できない扱いにする', async (t) => {
  const { github, tracker } = await trackerFixture(t);
  const parentHead = 'a'.repeat(40);
  const childHead = 'c'.repeat(40);
  github.openPullRequests = [ghPullRequest(32, 'feat/child', 'main', childHead)];
  github.mergedPullRequests = [
    mergedPullRequest(30, parentHead, '2026-10-03T11:00:00.000Z', 'feat/parent-child', 'feat/parent'),
    mergedPullRequest(31, 'b'.repeat(40), '2026-10-03T11:30:00.000Z', 'feat/parent', 'main'),
    mergedPullRequest(33, 'd'.repeat(40), '2026-10-03T11:45:00.000Z', 'feat/parent', 'main'),
  ];
  github.comparisons.set(`main...${childHead}`, compareResult([parentHead, childHead]));

  await tracker.refreshRepo('example', 'project');

  const result = tracker.repositoryState('example', 'project').restackResults.get(32);
  assert.deepEqual(result, { checked: false, parent: null });
});

test('マージ済み PR の一覧が上限で切れている場合は間接の親を確定しない', async (t) => {
  const { github, tracker } = await trackerFixture(t);
  const parentHead = 'a'.repeat(40);
  const childHead = 'c'.repeat(40);
  github.openPullRequests = [ghPullRequest(32, 'feat/child', 'main', childHead)];
  github.mergedPullRequests = [
    mergedPullRequest(30, parentHead, '2026-10-03T11:00:00.000Z', 'feat/parent-child', 'feat/parent'),
    mergedPullRequest(31, 'b'.repeat(40), '2026-10-03T11:30:00.000Z', 'feat/parent', 'main'),
    ...Array.from({ length: 998 }, (_, index) => mergedPullRequest(
      index + 100,
      (index + 100).toString(16).padStart(40, '0'),
      `2026-10-03T12:${String(index % 60).padStart(2, '0')}:00.000Z`,
      `unrelated/${index}`,
      'main',
    )),
  ];
  github.comparisons.set(`main...${childHead}`, compareResult([parentHead, childHead]));

  await tracker.refreshRepo('example', 'project');

  assert.equal(github.mergedPullRequests.length, 1000);
  assert.deepEqual(tracker.repositoryState('example', 'project').restackResults.get(32), { checked: false, parent: null });
});

test('循環するブランチ名のマージ経路を積み直し親として扱わない', async (t) => {
  const { github, tracker } = await trackerFixture(t);
  const parentHead = 'a'.repeat(40);
  const childHead = 'c'.repeat(40);
  github.openPullRequests = [ghPullRequest(32, 'feat/child', 'main', childHead)];
  github.mergedPullRequests = [
    mergedPullRequest(30, parentHead, '2026-10-03T11:00:00.000Z', 'branch/b-child', 'branch/a'),
    mergedPullRequest(31, 'b'.repeat(40), '2026-10-03T11:30:00.000Z', 'branch/a', 'branch/b'),
    mergedPullRequest(33, 'd'.repeat(40), '2026-10-03T11:45:00.000Z', 'branch/b', 'branch/a'),
  ];
  github.comparisons.set(`main...${childHead}`, compareResult([parentHead, childHead]));

  await tracker.refreshRepo('example', 'project');

  const result = tracker.repositoryState('example', 'project').restackResults.get(32);
  assert.equal(result.checked, true);
  assert.equal(result.parent, null);
});

test('マージ後に head が進んだ集約ブランチは比較 base と実効 base に使う', async (t) => {
  const { state, github, calls, tracker } = await trackerFixture(t);
  const childSha = 'b'.repeat(40);
  const mergedSha = 'a'.repeat(40);
  const liveSha = 'c'.repeat(40);
  const branch = 'codex/feature';
  github.openPullRequests = [ghPullRequest(31, 'feat/child', branch, childSha)];
  github.branchHeads.set(branch, liveSha);
  github.comparisons.set(`${branch}...${childSha}`, compareResult([childSha]));
  github.comparisons.set(`main...${childSha}`, compareResult([mergedSha, childSha]));
  rememberHistoricalMerge(state, 30, branch, 'main', mergedSha, '2026-10-03T11:00:00.000Z', true);

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.equal(group.trees[0].effectiveBase, branch);
  assert.equal(group.trees[0].needsRestack, false);
  assert.equal(group.trees[0].blocker, 'base の codex/feature はマージ済みの PR の head のため、ダッシュボードではマージしない');
  assert.ok(calls.some((args) => args[0] === 'api' && args[1].endsWith(`/compare/codex%2Ffeature...${childSha}`)));
  assert.ok(!calls.some((args) => args[0] === 'api' && args[1].endsWith(`/compare/main...${childSha}`)));
  assert.equal(calls.filter((args) => args[0] === 'api' && args[1].includes('/git/ref/heads/')).length, 1);
  const registration = state.pullRequestRegistrationsForRepo('example', 'project').find((record) => record.number === 31);
  assert.equal(tracker.mergeCandidate(registration).pullRequest.blocker, group.trees[0].blocker);
});

for (const { label, currentHead } of [
  { label: 'マージ時と同じ head', currentHead: 'a'.repeat(40) },
  { label: 'リモートブランチが 404', currentHead: null },
]) {
  test(`${label} ならマージ済み PR の base までたどる`, async (t) => {
    const { github, calls, tracker } = await trackerFixture(t);
    const childSha = 'b'.repeat(40);
    const mergedSha = 'a'.repeat(40);
    const branch = 'codex/feature';
    github.openPullRequests = [ghPullRequest(31, 'feat/child', branch, childSha)];
    github.mergedPullRequests = [mergedPullRequest(30, mergedSha, '2026-10-03T11:00:00.000Z', branch, 'main')];
    if (currentHead) github.branchHeads.set(branch, currentHead);
    github.comparisons.set(`main...${childSha}`, compareResult([childSha]));

    await tracker.refreshRepo('example', 'project');

    assert.ok(calls.some((args) => args[0] === 'api' && args[1].endsWith(`/compare/main...${childSha}`)));
    assert.ok(!calls.some((args) => args[0] === 'api' && args[1].endsWith(`/compare/codex%2Ffeature...${childSha}`)));
  });
}

test('ブランチ head の取得に失敗すると積み直し判定を不明にする', async (t) => {
  const { github, tracker } = await trackerFixture(t);
  const childSha = 'b'.repeat(40);
  const branch = 'codex/feature';
  github.openPullRequests = [ghPullRequest(31, 'feat/child', branch, childSha)];
  github.mergedPullRequests = [mergedPullRequest(30, 'a'.repeat(40), '2026-10-03T11:00:00.000Z', branch, 'main')];
  github.branchHeadErrors.set(branch, new Error('HTTP 403: Forbidden'));

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.equal(group.trees[0].restackCheckUnknown, true);
  assert.match(group.error, /#31 の積み直し状態を確認できません/);
});

test('同じ base の PR が複数あってもブランチ head は一度だけ取得する', async (t) => {
  const { github, calls, tracker } = await trackerFixture(t, [31, 32]);
  const branch = 'codex/feature';
  github.openPullRequests = [
    ghPullRequest(31, 'feat/child-one', branch, 'b'.repeat(40)),
    ghPullRequest(32, 'feat/child-two', branch, 'c'.repeat(40)),
  ];
  github.mergedPullRequests = [mergedPullRequest(30, 'a'.repeat(40), '2026-10-03T11:00:00.000Z', branch, 'main')];
  github.branchHeads.set(branch, 'd'.repeat(40));

  await tracker.refreshRepo('example', 'project');

  assert.equal(calls.filter((args) => args[0] === 'api' && args[1].includes('/git/ref/heads/')).length, 1);
});

test('base に対応するオープン PR の head は GitHub ref を取得せずにたどる', async (t) => {
  const { github, calls, tracker } = await trackerFixture(t);
  const branch = 'codex/feature';
  const childSha = 'b'.repeat(40);
  github.openPullRequests = [
    ghPullRequest(30, branch, 'main', 'a'.repeat(40)),
    ghPullRequest(31, 'feat/child', branch, childSha),
  ];
  github.mergedPullRequests = [mergedPullRequest(29, 'c'.repeat(40), '2026-10-03T11:00:00.000Z', branch, 'main')];

  await tracker.refreshRepo('example', 'project');

  assert.equal(calls.filter((args) => args[0] === 'api' && args[1].includes('/git/ref/heads/')).length, 0);
  assert.ok(calls.some((args) => args[0] === 'api' && args[1].endsWith(`/compare/main...${childSha}`)));
});

test('GitHub の一覧に無い関連 PR の履歴からもマージ済みの親をたどる', async (t) => {
  const { state, github, calls, tracker } = await trackerFixture(t);
  const childSha = 'b'.repeat(40);
  const parentSha = 'a'.repeat(40);
  const parentBranch = 'feat/parent';
  github.openPullRequests = [ghPullRequest(31, 'feat/child', parentBranch, childSha)];
  github.comparisons.set(`codex/feature...${childSha}`, compareResult([parentSha, childSha]));
  rememberHistoricalMerge(state, 30, parentBranch, 'codex/feature', parentSha, '2026-10-03T11:00:00.000Z');

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.equal(group.trees[0].needsRestack, true);
  assert.equal(group.trees[0].restackPr, 30);
  assert.ok(calls.some((args) => args[0] === 'api' && args[1].endsWith(`/compare/codex%2Ffeature...${childSha}`)));
});

test('集約ブランチへスカッシュマージされた親の head が差分に残れば積み直し待ちになる', async (t) => {
  const { github, tracker } = await trackerFixture(t);
  const childSha = 'b'.repeat(40);
  const parentSha = 'a'.repeat(40);
  const compareBase = 'codex/feature';
  github.openPullRequests = [ghPullRequest(31, 'feat/child', compareBase, childSha)];
  github.mergedPullRequests = [mergedPullRequest(30, parentSha, '2026-10-03T11:00:00.000Z', 'feat/parent', compareBase)];
  github.comparisons.set(`${compareBase}...${childSha}`, compareResult([parentSha, childSha]));

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.equal(group.trees[0].needsRestack, true);
  assert.equal(group.trees[0].restackPr, 30);
});

test('base がマージ済み PR の head なら、その PR の base までたどって比較する', async (t) => {
  const { github, calls, tracker } = await trackerFixture(t);
  const childSha = 'b'.repeat(40);
  const parentSha = 'a'.repeat(40);
  const compareBase = 'codex/feature';
  github.openPullRequests = [ghPullRequest(31, 'feat/child', 'feat/parent', childSha)];
  github.mergedPullRequests = [mergedPullRequest(30, parentSha, '2026-10-03T11:00:00.000Z', 'feat/parent', compareBase)];
  github.comparisons.set(`main...${childSha}`, compareResult([parentSha, childSha]));
  github.comparisons.set(`${compareBase}...${childSha}`, compareResult([childSha]));

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.equal(group.trees[0].needsRestack, false);
  assert.ok(calls.some((args) => args[0] === 'api' && args[1].endsWith(`/compare/codex%2Ffeature...${childSha}`)));
});

test('同じ head ブランチ名のマージ済み PR が複数あれば、最も新しいマージの base までたどる', async (t) => {
  const { calls, github, tracker } = await trackerFixture(t);
  const childSha = 'b'.repeat(40);
  github.openPullRequests = [ghPullRequest(31, 'feat/child', 'feat/reused', childSha)];
  github.mergedPullRequests = [
    mergedPullRequest(29, 'c'.repeat(40), '2026-10-03T10:00:00.000Z', 'feat/reused', 'release/old'),
    mergedPullRequest(30, 'a'.repeat(40), '2026-10-03T11:00:00.000Z', 'feat/reused', 'codex/feature'),
  ];

  await tracker.refreshRepo('example', 'project');

  assert.ok(calls.some((args) => args[0] === 'api' && args[1].endsWith(`/compare/codex%2Ffeature...${childSha}`)));
  assert.ok(!calls.some((args) => args[0] === 'api' && args[1].includes('/compare/release%2Fold...')));
});

test('マージ済み一覧の head/base 名が文字列でなくても積み直しを判定する', async (t) => {
  const { github, tracker } = await trackerFixture(t);
  const childSha = 'b'.repeat(40);
  const parentSha = 'a'.repeat(40);
  github.openPullRequests = [ghPullRequest(31, 'feat/child', 'main', childSha)];
  github.mergedPullRequests = [{
    ...mergedPullRequest(30, parentSha), headRefName: 30, baseRefName: null,
  }];
  github.comparisons.set(childSha, compareResult([parentSha, childSha]));

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.equal(group.error, null);
  assert.equal(group.trees[0].needsRestack, true);
  assert.equal(group.trees[0].restackPr, 30);
});

test('集約ブランチ上のオープン PR に積んだ子も集約ブランチとの差分で判定する', async (t) => {
  const { github, calls, tracker } = await trackerFixture(t);
  const compareBase = 'codex/feature';
  const parentSha = 'a'.repeat(40);
  const childSha = 'b'.repeat(40);
  github.openPullRequests = [
    ghPullRequest(30, 'feat/parent', compareBase, parentSha),
    ghPullRequest(31, 'feat/child', 'feat/parent', childSha),
  ];
  github.comparisons.set(`${compareBase}...${parentSha}`, compareResult([parentSha]));
  github.comparisons.set(`${compareBase}...${childSha}`, compareResult([childSha]));

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  const child = group.trees[0].children.find((pr) => pr.number === 31);
  assert.ok(child);
  assert.equal(child.needsRestack, false);
  assert.ok(calls.some((args) => args[0] === 'api' && args[1].endsWith(`/compare/codex%2Ffeature...${childSha}`)));
});

test('マージ可能件数は選択した条件に従い、レビュー不要の記録は同じ head だけで有効にする', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  const { state, github, tracker } = await trackerFixture(t, [31], root);
  const headSha = 'a'.repeat(40);
  const convergedRoot = await temporaryDirectory(t);
  await fs.mkdir(path.join(convergedRoot, '.git'));
  await installCrossReview(convergedRoot);
  state.registerPullRequest('session-converged', { url: 'https://github.com/example/project/pull/31' }, {
    cwd: convergedRoot, product: { key: 'project', name: 'project' },
  });
  github.openPullRequests = [ghPullRequest(31, 'feat/open', 'main', headSha)];
  github.openPullRequests[0].statusCheckRollup = [{ state: 'IN_PROGRESS', status: 'IN_PROGRESS' }];
  github.comparisons.set(headSha, compareResult([headSha]));

  await tracker.refreshRepo('example', 'project');
  let [group] = tracker.snapshot();
  assert.equal(group.trees[0].canMerge, true);
  assert.equal(group.trees[0].mergeConditionMet, false);
  assert.deepEqual(group.trees[0].mergeConditionWaits, ['CI 実行中', 'クロスレビュー未実施']);

  state.patchDisplayPreferences({ mergeableCondition: 'operation' });
  [group] = tracker.snapshot();
  assert.equal(group.trees[0].mergeConditionMet, true);
  assert.deepEqual(group.trees[0].mergeConditionWaits, []);
  assert.equal(group.mergeableCount, 1);

  state.patchDisplayPreferences({ mergeableCondition: 'ci' });
  [group] = tracker.snapshot();
  assert.equal(group.trees[0].mergeConditionMet, false);
  assert.deepEqual(group.trees[0].mergeConditionWaits, ['CI 実行中']);
  assert.equal(group.mergeableCount, 0);

  github.openPullRequests[0].statusCheckRollup = [{ state: 'SUCCESS', conclusion: 'SUCCESS' }];
  await tracker.refreshRepo('example', 'project');
  state.patchDisplayPreferences({ mergeableCondition: 'cross-review' });
  [group] = tracker.snapshot();
  assert.deepEqual(group.trees[0].mergeConditionWaits, ['クロスレビュー未実施']);
  assert.equal(group.mergeableCount, 0);

  await fs.writeFile(path.join(convergedRoot, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/open': { round: 2, dismissed: [], lastReviewedSha: headSha, lastTriage: { round: 1, sha: headSha, outcome: 'converged' } } },
  }));
  await tracker.refreshReviewGroups('example', 'project');
  [group] = tracker.snapshot();
  assert.deepEqual(group.trees[0].mergeConditionWaits, ['クロスレビュー対応中']);
  assert.equal(group.mergeableCount, 0);

  await fs.writeFile(path.join(convergedRoot, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/open': { round: 2, dismissed: [], lastReviewedSha: headSha, lastTriage: { round: 2, sha: headSha, outcome: 'converged' } } },
  }));
  await tracker.refreshReviewGroups('example', 'project');
  [group] = tracker.snapshot();
  assert.deepEqual(group.trees[0].mergeConditionWaits, []);
  assert.equal(group.mergeableCount, 1);

  state.setCrossReviewSkip({
    owner: 'example', repo: 'project', number: 31, headRefOid: headSha,
    reason: '変更が文言だけのため', recordedAt: new Date(1_790_000_000_000).toISOString(),
  });
  await tracker.refreshReviewGroups('example', 'project');
  [group] = tracker.snapshot();
  assert.deepEqual(group.trees[0].crossReview.triage, { round: 2, sha: headSha, outcome: 'converged' });
  assert.equal(group.mergeableCount, 1);

  const nextHead = 'b'.repeat(40);
  github.openPullRequests[0] = ghPullRequest(31, 'feat/open', 'main', nextHead);
  github.comparisons.set(nextHead, compareResult([nextHead]));
  await tracker.refreshRepo('example', 'project');
  [group] = tracker.snapshot();
  assert.equal(state.crossReviewSkip('example', 'project', 31), null);
  assert.notDeepEqual(group.trees[0].crossReview, { notRequired: true, source: 'recorded', reason: '変更が文言だけのため' });
  assert.deepEqual(group.trees[0].mergeConditionWaits, ['クロスレビュー後に push あり']);
});

test('閉じられた親のコミットは compare に残っていても積み直し待ちにしない', async (t) => {
  const { github, tracker } = await trackerFixture(t, [31, 30]);
  const childSha = 'b'.repeat(40);
  const parentSha = 'a'.repeat(40);
  github.openPullRequests = [ghPullRequest(31, 'feat/child', 'main', childSha)];
  github.comparisons.set(childSha, compareResult([parentSha, childSha]));
  github.views.set(30, { state: 'CLOSED', mergedAt: null, headRefOid: parentSha });

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.equal(stateRecord(tracker, 30).state, 'closed');
  assert.equal(group.trees[0].needsRestack, false);
  assert.equal(group.trees[0].canMerge, true);
});

function stateRecord(tracker, number) {
  return tracker.state.pullRequestRegistrations().find((record) => record.number === number);
}

test('compare の失敗と250件超では積み直しが必要か確かめられない', async (t) => {
  for (const condition of ['failure', 'truncated']) {
    const { github, tracker } = await trackerFixture(t);
    const childSha = 'b'.repeat(40);
    const parentSha = 'a'.repeat(40);
    github.openPullRequests = [ghPullRequest(31, 'feat/child', 'main', childSha)];
    github.mergedPullRequests = [mergedPullRequest(30, parentSha)];
    if (condition === 'failure') {
      github.compareErrors.add(childSha);
    } else {
      const commits = [parentSha, ...Array.from({ length: 249 }, (_, index) => (index + 1).toString(16).padStart(40, '0'))];
      github.comparisons.set(childSha, compareResult(commits, 251));
    }

    await tracker.refreshRepo('example', 'project');

    const [group] = tracker.snapshot();
    assert.equal(group.trees[0].restackCheckUnknown, true, condition);
    assert.equal(group.trees[0].blocker, '積み直しが必要か確かめられない', condition);
    assert.equal(group.trees[0].canMerge, false, condition);
    assert.equal(group.openStateUnknown, false, condition);
  }
});

test('状態を確かめられない PR を登録したプロダクトだけをオープンの PR を数えきれていないとする', async (t) => {
  const { state, github, tracker } = await trackerFixture(t, [31]);
  state.registerPullRequest('session-other', { url: 'https://github.com/example/project/pull/40' }, {
    cwd: process.cwd(), product: { key: 'other', name: 'other' },
  });
  github.openPullRequests = [ghPullRequest(31, 'feat/31', 'main', '3'.repeat(40))];

  await tracker.refreshRepo('example', 'project');

  const groups = new Map(tracker.snapshot().map((group) => [group.product.key, group]));
  assert.match(groups.get('project').error, /#40 の状態を確認できません/);
  assert.equal(groups.get('project').openStateUnknown, false);
  assert.equal(groups.get('other').openStateUnknown, true);
});

test('31件目以降の登録済みOPEN PRをgh pr viewから一覧へ補う', async (t) => {
  const homeDir = await temporaryDirectory(t);
  const state = new DashboardState({ homeDir });
  state.registerPullRequest('session-31', { url: 'https://github.com/example/project/pull/31' }, {
    cwd: process.cwd(), product: { key: 'project', name: 'project' },
  });
  const calls = [];
  const tracker = new PullRequestTracker({
    state,
    execFileImpl: (_file, args, _options, callback) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'list') callback(null, '[]');
      else if (args[0] === 'api' && args[1] === 'repos/example/project') {
        callback(null, JSON.stringify({ default_branch: 'main', allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: false }));
      } else if (args[0] === 'pr' && args[1] === 'view' && args[2] === '31') {
        callback(null, JSON.stringify({ ...ghPullRequest(31, 'feat/31', 'main', '1'.repeat(40)), state: 'OPEN' }));
      } else if (args[0] === 'api' && args[1].includes('/compare/')) {
        callback(null, JSON.stringify(compareResult()));
      } else callback(new Error(`unexpected gh arguments: ${args.join(' ')}`));
    },
  });

  await tracker.refreshRepo('example', 'project');
  const [group] = tracker.snapshot();
  const openListCall = calls.find((args) => args[0] === 'pr' && args[1] === 'list' && args[args.indexOf('--state') + 1] === 'open');
  assert.deepEqual(openListCall.slice(0, 8), [
    'pr', 'list', '-R', 'example/project', '--state', 'open', '--limit', '500',
  ]);
  assert.ok(openListCall.at(-1).includes('isCrossRepository'));
  const viewCall = calls.find((args) => args[0] === 'pr' && args[1] === 'view');
  assert.ok(viewCall.includes('number,title,url,headRefName,baseRefName,headRefOid,isCrossRepository,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,createdAt,state,mergedAt'));
  assert.equal(calls.filter((args) => args[0] === 'pr' && args[1] === 'list' && args[args.indexOf('--state') + 1] === 'merged').length, 1);
  assert.equal(calls.filter((args) => args[0] === 'api' && args[1].includes('/compare/')).length, 1);
  assert.equal(group.trees[0].number, 31);
  assert.equal(group.openCount, 1);
});

test('gh が失敗しても PR の取得理由を返し、登録状態を維持する', async (t) => {
  const homeDir = await temporaryDirectory(t);
  const state = new DashboardState({ homeDir });
  state.registerPullRequest('session-error', { url: 'https://github.com/example/project/pull/42' }, {
    cwd: process.cwd(), product: { key: 'project', name: 'project' },
  });
  const tracker = new PullRequestTracker({
    state,
    execFileImpl: (_file, _args, _options, callback) => {
      const error = Object.assign(new Error('missing'), { code: 'ENOENT' });
      callback(error);
    },
  });
  await tracker.refreshAll();
  const [group] = tracker.snapshot();
  assert.match(group.error, /gh コマンドが見つかりません/);
  assert.equal(group.openStateUnknown, true);
  assert.equal(group.registeredCount, 1);
  assert.deepEqual(group.trees, []);
});

test('マージできる PR の件数は、登録したセッションがありマージボタンが出る PR だけを数える', () => {
  const state = new DashboardState();
  state.patchDisplayPreferences({ mergeableCondition: 'operation' });
  const tracker = new PullRequestTracker({ state });
  const pullRequest = (number, mergeSessionId, children = []) => ({
    number, title: `PR ${number}`, url: `https://github.com/example/project/pull/${number}`,
    headRefName: `feat/${number}`, baseRefName: 'main', headRefOid: String(number).repeat(40).slice(0, 40),
    canMerge: true, mergeSessionId, children,
  });
  tracker.productViews = new Map([['project', {
    owner: 'example', repo: 'project', product: { key: 'project', name: 'Project' },
    mergeMethods: [], autoDeleteBranch: false, checkedAt: null, fetchedAt: null, error: null,
    registeredCount: 1, openCount: 2, mergeableCount: 0, trees: [pullRequest(1, 'session-1', [pullRequest(2, null)])], merged: [],
    mergeHistory: [], reservations: [], lastMethod: null,
  }]]);

  assert.equal(tracker.snapshot()[0].mergeableCount, 1);
});

test('PR の衝突依頼スナップショットは登録セッションの稼働状態を示し、head 変更後は依頼済み表示を外す', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_790_000_000_000 });
  const state = new DashboardState();
  const url = 'https://github.com/example/project/pull/42';
  for (const sessionId of ['conflict-live', 'conflict-ended']) {
    state.registerPullRequest(sessionId, { url }, { product: { key: 'project', name: 'Project' } }, 1_790_000_000_000);
  }
  state.endSession('conflict-ended', 1_790_000_000_000);
  state.recordPullRequestConflictRequest({
    owner: 'example', repo: 'project', number: 42, headRefOid: 'a'.repeat(40),
    requestedAt: new Date(1_790_000_000_000).toISOString(), sessionIds: ['conflict-live'],
  });

  const pullRequest = {
    number: 42,
    title: 'PR 42',
    url,
    headRefName: 'feature/conflict',
    baseRefName: 'main',
    headRefOid: 'a'.repeat(40),
    conflict: true,
    canMerge: false,
    children: [],
  };
  const tracker = new PullRequestTracker({ state });
  tracker.productViews = new Map([['project', {
    owner: 'example', repo: 'project', product: { key: 'project', name: 'Project' },
    mergeMethods: [], autoDeleteBranch: false, checkedAt: null, fetchedAt: null, error: null,
    registeredCount: 2, openCount: 1, mergeableCount: 0, trees: [pullRequest], merged: [],
    mergeHistory: [], reservations: [], lastMethod: null,
  }]]);

  let snapshot = tracker.snapshot()[0].trees[0];
  assert.deepEqual(snapshot.conflictRequestTargets, [
    { sessionId: 'conflict-live', alive: true },
    { sessionId: 'conflict-ended', alive: false },
  ]);
  assert.equal(snapshot.conflictRequestKey, state.pullRequestRegistrationKey(state.pullRequestRegistrationsForRepo('example', 'project')[0]));
  assert.deepEqual(snapshot.conflictRequest, { requestedAt: new Date(1_790_000_000_000).toISOString(), sessionIds: ['conflict-live'] });

  pullRequest.headRefOid = 'b'.repeat(40);
  snapshot = tracker.snapshot()[0].trees[0];
  assert.equal(Object.hasOwn(snapshot, 'conflictRequest'), false);
});

test('PR 登録は14日ちょうど保持し、期限を1ミリ秒過ぎると削除する', () => {
  const registeredAt = Date.parse('2026-10-03T00:00:00.000Z');
  const retentionMs = 14 * 24 * 60 * 60 * 1000;
  const state = new DashboardState();
  state.registerPullRequest('retention-boundary', {
    url: 'https://github.com/example/project/pull/43',
  }, {}, registeredAt);

  state.pruneExpiredStoreRecords(registeredAt + retentionMs);
  assert.equal(state.pullRequestRegistrations().length, 1);

  state.pruneExpiredStoreRecords(registeredAt + retentionMs + 1);
  assert.equal(state.pullRequestRegistrations().length, 0);
});

test('オープン一覧から消えた PR の状態を gh pr view で確認する', async (t) => {
  const homeDir = await temporaryDirectory(t);
  const state = new DashboardState({ homeDir });
  state.registerPullRequest('session-closed', { url: 'https://github.com/example/project/pull/52' }, {
    cwd: process.cwd(), product: { key: 'project', name: 'project' },
  });
  let includeOpenPullRequest = true;
  const calls = [];
  const tracker = new PullRequestTracker({
    state,
    now: () => Date.parse('2026-10-03T12:00:00.000Z'),
    execFileImpl: (_file, args, _options, callback) => {
      calls.push([...args]);
      if (args[0] === 'pr' && args[1] === 'list' && args[args.indexOf('--state') + 1] === 'open') {
        callback(null, JSON.stringify(includeOpenPullRequest ? [{
          number: 52, title: 'PR 52', url: 'https://github.com/example/project/pull/52',
          headRefName: 'feat/closed', baseRefName: 'main', headRefOid: '5'.repeat(40),
          isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
          reviewDecision: '', statusCheckRollup: [{ state: 'SUCCESS', conclusion: 'SUCCESS' }],
        }] : []));
      } else if (args[0] === 'pr' && args[1] === 'list' && args[args.indexOf('--state') + 1] === 'merged') {
        callback(null, '[]');
      } else if (args[0] === 'api' && args[1] === 'repos/example/project') {
        callback(null, JSON.stringify({
          default_branch: 'main', allow_merge_commit: true,
          allow_squash_merge: false, allow_rebase_merge: true, delete_branch_on_merge: false,
        }));
      } else if (args[0] === 'api' && args[1].includes('/compare/')) {
        callback(null, JSON.stringify(compareResult()));
      } else if (args[0] === 'pr' && args[1] === 'view') {
        callback(null, JSON.stringify({
          state: 'MERGED', mergedAt: '2026-10-03T11:59:00Z',
          headRefOid: '5'.repeat(40),
        }));
      } else {
        callback(new Error(`unexpected gh arguments: ${args.join(' ')}`));
      }
    },
  });

  await tracker.refreshRepo('example', 'project');
  includeOpenPullRequest = false;
  await tracker.refreshRepo('example', 'project');

  const viewCall = calls.find((args) => args[0] === 'pr' && args[1] === 'view' && args[2] === '52');
  assert.ok(viewCall);
  assert.equal(viewCall.at(-1), `${'number,title,url,headRefName,baseRefName,headRefOid,isCrossRepository,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,createdAt'},state,mergedAt`);
  assert.equal(Object.hasOwn(state.serializeStore(), 'mergedPrHeads'), false);
  const [group] = tracker.snapshot();
  assert.equal(group.defaultBranch, 'main');
  assert.deepEqual(group.mergeMethods, ['merge', 'rebase']);
  assert.equal(group.autoDeleteBranch, false);
  assert.equal(group.merged[0].state, 'merged');
});

test('delete_branch_on_merge が true のリポジトリ設定を snapshot に載せる', async (t) => {
  const homeDir = await temporaryDirectory(t);
  const state = new DashboardState({ homeDir });
  state.registerPullRequest('session-auto-delete', { url: 'https://github.com/example/project/pull/53' }, {
    cwd: process.cwd(), product: { key: 'project', name: 'project' },
  });
  state.updatePullRequest('session-auto-delete', 'example', 'project', 53, { state: 'merged' });
  const tracker = new PullRequestTracker({
    state,
    execFileImpl: (_file, args, _options, callback) => {
      if (args[0] === 'pr' && args[1] === 'list') {
        callback(null, '[]');
      } else if (args[0] === 'api' && args[1] === 'repos/example/project') {
        callback(null, JSON.stringify({
          default_branch: 'main', allow_merge_commit: true,
          allow_squash_merge: false, allow_rebase_merge: true, delete_branch_on_merge: true,
        }));
      } else {
        callback(new Error(`unexpected gh arguments: ${args.join(' ')}`));
      }
    },
  });

  await tracker.refreshRepo('example', 'project');

  assert.equal(tracker.repositories.get('example/project').autoDeleteBranch, true);
  assert.equal(tracker.snapshot()[0].autoDeleteBranch, true);
});

test('store.json は PR を version 1 で保存し、PR 項目のない旧形式も空として読む', async (t) => {
  const homeDir = await temporaryDirectory(t);
  const state = new DashboardState({ homeDir });
  state.registerPullRequest('session-store', { url: 'https://github.com/example/project/pull/44' }, {
    cwd: process.cwd(), product: { key: 'project', name: 'project' },
  });
  state.rememberRelatedPullRequest({
    owner: 'example', repo: 'project', number: 45,
    url: 'https://github.com/example/project/pull/45',
    lastOpen: {
      title: 'PR 45', url: 'https://github.com/example/project/pull/45',
      headRefName: 'feat/manual', baseRefName: 'main', headRefOid: '5'.repeat(40),
    },
  });
  await state.flushPersistence();
  const persisted = JSON.parse(await fs.readFile(path.join(homeDir, 'store.json'), 'utf8'));
  assert.equal(persisted.version, 1);
  assert.equal(persisted.prs[0].number, 44);
  assert.equal(persisted.relatedPrs[0].number, 45);
  assert.equal(Object.hasOwn(persisted, 'mergedPrHeads'), false);
  const restored = await DashboardState.load(homeDir);
  assert.equal(restored.pullRequestRegistrations()[0].url, 'https://github.com/example/project/pull/44');
  assert.equal(restored.relatedPullRequestRegistrations()[0].lastOpen.headRefOid, '5'.repeat(40));

  const oldHome = await temporaryDirectory(t);
  await fs.writeFile(path.join(oldHome, 'store.json'), JSON.stringify({
    version: 1, display: null, plans: {}, decisionLifecycles: {}, closedTasks: [], hiddenSessions: [],
  }));
  const oldState = await DashboardState.load(oldHome);
  assert.deepEqual(oldState.pullRequestRegistrations(), []);
  assert.equal((await fs.readdir(oldHome)).some((name) => name.startsWith('store.json.broken-')), false);
});

test('関連PRの保存記録は14日を過ぎると復元時に削除する', async (t) => {
  const homeDir = await temporaryDirectory(t);
  const now = Date.parse('2026-10-03T00:00:00.000Z');
  const state = new DashboardState({ homeDir });
  state.rememberRelatedPullRequest({
    owner: 'example', repo: 'project', number: 46,
    url: 'https://github.com/example/project/pull/46',
    lastOpen: {
      title: 'PR 46', url: 'https://github.com/example/project/pull/46',
      headRefName: 'feat/manual', baseRefName: 'main', headRefOid: '6'.repeat(40),
    },
  }, now - 14 * 24 * 60 * 60 * 1000 - 1);
  await state.flushPersistence();

  const restored = await DashboardState.load(homeDir, { now });
  assert.deepEqual(restored.relatedPullRequestRegistrations(), []);
});

async function installCrossReview(root) {
  await fs.mkdir(path.join(root, 'tools'), { recursive: true });
  await fs.writeFile(path.join(root, 'tools', 'cross-review.js'), '');
}

for (const fails of [false, true]) {
  test(`並行したレビュー再計算は次の回を共有し、古い head で上書きしない (先行失敗: ${fails})`, async (t) => {
    const { tracker, github } = await trackerFixture(t);
    tracker.readCrossReviewState = async () => null;
    github.openPullRequests = [ghPullRequest(31, 'feat/open', 'main', 'a'.repeat(40))];
    await tracker.refreshRepo('example', 'project');
    const pending = [];
    tracker.readCrossReviewState = () => new Promise((resolve, reject) => pending.push({ resolve, reject }));
    const first = tracker.refreshReviewGroups('example', 'project');
    const firstResult = fails ? assert.rejects(first, /read failed/) : first;
    const repo = tracker.repositories.get('example/project');
    tracker.repositories.set('example/project', { ...repo,
      openPullRequests: repo.openPullRequests.map(pr => ({ ...pr, headRefOid: 'b'.repeat(40) })) });
    const second = tracker.refreshReviewGroups('example', 'project');
    const third = tracker.refreshReviewGroups('example', 'project');
    assert.equal(pending.length, 1);
    if (fails) pending.shift().reject(new Error('read failed'));
    else pending.shift().resolve(null);
    await firstResult;
    await new Promise(setImmediate);
    assert.equal(pending.length, 1);
    let finished = false;
    second.then(() => { finished = true; });
    await new Promise(setImmediate);
    assert.equal(finished, false);
    const fourth = tracker.refreshReviewGroups('example', 'project');
    pending.shift().resolve(null);
    await Promise.all([second, third]);
    await new Promise(setImmediate);
    assert.equal(pending.length, 1);
    pending.shift().resolve(null);
    await fourth;
    assert.equal(tracker.snapshot()[0].trees[0].headRefOid, 'b'.repeat(40));
    assert.equal(pending.length, 0);
  });
}

test('消えた cwd から元のリポジトリの道具を検出し、探索結果を10分間使い回す', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  const cwd = path.join(root, '.claude', 'worktrees', 'removed');
  for (const code of ['ENOENT', 'ENOTDIR']) {
    const calls = [];
    const fileSystem = { async stat(file) {
      calls.push(file);
      if (file === cwd) throw Object.assign(new Error('missing'), { code });
      return fs.stat(file);
    } };
    const results = new Map();
    assert.equal(await crossReviewToolExists(cwd, fileSystem, results, 1000), true);
    assert.ok(calls.includes(path.join(root, '.git')));
    assert.deepEqual(results.get(cwd), { exists: true, checkedAt: 1000 });
    calls.length = 0;
    assert.equal(await crossReviewToolExists(cwd, fileSystem, results, 2000), true);
    assert.deepEqual(calls, [cwd]);
    calls.length = 0;
    assert.equal(await crossReviewToolExists(cwd, fileSystem, results, 601001), true);
    assert.ok(calls.includes(path.join(root, '.git')));
  }
});

test('消えた cwd の道具なしも使い回し、cwd が実在すれば毎回確認する', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  const cwd = path.join(root, 'missing');
  const results = new Map();
  assert.equal(await crossReviewToolExists(cwd, fs, results, 1000), false);
  await installCrossReview(root);
  assert.equal(await crossReviewToolExists(cwd, fs, results, 2000), false);
  await fs.mkdir(cwd);
  assert.equal(await crossReviewToolExists(cwd, fs, results, 3000), true);
  await fs.unlink(path.join(root, 'tools', 'cross-review.js'));
  assert.equal(await crossReviewToolExists(cwd, fs, results, 4000), false);
});

test('別リポジトリのレビュー再計算は実行中のリポジトリを待たない', async (t) => {
  const { tracker, github, state } = await trackerFixture(t);
  tracker.readCrossReviewState = async () => null;
  github.openPullRequests = [ghPullRequest(31, 'feat/open', 'main', 'a'.repeat(40))];
  await tracker.refreshRepo('example', 'project');
  state.registerPullRequest('other-session', { url: 'https://github.com/example/other/pull/31' }, {
    cwd: process.cwd(), product: { key: 'other', name: 'other' },
  });
  tracker.repositories.set('example/other', tracker.repositories.get('example/project'));
  let release;
  tracker.readCrossReviewState = registration => registration.session_id === 'other-session'
    ? Promise.resolve(null) : new Promise(resolve => { release = resolve; });
  const running = tracker.refreshReviewGroups('example', 'project');
  try {
    await tracker.refreshReviewGroups('example', 'other');
    assert.ok(tracker.snapshot().some(group => group.repo === 'other'));
  } finally { release(null); await running; }
});

test('base に統合したレビュー記録を未実施として診断し、同じ再計算では照合を使い回す', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({ branches: {
    'feat/open': { round: 1, dismissed: [], lastTriage: { round: 1, sha: 'a'.repeat(40), outcome: 'converged' } },
  } }));
  const reports = [];
  let comparisons = 0;
  const options = { baseAncestorCache: new Map(), observeReview: (_record, report) => reports.push(report),
    execFileImpl: (_file, args, _options, callback) => {
      if (args[2] === 'config') callback(null, 'remote.origin.url https://github.com/example/project.git\n');
      else if (args[2] === 'rev-parse') callback(null, 'b'.repeat(40));
      else if (args[2] === 'merge-base') { comparisons += 1; callback(null, ''); }
      else callback(new Error('unexpected git call'));
    } };
  const pr = { url: 'https://github.com/example/project/pull/31', headRefName: 'feat/open',
    baseRefName: 'main', headRefOid: 'c'.repeat(40) };
  for (let index = 0; index < 2; index += 1) {
    assert.equal(await readCrossReviewState({ cwd: root, number: 31 }, pr, options), null);
  }
  assert.equal(comparisons, 1);
  assert.ok(reports.every(report => report.failure === 'stale-record'));
});

test('base に含まれないか Git が照合できないレビュー記録は維持する', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({ branches: {
    'feat/open': { round: 1, dismissed: [], lastReviewedSha: 'a'.repeat(40) },
  } }));
  for (const code of [1, 128, 'EPERM']) {
    const review = await readCrossReviewState({ cwd: root, number: 31 }, {
      url: 'https://github.com/example/project/pull/31', headRefName: 'feat/open',
      baseRefName: 'main', headRefOid: 'c'.repeat(40),
    }, { execFileImpl: (_file, args, _options, callback) => {
      if (args[2] === 'config') callback(null, 'remote.origin.url https://github.com/example/project.git\n');
      else if (args[2] === 'rev-parse') callback(null, 'b'.repeat(40));
      else callback(Object.assign(new Error('cannot establish ancestry'), { code }));
    } });
    assert.equal(review.reviewedSha, 'a'.repeat(40));
  }
});

test('--uncommitted のレビューで lastReviewedSha が base に残っていても、今の head の収束は記録として残す', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({ branches: {
    'feat/open': { round: 2, dismissed: [], lastReviewedSha: 'a'.repeat(40),
      lastTriage: { round: 2, sha: 'c'.repeat(40), outcome: 'converged' } },
  } }));
  const review = await readCrossReviewState({ cwd: root, number: 31 }, {
    url: 'https://github.com/example/project/pull/31', headRefName: 'feat/open',
    baseRefName: 'main', headRefOid: 'c'.repeat(40),
  }, { execFileImpl: (_file, args, _options, callback) => {
    if (args[2] === 'config') callback(null, 'remote.origin.url https://github.com/example/project.git\n');
    else if (args[2] === 'rev-parse') callback(null, 'b'.repeat(40));
    else if (args[2] === 'merge-base') callback(args[4] === 'a'.repeat(40) ? null : Object.assign(new Error('not ancestor'), { code: 1 }), '');
    else callback(new Error('unexpected git call'));
  } });
  assert.deepEqual(review.triage, { round: 2, sha: 'c'.repeat(40), outcome: 'converged' });
});

for (const merged of [true, false]) {
  test(`別 worktree のレビュー記録は統合済みなら未実施にし、rebase した同じ PR なら残す (統合済み: ${merged})`, async (t) => {
    const root = await temporaryDirectory(t);
    const git = (...args) => execFileSync('git', ['-C', root, ...args], {
      encoding: 'utf8', windowsHide: true,
      env: { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: path.join(root, 'no-config') },
    }).trim();
    git('init', '-b', 'main');
    git('config', 'user.name', 'Test');
    git('config', 'user.email', 'test@example.invalid');
    await installCrossReview(root);
    git('add', 'tools/cross-review.js');
    git('commit', '-m', 'initial');
    git('checkout', '-b', 'old-review');
    git('commit', '--allow-empty', '-m', 'reviewed');
    const reviewedSha = git('rev-parse', 'HEAD');
    git('checkout', 'main');
    if (merged) git('merge', '--no-ff', 'old-review', '-m', 'merged');
    else git('commit', '--allow-empty', '-m', 'base advanced');
    git('remote', 'add', 'origin', 'https://github.com/example/project.git');
    git('update-ref', 'refs/remotes/origin/main', git('rev-parse', 'main'));
    const other = path.join(root, 'other');
    git('worktree', 'add', '-b', 'feat/open', other, merged ? 'main' : 'old-review');
    if (!merged) git('-C', other, 'rebase', '--force-rebase', 'main');
    git('-C', other, 'commit', '--allow-empty', '-m', 'new head');
    await fs.writeFile(path.join(other, '.cross-review-state.json'), JSON.stringify({ branches: {
      'feat/open': { round: 1, dismissed: [], lastReviewedSha: reviewedSha },
    } }));
    const { tracker, github } = await trackerFixture(t, [31], root);
    github.openPullRequests = [ghPullRequest(31, 'feat/open', 'main', git('-C', other, 'rev-parse', 'HEAD'))];
    const reports = [];
    tracker.diagnostics = { record: (...args) => reports.push(args) };
    await tracker.refreshRepo('example', 'project');
    const review = tracker.snapshot()[0].trees[0].crossReview;
    if (merged) {
      assert.equal(review, null);
      assert.ok(reports.some(args => args[3]?.failure === 'stale-record'));
    } else assert.equal(review.reviewedSha, reviewedSha);
  });
}

test('どの GitHub の remote とも PR のリポジトリが一致しないとクロスレビュー状態を確認不能にする', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/pr': { round: 1, dismissed: [], lastReviewedSha: 'a'.repeat(40) } },
  }));
  const calls = [];
  const review = await readCrossReviewState(
    { number: 55, cwd: root },
    { url: 'https://github.com/example/project/pull/55', headRefName: 'feat/pr' },
    { execFileImpl: (file, args, _options, callback) => {
      calls.push([file, ...args]);
      callback(null, [
        'remote.origin.url git@github.com:other/project.git',
        'remote.upstream.url https://github.com/another/project.git',
      ].join('\n') + '\n');
    } },
  );

  assert.deepEqual(calls, [['git', '-C', root, 'config', '--get-regexp', '^remote\\..*\\.url$']]);
  assert.deepEqual(review, { unavailable: true, reason: 'repository-mismatch' });
});

test('クロスレビューの道具が無い worktree でも、remote が PR のリポジトリと食い違えばレビュー不要にせず確認不能にする', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  const remotes = (_file, args, _options, callback) => callback(null, args[2] === 'ls-tree' ? '' : 'remote.origin.url https://github.com/other/tool-less.git\n');
  const mismatched = await readCrossReviewState(
    { number: 55, cwd: root },
    { url: 'https://github.com/example/project/pull/55', headRefName: 'feat/pr', headRefOid: 'a'.repeat(40) },
    { execFileImpl: remotes },
  );
  assert.deepEqual(mismatched, { unavailable: true, reason: 'repository-mismatch' });

  const matched = await readCrossReviewState(
    { number: 55, cwd: root },
    { url: 'https://github.com/other/tool-less/pull/55', headRefName: 'feat/pr', headRefOid: 'a'.repeat(40) },
    { execFileImpl: remotes },
  );
  assert.deepEqual(matched, { notRequired: true, source: 'tool-absent' });
});

test('fork の origin ではなく upstream が PR のリポジトリと一致すればクロスレビュー状態を読む', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/pr': { round: 1, dismissed: [], lastReviewedSha: 'a'.repeat(40) } },
  }));
  const review = await readCrossReviewState(
    { number: 55, cwd: root },
    { url: 'https://github.com/example/project/pull/55', headRefName: 'feat/pr' },
    { execFileImpl: (_file, _args, _options, callback) => callback(null, [
      'remote.origin.url https://github.com/me/project.git',
      'remote.upstream.url git@github.com:Example/Project.git',
    ].join('\n') + '\n') },
  );

  assert.deepEqual(review, {
    number: 55, branch: 'feat/pr', round: 1, max: 3, dismissed: 0,
    reviewedSha: 'a'.repeat(40), triage: null,
  });
});

test('GitHub の remote の一致と判定できない remote はクロスレビュー状態の読み取りを続ける', async (t) => {
  const expected = {
    number: 55, branch: 'feat/pr', round: 1, max: 3, dismissed: 0,
    reviewedSha: 'a'.repeat(40), triage: null,
  };
  const remotes = [
    (callback) => callback(null, 'remote.origin.url HTTPS://GITHUB.COM/Example/Project.git\n'),
    (callback) => callback(null, 'remote.origin.url https://gitlab.com/example/project.git\n'),
    (callback) => callback(new Error('remotes are unavailable')),
  ];
  for (const provideRemotes of remotes) {
    const root = await temporaryDirectory(t);
    await fs.mkdir(path.join(root, '.git'));
    await installCrossReview(root);
    await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({
      branches: { 'feat/pr': { round: 1, dismissed: [], lastReviewedSha: 'a'.repeat(40) } },
    }));
    const review = await readCrossReviewState(
      { number: 55, cwd: root },
      { url: 'https://github.com/example/project/pull/55', headRefName: 'feat/pr' },
      { execFileImpl: (_file, _args, _options, callback) => provideRemotes(callback) },
    );
    assert.deepEqual(review, expected);
  }
});

test('クロスレビューの道具は cwd から見つかる worktree のものだけを検出する', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  assert.equal(await crossReviewToolExists(path.join(root, 'src')), false);

  await installCrossReview(root);
  assert.equal(await crossReviewToolExists(path.join(root, 'src')), true);
  assert.equal(await crossReviewToolExists(path.join(root, 'missing')), true);
  assert.equal(await crossReviewToolExists(''), false);
});

test('クロスレビュー状態は PR head ブランチの往復数、非対応件数、レビュー済み SHA を読む', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/pr': {
      round: 2,
      dismissed: ['一件目', '二件目'],
      lastReviewedSha: 'A'.repeat(40),
      lastTriage: { round: 2, sha: 'B'.repeat(64), outcome: 'converged' },
    } },
  }));
  const value = await readCrossReviewState({ number: 55, cwd: root }, { headRefName: 'feat/pr' });
  assert.deepEqual(value, {
    number: 55,
    branch: 'feat/pr',
    round: 2,
    max: 3,
    dismissed: 2,
    reviewedSha: 'a'.repeat(40),
    triage: { round: 2, sha: 'b'.repeat(64), outcome: 'converged' },
  });
  assert.equal(await readCrossReviewState({ number: 55, cwd: root }, { headRefName: 'missing' }), null);
});

test('不正な lastTriage は null にする', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  const invalidTriages = [
    { round: 1, sha: 'a'.repeat(7), outcome: 'converged' },
    { round: 1, sha: 'a'.repeat(40), outcome: 'unknown' },
    { round: 0, sha: 'a'.repeat(40), outcome: 'fixing' },
  ];

  for (const lastTriage of invalidTriages) {
    await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({
      branches: { 'feat/pr': { round: 2, dismissed: [], lastTriage } },
    }));
    const value = await readCrossReviewState({ number: 55, cwd: root }, { headRefName: 'feat/pr' });
    assert.equal(value.triage, null);
  }
});

test('lastTriage が無い旧形式では triage を null にする', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/pr': { round: 1, dismissed: [], lastReviewedSha: 'a'.repeat(40) } },
  }));

  const value = await readCrossReviewState({ number: 55, cwd: root }, { headRefName: 'feat/pr' });
  assert.equal(value.triage, null);
});

test('tools/cross-review.js が無い worktree はレビュー不要として扱う', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/pr': { round: 1, dismissed: [], lastReviewedSha: 'a'.repeat(40) } },
  }));
  const execFileImpl = (_file, _args, _options, callback) => callback(null, '');
  assert.deepEqual(await readCrossReviewState({ number: 55, cwd: root }, { headRefName: 'feat/pr', headRefOid: 'a'.repeat(40) }, { execFileImpl }), {
    notRequired: true, source: 'tool-absent',
  });
});

test('保存した cwd が消失した worktree はクロスレビュー状態を確認できない', async (t) => {
  const root = await temporaryDirectory(t);
  const cwd = path.join(root, 'checkout');
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(cwd);
  await fs.rm(cwd, { recursive: true });

  assert.deepEqual(await readCrossReviewState({ number: 55, cwd }, { headRefName: 'feat/pr' }), { unavailable: true });
});

test('保存した cwd を読み取れない worktree はクロスレビュー状態を確認できない', async (t) => {
  const root = await temporaryDirectory(t);
  const cwd = path.join(root, 'src');
  await fs.mkdir(path.join(root, '.git'));
  await fs.mkdir(cwd);
  const fileSystem = {
    stat: (target) => {
      if (target === cwd) {
        const error = new Error('permission denied');
        error.code = 'EACCES';
        return Promise.reject(error);
      }
      return fs.stat(target);
    },
    readFile: fs.readFile,
  };

  assert.deepEqual(await readCrossReviewState({ number: 55, cwd }, { headRefName: 'feat/pr' }, fileSystem), { unavailable: true });
});

test('tools/cross-review.js はあるが状態ファイルがまだ無い worktree は null を返す', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  assert.equal(await readCrossReviewState({ number: 55, cwd: root }, { headRefName: 'feat/pr' }), null);
});

test('JSON として読めないクロスレビュー状態ファイルは null を返す', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  await fs.writeFile(path.join(root, '.cross-review-state.json'), '{invalid');
  assert.deepEqual(await readCrossReviewState({ number: 55, cwd: root }, { headRefName: 'feat/pr' }), { unavailable: true });
});

test('壊れた lastReviewedSha は null にする', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/pr': { round: 1, dismissed: [], lastReviewedSha: 'not-a-commit-sha' } },
  }));

  const value = await readCrossReviewState({ number: 55, cwd: root }, { headRefName: 'feat/pr' });
  assert.equal(value.reviewedSha, null);
});

test('64 桁の lastReviewedSha はクロスレビュー状態に保持する', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  const sha = 'D'.repeat(64);
  await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/pr': { round: 1, dismissed: [], lastReviewedSha: sha } },
  }));

  const value = await readCrossReviewState({ number: 55, cwd: root }, { headRefName: 'feat/pr' });
  assert.equal(value.reviewedSha, sha.toLowerCase());
});

test('クロスレビュー状態は開いている PR のスタックに付き、マージ済み PR には付かない', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  const openSha = 'a'.repeat(40);
  const mergedSha = 'b'.repeat(40);
  await installCrossReview(root);
  await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({
    branches: {
      'feat/open': {
        round: 2,
        dismissed: ['指摘'],
        lastReviewedSha: openSha,
        lastTriage: { round: 2, sha: openSha, outcome: 'fixing' },
      },
      'feat/merged': { round: 1, dismissed: [], lastReviewedSha: mergedSha },
    },
  }));
  const { github, tracker } = await trackerFixture(t, [31, 32, 33], root);
  tracker.state.updatePullRequest('session-32', 'example', 'project', 32, {
    lastOpen: {
      title: 'PR 32',
      url: 'https://github.com/example/project/pull/32',
      headRefName: 'feat/merged',
      baseRefName: 'main',
      headRefOid: mergedSha,
    },
  });
  const unreviewedSha = 'c'.repeat(40);
  github.openPullRequests = [
    ghPullRequest(31, 'feat/open', 'main', openSha),
    ghPullRequest(33, 'feat/unreviewed', 'main', unreviewedSha),
  ];
  github.mergedPullRequests = [mergedPullRequest(32, mergedSha)];
  github.views.set(32, {
    ...ghPullRequest(32, 'feat/merged', 'main', mergedSha),
    state: 'MERGED', mergedAt: '2026-10-03T11:00:00.000Z',
  });
  github.comparisons.set(openSha, compareResult([openSha]));
  github.comparisons.set(unreviewedSha, compareResult([unreviewedSha]));

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.deepEqual(group.trees[0].crossReview, {
    round: 2, max: 3, dismissed: 1, reviewedSha: openSha,
    triage: { round: 2, sha: openSha, outcome: 'fixing' },
  });
  assert.equal(group.trees.find((pullRequest) => pullRequest.number === 33).crossReview, null);
  const merged = group.merged.find((pullRequest) => pullRequest.number === 32);
  assert.ok(merged);
  assert.equal(Object.hasOwn(merged, 'crossReview'), false);
  assert.equal(Object.hasOwn(group, 'reviews'), false);
});

test('tools/cross-review.js が無い worktree の PR はレビュー不要の状態を付ける', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  const headSha = 'a'.repeat(40);
  const { github, tracker } = await trackerFixture(t, [31], root);
  github.openPullRequests = [ghPullRequest(31, 'feat/open', 'main', headSha)];
  github.comparisons.set(headSha, compareResult([headSha]));
  tracker.gitExecFileImpl = (_file, _args, _options, callback) => callback(null, '');

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.deepEqual(group.trees[0].crossReview, { notRequired: true, source: 'tool-absent' });
  assert.equal(group.mergeableCount, 1);
});

for (const [higher, lower] of [['valid', 'missing'], ['valid', 'null'], ['null', 'missing']]) {
  for (const order of [[higher, lower], [lower, higher]]) {
    test(`同じ PR のクロスレビュー登録は ${higher} を ${lower} より優先する (${order.join(' → ')})`, async (t) => {
      const headSha = 'a'.repeat(40);
      const roots = {};
      for (const name of [higher, lower]) {
        roots[name] = await temporaryDirectory(t);
        await fs.mkdir(path.join(roots[name], '.git'));
      }
      if ([higher, lower].includes('valid')) {
        await installCrossReview(roots.valid);
        await fs.writeFile(path.join(roots.valid, '.cross-review-state.json'), JSON.stringify({
          branches: { 'feat/open': { round: 1, dismissed: [], lastReviewedSha: headSha } },
        }));
      }
      if ([higher, lower].includes('null')) {
        await installCrossReview(roots.null);
        await fs.writeFile(path.join(roots.null, '.cross-review-state.json'), JSON.stringify({ branches: {} }));
      }
      const { github, tracker } = await trackerFixture(t, []);
      for (const name of order) {
        tracker.state.registerPullRequest(`session-${name}`, { url: 'https://github.com/example/project/pull/31' }, {
          cwd: roots[name], product: { key: 'project', name: 'project' },
        });
      }
      github.openPullRequests = [ghPullRequest(31, 'feat/open', 'main', headSha)];
      github.comparisons.set(headSha, compareResult([headSha]));

      await tracker.refreshRepo('example', 'project');

      const [group] = tracker.snapshot();
      if (higher === 'valid') {
        assert.deepEqual(group.trees[0].crossReview, {
          round: 1, max: 3, dismissed: 0, reviewedSha: headSha, triage: null,
        });
      } else {
        assert.equal(group.trees[0].crossReview, null);
      }
    });
  }
}

test('同じ PR のクロスレビュー登録は、今の head で収束した記録を今の head をレビューした記録より優先する', async (t) => {
  const headSha = 'a'.repeat(40);
  const roots = {};
  const branches = {
    reviewedAtHead: { round: 2, dismissed: [], lastReviewedSha: headSha },
    convergedAtHead: { round: 2, dismissed: [], lastReviewedSha: 'b'.repeat(40), lastTriage: { round: 2, sha: headSha, outcome: 'converged' } },
  };
  for (const name of Object.keys(branches)) {
    roots[name] = await temporaryDirectory(t);
    await fs.mkdir(path.join(roots[name], '.git'));
    await installCrossReview(roots[name]);
    await fs.writeFile(path.join(roots[name], '.cross-review-state.json'), JSON.stringify({ branches: { 'feat/open': branches[name] } }));
  }
  const { github, tracker } = await trackerFixture(t, []);
  for (const name of ['reviewedAtHead', 'convergedAtHead']) {
    tracker.state.registerPullRequest(`session-${name}`, { url: 'https://github.com/example/project/pull/31' }, {
      cwd: roots[name], product: { key: 'project', name: 'project' },
    });
  }
  github.openPullRequests = [ghPullRequest(31, 'feat/open', 'main', headSha)];
  github.comparisons.set(headSha, compareResult([headSha]));

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.deepEqual(group.trees[0].crossReview.triage, { round: 2, sha: headSha, outcome: 'converged' });
});

test('登録の cwd とは別の worktree が PR のブランチをチェックアウトしていれば、その worktree のクロスレビュー状態を読む', async (t) => {
  const base = await temporaryDirectory(t);
  const sessionRoot = path.join(base, 'session');
  const reviewRoot = path.join(base, 'review');
  for (const root of [sessionRoot, reviewRoot]) {
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await installCrossReview(root);
  }
  const headSha = 'a'.repeat(40);
  await fs.writeFile(path.join(reviewRoot, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/open': { round: 2, dismissed: [], lastReviewedSha: headSha, lastTriage: { round: 2, sha: headSha, outcome: 'converged' } } },
  }));
  await fs.writeFile(path.join(sessionRoot, '.cross-review-state.json'), JSON.stringify({ branches: {} }));
  const { github, tracker } = await trackerFixture(t, [31], path.join(sessionRoot, 'tools'));
  const gitCalls = [];
  tracker.gitExecFileImpl = (file, args, _options, callback) => {
    gitCalls.push([file, ...args]);
    if (args.includes('config')) {
      callback(null, 'remote.origin.url https://github.com/example/project.git\n');
      return;
    }
    callback(null, [
      `worktree ${sessionRoot.replaceAll('\\', '/')}`, `HEAD ${'c'.repeat(40)}`, 'branch refs/heads/main', '',
      `worktree ${reviewRoot.replaceAll('\\', '/')}`, `HEAD ${headSha}`, 'branch refs/heads/feat/open', '',
    ].join('\n'));
  };
  github.openPullRequests = [ghPullRequest(31, 'feat/open', 'main', headSha)];
  github.comparisons.set(headSha, compareResult([headSha]));

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.deepEqual(gitCalls.filter(call => ['config', 'worktree'].includes(call[3])), [
    ['git', '-C', sessionRoot, 'config', '--get-regexp', '^remote\\..*\\.url$'],
    ['git', '-C', sessionRoot, 'worktree', 'list', '--porcelain'],
    ['git', '-C', reviewRoot, 'config', '--get-regexp', '^remote\\..*\\.url$'],
  ]);
  assert.deepEqual(group.trees[0].crossReview, {
    round: 2, max: 3, dismissed: 0, reviewedSha: headSha, triage: { round: 2, sha: headSha, outcome: 'converged' },
  });
});

test('PR のブランチをどの worktree もチェックアウトしていなくても、そのブランチの記録を持つ worktree のクロスレビュー状態を読む', async (t) => {
  const base = await temporaryDirectory(t);
  const sessionRoot = path.join(base, 'session');
  const reviewRoot = path.join(base, 'review');
  for (const root of [sessionRoot, reviewRoot]) {
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await installCrossReview(root);
  }
  const headSha = 'a'.repeat(40);
  await fs.writeFile(path.join(reviewRoot, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/open': { round: 2, dismissed: [], lastReviewedSha: headSha, lastTriage: { round: 2, sha: headSha, outcome: 'converged' } } },
  }));
  await fs.writeFile(path.join(sessionRoot, '.cross-review-state.json'), JSON.stringify({ branches: {} }));
  const review = await readCrossReviewStateAcrossWorktrees(
    { number: 31, cwd: sessionRoot },
    { headRefName: 'feat/open', headRefOid: headSha },
    {
      execFileImpl: (_file, _args, _options, callback) => callback(null, [
        `worktree ${sessionRoot.replaceAll('\\', '/')}`, `HEAD ${'c'.repeat(40)}`, 'branch refs/heads/main', '',
        `worktree ${reviewRoot.replaceAll('\\', '/')}`, `HEAD ${'d'.repeat(40)}`, 'branch refs/heads/feat/stacked-child', '',
      ].join('\n')),
    },
  );
  assert.deepEqual(review, {
    number: 31, branch: 'feat/open', round: 2, max: 3, dismissed: 0, reviewedSha: headSha, triage: { round: 2, sha: headSha, outcome: 'converged' },
  });
});

test('別 worktree の origin が別リポジトリなら、その状態で登録 cwd の結果を上書きしない', async (t) => {
  const base = await temporaryDirectory(t);
  const sessionRoot = path.join(base, 'session');
  const reviewRoot = path.join(base, 'review');
  for (const root of [sessionRoot, reviewRoot]) {
    await fs.mkdir(path.join(root, '.git'), { recursive: true });
    await installCrossReview(root);
  }
  const headSha = 'a'.repeat(40);
  await fs.writeFile(path.join(sessionRoot, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/open': { round: 1, dismissed: [], lastReviewedSha: headSha } },
  }));
  await fs.writeFile(path.join(reviewRoot, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/open': {
      round: 2, dismissed: [], lastReviewedSha: headSha,
      lastTriage: { round: 2, sha: headSha, outcome: 'converged' },
    } },
  }));
  const worktrees = [
    `worktree ${sessionRoot.replaceAll('\\', '/')}`, `HEAD ${'c'.repeat(40)}`, 'branch refs/heads/main', '',
    `worktree ${reviewRoot.replaceAll('\\', '/')}`, `HEAD ${'d'.repeat(40)}`, 'branch refs/heads/feat/open', '',
  ].join('\n');
  const review = await readCrossReviewStateAcrossWorktrees(
    { number: 31, cwd: sessionRoot },
    { url: 'https://github.com/example/project/pull/31', headRefName: 'feat/open', headRefOid: headSha },
    { execFileImpl: (_file, args, _options, callback) => {
      if (args[2] === 'worktree') callback(null, worktrees);
      else if (args[1] === reviewRoot) callback(null, 'remote.origin.url https://github.com/other/project.git\n');
      else callback(null, 'remote.origin.url https://github.com/example/project.git\n');
    } },
  );

  assert.deepEqual(review, {
    number: 31, branch: 'feat/open', round: 1, max: 3, dismissed: 0,
    reviewedSha: headSha, triage: null,
  });
});

test('PR のブランチをチェックアウトしていない worktree が読めなくても、記録なしの状態を確認不能に変えない', async (t) => {
  const base = await temporaryDirectory(t);
  const sessionRoot = path.join(base, 'session');
  const missingRoot = path.join(base, 'removed');
  await fs.mkdir(path.join(sessionRoot, '.git'), { recursive: true });
  await installCrossReview(sessionRoot);
  await fs.writeFile(path.join(sessionRoot, '.cross-review-state.json'), JSON.stringify({ branches: {} }));
  const review = await readCrossReviewStateAcrossWorktrees(
    { number: 31, cwd: sessionRoot },
    { headRefName: 'feat/open', headRefOid: 'a'.repeat(40) },
    {
      execFileImpl: (_file, _args, _options, callback) => callback(null, [
        `worktree ${sessionRoot.replaceAll('\\', '/')}`, `HEAD ${'c'.repeat(40)}`, 'branch refs/heads/main', '',
        `worktree ${missingRoot.replaceAll('\\', '/')}`, `HEAD ${'d'.repeat(40)}`, 'branch refs/heads/feat/other', '',
      ].join('\n')),
    },
  );
  assert.equal(review, null);
});

test('worktree の一覧を取れないときは、登録の cwd の状態ファイルだけを読む', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/open': { round: 1, dismissed: [], lastReviewedSha: 'a'.repeat(40) } },
  }));
  const calls = [];
  const review = await readCrossReviewStateAcrossWorktrees(
    { number: 31, cwd: root },
    { headRefName: 'feat/open', headRefOid: 'a'.repeat(40) },
    { execFileImpl: (file, args, _options, callback) => { calls.push([file, ...args]); callback(new Error('not a repository')); } },
  );
  assert.deepEqual(calls, [['git', '-C', root, 'worktree', 'list', '--porcelain']]);
  assert.equal(review.round, 1);
  const thrown = await readCrossReviewStateAcrossWorktrees(
    { number: 31, cwd: root },
    { headRefName: 'feat/open', headRefOid: 'a'.repeat(40) },
    { execFileImpl: () => { throw Object.assign(new Error('spawn EPERM'), { code: 'EPERM' }); } },
  );
  assert.equal(thrown.round, 1);
});

test('マージ済みの一覧を最古のオープン PR の作成日以降に絞り、上限で切れたら積み直しを確かめられないとする', async (t) => {
  const { github, calls, tracker } = await trackerFixture(t);
  const childSha = 'b'.repeat(40);
  github.openPullRequests = [{ ...ghPullRequest(31, 'feat/child', 'main', childSha), createdAt: '2026-10-01T10:00:00.000Z' }];
  // 上限ちょうどの件数を返し、親が一覧の外にあり得る状態にする。
  github.mergedPullRequests = Array.from({ length: 1000 }, (_, index) => (
    mergedPullRequest(1000 + index, (index + 1).toString(16).padStart(40, 'f'))
  ));
  github.comparisons.set(childSha, compareResult([childSha]));

  await tracker.refreshRepo('example', 'project');

  const mergedListCall = calls.find((args) => args[0] === 'pr' && args[1] === 'list' && args[args.indexOf('--state') + 1] === 'merged');
  assert.equal(mergedListCall[mergedListCall.indexOf('--search') + 1], 'merged:>=2026-09-30');
  assert.equal(mergedListCall[mergedListCall.indexOf('--json') + 1], 'number,headRefOid,headRefName,baseRefName,mergedAt');
  const [group] = tracker.snapshot();
  assert.equal(group.trees[0].blocker, '積み直しが必要か確かめられない');
  assert.equal(group.mergeableCount, 0);
});

test('effective は確定済み head を使い、印のない記録では lastOpen をたどる', () => {
  const confirmedParent = {
    ...pullRequestRegistration(40, {
      state: 'merged',
      mergedAt: '2026-10-03T11:00:00.000Z',
      lastOpen: {
        title: 'PR 40', url: 'https://github.com/example/project/pull/40',
        headRefName: 'feat/confirmed', baseRefName: 'old-base', headRefOid: 'a'.repeat(40),
      },
    }),
    mergedHead: {
      headRefOid: 'b'.repeat(40),
      headRefName: 'feat/confirmed',
      baseRefName: 'main',
    },
  };
  const legacyParent = pullRequestRegistration(42, {
    state: 'merged',
    mergedAt: '2026-10-03T11:01:00.000Z',
    lastOpen: {
      title: 'PR 42', url: 'https://github.com/example/project/pull/42',
      headRefName: 'feat/legacy', baseRefName: 'integration', headRefOid: 'c'.repeat(40),
    },
  });
  const result = assemblePullRequestStacks({
    defaultBranch: 'main',
    openPullRequests: [
      pullRequest(41, 'feat/child', 'feat/confirmed'),
      pullRequest(43, 'feat/legacy-child', 'feat/legacy'),
    ],
    registrations: [confirmedParent, legacyParent],
  });

  assert.equal(result.trees.find((tree) => tree.number === 41).effectiveBase, 'main');
  assert.equal(result.trees.find((tree) => tree.number === 43).effectiveBase, 'integration');
});

test('親だけを登録したスタックで、親がマージされ子の base が main に付け替わっても子を表示し続ける', () => {
  const parentSha = 'a'.repeat(40);
  const child = pullRequest(31, 'feat/child', 'main');
  const parent = pullRequestRegistration(30, { state: 'merged', lastOpen: {
    title: 'PR 30', url: 'https://github.com/example/project/pull/30',
    headRefName: 'feat/parent', baseRefName: 'main', headRefOid: parentSha,
  } });
  const result = assemblePullRequestStacks({
    defaultBranch: 'main',
    openPullRequests: [child],
    registrations: [parent],
    restackResults: new Map([[31, { checked: true, parent: { number: 30, headRefOid: parentSha, mergedAt: '2026-10-03T11:00:00.000Z' } }]]),
  });

  assert.equal(result.openCount, 1);
  assert.equal(result.trees[0].number, 31);
  assert.equal(result.trees[0].needsRestack, true);
});

test('親だけを登録したスタックで、親のマージ後に base を付け替えた子の CI の失敗も親のプロダクトに記録する', async (t) => {
  const { state, github, tracker } = await trackerFixture(t, []);
  const productA = { key: 'C:\project-a', name: 'project-a' };
  const parentSha = 'a'.repeat(40);
  const childSha = 'b'.repeat(40);
  state.registerPullRequest('session-a', { url: 'https://github.com/example/project/pull/30' }, { product: productA });
  const child = (baseRefName, statusCheckRollup) => ({
    ...ghPullRequest(31, 'feat/child', baseRefName, childSha),
    statusCheckRollup,
  });
  github.openPullRequests = [
    ghPullRequest(30, 'feat/parent', 'main', parentSha),
    child('feat/parent', [{ state: 'IN_PROGRESS', conclusion: '' }]),
  ];
  await tracker.refreshRepo('example', 'project');

  github.openPullRequests = [child('main', [{ state: 'IN_PROGRESS', conclusion: '' }])];
  github.mergedPullRequests = [mergedPullRequest(30, parentSha)];
  github.views.set(30, { ...ghPullRequest(30, 'feat/parent', 'main', parentSha), state: 'MERGED', mergedAt: '2026-10-03T11:00:00.000Z' });
  github.comparisons.set(childSha, compareResult([parentSha, childSha]));
  await tracker.refreshRepo('example', 'project');

  github.openPullRequests = [child('main', [{ state: 'COMPLETED', conclusion: 'FAILURE' }])];
  await tracker.refreshRepo('example', 'project');

  assert.deepEqual(state.ciFailures.filter((failure) => failure.number === 31).map((failure) => failure.product.key), [productA.key]);
});

function restackMapReader(values, calls = []) {
  return async (...args) => {
    calls.push(args);
    assert.ok(values.has(args[0]), `スタブに ${args[0]} が必要です`);
    const value = values.get(args[0]);
    if (value instanceof Error) throw value;
    return value;
  };
}

async function compareBaseFixture({ base = 'main', open = [], merged = [], heads = new Map() } = {}) {
  const pr = pullRequest(90, 'child', base);
  const headCalls = [];
  const liveMergedBranches = new Set();
  const result = await restackCompareBase(pr, [pr, ...open], merged, 'main', restackMapReader(heads, headCalls), liveMergedBranches);
  return { ...result, headCalls, liveMergedBranches };
}

test('base が既定ブランチならそのブランチだけを比較し head を取得しない', async () => {
  assert.deepEqual(await compareBaseFixture(), {
    compareBase: 'main', comparisonBranches: new Set(['main']), headCalls: [], liveMergedBranches: new Set(),
  });
});

test('オープンの親 PR の base をたどるとき head を取得しない', async () => {
  const result = await compareBaseFixture({ base: 'parent', open: [pullRequest(89, 'parent', 'main')] });
  assert.equal(result.compareBase, 'main');
  assert.deepEqual(result.comparisonBranches, new Set(['parent', 'main']));
  assert.deepEqual(result.headCalls, []);
});

for (const [name, head] of [['マージ時と同じ', 'a'.repeat(40)], ['存在しない', null]]) {
  test(`マージ済みの親ブランチが${name}なら親の base をたどる`, async () => {
    const result = await compareBaseFixture({ base: 'parent',
      merged: [mergedPullRequest(89, 'a'.repeat(40), undefined, 'parent', 'main')], heads: new Map([['parent', head]]) });
    assert.equal(result.compareBase, 'main');
    assert.deepEqual(result.comparisonBranches, new Set(['parent', 'main']));
    assert.deepEqual(result.headCalls, [['parent']]);
    assert.deepEqual(result.liveMergedBranches, new Set());
  });
}

test('同じ head 名のマージ済み PR は最も新しいマージの base をたどる', async () => {
  const result = await compareBaseFixture({ base: 'parent', merged: [
    mergedPullRequest(87, 'a'.repeat(40), '2026-10-01T00:00:00Z', 'parent', 'old-base'),
    mergedPullRequest(89, 'b'.repeat(40), '2026-10-02T00:00:00Z', 'parent', 'main'),
  ], heads: new Map([['parent', 'b'.repeat(40)]]) });
  assert.equal(result.compareBase, 'main');
  assert.deepEqual(result.comparisonBranches, new Set(['parent', 'main']));
});

test('マージ時から head が進んだ親ブランチで止まり生きているブランチに含める', async () => {
  const result = await compareBaseFixture({ base: 'parent',
    merged: [mergedPullRequest(89, 'a'.repeat(40), undefined, 'parent', 'main')], heads: new Map([['parent', 'b'.repeat(40)]]) });
  assert.equal(result.compareBase, 'parent');
  assert.deepEqual(result.comparisonBranches, new Set(['parent']));
  assert.deepEqual(result.liveMergedBranches, new Set(['parent']));
});

for (const [name, head, expectedBase] of [['実在する', 'a'.repeat(40), 'parent'], ['存在しない', null, 'main']]) {
  test(`残す選択をした親ブランチが${name}場合は ${expectedBase} を比較する`, async () => {
    const result = await compareBaseFixture({ base: 'parent',
      merged: [{ ...mergedPullRequest(89, 'a'.repeat(40), undefined, 'parent', 'main'), branchKept: true }],
      heads: new Map([['parent', head]]) });
    assert.equal(result.compareBase, expectedBase);
    assert.deepEqual(result.comparisonBranches, new Set(head ? ['parent'] : ['parent', 'main']));
    assert.deepEqual(result.liveMergedBranches, new Set(head ? ['parent'] : []));
  });
}

test('既定ブランチに届かない鎖は行き着いたブランチを比較する', async () => {
  const result = await compareBaseFixture({ base: 'parent', open: [pullRequest(89, 'parent', 'aggregate')] });
  assert.equal(result.compareBase, 'aggregate');
  assert.deepEqual(result.comparisonBranches, new Set(['parent', 'aggregate']));
});

test('base と同じ head が自分自身だけならマージ済みの同名ブランチへはたどらない', async () => {
  const pr = pullRequest(90, 'parent', 'parent');
  const result = await restackCompareBase(pr, [pr],
    [mergedPullRequest(89, 'a'.repeat(40), undefined, 'parent', 'main')], 'main', restackMapReader(new Map()), new Set());
  assert.deepEqual(result, { compareBase: 'parent', comparisonBranches: new Set(['parent']) });
});

test('別 PR の head だけが base と一致し親の base が空なら既定ブランチへ戻る', async () => {
  const result = await compareBaseFixture({ base: 'parent', open: [pullRequest(89, 'parent', '')],
    merged: [mergedPullRequest(88, 'a'.repeat(40), undefined, 'parent', 'aggregate')] });
  assert.equal(result.compareBase, 'main');
  assert.deepEqual(result.comparisonBranches, new Set(['parent', 'main']));
  assert.deepEqual(result.headCalls, []);
});

test('base の鎖が循環したら再訪したブランチで止まる', async () => {
  const result = await compareBaseFixture({ base: 'parent',
    open: [pullRequest(89, 'parent', 'other'), pullRequest(88, 'other', 'parent')] });
  assert.equal(result.compareBase, 'parent');
  assert.deepEqual(result.comparisonBranches, new Set(['parent', 'other']));
});

test('base が空なら既定ブランチを比較する', async () => {
  const result = await compareBaseFixture({ base: '' });
  assert.equal(result.compareBase, 'main');
  assert.deepEqual(result.comparisonBranches, new Set(['main']));
});

test('ブランチ head の取得失敗は比較 base の判定からそのまま伝播する', async () => {
  const error = new Error('head failure');
  await assert.rejects(compareBaseFixture({ base: 'parent',
    merged: [mergedPullRequest(89, 'a'.repeat(40), undefined, 'parent', 'main')], heads: new Map([['parent', error]]) }),
  (actual) => actual === error);
});

test('差分に head があり base が鎖に含まれる候補のうち最も古いマージを親にする', () => {
  const oldest = mergedPullRequest(81, 'a'.repeat(40), '2026-10-01T00:00:00Z', 'old', 'parent');
  const newest = mergedPullRequest(82, 'b'.repeat(40), '2026-10-02T00:00:00Z', 'new', 'main');
  const candidates = mergedPullRequestCandidates([newest, oldest], []);
  assert.deepEqual(restackResult(new Set([oldest.headRefOid, newest.headRefOid]), candidates, new Set(['parent', 'main']), 'main', false),
    { checked: true, parent: oldest });
});

test('完全な一覧では直接親と間接親を合わせて最古のマージを選ぶ', () => {
  const oldestIndirect = mergedPullRequest(81, 'a'.repeat(40), '2026-10-01T00:00:00Z', 'old', 'parent');
  const newestDirect = mergedPullRequest(83, 'b'.repeat(40), '2026-10-03T00:00:00Z', 'new', 'main');
  const parent = mergedPullRequest(82, 'c'.repeat(40), '2026-10-02T00:00:00Z', 'parent', 'main');
  assert.deepEqual(restackResult(new Set([newestDirect.headRefOid, oldestIndirect.headRefOid]),
    [newestDirect, oldestIndirect, parent], new Set(['main']), 'main', true),
  { checked: true, parent: oldestIndirect });
});

test('同時刻の直接親は PR 番号が小さい候補を選ぶ', () => {
  const higherNumber = mergedPullRequest(82, 'a'.repeat(40), '2026-10-02T00:00:00Z', 'higher', 'main');
  const lowerNumber = mergedPullRequest(81, 'b'.repeat(40), '2026-10-02T00:00:00Z', 'lower', 'main');
  assert.deepEqual(restackResult(new Set([higherNumber.headRefOid, lowerNumber.headRefOid]),
    [higherNumber, lowerNumber], new Set(['main']), 'main', true),
  { checked: true, parent: lowerNumber });
});

test('完全な一覧で直接親と未確認の間接候補があれば親を確定しない', () => {
  const direct = mergedPullRequest(83, 'a'.repeat(40), '2026-10-03T00:00:00Z', 'direct', 'main');
  const indirect = mergedPullRequest(81, 'b'.repeat(40), '2026-10-01T00:00:00Z', 'child', 'parent');
  const unknownSuccessor = mergedPullRequest(82, 'c'.repeat(40), '2026-10-02T00:00:00Z', 'parent', '');
  assert.deepEqual(restackResult(new Set([direct.headRefOid, indirect.headRefOid]),
    [direct, indirect, unknownSuccessor], new Set(['main']), 'main', true),
  { checked: false, parent: null });
});

test('不完全な一覧でも直接親があれば既存どおり返す', () => {
  const direct = mergedPullRequest(81, 'a'.repeat(40), '2026-10-01T00:00:00Z', 'direct', 'main');
  assert.deepEqual(restackResult(new Set([direct.headRefOid]), [direct], new Set(['main']), 'main', false),
    { checked: true, parent: direct });
});

test('不完全な一覧で間接親しか見つからなければ未確認にする', () => {
  const indirect = mergedPullRequest(81, 'a'.repeat(40), '2026-10-01T00:00:00Z', 'child', 'parent');
  const parent = mergedPullRequest(82, 'b'.repeat(40), '2026-10-02T00:00:00Z', 'parent', 'main');
  assert.deepEqual(restackResult(new Set([indirect.headRefOid]), [indirect, parent], new Set(['main']), 'main', false),
    { checked: false, parent: null });
});

test('差分に head があっても base が比較の鎖にない候補は親にしない', () => {
  const candidate = mergedPullRequest(81, 'a'.repeat(40), undefined, 'parent', 'outside');
  assert.deepEqual(restackResult(new Set([candidate.headRefOid]), [candidate], new Set(['main']), 'main', true), { checked: true, parent: null });
});

test('同時刻に同名headがマージされていればbaseの到達先を未確認にする', () => {
  const mergedAt = '2026-10-04T11:00:00.000Z';
  const candidate = mergedPullRequest(81, 'a'.repeat(40), mergedAt, 'child', 'parent');
  const sameTimeSuccessor = mergedPullRequest(82, 'b'.repeat(40), mergedAt, 'parent', 'main');
  assert.deepEqual(restackResult(new Set([candidate.headRefOid]), [candidate, sameTimeSuccessor], new Set(['main']), 'main'),
    { checked: false, parent: null });
});

test('同時刻の同名headがあり後刻の到達経路も見つかる場合は未確認にする', () => {
  const mergedAt = '2026-10-04T11:00:00.000Z';
  const candidate = mergedPullRequest(81, 'a'.repeat(40), mergedAt, 'child', 'parent');
  const sameTimeSuccessor = mergedPullRequest(82, 'b'.repeat(40), mergedAt, 'parent', 'outside');
  const laterSuccessor = mergedPullRequest(83, 'c'.repeat(40), '2026-10-04T11:01:00.000Z', 'parent', 'main');
  assert.deepEqual(restackResult(new Set([candidate.headRefOid]), [candidate, sameTimeSuccessor, laterSuccessor],
    new Set(['main']), 'main'), { checked: false, parent: null });
});

test('base が空の候補は比較の鎖に関係なく親にできる', () => {
  const candidate = mergedPullRequest(81, 'a'.repeat(40));
  assert.deepEqual(restackResult(new Set([candidate.headRefOid]), [candidate], new Set(), 'main', false), { checked: true, parent: candidate });
});

for (const complete of [true, false]) {
  test(`親が見つからずマージ済み一覧の完全性が ${complete} なら checked は ${complete} になる`, () => {
    assert.deepEqual(restackResult(new Set(), [], new Set(['main']), 'main', complete), { checked: complete, parent: null });
  });
}

test('差分のコミット一覧が null なら積み直し状態を未確認にする', () => {
  assert.deepEqual(restackResult(null, [], new Set(['main']), 'main', true), { checked: false, parent: null });
});

test('compare のコミット一覧が ahead_by より短ければ null にする', () => {
  assert.equal(parseCompareResult(JSON.stringify(compareResult(['a'.repeat(40)], 2))), null);
});

test('compare の ahead_by や SHA が不正なら例外にする', () => {
  for (const aheadBy of [-1, 0.5, '1', null]) {
    assert.throws(() => parseCompareResult(JSON.stringify(compareResult([], aheadBy))), /invalid compare result/);
  }
  for (const sha of ['abc', 'g'.repeat(40), null]) {
    assert.throws(() => parseCompareResult(JSON.stringify(compareResult([sha]))), /invalid compare result/);
  }
});

test('compare の SHA を小文字にして重複をまとめる', () => {
  assert.deepEqual(parseCompareResult(JSON.stringify(compareResult(['A'.repeat(40), 'a'.repeat(40), 'B'.repeat(64)]))),
    new Set(['a'.repeat(40), 'b'.repeat(64)]));
});

test('履歴の候補には確定した mergedHead が必要でオープンの番号を除き同じ番号の新しいマージを採る', () => {
  const head = { headRefOid: 'a'.repeat(40), headRefName: 'parent', baseRefName: 'main' };
  const old = { number: 81, session_id: 'session', state: 'merged', mergedAt: '2026-10-01T00:00:00Z', mergedHead: head };
  const latest = { ...old, mergedAt: '2026-10-02T00:00:00Z', mergedHead: { ...head, headRefOid: 'b'.repeat(40) } };
  assert.deepEqual(historicalMergedPullRequests([
    old, { ...old, number: 82, mergedHead: undefined, lastOpen: head },
    { ...old, number: 83 }, { ...old, number: 84, state: 'closed' },
  ], [{ ...latest, session_id: undefined }], [pullRequest(83, 'open', 'main')]),
  [{ number: 81, ...latest.mergedHead, mergedAt: latest.mergedAt }]);
});

test('一覧と履歴の番号が同じなら一覧の値を使い履歴の branchKept true だけを引き継ぐ', () => {
  const listed = mergedPullRequest(81, 'a'.repeat(40), '2026-10-02T00:00:00Z', 'listed', 'main');
  const historical = { ...mergedPullRequest(81, 'b'.repeat(40), '2026-10-01T00:00:00Z', 'historical', 'old'), branchKept: true };
  assert.deepEqual(mergedPullRequestCandidates([listed], [historical]), [{ ...listed, branchKept: true }]);
  assert.deepEqual(mergedPullRequestCandidates([listed], [{ ...historical, branchKept: false }]), [listed]);
});

test('マージ済み一覧が null でも履歴だけから時刻順の候補を作る', () => {
  const old = mergedPullRequest(81, 'a'.repeat(40), '2026-10-01T00:00:00Z');
  const latest = mergedPullRequest(82, 'b'.repeat(40), '2026-10-02T00:00:00Z');
  assert.deepEqual(mergedPullRequestCandidates(null, [latest, old]), [old, latest]);
});

function evaluateRestackFixture(openPullRequests, { heads = new Map(), commits = new Map(), ...changes } = {}) {
  const headCalls = [];
  const compareCalls = [];
  const errors = [];
  const result = evaluateRestack({ openPullRequests, mergedCandidates: [], mergedListComplete: true,
    defaultBranch: 'main', listAvailable: true, readBranchHead: restackMapReader(heads, headCalls),
    compare: restackMapReader(commits, compareCalls), onError: (message) => errors.push(message), ...changes });
  return { result, headCalls, compareCalls, errors };
}

test('完全な SHA を持たない PR は compare を呼ばず未確認にする', async () => {
  const fixture = evaluateRestackFixture([pullRequest(90, 'child', 'main', { headRefOid: 'abc' })]);
  assert.deepEqual(await fixture.result, { restackResults: new Map([[90, { checked: false, parent: null }]]), liveMergedBranches: new Set() });
  assert.deepEqual(fixture.headCalls, []);
  assert.deepEqual(fixture.compareCalls, []);
});

for (const [name, changes] of [['既定ブランチが null', { defaultBranch: null }], ['一覧が取得できない', { listAvailable: false }]]) {
  test(`${name}ならすべての PR を未確認にし I/O を行わない`, async () => {
    const fixture = evaluateRestackFixture([pullRequest(90, 'child', 'parent'), pullRequest(91, 'other', 'main')], {
      ...changes, mergedCandidates: [mergedPullRequest(89, 'a'.repeat(40), undefined, 'parent', 'main')],
    });
    assert.deepEqual(await fixture.result, { restackResults: new Map([
      [90, { checked: false, parent: null }], [91, { checked: false, parent: null }],
    ]), liveMergedBranches: new Set() });
    assert.deepEqual(fixture.headCalls, []);
    assert.deepEqual(fixture.compareCalls, []);
  });
}

test('compare が失敗した PR だけ未確認にして従来の文言でエラーを通知する', async () => {
  const prs = Object.freeze([Object.freeze(pullRequest(90, 'child', 'main')), Object.freeze(pullRequest(91, 'other', 'aggregate'))]);
  const fixture = evaluateRestackFixture(prs, { commits: new Map([['main', new Error('compare failure')], ['aggregate', new Set()]]) });
  const result = await fixture.result;
  assert.deepEqual(result.restackResults, new Map([[90, { checked: false, parent: null }], [91, { checked: true, parent: null }]]));
  assert.deepEqual(fixture.errors, ['#90 の積み直し状態を確認できません。gh の認証、通信、または取得結果を確認してください']);
  assert.deepEqual(fixture.compareCalls, [['main', prs[0].headRefOid], ['aggregate', prs[1].headRefOid]]);
});

test('head が進んだ親ブランチは compare に失敗しても生きているブランチに残る', async () => {
  const fixture = evaluateRestackFixture([pullRequest(90, 'child', 'parent')], {
    mergedCandidates: [mergedPullRequest(89, 'a'.repeat(40), undefined, 'parent', 'main')],
    heads: new Map([['parent', 'b'.repeat(40)]]), commits: new Map([['parent', new Error('compare failure')]]),
  });
  assert.deepEqual(await fixture.result, { restackResults: new Map([[90, { checked: false, parent: null }]]), liveMergedBranches: new Set(['parent']) });
  assert.deepEqual(fixture.headCalls, [['parent']]);
  assert.deepEqual(fixture.errors, ['#90 の積み直し状態を確認できません。gh の認証、通信、または取得結果を確認してください']);
});

test('一覧が不完全で親が見つからない PR は差分を取得できても未確認にする', async () => {
  const fixture = evaluateRestackFixture([pullRequest(90, 'child', 'main')], {
    mergedListComplete: false, commits: new Map([['main', new Set()]]),
  });
  assert.deepEqual((await fixture.result).restackResults, new Map([[90, { checked: false, parent: null }]]));
  assert.deepEqual(fixture.errors, []);
});

test('ブランチ head の取得が失敗した PR は compare を呼ばず未確認にする', async () => {
  const fixture = evaluateRestackFixture([pullRequest(90, 'child', 'parent')], {
    mergedCandidates: [mergedPullRequest(89, 'a'.repeat(40), undefined, 'parent', 'main')],
    heads: new Map([['parent', Object.assign(new Error('head failure'), { code: 'ETIMEDOUT' })]]),
  });
  assert.deepEqual((await fixture.result).restackResults, new Map([[90, { checked: false, parent: null }]]));
  assert.deepEqual(fixture.compareCalls, []);
  assert.deepEqual(fixture.errors, ['#90 の積み直し状態を確認できません。gh の取得がタイムアウトしました']);
});

test('比較はすべての PR で始めてから結果を待ち、失敗した PR ごとにエラーを 1 件通知する', { timeout: 5000 }, async () => {
  const failures = new Map();
  const errors = [];
  let bothStarted;
  const started = new Promise((resolve) => { bothStarted = resolve; });
  const pending = evaluateRestack({
    openPullRequests: [pullRequest(90, 'first', 'main'), pullRequest(91, 'second', 'aggregate')],
    mergedCandidates: [], mergedListComplete: true, defaultBranch: 'main', listAvailable: true,
    readBranchHead: restackMapReader(new Map()),
    compare: (base) => new Promise((resolve, reject) => {
      failures.set(base, reject);
      if (failures.size === 2) bothStarted();
    }),
    onError: (message) => errors.push(message),
  });
  // どちらの比較も失敗させる前に 2 つとも始まっていれば、PR ごとに逐次ではなく並列に比べている。
  await started;
  failures.get('aggregate')(Object.assign(new Error('second'), { code: 'ENOENT' }));
  failures.get('main')(Object.assign(new Error('first'), { code: 'EPERM' }));
  const result = await pending;
  assert.deepEqual([...errors].sort(), [
    '#90 の積み直し状態を確認できません。gh を実行できません',
    '#91 の積み直し状態を確認できません。gh コマンドが見つかりません',
  ]);
  assert.deepEqual(result.restackResults, new Map([
    [90, { checked: false, parent: null }],
    [91, { checked: false, parent: null }],
  ]));
});

test('取得に失敗した一覧と設定は前回の値を残し、取得時刻を更新しない', () => {
  const current = { openPullRequests: [pullRequest(31, 'feat', 'main')], defaultBranch: 'main',
    mergeMethods: ['merge'], autoDeleteBranch: true, fetchedAt: 'previous' };
  const result = interpretFetchResults({ current, checkedAt: 'now',
    listResult: { status: 'rejected', reason: new Error('list') },
    configResult: { status: 'rejected', reason: new Error('config') } });
  assert.equal(result.openPullRequests, current.openPullRequests);
  assert.equal(result.mergeMethods, current.mergeMethods);
  assert.equal(result.defaultBranch, 'main');
  assert.equal(result.autoDeleteBranch, true);
  assert.equal(result.fetchedAt, 'previous');
  assert.equal(result.listAvailable, false);
  assert.equal(result.configAvailable, false);
  assert.deepEqual([...result.openNumbers], [31]);
  assert.match(result.errors[0], /^PR の一覧を取得できません。/);
  assert.match(result.errors[1], /^リポジトリ設定を取得できません。/);
});

test('読み取れない一覧と設定は一覧、設定の順でエラーにする', () => {
  const result = interpretFetchResults({ current: { openPullRequests: [], fetchedAt: 'previous' }, checkedAt: 'now',
    listResult: { status: 'fulfilled', value: 'invalid' },
    configResult: { status: 'fulfilled', value: 'invalid' } });
  assert.deepEqual(result.errors, ['PR の一覧を読み取れませんでした', 'リポジトリ設定を読み取れませんでした']);
  assert.equal(result.fetchedAt, 'previous');
});

test('取得できた一覧は新しい配列にして設定と取得時刻を更新する', () => {
  const current = { openPullRequests: [] };
  const result = interpretFetchResults({ current, checkedAt: 'now',
    listResult: { status: 'fulfilled', value: JSON.stringify([ghPullRequest(31, 'feat', 'main')]) },
    configResult: { status: 'fulfilled', value: JSON.stringify({ default_branch: 'main',
      allow_merge_commit: true, allow_squash_merge: false, allow_rebase_merge: true, delete_branch_on_merge: true }) } });
  assert.notEqual(result.openPullRequests, current.openPullRequests);
  assert.deepEqual([...result.openNumbers], [31]);
  assert.equal(result.fetchedAt, 'now');
  assert.equal(result.listAvailable, true);
  assert.equal(result.configAvailable, true);
  assert.deepEqual(result.mergeMethods, ['merge', 'rebase']);
  assert.equal(result.autoDeleteBranch, true);
  assert.deepEqual(result.errors, []);
});


test('確認対象は登録、関連の挿入順で束ね、同じ番号の登録をまとめる', () => {
  const first = pullRequestRegistration(32);
  const duplicate = { ...first, session_id: 'another' };
  const related = { number: 31, state: 'open' };
  const result = selectPullRequestsToInspect({ registrationsBeforeInspection: [first, pullRequestRegistration(30), duplicate],
    relatedBeforeInspection: [related, { number: 32, state: 'closed' }], openNumbers: new Set(), retried: new Set() });
  assert.deepEqual([...result.trackedByNumber.keys()], [32, 30, 31]);
  assert.deepEqual(result.toInspect.map(([number]) => number), [32, 30, 31]);
  assert.deepEqual(result.trackedByNumber.get(32).registrations, [first, duplicate]);
  assert.equal(result.trackedByNumber.get(32).record, first);
  assert.equal(result.trackedByNumber.get(31).related, related);
});

test('補完対象は最大５件を通常の確認対象の末尾に登録順で足す', () => {
  const records = [1, 2, 3, 4, 5, 6, 7].map(number => pullRequestRegistration(number, { state: 'merged' }));
  records.push(pullRequestRegistration(20));
  const retried = new Set([2]);
  const result = selectPullRequestsToInspect({ registrationsBeforeInspection: records,
    relatedBeforeInspection: [], openNumbers: new Set(), retried });
  assert.deepEqual([...result.backfillNumbers], [1, 3, 4, 5, 6]);
  assert.deepEqual(result.toInspect.map(([number]) => number), [20, 1, 3, 4, 5, 6]);
  assert.deepEqual([...retried], [2]);
});

test('一覧にある PR と閉じた PR と確定 head のあるマージ済み PR は確認しない', () => {
  const records = [pullRequestRegistration(1), pullRequestRegistration(2, { state: 'closed' }),
    { ...pullRequestRegistration(3, { state: 'merged' }),
      mergedHead: { headRefName: 'feat', baseRefName: 'main', headRefOid: 'a'.repeat(40) } }];
  const result = selectPullRequestsToInspect({ registrationsBeforeInspection: records,
    relatedBeforeInspection: [], openNumbers: new Set([1]), retried: new Set() });
  assert.deepEqual(result.toInspect, []);
});

test('補完は MERGED かつ確定 head のときだけ適用し、ほかの結果を無視する', () => {
  const backfill = new Set([31]);
  const value = { ...ghPullRequest(31, 'feat', 'main', { sha: 'a'.repeat(40) }), state: 'MERGED', mergedAt: 'now' };
  for (const result of [{ number: 31, error: new Error('failed') },
    { number: 31, value: { ...value, state: 'merged' } },
    { number: 31, value: { ...value, headRefOid: '' } },
    { number: 31, value: { ...value, state: 'CLOSED' } }]) {
    assert.deepEqual(classifyInspectedPullRequest(result, backfill), { kind: 'skip' });
  }
  const result = classifyInspectedPullRequest({ number: 31, value }, backfill);
  assert.equal(result.kind, 'merged');
  assert.equal(result.stateChanges.mergedHead.headRefOid, value.headRefOid);
});

test('確認失敗と読み取れない状態は番号付きのエラーに分類する', () => {
  assert.match(classifyInspectedPullRequest({ number: 31, error: new Error('failed') }, new Set()).error,
    /^#31 の状態を確認できません。/);
  for (const value of [{ state: 'UNKNOWN' }, { state: 'OPEN', number: 31 }]) {
    assert.deepEqual(classifyInspectedPullRequest({ number: 31, value }, new Set()),
      { kind: 'unreadable', error: '#31 の状態を読み取れませんでした' });
  }
});

test('確認で見つかった OPEN は正規化した PR を返す', () => {
  const result = classifyInspectedPullRequest({ number: 31,
    value: { ...ghPullRequest(31, 'feat', 'main'), state: 'open' } }, new Set());
  assert.equal(result.kind, 'open');
  assert.equal(result.pullRequest.number, 31);
  assert.equal(result.pullRequest.headRefName, 'feat');
});

test('CLOSED に mergedAt があれば merged にし、無ければ closed にする', () => {
  const closed = classifyInspectedPullRequest({ number: 31, value: { state: 'CLOSED' } }, new Set());
  assert.deepEqual(closed, { kind: 'closed', stateChanges: { state: 'closed', mergedAt: null } });
  const merged = classifyInspectedPullRequest({ number: 31,
    value: { ...ghPullRequest(31, 'feat', 'main'), state: 'CLOSED', mergedAt: 'now' } }, new Set());
  assert.equal(merged.kind, 'merged');
  assert.equal(merged.stateChanges.mergedAt, 'now');
});

test('子のスタックは予約、マージ意図の順で集め、閉じた子を除外する', () => {
  const result = stackedPullRequestsForMerge({
    reservation: { stackedPullRequests: [{ number: 32, baseRefName: 'old' }, { number: 99 }] },
    mergeIntent: { stackedPullRequests: [{ number: 33 }, { number: 32, baseRefName: 'updated' }] },
    pullRequest: null, openPullRequests: [pullRequest(32, 'child32', 'main'), pullRequest(33, 'child33', 'main')] });
  assert.deepEqual(result, [{ number: 32, baseRefName: 'updated', headRefName: 'child32' },
    { number: 33, headRefName: 'child33' }]);
});

test('親の head を base に持つ子は予約の値を置き換え、後から補った子も含める', () => {
  const openPullRequests = [pullRequest(32, 'child32', 'parent')];
  openPullRequests.push(pullRequest(33, 'child33', 'parent'));
  assert.deepEqual(stackedPullRequestsForMerge({
    reservation: { stackedPullRequests: [{ number: 32, baseRefName: 'old', headRefName: 'old' }] },
    mergeIntent: null, pullRequest: pullRequest(31, 'parent', 'main'), openPullRequests }),
  [{ number: 32, baseRefName: 'parent' }, { number: 33, baseRefName: 'parent' }]);
});

test('予約とマージ意図と親が無ければ子のスタックは空にする', () => {
  assert.deepEqual(stackedPullRequestsForMerge({ reservation: null, mergeIntent: null,
    pullRequest: null, openPullRequests: [pullRequest(32, 'child', 'main')] }), []);
});

test('オープン PR が無いときはマージ済み一覧を取得せず完全な空一覧を返す', async () => {
  const tracker = new PullRequestTracker({ state: new DashboardState() });
  tracker.execute = async () => { assert.fail('gh を呼ばない'); };
  assert.deepEqual(await tracker.fetchMergedPullRequests('example/project', []),
    { mergedPullRequests: [], mergedListComplete: true, error: null });
});

test('マージ済み一覧の取得失敗は一覧を null にして既存のエラー文を返す', async () => {
  const tracker = new PullRequestTracker({ state: new DashboardState() });
  tracker.execute = async () => { throw new Error('failed'); };
  const result = await tracker.fetchMergedPullRequests('example/project', [pullRequest(31, 'feat', 'main')]);
  assert.equal(result.mergedPullRequests, null);
  assert.equal(result.mergedListComplete, false);
  assert.match(result.error, /^マージ済み PR の一覧を取得できません。/);
});


test('プロダクトが無い登録はリポジトリ名を既定の所属にする', () => {
  const registration = { number: 31 };
  assert.deepEqual([...productGroupsFor('Example', 'Project', [registration])],
    [['repo:example/project', { product: { key: 'repo:example/project', name: 'Example/Project' },
      registrations: [registration] }]]);
});

test('所属は登録順で作り、同じキーの登録を最初のプロダクトに束ねる', () => {
  const first = { number: 31, product: { key: 'b', name: 'first' } };
  const second = { number: 32, product: { key: 'a', name: 'second' } };
  const third = { number: 33, product: { key: 'b', name: 'third' } };
  const registrations = [first, second, third];
  const groups = productGroupsFor('example', 'project', registrations);
  assert.deepEqual([...groups.keys()], ['b', 'a']);
  assert.equal(groups.get('b').product, first.product);
  assert.deepEqual(groups.get('b').registrations, [first, third]);
  assert.deepEqual(registrations, [first, second, third]);
});

test('登録が無ければ所属は空にする', () => {
  assert.deepEqual([...productGroupsFor('example', 'project', [])], []);
});

for (const failed of [false, true]) {
  test(failed ? 'head 検索が失敗したブランチはマージ先にしない' : '期間外にマージされた未登録 PR の head はマージ先にしない', async (t) => {
    const { github, tracker, calls, state } = await trackerFixture(t);
    github.openPullRequests = [ghPullRequest(31, 'feat/child', 'feature/aggregate')];
    if (failed) github.headSearchErrors.add('feature/aggregate');
    else github.headPullRequests.set('feature/aggregate', [{ number: 1 }]);
    await tracker.refreshRepo('example', 'project');
    const tree = tracker.snapshot()[0].trees[0];
    assert.equal(tree.mergeTarget, null);
    assert.equal(tree.canMerge, false);
    assert.equal(tracker.mergeCandidate(state.pullRequestRegistrationsForRepo('example', 'project')[0]).pullRequest.mergeTarget, null);
    assert.ok(calls.some(args => JSON.stringify(args) === JSON.stringify([
      'pr', 'list', '-R', 'example/project', '--state', 'all', '--head', 'feature/aggregate', '--limit', '1', '--json', 'number',
    ])));
  });
}

test('集約ブランチの head 検索が失敗しても既定ブランチ向けの PR はマージ候補のまま残る', async (t) => {
  const { github, tracker, state } = await trackerFixture(t, [31, 32]);
  github.openPullRequests = [ghPullRequest(31, 'feat/child', 'feature/aggregate'), ghPullRequest(32, 'feat/main', 'main')];
  github.headSearchErrors.add('feature/aggregate');
  await tracker.refreshRepo('example', 'project');
  const registration = state.pullRequestRegistrationsForRepo('example', 'project').find(record => record.number === 32);
  const candidate = tracker.mergeCandidate(registration);
  assert.equal(candidate.error, undefined);
  assert.equal(candidate.pullRequest.mergeTarget, 'main');
  assert.equal(tracker.snapshot()[0].error, null);
});

test('head の確認候補が上限を超えると超えたマージ先は認めない', async (t) => {
  const { github, tracker, calls } = await trackerFixture(t, Array.from({ length: 21 }, (_, index) => index + 1));
  github.openPullRequests = Array.from({ length: 21 }, (_, index) => ghPullRequest(index + 1, `feat/${index}`, `aggregate/${index}`));
  await tracker.refreshRepo('example', 'project');
  const trees = tracker.snapshot()[0].trees;
  assert.equal(trees.find(pr => pr.number === 1).mergeTarget, 'aggregate/0');
  assert.equal(trees.find(pr => pr.number === 21).mergeTarget, null);
  assert.equal(trees.find(pr => pr.number === 21).canMerge, false);
  assert.equal(calls.filter(args => args.includes('--head')).length, 20);
});

test('同じマージ先の head 検索は重複せず既定ブランチとオープン PR の head は検索しない', async (t) => {
  const { github, tracker, calls } = await trackerFixture(t, [1, 2, 3, 4]);
  github.openPullRequests = [ghPullRequest(1, 'feat/one', 'aggregate'), ghPullRequest(2, 'feat/two', 'aggregate'),
    ghPullRequest(3, 'feat/three', 'main'), ghPullRequest(4, 'feat/four', 'feat/one')];
  await tracker.refreshRepo('example', 'project');
  const searches = calls.filter(args => args.includes('--head'));
  assert.deepEqual(searches.map(args => args[args.indexOf('--head') + 1]), ['aggregate']);
  assert.equal(tracker.snapshot()[0].trees.find(pr => pr.number === 1).mergeTarget, 'aggregate');
});

test('クロスレビューのファイル有無と head の変化だけを記録し、状態本文を残さない', async t => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  const { tracker, github } = await trackerFixture(t, [31], root);
  const { Diagnostics } = require('../src/server/diagnostics');
  const diagnostics = new Diagnostics({ homeDir: root });
  tracker.diagnostics = diagnostics;
  tracker.gitExecFileImpl = (_file, _args, _options, callback) => callback(null, '');
  github.openPullRequests = [ghPullRequest(31, 'feat/private-branch', 'main', 'a'.repeat(40))];
  await tracker.refreshRepo('example', 'project');
  await tracker.refreshRepo('example', 'project');
  const stateFile = path.join(root, '.cross-review-state.json');
  for (const head of ['a', 'b']) {
    await fs.writeFile(stateFile, JSON.stringify({ branches: { 'feat/private-branch': {
      round: 1, dismissed: ['private-review-text'], lastReviewedSha: head.repeat(40), prompt: 'private-prompt',
    } } }));
    await tracker.refreshRepo('example', 'project');
    await tracker.refreshRepo('example', 'project');
  }
  const entries = (await diagnostics.readRun(diagnostics.run)).filter(entry => entry.msg === 'review.state');
  assert.deepEqual(entries.map(entry => [entry.data.file, entry.data.head]), [['missing', 'missing'], ['present', 'match'], ['present', 'mismatch']]);
  assert.doesNotMatch(JSON.stringify(entries), /private|dismissed|prompt|cross-review-state|lastReviewedSha/);
});

test('壊れたクロスレビュー状態は失敗分類だけを残し、同じ失敗を走査ごとには残さない', async t => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await installCrossReview(root);
  await fs.writeFile(path.join(root, '.cross-review-state.json'), '{private-invalid-json');
  const { tracker, github } = await trackerFixture(t, [31], root);
  const { Diagnostics } = require('../src/server/diagnostics');
  const diagnostics = new Diagnostics({ homeDir: root });
  tracker.diagnostics = diagnostics;
  tracker.gitExecFileImpl = (_file, _args, _options, callback) => callback(null, '');
  github.openPullRequests = [ghPullRequest(31, 'feat/review', 'main', 'a'.repeat(40))];
  await tracker.refreshRepo('example', 'project');
  await tracker.refreshRepo('example', 'project');
  const entries = (await diagnostics.readRun(diagnostics.run)).filter(entry => entry.msg === 'review.state');
  assert.equal(entries.length, 1);
  assert.equal(entries[0].data.failure, 'parse');
  assert.equal(entries[0].level, 'warn');
  assert.doesNotMatch(JSON.stringify(entries), /private|invalid-json|message/);
});

test('期限の整理を間引いている間に 24 時間を過ぎたマージ履歴は返さない', () => {
  const state = new DashboardState();
  const mergedAt = Date.parse('2026-10-01T00:00:00.000Z');
  state.recordMergedPullRequest({
    owner: 'example', repo: 'project', number: 7, title: '期限の境目', url: 'https://github.com/example/project/pull/7',
    mergedAt: new Date(mergedAt).toISOString(), method: 'merge', automatic: false,
  }, mergedAt);
  const retentionMs = 24 * 60 * 60 * 1000;

  assert.equal(state.mergedPullRequestHistoryForRepo('example', 'project', mergedAt + retentionMs - 1000).length, 1);
  assert.deepEqual(state.mergedPullRequestHistoryForRepo('example', 'project', mergedAt + retentionMs + 1000), []);
});

test('コマンドの後の取り直しは、閉じた登録だけのリポジトリも 60 秒経っていれば取る', async (t) => {
  const { tracker, github, calls } = await trackerFixture(t);
  let now = Date.parse('2026-10-03T12:00:00.000Z');
  tracker.now = () => now;
  github.views.set(31, { ...ghPullRequest(31, 'feature/31', 'main', '1'.repeat(40)), state: 'CLOSED', mergedAt: null });
  await tracker.refreshAll();
  const callCount = calls.length;

  now += 55_000 - 1;
  await tracker.refreshAfterCommand();
  assert.equal(calls.length, callCount);

  now += 5_000 + 1;
  await tracker.refreshAfterCommand();
  assert.ok(calls.length > callCount);
  tracker.close();
});

test('コマンドの後の全体の取り直しが 5 秒以内に続いたら、すぐの 1 回と間隔の明けの 1 回にまとめる', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { tracker, calls } = await trackerFixture(t);
  let now = Date.parse('2026-10-03T12:00:00.000Z');
  tracker.now = () => now;
  await tracker.refreshAll();
  const fetchCount = () => calls.filter((args) => args[0] === 'pr' && args[1] === 'list').length;
  const settle = async () => { for (let index = 0; index < 20; index += 1) await new Promise(setImmediate); };

  const before = fetchCount();
  await tracker.refreshAfterCommand();
  const afterFirst = fetchCount();
  assert.ok(afterFirst > before);
  now += 1_000;
  await tracker.refreshAfterCommand();
  now += 1_000;
  await tracker.refreshAfterCommand();
  assert.equal(fetchCount(), afterFirst);

  // 予約は 2 回目の呼び出しの時点で、残りの 4 秒後に置かれる。
  now += 3_000;
  t.mock.timers.tick(4_000);
  await settle();
  assert.equal(fetchCount() - afterFirst, afterFirst - before);
  tracker.close();
  t.mock.timers.reset();
});

test('確定操作の確かめ直しの取得は、その中の gh も待ち行列で定期取得より先に実行する', async (t) => {
  const { state, tracker } = await trackerFixture(t, [31]);
  state.getDisplayPreferences = () => ({ ghConcurrencyLimit: 4 });
  const started = [];
  const held = [];
  const realExecFile = tracker.execFileImpl;
  tracker.execFileImpl = (file, args, options, callback) => {
    const label = args.join(' ');
    started.push(label);
    held.push(() => (label.includes('example/background')
      ? callback(null, '{}')
      : realExecFile(file, args, options, callback)));
  };
  const settle = async () => { for (let index = 0; index < 5; index += 1) await new Promise(setImmediate); };
  const background = Array.from({ length: 6 }, (_, index) => tracker.execute(['api', `repos/example/background/${index}`]));
  await settle();
  assert.equal(started.length, 4);
  const fresh = tracker.refreshRepoFresh('example', 'project', { priority: true });
  await settle();
  held.shift()();
  await settle();
  assert.ok(!started[4].includes('example/background'));

  while (held.length) {
    held.shift()();
    await settle();
  }
  await Promise.allSettled([...background, fresh]);
});

test('コマンドの後に間隔が足りず飛ばしたリポジトリは、間隔が明けた時点で取る', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { tracker, github, calls } = await trackerFixture(t);
  let now = Date.parse('2026-10-03T12:00:00.000Z');
  tracker.now = () => now;
  github.views.set(31, { ...ghPullRequest(31, 'feature/31', 'main', '1'.repeat(40)), state: 'CLOSED', mergedAt: null });
  await tracker.refreshAll();
  const callCount = calls.length;

  now += 10_000;
  await tracker.refreshAfterCommand();
  assert.equal(calls.length, callCount);
  t.mock.timers.tick(50_000 - 1);
  await new Promise(setImmediate);
  assert.equal(calls.length, callCount);
  now += 50_000;
  t.mock.timers.tick(1);
  for (let index = 0; index < 20; index += 1) await new Promise(setImmediate);
  assert.ok(calls.length > callCount);
  tracker.close();
  t.mock.timers.reset();
});

test('同じリポジトリの取得が動いている間の確定操作は、その取得の待っている gh も優先に引き上げる', async (t) => {
  const { state, tracker } = await trackerFixture(t, [31]);
  state.getDisplayPreferences = () => ({ ghConcurrencyLimit: 4 });
  const held = [];
  const started = [];
  const realExecFile = tracker.execFileImpl;
  tracker.execFileImpl = (file, args, options, callback) => {
    const label = args.join(' ');
    started.push(label);
    held.push(() => (label.includes('example/background')
      ? callback(null, '{}')
      : realExecFile(file, args, options, callback)));
  };
  const settle = async () => { for (let index = 0; index < 5; index += 1) await new Promise(setImmediate); };
  const background = Array.from({ length: 4 }, (_, index) => tracker.execute(['api', `repos/example/background/${index}`]));
  await settle();
  const running = tracker.refreshRepo('example', 'project');
  const laterBackground = Array.from({ length: 2 }, (_, index) => tracker.execute(['api', `repos/example/background/later-${index}`]));
  await settle();
  assert.equal(started.length, 4);
  const fresh = tracker.refreshRepoFresh('example', 'project', { priority: true });
  await settle();
  held.shift()();
  await settle();
  assert.ok(!started[4].includes('example/background'));

  while (held.length) {
    held.shift()();
    await settle();
  }
  await Promise.allSettled([...background, ...laterBackground, running, fresh]);
});

test('予約した取り直しの時刻に同じリポジトリの取得が動いていれば、終わるのを待ってから取り直す', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { tracker, github, calls } = await trackerFixture(t);
  let now = Date.parse('2026-10-03T12:00:00.000Z');
  tracker.now = () => now;
  github.views.set(31, { ...ghPullRequest(31, 'feature/31', 'main', '1'.repeat(40)), state: 'CLOSED', mergedAt: null });
  await tracker.refreshAll();

  now += 10_000;
  await tracker.refreshAfterCommand();
  let finishRunning;
  tracker.inFlight.set('example/project', new Promise((resolve) => { finishRunning = resolve; }));
  const callCount = calls.length;
  now += 50_000;
  t.mock.timers.tick(50_000);
  for (let index = 0; index < 20; index += 1) await new Promise(setImmediate);
  assert.equal(calls.length, callCount);

  tracker.inFlight.delete('example/project');
  finishRunning();
  for (let index = 0; index < 20; index += 1) await new Promise(setImmediate);
  assert.ok(calls.length > callCount);
  tracker.close();
  t.mock.timers.reset();
});

async function headToolFixture(t, { missing = false, tool = false, contents, headSha = 'a'.repeat(40) } = {}) {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  if (tool) await installCrossReview(root);
  if (contents !== undefined) await fs.writeFile(path.join(root, '.cross-review-state.json'), contents);
  const calls = [];
  const execFileImpl = (_file, args, options, callback) => {
    calls.push({ args, options });
    if (args[2] === 'config') callback(null, 'remote.origin.url https://github.com/example/project.git\n');
    else if (args[2] === 'ls-tree') callback(null, '');
    else callback(null, `worktree ${root}\nbranch refs/heads/feat/open\n`);
  };
  return { root, calls, registration: { number: 31, cwd: missing ? path.join(root, 'missing') : root },
    pr: ghPullRequest(31, 'feat/open', 'main', headSha), options: { execFileImpl } };
}

for (const headSha of ['a'.repeat(40), 'b'.repeat(64)]) {
  test(`消えた cwd の PR は head に道具が無ければレビュー不要になる (${headSha.length} 桁 SHA)`, async (t) => {
    const f = await headToolFixture(t, { missing: true, headSha });
    assert.deepEqual(await readCrossReviewStateAcrossWorktrees(f.registration, f.pr, f.options), { notRequired: true, source: 'tool-absent' });
    const call = f.calls.find(({ args }) => args[2] === 'ls-tree');
    assert.deepEqual(call.args, ['-C', f.root, 'ls-tree', '--full-tree', headSha, '--', 'tools/cross-review.js']);
    assert.equal(call.options.shell, false);
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 10_000);
  });
}

for (const scenario of [
  { name: '道具がある', stdout: `100644 blob ${'b'.repeat(40)}\ttools/cross-review.js\n` },
  { name: 'コミットが手元に無い', error: Object.assign(new Error('missing commit'), { code: 128 }) },
  { name: '出力の形が合わない', stdout: 'unexpected output' },
  { name: '余分な空行がある', stdout: `100644 blob ${'b'.repeat(40)}\ttools/cross-review.js\n\n` },
  { name: 'タイムアウトする', error: Object.assign(new Error('timeout'), { killed: true }) },
  { name: '同期の起動失敗になる', throws: true },
]) {
  test(`消えた cwd で head と base の確認が「${scenario.name}」なら確認不能を保つ`, async (t) => {
    const f = await headToolFixture(t, { missing: true });
    const original = f.options.execFileImpl;
    f.options.execFileImpl = (file, args, options, callback) => {
      if (args[2] === 'worktree') return callback(null, `worktree ${f.root}\nbranch refs/heads/main\n`);
      if (args[2] !== 'ls-tree') return original(file, args, options, callback);
      if (scenario.throws) throw Object.assign(new Error('spawn'), { code: 'EPERM' });
      callback(scenario.error, scenario.stdout);
    };
    assert.deepEqual(await readCrossReviewStateAcrossWorktrees(f.registration, f.pr, f.options), { unavailable: true });
  });
}

const TOOL_ENTRY = `100644 blob ${'b'.repeat(40)}\ttools/cross-review.js\n`;
const ROUND_TWO_STATE = JSON.stringify({ branches: { 'feat/open': { round: 2, dismissed: [] } } });

// head の確認だけを失敗させ、base の確認には baseStdout を返す。undefined なら base の確認も失敗させる。
function failHeadLsTree(f, baseStdout) {
  const original = f.options.execFileImpl;
  f.options.execFileImpl = (file, args, options, callback) => {
    if (args[2] === 'worktree') return callback(null, `worktree ${f.root}\nbranch refs/heads/main\n`);
    if (args[2] !== 'ls-tree') return original(file, args, options, callback);
    if (args[4] === f.pr.headRefOid || baseStdout === undefined) return callback(Object.assign(new Error('missing'), { code: 128 }), '');
    callback(null, baseStdout);
  };
}

for (const [base, expected] of [['', { notRequired: true, source: 'tool-absent' }], [TOOL_ENTRY, { unavailable: true }]]) {
  test(`消えた cwd で head を確かめられないときは base の道具の有無で判断する (${base ? 'あり' : 'なし'})`, async (t) => {
    const f = await headToolFixture(t, { missing: true });
    failHeadLsTree(f, base);
    assert.deepEqual(await readCrossReviewStateAcrossWorktrees(f.registration, f.pr, f.options), expected);
  });
}

for (const scenario of [
  { name: 'base に道具があり状態ファイルが未作成', base: TOOL_ENTRY, contents: undefined, expected: null },
  { name: 'base に道具があり状態ファイルが破損', base: TOOL_ENTRY, contents: '{broken', expected: { unavailable: true } },
  { name: 'base に道具があり記録がある', base: TOOL_ENTRY, contents: ROUND_TWO_STATE, round: 2 },
  { name: 'base に道具が無い', base: '', contents: ROUND_TWO_STATE, expected: { notRequired: true, source: 'tool-absent' } },
  { name: 'base も確かめられない', base: undefined, contents: ROUND_TWO_STATE, expected: { unavailable: true } },
]) {
  test(`道具の無い worktree で head を確かめられないときは base で判断する (${scenario.name})`, async (t) => {
    const f = await headToolFixture(t, { contents: scenario.contents });
    failHeadLsTree(f, scenario.base);
    const result = await readCrossReviewStateAcrossWorktrees(f.registration, f.pr, f.options);
    if (scenario.round) assert.equal(result.round, scenario.round);
    else assert.deepEqual(result, scenario.expected);
  });
}

for (const scenario of [
  { name: 'fork の origin ではなく PR のリポジトリの upstream を見る',
    config: 'remote.origin.url https://github.com/fork/project.git\nremote.upstream.url https://github.com/example/project.git\n',
    refs: { 'refs/remotes/origin/main': '', 'refs/remotes/upstream/main': TOOL_ENTRY }, expected: { unavailable: true } },
  { name: '一致する remote を順に見る',
    config: 'remote.a.url https://github.com/example/project.git\nremote.b.url git@github.com:example/project.git\n',
    refs: { 'refs/remotes/b/main': '' }, expected: { notRequired: true, source: 'tool-absent' } },
  { name: '一致する remote が分からなければローカルのブランチを見ない',
    config: null, refs: { 'refs/heads/main': '' }, expected: { unavailable: true } },
  { name: 'GitHub と判定できる remote が無ければすべての remote を見る',
    config: 'remote.origin.url git@github-work:example/project.git\nremote.mirror.url https://example.com/project.git\n',
    refs: { 'refs/remotes/origin/main': '', 'refs/remotes/mirror/main': TOOL_ENTRY }, expected: { unavailable: true } },
]) {
  test(`消えた cwd の base は PR のリポジトリの追跡ブランチで確かめる (${scenario.name})`, async (t) => {
    const f = await headToolFixture(t, { missing: true });
    f.options.execFileImpl = (_file, args, _options, callback) => {
      if (args[2] === 'config') return scenario.config === null ? callback(new Error('unreadable')) : callback(null, scenario.config);
      if (args[2] === 'worktree') return callback(null, `worktree ${f.root}\nbranch refs/heads/main\n`);
      if (Object.hasOwn(scenario.refs, args[4])) return callback(null, scenario.refs[args[4]]);
      callback(Object.assign(new Error('missing'), { code: 128 }), '');
    };
    assert.deepEqual(await readCrossReviewStateAcrossWorktrees(f.registration, f.pr, f.options), scenario.expected);
  });
}

test('消えた cwd の remote が別リポジトリなら head の道具を照会しない', async (t) => {
  const f = await headToolFixture(t, { missing: true });
  f.options.execFileImpl = (_file, args, _options, callback) => {
    assert.equal(args[2], 'config');
    callback(null, 'remote.origin.url https://github.com/other/project.git\n');
  };
  assert.deepEqual(await readCrossReviewState(f.registration, f.pr, f.options), { unavailable: true, reason: 'repository-mismatch' });
});

for (const contents of [undefined, '{broken', JSON.stringify({ branches: { 'feat/open': { round: 2, dismissed: [] } } })]) {
  test(`現在のブランチに道具が無くても PR の head にあれば状態ファイルを読む (${contents === undefined ? '未作成' : contents === '{broken' ? '破損' : '記録あり'})`, async (t) => {
    const f = await headToolFixture(t, { contents });
    const original = f.options.execFileImpl;
    f.options.execFileImpl = (file, args, options, callback) => args[2] === 'ls-tree'
      ? callback(null, `100644 blob ${'b'.repeat(40)}\ttools/cross-review.js\n`) : original(file, args, options, callback);
    const result = await readCrossReviewStateAcrossWorktrees(f.registration, f.pr, f.options);
    if (contents === undefined) assert.equal(result, null);
    else if (contents === '{broken') assert.deepEqual(result, { unavailable: true });
    else assert.equal(result.round, 2);
  });
}

test('消えた cwd の親の根も PR のブランチの記録を持てば候補にする', async (t) => {
  const f = await headToolFixture(t, { missing: true, tool: true,
    contents: JSON.stringify({ branches: { 'feat/open': { round: 2, dismissed: [] } } }) });
  const original = f.options.execFileImpl;
  f.options.execFileImpl = (file, args, options, callback) => args[2] === 'worktree'
    ? callback(null, `worktree ${f.root}\nbranch refs/heads/main\n`) : original(file, args, options, callback);
  assert.equal((await readCrossReviewStateAcrossWorktrees(f.registration, f.pr, f.options)).round, 2);
});

test('prunable の worktree が残っていても PR の取り直しは例外にならず状態を保つ', async (t) => {
  const f = await headToolFixture(t, { tool: true, contents: '{broken' });
  const { tracker, github } = await trackerFixture(t, [31], f.root);
  github.openPullRequests = [f.pr];
  const observed = [];
  tracker.readCrossReviewState = (registration, pr, options) => readCrossReviewStateAcrossWorktrees(registration, pr, {
    ...options, observeReview: (record) => observed.push(record.cwd),
  });
  tracker.gitExecFileImpl = (_file, args, _options, callback) => callback(null, args[2] === 'worktree'
    ? `worktree ${f.root}\nbranch refs/heads/main\n\nworktree ${path.join(f.root, 'deleted')}\nbranch refs/heads/feat/open\nprunable gitdir file points to non-existent location\n`
    : '');
  await tracker.refreshRepo('example', 'project');
  assert.deepEqual(tracker.snapshot()[0].trees[0].crossReview, { unavailable: true });
  assert.deepEqual(observed, [f.root]);
});

test('同じ PR の登録が両方確認不能でも取り直しは例外にならない', async (t) => {
  const f = await headToolFixture(t, { tool: true, contents: '{broken' });
  const { tracker, state, github } = await trackerFixture(t, [31], f.root);
  state.registerPullRequest('session-other', { url: f.pr.url }, { cwd: f.root, product: { key: 'project', name: 'project' } });
  github.openPullRequests = [f.pr];
  tracker.gitExecFileImpl = f.options.execFileImpl;
  await tracker.refreshRepo('example', 'project');
  assert.deepEqual(tracker.snapshot()[0].trees[0].crossReview, { unavailable: true });
});

for (const order of [['missing', 'valid'], ['valid', 'missing']]) {
  test(`確認不能の登録があっても未実施を優先して催促する (${order.join(' → ')})`, async (t) => {
    const f = await headToolFixture(t, { tool: true });
    const { tracker, state, github } = await trackerFixture(t, []);
    for (const name of order) state.registerPullRequest(`session-${name}`, { url: f.pr.url }, {
      cwd: name === 'valid' ? f.root : path.join(f.root, 'missing'), product: { key: 'project', name: 'project' },
    });
    github.openPullRequests = [f.pr];
    tracker.gitExecFileImpl = (_file, _args, _options, callback) => callback(new Error('unavailable'));
    await tracker.refreshRepo('example', 'project');
    assert.equal(tracker.snapshot()[0].trees[0].crossReview, null);
    assert.deepEqual(await tracker.missingReviewRecords('session-valid'), [{ owner: 'example', repo: 'project', number: 31, headRefOid: f.pr.headRefOid }]);
  });
}

test('同じ根と head の道具確認を一度の取り直しで使い回す', async (t) => {
  const f = await headToolFixture(t, { missing: true });
  const { tracker, state, github } = await trackerFixture(t, [31], f.registration.cwd);
  state.registerPullRequest('session-other', { url: f.pr.url }, { cwd: f.registration.cwd, product: { key: 'project', name: 'project' } });
  github.openPullRequests = [f.pr];
  tracker.gitExecFileImpl = f.options.execFileImpl;
  await tracker.refreshRepo('example', 'project');
  assert.deepEqual(tracker.snapshot()[0].trees[0].crossReview, { notRequired: true, source: 'tool-absent' });
  assert.equal(f.calls.filter(({ args }) => args[2] === 'ls-tree').length, 1);
});

test('確かめた head の道具の有無を次の取り直しでも使う', async (t) => {
  const f = await headToolFixture(t, { missing: true });
  const { tracker, github } = await trackerFixture(t, [31], f.registration.cwd);
  github.openPullRequests = [f.pr];
  tracker.gitExecFileImpl = f.options.execFileImpl;
  await tracker.refreshRepo('example', 'project');
  await tracker.refreshRepo('example', 'project');
  assert.deepEqual(tracker.snapshot()[0].trees[0].crossReview, { notRequired: true, source: 'tool-absent' });
  assert.equal(f.calls.filter(({ args }) => args[2] === 'ls-tree').length, 1);
});

test('確かめられなかった head の道具の有無は次の取り直しで確かめ直す', async (t) => {
  const f = await headToolFixture(t, { missing: true });
  const { tracker, github } = await trackerFixture(t, [31], f.registration.cwd);
  github.openPullRequests = [f.pr];
  let lsTreeError = Object.assign(new Error('missing commit'), { code: 128 });
  let headLsTreeCalls = 0;
  tracker.gitExecFileImpl = (file, args, options, callback) => {
    if (args[2] !== 'ls-tree') return f.options.execFileImpl(file, args, options, callback);
    if (args[4] === f.pr.headRefOid) headLsTreeCalls += 1;
    callback(lsTreeError, '');
  };
  await tracker.refreshRepo('example', 'project');
  assert.deepEqual(tracker.snapshot()[0].trees[0].crossReview, { unavailable: true });
  lsTreeError = null;
  await tracker.refreshRepo('example', 'project');
  assert.deepEqual(tracker.snapshot()[0].trees[0].crossReview, { notRequired: true, source: 'tool-absent' });
  assert.equal(headLsTreeCalls, 2);
});

for (const timer of [false, true]) {
  test(`${timer ? '定期' : '初回'}の PR 取り直しが reject しても例外名だけを診断に残す`, async (t) => {
    const root = await temporaryDirectory(t);
    const { Diagnostics } = require('../src/server/diagnostics');
    const diagnostics = new Diagnostics({ homeDir: root });
    const { tracker } = await trackerFixture(t, []);
    tracker.diagnostics = diagnostics;
    let calls = 0;
    tracker.refreshAll = async () => {
      if (!timer || calls++ > 0) throw new TypeError('private-message /private/path');
    };
    t.mock.timers.enable({ apis: ['setInterval'] });
    t.after(() => tracker.close());
    tracker.start();
    if (timer) t.mock.timers.tick(60_000);
    await new Promise((resolve) => setImmediate(resolve));
    const entries = (await diagnostics.readRun(diagnostics.run)).filter((entry) => entry.msg === 'pr.refresh.failed');
    assert.deepEqual(entries.map(({ level, tag, data }) => ({ level, tag, data })), [
      { level: 'warn', tag: 'merge', data: { name: 'TypeError' } },
    ]);
    assert.doesNotMatch(JSON.stringify(entries), /private|stack|message/);
  });
}

for (const scenario of [
  { name: '今の head の収束', round: 2, outcome: 'converged', keepRecord: true },
  { name: '前の往復の収束', round: 1, outcome: 'converged' },
  { name: '別の head の収束', round: 2, outcome: 'converged', sha: 'b'.repeat(40) },
  { name: '対応中の記録', round: 2, outcome: 'fixing' },
  { name: '未実施', missing: true },
  { name: '確認不能', broken: true },
]) {
  test(`レビュー不要の記録後に「${scenario.name}」を読むと${scenario.keepRecord ? '収束記録を優先する' : '理由付きの不要を維持する'}`, async (t) => {
    const headSha = 'a'.repeat(40);
    const contents = scenario.broken ? '{broken' : JSON.stringify({ branches: scenario.missing ? {} : {
      'feat/open': { round: 2, dismissed: [], lastTriage: { round: scenario.round, sha: scenario.sha || headSha, outcome: scenario.outcome } },
    } });
    const f = await headToolFixture(t, { tool: true, contents });
    const { tracker, state, github } = await trackerFixture(t, [31], f.root);
    state.setCrossReviewSkip({ owner: 'example', repo: 'project', number: 31, headRefOid: headSha, reason: '文言だけの変更', recordedAt: new Date().toISOString() });
    github.openPullRequests = [f.pr];
    tracker.gitExecFileImpl = f.options.execFileImpl;
    await tracker.refreshRepo('example', 'project');
    const review = tracker.snapshot()[0].trees[0].crossReview;
    if (scenario.keepRecord) assert.deepEqual(review.triage, { round: 2, sha: headSha, outcome: 'converged' });
    else assert.deepEqual(review, { notRequired: true, source: 'recorded', reason: '文言だけの変更' });
  });
}
