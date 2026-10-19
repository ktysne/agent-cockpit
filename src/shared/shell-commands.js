function shellTokens(segment, toolName = 'Bash') {
  const expression = toolName === 'PowerShell'
    ? /"(?:[^"`]|`[\s\S])*"|'[^']*'|[^\s]+/g
    : /"(?:[^"\\]|\\(?:\r?\n|[\s\S]))*"|'[^']*'|\\(?:\r?\n|[\s\S])|[^\s]+/g;
  return (segment.match(expression) || []).map((token) => {
    const match = token.match(/^(?:"([\s\S]*)"|'([\s\S]*)')$/);
    if (!match) return token;
    const [, doubleQuoted, singleQuoted] = match;
    if (doubleQuoted === undefined || toolName === 'PowerShell') return doubleQuoted ?? singleQuoted;
    return doubleQuoted.replace(/\\(["\\$`])|\\\r?\n/g, (_match, escaped) => escaped ?? '');
  });
}

function commandSegments(command, toolName = 'Bash') {
  return commandSegmentParts(command, toolName).map((part) => part.command);
}

const HERE_DOCUMENT_SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh']);

// 標準入力をスクリプトとして読むシェルでは、ヒアドキュメントの本文が実行されるコマンドになる。
function readsScriptFromStandardInput(segment) {
  const words = commandWords(segment);
  if (!HERE_DOCUMENT_SHELLS.has(words[0])) return false;
  for (let index = 1; index < words.length; index += 1) {
    const word = words[index];
    if (/^[-+][^-]*c/.test(word)) return false;
    // -s と -- の後ろは位置引数で、スクリプトは標準入力から読む。
    if (word === '--' || /^-[^-]*s/.test(word)) return true;
    if (/^[-+][oO]$/.test(word)) index += 1;
    else if (!/^[-+]/.test(word)) return false;
  }
  return true;
}

function insideArithmetic(segment) {
  const unquoted = segment.replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, '');
  return (unquoted.match(/\(\(/g) || []).length > (unquoted.match(/\)\)/g) || []).length;
}

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

// 終わりの行が無ければ、Bash と同じく最後までを本文とみなす。
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
      if (lineEnding === -1) return command.length;
      lineStart = lineEnding + 1;
    }
    if (!found) return command.length;
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
    if (lineEnding === -1) return command.length;
    lineStart = lineEnding + 1;
  }
  return command.length;
}

function skipPowerShellBlockComment(command, start) {
  let depth = 1;
  for (let index = start + 2; index < command.length; index += 1) {
    if (command.startsWith('<#', index)) depth += 1;
    else if (command.startsWith('#>', index) && --depth === 0) return index + 2;
  }
  return command.length;
}

function commandSegmentParts(command, toolName = 'Bash', depth = 0) {
  if (typeof command !== 'string') return [];
  return scanCommandSegments(command, toolName, depth, 0, false).parts;
}

