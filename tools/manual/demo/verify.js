'use strict';

const verifyOptions = [
  {
    label: '確認した。コミットして PR を作る',
    description: '確認した内容を記録し、作業を続けます。',
    recommended: true,
    next: 'セッションがコミットして PR を作ると、PR の欄にクロスレビューとマージの段が出ます。',
  },
  {
    label: '直してほしい点がある',
    description: '表示が違うところや直してほしい内容を伝えます。',
    recommended: false,
    next: 'セッションが直したあと、このカードがもう一度届きます。',
  },
];

const verifySteps = [
  { cmd: 'npm test', note: '週の切り替えと祝日表示のテストを実行します。' },
  { cmd: 'npm run dev', note: 'ブラウザーで週表示と予約枠の位置を確認します。' },
];

function decision(title, context) {
  return {
    kind: 'add_decision',
    title,
    context,
    state: 'waiting',
    options: verifyOptions,
    verify: { steps: verifySteps },
  };
}

module.exports = function verifyScenario() {
  return {
    name: 'verify',
    startMinutesAgo: 24,

    products: [{
      name: 'shift-planner',
      branch: 'main',
      worktrees: [{
        name: 'calendar-preview',
        branch: 'feature/calendar-preview',
        gitWorktree: true,
        commits: [
          { files: { 'src/calendar.js': 'export function calendarWeek() { return "week"; }\n' } },
          { files: { 'src/holidays.js': 'export function holidayLabel(date) { return date.toISOString().slice(0, 10); }\n' } },
        ],
        uncommittedFiles: ['src/calendar-preview.css'],
      }],
    }],

    sessions: [{
      key: 'calendar-preview',
      id: 'demo-calendar-preview',
      product: 'shift-planner',
      worktree: 'calendar-preview',
      title: 'カレンダーの週表示',
    }],

    claudeAgents: [],
    gptAgents: [],
    github: { repositories: {} },

    async play(demo) {
      const { at, hook, plan, ui } = demo;
      const key = 'calendar-preview';
      const sessionId = demo.sessions.get(key).id;

      at(24);
      await hook(key, { hook_event_name: 'SessionStart', source: 'startup' });
      await hook(key, { hook_event_name: 'UserPromptSubmit' });

      at(18);
      const launched = await plan(key, decision(
        '起動後の表示を確認してください',
        'ローカル画面を開き、週の切り替えと予約枠を確認してください。',
      ));
      at(17);
      await ui('/api/verify/launch', { session_id: sessionId, decision_id: launched.decision.id });
      at(16);
      await plan(key, { kind: 'report_launch', id: launched.decision.id, url: 'http://localhost:5173/' });

      at(14);
      const pending = await plan(key, decision(
        '起動を依頼した画面を確認してください',
        '確認用アプリが起動したら、週表示と予約枠を確かめてください。',
      ));
      at(13);
      await ui('/api/verify/launch', { session_id: sessionId, decision_id: pending.decision.id });

      at(11);
      await plan(key, decision(
        '変更後の表示を確認してください',
        '祝日の表示を含め、週の切り替えと予約枠の位置を確認してください。',
      ));
    },
  };
};
