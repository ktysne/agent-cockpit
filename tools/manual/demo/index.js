'use strict';

const scenarios = Object.freeze({
  basic: () => require('./basic'),
  codex: () => require('./codex'),
  decisions: () => require('./decisions'),
  empty: () => require('./empty'),
  'no-gh': () => require('./no-gh'),
  'site-review': () => require('./site-review'),
  'site-work': () => require('./site-work'),
  states: () => require('./states'),
});

function scenarioNames() {
  return Object.keys(scenarios);
}

// シナリオは基準時刻を受け取り、プロダクト、セッション、GitHub の応答、流し込みの手順を返す関数である。
function loadScenario(name, context) {
  if (!Object.hasOwn(scenarios, name)) throw new Error(`シナリオがありません: ${name}`);
  return scenarios[name]()(context);
}

module.exports = { loadScenario, scenarioNames };
