'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { validRepositoryPart } = require('./pull-request-utils');

const PULL_REQUEST_FIELDS = 'number,title,url,headRefName,baseRefName,headRefOid,isCrossRepository,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,createdAt';
const MERGED_PULL_REQUEST_LIMIT = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const CROSS_REVIEW_MAX_ROUNDS = 3;
const SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function asText(value, maximum = 500) {
  return typeof value === 'string' ? value.slice(0, maximum) : '';
}

function ciState(value) {
  if (value === null) return 'pass';
  if (!Array.isArray(value)) return 'pending';
  let pending = false;
  for (const check of value) {
    if (!check || typeof check !== 'object') continue;
    const conclusion = String(check.conclusion || '').toUpperCase();
    const state = String(check.state || '').toUpperCase();
    const status = String(check.status || '').toUpperCase();
    if (['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE', 'STALE'].includes(conclusion) ||
      ['FAILURE', 'ERROR'].includes(state)) return 'fail';
    if (['PENDING', 'EXPECTED', 'REQUESTED', 'QUEUED', 'IN_PROGRESS', 'WAITING'].includes(state) ||
      (status && status !== 'COMPLETED') || (!conclusion && !state && status)) pending = true;
  }
  return pending ? 'pending' : 'pass';
}

function reviewState(value) {
  if (value === 'APPROVED') return 'approved';
  if (value === 'CHANGES_REQUESTED') return 'changes';
  if (value === 'REVIEW_REQUIRED') return 'required';
  return 'none';
}

function normalizeOpenPullRequest(value) {
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(Number(value.number)) || Number(value.number) < 1) return null;
  const number = Number(value.number);
  const url = asText(value.url, 2000);
  if (!/^https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[1-9]\d*\/?$/.test(url)) return null;
  return {
    number,
    title: asText(value.title, 500),
    url: url.replace(/\/$/, ''),
    headRefName: asText(value.headRefName, 500),
    baseRefName: asText(value.baseRefName, 500),
    headRefOid: SHA_PATTERN.test(value.headRefOid || '') ? value.headRefOid : '',
    isCrossRepository: value.isCrossRepository === true,
    createdAt: typeof value.createdAt === 'string' && Number.isFinite(Date.parse(value.createdAt)) ? value.createdAt : '',
    draft: value.isDraft === true,
    mergeable: asText(value.mergeable, 40).toUpperCase(),
    mergeStateStatus: asText(value.mergeStateStatus, 40).toUpperCase(),
    reviewDecision: ['APPROVED', 'CHANGES_REQUESTED', 'REVIEW_REQUIRED'].includes(value.reviewDecision)
      ? value.reviewDecision
      : '',
    ci: ciState(value.statusCheckRollup),
    review: reviewState(value.reviewDecision),
    conflict: value.mergeable === 'CONFLICTING' || value.mergeStateStatus === 'DIRTY',
    state: 'open',
    mergedAt: null,
  };
}

function parsePullRequestList(stdout) {
  const values = JSON.parse(stdout);
  if (!Array.isArray(values)) throw new Error('invalid PR list');
  return values.map(normalizeOpenPullRequest).filter(Boolean);
}

function lastOpenPullRequest(pr) {
  return {
    title: pr.title,
    url: pr.url,
    headRefName: pr.headRefName,
    baseRefName: pr.baseRefName,
    headRefOid: pr.headRefOid,
    isCrossRepository: pr.isCrossRepository,
    isDraft: pr.draft,
    mergeable: pr.mergeable,
    mergeStateStatus: pr.mergeStateStatus,
    reviewDecision: pr.reviewDecision,
    ci: pr.ci,
    review: pr.review,
    conflict: pr.conflict,
  };
}

function parseRepositoryConfig(stdout) {
  const value = JSON.parse(stdout);
  if (!value || typeof value !== 'object' || typeof value.default_branch !== 'string' || !value.default_branch) {
    throw new Error('invalid repository settings');
  }
  return {
    defaultBranch: value.default_branch.slice(0, 500),
    autoDeleteBranch: value.delete_branch_on_merge === true,
    mergeMethods: [
      value.allow_merge_commit === true ? 'merge' : null,
      value.allow_squash_merge === true ? 'squash' : null,
      value.allow_rebase_merge === true ? 'rebase' : null,
    ].filter(Boolean),
  };
}

function storedPullRequest(registration) {
  const known = registration.lastOpen || {};
  if (!Number.isSafeInteger(registration.number) || registration.number < 1) return null;
  if (!known.headRefName && !known.baseRefName && !known.title) return null;
  return {
    number: registration.number,
    title: asText(known.title, 500),
    url: asText(known.url || registration.url, 2000),
    headRefName: asText(known.headRefName, 500),
    baseRefName: asText(known.baseRefName, 500),
    headRefOid: SHA_PATTERN.test(known.headRefOid || '') ? known.headRefOid : '',
    isCrossRepository: known.isCrossRepository === true,
    draft: known.isDraft === true,
    mergeable: asText(known.mergeable, 40).toUpperCase(),
    mergeStateStatus: asText(known.mergeStateStatus, 40).toUpperCase(),
    reviewDecision: asText(known.reviewDecision, 40),
    ci: known.ci || 'pending',
    review: known.review || 'none',
    conflict: known.conflict === true,
    state: registration.state || 'unknown',
    mergedAt: registration.mergedAt || null,
  };
}

