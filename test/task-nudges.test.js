const test = require('node:test');
const assert = require('node:assert/strict');
const { DashboardState } = require('../src/server/state');
const { DecisionAnswerDelivery } = require('../src/server/decision-answers');
const {
  TASK_REMINDER_INTERVAL_MS,
  NO_TASKS_REMINDER,
  SUBAGENT_REMINDER,
  TaskNudges,
} = require('../src/server/task-nudges');

const START = Date.UTC(2026, 9, 2, 1, 2, 3);

function task(title = '実装する') {
  return { title, state: 'doing', criteria: [] };
}

function event(sessionId, hookEventName, hookAt, values = {}) {
  return { session_id: sessionId, hook_event_name: hookEventName, hookAt, ...values };
}

function makeNudges(options = {}) {
  const state = options.state || new DashboardState();
  let now = START;
  const nudges = new TaskNudges({ state, now: () => now });
  return {
    state,
    nudges,
    setNow(value) { now = value; },
  };
}

test('メインのツールを 5 回使うとタスク登録を促し、同じセッションでは 10 分空ける', () => {
  const { nudges, setNow } = makeNudges();
  nudges.afterEvent(event('tools', 'UserPromptSubmit', START));
  for (let index = 1; index <= 4; index += 1) {
    nudges.afterEvent(event('tools', 'PreToolUse', START + index, { tool_name: 'Read' }));
  }
  assert.equal(nudges.reminderFor('tools'), null);

  nudges.afterEvent(event('tools', 'PreToolUse', START + 5, { tool_name: 'Read' }));
  assert.equal(nudges.reminderFor('tools'), NO_TASKS_REMINDER);
  assert.equal(nudges.reminderFor('tools'), null);
  setNow(START + TASK_REMINDER_INTERVAL_MS - 1);
  assert.equal(nudges.reminderFor('tools'), null);
  setNow(START + TASK_REMINDER_INTERVAL_MS);
  assert.equal(nudges.reminderFor('tools'), NO_TASKS_REMINDER);

  nudges.afterEvent(event('tools', 'UserPromptSubmit', START + TASK_REMINDER_INTERVAL_MS + 1));
  assert.equal(nudges.reminderFor('tools'), null);
});

test('タスクが無い状態で Agent ツールを起動すると登録を促す', () => {
  const { nudges } = makeNudges();
  nudges.afterEvent(event('agent-launch', 'UserPromptSubmit', START));
  nudges.afterEvent(event('agent-launch', 'PreToolUse', START + 1, { tool_name: 'Agent' }));
  assert.equal(nudges.reminderFor('agent-launch'), NO_TASKS_REMINDER);
});

test('セッションが終わると催促の記録を消す', () => {
  const { nudges } = makeNudges();
  nudges.afterEvent(event('ended', 'UserPromptSubmit', START));
  nudges.afterEvent(event('ended', 'PreToolUse', START + 1, { tool_name: 'Agent' }));
  nudges.afterEvent(event('ended', 'SessionEnd', START + 2));
  assert.equal(nudges.sessions.has('ended'), false);
});

test('タスクがある場合はサブエージェント終了から 10 分後に書き直しを促す', () => {
  const state = new DashboardState();
  state.setTasks('agent-done', [task()], START);
  const { nudges, setNow } = makeNudges({ state });
  nudges.tasksWritten('agent-done', START);
  nudges.afterEvent(event('agent-done', 'SubagentStop', START + 1, { agent_id: 'agent-1' }));

  setNow(START + TASK_REMINDER_INTERVAL_MS - 1);
  assert.equal(nudges.reminderFor('agent-done'), null);
  setNow(START + TASK_REMINDER_INTERVAL_MS + 1);
  assert.equal(nudges.reminderFor('agent-done'), SUBAGENT_REMINDER);
});

test('タスクを書き直すと催促記録を消し、以後の終了時刻を追跡する', () => {
  const state = new DashboardState();
  const { nudges, setNow } = makeNudges({ state });
  nudges.afterEvent(event('task-write', 'PreToolUse', START, { tool_name: 'Agent' }));
  assert.equal(nudges.reminderFor('task-write'), NO_TASKS_REMINDER);
  assert.equal(nudges.sessions.get('task-write').lastNudgeAt, START);

  state.setTasks('task-write', [task()], START + 1);
  nudges.tasksWritten('task-write', START + 1);
  assert.equal(nudges.sessions.get('task-write').lastNudgeAt, null);
  nudges.afterEvent(event('task-write', 'SubagentStop', START + 2, { agent_id: 'agent-1' }));
  setNow(START + TASK_REMINDER_INTERVAL_MS + 2);
  assert.equal(nudges.reminderFor('task-write'), SUBAGENT_REMINDER);
});

test('サブエージェント終了より後にタスクを書いたら、その終了を理由に催促しない', () => {
  const state = new DashboardState();
  state.setTasks('updated-after-agent', [task()], START);
  const { nudges, setNow } = makeNudges({ state });
  nudges.tasksWritten('updated-after-agent', START);
  nudges.afterEvent(event('updated-after-agent', 'SubagentStop', START + 1, { agent_id: 'agent-1' }));
  state.setTasks('updated-after-agent', [task('報告を反映する')], START + 2);
  nudges.tasksWritten('updated-after-agent', START + 2);

  setNow(START + TASK_REMINDER_INTERVAL_MS + 2);
  assert.equal(nudges.reminderFor('updated-after-agent'), null);
});

test('サブエージェントのツール使用は回数に含めない', () => {
  const { nudges } = makeNudges();
  nudges.afterEvent(event('nested-tools', 'UserPromptSubmit', START));
  for (let index = 1; index <= 5; index += 1) {
    nudges.afterEvent(event('nested-tools', 'PreToolUse', START + index, {
      tool_name: 'Read', agent_id: 'agent-1',
    }));
  }
  assert.equal(nudges.sessions.get('nested-tools').mainToolUseCount, 0);
  assert.equal(nudges.reminderFor('nested-tools'), null);
});

test('PostToolBatch は判断事項の回答とタスク催促を同じ additionalContext にまとめる', () => {
  const state = new DashboardState();
  const delivery = new DecisionAnswerDelivery({ state, away: { snapshot: () => ({ enabled: false }) }, now: () => START });
  const decision = state.addDecision('combined', {
    title: 'どの方式にしますか。', context: '', state: 'provisional', options: [],
  }, START);
  delivery.submitAnswer('combined', decision.id, null, '期限付きで進める。');
  delivery.afterEvent(event('combined', 'PreToolUse', START + 1, { tool_name: 'Agent' }));

  const context = delivery.deliverPostToolBatch('combined');
  assert.match(context, /判断事項/);
  assert.match(context, /期限付きで進める。/);
  assert.match(context, /タスクが登録されていない/);
});
