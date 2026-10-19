// イベント列からセッションを組み立てる。hookAt と sequence の順に、applyCommonEventStart → 種類別の処理 → applyCommonEventEnd の順で適用する。
// 副作用は渡されたセッションにだけ及び、保存要求は出さない。
const { isQuestionTool } = require('./events');
const { isPullRequestShellTool } = require('./pull-request-utils');

const CODEX_UNKNOWN_ANSWER_NOTE = '元の画面で回答済み(内容は不明)';
// 次の入力は質問への回答とは限らないので、回答を確かめたと読めない言い方にする。
const CODEX_NEXT_INPUT_NOTE = '次の入力を検出(回答は未確認)';

function isoTime(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function agentFor(session, agentId) {
  if (!agentId) return null;
  return session.agents.find((agent) => agent.agent_id === agentId) || null;
}

// 非対話の claude -p は kind が interactive 以外になる。kind が無い、空、または文字列でないファイルは対話として扱う。
function isNonInteractiveSessionFile(file) {
  return typeof file?.kind === 'string' && file.kind.trim() !== '' && file.kind !== 'interactive';
}

// 状態が不明なときにセッションファイルの status で状態を決めてよいか。非対話の実行中は busy では決めず、「非対話の実行中」を保つ。
function fileStatusDecidesState(file) {
  return file?.status === 'idle' || (file?.status === 'busy' && !isNonInteractiveSessionFile(file));
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

/** @typedef {{tool_use_id: string, tool_name: string, summary: string, description: string, agent_id: string|null, startedAt: string}} SessionTool */

/** @typedef {{agent_id: string|null, target_tool_use_id: string|null, tool_name: string, summary: string, notification_type: string, message: string, startedAt: string, phase: 'checking'|'prompted', candidate_tool_use_ids?: string[]}} PermissionWait */

/** @typedef {ReturnType<typeof agentModelFromDefinition> & {
 * agent_id: string, startedAt: string|null, endedAt?: number, isCodex?: boolean, parent_agent_id?: string|null, runId?: string, backgroundTaskId?: string, backgrounded?: boolean, deniedCandidate?: boolean, deniedAt?: number, unconfirmed?: boolean, resultReceived?: boolean, waitEnded?: boolean, route?: string, codex_home?: string, unavailable?: string
 * }} SessionAgent */

/** @typedef {{session_id: string, provider: 'claude'|'codex', codex?: {model: string, resumes: number}, product: string, title: string, status: string, lastActivityAt?: string, stopped: boolean, interrupted: boolean, turnKnown: boolean, ended: boolean}} SessionIdentity */

/** @typedef {{tools: SessionTool[], completedToolIds: Set<string>, agentToolBindings: Object<string, string|symbol|null>}} SessionTools */

/** @typedef {{agents: SessionAgent[], backgrounds: Array<{taskId: string, agent_id: string, startedAt: string, description: string, tool_name: string, summary: string}>, stoppedAgentIds: Set<string>, launchedAgentIds: Set<string>}} SessionAgents */

/** @typedef {{pendingCodex: Object<string, string>, pendingCodexWait: Object<string, boolean>, codexLaunchToolIds: Set<string>, codexReviewAgentIds: Set<string>}} SessionCodex */

/** @typedef {{decisions: Array<ReturnType<typeof cloneDecision>>, decisionBindings: Object<string, string>, awayHandledIds: Set<string>}} SessionDecisions */

/** @typedef {{permissionWaits: PermissionWait[], permissionBoundaries: Set<string|null>}} SessionPermissions */

/** @typedef {SessionIdentity & SessionTools & SessionAgents & SessionCodex & SessionDecisions & SessionPermissions} DerivedSession */

/** @typedef {{decisions?: Array<ReturnType<typeof cloneDecision>>, bindings?: Object<string, string>, finishedOutsideEventsIds?: string[], awayHandledIds?: string[]}} AskDecisionState */

/** @returns {DerivedSession} */
function newSession(event, askDecisionState = {}) {
  return {
    session_id: event.session_id,
    provider: event.provider,
    ...(event.provider === 'codex' ? { codex: { model: '', resumes: 0 } } : {}),
    product: event.product,
    title: event.sessionName,
    status: '不明',
    tools: [],
    completedToolIds: new Set(),
    stoppedAgentIds: new Set(),
    launchedAgentIds: new Set(),
    codexLaunchToolIds: new Set(),
    agents: [],
    backgrounds: [],
    permissionWaits: [],
    permissionBoundaries: new Set(),
    decisions: (askDecisionState.decisions || []).map(cloneDecision),
    decisionBindings: Object.assign(Object.create(null), askDecisionState.bindings || {}),
    awayHandledIds: new Set(askDecisionState.awayHandledIds || []),
    codexQuestionTools: Object.create(null),
    startedAskToolUseIds: new Set(),
    stopped: false,
    interrupted: false,
    turnKnown: false,
    ended: false,
    pendingCodex: Object.create(null),
    pendingCodexWait: Object.create(null),
    codexReviewAgentIds: new Set(),
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

function isClosableAgent(agent) {
  return (!agent.active && agent.unconfirmed)
    || (!agent.isCodex && agent.backgrounded && agent.active)
    || (agent.isCodex && agent.backgrounded && !agent.parent_agent_id && agent.active);
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

// 前面のツールは呼び出し元のターンより長く続かないので、PostToolUse を受けないまま呼び出し元が止まった起動は終了未確認にする。
// 記録は遅れた PostToolUse の判定のために残す。
function deactivatePendingCodex(session, parentAgentId) {
  for (const [toolUseId, agentId] of Object.entries(session.pendingCodex)) {
    if (session.pendingCodexWait[toolUseId]) continue;
    const agent = agentFor(session, agentId);
    if (agent?.active && !agent.deniedCandidate && !agent.backgrounded && sameAgent(agent.parent_agent_id, parentAgentId)) {
      agent.active = false;
      agent.unconfirmed = true;
    }
  }
}

// 前面のサブエージェントは呼び出し元のターンより長く続かないため、停止の通知が無くても終了未確認にする。
function deactivateForegroundAgent(session, agent) {
  if (!agent || agent.isCodex || !agent.active || agent.backgrounded) return;
  agent.active = false;
  agent.unconfirmed = true;
  session.tools = session.tools.filter((tool) => tool.agent_id !== agent.agent_id);
  session.permissionWaits = session.permissionWaits.filter((wait) => wait.agent_id !== agent.agent_id);
  deactivatePendingCodex(session, agent.agent_id);
}

function stopAgent(session, agentId, stoppedAgentIds, hookAt) {
  const agent = agentFor(session, agentId);
  if (agent) {
    agent.active = false;
    agent.unconfirmed = false;
    if (agent.isCodex) agent.endedAt ??= hookAt;
  }
  stoppedAgentIds.add(agentId);
  deactivateBackgroundedCodex(session, agentId);
  deactivatePendingCodex(session, agentId);
  session.tools = session.tools.filter((tool) => tool.agent_id !== agentId);
  session.permissionWaits = session.permissionWaits.filter((wait) => wait.agent_id !== agentId);
}

// 実行 ID で直接特定できない結果行は、条件に合う行が一つの場合だけ割り当てる。実行 ID があれば定義名が同じで開始(秒で切り捨て)が
// 行の開始より前でない行、無ければ出力ファイルを読んだ応答でバックグラウンドタスク ID の無い行に限る。引用や別の実行の結果行を割り当てないため。
// 待機の終わった行はラッパーの出力に結果行が届かないので、実行 ID の一致だけで特定する。
function uniqueBackgroundedCodex(session, parentAgentId, runId = null, runStartedAt = null, backgroundOutputTaskId = null) {
  if (!runId && !backgroundOutputTaskId) return null;
  const definition = runId?.replace(/-\d{8}-\d{6}-\d+$/, '');
  const candidates = session.agents.filter((agent) => (
    agent.isCodex && agent.backgrounded && !agent.waitEnded && (agent.active || agent.unconfirmed) &&
    sameAgent(agent.parent_agent_id, parentAgentId) && (!agent.runId || agent.runId === runId) &&
    (runId || !agent.backgroundTaskId) &&
    (!runId || (agent.agent_type === definition &&
      (!runStartedAt || Date.parse(runStartedAt) >= Date.parse(agent.startedAt) - 1000)))
  ));
  return candidates.length === 1 ? candidates[0] : null;
}

function applyCodexAudit(agent, event) {
  if (!event.codexAudit) return;
  agent.model = event.codexAudit.model || agent.model;
  agent.effort = event.codexAudit.effort || agent.effort;
  agent.codex_home = event.codexAudit.codex_home || agent.codex_home || '';
}

// exit=3 は GPT 側が未導入か無効で、Codex を起動していない。
function isCodexNotStartedResult(result) {
  return result?.status === 'failed' && result.exitCode === 3;
}

// bridge が Codex を起動しなくても、クロスレビューの CLI は同じプロンプトで直接起動へ切り替えてレビューを続ける。
// そのため、クロスレビューの行では、呼び出しが失敗で終わったときだけ exit=3 を結果として扱う。
function ignoresReviewResult(session, agent, result, endedInFailure) {
  return session.codexReviewAgentIds.has(agent.agent_id) && isCodexNotStartedResult(result) && !endedInFailure;
}

// 監査行は Codex の起動前に出るので、終わったと判定するのは結果行を受けたときだけにする。
function completeCodexAgent(agent, event) {
  applyCodexAudit(agent, event);
  const result = event.codexResult;
  if (result?.status === 'rate-limited') agent.unavailable = '利用上限';
  if (result?.status === 'unavailable' || isCodexNotStartedResult(result)) agent.unavailable = '使用不能';
  agent.active = false;
  agent.unconfirmed = false;
  agent.resultReceived = true;
  agent.endedAt ??= event.hookAt;
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

// 結果無しで失敗した起動は続きが無いので、バックグラウンドへ移った行(終了未確認を含む)だけを候補にする。
// 実行 ID が分かっていて別の値の行は、別の実行なので候補にしない。
function latestWaitableCodex(session, parentAgentId, definition, runId) {
  return session.agents
    .filter((agent) => (
      agent.isCodex && agent.agent_type === definition && agent.backgrounded === true && !agent.resultReceived &&
      sameAgent(agent.parent_agent_id, parentAgentId) && (!agent.runId || agent.runId === runId)
    ))
    .sort((left, right) => Date.parse(right.startedAt) - Date.parse(left.startedAt))[0] || null;
}

function deniedBeforeCodexRun(agent, runStartedAt) {
  return agent.deniedCandidate && agent.deniedAt < runStartedAt - 1000;
}

function codexWaitRunStartedAt(runId) {
  const match = runId.match(/-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-\d+$/);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6])).getTime() : NaN;
}

function pendingCodexLaunches(session, definition, runStartedAt) {
  const agentIds = new Set(Object.entries(session.pendingCodex)
    .filter(([toolUseId]) => !session.pendingCodexWait[toolUseId])
    .map(([, agentId]) => agentId));
  return session.agents.filter((agent) => agentIds.has(agent.agent_id) && agent.isCodex &&
    !agent.resultReceived && !agent.runId && agent.agent_type === definition && !deniedBeforeCodexRun(agent, runStartedAt));
}

function isFinishedAskDecision(decision) {
  return ['resolved', 'withdrawn'].includes(decision?.state);
}

/** @param {AskDecisionState} askDecisionState */
function initialAskDecisionsFor(entries, askDecisionState, beforeSequence) {
  // 判断事項ごとに、メモリーにある終わりのイベントの最も新しい時刻。出し直した呼び出しの終わりも数える。
  // 開始がメモリーに無い呼び出しの終わりは、作り直しで再現できないので数えない。
  const startedAskToolUseIds = new Set(entries.flatMap(({ event }) => (
    event.hook_event_name === 'PreToolUse' && event.tool_name === 'AskUserQuestion' && !event.agent_id && event.tool_use_id
      ? [event.tool_use_id]
      : []
  )));
  const latestAskFinishAt = new Map();
  for (const { event } of entries) {
    if (!['PostToolUse', 'PostToolUseFailure'].includes(event.hook_event_name)) continue;
    if (event.tool_name !== 'AskUserQuestion' || event.agent_id || !startedAskToolUseIds.has(event.tool_use_id)) continue;
    const decisionId = askDecisionState.bindings?.[event.tool_use_id] || event.tool_use_id;
    latestAskFinishAt.set(decisionId, Math.max(latestAskFinishAt.get(decisionId) ?? -Infinity, event.hookAt));
  }
  const storedAskDecisions = new Map((askDecisionState.decisions || []).map((decision) => [decision.id, decision]));
  const finishedOutsideEventsIds = new Set(askDecisionState.finishedOutsideEventsIds || []);
  // 再起動の前か MCP で終わった判断事項は、その終わりのイベントがメモリーに無いので、作り直すと巻き戻る。保存済みの状態を保つ。
  // 保存済みの終わりより古い終わりのイベントは、遅れて届いた別の呼び出しの終わりなので、保存済みの状態を説明しない。
  const directlyRecreatedAskDecisionIds = new Set(entries.filter(({ sequence }) => sequence < beforeSequence).flatMap(({ event }) => {
    if (event.hook_event_name !== 'PreToolUse' || !isQuestionTool(event.provider, event.tool_name) || event.agent_id || !event.tool_use_id) return [];
    const decisionId = askDecisionState.bindings?.[event.tool_use_id] || event.tool_use_id;
    if (decisionId !== event.tool_use_id) return [];
    const stored = storedAskDecisions.get(decisionId);
    // 推定の取り下げの訂正は保存側で済ませるため、ここでは保存済みの取り下げを保つ。
    const keepStored = isFinishedAskDecision(stored) && finishedOutsideEventsIds.has(decisionId) &&
      (Boolean(stored.state === 'withdrawn' && stored.finishedByToolUseId) ||
        !(latestAskFinishAt.get(decisionId) >= Date.parse(stored.resolvedAt || stored.updatedAt)));
    return keepStored ? [] : [decisionId];
  }));
  return {
    decisions: (askDecisionState.decisions || []).filter((decision) => !directlyRecreatedAskDecisionIds.has(decision.id)),
    bindings: askDecisionState.bindings || {},
    awayHandledIds: askDecisionState.awayHandledIds || [],
  };
}

// 許可待ち、ターンの状態、稼働中のエージェントの有無から表示の状態を決める。スナップショットと表示側で同じ規則を使う。
function sessionStatus({ permissionWaits, agentActive, turnKnown, interrupted, stopped }) {
  return permissionWaits.some((wait) => wait.phase === 'prompted')
    ? '許可待ち'
    : permissionWaits.length
      ? '許可確認中'
      : !turnKnown
        ? '不明'
        : interrupted
          ? '中断'
          : stopped && agentActive
            ? '待機中(サブエージェント稼働中)'
            : stopped
              ? '待機中'
              : '作業中';
}

/**
 * @param {DerivedSession} session
 */
function sessionSnapshot(session) {
  const permissionWaits = session.permissionWaits.map(({ candidate_tool_use_ids, ...wait }) => wait);
  const visibleAgents = session.agents.filter((agent) => !agent.deniedCandidate);
  const agents = visibleAgents
    .filter((agent) => !(
      agent.isCodex && agent.parent_agent_id && session.agents.some((parent) => parent.agent_id === agent.parent_agent_id)
    ))
    .map(({ endedAt, ...agent }) => {
      const gptAgent = agent.isCodex ? null : latestCodexForParent(visibleAgents, agent.agent_id);
      const childUnconfirmed = !agent.isCodex && !agent.active && visibleAgents.some((child) => (
        child.isCodex && child.unconfirmed && child.parent_agent_id === agent.agent_id
      ));
      return {
        ...agent,
        ...(childUnconfirmed ? { unconfirmed: true } : {}),
        modelName: session.provider === 'codex' ? agent.model : agent.isCodex ? '' : claudeModelName(agent.model),
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
  const lifecycle = {
    turnKnown: session.turnKnown,
    interrupted: session.interrupted,
    stopped: session.stopped,
    activeAgentIds: visibleAgents.filter((agent) => agent.active).map((agent) => agent.agent_id),
  };
  const status = sessionStatus({ ...lifecycle, permissionWaits, agentActive: lifecycle.activeAgentIds.length > 0 });

  const snapshot = {
    session_id: session.session_id,
    provider: session.provider,
    ...(session.codex ? { codex: { ...session.codex } } : {}),
    product: session.product,
    title: session.title,
    lastActivityAt: session.lastActivityAt,
    status,
    tools,
    agents,
    backgrounds: session.backgrounds.map((item) => ({ ...item })),
    permissionWaits,
    decisions: session.decisions.map(cloneDecision),
    decisionBindings: { ...session.decisionBindings },
  };
  // 表示側が終了にした行を除いて状態を決め直す入力。親の行へまとめた Codex も稼働の判定に含めるため、まとめる前の行で持つ。
  // 画面へ送らないよう列挙しない。
  Object.defineProperty(snapshot, 'lifecycle', { value: lifecycle });
  // 親の行にまとめた Codex も再分類に使うため、起動情報は画面へ送らずに持つ。
  Object.defineProperty(snapshot, 'codexLaunches', {
    value: visibleAgents.filter((agent) => agent.isCodex)
      .map(({ agent_id, runId, startedAt, endedAt, active, unconfirmed, resultReceived }) =>
        ({ agent_id, runId, startedAt, endedAt, active, unconfirmed, resultReceived })),
  });
  // 完了通知の照合だけに使う。親の行にまとめた Codex も含むので表示の形に出さず、画面へ送らないよう列挙しない。
  Object.defineProperty(snapshot, 'backgroundCodex', {
    value: session.agents
      .filter((agent) => agent.isCodex && agent.backgrounded && !agent.waitEnded && (agent.active || agent.unconfirmed) && !agent.resultReceived)
      .map(({ agent_id, backgroundTaskId, runId, startedAt }) => ({ agent_id, backgroundTaskId, runId, startedAt })),
  });
  return snapshot;
}

/** @param {Map<string, DerivedSession>} sessions
 * @returns {DerivedSession}
 */
function sessionForEvent(sessions, event, initialAskDecisionState) {
  let session = sessions.get(event.session_id);
  if (event.hook_event_name === 'SessionStart') {
    if (!session || session.ended) {
      session = newSession(event, initialAskDecisionState);
      sessions.set(event.session_id, session);
    }
  } else if (!session) {
    session = newSession(event, initialAskDecisionState);
    sessions.set(event.session_id, session);
  }
  return session;
}

/**
 * @param {SessionDecisions} session
 */
function applyAskQuestionStart(session, event) {
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
  if (isQuestionTool(event.provider, event.tool_name) && !agentId && toolUseId && event.questions?.length) {
    // 同じ呼び出しの開始は回答の待ちとイベントの入口の両方から届く。2 回目で待ちに戻すと、上書きで記録した解決が負けるため。
    if (session.startedAskToolUseIds.has(toolUseId)) return;
    session.startedAskToolUseIds.add(toolUseId);
    // 保存済みの結び付きがある呼び出しは、終わった判断事項でも使い回す。再起動の前の ID と回答を保つため。
    const boundDecision = session.decisions.find((decision) => decision.id === session.decisionBindings[toolUseId]);
    const existing = boundDecision || session.decisions.find((decision) => (
      ['waiting', 'provisional'].includes(decision.state) && sameQuestionSet(decision.questions, event.questions)
    ));
    // 最初の呼び出しか判断事項を終えた呼び出しの開始と、終わった時点より古い開始の知らせは、
    // 遅れて届いたか重複なので、状態と解決の内容を変えない。
    const staleStart = existing === boundDecision && isFinishedAskDecision(existing) && (
      existing.id === toolUseId || existing.finishedByToolUseId === toolUseId ||
      event.hookAt <= Date.parse(existing.resolvedAt || existing.updatedAt)
    );
    if (staleStart) {
      session.decisionBindings[toolUseId] = existing.id;
    } else if (existing) {
      existing.state = 'waiting';
      existing.updatedAt = isoTime(event.hookAt);
      existing.resolvedAt = null;
      existing.resolution = null;
      delete existing.inferredWithdrawalHookAt;
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
    if (event.provider === 'codex') session.codexQuestionTools[session.decisionBindings[toolUseId]] = event.tool_name;
  }
}

/**
 * @param {Pick<SessionTools, 'agentToolBindings'|'tools'> & Pick<SessionAgents, 'agents'> & SessionPermissions & SessionCodex} session
 */
function applyAgentToolCompletion(session, event) {
  const eventName = event.hook_event_name;
  const toolUseId = event.tool_use_id || null;
  if (eventName === 'PostToolUseFailure' && event.tool_name === 'Agent' && event.isInterrupt) {
    deactivateForegroundAgent(session, agentFor(session, session.agentToolBindings[toolUseId]));
  }
  if (eventName === 'PostToolUse' && event.tool_name === 'Agent') {
    const boundAgent = agentFor(session, session.agentToolBindings[toolUseId]);
    const responseAgent = agentFor(session, event.agentId);
    const targetAgent = responseAgent && !responseAgent.isCodex
      ? responseAgent
      : boundAgent && !boundAgent.isCodex ? boundAgent : null;
    if (!targetAgent) {
      // バックグラウンドの起動の応答は SubagentStart より先に届くことがあるので、後から作る行をバックグラウンドにするため覚えておく。
      // 前面の応答は SubagentStop の後に届くので、停止済みの agentId は覚えない。
      if (event.agentId && !session.stoppedAgentIds.has(event.agentId)) session.launchedAgentIds.add(event.agentId);
      return;
    }
    if (targetAgent === responseAgent) {
      // 同じ行を指す別の呼び出しの結び付けは到着順の誤りなので、agentId の無い応答で使わせない。
      for (const [otherToolUseId, boundAgentId] of Object.entries(session.agentToolBindings)) {
        if (otherToolUseId !== toolUseId && boundAgentId === targetAgent.agent_id) {
          session.agentToolBindings[otherToolUseId] = AMBIGUOUS_AGENT_CALL;
        }
      }
    }
    if (toolUseId) session.agentToolBindings[toolUseId] = targetAgent.agent_id;
    const agentTool = toolUseId && session.tools.find((tool) => tool.tool_use_id === toolUseId && tool.tool_name === 'Agent');
    // SubagentStart の時点の結び付けは到着順で誤ることがあるので、呼び出し自身の説明で上書きする。
    if (agentTool?.description) targetAgent.description = agentTool.description;
    if (targetAgent.active) targetAgent.backgrounded = true;
    if (event.resolvedModel) {
      targetAgent.model = event.resolvedModel;
      targetAgent.source = 'Agent tool response';
    }
  }
}

/**
 * @param {SessionCodex & Pick<SessionAgents, 'agents'>} session
 */
function applyCodexLaunchCompletion(session, event) {
  const eventName = event.hook_event_name;
  const toolUseId = event.tool_use_id || null;
  if (isPullRequestShellTool(event.tool_name) && toolUseId) {
    const placeholder = agentFor(session, session.pendingCodex[toolUseId]);
    if (placeholder) {
      delete placeholder.deniedCandidate;
      delete placeholder.deniedAt;
    }
    if (placeholder) session.codexLaunchToolIds.add(toolUseId);
    if (placeholder && event.codexRunId) placeholder.runId = event.codexRunId;
    if (placeholder && event.codexResult &&
      !ignoresReviewResult(session, placeholder, event.codexResult, eventName === 'PostToolUseFailure')) {
      completeCodexAgent(placeholder, event);
    } else if (placeholder && session.pendingCodexWait[toolUseId]) {
      // waiting や状態が読めないときは Codex がバックグラウンドで動き続けている見込みなので、稼働中に残す。
      applyCodexAudit(placeholder, event);
      if (['vanished', 'not-found'].includes(event.codexWaitStatus)) {
        placeholder.active = false;
        placeholder.endedAt ??= event.hookAt;
      }
      if (['orphaned', 'unverified'].includes(event.codexWaitStatus)) {
        placeholder.active = false;
        placeholder.unconfirmed = true;
        placeholder.waitEnded = true;
      }
    } else if (placeholder && eventName === 'PostToolUseFailure') {
      applyCodexAudit(placeholder, event);
      placeholder.active = false;
      if (event.isInterrupt && !placeholder.resultReceived) placeholder.unconfirmed = true;
      else placeholder.endedAt ??= event.hookAt;
    } else if (placeholder && session.codexReviewAgentIds.has(placeholder.agent_id) && !event.backgroundTaskId) {
      // クロスレビューの CLI はレビュアーの終了まで戻らず、差分が無いときと直接起動では結果行を出さない。
      applyCodexAudit(placeholder, event);
      placeholder.active = false;
      placeholder.unconfirmed = false;
      placeholder.endedAt ??= event.hookAt;
    } else if (placeholder) {
      applyCodexAudit(placeholder, event);
      // 合成の Interrupt は記録ファイルの時刻で並ぶので、終了未確認にした後にバックグラウンドへ移った知らせが並ぶことがある。
      // 止まったサブエージェントのバックグラウンドの Codex は終了未確認にする規則があるので、その子は戻さない。
      if (placeholder.unconfirmed && !session.stoppedAgentIds.has(placeholder.parent_agent_id)) {
        placeholder.active = true;
        placeholder.unconfirmed = false;
        delete placeholder.endedAt;
      }
      placeholder.backgrounded = true;
      if (event.backgroundTaskId) placeholder.backgroundTaskId = event.backgroundTaskId;
    }
    delete session.pendingCodex[toolUseId];
    delete session.pendingCodexWait[toolUseId];
  }
}

/**
 * @param {SessionCodex & Pick<SessionAgents, 'agents'>} session
 */
function applyCodexResult(session, event) {
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
  // Codex を起動した呼び出しの出力はその起動のものなので、別の行へ結び付けない。
  // 同じ PostToolUse が重複して届くと pendingCodex は消えているので、起動の記録で判定する。
  const isCodexLaunch = session.codexLaunchToolIds.has(toolUseId);

  // バックグラウンドタスクの出力を読んだ呼び出しは、バックグラウンドタスク ID で起動した行と結び付ける。実行 ID が無い複数のバックグラウンドの Codex を区別できる。
  const outputCodex = event.backgroundOutputTaskId && event.tool_name !== 'Agent' && !isCodexLaunch
    ? session.agents.find((agent) => agent.isCodex && agent.backgroundTaskId === event.backgroundOutputTaskId)
    : null;
  if (outputCodex && !outputCodex.runId && event.codexRunId) outputCodex.runId = event.codexRunId;
  // 起動の PostToolUse が欠けた行は、後の出力の run 行で引き取る。実行 ID の付いていないバックグラウンドの行の run 行を
  // 吸い込まないよう、バックグラウンドの行も候補に数え、一意のときだけにする。Agent の報告は別の実行を引用しうるので使わない。
  if (!outputCodex && !isCodexLaunch && event.tool_name !== 'Agent' && event.codexRunId && event.codexRunStartedAt &&
    !session.agents.some((agent) => agent.runId === event.codexRunId)) {
    const definition = event.codexRunId.replace(/-\d{8}-\d{6}-\d+$/, '');
    const runStartedAt = Date.parse(event.codexRunStartedAt);
    const pending = pendingCodexLaunches(session, definition, runStartedAt);
    const candidates = session.agents.filter((agent) => agent.isCodex && !agent.resultReceived && !agent.runId &&
      agent.agent_type === definition && (pending.includes(agent) || agent.backgrounded) &&
      runStartedAt >= Date.parse(agent.startedAt) - 1000 && !deniedBeforeCodexRun(agent, runStartedAt));
    if (candidates.length === 1 && pending.includes(candidates[0])) {
      const agent = candidates[0];
      agent.runId = event.codexRunId;
      delete agent.deniedCandidate;
      delete agent.deniedAt;
      agent.backgrounded = true;
      if (event.backgroundOutputTaskId && !agent.backgroundTaskId) agent.backgroundTaskId = event.backgroundOutputTaskId;
    }
  }

  // Agent の結果は担当の最終報告で、バックグラウンドの Codex の結果行を写していることがあるので使わない。
  if (event.codexResult && !isCodexLaunch && event.tool_name !== 'Agent') {
    const codexForRun = event.codexRunId ? session.agents.find((agent) => agent.isCodex && agent.runId === event.codexRunId) : null;
    const matched = codexForRun || outputCodex;
    const targetAgent = matched
      ? (matched.resultReceived ? null : matched)
      : uniqueBackgroundedCodex(session, agentId, event.codexRunId, event.codexRunStartedAt, event.backgroundOutputTaskId);
    // 途中の出力を読んだだけでは、直接起動へ切り替えたレビューが続いているかを判断できない。
    if (targetAgent && ignoresReviewResult(session, targetAgent, event.codexResult, false)) return;
    if (targetAgent && !targetAgent.runId && event.codexRunId) targetAgent.runId = event.codexRunId;
    if (targetAgent) completeCodexAgent(targetAgent, event);
  }
}

function applyBackgroundTaskEnds(session, event) {
  if (session.provider === 'codex' || !['UserPromptSubmit', 'BackgroundTaskEnd'].includes(event.hook_event_name) || !Array.isArray(event.backgroundTaskEnds)) return;
  for (const end of event.backgroundTaskEnds) {
    if (!['completed', 'failed', 'killed', 'stopped'].includes(end.status)) continue;
    session.backgrounds = session.backgrounds.filter((item) => item.taskId !== end.taskId);
    const agent = session.agents.find((item) => item.isCodex && item.backgrounded &&
      (item.active || item.unconfirmed) && !item.resultReceived &&
      (item.backgroundTaskId ? item.backgroundTaskId === end.taskId : Boolean(end.codexRunId && item.runId === end.codexRunId)));
    if (!agent) continue;
    if (!agent.runId && end.codexRunId) agent.runId = end.codexRunId;
    if (end.codexResult && !ignoresReviewResult(session, agent, end.codexResult, end.status === 'failed')) {
      completeCodexAgent(agent, { ...end, hookAt: event.hookAt });
      continue;
    }
    // --wait が待機の上限で返っただけなら、Codex はバックグラウンドで動き続けている。
    if (end.codexWaitStatus === 'waiting') continue;
    applyCodexAudit(agent, end);
    agent.active = false;
    // 終わったのが Codex 本体だと確かめられないときは、終了未確認にする。待機状態の行があればそれに従う。
    // 出力ファイルが消えた通知は、--wait が待機の上限で返っただけかを確かめられない。
    // killed と stopped はラッパーの停止であり、子の Codex の終了を保証しない。
    const unconfirmed = end.outputMissing || (end.codexWaitStatus
      ? ['orphaned', 'unverified'].includes(end.codexWaitStatus)
      : ['killed', 'stopped'].includes(end.status) || !agent.backgroundTaskId);
    agent.unconfirmed = unconfirmed;
    if (unconfirmed) agent.waitEnded = true;
    else agent.endedAt ??= event.hookAt;
  }
}

/**
 * @param {SessionDecisions} session
 */
function applyAskQuestionCompletion(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
  if (isQuestionTool(event.provider, event.tool_name) && !agentId && toolUseId) {
    const decisionId = session.decisionBindings[toolUseId];
    const decision = session.decisions.find((item) => item.id === decisionId);
    if (decision && ['waiting', 'provisional'].includes(decision.state)) {
      decision.state = eventName === 'PostToolUse' ? 'resolved' : 'withdrawn';
      decision.updatedAt = isoTime(event.hookAt);
      decision.resolvedAt = decision.updatedAt;
      decision.resolution = eventName !== 'PostToolUse' ? null
        : event.provider === 'codex' ? { chosen: [], note: CODEX_UNKNOWN_ANSWER_NOTE }
          : event.decisionResolution || { chosen: [], note: '' };
      // 最後に判断事項を終えた呼び出し。再起動の後に同じ呼び出しの開始が新しい時刻で届いても重複と分かるよう、
      // waiting に戻っても消さずに残す(開始から終わりまで進んだ呼び出しの開始が、正当に新しく届くことは無い)。
      decision.finishedByToolUseId = toolUseId;
      delete decision.inferredWithdrawalHookAt;
    }
  }
}

/**
 * @param {SessionAgents & Pick<SessionIdentity, 'provider'|'product'|'title'|'lastActivityAt'>} session
 */
function applyCommonEventStart(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  const isCodexAgentId = agentId?.startsWith('codex:') === true;
  if (event.product) session.product = event.product;
  if (event.sessionName) session.title = event.sessionName;
  session.lastActivityAt = isoTime(event.hookAt);

  if (eventName === 'SubagentStop' && agentId) {
    session.stoppedAgentIds.add(agentId);
  } else if (eventName === 'SubagentStart' && agentId && !isCodexAgentId) {
    session.stoppedAgentIds.delete(agentId);
  } else if (
    agentId && !isCodexAgentId && !session.stoppedAgentIds.has(agentId) && !agentFor(session, agentId)
  ) {
    const agent = agentModelFromDefinition(event.agent_type, event.agentDefinition || {});
    agent.agent_id = agentId;
    agent.startedAt = isoTime(event.hookAt);
    if (session.provider === 'codex' || session.launchedAgentIds.has(agentId)) agent.backgrounded = true;
    session.agents.push(agent);
  }
}

/**
 * @param {SessionTools & Pick<SessionAgents, 'agents'> & SessionCodex & SessionDecisions & Pick<SessionIdentity, 'stopped'|'turnKnown'>} session
 */
function applyToolStart(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
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
      if (session.provider !== 'codex' && event.tool_name === 'Agent' && !agentId) {
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

    if (session.provider !== 'codex') {
      applyCodexStart(session, event);
    }
    applyAskQuestionStart(session, event);

    if (!agentId) {
      session.stopped = false;
      session.turnKnown = true;
    }
  }
}

/**
 * @param {SessionAgents & Pick<SessionIdentity, 'provider'> & Pick<SessionTools, 'tools'|'agentToolBindings'>} session
 */
function applySubagentStart(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  const isCodexAgentId = agentId?.startsWith('codex:') === true;
  if (eventName === 'SubagentStart' && agentId && !isCodexAgentId) {
    let agent = agentFor(session, agentId);
    const definition = event.agentDefinition || {};
    if (agent) {
      agent.active = true;
      agent.unconfirmed = false;
      agent.startedAt = isoTime(event.hookAt);
      agent.agent_type = event.agent_type || agent.agent_type;
      if (event.route) agent.route = event.route;
    } else {
      agent = agentModelFromDefinition(event.agent_type, definition);
      agent.agent_id = agentId;
      agent.startedAt = isoTime(event.hookAt);
      if (event.route) agent.route = event.route;
      session.agents.push(agent);
    }
    if (session.provider === 'codex' || session.launchedAgentIds.has(agentId)) agent.backgrounded = true;
    const unboundAgentCalls = unboundAgentCallsOf(session);
    if (unboundAgentCalls.length === 1) {
      const tool = unboundAgentCalls[0];
      session.agentToolBindings[tool.tool_use_id] = agentId;
      agent.description = tool.description || agent.description;
    }
  }
}

/**
 * @param {SessionAgents & Pick<SessionTools, 'tools'> & SessionPermissions} session
 */
function applySubagentStop(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  if (eventName === 'SubagentStop' && agentId) {
    stopAgent(session, agentId, session.stoppedAgentIds, event.hookAt);
  }
  if (eventName === 'PostToolUse' && event.tool_name === 'TaskStop' && event.stoppedTaskId) {
    const agent = agentFor(session, event.stoppedTaskId);
    if (agent && !agent.isCodex) stopAgent(session, agent.agent_id, session.stoppedAgentIds, event.hookAt);
  }
}

function retainPermissionCandidates(wait, tools) {
  const remaining = wait.candidate_tool_use_ids.filter((id) => tools.some((tool) => tool.tool_use_id === id));
  if (remaining.length !== wait.candidate_tool_use_ids.length) {
    wait.candidate_tool_use_ids = remaining;
    wait.phase = 'checking';
    wait.notification_type = '';
    wait.message = '';
  }
  return remaining.length > 0;
}

/**
 * @param {SessionTools & Pick<SessionAgents, 'agents'> & SessionCodex & SessionDecisions & SessionPermissions & Pick<SessionIdentity, 'stopped'|'turnKnown'>} session
 */
function applyToolCompletion(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
  if (session.provider === 'claude' && eventName === 'PostToolUse') {
    if (!agentId && isPullRequestShellTool(event.tool_name) && event.backgroundTaskId
      && !session.completedToolIds.has(toolUseId)
      && !session.pendingCodex[toolUseId] && !session.codexLaunchToolIds.has(toolUseId)
      && !session.backgrounds.some((item) => item.taskId === event.backgroundTaskId)) {
      const tool = session.tools.find((item) => item.tool_use_id === toolUseId);
      session.backgrounds.push({
        taskId: event.backgroundTaskId,
        agent_id: `background:${event.backgroundTaskId}`,
        startedAt: tool?.startedAt || isoTime(event.hookAt),
        description: event.description || '',
        tool_name: event.tool_name,
        summary: event.summary || tool?.summary || event.tool_name,
      });
    }
    if (event.tool_name === 'TaskStop' && event.stoppedTaskId) {
      session.backgrounds = session.backgrounds.filter((item) => item.taskId !== event.stoppedTaskId);
    }
  }
  if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
    if (session.provider !== 'codex') applyAgentToolCompletion(session, event);
    if (toolUseId) {
      session.tools = session.tools.filter((tool) => tool.tool_use_id !== toolUseId);
      session.completedToolIds.add(toolUseId);
    }

    if (session.provider !== 'codex') {
      applyCodexLaunchCompletion(session, event);
      applyCodexResult(session, event);
    }

    session.permissionBoundaries.add(agentId);
    session.permissionWaits = session.permissionWaits.filter((wait) => {
      if (!sameAgent(wait.agent_id, agentId)) return true;
      if (wait.target_tool_use_id) return wait.target_tool_use_id !== toolUseId;
      if (wait.candidate_tool_use_ids) return retainPermissionCandidates(wait, session.tools);
      if (wait.tool_name && wait.tool_name !== event.tool_name) return true;
      return session.tools.some((tool) => sameAgent(tool.agent_id, agentId) && tool.tool_name !== 'Agent'
        && (!wait.tool_name || tool.tool_name === wait.tool_name));
    });
    // Codex の request_user_input_async はすぐ戻るので結果では閉じず、次の入力で閉じる。待つ形の request_user_input は Claude と同じく結果で閉じる。
    if (session.provider !== 'codex' || event.tool_name === 'request_user_input') applyAskQuestionCompletion(session, event);

    if (!agentId) {
      session.stopped = false;
      session.turnKnown = true;
    }
  }
}

/**
 * @param {Pick<SessionTools, 'tools'> & SessionPermissions & SessionCodex & Pick<SessionAgents, 'agents'>} session
 */
function applyToolBatch(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  // 区切りより前のツールの待ちは解除するが、Codex は完了通知の欠落も考慮して起動の記録を残す。
  if (eventName === 'PostToolBatch') {
    const startedBeforeBatch = (item) => sameAgent(item.agent_id, agentId) && Date.parse(item.startedAt) < event.hookAt;
    // 非同期の完了通知が欠けても後の run 行で回復できるよう、拒否の候補は記録を残して隠す。
    for (const [toolUseId, codexAgentId] of Object.entries(session.pendingCodex)) {
      if (session.pendingCodexWait[toolUseId]) continue;
      const agent = agentFor(session, codexAgentId);
      if (!agent || agent.backgrounded || agent.backgroundTaskId || !sameAgent(agent.parent_agent_id, agentId)
        || Date.parse(agent.startedAt) >= event.hookAt) continue;
      agent.deniedCandidate = true;
      agent.deniedAt ??= event.hookAt;
    }
    session.tools = session.tools.filter((tool) => !startedBeforeBatch(tool));
    // メインの待ちの一括解除は、バックグラウンドツールの区切りで並列の待ちを巻き込むため避ける。
    session.permissionWaits = session.permissionWaits.filter((wait) => {
      if (!sameAgent(wait.agent_id, agentId)) return true;
      if (agentId && startedBeforeBatch(wait)) return false;
      return !wait.candidate_tool_use_ids || retainPermissionCandidates(wait, session.tools);
    });
  }
}

/**
 * @param {Pick<SessionTools, 'tools'> & SessionPermissions & Pick<SessionIdentity, 'provider'>} session
 */
function applyPermissionPrompt(session, event) {
  const eventName = event.hook_event_name;
  const agentId = event.agent_id || null;
  const requested = eventName === 'PermissionRequest';
  const prompted = session.provider === 'claude' && eventName === 'Notification' && event.notification_type === 'permission_prompt';
  if (!requested && !prompted) return;

  // Agent の呼び出しはサブエージェントの終わりまで続くので、許可を待つツールの候補にしない。
  const tools = session.tools.filter((tool) => sameAgent(tool.agent_id, agentId) && tool.tool_name !== 'Agent');
  if (prompted) {
    session.permissionWaits = session.permissionWaits.filter((wait) => !sameAgent(wait.agent_id, agentId)
      || (!wait.candidate_tool_use_ids
        && (!wait.target_tool_use_id || tools.some((tool) => tool.tool_use_id === wait.target_tool_use_id))));
  }
  let candidates = requested ? tools.filter((tool) => tool.tool_name === event.tool_name) : tools;
  if (requested && candidates.length > 1) {
    const matchingSummary = candidates.filter((tool) => tool.summary === event.summary);
    if (matchingSummary.length) candidates = matchingSummary;
  }
  const waits = session.permissionWaits.filter((wait) => sameAgent(wait.agent_id, agentId));
  if (prompted && waits.length === 1 && waits[0].phase === 'checking') {
    waits[0].phase = 'prompted';
    waits[0].notification_type = event.notification_type;
    waits[0].message = event.message || '';
    waits[0].startedAt = isoTime(event.hookAt);
    if (!waits[0].target_tool_use_id && candidates.length) {
      waits[0].candidate_tool_use_ids = candidates.map((tool) => tool.tool_use_id);
    }
    return;
  }
  if (prompted && !waits.length && !candidates.length && session.permissionBoundaries.has(agentId)) return;
  const target = candidates.length === 1 && (!prompted || waits.length < 2) ? candidates[0] : null;
  const wait = {
    agent_id: agentId,
    target_tool_use_id: target?.tool_use_id || null,
    tool_name: requested ? event.tool_name : target?.tool_name || '',
    summary: requested ? event.summary : target?.summary || '',
    notification_type: event.notification_type || '',
    message: event.message || '',
    startedAt: isoTime(event.hookAt),
    phase: requested ? 'checking' : 'prompted',
    ...(prompted && !target && candidates.length ? { candidate_tool_use_ids: candidates.map((tool) => tool.tool_use_id) } : {}),
  };
  session.permissionWaits = session.permissionWaits.filter((item) => !(
    sameAgent(item.agent_id, agentId) && ((prompted && item.phase === 'prompted') || (target
      ? item.target_tool_use_id === target.tool_use_id
      : !item.target_tool_use_id && item.tool_name === wait.tool_name && item.summary === wait.summary))
  ));
  session.permissionWaits.push(wait);
}

/**
 * @param {Pick<SessionTools, 'tools'> & SessionPermissions & SessionDecisions & SessionCodex & Pick<SessionAgents, 'agents'> & Pick<SessionIdentity, 'provider'|'stopped'|'interrupted'|'turnKnown'|'ended'>} session
 */
function applySessionLifecycle(session, event) {
  // Interrupt は Stop と同じ後始末をしたうえで、メインなら中断の印を付ける。印は次の入力か新しい開始まで残す。
  const eventName = event.hook_event_name === 'Interrupt' ? 'Stop' : event.hook_event_name;
  const agentId = event.agent_id || null;
  if (session.provider === 'codex' && eventName === 'UserPromptSubmit' && !agentId) {
    // すぐ戻る質問は次の入力を元の画面での回答とみなす。待つ質問は結果が来ないまま入力が届いたら、Claude の中断と同じく取り下げにする。
    // ツールの種類は保存しないので、再起動の前の質問はすぐ戻る質問として扱う。
    for (const decision of session.decisions) {
      // 離席中にフックで扱った質問は元の画面に出ないため、次の入力で閉じない。
      if (session.awayHandledIds.has(decision.id)) continue;
      if (decision.source !== 'ask' || decision.state !== 'waiting' || event.hookAt <= Date.parse(decision.updatedAt)) continue;
      const tool = session.codexQuestionTools[decision.id] || 'request_user_input_async';
      const answered = tool === 'request_user_input_async';
      decision.state = answered ? 'resolved' : 'withdrawn';
      decision.updatedAt = isoTime(event.hookAt);
      decision.resolvedAt = decision.updatedAt;
      decision.resolution = answered ? { chosen: [], note: CODEX_NEXT_INPUT_NOTE } : null;
    }
  }
  if (eventName === 'UserPromptSubmit' || eventName === 'Stop') {
    session.permissionBoundaries.add(agentId);
    session.permissionWaits = session.permissionWaits.filter((wait) => !sameAgent(wait.agent_id, agentId));
    if (!agentId) session.tools = session.tools.filter((tool) => tool.agent_id);
  }

  // compact は自動の圧縮でターンの途中にも起きるので、直前の状態を保つ。
  const startsIdle = eventName === 'SessionStart' && IDLE_START_SOURCES.has(event.source);
  if (!agentId && (startsIdle || eventName === 'Stop')) deactivatePendingCodex(session, null);
  if (!agentId && eventName === 'Stop') {
    for (const agent of session.agents) deactivateForegroundAgent(session, agent);
  }
  if (startsIdle || eventName === 'UserPromptSubmit' || eventName === 'Stop') session.turnKnown = true;
  if (startsIdle) {
    session.permissionBoundaries.add(null);
    session.permissionWaits = session.permissionWaits.filter((wait) => wait.agent_id);
    session.tools = session.tools.filter((tool) => tool.agent_id);
    session.stopped = true;
  }
  if (eventName === 'UserPromptSubmit') session.stopped = false;
  if (eventName === 'Stop') {
    session.stopped = true;
  }
  if (!agentId && (startsIdle || eventName === 'UserPromptSubmit')) session.interrupted = false;
  if (!agentId && event.hook_event_name === 'Interrupt') session.interrupted = true;
  if (eventName === 'SessionEnd') session.ended = true;
}

/**
 * @param {Pick<SessionAgents, 'stoppedAgentIds'> & Pick<SessionTools, 'tools'> & SessionPermissions} session
 */
function applyCommonEventEnd(session, event) {
  const agentId = event.agent_id || null;
  if (agentId && session.stoppedAgentIds.has(agentId)) {
    session.tools = session.tools.filter((tool) => tool.agent_id !== agentId);
    session.permissionWaits = session.permissionWaits.filter((wait) => wait.agent_id !== agentId);
  }
}

/**
 * @param {Pick<SessionAgents, 'agents'> & Pick<SessionCodex, 'pendingCodex'|'pendingCodexWait'>} session
 */
function applyCodexWaitStart(session, event) {
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
  // 実行 ID は一意なので親を問わずに探し、待ちを引き継いだ親の下へ付け替える。
  const codexForRun = session.agents.find((candidate) => candidate.isCodex && candidate.runId === event.codexWaitRunId);
  if (codexForRun?.resultReceived) {
    delete codexForRun.deniedCandidate;
    delete codexForRun.deniedAt;
    // 取り出し直しの出力の結果行を、バックグラウンドで動いている別の行へ流さないため、終わった行に結び付けておく。
    session.pendingCodex[toolUseId] = codexForRun.agent_id;
  } else {
    let agent = codexForRun || latestWaitableCodex(session, agentId, event.codexWaitDefinition, event.codexWaitRunId);
    if (!agent) {
      const pending = pendingCodexLaunches(session, event.codexWaitDefinition, codexWaitRunStartedAt(event.codexWaitRunId))
        .filter((candidate) => sameAgent(candidate.parent_agent_id, agentId));
      if (pending.length === 1) {
        agent = pending[0];
        agent.backgrounded = true;
      }
    }
    if (agent) {
      delete agent.deniedCandidate;
      delete agent.deniedAt;
      agent.parent_agent_id = agentId;
      agent.active = true;
      agent.unconfirmed = false;
      agent.runId = event.codexWaitRunId;
      delete agent.waitEnded;
      delete agent.endedAt;
      agent.lastTool = { tool_name: event.tool_name, summary: event.summary };
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
        lastTool: { tool_name: event.tool_name, summary: event.summary },
      });
      session.agents.push(waitAgent);
      session.pendingCodex[toolUseId] = agentIdForCall;
    }
    session.pendingCodexWait[toolUseId] = true;
  }
}

/**
 * @param {Pick<SessionAgents, 'agents'> & Pick<SessionCodex, 'pendingCodex'|'codexReviewAgentIds'>} session
 */
function applyCodexLaunchStart(session, event) {
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
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
    lastTool: { tool_name: event.tool_name, summary: event.summary },
  });
  const existingIndex = session.agents.findIndex((item) => item.agent_id === agentIdForCall);
  if (existingIndex >= 0) session.agents.splice(existingIndex, 1, agent);
  else session.agents.push(agent);
  session.pendingCodex[toolUseId] = agentIdForCall;
  if (event.codexReviewLaunch) session.codexReviewAgentIds.add(agentIdForCall);
  else session.codexReviewAgentIds.delete(agentIdForCall);
}

/**
 * @param {Pick<SessionAgents, 'agents'> & Pick<SessionCodex, 'pendingCodex'|'pendingCodexWait'|'codexReviewAgentIds'>} session
 */
function applyCodexStart(session, event) {
  const agentId = event.agent_id || null;
  const toolUseId = event.tool_use_id || null;
  const isCodexAgentId = agentId?.startsWith('codex:') === true;
  if (event.codexWaitDefinition && agentId && !isCodexAgentId && toolUseId) {
    applyCodexWaitStart(session, event);
  } else if (event.codexDefinition && toolUseId) {
    applyCodexLaunchStart(session, event);
  }
}

// 整理後の先頭に残す開始イベント。サブエージェントやツールの開始を残すと、再開で終わった作業が稼働中に戻るため、識別に要る項目だけを写す。
function sessionStartFor(entry) {
  const { event } = entry;
  if (event.hook_event_name === 'SessionStart' && !event.agent_id) return entry;
  const start = {
    session_id: event.session_id, provider: event.provider, hook_event_name: 'SessionStart', hookAt: event.hookAt,
    product: event.product, sessionName: event.sessionName, source: '',
  };
  for (const key of ['delegatedFrom', 'claudeParentSessionId', 'cwd']) {
    if (event[key] !== undefined) start[key] = event[key];
  }
  return { event: start, sequence: entry.sequence };
}

function deriveSessions(entries, askDecisionState = {}, beforeSequence = Infinity, questionEntries = entries) {
  const sessions = new Map();
  const initialAskDecisionState = initialAskDecisionsFor(questionEntries, askDecisionState, beforeSequence);
  const ordered = [...entries].sort((left, right) => {
    const difference = left.event.hookAt - right.event.hookAt;
    return difference || left.sequence - right.sequence;
  });

  for (const { event } of ordered) {
    if (event.delegatedFrom) continue;
    const session = sessionForEvent(sessions, event, initialAskDecisionState);

    if (session.ended) continue;
    if (event.hook_event_name === 'BackgroundTaskEnd') {
      applyBackgroundTaskEnds(session, event);
      continue;
    }
    applyCommonEventStart(session, event);

    applyToolStart(session, event);
    applySubagentStart(session, event);
    if (session.provider === 'codex') {
      if (event.agent_id) {
        const agent = agentFor(session, event.agent_id);
        if (agent && event.model) agent.model = event.model;
      } else {
        if (event.model) session.codex.model = event.model;
        if (event.hook_event_name === 'SessionStart' && event.source === 'resume') session.codex.resumes += 1;
      }
    }
    applySubagentStop(session, event);
    applyToolCompletion(session, event);
    applyBackgroundTaskEnds(session, event);
    applyToolBatch(session, event);
    applyPermissionPrompt(session, event);
    applySessionLifecycle(session, event);

    applyCommonEventEnd(session, event);
  }

  return [...sessions.values()]
    .filter((session) => !session.ended)
    .map(sessionSnapshot);
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
    ...(decision.verify ? { verify: { ...decision.verify, steps: decision.verify.steps.map(step => ({ ...step })),
      ...(decision.verify.launched ? { launched: { ...decision.verify.launched } } : {}) } } : {}),
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

module.exports = {
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
};
