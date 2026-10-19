const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { DashboardState } = require('../src/server/state');

function syntheticEvents(count = 10000) {
  const events = [];
  const add = (name, fields = {}) => events.push({
    session_id: 'compact', hook_event_name: name, hookAt: 1000 + events.length, ...fields,
  });
  add('SessionStart');
  for (let turn = 0; events.length < count; turn++) {
    add('UserPromptSubmit');
    if (turn === 0) {
      add('SubagentStart', { agent_id: 'worker', agent_type: 'Explore' });
      add('PreToolUse', { agent_id: 'worker', tool_name: 'Read', tool_use_id: 'worker-tool', summary: 'last tool' });
      add('PostToolUse', { agent_id: 'worker', tool_name: 'Read', tool_use_id: 'worker-tool' });
      add('SubagentStop', { agent_id: 'worker' });
      add('PreToolUse', { tool_name: 'Bash', tool_use_id: 'pr', ghPrCreateCommand: true, refreshPullRequestsCommand: true });
      add('PostToolUse', { tool_name: 'Bash', tool_use_id: 'pr' });
      add('PreToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask', questions: [{ question: '進めますか', options: [{ label: 'はい' }] }] });
      const questionAt = 1000 + events.length;
      add('Stop');
      add('PostToolUse', { tool_name: 'AskUserQuestion', tool_use_id: 'ask', hookAt: questionAt - 0.5, decisionResolution: { chosen: 'はい' } });
    }
    for (let tool = 0; tool < 100 && events.length < count - 1; tool++) {
      const fields = { tool_name: 'Read', tool_use_id: `tool-${turn}-${tool}` };
      const preAt = 1000 + events.length;
      if (tool === 0) {
        add('PostToolUse', { ...fields, hookAt: preAt + 0.5 });
        add('PreToolUse', { ...fields, hookAt: preAt });
      } else {
        add('PreToolUse', fields);
        add(tool % 7 === 0 ? 'PostToolUseFailure' : 'PostToolUse', fields);
      }
    }
    add('Stop');
  }
  return events.slice(0, count);
}

// 検証はイベントごとに全件から組み立て直すので、件数の 2 乗で遅くなる。畳み込みが 2 回起きる 4,000 件に抑える。
test('遅延した開始と質問の完了を含む四千イベントの表示が畳み込み後も全件の再構築と一致する', () => {
  const state = new DashboardState({ verifyEntries: true });
  for (const event of syntheticEvents(4000)) {
    state.addEvent(event);
    state.wasPullRequestCreate('compact', event.tool_use_id);
    state.wasPullRequestRefreshCommand('compact', event.tool_use_id);
  }
  state.addEvent({ session_id: 'compact', hook_event_name: 'PreToolUse', hookAt: 1020,
    tool_name: 'Read', tool_use_id: 'tool-0-1' });
  state.addEvent({ session_id: 'compact', hook_event_name: 'PostToolUse', hookAt: 1010.5,
    tool_name: 'AskUserQuestion', tool_use_id: 'ask', decisionResolution: { chosen: 'はい' } });
  assert.ok(state.entries.get('compact').length < 3000);
  const row = state.snapshot().sessions.find((session) => session.session_id === 'compact');
  assert.equal(row.agents[0].lastTool.summary, 'last tool');
  assert.equal(row.decisions[0].state, 'resolved');
  assert.equal(state.wasPullRequestCreate('compact', 'pr'), true);
  assert.equal(state.wasPullRequestRefreshCommand('compact', 'pr'), true);
});

test('PowerShell の PR 作成と取り直し判定が索引と全件照合に一致する', () => {
  const state = new DashboardState({ verifyEntries: true });
  state.addEvent({ session_id: 'powershell-index', hook_event_name: 'PreToolUse', hookAt: 1000,
    tool_name: 'PowerShell', tool_use_id: 'powershell-pr', ghPrCreateCommand: true, refreshPullRequestsCommand: true });
  assert.equal(state.wasPullRequestCreate('powershell-index', 'powershell-pr'), true);
  assert.equal(state.wasPullRequestRefreshCommand('powershell-index', 'powershell-pr'), true);
});

test('同じ一万イベントの先頭と末尾の処理時間が大幅に増加しない', (t) => {
  const state = new DashboardState({ verifyEntries: false });
  const events = syntheticEvents();
  const times = events.map((event) => {
    const start = performance.now();
    state.addEvent(event);
    return performance.now() - start;
  });
  const mean = (values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const first = mean(times.slice(0, 500));
  const last = mean(times.slice(-500));
  t.diagnostic(`先頭 ${first.toFixed(3)}ms、末尾 ${last.toFixed(3)}ms、比 ${(last / first).toFixed(2)}`);
  // 短い処理では時計と GC の揺れが比率を支配するため、平均 0.25ms を判定の下限にする。
  // 区切りのイベントは残すので緩やかには増える。畳み込みが効かないと数十倍になるので、5 倍で分ける。
  assert.ok(last <= Math.max(first, 0.25) * 5,`先頭 ${first.toFixed(3)}ms、末尾 ${last.toFixed(3)}ms`);
});

test('Codex のツールに毎回モデルと作業ディレクトリが付いても畳み込み後の表示が一致する', () => {
  const state = new DashboardState({ verifyEntries: true });
  const add = (name, at, fields = {}) => state.addEvent({ session_id: 'codex-compact', provider: 'codex',
    hook_event_name: name, hookAt: at, model: 'gpt-6', cwd: 'D:/project', ...fields });
  add('SessionStart', 1000);
  for (let turn = 0; turn < 12; turn++) {
    add('UserPromptSubmit', 1001 + turn * 202);
    for (let tool = 0; tool < 100; tool++) {
      const fields = { tool_name: 'exec_command', tool_use_id: `${turn}-${tool}` };
      add('PreToolUse', 1002 + turn * 202 + tool * 2, fields);
      add('PostToolUse', 1003 + turn * 202 + tool * 2, fields);
    }
    add('Stop', 1202 + turn * 202);
  }
  assert.ok(state.entries.get('codex-compact').length < 1000);
  assert.equal(state.snapshot().sessions[0].codex.model, 'gpt-6');
});
