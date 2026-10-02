const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { recommendedOptionFor, sanitizeEvent } = require('./events');
const { AtomicJsonWriter, atomicWriteJson } = require('./json-storage');
const { parsePullRequestUrl, validRepositoryPart } = require('./pull-request-utils');

const DEFAULT_AWAY_STATE = Object.freeze({ enabled: false, since: null });
const DEFAULT_DISPLAY = Object.freeze({ mode: 'product', order: [], pinned: [], collapsed: [], hidden: [] });
const SESSION_FILE_ABSENCE_END_MS = 60_000;
const STORE_WRITE_DELAY_MS = 500;
const STORE_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const DISPLAY_FILTER_KEYS = new Set(['permission', 'blocking', 'provisional', 'held', 'agents']);

function cloneDisplay(display) {
  if (display === null) return null;
  return {
    mode: display.mode,
    order: [...display.order],
    pinned: [...display.pinned],
    collapsed: [...display.collapsed],
    hidden: [...display.hidden],
  };
}

function defaultDisplay() {
  return { mode: DEFAULT_DISPLAY.mode, order: [], pinned: [], collapsed: [], hidden: [] };
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
  const allowed = new Set(['mode', 'order', 'pinned', 'collapsed', 'hidden']);
  if (Object.keys(value).some((key) => !allowed.has(key))) throw new Error('Invalid display preferences');
  for (const key of ['order', 'pinned', 'collapsed', 'hidden']) {
    if (!Array.isArray(value[key]) || value[key].length > 200 || value[key].some((item) => typeof item !== 'string' || item.length > 500)) {
      throw new Error('Invalid display preferences');
    }
    if (new Set(value[key]).size !== value[key].length) throw new Error('Invalid display preferences');
  }
  if (value.hidden.some((key) => !DISPLAY_FILTER_KEYS.has(key))) throw new Error('Invalid display preferences');
  return {
    mode: value.mode,
    order: [...value.order],
    pinned: [...value.pinned],
    collapsed: [...value.collapsed],
    hidden: [...value.hidden],
  };
}

function validStoredPlan(plan) {
  return isRecord(plan) && Array.isArray(plan.tasks) && validTimestamp(plan.tasksUpdatedAt, true) &&
    plan.tasks.every((task) => isRecord(task) && typeof task.title === 'string' && task.title.length <= 200 &&
      ['todo', 'doing', 'done'].includes(task.state) && Array.isArray(task.criteria) &&
      task.criteria.every((item) => isRecord(item) && typeof item.text === 'string' && typeof item.met === 'boolean')) &&
    Array.isArray(plan.decisions) && plan.decisions.every((decision) => isRecord(decision) &&
      typeof decision.id === 'string' && typeof decision.title === 'string' && typeof decision.state === 'string' &&
      Array.isArray(decision.questions) && decision.questions.every((question) => isRecord(question) && Array.isArray(question.options)) &&
      validTimestamp(decision.createdAt) && validTimestamp(decision.updatedAt));
}

function pullRequestRecordKey(owner, repo, number) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}#${number}`;
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
  if (record.lastOpen !== null && (!isRecord(record.lastOpen) ||
    ['title', 'url', 'headRefName', 'baseRefName'].some((key) => typeof record.lastOpen[key] !== 'string') ||
    ['title', 'headRefName', 'baseRefName'].some((key) => record.lastOpen[key].length > 500) ||
    (record.lastOpen.headRefOid !== '' && !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(record.lastOpen.headRefOid)))) return false;
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
    lastOpen: record.lastOpen ? { ...record.lastOpen } : null,
  };
}

function validPullRequestRetarget(record) {
  return isRecord(record) && validRepositoryPart(record.owner) && validRepositoryPart(record.repo) &&
    Number.isSafeInteger(record.number) && record.number > 0 && typeof record.base === 'string' && record.base.length <= 500 &&
    (record.fromNumber === null || record.fromNumber === undefined || (Number.isSafeInteger(record.fromNumber) && record.fromNumber > 0));
}

