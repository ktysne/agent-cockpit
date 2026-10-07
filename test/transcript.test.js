const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { MAX_TRANSCRIPT_BYTES, estimateTranscript, readTaskNotifications } = require('../src/server/transcript');
const { temporaryDirectory } = require('./support/temp');

test('queue-operation 行と user 行の両方から終了通知を読む', async (t) => {
  const fixture = await transcriptFixture(t);
  const notification = (id, status) => `<task-notification><task-id>${id}</task-id><status>${status}</status></task-notification>`;
  await fs.writeFile(fixture.filePath, [
    JSON.stringify({ type: 'queue-operation', timestamp: '2026-10-08T01:00:00.000Z', content: notification('queue-1', 'killed') }),
    JSON.stringify({ type: 'user', message: { content: [{ text: notification('user_1', 'completed') + notification('failed-1', 'failed') }] } }),
  ].join('\n'));
  assert.deepEqual(await readTaskNotifications(fixture.claudeHome, fixture.cwd, fixture.sessionId), new Map([
    ['queue-1', { status: 'killed', recordedAt: '2026-10-08T01:00:00.000Z' }],
    ['user_1', { status: 'completed', recordedAt: null }],
    ['failed-1', { status: 'failed', recordedAt: null }],
  ]));
});

test('終了通知は対象外の status と形の合わない id を捨て壊れた行を飛ばす', async (t) => {
  const fixture = await transcriptFixture(t);
  const lines = ['{壊れた行}'];
  for (const [id, status] of [['waiting', 'running'], ['../bad', 'killed'], ['x'.repeat(65), 'failed'], ['valid', 'completed']]) {
    lines.push(JSON.stringify({ data: `<task-notification><task-id>${id}</task-id><status>${status}</status></task-notification>` }));
  }
  await fs.writeFile(fixture.filePath, lines.join('\n'));
  assert.deepEqual(await readTaskNotifications(fixture.claudeHome, fixture.cwd, fixture.sessionId), new Map([
    ['valid', { status: 'completed', recordedAt: null }],
  ]));
});

test('終了通知は末尾の上限内だけを読み読めない記録は空で返す', async (t) => {
  const fixture = await transcriptFixture(t);
  const record = id => JSON.stringify({ data: `<task-notification><task-id>${id}</task-id><status>killed</status></task-notification>` });
  await fs.writeFile(fixture.filePath, `${record('old')}\n${'x'.repeat(MAX_TRANSCRIPT_BYTES)}\n${record('new')}\n`);
  assert.deepEqual([...await readTaskNotifications(fixture.claudeHome, fixture.cwd, fixture.sessionId)].map(([id]) => id), ['new']);
  assert.equal((await readTaskNotifications(fixture.claudeHome, fixture.cwd, 'missing')).size, 0);
});

async function transcriptFixture(testContext, sessionId = 'session_1') {
  const home = temporaryDirectory(testContext, 'agent-cockpit-transcript-').directory;
  const cwd = path.join(home, 'workspace', 'project');
  const projectName = cwd.replace(/[^A-Za-z0-9]/g, '-');
  const projectDirectory = path.join(home, '.claude', 'projects', projectName);
  await fs.mkdir(projectDirectory, { recursive: true });
  return {
    claudeHome: path.join(home, '.claude'),
    cwd,
    filePath: path.join(projectDirectory, `${sessionId}.jsonl`),
    sessionId,
  };
}

function transcriptRecord(type, { timestamp = '2026-10-02T01:02:03.000Z', stopReason = 'end_turn', content = [], isSidechain = false } = {}) {
  return JSON.stringify({
    type,
    timestamp,
    isSidechain,
    message: { role: type, stop_reason: stopReason, content },
  });
}

test('assistant の end_turn から入力待ちを推定する', async (t) => {
  const fixture = await transcriptFixture(t);
  await fs.writeFile(fixture.filePath, `${transcriptRecord('assistant')}\n`);
  assert.deepEqual(await estimateTranscript(fixture.claudeHome, fixture.cwd, fixture.sessionId), {
    recordedAt: '2026-10-02T01:02:03.000Z', lastTool: null, state: 'input',
  });
});

test('tool_use で止まった assistant からツール状態と最後のツールを返す', async (t) => {
  const fixture = await transcriptFixture(t);
  const content = [{ type: 'tool_use', name: 'Bash' }];
  await fs.writeFile(fixture.filePath, `${transcriptRecord('assistant', { stopReason: 'tool_use', content })}\n`);
  assert.deepEqual(await estimateTranscript(fixture.claudeHome, fixture.cwd, fixture.sessionId), {
    recordedAt: '2026-10-02T01:02:03.000Z', lastTool: 'Bash', state: 'tool',
  });
});

test('最後の対象行が user なら応答生成中として返す', async (t) => {
  const fixture = await transcriptFixture(t);
  const assistant = transcriptRecord('assistant', { stopReason: 'tool_use', content: [{ type: 'tool_use', name: 'Read' }] });
  const user = transcriptRecord('user', { timestamp: '2026-10-02T01:03:00.000Z', stopReason: null });
  await fs.writeFile(fixture.filePath, `${assistant}\n${user}\n`);
  assert.deepEqual(await estimateTranscript(fixture.claudeHome, fixture.cwd, fixture.sessionId), {
    recordedAt: '2026-10-02T01:03:00.000Z', lastTool: 'Read', state: 'model',
  });
});

