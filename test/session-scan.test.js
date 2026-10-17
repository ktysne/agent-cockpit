const test = require('node:test');
const assert = require('node:assert/strict');
const { DashboardState } = require('../src/server/state');
const { startTestServer } = require('./support/server');

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

test('重なったセッション走査は同じ読み取りを共有する', async (t) => {
  let readCount = 0;
  let activeReads = 0;
  let maximumActiveReads = 0;
  let holdRead = false;
  const started = deferred();
  const release = deferred();
  const server = await startTestServer(t, {
    readClaudeSessionFiles: async () => {
      readCount += 1;
      if (!holdRead) return [];
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      started.resolve();
      try {
        await release.promise;
        return [];
      } finally {
        activeReads -= 1;
      }
    },
  });

  holdRead = true;
  const first = server.runtime.refreshSessionFiles();
  let second;
  try {
    await started.promise;
    second = server.runtime.refreshSessionFiles();
    await new Promise(setImmediate);
    assert.equal(readCount, 2);
    assert.equal(maximumActiveReads, 1);
  } finally {
    release.resolve();
    await Promise.allSettled([first, second]);
  }
  await Promise.all([first, second]);
});

test('close は走査完了を待ち、完了後の走査を開始しない', async (t) => {
  const state = new DashboardState();
  let readCount = 0;
  let holdRead = false;
  const started = deferred();
  const release = deferred();
  const server = await startTestServer(t, {
    state,
    readClaudeSessionFiles: async (_home, _options) => {
      readCount += 1;
      if (!holdRead) return [];
      started.resolve();
      await release.promise;
      return [{ session_id: 'close-after-scan', cwd: 'C:/project' }];
    },
  });

  holdRead = true;
  const scan = server.runtime.refreshSessionFiles();
  let closing;
  let beforeClose;
  try {
    await started.promise;
    beforeClose = state.snapshot();
    let closeFinished = false;
    closing = server.runtime.close().then(() => { closeFinished = true; });
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.equal(closeFinished, false);
  } finally {
    release.resolve();
    await Promise.allSettled([scan, closing]);
  }
  await Promise.all([scan, closing]);
  const afterClose = state.snapshot();
  assert.deepEqual(afterClose, beforeClose);
  await server.runtime.refreshSessionFiles();
  await new Promise(setImmediate);
  assert.equal(readCount, 2);
  assert.deepEqual(state.snapshot(), afterClose);
});

test('Claude セッション一覧の読み取り失敗では既存セッションを保持する', async (t) => {
  const state = new DashboardState();
  let unavailable = false;
  const server = await startTestServer(t, {
    state,
    readClaudeSessionFiles: async (_home, _options) => unavailable
      ? null
      : [{ session_id: 'preserved-session', cwd: 'C:/project' }],
  });

  assert.equal(state.sessionFileFor('preserved-session')?.cwd, 'C:/project');
  unavailable = true;
  await server.runtime.refreshSessionFiles();

  assert.equal(state.sessionFileFor('preserved-session')?.cwd, 'C:/project');
  assert.ok(state.snapshot().sessions.some((session) => session.session_id === 'preserved-session'));
});
