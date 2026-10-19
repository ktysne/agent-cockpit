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

function shellTokens(segment) {
  return (segment.match(/"(?:[^"\\]|\\.)*"|'[^']*'|\\.|[^\s]+/g) || [])
    .map((token) => token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_match, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted));
}

function commandSegments(command, toolName = 'Bash') {
  return commandSegmentParts(command, toolName).map((part) => part.command);
}

const HERE_DOCUMENT_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

function bashHereDocumentAt(command, start) {
  // <<< はヒア文字列で本文の行を持たないので、2 文字目の < からも << と読まない。
  if (command[start - 1] === '<' || command[start] !== '<' || command[start + 1] !== '<' || command[start + 2] === '<') return null;
  let index = start + 2;
  let stripTabs = false;
  if (command[index] === '-') {
    stripTabs = true;
    index += 1;
  }
  while (command[index] === ' ' || command[index] === '\t') index += 1;

  let delimiter = '';
  let quote = '';
  let escaped = false;
  while (index < command.length) {
    const character = command[index];
    if (escaped) {
      delimiter += character;
      escaped = false;
    } else if (quote === "'") {
      if (character === quote) quote = '';
      else delimiter += character;
    } else if (character === '\\') {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = '';
      else delimiter += character;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (/[\s;&|()<>]/.test(character)) {
      break;
    } else {
      delimiter += character;
    }
    index += 1;
  }
  return delimiter ? { delimiter, stripTabs } : null;
}

// 終わりの行が無い << は算術のシフトやコメントの中の語なので、本文とみなさず -1 を返す。
function skipBashHereDocuments(command, start, documents) {
  let lineStart = start;
  let terminatorLineEnding = -1;
  for (const document of documents) {
    let found = false;
    while (lineStart <= command.length) {
      const lineEnding = command.indexOf('\n', lineStart);
      const lineEnd = lineEnding === -1 ? command.length : lineEnding;
      let line = command.slice(lineStart, lineEnd).replace(/\r$/, '');
      if (document.stripTabs) line = line.replace(/^\t+/, '');
      if (line === document.delimiter) {
        if (lineEnding === -1) return command.length;
        terminatorLineEnding = lineEnding;
        lineStart = lineEnding + 1;
        found = true;
        break;
      }
      if (lineEnding === -1) return -1;
      lineStart = lineEnding + 1;
    }
    if (!found) return -1;
  }
  return terminatorLineEnding;
}

function powerShellHereStringAtLineEnd(command, start) {
  const quote = command[start + 1];
  if (command[start] !== '@' || (quote !== '"' && quote !== "'")) return null;
  const lineEnd = command.indexOf('\n', start);
  const end = lineEnd === -1 ? command.length : lineEnd;
  if (!/^[\t ]*\r?$/.test(command.slice(start + 2, end))) return null;
  return { quote, lineEnd: end };
}

function skipPowerShellHereString(command, start, quote) {
  const terminator = quote === "'" ? "'@" : '"@';
  let lineStart = start;
  while (lineStart <= command.length) {
    const lineEnding = command.indexOf('\n', lineStart);
    const lineEnd = lineEnding === -1 ? command.length : lineEnding;
    // 終わりの '@ の後ろにはパイプなどのコマンドが続くことがあるので、その直後から分割を再開する。
    if (command.startsWith(terminator, lineStart)) return lineStart + terminator.length;
    if (lineEnding === -1) return -1;
    lineStart = lineEnding + 1;
  }
  return -1;
}

function commandSegmentParts(command, toolName = 'Bash') {
  if (typeof command !== 'string') return [];
  // PowerShell は \ ではなく逆引用符でエスケープするので、"D:\repo\" の末尾の \ で引用符を閉じ損ねないようにする。
  const escapeCharacter = toolName === 'PowerShell' ? '`' : '\\';
  const parts = [];
  let segment = '';
  let quote = '';
  let escaped = false;
  let separatorBefore = null;
  const hereDocuments = [];
  let hereStringQuote = '';
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (!escaped && !quote && toolName === 'PowerShell' && character === '@') {
      const hereString = powerShellHereStringAtLineEnd(command, index);
      if (hereString) {
        segment += command.slice(index, hereString.lineEnd);
        hereStringQuote = hereString.quote;
        index = hereString.lineEnd - 1;
        continue;
      }
    }
    // シェルに渡すヒアドキュメントの本文は実行されるコマンドなので、飛ばさずに分割する。
    if (!escaped && !quote && toolName !== 'PowerShell' && character === '<' &&
      !HERE_DOCUMENT_SHELLS.has(commandWords(segment)[0])) {
      const hereDocument = bashHereDocumentAt(command, index);
      if (hereDocument) hereDocuments.push(hereDocument);
    }
    if (escaped) {
      segment += character;
      escaped = false;
    } else if (character === escapeCharacter && quote !== "'") {
      segment += character;
      escaped = true;
    } else if (quote) {
      segment += character;
      if (character === quote) quote = '';
    } else if (character === '"' || character === "'") {
      segment += character;
      quote = character;
    } else if (character === '\n' && !segment.trim() && ['&&', '|'].includes(separatorBefore)) {
      // && や | の直後の改行は行の継続なので、次のコマンドとの区切りを && のまま保つ。
    } else if (';&|\n'.includes(character)) {
      parts.push({ command: segment, separatorBefore });
      segment = '';
      separatorBefore = character === '&' && command[index + 1] === '&' ? '&&' : character;
      if (separatorBefore === '&&') index += 1;
      if (character === '\n' && hereStringQuote) {
        const resumeAt = skipPowerShellHereString(command, index + 1, hereStringQuote);
        hereStringQuote = '';
        if (resumeAt !== -1) index = resumeAt - 1;
      } else if (character === '\n' && hereDocuments.length) {
        const resumeAt = skipBashHereDocuments(command, index + 1, hereDocuments);
        hereDocuments.length = 0;
        if (resumeAt !== -1) index = resumeAt - 1;
      }
    } else {
      segment += character;
    }
  }
  parts.push({ command: segment, separatorBefore });
  return parts;
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

function isGhPrCreateCommand(command, toolName = 'Bash') {
  return commandSegments(command, toolName).some((segment) => {
    const words = commandWords(segment);
    const subcommand = subcommandIndex(words, 'gh');
    return words[0] === 'gh' && words[subcommand] === 'pr' && words[subcommand + 1] === 'create';
  });
}

function countGhPrCreateCommands(command, toolName = 'Bash') {
  return commandSegments(command, toolName).filter((segment) => isGhPrCreateCommand(segment, toolName)).length;
}

function hasGhCommandOtherThanPrCreate(command, toolName = 'Bash') {
  return commandSegments(command, toolName).some((segment) => (
    commandWords(segment)[0] === 'gh' && !isGhPrCreateCommand(segment, toolName)
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
    const words = commandWords(previousCommand);
    if (words.length !== 2 || words[0] !== 'cd') return null;
    return resolvePullRequestCommandCwd(`${previousCommand} &&`, cwd, true);
  }
  return null;
}

function shouldRefreshPullRequests(command, toolName = 'Bash') {
  return commandSegments(command, toolName).some((segment) => {
    const words = commandWords(segment);
    if (words[0] === 'git') return words[subcommandIndex(words, 'git')] === 'push';
    if (words[0] === 'gh') return words[subcommandIndex(words, 'gh')] === 'pr';
    return false;
  });
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
 * 移動先を決められない cd、git -C、複数の対象を含むなど、1 つに決められないときは unknown を返す。
 */
function pullRequestRefreshScope(command, cwd) {
  const targets = new Set();
  let repository = null;
  for (const [index, segment] of commandSegments(command).entries()) {
    const words = commandWords(segment);
    if (['cd', 'pushd', 'popd'].includes(words[0]) && (index > 0 || !pullRequestCommandCwd(command, cwd))) return { unknown: true };
    if (words[0] === 'git') {
      const subcommand = subcommandIndex(words, 'git');
      if (words[subcommand] !== 'push') continue;
      if (words.slice(1, subcommand).some((word) => word.startsWith('-C') || ['--git-dir', '--work-tree'].includes(word.split('=')[0]))) {
        return { unknown: true };
      }
      targets.add('cwd');
    } else if (words[0] === 'gh' && words[subcommandIndex(words, 'gh')] === 'pr') {
      const value = ghRepositoryOption(words);
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
