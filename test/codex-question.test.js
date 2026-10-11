const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHookEvent } = require('../src/hooks/event');
const { DashboardState } = require('../src/server/state');
const { hookHeaders, uiHeaders, jsonBody, request, startTestServer } = require('./support/server');

const asyncQuestions = [
  { title: '表示の単位は', options: ['thread', 'ターン'] },
  { title: '並び順は', options: ['新しい順', '古い順 (Recommended)'] },
  { title: '追加の条件は' },
];
const planQuestions = [{ id: 'format', header: '形式', question: '保存の形式は',
  options: [{ label: 'CSV', description: '表で読む' }, { label: 'JSON (Recommended)', description: '構造を保つ' }] }];

function event(name, fields = {}, at = 100) {
  return makeHookEvent({ session_id: 'thread', hook_event_name: name,
    tool_name: 'request_user_input_async', tool_use_id: 'question-1',
    tool_input: { questions: asyncQuestions }, ...fields }, at, { provider: 'codex', environment: {} });
}

function decisions(state, id = 'thread') {
  return state.snapshot().sessions.find(session => session.session_id === id)?.decisions || [];
}

test('非同期の質問は先頭を推奨とし、自由記入には選択肢を作らない', () => {
  const state = new DashboardState();
  const input = event('PreToolUse');
  assert.equal(input.questions[0].options[0].recommended, true);
  state.addEvent(input);
  const [decision] = decisions(state);
  assert.equal(decision.source, 'ask');
  assert.equal(decision.state, 'waiting');
  assert.deepEqual(decision.questions.map(q => [q.question, q.header, q.multiSelect]),
    asyncQuestions.map(q => [q.title, '', false]));
  assert.deepEqual(decision.questions.map(q => q.options.map(o => o.recommended)), [[true, false], [true, false], []]);
});

test('待つ質問は Claude と同じ形で Recommended の印を推奨にする', () => {
  const state = new DashboardState();
  state.addEvent(event('PreToolUse', { tool_name: 'request_user_input', tool_input: { questions: planQuestions } }));
  const claude = new DashboardState();
  claude.addEvent(makeHookEvent({ session_id: 'claude', hook_event_name: 'PreToolUse',
    tool_name: 'AskUserQuestion', tool_use_id: 'ask', tool_input: { questions: planQuestions } }, 100));
  assert.deepEqual(decisions(state)[0].questions, decisions(claude, 'claude')[0].questions);
  assert.deepEqual(decisions(state)[0].questions[0].options.map(o => o.recommended), [false, true]);
});

test('Codex のフックとイベント受付は Claude と同じ質問数と選択肢数の上限を使う', () => {
  const questions = Array.from({ length: 5 }, (_, index) => ({ title: `質問 ${index}`,
    options: Array.from({ length: 7 }, (_, option) => `候補 ${option}`) }));
  const hook = event('PreToolUse', { tool_input: { questions } });
  const state = new DashboardState();
  state.addEvent({ ...hook, questions });
  assert.equal(hook.questions.length, 4);
  assert.equal(hook.questions[0].options.length, 6);
  assert.deepEqual(decisions(state)[0].questions, hook.questions);
});

test('すぐ戻る質問ツールの完了は Codex の判断事項を閉じない', () => {
  const state = new DashboardState();
  state.addEvent(event('PreToolUse'));
  state.addEvent(event('PostToolUse', { tool_response: { accepted: true } }, 200));
  state.addEvent(event('Stop', {}, 250));
  state.addEvent(event('PreToolUse', { tool_name: 'exec_command', tool_use_id: 'shell' }, 300));
  assert.equal(decisions(state)[0].state, 'waiting');
  assert.equal(decisions(state)[0].resolution, null);
});

test('待つ質問ツールは Claude と同じく完了で回答内容不明として閉じる', () => {
  const state = new DashboardState();
  const tool_input = { questions: planQuestions };
  state.addEvent(event('PreToolUse', { tool_name: 'request_user_input', tool_input }));
  state.addEvent(event('PostToolUse', { tool_name: 'request_user_input', tool_input }, 200));
  assert.equal(decisions(state)[0].state, 'resolved');
  assert.deepEqual(decisions(state)[0].resolution, { chosen: [], note: '元の画面で回答済み(内容は不明)' });
});

test('同じ thread の質問より後の入力は、すぐ戻る質問を回答内容不明で閉じ、待つ質問を取り下げる', () => {
  const state = new DashboardState();
  state.addEvent(event('PreToolUse'));
  state.addEvent(event('PreToolUse', { tool_use_id: 'question-2', tool_name: 'request_user_input',
    tool_input: { questions: planQuestions } }, 110));
  state.addEvent(event('UserPromptSubmit', { session_id: 'other' }, 200));
  state.addEvent(event('UserPromptSubmit', { agent_id: 'child' }, 200));
  state.addEvent(event('UserPromptSubmit', {}, 90));
  assert.ok(decisions(state).every(d => d.state === 'waiting'));
  state.addEvent(event('UserPromptSubmit', {}, 300));
  const [asyncDecision, planDecision] = decisions(state);
  assert.equal(asyncDecision.state, 'resolved');
  assert.deepEqual(asyncDecision.resolution, { chosen: [], note: '元の画面で回答済み(内容は不明)' });
  assert.equal(planDecision.state, 'withdrawn');
  assert.equal(planDecision.resolution, null);
  state.addEvent(event('Stop', {}, 400));
  assert.deepEqual(decisions(state).map(d => d.state), ['resolved', 'withdrawn']);
});

test('ネイティブの子の質問は判断事項にならない', () => {
  const state = new DashboardState();
  state.addEvent(event('PreToolUse', { agent_id: 'child' }));
  assert.deepEqual(decisions(state), []);
});

test('委譲した thread の質問はセッションも判断事項も作らない', () => {
  const state = new DashboardState();
  state.addEvent(makeHookEvent({ session_id: 'claude-parent', hook_event_name: 'PreToolUse',
    tool_name: 'Bash', tool_use_id: 'launch', tool_input: { command: 'bash ~/.claude/tools/codex-agent.sh impl-hard' } }, 50));
  state.addEvent({ ...event('PreToolUse'), claudeParentSessionId: 'claude-parent' });
  assert.equal(state.snapshot().sessions.some(s => s.session_id === 'thread'), false);
  assert.deepEqual(state.snapshot().sessions[0].decisions, []);
});

test('HTTP で受けた質問カードは在席中に回答できず、次の入力で閉じる', async (t) => {
  const c = await startTestServer(t);
  const postEvent = input => request(c.info.port, { method: 'POST', path: '/api/events',
    headers: hookHeaders(c.info.secret), body: JSON.stringify(input) });
  const snapshot = async () => jsonBody(await request(c.info.port, { path: '/api/state' }));
  assert.equal((await postEvent(event('PreToolUse'))).status, 202);
  const [decision] = (await snapshot()).sessions[0].decisions;
  assert.equal(decision.state, 'waiting');
  const answer = await request(c.info.port, { method: 'POST', path: `/api/decisions/${decision.id}/answer`,
    headers: uiHeaders(c.info, `http://127.0.0.1:${c.info.port}`),
    body: JSON.stringify({ session_id: 'thread', choice: 'ok', note: '' }) });
  assert.equal(answer.status, 409);
  assert.equal(jsonBody(answer).error, 'Decision cannot be answered now');
  await postEvent(event('UserPromptSubmit', {}, 200));
  assert.deepEqual((await snapshot()).sessions[0].decisions[0].resolution,
    { chosen: [], note: '元の画面で回答済み(内容は不明)' });
});