function storedRelatedPullRequest(record) {
  return storedPullRequest({
    number: record.number,
    url: record.url,
    state: record.state,
    mergedAt: record.mergedAt,
    lastOpen: record.lastOpen,
  });
}

function mapByNumber(values) {
  return new Map(values.map((value) => [value.number, value]));
}

function parseMergedPullRequestList(stdout) {
  const values = JSON.parse(stdout);
  if (!Array.isArray(values)) throw new Error('invalid merged PR list');
  return values.map((value) => {
    const number = Number(value?.number);
    const headRefOid = value?.headRefOid;
    const mergedAt = value?.mergedAt;
    if (!Number.isSafeInteger(number) || number < 1 || !SHA_PATTERN.test(headRefOid || '') ||
      typeof mergedAt !== 'string' || !Number.isFinite(Date.parse(mergedAt))) {
      throw new Error('invalid merged PR');
    }
    return { number, headRefOid: headRefOid.toLowerCase(), mergedAt };
  }).sort((left, right) => Date.parse(left.mergedAt) - Date.parse(right.mergedAt) || left.number - right.number);
}

function parseCompareResult(stdout) {
  const value = JSON.parse(stdout);
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.ahead_by) || value.ahead_by < 0 ||
    !Array.isArray(value.commits) || !value.commits.every((commit) => SHA_PATTERN.test(commit?.sha || ''))) {
    throw new Error('invalid compare result');
  }
  if (value.commits.length < value.ahead_by) return null;
  return new Set(value.commits.map((commit) => commit.sha.toLowerCase()));
}

// 親が見つからなくても、マージ済みの一覧が上限で切れていれば見逃しを否定できないので確かめられない扱いにする。
function restackResult(commits, mergedPullRequests, mergedListComplete = true) {
  if (!commits) return { checked: false, parent: null };
  const parent = mergedPullRequests.find((candidate) => commits.has(candidate.headRefOid)) || null;
  return { checked: Boolean(parent) || mergedListComplete, parent };
}

// 積まれた子の親は子が作られた後にマージされるので、オープンの PR の最も古い作成日より後のマージだけを取る。
// gh の検索は日付の単位なので、1 日前から取る。
function mergedSearchSince(openPullRequests) {
  const created = openPullRequests.map((pr) => Date.parse(pr.createdAt)).filter(Number.isFinite);
  if (!created.length) return null;
  return new Date(Math.min(...created) - DAY_MS).toISOString().slice(0, 10);
}

