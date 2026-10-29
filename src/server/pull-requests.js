'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { AsyncLocalStorage } = require('node:async_hooks');
const {
  isCompleteCommitSha,
  parseGitHubRepositoryRemote,
  parsePullRequestUrl,
  pullRequestKey,
  repositoryKey,
  staleHeadDescription,
  validBranchName,
  validRepositoryPart,
} = require('./pull-request-utils');
const { isGithubCredentialEnvironmentVariable } = require('./credential-environment');
const { findWorktreeRoot } = require('./git-worktree');
const { DISPLAY_SCHEMA } = require('./display-preferences');
const { parseCrossReviewState } = require('./cross-review-state');
const { evaluateReview, reviewPresentation, reviewReminderNeeded } = require('../shared/review-evaluation');

const GH_TIMEOUT_MS = 20_000;
const PULL_REQUEST_FIELDS = 'number,title,url,headRefName,baseRefName,headRefOid,isCrossRepository,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,createdAt';
const MERGED_PULL_REQUEST_LIMIT = 1000;
const MERGE_TARGET_HEAD_CHECK_LIMIT = 20;
const STACK_MERGE_LIMIT = 20;
const DAY_MS = 24 * 60 * 60 * 1000;
const CROSS_REVIEW_MAX_ROUNDS = 3;
const EMPTY_GIT_OBJECT_ID = '0000000000000000000000000000000000000000';
const HEAD_TOOL_RESULT_LIMIT = 1024;
const MAX_AFTER_CONVERGENCE_MERGES = 50;
const MAX_MERGED_BASE_HEADS = 20;
const MISSING_CWD_RECHECK_MS = 10 * 60 * 1000;
const REPOSITORY_NODE_ID_QUERY = `query($owner: String!, $repository: String!) {
  repository(owner: $owner, name: $repository) {
    id
  }
}`;
const DELETE_BRANCH_REF_MUTATION = `mutation($repositoryId: ID!, $refName: GitRefname!, $beforeOid: GitObjectID!, $afterOid: GitObjectID!) {
  updateRefs(input: {
    repositoryId: $repositoryId,
    refUpdates: [{
      name: $refName,
      beforeOid: $beforeOid,
      afterOid: $afterOid,
      force: false
    }]
  }) {
    clientMutationId
  }
}`;
const INACTIVE_REPOSITORY_REFRESH_INTERVAL_MS = 15 * 60 * 1000;
const USER_REFRESH_MIN_INTERVAL_MS = 10_000;
// コマンドの後の取り直しも間引かないと、gh pr のたびに全リポジトリを一斉に取るため、修正前の定期取得と同じ間隔までは間引く。
const COMMAND_REFRESH_INACTIVE_INTERVAL_MS = 60_000;
// 対象のリポジトリが決まらないコマンドの全体の取り直しは、この間隔に 1 回へまとめ、間に来た分は間隔の明けに 1 回取る。
const COMMAND_REFRESH_COALESCE_MS = 5000;
const UNKNOWN_MERGEABLE_REFRESH_MS = 5_000;
// GitHub が計算中を返し続けても gh を呼び続けないよう、早めの取り直しは連続でこの回数までにする。
const UNKNOWN_MERGEABLE_REFRESH_LIMIT = 3;
const STACK_UNKNOWN_REFRESH_LIMIT = 60;
const STACK_UNKNOWN_REFRESH_MS = 10_000;
// 開発者が確定した操作の確かめ直しの中で呼ぶ gh を、定期取得より先に実行するための印。
const ghPriorityContext = new AsyncLocalStorage();

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
    headRefOid: isCompleteCommitSha(value.headRefOid) ? value.headRefOid : '',
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

function confirmedMergedHead(value) {
  if (!isCompleteCommitSha(value?.headRefOid) || !validBranchName(value?.headRefName) ||
    !validBranchName(value?.baseRefName)) return null;
  return {
    headRefOid: value.headRefOid.toLowerCase(),
    headRefName: value.headRefName,
    baseRefName: value.baseRefName,
    ...(typeof value.branchKept === 'boolean' ? { branchKept: value.branchKept } : {}),
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
  const mergedHead = registration.state === 'merged' ? confirmedMergedHead(registration.mergedHead) : null;
  if (!Number.isSafeInteger(registration.number) || registration.number < 1) return null;
  if (!known.headRefName && !known.baseRefName && !known.title && !mergedHead) return null;
  return {
    number: registration.number,
    title: asText(known.title, 500),
    url: asText(known.url || registration.url, 2000),
    headRefName: mergedHead?.headRefName || asText(known.headRefName, 500),
    baseRefName: mergedHead?.baseRefName || asText(known.baseRefName, 500),
    headRefOid: mergedHead?.headRefOid || (isCompleteCommitSha(known.headRefOid) ? known.headRefOid : ''),
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
    mergedHead: record.mergedHead,
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
    if (!Number.isSafeInteger(number) || number < 1 || !isCompleteCommitSha(headRefOid) ||
      typeof mergedAt !== 'string' || !Number.isFinite(Date.parse(mergedAt))) {
      throw new Error('invalid merged PR');
    }
    return {
      number,
      headRefOid: headRefOid.toLowerCase(),
      headRefName: asText(value?.headRefName),
      baseRefName: asText(value?.baseRefName),
      mergedAt,
    };
  }).sort((left, right) => Date.parse(left.mergedAt) - Date.parse(right.mergedAt) || left.number - right.number);
}

function parseCompareResult(stdout) {
  const value = JSON.parse(stdout);
  if (!value || typeof value !== 'object' || !Number.isSafeInteger(value.ahead_by) || value.ahead_by < 0 ||
    !Array.isArray(value.commits) || !value.commits.every((commit) => isCompleteCommitSha(commit?.sha))) {
    throw new Error('invalid compare result');
  }
  if (value.commits.length < value.ahead_by) return null;
  return new Set(value.commits.map((commit) => commit.sha.toLowerCase()));
}

function mergedBaseReachesComparison(
  branch,
  mergedAt,
  mergedPullRequests,
  comparisonBranches,
  defaultBranch,
  visitedPrs = new Set(),
  memo = new Map(),
) {
  if (comparisonBranches.has(branch)) return 'matched';
  if (branch === defaultBranch) return 'none';
  const key = `${branch}\0${Date.parse(mergedAt)}`;
  if (memo.has(key)) return memo.get(key);
  const mergeTime = Date.parse(mergedAt);
  const sameTimeHead = mergedPullRequests.some((candidate) => (
    candidate.headRefName === branch && Date.parse(candidate.mergedAt) === mergeTime
  ));
  if (sameTimeHead) {
    memo.set(key, 'unknown');
    return 'unknown';
  }

  const successors = mergedPullRequests.filter((candidate) => (
    candidate.headRefName === branch && Date.parse(candidate.mergedAt) > mergeTime
  ));
  if (!successors.length) return 'none';

  const outcomes = [];
  for (const successor of successors) {
    if (visitedPrs.has(successor.number) || !successor.baseRefName) {
      outcomes.push('unknown');
      continue;
    }
    const nextVisited = new Set(visitedPrs).add(successor.number);
    outcomes.push(mergedBaseReachesComparison(
      successor.baseRefName,
      successor.mergedAt,
      mergedPullRequests,
      comparisonBranches,
      defaultBranch,
      nextVisited,
      memo,
    ));
  }

  const matchedCount = outcomes.filter((outcome) => outcome === 'matched').length;
  const result = matchedCount > 1 || outcomes.includes('unknown')
    ? 'unknown'
    : matchedCount === 1 ? 'matched' : 'none';
  memo.set(key, result);
  return result;
}

function restackResult(commits, mergedPullRequests, comparisonBranches, defaultBranch, mergedListComplete = true) {
  if (!commits) return { checked: false, parent: null };
  const candidates = mergedPullRequests.filter((candidate) => commits.has(candidate.headRefOid));
  const directParents = candidates.filter((candidate) => (
    !candidate.baseRefName || comparisonBranches.has(candidate.baseRefName)
  ));
  if (!mergedListComplete) {
    return directParents.length ? { checked: true, parent: directParents[0] } : { checked: false, parent: null };
  }

  const parentCandidates = [...directParents];
  const lineageMemo = new Map();
  for (const candidate of candidates) {
    if (directParents.includes(candidate) || !candidate.baseRefName) continue;
    const lineage = mergedBaseReachesComparison(
      candidate.baseRefName,
      candidate.mergedAt,
      mergedPullRequests,
      comparisonBranches,
      defaultBranch,
      new Set([candidate.number]),
      lineageMemo,
    );
    if (lineage === 'unknown') return { checked: false, parent: null };
    if (lineage === 'matched') parentCandidates.push(candidate);
  }
  parentCandidates.sort((left, right) => Date.parse(left.mergedAt) - Date.parse(right.mergedAt) || left.number - right.number);
  return { checked: true, parent: parentCandidates[0] || null };
}

function historicalMergedPullRequests(registrations, relatedPullRequests, openPullRequests) {
  const openNumbers = new Set(openPullRequests.map((pr) => pr.number));
  const byNumber = new Map();
  for (const record of [...registrations, ...relatedPullRequests]) {
    if (record.state !== 'merged' || openNumbers.has(record.number)) continue;
    const pullRequest = record.session_id ? storedPullRequest(record) : storedRelatedPullRequest(record);
    const mergedHead = confirmedMergedHead(record.mergedHead);
    if (!pullRequest || !mergedHead || !Number.isFinite(Date.parse(pullRequest.mergedAt || ''))) continue;
    const previous = byNumber.get(pullRequest.number);
    if (!previous || Date.parse(pullRequest.mergedAt) > Date.parse(previous.mergedAt)) {
      byNumber.set(pullRequest.number, {
        number: pullRequest.number,
        ...mergedHead,
        mergedAt: pullRequest.mergedAt,
      });
    }
  }
  return [...byNumber.values()].sort((left, right) => Date.parse(left.mergedAt) - Date.parse(right.mergedAt) || left.number - right.number);
}

function mergedPullRequestCandidates(mergedPullRequests, historicalPullRequests) {
  const byNumber = new Map(historicalPullRequests.map((pullRequest) => [pullRequest.number, pullRequest]));
  for (const pullRequest of mergedPullRequests || []) {
    const historical = byNumber.get(pullRequest.number);
    byNumber.set(pullRequest.number, { ...pullRequest, ...(historical?.branchKept === true ? { branchKept: true } : {}) });
  }
  return [...byNumber.values()].sort((left, right) => Date.parse(left.mergedAt) - Date.parse(right.mergedAt) || left.number - right.number);
}

async function restackCompareBase(pr, openPullRequests, mergedPullRequests, defaultBranch, readBranchHead, liveMergedBranches) {
  let compareBase = asText(pr.baseRefName);
  const comparisonBranches = new Set(compareBase ? [compareBase] : []);
  const visitedBranches = new Set();
  while (compareBase && compareBase !== defaultBranch && !visitedBranches.has(compareBase)) {
    visitedBranches.add(compareBase);
    const openParent = openPullRequests.find((candidate) => (
      candidate.number !== pr.number && candidate.headRefName === compareBase
    ));
    if (openParent) {
      compareBase = asText(openParent.baseRefName);
      if (compareBase) comparisonBranches.add(compareBase);
      continue;
    }
    if (openPullRequests.some((candidate) => candidate.headRefName === compareBase)) break;
    // 同じ head ブランチ名が再利用されることがあるので、マージ済みの親は最も新しいマージを採る。
    const mergedParent = mergedPullRequests.findLast((candidate) => candidate.headRefName === compareBase);
    if (!mergedParent) break;
    const currentHead = await readBranchHead(compareBase);
    // 残す選択をしたブランチは、同じ head でも引き続き base として使う。
    if (currentHead && (mergedParent.branchKept === true || currentHead !== mergedParent.headRefOid)) {
      liveMergedBranches.add(compareBase);
      break;
    }
    compareBase = asText(mergedParent.baseRefName);
    if (compareBase) comparisonBranches.add(compareBase);
  }
  compareBase = compareBase || defaultBranch;
  if (compareBase) comparisonBranches.add(compareBase);
  return { compareBase, comparisonBranches };
}

