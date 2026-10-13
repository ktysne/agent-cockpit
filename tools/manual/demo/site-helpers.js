'use strict';

// 配布ページ用のシナリオが共通で使う、フックと MCP の入力を組み立てる補助。
function siteHelpers(demo) {
  const { hook } = demo;
  const agentFields = (agent) => (agent ? { agent_id: agent.id, agent_type: agent.type } : {});
  const toolStart = (key, id, name, input, agent) => hook(key, {
    hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: id, tool_input: input, ...agentFields(agent),
  });
  const toolEnd = (key, id, name, input, agent, response) => hook(key, {
    hook_event_name: 'PostToolUse', tool_name: name, tool_use_id: id, tool_input: input, tool_response: response ?? {}, ...agentFields(agent),
  });
  return {
    toolStart,
    toolEnd,
    async tool(key, id, name, input, agent) {
      await toolStart(key, id, name, input, agent);
      await toolEnd(key, id, name, input, agent);
    },
    /** [題, 状態, [完了条件, 満たした], ...] の並びから cockpit_set_tasks の本文を作る。 */
    taskList: (...tasks) => ({
      kind: 'tasks',
      tasks: tasks.map(([title, state, ...criteria]) => ({ title, state, criteria: criteria.map(([text, met]) => ({ text, met })) })),
    }),
    async subagentStart(key, callId, description, agent, route = 'default') {
      await toolStart(key, callId, 'Agent', { description });
      await hook(key, { hook_event_name: 'SubagentStart', agent_id: agent.id, agent_type: agent.type, route });
    },
    /** Claude のサブエージェントが codex-agent.sh で Codex を起動し、run の行まで受け取った状態にする。 */
    async codexLaunch(key, id, agent, { model, effort, runId }) {
      const input = { command: `bash ~/.claude/tools/codex-agent.sh ${agent.type} --task-file task.md` };
      await toolStart(key, id, 'Bash', input, agent);
      await toolEnd(key, id, 'Bash', input, agent, [
        `codex-agent: agent=${agent.type} model=${model} effort=${effort}`,
        `codex-agent: run=${runId}`,
      ].join('\n'));
    },
    /** 画面が持つ PR のマージ用の鍵を、状態の中から番号で探す。 */
    async mergeRecordKeyOf(number) {
      const found = [];
      const visit = (value) => {
        if (!value || typeof value !== 'object') return;
        if (value.number === number && typeof value.mergeRecordKey === 'string') found.push(value);
        for (const child of Object.values(value)) visit(child);
      };
      visit(await demo.getState());
      if (!found.length) throw new Error(`#${number} のマージ用の鍵が状態にありません`);
      return found[0];
    },
  };
}

module.exports = { siteHelpers };
