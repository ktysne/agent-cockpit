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

// 解釈できない定義は、信頼の記録と照合できない鍵を返して起動を止める側に倒す。
function hookEntries(hooks, keyPrefix) {
  if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) return [{ key: `${keyPrefix}:(解釈できない定義)`, command: '' }];
  return Object.entries(hooks).flatMap(([event, groups]) => (Array.isArray(groups) ? groups : [null]).flatMap((group, groupIndex) =>
    (Array.isArray(group?.hooks) ? group.hooks : [null]).map((hook, hookIndex) => ({
      key: `${keyPrefix}:${snakeCase(event)}:${groupIndex}:${hookIndex}`,
      command: hook?.command || hook?.tool || '',
    }))));
}

function hookFileEntries(file, keyPrefix) {
  const text = readText(file);
  if (text === null) return [];
  try { return hookEntries(JSON.parse(text).hooks, keyPrefix); } catch { return hookEntries(null, keyPrefix); }
}

// manifest は、root の plugin.json に extensions["com.openai"] があればそれを、無ければ .codex-plugin/plugin.json を使う。
// manifest に hooks があれば既定の hooks/hooks.json は読まれない。
function selectedManifestHooks(versionDir) {
  const parse = (file) => {
    const text = readText(file);
    if (text === null) return { found: false };
    try { return { found: true, value: JSON.parse(text) }; } catch { return { found: true, invalid: true }; }
  };
  const root = parse(path.join(versionDir, 'plugin.json'));
  if (root.invalid) return { invalid: true };
  const extension = root.value?.extensions?.['com.openai'];
  if (extension !== undefined) {
    if (!extension || typeof extension !== 'object') return { invalid: true };
    return { hooks: extension.hooks };
  }
  const compat = parse(path.join(versionDir, '.codex-plugin', 'plugin.json'));
  if (compat.invalid) return { invalid: true };
  return { hooks: compat.value?.hooks };
}

// manifest の hooks は、ファイルのパス、インラインの定義、それらの配列のどれか。インラインの鍵は plugin.json#hooks[<番号>]。
function pluginVersionEntries(versionDir, plugin) {
  const { hooks, invalid } = selectedManifestHooks(versionDir);
  if (invalid) return hookEntries(null, `${plugin}:plugin.json`);
  if (hooks === undefined) return hookFileEntries(path.join(versionDir, 'hooks', 'hooks.json'), `${plugin}:hooks/hooks.json`);
  return (Array.isArray(hooks) ? hooks : [hooks]).flatMap((spec, index) => {
    if (typeof spec !== 'string') return hookEntries(spec, `${plugin}:plugin.json#hooks[${index}]`);
    const relative = spec.replace(/\\/g, '/').replace(/^\.\//, '');
    return hookFileEntries(path.join(versionDir, relative), `${plugin}:${relative}`);
  });
}

// [hooks] の表の項目、[hooks.<イベント>] の表、最初の表より前の hooks.<イベント> = ... を探す。[hooks.state] は信頼の記録なので除く。
function configDefinesHooks(config) {
  let section = '';
  for (const line of config.split(/\r?\n/)) {
    // 信頼の記録の鍵は plugin.json#hooks[0] のように ] を含むので、行頭の [ で表の見出しと判断する。
    if (/^\s*\[/.test(line)) {
      section = line.trim().replace(/^\[\[?\s*/, '').replace(/\s*\]\]?$/, '');
      if (/^hooks\./.test(section) && !/^hooks\.state(\.|$)/.test(section)) return true;
      continue;
    }
    if (!/^\s*[\w".'-]+\s*=/.test(line)) continue;
    if (section === 'hooks' && !/^\s*state\s*[.=]/.test(line)) return true;
    if (section === '' && /^\s*hooks\s*\.\s*(?!state\b)/.test(line)) return true;
  }
  return false;
}

function projectCodexDirs(cwd, codexHome) {
  const dirs = [];
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    const codexDir = path.join(dir, '.codex');
    if (path.resolve(codexDir) !== path.resolve(codexHome)) dirs.push(codexDir);
    if (path.dirname(dir) === dir) return dirs;
  }
}

// Codex に同梱されたマーケットプレイスのプラグインは Codex 本体の一部として扱う。
// 同梱のフックは版の更新で増え、そのたびに信頼の記録が無い状態になるため。
const BUNDLED_MARKETPLACES = new Set(['openai-bundled']);

// --dangerously-bypass-hook-trust は有効なフックをすべて動かすので、信頼の記録が無い既存のフックがあれば起動しない。
// 信頼した後に定義が変わったか(trusted_hash の一致)は確かめられない。
function untrustedExistingHooks(codexHome, cwd) {
  const config = readText(path.join(codexHome, 'config.toml')) || '';
  const states = hookStates(config);
  const problems = [];
  if (configDefinesHooks(config)) problems.push('config.toml に [hooks] の定義がある');
  for (const codexDir of projectCodexDirs(cwd, codexHome)) {
    if (fs.existsSync(path.join(codexDir, 'hooks.json'))) problems.push(`プロジェクトのフックがある: ${path.join(codexDir, 'hooks.json')}`);
    const projectConfig = readText(path.join(codexDir, 'config.toml'));
    if (projectConfig !== null && configDefinesHooks(projectConfig)) problems.push(`プロジェクトの config.toml にフックの定義がある: ${path.join(codexDir, 'config.toml')}`);
  }
  const userHooks = path.join(codexHome, 'hooks.json');
  const entries = hookFileEntries(userHooks, userHooks);
  for (const plugin of enabledPlugins(config)) {
    const [name, marketplace] = plugin.split('@');
    if (BUNDLED_MARKETPLACES.has(marketplace)) continue;
    const pluginDir = path.join(codexHome, 'plugins', 'cache', marketplace || '', name || '');
    let versions = [];
    try { versions = fs.readdirSync(pluginDir); } catch {}
    // 実行時に選ばれる版を確かめる手段が無いので、キャッシュにあるすべての版を検査する。
    for (const version of versions) entries.push(...pluginVersionEntries(path.join(pluginDir, version), plugin));
  }
  for (const entry of new Map(entries.map((item) => [item.key, item])).values()) {
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
