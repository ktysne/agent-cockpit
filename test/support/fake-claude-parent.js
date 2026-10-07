'use strict';

// 擬似の Claude 本体。起動すると自分の pid でセッションファイルを書き、親のテストから IPC で受けた依頼どおりに
// フックと MCP サーバーを自分の直接の子として起動する。親プロセスの pid が Claude 本体になる条件を再現するために使う。

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const [claudeHome, initialSessionId, procStart] = process.argv.slice(2);
const sessionsDirectory = path.join(claudeHome || '', 'sessions');
const mcpChildren = new Map();

function writeSessionFile(sessionId) {
  fs.mkdirSync(sessionsDirectory, { recursive: true });
  fs.writeFileSync(path.join(sessionsDirectory, `${process.pid}.json`), JSON.stringify({
    pid: process.pid,
    sessionId,
    procStart,
    cwd: process.cwd(),
    name: 'fake claude',
    updatedAt: Date.now(),
  }));
}

function collect(stream) {
  const chunks = [];
  stream.on('data', (chunk) => chunks.push(chunk));
  return () => Buffer.concat(chunks).toString('utf8');
}

function runHook({ script, input, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const stdout = collect(child.stdout);
    const stderr = collect(child.stderr);
    child.on('close', (exitCode) => resolve({ exitCode, stdout: stdout(), stderr: stderr() }));
    child.stdin.end(JSON.stringify(input));
  });
}

// シェルやラッパーを挟んだ起動を再現するため、中間の node を 1 段置いて MCP サーバーを孫にする。
const SHIM_SOURCE = "require('node:child_process').spawn(process.execPath, [process.argv[1]], { stdio: 'inherit' });";

function startMcp({ mcpId, script, env, viaShim }) {
  const args = viaShim ? ['-e', SHIM_SOURCE, script] : [script];
  const child = spawn(process.execPath, args, {
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const entry = { child, waiters: new Map(), buffer: '' };
  child.stdout.setEncoding('utf8').on('data', (chunk) => {
    entry.buffer += chunk;
    let index;
    while ((index = entry.buffer.indexOf('\n')) >= 0) {
      const line = entry.buffer.slice(0, index);
      entry.buffer = entry.buffer.slice(index + 1);
      if (!line.trim()) continue;
      const response = JSON.parse(line);
      entry.waiters.get(response.id)?.(response);
      entry.waiters.delete(response.id);
    }
  });
  child.stderr.resume();
  mcpChildren.set(mcpId, entry);
}

function callMcp({ mcpId, request }) {
  const entry = mcpChildren.get(mcpId);
  return new Promise((resolve) => {
    entry.waiters.set(request.id, resolve);
    entry.child.stdin.write(`${JSON.stringify(request)}\n`);
  });
}

function stopMcp({ mcpId }) {
  const entry = mcpChildren.get(mcpId);
  if (!entry) return;
  mcpChildren.delete(mcpId);
  entry.child.kill();
}

const handlers = {
  'run-hook': runHook,
  'start-mcp': async (message) => { startMcp(message); return {}; },
  'call-mcp': async (message) => ({ response: await callMcp(message) }),
  'stop-mcp': async (message) => { stopMcp(message); return {}; },
  'set-session': async ({ sessionId }) => { writeSessionFile(sessionId); return {}; },
};

function main() {
  process.on('message', async (message) => {
    if (message.cmd === 'exit') {
      for (const mcpId of [...mcpChildren.keys()]) stopMcp({ mcpId });
      process.exit(0);
    }
    const handler = handlers[message.cmd];
    const result = handler ? await handler(message) : { error: 'unknown command' };
    process.send({ requestId: message.requestId, ...result });
  });

  writeSessionFile(initialSessionId);
  process.send({ ready: true, pid: process.pid });
}

// node --test が test/ 配下のすべてのファイルを読み込むので、引数と IPC がある起動のときだけ動く。
if (process.argv.length >= 5 && typeof process.send === 'function') main();
