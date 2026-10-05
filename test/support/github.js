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

function pullRequestRegistration(number, options = {}) {
  const {
    addedAt = '2026-10-03T00:00:00.000Z',
    product = { key: 'project', name: 'project' },
    state = 'open',
    mergedAt = null,
    lastOpen = null,
    cwd = null,
  } = options;
  return {
    session_id: `session-${number}`,
    owner: 'example',
    repo: 'project',
    number,
    url: `https://github.com/example/project/pull/${number}`,
    addedAt,
    cwd,
    product,
    state,
    mergedAt,
    lastOpen,
  };
}

function ghPullRequest(number, headRefName, baseRefName, configuration = {}) {
  const options = typeof configuration === 'string' ? { sha: configuration } : configuration;
  const { sha = String(number).repeat(40), ci = 'pass', createdAt, fields = {}, ...changes } = options;
  const statusCheckRollup = ci === 'none'
    ? null
    : [{
      state: ci === 'pending' ? 'IN_PROGRESS' : ci === 'fail' ? 'FAILURE' : 'SUCCESS',
      status: ci === 'pending' ? 'IN_PROGRESS' : 'COMPLETED',
      conclusion: ci === 'pending' ? '' : ci === 'fail' ? 'FAILURE' : 'SUCCESS',
    }];

  return {
    number,
    title: `PR ${number}`,
    url: `https://github.com/example/project/pull/${number}`,
    headRefName,
    baseRefName,
    headRefOid: sha,
    ...(createdAt ? { createdAt } : {}),
    isDraft: false,
    mergeable: 'MERGEABLE',
    mergeStateStatus: ci === 'pending' ? 'BLOCKED' : 'CLEAN',
    reviewDecision: '',
    statusCheckRollup,
    ...changes,
    ...fields,
  };
}

module.exports = { ghPullRequest, pullRequest, pullRequestRegistration };
