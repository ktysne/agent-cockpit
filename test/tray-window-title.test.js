const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tray = fs.readFileSync(path.join(__dirname, '../src/tray/tray.ps1'), 'utf8');

function dashboardTitlePattern() {
  const match = /Regex\.IsMatch\(title\.ToString\(\), "([^"]*)" \+ Regex\.Escape\(titleSuffix\) \+ "([^"]*)"\)/.exec(tray);
  assert.ok(match, 'トレイのタイトル照合が見つからない');
  const unescape = (literal) => literal.replace(/\\\\/g, '\\');
  return new RegExp(`${unescape(match[1])}Agent Cockpit${unescape(match[2])}`);
}

test('トレイは件数とバージョンの付いた画面のタイトルをダッシュボードとして見つける', () => {
  const pattern = dashboardTitlePattern();
  for (const title of ['Agent Cockpit', '(3) Agent Cockpit', 'Agent Cockpit v1.0.0', '(12) Agent Cockpit v1.10.3']) {
    assert.match(title, pattern);
  }
  for (const title of ['Agent Cockpit v1', 'Agent Cockpit マニュアル', 'Other Agent Cockpit']) {
    assert.doesNotMatch(title, pattern);
  }
});
