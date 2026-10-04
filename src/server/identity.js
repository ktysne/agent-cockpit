const path = require('node:path');
const fs = require('node:fs');
const { isCompleteCommitSha } = require('./pull-request-utils');

const HEAD_FILE_LIMIT_BYTES = 4096;
const BRANCH_CACHE_TTL_MS = 10_000;
const BRANCH_CACHE_MAX_ENTRIES = 256;
const branchCache = new Map();

function pathApiFor(value) {
  return path.win32.isAbsolute(value) ? path.win32 : path.posix;
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
  let current = cwd;
  while (true) {
    const gitPath = paths.join(current, '.git');
    let gitStats;
    try {
      gitStats = fileSystem.statSync(gitPath);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') return null;
    }

    if (gitStats) {
      const gitDirectory = gitStats.isDirectory()
        ? gitPath
        : gitStats.isFile()
          ? gitDirectoryFromFile(gitPath, paths, fileSystem)
          : null;
      return gitDirectory ? branchFromHead(paths.join(gitDirectory, 'HEAD'), fileSystem) : null;
    }

    const parent = paths.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
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

  const key = paths === path.win32 ? root.toLowerCase() : root;
  return { key, name: paths.basename(root) || root, branch: branchFromCwd(cwd, options) };
}

function claudeHomeFromOptions(options = {}) {
  const environment = options.environment || process.env;
  if (options.claudeHome) return path.resolve(options.claudeHome);
  if (environment.CLAUDE_CONFIG_DIR) return path.resolve(environment.CLAUDE_CONFIG_DIR);
  return path.join(options.userHome || require('node:os').homedir(), '.claude');
}

// bridge は CLAUDE_CONFIG_DIR を見ずに ~/.claude/tools/ へ置く作りなので、Claude のホームに加えて ~/.claude も探す。
function codexAgentScriptPaths(claudeHome, userHome = require('node:os').homedir()) {
  const paths = [path.join(claudeHome, 'tools', 'codex-agent.sh'), path.join(userHome, '.claude', 'tools', 'codex-agent.sh')];
  return paths[0] === paths[1] ? [paths[0]] : paths;
}

function cockpitHomeFromOptions(options = {}) {
  if (options.homeDir) return path.resolve(options.homeDir);
  const environment = options.environment || process.env;
  if (environment.AGENT_COCKPIT_HOME) return path.resolve(environment.AGENT_COCKPIT_HOME);
  return path.join(options.userHome || require('node:os').homedir(), '.agent-cockpit');
}

module.exports = { productFromCwd, branchFromCwd, claudeHomeFromOptions, codexAgentScriptPaths, cockpitHomeFromOptions };
