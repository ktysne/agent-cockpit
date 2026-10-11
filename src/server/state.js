const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { recommendedOptionFor, sanitizeEvent } = require('./events');
const { AtomicJsonWriter, atomicWriteJson } = require('./json-storage');
const { isCompleteCommitSha, isSha256Digest, parsePullRequestUrl, pullRequestKey, repositoryKey, validBranchName, validRepositoryPart } = require('./pull-request-utils');
const { cloneDisplay, defaultDisplay, normalizeDisplay } = require('./display-preferences');
const { isStoredSessionId } = require('./session-ids');
const { isRecord } = require('./value-utils');

const DEFAULT_AWAY_STATE = Object.freeze({ enabled: false, since: null, periods: Object.freeze([]) });
const SESSION_FILE_ABSENCE_END_MS = 60_000;
const TRANSIENT_NOTICE_MS = 60_000;
const STORE_WRITE_DELAY_MS = 500;
const STORE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_AWAY_PERIODS = 50;
const RESTORE_SESSION_CLEANUP_GRACE_MS = 10 * 60 * 1000;
const MERGED_PULL_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;
const PULL_REQUEST_MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);
const pullRequestRecordKey = pullRequestKey;
const relatedPullRequestRecordKey = pullRequestKey;
const pullRequestRepositoryKey = repositoryKey;

function validProduct(value) {
  return isRecord(value) && typeof value.key === 'string' && value.key.trim().length > 0 && value.key.length <= 500 &&
    typeof value.name === 'string' && value.name.length > 0 && value.name.length <= 200;
}

function cloneProduct(product) {
  return validProduct(product) ? { key: product.key, name: product.name } : null;
}

function repoProduct(owner, repo) {
  return { key: `repo:${owner}/${repo}`, name: `${owner}/${repo}` };
}

function validStoredSessionId(value) {
  return isStoredSessionId(value);
}

