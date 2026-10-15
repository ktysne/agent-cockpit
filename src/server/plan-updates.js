const PLAN_TOOL = 'mcp__ccd_turn__update_plan';
const TASK_STATES = { pending: 'todo', in_progress: 'doing', completed: 'done' };

function sanitizePlanUpdate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  if (Object.hasOwn(input, 'items')) {
    if (!Array.isArray(input.items) || input.items.length > 12 ||
      (input.scope !== undefined && !['first_task', 'new_task', 'continuation'].includes(input.scope))) return null;
    const items = [];
    const titles = new Set();
    for (const item of input.items) {
      if (!item || typeof item !== 'object' || Array.isArray(item) ||
        typeof item.content !== 'string' || !item.content.trim() || item.content.length > 200 ||
        typeof item.status !== 'string' || !Object.hasOwn(TASK_STATES, item.status) || titles.has(item.content.trim())) return null;
      titles.add(item.content.trim());
      items.push({ content: item.content.trim(), status: item.status });
    }
    return { items, ...(input.scope === undefined ? {} : { scope: input.scope }) };
  }
  const update = {};
  if (Object.hasOwn(input, 'advance')) {
    if (input.advance !== true) return null;
    update.advance = true;
  }
  if (Object.hasOwn(input, 'done')) {
    if (!Array.isArray(input.done) || !input.done.every(Number.isSafeInteger)) return null;
    update.done = [...input.done];
  }
  if (Object.hasOwn(input, 'start')) {
    if (!Number.isSafeInteger(input.start)) return null;
    update.start = input.start;
  }
  return Object.keys(update).length ? update : null;
}

function planUpdateForTool(toolName, input) {
  return toolName === PLAN_TOOL ? sanitizePlanUpdate(input) : null;
}

function applyDifference(tasks, input) {
  if (input.advance) {
    const doing = tasks.findIndex(task => task.state === 'doing');
    if (doing >= 0) tasks[doing].state = 'done';
    const next = tasks.findIndex((task, index) => index > doing && task.state === 'todo');
    if (next >= 0) tasks[next].state = 'doing';
  }
  for (const index of input.done || []) {
    if (tasks[index - 1]) tasks[index - 1].state = 'done';
  }
  if (tasks[input.start - 1]) tasks[input.start - 1].state = 'doing';
}

// イベントのフックは非同期で送られて届く順が入れ替わるため、最新の items を基準に、それより後の差分を hookAt 順に当て直す。
class PlanUpdates {
  constructor() {
    this.sessions = new Map();
  }

  delete(sessionId) {
    this.sessions.delete(sessionId);
  }

  apply(event, plan) {
    const { session_id: sessionId, hookAt, tool_use_id: toolId, planUpdate: input } = event;
    let record = this.sessions.get(sessionId);
    if (!record) {
      const tasksAt = Date.parse(plan.tasksUpdatedAt);
      record = { hookAt: Number.isFinite(tasksAt) ? tasksAt : -Infinity,
        tasks: plan.tasks.map(({ title, state }) => ({ title, state })),
        hasItems: false, seen: new Set(), differences: [] };
      this.sessions.set(sessionId, record);
    }
    if (toolId && record.seen.has(toolId)) return null;
    if (toolId) record.seen.add(toolId);
    if (input.items) {
      if (record.hasItems && hookAt <= record.hookAt) return null;
      record.hookAt = hookAt;
      record.tasks = input.items.map(item => ({ title: item.content, state: TASK_STATES[item.status] }));
      record.hasItems = true;
      record.resetCriteria = input.scope === 'new_task';
      record.differences = record.differences.filter(update => update.hookAt > hookAt);
    } else {
      if (hookAt <= record.hookAt) return null;
      record.differences.push({ hookAt, tool_use_id: toolId, input });
    }
    const previous = new Map(plan.tasks.map(task => [task.title.trim(), task.criteria]));
    const tasks = record.tasks.map(task => ({ ...task,
      criteria: record.resetCriteria ? [] : previous.get(task.title.trim()) || [] }));
    record.differences.sort((a, b) => a.hookAt - b.hookAt || a.tool_use_id.localeCompare(b.tool_use_id));
    for (const update of record.differences) applyDifference(tasks, update.input);
    record.resetCriteria = false;
    return tasks;
  }

  unmatchedTitles(sessionId, tasks) {
    const record = this.sessions.get(sessionId);
    if (!record?.hasItems) return [];
    const titles = new Set(record.tasks.map(task => task.title.trim()));
    return tasks.map(task => task.title).filter(title => !titles.has(title.trim()));
  }
}

module.exports = { planUpdateForTool, PlanUpdates };
