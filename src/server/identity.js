const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { isCompleteCommitSha } = require('./pull-request-utils');
const { findWorktreeRootSync } = require('./git-worktree');

const HEAD_FILE_LIMIT_BYTES = 4096;
const BRANCH_CACHE_TTL_MS = 10_000;
const BRANCH_CACHE_MAX_ENTRIES = 256;
const CODEX_WORKTREE_CACHE_MAX_ENTRIES = 256;
const branchCache = new Map();
const codexWorktreeCache = new Map();

function pathApiFor(value) {
  if (/^[A-Za-z]:/.test(value) || value.startsWith('\\') || /^\/\/[^/]+\/[^/]+(?:\/|$)/.test(value)) {
    return path.win32;
  }
  if (path.posix.isAbsolute(value)) return path.posix;
  return process.platform === 'win32' ? path.win32 : path.posix;
}

function readSmallFile(filePath, fileSystem) {
  const stats = fileSystem.statSync(filePath);
  if (!stats.isFile() || stats.size > HEAD_FILE_LIMIT_BYTES) return null;
  return fileSystem.readFileSync(filePath, 'utf8');
}

function branchFromHead(headPath, fileSystem) {
  try {
    const head = readSmallFile(headPath, fileSystem);
    if (head === null) return null;
    const line = head.split(/\r?\n/, 1)[0].trim();
    const ref = line.match(/^ref: refs\/heads\/(.+)$/);
    if (ref) return ref[1] || null;
    return isCompleteCommitSha(line) ? line.slice(0, 7) : null;
  } catch {
    return null;
  }
}

function gitDirectoryFromFile(gitFilePath, paths, fileSystem) {
  try {
    const gitFile = readSmallFile(gitFilePath, fileSystem);
    if (gitFile === null) return null;
    const match = gitFile.split(/\r?\n/, 1)[0].match(/^gitdir:\s*(.+?)\s*$/);
    if (!match) return null;
    if (paths === path.win32 && match[1].startsWith('\\\\')) return null;
    return paths.resolve(paths.dirname(gitFilePath), match[1]);
  } catch {
    return null;
  }
}

function findBranchFromCwd(cwd, paths, fileSystem) {
  const worktree = findWorktreeRootSync(cwd, fileSystem, paths);
  if (!worktree.root) return null;
  const gitPath = paths.join(worktree.root, '.git');
  const gitDirectory = worktree.marker.isDirectory()
    ? gitPath
    : worktree.marker.isFile()
      ? gitDirectoryFromFile(gitPath, paths, fileSystem)
      : null;
  return gitDirectory ? branchFromHead(paths.join(gitDirectory, 'HEAD'), fileSystem) : null;
}

function branchFromCwd(cwd, options = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;

  const paths = pathApiFor(cwd);
  const absoluteCwd = paths.resolve(cwd);
  const fileSystem = options.fileSystem || fs;
  const shouldCache = fileSystem === fs;
  const cacheKey = paths === path.win32 ? absoluteCwd.toLowerCase() : absoluteCwd;
  const now = Date.now();
  const cached = shouldCache ? branchCache.get(cacheKey) : null;
  if (cached && cached.expiresAt > now) return cached.branch;

  const branch = findBranchFromCwd(absoluteCwd, paths, fileSystem);
  if (shouldCache) {
    branchCache.delete(cacheKey);
    if (branchCache.size >= BRANCH_CACHE_MAX_ENTRIES) branchCache.delete(branchCache.keys().next().value);
    branchCache.set(cacheKey, { branch, expiresAt: now + BRANCH_CACHE_TTL_MS });
  }
  return branch;
}

function pathIsWithin(directory, parent, paths) {
  const normalizedDirectory = paths === path.win32 ? directory.toLowerCase() : directory;
  const normalizedParent = paths === path.win32 ? parent.toLowerCase() : parent;
  return normalizedDirectory.startsWith(`${normalizedParent}${paths.sep}`);
}

function repositoryRootFromGitDirectory(gitDirectory, paths) {
  if (!gitDirectory) return null;
  const worktreeName = paths.basename(gitDirectory);
  const gitWorktrees = paths.dirname(gitDirectory);
  const gitDirectoryRoot = paths.dirname(gitWorktrees);
  const sameSegment = (left, right) => paths === path.win32
    ? left.toLowerCase() === right.toLowerCase()
    : left === right;
  if (!worktreeName || !sameSegment(paths.basename(gitWorktrees), 'worktrees') ||
    !sameSegment(paths.basename(gitDirectoryRoot), '.git')) return null;
  return paths.dirname(gitDirectoryRoot);
}