function validMergedPullRequestHead(record) {
  return isRecord(record) && validRepositoryPart(record.owner) && validRepositoryPart(record.repo) &&
    Number.isSafeInteger(record.number) && record.number > 0 &&
    typeof record.headRefOid === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(record.headRefOid) &&
    (record.method === null || ['merge', 'squash', 'rebase'].includes(record.method)) && validTimestamp(record.mergedAt);
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
      })),
      tasksUpdatedAt: plan.tasksUpdatedAt,
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
      lifecycles.set(decisionId, {
        answer: lifecycle.answer ? { ...lifecycle.answer } : null,
        state: lifecycle.state ?? null,
        updatedAt: lifecycle.updatedAt ?? null,
        ...(validTimestamp(lifecycle.awaitingAnswerUntil) ? { awaitingAnswerUntil: lifecycle.awaitingAnswerUntil } : {}),
      });
    }
    decisionLifecycles.set(sessionId, lifecycles);
  }
  const closedTasks = [];
  for (const record of value.closedTasks) {
    if (!isRecord(record) || !validStoredSessionId(record.session_id) || typeof record.title !== 'string' ||
      !['todo', 'doing'].includes(record.stateAtClose)) throw new Error('Invalid closed task');
    closedTasks.push({ session_id: record.session_id, title: record.title, stateAtClose: record.stateAtClose });
  }
  const hiddenSessions = [];
  for (const record of value.hiddenSessions) {
    if (!isRecord(record) || !validStoredSessionId(record.session_id) || !validTimestamp(record.updatedAt)) {
      throw new Error('Invalid hidden session');
    }
    hiddenSessions.push({ session_id: record.session_id, updatedAt: record.updatedAt });
  }
  const prs = value.prs === undefined ? [] : value.prs;
  const retargetedPrs = value.retargetedPrs === undefined ? [] : value.retargetedPrs;
  const mergedPrHeads = value.mergedPrHeads === undefined ? [] : value.mergedPrHeads;
  if (!Array.isArray(prs) || !prs.every(validPullRequestRecord) ||
    !Array.isArray(retargetedPrs) || !retargetedPrs.every(validPullRequestRetarget) ||
    !Array.isArray(mergedPrHeads) || !mergedPrHeads.every(validMergedPullRequestHead)) {
    throw new Error('Invalid pull request records');
  }
  return {
    display,
    plans,
    decisionLifecycles,
    closedTasks,
    hiddenSessions,
    prs: prs.map(normalizePullRequestRecord),
    retargetedPrs: retargetedPrs.map((record) => ({ ...record })),
    mergedPrHeads: mergedPrHeads.map((record) => ({ ...record })),
  };
}

async function atomicWriteAwayState(homeDir, value, fileSystem = fs, writer = null) {
  if (writer) return writer.write('away.json', value);
  return atomicWriteJson(homeDir, 'away.json', value, fileSystem);
}

class AwayState {
  constructor(homeDir, value = DEFAULT_AWAY_STATE, fileSystem = fs, writer = null) {
    this.homeDir = homeDir;
    this.value = { ...value };
    this.fileSystem = fileSystem;
    this.writer = writer;
    this.pending = Promise.resolve();
  }

  static async load(homeDir, fileSystem = fs, writer = null) {
    try {
      const value = JSON.parse(await fileSystem.readFile(path.join(homeDir, 'away.json'), 'utf8'));
      if (
        value && typeof value === 'object' && !Array.isArray(value) &&
        typeof value.enabled === 'boolean' &&
        ((value.enabled && Number.isFinite(value.since) && value.since >= 0) || (!value.enabled && value.since === null)) &&
        Number.isFinite(new Date(value.since).getTime())
      ) return new AwayState(homeDir, { enabled: value.enabled, since: value.since }, fileSystem, writer);
    } catch {
    }
    return new AwayState(homeDir, DEFAULT_AWAY_STATE, fileSystem, writer);
  }

  snapshot() {
    return { ...this.value };
  }

  // 画面とトレイから同時に切り替えても、保存の順と this.value の順が食い違わないよう直列にする。
  setEnabled(enabled, now) {
    const run = this.pending.then(() => this.applyEnabled(enabled, now ?? Date.now()));
    this.pending = run.catch(() => {});
    return run;
  }

