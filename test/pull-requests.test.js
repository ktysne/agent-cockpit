const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const {
  PullRequestTracker,
  assemblePullRequestStacks,
  parsePullRequestList,
  readCrossReviewState,
  runGh,
} = require('../src/server/pull-requests');
const {
  findPullRequestUrl,
  firstPullRequestUrl,
  isGhPrCreateCommand,
  parsePullRequestUrl,
  shouldRefreshPullRequests,
} = require('../src/server/pull-request-utils');
const { DashboardState } = require('../src/server/state');

async function temporaryDirectory(testContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-pr-test-'));
  testContext.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function pullRequest(number, headRefName, baseRefName, changes = {}) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/example/project/pull/${number}`,
    headRefName,
    baseRefName,
    headRefOid: String(number).padStart(40, '0'),
    draft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    ci: 'pass',
    review: 'none',
    conflict: false,
    state: 'open',
    mergedAt: null,
    ...changes,
  };
}

function registration(number, state = 'open', lastOpen = null) {
  return {
    session_id: `session-${number}`,
    owner: 'example',
    repo: 'project',
    number,
    url: `https://github.com/example/project/pull/${number}`,
    addedAt: '2026-10-03T00:00:00.000Z',
    cwd: null,
    product: { key: 'project', name: 'project' },
    state,
    mergedAt: null,
    lastOpen,
  };
}

function ghPullRequest(number, headRefName, baseRefName, sha) {
  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/example/project/pull/${number}`,
    headRefName,
    baseRefName,
    headRefOid: sha,
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: 'CLEAN',
    reviewDecision: '',
    statusCheckRollup: [{ state: 'SUCCESS', conclusion: 'SUCCESS' }],
  };
}

function mergedPullRequest(number, headRefOid, mergedAt = '2026-10-03T11:00:00.000Z') {
  return { number, headRefOid, mergedAt };
}

function compareResult(commits = [], aheadBy = commits.length) {
  return { ahead_by: aheadBy, commits: commits.map((sha) => ({ sha })) };
}

function checkedRestackResults(pullRequests, parent = null) {
  return new Map(pullRequests.map((pr) => [pr.number, { checked: true, parent }]));
}

async function trackerFixture(testContext, registeredNumbers = [31]) {
  const homeDir = await temporaryDirectory(testContext);
  const state = new DashboardState({ homeDir });
  for (const number of registeredNumbers) {
    state.registerPullRequest(`session-${number}`, { url: `https://github.com/example/project/pull/${number}` }, {
      cwd: process.cwd(), product: { key: 'project', name: 'project' },
    });
  }
  const github = {
    openPullRequests: [],
    mergedPullRequests: [],
    comparisons: new Map(),
    compareErrors: new Set(),
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
      } else if (args[0] === 'api' && args[1].includes('/compare/')) {
        const headSha = args[1].split('...').at(-1);
        if (github.compareErrors.has(headSha)) {
          callback(Object.assign(new Error('compare failed'), { code: 'EIO' }));
        } else {
          callback(null, JSON.stringify(github.comparisons.get(headSha) || compareResult()));
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
    registrations: [registration(11)],
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
  const merged = registration(32, 'merged', {
    title: 'merged', url: 'https://github.com/example/project/pull/32',
    headRefName: 'feat/merged', baseRefName: 'main', headRefOid: 'a'.repeat(40),
    isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: '',
    ci: 'pass', review: 'none', conflict: false,
  });
  const withoutRetarget = assemblePullRequestStacks({
    defaultBranch: 'main', openPullRequests: [child], registrations: [registration(33), merged],
    restackResults: checkedRestackResults([child]),
  }).trees[0];
  assert.equal(withoutRetarget.effectiveBase, 'main');
  assert.equal(withoutRetarget.retargetedFrom, null);
  assert.equal(withoutRetarget.blocker, 'base を main に付け替える必要がある');

  const withRetarget = assemblePullRequestStacks({
    defaultBranch: 'main', openPullRequests: [child], registrations: [registration(33), merged],
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
      expected: 'base の missing/base に対応する PR が見つからない',
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
      registrations: [registration(item.number), ...(item.number === 22 ? [registration(21)] : [])],
      retargetedPrs: item.retargetedPrs || [],
      restackResults,
    });
    const find = (tree) => tree.number === item.number ? tree : tree.children.map(find).find(Boolean);
    assert.equal(find(result.trees[0]).blocker, item.expected);
  }
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
    'pr', 'list', '-R', 'example/project', '--state', 'merged', '--limit', '1000', '--json', 'number,headRefOid,mergedAt',
  ]);
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
  }
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
  assert.equal(group.registeredCount, 1);
  assert.deepEqual(group.trees, []);
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
          allow_squash_merge: false, allow_rebase_merge: true,
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
  assert.equal(group.merged[0].state, 'merged');
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

test('クロスレビュー状態は PR head ブランチの round と非対応件数だけを読む', async (t) => {
  const root = await temporaryDirectory(t);
  await fs.mkdir(path.join(root, '.git'));
  await fs.writeFile(path.join(root, '.cross-review-state.json'), JSON.stringify({
    branches: { 'feat/pr': { round: 2, dismissed: ['一件目', '二件目'] } },
  }));
  const value = await readCrossReviewState({ number: 55, cwd: root }, { headRefName: 'feat/pr' });
  assert.deepEqual(value, { number: 55, branch: 'feat/pr', round: 2, max: 3, dismissed: 2 });
  assert.equal(await readCrossReviewState({ number: 55, cwd: root }, { headRefName: 'missing' }), null);
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
  const [group] = tracker.snapshot();
  assert.equal(group.trees[0].blocker, '積み直しが必要か確かめられない');
  assert.equal(group.mergeableCount, 0);
});

test('親だけを登録したスタックで、親がマージされ子の base が main に付け替わっても子を表示し続ける', () => {
  const parentSha = 'a'.repeat(40);
  const child = pullRequest(31, 'feat/child', 'main');
  const parent = registration(30, 'merged', {
    title: 'PR 30', url: 'https://github.com/example/project/pull/30',
    headRefName: 'feat/parent', baseRefName: 'main', headRefOid: parentSha,
  });
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
