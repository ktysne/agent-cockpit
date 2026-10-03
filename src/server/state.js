const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { recommendedOptionFor, sanitizeEvent } = require('./events');
const { AtomicJsonWriter, atomicWriteJson } = require('./json-storage');
const { parsePullRequestUrl, validBranchName, validRepositoryPart } = require('./pull-request-utils');

const DEFAULT_AWAY_STATE = Object.freeze({ enabled: false, since: null, periods: Object.freeze([]) });
const DEFAULT_SECTION_ORDER = Object.freeze(['sinceSeen', 'judgment', 'tasks', 'now', 'prs']);
const SECTION_ORDER_KEYS = new Set(DEFAULT_SECTION_ORDER);
const DEFAULT_LONG_WAIT_MINUTES = 15;
const DEFAULT_AWAY_ANSWER_WAIT_MINUTES = 5;
const DEFAULT_DISPLAY = Object.freeze({
  mode: 'product', order: [], pinned: [], collapsed: [], hidden: [], sectionOrder: DEFAULT_SECTION_ORDER,
  longWaitMinutes: DEFAULT_LONG_WAIT_MINUTES, awayAnswerWaitMinutes: DEFAULT_AWAY_ANSWER_WAIT_MINUTES, hideFinished: true,
});
const SESSION_FILE_ABSENCE_END_MS = 60_000;
const STORE_WRITE_DELAY_MS = 500;
const STORE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_AWAY_PERIODS = 50;
const RESTORE_SESSION_CLEANUP_GRACE_MS = 10 * 60 * 1000;
const MERGED_PULL_REQUEST_RETENTION_MS = 24 * 60 * 60 * 1000;
const PULL_REQUEST_MERGE_METHODS = new Set(['merge', 'squash', 'rebase']);
const DISPLAY_FILTER_KEYS = new Set(['permission', 'blocking', 'provisional', 'agents', 'prs']);

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

function cloneDisplay(display) {
  if (display === null) return null;
  return {
    mode: display.mode,
    order: [...display.order],
    pinned: [...display.pinned],
    collapsed: [...display.collapsed],
    hidden: [...display.hidden],
    sectionOrder: [...display.sectionOrder],
    longWaitMinutes: display.longWaitMinutes,
    awayAnswerWaitMinutes: display.awayAnswerWaitMinutes,
    hideFinished: display.hideFinished,
  };
}

function defaultDisplay() {
  return {
    mode: DEFAULT_DISPLAY.mode, order: [], pinned: [], collapsed: [], hidden: [],
    sectionOrder: [...DEFAULT_DISPLAY.sectionOrder],
    longWaitMinutes: DEFAULT_DISPLAY.longWaitMinutes,
    awayAnswerWaitMinutes: DEFAULT_DISPLAY.awayAnswerWaitMinutes,
    hideFinished: DEFAULT_DISPLAY.hideFinished,
  };
}

function normalizeDisplayMinutes(value, minimum, maximum, fallback) {
  return Number.isInteger(value) && value >= minimum && value <= maximum ? value : fallback;
}

function normalizeSectionOrder(order) {
  const known = [];
  for (const key of Array.isArray(order) ? order : []) {
    if (SECTION_ORDER_KEYS.has(key) && !known.includes(key)) known.push(key);
  }
  return [...known, ...DEFAULT_SECTION_ORDER.filter((key) => !known.includes(key))];
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validStoredSessionId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
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

function normalizeDisplay(value) {
  if (value === null) return null;
  if (!isRecord(value) || !['product', 'kind'].includes(value.mode)) throw new Error('Invalid display preferences');
  const allowed = new Set(['mode', 'order', 'pinned', 'collapsed', 'hidden', 'sectionOrder', 'longWaitMinutes', 'awayAnswerWaitMinutes', 'hideFinished']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('Invalid display preferences');
  if (Object.hasOwn(value, 'sectionOrder') && !Array.isArray(value.sectionOrder)) throw new Error('Invalid display preferences');
  for (const key of ['order', 'pinned', 'collapsed']) {
    if (!Array.isArray(value[key]) || value[key].length > 200 || value[key].some((item) => typeof item !== 'string' || item.length > 500)) {
      throw new Error('Invalid display preferences');
    }
    if (new Set(value[key]).size !== value[key].length) throw new Error('Invalid display preferences');
  }
  if (!Array.isArray(value.hidden) || value.hidden.length > 200 || value.hidden.some((key) => typeof key !== 'string' || key.length > 500)) {
    throw new Error('Invalid display preferences');
  }
  const hidden = value.hidden.filter((key) => DISPLAY_FILTER_KEYS.has(key));
  if (value.hidden.some((key) => !DISPLAY_FILTER_KEYS.has(key) && key !== 'held') || new Set(hidden).size !== hidden.length) {
    throw new Error('Invalid display preferences');
  }
  return {
    mode: value.mode,
    order: [...value.order],
    pinned: [...value.pinned],
    collapsed: [...value.collapsed],
    hidden,
    sectionOrder: normalizeSectionOrder(value.sectionOrder),
    longWaitMinutes: normalizeDisplayMinutes(value.longWaitMinutes, 1, 120, DEFAULT_LONG_WAIT_MINUTES),
    awayAnswerWaitMinutes: normalizeDisplayMinutes(value.awayAnswerWaitMinutes, 1, 30, DEFAULT_AWAY_ANSWER_WAIT_MINUTES),
    hideFinished: typeof value.hideFinished === 'boolean' ? value.hideFinished : DEFAULT_DISPLAY.hideFinished,
  };
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
      (decision.provisionalAt === undefined || validTimestamp(decision.provisionalAt)));
}

function pullRequestRecordKey(owner, repo, number) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
}

