const path = require('node:path');

function pathApiFor(value) {
  return path.win32.isAbsolute(value) ? path.win32 : path.posix;
}

function productFromCwd(cwd) {
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
  return { key, name: paths.basename(root) || root };
}

function claudeHomeFromOptions(options = {}) {
  if (options.claudeHome) return path.resolve(options.claudeHome);
  if (process.env.CLAUDE_CONFIG_DIR) return path.resolve(process.env.CLAUDE_CONFIG_DIR);
  return path.join(require('node:os').homedir(), '.claude');
}

function cockpitHomeFromOptions(options = {}) {
  if (options.homeDir) return path.resolve(options.homeDir);
  if (process.env.AGENT_COCKPIT_HOME) return path.resolve(process.env.AGENT_COCKPIT_HOME);
  return path.join(require('node:os').homedir(), '.agent-cockpit');
}

module.exports = { productFromCwd, claudeHomeFromOptions, cockpitHomeFromOptions };
