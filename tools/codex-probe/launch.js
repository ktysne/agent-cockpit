// 検証用のフックを、その起動だけに渡して Codex を起動する。~/.codex は書き換えない。
// 使い方と守ること: docs/development.md「Codex の実機検証」
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
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

// -c の値は TOML として読まれ、同じキーを 2 回渡すと後の値だけが残るので、イベントごとに 1 つにまとめる。
// JSON の文字列表記は TOML の基本文字列としても読める。
function hookOverrides(hooks, outDir) {
  const byEvent = new Map();
  for (const { event, script } of hooks) byEvent.set(event, [...(byEvent.get(event) || []), script]);
  return [...byEvent].flatMap(([event, scripts]) => {
    const timeout = event === 'Interrupt' ? INTERRUPT_TIMEOUT_SECONDS : HOOK_TIMEOUT_SECONDS;
    const handlers = scripts.map((script) => {
      const command = `node ${JSON.stringify(script.replace(/\\/g, '/'))} ${JSON.stringify(outDir.replace(/\\/g, '/'))}`;
      return `{type="command",command=${JSON.stringify(command)},timeout=${timeout}}`;
    });
    return ['-c', `hooks.${event}=[{hooks=[${handlers.join(',')}]}]`];
  });
}

const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } };
const snakeCase = (event) => event.replace(/[A-Z]/g, (letter, index) => `${index ? '_' : ''}${letter.toLowerCase()}`);

// config.toml の [hooks.state.'<鍵>'] のうち、trusted_hash を持つか enabled = false のものを返す。
function hookStates(config) {
  const states = new Map();
  let current = null;
  for (const line of config.split(/\r?\n/)) {
    const header = line.match(/^\[hooks\.state\.(['"])(.*)\1\]$/);
    if (header) { current = { trusted: false, disabled: false }; states.set(header[2], current); continue; }
    if (line.startsWith('[')) { current = null; continue; }
    if (current && /^trusted_hash\s*=/.test(line)) current.trusted = true;
    if (current && /^enabled\s*=\s*false/.test(line)) current.disabled = true;
  }
  return states;
}

function enabledPlugins(config) {
  const plugins = [];
  let current = null;
  for (const line of config.split(/\r?\n/)) {
    const header = line.match(/^\[plugins\."([^"]+)"\]$/);
    if (header) { current = header[1]; continue; }
    if (line.startsWith('[')) { current = null; continue; }
    if (current && /^enabled\s*=\s*true/.test(line)) plugins.push(current);
  }
  return plugins;
}

function hookEntries(file, keyPrefix) {
  let hooks;
  try { hooks = JSON.parse(readText(file)).hooks || {}; } catch { return []; }
  return Object.entries(hooks).flatMap(([event, groups]) => (Array.isArray(groups) ? groups : []).flatMap((group, groupIndex) =>
    (group.hooks || []).map((hook, hookIndex) => ({ key: `${keyPrefix}:${snakeCase(event)}:${groupIndex}:${hookIndex}`, command: hook.command || '' }))));
}

// --dangerously-bypass-hook-trust は有効なフックをすべて動かすので、信頼の記録が無い既存のフックがあれば起動しない。
// 信頼した後に定義が変わったか(trusted_hash の一致)は確かめられない。
function untrustedExistingHooks(codexHome, cwd) {
  const config = readText(path.join(codexHome, 'config.toml')) || '';
  const states = hookStates(config);
  const problems = [];
  if (/^\[\[?hooks\.(?!state)/m.test(config)) problems.push('config.toml に [hooks] の定義がある');
  const projectHooks = path.join(cwd, '.codex', 'hooks.json');
  if (fs.existsSync(projectHooks)) problems.push(`プロジェクトのフックがある: ${projectHooks}`);
  const userHooks = path.join(codexHome, 'hooks.json');
  const entries = hookEntries(userHooks, userHooks);
  for (const plugin of enabledPlugins(config)) {
    const [name, marketplace] = plugin.split('@');
    const pluginDir = path.join(codexHome, 'plugins', 'cache', marketplace || '', name || '');
    let versions = [];
    try { versions = fs.readdirSync(pluginDir).filter((version) => fs.existsSync(path.join(pluginDir, version, 'hooks', 'hooks.json'))).sort(); } catch {}
    if (versions.length) entries.push(...hookEntries(path.join(pluginDir, versions.at(-1), 'hooks', 'hooks.json'), `${plugin}:hooks/hooks.json`));
  }
  for (const entry of entries) {
    const state = states.get(entry.key);
    if (!state?.disabled && !state?.trusted) problems.push(`信頼の記録が無いフック: ${entry.key} (${entry.command})`);
  }
  return problems;
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
  const problems = untrustedExistingHooks(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), process.cwd());
  if (problems.length) {
    process.stderr.write(`信頼の確認を外すと、次の確認されていないフックも動くため起動しない:\n${problems.map((line) => `- ${line}`).join('\n')}\n`);
    process.exitCode = 2;
    return;
  }
  const overrides = hookOverrides(options.hooks, options.out);
  const [command, prefix] = codexCommand();
  const args = [...prefix, ...(options.exec ? EXEC_FLAGS : []), '--dangerously-bypass-hook-trust', ...overrides, options.prompt];
  const child = spawn(command, args, { stdio: 'inherit' });
  child.on('exit', (code) => { process.exitCode = code ?? 1; });
}

main();
