const fs = require('node:fs/promises');
const path = require('node:path');
const { branchFromCwd } = require('../server/identity');
const { findWorktreeRoot } = require('../server/git-worktree');

async function originTool(root) {
  try {
    const config = await fs.readFile(path.join(root, '.git/config'), 'utf8');
    let origin = false;
    for (const line of config.split(/\r?\n/)) {
      if (/^\s*\[/.test(line)) origin = /^\s*\[remote\s+"origin"\]\s*$/i.test(line);
      else if (origin) {
        const url = line.match(/^\s*url\s*=\s*(.*?)\s*$/i)?.[1]?.replace(/^"(.*)"$/, '$1');
        const tool = url?.match(/^(?:https:\/\/github\.com\/|git@github\.com:)ktysne\/(claude-codex-bridge|ai-cross-review)(?:\.git)?\/?$/i)?.[1];
        if (tool) return tool.toLowerCase();
      }
    }
  } catch {}
  return null;
}

async function observeCheckouts({ root, userHome, homes, bridgeInstalled, cwd = process.cwd() }) {
  const current = await findWorktreeRoot(cwd);
  const locations = [...new Set([path.dirname(root), ...(current.root ? [path.dirname(current.root)] : []), userHome])];
  const found = new Map([['agent-cockpit', root]]);
  for (const location of locations) {
    const entries = await fs.readdir(location, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(location, entry.name);
      const tool = await originTool(candidate);
      if (tool && !found.has(tool)) found.set(tool, candidate);
    }
  }
  const reviewInstalled = (await Promise.all([homes.claude, homes.codex, path.join(userHome, '.codex-subagent')]
    .map(home => fs.stat(path.join(home, 'skills/cross-review/SKILL.md')).then(() => true, () => false)))).some(Boolean);
  return ['agent-cockpit', 'claude-codex-bridge', 'ai-cross-review'].flatMap(tool => {
    const checkout = found.get(tool) || null;
    if (!checkout && !(tool === 'claude-codex-bridge' ? bridgeInstalled : reviewInstalled)) return [];
    return [{ tool, root: checkout, branch: checkout ? branchFromCwd(checkout) : null }];
  });
}

module.exports = { observeCheckouts };