async function evaluateRestack({ openPullRequests, mergedCandidates, mergedListComplete, defaultBranch, listAvailable, readBranchHead, compare, onError }) {
  const restackResults = new Map();
  const liveMergedBranches = new Set();
  if (!(listAvailable && defaultBranch)) {
    for (const pr of openPullRequests) restackResults.set(pr.number, { checked: false, parent: null });
    return { restackResults, liveMergedBranches };
  }
  const comparisons = await Promise.all(openPullRequests.map(async (pr) => {
    if (!isCompleteCommitSha(pr.headRefOid)) return [pr.number, { checked: false, parent: null }];
    try {
      const { compareBase, comparisonBranches } = await restackCompareBase(
        pr, openPullRequests, mergedCandidates, defaultBranch, readBranchHead, liveMergedBranches,
      );
      const commits = await compare(compareBase, pr.headRefOid);
      const result = restackResult(commits, mergedCandidates, comparisonBranches, defaultBranch, mergedListComplete);
      if (!result.checked && commits) return [pr.number, { checked: false, parent: null }];
      return [pr.number, result];
    } catch (error) {
      onError(`#${pr.number} の積み直し状態を確認できません。${ghErrorMessage(error)}`);
      return [pr.number, { checked: false, parent: null }];
    }
  }));
  for (const [number, result] of comparisons) restackResults.set(number, result);
  return { restackResults, liveMergedBranches };
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
  liveMergedBranches = new Set(),
  listAvailable = false,
  mergedPullRequests = null,
  mergedCandidates = [],
  mergeTargetHeadChecks = new Map(),
  uninspectedNumbers = new Set(),
  mergeMethods = [],
  knownRegistrations = registrations,
}) {
  const open = openPullRequests.map((pr) => ({ ...pr })).sort((left, right) => left.number - right.number);
  const openByNumber = mapByNumber(open);
  const historical = [...registrations, ...relatedPullRequests]
    .filter((record) => !openByNumber.has(record.number) && ['merged', 'closed'].includes(record.state))
    .map((record) => {
      const pullRequest = record.session_id ? storedPullRequest(record) : storedRelatedPullRequest(record);
      const mergedHead = record.state === 'merged' ? confirmedMergedHead(record.mergedHead) : null;
      return pullRequest && mergedHead ? { ...pullRequest, ...mergedHead } : pullRequest;
    })
    .filter(Boolean);
  const nodes = [...open, ...historical];
  const nodeByNumber = mapByNumber(nodes);

  const known = [...nodes, ...mergedCandidates, ...knownRegistrations.map(storedPullRequest).filter(Boolean)];
  const knownHeads = new Set(known.map((pr) => pr.headRefName));
  const absenceConfirmed = listAvailable && openPullRequests.length < 500 &&
    uninspectedNumbers.size === 0;
  const mergeTargetFor = (base) => base === defaultBranch ? base
    : absenceConfirmed && !knownHeads.has(base) && mergeTargetHeadChecks.get(base) === true ? base : null;

  function parentMergeConfirmed(number) {
    if (!listAvailable || openByNumber.has(number) || uninspectedNumbers.has(number)) return false;
    return mergedCandidates.some((candidate) => candidate.number === number &&
      isCompleteCommitSha(candidate.headRefOid) && validBranchName(candidate.headRefName) &&
      validBranchName(candidate.baseRefName) && Number.isFinite(Date.parse(candidate.mergedAt || '')));
  }

  function effective(pr) {
    const explicit = retargetedPrs.find((record) => record.number === pr.number);
    const completedRetarget = explicit?.completed === false ? null : explicit;
    const check = restackResults.get(pr.number) || { checked: false, parent: null };
    const parentNumber = Number.isSafeInteger(explicit?.fromNumber) && explicit.fromNumber > 0
      ? explicit.fromNumber : null;
    let base = completedRetarget?.base || pr.baseRefName;
    const seen = new Set([pr.number]);
    while (base) {
      if (base === defaultBranch || liveMergedBranches.has(base)) break;
      const merged = historical.find((candidate) => candidate.state === 'merged' &&
        candidate.headRefName === base && isCompleteCommitSha(candidate.headRefOid) && candidate.baseRefName &&
        candidate.number !== pr.number);
      if (!merged || seen.has(merged.number)) break;
      seen.add(merged.number);
      base = merged.baseRefName;
    }
    return {
      base: base || pr.baseRefName,
      retargetedFrom: completedRetarget ? { number: completedRetarget.fromNumber || null } : null,
      parentMergePending: parentNumber && !parentMergeConfirmed(parentNumber) ? parentNumber : null,
      needsRestack: Boolean(check.parent),
      restackCheckUnknown: check.checked !== true,
      restackPr: check.parent,
    };
  }

  const parentByNumber = new Map();
  for (const pr of open) {
    const base = effective(pr).base;
    const parent = open.find((candidate) => candidate.number !== pr.number && candidate.headRefName !== defaultBranch && candidate.headRefName === base);
    if (parent) parentByNumber.set(pr.number, parent.number);
  }

  const childrenByNumber = new Map(open.map((pr) => [pr.number, []]));
  for (const [child, parent] of parentByNumber) childrenByNumber.get(parent)?.push(child);
  for (const children of childrenByNumber.values()) children.sort((left, right) => left - right);

  const edges = new Map(nodes.map((pr) => [pr.number, new Set()]));
  for (const parent of nodes) {
    if (parent.headRefName === defaultBranch) continue;
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
    if (!parent || !nodeByNumber.has(child) || !nodeByNumber.has(parent) ||
      nodeByNumber.get(parent).headRefName === defaultBranch) continue;
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

  function blockerFor(pr, includeCi = true) {
    const value = effective(pr);
    if (value.parentMergePending) return { code: 'parentMergePending', message: `親 PR #${value.parentMergePending} のマージ確認待ち` };
    if (pr.staleHead) return { code: 'staleHead', message: staleHeadDescription(pr.staleHead) };
    if (!defaultBranch) return { code: 'repositoryUnavailable', message: 'リポジトリ設定を取得できません' };
    const parent = open.find((candidate) => candidate.number === parentByNumber.get(pr.number));
    if (parent) return { code: 'parentOpen', message: `下の #${parent.number} のマージ待ち` };
    const mergeTarget = mergeTargetFor(value.base);
    if (!mergeTarget) {
      const mergedBase = known.some((candidate) => candidate.headRefName === value.base &&
        (candidate.state === 'merged' || mergedCandidates.includes(candidate)));
      if (mergedBase) return { code: 'mergedBase', message: `base の ${value.base} はマージ済みの PR の head のため、ダッシュボードではマージしない` };
      if (mergeTargetHeadChecks.get(value.base) === false) return { code: 'baseIsHead', message: `base の ${value.base} は PR の head のため、ダッシュボードではマージしない` };
      if (knownHeads.has(value.base)) return { code: 'missingParent', message: `base の ${value.base} に対応する PR が見つからない` };
      return { code: 'targetUnknown', message: `base の ${value.base} がどの PR の head でもないことを確認できない` };
    }
    if (pr.baseRefName !== value.base) return { code: 'retargetRequired', message: `base を ${value.base} に付け替える必要がある` };
    if (mergeTarget !== defaultBranch && !mergeMethods.includes('merge')) return { code: 'methodUnavailable', message: 'マージコミットが必要だが、このリポジトリでは許可されていない' };
    if (pr.draft) return { code: 'draft', message: 'ドラフト' };
    if (value.needsRestack) {
      return { code: 'needsRestack', message: `積み直し待ち (#${value.restackPr.number} が ${mergeTarget} に入った後も、そのコミットが差分に残っている)` };
    }
    if (value.restackCheckUnknown) return { code: 'restackCheckUnknown', message: '積み直しが必要か確かめられない' };
    if (pr.mergeable === 'UNKNOWN') return { code: 'mergeableUnknown', message: 'GitHub がマージできるかを計算中' };
    if (pr.conflict) return { code: 'conflict', message: 'コンフリクトあり' };
    if (includeCi && pr.ci === 'fail') return { code: 'ciFail', message: 'CI が失敗' };
    if (includeCi && pr.ci === 'pending') return { code: 'ciPending', message: 'CI 実行中' };
    if (pr.review === 'changes') return { code: 'reviewChanges', message: '変更を求められている' };
    if (pr.review === 'required') return { code: 'reviewRequired', message: 'レビューの承認待ち' };
    return null;
  }

  function treeFor(root, depth, rootHeight, ancestors = new Set()) {
    if (ancestors.has(root.number)) return null;
    const nextAncestors = new Set(ancestors).add(root.number);
    const effectiveValue = effective(root);
    const blocker = blockerFor(root);
    const operationBlocker = blockerFor(root, false);
    const children = (childrenByNumber.get(root.number) || [])
      .filter((number) => visibleOpenNumbers.has(number))
      .map((number) => nodeByNumber.get(number))
      .map((child) => treeFor(child, depth + 1, rootHeight, nextAncestors))
      .filter(Boolean);
    return {
      ...root,
      effectiveBase: effectiveValue.base,
      mergeTarget: mergeTargetFor(effectiveValue.base),
      mergeMethodFixed: mergeTargetFor(effectiveValue.base) && effectiveValue.base !== defaultBranch ? 'merge' : null,
      retargetedFrom: effectiveValue.retargetedFrom?.number || null,
      needsRestack: effectiveValue.needsRestack,
      restackPr: effectiveValue.restackPr?.number || null,
      restackCheckUnknown: effectiveValue.restackCheckUnknown,
      parentNumber: parentByNumber.get(root.number) || null,
      stackPosition: { depth, total: rootHeight },
      blocker: blocker?.message || null,
      blockerCode: blocker?.code || null,
      operationBlocker: operationBlocker?.message || null,
      operationBlockerCode: operationBlocker?.code || null,
      canMerge: blockerFor(root, false) === null,
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
      mergeableCount: visibleOpen.filter((pr) => blockerFor(pr, false) === null).length,
      relatedOpen: visibleOpen.filter((pr) => !registeredNumbers.has(pr.number)),
      merged: visibleClosed,
    orphanedOpenNumbers: visibleOpen.filter((pr) => blockerFor(pr) && ['mergedBase', 'baseIsHead', 'missingParent', 'targetUnknown'].includes(blockerFor(pr).code)).map((pr) => pr.number),
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
      timeout: options.timeoutMs || GH_TIMEOUT_MS,
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

function ghFailureKind(error) {
  if (error?.killed || error?.signal || error?.code === 'ETIMEDOUT') return 'unconfirmed';
  if (typeof error?.code === 'number') return 'exit';
  if (error?.syscall?.startsWith('spawn')) return 'spawn';
  return 'unconfirmed';
}

function ghErrorMessage(error) {
  if (error?.code === 'ENOENT') return 'gh コマンドが見つかりません';
  if (error?.code === 'ETIMEDOUT' || error?.killed) return 'gh の取得がタイムアウトしました';
  if (error?.code === 'EPERM' || error?.code === 'EACCES') return 'gh を実行できません';
  return 'gh の認証、通信、または取得結果を確認してください';
}

function isGitHubNotFoundError(error) {
  const text = [error?.message, error?.stderr].filter((value) => typeof value === 'string').join('\n');
  return /(?:http\s+404|\b404 not found\b)/i.test(text);
}

function ghEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !isGithubCredentialEnvironmentVariable(key)));
}

function safeRepo(owner, repo) {
  if (!validRepositoryPart(owner) || !validRepositoryPart(repo)) throw new Error('invalid repository');
  return `${owner}/${repo}`;
}

const repoKey = repositoryKey;

async function crossReviewToolExists(cwd, fileSystem = fs, missingCwdResults = null, now = Date.now()) {
  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return false;
  let missingCwd = false;
  try {
    await fileSystem.stat(cwd);
  } catch (error) {
    missingCwd = ['ENOENT', 'ENOTDIR'].includes(error.code);
  }
  const cached = missingCwd && missingCwdResults?.get(cwd);
  if (cached && now - cached.checkedAt < MISSING_CWD_RECHECK_MS) return cached.exists;
  const { root } = await findWorktreeRoot(cwd, fileSystem);
  let exists = false;
  if (root) {
    try {
      await fileSystem.stat(path.join(root, 'tools', 'cross-review.js'));
      exists = true;
    } catch {}
  }
  if (missingCwd) missingCwdResults?.set(cwd, { exists, checkedAt: now });
  return exists;
}

async function detectCrossReviewTool(cwd, fileSystem = fs) {
  if (typeof cwd !== 'string' || !cwd || !path.isAbsolute(cwd)) return { status: 'unknown' };
  try {
    const cwdStat = await fileSystem.stat(cwd);
    if (!cwdStat.isDirectory()) return { status: 'unknown' };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) {
      const { root } = await findWorktreeRoot(cwd, fileSystem);
      return root ? { status: 'missing', root } : { status: 'unknown' };
    }
    return { status: 'unknown' };
  }

  const worktree = await findWorktreeRoot(cwd, fileSystem);
  if (!worktree.root) return { status: 'unknown', reason: worktree.reason };
  const current = worktree.root;

  try {
    await fileSystem.stat(path.join(current, 'tools', 'cross-review.js'));
    return { status: 'present', root: current };
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return { status: 'absent', root: current };
    return { status: 'unknown' };
  }
}

function crossReviewReadOptions(options) {
  const isFileSystem = options && typeof options.stat === 'function' && typeof options.readFile === 'function';
  return {
    fileSystem: isFileSystem ? options : options?.fileSystem || fs,
    execFileImpl: options?.execFileImpl || execFile,
    remoteRepositoryCache: options?.remoteRepositoryCache,
    headToolCache: options?.headToolCache,
    baseAncestorCache: options?.baseAncestorCache,
    mergedCandidates: options?.mergedCandidates,
  };
}

function readGitRemoteUrls(root, execFileImpl) {
  return new Promise((resolve) => {
    try {
      execFileImpl('git', ['-C', root, 'config', '--get-regexp', '^remote\\..*\\.url$'], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
      }, (error, stdout) => resolve(error || typeof stdout !== 'string' ? '' : stdout));
    } catch {
      resolve('');
    }
  });
}

// 各行は「remote.<名前>.url <URL>」の形。GitHub のリポジトリと判定できた remote だけが owner と repo を持つ。
function gitRemotes(stdout) {
  const remotes = [];
  for (const line of stdout.split(/\r?\n/)) {
    const separator = line.indexOf(' ');
    if (separator < 0) continue;
    const key = line.slice(0, separator);
    remotes.push({ name: key.slice('remote.'.length, key.lastIndexOf('.url')), ...parseGitHubRepositoryRemote(line.slice(separator + 1)) });
  }
  return remotes;
}

