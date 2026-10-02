const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { sanitizeEvent } = require('./events');

const DEFAULT_AWAY_STATE = Object.freeze({ enabled: false, since: null });

async function atomicWriteAwayState(homeDir, value, fileSystem = fs) {
  const target = path.join(homeDir, 'away.json');
  const temporary = path.join(homeDir, `.away.${process.pid}.${crypto.randomUUID()}.tmp`);
  await fileSystem.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  try {
    await fileSystem.rename(temporary, target);
  } catch (error) {
    await fileSystem.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

class AwayState {
  constructor(homeDir, value = DEFAULT_AWAY_STATE, fileSystem = fs) {
    this.homeDir = homeDir;
    this.value = { ...value };
    this.fileSystem = fileSystem;
    this.pending = Promise.resolve();
  }

  static async load(homeDir, fileSystem = fs) {
    try {
      const value = JSON.parse(await fileSystem.readFile(path.join(homeDir, 'away.json'), 'utf8'));
      if (
        value && typeof value === 'object' && !Array.isArray(value) &&
        typeof value.enabled === 'boolean' &&
        ((value.enabled && Number.isFinite(value.since) && value.since >= 0) || (!value.enabled && value.since === null)) &&
        Number.isFinite(new Date(value.since).getTime())
      ) return new AwayState(homeDir, { enabled: value.enabled, since: value.since }, fileSystem);
    } catch {
    }
    return new AwayState(homeDir, DEFAULT_AWAY_STATE, fileSystem);
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
    await atomicWriteAwayState(this.homeDir, next, this.fileSystem);
    this.value = next;
    return this.snapshot();
  }
}

function isoTime(milliseconds) {
  return new Date(milliseconds).toISOString();
}

function agentFor(session, agentId) {
  if (!agentId) return null;
  return session.agents.find((agent) => agent.agent_id === agentId) || null;
}

function agentModelFromDefinition(agentType, definition) {
  return {
    agent_id: agentType,
    agent_type: agentType || 'サブエージェント',
    startedAt: null,
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

// 背景で動いた codex-agent.sh は終了がフックに届かない。呼び出し元が終わった後は、稼働中とも終了とも言えないので終了未確認にする。
function deactivateBackgroundedCodex(session, parentAgentId) {
  for (const agent of session.agents) {
    if (agent.backgrounded && agent.active && sameAgent(agent.parent_agent_id, parentAgentId)) {
      agent.active = false;
      agent.unconfirmed = true;
    }
  }
}

function deriveSessions(entries) {
  const sessions = new Map();
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
        const agent = agentModelFromDefinition(event.codexDefinition, event.agentDefinition);
        Object.assign(agent, {
          agent_id: agentIdForCall,
          agent_type: event.codexDefinition,
          parent_agent_id: agentId,
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
          session.decisionBindings[toolUseId] = existing.id;
        } else {
          const createdAt = isoTime(event.hookAt);
          const decision = {
            id: toolUseId,
            session_id: event.session_id,
            source: 'ask',
            state: 'waiting',
            title: event.questions[0].question,
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

    if (eventName === 'SubagentStart' && agentId) {
      const existing = agentFor(session, agentId);
      const definition = event.agentDefinition || {};
      if (existing) {
        existing.active = true;
        existing.agent_type = event.agent_type || existing.agent_type;
      } else {
        const agent = agentModelFromDefinition(event.agent_type, definition);
        agent.agent_id = agentId;
        agent.startedAt = isoTime(event.hookAt);
        session.agents.push(agent);
      }
      const unboundAgentCalls = unboundAgentCallsOf(session);
      if (unboundAgentCalls.length === 1) session.agentToolBindings[unboundAgentCalls[0].tool_use_id] = agentId;
    }

    if (eventName === 'SubagentStop' && agentId) {
      const agent = agentFor(session, agentId);
      if (agent) agent.active = false;
      deactivateBackgroundedCodex(session, agentId);
    }

    if (eventName === 'PostToolUse' || eventName === 'PostToolUseFailure') {
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

      if (eventName === 'PostToolUse' && event.tool_name === 'Bash' && !event.codexAudit && toolUseId) {
        const placeholder = agentFor(session, session.pendingCodex[toolUseId]);
        if (placeholder) placeholder.backgrounded = true;
        delete session.pendingCodex[toolUseId];
      }

      if (eventName === 'PostToolUse' && event.tool_name === 'Bash' && event.codexAudit && toolUseId) {
        const placeholderId = session.pendingCodex[toolUseId];
        const targetAgent = agentFor(session, placeholderId);
        if (targetAgent) {
          targetAgent.model = event.codexAudit.model || targetAgent.model;
          targetAgent.effort = event.codexAudit.effort || targetAgent.effort;
          targetAgent.source = 'codex-agent audit';
          targetAgent.active = false;
        }
        delete session.pendingCodex[toolUseId];
      }

      if (eventName === 'PostToolUseFailure' && event.tool_name === 'Bash' && toolUseId) {
        const candidate = agentFor(session, session.pendingCodex[toolUseId]);
        if (candidate) candidate.active = false;
        delete session.pendingCodex[toolUseId];
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

    if (eventName === 'Notification' && event.notification_type === 'permission_prompt') {
      const oldestTool = session.tools
        .filter((tool) => sameAgent(tool.agent_id, agentId))
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
      const agents = session.agents.map((agent) => ({ ...agent }));
      const tools = [...session.tools].sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
      const status = permissionWaits.length
        ? '許可待ち'
        : session.stopped && agents.some((agent) => agent.active)
          ? '待機中(サブエージェント稼働中)'
          : session.stopped
            ? '待機中'
            : '作業中';

      return {
        session_id: session.session_id,
        product: session.product,
        title: session.title,
        status,
        tools,
        agents,
        permissionWaits,
        decisions: session.decisions.map(cloneDecision),
      };
    });
}

class DashboardState {
  constructor() {
    this.entries = new Map();
    this.sequence = 0;
    this.version = 0;
    this.generatedAt = new Date().toISOString();
    this.sessions = new Map();
    this.endedAt = new Map();
    this.fieldNames = new Set();
    this.notificationTypes = new Set();
    this.sessionFiles = new Map();
    this.plans = new Map();
    this.decisionOverrides = new Map();
  }

  // フックがまだ届いていないセッションも一覧に出し、題名の変更を拾うために使う。
  syncSessionFiles(files) {
    const next = new Map(files.map((file) => [file.session_id, file]));
    const before = JSON.stringify([...this.sessionFiles.entries()]);
    if (JSON.stringify([...next.entries()]) === before) return;
    this.sessionFiles = next;
    this.version += 1;
    this.generatedAt = new Date().toISOString();
  }

  sessionNameFor(sessionId) {
    return this.sessionFiles.get(sessionId)?.name || null;
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
    if (endedAt !== undefined) {
      this.endedAt.delete(event.session_id);
      this.entries.delete(event.session_id);
      this.plans.delete(event.session_id);
      this.decisionOverrides.delete(event.session_id);
    }

    const before = JSON.stringify([...this.sessions.values()]);
    const entries = this.entries.get(event.session_id) || [];
    entries.push({ event, sequence: this.sequence++ });
    this.entries.set(event.session_id, entries);
    const nextSessions = deriveSessions(entries);
    if (nextSessions.length > 0) this.sessions.set(event.session_id, nextSessions[0]);
    else this.sessions.delete(event.session_id);

    if (event.hook_event_name === 'SessionEnd') {
      this.entries.delete(event.session_id);
      this.endedAt.set(event.session_id, event.hookAt);
      this.plans.delete(event.session_id);
      this.decisionOverrides.delete(event.session_id);
    }

    if (JSON.stringify([...this.sessions.values()]) !== before) {
      this.version += 1;
      this.generatedAt = new Date().toISOString();
    }
    return true;
  }

  setTasks(sessionId, tasks, now = Date.now()) {
    const plan = this.planFor(sessionId);
    plan.tasks = tasks.map((task) => ({
      title: task.title,
      state: task.state,
      criteria: task.criteria.map((criterion) => ({ text: criterion.text, met: criterion.met })),
    }));
    plan.tasksUpdatedAt = isoTime(now);
    this.touch();
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
        options: input.options.map((option) => ({ ...option })),
      }],
      createdAt: timestamp,
      updatedAt: timestamp,
      resolvedAt: null,
      answer: null,
      resolution: null,
    };
    plan.decisions.push(decision);
    this.touch();
    return cloneDecision(decision);
  }

  updateDecision(sessionId, id, state, chosen, note, now = Date.now()) {
    const decision = this.decisionsFor(sessionId).find((item) => item.id === id);
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
    const stored = plan?.decisions.find((item) => item.id === id);
    if (stored) Object.assign(stored, updated);
    else {
      const overrides = this.decisionOverrides.get(sessionId) || new Map();
      overrides.set(id, {
        state: updated.state,
        updatedAt: updated.updatedAt,
        resolvedAt: updated.resolvedAt,
        resolution: cloneResolution(updated.resolution),
      });
      this.decisionOverrides.set(sessionId, overrides);
    }
    this.touch();
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
    return [...eventDecisions, ...planDecisions].map((decision) => {
      const override = overrides?.get(decision.id);
      if (!override || Date.parse(override.updatedAt) < Date.parse(decision.updatedAt)) return cloneDecision(decision);
      return cloneDecision({ ...decision, ...override });
    });
  }

  touch() {
    this.version += 1;
    this.generatedAt = new Date().toISOString();
  }

  snapshot() {
    const fileOnlySessions = [...this.sessionFiles.values()]
      .filter((file) => !this.sessions.has(file.session_id) && !this.endedAt.has(file.session_id))
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
      ...[...this.plans.keys()].filter((sessionId) => !this.endedAt.has(sessionId)),
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
      return {
        ...base,
        title: this.sessionNameFor(sessionId) || base.title,
        product: base.product ? { ...base.product } : null,
        tools: base.tools.map((tool) => ({ ...tool })),
        agents: base.agents.map((agent) => ({ ...agent, lastTool: agent.lastTool && { ...agent.lastTool } })),
        permissionWaits: base.permissionWaits.map((wait) => ({ ...wait })),
        decisions: this.decisionsFor(sessionId),
        tasks: (plan?.tasks || []).map((task) => ({ ...task, criteria: task.criteria.map((criterion) => ({ ...criterion })) })),
        tasksUpdatedAt: plan?.tasksUpdatedAt || null,
      };
    });
    return {
      version: this.version,
      generatedAt: this.generatedAt,
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
    answer: decision.answer ? { ...decision.answer } : null,
    resolution: cloneResolution(decision.resolution),
  };
}

module.exports = { AwayState, atomicWriteAwayState, DashboardState, deriveSessions };
