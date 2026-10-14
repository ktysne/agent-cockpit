const fs = require('node:fs');
const path = require('node:path');
const TASK_OUTPUT_CHUNK_BYTES = 64 * 1024;
const TASK_OUTPUT_MISSING = Symbol('task output missing');

function codexOutputLines(value) {
  const lines = {};
  const visit = (item, depth = 0) => {
    if (depth > 6) return;
    if (typeof item === 'string') {
      for (const line of item.match(/^[\t ]*codex-agent:[\t ]*(?:agent=|result=|run=|(?:waiting|vanished|orphaned|unverified|not-found)[\t ]+run=)[^\r\n]*/gm) || []) {
        const normalized = line.trimStart();
        if (!lines.auditLine && normalized.startsWith('codex-agent: agent=')) lines.auditLine = normalized.slice(0, 1024);
        else if (!lines.resultLine && normalized.startsWith('codex-agent: result=')) lines.resultLine = normalized.slice(0, 1024);
        else if (!lines.runLine && normalized.startsWith('codex-agent: run=')) lines.runLine = normalized.slice(0, 1024);
        // codex-agent.sh は --wait の状態を最後の行で示すので、後の行で上書きする。
        else if (!normalized.startsWith('codex-agent: agent=') && !normalized.startsWith('codex-agent: result=') && !normalized.startsWith('codex-agent: run=')) {
          lines.waitStatusLine = normalized.slice(0, 1024);
        }
      }
      return;
    }
    if (Array.isArray(item)) {
      for (const child of item) visit(child, depth + 1);
      return;
    }
    if (!item || typeof item !== 'object') return;
    for (const key of ['stdout', 'output', 'text', 'content', 'file']) visit(item[key], depth + 1);
  };
  visit(value);
  return Object.keys(lines).length ? lines : null;
}

function readTaskOutputFile(filePath) {
  let fileDescriptor;
  try {
    fileDescriptor = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fileDescriptor).size;
    const readChunk = (length, position) => {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const bytesRead = fs.readSync(fileDescriptor, buffer, offset, length - offset, position + offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset).toString('utf8');
    };
    if (size <= TASK_OUTPUT_CHUNK_BYTES * 2) return readChunk(size, 0);

    const head = readChunk(TASK_OUTPUT_CHUNK_BYTES, 0);
    const tail = readChunk(TASK_OUTPUT_CHUNK_BYTES, size - TASK_OUTPUT_CHUNK_BYTES);
    return joinOutputChunks(head, tail);
  } catch (error) {
    return error?.code === 'ENOENT' ? TASK_OUTPUT_MISSING : null;
  } finally {
    if (fileDescriptor !== undefined) {
      try { fs.closeSync(fileDescriptor); } catch {}
    }
  }
}


function taskOutputPath(taskId, value) {
  return typeof value === 'string' && path.isAbsolute(value) && path.basename(value) === `${taskId}.output` ? value : '';
}

async function readTaskOutputFileAsync(filePath) {
  let file;
  try {
    file = await fs.promises.open(filePath, 'r');
    const { size } = await file.stat();
    const readChunk = async (length, position) => {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await file.read(buffer, offset, length - offset, position + offset);
        if (!bytesRead) break;
        offset += bytesRead;
      }
      return buffer.subarray(0, offset).toString('utf8');
    };
    if (size <= TASK_OUTPUT_CHUNK_BYTES * 2) return await readChunk(size, 0);
    const head = await readChunk(TASK_OUTPUT_CHUNK_BYTES, 0);
    const tail = await readChunk(TASK_OUTPUT_CHUNK_BYTES, size - TASK_OUTPUT_CHUNK_BYTES);
    return joinOutputChunks(head, tail);
  } catch (error) {
    // 消えたファイルは読み直しても戻らないので印を返し、それ以外の失敗は呼び出し側が読み直せるように null を返す。
    return error?.code === 'ENOENT' ? TASK_OUTPUT_MISSING : null;
  } finally {
    if (file) await file.close().catch(() => {});
  }
}

function joinOutputChunks(head, tail) {
  const headBoundary = Math.max(head.lastIndexOf('\n'), head.lastIndexOf('\r'));
  const tailBoundary = tail.search(/[\r\n]/);
  return `${head.slice(0, headBoundary + 1)}\n${tailBoundary < 0 ? '' : tail.slice(tailBoundary + 1)}`;
}

module.exports = { TASK_OUTPUT_MISSING, codexOutputLines, taskOutputPath, readTaskOutputFile, readTaskOutputFileAsync };
