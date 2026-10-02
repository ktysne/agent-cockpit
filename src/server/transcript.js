const fs = require('node:fs/promises');
const path = require('node:path');

const MAX_TRANSCRIPT_BYTES = 256 * 1024;
const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,100}$/;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function transcriptPathFor(claudeHome, cwd, sessionId) {
  if (typeof cwd !== 'string' || cwd.length === 0 || !SESSION_ID_PATTERN.test(sessionId)) return null;
  const projectsDirectory = path.resolve(claudeHome, 'projects');
  const projectDirectory = path.resolve(projectsDirectory, cwd.replace(/[^A-Za-z0-9]/g, '-'));
  const filePath = path.resolve(projectDirectory, `${sessionId}.jsonl`);
  const relativePath = path.relative(projectsDirectory, filePath);
  if (
    path.dirname(projectDirectory) !== projectsDirectory ||
    path.dirname(filePath) !== projectDirectory ||
    path.isAbsolute(relativePath) ||
    relativePath.split(path.sep).length !== 2 ||
    relativePath.startsWith(`..${path.sep}`)
  ) return null;
  return filePath;
}

function targetRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (value.type !== 'assistant' && value.type !== 'user') return null;
  if (value.isSidechain === true) return null;
  const message = value.message;
  if (
    !message || typeof message !== 'object' || Array.isArray(message) ||
    message.role !== value.type ||
    typeof value.timestamp !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value.timestamp) || !Number.isFinite(Date.parse(value.timestamp)) ||
    !(message.stop_reason == null || typeof message.stop_reason === 'string') ||
    !(Array.isArray(message.content) || (value.type === 'user' && typeof message.content === 'string'))
  ) return { invalid: true };
  if (typeof message.content === 'string') return { record: value, toolNames: [] };

  const toolNames = [];
  for (const item of message.content) {
    // 画像などの要素の種類は増えるので、知らない種類は推定に使わずに飛ばす。
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { invalid: true };
    if (item.type === 'tool_use') {
      if (typeof item.name !== 'string' || item.name.length === 0) return { invalid: true };
      toolNames.push(item.name);
    }
  }
  return { record: value, toolNames };
}

async function readTail(fileSystem, filePath) {
  const handle = await fileSystem.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, MAX_TRANSCRIPT_BYTES);
    if (length === 0) return null;
    const offset = size - length;
    const buffer = Buffer.alloc(length);
    let bytesRead = 0;
    while (bytesRead < length) {
      const result = await handle.read(buffer, bytesRead, length - bytesRead, offset + bytesRead);
      if (result.bytesRead === 0) return null;
      bytesRead += result.bytesRead;
    }
    return { text: buffer.toString('utf8'), startedMidFile: offset > 0 };
  } finally {
    await handle.close();
  }
}

async function estimateTranscript(claudeHome, cwd, sessionId, fileSystem = fs) {
  const filePath = transcriptPathFor(claudeHome, cwd, sessionId);
  if (!filePath) return null;
  try {
    const tail = await readTail(fileSystem, filePath);
    if (!tail) return null;
    const lines = tail.text.split(/\r?\n/);
    if (tail.startedMidFile) lines.shift();

    let lastRecord = null;
    let lastTool = null;
    for (const line of lines) {
      if (!line) continue;
      let value;
      try {
        value = JSON.parse(line);
      } catch {
        continue;
      }
      const parsed = targetRecord(value);
      if (!parsed) continue;
      if (parsed.invalid) {
        lastRecord = null;
        continue;
      }
      lastRecord = parsed.record;
      for (const toolName of parsed.toolNames) lastTool = toolName;
    }
    if (!lastRecord) return null;

    const message = lastRecord.message;
    const hasToolUse = Array.isArray(message.content) && message.content.some((item) => item?.type === 'tool_use');
    const state = lastRecord.type === 'user'
      ? 'model'
      : message.stop_reason === 'end_turn' || (!hasToolUse && message.stop_reason !== 'tool_use')
        ? 'input'
        : 'tool';
    return { recordedAt: lastRecord.timestamp, lastTool, state };
  } catch {
    return null;
  }
}

module.exports = { MAX_TRANSCRIPT_BYTES, estimateTranscript, transcriptPathFor };
