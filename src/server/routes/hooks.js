const EVENT_DELAY_THRESHOLD_MS = 5000;
const { recordClientEntries } = require('../../client/diagnostic-events');
const { jsonResponse } = require('../http-helpers');
const { validSessionId, validText, validPlanInput, decisionSummaries } = require('../request-validation');
const { sanitizeEvent, isQuestionTool } = require('../events');
const { productFromCwd } = require('../identity');
const { claudeAgentDefinition, codexAgentDefinition } = require('../session-files');
const { isCompleteCommitSha, parsePullRequestUrl, isGithubCreatePullRequestTool, repositoryKey, validRepositoryPart } = require('../pull-request-utils');
const { applyReviewSkip } = require('./review-skip');
const { keepImportedCriteria } = require('../plan-updates');

const CODEX_SESSION_DELEGATED = 'Codex session delegated';
// 委譲した thread への案内は配信の記録に載せない。載せると ACK で、届けていない回答と通知まで配信済みになる。
const UNRECORDED_DELIVERY = Symbol('unrecorded delivery');
const DELEGATED_CODEX_PROMPT_CONTEXT ='Agent Cockpit: タスク、判断事項、PR は委譲元の Claude のセッションが記録する。この実行は Claude のセッションから委譲された Codex なので、Agent Cockpit の MCP ツール(cockpit_*)を呼ばない。';

