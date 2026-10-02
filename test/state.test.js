const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { DashboardState } = require('../src/server/state');
const { productFromCwd } = require('../src/server/identity');
const { readSessionName, claudeAgentDefinition, codexAgentDefinition } = require('../src/server/session-files');

async function temporaryHome(testContext) {
  const previous = process.env.AGENT_COCKPIT_HOME;
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-cockpit-test-'));
  process.env.AGENT_COCKPIT_HOME = homeDir;
  testContext.after(async () => {
    if (previous === undefined) delete process.env.AGENT_COCKPIT_HOME;
    else process.env.AGENT_COCKPIT_HOME = previous;
    await fs.rm(homeDir, { recursive: true, force: true });
  });
  return { homeDir, claudeHome: path.join(homeDir, '.claude') };
}

test('worktree の cwd からプロダクトの鍵と表示名を求める', async (t) => {
  await temporaryHome(t);
  assert.deepEqual(
    productFromCwd('D:\\Desktop\\Develop\\Agent-Cockpit\\.claude\\worktrees\\feature-x\\src'),
    { key: 'd:\\desktop\\develop\\agent-cockpit', name: 'Agent-Cockpit' },
  );
});

test('hookAt の順に再構成し、後から届いた古い PreToolUse を完了済みの PostToolUse より前に置く', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({
    session_id: 'ordered', hook_event_name: 'PostToolUse', hookAt: 200,
    tool_name: 'Read', tool_use_id: 'tool-1',
  });
  state.addEvent({
    session_id: 'ordered', hook_event_name: 'PreToolUse', hookAt: 100,
    tool_name: 'Read', tool_use_id: 'tool-1', summary: 'README.md',
  });
  assert.deepEqual(state.snapshot().sessions[0].tools, []);
});

test('許可待ちは同じ対象ツールの PostToolUse で解消する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'permission', hook_event_name: 'SessionStart', hookAt: 100 });
  state.addEvent({ session_id: 'permission', hook_event_name: 'PreToolUse', hookAt: 200, tool_name: 'Bash', tool_use_id: 'oldest', summary: 'git push' });
  state.addEvent({ session_id: 'permission', hook_event_name: 'PreToolUse', hookAt: 300, tool_name: 'Read', tool_use_id: 'newer', summary: 'README.md' });
  state.addEvent({ session_id: 'permission', hook_event_name: 'Notification', hookAt: 400, notification_type: 'permission_prompt', message: '許可を待っています' });

  let session = state.snapshot().sessions[0];
  assert.equal(session.status, '許可待ち');
  assert.equal(session.permissionWaits[0].target_tool_use_id, 'oldest');

  state.addEvent({ session_id: 'permission', hook_event_name: 'PostToolUse', hookAt: 500, tool_name: 'Read', tool_use_id: 'newer' });
  assert.equal(state.snapshot().sessions[0].permissionWaits.length, 1);
  state.addEvent({ session_id: 'permission', hook_event_name: 'PostToolUse', hookAt: 600, tool_name: 'Bash', tool_use_id: 'oldest' });
  session = state.snapshot().sessions[0];
  assert.equal(session.permissionWaits.length, 0);
  assert.equal(session.status, '作業中');
});

test('Stop 時にサブエージェントが稼働中なら待機中として区別する', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'stopped', hook_event_name: 'SessionStart', hookAt: 100 });
  state.addEvent({ session_id: 'stopped', hook_event_name: 'SubagentStart', hookAt: 200, agent_id: 'agent-1', agent_type: 'Explore' });
  state.addEvent({ session_id: 'stopped', hook_event_name: 'Stop', hookAt: 300 });
  assert.equal(state.snapshot().sessions[0].status, '待機中(サブエージェント稼働中)');
});

test('Agent ツールの resolvedModel でサブエージェントの仮モデルを置き換える', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'model-update', hook_event_name: 'PreToolUse', hookAt: 100, tool_name: 'Agent', tool_use_id: 'agent-tool', summary: 'Agent' });
  state.addEvent({ session_id: 'model-update', hook_event_name: 'SubagentStart', hookAt: 200, agent_id: 'agent-1', agent_type: 'Explore' }, {
    agentDefinition: { model: 'claude-default', effort: 'high', source: 'claude-agent-definition' },
  });
  state.addEvent({ session_id: 'model-update', hook_event_name: 'PostToolUse', hookAt: 300, tool_name: 'Agent', tool_use_id: 'agent-tool', resolvedModel: 'claude-resolved' });

  const agent = state.snapshot().sessions[0].agents[0];
  assert.equal(agent.model, 'claude-resolved');
  assert.equal(agent.effort, 'high');
  assert.equal(agent.source, 'Agent tool response');
});

test('SessionEnd はセッションを一覧から外す', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'ended', hook_event_name: 'SessionStart', hookAt: 100 });
  state.addEvent({ session_id: 'ended', hook_event_name: 'SessionEnd', hookAt: 200 });
  assert.deepEqual(state.snapshot().sessions, []);
});