async function gitRemotesOf(root, execFileImpl, cache) {
  const cacheKey = process.platform === 'win32' ? root.toLowerCase() : root;
  if (cache?.has(cacheKey)) return cache.get(cacheKey);
  const remotes = gitRemotes(await readGitRemoteUrls(root, execFileImpl));
  cache?.set(cacheKey, remotes);
  return remotes;
}

function sameGitHubRepository(left, right) {
  return left.owner.toLowerCase() === right.owner.toLowerCase() && left.repo.toLowerCase() === right.repo.toLowerCase();
}

async function matchingRepositoryCheckout(cwd, repository, options = {}) {
  if (typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const fileSystem = options.fileSystem || fs;
  try {
    if (!(await fileSystem.stat(cwd)).isDirectory()) return null;
  } catch { return null; }
  const { root } = await findWorktreeRoot(cwd, fileSystem);
  if (!root) return null;
  const remotes = await gitRemotesOf(root, options.execFileImpl || execFile, options.remoteRepositoryCache);
  return remotes.some(remote => remote.owner && sameGitHubRepository(remote, repository)) ? root : null;
}

function crossReviewToolAt(root, treeish, execFileImpl) {
  return new Promise((resolve) => {
    try {
      execFileImpl('git', ['-C', root, 'ls-tree', '--full-tree', treeish, '--', 'tools/cross-review.js'], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
      }, (error, stdout) => {
        if (error || typeof stdout !== 'string') return resolve('unknown');
        if (stdout === '') return resolve('absent');
        resolve(/^[0-7]{6} blob (?:[a-f0-9]{40}|[a-f0-9]{64})\ttools\/cross-review\.js\r?\n?(?![\s\S])/i.test(stdout) ? 'present' : 'unknown');
      });
    } catch {
      resolve('unknown');
    }
  });
}

// 道具の有無はコミットの木で決まるので、確かめられた結果は SHA で引き、取得をまたいで使う。
// 確かめられない結果は、worktree にコミットが届いていないなど一時的なことがあるので、1 回の取得の間だけ使う。
async function crossReviewToolAtHead(root, headSha, execFileImpl, cache) {
  if (!isCompleteCommitSha(headSha)) return 'unknown';
  const sha = headSha.toLowerCase();
  const unknownKey = JSON.stringify([process.platform === 'win32' ? root.toLowerCase() : root, sha]);
  if (cache?.known.has(sha)) return cache.known.get(sha);
  if (cache?.unknown.has(unknownKey)) return 'unknown';
  const result = await crossReviewToolAt(root, sha, execFileImpl);
  if (result === 'unknown') cache?.unknown.add(unknownKey);
  else if (cache) {
    if (cache.known.size >= HEAD_TOOL_RESULT_LIMIT) cache.known.clear();
    cache.known.set(sha, result);
  }
  return result;
}

// ローカルの base は PR のリポジトリと内容が違うことがあるので、remote の追跡ブランチだけを見る。
// 渡した remote のどれかに道具があれば道具を使うリポジトリとし、古い追跡ブランチで「不要」にしない。
async function crossReviewToolAtBase(root, baseRefName, remoteNames, execFileImpl) {
  if (!validBranchName(baseRefName)) return 'unknown';
  let result = 'unknown';
  for (const name of remoteNames.filter(validBranchName)) {
    const tool = await crossReviewToolAt(root, `refs/remotes/${name}/${baseRefName}`, execFileImpl);
    if (tool === 'present') return 'present';
    if (tool === 'absent') result = 'absent';
  }
  return result;
}

