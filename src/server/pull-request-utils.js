'use strict';

const COMPLETE_COMMIT_SHA_PATTERN = /^(?:[a-fA-F0-9]{40}|[a-fA-F0-9]{64})$/;

function validRepositoryPart(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(value);
}

function isCompleteCommitSha(value) {
  return typeof value === 'string' && COMPLETE_COMMIT_SHA_PATTERN.test(value);
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

function findPullRequestUrl(value) {
  if (typeof value !== 'string') return null;
  const matches = value.match(/https:\/\/github\.com\/[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\/pull\/[1-9]\d*(?:\?[^\s<>"']*)?(?:#[^\s<>"']*)?/gi) || [];
  for (const match of matches) {
    const normalized = match.replace(/[),.;]+$/, '');
    const parsed = parsePullRequestUrl(normalized.split(/[?#]/, 1)[0]);
    if (parsed) return parsed;
  }
  return null;
}

function firstPullRequestUrl(value, depth = 0) {
  if (depth > 7 || value == null) return null;
  if (typeof value === 'string') return findPullRequestUrl(value);
  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) {
      const found = firstPullRequestUrl(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const key of ['html_url', 'htmlUrl', 'url', 'pull_request_url', 'pullRequestUrl']) {
    if (typeof value[key] === 'string') {
      const found = findPullRequestUrl(value[key]);
      if (found) return found;
    }
  }
  for (const key of ['structuredContent', 'content', 'result', 'data', 'output', 'stdout', 'text', 'message', 'pull_request', 'pullRequest']) {
    if (Object.hasOwn(value, key)) {
      const found = firstPullRequestUrl(value[key], depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function isGithubCreatePullRequestTool(toolName) {
  if (typeof toolName !== 'string') return false;
  const normalized = toolName.toLowerCase();
  return normalized === 'create_pull_request' || /(?:^|__)github__create_pull_request$/.test(normalized);
}

function shellTokens(segment) {
  return (segment.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\\.|[^\s]+/g) || [])
    .map((token) => token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted));
}

function commandSegments(command) {
  if (typeof command !== 'string') return [];
  const segments = [];
  let segment = '';
  let quote = '';
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      segment += character;
      escaped = false;
    } else if (character === '\\' && quote !== "'") {
      segment += character;
      escaped = true;
    } else if (quote) {
      segment += character;
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      segment += character;
      quote = character;
    } else if (';&|\n'.includes(character)) {
      segments.push(segment);
      segment = '';
    } else {
      segment += character;
    }
  }
  segments.push(segment);
  return segments;
}

function commandWords(segment) {
  const words = shellTokens(segment.trim());
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] || '')) index += 1;
  if (words[index] === 'env') {
    index += 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] || '')) index += 1;
  }
  return words.slice(index).map((word) => word.replace(/^\\(["'\\])/, '$1'));
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

function isGhPrCreateCommand(command) {
  return commandSegments(command).some((segment) => {
    const words = commandWords(segment);
    const subcommand = subcommandIndex(words, 'gh');
    return words[0] === 'gh' && words[subcommand] === 'pr' && words[subcommand + 1] === 'create';
  });
}

function shouldRefreshPullRequests(command) {
  return commandSegments(command).some((segment) => {
    const words = commandWords(segment);
    if (words[0] === 'git') return words[subcommandIndex(words, 'git')] === 'push';
    if (words[0] === 'gh') return words[subcommandIndex(words, 'gh')] === 'pr';
    return false;
  });
}

module.exports = {
  COMPLETE_COMMIT_SHA_PATTERN,
  commandSegments,
  commandWords,
  findPullRequestUrl,
  firstPullRequestUrl,
  isCompleteCommitSha,
  isGhPrCreateCommand,
  isGithubCreatePullRequestTool,
  parsePullRequestUrl,
  shouldRefreshPullRequests,
  validBranchName,
  validRepositoryPart,
};
