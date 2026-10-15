const PLAN_TOOL = 'mcp__ccd_turn__update_plan';
const ITEM_STATUSES = new Set(['pending', 'in_progress', 'completed']);

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
        typeof item.status !== 'string' || !ITEM_STATUSES.has(item.status) || titles.has(item.content.trim())) return null;
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
  return toolName === 'mcp__ccd_turn__wrap_up' ? { wrapUp: true }
    : toolName === PLAN_TOOL ? sanitizePlanUpdate(input) : null;
}

function currentTask(tasks) {
  const task = tasks.at(-1);
  return task && task.state !== 'done' ? task : null;
}

function limitTasks(tasks) {
  while (tasks.length > 50) {
    const oldestDone = tasks.findIndex(task => task.state === 'done');
    if (oldestDone < 0) break;
    tasks.splice(oldestDone, 1);
  }
  return tasks;
}

function finishPrevious(tasks) {
  for (const task of tasks) task.state = 'done';
}

function mergeTasks(tasks, incoming) {
  tasks = structuredClone(tasks);
  for (const entry of incoming) {
    const title = entry.title.trim();
    let task = tasks.find(task => task.title.trim() === title);
    // 今のタスクは末尾にある前提なので、終えたタスクを再開するときは末尾へ移し、他を終える。
    if (task && task.state === 'done' && entry.state !== 'done' && task !== tasks.at(-1)) {
      tasks.splice(tasks.indexOf(task), 1);
      finishPrevious(tasks);
      tasks.push(task);
    }
    if (!task) {
      const current = currentTask(tasks);
      if (current && (current.autoTitle || !current.criteria.length)) {
        task = current;
        task.title = title;
      } else {
        finishPrevious(tasks);
        task = { title, criteria: [] };
        tasks.push(task);
      }
    }
    delete task.autoTitle;
    task.state = entry.state;
    if (entry.criteria?.length) task.criteria = structuredClone(entry.criteria);
  }
  return limitTasks(tasks);
}

function applyDifference(tasks, input) {
  const task = currentTask(tasks);
  if (!task) return;
  const criteria = task.criteria;
  let changed = input.wrapUp === true;
  const complete = item => { changed = true; item.met = true; delete item.doing; };
  const start = item => { changed = true; item.met = false; item.doing = true; };
  if (input.wrapUp) criteria.forEach(complete);
  if (input.advance) {
    const doing = criteria.findIndex(item => !item.met && item.doing);
    if (doing >= 0) complete(criteria[doing]);
    const next = criteria.findIndex((item, index) => index > doing && !item.met && !item.doing);
    if (next >= 0) start(criteria[next]);
  }
  for (const index of input.done || []) if (criteria[index - 1]) complete(criteria[index - 1]);
  if (criteria[input.start - 1]) start(criteria[input.start - 1]);
  if (changed) task.state = criteria.every(item => item.met) ? 'done' : 'doing';
}

function applyItems(tasks, input, sessionTitle) {
  let task = currentTask(tasks);
  if (!(task && !task.criteria.length) && (input.scope === 'new_task' || !task)) {
    finishPrevious(tasks);
    const base = (sessionTitle || '作業').trim().slice(0, 200) || '作業';
    let title = base;
    for (let number = 2; tasks.some(task => task.title.trim() === title); number++) {
      const suffix = ` (${number})`;
      title = base.slice(0, 200 - suffix.length) + suffix;
    }
    task = { title, autoTitle: true };
    tasks.push(task);
  }
  task.criteria = input.items.map(item => ({ text: item.content, met: item.status === 'completed',
    ...(item.status === 'in_progress' ? { doing: true } : {}) }));
  task.state = task.criteria.every(item => item.met) ? 'done' : 'doing';
  return limitTasks(tasks);
}

// 非同期のフックは到着順が入れ替わるため、最新の items とそれより後の差分を hookAt 順で再構成する。
class PlanUpdates {
  constructor() { this.sessions = new Map(); }
  delete(sessionId) { this.sessions.delete(sessionId); }

  // 一覧を置き換えた時刻を基準にし、それより前に作られた items と差分が遅れて届いても退ける。
  replaced(sessionId, tasks, at) {
    const record = this.sessions.get(sessionId);
    this.sessions.set(sessionId, { hookAt: at, tasks: structuredClone(tasks), hasItems: true,
      seen: record?.seen || new Set(), differences: (record?.differences || []).filter(update => update.hookAt > at) });
  }
  clear() { this.sessions.clear(); }

  merge(sessionId, plan, incoming) {
    const tasks = mergeTasks(plan.tasks, incoming);
    const record = this.sessions.get(sessionId);
    if (record) {
      const baseline = mergeTasks(record.tasks, incoming);
      const sameTasks = baseline.length === tasks.length && baseline.every((task, index) => task.title === tasks[index].title);
      if (sameTasks && !incoming.some(task => task.criteria?.length)) {
        record.tasks = baseline;
      } else {
        record.tasks = structuredClone(tasks);
        record.hookAt = Math.max(record.hookAt, ...record.differences.map(update => update.hookAt));
        record.differences = [];
      }
    }
    return tasks;
  }

  apply(event, plan, sessionTitle) {
    const { session_id: sessionId, hookAt, tool_use_id: toolId, planUpdate: input } = event;
    let record = this.sessions.get(sessionId);
    if (!record) {
      const tasksAt = Date.parse(plan.tasksUpdatedAt);
      record = { hookAt: Number.isFinite(tasksAt) ? tasksAt : -Infinity,
        tasks: structuredClone(plan.tasks), hasItems: false, seen: new Set(), differences: [] };
      this.sessions.set(sessionId, record);
    }
    if (toolId && record.seen.has(toolId)) return null;
    if (toolId) record.seen.add(toolId);
    if (input.items) {
      if (record.hasItems && hookAt <= record.hookAt) return null;
      const before = structuredClone(record.tasks);
      for (const update of record.differences.filter(update => update.hookAt < hookAt)
        .sort((a, b) => a.hookAt - b.hookAt || a.tool_use_id.localeCompare(b.tool_use_id))) {
        applyDifference(before, update.input);
      }
      record.tasks = applyItems(before, input, sessionTitle);
      record.hookAt = hookAt;
      record.hasItems = true;
      record.differences = record.differences.filter(update => update.hookAt > hookAt);
    } else {
      if (hookAt <= record.hookAt) return null;
      record.differences.push({ hookAt, tool_use_id: toolId, input });
    }
    const tasks = structuredClone(record.tasks);
    record.differences.sort((a, b) => a.hookAt - b.hookAt || a.tool_use_id.localeCompare(b.tool_use_id));
    for (const update of record.differences) applyDifference(tasks, update.input);
    return tasks;
  }
}

module.exports = { planUpdateForTool, PlanUpdates };
