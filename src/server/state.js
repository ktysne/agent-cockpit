const crypto = require('node:crypto');
const { PlanUpdates } = require('./plan-updates');
const { WorktreeInfo } = require('./worktree-info');
const { validVerify, validText } = require('./request-validation');
const assert = require('node:assert/strict');
const { SessionEntries } = require('./session-entries');
const fs = require('node:fs/promises');
const path = require('node:path');
const { recommendedOptionFor, sanitizeEvent } = require('./events');
const { AtomicJsonWriter, atomicWriteJson } = require('./json-storage');
const { isCompleteCommitSha, isSha256Digest, parsePullRequestUrl, pullRequestKey, repositoryKey, validBranchName, validRepositoryPart } = require('./pull-request-utils');
const { cloneDisplay, defaultDisplay, normalizeDisplay } = require('./display-preferences');
const { codexWorktreeProduct } = require('./identity');
const {
  isoTime,
  isNonInteractiveSessionFile,
  fileStatusDecidesState,
  claudeModelName,
  isClosableAgent,
  sessionStatus,
  sameQuestionSet,
  isFinishedAskDecision,
  sessionStartFor,
  deriveSessions,
  cloneResolution,
  cloneDecision,
} = require('./session-projection');
const {
  collectPullRequestTitles,
  collectMergedPullRequests,
  mergedPullRequestProducts,
  groupByPullRequest,
  pullRequestLabel,
  orderedProviders,
  groupSinceSeenEvents,
  isAwayAt,
  eventsSinceSeenWhileAway,
  foldPullRequestEvents,
  pullRequestSummaryText,
} = require('./since-seen');
const {
  validProduct,
  cloneProduct,
  repoProduct,
} = require('./product-utils');

const { isStoredSessionId } = require('./session-ids');
const { isRecord } = require('./value-utils');
const { readWithRetry, storageFailure } = require('./read-retry');

const DEFAULT_AWAY_STATE = Object.freeze({ enabled: false, since: null, periods: Object.freeze([]) });
const SESSION_FILE_ABSENCE_END_MS = 60_000;
// 24 時間以上停止したセッションは、途中のツールやサブエージェントの表示を復元しない。
const ABSENT_SESSION_ENTRIES_RETENTION_MS = 24 * 60 * 60_000;
const TRANSIENT_NOTICE_MS = 60_000;
const STORE_WRITE_DELAY_MS = 500;
const STORE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_AWAY_PERIODS = 50;
const MAX_CODEX_RECOVERY_SESSIONS = 200;
const MAX_HIDDEN_ITEMS = 200;
const CODEX_RECOVERY_ACTIVITY_STEP_MS = 60_000;
const RESTORE_SESSION_CLEANUP_GRACE_MS = 10 * 60 * 1000;
const MERGED_PULL_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;
const STORE_PRUNE_MIN_INTERVAL_MS = 60_000;
const PULL_REQUEST_MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);
const MAX_HOOK_DELIVERY_RECORDS_PER_SESSION = 128;
const pullRequestRecordKey = pullRequestKey;
const relatedPullRequestRecordKey = pullRequestKey;
const pullRequestRepositoryKey = repositoryKey;

function validStoredSessionId(value) {
  return isStoredSessionId(value);
}

function validTimestamp(value, nullable = false) {
  return (nullable && value === null) || (typeof value === 'string' && Number.isFinite(Date.parse(value)));
}

function validHookDeliveryRecord(record) {
  return isRecord(record) && typeof record.deliveryId === 'string' && record.deliveryId.length > 0 && record.deliveryId.length <= 256 &&
    typeof record.requestKey === 'string' && record.requestKey.length > 0 && record.requestKey.length <= 1024 &&
    typeof record.action === 'string' && record.action.length > 0 && record.action.length <= 64 &&
    typeof record.requestId === 'string' && record.requestId.length > 0 && record.requestId.length <= 256 &&
    (record.generation === null || Number.isSafeInteger(record.generation)) && isRecord(record.response) &&
    Array.isArray(record.answerVersions) && record.answerVersions.every((item) => isRecord(item) &&
      typeof item.decisionId === 'string' && item.decisionId.length > 0 && item.decisionId.length <= 256 &&
      typeof item.version === 'string' && item.version.length > 0 && item.version.length <= 256 && typeof item.prompt === 'boolean') &&
    Array.isArray(record.notificationIds) && record.notificationIds.every((id) => typeof id === 'string' && id.length > 0 && id.length <= 256) &&
    (record.overflowId === null || (typeof record.overflowId === 'string' && record.overflowId.length > 0 && record.overflowId.length <= 256)) &&
    validTimestamp(record.createdAt) && validTimestamp(record.expiresAt) && validTimestamp(record.acknowledgedAt, true);
}

function normalizePendingHookDeliveries(value) {
  const normalized = new Map();
  if (!isRecord(value)) return normalized;
  for (const [sessionId, records] of Object.entries(value)) {
    if (!validStoredSessionId(sessionId) || !Array.isArray(records)) continue;
    const pending = new Map();
    for (const record of records) {
      if (!validHookDeliveryRecord(record)) continue;
      pending.set(record.requestKey, structuredClone(record));
    }
    const retained = [...pending.values()].sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    while (retained.length > MAX_HOOK_DELIVERY_RECORDS_PER_SESSION) {
      const oldestAcknowledged = retained.findIndex((record) => record.acknowledgedAt);
      if (oldestAcknowledged === -1) break;
      retained.splice(oldestAcknowledged, 1);
    }
    if (retained.length) normalized.set(sessionId, new Map(retained.map((record) => [record.requestKey, record])));
  }
  return normalized;
}

function normalizePendingSessionNotifications(value) {
  const normalized = new Map();
  if (!isRecord(value)) return normalized;
  for (const [sessionId, records] of Object.entries(value)) {
    if (!validStoredSessionId(sessionId) || !Array.isArray(records)) continue;
    const pending = records.filter((record) => isRecord(record) && typeof record.id === 'string' && record.id.length > 0 && record.id.length <= 256 &&
      typeof record.message === 'string' && record.message.length <= 8000 && validTimestamp(record.createdAt))
      .map((record) => ({ id: record.id, message: record.message, createdAt: record.createdAt }));
    if (pending.length) normalized.set(sessionId, pending);
  }
  return normalized;
}