function runReviewGit(root, args, execFileImpl) {
  return new Promise((resolve, reject) => {
    execFileImpl('git', ['-C', root, ...args], {
      encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

// base へマージ済みと GitHub が返した PR の head は、その base に入っている。追跡ブランチは fetch まで古いので、その補いに使う。
function mergeCommitCandidates(mergedCandidates, mergedHeads) {
  const known = new Set(mergedHeads || []);
  return (mergedCandidates || []).filter((candidate) => isCompleteCommitSha(candidate?.headRefOid)
    && known.has(`${candidate.number}:${candidate.headRefOid.toLowerCase()}`));
}

function mergedHeadsOfBase(mergedCandidates, base) {
  if (!Array.isArray(mergedCandidates) || !validBranchName(base)) return [];
  const heads = new Set();
  const newestFirst = mergedCandidates.filter(candidate => candidate?.baseRefName === base && isCompleteCommitSha(candidate.headRefOid))
    .sort((left, right) => Date.parse(right.mergedAt) - Date.parse(left.mergedAt) || right.number - left.number);
  for (const candidate of newestFirst) {
    heads.add(candidate.headRefOid.toLowerCase());
    if (heads.size >= MAX_MERGED_BASE_HEADS) break;
  }
  return [...heads];
}

async function classifyAfterConvergence(root, convergedSha, headSha, base, remoteNames, mergedHeads, execFileImpl) {
  let merges = 0;
  const unknown = reason => ({ kind: 'unknown', merges, reason });
  if (!validBranchName(base)) return unknown('base-ref');
  try {
    const git = (...args) => runReviewGit(root, args, execFileImpl);
    let baseSha;
    for (const remote of remoteNames.filter(validBranchName)) {
      try {
        const sha = (await git('rev-parse', '--verify', `refs/remotes/${remote}/${base}^{commit}`)).trim();
        if (isCompleteCommitSha(sha)) { baseSha = sha; break; }
      } catch {}
    }
    if (!baseSha && !mergedHeads.length) return unknown('base-missing');
    try { await git('merge-base', '--is-ancestor', convergedSha, headSha); }
    catch (error) {
      if (error.code === 1) return { kind: 'other', merges };
      throw error;
    }
    const lines = (await git('rev-list', '--first-parent', '--parents',
      `--max-count=${MAX_AFTER_CONVERGENCE_MERGES + 1}`, `${convergedSha}..${headSha}`)).trim().split(/\r?\n/).filter(Boolean);
    if (!lines.length || lines.length > MAX_AFTER_CONVERGENCE_MERGES) return { kind: 'other', merges };
    let expected = headSha.toLowerCase();
    const commits = [];
    for (const line of lines) {
      const [sha, firstParent, ...parents] = line.split(' ');
      if (![sha, firstParent, ...parents].every(isCompleteCommitSha)) return unknown('commit-format');
      if (sha.toLowerCase() !== expected || !parents.length) return { kind: 'other', merges };
      for (const parent of parents) {
        let inBase = false;
        if (baseSha) {
          try { await git('merge-base', '--is-ancestor', parent, baseSha); inBase = true; }
          catch (error) { if (error.code !== 1) throw error; }
        }
        // 手元に無いマージ済みの head は、その候補だけを外す。
        for (const mergedHead of inBase ? [] : mergedHeads) {
          try { await git('merge-base', '--is-ancestor', parent, mergedHead); inBase = true; break; }
          catch (error) { if (typeof error.code !== 'number') throw error; }
        }
        if (!inBase) return baseSha ? { kind: 'other', merges } : unknown('base-missing');
      }
      expected = firstParent.toLowerCase();
      commits.push({ sha, parents });
      merges++;
    }
    if (expected !== convergedSha.toLowerCase()) return { kind: 'other', merges };
    let files = 0;
    let insertions = 0;
    let deletions = 0;
    for (const { sha, parents } of commits) {
      // remerge-diff は親が 2 つの merge だけを再構成できる。
      if (parents.length !== 1) return unknown('octopus-merge');
      const diff = await git('show', '--remerge-diff', '--format=', '--numstat', sha);
      for (const line of diff.split(/\r?\n/).filter(Boolean)) {
        const match = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
        if (!match) return unknown('diff-format');
        files++;
        insertions += match[1] === '-' ? 0 : Number(match[1]);
        deletions += match[2] === '-' ? 0 : Number(match[2]);
      }
    }
    return { kind: files ? 'resolved' : 'clean', merges, files, insertions, deletions };
  } catch { return unknown('git-failed'); }
}

async function readCrossReviewState(registration, pullRequest, options = {}) {
  const { fileSystem, execFileImpl, remoteRepositoryCache, headToolCache, baseAncestorCache, mergedCandidates } = crossReviewReadOptions(options);
  const report = (file, head = 'missing', failure = 'none', state = {}) => options.observeReview?.(registration, { file, head, failure, ...state });
  const branch = pullRequest?.headRefName;
  if (!registration.cwd) return undefined;
  // 状態ファイルは初回レビューまで作られないため、ツール本体の有無で連携を判定する。
  const tool = await detectCrossReviewTool(registration.cwd, fileSystem);
  if (!['present', 'absent', 'missing'].includes(tool.status)) {
    report('unknown', 'missing', 'tool-read');
    return { unavailable: true };
  }
  const { root } = tool;
  const pullRequestRepository = parsePullRequestUrl(pullRequest?.url);
  let baseRemoteNames = [];
  let matchedBaseRemoteNames = [];
  if (pullRequestRepository) {
    // フォークから upstream に作った PR は origin と食い違うため、どの GitHub の remote とも一致すれば続ける。
    // 道具の有無は別のリポジトリの判定にならないので、レビュー不要と判定する前に照合する。
    const remotes = await gitRemotesOf(root, execFileImpl, remoteRepositoryCache);
    const gitHubRemotes = remotes.filter((remote) => remote.owner);
    const matchingRemotes = gitHubRemotes.filter((remote) => sameGitHubRepository(remote, pullRequestRepository));
    if (gitHubRemotes.length && !matchingRemotes.length) {
      report('unknown', 'missing', 'repository-mismatch');
      return { unavailable: true, reason: 'repository-mismatch' };
    }
    // SSH の別名ホストなどで GitHub の remote と判定できないときは、PR のリポジトリを決められないのですべてを base の候補にする。
    baseRemoteNames = (gitHubRemotes.length ? matchingRemotes : remotes).map((remote) => remote.name);
    // 収束の引き継ぎは別のリポジトリの base で判定するとマージの条件を誤って満たすので、照合できた remote だけを使う。
    matchedBaseRemoteNames = matchingRemotes.map((remote) => remote.name);
  }
  let headTool = tool.status === 'present' ? 'present'
    : await crossReviewToolAtHead(root, pullRequest?.headRefOid, execFileImpl, headToolCache);
  // head のコミットが手元に無いなどで確かめられないときは、base ブランチの道具の有無で、道具を使うリポジトリかを判断する。
  // 「レビュー不要」は道具が無いと確かめられたときだけにし、確かめられない PR をマージの条件から外さない。
  if (headTool === 'unknown') headTool = await crossReviewToolAtBase(root, pullRequest?.baseRefName, baseRemoteNames, execFileImpl);
  if (headTool === 'absent') {
    report('unknown', 'missing', 'tool-absent');
    return { notRequired: true, source: 'tool-absent' };
  }
  if (tool.status === 'missing' || headTool === 'unknown') {
    report('unknown', 'missing', 'tool-read');
    return { unavailable: true };
  }
  let contents;
  try {
    contents = await fileSystem.readFile(path.join(root, '.cross-review-state.json'), 'utf8');
  } catch (error) {
    report(error.code === 'ENOENT' ? 'missing' : 'unknown', 'missing', error.code === 'ENOENT' ? 'none' : 'read');
    return error.code === 'ENOENT' ? null : { unavailable: true };
  }
  try {
    const parsed = parseCrossReviewState(contents);
    if (parsed.kind === 'invalid') {
      report('present', 'missing', 'parse');
      return { unavailable: true };
    }
    if (!branch) { report('present'); return null; }
    if (!Object.hasOwn(parsed.state.branches, branch)) { report('present'); return null; }
    const branchState = parsed.state.branches[branch];
    if (parsed.issues.some(({ path: issuePath }) => issuePath[0] === 'branches' && issuePath[1] === branch
      && (issuePath.length === 2 || (issuePath.length === 3 && ['round', 'dismissed'].includes(issuePath[2]))))) {
      report('present', 'missing', 'invalid');
      return { unavailable: true };
    }
    const lastReviewedSha = branchState.lastReviewedSha;
    const lastTriage = branchState.lastTriage;
    const triageSha = lastTriage?.sha;
    // --uncommitted のレビューは lastReviewedSha を据え置くので、記録の SHA がすべて base に入っているときだけ前の PR の記録とみなす。
    const recordedShas = [lastReviewedSha, triageSha].filter(isCompleteCommitSha);
    let staleRecord = recordedShas.length > 0;
    for (const sha of recordedShas) {
      if (!staleRecord) break;
      staleRecord = await reviewAlreadyInBase(root, sha, pullRequest.baseRefName, baseRemoteNames, execFileImpl, baseAncestorCache);
    }
    if (staleRecord) {
      report('present', 'mismatch', 'stale-record');
      return null;
    }
    const triage = lastTriage;
    const afterConvergence = triage?.round === branchState.round && triage.outcome === 'converged'
      && isCompleteCommitSha(triage.sha) && isCompleteCommitSha(pullRequest.headRefOid)
      && triage.sha.toLowerCase() !== pullRequest.headRefOid.toLowerCase()
      ? await classifyAfterConvergence(root, triage.sha, pullRequest.headRefOid, pullRequest.baseRefName, matchedBaseRemoteNames,
        matchedBaseRemoteNames.length ? mergedHeadsOfBase(mergedCandidates, pullRequest.baseRefName) : [], execFileImpl)
      : null;
    report('present', isCompleteCommitSha(lastReviewedSha)
      ? (lastReviewedSha.toLowerCase() === pullRequest.headRefOid?.toLowerCase() ? 'match' : 'mismatch') : 'missing', 'none',
      { afterConvergence, round: branchState.round, outcome: triage?.outcome || 'missing', triageHead: triage
        ? (triage.sha === pullRequest.headRefOid?.toLowerCase() ? 'match' : 'mismatch') : 'missing' });
    return {
      number: registration.number,
      branch,
      round: branchState.round,
      max: CROSS_REVIEW_MAX_ROUNDS,
      dismissed: branchState.dismissed.length,
      reviewedSha: isCompleteCommitSha(lastReviewedSha)
        ? lastReviewedSha.toLowerCase()
        : null,
      triage,
      ...(afterConvergence ? { afterConvergence } : {}),
    };
  } catch {
    report('present', 'missing', 'parse');
    return { unavailable: true };
  }
}

async function reviewAlreadyInBase(root, sha, base, remoteNames, execFileImpl, cache) {
  if (!validBranchName(base)) return false;
  const key = JSON.stringify([process.platform === 'win32' ? root.toLowerCase() : root, sha.toLowerCase(), base, remoteNames]);
  if (cache?.has(key)) return cache.get(key);
  const run = (args) => new Promise((resolve) => {
    try {
      execFileImpl('git', ['-C', root, ...args], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
      }, (error, stdout) => resolve({ error, stdout }));
    } catch (error) { resolve({ error }); }
  });
  const result = (async () => {
    const refs = remoteNames.filter(validBranchName).map(name => `refs/remotes/${name}/${base}`);
    let remoteFound = false;
    for (const ref of [...refs, `refs/heads/${base}`]) {
      if (remoteFound && ref === `refs/heads/${base}`) break;
      const resolved = await run(['rev-parse', '--verify', `${ref}^{commit}`]);
      if (resolved.error || !isCompleteCommitSha(resolved.stdout?.trim())) continue;
      if (ref.startsWith('refs/remotes/')) remoteFound = true;
      const ancestor = await run(['merge-base', '--is-ancestor', sha, ref]);
      if (!ancestor.error) return true;
    }
    return false;
  })();
  cache?.set(key, result);
  return result;
}

function listWorktrees(root, execFileImpl = execFile) {
  const parse = (stdout) => {
    const worktrees = [];
    let current = null;
    for (const line of stdout.split(/\r?\n/)) {
      if (line.startsWith('worktree ')) {
        current = { path: path.resolve(line.slice('worktree '.length)), branch: null };
        worktrees.push(current);
      } else if (current && line.startsWith('branch refs/heads/')) {
        current.branch = line.slice('branch refs/heads/'.length);
      } else if (current && /^prunable(?: |$)/.test(line)) {
        current.prunable = true;
      }
    }
    return worktrees;
  };
  return new Promise((resolve) => {
    // EPERM など一部の起動失敗は callback ではなく同期の例外になる。
    try {
      execFileImpl('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
        encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024, windowsHide: true, shell: false,
      }, (error, stdout) => resolve(error || typeof stdout !== 'string' ? [] : parse(stdout)));
    } catch {
      resolve([]);
    }
  });
}

// PR は登録したセッションとは別の worktree で作られることがあり、フックの cwd はコマンド中の cd を反映しないため、
// ほかの worktree の状態ファイルも候補にする。スタックを 1 つの worktree で積むと下の段のブランチはどこにもチェックアウトされないので、
// チェックアウトしていない worktree は、そのブランチの記録を持つときだけ候補にする。読めない worktree で記録なしの表示を上書きしないため。
async function collectCrossReviewStatesAcrossWorktrees(registration, pullRequest, options = {}) {
  const fileSystem = options.fileSystem || fs;
  const review = await readCrossReviewState(registration, pullRequest, options);
  const { root } = await findWorktreeRoot(registration.cwd, fileSystem);
  const candidates = [{ worktree: root || registration.cwd || '', review }];
  const branch = pullRequest?.headRefName;
  if (review === undefined || !branch) return candidates;
  if (review?.reason === 'repository-mismatch') {
    const checkedRoots = new Set();
    const matchingCandidates = [];
    for (const record of options.registrations || []) {
      if (!sameGitHubRepository(record, registration)) continue;
      const checkout = await matchingRepositoryCheckout(record.cwd, registration, options);
      if (!checkout || checkedRoots.has(checkout)) continue;
      checkedRoots.add(checkout);
      matchingCandidates.push(...await collectCrossReviewStatesAcrossWorktrees({ ...registration, cwd: checkout }, pullRequest, {
        ...options, registrations: [], requireMatchingRepository: true,
      }));
    }
    const matching = matchingCandidates.filter(candidate => candidate.review?.reason !== 'repository-mismatch');
    return matching.length ? matching : candidates;
  }
  if (!root) return candidates;
  const sameRoot = (left, right) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  let cwdMissing = false;
  try {
    await fileSystem.stat(registration.cwd);
  } catch (error) {
    cwdMissing = ['ENOENT', 'ENOTDIR'].includes(error.code);
  }
  for (const worktree of await listWorktrees(root, options.execFileImpl)) {
    if (worktree.prunable || (!cwdMissing && sameRoot(worktree.path, root))) continue;
    if (options.requireMatchingRepository && !await matchingRepositoryCheckout(worktree.path, registration, options)) continue;
    const candidate = await readCrossReviewState({ ...registration, cwd: worktree.path }, pullRequest, options);
    if (candidate?.reason === 'repository-mismatch') continue;
    const hasRecord = Number.isSafeInteger(candidate?.round);
    if (worktree.branch !== branch && !hasRecord) continue;
    candidates.push({ worktree: worktree.path, review: candidate });
  }
  return candidates;
}

async function readCrossReviewStateAcrossWorktrees(registration, pullRequest, options = {}) {
  const candidates = await collectCrossReviewStatesAcrossWorktrees(registration, pullRequest, options);
  if (options.candidates) {
    options.candidates.push(...candidates);
    return undefined;
  }
  return selectCrossReview(candidates, pullRequest.headRefOid);
}

function selectCrossReview(candidates, headSha) {
  const pathKey = (value) => process.platform === 'win32' ? value.toLowerCase() : value;
  const comparePath = (left, right) => left < right ? -1 : left > right ? 1 : 0;
  const priority = (review) => review === undefined ? 0
    : review?.notRequired === true ? 1 : review === null ? 3 : review?.unavailable === true ? 2 : 4;
  const unique = new Map();
  for (const candidate of candidates) {
    const key = pathKey(candidate.worktree);
    const current = unique.get(key);
    if (!current || priority(candidate.review) > priority(current.review)) unique.set(key, candidate);
  }
  const entries = [...unique.values()].map(candidate => ({
    ...candidate, outcome: evaluateReview({ record: candidate.review, headSha }).atHead,
  }));
  const converged = entries.filter(entry => entry.outcome === 'converged');
  const conflicting = converged.length > 0 && entries.some(entry =>
    ['halted', 'fixing'].includes(entry.outcome) || entry.outcome === 'in-progress'
      && converged.some(done => entry.review.round > done.review.triage.round));
  const outcomePriority = conflicting
    ? { halted: 4, fixing: 3, 'in-progress': 2, converged: 1, stale: 0 }
    : { converged: 2, halted: 1, fixing: 1, 'in-progress': 1, stale: 0 };
  entries.sort((left, right) => priority(right.review) - priority(left.review)
    || outcomePriority[right.outcome] - outcomePriority[left.outcome]
    || (right.review?.round || 0) - (left.review?.round || 0)
    || comparePath(pathKey(left.worktree), pathKey(right.worktree))
    || comparePath(left.worktree, right.worktree));
  const selected = entries[0]?.review;
  if (!conflicting) return selected;
  const conflict = entries.filter(entry => entry.outcome !== 'stale').map(({ worktree, review, outcome }) => ({
    worktree, round: review.round,
    sha: outcome === 'in-progress' ? review.reviewedSha : review.triage.sha,
    outcome,
  }));
  return { ...selected, conflict };
}

function mergeConditionWaits(pullRequest, condition) {
  const waiting = [];
  if (condition !== 'operation' && pullRequest.ci !== 'pass') {
    waiting.push(pullRequest.ci === 'fail' ? 'CI が失敗' : pullRequest.ci === 'pending' ? 'CI 実行中' : 'CI 状態不明');
  }
  if (condition === 'cross-review' && !pullRequest.review.mergeCondition.met) {
    waiting.push(pullRequest.review.mergeCondition.waitReason);
  }
  return waiting;
}

function applyMergeCondition(pullRequest, condition) {
  const children = pullRequest.children.map((child) => applyMergeCondition(child, condition));
  const waiting = mergeConditionWaits(pullRequest, condition);
  return {
    ...pullRequest,
    mergeCondition: condition,
    mergeConditionWaits: waiting,
    mergeConditionMet: pullRequest.canMerge === true && waiting.length === 0,
    children,
  };
}

// マージボタンは登録したセッションがある PR にだけ出るので、件数もそれに合わせる。
function mergeablePullRequestCount(trees) {
  return trees.reduce((total, pullRequest) => total + Number(!pullRequest.hidden && (pullRequest.mergeConditionMet ?? pullRequest.canMerge) === true && Boolean(pullRequest.mergeSessionId))
    + mergeablePullRequestCount(pullRequest.children || []), 0);
}

// 鍵の文字列はプロダクトの鍵次第で分解できないので、リポジトリは保存した owner と repo で比べる。
function removeStaleProductViews(productViews, repositoryKey, currentIdentities) {
  for (const [identity, view] of productViews) {
    if (repoKey(view.owner, view.repo) === repositoryKey && !currentIdentities.has(identity)) productViews.delete(identity);
  }
}

// 後段で push するのは listAvailable が真のときだけで、その場合は新しい配列を返す。
function interpretFetchResults({ listResult, configResult, current, checkedAt }) {
  const errors = [];
  const uninspectedNumbers = new Set();
  let openPullRequests = current.openPullRequests;
  let defaultBranch = current.defaultBranch;
  let mergeMethods = current.mergeMethods;
  let autoDeleteBranch = current.autoDeleteBranch;
  let configAvailable = false;
  let fetchedAt = current.fetchedAt;
  let listAvailable = false;

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
      configAvailable = true;
    } catch {
      errors.push('リポジトリ設定を読み取れませんでした');
    }
  } else {
    errors.push(`リポジトリ設定を取得できません。${ghErrorMessage(configResult.reason)}`);
  }
  const openNumbers = new Set(openPullRequests.map((pr) => pr.number));
  return { openPullRequests, openNumbers, defaultBranch, mergeMethods, autoDeleteBranch, configAvailable,
    fetchedAt, listAvailable, errors, uninspectedNumbers };
}

function selectPullRequestsToInspect({ registrationsBeforeInspection, relatedBeforeInspection, openNumbers, retried }) {
  const trackedByNumber = new Map();
  for (const record of [...registrationsBeforeInspection, ...relatedBeforeInspection]) {
    let tracked = trackedByNumber.get(record.number);
    if (!tracked) {
      tracked = { registrations: [], related: null, record: null };
      trackedByNumber.set(record.number, tracked);
    }
    if (record.session_id) tracked.registrations.push(record);
    else tracked.related = record;
    tracked.record ||= record;
  }
  const backfill = [...trackedByNumber.entries()]
    .filter(([number, tracked]) => !openNumbers.has(number) && tracked.record.state === 'merged'
      && !confirmedMergedHead(tracked.record.mergedHead)
      && !retried.has(number))
    .slice(0, 5);
  const backfillNumbers = new Set(backfill.map(([number]) => number));
  const toInspect = [...trackedByNumber.entries()]
    .filter(([number, tracked]) => !openNumbers.has(number) && !['merged', 'closed'].includes(tracked.record.state))
    .concat(backfill);
  return { trackedByNumber, toInspect, backfillNumbers };
}

function classifyInspectedPullRequest(result, backfillNumbers) {
  if (backfillNumbers.has(result.number) && (result.error || result.value?.state !== 'MERGED'
    || !confirmedMergedHead(result.value))) return { kind: 'skip' };
  if (result.error) return { kind: 'error', error: `#${result.number} の状態を確認できません。${ghErrorMessage(result.error)}` };
  const value = result.value;
  const state = String(value.state || '').toUpperCase();
  if (!['OPEN', 'CLOSED', 'MERGED'].includes(state)) {
    return { kind: 'unreadable', error: `#${result.number} の状態を読み取れませんでした` };
  }
  const closedState = state === 'MERGED' || (state === 'CLOSED' && value.mergedAt) ? 'merged' : state === 'CLOSED' ? 'closed' : 'open';
  if (closedState === 'open') {
    const pullRequest = normalizeOpenPullRequest(value);
    return pullRequest ? { kind: 'open', pullRequest }
      : { kind: 'unreadable', error: `#${result.number} の状態を読み取れませんでした` };
  }
  const stateChanges = {
    state: closedState,
    mergedAt: typeof value.mergedAt === 'string' ? value.mergedAt : null,
  };
  if (closedState === 'merged') stateChanges.mergedHead = confirmedMergedHead(value);
  return { kind: closedState, stateChanges };
}

function stackedPullRequestsForMerge({ reservation, mergeIntent, pullRequest, openPullRequests, defaultBranch }) {
  if (pullRequest && pullRequest.headRefName === defaultBranch) return [];
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
  return [...stackedPullRequests.values()];
}

function productGroupsFor(owner, repo, registrations) {
  const key = repoKey(owner, repo);
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
  return productGroups;
}

class PullRequestTracker {
  constructor(options = {}) {
    this.state = options.state;
    this.diagnostics = options.diagnostics;
    this.diagnosticFailures = new Map();
    this.diagnosticReviews = new Map();
    this.execFileImpl = options.execFileImpl || execFile;
    this.ghPath = options.ghPath || 'gh';
    this.gitExecFileImpl = options.gitExecFileImpl || execFile;
    this.fileSystem = options.fileSystem || fs;
    this.now = options.now || Date.now;
    this.repositories = new Map();
    this.productViews = new Map();
    this.reviewByRepository = new Map();
    this.reviewGroupRefreshes = new Map();
    this.headToolResults = new Map();
    this.inFlight = new Map();
    this.inFlightVerifying = new Set();
    this.staleHeads = new Map();
    this.userRefresh = null;
    this.lastUserRefreshCompletedAt = -Infinity;
    this.executingMerges = new Set();
    this.lastFetchStartedAt = new Map();
    this.activeGhCount = 0;
    this.ghQueue = [];
    this.priorityGhQueue = [];
    this.priorityRepositories = new Map();
    this.deferredRefreshes = new Map();
    this.unknownMergeableRefreshCounts = new Map();
    this.lastCommandRefreshAt = -Infinity;
    this.commandRefreshTimer = null;
    this.initialFetchCompleted = new Set();
    this.mergedHeadBackfillAttempts = new Set();
    this.mergedHeadBackfillRetries = new Set();
    this.timer = null;
    this.onMerged = options.onMerged || null;
    this.onClosed = options.onClosed || null;
    this.onRefreshed = options.onRefreshed || null;
    this.readCrossReviewState = options.readCrossReviewStateAcrossWorktrees || readCrossReviewStateAcrossWorktrees;
  }

  start() {
    if (this.timer) return;
    const refresh = () => {
      void this.refreshAll().catch((error) => {
        this.diagnostics?.record('warn', 'merge', 'pr.refresh.failed', { name: error?.name });
      });
    };
    refresh();
    this.timer = setInterval(refresh, 60_000);
    this.timer.unref?.();
  }

  close() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timeout of this.deferredRefreshes.values()) clearTimeout(timeout);
    this.deferredRefreshes.clear();
    clearTimeout(this.commandRefreshTimer);
    this.commandRefreshTimer = null;
  }

  refreshAll({ inactiveIntervalMs = INACTIVE_REPOSITORY_REFRESH_INTERVAL_MS, fresh = false, verifyHeads = false } = {}) {
    const repositories = new Map();
    for (const record of [...this.state.readOnlyPullRequestRegistrations(), ...this.state.relatedPullRequestRegistrations()]) {
      const key = repoKey(record.owner, record.repo);
      const previous = repositories.get(key);
      const active = record.state == null || ['open', 'unknown'].includes(record.state);
      repositories.set(key, { owner: record.owner, repo: record.repo, active: previous?.active || active });
    }
    const now = this.now();
    const refreshes = [];
    for (const [key, { owner, repo, active }] of repositories) {
      const elapsed = this.lastFetchStartedAt.has(key) ? now - this.lastFetchStartedAt.get(key) : Infinity;
      if (active || elapsed >= inactiveIntervalMs) refreshes.push(fresh ? this.refreshRepoFresh(owner, repo, { verifyHeads }) : this.refreshRepo(owner, repo, { verifyHeads }));
      // コマンドの後に飛ばしたリポジトリは、間隔が明けた時点で取る。15 分の定期取得まで反映を待たせないため。
      else if (inactiveIntervalMs < INACTIVE_REPOSITORY_REFRESH_INTERVAL_MS) this.deferRefresh(owner, repo, inactiveIntervalMs - elapsed, { verifyHeads });
    }
    return Promise.all(refreshes).then(async (results) => {
      // 取り直しの間に登録されたリポジトリを消さないため、登録は待った後に数え直す。
      const registeredKeys = new Set([...this.state.readOnlyPullRequestRegistrations(), ...this.state.relatedPullRequestRegistrations()]
        .map((record) => repoKey(record.owner, record.repo)));
      let removed = false;
      for (const key of this.repositories.keys()) {
        if (!registeredKeys.has(key)) {
          this.repositories.delete(key);
          this.lastFetchStartedAt.delete(key);
          removed = true;
        }
      }
      for (const [identity, view] of this.productViews) {
        if (!registeredKeys.has(repoKey(view.owner, view.repo))) {
          this.productViews.delete(identity);
          removed = true;
        }
      }
      this.pruneUnregisteredRepositoryRecords(registeredKeys);
      const orphanedStacks = new Map(this.state.pullRequestMergeReservations()
        .filter((record) => record.kind === 'stack' && !registeredKeys.has(repoKey(record.owner, record.repo)))
        .map((record) => [repoKey(record.owner, record.repo), record]));
      for (const { owner, repo } of orphanedStacks.values()) await this.onRefreshed?.(owner, repo);
      if (removed) this.state.touch();
      return results;
    });
  }

  refreshAllByUser() {
    if (this.userRefresh) return this.userRefresh;
    if (this.now() - this.lastUserRefreshCompletedAt < USER_REFRESH_MIN_INTERVAL_MS) {
      return Promise.resolve({ ok: true, throttled: true });
    }
    this.userRefresh = this.refreshAll({ inactiveIntervalMs: 0, fresh: true, verifyHeads: true })
      .then(() => ({ ok: true, throttled: false }))
      .finally(() => {
        this.lastUserRefreshCompletedAt = this.now();
        this.userRefresh = null;
      });
    return this.userRefresh;
  }

  pruneUnregisteredRepositoryRecords(registeredKeys) {
    for (const key of this.staleHeads.keys()) {
      if (!registeredKeys.has(key)) this.staleHeads.delete(key);
    }
    for (const diagnosticKey of this.diagnosticFailures.keys()) {
      const firstSeparator = diagnosticKey.indexOf(':');
      const lastSeparator = diagnosticKey.lastIndexOf(':');
      if (firstSeparator < 0 || firstSeparator === lastSeparator) continue;
      const key = diagnosticKey.slice(firstSeparator + 1, lastSeparator).toLowerCase();
      if (!key) continue;
      if (!registeredKeys.has(key)) this.diagnosticFailures.delete(diagnosticKey);
    }
    for (const attemptKey of this.mergedHeadBackfillAttempts) {
      const separator = attemptKey.lastIndexOf('#');
      if (separator < 0) continue;
      if (!registeredKeys.has(attemptKey.slice(0, separator).toLowerCase())) {
        this.mergedHeadBackfillAttempts.delete(attemptKey);
      }
    }
  }

  async unregisterUnknownRepository(owner, repo) {
    const key = repoKey(owner, repo);
    // 取得中に確かめられた open を削除せず、取得処理が表示を復活させないように待つ。
    await this.inFlight.get(key)?.catch(() => {});
    const deleted = this.state.unregisterUnknownPullRequests(owner, repo);
    if (!deleted) return deleted;
    if (this.state.pullRequestRegistrationsForRepo(owner, repo).length
      || this.state.relatedPullRequestRegistrationsForRepo(owner, repo).length) {
      await this.refreshRepo(owner, repo);
    } else {
      this.repositories.delete(key);
      this.reviewByRepository.delete(key);
      this.initialFetchCompleted.delete(key);
      this.pruneUnregisteredRepositoryRecords(new Set(
        [...this.state.readOnlyPullRequestRegistrations(), ...this.state.relatedPullRequestRegistrations()]
          .map((record) => repoKey(record.owner, record.repo)),
      ));
      for (const [identity, view] of this.productViews) {
        if (repoKey(view.owner, view.repo) === key) this.productViews.delete(identity);
      }
      this.state.touch();
    }
    return deleted;
  }

  scheduleUnknownMergeableRefresh(owner, repo, openPullRequests, { verifyHeads = false } = {}) {
    const key = repoKey(owner, repo);
    if (!openPullRequests.some((pullRequest) => pullRequest.mergeable === 'UNKNOWN')) {
      this.unknownMergeableRefreshCounts.delete(key);
      return;
    }
    const count = (this.unknownMergeableRefreshCounts.get(key) || 0) + 1;
    this.unknownMergeableRefreshCounts.set(key, count);
    const stackWaiting = this.state.pullRequestMergeReservationsForRepo(owner, repo).some((record) => record.kind === 'stack' &&
      openPullRequests.some((pr) => pr.number === record.number && pr.mergeable === 'UNKNOWN'));
    if (count <= UNKNOWN_MERGEABLE_REFRESH_LIMIT || (stackWaiting && count <= STACK_UNKNOWN_REFRESH_LIMIT)) {
      this.deferRefresh(owner, repo, count <= UNKNOWN_MERGEABLE_REFRESH_LIMIT ? UNKNOWN_MERGEABLE_REFRESH_MS : STACK_UNKNOWN_REFRESH_MS, { verifyHeads });
    }
  }

  deferRefresh(owner, repo, delayMs, { verifyHeads = false } = {}) {
    const key = repoKey(owner, repo);
    if (this.deferredRefreshes.has(key)) {
      if (!verifyHeads) return;
      clearTimeout(this.deferredRefreshes.get(key));
    }
    const timeout = setTimeout(() => {
      this.deferredRefreshes.delete(key);
      if (!this.state.pullRequestRegistrationsForRepo(owner, repo).length
        && !this.state.relatedPullRequestRegistrationsForRepo(owner, repo).length) return;
      // 先に動いている取得はコマンドの前の状態かもしれないので、合流せず終わるのを待ってから取り直す。
      void this.refreshRepoFresh(owner, repo, { verifyHeads }).catch(() => {});
    }, Math.max(0, delayMs));
    timeout.unref?.();
    this.deferredRefreshes.set(key, timeout);
  }

  refreshRepo(owner, repo, { verifyHeads = false } = {}) {
    const repository = safeRepo(owner, repo);
    const key = repoKey(owner, repo);
    if (this.inFlight.has(key)) {
      const running = this.inFlight.get(key);
      if (verifyHeads && !this.inFlightVerifying.has(key)) {
        return running.catch(() => {}).then(() => this.refreshRepo(owner, repo, { verifyHeads }));
      }
      return running;
    }
    if (verifyHeads) this.inFlightVerifying.add(key);
    clearTimeout(this.deferredRefreshes.get(key));
    this.deferredRefreshes.delete(key);
    this.lastFetchStartedAt.set(key, this.now());
    const operation = this.fetchRepository(owner, repo, repository, { verifyHeads })
      .then(async (result) => {
        this.initialFetchCompleted.add(key);
        this.inFlight.delete(key);
        this.inFlightVerifying.delete(key);
        this.state.touch();
        try {
          await this.onRefreshed?.(owner, repo);
        } catch {}
        return result;
      }, (error) => {
        this.initialFetchCompleted.add(key);
        this.inFlight.delete(key);
        this.inFlightVerifying.delete(key);
        this.state.touch();
        throw error;
      });
    this.inFlight.set(key, operation);
    return operation;
  }

  async refreshRepoFresh(owner, repo, { priority = false, verifyHeads = priority } = {}) {
    verifyHeads ||= priority;
    const key = repoKey(owner, repo);
    if (!priority) {
      await this.inFlight.get(key)?.catch(() => {});
      return this.refreshRepo(owner, repo, { verifyHeads });
    }
    // 先に動いている同じリポジトリの取得を待つ間も、その gh を優先に引き上げて確定操作を待たせない。
    this.priorityRepositories.set(key, (this.priorityRepositories.get(key) || 0) + 1);
    this.promoteQueuedGh(key);
    try {
      await this.inFlight.get(key)?.catch(() => {});
    } finally {
      const count = this.priorityRepositories.get(key) - 1;
      if (count > 0) this.priorityRepositories.set(key, count);
      else this.priorityRepositories.delete(key);
    }
    return ghPriorityContext.run(true, () => this.refreshRepo(owner, repo, { verifyHeads }));
  }

  // 先に動く取得はコマンドの前の状態かもしれないので、終わるのを待ってから取り直す。
  refreshAfterCommand() {
    const elapsed = this.now() - this.lastCommandRefreshAt;
    if (elapsed < COMMAND_REFRESH_COALESCE_MS) {
      if (!this.commandRefreshTimer) {
        this.commandRefreshTimer = setTimeout(() => {
          this.commandRefreshTimer = null;
          void this.refreshAfterCommand().catch(() => {});
        }, COMMAND_REFRESH_COALESCE_MS - elapsed);
        this.commandRefreshTimer.unref?.();
      }
      return Promise.resolve([]);
    }
    this.lastCommandRefreshAt = this.now();
    return this.refreshAll({ inactiveIntervalMs: COMMAND_REFRESH_INACTIVE_INTERVAL_MS, fresh: true, verifyHeads: true });
  }

  mergeCandidate(registration) {
    const key = repoKey(registration.owner, registration.repo);
    const repository = this.repositories.get(key);
    if (!repository) return null;
    const productKey = registration.product?.key || `repo:${key}`;
    const registrations = this.state.pullRequestRegistrationsForRepo(registration.owner, registration.repo)
      .filter((record) => (record.product?.key || `repo:${key}`) === productKey);
    const assembled = assemblePullRequestStacks({
      ...repository,
      knownRegistrations: this.state.pullRequestRegistrationsForRepo(registration.owner, registration.repo),
      defaultBranch: repository.defaultBranch,
      openPullRequests: repository.openPullRequests,
      registrations,
      relatedPullRequests: this.state.relatedPullRequestRegistrationsForRepo(registration.owner, registration.repo),
      retargetedPrs: this.state.pullRequestRetargetsForRepo(registration.owner, registration.repo),
      restackResults: repository.restackResults,
      liveMergedBranches: repository.liveMergedBranches,
    });
    const find = (items) => {
      for (const item of items) {
        if (item.number === registration.number) return item;
        const nested = find(item.children);
        if (nested) return nested;
      }
      return null;
    };
    const pullRequest = find(assembled.trees);
    if (pullRequest) {
      pullRequest.githubReview = pullRequest.review;
      pullRequest.review = this.reviewByRepository.get(key)?.get(pullRequest.number)
        || reviewPresentation(evaluateReview({ headSha: pullRequest.headRefOid }));
    }
    return {
      registration,
      repository,
      registrations,
      pullRequest,
    };
  }

  repositoryState(owner, repo) {
    return this.repositories.get(repositoryKey(owner, repo)) || null;
  }

  ghConcurrencyLimit() {
    const limit = this.state?.getDisplayPreferences?.()?.ghConcurrencyLimit;
    return Number.isInteger(limit) && limit >= 1 ? limit : DISPLAY_SCHEMA.ghConcurrencyLimit.default;
  }

  // 上限は設定から毎回読むので、下げても実行中の gh は止めず、解放のたびに新しい上限まで払い出す。
  acquireGhSlot(priority, queueRepositoryKey) {
    return new Promise((resolve) => {
      (priority ? this.priorityGhQueue : this.ghQueue).push({ resolve, queueRepositoryKey });
      this.dispatchQueuedGh();
    });
  }

  dispatchQueuedGh() {
    const limit = this.ghConcurrencyLimit();
    while (this.activeGhCount < limit) {
      const next = this.priorityGhQueue.shift() || this.ghQueue.shift();
      if (!next) return;
      this.activeGhCount += 1;
      next.resolve();
    }
  }

  promoteQueuedGh(queueRepositoryKey) {
    const promoted = this.ghQueue.filter((entry) => entry.queueRepositoryKey === queueRepositoryKey);
    if (!promoted.length) return;
    this.ghQueue = this.ghQueue.filter((entry) => entry.queueRepositoryKey !== queueRepositoryKey);
    this.priorityGhQueue.push(...promoted);
  }

  releaseGhSlot() {
    this.activeGhCount -= 1;
    this.dispatchQueuedGh();
  }

  async execute(args, { priority = false, repositoryHint = null } = {}) {
    const apiPath = args.find(arg => arg.startsWith('repos/'));
    const operation = args[0] === 'pr' ? `pr.${args[1]}`
      : apiPath?.includes('/compare/') ? 'api.compare'
      : (args.includes('DELETE') || args.some((arg) => arg.includes('updateRefs(input:'))) ? 'api.delete-branch'
      : apiPath?.includes('/git/ref/') ? 'api.branch-head'
      : apiPath?.includes('/pulls') ? 'api.pull-requests' : 'api.repository';
    const repository = repositoryHint || (args.includes('-R') ? args[args.indexOf('-R') + 1]
      : args.find(arg => /^repos\/[^/]+\/[^/]+/.test(arg))?.split('/').slice(1, 3).join('/'));
    const number = args[0] === 'pr' && /^\d+$/.test(args[2]) ? Number(args[2]) : undefined;
    const key = `${operation}:${repository || ''}:${number || ''}`;
    const queueRepositoryKey = repository ? repository.toLowerCase() : null;
    await this.acquireGhSlot(
      priority || ghPriorityContext.getStore() === true || this.priorityRepositories.has(queueRepositoryKey), queueRepositoryKey,
    );
    try {
      const output = await runGh(args, { execFileImpl: this.execFileImpl, ghPath: this.ghPath });
      this.diagnosticFailures.delete(key);
      return output;
    } catch (error) {
      const consecutive = (this.diagnosticFailures.get(key) || 0) + 1;
      this.diagnosticFailures.set(key, consecutive);
      const registration = repository && this.state.readOnlyPullRequestRegistrations().find(record =>
        repositoryKey(record.owner, record.repo) === repository.toLowerCase() && (!number || record.number === number));
      this.diagnostics?.record('error', 'gh', 'gh.failed', { operation, repository, number,
        session: registration?.session_id.slice(0, 8), consecutive,
        failure: error.killed || error.code === 'ETIMEDOUT' ? 'timeout'
          : error.code === 'ENOENT' ? 'missing-command' : ['EPERM', 'EACCES'].includes(error.code) ? 'permission'
          : error.signal ? 'signal' : typeof error.code === 'number' ? 'exit' : 'execution',
        code: error.code, signal: error.signal, exitCode: typeof error.code === 'number' ? error.code : undefined });
      throw error;
    } finally {
      this.releaseGhSlot();
    }
  }

  async readPullRequestView(owner, repo, number, options) {
    const output = await this.execute([
      'pr', 'view', String(number), '-R', safeRepo(owner, repo), '--json', `${PULL_REQUEST_FIELDS},state,mergedAt`,
    ], options);
    const value = JSON.parse(output);
    const state = String(value?.state || '').toUpperCase();
    const pullRequest = normalizeOpenPullRequest(value);
    if (!['OPEN', 'CLOSED', 'MERGED'].includes(state) || !pullRequest) throw new Error('invalid PR view');
    return {
      state,
      pullRequest,
      mergedAt: typeof value.mergedAt === 'string' && Number.isFinite(Date.parse(value.mergedAt)) ? value.mergedAt : null,
    };
  }

  async readRemoteBranchHead(repository, branch, options = {}) {
    const encodedBranch = branch.split('/').map((segment) => encodeURIComponent(segment)).join('/');
    try {
      const output = await this.execute(['api', `repos/${repository}/git/ref/heads/${encodedBranch}`], options);
      const headRefOid = JSON.parse(output)?.object?.sha;
      if (!isCompleteCommitSha(headRefOid)) throw new Error('invalid branch ref');
      return headRefOid.toLowerCase();
    } catch (error) {
      if (isGitHubNotFoundError(error)) return null;
      throw error;
    }
  }

  async deleteRemoteBranchIfHeadMatches(owner, repo, branch, expectedHeadRefOid) {
    if (!validRepositoryPart(owner) || !validRepositoryPart(repo) || !validBranchName(branch) ||
      !isCompleteCommitSha(expectedHeadRefOid)) throw new Error('invalid branch deletion');
    const repository = safeRepo(owner, repo);
    const repositoryOutput = await this.execute([
      'api', 'graphql',
      '-f', `owner=${owner}`,
      '-f', `repository=${repo}`,
      '-f', `query=${REPOSITORY_NODE_ID_QUERY}`,
    ], { priority: true, repositoryHint: repository });
    const repositoryId = JSON.parse(repositoryOutput)?.data?.repository?.id;
    if (typeof repositoryId !== 'string' || !repositoryId) throw new Error('repository ID lookup failed');

    const mutationOutput = await this.execute([
      'api', 'graphql',
      '-f', `repositoryId=${repositoryId}`,
      '-f', `refName=refs/heads/${branch}`,
      '-f', `beforeOid=${expectedHeadRefOid.toLowerCase()}`,
      '-f', `afterOid=${EMPTY_GIT_OBJECT_ID}`,
      '-f', `query=${DELETE_BRANCH_REF_MUTATION}`,
    ], { priority: true, repositoryHint: repository });
    const mutationResult = JSON.parse(mutationOutput);
    if (mutationResult.errors?.length || !mutationResult.data?.updateRefs) {
      throw new Error('branch reference deletion failed');
    }
    return mutationOutput;
  }

  async inspectDisappearedPullRequests(owner, repo, repository, {
    registrationsBeforeInspection, relatedBeforeInspection, openPullRequests, openNumbers, errors, uninspectedNumbers, defaultBranch,
  }) {
    const { toInspect, backfillNumbers } = selectPullRequestsToInspect({
      registrationsBeforeInspection, relatedBeforeInspection, openNumbers,
      retried: new Set([...registrationsBeforeInspection, ...relatedBeforeInspection]
        .filter((record) => this.mergedHeadBackfillRetries.has(`${repository}#${record.number}`))
        .map((record) => record.number)),
    });
    for (const number of backfillNumbers) {
      const key = `${repository}#${number}`;
      if (this.mergedHeadBackfillAttempts.has(key)) this.mergedHeadBackfillRetries.add(key);
      this.mergedHeadBackfillAttempts.add(key);
    }
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
      const classified = classifyInspectedPullRequest(result, backfillNumbers);
      if (classified.kind === 'skip') continue;
      if (classified.kind === 'error' || classified.kind === 'unreadable') {
        errors.push(classified.error);
        uninspectedNumbers.add(result.number);
        continue;
      }
      if (classified.kind === 'open') {
        openPullRequests.push(classified.pullRequest);
        openNumbers.add(classified.pullRequest.number);
        continue;
      }
      const value = result.value;
      const closedState = classified.kind;
      if (closedState === 'merged' && this.executingMerges.has(pullRequestKey(owner, repo, result.number))) continue;
      const stateChanges = classified.stateChanges;
      for (const record of result.tracked.registrations) {
        this.state.updatePullRequest(record.session_id, owner, repo, result.number, stateChanges);
      }
      if (result.tracked.related) {
        this.state.updateRelatedPullRequest(owner, repo, result.number, stateChanges);
      }
      if (closedState === 'merged' && result.tracked.record.state !== 'merged') {
        const reservation = this.state.pullRequestMergeReservation(owner, repo, result.number);
        const mergeIntent = this.state.pullRequestMergeIntent(owner, repo, result.number);
        const pullRequest = normalizeOpenPullRequest(value);
        const stackedPullRequests = stackedPullRequestsForMerge({
          reservation, mergeIntent, pullRequest, openPullRequests, defaultBranch,
        });
        await this.onMerged?.({
          owner,
          repo,
          pullRequest,
          mergedAt: typeof value.mergedAt === 'string' ? value.mergedAt : new Date(this.now()).toISOString(),
          reservation,
          registrations: result.tracked.registrations,
          stackedPullRequests,
          defaultBranch,
        });
      } else if (closedState === 'closed' && result.tracked.record.state !== 'closed') {
        const reservation = this.state.pullRequestMergeReservation(owner, repo, result.number);
        const mergeIntent = this.state.pullRequestMergeIntent(owner, repo, result.number);
        if (reservation || mergeIntent) await this.onClosed?.({ owner, repo, number: result.number, reservation, mergeIntent, registrations: result.tracked.registrations });
      }
    }
  }

  async fetchMergedPullRequests(repository, openPullRequests) {
    if (!openPullRequests.length) {
      return { mergedPullRequests: [], mergedListComplete: true, error: null };
    }
    const since = mergedSearchSince(openPullRequests);
    try {
      const mergedPullRequests = parseMergedPullRequestList(await this.execute([
        'pr', 'list', '-R', repository, '--state', 'merged', '--limit', String(MERGED_PULL_REQUEST_LIMIT),
        ...(since ? ['--search', `merged:>=${since}`] : []), '--json', 'number,headRefOid,headRefName,baseRefName,mergedAt',
      ]));
      return { mergedPullRequests, mergedListComplete: mergedPullRequests.length < MERGED_PULL_REQUEST_LIMIT, error: null };
    } catch (error) {
      return { mergedPullRequests: null, mergedListComplete: false,
        error: `マージ済み PR の一覧を取得できません。${ghErrorMessage(error)}` };
    }
  }

  updateProductMembership(owner, repo, {
    registrations, relatedPullRequests, openPullRequests, defaultBranch, listAvailable, restackResults, liveMergedBranches,
    mergedPullRequests, mergedCandidates, mergeTargetHeadChecks, uninspectedNumbers, mergeMethods,
  }) {
    if (listAvailable) {
      const registeredNumbers = new Set(registrations.map((record) => record.number));
      const productGroups = productGroupsFor(owner, repo, registrations);
      const groupAssemblies = [];
      const displayProductsByNumber = new Map();
      for (const group of productGroups.values()) {
        const assembled = assemblePullRequestStacks({
          defaultBranch,
          listAvailable, mergedPullRequests, mergedCandidates, mergeTargetHeadChecks, uninspectedNumbers, mergeMethods,
          knownRegistrations: registrations,
          openPullRequests,
          registrations: group.registrations,
          relatedPullRequests,
          retargetedPrs: this.state.pullRequestRetargetsForRepo(owner, repo),
          restackResults,
          liveMergedBranches,
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
  }

  async fetchRepository(owner, repo, repository, { verifyHeads = false } = {}) {
    const key = repoKey(owner, repo);
    const fetchStartedAt = this.now();
    const closureGenerationAtStart = this.state.pullRequestClosureGeneration(owner, repo);
    // 実行中に取った一覧はマージ前のオープンを返しうるので、実行が終わってから突き合わせても意図を消さない。
    const mergesExecutingAtStart = new Set(this.executingMerges);
    const checkedAt = new Date(fetchStartedAt).toISOString();
    const current = this.repositories.get(key) || {
      owner, repo, openPullRequests: [], defaultBranch: null, mergeMethods: [], autoDeleteBranch: false, configAvailable: false, fetchedAt: null, checkedAt: null,
    };
    const registrationsBeforeInspection = this.state.pullRequestRegistrationsForRepo(owner, repo);
    const relatedBeforeInspection = this.state.relatedPullRequestRegistrationsForRepo(owner, repo);
    const [listResult, configResult] = await Promise.allSettled([
      this.execute(['pr', 'list', '-R', repository, '--state', 'open', '--limit', '500', '--json', PULL_REQUEST_FIELDS]),
      this.execute(['api', `repos/${repository}`]),
    ]);
    const { openPullRequests, openNumbers, defaultBranch, mergeMethods, autoDeleteBranch, configAvailable,
      fetchedAt, listAvailable, errors, uninspectedNumbers } = interpretFetchResults({
      listResult, configResult, current, checkedAt,
    });
    if (listAvailable) this.scheduleUnknownMergeableRefresh(owner, repo, openPullRequests, { verifyHeads });
    let mergedPullRequests = null;
    let mergedListComplete = false;

    if (listAvailable) {
      await this.inspectDisappearedPullRequests(owner, repo, repository, {
        registrationsBeforeInspection, relatedBeforeInspection, openPullRequests, openNumbers, errors, uninspectedNumbers, defaultBranch,
      });
    }

    if (listAvailable) {
      for (const pullRequest of openPullRequests) {
        const intent = this.state.pullRequestMergeIntent(owner, repo, pullRequest.number);
        const mergeKey = pullRequestKey(owner, repo, pullRequest.number);
        if (!intent || mergesExecutingAtStart.has(mergeKey) || this.executingMerges.has(mergeKey) ||
          fetchStartedAt < Date.parse(intent.createdAt) + GH_TIMEOUT_MS) continue;
        this.state.clearPullRequestMergeIntent(owner, repo, pullRequest.number);
        this.state.recordPullRequestMergeReservationNotice({
          owner, repo, number: pullRequest.number, url: intent.url,
          at: new Date(this.now()).toISOString(),
          message: '前回のマージ操作の結果を確認できませんでした',
        });
      }
    }

    // gh pr view で補ったオープンの PR も含めるため、マージ済みの一覧は補った後に取る。
    if (listAvailable) {
      const mergedResult = await this.fetchMergedPullRequests(repository, openPullRequests);
      ({ mergedPullRequests, mergedListComplete } = mergedResult);
      if (mergedResult.error) errors.push(mergedResult.error);
    }

    const historicalPullRequests = historicalMergedPullRequests(
      this.state.pullRequestRegistrationsForRepo(owner, repo),
      this.state.relatedPullRequestRegistrationsForRepo(owner, repo),
      openPullRequests,
    );
    const mergedCandidates = mergedPullRequestCandidates(mergedPullRequests, historicalPullRequests);
    const branchHeadRequests = new Map();
    const readBranchHead = (branch) => {
      if (!branchHeadRequests.has(branch)) {
        branchHeadRequests.set(branch, this.readRemoteBranchHead(repository, branch));
      }
      return branchHeadRequests.get(branch);
    };
    const mismatches = this.staleHeads.get(key) || new Map();
    await Promise.all(openPullRequests.map(async (pr) => {
      if (mismatches.get(pr.number)?.prHead !== pr.headRefOid) mismatches.delete(pr.number);
      // 確かめられない記録は定期の取得でも照合し直す。照合の付いた取得を待つと、予約のマージが回復後も再開しないため。
      const unverified = mismatches.has(pr.number) && !mismatches.get(pr.number).branchHead;
      if ((verifyHeads || unverified) && listAvailable && pr.isCrossRepository !== true && pr.headRefOid) {
        let branchHead = null;
        try {
          branchHead = await readBranchHead(pr.headRefName);
        } catch {}
        if (branchHead?.toLowerCase() === pr.headRefOid.toLowerCase()) mismatches.delete(pr.number);
        else if (branchHead) mismatches.set(pr.number, { prHead: pr.headRefOid, branchHead, checkedAt });
        // 読めないときに通すと、障害で ref も読めない間に古い head をマージしうるので、確かめられないとして止める。
        // 確かめた食い違いは、読めなくても SHA を示せるので残す。
        else if (!mismatches.get(pr.number)?.branchHead) mismatches.set(pr.number, { prHead: pr.headRefOid, branchHead: null, checkedAt });
      }
      const mismatch = mismatches.get(pr.number);
      pr.staleHead = mismatch ? { prHead: mismatch.prHead, branchHead: mismatch.branchHead } : null;
    }));
    this.staleHeads.set(key, mismatches);
    const { restackResults, liveMergedBranches } = await evaluateRestack({
      openPullRequests, mergedCandidates, mergedListComplete, defaultBranch, listAvailable, readBranchHead,
      compare: async (compareBase, headRefOid) => parseCompareResult(await this.execute([
        'api', `repos/${repository}/compare/${encodeURIComponent(compareBase)}...${headRefOid}`,
      ])),
      onError: (message) => errors.push(message),
    });

    // base を付け替えた子も親のプロダクトに数えるため、所属は積み直しの判定の後に、画面と同じ結果で集める。
    const registrations = this.state.pullRequestRegistrationsForRepo(owner, repo);
    const relatedPullRequests = this.state.relatedPullRequestRegistrationsForRepo(owner, repo);
    const openHeads = new Set(openPullRequests.map((pr) => pr.headRefName));
    const candidateBases = new Set(openPullRequests.map((pr) => pr.baseRefName));
    const assembled = assemblePullRequestStacks({
      defaultBranch, openPullRequests, registrations, relatedPullRequests, restackResults, liveMergedBranches,
      retargetedPrs: this.state.pullRequestRetargetsForRepo(owner, repo),
    });
    const collectBases = (nodes) => {
      for (const node of nodes) {
        candidateBases.add(node.effectiveBase);
        collectBases(node.children);
      }
    };
    collectBases(assembled.trees);
    const candidates = [...candidateBases].filter((base) => base !== defaultBranch && !openHeads.has(base));
    const mergeTargetHeadChecks = new Map(candidates.map(branch => [branch, null]));
    if (listAvailable) {
      await Promise.all(candidates.slice(0, MERGE_TARGET_HEAD_CHECK_LIMIT).map(async (branch) => {
        try {
          const result = JSON.parse(await this.execute([
            'pr', 'list', '-R', repository, '--state', 'all', '--head', branch, '--limit', '1', '--json', 'number',
          ]));
          if (!Array.isArray(result)) throw new Error('PR の一覧が配列ではありません');
          mergeTargetHeadChecks.set(branch, result.length === 0);
        } catch {
          // リポジトリ全体の取得エラーにすると、無関係な既定ブランチ向けの PR のマージまで止まる。
          // 未確認のまま残し、このブランチを base にした PR だけを止める。
        }
      }));
    }
    // 取得中に確定したマージとクローズを古い一覧で戻さず、ほかの PR の更新は反映する。
    const currentOpenPullRequests = openPullRequests.filter((pr) =>
      this.state.pullRequestClosureGeneration(owner, repo, pr.number) <= closureGenerationAtStart);
    const currentNumbers = new Set(currentOpenPullRequests.map((pr) => pr.number));
    for (const number of mismatches.keys()) {
      if (!currentNumbers.has(number)) mismatches.delete(number);
    }
    this.updateProductMembership(owner, repo, {
      registrations, relatedPullRequests, openPullRequests: currentOpenPullRequests, defaultBranch, listAvailable, restackResults, liveMergedBranches,
      mergedPullRequests, mergedCandidates, mergeTargetHeadChecks, uninspectedNumbers, mergeMethods,
    });

    this.repositories.set(key, {
      owner,
      repo,
      openPullRequests: currentOpenPullRequests,
      defaultBranch,
      mergeMethods,
      autoDeleteBranch,
      configAvailable,
      fetchedAt,
      checkedAt,
      error: errors.length ? [...new Set(errors)].join('。') : null,
      listAvailable,
      mergedPullRequests,
      mergedCandidates,
      mergeTargetHeadChecks,
      uninspectedNumbers,
      restackResults,
      liveMergedBranches,
    });
    await this.refreshReviewGroups(owner, repo);
    this.state.touch();
    return this.repositories.get(key);
  }

  async missingReviewRecords(sessionId) {
    const registrations = this.state.pullRequestRegistrations().filter((record) => record.session_id === sessionId);
    const repositories = new Map(registrations.map((record) => [repoKey(record.owner, record.repo), record]));
    await Promise.all([...repositories].map(async ([key, { owner, repo }]) => {
      await this.inFlight.get(key);
      await this.refreshReviewGroups(owner, repo);
    }));
    const targets = new Map();
    for (const { owner, repo, number } of registrations) {
      const key = repoKey(owner, repo);
      const pullRequest = this.repositories.get(key)?.openPullRequests.find((pr) => pr.number === number);
      const review = this.reviewByRepository.get(key)?.get(number);
      // 先頭を読めなかっただけの PR は一時的な失敗のことが多いので、確かめた食い違いだけを知らせる。
      const staleHead = pullRequest?.staleHead?.branchHead ? pullRequest.staleHead : null;
      if (staleHead || (review && reviewReminderNeeded(review.evaluation))) {
        targets.set(`${key}#${number}`, { owner, repo, number, headRefOid: pullRequest.headRefOid,
          ...(review?.evaluation.afterConvergence ? { afterConvergence: review.evaluation.afterConvergence } : {}),
          ...(staleHead ? { staleHead } : {}) });
      }
    }
    return [...targets.values()];
  }

  refreshReviewGroups(owner, repo) {
    const key = repoKey(owner, repo);
    let refresh = this.reviewGroupRefreshes.get(key);
    if (refresh) {
      if (!refresh.pending) {
        refresh.pending = new Promise((resolve, reject) => { refresh.next = { resolve, reject }; });
      }
      return refresh.pending;
    }
    refresh = {};
    this.reviewGroupRefreshes.set(key, refresh);
    return this.runReviewGroupRefresh(owner, repo, key, refresh);
  }

  async runReviewGroupRefresh(owner, repo, key, refresh) {
    try {
      await this.recalculateReviewGroups(owner, repo);
    } finally {
      if (refresh.pending) {
        const next = refresh.next;
        refresh.pending = null;
        refresh.next = null;
        this.runReviewGroupRefresh(owner, repo, key, refresh).then(next.resolve, next.reject);
      } else this.reviewGroupRefreshes.delete(key);
    }
  }

  async recalculateReviewGroups(owner, repo) {
    const key = repoKey(owner, repo);
    const repositoryState = this.repositories.get(key);
    if (!repositoryState) return;
    const registrations = this.state.pullRequestRegistrationsForRepo(owner, repo);
    const relatedPullRequests = this.state.relatedPullRequestRegistrationsForRepo(owner, repo);
    const productGroups = productGroupsFor(owner, repo, registrations);
    const createdIdentities = new Set();
    const remoteRepositoryCache = new Map();
    const headToolCache = { known: this.headToolResults, unknown: new Set() };
    const baseAncestorCache = new Map();
    // worktree が分かるのは登録したセッションだけなので、登録の無い関連 PR は未登録と評価する。
    const reviewByNumber = new Map();
    const candidatesByNumber = new Map();
    this.state.invalidateCrossReviewSkips?.(owner, repo, repositoryState.openPullRequests);
    for (const registration of registrations) {
      const pullRequest = repositoryState.openPullRequests.find((candidate) => candidate.number === registration.number);
      if (!pullRequest) continue;
      const candidates = candidatesByNumber.get(registration.number) || [];
      candidatesByNumber.set(registration.number, candidates);
      const collected = [];
      const review = await this.readCrossReviewState(registration, pullRequest, {
        registrations, candidates: collected,
        fileSystem: this.fileSystem, execFileImpl: this.gitExecFileImpl, remoteRepositoryCache, headToolCache, baseAncestorCache,
        mergedCandidates: mergeCommitCandidates(repositoryState.mergedCandidates, this.state.mergeCommitMergedHeads?.(owner, repo)),
        observeReview: (record, result) => {
          const key = `${repositoryKey(owner, repo)}:${record.number}:${record.cwd}`;
          const signature = JSON.stringify(result);
          if (this.diagnosticReviews.get(key) === signature) return;
          this.diagnosticReviews.set(key, signature);
          this.diagnostics?.record(result.failure === 'none' ? 'info' : 'warn', 'merge', 'review.state',
            { repository: safeRepo(owner, repo), number: record.number, session: record.session_id?.slice(0, 8), ...result });
        },
      });
      candidates.push(...(collected.length ? collected : [{ worktree: registration.cwd || '', review }]));
    }
    for (const [number, candidates] of candidatesByNumber) {
      const pullRequest = repositoryState.openPullRequests.find(candidate => candidate.number === number);
      const review = selectCrossReview(candidates, pullRequest.headRefOid);
      reviewByNumber.set(number, reviewPresentation(evaluateReview({ record: review,
        afterConvergence: review?.afterConvergence,
        headSha: pullRequest.headRefOid,
        skip: this.state.crossReviewSkip?.(owner, repo, number),
        deferral: this.state.crossReviewDeferral?.(owner, repo, number),
      })));
    }
    for (const [productKey, group] of productGroups) {
      const assembled = assemblePullRequestStacks({
        ...repositoryState,
        knownRegistrations: registrations,
        defaultBranch: repositoryState.defaultBranch,
        openPullRequests: repositoryState.openPullRequests,
        registrations: group.registrations,
        relatedPullRequests,
        retargetedPrs: this.state.pullRequestRetargetsForRepo(owner, repo),
        restackResults: repositoryState.restackResults,
        liveMergedBranches: repositoryState.liveMergedBranches,
      });
      const condition = this.state.getDisplayPreferences?.().mergeableCondition || 'cross-review';
      const trees = assembled.trees.map((tree) => applyMergeCondition(attachReviewState(
        attachMergeState(tree, group.registrations, owner, repo, this.state),
        reviewByNumber,
      ), condition));
      const identity = `${productKey}\0${key}`;
      createdIdentities.add(identity);
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
        // error はリポジトリ全体の失敗を含むので、このプロダクトのオープンの PR が数えきれていないかは別に持つ。
        openStateUnknown: !repositoryState.listAvailable
          || group.registrations.some((registration) => repositoryState.uninspectedNumbers.has(registration.number)),
        registeredCount: group.registrations.length,
        unregisterableCount: [...registrations, ...relatedPullRequests].filter((record) => record.state === 'unknown').length,
        openCount: assembled.openCount,
        mergeableCount: mergeablePullRequestCount(trees),
        trees,
        merged: assembled.merged,
        mergeHistory: this.state.mergedPullRequestHistoryForRepo(owner, repo, this.now()),
        reservationNotices: this.state.pullRequestMergeReservationNoticesForRepo(owner, repo, this.now()),
        reservations: this.state.pullRequestMergeReservationsForRepo(owner, repo),
        lastMethod: this.state.lastPullRequestMethod(owner, repo),
      });
    }
    this.reviewByRepository.set(key, reviewByNumber);
    removeStaleProductViews(this.productViews, key, createdIdentities);
    this.state.touch();
  }

  inFlightSignature() {
    return JSON.stringify([...this.inFlight.keys()].sort());
  }

  snapshot(deadline) {
    const groups = [...this.productViews.values()].map((group) => {
      const condition = this.state.getDisplayPreferences?.().mergeableCondition || 'cross-review';
      const hiddenPrs = [];
      let hiddenCount = 0;
      const descendantCount = pr => (pr.children || []).reduce((total, child) => total + 1 + descendantCount(child), 0);
      const withVisibility = (pr, inherited = false) => {
        const direct = this.state.isPullRequestHidden(group.owner, group.repo, pr.number);
        const hidden = inherited || direct;
        if (direct) hiddenPrs.push({ number: pr.number, descendants: descendantCount(pr) });
        if (hidden) hiddenCount += 1;
        return { ...pr, hidden, children: pr.children.map(child => withVisibility(child, hidden)) };
      };
      const visibleHeight = pr => pr.hidden ? 0 : 1 + Math.max(0, ...pr.children.map(visibleHeight));
      const withPosition = (pr, depth, total) => ({
        ...pr, stackPosition: { depth, total }, children: pr.children.map(child => withPosition(child, depth + 1, total)),
      });
      const trees = group.trees.map((tree) => withVisibility(applyMergeCondition(
        attachMergeState(tree, [], group.owner, group.repo, this.state), condition,
      ))).map(tree => withPosition(tree, 1, visibleHeight(tree)));
      return {
        ...group,
        product: { ...group.product },
        mergeMethods: [...group.mergeMethods],
        hiddenPrs,
        openCount: Math.max(0, group.openCount - hiddenCount),
        mergeableCount: mergeablePullRequestCount(trees),
        trees: trees.map((tree) => attachStackMergeState(tree, group, this.state)),
        stackMergeResults: this.state.stackMergeResultsForRepo(group.owner, group.repo),
        merged: group.merged.map((pullRequest) => ({
          ...structuredClone(pullRequest), providers: this.state.pullRequestProviders(group.owner, group.repo, pullRequest.number),
        })),
        mergeHistory: this.state.mergedPullRequestHistoryForRepo(group.owner, group.repo, this.now(), deadline),
        reservationNotices: this.state.pullRequestMergeReservationNoticesForRepo(group.owner, group.repo, this.now(), deadline),
        reservations: this.state.pullRequestMergeReservationsForRepo(group.owner, group.repo),
        lastMethod: this.state.lastPullRequestMethod(group.owner, group.repo),
        loading: this.inFlight.has(repoKey(group.owner, group.repo)) && !this.initialFetchCompleted.has(repoKey(group.owner, group.repo)),
      };
    });
    const existing = new Set(groups.map((group) => `${group.product.key || `repo:${repoKey(group.owner, group.repo)}`}\0${repoKey(group.owner, group.repo)}`));
    const registrations = [...this.state.readOnlyPullRequestRegistrations(), ...this.state.relatedPullRequestRegistrations()];
    const pendingGroups = new Map();
    for (const registration of registrations) {
      const key = repoKey(registration.owner, registration.repo);
      if (!this.inFlight.has(key) || this.initialFetchCompleted.has(key)) continue;
      const product = registration.product || { key: `repo:${key}`, name: `${registration.owner}/${registration.repo}` };
      const productKey = product.key || `repo:${key}`;
      const identity = `${productKey}\0${key}`;
      if (existing.has(identity)) continue;
      let group = pendingGroups.get(identity);
      if (!group) {
        group = {
          product: { ...product }, owner: registration.owner, repo: registration.repo,
          defaultBranch: null, mergeMethods: [], autoDeleteBranch: false, checkedAt: null, fetchedAt: null, error: null,
          openStateUnknown: true, registeredCount: 0, openCount: 0, mergeableCount: 0, trees: [], merged: [],
          mergeHistory: this.state.mergedPullRequestHistoryForRepo(registration.owner, registration.repo, this.now(), deadline),
          reservationNotices: this.state.pullRequestMergeReservationNoticesForRepo(registration.owner, registration.repo, this.now(), deadline),
          reservations: this.state.pullRequestMergeReservationsForRepo(registration.owner, registration.repo),
          lastMethod: this.state.lastPullRequestMethod(registration.owner, registration.repo), loading: true,
        };
        pendingGroups.set(identity, group);
      }
      group.registeredCount += 1;
    }
    return [...groups, ...pendingGroups.values()];
  }
}

function stackChain(root) {
  const members = [];
  const seen = new Set();
  for (let pr = root; pr; pr = pr.children[0]) {
    if (pr.children.length > 1 || seen.has(pr.number)) return null;
    seen.add(pr.number);
    members.push(pr);
  }
  return members;
}

function stackMemberBlocker(pr, repository, numbers) {
  if (pr.isCrossRepository) return 'fork からの PR';
  if (pr.staleHead) return 'head が変わっている';
  if (pr.draft) return 'ドラフト';
  if (pr.needsRestack) return '積み直しが必要';
  if (pr.conflict || pr.mergeable === 'CONFLICTING') return 'コンフリクト';
  if (pr.ci === 'fail') return 'CI が失敗';
  if (!['pass', 'pending'].includes(pr.ci)) return 'CI 状態が不明';
  const review = pr.githubReview || pr.review;
  if (review === 'changes') return '変更要求がある';
  if (review === 'required') return 'レビュー承認待ち';
  if (!repository.mergeMethods.includes('merge')) return 'マージコミットが許可されていない';
  if (pr.mergeMethodFixed && pr.mergeMethodFixed !== 'merge') return 'マージ方式が一致しない';
  const code = pr.operationBlockerCode;
  if (code === 'parentOpen' && numbers.has(pr.parentNumber)) return null;
  if (['parentMergePending', 'mergeableUnknown', 'restackCheckUnknown'].includes(code)) return null;
  if (pr.operationBlocker) return pr.operationBlocker;
  return null;
}

/** クロスレビューの条件を満たさないときの待ち理由を返す。満たすなら null。 */
function stackReviewBlocker(pr) {
  const condition = pr.review?.mergeCondition;
  return condition?.met === true ? null : condition?.waitReason || 'クロスレビュー未実施';
}

// 一括マージの対象は、鎖の下からこの理由が無い段が続く範囲に限る。
function stackStageStopReason(pr, repository, numbers, state) {
  const label = `#${pr.number}`;
  if (!state.pullRequestRegistrationByKey(pr.mergeRecordKey)) return `${label} は登録されていない`;
  if (pr.isCrossRepository) return `${label} は fork からの PR`;
  if (pr.conflict || pr.mergeable === 'CONFLICTING') return `${label} のコンフリクト`;
  if (pr.staleHead) return `${label} の head が変わっている`;
  if (pr.draft) return `${label} はドラフト`;
  if (pr.needsRestack) return `${label} は積み直しが必要`;
  if (pr.ci === 'fail') return `${label} の CI が失敗`;
  if (!['pass', 'pending'].includes(pr.ci)) return `${label} の CI 状態が不明`;
  if (pr.githubReview === 'changes') return `${label} に変更要求がある`;
  if (pr.githubReview === 'required') return `${label} のレビュー承認待ち`;
  if (pr.mergeIntent) return `${label} は別のマージ処理中`;
  const reason = stackMemberBlocker(pr, repository, numbers);
  if (reason) return `${label} ${reason}`;
  const review = stackReviewBlocker(pr);
  return review ? `${label} は${review}` : null;
}

// 鎖全体に効く条件。段ごとの条件は stackStageStopReason が見る。
function stackMergeBlockingReason(members, target, repository) {
  const reserved = members.find((pr) => pr.reservation);
  if (reserved) return `#${reserved.number} は${reserved.reservation.kind === 'stack' ? '一括マージ' : '収束後マージ'}を予約中`;
  if (!repository.mergeMethods.includes('merge')) return 'マージコミットが許可されていない';
  if (!repository.defaultBranch || repository.error) return 'リポジトリ設定を取得できません';
  return target.length > STACK_MERGE_LIMIT ? `一括マージは ${STACK_MERGE_LIMIT} 件まで` : null;
}

function attachStackMergeState(root, repository, state) {
  const members = stackChain(root);
  if (!members) return root;
  const numbers = new Set(members.map((pr) => pr.number));
  let stopAt = null;
  let targetSize = 0;
  for (const pr of members) {
    const reason = stackStageStopReason(pr, repository, numbers, state);
    if (reason) {
      stopAt = { number: pr.number, reason };
      break;
    }
    targetSize += 1;
  }
  const target = members.slice(0, targetSize);
  const excluded = members.slice(targetSize).map((pr, index) => ({ number: pr.number, title: pr.title,
    reason: index === 0 ? stopAt.reason : '下の段がマージできないため' }));
  const reservations = state.pullRequestMergeReservationsForRepo(repository.owner, repository.repo);
  const current = members.map((pr) => pr.reservation).find((record) => record?.kind === 'stack');
  const remaining = current ? reservations.filter((record) => record.runId === current.runId).sort((a, b) => a.order - b.order) : [];
  const next = remaining.length ? members.find((pr) => pr.number === remaining[0].number) : null;
  const waitReason = repository.openStateUnknown || !next ? 'PR の状態を確認中'
    : next.mergeable === 'UNKNOWN' ? 'GitHub の計算中'
      : next.operationBlocker || (next.ci === 'pending' ? 'CI 実行中' : 'マージ結果の確認中');
  const blocker = stackMergeBlockingReason(members, target, repository);
  return { ...root, stackMerge: {
    available: target.length >= 2 && !blocker,
    blocker,
    targetBranch: root.mergeTarget,
    total: members.length,
    stopAt,
    excluded,
    members: target.map((pr) => ({ number: pr.number, title: pr.title, headRefOid: pr.headRefOid,
      registration_key: pr.mergeRecordKey,
      status: pr.mergeable === 'UNKNOWN' ? 'GitHub の計算中・待ってからマージ'
        : pr.ci === 'pending' ? 'CI 実行中・待ってからマージ' : 'マージできます' })),
    run: current ? { runId: current.runId, index: remaining[0].order, total: current.total,
      waitReason: `#${remaining[0].number} で ${waitReason}` } : null,
  } };
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
    providers: ['claude', 'codex'].filter((provider) => conflictRegistrations.some((record) => record.provider === provider)),
    conflictRequestKey: conflictRegistrations.length ? state.pullRequestRegistrationKey(conflictRegistrations[0]) : null,
    conflictRequestTargets: conflictRegistrations.map((record) => ({
      sessionId: record.session_id,
      alive: !state.sessionHasEnded(record.session_id),
    })),
    ...(activeConflictRequest ? { conflictRequest: { requestedAt: activeConflictRequest.requestedAt, sessionIds: activeConflictRequest.sessionIds } } : {}),
    reservation: state.pullRequestMergeReservation(owner, repo, pullRequest.number),
    mergeIntent,
    children: pullRequest.children.map((child) => attachMergeState(child, registrations, owner, repo, state)),
  };
}

