const { commandSegments, commandSegmentParts, commandWords, commandName, commandInvocationDetails } = require('../shared/shell-commands');
'use strict';

const path = require('node:path');

const COMPLETE_COMMIT_SHA_PATTERN = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;
const SHA256_DIGEST_PATTERN = /^[a-fA-F0-9]{64}$/;

function repositoryKey(owner, repo) {
  return `${owner.toLowerCase()}/${repo.toLowerCase()}`;
}

function pullRequestKey(owner, repo, number) {
  return `${repositoryKey(owner, repo)}#${number}`;
}

function validRepositoryPart(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(value);
}

function isCompleteCommitSha(value) {
  return typeof value === 'string' && COMPLETE_COMMIT_SHA_PATTERN.test(value);
}

// 登録キーは SHA-256 固定長なので、コミット SHA と長さの条件を分ける。
function isSha256Digest(value) {
  return typeof value === 'string' && SHA256_DIGEST_PATTERN.test(value);
}

function validBranchName(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 500 || value === '@' || value.startsWith('-') ||
    value.startsWith('/') || value.endsWith('/') || value.endsWith('.') || value.includes('..') || value.includes('//') ||
    value.includes('@{') || /[\x00-\x20\x7f~^:?*\[\\]/.test(value)) return false;
  return value.split('/').every((part) => part.length > 0 && !part.startsWith('.') && !part.endsWith('.lock'));
}

function parsePullRequestUrl(value) {
  if (typeof value !== 'string' || value.length > 2000) return null;
  let parsed;
  try {
    parsed = new URL(value.trim());
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:' || parsed.hostname.toLowerCase() !== 'github.com') return null;
  const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/([1-9]\d*)\/?$/);
  if (!match || !validRepositoryPart(match[1]) || !validRepositoryPart(match[2])) return null;
  const number = Number(match[3]);
  if (!Number.isSafeInteger(number)) return null;
  return {
    owner: match[1],
    repo: match[2],
    number,
    url: `https://github.com/${match[1]}/${match[2]}/pull/${number}`,
  };
}

