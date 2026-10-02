const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const path = require('node:path');
const { recommendedOptionFor, sanitizeEvent } = require('./events');

const DEFAULT_AWAY_STATE = Object.freeze({ enabled: false, since: null });
const SESSION_FILE_ABSENCE_END_MS = 60_000;

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
  constructor() {
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
  }

  // フックがまだ届いていないセッションも一覧に出し、題名の変更を拾うために使う。
  syncSessionFiles(files, now = Date.now()) {
    if (!Array.isArray(files)) return;
    const next = new Map(files.map((file) => [file.session_id, file]));
    const previous = this.sessionFiles;
    let changed = JSON.stringify([...next.entries()]) !== JSON.stringify([...previous.entries()]);
    this.sessionFiles = next;

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
        changed = true;
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
  }

  endSession(sessionId, endedAt) {
    this.entries.delete(sessionId);
    this.sessions.delete(sessionId);
    this.endedAt.set(sessionId, endedAt);
    this.endedByAbsence.delete(sessionId);
    this.plans.delete(sessionId);
    this.decisionOverrides.delete(sessionId);
    this.decisionLifecycles.delete(sessionId);
    this.estimates.delete(sessionId);
    this.hiddenSessions.delete(sessionId);
    this.sessionFileLastSeenAt.delete(sessionId);
  }

  endSessionByAbsence(sessionId, endedAt) {
    this.sessions.delete(sessionId);
    this.endedByAbsence.set(sessionId, endedAt);
    this.estimates.delete(sessionId);
    this.hiddenSessions.delete(sessionId);
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
    if (endedAt !== undefined) {
      this.endedAt.delete(event.session_id);
      this.entries.delete(event.session_id);
      this.plans.delete(event.session_id);
      this.decisionOverrides.delete(event.session_id);
      this.sessionFileLastSeenAt.delete(event.session_id);
      this.decisionLifecycles.delete(event.session_id);
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

    if (JSON.stringify([...this.sessions.values()]) !== before || hadEstimate || wasHidden) this.touch();
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

  hideSession(sessionId) {
    const session = this.snapshot().sessions.find((item) => item.session_id === sessionId);
    if (!session) return null;
    if (!this.hiddenSessions.has(sessionId)) {
      this.hiddenSessions.add(sessionId);
      this.touch();
    }
    return true;
  }

  clearHiddenSessions() {
    const count = this.hiddenSessions.size;
    if (count > 0) {
      this.hiddenSessions.clear();
      this.touch();
    }
    return count;
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
      lifecycle.updatedAt = null;
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
    if (Object.hasOwn(updates, 'state')) next.updatedAt = isoTime(now);
    lifecycles.set(decisionId, next);
    this.touch();
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
      ...[...this.plans.keys()].filter((sessionId) => !this.endedAt.has(sessionId) && !this.endedByAbsence.has(sessionId)),
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
        agents: base.agents.map((agent) => ({ ...agent, lastTool: agent.lastTool && { ...agent.lastTool } })),
        permissionWaits: base.permissionWaits.map((wait) => ({ ...wait })),
        decisions: this.decisionsFor(sessionId),
        tasks: (plan?.tasks || []).map((task) => ({ ...task, criteria: task.criteria.map((criterion) => ({ ...criterion })) })),
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

module.exports = { AwayState, atomicWriteAwayState, DashboardState, deriveSessions, claudeModelName };
