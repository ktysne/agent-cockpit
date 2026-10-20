const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { createHash } = require('node:crypto');
const { integrationManifest } = require('../shared/integration-manifest');
const { cockpitHomeFromOptions, claudeHomeFromOptions, codexHomeFromOptions, codexAgentScriptPaths, gitDirectoryFromFile, repositoryRootFromGitDirectory } = require('../server/identity');
const { readSourceState } = require('../server/source-revision');
const { readExpected } = require('./server-verification');
const { readServerInfo, requestFromServer } = require('./server-connection');
const { hookEntries, normalizedPath } = require('./doctor-evaluate');

const { observeCheckouts } = require('./checkouts');

const CHECKOUT_ROOT = path.resolve(__dirname, '../..');
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const digest = text => createHash('sha256').update(text).digest('hex');

async function readDocument(file, json = true) {
  let text;
  try { text = await fs.readFile(file, 'utf8'); }
  catch (error) { return { file, text: null, value: null, missing: error.code === 'ENOENT', invalid: error.code !== 'ENOENT', observedDigest: null }; }
  try {
    const value = json ? JSON.parse(text) : text;
    return { file, text, value, invalid: json && !object(value), missing: false, observedDigest: digest(text) };
  } catch { return { file, text, value: null, invalid: true, missing: false, observedDigest: digest(text) }; }
}

async function fallbackRoot(root) {
  const paths = path;
  const gitDir = gitDirectoryFromFile(paths.join(root, '.git'), paths, syncFs);
  return repositoryRootFromGitDirectory(gitDir, paths) || root;
}

async function observeServer(home, root, expected, options) {
  const { port, pid, startedAt } = await readServerInfo(home) || {};
  const info = Number.isInteger(port) ? { port, pid, startedAt } : null;
  const request = requestPath => requestFromServer(info, requestPath, { method: 'GET' }, { fetchImpl: options.fetchImpl });
  const response = await request('/health');
  const health = response.ok && object(response.json) ? response.json : null;
  const sourceState = await (options.readSourceState || readSourceState)({ root, ...expected });
  let entries = [];
  if (health && health.app === 'agent-cockpit' && health.pid === pid && health.startedAt === startedAt) {
    const runs = await request('/api/diagnostics');
    const current = runs.ok && Array.isArray(runs.json?.runs) ? runs.json.runs.find(run => run.current) : null;
    if (current) {
      const log = await request(`/api/diagnostics?run=${encodeURIComponent(current.id)}`);
      if (log.ok && Array.isArray(log.json?.entries)) entries = log.json.entries;
    }
  }
  return { port, pid, startedAt, health, sourceState, entries };
}

async function observeCrossReview(checkouts, homes, environment, options) {
  const checkout = checkouts.find(entry => entry.tool === 'ai-cross-review');
  if (!checkout) return null;
  if (!checkout.root) return { error: 'ai-cross-review の checkout が見つかりません。' };
  let stdout;
  try {
    ({ stdout } = await (options.queryCrossReview || promisify(execFile))(process.execPath,
      ['tools/cross-review.sync-all.js', '--global-skill', '--check', '--json'],
      { cwd: checkout.root, env: { ...environment, CLAUDE_CONFIG_DIR: homes.claude, CODEX_HOME: homes.codex },
        timeout: 30000, windowsHide: true, encoding: 'utf8' }));
  } catch (error) {
    if (error.killed) return { error: 'ai-cross-review の照会が時間切れになりました。' };
    if (![1, 3].includes(error.code)) return { error: `ai-cross-review の照会を実行できませんでした (終了コード: ${error.code ?? '不明'})。` };
    stdout = error.stdout;
  }
  let value;
  try { value = JSON.parse(stdout); }
  catch { return { error: 'ai-cross-review の照会結果を JSON として読めませんでした。' }; }
  if (![1, 2].includes(value?.schemaVersion)) return { error: 'ai-cross-review の照会結果の schemaVersion が 1 または 2 ではありません。' };
  if (value.source?.error) return { error: `ai-cross-review の SKILL の正本を読めませんでした (${value.source.error})。` };
  const validTargets = value.schemaVersion === 1
    ? Array.isArray(value.targets) && value.targets.every(target => object(target) &&
      ['claude', 'codex', 'codex-subagent'].includes(target.id) && typeof target.path === 'string' &&
      ['match', 'stale', 'missing', 'unreadable', 'skipped'].includes(target.state))
    : Array.isArray(value.targets) && value.targets.every(target => object(target) &&
      ['claude', 'agents', 'codex-legacy', 'codex-subagent-legacy'].includes(target.id) && typeof target.path === 'string' &&
      (target.id.endsWith('-legacy')
        ? target.state === 'legacy' && typeof target.removable === 'boolean'
        : ['match', 'stale', 'missing', 'unreadable', 'skipped'].includes(target.state)));
  if (!validTargets) {
    return { error: 'ai-cross-review の照会結果の配布先を読めませんでした。' };
  }
  return value;
}

