'use strict';

// GitHub CLI を実行できない環境の PR の欄を見せるシナリオ。登録した PR はあるが、GitHub から取得できない。
module.exports = function noGh() {
  return {
    name: 'no-gh',
    startMinutesAgo: 30,

    products: [
      { name: 'parcel-api', branch: 'feature/slots-lock' },
    ],

    sessions: [
      { key: 'parcel-main', id: 'demo-parcel-main', product: 'parcel-api', title: '配送枠の排他制御' },
    ],

    claudeAgents: [],
    gptAgents: [],
    github: { unavailable: 'ENOENT', repositories: {} },

    async play(demo) {
      const { at, hook, prs } = demo;
      const key = 'parcel-main';

      at(30);
      await hook(key, { hook_event_name: 'SessionStart', source: 'startup' });
      await hook(key, { hook_event_name: 'UserPromptSubmit' });

      at(10);
      await prs(key, { kind: 'add_pr', url: 'https://github.com/example-team/parcel-api/pull/42' });
      await demo.refreshPullRequests();
    },
  };
};
