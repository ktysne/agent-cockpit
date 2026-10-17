const { jsonResponse, logLine } = require('../http-helpers');
const { validSessionId, validText, validSeenRequest } = require('../request-validation');
const { validDisplayPatch } = require('../display-preferences');
const { validPicks } = require('../decision-answers');
const { estimateTranscript } = require('../transcript');
const { isShortSessionId } = require('../session-ids');
const { validRepositoryPart } = require('../pull-request-utils');

function createUiSessionRoutes(ctx) {
  const { homeDir, claudeHome, state, away, answerDelivery, pullRequestTracker } = ctx;

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
    if (state.providerForSession(sessionId) !== 'claude') {
      jsonResponse(response, 422, { error: 'State estimation is not supported for this provider' });
      return;
    }
    const file = state.sessionFileFor(sessionId);
    const estimate = await estimateTranscript(claudeHome, file?.cwd, sessionId);
    const saved = state.saveEstimate(sessionId, estimate);
    if (!saved) {
      jsonResponse(response, 409, { error: 'Session state is known' });
      return;
    }
    jsonResponse(response, 200, saved);
  }

  function handleHiddenSessions({ response, body }) {
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
      jsonResponse(response, 200, { unhidden: state.unhideSessions(body.session_ids) });
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
    const sessionIds = isSingleHide ? [body.session_id] : body.session_ids;
    let hiddenCount = 0;
    for (const sessionId of new Set(sessionIds)) {
      if (state.hideSession(sessionId) !== null) hiddenCount += 1;
    }
    if (hiddenCount === 0) {
      jsonResponse(response, 404, { error: 'Session not found' });
      return;
    }
    jsonResponse(response, 200, { hidden: isSingleHide ? true : hiddenCount });
  }

  async function handleRecordDeletions({ response, body }) {
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
    const now = Date.now();
    let sessions = 0;
    for (const sessionId of new Set(body.session_ids || [])) {
      if (state.deleteSession(sessionId, now)) sessions += 1;
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
  }

  function handleClosedTasks({ response, body }) {
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
  }

  function handleClosedAgents({ response, body }) {
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
  }

  async function handleSeen({ response, body }) {
    if (!validSeenRequest(body)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const seenAt = state.setProductSeen(body.productKey, body.generatedAt);
    await away.prune?.([...state.seenAtByProduct.values()]);
    jsonResponse(response, 200, { productKey: body.productKey, seenAt });
  }

  function handleDisplay({ response, body }) {
    if (!validDisplayPatch(body)) {
      jsonResponse(response, 400, { error: 'Invalid display preferences' });
      return;
    }
    jsonResponse(response, 200, { display: state.patchDisplayPreferences(body) });
  }

  async function handleDecisionAnswer({ response, params, body }) {
    let decisionId;
    try {
      decisionId = decodeURIComponent(params[1]);
    } catch {
      jsonResponse(response, 400, { error: 'Invalid decision id' });
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
    jsonResponse(response, 200, { decision: { id: answer.id, state: answer.state, answer: answer.answer }, persistence: state.persistenceStatus?.() });
  }

  return { handleEstimate, handleHiddenSessions, handleRecordDeletions, handleClosedTasks, handleClosedAgents, handleSeen, handleDisplay, handleDecisionAnswer };
}

module.exports = { createUiSessionRoutes };
