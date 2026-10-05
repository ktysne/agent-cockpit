const fs = require('node:fs/promises');
const path = require('node:path');

async function readSessionName(sessionId, claudeHome, fileSystem = fs) {
  const directory = path.join(claudeHome, 'sessions');
  let entries;
  try {
    entries = await fileSystem.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }

  const jsonFiles = entries
    .filter((entry) => entry.isFile() && path.extname(entry.name).toLowerCase() === '.json')
    .map((entry) => entry.name);
  const matchingFile = jsonFiles.find((name) => path.basename(name, path.extname(name)) === sessionId);
  const candidates = matchingFile ? [matchingFile, ...jsonFiles.filter((name) => name !== matchingFile)] : jsonFiles;

  for (const name of candidates) {
    let value;
    try {
      value = JSON.parse(await fileSystem.readFile(path.join(directory, name), 'utf8'));
    } catch {
      continue;
    }
    if (!value || typeof value !== 'object' || typeof value.name !== 'string') continue;
    const storedId = value.session_id || value.sessionId || value.id;
    if (name === matchingFile || storedId === sessionId) return value.name.slice(0, 200);
  }
  return null;
}

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sessionFileUpdatedAt(value) {
  if (!Number.isFinite(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

// ~/.claude/sessions は公開仕様ではないので、読めない項目やファイルは黙って飛ばす。
async function listLiveSessionFiles(claudeHome, { fileSystem = fs, isAlive = processIsAlive } = {}) {
  const directory = path.join(claudeHome, 'sessions');
  let entries;
  try {
    entries = await fileSystem.readdir(directory, { withFileTypes: true });
  } catch {
    return null;
  }
  const sessions = [];
  for (const entry of entries) {
    if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== '.json') continue;
    let value;
    try {
      value = JSON.parse(await fileSystem.readFile(path.join(directory, entry.name), 'utf8'));
    } catch {
      continue;
    }
    const sessionId = value && (value.sessionId || value.session_id || value.id);
    if (typeof sessionId !== 'string' || !Number.isInteger(value.pid) || !isAlive(value.pid)) continue;
    sessions.push({
      session_id: sessionId,
      pid: value.pid,
      cwd: typeof value.cwd === 'string' ? value.cwd : '',
      name: typeof value.name === 'string' ? value.name.slice(0, 200) : null,
      updatedAt: sessionFileUpdatedAt(value.updatedAt),
    });
  }
  return sessions;
}

async function findLiveSessionIdByPid(pid, claudeHome) {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const sessions = await listLiveSessionFiles(claudeHome);
  return sessions?.find((session) => session.pid === pid)?.session_id || null;
}

async function readAgentDefinition(filePath, fileSystem = fs) {
  let content;
  try {
    content = await fileSystem.readFile(filePath, 'utf8');
  } catch {
    return null;
  }
  const frontmatter = content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!frontmatter) return null;

  const values = Object.create(null);
  for (const line of frontmatter[1].split(/\r?\n/)) {
    const match = line.match(/^\s*(model|effort|codex_model|codex_reasoning_effort)\s*:\s*(.*?)\s*$/);
    if (match) values[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return values;
}

function safeDefinitionName(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.-]{1,100}$/.test(value)) return null;
  return value;
}

async function claudeAgentDefinition(agentType, claudeHome) {
  const safeName = safeDefinitionName(agentType);
  if (!safeName) return null;
  const values = await readAgentDefinition(path.join(claudeHome, 'agents', `${safeName}.md`));
  if (!values) return null;
  return {
    model: values.model || '',
    effort: values.effort || '',
    source: 'claude-agent-definition',
  };
}

async function codexAgentDefinition(agentName, claudeHome) {
  const safeName = safeDefinitionName(agentName);
  if (!safeName) return null;
  const values = await readAgentDefinition(path.join(claudeHome, 'gpt-agents', `${safeName}.md`));
  if (!values) return null;
  return {
    model: values.codex_model || '',
    effort: values.codex_reasoning_effort || '',
    source: 'gpt-agent-definition',
  };
}

module.exports = {
  readSessionName,
  listLiveSessionFiles,
  findLiveSessionIdByPid,
  readAgentDefinition,
  claudeAgentDefinition,
  codexAgentDefinition,
};
