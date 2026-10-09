const { sanitizeEvent } = require('../events');
const {
  isCompleteCommitSha, parsePullRequestUrl, isGithubCreatePullRequestTool, validRepositoryPart,
} = require('../pull-request-utils');
const { productFromCwd } = require('../identity');
const { claudeAgentDefinition, codexAgentDefinition } = require('../session-files');
const { jsonResponse } = require('../http-helpers');
const {
  decisionSummaries, hasExactKeys, hasOnlyKeys, validPlanInput,
  validSessionId, validText,
} = require('../request-validation');
const { WRITER_CLAIM_FIELDS } = require('../server-constants');
const { applyReviewSkip } = require('./review-skip');

function createHookRoutes(ctx) {
  const {
    answerDelivery, applyClaudeLineage, claudeHome, claudeIssuer,
    providerEventAdapters, providerEventProjection, pullRequestMergeManager, pullRequestTracker,
    registrationRegistry, resolveFreshWriterSessionId, resolveWriterSessionId, scheduleTaskNotifications,
    state,
  } = ctx;

  const INVALID_ANSWER_REQUEST = Symbol('invalid answer request');

  // 上から順に評価し、最初に一致した行を使う。post-tool-batch はサブエージェント用の行を先に置く。
  // 一致しない要求と、行の中で不正と分かった要求は 400 にする。
  const hookAnswerActions = [
    {
      matches: (body) => body.action === 'ask-register' && body.event_name === 'PreToolUse' && Array.isArray(body.questions),
      run: (body) => answerDelivery.registerAsk({ sessionId: body.session_id, toolUseId: body.id, questions: body.questions, agentId: body.agent_id }),
    },
    {
      matches: (body) => body.action === 'ask-poll' && body.event_name === 'PreToolUse',
      run: (body, authorize) => answerDelivery.waitForAsk({ sessionId: body.session_id, toolUseId: body.id, authorize }),
    },
    {
      matches: (body) => body.action === 'ask-finish' && body.event_name === 'PreToolUse' && ['answered', 'timeout', 'released', 'server-lost'].includes(body.outcome),
      run: (body) => answerDelivery.finishAsk({ sessionId: body.session_id, toolUseId: body.id, decisionId: body.decision_id, outcome: body.outcome }),
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
      run: (body, authorize) => answerDelivery.waitForStopAnswer(body.session_id, body.generation, body.parent_alive, authorize),
    },
  ];

  async function handleHookAnswers({ request, response, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body) || !validSessionId(body.session_id) || !validText(body.id, 256)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    if (Object.hasOwn(body, 'claudeLineage')) {
      const attached = await applyClaudeLineage(body);
      if (!attached.ok) {
        jsonResponse(response, 403, { error: 'Writer unavailable', reason: attached.reason });
        return;
      }
      body = attached.body;
    }
    const answerRequest = { ...body };
    let authorizationDenied = false;
    let authorizeAnswer;
    if (Object.hasOwn(body, 'writer')) {
      const authorization = registrationRegistry.authorizeEvent(body.writer);
      if (WRITER_CLAIM_FIELDS.some((field) => Object.hasOwn(body, field)) ||
          !authorization.ok || body.session_id !== authorization.sessionId) {
        jsonResponse(response, 403, { error: 'Writer unavailable' });
        return;
      }
      answerRequest.session_id = authorization.sessionId;
      delete answerRequest.writer;
      authorizeAnswer = () => {
        const current = registrationRegistry.authorizeEvent(body.writer);
        const authorized = current.ok && current.sessionId === body.session_id;
        if (!authorized) authorizationDenied = true;
        return authorized;
      };
    } else if (WRITER_CLAIM_FIELDS.some((field) => Object.hasOwn(body, field)) ||
        registrationRegistry.isRegisteredSessionId(body.session_id)) {
      jsonResponse(response, 403, { error: 'Writer unavailable' });
      return;
    } else {
      authorizeAnswer = () => {
        const authorized = !registrationRegistry.isRegisteredSessionId(body.session_id);
        if (!authorized) authorizationDenied = true;
        return authorized;
      };
    }
    try {
      const action = hookAnswerActions.find((candidate) => candidate.matches(answerRequest));
      const result = action ? await action.run(answerRequest, authorizeAnswer) : INVALID_ANSWER_REQUEST;
      if (result === INVALID_ANSWER_REQUEST) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      if (authorizationDenied) {
        jsonResponse(response, 403, { error: 'Writer unavailable' });
        return;
      }
      await state.waitForPersistence();
      jsonResponse(response, 200, result);
    } catch {
      jsonResponse(response, 500, { error: 'Internal Server Error' });
    }
    return;
  }

  async function handleClaudeWriter({ request, response, body }) {
    if (!hasExactKeys(body, ['ppid', 'contextPid']) || !Number.isSafeInteger(body.ppid) || body.ppid < 1 ||
        !Number.isSafeInteger(body.contextPid) || body.contextPid < 1) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    if (!claudeIssuer) {
      jsonResponse(response, 503, { error: 'Claude writer issuer unavailable' });
      return;
    }
    const attested = await claudeIssuer.attestMcp({ ppid: body.ppid, contextPid: body.contextPid });
    if (!attested.ok) {
      jsonResponse(response, 403, { error: 'Writer unavailable', reason: attested.reason });
      return;
    }
    jsonResponse(response, 200, { writer: attested.writer });
    return;
  }

  async function handleEvents({ request, response, body }) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    if (Object.hasOwn(body, 'claudeLineage')) {
      const attached = await applyClaudeLineage(body);
      if (!attached.ok) {
        jsonResponse(response, 403, { error: 'Writer unavailable', reason: attached.reason });
        return;
      }
      body = attached.body;
    }
    const eventBody = { ...body };
    const writerEnvelope = Object.hasOwn(body, 'writer') ? body.writer : null;
    if (Object.hasOwn(body, 'writer')) {
      const authorization = registrationRegistry.authorizeEvent(writerEnvelope);
      if (WRITER_CLAIM_FIELDS.some((field) => Object.hasOwn(body, field)) ||
          !authorization.ok || body.session_id !== authorization.sessionId) {
        jsonResponse(response, 403, { error: 'Writer unavailable' });
        return;
      }
      eventBody.session_id = authorization.sessionId;
      delete eventBody.writer;
    } else {
      if (WRITER_CLAIM_FIELDS.some((field) => Object.hasOwn(body, field)) ||
          registrationRegistry.isRegisteredSessionId(body.session_id)) {
        jsonResponse(response, 403, { error: 'Writer unavailable' });
        return;
      }
    }

    let eventAdapter = null;
    let registration = null;
    if (writerEnvelope) {
      const checked = providerEventProjection.inspect(writerEnvelope, eventBody.session_id);
      if (!checked.ok) {
        jsonResponse(response, 403, { error: 'Writer unavailable' });
        return;
      }
      registration = checked.registration;
      eventAdapter = providerEventAdapters.get(registration.provider);
      const normalized = eventAdapter.normalize(eventBody);
      if (!normalized.ok) {
        const result = eventAdapter.project({ writer: writerEnvelope, sessionId: eventBody.session_id, event: eventBody });
        if (result.action === 'reject') {
          jsonResponse(response, 403, { error: 'Writer unavailable' });
        } else {
          jsonResponse(response, 202, { accepted: false, status: 'unknown', reason: result.reason });
        }
        return;
      }
      Object.assign(eventBody, normalized.event);
    }
    const product = productFromCwd(eventBody.cwd || eventBody.nativeEvent?.cwd);
    const sessionId = typeof eventBody.session_id === 'string' ? eventBody.session_id : '';
    const eventName = eventBody.hook_event_name;
    const agentId = eventBody.agent_id || eventBody.nativeEvent?.agent_id;
    const agentType = eventBody.agent_type || eventBody.nativeEvent?.agent_type;
    const sessionName = sessionId ? state.sessionNameFor(sessionId) : null;
    const incomingEvent = sanitizeEvent(eventBody, { product, sessionName });
    const deletedAt = incomingEvent && state.deletedSessions.get(incomingEvent.session_id);
    if (deletedAt && incomingEvent.hookAt <= Date.parse(deletedAt)) {
      jsonResponse(response, 202, { accepted: true });
      return;
    }
    let agentDefinition = null;
    let codexDefinitionMetadata = null;

    if (
      (registration?.provider === 'claude' || !registration) && agentId && agentType && eventName !== 'SubagentStop' &&
      (eventName === 'SubagentStart' || !state.hasAgentRow(sessionId, agentId))
    ) {
      agentDefinition = await claudeAgentDefinition(agentType, claudeHome);
    }
    if (eventName === 'PreToolUse') {
      const preliminary = sanitizeEvent(eventBody, { product });
      const codexAgentName = preliminary?.codexDefinition || preliminary?.codexWaitDefinition;
      if (codexAgentName) {
        codexDefinitionMetadata = await codexAgentDefinition(codexAgentName, claudeHome);
      }
    }

    let stateEventBody = eventBody;
    let preserveProjectionOrder = false;
    if (writerEnvelope) {
      const authorization = registrationRegistry.authorizeEvent(writerEnvelope);
      const checked = providerEventProjection.inspect(writerEnvelope, eventBody.session_id, registration.provider);
      if (!authorization.ok || eventBody.session_id !== authorization.sessionId || !checked.ok) {
        jsonResponse(response, 403, { error: 'Writer unavailable' });
        return;
      }
      const result = eventAdapter.project({ writer: writerEnvelope, sessionId: eventBody.session_id, event: eventBody });
      if (result.action === 'reject') {
        jsonResponse(response, 403, { error: 'Writer unavailable' });
        return;
      }
      if (result.action === 'duplicate') {
        jsonResponse(response, 202, { accepted: true, duplicate: true });
        return;
      }
      if (result.action === 'unknown') {
        jsonResponse(response, 202, { accepted: false, status: 'unknown', reason: result.reason });
        return;
      }
      preserveProjectionOrder = true;
      stateEventBody = { ...result.event };
      delete stateEventBody.nativeEvent;
      delete stateEventBody.nativeEventId;
    } else if (registrationRegistry.isRegisteredSessionId(eventBody.session_id)) {
      jsonResponse(response, 403, { error: 'Writer unavailable' });
      return;
    }
    state.captureFieldNames(stateEventBody);
    const eventMetadata = {
      product,
      ...(registration ? { provider: registration.provider } : {}),
      sessionName,
      agentDefinition,
      codexAgentDefinition: codexDefinitionMetadata,
      ...(preserveProjectionOrder ? { preserveProjectionOrder: true } : {}),
      ...(registration ? { onVerifiedStateWrite: (event) => event.hook_event_name !== 'SessionEnd' &&
        state.clearProjectionDeletionAfterVerifiedWrite(registration.provider, event.session_id, event.hookAt) } : {}),
    };
    state.addEvent(stateEventBody, eventMetadata);
    const event = sanitizeEvent(stateEventBody, eventMetadata);
    if (event && !event.agent_id) scheduleTaskNotifications?.(event.session_id);
    if (event && state.deletedSessions.has(event.session_id)
      && event.hookAt <= Date.parse(state.deletedSessions.get(event.session_id))) {
      jsonResponse(response, 202, { accepted: true });
      return;
    }
    if (event?.hook_event_name === 'PostToolUse' && event.pullRequest && (
      (event.tool_name === 'Bash' && (event.ghPrCreateCommand || state.wasPullRequestCreate(event.session_id, event.tool_use_id))) ||
      isGithubCreatePullRequestTool(event.tool_name)
    )) {
      const registrationCwd = event.commandCwd || stateEventBody.cwd;
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
    return;
  }

  async function handlePlan({ request, response, params, body }) {
    const routeSessionId = params[1];

    if (!validPlanInput(body) || (body.ppid !== undefined && (!Number.isInteger(body.ppid) || body.ppid < 1))) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    if (Object.hasOwn(body, 'claudeCodeSessionId') && body.claudeCodeSessionId !== null && typeof body.claudeCodeSessionId !== 'string') {
      jsonResponse(response, 400, { error: 'Invalid session id' });
      return;
    }

    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'writer')) {
      jsonResponse(response, 403, { error: 'Writer unavailable' });
      return;
    }
    if (Object.hasOwn(body, 'session_id') || WRITER_CLAIM_FIELDS.some((field) => Object.hasOwn(body, field))) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const sessionId = await resolveFreshWriterSessionId(routeSessionId, body);
    if (!sessionId) {
      jsonResponse(response, 403, { error: 'Writer unavailable' });
      return;
    }
    const planFields = {
      tasks: ['kind', 'tasks', 'writer', 'ppid'],
      add_decision: ['kind', 'title', 'context', 'state', 'options', 'writer', 'ppid'],
      update_decision: ['kind', 'id', 'state', 'chosen', 'note', 'writer', 'ppid'],
    }[body.kind];
    if (!hasOnlyKeys(body, planFields)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
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
    return;
  }

  async function handleSessionPullRequests({ request, response, params, body }) {
    const routeSessionId = params[1];
    const isAddPullRequest = body?.kind === 'add_pr';
    const isSkipReview = body?.kind === 'skip_review';
    const pullRequest = isAddPullRequest ? parsePullRequestUrl(body.url) : null;
    const skipReviewKeys = ['headRefOid', 'kind', 'number', 'owner', 'reason', 'repo', 'writer'];
    const validSkipReview = isSkipReview && Object.keys(body).sort().join(',') === skipReviewKeys.join(',') &&
      validRepositoryPart(body.owner) && validRepositoryPart(body.repo) && Number.isSafeInteger(body.number) && body.number > 0 &&
      isCompleteCommitSha(body.headRefOid) && validText(body.reason, 2000);
    if ((!pullRequest && !validSkipReview) ||
      (body.ppid !== undefined && (!Number.isInteger(body.ppid) || body.ppid < 1)) ||
      (body.cwd !== undefined && (typeof body.cwd !== 'string' || body.cwd.length > 4096)) ||
      (body.claudeCodeSessionId !== undefined && body.claudeCodeSessionId !== null && typeof body.claudeCodeSessionId !== 'string')) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    if (!Object.hasOwn(body, 'writer')) {
      jsonResponse(response, 403, { error: 'Writer unavailable' });
      return;
    }
    if (Object.hasOwn(body, 'session_id') || WRITER_CLAIM_FIELDS.some((field) => Object.hasOwn(body, field))) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const addPullRequestFields = ['kind', 'url', 'writer', 'cwd', 'ppid'];
    if (!isSkipReview && !hasOnlyKeys(body, addPullRequestFields)) {
      jsonResponse(response, 400, { error: 'Invalid request' });
      return;
    }
    const sessionId = await resolveFreshWriterSessionId(routeSessionId, body);
    if (!sessionId) {
      jsonResponse(response, 403, { error: 'Writer unavailable' });
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
          pullRequestTracker, pullRequestMergeManager, registration,
          headRefOid: body.headRefOid, reason: body.reason,
          authorize: () => resolveWriterSessionId(routeSessionId, body) === sessionId,
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
    return;
  }

  return { handleHookAnswers, handleClaudeWriter, handleEvents, handlePlan, handleSessionPullRequests };
}

module.exports = { createHookRoutes };