function validTimestamp(value, nullable = false) {
  return (nullable && value === null) || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function validStoredPlan(plan) {
  return isRecord(plan) && Array.isArray(plan.tasks) && validTimestamp(plan.tasksUpdatedAt, true) &&
    (plan.product === undefined || plan.product === null || validProduct(plan.product)) &&
    plan.tasks.every((task) => isRecord(task) && typeof task.title === 'string' && task.title.length <= 200 &&
      ['todo', 'doing', 'done'].includes(task.state) && Array.isArray(task.criteria) &&
      task.criteria.every((item) => isRecord(item) && typeof item.text === 'string' && typeof item.met === 'boolean') &&
      (task.completedAt === undefined || validTimestamp(task.completedAt))) &&
    Array.isArray(plan.decisions) && plan.decisions.every((decision) => isRecord(decision) &&
      typeof decision.id === 'string' && typeof decision.title === 'string' && typeof decision.state === 'string' &&
      Array.isArray(decision.questions) && decision.questions.every((question) => isRecord(question) && Array.isArray(question.options)) &&
      validTimestamp(decision.createdAt) && validTimestamp(decision.updatedAt) &&
      (decision.provisionalAt === undefined || validTimestamp(decision.provisionalAt)) &&
      (decision.finishedByToolUseId === undefined || typeof decision.finishedByToolUseId === 'string') &&
      (decision.inferredWithdrawalHookAt === undefined || Number.isFinite(decision.inferredWithdrawalHookAt)));
}

function pullRequestRegistrationKey(record) {
  return crypto.createHash('sha256')
    .update([record.session_id, record.owner.toLowerCase(), record.repo.toLowerCase(), record.number, record.addedAt].join('\0'))
    .digest('hex');
}

function validCrossReviewSkip(record) {
  return isRecord(record) && validRepositoryPart(record.owner) && validRepositoryPart(record.repo) &&
    Number.isSafeInteger(record.number) && record.number > 0 &&
    isCompleteCommitSha(record.headRefOid) &&
    typeof record.reason === 'string' && record.reason.trim().length > 0 && record.reason.length <= 2000 &&
    validTimestamp(record.recordedAt);
}

function normalizeCrossReviewSkip(record) {
  return {
    owner: record.owner,
    repo: record.repo,
    number: record.number,
    headRefOid: record.headRefOid.toLowerCase(),
    reason: record.reason,
    recordedAt: record.recordedAt,
  };
}

function validPullRequestLastOpen(value) {
  if (value === null) return true;
  if (!isRecord(value) ||
    ['title', 'url', 'headRefName', 'baseRefName'].some((key) => typeof value[key] !== 'string') ||
    ['title', 'headRefName', 'baseRefName'].some((key) => value[key].length > 500) ||
    (value.headRefOid !== '' && !isCompleteCommitSha(value.headRefOid))) return false;
  return true;
}

function validMergedPullRequestHead(value) {
  return isRecord(value) && isCompleteCommitSha(value.headRefOid) &&
    validBranchName(value.headRefName) && validBranchName(value.baseRefName) &&
    (value.branchKept === undefined || typeof value.branchKept === 'boolean');
}

function normalizeMergedPullRequestHead(value) {
  if (!validMergedPullRequestHead(value)) return null;
  return {
    headRefOid: value.headRefOid.toLowerCase(),
    headRefName: value.headRefName,
    baseRefName: value.baseRefName,
    ...(value.branchKept !== undefined ? { branchKept: value.branchKept } : {}),
  };
}

function normalizePullRequestLastOpen(value) {
  if (!value) return null;
  const normalized = { ...value };
  delete normalized.basePullRequestNumber;
  delete normalized.basePullRequestHeadRefOid;
  delete normalized.restackParents;
  return normalized;
}

function validPullRequestRecord(record) {
  if (!isRecord(record) || !validStoredSessionId(record.session_id) ||
    !validRepositoryPart(record.owner) || !validRepositoryPart(record.repo) ||
    !Number.isSafeInteger(record.number) || record.number < 1 ||
    !validTimestamp(record.addedAt) ||
    (record.cwd !== null && (typeof record.cwd !== 'string' || record.cwd.length > 4096)) ||
    (record.product !== null && (!isRecord(record.product) || typeof record.product.key !== 'string' ||
      record.product.key.length > 500 || typeof record.product.name !== 'string' || record.product.name.length > 200)) ||
    ![null, 'unknown', 'open', 'merged', 'closed'].includes(record.state) ||
    (record.mergedAt !== null && !validTimestamp(record.mergedAt)) ||
    (record.mergedHead !== undefined && !validMergedPullRequestHead(record.mergedHead))) return false;
  const parsedUrl = parsePullRequestUrl(record.url);
  if (!parsedUrl || parsedUrl.owner !== record.owner || parsedUrl.repo !== record.repo || parsedUrl.number !== record.number) return false;
  if (!validPullRequestLastOpen(record.lastOpen)) return false;
  return true;
}

function normalizePullRequestRecord(record) {
  const mergedHead = normalizeMergedPullRequestHead(record.mergedHead);
  return {
    session_id: record.session_id,
    owner: record.owner,
    repo: record.repo,
    number: record.number,
    url: record.url,
    addedAt: record.addedAt,
    cwd: record.cwd || null,
    product: record.product ? { key: record.product.key, name: record.product.name } : null,
    state: record.state || 'unknown',
    mergedAt: record.mergedAt || null,
    lastOpen: normalizePullRequestLastOpen(record.lastOpen),
    ...(mergedHead ? { mergedHead } : {}),
  };
}

function validRelatedPullRequestRecord(record) {
  if (!isRecord(record) || !validRepositoryPart(record.owner) || !validRepositoryPart(record.repo) ||
    !Number.isSafeInteger(record.number) || record.number < 1 || !validTimestamp(record.addedAt) ||
    ![null, 'unknown', 'open', 'merged', 'closed'].includes(record.state) ||
    (record.mergedAt !== null && !validTimestamp(record.mergedAt)) ||
    (record.mergedHead !== undefined && !validMergedPullRequestHead(record.mergedHead))) return false;
  const parsedUrl = parsePullRequestUrl(record.url);
  return Boolean(parsedUrl && parsedUrl.owner === record.owner && parsedUrl.repo === record.repo &&
    parsedUrl.number === record.number && validPullRequestLastOpen(record.lastOpen));
}

function normalizeRelatedPullRequestRecord(record) {
  const mergedHead = normalizeMergedPullRequestHead(record.mergedHead);
  return {
    owner: record.owner,
    repo: record.repo,
    number: record.number,
    url: record.url,
    addedAt: record.addedAt,
    state: record.state || 'unknown',
    mergedAt: record.mergedAt || null,
    lastOpen: normalizePullRequestLastOpen(record.lastOpen),
    ...(mergedHead ? { mergedHead } : {}),
  };
}

function validPullRequestRetarget(record) {
  return isRecord(record) && validRepositoryPart(record.owner) && validRepositoryPart(record.repo) &&
    Number.isSafeInteger(record.number) && record.number > 0 && typeof record.base === 'string' && record.base.length <= 500 &&
    (record.fromNumber === null || record.fromNumber === undefined || (Number.isSafeInteger(record.fromNumber) && record.fromNumber > 0)) &&
    (record.previousBaseRefName === undefined || validBranchName(record.previousBaseRefName));
}

function validMergedPullRequest(record) {
  if (!isRecord(record) || !validRepositoryPart(record.owner) || !validRepositoryPart(record.repo) ||
    !Number.isSafeInteger(record.number) || record.number < 1 || typeof record.title !== 'string' || record.title.length > 500 ||
    !validTimestamp(record.mergedAt) || ![null, 'merge', 'squash', 'rebase'].includes(record.method) ||
    typeof record.automatic !== 'boolean' || typeof record.url !== 'string' ||
    (record.reservedHeadRefOid !== undefined && record.reservedHeadRefOid !== null && !isCompleteCommitSha(record.reservedHeadRefOid)) ||
    (record.mergedHeadRefOid !== undefined && record.mergedHeadRefOid !== null && !isCompleteCommitSha(record.mergedHeadRefOid)) ||
    (record.headMismatch !== undefined && typeof record.headMismatch !== 'boolean') ||
    (record.mergeResultClosedAt !== undefined && !validTimestamp(record.mergeResultClosedAt)) ||
    (record.historyDismissedAt !== undefined && !validTimestamp(record.historyDismissedAt)) ||
    (record.automaticResult !== undefined && !validPullRequestMergeResult(record.automaticResult))) return false;
  const parsedUrl = parsePullRequestUrl(record.url);
  return Boolean(parsedUrl && parsedUrl.owner === record.owner && parsedUrl.repo === record.repo && parsedUrl.number === record.number);
}

function validPullRequestMergeResult(value) {
  return isRecord(value) && typeof value.branchDeleted === 'boolean' && typeof value.autoDeleteBranch === 'boolean' &&
    (value.retargetedBase === null || validBranchName(value.retargetedBase)) &&
    Array.isArray(value.retargetedNumbers) && value.retargetedNumbers.length <= 100 &&
    value.retargetedNumbers.every((number) => Number.isSafeInteger(number) && number > 0) &&
    (value.warning === null || (typeof value.warning === 'string' && value.warning.length <= 5000));
}

function validPullRequestMergeReservation(record) {
  const parsedUrl = parsePullRequestUrl(record?.url);
  const allowedKeys = new Set(['session_id', 'owner', 'repo', 'number', 'url', 'method', 'deleteBranch', 'createdAt', 'targetBranch']);
  return isRecord(record) && validStoredSessionId(record.session_id) && validRepositoryPart(record.owner) && validRepositoryPart(record.repo) &&
    Object.keys(record).every((key) => allowedKeys.has(key)) &&
    Number.isSafeInteger(record.number) && record.number > 0 && PULL_REQUEST_MERGE_METHODS.has(record.method) &&
    (record.targetBranch === undefined || validBranchName(record.targetBranch)) &&
    typeof record.deleteBranch === 'boolean' && validTimestamp(record.createdAt) && typeof record.url === 'string' &&
    Boolean(parsedUrl && parsedUrl.owner === record.owner && parsedUrl.repo === record.repo && parsedUrl.number === record.number);
}

function validPullRequestMergeIntent(record) {
  const parsedUrl = parsePullRequestUrl(record?.url);
  return isRecord(record) && validStoredSessionId(record.session_id) && validRepositoryPart(record.owner) && validRepositoryPart(record.repo) &&
    Number.isSafeInteger(record.number) && record.number > 0 && isCompleteCommitSha(record.headRefOid) &&
    PULL_REQUEST_MERGE_METHODS.has(record.method) && typeof record.deleteBranch === 'boolean' && validTimestamp(record.createdAt) &&
    (record.automatic === undefined || typeof record.automatic === 'boolean') &&
    (record.targetBranch === undefined || validBranchName(record.targetBranch)) &&
    validBranchName(record.headRefName) && validBranchName(record.defaultBranch) && typeof record.url === 'string' &&
    Boolean(parsedUrl && parsedUrl.owner === record.owner && parsedUrl.repo === record.repo && parsedUrl.number === record.number) &&
    Array.isArray(record.stackedPullRequests) && record.stackedPullRequests.length <= 100 &&
    record.stackedPullRequests.every((item) => isRecord(item) && Number.isSafeInteger(item.number) && item.number > 0 && validBranchName(item.baseRefName));
}

function normalizeStore(value) {
  if (!isRecord(value) || !Number.isInteger(value.version)) throw new Error('Invalid store version');
  if (value.version > 1) throw Object.assign(new Error('Store version is newer'), { newerVersion: true });
  if (value.version !== 1 || !['display', 'plans', 'decisionLifecycles', 'closedTasks', 'hiddenSessions'].every((key) => Object.hasOwn(value, key))) {
    throw new Error('Invalid store format');
  }
  const display = normalizeDisplay(value.display);
  if (!isRecord(value.plans) || !isRecord(value.decisionLifecycles) || !Array.isArray(value.closedTasks) || !Array.isArray(value.hiddenSessions)) {
    throw new Error('Invalid store format');
  }
  const plans = new Map();
  for (const [sessionId, plan] of Object.entries(value.plans)) {
    if (!validStoredSessionId(sessionId) || !validStoredPlan(plan)) throw new Error('Invalid stored plan');
    plans.set(sessionId, {
      tasks: plan.tasks.map((task) => ({
        title: task.title,
        state: task.state,
        criteria: task.criteria.map((item) => ({ text: item.text, met: item.met })),
        ...(task.completedAt ? { completedAt: task.completedAt } : {}),
      })),
      tasksUpdatedAt: plan.tasksUpdatedAt,
      product: cloneProduct(plan.product),
      decisions: plan.decisions.map(cloneDecision),
    });
  }
  const askDecisionBindingsValue = value.askDecisionBindings === undefined ? {} : value.askDecisionBindings;
  if (!isRecord(askDecisionBindingsValue)) throw new Error('Invalid ask decision bindings');
  const askDecisionBindings = new Map();
  for (const [sessionId, bindings] of Object.entries(askDecisionBindingsValue)) {
    if (!validStoredSessionId(sessionId) || !isRecord(bindings)) throw new Error('Invalid ask decision bindings');
    const askDecisionIds = new Set((plans.get(sessionId)?.decisions || [])
      .filter((decision) => decision.source === 'ask').map((decision) => decision.id));
    const normalizedBindings = new Map();
    for (const [toolUseId, decisionId] of Object.entries(bindings)) {
      if (!toolUseId || toolUseId.length > 256 || typeof decisionId !== 'string' ||
        decisionId.length > 256 || !askDecisionIds.has(decisionId)) {
        throw new Error('Invalid ask decision bindings');
      }
      normalizedBindings.set(toolUseId, decisionId);
    }
    if (normalizedBindings.size) askDecisionBindings.set(sessionId, normalizedBindings);
  }
  const decisionLifecycles = new Map();
  for (const [sessionId, records] of Object.entries(value.decisionLifecycles)) {
    if (!validStoredSessionId(sessionId) || !isRecord(records)) throw new Error('Invalid decision lifecycle');
    const lifecycles = new Map();
    for (const [decisionId, lifecycle] of Object.entries(records)) {
      if (!isRecord(lifecycle) || (lifecycle.answer !== null && !isRecord(lifecycle.answer)) ||
        (lifecycle.state !== null && typeof lifecycle.state !== 'string') ||
        (lifecycle.awaitingAnswerUntil != null && !validTimestamp(lifecycle.awaitingAnswerUntil)) ||
        (lifecycle.updatedAt !== undefined && lifecycle.updatedAt !== null && !validTimestamp(lifecycle.updatedAt))) {
        throw new Error('Invalid decision lifecycle');
      }
      const legacyAnswer = lifecycle.answer?.choice === 'hold';
      const storedDecisionState = plans.get(sessionId)?.decisions.find((decision) => decision.id === decisionId)?.state;
      const legacyPendingDecision = legacyAnswer && ['waiting', 'provisional'].includes(lifecycle.state ?? storedDecisionState);
      lifecycles.set(decisionId, {
        answer: lifecycle.answer && !legacyAnswer ? { ...lifecycle.answer } : null,
        state: legacyPendingDecision ? 'provisional' : lifecycle.state ?? null,
        updatedAt: lifecycle.updatedAt ?? null,
        ...(validTimestamp(lifecycle.provisionalAt) ? { provisionalAt: lifecycle.provisionalAt } : {}),
        ...(validTimestamp(lifecycle.awaitingAnswerUntil) ? { awaitingAnswerUntil: lifecycle.awaitingAnswerUntil } : {}),
      });
    }
    decisionLifecycles.set(sessionId, lifecycles);
  }
  const closedTasks = [];
  for (const record of value.closedTasks) {
    if (!isRecord(record) || !validStoredSessionId(record.session_id) || typeof record.title !== 'string' ||
      !['todo', 'doing'].includes(record.stateAtClose) ||
      (record.closedAt !== undefined && !validTimestamp(record.closedAt))) throw new Error('Invalid closed task');
    closedTasks.push({
      session_id: record.session_id,
      title: record.title,
      stateAtClose: record.stateAtClose,
      ...(record.closedAt ? { closedAt: record.closedAt } : {}),
    });
  }
  const hiddenSessions = [];
  for (const record of value.hiddenSessions) {
    if (!isRecord(record) || !validStoredSessionId(record.session_id) || !validTimestamp(record.updatedAt)) {
      throw new Error('Invalid hidden session');
    }
    hiddenSessions.push({ session_id: record.session_id, updatedAt: record.updatedAt });
  }
  const prs = value.prs === undefined ? [] : value.prs;
  const deletedSessions = new Map();
  if (value.deletedSessions !== undefined && !isRecord(value.deletedSessions)) throw new Error('Invalid deleted sessions');
  for (const [sessionId, deletedAt] of Object.entries(value.deletedSessions || {})) {
    if (!validStoredSessionId(sessionId) || !validTimestamp(deletedAt)) throw new Error('Invalid deleted session');
    deletedSessions.set(sessionId, deletedAt);
  }
  const relatedPrs = value.relatedPrs === undefined ? [] : value.relatedPrs;
  const retargetedPrs = value.retargetedPrs === undefined ? [] : value.retargetedPrs;
  const mergedPrs = value.mergedPrs === undefined ? [] : value.mergedPrs;
  const mergeReservations = Array.isArray(value.mergeReservations) ? value.mergeReservations.filter(validPullRequestMergeReservation) : [];
  const mergeIntents = value.mergeIntents === undefined ? [] : value.mergeIntents;
  const lastPullRequestMethods = value.lastPullRequestMethods === undefined ? {} : value.lastPullRequestMethods;
  const seenAtByProduct = value.seenAtByProduct === undefined ? {} : value.seenAtByProduct;
  const ciFailures = value.ciFailures === undefined ? [] : value.ciFailures;
  const crossReviewSkips = value.crossReviewSkips === undefined ? [] : value.crossReviewSkips;
  if (!Array.isArray(prs) || !prs.every(validPullRequestRecord) ||
    !Array.isArray(relatedPrs) || !relatedPrs.every(validRelatedPullRequestRecord) ||
    !Array.isArray(retargetedPrs) || !retargetedPrs.every(validPullRequestRetarget) ||
    !Array.isArray(mergedPrs) || !mergedPrs.every(validMergedPullRequest) ||
    !Array.isArray(mergeIntents) || !mergeIntents.every(validPullRequestMergeIntent) ||
    !isRecord(lastPullRequestMethods) || Object.entries(lastPullRequestMethods).some(([key, method]) => {
      const [owner, repo, extra] = key.split('/');
      return extra !== undefined || !validRepositoryPart(owner) || !validRepositoryPart(repo) || !PULL_REQUEST_MERGE_METHODS.has(method);
    }) ||
    !isRecord(seenAtByProduct) || Object.entries(seenAtByProduct).some(([key, timestamp]) => (
      key.trim().length === 0 || key.length > 500 || !validTimestamp(timestamp)
    )) ||
    !Array.isArray(ciFailures) || !ciFailures.every((record) => isRecord(record) &&
      validRepositoryPart(record.owner) && validRepositoryPart(record.repo) && Number.isSafeInteger(record.number) && record.number > 0 &&
      validProduct(record.product) && validTimestamp(record.at)) ||
    !Array.isArray(crossReviewSkips) || !crossReviewSkips.every(validCrossReviewSkip)) {
    throw new Error('Invalid pull request records');
  }
  return {
    display,
    plans,
    askDecisionBindings,
    decisionLifecycles,
    closedTasks,
    hiddenSessions,
    deletedSessions,
    prs: prs.map(normalizePullRequestRecord),
    relatedPrs: relatedPrs.map(normalizeRelatedPullRequestRecord),
    retargetedPrs: retargetedPrs.map((record) => ({ ...record })),
    mergedPrs: mergedPrs.map((record) => ({ ...record })),
    mergeReservations: mergeReservations.map((record) => ({ ...record })),
    mergeIntents: mergeIntents.map((record) => ({
      ...record,
      stackedPullRequests: record.stackedPullRequests.map((item) => ({ ...item })),
    })),
    lastPullRequestMethods: new Map(Object.entries(lastPullRequestMethods)),
    seenAtByProduct: new Map(Object.entries(seenAtByProduct)),
    ciFailures: ciFailures.map((record) => ({ ...record, product: cloneProduct(record.product) })),
    crossReviewSkips: crossReviewSkips.map(normalizeCrossReviewSkip),
  };
}

async function atomicWriteAwayState(homeDir, value, fileSystem = fs, writer = null) {
  if (writer) return writer.write('away.json', value);
  return atomicWriteJson(homeDir, 'away.json', value, fileSystem);
}

function normalizeAwayState(value) {
  if (!isRecord(value) || typeof value.enabled !== 'boolean' ||
    !((value.enabled && Number.isFinite(value.since) && value.since >= 0) || (!value.enabled && value.since === null)) ||
    !Number.isFinite(new Date(value.since).getTime())) return null;

  // 旧形式と、期間の記録が食い違うものは、離席中なら since から現在まで続く期間だけとして読む。
  // 期間が壊れていても、離席中かどうかの記録は保つ。
  const sinceOnly = value.enabled ? [{ start: value.since, end: null }] : [];
  let periods = sinceOnly;
  if (Array.isArray(value.periods) && value.periods.every((period) => isRecord(period) &&
    Number.isFinite(period.start) && period.start >= 0 &&
    (period.end === null || (Number.isFinite(period.end) && period.end >= period.start)))) {
    const candidate = value.periods.map(({ start, end }) => ({ start, end }));
    const openIndexes = candidate.flatMap((period, index) => period.end === null ? [index] : []);
    const activePeriod = candidate.at(-1);
    const consistent = value.enabled
      ? openIndexes.length === 0
        ? !activePeriod || activePeriod.end <= value.since
        : openIndexes.length === 1 && openIndexes[0] === candidate.length - 1 && activePeriod.start === value.since
      : openIndexes.length === 0;
    if (consistent) {
      periods = candidate;
      if (value.enabled && activePeriod?.end !== null) periods.push({ start: value.since, end: null });
    }
  }

  return { enabled: value.enabled, since: value.since, periods: periods.slice(-MAX_AWAY_PERIODS) };
}

function retainedAwayPeriods(periods, seenAtValues = [], now = Date.now()) {
  const retentionOrigin = now - STORE_RETENTION_MS;
  const seenTimes = [...seenAtValues].map((at) => typeof at === 'number' ? at : Date.parse(at)).filter(Number.isFinite);
  return periods.filter((period) => {
    if (period.end === null) return true;
    if (period.end < retentionOrigin) return false;
    return !seenTimes.length || !seenTimes.every((seenAt) => period.end <= seenAt);
  }).slice(-MAX_AWAY_PERIODS);
}

class AwayState {
  constructor(homeDir, value = DEFAULT_AWAY_STATE, fileSystem = fs, writer = null) {
    this.homeDir = homeDir;
    this.value = normalizeAwayState(value) || { ...DEFAULT_AWAY_STATE, periods: [] };
    this.fileSystem = fileSystem;
    this.writer = writer;
    this.pending = Promise.resolve();
  }

  static async load(homeDir, fileSystem = fs, writer = null) {
    try {
      const value = JSON.parse(await fileSystem.readFile(path.join(homeDir, 'away.json'), 'utf8'));
      const normalized = normalizeAwayState(value);
      if (normalized) {
        const away = new AwayState(homeDir, normalized, fileSystem, writer);
        if (JSON.stringify(value) !== JSON.stringify(away.value)) await away.persistCurrent();
        await away.prune([], Date.now());
        return away;
      }
    } catch {
    }
    return new AwayState(homeDir, DEFAULT_AWAY_STATE, fileSystem, writer);
  }

  snapshot() {
    return { ...this.value, periods: this.value.periods.map((period) => ({ ...period })) };
  }

  // 画面とトレイから同時に切り替えても、保存の順と this.value の順が食い違わないよう直列にする。
  setEnabled(enabled, now) {
    const run = this.pending.then(() => this.applyEnabled(enabled, now ?? Date.now()));
    this.pending = run.catch(() => {});
    return run;
  }

  async applyEnabled(enabled, now) {
    const periods = [...this.value.periods];
    if (enabled && !this.value.enabled) periods.push({ start: now, end: null });
    if (!enabled && this.value.enabled) {
      const activePeriod = periods.at(-1);
      if (activePeriod?.end === null) activePeriod.end = Math.max(now, activePeriod.start);
    }
    const next = {
      enabled,
      since: enabled ? (this.value.enabled ? this.value.since : now) : null,
      periods: retainedAwayPeriods(periods, [], now),
    };
    this.value = next;
    await atomicWriteAwayState(this.homeDir, next, this.fileSystem, this.writer).catch(() => {});
    return this.snapshot();
  }

  persistCurrent() {
    const run = this.pending.then(async () => {
      await atomicWriteAwayState(this.homeDir, this.value, this.fileSystem, this.writer).catch(() => {});
      return this.snapshot();
    });
    this.pending = run.catch(() => {});
    return run;
  }

  prune(seenAtValues, now = Date.now()) {
    const run = this.pending.then(async () => {
      const periods = retainedAwayPeriods(this.value.periods, seenAtValues, now);
      if (periods.length === this.value.periods.length) return this.snapshot();
      this.value = { ...this.value, periods };
      await atomicWriteAwayState(this.homeDir, this.value, this.fileSystem, this.writer).catch(() => {});
      return this.snapshot();
    });
    this.pending = run.catch(() => {});
    return run;
  }

  attachWriter(writer) {
    this.writer = writer;
  }

  async flushPersistence() {
    await this.pending;
    if (this.writer) await this.writer.flush();
  }
}

function isoTime(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function agentFor(session, agentId) {
  if (!agentId) return null;
  return session.agents.find((agent) => agent.agent_id === agentId) || null;
}

// 非対話の claude -p は kind が interactive 以外になる。kind が無い、空、または文字列でないファイルは対話として扱う。
function isNonInteractiveSessionFile(file) {
  return typeof file?.kind === 'string' && file.kind.trim() !== '' && file.kind !== 'interactive';
}

function claudeModelName(modelId) {
  if (typeof modelId !== 'string' || !modelId) return '';
  const id = modelId.replace(/\[[^\]]*\]$/, '');
  const modern = id.match(/^claude-([a-z]+)-(\d+)-(\d+)(?:-\d{8})?$/i);
  const legacy = id.match(/^claude-(\d+)-(\d+)-([a-z]+)(?:-\d{8})?$/i);
  const match = modern
    ? { family: modern[1], major: modern[2], minor: modern[3] }
    : legacy
      ? { family: legacy[3], major: legacy[1], minor: legacy[2] }
      : null;
  if (match) return `${match.family[0].toUpperCase()}${match.family.slice(1)} ${match.major}.${match.minor}`;
  const readable = id.replace(/^claude-/i, '').replace(/[-_]+/g, ' ').trim();
  return readable ? `${readable[0].toUpperCase()}${readable.slice(1)}` : modelId;
}

function agentModelFromDefinition(agentType, definition) {
  return {
    agent_id: agentType,
    agent_type: agentType || 'サブエージェント',
    startedAt: null,
    description: '',
    lastTool: null,
    model: definition?.model || '',
    effort: definition?.effort || '',
    source: definition?.source || '',
    active: true,
  };
}

/** @typedef {{tool_use_id: string, tool_name: string, summary: string, description: string, agent_id: string|null, startedAt: string}} SessionTool */

/** @typedef {{agent_id: string|null, target_tool_use_id: string|null, tool_name: string, summary: string, notification_type: string, message: string, startedAt: string}} PermissionWait */

/** @typedef {ReturnType<typeof agentModelFromDefinition> & {
 * agent_id: string, startedAt: string|null, isCodex?: boolean, parent_agent_id?: string|null, runId?: string, backgroundTaskId?: string, backgrounded?: boolean, unconfirmed?: boolean, resultReceived?: boolean, waitEnded?: boolean, route?: string, codex_home?: string, unavailable?: string
 * }} SessionAgent */

/** @typedef {{session_id: string, provider: 'claude'|'codex', codex?: {model: string, resumes: number}, product: string, title: string, status: string, lastActivityAt?: string, stopped: boolean, turnKnown: boolean, ended: boolean}} SessionIdentity */

/** @typedef {{tools: SessionTool[], completedToolIds: Set<string>, agentToolBindings: Object<string, string|symbol|null>}} SessionTools */

/** @typedef {{agents: SessionAgent[], stoppedAgentIds: Set<string>}} SessionAgents */

/** @typedef {{pendingCodex: Object<string, string>, pendingCodexWait: Object<string, boolean>, codexLaunchToolIds: Set<string>}} SessionCodex */

/** @typedef {{decisions: Array<ReturnType<typeof cloneDecision>>, decisionBindings: Object<string, string>}} SessionDecisions */

/** @typedef {{permissionWaits: PermissionWait[]}} SessionPermissions */

/** @typedef {SessionIdentity & SessionTools & SessionAgents & SessionCodex & SessionDecisions & SessionPermissions} DerivedSession */

/** @typedef {{decisions?: Array<ReturnType<typeof cloneDecision>>, bindings?: Object<string, string>, finishedOutsideEventsIds?: string[]}} AskDecisionState */

/** @returns {DerivedSession} */
function newSession(event, askDecisionState = {}) {
  return {
    session_id: event.session_id,
    provider: event.provider,
    ...(event.provider === 'codex' ? { codex: { model: '', resumes: 0 } } : {}),
    product: event.product,
    title: event.sessionName,
    status: '不明',
    tools: [],
    completedToolIds: new Set(),
    stoppedAgentIds: new Set(),
    codexLaunchToolIds: new Set(),
    agents: [],
    permissionWaits: [],
    decisions: (askDecisionState.decisions || []).map(cloneDecision),
    decisionBindings: Object.assign(Object.create(null), askDecisionState.bindings || {}),
    stopped: false,
    turnKnown: false,
    ended: false,
    pendingCodex: Object.create(null),
    pendingCodexWait: Object.create(null),
    agentToolBindings: Object.create(null),
  };
}

const IDLE_START_SOURCES = new Set(['startup', 'resume', 'clear']);

const AMBIGUOUS_AGENT_CALL = Symbol('ambiguous agent call');

function unboundAgentCallsOf(session) {
  return session.tools.filter((tool) => (
    tool.tool_name === 'Agent' && !tool.agent_id && session.agentToolBindings[tool.tool_use_id] === null
  ));
}

function sameAgent(left, right) {
  return (left || null) === (right || null);
}

function isClosableAgent(agent) {
  return (!agent.active && agent.unconfirmed)
    || (!agent.isCodex && agent.backgrounded && agent.active)
    || (agent.isCodex && agent.backgrounded && !agent.parent_agent_id && agent.active);
}

function sameQuestionSet(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
  return left.every((question, index) => question.question === right[index]?.question);
}

function deactivateBackgroundedCodex(session, parentAgentId) {
  for (const agent of session.agents) {
    if (agent.backgrounded && agent.active && sameAgent(agent.parent_agent_id, parentAgentId)) {
      agent.active = false;
      agent.unconfirmed = true;
    }
  }
}

function stopAgent(session, agentId, stoppedAgentIds) {
  const agent = agentFor(session, agentId);
  if (agent) {
    agent.active = false;
    agent.unconfirmed = false;
  }
  stoppedAgentIds.add(agentId);
  deactivateBackgroundedCodex(session, agentId);
  session.tools = session.tools.filter((tool) => tool.agent_id !== agentId);
  session.permissionWaits = session.permissionWaits.filter((wait) => wait.agent_id !== agentId);
}

// 実行 ID で直接特定できない結果行は、条件に合う行が一つの場合だけ割り当てる。
// --wait の状態行で終了未確認になった行は、ラッパーが消えて結果行が届かないので候補にしない。
function uniqueBackgroundedCodex(session, parentAgentId, runId = null) {
  const candidates = session.agents.filter((agent) => (
    agent.isCodex && agent.backgrounded && !agent.waitEnded && (agent.active || agent.unconfirmed) &&
    sameAgent(agent.parent_agent_id, parentAgentId) && (!agent.runId || agent.runId === runId)
  ));
  return candidates.length === 1 ? candidates[0] : null;
}

function applyCodexAudit(agent, event) {
  if (!event.codexAudit) return;
  agent.model = event.codexAudit.model || agent.model;
  agent.effort = event.codexAudit.effort || agent.effort;
  agent.codex_home = event.codexAudit.codex_home || agent.codex_home || '';
}

// 監査行は Codex の起動前に出るので、終わったと判定するのは結果行を受けたときだけにする。
function completeCodexAgent(agent, event) {
  applyCodexAudit(agent, event);
  const result = event.codexResult;
  if (result?.status === 'rate-limited') agent.unavailable = '利用上限';
  // exit=3 は GPT 側が未導入か無効で、Codex を起動していない。
  if (result?.status === 'unavailable' || (result?.status === 'failed' && result.exitCode === 3)) agent.unavailable = '使用不能';
  agent.active = false;
  agent.unconfirmed = false;
  agent.resultReceived = true;
}

// --wait で続きに戻った古い行も札に出すため、稼働中の行を優先する。
function latestCodexForParent(agents, parentAgentId) {
  return agents
    .filter((agent) => agent.isCodex && sameAgent(agent.parent_agent_id, parentAgentId))
    .sort((left, right) => (
      Number(left.active === true) - Number(right.active === true) || Date.parse(left.startedAt) - Date.parse(right.startedAt)
    ))
    .at(-1);
}

// 結果無しで失敗した起動は続きが無いので、背景へ移った行(終了未確認を含む)だけを候補にする。
// 実行 ID が分かっていて別の値の行は、別の実行なので候補にしない。
function latestWaitableCodex(session, parentAgentId, definition, runId) {
  return session.agents
    .filter((agent) => (
      agent.isCodex && agent.agent_type === definition && agent.backgrounded === true && !agent.resultReceived &&
      sameAgent(agent.parent_agent_id, parentAgentId) && (!agent.runId || agent.runId === runId)
    ))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0] || null;
}

function isFinishedAskDecision(decision) {
  return ['resolved', 'withdrawn'].includes(decision?.state);
}

