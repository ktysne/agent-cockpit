const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { globalGuardEvents, globalSettingsPath, isMostlyEnglish, output } = require('../.claude/hooks/japanese-guard');

const SCRIPT = path.join(__dirname, '..', '.claude', 'hooks', 'japanese-guard.js');
const ENGLISH = 'The build finished and all of the tests passed without any failures.';

function settingsWith(hooks) {
  return JSON.stringify({ hooks });
}

function hookGroup(command, args) {
  return [{ hooks: [{ type: 'command', command, args }] }];
}

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

test('グローバル版が登録されたイベントだけ何も出さない', () => {
  const globalEvents = new Set(['Stop']);
  assert.equal(output({ hook_event_name: 'Stop', last_assistant_message: ENGLISH }, { globalEvents }), null);
  assert.match(output({ hook_event_name: 'UserPromptSubmit' }, { globalEvents }).hookSpecificOutput.additionalContext, /日本語で書く/);
});

test('グローバル版の登録は exec 形式とシェル形式のどちらでも見つける', () => {
  const events = globalGuardEvents(settingsWith({
    Stop: hookGroup('D:/Program Files/nodejs/node.exe', ['C:\\Users\\me\\.claude\\hooks\\japanese-guard.js']),
    UserPromptSubmit: hookGroup('node ~/.claude/hooks/japanese-guard.js'),
    SessionStart: hookGroup('node', ['/home/me/.claude/hooks/compact-language.js']),
    PostToolBatch: hookGroup('node', ['/home/me/.claude/hooks/other.js']),
  }));
  assert.deepEqual([...events].sort(), ['SessionStart', 'Stop', 'UserPromptSubmit']);
});

test('SessionStart は matcher が compact に当たる登録だけをグローバル版として数える', () => {
  const script = '/home/me/.claude/hooks/compact-language.js';
  const sessionStart = (matcher) => [{ matcher, hooks: [{ type: 'command', command: 'node', args: [script] }] }];
  for (const matcher of [undefined, '', '*', 'compact', 'startup|compact', 'startup, compact', 'compact | startup', 'comp.*']) {
    assert.equal(globalGuardEvents(settingsWith({ SessionStart: sessionStart(matcher) })).has('SessionStart'), true, String(matcher));
  }
  for (const matcher of ['startup', 'resume|clear', 'resume, clear', 'compactor', '(']) {
    assert.equal(globalGuardEvents(settingsWith({ SessionStart: sessionStart(matcher) })).has('SessionStart'), false, matcher);
  }
});

test('グローバル版のスクリプトが本来出力しないイベントの登録は数えない', () => {
  const events = globalGuardEvents(settingsWith({
    SessionStart: hookGroup('node', ['/home/me/.claude/hooks/japanese-guard.js']),
    Stop: hookGroup('node', ['/home/me/.claude/hooks/compact-language.js']),
  }));
  assert.equal(events.size, 0);
});

test('ユーザー設定に書いたリポジトリ版の登録はグローバル版として数えない', () => {
  const events = globalGuardEvents(settingsWith({
    Stop: hookGroup('node', ['${CLAUDE_PROJECT_DIR}/.claude/hooks/japanese-guard.js']),
  }));
  assert.equal(events.size, 0);
});

test('ユーザー設定が無いか壊れているときは、グローバル版が無いものとして扱う', () => {
  assert.equal(globalGuardEvents('{').size, 0);
  assert.equal(globalGuardEvents(settingsWith({ Stop: 'not-an-array' })).size, 0);
  assert.equal(globalGuardEvents('{}').size, 0);
});

test('ユーザー設定の場所は CLAUDE_CONFIG_DIR を優先する', () => {
  assert.equal(globalSettingsPath({ CLAUDE_CONFIG_DIR: path.join('x', 'home') }), path.join('x', 'home', 'settings.json'));
  assert.equal(globalSettingsPath({}), path.join(os.homedir(), '.claude', 'settings.json'));
});

test('スクリプトとして起動すると、グローバル版の登録の有無で出力を切り替える', (t) => {
  const claudeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-cockpit-japanese-guard-'));
  t.after(() => fs.rmSync(claudeHome, { recursive: true, force: true }));
  fs.mkdirSync(path.join(claudeHome, 'hooks'));
  fs.writeFileSync(path.join(claudeHome, 'hooks', 'japanese-guard.js'), '');
  const run = () => spawnSync(process.execPath, [SCRIPT], {
    input: JSON.stringify({ hook_event_name: 'Stop', last_assistant_message: ENGLISH }),
    env: { ...process.env, CLAUDE_CONFIG_DIR: claudeHome },
    encoding: 'utf8',
  });

  const unregistered = run();
  if (unregistered.error && unregistered.error.code === 'EPERM') {
    t.skip('子プロセスを起動できないため未確認');
    return;
  }
  assert.ifError(unregistered.error);
  assert.equal(unregistered.status, 0);
  assert.equal(JSON.parse(unregistered.stdout).decision, 'block');

  fs.writeFileSync(path.join(claudeHome, 'settings.json'), settingsWith({
    Stop: hookGroup('node', [path.join(claudeHome, 'hooks', 'japanese-guard.js')]),
  }));
  const registered = run();
  assert.ifError(registered.error);
  assert.equal(registered.status, 0);
  assert.equal(registered.stdout, '');
});