test('256KB を超えるファイルでは途中の先頭行を捨てて読む', async (t) => {
  const fixture = await transcriptFixture(t);
  const oversized = transcriptRecord('assistant', { content: [{ type: 'text', text: 'x'.repeat(MAX_TRANSCRIPT_BYTES) }] });
  const finalRecord = transcriptRecord('assistant', { timestamp: '2026-10-02T01:04:00.000Z' });
  await fs.writeFile(fixture.filePath, `${oversized}\n${finalRecord}\n`);
  assert.ok((await fs.stat(fixture.filePath)).size > MAX_TRANSCRIPT_BYTES);
  assert.deepEqual(await estimateTranscript(fixture.claudeHome, fixture.cwd, fixture.sessionId), {
    recordedAt: '2026-10-02T01:04:00.000Z', lastTool: null, state: 'input',
  });
});

test('壊れた JSON 行を飛ばす', async (t) => {
  const fixture = await transcriptFixture(t);
  const finalRecord = transcriptRecord('assistant', { timestamp: '2026-10-02T01:05:00.000Z' });
  await fs.writeFile(fixture.filePath, `${finalRecord}\n{壊れた行}\n`);
  assert.equal((await estimateTranscript(fixture.claudeHome, fixture.cwd, fixture.sessionId)).recordedAt, '2026-10-02T01:05:00.000Z');
});

test('サイドチェーンの行を推定から除外する', async (t) => {
  const fixture = await transcriptFixture(t);
  const primary = transcriptRecord('assistant', { timestamp: '2026-10-02T01:06:00.000Z' });
  const sidechain = transcriptRecord('user', { timestamp: '2026-10-02T01:07:00.000Z', isSidechain: true });
  await fs.writeFile(fixture.filePath, `${primary}\n${sidechain}\n`);
  assert.deepEqual(await estimateTranscript(fixture.claudeHome, fixture.cwd, fixture.sessionId), {
    recordedAt: '2026-10-02T01:06:00.000Z', lastTool: null, state: 'input',
  });
});

test('対象行の形式が違う場合は null を返す', async (t) => {
  const fixture = await transcriptFixture(t);
  await fs.writeFile(fixture.filePath, `${JSON.stringify({
    type: 'assistant', timestamp: 'yesterday', isSidechain: false,
    message: { role: 'assistant', stop_reason: 'end_turn', content: [] },
  })}\n`);
  assert.equal(await estimateTranscript(fixture.claudeHome, fixture.cwd, fixture.sessionId), null);
});

test('ユーザーの発言が文字列の行で終わる場合は応答の生成中とする', async (t) => {
  const fixture = await transcriptFixture(t);
  const prompt = JSON.stringify({
    type: 'user', timestamp: '2026-10-02T01:02:04.000Z', isSidechain: false,
    message: { role: 'user', content: '続けてください' },
  });
  await fs.writeFile(fixture.filePath, `${transcriptRecord('assistant')}\n${prompt}\n`);
  assert.deepEqual(await estimateTranscript(fixture.claudeHome, fixture.cwd, fixture.sessionId), {
    recordedAt: '2026-10-02T01:02:04.000Z', lastTool: null, state: 'model',
  });
});

test('知らない種類の要素を含む行も推定に使う', async (t) => {
  const fixture = await transcriptFixture(t);
  const record = transcriptRecord('user', { stopReason: null, content: [{ type: 'image' }, { type: 'text' }] });
  await fs.writeFile(fixture.filePath, `${record}\n`);
  assert.equal((await estimateTranscript(fixture.claudeHome, fixture.cwd, fixture.sessionId))?.state, 'model');
});

test('中断の行で終わる場合は入力待ちとする', async (t) => {
  const fixture = await transcriptFixture(t);
  const interrupted = transcriptRecord('user', { stopReason: null, content: [{ type: 'text', text: '[Request interrupted by user]' }] });
  await fs.writeFile(fixture.filePath, `${transcriptRecord('assistant', { stopReason: 'tool_use', content: [{ type: 'tool_use', name: 'Bash' }] })}\n${interrupted}\n`);
  assert.equal((await estimateTranscript(fixture.claudeHome, fixture.cwd, fixture.sessionId))?.state, 'input');
});

test('isMeta の user の行は推定に使わない', async (t) => {
  const fixture = await transcriptFixture(t);
  const meta = JSON.stringify({
    type: 'user', timestamp: '2026-10-02T01:02:09.000Z', isSidechain: false, isMeta: true,
    message: { role: 'user', content: 'コマンドの出力' },
  });
  await fs.writeFile(fixture.filePath, `${transcriptRecord('assistant')}\n${meta}\n`);
  assert.deepEqual(await estimateTranscript(fixture.claudeHome, fixture.cwd, fixture.sessionId), {
    recordedAt: '2026-10-02T01:02:03.000Z', lastTool: null, state: 'input',
  });
});

test('不正な session_id を使わない', async (t) => {
  const fixture = await transcriptFixture(t);
  assert.equal(await estimateTranscript(fixture.claudeHome, fixture.cwd, '../session'), null);
});

test('会話の記録が無い場合は null を返す', async (t) => {
  const fixture = await transcriptFixture(t);
  assert.equal(await estimateTranscript(fixture.claudeHome, fixture.cwd, fixture.sessionId), null);
});
