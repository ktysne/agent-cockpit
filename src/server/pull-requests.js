'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { validRepositoryPart } = require('./pull-request-utils');

const PULL_REQUEST_FIELDS = 'number,title,url,headRefName,baseRefName,headRefOid,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup';
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

function parseRepositoryConfig(stdout) {
  const value = JSON.parse(stdout);
  if (!value || typeof value !== 'object' || typeof value.default_branch !== 'string' || !value.default_branch) {
    throw new Error('invalid repository settings');
  }
  return {
    defaultBranch: value.default_branch.slice(0, 500),
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

function mapByNumber(values) {
  return new Map(values.map((value) => [value.number, value]));
}

function mergeHeadFor(mergedHeadRecords, number) {
  return mergedHeadRecords.find((record) => record.number === number && SHA_PATTERN.test(record.headRefOid || '')) || null;
}

function comparisonKey(number, mergedNumber) {
  return `${number}:${mergedNumber}`;
}

function comparisonRequests(openPullRequests, registrations, mergedHeadRecords) {
  const historic = registrations.map(storedPullRequest).filter((pr) => pr && pr.state === 'merged');
  const requests = new Map();
  for (const pr of openPullRequests) {
    let base = pr.baseRefName;
    const seen = new Set();
    while (!seen.has(base)) {
      seen.add(base);
      const merged = historic.find((candidate) => candidate.headRefName && candidate.headRefName === base);
      if (!merged) break;
      const oldHead = mergeHeadFor(mergedHeadRecords, merged.number);
      if (oldHead && pr.headRefOid) {
        requests.set(comparisonKey(pr.number, merged.number), {
          number: pr.number,
          mergedNumber: merged.number,
          oldHeadSha: oldHead.headRefOid,
          headSha: pr.headRefOid,
        });
      }
      base = merged.baseRefName;
    }
  }
  return [...requests.values()];
}

function assemblePullRequestStacks({
  defaultBranch,
  openPullRequests = [],
  registrations = [],
  retargetedPrs = [],
  mergedHeadRecords = [],
  comparisonStatuses = new Map(),
}) {
  const open = [...openPullRequests].sort((left, right) => left.number - right.number);
  const openByNumber = mapByNumber(open);
  const historical = registrations
    .filter((record) => !openByNumber.has(record.number) && ['merged', 'closed'].includes(record.state))
    .map(storedPullRequest)
    .filter(Boolean)
    .map((pr) => ({ ...pr, method: mergeHeadFor(mergedHeadRecords, pr.number)?.method || null }));
  const nodes = [...open, ...historical];
  const nodeByNumber = mapByNumber(nodes);
  const effectiveByNumber = new Map();

  function effective(pr, visiting = new Set()) {
    if (effectiveByNumber.has(pr.number)) return effectiveByNumber.get(pr.number);
    if (visiting.has(pr.number)) return { base: pr.baseRefName, retargetedFrom: null, needsRestack: false, restackPr: null };
    const nextVisiting = new Set(visiting).add(pr.number);
    const explicit = retargetedPrs.find((record) => record.number === pr.number);
    let base = explicit?.base || pr.baseRefName;
    let retargetedFrom = explicit ? { number: explicit.fromNumber || null } : null;
    let needsRestack = false;
    let restackPr = null;
    while (base) {
      const merged = nodes.find((candidate) => candidate.state === 'merged' && candidate.headRefName === base && candidate.number !== pr.number);
      if (!merged || nextVisiting.has(merged.number)) break;
      const comparison = comparisonStatuses.get(comparisonKey(pr.number, merged.number));
      const oldHead = mergeHeadFor(mergedHeadRecords, merged.number);
      if (oldHead && ['ahead', 'identical'].includes(comparison)) {
        needsRestack = true;
        restackPr ||= merged;
      }
      const mergedEffective = effective(merged, nextVisiting);
      base = mergedEffective.base;
      needsRestack ||= mergedEffective.needsRestack;
      restackPr ||= mergedEffective.restackPr;
    }
    const result = { base: base || pr.baseRefName, retargetedFrom, needsRestack, restackPr };
    effectiveByNumber.set(pr.number, result);
    return result;
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
  const visibleOpenNumbers = new Set(visibleOpen.map((pr) => pr.number));
  const roots = visibleOpen.filter((pr) => !visibleOpenNumbers.has(parentByNumber.get(pr.number)));

  function blockerFor(pr) {
    const value = effective(pr);
    if (!defaultBranch) return 'リポジトリ設定を取得できません';
    const hasBasePullRequest = visibleOpen.some((candidate) => candidate.headRefName === value.base);
    if (value.base !== defaultBranch && !hasBasePullRequest) return `base の ${value.base} に対応する PR が見つからない`;
    const parent = visibleOpen.find((candidate) => candidate.number === parentByNumber.get(pr.number));
    if (parent) return `下の #${parent.number} のマージ待ち`;
    if (pr.draft) return 'ドラフト';
    if (value.needsRestack) {
      const method = value.restackPr?.method;
      const methodLabel = ['squash', 'rebase'].includes(method) ? `${method} で入った ` : '';
      return `積み直し待ち (${methodLabel}#${value.restackPr?.number || ''} のコミットが差分に残っている)`;
    }
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
      restackMethod: effectiveValue.restackPr?.method || null,
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
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
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

async function readCrossReviewState(registration, pullRequest, fileSystem = fs) {
  const branch = pullRequest?.headRefName;
  if (!branch || !registration.cwd) return null;
  const root = await findWorktreeRoot(registration.cwd, fileSystem);
  if (!root) return null;
  try {
    const parsed = JSON.parse(await fileSystem.readFile(path.join(root, '.cross-review-state.json'), 'utf8'));
    const branchState = parsed?.branches?.[branch];
    if (!branchState || !Number.isSafeInteger(branchState.round) || branchState.round < 0 || !Array.isArray(branchState.dismissed)) return null;
    return {
      number: registration.number,
      branch,
      round: branchState.round,
      max: CROSS_REVIEW_MAX_ROUNDS,
      dismissed: branchState.dismissed.length,
    };
  } catch {
    return null;
  }
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
    for (const record of this.state.pullRequestRegistrations()) {
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

  async execute(args) {
    return runGh(args, { execFileImpl: this.execFileImpl, ghPath: this.ghPath });
  }

  async fetchRepository(owner, repo, repository) {
    const key = repoKey(owner, repo);
    const checkedAt = new Date(this.now()).toISOString();
    const current = this.repositories.get(key) || {
      owner, repo, openPullRequests: [], defaultBranch: null, mergeMethods: [], fetchedAt: null, checkedAt: null,
    };
    const [listResult, configResult] = await Promise.allSettled([
      this.execute(['pr', 'list', '-R', repository, '--state', 'open', '--json', PULL_REQUEST_FIELDS]),
      this.execute(['api', `repos/${repository}`]),
    ]);
    const errors = [];
    let openPullRequests = current.openPullRequests;
    let defaultBranch = current.defaultBranch;
    let mergeMethods = current.mergeMethods;
    let fetchedAt = current.fetchedAt;

    if (listResult.status === 'fulfilled') {
      try {
        openPullRequests = parsePullRequestList(listResult.value);
        fetchedAt = checkedAt;
        const openByNumber = mapByNumber(openPullRequests);
        for (const record of this.state.pullRequestRegistrationsForRepo(owner, repo)) {
          const openPullRequest = openByNumber.get(record.number);
          if (openPullRequest) {
            this.state.updatePullRequest(record.session_id, owner, repo, record.number, {
              state: 'open',
              mergedAt: null,
              lastOpen: {
                title: openPullRequest.title,
                url: openPullRequest.url,
                headRefName: openPullRequest.headRefName,
                baseRefName: openPullRequest.baseRefName,
                headRefOid: openPullRequest.headRefOid,
                isDraft: openPullRequest.draft,
                mergeable: openPullRequest.mergeable,
                mergeStateStatus: openPullRequest.mergeStateStatus,
                reviewDecision: openPullRequest.reviewDecision,
                ci: openPullRequest.ci,
                review: openPullRequest.review,
                conflict: openPullRequest.conflict,
              },
            });
          }
        }
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
      } catch {
        errors.push('リポジトリ設定を読み取れませんでした');
      }
    } else {
      errors.push(`リポジトリ設定を取得できません。${ghErrorMessage(configResult.reason)}`);
    }

    if (listResult.status === 'fulfilled') {
      const openNumbers = new Set(openPullRequests.map((pr) => pr.number));
      const toInspect = this.state.pullRequestRegistrationsForRepo(owner, repo)
        .filter((record) => !openNumbers.has(record.number) && !['merged', 'closed'].includes(record.state));
      const inspected = await Promise.all(toInspect.map(async (record) => {
        try {
          const output = await this.execute(['pr', 'view', String(record.number), '-R', repository, '--json', 'state,mergedAt,mergeCommit,headRefOid']);
          return { record, value: JSON.parse(output) };
        } catch (error) {
          return { record, error };
        }
      }));
      for (const result of inspected) {
        if (result.error) {
          errors.push(`#${result.record.number} の状態を確認できません。${ghErrorMessage(result.error)}`);
          continue;
        }
        const value = result.value;
        const state = String(value.state || '').toUpperCase();
        if (!['OPEN', 'CLOSED', 'MERGED'].includes(state)) {
          errors.push(`#${result.record.number} の状態を読み取れませんでした`);
          continue;
        }
        const closedState = state === 'MERGED' || (state === 'CLOSED' && value.mergedAt) ? 'merged' : state === 'CLOSED' ? 'closed' : 'open';
        this.state.updatePullRequest(result.record.session_id, owner, repo, result.record.number, {
          state: closedState,
          mergedAt: typeof value.mergedAt === 'string' ? value.mergedAt : null,
        });
        if (closedState === 'merged') {
          const headRefOid = SHA_PATTERN.test(value.headRefOid || '')
            ? value.headRefOid
            : result.record.lastOpen?.headRefOid;
          if (headRefOid && SHA_PATTERN.test(headRefOid)) {
            this.state.recordMergedPullRequestHead({
              owner,
              repo,
              number: result.record.number,
              headRefOid,
              method: null,
              mergedAt: typeof value.mergedAt === 'string' ? value.mergedAt : checkedAt,
            });
          }
        }
      }
    }

    const registrations = this.state.pullRequestRegistrationsForRepo(owner, repo);
    const mergedHeads = this.state.mergedPullRequestHeadsForRepo(owner, repo);
    const comparisons = listResult.status === 'fulfilled'
      ? comparisonRequests(openPullRequests, registrations, mergedHeads)
      : [];
    const comparisonStatuses = new Map();
    for (const comparison of comparisons) {
      try {
        const output = await this.execute([
          'api',
          `repos/${repository}/compare/${comparison.oldHeadSha}...${comparison.headSha}`,
        ]);
        const value = JSON.parse(output);
        comparisonStatuses.set(comparisonKey(comparison.number, comparison.mergedNumber), String(value.status || '').toLowerCase());
      } catch (error) {
        errors.push(`#${comparison.number} の積み直し状態を確認できません。${ghErrorMessage(error)}`);
      }
    }

    this.repositories.set(key, {
      owner,
      repo,
      openPullRequests,
      defaultBranch,
      mergeMethods,
      fetchedAt,
      checkedAt,
      error: errors.length ? [...new Set(errors)].join('。') : null,
      comparisonStatuses,
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
    for (const [productKey, group] of productGroups) {
      const assembled = assemblePullRequestStacks({
        defaultBranch: repositoryState.defaultBranch,
        openPullRequests: repositoryState.openPullRequests,
        registrations: group.registrations,
        retargetedPrs: this.state.pullRequestRetargetsForRepo(owner, repo),
        mergedHeadRecords: this.state.mergedPullRequestHeadsForRepo(owner, repo),
        comparisonStatuses: repositoryState.comparisonStatuses,
      });
      const allRegistrations = registrations;
      const knownByNumber = new Map([
        ...repositoryState.openPullRequests.map((pr) => [pr.number, pr]),
        ...allRegistrations.map((registration) => [registration.number, storedPullRequest(registration)]),
      ]);
      const reviews = [];
      for (const registration of group.registrations) {
        const pullRequest = knownByNumber.get(registration.number);
        const review = await readCrossReviewState(registration, pullRequest, this.fileSystem);
        if (review) reviews.push(review);
      }
      const identity = `${productKey}\0${key}`;
      this.productViews ||= new Map();
      this.productViews.set(identity, {
        product: { ...group.product },
        owner,
        repo,
        defaultBranch: repositoryState.defaultBranch,
        mergeMethods: [...repositoryState.mergeMethods],
        checkedAt: repositoryState.checkedAt,
        fetchedAt: repositoryState.fetchedAt,
        error: repositoryState.error,
        registeredCount: group.registrations.length,
        openCount: assembled.openCount,
        mergeableCount: assembled.mergeableCount,
        trees: assembled.trees,
        merged: assembled.merged,
        reviews,
      });
    }
  }

  snapshot() {
    return [...(this.productViews || new Map()).values()].map((group) => ({
      ...group,
      product: { ...group.product },
      mergeMethods: [...group.mergeMethods],
      trees: structuredClone(group.trees),
      merged: structuredClone(group.merged),
      reviews: group.reviews.map((review) => ({ ...review })),
    }));
  }
}

module.exports = {
  PullRequestTracker,
  assemblePullRequestStacks,
  comparisonRequests,
  ghEnvironment,
  ghErrorMessage,
  normalizeOpenPullRequest,
  parsePullRequestList,
  parseRepositoryConfig,
  readCrossReviewState,
  runGh,
};
