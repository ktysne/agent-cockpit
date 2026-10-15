const test = require('node:test');
const assert = require('node:assert/strict');
const { DashboardState } = require('../src/server/state');
const { DecisionAnswerDelivery } = require('../src/server/decision-answers');
const {
  TASK_REMINDER_INTERVAL_MS,
  NO_TASKS_REMINDER,
  SUBAGENT_REMINDER,
  SET_TASKS_NO_TASKS_REMINDER,
  SET_TASKS_SUBAGENT_REMINDER,
  TaskNudges,
} = require('../src/server/task-nudges');
const { startTestServer, request, hookHeaders, uiHeaders, jsonBody } = require('./support/server');

const START = Date.UTC(2026, 9, 2, 1, 2, 3);

function task(title = '実装する') {
  return { title, state: 'doing', criteria: [] };
}

function event(sessionId, hookEventName, hookAt, values = {}) {
  return { session_id: sessionId, hook_event_name: hookEventName, hookAt, ...values };
}

function makeNudges(options = {}) {
  const state = options.state || new DashboardState();
  if (!options.state) state.patchDisplayPreferences({ importAppTasks: true });
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

test('Agent の PreToolUse 後に届いた同じターンの UserPromptSubmit は催促状態を消さない', () => {
  const { nudges } = makeNudges();
  nudges.afterEvent(event('late-prompt', 'UserPromptSubmit', START));
  nudges.afterEvent(event('late-prompt', 'PreToolUse', START + 2, { tool_name: 'Agent' }));
  nudges.afterEvent(event('late-prompt', 'UserPromptSubmit', START + 1));

  assert.equal(nudges.reminderFor('late-prompt'), NO_TASKS_REMINDER);
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
  state.patchDisplayPreferences({ importAppTasks: true });
  state.setTasks('agent-done', [task()], START);
  const { nudges, setNow } = makeNudges({ state });
  nudges.tasksWritten('agent-done', START);
  nudges.afterEvent(event('agent-done', 'SubagentStop', START + 1, { agent_id: 'agent-1' }));

  setNow(START + TASK_REMINDER_INTERVAL_MS - 1);
  assert.equal(nudges.reminderFor('agent-done'), null);
  setNow(START + TASK_REMINDER_INTERVAL_MS + 1);
  assert.equal(nudges.reminderFor('agent-done'), SUBAGENT_REMINDER);
});

test('サブエージェント終了ごとに 1 回だけ書き直しを促す', () => {
  const state = new DashboardState();
  state.patchDisplayPreferences({ importAppTasks: true });
  state.setTasks('once-per-stop', [task()], START);
  const { nudges, setNow } = makeNudges({ state });
  nudges.tasksWritten('once-per-stop', START);
  nudges.afterEvent(event('once-per-stop', 'SubagentStop', START + 1, { agent_id: 'agent-1' }));

  setNow(START + TASK_REMINDER_INTERVAL_MS + 1);
  assert.equal(nudges.reminderFor('once-per-stop'), SUBAGENT_REMINDER);
  setNow(START + 2 * TASK_REMINDER_INTERVAL_MS + 1);
  assert.equal(nudges.reminderFor('once-per-stop'), null);

  nudges.afterEvent(event('once-per-stop', 'SubagentStop', START + TASK_REMINDER_INTERVAL_MS + 2, { agent_id: 'agent-2' }));
  setNow(START + 2 * TASK_REMINDER_INTERVAL_MS + 2);
  assert.equal(nudges.reminderFor('once-per-stop'), SUBAGENT_REMINDER);
});

test('タスクを書き直すと催促記録を消し、以後の終了時刻を追跡する', () => {
  const state = new DashboardState();
  state.patchDisplayPreferences({ importAppTasks: true });
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
  state.patchDisplayPreferences({ importAppTasks: true });
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
  state.patchDisplayPreferences({ importAppTasks: true });
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

test('Codex のセッションには cockpit_set_tasks だけで登録するよう催促する', () => {
  const state = { planSummary: () => ({ tasks: [] }), providerForSession: () => 'codex' };
  const { nudges } = makeNudges({ state });
  nudges.afterEvent(event('codex', 'UserPromptSubmit', START));
  for (let index = 1; index <= 5; index += 1) {
    nudges.afterEvent(event('codex', 'PreToolUse', START + index, { tool_name: 'Read' }));
  }
  assert.equal(nudges.reminderFor('codex'), SET_TASKS_NO_TASKS_REMINDER);
});

test('取り込み設定がオフの Claude セッションには cockpit_set_tasks だけで登録するよう催促する', () => {
  const state = new DashboardState();
  state.patchDisplayPreferences({ importAppTasks: false });
  const { nudges } = makeNudges({ state });
  nudges.afterEvent(event('claude', 'UserPromptSubmit', START));
  for (let index = 1; index <= 5; index += 1) {
    nudges.afterEvent(event('claude', 'PreToolUse', START + index, { tool_name: 'Read' }));
  }
  assert.equal(nudges.reminderFor('claude'), SET_TASKS_NO_TASKS_REMINDER);
});

test('取り込みオフの Claude セッションに届いた PostToolBatch は cockpit_set_tasks だけの催促を返す', async t => {
  const state = new DashboardState();
  state.patchDisplayPreferences({ importAppTasks: true });
  const { info } = await startTestServer(t, { state });
  const origin = `http://127.0.0.1:${info.port}`;
  const display = await request(info.port, {
    method: 'POST', path: '/api/display',
    headers: { ...uiHeaders(info, origin), 'content-type': 'application/json' },
    body: JSON.stringify({ importAppTasks: false }),
  });
  assert.equal(display.status, 200);
  for (const event of [
    { session_id: 'claude-nudge', provider: 'claude', hook_event_name: 'UserPromptSubmit' },
    { session_id: 'claude-nudge', provider: 'claude', hook_event_name: 'PreToolUse', tool_name: 'Agent' },
  ]) {
    const response = await request(info.port, {
      method: 'POST', path: '/api/events', headers: hookHeaders(info.secret), body: JSON.stringify(event),
    });
    assert.equal(response.status, 202);
  }
  const batch = await request(info.port, {
    method: 'POST', path: '/api/hooks/answers', headers: hookHeaders(info.secret),
    body: JSON.stringify({ action: 'post-tool-batch', event_name: 'PostToolBatch', session_id: 'claude-nudge', id: 'batch' }),
  });
  assert.equal(jsonBody(batch).hookOutput.hookSpecificOutput.additionalContext, SET_TASKS_NO_TASKS_REMINDER);
});

test('取り込み設定がオフの Claude セッションにはサブエージェント終了後も一覧全体を書き直すよう促す', () => {
  const state = new DashboardState();
  state.patchDisplayPreferences({ importAppTasks: false });
  state.setTasks('claude-agent', [task()], START);
  const { nudges, setNow } = makeNudges({ state });
  nudges.tasksWritten('claude-agent', START);
  nudges.afterEvent(event('claude-agent', 'SubagentStop', START + 1, { agent_id: 'agent-1' }));
  setNow(START + TASK_REMINDER_INTERVAL_MS + 1);
  assert.equal(nudges.reminderFor('claude-agent'), SET_TASKS_SUBAGENT_REMINDER);
});
