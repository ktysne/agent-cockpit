'use strict';

const crypto = require('node:crypto');

// 常駐サーバーが gh から読む項目。ここに無い項目を要求されたら、取得の作りが変わったとみなして止める。
const PULL_REQUEST_FIELDS = Object.freeze({
  number: (pr) => pr.number,
  title: (pr) => pr.title,
  url: (pr, repo) => `https://github.com/${repo.name}/pull/${pr.number}`,
  headRefName: (pr) => pr.head,
  baseRefName: (pr) => pr.base,
  headRefOid: (pr) => pr.headRefOid,
  isCrossRepository: () => false,
  isDraft: (pr) => pr.draft === true,
  mergeable: (pr) => pr.mergeable,
  mergeStateStatus: (pr) => pr.mergeStateStatus,
  reviewDecision: (pr) => pr.reviewDecision,
  statusCheckRollup: (pr) => checkRollup(pr.checks),
  createdAt: (pr) => pr.createdAt,
  state: (pr) => pr.state,
  mergedAt: (pr) => pr.mergedAt,
});

const MERGE_METHOD_FLAGS = new Map([['--merge', 'merge'], ['--squash', 'squash'], ['--rebase', 'rebase']]);

function checkRollup(checks) {
  if (checks === 'none') return null;
  if (checks === 'pass') return [{ name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS' }];
  if (checks === 'pending') return [{ name: 'build', status: 'IN_PROGRESS', conclusion: '' }];
  if (checks === 'fail') return [{ name: 'build', status: 'COMPLETED', conclusion: 'FAILURE' }];
  throw new Error(`CI の状態が不正です: ${checks}`);
}

function sha(label) {
  return crypto.createHash('sha1').update(label).digest('hex');
}

function normalizeRepository(name, definition) {
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(name)) throw new Error(`リポジトリ名が不正です: ${name}`);
  const numbers = new Set();
  const pullRequests = (definition.pullRequests || []).map((pr) => {
    if (!Number.isSafeInteger(pr.number) || pr.number < 1 || numbers.has(pr.number)) throw new Error(`${name} の PR 番号が不正か重複しています: ${pr.number}`);
    numbers.add(pr.number);
    const state = pr.state || 'OPEN';
    if (!['OPEN', 'MERGED', 'CLOSED'].includes(state)) throw new Error(`${name}#${pr.number} の state が不正です: ${state}`);
    const headRefOid = pr.headRefOid || sha(`${name}#${pr.number}`);
    return {
      number: pr.number,
      title: pr.title,
      head: pr.head,
      base: pr.base || definition.defaultBranch || 'main',
      headRefOid,
      draft: pr.draft === true,
      mergeable: pr.mergeable || 'MERGEABLE',
      mergeStateStatus: pr.mergeStateStatus || 'CLEAN',
      reviewDecision: pr.reviewDecision ?? '',
      checks: pr.checks || 'pass',
      createdAt: pr.createdAt,
      state,
      mergedAt: pr.mergedAt || null,
      // 親が先にマージされた PR の差分に、親のコミットが残っている状態を作る。
      parentCommits: [...(pr.parentCommits || [])],
    };
  });
  return {
    name,
    defaultBranch: definition.defaultBranch || 'main',
    autoDeleteBranch: definition.autoDeleteBranch === true,
    mergeMethods: definition.mergeMethods || ['merge', 'squash', 'rebase'],
    pullRequests,
    deletedBranches: [],
  };
}

function flagValue(args, flag) {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

// PullRequestTracker と PullRequestMergeManager が呼ぶ gh の部分だけを、シナリオの PR の定義から返す。
// 定義に無い呼び出しは onUnexpected に記録して失敗にする。撮影はその記録を見て止まる。
function createFakeGh(definition, { now = () => Date.now(), onUnexpected = () => {} } = {}) {
  const repositories = new Map();
  for (const [name, repo] of Object.entries(definition.repositories || {})) repositories.set(name.toLowerCase(), normalizeRepository(name, repo));
  const unexpected = [];

  function fail(args, reason) {
    const message = `偽の gh が扱えない呼び出しです: gh ${args.join(' ')}${reason ? `(${reason})` : ''}`;
    unexpected.push(message);
    onUnexpected(message);
    throw Object.assign(new Error(message), { code: 'DEMO_UNEXPECTED_GH', stderr: message });
  }

  function projectFields(args, pr, repo, fieldList) {
    const fields = fieldList.split(',');
    const unknown = fields.filter((field) => !Object.hasOwn(PULL_REQUEST_FIELDS, field));
    if (unknown.length) fail(args, `扱えない項目: ${unknown.join(',')}`);
    return Object.fromEntries(fields.map((field) => [field, PULL_REQUEST_FIELDS[field](pr, repo)]));
  }

  function repositoryFor(args, name) {
    const repo = repositories.get(String(name || '').toLowerCase());
    return repo || fail(args, 'リポジトリが定義に無い');
  }

  function pullRequestFor(args, repo, number) {
    const pr = repo.pullRequests.find((item) => String(item.number) === String(number));
    return pr || fail(args, `#${number} が定義に無い`);
  }

  function handlePullRequest(args) {
    const [, action, ...rest] = args;
    if (action === 'list') {
      const repo = repositoryFor(args, flagValue(args, '-R'));
      const state = flagValue(args, '--state');
      const fields = flagValue(args, '--json');
      if (!fields || !['open', 'merged'].includes(state)) fail(args, '--state か --json が想定外');
      const wanted = state === 'open' ? 'OPEN' : 'MERGED';
      return JSON.stringify(repo.pullRequests.filter((pr) => pr.state === wanted).map((pr) => projectFields(args, pr, repo, fields)));
    }
    if (action === 'view') {
      const repo = repositoryFor(args, flagValue(args, '-R'));
      const pr = pullRequestFor(args, repo, rest[0]);
      const fields = flagValue(args, '--json');
      if (!fields) fail(args, '--json が無い');
      return JSON.stringify(projectFields(args, pr, repo, fields));
    }
    if (action === 'edit') {
      const repo = repositoryFor(args, flagValue(args, '-R'));
      const pr = pullRequestFor(args, repo, rest[0]);
      const base = flagValue(args, '--base');
      if (!base || pr.state !== 'OPEN') fail(args, '付け替えられない');
      pr.base = base;
      return '';
    }
    if (action === 'merge') {
      const repo = repositoryFor(args, flagValue(args, '-R'));
      const pr = pullRequestFor(args, repo, rest[0]);
      const method = args.map((arg) => MERGE_METHOD_FLAGS.get(arg)).find(Boolean);
      const expectedHead = flagValue(args, '--match-head-commit');
      if (!method || !repo.mergeMethods.includes(method) || pr.state !== 'OPEN') fail(args, 'マージできない');
      if (expectedHead !== pr.headRefOid) fail(args, 'head が一致しない');
      pr.state = 'MERGED';
      pr.mergedAt = new Date(now()).toISOString();
      return '';
    }
    return fail(args);
  }

  function handleApi(args) {
    const deleteMatch = args.length === 4 && args[1] === '-X' && args[2] === 'DELETE'
      && args[3].match(/^repos\/([^/]+\/[^/]+)\/git\/refs\/heads\/(.+)$/);
    if (deleteMatch) {
      const repo = repositoryFor(args, deleteMatch[1]);
      repo.deletedBranches.push(deleteMatch[2]);
      return '';
    }
    if (args.length !== 2) return fail(args);
    const compare = args[1].match(/^repos\/([^/]+\/[^/]+)\/compare\/([^/]+)\.\.\.([a-f0-9]+)$/i);
    if (compare) {
      const repo = repositoryFor(args, compare[1]);
      const pr = repo.pullRequests.find((item) => item.headRefOid === compare[3].toLowerCase()) || fail(args, 'head が定義に無い');
      if (decodeURIComponent(compare[2]) !== repo.defaultBranch) fail(args, '比較の base が既定ブランチではない');
      const commits = [...pr.parentCommits, pr.headRefOid].map((value) => ({ sha: value }));
      return JSON.stringify({ ahead_by: commits.length, commits });
    }
    const repository = args[1].match(/^repos\/([^/]+\/[^/]+)$/);
    if (repository) {
      const repo = repositoryFor(args, repository[1]);
      return JSON.stringify({
        default_branch: repo.defaultBranch,
        delete_branch_on_merge: repo.autoDeleteBranch,
        allow_merge_commit: repo.mergeMethods.includes('merge'),
        allow_squash_merge: repo.mergeMethods.includes('squash'),
        allow_rebase_merge: repo.mergeMethods.includes('rebase'),
      });
    }
    return fail(args);
  }

  function run(file, args) {
    if (file !== 'gh') fail([file, ...args], 'gh 以外のコマンド');
    if (args[0] === 'pr') return handlePullRequest(args);
    if (args[0] === 'api') return handleApi(args);
    return fail(args);
  }

  // child_process.execFile と同じ形で、コールバックを非同期に呼ぶ。
  function execFileImpl(file, args, options, callback) {
    Promise.resolve().then(() => run(file, args)).then(
      (stdout) => callback(null, stdout, ''),
      (error) => callback(error, '', error.stderr || ''),
    );
  }

  return {
    execFileImpl,
    unexpectedCalls: () => [...unexpected],
    repository: (name) => repositories.get(name.toLowerCase()) || null,
  };
}

module.exports = { createFakeGh, checkRollup, sha };