function pullRequestRegistrationKey(record) {
  return crypto.createHash('sha256')
    .update([record.session_id, record.owner.toLowerCase(), record.repo.toLowerCase(), record.number, record.addedAt].join('\0'))
    .digest('hex');
}

function relatedPullRequestRecordKey(owner, repo, number) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
}

function pullRequestRepositoryKey(owner, repo) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function validPullRequestLastOpen(value) {
  if (value === null) return true;
  if (!isRecord(value) ||
    ['title', 'url', 'headRefName', 'baseRefName'].some((key) => typeof value[key] !== 'string') ||
    ['title', 'headRefName', 'baseRefName'].some((key) => value[key].length > 500) ||
    (value.headRefOid !== '' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value.headRefOid))) return false;
  return true;
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
    (record.mergedAt !== null && !validTimestamp(record.mergedAt))) return false;
  const parsedUrl = parsePullRequestUrl(record.url);
  if (!parsedUrl || parsedUrl.owner !== record.owner || parsedUrl.repo !== record.repo || parsedUrl.number !== record.number) return false;
  if (!validPullRequestLastOpen(record.lastOpen)) return false;
  return true;
}

function normalizePullRequestRecord(record) {
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
  };
}

function validRelatedPullRequestRecord(record) {
  if (!isRecord(record) || !validRepositoryPart(record.owner) || !validRepositoryPart(record.repo) ||
    !Number.isSafeInteger(record.number) || record.number < 1 || !validTimestamp(record.addedAt) ||
    ![null, 'unknown', 'open', 'merged', 'closed'].includes(record.state) ||
    (record.mergedAt !== null && !validTimestamp(record.mergedAt))) return false;
  const parsedUrl = parsePullRequestUrl(record.url);
  return Boolean(parsedUrl && parsedUrl.owner === record.owner && parsedUrl.repo === record.repo &&
    parsedUrl.number === record.number && validPullRequestLastOpen(record.lastOpen));
}

function normalizeRelatedPullRequestRecord(record) {
  return {
    owner: record.owner,
    repo: record.repo,
    number: record.number,
    url: record.url,
    addedAt: record.addedAt,
    state: record.state || 'unknown',
    mergedAt: record.mergedAt || null,
    lastOpen: normalizePullRequestLastOpen(record.lastOpen),
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
    (record.reservedHeadRefOid !== undefined && record.reservedHeadRefOid !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(record.reservedHeadRefOid)) ||
    (record.mergedHeadRefOid !== undefined && record.mergedHeadRefOid !== null && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(record.mergedHeadRefOid)) ||
    (record.headMismatch !== undefined && typeof record.headMismatch !== 'boolean')) return false;
  const parsedUrl = parsePullRequestUrl(record.url);
  return Boolean(parsedUrl && parsedUrl.owner === record.owner && parsedUrl.repo === record.repo && parsedUrl.number === record.number);
}

function validPullRequestMergeReservation(record) {
  const parsedUrl = parsePullRequestUrl(record?.url);
  return isRecord(record) && validStoredSessionId(record.session_id) && validRepositoryPart(record.owner) && validRepositoryPart(record.repo) &&
    Number.isSafeInteger(record.number) && record.number > 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(record.headRefOid || '') &&
    PULL_REQUEST_MERGE_METHODS.has(record.method) && typeof record.deleteBranch === 'boolean' && validTimestamp(record.createdAt) &&
    validBranchName(record.headRefName) && validBranchName(record.defaultBranch) && typeof record.url === 'string' &&
    Boolean(parsedUrl && parsedUrl.owner === record.owner && parsedUrl.repo === record.repo && parsedUrl.number === record.number) &&
    Array.isArray(record.stackedPullRequests) && record.stackedPullRequests.length <= 100 &&
    record.stackedPullRequests.every((item) => isRecord(item) && Number.isSafeInteger(item.number) && item.number > 0 && validBranchName(item.baseRefName));
}

