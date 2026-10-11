// 検証用のフックを、その起動だけに渡して Codex を起動する。~/.codex は書き換えない。
// 使い方と守ること: docs/development.md「Codex の実機検証」
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'Stop',
  'Interrupt', 'SessionEnd', 'SubagentStart', 'SubagentStop'];
const HOOK_TIMEOUT_SECONDS = 120;
// Interrupt のフックは 1〜3 秒までしか待たれない。
const INTERRUPT_TIMEOUT_SECONDS = 3;
const EXEC_FLAGS = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only'];

function usage() {
  return 'node tools/codex-probe/launch.js [--exec] [--out <dir>] [--hook <Event>=<script.js>]... -- <prompt>';
}

function parseArguments(argv) {
  const options = { exec: false, out: path.join(__dirname, 'out'), hooks: [], prompt: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--') { options.prompt = argv.slice(index + 1).join(' '); break; }
    if (arg === '--exec') options.exec = true;
    else if (arg === '--out') options.out = path.resolve(argv[++index]);
    else if (arg === '--hook') {
      const [event, script] = String(argv[++index]).split(/=(.*)/s);
      if (!event || !script) throw new Error(usage());
      options.hooks.push({ event, script: path.resolve(script) });
    } else throw new Error(usage());
  }
  if (!options.prompt) throw new Error(usage());
  if (!options.hooks.length) {
    options.hooks = DEFAULT_EVENTS.map((event) => ({ event, script: path.join(__dirname, 'record.js') }));
  }
  return options;
}

// -c の値は TOML として読まれる。JSON の文字列表記は TOML の基本文字列としても読める。
function hookOverride({ event, script }, outDir) {
  const command = `node ${JSON.stringify(script.replace(/\\/g, '/'))} ${JSON.stringify(outDir.replace(/\\/g, '/'))}`;
  const timeout = event === 'Interrupt' ? INTERRUPT_TIMEOUT_SECONDS : HOOK_TIMEOUT_SECONDS;
  return `hooks.${event}=[{hooks=[{type="command",command=${JSON.stringify(command)},timeout=${timeout}}]}]`;
}

// Windows の npm の codex は .cmd なので、シェルを経ずに起動できる codex.js を直接 node で動かす。
function codexCommand() {
  const codexJs = process.env.APPDATA && path.join(process.env.APPDATA, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  if (process.platform === 'win32' && codexJs && fs.existsSync(codexJs)) return [process.execPath, [codexJs]];
  return ['codex', []];
}

function main() {
  let options;
  try { options = parseArguments(process.argv.slice(2)); } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
    return;
  }
  const overrides = options.hooks.flatMap((hook) => ['-c', hookOverride(hook, options.out)]);
  const [command, prefix] = codexCommand();
  const args = [...prefix, ...(options.exec ? EXEC_FLAGS : []), '--dangerously-bypass-hook-trust', ...overrides, options.prompt];
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}

main();