// nested が真のときは $( ) の中身を start から読み、対応する ) の位置を end で返す。
// 外側の分割と同じ走査にして、中身のヒアドキュメント、コメント、引用符の扱いを外側とそろえる。
function scanCommandSegments(command, toolName, depth, start, nested) {
  // PowerShell は \ ではなく逆引用符でエスケープするので、"D:\repo\" の末尾の \ で引用符を閉じ損ねないようにする。
  const escapeCharacter = toolName === 'PowerShell' ? '`' : '\\';
  const parts = [];
  let segment = '';
  let quote = '';
  let escaped = false;
  let separatorBefore = null;
  const hereDocuments = [];
  let hereStringQuote = '';
  let inComment = false;
  let substitutions = [];
  let parenDepth = 0;
  const pushPart = () => {
    parts.push({ command: segment, separatorBefore }, ...substitutions);
    substitutions = [];
    segment = '';
  };
  for (let index = start; index < command.length; index += 1) {
    const character = command[index];
    if (inComment && character !== '\n') continue;
    if (escaped && (character === '\n' || (character === '\r' && command[index + 1] === '\n'))) {
      segment = segment.slice(0, -1);
      escaped = false;
      if (character === '\r') index += 1;
      continue;
    }
    if (!escaped && !quote) {
      if (toolName === 'PowerShell' && command.startsWith('<#', index)) {
        index = skipPowerShellBlockComment(command, index) - 1;
        continue;
      }
      if (character === '#' && (!segment || /[\s()<>]$/.test(segment))) {
        inComment = true;
        continue;
      }
    }
    if (!escaped && quote !== "'" && character === '$' && command[index + 1] === '(' && command[index + 2] !== '(' && depth < 8) {
      const inner = scanCommandSegments(command, toolName, depth + 1, index + 2, true);
      substitutions.push(...inner.parts);
      segment += '_';
      index = inner.end;
      continue;
    }
    if (!escaped && !quote && toolName === 'PowerShell' && character === '@') {
      const hereString = powerShellHereStringAtLineEnd(command, index);
      if (hereString) {
        segment += command.slice(index, hereString.lineEnd);
        hereStringQuote = hereString.quote;
        index = hereString.lineEnd - 1;
        continue;
      }
    }
    if (!escaped && !quote && toolName !== 'PowerShell') {
      if (character === '<' && !insideArithmetic(segment) && !readsScriptFromStandardInput(segment)) {
        const hereDocument = bashHereDocumentAt(command, index);
        if (hereDocument) hereDocuments.push(hereDocument);
      }
    }
    if (character === '\n') inComment = false;
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
    } else if (nested && character === ')' && parenDepth === 0) {
      pushPart();
      return { parts, end: index };
    } else if (nested && (character === '(' || character === ')')) {
      parenDepth += character === '(' ? 1 : -1;
      segment += character;
    } else if (character === '\n' && !segment.trim() && ['&&', '|'].includes(separatorBefore)) {
      // && や | の直後の改行は行の継続なので、次のコマンドとの区切りを && のまま保つ。
    } else if (character === '&' && (segment.endsWith('>') || command[index + 1] === '>')) {
      segment += character;
    } else if (';&|\n'.includes(character)) {
      pushPart();
      separatorBefore = character === '&' && command[index + 1] === '&' ? '&&' : character;
      if (separatorBefore === '&&') index += 1;
      if (character === '\n' && hereStringQuote) {
        const resumeAt = skipPowerShellHereString(command, index + 1, hereStringQuote);
        hereStringQuote = '';
        index = resumeAt - 1;
      } else if (character === '\n' && hereDocuments.length) {
        const resumeAt = skipBashHereDocuments(command, index + 1, hereDocuments);
        hereDocuments.length = 0;
        index = resumeAt - 1;
      }
    } else {
      segment += character;
    }
  }
  pushPart();
  return { parts, end: command.length };
}

function commandWords(segment, toolName = 'Bash', stripRedirections = false) {
  const words = stripRedirections ? shellArguments(segment.trim(), toolName) : shellTokens(segment.trim(), toolName);
  let index = 0;
  while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] || '')) index += 1;
  if (words[index] === 'env') {
    index += 1;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[index] || '')) index += 1;
  }
  return words.slice(index).map((word) => toolName === 'PowerShell' ? word : word.replace(/^\\(["'\\])/, '$1'));
}

// コマンドの区切りまでの引数を返す。`2>&1` や `> "out file"` のリダイレクトは出力先ごと除く。
function shellArguments(value, toolName = 'Bash') {
  const tokens = [];
  let token = { text: '', quoted: false, started: false };
  let quote = '';
  const pushToken = () => {
    if (token.started) tokens.push(token);
    token = { text: '', quoted: false, started: false };
  };

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quote === "'") {
      if (character === "'") quote = '';
      else token.text += character;
    } else if (character === (toolName === 'PowerShell' ? '`' : '\\')) {
      token.text += value[index + 1] || '';
      index += 1;
      token.started = true;
    } else if (quote === '"') {
      if (character === '"') quote = '';
      else token.text += character;
    } else if (character === '"' || character === "'") {
      quote = character;
      token.quoted = true;
      token.started = true;
    } else if (/[\r\n]/.test(character)) break;
    else if (/\s/.test(character)) pushToken();
    else if (character === '&' && (token.text.endsWith('>') || value[index + 1] === '>')) {
      token.text += character;
      token.started = true;
    } else if (/[;&|()\r\n]/.test(character)) break;
    else {
      token.text += character;
      token.started = true;
    }
  }
  pushToken();

  const argumentsList = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const { text, quoted } = tokens[index];
    if (!quoted && /^(?:\d*>&\d*-?|\d*[<>]>?|&>>?)$/.test(text)) {
      if (!/&\d*-?$/.test(text) || /^&>/.test(text)) index += 1;
      continue;
    }
    if (!quoted && /^(?:\d*[<>]>?|&>>?)./.test(text)) continue;
    argumentsList.push(text);
  }
  return argumentsList;
}

