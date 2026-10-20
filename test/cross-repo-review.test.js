const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { callTool } = require('../src/mcp/server');
const { productFromCwd } = require('../src/server/identity');
const { ghPullRequest } = require('./support/github');
const { startTestServer, request, jsonBody } = require('./support/server');

async function crossRepositoryServer(t, { matching = true, worktree = false, tool = true, commitTool = true } = {}) {
  const head = 'a'.repeat(40);
  const gitCalls = [];
  let roots;
  const { runtime, info, homeDir } = await startTestServer(t, {
    findSessionIdByPid: async () => null,
    pullRequestOptions: {
      execFileImpl: (_file, args, _options, callback) => {
        if (args[0] === 'pr' && args[1] === 'list') {
          callback(null, JSON.stringify(args.includes('open') ? [ghPullRequest(31, 'feature', 'main', head)] : []));
        } else if (args[1] === 'repos/example/project') {
          callback(null, JSON.stringify({ default_branch: 'main', allow_merge_commit: true }));
        } else if (args[1]?.includes('/compare/')) {
          callback(null, JSON.stringify({ ahead_by: 1, commits: [{ sha: head }] }));
        } else callback(new Error(`unexpected gh arguments: ${args.join(' ')}`));
      },
      gitExecFileImpl: (_file, args, _options, callback) => {
        gitCalls.push(args);
        if (args[2] === 'config') {
          const repo = matching && args[1] !== roots.session ? 'example/project' : 'other/project';
          callback(null, `remote.origin.url https://github.com/${repo}.git\n`);
        } else if (args[2] === 'worktree') {
          callback(null, args[1] === roots.session
            ? `worktree ${roots.session}\nbranch refs/heads/main\n`
            : `worktree ${roots.checkout}\nbranch refs/heads/main\n\nworktree ${roots.review}\nbranch refs/heads/feature\n`);
        } else if (args[2] === 'ls-tree') {
          callback(null, commitTool ? `100644 blob ${head}\ttools/cross-review.js\n` : '');
        } else callback(new Error('ref unavailable'));
      },
    },
  });
  roots = Object.fromEntries(['session', 'checkout', 'review'].map(name => [name, path.join(homeDir, name)]));
  for (const root of Object.values(roots)) await fs.mkdir(path.join(root, '.git'), { recursive: true });
  if (tool) {
    await fs.mkdir(path.join(roots.review, 'tools'));
    await fs.writeFile(path.join(roots.review, 'tools/cross-review.js'), '');
  }
  await fs.writeFile(path.join(worktree ? roots.review : roots.checkout, '.cross-review-state.json'), JSON.stringify({
    branches: { feature: { round: 2, dismissed: [], lastReviewedSha: head,
      lastTriage: { round: 2, sha: head, outcome: 'converged' } } },
  }));
  const add = (number, cwd, session = 'cross-repo') => callTool('cockpit_add_pr', {
    url: `https://github.com/example/project/pull/${number}`, ...(cwd === undefined ? {} : { cwd }),
  }, { environment: { CLAUDE_CODE_SESSION_ID: session }, ppid: 123, cwd: roots.session,
    ensureServerRunning: async () => info });
  const snapshot = async () => {
    await runtime.pullRequestTracker.refreshRepoFresh('example', 'project');
    return jsonBody(await request(info.port, { path: '/api/state' }));
  };
  return { runtime, info, roots, gitCalls, add, snapshot };
}

for (const worktree of [false, true]) {
  test(`別リポジトリの cwd で登録した PR は同じリポジトリの別登録の ${worktree ? 'worktree' : 'checkout'} の収束を読む`, async t => {
    const f = await crossRepositoryServer(t, { worktree, tool: false });
    await f.add(31);
    await f.add(32, f.roots.checkout, 'checkout-session');
    const snapshot = await f.snapshot();
    const pr = snapshot.pullRequests.flatMap(group => group.trees).find(pr => pr.number === 31);
    assert.equal(pr.review.evaluation.latest.outcome, 'converged');
    assert.equal(pr.mergeConditionMet, true);
    assert.ok(f.gitCalls.some(args => args[2] === 'ls-tree' && args[1] === f.roots.checkout));
    assert.ok(!f.gitCalls.some(args => args[1] === f.roots.session && args[2] === 'ls-tree'));
  });
}

test('別登録の checkout の head に道具が無ければレビュー不要にする', async t => {
  const f = await crossRepositoryServer(t, { tool: false, commitTool: false });
  await f.add(31);
  await f.add(32, f.roots.checkout, 'checkout-session');
  const snapshot = await f.snapshot();
  const pr = snapshot.pullRequests.flatMap(group => group.trees).find(pr => pr.number === 31);
  assert.equal(pr.review.evaluation.decision.source, 'tool-absent');
});

test('別登録の checkout の remote が変わっていればクロスレビューは確認不能を保つ', async t => {
  const f = await crossRepositoryServer(t, { matching: false });
  await f.add(31);
  await request(f.info.port, { method: 'POST', path: '/api/sessions/checkout-session/prs',
    headers: { 'content-type': 'application/json', 'x-cockpit-secret': f.info.secret },
    body: JSON.stringify({ kind: 'add_pr', url: 'https://github.com/example/project/pull/32',
      ppid: 123, claudeCodeSessionId: 'checkout-session', cwd: f.roots.checkout }) });
  const snapshot = await f.snapshot();
  const pr = snapshot.pullRequests.flatMap(group => group.trees).find(pr => pr.number === 31);
  assert.equal(pr.review.evaluation.record, 'unavailable');
  assert.ok(pr.mergeConditionWaits.includes('クロスレビューの状態を確認できない'));
});

test('cockpit_add_pr は remote が一致する cwd で既存の PR を付け直す', async t => {
  const f = await crossRepositoryServer(t);
  await f.add(31);
  const before = f.runtime.state.pullRequestRegistrations()[0];
  const result = await f.add(31, f.roots.checkout);
  assert.equal(result.isError, undefined);
  const records = f.runtime.state.pullRequestRegistrations();
  assert.equal(records.length, 1);
  assert.equal(records[0].cwd, f.roots.checkout);
  assert.equal(records[0].addedAt, before.addedAt);
  const product = productFromCwd(f.roots.checkout);
  assert.deepEqual(records[0].product, { key: product.key, name: product.name });
});

test('cockpit_add_pr は remote が不一致か読めない cwd では元の cwd を使う', async t => {
  const f = await crossRepositoryServer(t, { matching: false });
  for (const cwd of [f.roots.checkout, path.join(f.roots.checkout, 'missing')]) {
    const result = await f.add(31, cwd);
    assert.equal(result.isError, undefined);
    assert.equal(f.runtime.state.pullRequestRegistrations()[0].cwd, f.roots.session);
  }
});

test('cockpit_add_pr は cwd の型違い、長さ超過、相対パスを拒否する', async () => {
  for (const cwd of [123, 'x'.repeat(4097), 'relative/path']) {
    const result = await callTool('cockpit_add_pr', { url: 'https://github.com/example/project/pull/31', cwd });
    assert.equal(result.isError, true);
  }
});
