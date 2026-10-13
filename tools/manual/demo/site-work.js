'use strict';

const { siteHelpers } = require('./site-helpers');

const REPOSITORY = 'example-team/expense-app';
const pullRequestUrl = (number) => `https://github.com/${REPOSITORY}/pull/${number}`;

// 配布ページの 2 枚目。Claude Code と Codex のセッションがそれぞれタスクと完了条件を持って作業していて、
// Claude のメインセッションは、Claude で動く担当と Codex に委譲した担当のサブエージェントを並行して使っている。
module.exports = function siteWork({ baseTime }) {
  const iso = (minutesAgo) => new Date(baseTime - minutesAgo * 60_000).toISOString();

  return {
    name: 'site-work',
    startMinutesAgo: 180,

    products: [{
      name: 'expense-app',
      branch: 'feature/receipt-ocr',
      crossReview: { tool: true },
      worktrees: [{ name: 'approval-notify', branch: 'feature/approval-notify', crossReview: { tool: true } }],
    }],

    sessions: [
      { key: 'claude', id: 'demo-site-work-claude', product: 'expense-app', model: 'claude-opus-5-5', title: '領収書の読み取り' },
      {
        key: 'codex', id: '019a3b71-8e2c-7d14-a6f0-5c9e2b7d3a18', product: 'expense-app', worktree: 'approval-notify',
        provider: 'codex', model: 'gpt-6.1-sol', title: '承認待ちの通知',
      },
    ],

    claudeAgents: [{ name: 'impl-standard', model: 'claude-sonnet-5-5', effort: 'medium' }],
    gptAgents: [{ name: 'impl-standard', model: 'gpt-6-luna', effort: 'high' }],

    github: {
      repositories: {
        [REPOSITORY]: {
          defaultBranch: 'main',
          pullRequests: [{
            number: 83, title: '承認待ちの申請を Slack に通知する', head: 'feature/approval-notify', createdAt: iso(40),
            draft: true, checks: 'pending',
          }],
        },
      },
    },

    async play(demo) {
      const { at, hook, plan, prs } = demo;
      const { tool, toolStart, taskList, subagentStart, codexLaunch } = siteHelpers(demo);

      at(180);
      await demo.ui('/api/display', { mode: 'kind' });
      for (const key of ['claude', 'codex']) {
        await hook(key, { hook_event_name: 'SessionStart', source: 'startup' });
        await hook(key, { hook_event_name: 'UserPromptSubmit' });
      }

      at(175);
      await plan('claude', taskList(
        ['領収書の画像を取り込む', 'doing', ['JPEG と PNG と PDF を受け付ける', false], ['10MB を超える画像は縮小する', false]],
        ['金額と日付を読み取る', 'todo', ['税込と税抜を区別する', false], ['和暦の日付を西暦に直す', false], ['読み取れない項目は手入力に回す', false]],
        ['読み取り結果の確認画面を作る', 'todo', ['修正した値を保存できる', false]],
      ));
      at(172);
      await plan('codex', taskList(
        ['承認待ちの申請を Slack に通知する', 'doing', ['申請者と金額が通知に入る', false], ['差し戻しのときも通知する', false]],
        ['通知の設定画面を作る', 'todo', ['部署ごとに通知先を選べる', false]],
      ));

      at(90);
      await plan('claude', taskList(
        ['領収書の画像を取り込む', 'done', ['JPEG と PNG と PDF を受け付ける', true], ['10MB を超える画像は縮小する', true]],
        ['金額と日付を読み取る', 'doing', ['税込と税抜を区別する', true], ['和暦の日付を西暦に直す', false], ['読み取れない項目は手入力に回す', false]],
        ['読み取り結果の確認画面を作る', 'todo', ['修正した値を保存できる', false]],
      ));

      at(40);
      await plan('codex', taskList(
        ['承認待ちの申請を Slack に通知する', 'doing', ['申請者と金額が通知に入る', true], ['差し戻しのときも通知する', false]],
        ['通知の設定画面を作る', 'todo', ['部署ごとに通知先を選べる', false]],
      ));
      await prs('codex', { kind: 'add_pr', url: pullRequestUrl(83) });
      await demo.refreshPullRequests();

      at(16);
      const codexAgent = { id: 'agent-site-work-codex', type: 'impl-standard' };
      await subagentStart('claude', 'call-site-work-codex', 'OCR の結果を経費の項目に振り分ける', codexAgent);
      await codexLaunch('claude', 'site-work-codex-run', codexAgent, {
        model: 'gpt-6-luna', effort: 'high', runId: 'impl-standard-20261006-141400-5120',
      });

      at(11);
      const claudeAgent = { id: 'agent-site-work-claude', type: 'impl-standard' };
      await subagentStart('claude', 'call-site-work-claude', '和暦の変換のテストを書く', claudeAgent);
      at(9);
      await toolStart('claude', 'site-work-claude-read', 'Read', { file_path: 'src/receipt/era.ts' }, claudeAgent);

      // プロダクトの中は最後に動いたセッションが上に来るので、Claude のセッションを後に動かす。
      at(4);
      await toolStart('codex', 'codex-test-notify', 'Bash', { command: 'npm test -- notify' });

      at(2);
      await tool('claude', 'claude-read-parse', 'Read', { file_path: 'src/receipt/parse.ts' });
      at(1);
      await toolStart('claude', 'claude-edit-date', 'Edit', { file_path: 'src/receipt/parse-date.ts' });
    },
  };
};