function validPullRequestMergeIntent(record) {
  const parsedUrl = parsePullRequestUrl(record?.url);
  return isRecord(record) && validStoredSessionId(record.session_id) && validRepositoryPart(record.owner) && validRepositoryPart(record.repo) &&
    Number.isSafeInteger(record.number) && record.number > 0 && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(record.headRefOid || '') &&
    PULL_REQUEST_MERGE_METHODS.has(record.method) && typeof record.deleteBranch === 'boolean' && validTimestamp(record.createdAt) &&
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
  const relatedPrs = value.relatedPrs === undefined ? [] : value.relatedPrs;
  const retargetedPrs = value.retargetedPrs === undefined ? [] : value.retargetedPrs;
  const mergedPrs = value.mergedPrs === undefined ? [] : value.mergedPrs;
  const mergeReservations = value.mergeReservations === undefined ? [] : value.mergeReservations;
  const mergeIntents = value.mergeIntents === undefined ? [] : value.mergeIntents;
  const lastPullRequestMethods = value.lastPullRequestMethods === undefined ? {} : value.lastPullRequestMethods;
  const seenAtByProduct = value.seenAtByProduct === undefined ? {} : value.seenAtByProduct;
  const ciFailures = value.ciFailures === undefined ? [] : value.ciFailures;
  if (!Array.isArray(prs) || !prs.every(validPullRequestRecord) ||
    !Array.isArray(relatedPrs) || !relatedPrs.every(validRelatedPullRequestRecord) ||
    !Array.isArray(retargetedPrs) || !retargetedPrs.every(validPullRequestRetarget) ||
    !Array.isArray(mergedPrs) || !mergedPrs.every(validMergedPullRequest) ||
    !Array.isArray(mergeReservations) || !mergeReservations.every(validPullRequestMergeReservation) ||
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
      validProduct(record.product) && validTimestamp(record.at))) {
    throw new Error('Invalid pull request records');
  }
  return {
    display,
    plans,
    decisionLifecycles,
    closedTasks,
    hiddenSessions,
    prs: prs.map(normalizePullRequestRecord),
    relatedPrs: relatedPrs.map(normalizeRelatedPullRequestRecord),
    retargetedPrs: retargetedPrs.map((record) => ({ ...record })),
    mergedPrs: mergedPrs.map((record) => ({ ...record })),
    mergeReservations: mergeReservations.map((record) => ({
      ...record,
      stackedPullRequests: record.stackedPullRequests.map((item) => ({ ...item })),
    })),
    mergeIntents: mergeIntents.map((record) => ({
      ...record,
      stackedPullRequests: record.stackedPullRequests.map((item) => ({ ...item })),
    })),
    lastPullRequestMethods: new Map(Object.entries(lastPullRequestMethods)),
    seenAtByProduct: new Map(Object.entries(seenAtByProduct)),
    ciFailures: ciFailures.map((record) => ({ ...record, product: cloneProduct(record.product) })),
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

  let periods;
  if (value.periods === undefined) {
    // 旧形式は、離席中なら since から現在まで続く期間として読む。
    periods = value.enabled ? [{ start: value.since, end: null }] : [];
  } else {
    if (!Array.isArray(value.periods) || value.periods.some((period) => !isRecord(period) ||
      !Number.isFinite(period.start) || period.start < 0 ||
      !(period.end === null || (Number.isFinite(period.end) && period.end >= period.start)))) return null;
    periods = value.periods.map(({ start, end }) => ({ start, end }));
  }

  if (periods.some((period, index) => period.end === null && index !== periods.length - 1)) return null;
  if (value.enabled) {
    const activePeriod = periods.at(-1);
    if (activePeriod?.end === null) {
      if (activePeriod.start !== value.since) return null;
    } else {
      if (activePeriod && activePeriod.end > value.since) return null;
      periods.push({ start: value.since, end: null });
    }
  } else if (periods.some((period) => period.end === null)) {
    return null;
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

function newSession(event) {
  return {
    session_id: event.session_id,
    product: event.product,
    title: event.sessionName,
    status: '作業中',
    tools: [],
    completedToolIds: new Set(),
    agents: [],
    permissionWaits: [],
    decisions: [],
    decisionBindings: Object.create(null),
    stopped: false,
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

// 親が一度止まって終了未確認になった Codex も、再開した親が取り出した結果行で終了にする。
// --wait の状態の行で終わった行は、ラッパーが消えていて結果行が届かないので除く。
function oldestBackgroundedCodex(session, parentAgentId, runId = null) {
  return session.agents
    .filter((agent) => (
      agent.isCodex && agent.backgrounded && !agent.waitEnded && (agent.active || agent.unconfirmed) &&
      sameAgent(agent.parent_agent_id, parentAgentId) && (!runId || !agent.runId || agent.runId === runId)
    ))
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))[0] || null;
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

function deriveSessions(entries) {
  const sessions = new Map();
  const stoppedAgentIdsBySession = new Map();
  const ordered = [...entries].sort((left, right) => {
    const difference = left.event.hookAt - right.event.hookAt;
    return difference || left.sequence - right.sequence;
  });

  for (const { event } of ordered) {
    let session = sessions.get(event.session_id);
    if (event.hook_event_name === 'SessionStart') {
      if (!session || session.ended) {
        session = newSession(event);
        sessions.set(event.session_id, session);
      }
    } else if (!session) {
      session = newSession(event);
      sessions.set(event.session_id, session);
    }

    if (session.ended) continue;
    if (event.product) session.product = event.product;
    if (event.sessionName) session.title = event.sessionName;
    session.lastActivityAt = isoTime(event.hookAt);

    const eventName = event.hook_event_name;
    const agentId = event.agent_id || null;
    const toolUseId = event.tool_use_id || null;
    const isCodexAgentId = agentId?.startsWith('codex:') === true;
    let stoppedAgentIds = stoppedAgentIdsBySession.get(session);
    if (!stoppedAgentIds) {
      stoppedAgentIds = new Set();
      stoppedAgentIdsBySession.set(session, stoppedAgentIds);
    }

    if (eventName === 'SubagentStop' && agentId) {
      stoppedAgentIds.add(agentId);
    } else if (eventName === 'SubagentStart' && agentId && !isCodexAgentId) {
      stoppedAgentIds.delete(agentId);
    } else if (
      agentId && !isCodexAgentId && !stoppedAgentIds.has(agentId) && !agentFor(session, agentId)
    ) {
      const agent = agentModelFromDefinition(event.agent_type, event.agentDefinition || {});
      agent.agent_id = agentId;
      agent.startedAt = isoTime(event.hookAt);
      session.agents.push(agent);
    }

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
        if (event.tool_name === 'Agent' && !agentId) {
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

      if (event.codexWaitDefinition && agentId && !isCodexAgentId && toolUseId) {
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
      } else if (event.codexDefinition && toolUseId) {
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
      if (event.tool_name === 'AskUserQuestion' && !agentId && toolUseId && event.questions?.length) {
        const existing = session.decisions.find((decision) => (
          ['waiting', 'provisional'].includes(decision.state) && sameQuestionSet(decision.questions, event.questions)
        ));
        if (existing) {
          existing.state = 'waiting';
          existing.updatedAt = isoTime(event.hookAt);
          existing.resolvedAt = null;
          existing.resolution = null;
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
      if (!agentId) session.stopped = false;
    }

    if (eventName === 'SubagentStart' && agentId && !isCodexAgentId) {
      let agent = agentFor(session, agentId);
      const definition = event.agentDefinition || {};
      if (agent) {
        agent.active = true;
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

    if (eventName === 'SubagentStop' && agentId) {
      const agent = agentFor(session, agentId);
      if (agent) agent.active = false;
      deactivateBackgroundedCodex(session, agentId);
    }

    if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
      let completedCodexAgent = null;
      if (toolUseId) {
        session.tools = session.tools.filter((tool) => tool.tool_use_id !== toolUseId);
        session.completedToolIds.add(toolUseId);
      }

      if (eventName === 'PostToolUse' && event.tool_name === 'Agent' && event.resolvedModel) {
        const boundAgentId = session.agentToolBindings[toolUseId];
        const targetAgent = agentFor(session, boundAgentId);
        if (targetAgent) {
          targetAgent.model = event.resolvedModel;
          targetAgent.source = 'Agent tool response';
        }
      }

      if (event.tool_name === 'Bash' && toolUseId) {
        const placeholder = agentFor(session, session.pendingCodex[toolUseId]);
        if (placeholder && event.codexRunId) placeholder.runId = event.codexRunId;
        if (placeholder && event.codexResult) {
          completeCodexAgent(placeholder, event);
          completedCodexAgent = placeholder;
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
        }
        delete session.pendingCodex[toolUseId];
        delete session.pendingCodexWait[toolUseId];
      }

      // Agent の結果は担当の最終報告で、背景の Codex の結果行を写していることがあるので使わない。
      if (event.codexResult && !completedCodexAgent && event.tool_name !== 'Agent') {
        const codexForRun = event.codexRunId ? session.agents.find((agent) => agent.isCodex && agent.runId === event.codexRunId) : null;
        const targetAgent = codexForRun
          ? (codexForRun.resultReceived ? null : codexForRun)
          : oldestBackgroundedCodex(session, agentId, event.codexRunId);
        if (targetAgent && !targetAgent.runId && event.codexRunId) targetAgent.runId = event.codexRunId;
        if (targetAgent) completeCodexAgent(targetAgent, event);
      }

      session.permissionWaits = session.permissionWaits.filter((wait) => !(
        sameAgent(wait.agent_id, agentId) && wait.target_tool_use_id === toolUseId && toolUseId
      ));
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
        }
      }
      if (!agentId) session.stopped = false;
    }

    if (eventName === 'PostToolBatch' && !agentId) {
      session.tools = session.tools.filter((tool) => (
        tool.agent_id || Date.parse(tool.startedAt) >= event.hookAt
      ));
    }

    if (eventName === 'Notification' && event.notification_type === 'permission_prompt') {
      // Agent の呼び出しはサブエージェントの終わりまで続くので、許可を待つツールの候補にしない。
      const oldestTool = session.tools
        .filter((tool) => sameAgent(tool.agent_id, agentId) && tool.tool_name !== 'Agent')
        .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))[0];
      const wait = {
        agent_id: agentId,
        target_tool_use_id: oldestTool?.tool_use_id || null,
        tool_name: oldestTool?.tool_name || '',
        summary: oldestTool?.summary || '',
        notification_type: event.notification_type,
        message: event.message,
        startedAt: isoTime(event.hookAt),
      };
      session.permissionWaits = session.permissionWaits.filter((item) => !sameAgent(item.agent_id, agentId));
      session.permissionWaits.push(wait);
    }

    if (eventName === 'UserPromptSubmit' || eventName === 'Stop') {
      session.permissionWaits = session.permissionWaits.filter((wait) => !sameAgent(wait.agent_id, agentId));
      if (!agentId) session.tools = session.tools.filter((tool) => tool.agent_id);
    }

    // compact は自動の圧縮でターンの途中にも起きるので、直前の状態を保つ。
    const startsIdle = eventName === 'SessionStart' && IDLE_START_SOURCES.has(event.source);
    if (startsIdle) {
      session.permissionWaits = session.permissionWaits.filter((wait) => wait.agent_id);
      session.tools = session.tools.filter((tool) => tool.agent_id);
      session.stopped = true;
    }
    if (eventName === 'UserPromptSubmit') session.stopped = false;
    if (eventName === 'Stop') {
      session.stopped = true;
      deactivateBackgroundedCodex(session, null);
    }
    if (eventName === 'SessionEnd') session.ended = true;
  }

  return [...sessions.values()]
    .filter((session) => !session.ended)
    .map((session) => {
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
            modelName: agent.isCodex ? '' : claudeModelName(agent.model),
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
        : session.stopped && session.agents.some((agent) => agent.active)
          ? '待機中(サブエージェント稼働中)'
          : session.stopped
            ? '待機中'
            : '作業中';

      return {
        session_id: session.session_id,
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
    });
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
    this.decisionOverrides = new Map();
    this.decisionLifecycles = new Map();
    this.estimates = new Map();
    this.hiddenSessions = new Set();
    this.hiddenSessionUpdatedAt = new Map();
    this.closedTasks = new Map();
    this.pullRequests = new Map();
    this.relatedPullRequests = new Map();
    this.pullRequestConflictRequests = new Map();
    this.pullRequestRetargets = [];
    this.mergedPullRequests = new Map();
    this.pullRequestMergeReservationRecords = new Map();
    this.pullRequestMergeIntentRecords = new Map();
    this.lastPullRequestMethods = new Map();
    this.seenAtByProduct = new Map();
    this.ciFailures = [];
    this.closedAgents = new Map();
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
    this.plans = store.plans;
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
    this.pullRequestMergeIntentRecords = new Map(store.mergeIntents.map((record) => [
      relatedPullRequestRecordKey(record.owner, record.repo, record.number), record,
    ]));
    this.lastPullRequestMethods = store.lastPullRequestMethods;
    this.pruneExpiredStoreRecords(now);
  }

  pruneExpiredStoreRecords(now) {
    let mergeHistoryChanged = false;
    let sessionRecordsChanged = false;
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
    if (sessionRecordsChanged || mergeHistoryChanged || previousFailureCount !== this.ciFailures.length) {
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

  deleteStoredSession(sessionId) {
    this.plans.delete(sessionId);
    this.decisionLifecycles.delete(sessionId);
    this.closedTasks.delete(sessionId);
    this.pullRequests.delete(sessionId);
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
      decisionLifecycles,
      closedTasks,
      hiddenSessions,
      prs: this.pullRequestRegistrations(),
      relatedPrs: [...this.relatedPullRequests.values()].map(normalizeRelatedPullRequestRecord),
      retargetedPrs: this.pullRequestRetargets.map((record) => ({ ...record })),
      mergedPrs: [...this.mergedPullRequests.values()].map((record) => ({ ...record })),
      mergeReservations: [...this.pullRequestMergeReservationRecords.values()].map((record) => ({
        ...record,
        stackedPullRequests: record.stackedPullRequests.map((item) => ({ ...item })),
      })),
      mergeIntents: [...this.pullRequestMergeIntentRecords.values()].map((record) => ({
        ...record,
        stackedPullRequests: record.stackedPullRequests.map((item) => ({ ...item })),
      })),
      lastPullRequestMethods: Object.fromEntries(this.lastPullRequestMethods),
      seenAtByProduct: Object.fromEntries(this.seenAtByProduct),
      ciFailures: this.ciFailures.map((record) => ({ ...record, product: cloneProduct(record.product) })),
    };
  }

  pullRequestRegistrations() {
    return [...this.pullRequests.values()].flatMap((records) => [...records.values()].map(normalizePullRequestRecord));
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
    if (typeof registrationKey !== 'string' || !/^[a-f0-9]{64}$/i.test(registrationKey)) return null;
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
    };
    if (!validMergedPullRequest(next)) return false;
    const key = relatedPullRequestRecordKey(next.owner, next.repo, next.number);
    const previous = this.mergedPullRequests.get(key);
    if (previous && stableStringify(previous) === stableStringify(next)) return false;
    this.mergedPullRequests.set(key, next);
    for (const registration of this.pullRequestRegistrationsForRepo(next.owner, next.repo).filter((item) => item.number === next.number)) {
      this.updatePullRequest(registration.session_id, next.owner, next.repo, next.number, { state: 'merged', mergedAt: next.mergedAt });
    }
    this.updateRelatedPullRequest(next.owner, next.repo, next.number, { state: 'merged', mergedAt: next.mergedAt });
    this.pruneExpiredStoreRecords(now);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  mergedPullRequestHistoryForRepo(owner, repo, now = Date.now()) {
    this.pruneExpiredStoreRecords(now);
    return [...this.mergedPullRequests.values()]
      .filter((record) => record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase())
      .sort((left, right) => Date.parse(right.mergedAt) - Date.parse(left.mergedAt) || right.number - left.number)
      .map((record) => ({ ...record }));
  }

  setPullRequestMergeReservation(record) {
    const next = {
      ...record,
      owner: record.owner,
      repo: record.repo,
      stackedPullRequests: record.stackedPullRequests.map((item) => ({ ...item })),
    };
    if (!validPullRequestMergeReservation(next)) return false;
    const key = relatedPullRequestRecordKey(next.owner, next.repo, next.number);
    const previous = this.pullRequestMergeReservationRecords.get(key);
    if (previous && stableStringify(previous) === stableStringify(next)) return false;
    this.pullRequestMergeReservationRecords.set(key, next);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  pullRequestMergeReservation(owner, repo, number) {
    const record = this.pullRequestMergeReservationRecords.get(relatedPullRequestRecordKey(owner, repo, number));
    return record ? { ...record, stackedPullRequests: record.stackedPullRequests.map((item) => ({ ...item })) } : null;
  }

  pullRequestMergeReservationsForRepo(owner, repo) {
    return [...this.pullRequestMergeReservationRecords.values()]
      .filter((record) => record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase())
      .map((record) => ({ ...record, stackedPullRequests: record.stackedPullRequests.map((item) => ({ ...item })) }));
  }

  pullRequestMergeReservations() {
    return [...this.pullRequestMergeReservationRecords.values()].map((record) => ({
      ...record,
      stackedPullRequests: record.stackedPullRequests.map((item) => ({ ...item })),
    }));
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
    let records = this.pullRequests.get(sessionId);
    if (!records) {
      records = new Map();
      this.pullRequests.set(sessionId, records);
    }
    const key = pullRequestRecordKey(parsedUrl.owner, parsedUrl.repo, parsedUrl.number);
    const previous = records.get(key);
    const relatedKey = relatedPullRequestRecordKey(parsedUrl.owner, parsedUrl.repo, parsedUrl.number);
    const related = this.relatedPullRequests.get(relatedKey);
    const product = context.product && typeof context.product.key === 'string' && typeof context.product.name === 'string'
      ? { key: context.product.key.slice(0, 500), name: context.product.name.slice(0, 200) }
      : previous?.product || null;
    const next = {
      session_id: sessionId,
      ...parsedUrl,
      addedAt: previous?.addedAt || isoTime(now),
      cwd: typeof context.cwd === 'string' && context.cwd.length <= 4096 ? context.cwd : previous?.cwd || null,
      product,
      state: previous?.state || related?.state || 'unknown',
      mergedAt: previous?.mergedAt || related?.mergedAt || null,
      lastOpen: previous?.lastOpen ? { ...previous.lastOpen } : related?.lastOpen ? { ...related.lastOpen } : null,
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
    const [session] = deriveSessions(entries);
    if (session) this.sessions.set(sessionId, session);
    this.onSessionReopened?.(sessionId);
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

  addEvent(input, metadata = {}) {
    const event = sanitizeEvent(input, metadata);
    if (!event) return false;

    const endedAt = this.endedAt.get(event.session_id);
    if (endedAt !== undefined && event.hook_event_name !== 'SessionStart') return true;
    if (endedAt !== undefined && event.hookAt <= endedAt) return true;

    const endedByAbsenceAt = this.endedByAbsence.get(event.session_id);
    if (endedByAbsenceAt !== undefined && event.hookAt <= endedByAbsenceAt) return true;

    const before = JSON.stringify([...this.sessions.values()]);
    const hadEstimate = this.estimates.delete(event.session_id);
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

    const entries = this.entries.get(event.session_id) || [];
    entries.push({ event, sequence: this.sequence++ });
    this.entries.set(event.session_id, entries);
    const nextSessions = deriveSessions(entries);
    if (nextSessions.length > 0) this.sessions.set(event.session_id, nextSessions[0]);
    else this.sessions.delete(event.session_id);

    if (event.hook_event_name === 'SessionEnd') {
      this.endSession(event.session_id, event.hookAt);
    }

    const clearedClosedAgent = this.reconcileClosedAgents(event.session_id);
    if (JSON.stringify([...this.sessions.values()]) !== before || hadEstimate || wasHidden || clearedClosedAgent) this.touch();
    if (wasHidden) this.requestStoreWrite();
    return true;
  }

  // 推定の読み取り中にイベントが届いたセッションは状態が分かったので、古い推定を残さない。
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
    if (!this.hiddenSessions.has(sessionId)) {
      this.hiddenSessions.add(sessionId);
      this.hiddenSessionUpdatedAt.set(sessionId, isoTime(now));
      this.touch();
      this.requestStoreWrite();
    }
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
    if (agent.active || !agent.unconfirmed) return false;
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
      if (!agent || agent.active || !agent.unconfirmed) {
        closed.delete(agentId);
        changed = true;
      }
    }
    if (!closed.size) this.closedAgents.delete(sessionId);
    return changed;
  }

  setTasks(sessionId, tasks, now = Date.now()) {
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
    if (stored) Object.assign(stored, updated);
    else {
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
    const overrides = this.decisionOverrides.get(sessionId);
    const lifecycles = this.decisionLifecycles.get(sessionId);
    return [...eventDecisions, ...planDecisions].map((decision) => {
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
        answer: lifecycle.answer,
        ...(lifecycle.awaitingAnswerUntil ? { awaitingAnswerUntil: lifecycle.awaitingAnswerUntil } : {}),
      });
    });
  }

  decisionFor(sessionId, decisionId) {
    return this.decisionsFor(sessionId).find((decision) => decision.id === decisionId) || null;
  }

  decisionIdForToolUse(sessionId, toolUseId) {
    return this.sessions.get(sessionId)?.decisionBindings?.[toolUseId] || null;
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
    let lifecycles = this.decisionLifecycles.get(sessionId);
    if (!lifecycles) {
      lifecycles = new Map();
      this.decisionLifecycles.set(sessionId, lifecycles);
    }
    const current = lifecycles.get(decisionId) || { answer: null, awaitingAnswerUntil: null, state: null, updatedAt: null };
    const next = { ...current, ...updates };
    next.updatedAt = isoTime(now);
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
      const current = {
        ...visible,
        title: this.sessionNameFor(sessionId) || base.title,
        product: base.product ? { ...base.product } : null,
        tools: base.tools.map((tool) => ({ ...tool })),
        agents: base.agents.map((agent) => ({
          ...agent,
          ...(agent.unconfirmed && !agent.active && this.closedAgents.get(sessionId)?.has(agent.agent_id) ? { unconfirmed: false } : {}),
          lastTool: agent.lastTool && { ...agent.lastTool },
        })),
        permissionWaits: base.permissionWaits.map((wait) => ({ ...wait })),
        decisions: this.decisionsFor(sessionId),
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
      };
      const estimate = this.estimates.get(sessionId);
      if (estimate) current.estimate = { ...estimate };
      if (this.hiddenSessions.has(sessionId)) current.hidden = true;
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

  snapshotSinceSeen(sessions, pullRequestGroups = [], now = Date.now(), awayPeriods = []) {
    const products = new Map();
    const visibleProductKeys = new Set();
    const registrations = this.pullRequestRegistrations();
    const relatedRegistrations = this.relatedPullRequestRegistrations();
    const mergedPullRequests = new Map();
    const addProduct = (value) => {
      const product = cloneProduct(value);
      if (product && !products.has(product.key)) products.set(product.key, product);
      return product;
    };
    for (const merged of this.mergedPullRequests.values()) {
      mergedPullRequests.set(relatedPullRequestRecordKey(merged.owner, merged.repo, merged.number), merged);
    }
    for (const record of [...registrations, ...relatedRegistrations]) {
      if (record.state !== 'merged' || !record.mergedAt) continue;
      const key = relatedPullRequestRecordKey(record.owner, record.repo, record.number);
      if (mergedPullRequests.has(key)) continue;
      mergedPullRequests.set(key, {
        owner: record.owner,
        repo: record.repo,
        number: record.number,
        title: record.lastOpen?.title || `#${record.number}`,
        mergedAt: record.mergedAt,
      });
    }
    // 関連 PR は登録にプロダクトを持たないので、その PR をマージ済みとして載せている PR 群のプロダクトに出す。
    const productsForMergedPullRequest = (merged) => {
      const sameRepo = (owner, repo) => owner?.toLowerCase() === merged.owner.toLowerCase() && repo?.toLowerCase() === merged.repo.toLowerCase();
      const found = [
        ...registrations.filter((record) => sameRepo(record.owner, record.repo) && record.number === merged.number)
          .map((record) => cloneProduct(record.product) || repoProduct(merged.owner, merged.repo)),
        ...pullRequestGroups.filter((group) => sameRepo(group.owner, group.repo) && group.merged?.some((item) => item.number === merged.number))
          .map((group) => cloneProduct(group.product)).filter(Boolean),
      ];
      if (!found.length) return [repoProduct(merged.owner, merged.repo)];
      return [...new Map(found.map((product) => [product.key, product])).values()];
    };
    for (const session of sessions) {
      const product = addProduct(session.product);
      if (product) visibleProductKeys.add(product.key);
    }
    for (const group of pullRequestGroups) {
      const product = addProduct(group.product || (group.owner && group.repo ? repoProduct(group.owner, group.repo) : null));
      if (product) visibleProductKeys.add(product.key);
    }
    for (const plan of this.plans.values()) addProduct(plan.product);
    for (const record of registrations) addProduct(record.product || repoProduct(record.owner, record.repo));
    for (const record of this.ciFailures) addProduct(record.product);
    for (const merged of mergedPullRequests.values()) {
      for (const product of productsForMergedPullRequest(merged)) addProduct(product);
    }

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

    const eventsByProduct = new Map([...products.keys()].map((key) => [key, []]));
    const eventKeys = new Set();
    const happenedWhileAway = (timestamp) => awayPeriods.some((period) => {
      if (!Number.isFinite(period.start)) return false;
      const end = period.end === null ? now : period.end;
      return Number.isFinite(end) && timestamp >= period.start && timestamp <= end;
    });
    const addEvent = (product, type, identity, at, text) => {
      const timestamp = Date.parse(at || '');
      if (!product || !eventsByProduct.has(product.key) || !Number.isFinite(timestamp)) return;
      const key = `${product.key}\0${type}\0${identity}\0${at}`;
      if (eventKeys.has(key)) return;
      eventKeys.add(key);
      eventsByProduct.get(product.key).push({ at, type, text });
    };

    for (const [sessionId, plan] of this.plans) {
      const product = cloneProduct(plan.product || this.productForSession(sessionId));
      if (!product) continue;
      for (const task of plan.tasks) {
        const closed = this.closedTasks.get(sessionId)?.get(task.title);
        const closedByUser = closed?.stateAtClose === task.state;
        const at = closedByUser ? closed.closedAt || plan.tasksUpdatedAt : task.state === 'done' ? task.completedAt || plan.tasksUpdatedAt : null;
        if (at) addEvent(product, 'task', `${sessionId}\0${task.title}`, at, `タスク「${task.title}」が完了した`);
      }
    }

    for (const record of this.pullRequestRegistrations()) {
      const product = cloneProduct(record.product) || repoProduct(record.owner, record.repo);
      const title = record.lastOpen?.title;
      addEvent(product, 'pull-request', `${record.owner}/${record.repo}#${record.number}`, record.addedAt,
        `PR #${record.number}${title ? `(${title})` : ''}を作成した`);
    }

    const sessionDecisionIds = new Set();
    for (const session of sessions) {
      for (const decision of session.decisions) {
        sessionDecisionIds.add(`${session.session_id}\0${decision.id}`);
        if (!decision.provisionalAt && decision.state !== 'provisional') continue;
        const product = cloneProduct(session.product || this.plans.get(session.session_id)?.product);
        const at = decision.provisionalAt || decision.updatedAt;
        addEvent(product, 'provisional', `${session.session_id}\0${decision.id}`, at,
          `判断「${decision.title}」を推奨案で仮に進めた`);
      }
    }
    for (const [sessionId, plan] of this.plans) {
      const product = cloneProduct(plan.product || this.productForSession(sessionId));
      for (const decision of plan.decisions) {
        if (sessionDecisionIds.has(`${sessionId}\0${decision.id}`) || (!decision.provisionalAt && decision.state !== 'provisional')) continue;
        addEvent(product, 'provisional', `${sessionId}\0${decision.id}`, decision.provisionalAt || decision.updatedAt,
          `判断「${decision.title}」を推奨案で仮に進めた`);
      }
    }

    for (const failure of this.ciFailures) {
      addEvent(failure.product, 'ci-failure', `${failure.owner}/${failure.repo}#${failure.number}`, failure.at,
        `PR #${failure.number} の CI が失敗した`);
    }

    for (const merged of mergedPullRequests.values()) {
      for (const product of productsForMergedPullRequest(merged)) {
        addEvent(product, 'merged-pull-request', `${merged.owner}/${merged.repo}#${merged.number}`, merged.mergedAt,
          `PR #${merged.number}(${merged.title})をマージした`);
      }
    }

    const sinceSeen = [];
    for (const product of products.values()) {
      const seenAt = this.seenAtByProduct.get(product.key);
      if (!seenAt) continue;
      const seenMilliseconds = Date.parse(seenAt || '');
      const items = (eventsByProduct.get(product.key) || [])
        .filter((event) => {
          const timestamp = Date.parse(event.at);
          return timestamp > seenMilliseconds && happenedWhileAway(timestamp);
        })
        .sort((left, right) => Date.parse(right.at) - Date.parse(left.at));
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

module.exports = { AwayState, atomicWriteAwayState, DashboardState, deriveSessions, claudeModelName };
