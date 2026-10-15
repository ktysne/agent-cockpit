const TASK_REMINDER_TOOL_COUNT = 5;
const TASK_REMINDER_INTERVAL_MS = 10 * 60 * 1000;

const NO_TASKS_REMINDER = 'タスクが登録されていない。アプリのタスク一覧か `cockpit_set_tasks` で今の作業のタスクを登録し、完了条件は `cockpit_set_tasks` で足す。';
const SUBAGENT_REMINDER = 'サブエージェントが終わった後にタスクが書き直されていない。報告に合わせてアプリのタスク一覧か `cockpit_set_tasks` で状態を更新する。';
const SET_TASKS_NO_TASKS_REMINDER = 'タスクが登録されていない。`cockpit_set_tasks` で今の作業のタスクと完了条件を登録する。';
const SET_TASKS_SUBAGENT_REMINDER = 'サブエージェントが終わった後にタスクが書き直されていない。報告に合わせて `cockpit_set_tasks` で状態を更新する。';

class TaskNudges {
  constructor({ state, now = Date.now } = {}) {
    this.state = state;
    this.now = now;
    this.sessions = new Map();
  }

  sessionFor(sessionId) {
    let session = this.sessions.get(sessionId);
    if (!session) {
      session = {
        turnStartedAt: null,
        mainToolUseCount: 0,
        lastMainToolUseAt: null,
        agentStartedWithoutTasks: false,
        lastSubagentStopAt: null,
        nudgedSubagentStopAt: null,
        lastTaskWriteAt: null,
        lastNudgeAt: null,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  afterEvent(event) {
    if (!event || typeof event.session_id !== 'string') return;
    if (event.hook_event_name === 'SessionEnd' && !event.agent_id) {
      this.sessionEnded(event.session_id);
      return;
    }
    const session = this.sessionFor(event.session_id);
    const eventAt = Number.isFinite(event.hookAt) ? event.hookAt : this.now();

    if (event.hook_event_name === 'UserPromptSubmit' && !event.agent_id) {
      if (session.lastMainToolUseAt !== null && eventAt <= session.lastMainToolUseAt) return;
      if (session.turnStartedAt !== null && eventAt <= session.turnStartedAt) return;
      session.turnStartedAt = eventAt;
      session.mainToolUseCount = 0;
      session.agentStartedWithoutTasks = false;
      session.lastMainToolUseAt = null;
      return;
    }

    if (event.hook_event_name === 'SubagentStop' && event.agent_id) {
      if (session.lastSubagentStopAt === null || eventAt > session.lastSubagentStopAt) {
        session.lastSubagentStopAt = eventAt;
      }
      return;
    }

    if (event.hook_event_name !== 'PreToolUse' || event.agent_id) return;
    if (session.turnStartedAt !== null && eventAt < session.turnStartedAt) return;
    session.mainToolUseCount += 1;
    session.lastMainToolUseAt = session.lastMainToolUseAt === null
      ? eventAt
      : Math.max(session.lastMainToolUseAt, eventAt);
    if (event.tool_name === 'Agent' && !this.hasTasks(event.session_id)) {
      session.agentStartedWithoutTasks = true;
    }
  }

  sessionEnded(sessionId) {
    this.sessions.delete(sessionId);
  }

  tasksWritten(sessionId, writtenAt = this.now()) {
    const session = this.sessionFor(sessionId);
    session.lastTaskWriteAt = writtenAt;
    session.lastNudgeAt = null;
    session.mainToolUseCount = 0;
    session.agentStartedWithoutTasks = false;
  }

  reminderFor(sessionId) {
    const session = this.sessionFor(sessionId);
    const now = this.now();
    const hasTasks = this.hasTasks(sessionId);
    const subagentReportIsStale = hasTasks && session.lastSubagentStopAt !== null &&
      session.lastSubagentStopAt > (session.lastTaskWriteAt ?? -1) &&
      session.lastSubagentStopAt !== session.nudgedSubagentStopAt &&
      now - session.lastSubagentStopAt >= TASK_REMINDER_INTERVAL_MS;
    const noTasksReminderIsDue = !hasTasks && (
      session.mainToolUseCount >= TASK_REMINDER_TOOL_COUNT || session.agentStartedWithoutTasks
    );
    if (!subagentReportIsStale && !noTasksReminderIsDue) return null;
    if (session.lastNudgeAt !== null && now - session.lastNudgeAt < TASK_REMINDER_INTERVAL_MS) return null;

    session.lastNudgeAt = now;
    if (subagentReportIsStale) session.nudgedSubagentStopAt = session.lastSubagentStopAt;
    const setTasksOnly = this.state.providerForSession?.(sessionId) === 'codex' ||
      this.state.getDisplayPreferences?.()?.importAppTasks === false;
    if (subagentReportIsStale) return setTasksOnly ? SET_TASKS_SUBAGENT_REMINDER : SUBAGENT_REMINDER;
    return setTasksOnly ? SET_TASKS_NO_TASKS_REMINDER : NO_TASKS_REMINDER;
  }

  hasTasks(sessionId) {
    return (this.state.planSummary(sessionId).tasks || []).length > 0;
  }
}

module.exports = {
  TASK_REMINDER_TOOL_COUNT,
  TASK_REMINDER_INTERVAL_MS,
  NO_TASKS_REMINDER,
  SUBAGENT_REMINDER,
  SET_TASKS_NO_TASKS_REMINDER,
  SET_TASKS_SUBAGENT_REMINDER,
  TaskNudges,
};