const TRANSPARENT_COMMANDS = new Set(['command', 'nohup', 'time', 'builtin', '!']);
const ASSIGNMENT_WORD = /^[A-Za-z_][A-Za-z0-9_]*=/;

function commandName(word) {
  return (word || '').split(/[\\/]/).pop().toLowerCase().replace(/\.(?:exe|cmd)$/, '');
}

function withoutEnvOptions(words) {
  let rest = words;
  while (rest[0] !== undefined && (rest[0].startsWith('-') || ASSIGNMENT_WORD.test(rest[0]))) {
    rest = rest.slice(['-u', '--unset', '-C', '--chdir'].includes(rest[0]) ? 2 : 1);
  }
  return rest;
}

// 後ろのコマンドをそのまま実行するだけの前置きを外し、実際に起動されるコマンドの語から始める。
// commandWords は先頭の代入と env を外すので、元の区切りが env で始まるかを startsWithEnv で受け、残った env のオプションを外す。
function withoutCommandPrefixes(words, startsWithEnv) {
  let rest = startsWithEnv ? withoutEnvOptions(words) : words;
  for (;;) {
    const name = commandName(rest[0]);
    if (TRANSPARENT_COMMANDS.has(name)) {
      rest = rest.slice(1);
    } else if (name === 'exec' || name === 'nice' || name === 'timeout') {
      rest = rest.slice(1);
      while (rest[0]?.startsWith('-')) rest = rest.slice(['-a', '-n', '-s', '-k', '--signal', '--kill-after'].includes(rest[0]) ? 2 : 1);
      if (name === 'timeout') rest = rest.slice(1);
    } else if (name === 'env') {
      rest = withoutEnvOptions(rest.slice(1));
    } else {
      return rest;
    }
  }
}

function segmentStartsWithEnv(segment) {
  const firstCommand = segment.split(/\s+/).find((word) => !ASSIGNMENT_WORD.test(word));
  return commandName(firstCommand) === 'env';
}

/**
 * 前置きとシェルの起動をたどり、isScript に合う語で始まる起動ごとに、その後ろの語の列を返す。
 */
function commandInvocations(command, isScript, prepare = (text) => [text], depth = 0, toolName = 'Bash') {
  return commandInvocationDetails(command, isScript, prepare, depth, toolName).map((invocation) => invocation.argumentsList);
}

/** commandInvocations と同じ起動ごとに、語の列と、その語を分けたシェルの種別(toolName)を返す。 */
function commandInvocationDetails(command, isScript, prepare = (text) => [text], depth = 0, toolName = 'Bash', stripRedirections = false) {
  if (typeof command !== 'string') return [];
  if (depth >= 8) return [];
  return prepare(command).flatMap((text) => commandSegments(text, toolName)).flatMap((segment) => {
    let ungrouped = segment.trim();
    while (/^[({]/.test(ungrouped)) ungrouped = ungrouped.slice(1).trimStart();
    while (/[)}]$/.test(ungrouped)) ungrouped = ungrouped.slice(0, -1).trimEnd();
    const words = withoutCommandPrefixes(commandWords(ungrouped, toolName, stripRedirections), segmentStartsWithEnv(ungrouped));
    const invocation = (argumentsList) => [{ argumentsList, toolName, executable: commandName(words[0]) }];
    if (isScript(words[0] || '')) return invocation(words.slice(1));
    if (['source', '.'].includes(words[0])) return isScript(words[1] || '') ? invocation(words.slice(2)) : [];
    const shell = commandName(words[0]);
    if (!['bash', 'sh', 'dash', 'zsh'].includes(shell)) return [];
    for (let index = 1; index < words.length;) {
      const option = words[index];
      if (option === '-c' || option === '--command' || /^-[^-]*c[^-]*$/.test(option)) {
        return commandInvocationDetails(words[index + 1] || '', isScript, prepare, depth + 1, 'Bash', stripRedirections);
      }
      if (option === '--help' || option === '--version' || option === '-help' || option === '-version') return [];
      if (option === '--') return isScript(words[index + 1] || '') ? invocation(words.slice(index + 2)) : [];
      if (option === '-o' || option === '-O' || option === '--rcfile' || option === '--init-file') {
        index += 2;
      } else if (option.startsWith('-') && option !== '-') {
        index += 1;
      } else {
        return isScript(option) ? invocation(words.slice(index + 1)) : [];
      }
    }
    return [];
  });
}

module.exports = { commandSegments, commandSegmentParts, commandWords, commandName, commandInvocationDetails, commandInvocations };
