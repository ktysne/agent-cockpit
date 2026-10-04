'use strict';

// セッションが 1 つも無いダッシュボードを見せるシナリオ。
module.exports = function empty() {
  return {
    name: 'empty',
    startMinutesAgo: 30,
    products: [],
    sessions: [],
    claudeAgents: [],
    gptAgents: [],
    github: { repositories: {} },
    async play() {},
  };
};
