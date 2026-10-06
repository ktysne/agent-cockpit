'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPOSITORY_ROOT = fs.realpathSync(path.resolve(__dirname, '..', '..'));
const OUTPUT_BASE = path.join(REPOSITORY_ROOT, 'poc', 'out');
const REQUIRED_CODEX_VERSION = '0.160.0';

function isInside(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function resolveOutputDirectory(value, repositoryRoot = REPOSITORY_ROOT) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error('--out is required');
  const root = path.resolve(repositoryRoot);
  const outputBase = path.resolve(root, 'poc', 'out');
  const target = path.resolve(root, value);
  if (!isInside(outputBase, target)) throw new Error('--out must name a new directory under poc/out');
  const segments = path.relative(outputBase, target).split(path.sep);
  if (segments.some(segment => !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(segment))) {
    throw new Error('--out path segments must contain only letters, numbers, dots, underscores, and hyphens');
  }
  return target;
}

function assertNoSymlinkComponents(base, target) {
  const relative = path.relative(base, target);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error('Output path escaped poc/out');
  }
  let current = base;
  for (const component of relative ? relative.split(path.sep) : []) {
    current = path.join(current, component);
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('Output path cannot contain symbolic links');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
}

function commandFor(scriptPath, platform = process.platform) {
  if (platform === 'win32') {
    if (/[&|<>^%!"\r\n]/.test(scriptPath)) throw new Error('Output path contains a character unsupported by Windows hook commands');
    return `node "${scriptPath}"`;
  }
  return `node '${scriptPath.replace(/'/g, "'\\''")}'`;
}

function tomlString(value) {
  return JSON.stringify(value);
}

function makeLayout(outputDirectory) {
  const home = path.join(outputDirectory, 'home');
  return {
    output: outputDirectory,
    home,
    repo: path.join(outputDirectory, 'repo'),
    hooks: path.join(home, 'hooks'),
  };
}

function renderHooksConfig(loggerPath) {
  const command = commandFor(loggerPath);
  const windowsCommand = process.platform === 'win32' ? undefined : commandFor(loggerPath, 'win32');
  const handler = { type: 'command', command, timeout: 3 };
  if (windowsCommand) handler.command_windows = windowsCommand;
  const eventNames = [
    'SessionStart', 'SessionEnd', 'PreToolUse', 'PermissionRequest', 'PostToolUse',
    'PreCompact', 'PostCompact', 'UserPromptSubmit', 'SubagentStart', 'SubagentStop',
    'Stop', 'Interrupt',
  ];
  return JSON.stringify({
    description: 'Codex 0.160.0 identity probe; records allowlisted metadata only.',
    hooks: Object.fromEntries(eventNames.map(name => [name, [{ hooks: [handler] }]])),
  }, null, 2) + '\n';
}

function renderConfig(mcpProbePath) {
  return [
    '[mcp_servers.poc157_identity]',
    'command = "node"',
    `args = [${tomlString(mcpProbePath)}]`,
    'env_vars = ["CLAUDE_CODE_SESSION_ID"]',
    '',
  ].join('\n');
}

function writeText(filePath, contents) {
  fs.writeFileSync(filePath, contents, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
}

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (!['--out', '--codex-version'].includes(option) || values.has(option) || !argv[index + 1]) {
      throw new Error('Usage: node setup.js --out poc/out/<slug> --codex-version 0.160.0');
    }
    values.set(option, argv[index + 1]);
    index += 1;
  }
  return { outputDirectory: values.get('--out'), codexVersion: values.get('--codex-version') };
}

function setup({ outputDirectory, codexVersion }) {
  if (codexVersion !== REQUIRED_CODEX_VERSION) throw new Error(`--codex-version must be ${REQUIRED_CODEX_VERSION}`);
  const target = resolveOutputDirectory(outputDirectory);
  const layout = makeLayout(target);
  assertNoSymlinkComponents(REPOSITORY_ROOT, target);
  if (fs.existsSync(target)) throw new Error('Output directory already exists; choose a fresh poc/out subdirectory');

  fs.mkdirSync(path.dirname(target), { recursive: true });
  assertNoSymlinkComponents(REPOSITORY_ROOT, target);
  if (fs.existsSync(target)) throw new Error('Output directory already exists; choose a fresh poc/out subdirectory');
  execFileSync('git', ['--version'], { stdio: 'ignore' });
  fs.mkdirSync(layout.home, { recursive: true });
  fs.mkdirSync(layout.hooks, { recursive: true });
  fs.mkdirSync(layout.repo, { recursive: true });
  fs.writeFileSync(path.join(layout.hooks, 'hook-logger.js'), fs.readFileSync(path.join(__dirname, 'hook-logger.js')),
    { flag: 'wx', mode: 0o600 });
  writeText(path.join(layout.home, 'hooks.json'), renderHooksConfig(path.join(layout.hooks, 'hook-logger.js')));
  writeText(path.join(layout.home, 'config.toml'), renderConfig(path.join(__dirname, 'mcp-probe.js')));
  writeText(path.join(layout.repo, 'README.md'), '# Codex identity fixture\n\nThis repository isolates the Codex 0.160.0 identity probe.\n');
  const localInstructions = '# 隔離PoC\n\nこのリポジトリはCodex 0.160.0の識別情報を確認するための空のfixtureです。\n';
  writeText(path.join(layout.repo, 'AGENTS.md'), localInstructions);
  writeText(path.join(layout.repo, 'CLAUDE.md'), localInstructions);
  writeText(path.join(layout.repo, '.gitignore'), 'events.jsonl\n');
  execFileSync('git', ['init', '--quiet'], { cwd: layout.repo, stdio: 'ignore' });
  return layout;
}

if (require.main === module) {
  try {
    const layout = setup(parseArguments(process.argv.slice(2)));
    process.stdout.write(`PoC home: ${layout.home}\nPoC repository: ${layout.repo}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  REPOSITORY_ROOT,
  OUTPUT_BASE,
  REQUIRED_CODEX_VERSION,
  assertNoSymlinkComponents,
  commandFor,
  makeLayout,
  parseArguments,
  renderConfig,
  renderHooksConfig,
  resolveOutputDirectory,
  setup,
};