function assemblePullRequestStacks({
  defaultBranch,
  openPullRequests = [],
  registrations = [],
  retargetedPrs = [],
  relatedPullRequests = [],
  restackResults = new Map(),
}) {
  const open = openPullRequests.map((pr) => ({ ...pr })).sort((left, right) => left.number - right.number);
  const openByNumber = mapByNumber(open);
  const historical = [...registrations, ...relatedPullRequests]
    .filter((record) => !openByNumber.has(record.number) && ['merged', 'closed'].includes(record.state))
    .map((record) => record.session_id ? storedPullRequest(record) : storedRelatedPullRequest(record))
    .filter(Boolean);
  const nodes = [...open, ...historical];
  const nodeByNumber = mapByNumber(nodes);

  function effective(pr) {
    const explicit = retargetedPrs.find((record) => record.number === pr.number);
    const check = restackResults.get(pr.number) || { checked: false, parent: null };
    let base = explicit?.base || pr.baseRefName;
    const seen = new Set([pr.number]);
    while (base) {
      const merged = historical.find((candidate) => candidate.state === 'merged' &&
        candidate.headRefName === base && candidate.number !== pr.number);
      if (!merged || seen.has(merged.number)) break;
      seen.add(merged.number);
      base = merged.baseRefName;
    }
    return {
      base: base || pr.baseRefName,
      retargetedFrom: explicit ? { number: explicit.fromNumber || null } : null,
      needsRestack: Boolean(check.parent),
      restackCheckUnknown: check.checked !== true,
      restackPr: check.parent,
    };
  }

  const parentByNumber = new Map();
  for (const pr of open) {
    const base = effective(pr).base;
    const parent = open.find((candidate) => candidate.number !== pr.number && candidate.headRefName === base);
    if (parent) parentByNumber.set(pr.number, parent.number);
  }

  const childrenByNumber = new Map(open.map((pr) => [pr.number, []]));
  for (const [child, parent] of parentByNumber) childrenByNumber.get(parent)?.push(child);
  for (const children of childrenByNumber.values()) children.sort((left, right) => left - right);

  const edges = new Map(nodes.map((pr) => [pr.number, new Set()]));
  for (const parent of nodes) {
    for (const child of nodes) {
      if (parent.number !== child.number && parent.headRefName && parent.headRefName === child.baseRefName) {
        edges.get(parent.number)?.add(child.number);
        edges.get(child.number)?.add(parent.number);
      }
    }
  }
  for (const [child, parent] of parentByNumber) {
    edges.get(child)?.add(parent);
    edges.get(parent)?.add(child);
  }
  // base を付け替えた後はブランチ名でつながらないので、積み直しの判定で見つけた親子でもつなぐ。
  for (const [child, check] of restackResults) {
    const parent = check?.parent?.number;
    if (!parent || !nodeByNumber.has(child) || !nodeByNumber.has(parent)) continue;
    edges.get(child)?.add(parent);
    edges.get(parent)?.add(child);
  }

  const seedNumbers = new Set(registrations.map((record) => record.number));
  const visibleNumbers = new Set();
  const queue = [...seedNumbers].filter((number) => nodeByNumber.has(number));
  while (queue.length) {
    const current = queue.shift();
    if (visibleNumbers.has(current)) continue;
    visibleNumbers.add(current);
    for (const neighbor of edges.get(current) || []) if (!visibleNumbers.has(neighbor)) queue.push(neighbor);
  }
  const visibleOpen = open.filter((pr) => visibleNumbers.has(pr.number));
  const visibleClosed = historical.filter((pr) => visibleNumbers.has(pr.number));
  const registeredNumbers = new Set(registrations.map((record) => record.number));
  const visibleOpenNumbers = new Set(visibleOpen.map((pr) => pr.number));
  const roots = visibleOpen.filter((pr) => !visibleOpenNumbers.has(parentByNumber.get(pr.number)));

  function blockerFor(pr) {
    const value = effective(pr);
    if (!defaultBranch) return 'リポジトリ設定を取得できません';
    const hasBasePullRequest = visibleOpen.some((candidate) => candidate.headRefName === value.base);
    if (value.base !== defaultBranch && !hasBasePullRequest) return `base の ${value.base} に対応する PR が見つからない`;
    const parent = visibleOpen.find((candidate) => candidate.number === parentByNumber.get(pr.number));
    if (parent) return `下の #${parent.number} のマージ待ち`;
    if (pr.baseRefName !== defaultBranch) return `base を ${defaultBranch} に付け替える必要がある`;
    if (pr.draft) return 'ドラフト';
    if (value.needsRestack) {
      return `積み直し待ち (#${value.restackPr.number} が ${defaultBranch} に入った後も、そのコミットが差分に残っている)`;
    }
    if (value.restackCheckUnknown) return '積み直しが必要か確かめられない';
    if (pr.conflict) return 'コンフリクトあり';
    if (pr.ci === 'fail') return 'CI が失敗';
    if (pr.ci === 'pending') return 'CI 実行中';
    if (pr.review === 'changes') return '変更を求められている';
    if (pr.review === 'required') return 'レビューの承認待ち';
    return null;
  }

  function treeFor(root, depth, rootHeight, ancestors = new Set()) {
    if (ancestors.has(root.number)) return null;
    const nextAncestors = new Set(ancestors).add(root.number);
    const effectiveValue = effective(root);
    const blocker = blockerFor(root);
    const children = (childrenByNumber.get(root.number) || [])
      .filter((number) => visibleOpenNumbers.has(number))
      .map((number) => nodeByNumber.get(number))
      .map((child) => treeFor(child, depth + 1, rootHeight, nextAncestors))
      .filter(Boolean);
    return {
      ...root,
      effectiveBase: effectiveValue.base,
      retargetedFrom: effectiveValue.retargetedFrom?.number || null,
      needsRestack: effectiveValue.needsRestack,
      restackPr: effectiveValue.restackPr?.number || null,
      restackCheckUnknown: effectiveValue.restackCheckUnknown,
      parentNumber: parentByNumber.get(root.number) || null,
      stackPosition: { depth, total: rootHeight },
      blocker,
      canMerge: blocker === null,
      children,
    };
  }

  function subtreeHeight(number, ancestors = new Set()) {
    if (ancestors.has(number)) return 0;
    const nextAncestors = new Set(ancestors).add(number);
    return 1 + Math.max(0, ...(childrenByNumber.get(number) || [])
      .filter((child) => visibleOpenNumbers.has(child))
      .map((child) => subtreeHeight(child, nextAncestors)));
  }

  const unvisitedRoots = [...roots];
  const trees = unvisitedRoots.map((root) => treeFor(root, 1, subtreeHeight(root.number))).filter(Boolean);
  for (const pr of visibleOpen) {
    if (!trees.some((tree) => hasTreeNumber(tree, pr.number))) trees.push(treeFor(pr, 1, subtreeHeight(pr.number)));
  }

  return {
      trees,
      openCount: visibleOpen.length,
      mergeableCount: visibleOpen.filter((pr) => blockerFor(pr) === null).length,
      relatedOpen: visibleOpen.filter((pr) => !registeredNumbers.has(pr.number)),
      merged: visibleClosed,
    orphanedOpenNumbers: visibleOpen.filter((pr) => blockerFor(pr) && blockerFor(pr).startsWith('base の ')).map((pr) => pr.number),
  };
}

function hasTreeNumber(tree, number) {
  return tree.number === number || tree.children.some((child) => hasTreeNumber(child, number));
}

