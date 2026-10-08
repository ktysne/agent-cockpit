const { jsonResponse } = require('../http-helpers');
const { validSessionId, validText, validPlanInput, decisionSummaries } = require('../request-validation');
const { sanitizeEvent } = require('../events');
const { productFromCwd } = require('../identity');
const { claudeAgentDefinition, codexAgentDefinition } = require('../session-files');
const { isCompleteCommitSha, parsePullRequestUrl, isGithubCreatePullRequestTool, validRepositoryPart } = require('../pull-request-utils');

function createHookRoutes(ctx) {
  const { state, answerDelivery, claudeHome, pullRequestTracker, pullRequestMergeManager, findSessionIdByPid, scheduleTaskNotifications } = ctx;

  async function resolveWriterSessionId(routeId, body) {
    // 呼び出し元が ID 不一致を個別の応答へ変換できるよう、解決した ID と不一致状態を返す。
    const mappedSessionId = Number.isInteger(body.ppid) ? await findSessionIdByPid(body.ppid) : null;
    const fallbackSessionId = Object.hasOwn(body, 'claudeCodeSessionId') ? body.claudeCodeSessionId : routeId;
    const sessionId = validSessionId(mappedSessionId) ? mappedSessionId : fallbackSessionId;
    const routeMismatch = !validSessionId(mappedSessionId) && typeof fallbackSessionId === 'string' &&
      routeId !== 'pending' && fallbackSessionId !== routeId;
    return { sessionId: validSessionId(sessionId) ? sessionId : null, routeMismatch };
  }

  async function handleHookAnswers({ response, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !validSessionId(body.session_id) || !validText(body.id, 256)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    try {
      let result;
      if (body.action === 'ask-register' && body.event_name === 'PreToolUse' && Array.isArray(body.questions)) {
        result = answerDelivery.registerAsk({ sessionId: body.session_id, toolUseId: body.id, questions: body.questions, agentId: body.agent_id });
      } else if (body.action === 'ask-poll' && body.event_name === 'PreToolUse') {
        result = await answerDelivery.waitForAsk({ sessionId: body.session_id, toolUseId: body.id });
      } else if (body.action === 'ask-finish' && body.event_name === 'PreToolUse' && ['answered', 'timeout', 'released', 'server-lost'].includes(body.outcome)) {
        result = answerDelivery.finishAsk({ sessionId: body.session_id, toolUseId: body.id, decisionId: body.decision_id, outcome: body.outcome });
      } else if (body.action === 'post-tool-batch' && body.event_name === 'PostToolBatch' && body.agent_id !== undefined) {
        if (!validText(body.agent_id, 256)) {
          jsonResponse(response, 400, { error: 'Invalid request' });
          return;
        }
        state.addEvent({
          session_id: body.session_id,
          hook_event_name: 'PostToolBatch',
          agent_id: body.agent_id,
          hookAt: Date.now(),
        });
        result = { hookOutput: null };
      } else if (body.action === 'post-tool-batch' && body.event_name === 'PostToolBatch') {
        state.addEvent({
          session_id: body.session_id,
          hook_event_name: 'PostToolBatch',
          hookAt: Date.now(),
        });
        const additionalContext = answerDelivery.deliverPostToolBatch(body.session_id);
        result = { hookOutput: additionalContext ? { hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext } } : null };
      } else if (body.action === 'user-prompt-submit' && body.event_name === 'UserPromptSubmit') {
        const additionalContext = answerDelivery.deliverPrompt(body.session_id, body.id, Number.isFinite(body.hook_at) ? body.hook_at : undefined);
        result = { hookOutput: additionalContext ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } } : null };
      } else if (body.action === 'stop-start' && body.event_name === 'Stop') {
        result = { generation: answerDelivery.startStop(body.session_id, body.id, Number.isFinite(body.hook_at) ? body.hook_at : undefined) };
      } else if (body.action === 'stop-poll' && body.event_name === 'Stop' && Number.isInteger(body.generation) && typeof body.parent_alive === 'boolean') {
        result = await answerDelivery.waitForStopAnswer(body.session_id, body.generation, body.parent_alive);
      } else {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      await state.waitForPersistence();
      jsonResponse(response, 200, result);
    } catch {
      jsonResponse(response, 500, { error: 'Internal Server Error' });
    }
  }

  async function handleEvents({ response, body }) {
    state.captureFieldNames(body);
    const product = productFromCwd(body.cwd);
    const sessionId = typeof body.session_id === 'string' ? body.session_id : '';
    const eventName = body.hook_event_name;
    const sessionName = sessionId ? state.sessionNameFor(sessionId) : null;
    let agentDefinition = null;
    let codexDefinitionMetadata = null;

    if (
      body.agent_id && body.agent_type && eventName !== 'SubagentStop' &&
      (eventName === 'SubagentStart' || !state.hasAgentRow(sessionId, body.agent_id))
    ) {
      agentDefinition = await claudeAgentDefinition(body.agent_type, claudeHome);
    }
    if (eventName === 'PreToolUse') {
      const preliminary = sanitizeEvent(body, { product });
      const codexAgentName = preliminary?.codexDefinition || preliminary?.codexWaitDefinition;
      if (codexAgentName) {
        codexDefinitionMetadata = await codexAgentDefinition(codexAgentName, claudeHome);
      }
    }

    const eventMetadata = { product, sessionName, agentDefinition, codexAgentDefinition: codexDefinitionMetadata };
    state.addEvent(body, eventMetadata);
    const event = sanitizeEvent(body, eventMetadata);
    // 終了通知はメインの記録に書かれるので、サブエージェントのイベントのたびには読まない。
    if (event && !event.agent_id) scheduleTaskNotifications(event.session_id);
    if (event && state.deletedSessions.has(event.session_id)
      && event.hookAt <= Date.parse(state.deletedSessions.get(event.session_id))) {
      jsonResponse(response, 202, { accepted: true });
      return;
    }
    if (event?.hook_event_name === 'PostToolUse' && event.pullRequest && (
      (event.tool_name === 'Bash' && (event.ghPrCreateCommand || state.wasPullRequestCreate(event.session_id, event.tool_use_id))) ||
      isGithubCreatePullRequestTool(event.tool_name)
    )) {
      const registered = state.registerPullRequest(event.session_id, event.pullRequest, { cwd: body.cwd, product }, event.hookAt);
      if (registered) void pullRequestTracker?.refreshRepo(registered.owner, registered.repo).catch(() => {});
    }
    if ((event?.hook_event_name === 'PostToolUse' || event?.hook_event_name === 'PostToolUseFailure') && (
      event.refreshPullRequests || state.wasPullRequestRefreshCommand(event.session_id, event.tool_use_id)
    )) void pullRequestTracker?.refreshAll().catch(() => {});
    if (event) answerDelivery.afterEvent(event);
    await state.waitForPersistence();
    jsonResponse(response, 202, { accepted: true });
  }

  async function handlePlan({ response, params, body }) {
    const routeSessionId = params[1];
    if (!validPlanInput(body) || (body.ppid !== undefined && (!Number.isInteger(body.ppid) || body.ppid < 1))) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    if (Object.hasOwn(body, 'claudeCodeSessionId') && body.claudeCodeSessionId !== null && typeof body.claudeCodeSessionId !== 'string') {
      jsonResponse(response, 400, { error: 'Invalid session id' });
      return;
    }

    const resolvedSession = await resolveWriterSessionId(routeSessionId, body);
    const sessionId = resolvedSession.sessionId;
    if (!sessionId) {
      jsonResponse(response, 400, { error: 'Session id unavailable' });
      return;
    }
    if (resolvedSession.routeMismatch) {
      jsonResponse(response, 400, { error: 'Invalid session id' });
      return;
    }

    if (body.kind === 'tasks') {
      const saved = state.setTasks(sessionId, body.tasks);
      answerDelivery.afterTasksWrite(sessionId, Date.parse(saved.updatedAt));
      jsonResponse(response, 200, { tasks: saved.tasks.map(({ title, state: taskState }) => ({ title, state: taskState })), updatedAt: saved.updatedAt });
      return;
    }
    if (body.kind === 'add_decision') {
      const decision = state.addDecision(sessionId, {
        title: body.title,
        context: body.context,
        state: body.state,
        options: body.options.map((option) => ({
          label: option.label,
          description: option.description,
          recommended: option.recommended === true,
        })),
      });
      const decisions = decisionSummaries(state, sessionId);
      jsonResponse(response, 200, { decision: { id: decision.id, title: decision.title, state: decision.state }, decisions });
      return;
    }
    const decision = state.updateDecision(sessionId, body.id, body.state, body.chosen, body.note);
    if (!decision) {
      jsonResponse(response, 404, { error: 'Decision not found or already resolved' });
      return;
    }
    answerDelivery.afterDecisionUpdate(sessionId, decision.id);
    await state.waitForPersistence();
    const decisions = decisionSummaries(state, sessionId);
    jsonResponse(response, 200, { decision: { id: decision.id, title: decision.title, state: decision.state }, decisions });
  }

  async function handleSessionPullRequests({ response, params, body }) {
    const routeSessionId = params[1];
    const isAddPullRequest = body?.kind === 'add_pr';
    const isSkipReview = body?.kind === 'skip_review';
    const pullRequest = isAddPullRequest ? parsePullRequestUrl(body.url) : null;
    const skipReviewKeys = ['claudeCodeSessionId', 'headRefOid', 'kind', 'number', 'owner', 'ppid', 'reason', 'repo'];
    const validSkipReview = isSkipReview && Object.keys(body).sort().join(',') === skipReviewKeys.join(',') &&
      validRepositoryPart(body.owner) && validRepositoryPart(body.repo) && Number.isSafeInteger(body.number) && body.number > 0 &&
      isCompleteCommitSha(body.headRefOid) && validText(body.reason, 2000);
    if ((!pullRequest && !validSkipReview) || !Number.isInteger(body.ppid) || body.ppid < 1 ||
      (body.cwd !== undefined && (typeof body.cwd !== 'string' || body.cwd.length > 4096)) ||
      (body.claudeCodeSessionId !== undefined && body.claudeCodeSessionId !== null && typeof body.claudeCodeSessionId !== 'string')) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const resolvedSession = await resolveWriterSessionId(routeSessionId, body);
    const sessionId = resolvedSession.sessionId;
    if (!sessionId || resolvedSession.routeMismatch) {
      jsonResponse(response, 400, { error: 'Session id unavailable' });
      return;
    }
    if (isSkipReview) {
      const registration = state.pullRequestRegistrationForSession(sessionId, body.owner, body.repo, body.number);
      if (!registration) {
        jsonResponse(response, 404, { error: 'PR is not registered by this session' });
        return;
      }
      if (!pullRequestTracker?.refreshRepoFresh || !pullRequestTracker.mergeCandidate) {
        jsonResponse(response, 503, { error: 'Pull request state is unavailable' });
        return;
      }
      try {
        if (!pullRequestMergeManager?.setReviewSkip) {
          jsonResponse(response, 503, { error: 'Pull request state is unavailable' });
          return;
        }
        const result = await pullRequestMergeManager.setReviewSkip(registration, body.headRefOid, body.reason);
        if (!result.ok) {
          jsonResponse(response, result.status, { error: result.error });
          return;
        }
        jsonResponse(response, 200, { ...result.saved });
      } catch {
        jsonResponse(response, 502, { error: 'Pull request state could not be refreshed' });
      }
      return;
    }
    const product = productFromCwd(body.cwd);
    const registered = state.registerPullRequest(sessionId, pullRequest, { cwd: body.cwd, product });
    if (!registered) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    void pullRequestTracker?.refreshRepo(registered.owner, registered.repo).catch(() => {});
    jsonResponse(response, 200, { owner: registered.owner, repo: registered.repo, number: registered.number, url: registered.url });
  }

  return { handleHookAnswers, handleEvents, handlePlan, handleSessionPullRequests };
}

module.exports = { createHookRoutes };
