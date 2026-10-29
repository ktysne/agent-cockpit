'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const { buildStackHistory } = require('./stack-history');

const REPOSITORY = 'ktysne/rec-studio';
const pullRequestUrl = (number) => `https://github.com/${REPOSITORY}/pull/${number}`;

// 一覧と一括マージの確認欄を、モックの鎖と同じ状態で撮るためのシナリオ。
// 中段は収束の後に base を競合なしで取り込み、上段は収束の後の取り込みで競合を解消した状態にする。
// 履歴は play で本物の git コミットとして作り、PR の head と収束の SHA を履歴に合わせる。
module.exports = function stackMerge({ baseTime }) {
  const iso = (minutesAgo) => new Date(baseTime - minutesAgo * 60_000).toISOString();

  return {
    name: 'stack-merge',
    startMinutesAgo: 180,

    products: [{ name: 'rec-studio', branch: 'main', crossReview: { tool: true } }],

    sessions: [
      { key: 'claude', id: 'demo-stack-merge-claude', product: 'rec-studio', model: 'claude-opus-5-5', title: '拍子変更の反映' },
    ],

    github: {
      repositories: {
        [REPOSITORY]: {
          defaultBranch: 'main',
          autoDeleteBranch: true,
          mergeMethods: ['squash', 'merge'],
          pullRequests: [
            {
              number: 146, title: '拍子変更のデータ構造を分離する', head: 'refactor/meter-model', createdAt: iso(170),
              checks: 'pass', reviewDecision: 'APPROVED',
            },
            {
              number: 147, title: '拍子変更を譜面の描画へ反映する', head: 'feat/meter-render', base: 'refactor/meter-model', createdAt: iso(120),
              checks: 'pass', reviewDecision: 'APPROVED',
            },
            {
              number: 148, title: '拍子記号の入力欄を追加する', head: 'feat/meter-input', base: 'feat/meter-render', createdAt: iso(60),
              checks: 'pass', reviewDecision: 'APPROVED',
            },
          ],
        },
      },
    },

    async play(demo) {
      const { at, hook, prs, gh, sessions, refreshPullRequests } = demo;
      const { cwd } = sessions.get('claude');

      // git の設定はデモ用の空のファイルに向け、利用者の設定でコミットや競合の結果が変わらないようにする。
      const configPath = path.join(path.dirname(cwd), 'stack-history.gitconfig');
      await fs.writeFile(configPath, '');
      const history = await buildStackHistory(cwd, { remoteUrl: `https://github.com/${REPOSITORY}.git`, configPath });

      const branchState = (sha, round) => ({ round, dismissed: [], lastReviewedSha: sha, lastTriage: { round, sha, outcome: 'converged' } });
      await fs.writeFile(path.join(cwd, '.cross-review-state.json'), `${JSON.stringify({
        branches: {
          'refactor/meter-model': branchState(history.refactorHead, 2),
          'feat/meter-render': branchState(history.renderConverged, 1),
          'feat/meter-input': branchState(history.inputConverged, 2),
        },
      }, null, 2)}\n`);

      // 偽の gh は PR の head を定義から返す。履歴の SHA を入れてから取得させる。
      const repository = gh.repository(REPOSITORY);
      for (const [head, sha] of [
        ['refactor/meter-model', history.refactorHead],
        ['feat/meter-render', history.renderHead],
        ['feat/meter-input', history.inputHead],
      ]) {
        const pullRequest = repository.pullRequests.find((item) => item.head === head);
        pullRequest.headRefOid = sha;
        repository.branchHeads.set(head, sha);
      }

      at(170);
      await hook('claude', { hook_event_name: 'SessionStart', source: 'startup' });
      await hook('claude', { hook_event_name: 'UserPromptSubmit' });
      for (const number of [146, 147, 148]) {
        await prs('claude', { kind: 'add_pr', url: pullRequestUrl(number) });
      }
      await refreshPullRequests();
    },
  };
};