async function observeBridge(checkouts, homes, environment, options) {
  const checkout = checkouts.find(entry => entry.tool === 'claude-codex-bridge');
  if (!checkout) return null;
  if (!checkout.root) return { error: 'claude-codex-bridge の checkout が見つかりません。' };
  let stdout;
  try {
    ({ stdout } = await (options.queryBridge || promisify(execFile))('bash', ['tools/codex-agent.sh', '--check-copies'],
      { cwd: checkout.root, env: { ...environment, CLAUDE_CONFIG_DIR: homes.claude },
        timeout: 30000, windowsHide: true, encoding: 'utf8' }));
  } catch (error) {
    if (error.code === 'ENOENT') return { error: 'bash が見つからないため、bridge の照会を実行できませんでした。' };
    if (error.killed || error.code === 'ETIMEDOUT') return { error: 'bridge の照会が時間切れになりました。' };
    if (error.code === 2 && error.stderr?.includes('不明なオプションである: --check-copies')) {
      return { error: 'bridge は照会の入口を持たない古い版です。' };
    }
    return { error: `bridge の照会を実行できませんでした (終了コード: ${error.code ?? '不明'})。` };
  }
  let value;
  try { value = JSON.parse(stdout); }
  catch { return { error: 'bridge の照会結果を JSON として読めませんでした。' }; }
  if (value?.protocol !== 1) return { error: 'bridge の照会結果の protocol が整数 1 ではありません。' };
  if (!Array.isArray(value.items) || !value.items.every(item => object(item) &&
      ['id', 'kind', 'name', 'target'].every(key => typeof item[key] === 'string') &&
      ['match', 'stale', 'missing', 'not-deployed', 'unreadable'].includes(item.status) &&
      Array.isArray(item.requires) && item.requires.every(id => typeof id === 'string') &&
      (!['stale', 'missing'].includes(item.status) || typeof item.content === 'string')) ||
      !Array.isArray(value.order) || !value.order.every(kind => typeof kind === 'string') ||
      !Array.isArray(value.after) || !value.after.every(action => object(action) &&
        typeof action.id === 'string' && typeof action.when === 'string')) {
    return { error: 'bridge の照会結果の items、order、after の形を読めませんでした。' };
  }
  return value;
}

async function observe(options = {}) {
  const environment = options.environment || process.env;
  const userHome = options.userHome || os.homedir();
  const homes = { claude: claudeHomeFromOptions({ environment, userHome }),
    codex: codexHomeFromOptions({ environment, userHome }),
    cockpit: cockpitHomeFromOptions({ environment, userHome }) };
  const bridgeInstalled = options.isBridgeInstalled
    ? await options.isBridgeInstalled({ claudeHome: homes.claude, userHome })
    : codexAgentScriptPaths(homes.claude, userHome).some(scriptPath => syncFs.existsSync(scriptPath));
  const [claudeHooks, codexHooks, claudeMcp, codexConfig] = await Promise.all([
    readDocument(path.join(homes.claude, 'settings.json')), readDocument(path.join(homes.codex, 'hooks.json')),
    readDocument(path.join(environment.CLAUDE_CONFIG_DIR ? homes.claude : userHome, '.claude.json')),
    readDocument(path.join(homes.codex, 'config.toml'), false),
  ]);
  const hooks = { claude: hookEntries(claudeHooks), codex: hookEntries(codexHooks) };
  const packages = new Map();
  for (const entry of [...hooks.claude, ...hooks.codex]) {
    if (!entry.root) continue;
    const key = normalizedPath(entry.root);
    if (!packages.has(key)) packages.set(key, (await readDocument(path.join(entry.root, 'package.json'))).value?.name === 'agent-cockpit');
    entry.cockpit = packages.get(key) || /(?:^|[\\/])agent-cockpit$/i.test(entry.root);
  }
  const candidates = [...new Map([...hooks.claude, ...hooks.codex].filter(entry => entry.root && packages.get(normalizedPath(entry.root)))
    .map(entry => [normalizedPath(entry.root), entry.root])).values()];
  const root = options.root ? path.resolve(options.root) : candidates.length === 1 ? candidates[0] : await fallbackRoot(options.checkoutRoot || CHECKOUT_ROOT);
  const resolvedBy = options.root ? 'root' : candidates.length === 1 ? 'hooks' : 'doctor';
  const expected = await readExpected(root);
  if ((await readDocument(path.join(root, 'package.json'))).value?.name !== 'agent-cockpit') throw new Error('対象の checkout が agent-cockpit ではありません。');
  const manifest = integrationManifest(root);
  const generatedAt = new Date().toISOString();
  const skills = {};
  const skillPresent = {};
  for (const provider of ['claude', 'codex']) {
    skillPresent[provider] = (await Promise.all(Object.values(manifest[provider].skills)
      .map(file => fs.stat(path.join(homes[provider], file)).then(() => true, () => false)))).some(Boolean);
    skills[provider] = [];
    for (const [source, destination] of Object.entries(manifest[provider].skills)) {
      const target = path.join(homes[provider], destination);
      const [original, copy] = await Promise.all([readDocument(path.join(root, source), false), readDocument(target, false)]);
      skills[provider].push({ source, destination, target, original, copy });
    }
  }
  const server = await observeServer(homes.cockpit, root, expected, options);
  const checkouts = await observeCheckouts({ root, userHome, homes, bridgeInstalled, cwd: options.cwd });
  const crossReview = await observeCrossReview(checkouts, homes, environment, options);
  const bridge = await observeBridge(checkouts, homes, environment, options);
  return { homes, hooks, candidates, root, resolvedBy, expected, manifest, generatedAt, bridgeInstalled, checkouts, crossReview, bridge,
    claudeHooks, codexHooks, claudeMcp, codexConfig, skills, skillPresent, server };
}

module.exports = { observe };