/** @param {AskDecisionState} askDecisionState */
function initialAskDecisionsFor(entries, askDecisionState, beforeSequence) {
  // 判断事項ごとに、メモリーにある終わりのイベントの最も新しい時刻。出し直した呼び出しの終わりも数える。
  // 開始がメモリーに無い呼び出しの終わりは、作り直しで再現できないので数えない。
  const startedAskToolUseIds = new Set(entries.flatMap(({ event }) => (
    event.hook_event_name === 'PreToolUse' && event.tool_name === 'AskUserQuestion' && !event.agent_id && event.tool_use_id
      ? [event.tool_use_id]
      : []
  )));
  const latestAskFinishAt = new Map();
  for (const { event } of entries) {
    if (!['PostToolUse', 'PostToolUseFailure'].includes(event.hook_event_name)) continue;
    if (event.tool_name !== 'AskUserQuestion' || event.agent_id || !startedAskToolUseIds.has(event.tool_use_id)) continue;
    const decisionId = askDecisionState.bindings?.[event.tool_use_id] || event.tool_use_id;
    latestAskFinishAt.set(decisionId, Math.max(latestAskFinishAt.get(decisionId) ?? -Infinity, event.hookAt));
  }
  const storedAskDecisions = new Map((askDecisionState.decisions || []).map((decision) => [decision.id, decision]));
  const finishedOutsideEventsIds = new Set(askDecisionState.finishedOutsideEventsIds || []);
  // 再起動の前か MCP で終わった判断事項は、その終わりのイベントがメモリーに無いので、作り直すと巻き戻る。保存済みの状態を保つ。
  // 保存済みの終わりより古い終わりのイベントは、遅れて届いた別の呼び出しの終わりなので、保存済みの状態を説明しない。
  const directlyRecreatedAskDecisionIds = new Set(entries.filter(({ sequence }) => sequence < beforeSequence).flatMap(({ event }) => {
    if (event.hook_event_name !== 'PreToolUse' || event.tool_name !== 'AskUserQuestion' || event.agent_id || !event.tool_use_id) return [];
    const decisionId = askDecisionState.bindings?.[event.tool_use_id] || event.tool_use_id;
    if (decisionId !== event.tool_use_id) return [];
    const stored = storedAskDecisions.get(decisionId);
    // 推定の取り下げの訂正は保存側で済ませるため、ここでは保存済みの取り下げを保つ。
    const keepStored = isFinishedAskDecision(stored) && finishedOutsideEventsIds.has(decisionId) &&
      (Boolean(stored.state === 'withdrawn' && stored.finishedByToolUseId) ||
        !(latestAskFinishAt.get(decisionId) >= Date.parse(stored.resolvedAt || stored.updatedAt)));
    return keepStored ? [] : [decisionId];
  }));
  return {
    decisions: (askDecisionState.decisions || []).filter((decision) => !directlyRecreatedAskDecisionIds.has(decision.id)),
    bindings: askDecisionState.bindings || {},
  };
}

/**
 * @param {DerivedSession} session
 */
function sessionSnapshot(session) {
  const permissionWaits = session.permissionWaits.map(({ agent_id, ...wait }) => ({ agent_id, ...wait }));
  const agents = session.agents
    .filter((agent) => !(
      agent.isCodex && agent.parent_agent_id && session.agents.some((parent) => parent.agent_id === agent.parent_agent_id)
    ))
    .map((agent) => {
      const gptAgent = agent.isCodex ? null : latestCodexForParent(session.agents, agent.agent_id);
      const childUnconfirmed = !agent.isCodex && !agent.active && session.agents.some((child) => (
        child.isCodex && child.unconfirmed && child.parent_agent_id === agent.agent_id
      ));
      return {
        ...agent,
        ...(childUnconfirmed ? { unconfirmed: true } : {}),
        modelName: session.provider === 'codex' ? agent.model : agent.isCodex ? '' : claudeModelName(agent.model),
        ...(gptAgent ? {
          gpt: {
            model: gptAgent.model,
            effort: gptAgent.effort,
            codex_home: gptAgent.codex_home,
            unavailable: gptAgent.unavailable,
            active: gptAgent.active,
            unconfirmed: gptAgent.unconfirmed === true,
          },
        } : {}),
      };
    });
  const tools = [...session.tools].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
  const status = permissionWaits.length
    ? '許可待ち'
    : !session.turnKnown
      ? '不明'
      : session.stopped && session.agents.some((agent) => agent.active)
        ? '待機中(サブエージェント稼働中)'
        : session.stopped
          ? '待機中'
          : '作業中';

  return {
    session_id: session.session_id,
    provider: session.provider,
    ...(session.codex ? { codex: { ...session.codex } } : {}),
    product: session.product,
    title: session.title,
    lastActivityAt: session.lastActivityAt,
    status,
    tools,
    agents,
    permissionWaits,
    decisions: session.decisions.map(cloneDecision),
    decisionBindings: { ...session.decisionBindings },
  };
}

/** @param {Map<string, DerivedSession>} sessions
 * @returns {DerivedSession}
 */
function sessionForEvent(sessions, event, initialAskDecisionState) {
  let session = sessions.get(event.session_id);
  if (event.hook_event_name === 'SessionStart') {
    if (!session || session.ended) {
      session = newSession(event, initialAskDecisionState);
      sessions.set(event.session_id, session);
    }
  } else if (!session) {
    session = newSession(event, initialAskDecisionState);
    sessions.set(event.session_id, session);
  }
  return session;
}

/**
 * @param {SessionDecisions} session
 */
function applyAskQuestionStart(session, event) {
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
  if (event.tool_name === 'AskUserQuestion' && !agentId && toolUseId && event.questions?.length) {
    // 保存済みの結び付きがある呼び出しは、終わった判断事項でも使い回す。再起動の前の ID と回答を保つため。
    const boundDecision = session.decisions.find((decision) => decision.id === session.decisionBindings[toolUseId]);
    const existing = boundDecision || session.decisions.find((decision) => (
      ['waiting', 'provisional'].includes(decision.state) && sameQuestionSet(decision.questions, event.questions)
    ));
    // 最初の呼び出しか判断事項を終えた呼び出しの開始と、終わった時点より古い開始の知らせは、
    // 遅れて届いたか重複なので、状態と解決の内容を変えない。
    const staleStart = existing === boundDecision && isFinishedAskDecision(existing) && (
      existing.id === toolUseId || existing.finishedByToolUseId === toolUseId ||
      event.hookAt <= Date.parse(existing.resolvedAt || existing.updatedAt)
    );
    if (staleStart) {
      session.decisionBindings[toolUseId] = existing.id;
    } else if (existing) {
      existing.state = 'waiting';
      existing.updatedAt = isoTime(event.hookAt);
      existing.resolvedAt = null;
      existing.resolution = null;
      delete existing.inferredWithdrawalHookAt;
      existing.title = event.questions[0].question.slice(0, 200);
      existing.questions = event.questions;
      session.decisionBindings[toolUseId] = existing.id;
    } else {
      const createdAt = isoTime(event.hookAt);
      const decision = {
        id: toolUseId,
        session_id: event.session_id,
        source: 'ask',
        state: 'waiting',
        title: event.questions[0].question.slice(0, 200),
        context: '',
        questions: event.questions,
        createdAt,
        updatedAt: createdAt,
        resolvedAt: null,
        answer: null,
        resolution: null,
      };
      session.decisions.push(decision);
      session.decisionBindings[toolUseId] = decision.id;
    }
  }
}

/**
 * @param {Pick<SessionTools, 'agentToolBindings'|'tools'> & Pick<SessionAgents, 'agents'>} session
 */
function applyAgentToolCompletion(session, event) {
  const eventName = event.hook_event_name;
  const toolUseId = event.tool_use_id || null;
  if (eventName === 'PostToolUse' && event.tool_name === 'Agent') {
    const boundAgent = agentFor(session, session.agentToolBindings[toolUseId]);
    const responseAgent = agentFor(session, event.agentId);
    const targetAgent = responseAgent && !responseAgent.isCodex
      ? responseAgent
      : boundAgent && !boundAgent.isCodex ? boundAgent : null;
    if (!targetAgent) return;
    if (targetAgent === responseAgent) {
      // 同じ行を指す別の呼び出しの結び付けは到着順の誤りなので、agentId の無い応答で使わせない。
      for (const [otherToolUseId, boundAgentId] of Object.entries(session.agentToolBindings)) {
        if (otherToolUseId !== toolUseId && boundAgentId === targetAgent.agent_id) {
          session.agentToolBindings[otherToolUseId] = AMBIGUOUS_AGENT_CALL;
        }
      }
    }
    if (toolUseId) session.agentToolBindings[toolUseId] = targetAgent.agent_id;
    const agentTool = toolUseId && session.tools.find((tool) => tool.tool_use_id === toolUseId && tool.tool_name === 'Agent');
    // SubagentStart の時点の結び付けは到着順で誤ることがあるので、呼び出し自身の説明で上書きする。
    if (agentTool?.description) targetAgent.description = agentTool.description;
    if (targetAgent.active) targetAgent.backgrounded = true;
    if (event.resolvedModel) {
      targetAgent.model = event.resolvedModel;
      targetAgent.source = 'Agent tool response';
    }
  }
}

/**
 * @param {SessionCodex & Pick<SessionAgents, 'agents'>} session
 */
function applyCodexLaunchCompletion(session, event) {
  const eventName = event.hook_event_name;
  const toolUseId = event.tool_use_id || null;
  if (event.tool_name === 'Bash' && toolUseId) {
    const placeholder = agentFor(session, session.pendingCodex[toolUseId]);
    if (placeholder) session.codexLaunchToolIds.add(toolUseId);
    if (placeholder && event.codexRunId) placeholder.runId = event.codexRunId;
    if (placeholder && event.codexResult) {
      completeCodexAgent(placeholder, event);
    } else if (placeholder && session.pendingCodexWait[toolUseId]) {
      // waiting や状態が読めないときは Codex が背景で動き続けている見込みなので、稼働中に残す。
      applyCodexAudit(placeholder, event);
      if (['vanished', 'not-found'].includes(event.codexWaitStatus)) placeholder.active = false;
      if (['orphaned', 'unverified'].includes(event.codexWaitStatus)) {
        placeholder.active = false;
        placeholder.unconfirmed = true;
        placeholder.waitEnded = true;
      }
    } else if (placeholder && eventName === 'PostToolUseFailure') {
      applyCodexAudit(placeholder, event);
      placeholder.active = false;
    } else if (placeholder) {
      applyCodexAudit(placeholder, event);
      placeholder.backgrounded = true;
      if (event.backgroundTaskId) placeholder.backgroundTaskId = event.backgroundTaskId;
    }
    delete session.pendingCodex[toolUseId];
    delete session.pendingCodexWait[toolUseId];
  }
}

/**
 * @param {Pick<SessionCodex, 'codexLaunchToolIds'> & Pick<SessionAgents, 'agents'>} session
 */
function applyCodexResult(session, event) {
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
  // Codex を起動した呼び出しの出力はその起動のものなので、別の行へ結び付けない。
  // 同じ PostToolUse が重複して届くと pendingCodex は消えているので、起動の記録で判定する。
  const isCodexLaunch = session.codexLaunchToolIds.has(toolUseId);

  // 背景タスクの出力を読んだ呼び出しは、背景タスク ID で起動した行と結び付ける。実行 ID が無い複数の背景 Codex を区別できる。
  const outputCodex = event.backgroundOutputTaskId && event.tool_name !== 'Agent' && !isCodexLaunch
    ? session.agents.find((agent) => agent.isCodex && agent.backgroundTaskId === event.backgroundOutputTaskId)
    : null;
  if (outputCodex && !outputCodex.runId && event.codexRunId) outputCodex.runId = event.codexRunId;

  // Agent の結果は担当の最終報告で、背景の Codex の結果行を写していることがあるので使わない。
  if (event.codexResult && !isCodexLaunch && event.tool_name !== 'Agent') {
    const codexForRun = event.codexRunId ? session.agents.find((agent) => agent.isCodex && agent.runId === event.codexRunId) : null;
    const matched = codexForRun || outputCodex;
    const targetAgent = matched
      ? (matched.resultReceived ? null : matched)
      : uniqueBackgroundedCodex(session, agentId, event.codexRunId);
    if (targetAgent && !targetAgent.runId && event.codexRunId) targetAgent.runId = event.codexRunId;
    if (targetAgent) completeCodexAgent(targetAgent, event);
  }
}

/**
 * @param {SessionDecisions} session
 */
function applyAskQuestionCompletion(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
  if (event.tool_name === 'AskUserQuestion' && !agentId && toolUseId) {
    const decisionId = session.decisionBindings[toolUseId];
    const decision = session.decisions.find((item) => item.id === decisionId);
    if (decision && ['waiting', 'provisional'].includes(decision.state)) {
      decision.state = eventName === 'PostToolUse' ? 'resolved' : 'withdrawn';
      decision.updatedAt = isoTime(event.hookAt);
      decision.resolvedAt = decision.updatedAt;
      decision.resolution = eventName === 'PostToolUse'
        ? event.decisionResolution || { chosen: [], note: '' }
        : null;
      // 最後に判断事項を終えた呼び出し。再起動の後に同じ呼び出しの開始が新しい時刻で届いても重複と分かるよう、
      // waiting に戻っても消さずに残す(開始から終わりまで進んだ呼び出しの開始が、正当に新しく届くことは無い)。
      decision.finishedByToolUseId = toolUseId;
      delete decision.inferredWithdrawalHookAt;
    }
  }
}

/**
 * @param {SessionAgents & Pick<SessionIdentity, 'product'|'title'|'lastActivityAt'>} session
 */
function applyCommonEventStart(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  const isCodexAgentId = agentId?.startsWith('codex:') === true;
  if (event.product) session.product = event.product;
  if (event.sessionName) session.title = event.sessionName;
  session.lastActivityAt = isoTime(event.hookAt);

  if (eventName === 'SubagentStop' && agentId) {
    session.stoppedAgentIds.add(agentId);
  } else if (eventName === 'SubagentStart' && agentId && !isCodexAgentId) {
    session.stoppedAgentIds.delete(agentId);
  } else if (
    agentId && !isCodexAgentId && !session.stoppedAgentIds.has(agentId) && !agentFor(session, agentId)
  ) {
    const agent = agentModelFromDefinition(event.agent_type, event.agentDefinition || {});
    agent.agent_id = agentId;
    agent.startedAt = isoTime(event.hookAt);
    session.agents.push(agent);
  }
}

/**
 * @param {SessionTools & Pick<SessionAgents, 'agents'> & SessionCodex & SessionDecisions & Pick<SessionIdentity, 'stopped'|'turnKnown'>} session
 */
function applyToolStart(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
  if (eventName === 'PreToolUse') {
    if (toolUseId && !session.completedToolIds.has(toolUseId)) {
      session.tools = session.tools.filter((tool) => tool.tool_use_id !== toolUseId);
      session.tools.push({
        tool_use_id: toolUseId,
        tool_name: event.tool_name,
        summary: event.summary,
        description: event.description || '',
        agent_id: agentId,
        startedAt: isoTime(event.hookAt),
      });
      if (session.provider !== 'codex' && event.tool_name === 'Agent' && !agentId) {
        // 未対応の呼び出しが重なった時点で、どの SubagentStart がどれに当たるかは決まらない。
        const overlapping = unboundAgentCallsOf(session).filter((tool) => tool.tool_use_id !== toolUseId);
        for (const tool of overlapping) session.agentToolBindings[tool.tool_use_id] = AMBIGUOUS_AGENT_CALL;
        session.agentToolBindings[toolUseId] = overlapping.length ? AMBIGUOUS_AGENT_CALL : null;
      }
    }

    if (agentId) {
      const agent = agentFor(session, agentId);
      if (agent) {
        agent.lastTool = { tool_name: event.tool_name, summary: event.summary };
      }
    }

    if (session.provider !== 'codex') {
      applyCodexStart(session, event);
      applyAskQuestionStart(session, event);
    }

    if (!agentId) {
      session.stopped = false;
      session.turnKnown = true;
    }
  }
}

/**
 * @param {SessionAgents & Pick<SessionTools, 'tools'|'agentToolBindings'>} session
 */
function applySubagentStart(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  const isCodexAgentId = agentId?.startsWith('codex:') === true;
  if (eventName === 'SubagentStart' && agentId && !isCodexAgentId) {
    let agent = agentFor(session, agentId);
    const definition = event.agentDefinition || {};
    if (agent) {
      agent.active = true;
      agent.unconfirmed = false;
      agent.startedAt = isoTime(event.hookAt);
      agent.agent_type = event.agent_type || agent.agent_type;
      if (event.route) agent.route = event.route;
    } else {
      agent = agentModelFromDefinition(event.agent_type, definition);
      agent.agent_id = agentId;
      agent.startedAt = isoTime(event.hookAt);
      if (event.route) agent.route = event.route;
      session.agents.push(agent);
    }
    const unboundAgentCalls = unboundAgentCallsOf(session);
    if (unboundAgentCalls.length === 1) {
      const tool = unboundAgentCalls[0];
      session.agentToolBindings[tool.tool_use_id] = agentId;
      agent.description = tool.description || agent.description;
    }
  }
}

/**
 * @param {SessionAgents & Pick<SessionTools, 'tools'> & SessionPermissions} session
 */
function applySubagentStop(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  if (eventName === 'SubagentStop' && agentId) {
    stopAgent(session, agentId, session.stoppedAgentIds);
  }
  if (eventName === 'PostToolUse' && event.tool_name === 'TaskStop' && event.stoppedTaskId) {
    const agent = agentFor(session, event.stoppedTaskId);
    if (agent && !agent.isCodex) stopAgent(session, agent.agent_id, session.stoppedAgentIds);
  }
}

/**
 * @param {SessionTools & Pick<SessionAgents, 'agents'> & SessionCodex & SessionDecisions & SessionPermissions & Pick<SessionIdentity, 'stopped'|'turnKnown'>} session
 */
function applyToolCompletion(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
  if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
    if (session.provider !== 'codex') applyAgentToolCompletion(session, event);
    if (toolUseId) {
      session.tools = session.tools.filter((tool) => tool.tool_use_id !== toolUseId);
      session.completedToolIds.add(toolUseId);
    }

    if (session.provider !== 'codex') {
      applyCodexLaunchCompletion(session, event);
      applyCodexResult(session, event);
    }

    session.permissionWaits = session.permissionWaits.filter((wait) => !(
      sameAgent(wait.agent_id, agentId) && (
        (wait.target_tool_use_id === toolUseId && toolUseId) ||
        (session.provider === 'codex' && eventName === 'PostToolUse' && !wait.target_tool_use_id && wait.tool_name === event.tool_name)
      )
    ));
    if (session.provider !== 'codex') applyAskQuestionCompletion(session, event);

    if (!agentId) {
      session.stopped = false;
      session.turnKnown = true;
    }
  }
}

/**
 * @param {Pick<SessionTools, 'tools'> & SessionPermissions} session
 */
function applyToolBatch(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  // 区切りが終わった時点で、同じエージェントの先に始まったツールは終わったか拒否されている。
  // 拒否されたツールには PostToolUse も PostToolUseFailure も届かない。
  if (eventName === 'PostToolBatch') {
    const startedBeforeBatch = (item) => sameAgent(item.agent_id, agentId) && Date.parse(item.startedAt) < event.hookAt;
    session.tools = session.tools.filter((tool) => !startedBeforeBatch(tool));
    // メインの許可待ちは Stop と UserPromptSubmit で消す。並行する背景のサブエージェントの許可待ちを巻き込まないため。
    if (agentId) session.permissionWaits = session.permissionWaits.filter((wait) => !startedBeforeBatch(wait));
  }
}

/**
 * @param {Pick<SessionTools, 'tools'> & SessionPermissions} session
 */
