const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  PullRequestTracker,
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
  parsePullRequestUrl,
  shouldRefreshPullRequests,
} = require('../src/server/pull-request-utils');
const { DashboardState } = require('../src/server/state');
const { temporaryDirectory: createTemporaryDirectory } = require('./support/temp');
const { ghPullRequest, pullRequest, pullRequestRegistration } = require('./support/github');

async function temporaryDirectory(testContext) {
  return createTemporaryDirectory(testContext, 'agent-cockpit-pr-test-').directory;
}

function mergedPullRequest(number, headRefOid, mergedAt = '2026-10-03T11:00:00.000Z', headRefName = '', baseRefName = '') {
  return { number, headRefOid, headRefName, baseRefName, mergedAt };
}

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
    if (exists) assert.match(tree.blocker, /base の codex\/feature は既定ブランチではない/);
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
      expected: 'base の missing/base は既定ブランチではないため、ダッシュボードではマージしない',
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
      openPullRequests: item.pullRequests,
      registrations: [pullRequestRegistration(item.number), ...(item.number === 22 ? [pullRequestRegistration(21)] : [])],
      relatedPullRequests: item.relatedPullRequests || [],
      retargetedPrs: item.retargetedPrs || [],
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
  assert.equal(group.trees[0].blocker, 'base の codex/feature は既定ブランチではないため、ダッシュボードではマージしない');
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
  assert.equal(group.trees[0].blocker, 'base の codex/feature は既定ブランチではないため、ダッシュボードではマージしない');
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
  assert.deepEqual(group.trees[0].crossReview, { notRequired: true, source: 'recorded', reason: '変更が文言だけのため' });
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
  assert.deepEqual(await readCrossReviewState({ number: 55, cwd: root }, { headRefName: 'feat/pr' }), {
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
    callback(null, [
      `worktree ${sessionRoot.replaceAll('\\', '/')}`, `HEAD ${'c'.repeat(40)}`, 'branch refs/heads/main', '',
      `worktree ${reviewRoot.replaceAll('\\', '/')}`, `HEAD ${headSha}`, 'branch refs/heads/feat/open', '',
    ].join('\n'));
  };
  github.openPullRequests = [ghPullRequest(31, 'feat/open', 'main', headSha)];
  github.comparisons.set(headSha, compareResult([headSha]));

  await tracker.refreshRepo('example', 'project');

  const [group] = tracker.snapshot();
  assert.deepEqual(gitCalls, [['git', '-C', sessionRoot, 'worktree', 'list', '--porcelain']]);
  assert.deepEqual(group.trees[0].crossReview, {
    round: 2, max: 3, dismissed: 0, reviewedSha: headSha, triage: { round: 2, sha: headSha, outcome: 'converged' },
  });
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
