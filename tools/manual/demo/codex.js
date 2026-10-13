'use strict';

const { siteHelpers } = require('./site-helpers');

const PRODUCT = 'rota-board';
const REPOSITORY = `example-team/${PRODUCT}`;

// Claude と Codex のセッションが同じプロダクトで動き、同じ PR を両方が登録している。Codex は一度再開していて、
// 判断事項とサブエージェントを持つ。Codex の表示(再開の札、青紫の帯と強調、Codex のサブエージェントの行)を示す。
module.exports = function codex({ baseTime }) {
  const iso = (minutesAgo) => new Date(baseTime - minutesAgo * 60_000).toISOString();

  return {
    name: 'codex',
    startMinutesAgo: 150,

    products: [{ name: PRODUCT, branch: 'feature/shift-swap', crossReview: { tool: true } }],

    sessions: [
      { key: 'claude', id: 'demo-codex-claude', product: PRODUCT, model: 'claude-opus-5-5', title: '交代申請の画面' },
      {
        key: 'codex', id: '019a4d52-3b9e-7c41-8f07-2a6d5e1c9b83', product: PRODUCT,
        provider: 'codex', model: 'gpt-6.1-sol', title: '交代申請の承認ルール',
      },
    ],

    claudeAgents: [],
    gptAgents: [],

    github: {
      repositories: {
        [REPOSITORY]: {
          defaultBranch: 'main',
          pullRequests: [{
            number: 112, title: 'シフトの交代申請を承認者へ通知する', head: 'feature/shift-swap', createdAt: iso(140),
            checks: 'pass',
          }],
        },
      },
    },

    async play(demo) {
      const { at, hook, plan, prs } = demo;
      const { tool, toolStart, taskList } = siteHelpers(demo);
      const codexAgent = { id: 'agent-codex-explorer', type: 'explorer', model: 'gpt-6-luna' };

      at(150);
      for (const key of ['claude', 'codex']) {
        await hook(key, { hook_event_name: 'SessionStart', source: 'startup' });
        await hook(key, { hook_event_name: 'UserPromptSubmit' });
      }

      at(146);
      await plan('claude', taskList(
        ['交代申請の画面を作る', 'doing', ['申請と承認の状態を一覧で見られる', false], ['承認者には未処理の申請だけを出す', false]],
        ['交代の確定処理を作る', 'todo', ['承認された交代を勤務表に反映する', false]],
      ));
      at(144);
      await plan('codex', taskList(
        ['交代申請の承認ルールを決める', 'doing', ['承認者の条件を一つに決める', false], ['期限切れの申請を自動で取り下げる', false]],
        ['承認ルールの移行を書く', 'todo', ['既存の申請を新しいルールに移せる', false]],
      ));

      // 同じ PR を Claude と Codex の両方が登録する。PR の行の色帯は、上半分が Claude、下半分が Codex になる。
      at(140);
      await prs('claude', { kind: 'add_pr', url: `https://github.com/${REPOSITORY}/pull/112` });
      await prs('codex', { kind: 'add_pr', url: `https://github.com/${REPOSITORY}/pull/112` });
      await demo.refreshPullRequests();

      // Codex は一度止まって、同じ会話を再開する。再開の数が 1 増え、メインの行に「再開 1 回」が出る。
      at(130);
      await hook('codex', { hook_event_name: 'Stop' });
      at(120);
      await hook('codex', { hook_event_name: 'SessionStart', source: 'resume' });
      await hook('codex', { hook_event_name: 'UserPromptSubmit' });

      at(100);
      await plan('codex', {
        kind: 'add_decision',
        title: '承認者が不在のときの扱い',
        context: '承認者が休暇中だと、申請が止まったまま期限を過ぎる。',
        state: 'waiting',
        options: [
          { label: '代わりの承認者へ回す', description: '勤務表の上の役職を順にたどる', recommended: true },
          { label: '申請を取り下げる', description: '申請者が出し直す' },
          { label: '期限まで待つ', description: '承認されないまま期限が来たら取り下げる' },
        ],
      });

      // Codex が自分で起動したサブエージェントは、Codex の出来事として届き、モデルの札は Codex のモデル名になる。
      at(40);
      // サブエージェントの出来事には子のモデルを載せる。載せないと、親のモデルで上書きされる。
      await hook('codex', {
        hook_event_name: 'SubagentStart', agent_id: codexAgent.id, agent_type: codexAgent.type, model: codexAgent.model,
      });
      await hook('codex', {
        hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'codex-explorer-grep',
        tool_input: { command: 'rg -n "approver" src/shift' }, agent_id: codexAgent.id, agent_type: codexAgent.type, model: codexAgent.model,
      });

      at(4);
      await toolStart('codex', 'codex-run-swap', 'Bash', { command: 'npm test -- shift-swap' });

      at(2);
      await tool('claude', 'claude-read-form', 'Read', { file_path: 'src/shift/swap-form.tsx' });
      at(1);
      await toolStart('claude', 'claude-edit-form', 'Edit', { file_path: 'src/shift/swap-form.tsx' });
    },
  };
};