function runGh(args, options = {}) {
  const execFileImpl = options.execFileImpl || execFile;
  const ghPath = options.ghPath || 'gh';
  return new Promise((resolve, reject) => {
    execFileImpl(ghPath, args, {
      encoding: 'utf8',
      timeout: options.timeoutMs || 20_000,
      maxBuffer: 4 * 1024 * 1024,
      windowsHide: true,
      shell: false,
      env: ghEnvironment(options.environment),
    }, (error, stdout, stderr) => {
      if (error) {
        if (stderr && error.stderr == null) error.stderr = stderr;
        reject(error);
      } else resolve(stdout);
    });
  });
}

function ghErrorMessage(error) {
  if (error?.code === 'ENOENT') return 'gh コマンドが見つかりません';
  if (error?.code === 'ETIMEDOUT' || error?.killed) return 'gh の取得がタイムアウトしました';
  if (error?.code === 'EPERM' || error?.code === 'EACCES') return 'gh を実行できません';
  return 'gh の認証、通信、または取得結果を確認してください';
}

function ghEnvironment(environment = process.env) {
  const credentialVariables = new Set(['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN']);
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !credentialVariables.has(key.toUpperCase())));
}

function safeRepo(owner, repo) {
  if (!validRepositoryPart(owner) || !validRepositoryPart(repo)) throw new Error('invalid repository');
  return `${owner}/${repo}`;
}

function repoKey(owner, repo) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

