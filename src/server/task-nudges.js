const TASK_REMINDER_TOOL_COUNT = 5;
const TASK_REMINDER_INTERVAL_MS = 10 * 60 * 1000;

const NO_TASKS_REMINDER = 'タスクが登録されていない。アプリのタスク一覧は cockpit の 1 つのタスクの完了条件として取り込まれる。依頼ごとに `cockpit_set_tasks` で題だけを 1 件 (`[{title, state:"doing"}]`) 登録する。完了条件は書かなくてよい。';
const SUBAGENT_REMINDER = 'サブエージェントが終わった後にタスクが書き直されていない。報告に合わせてアプリのタスク一覧の各項目の状態を更新する。一覧は cockpit の 1 つのタスクの完了条件として取り込まれる。題を登録するときは `cockpit_set_tasks` で 1 件登録し、完了条件は書かなくてよい。';
const SET_TASKS_NO_TASKS_REMINDER = 'タスクが登録されていない。`cockpit_set_tasks` で今の作業のタスクと完了条件を登録する。';
const SET_TASKS_SUBAGENT_REMINDER = 'サブエージェントが終わった後にタスクが書き直されていない。報告に合わせて `cockpit_set_tasks` で状態を更新する。';
const STALE_TASKS_REMINDER = '前のタスクがすべて完了したまま、新しい作業が続いている。新しい依頼なら、アプリのタスク一覧を新しい作業に合わせ、`cockpit_set_tasks` で題だけを 1 件 (`[{title, state:"doing"}]`) 登録する。同じ依頼の続きなら、そのままでよい。';
const SET_TASKS_STALE_TASKS_REMINDER = '前のタスクがすべて完了したまま、新しい作業が続いている。新しい依頼なら、`cockpit_set_tasks` で今の作業のタスクと完了条件を登録する。同じ依頼の続きなら、そのままでよい。';

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
        agentStartedWithCompletedTasks: false,
        staleTasksNudgedTurnAt: null,
        lastSubagentStopAt: null,
        nudgedSubagentStopAt: null,
        lastTaskWriteAt: null,
        lastNudgeAt: null,
        pendingNudge: null,
      };
      this.sessions.set(sessionId, session);
    }
    return session;
  }

  afterEvent(event, { ended = true } = {}) {
    if (!event || typeof event.session_id !== 'string') return;
    if (event.hook_event_name === 'SessionEnd' && !event.agent_id) {
      if (ended) this.sessionEnded(event.session_id);
      return;
    }
    if (this.state.isDelegatedCodexThread?.(event.session_id)) {
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
      session.agentStartedWithCompletedTasks = false;
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
    if (event.tool_name === 'Agent') {
      const tasks = this.tasksFor(event.session_id);
      if (!tasks.length) session.agentStartedWithoutTasks = true;
      else if (tasks.every((task) => task.state === 'done')) session.agentStartedWithCompletedTasks = true;
    }
  }

  sessionEnded(sessionId) {
    this.sessions.delete(sessionId);
  }

  tasksWritten(sessionId, writtenAt = this.now()) {
    const session = this.sessionFor(sessionId);
    session.pendingNudge = null;
    session.lastTaskWriteAt = writtenAt;
    session.lastNudgeAt = null;
    session.mainToolUseCount = 0;
    session.agentStartedWithoutTasks = false;
    session.agentStartedWithCompletedTasks = false;
  }

  reminderFor(sessionId) {
    if (this.state.isDelegatedCodexThread?.(sessionId)) {
      this.sessionEnded(sessionId);
      return null;
    }
    const session = this.sessionFor(sessionId);
    if (session.pendingNudge) return null;
    const now = this.now();
    const tasks = this.tasksFor(sessionId);
    const hasTasks = tasks.length > 0;
    const subagentReportIsStale = hasTasks && session.lastSubagentStopAt !== null &&
      session.lastSubagentStopAt > (session.lastTaskWriteAt ?? -1) &&
      session.lastSubagentStopAt !== session.nudgedSubagentStopAt &&
      now - session.lastSubagentStopAt >= TASK_REMINDER_INTERVAL_MS;
    const noTasksReminderIsDue = !hasTasks && (
      session.mainToolUseCount >= TASK_REMINDER_TOOL_COUNT || session.agentStartedWithoutTasks
    );
    const staleTasksReminderIsDue = tasks.length > 0 && tasks.every((task) => task.state === 'done') &&
      session.turnStartedAt !== null &&
      (session.lastTaskWriteAt === null || session.lastTaskWriteAt <= session.turnStartedAt) &&
      (session.mainToolUseCount >= TASK_REMINDER_TOOL_COUNT || session.agentStartedWithCompletedTasks) &&
      // 同じ依頼の続きなら一覧はそのままでよいので、1 つのターンで繰り返さない。
      session.staleTasksNudgedTurnAt !== session.turnStartedAt;
    if (!subagentReportIsStale && !noTasksReminderIsDue && !staleTasksReminderIsDue) return null;
    if (session.lastNudgeAt !== null && now - session.lastNudgeAt < TASK_REMINDER_INTERVAL_MS) return null;

    session.pendingNudge = {
      createdAt: now,
      lastNudgeAt: now,
      nudgedSubagentStopAt: subagentReportIsStale ? session.lastSubagentStopAt : session.nudgedSubagentStopAt,
      staleTasksNudgedTurnAt: staleTasksReminderIsDue && !subagentReportIsStale && !noTasksReminderIsDue
        ? session.turnStartedAt : session.staleTasksNudgedTurnAt,
    };
    const setTasksOnly = this.state.providerForSession?.(sessionId) === 'codex' ||
      this.state.getDisplayPreferences?.()?.importAppTasks !== true;
    if (subagentReportIsStale) return setTasksOnly ? SET_TASKS_SUBAGENT_REMINDER : SUBAGENT_REMINDER;
    if (noTasksReminderIsDue) return setTasksOnly ? SET_TASKS_NO_TASKS_REMINDER : NO_TASKS_REMINDER;
    return setTasksOnly ? SET_TASKS_STALE_TASKS_REMINDER : STALE_TASKS_REMINDER;
  }

  acknowledgeReminder(sessionId, pendingNudge) {
    const session = this.sessions.get(sessionId);
    if (!pendingNudge || session?.pendingNudge !== pendingNudge) return;
    const { createdAt, ...delivered } = pendingNudge;
    Object.assign(session, delivered, { lastNudgeAt: this.now(), pendingNudge: null });
  }

  cancelReminder(sessionId, occurredAt = Infinity) {
    const session = this.sessions.get(sessionId);
    if (session?.pendingNudge && session.pendingNudge.createdAt < occurredAt) session.pendingNudge = null;
  }

  tasksFor(sessionId) {
    return this.state.planSummary(sessionId).tasks || [];
  }
}

module.exports = {
  TASK_REMINDER_TOOL_COUNT,
  TASK_REMINDER_INTERVAL_MS,
  NO_TASKS_REMINDER,
  SUBAGENT_REMINDER,
  SET_TASKS_NO_TASKS_REMINDER,
  SET_TASKS_SUBAGENT_REMINDER,
  STALE_TASKS_REMINDER,
  SET_TASKS_STALE_TASKS_REMINDER,
  TaskNudges,
};