function attachReviewState(pullRequest, reviewByNumber) {
  const value = {
    ...pullRequest,
    children: pullRequest.children.map((child) => attachReviewState(child, reviewByNumber)),
  };
  value.githubReview = value.review;
  value.review = reviewByNumber.get(pullRequest.number)
    || reviewPresentation(evaluateReview({ headSha: pullRequest.headRefOid }));
  return value;
}

module.exports = {
  GH_TIMEOUT_MS,
  ghFailureKind,
  productGroupsFor,
  selectPullRequestsToInspect,
  classifyInspectedPullRequest,
  stackedPullRequestsForMerge,
  interpretFetchResults,
  parseCompareResult,
  restackResult,
  historicalMergedPullRequests,
  mergedPullRequestCandidates,
  restackCompareBase,
  evaluateRestack,
  PullRequestTracker,
  assemblePullRequestStacks,
  stackChain,
  stackMemberBlocker,
  stackReviewBlocker,
  STACK_MERGE_LIMIT,
  ghEnvironment,
  ghErrorMessage,
  repoKey,
  safeRepo,
  normalizeOpenPullRequest,
  parsePullRequestList,
  parseRepositoryConfig,
  crossReviewToolExists,
  readCrossReviewState,
  readCrossReviewStateAcrossWorktrees,
  matchingRepositoryCheckout,
  listWorktrees,
  gitRemotes,
  runGh,
};