async function findWorktreeRoot(cwd, fileSystem = fs) {
  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return null;
  let current = path.resolve(cwd);
  while (true) {
    try {
      await fileSystem.stat(path.join(current, '.git'));
      return current;
    } catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes(error.code)) return null;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function crossReviewToolExists(cwd, fileSystem = fs) {
  const root = await findWorktreeRoot(cwd, fileSystem);
  if (!root) return false;
  try {
    await fileSystem.stat(path.join(root, 'tools', 'cross-review.js'));
    return true;
  } catch {
    return false;
  }
}

async function readCrossReviewState(registration, pullRequest, fileSystem = fs) {
  const branch = pullRequest?.headRefName;
  if (!registration.cwd) return undefined;
  // 状態ファイルは初回レビューまで作られないため、ツール本体の有無で連携を判定する。
  if (!(await crossReviewToolExists(registration.cwd, fileSystem))) return undefined;
  const root = await findWorktreeRoot(registration.cwd, fileSystem);
  if (!root) return undefined;
  let contents;
  try {
    contents = await fileSystem.readFile(path.join(root, '.cross-review-state.json'), 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed = JSON.parse(contents);
    if (!branch) return null;
    const branchState = parsed?.branches?.[branch];
    if (!branchState || !Number.isSafeInteger(branchState.round) || branchState.round < 0 || !Array.isArray(branchState.dismissed)) return null;
    const lastReviewedSha = branchState.lastReviewedSha;
    const lastTriage = branchState.lastTriage;
    const triageSha = lastTriage?.sha;
    const triageOutcome = lastTriage?.outcome;
    const triage = Number.isSafeInteger(lastTriage?.round) && lastTriage.round >= 1
      && typeof triageSha === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(triageSha)
      && ['fixing', 'converged', 'halted'].includes(triageOutcome)
      ? { round: lastTriage.round, sha: triageSha.toLowerCase(), outcome: triageOutcome }
      : null;
    return {
      number: registration.number,
      branch,
      round: branchState.round,
      max: CROSS_REVIEW_MAX_ROUNDS,
      dismissed: branchState.dismissed.length,
      reviewedSha: typeof lastReviewedSha === 'string' && /^[0-9a-f]{40}$/i.test(lastReviewedSha)
        ? lastReviewedSha.toLowerCase()
        : null,
      triage,
    };
  } catch {
    return null;
  }
}

// 記録のある worktree を優先し、同じ優先度なら今の head で収束した記録、次に今の head をレビューした記録を選ぶ。
function shouldReplaceCrossReview(current, candidate, headSha) {
  const priority = (review) => review === undefined ? 0 : review === null ? 1 : 2;
  const currentPriority = priority(current);
  const candidatePriority = priority(candidate);
  if (candidatePriority !== currentPriority) return candidatePriority > currentPriority;
  if (!current || !candidate) return false;
  const head = String(headSha || '').toLowerCase();
  const convergedAtHead = (review) => review.triage?.outcome === 'converged' && review.triage.sha === head;
  if (convergedAtHead(current) !== convergedAtHead(candidate)) return convergedAtHead(candidate);
  return current.reviewedSha !== headSha;
}

function mergeablePullRequestCount(trees) {
  return trees.reduce((total, pullRequest) => total + Number(pullRequest.canMerge === true) + mergeablePullRequestCount(pullRequest.children || []), 0);
}

class PullRequestTracker {
  constructor(options = {}) {
    this.state = options.state;
    this.execFileImpl = options.execFileImpl || execFile;
    this.ghPath = options.ghPath || 'gh';
    this.fileSystem = options.fileSystem || fs;
    this.now = options.now || Date.now;
    this.repositories = new Map();
    this.inFlight = new Map();
    this.timer = null;
    this.onMerged = options.onMerged || null;
    this.onClosed = options.onClosed || null;
  }

  start() {
    if (this.timer) return;
    void this.refreshAll();
    this.timer = setInterval(() => { void this.refreshAll(); }, 60_000);
    this.timer.unref?.();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  refreshAll() {
    const repositories = new Map();
    for (const record of [...this.state.pullRequestRegistrations(), ...this.state.relatedPullRequestRegistrations()]) {
      const key = repoKey(record.owner, record.repo);
      repositories.set(key, { owner: record.owner, repo: record.repo });
    }
    return Promise.all([...repositories.values()].map(({ owner, repo }) => this.refreshRepo(owner, repo)));
  }

  refreshRepo(owner, repo) {
    const repository = safeRepo(owner, repo);
    const key = repoKey(owner, repo);
    if (this.inFlight.has(key)) return this.inFlight.get(key);
    const operation = this.fetchRepository(owner, repo, repository)
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, operation);
    return operation;
  }

  async refreshRepoFresh(owner, repo) {
    const key = repoKey(owner, repo);
    await this.inFlight.get(key)?.catch(() => {});
    return this.refreshRepo(owner, repo);
  }

  mergeCandidate(registration) {
    const key = repoKey(registration.owner, registration.repo);
    const repository = this.repositories.get(key);
    if (!repository) return null;
    const productKey = registration.product?.key || `repo:${key}`;
    const registrations = this.state.pullRequestRegistrationsForRepo(registration.owner, registration.repo)
      .filter((record) => (record.product?.key || `repo:${key}`) === productKey);
    const assembled = assemblePullRequestStacks({
      defaultBranch: repository.defaultBranch,
      openPullRequests: repository.openPullRequests,
      registrations,
      relatedPullRequests: this.state.relatedPullRequestRegistrationsForRepo(registration.owner, registration.repo),
      retargetedPrs: this.state.pullRequestRetargetsForRepo(registration.owner, registration.repo),
      restackResults: repository.restackResults,
    });
    const find = (items) => {
      for (const item of items) {
        if (item.number === registration.number) return item;
        const nested = find(item.children);
        if (nested) return nested;
      }
      return null;
    };
    return {
      registration,
      repository,
      registrations,
      pullRequest: find(assembled.trees),
    };
  }

  async execute(args) {
    return runGh(args, { execFileImpl: this.execFileImpl, ghPath: this.ghPath });
  }

  async readPullRequestView(owner, repo, number) {
    const output = await this.execute([
      'pr', 'view', String(number), '-R', safeRepo(owner, repo), '--json', `${PULL_REQUEST_FIELDS},state,mergedAt,autoMergeRequest`,
    ]);
    const value = JSON.parse(output);
    const state = String(value?.state || '').toUpperCase();
    const pullRequest = normalizeOpenPullRequest(value);
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(state) || !pullRequest) throw new Error('invalid PR view');
    return {
      state,
      pullRequest,
      mergedAt: typeof value.mergedAt === 'string' && Number.isFinite(Date.parse(value.mergedAt)) ? value.mergedAt : null,
      autoMergeEnabled: Boolean(value.autoMergeRequest),
    };
  }

  async fetchRepository(owner, repo, repository) {
    const key = repoKey(owner, repo);
    const checkedAt = new Date(this.now()).toISOString();
    const current = this.repositories.get(key) || {
      owner, repo, openPullRequests: [], defaultBranch: null, mergeMethods: [], autoDeleteBranch: false, fetchedAt: null, checkedAt: null,
    };
    const previousRegistrations = this.state.pullRequestRegistrationsForRepo(owner, repo);
    const previousRelated = this.state.relatedPullRequestRegistrationsForRepo(owner, repo);
    const [listResult, configResult] = await Promise.allSettled([
      this.execute(['pr', 'list', '-R', repository, '--state', 'open', '--limit', '500', '--json', PULL_REQUEST_FIELDS]),
      this.execute(['api', `repos/${repository}`]),
    ]);
    const errors = [];
    let openPullRequests = current.openPullRequests;
    let defaultBranch = current.defaultBranch;
    let mergeMethods = current.mergeMethods;
    let autoDeleteBranch = current.autoDeleteBranch;
    let fetchedAt = current.fetchedAt;
    let listAvailable = false;
    let mergedPullRequests = null;
    let mergedListComplete = false;

    if (listResult.status === 'fulfilled') {
      try {
        openPullRequests = parsePullRequestList(listResult.value);
        fetchedAt = checkedAt;
        listAvailable = true;
      } catch {
        errors.push('PR の一覧を読み取れませんでした');
      }
    } else {
      errors.push(`PR の一覧を取得できません。${ghErrorMessage(listResult.reason)}`);
    }

    if (configResult.status === 'fulfilled') {
      try {
        const config = parseRepositoryConfig(configResult.value);
        defaultBranch = config.defaultBranch;
        mergeMethods = config.mergeMethods;
        autoDeleteBranch = config.autoDeleteBranch;
      } catch {
        errors.push('リポジトリ設定を読み取れませんでした');
      }
    } else {
      errors.push(`リポジトリ設定を取得できません。${ghErrorMessage(configResult.reason)}`);
    }


    if (listAvailable) {
      const trackedByNumber = new Map();
      for (const record of [...previousRegistrations, ...previousRelated]) {
        let tracked = trackedByNumber.get(record.number);
        if (!tracked) {
          tracked = { registrations: [], related: null, record: null };
          trackedByNumber.set(record.number, tracked);
        }
        if (record.session_id) tracked.registrations.push(record);
        else tracked.related = record;
        tracked.record ||= record;
      }
      const openNumbers = new Set(openPullRequests.map((pr) => pr.number));
      const toInspect = [...trackedByNumber.entries()]
        .filter(([number, tracked]) => !openNumbers.has(number) && !['merged', 'closed'].includes(tracked.record.state));
      const viewFields = `${PULL_REQUEST_FIELDS},state,mergedAt`;
      const inspected = await Promise.all(toInspect.map(async ([number, tracked]) => {
        try {
          const output = await this.execute(['pr', 'view', String(number), '-R', repository, '--json', viewFields]);
          return { number, tracked, value: JSON.parse(output) };
        } catch (error) {
          return { number, tracked, error };
        }
      }));
      for (const result of inspected) {
        if (result.error) {
          errors.push(`#${result.number} の状態を確認できません。${ghErrorMessage(result.error)}`);
          continue;
        }
        const value = result.value;
        const state = String(value.state || '').toUpperCase();
        if (!['OPEN', 'CLOSED', 'MERGED'].includes(state)) {
          errors.push(`#${result.number} の状態を読み取れませんでした`);
          continue;
        }
        const closedState = state === 'MERGED' || (state === 'CLOSED' && value.mergedAt) ? 'merged' : state === 'CLOSED' ? 'closed' : 'open';
        if (closedState === 'open') {
          const normalized = normalizeOpenPullRequest(value);
          if (!normalized) {
            errors.push(`#${result.number} の状態を読み取れませんでした`);
            continue;
          }
          openPullRequests.push(normalized);
          openNumbers.add(normalized.number);
          continue;
        }
        for (const record of result.tracked.registrations) {
          this.state.updatePullRequest(record.session_id, owner, repo, result.number, {
            state: closedState,
            mergedAt: typeof value.mergedAt === 'string' ? value.mergedAt : null,
          });
        }
        if (result.tracked.related) {
          this.state.updateRelatedPullRequest(owner, repo, result.number, {
            state: closedState,
            mergedAt: typeof value.mergedAt === 'string' ? value.mergedAt : null,
          });
        }
        if (closedState === 'merged' && result.tracked.record.state !== 'merged') {
          const reservation = this.state.pullRequestMergeReservation(owner, repo, result.number);
          const mergeIntent = this.state.pullRequestMergeIntent(owner, repo, result.number);
          const pullRequest = normalizeOpenPullRequest(value);
          const openByNumber = new Map(openPullRequests.map((item) => [item.number, item]));
          const stackedPullRequests = new Map();
          for (const item of [...(reservation?.stackedPullRequests || []), ...(mergeIntent?.stackedPullRequests || [])]) {
            const child = openByNumber.get(item.number);
            if (child) stackedPullRequests.set(item.number, { ...item, headRefName: child.headRefName });
          }
          if (pullRequest) {
            for (const child of openPullRequests
              .filter((candidate) => candidate.baseRefName === pullRequest.headRefName)
              .map((candidate) => ({ number: candidate.number, baseRefName: pullRequest.headRefName }))) {
              stackedPullRequests.set(child.number, child);
            }
          }
          await this.onMerged?.({
            owner,
            repo,
            pullRequest,
            mergedAt: typeof value.mergedAt === 'string' ? value.mergedAt : new Date(this.now()).toISOString(),
            reservation,
            registrations: result.tracked.registrations,
            stackedPullRequests: [...stackedPullRequests.values()],
          });
        } else if (closedState === 'closed' && result.tracked.record.state !== 'closed') {
          const reservation = this.state.pullRequestMergeReservation(owner, repo, result.number);
          const mergeIntent = this.state.pullRequestMergeIntent(owner, repo, result.number);
          if (reservation || mergeIntent) await this.onClosed?.({ owner, repo, number: result.number, reservation, mergeIntent, registrations: result.tracked.registrations });
        }
      }
    }

    // gh pr view で補ったオープンの PR も含めるため、マージ済みの一覧は補った後に取る。
    if (listAvailable && !openPullRequests.length) {
      mergedPullRequests = [];
      mergedListComplete = true;
    } else if (listAvailable) {
      const since = mergedSearchSince(openPullRequests);
      try {
        mergedPullRequests = parseMergedPullRequestList(await this.execute([
          'pr', 'list', '-R', repository, '--state', 'merged', '--limit', String(MERGED_PULL_REQUEST_LIMIT),
          ...(since ? ['--search', `merged:>=${since}`] : []), '--json', 'number,headRefOid,mergedAt',
        ]));
        mergedListComplete = mergedPullRequests.length < MERGED_PULL_REQUEST_LIMIT;
      } catch (error) {
        errors.push(`マージ済み PR の一覧を取得できません。${ghErrorMessage(error)}`);
      }
    }

    const restackResults = new Map();
    const comparisons = listAvailable && defaultBranch
      ? await Promise.all(openPullRequests.map(async (pr) => {
        if (!SHA_PATTERN.test(pr.headRefOid || '')) return [pr.number, { checked: false, parent: null }];
        try {
          const output = await this.execute([
            'api',
            `repos/${repository}/compare/${encodeURIComponent(defaultBranch)}...${pr.headRefOid}`,
          ]);
          const commits = parseCompareResult(output);
          const result = mergedPullRequests ? restackResult(commits, mergedPullRequests, mergedListComplete) : { checked: false, parent: null };
          if (!result.checked && commits) return [pr.number, { checked: false, parent: null }];
          return [pr.number, result];
        } catch (error) {
          errors.push(`#${pr.number} の積み直し状態を確認できません。${ghErrorMessage(error)}`);
          return [pr.number, { checked: false, parent: null }];
        }
      }))
      : openPullRequests.map((pr) => [pr.number, { checked: false, parent: null }]);
    for (const [number, result] of comparisons) restackResults.set(number, result);

    // base を付け替えた子も親のプロダクトに数えるため、所属は積み直しの判定の後に、画面と同じ結果で集める。
    const registrations = this.state.pullRequestRegistrationsForRepo(owner, repo);
    const relatedPullRequests = this.state.relatedPullRequestRegistrationsForRepo(owner, repo);
    const trackedPullRequests = [...registrations, ...relatedPullRequests].map((record) => (
      record.session_id ? storedPullRequest(record) : storedRelatedPullRequest(record)
    )).filter(Boolean);

    if (listAvailable) {
      const registeredNumbers = new Set(registrations.map((record) => record.number));
      const productGroups = new Map();
      for (const registration of registrations) {
        const productKey = registration.product?.key || `repo:${key}`;
        let group = productGroups.get(productKey);
        if (!group) {
          group = { product: registration.product || { key: productKey, name: `${owner}/${repo}` }, registrations: [] };
          productGroups.set(productKey, group);
        }
        group.registrations.push(registration);
      }
      const groupAssemblies = [];
      const displayProductsByNumber = new Map();
      for (const group of productGroups.values()) {
        const assembled = assemblePullRequestStacks({
          defaultBranch,
          openPullRequests,
          registrations: group.registrations,
          relatedPullRequests,
          retargetedPrs: this.state.pullRequestRetargetsForRepo(owner, repo),
          restackResults,
        });
        groupAssemblies.push({ group, assembled });
        const visit = (pullRequest) => {
          let products = displayProductsByNumber.get(pullRequest.number);
          if (!products) {
            products = new Map();
            displayProductsByNumber.set(pullRequest.number, products);
          }
          products.set(group.product.key, group.product);
          for (const child of pullRequest.children) visit(child);
        };
        for (const pullRequest of assembled.trees) visit(pullRequest);
      }

      for (const pr of openPullRequests) {
        const lastOpen = lastOpenPullRequest(pr);
        const displayProducts = [...(displayProductsByNumber.get(pr.number)?.values() || [])];
        for (const record of registrations.filter((candidate) => candidate.number === pr.number)) {
          this.state.updatePullRequest(
            record.session_id, owner, repo, pr.number, { state: 'open', mergedAt: null, lastOpen }, this.now(), displayProducts,
          );
        }
        if (relatedPullRequests.some((record) => record.number === pr.number)) {
          this.state.updateRelatedPullRequest(
            owner, repo, pr.number, { state: 'open', mergedAt: null, lastOpen }, this.now(), displayProducts,
          );
        }
      }

      for (const { assembled } of groupAssemblies) {
        for (const pr of assembled.relatedOpen) {
          if (registeredNumbers.has(pr.number)) continue;
          const lastOpen = lastOpenPullRequest(pr);
          this.state.rememberRelatedPullRequest({ owner, repo, number: pr.number, url: pr.url, lastOpen }, this.now());
        }
      }
    }

    this.repositories.set(key, {
      owner,
      repo,
      openPullRequests,
      defaultBranch,
      mergeMethods,
      autoDeleteBranch,
      fetchedAt,
      checkedAt,
      error: errors.length ? [...new Set(errors)].join('。') : null,
      restackResults,
    });
    await this.refreshReviewGroups(owner, repo);
    this.state.touch();
    return this.repositories.get(key);
  }

  async refreshReviewGroups(owner, repo) {
    const key = repoKey(owner, repo);
    const repositoryState = this.repositories.get(key);
    if (!repositoryState) return;
    const registrations = this.state.pullRequestRegistrationsForRepo(owner, repo);
    const relatedPullRequests = this.state.relatedPullRequestRegistrationsForRepo(owner, repo);
    const productGroups = new Map();
    for (const registration of registrations) {
      const productKey = registration.product?.key || `repo:${key}`;
      let group = productGroups.get(productKey);
      if (!group) {
        group = { product: registration.product || { key: productKey, name: `${owner}/${repo}` }, registrations: [] };
        productGroups.set(productKey, group);
      }
      group.registrations.push(registration);
    }
    // worktree が分かるのは登録したセッションだけなので、登録の無い関連 PR には crossReview を付けない。
    const crossReviewByNumber = new Map();
    for (const registration of registrations) {
      const pullRequest = repositoryState.openPullRequests.find((candidate) => candidate.number === registration.number);
      if (!pullRequest) continue;
      const review = await readCrossReviewState(registration, pullRequest, this.fileSystem);
      const current = crossReviewByNumber.get(registration.number);
      if (crossReviewByNumber.has(registration.number) && !shouldReplaceCrossReview(current, review, pullRequest.headRefOid)) continue;
      crossReviewByNumber.set(registration.number, review && {
        round: review.round,
        max: review.max,
        dismissed: review.dismissed,
        reviewedSha: review.reviewedSha,
        triage: review.triage,
      });
    }
    for (const [productKey, group] of productGroups) {
      const assembled = assemblePullRequestStacks({
        defaultBranch: repositoryState.defaultBranch,
        openPullRequests: repositoryState.openPullRequests,
        registrations: group.registrations,
        relatedPullRequests,
        retargetedPrs: this.state.pullRequestRetargetsForRepo(owner, repo),
        restackResults: repositoryState.restackResults,
      });
      const trees = assembled.trees.map((tree) => attachCrossReviewState(
        attachMergeState(tree, group.registrations, owner, repo, this.state),
        crossReviewByNumber,
      ));
      const identity = `${productKey}\0${key}`;
      this.productViews ||= new Map();
      this.productViews.set(identity, {
        product: { ...group.product },
        owner,
        repo,
        defaultBranch: repositoryState.defaultBranch,
        mergeMethods: [...repositoryState.mergeMethods],
        autoDeleteBranch: repositoryState.autoDeleteBranch,
        checkedAt: repositoryState.checkedAt,
        fetchedAt: repositoryState.fetchedAt,
        error: repositoryState.error,
        registeredCount: group.registrations.length,
        openCount: assembled.openCount,
        mergeableCount: mergeablePullRequestCount(trees),
        trees,
        merged: assembled.merged,
        mergeHistory: this.state.mergedPullRequestHistoryForRepo(owner, repo, this.now()),
        reservations: this.state.pullRequestMergeReservationsForRepo(owner, repo),
        lastMethod: this.state.lastPullRequestMethod(owner, repo),
      });
    }
  }

  snapshot() {
    return [...(this.productViews || new Map()).values()].map((group) => {
      const trees = group.trees.map((tree) => attachMergeState(tree, [], group.owner, group.repo, this.state));
      return {
        ...group,
        product: { ...group.product },
        mergeMethods: [...group.mergeMethods],
        mergeableCount: mergeablePullRequestCount(trees),
        trees,
        merged: structuredClone(group.merged),
        mergeHistory: this.state.mergedPullRequestHistoryForRepo(group.owner, group.repo, this.now()),
        reservations: this.state.pullRequestMergeReservationsForRepo(group.owner, group.repo),
        lastMethod: this.state.lastPullRequestMethod(group.owner, group.repo),
      };
    });
  }
}

function attachMergeState(pullRequest, registrations, owner, repo, state) {
  const registration = registrations.find((record) => record.number === pullRequest.number);
  const conflictRegistrations = state.pullRequestRegistrationsForRepo(owner, repo)
    .filter((record) => record.number === pullRequest.number);
  const conflictRequest = state.pullRequestConflictRequest(owner, repo, pullRequest.number);
  const activeConflictRequest = conflictRequest?.headRefOid.toLowerCase() === pullRequest.headRefOid.toLowerCase()
    ? conflictRequest
    : null;
  const mergeIntent = state.pullRequestMergeIntent(owner, repo, pullRequest.number);
  return {
    ...pullRequest,
    canMerge: mergeIntent ? false : pullRequest.canMerge,
    mergeSessionId: registration?.session_id || pullRequest.mergeSessionId || null,
    mergeRecordKey: registration ? state.pullRequestRegistrationKey(registration) : pullRequest.mergeRecordKey || null,
    conflictRequestKey: conflictRegistrations.length ? state.pullRequestRegistrationKey(conflictRegistrations[0]) : null,
    conflictRequestTargets: conflictRegistrations.map((record) => ({
      sessionId: record.session_id,
      alive: !state.sessionHasEnded(record.session_id),
    })),
    ...(activeConflictRequest ? { conflictRequest: { requestedAt: activeConflictRequest.requestedAt } } : {}),
    reservation: state.pullRequestMergeReservation(owner, repo, pullRequest.number),
    mergeIntent,
    children: pullRequest.children.map((child) => attachMergeState(child, registrations, owner, repo, state)),
  };
}

function attachCrossReviewState(pullRequest, crossReviewByNumber) {
  const value = {
    ...pullRequest,
    children: pullRequest.children.map((child) => attachCrossReviewState(child, crossReviewByNumber)),
  };
  const crossReview = crossReviewByNumber.get(pullRequest.number);
  if (crossReview !== undefined) value.crossReview = crossReview;
  return value;
}

module.exports = {
  PullRequestTracker,
  assemblePullRequestStacks,
  ghEnvironment,
  ghErrorMessage,
  repoKey,
  safeRepo,
  normalizeOpenPullRequest,
  parsePullRequestList,
  parseRepositoryConfig,
  crossReviewToolExists,
  readCrossReviewState,
  runGh,
};