function applyPermissionPrompt(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  if (eventName === 'PermissionRequest' || (eventName === 'Notification' && event.notification_type === 'permission_prompt')) {
    // Agent の呼び出しはサブエージェントの終わりまで続くので、許可を待つツールの候補にしない。
    const oldestTool = session.tools
      .filter((tool) => sameAgent(tool.agent_id, agentId) && tool.tool_name !== 'Agent')
      .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))[0];
    // PermissionRequest には tool_use_id が無いので、同じ名前で実行中のツールが 1 つに決まるときだけ対象にする。
    const requestedTools = eventName === 'PermissionRequest'
      ? session.tools.filter((tool) => sameAgent(tool.agent_id, agentId) && tool.tool_name === event.tool_name)
      : [];
    const wait = {
      agent_id: agentId,
      target_tool_use_id: eventName === 'PermissionRequest'
        ? (requestedTools.length === 1 ? requestedTools[0].tool_use_id : null)
        : oldestTool?.tool_use_id || null,
      tool_name: eventName === 'PermissionRequest' ? event.tool_name : oldestTool?.tool_name || '',
      summary: eventName === 'PermissionRequest' ? event.summary : oldestTool?.summary || '',
      notification_type: event.notification_type || 'permission_prompt',
      message: event.message || '',
      startedAt: isoTime(event.hookAt),
    };
    session.permissionWaits = session.permissionWaits.filter((item) => !sameAgent(item.agent_id, agentId));
    session.permissionWaits.push(wait);
  }
}

/**
 * @param {Pick<SessionTools, 'tools'> & SessionPermissions & Pick<SessionIdentity, 'stopped'|'turnKnown'|'ended'>} session
 */
function applySessionLifecycle(session, event) {
  const eventName = event.hook_event_name === 'Interrupt' ? 'Stop' : event.hook_event_name;
  const agentId = event.agent_id || null;
  if (eventName === 'UserPromptSubmit' || eventName === 'Stop') {
    session.permissionWaits = session.permissionWaits.filter((wait) => !sameAgent(wait.agent_id, agentId));
    if (!agentId) session.tools = session.tools.filter((tool) => tool.agent_id);
  }

  // compact は自動の圧縮でターンの途中にも起きるので、直前の状態を保つ。
  const startsIdle = eventName === 'SessionStart' && IDLE_START_SOURCES.has(event.source);
  if (startsIdle || eventName === 'UserPromptSubmit' || eventName === 'Stop') session.turnKnown = true;
  if (startsIdle) {
    session.permissionWaits = session.permissionWaits.filter((wait) => wait.agent_id);
    session.tools = session.tools.filter((tool) => tool.agent_id);
    session.stopped = true;
  }
  if (eventName === 'UserPromptSubmit') session.stopped = false;
  if (eventName === 'Stop') {
    session.stopped = true;
  }
  if (eventName === 'SessionEnd') session.ended = true;
}

/**
 * @param {Pick<SessionAgents, 'stoppedAgentIds'> & Pick<SessionTools, 'tools'> & SessionPermissions} session
 */
function applyCommonEventEnd(session, event) {
  const agentId = event.agent_id || null;
  if (agentId && session.stoppedAgentIds.has(agentId)) {
    session.tools = session.tools.filter((tool) => tool.agent_id !== agentId);
    session.permissionWaits = session.permissionWaits.filter((wait) => wait.agent_id !== agentId);
  }
}

/**
 * @param {Pick<SessionAgents, 'agents'> & Pick<SessionCodex, 'pendingCodex'|'pendingCodexWait'>} session
 */
function applyCodexWaitStart(session, event) {
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
  // 実行 ID は一意なので親を問わずに探し、待ちを引き継いだ親の下へ付け替える。
  const codexForRun = session.agents.find((candidate) => candidate.isCodex && candidate.runId === event.codexWaitRunId);
  if (codexForRun?.resultReceived) {
    // 取り出し直しの出力の結果行を、背景で動いている別の行へ流さないため、終わった行に結び付けておく。
    session.pendingCodex[toolUseId] = codexForRun.agent_id;
  } else {
    const agent = codexForRun || latestWaitableCodex(session, agentId, event.codexWaitDefinition, event.codexWaitRunId);
    if (agent) {
      agent.parent_agent_id = agentId;
      agent.active = true;
      agent.unconfirmed = false;
      agent.runId = event.codexWaitRunId;
      delete agent.waitEnded;
      agent.lastTool = { tool_name: 'Bash', summary: event.summary };
      session.pendingCodex[toolUseId] = agent.agent_id;
    } else {
      const agentIdForCall = `codex:${toolUseId}`;
      const waitAgent = agentModelFromDefinition(event.codexWaitDefinition, event.codexAgentDefinition);
      Object.assign(waitAgent, {
        agent_id: agentIdForCall,
        agent_type: event.codexWaitDefinition,
        isCodex: true,
        parent_agent_id: agentId,
        codex_home: '',
        unavailable: '',
        backgrounded: true,
        runId: event.codexWaitRunId,
        startedAt: isoTime(event.hookAt),
        lastTool: { tool_name: 'Bash', summary: event.summary },
      });
      session.agents.push(waitAgent);
      session.pendingCodex[toolUseId] = agentIdForCall;
    }
    session.pendingCodexWait[toolUseId] = true;
  }
}

/**
 * @param {Pick<SessionAgents, 'agents'> & Pick<SessionCodex, 'pendingCodex'>} session
 */
function applyCodexLaunchStart(session, event) {
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
  const agentIdForCall = `codex:${toolUseId}`;
  const agent = agentModelFromDefinition(event.codexDefinition, event.codexAgentDefinition);
  Object.assign(agent, {
    agent_id: agentIdForCall,
    agent_type: event.codexDefinition,
    isCodex: true,
    parent_agent_id: agentId,
    codex_home: '',
    unavailable: '',
    startedAt: isoTime(event.hookAt),
    lastTool: { tool_name: 'Bash', summary: event.summary },
  });
  const existingIndex = session.agents.findIndex((item) => item.agent_id === agentIdForCall);
  if (existingIndex >= 0) session.agents.splice(existingIndex, 1, agent);
  else session.agents.push(agent);
  session.pendingCodex[toolUseId] = agentIdForCall;
}

/**
 * @param {Pick<SessionAgents, 'agents'> & Pick<SessionCodex, 'pendingCodex'|'pendingCodexWait'>} session
 */
function applyCodexStart(session, event) {
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
  const isCodexAgentId = agentId?.startsWith('codex:') === true;
  if (event.codexWaitDefinition && agentId && !isCodexAgentId && toolUseId) {
    applyCodexWaitStart(session, event);
  } else if (event.codexDefinition && toolUseId) {
    applyCodexLaunchStart(session, event);
  }
}

function deriveSessions(entries, askDecisionState = {}, beforeSequence = Infinity) {
  const sessions = new Map();
  const initialAskDecisionState = initialAskDecisionsFor(entries, askDecisionState, beforeSequence);
  const ordered = [...entries].sort((left, right) => {
    const difference = left.event.hookAt - right.event.hookAt;
    return difference || left.sequence - right.sequence;
  });

  for (const { event } of ordered) {
    const session = sessionForEvent(sessions, event, initialAskDecisionState);

    if (session.ended) continue;
    applyCommonEventStart(session, event);

    applyToolStart(session, event);
    applySubagentStart(session, event);
    if (session.provider === 'codex') {
      if (event.agent_id) {
        const agent = agentFor(session, event.agent_id);
        if (agent && event.model) agent.model = event.model;
      } else {
        if (event.model) session.codex.model = event.model;
        if (event.hook_event_name === 'SessionStart' && event.source === 'resume') session.codex.resumes += 1;
      }
    }
    applySubagentStop(session, event);
    applyToolCompletion(session, event);
    applyToolBatch(session, event);
    applyPermissionPrompt(session, event);
    applySessionLifecycle(session, event);

    applyCommonEventEnd(session, event);
  }

  return [...sessions.values()]
    .filter((session) => !session.ended)
    .map(sessionSnapshot);
}

class DashboardState {
  constructor(options = {}) {
    this.homeDir = options.homeDir || null;
    this.fileSystem = options.fileSystem || fs;
    this.storeWriter = options.writer || (this.homeDir ? new AtomicJsonWriter(this.homeDir, { fileSystem: this.fileSystem }) : null);
    this.entries = new Map();
    this.sequence = 0;
    this.version = 0;
    this.generatedAt = new Date().toISOString();
    this.sessions = new Map();
    this.endedAt = new Map();
    this.endedByAbsence = new Map();
    this.fieldNames = new Set();
    this.notificationTypes = new Set();
    this.sessionFiles = new Map();
    this.sessionFileLastSeenAt = new Map();
    this.plans = new Map();
    this.askDecisionBindings = new Map();
    // 保存済み、MCP、後続イベントで終えた質問は、開始と終了のフックだけで再現できないため状態を保つ。
    this.finishedOutsideEventsAskDecisionIds = new Map();
    this.decisionOverrides = new Map();
    this.decisionLifecycles = new Map();
    this.estimates = new Map();
    this.hiddenSessions = new Set();
    this.hiddenSessionUpdatedAt = new Map();
    this.deletedSessions = new Map();
    this.closedTasks = new Map();
    this.pullRequests = new Map();
    this.relatedPullRequests = new Map();
    this.pullRequestConflictRequests = new Map();
    this.pullRequestRetargets = [];
    this.mergedPullRequests = new Map();
    this.pullRequestMergeReservationRecords = new Map();
    this.pullRequestMergeReservationNotices = new Map();
    this.pullRequestMergeIntentRecords = new Map();
    this.lastPullRequestMethods = new Map();
    this.seenAtByProduct = new Map();
    this.ciFailures = [];
    this.crossReviewSkips = new Map();
    this.closedAgents = new Map();
    // SessionEnd でイベントを捨てても、同じ thread の再開の回数は続けて数える。
    this.codexResumesBeforeEnd = new Map();
    this.display = null;
    this.storeWriteTimer = null;
    this.storeWritePending = false;
    this.restoreSessionCleanupPending = false;
    this.onSessionEndedByAbsence = options.onSessionEndedByAbsence || null;
    this.onSessionReopened = options.onSessionReopened || null;
  }

