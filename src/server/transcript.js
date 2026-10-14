const fs = require('node:fs/promises');
const path = require('node:path');
const { taskOutputPath } = require('../shared/task-output');
const { isShortSessionId } = require('./session-ids');

const MAX_TRANSCRIPT_BYTES = 256 * 1024;
const INTERRUPTED_PREFIX = '[Request interrupted';
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

function transcriptPathFor(claudeHome, cwd, sessionId) {
  if (typeof cwd !== 'string' || cwd.length === 0 || !isShortSessionId(sessionId)) return null;
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
  // isMeta の行はスラッシュコマンドの出力などで、モデルの応答を待たせない。
  if (value.isSidechain === true || value.isMeta === true) return null;
  const message = value.message;
  if (
    !message || typeof message !== 'object' || Array.isArray(message) ||
    message.role !== value.type ||
    typeof value.timestamp !== 'string' || !ISO_TIMESTAMP_PATTERN.test(value.timestamp) || !Number.isFinite(Date.parse(value.timestamp)) ||
    !(message.stop_reason == null || typeof message.stop_reason === 'string') ||
    !(Array.isArray(message.content) || (value.type === 'user' && typeof message.content === 'string'))
  ) return { invalid: true };
  if (typeof message.content === 'string') return { record: value, toolNames: [], interrupted: message.content.startsWith(INTERRUPTED_PREFIX) };

  const toolNames = [];
  let interrupted = false;
  for (const item of message.content) {
    // 画像などの要素の種類は増えるので、知らない種類は推定に使わずに飛ばす。
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { invalid: true };
    if (item.type === 'tool_use') {
      if (typeof item.name !== 'string' || item.name.length === 0) return { invalid: true };
      toolNames.push(item.name);
    }
    if (value.type === 'user' && item.type === 'text' && typeof item.text === 'string' && item.text.startsWith(INTERRUPTED_PREFIX)) interrupted = true;
  }
  return { record: value, toolNames, interrupted };
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

function scanTail(tail) {
  const lines = tail.text.split(/\r?\n/);
  if (tail.startedMidFile) lines.shift();

  let lastRecord = null;
  let lastInterrupted = false;
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
    lastInterrupted = parsed.interrupted;
    for (const toolName of parsed.toolNames) lastTool = toolName;
  }
  return { lastRecord, lastInterrupted, lastTool };
}

async function estimateTranscript(claudeHome, cwd, sessionId, fileSystem = fs) {
  const filePath = transcriptPathFor(claudeHome, cwd, sessionId);
  if (!filePath) return null;
  try {
    const tail = await readTail(fileSystem, filePath);
    if (!tail) return null;
    const { lastRecord, lastInterrupted, lastTool } = scanTail(tail);
    if (!lastRecord) return null;

    const message = lastRecord.message;
    const hasToolUse = Array.isArray(message.content) && message.content.some((item) => item?.type === 'tool_use');
    // 中断の行は利用者が止めた印なので、モデルは次の入力を待っている。
    const state = lastRecord.type === 'user'
      ? lastInterrupted ? 'input' : 'model'
      : message.stop_reason === 'end_turn' || (!hasToolUse && message.stop_reason !== 'tool_use')
        ? 'input'
        : 'tool';
    return { recordedAt: lastRecord.timestamp, lastTool, state };
  } catch {
    return null;
  }
}

// 読めないときは null を返し、最後の対象行が中断の行かどうかを interrupted で返す。
async function readTranscriptInterruption(claudeHome, cwd, sessionId, fileSystem = fs) {
  const filePath = transcriptPathFor(claudeHome, cwd, sessionId);
  if (!filePath) return null;
  try {
    const tail = await readTail(fileSystem, filePath);
    if (!tail) return null;
    const { lastRecord, lastInterrupted } = scanTail(tail);
    if (!lastRecord) return null;
    return { interrupted: lastInterrupted, recordedAt: lastRecord.timestamp };
  } catch {
    return null;
  }
}

async function readTaskNotifications(claudeHome, cwd, sessionId, fileSystem = fs) {
  const notifications = new Map();
  const filePath = transcriptPathFor(claudeHome, cwd, sessionId);
  if (!filePath) return notifications;
  try {
    const tail = await readTail(fileSystem, filePath);
    if (!tail) return notifications;
    const lines = tail.text.split(/\r?\n/);
    if (tail.startedMidFile) lines.shift();
    for (const line of lines) {
      let record;
      try { record = JSON.parse(line); } catch { continue; }
      // ツールの入出力や本文に写った通知の文字列を終了と取り違えないため、Claude Code が通知を積む行だけを読む。
      if (record?.type !== 'queue-operation' || record.operation !== 'enqueue') continue;
      if (typeof record.content !== 'string' || !record.content.startsWith('<task-notification>')) continue;
      const block = record.content.split('</task-notification>')[0];
      // 前のプロセスで終わらなかった背景のエージェントは、stopped の 1 通にまとめて複数の task-id が並ぶ。
      const status = block.match(/<status>(completed|killed|failed|stopped)<\/status>/)?.[1];
      if (!status) continue;
      const recordedAt = typeof record.timestamp === 'string' ? record.timestamp : null;
      // <status> より後の <result> には報告の本文が入り、ほかのエージェントの task-id が写ることがある。
      const header = block.split('<status>')[0];
      for (const [, taskId] of header.matchAll(/<task-id>([A-Za-z0-9_-]{1,64})<\/task-id>/g)) {
        const outputFile = taskOutputPath(taskId, header.match(/<output-file>([\s\S]*?)<\/output-file>/)?.[1]?.trim());
        notifications.set(taskId, { status, recordedAt, ...(outputFile ? { outputFile } : {}) });
      }
    }
  } catch {}
  return notifications;
}

async function readSessionModel(claudeHome, cwd, sessionId, fileSystem = fs) {
  const filePath = transcriptPathFor(claudeHome, cwd, sessionId);
  if (!filePath) return null;
  try {
    const tail = await readTail(fileSystem, filePath);
    if (!tail) return null;
    const lines = tail.text.split(/\r?\n/);
    if (tail.startedMidFile) lines.shift();
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let record;
      try { record = JSON.parse(lines[index]); } catch { continue; }
      const model = record?.message?.model;
      if (record?.type === 'assistant' && record.isSidechain !== true &&
        typeof model === 'string' && model && model !== '<synthetic>') {
        const at = typeof record.timestamp === 'string' ? Date.parse(record.timestamp) : NaN;
        return { model, at: Number.isFinite(at) ? at : null };
      }
    }
  } catch {}
  return null;
}

module.exports = { MAX_TRANSCRIPT_BYTES, estimateTranscript, readTranscriptInterruption, transcriptPathFor, readTaskNotifications, readSessionModel };