test('セッション名を *.json から読み、*.key は開かない', async (t) => {
  const { homeDir } = await temporaryHome(t);
  const reads = [];
  const fileSystem = {
    async readdir() {
      return [
        { name: 'session-1.key', isFile: () => true },
        { name: 'session-1.json', isFile: () => true },
      ];
    },
    async readFile(filePath) {
      reads.push(path.basename(filePath));
      return JSON.stringify({ name: '設計作業', session_id: 'session-1' });
    },
  };
  assert.equal(await readSessionName('session-1', homeDir, fileSystem), '設計作業');
  assert.deepEqual(reads, ['session-1.json']);
});

test('サブエージェント定義から Claude と Codex のモデルおよび effort を読む', async (t) => {
  const { homeDir } = await temporaryHome(t);
  const claudeAgents = path.join(homeDir, 'agents');
  const gptAgents = path.join(homeDir, 'gpt-agents');
  await fs.mkdir(claudeAgents, { recursive: true });
  await fs.mkdir(gptAgents, { recursive: true });
  await fs.writeFile(path.join(claudeAgents, 'Explore.md'), '---\nmodel: claude-opus\neffort: high\n---\n');
  await fs.writeFile(path.join(gptAgents, 'impl-hard.md'), '---\ncodex_model: gpt-5.5-codex\ncodex_reasoning_effort: xhigh\n---\n');

  assert.deepEqual(await claudeAgentDefinition('Explore', homeDir), {
    model: 'claude-opus', effort: 'high', source: 'claude-agent-definition',
  });
  assert.deepEqual(await codexAgentDefinition('impl-hard', homeDir), {
    model: 'gpt-5.5-codex', effort: 'xhigh', source: 'gpt-agent-definition',
  });
  assert.equal(await claudeAgentDefinition('../outside', homeDir), null);
});

test('SessionEnd より後に遅れて届いたイベントで終了済みセッションを復活させない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'ended-late', hook_event_name: 'SessionStart', hookAt: 100 });
  state.addEvent({ session_id: 'ended-late', hook_event_name: 'SessionEnd', hookAt: 300 });
  state.addEvent({ session_id: 'ended-late', hook_event_name: 'PreToolUse', hookAt: 200, tool_name: 'Read', tool_use_id: 'tool-1', summary: 'README.md' });
  assert.deepEqual(state.snapshot().sessions, []);
});

function launchCodex(state, sessionId, toolUseId, hookAt, agentId) {
  state.addEvent({
    session_id: sessionId, hook_event_name: 'PreToolUse', hookAt, agent_id: agentId,
    tool_name: 'Bash', tool_use_id: toolUseId, summary: 'bash ~/.claude/tools/codex-agent.sh impl-hard < prompt.md',
  });
}

test('背景で動いた Codex の実行は、呼び出したサブエージェントの終了で稼働中から外れる', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'bg', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'impl-hard' });
  launchCodex(state, 'bg', 'bash-1', 2, 'sub-1');
  state.addEvent({ session_id: 'bg', hook_event_name: 'PostToolUse', hookAt: 3, agent_id: 'sub-1', tool_name: 'Bash', tool_use_id: 'bash-1' });
  const codexActive = () => state.snapshot().sessions[0].agents.find((agent) => agent.agent_id === 'codex:bash-1').active;
  assert.equal(codexActive(), true);
  state.addEvent({ session_id: 'bg', hook_event_name: 'SubagentStop', hookAt: 4, agent_id: 'sub-1' });
  assert.equal(codexActive(), false);
  state.addEvent({ session_id: 'bg', hook_event_name: 'Stop', hookAt: 5 });
  assert.equal(state.snapshot().sessions[0].status, '待機中');
});

test('同じ定義の Codex の実行が 2 回あっても、監査行はそれぞれの実行に付く', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  launchCodex(state, 'twice', 'bash-a', 1, null);
  launchCodex(state, 'twice', 'bash-b', 2, null);
  state.addEvent({
    session_id: 'twice', hook_event_name: 'PostToolUse', hookAt: 3, tool_name: 'Bash', tool_use_id: 'bash-b',
    codexAudit: { agent_id: 'impl-hard', model: 'gpt-b', effort: 'high' },
  });
  state.addEvent({
    session_id: 'twice', hook_event_name: 'PostToolUse', hookAt: 4, tool_name: 'Bash', tool_use_id: 'bash-a',
    codexAudit: { agent_id: 'impl-hard', model: 'gpt-a', effort: 'max' },
  });
  const models = Object.fromEntries(state.snapshot().sessions[0].agents.map((agent) => [agent.agent_id, agent.model]));
  assert.deepEqual(models, { 'codex:bash-a': 'gpt-a', 'codex:bash-b': 'gpt-b' });
});

