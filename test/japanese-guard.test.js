const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { globalGuardPath, isMostlyEnglish, output } = require('../.claude/hooks/japanese-guard');

const SCRIPT = path.join(__dirname, '..', '.claude', 'hooks', 'japanese-guard.js');
const ENGLISH = 'The build finished and all of the tests passed without any failures.';

test('UserPromptSubmit と PostToolBatch では日本語で書く決まりを差し込む', () => {
  for (const event of ['UserPromptSubmit', 'PostToolBatch']) {
    assert.equal(output({ hook_event_name: event }).hookSpecificOutput.hookEventName, event);
    assert.match(output({ hook_event_name: event }).hookSpecificOutput.additionalContext, /日本語で書く/);
  }
});

test('SessionStart は圧縮の直後だけ決まりを差し込む', () => {
  assert.match(output({ hook_event_name: 'SessionStart', source: 'compact' }).hookSpecificOutput.additionalContext, /圧縮/);
  assert.equal(output({ hook_event_name: 'SessionStart', source: 'startup' }), null);
});

test('Stop は英語の返答を一度だけ書き直させる', () => {
  assert.equal(output({ hook_event_name: 'Stop', last_assistant_message: ENGLISH }).decision, 'block');
  assert.equal(output({ hook_event_name: 'Stop', last_assistant_message: ENGLISH, stop_hook_active: true }), null);
  assert.equal(output({ hook_event_name: 'Stop', last_assistant_message: 'テストはすべて通りました。' }), null);
});

test('コードブロック、インラインコード、URL、パスは英語の判定から外す', () => {
  const text = '確認しました。\n```js\nconst value = computeSomethingVeryLongForTheTest();\n```\n`npm run test:inprocess` と https://example.com/some/long/path/for/test を見ました。';
  assert.equal(isMostlyEnglish(text), false);
  assert.equal(isMostlyEnglish('Done.'), false);
  assert.equal(isMostlyEnglish(ENGLISH), true);
});

test('グローバル版があるときはどのイベントでも何も出さない', () => {
  for (const input of [
    { hook_event_name: 'UserPromptSubmit' },
    { hook_event_name: 'SessionStart', source: 'compact' },
    { hook_event_name: 'Stop', last_assistant_message: ENGLISH },
  ]) {
    assert.equal(output(input, { hasGlobalGuard: true }), null);
  }
});

test('グローバル版の場所は CLAUDE_CONFIG_DIR を優先する', () => {
  assert.equal(globalGuardPath({ CLAUDE_CONFIG_DIR: path.join('x', 'home') }), path.join('x', 'home', 'hooks', 'japanese-guard.js'));
  assert.equal(globalGuardPath({}), path.join(os.homedir(), '.claude', 'hooks', 'japanese-guard.js'));
});

test('スクリプトとして起動すると、グローバル版の有無で出力を切り替える', (t) => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-japanese-guard-'));
  t.after(() => fs.rmSync(claudeHome, { recursive: true, force: true }));
  const run = () => spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: ENGLISH }),
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome },
    encoding: 'utf8',
  });

  assert.equal(JSON.parse(run().stdout).decision, 'block');
  fs.mkdirSync(path.join(claudeHome, 'hooks'));
  fs.writeFileSync(path.join(claudeHome, 'hooks', 'japanese-guard.js'), '');
  assert.equal(run().stdout, '');
});