function codexWorktreeRepositoryRoot(cwd, options, paths, fileSystem) {
  const codexHome = options.codexHome || process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const worktreesRoot = paths.resolve(codexHome, 'worktrees');
  if (!pathIsWithin(cwd, worktreesRoot, paths)) return null;

  const cacheKey = paths === path.win32 ? cwd.toLowerCase() : cwd;
  const shouldCache = fileSystem === fs;
  const cachedRoot = shouldCache ? codexWorktreeCache.get(cacheKey) : null;
  if (cachedRoot) return cachedRoot;

  const worktree = findWorktreeRootSync(cwd, fileSystem, paths);
  if (!worktree.root || !worktree.marker.isFile()) return null;
  const gitDirectory = gitDirectoryFromFile(paths.join(worktree.root, '.git'), paths, fileSystem);
  const repositoryRoot = repositoryRootFromGitDirectory(gitDirectory, paths);
  if (!repositoryRoot) return null;
  try {
    if (!fileSystem.statSync(gitDirectory).isDirectory()) return null;
  } catch {
    return null;
  }

  if (shouldCache) {
    if (codexWorktreeCache.size >= CODEX_WORKTREE_CACHE_MAX_ENTRIES) {
      codexWorktreeCache.delete(codexWorktreeCache.keys().next().value);
    }
    codexWorktreeCache.set(cacheKey, repositoryRoot);
  }
  return repositoryRoot;
}

function productForRoot(root, paths) {
  const key = paths === path.win32 ? root.toLowerCase() : root;
  return { key, name: paths.basename(root) || root };
}

// Codex の worktree の cwd だけを元のリポジトリの製品に畳む。畳めないときは null を返す。
function codexWorktreeProduct(cwd, options = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;

  const paths = pathApiFor(cwd);
  const root = codexWorktreeRepositoryRoot(paths.resolve(cwd), options, paths, options.fileSystem || fs);
  return root ? productForRoot(root, paths) : null;
}

function productFromCwd(cwd, options = {}) {
  if (typeof cwd !== 'string' || cwd.length === 0) return null;

  const paths = pathApiFor(cwd);
  const absoluteCwd = paths.resolve(cwd);
  const parsed = paths.parse(absoluteCwd);
  const parts = paths.relative(parsed.root, absoluteCwd).split(paths.sep).filter(Boolean);
  let root = absoluteCwd;

  for (let index = parts.length - 3; index >= 0; index -= 1) {
    if (
      parts[index].toLowerCase() === '.claude' &&
      parts[index + 1].toLowerCase() === 'worktrees'
    ) {
      root = paths.resolve(parsed.root, ...parts.slice(0, index));
      break;
    }
  }

  if (root === absoluteCwd) {
    root = codexWorktreeRepositoryRoot(absoluteCwd, options, paths, options.fileSystem || fs) || root;
  }
  return { ...productForRoot(root, paths), branch: branchFromCwd(cwd, options) };
}

function claudeHomeFromOptions(options = {}) {
  const environment = options.environment || process.env;
  if (options.claudeHome) return path.resolve(options.claudeHome);
  if (environment.CLAUDE_CONFIG_DIR) return path.resolve(environment.CLAUDE_CONFIG_DIR);
  return path.join(options.userHome || require('node:os').homedir(), '.claude');
}

// bridge は CLAUDE_CONFIG_DIR を見ずに ~/.claude の tools/ と gpt-agents/ を使う作りなので、Claude のホームに加えて ~/.claude も探す。
function pathsInClaudeHomes(claudeHome, userHome, ...segments) {
  const paths = [path.join(claudeHome, ...segments), path.join(userHome, '.claude', ...segments)];
  return paths[0] === paths[1] ? [paths[0]] : paths;
}

function codexAgentScriptPaths(claudeHome, userHome = require('node:os').homedir()) {
  return pathsInClaudeHomes(claudeHome, userHome, 'tools', 'codex-agent.sh');
}

function codexAgentDefinitionPaths(agentName, claudeHome, userHome = require('node:os').homedir()) {
  return pathsInClaudeHomes(claudeHome, userHome, 'gpt-agents', `${agentName}.md`);
}

function cockpitHomeFromOptions(options = {}) {
  if (options.homeDir) return path.resolve(options.homeDir);
  const environment = options.environment || process.env;
  if (environment.AGENT_COCKPIT_HOME) return path.resolve(environment.AGENT_COCKPIT_HOME);
  return path.join(options.userHome || require('node:os').homedir(), '.agent-cockpit');
}

module.exports = { productFromCwd, codexWorktreeProduct, branchFromCwd, claudeHomeFromOptions, codexAgentScriptPaths, codexAgentDefinitionPaths, cockpitHomeFromOptions };