function createHookRoutes(ctx) {
  const { state, answerDelivery, claudeHome, userHome, pullRequestTracker, pullRequestMergeManager, findSessionIdByPid, scheduleTaskNotifications, scheduleSessionModel } = ctx;

  function refreshPullRequestsAfterCommand(event) {
    const registrations = state.readOnlyPullRequestRegistrations();
    let scopedRegistrations = null;
    if (event.refreshScopeUnknown) {
      // 対象を 1 つに決められないコマンドは、下の全体の取り直しへ回す。
    } else if (event.refreshRepository) {
      const [owner, repo] = event.refreshRepository.split('/');
      const key = repositoryKey(owner, repo);
      scopedRegistrations = registrations.filter((record) => repositoryKey(record.owner, record.repo) === key);
    } else {
      const product = event.commandCwd ? productFromCwd(event.commandCwd) : event.product || productFromCwd(event.cwd);
      if (product) scopedRegistrations = registrations.filter((record) => record.product?.key === product.key);
    }

    // 下位のフォルダーや .claude/worktrees 以外の worktree の cwd は、登録の product と key がずれるので全体へ戻す。
    if (scopedRegistrations === null || (!event.refreshRepository && scopedRegistrations.length === 0)) {
      void pullRequestTracker?.refreshAfterCommand().catch(() => {});
      return;
    }

    const repositories = new Map();
    for (const record of scopedRegistrations) {
      const key = repositoryKey(record.owner, record.repo);
      if (!repositories.has(key)) repositories.set(key, { owner: record.owner, repo: record.repo });
    }
    for (const { owner, repo } of repositories.values()) {
      void pullRequestTracker?.refreshRepoFresh(owner, repo).catch(() => {});
    }
  }

  async function resolveWriterSessionId(routeId, body) {
    if (Object.hasOwn(body, 'codexSessionId')) {
      if (Object.hasOwn(body, 'ppid') || Object.hasOwn(body, 'claudeCodeSessionId') ||
        !validSessionId(body.codexSessionId) || routeId !== body.codexSessionId) {
        return { status: 400, error: 'Invalid session id' };
      }
      if (state.isDelegatedCodexThread(body.codexSessionId)) return { status: 403, error: CODEX_SESSION_DELEGATED };
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
      matches: (body) => body.action === 'delivery-ack' && validText(body.delivery_id, 256),
      run: (body) => ({ acknowledged: answerDelivery.acknowledgeHookDelivery(body.session_id, body.delivery_id) }),
    },
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
      matches: (body) => body.action === 'post-tool-use' && body.event_name === 'PostToolUse' && body.provider === 'codex',
      run: (body) => {
        const additionalContext = answerDelivery.deliverPostToolBatch(body.session_id);
        return { hookOutput: additionalContext ? { hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext } } : null };
      },
    },
    {
      matches: (body) => body.action === 'user-prompt-submit' && body.event_name === 'UserPromptSubmit',
      run: (body) => {
        if (state.isDelegatedCodexThread(body.session_id)) {
          return { hookOutput: { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: DELEGATED_CODEX_PROMPT_CONTEXT } },
            [UNRECORDED_DELIVERY]: true };
        }
        const additionalContext = answerDelivery.deliverPrompt(body.session_id, body.id, Number.isFinite(body.hook_at) ? body.hook_at : undefined);
        return { hookOutput: additionalContext ? { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext } } : null };
      },
    },
    {
      matches: (body) => body.action === 'stop-check' && body.event_name === 'Stop' && ['claude', 'codex'].includes(body.provider),
      run: (body) => answerDelivery.checkStop(body.session_id, body.id, Number.isFinite(body.hook_at) ? body.hook_at : undefined),
    },
    {
      matches: (body) => body.action === 'stop-start' && body.event_name === 'Stop',
      run: (body) => ({ generation: answerDelivery.startStop(body.session_id, body.id, Number.isFinite(body.hook_at) ? body.hook_at : undefined) }),
    },
    {
      matches: (body) => body.action === 'stop-poll' && body.event_name === 'Stop' && Number.isInteger(body.generation) &&
        typeof body.parent_alive === 'boolean' && (body.provider === undefined || body.provider === 'codex'),
      run: (body) => answerDelivery.waitForStopAnswer(body.session_id, body.generation, body.parent_alive, body.provider || 'claude'),
    },
  ];

  const deliveryActions = new Set(['ask-finish', 'post-tool-batch', 'post-tool-use', 'user-prompt-submit', 'stop-check', 'stop-poll']);

  function hasHookOutput(result) {
    return Boolean(result?.hookOutput || (typeof result?.stderrText === 'string' && result.stderrText));
  }

  async function handleHookAnswers({ request, response, body }) {
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
      let result = INVALID_ANSWER_REQUEST;
      if (action) {
        const generation = body.action === 'stop-poll' ? body.generation : null;
        const cached = deliveryActions.has(body.action)
          ? answerDelivery.getHookDelivery(body.session_id, body.action, body.id, generation)
          : null;
        const replayAllowed = cached && (!['stop-check', 'stop-poll'].includes(body.action) ||
          answerDelivery.canReplayStopDelivery(body.session_id, cached, body.parent_alive !== false));
        if (replayAllowed) result = cached.response;
        else if (cached && body.action === 'stop-check') result = { hookOutput: null, generation: null, wait: false };
        else if (cached && body.action === 'stop-poll') result = { stderrText: null, done: true };
        else result = await action.run(body);
        if (result !== INVALID_ANSWER_REQUEST && deliveryActions.has(body.action) && hasHookOutput(result) && !replayAllowed &&
          !result[UNRECORDED_DELIVERY]) {
          const delivery = answerDelivery.recordHookDelivery({
            sessionId: body.session_id,
            action: body.action,
            requestId: body.id,
            response: result,
            requestGeneration: body.action === 'stop-poll' ? body.generation : null,
            generation: body.action === 'stop-check' ? result.generation : body.action === 'stop-poll' ? body.generation : null,
            decisionId: body.action === 'ask-finish' ? body.decision_id : null,
          });
          if (!delivery) {
            jsonResponse(response, 503, { error: 'Delivery capacity reached' });
            return;
          }
          result = delivery.response;
        }
      }
      if (result === INVALID_ANSWER_REQUEST) {
        jsonResponse(response, 400, { error: 'Invalid request' });
        return;
      }
      await state.waitForPersistence();
      jsonResponse(response, 200, result);
    } catch (error) {
      request?.setDiagnosticError?.(error);
      jsonResponse(response, 500, { error: 'Internal Server Error' });
    }
  }

  async function handleEvents({ response, body }) {
    if (body?.hook_event_name === 'BackgroundTaskEnd' || (body?.hook_event_name === 'Interrupt' && body.provider !== 'codex')) {
      jsonResponse(response, 202, { accepted: true });
      return;
    }
    recordClientEntries(ctx.diagnostics, body?.diagnostics, 'hook');
    const receivedAt = Date.now();
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
        codexDefinitionMetadata = await codexAgentDefinition(codexAgentName, claudeHome, userHome);
      }
    }

    let rejected = false;
    const eventMetadata = { product, sessionName, agentDefinition, codexAgentDefinition: codexDefinitionMetadata,
      diagnostics: ctx.diagnostics, onRejected: () => { rejected = true; } };
    if (!state.addEvent(body, eventMetadata)) {
      jsonResponse(response, 202, { accepted: true });
      return;
    }
    const event = sanitizeEvent(body, eventMetadata);
    if (event && !rejected) {
      const data = { event: event.hook_event_name, provider: event.provider, tool: event.tool_name,
        session: event.session_id.slice(0, 8), product: product?.name, delayMs: receivedAt - event.hookAt };
      ctx.diagnostics?.record('debug', 'server', 'event.accepted', data);
      if (ctx.eventCounts) ctx.eventCounts[event.hook_event_name] = (ctx.eventCounts[event.hook_event_name] || 0) + 1;
      if (data.delayMs > EVENT_DELAY_THRESHOLD_MS) ctx.diagnostics?.record('info', 'server', 'event.delayed', data);
      if (['SessionStart', 'SessionEnd'].includes(event.hook_event_name)) ctx.diagnostics?.record('info', 'server', 'event.lifecycle', data);
    }

    if (event && !event.agent_id) state.noteHookCwd(event.session_id, body.cwd);
    // 終了通知はメインの記録に書かれるので、サブエージェントのイベントのたびには読まない。
    if (event && !event.agent_id) scheduleTaskNotifications(event.session_id);
    if (event) scheduleSessionModel(event);
    if (event && state.deletedSessions.has(event.session_id)
      && event.hookAt <= Date.parse(state.deletedSessions.get(event.session_id))) {
      jsonResponse(response, 202, { accepted: true });
      return;
    }
    if (!rejected && event?.planUpdate && !event.agent_id && event.provider !== 'codex' &&
      state.getDisplayPreferences().importAppTasks === true) {
      const tasks = state.planUpdates.apply(event, state.planFor(event.session_id),
        state.sessionNameFor(event.session_id) || state.sessions.get(event.session_id)?.title);
      if (tasks) {
        const saved = state.setTasks(event.session_id, tasks);
        state.markAppTasks(event.session_id);
        answerDelivery.afterTasksWrite(event.session_id, Date.parse(saved.updatedAt));
      }
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
    )) refreshPullRequestsAfterCommand(event);
    if (event) answerDelivery.afterEvent(event);
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
      const incoming = body.tasks.map(task => ({ ...task, criteria: task.criteria || [] }));
      // 取り込みの無い CLI などは一覧全体を書くので置き換える。2 件以上も一覧全体を書く形として扱う。
      const plan = state.planFor(sessionId);
      const importing = state.getDisplayPreferences().importAppTasks === true && state.providerForSession(sessionId) !== 'codex';
      const merging = importing && incoming.length === 1 && plan.appTasks === true;
      const previousAt = Date.parse(plan.tasksUpdatedAt);
      const tasks = merging ? state.planUpdates.merge(sessionId, plan, incoming)
        : importing ? keepImportedCriteria(plan.tasks, incoming) : incoming;
      const saved = state.setTasks(sessionId, tasks);
      // 置き換えより前の基準から組み立て直すと、置き換えた内容が消えるため、基準を置き換えた一覧にする。
      if (!merging) {
        state.planUpdates.replaced(sessionId, saved.tasks, Date.parse(saved.updatedAt), Number.isFinite(previousAt) ? previousAt : -Infinity);
      }
      answerDelivery.afterTasksWrite(sessionId, Date.parse(saved.updatedAt));
      jsonResponse(response, 200, { tasks: saved.tasks.map(({ title, state: taskState }) => ({ title, state: taskState })), updatedAt: saved.updatedAt });
      return;
    }
    if (body.kind === 'add_decision') {
      const decision = state.addDecision(sessionId, {
        title: body.title,
        context: body.context,
        state: body.state,
        ...(body.verify ? { verify: body.verify } : {}),
        options: body.options.map((option) => ({
          label: option.label,
          description: option.description,
          recommended: option.recommended === true,
          ...(option.next !== undefined ? { next: option.next } : {}),
        })),
      });
      const decisions = decisionSummaries(state, sessionId);
      jsonResponse(response, 200, { decision: { id: decision.id, title: decision.title, state: decision.state }, decisions });
      return;
    }
    const decision = body.kind === 'report_launch'
      ? state.reportLaunch(sessionId, body.id, body.url !== undefined ? { url: body.url } : { process: body.process })
      : state.updateDecision(sessionId, body.id, body.state, body.chosen, body.note);
    if (!decision) {
      jsonResponse(response, 404, { error: 'Decision not found or already resolved' });
      return;
    }
    if (body.kind !== 'report_launch') answerDelivery.afterDecisionUpdate(sessionId, decision.id);
    await state.waitForPersistence();
    const decisions = decisionSummaries(state, sessionId);
    jsonResponse(response, 200, { decision: { id: decision.id, title: decision.title, state: decision.state }, decisions });
  }

  async function handleSessionPullRequests({ request, response, params, body }) {
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
      } catch (error) {
        request?.setDiagnosticError?.(error);
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