  static async load(homeDir, options = {}) {
    const state = new DashboardState({ ...options, homeDir });
    if (!state.storeWriter) state.storeWriter = new AtomicJsonWriter(homeDir, { fileSystem: state.fileSystem });
    let contents;
    try {
      contents = await state.fileSystem.readFile(path.join(homeDir, 'store.json'), 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') await state.quarantineStore(options.now ?? Date.now());
      state.restoreSessionCleanupPending = true;
      return state;
    }

    try {
      const parsed = JSON.parse(contents);
      const before = stableStringify(parsed);
      const normalized = normalizeStore(parsed);
      state.restoreStore(normalized, options.now ?? Date.now());
      state.restoreSessionCleanupPending = true;
      if (stableStringify(state.serializeStore()) !== before) state.requestStoreWrite();
    } catch {
      await state.quarantineStore(options.now ?? Date.now());
      state.restoreSessionCleanupPending = true;
    }
    return state;
  }

  async quarantineStore(now) {
    const stamp = new Date(now).toISOString().replace(/[:.]/g, '-');
    const target = path.join(this.homeDir, `store.json.broken-${stamp}`);
    await this.fileSystem.rename(path.join(this.homeDir, 'store.json'), target).catch(() => {});
  }

  restoreStore(store, now) {
    this.restoreSessionCleanupPending = true;
    this.restoredAt = now;
    this.display = store.display;
    this.deletedSessions = store.deletedSessions;
    this.plans = store.plans;
    this.askDecisionBindings = store.askDecisionBindings;
    this.finishedOutsideEventsAskDecisionIds = new Map([...this.plans].flatMap(([sessionId, plan]) => {
      const ids = (plan.decisions || [])
        .filter((decision) => decision.source === 'ask' && isFinishedAskDecision(decision)).map((decision) => decision.id);
      return ids.length ? [[sessionId, new Set(ids)]] : [];
    }));
    this.seenAtByProduct = store.seenAtByProduct;
    this.ciFailures = store.ciFailures;
    this.decisionLifecycles = store.decisionLifecycles;
    for (const [sessionId, lifecycles] of this.decisionLifecycles) {
      const decisionIds = new Set((this.plans.get(sessionId)?.decisions || []).map((decision) => decision.id));
      for (const [decisionId, lifecycle] of lifecycles) {
        if (!decisionIds.has(decisionId)) lifecycles.delete(decisionId);
        else delete lifecycle.awaitingAnswerUntil;
      }
      if (!lifecycles.size) this.decisionLifecycles.delete(sessionId);
    }
    for (const record of store.closedTasks) {
      const task = this.plans.get(record.session_id)?.tasks.find((item) => item.title === record.title);
      if (!task || task.state !== record.stateAtClose) continue;
      const closedAt = record.closedAt || this.plans.get(record.session_id)?.tasksUpdatedAt || isoTime(now);
      this.closedTaskMapFor(record.session_id).set(record.title, { stateAtClose: record.stateAtClose, closedAt });
    }
    for (const record of store.hiddenSessions) {
      this.hiddenSessions.add(record.session_id);
      this.hiddenSessionUpdatedAt.set(record.session_id, record.updatedAt);
    }
    for (const record of store.prs) {
      let records = this.pullRequests.get(record.session_id);
      if (!records) {
        records = new Map();
        this.pullRequests.set(record.session_id, records);
      }
      records.set(pullRequestRecordKey(record.owner, record.repo, record.number), record);
    }
    this.relatedPullRequests = new Map(store.relatedPrs.map((record) => [
      relatedPullRequestRecordKey(record.owner, record.repo, record.number), record,
    ]));
    this.pullRequestRetargets = store.retargetedPrs;
    this.mergedPullRequests = new Map(store.mergedPrs.map((record) => [
      relatedPullRequestRecordKey(record.owner, record.repo, record.number), record,
    ]));
    for (const record of [...this.pullRequestRegistrations(), ...this.relatedPullRequestRegistrations()]) {
      const mergedAt = Date.parse(record.mergedAt || '');
      if (record.state !== 'merged' || !Number.isFinite(mergedAt) || now - mergedAt < 0 || now - mergedAt >= MERGED_PULL_REQUEST_RETENTION_MS) continue;
      const key = relatedPullRequestRecordKey(record.owner, record.repo, record.number);
      if (this.mergedPullRequests.has(key)) continue;
      this.mergedPullRequests.set(key, {
        owner: record.owner,
        repo: record.repo,
        number: record.number,
        title: record.lastOpen?.title || `#${record.number}`,
        url: record.url,
        mergedAt: record.mergedAt,
        method: null,
        automatic: false,
        reservedHeadRefOid: null,
        mergedHeadRefOid: null,
        headMismatch: false,
      });
    }
    this.pullRequestMergeReservationRecords = new Map(store.mergeReservations.map((record) => [
      relatedPullRequestRecordKey(record.owner, record.repo, record.number), record,
    ]));
    this.pullRequestMergeReservationNotices = new Map();
    this.pullRequestMergeIntentRecords = new Map(store.mergeIntents.map((record) => [
      relatedPullRequestRecordKey(record.owner, record.repo, record.number), record,
    ]));
    this.lastPullRequestMethods = store.lastPullRequestMethods;
    this.crossReviewSkips = new Map(store.crossReviewSkips.map((record) => [
      relatedPullRequestRecordKey(record.owner, record.repo, record.number), record,
    ]));
    this.pruneExpiredStoreRecords(now);
  }

  pruneExpiredStoreRecords(now) {
    let mergeHistoryChanged = false;
    let sessionRecordsChanged = false;
    for (const [sessionId, deletedAt] of this.deletedSessions) {
      if (now - Date.parse(deletedAt) <= STORE_RETENTION_MS) continue;
      this.deletedSessions.delete(sessionId);
      sessionRecordsChanged = true;
    }
    let relatedPullRequestsChanged = false;
    let crossReviewSkipsChanged = false;
    // セッションファイルを読めない環境では同期が来ないので、猶予の後はフックで届いたセッションだけで生死を判定する。
    const sessionCleanupDeferred = this.restoreSessionCleanupPending && now - this.restoredAt < RESTORE_SESSION_CLEANUP_GRACE_MS;
    if (!sessionCleanupDeferred) {
      const sessionIds = new Set([
        ...this.plans.keys(), ...this.decisionLifecycles.keys(),
        ...this.closedTasks.keys(), ...this.pullRequests.keys(),
      ]);
      for (const sessionId of sessionIds) {
        if (this.sessions.has(sessionId) || this.sessionFiles.has(sessionId)) continue;
        const updatedAt = this.lastStoredUpdateAt(sessionId);
        if (!Number.isFinite(updatedAt) || now - updatedAt > STORE_RETENTION_MS) {
          this.deleteStoredSession(sessionId);
          sessionRecordsChanged = true;
        }
      }
    }
    for (const [key, record] of this.relatedPullRequests) {
      if (!Number.isFinite(Date.parse(record.addedAt)) || now - Date.parse(record.addedAt) > STORE_RETENTION_MS) {
        this.relatedPullRequests.delete(key);
        relatedPullRequestsChanged = true;
      }
    }
    const retainedPullRequestKeys = new Set([
      ...this.pullRequestRegistrations(),
      ...this.relatedPullRequestRegistrations(),
    ].map((record) => relatedPullRequestRecordKey(record.owner, record.repo, record.number)));
    for (const key of this.crossReviewSkips.keys()) {
      if (retainedPullRequestKeys.has(key)) continue;
      this.crossReviewSkips.delete(key);
      crossReviewSkipsChanged = true;
    }
    for (const [key, record] of this.mergedPullRequests) {
      if (!Number.isFinite(Date.parse(record.mergedAt)) || now - Date.parse(record.mergedAt) >= MERGED_PULL_REQUEST_RETENTION_MS) {
        this.mergedPullRequests.delete(key);
        mergeHistoryChanged = true;
      }
    }
    const previousFailureCount = this.ciFailures.length;
    this.ciFailures = this.ciFailures.filter((record) => now - Date.parse(record.at) < STORE_RETENTION_MS);
    if (sessionRecordsChanged || relatedPullRequestsChanged || crossReviewSkipsChanged || mergeHistoryChanged || previousFailureCount !== this.ciFailures.length) {
      this.touch();
      this.requestStoreWrite();
    }
    return mergeHistoryChanged;
  }

  lastStoredUpdateAt(sessionId) {
    const timestamps = [];
    const plan = this.plans.get(sessionId);
    if (plan?.tasksUpdatedAt) timestamps.push(Date.parse(plan.tasksUpdatedAt));
    for (const decision of plan?.decisions || []) timestamps.push(Date.parse(decision.updatedAt));
    for (const lifecycle of this.decisionLifecycles.get(sessionId)?.values() || []) {
      if (lifecycle.updatedAt) timestamps.push(Date.parse(lifecycle.updatedAt));
      for (const key of ['sentAt', 'deliveredAt', 'reflectedAt', 'ignoredAt']) {
        if (lifecycle.answer?.[key]) timestamps.push(Date.parse(lifecycle.answer[key]));
      }
    }
    for (const record of this.closedTasks.get(sessionId)?.values() || []) timestamps.push(Date.parse(record.closedAt));
    for (const record of this.pullRequests.get(sessionId)?.values() || []) {
      timestamps.push(Date.parse(record.addedAt));
      if (record.mergedAt) timestamps.push(Date.parse(record.mergedAt));
    }
    const finite = timestamps.filter(Number.isFinite);
    return finite.length ? Math.max(...finite) : NaN;
  }

  deleteStoredSession(sessionId, { keepPullRequests = false } = {}) {
    this.plans.delete(sessionId);
    this.askDecisionBindings.delete(sessionId);
    this.finishedOutsideEventsAskDecisionIds.delete(sessionId);
    this.decisionLifecycles.delete(sessionId);
    this.closedTasks.delete(sessionId);
    if (!keepPullRequests) this.pullRequests.delete(sessionId);
  }

  deleteSession(sessionId, now = Date.now()) {
    if (!this.snapshot().sessions.some((session) => session.session_id === sessionId)) return false;
    for (const records of [this.entries, this.sessions, this.endedAt, this.endedByAbsence,
      this.decisionOverrides, this.estimates, this.hiddenSessions, this.hiddenSessionUpdatedAt,
      this.closedAgents, this.sessionFileLastSeenAt]) records.delete(sessionId);
    this.deleteStoredSession(sessionId, { keepPullRequests: true });
    this.deletedSessions.set(sessionId, isoTime(now));
    this.onSessionEndedByAbsence?.(sessionId, now);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  acceptSessionWrite(sessionId, at = Infinity) {
    const deletedAt = this.deletedSessions.get(sessionId);
    if (!deletedAt) return true;
    if (at <= Date.parse(deletedAt)) return false;
    this.deletedSessions.delete(sessionId);
    this.onSessionReopened?.(sessionId);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  serializeStore() {
    const plans = Object.fromEntries([...this.plans].map(([sessionId, plan]) => [sessionId, {
      tasks: plan.tasks.map((task) => ({
        title: task.title,
        state: task.state,
        criteria: task.criteria.map((item) => ({ text: item.text, met: item.met })),
        ...(task.completedAt ? { completedAt: task.completedAt } : {}),
      })),
      tasksUpdatedAt: plan.tasksUpdatedAt,
      product: cloneProduct(plan.product),
      decisions: plan.decisions.map(cloneDecision),
    }]));
    const decisionLifecycles = Object.fromEntries([...this.decisionLifecycles].flatMap(([sessionId, records]) => {
      const decisionIds = new Set((this.plans.get(sessionId)?.decisions || []).map((decision) => decision.id));
      const persistent = [...records].filter(([decisionId]) => decisionIds.has(decisionId));
      return persistent.length
        ? [[sessionId, Object.fromEntries(persistent.map(([decisionId, lifecycle]) => [decisionId, { ...lifecycle }]))]]
        : [];
    }));
    const askDecisionBindings = Object.fromEntries([...this.askDecisionBindings]
      .map(([sessionId, bindings]) => [sessionId, Object.fromEntries(bindings)]));
    const closedTasks = [...this.closedTasks].flatMap(([sessionId, tasks]) => [...tasks].map(([title, record]) => ({
      session_id: sessionId,
      title,
      stateAtClose: record.stateAtClose,
      ...(record.closedAt ? { closedAt: record.closedAt } : {}),
    })));
    const hiddenSessions = [...this.hiddenSessions].map((sessionId) => ({
      session_id: sessionId,
      updatedAt: this.hiddenSessionUpdatedAt.get(sessionId),
    }));
    return {
      version: 1,
      display: cloneDisplay(this.display),
      plans,
      askDecisionBindings,
      decisionLifecycles,
      closedTasks,
      hiddenSessions,
      deletedSessions: Object.fromEntries(this.deletedSessions),
      prs: this.pullRequestRegistrations(),
      relatedPrs: [...this.relatedPullRequests.values()].map(normalizeRelatedPullRequestRecord),
      retargetedPrs: this.pullRequestRetargets.map((record) => ({ ...record })),
      mergedPrs: [...this.mergedPullRequests.values()].map((record) => ({ ...record })),
      mergeReservations: [...this.pullRequestMergeReservationRecords.values()].map((record) => ({ ...record })),
      mergeIntents: [...this.pullRequestMergeIntentRecords.values()].map((record) => ({
        ...record,
        stackedPullRequests: record.stackedPullRequests.map((item) => ({ ...item })),
      })),
      lastPullRequestMethods: Object.fromEntries(this.lastPullRequestMethods),
      seenAtByProduct: Object.fromEntries(this.seenAtByProduct),
      ciFailures: this.ciFailures.map((record) => ({ ...record, product: cloneProduct(record.product) })),
      crossReviewSkips: [...this.crossReviewSkips.values()].map(normalizeCrossReviewSkip),
    };
  }

  pullRequestRegistrations() {
    return [...this.pullRequests.values()].flatMap((records) => [...records.values()].map(normalizePullRequestRecord));
  }

  pullRequestRegistrationForSession(sessionId, owner, repo, number) {
    const record = this.pullRequests.get(sessionId)?.get(pullRequestRecordKey(owner, repo, number));
    return record ? normalizePullRequestRecord(record) : null;
  }

  crossReviewSkip(owner, repo, number) {
    const record = this.crossReviewSkips.get(relatedPullRequestRecordKey(owner, repo, number));
    return record ? { ...record } : null;
  }

  setCrossReviewSkip(record) {
    if (!validCrossReviewSkip(record)) return false;
    const next = normalizeCrossReviewSkip(record);
    const key = relatedPullRequestRecordKey(next.owner, next.repo, next.number);
    const current = this.crossReviewSkips.get(key);
    if (current && stableStringify(current) === stableStringify(next)) return { ...current };
    this.crossReviewSkips.set(key, next);
    this.touch();
    this.requestStoreWrite();
    return { ...next };
  }

  clearCrossReviewSkip(owner, repo, number, expectedHeadRefOid) {
    const key = relatedPullRequestRecordKey(owner, repo, number);
    const current = this.crossReviewSkips.get(key);
    if (!current || (expectedHeadRefOid && current.headRefOid !== expectedHeadRefOid.toLowerCase())) return false;
    this.crossReviewSkips.delete(key);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  invalidateCrossReviewSkips(owner, repo, pullRequests) {
    const currentHeads = new Map(pullRequests.map((pullRequest) => [pullRequest.number, String(pullRequest.headRefOid || '').toLowerCase()]));
    let invalidated = 0;
    for (const [key, record] of this.crossReviewSkips) {
      if (record.owner.toLowerCase() !== owner.toLowerCase() || record.repo.toLowerCase() !== repo.toLowerCase()) continue;
      const headRefOid = currentHeads.get(record.number);
      if (!headRefOid || headRefOid === record.headRefOid) continue;
      this.crossReviewSkips.delete(key);
      invalidated += 1;
    }
    if (invalidated) {
      this.touch();
      this.requestStoreWrite();
    }
    return invalidated;
  }

  knownCwds() {
    const cwds = new Set();
    for (const file of this.sessionFiles.values()) {
      if (typeof file.cwd === 'string') cwds.add(file.cwd);
    }
    for (const record of this.pullRequestRegistrations()) {
      if (typeof record.cwd === 'string') cwds.add(record.cwd);
    }
    return [...cwds];
  }

  pullRequestRegistrationsForRepo(owner, repo) {
    return this.pullRequestRegistrations().filter((record) => (
      record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase()
    ));
  }

  pullRequestRegistration(number, registrationKey) {
    const matches = this.pullRequestRegistrations().filter((record) => record.number === number);
    if (typeof registrationKey === 'string') {
      const record = matches.find((candidate) => pullRequestRegistrationKey(candidate) === registrationKey);
      return record ? normalizePullRequestRecord(record) : null;
    }
    return matches.length === 1 ? normalizePullRequestRecord(matches[0]) : null;
  }

  pullRequestRegistrationByKey(registrationKey) {
    if (!isSha256Digest(registrationKey)) return null;
    const record = this.pullRequestRegistrations().find((candidate) => pullRequestRegistrationKey(candidate) === registrationKey);
    return record ? normalizePullRequestRecord(record) : null;
  }

  sessionHasEnded(sessionId) {
    return this.endedAt.has(sessionId) || this.endedByAbsence.has(sessionId);
  }

  recordPullRequestConflictRequest(record) {
    const key = pullRequestRecordKey(record.owner, record.repo, record.number);
    const next = {
      owner: record.owner,
      repo: record.repo,
      number: record.number,
      headRefOid: record.headRefOid,
      requestedAt: record.requestedAt,
      sessionIds: [...record.sessionIds],
    };
    this.pullRequestConflictRequests.set(key, next);
    this.touch();
    return { ...next, sessionIds: [...next.sessionIds] };
  }

  pullRequestConflictRequest(owner, repo, number) {
    const record = this.pullRequestConflictRequests.get(pullRequestRecordKey(owner, repo, number));
    return record ? { ...record, sessionIds: [...record.sessionIds] } : null;
  }

  pullRequestRegistrationKey(record) {
    if (!record || !validStoredSessionId(record.session_id) || !validRepositoryPart(record.owner) ||
      !validRepositoryPart(record.repo) || !Number.isSafeInteger(record.number) || !validTimestamp(record.addedAt)) return null;
    return pullRequestRegistrationKey(record);
  }

  recordMergedPullRequest(record, now = Date.now()) {
    const next = {
      owner: record.owner,
      repo: record.repo,
      number: record.number,
      title: typeof record.title === 'string' ? record.title.slice(0, 500) : `#${record.number}`,
      url: record.url,
      mergedAt: record.mergedAt || isoTime(now),
      method: record.method ?? null,
      automatic: record.automatic === true,
      reservedHeadRefOid: record.reservedHeadRefOid || null,
      mergedHeadRefOid: record.mergedHeadRefOid || null,
      headMismatch: record.headMismatch === true,
      ...(record.automaticResult ? { automaticResult: { ...record.automaticResult, retargetedNumbers: [...record.automaticResult.retargetedNumbers] } } : {}),
    };
    if (!validMergedPullRequest(next)) return false;
    const key = relatedPullRequestRecordKey(next.owner, next.repo, next.number);
    const previous = this.mergedPullRequests.get(key);
    if (previous?.mergedAt === next.mergedAt && previous.mergeResultClosedAt) {
      next.mergeResultClosedAt = previous.mergeResultClosedAt;
    }
    if (previous?.mergedAt === next.mergedAt && previous.historyDismissedAt) {
      next.historyDismissedAt = previous.historyDismissedAt;
    }
    if (previous && stableStringify(previous) === stableStringify(next)) return false;
    this.mergedPullRequests.set(key, next);
    const registrationChanges = { state: 'merged', mergedAt: next.mergedAt };
    if (Object.hasOwn(record, 'mergedHead')) {
      registrationChanges.mergedHead = normalizeMergedPullRequestHead(record.mergedHead);
    }
    for (const registration of this.pullRequestRegistrationsForRepo(next.owner, next.repo).filter((item) => item.number === next.number)) {
      this.updatePullRequest(registration.session_id, next.owner, next.repo, next.number, registrationChanges);
    }
    this.updateRelatedPullRequest(next.owner, next.repo, next.number, registrationChanges);
    this.pruneExpiredStoreRecords(now);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  mergedPullRequestHistoryForRepo(owner, repo, now = Date.now()) {
    this.pruneExpiredStoreRecords(now);
    return [...this.mergedPullRequests.values()]
      .filter((record) => !record.historyDismissedAt)
      .filter((record) => record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase())
      .sort((left, right) => Date.parse(right.mergedAt) - Date.parse(left.mergedAt) || right.number - left.number)
      .map((record) => ({ ...record }));
  }

  dismissMergedPullRequestHistory(owner, repo, number, now = Date.now()) {
    const record = this.mergedPullRequests.get(relatedPullRequestRecordKey(owner, repo, number));
    if (!record || record.headMismatch === true || record.historyDismissedAt) return false;
    record.historyDismissedAt = isoTime(now);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  deleteClosedPullRequest(owner, repo, number) {
    const key = pullRequestRecordKey(owner, repo, number);
    let deleted = false;
    for (const [sessionId, records] of this.pullRequests) {
      if (records.get(key)?.state !== 'closed') continue;
      records.delete(key);
      if (!records.size) this.pullRequests.delete(sessionId);
      deleted = true;
    }
    if (this.relatedPullRequests.get(key)?.state === 'closed') {
      this.relatedPullRequests.delete(key);
      deleted = true;
    }
    if (deleted) {
      this.touch();
      this.requestStoreWrite();
    }
    return deleted;
  }

  closeAutomaticPullRequestMergeResult(owner, repo, number, now = Date.now()) {
    const record = this.mergedPullRequests.get(relatedPullRequestRecordKey(owner, repo, number));
    if (!record || record.automatic !== true || !record.automaticResult) return null;
    if (record.mergeResultClosedAt) return false;
    this.mergedPullRequests.set(relatedPullRequestRecordKey(owner, repo, number), {
      ...record,
      mergeResultClosedAt: isoTime(now),
    });
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  setPullRequestMergeReservation(record) {
    const next = {
      session_id: record.session_id,
      owner: record.owner,
      repo: record.repo,
      number: record.number,
      url: record.url,
      method: record.method,
      deleteBranch: record.deleteBranch,
      createdAt: record.createdAt,
      ...(record.targetBranch === undefined ? {} : { targetBranch: record.targetBranch }),
    };
    if (!validPullRequestMergeReservation(next)) return false;
    const key = relatedPullRequestRecordKey(next.owner, next.repo, next.number);
    const previous = this.pullRequestMergeReservationRecords.get(key);
    if (previous && stableStringify(previous) === stableStringify(next)) return false;
    this.pullRequestMergeReservationRecords.set(key, next);
    this.pullRequestMergeReservationNotices.delete(key);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  pullRequestMergeReservation(owner, repo, number) {
    const record = this.pullRequestMergeReservationRecords.get(relatedPullRequestRecordKey(owner, repo, number));
    return record ? { ...record } : null;
  }

  pullRequestMergeReservationsForRepo(owner, repo) {
    return [...this.pullRequestMergeReservationRecords.values()]
      .filter((record) => record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase())
      .map((record) => ({ ...record }));
  }

  pullRequestMergeReservations() {
    return [...this.pullRequestMergeReservationRecords.values()].map((record) => ({ ...record }));
  }

  recordPullRequestMergeReservationNotice(record) {
    const key = relatedPullRequestRecordKey(record.owner, record.repo, record.number);
    this.pullRequestMergeReservationNotices.set(key, {
      owner: record.owner,
      repo: record.repo,
      number: record.number,
      url: record.url,
      at: record.at,
      message: record.message,
    });
    if (this.pullRequestMergeReservationNotices.size > 100) {
      const oldest = [...this.pullRequestMergeReservationNotices.entries()]
        .sort((left, right) => Date.parse(left[1].at) - Date.parse(right[1].at))[0];
      if (oldest) this.pullRequestMergeReservationNotices.delete(oldest[0]);
    }
    this.touch();
  }

  pullRequestMergeReservationNoticesForRepo(owner, repo, now = Date.now()) {
    return [...this.pullRequestMergeReservationNotices.values()]
      .filter((record) => {
        const timestamp = Date.parse(record.at || '');
        return record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase()
          && !(Number.isFinite(timestamp) && now >= timestamp && now - timestamp >= TRANSIENT_NOTICE_MS);
      })
      .map((record) => ({ ...record }));
  }

  clearPullRequestMergeReservation(owner, repo, number) {
    const deleted = this.pullRequestMergeReservationRecords.delete(relatedPullRequestRecordKey(owner, repo, number));
    if (deleted) {
      this.touch();
      this.requestStoreWrite();
    }
    return deleted;
  }

  setPullRequestMergeIntent(record) {
    const next = {
      ...record,
      owner: record.owner,
      repo: record.repo,
      stackedPullRequests: record.stackedPullRequests.map((item) => ({ ...item })),
    };
    if (!validPullRequestMergeIntent(next)) return false;
    const key = relatedPullRequestRecordKey(next.owner, next.repo, next.number);
    const previous = this.pullRequestMergeIntentRecords.get(key);
    if (previous && stableStringify(previous) === stableStringify(next)) return false;
    this.pullRequestMergeIntentRecords.set(key, next);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  pullRequestMergeIntent(owner, repo, number) {
    const record = this.pullRequestMergeIntentRecords.get(relatedPullRequestRecordKey(owner, repo, number));
    return record ? { ...record, stackedPullRequests: record.stackedPullRequests.map((item) => ({ ...item })) } : null;
  }

  clearPullRequestMergeIntent(owner, repo, number) {
    const deleted = this.pullRequestMergeIntentRecords.delete(relatedPullRequestRecordKey(owner, repo, number));
    if (deleted) {
      this.touch();
      this.requestStoreWrite();
    }
    return deleted;
  }

  setLastPullRequestMethod(owner, repo, method) {
    if (!validRepositoryPart(owner) || !validRepositoryPart(repo) || !PULL_REQUEST_MERGE_METHODS.has(method)) return false;
    const key = pullRequestRepositoryKey(owner, repo);
    if (this.lastPullRequestMethods.get(key) === method) return false;
    this.lastPullRequestMethods.set(key, method);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  lastPullRequestMethod(owner, repo) {
    return this.lastPullRequestMethods.get(pullRequestRepositoryKey(owner, repo)) || null;
  }

  relatedPullRequestRegistrations() {
    return [...this.relatedPullRequests.values()].map(normalizeRelatedPullRequestRecord);
  }

  relatedPullRequestRegistrationsForRepo(owner, repo) {
    return this.relatedPullRequestRegistrations().filter((record) => (
      record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase()
    ));
  }

  rememberRelatedPullRequest(record, now = Date.now()) {
    if (!isRecord(record)) return false;
    const key = relatedPullRequestRecordKey(record.owner, record.repo, record.number);
    const previous = this.relatedPullRequests.get(key);
    const next = normalizeRelatedPullRequestRecord({
      owner: record.owner,
      repo: record.repo,
      number: record.number,
      url: record.url,
      addedAt: previous?.addedAt || isoTime(now),
      state: 'open',
      mergedAt: null,
      lastOpen: record.lastOpen,
    });
    if (!validRelatedPullRequestRecord(next)) return false;
    if (previous && stableStringify(previous) === stableStringify(next)) return false;
    this.relatedPullRequests.set(key, next);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  updateRelatedPullRequest(owner, repo, number, changes, now = Date.now(), displayProducts = []) {
    const key = relatedPullRequestRecordKey(owner, repo, number);
    const current = this.relatedPullRequests.get(key);
    if (!current) return false;
    if (changes.lastOpen && stableStringify(current.lastOpen) !== stableStringify(changes.lastOpen)) {
      this.recordPullRequestCiFailure(owner, repo, number, changes.lastOpen, now, displayProducts);
    }
    const next = normalizeRelatedPullRequestRecord({ ...current, ...changes });
    if (!validRelatedPullRequestRecord(next) || stableStringify(current) === stableStringify(next)) return false;
    this.relatedPullRequests.set(key, next);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  recordPullRequestCiFailure(owner, repo, number, nextLastOpen, now, displayProducts = []) {
    if (nextLastOpen?.ci !== 'fail') return;
    const registrations = this.pullRequestRegistrations().filter((record) => (
      record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase() && record.number === number
    ));
    const related = this.relatedPullRequestRegistrations().filter((record) => (
      record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase() && record.number === number
    ));
    const records = [...registrations, ...related];
    if (records.some((record) => record.lastOpen?.ci === 'fail') ||
      !records.some((record) => ['pass', 'pending'].includes(record.lastOpen?.ci))) return;
    const products = new Map();
    for (const registration of registrations) {
      const product = cloneProduct(registration.product) || repoProduct(owner, repo);
      products.set(product.key, product);
    }
    for (const value of displayProducts) {
      const product = cloneProduct(value);
      if (product) products.set(product.key, product);
    }
    if (!products.size) {
      const product = repoProduct(owner, repo);
      products.set(product.key, product);
    }
    const at = isoTime(now);
    for (const product of products.values()) this.ciFailures.push({ owner, repo, number, product, at });
  }

  registerPullRequest(sessionId, input, context = {}, now = Date.now()) {
    if (!validStoredSessionId(sessionId)) return null;
    const parsedUrl = parsePullRequestUrl(input?.url);
    if (!parsedUrl || (input.owner && input.owner !== parsedUrl.owner) || (input.repo && input.repo !== parsedUrl.repo) ||
      (input.number && input.number !== parsedUrl.number)) return null;
    if (!this.acceptSessionWrite(sessionId, now)) return null;
    let records = this.pullRequests.get(sessionId);
    if (!records) {
      records = new Map();
      this.pullRequests.set(sessionId, records);
    }
    const key = pullRequestRecordKey(parsedUrl.owner, parsedUrl.repo, parsedUrl.number);
    const previous = records.get(key);
    const relatedKey = relatedPullRequestRecordKey(parsedUrl.owner, parsedUrl.repo, parsedUrl.number);
    const related = this.relatedPullRequests.get(relatedKey);
    // preserveLocation は、登録済みの cwd と製品を残す。コマンドの cd から決めた場所を、後の /prs の登録で上書きしないため。
    const location = context.preserveLocation === true && previous?.cwd ? previous : context;
    const product = location.product && typeof location.product.key === 'string' && typeof location.product.name === 'string'
      ? { key: location.product.key.slice(0, 500), name: location.product.name.slice(0, 200) }
      : previous?.product || null;
    const next = {
      session_id: sessionId,
      ...parsedUrl,
      addedAt: previous?.addedAt || isoTime(now),
      cwd: typeof location.cwd === 'string' && location.cwd.length <= 4096 ? location.cwd : previous?.cwd || null,
      product,
      state: previous?.state || related?.state || 'unknown',
      mergedAt: previous?.mergedAt || related?.mergedAt || null,
      lastOpen: previous?.lastOpen ? { ...previous.lastOpen } : related?.lastOpen ? { ...related.lastOpen } : null,
      ...(previous?.mergedHead || related?.mergedHead
        ? { mergedHead: { ...(previous?.mergedHead || related.mergedHead) } }
        : {}),
    };
    if (previous && stableStringify(previous) === stableStringify(next)) {
      if (this.relatedPullRequests.delete(relatedKey)) {
        this.touch();
        this.requestStoreWrite();
      }
      return normalizePullRequestRecord(previous);
    }
    records.set(key, next);
    this.relatedPullRequests.delete(relatedKey);
    this.touch();
    this.requestStoreWrite();
    return normalizePullRequestRecord(next);
  }

  updatePullRequest(sessionId, owner, repo, number, changes, now = Date.now(), displayProducts = []) {
    const records = this.pullRequests.get(sessionId);
    const key = pullRequestRecordKey(owner, repo, number);
    const current = records?.get(key);
    if (!current) return false;
    if (changes.lastOpen && stableStringify(current.lastOpen) !== stableStringify(changes.lastOpen)) {
      this.recordPullRequestCiFailure(owner, repo, number, changes.lastOpen, now, displayProducts);
    }
    const next = { ...current, ...changes };
    if (changes.lastOpen) next.lastOpen = { ...changes.lastOpen };
    if (Object.hasOwn(changes, 'mergedHead')) {
      const mergedHead = normalizeMergedPullRequestHead(changes.mergedHead);
      if (mergedHead) next.mergedHead = mergedHead;
      else delete next.mergedHead;
    }
    if (stableStringify(current) === stableStringify(next)) return false;
    records.set(key, next);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  recordPullRequestRetarget(record) {
    if (!validPullRequestRetarget(record)) return false;
    const index = this.pullRequestRetargets.findIndex((item) => item.owner === record.owner && item.repo === record.repo && item.number === record.number);
    const next = { owner: record.owner, repo: record.repo, number: record.number, base: record.base, fromNumber: record.fromNumber ?? null };
    if (record.previousBaseRefName) next.previousBaseRefName = record.previousBaseRefName;
    if (index >= 0 && stableStringify(this.pullRequestRetargets[index]) === stableStringify(next)) return false;
    if (index >= 0) this.pullRequestRetargets[index] = next;
    else this.pullRequestRetargets.push(next);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  pullRequestRetargetsForRepo(owner, repo) {
    return this.pullRequestRetargets.filter((record) => record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase());
  }

  wasPullRequestCreate(sessionId, toolUseId) {
    if (!toolUseId) return false;
    return (this.entries.get(sessionId) || []).some(({ event }) => (
      event.hook_event_name === 'PreToolUse' && event.tool_name === 'Bash' &&
      event.tool_use_id === toolUseId && event.ghPrCreateCommand === true
    ));
  }

  wasPullRequestRefreshCommand(sessionId, toolUseId) {
    if (!toolUseId) return false;
    return (this.entries.get(sessionId) || []).some(({ event }) => (
      event.hook_event_name === 'PreToolUse' && event.tool_name === 'Bash' &&
      event.tool_use_id === toolUseId && event.refreshPullRequestsCommand === true
    ));
  }

  attachWriter(writer) {
    this.storeWriter = writer;
  }

  requestStoreWrite(immediate = false) {
    if (!this.storeWriter) return Promise.resolve();
    this.storeWritePending = true;
    clearTimeout(this.storeWriteTimer);
    if (!immediate) {
      this.storeWriteTimer = setTimeout(() => { void this.flushStoreWrite().catch(() => {}); }, STORE_WRITE_DELAY_MS);
      this.storeWriteTimer.unref?.();
      return Promise.resolve();
    }
    return this.flushStoreWrite().catch(() => {});
  }

  flushStoreWrite() {
    clearTimeout(this.storeWriteTimer);
    this.storeWriteTimer = null;
    if (!this.storeWritePending || !this.storeWriter) return Promise.resolve();
    this.storeWritePending = false;
    return this.storeWriter.write('store.json', this.serializeStore());
  }

  async waitForPersistence() {
    if (this.storeWriter) await this.storeWriter.flush();
  }

  async flushPersistence() {
    await this.flushStoreWrite().catch(() => {});
    await this.waitForPersistence();
  }

  // フックがまだ届いていないセッションも一覧に出し、題名の変更を拾うために使う。
  syncSessionFiles(files, now = Date.now()) {
    if (!Array.isArray(files)) return;
    const next = new Map(files.map((file) => [file.session_id, file]));
    const previous = this.sessionFiles;
    let changed = JSON.stringify([...next.entries()]) !== JSON.stringify([...previous.entries()]);
    let persistentChanged = false;
    this.sessionFiles = next;
    for (const sessionId of this.deletedSessions.keys()) {
      const file = next.get(sessionId);
      if (file && Date.parse(file.updatedAt) > Date.parse(this.deletedSessions.get(sessionId))) {
        this.acceptSessionWrite(sessionId, Date.parse(file.updatedAt));
        changed = true;
      }
    }

    for (const [sessionId, plan] of this.plans) {
      const product = cloneProduct(next.get(sessionId)?.product || this.sessions.get(sessionId)?.product);
      if (product && stableStringify(plan.product) !== stableStringify(product)) {
        plan.product = product;
        persistentChanged = true;
      }
    }

    if (this.restoreSessionCleanupPending) {
      this.restoreSessionCleanupPending = false;
      this.pruneExpiredStoreRecords(now);
      for (const sessionId of this.hiddenSessions) {
        if (this.sessions.has(sessionId) || next.has(sessionId)) continue;
        this.hiddenSessions.delete(sessionId);
        this.hiddenSessionUpdatedAt.delete(sessionId);
        changed = true;
        persistentChanged = true;
      }
    }

    for (const sessionId of next.keys()) this.sessionFileLastSeenAt.set(sessionId, now);
    for (const sessionId of this.endedByAbsence.keys()) {
      if (next.has(sessionId)) {
        this.reopenAbsentSession(sessionId);
        changed = true;
      }
    }
    for (const sessionId of this.hiddenSessions) {
      if (!next.has(sessionId) && previous.has(sessionId) && !this.sessions.has(sessionId)) {
        this.hiddenSessions.delete(sessionId);
        this.hiddenSessionUpdatedAt.delete(sessionId);
        changed = true;
        persistentChanged = true;
      }
    }
    for (const sessionId of this.estimates.keys()) {
      if (!next.has(sessionId)) {
        this.estimates.delete(sessionId);
        changed = true;
      }
    }
    for (const [sessionId, lastSeenAt] of this.sessionFileLastSeenAt) {
      if (!next.has(sessionId) && this.sessions.has(sessionId) && !this.endedAt.has(sessionId)) {
        if (now - lastSeenAt >= SESSION_FILE_ABSENCE_END_MS) {
          this.endSessionByAbsence(sessionId, now);
          changed = true;
        }
      }
      if (!next.has(sessionId) && !this.sessions.has(sessionId)) this.sessionFileLastSeenAt.delete(sessionId);
    }
    if (changed) this.touch();
    if (persistentChanged) this.requestStoreWrite();
  }

  endSession(sessionId, endedAt) {
    const resumes = (this.entries.get(sessionId) || []).filter(({ event }) => event.provider === 'codex' && !event.agent_id &&
      event.hook_event_name === 'SessionStart' && event.source === 'resume').length;
    if (resumes) this.codexResumesBeforeEnd.set(sessionId, (this.codexResumesBeforeEnd.get(sessionId) || 0) + resumes);
    this.entries.delete(sessionId);
    this.sessions.delete(sessionId);
    this.endedAt.set(sessionId, endedAt);
    this.endedByAbsence.delete(sessionId);
    this.decisionOverrides.delete(sessionId);
    this.estimates.delete(sessionId);
    const wasHidden = this.hiddenSessions.delete(sessionId);
    this.hiddenSessionUpdatedAt.delete(sessionId);
    this.closedAgents.delete(sessionId);
    this.sessionFileLastSeenAt.delete(sessionId);
    if (wasHidden) this.requestStoreWrite();
  }

  endSessionByAbsence(sessionId, endedAt) {
    this.sessions.delete(sessionId);
    this.endedByAbsence.set(sessionId, endedAt);
    this.estimates.delete(sessionId);
    if (this.hiddenSessions.delete(sessionId)) {
      this.hiddenSessionUpdatedAt.delete(sessionId);
      this.requestStoreWrite();
    }
    this.onSessionEndedByAbsence?.(sessionId, endedAt);
  }

  reopenAbsentSession(sessionId) {
    this.endedByAbsence.delete(sessionId);
    const entries = this.entries.get(sessionId) || [];
    const [session] = deriveSessions(entries, this.askDecisionStateFor(sessionId));
    if (session) this.sessions.set(sessionId, session);
    this.onSessionReopened?.(sessionId);
  }

  askDecisionStateFor(sessionId) {
    return {
      decisions: (this.plans.get(sessionId)?.decisions || [])
        .filter((decision) => decision.source === 'ask').map(cloneDecision),
      bindings: Object.fromEntries(this.askDecisionBindings.get(sessionId) || []),
      finishedOutsideEventsIds: [...(this.finishedOutsideEventsAskDecisionIds.get(sessionId) || [])],
    };
  }

  persistAskDecisionState(sessionId, session) {
    const plan = this.plans.get(sessionId);
    const storedAskDecisions = new Map((plan?.decisions || [])
      .filter((decision) => decision.source === 'ask').map((decision) => [decision.id, decision]));
    const askDecisions = session.decisions.filter((decision) => decision.source === 'ask').map((decision) => {
      const stored = storedAskDecisions.get(decision.id);
      return stored && Date.parse(stored.updatedAt) > Date.parse(decision.updatedAt)
        ? cloneDecision(stored)
        : cloneDecision(decision);
    });
    const existingAskDecisions = (plan?.decisions || []).filter((decision) => decision.source === 'ask');
    const askDecisionIds = new Set(askDecisions.map((decision) => decision.id));
    const nextDecisions = [
      ...(plan?.decisions || []).filter((decision) => decision.source !== 'ask'),
      ...askDecisions.filter((decision) => !(plan?.decisions || []).some((stored) => (
        stored.source !== 'ask' && stored.id === decision.id
      ))),
    ];
    let changed = false;
    if (askDecisions.length || existingAskDecisions.length) {
      const targetPlan = plan || this.planFor(sessionId);
      if (stableStringify(targetPlan.decisions) !== stableStringify(nextDecisions)) {
        targetPlan.decisions = nextDecisions;
        changed = true;
      }
    }

    const nextBindings = new Map(Object.entries(session.decisionBindings)
      .filter(([, decisionId]) => askDecisionIds.has(decisionId)));
    const currentBindings = this.askDecisionBindings.get(sessionId) || new Map();
    if (stableStringify(Object.fromEntries(currentBindings)) !== stableStringify(Object.fromEntries(nextBindings))) {
      if (nextBindings.size) this.askDecisionBindings.set(sessionId, nextBindings);
      else this.askDecisionBindings.delete(sessionId);
      changed = true;
    }
    return changed;
  }

  hasAgentRow(sessionId, agentId) {
    return Boolean(agentId && this.sessions.get(sessionId)?.agents.some((agent) => agent.agent_id === agentId));
  }

  sessionNameFor(sessionId) {
    return this.sessionFiles.get(sessionId)?.name || null;
  }

  sessionFileFor(sessionId) {
    return this.sessionFiles.get(sessionId) || null;
  }

  captureFieldNames(input) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return;
    const eventName = typeof input.hook_event_name === 'string' ? input.hook_event_name : '';
    const inputFields = Array.isArray(input.input_fields) ? input.input_fields : [];
    for (const key of inputFields) {
      if (typeof key === 'string' && key.length <= 100) this.fieldNames.add(`${eventName}.${key}`);
    }
    if (typeof input.notification_type === 'string' && input.notification_type.length <= 100) {
      this.notificationTypes.add(input.notification_type);
    }
  }

  correctInferredAskWithdrawal(event) {
    if (event.agent_id || event.tool_name !== 'AskUserQuestion' || !event.tool_use_id ||
      !['PostToolUse', 'PostToolUseFailure'].includes(event.hook_event_name)) return false;
    // 推定の取り下げは最新の呼び出しを finishedByToolUseId に持つ。出し直し前の呼び出しの終了は結果を説明しない。
    const stored = this.plans.get(event.session_id)?.decisions.find((decision) => decision.source === 'ask' &&
      decision.finishedByToolUseId === event.tool_use_id);
    if (!stored || stored.state !== 'withdrawn' || !Number.isFinite(stored.inferredWithdrawalHookAt) ||
      event.hookAt >= stored.inferredWithdrawalHookAt) return false;
    // 終了フックは別プロセスから遅れて届くため、推定の根拠より前の終了だけで保存状態を訂正する。
    Object.assign(stored, {
      state: event.hook_event_name === 'PostToolUse' ? 'resolved' : 'withdrawn',
      updatedAt: isoTime(event.hookAt),
      resolvedAt: isoTime(event.hookAt),
      resolution: event.hook_event_name === 'PostToolUse'
        ? cloneResolution(event.decisionResolution || { chosen: [], note: '' })
        : null,
      finishedByToolUseId: event.tool_use_id,
    });
    delete stored.inferredWithdrawalHookAt;
    return true;
  }

  withdrawFinishedDesktopAsks(event) {
    if (event.agent_id) return false;
    const isNextTool = event.hook_event_name === 'PreToolUse' && event.tool_use_id;
    if (!isNextTool && !['UserPromptSubmit', 'Stop'].includes(event.hook_event_name)) return false;
    const sessionId = event.session_id;
    const bindings = this.askDecisionBindings.get(sessionId) || new Map();
    const entries = this.entries.get(sessionId) || [];
    let changed = false;
    for (const decision of this.decisionsFor(sessionId)) {
      if (decision.source !== 'ask' || decision.state !== 'waiting') continue;
      // フックの回答待ちは再起動で期限を消しても配信を続けるため、記録の存在で保護する。
      if (this.decisionLifecycles.get(sessionId)?.has(decision.id)) continue;
      const stored = this.plans.get(sessionId)?.decisions.find((item) => item.id === decision.id);
      if (!stored) continue;
      const starts = entries.filter(({ event: start }) => start.hook_event_name === 'PreToolUse' &&
        start.tool_name === 'AskUserQuestion' && !start.agent_id && bindings.get(start.tool_use_id) === decision.id);
      starts.sort((left, right) => right.event.hookAt - left.event.hookAt || right.sequence - left.sequence);
      const start = starts[0]?.event;
      const storedStartAt = Date.parse(stored.updatedAt);
      const toolUseId = start && start.hookAt >= storedStartAt
        ? start.tool_use_id
        : [...bindings].reverse().find(([, id]) => id === decision.id)?.[0];
      if (!toolUseId || event.hookAt <= Math.max(start?.hookAt ?? -Infinity, storedStartAt)) continue;
      if (isNextTool && event.tool_use_id === toolUseId) continue;
      // 同じ質問の出し直しは既存の判断事項と回答を引き継ぐため、取り下げずに結び付ける。
      if (isNextTool && event.tool_name === 'AskUserQuestion' && sameQuestionSet(decision.questions, event.questions || [])) continue;
      Object.assign(stored, {
        state: 'withdrawn',
        updatedAt: isoTime(event.hookAt),
        resolvedAt: isoTime(event.hookAt),
        resolution: null,
        finishedByToolUseId: toolUseId,
        inferredWithdrawalHookAt: event.hookAt,
      });
      let finishedIds = this.finishedOutsideEventsAskDecisionIds.get(sessionId);
      if (!finishedIds) {
        finishedIds = new Set();
        this.finishedOutsideEventsAskDecisionIds.set(sessionId, finishedIds);
      }
      finishedIds.add(decision.id);
      changed = true;
    }
    return changed;
  }

  addEvent(input, metadata = {}) {
    const event = sanitizeEvent(input, metadata);
    if (!event) return false;
    const existingProvider = this.entries.get(event.session_id)?.[0]?.event.provider
      || this.sessions.get(event.session_id)?.provider;
    if (existingProvider && existingProvider !== event.provider) return false;
    if (!this.acceptSessionWrite(event.session_id, event.hookAt)) return true;

    const endedAt = this.endedAt.get(event.session_id);
    if (endedAt !== undefined && event.hook_event_name !== 'SessionStart') return true;
    if (endedAt !== undefined && event.hookAt <= endedAt) return true;

    const endedByAbsenceAt = this.endedByAbsence.get(event.session_id);
    if (endedByAbsenceAt !== undefined && event.hookAt <= endedByAbsenceAt) return true;

    const before = JSON.stringify([...this.sessions.values()]);
    const wasHidden = this.hiddenSessions.delete(event.session_id);
    if (wasHidden) this.hiddenSessionUpdatedAt.delete(event.session_id);
    if (endedAt !== undefined) {
      this.endedAt.delete(event.session_id);
      this.entries.delete(event.session_id);
      this.decisionOverrides.delete(event.session_id);
      this.sessionFileLastSeenAt.delete(event.session_id);
      this.closedAgents.delete(event.session_id);
    }
    if (endedByAbsenceAt !== undefined) {
      this.reopenAbsentSession(event.session_id);
      this.sessionFileLastSeenAt.set(event.session_id, event.hookAt);
    }

    const correctedAsk = this.correctInferredAskWithdrawal(event);
    const withdrawnAsk = this.withdrawFinishedDesktopAsks(event);
    const entries = this.entries.get(event.session_id) || [];
    const eventSequence = this.sequence++;
    entries.push({ event, sequence: eventSequence });
    this.entries.set(event.session_id, entries);
    const nextSessions = deriveSessions(entries, this.askDecisionStateFor(event.session_id), eventSequence);
    let askDecisionStateChanged = false;
    if (nextSessions.length > 0) {
      this.sessions.set(event.session_id, nextSessions[0]);
      askDecisionStateChanged = this.persistAskDecisionState(event.session_id, nextSessions[0]);
    }
    else this.sessions.delete(event.session_id);
    // 推定はターンが不明な間の補助なので、状態が確定したら消す。不明のままのイベントでは残す。
    // 許可待ちはターンの確定を待たずに優先して出るので、許可待ちでも残す。
    const derivedStatus = nextSessions[0]?.status;
    const hadEstimate = derivedStatus !== '不明' && derivedStatus !== '許可待ち' && this.estimates.delete(event.session_id);

    if (event.hook_event_name === 'SessionEnd') {
      this.endSession(event.session_id, event.hookAt);
    }

    const reopenedClosedAgent = event.agent_id && event.hook_event_name !== 'SubagentStop'
      ? this.closedAgents.get(event.session_id)?.delete(event.agent_id) : false;
    const clearedClosedAgent = this.reconcileClosedAgents(event.session_id) || reopenedClosedAgent;
    if (JSON.stringify([...this.sessions.values()]) !== before || hadEstimate || wasHidden || clearedClosedAgent) this.touch();
    if (wasHidden) this.requestStoreWrite();
    if (askDecisionStateChanged || withdrawnAsk || correctedAsk) this.requestStoreWrite();
    return true;
  }

  applyTaskNotifications(sessionId, notifications, now = Date.now()) {
    const agents = this.sessions.get(sessionId)?.agents || [];
    for (const agent of agents) {
      if (agent.isCodex || !agent.active) continue;
      const notification = notifications.get(agent.agent_id);
      if (!notification) continue;
      const recordedAt = Date.parse(notification.recordedAt);
      if (Number.isFinite(recordedAt) && recordedAt < Date.parse(agent.startedAt)) continue;
      if (!this.sessions.get(sessionId)?.agents.some((current) => current.agent_id === agent.agent_id && current.active)) continue;
      this.addEvent({ session_id: sessionId, hook_event_name: 'SubagentStop', agent_id: agent.agent_id,
        hookAt: Number.isFinite(recordedAt) ? recordedAt : now });
    }
  }

  // 読み取り中に状態が分かったセッションには推定を保存しない。
  saveEstimate(sessionId, estimate) {
    const current = this.snapshot().sessions.find((item) => item.session_id === sessionId);
    if (current?.status !== '不明') return null;
    const stored = estimate
      ? { canEstimate: true, recordedAt: estimate.recordedAt, lastTool: estimate.lastTool, state: estimate.state }
      : { canEstimate: false, recordedAt: null, lastTool: null, state: null };
    this.estimates.set(sessionId, stored);
    this.touch();
    return { ...stored };
  }

  hideSession(sessionId, now = Date.now()) {
    const session = this.snapshot().sessions.find((item) => item.session_id === sessionId);
    if (!session) return null;
    this.hiddenSessions.add(sessionId);
    this.hiddenSessionUpdatedAt.set(sessionId, isoTime(now));
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  unhideSessions(sessionIds) {
    let unhidden = 0;
    for (const sessionId of new Set(sessionIds)) {
      if (!this.hiddenSessions.delete(sessionId)) continue;
      this.hiddenSessionUpdatedAt.delete(sessionId);
      unhidden += 1;
    }
    if (unhidden > 0) {
      this.touch();
      this.requestStoreWrite();
    }
    return unhidden;
  }

  clearHiddenSessions() {
    const count = this.hiddenSessions.size;
    if (count > 0) {
      this.hiddenSessions.clear();
      this.hiddenSessionUpdatedAt.clear();
      this.touch();
      this.requestStoreWrite();
    }
    return count;
  }

  patchDisplayPreferences(changes) {
    const next = normalizeDisplay({ ...(this.display || defaultDisplay()), ...changes });
    if (this.display && JSON.stringify(this.display) === JSON.stringify(next)) return cloneDisplay(this.display);
    this.display = next;
    this.touch();
    this.requestStoreWrite();
    return cloneDisplay(this.display);
  }

  getDisplayPreferences() {
    return cloneDisplay(this.display || defaultDisplay());
  }

  closeTask(sessionId, title, now = Date.now()) {
    const task = this.plans.get(sessionId)?.tasks.find((item) => item.title === title);
    if (!task) return null;
    if (task.state === 'done') return false;
    this.closedTaskMapFor(sessionId).set(title, { stateAtClose: task.state, closedAt: isoTime(now) });
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  closeAgent(sessionId, agentId) {
    const agent = this.sessions.get(sessionId)?.agents.find((item) => item.agent_id === agentId);
    if (!agent) return null;
    if (!isClosableAgent(agent)) return false;
    let closed = this.closedAgents.get(sessionId);
    if (!closed) {
      closed = new Set();
      this.closedAgents.set(sessionId, closed);
    }
    if (!closed.has(agentId)) {
      closed.add(agentId);
      this.touch();
    }
    return true;
  }

  closedTaskMapFor(sessionId) {
    let tasks = this.closedTasks.get(sessionId);
    if (!tasks) {
      tasks = new Map();
      this.closedTasks.set(sessionId, tasks);
    }
    return tasks;
  }

  reconcileClosedAgents(sessionId) {
    const closed = this.closedAgents.get(sessionId);
    if (!closed) return false;
    const agents = this.sessions.get(sessionId)?.agents || [];
    let changed = false;
    for (const agentId of closed) {
      const agent = agents.find((item) => item.agent_id === agentId);
      if (!agent || !isClosableAgent(agent)) {
        closed.delete(agentId);
        changed = true;
      }
    }
    if (!closed.size) this.closedAgents.delete(sessionId);
    return changed;
  }

  setTasks(sessionId, tasks, now = Date.now()) {
    this.acceptSessionWrite(sessionId);
    const plan = this.planFor(sessionId);
    const previousTasks = new Map(plan.tasks.map((task) => [task.title, task]));
    const previousUpdatedAt = plan.tasksUpdatedAt;
    const updatedAt = isoTime(now);
    plan.tasks = tasks.map((task) => ({
      title: task.title,
      state: task.state,
      criteria: task.criteria.map((criterion) => ({ text: criterion.text, met: criterion.met })),
      ...(task.state === 'done' ? {
        completedAt: previousTasks.get(task.title)?.state === 'done'
          ? previousTasks.get(task.title).completedAt || previousUpdatedAt || updatedAt
          : updatedAt,
      } : {}),
    }));
    plan.tasksUpdatedAt = updatedAt;
    plan.product ||= cloneProduct(this.productForSession(sessionId));
    const closed = this.closedTasks.get(sessionId);
    if (closed) {
      for (const [title, record] of closed) {
        const current = plan.tasks.find((task) => task.title === title);
        if (!current || current.state !== record.stateAtClose) closed.delete(title);
      }
      if (!closed.size) this.closedTasks.delete(sessionId);
    }
    this.touch();
    this.requestStoreWrite();
    return { tasks: plan.tasks.map((task) => ({ ...task, criteria: task.criteria.map((item) => ({ ...item })) })), updatedAt: plan.tasksUpdatedAt };
  }

  addDecision(sessionId, input, now = Date.now()) {
    this.acceptSessionWrite(sessionId);
    const plan = this.planFor(sessionId);
    const timestamp = isoTime(now);
    plan.product ||= cloneProduct(this.productForSession(sessionId));
    const decision = {
      id: crypto.randomUUID(),
      session_id: sessionId,
      source: 'mcp',
      state: input.state,
      title: input.title,
      context: input.context,
      questions: [{
        question: input.title,
        header: '',
        multiSelect: false,
        options: input.options.map((option) => ({ ...option, recommended: option.recommended === true })),
      }],
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(input.state === 'provisional' ? { provisionalAt: timestamp } : {}),
      resolvedAt: null,
      answer: null,
      resolution: null,
    };
    const recommended = recommendedOptionFor(decision.questions[0]);
    if (recommended) recommended.recommended = true;
    plan.decisions.push(decision);
    this.touch();
    this.requestStoreWrite();
    return cloneDecision(decision);
  }

  updateDecision(sessionId, id, state, chosen, note, now = Date.now()) {
    const decisions = this.decisionsFor(sessionId);
    const decision = decisions.find((item) => item.id === id) || decisions.find((item) => (
      item.id === this.sessions.get(sessionId)?.decisionBindings?.[id]
    ));
    if (!decision || decision.state === 'resolved') return null;
    const timestamp = isoTime(now);
    const updated = {
      ...decision,
      state,
      updatedAt: timestamp,
      ...(state === 'provisional' && decision.state !== 'provisional' ? { provisionalAt: timestamp } : decision.provisionalAt ? { provisionalAt: decision.provisionalAt } : {}),
      resolvedAt: state === 'resolved' ? timestamp : null,
      resolution: { chosen, note },
    };
    const plan = this.plans.get(sessionId);
    const stored = plan?.decisions.find((item) => item.id === decision.id);
    const hasEventDecision = this.sessions.get(sessionId)?.decisions.some((item) => item.id === decision.id) === true;
    if (stored) Object.assign(stored, updated);
    if (stored?.source === 'ask' && !hasEventDecision && isFinishedAskDecision(updated)) {
      // 上書きを残さないので、後から届いた古い開始の知らせで作り直して巻き戻さないよう覚えておく。
      const ids = this.finishedOutsideEventsAskDecisionIds.get(sessionId) || new Set();
      ids.add(decision.id);
      this.finishedOutsideEventsAskDecisionIds.set(sessionId, ids);
    }
    if (!stored || hasEventDecision) {
      const overrides = this.decisionOverrides.get(sessionId) || new Map();
      overrides.set(decision.id, {
        state: updated.state,
        updatedAt: updated.updatedAt,
        ...(updated.provisionalAt ? { provisionalAt: updated.provisionalAt } : {}),
        resolvedAt: updated.resolvedAt,
        resolution: cloneResolution(updated.resolution),
      });
      this.decisionOverrides.set(sessionId, overrides);
    }
    const lifecycle = this.decisionLifecycles.get(sessionId)?.get(decision.id);
    if (lifecycle) {
      lifecycle.state = null;
      delete lifecycle.provisionalAt;
      lifecycle.updatedAt = isoTime(now);
    }
    this.touch();
    this.requestStoreWrite(Boolean(lifecycle));
    return cloneDecision(updated);
  }

  planSummary(sessionId) {
    const plan = this.plans.get(sessionId);
    return {
      tasks: (plan?.tasks || []).map(({ title, state }) => ({ title, state })),
      decisions: this.decisionsFor(sessionId)
        .filter((decision) => ['waiting', 'provisional'].includes(decision.state))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .map(({ id, title, state }) => ({ id, title, state })),
    };
  }

  planFor(sessionId) {
    let plan = this.plans.get(sessionId);
    if (!plan) {
      plan = { tasks: [], tasksUpdatedAt: null, product: cloneProduct(this.productForSession(sessionId)), decisions: [] };
      this.plans.set(sessionId, plan);
    }
    return plan;
  }

  productForSession(sessionId) {
    return this.sessions.get(sessionId)?.product || this.sessionFiles.get(sessionId)?.product || this.plans.get(sessionId)?.product || null;
  }

  decisionsFor(sessionId) {
    const eventDecisions = this.sessions.get(sessionId)?.decisions || [];
    const planDecisions = this.plans.get(sessionId)?.decisions || [];
    const eventDecisionIds = new Set(eventDecisions.map((decision) => decision.id));
    const overrides = this.decisionOverrides.get(sessionId);
    const lifecycles = this.decisionLifecycles.get(sessionId);
    return [...eventDecisions, ...planDecisions.filter((decision) => !eventDecisionIds.has(decision.id))].map((decision) => {
      const override = overrides?.get(decision.id);
      const withOverride = override && Date.parse(override.updatedAt) >= Date.parse(decision.updatedAt)
        ? { ...decision, ...override }
        : decision;
      const lifecycle = lifecycles?.get(decision.id);
      if (!lifecycle) return cloneDecision(withOverride);
      return cloneDecision({
        ...withOverride,
        ...(lifecycle.state ? { state: lifecycle.state } : {}),
        ...(lifecycle.updatedAt ? { updatedAt: lifecycle.updatedAt } : {}),
        ...(lifecycle.provisionalAt ? { provisionalAt: lifecycle.provisionalAt } : {}),
        answer: lifecycle.answer,
        ...(lifecycle.awaitingAnswerUntil ? { awaitingAnswerUntil: lifecycle.awaitingAnswerUntil } : {}),
      });
    });
  }

  decisionFor(sessionId, decisionId) {
    return this.decisionsFor(sessionId).find((decision) => decision.id === decisionId) || null;
  }

  decisionIdForToolUse(sessionId, toolUseId) {
    return this.sessions.get(sessionId)?.decisionBindings?.[toolUseId] ||
      this.askDecisionBindings.get(sessionId)?.get(toolUseId) || null;
  }

  // 終了の片付けはセッションを一覧から消した後にも呼ばれるので、判断事項を引かずに記録だけを直す。
  clearAwaitingAnswers(sessionId, now = Date.now()) {
    let changed = false;
    for (const lifecycle of this.decisionLifecycles.get(sessionId)?.values() || []) {
      if (!lifecycle.awaitingAnswerUntil) continue;
      lifecycle.awaitingAnswerUntil = null;
      lifecycle.updatedAt = isoTime(now);
      changed = true;
    }
    if (!changed) return;
    this.touch();
    this.requestStoreWrite(true);
  }

  setDecisionLifecycle(sessionId, decisionId, updates, now = Date.now()) {
    if (!this.decisionFor(sessionId, decisionId)) return null;
    const sourceDecision = this.sessions.get(sessionId)?.decisions.find((decision) => decision.id === decisionId) ||
      this.plans.get(sessionId)?.decisions.find((decision) => decision.id === decisionId);
    const override = this.decisionOverrides.get(sessionId)?.get(decisionId);
    const baseDecision = override && Date.parse(override.updatedAt) >= Date.parse(sourceDecision.updatedAt)
      ? { ...sourceDecision, ...override }
      : sourceDecision;
    const baseState = baseDecision.state;
    let lifecycles = this.decisionLifecycles.get(sessionId);
    if (!lifecycles) {
      lifecycles = new Map();
      this.decisionLifecycles.set(sessionId, lifecycles);
    }
    const current = lifecycles.get(decisionId) || { answer: null, awaitingAnswerUntil: null, state: null, updatedAt: null };
    const currentEffectiveState = current.state ?? baseState;
    const nextEffectiveState = Object.hasOwn(updates, 'state') ? updates.state ?? baseState : currentEffectiveState;
    const next = { ...current, ...updates };
    next.updatedAt = isoTime(now);
    delete next.provisionalAt;
    if (nextEffectiveState === 'provisional') {
      const provisionalAt = currentEffectiveState === 'provisional'
        ? current.provisionalAt || (baseState === 'provisional' ? baseDecision.provisionalAt : null) || (current.state ? current.updatedAt : baseDecision.updatedAt) || baseDecision.updatedAt
        : isoTime(now);
      if (provisionalAt) next.provisionalAt = provisionalAt;
    }
    lifecycles.set(decisionId, next);
    this.touch();
    this.requestStoreWrite(true);
    return this.decisionFor(sessionId, decisionId);
  }

  touch() {
    this.version += 1;
    this.generatedAt = new Date().toISOString();
  }

  snapshot() {
    const fileOnlySessions = [...this.sessionFiles.values()]
      .filter((file) => (
        !this.sessions.has(file.session_id) && !this.endedAt.has(file.session_id) && !this.endedByAbsence.has(file.session_id)
        && (!this.deletedSessions.has(file.session_id)
          || Date.parse(file.updatedAt) > Date.parse(this.deletedSessions.get(file.session_id)))
      ))
      .map((file) => ({
        session_id: file.session_id,
        product: file.product || null,
        title: file.name,
        status: '不明',
        tools: [],
        agents: [],
        permissionWaits: [],
        decisions: [],
      }));
    const sessionIds = new Set([
      ...this.sessions.keys(),
      ...fileOnlySessions.map((session) => session.session_id),
    ]);
    const currentSessions = [...sessionIds].map((sessionId) => {
      const session = this.sessions.get(sessionId);
      const file = this.sessionFiles.get(sessionId);
      const plan = this.plans.get(sessionId);
      const base = session || {
        session_id: sessionId,
        product: file?.product || null,
        title: file?.name || null,
        status: '不明',
        tools: [],
        agents: [],
        permissionWaits: [],
        decisions: [],
      };
      const { decisionBindings: _decisionBindings, ...visible } = base;
      const decisions = this.decisionsFor(sessionId);
      const closedAgents = this.closedAgents.get(sessionId) || new Set();
      const isClosedByUser = (agent) => closedAgents.has(agent.agent_id) && isClosableAgent(agent);
      const updateTimestamps = [base.lastActivityAt, plan?.tasksUpdatedAt, ...decisions.map((decision) => decision.updatedAt)]
        .filter((timestamp) => Number.isFinite(Date.parse(timestamp || '')));
      const lastUpdatedAt = updateTimestamps.reduce((latest, timestamp) => (
        !latest || Date.parse(timestamp) > Date.parse(latest) ? timestamp : latest
      ), null) || base.lastActivityAt || null;
      const current = {
        ...visible,
        provider: base.provider || 'claude',
        ...(base.codex ? { codex: { ...base.codex, resumes: base.codex.resumes + (this.codexResumesBeforeEnd.get(sessionId) || 0) } } : {}),
        title: this.sessionNameFor(sessionId) || base.title,
        product: base.product ? { ...base.product } : null,
        sessionFileUpdatedAt: file?.updatedAt || null,
        lastUpdatedAt,
        tools: base.tools.map((tool) => ({ ...tool })),
        agents: base.agents.map((agent) => {
          const closedByUser = isClosedByUser(agent);
          const snapshotAgent = closedByUser ? { ...agent, active: false, unconfirmed: false } : agent;
          return {
            ...snapshotAgent,
            ...(isClosableAgent(snapshotAgent) ? { closable: true } : {}),
            lastTool: agent.lastTool && { ...agent.lastTool },
          };
        }),
        ...(base.status === '待機中(サブエージェント稼働中)'
          && !base.agents.some((agent) => agent.active && !isClosedByUser(agent))
          ? { status: '待機中' }
          : {}),
        permissionWaits: base.permissionWaits.map((wait) => ({ ...wait })),
        decisions,
        tasks: (plan?.tasks || []).map((task) => {
          const closed = this.closedTasks.get(sessionId)?.get(task.title);
          const isClosedByUser = closed?.stateAtClose === task.state;
          return {
            ...task,
            ...(isClosedByUser ? { state: 'done', closedByUser: true } : {}),
            criteria: task.criteria.map((criterion) => ({ ...criterion })),
          };
        }),
        tasksUpdatedAt: plan?.tasksUpdatedAt || null,
        ...(isNonInteractiveSessionFile(file) ? { nonInteractive: true } : {}),
      };
      if (current.status === '不明' && file?.status === 'idle') {
        current.status = base.agents.some((agent) => agent.active && !isClosedByUser(agent))
          ? '待機中(サブエージェント稼働中)'
          : '待機中';
      }
      const estimate = this.estimates.get(sessionId);
      if (estimate && current.status === '不明') current.estimate = { ...estimate };
      if (this.hiddenSessions.has(sessionId)) {
        current.hidden = true;
        current.hiddenAt = this.hiddenSessionUpdatedAt.get(sessionId);
      }
      return current;
    });
    return {
      version: this.version,
      generatedAt: this.generatedAt,
      display: cloneDisplay(this.display),
      sessions: currentSessions,
    };
  }

  setProductSeen(productKey, at = Date.now()) {
    if (typeof productKey !== 'string' || productKey.trim().length === 0 || productKey.length > 500) return null;
    const milliseconds = typeof at === 'number' ? at : Date.parse(at || '');
    if (!Number.isFinite(milliseconds)) return null;
    const current = this.seenAtByProduct.get(productKey);
    if (current && Date.parse(current) >= milliseconds) return current;
    const seenAt = isoTime(milliseconds);
    this.seenAtByProduct.set(productKey, seenAt);
    this.touch();
    this.requestStoreWrite();
    return seenAt;
  }

  taskCompletionCandidates() {
    const candidates = [];
    for (const [sessionId, plan] of this.plans) {
      const product = cloneProduct(plan.product || this.productForSession(sessionId));
      for (const task of plan.tasks) {
        const closed = this.closedTasks.get(sessionId)?.get(task.title);
        const closedByUser = closed?.stateAtClose === task.state;
        const at = closedByUser ? closed.closedAt || plan.tasksUpdatedAt : task.state === 'done' ? task.completedAt || plan.tasksUpdatedAt : null;
        if (!at) continue;
        candidates.push({
          product, type: 'task', identity: `${sessionId}\0${task.title}`, at,
          text: `タスク「${task.title}」が完了した`, pullRequest: null,
        });
      }
    }
    return candidates;
  }

  pullRequestCreatedCandidates({ registrations, pullRequestTitles }) {
    return registrations.map((record) => {
      const identity = relatedPullRequestRecordKey(record.owner, record.repo, record.number);
      const title = pullRequestTitles.get(identity);
      return {
        product: cloneProduct(record.product) || repoProduct(record.owner, record.repo),
        type: 'pull-request',
        identity: `${record.owner}/${record.repo}#${record.number}`,
        at: record.addedAt,
        text: `${pullRequestLabel(record.number, title)}を作成した`,
        pullRequest: { identity, number: record.number, action: 'created', title },
      };
    });
  }

  // セッションの判断を先に取り、セッションに載っていない判断だけを計画から補う。
  provisionalDecisionCandidates(sessions) {
    const candidates = [];
    const sessionDecisionIds = new Set();
    for (const session of sessions) {
      for (const decision of session.decisions) {
        sessionDecisionIds.add(`${session.session_id}\0${decision.id}`);
        if (!decision.provisionalAt && decision.state !== 'provisional') continue;
        candidates.push({
          product: cloneProduct(session.product || this.plans.get(session.session_id)?.product),
          type: 'provisional',
          identity: `${session.session_id}\0${decision.id}`,
          at: decision.provisionalAt || decision.updatedAt,
          text: `判断「${decision.title}」を推奨案で仮に進めた`,
          pullRequest: null,
        });
      }
    }
    for (const [sessionId, plan] of this.plans) {
      const product = cloneProduct(plan.product || this.productForSession(sessionId));
      for (const decision of plan.decisions) {
        if (sessionDecisionIds.has(`${sessionId}\0${decision.id}`) || (!decision.provisionalAt && decision.state !== 'provisional')) continue;
        candidates.push({
          product,
          type: 'provisional',
          identity: `${sessionId}\0${decision.id}`,
          at: decision.provisionalAt || decision.updatedAt,
          text: `判断「${decision.title}」を推奨案で仮に進めた`,
          pullRequest: null,
        });
      }
    }
    return candidates;
  }

  // 記録のプロダクトをそのまま使う(cloneProduct を通さない)。
  ciFailureCandidates({ pullRequestTitles }) {
    return this.ciFailures.map((failure) => {
      const identity = relatedPullRequestRecordKey(failure.owner, failure.repo, failure.number);
      return {
        product: failure.product,
        type: 'ci-failure',
        identity: `${failure.owner}/${failure.repo}#${failure.number}`,
        at: failure.at,
        text: `PR #${failure.number} の CI が失敗した`,
        pullRequest: { identity, number: failure.number, action: 'ci-failure', title: pullRequestTitles.get(identity) },
      };
    });
  }

  mergedPullRequestCandidates(sources) {
    const candidates = [];
    for (const merged of sources.mergedPullRequests.values()) {
      const identity = relatedPullRequestRecordKey(merged.owner, merged.repo, merged.number);
      const title = sources.pullRequestTitles.get(identity);
      for (const product of mergedPullRequestProducts(merged, sources)) {
        candidates.push({
          product,
          type: 'merged-pull-request',
          identity: `${merged.owner}/${merged.repo}#${merged.number}`,
          at: merged.mergedAt,
          text: `${pullRequestLabel(merged.number, title)}をマージした`,
          pullRequest: { identity, number: merged.number, action: 'merged', title },
        });
      }
    }
    return candidates;
  }

  // 初回の表示で既存の変化を既読として扱うために、変化を集める前に呼ぶ。
  refreshSeenTimes(products, visibleProductKeys, now) {
    let seenChanged = false;
    for (const key of this.seenAtByProduct.keys()) {
      if (!products.has(key)) {
        this.seenAtByProduct.delete(key);
        seenChanged = true;
      }
    }
    let initialized = false;
    for (const product of products.values()) {
      if (visibleProductKeys.has(product.key) && !this.seenAtByProduct.has(product.key)) {
        this.seenAtByProduct.set(product.key, isoTime(now));
        initialized = true;
      }
    }
    if (initialized || seenChanged) {
      this.touch();
      this.requestStoreWrite();
    }
  }

  // 変化の元になる記録。種類ごとの取り出しと対象のプロダクトの絞り込みが、同じ記録を見る。
  sinceSeenSources(pullRequestGroups) {
    const registrations = this.pullRequestRegistrations();
    const records = [...registrations, ...this.relatedPullRequestRegistrations()];
    const storedMerged = [...this.mergedPullRequests.values()];
    return {
      registrations,
      pullRequestGroups,
      pullRequestTitles: collectPullRequestTitles(records, storedMerged),
      mergedPullRequests: collectMergedPullRequests(records, storedMerged),
    };
  }

  // 変化の元になる記録のどれかに載るプロダクトを集める。取り出しの関数が見る記録は、ここでも対象に加える。
  // 加え忘れると、その種類の変化は重複の除去で捨てられる。
  sinceSeenProducts(sessions, sources) {
    const products = new Map();
    const visibleProductKeys = new Set();
    const addProduct = (value) => {
      const product = cloneProduct(value);
      if (product && !products.has(product.key)) products.set(product.key, product);
      return product;
    };
    for (const session of sessions) {
      const product = addProduct(session.product);
      if (product) visibleProductKeys.add(product.key);
    }
    for (const group of sources.pullRequestGroups) {
      const product = addProduct(group.product || (group.owner && group.repo ? repoProduct(group.owner, group.repo) : null));
      if (product) visibleProductKeys.add(product.key);
    }
    for (const plan of this.plans.values()) addProduct(plan.product);
    for (const record of sources.registrations) addProduct(record.product || repoProduct(record.owner, record.repo));
    for (const record of this.ciFailures) addProduct(record.product);
    for (const merged of sources.mergedPullRequests.values()) {
      for (const product of mergedPullRequestProducts(merged, sources)) addProduct(product);
    }
    return { products, visibleProductKeys };
  }

  snapshotSinceSeen(sessions, pullRequestGroups = [], now = Date.now(), awayPeriods = []) {
    const sources = this.sinceSeenSources(pullRequestGroups);
    const { products, visibleProductKeys } = this.sinceSeenProducts(sessions, sources);

    this.refreshSeenTimes(products, visibleProductKeys, now);

    const candidates = [
      ...this.taskCompletionCandidates(),
      ...this.pullRequestCreatedCandidates(sources),
      ...this.provisionalDecisionCandidates(sessions),
      ...this.ciFailureCandidates(sources),
      ...this.mergedPullRequestCandidates(sources),
    ];
    const eventsByProduct = groupSinceSeenEvents(candidates, products);

    const sinceSeen = [];
    for (const product of products.values()) {
      const seenAt = this.seenAtByProduct.get(product.key);
      if (!seenAt) continue;
      const events = eventsSinceSeenWhileAway(eventsByProduct.get(product.key) || [], Date.parse(seenAt), awayPeriods, now);
      const items = foldPullRequestEvents(events);
      items.sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
      if (items.length) sinceSeen.push({ product, seenAt, items });
    }
    return {
      sinceSeen,
      seenAtByProduct: Object.fromEntries([...visibleProductKeys]
        .filter((key) => this.seenAtByProduct.has(key))
        .map((key) => [key, this.seenAtByProduct.get(key)])),
    };
  }

  devFields() {
    return {
      fields: [...this.fieldNames].sort(),
      notificationTypes: [...this.notificationTypes].sort(),
    };
  }
}

function collectPullRequestTitles(records, storedMerged) {
  const titles = new Map();
  const remember = (owner, repo, number, title) => {
    if (typeof title !== 'string' || !title) return;
    titles.set(relatedPullRequestRecordKey(owner, repo, number), title);
  };
  for (const record of records) remember(record.owner, record.repo, record.number, record.lastOpen?.title);
  for (const merged of storedMerged) {
    if (merged.title !== `#${merged.number}`) remember(merged.owner, merged.repo, merged.number, merged.title);
  }
  return titles;
}

function collectMergedPullRequests(records, storedMerged) {
  const mergedPullRequests = new Map();
  for (const merged of storedMerged) {
    mergedPullRequests.set(relatedPullRequestRecordKey(merged.owner, merged.repo, merged.number), merged);
  }
  for (const record of records) {
    if (record.state !== 'merged' || !record.mergedAt) continue;
    const key = relatedPullRequestRecordKey(record.owner, record.repo, record.number);
    if (mergedPullRequests.has(key)) continue;
    mergedPullRequests.set(key, {
      owner: record.owner,
      repo: record.repo,
      number: record.number,
      title: record.lastOpen?.title,
      mergedAt: record.mergedAt,
    });
  }
  return mergedPullRequests;
}

// 関連 PR は登録にプロダクトを持たないので、その PR をマージ済みとして載せている PR 群のプロダクトに出す。
function mergedPullRequestProducts(merged, { registrations, pullRequestGroups }) {
  const sameRepo = (owner, repo) => owner?.toLowerCase() === merged.owner.toLowerCase() && repo?.toLowerCase() === merged.repo.toLowerCase();
  const found = [
    ...registrations.filter((record) => sameRepo(record.owner, record.repo) && record.number === merged.number)
      .map((record) => cloneProduct(record.product) || repoProduct(merged.owner, merged.repo)),
    ...pullRequestGroups.filter((group) => sameRepo(group.owner, group.repo) && group.merged?.some((item) => item.number === merged.number))
      .map((group) => cloneProduct(group.product)).filter(Boolean),
  ];
  if (!found.length) return [repoProduct(merged.owner, merged.repo)];
  return [...new Map(found.map((product) => [product.key, product])).values()];
}

function pullRequestLabel(number, title) {
  return `PR #${number}${title ? `(${title})` : ''}`;
}

// 対象のプロダクトに無い候補、時刻を読めない候補、同じ内容の重複は捨てる。
function groupSinceSeenEvents(candidates, products) {
  const eventsByProduct = new Map([...products.keys()].map((key) => [key, []]));
  const eventKeys = new Set();
  for (const { product, type, identity, at, text, pullRequest } of candidates) {
    const timestamp = Date.parse(at || '');
    if (!product || !eventsByProduct.has(product.key) || !Number.isFinite(timestamp)) continue;
    const key = `${product.key}\0${type}\0${identity}\0${at}`;
    if (eventKeys.has(key)) continue;
    eventKeys.add(key);
    eventsByProduct.get(product.key).push({ at, type, text, ...(pullRequest ? { pullRequest } : {}) });
  }
  return eventsByProduct;
}

function isAwayAt(timestamp, awayPeriods, now) {
  return awayPeriods.some((period) => {
    if (!Number.isFinite(period.start)) return false;
    const end = period.end === null ? now : period.end;
    return Number.isFinite(end) && timestamp >= period.start && timestamp <= end;
  });
}

// 絞り込みの後でまとめる。先にまとめると、範囲外の変化がまとめた行の時刻と文に混ざる。
function eventsSinceSeenWhileAway(events, seenMilliseconds, awayPeriods, now) {
  return events.filter((event) => {
    const timestamp = Date.parse(event.at);
    return timestamp > seenMilliseconds && isAwayAt(timestamp, awayPeriods, now);
  });
}

// 同じ PR の作成、CI の失敗、マージを 1 行にまとめ、PR に紐づかない変化はそのまま返す。
function foldPullRequestEvents(events) {
  const pullRequestSummaries = new Map();
  const items = [];
  for (const event of events) {
    if (!event.pullRequest) {
      items.push(event);
      continue;
    }
    const { identity, number, action, title } = event.pullRequest;
    let summary = pullRequestSummaries.get(identity);
    if (!summary) {
      summary = { at: event.at, number, title, actions: new Set() };
      pullRequestSummaries.set(identity, summary);
    }
    if (Date.parse(event.at) > Date.parse(summary.at)) summary.at = event.at;
    if (!summary.title && title) summary.title = title;
    summary.actions.add(action);
  }
  for (const summary of pullRequestSummaries.values()) {
    items.push({ at: summary.at, type: 'pull-request-summary', text: pullRequestSummaryText(summary) });
  }
  return items;
}

// 題が無いときは「の CI」の前に空白を置く。全角括弧の書式をテストが完全一致で確かめる。
function pullRequestSummaryText({ number, title, actions }) {
  const prefix = pullRequestLabel(number, title);
  const hasCreated = actions.has('created');
  const hasMerged = actions.has('merged');
  if (actions.has('ci-failure')) {
    const failure = `${prefix}${title ? '' : ' '}の CI が失敗した`;
    const outcome = hasCreated && hasMerged
      ? '作成し、マージした'
      : hasCreated ? '作成した' : hasMerged ? 'マージした' : '';
    return `${failure}${outcome ? `。${outcome}` : ''}`;
  }
  if (hasCreated && hasMerged) return `${prefix}を作成し、マージした`;
  if (hasCreated) return `${prefix}を作成した`;
  return `${prefix}をマージした`;
}

function cloneResolution(resolution) {
  if (!resolution) return null;
  return {
    chosen: Array.isArray(resolution.chosen) ? [...resolution.chosen] : resolution.chosen,
    note: resolution.note,
  };
}

function cloneDecision(decision) {
  return {
    ...decision,
    questions: decision.questions.map((question) => ({
      ...question,
      options: question.options.map((option) => ({ ...option })),
    })),
    answer: decision.answer ? {
      ...decision.answer,
      ...(Array.isArray(decision.answer.picks) ? { picks: decision.answer.picks.map((labels) => [...labels]) } : {}),
    } : null,
    resolution: cloneResolution(decision.resolution),
  };
}

module.exports = { AwayState, atomicWriteAwayState, DashboardState, deriveSessions, claudeModelName, isAwayAt, pullRequestSummaryText };
