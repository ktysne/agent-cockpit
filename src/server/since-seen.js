// 「前回見てから」の行を時刻と候補から組み立てる。既読時刻の更新と保存要求は DashboardState が持つ。
const { pullRequestKey: relatedPullRequestRecordKey } = require('./pull-request-utils');
const { cloneProduct, repoProduct } = require('./product-utils');

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
function mergedPullRequestProducts(merged, { registrationsByPullRequest, mergedGroupsByPullRequest }) {
  const key = relatedPullRequestRecordKey(merged.owner, merged.repo, merged.number);
  const found = [
    ...(registrationsByPullRequest.get(key) || []).map((record) => cloneProduct(record.product) || repoProduct(merged.owner, merged.repo)),
    ...(mergedGroupsByPullRequest.get(key) || []).map((group) => cloneProduct(group.product)).filter(Boolean),
  ];
  if (!found.length) return [repoProduct(merged.owner, merged.repo)];
  return [...new Map(found.map((product) => [product.key, product])).values()];
}

function groupByPullRequest(values, numbersOf) {
  const grouped = new Map();
  for (const value of values) {
    for (const number of numbersOf(value)) {
      const key = relatedPullRequestRecordKey(value.owner, value.repo, number);
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(value);
    }
  }
  return grouped;
}

function pullRequestLabel(number, title) {
  return `PR #${number}${title ? `(${title})` : ''}`;
}

function orderedProviders(providers) {
  const present = new Set(providers);
  return ['claude', 'codex'].filter((provider) => present.has(provider));
}

// 対象のプロダクトに無い候補、時刻を読めない候補、同じ内容の重複は捨てる。
function groupSinceSeenEvents(candidates, products) {
  const eventsByProduct = new Map([...products.keys()].map((key) => [key, []]));
  const eventKeys = new Set();
  for (const { product, type, identity, at, text, pullRequest, provider, providers } of candidates) {
    const timestamp = Date.parse(at || '');
    if (!product || !eventsByProduct.has(product.key) || !Number.isFinite(timestamp)) continue;
    const key = `${product.key}\0${type}\0${identity}\0${at}`;
    if (eventKeys.has(key)) continue;
    eventKeys.add(key);
    eventsByProduct.get(product.key).push({
      at, type, text,
      ...(provider ? { provider } : {}),
      ...(Array.isArray(providers) ? { providers: orderedProviders(providers) } : {}),
      ...(pullRequest ? { pullRequest } : {}),
    });
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
      summary = { at: event.at, number, title, actions: new Set(), providers: new Set() };
      pullRequestSummaries.set(identity, summary);
    }
    if (Date.parse(event.at) > Date.parse(summary.at)) summary.at = event.at;
    if (!summary.title && title) summary.title = title;
    summary.actions.add(action);
    for (const provider of event.providers || (event.provider ? [event.provider] : [])) summary.providers.add(provider);
  }
  for (const summary of pullRequestSummaries.values()) {
    items.push({
      at: summary.at, type: 'pull-request-summary', text: pullRequestSummaryText(summary),
      providers: orderedProviders(summary.providers),
    });
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

module.exports = {
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
};
