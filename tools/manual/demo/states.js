'use strict';

// 作業行とサブエージェントの行の、基本のシナリオに無い状態を並べるシナリオ。
// 終了未確認、GPT が使えなかった行、経路の設定を変えた後の行、状態不明のセッションを含む。
module.exports = function states() {
  return {
    name: 'states',
    startMinutesAgo: 150,

    products: [
      { name: 'field-notes', branch: 'feature/export-pdf' },
    ],

    sessions: [
      { key: 'notes-main', id: 'demo-notes-main', product: 'field-notes', title: 'PDF の書き出し' },
      { key: 'notes-lost', id: 'demo-notes-lost', product: 'field-notes', title: 'ノートの検索' },
    ],

    claudeAgents: [
      { name: 'impl-hard', model: 'claude-opus-4-5', effort: 'high' },
      { name: 'impl-light', model: 'claude-haiku-4-5', effort: 'low' },
    ],
    gptAgents: [
      { name: 'impl-hard', model: 'gpt-5.5-codex', effort: 'high' },
      { name: 'impl-light', model: 'gpt-5.5-codex', effort: 'medium' },
    ],
    github: { repositories: {} },

    async play(demo) {
      const { at, hook, plan } = demo;
      const key = 'notes-main';
      const toolStart = (id, name, input, agent) => hook(key, {
        hook_event_name: 'PreToolUse', tool_name: name, tool_use_id: id, tool_input: input,
        ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}),
      });
      const toolEnd = (id, name, input, agent, response) => hook(key, {
        hook_event_name: 'PostToolUse', tool_name: name, tool_use_id: id, tool_input: input, tool_response: response ?? {},
        ...(agent ? { agent_id: agent.id, agent_type: agent.type } : {}),
      });
      const subagentStart = async (callId, description, agent, route) => {
        await toolStart(callId, 'Agent', { description });
        await hook(key, { hook_event_name: 'SubagentStart', agent_id: agent.id, agent_type: agent.type, route });
      };
      const codexLaunch = (id, agent) => toolStart(id, 'Bash', {
        command: `bash ~/.claude/tools/codex-agent.sh ${agent.type} --task-file task.md`,
      }, agent);
      const codexCommand = (agent) => ({ command: `bash ~/.claude/tools/codex-agent.sh ${agent.type} --task-file task.md` });
      const audit = (definition, runId, effort, result) => [
        `codex-agent: agent=${definition} model=gpt-5.5-codex effort=${effort}`,
        `codex-agent: run=${runId}`,
        ...(result ? [result] : []),
      ].join('\n');

      at(150);
      await hook(key, { hook_event_name: 'SessionStart', source: 'startup' });
      await hook(key, { hook_event_name: 'UserPromptSubmit' });

      at(140);
      await plan(key, {
        kind: 'tasks',
        tasks: [
          { title: 'PDF 変換ライブラリを選ぶ', state: 'done', criteria: [{ text: '日本語フォントが埋め込める', met: true }] },
          { title: '書き出しボタンを足す', state: 'doing', criteria: [{ text: 'ノートの画面から押せる', met: false }] },
          { title: '余白を設定できるようにする', state: 'todo', criteria: [{ text: '余白は 0〜30mm で指定できる', met: false }] },
        ],
      });

      // Codex を背景で動かしたまま、担当が終わった。Codex が終わったかどうかは分からない。
      at(45);
      const hardAgent = { id: 'agent-notes-hard', type: 'impl-hard' };
      await subagentStart('call-notes-hard', 'PDF 変換の本体を実装する', hardAgent, 'default');
      await codexLaunch('notes-hard-run', hardAgent);
      at(44);
      await toolEnd('notes-hard-run', 'Bash', codexCommand(hardAgent), hardAgent, audit('impl-hard', 'impl-hard-20261006-134500-3301', 'high'));
      at(30);
      await hook(key, { hook_event_name: 'SubagentStop', agent_id: hardAgent.id, agent_type: hardAgent.type });
      await toolEnd('call-notes-hard', 'Agent', { description: 'PDF 変換の本体を実装する' });

      // 経路の設定は「既定」のまま、Codex の経路で起動した担当。Codex が利用上限で使えなかった。
      at(12);
      const lightAgent = { id: 'agent-notes-light', type: 'impl-light' };
      await subagentStart('call-notes-light', '書き出しボタンの文言を直す', lightAgent, 'codex');
      await codexLaunch('notes-light-run', lightAgent);
      at(11);
      await toolEnd(
        'notes-light-run',
        'Bash',
        codexCommand(lightAgent),
        lightAgent,
        audit('impl-light', 'impl-light-20261006-141800-3377', 'medium', 'codex-agent: result=rate-limited exit=75'),
      );
      await toolStart('notes-light-edit', 'Edit', { file_path: 'src/components/ExportButton.tsx' }, lightAgent);

      at(2);
      await toolStart('notes-main-edit', 'Edit', { file_path: 'src/export/pdf.ts' });
    },
  };
};
