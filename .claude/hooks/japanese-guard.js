// 開発者に見える文を日本語に保つためのフック。依存が無いので、他のリポジトリへはこのファイルをそのまま写す。
// 写し方と、グローバル版との重複を避ける仕組みは docs/japanese-guard.md にある。
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const REMINDER = '開発者に見える文(途中経過、ツールの合間の一言、英語の通知への返答を含む)は日本語で書く。';
const COMPACT_REMINDER = '会話を圧縮した直後である。上の要約が英語でも、開発者に見える文(途中経過、ツールの合間の一言、割り込みの通知への返答を含む)はすべて日本語で書く。';
const REWRITE_REASON = '最後の返答が英語で書かれている。同じ内容を日本語で書き直す。コード、コマンド、識別子は元のままでよい。';
const GLOBAL_GUARD_SCRIPTS = ['japanese-guard.js', 'compact-language.js'];

function globalSettingsPath(environment = process.env) {
  const claudeHome = environment.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  return path.join(claudeHome, 'settings.json');
}

// ユーザー設定でグローバル版を登録しているイベントの一覧。読めないときは空にし、重複より無効化を避ける。
function globalGuardEvents(settingsText) {
  const events = new Set();
  let hooks;
  try {
    hooks = JSON.parse(settingsText).hooks || {};
  } catch {
    return events;
  }
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of Array.isArray(groups) ? groups : []) {
      for (const hook of Array.isArray(group && group.hooks) ? group.hooks : []) {
        const commandLine = [hook.command, ...(Array.isArray(hook.args) ? hook.args : [])].join(' ').replace(/\\/g, '/');
        if (GLOBAL_GUARD_SCRIPTS.some((script) => commandLine.includes(`/${script}`))) events.add(event);
      }
    }
  }
  return events;
}

function readGlobalGuardEvents(environment = process.env) {
  try {
    return globalGuardEvents(fs.readFileSync(globalSettingsPath(environment), 'utf8'));
  } catch {
    return new Set();
  }
}

function proseOf(text) {
  return String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[A-Za-z]:[\\/][^\s)]*/g, ' ')
    .replace(/(?:\.{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+/g, ' ');
}

// 英語の単語が十分にあり、日本語の文字がその 4 分の 1 に満たないときを英語とみなす。
function isMostlyEnglish(text) {
  const prose = proseOf(text);
  const japanese = (prose.match(/[぀-ヿ㐀-鿿]/g) || []).length;
  const latin = (prose.match(/[A-Za-z]/g) || []).length;
  return latin >= 40 && japanese * 4 < latin;
}

function context(event, text) {
  return { hookSpecificOutput: { hookEventName: event, additionalContext: text } };
}

function output(input, { globalEvents = new Set() } = {}) {
  const event = input.hook_event_name;
  if (globalEvents.has(event)) return null;
  if (event === 'UserPromptSubmit' || event === 'PostToolBatch') return context(event, REMINDER);
  if (event === 'SessionStart' && input.source === 'compact') return context(event, COMPACT_REMINDER);
  // stop_hook_active は書き直しの後のターンを表す。ここで止めると書き直しが終わらなくなる。
  if (event === 'Stop' && !input.stop_hook_active && isMostlyEnglish(input.last_assistant_message)) {
    return { decision: 'block', reason: REWRITE_REASON };
  }
  return null;
}

if (require.main === module) {
  let raw = '';
  process.stdin.on('data', (chunk) => { raw += chunk; });
  process.stdin.on('end', () => {
    try {
      const result = output(JSON.parse(raw || '{}'), { globalEvents: readGlobalGuardEvents() });
      if (result) process.stdout.write(JSON.stringify(result));
    } catch {
      // 入力が読めないときは何もしない。セッションを止めないため。
    }
  });
}

module.exports = { globalGuardEvents, globalSettingsPath, isMostlyEnglish, output };