test('完了した tool_use_id は、遅れて処理された PreToolUse で実行中に戻らない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'late', hook_event_name: 'PostToolUse', hookAt: 100, tool_name: 'Read', tool_use_id: 'read-1' });
  state.addEvent({ session_id: 'late', hook_event_name: 'PreToolUse', hookAt: 200, tool_name: 'Read', tool_use_id: 'read-1', summary: 'a.md' });
  assert.deepEqual(state.snapshot().sessions[0].tools, []);
});

test('背景の Codex は、呼び出し元が終わっても終了ではなく終了未確認になる', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  launchCodex(state, 'unconfirmed', 'bash-1', 1, null);
  state.addEvent({ session_id: 'unconfirmed', hook_event_name: 'PostToolUse', hookAt: 2, tool_name: 'Bash', tool_use_id: 'bash-1' });
  state.addEvent({ session_id: 'unconfirmed', hook_event_name: 'Stop', hookAt: 3 });
  const codex = state.snapshot().sessions[0].agents.find((agent) => agent.agent_id === 'codex:bash-1');
  assert.deepEqual([codex.active, codex.unconfirmed], [false, true]);
});

test('メインの Stop の後のサブエージェントの活動では、メインを作業中に戻さない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const status = () => state.snapshot().sessions[0].status;
  state.addEvent({ session_id: 'bg-agent', hook_event_name: 'SubagentStart', hookAt: 1, agent_id: 'sub-1', agent_type: 'Explore' });
  state.addEvent({ session_id: 'bg-agent', hook_event_name: 'Stop', hookAt: 2 });
  state.addEvent({ session_id: 'bg-agent', hook_event_name: 'PreToolUse', hookAt: 3, agent_id: 'sub-1', tool_name: 'Read', tool_use_id: 'r-1' });
  state.addEvent({ session_id: 'bg-agent', hook_event_name: 'PostToolUse', hookAt: 4, agent_id: 'sub-1', tool_name: 'Read', tool_use_id: 'r-1' });
  assert.equal(status(), '待機中(サブエージェント稼働中)');
  state.addEvent({ session_id: 'bg-agent', hook_event_name: 'SubagentStop', hookAt: 5, agent_id: 'sub-1' });
  assert.equal(status(), '待機中');
});

test('並列の Agent 呼び出しで対応が決まらないときは、resolvedModel を別のサブエージェントに付けない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'parallel', hook_event_name: 'PreToolUse', hookAt: 1, tool_name: 'Agent', tool_use_id: 'call-a' });
  state.addEvent({ session_id: 'parallel', hook_event_name: 'PreToolUse', hookAt: 2, tool_name: 'Agent', tool_use_id: 'call-b' });
  state.addEvent({ session_id: 'parallel', hook_event_name: 'SubagentStart', hookAt: 3, agent_id: 'agent-a', agent_type: 'Explore' });
  state.addEvent({ session_id: 'parallel', hook_event_name: 'SubagentStart', hookAt: 4, agent_id: 'agent-b', agent_type: 'Explore' });
  state.addEvent({ session_id: 'parallel', hook_event_name: 'PostToolUse', hookAt: 5, tool_name: 'Agent', tool_use_id: 'call-a', resolvedModel: 'model-a' });
  const models = state.snapshot().sessions[0].agents.map((agent) => agent.model);
  assert.ok(!models.includes('model-a'));
});

test('セッションファイルの題名が変わったら、一覧の題名も変わる', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  state.addEvent({ session_id: 'renamed', hook_event_name: 'SessionStart', hookAt: 1 });
  state.syncSessionFiles([{ session_id: 'renamed', cwd: '', name: '最初の名前' }]);
  state.syncSessionFiles([{ session_id: 'renamed', cwd: '', name: '変えた名前' }]);
  assert.equal(state.snapshot().sessions[0].title, '変えた名前');
});

test('開始が重なった Agent 呼び出しは、片方が先に終わっても後の SubagentStart に結び付けない', async (t) => {
  await temporaryHome(t);
  const state = new DashboardState();
  const add = (event) => state.addEvent({ session_id: 'overlap', ...event });
  add({ hook_event_name: 'PreToolUse', hookAt: 1, tool_name: 'Agent', tool_use_id: 'call-a' });
  add({ hook_event_name: 'PreToolUse', hookAt: 2, tool_name: 'Agent', tool_use_id: 'call-b' });
  add({ hook_event_name: 'PostToolUse', hookAt: 3, tool_name: 'Agent', tool_use_id: 'call-a', resolvedModel: 'model-a' });
  add({ hook_event_name: 'SubagentStart', hookAt: 4, agent_id: 'agent-a', agent_type: 'Explore' });
  add({ hook_event_name: 'SubagentStart', hookAt: 5, agent_id: 'agent-b', agent_type: 'Explore' });
  add({ hook_event_name: 'PostToolUse', hookAt: 6, tool_name: 'Agent', tool_use_id: 'call-b', resolvedModel: 'model-b' });
  const models = state.snapshot().sessions[0].agents.map((agent) => agent.model);
  assert.ok(!models.includes('model-a') && !models.includes('model-b'));
});
