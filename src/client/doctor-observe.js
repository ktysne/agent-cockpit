const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { integrationManifest } = require('../shared/integration-manifest');
const { cockpitHomeFromOptions, claudeHomeFromOptions, codexHomeFromOptions, codexAgentScriptPaths, gitDirectoryFromFile, repositoryRootFromGitDirectory } = require('../server/identity');
const { readSourceState } = require('../server/source-revision');
const { readExpected } = require('./server-verification');
const { readServerInfo, requestFromServer } = require('./server-connection');
const { hookEntries, normalizedPath } = require('./doctor-evaluate');

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
  return { homes, hooks, candidates, root, resolvedBy, expected, manifest, generatedAt, bridgeInstalled,
    claudeHooks, codexHooks, claudeMcp, codexConfig, skills, skillPresent, server };
}

module.exports = { observe };