function normalizePendingSessionNotificationOverflow(value) {
  const normalized = new Map();
  if (!isRecord(value)) return normalized;
  for (const [sessionId, record] of Object.entries(value)) {
    if (!validStoredSessionId(sessionId) || !isRecord(record) || typeof record.id !== 'string' || record.id.length === 0 || record.id.length > 256 ||
      !Number.isSafeInteger(record.count) || record.count < 1 || !validTimestamp(record.updatedAt)) continue;
    normalized.set(sessionId, { id: record.id, count: record.count, updatedAt: record.updatedAt });
  }
  return normalized;
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

// lastOpen の中の値は保存中の記録と共有しているので、正規化で作り直した階層だけを凍結する。
function freezeRegistrations(registrations) {
  for (const record of registrations) {
    for (const key of ['product', 'lastOpen', 'mergedHead']) if (record[key]) Object.freeze(record[key]);
    Object.freeze(record);
  }
  return Object.freeze(registrations);
}

function validStoredPlan(plan) {
  return isRecord(plan) && Array.isArray(plan.tasks) && validTimestamp(plan.tasksUpdatedAt, true) &&
    (plan.product === undefined || plan.product === null || validProduct(plan.product)) &&
    (plan.provider === undefined || ['claude', 'codex'].includes(plan.provider)) &&
    plan.tasks.every((task) => isRecord(task) && typeof task.title === 'string' && task.title.length <= 200 &&
      ['todo', 'doing', 'done'].includes(task.state) && Array.isArray(task.criteria) &&
      task.criteria.every((item) => isRecord(item) && typeof item.text === 'string' && typeof item.met === 'boolean' &&
        (item.doing === undefined || typeof item.doing === 'boolean')) &&
      (task.completedAt === undefined || validTimestamp(task.completedAt))) &&
    Array.isArray(plan.decisions) && plan.decisions.every((decision) => isRecord(decision) &&
      typeof decision.id === 'string' && typeof decision.title === 'string' && typeof decision.state === 'string' &&
      Array.isArray(decision.questions) && decision.questions.every((question) => isRecord(question) && Array.isArray(question.options) &&
        question.options.every(option => option.next === undefined || validText(option.next, 2000, true))) &&
      (decision.verify === undefined || validVerify(decision.verify, true)) &&
      (decision.closedByUser === undefined || typeof decision.closedByUser === 'boolean') &&
      (decision.launchRequestedAt === undefined || validTimestamp(decision.launchRequestedAt)) &&
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

function validCrossReviewDeferral(record) {
  return validCrossReviewSkip(record) && typeof record.next === 'string' &&
    record.next.trim().length > 0 && record.next.length <= 2000;
}

function normalizeCrossReviewDeferral(record) {
  return { ...normalizeCrossReviewSkip(record), next: record.next };
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
    (record.provider !== undefined && !['claude', 'codex'].includes(record.provider)) ||
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
    provider: record.provider || 'claude',
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
    (record.previousBaseRefName === undefined || validBranchName(record.previousBaseRefName)) &&
    (record.completed === undefined || typeof record.completed === 'boolean');
}

function validMergedPullRequest(record) {
  if (!isRecord(record) || !validRepositoryPart(record.owner) || !validRepositoryPart(record.repo) ||
    !Number.isSafeInteger(record.number) || record.number < 1 || typeof record.title !== 'string' || record.title.length > 500 ||
    !validTimestamp(record.mergedAt) || ![null, 'merge', 'squash', 'rebase'].includes(record.method) ||
    typeof record.automatic !== 'boolean' || typeof record.url !== 'string' ||
    (record.reservedHeadRefOid !== undefined && record.reservedHeadRefOid !== null && !isCompleteCommitSha(record.reservedHeadRefOid)) ||
    (record.mergedHeadRefOid !== undefined && record.mergedHeadRefOid !== null && !isCompleteCommitSha(record.mergedHeadRefOid)) ||
    (record.headMismatch !== undefined && typeof record.headMismatch !== 'boolean') ||
    (record.historyMerged !== undefined && record.historyMerged !== true) ||
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
  const allowedKeys = new Set(['session_id', 'owner', 'repo', 'number', 'url', 'method', 'deleteBranch', 'createdAt', 'targetBranch', 'kind', 'headRefOid', 'runId', 'order', 'total']);
  return isRecord(record) && validStoredSessionId(record.session_id) && validRepositoryPart(record.owner) && validRepositoryPart(record.repo) &&
    Object.keys(record).every((key) => allowedKeys.has(key)) &&
    (record.kind === undefined || (record.kind === 'stack' && isCompleteCommitSha(record.headRefOid) &&
      typeof record.runId === 'string' && /^[a-f0-9-]{36}$/.test(record.runId) &&
      Number.isSafeInteger(record.order) && Number.isSafeInteger(record.total) &&
      record.total >= 2 && record.total <= 20 && record.order >= 1 && record.order <= record.total &&
      record.method === 'merge' && record.deleteBranch === true && validBranchName(record.targetBranch))) &&
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

function normalizeCodexRecovery(value) {
  if (!isRecord(value)) return new Map();
  return new Map(Object.entries(value)
    .filter(([id, record]) => validStoredSessionId(id) && isRecord(record) &&
      Number.isInteger(record.pid) && record.pid > 0 && typeof record.cwd === 'string' &&
      typeof record.model === 'string' && Number.isInteger(record.resumes) && record.resumes >= 0 &&
      validTimestamp(record.updatedAt) && (record.lockSeen === undefined || typeof record.lockSeen === 'boolean'))
    .sort(([, left], [, right]) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
    .slice(0, MAX_CODEX_RECOVERY_SESSIONS)
    .map(([id, record]) => [id, {
      pid: record.pid, cwd: record.cwd.slice(0, 4096), model: record.model.slice(0, 160),
      resumes: record.resumes, updatedAt: record.updatedAt,
      ...(record.lockSeen === true ? { lockSeen: true } : {}),
    }]));
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
        ...(task.autoTitle === true ? { autoTitle: true } : {}),
        state: task.state,
        criteria: task.criteria.map((item) => ({
          text: item.text,
          met: item.met,
          ...(item.doing === true ? { doing: true } : {}),
        })),
        ...(task.completedAt ? { completedAt: task.completedAt } : {}),
      })),
      tasksUpdatedAt: plan.tasksUpdatedAt,
      ...(plan.appTasks === true ? { appTasks: true } : {}),
      product: cloneProduct(plan.product),
      ...(plan.provider ? { provider: plan.provider } : {}),
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
        (lifecycle.updatedAt !== undefined && lifecycle.updatedAt !== null && !validTimestamp(lifecycle.updatedAt)) ||
        (lifecycle.askToolUseId !== undefined && typeof lifecycle.askToolUseId !== 'string')) {
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
        ...(lifecycle.askToolUseId ? { askToolUseId: lifecycle.askToolUseId.slice(0, 256) } : {}),
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
  const hiddenDecisions = value.hiddenDecisions === undefined ? [] : value.hiddenDecisions;
  const hiddenPrs = value.hiddenPrs === undefined ? [] : value.hiddenPrs;
  if (!Array.isArray(hiddenDecisions) || hiddenDecisions.length > MAX_HIDDEN_ITEMS || hiddenDecisions.some(record =>
    !isRecord(record) || !validStoredSessionId(record.session_id) || typeof record.id !== 'string' || !record.id.length || record.id.length > 256)) {
    throw new Error('Invalid hidden decisions');
  }
  if (!Array.isArray(hiddenPrs) || hiddenPrs.length > MAX_HIDDEN_ITEMS || hiddenPrs.some(record =>
    !isRecord(record) || !validRepositoryPart(record.owner) || !validRepositoryPart(record.repo)
      || !Number.isSafeInteger(record.number) || record.number <= 0)) throw new Error('Invalid hidden pull requests');
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
  const crossReviewDeferrals = value.crossReviewDeferrals === undefined ? [] : value.crossReviewDeferrals;
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
    !Array.isArray(crossReviewSkips) || !crossReviewSkips.every(validCrossReviewSkip) ||
    !Array.isArray(crossReviewDeferrals) || !crossReviewDeferrals.every(validCrossReviewDeferral)) {
    throw new Error('Invalid pull request records');
  }
  return {
    display,
    codexRecovery: normalizeCodexRecovery(value.codexRecovery),
    plans,
    askDecisionBindings,
    decisionLifecycles,
    pendingHookDeliveries: normalizePendingHookDeliveries(value.pendingHookDeliveries),
    pendingSessionNotifications: normalizePendingSessionNotifications(value.pendingSessionNotifications),
    pendingSessionNotificationOverflow: normalizePendingSessionNotificationOverflow(value.pendingSessionNotificationOverflow),
    closedTasks,
    hiddenSessions,
    hiddenDecisions,
    hiddenPrs,
    deletedSessions,
    prs: prs.map(normalizePullRequestRecord),
    relatedPrs: relatedPrs.map(normalizeRelatedPullRequestRecord),
    retargetedPrs: retargetedPrs.map((record) => ({ ...record })),
    mergedPrs: mergedPrs.map((record) => ({ ...record })),
    mergeReservations: mergeReservations.map((record) => ({ ...record })),
    stackMergeResults: (Array.isArray(value.stackMergeResults) ? value.stackMergeResults : []).filter((record) =>
      isRecord(record) && validRepositoryPart(record.owner) && validRepositoryPart(record.repo) &&
      typeof record.runId === 'string' && /^[a-f0-9-]{36}$/.test(record.runId) && validTimestamp(record.at) &&
      typeof record.message === 'string' && record.message.length <= 5000 &&
      (record.closedAt === undefined || validTimestamp(record.closedAt))),
    mergeIntents: mergeIntents.map((record) => ({
      ...record,
      stackedPullRequests: record.stackedPullRequests.map((item) => ({ ...item })),
    })),
    lastPullRequestMethods: new Map(Object.entries(lastPullRequestMethods)),
    seenAtByProduct: new Map(Object.entries(seenAtByProduct)),
    ciFailures: ciFailures.map((record) => ({ ...record, product: cloneProduct(record.product) })),
    crossReviewSkips: crossReviewSkips.map(normalizeCrossReviewSkip),
    crossReviewDeferrals: crossReviewDeferrals.map(normalizeCrossReviewDeferral),
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

  static async load(homeDir, fileSystem = fs, writer = null, readRetryOptions = {}) {
    let contents;
    try {
      contents = await readWithRetry(() => fileSystem.readFile(path.join(homeDir, 'away.json'), 'utf8'), readRetryOptions);
    } catch (error) {
      if (error.code !== 'ENOENT') throw storageFailure(error, 'away.json', 'read');
      return new AwayState(homeDir, DEFAULT_AWAY_STATE, fileSystem, writer);
    }

    let value;
    try {
      value = JSON.parse(contents);
    } catch {
      return new AwayState(homeDir, DEFAULT_AWAY_STATE, fileSystem, writer);
    }
    const normalized = normalizeAwayState(value);
    if (!normalized) return new AwayState(homeDir, DEFAULT_AWAY_STATE, fileSystem, writer);

    const away = new AwayState(homeDir, normalized, fileSystem, writer);
    if (JSON.stringify(value) !== JSON.stringify(away.value)) await away.persistCurrent();
    await away.prune([], Date.now());
    return away;
  }

  snapshot(deadline) {
    for (const period of this.value.periods) {
      if (period.end !== null) deadline?.propose(period.end + STORE_RETENTION_MS + 1);
    }
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

class DashboardState {
  constructor(options = {}) {
    this.homeDir = options.homeDir || null;
    this.fileSystem = options.fileSystem || fs;
    this.storeWriter = options.writer || (this.homeDir ? new AtomicJsonWriter(this.homeDir, { fileSystem: this.fileSystem }) : null);
    this.perf = options.perf || null;
    this.verifyEntries = options.verifyEntries ?? process.env.AGENT_COCKPIT_VERIFY_ENTRIES === '1';
    this.entries = new SessionEntries(this.verifyEntries);
    this.hookCwds = new Map();
    this.worktreeInfo = new WorktreeInfo({ ...options.worktreeOptions, onChange: () => this.touch() });
    this.sequence = 0;
    this.version = 0;
    this.generatedAt = new Date().toISOString();
    this.sessions = new Map();
    this.claudeSessionModels = new Map();
    this.endedAt = new Map();
    this.endedByAbsence = new Map();
    this.lockMissingReported = new Set();
    this.fieldNames = new Set();
    this.notificationTypes = new Set();
    this.sessionFiles = new Map();
    this.sessionFileLastSeenAt = new Map();
    this.plans = new Map();
    this.planUpdates = new PlanUpdates();
    this.askDecisionBindings = new Map();
    // 保存済み、MCP、後続イベントで終えた質問は、開始と終了のフックだけで再現できないため状態を保つ。
    this.finishedOutsideEventsAskDecisionIds = new Map();
    this.decisionOverrides = new Map();
    this.decisionLifecycles = new Map();
    this.pendingHookDeliveries = new Map();
    this.pendingSessionNotifications = new Map();
    this.pendingSessionNotificationOverflow = new Map();
    this.estimates = new Map();
    this.hiddenSessions = new Set();
    this.hiddenDecisions = new Map();
    this.hiddenPrs = new Map();
    this.hiddenSessionUpdatedAt = new Map();
    this.deletedSessions = new Map();
    this.closedTasks = new Map();
    this.pullRequests = new Map();
    this.pullRequestRegistrationCache = null;
    this.lastStorePruneAt = null;
    this.relatedPullRequests = new Map();
    this.pullRequestConflictRequests = new Map();
    this.pullRequestRetargets = [];
    this.mergedPullRequests = new Map();
    this.pullRequestMergeReservationRecords = new Map();
    this.stackMergeResults = new Map();
    this.pullRequestMergeReservationNotices = new Map();
    this.pullRequestMergeIntentRecords = new Map();
    this.pullRequestClosureGenerations = new Map();
    this.lastPullRequestMethods = new Map();
    this.seenAtByProduct = new Map();
    this.ciFailures = [];
    this.crossReviewSkips = new Map();
    this.crossReviewDeferrals = new Map();
    this.closedAgents = new Map();
    // イベントから再構成できない復元済みの回数と、SessionEnd で捨てた回数を保持する。
    this.codexResumesBeforeEnd = new Map();
    this.codexRecovery = new Map();
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
      contents = await readWithRetry(() => state.fileSystem.readFile(path.join(homeDir, 'store.json'), 'utf8'), options.readRetryOptions);
    } catch (error) {
      if (error.code !== 'ENOENT') throw storageFailure(error, 'store.json', 'read');
      state.restoreSessionCleanupPending = true;
      return state;
    }

    try {
      const parsed = JSON.parse(contents);
      const before = stableStringify(parsed);
      const normalized = normalizeStore(parsed);
      state.restoreStore(normalized, options.now ?? Date.now());
      state.repairCodexWorktreePullRequestProducts(options.codexHome);
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
    try {
      await this.fileSystem.rename(path.join(this.homeDir, 'store.json'), target);
    } catch (error) {
      throw storageFailure(error, 'store.json', 'quarantine');
    }
  }

  restoreStore(store, now) {
    this.restoreSessionCleanupPending = true;
    this.restoredAt = now;
    this.display = store.display;
    this.codexRecovery = store.codexRecovery;
    this.codexResumesBeforeEnd = new Map([...store.codexRecovery].map(([id, record]) => [id, record.resumes]));
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
        else {
          delete lifecycle.awaitingAnswerUntil;
          if (lifecycle.answer && typeof lifecycle.answer.version !== 'string') lifecycle.answer.version = crypto.randomUUID();
        }
      }
      if (!lifecycles.size) this.decisionLifecycles.delete(sessionId);
    }
    this.pendingHookDeliveries = store.pendingHookDeliveries;
    this.pendingSessionNotifications = store.pendingSessionNotifications;
    this.pendingSessionNotificationOverflow = store.pendingSessionNotificationOverflow;
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
    for (const record of store.hiddenDecisions) this.hiddenDecisions.set(`${record.session_id}\0${record.id}`, { session_id: record.session_id, id: record.id });
    for (const record of store.hiddenPrs) this.hiddenPrs.set(relatedPullRequestRecordKey(record.owner, record.repo, record.number), { owner: record.owner, repo: record.repo, number: record.number });
    for (const record of store.prs) {
      let records = this.pullRequests.get(record.session_id);
      if (!records) {
        records = new Map();
        this.pullRequests.set(record.session_id, records);
      }
      records.set(pullRequestRecordKey(record.owner, record.repo, record.number), record);
    }
    this.invalidatePullRequestRegistrationCache();
    this.relatedPullRequests = new Map(store.relatedPrs.map((record) => [
      relatedPullRequestRecordKey(record.owner, record.repo, record.number), record,
    ]));
    this.pullRequestRetargets = store.retargetedPrs;
    this.mergedPullRequests = new Map(store.mergedPrs.map((record) => [
      relatedPullRequestRecordKey(record.owner, record.repo, record.number), record,
    ]));
    for (const record of [...this.readOnlyPullRequestRegistrations(), ...this.relatedPullRequestRegistrations()]) {
      if (['merged', 'closed'].includes(record.state)) this.hiddenPrs.delete(relatedPullRequestRecordKey(record.owner, record.repo, record.number));
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
    this.stackMergeResults = new Map(store.stackMergeResults.map((record) => [record.runId, record]));
    this.pullRequestMergeReservationNotices = new Map();
    this.pullRequestMergeIntentRecords = new Map(store.mergeIntents.map((record) => [
      relatedPullRequestRecordKey(record.owner, record.repo, record.number), record,
    ]));
    this.lastPullRequestMethods = store.lastPullRequestMethods;
    this.crossReviewSkips = new Map(store.crossReviewSkips.map((record) => [
      relatedPullRequestRecordKey(record.owner, record.repo, record.number), record,
    ]));
    this.crossReviewDeferrals = new Map(store.crossReviewDeferrals.map((record) => [
      relatedPullRequestRecordKey(record.owner, record.repo, record.number), record,
    ]));
    this.pruneExpiredStoreRecords(now);
    this.pruneHiddenDecisions();
  }

  pruneExpiredStoreRecords(now) {
    this.lastStorePruneAt = now;
    for (const [sessionId, endedAt] of this.endedByAbsence) {
      if (now - endedAt <= ABSENT_SESSION_ENTRIES_RETENTION_MS) continue;
      const entries = this.entries.get(sessionId);
      if (!entries?.length) continue;
      const retained = [sessionStartFor(entries[0]), ...entries.slice(1).filter(({ event }) => (
        event.provider === 'codex' && !event.agent_id && event.hook_event_name === 'SessionStart' && event.source === 'resume'
      ))];
      if (retained.length !== entries.length || retained[0] !== entries[0]) this.entries.replace(sessionId, retained);
    }
    let mergeHistoryChanged = false;
    let sessionRecordsChanged = false;
    for (const [sessionId, records] of this.pendingHookDeliveries) {
      const retained = new Map([...records].filter(([, record]) => Date.parse(record.expiresAt) > now));
      if (retained.size === records.size) continue;
      if (retained.size) this.pendingHookDeliveries.set(sessionId, retained);
      else this.pendingHookDeliveries.delete(sessionId);
      sessionRecordsChanged = true;
    }
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
        ...this.pendingSessionNotifications.keys(), ...this.pendingSessionNotificationOverflow.keys(),
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
    // 登録の Map のキーは relatedPullRequestRecordKey と同じ規則で作る。マージを記録するたびに呼ぶので、登録一覧を組み立てない。
    const retainedPullRequestKeys = this.crossReviewSkips.size || this.crossReviewDeferrals.size ? new Set([
      ...[...this.pullRequests.values()].flatMap((records) => [...records.keys()]),
      ...this.relatedPullRequests.keys(),
    ]) : null;
    for (const records of [this.crossReviewSkips, this.crossReviewDeferrals]) {
      for (const key of records.keys()) {
        if (retainedPullRequestKeys.has(key)) continue;
        records.delete(key);
        crossReviewSkipsChanged = true;
      }
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
    for (const record of this.pendingSessionNotifications.get(sessionId) || []) timestamps.push(Date.parse(record.createdAt));
    const overflow = this.pendingSessionNotificationOverflow.get(sessionId);
    if (overflow) timestamps.push(Date.parse(overflow.updatedAt));
    const finite = timestamps.filter(Number.isFinite);
    return finite.length ? Math.max(...finite) : NaN;
  }

  deleteStoredSession(sessionId, { keepPullRequests = false } = {}) {
    this.planUpdates.delete(sessionId);
    this.plans.delete(sessionId);
    this.askDecisionBindings.delete(sessionId);
    this.finishedOutsideEventsAskDecisionIds.delete(sessionId);
    this.decisionLifecycles.delete(sessionId);
    this.closedTasks.delete(sessionId);
    this.pendingHookDeliveries.delete(sessionId);
    this.pendingSessionNotifications.delete(sessionId);
    this.pendingSessionNotificationOverflow.delete(sessionId);
    if (!keepPullRequests && this.pullRequests.delete(sessionId)) this.invalidatePullRequestRegistrationCache();
  }

  deleteSession(sessionId, now = Date.now()) {
    if (!this.snapshot().sessions.some((session) => session.session_id === sessionId)) return false;
    for (const records of [this.entries, this.sessions, this.endedAt, this.endedByAbsence,
      this.decisionOverrides, this.estimates, this.hiddenSessions, this.hiddenSessionUpdatedAt,
      this.closedAgents, this.sessionFileLastSeenAt, this.hookCwds]) records.delete(sessionId);
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
        ...(task.autoTitle === true ? { autoTitle: true } : {}),
        state: task.state,
        criteria: task.criteria.map((item) => ({
          text: item.text,
          met: item.met,
          ...(item.doing === true ? { doing: true } : {}),
        })),
        ...(task.completedAt ? { completedAt: task.completedAt } : {}),
      })),
      tasksUpdatedAt: plan.tasksUpdatedAt,
      ...(plan.appTasks === true ? { appTasks: true } : {}),
      product: cloneProduct(plan.product),
      ...(plan.provider ? { provider: plan.provider } : {}),
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
    const pendingHookDeliveries = Object.fromEntries([...this.pendingHookDeliveries]
      .map(([sessionId, records]) => [sessionId, [...records.values()].map((record) => structuredClone(record))]));
    const pendingSessionNotifications = Object.fromEntries([...this.pendingSessionNotifications]
      .map(([sessionId, records]) => [sessionId, records.map((record) => ({ ...record }))]));
    const pendingSessionNotificationOverflow = Object.fromEntries([...this.pendingSessionNotificationOverflow]
      .map(([sessionId, record]) => [sessionId, { ...record }]));
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
      codexRecovery: Object.fromEntries(this.codexRecovery),
      display: cloneDisplay(this.display),
      plans,
      askDecisionBindings,
      decisionLifecycles,
      pendingHookDeliveries,
      pendingSessionNotifications,
      pendingSessionNotificationOverflow,
      closedTasks,
      hiddenSessions,
      hiddenDecisions: [...this.hiddenDecisions.values()],
      hiddenPrs: [...this.hiddenPrs.values()],
      deletedSessions: Object.fromEntries(this.deletedSessions),
      prs: this.pullRequestRegistrations(),
      relatedPrs: [...this.relatedPullRequests.values()].map(normalizeRelatedPullRequestRecord),
      retargetedPrs: this.pullRequestRetargets.map((record) => ({ ...record })),
      mergedPrs: [...this.mergedPullRequests.values()].map((record) => ({ ...record })),
      mergeReservations: [...this.pullRequestMergeReservationRecords.values()].map((record) => ({ ...record })),
      stackMergeResults: [...this.stackMergeResults.values()],
      mergeIntents: [...this.pullRequestMergeIntentRecords.values()].map((record) => ({
        ...record,
        stackedPullRequests: record.stackedPullRequests.map((item) => ({ ...item })),
      })),
      lastPullRequestMethods: Object.fromEntries(this.lastPullRequestMethods),
      seenAtByProduct: Object.fromEntries(this.seenAtByProduct),
      ciFailures: this.ciFailures.map((record) => ({ ...record, product: cloneProduct(record.product) })),
      crossReviewSkips: [...this.crossReviewSkips.values()].map(normalizeCrossReviewSkip),
      crossReviewDeferrals: [...this.crossReviewDeferrals.values()].map(normalizeCrossReviewDeferral),
    };
  }

  pullRequestRegistrations() {
    return structuredClone(this.pullRequestRegistrationSnapshot().registrations);
  }

  /** 索引と共有する凍結済みの登録一覧を返す。書き換える呼び出し側は pullRequestRegistrations() の複製を使う。 */
  readOnlyPullRequestRegistrations() {
    return this.pullRequestRegistrationSnapshot().registrations;
  }

  pullRequestRegistrationSnapshot() {
    if (this.pullRequestRegistrationCache) return this.pullRequestRegistrationCache;
    const registrations = freezeRegistrations([...this.pullRequests.values()].flatMap((records) => [...records.values()].map(normalizePullRequestRecord)));
    const registrationsByRepo = new Map();
    const providersByPullRequest = new Map();
    for (const record of registrations) {
      const repository = pullRequestRepositoryKey(record.owner, record.repo);
      let repositoryRegistrations = registrationsByRepo.get(repository);
      if (!repositoryRegistrations) {
        repositoryRegistrations = [];
        registrationsByRepo.set(repository, repositoryRegistrations);
      }
      repositoryRegistrations.push(record);
      const key = pullRequestRecordKey(record.owner, record.repo, record.number);
      let providers = providersByPullRequest.get(key);
      if (!providers) {
        providers = new Set();
        providersByPullRequest.set(key, providers);
      }
      providers.add(record.provider);
    }
    this.pullRequestRegistrationCache = {
      registrations,
      registrationsByRepo,
      providersByPullRequest: new Map([...providersByPullRequest].map(([key, providers]) => [key, orderedProviders(providers)])),
    };
    return this.pullRequestRegistrationCache;
  }

  invalidatePullRequestRegistrationCache() {
    this.pullRequestRegistrationCache = null;
  }

  // 保存済みの PR 登録の製品を、登録自身の cwd で Codex の worktree として畳み直す。
  // セッションの cwd で一括に置き換えると、別のリポジトリから登録した PR の場所を失うため。
  repairCodexWorktreePullRequestProducts(codexHome) {
    for (const records of this.pullRequests.values()) {
      for (const [key, record] of records) {
        if (!record.cwd || !record.product) continue;
        const product = codexWorktreeProduct(record.cwd, { codexHome });
        if (!product || product.key === record.product.key) continue;
        // 移行先の既読時刻は早いほうを採る。遅いほうを採ると、旧鍵で未読だった変化が既読になるため。
        const previousSeenAt = this.seenAtByProduct.get(record.product.key);
        const currentSeenAt = this.seenAtByProduct.get(product.key);
        if (previousSeenAt && (!currentSeenAt || previousSeenAt < currentSeenAt)) this.seenAtByProduct.set(product.key, previousSeenAt);
        records.set(key, { ...record, product });
      }
    }
    this.invalidatePullRequestRegistrationCache();
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
    if (current && stableStringify(current) === stableStringify(next) && !this.crossReviewDeferrals.has(key)) return { ...current };
    this.crossReviewDeferrals.delete(key);
    this.crossReviewSkips.set(key, next);
    this.touch();
    this.requestStoreWrite();
    return { ...next };
  }

  crossReviewDeferral(owner, repo, number) {
    const record = this.crossReviewDeferrals.get(relatedPullRequestRecordKey(owner, repo, number));
    return record ? { ...record } : null;
  }

  setCrossReviewDeferral(record) {
    if (!validCrossReviewDeferral(record)) return false;
    const next = normalizeCrossReviewDeferral(record);
    const key = relatedPullRequestRecordKey(next.owner, next.repo, next.number);
    this.crossReviewSkips.delete(key);
    this.crossReviewDeferrals.set(key, next);
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
    for (const records of [this.crossReviewSkips, this.crossReviewDeferrals]) {
      for (const [key, record] of records) {
        if (record.owner.toLowerCase() !== owner.toLowerCase() || record.repo.toLowerCase() !== repo.toLowerCase()) continue;
        const headRefOid = currentHeads.get(record.number);
        if (!headRefOid || headRefOid === record.headRefOid) continue;
        records.delete(key);
        invalidated += 1;
      }
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
    for (const record of this.readOnlyPullRequestRegistrations()) {
      if (typeof record.cwd === 'string') cwds.add(record.cwd);
    }
    return [...cwds];
  }

  pullRequestRegistrationsForRepo(owner, repo) {
    return structuredClone(this.pullRequestRegistrationSnapshot().registrationsByRepo.get(pullRequestRepositoryKey(owner, repo)) || []);
  }

  pullRequestRegistration(number, registrationKey) {
    const matches = this.readOnlyPullRequestRegistrations().filter((record) => record.number === number);
    if (typeof registrationKey === 'string') {
      const record = matches.find((candidate) => pullRequestRegistrationKey(candidate) === registrationKey);
      return record ? normalizePullRequestRecord(record) : null;
    }
    return matches.length === 1 ? normalizePullRequestRecord(matches[0]) : null;
  }

  pullRequestRegistrationByKey(registrationKey) {
    if (!isSha256Digest(registrationKey)) return null;
    const record = this.readOnlyPullRequestRegistrations().find((candidate) => pullRequestRegistrationKey(candidate) === registrationKey);
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
      ...(record.historyMerged === true ? { historyMerged: true } : {}),
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
    for (const sessionId of this.pullRequests.keys()) {
      this.updatePullRequest(sessionId, next.owner, next.repo, next.number, registrationChanges);
    }
    this.updateRelatedPullRequest(next.owner, next.repo, next.number, registrationChanges);
    this.pruneExpiredStoreRecords(now);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  // squash と rebase では head の祖先が base に入らないので、マージコミットの親に head があると確かめた PR だけを返す。
  mergeCommitMergedHeads(owner, repo) {
    return [...this.mergedPullRequests.values()]
      .filter((record) => record.historyMerged === true && !record.headMismatch
        && isCompleteCommitSha(record.mergedHeadRefOid)
        && record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase())
      .map((record) => `${record.number}:${record.mergedHeadRefOid.toLowerCase()}`);
  }

  mergedPullRequestHistoryForRepo(owner, repo, now = Date.now(), deadline) {
    if (!Number.isFinite(this.lastStorePruneAt) || now < this.lastStorePruneAt ||
      now - this.lastStorePruneAt >= STORE_PRUNE_MIN_INTERVAL_MS) this.pruneExpiredStoreRecords(now);
    // 整理は間引くので、間引いた間に期限を過ぎた記録もここで除く。
    return [...this.mergedPullRequests.values()]
      .filter((record) => !record.historyDismissedAt && now - Date.parse(record.mergedAt) < MERGED_PULL_REQUEST_RETENTION_MS)
      .filter((record) => record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase())
      .sort((left, right) => Date.parse(right.mergedAt) - Date.parse(left.mergedAt) || right.number - left.number)
      .map((record) => {
        deadline?.propose(Date.parse(record.mergedAt) + MERGED_PULL_REQUEST_RETENTION_MS);
        return { ...record, providers: this.pullRequestProviders(record.owner, record.repo, record.number) };
      });
  }

  dismissMergedPullRequestHistory(owner, repo, number, now = Date.now()) {
    const record = this.mergedPullRequests.get(relatedPullRequestRecordKey(owner, repo, number));
    if (!record || record.headMismatch === true || record.historyDismissedAt) return false;
    record.historyDismissedAt = isoTime(now);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  unregisterUnknownPullRequests(owner, repo) {
    let deleted = 0;
    const matches = (record) => record.owner.toLowerCase() === owner.toLowerCase()
      && record.repo.toLowerCase() === repo.toLowerCase() && record.state === 'unknown';
    for (const [sessionId, records] of this.pullRequests) {
      for (const [key, record] of records) {
        if (!matches(record)) continue;
        records.delete(key);
        this.invalidatePullRequestRegistrationCache();
        deleted += 1;
      }
      if (!records.size) this.pullRequests.delete(sessionId);
    }
    for (const [key, record] of this.relatedPullRequests) {
      if (!matches(record)) continue;
      this.relatedPullRequests.delete(key);
      deleted += 1;
    }
    if (deleted) {
      this.touch();
      this.requestStoreWrite();
    }
    return deleted;
  }

  deleteClosedPullRequest(owner, repo, number) {
    const key = pullRequestRecordKey(owner, repo, number);
    let deleted = false;
    for (const [sessionId, records] of this.pullRequests) {
      if (records.get(key)?.state !== 'closed') continue;
      records.delete(key);
      this.invalidatePullRequestRegistrationCache();
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
      ...(record.kind === 'stack' ? { kind: record.kind, headRefOid: record.headRefOid,
        runId: record.runId, order: record.order, total: record.total } : {}),
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

  recordStackMergeResult(record) {
    this.stackMergeResults.set(record.runId, { ...record });
    if (this.stackMergeResults.size > 100) this.stackMergeResults.delete(this.stackMergeResults.keys().next().value);
    this.touch();
    this.requestStoreWrite();
  }

  stackMergeResultsForRepo(owner, repo) {
    return [...this.stackMergeResults.values()].filter((record) => !record.closedAt &&
      record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase())
      .map((record) => ({ ...record }));
  }

  closeStackMergeResult(runId) {
    const record = this.stackMergeResults.get(runId);
    if (!record) return false;
    this.recordStackMergeResult({ ...record, closedAt: new Date().toISOString() });
    return true;
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

  pullRequestMergeReservationNoticesForRepo(owner, repo, now = Date.now(), deadline) {
    return [...this.pullRequestMergeReservationNotices.values()]
      .filter((record) => {
        const timestamp = Date.parse(record.at || '');
        return record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase()
          && !(Number.isFinite(timestamp) && now >= timestamp && now - timestamp >= TRANSIENT_NOTICE_MS);
      })
      .map((record) => {
        deadline?.propose(Date.parse(record.at) + TRANSIENT_NOTICE_MS);
        return { ...record };
      });
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
    if (changes.state === 'merged' || changes.state === 'closed') this.recordPullRequestClosure(owner, repo, number);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  recordPullRequestCiFailure(owner, repo, number, nextLastOpen, now, displayProducts = []) {
    if (nextLastOpen?.ci !== 'fail') return;
    const registrations = this.readOnlyPullRequestRegistrations().filter((record) => (
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
      provider: previous?.provider || this.providerForSession(sessionId),
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
    this.invalidatePullRequestRegistrationCache();
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
    if (changes.state === 'merged' || changes.state === 'closed') this.recordPullRequestClosure(owner, repo, number);
    this.invalidatePullRequestRegistrationCache();
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  recordPullRequestClosure(owner, repo, number) {
    this.hiddenPrs.delete(relatedPullRequestRecordKey(owner, repo, number));
    const key = pullRequestRepositoryKey(owner, repo);
    let record = this.pullRequestClosureGenerations.get(key);
    if (!record) {
      record = { generation: 0, pullRequests: new Map() };
      this.pullRequestClosureGenerations.set(key, record);
    }
    record.generation += 1;
    record.pullRequests.set(number, record.generation);
  }

  pullRequestClosureGeneration(owner, repo, number = null) {
    const record = this.pullRequestClosureGenerations.get(pullRequestRepositoryKey(owner, repo));
    return (number === null ? record?.generation : record?.pullRequests.get(number)) || 0;
  }

  recordPullRequestRetarget(record) {
    if (!validPullRequestRetarget(record)) return false;
    const index = this.pullRequestRetargets.findIndex((item) => item.owner === record.owner && item.repo === record.repo && item.number === record.number);
    const next = { owner: record.owner, repo: record.repo, number: record.number, base: record.base, fromNumber: record.fromNumber ?? null };
    if (record.previousBaseRefName) next.previousBaseRefName = record.previousBaseRefName;
    const completed = record.completed ?? this.pullRequestRetargets[index]?.completed;
    if (completed !== undefined) next.completed = completed;
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
    return this.entries.wasCommand(sessionId, toolUseId, 'creates');
  }

  wasPullRequestRefreshCommand(sessionId, toolUseId) {
    return this.entries.wasCommand(sessionId, toolUseId, 'refreshes');
  }

  attachWriter(writer) {
    this.storeWriter = writer;
  }

  requestStoreWrite(immediate = false) {
    if (!this.storeWriter) return Promise.resolve();
    this.storeWritePending = true;
    if (!immediate) {
      if (!this.storeWriteTimer) {
        this.storeWriteTimer = setTimeout(() => { void this.flushStoreWrite().catch(() => {}); }, STORE_WRITE_DELAY_MS);
        this.storeWriteTimer.unref?.();
      }
      return Promise.resolve();
    }
    return this.flushStoreWrite().catch(() => {});
  }

  flushStoreWrite() {
    clearTimeout(this.storeWriteTimer);
    this.storeWriteTimer = null;
    if (!this.storeWriter) return Promise.resolve();
    if (!this.storeWritePending) return this.storeWriter.retry?.('store.json') || Promise.resolve();
    this.storeWritePending = false;
    return this.measure('store', () => this.storeWriter.write('store.json', this.serializeStore()));
  }

  async waitForPersistence() {
    if (this.storeWriter) await (this.storeWriter.wait?.() || this.storeWriter.flush());
  }

  persistenceStatus() {
    const status = this.storeWriter?.snapshot?.() || { status: 'saved', files: [] };
    return this.storeWritePending && status.status === 'saved' ? { ...status, status: 'pending' } : status;
  }

  async flushPersistence() {
    await this.flushStoreWrite().catch(() => {});
    await this.waitForPersistence();
  }

  recordCodexRecovery(event, session) {
    if (session.provider !== 'codex') return;
    const previous = this.codexRecovery.get(event.session_id);
    const pid = (!event.agent_id && event.codexPid) || previous?.pid;
    if (!pid) return;
    const record = {
      pid,
      cwd: event.cwd || previous?.cwd || '',
      model: session.codex.model,
      resumes: session.codex.resumes + (this.codexResumesBeforeEnd.get(event.session_id) || 0),
      updatedAt: previous?.updatedAt || isoTime(event.hookAt),
      // 再開(codex exec resume など)はロックを作らないことがあり、プロセス ID の照会も失敗しうるので、本体の SessionStart では印を外す。
      // ロックを作る画面なら、次の走査で印が付き直る。
      ...(previous?.lockSeen && !(event.hook_event_name === 'SessionStart' && !event.agent_id) ? { lockSeen: true } : {}),
    };
    // updatedAt は再起動の後の行の無操作の判定にも使う。イベントのたびに保存しないよう、1 分以上進んだときだけ進める。
    const activityAdvanced = event.hookAt - Date.parse(record.updatedAt) >= CODEX_RECOVERY_ACTIVITY_STEP_MS;
    if (activityAdvanced) record.updatedAt = isoTime(event.hookAt);
    this.codexRecovery.set(event.session_id, record);
    this.sessionFileLastSeenAt.set(event.session_id, event.hookAt);
    const changed = !previous || activityAdvanced || ['pid', 'cwd', 'model', 'resumes', 'lockSeen'].some((key) => previous[key] !== record[key]);
    if (!changed) return;
    const oldest = [...this.codexRecovery].sort(([, left], [, right]) => Date.parse(left.updatedAt) - Date.parse(right.updatedAt));
    for (const [id] of oldest.slice(0, Math.max(0, oldest.length - MAX_CODEX_RECOVERY_SESSIONS))) {
      this.codexRecovery.delete(id);
      this.sessionFileLastSeenAt.delete(id);
      if (this.sessionFiles.get(id)?.provider === 'codex') this.sessionFiles.delete(id);
    }
    this.requestStoreWrite();
  }

  liveCodexSessionFiles(isAlive, locks = null) {
    const files = [];
    for (const [sessionId, record] of this.codexRecovery) {
      if (!isAlive(record.pid)) {
        this.diagnostics?.record('info', 'codex', 'session.ended',
          { session: sessionId.slice(0, 8), provider: 'codex', reason: 'process-dead' });
        this.lockMissingReported.delete(sessionId);
        this.codexRecovery.delete(sessionId);
        this.requestStoreWrite();
        continue;
      }
      if (locks?.has(sessionId) && !record.lockSeen) {
        record.lockSeen = true;
        this.requestStoreWrite();
      }
      // 閉じた会話も記録は残す。プロセス ID は SessionStart でしか届かないので、消すと再開した行を生存の一覧へ戻せないため。
      if (locks !== null && record.lockSeen && !locks.has(sessionId)) {
        // 閉じた会話の記録は走査のたびにここを通るので、ロックが戻るまでは 1 回だけ記録する。
        if (!this.lockMissingReported.has(sessionId)) {
          this.lockMissingReported.add(sessionId);
          this.diagnostics?.record('info', 'codex', 'session.ended',
            { session: sessionId.slice(0, 8), provider: 'codex', reason: 'lock-missing' });
        }
        continue;
      }
      this.lockMissingReported.delete(sessionId);
      files.push({
        session_id: sessionId, provider: 'codex', pid: record.pid, cwd: record.cwd,
        updatedAt: record.updatedAt, codex: { model: record.model, resumes: record.resumes },
      });
    }
    return files;
  }

  // フックがまだ届いていないセッションも一覧に出し、題名の変更を拾うために使う。
  syncSessionFiles(files, now = Date.now(), { codexOnly = false } = {}) {
    if (!Array.isArray(files)) return;
    if (codexOnly) files = [...this.sessionFiles.values()].filter((file) => file.provider !== 'codex').concat(files);
    const next = new Map(files.map((file) => [file.session_id, file]));
    const previous = this.sessionFiles;
    const shouldSyncSession = (sessionId) => !codexOnly || next.get(sessionId)?.provider === 'codex' ||
      previous.get(sessionId)?.provider === 'codex' || this.sessions.get(sessionId)?.provider === 'codex';
    let changed = JSON.stringify([...next.entries()]) !== JSON.stringify([...previous.entries()]);
    let persistentChanged = false;
    this.sessionFiles = next;
    for (const sessionId of this.deletedSessions.keys()) {
      if (!shouldSyncSession(sessionId)) continue;
      const file = next.get(sessionId);
      if (file && Date.parse(file.updatedAt) > Date.parse(this.deletedSessions.get(sessionId))) {
        this.acceptSessionWrite(sessionId, Date.parse(file.updatedAt));
        changed = true;
      }
    }

    for (const [sessionId, plan] of this.plans) {
      if (!shouldSyncSession(sessionId)) continue;
      const product = cloneProduct(next.get(sessionId)?.product || this.sessions.get(sessionId)?.product);
      if (product && stableStringify(plan.product) !== stableStringify(product)) {
        plan.product = product;
        persistentChanged = true;
      }
    }

    if (this.restoreSessionCleanupPending && !codexOnly) {
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

    for (const [sessionId, file] of next) {
      if (!codexOnly || file.provider === 'codex') this.sessionFileLastSeenAt.set(sessionId, now);
    }
    for (const sessionId of this.endedByAbsence.keys()) {
      if (!shouldSyncSession(sessionId)) continue;
      if (next.has(sessionId)) {
        this.reopenAbsentSession(sessionId);
        changed = true;
      }
    }
    for (const sessionId of this.hiddenSessions) {
      if (!shouldSyncSession(sessionId)) continue;
      if (!next.has(sessionId) && previous.has(sessionId) && !this.sessions.has(sessionId)) {
        this.hiddenSessions.delete(sessionId);
        this.hiddenSessionUpdatedAt.delete(sessionId);
        changed = true;
        persistentChanged = true;
      }
    }
    // ファイルの status で状態が決まる間は推定を使わない。決まった状態が後で不明に戻っても古い推定を出さないため、ここで消す。
    for (const sessionId of this.estimates.keys()) {
      if (!shouldSyncSession(sessionId)) continue;
      if (!next.has(sessionId) || fileStatusDecidesState(next.get(sessionId))) {
        this.estimates.delete(sessionId);
        changed = true;
      }
    }
    for (const [sessionId, lastSeenAt] of this.sessionFileLastSeenAt) {
      if (!shouldSyncSession(sessionId)) continue;
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
    this.planUpdates.delete(sessionId);
    // provider を持たない保存済みの計画は、起点の情報を消す前に補う。
    const plan = this.plans.get(sessionId);
    const planProviderAdded = Boolean(plan && !plan.provider);
    if (planProviderAdded) plan.provider = this.providerForSession(sessionId);
    const hadRecovery = this.codexRecovery.delete(sessionId);
    if (this.sessionFiles.get(sessionId)?.provider === 'codex') this.sessionFiles.delete(sessionId);
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
    if (wasHidden || hadRecovery || planProviderAdded) this.requestStoreWrite();
  }

  endSessionByAbsence(sessionId, endedAt) {
    this.planUpdates.delete(sessionId);
    this.diagnostics?.record('info', 'server', 'session.ended',
      { session: sessionId.slice(0, 8), provider: this.providerForSession(sessionId), reason: 'session-file-absent' });
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
    const [session] = deriveSessions(entries, this.askDecisionStateFor(sessionId), Infinity, this.entries.questions(sessionId));
    if (session) this.sessions.set(sessionId, session);
    this.onSessionReopened?.(sessionId);
  }

  // 解決すると lifecycle の仮適用の印は消えるので、上書きと計画に残る provisionalAt も見る。
  awayHandledDecisionIds(sessionId) {
    const ids = new Set();
    for (const [id, lifecycle] of this.decisionLifecycles.get(sessionId) || []) {
      if (lifecycle.awaitingAnswerUntil || lifecycle.provisionalAt || lifecycle.state === 'provisional' || lifecycle.answer?.sentAt) ids.add(id);
    }
    for (const [id, override] of this.decisionOverrides.get(sessionId) || []) {
      if (override.provisionalAt) ids.add(id);
    }
    for (const decision of this.plans.get(sessionId)?.decisions || []) {
      if (decision.source === 'ask' && decision.provisionalAt) ids.add(decision.id);
    }
    return [...ids];
  }

  askDecisionStateFor(sessionId) {
    return {
      decisions: (this.plans.get(sessionId)?.decisions || [])
        .filter((decision) => decision.source === 'ask').map(cloneDecision),
      bindings: Object.fromEntries(this.askDecisionBindings.get(sessionId) || []),
      finishedOutsideEventsIds: [...(this.finishedOutsideEventsAskDecisionIds.get(sessionId) || [])],
      awayHandledIds: this.awayHandledDecisionIds(sessionId),
      finishedWrapUpToolUseIds: [...(this.decisionLifecycles.get(sessionId)?.values() || [])]
        .map((lifecycle) => lifecycle.askToolUseId)
        .filter((toolUseId) => this.isWrapUpAskFinished(sessionId, toolUseId)),
    };
  }

  isWrapUpAskFinished(sessionId, toolUseId) {
    if (!toolUseId) return false;
    const decisionId = this.decisionIdForToolUse(sessionId, toolUseId);
    const lifecycle = this.decisionLifecycles.get(sessionId)?.get(decisionId);
    return lifecycle?.askToolUseId === toolUseId && !lifecycle.awaitingAnswerUntil &&
      (lifecycle.state === 'provisional' || Boolean(lifecycle.answer?.sentAt));
  }

  // 判断事項の回答待ちが別の呼び出しへ移っていれば、遅れて届いた古い呼び出しの終わりで書き換えないため。
  isAskLifecycleOwnedBy(sessionId, toolUseId) {
    const lifecycle = this.decisionLifecycles.get(sessionId)?.get(this.decisionIdForToolUse(sessionId, toolUseId));
    return !lifecycle?.askToolUseId || lifecycle.askToolUseId === toolUseId;
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

  // サブエージェントから委譲した Codex の行は、表示用の形では親の行の gpt にまとめられている。
  hasRunningDelegation(sessionId) {
    const parent = sessionId ? this.sessions.get(sessionId) : null;
    if (parent?.provider !== 'claude') return false;
    return parent.agents.some((agent) => (
      (agent.isCodex === true && !agent.resultReceived && (agent.active || agent.unconfirmed)) ||
      (agent.gpt && (agent.gpt.active || agent.gpt.unconfirmed))
    ));
  }

  // Claude の PreToolUse は非同期のフックで、子の Codex のイベントより後に届くことがある。
  // 起動から終了までに始まった独立の thread だけを委譲に直す。
  reclassifyDelegatedThreads(parentSessionId, launchedAt, endedAt = Infinity) {
    let changed = false;
    for (const [threadId, entries] of this.entries) {
      const first = entries[0]?.event;
      if (first?.provider !== 'codex' || first.delegatedFrom || first.claudeParentSessionId !== parentSessionId ||
        first.hookAt < launchedAt || first.hookAt > endedAt) continue;
      this.entries.delegate(threadId, parentSessionId);
      changed = this.sessions.delete(threadId) || changed;
      if (this.codexRecovery.delete(threadId)) this.requestStoreWrite();
      if (this.sessionFiles.get(threadId)?.provider === 'codex') {
        this.sessionFiles.delete(threadId);
        changed = true;
      }
      this.sessionFileLastSeenAt.delete(threadId);
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

  // 記録ファイルはセッションを始めた場所で決まるので、後で cd した先の cwd では上書きしない。
  noteHookCwd(sessionId, cwd) {
    if (typeof cwd === 'string' && cwd && cwd.length <= 4096 && !this.hookCwds.has(sessionId)) this.hookCwds.set(sessionId, cwd);
  }

  // セッションの一覧は公開仕様ではないので、読めないときはフックが最初に送った cwd で記録ファイルを探す。
  transcriptCwdFor(sessionId) {
    return this.sessionFiles.get(sessionId)?.cwd || this.hookCwds.get(sessionId) || null;
  }

  // 再開の SessionStart の後に読んだ記録の末尾は再開前の応答のことがあるので、時刻の新しいほうを残す。
  recordSessionModel(sessionId, observation) {
    const provider = this.sessions.get(sessionId)?.provider || this.sessionFiles.get(sessionId)?.provider;
    if (provider === 'codex' || !observation?.model) return;
    const at = Number.isFinite(observation.at) ? observation.at : null;
    const current = this.claudeSessionModels.get(sessionId);
    if (current && (at === null || (current.at !== null && at < current.at))) return;
    this.claudeSessionModels.set(sessionId, { model: observation.model, at });
    if (current?.model !== observation.model) this.touch();
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

  desktopAskWithdrawalTarget(sessionId, decision) {
    if (decision.source !== 'ask' || decision.state !== 'waiting') return null;
    // フックの回答待ちは再起動で期限を消しても配信を続けるため、記録の存在で保護する。
    if (this.decisionLifecycles.get(sessionId)?.has(decision.id)) return null;
    const stored = this.plans.get(sessionId)?.decisions.find((item) => item.id === decision.id);
    if (!stored) return null;
    const bindings = this.askDecisionBindings.get(sessionId) || new Map();
    const starts = this.entries.questions(sessionId).filter(({ event: start }) => start.hook_event_name === 'PreToolUse' &&
      start.tool_name === 'AskUserQuestion' && !start.agent_id && bindings.get(start.tool_use_id) === decision.id);
    starts.sort((left, right) => right.event.hookAt - left.event.hookAt || right.sequence - left.sequence);
    const start = starts[0]?.event;
    const storedStartAt = Date.parse(stored.updatedAt);
    const toolUseId = start && start.hookAt >= storedStartAt
      ? start.tool_use_id
      : [...bindings].reverse().find(([, id]) => id === decision.id)?.[0];
    return toolUseId ? { decision, stored, toolUseId, startAt: Math.max(start?.hookAt ?? -Infinity, storedStartAt) } : null;
  }

  isDesktopAskProgress(event) {
    if (event.provider === 'codex' || event.agent_id) return false;
    return (event.hook_event_name === 'PreToolUse' && Boolean(event.tool_use_id)) ||
      ['UserPromptSubmit', 'Stop', 'Interrupt'].includes(event.hook_event_name);
  }

  isDesktopAskBoundary(event, target) {
    if (!this.isDesktopAskProgress(event)) return false;
    const isNextTool = event.hook_event_name === 'PreToolUse';
    if (isNextTool && event.tool_use_id === target.toolUseId) return false;
    // 同じ質問の出し直しは既存の判断事項と回答を引き継ぐため、取り下げずに結び付ける。
    if (isNextTool && event.tool_name === 'AskUserQuestion' && sameQuestionSet(target.decision.questions, event.questions || [])) return false;
    return true;
  }

  recordInferredAskWithdrawal(sessionId, target, hookAt) {
    Object.assign(target.stored, {
      state: 'withdrawn',
      updatedAt: isoTime(hookAt),
      resolvedAt: isoTime(hookAt),
      resolution: null,
      finishedByToolUseId: target.toolUseId,
      inferredWithdrawalHookAt: hookAt,
    });
    let finishedIds = this.finishedOutsideEventsAskDecisionIds.get(sessionId);
    if (!finishedIds) {
      finishedIds = new Set();
      this.finishedOutsideEventsAskDecisionIds.set(sessionId, finishedIds);
    }
    finishedIds.add(target.decision.id);
  }

  withdrawFinishedDesktopAsks(event) {
    if (!this.isDesktopAskProgress(event)) return false;
    const sessionId = event.session_id;
    let changed = false;
    for (const decision of this.decisionsFor(sessionId)) {
      const target = this.desktopAskWithdrawalTarget(sessionId, decision);
      if (!target || event.hookAt <= target.startAt || !this.isDesktopAskBoundary(event, target)) continue;
      this.recordInferredAskWithdrawal(sessionId, target, event.hookAt);
      changed = true;
    }
    return changed;
  }

  withdrawLateDesktopAskStart(event) {
    if (event.provider === 'codex' || event.agent_id || event.hook_event_name !== 'PreToolUse' ||
      event.tool_name !== 'AskUserQuestion' || !event.tool_use_id) return false;
    const sessionId = event.session_id;
    const decisionId = this.decisionIdForToolUse(sessionId, event.tool_use_id);
    const decision = this.decisionFor(sessionId, decisionId);
    const target = decision && this.desktopAskWithdrawalTarget(sessionId, decision);
    if (!target) return false;
    let boundaryAt = Infinity;
    for (const { event: boundary } of this.entries.get(sessionId) || []) {
      if (boundary.hookAt > target.startAt && boundary.hookAt < boundaryAt && this.isDesktopAskBoundary(boundary, target)) {
        boundaryAt = boundary.hookAt;
      }
    }
    if (boundaryAt === Infinity) return false;
    this.recordInferredAskWithdrawal(sessionId, target, boundaryAt);
    return true;
  }

  measure(name, fn) {
    return this.perf ? this.perf.measure(name, fn) : fn();
  }

  addEvent(input, metadata = {}) {
    return this.measure('event', () => this.applyEvent(input, metadata));
  }

  isDelegatedCodexThread(sessionId) {
    return Boolean(this.entries.get(sessionId)?.[0]?.event.delegatedFrom);
  }

  applyEvent(input, metadata = {}) {
    const event = sanitizeEvent(input, metadata);
    const rejected = (reason, result) => {
      metadata.onRejected?.(reason);
      (metadata.diagnostics || this.diagnostics)?.record('info', 'server', 'event.rejected', { reason,
        ...(event ? { event: event.hook_event_name, provider: event.provider, session: event.session_id.slice(0, 8) } : {}) });
      return result;
    };
    if (!event) return rejected('invalid', false);
    const existingProvider = this.entries.get(event.session_id)?.[0]?.event.provider
      || this.sessions.get(event.session_id)?.provider || this.sessionFiles.get(event.session_id)?.provider
      || (this.codexRecovery.has(event.session_id) ? 'codex' : null);
    if (existingProvider && existingProvider !== event.provider) return rejected('provider-mismatch', false);
    // 委譲した Codex の thread は行を作らない。分類は thread の最初のイベントで決め、そのイベントだけを保持する(docs/design/codex-delegation.md)。
    if (event.provider === 'codex') {
      const entries = this.entries.get(event.session_id) || [];
      if (entries[0]?.event.delegatedFrom) return rejected('delegated', true);
      if (!entries.length && this.hasRunningDelegation(event.claudeParentSessionId)) {
        event.delegatedFrom = event.claudeParentSessionId;
        this.entries.replace(event.session_id, [{ event, sequence: this.sequence++ }]);
        return true;
      }
    }
    if (!this.acceptSessionWrite(event.session_id, event.hookAt)) return rejected('deleted', true);

    // ファイルだけで出している行は this.sessions に無いので、終了で消えることを比較では拾えない。
    const endedFileOnlySession = event.hook_event_name === 'SessionEnd' && !this.sessions.has(event.session_id) &&
      this.sessionFiles.has(event.session_id);
    const endedAt = this.endedAt.get(event.session_id);
    if (endedAt !== undefined && event.hook_event_name !== 'SessionStart') return rejected('ended', true);
    if (endedAt !== undefined && event.hookAt <= endedAt) return rejected('stale', true);

    const endedByAbsenceAt = this.endedByAbsence.get(event.session_id);
    if (endedByAbsenceAt !== undefined && event.hookAt <= endedByAbsenceAt) return rejected('absent-stale', true);

    const previousSession = this.sessions.get(event.session_id);
    const before = stableStringify(previousSession ?? null);
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
    const eventSequence = this.sequence++;
    if (event.provider !== 'codex' && !event.agent_id && event.hook_event_name === 'SessionStart' &&
      event.model) {
      this.recordSessionModel(event.session_id, { model: event.model, at: event.hookAt });
    }
    const entries = this.entries.push(event.session_id, { event, sequence: eventSequence });
    const askState = this.askDecisionStateFor(event.session_id);
    let nextSessions = deriveSessions(entries, askState, eventSequence, this.entries.questions(event.session_id));
    if (this.verifyEntries) {
      assert.deepStrictEqual(nextSessions, deriveSessions(this.entries.full(event.session_id), askState, eventSequence));
    }
    let askDecisionStateChanged = false;
    let withdrawnLateAsk = false;
    if (nextSessions.length > 0) {
      if (nextSessions[0].codex && !nextSessions[0].codex.model) {
        nextSessions[0].codex.model = this.codexRecovery.get(event.session_id)?.model || '';
      }
      this.sessions.set(event.session_id, nextSessions[0]);
      this.recordCodexRecovery(event, nextSessions[0]);
      askDecisionStateChanged = this.persistAskDecisionState(event.session_id, nextSessions[0]);
      withdrawnLateAsk = this.withdrawLateDesktopAskStart(event);
      if (withdrawnLateAsk) {
        const updatedAskState = this.askDecisionStateFor(event.session_id);
        // decisionsFor は this.sessions を優先するため、保存した取り下げを表示にも反映する。
        nextSessions = deriveSessions(entries, updatedAskState, eventSequence, this.entries.questions(event.session_id));
        if (this.verifyEntries) {
          assert.deepStrictEqual(nextSessions, deriveSessions(this.entries.full(event.session_id), updatedAskState, eventSequence));
        }
        this.sessions.set(event.session_id, nextSessions[0]);
        askDecisionStateChanged = this.persistAskDecisionState(event.session_id, nextSessions[0]) || askDecisionStateChanged;
      }
    }
    else this.sessions.delete(event.session_id);
    // 推定はターンが不明な間の補助なので、状態が確定したら消す。不明のままのイベントでは残す。
    // 許可確認はターンの確定を待たずに優先して出るので、確認中と許可待ちでも残す。
    const derivedStatus = nextSessions[0]?.status;
    const hadEstimate = !['不明', '許可確認中', '許可待ち'].includes(derivedStatus) && this.estimates.delete(event.session_id);
    let reclassifiedDelegatedThread = event.provider === 'claude' && event.hook_event_name === 'PreToolUse' && event.codexDefinition
      ? this.reclassifyDelegatedThreads(event.session_id, event.hookAt) : false;
    if (event.provider === 'claude' && previousSession?.codexLaunches) {
      const previousLaunchIds = new Set(previousSession.codexLaunches.map((launch) => launch.agent_id));
      const launches = nextSessions[0]?.codexLaunches || [];
      for (const launch of launches) {
        if (previousLaunchIds.has(launch.agent_id)) continue;
        const endedAt = launch.resultReceived || !(launch.active || launch.unconfirmed)
          ? launch.endedAt ?? event.hookAt : Infinity;
        reclassifiedDelegatedThread = this.reclassifyDelegatedThreads(event.session_id, Date.parse(launch.startedAt), endedAt)
          || reclassifiedDelegatedThread;
      }
    }

    const ended = event.hook_event_name === 'SessionEnd' && nextSessions.length === 0;
    if (ended) {
      this.diagnostics?.record('info', event.provider === 'codex' ? 'codex' : 'server', 'session.ended',
        { session: event.session_id.slice(0, 8), provider: event.provider, reason: 'SessionEnd' });
      this.endSession(event.session_id, event.hookAt);
    }

    const reopenedClosedAgent = event.agent_id && event.hook_event_name !== 'SubagentStop'
      ? this.closedAgents.get(event.session_id)?.delete(event.agent_id) : false;
    const clearedClosedAgent = this.reconcileClosedAgents(event.session_id) || reopenedClosedAgent;
    if (stableStringify(this.sessions.get(event.session_id) ?? null) !== before || hadEstimate || wasHidden ||
      clearedClosedAgent || reclassifiedDelegatedThread || correctedAsk || withdrawnAsk || withdrawnLateAsk || endedFileOnlySession) this.touch();
    if (wasHidden) this.requestStoreWrite();
    if (askDecisionStateChanged || withdrawnAsk || withdrawnLateAsk || correctedAsk) this.requestStoreWrite();
    return event.hook_event_name === 'SessionEnd' ? { ended } : true;
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

  // Claude はターンの中断で Stop を送らないので、ファイルが idle なのにメインの最後の区切りより新しく、
  // フックの状態が作業中か許可確認の途中のセッションだけを、transcript で中断を確かめる候補にする。
  interruptCandidate(sessionId) {
    const session = this.sessions.get(sessionId);
    const file = this.sessionFiles.get(sessionId);
    if (!session || session.provider !== 'claude' || file?.status !== 'idle') return null;
    if (!['作業中', '許可確認中', '許可待ち'].includes(session.status)) return null;
    const statusAt = Date.parse(file.statusUpdatedAt || '');
    if (!Number.isFinite(statusAt)) return null;
    const { lastLifecycleAt, lastPromptAt } = this.entries.lifecycle(sessionId);
    if (statusAt <= lastLifecycleAt) return null;
    return { cwd: file.cwd, statusUpdatedAt: file.statusUpdatedAt, lastPromptAt };
  }

  backgroundCodexAgents(sessionId) {
    return this.sessions.get(sessionId)?.backgroundCodex || [];
  }

  recordBackgroundTaskEnd(sessionId, end, hookAt = Date.now()) {
    return this.addEvent({ session_id: sessionId, hook_event_name: 'BackgroundTaskEnd', backgroundTaskEnds: [end], hookAt });
  }

  recordInterruption(sessionId, hookAt) {
    return this.addEvent({ session_id: sessionId, hook_event_name: 'Interrupt', hookAt });
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

  setDecisionHidden(sessionId, id, hidden) {
    const decision = this.decisionFor(sessionId, id);
    if (hidden && (!decision || !['waiting', 'provisional'].includes(decision.state)
      || (decision.state === 'waiting' && decision.awaitingAnswerUntil))) return false;
    const key = `${sessionId}\0${id}`;
    if (hidden && !this.hiddenDecisions.has(key) && this.hiddenDecisions.size >= MAX_HIDDEN_ITEMS) return false;
    if (hidden) this.hiddenDecisions.set(key, { session_id: sessionId, id });
    else this.hiddenDecisions.delete(key);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  setPullRequestHidden(owner, repo, number, hidden) {
    const key = relatedPullRequestRecordKey(owner, repo, number);
    if (hidden && !this.hiddenPrs.has(key) && this.hiddenPrs.size >= MAX_HIDDEN_ITEMS) return false;
    if (hidden) this.hiddenPrs.set(key, { owner, repo, number });
    else this.hiddenPrs.delete(key);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  isPullRequestHidden(owner, repo, number) {
    return this.hiddenPrs.has(relatedPullRequestRecordKey(owner, repo, number));
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
    const current = normalizeDisplay(this.display || defaultDisplay());
    const next = normalizeDisplay({
      ...current, ...changes,
      ...(Object.hasOwn(changes, 'importAppTasks') ? { importAppTasksAsked: true } : {}),
    });
    if (this.display && JSON.stringify(this.display) === JSON.stringify(next)) return cloneDisplay(this.display);
    if (current.importAppTasks !== next.importAppTasks) this.planUpdates.clear();
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
    const background = this.sessions.get(sessionId)?.backgrounds?.find((item) => item.agent_id === agentId);
    const agent = this.sessions.get(sessionId)?.agents.find((item) => item.agent_id === agentId);
    if (!agent && !background) return null;
    if (!background && !isClosableAgent(agent)) return false;
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
    const backgrounds = this.sessions.get(sessionId)?.backgrounds || [];
    let changed = false;
    for (const agentId of closed) {
      const agent = agents.find((item) => item.agent_id === agentId);
      if ((!agent || !isClosableAgent(agent)) && !backgrounds.some((item) => item.agent_id === agentId)) {
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
      ...(task.autoTitle === true ? { autoTitle: true } : {}),
      state: task.state,
      criteria: task.criteria.map((criterion) => ({
        text: criterion.text,
        met: criterion.met,
        ...(criterion.doing === true ? { doing: true } : {}),
      })),
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

  // アプリの一覧を取り込んだセッションだけ、1 件の cockpit_set_tasks を題でのまとめ書きにする。
  markAppTasks(sessionId) {
    const plan = this.planFor(sessionId);
    if (plan.appTasks === true) return;
    plan.appTasks = true;
    this.requestStoreWrite();
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
      ...(input.verify ? { verify: { steps: input.verify.steps.map(step => ({ ...step })) } } : {}),
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

  reportLaunch(sessionId, id, target, now = Date.now()) {
    const decision = this.plans.get(sessionId)?.decisions.find(item => item.id === id);
    if (!decision?.verify || !['waiting', 'provisional'].includes(this.decisionFor(sessionId, id)?.state)) return null;
    const timestamp = isoTime(now);
    decision.verify.launched = { ...target, at: timestamp };
    decision.updatedAt = timestamp;
    this.touch();
    this.requestStoreWrite(true);
    return this.decisionFor(sessionId, id);
  }

  requestLaunch(sessionId, id, now = Date.now()) {
    const decision = this.plans.get(sessionId)?.decisions.find(item => item.id === id);
    if (!decision?.verify || !['waiting', 'provisional'].includes(this.decisionFor(sessionId, id)?.state)) return null;
    decision.launchRequestedAt = isoTime(now);
    decision.updatedAt = decision.launchRequestedAt;
    this.touch();
    this.requestStoreWrite(true);
    return this.decisionFor(sessionId, id);
  }

  closeDecision(sessionId, id, now = Date.now()) {
    const decision = this.decisionFor(sessionId, id);
    if (!decision) return null;
    if (decision.awaitingAnswerUntil || !(decision.state === 'provisional' ||
      decision.state === 'waiting' && decision.source === 'mcp')) return false;
    return this.updateDecision(sessionId, id, 'resolved', decision.resolution?.chosen || [], decision.resolution?.note || '', now, true);
  }

  updateDecision(sessionId, id, state, chosen, note, now = Date.now(), closedByUser = false) {
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
      ...(closedByUser ? { closedByUser: true } : {}),
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
        ...(updated.closedByUser ? { closedByUser: true } : {}),
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
      plan = {
        tasks: [], tasksUpdatedAt: null, product: cloneProduct(this.productForSession(sessionId)),
        provider: this.providerForSession(sessionId), decisions: [],
      };
      this.plans.set(sessionId, plan);
    }
    return plan;
  }

  productForSession(sessionId) {
    return this.sessions.get(sessionId)?.product || this.sessionFiles.get(sessionId)?.product || this.plans.get(sessionId)?.product || null;
  }

  providerForSession(sessionId) {
    return this.entries.get(sessionId)?.[0]?.event.provider || this.sessions.get(sessionId)?.provider ||
      this.sessionFiles.get(sessionId)?.provider || (this.codexRecovery.has(sessionId) ? 'codex' : null) ||
      this.plans.get(sessionId)?.provider || 'claude';
  }

  // マージ記録の保持期間は登録より短いので、マージ済みの PR の起点も登録から求められる。
  pullRequestProviders(owner, repo, number) {
    return [...(this.pullRequestRegistrationSnapshot().providersByPullRequest.get(pullRequestRecordKey(owner, repo, number)) || [])];
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

  deleteDecisionLifecycle(sessionId, decisionId, { exceptAskToolUseId = null, updatedBefore = Infinity } = {}) {
    const lifecycles = this.decisionLifecycles.get(sessionId);
    const lifecycle = lifecycles?.get(decisionId);
    if (!lifecycle || (exceptAskToolUseId && lifecycle.askToolUseId === exceptAskToolUseId)) return false;
    if (!(Date.parse(lifecycle.updatedAt) < updatedBefore)) return false;
    lifecycles.delete(decisionId);
    if (!lifecycles.size) this.decisionLifecycles.delete(sessionId);
    this.touch();
    this.requestStoreWrite(true);
    return true;
  }

  // 判断事項が見つからなくても、セッションが残っていれば消さない。起動直後はイベント由来の判断事項がまだ組み立てられていないため。
  // 隠した質問が再提示されて回答の秒読みに入ったら表示へ戻す。隠したままだと回答の機会を見落とすため。
  pruneHiddenDecisions() {
    if (!this.hiddenDecisions.size) return;
    const decisionsBySession = new Map();
    for (const [key, record] of this.hiddenDecisions) {
      if (!decisionsBySession.has(record.session_id)) decisionsBySession.set(record.session_id, this.decisionsFor(record.session_id));
      const decision = decisionsBySession.get(record.session_id).find((item) => item.id === record.id);
      const sessionGone = !this.plans.has(record.session_id) && !this.sessions.has(record.session_id);
      const hideable = decision && ['waiting', 'provisional'].includes(decision.state)
        && !(decision.state === 'waiting' && decision.awaitingAnswerUntil);
      if (decision ? !hideable : sessionGone) this.hiddenDecisions.delete(key);
    }
  }

  touch() {
    this.pruneHiddenDecisions();
    this.version += 1;
    this.generatedAt = new Date().toISOString();
  }

  snapshot() {
    return this.measure('snapshot', () => this.buildSnapshot());
  }

  buildSnapshot() {
    const fileOnlyIds = [...this.sessionFiles.values()]
      .filter((file) => this.isFileOnlySession(file))
      .map((file) => file.session_id);
    const sessionIds = new Set([...this.sessions.keys(), ...fileOnlyIds]);
    return {
      version: this.version,
      generatedAt: this.generatedAt,
      display: cloneDisplay(this.display),
      sessions: [...sessionIds].map((sessionId) => this.buildSessionView(sessionId)),
    };
  }

  // フックのイベントがまだ無く、セッションの一覧にだけあるセッション。
  isFileOnlySession(file) {
    return !this.sessions.has(file.session_id) && !this.endedAt.has(file.session_id) && !this.endedByAbsence.has(file.session_id)
      && (!this.deletedSessions.has(file.session_id)
        || Date.parse(file.updatedAt) > Date.parse(this.deletedSessions.get(file.session_id)));
  }

  /**
   * 1 セッション分の表示用の状態を、全体の snapshot と同じ規則で組み立てる。
   * 全体の snapshot に含まれないセッションには null を返す。
   */
  sessionView(sessionId) {
    const file = this.sessionFiles.get(sessionId);
    if (!this.sessions.has(sessionId) && !(file && this.isFileOnlySession(file))) return null;
    return this.buildSessionView(sessionId);
  }

  buildSessionView(sessionId) {
    const session = this.sessions.get(sessionId);
    const file = this.sessionFiles.get(sessionId);
    const plan = this.plans.get(sessionId);
    const base = session || {
      session_id: sessionId,
      ...(file?.provider === 'codex' ? { provider: 'codex', codex: { ...file.codex } } : {}),
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
    const closedAgentIds = new Set(base.agents.filter(isClosedByUser).map((agent) => agent.agent_id));
    const updateTimestamps = [base.lastActivityAt, plan?.tasksUpdatedAt, ...decisions.map((decision) => decision.updatedAt)]
      .filter((timestamp) => Number.isFinite(Date.parse(timestamp || '')));
    const lastUpdatedAt = updateTimestamps.reduce((latest, timestamp) => (
      !latest || Date.parse(timestamp) > Date.parse(latest) ? timestamp : latest
    ), null) || base.lastActivityAt || null;
    const current = {
      ...visible,
      provider: base.provider || 'claude',
      ...(base.provider !== 'codex' && this.claudeSessionModels.has(sessionId)
        ? { modelName: claudeModelName(this.claudeSessionModels.get(sessionId).model) } : {}),
      ...(base.codex ? { codex: { ...base.codex, resumes: base.codex.resumes + (session ? this.codexResumesBeforeEnd.get(sessionId) || 0 : 0) } } : {}),
      title: this.sessionNameFor(sessionId) || base.title,
      product: base.product ? { ...base.product } : null,
      sessionFileUpdatedAt: file?.updatedAt || null,
      lastUpdatedAt,
      tools: base.tools.filter((tool) => !closedAgentIds.has(tool.agent_id)).map((tool) => ({ ...tool })),
      backgrounds: (base.backgrounds || []).filter((item) => !closedAgents.has(item.agent_id)).map((item) => ({ ...item })),
      agents: base.agents.map((agent) => {
        const closedByUser = isClosedByUser(agent);
        const snapshotAgent = closedByUser ? { ...agent, active: false, unconfirmed: false } : agent;
        return {
          ...snapshotAgent,
          ...(isClosableAgent(snapshotAgent) ? { closable: true } : {}),
          lastTool: agent.lastTool && { ...agent.lastTool },
        };
      }),
      permissionWaits: base.permissionWaits.filter((wait) => !closedAgentIds.has(wait.agent_id)).map((wait) => ({ ...wait })),
      decisions: decisions.map(decision => this.hiddenDecisions.has(`${sessionId}\0${decision.id}`)
        ? { ...decision, hidden: true } : decision),
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
    if (session) {
      current.status = sessionStatus({
        ...session.lifecycle,
        permissionWaits: current.permissionWaits,
        agentActive: session.lifecycle.activeAgentIds.some((agentId) => !closedAgentIds.has(agentId)),
      });
    }
    const worktree = this.worktreeInfo.snapshot(this.transcriptCwdFor(sessionId),
      decisions.some(decision => decision.verify && ['waiting', 'provisional'].includes(decision.state)));
    if (worktree) current.worktree = worktree;
    if (current.status === '不明' && fileStatusDecidesState(file)) {
      if (file.status === 'busy') {
        current.status = '作業中';
      } else {
        current.status = base.agents.some((agent) => agent.active && !isClosedByUser(agent))
          ? '待機中(サブエージェント稼働中)'
          : '待機中';
      }
      // 再起動の直後はフックの時刻が無いので、経過時間の基準にファイルの時刻を載せる。
      current.statusSince = file.statusUpdatedAt || file.updatedAt || null;
    }
    const estimate = this.estimates.get(sessionId);
    if (estimate && current.status === '不明') current.estimate = { ...estimate };
    if (this.hiddenSessions.has(sessionId)) {
      current.hidden = true;
      current.hiddenAt = this.hiddenSessionUpdatedAt.get(sessionId);
    }
    return current;
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
          text: `タスク「${task.title}」が完了した`, provider: this.providerForSession(sessionId), pullRequest: null,
        });
      }
    }
    return candidates;
  }

  pullRequestCreatedCandidates({ registrations, registrationsByPullRequest, pullRequestTitles }) {
    return registrations.map((record) => {
      const identity = relatedPullRequestRecordKey(record.owner, record.repo, record.number);
      const title = pullRequestTitles.get(identity);
      const providers = orderedProviders(registrationsByPullRequest.get(identity).map((candidate) => candidate.provider));
      return {
        product: cloneProduct(record.product) || repoProduct(record.owner, record.repo),
        type: 'pull-request',
        identity: `${record.owner}/${record.repo}#${record.number}`,
        at: record.addedAt,
        text: `${pullRequestLabel(record.number, title)}を作成した`,
        providers,
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
          provider: session.provider || this.providerForSession(session.session_id),
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
          provider: this.providerForSession(sessionId),
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
      const providers = this.pullRequestProviders(failure.owner, failure.repo, failure.number);
      return {
        product: failure.product,
        type: 'ci-failure',
        identity: `${failure.owner}/${failure.repo}#${failure.number}`,
        at: failure.at,
        text: `PR #${failure.number} の CI が失敗した`,
        providers,
        pullRequest: { identity, number: failure.number, action: 'ci-failure', title: pullRequestTitles.get(identity) },
      };
    });
  }

  mergedPullRequestCandidates(sources) {
    const candidates = [];
    for (const merged of sources.mergedPullRequests.values()) {
      const identity = relatedPullRequestRecordKey(merged.owner, merged.repo, merged.number);
      const title = sources.pullRequestTitles.get(identity);
      const providers = orderedProviders((sources.registrationsByPullRequest.get(identity) || []).map((record) => record.provider));
      for (const product of mergedPullRequestProducts(merged, sources)) {
        candidates.push({
          product,
          type: 'merged-pull-request',
          identity: `${merged.owner}/${merged.repo}#${merged.number}`,
          at: merged.mergedAt,
          text: `${pullRequestLabel(merged.number, title)}をマージした`,
          providers,
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
    const registrations = this.readOnlyPullRequestRegistrations();
    const records = [...registrations, ...this.relatedPullRequestRegistrations()];
    const storedMerged = [...this.mergedPullRequests.values()];
    return {
      registrations,
      registrationsByPullRequest: groupByPullRequest(registrations, (record) => [record.number]),
      mergedGroupsByPullRequest: groupByPullRequest(pullRequestGroups.filter((group) => group.owner && group.repo),
        (group) => new Set((group.merged || []).map((item) => item.number))),
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

  snapshotSinceSeen(sessions, pullRequestGroups = [], now = Date.now(), awayPeriods = [], deadline) {
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
    if (awayPeriods.some((period) => period.end === null)) {
      for (const events of eventsByProduct.values()) {
        for (const event of events) deadline?.propose(Date.parse(event.at));
      }
    }

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

module.exports = { AwayState, atomicWriteAwayState, DashboardState, deriveSessions, claudeModelName, isAwayAt, pullRequestSummaryText };