  async applyEnabled(enabled, now) {
    const next = {
      enabled,
      since: enabled ? (this.value.enabled ? this.value.since : now) : null,
    };
    this.value = next;
    await atomicWriteAwayState(this.homeDir, next, this.fileSystem, this.writer).catch(() => {});
    return this.snapshot();
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
function oldestBackgroundedCodex(session, parentAgentId) {
  return session.agents
    .filter((agent) => agent.isCodex && agent.backgrounded && (agent.active || agent.unconfirmed) && sameAgent(agent.parent_agent_id, parentAgentId))
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
}

function latestCodexForParent(agents, parentAgentId) {
  return agents
    .filter((agent) => agent.isCodex && sameAgent(agent.parent_agent_id, parentAgentId))
    .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt))
    .at(-1);
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

      if (event.codexDefinition && toolUseId) {
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
      } else {
        agent = agentModelFromDefinition(event.agent_type, definition);
        agent.agent_id = agentId;
        agent.startedAt = isoTime(event.hookAt);
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
        if (placeholder && event.codexResult) {
          completeCodexAgent(placeholder, event);
          completedCodexAgent = placeholder;
        } else if (placeholder && eventName === 'PostToolUseFailure') {
          applyCodexAudit(placeholder, event);
          placeholder.active = false;
        } else if (placeholder) {
          applyCodexAudit(placeholder, event);
          placeholder.backgrounded = true;
        }
        delete session.pendingCodex[toolUseId];
      }

      // Agent の結果は担当の最終報告で、背景の Codex の結果行を写していることがあるので使わない。
      if (event.codexResult && !completedCodexAgent && event.tool_name !== 'Agent') {
        const targetAgent = oldestBackgroundedCodex(session, agentId);
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
    this.pullRequestRetargets = [];
    this.mergedPullRequestHeads = [];
    this.closedAgents = new Map();
    this.display = null;
    this.storeWriteTimer = null;
    this.storeWritePending = false;
    this.restoreSessionCleanupPending = false;
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
    this.display = store.display;
    this.plans = store.plans;
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
      this.closedTaskMapFor(record.session_id).set(record.title, { stateAtClose: record.stateAtClose });
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
    this.pullRequestRetargets = store.retargetedPrs;
    this.mergedPullRequestHeads = store.mergedPrHeads;
    this.pruneExpiredStoreRecords(now);
  }

  pruneExpiredStoreRecords(now) {
    const sessionIds = new Set([
      ...this.plans.keys(), ...this.decisionLifecycles.keys(), ...this.hiddenSessions,
      ...this.closedTasks.keys(), ...this.pullRequests.keys(),
    ]);
    for (const sessionId of sessionIds) {
      const updatedAt = this.lastStoredUpdateAt(sessionId);
      if (!Number.isFinite(updatedAt) || now - updatedAt > STORE_RETENTION_MS) this.deleteStoredSession(sessionId);
    }
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
    const hiddenAt = this.hiddenSessionUpdatedAt.get(sessionId);
    if (hiddenAt) timestamps.push(Date.parse(hiddenAt));
    for (const record of this.pullRequests.get(sessionId)?.values() || []) timestamps.push(Date.parse(record.addedAt));
    const finite = timestamps.filter(Number.isFinite);
    return finite.length ? Math.max(...finite) : NaN;
  }

  deleteStoredSession(sessionId) {
    this.plans.delete(sessionId);
    this.decisionLifecycles.delete(sessionId);
    this.hiddenSessions.delete(sessionId);
    this.hiddenSessionUpdatedAt.delete(sessionId);
    this.closedTasks.delete(sessionId);
    this.pullRequests.delete(sessionId);
  }

