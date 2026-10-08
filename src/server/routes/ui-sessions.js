const { validDisplayPatch } = require('../display-preferences');
const { validPicks } = require('../decision-answers');
const { estimateTranscript } = require('../transcript');
const { validRepositoryPart } = require('../pull-request-utils');
const { isShortSessionId } = require('../session-ids');
const { jsonResponse, logLine } = require('../http-helpers');
const { validSeenRequest, validSessionId, validText } = require('../request-validation');

function createUiSessionRoutes(ctx) {
  const {
    answerDelivery, away, claudeHome, currentValidatedSessionProjectionRecords,
    homeDir, mutateCommonQuestion, pullRequestTracker, resolveProjectionProvidersForSession,
    state,
  } = ctx;

  async function handleDecisionAnswer({ request, response, params, body }) {
    let decisionId;
    try {
      decisionId = decodeURIComponent(params[1]);
    } catch {
      jsonResponse(response, 400, { error: 'Invalid decision id' });
      return;
    }
    if (decisionId.startsWith('cq-')) {
      await mutateCommonQuestion(response, decisionId, body, 'answer');
      return;
    }
    if (
      !body || typeof body !== 'object' || Array.isArray(body) ||
      !validSessionId(body.session_id) || body.choice !== null && !['ok', 'pick'].includes(body.choice) ||
      (body.choice === 'pick' ? !Array.isArray(body.picks) : Object.hasOwn(body, 'picks')) ||
      !validText(body.note, 2000, true)
    ) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    if (body.choice === null && !body.note.trim()) {
      jsonResponse(response, 400, { error: 'An answer is required' });
      return;
    }
    const decision = state.decisionFor(body.session_id, decisionId);
    if (!decision || decision.session_id !== body.session_id) {
      jsonResponse(response, 404, { error: 'Decision not found' });
      return;
    }
    if (body.choice === 'pick' && !validPicks(decision, body.picks, body.note)) {
      jsonResponse(response, 400, { error: 'Invalid picks' });
      return;
    }
    const answer = answerDelivery.submitAnswer(body.session_id, decisionId, body.choice, body.note, body.picks);
    if (answer === false) {
      jsonResponse(response, 400, { error: 'A recommended option is required for this choice' });
      return;
    }
    if (!answer) {
      jsonResponse(response, 409, { error: 'Decision cannot be answered now' });
      return;
    }
    await state.waitForPersistence();
    jsonResponse(response, 200, { decision: { id: answer.id, state: answer.state, answer: answer.answer } });
    return;
  }

  async function handleEstimate({ response, params }) {
    const sessionId = params[1];
    const session = state.snapshot().sessions.find((item) => item.session_id === sessionId);
    if (!session) {
      jsonResponse(response, 404, { error: 'Session not found' });
      return;
    }
    if (session.status !== '不明') {
      jsonResponse(response, 409, { error: 'Session state is known' });
      return;
    }
    const file = state.sessionFileFor(sessionId);
    const estimate = await estimateTranscript(claudeHome, file?.cwd, file?.native_session_id || sessionId);
    const saved = state.saveEstimate(sessionId, estimate);
    if (!saved) {
      jsonResponse(response, 409, { error: 'Session state is known' });
      return;
    }
    jsonResponse(response, 200, saved);
    return;
  }

  async function handleRecordDeletions({ request, response, body }) {
    const keys = ['session_ids', 'merge_history', 'closed_pull_requests'];
    const validPullRequest = (record) => record && typeof record === 'object' && !Array.isArray(record)
      && Object.keys(record).length === 3 && Object.keys(record).every((key) => ['owner', 'repo', 'number'].includes(key))
      && validRepositoryPart(record.owner) && validRepositoryPart(record.repo)
      && Number.isSafeInteger(record.number) && record.number > 0;
    if (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some((key) => !keys.includes(key))
      || keys.some((key) => Object.hasOwn(body, key) && (!Array.isArray(body[key]) || body[key].length > 50
        || !body[key].every(key === 'session_ids' ? isShortSessionId : validPullRequest)))
      || !keys.some((key) => body[key]?.length > 0)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const sessionIds = [...new Set(body.session_ids || [])];
    const projections = sessionIds.length ? await currentValidatedSessionProjectionRecords() : null;
    if (projections?.configuredSourceUnavailable) {
      jsonResponse(response, 503, { error: 'Session target is unavailable' });
      return;
    }
    const projectionProviders = new Map(sessionIds.map((sessionId) => [
      sessionId, projections ? resolveProjectionProvidersForSession(projections, sessionId) : [],
    ]));
    if ([...projectionProviders.values()].some((providers) => providers.length > 1)) {
      jsonResponse(response, 409, { error: 'Session target is ambiguous' });
      return;
    }
    const now = Date.now();
    let sessions = 0;
    for (const sessionId of sessionIds) {
      const provider = projectionProviders.get(sessionId)?.[0];
      if (provider) {
        if (state.deleteProjectionDisplay(provider, sessionId, now)) sessions += 1;
      } else if (state.deleteSession(sessionId, now)) sessions += 1;
    }
    const deletedPullRequests = new Set();
    const changedRepositories = new Map();
    for (const record of body.merge_history || []) {
      if (state.dismissMergedPullRequestHistory(record.owner, record.repo, record.number, now)) {
        deletedPullRequests.add(`${record.owner.toLowerCase()}/${record.repo.toLowerCase()}#${record.number}`);
      }
    }
    for (const record of body.closed_pull_requests || []) {
      if (!state.deleteClosedPullRequest(record.owner, record.repo, record.number)) continue;
      const repository = `${record.owner.toLowerCase()}/${record.repo.toLowerCase()}`;
      deletedPullRequests.add(`${repository}#${record.number}`);
      changedRepositories.set(repository, record);
    }
    for (const { owner, repo } of changedRepositories.values()) {
      try {
        await pullRequestTracker?.refreshReviewGroups?.(owner, repo);
      } catch {
        logLine(homeDir, `pull request group refresh failed for ${owner}/${repo}`);
      }
    }
    jsonResponse(response, 200, { deleted: { sessions, pullRequests: deletedPullRequests.size } });
    return;
  }

  async function handleHiddenSessions({ request, response, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const keys = Object.keys(body).sort();
    if (body.action === 'clear' && keys.length === 1 && keys[0] === 'action') {
      jsonResponse(response, 200, { cleared: state.clearHiddenSessions() });
      return;
    }
    const validHiddenSessionId = isShortSessionId;
    const isBatchUnhide = body.action === 'unhide' && keys.length === 2 && keys[0] === 'action' && keys[1] === 'session_ids' &&
      Array.isArray(body.session_ids) && body.session_ids.length >= 1 && body.session_ids.length <= 50 &&
      body.session_ids.every(validHiddenSessionId);
    if (body.action === 'unhide') {
      if (!isBatchUnhide) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const sessionIds = [...new Set(body.session_ids)];
      const projections = await currentValidatedSessionProjectionRecords();
      if (projections.configuredSourceUnavailable) {
        jsonResponse(response, 503, { error: 'Session target is unavailable' });
        return;
      }
      const projectionProviders = new Map();
      for (const sessionId of sessionIds) {
        const currentProviders = resolveProjectionProvidersForSession(projections, sessionId);
        const hiddenProviders = state.projectionDisplayRecordsForSession(sessionId)
          .filter((record) => record.hiddenAt !== undefined).map((record) => record.provider);
        const providers = currentProviders.length ? currentProviders : [...new Set(hiddenProviders)];
        if (providers.length > 1) {
          jsonResponse(response, 409, { error: 'Session target is ambiguous' });
          return;
        }
        projectionProviders.set(sessionId, providers[0] || null);
      }
      const unhiddenIds = new Set();
      const stateHiddenIds = new Set(sessionIds.filter((sessionId) => state.hiddenSessions.has(sessionId)));
      state.unhideSessions(sessionIds);
      for (const sessionId of sessionIds) {
        const provider = projectionProviders.get(sessionId);
        const projectionUnhidden = provider && state.setProjectionHidden(provider, sessionId, false);
        if (projectionUnhidden || stateHiddenIds.has(sessionId)) unhiddenIds.add(sessionId);
      }
      jsonResponse(response, 200, { unhidden: unhiddenIds.size });
      return;
    }
    const isSingleHide = keys.length === 2 && keys[0] === 'action' && keys[1] === 'session_id' && validHiddenSessionId(body.session_id);
    const isBatchHide = keys.length === 2 && keys[0] === 'action' && keys[1] === 'session_ids' &&
      Array.isArray(body.session_ids) && body.session_ids.length >= 1 && body.session_ids.length <= 50 &&
      body.session_ids.every(validHiddenSessionId);
    if (body.action !== 'hide' || (!isSingleHide && !isBatchHide)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const sessionIds = [...new Set(isSingleHide ? [body.session_id] : body.session_ids)];
    const projections = await currentValidatedSessionProjectionRecords();
    if (projections.configuredSourceUnavailable) {
      jsonResponse(response, 503, { error: 'Session target is unavailable' });
      return;
    }
    const projectionProviders = new Map(sessionIds.map((sessionId) => [
      sessionId, resolveProjectionProvidersForSession(projections, sessionId),
    ]));
    if ([...projectionProviders.values()].some((providers) => providers.length > 1)) {
      jsonResponse(response, 409, { error: 'Session target is ambiguous' });
      return;
    }
    let hiddenCount = 0;
    for (const sessionId of sessionIds) {
      const provider = projectionProviders.get(sessionId)?.[0];
      const projectionHidden = provider ? state.setProjectionHidden(provider, sessionId, true) : false;
      const stateHidden = state.hideSession(sessionId) !== null;
      if (projectionHidden || stateHidden) hiddenCount += 1;
    }
    if (hiddenCount === 0) {
      jsonResponse(response, 404, { error: 'Session not found' });
      return;
    }
    jsonResponse(response, 200, { hidden: isSingleHide ? true : hiddenCount });
    return;
  }

  async function handleDisplay({ response, body }) {
    if (!validDisplayPatch(body)) {
      jsonResponse(response, 400, { error: 'Invalid display preferences' });
      return;
    }
    jsonResponse(response, 200, { display: state.patchDisplayPreferences(body) });
    return;
  }

  async function handleSeen({ request, response, body }) {
    if (!validSeenRequest(body)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const seenAt = state.setProductSeen(body.productKey, body.generatedAt);
    await away.prune?.([...state.seenAtByProduct.values()]);
    jsonResponse(response, 200, { productKey: body.productKey, seenAt });
    return;
  }

  async function handleClosedTasks({ request, response, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'session_id,title' || !validSessionId(body.session_id) || !validText(body.title, 200)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    if (!state.snapshot().sessions.some((session) => session.session_id === body.session_id)) {
      jsonResponse(response, 404, { error: 'Session not found' });
      return;
    }
    const closed = state.closeTask(body.session_id, body.title);
    if (closed === null) {
      jsonResponse(response, 404, { error: 'Task not found' });
      return;
    }
    if (!closed) {
      jsonResponse(response, 409, { error: 'Task is already complete' });
      return;
    }
    jsonResponse(response, 200, { closed: true });
    return;
  }

  async function handleClosedAgents({ request, response, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body) ||
      Object.keys(body).sort().join(',') !== 'agent_id,session_id' || !validSessionId(body.session_id) || !validText(body.agent_id, 256)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const closed = state.closeAgent(body.session_id, body.agent_id);
    if (closed === null) {
      jsonResponse(response, 404, { error: 'Unconfirmed agent not found' });
      return;
    }
    if (!closed) {
      jsonResponse(response, 409, { error: 'Agent state changed' });
      return;
    }
    jsonResponse(response, 200, { closed: true });
    return;
  }

  return { handleDecisionAnswer, handleEstimate, handleRecordDeletions, handleHiddenSessions, handleDisplay, handleSeen, handleClosedTasks, handleClosedAgents };
}

module.exports = { createUiSessionRoutes };
