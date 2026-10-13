'use strict';

const { sha } = require('../fake-gh');
const { siteHelpers } = require('./site-helpers');

const REPOSITORY = 'example-team/room-booking';
const headOf = (number) => sha(`${REPOSITORY}#${number}`);
const pullRequestUrl = (number) => `https://github.com/${REPOSITORY}/pull/${number}`;

// 配布ページの 1 枚目。Claude Code と Codex が同じプロダクトで動き、判断事項が選択肢つきで待っていて、
// 積み上げた 2 段の PR のうち、下の段はクロスレビュー中で、上の段はレビューを終えて下の段のマージを待っている。
module.exports = function siteReview({ baseTime }) {
  const iso = (minutesAgo) => new Date(baseTime - minutesAgo * 60_000).toISOString();

  return {
    name: 'site-review',
    startMinutesAgo: 240,

    products: [{
      name: 'room-booking',
      branch: 'feature/alt-room-suggest',
      crossReview: {
        tool: true,
        state: {
          'feature/booking-conflict': {
            round: 2, dismissed: ['エラー文言の言い回し'], lastReviewedSha: headOf(57), lastTriage: { round: 1, sha: headOf(57), outcome: 'fixing' },
          },
          'feature/alt-room-suggest': {
            round: 1, dismissed: [], lastReviewedSha: headOf(58), lastTriage: { round: 1, sha: headOf(58), outcome: 'converged' },
          },
        },
      },
      worktrees: [{ name: 'calendar-export', branch: 'feature/calendar-export', crossReview: { tool: true } }],
    }],

    sessions: [
      { key: 'claude', id: 'demo-site-review-claude', product: 'room-booking', model: 'claude-opus-5-5', title: '空き部屋の提案' },
      {
        key: 'codex', id: '019a2f6e-4c1d-7b80-9e53-2d8f1a6c0b47', product: 'room-booking', worktree: 'calendar-export',
        provider: 'codex', model: 'gpt-6.1-sol', title: '予約を iCal で書き出す',
      },
    ],

    claudeAgents: [{ name: 'impl-standard', model: 'claude-sonnet-5-5', effort: 'medium' }],
    gptAgents: [{ name: 'impl-standard', model: 'gpt-6-luna', effort: 'high' }],

    github: {
      repositories: {
        [REPOSITORY]: {
          defaultBranch: 'main',
          pullRequests: [
            {
              number: 57, title: '予約の重複を検出する', head: 'feature/booking-conflict', createdAt: iso(230),
              checks: 'pass', reviewDecision: 'APPROVED',
            },
            {
              number: 58, title: '空いている会議室を候補として提案する', head: 'feature/alt-room-suggest', base: 'feature/booking-conflict',
              createdAt: iso(150), checks: 'pass',
            },
          ],
        },
      },
    },

    async play(demo) {
      const { at, hook, plan, prs } = demo;
      const { tool, toolStart, taskList } = siteHelpers(demo);

      at(240);
      await demo.ui('/api/display', { mode: 'kind' });
      for (const key of ['claude', 'codex']) {
        await hook(key, { hook_event_name: 'SessionStart', source: 'startup' });
        await hook(key, { hook_event_name: 'UserPromptSubmit' });
      }

      at(235);
      await plan('claude', taskList(
        ['予約の重複を検出する', 'doing', ['同じ部屋と時間帯の予約を保存できない', false], ['重複の理由を画面に出す', false]],
        ['空いている会議室を提案する', 'todo', ['同じ時間帯の空き部屋を 5 件まで出す', false], ['提案から 1 クリックで予約できる', false]],
      ));
      at(232);
      await plan('codex', taskList(
        ['予約を iCal 形式で書き出す', 'doing', ['Outlook と Google カレンダーで読み込める', false], ['繰り返しの予約を RRULE で表す', false]],
        ['書き出しのボタンを足す', 'todo', ['予約の詳細画面から押せる', false]],
      ));

      at(228);
      await prs('claude', { kind: 'add_pr', url: pullRequestUrl(57) });
      await demo.refreshPullRequests();

      at(150);
      await plan('claude', taskList(
        ['予約の重複を検出する', 'done', ['同じ部屋と時間帯の予約を保存できない', true], ['重複の理由を画面に出す', true]],
        ['空いている会議室を提案する', 'doing', ['同じ時間帯の空き部屋を 5 件まで出す', true], ['提案から 1 クリックで予約できる', false]],
        ['提案の範囲を決める', 'todo', ['空き部屋が無いときの扱いを決める', false]],
      ));
      await prs('claude', { kind: 'add_pr', url: pullRequestUrl(58) });
      await demo.refreshPullRequests();

      at(30);
      await plan('codex', taskList(
        ['予約を iCal 形式で書き出す', 'doing', ['Outlook と Google カレンダーで読み込める', true], ['繰り返しの予約を RRULE で表す', false]],
        ['書き出しのボタンを足す', 'todo', ['予約の詳細画面から押せる', false]],
      ));

      // プロダクトの中は最後に動いたセッションが上に来るので、判断を待つ Claude のセッションを後に動かす。
      at(9);
      await toolStart('codex', 'codex-edit-rrule', 'Edit', { file_path: 'src/export/ical/rrule.ts' });

      at(6);
      await tool('claude', 'claude-read-rooms', 'Read', { file_path: 'src/rooms/availability.ts' });
      await plan('claude', {
        kind: 'add_decision',
        title: '希望の時間帯に空き部屋が無いときの提案の範囲',
        context: '昼前と夕方は全フロアが埋まりやすい。候補を広げるほど見つかりやすいが、一覧が長くなり移動も増える。',
        state: 'waiting',
        options: [
          { label: '同じフロアで前後 1 時間', description: '候補は 5 件以内に収まり、移動も少ない', recommended: true },
          { label: '全フロアで同じ時間帯', description: '時間は変わらないが、別のフロアへ移動する' },
          { label: '両方を並べて出す', description: '見つかりやすいが、一覧が長くなる' },
        ],
      });
      await hook('claude', { hook_event_name: 'Stop' });
    },
  };
};