  serializeStore() {
    const plans = Object.fromEntries([...this.plans].map(([sessionId, plan]) => [sessionId, {
      tasks: plan.tasks.map((task) => ({
        title: task.title,
        state: task.state,
        criteria: task.criteria.map((item) => ({ text: item.text, met: item.met })),
      })),
      tasksUpdatedAt: plan.tasksUpdatedAt,
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
      retargetedPrs: this.pullRequestRetargets.map((record) => ({ ...record })),
      mergedPrHeads: this.mergedPullRequestHeads.map((record) => ({ ...record })),
    };
  }

  pullRequestRegistrations() {
    return [...this.pullRequests.values()].flatMap((records) => [...records.values()].map(normalizePullRequestRecord));
  }

  pullRequestRegistrationsForRepo(owner, repo) {
    return this.pullRequestRegistrations().filter((record) => (
      record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase()
    ));
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
    const product = context.product && typeof context.product.key === 'string' && typeof context.product.name === 'string'
      ? { key: context.product.key.slice(0, 500), name: context.product.name.slice(0, 200) }
      : previous?.product || null;
    const next = {
      session_id: sessionId,
      ...parsedUrl,
      addedAt: previous?.addedAt || isoTime(now),
      cwd: typeof context.cwd === 'string' && context.cwd.length <= 4096 ? context.cwd : previous?.cwd || null,
      product,
      state: previous?.state || 'unknown',
      mergedAt: previous?.mergedAt || null,
      lastOpen: previous?.lastOpen ? { ...previous.lastOpen } : null,
    };
    if (previous && stableStringify(previous) === stableStringify(next)) return normalizePullRequestRecord(previous);
    records.set(key, next);
    this.touch();
    this.requestStoreWrite();
    return normalizePullRequestRecord(next);
  }

  updatePullRequest(sessionId, owner, repo, number, changes) {
    const records = this.pullRequests.get(sessionId);
    const key = pullRequestRecordKey(owner, repo, number);
    const current = records?.get(key);
    if (!current) return false;
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

  recordMergedPullRequestHead(record) {
    if (!validMergedPullRequestHead(record)) return false;
    const index = this.mergedPullRequestHeads.findIndex((item) => item.owner === record.owner && item.repo === record.repo && item.number === record.number);
    const next = { ...record };
    if (index >= 0 && stableStringify(this.mergedPullRequestHeads[index]) === stableStringify(next)) return false;
    if (index >= 0) this.mergedPullRequestHeads[index] = next;
    else this.mergedPullRequestHeads.push(next);
    this.touch();
    this.requestStoreWrite();
    return true;
  }

  mergedPullRequestHeadsForRepo(owner, repo) {
    return this.mergedPullRequestHeads.filter((record) => record.owner.toLowerCase() === owner.toLowerCase() && record.repo.toLowerCase() === repo.toLowerCase());
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

    if (this.restoreSessionCleanupPending) {
      this.restoreSessionCleanupPending = false;
      for (const sessionId of this.hiddenSessions) {
        if (next.has(sessionId) || this.plans.get(sessionId)?.tasks.length) continue;
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
  }

  reopenAbsentSession(sessionId) {
    this.endedByAbsence.delete(sessionId);
    const entries = this.entries.get(sessionId) || [];
    const [session] = deriveSessions(entries);
    if (session) this.sessions.set(sessionId, session);
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
    const next = { ...(this.display || defaultDisplay()), ...changes };
    if (this.display && JSON.stringify(this.display) === JSON.stringify(next)) return cloneDisplay(this.display);
    this.display = next;
    this.touch();
    this.requestStoreWrite();
    return cloneDisplay(this.display);
  }

  closeTask(sessionId, title) {
    const task = this.plans.get(sessionId)?.tasks.find((item) => item.title === title);
    if (!task) return null;
    if (task.state === 'done') return false;
    this.closedTaskMapFor(sessionId).set(title, { stateAtClose: task.state });
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
    plan.tasks = tasks.map((task) => ({
      title: task.title,
      state: task.state,
      criteria: task.criteria.map((criterion) => ({ text: criterion.text, met: criterion.met })),
    }));
    plan.tasksUpdatedAt = isoTime(now);
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
      plan = { tasks: [], tasksUpdatedAt: null, decisions: [] };
      this.plans.set(sessionId, plan);
    }
    return plan;
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