function findPullRequestUrls(value, maxCount = Number.MAX_SAFE_INTEGER, excluded = new Set()) {
  if (typeof value !== 'string') return [];
  const pullRequests = [];
  const seen = new Set(excluded);
  const matches = value.matchAll(/https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[1-9]\d*(?:\?[^\s<>"']*)?(?:#[^\s<>"']*)?/gi);
  for (const { 0: match } of matches) {
    const normalized = match.replace(/[),.;]+$/, '');
    const parsed = parsePullRequestUrl(normalized.split(/[?#]/, 1)[0]);
    if (!parsed) continue;
    const key = pullRequestKey(parsed.owner, parsed.repo, parsed.number);
    if (seen.has(key)) continue;
    seen.add(key);
    pullRequests.push(parsed);
    if (pullRequests.length >= maxCount) break;
  }
  return pullRequests;
}

function findPullRequestUrl(value) {
  return findPullRequestUrls(value, 1)[0] || null;
}

function pullRequestUrls(value, maxCount, depth = 0) {
  if (!Number.isInteger(maxCount) || maxCount < 1) return [];
  const pullRequests = [];
  const seen = new Set();
  const add = (pullRequest) => {
    const key = pullRequestKey(pullRequest.owner, pullRequest.repo, pullRequest.number);
    if (seen.has(key)) return;
    seen.add(key);
    pullRequests.push(pullRequest);
  };
  const visit = (current, currentDepth) => {
    if (currentDepth > 7 || current == null || pullRequests.length >= maxCount) return;
    if (typeof current === 'string') {
      for (const pullRequest of findPullRequestUrls(current, maxCount - pullRequests.length, seen)) {
        add(pullRequest);
      }
      return;
    }
    if (Array.isArray(current)) {
      for (const item of current.slice(0, 40)) {
        visit(item, currentDepth + 1);
        if (pullRequests.length >= maxCount) return;
      }
      return;
    }
    if (typeof current !== 'object') return;
    for (const key of ['html_url', 'htmlUrl', 'url', 'pull_request_url', 'pullRequestUrl']) {
      if (typeof current[key] === 'string') {
        for (const pullRequest of findPullRequestUrls(current[key], maxCount - pullRequests.length, seen)) {
          add(pullRequest);
        }
        if (pullRequests.length >= maxCount) return;
      }
    }
    for (const key of ['structuredContent', 'content', 'result', 'data', 'output', 'stdout', 'text', 'message', 'pull_request', 'pullRequest']) {
      if (Object.hasOwn(current, key)) {
        visit(current[key], currentDepth + 1);
        if (pullRequests.length >= maxCount) return;
      }
    }
  };
  visit(value, depth);
  return pullRequests;
}

function firstPullRequestUrl(value) {
  return pullRequestUrls(value, 1)[0] || null;
}

function isGithubCreatePullRequestTool(toolName) {
  if (typeof toolName !== 'string') return false;
  const normalized = toolName.toLowerCase();
  return normalized === 'create_pull_request' || /(?:^|__)github__create_pull_request$/.test(normalized);
}

function isPullRequestShellTool(toolName) {
  return toolName === 'Bash' || toolName === 'PowerShell';
}

function pullRequestCommandCwd(command, cwd) {
  return resolvePullRequestCommandCwd(command, cwd, false);
}

function resolvePullRequestCommandCwd(command, cwd, requireAbsolute) {
  if (typeof command !== 'string' || typeof cwd !== 'string' || !path.isAbsolute(cwd)) return null;
  const match = command.match(/^\s*cd[\t ]+(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([^\s;&|()<>]+))[\t ]*&&(?!&)/);
  if (!match) return null;
  const quotedPath = match[1] ?? match[2];
  const commandPath = quotedPath ?? match[3];
  if (!commandPath || commandPath.startsWith('-') || /[$`\r\n]/.test(commandPath)) return null;
  // 二重引用符の中の \ は、エスケープか Windows の区切りかを決められないため、パスを推測しない。
  if (match[1]?.includes('\\')) return null;
  if (quotedPath === undefined && (commandPath.startsWith('~') || /[\\<>*?\[\]{}]/.test(commandPath))) return null;

  let resolvedPath = commandPath;
  if (process.platform === 'win32') {
    const gitBashDrivePath = resolvedPath.match(/^\/([a-z])\//i);
    if (gitBashDrivePath) resolvedPath = `${gitBashDrivePath[1].toUpperCase()}:${resolvedPath.slice(2)}`;
    else if (resolvedPath.startsWith('/') && !resolvedPath.startsWith('//')) return null;
  }
  if (requireAbsolute && !path.isAbsolute(resolvedPath)) return null;
  return path.resolve(cwd, resolvedPath);
}

function parseGitHubRepositoryRemote(remoteUrl) {
  if (typeof remoteUrl !== 'string' || remoteUrl.length > 2000) return null;
  let owner;
  let repo;
  try {
    const parsed = new URL(remoteUrl.trim());
    if (!['http:', 'https:', 'ssh:', 'git:'].includes(parsed.protocol) ||
      parsed.hostname.toLowerCase() !== 'github.com' || parsed.search || parsed.hash) return null;
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 2) return null;
    [owner, repo] = parts;
  } catch {
    const match = remoteUrl.trim().match(/^(?:[^@/:]+@)?github\.com:([^/]+)\/([^/]+?)\/?$/i);
    if (!match) return null;
    [, owner, repo] = match;
  }
  repo = repo.replace(/\.git$/i, '');
  return validRepositoryPart(owner) && validRepositoryPart(repo) ? { owner, repo } : null;
}

function subcommandIndex(words, command) {
  let index = 1;
  const optionsWithValue = command === 'git'
    ? new Set(['-C', '-c', '--git-dir', '--work-tree'])
    : new Set(['-R', '--repo', '--hostname', '--config', '--jq', '--template', '--json']);
  while (index < words.length && words[index].startsWith('-')) {
    const option = words[index];
    index += 1;
    if (optionsWithValue.has(option) && index < words.length) index += 1;
  }
  return index;
}

// レビューと Codex の起動の判定と同じく、command や timeout の前置き、.exe の付いた名前、bash -c の中身も読む。
// 語の列は、先頭を起動したコマンドの名前(gh、git)にそろえて返す。
function toolInvocations(segment, toolName, names) {
  return commandInvocationDetails(segment, (word) => names.includes(commandName(word)), undefined, 0, toolName)
    .map(({ argumentsList, executable, nested }) => ({ words: [executable, ...argumentsList], nested }));
}

function isGhPrCreateWords(words) {
  const subcommand = subcommandIndex(words, 'gh');
  return words[0] === 'gh' && words[subcommand] === 'pr' && ['create', 'new'].includes(words[subcommand + 1]);
}

function isGhPrCreateCommand(command, toolName = 'Bash') {
  return commandSegments(command, toolName).some((segment) => (
    toolInvocations(segment, toolName, ['gh']).some(({ words }) => isGhPrCreateWords(words))
  ));
}

function countGhPrCreateCommands(command, toolName = 'Bash') {
  return commandSegments(command, toolName).filter((segment) => isGhPrCreateCommand(segment, toolName)).length;
}

function hasGhCommandOtherThanPrCreate(command, toolName = 'Bash') {
  return commandSegments(command, toolName).some((segment) => (
    toolInvocations(segment, toolName, ['gh']).some(({ words }) => !isGhPrCreateWords(words))
  ));
}

function pullRequestCreateCommandCwd(command, cwd, commandNumber, toolName = 'Bash') {
  if (!Number.isInteger(commandNumber) || commandNumber < 2 || toolName !== 'Bash') return null;
  const parts = commandSegmentParts(command, toolName);
  let found = 0;
  for (let index = 0; index < parts.length; index += 1) {
    if (!isGhPrCreateCommand(parts[index].command, toolName)) continue;
    found += 1;
    if (found !== commandNumber) continue;
    if (index === 0 || parts[index].separatorBefore !== '&&') return null;
    const previousCommand = parts[index - 1].command.trim();
    const words = commandWords(previousCommand, toolName);
    if (words.length !== 2 || words[0] !== 'cd') return null;
    return resolvePullRequestCommandCwd(`${previousCommand} &&`, cwd, true);
  }
  return null;
}

function isRefreshWords(words) {
  if (words[0] === 'git') return words[subcommandIndex(words, 'git')] === 'push';
  if (words[0] === 'gh') return words[subcommandIndex(words, 'gh')] === 'pr';
  return false;
}

function shouldRefreshPullRequests(command, toolName = 'Bash') {
  return commandSegments(command, toolName).some((segment) => (
    toolInvocations(segment, toolName, ['git', 'gh']).some(({ words }) => isRefreshWords(words))
  ));
}

function ghRepositoryOption(words) {
  let value = null;
  for (let index = 1; index < words.length; index += 1) {
    if (words[index] === '--repo' || words[index] === '-R') value = words[++index] ?? '';
    else if (words[index].startsWith('--repo=')) value = words[index].slice('--repo='.length);
  }
  return value;
}

/**
 * 取り直しの対象のコマンドが指すリポジトリを返す。
 * repository は gh の --repo の指定、cwd はコマンドを始めた作業ディレクトリのリポジトリを指す。
 * 移動先を決められない cd、git -C、bash -c などの中の起動、複数の対象を含むなど、1 つに決められないときは unknown を返す。
 */
function pullRequestRefreshScope(command, cwd) {
  const targets = new Set();
  let repository = null;
  for (const [index, segment] of commandSegments(command).entries()) {
    const words = commandWords(segment);
    if (['cd', 'pushd', 'popd'].includes(words[0]) && (index > 0 || !pullRequestCommandCwd(command, cwd))) return { unknown: true };
    for (const invocation of toolInvocations(segment, 'Bash', ['git', 'gh'])) {
      if (!isRefreshWords(invocation.words)) continue;
      // シェルの中では cd で作業ディレクトリが変わりうるので、どのリポジトリかを決めない。
      if (invocation.nested) return { unknown: true };
      const toolWords = invocation.words;
      if (toolWords[0] === 'git') {
        const subcommand = subcommandIndex(toolWords, 'git');
        if (toolWords.slice(1, subcommand).some((word) => word.startsWith('-C') || ['--git-dir', '--work-tree'].includes(word.split('=')[0]))) {
          return { unknown: true };
        }
        targets.add('cwd');
        continue;
      }
      const value = ghRepositoryOption(toolWords);
      if (value === null) {
        targets.add('cwd');
        continue;
      }
      const parts = value.split('/');
      if (parts.length !== 2 || !validRepositoryPart(parts[0]) || !validRepositoryPart(parts[1])) return { unknown: true };
      repository ??= `${parts[0]}/${parts[1]}`;
      targets.add(repositoryKey(parts[0], parts[1]));
    }
  }
  if (targets.size !== 1) return { unknown: true };
  return targets.has('cwd') ? { cwd: true } : { repository };
}

module.exports = {
  COMPLETE_COMMIT_SHA_PATTERN,
  commandSegments,
  commandWords,
  countGhPrCreateCommands,
  findPullRequestUrl,
  hasGhCommandOtherThanPrCreate,
  firstPullRequestUrl,
  isCompleteCommitSha,
  isSha256Digest,
  isGhPrCreateCommand,
  isGithubCreatePullRequestTool,
  isPullRequestShellTool,
  parsePullRequestUrl,
  parseGitHubRepositoryRemote,
  pullRequestCreateCommandCwd,
  pullRequestCommandCwd,
  pullRequestUrls,
  pullRequestRefreshScope,
  pullRequestKey,
  repositoryKey,
  shouldRefreshPullRequests,
  validBranchName,
  validRepositoryPart,
};
