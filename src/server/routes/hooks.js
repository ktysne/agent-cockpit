const { jsonResponse } = require('../http-helpers');
const { validSessionId, validText, validPlanInput, decisionSummaries } = require('../request-validation');
const { sanitizeEvent, isQuestionTool } = require('../events');
const { productFromCwd } = require('../identity');
const { claudeAgentDefinition, codexAgentDefinition } = require('../session-files');
const { isCompleteCommitSha, parsePullRequestUrl, isGithubCreatePullRequestTool, validRepositoryPart } = require('../pull-request-utils');
const { applyReviewSkip } = require('./review-skip');

function createHookRoutes(ctx) {
  const { state, answerDelivery, claudeHome, pullRequestTracker, pullRequestMergeManager, findSessionIdByPid, scheduleTaskNotifications } = ctx;

  async function resolveWriterSessionId(routeId, body) {
    if (Object.hasOwn(body, 'codexSessionId')) {
      if (Object.hasOwn(body, 'ppid') || Object.hasOwn(body, 'claudeCodeSessionId') ||
        !validSessionId(body.codexSessionId) || routeId !== body.codexSessionId) {
        return { status: 400, error: 'Invalid session id' };
      }
      const session = state.sessions.get(body.codexSessionId);
      if (session?.provider !== 'codex' || state.sessionHasEnded(body.codexSessionId)) {
        return { status: 403, error: 'Codex session unavailable' };
      }
      return { sessionId: body.codexSessionId, routeMismatch: false };
    }
    // 呼び出し元が ID 不一致を個別の応答へ変換できるよう、解決した ID と不一致状態を返す。
    const mappedSessionId = Number.isInteger(body.ppid) ? await findSessionIdByPid(body.ppid) : null;
    const fallbackSessionId = Object.hasOwn(body, 'claudeCodeSessionId') ? body.claudeCodeSessionId : routeId;
    const sessionId = validSessionId(mappedSessionId) ? mappedSessionId : fallbackSessionId;
    const routeMismatch = !validSessionId(mappedSessionId) && typeof fallbackSessionId === 'string' &&
      routeId !== 'pending' && fallbackSessionId !== routeId;
    return { sessionId: validSessionId(sessionId) ? sessionId : null, routeMismatch };
  }

  const INVALID_ANSWER_REQUEST = Symbol('invalid answer request');

  // 上から順に評価し、最初に一致した行を使う。post-tool-batch はサブエージェント用の行を先に置く。
  // 一致しない要求と、行の中で不正と分かった要求は 400 にする。
  const hookAnswerActions = [
    {
      matches: (body) => body.action === 'ask-register' && body.event_name === 'PreToolUse' && Array.isArray(body.questions),
      run: (body) => answerDelivery.registerAsk({ sessionId: body.session_id, toolUseId: body.id, questions: body.questions, agentId: body.agent_id,
        provider: body.provider, toolName: body.tool_name }),
    },
    {
      matches: (body) => body.action === 'ask-poll' && body.event_name === 'PreToolUse',
      run: (body) => answerDelivery.waitForAsk({ sessionId: body.session_id, toolUseId: body.id }),
    },
    {
      matches: (body) => body.action === 'ask-finish' && body.event_name === 'PreToolUse' && ['answered', 'timeout', 'released', 'server-lost'].includes(body.outcome),
      run: (body) => answerDelivery.finishAsk({ sessionId: body.session_id, toolUseId: body.id, decisionId: body.decision_id, outcome: body.outcome,
        provider: body.provider, toolName: body.tool_name }),
    },
    {
      matches: (body) => body.action === 'post-tool-batch' && body.event_name === 'PostToolBatch' && body.agent_id !== undefined,
      run: (body) => {
        if (!validText(body.agent_id, 256)) return INVALID_ANSWER_REQUEST;
        state.addEvent({
          session_id: body.session_id,
          hook_event_name: 'PostToolBatch',
          agent_id: body.agent_id,
          hookAt: Date.now(),
        });
        return { hookOutput: null };
      },
    },
    {
      matches: (body) => body.action === 'post-tool-batch' && body.event_name === 'PostToolBatch',
      run: (body) => {
        state.addEvent({
          session_id: body.session_id,
          hook_event_name: 'PostToolBatch',
          hookAt: Date.now(),
        });
        const additionalContext = answerDelivery.deliverPostToolBatch(body.session_id);
        return { hookOutput: additionalContext ? { hookSpecificOutput: { hookEventName: 'PostToolBatch', additionalContext } } : null };
      },
    },
    {
      matches: (body) => body.action === 'user-prompt-submit' && body.event_name === 'UserPromptSubmit',
      run: (body) => {
        const additionalContext = answerDelivery.deliverPrompt(body.session_id, body.id, Number.isFinite(body.hook_at) ? body.hook_at : undefined);
        return { hookOutput: additionalContext ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } } : null };
      },
    },
    {
      matches: (body) => body.action === 'stop-start' && body.event_name === 'Stop',
      run: (body) => ({ generation: answerDelivery.startStop(body.session_id, body.id, Number.isFinite(body.hook_at) ? body.hook_at : undefined) }),
    },
    {
      matches: (body) => body.action === 'stop-poll' && body.event_name === 'Stop' && Number.isInteger(body.generation) && typeof body.parent_alive === 'boolean',
      run: (body) => answerDelivery.waitForStopAnswer(body.session_id, body.generation, body.parent_alive),
    },
  ];

  async function handleHookAnswers({ response, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !validSessionId(body.session_id) || !validText(body.id, 256)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    try {
      if (body.provider !== undefined && !['claude', 'codex'].includes(body.provider) ||
        typeof body.action === 'string' && body.action.startsWith('ask-') && !isQuestionTool(body.provider, body.tool_name || 'AskUserQuestion')) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      const action = hookAnswerActions.find((candidate) => candidate.matches(body));
      const result = action ? await action.run(body) : INVALID_ANSWER_REQUEST;
      if (result === INVALID_ANSWER_REQUEST) {
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
      body.provider !== 'codex' && body.agent_id && body.agent_type && eventName !== 'SubagentStop' &&
      (eventName === 'SubagentStart' || !state.hasAgentRow(sessionId, body.agent_id))
    ) {
      agentDefinition = await claudeAgentDefinition(body.agent_type, claudeHome);
    }
    if (body.provider !== 'codex' && eventName === 'PreToolUse') {
      const preliminary = sanitizeEvent(body, { product });
      const codexAgentName = preliminary?.codexDefinition || preliminary?.codexWaitDefinition;
      if (codexAgentName) {
        codexDefinitionMetadata = await codexAgentDefinition(codexAgentName, claudeHome);
      }
    }

    const eventMetadata = { product, sessionName, agentDefinition, codexAgentDefinition: codexDefinitionMetadata };
    if (!state.addEvent(body, eventMetadata)) {
      jsonResponse(response, 202, { accepted: true });
      return;
    }
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
      const registrationCwd = event.commandCwd || body.cwd;
      const registrationProduct = event.commandCwd ? productFromCwd(event.commandCwd) : product;
      const registered = state.registerPullRequest(event.session_id, event.pullRequest, {
        cwd: registrationCwd, product: registrationProduct,
      }, event.hookAt);
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
    if (resolvedSession.status) {
      jsonResponse(response, resolvedSession.status, { error: resolvedSession.error });
      return;
    }
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
    const isCodex = Object.hasOwn(body || {}, 'codexSessionId');
    const skipReviewKeys = isCodex
      ? ['codexSessionId', 'headRefOid', 'kind', 'number', 'owner', 'reason', 'repo']
      : ['claudeCodeSessionId', 'headRefOid', 'kind', 'number', 'owner', 'ppid', 'reason', 'repo'];
    const validSkipReview = isSkipReview && Object.keys(body).sort().join(',') === skipReviewKeys.join(',') &&
      validRepositoryPart(body.owner) && validRepositoryPart(body.repo) && Number.isSafeInteger(body.number) && body.number > 0 &&
      isCompleteCommitSha(body.headRefOid) && validText(body.reason, 2000);
    if ((!pullRequest && !validSkipReview) || (!isCodex && (!Number.isInteger(body.ppid) || body.ppid < 1)) ||
      (body.cwd !== undefined && (typeof body.cwd !== 'string' || body.cwd.length > 4096)) ||
      (body.claudeCodeSessionId !== undefined && body.claudeCodeSessionId !== null && typeof body.claudeCodeSessionId !== 'string')) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const resolvedSession = await resolveWriterSessionId(routeSessionId, body);
    if (resolvedSession.status) {
      jsonResponse(response, resolvedSession.status, { error: resolvedSession.error });
      return;
    }
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
      try {
        const result = await applyReviewSkip({
          pullRequestTracker,
          pullRequestMergeManager,
          registration,
          headRefOid: body.headRefOid,
          reason: body.reason,
        });
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
    const registered = state.registerPullRequest(sessionId, pullRequest, { cwd: body.cwd, product, preserveLocation: true });
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
